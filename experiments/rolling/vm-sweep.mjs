/** Shape sweep: how many script units does each action really need across ledger shapes and value magnitudes?
 * Usage: node experiments/rolling/vm-sweep.mjs [--quick]                 grid sweep   -> artifacts/vm/sweep-report.json
 *        node experiments/rolling/vm-sweep.mjs --random=N [--seed=S]    random shapes -> artifacts/vm/sweep-random-report.json (hold-out)
 *        node experiments/rolling/vm-sweep.mjs --only=<substring of a shape name>   re-run matching grid shapes -> artifacts/vm/sweep-only-report.json
 * Runner: $KASWIN_VM_BIN as in vm-run.mjs. Builds valid transactions per action (old shards/records/targets/funding inputs, refund cursors,
 * DRAW winner position, narrow vs wide cumulative ticket counts, small vs maximal price), executes the covenant inputs in the real engine
 * without any budget limit and records the consumed units. Empirical: a bound over the sampled shapes, not a proof.
 * Funding inputs are not signed or executed here (their cost is constant, see vm-budgets.mjs). */
import {mkdirSync,openSync,writeSync,closeSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeBase} from './vm-cases.mjs';
import {shapeCase} from './vm-shapes.mjs';
import {profile} from './fixtures.mjs';
const here=dirname(fileURLToPath(import.meta.url)),out=join(here,'artifacts','vm');
const bin=process.env.KASWIN_VM_BIN??join(here,'vm','target','release','kaswin-rolling-vm');
const arg=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const quick=process.argv.includes('--quick'),randomN=arg('random')?Number(arg('random')):0,seed=Number(arg('seed')??1);
const only=arg('only'),tag=randomN?'sweep-random':only?'sweep-only':'sweep';
mkdirSync(out,{recursive:true});
const P=[];
if(!randomN) {
  const CNTS=quick?[0,1,255]:[0,1,2,3,16,64,128,254,255],LOCALS=quick?[0,3,255]:[0,1,2,3,5,32,33,64,100,128,200,254,255];
  for(const cnt of CNTS) for(const local of LOCALS) {
    const T=cnt*256+local;
    P.push({action:'BUY',cnt,local,q:1,nf:1});
    if(T>0) {P.push({action:'CLOSE',cnt,local,variant:'sealed',nf:1},{action:'CLOSE',cnt,local,variant:'refund',nf:1});} else P.push({action:'CLOSE',cnt,local,variant:'empty',nf:1});
    if(T>=3) {
      P.push({action:'TIMEOUT',cnt,local,nf:1});
      if(cnt>0) P.push({action:'DRAW',cnt,local,winner:'old',nf:1});
      if(local>0) P.push({action:'DRAW',cnt,local,winner:'local',nf:1});
    }
  }
  for(const q of [1000,100000]) for(const [cnt,local] of [[0,0],[0,254],[255,254]]) P.push({action:'BUY',cnt,local,q,nf:1});
  // funding-input count at the corners of the ledger domain
  for(const nf of [2,4,8]) for(const [cnt,local] of [[0,0],[0,254],[255,0],[255,254]]) {
    P.push({action:'BUY',cnt,local,q:1,nf},{action:'BUY',cnt,local:255,q:1,nf},{action:'CLOSE',cnt,local:cnt+local<3?3:local,variant:'sealed',nf},{action:'CLOSE',cnt,local:Math.max(local,3),variant:'refund',nf},{action:'TIMEOUT',cnt,local:Math.max(local,3),nf});
    if(cnt>0) P.push({action:'DRAW',cnt,local:Math.max(local,3),winner:'old',nf});
    P.push({action:'DRAW',cnt,local:Math.max(local,3),winner:'local',nf});
  }
  for(const winner of [{j:0,i:0},{j:0,i:255},{j:254,i:0},{j:254,i:255},{j:255,i:0},{j:255,i:254}]) P.push({action:'DRAW',cnt:255,local:255,winner,nf:1});
  for(const cnt of quick?[1,16,255]:[1,2,3,16,17,64,128,255]) for(const local of quick?[0,2,255]:[0,1,2,3,10,100,255]) for(const k of [1,2,8,16]) {
    if(k>cnt) continue;
    for(const p of new Set([0,Math.floor((cnt-k)/2),cnt-k])) P.push({action:'PAY_OLD',cnt,local,k,p});
  }
  for(const cnt of [0,1,2,16,255]) for(const local of [3,5,10,32,100,255]) P.push({action:'PAY_SELF',cnt,local});
  for(const cnt of quick?[1,255]:[1,2,3,16,128,255]) for(const local of quick?[0,255]:[0,1,2,3,10,100,255]) for(const r of new Set([0,Math.floor(cnt/2),cnt-1])) for(const c of quick?[0,224]:[0,32,96,224])
    P.push({action:'REFUND_OLD',cnt,local,r,c});
  for(const cnt of [0,1,3,255]) for(const local of [1,3,33,34,65,100,255]) for(const c of [0,32,64,224]) for(const nf of [0,1,2,4,8]) if(c<local) P.push({action:'REFUND_SELF',cnt,local,c,nf});
  // value regimes at the largest ledgers
  for(const regime of ['wide','maxprice','wide+maxprice']) for(const [cnt,local] of [[0,255],[255,255],[255,2],[255,0]]) {
    const L=Math.min(local,254),k=Math.min(16,cnt);
    P.push({action:'BUY',cnt,local:L,q:1,nf:1,regime},{action:'BUY',cnt,local:255,q:1,nf:1,regime},{action:'CLOSE',cnt,local:Math.max(local,3),variant:'sealed',nf:1,regime},
      {action:'CLOSE',cnt,local:Math.max(local,3),variant:'refund',nf:1,regime},{action:'TIMEOUT',cnt,local:Math.max(local,3),nf:1,regime});
    if(cnt>0) P.push({action:'DRAW',cnt,local:Math.max(local,3),winner:'old',nf:1,regime},{action:'PAY_OLD',cnt,local,k,p:0,regime},{action:'PAY_OLD',cnt,local,k,p:cnt-k,regime},
      {action:'REFUND_OLD',cnt,local,r:cnt-1,c:224,regime},{action:'REFUND_OLD',cnt,local,r:0,c:0,regime});
    if(local>0) P.push({action:'DRAW',cnt,local,winner:'local',nf:1,regime});
    if(local>=3) P.push({action:'PAY_SELF',cnt,local,regime},{action:'REFUND_SELF',cnt,local,c:0,nf:1,regime});
  }
} else {
  const rnd=(a=>()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;})(seed);
  const int=(lo,hi)=>lo+Math.floor(rnd()*(hi-lo+1)),pick=a=>a[int(0,a.length-1)];
  const count=()=>{const u=rnd();return u<.5?int(0,255):u<.75?pick([0,1,2,3,254,255]):int(0,20);};
  const ACTIONS=['BUY','CLOSE','TIMEOUT','DRAW','PAY_OLD','PAY_SELF','REFUND_OLD','REFUND_SELF'],REG=['narrow','narrow','wide','maxprice','wide+maxprice'];
  for(let i=0;i<randomN;i++) {
    const action=pick(ACTIONS),cnt=count(),local=count(),regime=pick(REG),nf=int(1,8),T=cnt*256+local;
    switch(action) {
      case 'BUY': P.push({action,cnt,local,q:rnd()<.7?1:Math.floor(10**(rnd()*5)),nf,regime});break;
      case 'CLOSE': P.push({action,cnt,local,variant:T===0?'empty':pick(['sealed','refund']),nf,regime});break;
      case 'TIMEOUT': P.push({action,cnt,local,nf,regime});break;
      case 'DRAW': P.push({action,cnt,local,winner:cnt>0&&(local===0||rnd()<.5)?'old':'local',nf,regime});break;
      case 'PAY_OLD': {const k=cnt?int(1,Math.min(16,cnt)):1;P.push({action,cnt,local:rnd()<.4?int(0,2):local,k,p:rnd()<.3?cnt-k:int(0,Math.max(0,cnt-k)),regime});break;}
      case 'PAY_SELF': P.push({action,cnt,local:Math.max(3,local),regime});break;
      case 'REFUND_OLD': P.push({action,cnt,local:rnd()<.3?int(0,2):local,r:cnt?int(0,cnt-1):0,c:32*int(0,7),regime});break;
      case 'REFUND_SELF': {const l=Math.max(1,local);P.push({action,cnt,local:l,c:32*int(0,Math.floor((l-1)/32)),nf:int(0,8),regime});break;}
    }
  }
}
{const seen=new Set();for(let i=P.length-1;i>=0;i--) {const n=shapeCase(P[i]).name;if(seen.has(n)) P.splice(i,1);else seen.add(n);}}
if(only) for(let i=P.length-1;i>=0;i--) if(!shapeCase(P[i]).name.includes(only)) P.splice(i,1);
const fd=openSync(join(out,tag+'-cases.ndjson'),'w'),metas=new Map(),skipped={},skippedNames={};
let count=0;
for(const p of P) {
  const sc=shapeCase(p);
  try {
    const [f,op,o={}]=sc.mk();
    const c=makeBase(sc.name,f,op,{...o,sign:false});
    writeSync(fd,JSON.stringify(c)+'\n');metas.set(c.name,c.meta);count++;
  } catch(e) {const k=e.code??String(e.message).slice(0,40);skipped[k]=(skipped[k]??0)+1;(skippedNames[k]??=[]).push(sc.name);}
}
closeSync(fd);
console.log(`built ${count} of ${P.length} cases; skipped (invalid shapes / failed searches):`,skipped);
for(const [k,v] of Object.entries(skippedNames)) console.log('  skipped',k,v.slice(0,6));
const run=spawnSync(bin,[join(out,tag+'-cases.ndjson'),join(out,tag+'-results.ndjson')],{stdio:'inherit',maxBuffer:1<<28});
if(run.error) throw run.error;
const rows=readFileSync(join(out,tag+'-results.ndjson'),'utf8').split('\n').filter(Boolean).map(l=>{
  const r=JSON.parse(l),m=metas.get(r.name);
  return {name:r.name,ok:r.matches,params:m.params,terminal:m.terminal,nT:m.nT,nF:m.nF,ledgerBytes:m.ledgerBytes,managerUnits:r.inputs[0].usedScriptUnits,
    frozenUnits:r.inputs.slice(1).map(i=>i.usedScriptUnits),totalUnits:r.inputs.reduce((n,i)=>n+i.usedScriptUnits,0)};
});
const bad=rows.filter(r=>!r.ok);
writeFileSync(join(out,tag+'-report.json'),JSON.stringify({status:'OFFLINE_SCRIPT_ENGINE_SWEEP_EMPIRICAL_NOT_A_PROOF',profileId:profile.id,mode:randomN?{random:randomN,seed}:'grid',
  cases:rows.length,skipped,failures:bad.map(b=>b.name),rows})+'\n');
console.log(`ran ${rows.length} cases, ${bad.length} failed in the engine`);
for(const b of bad.slice(0,20)) console.log('FAILED',b.name);
process.exitCode=bad.length?1:0;
