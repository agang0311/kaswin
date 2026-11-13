/** Framework-neutral Indexer endpoints and accepted-event ingestion. NOT_RUN.
 * nodeAdapter must use the configured node: authenticateAccepted(txid, position) returns
 * authenticated transaction + spent UTXOs + manager context + PASS-A accessor, never caller DTOs.
 * authenticateReversal(position) establishes removal of an accepted instance.
 */
import {createHash} from 'node:crypto';
import {ascii,same,stable} from '../../scripts/core/lib/bytes.js';
import {blake2b256} from '../../scripts/core/lib/hashes.js';
import {referenceTxId,outpointKey,validateTransaction} from '../../scripts/core/lib/transaction.js';
import {p2sh} from '../../scripts/core/lib/covenant-id.js';
import {identify,redeem,rootId,verifyManager,assertProfile} from './profile.mjs';
import {interpretAccepted} from './accepted.mjs';
import * as S from './state.mjs';
const {check,hex,unhex}=S;
const sha=text=>createHash('sha256').update(text).digest('hex');
const decimal=n=>{check(typeof n==='bigint'&&n>=0n,'WIRE_BIGINT');return n.toString();};
export class RollingIndexer {
  constructor({archive,profile,networkGenesis,nodeAdapter}) {
    assertProfile(profile);unhex(networkGenesis,32);check(archive&&nodeAdapter,'INDEXER_DEPENDENCIES');
    this.store=archive;this.profile=profile;this.network=networkGenesis;this.node=nodeAdapter;
  }
  async putPreimage(hash,redeemHex) {
    unhex(hash,32);const raw=unhex(redeemHex);check(raw.length<=250000&&hex(blake2b256(raw))===hash,'PREIMAGE_HASH');
    const state=identify(raw,this.profile);
    await this.store.putPreimage(this.network,this.profile.id,hash,redeemHex);
    return {scriptHash:hash,module:state.module,status:'CANDIDATE'};
  }
  async getPreimage(hash) {
    const raw=await this.store.getPreimage(this.network,this.profile.id,hash);if(raw===null)return null;
    const state=identify(unhex(raw),this.profile);check(hex(blake2b256(unhex(raw)))===hash,'ARCHIVE_CORRUPTION');
    return {scriptHash:hash,redeemScript:raw,module:state.module};
  }
  async #descriptor(output,outpoint,daa,state) {
    const raw=redeem(state,this.profile),hash=hex(blake2b256(raw));
    check(stable(output.scriptPublicKey)===stable(p2sh(hash)),'OUTPUT_PREIMAGE');
    await this.putPreimage(hash,hex(raw));
    return {outpoint,scriptHash:hash,module:state.module,value:decimal(output.value),utxoDaa:decimal(daa)};
  }
  async #material(d,cid,origin,currentDaa) {
    const raw=await this.getPreimage(d.scriptHash);check(raw,'MISSING_PREIMAGE');
    check(raw.module===d.module,'DESCRIPTOR_MODULE');
    return {outpoint:d.outpoint,redeemScript:unhex(raw.redeemScript),spk:p2sh(d.scriptHash),cid,origin,
      value:BigInt(d.value),utxoDaa:BigInt(d.utxoDaa),currentDaa};
  }
  async verifyView(view,currentDaa) {
    check(view.networkGenesis===this.network&&view.profileId===this.profile.id,'VIEW_DOMAIN');unhex(view.cid,32);
    check(Array.isArray(view.frozen),'VIEW_FROZEN');
    if(view.manager===null){check(view.terminal&&view.frozen.length===0,'TERMINAL_REMAINDER');return;}
    const manager=await this.#material(view.manager,view.cid,view.origin,currentDaa),s=verifyManager(manager,this.profile);
    check(view.manager.module===s.module,'MANAGER_MODULE');
    check(!view.terminal,'LIVE_TERMINAL');
    const start=s.module==='win'?s.p:s.module==='refund'?s.r:0;
    check(view.frozen.length===s.indices.length-start,'FROZEN_SET_COUNT');
    const remaining=new Map();const seen=new Set([outpointKey(view.manager.outpoint)]);
    for(const d of view.frozen) {
      const id=outpointKey(d.outpoint);check(!seen.has(id),'DUPLICATE_OUTPOINT');seen.add(id);
      const f=await this.#material(d,view.cid,view.origin,currentDaa),state=identify(f.redeemScript,this.profile);
      check(state.module==='frozen','FROZEN_ROLE');
      const key=d.scriptHash+':'+d.value;remaining.set(key,(remaining.get(key)??0)+1);
    }
    for(let j=start;j<s.indices.length;j++) {
      const preimage=await this.getPreimage(s.indices[j].hash);check(preimage,'MISSING_FROZEN_PREIMAGE');
      const f=identify(unhex(preimage.redeemScript),this.profile);check(f.module==='frozen','FROZEN_ROLE');
      const value=S.frozenValue(s,j,f.records),key=s.indices[j].hash+':'+value.toString();
      check((remaining.get(key)??0)>0,'FROZEN_MULTISET');remaining.set(key,remaining.get(key)-1);
    }
    check([...remaining.values()].every(n=>n===0),'EXTRA_FROZEN');
  }
  /** All facts come from the node adapter; hints only locate evidence. */
  async ingest(txid,position,expectedRevision) {
    unhex(txid,32);const facts=await this.node.authenticateAccepted(txid,position);
    const beforePublish=()=>{facts?.assertCurrent?.();};
    try {
    beforePublish();
    check(facts?.accepted===true&&facts.networkGenesis===this.network,'NODE_ACCEPTANCE_REQUIRED');
    const tx=facts.transaction;validateTransaction(tx);check(referenceTxId(tx)===txid,'TXID');
    check(typeof facts.utxoDaa==='bigint'&&typeof facts.currentDaa==='bigint'&&facts.utxoDaa<=facts.currentDaa,'NODE_DAA');
    const witnessDigest=sha(tx.inputs.map(i=>i.signatureScript).join(':'));
    const instance=sha(stable({network:this.network,profile:this.profile.id,txid,position:facts.position,witnessDigest}));
    let cid,origin,effects;
    if(facts.manager) {
      cid=facts.manager.cid;origin=facts.manager.origin;
      effects=interpretAccepted({...facts,transaction:tx},this.profile);
    } else {
      const prefix=ascii('KASWIN_ROLLING_GENESIS_V1'),payload=unhex(tx.payload);
      check(payload.length===prefix.length+32+59&&same(payload.slice(0,prefix.length),prefix),'GENESIS_PAYLOAD');
      check(hex(payload.slice(prefix.length,prefix.length+32))===this.profile.id,'GENESIS_PROFILE');
      const s=S.decode('sales',payload.slice(prefix.length+32));check(s.indices.length===0&&s.records.length===0,'GENESIS_STATE');
      check(tx.inputs.length>=1&&tx.inputs.length<=8&&facts.funds?.length===tx.inputs.length,'GENESIS_INPUTS');
      facts.funds.forEach((f,i)=>check(outpointKey(f.outpoint)===outpointKey(tx.inputs[i].previousOutpoint)&&(!f.cid||f.cid===S.ZERO)&&(!f.covenantId||f.covenantId===S.ZERO),'GENESIS_FUNDING'));
      origin=tx.inputs[0].previousOutpoint;cid=rootId(origin,s,this.profile);
      check(tx.outputs[0]?.value===S.DEPOSIT&&tx.outputs[0].covenant?.covenantId===cid&&tx.outputs[0].covenant?.authorizingInput===0,'GENESIS_OUTPUT');
      check(tx.outputs.slice(1).every(o=>!o.covenant),'GENESIS_EXTRA_COVENANT');
      check(tx.outputs.length>=1&&tx.outputs.length<=3,'GENESIS_OUTPUT_COUNT');
      effects={action:'GENESIS',terminal:null,next:s,outputs:[{...tx.outputs[0],state:s}]};
    }
    const newStates=[];
    for(let i=0;i<effects.outputs.length;i++)if(effects.outputs[i].state) newStates.push(await this.#descriptor(tx.outputs[i],{transactionId:txid,index:i},facts.utxoDaa,effects.outputs[i].state));
    const current=await this.store.getRound(this.network,this.profile.id,cid);
    if(current&&await this.store.activeInstance(this.network,this.profile.id,cid,instance))return current;
    return await this.store.update(this.network,this.profile.id,cid,expectedRevision,async old=>{
      if(facts.manager)check(old?.manager&&outpointKey(old.manager.outpoint)===outpointKey(facts.manager.outpoint)&&stable(old.origin)===stable(origin),'STALE_MANAGER');
      else check(old===null||old.terminal==='GENESIS_REVERTED','GENESIS_EXISTS');
      const spent=new Set(tx.inputs.map(i=>outpointKey(i.previousOutpoint)));
      const frozen=[...(old?.frozen??[]).filter(f=>!spent.has(outpointKey(f.outpoint))),...newStates.filter(f=>f.module==='frozen')];
      const manager=newStates.find(f=>f.module!=='frozen')??null;
      const before=old?{manager:old.manager,terminal:old.terminal,acceptance:old.acceptance,
        restoredFrozen:old.frozen.filter(f=>spent.has(outpointKey(f.outpoint)))}:null;
      const event={type:'ACCEPT',instance,txid,position:facts.position,witnessDigest,action:effects.action,before,
        createdFrozen:newStates.filter(f=>f.module==='frozen'),
        // Actual consumed outpoints retain logical order, including equal-hash interchangeable shards.
        consumedTargets:(facts.targets??[]).map(f=>f.outpoint)};
      const next={networkGenesis:this.network,profileId:this.profile.id,cid,origin,manager,frozen,terminal:effects.terminal,
        acceptance:{instance,txid,position:facts.position},event};
      await this.verifyView(next,facts.currentDaa);beforePublish();return next;
    });
    } finally {facts?.release?.();}
  }
  async revert(cid,instance,expectedRevision) {
    const old=await this.store.getRound(this.network,this.profile.id,cid);check(old,'ROUND_NOT_FOUND');
    const event=await this.store.activeInstance(this.network,this.profile.id,cid,instance);check(event,'ACCEPT_INSTANCE');
    check(old.acceptance?.instance===instance,'REVERT_DESCENDANTS_FIRST');
    const fact=await this.node.authenticateReversal(event.position);
    check(fact?.removed===true&&fact.networkGenesis===this.network,'NODE_REVERSAL_REQUIRED');
    return this.store.update(this.network,this.profile.id,cid,expectedRevision,async current=>{
      check(current.acceptance?.instance===instance,'REVERSAL_RACE');
      const {restoredFrozen=[],...restored}=event.before??{manager:null,terminal:'GENESIS_REVERTED',acceptance:null};
      const created=new Set(event.createdFrozen.map(f=>outpointKey(f.outpoint)));
      const frozen=[...current.frozen.filter(f=>!created.has(outpointKey(f.outpoint))),...restoredFrozen];
      return {...current,...restored,frozen,event:{type:'REVERT',reverts:instance,position:event.position}};
    });
  }
  async history(cid,{cursor=null,limit=100}={}) {
    S.integer(limit,1,100);const view=await this.store.getRound(this.network,this.profile.id,cid);if(!view)return null;
    check(BigInt(view.revision)<=BigInt(Number.MAX_SAFE_INTEGER),'REVISION_RANGE');const count=Number(view.revision);
    let offset=0;
    if(cursor){check(typeof cursor==='string'&&cursor.length<=4096,'CURSOR_SIZE');const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));check(c.network===this.network&&c.profile===this.profile.id&&c.cid===cid&&c.revision===view.revision,'CURSOR_STALE');offset=S.integer(c.offset,0,count);}
    const events=await this.store.readEvents(this.network,this.profile.id,cid,{offset,limit,revision:view.revision}),nextOffset=offset+events.length;
    const next=nextOffset<count?Buffer.from(JSON.stringify({network:this.network,profile:this.profile.id,cid,revision:view.revision,offset:nextOffset})).toString('base64url'):null;
    return {revision:view.revision,events,next};
  }
  /** Bounded-memory NDJSON export. A missing final `end` record means incomplete material. */
  async *exportEntries(round) {
    const hashes=new Set();
    const add=d=>{if(d?.scriptHash)hashes.add(d.scriptHash);};
    add(round.manager);round.frozen.forEach(add);
    yield {type:'round',format:'kaswin-rolling-export-v1',round,status:'ARCHIVE_MATERIAL_NOT_ACCEPTANCE_PROOF'};
    let offset=0;check(BigInt(round.revision)<=BigInt(Number.MAX_SAFE_INTEGER),'REVISION_RANGE');
    while(BigInt(offset)<BigInt(round.revision)) {
      const page=await this.store.readEvents(this.network,this.profile.id,round.cid,{offset,limit:100,revision:round.revision});
      for(const event of page) {
        add(event.before?.manager);(event.before?.restoredFrozen??[]).forEach(add);(event.createdFrozen??[]).forEach(add);
        yield {type:'event',event};
      }
      offset+=page.length;
    }
    for(const hash of hashes) {const preimage=await this.getPreimage(hash);check(preimage,'EXPORT_PREIMAGE_MISSING');yield {type:'preimage',preimage};}
    yield {type:'end',revision:round.revision,events:offset,preimages:hashes.size};
  }
  /** Small-export convenience API. HTTP uses exportEntries instead. */
  async export(cid) {
    const round=await this.store.getRound(this.network,this.profile.id,cid);if(!round)return null;
    const events=[],preimages=[];
    for await(const row of this.exportEntries(round)) {
      if(row.type==='event')events.push(row.event);
      if(row.type==='preimage')preimages.push(row.preimage);
    }
    return {format:'kaswin-rolling-export-v1',round,events,preimages,status:'ARCHIVE_MATERIAL_NOT_ACCEPTANCE_PROOF'};
  }
  /** Returns {status,body} or {status,stream}; host enforces request limits before parsing. */
  async request(method,relativePath,body=null) {
    check(typeof relativePath==='string'&&relativePath.length<=8192,'REQUEST_PATH');
    const url=new URL(relativePath,'https://rolling.invalid');
    const parts=url.pathname.split('/').filter(Boolean);
    if(parts[0]==='preimages'&&parts.length===2) {
      if(method==='PUT')return {status:201,body:await this.putPreimage(parts[1],body?.redeemScript)};
      if(method==='GET'){const result=await this.getPreimage(parts[1]);return {status:result?200:404,body:result};}
    }
    if(parts[0]==='rounds'&&method==='GET') {
      if(parts.length===2){const v=await this.store.getRound(this.network,this.profile.id,parts[1]);return {status:v?200:404,body:v};}
      if(parts.length===3&&parts[2]==='history') {
        const limitText=url.searchParams.get('limit')??'100';check(/^[0-9]{1,3}$/.test(limitText),'HISTORY_LIMIT');
        const v=await this.history(parts[1],{cursor:url.searchParams.get('cursor'),limit:Number(limitText)});
        return {status:v?200:404,body:v};
      }
      if(parts.length===3&&parts[2]==='export') {
        const v=await this.store.getRound(this.network,this.profile.id,parts[1]);
        return v?{status:200,stream:this.exportEntries(v)}:{status:404,body:null};
      }
    }
    return {status:404,body:null};
  }
}
