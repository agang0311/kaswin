/** Three-tier round discovery & forward catch-up (Indexer -> Node -> REST fallback), matching V2.0.2 safety rules.
 * - Explore lists come from Indexer first, falling back to TN10 REST on the dedicated Rolling registry address.
 * - Round detail fetches from Indexer once, checks the connected node (chasing forward via virtual-chain Full
 *   if another participant already advanced it), and falls back to REST when pruned or absent on Indexer/node.
 * - Live active states remain anchored to live node UTXOs (liveRound); REST never overrides an unresolved local intent. */
import {decodeSpend,drawSample,identify,interpretAccepted,redeem,rootId,scriptHash,verifyManager} from '../core.mjs';
import * as S from '../core.mjs';
import {acceptedAt,acceptanceFromPage} from '../chain/chain.mjs';
import {parseSpk,txFromRpc} from '../chain/nodes.mjs';
import {restAddressTransactions,restTransaction} from '../chain/rest.mjs';
import {TN10} from '../chain/tn10.mjs';
import {uint} from '../chain/json.mjs';
import {blake2b256} from '../core/lib/hashes.js';
import {p2sh} from '../core/lib/covenant-id.js';
import {outpointKey,referenceTxId} from '../core/lib/transaction.js';
import {ascii,cat,same} from '../core/lib/bytes.js';
import {spkToAddress} from '../wallet/address.mjs';
import {GENESIS_MAGIC,emptyRound,interpretGenesis,roundFromText} from './round.mjs';
import {liveRound} from './prepare.mjs';
import {verifyIndexedSnapshot} from './indexer-client.mjs';
import {TN10_PROFILE_ID,TN10_ROLLING_REGISTRY} from '../contract/protocol.mjs';

const {check,fromLe,hex,unhex,ZERO}=S;
const HASH=/^[0-9a-f]{64}$/;
const REFUND_BATCH=32;
const GENESIS_PREFIX_HEX=hex(ascii(GENESIS_MAGIC));

const spends=(raw,tip)=>raw?.inputs?.some(i=>i.previous_outpoint_hash===tip.transactionId&&uint(i.previous_outpoint_index)===BigInt(tip.index));
const feeFromContexts=(contexts,outs)=>contexts.reduce((n,u)=>n+u.value,0n)-outs.reduce((n,o)=>n+o.value,0n);

function seedPreimages(round,profile) {
  const map=new Map();
  for(const f of round?.frozen??[])if(f?.redeemScript)map.set(hex(blake2b256(f.redeemScript)),f.redeemScript);
  for(const sh of round?.history?.shards??[])if(sh?.hash&&Array.isArray(sh.records)){
    try{map.set(sh.hash,redeem({module:'frozen',records:sh.records},profile));}catch{}
  }
  return map;
}

function terminalHistory(terminal,state,preimages,profile) {
  if(terminal==='EMPTY'||(!state.indices.length&&!state.records.length))return null;
  return {
    terminal,
    winnerKey:state.winnerKey??null,
    localRecords:state.records.map(r=>({end:r.end,key:r.key})),
    shards:state.indices.map(idx=>{
      const raw=preimages.get(idx.hash);
      if(!raw)return {end:idx.end,hash:idx.hash,records:null};
      try{
        const dec=identify(raw,profile);
        return dec.module==='frozen'?{end:idx.end,hash:idx.hash,records:dec.records.map(r=>({end:r.end,key:r.key}))}:{end:idx.end,hash:idx.hash,records:null};
      }catch{return {end:idx.end,hash:idx.hash,records:null};}
    }),
  };
}

/** Parse and validate a REST transaction as a Rolling GENESIS carrying the dedicated REGISTRATION output. */
export function restRollingGenesisCandidate(raw,profile,{registry=TN10_ROLLING_REGISTRY}={}) {
  check(raw&&typeof raw==='object'&&typeof raw.payload==='string','REST_NOT_GENESIS');
  const expectedPrefix=GENESIS_PREFIX_HEX+profile.id;
  check(raw.payload.startsWith(expectedPrefix),'REST_NOT_GENESIS');
  const s=S.decode('sales',unhex(raw.payload.slice(expectedPrefix.length)));
  check(s.indices.length===0&&s.records.length===0,'GENESIS_STATE');
  const in0=raw.inputs?.find(i=>uint(i.index)===0n);
  check(in0&&HASH.test(in0.previous_outpoint_hash),'REST_GENESIS_ORIGIN');
  const origin={transactionId:in0.previous_outpoint_hash,index:Number(uint(in0.previous_outpoint_index))};
  const cid=rootId(origin,s,profile),expectedSpk=p2sh(scriptHash(s,profile));
  const out0=raw.outputs?.find(o=>uint(o.index)===0n);
  check(out0&&uint(out0.amount)===S.DEPOSIT&&out0.script_public_key===expectedSpk.script&&out0.covenant_id===cid&&uint(out0.covenant_authorizing_input)===0n,'REST_GENESIS_OUTPUT');
  for(const o of raw.outputs)if(uint(o.index)!==0n)check(!o.covenant_id,'GENESIS_EXTRA_COVENANT');
  if(registry?.spk?.script)check(raw.outputs.some(o=>uint(o.index)!==0n&&o.covenant_id==null&&o.script_public_key===registry.spk.script&&uint(o.amount)===registry.valueSompi),'REST_REGISTRATION');
  const txid=String(raw.transaction_id??'').toLowerCase();check(HASH.test(txid),'REST_GENESIS_TXID');
  return {
    cid,origin,settings:{ticketPrice:s.ticketPrice,ticketCap:s.ticketCap,minTickets:s.minTickets,closeEligibleDaa:s.closeEligibleDaa},
    txid,acceptingBlock:raw.accepting_block_hash??null,isAccepted:raw.is_accepted===true,
    updatedAt:Number.isSafeInteger(raw.block_time)?raw.block_time:null,
  };
}

/** Discover Rolling rounds directly from REST when the Indexer is unavailable or unconfigured. */
export async function discoverRestRollingRounds({net=TN10,cursor=0,limit=50,fetcher=globalThis.fetch,profile,registry=TN10_ROLLING_REGISTRY}={}) {
  const offset=Number.isSafeInteger(cursor)&&cursor>=0?cursor:0;
  const page=await restAddressTransactions(registry.address,{offset,limit,net,fetcher});
  const rounds=[];let rejected=0;
  for(const raw of page.items){
    try{
      if(raw.is_accepted!==true)continue;
      const g=restRollingGenesisCandidate(raw,profile,{registry});
      rounds.push({
        cid:g.cid,terminal:null,module:'sales',tickets:0,shards:0,bought:0,buys:0,
        managerValue:String(S.DEPOSIT),acceptingDaa:null,updatedAt:g.updatedAt,source:'rest',genesisTxid:g.txid,
      });
    }catch{rejected++;}
  }
  return {rounds,nextCursor:page.nextOffset??null,source:'rest',rejected};
}

/** Locate a single round's GENESIS transaction by CID via REST pages on the registry address. */
export async function locateRestRollingGenesis(cid,{net=TN10,maxPages=6,fetcher=globalThis.fetch,profile,registry=TN10_ROLLING_REGISTRY}={}) {
  check(HASH.test(cid),'ROUND_CID');
  let offset=0;
  for(let p=0;p<maxPages;p++){
    const page=await restAddressTransactions(registry.address,{offset,limit:50,net,fetcher});
    for(const raw of page.items){
      if(raw.is_accepted!==true)continue;
      try{
        const g=restRollingGenesisCandidate(raw,profile,{registry});
        if(g.cid===cid||g.txid===cid)return {...g,raw};
      }catch{}
    }
    if(page.nextOffset==null)break;
    offset=page.nextOffset;
  }
  return null;
}

/** Build a verified Round record from a GENESIS node acceptance evidence. */
export function roundFromGenesisEvidence(ev,profile,{source='imported'}={}) {
  const g=interpretGenesis(ev.tx,profile);
  const feeSompi=ev.inputs.reduce((n,u)=>n+BigInt(u.value),0n)-ev.tx.outputs.reduce((n,o)=>n+o.value,0n);
  const s=g.next,out=ev.tx.outputs[0];
  const r=emptyRound({cid:g.cid,origin:g.origin,settings:{ticketPrice:s.ticketPrice,ticketCap:s.ticketCap,minTickets:s.minTickets,closeEligibleDaa:s.closeEligibleDaa},source});
  r.manager={outpoint:{transactionId:ev.txid,index:0},origin:g.origin,cid:g.cid,value:out.value,spk:out.scriptPublicKey,
    redeemScript:redeem(s,profile),utxoDaa:ev.acceptingDaa,currentDaa:ev.acceptingDaa,daa:ev.acceptingDaa,covenantId:g.cid};
  r.accepting=ev.accepting;r.step=1;r.fees=feeSompi;
  r.receipts.push({txid:ev.txid,action:'GENESIS',accepted:true,candidate:false,finalized:true,acceptingBlock:ev.accepting,acceptingDaa:String(ev.acceptingDaa),feeSompi:String(feeSompi)});
  return r;
}

/** Advance a verified round one step using node acceptance evidence (acceptedAt / getVirtualChainFromBlockV2 Full). */
export async function applyAcceptedStep(round,ev,rpc,profile,{virtualDaa=null,preimages=seedPreimages(round,profile)}={}) {
  if(round.receipts.some(rc=>rc.txid===ev.txid))return round;
  if(!round.manager&&round.step===0){return roundFromGenesisEvidence(ev,profile,{source:round.source});}
  check(round.manager,'ROUND_HAS_NO_MANAGER');
  check(Array.isArray(ev.inputs)&&ev.inputs.length===ev.tx.inputs.length&&ev.inputs.every(Boolean),'MISSING_ACCEPTED_INPUT_CONTEXT');
  const contexts=ev.inputs.map((u,i)=>({
    outpoint:ev.tx.inputs[i].previousOutpoint,value:u.value,
    spk:typeof u.spk==='string'?parseSpk(u.spk):u.spk,utxoDaa:u.daa,cid:u.covenantId??null,covenantId:u.covenantId??null,
  }));
  check(outpointKey(contexts[0].outpoint)===outpointKey(round.manager.outpoint),'ADVANCE_MANAGER_MISMATCH');
  const w0=decodeSpend(ev.tx.inputs[0].signatureScript,profile);
  const manager={...contexts[0],origin:round.origin,utxoDaa:contexts[0].utxoDaa,currentDaa:ev.acceptingDaa,redeemScript:round.manager.redeemScript};
  const targets=[],funds=[];let funding=false;
  for(let i=1;i<contexts.length;i++){
    const u=contexts[i];
    if(u.cid&&u.cid!==ZERO){
      check(!funding&&u.cid===round.cid,'TARGET_LAYOUT');
      const key=outpointKey(u.outpoint),matched=round.frozen.find(f=>outpointKey(f.outpoint)===key);
      const raw=matched?.redeemScript??decodeSpend(ev.tx.inputs[i].signatureScript,profile).raw;
      targets.push({...u,redeemScript:raw});
    }else{funding=true;funds.push(u);}
  }
  let accessor,drawInfo=null;
  if(w0.state.module==='sealed'&&w0.args.action===4n){
    check(w0.args.data.length>=240,'DRAW_DATA');
    const hash=hex(w0.args.data.slice(0,32));
    const b=(await rpc.call('getBlock',{hash,includeTransactions:false}))?.block;
    check(b?.header?.hash===hash&&b.verboseData?.isChainBlock===true,'DRAW_TARGET_NOT_CHAIN');
    unhex(b.header.acceptedIdMerkleRoot,32);
    accessor={blockHash:hash,sequenceCommitment:b.header.acceptedIdMerkleRoot};
  }
  const t=interpretAccepted({manager,targets,funds,transaction:ev.tx,accessor},profile);
  check(t.cid===round.cid,'ADVANCE_CID_MISMATCH');
  const r=structuredClone(round),spent=new Set(ev.tx.inputs.map(i=>outpointKey(i.previousOutpoint)));
  r.frozen=r.frozen.filter(f=>!spent.has(outpointKey(f.outpoint)));
  const outs=ev.tx.outputs,obsDaa=virtualDaa&&virtualDaa>ev.acceptingDaa?virtualDaa:ev.acceptingDaa;
  if(t.next){
    check(outs[0]?.covenant?.covenantId===r.cid,'ADVANCE_COVENANT');
    r.manager={outpoint:{transactionId:ev.txid,index:0},origin:r.origin,cid:r.cid,value:outs[0].value,spk:outs[0].scriptPublicKey,
      redeemScript:redeem(t.next,profile),utxoDaa:ev.acceptingDaa,currentDaa:obsDaa,daa:ev.acceptingDaa,covenantId:r.cid};
    verifyManager(r.manager,profile);
  }else r.manager=null;
  t.outputs.forEach((o,i)=>{if(o.state?.module==='frozen'){
    const raw=redeem(o.state,profile),h=hex(blake2b256(raw));
    preimages.set(h,raw);
    r.frozen.push({outpoint:{transactionId:ev.txid,index:i},cid:r.cid,covenantId:r.cid,origin:r.origin,value:outs[i].value,
      spk:outs[i].scriptPublicKey,redeemScript:raw,utxoDaa:ev.acceptingDaa,daa:ev.acceptingDaa});
  }});
  if(t.action==='DRAW'){
    const d=w0.args.data;
    const sample=drawSample(manager,w0.state,{proof:d.slice(0,240),accessor});
    drawInfo={txid:ev.txid,shard:Number(fromLe(d.slice(240,242))),record:Number(fromLe(d.slice(242,244))),ticket:sample.ticket};
    r.draw=drawInfo;
  }
  if(t.action==='BUY'){
    const q=Number(fromLe(w0.args.data.slice(0,4)));
    r.buys++;r.bought+=q;
  }
  r.accepting=ev.accepting;r.fees+=t.fee;r.step++;r.terminal=t.terminal??null;
  r.receipts.push({txid:ev.txid,action:t.action,accepted:true,candidate:false,finalized:true,
    acceptingBlock:ev.accepting,acceptingDaa:String(ev.acceptingDaa),feeSompi:String(t.fee),
    computeMass:ev.computeMass!=null?String(ev.computeMass):null,storageMass:String(ev.tx.storageMass??0n)});
  if(r.terminal==='PAID'||r.terminal==='REFUNDED'){
    const st=t.next??w0.state;
    r.history=terminalHistory(r.terminal,st,preimages,profile);
  }
  return r;
}

/** Advance a round one step from a REST transaction hint when the node pruned that historical block.
 * Non-terminal results remain untrusted until the caller reaches and verifies a live UTXO on the node. */
export async function applyRestHintStep(round,raw,profile,{rpc=null,preimages=seedPreimages(round,profile)}={}) {
  const txid=String(raw?.transaction_id??'').toLowerCase();
  check(HASH.test(txid)&&raw.is_accepted===true&&HASH.test(raw.accepting_block_hash??''),'REST_TX_INVALID');
  if(round.receipts.some(rc=>rc.txid===txid))return round;
  check(round.manager,'ROUND_HAS_NO_MANAGER');
  const in0=raw.inputs?.find(i=>uint(i.index)===0n);
  check(in0&&in0.previous_outpoint_hash===round.manager.outpoint.transactionId&&uint(in0.previous_outpoint_index)===BigInt(round.manager.outpoint.index),'REST_SPENDER_INPUT');
  const w0=decodeSpend(in0.signature_script,profile);
  check(same(w0.raw,round.manager.redeemScript),'REST_SPENT_MANAGER');
  const s=w0.state,actionNum=w0.args.action;
  const outs=(raw.outputs??[]).slice().sort((a,b)=>Number(uint(a.index)-uint(b.index)));
  check(outs.length>=1,'REST_OUTPUTS_EMPTY');
  const outSpk=o=>({version:0,script:String(o.script_public_key).toLowerCase()});
  const r=structuredClone(round);
  const spentKeys=new Set((raw.inputs??[]).map(i=>`${i.previous_outpoint_hash}:${Number(uint(i.previous_outpoint_index))}`));
  r.frozen=r.frozen.filter(f=>!spentKeys.has(outpointKey(f.outpoint)));

  let actionName='',next=null,terminal=null,lastState=s;
  const checkNextOut=(st,outIndex=0)=>{
    const expSpk=p2sh(scriptHash(st,profile)).script,expVal=S.managerValue(st),o=outs[outIndex];
    check(o&&uint(o.amount)===expVal&&o.script_public_key===expSpk&&o.covenant_id===r.cid&&uint(o.covenant_authorizing_input)===0n,'REST_NEXT_MANAGER');
    return {outpoint:{transactionId:txid,index:outIndex},origin:r.origin,cid:r.cid,value:expVal,spk:outSpk(o),
      redeemScript:redeem(st,profile),utxoDaa:round.manager.utxoDaa,currentDaa:round.manager.utxoDaa,daa:round.manager.utxoDaa,covenantId:r.cid};
  };

  if(actionNum===1n){
    actionName='BUY';
    check(s.module==='sales'&&w0.args.data.length===36,'REST_BUY_DATA');
    const q=Number(fromLe(w0.args.data.slice(0,4))),buyer=hex(w0.args.data.slice(4));
    const local=S.recordTotal(s.records),T=S.totalTickets(s);check(q>=1&&T+q<=s.ticketCap,'REST_BUY_RANGE');
    const records=[...s.records,{end:local+q,key:buyer}];
    if(records.length===256){
      const f={module:'frozen',records},h=scriptHash(f,profile),fRaw=redeem(f,profile),fSpk=p2sh(h);
      const o1=outs[1];check(o1&&uint(o1.amount)===BigInt(local+q)*s.ticketPrice&&o1.script_public_key===fSpk.script&&o1.covenant_id===r.cid,'REST_FROZEN_OUT');
      preimages.set(h,fRaw);
      next=S.phase(s,'sales',{indices:[...s.indices,{hash:h,end:T+q}],records:[]});
      r.manager=checkNextOut(next,0);
      r.frozen.push({outpoint:{transactionId:txid,index:1},cid:r.cid,covenantId:r.cid,origin:r.origin,value:uint(o1.amount),
        spk:fSpk,redeemScript:fRaw,utxoDaa:round.manager.utxoDaa,daa:round.manager.utxoDaa});
    }else{
      next=S.phase(s,'sales',{records});
      r.manager=checkNextOut(next,0);
    }
    r.buys++;r.bought+=q;lastState=next;
  }else if(actionNum===2n){
    actionName='CLOSE';check(s.module==='sales','REST_CLOSE_STATE');
    const T=S.totalTickets(s);
    if(T===0){terminal='EMPTY';r.manager=null;}
    else{const m=T>=s.minTickets?'sealed':'refund';next=S.phase(s,m,m==='refund'?{r:0,c:0}:{});r.manager=checkNextOut(next,0);lastState=next;}
  }else if(actionNum===4n){
    actionName='DRAW';check(s.module==='sealed'&&w0.args.data.length>=248,'REST_DRAW_DATA');
    const d=w0.args.data,j=Number(fromLe(d.slice(240,242))),i=Number(fromLe(d.slice(242,244))),n=Number(fromLe(d.slice(244,248)));
    check(d.length===248+n,'REST_DRAW_LEN');
    let records=s.records;
    if(j<s.indices.length){
      const winRaw=d.slice(248);check(hex(blake2b256(winRaw))===s.indices[j].hash,'REST_DRAW_HASH');
      const dec=identify(winRaw,profile);check(dec.module==='frozen','REST_DRAW_ROLE');
      preimages.set(s.indices[j].hash,winRaw);records=dec.records;
    }
    const winnerKey=records[i]?.key;check(winnerKey,'REST_DRAW_RECORD');
    next=S.phase(s,'win',{winnerKey,p:0});r.manager=checkNextOut(next,0);lastState=next;
    const start=j===0?0:s.indices[j-1].end,prev=i?records[i-1].end:0;
    if(rpc){
      try{
        const hash=hex(d.slice(0,32)),b=(await rpc.call('getBlock',{hash,includeTransactions:false}))?.block;
        if(b?.header?.hash===hash&&b.verboseData?.isChainBlock===true&&b.header?.acceptedIdMerkleRoot){
          const sample=drawSample(round.manager,s,{proof:d.slice(0,240),accessor:{blockHash:hash,sequenceCommitment:b.header.acceptedIdMerkleRoot}});
          r.draw={txid,shard:j,record:i,ticket:sample.ticket};
        }
      }catch{}
    }
    if(!r.draw)r.draw={txid,shard:j,record:i,ticket:start+prev};
  }else if(actionNum===9n){
    actionName='TIMEOUT';check(s.module==='sealed','REST_TIMEOUT_STATE');
    next=S.phase(s,'refund',{r:0,c:0});r.manager=checkNextOut(next,0);lastState=next;
  }else if(actionNum===20n){
    actionName='PAY_OLD';check(s.module==='win','REST_PAY_STATE');
    const frozenKeys=new Set(round.frozen.map(f=>outpointKey(f.outpoint)));
    const targetIns=(raw.inputs??[]).filter(i=>{
      if(uint(i.index)===0n)return false;
      if(frozenKeys.has(`${i.previous_outpoint_hash}:${Number(uint(i.previous_outpoint_index))}`))return true;
      try{return decodeSpend(i.signature_script,profile).state.module==='frozen';}catch{return false;}
    }).sort((a,b)=>Number(uint(a.index)-uint(b.index)));
    const k=targetIns.length;check(k>=1&&k<=16&&s.p+k<=s.indices.length,'REST_PAY_OLD_K');
    targetIns.forEach((ti,idx)=>{try{const fDec=decodeSpend(ti.signature_script,profile);if(fDec.state.module==='frozen')preimages.set(s.indices[s.p+idx].hash,fDec.raw);}catch{}});
    const last=S.mergeTail(s)&&s.p+k===s.indices.length;
    if(last){terminal='PAID';r.manager=null;}else{next={...s,p:s.p+k};r.manager=checkNextOut(next,0);lastState=next;}
  }else if(actionNum===21n){
    actionName='PAY_SELF';check(s.module==='win','REST_PAY_SELF_STATE');
    terminal='PAID';r.manager=null;
  }else if(actionNum===30n){
    actionName='REFUND_OLD';check(s.module==='refund','REST_REFUND_STATE');
    const in1=raw.inputs?.find(i=>uint(i.index)===1n);check(in1,'REST_REFUND_TARGET');
    const fRaw=decodeSpend(in1.signature_script,profile).raw,fDec=identify(fRaw,profile);check(fDec.module==='frozen','REST_FROZEN_ROLE');
    preimages.set(s.indices[s.r].hash,fRaw);
    const nextC=s.c+REFUND_BATCH,doneShard=nextC>=fDec.records.length,finalAll=doneShard&&s.r+1===s.indices.length&&S.mergeTail(s);
    if(finalAll){terminal='REFUNDED';r.manager=null;}
    else{
      next=doneShard?{...s,r:s.r+1,c:0}:{...s,c:nextC};
      r.manager=checkNextOut(next,0);lastState=next;
      if(!doneShard){
        const fOut=outs[1];check(fOut&&fOut.covenant_id===r.cid,'REST_REFUND_FROZEN_REMAINDER');
        r.frozen.push({outpoint:{transactionId:txid,index:1},cid:r.cid,covenantId:r.cid,origin:r.origin,value:uint(fOut.amount),
          spk:outSpk(fOut),redeemScript:fRaw,utxoDaa:round.manager.utxoDaa,daa:round.manager.utxoDaa});
      }
    }
  }else if(actionNum===31n){
    actionName='REFUND_SELF';check(s.module==='refund','REST_REFUND_SELF_STATE');
    const nextC=s.c+REFUND_BATCH;
    if(nextC>=s.records.length){terminal='REFUNDED';r.manager=null;}
    else{next={...s,c:nextC};r.manager=checkNextOut(next,0);lastState=next;}
  }else check(false,'REST_UNSUPPORTED_ACTION');

  r.accepting=raw.accepting_block_hash;r.step++;r.terminal=terminal;
  r.receipts.push({txid,action:actionName,accepted:true,candidate:false,finalized:true,
    acceptingBlock:raw.accepting_block_hash,acceptingDaa:String(round.manager.utxoDaa??0n),feeSompi:'0'});
  if(r.terminal==='PAID'||r.terminal==='REFUNDED')r.history=terminalHistory(r.terminal,lastState,preimages,profile);
  return r;
}

/** Walk forward on the connected node from `round.accepting` using getVirtualChainFromBlockV2(Full) to find the spender of `round.manager.outpoint`. */
export async function findSpenderOnNode(rpc,round,{maxPages=6}={}) {
  if(!round?.manager||!HASH.test(round.accepting??''))return {kind:'NOT_AVAILABLE',reason:'NO_ACCEPTING'};
  const tip=round.manager.outpoint;
  let b;
  try{b=(await rpc.call('getBlock',{hash:round.accepting,includeTransactions:false}))?.block;}
  catch{return {kind:'NOT_AVAILABLE',reason:'PRUNED_OR_MISSING'};}
  if(!b||b.header?.hash!==round.accepting||b.verboseData?.isChainBlock!==true)return {kind:'NOT_AVAILABLE',reason:'NOT_CHAIN'};
  let from=b.verboseData?.selectedParentHash;
  if(!HASH.test(from??''))return {kind:'NOT_AVAILABLE',reason:'NO_PARENT'};
  let blue=uint(b.header.blueScore);
  try{
    const p=(await rpc.call('getBlock',{hash:from,includeTransactions:false}))?.block;
    if(p?.verboseData?.isChainBlock===true)blue=uint(p.header.blueScore);
    else return {kind:'NOT_AVAILABLE',reason:'PARENT_NOT_CHAIN'};
  }catch{return {kind:'NOT_AVAILABLE',reason:'PARENT_PRUNED'};}

  let win=200n;
  for(let page=0;page<maxPages;page++){
    const sink=uint((await rpc.call('getSinkBlueScore')).blueScore);
    if(sink<blue)return {kind:'NOT_AVAILABLE',reason:'SINK_BEHIND'};
    const target=blue+win,min=sink>target?sink-target:0n;
    if(min>BigInt(Number.MAX_SAFE_INTEGER))return {kind:'NOT_AVAILABLE',reason:'RANGE'};
    const full=await rpc.call('getVirtualChainFromBlockV2',{startHash:from,dataVerbosityLevel:'Full',minConfirmationCount:Number(min)});
    if(full?.removedChainBlockHashes?.length)return {kind:'NOT_AVAILABLE',reason:'REORG'};
    const added=full?.addedChainBlockHashes??[],rows=full?.chainBlockAcceptedTransactions??[];
    for(let i=0;i<rows.length;i++){
      const row=rows[i],blockHash=added[i];
      if(!HASH.test(blockHash)||row?.chainBlockHeader?.hash!==blockHash)continue;
      blue=uint(row.chainBlockHeader.blueScore);
      const hit=row.acceptedTransactions?.find(t=>t.inputs?.some(inp=>inp.previousOutpoint?.transactionId===tip.transactionId&&Number(inp.previousOutpoint.index)===tip.index));
      if(hit){
        const ev=acceptanceFromPage(full,hit.verboseData.transactionId,blockHash,sink);
        const virtualDaa=await rpc.currentDaa();
        return {kind:'FOUND',evidence:ev,virtualDaa};
      }
    }
    if(added.length)from=added.at(-1),win=200n;
    else if(min===0n)return {kind:'AT_TIP'};
    else win*=2n;
  }
  return {kind:'NOT_AVAILABLE',reason:'WINDOW_EXHAUSTED'};
}

/** Find the spender of `round.manager` via REST /addresses/{spk}/full-transactions, preferring node hydration if the block is unpruned. */
export async function findSpenderViaRest(rpc,round,{net=TN10,maxPages=3,fetcher=globalThis.fetch}={}) {
  if(!round?.manager)return {kind:'NOT_AVAILABLE'};
  const addr=spkToAddress(round.manager.spk,net.addressPrefix),tip=round.manager.outpoint;
  let offset=0;
  for(let p=0;p<maxPages;p++){
    const page=await restAddressTransactions(addr,{offset,limit:50,net,fetcher});
    const raw=page.items.find(t=>spends(t,tip)&&t.is_accepted===true&&HASH.test(t.accepting_block_hash??''));
    if(raw){
      const txid=String(raw.transaction_id).toLowerCase(),accepting=String(raw.accepting_block_hash).toLowerCase();
      if(rpc){
        try{
          const ev=await acceptedAt(rpc,txid,accepting),virtualDaa=await rpc.currentDaa();
          return {kind:'FOUND_NODE',evidence:ev,virtualDaa};
        }catch{}
      }
      return {kind:'FOUND_REST',raw,txid,acceptingBlock:accepting};
    }
    if(page.nextOffset==null)break;
    offset=page.nextOffset;
  }
  return {kind:'NOT_FOUND'};
}

/** Authenticate an Indexer export document against the node WITHOUT failing when its head UTXO was already spent on-chain. */
async function authenticateIndexerSeed(document,rpc,profile) {
  const r=roundFromText(document.roundText,profile),head=document.head;
  check(r.cid===document.cid&&head&&HASH.test(head.txid)&&HASH.test(head.acceptingBlock),'INDEXER_RESPONSE_INVALID');
  check(!r.intent&&!r.pending?.length&&!r.halted,'INDEXER_PENDING_STATE');
  try{
    return {round:await verifyIndexedSnapshot(document,rpc,profile),nodeVerified:true};
  }catch(e){
    const code=e?.code??e?.safeCode??e?.message;
    // If head was already spent (STALE_INPUT) or <100 DAA deep, check head acceptance on node without failing the whole catch-up.
    if(code==='INDEXER_HEAD_NOT_FINAL'||code==='STALE_INPUT'||code==='ROUND_HAS_NO_MANAGER'){
      const ev=await acceptedAt(rpc,head.txid,head.acceptingBlock);
      const tx=ev.tx,contexts=ev.inputs.map((u,i)=>({outpoint:tx.inputs[i].previousOutpoint,value:u.value,
        spk:typeof u.spk==='string'?parseSpk(u.spk):u.spk,utxoDaa:u.daa,cid:u.covenantId??null,covenantId:u.covenantId??null}));
      if(!contexts[0].cid||contexts[0].cid===ZERO)interpretGenesis(tx,profile);
      else{
        const w=decodeSpend(tx.inputs[0].signatureScript,profile),manager={...contexts[0],origin:r.origin,currentDaa:ev.acceptingDaa,redeemScript:w.raw};
        const targets=[],funds=[];let funding=false;
        for(let i=1;i<contexts.length;i++){
          const c=contexts[i];
          if(c.cid&&c.cid!==ZERO){check(!funding&&c.cid===r.cid,'TARGET_LAYOUT');targets.push({...c,redeemScript:decodeSpend(tx.inputs[i].signatureScript,profile).raw});}
          else{funding=true;funds.push(c);}
        }
        let accessor;
        if(w.state.module==='sealed'&&w.args.action===4n){
          const hash=hex(w.args.data.slice(0,32)),b=(await rpc.call('getBlock',{hash,includeTransactions:false}))?.block;
          check(b?.header?.hash===hash&&b.verboseData?.isChainBlock===true,'DRAW_TARGET_NOT_CHAIN');
          accessor={blockHash:hash,sequenceCommitment:b.header.acceptedIdMerkleRoot};
        }
        interpretAccepted({manager,targets,funds,transaction:tx,accessor},profile);
      }
      return {round:r,nodeVerified:false};
    }
    throw e;
  }
}

/** Three-tier round synchronization:
 * 1) Indexer export (if configured & available);
 * 2) Node UTXO verify & forward virtual-chain catch-up if someone else advanced the round;
 * 3) REST API fallback when neither Indexer nor node history covers a step or genesis. */
export async function syncRoundThreeTier({cid,round=null,lookupInput=null,rpc,indexer=null,profile,net=TN10,fetcher=globalThis.fetch,maxSteps=200}={}) {
  check(rpc,'NODE_REQUIRED');
  let cur=round?structuredClone(round):null,source=cur?'local':null,usedRest=false;
  // Tier 1: Indexer
  if(indexer){
    try{
      let doc;
      try{doc=await indexer.exportRound(lookupInput??cid);}
      catch(e){if(!lookupInput||(e?.message!=='INDEXER_NOT_FOUND'))throw e;doc=await indexer.exportRound(await indexer.resolveTxid(lookupInput));}
      const seeded=await authenticateIndexerSeed(doc,rpc,profile);
      seeded.round.indexer={...seeded.round.indexer,base:indexer.base,revision:String(doc.revision),headTxid:doc.head.txid,acceptingBlock:doc.head.acceptingBlock,checkedAt:Date.now()};
      if(!cur||seeded.round.step>cur.step||seeded.round.terminal&&!cur.terminal){
        cur=seeded.round;source='indexer';
        if(seeded.nodeVerified&&!cur.terminal)return {round:cur,source:'indexer',caughtUp:false,steps:0};
      }
    }catch{}
  }

  // Tier 3a: Neither local nor Indexer had the round -> locate GENESIS via REST
  const queryId=HASH.test(cid??'')?cid:(HASH.test(lookupInput??'')?lookupInput:null);
  if(!cur&&queryId){
    let g=null;
    try{g=await locateRestRollingGenesis(queryId,{net,fetcher,profile});}catch{}
    if(!g&&HASH.test(lookupInput??'')){
      try{
        const tx=await restTransaction(lookupInput,{net,fetcher});
        if(tx?.is_accepted===true){g={...restRollingGenesisCandidate(tx,profile),raw:tx};}
      }catch{}
    }
    if(g){
      usedRest=true;source='rest';
      let loaded=null;
      if(HASH.test(g.acceptingBlock??'')){
        try{
          const ev=await acceptedAt(rpc,g.txid,g.acceptingBlock);
          loaded=roundFromGenesisEvidence(ev,profile,{source:'imported'});
          source='node';
        }catch{}
      }
      if(!loaded&&g.raw){
        const expectedPrefix=GENESIS_PREFIX_HEX+profile.id,s=S.decode('sales',unhex(g.raw.payload.slice(expectedPrefix.length)));
        const r=emptyRound({cid:g.cid,origin:g.origin,settings:g.settings,source:'imported'});
        r.manager={outpoint:{transactionId:g.txid,index:0},origin:g.origin,cid:g.cid,value:S.DEPOSIT,spk:p2sh(scriptHash(s,profile)),
          redeemScript:redeem(s,profile),utxoDaa:0n,currentDaa:0n,daa:0n,covenantId:g.cid};
        r.accepting=g.acceptingBlock;r.step=1;
        r.receipts.push({txid:g.txid,action:'GENESIS',accepted:true,candidate:false,finalized:true,acceptingBlock:g.acceptingBlock,acceptingDaa:'0',feeSompi:'0'});
        loaded=r;
      }
      cur=loaded;
    }
  }
  check(cur,'ROUND_NOT_FOUND');
  if(cur.terminal)return {round:cur,source:source??'local',caughtUp:source==='indexer'||usedRest,steps:0};

  // Tier 2 + Tier 3b: Verify live on node, else chase forward on node, else chase via REST
  const preimages=seedPreimages(cur,profile);
  let steps=0;
  for(let iter=0;iter<maxSteps;iter++){
    try{
      const live=await liveRound(rpc,cur,profile,{targets:cur.frozen});
      cur={...cur,manager:live.manager,frozen:live.targets};
      return {round:cur,source:steps>0?(usedRest?'rest+node':'node'):(source??'node'),caughtUp:steps>0||source==='indexer',steps};
    }catch(e){
      if((e?.code??e?.safeCode)!=='STALE_INPUT')throw e;
    }
    const foundNode=await findSpenderOnNode(rpc,cur);
    if(foundNode.kind==='FOUND'){
      cur=await applyAcceptedStep(cur,foundNode.evidence,rpc,profile,{virtualDaa:foundNode.virtualDaa,preimages});
      steps++;
      if(cur.terminal)return {round:cur,source:'node',caughtUp:true,steps};
      continue;
    }
    const foundRest=await findSpenderViaRest(rpc,cur,{net,fetcher});
    if(foundRest.kind==='FOUND_NODE'){
      cur=await applyAcceptedStep(cur,foundRest.evidence,rpc,profile,{virtualDaa:foundRest.virtualDaa,preimages});
      steps++;usedRest=true;
      if(cur.terminal)return {round:cur,source:'rest+node',caughtUp:true,steps};
      continue;
    }
    if(foundRest.kind==='FOUND_REST'){
      cur=await applyRestHintStep(cur,foundRest.raw,profile,{rpc,preimages});
      steps++;usedRest=true;
      if(cur.terminal)return {round:cur,source:'rest',caughtUp:true,steps};
      continue;
    }
    throw Object.assign(new Error('STALE_INPUT'),{code:'STALE_INPUT',safeCode:'STALE_INPUT'});
  }
  throw Object.assign(new Error('CATCHUP_LIMIT'),{code:'STALE_INPUT',safeCode:'STALE_INPUT'});
}
