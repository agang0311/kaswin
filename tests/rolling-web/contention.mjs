// Real-page TN10 contention. Already-signed submit bytes may wait at a <=18 s test barrier; bytes/replies are never rewritten.
// All participants must reach the barrier and receive real node outcomes. Failed cases settle or retain resumable profiles and stop.
import fs from 'node:fs';
import path from 'node:path';
import {RollingPage} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';
import {SubmissionBarrier} from './submission-barrier.mjs';
import {classifyRejection} from '../../web/rolling-tn10/conflict.mjs';
import {mempoolEntry,commonUtxos,sameInput,inputsState} from '../../scripts/chain/chain.mjs';
import {spkToAddress} from '../../scripts/wallet/address.mjs';
import {saveJson,readRound,openEvidenceRpc,stableCursor,roundReady,waitActionQuote,quoteId,executeAction,sendQuote,acceptanceEvidence,absentEvidence,finalizedRound,pause} from './evidence.mjs';
const HERE=path.dirname(new URL(import.meta.url).pathname),ROOT=path.join(HERE,'../output/rolling-runs');
const arg=(k,d)=>process.argv.find(a=>a.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const cases=arg('cases','three-buy,close,buy-close,cross-node').split(','),attempts=Number(arg('attempts','4'));
if(cases.some(x=>!['three-buy','close','buy-close','cross-node'].includes(x))||!Number.isInteger(attempts)||attempts<1||attempts>8)throw new Error('CASE_OR_ATTEMPTS');
for(const role of ['creator','b1','b2'])acquireWalletLock(ROOT,role,'contention campaign');
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),RUN=path.join(ROOT,`${stamp}-contention`);
fs.mkdirSync(RUN,{recursive:true});
const log=(...args)=>{const line=`${new Date().toISOString()} ${args.join(' ')}`;console.log(line);fs.appendFileSync(path.join(RUN,'run.log'),line+'\n');};
const data={schema:'ROLLING_CONTENTION_CAMPAIGN_2',cases:[],page:'https://cd311.cn:888/www/rolling-tn10/'};
const save=()=>saveJson(path.join(RUN,'result.json'),data);
const local='wss://cd311.cn:888/www/rolling-tn10/node',remote=arg('remote','wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json');
const rpc=await openEvidenceRpc();
async function noModal(a) {
 if(!await a.page.p.locator('#modal[open]').count())return;
 // A quote can be cancelled, but signing/submission must complete or reach its own unknown-result timeout.
 const deadline=Date.now()+90000;
 while(await a.page.p.locator('#modal[open]').count()) {
  if(!await a.page.p.locator('#mClose').isDisabled()){await a.page.p.locator('#mClose').click();return;}
  if(Date.now()>deadline)throw new Error(`MODAL_OPERATION_STILL_RUNNING ${a.role}`);
  await pause(200);
 }
}
async function snapshot(a) {
 await noModal(a);
 if(!await a.page.p.locator('[data-act=export]').count()) {
  await a.page.p.getByRole('button',{name:'广场',exact:true}).first().click();await pause(100);
  const card=a.page.p.locator('[data-open]').first();if(!await card.count())return null;
  await card.click();await a.page.p.locator('[data-act=export]').waitFor({state:'visible'});
 }
 return readRound(a.page);
}
async function inputsLive(intent) {
 const expected=intent.draft.inputUtxos.map(u=>({...u,daa:u.utxoDaa??u.daa})),states=await inputsState(rpc,expected);
 return states.every((s,n)=>sameInput(s.utxo,expected[n],{allowDaaDrift:true}));
}
async function liveManager(round) {
 if(!round.manager)return false;
 const found=await commonUtxos(rpc,spkToAddress(round.manager.spk,'kaspatest'));
 return found.some(u=>u.outpoint.transactionId===round.manager.outpoint.transactionId&&u.outpoint.index===round.manager.outpoint.index&&sameInput(u,{...round.manager,daa:round.manager.utxoDaa},{allowDaaDrift:true}));
}
async function findWinner(actors,cursor,timeout=90000) {
 const end=Date.now()+timeout;
 while(Date.now()<end) {
  const observed=await Promise.all(actors.map(a=>absentEvidence(rpc,a.txid,cursor)));
  const found=observed.flatMap((o,i)=>o.accepted?[actors[i]]:[]);
  if(found.length===1)return {actor:found[0],observed};
  if(found.length>1)throw new Error('MULTIPLE_CANONICAL_MANAGER_SPENDS');
  await pause(500);
 }
 throw new Error('NO_CHAIN_WINNER_WITHIN_RECONCILIATION_WINDOW');
}
async function settleOwner(all,record,cursor,gate) {
 // Independently reconcile profiles even if the main case failed before assigning its winner.
 const deadline=Date.now()+240000;let recoveryTxid=null,retryAfter=0;
 while(Date.now()<deadline) {
  const states=(await Promise.all(all.map(async a=>({a,r:await snapshot(a)})))).filter(x=>x.r);
  for(const {a,r} of states.sort((x,y)=>y.r.step-x.r.step)) {
   if(r.intent||r.halted)continue;
   if(r.terminal) {
    const receipt=r.receipts.at(-1);await acceptanceEvidence(rpc,receipt.txid,{block:receipt.acceptingBlock,cursor});return a;
   }
   if(await liveManager(r)) {
    // Don't race a still-unknown submit from another actor merely because its old input remains in the UTXO index.
    if(states.some(x=>x.r.intent&&['SUBMITTED','UNKNOWN','PREPARED'].includes(x.r.intent.status)))continue;
    return a;
   }
  }
  // If test transport aborted before forwarding, recover ONE original signed intent; never construct its replacement.
  // Other conflicts then have a spent manager input and may be discarded under the normal UI policy.
  for(const {a,r} of states)if(r.intent&&['UNKNOWN','SUBMITTED','PREPARED'].includes(r.intent.status)) {
   if(r.intent.txid!==a.txid)continue;
   const accepted=await absentEvidence(rpc,r.intent.txid,cursor);
   if(accepted.accepted){await a.page.clickAct('track');break;}
   if((recoveryTxid===null||recoveryTxid===r.intent.txid)&&Date.now()>=retryAfter&&!accepted.inMempool&&accepted.complete&&(await liveManager(r)||(r.intent.action==='GENESIS'&&await inputsLive(r.intent)))&&await a.page.enabled('recover')) {
    recoveryTxid=r.intent.txid;retryAfter=Date.now()+5000;gate.allowedRole=a.role;
    record.cleanupRecoveredOriginal=r.intent.txid;record.recoveryAttempts=(record.recoveryAttempts??0)+1;save();
    if(a.node!==local&&a.currentReadNode!==local){await a.page.setNode(local);a.currentReadNode=local;record.cleanupRecoveryNode=local;save();}
    await a.page.clickAct('recover');log(`cleanup: request recovery of same signed tx ${r.intent.txid}, attempt ${record.recoveryAttempts}`);break;
   }
  }
  // A REJECTED/UNSENT intent may be dropped immediately after the page performs its own negative acceptance/live-input checks.
  for(const {a,r} of states)if(r.intent&&['REJECTED','UNSENT'].includes(r.intent.status)&&await a.page.enabled('discard'))await a.page.clickAct('discard');
  // A winner's current manager is live even while another profile retains the now-lost intent. Identify that winner by its accepted receipt.
  for(const {a,r} of states)if(!r.intent&&!r.halted&&r.step>1&&await liveManager(r)) {
   const last=r.receipts.at(-1);await acceptanceEvidence(rpc,last.txid,{block:last.acceptingBlock,cursor});return a;
  }
  await pause(500);
 }
 throw new Error('NO_VERIFIED_SETTLEMENT_PROFILE; preserve all profiles');
}
async function clearLoser(a,record,cursor) {
 let round=await snapshot(a);const intent=round?.intent,raced=record.actors.some(x=>x.role===a.role),txid=intent?.txid??(raced?a.txid:null);
 if(!txid)return {alreadyCleared:true,nonParticipant:!raced};
 if(intent)saveJson(path.join(path.dirname(a.page.o.profileDir),`before-discard-${a.role}.json`),round);
 const own=a.node!==local,originalNode=own?await openEvidenceRpc(a.node):rpc;
 try{
  const info=await originalNode.call('getInfo'),expected=a.submitInfo?.p2pId??a.info.p2pId;
  if(info.p2pId!==expected)throw new Error(`SUBMIT_NODE_IDENTITY_CHANGED ${a.role}`);
  let absent,present=true;const negativeUntil=Date.now()+60000;
  while(Date.now()<negativeUntil){
   absent=await absentEvidence(rpc,txid,cursor);present=!!await mempoolEntry(originalNode,txid);
   if(!absent.accepted&&absent.complete&&!absent.inMempool&&!present)break;
   await pause(1000);
  }
  if(!absent||absent.accepted||!absent.complete||absent.inMempool||present)throw new Error(`LOSER_NOT_ABSENT ${a.role}`);
  const proof={txid,local:absent,actualSubmitNodeInMempool:false,actualSubmitNodeP2pId:info.p2pId,originalNodeProofTransport:'fresh read-only connection to the same p2pId'};
  if(!intent)return {...proof,alreadyCleared:true,pendingCandidates:round?.pending.length??0};
  // A remote moving tip can prevent its bounded scan from returning an empty last page. Use the local selected-chain policy for UI discard;
  // retain separate negative mempool evidence from the actual original submission node and the original signed intent above.
  if(own){await a.page.setNode(local);proof.uiReadNodeForDiscard=local;}
  if(['SUBMITTED','UNKNOWN','PREPARED'].includes(intent.status)){
   const grace=(intent.createdAtMs??Date.now())+181000;while(Date.now()<grace)await pause(Math.min(1000,grace-Date.now()));
  }
  const until=Date.now()+120000;
  while(Date.now()<until){
   round=await snapshot(a);
   if(!round?.intent){
    const finalNegative=await absentEvidence(rpc,txid,cursor);if(finalNegative.accepted||!finalNegative.complete||finalNegative.inMempool||await mempoolEntry(originalNode,txid))throw new Error(`LOSER_ABSENCE_CHANGED ${a.role}`);
    return {...proof,local:finalNegative,cleared:true};
   }
   if(round.intent.txid!==txid||round.intent.wireDigest!==intent.wireDigest)throw new Error(`LOSER_INTENT_CHANGED ${a.role}`);
   if(await a.page.enabled('discard'))await a.page.clickAct('discard');await pause(1000);
  }
  throw new Error(`LOSER_INTENT_NOT_CLEARED ${a.role}`);
 }finally{if(own)originalNode.close();}
}
async function one(kind,n) {
 const dir=path.join(RUN,`${kind}-${n}`);fs.mkdirSync(dir,{recursive:true});
 const record={kind,attempt:n,actors:[],pass:false};data.cases.push(record);save();
 const barrier=new SubmissionBarrier(),all=[];
 const mk=(role,node)=>{
  const a={role,node,replies:[],forwarded:false};
  a.page=new RollingPage({url:data.page,profileDir:path.join(dir,`profile-${role}`),log,
   submitGate:(send,socket)=>{
    a.submitProbe=socket.probeCall;a.submitUrl=socket.url;
    if(barrier.aborted){if(barrier.allowedRole===role)send();else barrier.lateDropped[role]=(barrier.lateDropped[role]??0)+1;return;}
    if(!barrier.enabled)send();else barrier.hold(role,send);
   },
   wsTap:event=>{if(event.kind==='submitReply')a.replies.push(event);}});
  all.push(a);return a;
 };
 const C=mk('creator',local),A=mk('b1',local),B=mk('b2',kind==='cross-node'?remote:local);
 let cursor,created=false,actors=[],mainPassed=false,expectedTerminal;
 try {
  log(`START ${kind} attempt ${n}`);
  await Promise.all(all.map(a=>a.page.open()));
  for(const a of all){await a.page.setNode(a.node);await a.page.connect(a.role);a.info=await a.page.probeCall('getInfo');}
  let delay=0;
  if(kind==='cross-node') {
   if(!A.info.p2pId||!B.info.p2pId||A.info.p2pId===B.info.p2pId)throw new Error('CROSS_NODE_IDENTITIES_MISSING_OR_SAME');
   const t=Date.now();await B.page.probeCall('getInfo');record.publicProbeRttMs=Date.now()-t;delay=Math.min(2000,Math.max(0,Math.round(record.publicProbeRttMs/2)));
  }
  record.actualConnections=all.map(a=>({role:a.role,url:a.page.probeConnectionUrl,p2pId:a.info.p2pId,serverVersion:a.info.serverVersion}));
  cursor=await stableCursor(rpc);record.cursor=cursor;
  await C.page.fillCreate({price:'1',cap:10,min:10,minutes:1});await C.page.clickCreate();
  if(!await C.page.waitQuote())throw new Error('GENESIS_QUOTE_TIMEOUT');
  C.txid=await quoteId(C.page);created=true;record.genesisAttempted=C.txid;save();
  const initial=(await sendQuote(C.page,'GENESIS',{log})).round;
  record.cid=initial.cid;saveJson(path.join(dir,'checkpoint.json'),initial);save();
  const share=await C.page.exportRoundText();await A.page.joinText(share);await B.page.joinText(share);
  for(const a of [A,B])await roundReady(a.page,r=>r.manager&&!r.intent);
  actors=kind==='three-buy'?[C,A,B]:[A,B];
  for(const a of actors)a.action=kind==='close'||(kind==='buy-close'&&a===B)?'CLOSE':'BUY';
  const quotes=await Promise.allSettled(actors.map(a=>waitActionQuote(a.page,a.action,300000)));
  if(quotes.some(r=>r.status==='rejected'))throw new Error('NOT_ALL_QUOTES_READY');
  for(const a of actors){a.txid=await quoteId(a.page);a.replies=[];}
  record.contestedOutpoint=`${initial.manager.outpoint.transactionId}:${initial.manager.outpoint.index}`;
  barrier.enabled=true;record.signingOrder=[];
  const overall=Date.now()+180000,signingOrder=kind==='cross-node'?[B,A]:actors;
  // Finish the slower public-node checks before holding the first signed frame.
  for(const a of signingOrder) {
   await a.page.clickSend();
   while(!barrier.sends.has(a.role)&&Date.now()<overall) {
    if(barrier.expired())break;
    await pause(20);
   }
   record.signingOrder.push({role:a.role,reachedBarrier:barrier.sends.has(a.role)});
   if(!barrier.sends.has(a.role))break;
  }
  record.barrierParticipants=barrier.sends.size;
  if(barrier.sends.size===actors.length){
   record.submissionConnections=await barrier.withinWindow(()=>Promise.all(actors.map(async a=>{a.submitInfo=await a.submitProbe('getInfo');if(a.submitInfo.p2pId!==a.info.p2pId)throw new Error('SUBMIT_SOCKET_NODE_CHANGED');return {role:a.role,url:a.submitUrl,p2pId:a.submitInfo.p2pId};})));
   if(kind==='cross-node'&&new Set(record.submissionConnections.map(x=>x.p2pId)).size!==2)throw new Error('ACTUAL_SUBMIT_SOCKETS_NOT_DISTINCT');
  }
  if(barrier.sends.size!==actors.length||barrier.expired()) {
   record.barrierAborted=true;barrier.abort('INCOMPLETE_OR_EXPIRED_SUBMISSION_BARRIER');throw new Error('INCOMPLETE_OR_EXPIRED_SUBMISSION_BARRIER; no held frames forwarded');
  }
  record.barrierWindowMs=barrier.windowMs;record.localReleaseDelayMs=delay;
  const release=a=>{barrier.release(a.role);a.forwarded=true;};
  if(kind==='cross-node'){release(B);await barrier.withinWindow(()=>pause(delay));release(A);}else for(const a of actors)release(a);
  barrier.complete();
  const sends=await Promise.all(actors.map(a=>a.page.sendResult()));
  for(let i=0;i<actors.length;i++) {
   const a=actors[i],round=await snapshot(a),intent=round.intent;
   const result={role:a.role,action:a.action,node:a.node,txid:a.txid,forwarded:a.forwarded,status:sends[i].status,toasts:sends[i].toasts,replies:[...a.replies],classification:intent?.nodeError?classifyRejection(intent):null};
   record.actors.push(result);log(`${kind} ${a.role}: ${result.status} ${a.txid} ${result.classification?.kind??''}`);
  }
  const found=await findWinner(actors,cursor),winner=found.actor;
  const accepted=await acceptanceEvidence(rpc,winner.txid,{cursor});
  if(accepted.inputs[0].outpoint!==record.contestedOutpoint)throw new Error('CONFLICT_WAS_NOT_ON_MANAGER_INPUT');
  record.winner=winner.role;record.winnerTx=winner.txid;record.winnerAcceptance=accepted;
  record.dualNodeAdmission=kind==='cross-node'&&record.actors.every(a=>a.replies.some(r=>!r.error&&r.txid===a.txid));
  // Replies are correlated with submit requests by RPC id in the page tap; rejection replies have no transactionId field.
  record.allParticipated=record.barrierParticipants===actors.length&&record.actors.every(a=>a.forwarded&&a.replies.length>0);
  record.classificationsCorrect=record.actors.filter(a=>a.role!==winner.role&&a.status==='REJECTED').every(a=>a.classification?.kind==='ROUND_INPUT'&&a.classification.spender===winner.txid);
  const loserOutcomes=record.actors.filter(a=>a.role!==winner.role).every(a=>a.status==='REJECTED'||(kind==='cross-node'&&a.replies.some(r=>!r.error&&r.txid===a.txid)));
  expectedTerminal=winner.action==='CLOSE'?'EMPTY':'REFUNDED';
  mainPassed=record.allParticipated&&record.classificationsCorrect&&loserOutcomes&&(kind!=='cross-node'||record.dualNodeAdmission);
  save();
 }catch(e){record.error=String(e.message).slice(0,700);record.pass=false;log(`CASE ERROR ${record.error}`);}
 finally {
  // Abort any outstanding test hold. Never broadcast a queued frame from an exception handler.
  barrier.abort(record.error?'CASE_FAILED':'CASE_FINISHED');barrier.allowedRole=null;
  record.droppedUnforwardedFrames=[...barrier.droppedUnforwardedFrames];record.barrierAbortReason=barrier.abortReason;
  if(barrier.abortReason==='SUBMISSION_BARRIER_EXPIRED')record.barrierAborted=true;
  try {
   if(created) {
    const owner=await settleOwner(all,record,cursor,barrier);barrier.allowedRole=owner.role;
    if(owner.node!==local&&owner.currentReadNode!==local){await owner.page.setNode(local);owner.currentReadNode=local;}
    record.settlementNode=local;let round=await roundReady(owner.page);
    if(!round.terminal)({round}=await executeAction(owner.page,'CLOSE',{log,timeout:360000}));
    for(let step=0;!round.terminal&&step<10;step++) {
     const state=await owner.page.state(),next=['REFUND_OLD','REFUND_SELF','DRAW','PAY_OLD','PAY_SELF'].find(a=>state.acts.includes(a));
     if(!next)throw new Error('NO_SAFE_SETTLEMENT_ACTION');
     ({round}=await executeAction(owner.page,next,{log,timeout:360000}));
    }
    const done=await finalizedRound(owner.page,rpc,{cursor,dir,log});
    record.terminal=done.round.terminal;record.feeSompi=done.round.fees.toString();record.transactions=done.evidence.length;
    record.cleanup={};const finalShare=await owner.page.exportRoundText();
    for(const a of all.filter(a=>a!==owner)) {
     record.cleanup[a.role]=await clearLoser(a,record,cursor);
     await a.page.joinText(finalShare);await roundReady(a.page,r=>!r.intent&&r.terminal===done.round.terminal);
     record.cleanup[a.role].importedFinalState=true;
    }
    record.allLosersAbsent=Object.values(record.cleanup).every(r=>r.alreadyCleared||r.cleared);
    await owner.page.shot(dir,'final');
    record.pass=mainPassed&&!record.error&&record.allLosersAbsent&&record.terminal===expectedTerminal;
   }else record.noRoundCreated=true;
  }catch(e){record.pass=false;record.settlementError=String(e.message).slice(0,700);log(`SETTLEMENT ERROR ${record.settlementError}`);}
  finally{record.lateUnforwardedFrames=barrier.lateDropped;for(const a of all)await a.page.close_().catch(()=>{});save();}
 }
 log(`END ${kind} pass=${record.pass} dualAdmission=${record.dualNodeAdmission??false} terminal=${record.terminal??null}`);return record;
}
try {
 for(const kind of cases)for(let n=1;n<=(kind==='cross-node'?attempts:1);n++) {
  const result=await one(kind,n);
  if(result.settlementError)throw new Error('STOP_WITH_DURABLE_RECOVERY_PROFILES');
  if(result.pass||kind!=='cross-node')break;
 }
}finally{rpc.close();save();}
log(`run=${RUN}`);process.exitCode=cases.every(kind=>data.cases.some(r=>r.kind===kind&&r.pass))?0:1;
