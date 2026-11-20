/** Resumable, explicitly invoked TN10-only rolling experiment. See TN10-DEPLOYMENT.md.
 * --preflight reads public node/wallet balances only. --execute --scenario=empty|refund|payout|shard-payout|shard-refund|multi-payout|multi-refund|batch-payout|seventeen-shard-payout|nine-shard-payout|three-shard-refund|eight-shard-refund|nine-shard-refund|seventeen-shard-refund|full-payout|full-refund [--payout-batch=1..16]
 * requires KASWIN_VM_BIN. --resume=<run directory> reconciles persisted signed intent before advancing.
 * No import-time wallet access, signatures, node connection or broadcast. */
import {mkdir,readFile,open,rename,unlink,readdir,stat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {probeNode,txToRpc,RpcError} from '../../scripts/chain/nodes.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {checkServerIdentity} from '../../scripts/chain/node-identity.mjs';
import {commonUtxos,verifyInputsLive,searchAccepted,acceptedAt,matchesDraft,mempoolEntry} from '../../scripts/chain/chain.mjs';
import {jsonText} from '../../scripts/chain/json.mjs';
import {createCliSubmitPermit} from '../../scripts/release-safety.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {parseFeeEstimate} from '../../scripts/chain/feetiers.mjs';
import {addressToPubkey} from '../../scripts/wallet/address.mjs';
import {blake2b256} from '../../scripts/core/lib/hashes.js';
import {loadDeploymentProfile,TN10_PROFILE_ID} from '../../scripts/contract/bundle.mjs';
import {openTestSigner,openDerivedBuyerPool,publicWallets} from './test-signer.mjs';
import {runEngine,measuredBudgets} from './engine-gate.mjs';
import {buildAction,buildGenesis,drawSample} from '../../scripts/core.mjs';
import {redeem,identify,verifyManager} from '../../scripts/core.mjs';
import {quoteMass} from '../../scripts/core.mjs';
import {acquireRollingProof} from '../../scripts/round/draw-proof.mjs';
import {drawTargetFromOpening,requireConfirmedDrawTarget,assertFreshDrawConfirmation} from '../../scripts/round/draw-confirmations.mjs';
import {acquireWalletLock} from '../web/lock.mjs';
import * as S from '../../scripts/core.mjs';
const {check,hex,unhex}=S;
const here=dirname(fileURLToPath(import.meta.url)),root=join(here,'artifacts','tn10');
const endpoint='ws://127.0.0.1:18210';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const encodeRunJson=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{$bigint:v.toString()}:v instanceof Uint8Array?{$bytes:hex(v)}:v,2)+'\n';
export const decodeRunJson=value=>JSON.parse(value,(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1?('$bigint'in v?BigInt(v.$bigint):'$bytes'in v?unhex(v.$bytes):v):v);
const text=encodeRunJson;
const parse=decodeRunJson;
export async function durable(path,value) {
 await mkdir(dirname(path),{recursive:true,mode:0o700});const tmp=path+'.'+randomUUID()+'.tmp';
 const f=await open(tmp,'wx',0o600);try{await f.writeFile(text(value));await f.sync();}finally{await f.close();}
 await rename(tmp,path);const d=await open(dirname(path),'r');try{await d.sync();}finally{await d.close();}
}
const read=async path=>parse(await readFile(path,'utf8'));
async function appendNdjson(path,rows) {
 if(!rows.length)return;
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const f=await open(path,'a',0o600);
 try{await f.writeFile(rows.map(r=>JSON.stringify(r)).join('\n')+'\n');await f.sync();}finally{await f.close();}
}
export async function readAllReceipts(dir,state=null) {
 const s=state??await read(join(dir,'state.json'));
 const byTx=new Map();
 try {
  const raw=await readFile(join(dir,'receipts.ndjson'),'utf8');
  for(const line of raw.split('\n'))if(line.trim()){const r=JSON.parse(line);byTx.set(r.txid,r);}
 }catch(e){if(e.code!=='ENOENT')throw e;}
 for(const r of s.receipts??[])if(!byTx.has(r.txid)||r.finalized===true)byTx.set(r.txid,r);
 const stepOf=r=>{const m=/(\d+)-intent\.json$/.exec(r?.intentFile??'');return m?Number(m[1]):Number.MAX_SAFE_INTEGER;};
 return [...byTx.values()].map((r,idx)=>({r,idx,step:stepOf(r)})).sort((a,b)=>a.step-b.step||a.idx-b.idx).map(x=>x.r);
}
export async function saveRunState(dir,state) {
 const done=[],keep=[];
 for(const r of state.receipts??[])(r.finalized===true?done:keep).push(r);
 if(done.length){await appendNdjson(join(dir,'receipts.ndjson'),done);state.receipts=keep;}
 const frozenOut=[];
 for(const f of state.frozen??[]) {
  const rel=f.redeemFile??`frozen/${f.outpoint.transactionId}-${f.outpoint.index}.bin`;
  if(f.redeemScript instanceof Uint8Array&&!f.redeemFile) {
   const target=join(dir,rel);await mkdir(dirname(target),{recursive:true,mode:0o700});
   try{await stat(target);}catch(e){
    if(e.code!=='ENOENT')throw e;
    const tmp=target+'.'+randomUUID()+'.tmp',h=await open(tmp,'wx',0o600);
    try{await h.writeFile(f.redeemScript);await h.sync();}finally{await h.close();}
    await rename(tmp,target);
   }
   f.redeemFile=rel;
  }
  const {redeemScript,...rest}=f;void redeemScript;frozenOut.push({...rest,redeemFile:rel});
 }
 await durable(join(dir,'state.json'),{...state,frozen:frozenOut});
}
export const stepFile=(step,suffix)=>`steps/${String(Math.floor(step/1000)).padStart(3,'0')}/${step}-${suffix}`;
export async function loadRunState(dir) {
 const state=await read(join(dir,'state.json'));
 for(const f of state.frozen??[])if(!f.redeemScript&&f.redeemFile)f.redeemScript=new Uint8Array(await readFile(join(dir,f.redeemFile)));
 return state;
}
const RETRYABLE_RPC=new Set(['RPC_TIMEOUT','NODE_DISCONNECTED','NODE_CLOSED']);
const isRetryableRpc=e=>{
 const c=e?.code??e?.safeCode??e?.message??'';
 return RETRYABLE_RPC.has(c)||/^(连接超时|无法连接|连接已关闭)：/.test(String(e?.message??''));
};
export async function connectTN10(node=null) {
 const rpc=await probeNode(node||process.env.KASWIN_TN10_NODE||endpoint,{net:TN10,verifyDag:true,timeoutMs:15000});
 const call=rpc.call.bind(rpc);let verifiedEpoch=rpc.epoch;
 rpc.call=async(method,...args)=>{
  for(let attempt=0;;attempt++)try{
   const out=await call(method,...args);
   if(!method.startsWith('submit')&&method!=='getServerInfo'&&rpc.epoch!==verifiedEpoch){
    const info=await call('getServerInfo');checkServerIdentity(info,TN10.networkId);check(info.isSynced&&info.hasUtxoIndex,'NODE_UNSYNCED');verifiedEpoch=rpc.epoch;
   }
   if(method==='getServerInfo')verifiedEpoch=rpc.epoch;
   return out;
  }catch(e){
   if(method.startsWith('submit')||attempt>=5||!isRetryableRpc(e))throw e;
   await sleep(Math.min(3000,500*(attempt+1)));
  }
 };
 rpc.currentDaa=async()=>{const i=await rpc.call('getServerInfo');checkServerIdentity(i,TN10.networkId);check(i.isSynced&&i.hasUtxoIndex,'NODE_UNSYNCED');return BigInt(i.virtualDaaScore);};
 return rpc;
}
export async function preflight({node=null}={}) {
 const rpc=await connectTN10(node);try {
  const info=await rpc.call('getServerInfo'),wallets=[];
  for(const w of publicWallets()) {const us=await commonUtxos(rpc,w.address),ordinary=us.filter(u=>!u.isCoinbase&&!u.covenantId);wallets.push({...w,ordinaryUtxos:ordinary.length,balanceSompi:ordinary.reduce((n,u)=>n+u.value,0n).toString()});}
  const result={networkId:info.networkId,genesis:TN10.genesis,endpoint:rpc.url,version:info.serverVersion,isSynced:info.isSynced,virtualDaa:String(info.virtualDaaScore),profileId:(await loadDeploymentProfile()).id,wallets};
  console.log(JSON.stringify(result,null,2));return result;
 }finally{rpc.close();}
}
export function plan(scenario) {
 const defs={empty:{buys:0,quantity:1,minTickets:3,ticketCap:3},refund:{buys:2,quantity:1,minTickets:3,ticketCap:10},payout:{buys:3,quantity:1,minTickets:3,ticketCap:3},
  'shard-payout':{buys:256,quantity:1,minTickets:3,ticketCap:256},'shard-refund':{buys:256,quantity:1,minTickets:300,ticketCap:300},
  // Two frozen shards (512 single-ticket buys) + a 3-ticket tail buy: the tail pool reaches TAIL_POOL_MIN, so the final step is PAY_SELF / REFUND_SELF, not a merged tail.
  'multi-payout':{buys:513,quantity:1,tailQuantity:3,minTickets:3,ticketCap:515},'multi-refund':{buys:513,quantity:1,tailQuantity:3,minTickets:600,ticketCap:600},
  'batch-payout':{buys:4353,quantity:1,tailQuantity:3,minTickets:3,ticketCap:4355,payoutBatch:16,defaultMaxSteps:6000},
  'seventeen-shard-payout':{buys:4353,quantity:1,tailQuantity:3,minTickets:3,ticketCap:4355,payoutBatch:16,defaultMaxSteps:6000},
  'nine-shard-payout':{buys:2305,quantity:1,tailQuantity:3,minTickets:3,ticketCap:2307,payoutBatch:8,defaultMaxSteps:3500},
  'three-shard-refund':{buys:769,quantity:1,tailQuantity:3,minTickets:800,ticketCap:800,defaultMaxSteps:1500},
  'eight-shard-refund':{buys:2049,quantity:1,tailQuantity:3,minTickets:2100,ticketCap:2100,defaultMaxSteps:3000},
  'nine-shard-refund':{buys:2305,quantity:1,tailQuantity:3,minTickets:2400,ticketCap:2400,defaultMaxSteps:3500},
  'seventeen-shard-refund':{buys:4353,quantity:1,tailQuantity:3,minTickets:4400,ticketCap:4400,defaultMaxSteps:6000},
  'full-payout':{buys:65536,quantity:1,minTickets:3,ticketCap:65536,payoutBatch:16,closeDelayDaa:864000n,defaultMaxSteps:70000},
  'full-refund':{buys:65536,quantity:1,minTickets:65537,ticketCap:65537,defaultMaxSteps:70000}};
 check(Object.hasOwn(defs,scenario),'SCENARIO');return defs[scenario];
}
async function usage() {
 let fees=0n,tickets=0,active=0;
 for(const d of await readdir(root,{withFileTypes:true}))if(d.isDirectory()) {
  let state;try{state=await read(join(root,d.name,'state.json'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
  check(state.profileId===TN10_PROFILE_ID&&state.network===TN10.networkId,'RUN_SCOPE');
  fees+=state.fees;tickets+=state.bought;active+=state.terminal?0:1;
  if(state.intent) {const i=await read(join(root,d.name,state.intent));fees+=i.draft.fee;if(i.action==='BUY')tickets+=i.quantity;}
 }
 return {fees,tickets,active};
}
async function fund(rpc,signer,minimum,exclude=null) {
 const us=(await commonUtxos(rpc,signer.address)).filter(u=>!u.isCoinbase&&!u.covenantId&&u.value>0n&&!exclude?.has(`${u.outpoint.transactionId}:${u.outpoint.index}`)).sort((a,b)=>a.value>b.value?-1:a.value<b.value?1:0);
 const selected=[];let total=0n;
 // Aggregate small ordinary outputs within buildGenesis/buildAction's eight-funding-input bound.
 for(const u of us){selected.push({...u,utxoDaa:u.daa});total+=u.value;if(total>=minimum)break;if(selected.length===8)break;}
 check(total>=minimum,'TEST_WALLET_FUNDS_INSUFFICIENT');return selected;
}
export function buildFeeRateLadder(feeInfo) {
 const out=[];
 const pri=Number(feeInfo?.priority?.feerate??1);
 const boosted=Number.isFinite(pri)&&pri>5?Math.ceil(pri*1.25):null;
 for(const raw of [boosted,pri,feeInfo?.normal?.feerate,feeInfo?.low?.feerate,1]) {
  if(raw==null)continue;
  const n=Math.max(1,Math.ceil(Number(raw)));
  if(!Number.isFinite(n))continue;
  const s=String(n);
  if(!out.includes(s))out.push(s);
 }
 return out;
}
export function requiredFee(mass,rate='100') {
 check(typeof rate==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(rate),'FEE_RATE');
 const [a,b='']=rate.split('.'),den=10n**BigInt(b.length),num=BigInt(a+b);
 const fee=(mass.orderingMass*num+den-1n)/den;return fee>mass.relayFloor?fee:mass.relayFloor;
}
export async function chainCursor(rpc,hash=null,depth=0) {
 let at=hash??(await rpc.call('getSink')).sink;
 for(let n=0;n<512;n++) {
  const b=(await rpc.call('getBlock',{hash:at,includeTransactions:false})).block;check(b?.header?.hash===at,'CURSOR_BLOCK');
  if(b.verboseData?.isChainBlock===true&&depth--<=0)return at;
  at=b.verboseData?.selectedParentHash;unhex(at,32);
 }
 throw new Error('CURSOR_RECOVERY_BOUND');
}
async function search(rpc,txid,cursor) {
 try{return await searchAccepted(rpc,txid,cursor,{pages:4});}
 catch(e){if(e.code!=='CURSOR_REORG'&&e.safeCode!=='CURSOR_REORG')throw e;return searchAccepted(rpc,txid,await chainCursor(rpc,cursor),{pages:4});}
}
export function authenticateIntent(intent) {
 check(intent.network===TN10.networkId&&intent.profileId===TN10_PROFILE_ID,'INTENT_SCOPE');
 check(referenceTxId(intent.draft.transaction)===intent.txid,'INTENT_TXID');
 const wire=txToRpc(intent.draft.transaction),digest=createHash('sha256').update(jsonText(wire)).digest('hex');
 check(digest===intent.wireDigest,'INTENT_CONTENT_CHANGED');
 const mass=quoteMass(intent.draft);check(mass.storageMass===intent.draft.transaction.storageMass,'INTENT_STORAGE_MASS');
 check(intent.draft.inputUtxos.length===intent.draft.transaction.inputs.length,'INTENT_INPUT_COUNT');
 intent.draft.inputUtxos.forEach((u,i)=>check(u.outpoint.transactionId===intent.draft.transaction.inputs[i].previousOutpoint.transactionId&&u.outpoint.index===intent.draft.transaction.inputs[i].previousOutpoint.index,'INTENT_OUTPOINT'));
 return {wire,digest};
}
export async function submitIntent(rpc,intent,{skipEngine=false}={}) {
 let sent=false;
 try {
 const {wire,digest}=authenticateIntent(intent);
 await verifyInputsLive(rpc,intent.draft.inputUtxos,{allowDaaDrift:true});
 const now=await rpc.currentDaa(),tx=intent.draft.transaction;
 check(tx.lockTime===0n||tx.lockTime<now,'SUBMIT_LOCK_MATURITY');
 for(let i=0;i<tx.inputs.length;i++)check(tx.inputs[i].sequence===0n||now>=intent.draft.inputUtxos[i].daa+tx.inputs[i].sequence,'SUBMIT_SEQUENCE_MATURITY');
 let confirmation=null;
 if(intent.action==='DRAW')confirmation=await requireConfirmedDrawTarget(rpc,drawTargetFromOpening(intent.proof));
 if(!(skipEngine&&intent.engineVerifiedDigest===digest&&intent.engine&&intent.action!=='DRAW')) {
  runEngine(intent.draft,{accessor:intent.accessor,limited:true});
 }
 const permit=createCliSubmitPermit(TN10,request=>check(createHash('sha256').update(jsonText(request.transaction)).digest('hex')===digest,'SUBMIT_CONTENT_CHANGED'));
 const result=await rpc.call('submitTransaction',{transaction:wire,allowOrphan:false},30000,{submitPermit:permit,beforeSend:()=>{if(confirmation)assertFreshDrawConfirmation(confirmation,confirmation,Date.now(),rpc);sent=true;}});
 check(result.transactionId===intent.txid,'SUBMIT_TXID');return result;
 }catch(e){e.submissionAttempted=sent;throw e;}
}
/** depth=0n (V2.0.2 zero-depth chaining): the first selected-chain acceptance is a CANDIDATE and lets the caller continue;
 * it is promoted to ACCEPTED later by finalizePending (>=100 DAA below the virtual DAA, re-verified). depth=100n waits here. */
export async function settle(rpc,intent,{timeoutMs=300000,recover=false,depth=100n,pollMs=1500,checkpoint=async()=>{}}={}) {
 authenticateIntent(intent);
 const until=Date.now()+timeoutMs;let cursor=intent.cursor,reconciled=false;
 while(Date.now()<until) {
  try {
  const found=await search(rpc,intent.txid,cursor);cursor=found.cursor;
  intent.cursor=cursor;await checkpoint(intent);
  if(recover&&!reconciled&&!found.accepting&&found.complete) {
   reconciled=true;
   if(!await mempoolEntry(rpc,intent.txid)) {
    // Never replace an unknown transaction. If every input is still live, resubmit precisely the durable signed content.
    check(intent.status!=='REJECTED','RECORDED_REJECTION_REQUIRES_REVIEW');
    try{await submitIntent(rpc,intent);console.log(JSON.stringify({resubmitted:intent.txid,sameSignedContent:true}));}
    catch(e){if(e.code!=='STALE_INPUT'&&e.safeCode!=='STALE_INPUT')throw e; /* May have just been accepted; re-search until the bounded deadline. */}
   }
  }
  if(found.accepting) {
   const virtualDaa=await rpc.currentDaa(),ev=await acceptedAt(rpc,intent.txid,found.accepting);matchesDraft(ev,intent.draft);
   if(depth===0n||virtualDaa>=ev.acceptingDaa+depth) {
    const final=depth>0n?await acceptedAt(rpc,intent.txid,found.accepting):ev;const fee=matchesDraft(final,intent.draft);
    check(final.acceptingDaa===ev.acceptingDaa,'ACCEPTANCE_MOVED');
    return {accepted:depth>=100n,candidate:depth<100n,txid:intent.txid,acceptingBlock:final.accepting,acceptingDaa:final.acceptingDaa,observedVirtualDaa:virtualDaa,
      nodeEndpoint:rpc.url,nodeComputeMass:final.computeMass,storageMass:final.tx.storageMass,quotedMass:intent.mass,actualFee:fee,transaction:final.tx,inputs:final.inputs};
   }
  }
  }catch(e){if(!['NOT_CHAIN','REORG','CURSOR_REORG','NOT_ACCEPTED','SINK_BEHIND','RPC_TIMEOUT','READ_VIEW_CHANGED','ACCEPTANCE_MOVED'].includes(e.code??e.safeCode??e.message))throw e;}
  await sleep(pollMs);
 }
 throw new Error('ACCEPTANCE_UNKNOWN_RESUME_SAME_INTENT');
}
/** Outpoints spent by candidates that are not yet re-verified: the node's UTXO index may still list them, so they must not be reused as funding. */
async function pendingSpends(dir,state) {
 const keys=new Set();
 for(const r of state.receipts)if(r.finalized===false)for(const x of (await read(join(dir,r.intentFile))).draft.transaction.inputs)keys.add(`${x.previousOutpoint.transactionId}:${x.previousOutpoint.index}`);
 return keys;
}
/** A shallow selected-chain reorg can drop a candidate's accepting block; the same signed bytes are normally accepted again in another block at a
 * slightly different DAA (V2.0.2 "zero-depth chaining"). Re-find the acceptance from the intent cursor, verify it against the approved draft,
 * record the history and refresh the DAA of the UTXOs that transaction created. A transaction that is neither accepted nor in the mempool stops the run. */
async function reaccept(rpc,dir,state,r) {
 const intent=await read(join(dir,r.intentFile));let found;
 try{found=await search(rpc,r.txid,intent.cursor);}catch(e){if(TRANSIENT.includes(e.code??e.safeCode??e.message))return false;throw e;}
 if(!found.accepting) {
  if(!found.complete)return false;
  r.limboSince??=Date.now();
  if(await mempoolEntry(rpc,r.txid)&&Date.now()-r.limboSince<180000)return false;
  console.error(JSON.stringify({candidateDropped:r.txid,action:r.action}));throw Object.assign(new Error('CANDIDATE_DROPPED'),{code:'CANDIDATE_DROPPED'});
 }
 const ev=await acceptedAt(rpc,r.txid,found.accepting);matchesDraft(ev,intent.draft);
 const was={acceptingBlock:r.acceptingBlock,acceptingDaa:r.acceptingDaa};
 if(state.accepting===r.acceptingBlock)state.accepting=found.accepting;
 if(state.manager?.outpoint.transactionId===r.txid)Object.assign(state.manager,{utxoDaa:ev.acceptingDaa,daa:ev.acceptingDaa});
 for(const f of state.frozen)if(f.outpoint.transactionId===r.txid)Object.assign(f,{utxoDaa:ev.acceptingDaa,daa:ev.acceptingDaa});
 (r.reaccepted??=[]).push(was);delete r.limboSince;r.acceptingBlock=found.accepting;r.acceptingDaa=ev.acceptingDaa.toString();
 console.log(JSON.stringify({reaccepted:r.txid,action:r.action,from:was,to:{acceptingBlock:r.acceptingBlock,acceptingDaa:r.acceptingDaa}}));
 return true;
}
const REORG_RECHECK=100n,TRANSIENT=['RPC_TIMEOUT','SINK_BEHIND','READ_VIEW_CHANGED'];
/** Promote CANDIDATE receipts to ACCEPTED: the accepting block must still be on the selected chain >=100 DAA below the virtual DAA,
 * the transaction must still match the approved draft and the accepting DAA must not have moved. Any other failure stops the run (fail closed). */
async function finalizePending(rpc,dir,state,{wait=false,timeoutMs=900000}={}) {
 const until=Date.now()+timeoutMs;
 for(;;) {
  const pending=state.receipts.filter(r=>r.finalized===false);if(!pending.length)return;
  const virtualDaa=await rpc.currentDaa();let changed=false;
  for(const r of pending) {
   if(virtualDaa<BigInt(r.acceptingDaa)+REORG_RECHECK)continue;
   let f;
   try {
    f=await acceptedAt(rpc,r.txid,r.acceptingBlock);matchesDraft(f,(await read(join(dir,r.intentFile))).draft);
    check(f.acceptingDaa.toString()===r.acceptingDaa,'ACCEPTANCE_MOVED');
   } catch(e) {
    const c=e.code??e.safeCode??e.message;if(TRANSIENT.includes(c))continue;
    if(c==='NOT_CHAIN'||c==='REORG'){if(await reaccept(rpc,dir,state,r))changed=true;continue;}
    console.error(JSON.stringify({finalizationFailed:r.txid,action:r.action,cause:c}));throw Object.assign(new Error('FINALIZATION_FAILED'),{code:'FINALIZATION_FAILED'});
   }
   Object.assign(r,{accepted:true,candidate:false,finalized:true,finalDepth:(virtualDaa-BigInt(r.acceptingDaa)).toString()});changed=true;
   console.log(JSON.stringify({finalized:r.txid,action:r.action,depth:r.finalDepth}));
  }
  if(changed)await saveRunState(dir,state);
  if(!wait)return;
  if(Date.now()>until)throw new Error('FINALIZATION_TIMEOUT');
  await sleep(2000);
 }
}
export function advance(state,intent,receipt,profile) {
 const d=intent.draft,txid=receipt.txid,spent=new Set(d.transaction.inputs.map(i=>`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`));
 state.frozen=state.frozen.filter(f=>!spent.has(`${f.outpoint.transactionId}:${f.outpoint.index}`));
 if(d.transition.next)state.manager={outpoint:{transactionId:txid,index:0},origin:d.origin,cid:d.cid,value:d.transaction.outputs[0].value,spk:d.transaction.outputs[0].scriptPublicKey,
   redeemScript:redeem(d.transition.next,profile),utxoDaa:receipt.acceptingDaa,currentDaa:receipt.observedVirtualDaa,daa:receipt.acceptingDaa,covenantId:d.cid};
 else state.manager=null;
 for(let i=0;i<d.transition.outputs.length;i++) {const o=d.transition.outputs[i];if(o.state?.module==='frozen')state.frozen.push({outpoint:{transactionId:txid,index:i},cid:d.cid,covenantId:d.cid,origin:d.origin,
  value:d.transaction.outputs[i].value,spk:d.transaction.outputs[i].scriptPublicKey,redeemScript:redeem(o.state,profile),utxoDaa:receipt.acceptingDaa,daa:receipt.acceptingDaa});}
 state.cid=d.cid;state.origin=d.origin;state.accepting=receipt.acceptingBlock;state.fees+=receipt.actualFee;
 if(intent.action==='BUY'){state.buys++;state.bought+=intent.quantity;}
 state.step++;state.intent=null;state.terminal=d.transition.terminal??null;
 state.receipts.push({txid,action:intent.action,accepted:true,acceptingBlock:receipt.acceptingBlock,acceptingDaa:receipt.acceptingDaa.toString(),feeSompi:receipt.actualFee.toString(),computeMass:receipt.nodeComputeMass?.toString()??null,storageMass:receipt.storageMass.toString(),transientMass:intent.mass.transientMass.toString()});
}
export function selectOldShardBatch(state,s,profile,settings={}) {
 const start=s.module==='win'?s.p:s.r;
 if(start>=s.indices.length)return null;
 const batchCap=state.payoutBatch??settings.payoutBatch??16;
 check(Number.isSafeInteger(batchCap)&&batchCap>=1&&batchCap<=16,'PAYOUT_BATCH');
 // PAY_OLD merges 1..16 frozen shards per tx; REFUND_OLD strictly targets 1 shard (32 buyer records per tx, 8 txs/shard) per KaswinRollingRefund.
 const count=s.module==='win'?Math.min(batchCap,s.indices.length-start):1,available=[...state.frozen],targets=[];
 for(let j=start;j<start+count;j++) { // Two shards can share a script hash (identical ledgers); the one at the cursor is told apart by its expected value (a refunded shard is smaller).
  const at=available.findIndex(f=>hex(blake2b256(f.redeemScript))===s.indices[j].hash&&f.value===S.frozenValue(s,j,identify(f.redeemScript,profile).records));check(at>=0,'FROZEN_TARGET_MISSING');targets.push(available.splice(at,1)[0]);}
 return {action:s.module==='win'?'PAY_OLD':'REFUND_OLD',role:'creator',targets};
}
export function selectBuyerRole(buys,lane=null,depleted=new Set()) {
 if(lane==='B')return 'buyer2';
 if(lane==='A') {
  const c=buys%4===3&&buys<4000?'creator':'buyer1';
  return depleted.has(c)?'buyer1':c;
 }
 const c=['buyer1','buyer2','creator'][buys%3];
 if(c==='creator'&&buys>=3000)return depleted.has('buyer2')?'buyer1':'buyer2';
 return depleted.has(c)?'buyer1':c;
}
export function selectBuyerKey(buys,poolKeys) {
 if(!Array.isArray(poolKeys)||!poolKeys.length)return null;
 const shard=Math.floor(buys/256);
 return poolKeys[(buys+shard*7)%poolKeys.length];
}
async function nextOperation(rpc,state,profile,settings,depleted=new Set()) {
 if(!state.manager)return {action:'GENESIS',role:'creator'};
 state.manager.currentDaa=await rpc.currentDaa();const s=verifyManager(state.manager,profile);
 if(s.module==='sales') {
  if(state.buys<settings.buys)return {action:'BUY',quantity:state.buys===settings.buys-1&&settings.tailQuantity?settings.tailQuantity:settings.quantity,role:selectBuyerRole(state.buys,state.lane??null,depleted)};
  if(S.totalTickets(s)<s.ticketCap&&s.indices.length<256&&state.manager.currentDaa<s.closeEligibleDaa)return null;
  return {action:'CLOSE',role:'creator'};
 }
 if(s.module==='sealed') {
  if(state.manager.currentDaa<state.manager.utxoDaa+S.DRAW_DELAY+120n)return null;
  check(state.manager.currentDaa<state.manager.utxoDaa+S.TIMEOUT_DELAY,'TIMEOUT_RESERVED_FOR_MANUAL_TEST');
  if(state.manager.currentDaa>=state.manager.utxoDaa+S.TIMEOUT_DELAY-1000n)return null;
  let p;try{p=await acquireRollingProof(rpc,state.manager,profile,state.accepting);}catch(e){if(['DRAW_TARGET_UNCONFIRMED','DRAW_CONFIRMATION_STALE','READ_VIEW_CHANGED'].includes(e.code??e.safeCode))return null;throw e;}
  const sample=drawSample(state.manager,s,{proof:p.opening,accessor:p.accessor});
  const j=[...s.indices.map(x=>x.end),S.totalTickets(s)].findIndex(end=>sample.ticket<end);
  const winning=j<s.indices.length?state.frozen.find(f=>hex(blake2b256(f.redeemScript))===s.indices[j].hash):null;
  check(j===s.indices.length||winning,'WINNING_SHARD_PREIMAGE');
  return {action:'DRAW',role:'creator',proof:p.opening,accessor:p.accessor,j,winningRedeem:winning?.redeemScript};
 }
 return selectOldShardBatch(state,s,profile,settings)??{action:s.module==='win'?'PAY_SELF':'REFUND_SELF',role:'creator'};
}
function estimateInitialFee(state,op,targets,feerate,feeCap) {
 if(op.action==='GENESIS'||!state?.manager?.redeemScript?.length)return 1000000n;
 let scriptBytes=BigInt(state.manager.redeemScript.length);
 for(const t of targets)if(t?.redeemScript?.length)scriptBytes+=BigInt(t.redeemScript.length);
 const estOrderingMass=scriptBytes*2n;
 const est=requiredFee({orderingMass:estOrderingMass,relayFloor:estOrderingMass*100n},feerate);
 if(est<=1000000n)return 1000000n;
 return est<feeCap?est:feeCap;
}
export async function prepare(rpc,state,profile,op,signer,settings,{feerate='100',exclude=null}={}) {
 const targets=op.targets??[],needsFunds=['GENESIS','BUY','CLOSE','DRAW','TIMEOUT','REFUND_SELF'].includes(op.action);
 const funds=needsFunds?await fund(rpc,signer,op.action==='GENESIS'?600000000n:op.action==='BUY'?BigInt(op.quantity)*S.PRICE_MIN+S.FEE_CAP+1n:S.FEE_CAP+1n,exclude):[];
 const feeCap=op.action.startsWith('PAY')?S.PAY_FEE_CAP:S.FEE_CAP;
 let fee=estimateInitialFee(state,op,targets,feerate,feeCap),budgets=Array((op.action==='GENESIS'?0:1)+targets.length+funds.length).fill(65535),draft,mass;
 const make=()=>op.action==='GENESIS'?buildGenesis(profile,signer.key,{ticketPrice:S.PRICE_MIN,ticketCap:settings.ticketCap,minTickets:settings.minTickets,closeEligibleDaa:state.closeEligibleDaa},{funds,fee,budgets,registrySpk:TN10.registry.spk}):
  buildAction(state.manager,profile,{...op,actorKey:signer.key},{targets,funds,fee,budgets,allowDelegatedBuyer:op.action==='BUY'&&typeof op.buyerKey==='string'&&op.buyerKey!==signer.key});
 for(let attempt=0;attempt<8;attempt++) {
  draft=make();
  const outCount=draft.transaction.outputs.length;
  budgets=measuredBudgets(draft,op.accessor);
  const probe={...draft,transaction:{...draft.transaction,inputs:draft.transaction.inputs.map((inp,i)=>({...inp,computeBudget:budgets[i]}))}};
  try {
   const estReq=requiredFee(quoteMass(probe),feerate);
   if(estReq>fee&&estReq<=feeCap)fee=estReq;
  }catch{}
  draft=make();mass=quoteMass(draft);
  const required=requiredFee(mass,feerate);
  if(fee>=required&&draft.transaction.outputs.length===outCount)break;
  fee=required;check(attempt<7,'FEE_CONVERGENCE');
 }
 check(fee<=feeCap,'EXPERIMENT_FEE_CAP');
 for(const u of draft.inputUtxos)u.daa=u.utxoDaa;
 await verifyInputsLive(rpc,draft.inputUtxos,{allowDaaDrift:true});
 draft.transaction.storageMass=mass.storageMass;await signer.sign(draft);
 const engine=runEngine(draft,{accessor:op.accessor,limited:true});
 return {draft,mass,engine};
}
/** Concurrent rounds use disjoint wallet sets so they can never select the same funding UTXO:
 * lane A = creator + buyer1 (buyer2 buys are re-routed to buyer1); lane B = buyer2 for every role. No lane = legacy single writer. */
const walletRole=(lane,role)=>lane==='B'?'buyer2':lane==='A'&&role==='buyer2'?'buyer1':role;
export async function execute({scenario,resume=null,maxSteps=null,lane=null,pollMs=1500,node=null,payoutBatch=null,skipReorgRecheck=false,buyerPool=64,onRunDir=null}={}) {
 check(maxSteps===null||(Number.isSafeInteger(maxSteps)&&maxSteps>0),'MAX_STEPS');
 check(Number.isSafeInteger(pollMs)&&pollMs>=250&&pollMs<=5000,'POLL_INTERVAL');
 check(lane===null||lane==='A'||lane==='B','LANE');
 check(payoutBatch===null||(Number.isSafeInteger(payoutBatch)&&payoutBatch>=1&&payoutBatch<=16),'PAYOUT_BATCH');
 check(Number.isSafeInteger(buyerPool)&&buyerPool>=0&&buyerPool<=256,'BUYER_POOL_SIZE');
 await mkdir(root,{recursive:true,mode:0o700});
 const lockName=lane?`writer-${lane}.lock`:'writer.lock',others=(await readdir(root)).filter(n=>/^writer(-[AB])?\.lock$/.test(n)&&n!==lockName);
 check(lane?!others.includes('writer.lock'):others.length===0,'WRITER_LANE_CONFLICT');
 const lock=await open(join(root,lockName),'wx',0o600);await lock.writeFile(String(process.pid));
 let rpc,stopping=false;const signers=new Map(),walletLocks=[];
 const onSignal=sig=>{if(stopping)process.exit(143);stopping=true;console.error(JSON.stringify({gracefulStop:sig,pid:process.pid}));};
 process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 try {
  for(const role of lane==='A'?['creator','b1']:lane==='B'?['b2']:['creator','b1','b2'])walletLocks.push(acquireWalletLock(join(here,'../output/rolling-runs'),role,`rolling CLI lane ${lane??'all'}`));
  const profile=await loadDeploymentProfile();rpc=await connectTN10(node);
  const dir=resume?resolve(resume):join(root,`${scenario}-${Date.now()}`);check(dirname(dir)===root,'RESUME_PATH');
  let state;
  if(resume) {
   state=await loadRunState(dir);
   check(!state.lane||state.lane===lane,'LANE_MISMATCH');
   check(payoutBatch===null||!state.payoutBatch||state.payoutBatch===payoutBatch,'PAYOUT_BATCH_MISMATCH');
   let updated=false;
   if(lane&&!state.lane){state.lane=lane;updated=true;}
   if(payoutBatch&&!state.payoutBatch){state.payoutBatch=payoutBatch;updated=true;}
   if(updated)await saveRunState(dir,state);
  }
  else {
   const initialSettings=plan(scenario);const u=await usage();check(u.active<3,'EXPERIMENT_ACTIVE_ROUNDS_LIMIT');
   state={network:TN10.networkId,profileId:profile.id,scenario,endpoint:rpc.url,cid:null,origin:null,manager:null,frozen:[],buys:0,bought:0,fees:0n,step:0,intent:null,terminal:null,receipts:[],lane,payoutBatch:payoutBatch??initialSettings.payoutBatch??16,closeEligibleDaa:await rpc.currentDaa()+(initialSettings.closeDelayDaa??600n)};
   await saveRunState(dir,state);
  }
  if(typeof onRunDir==='function')await onRunDir(dir);
  check(state.network===TN10.networkId&&state.profileId===profile.id,'RESUME_SCOPE');const settings=plan(state.scenario);
  const stepLimit=maxSteps??settings.defaultMaxSteps??1000;
  let buyerKeys=[];const poolBaseRole=state.lane==='B'?'buyer2':'buyer1';
  if(buyerPool>0) {
   const pool=await openDerivedBuyerPool(poolBaseRole,buyerPool,TN10.networkId);
   try{buyerKeys=pool.entries.map(e=>e.key);}finally{pool.close();}
  }
  console.log(JSON.stringify({run:dir,scenario:state.scenario,profileId:profile.id,payoutBatch:state.payoutBatch??settings.payoutBatch??16,maxSteps:stepLimit,buyerPool:buyerKeys.length,buyerPoolRole:buyerKeys.length?poolBaseRole:null}));
  let resumed=!!resume,staleRetries=0;const depletedBuyers=new Set();
  for(let steps=0;steps<stepLimit&&!state.terminal&&!stopping;) {
   if(!skipReorgRecheck||state.receipts.some(r=>r.finalized===false))await finalizePending(rpc,dir,state);
   if(state.intent) {
    const intent=await read(join(dir,state.intent));
    check(intent.action!=='TIMEOUT','TIMEOUT_RESERVED_FOR_MANUAL_TEST');
    if(intent.status==='UNSENT') {authenticateIntent(intent);await durable(join(dir,stepFile(state.step,`unsent-${randomUUID()}.json`)),intent);state.intent=null;await saveRunState(dir,state);continue;}
    const intentFile=state.intent,receipt=await settle(rpc,intent,{recover:resumed,depth:0n,pollMs,checkpoint:i=>durable(join(dir,intentFile),i)});resumed=false;
    await durable(join(dir,stepFile(state.step,'receipt.json')),receipt);advance(state,intent,receipt,profile);
    const latest=state.receipts.at(-1);
    Object.assign(latest,{accepted:skipReorgRecheck?true:receipt.accepted,candidate:skipReorgRecheck?false:receipt.candidate,finalized:skipReorgRecheck?true:receipt.accepted,acceptOnly:skipReorgRecheck&&!receipt.accepted,intentFile});await saveRunState(dir,state);
    console.log(JSON.stringify({...latest,step:state.step,terminal:state.terminal}));steps++;continue;
   }
   const op=await nextOperation(rpc,state,profile,settings,depletedBuyers);if(!op){await sleep(2000);continue;}
   if(op.action==='BUY'&&buyerKeys.length>0)op.buyerKey=selectBuyerKey(state.buys,buyerKeys);
   // Cumulative fee/ticket limits were withdrawn by the user on 2026-11-14; funding is bounded by the dedicated wallet balances.
   // Per-transaction fee caps, live-input checks, the real engine and acceptance reconciliation remain mandatory.
   let role=walletRole(state.lane??null,op.role),signer;
   const getSigner=async r=>{
    if(['PAY_OLD','PAY_SELF','REFUND_OLD'].includes(op.action)) {
     const wallet=publicWallets().find(w=>w.role===r);
     return {address:wallet.address,key:addressToPubkey(wallet.address),async sign(d){check(d.authorizedInputIndices.length===0,'PERMISSIONLESS_SIGNATURE_SCOPE');}};
    }
    let s=signers.get(r);if(!s){s=await openTestSigner(r,TN10.networkId);signers.set(r,s);}
    return s;
   };
   signer=await getSigner(role);
   const feeInfo=parseFeeEstimate(await rpc.call('getFeeEstimate'));
   const feeRates=buildFeeRateLadder(feeInfo);
   let rateIdx=0;
   // Zero-depth chaining: the node's UTXO index can lag the accepting chain block for a moment; wait briefly, never build on guesses.
   const CREATOR_RESERVE_SOMPI=100_00000000n;
   const exclude=await pendingSpends(dir,state);let prepared;
   for(let attempt=0;;attempt++) {
    try{
     if(op.action==='BUY'&&role==='creator') {
      const need=BigInt(op.quantity)*S.PRICE_MIN+S.FEE_CAP+1n;
      const live=(await commonUtxos(rpc,signer.address)).filter(u=>!u.isCoinbase&&!u.covenantId&&!exclude.has(`${u.outpoint.transactionId}:${u.outpoint.index}`)).reduce((s,u)=>s+u.value,0n);
      if(live<need+CREATOR_RESERVE_SOMPI){depletedBuyers.add('creator');role=state.lane==='B'?'buyer2':'buyer1';op.role=role;signer=await getSigner(role);}
     }
     prepared=await prepare(rpc,state,profile,op,signer,settings,{feerate:feeRates[rateIdx],exclude});break;
    }
    catch(e){
     const c=e.code??e.safeCode??e.message,fallback=state.lane==='B'?'buyer2':'buyer1';
     if(['FEE','FEE_CONVERGENCE','PAYMENT','EXPERIMENT_FEE_CAP'].includes(c)&&rateIdx+1<feeRates.length){rateIdx++;continue;}
     if(c==='TEST_WALLET_FUNDS_INSUFFICIENT'&&op.action==='BUY'&&role!==fallback&&(exclude.size===0||attempt>=10)){depletedBuyers.add(role);role=fallback;op.role=role;signer=await getSigner(role);continue;}
     if(attempt>=40||!(['STALE_INPUT','TEST_WALLET_NEEDS_SINGLE_FUNDING_UTXO'].includes(c)||(c==='TEST_WALLET_FUNDS_INSUFFICIENT'&&exclude.size>0)))throw e;await sleep(500);
    }
   }
   const cursor=state.accepting??await chainCursor(rpc,null,8),txid=referenceTxId(prepared.draft.transaction);
   const wireDigest=createHash('sha256').update(jsonText(txToRpc(prepared.draft.transaction))).digest('hex');
   const intent={...prepared,txid,cursor,wireDigest,status:'PREPARED',action:op.action,quantity:op.quantity??0,network:TN10.networkId,profileId:profile.id,accessor:op.accessor??null,proof:op.proof??null};
   const name=stepFile(state.step,'intent.json');await durable(join(dir,name),intent);state.intent=name;await saveRunState(dir,state);
   console.log(JSON.stringify({prepared:txid,action:op.action,feeSompi:prepared.draft.fee.toString(),node:rpc.url}));
   try {await submitIntent(rpc,intent);intent.status='SUBMITTED';}
   catch(e) {
    intent.status=!e.submissionAttempted?'UNSENT':e instanceof RpcError?'REJECTED':'UNKNOWN';intent.errorCode=e.code??e.safeCode??e.name;
    if(e instanceof RpcError)intent.nodeError=e.message;
    await durable(join(dir,name),intent);
    if(intent.status==='UNSENT'&&(e.code??e.safeCode)==='STALE_INPUT'&&staleRetries++<40){await sleep(500);continue;} // never sent: the loop archives it and re-prepares
    throw e;
   }
   staleRetries=0;
   await durable(join(dir,name),intent);console.log(JSON.stringify({submitted:txid,action:op.action,accepted:false}));
  }
  if(stopping&&state.intent) {
   const intent=await read(join(dir,state.intent));
   if(intent.status!=='UNSENT') {
    const intentFile=state.intent,receipt=await settle(rpc,intent,{recover:false,depth:0n,pollMs,checkpoint:i=>durable(join(dir,intentFile),i)});
    await durable(join(dir,stepFile(state.step,'receipt.json')),receipt);advance(state,intent,receipt,profile);
    const latest=state.receipts.at(-1);
    Object.assign(latest,{accepted:skipReorgRecheck?true:receipt.accepted,candidate:skipReorgRecheck?false:receipt.candidate,finalized:skipReorgRecheck?true:receipt.accepted,acceptOnly:skipReorgRecheck&&!receipt.accepted,intentFile});await saveRunState(dir,state);
   }
  }
  if((!skipReorgRecheck||state.receipts.some(r=>r.finalized===false))&&!stopping)await finalizePending(rpc,dir,state,{wait:true});
  return {run:dir,terminal:state.terminal,completed:state.terminal!==null,stopped:stopping,transactions:state.step,allAccepted:state.receipts.every(r=>r.finalized!==false)};
 }finally{process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);for(const s of signers.values())s.close();rpc?.close();for(const release of walletLocks)release();await lock.close();await unlink(join(root,lockName));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const arg=n=>process.argv.find(x=>x.startsWith(`--${n}=`))?.slice(n.length+3);
 try {
  if(process.argv.includes('--preflight'))await preflight({node:arg('node')??null});
  else {check(process.argv.includes('--execute'),'EXPLICIT_EXECUTE_REQUIRED');console.log(JSON.stringify(await execute({scenario:arg('scenario'),resume:arg('resume'),maxSteps:arg('max-steps')?Number(arg('max-steps')):null,lane:arg('lane')??null,pollMs:arg('poll-ms')?Number(arg('poll-ms')):1500,node:arg('node')??null,payoutBatch:arg('payout-batch')?Number(arg('payout-batch')):null,skipReorgRecheck:process.argv.includes('--skip-reorg-recheck'),buyerPool:arg('buyer-pool')!=null?Number(arg('buyer-pool')):64})));}
 }catch(e){console.error(e.code??e.safeCode??e.message);process.exitCode=1;}
}
