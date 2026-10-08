// 03-timeout-and-timelock.test.mjs: Test 432000 DAA timeout delay, sequence requirements, and DRAW/CLOSE timelocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import * as builders from '../../packages/f3.2-core/lib/builders.js';
import {interpretAccepted} from '../../packages/f3.2-core/lib/accepted.js';
import {p2pk, p2sh} from '../../packages/f3.2-core/lib/covenant-id.js';
import {hex} from '../../packages/f3.2-core/lib/bytes.js';
import {blake2b256} from '../../packages/f3.2-core/lib/hashes.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');
const {profile} = await loadV2Bundle(CONTRACTS);

const KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const ORIGIN = {transactionId: '11'.repeat(32), index: 0};
const BASE_CONFIG = {ticketPrice: 100000000n, ticketCap: 10, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 500n};

function snap(s, utxoDaa, currentDaa) {
  return {
    ledger: S.encodeLedger(s),
    tip: {transactionId: '12'.repeat(32), index: 0},
    origin: ORIGIN,
    scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(s, profile)))),
    covenantId: S.rootId(ORIGIN, S.rootScript(s, profile)),
    value: S.valueOf(s),
    utxoDaa,
    currentDaa
  };
}

test('03.1 Timeout constant is exactly 432000 DAA', () => {
  assert.equal(S.TIMEOUT_DELAY, 432000n, 'S.TIMEOUT_DELAY in core must be 432000n');
  assert.equal(S.DRAW_DELAY, 100n, 'S.DRAW_DELAY in core must be 100n');
});

test('03.2 Premature timeout (< 432000 DAA) is rejected by protocol builder', () => {
  const sealed = {...S.appendPurchase(S.newOpen(KEY, BASE_CONFIG), 3, KEY), phase: S.Phase.SEALED};
  const utxoDaa = 100000n;

  // DAA = utxoDaa + 300 (old timeout)
  const x300 = snap(sealed, utxoDaa, utxoDaa + 300n);
  assert.throws(() => {
    builders.buildAction(x300, profile, {action: 'TIMEOUT_REFUND', actorKey: KEY}, 1000000n, []);
  }, /ACTION_NOT_AVAILABLE/, 'At 300 DAA, TIMEOUT_REFUND must not be available');

  // DAA = utxoDaa + 431999 (one DAA before deadline)
  const x431999 = snap(sealed, utxoDaa, utxoDaa + 431999n);
  assert.throws(() => {
    builders.buildAction(x431999, profile, {action: 'TIMEOUT_REFUND', actorKey: KEY}, 1000000n, []);
  }, /ACTION_NOT_AVAILABLE/, 'At 431999 DAA, TIMEOUT_REFUND must not be available');
});

test('03.3 Valid timeout (>= 432000 DAA) builds with sequence=432000 and is interpreted correctly', () => {
  const sealed = {...S.appendPurchase(S.newOpen(KEY, BASE_CONFIG), 3, KEY), phase: S.Phase.SEALED};
  const utxoDaa = 100000n;
  const currentDaa = utxoDaa + 432000n;
  const xValid = snap(sealed, utxoDaa, currentDaa);
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];

  const timeout = builders.buildAction(xValid, profile, {action: 'TIMEOUT_REFUND', actorKey: KEY}, 1000000n, funds);
  assert.equal(timeout.transaction.inputs[0].sequence, 432000n, 'Input sequence must be 432000n');

  const interp = interpretAccepted(xValid, profile, timeout.transaction, [xValid.value, 1000000000n]);
  assert.equal(interp.action, 'TIMEOUT_REFUND');
  assert.equal(interp.next.phase, S.Phase.REFUNDING);
});

test('03.4 Tampering sequence (< 432000) causes interpretAccepted to fail with SEQUENCE_REQUIREMENT', () => {
  const sealed = {...S.appendPurchase(S.newOpen(KEY, BASE_CONFIG), 3, KEY), phase: S.Phase.SEALED};
  const utxoDaa = 100000n;
  const currentDaa = utxoDaa + 432000n;
  const xValid = snap(sealed, utxoDaa, currentDaa);
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];
  const timeout = builders.buildAction(xValid, profile, {action: 'TIMEOUT_REFUND', actorKey: KEY}, 1000000n, funds);

  const tamperedSeq = structuredClone(timeout.transaction);
  tamperedSeq.inputs[0].sequence = 300n; // tamper sequence to old 300

  assert.throws(() => {
    interpretAccepted(xValid, profile, tamperedSeq, [xValid.value, 1000000000n]);
  }, /SEQUENCE_REQUIREMENT/, 'Sequence < 432000 must fail closed');
});

test('03.5 CLOSE timelock requires closeEligibleDaa - 1', () => {
  const open = S.newOpen(KEY, BASE_CONFIG);
  const x = snap(open, 100n, 600n);
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];
  const close = builders.buildAction(x, profile, {action: 'CLOSE', actorKey: KEY}, 1000000n, funds);

  assert.equal(close.transaction.lockTime, BASE_CONFIG.closeEligibleDaa - 1n);
});
