// Offline engine lifecycle: GENESIS -> BUY x3 -> CLOSE -> (sim) ... ; REFUNDING path; failure modes.
// One active simulated node + simulated KasWare (public test key). No network or consensus execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SimChain, wsFactory, fakeKasware, simIndexer, loadProfile, MemoryStore, testLocks, TEST_ADDRESS, TEST_KEY} from './sim.mjs';
import {NodeLink} from '../scripts/shared/nodes.mjs';
import {EngineV2 as Engine, chainAncestor} from '../scripts/engine2.mjs';
import {readSession} from '../scripts/shared/wallet.mjs';
import {S, unhex, authenticateDraw, sample, winnerRecord} from '../scripts/shared/core.mjs';
import {replayAccepted} from '../scripts/shared/replay.mjs';
import {liveRound} from '../scripts/shared/rounds.mjs';

const profile = loadProfile();
const passA = JSON.parse(fs.readFileSync(new URL('./fixtures/pass-a-public.json', import.meta.url), 'utf8'));
const PASS_A_OPENING = unhex(passA.openingHex);
const PASS_A_TARGET = {blockHash: passA.target.hash, sequenceCommitment: passA.target.seqCommit};

function harness(opts = {}) {
  const chain = new SimChain(opts.chain);
  const pair = new NodeLink(opts.nodes ?? ['wss://alpha.sim/kaspa/testnet-10/wrpc/json'], {WebSocketImpl: wsFactory(chain)});
  const idx = simIndexer(chain, profile);
  globalThis.fetch = idx.fetch;
  const wallet = fakeKasware(opts.wallet);
  globalThis.kasware = wallet;
  const store = new MemoryStore();
  const engine = new Engine({pair, profile, indexer: 'http://localhost/indexer', openStore: async () => store, locks: testLocks, reorgRecheckDaa: 0n, drawProof: opts.drawProof});
  return {chain, pair, idx, wallet, engine, store};
}
const config = (daa, extra = {}) => ({ticketPrice: 100_000_000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: daa + 1000n, ...extra});

async function genesis(h, cfg) {
  const session = await readSession(globalThis.kasware, {request: true});
  const plan = await h.engine.plan({action: 'GENESIS', config: cfg, registry: true}, session);
  const rec = await h.engine.execute(plan, {approved: true});
  assert.equal(rec.status, 'SUBMITTED');
  const tx = h.chain.accepted.get(rec.txid);
  h.idx.track(plan.cid, {genesisTxid: rec.txid, origin: plan.draft.inputUtxos[0].outpoint, tip: {transactionId: rec.txid, index: 0}, ledger: S.encodeLedger(S.newOpen(TEST_KEY, cfg))});
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

test('engine: normal draw and payout GENESIS -> BUY x3 -> CLOSE(SEALED) -> DRAW_AND_PAY (PAID terminal), reconcile ACCEPTED', async () => {
  const drawProof = async (_link, _p, live) => {
    const s = live.ledger, x = live.snapshot;
    const drawn = authenticateDraw(x, s, PASS_A_OPENING, PASS_A_TARGET);
    const smp = sample(drawn);
    assert.notEqual(smp.ticket, null);
    const accepted = {...drawn, phase: S.Phase.WINNER_READY, winnerPlusOne: smp.ticket + 1};
    const idx = winnerRecord(accepted), rec = S.records(accepted)[idx];
    return {
      opening: PASS_A_OPENING, openingHex: passA.openingHex,
      target: {hash: passA.target.hash, seqCommit: passA.target.seqCommit},
      parent: {hash: passA.parent.hash, daa: passA.parent.daa},
      boundaryDaa: passA.boundaryDaa, nodes: ['sim'], seed: drawn.seed,
      winner: {ticket: smp.ticket + 1, record: idx, key: rec.key, recordTickets: rec.count, sampleValue: smp.value.toString(), limit: smp.limit.toString()}
    };
  };
  const h = harness({chain: {daa: 580025200n}, drawProof});
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g, session} = await genesis(h, config(h.chain.daa, {ticketPrice: 100_000_000n, ticketCap: 3, minTickets: 3}));
  assert.equal(g.outputs[0].role, 'STATE');
  assert.equal(g.outputs[1].role, 'REGISTRY');
  for (let i = 0; i < 3; i++) {
    const {plan} = await step(h, g.cid, {action: 'BUY', quantity: 1}, session);
    assert.equal(plan.after.sold, i + 1);
  }
  // Align the accepting block of CLOSE to exactly match the PASS_A boundary condition: utxoDaa + 100 = 580025326
  h.chain.daa = 580025225n;
  const close = await step(h, g.cid, {action: 'CLOSE'}, session);
  assert.equal(close.plan.after.phase, S.Phase.SEALED);
  const sealedUtxoDaa = h.chain.utxos.get(`${close.rec.txid}:0`).daa;
  assert.equal(sealedUtxoDaa, 580025226n);

  // Advance chain beyond 100 DAA after sealing (boundary = 580025326)
  h.chain.advance(101);
  assert.ok(h.chain.daa >= 580025327n);

  // Register the target block in simulated chain so header verification succeeds
  h.chain.blocks.set(passA.target.hash, {
    hash: passA.target.hash, daa: 580025327n, blue: 590000100n, parent: passA.parent.hash, txs: [], seqCommit: passA.target.seqCommit
  });

  const pay = await step(h, g.cid, {action: 'DRAW_AND_PAY'}, session);
  assert.equal(pay.plan.action, 'DRAW_AND_PAY');
  assert.equal(pay.plan.terminal, 'PAID');
  assert.equal(pay.rec.status, 'SUBMITTED');

  // Verify payout structure: Output 0 is Winner Prize, Output 1 is Creator Deposit return, Output 2 is Executor Finalizer Bounty
  const roles = pay.plan.outputs.map(o => o.role);
  assert.deepEqual(roles, ['WINNER', 'CREATOR', 'EXECUTOR']);
  assert.equal(pay.plan.outputs[1].value, S.DEPOSIT); // 20,000,000 (0.2 TKAS)
  assert.equal(pay.plan.outputs[2].value, S.FINALIZER); // 100,000,000 (1 TKAS)
  assert.equal(pay.plan.outputs[0].value, 300_000_000n - S.FINALIZER - pay.plan.fee); // 3 TKAS - 1 TKAS - fee

  const rec = await h.engine.reconcile(pay.rec.txid);
  assert.equal(rec.status, 'ACCEPTED');

  // Independent replay verification of the ACCEPTED DRAW_AND_PAY transition
  const replayed = await replayAccepted(h.pair, profile, pay.rec.txid, rec.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(replayed.action, 'DRAW_AND_PAY');
  assert.equal(replayed.terminal, 'PAID');
  assert.equal(replayed.winner.ticket, pay.plan.winner.ticket);
  assert.equal(replayed.outputs[0].value, pay.plan.outputs[0].value);
});

test('engine: empty round (zero ticket sales) CLOSE returns deposit (EMPTY terminal), reconcile ACCEPTED', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g, session} = await genesis(h, config(h.chain.daa, {ticketCap: 3, minTickets: 3}));
  // Trying to close before eligible closing time must be rejected
  await assert.rejects(h.engine.plan({action: 'CLOSE', cid: g.cid}, session), /封盘时间/);
  h.chain.advance(1001);
  const e = await step(h, g.cid, {action: 'CLOSE'}, session);
  assert.equal(e.plan.terminal, 'EMPTY');
  assert.equal(e.plan.outputs.find(o => o.role === 'CREATOR').value, S.DEPOSIT); // 0.2 TKAS full refund

  const r = await h.engine.reconcile(e.rec.txid);
  assert.equal(r.status, 'ACCEPTED');

  const replayed = await replayAccepted(h.pair, profile, e.rec.txid, r.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(replayed.terminal, 'EMPTY');
  assert.equal(replayed.outputs[0].value, S.DEPOSIT);
});

test('engine: sales below minimum tickets route to REFUNDING -> REFUND batches (REFUNDED terminal), reconcile ACCEPTED', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g, session} = await genesis(h, config(h.chain.daa, {ticketCap: 10, minTickets: 5}));
  // Buy 2 tickets (2 < 5, does not meet minimum tickets)
  await step(h, g.cid, {action: 'BUY', quantity: 1}, session);
  await step(h, g.cid, {action: 'BUY', quantity: 1}, session);

  // Before closeEligibleDaa, CLOSE is not allowed
  await assert.rejects(h.engine.plan({action: 'CLOSE', cid: g.cid}, session), /封盘时间/);
  h.chain.advance(1001);

  // CLOSE under minTickets transitions to REFUNDING
  const c = await step(h, g.cid, {action: 'CLOSE'}, session);
  assert.equal(c.plan.after.phase, S.Phase.REFUNDING);
  assert.equal(c.plan.after.value, S.DEPOSIT + 2n * 100_000_000n); // 2.2 TKAS intact

  const rc = await h.engine.reconcile(c.rec.txid);
  assert.equal(rc.status, 'ACCEPTED');

  const repClose = await replayAccepted(h.pair, profile, c.rec.txid, rc.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(repClose.next.phase, S.Phase.REFUNDING);

  // Execute REFUND batch (all 2 records refunded in a single batch)
  const rf = await step(h, g.cid, {action: 'REFUND'}, session);
  assert.equal(rf.plan.terminal, 'REFUNDED');
  const roles = rf.plan.outputs.map(o => o.role);
  assert.deepEqual(roles.filter(r => r === 'BUYER_REFUND').length, 2);
  assert.ok(roles.includes('CREATOR') && roles.includes('EXECUTOR'));

  // Each buyer gets ticketPrice - 0.01 TKAS
  for (const o of rf.plan.outputs.filter(o => o.role === 'BUYER_REFUND')) {
    assert.equal(o.value, 100_000_000n - S.REFUND_FEE);
  }
  // Creator deposit returned
  assert.equal(rf.plan.outputs.find(o => o.role === 'CREATOR').value, S.DEPOSIT);

  const rrf = await h.engine.reconcile(rf.rec.txid);
  assert.equal(rrf.status, 'ACCEPTED');

  const repRefund = await replayAccepted(h.pair, profile, rf.rec.txid, rrf.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(repRefund.terminal, 'REFUNDED');
  assert.equal(repRefund.outputs.find(o => o.role === 'CREATOR').value, S.DEPOSIT);
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

test('engine: continues from its own ACCEPTED successor when the indexer lags (checked on the active simulated node)', async () => {
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

test('V2 seed/sample preimage and non-OPEN origin authentication (synthetic JS vector, NOT VM or TN10)', async () => {
  const {sample, authenticateDraw, unhex, p2sh, hex, blake2b256, cat, le, ascii, fromLe} = await import('../scripts/shared/core.mjs');
  const {targetSeqOf} = await import('../scripts/shared/replay.mjs');
  const spent = {...S.appendPurchase(S.newOpen(TEST_KEY, config(100n)), 3, TEST_KEY), phase: S.Phase.SEALED};
  const origin = {transactionId: '11'.repeat(32), index: 1}, tip = {transactionId: '22'.repeat(32), index: 0};
  const snapshot = {ledger: S.encodeLedger(spent), tip, origin, covenantId: S.rootId(origin, S.rootScript(spent, profile)),
    scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(spent, profile)))), value: S.valueOf(spent), utxoDaa: 2000n, currentDaa: 2100n};
  S.verifySnapshot(snapshot, profile);
  assert.throws(() => S.verifySnapshot({...snapshot, origin: undefined}, profile), /ORIGIN_REQUIRED/);
  assert.throws(() => S.verifySnapshot({...snapshot, origin: {...origin, index: 2}}, profile), /OPEN_GENESIS_CID_MISMATCH/);
  const opening = new Uint8Array(240); opening.set(unhex('44'.repeat(32)));
  opening.set(le(2100n, 8), 104); opening.set(le(2099n, 8), 224);
  opening.set(le(2n, 8), 112); opening.set(le(1n, 8), 232);
  const seq = targetSeqOf(opening), drawn = authenticateDraw(snapshot, spent, opening, {blockHash: '44'.repeat(32), sequenceCommitment: seq});
  const frozen = blake2b256(cat(snapshot.ledger.slice(8, 44), spent.directory));
  const expectedSeed = blake2b256(cat(ascii('KASWIN_V2_DRAW'), unhex(snapshot.covenantId), unhex(tip.transactionId), le(0n, 4), frozen, le(2100n, 8), opening.slice(0, 32), unhex(seq)));
  assert.equal(drawn.seed, hex(expectedSeed));
  const digest = blake2b256(cat(ascii('KASWIN_V2_SAMPLE'), expectedSeed, le(0n, 8)));
  const value = fromLe(digest.slice(0, 7)), space = 1n << 56n, limit = space - space % 3n;
  assert.deepEqual(sample(drawn), {value, limit, ticket: value < limit ? Number(value % 3n) : null});
  assert.throws(() => sample(seq, spent.sold)); // sample takes a ledger, never (commitment, sold).
});

test('engine: another Profile reserves funding before signing while records and reconcile stay isolated', async () => {
  const {NETWORK_GENESIS, PROFILE_ID} = await import('../scripts/shared/core.mjs');
  const h = harness(); h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const session = await readSession(globalThis.kasware, {request: true});
  const request = {action: 'GENESIS', config: config(h.chain.daa)};
  const plan = await h.engine.plan(request, session);
  const other = PROFILE_ID === 'aa'.repeat(32) ? 'bb'.repeat(32) : 'aa'.repeat(32), txid = 'cc'.repeat(32);
  const k = `${NETWORK_GENESIS}/${other}/tx/${txid}`;
  await h.store.compareAndSet(k, null, {status: 'UNKNOWN', inputs: plan.draft.inputUtxos.map(f => f.outpoint)});
  const before = await h.store.get(k);
  assert.deepEqual(await h.engine.records(), []);
  await assert.rejects(h.engine.execute(plan, {approved: true}), /输入已被/);
  await assert.rejects(h.engine.plan(request, session), /资金不足/);
  await assert.rejects(h.engine.reconcile(txid), /没有.*记录/);
  assert.deepEqual(await h.store.get(k), before);
  assert.equal(h.chain.submits, 0);
});

test('engine: a refused action still reports the node-verified state; local CLOSE wins over a lagging indexer', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const seen = [];
  h.engine.onLive = (live, cid) => seen.push({cid, phase: live.ledger.phase, source: live.source, tip: live.snapshot.tip.transactionId});
  const {plan: g, session, rec: gr} = await genesis(h, config(h.chain.daa, {ticketCap: 3}));
  assert.equal((await h.engine.reconcile(gr.txid)).status, 'ACCEPTED');
  const {rec: b} = await step(h, g.cid, {action: 'BUY', quantity: 3}, session);
  assert.equal((await h.engine.reconcile(b.txid)).status, 'ACCEPTED');
  // CLOSE through the engine; the simulated indexer intentionally stays at the OPEN tip.
  const pc = await h.engine.plan({action: 'CLOSE', cid: g.cid}, session);
  const c = await h.engine.execute(pc, {approved: true});
  assert.equal((await h.engine.reconcile(c.txid)).status, 'ACCEPTED');
  seen.length = 0;
  await assert.rejects(h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session), /轮次已封盘/);
  assert.deepEqual(seen, [{cid: g.cid, phase: 2, source: 'local', tip: c.txid}]);
});

test('liveRound: a further-along local successor that is not live (reorged out) yields to the live indexer tip', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {plan: g, session, rec: gr} = await genesis(h, config(h.chain.daa, {ticketCap: 10}));
  assert.equal((await h.engine.reconcile(gr.txid)).status, 'ACCEPTED');
  // A BUY this browser once saw ACCEPTED but which is no longer on the selected chain: valid successor ledger, absent txid.
  const p = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 2}, session);
  const local = {txid: 'ff'.repeat(32), terminal: null, nextLedger: p.nextLedger, value: p.nextValue, spk: p.nextSpk, utxoDaa: h.chain.daa,
    accepting: h.chain.chain.at(-1), origin: p.origin, genesisTxid: gr.txid, inputs: p.draft.inputUtxos.map(u => u.outpoint)};
  await h.pair.connect();
  const live = await liveRound(h.pair, 'http://localhost/indexer', profile, g.cid, await h.pair.currentDaa(), local);
  assert.equal(live.source, 'indexer'); assert.equal(live.snapshot.tip.transactionId, gr.txid); assert.equal(live.ledger.sold, 0);
});
