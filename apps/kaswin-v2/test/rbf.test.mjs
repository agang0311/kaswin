// Mempool status and fee bump (RBF). Protects: a transaction stuck in the mempool is labelled "in mempool", never
// "accepted"; a replacement spends exactly the same inputs with the same state transition and a strictly higher
// ordering feerate, goes through the node's RBF endpoint, and when one member of the family is accepted the others
// are marked superseded (never accepted, inputs released). Simulated node mirroring rusty-kaspa v2.1.0 RbfPolicy;
// NOT consensus, NOT a real TN10 mempool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SimChain, wsFactory, fakeKasware, simIndexer, loadProfile, MemoryStore, testLocks, TEST_ADDRESS, TEST_KEY} from './sim.mjs';
import {NodeLink} from '../scripts/shared/nodes.mjs';
import {EngineV2 as Engine} from '../scripts/engine2.mjs';
import {readSession} from '../scripts/shared/wallet.mjs';
import {S, unhex, authenticateDraw, sample, winnerRecord} from '../scripts/shared/core.mjs';
import {quoteMass} from '../scripts/shared/mass.mjs';
import {reservedInputs} from '../scripts/shared/reservations.mjs';

const profile = loadProfile(), NET = 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';
const passA = JSON.parse(fs.readFileSync(new URL('./fixtures/pass-a-public.json', import.meta.url), 'utf8'));
function harness(opts = {}) {
  const chain = new SimChain(opts.chain), pair = new NodeLink(['wss://alpha.sim/kaspa/testnet-10/wrpc/json'], {WebSocketImpl: wsFactory(chain)});
  const idx = simIndexer(chain, profile); globalThis.fetch = idx.fetch; globalThis.kasware = fakeKasware();
  const store = new MemoryStore();
  const engine = new Engine({pair, profile, indexer: 'http://localhost/indexer', openStore: async () => store, locks: testLocks, drawProof: opts.drawProof});
  return {chain, pair, idx, engine, store};
}
const cfg = (daa, x = {}) => ({ticketPrice: 100_000_000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: daa + 1000n, ...x});
const ordering = q => [q.computeMass, q.normalizedTransient, q.storageMass].reduce((a, b) => a > b ? a : b);
async function genesis(h) {
  const session = await readSession(globalThis.kasware, {request: true});
  const p = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: true}, session), rec = await h.engine.execute(p, {approved: true});
  h.idx.track(p.cid, {genesisTxid: rec.txid, origin: p.draft.inputUtxos[0].outpoint, tip: {transactionId: rec.txid, index: 0}, ledger: unhex(p.nextLedger)});
  assert.equal((await h.engine.reconcile(rec.txid)).status, 'ACCEPTED');
  return {p, session};
}

test('in mempool -> PENDING (not accepted); bump replaces it via RBF; mining the replacement supersedes the original', async () => {
  const h = harness(); h.chain.fund(TEST_ADDRESS, 50_000_000_000n); h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {p: g, session} = await genesis(h);
  h.chain.holdInMempool = true;
  const buy = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 2}, session), r0 = await h.engine.execute(buy, {approved: true});
  assert.equal(r0.status, 'SUBMITTED');
  const c0 = await h.engine.reconcile(r0.txid);
  assert.equal(c0.status, 'PENDING'); assert.equal(c0.accepted, false); assert.equal(c0.mempool.present, true); assert.equal(c0.mempool.fee, r0.fee);
  // A second, unrelated plan on the same round state is still refused while the original is unsettled.
  await assert.rejects(h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session), /尚未对账|占用/);

  const bump = await h.engine.planReplacement(r0.txid, session);
  assert.deepEqual(bump.draft.inputUtxos.map(u => u.outpoint), buy.draft.inputUtxos.map(u => u.outpoint));
  assert.deepEqual(S.encodeLedger(bump.draft.transition.next), S.encodeLedger(buy.draft.transition.next));
  assert.ok(bump.fee * ordering(buy.quote) > buy.fee * ordering(bump.quote), 'strictly higher ordering feerate');
  assert.ok(bump.fee >= buy.fee + buy.fee / 10n);
  // Only the fee moves: the wallet change shrinks by exactly the fee difference; every other output is identical.
  const outs = d => d.transaction.outputs.map(o => o.value);
  assert.deepEqual(outs(bump.draft).slice(0, -1), outs(buy.draft).slice(0, -1));
  assert.equal(outs(buy.draft).at(-1) - outs(bump.draft).at(-1), bump.fee - buy.fee);

  const r1 = await h.engine.execute(bump, {approved: true});
  assert.equal(r1.status, 'SUBMITTED'); assert.equal(r1.replaces, r0.txid); assert.equal(r1.replacedInMempool, r0.txid);
  const old = (await h.store.get([...h.store.map.keys()].find(k => k.endsWith(r0.txid)))).value;
  assert.equal(old.status, 'REPLACED'); assert.equal(old.replacedBy, r1.txid);
  assert.equal(h.chain.mempool.has(r0.txid), false); assert.equal(h.chain.mempool.has(r1.txid), true);
  // The original stays reconcilable but keeps its REPLACED label (it is absent from the mempool now, never "accepted").
  assert.equal((await h.engine.reconcile(r0.txid)).status, 'REPLACED');
  // No double bump of the same record; no bump of something that is not in the mempool.
  await assert.rejects(h.engine.planReplacement(r0.txid, session), /未被替换过/);

  h.chain.mine(r1.txid);
  const a1 = await h.engine.reconcile(r1.txid);
  assert.equal(a1.status, 'ACCEPTED'); assert.equal(a1.actualFee, bump.fee);
  const s0 = await h.engine.reconcile(r0.txid);
  assert.equal(s0.status, 'SUPERSEDED'); assert.equal(s0.supersededBy, r1.txid); assert.equal(s0.accepted, false);
  // The superseded original no longer reserves anything of its own: removing the accepted record leaves no reservation.
  const rows = (await h.store.list('')).filter(x => !x.key.endsWith(r1.txid));
  const reserved = await reservedInputs({list: async () => rows}, NET);
  assert.equal(buy.draft.inputUtxos.some(u => reserved.has(`${u.outpoint.transactionId}:${u.outpoint.index}`)), false);
  h.chain.holdInMempool = false;
  const next = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session);
  assert.equal(next.before.sold, 2); assert.equal(next.draft.transaction.inputs[0].previousOutpoint.transactionId, r1.txid);
  assert.equal(h.chain.submits, 3);
});

test('if the ORIGINAL is mined after a bump, the replacement is superseded and the original is accepted', async () => {
  const h = harness(); h.chain.fund(TEST_ADDRESS, 50_000_000_000n); h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {p: g, session} = await genesis(h);
  h.chain.holdInMempool = true;
  const r0 = await h.engine.execute(await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session), {approved: true});
  const r1 = await h.engine.execute(await h.engine.planReplacement(r0.txid, session), {approved: true});
  // Simulate a peer that mined the original before it saw the replacement.
  h.chain.mempool.delete(r1.txid); h.chain.mempool.set(r0.txid, {...h.chain.mempool.get(r0.txid) ?? {id: r0.txid, rpc: (await import('../scripts/shared/nodes.mjs')).txToRpc(r0.signed), ops: r0.inputs.map(o => `${o.transactionId}:${o.index}`), fee: r0.fee, mass: 1n}});
  h.chain.mine(r0.txid);
  assert.equal((await h.engine.reconcile(r0.txid)).status, 'ACCEPTED');
  const s1 = (await h.store.get([...h.store.map.keys()].find(k => k.endsWith(r1.txid)))).value;
  assert.equal(s1.status, 'SUPERSEDED'); assert.equal(s1.supersededBy, r0.txid);
});

test('refused bumps: not in mempool, different wallet, and the node rejects a non-increasing feerate', async () => {
  const h = harness(); h.chain.fund(TEST_ADDRESS, 50_000_000_000n); h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {p: g, session} = await genesis(h);
  h.chain.holdInMempool = true;
  const r0 = await h.engine.execute(await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session), {approved: true});
  await assert.rejects(h.engine.planReplacement(r0.txid, {...session, key: '22'.repeat(32)}), /钱包账户/);
  h.chain.evict(r0.txid);
  await assert.rejects(h.engine.planReplacement(r0.txid, session), /不在节点内存池/);
  // Node side: a replacement that does not strictly raise the ordering feerate is rejected (RbfPolicy::Mandatory).
  const {txToRpc} = await import('../scripts/shared/nodes.mjs');
  h.chain.mempool.set(r0.txid, {id: r0.txid, rpc: txToRpc(r0.signed), ops: r0.inputs.map(o => `${o.transactionId}:${o.index}`), fee: r0.fee, mass: 1n}); // node-side feerate fee/1: unbeatable
  const p = await h.engine.planReplacement(r0.txid, session);
  const r1 = await h.engine.execute(p, {approved: true});
  assert.equal(r1.status, 'REJECTED'); assert.match(r1.error, /already spent by transaction/);
  // The original keeps its inputs reserved and is still open (not REPLACED): a rejected replacement changes nothing.
  const old = (await h.store.get([...h.store.map.keys()].find(k => k.endsWith(r0.txid)))).value;
  assert.equal(old.status, 'SUBMITTED'); assert.equal(old.replacedBy, undefined);
});

test('DRAW_AND_PAY bump: same winner and outputs except the fee, which comes out of the prize (bound fee witness)', async () => {
  const opening = unhex(passA.openingHex), target = {blockHash: passA.target.hash, sequenceCommitment: passA.target.seqCommit};
  const drawProof = async (_l, _p, live) => {
    const drawn = authenticateDraw(live.snapshot, live.ledger, opening, target), smp = sample(drawn);
    const acc = {...drawn, phase: S.Phase.WINNER_READY, winnerPlusOne: smp.ticket + 1}, i = winnerRecord(acc), rec = S.records(acc)[i];
    return {opening, openingHex: passA.openingHex, target: {hash: passA.target.hash, seqCommit: passA.target.seqCommit}, parent: passA.parent, boundaryDaa: passA.boundaryDaa, nodes: ['sim'], seed: drawn.seed,
      winner: {ticket: smp.ticket + 1, record: i, key: rec.key, recordTickets: rec.count, sampleValue: smp.value.toString(), limit: smp.limit.toString()}};
  };
  const h = harness({chain: {daa: 580025200n}, drawProof}); h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const {p: g, session} = await genesis(h);
  const step = async req => { const p = await h.engine.plan({...req, cid: g.cid}, session), r = await h.engine.execute(p, {approved: true}); assert.equal((await h.engine.reconcile(r.txid)).status, 'ACCEPTED');
    const t = h.idx.rounds.get(g.cid); if (p.draft.transition.next) h.idx.track(g.cid, {...t, tip: {transactionId: r.txid, index: 0}, ledger: S.encodeLedger(p.draft.transition.next)}); return p; };
  for (let i = 0; i < 3; i++) await step({action: 'BUY', quantity: 1});
  h.chain.daa = 580025225n; await step({action: 'CLOSE'});
  h.chain.advance(101);
  h.chain.blocks.set(passA.target.hash, {hash: passA.target.hash, daa: 580025327n, blue: 590000100n, parent: passA.parent.hash, txs: [], seqCommit: passA.target.seqCommit});
  h.chain.holdInMempool = true;
  const pay = await h.engine.plan({action: 'DRAW_AND_PAY', cid: g.cid}, session), r0 = await h.engine.execute(pay, {approved: true});
  const bump = await h.engine.planReplacement(r0.txid, session);
  assert.equal(bump.winner.ticket, pay.winner.ticket);
  assert.deepEqual(bump.outputs.map(o => o.role), ['WINNER', 'CREATOR', 'EXECUTOR']);
  assert.equal(bump.draft.transaction.outputs[0].value, 300_000_000n - S.FINALIZER - bump.fee);
  assert.equal(pay.draft.transaction.outputs[0].value - bump.draft.transaction.outputs[0].value, bump.fee - pay.fee);
  assert.deepEqual(bump.draft.transaction.outputs.slice(1).map(o => o.value), pay.draft.transaction.outputs.slice(1).map(o => o.value));
  const r1 = await h.engine.execute(bump, {approved: true}); h.chain.mine(r1.txid);
  assert.equal((await h.engine.reconcile(r1.txid)).status, 'ACCEPTED');
  assert.equal((await h.engine.reconcile(r0.txid)).status, 'SUPERSEDED');
});

test('GENESIS bump keeps the round identity (same origin input => same Covenant ID)', async () => {
  const h = harness(); h.chain.fund(TEST_ADDRESS, 50_000_000_000n);
  const session = await readSession(globalThis.kasware, {request: true});
  h.chain.holdInMempool = true;
  const p0 = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: true}, session), r0 = await h.engine.execute(p0, {approved: true});
  assert.equal((await h.engine.reconcile(r0.txid)).status, 'PENDING');
  const p1 = await h.engine.planReplacement(r0.txid, session);
  assert.equal(p1.cid, p0.cid); assert.notEqual(p1.draft.txid, p0.draft.txid);
  assert.equal(p1.draft.transaction.payload, p0.draft.transaction.payload);
  assert.ok(quoteMass(p1.draft).storageMass > 0n);
});
