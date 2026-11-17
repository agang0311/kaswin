/** Generate the VM cases, run them through the real kaspa-txscript engine (vm/) and summarise.
 * Usage: node experiments/rolling/vm-run.mjs [--only=<substring of a base case name>]
 * Runner binary: $KASWIN_VM_BIN, else vm/target/release/kaswin-rolling-vm (build: cargo build --release in vm/).
 * Writes artifacts/vm/{cases.ndjson,results.ndjson,report.json} (git-ignored). Offline: no node, network or real key (funding inputs are signed with a public throwaway key).
 * Scope: the script engine with a covenants context. NOT consensus: no maturity, mass, double-spend or acceptance checks. */
import {mkdirSync,openSync,writeSync,closeSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generate} from './vm-cases.mjs';
import {profile} from './fixtures.mjs';
const here=dirname(fileURLToPath(import.meta.url)),out=join(here,'artifacts','vm');
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);
const bin=process.env.KASWIN_VM_BIN??join(here,'vm','target','release','kaswin-rolling-vm');
mkdirSync(out,{recursive:true});
const meta=new Map(),fd=openSync(join(out,'cases.ndjson'),'w');
let n=0;
for(const c of generate({only})) {
  meta.set(c.name,{kind:c.meta.kind,family:c.meta.family??'base',base:c.meta.base??c.name,module:c.meta.module,action:c.meta.action,expect:c.expect,nT:c.meta.nT,nF:c.meta.nF});
  writeSync(fd,JSON.stringify(c)+'\n');n++;
}
closeSync(fd);
console.log(`generated ${n} cases (profile ${profile.id})`);
const t0=Date.now(),run=spawnSync(bin,[join(out,'cases.ndjson'),join(out,'results.ndjson')],{stdio:'inherit',maxBuffer:1<<28});
if(run.error) throw run.error;
console.log(`runner exit ${run.status}, ${((Date.now()-t0)/1000).toFixed(1)} s`);
const results=readFileSync(join(out,'results.ndjson'),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
const bump=(o,k,by=1)=>{o[k]=(o[k]??0)+by;};
const summary={bases:{total:0,passed:0},mutations:{total:0,matchedExpectation:0},byFamily:{},failReasons:{},mismatches:[],positives:[]};
for(const r of results) {
  const m=meta.get(r.name);
  if(m.kind==='base') {
    summary.bases.total++;if(r.matches) summary.bases.passed++;
    summary.positives.push({name:r.name,module:m.module,action:m.action,nT:m.nT,matches:r.matches,
      inputs:r.inputs.map(i=>({input:i.input,usedScriptUnits:i.usedScriptUnits,minBudget:i.minBudget,error:i.error}))});
  } else {
    summary.mutations.total++;if(r.matches) summary.mutations.matchedExpectation++;
    const f=summary.byFamily[m.family]??={cases:0,expectFail:0,rejected:0,rejectedByContext:0,expectPass:0,passed:0,mismatch:0};
    f.cases++;
    if(m.expect==='fail') {
      f.expectFail++;
      if(r.contextError) {f.rejectedByContext++;f.rejected++;bump(summary.failReasons,'context:'+r.contextError.slice(0,60));}
      else if(r.inputs.some(i=>!i.ok)) {f.rejected++;for(const i of r.inputs) if(!i.ok){bump(summary.failReasons,'script:'+i.error);break;}}
    } else {f.expectPass++;if(r.matches) f.passed++;}
    if(!r.matches) {f.mismatch++;}
  }
  if(!r.matches) summary.mismatches.push({name:r.name,expect:r.expect,contextError:r.contextError,inputs:r.inputs.map(i=>({input:i.input,ok:i.ok,error:i.error}))});
}
// Budget table: the largest measured consumption per module/action over the passing base cases.
const budget={};
for(const p of summary.positives) if(p.matches) {
  const k=`${p.module}:${p.action}`,b=budget[k]??={cases:0,maxManagerUnits:0,maxManagerBudget:0,maxFrozenUnits:0,maxFrozenBudget:0,maxFundingUnits:0,maxFundingBudget:0};
  b.cases++;
  for(const i of p.inputs) {
    const f=i.input===0?['maxManagerUnits','maxManagerBudget']:i.input<=p.nT?['maxFrozenUnits','maxFrozenBudget']:['maxFundingUnits','maxFundingBudget'];
    b[f[0]]=Math.max(b[f[0]],i.usedScriptUnits);b[f[1]]=Math.max(b[f[1]],i.minBudget);
  }
}
summary.budgetByAction=budget;
const report={status:'OFFLINE_SCRIPT_ENGINE_COVENANT_CONTEXT_NOT_CONSENSUS_NOT_ACCEPTANCE',profileId:profile.id,cases:n,...summary};
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,1)+'\n');
console.log(`bases: ${summary.bases.passed}/${summary.bases.total} pass; mutations: ${summary.mutations.matchedExpectation}/${summary.mutations.total} match expectation; mismatches: ${summary.mismatches.length}`);
console.table(summary.byFamily);
console.table(budget);
console.log('rejection reasons',summary.failReasons);
for(const x of summary.mismatches.slice(0,40)) console.log('MISMATCH',JSON.stringify(x).slice(0,400));
if(summary.mismatches.length>40) console.log(`... ${summary.mismatches.length-40} more in report.json`);
process.exitCode=summary.mismatches.length?1:0;
