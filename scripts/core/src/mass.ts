/** Candidate full-transaction mass quotation. TypeScript port of experiments/rolling/mass.mjs (itself ported from scripts/chain/mass.mjs).
 * Explicit budgets are inputs, NOT measured VM usage. No production-budget default.
 * Parameters below reference cfafeb4; target-node compatibility remains NOT_RUN. Source candidate; NOT_RUN. */
import {check,integer,unhex} from './bytes.js';
import type {Spk} from './covenant-id.js';
import {validateTransaction,outpointKey} from './transaction.js';
import {VALUE_LIMIT,FEE_CAP,PAY_FEE_CAP} from './state.js';
import type {DraftBase} from './transactions.js';

/** Only the fields mass arithmetic reads: any full Draft satisfies it. */
export type MassDraft=Pick<DraftBase,'transaction'|'inputUtxos'|'authorizedInputIndices'|'fee'>;
export interface MassQuote {
  size:bigint;computeMass:bigint;transientMass:bigint;normalizedTransient:bigint;storageMass:bigint;feeMass:bigint;
  orderingMass:bigint;relayFloor:bigint;budgetsMeasured:false;
}
const C=1000000000000n,U64=(1n<<64n)-1n;
const byteLen=(h:string):bigint=>BigInt(unhex(h).length);
const plurality=(spk:Spk,covenant:boolean):bigint=>(63n+byteLen(spk.script)+(covenant?32n:0n)+99n)/100n;
const max=(...xs:bigint[]):bigint=>xs.reduce((a,b)=>a>b?a:b);
export function massOf(draft:MassDraft):MassQuote {
  const t=draft.transaction;validateTransaction(t);
  check(t.version===1&&t.subnetworkId==='00'.repeat(20)&&t.gas===0n,'NATIVE_V1');
  check(draft.inputUtxos.length===t.inputs.length,'UTXO_CONTEXT');
  const auth=new Set(draft.authorizedInputIndices);check(auth.size===draft.authorizedInputIndices.length,'SIGN_INDEX_DUPLICATE');
  for(const i of auth)integer(i,0,t.inputs.length-1);
  let size=2n+8n+8n+8n+20n+8n+32n+8n+byteLen(t.payload),budget=0n,spkBytes=0n;
  t.inputs.forEach((i,n)=>{
    check(outpointKey(i.previousOutpoint)===outpointKey(draft.inputUtxos[n]!.outpoint),'UTXO_OUTPOINT');
    integer(i.computeBudget??NaN,0,65535);budget+=BigInt(i.computeBudget!);
    const sig=auth.has(n)?66n:byteLen(i.signatureScript);check(sig<=250000n,'SIGSCRIPT_LIMIT');
    size+=32n+4n+8n+sig+8n+2n;
  });
  for(const o of t.outputs){const len=byteLen(o.scriptPublicKey.script);size+=8n+2n+8n+len+(o.covenant?34n:0n);spkBytes+=2n+len;}
  const ins=draft.inputUtxos.map(f=>({p:plurality(f.spk,!!f.covenantId&&f.covenantId!=='00'.repeat(32)),v:f.value}));
  const outs=t.outputs.map(o=>({p:plurality(o.scriptPublicKey,!!o.covenant),v:o.value}));
  check(ins.length>0&&outs.length>0&&[...ins,...outs].every(c=>typeof c.v==='bigint'&&c.v>0n&&c.v<=VALUE_LIMIT),'MASS_VALUES');
  const inputTotal=ins.reduce((v,i)=>v+i.v,0n),outputTotal=outs.reduce((v,o)=>v+o.v,0n);check(inputTotal-outputTotal===draft.fee&&draft.fee>0n,'MASS_FEE');
  const ip=ins.reduce((v,i)=>v+i.p,0n),op=outs.reduce((v,o)=>v+o.p,0n);
  const harmonicOut=outs.reduce((v,o)=>v+C*o.p*o.p/o.v,0n);check(harmonicOut<=U64,'MASS_OVERFLOW');
  const relaxed=op===1n||(ins.length<=2&&(ip===1n||(op===2n&&ip===2n)));
  let subtract:bigint;
  if(relaxed)subtract=ins.reduce((v,i)=>v+C*i.p*i.p/i.v,0n);
  else subtract=ip*(C/max(inputTotal/ip,1n));
  if(subtract>U64)subtract=U64;
  const storageMass=max(harmonicOut-subtract,0n),computeMass=size+10n*spkBytes+100n*budget,transientMass=4n*size;
  const normalizedTransient=(transientMass+1n)/2n,feeMass=max(computeMass,normalizedTransient);
  return {size,computeMass,transientMass,normalizedTransient,storageMass,feeMass,orderingMass:max(feeMass,storageMass),relayFloor:max(100000n,feeMass*100n),budgetsMeasured:false};
}
export class ResourceLimit extends Error {
  readonly code:string;readonly quote:MassQuote|null;
  constructor(code:string,quote:MassQuote|null){super(code);this.code=code;this.quote=quote;}
}
export function quoteMass(draft:MassDraft):MassQuote {
  const q=massOf(draft);
  if(q.computeMass>500000n)throw new ResourceLimit('COMPUTE_MASS_LIMIT',q);
  if(q.transientMass>1000000n)throw new ResourceLimit('TRANSIENT_MASS_LIMIT',q);
  if(q.storageMass>500000n)throw new ResourceLimit('STORAGE_MASS_LIMIT',q);
  return q;
}
export interface FeeResult<D extends MassDraft> {draft:D;quote:MassQuote;fee:bigint;status:'UNMEASURED_BUDGET_QUOTE';}
/** Feerate is an exact decimal STRING, never Number. No conversion of amounts to floats. */
export function convergeFee<D extends MassDraft>(makeDraft:(fee:bigint)=>D,rate:string,{cap=FEE_CAP}:{cap?:bigint}={}):FeeResult<D> {
  check(typeof rate==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(rate),'FEE_RATE');
  check(typeof cap==='bigint'&&cap>0n&&cap<=PAY_FEE_CAP,'FEE_CAP');
  const [a='',b='']=rate.split('.'),n=BigInt(a+b),d=10n**BigInt(b.length);check(n>0n,'FEE_RATE_ZERO');
  let fee=100000n;
  for(let attempt=0;attempt<24;attempt++){
    if(fee>cap)throw new ResourceLimit('FEE_CAP',null);
    const draft=makeDraft(fee),q=quoteMass(draft);check(draft.fee===fee,'QUOTE_FEE');
    const required=max(q.relayFloor,(q.orderingMass*n+d-1n)/d);
    if(required>cap)throw new ResourceLimit('FEE_CAP',q);
    if(fee>=required){draft.transaction.storageMass=q.storageMass;return {draft,quote:q,fee,status:'UNMEASURED_BUDGET_QUOTE'};}
    fee=required;
  }
  throw new ResourceLimit('FEE_DID_NOT_CONVERGE',null);
}
/** Only resource/fee excess permits reducing k. Invalid proofs/state stop immediately. */
export function choosePayoutBatch<D extends MassDraft>(available:number,makeDraft:(k:number,fee:bigint)=>D,rate:string):FeeResult<D>&{k:number} {
  integer(available,1,16);let failure:unknown;
  for(let k=available;k>=1;k--){
    try{return {k,...convergeFee(fee=>makeDraft(k,fee),rate,{cap:PAY_FEE_CAP})};}
    catch(e){if(!(e instanceof ResourceLimit))throw e;failure=e;}
  }
  throw failure;
}
