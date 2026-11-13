/** Durable single-writer archive adapter. NOT_RUN; no service is started by importing this file.
 * Each round has a small atomic snapshot and an append-only revision journal. Immutable
 * preimages and the journal entry are fsynced before the new snapshot is published.
 * Run exactly one writer process per directory; a database adapter is required for multiple writers.
 */
import {mkdir,readFile,open,rename,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {check,unhex} from './state.mjs';
export class FileArchive {
  #root; #tail=Promise.resolve();
  constructor(root) {check(typeof root==='string'&&root.length>0,'ARCHIVE_ROOT');this.#root=root;}
  #segment(value) {unhex(value,32);return value;}
  #roundKey(network,profile,cid) {return [network,profile,cid].map(v=>this.#segment(v)).join('-');}
  async #read(path) {try{return await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async #atomic(dir,name,text,immutable=false) {
    const firstCreated=await mkdir(dir,{recursive:true});
    if(firstCreated) {
      const stop=resolve(dirname(firstCreated));let at=resolve(dir);
      for(;;) {
        const directory=await open(at,'r');try{await directory.sync();}finally{await directory.close();}
        if(at===stop||dirname(at)===at)break;at=dirname(at);
      }
    }
    const destination=join(dir,name),existing=await this.#read(destination);
    if(immutable&&existing!==null){check(existing===text,'IMMUTABLE_PREIMAGE_CONFLICT');return;}
    const tmp=join(dir,'.'+randomUUID()+'.tmp');let file;
    try {
      file=await open(tmp,'wx',0o600);await file.writeFile(text,'utf8');await file.sync();await file.close();file=null;
      await rename(tmp,destination);const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
    } finally {if(file)await file.close();await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  }
  async #exclusive(fn) {
    const previous=this.#tail;let release;this.#tail=new Promise(resolve=>{release=resolve;});await previous;
    try{return await fn();}finally{release();}
  }
  async putPreimage(network,profile,hash,redeemHex) {
    const dir=join(this.#root,'preimages',this.#segment(network),this.#segment(profile));this.#segment(hash);unhex(redeemHex);
    return this.#exclusive(()=>this.#atomic(dir,hash+'.hex',redeemHex,true));
  }
  async getPreimage(network,profile,hash) {
    return this.#read(join(this.#root,'preimages',this.#segment(network),this.#segment(profile),this.#segment(hash)+'.hex'));
  }
  async getRound(network,profile,cid) {
    const text=await this.#read(join(this.#root,'rounds',this.#roundKey(network,profile,cid)+'.json'));return text===null?null:JSON.parse(text);
  }
  async update(network,profile,cid,expectedRevision,apply) {
    check(/^(0|[1-9][0-9]*)$/.test(expectedRevision),'REVISION');
    return this.#exclusive(async()=>{
      const current=await this.getRound(network,profile,cid);
      check((current?.revision??'0')===expectedRevision,'REVISION_CONFLICT');
      const next=await apply(current);check(next&&next.networkGenesis===network&&next.profileId===profile&&next.cid===cid,'ARCHIVE_IDENTITY');
      check(next.event&&typeof next.event.type==='string','ARCHIVE_EVENT');
      const revision=(BigInt(expectedRevision)+1n).toString(),event={...next.event,revision};
      const snapshot={...next,revision};delete snapshot.event;
      // A failed unpublished revision can be replaced; committed revisions are never rewritten.
      // Readers only expose journal entries up to the atomically published snapshot.revision.
      const key=this.#roundKey(network,profile,cid);
      await this.#atomic(join(this.#root,'journal',key),revision+'.json',JSON.stringify(event));
      const instance=event.type==='REVERT'?event.reverts:event.instance;this.#segment(instance);
      await this.#atomic(join(this.#root,'receipts',key),instance+'.json',JSON.stringify({revision,type:event.type}));
      await this.#atomic(join(this.#root,'rounds'),key+'.json',JSON.stringify(snapshot));return snapshot;
    });
  }
  async readEvents(network,profile,cid,{offset=0,limit=100,revision=null}={}) {
    check(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'EVENT_PAGE');
    const current=await this.getRound(network,profile,cid);check(current,'ROUND_NOT_FOUND');
    const end=revision??current.revision;check(/^(0|[1-9][0-9]*)$/.test(end)&&BigInt(end)<=BigInt(current.revision),'EVENT_REVISION');
    check(BigInt(offset)<=BigInt(end),'EVENT_OFFSET');
    const count=Number(BigInt(end)-BigInt(offset)>BigInt(limit)?BigInt(limit):BigInt(end)-BigInt(offset));
    const dir=join(this.#root,'journal',this.#roundKey(network,profile,cid));
    return Promise.all(Array.from({length:count},async(_,i)=>{
      const rev=(BigInt(offset)+BigInt(i)+1n).toString(),raw=await this.#read(join(dir,rev+'.json'));
      check(raw!==null,'JOURNAL_MISSING');const event=JSON.parse(raw);check(event.revision===rev,'JOURNAL_REVISION');return event;
    }));
  }
  async activeInstance(network,profile,cid,instance) {
    const view=await this.getRound(network,profile,cid);if(!view)return null;
    this.#segment(instance);const key=this.#roundKey(network,profile,cid);
    const raw=await this.#read(join(this.#root,'receipts',key,instance+'.json'));if(raw===null)return null;
    const receipt=JSON.parse(raw);
    if(BigInt(receipt.revision)<=BigInt(view.revision)) {
      const eventText=await this.#read(join(this.#root,'journal',key,receipt.revision+'.json'));check(eventText!==null,'JOURNAL_MISSING');
      const event=JSON.parse(eventText),eventInstance=event.type==='REVERT'?event.reverts:event.instance;
      if(eventInstance===instance&&event.type===receipt.type)return event.type==='REVERT'?null:event;
    }
    // An interrupted/replaced unpublished update can leave a derived receipt index stale.
    check(BigInt(view.revision)<=BigInt(Number.MAX_SAFE_INTEGER),'REVISION_RANGE');
    let end=Number(view.revision);
    while(end>0) {
      const start=Math.max(0,end-100),events=await this.readEvents(network,profile,cid,{offset:start,limit:end-start,revision:view.revision});
      for(const e of events.reverse()) {
        if(e.type==='REVERT'&&e.reverts===instance)return null;
        if(e.type==='ACCEPT'&&e.instance===instance)return e;
      }
      end=start;
    }
    return null;
  }
}
