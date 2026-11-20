/** Page controller: every user-visible operation, without DOM. Dependencies are injected so the whole flow runs offline in tests.
 * Safety rules enforced here:
 *  - the round record carries exactly ONE intent; it is persisted (compare-and-set) BEFORE any send, and an unresolved
 *    intent (PREPARED/SUBMITTED/UNKNOWN/REJECTED) blocks preparing another transaction for that round;
 *  - UNKNOWN/SUBMITTED outcomes are only reconciled (search acceptance / resend the SAME bytes after live-input checks);
 *  - V2.0.2 pacing: the FIRST selected-chain acceptance (searchAccepted + acceptedAt + matchesDraft) is a CANDIDATE: the record advances from the
 *    node-served tx and the next step may be prepared at once. A candidate becomes ACCEPTED only after recheckCandidate (>=100 DAA deep, still on the
 *    selected chain, same draft). A reorg that moves it is recorded (same signed bytes re-accepted); a candidate that is neither accepted nor in the
 *    mempool halts the round (fail closed). */
import {mempoolEntry,inputsState,sameInput} from '../chain/chain.mjs';
import {check} from '../core.mjs';
import {outpointKey} from '../core/lib/transaction.js';
import {emptyRound,advanceRound,settleCandidate,moveCandidate,availableActions,describeRound,roundToText,roundFromText,validateRound} from './round.mjs';
import {authenticateIntent,submitIntent,statusAfterFailure,checkAcceptance,recheckCandidate} from '../tracking/intent.mjs';
import {prepareOperation,nodeFeeRate,liveRound,connectNetwork,signAndRecord} from './prepare.mjs';
import {classifyRejection} from '../tracking/conflict.mjs';
import {spkToAddress} from '../wallet/address.mjs';
import {openMemoryWallet,publicRecipient} from '../wallet/wallet.mjs';
import {openExtensionWallet} from '../wallet/extension-wallet.mjs';
import {openKaspireWallet} from '../wallet/kaspire-wallet.mjs';
import {createIndexerClient,materializeIndexedDocument} from './indexer-client.mjs';
import {discoverRestRollingRounds,syncRoundThreeTier} from './catchup.mjs';
import {sanitizeDiscoveredRounds} from '../store/round-store.mjs';
import {TN10} from '../chain/tn10.mjs';
import {parseTkas,parseUint} from '../../web/ui/format.mjs';
const FUNDED=new Set(['GENESIS','BUY','CLOSE','DRAW','TIMEOUT']);
const LOST_GRACE_MS=180000;
const codeOf=e=>e?.code??e?.safeCode??(typeof e?.message==='string'&&/^[A-Z0-9_]{3,64}$/.test(e.message)?e.message:'ERROR');

export function createController({profile,roundStore,connect=(urls,opts)=>connectNetwork(urls,opts),now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),fetcher=globalThis.fetch,net=TN10,discoveryCache=null}) {
  const c={rpc:null,indexer:null,indexerInfo:null,indexerCursor:null,discovered:[],discoveredSource:null,discoveredCachedAt:null,watchedAddress:null,lastSynced:null,wallet:null,prepared:null,busy:false,busyLabel:null,logs:[]},listeners=new Set();
  let cachedOrigin=null,api=null;
  const applyCachedDiscovery=snap=>{
    if(!snap||typeof snap!=='object')return false;
    const rounds=sanitizeDiscoveredRounds(snap.rounds);
    if(!rounds.length)return false;
    c.discovered=rounds;c.discoveredSource='cache';
    c.discoveredCachedAt=typeof snap.savedAt==='number'&&Number.isFinite(snap.savedAt)?snap.savedAt:null;
    cachedOrigin=snap.origin==='rest'?'rest':'indexer';
    return true;
  };
  const persistDiscovery=(rounds,origin,base='',{temporaryFallback=false}={})=>{
    const clean=sanitizeDiscoveredRounds(rounds),savedAt=now();
    if(!(temporaryFallback&&cachedOrigin==='indexer')){
      cachedOrigin=origin==='rest'?'rest':'indexer';
      void roundStore.writeDiscovery?.({rounds:clean,origin:cachedOrigin,base,savedAt});
      if(discoveryCache?.write){try{discoveryCache.write({rounds:clean.slice(0,200),origin:cachedOrigin,base,savedAt});}catch{}}
    }
    return clean;
  };
  if(discoveryCache?.read){try{applyCachedDiscovery(discoveryCache.read());}catch{}}
  const outpointFromEntry=entry=>{
    const op=entry?.outpoint??entry?.utxoEntry?.outpoint??entry?.entry?.outpoint;
    return op&&typeof op.transactionId==='string'&&op.index!=null?`${op.transactionId}:${Number(op.index)}`:null;
  };
  let watchedCid=null,watchSeq=0,watchTimer=null,watchQueue=Promise.resolve();
  let activeWatch={rpc:null,address:null,tipKey:null,mode:null,pendingWake:false,offUtxos:null,offDisconnect:null};
  const wakeRetries=new Map();
  const teardownWatch=({unsubscribe=true}={})=>{
    if(watchTimer){clearTimeout(watchTimer);watchTimer=null;}
    const prev=activeWatch;
    activeWatch={rpc:null,address:null,tipKey:null,mode:null,pendingWake:false,offUtxos:null,offDisconnect:null};
    c.watchedAddress=null;
    try{prev.offUtxos?.();}catch{}
    try{prev.offDisconnect?.();}catch{}
    if(unsubscribe&&prev.rpc&&prev.address&&typeof prev.rpc.subscribe==='function'){
      void prev.rpc.subscribe([prev.address],false).catch(()=>{});
    }
  };
  const activeRoundSyncs=new Set();
  const wakeWatchedRound=(cid,triggerKey,delayMs=80)=>{
    if(watchedCid!==cid||!c.rpc||activeRoundSyncs.has(cid))return;
    if(watchTimer)clearTimeout(watchTimer);
    watchTimer=setTimeout(async()=>{
      watchTimer=null;
      if(watchedCid!==cid||!c.rpc||!api)return;
      const cur=await roundStore.get(cid).catch(()=>null);
      if(!cur||cur.round.terminal||cur.round.halted)return;
      if(cur.round.intent){
        if(['SUBMITTED','UNKNOWN','PREPARED'].includes(cur.round.intent.status)){
          try{await api.track(cid);}catch{}
        }
        return;
      }
      if(c.prepared?.cid===cid||c.busy){
        if(activeWatch.rpc===c.rpc)activeWatch.pendingWake=true;
        return;
      }
      activeWatch.pendingWake=false;
      try{
        await api.syncRound(cid,{force:true,timeBudgetMs:5000});
        wakeRetries.delete(triggerKey);
      }catch{
        const count=wakeRetries.get(triggerKey)??0;
        if(count<1&&watchedCid===cid&&c.rpc){
          wakeRetries.set(triggerKey,count+1);
          wakeWatchedRound(cid,triggerKey,1000);
        }
      }
    },delayMs);
  };
  const applyWatch=async seq=>{
    if(seq!==watchSeq)return;
    const rpc=c.rpc,cid=watchedCid;
    if(!cid||!rpc||typeof rpc.subscribe!=='function'||typeof rpc.on!=='function'){teardownWatch();return;}
    if(activeRoundSyncs.has(cid))return;
    const cur=await roundStore.get(cid).catch(()=>null);
    if(seq!==watchSeq||watchedCid!==cid||c.rpc!==rpc)return;
    if(!cur||cur.round.terminal||cur.round.halted){teardownWatch();return;}
    let targetAddr=null,targetTipKey=null,mode=null;
    if(cur.round.manager){
      targetAddr=spkToAddress(cur.round.manager.spk,net.addressPrefix);
      targetTipKey=outpointKey(cur.round.manager.outpoint);
      mode='manager';
    }else if(cur.round.step===0&&cur.round.intent?.draft?.transaction?.outputs?.[0]?.scriptPublicKey){
      targetAddr=spkToAddress(cur.round.intent.draft.transaction.outputs[0].scriptPublicKey,net.addressPrefix);
      mode='genesis';
    }
    if(!targetAddr){teardownWatch();return;}
    if(activeWatch.rpc===rpc&&activeWatch.address===targetAddr){
      activeWatch.tipKey=targetTipKey;activeWatch.mode=mode;
      if(activeWatch.pendingWake&&!cur.round.intent&&c.prepared?.cid!==cid&&!c.busy){
        activeWatch.pendingWake=false;
        wakeWatchedRound(cid,targetTipKey??targetAddr,20);
      }
      return;
    }
    const prev=activeWatch;
    try{prev.offUtxos?.();}catch{}
    try{prev.offDisconnect?.();}catch{}
    const offUtxos=rpc.on('utxos',({added=[],removed=[]}={})=>{
      if(activeWatch.rpc!==rpc||watchedCid!==cid)return;
      if(activeWatch.mode==='manager'){
        const hit=removed.some(e=>outpointFromEntry(e)===activeWatch.tipKey||e?.address===activeWatch.address);
        if(hit)wakeWatchedRound(cid,activeWatch.tipKey??activeWatch.address);
      }else if(activeWatch.mode==='genesis'){
        const hit=added.some(e=>e?.address===activeWatch.address||!e?.address);
        if(hit)wakeWatchedRound(cid,`genesis:${activeWatch.address}`);
      }
    });
    const offDisconnect=rpc.on('disconnect',()=>{
      if(activeWatch.rpc===rpc)teardownWatch({unsubscribe:false});
    });
    try{
      await rpc.subscribe([targetAddr],true);
    }catch{
      try{offUtxos?.();}catch{}
      try{offDisconnect?.();}catch{}
      if(prev.rpc===rpc&&prev.address)void prev.rpc.subscribe([prev.address],false).catch(()=>{});
      activeWatch={rpc:null,address:null,tipKey:null,mode:null,pendingWake:false,offUtxos:null,offDisconnect:null};
      c.watchedAddress=null;
      return;
    }
    if(seq!==watchSeq||watchedCid!==cid||c.rpc!==rpc){
      try{offUtxos?.();}catch{}
      try{offDisconnect?.();}catch{}
      void rpc.subscribe([targetAddr],false).catch(()=>{});
      if(prev.rpc===rpc&&prev.address&&prev.address!==targetAddr)void prev.rpc.subscribe([prev.address],false).catch(()=>{});
      activeWatch={rpc:null,address:null,tipKey:null,mode:null,pendingWake:false,offUtxos:null,offDisconnect:null};
      c.watchedAddress=null;
      return;
    }
    activeWatch={rpc,address:targetAddr,tipKey:targetTipKey,mode,pendingWake:false,offUtxos,offDisconnect};
    c.watchedAddress=targetAddr;
    if(prev.rpc===rpc&&prev.address&&prev.address!==targetAddr){
      void prev.rpc.subscribe([prev.address],false).catch(()=>{});
    }
    // KCI subscribe-first gap check: verify the manager UTXO is still live AFTER the subscription took effect.
    if(mode==='manager'&&!cur.round.intent&&c.prepared?.cid!==cid&&!c.busy){
      try{
        await liveRound(rpc,cur.round,profile,{targets:[]});
      }catch(e){
        if(codeOf(e)==='STALE_INPUT'&&watchedCid===cid&&c.rpc===rpc&&activeWatch.address===targetAddr){
          wakeWatchedRound(cid,targetTipKey??targetAddr,20);
        }
      }
    }
  };
  const scheduleWatchSync=()=>{
    const seq=++watchSeq;
    watchQueue=watchQueue.catch(()=>{}).then(()=>applyWatch(seq));
    return watchQueue;
  };
  const emit=()=>{if(watchedCid)void scheduleWatchSync();for(const f of listeners)try{f();}catch{}};
  const log=(kind,text)=>{c.logs.push({at:now(),kind,text});if(c.logs.length>200)c.logs.shift();emit();};
  // All operations that touch round records remain single-writer. Background reconciliation/verification does not mark the UI busy;
  // a user operation reserves busy immediately and runs after the active job, ahead of queued background jobs.
  const jobs=[],reads=new Map();let running=false;
  const drain=async()=>{
    if(running)return;running=true;
    try {while(jobs.length) {
      const foreground=jobs.findIndex(j=>!j.background),job=jobs.splice(foreground<0?0:foreground,1)[0];
      try{job.resolve(await job.fn());}
      catch(e){log('error',`${job.label}失败：${codeOf(e)}${e?.message&&e.message!==codeOf(e)&&!/key|secret|private/i.test(e.message)?` — ${String(e.message).slice(0,160)}`:''}`);job.reject(e);}
      finally{if(!job.background){c.busy=false;c.busyLabel=null;}emit();}
    }} finally{running=false;}
  };
  const guard=async(label,fn,{readKey=null}={})=>{
    if(readKey&&reads.has(readKey))return reads.get(readKey);
    const background=readKey!==null;
    if(!background){check(!c.busy,'BUSY');c.busy=true;c.busyLabel=label;}
    const promise=new Promise((resolve,reject)=>jobs.push({label,fn,background,resolve,reject}));
    if(readKey){reads.set(readKey,promise);const clear=()=>reads.delete(readKey);promise.then(clear,clear);}
    if(!background)emit(); // render the disabled state before the first await, including when waiting for a background job
    void drain();return promise;
  };
  const need=(v,code)=>{check(v,code);return v;};
  let walletEpoch=0,nodeEpoch=0,indexerEpoch=0;
  const walletValid=(wallet,epoch)=>c.wallet===wallet&&!wallet.closed&&walletEpoch===epoch;
  const replaceWallet=wallet=>{const old=c.wallet;walletEpoch++;c.prepared=null;c.wallet=wallet;old?.close();emit();};
  const indexReads=new Map(),indexChecks=new Map();
  const indexRead=(key,fn)=>{if(indexReads.has(key))return indexReads.get(key);const promise=Promise.resolve().then(fn);indexReads.set(key,promise);const done=()=>indexReads.delete(key);promise.then(done,done);return promise;};
  async function mutate(cid,fn) {
    const cur=need(await roundStore.get(cid),'ROUND_NOT_FOUND'),next=await fn(structuredClone(cur.round));
    if(next===null){await roundStore.remove(cid,cur.revision);return null;}
    return {round:next,revision:(await roundStore.replace(next,cur.revision)).revision};
  }
  async function setIntentStatus(cid,intent,status) {
    if(status==='UNSENT') { // never handed to the transport: safe to drop; the next prepare starts from scratch
      await mutate(cid,r=>(r.step===0&&!r.manager)?null:{...r,intent:null});return;}
    await mutate(cid,r=>({...r,intent:{...r.intent,status,errorCode:intent.errorCode??null,nodeError:intent.nodeError??null}}));
  }
  /** One pass over a round's candidates: promote (>=100 DAA deep), follow a reorg, or halt the round when one was lost. */
  async function recheckPending(cid) {
    const out={finalized:0,reaccepted:0,waiting:0};
    let cur=need(await roundStore.get(cid),'ROUND_NOT_FOUND'),nextRound=cur.round,dirty=false;
    const flush=async()=>{if(dirty){dirty=false;cur={round:nextRound,revision:(await roundStore.replace(nextRound,cur.revision)).revision};}};
    try{
      for(const entry of structuredClone(cur.round.pending??[])) {
        let res;
        try{res=await recheckCandidate(c.rpc,entry,profile,{now:now(),network:net.networkId});}
        catch(e) {
          if(codeOf(e)==='CANDIDATE_DROPPED'){nextRound={...nextRound,halted:'CANDIDATE_DROPPED'};dirty=true;await flush();log('error',`候选交易 ${entry.txid} 既未被接受也不在内存池：轮次已停止，请人工核对`);}
          throw e;
        }
        if(res.status==='FINAL') {nextRound=settleCandidate(nextRound,entry.txid,{depth:res.depth});dirty=true;out.finalized++;log('info',`已接受并复核（深度 ${res.depth}≥100）：${entry.txid}`);}
        else if(res.status==='REACCEPTED') {nextRound=moveCandidate(nextRound,entry.txid,res);dirty=true;out.reaccepted++;log('warn',`选中链浅层重组：${entry.txid} 在新的块被重新接受（DAA ${res.acceptingDaa}）`);}
        else if(res.status==='LIMBO') {
          out.waiting++;
          if(entry.limboSince==null){nextRound={...nextRound,pending:nextRound.pending.map(p=>p.txid===entry.txid?{...p,limboSince:res.limboSince}:p)};dirty=true;}
        } else out.waiting++;
      }
    }finally{await flush();}
    return out;
  }
  api={
    state:c,onChange:f=>{listeners.add(f);return()=>listeners.delete(f);},
    isSyncing:cid=>activeRoundSyncs.has(cid),
    log,
    watchRound(cid=null) {
      const next=typeof cid==='string'&&/^[0-9a-f]{64}$/.test(cid)?cid:null;
      if(watchedCid!==next){watchedCid=next;wakeRetries.clear();}
      return scheduleWatchSync();
    },
    async connectNode(urls) {
      const epoch=++nodeEpoch;
      try {
        const rpc=await connect(urls,{net});
        if(epoch!==nodeEpoch){rpc?.close?.();return;}
        indexChecks.clear();const old=c.rpc;c.rpc=rpc;old?.close?.();
        log('info',`已连接 ${c.rpc.url}（${net.networkId}，已同步，UTXO 索引可用）`);
      } catch(e) {
        log('error',`连接节点失败：${codeOf(e)}${e?.message&&e.message!==codeOf(e)?` — ${String(e.message).slice(0,160)}`:''}`);throw e;
      }
    },
    async restoreDiscovery() {
      const stored=await roundStore.readDiscovery?.().catch(()=>null);
      if(c.discoveredSource==='indexer'||c.discoveredSource==='rest')return c.discovered;
      let fallback=null;
      if(discoveryCache?.read){try{fallback=discoveryCache.read();}catch{}}
      const best=stored?.rounds?.length&&fallback?.rounds?.length
        ?((stored.savedAt??0)>=(fallback.savedAt??0)?stored:fallback)
        :(stored?.rounds?.length?stored:fallback);
      if(applyCachedDiscovery(best))emit();
      return c.discovered;
    },
    async checkIndexer(base) {
      const epoch=++indexerEpoch;
      if(!String(base).trim()){indexChecks.clear();c.indexer=null;c.indexerInfo=null;c.indexerCursor=null;c.discoveredSource=c.discovered.length?'cache':null;emit();return null;}
      const client=createIndexerClient({baseUrl:base,fetchImpl:fetcher,networkId:net.networkId,genesisHash:net.genesis,profileId:profile.id});
      try {
        const infoPromise=client.info(),roundsPromise=client.rounds();
        const info=await infoPromise;
        if(epoch!==indexerEpoch)return info;
        indexChecks.clear();c.indexer=client;c.indexerInfo=info;emit();
        const page=await roundsPromise;
        if(epoch!==indexerEpoch)return info;
        const rounds=persistDiscovery(page.rounds,'indexer',client.base);
        c.indexerCursor=page.nextCursor;c.discovered=rounds;c.discoveredSource='indexer';c.discoveredCachedAt=null;
        log('info',`Rolling 索引已连接：${client.base}（只读发现，状态由当前节点核对）`);emit();return info;
      } catch(e) {
        if(epoch===indexerEpoch){
          if(c.indexer===client){c.indexer=null;c.indexerInfo=null;}
          if(c.discovered.length&&!c.discoveredSource)c.discoveredSource='cache';
        }
        log('error',`连接索引失败：${codeOf(e)}${e?.message&&e.message!==codeOf(e)?` — ${String(e.message).slice(0,160)}`:''}`);throw e;
      }
    },
    async refreshIndex() {return indexRead('list',async()=>{
      const client=c.indexer;
      if(client){
        try{
          const [info,page]=await Promise.all([c.indexerInfo?Promise.resolve(c.indexerInfo):client.info(),client.rounds()]);
          return await guard('更新索引列表',async()=>{check(c.indexer===client,'INDEXER_CONNECTION_CHANGED');const rounds=persistDiscovery(page.rounds,'indexer',client.base);c.indexerInfo=info;c.indexerCursor=page.nextCursor;c.discovered=rounds;c.discoveredSource='indexer';c.discoveredCachedAt=null;emit();return page;},{readKey:'indexer:list:apply'});
        }catch(e){
          if(c.indexer===client)c.indexerInfo={...c.indexerInfo,stale:true};
          try{
            const restPage=await discoverRestRollingRounds({net,cursor:0,fetcher,profile});
            return await guard('更新 REST 备选列表',async()=>{const rounds=persistDiscovery(restPage.rounds,'rest','',{temporaryFallback:true});c.indexerCursor=restPage.nextCursor;c.discovered=rounds;c.discoveredSource='rest';c.discoveredCachedAt=null;emit();return {...restPage,fallbackFrom:codeOf(e)};},{readKey:'indexer:list:rest'});
          }catch{
            if(c.indexer===client){c.indexerCursor=null;c.discoveredSource=c.discovered.length?'cache':null;emit();}
            throw e;
          }
        }
      }
      let restPage;
      try{restPage=await discoverRestRollingRounds({net,cursor:0,fetcher,profile});}
      catch(e){c.indexerCursor=null;c.discoveredSource=c.discovered.length?'cache':null;emit();throw e;}
      return guard('更新 REST 列表',async()=>{if(c.indexer)return {skipped:'INDEXER_CONNECTED'};const rounds=persistDiscovery(restPage.rounds,'rest','');c.indexerCursor=restPage.nextCursor;c.discovered=rounds;c.discoveredSource='rest';c.discoveredCachedAt=null;emit();return restPage;},{readKey:'indexer:list:rest'});
    });},
    async moreIndex() {return indexRead('more',async()=>{
      const cursor=c.indexerCursor;if(cursor===null)return {done:true};
      if(c.discoveredSource==='rest'||!c.indexer){
        const page=await discoverRestRollingRounds({net,cursor,fetcher,profile});
        return guard('补充 REST 列表',async()=>{
          check(c.indexerCursor===cursor,'INDEXER_CONNECTION_CHANGED');
          const byId=new Map([...c.discovered,...page.rounds].map(r=>[r.cid,r]));check(byId.size<=500,'INDEXER_DISCOVERY_LIMIT');
          c.discovered=persistDiscovery([...byId.values()],'rest','',{temporaryFallback:!!c.indexer});c.indexerCursor=page.nextCursor;c.discoveredSource='rest';c.discoveredCachedAt=null;emit();return page;
        },{readKey:'indexer:more:rest'});
      }
      const client=need(c.indexer,'INDEXER_REQUIRED');
      const page=await client.rounds({cursor});
      return guard('补充索引列表',async()=>{
        check(c.indexer===client&&c.indexerCursor===cursor,'INDEXER_CONNECTION_CHANGED');
        const byId=new Map([...c.discovered,...page.rounds].map(r=>[r.cid,r]));check(byId.size<=500,'INDEXER_DISCOVERY_LIMIT');
        c.discovered=persistDiscovery([...byId.values()],'indexer',client.base);c.indexerCursor=page.nextCursor;c.discoveredCachedAt=null;emit();return page;
      },{readKey:'indexer:more:apply'});
    });},
    async cachedPreview(cid) {
      if(typeof cid!=='string'||!/^[0-9a-f]{64}$/.test(cid))return null;
      const text=await roundStore.getPreview?.(cid).catch(()=>null);
      if(typeof text!=='string')return null;
      try{
        const r=roundFromText(text,profile,{network:net.networkId});
        return r.cid===cid&&!r.intent&&!r.pending?.length?r:null;
      }catch{return null;}
    },
    async loadPreview(cid) {
      if(typeof cid!=='string'||!/^[0-9a-f]{64}$/.test(cid))return null;
      const local=await roundStore.get(cid).catch(()=>null);
      if(local?.round)return null;
      const cached=await api.cachedPreview(cid);
      const client=c.indexer;
      if(client){
        try{
          const canDelta=!!(cached&&!cached.pending?.length&&cached.receipts?.length>0&&cached.receipts.length===cached.step&&/^[0-9a-f]{64}$/.test(cached.receipts.at(-1)?.txid??''));
          let doc=canDelta
            ?await client.exportRound(cid,{sinceTxid:cached.receipts.at(-1).txid,sinceStep:cached.receipts.length})
            :await client.exportRound(cid);
          if((doc.mode==='unchanged'||doc.mode==='ahead')&&cached)return cached;
          let fresh;
          if(doc.mode==='delta'){
            try{fresh=materializeIndexedDocument(doc,profile,{baseRound:cached,network:net.networkId}).round;}
            catch(e){
              const code=e?.code??e?.safeCode??e?.message??'';
              if(code.startsWith('DELTA_')){
                doc=await client.exportRound(cid);
                fresh=roundFromText(doc.roundText,profile,{network:net.networkId});
              }else throw e;
            }
          }else{
            fresh=roundFromText(doc.roundText,profile,{network:net.networkId});
          }
          if(fresh.cid===cid&&!fresh.intent&&!fresh.pending?.length){
            void roundStore.savePreview?.(cid,doc.mode==='delta'?roundToText(fresh):doc.roundText);
            return fresh;
          }
        }catch{}
      }
      return cached;
    },
    async syncRound(input,{lookup=false,allowHalted=false,force=true,timeBudgetMs=null,skipIndexer=false,preferRest=false}={}) {return indexRead(`round:${input}`,async()=>{
      activeRoundSyncs.add(input);
      try{
      const rpc=need(c.rpc,'NODE_REQUIRED');need(roundStore.persistent,'DURABLE_STORE_REQUIRED');
      const initial=await roundStore.get(input);
      if(initial?.round.terminal)return {cid:initial.round.cid,unchanged:true,source:'local',steps:0,terminal:initial.round.terminal};
      if(c.prepared?.cid===input||initial&&(initial.round.intent||(!allowHalted&&initial.round.halted)))return {cid:input,skipped:'LOCAL_PENDING'};
      const client=c.indexer;
      const markSynced=r=>{
        c.lastSynced={cid:r.cid,nodeUrl:rpc.url??'',managerOutpoint:r.manager?`${r.manager.outpoint.transactionId}:${r.manager.outpoint.index}`:'-',step:r.step,frozen:r.frozen.length,at:now()};
      };
      if(!force&&client&&initial){
        const cached=indexChecks.get(initial.round.cid);
        if(cached?.client===client&&cached.rpc===rpc&&cached.localRevision===initial.revision&&now()-cached.checkedAt<15000){
          try{await liveRound(rpc,initial.round,profile,{targets:initial.round.frozen});markSynced(initial.round);return {cid:initial.round.cid,unchanged:true,source:'cache',steps:0,terminal:initial.round.terminal};}catch{}
        }
      }
      const sigOf=r=>`${r.cid}|${r.step}|${r.terminal??''}|${r.manager?.outpoint?.transactionId??'-'}:${r.manager?.outpoint?.index??-1}|${r.receipts?.length??0}`;
      let expectedRev=initial?.revision??null,lastSavedSig='',progressChain=Promise.resolve();
      const onProgress=async snap=>{
        progressChain=progressChain.then(async()=>{
          if(c.rpc!==rpc||c.busy||c.prepared?.cid===snap.cid)return;
          await guard('保存同步进度',async()=>{
            if(c.rpc!==rpc||c.busy||c.prepared?.cid===snap.cid)return;
            const current=await roundStore.get(snap.cid);
            if(current?.round.intent||(!allowHalted&&current?.round.halted))return;
            if((current?.revision??null)!==expectedRev)return;
            const round={...snap,source:current?.round.source??snap.source};
            validateRound(round,profile,{network:net.networkId});
            const saved=current?await roundStore.replace(round,current.revision):await roundStore.create(round);
            expectedRev=saved.revision;
            lastSavedSig=sigOf(round);
            void roundStore.removePreview?.(snap.cid);
            if(c.lastSynced?.cid===snap.cid)c.lastSynced=null;
          },{readKey:`sync:round:${snap.cid}:progress`});
        }).catch(()=>{});
        return progressChain;
      };
      const onSummary=d=>{
        const sum=d?.summary;if(!sum||typeof d.cid!=='string')return;
        const entry={cid:d.cid,terminal:d.terminal??null,module:sum.module??null,tickets:Number(sum.tickets??0),shards:Number(sum.shards??0),
          bought:Number(sum.bought??sum.tickets??0),buys:Number(sum.buys??0),managerValue:d.manager?.value!=null?String(d.manager.value):null,
          acceptingDaa:d.head?.acceptingDaa!=null?String(d.head.acceptingDaa):null,updatedAt:Date.now(),source:'indexer'};
        const idx=c.discovered.findIndex(x=>x.cid===d.cid);
        c.discovered=idx>=0?c.discovered.map((x,i)=>i===idx?{...x,...entry}:x):[entry,...c.discovered];
        emit();
      };
      const preview=!initial&&/^[0-9a-f]{64}$/.test(input)?await api.cachedPreview(input):null;
      const synced=await syncRoundThreeTier({
        cid:initial?input:(lookup?null:input),round:initial?.round??null,preview,lookupInput:lookup?input:null,rpc,indexer:client,profile,net,fetcher,timeBudgetMs,skipIndexer,preferRest,onProgress,onSummary,
      });
      await progressChain;
      if(synced.indexerError&&!skipIndexer)log('warn',`索引跨越未生效（${synced.indexerError}），改为节点核对追赶`);
      const cid=synced.round.cid;
      const cur=initial&&initial.round.cid===cid&&expectedRev===initial.revision&&!synced.caughtUp?initial:await roundStore.get(cid);
      if(c.prepared?.cid===cid||cur&&(cur.round.intent||(!allowHalted&&cur.round.halted)))return {cid,skipped:'LOCAL_PENDING'};
      if(cur&&expectedRev===(initial?.revision??null)&&cur.round.step===synced.round.step&&cur.round.terminal===synced.round.terminal&&cur.round.manager?.outpoint?.transactionId===synced.round.manager?.outpoint?.transactionId&&!synced.caughtUp){
        if(client&&synced.round.indexer?.headTxid)indexChecks.set(cid,{client,rpc,localRevision:cur.revision,headTxid:synced.round.indexer.headTxid,acceptingBlock:synced.round.indexer.acceptingBlock,revision:String(synced.round.indexer.revision??''),checkedAt:now()});
        markSynced(cur.round);
        return {cid,unchanged:true,source:synced.source,steps:0,terminal:synced.round.terminal};
      }
      // If onProgress just validated & persisted this exact snapshot (e.g. Indexer seed before timeBudgetMs exit), avoid a duplicate 10MB validate+IDB write.
      if(cur&&lastSavedSig&&lastSavedSig===sigOf(synced.round)){
        if(synced.partial||synced.source==='rest'){
          if(c.lastSynced?.cid===cid)c.lastSynced=null;
        }else{
          markSynced(cur.round);
          if(client&&cur.round.indexer?.headTxid)indexChecks.set(cid,{client,rpc,localRevision:cur.revision,headTxid:cur.round.indexer.headTxid,acceptingBlock:cur.round.indexer.acceptingBlock,revision:String(cur.round.indexer.revision??''),checkedAt:now()});
        }
        if(synced.steps>0)log('info',`轮次 ${cid.slice(0,16)}… 已自动追赶 ${synced.steps} 步最新链上状态（来源：${synced.source}）`);
        else log('info',`已核对并同步轮次 ${cid.slice(0,16)}…（来源：${synced.source}）`);
        return {cid,source:synced.source,caughtUp:synced.caughtUp,steps:synced.steps,terminal:cur.round.terminal,partial:!!synced.partial};
      }
      // Fetch and catch-up run outside the write queue. Re-read under the queue before saving, so slow queries never block preparation
      // and never overwrite a transaction/candidate created while the read was in flight.
      return guard('保存同步轮次',async()=>{
        check(c.rpc===rpc,'INDEXER_CONNECTION_CHANGED');const current=await roundStore.get(cid);
        if(c.prepared?.cid===cid||current?.round.intent||(!allowHalted&&current?.round.halted))return {cid,skipped:'LOCAL_PENDING'};
        if((current?.revision??null)!==expectedRev)return {cid,skipped:'LOCAL_CHANGED'};
        const round={...synced.round,source:current?.round.source??synced.round.source};
        validateRound(round,profile,{network:net.networkId});
        const saved=current?await roundStore.replace(round,current.revision):await roundStore.create(round);
        void roundStore.removePreview?.(cid);
        if(synced.partial||synced.source==='rest'){
          if(c.lastSynced?.cid===cid)c.lastSynced=null;
        }else{
          markSynced(round);
          if(client&&round.indexer?.headTxid)indexChecks.set(cid,{client,rpc,localRevision:saved.revision,headTxid:round.indexer.headTxid,acceptingBlock:round.indexer.acceptingBlock,revision:String(round.indexer.revision??''),checkedAt:now()});
        }
        if(synced.steps>0)log('info',`轮次 ${cid.slice(0,16)}… 已自动追赶 ${synced.steps} 步最新链上状态（来源：${synced.source}）`);
        else log('info',`已核对并同步轮次 ${cid.slice(0,16)}…（来源：${synced.source}）`);
        return {cid,source:synced.source,caughtUp:synced.caughtUp,steps:synced.steps,terminal:round.terminal,partial:!!synced.partial};
      },{readKey:`sync:round:${input}:apply`});
      }finally{activeRoundSyncs.delete(input);if(watchedCid===input)void scheduleWatchSync();}
    });},
    syncIndexedRound(input,opts) {return this.syncRound(input,opts);},
    openWallet(keyText) {check(net.key!=='mainnet','MAINNET_MEMORY_KEY_DISABLED');replaceWallet(null);replaceWallet(openMemoryWallet(keyText,{prefix:net.addressPrefix}));log('info',`内存钱包已连接：${c.wallet.address}`);return c.wallet.address;},
    usePublicAddress(address) {replaceWallet(null);replaceWallet(publicRecipient(address,{prefix:net.addressPrefix}));log('info',`使用公开收款地址（免签动作）：${c.wallet.address}`);return c.wallet.address;},
    async connectExternalWallet(id,opts={}) {return guard('连接钱包',async()=>{
      let wallet;
      const onInvalidate=()=>{
        if(c.wallet!==wallet)return;replaceWallet(null);log('warn','外部钱包账户或网络已变化，连接与未发送报价已撤销，请重新连接。');
      };
      wallet=id==='kaspire'
        ?await openKaspireWallet({...opts,net,onInvalidate,onLog:msg=>log('info',msg)})
        :await openExtensionWallet(id,{globals:opts.globals??globalThis,net,onInvalidate});
      check(!wallet.closed,'WALLET_CHANGED');replaceWallet(wallet);
      log('info',`${wallet.name} 已连接：${wallet.address}（${net.networkId}）`);return wallet.address;
    });},
    disconnectWallet({keepSession=false}={}) {const old=c.wallet;replaceWallet(null);if(!keepSession)old?.disconnectSession?.().catch(()=>{});if(old)log('info','钱包已断开，未发送报价已撤销');},
    async rounds() {return (await roundStore.list()).map(x=>x.round).sort((a,b)=>a.cid<b.cid?-1:1);},
    async describe(cid) {
      const cur=need(await roundStore.get(cid),'ROUND_NOT_FOUND'),r=cur.round;
      const daa=c.rpc?await c.rpc.currentDaa().catch(()=>null):null;
      return {round:r,facts:describeRound(r,profile,daa??undefined),actions:availableActions(r,profile,daa??r.manager?.currentDaa??0n),daa};
    },
    /** choice: {action, quantity?:string|number, settings?:{ticketPrice:'1',ticketCap,minTickets,closeMinutes}} */
    async prepare(choice,cid=null) {return guard('准备交易',async()=>{
      need(c.rpc,'NODE_REQUIRED');need(c.wallet,'WALLET_REQUIRED');
      need(roundStore.persistent,'DURABLE_STORE_REQUIRED');
      const wallet=c.wallet,epoch=walletEpoch;
      if(FUNDED.has(choice.action))check(wallet.kind==='key'||wallet.kind==='extension','WALLET_KEY_REQUIRED');
      let round=null,op={...choice};
      if(choice.action==='GENESIS') {
        const st=choice.settings,daa=await c.rpc.currentDaa();
        op.settings={ticketPrice:parseTkas(String(st.ticketPrice)),ticketCap:Number(st.ticketCap),minTickets:Number(st.minTickets),
          closeEligibleDaa:daa+parseUint(String(st.closeMinutes))*600n};
        check(Number.isSafeInteger(op.settings.ticketCap)&&Number.isSafeInteger(op.settings.minTickets),'SETTINGS');
      } else {
        round=need((await roundStore.get(need(cid,'ROUND_REQUIRED')))?.round,'ROUND_NOT_FOUND');
        check(!round.intent,'INTENT_UNRESOLVED_REPLACEMENT_BLOCKED');
        check(!round.terminal,'ROUND_TERMINAL');
        check(!round.halted,'ROUND_HALTED');
        if(choice.action==='BUY'){const q=Number(choice.quantity);check(Number.isSafeInteger(q)&&q>=1,'QUANTITY');op.quantity=q;}
      }
      const [reserved,feerate]=await Promise.all([roundStore.reserved(),nodeFeeRate(c.rpc)]);
      // Zero-depth chaining: the node's UTXO view can lag the accepting block for a moment. Only when this round has unverified
      // candidates, wait briefly (never build on guesses); everything else fails immediately.
      const lag=(round?.pending?.length??0)>0;let prepared;
      for(let attempt=0;;attempt++) {
        try{prepared=await prepareOperation({rpc:c.rpc,profile,round,choice:op,wallet,feerate,reserved,net});break;}
        catch(e){
          if(codeOf(e)==='STALE_INPUT'&&round&&(!lag||attempt>=40))log('warn','本地 round state 可能已过期（他人已在这一轮操作过）：请导入最新的 round state 后再试');
          if(!lag||attempt>=40||codeOf(e)!=='STALE_INPUT')throw e;await sleep(500);}
      }
      check(walletValid(wallet,epoch),'WALLET_CHANGED');
      c.prepared={...prepared,walletAddress:wallet.address,walletEpoch:epoch,preparedAt:now(),settings:op.settings??null,cid:prepared.roundCid};
      log('info',`草案已生成：${prepared.review.txid}（手续费 ${prepared.fee} sompi，费率 ${feerate} sompi/克）。请复核后再签名发送。`);
      return c.prepared;});},
    discardPrepared() {c.prepared=null;emit();},
    /** Sign -> signed-engine check -> PERSIST intent -> send. Returns the stored intent status. */
    async signAndSend({onSigned=()=>{}}={}) {return guard('签名并发送',async()=>{
      const p=need(c.prepared,'NOTHING_PREPARED');need(c.rpc,'NODE_REQUIRED');need(roundStore.persistent,'DURABLE_STORE_REQUIRED');
      const wallet=c.wallet,epoch=walletEpoch;
      need(wallet&&wallet.address===p.walletAddress&&walletValid(wallet,epoch)&&p.walletEpoch===epoch,'WALLET_REQUIRED');
      log('info',`正在请求 ${wallet.name??'钱包'} 签名 ${p.op.action}…`);
      const intent=await signAndRecord({rpc:c.rpc,profile,prepared:p,wallet,net,onSigned:()=>{c.prepared=null;log('info','钱包已返回签名并完成本地验签，正在读取链上游标…');onSigned();}});
      check(walletValid(wallet,epoch),'WALLET_CHANGED');
      c.prepared=null;
      // Durable BEFORE send: from here an unknown outcome can only be reconciled, never replaced.
      if(intent.action==='GENESIS') {
        const r=emptyRound({cid:p.cid,origin:p.draft.origin,settings:p.settings,network:net.networkId});r.intent=intent;validateRound(r,profile,{network:net.networkId});await roundStore.create(r);
      } else await mutate(p.cid,r=>{check(!r.intent&&r.manager,'INTENT_UNRESOLVED_REPLACEMENT_BLOCKED');
        check(`${r.manager.outpoint.transactionId}:${r.manager.outpoint.index}`===`${intent.draft.inputUtxos[0].outpoint.transactionId}:${intent.draft.inputUtxos[0].outpoint.index}`,'INTENT_MANAGER');
        r.intent=intent;return r;});
      log('info',`意图已持久化：${intent.txid}；正在提交…`);
      let status;
      try {await submitIntent(c.rpc,intent,profile,{beforeSend:()=>check(walletValid(wallet,epoch),'WALLET_CHANGED'),network:net.networkId});status='SUBMITTED';log('info',`已提交 ${intent.txid}（首次被选中链接受即为候选，可继续下一步；满 100 DAA 复核后才算已接受）`);}
      catch(e) {status=statusAfterFailure(e);log('error',`提交${status==='UNSENT'?'未发出':status==='REJECTED'?'被节点拒绝':'结果未知'}：${codeOf(e)}（状态 ${status}）`);
        if(status==='REJECTED') {
          intent.nodeError=String(e.message).slice(0,600); // the full text of a mempool conflict is ~290 chars; classifyRejection needs both outpoint and spender
          const k=classifyRejection(intent);
          if(k.kind==='FUNDS_INPUT')log('warn',`钱包的资金输入 ${k.outpoint.slice(0,12)}… 已被节点内存池里的另一笔交易 ${k.spender.slice(0,12)}… 占用（同一个钱包在别处的未确认操作）；这笔没有被节点收下`);
          else if(k.kind==='ROUND_INPUT')log('warn',`这一轮的合约输出已被另一笔未确认交易 ${k.spender.slice(0,12)}… 占用（别人先操作了这一轮）；这笔没有被节点收下`);
          else if(k.kind==='ORPHAN')log('warn','节点找不到这笔交易依赖的上一笔交易（尚未传到该节点）；这笔没有被节点收下');
        }
        intent.errorCode=codeOf(e);}
      await setIntentStatus(p.cid,intent,status);
      return status;});},
    /** One reconciliation pass: settle the pending intent (first acceptance = candidate, the round advances), then re-verify candidates.
     * recover=true may resend the SAME signed bytes (after live-input verification). */
    async track(cid,{recover=false}={}) {return guard(recover?'恢复':'查询接受状态',async()=>{
      need(c.rpc,'NODE_REQUIRED');let cur=need(await roundStore.get(cid),'ROUND_NOT_FOUND');
      need(cur.round.intent||cur.round.pending?.length,'NO_PENDING_INTENT');
      let result={accepted:false};
      if(cur.round.intent) {
        const intent=structuredClone(cur.round.intent);
        const res=await checkAcceptance(c.rpc,intent,profile,{recover,network:net.networkId,checkpoint:async i=>{
          const next={...cur.round,intent:{...cur.round.intent,cursor:i.cursor}};
          cur={round:next,revision:(await roundStore.replace(next,cur.revision)).revision};}});
        if(res.accepted||res.candidate) {
          const next=advanceRound(cur.round,cur.round.intent,res,profile);await roundStore.replace(next,cur.revision);
          log('info',res.accepted?`已接受并复核（接受 DAA ${res.acceptingDaa}，深度≥100）：${res.txid}`:`首次被选中链接受（DAA ${res.acceptingDaa}，深度 ${res.depth}）：${res.txid} —— 已作为候选推进，可继续下一步；满 100 DAA 后复核`);
          result={accepted:res.accepted,candidate:!!res.candidate,receipt:res};
        } else {
          if(res.resubmitted)await mutate(cid,r=>({...r,intent:{...r.intent,status:'SUBMITTED'}}));
          if(res.inputsGone&&!res.accepting)log('warn','输入已不在 UTXO 集且未见接受：可能被其他交易花费。若超过 3 分钟仍如此且不在内存池，可“放弃”本意图并导入最新的 round state（不会自动新建交易）');
          return {accepted:false,...res};
        }
      }
      const pend=await recheckPending(cid);
      return {...result,accepted:result.accepted||pend.finalized>0,pending:pend};},{readKey:recover?null:`track:${cid}`});},
    /** Drop an intent that provably has no chance. Required, in this order: every input is either the identical live UTXO or GONE (read FIRST, so an input
     * that vanished before an empty acceptance search was not spent by us); a complete acceptance search from the intent's cursor finds nothing; the node's
     * mempool does not have it. UNSENT/REJECTED intents may be dropped like that. SUBMITTED/UNKNOWN/PREPARED intents (PREPARED = persisted but the page
     * went away before the status update, so it may or may not have been sent: the same unknown outcome as UNKNOWN) (e.g. the node took it but a competing buyer's
     * conflicting transaction won through another node) additionally need an input that is GONE (spent by another transaction) and LOST_GRACE_MS since
     * creation. A gone input means the local round state is out of date: re-import the latest state afterwards.
     * `force` (explicit user confirmation) covers one case only: the acceptance search can no longer be run (SEARCH_RANGE: the intent's cursor is older than
     * the node's search window) while EVERY input is GONE and the transaction is not in the mempool. No replacement can double-spend (all inputs are
     * gone and prepare() always re-reads live UTXOs); the only thing lost is the local record of whether our own transaction was the one that spent them. */
    async discard(cid,{force=false}={}) {return guard('放弃意图',async()=>{
      need(c.rpc,'NODE_REQUIRED');const cur=need(await roundStore.get(cid),'ROUND_NOT_FOUND'),i=need(cur.round.intent,'NO_PENDING_INTENT');
      const settled=['REJECTED','UNSENT'].includes(i.status);
      check(settled||['SUBMITTED','UNKNOWN','PREPARED'].includes(i.status),'DISCARD_NOT_ALLOWED');
      const probe=i.draft.inputUtxos.map(u=>({...u,daa:u.utxoDaa??u.daa})),states=await inputsState(c.rpc,probe);let gone=0;
      states.forEach(({utxo:u},n)=>{
        if(!u){gone++;return;}
        if(!sameInput(u,probe[n],{allowDaaDrift:true}))throw Object.assign(new Error('STALE_INPUT'),{code:'STALE_INPUT',safeCode:'STALE_INPUT'}); // present but different: never guess
      });
      let unprovable=false;
      try {
        const r=await checkAcceptance(c.rpc,structuredClone(i),profile,{recover:false,network:net.networkId});
        check(r.complete===true&&!r.transient&&!r.accepted&&!r.candidate,'INTENT_ACCEPTANCE_UNRESOLVED');
      } catch(e) {
        if(!(force&&codeOf(e)==='SEARCH_RANGE'&&gone===probe.length))throw e;
        unprovable=true;
      }
      check(!await mempoolEntry(c.rpc,i.txid),'INTENT_IN_MEMPOOL');
      if(!settled) {
        check(gone>0,'INTENT_INPUTS_STILL_LIVE'); // inputs intact: use recovery (resend the same bytes) instead
        check(now()-(i.createdAtMs??now())>=LOST_GRACE_MS,'INTENT_TOO_RECENT');
      }
      await mutate(cid,x=>(x.step===0&&!x.manager)?null:{...x,intent:null});
      if(unprovable)log('warn','已按你的确认强制放弃：所有输入都已被花掉，但节点无法再回溯查询这笔交易是否被接受。请导入最新的 round state。');
      else log(gone?'warn':'info',gone?'已放弃：有输入已被其他交易花费（他人抢先操作了同一个 manager），本地 round state 已过期。请导入最新的 round state（例如抢先者导出的）后再继续。':'已放弃被拒绝/未发送的意图');});},
    async verifyLive(cid) {return guard('核对链上状态',async()=>{
      need(c.rpc,'NODE_REQUIRED');const r=need((await roundStore.get(cid))?.round,'ROUND_NOT_FOUND');
      const live=await liveRound(c.rpc,r,profile,{targets:r.frozen});
      log('info',`链上核对通过：manager 与 ${live.targets.length} 个分片均为活跃且一致的 UTXO（阶段 ${live.state.module}）`);
      return {module:live.state.module,frozen:live.targets.length};},{readKey:`verify:${cid}`});},
    exportText(cid) {return (async()=>roundToText(cid&&typeof cid==='object'?cid:need((await roundStore.get(cid))?.round,'ROUND_NOT_FOUND')))();},
    /** Import = data only. Never authenticated until prepare() verifies the live UTXOs; a local pending intent is never overwritten. */
    async importText(text) {return guard('导入',async()=>{
      const r=roundFromText(text,profile,{network:net.networkId});
      if(r.intent)await authenticateIntent(r.intent,profile,{network:net.networkId});
      for(const p of r.pending??[])await authenticateIntent(p.intent,profile,{network:net.networkId});   // candidates are re-verified from this record later: authenticate them like the live intent
      const cur=await roundStore.get(r.cid);
      if(cur){check(!cur.round.intent||(r.intent&&cur.round.intent.wireDigest===r.intent.wireDigest),'IMPORT_WOULD_REPLACE_LOCAL_INTENT');await roundStore.replace(r,cur.revision);}
      else await roundStore.create(r);
      log('info',`已导入 round ${r.cid.slice(0,16)}…（未认证：准备交易前会核对链上 UTXO）`);return r.cid;});},
    close() {watchedCid=null;teardownWatch({unsubscribe:false});c.rpc?.close();replaceWallet(null);c.rpc=null;c.indexer=null;c.indexerInfo=null;c.indexerCursor=null;c.discovered=[];c.discoveredSource=null;indexChecks.clear();},
  };
  return api;
}
