import test from 'node:test';
import assert from 'node:assert/strict';
import {actionBudget, budgetOf, actionUnits} from '../../../packages/f3.2-core/lib/protocol.js';
import * as S from '../../../packages/f3.2-core/lib/state.js';

const KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const config = {ticketPrice: 100_000_000n, ticketCap: 100_000, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 500n};

test('V2 zero-ticket ledger uses 228-byte header and canonical PUSHDATA1; first record uses PUSHDATA2', () => {
  const s = S.newOpen(KEY, config), raw = S.encodeLedger(s);
  assert.equal(S.HEADER, 228);
  assert.equal(raw.length, 228);
  assert.equal(Buffer.from(raw.slice(0, 4)).toString(), 'KW20');
  assert.equal('routes' in s, false);
  assert.equal('networkGenesis' in s, false);
  assert.deepEqual([...S.pushBytes(raw).slice(0, 2)], [0x4c, 0xe4]);
  const purchased = S.encodeLedger(S.appendPurchase(s, 3, KEY));
  assert.equal(purchased.length, 264);
  assert.deepEqual([...S.pushBytes(purchased).slice(0, 3)], [0x4d, 0x08, 0x01]);
});

test('V2 provisional budgets: genesis constant, alias, missing ledger and unsupported actions', () => {
  const s = S.newOpen(KEY, config);
  assert.equal(actionBudget('GENESIS'), 10);
  assert.equal(budgetOf('BUY', s), actionBudget('BUY', s));
  assert.throws(() => actionBudget('BUY'), /LEDGER_REQUIRED_FOR_BUDGET/);
  for (const a of ['DRAW', 'ACCEPT', 'ADVANCE_SAMPLE', 'ACCEPT_AND_PAY', 'PAY']) assert.throws(() => actionUnits(a, s), /NO_CALIBRATED_BUDGET/);
});

// Historical min-budgets.json (F3.2 / 3,446 cases) is retained, never loaded as a V2 oracle.
// A JS inequality over old numbers cannot establish V2 script cost or the 256-record limit.
test.todo('V2 VM calibration: reviewed measurements must bind the new Profile before budgetProfileId is set');
