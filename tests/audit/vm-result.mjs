// Pure result validation. Infrastructure failures can NEVER satisfy a negative case.
import assert from 'node:assert/strict';
export function checkVmResult({stdout, exitCode, signal}, tc, profileId) {
  assert.equal(signal ?? null, null, 'VM_INFRA_SIGNAL');
  assert.equal(exitCode, 0, 'VM_INFRA_EXIT');
  const lines = stdout.split('\n').filter(s => s.startsWith('KASWIN_VM_RESULT '));
  assert.equal(lines.length, 1, 'VM_RESULT_COUNT');
  const r = JSON.parse(lines[0].slice('KASWIN_VM_RESULT '.length));
  assert.equal(r.schema, 'KASWIN_SCRIPT_VM_1'); assert.equal(r.name, tc.name); assert.equal(r.profileId, profileId);
  assert.equal(r.scope, 'SCRIPT_VM_NOT_FULL_TRANSACTION');
  assert.deepEqual(r.budgets, tc.draft.transaction.inputs.map(i => i.computeBudget));
  assert.ok(Array.isArray(r.units) && r.units.length > 0 && r.units.length <= r.budgets.length, 'VM_UNITS');
  r.units.forEach((u, i) => assert.ok(Number.isSafeInteger(u) && u >= 0 && u <= 9999 + 10000 * r.budgets[i], 'VM_BUDGET_EXCEEDED'));
  if (tc.expectedPass) {
    assert.equal(r.status, 'ACCEPT'); assert.equal(r.error, null); assert.equal(r.units.length, r.budgets.length);
  } else {
    assert.equal(r.status, 'REJECT', 'VM_ERROR_IS_NOT_REJECTION'); assert.equal(r.input, 0, 'WRONG_REJECTED_INPUT');
    assert.equal(r.units.length, 1, 'REJECTED_INPUT_UNITS_COUNT');
    assert.ok(tc.expectedErrors.includes(r.error), 'WRONG_REJECTION_REASON');
  }
  return r;
}
