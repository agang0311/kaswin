// L-only tests for local double-spend prevention, not protocol/VM/acceptance evidence. Not yet run for V2.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reservedInputs} from '../scripts/shared/reservations.mjs';
const network = '11'.repeat(32), current = '22'.repeat(32), other = '33'.repeat(32);
const input = n => ({transactionId: n.repeat(64), index: 0});
const row = (profile, n, status, inputs = [input(n)], net = network) => ({key: `${net}/${profile}/tx/${n.repeat(64)}`, record: {value: {status, inputs}}});
const store = rows => ({list: async prefix => structuredClone(rows.filter(r => r.key.startsWith(prefix)))});

test('reservations span Profiles within one network without decoding or mutating any record', async () => {
  const rows = [row(current, '1', 'SUBMITTING'), row(other, '2', 'UNKNOWN'), row(other, '3', 'ACCEPTED'),
    row(other, '4', 'REJECTED'), row(other, '5', 'ARCHIVED'), row(other, '6', 'FUTURE_STATUS'),
    row(other, '7', 'UNKNOWN', [input('7')], '99'.repeat(32)),
    {key: `${network}/${other}/round/${'8'.repeat(64)}`, record: {value: {}}}];
  const before = structuredClone(rows);
  assert.deepEqual([...await reservedInputs(store(rows), network)], ['1', '2', '3', '6'].map(n => `${n.repeat(64)}:0`));
  assert.deepEqual(rows, before);
});

test('malformed unresolved intent blocks reservations instead of freeing inputs', async () => {
  await assert.rejects(reservedInputs(store([row(other, '1', 'UNKNOWN', [])]), network), /INPUT_RESERVATION_RECORD_INVALID/);
  await assert.rejects(reservedInputs(store([row(other, '1', 'UNKNOWN', [{transactionId: 'bad', index: 0}])]), network), /INPUT_RESERVATION_OUTPOINT_INVALID/);
});
