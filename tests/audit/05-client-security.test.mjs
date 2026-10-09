// Reuse focused security regressions rather than weaker duplicate HTML string tests.
// Source only in this remediation; importing the following files RUNS their node:test cases.
import '../../apps/kaswin-v2/test/remediation.test.mjs';
import '../../apps/kaswin-v2/test/release-safety.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {reservedInputs} from '../../apps/kaswin-v2/scripts/shared/reservations.mjs';

test('published candidate manifest, evidence, HTML fingerprint and CSP agree', async () => {
  const base = new URL('../../releases/kaswin-v2/', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('build-manifest.json', base), 'utf8'));
  const html = await fs.readFile(new URL('index.html', base), 'utf8');
  assert.equal(manifest.budgetProfileId, null);
  if (manifest.releaseMode === 'TN10_ACCEPTANCE_CANDIDATE') {
    assert.equal(manifest.tradingEnabled, true); assert.equal(manifest.publicLaunchApproved, false);
    const raw = await fs.readFile(new URL('../../contracts/f3.2/tn10-release-evidence.json', import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'), manifest.tn10EvidenceSha256);
    assert.equal(JSON.parse(raw).vmCalibrated, false);
    assert.equal(html.includes('TN10 TRADABLE ACCEPTANCE CANDIDATE'), false);
  } else {
    assert.equal(manifest.releaseMode, 'READ_ONLY_UNVERIFIED_CANDIDATE');
    assert.equal(manifest.tradingEnabled, false);
  }
  assert.equal(createHash('sha256').update(html).digest('hex'), manifest.sha256);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  assert.ok(html.includes(`sha256-${createHash('sha256').update(scripts[0][1]).digest('base64')}`));
});

test('reservation malformed inputs is the ONLY mutated field; valid control reserves its outpoint', async () => {
  const network = 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';
  const profile = '11'.repeat(32), txid = '22'.repeat(32), outpoint = {transactionId: '33'.repeat(32), index: 0};
  const row = {key: `${network}/${profile}/tx/${txid}`, record: {value: {txid, status: 'UNKNOWN', inputs: [outpoint]}}};
  const store = {list: async () => [row]};
  assert.ok((await reservedInputs(store, network)).has(`${outpoint.transactionId}:0`));
  for (const bad of ['not an array', null, []]) {
    row.record.value.inputs = bad;
    await assert.rejects(reservedInputs(store, network), /^Error: INPUT_RESERVATION_RECORD_INVALID$/);
  }
});
