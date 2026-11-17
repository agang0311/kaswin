/** Shared synthetic fixtures built from the REAL compiled artifacts (artifacts/*.json). Offline; used by measure.mjs and the VM cases.
 * Ledgers are synthetic: every record belongs to one buyer and every old shard is a distinct valid frozen shard.
 * Nothing here is a node observation, a signature or an approval. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {p2pk,p2sh} from '../../scripts/core/lib/covenant-id.js';
import {domainHash} from '../../scripts/core/lib/blake3.js';
import * as S from './state.mjs';
import {loadCandidateProfile,redeem,rootId,scriptHash} from './profile.mjs';
import {buildAction,draw,drawSample} from './transactions.mjs';
import {massOf} from './mass.mjs';
export {S,p2pk,p2sh,redeem,scriptHash,rootId,buildAction,massOf};
const {cat,hex,le}=S;
export const here=dirname(fileURLToPath(import.meta.url));
const sha=text=>createHash('sha256').update(text).digest('hex');
export const texts={},trust={};
for(const m of S.MODULES) {
  texts[m]=await readFile(join(here,'artifacts',m+'.json'),'utf8');
  trust[m]={artifactSha256:sha(texts[m]),sourceSha256:sha(await readFile(join(here,'generated',m+'.sil'),'utf8'))};
}
export const profile=loadCandidateProfile(texts,trust);
export const OWNER='11'.repeat(32),BUYER='22'.repeat(32),WINNER='33'.repeat(32),ACTOR='44'.repeat(32);
export const id=n=>BigInt(n).toString(16).padStart(64,'0');
export const PRICE=100000000n,KAS=100000000n,FEE=1000000n;
/** n purchase records of `per` tickets each (per>1 widens the cumulative end values). */
export const records=(n,per=1)=>Array.from({length:n},(_,i)=>({end:(i+1)*per,key:BUYER}));
/** Old shard j: 256 records of `per` tickets; record 0 belongs to a distinct buyer so every shard (and its hash) is different. */
export const shardRecords=(j,per=1)=>records(256,per).map((r,i)=>i===0?{...r,key:id(0x10000+j)}:r);
const shardCache=new Map();
export function shard(j,per=1) {
  const k=j+':'+per;
  if(!shardCache.has(k)) {const s={module:'frozen',records:shardRecords(j,per)};shardCache.set(k,{s,hash:scriptHash(s,profile),redeem:redeem(s,profile)});}
  return shardCache.get(k);
}
export function fixture({module,cnt=0,local=0,p=0,r=0,c=0,minTickets=3,per=1,localRecords=records(local,per),currentDaa=500000n,
  price=PRICE,ticketCap=10000000,closeEligibleDaa=1000n}) {
  const config={ticketPrice:price,ticketCap,minTickets,closeEligibleDaa};
  const extra=module==='win'?{winnerKey:WINNER,p}:module==='refund'?{r,c}:{};
  const s=S.phase(S.initial(OWNER,config),module,{indices:Array.from({length:cnt},(_,i)=>({hash:shard(i,per).hash,end:256*per*(i+1)})),records:localRecords,...extra});
  const origin={transactionId:id(5000),index:0},cid=rootId(origin,s,profile);
  const manager={outpoint:{transactionId:id(6000),index:0},cid,origin,spk:p2sh(scriptHash(s,profile)),value:S.managerValue(s),
    redeemScript:redeem(s,profile),utxoDaa:2000n,currentDaa};
  const targets=Array.from({length:cnt},(_,j)=>({outpoint:{transactionId:id(7000+j),index:1},cid,spk:p2sh(shard(j,per).hash),
    value:S.frozenValue(s,j,shard(j,per).s.records),redeemScript:shard(j,per).redeem,utxoDaa:1000n}));
  return {s,manager,targets};
}
export const fund=(n,value,key=ACTOR)=>({outpoint:{transactionId:id(8000+n),index:0},value,spk:p2pk(key),utxoDaa:0n});
/** budgets: array (one per input) or undefined for all-zero (size-only quotation). */
export function quote(f,op,{targets=[],funds=[],fee=FEE,budgets}={}) {
  const n=1+targets.length+funds.length;
  const d=buildAction(f.manager,profile,{actorKey:ACTOR,...op},{targets,funds,fee,budgets:budgets??Array(n).fill(0)});
  return {d,q:massOf(d)};
}
// A DRAW proof that satisfies the JS-side structure checks; the chain accessor is derived the same way the contract opens it.
export function drawOp(f,nonce=0) {
  const boundary=f.manager.utxoDaa+S.DRAW_DELAY,proof=new Uint8Array(240);
  proof.set(Uint8Array.from({length:32},(_,i)=>i+1),0);proof[31]=nonce&255;proof[30]=(nonce>>8)&255;if(nonce>>16) proof[29]=(nonce>>16)&255;
  const put=(at,v)=>proof.set(le(v,8),at);put(96,0n);put(104,boundary+5n);put(112,10n);put(216,0n);put(224,boundary-1n);put(232,1n);
  const branch=(a,b)=>domainHash('SeqCommitmentMerkleBranchHash',cat(a,b));
  const open=(base,parent)=>branch(parent,branch(proof.slice(base,base+32),branch(domainHash('SeqCommitMergesetContext',proof.slice(base+64,base+88)),proof.slice(base+32,base+64))));
  const seq=open(32,open(152,proof.slice(120,152)));
  return {proof,accessor:{blockHash:hex(proof.slice(0,32)),sequenceCommitment:hex(seq)}};
}
/** Find a nonce whose draw satisfies pred({j,i,ticket}); `per` must match the fixture. Returns the DRAW operation.
 * Only the ticket is derived per nonce; the full builder draw() runs once, for the winner. */
export function findDrawWhere(f,pred,{max=400000,per=1}={}) {
  const s=f.s,N=s.indices.length,ends=[...s.indices.map(v=>v.end),S.totalTickets(s)];
  for(let nonce=0;nonce<max;nonce++) {
    const base={...drawOp(f,nonce),action:'DRAW'};
    let ticket;try {({ticket}=drawSample(f.manager,s,base));} catch(e) {if(e.code==='SAMPLE_REJECTED') continue;throw e;}
    const j=ends.findIndex(end=>ticket<end),start=j===0?0:s.indices[j-1].end;
    let records=s.records;if(j<N) records=shard(j,per).s.records;
    const local=ticket-start,i=records.findIndex(r=>local<r.end);
    if(!pred({j,i,ticket})) continue;
    const op={...base,j,winningRedeem:j<N?shard(j,per).redeem:undefined};
    draw(f.manager,s,profile,op);return {...op,nonce,j,i,ticket};
  }
  throw new Error('no DRAW nonce found');
}
/** Nonce whose drawn ticket lands in an old shard (wantOld) or in the manager's local records. */
export const findDraw=(f,wantOld,max=6000)=>findDrawWhere(f,d=>(d.j<f.s.indices.length)===wantOld,{max});
