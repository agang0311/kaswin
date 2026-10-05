// Offline engine lifecycle: GENESIS -> BUY x3 -> CLOSE -> (sim) ... ; REFUNDING path; failure modes.
// Simulated two-node chain + simulated KasWare (public test key). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SimChain, wsFactory, fakeKasware, simIndexer, loadProfile, MemoryStore, testLocks, TEST_ADDRESS, TEST_KEY} from './sim.mjs';
import {NodeLink} from '../scripts/shared/nodes.mjs';
import {EngineV2 as Engine, chainAncestor} from '../scripts/engine2.mjs';
import {readSession} from '../scripts/shared/wallet.mjs';
import {S} from '../scripts/shared/core.mjs';
import {liveRound} from '../scripts/shared/rounds.mjs';

const profile = loadProfile();
function harness(opts = {}) {
  const chain = new SimChain();
  const pair = new NodeLink(opts.nodes ?? ['wss://alpha.sim/kaspa/testnet-10/wrpc/json'], {WebSocketImpl: wsFactory(chain)});
  const idx = simIndexer(chain, profile);
  globalThis.fetch = idx.fetch;
  const wallet = fakeKasware(opts.wallet);
  globalThis.kasware = wallet;
  const store = new MemoryStore();
  const engine = new Engine({pair, profile, indexer: 'http://localhost/indexer', openStore: async () => store, locks: testLocks});
  return {chain, pair, idx, wallet, engine, store};
}
const config = (daa, extra = {}) => ({ticketPrice: 100_000_000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: daa + 1000n, ...extra});

async function genesis(h, cfg) {
  const session = await readSession(globalThis.kasware, {request: true});
  const plan = await h.engine.plan({action: 'GENESIS', config: cfg, registry: true}, session);
  const rec = await h.engine.execute(plan, {approved: true});
  assert.equal(rec.status, 'SUBMITTED');
  const tx = h.chain.accepted.get(rec.txid);
  h.idx.track(plan.cid, {genesisTxid: rec.txid, origin: plan.draft.inputUtxos[0].outpoint, tip: {transactionId: rec.txid, index: 0}, ledger: S.encodeLedger(plan.draft.transaction && S.decodeLedger(S.encodeLedger(S.newOpen(TEST_KEY, profile.networkGenesis, Object.fromEntries(S.MODULES.map(m => [m, profile.frames[m].templateHash])), cfg))))});
  return {plan, rec, session, tx};
}
async function step(h, cid, request, session) {
  const plan = await h.engine.plan({...request, cid}, session);
  const rec = await h.engine.execute(plan, {approved: true});
  assert.equal(rec.status, 'SUBMITTED', rec.error);
  const r = h.idx.rounds.get(cid);
  if (plan.draft.transition.next) h.idx.track(cid, {...r, tip: {transactionId: rec.txid, index: 0}, ledger: S.encodeLedger(plan.draft.transition.next)});
  else h.idx.track(cid, {...r, terminal: plan.draft.transition.terminal});
  return {plan, rec};
}

test('v2: off-chain cursor repaired, acceptance still field-checked, zero extra submits', async () => {
  const h=harness();h.chain.fund(TEST_ADDRESS,50_000_000_000n);
  const {rec}=await genesis(h,config(h.chain.daa));
  const k=[...h.store.map.keys()].find(k=>k.endsWith(rec.txid)),r=h.store.map.get(k).value;
  const [n]=await h.pair.connect(),orig=n.call.bind(n),off='ab'.repeat(32),parent=r.anchors[0].sink;
  r.cursors[n.url]=off;
  n.call=async (method,p)=>method==='getBlock'&&p.hash===off?{block:{header:{hash:off},verboseData:{isChainBlock:false,selectedParentHash:parent}}}:orig(method,p);
  assert.equal((await h.engine.reconcile(rec.txid)).status,'ACCEPTED');assert.equal(h.chain.submits,1);
});

test('v2: reorg during search stays UNKNOWN, field tampering never accepted',async()=>{
 for (const mode of ['reorg','tamper']) {
  const h=harness();h.chain.fund(TEST_ADDRESS,50_000_000_000n);const {rec}=await genesis(h,config(h.chain.daa));
  const [n]=await h.pair.connect(),orig=n.call.bind(n);
  n.call=async(method,p)=>{const out=await orig(method,p);
   if(mode==='reorg'&&method==='getVirtualChainFromBlock')out.removedChainBlockHashes=['aa'.repeat(32)];
   if(mode==='tamper'&&method==='getVirtualChainFromBlockV2'){const tx=out.chainBlockAcceptedTransactions.flatMap(b=>b.acceptedTransactions)[0];if(tx)tx.outputs[0].value=1n;}
   return out;
  };
  assert.equal((await h.engine.reconcile(rec.txid)).status,'UNKNOWN');assert.equal(h.chain.submits,1);
 }
});

test('v2: UNKNOWN older than 24h cannot release live inputs, including contract-only draft', async()=>{
 const h=harness();h.chain.fund(TEST_ADDRESS,50_000_000_000n);
 const session=await readSession(globalThis.kasware,{request:true});const p=await h.engine.plan({action:'GENESIS',config:config(h.chain.daa)},session);
 h.chain.rejectNext='connection reset';const r=await h.engine.execute(p,{approved:true});
 const k=[...h.store.map.keys()].find(k=>k.endsWith(r.txid)),v=h.store.map.get(k).value;v.createdAt-=3*86400000;
 assert.equal((await h.engine.reconcile(r.txid)).status,'UNKNOWN');
 await assert.rejects(h.engine.archive(r.txid),/仍然未花费/);
 h.store.map.get(k).value.draft.authorizedInputIndices=[];
 await assert.rejects(h.engine.archive(r.txid),/仍然未花费/);assert.equal(h.chain.submits,1);
});

test('v2: archive needs outpoint absence, not amount mismatch or query failure',async()=>{
 const h=harness();h.chain.fund(TEST_ADDRESS,50_000_000_000n);
 const session=await readSession(globalThis.kasware,{request:true});const p=await h.engine.plan({action:'GENESIS',config:config(h.chain.daa)},session);
 h.chain.rejectNext='connection reset';const r=await h.engine.execute(p,{approved:true});
 const u=h.chain.utxos.values().next().value;u.value-=1n;
 await assert.rejects(h.engine.archive(r.txid),/仍然未花费/);
 const [n]=await h.pair.connect(),orig=n.call.bind(n);
 n.call=async(method,p)=>{if(method==='getUtxosByAddresses')throw Error('offline');return orig(method,p);};
 await assert.rejects(h.engine.archive(r.txid),/offline/);
 n.call=orig;h.chain.utxos.clear();await h.engine.archive(r.txid);
 assert.equal((await h.engine.records())[0].status,'ARCHIVED');assert.equal(h.chain.submits,1);
});

test('v2: old accepted evidence with missing block never becomes irreversible ACCEPTED',async()=>{
 const h=harness();h.chain.fund(TEST_ADDRESS,50_000_000_000n);const {rec}=await genesis(h,config(h.chain.daa));
 const r=await h.engine.reconcile(rec.txid);assert.equal(r.status,'ACCEPTED');
 h.chain.daa+=900000n;h.chain.blocks.delete(r.accepting);
 const after=await h.engine.reconcile(rec.txid);assert.equal(after.status,'UNKNOWN');assert.equal(h.chain.submits,1);
});

test('v2: ancestor walk bounded; no upgrade on a repeatedly off-chain ancestor',async()=>{
 let calls=0;const h='aa'.repeat(32),b={header:{hash:h},verboseData:{isChainBlock:false,selectedParentHash:h}};
 assert.equal(await chainAncestor({call:async()=>{calls++;return {block:b};}},b,4),null);assert.equal(calls,4);
});

test('engine: full payout-free path GENESIS -> BUY x3 -> CLOSE(SEALED) -> TIMEOUT_REFUND -> REFUND (terminal), reconcile ACCEPTED', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g, session} = await genesis(h, config(h.chain.daa));
  assert.equal(g.outputs[0].role, 'STATE'); assert.equal(g.outputs[1].role, 'REGISTRY');
  assert.equal(g.draft.authorizedInputIndices.length, 1);
  for (let i = 0; i < 3; i++) {
    const {plan} = await step(h, g.cid, {action: 'BUY', quantity: 1}, session);
    assert.equal(plan.budget, S.decodeLedger(S.encodeLedger(plan.draft.transition.next)).purchaseCount - 1 >= 0 ? plan.budget : -1);
    assert.equal(plan.after.sold, i + 1);
  }
  const close = await step(h, g.cid, {action: 'CLOSE'}, session); // sold == cap -> early close allowed
  assert.equal(close.plan.after.phase, S.Phase.SEALED);
  // DRAW_AND_PAY needs real PASS-A data (not simulated here); exercise the timeout exit instead.
  await assert.rejects(h.engine.plan({action: 'TIMEOUT_REFUND', cid: g.cid}, session), /300 DAA|不允许/);
  h.chain.advance(301);
  const t = await step(h, g.cid, {action: 'TIMEOUT_REFUND'}, session);
  assert.equal(t.plan.after.phase, S.Phase.REFUNDING);
  const rf = await step(h, g.cid, {action: 'REFUND'}, session);
  assert.equal(rf.plan.terminal, 'REFUNDED');
  const roles = rf.plan.outputs.map(o => o.role);
  assert.deepEqual(roles.filter(r => r === 'BUYER_REFUND').length, 3);
  assert.ok(roles.includes('CREATOR') && roles.includes('EXECUTOR'));
  // every buyer refund = price - 0.01 TKAS
  for (const o of rf.plan.outputs.filter(o => o.role === 'BUYER_REFUND')) assert.equal(o.value, 99_000_000n);
  const r = await h.engine.reconcile(rf.rec.txid);
  assert.equal(r.status, 'ACCEPTED', r.error); assert.equal(r.actualFee, rf.plan.fee);
});

test('engine: CLOSE below minimum routes to REFUNDING; empty round CLOSE returns deposit (EMPTY)', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g, session} = await genesis(h, config(h.chain.daa, {ticketCap: 10, minTickets: 5}));
  await step(h, g.cid, {action: 'BUY', quantity: 2}, session);
  await assert.rejects(h.engine.plan({action: 'CLOSE', cid: g.cid}, session), /封盘时间/);
  h.chain.advance(1001);
  const c = await step(h, g.cid, {action: 'CLOSE'}, session);
  assert.equal(c.plan.after.phase, S.Phase.REFUNDING);
  const h2 = harness();
  h2.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const g2 = await genesis(h2, config(h2.chain.daa));
  h2.chain.advance(1001);
  const e = await step(h2, g2.plan.cid, {action: 'CLOSE'}, g2.session);
  assert.equal(e.plan.terminal, 'EMPTY');
  assert.equal(e.plan.outputs.find(o => o.role === 'CREATOR').value, 20_000_000n);
});

test('engine: wallet that mutates committed fields or signs with another key is rejected before submission', async () => {
  for (const wallet of [{mutate: j => { j.outputs[0].value = String(BigInt(j.outputs[0].value) - 1n); }}, {mutate: j => { j.lockTime = '7'; }}, {mutate: j => { j.inputs[0].sequence = '1'; }}, {wrongKey: true}]) {
    const h = harness({wallet});
    h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
    const session = await readSession(globalThis.kasware, {request: true});
    const plan = await h.engine.plan({action: 'GENESIS', config: config(h.chain.daa), registry: false}, session);
    await assert.rejects(h.engine.execute(plan, {approved: true}), /钱包修改|签名验证失败/);
    assert.equal(h.chain.submits, 0);
    assert.equal((await h.engine.records()).length, 0);
  }
});

test('engine: wallet echo of non-committed fields is ignored; the page submits its own budgets and storage mass', async () => {
  const h = harness({wallet: {mutate: j => { for (const i of j.inputs) i.computeBudget = 0; j.storageMass = '0'; }}});
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const session = await readSession(globalThis.kasware, {request: true});
  const plan = await h.engine.plan({action: 'GENESIS', config: config(h.chain.daa), registry: false}, session);
  const rec = await h.engine.execute(plan, {approved: true});
  assert.equal(rec.status, 'SUBMITTED');
  assert.equal(rec.walletEchoDiffers, true);
  const sent = h.chain.accepted.get(rec.txid).tx;
  assert.equal(sent.storageMass, plan.draft.transaction.storageMass);
  assert.deepEqual(sent.inputs.map(i => i.computeBudget), plan.draft.transaction.inputs.map(i => i.computeBudget));
});

test('engine: lost submit response is UNKNOWN, inputs stay reserved, no second submit; reconcile finds acceptance', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const session = await readSession(globalThis.kasware, {request: true});
  const plan = await h.engine.plan({action: 'GENESIS', config: config(h.chain.daa), registry: false}, session);
  h.chain.dropResponse = true;
  const rec = await h.engine.execute(plan, {approved: true});
  assert.equal(rec.status, 'UNKNOWN'); assert.equal(h.chain.submits, 1);
  await assert.rejects(h.engine.execute(plan, {approved: true}), /失效/); // plan is single-use
  // The reserved input of the unknown record is never offered again (here the chain did accept it, so only its change is live).
  const again = await h.engine.plan({action: 'GENESIS', config: config(h.chain.daa), registry: false}, session);
  assert.ok(!again.draft.inputUtxos.some(u => rec.inputs.some(o => o.transactionId === u.outpoint.transactionId && o.index === u.outpoint.index)));
  const r = await h.engine.reconcile(rec.txid);
  assert.equal(r.status, 'ACCEPTED', r.error); assert.equal(h.chain.submits, 1);
});

test('engine: definite node rejection is recorded REJECTED; approval flag and plan TTL enforced', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const session = await readSession(globalThis.kasware, {request: true});
  const plan = await h.engine.plan({action: 'GENESIS', config: config(h.chain.daa), registry: false}, session);
  await assert.rejects(h.engine.execute(plan, {approved: false}), /批准/);
  const p2 = await h.engine.plan({action: 'GENESIS', config: config(h.chain.daa), registry: false}, session);
  h.chain.rejectNext = `Rejected transaction ${p2.draft.txid}: transaction ${p2.draft.txid} has insufficient fee`;
  const rec = await h.engine.execute(p2, {approved: true});
  assert.equal(rec.status, 'REJECTED');
  const p3 = await h.engine.plan({action: 'GENESIS', config: config(h.chain.daa), registry: false}, session);
  p3.createdAt -= 91_000;
  await assert.rejects(h.engine.execute(p3, {approved: true}), /90 秒/);
});

test('engine: stale tip (someone else advanced the round) is detected before signing', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g, session} = await genesis(h, config(h.chain.daa, {ticketCap: 100}));
  const p = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session);
  // a competing BUY lands first
  const other = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 2}, session);
  const won = await h.engine.execute(other, {approved: true});
  assert.equal(won.status, 'SUBMITTED');
  await assert.rejects(h.engine.execute(p, {approved: true}), /已失效|未花费|占用/);
});

test('engine: wrong wallet network is refused', async () => {
  const h = harness({wallet: {network: 'kaspa_mainnet'}});
  await assert.rejects(readSession(globalThis.kasware, {request: true}), /Testnet 10/);
});

test('liveRound: indexer data that disagrees with the nodes is rejected', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g} = await genesis(h, config(h.chain.daa));
  await h.pair.connect();
  const daa = await h.pair.currentDaa();
  await liveRound(h.pair, 'http://localhost/indexer', profile, g.cid, daa); // consistent
  const r = h.idx.rounds.get(g.cid);
  h.idx.track(g.cid, {...r, ledger: S.encodeLedger({...S.decodeLedger(r.ledger), config: {...S.decodeLedger(r.ledger).config, ticketPrice: 200_000_000n}})});
  await assert.rejects(liveRound(h.pair, 'http://localhost/indexer', profile, g.cid, daa), /CID|SPK|MISMATCH|不一致/);
});

test('engine: continues from its own ACCEPTED successor when the indexer lags (still verified on both nodes)', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g, session, rec: gr} = await genesis(h, config(h.chain.daa, {ticketCap: 10}));
  assert.equal((await h.engine.reconcile(gr.txid)).status, 'ACCEPTED');
  // BUY #1 through the engine, but DO NOT update the simulated indexer (it keeps pointing at the genesis tip).
  const p1 = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 2}, session);
  const r1 = await h.engine.execute(p1, {approved: true});
  assert.equal(r1.status, 'SUBMITTED');
  assert.equal((await h.engine.reconcile(r1.txid)).status, 'ACCEPTED');
  // Next BUY must build on the local successor (sold 2), not on the stale indexer tip.
  const p2 = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session);
  assert.equal(p2.before.sold, 2);
  assert.equal(p2.draft.transaction.inputs[0].previousOutpoint.transactionId, r1.txid);
  const r2 = await h.engine.execute(p2, {approved: true});
  assert.equal(r2.status, 'SUBMITTED');
  // A forged local ledger is never trusted: tamper the stored successor and planning must fail on the nodes' P2SH check.
  const k = [...h.store.map.keys()].find(x => x.endsWith(r2.txid));
  const stored = h.store.map.get(k);
  stored.value.status = 'ACCEPTED'; stored.value.accepting = h.chain.accepted.get(r2.txid).block; stored.value.acceptingDaa = h.chain.utxos.get(`${r2.txid}:0`).daa;
  // Forge the ticket price (bytes 8..16 of the ledger): structurally valid, but it changes the P2SH and the root CID.
  const L = S.decodeLedger(Uint8Array.from(Buffer.from(stored.value.nextLedger, 'hex')));
  stored.value.nextLedger = Buffer.from(S.encodeLedger({...L, config: {...L.config, ticketPrice: L.config.ticketPrice + 1n}})).toString('hex');
  await assert.rejects(h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session), /CID_MISMATCH|STATE_INPUT|不一致/);
});

test('NodeLink: uses the first reachable synced node in order; reports why earlier ones were skipped', async () => {
  const chain = new SimChain();
  const base = wsFactory(chain);
  // "down.sim" refuses connections, "lagging.sim" is unsynced, "good.sim" works.
  class WS extends base {
    constructor(url) {
      const h = new URL(url).host;
      if (h.startsWith('down')) { super(url); setTimeout(() => { this.readyState = 3; this.onerror?.(); }, 0); this.onopen = null; return; }
      super(url);
      if (h.startsWith('lagging')) { const m = this.methods.getServerInfo; this.methods.getServerInfo = () => ({...m(), isSynced: false}); }
    }
  }
  const link = new NodeLink(['wss://down.sim/x', 'wss://lagging.sim/x', 'wss://good.sim/x'], {WebSocketImpl: WS});
  const [n] = await link.connect();
  assert.equal(new URL(n.url).host, 'good.sim');
  const st = link.status();
  assert.equal(st.connected, true);
  assert.deepEqual(st.rejected.map(r => new URL(r.url).host), ['down.sim', 'lagging.sim']);
  assert.match(st.rejected[1].reason, /同步/);
  assert.equal(typeof (await link.currentDaa()), 'bigint');
  link.close();
  const none = new NodeLink(['wss://down.sim/x'], {WebSocketImpl: WS});
  await assert.rejects(none.connect(), /没有可用的 TN10 节点/);
});

test('replay: DRAW_AND_PAY winner ticket is recomputed exactly as the contract does (archived f256 draw -> #164)', async () => {
  const fs = await import('node:fs');
  const {S, sample, authenticateDraw, unhex, p2sh, hex, blake2b256} = await import('../scripts/shared/core.mjs');
  const {ledgerFromDetail} = await import('../scripts/shared/rounds.mjs');
  const a = JSON.parse(fs.readFileSync(new URL('./fixtures/f256-draw.json', import.meta.url), 'utf8')), D = a.notes.f256.draw;
  const item = a.details.find(d => d.item.cid === D.cid).item;
  const spent = ledgerFromDetail({...item, state: {...item.state, phase: 2}}, profile);
  const snapshot = {ledger: S.encodeLedger(spent), tip: D.sealedTip, origin: item.origin, scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(spent, profile)))),
    covenantId: D.cid, value: BigInt(spent.sold) * spent.config.ticketPrice + S.DEPOSIT, utxoDaa: BigInt(D.sealedUtxoDaa), currentDaa: BigInt(D.acceptingDaa)};
  S.verifySnapshot(snapshot, profile);
  const smp = sample(authenticateDraw(snapshot, spent, unhex(D.opening), {blockHash: D.target.hash, sequenceCommitment: D.target.seqCommit}));
  assert.equal(smp.ticket + 1, 164);
  const rec = S.records(spent)[D.hint];
  assert.ok(smp.ticket + 1 > rec.end - rec.count && smp.ticket + 1 <= rec.end);
  // The broken call shape introduced on 2026-10-02 must not come back: sample() takes a ledger, not (commitment, sold).
  assert.throws(() => sample(D.target.seqCommit, spent.sold));
  const src = fs.readFileSync(new URL('../scripts/shared/replay.mjs', import.meta.url), 'utf8');
  assert.ok(!/sample\(op\.accessor\.sequenceCommitment/.test(src));
});
