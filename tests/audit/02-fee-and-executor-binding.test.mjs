// 02-fee-and-executor-binding.test.mjs: Test fee conservation, 0.5 TKAS fee cap, and executor output binding in REFUND.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import * as builders from '../../packages/f3.2-core/lib/builders.js';
import {interpretAccepted} from '../../packages/f3.2-core/lib/accepted.js';
import {p2pk, p2sh} from '../../packages/f3.2-core/lib/covenant-id.js';
import {hex, unhex, cat} from '../../packages/f3.2-core/lib/bytes.js';
import {blake2b256} from '../../packages/f3.2-core/lib/hashes.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');
const {profile} = await loadV2Bundle(CONTRACTS);

const KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const OTHER_KEY = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const ORIGIN = {transactionId: '11'.repeat(32), index: 0};
const BASE_CONFIG = {ticketPrice: 100000000n, ticketCap: 10, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 500n};

function snap(s, utxoDaa = 100n, currentDaa = 101n) {
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

function items(sig) {
  const raw = unhex(sig), out = []; let at = 0;
  while (at < raw.length) {
    const start = at, op = raw[at++]; let n = 0;
    if (op >= 1 && op <= 75) n = op;
    else if (op >= 76 && op <= 78) {
      const w = op === 76 ? 1 : op === 77 ? 2 : 4;
      for (let j = 0; j < w; j++) n += raw[at++] * 2**(8*j);
    }
    at += n; out.push(raw.slice(start, at));
  }
  return out;
}
const join = xs => hex(cat(...xs));

test('02.1 Fee conservation: real fee must equal totalIn - totalOut and match witness fee', () => {
  const open = S.newOpen(KEY, BASE_CONFIG);
  const x = snap(open);
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];
  const buy = builders.buildAction(x, profile, {action: 'BUY', actorKey: KEY, quantity: 2}, 1500000n, funds);

  const inputValues = [x.value, 1000000000n];
  const totalIn = inputValues.reduce((a, b) => a + b, 0n);
  const totalOut = buy.transaction.outputs.reduce((a, b) => a + b.value, 0n);
  assert.equal(totalIn - totalOut, 1500000n, 'Fee conservation: totalIn - totalOut must be 1.5M sompi');

  const interp = interpretAccepted(x, profile, buy.transaction, inputValues);
  assert.equal(interp.fee, 1500000n);
  assert.equal(interp.witnessFee, 1500000n);
});

test('02.2 Fee witness tampering is rejected by interpretAccepted (anti-malleability)', () => {
  const open = S.newOpen(KEY, BASE_CONFIG);
  const x = snap(open);
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];
  const buy = builders.buildAction(x, profile, {action: 'BUY', actorKey: KEY, quantity: 1}, 1000000n, funds);

  const tampered = structuredClone(buy.transaction);
  const w = items(tampered.inputs[0].signatureScript);
  w[7] = builders.pushInt(500000n); // tamper fee witness from 1000000 to 500000
  tampered.inputs[0].signatureScript = join(w);

  assert.throws(() => {
    interpretAccepted(x, profile, tampered, [x.value, 1000000000n]);
  }, /FEE_MISMATCH/, 'Mutated fee witness must fail closed with FEE_MISMATCH');
});

test('02.3 Fee exceeding 0.5 TKAS (50,000,000 sompi) is rejected', () => {
  const open = S.newOpen(KEY, BASE_CONFIG);
  const x = snap(open);
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 2000000000n, spk: p2pk(KEY), daa: 1n}];

  assert.throws(() => {
    builders.buildAction(x, profile, {action: 'BUY', actorKey: KEY, quantity: 1}, 50000001n, funds);
  }, /NETWORK_FEE|FEE_CAP/, 'Fee > 50M must be rejected at build time');
});

test('02.4 REFUND binds executor output to actorPk and exact computed remainder', () => {
  const refundingLedger = {...S.appendPurchase(S.newOpen(KEY, {...BASE_CONFIG, minTickets: 5}), 3, KEY), phase: S.Phase.REFUNDING};
  const x = snap(refundingLedger, 501n, 502n);
  const refund = builders.buildAction(x, profile, {action: 'REFUND', actorKey: KEY}, 100000n, []);

  // Canonical interpretation succeeds
  const interp = interpretAccepted(x, profile, refund.transaction, [x.value]);
  assert.equal(interp.action, 'REFUND');
  assert.equal(interp.terminal, 'REFUNDED');

  const executorOut = interp.outputs.find(o => o.role === 'EXECUTOR');
  assert.ok(executorOut, 'Executor output must exist with role EXECUTOR');
  assert.equal(executorOut.scriptPublicKey.script, p2pk(KEY).script, 'Executor output script must match actorPk');

  // Mutation 1: Diverting executor output to another pubkey
  const tamperedKey = structuredClone(refund.transaction);
  tamperedKey.outputs[tamperedKey.outputs.length - 1].scriptPublicKey = p2pk(OTHER_KEY);
  assert.throws(() => {
    interpretAccepted(x, profile, tamperedKey, [x.value]);
  }, /PAYOUT_MISMATCH/, 'Diverting executor payment to another key must be rejected');

  // Mutation 2: Diverting executor sompi (shortpaying by 1 sompi)
  const tamperedValue = structuredClone(refund.transaction);
  tamperedValue.outputs[tamperedValue.outputs.length - 1].value -= 1n;
  assert.throws(() => {
    interpretAccepted(x, profile, tamperedValue, [x.value]);
  }, /FEE_MISMATCH|PAYOUT_MISMATCH/, 'Tampering executor amount must be rejected');
});
