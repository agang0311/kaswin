/** Deterministic rolling transitions and unsigned v1 drafts. TypeScript port of experiments/rolling/transactions.mjs.
 * NOT a VM, node or signing API. Source candidate; NOT_RUN. */
import {ascii,cat,check,fromLe,hex,integer,le,stable,unhex} from '../../../core/lib/bytes.js';
import {blake2b256} from '../../../core/lib/hashes.js';
import {domainHash} from '../../../core/lib/blake3.js';
import {p2pk,p2sh,type Outpoint,type Spk} from '../../../core/lib/covenant-id.js';
import {pushBytes} from '../../../core/lib/state.js';
import {pushInt} from '../../../core/lib/builders.js';
import {validateTransaction,outpointKey,type Binding,type Input,type Transaction} from '../../../core/lib/transaction.js';
import {REGISTRATION_SOMPI,checkRegistrySpk} from '../../../core/lib/registry.js';
import * as S from './state.js';
import {assertProfile,identify,rootId,scriptHash,verifyManager,type ManagerContext,type Profile} from './profile.js';

// Action IDs 22/23 are retired; do not reuse them for another branch.
export const ACTION={BUY:1,CLOSE:2,DRAW:4,TIMEOUT:9,PAY_OLD:20,PAY_SELF:21,REFUND_OLD:30,REFUND_SELF:31} as const;
export type Action=keyof typeof ACTION;
export type Terminal='EMPTY'|'PAID'|'REFUNDED';
/** Chain facts the DRAW proof must match; the caller reads them from an authenticated node. */
export interface Accessor {blockHash:string;sequenceCommitment:string;}
/** Sampling also serves callers which have not selected an action or reward receiver yet. */
export type DrawContext=Pick<ManagerContext,'cid'|'outpoint'|'utxoDaa'|'currentDaa'>;
export interface DrawOperation {
  proof?:Uint8Array|undefined;accessor?:Accessor|undefined;j?:number|undefined;i?:number|undefined;winningRedeem?:Uint8Array|undefined;
}
export interface Operation extends DrawOperation {
  action:Action;actorKey:string;buyerKey?:string|undefined;quantity?:number|undefined;
}
/** A spent frozen shard, with its authenticated preimage. */
export interface TargetContext {
  cid:string;outpoint:Outpoint;value:bigint;spk:Spk;redeemScript:Uint8Array;
  origin?:Outpoint|undefined;utxoDaa?:bigint|undefined;covenantId?:string|null|undefined;
}
/** An ordinary wallet input: never carries a covenant id. */
export interface Funding {
  outpoint:Outpoint;value:bigint;spk:Spk;daa?:bigint|undefined;cid?:string|null|undefined;covenantId?:string|null|undefined;
}
export interface InputContext {
  outpoint:Outpoint;value:bigint;spk:Spk;cid?:string|null|undefined;covenantId?:string|null|undefined;
}
export interface OutputEffect {
  value:bigint;scriptPublicKey:Spk;covenant:Binding|null;role:string;state?:S.State;
}
export interface Transition {
  next:S.ManagerState|null;terminal:Terminal|null;outputs:OutputEffect[];data:Uint8Array;nextTail:Uint8Array;
  sequence:bigint;lockTime:bigint;externalCost:bigint|null;
}
export interface GenesisTransition {next:S.SalesState;outputs:{state:S.SalesState}[];}
/** Normalizing a covenant id retains the caller's authenticated UTXO metadata. */
export type Utxo<T extends InputContext=InputContext>=T extends InputContext?Omit<T,'covenantId'>&{covenantId:string|null;}:never;
export interface DraftBase<T extends InputContext=InputContext> {
  transaction:Transaction;inputUtxos:Utxo<T>[];authorizedInputIndices:number[];fee:bigint;roles:string[];status:'SOURCE_ONLY_NOT_RUN';
}
export interface Draft extends DraftBase<ManagerContext|TargetContext|Funding> {transition:Transition|GenesisTransition;origin:Outpoint;cid:string;}
export interface ActionDraft extends Draft {transition:Transition;}
export interface GenesisDraft extends Draft {transition:GenesisTransition;inputUtxos:Utxo<Funding>[];}
export interface BuildOptions {targets?:TargetContext[];funds?:Funding[];fee:bigint;budgets:number[];}
export interface GenesisOptions {funds:Funding[];fee:bigint;budgets:number[];registrySpk?:Spk|null;}
export interface DrawSample {ticket:number;seed:Uint8Array;proof:Uint8Array;}
export interface DrawResult {ticket:number;winnerKey:string;seed:string;j:number;i:number;data:Uint8Array;}

const empty=():Uint8Array=>new Uint8Array();
function openingInt(proof:Uint8Array,offset:number):bigint {const n=fromLe(proof.slice(offset,offset+8));check(n<1n<<63n,'PROOF_INTEGER');return n;}
function openSeq(proof:Uint8Array,base:number,parent:Uint8Array):Uint8Array {
  const branch=(a:Uint8Array,b:Uint8Array):Uint8Array=>domainHash('SeqCommitmentMerkleBranchHash',cat(a,b));
  return branch(parent,branch(proof.slice(base,base+32),branch(domainHash('SeqCommitMergesetContext',proof.slice(base+64,base+88)),proof.slice(base+32,base+64))));
}
/** The proof-bound ticket only (no shard preimage needed): sampling, maturity and PASS-A structure checks. */
export function drawSample(x:DrawContext,s:S.ManagerState,op:DrawOperation):DrawSample {
  const proof=op.proof,accessor=op.accessor;check(proof instanceof Uint8Array&&proof.length===240&&accessor,'DRAW_PROOF');
  check(x.utxoDaa>=0n&&x.utxoDaa<S.DAA_LIMIT-S.TIMEOUT_DELAY&&x.currentDaa>=x.utxoDaa+S.DRAW_DELAY,'DRAW_MATURITY');
  const boundary=x.utxoDaa+S.DRAW_DELAY,td=openingInt(proof,104);
  check(openingInt(proof,224)<boundary&&td>=boundary&&td<S.DAA_LIMIT,'FIRST_CROSSING');
  check(openingInt(proof,112)>openingInt(proof,232),'BLUE_ORDER');openingInt(proof,96);openingInt(proof,216);
  const seq=openSeq(proof,32,openSeq(proof,152,proof.slice(120,152))),target=hex(proof.slice(0,32));
  check(accessor.blockHash===target&&accessor.sequenceCommitment===hex(seq),'CHAIN_ACCESSOR');
  const seed=blake2b256(cat(ascii('KASWIN_ROLLING_DRAW_V1'),unhex(x.cid,32),unhex(x.outpoint.transactionId,32),
    le(BigInt(x.outpoint.index),4),le(boundary,8),proof.slice(0,32),seq));
  const digest=blake2b256(cat(ascii('KASWIN_V2_SAMPLE'),seed,new Uint8Array(8))),sample=fromLe(digest.slice(0,7)),T=BigInt(S.totalTickets(s)),space=1n<<56n;
  check(sample<space-space%T,'SAMPLE_REJECTED');
  return {ticket:Number(sample%T),seed,proof};
}
export function draw(x:DrawContext,s:S.ManagerState,p:Profile,op:DrawOperation):DrawResult {
  const {ticket,seed,proof}=drawSample(x,s,op);
  const j=op.j??[...s.indices.map(i=>i.end),S.totalTickets(s)].findIndex(end=>ticket<end);integer(j,0,s.indices.length);
  const start=j===0?0:s.indices[j-1]!.end,end=j<s.indices.length?s.indices[j]!.end:S.totalTickets(s);
  check(start<=ticket&&ticket<end,'SHARD_HINT');let records:readonly S.TicketRecord[]=s.records,raw:Uint8Array|undefined=empty();
  if(j<s.indices.length){
    raw=op.winningRedeem;check(raw instanceof Uint8Array,'WINNING_PREIMAGE');
    check(hex(blake2b256(raw))===s.indices[j]!.hash,'WINNING_HASH');const f=identify(raw,p);check(f.module==='frozen','WINNING_ROLE');
    records=f.records;check(S.recordTotal(records)===end-start,'WINNING_TICKETS');
  }else check(!op.winningRedeem?.length,'UNEXPECTED_WINNING_PREIMAGE');
  const local=ticket-start,i=op.i??records.findIndex(r=>local<r.end);integer(i,0,records.length-1);
  check((i?records[i-1]!.end:0)<=local&&local<records[i]!.end,'RECORD_HINT');
  return {ticket,winnerKey:records[i]!.key,seed:hex(seed),j,i,
    data:cat(proof,le(BigInt(j),2),le(BigInt(i),2),le(BigInt(raw.length),4),raw)};
}
function frozen(x:ManagerContext,p:Profile,s:S.ManagerState,f:TargetContext,j:number):S.FrozenState {
  check(f.cid===x.cid,'TARGET_CID');check(hex(blake2b256(f.redeemScript))===s.indices[j]?.hash,'TARGET_HASH');
  const q=identify(f.redeemScript,p);check(q.module==='frozen','TARGET_ROLE');
  check(stable(f.spk)===stable(p2sh(s.indices[j]!.hash)),'TARGET_SPK');
  check(f.value===S.frozenValue(s,j,q.records),'TARGET_VALUE');return q;
}
/** Exact effects, independent of wallet-selection policy. Target order is protocol order. */
export function transition(x:ManagerContext,p:Profile,op:Operation,targets:readonly TargetContext[],fee:bigint,external:bigint=0n):Transition {
  const s=verifyManager(x,p),N=s.indices.length,local=S.recordTotal(s.records),T=S.totalTickets(s);
  check(Object.hasOwn(ACTION,op.action),'ACTION');unhex(op.actorKey,32);
  const paying=op.action==='PAY_OLD'||op.action==='PAY_SELF';
  check(typeof fee==='bigint'&&fee>0n&&fee<=(paying?S.PAY_FEE_CAP:S.FEE_CAP),'FEE');
  check(typeof external==='bigint'&&external>=0n,'EXTERNAL');
  const seen=[x,...targets].map(v=>outpointKey(v.outpoint));check(new Set(seen).size===seen.length,'DUPLICATE_INPUT');
  // `as` keeps the declared union: these are reassigned from the closures/branches below, which control-flow analysis cannot see.
  let next=null as S.ManagerState|null,terminal=null as Terminal|null,data=empty(),nextTail=empty(),sequence=0n,lockTime=0n,externalCost=null as bigint|null;
  const outputs:OutputEffect[]=[];
  const pay=(value:bigint,key:string,role:string):void=>{check(value>0n&&value<=S.VALUE_LIMIT,'PAYMENT');outputs.push({value,scriptPublicKey:p2pk(key),covenant:null,role});};
  const state=(st:S.State,value:bigint,role='MANAGER'):void=>{outputs.push({value,scriptPublicKey:p2sh(scriptHash(st,p)),covenant:{covenantId:x.cid,authorizingInput:0},role,state:st});};
  const manager=(st:S.ManagerState):void=>{next=st;state(st,S.managerValue(st));};
  const noTargets=():void=>check(targets.length===0,'UNEXPECTED_TARGETS');
  switch(op.action){
    case 'BUY':{
      check(s.module==='sales'&&N<256,'NOT_SELLING');noTargets();const q=integer(op.quantity??NaN,1,s.ticketCap-T);
      const buyer=op.buyerKey??op.actorKey;unhex(buyer,32);data=cat(le(BigInt(q),4),unhex(buyer,32));
      const records=[...s.records,{end:local+q,key:buyer}];externalCost=BigInt(q)*s.ticketPrice+fee;
      if(records.length===256){
        const f:S.FrozenState={module:'frozen',records},hash=scriptHash(f,p);
        manager(S.phase(s,'sales',{indices:[...s.indices,{hash,end:T+q}],records:[]}));
        state(f,BigInt(local+q)*s.ticketPrice,'FROZEN');nextTail=p.frames.frozen.tail;
      }else manager(S.phase(s,'sales',{records}));
      break;
    }
    case 'CLOSE':{
      check(s.module==='sales','NOT_SALES');noTargets();
      if(T<s.ticketCap&&N<256){check(x.currentDaa>=s.closeEligibleDaa,'CLOSE_EARLY');lockTime=s.closeEligibleDaa-1n;}
      externalCost=fee;
      if(T===0){pay(S.DEPOSIT,s.ownerKey,'CREATOR');terminal='EMPTY';}
      else{const m=T>=s.minTickets?'sealed':'refund';manager(S.phase(s,m,m==='refund'?{r:0,c:0}:{}));nextTail=p.frames[m].tail;}
      break;
    }
    case 'DRAW':{
      check(s.module==='sealed','NOT_SEALED');noTargets();const d=draw(x,s,p,op);
      manager(S.phase(s,'win',{winnerKey:d.winnerKey,p:0}));data=d.data;
      nextTail=p.frames.win.tail;sequence=S.DRAW_DELAY;externalCost=fee;
      break;
    }
    case 'TIMEOUT':{
      check(s.module==='sealed'&&x.currentDaa>=x.utxoDaa+S.TIMEOUT_DELAY,'TIMEOUT_EARLY');noTargets();
      manager(S.phase(s,'refund',{r:0,c:0}));nextTail=p.frames.refund.tail;sequence=S.TIMEOUT_DELAY;externalCost=fee;
      break;
    }
    case 'PAY_OLD':{
      check(s.module==='win'&&external===0n,'PAY_CONTEXT');const k=targets.length;integer(k,1,16);
      check(s.p+k<=N,'PAY_BOUNDARY');let gross=0n;
      targets.forEach((f,i)=>{frozen(x,p,s,f,s.p+i);gross+=f.value;});
      const last=S.mergeTail(s)&&s.p+k===N;
      if(last)gross+=BigInt(local)*s.ticketPrice;
      else manager({...s,p:s.p+k});
      const prize=gross-BigInt(k)*S.REWARD-fee;check(prize>=S.PRICE_MIN,'PRIZE_MIN');
      pay(prize,s.winnerKey,'WINNER');
      if(last){pay(S.DEPOSIT,s.ownerKey,'CREATOR');terminal='PAID';}
      pay(BigInt(k)*S.REWARD,op.actorKey,'EXECUTOR');
      break;
    }
    case 'PAY_SELF':{
      check(s.module==='win'&&external===0n,'PAY_CONTEXT');noTargets();
      check(s.p===N&&local>0&&!S.mergeTail(s),'SELF_PAY_BOUNDARY');
      const prize=BigInt(local)*s.ticketPrice-S.REWARD-fee;check(prize>=S.PRICE_MIN,'PRIZE_MIN');
      pay(prize,s.winnerKey,'WINNER');pay(S.DEPOSIT,s.ownerKey,'CREATOR');pay(S.REWARD,op.actorKey,'EXECUTOR');terminal='PAID';
      break;
    }
    case 'REFUND_OLD':{
      check(s.module==='refund'&&s.r<N&&targets.length===1&&external===0n,'OLD_REFUND_CONTEXT');
      const f=targets[0]!,rs=frozen(x,p,s,f,s.r).records,end=s.c+32,last=end===256;
      const final=last&&s.r===N-1&&S.mergeTail(s);
      if(!final)manager({...s,r:last?s.r+1:s.r,c:last?0:end});
      const gross=BigInt(S.paidTickets(rs,end)-S.paidTickets(rs,s.c))*s.ticketPrice;
      if(!last)state({module:'frozen',records:rs},f.value-gross,'FROZEN');
      for(let i=s.c;i<end;i++)pay(BigInt(rs[i]!.end-(i?rs[i-1]!.end:0))*s.ticketPrice-S.REFUND_FEE,rs[i]!.key,'BUYER_REFUND');
      let pool=32n*S.REFUND_FEE;
      if(final){
        check(s.records.length<=2,'MERGED_REFUND_RECORDS');
        for(let i=0;i<s.records.length;i++)pay(BigInt(s.records[i]!.end-(i?s.records[i-1]!.end:0))*s.ticketPrice-S.REFUND_FEE,s.records[i]!.key,'BUYER_REFUND');
        pool+=BigInt(s.records.length)*S.REFUND_FEE;
        pay(S.DEPOSIT,s.ownerKey,'CREATOR');terminal='REFUNDED';
      }
      pay(pool-fee,op.actorKey,'EXECUTOR');
      break;
    }
    case 'REFUND_SELF':{
      check(s.module==='refund'&&s.r===N&&s.records.length>0&&!S.mergeTail(s),'SELF_REFUND_CONTEXT');noTargets();
      const end=Math.min(s.c+32,s.records.length),last=end===s.records.length;
      if(!last)manager({...s,c:end});
      for(let i=s.c;i<end;i++)pay(BigInt(s.records[i]!.end-(i?s.records[i-1]!.end:0))*s.ticketPrice-S.REFUND_FEE,s.records[i]!.key,'BUYER_REFUND');
      if(last){pay(S.DEPOSIT-S.REFUND_FEE,s.ownerKey,'CREATOR');terminal='REFUNDED';}
      pay(BigInt(end-s.c+(last?1:0))*S.REFUND_FEE+external-fee,op.actorKey,'EXECUTOR');
      break;
    }
    default:check(false,'ACTION');
  }
  if(externalCost!==null){check(external>=externalCost,'FUNDING_SHORT');if(external>externalCost)pay(external-externalCost,op.actorKey,'CHANGE');}
  check(outputs.length>0&&outputs.length<=S.MAX_OUTPUTS,'OUTPUT_COUNT');
  check(x.value+targets.reduce((n,f)=>n+f.value,0n)+external-outputs.reduce((n,o)=>n+o.value,0n)===fee,'CONSERVATION');
  return {next,terminal,outputs,data,nextTail,sequence,lockTime,externalCost};
}
function checkFunding(funds:readonly Funding[],key:string):void {
  integer(funds.length,0,8);
  for(const f of funds){
    check(typeof f.value==='bigint'&&f.value>0n&&f.value<=S.VALUE_LIMIT,'FUNDING_VALUE');
    check(!f.cid||f.cid===S.ZERO,'FUNDING_CID');check(!f.covenantId||f.covenantId===S.ZERO,'FUNDING_CID');
    check(stable(f.spk)===stable(p2pk(key)),'FUNDING_OWNER');
  }
}
function finish<T extends InputContext>(transaction:Transaction,inputs:readonly T[],authorized:number[],fee:bigint,roles:string[],budgets:readonly number[]):DraftBase<T> {
  check(Array.isArray(budgets)&&budgets.length===inputs.length,'EXPLICIT_BUDGETS_REQUIRED');
  transaction.inputs.forEach((i,n)=>{i.computeBudget=integer(budgets[n]!,0,65535);});
  const keys=inputs.map(f=>outpointKey(f.outpoint));check(new Set(keys).size===keys.length,'DUPLICATE_INPUT');
  check(inputs.reduce((n,f)=>n+f.value,0n)-transaction.outputs.reduce((n,o)=>n+o.value,0n)===fee,'FEE_MISMATCH');
  check(transaction.outputs.every(o=>typeof o.value==='bigint'&&o.value>0n&&o.value<=S.VALUE_LIMIT),'OUTPUT_VALUE');
  validateTransaction(transaction);
  return {transaction,inputUtxos:inputs.map(f=>({...f,covenantId:f.cid&&f.cid!==S.ZERO?f.cid:null} as unknown as Utxo<T>)),
    authorizedInputIndices:authorized,fee,roles,status:'SOURCE_ONLY_NOT_RUN'};
}
const base=():Transaction=>({version:1,inputs:[],outputs:[],lockTime:0n,subnetworkId:'00'.repeat(20),gas:0n,payload:'',storageMass:0n});
const input=(f:{outpoint:Outpoint},signatureScript='',sequence=0n):Input=>({previousOutpoint:{...f.outpoint},signatureScript,sequence});
function call(args:readonly (bigint|Uint8Array)[],tag:string,raw:Uint8Array):string {
  return hex(cat(...args.map(v=>typeof v==='bigint'?pushInt(v):pushBytes(v)),pushBytes(unhex(tag,4)),pushBytes(raw)));
}
/** The empty options default preserves legacy validation order; fee and budgets still have to be explicit. */
export function buildAction(x:ManagerContext,p:Profile,op:Operation,{targets=[],funds=[],fee,budgets}:BuildOptions={} as BuildOptions):ActionDraft {
  const s=verifyManager(x,p);checkFunding(funds,op.actorKey);
  if(op.action==='BUY')check(!op.buyerKey||op.buyerKey===op.actorKey,'STANDARD_SELF_PURCHASE');
  const external=funds.reduce((n,f)=>n+f.value,0n),t=transition(x,p,op,targets,fee,external);
  if(t.externalCost!==null)check(funds.length>=1,'FUNDING_REQUIRED');
  if(op.action==='PAY_OLD'||op.action==='PAY_SELF'||op.action==='REFUND_OLD')check(funds.length===0,'NO_FUNDING_BRANCH');
  const frame=p.frames[s.module],sizes=cat(...targets.map(f=>le(BigInt(f.redeemScript.length),4)));
  const id=BigInt(ACTION[op.action]);
  const args:(bigint|Uint8Array)[]=s.module==='sales'?[id,unhex(x.origin.transactionId,32),BigInt(x.origin.index),BigInt(frame.tail.length),t.nextTail,t.data]:
    s.module==='sealed'?[id,BigInt(frame.tail.length),t.nextTail,t.data]:[id,BigInt(frame.tail.length),sizes];
  const tx=base();tx.lockTime=t.lockTime;
  tx.inputs=[input(x,call(args,frame.dispatchTag,x.redeemScript),t.sequence),
    ...targets.map(f=>input(f,call([BigInt(x.redeemScript.length),BigInt(frame.tail.length)],p.frames.frozen.dispatchTag,f.redeemScript))),
    ...funds.map(f=>input(f))];
  check(tx.inputs.every(i=>unhex(i.signatureScript).length<=250000),'SIGSCRIPT_LIMIT');
  tx.outputs=t.outputs.map(({value,scriptPublicKey,covenant})=>({value,scriptPublicKey,covenant}));
  return {...finish(tx,[x,...targets,...funds],funds.map((_,i)=>1+targets.length+i),fee,t.outputs.map(o=>o.role),budgets),transition:t,origin:x.origin,cid:x.cid};
}
export function buildGenesis(p:Profile,ownerKey:string,config:S.ManagerConfig,{funds,fee,budgets,registrySpk=null}:GenesisOptions):GenesisDraft {
  assertProfile(p);checkFunding(funds,ownerKey);check(funds.length>0,'FUNDING_REQUIRED');
  check(typeof fee==='bigint'&&fee>0n&&fee<=S.FEE_CAP,'FEE');const s=S.initial(ownerKey,config),origin=funds[0]!.outpoint;
  check(origin.transactionId!==S.ZERO,'ORIGIN_ZERO');const cid=rootId(origin,s,p),tx=base(),registration=registrySpk?REGISTRATION_SOMPI:0n;
  tx.inputs=funds.map(f=>input(f));tx.payload=hex(cat(ascii('KASWIN_ROLLING_GENESIS_V1'),unhex(p.id,32),S.encode(s)));
  tx.outputs=[{value:S.DEPOSIT,scriptPublicKey:p2sh(scriptHash(s,p)),covenant:{covenantId:cid,authorizingInput:0}}];const roles=['MANAGER'];
  if(registrySpk){tx.outputs.push({value:registration,scriptPublicKey:checkRegistrySpk(registrySpk),covenant:null});roles.push('REGISTRATION');}
  const change=funds.reduce((n,f)=>n+f.value,0n)-S.DEPOSIT-registration-fee;check(change>=0n,'FUNDING_SHORT');
  if(change>0n){tx.outputs.push({value:change,scriptPublicKey:p2pk(ownerKey),covenant:null});roles.push('CHANGE');}
  return {...finish(tx,funds,funds.map((_,i)=>i),fee,roles,budgets),origin,cid,transition:{next:s,outputs:[{state:s}]}};
}
