/** Read-only Rolling index discovery. REST supplies candidates; this module authenticates the head against the user's node. */
import {check,hex,unhex,ZERO,totalTickets,fromLe} from '../core.mjs';
import {decodeSpend,drawSample,identify,interpretAccepted} from '../core.mjs';
import {redeem} from '../core.mjs';
import {blake2b256} from '../core/lib/hashes.js';
import {same} from '../core/lib/bytes.js';
import {acceptedAt} from '../chain/chain.mjs';
import {parseSpk} from '../chain/nodes.mjs';
import {parseJson} from '../chain/json.mjs';
import {roundFromText,interpretGenesis} from './round.mjs';
import {liveRound} from './prepare.mjs';
import {TN10_NETWORK_ID,TN10_GENESIS,TN10_PROFILE_ID} from '../contract/protocol.mjs';
const HASH=/^[0-9a-f]{64}$/;
export function indexerBase(text) {
  let u;try{u=new URL(String(text).trim());}catch{throw new Error('INDEXER_URL');}
  check(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash,'INDEXER_URL');
  return u.href.replace(/\/+$/,'');
}
function scope(value) {
  check(value&&value.schema===1&&value.network===TN10_NETWORK_ID&&value.genesisHash===TN10_GENESIS&&value.profileId===TN10_PROFILE_ID,'INDEXER_SCOPE');
  check(value.stale!==true,'INDEXER_STALE');return value;
}
export function createIndexerClient({baseUrl,fetchImpl=globalThis.fetch,timeoutMs=12000}) {
  const base=indexerBase(baseUrl);
  async function get(path) {
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs);
    try {
      const response=await fetchImpl(base+path,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',signal:abort.signal});
      if(response.status===404)throw new Error('INDEXER_NOT_FOUND');
      check(response.ok,'INDEXER_UNAVAILABLE');
      const length=response.headers?.get('content-length');check(!length||(/^[0-9]+$/.test(length)&&BigInt(length)<=16_000_000n),'INDEXER_RESPONSE_SIZE');
      const reader=response.body?.getReader();let text;
      if(reader){let size=0;const chunks=[],decoder=new TextDecoder();
        try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;check(size<=16_000_000,'INDEXER_RESPONSE_SIZE');chunks.push(decoder.decode(value,{stream:true}));}text=chunks.join('')+decoder.decode();}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      }else{text=await response.text();check(new TextEncoder().encode(text).length<=16_000_000,'INDEXER_RESPONSE_SIZE');}
      let value;try{value=parseJson(text);}catch{throw new Error('INDEXER_RESPONSE_INVALID');}
      return scope(value);
    }catch(e){if(abort.signal.aborted)throw new Error('INDEXER_TIMEOUT');if(e?.message?.startsWith('INDEXER_'))throw e;throw new Error('INDEXER_UNAVAILABLE');}
    finally{clearTimeout(timer);}
  }
  return Object.freeze({base,
    async info(){const value=await get('/info');check(value.readOnly===true,'INDEXER_SCOPE');return value;},
    async rounds({cursor=null,limit=30}={}){
      check(Number.isInteger(limit)&&limit>=1&&limit<=100,'INDEXER_PAGE_LIMIT');
      const query=new URLSearchParams({limit:String(limit)});if(cursor!==null){check(typeof cursor==='string'&&cursor.length<=2048,'INDEXER_CURSOR');query.set('cursor',cursor);}
      const value=await get('/rounds?'+query);check(Array.isArray(value.rounds)&&value.rounds.length<=limit,'INDEXER_RESPONSE_INVALID');
      value.rounds.forEach(r=>check(r&&HASH.test(r.cid),'INDEXER_RESPONSE_INVALID'));
      check(value.nextCursor==null||(typeof value.nextCursor==='string'&&value.nextCursor.length<=2048),'INDEXER_RESPONSE_INVALID');
      return {...value,nextCursor:value.nextCursor??null};
    },
    async exportRound(cid){check(HASH.test(cid),'INDEXER_CID');const value=await get(`/rounds/${cid}/export`);check(value.cid===cid&&typeof value.roundText==='string'&&HASH.test(value.head?.txid)&&HASH.test(value.head?.acceptingBlock),'INDEXER_RESPONSE_INVALID');return value;},
    async resolveTxid(txid){check(HASH.test(txid),'INDEXER_TXID');const value=await get(`/txid/${txid}`);check(HASH.test(value.cid),'INDEXER_RESPONSE_INVALID');return value.cid;},
  });
}

/** Extract node-authenticated DRAW winning shard/record/ticket directly from the DRAW tx witness & target block commitment. */
export async function verifyDrawReceipt(round,rpc,profile) {
  const drawRc=round?.receipts?.find(x=>x?.action==='DRAW'&&typeof x.acceptingBlock==='string'&&HASH.test(x.acceptingBlock)&&typeof x.txid==='string'&&HASH.test(x.txid));
  if(!drawRc)return null;
  const ev=await acceptedAt(rpc,drawRc.txid,drawRc.acceptingBlock);
  const tx=ev.tx,w=decodeSpend(tx.inputs[0].signatureScript,profile);
  check(w.args?.action===4n,'INDEXER_DRAW_ACTION');
  const d=w.args.data,proof=d.slice(0,240),shard=Number(fromLe(d.slice(240,242))),record=Number(fromLe(d.slice(242,244))),targetHash=hex(proof.slice(0,32));
  const tb=(await rpc.call('getBlock',{hash:targetHash,includeTransactions:false}))?.block;
  check(tb?.header?.hash===targetHash&&tb.verboseData?.isChainBlock===true,'DRAW_TARGET_NOT_CHAIN');
  const sample=drawSample({cid:round.cid,outpoint:tx.inputs[0].previousOutpoint,utxoDaa:ev.inputs[0].daa,currentDaa:ev.acceptingDaa},w.state,
    {proof,accessor:{blockHash:targetHash,sequenceCommitment:tb.header.acceptedIdMerkleRoot}});
  return {txid:drawRc.txid,shard,record,ticket:sample.ticket};
}

/** Reconstruct contexts from NODE-served spent inputs and witnesses, never REST input amounts/scripts. */
export async function verifyIndexedSnapshot(document,rpc,profile) {
  scope(document);const round=roundFromText(document.roundText,profile),head=document.head;
  check(round.cid===document.cid&&head&&HASH.test(head.txid)&&HASH.test(head.acceptingBlock)&&/^(0|[1-9][0-9]{0,24})$/.test(String(document.revision)),'INDEXER_RESPONSE_INVALID');
  check(!round.intent&&!round.pending.length&&!round.halted,'INDEXER_PENDING_STATE');
  const evidence=await acceptedAt(rpc,head.txid,head.acceptingBlock),daa=await rpc.currentDaa();
  check(daa>=evidence.acceptingDaa+100n,'INDEXER_HEAD_NOT_FINAL');
  const tx=evidence.tx;check(evidence.inputs.length===tx.inputs.length&&evidence.inputs.every(Boolean),'MISSING_ACCEPTED_INPUT_CONTEXT');
  const contexts=evidence.inputs.map((u,i)=>({outpoint:tx.inputs[i].previousOutpoint,value:u.value,spk:typeof u.spk==='string'?parseSpk(u.spk):u.spk,
    utxoDaa:u.daa,cid:u.covenantId??null,covenantId:u.covenantId??null}));
  let result,state;
  if(!contexts[0].cid||contexts[0].cid===ZERO){result=interpretGenesis(tx,profile);state=result.next;}
  else {
    const witness=decodeSpend(tx.inputs[0].signatureScript,profile);state=witness.state;
    const origin=state.module==='sales'?{transactionId:hex(witness.args.originTxId),index:Number(witness.args.originIndex)}:round.origin;
    const manager={...contexts[0],origin,currentDaa:evidence.acceptingDaa,redeemScript:witness.raw},targets=[],funds=[];let funding=false;
    for(let i=1;i<contexts.length;i++){
      const context=contexts[i];if(context.cid&&context.cid!==ZERO){check(!funding&&context.cid===manager.cid,'TARGET_LAYOUT');const w=decodeSpend(tx.inputs[i].signatureScript,profile);check(w.state.module==='frozen','TARGET_ROLE');targets.push({...context,redeemScript:w.raw});}
      else{funding=true;funds.push(context);}
    }
    let accessor;
    if(state.module==='sealed'&&witness.args.action===4n){
      check(witness.args.data.length>=240,'DRAW_DATA');const hash=hex(witness.args.data.slice(0,32));
      const block=(await rpc.call('getBlock',{hash,includeTransactions:false}))?.block;
      check(block?.header?.hash===hash&&block.verboseData?.isChainBlock===true,'DRAW_TARGET_NOT_CHAIN');unhex(block.header.acceptedIdMerkleRoot,32);
      accessor={blockHash:hash,sequenceCommitment:block.header.acceptedIdMerkleRoot};
    }
    result=interpretAccepted({manager,targets,funds,transaction:tx,accessor},profile);
  }
  check(result.cid===round.cid&&(result.terminal??null)===round.terminal,'INDEXER_HEAD_EFFECTS');
  for(const key of ['ticketPrice','ticketCap','minTickets','closeEligibleDaa'])check(round.settings[key]===state[key],'INDEXER_SETTINGS');
  const receipt=round.receipts.at(-1),headFee=contexts.reduce((n,u)=>n+u.value,0n)-tx.outputs.reduce((n,o)=>n+o.value,0n);
  check(round.accepting===head.acceptingBlock&&receipt?.txid===head.txid&&receipt.action===(result.action??'GENESIS')&&BigInt(receipt.feeSompi)===headFee,'INDEXER_HEAD_BINDING');
  if(result.next){
    const manager=round.manager,out=tx.outputs[0];
    check(manager&&manager.outpoint.transactionId===head.txid&&manager.outpoint.index===0&&manager.value===out.value&&same(manager.redeemScript,redeem(result.next,profile)),'INDEXER_HEAD_EFFECTS');
    const live=await liveRound(rpc,round,profile,{targets:round.frozen});round.manager=live.manager;round.frozen=live.targets;
  }else{
    check(round.manager===null&&round.frozen.length===0&&['EMPTY','PAID','REFUNDED'].includes(result.terminal),'INDEXER_TERMINAL');
    round.bought=totalTickets(state);
    if(result.terminal!=='EMPTY'&&(state.indices.length>0||state.records.length>0)){
      const supplied=new Map();
      for(const item of Array.isArray(document.historicalShards?.shards)?document.historicalShards.shards:[]){
        if(item&&typeof item.hash==='string'&&typeof item.redeemHex==='string')supplied.set(item.hash,item.redeemHex);
      }
      const shards=state.indices.map(idx=>{
        const redeemHex=supplied.get(idx.hash);
        if(redeemHex){
          const raw=unhex(redeemHex);
          check(hex(blake2b256(raw))===idx.hash,'INDEXER_HISTORICAL_SHARD_HASH');
          const decoded=identify(raw,profile);
          check(decoded.module==='frozen','INDEXER_HISTORICAL_SHARD_MODULE');
          return {end:idx.end,hash:idx.hash,records:decoded.records.map(rec=>({end:rec.end,key:rec.key}))};
        }
        return {end:idx.end,hash:idx.hash,records:null};
      });
      round.history={
        terminal:result.terminal,
        winnerKey:state.winnerKey??null,
        localRecords:state.records.map(rec=>({end:rec.end,key:rec.key})),
        shards,
      };
    }
  }
  if((result.terminal==='PAID'||state.module==='win')&&!round.draw){
    try{const drawInfo=await verifyDrawReceipt(round,rpc,profile);if(drawInfo)round.draw=drawInfo;}catch{}
  }
  const counted=result.next??state;round.bought=totalTickets(counted);round.buys=counted.indices.length*256+counted.records.length;
  const final=await acceptedAt(rpc,head.txid,head.acceptingBlock);check(final.acceptingDaa===evidence.acceptingDaa,'INDEXER_HEAD_MOVED');
  round.indexer={revision:String(document.revision),headTxid:head.txid,acceptingBlock:head.acceptingBlock,checkedAt:Date.now(),nodeEndpoint:rpc.url??null};
  return round;
}
