/** Local persistence of round records (each record carries its single pending intent, so "persist the intent" and
 * "block replacement" are ONE compare-and-set). IndexedDB via the repository's IndexedStore; MemoryStore is for
 * tests / browsers without IndexedDB and reports persistent:false, in which case the page refuses to send. */
import {IndexedStore} from '../core/lib/persistence.js';
import {outpointKey} from '../core/lib/transaction.js';
import {check} from '../core.mjs';
import {TN10_GENESIS,TN10_PROFILE_ID} from '../contract/protocol.mjs';

export class MemoryStore {
  persistent=false;#rows=new Map();
  async get(key){const r=this.#rows.get(key);return r?structuredClone(r):null;}
  async compareAndSet(key,expected,value){
    const prev=this.#rows.get(key);check((prev?.revision??null)===expected,'STALE_CACHE_REVISION');
    const rec={revision:(prev?.revision??-1)+1,value:structuredClone(value)};this.#rows.set(key,rec);return structuredClone(rec);
  }
  async compareAndSetWithCheck(key,expected,value,prefix,inspect){
    const prev=this.#rows.get(key);check((prev?.revision??null)===expected,'STALE_CACHE_REVISION');
    inspect([...this.#rows].filter(([k])=>k.startsWith(prefix)).map(([k,record])=>({key:k,record:structuredClone(record)})));
    const rec={revision:(prev?.revision??-1)+1,value:structuredClone(value)};this.#rows.set(key,rec);return structuredClone(rec);
  }
  async insertIfAbsentWithCheck(key,value,prefix,inspect){
    check(key.startsWith(prefix)&&!this.#rows.has(key),'INTENT_ALREADY_EXISTS');
    inspect([...this.#rows].filter(([k])=>k.startsWith(prefix)).map(([k,record])=>({key:k,record:structuredClone(record)})));
    const rec={revision:0,value:structuredClone(value)};this.#rows.set(key,rec);return structuredClone(rec);
  }
  async remove(key,expected){check(this.#rows.get(key)?.revision===expected,'STALE_CACHE_REVISION');this.#rows.delete(key);}
  async list(prefix){return [...this.#rows].filter(([k])=>k.startsWith(prefix)).map(([key,record])=>({key,record:structuredClone(record)}));}
}
export async function openRoundStore({factory=globalThis.indexedDB,name='kaswin-rolling-tn10'}={}) {
  if(!factory)return new MemoryStore();
  try {const s=await IndexedStore.open(name,factory);s.persistent=true;return s;}
  catch {return new MemoryStore();}
}
/** An intent still owns its inputs unless it was never sent, was accepted, or lost its inputs to another spend. */
export const intentBlocks=i=>!!i&&['PREPARED','SUBMITTED','UNKNOWN','REJECTED'].includes(i.status);
export const intentOutpoints=round=>round.intent?round.intent.draft.transaction.inputs.map(i=>outpointKey(i.previousOutpoint)):[];
/** Inputs spent by candidates that are not yet re-verified: the node's UTXO index may still list them, so they must never be reused as funding. */
export const pendingOutpoints=round=>(round.pending??[]).flatMap(p=>p.intent.draft.transaction.inputs.map(i=>outpointKey(i.previousOutpoint)));

const HASH64=/^[0-9a-f]{64}$/,DEC_UINT=/^[0-9]{1,30}$/;
export function sanitizeDiscoveredRound(raw) {
  if(!raw||typeof raw!=='object'||typeof raw.cid!=='string'||!HASH64.test(raw.cid))return null;
  const out={cid:raw.cid,terminal:typeof raw.terminal==='string'&&raw.terminal.length<=32?raw.terminal:null,
    module:typeof raw.module==='string'&&raw.module.length<=32?raw.module:null};
  if((typeof raw.phase==='string'&&raw.phase.length<=32)||(typeof raw.phase==='number'&&Number.isSafeInteger(raw.phase)))out.phase=raw.phase;
  for(const k of ['tickets','shards','bought','buys']){
    const v=raw[k];if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)out[k]=v;
  }
  const mv=raw.managerValue;
  out.managerValue=typeof mv==='string'&&DEC_UINT.test(mv)?mv:(typeof mv==='number'&&Number.isSafeInteger(mv)&&mv>=0?String(mv):null);
  const daa=raw.acceptingDaa;
  out.acceptingDaa=typeof daa==='string'&&DEC_UINT.test(daa)?daa:(typeof daa==='number'&&Number.isSafeInteger(daa)&&daa>=0?daa:null);
  out.updatedAt=typeof raw.updatedAt==='number'&&Number.isFinite(raw.updatedAt)&&raw.updatedAt>=0?Math.trunc(raw.updatedAt):null;
  if(raw.source==='rest'||raw.source==='indexer')out.source=raw.source;
  if(typeof raw.genesisTxid==='string'&&HASH64.test(raw.genesisTxid))out.genesisTxid=raw.genesisTxid;
  return out;
}
export function sanitizeDiscoveredRounds(list,{limit=500}={}) {
  if(!Array.isArray(list))return [];
  const byId=new Map();
  for(const item of list){
    const clean=sanitizeDiscoveredRound(item);
    if(!clean)continue;
    if(!byId.has(clean.cid)&&byId.size>=limit)continue;
    byId.set(clean.cid,clean);
  }
  return [...byId.values()];
}

export class RoundStore {
  #discoveryQueue=Promise.resolve();
  #previewQueue=Promise.resolve();
  constructor(store,{genesis=TN10_GENESIS,profileId=TN10_PROFILE_ID}={}){
    this.store=store;this.prefix=`${genesis}/${profileId}/round/`;this.discoveryKey=`${genesis}/${profileId}/discovery`;
    this.previewPrefix=`${genesis}/${profileId}/preview/`;
  }
  get persistent(){return this.store.persistent!==false;}
  key(cid){return this.prefix+cid;}
  previewKey(cid){return this.previewPrefix+cid;}
  async getPreview(cid){
    try{
      if(typeof cid!=='string'||!HASH64.test(cid))return null;
      const rec=await this.store.get(this.previewKey(cid)),val=rec?.value;
      return typeof val?.roundText==='string'?val.roundText:null;
    }catch{return null;}
  }
  async savePreview(cid,roundText){
    if(typeof cid!=='string'||!HASH64.test(cid)||typeof roundText!=='string'||roundText.length>4_000_000)return null;
    const key=this.previewKey(cid),payload={v:1,roundText,savedAt:Date.now()};
    const task=this.#previewQueue.then(async()=>{
      for(let attempt=0;attempt<3;attempt++){
        try{
          const cur=await this.store.get(key);
          await this.store.compareAndSet(key,cur?.revision??null,payload);
          return payload;
        }catch(e){
          if(e?.message!=='STALE_CACHE_REVISION'||attempt===2)return null;
        }
      }
      return null;
    });
    this.#previewQueue=task.catch(()=>{});
    return task;
  }
  async removePreview(cid){
    if(typeof cid!=='string'||!HASH64.test(cid))return;
    const key=this.previewKey(cid);
    const task=this.#previewQueue.then(async()=>{
      try{const cur=await this.store.get(key);if(cur)await this.store.remove(key,cur.revision);}catch{}
    });
    this.#previewQueue=task.catch(()=>{});
    return task;
  }
  async readDiscovery(){
    try{
      const rec=await this.store.get(this.discoveryKey),val=rec?.value;
      if(!val||typeof val!=='object')return null;
      const rounds=sanitizeDiscoveredRounds(val.rounds);
      const savedAt=typeof val.savedAt==='number'&&Number.isFinite(val.savedAt)&&val.savedAt>=0?Math.trunc(val.savedAt):0;
      const origin=val.origin==='rest'?'rest':'indexer';
      const base=typeof val.base==='string'&&val.base.length<=512?val.base:'';
      return {rounds,savedAt,origin,base};
    }catch{return null;}
  }
  async writeDiscovery({rounds,origin='indexer',base='',savedAt=Date.now()}={}){
    const payload={
      v:1,rounds:sanitizeDiscoveredRounds(rounds),origin:origin==='rest'?'rest':'indexer',
      base:typeof base==='string'?base.slice(0,512):'',
      savedAt:typeof savedAt==='number'&&Number.isFinite(savedAt)&&savedAt>=0?Math.trunc(savedAt):Date.now(),
    };
    const task=this.#discoveryQueue.then(async()=>{
      for(let attempt=0;attempt<3;attempt++){
        try{
          const cur=await this.store.get(this.discoveryKey);
          await this.store.compareAndSet(this.discoveryKey,cur?.revision??null,payload);
          return payload;
        }catch(e){
          if(e?.message!=='STALE_CACHE_REVISION'||attempt===2)return null;
        }
      }
      return null;
    });
    this.#discoveryQueue=task.catch(()=>{});
    return task;
  }
  async list(){return (await this.store.list(this.prefix)).map(x=>({round:x.record.value,revision:x.record.revision}));}
  async get(cid){const r=await this.store.get(this.key(cid));return r?{round:r.value,revision:r.revision}:null;}
  /** Atomic create. Refuses an existing cid and any record whose pending intent shares an input with the new one. */
  async create(round){
    const mine=new Set(intentOutpoints(round));
    return this.store.insertIfAbsentWithCheck(this.key(round.cid),round,this.prefix,rows=>{
      for(const {record} of rows){const o=record.value;
        if(intentBlocks(o.intent)&&intentOutpoints(o).some(k=>mine.has(k)))throw Object.assign(new Error('INPUT_RESERVED_BY_PENDING_INTENT'),{code:'INPUT_RESERVED_BY_PENDING_INTENT'});}
    });
  }
  /** Compare-and-set replace. Callers MUST pass the revision they read; a stale revision never overwrites. */
  async replace(round,expectedRevision){
    if(!round.intent)return this.store.compareAndSet(this.key(round.cid),expectedRevision,round);
    const mine=new Set(intentOutpoints(round)),inspect=rows=>{
      for(const {key,record} of rows)if(key!==this.key(round.cid)&&intentBlocks(record.value.intent))
        check(!intentOutpoints(record.value).some(k=>mine.has(k)),'INPUT_RESERVED_BY_PENDING_INTENT');
    };
    if(this.store.compareAndSetWithCheck)return this.store.compareAndSetWithCheck(this.key(round.cid),expectedRevision,round,this.prefix,inspect);
    check(this.store.db,'ATOMIC_STORE_REQUIRED');
    return new Promise((resolve,reject)=>{
      const range=typeof IDBKeyRange!=='undefined'&&this.prefix?IDBKeyRange.bound(this.prefix,this.prefix+'\uffff',false,true):undefined;
      const tx=this.store.db.transaction('records','readwrite'),object=tx.objectStore('records'),rows=[];let cause,result,previous=null;
      const req=object.openCursor(range);
      req.onsuccess=()=>{try{const c=req.result;if(c){if(c.key===this.key(round.cid))previous=c.value;
        if(typeof c.key==='string'&&c.key.startsWith(this.prefix))rows.push({key:c.key,record:c.value});c.continue();}
        else {check((previous?.revision??null)===expectedRevision,'STALE_CACHE_REVISION');inspect(rows);
          result={revision:(previous?.revision??-1)+1,value:round};object.put(result,this.key(round.cid));}}
        catch(e){cause=e;tx.abort();}};
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(cause??tx.error??new Error('IDB_ABORT'));tx.onerror=()=>reject(cause??tx.error);
    });
  }
  async remove(cid,revision){return this.store.remove(this.key(cid),revision);}
  /** Inputs reserved by any pending intent (advisory for funding selection). */
  async reserved(){const set=new Set();for(const {round} of await this.list()){if(intentBlocks(round.intent))for(const k of intentOutpoints(round))set.add(k);for(const k of pendingOutpoints(round))set.add(k);}return set;}
}
