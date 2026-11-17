/** Positive bases and single-fault mutations for the rolling templates, as cases for the Rust script-engine runner (vm/).
 * Offline. Every base is built by the real JS builder from the real compiled artifacts; every mutation changes ONE thing
 * (some outputs are coupled by value conservation, noted in the label). A "fail" case is evidence only when its base passes.
 * Funding (P2PK) inputs are signed with a public throwaway key (see FUNDER_SK below) and executed too, so the page's JS Schnorr signer and sighash are checked by the engine. */
import {S,profile,fixture,fund,quote,findDraw,shard,p2pk,p2sh,PRICE,KAS,FEE,ACTOR,id} from './fixtures.mjs';
import {ABI} from './profile.mjs';
import {ACTION} from './transactions.mjs';
import {scriptPushes,scriptNumber} from '../../scripts/core/lib/accepted.js';
import {pushInt} from '../../scripts/core/lib/builders.js';
import {pushBytes,scriptFor} from '../../scripts/core/lib/state.js';
import {blake2b256} from '../../scripts/core/lib/hashes.js';
import {schnorrSign,xonlyPubkey} from '../../scripts/wallet/schnorr.mjs';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {createHash} from 'node:crypto';
const {cat,hex,unhex,le}=S;
const KAS10=10n*KAS,OTHER='ee'.repeat(32);
// Deterministic PUBLIC throwaway key, same convention as tests/redteam/baseline.mjs: derived from a label, never funded, never a wallet.
// It signs the funding (P2PK) inputs of the base transactions so the real engine can check the page's JS Schnorr signer and sighash.
const FUNDER_SK=new Uint8Array(createHash('sha256').update('kaswin-rolling-vm-throwaway-key:funder').digest()),FUNDER=hex(xonlyPubkey(FUNDER_SK));
export const FUNDER_KEY=FUNDER;
const F=(n,v)=>fund(n,v,FUNDER);
const SINK={BUY:'CHANGE',CLOSE:'CHANGE',DRAW:'CHANGE',TIMEOUT:'CHANGE',PAY_OLD:'WINNER',PAY_SELF:'WINNER',REFUND_OLD:'EXECUTOR',REFUND_SELF:'EXECUTOR'};
const CAP=a=>a.startsWith('PAY')?S.PAY_FEE_CAP:S.FEE_CAP;
const flip=(h,b,bit=1)=>{const i=b*2,v=(parseInt(h.slice(i,i+2),16)^bit).toString(16).padStart(2,'0');return h.slice(0,i)+v+h.slice(i+2);};
// ---- signature-script tokens (ABI-typed), so single arguments can be mutated and re-encoded ----
function pushNum(n) {
  if(n>=0n) return pushInt(n);
  let m=-n;const a=[];while(m) {a.push(Number(m&255n));m>>=8n;}
  if(a.at(-1)&128) a.push(128);else a[a.length-1]|=128;
  return pushBytes(Uint8Array.from(a));
}
function decode(sigHex,module) {
  const pushes=scriptPushes(unhex(sigHex)),spec=ABI[module];
  if(pushes.length!==spec.length+2) throw new Error('unexpected sigscript shape for '+module);
  return {toks:spec.map(([name,type],i)=>({name,type,v:type==='int'?scriptNumber(pushes[i]):pushes[i]})),tag:pushes.at(-2),raw:pushes.at(-1)};
}
const enc=t=>hex(cat(...t.toks.map(k=>k.type==='int'?pushNum(k.v):pushBytes(k.v)),pushBytes(t.tag),pushBytes(t.raw)));
const tok=(t,name)=>t.toks.find(k=>k.name===name);
function splitRaw(raw) {
  if(raw[0]!==0x6b) throw new Error('not a ledger script');
  const op=raw[1],[n,at]=op===0x4c?[raw[2],3]:op===0x4d?[raw[2]|raw[3]<<8,4]:[op,2];
  return {ledger:raw.slice(at,at+n),tail:raw.slice(at+n)};
}
// ---- case assembly ----
function toCase(name,d,{execute,seq,meta}) {
  const t=d.transaction;
  return {name,expect:'pass',meta,execute,seq,
    tx:{version:t.version,lockTime:String(t.lockTime),subnetworkId:t.subnetworkId,gas:String(t.gas),payload:t.payload,
      inputs:t.inputs.map(i=>({txid:i.previousOutpoint.transactionId,index:i.previousOutpoint.index,sigscript:i.signatureScript,sequence:String(i.sequence),computeBudget:i.computeBudget??0})),
      outputs:t.outputs.map(o=>({value:String(o.value),spkVersion:o.scriptPublicKey.version,spk:o.scriptPublicKey.script,covenant:o.covenant?{authorizingInput:o.covenant.authorizingInput,covenantId:o.covenant.covenantId}:null}))},
    utxos:d.inputUtxos.map(u=>({value:String(u.value),spkVersion:u.spk.version,spk:u.spk.script,daa:String(u.utxoDaa),covenantId:u.covenantId??null}))};
}
const names=new Set();
let budgetFor=null;
/** Pass 2: fn(caseName, inputCount) -> committed compute budget per input. Default: 65535 everywhere (budget never limits the run). */
export const useBudgets=fn=>{budgetFor=fn;};
export {base as makeBase};
function base(name,f,op,{targets=[],funds=[],fee=FEE,full=false,header=false,sign=true,extra={}}={}) {
  if(names.has(name)) throw new Error('duplicate case name '+name);names.add(name);
  const nIn=1+targets.length+funds.length,budgets=budgetFor?budgetFor(name,nIn):Array(nIn).fill(65535);
  const {d,q}=quote(f,{...op,actorKey:FUNDER},{targets,funds,fee,budgets});
  if(sign) {const tx=d.transaction,utxos=d.inputUtxos.map(u=>({value:u.value,spk:u.spk}));
    for(const i of d.authorizedInputIndices) tx.inputs[i].signatureScript='41'+hex(schnorrSign(FUNDER_SK,schnorrSighash(tx,utxos,i)))+'01';}
  const sinkIdx=d.roles.indexOf(SINK[op.action]);if(sinkIdx<0) throw new Error('no fee sink output in '+name);
  const c=toCase(name,d,{execute:[...Array(sign?nIn:1+targets.length).keys()],
    seq:op.accessor?[{blockHash:op.accessor.blockHash,commitment:op.accessor.sequenceCommitment}]:[],
    meta:{kind:'base',module:f.s.module,action:op.action,roles:d.roles,fee:String(fee),cap:String(CAP(op.action)),sinkIdx,nT:targets.length,nF:funds.length,
      cid:f.manager.cid,lockTime:String(d.transaction.lockTime),full,header,heavy:targets.length>=8,local:S.recordTotal(f.s.records),total:S.totalTickets(f.s),
      terminal:d.transition.terminal!==null,budgets,ledgerBytes:f.manager.redeemScript.length,cnt:f.s.indices.length,records:f.s.records.length,...extra,
      mass:Object.fromEntries(['size','computeMass','transientMass','storageMass','feeMass','orderingMass','relayFloor'].map(k=>[k,String(q[k])]))}});
  for(const i of [...Array(1+targets.length).keys()]) {const m=i===0?f.s.module:'frozen',s=d.transaction.inputs[i].signatureScript;
    if(enc(decode(s,m))!==s) throw new Error('sigscript round trip failed: '+name+' input '+i);}
  return c;
}
const clone=c=>({...c,tx:{...c.tx,inputs:c.tx.inputs.map(i=>({...i})),outputs:c.tx.outputs.map(o=>({...o}))},utxos:c.utxos.map(u=>({...u}))});
function V(c,family,label,expect,fn) {
  const x=clone(c);x.execute=c.execute.filter(i=>i<=c.meta.nT);if(fn(x)===false) return null;
  x.name=`${c.name} | ${label}`;x.expect=expect;x.meta={...c.meta,kind:'mutation',base:c.name,family};
  if(names.has(x.name)) throw new Error('duplicate case name '+x.name);names.add(x.name);return x;
}
function positions(len,full,extra=[]) {
  if(full) return [...Array(len).keys()];
  return [...new Set([0,1,len>>1,len-1,...extra])].filter(p=>p>=0&&p<len).sort((a,b)=>a-b);
}
const big=v=>BigInt(v);
function mutate(c) {
  const acc=[],m=c.meta,n=c.tx.outputs.length,sink=m.sinkIdx,cid=m.cid,nIn=c.tx.inputs.length,fi=1+m.nT;
  const add=(fam,label,expect,fn)=>{const x=V(c,fam,label,expect,fn);if(x) acc.push(x);};
  const setOut=(x,i,p)=>{x.tx.outputs[i]={...x.tx.outputs[i],...p};};
  const sample=n<=8?[...Array(n).keys()]:[0,1,2,n>>1,n-3,n-2,n-1];
  // outputs: each pinned output is lowered/raised by one sompi, redirected, rebound or dropped
  for(const i of sample) {
    const role=m.roles[i],o=c.tx.outputs[i],tag=`out${i}(${role})`;
    if(i!==sink) {
      add('out-value',`${tag} value-1 (fee+1)`,'fail',x=>setOut(x,i,{value:String(big(o.value)-1n)}));
      add('out-value',`${tag} value+1 (fee-1)`,'fail',x=>setOut(x,i,{value:String(big(o.value)+1n)}));
    }
    if(o.covenant) {
      add('out-spk',`${tag} p2sh hash byte flipped`,'fail',x=>setOut(x,i,{spk:flip(o.spk,5)}));
      add('out-cov',`${tag} covenant binding removed`,'fail',x=>setOut(x,i,{covenant:null}));
      add('out-cov',`${tag} covenant id flipped`,'fail',x=>setOut(x,i,{covenant:{...o.covenant,covenantId:flip(o.covenant.covenantId,0)}}));
      if(nIn>1) add('out-cov',`${tag} authorizing input 1`,'fail',x=>setOut(x,i,{covenant:{...o.covenant,authorizingInput:1}}));
    } else {
      // chosenPayment (CHANGE / EXECUTOR) checks value, a 32-byte Schnorr P2PK form and no covenant, never the key: the key is the
      // funder's or executor's own choice. Every other payment output is pinned to a ledger key.
      const free=m.roles[i]==='CHANGE'||m.roles[i]==='EXECUTOR';
      add('out-spk',`${tag} pays another key${free?' (key not pinned by design)':''}`,free?'pass':'fail',x=>setOut(x,i,{spk:p2pk(OTHER).script}));
      if(free) add('out-spk',`${tag} pays a P2SH script instead of Schnorr P2PK`,'fail',x=>setOut(x,i,{spk:p2sh(OTHER).script}));
      add('out-cov',`${tag} covenant binding added`,'fail',x=>setOut(x,i,{covenant:{authorizingInput:0,covenantId:cid}}));
    }
  }
  // output count: drop a pinned output (its value moves to the sink) / add a 1-sompi output (taken from the sink)
  const pinned=[...Array(n).keys()].filter(i=>i!==sink),drops=[...new Set([pinned[0],pinned.at(-1)])].filter(i=>i!==undefined);
  for(const i of drops) add('out-count',`drop out${i}(${m.roles[i]}), value moved to sink`,'fail',x=>{
    const o=x.tx.outputs[i];x.tx.outputs.splice(i,1);const s=sink>i?sink-1:sink;
    setOut(x,s,{value:String(big(x.tx.outputs[s].value)+big(o.value))});});
  add('out-count','extra 1-sompi P2PK output (taken from sink)','fail',x=>{
    const s=x.tx.outputs[sink];if(big(s.value)<=1n) return false;setOut(x,sink,{value:String(big(s.value)-1n)});
    x.tx.outputs.push({value:'1',spkVersion:0,spk:p2pk(ACTOR).script,covenant:null});});
  // input-0 signature script: every argument
  const sig0=(label,expect,fn)=>add('sig',label,expect,x=>{const t=decode(x.tx.inputs[0].sigscript,m.module);if(fn(t)===false) return false;x.tx.inputs[0].sigscript=enc(t);});
  const t0=decode(c.tx.inputs[0].sigscript,m.module);
  for(const k of t0.toks) {
    const set=(label,v)=>sig0(`${k.name}=${label}`,'fail',t=>{tok(t,k.name).v=v;});
    if(k.type==='int') {
      const vals=k.name==='action'?[...new Set([...Object.values(ACTION),0,3,255])].map(big).filter(a=>a!==k.v):
        [k.v+1n,k.v>0n?k.v-1n:null,k.v===0n?null:0n,-1n,1n<<62n];
      for(const v of vals) if(v!==null&&v!==k.v) set(String(v),v);
    } else if(k.name==='originTxId') {
      for(const b of [0,31]) sig0(`originTxId byte ${b} flipped`,'fail',t=>{const v=tok(t,k.name).v.slice();v[b]^=1;tok(t,k.name).v=v;});
    } else if(k.name==='nextTail') {
      const v=k.v;
      if(v.length) {
        set('empty',new Uint8Array());
        set('last byte dropped',v.slice(0,-1));
        for(const b of [1,v.length-1]) sig0(`nextTail byte ${b} flipped`,'fail',t=>{const w=v.slice();w[b]^=1;tok(t,k.name).v=w;});
      }
      set('one byte appended',cat(v,Uint8Array.of(0)));
    } else if(k.name==='data') {
      const v=k.v,isDraw=m.action==='DRAW',ex=isDraw?[31,96,104,112,216,224,232,239,240,242,244,248]:[];
      for(const b of positions(v.length,m.full&&!isDraw,ex)) sig0(`data byte ${b} flipped`,'fail',t=>{const w=v.slice();w[b]^=1;tok(t,k.name).v=w;});
      if(isDraw&&m.full) for(let b=0;b<240;b++) if(!positions(v.length,false,ex).includes(b)) sig0(`data byte ${b} flipped`,'fail',t=>{const w=v.slice();w[b]^=1;tok(t,k.name).v=w;});
      if(v.length) {set('empty',new Uint8Array());set('last byte dropped',v.slice(0,-1));}
      set('one byte appended',cat(v,Uint8Array.of(0)));
      if(m.action==='BUY') {
        set('quantity=0',cat(le(0n,4),v.slice(4)));
        set('quantity=2^32-1',cat(le(0xffffffffn,4),v.slice(4)));
      }
    } else if(k.name==='targetSizes') {
      const v=k.v,cnt=v.length/4,at=[...new Set([0,cnt>>1,cnt-1])].filter(i=>i>=0&&i<cnt);
      const put=(i,x)=>cat(v.slice(0,4*i),le(x,4),v.slice(4*i+4));
      for(const i of at) {
        const cur=BigInt(S.fromLe(v.slice(4*i,4*i+4)));
        set(`size[${i}]+1`,put(i,cur+1n));set(`size[${i}]-1`,put(i,cur-1n));set(`size[${i}]=0`,put(i,0n));set(`size[${i}]=2^32-1`,put(i,0xffffffffn));
      }
      if(v.length) {set('last entry dropped',v.slice(0,-4));set('truncated by 1 byte',v.slice(0,-1));}
      set('entry appended',cat(v,le(1n,4)));
    }
  }
  for(const b of [0]) sig0(`dispatch tag byte ${b} flipped`,'fail',t=>{const w=t.tag.slice();w[b]^=1;t.tag=w;});
  // redeem script that no longer matches the spent P2SH hash (engine-level hash check, not covenant logic)
  const raw0=t0.raw;
  for(const [label,fn] of [['redeem ledger byte flipped',r=>{const w=r.slice();w[5]^=1;return w;}],['redeem last byte flipped',r=>{const w=r.slice();w[w.length-1]^=1;return w;}],
    ['redeem last byte dropped',r=>r.slice(0,-1)],['redeem byte appended',r=>cat(r,Uint8Array.of(0))]])
    sig0(label+' (P2SH hash mismatch)','fail',t=>{t.raw=fn(raw0);});
  // covenant inputs: funding input carrying a covenant id, extra funding input, target substitution
  if(m.nF>0) add('inputs',`funding input ${fi} carries the covenant id`,'fail',x=>{x.utxos[fi]={...x.utxos[fi],covenantId:cid};});
  if(['BUY','CLOSE','DRAW','TIMEOUT','REFUND_SELF'].includes(m.action)) {
    const nine=m.nF>=8,label=nine?'9th funding input (limit is 8)':`funding input #${m.nF+1} (+1 sompi to sink)`;
    add('inputs',label,nine?'fail':'pass',x=>{
      x.tx.inputs.push({txid:id(9000),index:0,sigscript:'',sequence:'0',computeBudget:0});
      x.utxos.push({value:'1',spkVersion:0,spk:p2pk(ACTOR).script,daa:'0',covenantId:null});
      setOut(x,sink,{value:String(big(x.tx.outputs[sink].value)+1n)});});
  }
  if(m.nT>=2) add('inputs','targets 1 and 2 swapped','fail',x=>{
    [x.tx.inputs[1],x.tx.inputs[2]]=[x.tx.inputs[2],x.tx.inputs[1]];[x.utxos[1],x.utxos[2]]=[x.utxos[2],x.utxos[1]];});
  if(m.nT>=1) {
    add('inputs','target 1 replaced by another valid frozen shard','fail',x=>{
      const other=shard(900),t=decode(x.tx.inputs[1].sigscript,'frozen');t.raw=other.redeem;x.tx.inputs[1].sigscript=enc(t);
      x.utxos[1]={...x.utxos[1],spk:p2sh(other.hash).script};});
    add('inputs','target 1 covenant id cleared','fail',x=>{x.utxos[1]={...x.utxos[1],covenantId:null};});
    add('inputs','target 1 covenant id flipped','fail',x=>{x.utxos[1]={...x.utxos[1],covenantId:flip(cid,0)};});
    for(const [label,fn] of [['managerRedeemBytes+1',v=>v+1n],['managerRedeemBytes-1',v=>v-1n],['managerRedeemBytes=0',()=>0n]])
      add('inputs',`target 1 ${label}`,'fail',x=>{const t=decode(x.tx.inputs[1].sigscript,'frozen');tok(t,'managerRedeemBytes').v=fn(tok(t,'managerRedeemBytes').v);x.tx.inputs[1].sigscript=enc(t);});
    for(const [label,fn] of [['managerTailBytes+1',v=>v+1n],['managerTailBytes-1',v=>v-1n],['managerTailBytes=0',()=>0n]])
      add('inputs',`target 1 ${label}`,'fail',x=>{const t=decode(x.tx.inputs[1].sigscript,'frozen');tok(t,'managerTailBytes').v=fn(tok(t,'managerTailBytes').v);x.tx.inputs[1].sigscript=enc(t);});
  }
  // time bounds (script-level only: the engine does not check maturity against the DAA score)
  if(m.action==='DRAW') for(const [s,e] of [[99n,'fail'],[0n,'fail'],[101n,'pass']]) add('time',`input 0 sequence=${s}`,e,x=>{x.tx.inputs[0].sequence=String(s);});
  if(m.action==='TIMEOUT') for(const [s,e] of [[431999n,'fail'],[0n,'fail'],[432001n,'pass']]) add('time',`input 0 sequence=${s}`,e,x=>{x.tx.inputs[0].sequence=String(s);});
  if(m.action==='CLOSE'&&big(m.lockTime)>0n) for(const v of [big(m.lockTime)-1n,0n]) add('time',`lockTime=${v}`,'fail',x=>{x.tx.lockTime=String(v);});
  // fee boundary through the sink output: contract rule is 0 < fee <= cap
  {
    const fee=big(m.fee),cap=big(m.cap),sv=big(c.tx.outputs[sink].value);
    for(const [nf,e,l] of [[cap,'pass','at cap'],[cap+1n,'fail','cap+1'],[1n,'pass','1 sompi'],[0n,'fail','zero']]) {
      if(nf===fee) continue;
      add('fee',`fee=${nf} (${l}) via sink out${sink}`,e,x=>{const v=sv-(nf-fee);if(v<=0n) return false;setOut(x,sink,{value:String(v)});});
    }
  }
  // chain accessor of DRAW
  if(m.action==='DRAW') {
    add('seq','sequence commitment flipped','fail',x=>{x.seq=[{...x.seq[0],commitment:flip(x.seq[0].commitment,0)}];});
    add('seq','block hash unknown to the accessor','fail',x=>{x.seq=[{...x.seq[0],blockHash:flip(x.seq[0].blockHash,0)}];});
  }
  // manager ledger header rules, only on terminal bases (the output set does not depend on the mutated header)
  if(m.header&&m.terminal) {
    const {ledger,tail}=splitRaw(t0.raw);
    const put=(at,v,w)=>L=>{const o=L.slice();o.set(le(BigInt(v),w),at);return o;};
    const cases=[['role byte=2','fail',L=>{const o=L.slice();o[0]=2;return o;}],['role byte=0','fail',L=>{const o=L.slice();o[0]=0;return o;}],
      ['ticketCap=2','fail',put(41,2,4)],['ticketCap=10000001','fail',put(41,10000001,4)],['minTickets=2','fail',put(45,2,4)],
      ['minTickets=ticketCap+1','fail',L=>put(45,S.fromLe(L.slice(41,45))+1n,4)(L)],
      ['closeEligibleDaa=0','fail',put(49,0,8)],['closeEligibleDaa=DAA_LIMIT-TIMEOUT','fail',put(49,S.DAA_LIMIT-S.TIMEOUT_DELAY,8)],
      ['directory count=1 (no such entry)','fail',put(57,1,2)],['directory count=257','fail',put(57,257,2)],['trailing byte (misaligned records)','fail',L=>cat(L,Uint8Array.of(0))],
      ['ticketCap=total tickets (valid boundary)','pass',put(41,m.total,4)],['closeEligibleDaa=DAA_LIMIT-TIMEOUT-1 (valid boundary)','pass',put(49,S.DAA_LIMIT-S.TIMEOUT_DELAY-1n,8)]];
    for(const [label,expect,fn] of cases) add('header',label,expect,x=>{
      const t=decode(x.tx.inputs[0].sigscript,m.module),raw=scriptFor(fn(ledger),tail);
      t.raw=raw;x.tx.inputs[0].sigscript=enc(t);x.utxos[0]={...x.utxos[0],spk:p2sh(hex(blake2b256(raw))).script};});
  }
  return acc;
}
function* bases() {
  const buy=(name,o,q,{funds,full=false}={})=>base(name,fixture({module:'sales',...o}),{action:'BUY',quantity:q},{funds:funds??[F(1,BigInt(q)*PRICE+KAS10)],full});
  yield buy('BUY first (cnt=0, local=0)',{},1,{full:true});
  yield buy('BUY q=1000',{},1000);
  yield buy('BUY fills the cap exactly (cap=1000, local=10, q=990)',{ticketCap:1000,local:10},990);
  yield buy('BUY (cnt=254, local=254) largest nonfreezing',{cnt:254,local:254},1);
  yield buy('BUY freeze (cnt=0, local=255)',{local:255},1);
  yield buy('BUY freeze (cnt=254, local=255)',{cnt:254,local:255},1);
  yield buy('BUY freeze (cnt=255, local=255) creating shard 256',{cnt:255,local:255},1);
  yield buy('BUY with 8 funding inputs',{},1,{funds:Array.from({length:8},(_,i)=>F(10+i,137500000n))});
  const close=(name,o)=>base(name,fixture({module:'sales',...o}),{action:'CLOSE'},{funds:[F(2,KAS10)]});
  yield close('CLOSE empty (cnt=0, local=0)',{});
  yield close('CLOSE -> SEALED (cnt=0, local=5)',{local:5});
  yield close('CLOSE -> SEALED (cnt=255, local=255) largest',{cnt:255,local:255});
  yield close('CLOSE -> REFUND (cnt=0, local=5, T<min)',{local:5,minTickets:100});
  yield close('CLOSE -> REFUND (cnt=255, local=255, T<min) largest',{cnt:255,local:255,minTickets:70000});
  yield close('CLOSE at the cap needs no lockTime (cap=5, local=5)',{local:5,ticketCap:5});
  yield close('CLOSE with 256 shards needs no lockTime (cnt=256, local=0)',{cnt:256});
  const sf=o=>fixture({module:'sealed',...o,currentDaa:2000n+S.DRAW_DELAY+10n});
  for(const [name,o,old,full] of [['DRAW old shard (cnt=1, local=0)',{cnt:1},true,true],['DRAW old shard (cnt=255, local=255) largest',{cnt:255,local:255},true,false],
    ['DRAW local winner (cnt=0, local=3)',{local:3},false,true],['DRAW local winner (cnt=3, local=100)',{cnt:3,local:100},false,false],
    ['DRAW local winner (cnt=255, local=255)',{cnt:255,local:255},false,false]]) {
    const f=sf(o);yield base(name,f,findDraw(f,old),{funds:[F(3,KAS10)],full});
  }
  for(const [name,o] of [['TIMEOUT (cnt=255, local=255) largest',{cnt:255,local:255}],['TIMEOUT (cnt=0, local=5)',{local:5}]]) {
    const f=fixture({module:'sealed',...o,currentDaa:2000n+S.TIMEOUT_DELAY});yield base(name,f,{action:'TIMEOUT'},{funds:[F(4,KAS10)]});
  }
  const win=(name,o,k)=>{const f=fixture({module:'win',...o}),p=o.p??0;return base(name,f,{action:'PAY_OLD'},{targets:f.targets.slice(p,p+k),fee:50000000n});};
  yield win('PAY_OLD k=1 nonfinal (cnt=255, local=255, p=0)',{cnt:255,local:255},1);
  yield win('PAY_OLD k=16 nonfinal (cnt=255, local=255, p=0)',{cnt:255,local:255},16);
  yield win('PAY_OLD k=16 nonfinal (cnt=255, local=255, p=128)',{cnt:255,local:255,p:128},16);
  yield win('PAY_OLD k=1 final merge (cnt=255, local=2, p=254)',{cnt:255,local:2,p:254},1);
  yield win('PAY_OLD k=2 final merge (cnt=17, local=1, p=15)',{cnt:17,local:1,p:15},2);
  yield win('PAY_OLD k=16 final merge (cnt=16, local=2, p=0)',{cnt:16,local:2,p:0},16);
  yield win('PAY_OLD k=1 final merge with empty tail (cnt=2, local=0, p=1)',{cnt:2,local:0,p:1},1);
  yield win('PAY_OLD k=1 merge tail but not final (cnt=3, local=2, p=0)',{cnt:3,local:2,p:0},1);
  yield win('PAY_OLD k=1 last old shard, tail too large to merge (cnt=2, local=10, p=1)',{cnt:2,local:10,p:1},1);
  const own=(name,o,extra={})=>base(name,fixture({module:'win',...o}),{action:'PAY_SELF'},{fee:50000000n,...extra});
  yield own('PAY_SELF (cnt=255, local=255, p=255)',{cnt:255,local:255,p:255});
  yield own('PAY_SELF (cnt=0, local=3) smallest',{local:3,p:0},{header:true});
  yield own('PAY_SELF (cnt=2, local=10, p=2)',{cnt:2,local:10,p:2});
  const rold=(name,o)=>{const f=fixture({module:'refund',...o});return base(name,f,{action:'REFUND_OLD'},{targets:f.targets.slice(o.r,o.r+1),fee:50000000n});};
  yield rold('REFUND_OLD nonfinal (cnt=255, local=255, r=0, c=0)',{cnt:255,local:255,r:0,c:0});
  yield rold('REFUND_OLD nonfinal (cnt=255, local=255, r=0, c=32)',{cnt:255,local:255,r:0,c:32});
  yield rold('REFUND_OLD last batch of a shard (cnt=255, local=255, r=0, c=224)',{cnt:255,local:255,r:0,c:224});
  yield rold('REFUND_OLD last batch of last shard, no merge (cnt=255, local=255, r=254, c=224)',{cnt:255,local:255,r:254,c:224});
  yield rold('REFUND_OLD final merge, 2 tail records, 36 outputs (cnt=255, local=2, r=254, c=224)',{cnt:255,local:2,r:254,c:224});
  yield rold('REFUND_OLD final merge, 1 tail record (cnt=1, local=1, r=0, c=224)',{cnt:1,local:1,r:0,c:224});
  yield rold('REFUND_OLD final merge, empty tail (cnt=2, local=0, r=1, c=224)',{cnt:2,local:0,r:1,c:224});
  yield rold('REFUND_OLD mid (cnt=100, local=50, r=57, c=96)',{cnt:100,local:50,r:57,c:96});
  const rself=(name,o,funds,extra={})=>base(name,fixture({module:'refund',...o}),{action:'REFUND_SELF'},{funds,fee:5000000n,...extra});
  yield rself('REFUND_SELF nonlast (cnt=0, local=255, c=0)',{local:255,r:0,c:0},[F(5,KAS)]);
  yield rself('REFUND_SELF nonlast (cnt=255, local=255, r=255, c=0)',{cnt:255,local:255,r:255,c:0},[F(5,KAS)]);
  yield rself('REFUND_SELF last batch (cnt=0, local=255, c=224)',{local:255,r:0,c:224},[F(5,KAS)]);
  yield rself('REFUND_SELF last batch, one record (cnt=0, local=33, c=32)',{local:33,r:0,c:32},[F(5,KAS)],{header:true});
  yield rself('REFUND_SELF without funding inputs (cnt=0, local=255, c=32)',{local:255,r:0,c:32},[]);
  yield rself('REFUND_SELF with 8 funding inputs (cnt=3, local=40, r=3, c=32)',{cnt:3,local:40,r:3,c:32},Array.from({length:8},(_,i)=>F(20+i,125000000n)));
}
export function* generate({only,basesOnly=false}={}) {
  for(const c of bases()) {
    if(only&&!c.name.includes(only)) continue;
    yield c;
    if(!basesOnly) for(const x of mutate(c)) yield x;
  }
}
