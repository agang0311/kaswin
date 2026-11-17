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
export async function openRoundStore({factory=globalThis.indexedDB}={}) {
  if(!factory)return new MemoryStore();
  try {const s=await IndexedStore.open('kaswin-rolling-tn10',factory);s.persistent=true;return s;}
  catch {return new MemoryStore();}
}
/** An intent still owns its inputs unless it was never sent, was accepted, or lost its inputs to another spend. */
export const intentBlocks=i=>!!i&&['PREPARED','SUBMITTED','UNKNOWN','REJECTED'].includes(i.status);
export const intentOutpoints=round=>round.intent?round.intent.draft.transaction.inputs.map(i=>outpointKey(i.previousOutpoint)):[];
/** Inputs spent by candidates that are not yet re-verified: the node's UTXO index may still list them, so they must never be reused as funding. */
export const pendingOutpoints=round=>(round.pending??[]).flatMap(p=>p.intent.draft.transaction.inputs.map(i=>outpointKey(i.previousOutpoint)));

export class RoundStore {
  constructor(store){this.store=store;this.prefix=`${TN10_GENESIS}/${TN10_PROFILE_ID}/round/`;}
  get persistent(){return this.store.persistent!==false;}
  key(cid){return this.prefix+cid;}
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
      const tx=this.store.db.transaction('records','readwrite'),object=tx.objectStore('records'),rows=[];let cause,result,previous=null;
      const req=object.openCursor();
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
