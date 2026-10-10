// Fee tier choice. Protects: the page probes the node's fee buckets and mempool, quotes BOTH tiers on the same state,
// economy = admission rule (no storage mass) at the low bucket, fast = full ordering mass at the normal bucket; the
// recommendation follows the network state; switching tiers invalidates the old plan; the chosen tier is what is signed.
// Simulated node; the estimator curve is rusty-kaspa v2.1.0 mining/src/feerate/mod.rs (ALPHA = 3). NOT a real mempool.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SimChain, wsFactory, fakeKasware, simIndexer, loadProfile, MemoryStore, testLocks, TEST_ADDRESS} from './sim.mjs';
import {NodeLink} from '../scripts/shared/nodes.mjs';
import {EngineV2 as Engine} from '../scripts/engine2.mjs';
import {readSession} from '../scripts/shared/wallet.mjs';
import {unhex} from '../scripts/shared/core.mjs';
import {parseFeeEstimate, waitSeconds, isIdle, recommendTier} from '../scripts/shared/feetiers.mjs';

const profile = loadProfile();
// Live TN10 node 2026-10-10 01:58Z (getFeeEstimateExperimental verbose) under the stress test, and seconds later idle.
const BUSY = {estimate: {lowBuckets: [{estimatedSeconds: 0.8548, feerate: 111.97}], normalBuckets: [{estimatedSeconds: 0.3002, feerate: 158.77}, {estimatedSeconds: 0.5512, feerate: 129.63}], priorityBucket: {estimatedSeconds: 0.1, feerate: 229.28}},
  verbose: {mempoolReadyTransactionsCount: 1792, mempoolReadyTransactionsTotalMass: 3440070, networkMassPerSecond: 5000000}};
const IDLE = {estimate: {lowBuckets: [{estimatedSeconds: 0.00068, feerate: 100}], normalBuckets: [{estimatedSeconds: 0.00068, feerate: 100}, {estimatedSeconds: 0.00068, feerate: 100}], priorityBucket: {estimatedSeconds: 0.00068, feerate: 100}},
  verbose: {mempoolReadyTransactionsCount: 90, mempoolReadyTransactionsTotalMass: 146160, networkMassPerSecond: 5000000}};

function harness(fee) {
  const chain = new SimChain(); chain.feeEstimate = fee;
  const pair = new NodeLink(['wss://alpha.sim/kaspa/testnet-10/wrpc/json'], {WebSocketImpl: wsFactory(chain)});
  const idx = simIndexer(chain, profile); globalThis.fetch = idx.fetch; globalThis.kasware = fakeKasware();
  const engine = new Engine({pair, profile, indexer: 'http://localhost/indexer', openStore: async () => new MemoryStore(), locks: testLocks});
  chain.fund(TEST_ADDRESS, 50_000_000_000n);
  return {chain, idx, engine};
}
const cfg = daa => ({ticketPrice: 100_000_000n, ticketCap: 100, purchaseCap: 256, minTickets: 3, closeEligibleDaa: daa + 1000n});

test('estimator curve: reproduces the node buckets, monotone, idle when the ready mempool fits a block', () => {
  const busy = parseFeeEstimate(BUSY, BUSY.verbose), idle = parseFeeEstimate(IDLE, IDLE.verbose);
  assert.equal(isIdle(busy), false); assert.equal(isIdle(idle), true);
  for (const b of [busy.priority, busy.low]) assert.ok(Math.abs(waitSeconds(busy, b.feerate) - b.seconds) < 1e-6);
  // The normal bucket lies on the same curve (third point, not used for the fit) within 2%.
  assert.ok(Math.abs(waitSeconds(busy, busy.normal.feerate) / busy.normal.seconds - 1) < 0.02);
  assert.ok(waitSeconds(busy, 1) > waitSeconds(busy, 50) && waitSeconds(busy, 50) > waitSeconds(busy, 500));
  assert.equal(waitSeconds(idle, 0.5), idle.priority.seconds);
  // Without verbose data a collapsed estimator still counts as idle; missing buckets are refused, not guessed.
  assert.equal(isIdle(parseFeeEstimate({estimate: IDLE.estimate})), true);
  assert.equal(parseFeeEstimate({estimate: BUSY.estimate}).mempool, null);
  assert.throws(() => parseFeeEstimate({estimate: {}}), /节点未返回费率/);
  assert.equal(recommendTier(busy, {fee: 10n, waitSeconds: 0.5, belowLow: false}, {fee: 20n}), 'economy');
  assert.equal(recommendTier(busy, {fee: 10n, waitSeconds: 5e6, belowLow: true}, {fee: 20n}), 'fast');
  assert.equal(recommendTier(idle, {fee: 10n, waitSeconds: 0.001, belowLow: false}, {fee: 20n}), 'economy');
});

test('busy network: GENESIS quotes both tiers, recommends fast; economy is the admission minimum; switching re-plans', async () => {
  const h = harness(BUSY), session = await readSession(globalThis.kasware, {request: true});
  const p = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: true}, session);
  const {economy, fast} = p.tiers;
  assert.equal(p.network.idle, false); assert.equal(p.conditions.mempool.readyCount, 1792);
  assert.ok(economy.available && fast.available);
  assert.equal(economy.mode, 'standard'); assert.equal(fast.mode, 'load');
  assert.equal(economy.fee, economy.standardFee); assert.ok(fast.fee > economy.fee * 50n, 'storage-dominated: fast pays for storage');
  assert.equal(economy.belowLow, true); assert.equal(p.recommendedTier, 'fast'); assert.equal(p.tier, 'fast'); assert.equal(p.fee, fast.fee);
  const e = h.engine.chooseTier(p, 'economy');
  assert.notEqual(e.id, p.id); assert.equal(e.tier, 'economy'); assert.equal(e.fee, economy.fee);
  assert.equal(e.cid, p.cid, 'same funding input -> same Covenant ID');
  assert.equal(e.draft.transaction.outputs.at(-1).value - p.draft.transaction.outputs.at(-1).value, fast.fee - economy.fee, 'only the change differs');
  await assert.rejects(h.engine.execute(p, {approved: true}), /交易计划已失效/);
  const rec = await h.engine.execute(e, {approved: true});
  assert.equal(rec.fee, economy.fee); assert.equal(rec.feeTier, 'economy');
  assert.equal((await h.engine.reconcile(rec.txid)).actualFee, economy.fee);
});

test('idle network: economy recommended; compute-dominated BUY quotes the same in both tiers', async () => {
  const h = harness(IDLE), session = await readSession(globalThis.kasware, {request: true});
  const g = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: false}, session);
  assert.equal(g.network.idle, true); assert.equal(g.recommendedTier, 'economy'); assert.equal(g.tier, 'economy');
  assert.ok(g.tiers.fast.fee > g.tiers.economy.fee);
  const r = await h.engine.execute(g, {approved: true}); await h.engine.reconcile(r.txid);
  h.idx.track(g.cid, {genesisTxid: r.txid, origin: g.draft.inputUtxos[0].outpoint, tip: {transactionId: r.txid, index: 0}, ledger: unhex(g.nextLedger)});
  // A later BUY (8 records in, tiny storage) at rate 100 in both buckets: both tiers converge to one quote.
  h.chain.feeEstimate = {estimate: IDLE.estimate};
  const b = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1}, session);
  assert.equal(b.network.idle, true);
  if (b.tiers.economy.sameAs === 'fast') assert.equal(b.tiers.economy.fee, b.tiers.fast.fee);
  else assert.ok(b.tiers.economy.fee < b.tiers.fast.fee);
  // A request may pin a tier (used by tests and the bump path); an unavailable tier falls back to the recommendation.
  const pinned = await h.engine.plan({action: 'BUY', cid: g.cid, quantity: 1, tier: 'fast'}, session);
  assert.equal(pinned.tier, 'fast'); assert.equal(pinned.fee, pinned.tiers.fast.fee);
  assert.throws(() => h.engine.chooseTier(pinned, 'turbo'), /不可用/);
});

test('node without getFeeEstimateExperimental: falls back to getFeeEstimate, no mempool size shown', async () => {
  const h = harness({estimate: BUSY.estimate}), session = await readSession(globalThis.kasware, {request: true});
  const p = await h.engine.plan({action: 'GENESIS', config: cfg(h.chain.daa), registry: false}, session);
  assert.equal(p.conditions.mempool, null); assert.equal(p.network.idle, false);
  assert.equal(p.conditions.low.feerate, 111.97); assert.equal(p.feerate, 158.77);
});
