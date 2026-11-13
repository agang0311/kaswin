/** Pass 2: rebuild every base with the budgets MEASURED by vm-run.mjs, check them under the engine's committed limit, and quote mass.
 * Usage: node experiments/rolling/vm-budgets.mjs     (run vm-run.mjs first; it writes artifacts/vm/report.json)
 * Covenant inputs: budget = measured minimum. Funding (P2PK) inputs are never executed here (no signature exists), so their budget is
 * the ANALYTIC Schnorr cost: one sigop = 1000 gram = 100000 script units, minus the 9999 free units, over 10000 per budget unit = 10;
 * FUND_BUDGET adds one unit of margin for the push/CHECKSIG opcodes. That figure is NOT engine-measured.
 * Each base must pass under its committed limit and fail with ExceededCommittedScriptUnits at (budget - 1) on every input. */
import {readFileSync,writeFileSync,openSync,writeSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generate,useBudgets} from './vm-cases.mjs';
import {profile} from './fixtures.mjs';
const here=dirname(fileURLToPath(import.meta.url)),out=join(here,'artifacts','vm');
const bin=process.env.KASWIN_VM_BIN??join(here,'vm','target','release','kaswin-rolling-vm');
const FUND_BUDGET=11,LIMITS={computeMass:500000n,transientMass:1000000n,storageMass:500000n};
const pass1=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
if(pass1.profileId!==profile.id) throw new Error('report.json belongs to another profile; rerun vm-run.mjs');
const measured=new Map(pass1.positives.map(p=>[p.name,p.inputs]));
useBudgets((name,n)=>{const m=measured.get(name);if(!m) throw new Error('no measurement for '+name);return Array.from({length:n},(_,i)=>i<m.length?m[i].minBudget:FUND_BUDGET);});
const meta=new Map(),fd=openSync(join(out,'cases-budgets.ndjson'),'w');
const put=(c,m)=>{meta.set(c.name,m);writeSync(fd,JSON.stringify(c)+'\n');};
for(const c of generate({basesOnly:true})) {
  c.limited=true;put(c,{kind:'base',c});
  for(const i of c.execute) {
    if(c.meta.budgets[i]<=0) continue;
    const x={...c,name:`${c.name} | input ${i} budget-1`,expect:'fail',limited:true,
      tx:{...c.tx,inputs:c.tx.inputs.map((v,k)=>k===i?{...v,computeBudget:v.computeBudget-1}:v)}};
    put(x,{kind:'budget-1',base:c.name,input:i});
  }
}
closeSync(fd);
const run=spawnSync(bin,[join(out,'cases-budgets.ndjson'),join(out,'results-budgets.ndjson')],{stdio:'inherit',maxBuffer:1<<28});
if(run.error) throw run.error;
const results=readFileSync(join(out,'results-budgets.ndjson'),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const rows=[],bad=[],reasons={};
let bases=0,basesOk=0,minus=0,minusRejected=0;
for(const r of results) {
  const m=meta.get(r.name);
  if(m.kind==='base') {
    bases++;if(r.matches) basesOk++;else bad.push(r.name);
    const c=m.c,q=Object.fromEntries(Object.entries(c.meta.mass).map(([k,v])=>[k,BigInt(v)]));
    rows.push({scenario:r.name,module:c.meta.module,action:c.meta.action,inputs:c.tx.inputs.length,outputs:c.tx.outputs.length,
      budgets:c.meta.budgets,size:Number(q.size),computeMass:Number(q.computeMass),transientMass:Number(q.transientMass),storageMass:Number(q.storageMass),
      feeMass:Number(q.feeMass),relayFloorSompi:Number(q.relayFloor),
      overLimit:Object.entries(LIMITS).filter(([k,v])=>q[k]>v).map(([k])=>k)});
  } else {
    minus++;
    if(r.matches) minusRejected++;else bad.push(r.name);
    const e=r.inputs.find(i=>i.input===m.input)?.limitedError??'none';reasons[e.replace(/\{.*$/,'').slice(0,40)]=(reasons[e.replace(/\{.*$/,'').slice(0,40)]??0)+1;
  }
}
const report={status:'OFFLINE_SCRIPT_ENGINE_COMMITTED_BUDGET_QUOTE_NOT_CONSENSUS_NOT_ACCEPTANCE',profileId:profile.id,fundingBudgetAssumption:FUND_BUDGET,
  bases:{total:bases,passUnderCommittedLimit:basesOk},budgetMinusOne:{total:minus,rejected:minusRejected,reasons},problems:bad,scenarios:rows};
writeFileSync(join(out,'budget-report.json'),JSON.stringify(report,null,1)+'\n');
console.log(`bases under committed budgets: ${basesOk}/${bases}; budget-1 rejected: ${minusRejected}/${minus}; problems: ${bad.length}`);
console.log('budget-1 errors',reasons);
console.table(rows.map(r=>({scenario:r.scenario.slice(0,62),in:r.inputs,out:r.outputs,size:r.size,compute:r.computeMass,transient:r.transientMass,storage:r.storageMass,feeMass:r.feeMass,over:r.overLimit.join(',')})));
for(const b of bad.slice(0,20)) console.log('PROBLEM',b);
process.exitCode=bad.length?1:0;
