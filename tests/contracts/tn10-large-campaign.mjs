/** Resumable TN10 large-scale Rolling campaign runner & ordinary-UTXO consolidator.
 * Covers:
 *  - 65,536-purchase full round + DRAW + PAY_OLD (`full-payout-b16` / `full-payout-b8`),
 *  - 17-shard refund (`seventeen-shard-refund`: 4,353 buys -> CLOSE -> 136 REFUND_OLD + REFUND_SELF),
 *  - 9-shard refund (`nine-shard-refund`: 2,305 buys -> CLOSE -> 72 REFUND_OLD + REFUND_SELF),
 *  - 17-shard / 9-shard payout batch variants (`seventeen-shard-payout-b16`, `nine-shard-payout-b8`).
 * Note on protocol semantics (Candidate Profile b56bcd9c...c4e5):
 *  - PAY_OLD merges k = 1..16 frozen shards per tx (`--payout-batch=8` or `16`).
 *  - REFUND_OLD strictly targets 1 frozen shard and refunds 32 buyer records per tx (8 txs/shard; MAX_OUTPUTS=36).
 * No import-time wallet access, node connection, or transaction submission. TIMEOUT is never invoked. */
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {txToRpc,RpcError} from '../../scripts/chain/nodes.mjs';
import {commonUtxos,verifyInputsLive,searchAccepted,acceptedAt,matchesDraft,mempoolEntry} from '../../scripts/chain/chain.mjs';
import {jsonText} from '../../scripts/chain/json.mjs';
import {parseFeeEstimate} from '../../scripts/chain/feetiers.mjs';
import {createCliSubmitPermit} from '../../scripts/release-safety.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {quoteMass} from '../../scripts/core.mjs';
import * as S from '../../scripts/core.mjs';
import {p2pk} from '../../scripts/core/lib/covenant-id.js';
import {addressToPubkey} from '../../scripts/wallet/address.mjs';
import {openTestSigner,openDerivedBuyerPool,publicWallets} from './test-signer.mjs';
import {runEngine} from './engine-gate.mjs';
import {acquireWalletLock} from '../web/lock.mjs';
import {connectTN10,durable,execute as executeScenario,plan as scenarioPlan,preflight as basePreflight,readAllReceipts,requiredFee} from './tn10-run.mjs';

const {check,unhex}=S;
const here=dirname(fileURLToPath(import.meta.url));
const runsRoot=join(here,'artifacts','tn10');
const campaignRoot=join(here,'artifacts','tn10-large-campaign');
const lockDir=join(here,'../output/rolling-runs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const LOCK_ROLE={creator:'creator',buyer1:'b1',buyer2:'b2'};
const ROLES_BY_LANE=lane=>lane==='A'?['creator','buyer1']:lane==='B'?['buyer2']:['creator','buyer1','buyer2'];
const BUYER_ROLES_BY_LANE=lane=>lane==='A'?['buyer1']:lane==='B'?['buyer2']:['buyer1','buyer2'];

/** Canonical phase definitions for the large-scale TN10 campaign. */
export const PHASES=Object.freeze({
 'full-payout-b16':Object.freeze({
  id:'full-payout-b16',scenario:'full-payout',payoutBatch:16,expectedTerminal:'PAID',
  shards:256,buys:65536,tickets:65536,oldShardTxCount:16,selfTxCount:0,
  estimatedMinSompi:6850000000000n, // 68,500 TKAS in buyer wallet(s) (matches miner auto-stop target)
  refundCreatesUtxos:0,
  note:'65,536 buys (256 frozen shards) -> CLOSE -> DRAW -> 16 x PAY_OLD(16 shards/tx)',
 }),
 'full-payout-b8':Object.freeze({
  id:'full-payout-b8',scenario:'full-payout',payoutBatch:8,expectedTerminal:'PAID',
  shards:256,buys:65536,tickets:65536,oldShardTxCount:32,selfTxCount:0,
  estimatedMinSompi:6850000000000n,
  refundCreatesUtxos:0,
  note:'65,536 buys (256 frozen shards) -> CLOSE -> DRAW -> 32 x PAY_OLD(8 shards/tx)',
 }),
 'seventeen-shard-refund':Object.freeze({
  id:'seventeen-shard-refund',scenario:'seventeen-shard-refund',payoutBatch:16,expectedTerminal:'REFUNDED',
  shards:17,buys:4353,tickets:4355,oldShardTxCount:136,selfTxCount:1,
  estimatedMinSompi:450000000000n, // ~4,500 TKAS
  refundCreatesUtxos:4353,
  note:'17 frozen shards + 3-ticket tail -> CLOSE -> 136 x REFUND_OLD (1 shard / 32 records per tx) + REFUND_SELF',
 }),
 'nine-shard-refund':Object.freeze({
  id:'nine-shard-refund',scenario:'nine-shard-refund',payoutBatch:16,expectedTerminal:'REFUNDED',
  shards:9,buys:2305,tickets:2307,oldShardTxCount:72,selfTxCount:1,
  estimatedMinSompi:238000000000n, // ~2,380 TKAS (fits in buyer2 ~2,649 TKAS on lane B even after nine-shard-payout-b8)
  refundCreatesUtxos:2305,
  note:'9 frozen shards + 3-ticket tail -> CLOSE -> 72 x REFUND_OLD (1 shard / 32 records per tx) + REFUND_SELF',
 }),
 'seventeen-shard-payout-b16':Object.freeze({
  id:'seventeen-shard-payout-b16',scenario:'seventeen-shard-payout',payoutBatch:16,expectedTerminal:'PAID',
  shards:17,buys:4353,tickets:4355,oldShardTxCount:2,selfTxCount:1,
  estimatedMinSompi:450000000000n,
  refundCreatesUtxos:0,
  note:'17 frozen shards + 3-ticket tail -> CLOSE -> DRAW -> PAY_OLD(16) + PAY_OLD(1) + PAY_SELF',
 }),
 'nine-shard-payout-b8':Object.freeze({
  id:'nine-shard-payout-b8',scenario:'nine-shard-payout',payoutBatch:8,expectedTerminal:'PAID',
  shards:9,buys:2305,tickets:2307,oldShardTxCount:2,selfTxCount:1,
  estimatedMinSompi:238000000000n,
  refundCreatesUtxos:0,
  note:'9 frozen shards + 3-ticket tail -> CLOSE -> DRAW -> PAY_OLD(8) + PAY_OLD(1) + PAY_SELF',
 }),
});

export const DEFAULT_PHASES=['seventeen-shard-refund','nine-shard-payout-b8','nine-shard-refund','full-payout-b16'];

export function resolvePhaseList(spec=null) {
 const ids=spec?spec.split(',').map(s=>s.trim()).filter(Boolean):DEFAULT_PHASES;
 check(ids.length>0,'EMPTY_PHASES');
 return ids.map(id=>{
  check(Object.hasOwn(PHASES,id),`UNKNOWN_PHASE:${id}`);
  const p=PHASES[id],s=scenarioPlan(p.scenario);
  return {...p,totalExpectedTransactions:1+s.buys+1+(p.expectedTerminal==='PAID'?1:0)+p.oldShardTxCount+p.selfTxCount};
 });
}

const parseSaved=raw=>JSON.parse(raw,(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1?('$bigint'in v?BigInt(v.$bigint):'$bytes'in v?unhex(v.$bytes):v):v);
async function readSaved(path) {
 try{return parseSaved(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
}

async function chainCursor(rpc,hash=null,depth=0) {
 let at=hash??(await rpc.call('getSink')).sink;
 for(let n=0;n<512;n++) {
  const b=(await rpc.call('getBlock',{hash:at,includeTransactions:false})).block;check(b?.header?.hash===at,'CURSOR_BLOCK');
  if(b.verboseData?.isChainBlock===true&&depth--<=0)return at;
  at=b.verboseData?.selectedParentHash;unhex(at,32);
 }
 throw new Error('CURSOR_RECOVERY_BOUND');
}

export function normalizeConsolidationDraft(draft) {
 if(!draft?.transaction?.inputs?.some(i=>Object.hasOwn(i,'sigOpCount')))return draft;
 return {
  ...draft,
  transaction:{
   ...draft.transaction,
   inputs:draft.transaction.inputs.map(({sigOpCount:_ignored,...rest})=>{void _ignored;return rest;}),
  },
 };
}

export function buildConsolidationDraft(batch,recipientSpk,feerate='1',{minInputs=2}={}) {
 check(Array.isArray(batch)&&batch.length>=minInputs&&batch.length<=80,'CONSOLIDATE_BATCH_INPUTS');
 const totalIn=batch.reduce((s,u)=>s+u.value,0n);
 let fee=500000n,draft,mass;
 for(let attempt=0;attempt<8;attempt++) {
  check(totalIn>fee,'SWEEP_DUST_BELOW_FEE');
  const tx={
   version:1,
   inputs:batch.map(u=>({previousOutpoint:{...u.outpoint},signatureScript:'',sequence:0n,computeBudget:10})),
   outputs:[{value:totalIn-fee,scriptPublicKey:recipientSpk,covenant:null}],
   lockTime:0n,subnetworkId:'00'.repeat(20),gas:0n,payload:'',storageMass:0n,
  };
  draft={transaction:tx,inputUtxos:batch,authorizedInputIndices:batch.map((_,i)=>i),fee};
  mass=quoteMass(draft);
  const req=requiredFee(mass,feerate);
  if(fee>=req){tx.storageMass=mass.storageMass;break;}
  fee=req;check(attempt<7,'CONSOLIDATE_FEE_CONVERGENCE');
 }
 check(fee<=S.FEE_CAP,'CONSOLIDATE_FEE_CAP');
 return {draft,mass};
}

async function waitConsolidationAccepted(rpc,intent,{pollMs=1000,timeoutMs=180000,recover=false}={}) {
 const expectedDraft=normalizeConsolidationDraft(intent.draft);
 const until=Date.now()+timeoutMs;let cursor=intent.cursor,reconciled=false;
 while(Date.now()<until) {
  try {
   let found;
   try{found=await searchAccepted(rpc,intent.txid,cursor,{pages:4});}
   catch(e){if((e.code??e.safeCode)!=='CURSOR_REORG')throw e;found=await searchAccepted(rpc,intent.txid,await chainCursor(rpc,cursor),{pages:4});}
   cursor=found.cursor;
   if(recover&&!reconciled&&!found.accepting&&found.complete) {
    reconciled=true;
    if(!await mempoolEntry(rpc,intent.txid)) {
     check(intent.status!=='REJECTED','CONSOLIDATION_REJECTED_REQUIRES_REVIEW');
     const wire=txToRpc(expectedDraft.transaction);
     const digest=createHash('sha256').update(jsonText(wire)).digest('hex');
     check(digest===intent.wireDigest,'CONSOLIDATION_WIRE_CHANGED');
     try {
      await verifyInputsLive(rpc,expectedDraft.inputUtxos,{allowDaaDrift:true});
      const permit=createCliSubmitPermit(TN10,req=>check(createHash('sha256').update(jsonText(req.transaction)).digest('hex')===digest,'SUBMIT_CONTENT_CHANGED'));
      await rpc.call('submitTransaction',{transaction:wire,allowOrphan:false},30000,{submitPermit:permit});
     }catch(e){if((e.code??e.safeCode)!=='STALE_INPUT')throw e;}
    }
   }
   if(found.accepting) {
    const ev=await acceptedAt(rpc,intent.txid,found.accepting);
    const actualFee=matchesDraft(ev,expectedDraft);
    return {txid:intent.txid,acceptingBlock:found.accepting,acceptingDaa:ev.acceptingDaa.toString(),feeSompi:actualFee.toString()};
   }
  }catch(e){if(!['NOT_CHAIN','REORG','CURSOR_REORG','NOT_ACCEPTED','SINK_BEHIND','RPC_TIMEOUT','READ_VIEW_CHANGED'].includes(e.code??e.safeCode??e.message))throw e;}
  await sleep(pollMs);
 }
 throw new Error('CONSOLIDATION_ACCEPTANCE_TIMEOUT');
}

async function mempoolSendingOutpoints(rpc,address) {
 const res=await rpc.call('getMempoolEntriesByAddresses',{addresses:[address],includeOrphanPool:true,filterTransactionPool:false});
 const out=new Set();
 for(const entry of res?.entries??[])for(const s of entry?.sending??[])for(const inp of s?.transaction?.inputs??[]) {
  const op=inp?.previousOutpoint;if(op?.transactionId!=null&&op?.index!=null)out.add(`${op.transactionId}:${Number(op.index)}`);
 }
 return out;
}

async function buildConsolidationWithFallback(rpc,batch,recipientSpk,opts={}) {
 const feeInfo=parseFeeEstimate(await rpc.call('getFeeEstimate'));
 const rates=[String(Math.max(1,Math.ceil(feeInfo.normal.feerate)))];
 const low=String(Math.max(1,Math.ceil(feeInfo.low?.feerate??1)));
 if(!rates.includes(low))rates.push(low);
 if(!rates.includes('1'))rates.push('1');
 let lastErr;
 for(const rate of rates) {
  try{return buildConsolidationDraft(batch,recipientSpk,rate,opts);}
  catch(e){
   lastErr=e;
   const c=e?.code??e?.safeCode??e?.message;
   if(!['CONSOLIDATE_FEE_CAP','CONSOLIDATE_FEE_CONVERGENCE','SWEEP_DUST_BELOW_FEE','MASS_VALUES','MASS_FEE'].includes(c))throw e;
  }
 }
 throw lastErr;
}

/** Sweep ordinary UTXOs from deterministically derived TN10 buyer-pool addresses back to their base dedicated wallet. */
export async function sweepDerivedBuyers({rpc,baseRole,count=64,dir,batchSize=80,pollMs=1000}={}) {
 check(Object.hasOwn(LOCK_ROLE,baseRole),'WALLET_ROLE');
 check(Number.isSafeInteger(count)&&count>=1&&count<=256,'BUYER_POOL_SIZE');
 check(Number.isSafeInteger(batchSize)&&batchSize>=1&&batchSize<=80,'CONSOLIDATE_BATCH_SIZE');
 await mkdir(dir,{recursive:true,mode:0o700});
 const intentPath=join(dir,`sweep-derived-${baseRole}-intent.json`);
 const release=acquireWalletLock(lockDir,LOCK_ROLE[baseRole],`sweep-derived ${baseRole}`);
 const spentInSession=new Set();
 let pool;
 try {
  const pending=await readSaved(intentPath);
  if(pending&&pending.status!=='ACCEPTED') {
   const rec=await waitConsolidationAccepted(rpc,pending,{pollMs,recover:true});
   pending.draft=normalizeConsolidationDraft(pending.draft);
   pending.status='ACCEPTED';pending.receipt=rec;await durable(intentPath,pending);
   for(const inp of pending.draft.transaction.inputs)spentInSession.add(`${inp.previousOutpoint.transactionId}:${inp.previousOutpoint.index}`);
  }
  pool=await openDerivedBuyerPool(baseRole,count,TN10.networkId);
  const baseSpk=p2pk(addressToPubkey(pool.baseAddress));
  const byAddr=new Map();
  for(let i=0;i<pool.entries.length;i+=64) {
   const chunk=pool.entries.slice(i,i+64);
   const res=await rpc.call('getUtxosByAddresses',{addresses:chunk.map(e=>e.address)});
   for(const raw of res?.entries??[]) {
    const e=raw.utxoEntry;if(!e||e.isCoinbase||e.covenantId)continue;
    const val=BigInt(e.amount);if(val<=0n)continue;
    const op={transactionId:raw.outpoint.transactionId,index:Number(raw.outpoint.index)};
    if(spentInSession.has(`${op.transactionId}:${op.index}`))continue;
    const entry=chunk.find(x=>x.address===raw.address);if(!entry)continue;
    const list=byAddr.get(entry.index)??[];
    list.push({outpoint:op,value:val,spk:entry.spk,daa:BigInt(e.blockDaaScore),utxoDaa:BigInt(e.blockDaaScore),covenantId:null,isCoinbase:false});
    byAddr.set(entry.index,list);
   }
  }
  const batches=[];let sweptSompi=0n,skippedDust=0;
  for(const [index,utxos] of byAddr.entries()) {
   const entry=pool.entries[index];
   const sending=await mempoolSendingOutpoints(rpc,entry.address);
   const spendable=utxos.filter(u=>!sending.has(`${u.outpoint.transactionId}:${u.outpoint.index}`)&&!spentInSession.has(`${u.outpoint.transactionId}:${u.outpoint.index}`))
    .sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0);
   for(let offset=0;offset<spendable.length;offset+=batchSize) {
    const batch=spendable.slice(offset,offset+batchSize);
    let built;
    try{built=await buildConsolidationWithFallback(rpc,batch,baseSpk,{minInputs:1});}
    catch(e){
     if((e?.code??e?.safeCode??e?.message)==='SWEEP_DUST_BELOW_FEE'){skippedDust+=batch.length;continue;}
     throw e;
    }
    const {draft,mass}=built;
    await verifyInputsLive(rpc,draft.inputUtxos,{allowDaaDrift:true});
    await pool.signSweep(index,draft);
    if(process.env.KASWIN_VM_BIN)runEngine(draft,{limited:true});
    const cursor=await chainCursor(rpc,null,32),txid=referenceTxId(draft.transaction);
    const wire=txToRpc(draft.transaction),wireDigest=createHash('sha256').update(jsonText(wire)).digest('hex');
    const intent={role:baseRole,derivedIndex:index,derivedAddress:entry.address,network:TN10.networkId,txid,wireDigest,cursor,status:'PREPARED',draft,mass};
    await durable(intentPath,intent);
    let sent=false;
    try {
     const permit=createCliSubmitPermit(TN10,req=>check(createHash('sha256').update(jsonText(req.transaction)).digest('hex')===wireDigest,'SUBMIT_CONTENT_CHANGED'));
     await rpc.call('submitTransaction',{transaction:wire,allowOrphan:false},30000,{submitPermit:permit,beforeSend:()=>{sent=true;}});
     intent.status='SUBMITTED';await durable(intentPath,intent);
    }catch(e) {
     intent.status=!sent?'UNSENT':e instanceof RpcError?'REJECTED':'UNKNOWN';
     await durable(intentPath,intent);throw e;
    }
    const rec=await waitConsolidationAccepted(rpc,intent,{pollMs});
    intent.status='ACCEPTED';intent.receipt=rec;await durable(intentPath,intent);
    for(const inp of draft.transaction.inputs)spentInSession.add(`${inp.previousOutpoint.transactionId}:${inp.previousOutpoint.index}`);
    const outValue=draft.transaction.outputs[0].value;
    sweptSompi+=outValue;
    batches.push({...rec,derivedIndex:index,mergedInputs:batch.length,sweptSompi:outValue.toString()});
    console.log(JSON.stringify({sweptDerived:baseRole,derivedIndex:index,txid:rec.txid,mergedInputs:batch.length,sweptSompi:outValue.toString(),feeSompi:rec.feeSompi}));
    await sleep(300);
   }
  }
  return {baseRole,baseAddress:pool.baseAddress,poolSize:count,fundedAddresses:byAddr.size,sweptSompi:sweptSompi.toString(),skippedDust,batches};
 }finally{pool?.close();release();}
}

/** Merge fragmented ordinary UTXOs (smallest first, <=80 inputs/tx) so refund outputs never push an address past commonUtxos's 5,000 limit. */
export async function consolidateWalletUtxos({rpc,role,dir,maxOrdinaryUtxos=800,batchSize=80,pollMs=1000}={}) {
 check(Object.hasOwn(LOCK_ROLE,role),'WALLET_ROLE');
 check(Number.isSafeInteger(maxOrdinaryUtxos)&&maxOrdinaryUtxos>=50&&maxOrdinaryUtxos<=4500,'MAX_ORDINARY_UTXOS');
 check(Number.isSafeInteger(batchSize)&&batchSize>=10&&batchSize<=80,'CONSOLIDATE_BATCH_SIZE');
 await mkdir(dir,{recursive:true,mode:0o700});
 const intentPath=join(dir,`consolidate-${role}-intent.json`);
 const release=acquireWalletLock(lockDir,LOCK_ROLE[role],`consolidate ${role}`);
 const spentInSession=new Set();
 let signer;
 try {
  const pending=await readSaved(intentPath);
  if(pending&&pending.status!=='ACCEPTED') {
   const rec=await waitConsolidationAccepted(rpc,pending,{pollMs,recover:true});
   pending.draft=normalizeConsolidationDraft(pending.draft);
   pending.status='ACCEPTED';pending.receipt=rec;await durable(intentPath,pending);
   for(const inp of pending.draft.transaction.inputs)spentInSession.add(`${inp.previousOutpoint.transactionId}:${inp.previousOutpoint.index}`);
  }
  const wallet=publicWallets().find(w=>w.role===role);
  let ordinary=(await commonUtxos(rpc,wallet.address)).filter(u=>!u.isCoinbase&&!u.covenantId&&u.value>0n&&!spentInSession.has(`${u.outpoint.transactionId}:${u.outpoint.index}`));
  if(ordinary.length<=maxOrdinaryUtxos)return {role,before:ordinary.length,after:ordinary.length,batches:[]};
  const before=ordinary.length,batches=[];
  signer=await openTestSigner(role,TN10.networkId);
  while(ordinary.length>maxOrdinaryUtxos) {
   const sending=await mempoolSendingOutpoints(rpc,signer.address);
   const spendable=ordinary.filter(u=>!sending.has(`${u.outpoint.transactionId}:${u.outpoint.index}`)&&!spentInSession.has(`${u.outpoint.transactionId}:${u.outpoint.index}`))
    .sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0);
   if(spendable.length<2)break;
   const batch=spendable.slice(0,Math.min(batchSize,spendable.length)).map(u=>({...u,utxoDaa:u.daa,covenantId:null}));
   const {draft,mass}=await buildConsolidationWithFallback(rpc,batch,signer.spk,{minInputs:2});
   await verifyInputsLive(rpc,draft.inputUtxos,{allowDaaDrift:true});
   await signer.sign(draft);
   if(process.env.KASWIN_VM_BIN)runEngine(draft,{limited:true});
   const cursor=await chainCursor(rpc,null,32),txid=referenceTxId(draft.transaction);
   const wire=txToRpc(draft.transaction),wireDigest=createHash('sha256').update(jsonText(wire)).digest('hex');
   const intent={role,network:TN10.networkId,txid,wireDigest,cursor,status:'PREPARED',draft,mass};
   await durable(intentPath,intent);
   let sent=false;
   try {
    const permit=createCliSubmitPermit(TN10,req=>check(createHash('sha256').update(jsonText(req.transaction)).digest('hex')===wireDigest,'SUBMIT_CONTENT_CHANGED'));
    await rpc.call('submitTransaction',{transaction:wire,allowOrphan:false},30000,{submitPermit:permit,beforeSend:()=>{sent=true;}});
    intent.status='SUBMITTED';await durable(intentPath,intent);
   }catch(e) {
    intent.status=!sent?'UNSENT':e instanceof RpcError?'REJECTED':'UNKNOWN';
    await durable(intentPath,intent);throw e;
   }
   const rec=await waitConsolidationAccepted(rpc,intent,{pollMs});
   intent.status='ACCEPTED';intent.receipt=rec;await durable(intentPath,intent);
   for(const inp of draft.transaction.inputs)spentInSession.add(`${inp.previousOutpoint.transactionId}:${inp.previousOutpoint.index}`);
   batches.push({...rec,mergedInputs:batch.length});
   console.log(JSON.stringify({consolidated:role,txid:rec.txid,mergedInputs:batch.length,feeSompi:rec.feeSompi}));
   await sleep(400);
   ordinary=(await commonUtxos(rpc,wallet.address)).filter(u=>!u.isCoinbase&&!u.covenantId&&u.value>0n&&!spentInSession.has(`${u.outpoint.transactionId}:${u.outpoint.index}`));
  }
  return {role,before,after:ordinary.length,batches};
 }finally{signer?.close();release();}
}

async function latestScenarioRunDir(scenario,lane) {
 try {
  const dirs=(await readdir(runsRoot,{withFileTypes:true})).filter(d=>d.isDirectory()&&d.name.startsWith(`${scenario}-`)).map(d=>d.name).sort();
  for(let i=dirs.length-1;i>=0;i--) {
   const full=join(runsRoot,dirs[i]),st=await readSaved(join(full,'state.json'));
   if(st&&st.scenario===scenario&&(st.lane??null)===(lane??null)&&!st.terminal)return full;
  }
 }catch(e){if(e.code!=='ENOENT')throw e;}
 return null;
}

const TRANSIENT_RUN_ERRORS=new Set(['RPC_TIMEOUT','NODE_DISCONNECTED','NODE_CLOSED','ACCEPTANCE_UNKNOWN_RESUME_SAME_INTENT','SINK_BEHIND','READ_VIEW_CHANGED']);
export const isTransientRunError=code=>TRANSIENT_RUN_ERRORS.has(code)||/^(?:无法连接：|节点连接超时|节点断开|RPC_TIMEOUT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND)/.test(String(code??''));

export async function preflightCampaign({node=null,phases=null,lane=null}={}) {
 const list=resolvePhaseList(phases),info=await basePreflight({node});
 const byRole=new Map(info.wallets.map(w=>[w.role,{...w,sompi:BigInt(w.balanceSompi)}]));
 const roles=ROLES_BY_LANE(lane),buyerRoles=BUYER_ROLES_BY_LANE(lane);
 const buyerSompi=buyerRoles.reduce((s,r)=>s+(byRole.get(r)?.sompi??0n),0n);
 const readiness=list.map(p=>({
  phase:p.id,scenario:p.scenario,payoutBatch:p.payoutBatch,expectedTransactions:p.totalExpectedTransactions,
  estimatedMinSompi:p.estimatedMinSompi.toString(),laneRoles:roles,buyerRoles,buyerSompi:buyerSompi.toString(),
  balanceSufficient:buyerSompi>=p.estimatedMinSompi,
  needsConsolidationBefore:roles.filter(r=>(byRole.get(r)?.ordinaryUtxos??0)+p.refundCreatesUtxos>4200),
 }));
 const summary={...info,lane,readiness};
 console.log(JSON.stringify(summary,null,2));
 return summary;
}

async function readBuyerSompi(rpc,lane) {
 let sum=0n;
 for(const role of BUYER_ROLES_BY_LANE(lane)) {
  const w=publicWallets().find(x=>x.role===role);
  const us=(await commonUtxos(rpc,w.address)).filter(u=>!u.isCoinbase&&!u.covenantId);
  sum+=us.reduce((s,u)=>s+u.value,0n);
 }
 return sum;
}

export async function runCampaign({phases=null,lane=null,node=null,pollMs=500,maxOrdinaryUtxos=150,skipConsolidate=false,waitBalanceMinutes=0,skipReorgRecheck=false,buyerPool=64,campaignId='default'}={}) {
 check(process.env.KASWIN_VM_BIN,'KASWIN_VM_BIN_REQUIRED');
 check(lane===null||lane==='A'||lane==='B','LANE');
 check(Number.isSafeInteger(waitBalanceMinutes)&&waitBalanceMinutes>=0&&waitBalanceMinutes<=1440,'WAIT_BALANCE_MINUTES');
 check(Number.isSafeInteger(buyerPool)&&buyerPool>=0&&buyerPool<=256,'BUYER_POOL_SIZE');
 check(/^[a-zA-Z0-9_-]{1,64}$/.test(campaignId),'CAMPAIGN_ID');
 const list=resolvePhaseList(phases);
 const dir=join(campaignRoot,campaignId);await mkdir(dir,{recursive:true,mode:0o700});
 const statusPath=join(dir,'status.json');
 const status=(await readSaved(statusPath))??{schema:'TN10_LARGE_CAMPAIGN_V1',campaignId,lane,startedAt:new Date().toISOString(),phases:{}};
 check((status.lane??null)===(lane??null),'CAMPAIGN_LANE_MISMATCH');

 for(const p of list) {
  const rec=status.phases[p.id]??{phase:p.id,scenario:p.scenario,payoutBatch:p.payoutBatch,completed:false,runDir:null,attempts:0,consolidations:[],sweeps:[]};
  rec.sweeps??=[];
  status.phases[p.id]=rec;
  if(rec.completed)continue;

  if(!skipConsolidate) {
   const rpc=await connectTN10(node);
   try {
    if(buyerPool>0) {
     for(const baseRole of BUYER_ROLES_BY_LANE(lane)) {
      const sw=await sweepDerivedBuyers({rpc,baseRole,count:buyerPool,dir,pollMs});
      if(sw.batches.length)rec.sweeps.push({at:new Date().toISOString(),when:'before',baseRole,sweptSompi:sw.sweptSompi,batches:sw.batches.length});
     }
    }
    for(const role of ROLES_BY_LANE(lane)) {
     const c=await consolidateWalletUtxos({rpc,role,dir,maxOrdinaryUtxos,pollMs});
     if(c.batches.length)rec.consolidations.push({at:new Date().toISOString(),...c});
    }
   }finally{rpc.close();}
   await durable(statusPath,status);
  }

  if(!rec.runDir) {
   const existing=await latestScenarioRunDir(p.scenario,lane);
   if(existing){rec.runDir=existing;await durable(statusPath,status);}
  }
  // Verify buyer funding sufficiency before starting a brand-new round (resuming an existing round must always be allowed to settle).
  if(!rec.runDir) {
   const deadline=Date.now()+waitBalanceMinutes*60000;
   for(;;) {
    const rpc=await connectTN10(node);
    let sum;try{sum=await readBuyerSompi(rpc,lane);}finally{rpc.close();}
    if(sum>=p.estimatedMinSompi)break;
    check(Date.now()<deadline,`INSUFFICIENT_BUYER_BALANCE:${p.id}:have=${sum}:need=${p.estimatedMinSompi}`);
    console.log(JSON.stringify({waitingForBuyerBalance:p.id,haveSompi:sum.toString(),needSompi:p.estimatedMinSompi.toString()}));
    await sleep(30000);
   }
   if(!skipConsolidate&&waitBalanceMinutes>0) {
    const rpc=await connectTN10(node);
    try {
     for(const role of BUYER_ROLES_BY_LANE(lane)) {
      const c=await consolidateWalletUtxos({rpc,role,dir,maxOrdinaryUtxos,pollMs});
      if(c.batches.length)rec.consolidations.push({at:new Date().toISOString(),...c});
     }
    }finally{rpc.close();}
    await durable(statusPath,status);
   }
  }

  for(;;) {
   rec.attempts++;rec.lastStartedAt=new Date().toISOString();await durable(statusPath,status);
   try {
    const res=await executeScenario({
     scenario:p.scenario,
     resume:rec.runDir,
     maxSteps:scenarioPlan(p.scenario).defaultMaxSteps??70000,
     lane,
     pollMs,
     node,
     payoutBatch:p.payoutBatch,
     skipReorgRecheck,
     buyerPool,
     onRunDir:async runDir=>{if(rec.runDir!==runDir){rec.runDir=runDir;await durable(statusPath,status);}},
    });
    rec.runDir=res.run;
    if(res.stopped) {
     await durable(statusPath,status);
     return status;
    }
    const allReceipts=await readAllReceipts(res.run);
    check(res.completed&&res.terminal===p.expectedTerminal&&res.allAccepted&&allReceipts.every(r=>r.finalized!==false),'PHASE_INCOMPLETE_OR_UNFINALIZED');
    if(buyerPool>0) {
     const rpc=await connectTN10(node);
     try {
      for(const baseRole of BUYER_ROLES_BY_LANE(lane)) {
       const sw=await sweepDerivedBuyers({rpc,baseRole,count:buyerPool,dir,pollMs});
       if(sw.batches.length)rec.sweeps.push({at:new Date().toISOString(),when:'after',baseRole,sweptSompi:sw.sweptSompi,batches:sw.batches.length});
      }
     }finally{rpc.close();}
    }
    rec.completed=true;rec.terminal=res.terminal;rec.transactions=res.transactions;rec.finishedAt=new Date().toISOString();
    await durable(statusPath,status);
    console.log(JSON.stringify({phaseCompleted:p.id,run:res.run,terminal:res.terminal,transactions:res.transactions}));
    break;
   }catch(e) {
    const code=e?.code??e?.safeCode??e?.message??'UNKNOWN_ERROR';
    if(!rec.runDir)rec.runDir=await latestScenarioRunDir(p.scenario,lane);
    rec.lastError={code,at:new Date().toISOString()};await durable(statusPath,status);
    if(!isTransientRunError(code)||rec.attempts>=50)throw e;
    console.warn(JSON.stringify({phaseTransientRetry:p.id,code,runDir:rec.runDir,attempt:rec.attempts}));
    await sleep(10000);
   }
  }
 }
 status.finishedAt=new Date().toISOString();await durable(statusPath,status);
 return status;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const arg=n=>process.argv.find(x=>x.startsWith(`--${n}=`))?.slice(n.length+3);
 const phases=arg('phases')??null,lane=arg('lane')??null,node=arg('node')??null;
 const maxOrdinaryUtxos=arg('max-utxos')?Number(arg('max-utxos')):150;
 const pollMs=arg('poll-ms')?Number(arg('poll-ms')):500;
 const waitBalanceMinutes=arg('wait-balance-min')?Number(arg('wait-balance-min')):0;
 const buyerPool=arg('buyer-pool')!=null?Number(arg('buyer-pool')):64;
 try {
  if(process.argv.includes('--plan')) {
   console.log(JSON.stringify(resolvePhaseList(phases),(_,v)=>typeof v==='bigint'?v.toString():v,2));
  } else if(process.argv.includes('--preflight')) {
   await preflightCampaign({node,phases,lane});
  } else if(process.argv.includes('--consolidate-only')) {
   const roles=(arg('roles')??ROLES_BY_LANE(lane).join(',')).split(',').map(s=>s.trim()).filter(Boolean);
   const dir=join(campaignRoot,arg('campaign')??'manual-consolidate');
   const rpc=await connectTN10(node);
   try {
    const out=[];for(const role of roles)out.push(await consolidateWalletUtxos({rpc,role,dir,maxOrdinaryUtxos,pollMs}));
    console.log(JSON.stringify(out,null,2));
   }finally{rpc.close();}
  } else if(process.argv.includes('--sweep-derived')) {
   const roles=(arg('roles')??BUYER_ROLES_BY_LANE(lane).join(',')).split(',').map(s=>s.trim()).filter(Boolean);
   const dir=join(campaignRoot,arg('campaign')??'manual-sweep');
   const rpc=await connectTN10(node);
   try {
    const out=[];for(const baseRole of roles)out.push(await sweepDerivedBuyers({rpc,baseRole,count:buyerPool,dir,pollMs}));
    console.log(JSON.stringify(out,null,2));
   }finally{rpc.close();}
  } else {
   check(process.argv.includes('--execute'),'EXPLICIT_MODE_REQUIRED (--plan | --preflight | --consolidate-only | --sweep-derived | --execute)');
   const out=await runCampaign({phases,lane,node,pollMs,maxOrdinaryUtxos,skipConsolidate:process.argv.includes('--skip-consolidate'),waitBalanceMinutes,skipReorgRecheck:process.argv.includes('--skip-reorg-recheck'),buyerPool,campaignId:arg('campaign')??(lane?`lane-${lane}`:'default')});
   console.log(JSON.stringify({campaignId:out.campaignId,finishedAt:out.finishedAt,phases:Object.keys(out.phases)}));
  }
 }catch(e){console.error(e?.code??e?.safeCode??e?.message??e);process.exitCode=1;}
}
