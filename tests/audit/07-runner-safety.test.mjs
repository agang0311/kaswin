// Minimal regression sources for review findings. NOT RUN in remediation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from '../tn10/cli.mjs';
import {Journal} from '../tn10/journal.mjs';
import {signDraft} from '../tn10/signing.mjs';
import {checkVmResult} from './vm-result.mjs';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import {buildOpenGenesis} from '../../packages/f3.2-core/lib/builders.js';
import {p2pk} from '../../packages/f3.2-core/lib/covenant-id.js';
import {referenceTxId} from '../../packages/f3.2-core/lib/transaction.js';
import {fileURLToPath} from 'node:url';

test('CLI rejects verify+execute, unknown flags and path traversal before side effects', () => {
  assert.equal(parseArgs([]).mode, 'dry');
  assert.equal(parseArgs(['--verify', '--round=r1', '--step=01-GENESIS']).mode, 'verify');
  for (const args of [['--verify', '--execute'], ['--submit'], ['--allow-timeout-refund'], ['--scenario=evil'],
    ['--execute', '--round=../escape', '--scenario=empty', '--approval=/tmp/a.json'], ['--dry', '--round=r1'], ['--verify']]) assert.throws(() => parseArgs(args));
});

test('journal excludes concurrent writers, never overwrites intent, blocks incomplete run after restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaswin-journal-unit-'));
  try {
    const a = new Journal(root), b = new Journal(root); a.lock(); assert.throws(() => b.lock(), /EEXIST/);
    a.start('r1', {schema: 'KASWIN_TN10_RUN_2'});
    a.persist('r1', '01-GENESIS', {networkGenesis: '11'.repeat(32), profileId: '22'.repeat(32), draft: {txid: '33'.repeat(32)}, signed: {}, snapshot: null, anchor: '44'.repeat(32)});
    const saved = fs.readFileSync(path.join(root, 'r1/01-GENESIS-intent.json'));
    assert.throws(() => a.persist('r1', '01-GENESIS', {}), /EEXIST/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'r1/01-GENESIS-intent.json')), saved);
    a.event('r1', '01-GENESIS', 'UNKNOWN'); a.unlock(); b.lock();
    try {assert.throws(() => b.checkUnresolved());} finally {b.unlock();}
  } finally {fs.rmSync(root, {recursive: true, force: true});} // this test's own ephemeral directory only
});

test('async false signature verification is awaited and rejects before caller can submit', async () => {
  const {profile} = await loadV2Bundle(fileURLToPath(new URL('../../contracts/f3.2/', import.meta.url)));
  const key = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const draft = buildOpenGenesis(profile, key, {ticketPrice: 100000000n, ticketCap: 3, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 500n},
    [{outpoint: {transactionId: '11'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(key), daa: 1n}], 1000000n);
  draft.txid = referenceTxId(draft.transaction);
  await assert.rejects(signDraft(draft, key, async () => '41' + '11'.repeat(64) + '01', async () => false), /SIGNATURE_INVALID/);
});

test('VM infrastructure errors, wrong-input rejects and missing rows never count as negative PASS', () => {
  const tc = {name: 'NEG', draft: {transaction: {inputs: [{computeBudget: 20}]}}, expectedPass: false, expectedErrors: ['VerifyError']};
  const row = {schema: 'KASWIN_SCRIPT_VM_1', name: 'NEG', profileId: 'p', scope: 'SCRIPT_VM_NOT_FULL_TRANSACTION', budgets: [20], units: [1000], status: 'REJECT', input: 0, error: 'VerifyError'};
  const output = r => ({stdout: 'KASWIN_VM_RESULT ' + JSON.stringify(r), exitCode: 0});
  assert.equal(checkVmResult(output(row), tc, 'p').status, 'REJECT');
  for (const r of [{...output(row), exitCode: 'ENOENT'}, {...output(row), signal: 'SIGKILL'}, {stdout: '', exitCode: 0},
    output({...row, status: 'ERROR'}), output({...row, input: 1}), output({...row, error: 'BudgetExceeded'}), output({...row, budgets: [65535]})]) assert.throws(() => checkVmResult(r, tc, 'p'));
});
