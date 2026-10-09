import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {requireTn10Evidence} from '../../contracts/f3.2/tools/tn10-evidence.mjs';
import {requireReviewedBudgets} from '../../contracts/f3.2/tools/budget-gate.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
test('TN10 receipts only admit bounded candidate; VM gate still refuses and wrong profile fails',async()=>{
 await fs.access(new URL('../tn10/evidence/empty-r1/complete.json', import.meta.url)).catch(() => {
  throw Error('TN10_EVIDENCE_REQUIRED: obtain the controlled raw receipt set described in docs/kaswin-v2/EVIDENCE-ACCESS.md; this gate cannot be skipped or replaced by public summaries.');
 });
 const profile=JSON.parse(await fs.readFile(new URL('../../contracts/f3.2/profile.json',import.meta.url))),pins=JSON.parse(await fs.readFile(new URL('../../contracts/f3.2/pins.json',import.meta.url)));
 const e=await requireTn10Evidence(repo,profile,pins);assert.equal(e.evidence.records.length,377);assert.equal(e.publicLaunchApproved,false);assert.equal(e.vmCalibrated,false);
 await assert.rejects(requireTn10Evidence(repo,{...profile,id:'00'.repeat(32)},pins));
 await assert.rejects(requireReviewedBudgets(repo+'/contracts/f3.2',pins,profile),/release is BLOCKED/);
});
