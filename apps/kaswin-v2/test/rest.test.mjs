// REST backup lookup: unit + engine tests. Offline: simulated node (SimChain) / stub pair, fake REST responses,
// public historical signed receipt from TN10 evidence. No network, wallet keys, signing of real funds or submission.
import test from 'node:test';
import assert from 'node:assert/strict';
import {restAcceptance, compareRestFields, queryRest, REST_BASE, recordStatus, hasRestAcceptance} from '../scripts/rest.mjs';
import {needsAttention, txStatus} from '../visual/view.mjs';
import {EngineV2, verifyAtHint, wantsRest, REST_AFTER_MS} from '../scripts/engine2.mjs';
import {SimChain, wsFactory, fakeKasware, simIndexer, loadProfile, MemoryStore, testLocks, TEST_ADDRESS} from './sim.mjs';
import {NodeLink} from '../scripts/shared/nodes.mjs';
import {readSession} from '../scripts/shared/wallet.mjs';
import {NETWORK_GENESIS, PROFILE_ID} from '../scripts/shared/core.mjs';
import {jsonText} from '../scripts/shared/lib/json.mjs';
import {historyRecord, restDTO} from './rest-history.mjs';

const profile = loadProfile();
const PREFIX = `${NETWORK_GENESIS}/${PROFILE_ID}/tx/`;
const ok = data => new Response(jsonText(data));
const status = code => new Response('{}', {status: code});

test('REST query: GET only, fixed TN10 endpoint, no credentials/body, lossless amounts, no DAA or synthetic tx', async () => {
  const record = await historyRecord(); let calls = 0;
  const dto = restDTO(record); dto.outputs[1].amount = 9007199254740993n; record.draft.transaction.outputs[1].value = 9007199254740993n; record.signed.outputs[1].value = 9007199254740993n;
  const out = await queryRest(record, {fetcher: async (url, o) => { calls++; assert.equal(url, `${REST_BASE}/transactions/${record.txid}?inputs=true&outputs=true`); assert.equal(o.method, 'GET'); assert.equal(o.credentials, 'omit'); assert.equal(o.body, undefined); return ok(dto); }});
  assert.equal(calls, 1); assert.equal(out.outcome, 'ACCEPTED'); assert.equal(out.fields.ok, true); assert.equal(out.acceptingBlockHash, 'cc'.repeat(32));
  assert.equal(out.acceptingDaa, undefined); assert.equal(out.tx, undefined);
});

test('REST fields: every API-supplied field must match the approved/signed record; missing fields fail closed', async () => {
  const mutations = [d => d.version = 0, d => d.payload = '01', d => d.subnetwork_id = 'ff'.repeat(20), d => d.inputs[0].previous_outpoint_index = '1',
    d => d.inputs[0].previous_outpoint_hash = 'ee'.repeat(32), d => d.inputs[0].compute_budget = 9, d => d.inputs[0].signature_script = 'ff', d => d.inputs[1].signature_script = '41' + '00'.repeat(64) + '01',
    d => d.inputs.pop(), d => delete d.outputs, d => d.outputs.push(d.outputs[0]), d => d.outputs[0].index = 1, d => d.outputs[0].amount -= 1n, d => d.outputs[0].script_public_key = 'ff',
    d => d.outputs[0].covenant_id = 'ff'.repeat(32), d => d.outputs[0].covenant_authorizing_input = 1, d => d.outputs[1].covenant_id = 'aa'.repeat(32), d => delete d.outputs[1].covenant_id];
  for (const mutate of mutations) { const record = await historyRecord(), d = restDTO(record); mutate(d); assert.throws(() => compareRestFields(d, record)); }
  const record = await historyRecord();
  assert.equal(compareRestFields(restDTO(record), record).unavailable.includes('sequence'), true);
  // Pinned REST maps an empty payload to null; null is never accepted for a non-empty local payload.
  const fresh = restDTO(await historyRecord());
  record.draft.transaction.payload = 'ab'; assert.throws(() => compareRestFields(fresh, record), /payload/);
});

test('REST claim: txid binding and strict boolean; 404 / false / containing block alone are never accepted or rejected', async () => {
  const record = await historyRecord(), d = restDTO(record);
  assert.throws(() => restAcceptance({...d, transaction_id: 'ff'.repeat(32)}, record.txid));
  assert.throws(() => restAcceptance({...d, is_accepted: 'true'}, record.txid));
  assert.throws(() => restAcceptance({...d, accepting_block_hash: null}, record.txid));
  assert.deepEqual(restAcceptance({...d, is_accepted: false, block_hash: ['ee'.repeat(32)]}, record.txid), {outcome: 'UNCONFIRMED'});
  assert.equal((await queryRest(record, {fetcher: async () => status(404)})).outcome, 'NOT_FOUND');
});

test('REST transport: 429 / oversize / malformed / timeout fail once, without retry', async () => {
  const record = await historyRecord(); let calls = 0;
  await assert.rejects(queryRest(record, {fetcher: async () => { calls++; return status(429); }}), /HTTP 429/); assert.equal(calls, 1);
  await assert.rejects(queryRest(record, {maxBytes: 5, fetcher: async () => new Response('123456')}), /大小上限/);
  await assert.rejects(queryRest(record, {fetcher: async () => new Response('{broken')}));
  await assert.rejects(queryRest(record, {timeoutMs: 5, fetcher: async (_u, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('timeout'))))}), /timeout/);
});

test('display level: REST-only needs witness + fresh lookup bound to node check + node unable (not contradicting)', async () => {
  const r = await historyRecord(); r.checkedAt = 10;
  r.restWitness = {source: REST_BASE, txid: r.txid, acceptingBlockHash: 'cc'.repeat(32), fields: {ok: true}};
  r.restCheck = {txid: r.txid, nodeCheckedAt: 10, hint: {acceptingBlockHash: 'cc'.repeat(32)}, node: {result: 'PRUNED'}};
  assert.equal(recordStatus(r), 'REST_ACCEPTED'); assert.equal(needsAttention(r), false); assert.match(txStatus('REST_ACCEPTED').meaning, /不是节点完整复验/);
  for (const s of ['ACCEPTED', 'PENDING', 'REJECTED', 'ARCHIVED', 'SUBMITTED']) assert.equal(recordStatus({...r, status: s}), s);
  const variants = [{checkedAt: 11}, {restWitness: {...r.restWitness, source: 'https://fake'}}, {restWitness: {...r.restWitness, fields: {ok: false}}}, {restWitness: null},
    {restCheck: {...r.restCheck, node: {result: 'CONFLICT'}}}, {restCheck: {...r.restCheck, node: {result: 'ERROR'}}}, {restCheck: {...r.restCheck, node: null}},
    {restCheck: {...r.restCheck, hint: {acceptingBlockHash: 'dd'.repeat(32)}}}, {restCheck: null}];
  for (const v of variants) { const x = {...r, ...v}; assert.equal(hasRestAcceptance(x), false); assert.equal(needsAttention(x), true); }
});

/** Simulated node: tx actually accepted, submit response lost (UNKNOWN), bounded node search cannot reach it. */
async function simUnknown() {
  const chain = new SimChain(), pair = new NodeLink(['wss://alpha.sim/kaspa/testnet-10/wrpc/json'], {WebSocketImpl: wsFactory(chain)});
  globalThis.fetch = simIndexer(chain, profile).fetch; globalThis.kasware = fakeKasware();
  const store = new MemoryStore(), h = {chain, pair, store, respond: async () => status(404), restCalls: 0};
  h.engine = new EngineV2({pair, profile, indexer: 'http://localhost/indexer', openStore: async () => store, locks: testLocks, reorgRecheckDaa: 0n,
    restQuery: r => queryRest(r, {fetcher: (...a) => { h.restCalls++; return h.respond(...a); }})});
  chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const session = await readSession(globalThis.kasware, {request: true});
  h.plan = await h.engine.plan({action: 'GENESIS', config: {ticketPrice: 100_000_000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: chain.daa + 1000n}, registry: false}, session);
  chain.dropResponse = true; h.rec = await h.engine.execute(h.plan, {approved: true});
  assert.equal(h.rec.status, 'UNKNOWN'); h.block = chain.accepted.get(h.rec.txid).block;
  // Make the record older than REST_AFTER_MS (a fresh one never goes to REST; tested separately).
  const k = PREFIX + h.rec.txid, cur = await store.get(k); await store.compareAndSet(k, cur.revision, {...cur.value, createdAt: cur.value.createdAt - 3_600_000});
  chain.advance(3);
  const [n] = await pair.connect(); h.n = n; h.orig = n.call.bind(n); h.over = {};
  n.call = async (m, p, t) => {
    if (h.over[m]) { const out = await h.over[m](p); if (out !== undefined) return out; }
    if (m === 'getVirtualChainFromBlock') throw Error('getVirtualChainFromBlock: the queried hash does not have retention root on its chain');
    return h.orig(m, p, t);
  };
  h.stored = async () => (await store.get(PREFIX + h.rec.txid)).value;
  h.blue = hash => Number(chain.blocks.get(hash).blue);
  h.ppBlue = h.blue(chain.chain[0]);
  h.over.getBlockDagInfo = () => ({pruningPointHash: chain.chain[0]});
  return h;
}

test('REST locates, node verifies: full node acceptance at the REST block becomes real ACCEPTED; no extra submit', async () => {
  const h = await simUnknown();
  h.respond = async () => ok(restDTO(await h.stored(), h.block, h.blue(h.block)));
  const r = await h.engine.reconcile(h.rec.txid);
  assert.equal(r.status, 'ACCEPTED'); assert.equal(r.accepted, true); assert.equal(r.locatedBy, 'REST'); assert.equal(r.accepting, h.block);
  assert.equal(r.actualFee, h.plan.fee); assert.equal(r.restCheck.node.result, 'VERIFIED'); assert.equal(recordStatus(r), 'ACCEPTED');
  assert.equal(r.error, undefined); assert.equal(h.chain.submits, 1);
  assert.ok(await h.engine.localTip(h.plan.cid)); // node-verified, so it may serve as local continuation
  // Later node reconcile of the ACCEPTED record no longer needs REST.
  const calls = h.restCalls; assert.equal((await h.engine.reconcile(h.rec.txid)).status, 'ACCEPTED'); assert.equal(h.restCalls, calls);
});

test('node contradicts REST (off-chain block / tx not in acceptance set / field mismatch): node wins, UNKNOWN', async () => {
  for (const mode of ['offchain', 'notAccepted', 'tampered']) {
    const h = await simUnknown(), x = 'ab'.repeat(32), empty = h.chain.chain.at(-1);
    const hint = mode === 'offchain' ? x : mode === 'notAccepted' ? empty : h.block;
    if (mode === 'offchain') h.over.getBlock = p => p.hash === x ? {block: {header: {hash: x}, verboseData: {isChainBlock: false, selectedParentHash: h.block}}} : undefined;
    if (mode === 'tampered') h.over.getVirtualChainFromBlockV2 = async p => { const out = await h.orig('getVirtualChainFromBlockV2', p); for (const b of out.chainBlockAcceptedTransactions) for (const t of b.acceptedTransactions) t.outputs[0].value = 1n; return out; };
    h.respond = async () => ok(restDTO(await h.stored(), hint, mode === 'offchain' ? undefined : h.blue(hint)));
    if (mode === 'offchain') h.over.getBlock = p => p.hash === x ? {block: {header: {hash: x, blueScore: 1}, verboseData: {isChainBlock: false, selectedParentHash: h.block}}} : undefined;
    const r = await h.engine.reconcile(h.rec.txid);
    assert.equal(r.status, 'UNKNOWN', mode); assert.equal(r.restCheck.node.result, 'CONFLICT', mode); assert.equal(r.restWitness, null);
    assert.equal(recordStatus(r), 'UNKNOWN'); assert.equal(needsAttention(r), true); assert.equal(h.chain.submits, 1);
    assert.equal(await h.engine.localTip(h.plan.cid), null);
  }
});

test('node pruned: REST-only display, journal stays UNKNOWN, inputs reserved, no localTip, archive still gated', async () => {
  for (const mode of ['header', 'acceptance']) {
    const h = await simUnknown(), gone = 'ee'.repeat(32), hint = mode === 'header' ? gone : h.block;
    if (mode === 'header') h.over.getBlock = p => { if (p.hash === gone) throw Error(`getBlock: cannot find header ${gone}`); };
    else h.over.getVirtualChainFromBlockV2 = () => { throw Error('getVirtualChainFromBlockV2: the queried hash does not have retention root on its chain'); };
    h.respond = async () => ok(restDTO(await h.stored(), hint, mode === 'header' ? h.ppBlue - 1000 : h.blue(hint)));
    const r = await h.engine.reconcile(h.rec.txid);
    assert.equal(recordStatus(r), 'REST_ACCEPTED', mode); assert.equal(r.status, 'UNKNOWN'); assert.equal(r.accepted, false);
    assert.equal(r.restCheck.node.result, 'PRUNED'); assert.equal(r.restCheck.node.chainBlock, mode === 'header' ? null : true);
    assert.equal(await h.engine.localTip(h.plan.cid), null);
    assert.ok([...(await h.engine.reserved())].some(k => k.startsWith(h.plan.draft.inputUtxos[0].outpoint.transactionId)));
    assert.equal(h.chain.submits, 1);
  }
});

test('witness lifecycle: REST 404/5xx keep it; REST not-accepted, field mismatch or later node contradiction drop it', async () => {
  const h = await simUnknown(), gone = 'ee'.repeat(32);
  let offchain = false;
  h.over.getBlock = p => { if (p.hash !== gone) return undefined; if (offchain) return {block: {header: {hash: gone, blueScore: h.ppBlue - 1000}, verboseData: {isChainBlock: false, selectedParentHash: h.block}}}; throw Error(`getBlock: cannot find header ${gone}`); };
  const accepted = async () => ok(restDTO(await h.stored(), gone, h.ppBlue - 1000));
  h.respond = accepted; assert.equal(recordStatus(await h.engine.reconcile(h.rec.txid)), 'REST_ACCEPTED');
  const first = (await h.stored()).restWitness.observedAt;
  h.respond = async () => status(404);
  let r = await h.engine.reconcile(h.rec.txid); assert.equal(recordStatus(r), 'REST_ACCEPTED'); assert.equal(r.restCheck.hint.from, 'WITNESS'); assert.equal(r.restWitness.observedAt, first);
  h.respond = async () => status(503);
  r = await h.engine.reconcile(h.rec.txid); assert.equal(recordStatus(r), 'REST_ACCEPTED'); assert.match(r.restCheck.error, /503/);
  h.respond = async () => ok({...restDTO(await h.stored(), gone, h.ppBlue - 1000), is_accepted: false});
  r = await h.engine.reconcile(h.rec.txid); assert.equal(recordStatus(r), 'UNKNOWN'); assert.equal(r.restWitness, null); assert.equal(r.restCheck.node, null);
  h.respond = async () => { const d = restDTO(await h.stored(), gone, h.ppBlue - 1000); d.outputs[0].amount -= 1n; return ok(d); };
  r = await h.engine.reconcile(h.rec.txid); assert.equal(recordStatus(r), 'UNKNOWN'); assert.equal(r.restCheck.fields.ok, false);
  h.respond = accepted; assert.equal(recordStatus(await h.engine.reconcile(h.rec.txid)), 'REST_ACCEPTED');
  offchain = true; h.respond = async () => status(404);
  r = await h.engine.reconcile(h.rec.txid); assert.equal(recordStatus(r), 'UNKNOWN'); assert.equal(r.restCheck.node.result, 'CONFLICT'); assert.equal(r.restWitness, null);
  assert.equal(h.chain.submits, 1);
});

test('offline node + historical receipt: REST-only display; a slow lookup never overwrites another tab (CAS)', async () => {
  const record = await historyRecord(), store = new MemoryStore(), k = PREFIX + record.txid;
  await store.compareAndSet(k, null, record);
  const pair = {nodes: [], connect: async () => { throw Error('没有可用的 TN10 节点：x（无法连接：x）'); }};
  const engine = new EngineV2({pair, openStore: async () => store, locks: testLocks, reorgRecheckDaa: 0n, restQuery: r => queryRest(r, {fetcher: async () => ok(restDTO(record))})});
  const r = await engine.reconcile(record.txid);
  assert.equal(recordStatus(r), 'REST_ACCEPTED'); assert.equal(r.restCheck.node.result, 'UNAVAILABLE'); assert.equal((await engine.reserved()).size, 2);
  let wake, started; const ready = new Promise(x => started = x), wait = new Promise(x => wake = x);
  engine.restQuery = async () => { started(); await wait; return {outcome: 'NOT_FOUND', source: REST_BASE, checkedAt: Date.now()}; };
  const p = engine.reconcile(record.txid); await ready;
  const cur = await store.get(k); await store.compareAndSet(k, cur.revision, {...cur.value, status: 'ACCEPTED', accepted: true}); wake();
  await assert.rejects(p, /STALE_CACHE_REVISION/); assert.equal((await store.get(k)).value.status, 'ACCEPTED');
});

test('verifyAtHint: a missing header counts as pruned only below the pruning point; otherwise conservative', async () => {
  const record = await historyRecord(), H = 'cc'.repeat(32), PP = 'dd'.repeat(32);
  const node = (f, ppBlue = 1000) => ({connect: async () => [{call: async (m, p) => {
    if (m === 'getBlockDagInfo') return {pruningPointHash: PP};
    if (m === 'getBlock' && p.hash === PP) return {block: {header: {hash: PP, blueScore: ppBlue}}};
    return f(m, p);
  }}]});
  const missing = node(async () => { throw Error(`getBlock: cannot find header ${H}`); });
  assert.equal((await verifyAtHint(missing, record, H, '999')).result, 'PRUNED');
  assert.equal((await verifyAtHint(missing, record, H, '1000')).result, 'CONFLICT'); // node should still have it
  assert.equal((await verifyAtHint(missing, record, H, null)).result, 'ERROR'); // cannot judge without blue score
  assert.equal((await verifyAtHint(node(async () => { throw Error('节点请求超时 getBlock@x'); }), record, H, '1')).result, 'UNAVAILABLE');
  assert.equal((await verifyAtHint(node(async () => { throw Error('something unexpected'); }), record, H, '1')).result, 'ERROR');
  assert.equal((await verifyAtHint(node(async () => ({block: {header: {hash: 'ee'.repeat(32), blueScore: 1}}})), record, H, '1')).result, 'ERROR');
  assert.equal((await verifyAtHint(node(async () => ({block: {header: {hash: H, blueScore: 2}, verboseData: {isChainBlock: true}}})), record, H, '1')).result, 'CONFLICT'); // blue mismatch
  assert.equal((await verifyAtHint(node(async () => ({block: {header: {hash: H, blueScore: 1}, verboseData: {}}})), record, H, '1')).result, 'ERROR');
  assert.equal((await verifyAtHint({connect: async () => { throw Error('没有可用的 TN10 节点'); }}, record, H, '1')).result, 'UNAVAILABLE');
});

test('fresh UNKNOWN (< 10 min) never contacts REST; older one does; node search reason is recorded', async () => {
  const now = Date.now();
  assert.equal(wantsRest({status: 'UNKNOWN', createdAt: now - REST_AFTER_MS + 1000}, now), false);
  assert.equal(wantsRest({status: 'UNKNOWN', createdAt: now - REST_AFTER_MS - 1000}, now), true);
  for (const s of ['ACCEPTED', 'PENDING', 'REJECTED', 'ARCHIVED']) assert.equal(wantsRest({status: s, createdAt: 0}, now), false);
  const h = await simUnknown(), k = PREFIX + h.rec.txid, cur = await h.store.get(k);
  await h.store.compareAndSet(k, cur.revision, {...cur.value, createdAt: Date.now()});
  const r = await h.engine.reconcile(h.rec.txid);
  assert.equal(h.restCalls, 0); assert.equal(r.restCheck, undefined); assert.equal(r.status, 'UNKNOWN');
  const old = await h.store.get(k); await h.store.compareAndSet(k, old.revision, {...old.value, createdAt: Date.now() - 3_600_000});
  const r2 = await h.engine.reconcile(h.rec.txid);
  assert.equal(h.restCalls, 1); assert.equal(r2.restCheck.outcome, 'NOT_FOUND'); assert.match(r2.restCheck.nodeSearch, /retention root|未完成|没有/);
});
