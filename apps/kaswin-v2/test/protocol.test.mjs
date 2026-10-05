import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {actionBudget, budgetOf, actionUnits, BUDGET_MARGIN} from '../../../packages/f3.2-core/lib/protocol.js';
import * as S from '../../../packages/f3.2-core/lib/state.js';

// Pinned offline-VM measurements (3,446 cases, rusty-kaspa cfafeb4 TxScriptEngine). Historical data; the VM harness and
// generators are not published here (see docs/kaswin-v2/VALIDATION.md).
const calib = JSON.parse(fs.readFileSync(new URL('./fixtures/min-budgets.json', import.meta.url), 'utf8'));
const routes = {open: '11'.repeat(32), sealed: '22'.repeat(32), refunding: '33'.repeat(32)};
const KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
function ledger(phase, pc, {cursor = 0, minTickets = 3, first = 3} = {}) {
  const config = {ticketPrice: 100_000_000n, ticketCap: 100_000, purchaseCap: 256, minTickets, closeEligibleDaa: 500n};
  let end = 0; const dir = new Uint8Array(pc * 36);
  for (let i = 0; i < pc; i++) { end += i === 0 ? first : 1; new DataView(dir.buffer).setUint32(i * 36, end, true); dir.set(Buffer.from(KEY, 'hex'), i * 36 + 4); }
  return {...S.newOpen(KEY, 'f8'.repeat(32), routes, config), phase, sold: end, purchaseCount: pc, cursor, directory: dir};
}

test('F3.2 actionBudget covers every VM-measured minimum with the declared margin', () => {
  assert.equal(calib.cases >= 3446, true);
  let checked = 0;
  const expect = (fam, key, s, action) => {
    const need = calib.minBudget[fam][key];
    assert.ok(Number.isInteger(need), `${fam} ${key}`);
    const b = actionBudget(action, s);
    assert.ok(b >= need + BUDGET_MARGIN, `${fam} ${key}: budget ${b} < measured ${need} + ${BUDGET_MARGIN}`);
    assert.ok(b <= need + BUDGET_MARGIN + 16, `${fam} ${key}: budget ${b} wastes more than 16 units over ${need}`);
    checked++;
  };
  for (let pc = 0; pc < 256; pc++) expect('BUY', String(pc), ledger(1, pc, {first: 1}), 'BUY');
  expect('CLOSE_EMPTY', '0', ledger(1, 0), 'CLOSE');
  for (let pc = 1; pc <= 256; pc++) {
    expect('CLOSE_SEALED', String(pc), ledger(1, pc), 'CLOSE');
    expect('CLOSE_REFUNDING', String(pc), ledger(1, pc, {minTickets: 100_000, first: 1}), 'CLOSE');
    expect('DRAW_AND_PAY', String(pc), ledger(2, pc), 'DRAW_AND_PAY');
    expect('TIMEOUT_REFUND', String(pc), ledger(2, pc), 'TIMEOUT_REFUND');
    for (let c = 0; c < pc; c += 32) expect('REFUND', `${pc}:${c}`, ledger(5, pc, {cursor: c, minTickets: 100_000, first: 1}), 'REFUND');
  }
  assert.equal(checked, 256 + 1 + 256 * 4 + Object.keys(calib.minBudget.REFUND).length);
});

test('F3.2 actionBudget: genesis constant, alias, and no silent default for uncalibrated actions', () => {
  assert.equal(actionBudget('GENESIS'), 10);
  assert.equal(budgetOf('BUY', ledger(1, 0, {first: 1})), actionBudget('BUY', ledger(1, 0, {first: 1})));
  assert.throws(() => actionBudget('BUY'), /LEDGER_REQUIRED_FOR_BUDGET/);
  for (const a of ['DRAW', 'ACCEPT', 'ADVANCE_SAMPLE', 'ACCEPT_AND_PAY', 'PAY']) assert.throws(() => actionUnits(a, ledger(2, 3)), /NO_CALIBRATED_BUDGET/);
  // The 256-record TN10 run used CLOSE 116 / DRAW_AND_PAY 195; the envelope stays at or above both.
  assert.ok(actionBudget('CLOSE', ledger(1, 256, {first: 1})) >= 116);
  assert.ok(actionBudget('DRAW_AND_PAY', ledger(2, 256)) >= 195);
});
