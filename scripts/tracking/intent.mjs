/** Intent authentication, submission and acceptance re-verification (browser-safe port of tn10-run.mjs semantics).
 * Statuses: PREPARED (persisted, not yet sent) -> SUBMITTED | UNKNOWN | REJECTED | UNSENT.
 * V2.0.2 pacing: the FIRST selected-chain acceptance (searchAccepted + acceptedAt + matchesDraft) is a CANDIDATE and lets the
 * round continue at once; it becomes ACCEPTED only after recheckCandidate sees the accepting block >=100 DAA deep, still on the
 * selected chain, still matching the approved draft. REST/"included in a block" never counts. */
import {txToRpc,RpcError} from '../chain/nodes.mjs';
import {jsonText} from '../chain/json.mjs';
import {verifyInputsLive,searchAccepted,acceptedAt,matchesDraft,mempoolEntry,inputsState,sameInput,REORG_RECHECK_DAA} from '../chain/chain.mjs';
import {referenceTxId} from '../core/lib/transaction.js';
import {drawTargetFromOpening,requireConfirmedDrawTarget,assertFreshDrawConfirmation} from '../round/draw-confirmations.mjs';
import {quoteMass} from '../core.mjs';
import {check,hex,unhex} from '../core.mjs';
import {sha256Hex,TN10_NETWORK_ID,TN10_PROFILE_ID} from '../contract/protocol.mjs';
import {verifyOrdinarySignatures} from '../wallet/wallet.mjs';
import {interpretGenesis} from '../round/round.mjs';
import {interpretAccepted} from '../core.mjs';

export const wireDigestOf=tx=>sha256Hex(jsonText(txToRpc(tx)));
const code=e=>e?.code??e?.safeCode??e?.message;

/** Offline integrity of a persisted/imported intent: txid, exact wire bytes, mass, outpoints, ordinary signatures,
 * and an independent re-interpretation of the transaction effects against its input contexts. */
export async function authenticateIntent(intent,profile) {
  check(intent&&intent.network===TN10_NETWORK_ID&&intent.profileId===TN10_PROFILE_ID,'INTENT_SCOPE');
  const d=intent.draft,tx=d.transaction;
  check(referenceTxId(tx)===intent.txid,'INTENT_TXID');
  const wire=txToRpc(tx);check(sha256Hex(jsonText(wire))===intent.wireDigest,'INTENT_CONTENT_CHANGED');
  const mass=quoteMass(d);check(mass.storageMass===tx.storageMass,'INTENT_STORAGE_MASS');
  check(d.inputUtxos.length===tx.inputs.length,'INTENT_INPUT_COUNT');
  tx.inputs.forEach((i,n)=>check(d.inputUtxos[n].outpoint.transactionId===i.previousOutpoint.transactionId&&d.inputUtxos[n].outpoint.index===i.previousOutpoint.index,'INTENT_OUTPOINT'));
  check(d.inputUtxos.reduce((n,u)=>n+u.value,0n)-tx.outputs.reduce((n,o)=>n+o.value,0n)===d.fee,'INTENT_FEE');
  await verifyOrdinarySignatures(d);
  if(intent.action==='GENESIS') {
    const g=interpretGenesis({...tx,inputs:tx.inputs,outputs:tx.outputs},profile);check(g.cid===d.cid,'INTENT_GENESIS_CID');
  } else {
    const ctx=d.inputUtxos,t=intent.targetCount;
    const x=interpretAccepted({manager:ctx[0],targets:ctx.slice(1,1+t),funds:ctx.slice(1+t),transaction:tx,accessor:intent.accessor},profile);
    check(x.action===intent.action,'INTENT_ACTION');
  }
  return {wire,mass};
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
/** Cursor recorded in the intent BEFORE sending, ~32 chain blocks back, so the later acceptance search cannot miss the block. */
export const takeCursor=rpc=>chainCursor(rpc,null,32);
async function search(rpc,txid,cursor) {
  try{return await searchAccepted(rpc,txid,cursor,{pages:4});}
  catch(e){if(!['CURSOR_REORG'].includes(code(e)))throw e;return searchAccepted(rpc,txid,await chainCursor(rpc,cursor),{pages:4});}
}

/** Send the persisted intent's exact bytes. Throws with e.submissionAttempted=true once the frame was handed to the transport. */
export async function submitIntent(rpc,intent,profile,{beforeSend=()=>{}}={}) {
  let sent=false;
  try {
    const {wire,mass}=await authenticateIntent(intent,profile);
    await verifyInputsLive(rpc,intent.draft.inputUtxos.map(u=>({...u,daa:u.utxoDaa??u.daa})),{allowDaaDrift:true}); // a re-accepted parent may sit at another DAA
    const now=await rpc.currentDaa(),tx=intent.draft.transaction;
    check(tx.lockTime===0n||tx.lockTime<now,'SUBMIT_LOCK_MATURITY');
    tx.inputs.forEach((i,n)=>check(i.sequence===0n||now>=(intent.draft.inputUtxos[n].utxoDaa??intent.draft.inputUtxos[n].daa)+i.sequence,'SUBMIT_SEQUENCE_MATURITY'));
    let confirmation=null;
    if(intent.action==='DRAW') {
      check(intent.proof instanceof Uint8Array,'DRAW_PROOF_MISSING');
      confirmation=await requireConfirmedDrawTarget(rpc,drawTargetFromOpening(intent.proof));
    }
    const digest=intent.wireDigest;
    const result=await rpc.call('submitTransaction',{transaction:wire,allowOrphan:false},30000,{beforeSend:()=>{
      check(sha256Hex(jsonText(wire))===digest,'SUBMIT_CONTENT_CHANGED');
      if(confirmation)assertFreshDrawConfirmation(confirmation,confirmation,Date.now(),rpc);
      beforeSend();sent=true;}});
    check(result.transactionId===intent.txid,'SUBMIT_TXID');
    return {result,mass};
  } catch(e) {e.submissionAttempted=sent;throw e;}
}
/** Status to record after a failed send attempt. Unknown outcomes keep the intent and block replacement. */
export const statusAfterFailure=e=>!e.submissionAttempted?'UNSENT':e instanceof RpcError?'REJECTED':'UNKNOWN';

async function someInputLive(rpc,intent) {
  const probe=intent.draft.inputUtxos.map(u=>({...u,daa:u.utxoDaa??u.daa})),states=await inputsState(rpc,probe);
  return states.some(({utxo:u},n)=>u&&sameInput(u,probe[n],{allowDaaDrift:true}));
}
/** One acceptance pass. Returns {accepted:false,...progress} or {accepted:true,...receipt}. `recover` may resubmit the SAME signed bytes
 * (after live-input verification inside submitIntent) when the node neither has it accepted nor in its mempool. It never builds a new tx. */
export async function checkAcceptance(rpc,intent,profile,{recover=false,checkpoint=async()=>{}}={}) {
  await authenticateIntent(intent,profile);
  let found;
  try {found=await search(rpc,intent.txid,intent.cursor);}
  catch(e){
    if(['NOT_CHAIN','REORG','CURSOR_REORG','NOT_ACCEPTED','SINK_BEHIND','RPC_TIMEOUT','READ_VIEW_CHANGED'].includes(code(e)))return {accepted:false,transient:code(e)};
    // SEARCH_RANGE: the cursor is older than the node's search window (an intent left unresolved for ~11 h). The search is not needed when some input is still the
    // identical live UTXO: an accepted transaction spends ALL of its inputs, so one unspent input proves it was never accepted (and, if another input is gone, never can be).
    if(code(e)==='SEARCH_RANGE'&&await someInputLive(rpc,intent))found={accepting:null,complete:true,cursor:intent.cursor};else throw e;
  }
  intent.cursor=found.cursor;await checkpoint(intent);
  let resubmitted=false,conflict=false;
  if(recover&&!found.accepting&&found.complete) {
    check(intent.status!=='REJECTED','RECORDED_REJECTION_REQUIRES_REVIEW');
    if(!await mempoolEntry(rpc,intent.txid)) {
      try{await submitIntent(rpc,intent,profile);resubmitted=true;}
      catch(e){if(code(e)==='STALE_INPUT')conflict=true;else throw e;} // inputs gone: maybe just accepted (re-searched next pass) or spent elsewhere
    }
  }
  if(!found.accepting)return {accepted:false,complete:found.complete,resubmitted,inputsGone:conflict};
  const virtualDaa=await rpc.currentDaa(),ev=await acceptedAt(rpc,intent.txid,found.accepting);
  const firstFee=matchesDraft(ev,intent.draft),depth=virtualDaa>ev.acceptingDaa?virtualDaa-ev.acceptingDaa:0n;
  // Not deep enough: a CANDIDATE carrying everything the round needs to continue (effects are read from the node-served transaction).
  if(virtualDaa<ev.acceptingDaa+REORG_RECHECK_DAA)return {accepted:false,candidate:true,depth,txid:intent.txid,acceptingBlock:ev.accepting,acceptingDaa:ev.acceptingDaa,observedVirtualDaa:virtualDaa,
    nodeEndpoint:rpc.url,nodeComputeMass:ev.computeMass,storageMass:ev.tx.storageMass,quotedMass:intent.mass,actualFee:firstFee,tx:ev.tx,inputs:ev.inputs};
  const final=await acceptedAt(rpc,intent.txid,found.accepting),actualFee=matchesDraft(final,intent.draft);
  check(final.acceptingDaa===ev.acceptingDaa,'ACCEPTANCE_MOVED');
  return {accepted:true,txid:intent.txid,acceptingBlock:final.accepting,acceptingDaa:final.acceptingDaa,observedVirtualDaa:virtualDaa,nodeEndpoint:rpc.url,
    nodeComputeMass:final.computeMass,storageMass:final.tx.storageMass,quotedMass:intent.mass,actualFee,tx:final.tx,inputs:final.inputs};
}

const TRANSIENT=['RPC_TIMEOUT','SINK_BEHIND','READ_VIEW_CHANGED'],LIMBO_MS=180000;
/** Re-verify one CANDIDATE `entry`={txid,acceptingBlock,acceptingDaa,intent,limboSince?}. Returns
 *  {status:'WAIT'|'FINAL'|'REACCEPTED'|'LIMBO',...}; throws CANDIDATE_DROPPED when the transaction is neither accepted nor in the mempool
 *  (and any hard verification failure). A shallow selected-chain reorg normally re-accepts the SAME signed bytes in another block at a
 *  slightly different DAA: that is REACCEPTED (the caller records the history and refreshes the DAA of the UTXOs it created). */
export async function recheckCandidate(rpc,entry,profile,{now=Date.now()}={}) {
  const intent=entry.intent;
  await authenticateIntent(intent,profile);check(intent.txid===entry.txid,'CANDIDATE_INTENT');
  const virtualDaa=await rpc.currentDaa(),depth=virtualDaa>BigInt(entry.acceptingDaa)?virtualDaa-BigInt(entry.acceptingDaa):0n;
  try {
    const f=await acceptedAt(rpc,entry.txid,entry.acceptingBlock);matchesDraft(f,intent.draft);
    check(f.acceptingDaa.toString()===entry.acceptingDaa,'ACCEPTANCE_MOVED');
    return depth<REORG_RECHECK_DAA?{status:'WAIT',depth}:{status:'FINAL',depth,observedVirtualDaa:virtualDaa};
  } catch(e) {
    const k=code(e);
    if(TRANSIENT.includes(k))return {status:'WAIT',depth,transient:k};
    if(k!=='NOT_CHAIN'&&k!=='REORG')throw e;
  }
  let found;
  try{found=await search(rpc,entry.txid,intent.cursor);}catch(e){if(TRANSIENT.includes(code(e)))return {status:'WAIT',depth};throw e;}
  if(found.accepting) {
    const ev=await acceptedAt(rpc,entry.txid,found.accepting);matchesDraft(ev,intent.draft);
    return {status:'REACCEPTED',acceptingBlock:ev.accepting,acceptingDaa:ev.acceptingDaa};
  }
  if(!found.complete)return {status:'WAIT',depth};
  const since=entry.limboSince??now;
  if(await mempoolEntry(rpc,entry.txid)&&now-since<LIMBO_MS)return {status:'LIMBO',limboSince:since};
  throw Object.assign(new Error('CANDIDATE_DROPPED'),{code:'CANDIDATE_DROPPED'});
}
