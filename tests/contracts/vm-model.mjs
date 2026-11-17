/** Empirical worst-case budget model fitted on the shape sweep (vm-sweep.mjs), checked on a random hold-out sweep.
 * Usage: node tests/contracts/vm-model.mjs [grid-report.json] [holdout-report.json]
 *   defaults: artifacts/vm/sweep-report.json and artifacts/vm/sweep-random-report.json (optional). Writes artifacts/vm/budget-model.json.
 * Per action class (the contract branch that actually runs: terminal or not, freeze or not, winner in an old shard or the local shard, ...)
 * managerUnits ~ beta . features(cnt, local, k, batch, nF ...), fitted by least squares on the grid. The published bound adds the largest
 * positive grid residual plus 1 % of the class maximum, so it covers every grid point by construction; the hold-out then tests
 * shapes the fit never saw. Frozen-shard inputs are modelled as a + b*managerLedgerBytes; funding inputs are constant (Schnorr).
 * EMPIRICAL: a bound over sampled shapes inside the box cnt<=255, local<=255, k<=16, nF<=8 - not a proof, not consensus acceptance. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),vm=join(here,'artifacts','vm');
const gridPath=process.argv[2]??join(vm,'sweep-report.json'),holdPath=process.argv[3]??join(vm,'sweep-random-report.json');
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const grid=load(gridPath).rows,hold=existsSync(holdPath)?load(holdPath).rows:[];
const FREE=9999,PER=10000,budgetOf=u=>Math.max(0,Math.ceil((u-FREE)/PER));
const reg=x=>x.params.regime??'narrow',T=p=>p.cnt*256+p.local,batchOf=p=>{const end=Math.min(p.c+32,p.local);return end-p.c;};
/** name, sel(p,x), names[], f(p,x), corner (worst box corner for the reported maximum) */
const CLASSES=[
  {name:'BUY plain',   sel:(p,x)=>p.action==='BUY'&&p.local<255,                 names:['1','cnt','local','nF'],           f:(p,x)=>[1,p.cnt,p.local,x.nF],    corner:{cnt:255,local:254,nF:8}},
  {name:'BUY freeze',  sel:(p,x)=>p.action==='BUY'&&p.local===255,               names:['1','cnt','nF'],                   f:(p,x)=>[1,p.cnt,x.nF],            corner:{cnt:255,local:255,nF:8}},
  {name:'CLOSE sealed',sel:(p,x)=>p.action==='CLOSE'&&p.variant==='sealed'&&T(p)>=3,names:['1','cnt','local','nF'],         f:(p,x)=>[1,p.cnt,p.local,x.nF],    corner:{cnt:255,local:255,nF:8}},
  {name:'CLOSE refund',sel:(p,x)=>p.action==='CLOSE'&&(p.variant==='refund'||(p.variant==='sealed'&&T(p)<3)),names:['1','cnt','local','nF'],f:(p,x)=>[1,p.cnt,p.local,x.nF],corner:{cnt:255,local:255,nF:8}},
  {name:'TIMEOUT',     sel:(p,x)=>p.action==='TIMEOUT',                          names:['1','cnt','local','nF'],           f:(p,x)=>[1,p.cnt,p.local,x.nF],    corner:{cnt:255,local:255,nF:8}},
  {name:'DRAW old',    sel:(p,x)=>p.action==='DRAW'&&p.winner!=='local'&&(p.winner==='old'||p.winner.j<p.cnt),names:['1','cnt','local','nF'],f:(p,x)=>[1,p.cnt,p.local,x.nF],corner:{cnt:255,local:255,nF:8}},
  {name:'DRAW local',  sel:(p,x)=>p.action==='DRAW'&&(p.winner==='local'||(p.winner.j??-1)===p.cnt),names:['1','cnt','local','nF'],f:(p,x)=>[1,p.cnt,p.local,x.nF],corner:{cnt:255,local:255,nF:8}},
  {name:'PAY_OLD',     sel:(p,x)=>p.action==='PAY_OLD'&&!x.terminal,             names:['1','cnt','local','k','k*cnt','k*local'],f:(p,x)=>[1,p.cnt,p.local,p.k,p.k*p.cnt,p.k*p.local],corner:{cnt:255,local:255,k:16}},
  {name:'PAY_OLD merge-final',sel:(p,x)=>p.action==='PAY_OLD'&&x.terminal,       names:['1','cnt','local','k','k*cnt'],    f:(p,x)=>[1,p.cnt,p.local,p.k,p.k*p.cnt],corner:{cnt:255,local:2,k:16}},
  {name:'PAY_SELF',    sel:(p,x)=>p.action==='PAY_SELF',                         names:['1','cnt','local'],                f:(p,x)=>[1,p.cnt,p.local],         corner:{cnt:255,local:255}},
  {name:'REFUND_OLD',  sel:(p,x)=>p.action==='REFUND_OLD'&&p.c<224,              names:['1','cnt','local','c','r'],        f:(p,x)=>[1,p.cnt,p.local,p.c,p.r],corner:{cnt:255,local:255,c:192,r:254}},
  {name:'REFUND_OLD last-batch',sel:(p,x)=>p.action==='REFUND_OLD'&&p.c===224&&!x.terminal,names:['1','cnt','local','r'],f:(p,x)=>[1,p.cnt,p.local,p.r],corner:{cnt:255,local:255,r:254}},
  {name:'REFUND_OLD final',sel:(p,x)=>p.action==='REFUND_OLD'&&x.terminal,        names:['1','cnt','local'],                f:(p,x)=>[1,p.cnt,p.local],         corner:{cnt:255,local:2}},
  {name:'REFUND_SELF', sel:(p,x)=>p.action==='REFUND_SELF'&&!x.terminal,          names:['1','cnt','local','batch','batch*cnt','c>0','nF'],f:(p,x)=>[1,p.cnt,p.local,batchOf(p),batchOf(p)*p.cnt,p.c>0?1:0,x.nF],corner:{cnt:255,local:255,batch:32,c:64,nF:8}},
  {name:'REFUND_SELF final',sel:(p,x)=>p.action==='REFUND_SELF'&&x.terminal,     names:['1','cnt','local','batch','batch*cnt','nF'],f:(p,x)=>[1,p.cnt,p.local,batchOf(p),batchOf(p)*p.cnt,x.nF],corner:{cnt:255,local:255,batch:32,nF:8}},
];
function lsq(X,y) {
  const n=X[0].length,A=Array.from({length:n},()=>Array(n+1).fill(0));
  X.forEach((x,k)=>{for(let i=0;i<n;i++){for(let j=0;j<n;j++)A[i][j]+=x[i]*x[j];A[i][n]+=x[i]*y[k];}});
  for(let i=0;i<n;i++) A[i][i]+=1e-6;
  for(let i=0;i<n;i++) {
    let p=i;for(let k=i+1;k<n;k++) if(Math.abs(A[k][i])>Math.abs(A[p][i])) p=k;
    [A[i],A[p]]=[A[p],A[i]];
    for(let k=0;k<n;k++) {if(k===i) continue;const f=A[k][i]/A[i][i];for(let j=i;j<=n;j++) A[k][j]-=f*A[i][j];}
  }
  return A.map((row,i)=>row[n]/row[i]);
}
const classOf=x=>CLASSES.find(c=>c.sel(x.params,x))??(x.params.action==='CLOSE'&&x.params.variant==='empty'?CLASSES.find(c=>c.name==='CLOSE refund'):null);
const dot=(f,b)=>f.reduce((s,a,i)=>s+a*b[i],0);
const model={status:'OFFLINE_SCRIPT_ENGINE_EMPIRICAL_BUDGET_MODEL_NOT_A_PROOF',grid:{path:'sweep-report.json',rows:grid.length},holdout:{rows:hold.length},unit:{freeUnitsPerInput:FREE,scriptUnitsPerBudget:PER},classes:{},problems:[]};
for(const x of [...grid,...hold]) if(!classOf(x)) model.problems.push('unclassified: '+x.name);
const pad=(s,n)=>String(s).padStart(n);
console.log('class'.padEnd(24),'grid','hold','  max observed','   offset','  bound@corner','  hold worst obs/bound','viol');
for(const c of CLASSES) {
  const g=grid.filter(x=>c.sel(x.params,x)),h=hold.filter(x=>c.sel(x.params,x)),covered=[...grid,...hold].filter(x=>classOf(x)===c&&!c.sel(x.params,x));   // covered: checked against the bound, not fitted
  if(g.length<c.names.length+2) {model.problems.push(`${c.name}: only ${g.length} grid rows`);console.log(c.name.padEnd(24),pad(g.length,4),'too few rows');continue;}
  const beta=lsq(g.map(x=>c.f(x.params,x)),g.map(x=>x.managerUnits));
  const res=g.map(x=>x.managerUnits-dot(c.f(x.params,x),beta)),maxObs=Math.max(...g.map(x=>x.managerUnits));
  const span=r=>r.length?[Math.round(Math.min(...r)),Math.round(Math.max(...r))]:null,isNarrow=x=>reg(x)==='narrow';
  const resNarrow=span(res.filter((r,i)=>isNarrow(g[i]))),resValue=span(res.filter((r,i)=>!isNarrow(g[i])));   // value regimes (wide / maxprice) vs the narrow rows, same fit
  const offset=Math.ceil(Math.max(0,...res)+0.01*maxObs);
  const bound=x=>Math.ceil(dot(c.f(x.params,x),beta))+offset;
  const cornerRow={params:{action:'',cnt:0,local:0,k:0,c:0,r:0,...c.corner},nF:c.corner.nF??0,terminal:false};
  const atCorner=bound(cornerRow);
  const viol=[...g,...h,...covered].filter(x=>x.managerUnits>bound(x));
  const worstHold=h.length?Math.max(...h.map(x=>x.managerUnits/bound(x))):null;
  model.classes[c.name]={features:c.names,beta:beta.map(b=>+b.toFixed(3)),offset,gridRows:g.length,holdoutRows:h.length,maxObservedUnits:Math.max(maxObs,...h.map(x=>x.managerUnits)),
    boundAtCornerUnits:atCorner,boundAtCornerBudget:budgetOf(atCorner),corner:c.corner,minResidual:Math.round(Math.min(...res)),maxResidual:Math.round(Math.max(...res)),residualNarrow:resNarrow,residualValueRegimes:resValue,
    holdoutWorstRatio:worstHold,violations:viol.map(x=>x.name)};
  if(viol.length) model.problems.push(`${c.name}: ${viol.length} rows exceed the bound (e.g. ${viol[0].name})`);
  console.log(c.name.padEnd(24),pad(g.length,4),pad(h.length,4),pad(Math.max(maxObs,...h.map(x=>x.managerUnits)),14),pad(offset,9),pad(atCorner,14),pad(worstHold===null?'-':worstHold.toFixed(4),22),viol.length);
}
// frozen-shard inputs (PAY_OLD / REFUND_OLD targets): fitted on the grid, checked on grid + hold-out
for(const action of ['PAY_OLD','REFUND_OLD']) {
  const pts=rows=>rows.filter(x=>x.params.action===action&&x.frozenUnits.length).flatMap(x=>x.frozenUnits.map(u=>({L:x.ledgerBytes,u})));
  const g=pts(grid),h=pts(hold),n=g.length,sx=g.reduce((s,p)=>s+p.L,0),sy=g.reduce((s,p)=>s+p.u,0),sxx=g.reduce((s,p)=>s+p.L*p.L,0),sxy=g.reduce((s,p)=>s+p.L*p.u,0);
  const b=(n*sxy-sx*sy)/(n*sxx-sx*sx),a=(sy-b*sx)/n,off=Math.ceil(Math.max(0,...g.map(p=>p.u-(a+b*p.L)))+0.01*Math.max(...g.map(p=>p.u)));
  const worst=Math.max(...[...g,...h].map(p=>p.u/(a+b*p.L+off)));
  model.classes[`frozen input (${action})`]={model:'a + b*managerLedgerBytes',a:+a.toFixed(2),b:+b.toFixed(4),offset:off,gridPoints:n,holdoutPoints:h.length,worstRatio:worst,maxObservedUnits:Math.max(...[...g,...h].map(p=>p.u))};
  if(worst>1) model.problems.push(`frozen input (${action}) exceeds its bound`);
  console.log(`frozen input (${action})`.padEnd(30),`${a.toFixed(0)} + ${b.toFixed(3)}*bytes + ${off}  grid=${n} hold-out=${h.length} max obs/bound=${worst.toFixed(4)}`);
}
// per action: manager bound at the box corner, frozen bound at the largest ledger, and the compute mass if every input got these budgets
model.actions={};
for(const [name,c] of Object.entries(model.classes)) {
  if(!c.corner) continue;
  const act=name.split(' ')[0],m=model.actions[act]??={managerBoundUnits:0};
  if(c.boundAtCornerUnits>m.managerBoundUnits) {m.managerBoundUnits=c.boundAtCornerUnits;m.worstClass=name;}
}
for(const [act,m] of Object.entries(model.actions)) {
  m.managerBudget=budgetOf(m.managerBoundUnits);
  m.maxLedgerBytes=Math.max(...grid.filter(x=>x.params.action===act).map(x=>x.ledgerBytes));
  const fz=model.classes[`frozen input (${act})`];
  if(fz) {m.frozenBoundUnits=Math.ceil(fz.a+fz.b*m.maxLedgerBytes)+fz.offset;m.frozenBudget=budgetOf(m.frozenBoundUnits);}
}
const FUNDING_BUDGET=10;   // measured constant (vm-budgets.mjs): 100,001 script units per P2PK input
const budgetPath=join(vm,'budget-report.json');
if(existsSync(budgetPath)) {
  const sc=load(budgetPath).scenarios,worst={};
  for(const s of sc) {
    const m=model.actions[s.action];if(!m) continue;
    const rest=Array(s.inputs-1).fill(m.frozenBudget??FUNDING_BUDGET),newBudgets=[m.managerBudget,...rest];
    const oldSum=s.budgets.reduce((a,b)=>a+b,0),newSum=newBudgets.reduce((a,b)=>a+b,0);
    const compute=s.computeMass-100*oldSum+100*newSum;
    if(!worst[s.action]||compute>worst[s.action].computeMassBoundBudgets) worst[s.action]={scenario:s.scenario,computeMassMeasuredBudgets:s.computeMass,computeMassBoundBudgets:compute,budgetSum:newSum};
  }
  for(const [act,w] of Object.entries(worst)) model.actions[act].worstComputeMass=w;
}
console.log('\naction'.padEnd(14),'manager bound','budget','frozen bound','budget','compute mass (bound budgets, worst of 48 scenarios, limit 500,000)');
for(const [act,m] of Object.entries(model.actions)) console.log(act.padEnd(13),pad(m.managerBoundUnits,13),pad(m.managerBudget,6),pad(m.frozenBoundUnits??'-',12),pad(m.frozenBudget??'-',6),m.worstComputeMass?`${m.worstComputeMass.computeMassBoundBudgets} (measured budgets ${m.worstComputeMass.computeMassMeasuredBudgets}) ${m.worstComputeMass.scenario}`:'');
console.log('problems:',model.problems.length?model.problems:'none');
writeFileSync(join(vm,'budget-model.json'),JSON.stringify(model,null,1)+'\n');
process.exitCode=model.problems.length?1:0;
