/** Local round record: pure state transitions for the TN10 rolling page.
 * A record is DATA, never authority: imported records are unauthenticated until the page verifies the live UTXOs;
 * after acceptance the next state is derived from the node-served accepted transaction, not from the page's draft.
 * Port of the bounded logic in experiments/rolling/tn10-run.mjs (which pulls node:fs/test-signer and must not enter a browser). */
import {p2sh} from '../core/lib/covenant-id.js';
import {blake2b256} from '../core/lib/hashes.js';
import {outpointKey} from '../core/lib/transaction.js';
import * as S from '../core.mjs';
import {identify,redeem,rootId,scriptHash,verifyManager,decodeSpend,drawSample} from '../core.mjs';
import {interpretAccepted} from '../core.mjs';
import {TN10_NETWORK_ID,TN10_PROFILE_ID} from '../contract/protocol.mjs';
import {encodeTagged,decodeTagged} from '../store/codec.mjs';
import {daaDuration} from '../../web/ui/format.mjs';
const {check,hex,unhex}=S;
export const ROUND_VERSION=1;
export const GENESIS_MAGIC='KASWIN_ROLLING_GENESIS_V1';
export const ACTIONS=Object.freeze(['BUY','CLOSE','DRAW','TIMEOUT','PAY_OLD','PAY_SELF','REFUND_OLD','REFUND_SELF']);
const hash32=(v,c)=>{check(typeof v==='string'&&/^[0-9a-f]{64}$/.test(v),c);return v;};
const outpoint=(o,c)=>{check(o&&typeof o.index==='number'&&Number.isSafeInteger(o.index)&&o.index>=0&&o.index<=0xffffffff,c);hash32(o.transactionId,c);return {transactionId:o.transactionId,index:o.index};};
const spkOf=(s,c)=>{check(s&&s.version===0&&typeof s.script==='string'&&/^(?:[0-9a-f]{2}){1,100}$/.test(s.script),c);return {version:0,script:s.script};};
const big=(v,c,max=S.VALUE_LIMIT)=>{check(typeof v==='bigint'&&v>=0n&&v<=max,c);return v;};

export function emptyRound({cid,origin,settings,source='local',network=TN10_NETWORK_ID}) {
  return {v:ROUND_VERSION,network,profileId:TN10_PROFILE_ID,cid:hash32(cid,'ROUND_CID'),origin:outpoint(origin,'ROUND_ORIGIN'),
    settings:{...settings},manager:null,frozen:[],accepting:null,step:0,buys:0,bought:0,fees:0n,terminal:null,receipts:[],pending:[],halted:null,source,intent:null};
}

/** Genesis effects read back from the NODE-SERVED accepted transaction (payload ledger, covenant id, script hash). */
export function interpretGenesis(tx,profile) {
  check(tx.version===1&&tx.inputs.length>=1&&tx.outputs.length>=1&&tx.outputs.length<=3,'GENESIS_SHAPE');
  for(let i=1;i<tx.outputs.length;i++)check(!tx.outputs[i].covenant,'GENESIS_EXTRA_COVENANT');
  const raw=unhex(tx.payload),magic=new TextEncoder().encode(GENESIS_MAGIC);
  check(raw.length>magic.length+32&&hex(raw.slice(0,magic.length))===hex(magic)&&hex(raw.slice(magic.length,magic.length+32))===profile.id,'GENESIS_PAYLOAD');
  const s=S.decode('sales',raw.slice(magic.length+32));
  check(s.indices.length===0&&s.records.length===0,'GENESIS_STATE');
  const origin=outpoint(tx.inputs[0].previousOutpoint,'GENESIS_ORIGIN'),cid=rootId(origin,s,profile),out=tx.outputs[0];
  check(out.value===S.DEPOSIT&&out.covenant?.covenantId===cid&&out.covenant.authorizingInput===0,'GENESIS_COVENANT');
  check(out.scriptPublicKey.version===0&&out.scriptPublicKey.script===p2sh(scriptHash(s,profile)).script,'GENESIS_SPK');
  return {next:s,cid,origin,terminal:null,outputs:[{state:s}]};
}

/** Which of the eight actions are possible NOW for this record (state + DAA only; wallet/funds checked at preparation). */
export function availableActions(round,profile,currentDaa) {
  const no=reason=>({ok:false,reason}),all=reason=>Object.fromEntries(ACTIONS.map(a=>[a,no(reason)]));
  if(round.terminal)return all(`轮次已终结（${round.terminal}）`);
  if(round.halted)return all(`轮次已停止（${round.halted}）：有候选交易既未被接受也不在内存池，需人工核对后重新导入状态`);
  if(round.intent)return all('存在未完成交易意图：请先等待接受 / 恢复，不能新建交易');
  if(!round.manager)return all('尚无 manager UTXO（创建交易未被接受）');
  currentDaa=currentDaa>round.manager.utxoDaa?currentDaa:round.manager.utxoDaa; // a lagging node view never precedes the UTXO itself
  const x={...round.manager,currentDaa},s=verifyManager(x,profile);
  const T=S.totalTickets(s),N=s.indices.length,local=S.recordTotal(s.records),R=Object.fromEntries(ACTIONS.map(a=>[a,no(`当前阶段（${s.module}）不适用`)]));
  const ok=(extra={})=>({ok:true,...extra});
  if(s.module==='sales') {
    R.BUY=N<256&&T<s.ticketCap?ok({maxQuantity:s.ticketCap-T}):no('售卖已满/容量已满');
    const early=T<s.ticketCap&&N<256&&currentDaa<s.closeEligibleDaa;
    R.CLOSE=early?no(`尚未到可关闭 DAA，还差 ${s.closeEligibleDaa-currentDaa}（约 ${daaDuration(s.closeEligibleDaa-currentDaa)}）`):ok();
  } else if(s.module==='sealed') {
    const draw=x.utxoDaa+S.DRAW_DELAY,timeout=x.utxoDaa+S.TIMEOUT_DELAY;
    R.DRAW=currentDaa<draw?no(`DRAW 需再等 ${draw-currentDaa} DAA（约 ${daaDuration(draw-currentDaa)}）`)
      :currentDaa>=timeout-1000n?no('已接近/超过超时窗口，不再抽奖'):ok();
    R.TIMEOUT=currentDaa>=timeout?ok():no(`超时需再等 ${timeout-currentDaa} DAA（约 ${daaDuration(timeout-currentDaa)}）`);
  } else if(s.module==='win') {
    R.PAY_OLD=s.p<N?ok({remaining:N-s.p}):no('没有旧分片待支付');
    R.PAY_SELF=s.p===N&&local>0&&!S.mergeTail(s)?ok():no('不满足自支付边界');
  } else if(s.module==='refund') {
    R.REFUND_OLD=s.r<N?ok({remaining:N-s.r}):no('没有旧分片待退款');
    R.REFUND_SELF=s.r===N&&s.records.length>0&&!S.mergeTail(s)?ok():no('不满足自退款边界');
  }
  return R;
}

export function describeRound(round,profile,currentDaa=null) {
  if(!round.manager){
    if(round.history){
      const h=round.history;
      return {module:null,terminal:round.terminal,tickets:round.bought,shards:h.shards.length,localRecords:h.localRecords.length,winnerKey:h.winnerKey??null};
    }
    return {module:null,terminal:round.terminal};
  }
  const daa=currentDaa!==null&&currentDaa>round.manager.utxoDaa?currentDaa:round.manager.utxoDaa;
  const s=verifyManager({...round.manager,currentDaa:daa},profile);
  return {module:s.module,ticketPrice:s.ticketPrice,ticketCap:s.ticketCap,minTickets:s.minTickets,closeEligibleDaa:s.closeEligibleDaa,
    tickets:S.totalTickets(s),shards:s.indices.length,localRecords:s.records.length,managerValue:round.manager.value,frozen:round.frozen.length,
    owner:s.ownerKey,winnerKey:s.winnerKey??null,payCursor:s.p??null,refundShard:s.r??null,refundCursor:s.c??null,terminal:round.terminal,pending:(round.pending??[]).length,halted:round.halted??null};
}

/** Decode live manager + frozen shard preimages (or verified terminal history) into per-shard summaries and bounded (<=256) purchase records for UI inspection. */
export function shardCatalog(round,profile,walletKey=null) {
  const buildRecs=(recs,baseTicket,refundedCount)=>{
    let prev=0,mine=0;
    const out=recs.map((rec,idx)=>{
      const count=rec.end-prev,startTicket=baseTicket+prev+1,endTicket=baseTicket+rec.end,isMine=!!walletKey&&rec.key===walletKey;
      if(isMine)mine+=count;
      prev=rec.end;
      return {index:idx,startTicket,endTicket,count,key:rec.key,mine:isMine,refunded:idx<refundedCount};
    });
    return {out,mine};
  };
  if(!round?.manager?.redeemScript){
    const h=round?.history;
    if(!h)return null;
    const termStatus=h.terminal==='REFUNDED'?'refunded':'settled';
    const shards=[];let prevEnd=0;
    for(let j=0;j<h.shards.length;j++){
      const sh=h.shards[j],tickets=sh.end-prevEnd,startTicket=tickets>0?prevEnd+1:0,endTicket=tickets>0?sh.end:0;
      const built=sh.records?buildRecs(sh.records,prevEnd,h.terminal==='REFUNDED'?sh.records.length:0):null;
      shards.push({index:j,kind:'frozen',status:termStatus,startTicket,endTicket,tickets,recordCount:built?built.out.length:null,
        records:built?built.out:null,hash:sh.hash,refundedRecords:h.terminal==='REFUNDED'&&built?built.out.length:0,mineCount:built?built.mine:0});
      prevEnd=sh.end;
    }
    if(h.localRecords.length>0){
      const localTickets=S.recordTotal(h.localRecords);
      const built=buildRecs(h.localRecords,prevEnd,h.terminal==='REFUNDED'?h.localRecords.length:0);
      shards.push({index:h.shards.length,kind:'active',status:termStatus,startTicket:prevEnd+1,endTicket:prevEnd+localTickets,tickets:localTickets,
        recordCount:built.out.length,records:built.out,hash:null,refundedRecords:h.terminal==='REFUNDED'?built.out.length:0,mineCount:built.mine});
    }
    return shards;
  }
  const daa=round.manager.currentDaa??round.manager.utxoDaa;
  const s=verifyManager({...round.manager,currentDaa:daa>round.manager.utxoDaa?daa:round.manager.utxoDaa},profile);
  const indices=s.indices??[],N=indices.length,settledStart=s.module==='win'?s.p:s.module==='refund'?s.r:0;
  const byHash=new Map();
  for(const f of round.frozen??[]){
    if(!(f?.redeemScript instanceof Uint8Array))continue;
    const h=hex(blake2b256(f.redeemScript));
    let decoded=null;try{decoded=identify(f.redeemScript,profile);}catch{}
    const bucket=byHash.get(h);if(bucket)bucket.push({f,decoded});else byHash.set(h,[{f,decoded}]);
  }
  const takeFrozen=j=>{
    const bucket=byHash.get(indices[j].hash);
    if(!bucket||!bucket.length)return null;
    const byVal=bucket.findIndex(x=>{
      if(!x.decoded)return false;
      try{return x.f.value===S.frozenValue(s,j,x.decoded.records);}catch{return false;}
    });
    return bucket.splice(byVal>=0?byVal:0,1)[0];
  };
  const shards=[];let prevEnd=0;
  for(let j=0;j<N;j++) {
    const end=indices[j].end,tickets=end-prevEnd,startTicket=tickets>0?prevEnd+1:0,endTicket=tickets>0?end:0;
    let status='frozen',refundedRecords=0,records=null,mineCount=0;
    if(s.module==='win')status=j<s.p?'settled':'frozen';
    else if(s.module==='refund')status=j<s.r?'refunded':j===s.r?'refunding':'frozen';
    if(j>=settledStart) {
      const hit=takeFrozen(j);
      if(hit) {
        const d=hit.decoded??identify(hit.f.redeemScript,profile);
        if(d.module==='frozen') {
          refundedRecords=status==='refunding'?s.c:0;
          const built=buildRecs(d.records,prevEnd,refundedRecords);
          records=built.out;mineCount=built.mine;
        }
      }
    }
    shards.push({index:j,kind:'frozen',status,startTicket,endTicket,tickets,recordCount:records?records.length:null,records,hash:indices[j].hash,refundedRecords,mineCount});
    prevEnd=end;
  }
  const localRecs=s.records??[],localTickets=S.recordTotal(localRecs);
  if(localRecs.length>0) {
    const status=s.module==='refund'?(s.r===N?'refunding':'frozen'):s.module==='sales'?'active':'frozen';
    const refundedRecords=status==='refunding'?s.c:0;
    const built=buildRecs(localRecs,prevEnd,refundedRecords);
    shards.push({index:N,kind:'active',status,startTicket:prevEnd+1,endTicket:prevEnd+localTickets,tickets:localTickets,
      recordCount:built.out.length,records:built.out,hash:null,refundedRecords,mineCount:built.mine});
  }
  return shards;
}

/** Pure advance after a verified acceptance. `accepted` = {txid,tx,acceptingBlock,acceptingDaa,observedVirtualDaa,actualFee,nodeComputeMass,storageMass,candidate?}.
 * V2.0.2 pacing: `candidate:true` (first selected-chain acceptance, not yet >=100 DAA deep) advances the round at once and queues the
 * intent in `pending`; settleCandidate promotes it later. Effects are interpreted from the accepted transaction (node data) against the
 * verified input contexts. Idempotent by txid. */
export function advanceRound(round,intent,accepted,profile) {
  if(round.receipts.some(r=>r.txid===accepted.txid))return round;
  const r=structuredClone(round),txid=accepted.txid;let t,cid,origin;
  if(intent.action==='GENESIS') {
    check(!r.manager&&r.step===0,'GENESIS_ALREADY_APPLIED');
    t=interpretGenesis(accepted.tx,profile);cid=t.cid;origin=t.origin;check(cid===r.cid,'GENESIS_CID');
  } else {
    const ctx=intent.draft.inputUtxos,targets=ctx.slice(1,1+intent.targetCount),funds=ctx.slice(1+intent.targetCount);
    check(r.manager&&outpointKey(ctx[0].outpoint)===outpointKey(r.manager.outpoint),'ADVANCE_MANAGER_MISMATCH');
    t=interpretAccepted({manager:ctx[0],targets,funds,transaction:accepted.tx,accessor:intent.accessor},profile);
    check(t.action===intent.action&&t.cid===r.cid,'ADVANCE_ACTION_MISMATCH');cid=t.cid;origin=t.origin;
    const spent=new Set(accepted.tx.inputs.map(i=>outpointKey(i.previousOutpoint)));
    r.frozen=r.frozen.filter(f=>!spent.has(outpointKey(f.outpoint)));
  }
  const outs=accepted.tx.outputs;
  if(t.next) {
    check(outs[0].covenant?.covenantId===cid,'ADVANCE_COVENANT');
    r.manager={outpoint:{transactionId:txid,index:0},origin,cid,value:outs[0].value,spk:outs[0].scriptPublicKey,redeemScript:redeem(t.next,profile),
      utxoDaa:accepted.acceptingDaa,currentDaa:accepted.observedVirtualDaa,daa:accepted.acceptingDaa,covenantId:cid};
    verifyManager(r.manager,profile);
  } else r.manager=null;
  t.outputs.forEach((o,i)=>{if(o.state?.module==='frozen')r.frozen.push({outpoint:{transactionId:txid,index:i},cid,covenantId:cid,origin,value:outs[i].value,spk:outs[i].scriptPublicKey,
    redeemScript:redeem(o.state,profile),utxoDaa:accepted.acceptingDaa,daa:accepted.acceptingDaa});});
  r.cid=cid;r.origin=origin;r.accepting=accepted.acceptingBlock;r.fees+=accepted.actualFee;
  if(intent.action==='BUY'){r.buys++;r.bought+=intent.quantity;}
  if(intent.action==='DRAW'){
    const w=decodeSpend(accepted.tx.inputs[0].signatureScript,profile),d=w.args.data;
    const sample=drawSample(intent.draft.inputUtxos[0],w.state,{proof:d.slice(0,240),accessor:intent.accessor});
    r.draw={txid,shard:Number(S.fromLe(d.slice(240,242))),record:Number(S.fromLe(d.slice(242,244))),ticket:sample.ticket};
  }
  r.step++;r.intent=null;r.terminal=t.terminal??null;
  const cand=accepted.candidate===true;
  if(cand)(r.pending??=[]).push({txid,acceptingBlock:accepted.acceptingBlock,acceptingDaa:accepted.acceptingDaa.toString(),intent:structuredClone(intent)});
  r.receipts.push({txid,action:intent.action,accepted:!cand,candidate:cand,finalized:!cand,acceptingBlock:accepted.acceptingBlock,acceptingDaa:accepted.acceptingDaa.toString(),
    feeSompi:accepted.actualFee.toString(),computeMass:accepted.nodeComputeMass?.toString()??null,storageMass:accepted.storageMass.toString(),
    transientMass:intent.mass.transientMass.toString()});
  return r;
}

/** Promote a CANDIDATE after recheckCandidate returned FINAL (accepting block >=100 DAA deep, still on the selected chain, draft unchanged). */
export function settleCandidate(round,txid,{depth}) {
  const r=structuredClone(round),rc=r.receipts.find(x=>x.txid===txid);
  check(rc&&rc.finalized===false&&(r.pending??[]).some(p=>p.txid===txid),'NOT_A_CANDIDATE');
  Object.assign(rc,{accepted:true,candidate:false,finalized:true,finalDepth:depth.toString()});r.pending=r.pending.filter(p=>p.txid!==txid);
  return r;
}
/** A shallow reorg displaced the accepting block and the SAME signed bytes were accepted again elsewhere: record the history, move the
 * candidate, and refresh the DAA of the UTXOs that transaction created (the manager / frozen shards the next steps are built on). */
export function moveCandidate(round,txid,{acceptingBlock,acceptingDaa}) {
  const r=structuredClone(round),rc=r.receipts.find(x=>x.txid===txid),p=(r.pending??[]).find(x=>x.txid===txid);
  check(rc&&rc.finalized===false&&p,'NOT_A_CANDIDATE');
  (rc.reaccepted??=[]).push({acceptingBlock:rc.acceptingBlock,acceptingDaa:rc.acceptingDaa});
  if(r.accepting===rc.acceptingBlock)r.accepting=acceptingBlock;
  if(r.manager?.outpoint.transactionId===txid)Object.assign(r.manager,{utxoDaa:acceptingDaa,daa:acceptingDaa});
  for(const f of r.frozen)if(f.outpoint.transactionId===txid)Object.assign(f,{utxoDaa:acceptingDaa,daa:acceptingDaa});
  rc.acceptingBlock=p.acceptingBlock=acceptingBlock;rc.acceptingDaa=p.acceptingDaa=acceptingDaa.toString();delete p.limboSince;
  return r;
}

/** Offline validation of a record (own or imported). Does NOT authenticate against the chain. */
export function validateRound(r,profile,{allowIntent=true,network=TN10_NETWORK_ID}={}) {
  check(r&&typeof r==='object'&&r.v===ROUND_VERSION&&r.network===network&&r.profileId===TN10_PROFILE_ID,'ROUND_SCOPE');
  hash32(r.cid,'ROUND_CID');outpoint(r.origin,'ROUND_ORIGIN');
  const st=r.settings;check(st&&typeof st.ticketCap==='number'&&typeof st.minTickets==='number','ROUND_SETTINGS');
  big(st.ticketPrice,'ROUND_SETTINGS');big(st.closeEligibleDaa,'ROUND_SETTINGS');S.integer(st.ticketCap,3,S.MAX_TICKETS);S.integer(st.minTickets,3,st.ticketCap);
  S.integer(r.step,0,1e9);S.integer(r.buys,0,1e9);S.integer(r.bought,0,1e9);big(r.fees,'ROUND_FEES',1n<<62n);
  check(r.terminal===null||['EMPTY','PAID','REFUNDED'].includes(r.terminal),'ROUND_TERMINAL');
  check(r.accepting===null||/^[0-9a-f]{64}$/.test(r.accepting),'ROUND_ACCEPTING');
  check(['local','imported'].includes(r.source),'ROUND_SOURCE');
  check(Array.isArray(r.receipts)&&r.receipts.length<=100000&&r.receipts.every(x=>x&&typeof x.txid==='string'&&/^[0-9a-f]{64}$/.test(x.txid)&&typeof x.action==='string'
    &&typeof x.feeSompi==='string'&&/^[0-9]{1,19}$/.test(x.feeSompi)&&(x.finalized===undefined||typeof x.finalized==='boolean')),'ROUND_RECEIPTS'); // feeSompi is rendered as a bigint
  check(r.halted==null||(typeof r.halted==='string'&&r.halted.length<=64),'ROUND_HALTED');
  const pend=r.pending??[];check(Array.isArray(pend)&&pend.length<=64,'ROUND_PENDING');
  for(const p of pend){hash32(p.txid,'PENDING_TXID');hash32(p.acceptingBlock,'PENDING_BLOCK');
    check(typeof p.acceptingDaa==='string'&&/^[0-9]{1,18}$/.test(p.acceptingDaa)&&p.intent&&p.intent.txid===p.txid&&r.receipts.some(x=>x.txid===p.txid&&x.finalized===false),'PENDING_RECEIPT');
    check(Array.isArray(p.intent.draft?.transaction?.inputs)&&Array.isArray(p.intent.draft?.inputUtxos),'PENDING_INTENT');} // full authentication happens in importText
  check(Array.isArray(r.frozen)&&r.frozen.length<=256,'ROUND_FROZEN');
  let s=null;
  if(r.manager) {
    const m=r.manager;outpoint(m.outpoint,'MANAGER_OUTPOINT');outpoint(m.origin,'MANAGER_ORIGIN');hash32(m.cid,'MANAGER_CID');spkOf(m.spk,'MANAGER_SPK');
    big(m.value,'MANAGER_VALUE');big(m.utxoDaa,'MANAGER_DAA',S.DAA_LIMIT);big(m.currentDaa,'MANAGER_DAA',S.DAA_LIMIT);check(m.redeemScript instanceof Uint8Array,'MANAGER_REDEEM');
    check(m.cid===r.cid&&outpointKey(m.origin)===outpointKey(r.origin)&&!r.terminal,'MANAGER_BINDING');
    s=verifyManager(m,profile);
  } else check(r.frozen.length===0,'ROUND_FROZEN_WITHOUT_MANAGER');
  const hashes=new Set((s?.indices??[]).map(i=>i.hash)),seen=new Set(r.manager?[outpointKey(r.manager.outpoint)]:[]),remaining=new Map(),frozenByHash=new Map();
  for(const f of r.frozen) {
    outpoint(f.outpoint,'FROZEN_OUTPOINT');big(f.value,'FROZEN_VALUE');big(f.utxoDaa,'FROZEN_DAA',S.DAA_LIMIT);spkOf(f.spk,'FROZEN_SPK');
    const dec=identify(f.redeemScript,profile);
    check(f.cid===r.cid&&f.redeemScript instanceof Uint8Array&&dec.module==='frozen','FROZEN_SCOPE');
    const h=hex(blake2b256(f.redeemScript)),point=outpointKey(f.outpoint);check(hashes.has(h)&&!seen.has(point)&&f.spk.script===p2sh(h).script,'FROZEN_HASH');seen.add(point);
    const key=h+':'+f.value;remaining.set(key,(remaining.get(key)??0)+1);
    if(!frozenByHash.has(h))frozenByHash.set(h,dec.records);
  }
  if(s) {
    const start=s.module==='win'?s.p:s.module==='refund'?s.r:0;check(r.frozen.length===s.indices.length-start,'ROUND_FROZEN_COUNT');
    for(let j=start;j<s.indices.length;j++) {
      const records=frozenByHash.get(s.indices[j].hash);check(records,'ROUND_PREIMAGE');
      const key=s.indices[j].hash+':'+S.frozenValue(s,j,records);check((remaining.get(key)??0)>0,'ROUND_FROZEN_VALUE');remaining.set(key,remaining.get(key)-1);
    }
  }
  check(r.intent===null||allowIntent,'ROUND_INTENT_NOT_ALLOWED');
  if(r.history!=null){
    const h=r.history;
    check(h&&typeof h==='object'&&!Array.isArray(h)&&['PAID','REFUNDED'].includes(h.terminal),'ROUND_HISTORY');
    check(h.winnerKey===null||typeof h.winnerKey==='string'&&/^[0-9a-f]{64}$/.test(h.winnerKey),'ROUND_HISTORY');
    S.validateRecords(h.localRecords,256);
    check(Array.isArray(h.shards)&&h.shards.length<=256,'ROUND_HISTORY');
    let prev=0;
    for(const sh of h.shards){
      check(sh&&typeof sh==='object'&&!Array.isArray(sh),'ROUND_HISTORY');
      hash32(sh.hash,'ROUND_HISTORY');S.integer(sh.end,prev+256,st.ticketCap);
      const span=sh.end-prev;prev=sh.end;
      if(sh.records!==null){S.validateRecords(sh.records,256);check(S.recordTotal(sh.records)===span,'ROUND_HISTORY');}
    }
  }
  if(r.draw!=null){
    const d=r.draw;
    check(d&&typeof d==='object'&&!Array.isArray(d),'ROUND_DRAW');
    hash32(d.txid,'ROUND_DRAW');S.integer(d.shard,0,256);S.integer(d.record,0,255);S.integer(d.ticket,0,S.MAX_TICKETS-1);
  }
  return s;
}
export const roundToText=round=>encodeTagged(round);
/** Import: parse + validate. Result is marked imported/unauthenticated and can never carry a trusted live status. */
export function roundFromText(text,profile,{network=TN10_NETWORK_ID}={}) {
  const r=decodeTagged(text);
  check(r&&typeof r==='object'&&!Array.isArray(r),'ROUND_SHAPE');
  validateRound(r,profile,{network});
  return {...r,source:'imported'};
}
