/** Pass 2: rebuild every base with the budgets MEASURED by vm-run.mjs, check them under the engine's committed limit, and quote mass.
 * Usage: node tests/contracts/vm-budgets.mjs     (run vm-run.mjs first; it writes artifacts/vm/report.json)
 * Every input, funding (P2PK) inputs included, gets its measured minimum budget. Funding inputs are really signed with a deterministic
 * PUBLIC throwaway key (see vm-cases.mjs) using the page's JS Schnorr signer and sighash, and executed by the engine.
 * Each base must pass under its committed limit and fail with ExceededCommittedScriptUnits at (budget - 1) on every input.
 * Signature controls: a flipped signature byte, and a transaction tampered after signing, must fail on the funding input alone. */
import {readFileSync,writeFileSync,openSync,writeSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generate,useBudgets} from './vm-cases.mjs';
import {profile} from './fixtures.mjs';
const here=dirname(fileURLToPath(import.meta.url)),out=join(here,'artifacts','vm');
const bin=process.env.KASWIN_VM_BIN??join(here,'vm','target','release','kaswin-rolling-vm');
const LIMITS={computeMass:500000n,transientMass:1000000n,storageMass:500000n};
const pass1=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
if(pass1.profileId!==profile.id) throw new Error('report.json belongs to another profile; rerun vm-run.mjs');
const measured=new Map(pass1.positives.map(p=>[p.name,p.inputs]));
useBudgets((name,n)=>{const m=measured.get(name);if(!m||m.length!==n) throw new Error('no full measurement for '+name);return m.map(i=>i.minBudget);});
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
  const funding=c.execute.filter(i=>i>c.meta.nT);
  if(funding.length) {
    const i=funding[0],sig=c.tx.inputs[i].sigscript,flipped=sig.slice(0,10)+(sig[10]==='0'?'1':'0')+sig.slice(11);
    put({...c,name:`${c.name} | funding input ${i} signature byte flipped`,expect:'fail',limited:true,execute:[i],
      tx:{...c.tx,inputs:c.tx.inputs.map((v,k)=>k===i?{...v,sigscript:flipped}:v)}},{kind:'sig-control',base:c.name,input:i});
    put({...c,name:`${c.name} | transaction tampered after signing (out0 value+1), funding input ${i} only`,expect:'fail',limited:true,execute:[i],
      tx:{...c.tx,outputs:c.tx.outputs.map((o,k)=>k===0?{...o,value:String(BigInt(o.value)+1n)}:o)}},{kind:'sig-control',base:c.name,input:i});
    put({...c,name:`${c.name} | funding inputs only`,expect:'pass',limited:true,execute:funding},{kind:'funding-only',base:c.name});
  }
}
closeSync(fd);
const run=spawnSync(bin,[join(out,'cases-budgets.ndjson'),join(out,'results-budgets.ndjson')],{stdio:'inherit',maxBuffer:1<<28});
if(run.error) throw run.error;
const results=readFileSync(join(out,'results-budgets.ndjson'),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const rows=[],bad=[],reasons={};
let bases=0,basesOk=0,minus=0,minusRejected=0,ctl=0,ctlOk=0;
for(const r of results) {
  const m=meta.get(r.name);
  if(m.kind==='base') {
    bases++;if(r.matches) basesOk++;else bad.push(r.name);
    const c=m.c,q=Object.fromEntries(Object.entries(c.meta.mass).map(([k,v])=>[k,BigInt(v)]));
    rows.push({scenario:r.name,module:c.meta.module,action:c.meta.action,inputs:c.tx.inputs.length,outputs:c.tx.outputs.length,
      budgets:c.meta.budgets,size:Number(q.size),computeMass:Number(q.computeMass),transientMass:Number(q.transientMass),storageMass:Number(q.storageMass),
      feeMass:Number(q.feeMass),relayFloorSompi:Number(q.relayFloor),
      overLimit:Object.entries(LIMITS).filter(([k,v])=>q[k]>v).map(([k])=>k)});
  } else if(m.kind==='sig-control'||m.kind==='funding-only') {
    ctl++;if(r.matches) ctlOk++;else bad.push(r.name);
  } else {
    minus++;
    if(r.matches) minusRejected++;else bad.push(r.name);
    const e=r.inputs.find(i=>i.input===m.input)?.limitedError??'none';reasons[e.replace(/\{.*$/,'').slice(0,40)]=(reasons[e.replace(/\{.*$/,'').slice(0,40)]??0)+1;
  }
}
const report={status:'OFFLINE_SCRIPT_ENGINE_COMMITTED_BUDGET_QUOTE_NOT_CONSENSUS_NOT_ACCEPTANCE',profileId:profile.id,
  bases:{total:bases,passUnderCommittedLimit:basesOk},budgetMinusOne:{total:minus,rejected:minusRejected,reasons},signatureControls:{total:ctl,matchedExpectation:ctlOk},problems:bad,scenarios:rows};
writeFileSync(join(out,'budget-report.json'),JSON.stringify(report,null,1)+'\n');
console.log(`bases under committed budgets: ${basesOk}/${bases}; budget-1 rejected: ${minusRejected}/${minus}; signature controls: ${ctlOk}/${ctl}; problems: ${bad.length}`);
console.log('budget-1 errors',reasons);
console.table(rows.map(r=>({scenario:r.scenario.slice(0,62),in:r.inputs,out:r.outputs,size:r.size,compute:r.computeMass,transient:r.transientMass,storage:r.storageMass,feeMass:r.feeMass,over:r.overLimit.join(',')})));
for(const b of bad.slice(0,20)) console.log('PROBLEM',b);
process.exitCode=bad.length?1:0;
