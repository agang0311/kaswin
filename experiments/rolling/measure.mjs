/** Contract-size and transaction-mass report from the real compiled artifacts. Offline: no node, signing or VM.
 * Usage: node experiments/rolling/measure.mjs            (reads artifacts/*.json and generated/*.sil)
 * Compute budgets are NOT measured here; every input uses budget 0, so computeMass is a size-only lower bound.
 * The report is a size/mass quotation, not VM, acceptance or fee-market evidence. */
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {S,here,texts,trust,profile,OWNER,PRICE,KAS,FEE,fixture,fund,quote,findDraw,buildAction,massOf} from './fixtures.mjs';
import {buildGenesis} from './transactions.mjs';
const rows=[];
function add(module,name,r) {
  const {d,q}=r,sig=d.transaction.inputs.map(i=>i.signatureScript.length/2);
  rows.push({module,scenario:name,inputs:d.transaction.inputs.length,outputs:d.transaction.outputs.length,
    sigscriptBytes:sig,
    size:Number(q.size),computeMassLowerBound:Number(q.computeMass),transientMass:Number(q.transientMass),
    storageMass:Number(q.storageMass),feeMass:Number(q.feeMass),orderingMass:Number(q.orderingMass)});
}
// SALES
{
  const g=buildGenesis(profile,OWNER,{ticketPrice:PRICE,ticketCap:10000000,minTickets:3,closeEligibleDaa:1000n},{funds:[fund(0,3n*S.DEPOSIT,OWNER)],fee:FEE,budgets:[0]});
  add('sales','GENESIS',{d:g,q:massOf(g)});
  const buy=(name,o)=>{const f=fixture({module:'sales',...o});add('sales',name,quote(f,{action:'BUY',quantity:1},{funds:[fund(1,PRICE+S.DEPOSIT*0n+10n*KAS)]}));return f;};
  buy('BUY first (cnt=0, local=0)',{});
  buy('BUY (cnt=254, local=254) largest nonfreezing',{cnt:254,local:254});
  buy('BUY freeze (cnt=0, local=255)',{cnt:0,local:255});
  buy('BUY freeze (cnt=254, local=255) largest',{cnt:254,local:255});
  const close=(name,o,m)=>add('sales',name,quote(fixture({module:'sales',...o}),{action:'CLOSE'},{funds:[fund(2,10n*KAS)]}));
  close('CLOSE empty (cnt=0, local=0)',{});
  close('CLOSE -> SEALED (cnt=255, local=255) largest',{cnt:255,local:255,currentDaa:500000n});
  close('CLOSE -> REFUND (cnt=255, local=255, T<min) largest',{cnt:255,local:255,minTickets:70000});
}
// SEALED
{
  for(const [name,o] of [['DRAW (cnt=1, local=0)',{cnt:1}],['DRAW (cnt=255, local=255) largest',{cnt:255,local:255}]]) {
    const f=fixture({module:'sealed',...o,currentDaa:2000n+S.DRAW_DELAY+10n});
    // The drawn ticket must fall in an old shard: that forces the largest (raw shard) witness.
    add('sealed',name,quote(f,findDraw(f,true),{funds:[fund(3,10n*KAS)]}));
  }
  const f=fixture({module:'sealed',cnt:255,local:255,currentDaa:2000n+S.TIMEOUT_DELAY});
  add('sealed','TIMEOUT -> REFUND (cnt=255, local=255) largest',quote(f,{action:'TIMEOUT'},{funds:[fund(4,10n*KAS)]}));
}
// WIN
{
  const f=fixture({module:'win',cnt:255,local:255});
  add('win','PAY_OLD k=1 (cnt=255, local=255)',quote(f,{action:'PAY_OLD'},{targets:f.targets.slice(0,1),fee:50000000n}));
  add('win','PAY_OLD k=16 (cnt=255, local=255)',quote(f,{action:'PAY_OLD'},{targets:f.targets.slice(0,16),fee:50000000n}));
  const own=fixture({module:'win',cnt:255,local:255,p:255});
  add('win','PAY_SELF (cnt=255, local=255)',quote(own,{action:'PAY_SELF'},{fee:50000000n}));
  const small=fixture({module:'win',cnt:0,local:3});
  add('win','PAY_SELF (cnt=0, local=3) smallest',quote(small,{action:'PAY_SELF'},{fee:50000000n}));
}
// REFUND
{
  const f=fixture({module:'refund',cnt:255,local:255});
  add('refund','REFUND_OLD nonfinal (cnt=255, local=255, c=0)',quote(f,{action:'REFUND_OLD'},{targets:f.targets.slice(0,1),fee:50000000n}));
  const fin=fixture({module:'refund',cnt:255,local:2,r:254,c:224});
  add('refund','REFUND_OLD final merged (36 outputs)',quote(fin,{action:'REFUND_OLD'},{targets:fin.targets.slice(254,255),fee:50000000n}));
  const own=fixture({module:'refund',cnt:0,local:255,r:0,c:0});
  add('refund','REFUND_SELF m=32 (cnt=0, local=255)',quote(own,{action:'REFUND_SELF'},{funds:[fund(5,3000000n)],fee:5000000n}));
  const ownMax=fixture({module:'refund',cnt:255,local:255,r:255,c:0});
  add('refund','REFUND_SELF m=32 (cnt=255, local=255) largest',quote(ownMax,{action:'REFUND_SELF'},{funds:[fund(5,3000000n)],fee:5000000n}));
}
const frames={};
for(const m of S.MODULES) {
  const art=JSON.parse(texts[m]),c=Object.values(art.contracts)[0].compiled,len=c.bytecode.length,span=c.state_span;
  frames[m]={bytecodeBytes:len,statePushBytes:span.len,tailBytes:len-1-span.len,templateHash:profile.frames[m].templateHash,
    dispatchTag:profile.frames[m].dispatchTag,artifactSha256:trust[m].artifactSha256,sourceSha256:trust[m].sourceSha256};
}
const report={status:'OFFLINE_SIZE_MASS_QUOTATION_COMPUTE_BUDGET_NOT_MEASURED',compiler:{package:'silverscript-lang 1.0.1',commit:profile.compilerCommit},
  profileId:profile.id,limits:{computeMass:500000,transientMass:1000000,storageMass:500000,signatureScriptBytes:250000},frames,scenarios:rows};
await writeFile(join(here,'artifacts','size-mass-report.json'),JSON.stringify(report,null,1)+'\n');
console.log('profile',profile.id);
console.table(Object.fromEntries(Object.entries(frames).map(([m,f])=>[m,{bytecode:f.bytecodeBytes,tail:f.tailBytes,dispatch:f.dispatchTag}])));
console.table(rows.map(r=>({module:r.module,scenario:r.scenario,in:r.inputs,out:r.outputs,size:r.size,compute:r.computeMassLowerBound,transient:r.transientMass,storage:r.storageMass,feeMass:r.feeMass})));
