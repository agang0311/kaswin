/** Client-side construction of every rolling action: live context verification, funding, draft, real-engine budget
 * measurement (service), local mass/fee recomputation, signing, signed-engine verification, intent record.
 * The page builds the draft itself (recipients and amounts come from the protocol transition); the service can only
 * advise budgets and is never asked to supply or modify outputs. Port of tn10-run.mjs prepare()/nextOperation(). */
import {probeNode} from '../chain/nodes.mjs';
import {TN10} from '../chain/tn10.mjs';
import {checkServerIdentity} from '../chain/node-identity.mjs';
import {commonUtxos,inputsState,sameInput} from '../chain/chain.mjs';
import {parseFeeEstimate} from '../chain/feetiers.mjs';
import {outpointKey,referenceTxId} from '../core/lib/transaction.js';
import {blake2b256} from '../core/lib/hashes.js';
import {stable} from '../core/lib/bytes.js';
import * as S from '../core.mjs';
import {verifyManager,identify} from '../core.mjs';
import {buildAction,buildGenesis,drawSample} from '../core.mjs';
import {quoteMass,ResourceLimit} from '../core.mjs';
import {acquireRollingProof} from './draw-proof.mjs';
import {interpretAccepted} from '../core.mjs';
import {verifyOrdinarySignatures} from '../wallet/wallet.mjs';
import {authenticateIntent,takeCursor,wireDigestOf} from '../tracking/intent.mjs';
import {interpretGenesis} from './round.mjs';
import {actionBudgets} from './budget.mjs';
import {TN10_PROFILE_ID,registryFor} from '../contract/protocol.mjs';
import {addressToSpk} from '../wallet/address.mjs';
const {check,hex}=S;
const FUNDED=['GENESIS','BUY','CLOSE','DRAW','TIMEOUT'];

function resolveRegistrySpk(registry,net=TN10) {
  if(registry===false||registry===null)return null;
  if(registry===undefined||registry===true)return net.registry.spk;
  check(typeof registry==='string'&&registry.trim().length>0,'REGISTRY_ADDRESS');
  try{return addressToSpk(registry.trim().toLowerCase(),net.addressPrefix);}
  catch{check(false,'REGISTRY_ADDRESS');}
}
export const PAYOUT_BATCH=16;

/** One Kaspa node matching `net`, synced and with UTXO index (probeNode verifies all three). */
export async function connectNetwork(urls,{net=TN10,...opts}={}) {
  let rpc,last;
  for(const url of urls) {try{rpc=await probeNode(url,{net,verifyDag:true,timeoutMs:15000,...opts});break;}catch(e){last=e;}}
  if(!rpc)throw last??new Error('NO_NODE');
  const call=rpc.call.bind(rpc);
  rpc.call=async(method,...args)=>{
    for(let attempt=0;;attempt++)try{return await call(method,...args);}catch(e){
      if(method.startsWith('submit')||attempt>=2||!['RPC_TIMEOUT','NODE_DISCONNECTED'].includes(e.code??e.safeCode))throw e;}
  };
  rpc.currentDaa=async()=>{const i=await rpc.call('getServerInfo');checkServerIdentity(i,net.networkId);return BigInt(i.virtualDaaScore);};
  return rpc;
}
export const connectTN10=(urls,opts={})=>connectNetwork(urls,{net:TN10,...opts});
/** Exact decimal fee: ceil(orderingMass * rate), never below the relay floor. */
export function requiredFee(mass,rate='100') {
  check(typeof rate==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(rate),'FEE_RATE');
  const [a,b='']=rate.split('.'),den=10n**BigInt(b.length),num=BigInt(a+b);
  const fee=(mass.orderingMass*num+den-1n)/den;return fee>mass.relayFloor?fee:mass.relayFloor;
}
export async function nodeFeeRate(rpc) {return String(Math.max(1,Math.ceil(parseFeeEstimate(await rpc.call('getFeeEstimate')).normal.feerate)));}

/** Imported or stale records are NOT trusted: each context must be the live, identical UTXO (value/script/covenant);
 * its DAA is then taken from the node. Returns refreshed copies. */
export async function refreshLive(rpc,contexts) {
  const probe=contexts.map(c=>({...c,daa:c.utxoDaa??c.daa,covenantId:c.cid&&c.cid!==S.ZERO?c.cid:(c.covenantId??null)}));
  const states=await inputsState(rpc,probe);
  return contexts.map((c,i)=>{
    const u=states[i].utxo;
    if(!u||!sameInput(u,{...probe[i],daa:u.daa}))throw Object.assign(new Error('STALE_INPUT'),{code:'STALE_INPUT',safeCode:'STALE_INPUT'});
    return {...c,utxoDaa:u.daa,daa:u.daa};
  });
}
export async function liveRound(rpc,round,profile,{targets=[]}={}) {
  check(round.manager,'ROUND_HAS_NO_MANAGER');
  const [[manager,...ts],currentDaa]=await Promise.all([refreshLive(rpc,[round.manager,...targets]),rpc.currentDaa()]);
  manager.currentDaa=currentDaa;manager.covenantId=manager.cid;
  const s=verifyManager(manager,profile);
  return {manager,targets:ts,state:s};
}
/** Outpoints that transactions already waiting in the node's mempool spend from `address` (its `sending` set).
 * getUtxosByAddresses lists CONFIRMED outputs only, so an output that an unconfirmed transaction already spends is still listed there: a second
 * prepare (another tab, another page profile, a script on the same wallet) would pick the same input and the node would answer
 * "output (…) already spent by transaction … in the mempool". The page's own `reserved` set cannot see other profiles.
 * Fail-open on purpose: if the node cannot answer, selection proceeds as before and the node's own rejection is the backstop (classifyRejection). */
export async function mempoolSpentOutpoints(rpc,address) {
  const spent=new Set();let r;
  try{r=await rpc.call('getMempoolEntriesByAddresses',{addresses:[address],includeOrphanPool:true,filterTransactionPool:false});}
  catch{return spent;}
  for(const g of Array.isArray(r?.entries)?r.entries:[])for(const e of Array.isArray(g?.sending)?g.sending:[])for(const i of Array.isArray(e?.transaction?.inputs)?e.transaction.inputs:[]) {
    const o=i?.previousOutpoint;if(o&&typeof o.transactionId==='string'&&Number.isInteger(Number(o.index)))spent.add(`${o.transactionId}:${Number(o.index)}`);
  }
  return spent;
}
/** Funding inputs for `minimum` sompi: largest first, at most 8, never coinbase/covenant, never an outpoint this page reserved, never one the mempool already spends.
 * WALLET_FUNDS_PENDING (not INSUFFICIENT) when the wallet would have enough if its unconfirmed spends were confirmed. */
export async function selectFunds(rpc,wallet,minimum,reserved=new Set()) {
  const [ownRaw,inPool]=await Promise.all([commonUtxos(rpc,wallet.address),mempoolSpentOutpoints(rpc,wallet.address)]);
  const own=ownRaw.filter(u=>!u.isCoinbase&&!u.covenantId&&!reserved.has(outpointKey(u.outpoint))&&u.spk.script===wallet.spk.script);
  const pick=list=>{
    const picked=[];let sum=0n;
    for(const u of list.slice().sort((a,b)=>a.value>b.value?-1:a.value<b.value?1:0)){if(picked.length===8)break;picked.push({...u,utxoDaa:u.daa});sum+=u.value;if(sum>=minimum)break;}
    return sum>=minimum?picked:null;
  };
  const picked=pick(own.filter(u=>!inPool.has(outpointKey(u.outpoint))));
  if(picked)return picked;
  check(!(inPool.size&&pick(own)),'WALLET_FUNDS_PENDING');
  check(false,'WALLET_FUNDS_INSUFFICIENT');
}
/** DRAW: real PASS-A for the first-crossing target + 100-confirmation requirement (tn10-proof, no fixtures). */
export async function planDraw(rpc,round,profile) {
  check(round.accepting,'ACCEPTING_BLOCK_REQUIRED');
  const {manager,state:s}=await liveRound(rpc,round,profile);check(s.module==='sealed','NOT_SEALED');
  const p=await acquireRollingProof(rpc,manager,profile,round.accepting);
  const sample=drawSample(manager,s,{proof:p.opening,accessor:p.accessor});
  const ends=[...s.indices.map(x=>x.end),S.totalTickets(s)],j=ends.findIndex(end=>sample.ticket<end);
  const winning=j<s.indices.length?round.frozen.find(f=>hex(blake2b256(f.redeemScript))===s.indices[j].hash):null;
  check(j===s.indices.length||winning,'WINNING_SHARD_PREIMAGE');
  return {action:'DRAW',proof:p.opening,accessor:p.accessor,j,winningRedeem:winning?.redeemScript};
}
/** Targets for PAY_OLD (up to `count` consecutive shards from the payout cursor) / REFUND_OLD (the shard at the refund cursor). */
export function pickTargets(round,s,profile,action,count=PAYOUT_BATCH) {
  const start=action==='PAY_OLD'?s.p:s.r,k=action==='PAY_OLD'?Math.min(count,s.indices.length-start):1,avail=[...round.frozen],out=[];
  check(start<s.indices.length&&k>=1,'NO_OLD_SHARD');
  for(let j=start;j<start+k;j++){ // shards with identical ledgers share a script hash; the one at the cursor is told apart by its expected value (a refunded shard is smaller)
    const at=avail.findIndex(f=>hex(blake2b256(f.redeemScript))===s.indices[j].hash&&f.value===S.frozenValue(s,j,identify(f.redeemScript,profile).records));check(at>=0,'FROZEN_TARGET_MISSING');out.push(avail.splice(at,1)[0]);}
  return out;
}

const effects=outs=>stable(outs.map(o=>({value:o.value,spk:o.scriptPublicKey,covenant:o.covenant??null})));
/** Build + locally budget + price one transaction (unsigned). `op` = {action,quantity?,proof?,accessor?,j?,winningRedeem?,settings?}. */
export async function prepareAction({rpc,profile,round,op,wallet,feerate,reserved=new Set(),net=TN10}) {
  const action=op.action,keyed=wallet.kind==='key'||wallet.kind==='extension';
  check(['GENESIS','BUY','CLOSE','DRAW','TIMEOUT','PAY_OLD','PAY_SELF','REFUND_OLD','REFUND_SELF'].includes(action),'ACTION');
  const needsFunds=FUNDED.includes(action)||(action==='REFUND_SELF'&&keyed);
  check(!needsFunds||keyed,'WALLET_KEY_REQUIRED');
  const settings=op.settings;
  const registrySpk=action==='GENESIS'?resolveRegistrySpk(op.registry,net):null;
  let manager=null,targets=[],s=null,funds=[];
  if(action!=='GENESIS') {
    const wanted=(action==='PAY_OLD'||action==='REFUND_OLD')?(op.targets??[]):[];
    const liveTask=liveRound(rpc,round,profile,{targets:wanted});
    if(needsFunds) {
      const price=round.settings?.ticketPrice;
      const minimum=action==='BUY'?BigInt(op.quantity)*price+S.FEE_CAP+1n:S.FEE_CAP+1n;
      const [live,selected]=await Promise.all([liveTask,selectFunds(rpc,wallet,minimum,reserved)]);
      manager=live.manager;targets=live.targets;s=live.state;funds=selected;
    } else {
      const live=await liveTask;manager=live.manager;targets=live.targets;s=live.state;
    }
    for(const t of targets)check(t.cid===manager.cid,'TARGET_CID');
  } else if(needsFunds) {
    const regValue=registrySpk?registryFor(net).valueSompi:0n;
    funds=await selectFunds(rpc,wallet,S.DEPOSIT+regValue+S.FEE_CAP+1n,reserved);
  }
  const bare={...op};delete bare.settings;delete bare.targets;delete bare.registry;
  const budgets=actionBudgets(action,{manager,state:s,targets,funds,op});
  let fee=1000000n,draft,mass;
  const make=()=>action==='GENESIS'
    ?buildGenesis(profile,wallet.key,{ticketPrice:settings.ticketPrice,ticketCap:settings.ticketCap,minTickets:settings.minTickets,closeEligibleDaa:settings.closeEligibleDaa},{funds,fee,budgets,registrySpk})
    :buildAction(manager,profile,{...bare,actorKey:wallet.key},{targets,funds,fee,budgets});
  for(let attempt=0;attempt<8;attempt++) {
    draft=make();mass=quoteMass(draft);
    const required=requiredFee(mass,feerate);
    if(fee>=required)break;
    fee=required;check(attempt<7,'FEE_CONVERGENCE');
  }
  check(fee<=(action.startsWith('PAY')?S.PAY_FEE_CAP:S.FEE_CAP),'PROTOCOL_FEE_CAP');
  for(const u of draft.inputUtxos)u.daa=u.utxoDaa??u.daa;
  draft.transaction.storageMass=mass.storageMass;
  // Independent re-reading of the unsigned transaction (witness decoding, CID/script/amount) against the verified contexts.
  if(action==='GENESIS') interpretGenesis(draft.transaction,profile);
  else {
    const t=interpretAccepted({manager:draft.inputUtxos[0],targets:draft.inputUtxos.slice(1,1+targets.length),funds:draft.inputUtxos.slice(1+targets.length),
      transaction:draft.transaction,accessor:op.accessor??null},profile);
    check(effects(t.outputs)===effects(draft.transition.outputs)&&t.terminal===(draft.transition.terminal??null),'DRAFT_REINTERPRETATION');
  }
  return {op,draft,mass,fee,feerate,budgets,targetCount:targets.length,fundCount:funds.length,
    currentDaa:manager?.currentDaa??null,roundCid:action==='GENESIS'?draft.cid:round.cid,
    review:reviewOf(draft,wallet)};
}
/** Human review rows computed from the draft (never from the service). */
export function reviewOf(draft,wallet=null) {
  return {txid:referenceTxId(draft.transaction),fee:draft.fee,
    inputs:draft.inputUtxos.map((u,i)=>({index:i,outpoint:`${u.outpoint.transactionId}:${u.outpoint.index}`,value:u.value,
      kind:draft.authorizedInputIndices.includes(i)?'普通输入（需签名）':u.covenantId?'covenant 输入':'免签输入',covenantId:u.covenantId??null})),
    outputs:draft.transaction.outputs.map((o,i)=>({index:i,value:o.value,role:draft.roles[i],script:o.scriptPublicKey.script,covenant:!!o.covenant})),
    signer:wallet?.address??null};
}

/** Sign (ordinary inputs, SIGHASH_ALL, locally verified), recompute mass/fee, and return a not-yet-persisted intent. */
export async function signAndRecord({rpc,profile,prepared,wallet,net=TN10,onSigned=()=>{}}) {
  const {draft,op}=prepared;
  // Fetch the acceptance search cursor in parallel with wallet signing so remote wRPC latency doesn't stall post-sign submission.
  const cursorPromise=takeCursor(rpc);
  cursorPromise.catch(()=>{});
  await wallet.sign(draft);
  await verifyOrdinarySignatures(draft);
  onSigned();
  const mass=quoteMass(draft);
  check(mass.storageMass===draft.transaction.storageMass&&draft.fee>=requiredFee(mass,prepared.feerate),'SIGNED_MASS_FEE');
  const {transition,...plain}=draft;void transition;
  const intent={v:1,network:net.networkId,profileId:TN10_PROFILE_ID,txid:referenceTxId(draft.transaction),wireDigest:wireDigestOf(draft.transaction),
    cursor:await cursorPromise,status:'PREPARED',action:op.action,quantity:op.quantity??0,targetCount:prepared.targetCount,
    accessor:op.accessor??null,proof:op.proof??null,mass,draft:plain,createdAtMs:Date.now(),
    evidence:{budgetModel:'calibrated-vm-model-v1',note:'client-side calibrated script-unit bound; not consensus validation'}};
  await authenticateIntent(intent,profile,{network:net.networkId});
  return intent;
}

/** Entry point for the UI: resolves targets / DRAW proof, and shrinks a PAY_OLD batch when (and only when) a RESOURCE or fee limit
 * is hit. Invalid state/proof errors stop immediately and are never "fixed" by a smaller batch. */
export async function prepareOperation({rpc,profile,round,choice,wallet,feerate,reserved,net=TN10}) {
  const common={rpc,profile,round,wallet,feerate,reserved,net};
  if(choice.action==='DRAW')return prepareAction({...common,op:await planDraw(rpc,round,profile)});
  if(choice.action==='PAY_OLD'||choice.action==='REFUND_OLD') {
    check(round.manager,'ROUND_HAS_NO_MANAGER');
    const s=verifyManager({...round.manager,currentDaa:round.manager.utxoDaa},profile);
    const all=pickTargets(round,s,profile,choice.action),sizes=choice.action==='PAY_OLD'?[...new Set([all.length,8,4,2,1].filter(k=>k<=all.length))]:[1];
    let last;
    for(const k of sizes) {
      try{return await prepareAction({...common,op:{action:choice.action,targets:all.slice(0,k)}});}
      catch(e){if(!(e instanceof ResourceLimit)&&!['PROTOCOL_FEE_CAP','FEE','PRIZE_MIN'].includes(e.code))throw e;last=e;}
    }
    throw last;
  }
  return prepareAction({...common,op:{...choice}});
}
