// SOURCE ONLY: added 2026-10-07, NOT RUN during the static/compile-only remediation.
// Core-value regressions: hostile metadata, consensus-vs-builder interpretation,
// atomic intent contract and fee finalization. No VM, SDK, signatures or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../../packages/f3.2-core/lib/state.js';
import {buildAction, buildOpenGenesis, witness} from '../../../packages/f3.2-core/lib/builders.js';
import {interpretAccepted} from '../../../packages/f3.2-core/lib/accepted.js';
import {availableActions} from '../../../packages/f3.2-core/lib/protocol.js';
import {blake2b256} from '../../../packages/f3.2-core/lib/hashes.js';
import {hex} from '../../../packages/f3.2-core/lib/bytes.js';
import {p2pk, p2sh} from '../../../packages/f3.2-core/lib/covenant-id.js';
import {convergeFee, quoteMass, rateFraction} from '../scripts/shared/mass.mjs';
import {checkRow, ledgerFromDetail} from '../scripts/shared/rounds.mjs';
import {CONTRACT_TAG, NETWORK_GENESIS, PROFILE_ID} from '../scripts/shared/core.mjs';
import {persistIntent, reservedFromRows} from '../scripts/shared/reservations.mjs';
import {Engine} from '../scripts/shared/engine.mjs';
import {matchesDraft} from '../scripts/shared/chain.mjs';
import {spkText} from '../scripts/shared/nodes.mjs';

const {profile} = await loadV2Bundle(fileURLToPath(new URL('../../../contracts/f3.2/', import.meta.url)));
const key = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const other = '11'.repeat(32); // synthetic alternate script recipient; no signing or curve-validity claim
const hash = byte => byte.repeat(64);
const funds = [{outpoint: {transactionId: hash('3'), index: 0}, value: 10000000000n, spk: p2pk(key), daa: 1n}];
const config = {ticketPrice: 100000000n, ticketCap: 10, purchaseCap: 256, minTickets: 5, closeEligibleDaa: 500n};
function snapshot(ledger) {
  const origin = {transactionId: hash('1'), index: 0};
  return {ledger: S.encodeLedger(ledger), origin, tip: {transactionId: hash('2'), index: 0}, covenantId: S.rootId(origin, S.rootScript(ledger, profile)),
    scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(ledger, profile)))), value: S.valueOf(ledger), utxoDaa: 100n, currentDaa: 501n};
}
function draft(action = 'BUY', ledger = S.newOpen(key, config)) {
  const x = snapshot(ledger), op = {action, actorKey: key, ...(action === 'BUY' ? {quantity: 1} : {})};
  return {x, op, d: buildAction(x, profile, op, 1000000n, funds)};
}

test('metadata: fresh rows AND cached ledgers reject an injected purchase txid', () => {
  const s = S.appendPurchase(S.newOpen(key, config), 1, key);
  const row = {cid: hash('1'), indexStatus: 'LIVE', terminal: null, phase: 1, value: '120000000', contract: CONTRACT_TAG,
    state: s, purchases: S.records(s).map(r => ({...r, txid: '\" onmouseover=\"notCode\"'}))};
  assert.throws(() => checkRow(row), /购买交易 ID/);
  assert.throws(() => ledgerFromDetail(row, profile), /购买交易 ID/);
  row.purchases[0].txid = hash('4'); assert.equal(checkRow(row), row);
});

// Protects: list card / round KPIs render indexer- or IndexedDB-supplied `state` numbers into innerHTML.
// Failure: an unvalidated row.state.purchaseCount string injects markup (CSP blocks script, not phishing HTML).
test('metadata: hostile or non-canonical state in list rows and cached views is rejected before rendering', () => {
  const s = S.appendPurchase(S.newOpen(key, config), 1, key);
  const st = {...s, directory: undefined, config: {...s.config, ticketPrice: '100000000', closeEligibleDaa: '500'}, anchorDaa: '0'};
  const base = {cid: hash('1'), indexStatus: 'LIVE', terminal: null, phase: 1, value: '120000000', contract: CONTRACT_TAG};
  assert.equal(checkRow({...base, state: st}).state, st);                                  // summary row without directory
  assert.equal(checkRow({...base, state: st, purchases: S.records(s)}).state, st);         // detail row with directory
  for (const bad of [{purchaseCount: '<img src=x onerror=alert(1)>'}, {sold: 11}, {config: {...st.config, ticketCap: '10'}},
    {config: {...st.config, minTickets: '<b>'}}, {ownerKey: '"><i>'}, {seed: 1}])
    assert.throws(() => checkRow({...base, state: {...st, ...bad}}), Error, JSON.stringify(bad));
  assert.throws(() => checkRow({...base, state: st, purchases: []}), /购买目录数量/);
  assert.throws(() => checkRow({...base, indexStatus: 'UNKNOWN', state: st}), /未知索引状态/);
  assert.equal(checkRow({...base, indexStatus: 'UNKNOWN', state: st}, {cached: true}).state, st);
  assert.throws(() => checkRow({...base, indexStatus: 'LOCAL', state: {...st, purchaseCount: '<svg>'}}, {cached: true}));
});

test('new Profile BUY binds witness fee to real fee and requires funding context', () => {
  const {x, op, d} = draft(), tx = structuredClone(d.transaction), values = d.inputUtxos.map(u => u.value);
  const r = interpretAccepted(x, profile, tx, values);
  assert.equal(r.fee, d.fee); assert.equal(r.witnessFee, d.fee); assert.equal(r.next.sold, 1);
  assert.equal(r.outputs[1].role, 'AUXILIARY');
  assert.throws(() => interpretAccepted(x, profile, tx), /INPUT_VALUES_REQUIRED/);
  for (const badFee of [0n, d.fee + 1n, S.MAX_PAY_FEE + 1n]) {
    tx.inputs[0].signatureScript = witness(x, profile, op, d.transition, badFee);
    assert.throws(() => interpretAccepted(x, profile, tx, values), /FEE_MISMATCH/);
  }
  tx.inputs[0].signatureScript = d.transaction.inputs[0].signatureScript;
  tx.outputs[0].value--; tx.outputs[1].value++;
  assert.throws(() => interpretAccepted(x, profile, tx, values), /SUCCESSOR_MISMATCH/);
});

test('new Profile reconciliation rejects changed fee witness, budget or missing context', () => {
  const {x, op, d} = draft(), tx = structuredClone(d.transaction);
  tx.inputs[1].signatureScript = '41' + '11'.repeat(64) + '01';
  const ev = {tx, inputs: d.inputUtxos.map(u => ({value: u.value, daa: u.daa, spk: spkText(u.spk), covenantId: u.covenantId ?? null}))};
  assert.equal(matchesDraft(ev, d), d.fee);
  const missing = {...ev, inputs: [null, ev.inputs[1]]}; assert.throws(() => matchesDraft(missing, d), /上下文/);
  const bad = structuredClone(ev); bad.tx.inputs[0].computeBudget++; assert.throws(() => matchesDraft(bad, d), /字段不一致/);
  tx.inputs[0].signatureScript = witness(x, profile, op, d.transition, 0n);
  assert.throws(() => matchesDraft(ev, d), /字段不一致/);
});

test('accepted CLOSE permits auxiliary output layout and stronger locktime, but not diverted deposit', () => {
  const {x, d} = draft('CLOSE'), tx = structuredClone(d.transaction);
  tx.lockTime = 500n; tx.outputs[1].scriptPublicKey = p2pk(other);
  const r = interpretAccepted(x, profile, tx, d.inputUtxos.map(u => u.value));
  assert.equal(r.terminal, 'EMPTY'); assert.equal(r.outputs[1].constrained, false);
  tx.outputs[0].scriptPublicKey = p2pk(other);
  assert.throws(() => interpretAccepted(x, profile, tx, d.inputUtxos.map(u => u.value)), /PAYOUT_MISMATCH/);
});

test('REFUND intermediate/final executor is bound even with sponsored inputs', () => {
  for (const count of [1, 33]) {
    let s = S.newOpen(key, {...config, ticketCap: 40});
    for (let i = 0; i < count; i++) s = S.appendPurchase(s, 1, key);
    s = {...s, phase: S.Phase.REFUNDING};
    const x = snapshot(s), op = {action: 'REFUND', actorKey: key};
    for (const sponsors of [[], funds]) {
      const d = buildAction(x, profile, op, 100000n, sponsors), values = d.inputUtxos.map(u => u.value);
      const r = interpretAccepted(x, profile, d.transaction, values);
      assert.equal(r.outputs.at(-1).role, 'EXECUTOR'); assert.equal(r.outputs.at(-1).constrained, true);
      assert.equal(r.outputs.at(-1).value, BigInt(Math.min(count, 32)) * S.REFUND_FEE + sponsors.reduce((a, u) => a + u.value, 0n) - d.fee);
      assert.equal(r.terminal, count === 1 ? 'REFUNDED' : null);
      for (const mutate of [o => {o.scriptPublicKey = p2pk(other);}, o => {o.covenant = {covenantId: hash('9'), authorizingInput: 0};}]) {
        const tx = structuredClone(d.transaction); mutate(tx.outputs.at(-1));
        assert.throws(() => interpretAccepted(x, profile, tx, values), /PAYOUT_MISMATCH/);
      }
      const bad = structuredClone(d.transaction); bad.outputs[0].value--; bad.outputs.at(-1).value++;
      assert.throws(() => interpretAccepted(x, profile, bad, values), /PAYOUT_MISMATCH|SUCCESSOR_MISMATCH/);
    }
  }
});

test('timeout is 432000 DAA: before/equal boundary, sequence and fee remain bound', () => {
  const s = {...S.appendPurchase(S.newOpen(key, config), 5, key), phase: S.Phase.SEALED};
  const x = snapshot(s), op = {action: 'TIMEOUT_REFUND', actorKey: key};
  assert.equal(S.TIMEOUT_DELAY, 432000n);
  x.currentDaa = x.utxoDaa + S.TIMEOUT_DELAY - 1n;
  assert.equal(availableActions(x, profile).includes('TIMEOUT_REFUND'), false);
  x.currentDaa++;
  assert.equal(availableActions(x, profile).includes('TIMEOUT_REFUND'), true);
  const d = buildAction(x, profile, op, 100000n, funds), values = d.inputUtxos.map(u => u.value);
  assert.equal(d.transaction.inputs[0].sequence, 432000n);
  assert.equal(interpretAccepted(x, profile, d.transaction, values).next.phase, S.Phase.REFUNDING);
  const early = structuredClone(d.transaction); early.inputs[0].sequence--;
  assert.throws(() => interpretAccepted(x, profile, early, values), /SEQUENCE_REQUIREMENT/);
  const wrongFee = structuredClone(d.transaction); wrongFee.inputs[0].signatureScript = witness(x, profile, op, d.transition, 0n);
  assert.throws(() => interpretAccepted(x, profile, wrongFee, values), /FEE_MISMATCH/);
});

test('ordinary input budgets are initialized in core; final fee satisfies rate and mass for both modes', () => {
  const genesis = fee => buildOpenGenesis(profile, key, config, funds, fee);
  assert.equal(genesis(100000n).transaction.inputs[0].computeBudget, 10);
  assert.equal(draft().d.transaction.inputs[1].computeBudget, 10);
  for (const mode of ['standard', 'priority']) {
    const rate = 151.125, {n, d} = rateFraction(rate), q = convergeFee(genesis, rate, {mode});
    const final = quoteMass(q.draft), binding = mode === 'priority' ? [final.computeMass, final.normalizedTransient, final.storageMass].reduce((a, b) => a > b ? a : b) : final.feeMass;
    assert.ok(q.fee >= (binding * n + d - 1n) / d && q.fee >= final.relayFloor);
    assert.equal(q.draft.transaction.storageMass, final.storageMass);
  }
  assert.throws(() => convergeFee(genesis, 1, {mode: 'unrecognized'}), /模式/);
});

// TN10 stress load (2026-10-09, node estimate ~104-120 sompi/gram): the node estimate is per gram of the mempool
// ORDERING mass max(compute, normalized transient, storage). A fee priced on compute/transient only is admitted but can
// wait in the mempool indefinitely when storage mass dominates (GENESIS: 400000 storage vs ~2772 compute).
test("'load' fee: node estimate x ordering mass, cap-clamped but never below the relay admission minimum", () => {
  const genesis = fee => buildOpenGenesis(profile, key, config, funds, fee);
  const rate = 120.26359250251055, {n, d} = rateFraction(rate);
  const std = convergeFee(genesis, rate, {mode: 'standard'}), load = convergeFee(genesis, rate, {mode: 'load'});
  const q = quoteMass(load.draft), ordering = [q.computeMass, q.normalizedTransient, q.storageMass].reduce((a, b) => a > b ? a : b);
  assert.ok(q.storageMass > q.feeMass, 'fixture must be storage-dominated');
  assert.ok(load.fee >= (ordering * n + d - 1n) / d && load.fee >= q.relayFloor && load.fee > std.fee);
  assert.equal(load.clamped, false); assert.equal(load.orderingMass, ordering);
  assert.equal(load.orderingFeerate, `${load.fee * 100n / ordering / 100n}.${String(load.fee * 100n / ordering % 100n).padStart(2, '0')}`);
  // A rate whose ordering-mass fee exceeds the cap: clamped to the cap and flagged, still >= the admission minimum.
  const hot = convergeFee(genesis, 2000, {mode: 'load'});
  assert.equal(hot.fee, 50_000_000n); assert.equal(hot.clamped, true); assert.ok(hot.fee >= hot.standardFee);
  // 'priority' keeps its strict meaning (refuses above the cap); the admission minimum itself above the cap is refused.
  assert.throws(() => convergeFee(genesis, 2000, {mode: 'priority'}), /超过保护上限/);
  assert.throws(() => convergeFee(genesis, 1e6, {mode: 'load'}), /超过保护上限/);
});

test('funding excludes mature and immature coinbase alike', async () => {
  const normal = {...funds[0], isCoinbase: false};
  const entries = [normal, {...normal, outpoint: {transactionId: hash('4'), index: 0}, isCoinbase: true}].map(u => ({outpoint: u.outpoint,
    utxoEntry: {amount: u.value.toString(), scriptPublicKey: spkText(u.spk), blockDaaScore: '1', covenantId: null, isCoinbase: u.isCoinbase}}));
  const engine = new Engine({pair: {call: async () => ({entries})}, profile, indexer: '', openStore: async () => ({list: async () => []})});
  assert.deepEqual((await engine.funding({address: 'unused', spk: normal.spk})).map(u => u.outpoint), [normal.outpoint]);
});

test('intent storage requires atomic API and atomically detects cross-Profile conflict (memory contract only)', async () => {
  const rows = [], store = {insertIfAbsentWithCheck: async (k, value, _prefix, inspect) => {
    if (rows.some(r => r.key === k)) throw Error('INTENT_ALREADY_EXISTS'); inspect(rows);
    const record = {revision: 0, value: structuredClone(value)}; rows.push({key: k, record}); return record;
  }};
  const input = funds[0].outpoint, make = txid => ({txid, status: 'SUBMITTING', inputs: [input]}), k = (p, t) => `${NETWORK_GENESIS}/${p}/tx/${t}`;
  await assert.rejects(persistIntent({}, NETWORK_GENESIS, k(PROFILE_ID, hash('5')), make(hash('5'))), /ATOMIC_INTENT_STORE_REQUIRED/);
  await persistIntent(store, NETWORK_GENESIS, k(PROFILE_ID, hash('5')), make(hash('5')));
  await assert.rejects(persistIntent(store, NETWORK_GENESIS, k(hash('9'), hash('6')), make(hash('6'))), /INPUT_ALREADY_RESERVED/);
  assert.equal(reservedFromRows(rows, NETWORK_GENESIS).size, 1);
  // An expired lock never authorizes a new intent, even with no conflicting inputs.
  await assert.rejects(persistIntent(store, NETWORK_GENESIS, k(PROFILE_ID, hash('7')), make(hash('7')), {key: 'lock/missing', owner: 'gone'}), /SUBMIT_LEASE_LOST/);
});
