// Dedicated test suite verifying the three requested user lifecycles:
// 1. Normal draw and payout (DRAW_AND_PAY -> PAID terminal)
// 2. Zero-ticket sales close and refund (CLOSE -> EMPTY terminal)
// 3. Sub-minimum ticket sales close and refund (CLOSE -> REFUNDING -> REFUND -> REFUNDED terminal)
// Explicit constraint: TIMEOUT_REFUND is NOT tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SimChain, wsFactory, fakeKasware, simIndexer, loadProfile, MemoryStore, testLocks, TEST_ADDRESS, TEST_KEY} from './sim.mjs';
import {NodeLink} from '../scripts/shared/nodes.mjs';
import {EngineV2 as Engine} from '../scripts/engine2.mjs';
import {readSession} from '../scripts/shared/wallet.mjs';
import {S, unhex, authenticateDraw, sample, winnerRecord, kas} from '../scripts/shared/core.mjs';
import {replayAccepted} from '../scripts/shared/replay.mjs';

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
  const engine = new Engine({pair, profile, indexer: 'http://localhost/indexer', openStore: async () => store, locks: testLocks, drawProof: opts.drawProof});
  return {chain, pair, idx, wallet, engine, store};
}
const config = (daa, extra = {}) => ({ticketPrice: 100_000_000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: daa + 1000n, ...extra});

async function genesis(h, cfg) {
  const session = await readSession(globalThis.kasware, {request: true});
  const plan = await h.engine.plan({action: 'GENESIS', config: cfg, registry: true}, session);
  const rec = await h.engine.execute(plan, {approved: true});
  assert.equal(rec.status, 'SUBMITTED');
  h.idx.track(plan.cid, {genesisTxid: rec.txid, origin: plan.draft.inputUtxos[0].outpoint, tip: {transactionId: rec.txid, index: 0}, ledger: S.encodeLedger(S.newOpen(TEST_KEY, cfg))});
  return {plan, rec, session};
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

test('流程 1：正常开奖派奖全生命周期（GENESIS -> BUY x3 -> CLOSE -> DRAW_AND_PAY -> PAID 终局）', async () => {
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

  // 1. GENESIS 创建
  const {plan: g, session} = await genesis(h, config(h.chain.daa, {ticketPrice: 100_000_000n, ticketCap: 3, minTickets: 3}));
  const rGen = await h.engine.reconcile(g.draft.txid);
  assert.equal(rGen.status, 'ACCEPTED');
  const repGen = await replayAccepted(h.pair, profile, g.draft.txid, rGen.accepting, {cid: g.cid});
  assert.equal(repGen.action, 'GENESIS');

  // 2. BUY 满 3 票
  for (let i = 0; i < 3; i++) {
    const buy = await step(h, g.cid, {action: 'BUY', quantity: 1}, session);
    const rBuy = await h.engine.reconcile(buy.rec.txid);
    assert.equal(rBuy.status, 'ACCEPTED');
    const repBuy = await replayAccepted(h.pair, profile, buy.rec.txid, rBuy.accepting, {origin: g.origin, cid: g.cid});
    assert.equal(repBuy.action, 'BUY');
    assert.equal(repBuy.next.sold, i + 1);
  }

  // 3. CLOSE 满票截盘 -> 进入 SEALED
  h.chain.daa = 580025225n; // 保证 SEALED UTXO DAA 为 580025226
  const close = await step(h, g.cid, {action: 'CLOSE'}, session);
  assert.equal(close.plan.after.phase, S.Phase.SEALED);
  const rClose = await h.engine.reconcile(close.rec.txid);
  assert.equal(rClose.status, 'ACCEPTED');
  const repClose = await replayAccepted(h.pair, profile, close.rec.txid, rClose.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(repClose.action, 'CLOSE');
  assert.equal(repClose.next.phase, S.Phase.SEALED);

  // 4. 等待 100 DAA 封存成熟期，构造 PASS-A 证明开奖
  h.chain.advance(101);
  h.chain.blocks.set(passA.target.hash, {
    hash: passA.target.hash, daa: 580025327n, blue: 590000100n, parent: passA.parent.hash, txs: [], seqCommit: passA.target.seqCommit
  });

  const pay = await step(h, g.cid, {action: 'DRAW_AND_PAY'}, session);
  assert.equal(pay.plan.action, 'DRAW_AND_PAY');
  assert.equal(pay.plan.terminal, 'PAID');
  assert.deepEqual(pay.plan.outputs.map(o => o.role), ['WINNER', 'CREATOR', 'EXECUTOR']);
  assert.equal(pay.plan.outputs[1].value, S.DEPOSIT); // 创建者押金 0.2 TKAS
  assert.equal(pay.plan.outputs[2].value, S.FINALIZER); // 执行者赏金 1 TKAS
  assert.equal(pay.plan.outputs[0].value, 300_000_000n - S.FINALIZER - pay.plan.fee); // 赢家总奖金

  const rPay = await h.engine.reconcile(pay.rec.txid);
  assert.equal(rPay.status, 'ACCEPTED');

  const repPay = await replayAccepted(h.pair, profile, pay.rec.txid, rPay.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(repPay.action, 'DRAW_AND_PAY');
  assert.equal(repPay.terminal, 'PAID');
  assert.equal(repPay.winner.ticket, pay.plan.winner.ticket);
  assert.equal(repPay.outputs[0].value, pay.plan.outputs[0].value);
  assert.equal(repPay.outputs[1].value, S.DEPOSIT);
  assert.equal(repPay.outputs[2].value, S.FINALIZER);
});

test('流程 2：零买退款全生命周期（GENESIS -> CLOSE -> EMPTY 终局全额返还押金）', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);

  // 1. GENESIS 创建
  const {plan: g, session} = await genesis(h, config(h.chain.daa, {ticketPrice: 100_000_000n, ticketCap: 3, minTickets: 3, closeEligibleDaa: h.chain.daa + 500n}));

  // 2. 未到截盘时间拒绝 CLOSE
  await assert.rejects(h.engine.plan({action: 'CLOSE', cid: g.cid}, session), /封盘时间/);

  // 3. 时间到达截盘点，执行空轮 CLOSE
  h.chain.advance(501);
  const empty = await step(h, g.cid, {action: 'CLOSE'}, session);
  assert.equal(empty.plan.action, 'CLOSE');
  assert.equal(empty.plan.terminal, 'EMPTY');
  assert.equal(empty.plan.outputs.length, 2); // 输出 0 是 CREATOR 押金退回，输出 1 是找零
  assert.equal(empty.plan.outputs[0].role, 'CREATOR');
  assert.equal(empty.plan.outputs[0].value, S.DEPOSIT); // 0.2 TKAS 原路退回

  const rEmpty = await h.engine.reconcile(empty.rec.txid);
  assert.equal(rEmpty.status, 'ACCEPTED');

  const repEmpty = await replayAccepted(h.pair, profile, empty.rec.txid, rEmpty.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(repEmpty.action, 'CLOSE');
  assert.equal(repEmpty.terminal, 'EMPTY');
  assert.equal(repEmpty.outputs[0].role, 'CREATOR');
  assert.equal(repEmpty.outputs[0].value, S.DEPOSIT);
});

test('流程 3：不达最低票数退款全生命周期（GENESIS -> BUY x2 -> CLOSE -> REFUNDING -> REFUND -> REFUNDED 终局）', async () => {
  const h = harness();
  h.chain.fund(TEST_ADDRESS, 50_000_000_000n);

  // 1. GENESIS 创建（最低票数 5，购买上限 10）
  const {plan: g, session} = await genesis(h, config(h.chain.daa, {ticketPrice: 100_000_000n, ticketCap: 10, minTickets: 5, closeEligibleDaa: h.chain.daa + 500n}));

  // 2. 购买 2 张票（2 < 5，不达标）
  await step(h, g.cid, {action: 'BUY', quantity: 1}, session);
  await step(h, g.cid, {action: 'BUY', quantity: 1}, session);

  // 3. 截盘时间未到前拒绝封盘
  await assert.rejects(h.engine.plan({action: 'CLOSE', cid: g.cid}, session), /封盘时间/);

  // 4. 截盘时间到达，CLOSE 判定票数不足，转入 REFUNDING
  h.chain.advance(501);
  const close = await step(h, g.cid, {action: 'CLOSE'}, session);
  assert.equal(close.plan.action, 'CLOSE');
  assert.equal(close.plan.after.phase, S.Phase.REFUNDING);
  assert.equal(close.plan.after.sold, 2);
  const rClose = await h.engine.reconcile(close.rec.txid);
  assert.equal(rClose.status, 'ACCEPTED');

  const repClose = await replayAccepted(h.pair, profile, close.rec.txid, rClose.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(repClose.action, 'CLOSE');
  assert.equal(repClose.next.phase, S.Phase.REFUNDING);

  // 5. 执行退款批次 REFUND
  const refund = await step(h, g.cid, {action: 'REFUND'}, session);
  assert.equal(refund.plan.action, 'REFUND');
  assert.equal(refund.plan.terminal, 'REFUNDED');

  // 输出验证：2 笔买家退款输出（每笔票款 1 TKAS 扣 0.01 TKAS 退款执行费），1 笔创建者押金返还，1 笔执行者费用补贴
  const refundRoles = refund.plan.outputs.map(o => o.role);
  assert.deepEqual(refundRoles.filter(r => r === 'BUYER_REFUND').length, 2);
  for (const o of refund.plan.outputs.filter(o => o.role === 'BUYER_REFUND')) {
    assert.equal(o.value, 100_000_000n - S.REFUND_FEE); // 0.99 TKAS
  }
  assert.equal(refund.plan.outputs.find(o => o.role === 'CREATOR').value, S.DEPOSIT); // 0.2 TKAS 原路退回
  assert.ok(refund.plan.outputs.some(o => o.role === 'EXECUTOR')); // 执行者费用池

  const rRefund = await h.engine.reconcile(refund.rec.txid);
  assert.equal(rRefund.status, 'ACCEPTED');

  const repRefund = await replayAccepted(h.pair, profile, refund.rec.txid, rRefund.accepting, {origin: g.origin, cid: g.cid});
  assert.equal(repRefund.action, 'REFUND');
  assert.equal(repRefund.terminal, 'REFUNDED');
  assert.equal(repRefund.outputs.find(o => o.role === 'CREATOR').value, S.DEPOSIT);
});
