/** Multi-process TN10 contention runner for a live Rolling round in `sales` state.
 * Spawns independent OS worker processes (one per dedicated wallet role: creator, buyer1, buyer2),
 * synchronizes them on the exact same `manager` outpoint, fires concurrent `submitTransaction` calls,
 * verifies a single on-chain winner and absence of all losers, and advances `runDir` with the winner's state.
 *
 * Usage:
 *   node tests/contracts/tn10-contention.mjs --execute --run-dir=<path> [--rounds=5] [--roles=creator,buyer1,buyer2] [--node=ws://127.0.0.1:18210] [--poll-ms=250] [--buyer-pool=64]
 *
 * No import-time wallet access, node connection, or transaction submission. */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {appendFile,mkdir,open,readdir,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomInt} from 'node:crypto';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {txToRpc,RpcError,parseSpk} from '../../scripts/chain/nodes.mjs';
import {commonUtxos,verifyInputsLive,searchAccepted,acceptedAt,matchesDraft,mempoolEntry} from '../../scripts/chain/chain.mjs';
import {jsonText} from '../../scripts/chain/json.mjs';
import {parseFeeEstimate} from '../../scripts/chain/feetiers.mjs';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {loadDeploymentProfile,TN10_PROFILE_ID} from '../../scripts/contract/bundle.mjs';
import {identify,interpretAccepted,decodeSpend,redeem,verifyManager,fromLe} from '../../scripts/core.mjs';
import * as S from '../../scripts/core.mjs';
import {openTestSigner,openDerivedBuyerPool} from './test-signer.mjs';
import {acquireWalletLock} from '../web/lock.mjs';
import {
 advance,
 buildFeeRateLadder,
 chainCursor,
 connectTN10,
 decodeRunJson,
 durable,
 loadRunState,
 plan,
 prepare,
 saveRunState,
 selectBuyerKey,
 settle,
 stepFile,
 submitIntent,
} from './tn10-run.mjs';

const {check,hex,unhex}=S;
const here=dirname(fileURLToPath(import.meta.url));
const runsRoot=join(here,'artifacts','tn10');
const lockDir=join(here,'../output/rolling-runs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const LOCK_ROLE={creator:'creator',buyer1:'b1',buyer2:'b2'};
const CREATOR_RESERVE_SOMPI=100_00000000n;

export const packIpc=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?{$bigint:x.toString()}:x instanceof Uint8Array?{$bytes:hex(x)}:x);
export const unpackIpc=line=>decodeRunJson(line);

export function shuffleWorkers(items,pick=randomInt) {
 const copy=[...items];
 for(let i=copy.length-1;i>0;i--) {
  const j=pick(i+1);
  [copy[i],copy[j]]=[copy[j],copy[i]];
 }
 return copy;
}

export function parseContentionRoles(spec='creator,buyer1,buyer2') {
 const roles=spec.split(',').map(s=>s.trim()).filter(Boolean);
 const unique=[...new Set(roles)];
 check(unique.length>=2&&unique.length<=3,'CONTENTION_MIN_TWO_ROLES');
 for(const r of unique)check(Object.hasOwn(LOCK_ROLE,r),`UNKNOWN_ROLE:${r}`);
 check(roles.length===unique.length,'CONTENTION_DUPLICATE_ROLE');
 return roles;
}

export function pickWinningOutcome(outcomes,acceptedTxids) {
 check(Array.isArray(outcomes)&&outcomes.length>=2,'CONTENTION_OUTCOMES');
 const winners=outcomes.filter(o=>acceptedTxids.has(o.txid));
 check(winners.length===1,`CONTENTION_EXPECTED_SINGLE_WINNER:got=${winners.length}`);
 const winner=winners[0];
 const losers=outcomes.filter(o=>o.role!==winner.role);
 return {winner,losers};
}

export function verifyContentionReceipt(receipt,manager,draft) {
 const spent=receipt?.transaction?.inputs?.[0]?.previousOutpoint;
 check(spent&&spent.transactionId===manager.outpoint.transactionId&&Number(spent.index)===Number(manager.outpoint.index),'WINNER_DID_NOT_SPEND_CONTESTED_MANAGER');
 matchesDraft({tx:receipt.transaction,inputs:receipt.inputs},draft);
 return receipt;
}

const DEFAULT_LOCAL_NODE='ws://127.0.0.1:18210';
const LOCAL_NODE_RE=/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i;
const NODE_CONN_ERR=new Set(['NODE_DISCONNECTED','NODE_NETWORK_MISMATCH','WS_CLOSED','RPC_TIMEOUT','NODE_UNAVAILABLE']);

/** Expand local single-node specs to [local, ...publicTN10] so local is preferred and public nodes act as fallback. */
export function parseNodeCandidates(node=DEFAULT_LOCAL_NODE) {
 const raw=Array.isArray(node)?node:String(node??'').split(',').map(s=>s.trim()).filter(Boolean);
 const list=raw.length?raw:[DEFAULT_LOCAL_NODE];
 const withFallback=(list.length===1&&LOCAL_NODE_RE.test(list[0]))?[...list,...TN10.nodes]:list;
 return [...new Set(withFallback)];
}

/** Connect to the first healthy, synced node in preference order (local first, public fallback). */
export async function connectCandidateNodes(node=DEFAULT_LOCAL_NODE,connector=connectTN10) {
 const candidates=parseNodeCandidates(node);
 let lastErr=null;
 for(const url of candidates) {
  try{return await connector(url);}
  catch(e){lastErr=e;}
 }
 throw lastErr??new Error('NO_NODE');
}

export async function reconcileAcceptedBuy({runDir,txid,block,node=DEFAULT_LOCAL_NODE}={}) {
 check(typeof txid==='string'&&/^[0-9a-f]{64}$/.test(txid),'RECONCILE_TXID');
 check(typeof block==='string'&&/^[0-9a-f]{64}$/.test(block),'RECONCILE_BLOCK');
 const dir=resolve(runDir);
 check(dirname(dir)===runsRoot,'CONTENTION_RUN_DIR_SCOPE');
 await mkdir(runsRoot,{recursive:true,mode:0o700});
 const others=(await readdir(runsRoot)).filter(n=>/^writer(-[AB])?\.lock$/.test(n));
 check(others.length===0,`WRITER_LOCK_ACTIVE:${others.join(',')}`);
 const lock=await open(join(runsRoot,'writer.lock'),'wx',0o600);
 await lock.writeFile(String(process.pid));
 let rpc;
 try {
  const profile=await loadDeploymentProfile();
  const state=await loadRunState(dir);
  check(state.network===TN10.networkId&&state.profileId===profile.id,'CONTENTION_STATE_SCOPE');
  check(!state.terminal&&!state.intent&&state.manager,'CONTENTION_ROUND_NOT_ACTIVE_SALES');
  rpc=await connectCandidateNodes(node);
  const ev=await acceptedAt(rpc,txid,block);
  const virtualDaa=await rpc.currentDaa();
  const spent0=ev.tx.inputs[0]?.previousOutpoint;
  check(spent0&&spent0.transactionId===state.manager.outpoint.transactionId&&Number(spent0.index)===Number(state.manager.outpoint.index),'RECONCILE_MANAGER_MISMATCH');
  check(Array.isArray(ev.inputs)&&ev.inputs.length===ev.tx.inputs.length&&ev.inputs.every(Boolean),'MISSING_ACCEPTED_INPUT_CONTEXT');
  const contexts=ev.inputs.map((u,i)=>({
   outpoint:ev.tx.inputs[i].previousOutpoint,value:u.value,
   spk:typeof u.spk==='string'?parseSpk(u.spk):u.spk,utxoDaa:u.daa,cid:u.covenantId??null,covenantId:u.covenantId??null,
  }));
  const manager={...contexts[0],origin:state.origin,utxoDaa:contexts[0].utxoDaa,currentDaa:ev.acceptingDaa,redeemScript:state.manager.redeemScript};
  const funds=contexts.slice(1);
  for(const f of funds)check(!f.cid||f.cid===S.ZERO,'RECONCILE_FUNDING_CID');
  const w0=decodeSpend(ev.tx.inputs[0].signatureScript,profile);
  const t=interpretAccepted({manager,targets:[],funds,transaction:ev.tx},profile);
  check(t.cid===state.cid&&t.action==='BUY'&&t.next,'RECONCILE_EXPECTED_BUY');
  const q=Number(fromLe(w0.args.data.slice(0,4)));
  check(Number.isSafeInteger(q)&&q>=1,'RECONCILE_BUY_QUANTITY');
  const outs=ev.tx.outputs,obsDaa=virtualDaa>ev.acceptingDaa?virtualDaa:ev.acceptingDaa;
  check(outs[0]?.covenant?.covenantId===state.cid,'RECONCILE_COVENANT');
  state.manager={
   outpoint:{transactionId:ev.txid,index:0},origin:state.origin,cid:state.cid,value:outs[0].value,spk:outs[0].scriptPublicKey,
   redeemScript:redeem(t.next,profile),utxoDaa:ev.acceptingDaa,currentDaa:obsDaa,daa:ev.acceptingDaa,covenantId:state.cid,
  };
  verifyManager(state.manager,profile);
  t.outputs.forEach((o,i)=>{if(o.state?.module==='frozen'){
   state.frozen.push({
    outpoint:{transactionId:ev.txid,index:i},cid:state.cid,covenantId:state.cid,origin:state.origin,
    value:outs[i].value,spk:outs[i].scriptPublicKey,redeemScript:redeem(o.state,profile),utxoDaa:ev.acceptingDaa,daa:ev.acceptingDaa,
   });
  }});
  state.accepting=ev.accepting;
  state.fees+=t.fee;
  state.buys++;
  state.bought+=q;
  const receiptFile=stepFile(state.step,'reconciled-receipt.json');
  const rec={
   txid:ev.txid,action:'BUY',accepted:true,acceptingBlock:ev.accepting,acceptingDaa:ev.acceptingDaa.toString(),
   feeSompi:t.fee.toString(),computeMass:ev.computeMass!=null?ev.computeMass.toString():null,
   storageMass:(ev.tx.storageMass??0n).toString(),candidate:false,finalized:true,acceptOnly:true,reconciled:true,
  };
  await durable(join(dir,receiptFile),rec);
  state.step++;
  state.receipts.push(rec);
  await saveRunState(dir,state);
  return {reconciled:true,cid:state.cid,txid:ev.txid,acceptingBlock:ev.accepting,acceptingDaa:ev.acceptingDaa.toString(),step:state.step,buys:state.buys,bought:state.bought};
 }finally {
  rpc?.close();
  await lock.close();
  await unlink(join(runsRoot,'writer.lock')).catch(()=>{});
 }
}

async function waitManagerLive(rpc,manager,{timeoutMs=60000,pollMs=250}={}) {
 const until=Date.now()+timeoutMs;
 while(Date.now()<until) {
  try{await verifyInputsLive(rpc,[{...manager,daa:manager.utxoDaa}],{allowDaaDrift:true});return;}
  catch(e){if((e.code??e.safeCode)!=='STALE_INPUT')throw e;}
  await sleep(pollMs);
 }
 throw new Error('CONTENTION_MANAGER_NOT_LIVE');
}

async function safeChainCursor(rpc,hash=null,depth=2) {
 try{return await chainCursor(rpc,hash,depth);}
 catch(e){
  if((e.code??e.safeCode??e.message)==='CURSOR_RECOVERY_BOUND')return await chainCursor(rpc,null,16);
  throw e;
 }
}

const REORG_TRANSIENT=new Set(['CURSOR_REORG','NOT_CHAIN','REORG','RPC_TIMEOUT','SINK_BEHIND','READ_VIEW_CHANGED']);
export async function searchWithReorg(rpc,txid,cursor,{pages=12}={}) {
 let cur=cursor;
 for(let attempt=0;attempt<6;attempt++) {
  try{
   const found=await searchAccepted(rpc,txid,cur,{pages});
   return {found,cursor:found.cursor??cur};
  }catch(e){
   const code=e.code??e.safeCode??e.message;
   if(code==='CURSOR_REORG'||code==='NOT_CHAIN'||code==='REORG'){cur=await safeChainCursor(rpc,cur,16);continue;}
   throw e;
  }
 }
 // Never jump forward to the live chain tip on fallback, or an already-accepted tx in the search window can be skipped.
 const fallback=await safeChainCursor(rpc,cursor,16);
 const found=await searchAccepted(rpc,txid,fallback,{pages});
 return {found,cursor:found.cursor??fallback};
}

export async function waitContentionOutcome(rpc,outcomes,cursor,{timeoutMs=600000,pollMs=250}={}) {
 const candidates=outcomes.filter(o=>o.txid&&o.status!=='UNSENT');
 check(candidates.length>=1,'CONTENTION_NO_SUBMITTED_CANDIDATE');
 const until=Date.now()+timeoutMs;
 const cursors=new Map(candidates.map(o=>[o.txid,cursor]));
 while(Date.now()<until) {
  const accepted=new Set();
  for(const o of candidates) {
   let res;
   try{res=await searchWithReorg(rpc,o.txid,cursors.get(o.txid),{pages:12});}
   catch(e){
    if(REORG_TRANSIENT.has(e.code??e.safeCode??e.message))continue;
    throw e;
   }
   if(res.found.accepting)accepted.add(o.txid);
   // Only advance cursor when page budget was exhausted (complete === false);
   // if we reached the tip (complete === true), keep the safe pre-submit cursor so we don't chase 0-conf tip reorgs.
   else if(res.found.complete===false)cursors.set(o.txid,res.cursor);
  }
  if(accepted.size>1)throw new Error('MULTIPLE_CANONICAL_MANAGER_SPENDS');
  if(accepted.size===1)return pickWinningOutcome(outcomes,accepted);
  await sleep(pollMs);
 }
 throw new Error('CONTENTION_WINNER_TIMEOUT');
}

async function verifyLoserAbsent(rpc,loser,cursor,{timeoutMs=30000,pollMs=250}={}) {
 if(!loser.txid||loser.status==='UNSENT')return {role:loser.role,pid:loser.pid,txid:loser.txid??null,status:loser.status,absent:true,inMempool:false,classification:loser.classification??null};
 const until=Date.now()+timeoutMs;
 let cur=cursor;
 while(Date.now()<until) {
  try {
   const res=await searchWithReorg(rpc,loser.txid,cur,{pages:6});
   cur=res.cursor;
   check(!res.found.accepting,`LOSER_UNEXPECTEDLY_ACCEPTED:${loser.role}:${loser.txid}`);
   const inMempool=!!await mempoolEntry(rpc,loser.txid);
   if(res.found.complete&&!inMempool) {
    return {role:loser.role,pid:loser.pid,txid:loser.txid,status:loser.status,absent:true,inMempool:false,nodeError:loser.nodeError??null,classification:loser.classification??null};
   }
  }catch(e){
   if(!REORG_TRANSIENT.has(e.code??e.safeCode??e.message))throw e;
  }
  await sleep(pollMs);
 }
 throw new Error(`LOSER_STILL_IN_MEMPOOL:${loser.role}:${loser.txid}`);
}

async function runWorker({role,node}) {
 check(Object.hasOwn(LOCK_ROLE,role),'WORKER_ROLE');
 const profile=await loadDeploymentProfile();
 const signer=await openTestSigner(role,TN10.networkId);
 const nodeCandidates=parseNodeCandidates(node);
 let rpc=await connectCandidateNodes(nodeCandidates);
 const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
 let currentIntent=null;
 const emit=obj=>process.stdout.write(packIpc(obj)+'\n');
 const reconnectWorker=async(preferred=null)=>{
  try{rpc.close();}catch{}
  const list=preferred?[preferred,...nodeCandidates.filter(u=>u!==preferred)]:nodeCandidates;
  rpc=await connectCandidateNodes(list);
 };
 try {
  emit({event:'online',role,pid:process.pid,address:signer.address,node:rpc.url});
  for await (const line of rl) {
   if(!line.trim())continue;
   const msg=unpackIpc(line);
   if(msg.cmd==='quit')break;
   if(msg.cmd==='reconnect'){
    try{await reconnectWorker(msg.node??null);emit({event:'reconnected',role,pid:process.pid,node:rpc.url});}
    catch(e){emit({event:'reconnect_error',role,pid:process.pid,code:e.code??e.safeCode??e.message});}
    continue;
   }
   if(msg.cmd==='prepare') {
    currentIntent=null;
    const state=msg.state,settings=msg.settings??{};
    try {
     let feeInfo;
     try{feeInfo=parseFeeEstimate(await rpc.call('getFeeEstimate'));}
     catch(e){
      if(NODE_CONN_ERR.has(e?.code??e?.safeCode??e?.message)){await reconnectWorker();feeInfo=parseFeeEstimate(await rpc.call('getFeeEstimate'));}
      else throw e;
     }
     if(role==='creator') {
      const need=S.PRICE_MIN+S.FEE_CAP+1n;
      const live=(await commonUtxos(rpc,signer.address)).filter(u=>!u.isCoinbase&&!u.covenantId).reduce((s,u)=>s+u.value,0n);
      check(live>=need+CREATOR_RESERVE_SOMPI,'CREATOR_RESERVE_REACHED');
     }
     const feeRates=buildFeeRateLadder(feeInfo);
     let rateIdx=0,prepared;
     for(let attempt=0;;attempt++) {
      try {
       const op={action:'BUY',quantity:1,role,...(msg.buyerKey?{buyerKey:msg.buyerKey}:{})};
       prepared=await prepare(rpc,state,profile,op,signer,settings,{feerate:feeRates[rateIdx]});
       break;
      }catch(e) {
       const c=e.code??e.safeCode??e.message;
       if(['FEE','FEE_CONVERGENCE','PAYMENT','EXPERIMENT_FEE_CAP'].includes(c)&&rateIdx+1<feeRates.length){rateIdx++;continue;}
       const retryLimit=c==='TEST_WALLET_FUNDS_INSUFFICIENT'?6:12;
       if(attempt>=retryLimit||!['STALE_INPUT','TEST_WALLET_NEEDS_SINGLE_FUNDING_UTXO','TEST_WALLET_FUNDS_INSUFFICIENT'].includes(c))throw e;
       await sleep(250);
      }
     }
     const cursor=state.accepting??await chainCursor(rpc,null,8);
     const txid=referenceTxId(prepared.draft.transaction);
     const wireDigest=createHash('sha256').update(jsonText(txToRpc(prepared.draft.transaction))).digest('hex');
     currentIntent={...prepared,txid,cursor,wireDigest,status:'PREPARED',action:'BUY',quantity:1,network:TN10.networkId,profileId:profile.id,accessor:null,proof:null};
     emit({
      event:'prepared',round:msg.round,pid:process.pid,role,txid,
      feeSompi:prepared.draft.fee.toString(),
      managerOutpoint:`${state.manager.outpoint.transactionId}:${state.manager.outpoint.index}`,
      buyerKey:msg.buyerKey??signer.key,
     });
    }catch(e) {
     emit({event:'prepare_error',round:msg.round,pid:process.pid,role,code:e.code??e.safeCode??e.message??'PREPARE_FAILED'});
    }
   }else if(msg.cmd==='submit') {
    check(currentIntent&&currentIntent.txid,'WORKER_NOT_PREPARED');
    const intent=currentIntent;currentIntent=null;
    try {
     await submitIntent(rpc,intent);
     intent.status='SUBMITTED';
     emit({event:'submit_result',round:msg.round,pid:process.pid,role,txid:intent.txid,status:'SUBMITTED',intent});
    }catch(e) {
     const status=!e.submissionAttempted?'UNSENT':e instanceof RpcError?'REJECTED':'UNKNOWN';
     const errorCode=e.code??e.safeCode??e.name;
     const nodeError=e instanceof RpcError?e.message:null;
     intent.status=status;intent.errorCode=errorCode;if(nodeError)intent.nodeError=nodeError;
     const classification=nodeError?classifyRejection({nodeError,draft:intent.draft}):null;
     emit({event:'submit_result',round:msg.round,pid:process.pid,role,txid:intent.txid,status,errorCode,nodeError,classification,intent});
    }
   }
  }
 }finally{rl.close();signer.close();rpc.close();}
}

function spawnWorker({role,node}) {
 const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',`--role=${role}`,`--node=${node}`],{stdio:['pipe','pipe','inherit']});
 const rl=createInterface({input:child.stdout,crlfDelay:Infinity});
 const waiters=[];
 rl.on('line',line=>{
  if(!line.trim())return;
  const msg=unpackIpc(line);
  const w=waiters.shift();
  if(w)w.resolve(msg);
 });
 child.on('exit',code=>{
  while(waiters.length)waiters.shift().reject(new Error(`WORKER_EXITED_${role}_${code}`));
 });
 const nextEvent=(timeoutMs=45000)=>new Promise((res,rej)=>{
  const t=setTimeout(()=>rej(new Error(`WORKER_TIMEOUT_${role}`)),timeoutMs);
  waiters.push({
   resolve:v=>{clearTimeout(t);res(v);},
   reject:e=>{clearTimeout(t);rej(e);},
  });
 });
 return {
  role,
  child,
  get pid(){return child.pid;},
  send(obj){child.stdin.write(packIpc(obj)+'\n');},
  nextEvent,
  async close(){
   if(child.exitCode!==null||child.signalCode!==null){rl.close();return;}
   try{this.send({cmd:'quit'});}catch{}
   await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);
   if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
   rl.close();
  },
 };
}

export async function executeContention({runDir,rounds=5,continuous=false,rolesSpec='creator,buyer1,buyer2',node=DEFAULT_LOCAL_NODE,pollMs=250,buyerPool=64,winnerTimeoutMs=600000}={}) {
 check(process.env.KASWIN_VM_BIN,'KASWIN_VM_BIN_REQUIRED');
 check(continuous||rounds===0||(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=1000),'CONTENTION_ROUNDS');
 check(Number.isSafeInteger(pollMs)&&pollMs>=100&&pollMs<=5000,'POLL_INTERVAL');
 check(Number.isSafeInteger(buyerPool)&&buyerPool>=0&&buyerPool<=256,'BUYER_POOL_SIZE');
 check(Number.isSafeInteger(winnerTimeoutMs)&&winnerTimeoutMs>=30000&&winnerTimeoutMs<=3600000,'WINNER_TIMEOUT_MS');
 const maxRounds=continuous||rounds===0?Infinity:rounds;
 const roles=parseContentionRoles(rolesSpec);
 const dir=resolve(runDir);
 check(dirname(dir)===runsRoot,'CONTENTION_RUN_DIR_SCOPE');
 await mkdir(runsRoot,{recursive:true,mode:0o700});
 const others=(await readdir(runsRoot)).filter(n=>/^writer(-[AB])?\.lock$/.test(n));
 check(others.length===0,`WRITER_LOCK_ACTIVE:${others.join(',')}`);
 const lock=await open(join(runsRoot,'writer.lock'),'wx',0o600);
 await lock.writeFile(String(process.pid));
 const walletLocks=[];
 let rpc,stopping=false;
 const workers=[];
 const onSignal=sig=>{if(stopping)process.exit(143);stopping=true;console.error(JSON.stringify({gracefulStop:sig,pid:process.pid}));};
 process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 try {
  for(const role of roles)walletLocks.push(acquireWalletLock(lockDir,LOCK_ROLE[role],`tn10-contention ${role}`));
  const profile=await loadDeploymentProfile();
  const state=await loadRunState(dir);
  check(state.network===TN10.networkId&&state.profileId===profile.id,'CONTENTION_STATE_SCOPE');
  check(!state.terminal&&!state.intent&&state.manager,'CONTENTION_ROUND_NOT_ACTIVE_SALES');
  check(identify(state.manager.redeemScript,profile).module==='sales','CONTENTION_NOT_SALES_MODULE');
  const settings=plan(state.scenario);
  if(Number.isFinite(maxRounds))check(state.buys+maxRounds<=settings.buys,'CONTENTION_EXCEEDS_SCENARIO_BUYS');

  const poolKeys=new Map();
  if(buyerPool>0) {
   const poolBase=state.lane==='B'?'buyer2':'buyer1';
   if(roles.includes(poolBase)) {
    const pool=await openDerivedBuyerPool(poolBase,buyerPool,TN10.networkId);
    try{poolKeys.set(poolBase,pool.entries.map(e=>e.key));}finally{pool.close();}
   }
  }

  const nodeCandidates=parseNodeCandidates(node);
  const workerNodeSpec=nodeCandidates.join(',');
  rpc=await connectCandidateNodes(nodeCandidates);
  for(const role of roles)workers.push(spawnWorker({role,node:workerNodeSpec}));
  const onlines=await Promise.all(workers.map(w=>w.nextEvent()));
  for(const o of onlines)check(o.event==='online','WORKER_ONLINE_FAILED');
  console.log(JSON.stringify({contentionStart:true,cid:state.cid,runDir:dir,node:rpc.url,nodeCandidates,continuous:maxRounds===Infinity,rounds:maxRounds===Infinity?null:maxRounds,workers:onlines.map(o=>({role:o.role,pid:o.pid,address:o.address,node:o.node}))}));

  const report={schema:'TN10_MULTIPROCESS_CONTENTION_V1',cid:state.cid,runDir:dir,node:rpc.url,continuous:maxRounds===Infinity,startedAt:new Date().toISOString(),workers:onlines,roundsCompleted:0,winsByRole:{},recentRounds:[]};
  let activeWorkers=[...workers],r=0;
  const reconnectAll=async reason=>{
   try{rpc?.close();}catch{}
   rpc=await connectCandidateNodes(nodeCandidates);
   console.error(JSON.stringify({contentionNodeSwitch:true,reason,node:rpc.url}));
   for(const w of activeWorkers)w.send({cmd:'reconnect',node:rpc.url});
   const evs=await Promise.all(activeWorkers.map(w=>w.nextEvent(30000)));
   for(const ev of evs)check(ev.event==='reconnected',`WORKER_RECONNECT_FAILED:${ev.role}:${ev.code??ev.event}`);
  };
  while(!stopping&&r<maxRounds&&state.buys<settings.buys&&activeWorkers.length>=2) {
   r++;
   try{
    await waitManagerLive(rpc,state.manager,{pollMs});
   }catch(e){
    const c=e?.code??e?.safeCode??e?.message;
    if(!NODE_CONN_ERR.has(c))throw e;
    await reconnectAll(c);
    await waitManagerLive(rpc,state.manager,{pollMs});
   }
   const contestedOutpoint=`${state.manager.outpoint.transactionId}:${state.manager.outpoint.index}`;
   // Always anchor the pre-submit search cursor safely behind the current chain tip rather than a potentially stale state.accepting.
   const cursor=await safeChainCursor(rpc,null,16);
   const stepState={
    network:state.network,profileId:state.profileId,scenario:state.scenario,cid:state.cid,origin:state.origin,
    accepting:cursor,manager:state.manager,buys:state.buys,bought:state.bought,step:state.step,lane:state.lane??null,
   };
   for(let i=0;i<activeWorkers.length;i++) {
    const w=activeWorkers[i],keys=poolKeys.get(w.role);
    const buyerKey=keys?selectBuyerKey(state.buys+i,keys):null;
    w.send({cmd:'prepare',round:r,state:stepState,settings,buyerKey});
   }
   const prepEvents=await Promise.all(activeWorkers.map(w=>w.nextEvent()));
   const dropped=new Set();
   for(const p of prepEvents) {
    if(p.event==='prepare_error'&&['CREATOR_RESERVE_REACHED','TEST_WALLET_FUNDS_INSUFFICIENT'].includes(p.code)) {
     dropped.add(p.role);
     console.log(JSON.stringify({contentionWorkerDropped:p.role,reason:p.code,round:r}));
     continue;
    }
    check(p.event==='prepared'&&p.managerOutpoint===contestedOutpoint,`WORKER_PREPARE_FAILED:${p.role}:${p.code??p.event}`);
   }
   if(dropped.size) {
    for(const w of activeWorkers)if(dropped.has(w.role))await w.close().catch(()=>{});
    activeWorkers=activeWorkers.filter(w=>!dropped.has(w.role));
    if(activeWorkers.length<2){
     if(maxRounds===Infinity){console.log(JSON.stringify({contentionStopped:'FEWER_THAN_TWO_FUNDED_WORKERS',round:r}));break;}
     throw new Error('CONTENTION_FEWER_THAN_TWO_ACTIVE_WORKERS');
    }
   }

   // Barrier complete: randomize dispatch order each round so every contending worker gets fair first-send chance.
   const submitOrder=shuffleWorkers(activeWorkers);
   for(const w of submitOrder)w.send({cmd:'submit',round:r});
   const outcomes=await Promise.all(submitOrder.map(w=>w.nextEvent(60000)));
   for(const o of outcomes)check(o.event==='submit_result',`WORKER_SUBMIT_EVENT:${o.role}`);

   let winner,losers;
   try{
    ({winner,losers}=await waitContentionOutcome(rpc,outcomes,cursor,{timeoutMs:winnerTimeoutMs,pollMs}));
   }catch(e){
    const c=e?.code??e?.safeCode??e?.message;
    if(!NODE_CONN_ERR.has(c))throw e;
    await reconnectAll(c);
    ({winner,losers}=await waitContentionOutcome(rpc,outcomes,cursor,{timeoutMs:winnerTimeoutMs,pollMs}));
   }
   const winnerIntent=winner.intent;
   winnerIntent.cursor=cursor;
   const receipt=await settle(rpc,winnerIntent,{recover:false,depth:0n,pollMs});
   verifyContentionReceipt(receipt,state.manager,winnerIntent.draft);

   // Persist the accepted winner immediately so a subsequent reorg/check on losers never leaves state.json behind.
   const intentFile=stepFile(state.step,'intent.json');
   winnerIntent.status='SUBMITTED';
   await durable(join(dir,intentFile),winnerIntent);
   await durable(join(dir,stepFile(state.step,'receipt.json')),receipt);
   advance(state,winnerIntent,receipt,profile);
   const latest=state.receipts.at(-1);
   Object.assign(latest,{accepted:true,candidate:false,finalized:true,acceptOnly:true,intentFile});
   await saveRunState(dir,state);

   const loserChecks=[];
   for(const l of losers)loserChecks.push(await verifyLoserAbsent(rpc,l,cursor,{pollMs}));

   const summary={
    round:r,
    at:new Date().toISOString(),
    step:state.step,
    buys:state.buys,
    submitOrder:submitOrder.map(w=>w.role),
    contestedOutpoint,
    winner:{role:winner.role,pid:winner.pid,txid:winner.txid,acceptingBlock:receipt.acceptingBlock,acceptingDaa:receipt.acceptingDaa.toString(),feeSompi:receipt.actualFee.toString()},
    losers:loserChecks,
   };
   report.roundsCompleted++;
   report.winsByRole[winner.role]=(report.winsByRole[winner.role]??0)+1;
   report.recentRounds.push(summary);
   if(report.recentRounds.length>100)report.recentRounds.shift();
   await appendFile(join(dir,'contention.ndjson'),JSON.stringify(summary)+'\n',{mode:0o600});
   console.log(JSON.stringify(summary));
  }
  report.stopped=stopping;
  report.finishedAt=new Date().toISOString();
  const reportPath=join(dir,`contention-${Date.now()}.json`);
  await durable(reportPath,report);
  return {reportPath,cid:state.cid,rounds:report.roundsCompleted,winsByRole:report.winsByRole,finalStep:state.step,finalBuys:state.buys,stopped:stopping};
 }finally {
  process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);
  await Promise.all(workers.map(w=>w.close().catch(()=>{})));
  rpc?.close();
  for(const release of walletLocks)release();
  await lock.close();
  await unlink(join(runsRoot,'writer.lock')).catch(()=>{});
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const arg=n=>process.argv.find(x=>x.startsWith(`--${n}=`))?.slice(n.length+3);
 try {
  if(process.argv.includes('--worker')) {
   await runWorker({role:arg('role'),node:arg('node')??'ws://127.0.0.1:18210'});
  }else if(process.argv.includes('--reconcile')) {
   const out=await reconcileAcceptedBuy({
    runDir:arg('run-dir'),
    txid:arg('txid'),
    block:arg('block'),
    node:arg('node')??'ws://127.0.0.1:18210',
   });
   console.log(JSON.stringify(out));
  }else {
   check(process.argv.includes('--execute'),'EXPLICIT_EXECUTE_REQUIRED');
   const out=await executeContention({
    runDir:arg('run-dir'),
    rounds:arg('rounds')!=null?Number(arg('rounds')):5,
    continuous:process.argv.includes('--continuous'),
    rolesSpec:arg('roles')??'creator,buyer1,buyer2',
    node:arg('node')??'ws://127.0.0.1:18210',
    pollMs:arg('poll-ms')?Number(arg('poll-ms')):250,
    buyerPool:arg('buyer-pool')!=null?Number(arg('buyer-pool')):64,
    winnerTimeoutMs:arg('winner-timeout-ms')!=null?Number(arg('winner-timeout-ms')):600000,
   });
   console.log(JSON.stringify(out));
  }
 }catch(e){console.error(e.code??e.safeCode??e.message);process.exitCode=1;}
}
