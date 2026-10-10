// Reorg recheck (project policy 100 DAA ≈ 10 s; deepest observed selected-chain removal 83 DAA, mainnet 24 h read-only
// monitor 2026-09-26/27). Protects: a first acceptance is only CONFIRMING; it becomes ACCEPTED only after acceptance is
// verified again with the accepting block >= 100 DAA deep; a short reorg in between is followed (re-found in a sibling
// block, or not found at all -> never ACCEPTED, inputs stay reserved, never resubmitted); a CONFIRMING record does not
// unlock the next round action. Simulated chain (SimChain.reorgBlock), NOT a real TN10 reorg.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SimChain, wsFactory, fakeKasware, simIndexer, loadProfile, MemoryStore, testLocks, TEST_ADDRESS} from './sim.mjs';
import {NodeLink} from '../scripts/shared/nodes.mjs';
import {EngineV2 as Engine} from '../scripts/engine2.mjs';
import {acceptanceStep} from '../scripts/shared/engine.mjs';
import {REORG_RECHECK_DAA, acceptanceDepth} from '../scripts/shared/chain.mjs';
import {readSession} from '../scripts/shared/wallet.mjs';
import {unhex} from '../scripts/shared/core.mjs';
import {txStatus, needsAttention} from '../visual/view.mjs';

const profile = loadProfile();
function harness() {
  const chain = new SimChain(), pair = new NodeLink(['wss://alpha.sim/kaspa/testnet-10/wrpc/json'], {WebSocketImpl: wsFactory(chain)});
  const idx = simIndexer(chain, profile); globalThis.fetch = idx.fetch; globalThis.kasware = fakeKasware();
  const store = new MemoryStore();
  const engine = new Engine({pair, profile, indexer: 'http://localhost/indexer', openStore: async () => store, locks: testLocks});
  chain.fund(TEST_ADDRESS, 50_000_000_000n);
  return {chain, idx, engine, store};
}
const cfg = daa => ({ticketPrice: 100_000_000n, ticketCap: 100, purchaseCap: 256, minTickets: 3, closeEligibleDaa: daa + 1000n});
const deepen = (chain, n) => chain.advance(n);

test('policy constant and depth rule', () => {
  assert.equal(REORG_RECHECK_DAA, 100n);
  assert.equal(acceptanceDepth(1000n, 900n), 100n); assert.equal(acceptanceDepth(900n, 1000n), 0n);
  const ev = {accepting: 'aa'.repeat(32), acceptingDaa: 1000n};
  const a = acceptanceStep({}, ev, 1050n, 100n, 1);
  assert.equal(a.status, 'CONFIRMING'); assert.equal(a.accepted, false); assert.equal(a.firstAccepting, ev.accepting); assert.equal(a.firstAcceptedAt, 1);
  const b = acceptanceStep(a, ev, 1100n, 100n, 2);
  assert.equal(b.status, 'ACCEPTED'); assert.equal(b.accepted, true); assert.equal(b.firstAcceptedAt, 1, 'first sighting kept'); assert.equal(b.recheckedAt, 2);
  assert.equal(txStatus('CONFIRMING').label, '确认中'); assert.equal(needsAttention({status: 'CONFIRMING'}), true);
});

test('first acceptance -> CONFIRMING (not ACCEPTED, no local tip); after 100 DAA the recheck -> ACCEPTED', async () => {
  const h = harness(), session = await readSession(globalThis.kasware, {request: true});
  const p = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: false}, session);
  const rec = await h.engine.execute(p, {approved: true});
  const c1 = await h.engine.reconcile(rec.txid);
  assert.equal(c1.status, 'CONFIRMING'); assert.equal(c1.accepted, false); assert.ok(c1.depthDaa < 100n);
  assert.equal(await h.engine.localTip(p.cid), null, 'a CONFIRMING record never feeds the next action');
  assert.ok((await h.engine.reserved()).size > 0, 'inputs stay reserved');
  await assert.rejects(h.engine.archive(rec.txid), /已接受的交易不能归档|不能归档/);
  const wait = h.engine.recheckDelayMs(c1); assert.ok(wait >= 1500 && wait <= 100 * 100 + 1500);
  deepen(h.chain, 60);
  assert.equal((await h.engine.reconcile(rec.txid)).status, 'CONFIRMING', 'still shallow');
  deepen(h.chain, 60);
  const c2 = await h.engine.reconcile(rec.txid);
  assert.equal(c2.status, 'ACCEPTED'); assert.equal(c2.accepted, true); assert.ok(c2.depthDaa >= 100n);
  assert.equal(c2.firstAcceptedAt, c1.firstAcceptedAt); assert.equal(c2.firstAccepting, c1.accepting);
  assert.equal((await h.engine.localTip(p.cid)).txid, rec.txid);
  assert.equal(h.chain.submits, 1, 'only queries, never resubmitted');
});

test('reorg before the recheck, transaction re-accepted in a sibling block: followed to the new block, then ACCEPTED', async () => {
  const h = harness(), session = await readSession(globalThis.kasware, {request: true});
  const p = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: false}, session);
  const rec = await h.engine.execute(p, {approved: true});
  const c1 = await h.engine.reconcile(rec.txid);
  assert.equal(c1.status, 'CONFIRMING');
  const sib = h.chain.reorgBlock(c1.accepting, {reaccept: true});
  deepen(h.chain, 120);
  let r = await h.engine.reconcile(rec.txid);
  // The stored accepting block left the chain: the V2 engine repairs the cursor to a chain ancestor and searches again.
  if (r.status !== 'ACCEPTED') r = await h.engine.reconcile(rec.txid);
  assert.equal(r.status, 'ACCEPTED'); assert.equal(r.accepting, sib); assert.equal(r.previousAccepting, c1.accepting);
  assert.equal(r.firstAccepting, c1.accepting, 'first sighting is kept for the record');
  assert.equal(h.chain.submits, 1);
});

test('reorg that drops the transaction before the recheck: never ACCEPTED, inputs stay reserved, never resubmitted', async () => {
  const h = harness(), session = await readSession(globalThis.kasware, {request: true});
  const p = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: false}, session);
  const rec = await h.engine.execute(p, {approved: true});
  const c1 = await h.engine.reconcile(rec.txid);
  assert.equal(c1.status, 'CONFIRMING');
  h.chain.reorgBlock(c1.accepting, {reaccept: false});
  deepen(h.chain, 120);
  let r = await h.engine.reconcile(rec.txid);
  if (!['UNKNOWN', 'PENDING'].includes(r.status)) r = await h.engine.reconcile(rec.txid);
  assert.ok(['UNKNOWN', 'PENDING'].includes(r.status), r.status); assert.equal(r.accepted, false);
  assert.equal(await h.engine.localTip(p.cid), null);
  assert.ok((await h.engine.reserved()).size > 0);
  assert.equal(h.chain.submits, 1);
});

test('next action during CONFIRMING: built only on a node-verified live UTXO; a reorg that drops the parent stops it before signing', async () => {
  const h = harness(), session = await readSession(globalThis.kasware, {request: true});
  const g = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: false}, session);
  const r = await h.engine.execute(g, {approved: true});
  h.idx.track(g.cid, {genesisTxid: r.txid, origin: g.draft.inputUtxos[0].outpoint, tip: {transactionId: r.txid, index: 0}, ledger: unhex(g.nextLedger)});
  const c1 = await h.engine.reconcile(r.txid);
  assert.equal(c1.status, 'CONFIRMING');
  assert.equal(await h.engine.localTip(g.cid), null, 'the CONFIRMING record is not used as a state source');
  // The next action is not delayed: liveRound re-verifies the round UTXO and its accepting block on the node.
  const b = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session);
  assert.equal(b.draft.transaction.inputs[0].previousOutpoint.transactionId, r.txid);
  // A reorg drops the parent before the BUY is signed: the input re-check refuses it; nothing is submitted.
  h.chain.reorgBlock(c1.accepting, {reaccept: false});
  await assert.rejects(h.engine.execute(b, {approved: true}), /已不是未花费|STALE_INPUT/);
  assert.equal(h.chain.submits, 1);
  assert.notEqual((await h.engine.reconcile(r.txid)).status, 'ACCEPTED');
});
