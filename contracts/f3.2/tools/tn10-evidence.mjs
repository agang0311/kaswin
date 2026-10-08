// Historical local receipt integrity, NOT an independent network/VM verifier.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const sha = b => createHash('sha256').update(b).digest('hex');
export const SCENARIOS = {'empty-r1': [2,'EMPTY'], 'refund-r1': [5,'REFUNDED'], 'payout-r1': [5,'PAID'], 'payout256-r1': [259,'PAID'], 'refund100-r1': [106,'REFUNDED']};
export const SOURCE_FILES = ['packages/f3.2-core/src/protocol.ts','packages/f3.2-core/src/builders.ts','packages/f3.2-core/src/accepted.ts','contracts/f3.2/pins.json','contracts/f3.2/profile.json','contracts/f3.2/tools/tn10-evidence.mjs'];
export async function collectEvidence(repo, profile, networkGenesis) {
 const records=[], rounds=[];
 for (const [round,[count,terminal]] of Object.entries(SCENARIOS)) {
  const dir=path.join(repo,'tests/tn10/evidence',round), names=(await fs.readdir(dir)).filter(n=>n.endsWith('-accepted.json')).sort((a,b)=>parseInt(a)-parseInt(b));
  assert.equal(names.length,count);let previous=null,totalFee=0n;
  for (const [index,name] of names.entries()) {
   const step=name.slice(0,-14);assert.equal(parseInt(step),index+1);
   const receiptRaw=await fs.readFile(path.join(dir,name)), intentRaw=await fs.readFile(path.join(dir,`${step}-intent.json`));
   const r=JSON.parse(receiptRaw),i=JSON.parse(intentRaw),tx=r.transaction;
   assert.equal(r.schema,'KASWIN_TN10_ACCEPTED_2');assert.equal(r.status,'ACCEPTED');assert.equal(r.profileId,profile.id);assert.equal(r.networkGenesis,networkGenesis);
   assert.equal(i.profileId,profile.id);assert.equal(i.networkGenesis,networkGenesis);assert.equal(r.txid,i.txid);
   assert.equal(r.intentSha256,sha(intentRaw));assert.equal(i.recordSha256,sha(await fs.readFile(path.join(dir,`${step}-record.bin`))));
   assert.deepEqual(tx.outputs,i.draft.transaction.outputs);
   const fee=BigInt(r.actualFeeSompi);assert(fee>0n&&fee<=50000000n);assert.equal(fee,BigInt(i.draft.fee));
   assert.equal(r.inputContext.reduce((n,u)=>n+BigInt(u.value),0n)-tx.outputs.reduce((n,o)=>n+BigInt(o.value),0n),fee);
   assert.match(r.acceptingBlockHash,/^[0-9a-f]{64}$/);assert.match(String(r.acceptingDaa),/^\d+$/);
   assert(BigInt(r.computeMass)>0n);assert(BigInt(r.storageMass)>=0n);
   let purchaseCount=0,cursor=0,phase=0;
   if(i.snapshot) {
    const b=Buffer.from(i.snapshot.ledger,'hex');phase=b.readUInt32LE(4);purchaseCount=b.readUInt32LE(40);cursor=b.readUInt32LE(44);
    assert.equal(b.length,228+36*purchaseCount);assert.equal(i.snapshot.utxoDaa,r.inputContext[0].daa);
    assert.deepEqual(tx.inputs[0].previousOutpoint,{transactionId:previous,index:0});
    const tail=profile.frames[{1:'open',2:'sealed',5:'refunding'}[phase]].tail;
    assert(tx.inputs[0].signatureScript.endsWith(typeof tail==='string'?tail:Buffer.from(tail).toString('hex')));
   } else assert.equal(index,0);
   if(index===count-1)assert.equal(r.terminal,terminal);else assert.equal(r.terminal,null);
   records.push({round,step,txid:r.txid,acceptingBlockHash:r.acceptingBlockHash,acceptingDaa:r.acceptingDaa,checkedAt:r.checkedAt,feeSompi:r.actualFeeSompi,computeMass:r.computeMass,storageMass:r.storageMass,purchaseCount,cursor,phase,budgets:tx.inputs.map(x=>x.computeBudget),terminal:r.terminal,receiptSha256:sha(receiptRaw),intentSha256:sha(intentRaw),recordSha256:i.recordSha256});
   previous=r.txid;totalFee+=fee;
  }
  const complete=JSON.parse(await fs.readFile(path.join(dir,'complete.json')));assert.equal(complete.status,'COMPLETED');assert.equal(complete.terminal,terminal);
  rounds.push({round,count,terminal,totalFeeSompi:String(totalFee)});
 }
 assert.deepEqual(records.filter(r=>r.round==='payout256-r1'&&r.step.includes('-BUY')).map(r=>r.purchaseCount),Array.from({length:256},(_,i)=>i));
 assert.deepEqual(records.filter(r=>r.round==='refund100-r1'&&r.step.includes('-REFUND')).map(r=>r.cursor),[0,32,64,96]);
 const sourceSha256=Object.fromEntries(await Promise.all(SOURCE_FILES.map(async f=>[f,sha(await fs.readFile(path.join(repo,f)))])));
 return {profileId:profile.id,networkGenesis,sourceSha256,rounds,records};
}
export async function requireTn10Evidence(repo, profile, pins) {
 const raw=await fs.readFile(path.join(repo,'contracts/f3.2/tn10-release-evidence.json')),e=JSON.parse(raw);
 assert.equal(e.schema,'KASWIN_TN10_ACCEPTANCE_CANDIDATE_1');
 assert.equal(e.publicLaunchApproved,false);assert.equal(e.vmCalibrated,false);
 assert.deepEqual(e.unverified,['TIMEOUT_REFUND','REFUND_DIRECTORY_256','REAL_KASWARE_END_TO_END']);
 assert.equal(e.review.scope,'TN10_ACCEPTANCE_CANDIDATE_ONLY');assert.equal(e.review.reviewer,'main-assistant');
 assert.deepEqual(e.evidence,await collectEvidence(repo,profile,pins.networkGenesis),'Receipt/source drift: regenerate and review candidate evidence');
 return {sha256:sha(raw),...e};
}
