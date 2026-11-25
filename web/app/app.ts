/** Browser entry for Kaswin (user-facing). Wiring only: all protocol behaviour lives in controller.mjs & ProtocolPlugin adapters,
 * all markup in views.ts. No console output; interpolated text is escaped by html``; the private key lives in the wallet closure,
 * its input is emptied as soon as it is read, and everything is wiped on disconnect / pagehide. */
import {DRAW_DELAY,TIMEOUT_DELAY} from '../../scripts/core.mjs';
import {protocolBundles,defaultCreateProfileId,defaultUiCreateId} from '@kaswin/protocol-bundles';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {
  buildProtocolRegistryFromBundles,
  connectNetwork,
  createIndexerClient,
  getAssetUtxos,
  kasAsset,
  makeController,
  matchBuyReceiptAuto,
  matchRefundReceiptAuto,
  openStore,
  pubkeyToAddress,
  readDrawProgress,
} from './bridge.ts';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';
import {getLocale,setLocale,resolveLocale,nextLocale} from '../ui/locales/index.ts';
import type {Locale} from '../ui/locales/index.ts';
import {parseNodeList} from './settings.ts';
import {deferPointerRender} from '../ui/interaction.ts';
import {availableExtensionWallets} from '../../scripts/wallet/extension-wallet.mjs';
import {isMobileBrowser,KASPIRE_WAKE_LINK,renderPairingQrDataUrl,triggerAppLink} from '../../scripts/wallet/kaspire-wallet.mjs';
import {indexerBase} from '../../scripts/round/indexer-client.mjs';
import {formatTkas,formatTkasFixed,shortHash} from '../ui/format.mjs';
import {TN10_PROFILE_ID} from '../../scripts/contract/protocol.mjs';
import {$,put,html,ic,toast,copyText,download,modal,closeModal,lockModal,initModal,modalOpen} from '../ui/ui.ts';
import {ACTION_INFO,actionTitle,errText,errCode,phaseOf} from '../ui/messages.ts';
import {exploreView,createView,roundView,roundToolsBody,mineView,helpBody,walletBody,settingsBody,confirmBody,parseCreate,qtyCost,qtyError,paintShardCanvases} from '../ui/views.ts';
import {drawReadiness} from '../ui/draw-readiness.ts';
import {pickRandomBuyShard,isShardUtxoConflict,shouldWarnShardCongestion} from './buy-shard.ts';
import type {Raw} from '../ui/ui.ts';
import {makeShare,parseShare} from './share.ts';
import type {
  ConfirmCtx,
  Conn,
  Controller,
  Ctx,
  Detail,
  DiscoveryCacheLike,
  DiscoveryCacheSnapshot,
  DrawProgress,
  DrawResult,
  Explorer,
  Facts,
  Gate,
  Hex,
  Holdings,
  Item,
  MineData,
  NetInfo,
  Prepared,
  Profile,
  ProtocolAdapterLike,
  ProtocolRegistryLike,
  Receipt,
  Round,
  RoundStoreLike,
  RpcLike,
  ShardRecordView,
  ShardView,
  SubmissionProgress,
  UiState,
  VerifyState,
  WalletView,
} from './types.ts';

const NET_KEY_STORAGE='kaswin-rolling:net';
const resolveInitialNet=(): NetInfo=>{
  const fallback=typeof __KASWIN_DEFAULT_NET__==='string'&&__KASWIN_DEFAULT_NET__==='tn10'?'tn10':'mainnet';
  let key=fallback;
  try{
    const q=new URLSearchParams(location.search).get('net');
    if(q==='mainnet'||q==='tn10'){key=q;localStorage.setItem(NET_KEY_STORAGE,q);}
    else{const saved=localStorage.getItem(NET_KEY_STORAGE);if(saved==='mainnet'||saved==='tn10')key=saved;}
  }catch{}
  return (key==='tn10'?TN10:MAINNET) as unknown as NetInfo;
};
const activeNet=resolveInitialNet();
const switchNetwork=()=>{
  const next=activeNet.key==='mainnet'?'tn10':'mainnet';
  try{localStorage.setItem(NET_KEY_STORAGE,next);}catch{}
  ctl?.disconnectWallet({keepSession:true});
  const url=new URL(location.href);url.searchParams.delete('net');
  if(url.href!==location.href)location.href=url.href;else location.reload();
};

const PREFIX=`kaswin-rolling-${activeNet.key}:`,ADDR_PREFIX=activeNet.addressPrefix,EX=activeNet.explorer,UNIT=activeNet.unit;
const LS={get<T>(k: string,d: T): T{try{const v=localStorage.getItem(PREFIX+k);return v==null?d:JSON.parse(v) as T;}catch{return d;}},set(k: string,v: unknown): void{try{localStorage.setItem(PREFIX+k,JSON.stringify(v));}catch{}}};
const DISCOVERY_LS_KEY=`discovered:${TN10_PROFILE_ID}`;
const discoveryCache: DiscoveryCacheLike={
  read:()=>LS.get<DiscoveryCacheSnapshot|null>(DISCOVERY_LS_KEY,null),
  write:(snap: DiscoveryCacheSnapshot)=>LS.set(DISCOVERY_LS_KEY,snap),
};
const LANG_KEY_STORAGE='kaswin-rolling:lang';
const resolveInitialLocale=(): Locale=>{
  try{
    const q=new URLSearchParams(location.search).get('lang');
    if(q){
      const picked=resolveLocale(q,[]);
      localStorage.setItem(LANG_KEY_STORAGE,picked.key);
      return picked;
    }
    const globalSaved=localStorage.getItem(LANG_KEY_STORAGE);
    if(globalSaved)return resolveLocale(globalSaved,[...navigator.languages]);
  }catch{}
  return resolveLocale(LS.get('language',null),[...navigator.languages]);
};
setLocale(resolveInitialLocale());
const L=(): Locale=>getLocale();
function applyShellLocale() {
  const loc=L(),ch=loc.chrome;
  document.documentElement.lang=loc.htmlLang;
  document.title=loc.meta.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content',activeNet.key==='mainnet'?loc.meta.descriptionMainnet:loc.meta.descriptionTn10);
  const brand=document.querySelector<HTMLElement>('.brand');
  if(brand)brand.setAttribute('aria-label',ch.brandAria);
  const nav=document.querySelector<HTMLElement>('.nav');
  if(nav)nav.setAttribute('aria-label',ch.navAria);
  const drawer=document.getElementById('menuDrawer');
  if(drawer)drawer.setAttribute('aria-label',ch.navAria);
  const navLabels: Record<string,string>={explore:ch.navExplore,create:ch.navCreate,mine:ch.navMine};
  document.querySelectorAll<HTMLElement>('.nav [data-go], .menu-drawer [data-go]').forEach(btn=>{
    const key=btn.dataset.go??'',span=btn.querySelector('span');
    if(span&&navLabels[key])span.textContent=navLabels[key];
  });
  const setAttr=(id: string,title: string,aria=title)=>{const el=document.getElementById(id);if(el){el.title=title;el.setAttribute('aria-label',aria);}};
  setAttr('nodeChip',ch.nodeStatusTitle);
  setAttr('githubBtn',ch.githubTitle);
  setAttr('settingsBtn',ch.settingsTitle);
  setAttr('menuBtn',ch.navAria);
  const menuSettings=document.querySelector<HTMLElement>('#menuSettingsBtn span');
  if(menuSettings)menuSettings.textContent=ch.settingsTitle;
  const footHelp=document.getElementById('footHelpBtn');if(footHelp)footHelp.textContent=ch.helpTitle;
  const mClose=document.getElementById('mClose');if(mClose)mClose.setAttribute('aria-label',ch.close);
}
applyShellLocale();
const overrideNode=activeNet.key==='mainnet'?__KASWIN_DEFAULT_MAINNET_NODE__:__KASWIN_DEFAULT_TN10_NODE__;
const overrideIndexer=activeNet.key==='mainnet'?__KASWIN_DEFAULT_MAINNET_INDEXER__:__KASWIN_DEFAULT_TN10_INDEXER__;
const defaultNode=overrideNode||activeNet.web.nodes.join('\n');
const defaultIndexer=overrideIndexer||activeNet.web.indexer;
const initialNodes=((): string=>{
  const saved=LS.get<string|null>('nodes',null);
  if(saved===null)return defaultNode;
  if(overrideNode&&saved===activeNet.web.nodes.join('\n'))return defaultNode;
  return saved;
})();
const initialIndexer=((): string=>{
  const saved=LS.get<string|null>('indexer',null);
  if(saved===null)return defaultIndexer;
  if(overrideIndexer&&saved.replace(/\/+$/,'')===activeNet.web.indexer.replace(/\/+$/,''))return defaultIndexer;
  // Migrate the previous Profile-qualified API on the same host; preserve explicitly configured hosts and empty opt-out.
  return saved.replace(/\/+$/,'').replace(`/rolling/v1/${TN10_PROFILE_ID}`,'');
})();
const ex: Explorer={
  tx:(id: string)=>`${EX}/transactions/${id}`,addr:(a: string)=>`${EX}/addresses/${a}`,block:(h: string)=>`${EX}/blocks/${h}`,
  addrOfKey:(k: string|null)=>k?pubkeyToAddress(k,ADDR_PREFIX):null,
  addrOfScript:(s: string)=>{const m=/^20([0-9a-f]{64})ac$/.exec(s);return m?pubkeyToAddress(m[1] as string,ADDR_PREFIX):shortHash(s,10,6);},
};
const S: UiState={view:'explore',cid:null,filter:'live',sort:'new',query:'',qty:'1',join:'',wtab:'extension',theme:LS.get('theme','dark'),shard:null,purchase:null,pixelMode:LS.get('pixelMode',false),liveSync:LS.get('liveSync',true),detailTab:'rules',txLimit:20,buyShard:'auto',
  form:{protocol:'',price:'1',cap:'100',min:'3',dur:'60',custom:'',customUnit:'m',registry:true,...LS.get<Partial<UiState['form']>>('form',{})},nodes:initialNodes,indexer:initialIndexer,walletProvider:LS.get('walletProvider','kasware')};
const conn: Conn={node:null,nodeUrl:null,indexer:null,indexerUrl:null,indexerStale:false,discoveredSource:null};
const verify=new Map<string,VerifyState>(),initialSyncDone=new Set<string>();
const buyShardConflicts=new Map<string,{count: number; avoided: Set<string>}>();
let lastPreparedBuy: {cid: string; shardCid: string|null; quantity: string; auto: boolean}|null=null;
let pendingCongestion: {cid: string; quantity: string}|null=null;
let savedCids=new Set<string>(LS.get<string[]>('saved',[]));
let checkProgress: string|null=null,roundTimer: ReturnType<typeof setInterval>|null=null,daaObservedAt=0;
let drawObservation: {rpc: RpcLike; key: string; value: DrawProgress}|null=null,drawReading=false,drawReadAt=0;
let protocols: ProtocolRegistryLike,primaryProfileId=TN10_PROFILE_ID,store: RoundStoreLike,ctl: Controller,items: Item[]=[],daa: bigint|null=null,balance: bigint|null=null,balanceAt=0,renderQueued=false,lastBusy=false,lastHtml='',lastCanvasKey='',refreshSeq=0,daaPolling=false,lastRounds: Round[]=[],settingsOpened={nodes:'',indexer:''};
let shardCache: {key: string;shards: ShardView[]|null}={key:'',shards:null};
const itemCache=new Map<string,{fp: string;item: Item}>();
const drawCache=new Map<string,DrawResult>(),drawResolveState=new Map<string,{inFlight: boolean; attempts: number; nextAt: number}>();
const walletActivityAt=new Map<string,number>();
let walletActivityInFlight: string|null=null;
const canSign=(wallet: WalletView|null): boolean=>!!wallet&&(wallet.kind==='key'||wallet.kind==='extension');
let submission: SubmissionProgress|null=null;
let lastWallet: WalletView|null=null;
let previewRound: Round|null=null,previewSeq=0;
let detailSyncAt=0,detailPolling=false,lastDetailOkAt=0;
let indexInitPending=false,indexWaitTimedOut=false,indexWaitTimer: ReturnType<typeof setTimeout>|null=null,userVerifyPending: string|null=null;
const indexerUsedAt=new Map<string,number>();
const INDEXER_REUSE_MS=3000;

/* ------------------------------------------------------------------ derived data */
let deferViewWrite=(): boolean=>false;
let touchedCache: Record<string,number>|null=null;
let ownersCache: Record<string,string>|null=null;
let myTxsCache: Record<string,string[]>|null=null;
const touched=(): Record<string,number>=>(touchedCache??=LS.get<Record<string,number>>('touched',{}));
const owners=(): Record<string,string>=>(ownersCache??=LS.get<Record<string,string>>('owners',{}));
const myTxs=(): Record<string,string[]> =>(myTxsCache??=LS.get<Record<string,string[]>>('myTxs',{}));
const touch=(cid: string)=>{const t=touched();t[cid]=Date.now();LS.set('touched',t);};
const recordMyTx=(walletKey: string,txid: string)=>{
  const map=myTxs();
  const list=map[walletKey]??[];
  if(!list.includes(txid)){list.push(txid);if(list.length>500)list.splice(0,list.length-500);map[walletKey]=list;LS.set('myTxs',map);}
};
const adapterOf=(r: Round|null|undefined): ProtocolAdapterLike|null=>
  r?(ctl?.protocols??protocols)?.resolveForRound(r)??null:null;
const roundStateFp=(r: Round,adapter=adapterOf(r)): string=>
  adapter?.roundFingerprint
    ?adapter.roundFingerprint(r)
    :`${r.step}:${r.terminal??''}:${r.manager?`${r.manager.outpoint.transactionId}:${r.manager.outpoint.index}`:'-'}:${r.frozen.length}:${r.history?'h':''}`;
function buildItem(r: Round,d: bigint|null,t: Record<string,number>,own: Record<string,string>): Item {
  const adapter=adapterOf(r);
  const daaKey=r.terminal?'':(d??'');
  const fp=[roundStateFp(r,adapter),r.intent?.status??'',r.halted??'',r.pending?.length??0,daaKey,t[r.cid]??0,own[r.cid]??''].join('|');
  const cached=itemCache.get(r.cid);
  if(cached&&cached.fp===fp&&cached.item.r===r)return cached.item;
  let f: Partial<Facts>={module:null},a: Item['a']={};
  try {
    if(adapter?.describeRound&&adapter?.uiActions){
      f=adapter.describeRound(r,d);
      a=adapter.uiActions(r,d);
    }
  }
  catch {f={module:null};a=Object.fromEntries(Object.keys(ACTION_INFO).map(k=>[k,{ok:false,reason:L().app.recordUnreadable}]));}
  const st=r.settings;
  // Rules come from the creation settings; a finished round has no manager UTXO any more, so its total comes from the recorded buys.
  const facts: Facts={module:null,ticketPrice:st.ticketPrice,ticketCap:st.ticketCap,minTickets:st.minTickets,closeEligibleDaa:st.closeEligibleDaa,shards:0,localRecords:0,owner:own[r.cid]??null,winnerKey:null,payCursor:null,refundShard:null,...f,
    tickets:f.tickets??(r.terminal?r.bought:0)};
  if(!facts.owner)facts.owner=own[r.cid]??null;   // the owner is only readable while the round has a manager UTXO; later it comes from the cache below
  const value=adapter?.lockedSompi?adapter.lockedSompi(r):(r.manager?r.manager.value+r.frozen.reduce((n: bigint,x)=>n+x.value,0n):0n);
  const asset=adapter?.assetFor(activeNet);
  const protocolMeta=adapter?.viewMeta?.(activeNet);
  const item: Item={r,f: facts,a,ph:phaseOf(r,facts),value,at:t[r.cid]??0,asset,protocolMeta};
  itemCache.set(r.cid,{fp,item});
  return item;
}
/** Tickets the connected wallet holds in the active round, delegated to the owning ProtocolAdapter. */
function holdings(it: Item,shards: ShardView[]|null=null): Holdings|null {
  const key=ctl.state.wallet?.key??null;
  if(!key)return null;
  const adapter=adapterOf(it.r);
  return adapter?.holdingsOf?adapter.holdingsOf(it.r,it.f,shards,key):null;
}
/** Items are rebuilt from the stored rounds + the last known DAA. Reading the store is the ONLY awaited step before rendering: a slow / hung node call
 * can no longer delay (or, by finishing late, overwrite) the newest stored state, and DAA is refreshed separately (pollDaa). */
function rebuild() {
  const t=touched(),own=owners();let dirty=false;
  const activeCids=new Set(lastRounds.map(r=>r.cid));
  for(const k of itemCache.keys())if(!activeCids.has(k))itemCache.delete(k);
  items=lastRounds.map(r=>buildItem(r,daa,t,own));
  for(const i of items)if(i.f.owner&&own[i.r.cid]!==i.f.owner){own[i.r.cid]=i.f.owner;dirty=true;}
  if(dirty)LS.set('owners',own);
}
async function refresh() {
  const seq=++refreshSeq,rs=await ctl.rounds();
  if(seq!==refreshSeq)return;                       // a newer refresh already read newer data; never render an older snapshot over it
  const prevByCid=new Map(lastRounds.map(r=>[r.cid,r]));
  const progressed=lastRounds.length>0&&rs.some(r=>{const p=prevByCid.get(r.cid);return p&&(p.step!==r.step||p.terminal!==r.terminal||p.manager?.outpoint.transactionId!==r.manager?.outpoint.transactionId);});
  lastRounds=rs;rebuild();
  if(previewRound&&items.some(i=>i.r.cid===previewRound!.cid))previewRound=null;
  const ls=ctl.state.lastSynced;
  if(ls&&S.cid===ls.cid&&Date.now()-ls.at<10000){
    const it=items.find(i=>i.r.cid===ls.cid);
    if(it&&!it.r.intent&&isNodeVerified(it.r)){
      const outpt=it.r.manager?`${it.r.manager.outpoint.transactionId}:${it.r.manager.outpoint.index}`:'-';
      if((conn.nodeUrl??'')===ls.nodeUrl&&outpt===ls.managerOutpoint&&it.r.step===ls.step&&it.r.frozen.length===ls.frozen){
        verify.set(ls.cid,{state:'ok',at:ls.at,fp:fpOf(it.r)});
      }
    }
  }
  render();
  if(progressed)void refreshBalance(true);
  void pollDaa();
  if(S.view==='round'&&S.cid){void ctl.watchRound(shouldWatchRound(S.cid)?S.cid:null);void autoVerify(S.cid);void resolveDrawHint(S.cid);void pollDrawProgress();}
}
async function pollDaa(force=false) {
  const rpc=ctl.state.rpc;
  const activeItem=S.view==='round'&&S.cid?items.find(i=>i.r.cid===S.cid):null;
  const minIntervalMs=activeItem?.f.module==='sealed'?3000:10000;
  if(!rpc||daaPolling||(!force&&Date.now()-daaObservedAt<minIntervalMs))return;daaPolling=true;
  try {const d=await rpc.currentDaa();if(rpc!==ctl.state.rpc)return;daaObservedAt=Date.now();if(d!==daa){daa=d;rebuild();render();void pollDrawProgress();}}catch{}finally{daaPolling=false;}
}
const drawKey=(r: Round): string=>`${r.cid}/${r.manager?.outpoint.transactionId}/${r.manager?.outpoint.index}/${r.manager?.utxoDaa}/${r.accepting}`;
async function pollDrawProgress() {
  const D=detail(),rpc=ctl.state.rpc;
  if(drawReading||document.hidden||S.view!=='round'||!rpc||ctl.state.busy||D?.preview||!D?.r.manager||D.f.module!=='sealed'||D.r.intent||D.r.halted||daa===null||daa<D.r.manager.utxoDaa+DRAW_DELAY||daa>=D.r.manager.utxoDaa+TIMEOUT_DELAY-1000n)return;
  const key=drawKey(D.r);
  if(drawObservation?.rpc===rpc&&drawObservation.key===key&&Date.now()-drawReadAt<5000)return;
  drawReading=true;drawReadAt=Date.now();
  try {
    let roundForRead=D.r;
    if(!roundForRead.accepting&&activeNet.rest&&roundForRead.manager?.outpoint.transactionId){
      try{
        const restBase=activeNet.rest.replace(/\/+$/,'');
        const res=await fetch(`${restBase}/transactions/${encodeURIComponent(roundForRead.manager.outpoint.transactionId)}?inputs=false&outputs=false`,{method:'GET',credentials:'omit',cache:'no-store'});
        if(res.ok){
          const j=await res.json();
          const ab=String(j?.accepting_block_hash??'').toLowerCase();
          if(/^[0-9a-f]{64}$/.test(ab))roundForRead={...roundForRead,accepting:ab};
        }
      }catch{}
    }
    let value: DrawProgress;
    try {value=await readDrawProgress(rpc,roundForRead);}
    catch {value={phase:'UNAVAILABLE',requiredConfirmations:100n,observedAt:Date.now()};}
    if(rpc===ctl.state.rpc&&S.view==='round'&&S.cid===D.r.cid&&drawKey(detail()?.r??D.r)===key){drawObservation={rpc,key,value};render();}
  } finally {drawReading=false;}
}
function gate(a: string): Gate {
  const c=ctl.state,it=S.view==='round'&&S.cid?items.find(i=>i.r.cid===S.cid):null,A=L().app;
  const adapter=it?adapterOf(it.r):null;
  const freeSet=adapter?.capabilities?.freeActions;
  const free=freeSet?freeSet.includes(a):!!ACTION_INFO[a]?.free;
  if(!store.persistent)return {ok:false,reason:A.gateNoStorage};
  if(!c.rpc)return {ok:false,reason:A.gateNoNode,fix:'settings'};
  if(S.view==='round'&&S.cid&&!it)return {ok:false,reason:A.gateVerifying};
  if(!c.wallet)return {ok:false,reason:free?A.gateNeedRecipient:A.gateNeedWallet,fix:'wallet'};
  if(!free&&!canSign(c.wallet))return {ok:false,reason:A.gateNeedSigning,fix:'wallet'};
  if(c.busy)return {ok:false,reason:A.gateBusy(c.busyLabel??L().common.working)};
  return {ok:true};
}
const shardsFor=(it: Item): ShardView[]|null=>{
  const wk=ctl.state.wallet?.key??'',adapter=adapterOf(it.r);
  const key=`${it.r.cid}|${roundStateFp(it.r,adapter)}|${wk}`;
  if(shardCache.key===key)return shardCache.shards;
  let shards: ShardView[]|null=null;
  try{shards=adapter?.shardCatalog?adapter.shardCatalog(it.r,wk||null):null;}catch{shards=null;}
  shardCache={key,shards};
  return shards;
};
const detail=(): Detail|null=>{
  let it=items.find(i=>i.r.cid===S.cid)??null,isPreview=false;
  if(!it&&previewRound&&previewRound.cid===S.cid){
    it=buildItem(previewRound,daa,touched(),owners());
    isPreview=true;
  }
  if(!it)return null;
  const cachedDraw=drawCache.get(it.r.cid)??null;
  const mergedDraw=it.r.draw?(cachedDraw?.proof&&!it.r.draw.proof?{...it.r.draw,proof:cachedDraw.proof}:it.r.draw):cachedDraw;
  const r=mergedDraw&&mergedDraw!==it.r.draw?{...it.r,draw:mergedDraw}:it.r;
  const shards=shardsFor(it);
  const adapter=adapterOf(it.r);
  const isWinner=!!it.f.winnerKey&&it.f.winnerKey===ctl.state.wallet?.key;
  const interactive=adapter?.interactiveModel?adapter.interactiveModel(r,{isWinner}):null;
  const receiptMatcher=adapter?{
    buyReceipt:(sh: ShardView,rec: ShardRecordView)=>
      adapter.matchBuyReceipt?adapter.matchBuyReceipt(sh,rec,r,shards):matchBuyReceiptAuto(sh,rec,r,shards),
    refundReceipt:(sh: ShardView,rec: ShardRecordView)=>
      adapter.matchRefundReceipt?adapter.matchRefundReceipt(sh,rec,r,shards):matchRefundReceiptAuto(sh,rec,r,shards),
    shardRefunds:(sh: ShardView)=>
      adapter.shardRefundReceipts?adapter.shardRefundReceipts(sh,r,shards):[],
  }:null;
  return {...it,r,preview:isPreview,mine:holdings(it,shards),isWinner,shards,interactive,receiptMatcher};
};
async function hydrateRoundPreview(cid: string) {
  if(items.some(i=>i.r.cid===cid))return;
  const seq=++previewSeq;
  const cached=await ctl.cachedPreview(cid);
  if(seq!==previewSeq||S.view!=='round'||S.cid!==cid||items.some(i=>i.r.cid===cid))return;
  if(cached&&(!previewRound||previewRound.cid!==cid||cached.step>previewRound.step)){previewRound=cached;render();}
  if(ctl.state.rpc)return;
  const fresh=await ctl.loadPreview(cid);
  if(seq!==previewSeq||S.view!=='round'||S.cid!==cid||items.some(i=>i.r.cid===cid))return;
  if(fresh&&(!previewRound||previewRound.cid!==cid||fresh.step>=previewRound.step||!!fresh.terminal)){previewRound=fresh;render();}
}
function mineData(): MineData|null {
  const w=ctl.state.wallet;if(!w)return null;
  const myTxSet=new Set(myTxs()[w.key]??[]);
  const rounds: MineData['rounds']=[],txs: {cid: Hex; t: Receipt}[]=[];
  for(const i of items){
    const adapter=adapterOf(i.r);
    const created=i.f.owner===w.key,won=!!i.f.winnerKey&&i.f.winnerKey===w.key;
    const shards=shardsFor(i);
    const tickets=shards?shards.reduce((n,s)=>n+s.mineCount,0):0;
    const hasMyTx=i.r.receipts.some(t=>myTxSet.has(t.txid))||(!!i.r.intent?.txid&&myTxSet.has(i.r.intent.txid));
    if(created||won||tickets>0||hasMyTx)rounds.push({item:i,tickets,created,won});
    const myBuyTxids=new Set<string>(),myRefundTxids=new Set<string>();
    if(shards){
      for(const s of shards){
        if(!s.records)continue;
        for(const rec of s.records){
          if(!rec.mine)continue;
          const brc=adapter?.matchBuyReceipt?adapter.matchBuyReceipt(s,rec,i.r,shards):matchBuyReceiptAuto(s,rec,i.r,shards);
          if(brc)myBuyTxids.add(brc.txid);
          if(rec.refunded){
            const rrc=adapter?.matchRefundReceipt?adapter.matchRefundReceipt(s,rec,i.r,shards):matchRefundReceiptAuto(s,rec,i.r,shards);
            if(rrc)myRefundTxids.add(rrc.txid);
          }
        }
      }
    }
    for(const t of i.r.receipts){
      const isBuy=adapter?.isPurchaseReceipt?adapter.isPurchaseReceipt(t):t.action==='BUY';
      const isRef=adapter?.isRefundReceipt?adapter.isRefundReceipt(t):(t.action==='REFUND_OLD'||t.action==='REFUND_SELF');
      if(myTxSet.has(t.txid)||(t.action==='GENESIS'&&created)||(isBuy&&myBuyTxids.has(t.txid))||(isRef&&myRefundTxids.has(t.txid)))txs.push({cid:i.r.cid,t});
    }
  }
  return {rounds,txs:txs.reverse().slice(0,100)};
}
async function resolveDrawHint(cid: string,force=false) {
  const it=items.find(i=>i.r.cid===cid);const rpc=ctl.state.rpc;
  if(!it||!rpc||it.r.draw?.proof||drawCache.get(cid)?.proof||!it.r.receipts.some(t=>t.action==='DRAW'))return;
  const st=drawResolveState.get(cid)??{inFlight:false,attempts:0,nextAt:0};
  const now=Date.now();
  if(st.inFlight||(!force&&(st.attempts>=8||now<st.nextAt)))return;
  st.inFlight=true;
  drawResolveState.set(cid,st);
  let resolved=false;
  try{
    const adapter=adapterOf(it.r);
    const d=adapter?.verifyDrawReceipt?await adapter.verifyDrawReceipt(it.r,rpc,{net:activeNet,fetcher:fetch}):null;
    if(d?.proof){
      resolved=true;
      drawCache.set(cid,d);
      drawResolveState.delete(cid);
      if(S.view==='round'&&S.cid===cid)render();
    }
  }catch{}finally{
    if(!resolved){
      st.inFlight=false;
      st.attempts+=1;
      const delay=st.attempts<=2?2000:st.attempts<=5?3000:5000;
      st.nextAt=Date.now()+delay;
      drawResolveState.set(cid,st);
      if(st.attempts<8&&S.view==='round'&&S.cid===cid&&!document.hidden){
        setTimeout(()=>{if(S.view==='round'&&S.cid===cid)void resolveDrawHint(cid);},delay);
      }
    }
  }
}
async function syncWalletActivityIfNeeded(force=false) {
  const w=ctl?.state.wallet;
  if(!w?.key||!ctl?.state.indexer||!ctl?.syncWalletActivity)return;
  const cacheKey=`${w.key}|${conn.indexerUrl??''}`;
  const nowMs=Date.now();
  if(walletActivityInFlight===cacheKey)return;
  if(!force&&nowMs-(walletActivityAt.get(cacheKey)??0)<30_000)return;
  walletActivityInFlight=cacheKey;
  walletActivityAt.set(cacheKey,nowMs);
  try{
    const res=await ctl.syncWalletActivity(w.key);
    if(res.synced.length||res.activities.length)await refresh();
  }catch{}finally{if(walletActivityInFlight===cacheKey)walletActivityInFlight=null;}
}
const observedDrawProgress=(): DrawProgress|null=>{
  const r=items.find(i=>i.r.cid===S.cid)?.r;
  return r&&drawObservation?.rpc===ctl.state.rpc&&drawObservation.key===drawKey(r)?drawObservation.value:null;
};
const compatibleProfilesList=()=>ctl.protocols.compatibleProfiles(activeNet);
const createSpecsList=()=>ctl.protocols.createSpecs(activeNet);
const ctxt=(): Ctx=>{const loc=L();conn.discoveredSource=ctl.state.discoveredSource??null;conn.indexerProfiles=ctl.state.indexerInfo?.profiles??null;return {net:activeNet,items,S,wallet:ctl.state.wallet,balance,daa,conn,busy:ctl.state.busy,ex,logs:ctl.state.logs,gate,detail:S.view==='round'?detail():null,
  mine:S.view==='mine'?mineData():null,verify:verifyFor(S.cid),discovered:ctl.state.discovered,indexerMore:ctl.state.indexerCursor!==null,walletOptions:availableExtensionWallets(),saved:savedCids,checkProgress,submission,daaObservedAt,drawProgress:observedDrawProgress(),supportedProfiles:new Set(ctl.protocols.profileIds()),compatibleProfiles:compatibleProfilesList(),createSpecs:createSpecsList(),L:loc,lang:loc.key};};

/* ------------------------------------------------------------------ render */
interface Focus {id: string;s: number|null;e: number|null}
function captureFocus(): Focus|null {const a=document.activeElement as HTMLInputElement|null;return a&&a.id&&$('view').contains(a)?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null;}
function restoreFocus(f: Focus|null) {if(!f)return;const el=$<HTMLInputElement>(f.id);if(!el)return;el.focus({preventScroll:true});try{el.setSelectionRange(f.s,f.e);}catch{}}
let lastFooterKey='';
function chrome() {
  const loc=L(),ch=loc.chrome,netLabel=ch.netLabel(activeNet.key);
  const ok=conn.node===true,bad=conn.node===false,chip=$('nodeChip');
  const label=ok?ch.connected:bad?ch.nodeFailed:ch.connecting;
  (chip.querySelector('.dot') as HTMLElement).className='dot '+(ok?'ok':bad?'bad':'warn');
  (chip.lastChild as ChildNode).textContent=`${netLabel} · ${label}`;
  chip.hidden=!bad;
  const netTag=document.getElementById('netTag');
  if(netTag)netTag.hidden=activeNet.key!=='tn10';
  const fk=`${loc.key}|${activeNet.key}`;
  const footerNet=document.getElementById('footerNet');
  if(footerNet&&fk!==lastFooterKey){
    lastFooterKey=fk;
    put(footerNet,html`${netLabel} · ${UNIT}`);
  }
  const w=ctl?.state.wallet,b=$('walletBtn');
  b.className='wbtn'+(w?' on':'');
  if(w){
    b.title=w.address;
    b.dataset.address=w.address;
    const text=canSign(w)?(balance!=null?`${formatTkasFixed(balance,2)} ${UNIT}`:`… ${UNIT}`):ch.receiveOnlyBadge;
    put(b,html`<span class="wdot" aria-hidden="true"></span><span class="wbal">${text}</span>`);
  }else{
    b.title='';
    delete b.dataset.address;
    b.textContent=ch.connectWallet;
  }
  document.querySelectorAll<HTMLElement>('.nav [data-go], .menu-drawer [data-go]').forEach(n=>{if(n.dataset.go===(S.view==='round'?'explore':S.view))n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});
  document.documentElement.dataset.theme=S.theme;
  const menuTheme=document.getElementById('menuThemeBtn');
  if(menuTheme){const tl=S.theme==='dark'?ch.themeToLight:ch.themeToDark;menuTheme.title=tl;menuTheme.setAttribute('aria-label',tl);}
  const themeColor=document.getElementById('themeColorMeta');
  if(themeColor)themeColor.setAttribute('content',S.theme==='dark'?'#081119':'#f4f7f9');
}
const isLiveSync=(): boolean=>S.liveSync!==false;
const shouldWatchRound=(cid: string|null): boolean=>{
  if(!cid)return false;
  if(isLiveSync())return true;
  return !!items.find(i=>i.r.cid===cid)?.r.intent;
};
function syncRoundTimer(x: Ctx) {
  const mod=x.detail?.f.module;
  const need=S.view==='round'&&!document.hidden&&!!ctl.state.rpc&&(mod==='sealed'||(mod==='sales'&&!x.detail?.a.CLOSE?.ok));
  if(need&&!roundTimer)roundTimer=setInterval(()=>{if(!document.hidden){void pollDaa();if(S.view==='round'){const d=detail();if(d?.f.module==='sealed'){void pollDrawProgress();render();}else if(d?.f.module==='sales'&&!d.a.CLOSE?.ok){render();}}}},1000);
  else if(!need&&roundTimer){clearInterval(roundTimer);roundTimer=null;}
}
function shardCanvasKey(D: Detail|null): string {
  if(!D?.shards?.length||(S.detailTab??'rules')!=='map')return '';
  const draw=D.r.draw;
  return `${D.r.cid}|${S.detailTab}|${S.theme}|${draw?`${draw.shard}:${draw.record}`:''}|${D.shards.map(s=>`${s.index}:${s.status}:${s.records?.length??-1}:${s.refundedRecords}`).join(',')}`;
}
function render() {
  const focus=captureFocus();
  let body: Raw,roundDetail: Detail|null=null;
  try {
    const x=ctxt();
    roundDetail=x.detail;
    syncRoundTimer(x);
    body=S.view==='create'?createView(x):S.view==='round'?roundView(x):S.view==='mine'?mineView(x):exploreView(x);
  } catch(e) {
    // One malformed record must not blank the whole page: say so, keep navigation alive.
    body=html`<div class="notice bad"><b>${L().app.renderErrTitle}</b> (${(e as Error)?.name??'Error'})${L().app.renderErrBody}<div class="btnrow"><button class="btn sm" data-go2="explore">${L().common.backToList}</button></div></div>`;
  }
  const out=html`${store.persistent?'':html`<div class="notice bad">${L().app.noStorageBanner}</div>`}${body}`;
  // Periodic refreshes often produce identical markup: skip the DOM write so <details>, scroll and selection are left alone.
  const canWrite=!deferViewWrite();
  if(out.s!==lastHtml&&canWrite){lastHtml=out.s;lastCanvasKey='';put($('view'),out);restoreFocus(focus);}
  if(canWrite&&S.view==='round'){
    const ck=shardCanvasKey(roundDetail);
    if(ck&&ck!==lastCanvasKey){lastCanvasKey=ck;paintShardCanvases($('view'),roundDetail,S.theme);}
  }else if(S.view!=='round')lastCanvasKey='';
  chrome();
}
const schedule=()=>{
  if(ctl.state.indexer&&conn.indexer!==true){
    conn.indexer=true;conn.indexerUrl=S.indexer.trim()||null;conn.indexerStale=false;
    if(indexWaitTimer){clearTimeout(indexWaitTimer);indexWaitTimer=null;}
    indexInitPending=false;
    if(ctl.state.wallet?.key)void syncWalletActivityIfNeeded();
  }
  if(lastWallet!==ctl.state.wallet){
    const had=!!lastWallet;lastWallet=ctl.state.wallet;balance=null;
    if(had&&!lastWallet&&!ctl.state.busy&&modalOpen()&&$('mTitle').dataset.modalKind==='confirm'){closeModal();toast(L().app.walletChangedCloseConfirm,'warn');}
    if(lastWallet?.key&&ctl.state.indexer)void syncWalletActivityIfNeeded();
    if(canSign(lastWallet))prefetchActiveWalletAssets();
  }
  // Button availability comes from controller state, not the next asynchronous IndexedDB snapshot.
  // Paint foreground busy transitions now; reconcile round data separately. Background checks never set busy.
  if(lastBusy!==ctl.state.busy){lastBusy=ctl.state.busy;render();}
  if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;refresh().catch(()=>{});});
};

function prefetchActiveWalletAssets() {
  const w=ctl?.state?.wallet;
  if(!canSign(w)||!protocols)return;
  for(const ad of protocols.list()){
    if(ad.supportsNetwork&&!ad.supportsNetwork(activeNet))continue;
    ad.prefetchForWallet?.({wallet:w,net:activeNet,fetcher:fetch});
  }
}
/* ------------------------------------------------------------------ navigation */
const VIEWS=['explore','create','mine','round'];
function route() {
  if(location.hash.startsWith('#join=')){const code=location.href;history.replaceState(null,'',location.pathname+'#/explore');S.view='explore';S.cid=null;S.shard=null;S.purchase=null;S.txLimit=20;previewRound=null;void ctl.watchRound(null);render();void onJoin(code);return;}
  if(location.hash==='#/protocol'){history.replaceState(null,'',location.pathname+'#/explore');S.view='explore';S.cid=null;render();openHelp();return;}
  const m=/^#\/(\w+)(?:\/([0-9a-f]{64}))?$/.exec(location.hash);
  const nextView=m&&VIEWS.includes(m[1])?m[1]:'explore',nextCid=m?.[2]??null;
  if(nextView!==S.view||nextCid!==S.cid){S.shard=null;S.purchase=null;S.detailTab='rules';S.txLimit=20;S.buyShard='auto';if(previewRound?.cid!==nextCid)previewRound=null;if(nextView==='round'&&nextCid){verify.delete(nextCid);initialSyncDone.delete(nextCid);}}
  S.view=nextView;S.cid=nextCid;if(S.view==='round'&&!S.cid)S.view='explore';
  if(S.view!=='round')previewRound=null;
  void ctl.watchRound(S.view==='round'&&shouldWatchRound(S.cid)?S.cid:null);
  if(S.view==='round'&&S.cid){touch(S.cid);prefetchActiveWalletAssets();void hydrateRoundPreview(S.cid);void autoVerify(S.cid);void resolveDrawHint(S.cid);void pollDrawProgress();}
  if(S.view==='mine')void syncWalletActivityIfNeeded();
  render();
}
function go(view: string,cid: string|null=null) {
  if(view==='round'&&cid){verify.delete(cid);initialSyncDone.delete(cid);}
  const h=view==='round'&&cid?`#/round/${cid}`:`#/${view}`;
  if(location.hash!==h)location.hash=h;else route();
  window.scrollTo?.(0,0);
}

/* ------------------------------------------------------------------ actions */
async function run<T>(fn: ()=>Promise<T>,{ok=null}: {ok?: string|null}={}): Promise<T|undefined> {
  try {const v=await fn();if(ok)toast(ok);return v;}
  catch(e) {toast(errText(e),'bad');return undefined;}
  finally {await refresh();}
}
function failure(e: unknown,action='') {
  const loc=L(),A=loc.app;
  if(errCode(e)==='WALLET_FUNDS_INSUFFICIENT'&&action==='REFUND_SELF') {
    toast(`${errText(e)}${A.refundFreeHint}`,'bad');return;
  }
  if(errCode(e)==='STALE_INPUT') {
    modal(A.roundUpdatedTitle,html`<p>${errText(e)}</p>`,html`<button class="btn" data-act="closeModal">${loc.common.gotIt}</button>${S.cid?html`<button class="btn pri" data-act="syncNow">${A.syncLatestBtn}</button>`:html`<button class="btn pri" data-act="pasteLatest">${A.pasteLatestBtn}</button>`}`);
  } else toast(errText(e),'bad');
}
/** A verification result only counts for the node and round state it was obtained for: importing different data over the same CID (file or link), a state
 * change, or switching node makes the fingerprint differ, so a stale green tick can never describe data it did not check. */
const fpOf=(r: Round): string=>[conn.nodeUrl??'',roundStateFp(r),r.intent?.status??''].join('|');
const isNodeVerified=(r: Round): boolean=>{
  const adapter=adapterOf(r);
  return adapter?.isNodeVerified?adapter.isNodeVerified(r):(!!r.terminal||!!r.manager);
};
function verifyFor(cid: string|null): VerifyState|null {
  const v=cid?verify.get(cid):undefined,it=cid?items.find(i=>i.r.cid===cid):undefined;
  if(!it)return v?.fp==='loading'?v:null;
  if(v&&(v.state==='partial'||((detailPolling||ctl.isSyncing?.(cid??''))&&v.state!=='bad'))&&!it.r.terminal&&!it.r.intent&&(!v.fp||v.fp.startsWith(`${conn.nodeUrl??''}|`)))return v;
  if(v?.state==='checking'&&v.fp===fpOf(it.r))return v;
  return v&&v.fp===fpOf(it.r)?v:null;
}
async function autoVerify(cid: string) {
  if(detailPolling||ctl.isSyncing?.(cid)||verify.get(cid)?.state==='checking'||verify.get(cid)?.state==='partial'||verifyFor(cid)||!ctl.state.rpc||ctl.state.busy)return;
  const it=items.find(i=>i.r.cid===cid);
  if(it&&(it.r.terminal||it.r.intent||(!isLiveSync()&&initialSyncDone.has(cid))))return;
  if(!it&&!/^[0-9a-f]{64}$/.test(cid))return;
  if(indexInitPending||(!it&&S.indexer.trim()&&conn.indexer===null&&!conn.indexerStale&&!indexWaitTimedOut))return;
  initialSyncDone.add(cid);
  await doVerify(cid);
}
async function doVerify(cid: string,{quiet=true}: {quiet?: boolean}={}) {
  const it=items.find(i=>i.r.cid===cid);
  const fp=it?fpOf(it.r):'loading';
  const prev=verify.get(cid);
  if(!quiet)userVerifyPending=cid;
  if(!quiet||!prev||prev.state==='bad'){verify.set(cid,{state:'checking',fp});render();}
  try {
    if(ctl.state.indexer)indexerUsedAt.set(cid,Date.now());
    const res=await ctl.syncRound(cid,{lookup:!it,allowHalted:true,force:true,timeBudgetMs:6000});
    await refresh();
    const after=items.find(i=>i.r.cid===res.cid);
    if(res.skipped){
      verify.delete(cid);
    }else if(res.partial||res.source==='rest'){
      verify.set(res.cid,{state:'partial',at:Date.now(),fp:after?fpOf(after.r):fp});
      if(res.partial){detailSyncAt=0;setTimeout(()=>{void runDetailSync({immediate:true});},120);}
      if(!quiet)toast(L().app.syncedPartialToast(res.steps??0));
    }else{
      if(after&&isNodeVerified(after.r)){
        lastDetailOkAt=Date.now();
        verify.set(res.cid,{state:'ok',at:Date.now(),fp:fpOf(after.r)});
      }else{
        verify.delete(cid);
      }
      if(res.cid!==cid&&S.view==='round'&&S.cid===cid){touch(res.cid);go('round',res.cid);return;}
      if(!quiet)toast(after&&!isNodeVerified(after.r)?L().app.verifyNotConfirmedToast:(res.steps&&res.steps>0?L().app.verifyCaughtUpToast(res.steps):L().app.verifyConsistentToast));
    }
  } catch(e) {
    if(errCode(e)==='BUSY'){verify.delete(cid);if(!quiet)toast(errText(e),'warn');}   // another operation is running: not a verdict
    else {verify.set(cid,{state:'bad',code:errCode(e),fp});if(!quiet)failure(e);}
  } finally {
    if(userVerifyPending===cid)userVerifyPending=null;
  }
  render();
}
function saveCreateForm() {
  const f=S.form,raw=(f.registryAddr??'').trim().toLowerCase();
  const customAddr=raw&&raw!==activeNet.registry.address?f.registryAddr:undefined;
  LS.set('form',{protocol:f.protocol,price:f.price,cap:f.cap,min:f.min,dur:f.dur,custom:f.custom,customUnit:f.customUnit??'m',registry:f.registry!==false,registryAddr:customAddr});
}
function planText(p: Prepared): string {
  const adapter=p.profileId?ctl.protocols.get(p.profileId):null;
  const isParallel=adapter?.viewMeta?.(activeNet)?.shardModel==='parallel'||!!p.subAction;
  const asset=adapter?.assetFor(activeNet);
  const tokenUnit=asset&&asset.kind!=='KAS'?asset.symbol:undefined;
  const fee=formatTkas(p.review.fee),n=p.targetCount,hasReg=p.review.outputs.some(o=>o.role==='REGISTRATION');
  const act=p.subAction??p.op.action;
  return L().app.planAction(act,{qty:Number(p.op.quantity??0),n,fee,unit:UNIT,tokenUnit,hasReg,isParallel});
}
async function prepareAndConfirm(choice: Record<string,unknown>,cid: string|null) {
  const act=String(choice.action??''),A=L().app;
  const it=cid?items.find(i=>i.r.cid===cid):null;
  const adapter=it?adapterOf(it.r):null;
  const freeSet=adapter?.capabilities?.freeActions;
  const isFreeAct=freeSet?freeSet.includes(act):!!ACTION_INFO[act]?.free;
  if(!isFreeAct&&ctl.state.wallet?.kind==='extension'){
    const ping=(ctl.state.wallet as {ping?:()=>Promise<boolean>}).ping;
    if(ping&&!(await ping())){toast(A.extSessionLostToast,'warn');openWallet();await refresh();return;}
  }
  lockModal(true);
  modal(A.prepareModalTitle,html`<ul class="progress"><li class="run">${A.prepareModalStep}</li></ul><p class="small muted">${A.prepareModalHint}</p>`);
  try {
    await ctl.prepare(choice,cid);
    lastPreparedBuy=act==='BUY'&&cid?{cid,shardCid:typeof choice.shardCid==='string'?choice.shardCid:null,quantity:String(choice.quantity??'1'),auto:false}:null;
    lockModal(false);
    showConfirm();
  }
  catch(e) {lockModal(false);closeModal();ctl.log('error',`准备交易失败：${(e as Error)?.message??String(e)}`);failure(e,act);await refresh();return;}
}
function showBuyCongestionModal(cid: string,quantity: string,depositKas: string) {
  const A=L().app;
  pendingCongestion={cid,quantity};
  modal(
    A.buyShardCongestionTitle,
    html`<p style="margin:0">${A.buyShardCongestionBody(depositKas,UNIT)}</p>`,
    html`<button type="button" class="btn" data-act="retryOtherShard">${A.buyShardRetryOtherBtn}</button><button type="button" class="btn pri" data-act="openNewShard">${A.buyShardOpenNewBtn(depositKas,UNIT)}</button>`,
    {kind:'congestion',onClose:()=>{pendingCongestion=null;}},
  );
}
async function prepareAutoBuyShard(cid: string,quantity: string,{switchedNotice=false}: {switchedNotice?: boolean}={}) {
  const A=L().app;
  if(ctl.state.wallet?.kind==='extension'){
    const ping=(ctl.state.wallet as {ping?:()=>Promise<boolean>}).ping;
    if(ping&&!(await ping())){toast(A.extSessionLostToast,'warn');openWallet();await refresh();return;}
  }
  lockModal(true);
  modal(A.prepareModalTitle,html`<ul class="progress"><li class="run" id="prepStep">${A.prepareModalStep}</li></ul><p class="small muted">${A.prepareModalHint}</p>`);
  const setStep=(text: string)=>{const el=document.getElementById('prepStep');if(el)el.textContent=text;};
  const rec=buyShardConflicts.get(cid)??{count:0,avoided:new Set<string>()};
  const tried=new Set<string>();
  let refreshedOnce=false,switched=switchedNotice,lastErr: unknown=null;
  try {
    for(let guard=0;guard<16;guard++){
      const D=detail();
      const buySel=D?.interactive?.buyShardSelector??null;
      const opts=buySel?.options??[];
      if(!opts.length){
        if(buySel?.canOpenNew){
          await ctl.prepare({action:'BUY',quantity},cid);
          lastPreparedBuy={cid,shardCid:null,quantity,auto:true};
          lockModal(false);
          showConfirm();
          return;
        }
        throw lastErr??Object.assign(new Error('ROUND_UNAVAILABLE'),{code:'USER'});
      }
      const combinedExclude=new Set<string>([...tried,...rec.avoided]);
      const picked=pickRandomBuyShard(opts,combinedExclude)??pickRandomBuyShard(opts,tried);
      if(!picked){
        if(!refreshedOnce){
          refreshedOnce=true;
          setStep(A.buyShardRetryingStep(Math.max(1,rec.count)));
          await doVerify(cid,{quiet:true});
          await refresh();
          tried.clear();
          continue;
        }
        if(shouldWarnShardCongestion(rec.count,buySel)){
          lockModal(false);
          showBuyCongestionModal(cid,quantity,buySel!.depositKas);
          return;
        }
        throw lastErr??Object.assign(new Error('STALE_INPUT'),{code:'STALE_INPUT'});
      }
      tried.add(picked.shardId);
      try {
        await ctl.prepare({action:'BUY',quantity,shardCid:picked.shardId},cid);
        lastPreparedBuy={cid,shardCid:picked.shardId,quantity,auto:true};
        lockModal(false);
        showConfirm();
        if(switched)toast(A.buyShardSwitchedToast);
        return;
      } catch(e) {
        if(!isShardUtxoConflict(e))throw e;
        lastErr=e;
        rec.count+=1;
        rec.avoided.add(picked.shardId);
        buyShardConflicts.set(cid,rec);
        switched=true;
        ctl.log('warn',`分片 #${shortHash(picked.shardId,6,4)} UTXO 冲突（第 ${rec.count} 次），尝试切换其他分片`);
        const curSel=detail()?.interactive?.buyShardSelector??buySel;
        if(shouldWarnShardCongestion(rec.count,curSel)){
          lockModal(false);
          showBuyCongestionModal(cid,quantity,curSel!.depositKas);
          return;
        }
        setStep(A.buyShardRetryingStep(rec.count));
      }
    }
    const finalSel=detail()?.interactive?.buyShardSelector??null;
    if(shouldWarnShardCongestion(rec.count,finalSel)){
      lockModal(false);
      showBuyCongestionModal(cid,quantity,finalSel!.depositKas);
      return;
    }
    throw lastErr??Object.assign(new Error('STALE_INPUT'),{code:'STALE_INPUT'});
  } catch(e) {
    lockModal(false);closeModal();
    ctl.log('error',`准备交易失败：${(e as Error)?.message??String(e)}`);
    failure(e,'BUY');
    await refresh();
  }
}
function showConfirm() {
  const p: Prepared|null=ctl.state.prepared,w=ctl.state.wallet;if(!p||!w)return;
  const loc=L(),x: ConfirmCtx={...ctxt(),prepared:p,planText:planText(p)};
  const needsSig=p.review.inputs.some(i=>i.kind.includes('需签名')||i.kind.toLowerCase().includes('signed'));
  modal(loc.dialogs.confirmTitle(actionTitle(p.op.action,loc)),confirmBody(x),
    html`<button class="btn" data-act="closeModal">${loc.common.cancel}</button><button class="btn pri" data-act="send">${needsSig?loc.dialogs.confirmSignSend:loc.dialogs.confirmSendFree}</button>`,
    {kind:'confirm',onClose:()=>{if(ctl.state.prepared){ctl.discardPrepared();render();}}});
}
async function onSend() {
  const loc=L(),A=loc.app;
  const p: Prepared|null=ctl.state.prepared;if(!p){closeModal();toast(A.quoteExpiredToast,'warn');return;}
  const {cid}=p,genesis=p.op.action==='GENESIS',signerKey=ctl.state.wallet?.key??null,creatorKey=genesis?signerKey:null,txid=p.review?.txid??null;
  const buyMeta=lastPreparedBuy?.cid===cid?lastPreparedBuy:null;
  lastPreparedBuy=null;
  const isExt=ctl.state.wallet?.kind==='extension',isKaspire=ctl.state.wallet?.id==='kaspire',needsSig=p.review.inputs.some(i=>i.kind.includes('需签名')||i.kind.toLowerCase().includes('signed'));
  const extWallet=isExt?ctl.state.wallet as {ping?:()=>Promise<boolean>;name?:string}:null;
  const signAbort=isExt&&needsSig?new AbortController():null;
  lockModal(true);
  if(signAbort){
    $('mFoot').hidden=false;
    put($('mFoot'),html`<button type="button" class="btn" id="signCancel">${A.cancelWaitBtn}</button>`);
    $('signCancel').onclick=()=>{
      const b=document.getElementById('signCancel') as HTMLButtonElement|null;if(b)b.disabled=true;
      signAbort.abort();
      void extWallet?.ping?.();
    };
  }else{$('mFoot').hidden=true;}
  put($('mBody'),html`<ul class="progress"><li class="run">${isExt&&needsSig?A.sendSigningExt:needsSig?A.sendSigningLocal:A.sendNoSig}</li></ul>${isKaspire&&needsSig?html`<div class="btnrow" style="margin:8px 0"><a class="btn sm" href="${KASPIRE_WAKE_LINK}">${A.sendOpenKaspire}</a></div>`:''}<p class="small muted" id="signHint">${A.prepareModalHint}</p>`);
  let signed=false;
  const slowTimer=signAbort?setTimeout(()=>{
    if(signed||signAbort.signal.aborted)return;
    const hint=document.getElementById('signHint');
    if(hint)hint.textContent=loc.errors.map.WALLET_SIGN_TIMEOUT??A.prepareModalHint;
  },8000):null;
  let status: string;
  try {
    status=await ctl.signAndSend({signal:signAbort?.signal??null,onSigned:()=>{
      signed=true;if(slowTimer)clearTimeout(slowTimer);$('mFoot').hidden=true;
      submission={cid,action:p.op.action,txid};
      lockModal(false);closeModal();go('round',cid);
    }});
  }
  catch(e) {
    if(slowTimer)clearTimeout(slowTimer);
    if(signAbort?.signal.aborted&&ctl.state.prepared)ctl.discardPrepared();
    if(submission?.cid===cid)submission={...submission,error:errText(e)};
    lockModal(false);closeModal();toast(errText(e),signAbort?.signal.aborted?'warn':'bad');await refresh();return;
  }
  if(slowTimer)clearTimeout(slowTimer);
  lockModal(false);closeModal();
  if(status==='SUBMITTED'){
    buyShardConflicts.delete(cid);
    if(signerKey&&p.profileId)ctl.protocols.get(p.profileId)?.invalidateWalletCache?.(signerKey,fetch);
    toast(A.sendDoneToast);
  }
  else if(status==='REJECTED')toast(A.sendFailToast,'bad');
  else if(status==='UNSENT')toast(A.sendFailToast,'warn');
  else toast(A.sendSubmitted,'warn');
  touch(cid);verify.delete(cid);
  if(signerKey&&txid&&status!=='UNSENT'&&status!=='REJECTED')recordMyTx(signerKey,txid);
  if(creatorKey&&status!=='UNSENT'){const own=owners();own[cid]=creatorKey;LS.set('owners',own);}
  await refresh();
  submission=null;render();
  const rejIntent=items.find(i=>i.r.cid===cid)?.r.intent;
  if(status==='REJECTED'&&!genesis&&classifyRejection(rejIntent).kind==='ROUND_INPUT'){
    if(buyMeta?.auto&&buyMeta.shardCid){
      const rec=buyShardConflicts.get(cid)??{count:0,avoided:new Set<string>()};
      rec.count+=1;rec.avoided.add(buyMeta.shardCid);buyShardConflicts.set(cid,rec);
      await doVerify(cid,{quiet:true});
      await refresh();
      const curIntent=items.find(i=>i.r.cid===cid)?.r.intent;
      if(curIntent?.status==='REJECTED'){
        try {
          await ctl.discard(cid,{force:false});
          await refresh();
          const D=detail();
          const buySel=D?.interactive?.buyShardSelector??null;
          if(shouldWarnShardCongestion(rec.count,buySel)){
            showBuyCongestionModal(cid,buyMeta.quantity,buySel!.depositKas);
          }else if(buySel?.options?.length&&S.view==='round'&&S.cid===cid){
            void prepareAutoBuyShard(cid,buyMeta.quantity,{switchedNotice:true});
          }
        } catch {/* Keep rejected intent for manual reconciliation if discard safety check fails. */}
      }
    }else{
      void doVerify(cid,{quiet:true});
    }
  }
  void refreshBalance(true);
  if(status!=='UNSENT'&&status!=='REJECTED')void ctl.track(cid).then(async()=>{await refresh();void refreshBalance(true);},()=>{});
}
async function onAction(a: string) {
  if(modalOpen())return;
  if(ctl.state.busy){toast(L().app.gateBusy(ctl.state.busyLabel??L().common.working),'warn');return;}
  const choice: Record<string,unknown>={action:a};
  if(a==='BUY'){
    const D=detail();if(!D){toast(L().round.notFound,'warn');return;}
    const error=qtyError(S.qty,D.f,D.a.BUY);if(error){toast(error,'warn');return;}
    choice.quantity=S.qty.trim();
    const buySel=D.interactive?.buyShardSelector??null;
    if(buySel&&S.cid){
      const manualSel=(document.getElementById('buyShardSelect') as HTMLSelectElement|null)?.value??S.buyShard??'auto';
      if(manualSel==='new'&&buySel.canOpenNew){
        // Explicit new dedicated shard (OPEN_SHARD)
      }else if(manualSel&&manualSel!=='auto'&&manualSel!=='new'&&buySel.options.some(o=>o.shardId===manualSel)){
        choice.shardCid=manualSel;
      }else{
        await prepareAutoBuyShard(S.cid,choice.quantity as string);
        return;
      }
    }
  }
  if(a==='DRAW'){
    const D=detail();if(!D)return;
    const readiness=drawReadiness(D,ctxt());if(!readiness.ready){toast(readiness.detail,'warn');void pollDrawProgress();return;}
  }
  await prepareAndConfirm(choice,S.cid);
}
async function runBatchSettlement(mode: 'payout' | 'refund') {
  if(modalOpen())return;
  const cid=S.cid;if(!cid)return;
  const loc=L(),B=loc.app.batch;
  const cfg=mode==='payout'
    ?{module:'win',terminal:'PAID',primary:'PAY_OLD',final:'PAY_SELF',...B.payout}
    :{module:'refund',terminal:'REFUNDED',primary:'REFUND_OLD',final:'REFUND_SELF',...B.refund};
  const start=items.find(i=>i.r.cid===cid);
  if(!start||start.r.terminal||start.r.halted||start.r.intent||start.f.module!==cfg.module){toast(B.cannotStart(cfg.noun),'warn');return;}
  if(ctl.state.busy){toast(B.busy(ctl.state.busyLabel??loc.common.working),'warn');return;}
  const g=gate(start.a[cfg.primary]?.ok?cfg.primary:cfg.final);
  if(!g.ok){toast(g.reason??loc.round.unavailable,'warn');if(g.fix==='wallet')openWallet();else if(g.fix==='settings')openSettings();return;}
  let stop=false,batch=0;
  const steps: {cls: string; text: string}[]=[];
  const paint=(summary: string,extra: unknown='')=>{
    put($('mBody'),html`<p class="small muted" style="margin-top:0">${summary}</p><ul class="progress">${steps.map(s=>html`<li class="${s.cls}">${s.text}</li>`)}</ul>${extra}`);
  };
  lockModal(true);
  modal(cfg.title,html`<ul class="progress"><li class="run">${B.preparingFirst(cfg.noun)}</li></ul>`,html`<button type="button" class="btn warn" id="batchStop">${B.stopBtn}</button>`);
  $('batchStop').onclick=()=>{stop=true;const b=$<HTMLButtonElement>('batchStop');b.disabled=true;b.textContent=B.stoppingBtn;};
  const finish=(title: string,ok: boolean)=>{
    lockModal(false);
    $('mTitle').textContent=title;
    put($('mFoot'),html`<button type="button" class="btn ${ok?'pri':''}" data-act="closeModal">${ok?loc.common.done:loc.common.close}</button>`);
    $('mFoot').hidden=false;
    void refreshBalance(true);
  };
  try {
    while(!stop){
      const cur=items.find(i=>i.r.cid===cid);
      if(!cur)throw new Error('ROUND_NOT_FOUND');
      if(cur.r.terminal===cfg.terminal){paint(B.allDone(cfg.noun,batch));return finish(cfg.doneTitle,true);}
      if(cur.r.terminal||cur.r.halted)throw new Error('ROUND_CLOSED');
      if(cur.r.intent)throw new Error('PENDING_INTENT');
      const action=cur.a[cfg.primary]?.ok?cfg.primary:cur.a[cfg.final]?.ok?cfg.final:null;
      if(!action)throw new Error('ACTION_UNAVAILABLE');
      batch++;
      const rem=cur.r.frozen.length;
      const detailLabel=action==='PAY_OLD'?B.detailPayOld(rem):action==='PAY_SELF'?B.detailPaySelf:action==='REFUND_OLD'?B.detailRefundOld(rem):B.detailRefundSelf;
      const label=B.batchLabel(batch,detailLabel);
      steps.push({cls:'run',text:B.building(label)});
      paint(B.keepOpen);
      await ctl.prepare({action},cid);
      const p=ctl.state.prepared;if(!p)throw new Error('PREPARE_FAILED');
      const needsSig=p.review.inputs.some(i=>i.kind.includes('需签名')||i.kind.toLowerCase().includes('signed')),isKaspire=ctl.state.wallet?.id==='kaspire';
      steps[steps.length-1]={cls:'run',text:needsSig?B.signing(label):B.submittingFree(label)};
      paint(B.keepOpen,isKaspire&&needsSig?html`<div class="btnrow" style="margin:8px 0"><a class="btn sm" href="${KASPIRE_WAKE_LINK}">${loc.app.sendOpenKaspire}</a></div>`:'');
      const status=await ctl.signAndSend();
      const signerKey=ctl.state.wallet?.key??null,txid=p.review?.txid??null;
      if(signerKey&&txid&&status!=='UNSENT'&&status!=='REJECTED')recordMyTx(signerKey,txid);
      touch(cid);verify.delete(cid);
      if(status==='UNSENT'||status==='REJECTED'){
        steps[steps.length-1]={cls:'bad',text:status==='REJECTED'?B.rejected(label):B.unsent(label)};
        paint(B.closeHint);
        await refresh();
        return finish(cfg.abortTitle,false);
      }
      steps[steps.length-1]={cls:'run',text:B.waitingAccept(label)};
      paint(B.waitingAcceptHint);
      await refresh();
      let settled=false;
      for(let t=0;t<30;t++){
        await new Promise(r=>setTimeout(r,t===0?800:1500));
        try{await ctl.track(cid);}catch{}
        await refresh();
        const latest=items.find(i=>i.r.cid===cid);
        if(!latest)break;
        if(latest.r.intent?.status==='REJECTED'){
          steps[steps.length-1]={cls:'bad',text:B.acceptedRejected(label)};
          paint(B.discardHint);
          return finish(cfg.abortTitle,false);
        }
        if(!latest.r.intent){settled=true;break;}
        if(stop)break;
      }
      if(!settled){
        steps[steps.length-1]={cls:'ok',text:stop?B.submittedStop(label):B.submittedPending(label)};
        paint(B.batchesSubmitted(batch));
        return finish(stop?cfg.stopTitle:B.waitingConfirmTitle,false);
      }
      steps[steps.length-1]={cls:'ok',text:B.accepted(label)};
      void refreshBalance(true);
    }
    paint(B.stoppedSummary(batch));
    finish(cfg.stopTitle,false);
  } catch(e) {
    if(ctl.state.prepared)ctl.discardPrepared();
    steps.push({cls:'bad',text:B.batchError(Math.max(1,batch),errText(e))});
    paint(B.errorHint);
    await refresh();
    finish(cfg.failTitle,false);
  }
}
async function onCreate() {
  const loc=L(),specs=createSpecsList();
  const spec=specs.find(s=>s.protocolId===S.form.protocol)??specs[0]??null;
  const altSpec=specs.find(s=>s.supportedOnNet&&s.protocolId!==spec?.protocolId);
  const altLabel=altSpec?(altSpec.layout==='parallel_fixed_shards'?loc.create.protoParallel(altSpec.name,altSpec.maxShards,altSpec.asset.symbol):loc.create.protoSequential(altSpec.name,UNIT)):UNIT;
  const p=parseCreate(S.form,activeNet,loc,spec,altLabel);
  if(!p.ok){toast(p.errors[0]!,'warn');return;}
  const w=ctl.state.wallet;
  if(!w||!canSign(w)){if(w)toast(loc.app.createNeedSigningToast,'warn');openWallet();return;}
  const proto=spec?ctl.protocols.getById(spec.protocolId):ctl.protocols.defaultForCreate();
  await prepareAndConfirm({action:'GENESIS',profileId:proto?.profileId,registry:p.registry,settings:{ticketPrice:S.form.price.trim(),ticketCap:String(p.cap),minTickets:String(p.min),closeMinutes:String(p.mins)}},null);
}
async function onJoin(input: unknown) {
  if(typeof input==='string'&&/^[0-9a-f]{64}$/i.test(input.trim())){
    const id=input.trim().toLowerCase();
    S.join='';touch(id);verify.delete(id);go('round',id);return;
  }
  try {
    const text=await parseShare(input),cid=await ctl.importText(text);
    touch(cid);verify.delete(cid);S.join='';toast(L().app.joinedToast);await refresh();go('round',cid);
  } catch(e) {toast(errText(e),'bad');}
}
async function onRefreshIndex(){
  try{
    if(!ctl.state.indexer&&S.indexer.trim()){
      const err=await connectIndexerPart(S.indexer.trim());
      if(!err){await refresh();toast(L().app.refreshedIndexToast);return;}
    }
    const res=await ctl.refreshIndex() as {fallbackFrom?: unknown;skipped?: string}|undefined;
    conn.indexerStale=!!ctl.state.indexerInfo?.stale||!!res?.fallbackFrom;
    conn.discoveredSource=ctl.state.discoveredSource??null;
    await refresh();
    if(!res?.skipped)toast(conn.discoveredSource==='rest'?L().app.refreshedRestToast:L().app.refreshedIndexToast);
  }
  catch(e){conn.indexerStale=!!ctl.state.indexer||!!S.indexer.trim();conn.discoveredSource=ctl.state.discoveredSource??null;toast(errText(e),'warn');render();}
}
async function onMoreIndex(){try{await ctl.moreIndex();await refresh();}catch(e){toast(errText(e),'warn');}}
function openRoundTools(cid: string) {
  const loc=L();
  modal(loc.round.toolsTitle,roundToolsBody(cid,loc),html`<button class="btn" data-act="closeModal">${loc.common.close}</button>`);
}
async function onShare(cid: string) {
  const text=await ctl.exportText(cid),code=await makeShare(text),link=`${location.origin}${location.pathname}#join=${code}`;
  try {await copyText(link);toast(link.length>6000?L().app.shareCopiedLong:L().app.shareCopied);}
  catch {toast(L().app.shareCopyFail,'warn');}
}
async function onExport(cid: string) {download(`kaswin-rolling-${cid.slice(0,12)}.json`,await ctl.exportText(cid));}
async function onExportAll() {
  const rounds: string[]=[];for(const r of await ctl.rounds())rounds.push(await ctl.exportText(r as unknown as string));
  if(!rounds.length){toast(L().app.exportEmptyToast,'warn');return;}
  download('kaswin-rolling-rounds.json',JSON.stringify({kind:'KASWIN_ROLLING_BUNDLE',rounds}));
}
async function onImportFile(file: File|undefined) {
  if(!file||file.size>64_000_000){toast(L().app.importSizeToast,'warn');return;}
  const text=await file.text();let n=0;
  try {
    let list: unknown[]=[text];
    if(text.trimStart().startsWith('{')){const o=JSON.parse(text) as {kind?: string;rounds?: unknown};if(o?.kind==='KASWIN_ROLLING_BUNDLE'&&Array.isArray(o.rounds)&&o.rounds.length<=200)list=o.rounds;}
    for(const t of list){const cid=await ctl.importText(String(t));verify.delete(cid);n++;}
    toast(L().app.importedToast(n));
  } catch(e) {toast(errText(e),'bad');}
  await refresh();
}
let balanceInflight: Promise<void>|null=null;
async function refreshBalance(force=false) {
  const w=ctl.state.wallet,rpc=ctl.state.rpc;
  if(!w||!canSign(w)||!rpc){balance=null;return;}
  if(!force&&Date.now()-balanceAt<10000)return;
  if(balanceInflight)return balanceInflight;
  balanceAt=Date.now();
  balanceInflight=(async()=>{
    try {balance=(await getAssetUtxos(rpc,w.address,kasAsset(activeNet))).reduce((n,u)=>n+u.value,0n);}catch{balance=null;}
    chrome();if(modalOpen()&&$('mTitle').dataset.modalKind==='wallet')openWallet();else render();
  })().finally(()=>{balanceInflight=null;});
  return balanceInflight;
}

/* ------------------------------------------------------------------ connection / wallet dialogs */
/** Node and service are connected independently, so one failing never reports the other as down. Both return the error (or null). */
async function connectNodePart(list: string[]): Promise<unknown> {
  try {await ctl.connectNode(list);conn.node=!!ctl.state.rpc;conn.nodeUrl=ctl.state.rpc?.url??null;return null;}
  catch(e) {conn.node=!!ctl.state.rpc;conn.nodeUrl=ctl.state.rpc?.url??null;return e;}
}
async function connectIndexerPart(base: string): Promise<unknown> {
  try{await ctl.checkIndexer(base);conn.indexer=base?true:null;conn.indexerUrl=base||null;conn.indexerStale=false;conn.discoveredSource=ctl.state.discoveredSource??null;return null;}
  catch(e){conn.indexer=!!ctl.state.indexer;conn.indexerStale=!ctl.state.indexer&&(!!base||!!ctl.state.indexerInfo?.stale);return e;}
}
const nodesOrEmpty=(text: string): string[]=>{try{return parseNodeList(text,defaultNode);}catch{return [];}};
async function connectAuto() {
  conn.node=null;chrome();
  if(indexWaitTimer){clearTimeout(indexWaitTimer);indexWaitTimer=null;}
  indexWaitTimedOut=false;
  indexInitPending=!!S.indexer.trim()&&conn.indexer===null&&!conn.indexerStale;
  if(indexInitPending){
    indexWaitTimer=setTimeout(()=>{
      indexWaitTimer=null;indexInitPending=false;indexWaitTimedOut=true;
      if(S.view==='round'&&S.cid)void autoVerify(S.cid);
    },5000);
  }
  const nodes=nodesOrEmpty(S.nodes);
  const nodeTask=(async()=>{
    if(nodes.length)await connectNodePart(nodes);else conn.node=false;   // a stored value that no longer validates counts as a failed node, not a crash
    chrome();await refresh();void refreshBalance(true);
    if(S.view==='round'&&S.cid&&items.some(i=>i.r.cid===S.cid))void autoVerify(S.cid);
  })();
  const indexTask=(async()=>{
    try{
      let idxErr: unknown=null;
      if(S.indexer.trim())idxErr=await connectIndexerPart(S.indexer.trim());
      if(!S.indexer.trim()||idxErr){try{await ctl.refreshIndex();}catch{}}
      conn.discoveredSource=ctl.state.discoveredSource??null;
      if(S.cid&&verify.get(S.cid)?.fp==='loading'&&verify.get(S.cid)?.state==='bad')verify.delete(S.cid);
      if(S.view==='round'&&S.cid){
        if(conn.indexer&&verify.get(S.cid)?.state==='partial')indexerUsedAt.delete(S.cid);
        if(!items.some(i=>i.r.cid===S.cid)&&!ctl.state.rpc)void hydrateRoundPreview(S.cid);
      }
      chrome();await refresh();
    }finally{
      if(indexWaitTimer){clearTimeout(indexWaitTimer);indexWaitTimer=null;}
      indexInitPending=false;
    }
  })();
  await Promise.all([nodeTask,indexTask]);
  if(S.view==='round'&&S.cid)void autoVerify(S.cid);   // an imported or deep-linked round opened before the node/indexer was ready
}
function openHelp() {
  const loc=L();
  modal(loc.rules.heading,helpBody(ctxt()),html`<button class="btn pri" data-act="closeModal">${loc.common.gotIt}</button>`,{kind:'help'});
}
function openSettings() {
  const loc=L(),Dl=loc.dialogs;
  settingsOpened={nodes:S.nodes,indexer:S.indexer};   // what this dialog was opened with: only fields the user actually edits are saved
  modal(Dl.settingsTitle,settingsBody(ctxt()),html`<button class="btn" data-act="closeModal">${loc.common.close}</button>`,{kind:'settings'});
  $<HTMLInputElement>('sFile').onchange=ev=>{const el=ev.target as HTMLInputElement;void onImportFile(el.files?.[0]);el.value='';};
}
function openWallet() {
  const loc=L(),x=ctxt(),w=x.wallet;
  const tab=activeNet.key==='mainnet'&&S.wtab==='key'?'extension':S.wtab;
  modal(loc.dialogs.walletTitle,walletBody(x),w?html`<button class="btn warn" data-act="disconnect">${loc.common.disconnect}</button><button class="btn" data-act="closeModal">${loc.common.close}</button>`
    :tab==='extension'?html`<button class="btn" data-act="closeModal">${loc.common.close}</button>`
    :html`<button class="btn" data-act="closeModal">${loc.common.cancel}</button><button class="btn pri" data-act="connectWallet">${loc.common.connect}</button>`,{kind:'wallet'});
}
/** Error text next to the field that caused it (dialogs hide page-level feedback); falls back to a toast when the slot is gone. */
function inlineError(id: string,text: string) {
  const el=document.getElementById(id);
  if(el)el.textContent=text;else toast(text,'bad');
}
async function connectExternalProvider(id: string) {
  const loc=L(),A=loc.app;
  if(ctl.state.busy){inlineError('wErr',loc.round.busyFallback);return;}
  try {
    if(id==='kaspire'){
      const abort=new AbortController();
      const cancel=()=>{abort.abort();lockModal(false);closeModal();};
      lockModal(true);
      put($('mBody'),html`<ul class="progress"><li class="run">${A.kaspireWaiting}</li></ul><p class="small muted">${A.prepareModalHint}</p>`);
      put($('mFoot'),html`<button class="btn" id="kaspireCancel">${loc.common.cancel}</button>`);
      $('kaspireCancel').onclick=cancel;
      try {
        await ctl.connectExternalWallet('kaspire',{
          signal:abort.signal,
          onPairingUri:async({wcUri,schemeUri,appLink}:{wcUri: string;schemeUri: string;appLink: string})=>{
            if(abort.signal.aborted)return;
            let qr='';
            try{qr=await renderPairingQrDataUrl(appLink);}catch{}
            if(abort.signal.aborted)return;
            const pr=A.kaspirePrompt(loc.chrome.netLabel(activeNet.key));
            put($('mBody'),html`
              <p class="sub" style="margin-top:0">${pr.before}<b>${pr.bold}</b>${pr.after}</p>
              ${qr?html`<div style="display:flex;justify-content:center;margin:12px 0"><img src="${qr}" alt="${A.kaspireQrAlt}" style="width:200px;height:200px;border-radius:10px;background:#fff;padding:8px"></div>`:''}
              <div class="btnrow" style="justify-content:center;margin-top:10px">
                <a class="btn pri" href="${schemeUri}">${A.kaspireOpenApp}</a>
                <button class="btn" type="button" data-copy="${wcUri}">${A.kaspireCopyLink}</button>
              </div>
              <p class="small muted" style="text-align:center;margin-top:10px">${A.kaspireWaiting}</p>`);
            if(isMobileBrowser())setTimeout(()=>{if(!abort.signal.aborted)triggerAppLink(schemeUri);},350);
          },
        });
      } catch(e) {
        lockModal(false);
        if(abort.signal.aborted)return;
        openWallet();
        inlineError('wErr',errText(e));
        return;
      } finally {lockModal(false);}
    } else {
      const abort=new AbortController();
      lockModal(true);
      put($('mBody'),html`<ul class="progress"><li class="run">${A.sendSigningExt}</li></ul><p class="small muted">${loc.errors.map.WALLET_CONNECT_TIMEOUT??A.prepareModalHint}</p>`);
      put($('mFoot'),html`<button class="btn" id="extConnectCancel">${loc.common.cancel}</button>`);
      $('extConnectCancel').onclick=()=>abort.abort();
      try {
        await ctl.connectExternalWallet(id,{signal:abort.signal});
      } catch(e) {
        lockModal(false);
        openWallet();
        if(!abort.signal.aborted)inlineError('wErr',errText(e));
        return;
      } finally {lockModal(false);}
    }
    S.walletProvider=id;LS.set('walletProvider',id);
  } catch(e) {inlineError('wErr',errText(e));return;}
  closeModal();toast(A.walletConnectedToast);void refreshBalance(true);render();
}
async function onConnectWallet() {
  const loc=L();
  if(ctl.state.busy){inlineError('wErr',loc.round.busyFallback);return;}
  if(S.wtab==='extension'){
    const sel=document.getElementById('wProvider') as HTMLSelectElement|null;
    await connectExternalProvider(sel?.value||S.walletProvider||'kasware');
    return;
  }
  try {
    if(S.wtab==='key'){
      if(activeNet.key==='mainnet')throw Object.assign(new Error('MAINNET_MEMORY_KEY_DISABLED'),{code:'MAINNET_MEMORY_KEY_DISABLED'});
      const el=$<HTMLInputElement>('wKey'),v=el.value;el.value='';ctl.openWallet(v);
    } else ctl.usePublicAddress($<HTMLInputElement>('wAddr').value);
  } catch(e) {inlineError('wErr',errText(e));return;}
  closeModal();toast(loc.app.walletConnectedToast);void refreshBalance(true);render();
}
function onDisconnect() {ctl.disconnectWallet();balance=null;closeModal();toast(L().app.walletDisconnectedToast);render();}
function onResetConn() {
  $<HTMLTextAreaElement>('sNodes').value=defaultNode;
  $<HTMLInputElement>('sIndexer').value=defaultIndexer;
  inlineError('sErr','');
  const probe=$('sProbe');if(probe)put(probe,html``);
  toast(L().app.resetConnToast);
}
async function onTestConn() {
  const loc=L(),A=loc.app;
  inlineError('sErr','');
  const probe=$('sProbe');if(!probe)return;
  put(probe,html`<div class="notice">${A.testingConn}</div>`);
  const parts: Raw[]=[];
  try {
    const urls=parseNodeList($<HTMLTextAreaElement>('sNodes').value,defaultNode);
    const t0=Date.now();
    const rpc=await connectNetwork(urls,activeNet);
    try {
      const d=await rpc.currentDaa();
      const ok=A.probeNodeOk(rpc.url??urls[0]!,loc.chrome.netLabel(activeNet.key),String(d),Date.now()-t0);
      parts.push(html`<div class="notice ok">${ok.before}<b>${ok.bold}</b>${ok.after}</div>`);
    } finally {rpc.close?.();}
  } catch(e) {
    parts.push(html`<div class="notice warn">${A.probeNodeWarn(errText(e))}</div>`);
  }
  try {
    const raw=$<HTMLInputElement>('sIndexer').value.trim();
    if(!raw)parts.push(html`<div class="notice">${A.probeIndexerNone}</div>`);
    else {
      const baseUrl=indexerBase(raw),client=createIndexerClient({baseUrl,networkId:activeNet.networkId,genesisHash:activeNet.genesis,profileId:primaryProfileId,profileIds:ctl.protocols.profileIds()}),info=await client.info();
      const cnt=info.roundsCount??(await client.rounds({limit:100})).rounds.length;
      const reported=Array.isArray(info.profiles)&&info.profiles.length?new Set(info.profiles.map(p=>p.profileId)):null;
      const required=compatibleProfilesList().filter(p=>p.supportsNet!==false);
      const missing=reported?required.filter(p=>!reported.has(p.profileId)):[];
      if(missing.length){
        const missText=missing.map(p=>`${p.asset} (${shortHash(p.profileId,6,4)})`).join(loc.listSep);
        parts.push(html`<div class="notice warn">${A.probeIndexerMissing(cnt,missText)}</div>`);
      }else{
        const cov=reported?required.map(p=>p.asset).join(loc.listSep):null;
        parts.push(html`<div class="notice ok">${A.probeIndexerOk(cnt,!!info.stale,cov)}</div>`);
      }
    }
  } catch(e) {
    parts.push(html`<div class="notice warn">${A.probeIndexerWarn(errText(e))}</div>`);
  }
  if($('sProbe'))put($('sProbe'),html`${parts}`);
}
async function onApplyConn() {
  const loc=L(),A=loc.app;
  const nodesText=$<HTMLTextAreaElement>('sNodes').value,indexText=$<HTMLInputElement>('sIndexer').value;
  const nodesChanged=nodesText.trim()!==settingsOpened.nodes.trim(),indexChanged=indexText.trim()!==settingsOpened.indexer.trim();
  const problems: string[]=[];let newNodes: string[]|null=null,newIndex: string|null=null;
  try {if(nodesChanged)newNodes=parseNodeList(nodesText,defaultNode);} catch(e) {problems.push(errText(e));}
  try {if(indexChanged)newIndex=indexText.trim()?indexerBase(indexText):'';} catch(e) {problems.push(errText(e));}
  if(problems.length){inlineError('sErr',problems.join(' '));return;}
  if(newNodes){
    const previous=nodesOrEmpty(S.nodes),err=await connectNodePart(newNodes);
    if(!err){S.nodes=newNodes.join('\n');LS.set('nodes',S.nodes);}
    else{problems.push(A.savedConnWarn(errText(err)));if(previous.length)await connectNodePart(previous);}
  }
  if(newIndex!==null){
    const err=await connectIndexerPart(newIndex);
    if(!err){S.indexer=newIndex;LS.set('indexer',newIndex);if(!newIndex){try{await ctl.refreshIndex();}catch{}}conn.discoveredSource=ctl.state.discoveredSource??null;}
    else problems.push(A.savedConnWarn(errText(err)));
  }
  if(!nodesChanged&&!indexChanged)await connectAuto();
  chrome();await refresh();void refreshBalance(true);
  if(modalOpen()&&$('mTitle').dataset.modalKind==='settings'){
    openSettings();
    if(problems.length){
      $<HTMLTextAreaElement>('sNodes').value=nodesText;$<HTMLInputElement>('sIndexer').value=indexText;inlineError('sErr',problems.join(' '));
    } else toast(A.savedConnToast);
  }
}
async function onDiscard(force=false) {
  const cid=CID(),loc=L(),A=loc.app;
  try {
    await ctl.discard(cid,{force});
    if(force)closeModal();
    toast(A.discardedToast);
  } catch(e) {
    if(!force&&errCode(e)==='SEARCH_RANGE') {
      const txid=items.find(i=>i.r.cid===cid)?.r.intent?.txid;
      modal(A.discardConfirmTitle,html`<p>${errText(e)}</p><p>${A.discardConfirmBody}</p>${txid?html`<p class="small muted">${loc.round.intentTxid}<span class="mono">${txid}</span></p>`:''}`,
        html`<button class="btn" data-act="closeModal">${loc.common.cancel}</button><button class="btn warn" data-act="discardForce">${A.discardConfirmBtn}</button>`);
    } else {if(force)closeModal();toast(errText(e),'bad');}
  } finally {await refresh();}
}

/* ------------------------------------------------------------------ events */
const CID=(): string=>S.cid as string;
function toggleStar(cid: string) {
  if(savedCids.has(cid)){savedCids.delete(cid);toast(L().common.star);}
  else{savedCids.add(cid);toast(L().common.starred);}
  LS.set('saved',[...savedCids]);
  render();
}
async function onCheckPending() {
  const loc=L(),A=loc.app;
  if(checkProgress||ctl.state.busy)return;
  if(!ctl.state.rpc){toast(A.gateNoNode,'warn');return;}
  const targets=items.filter(i=>(i.r.pending?.length??0)>0||(!!i.r.intent&&['SUBMITTED','UNKNOWN'].includes(i.r.intent.status))).slice(0,20);
  if(!targets.length){toast(A.checkPendingDone(0));return;}
  try {
    for(let i=0;i<targets.length;i++){
      checkProgress=A.checkPendingProgress(i+1,targets.length);render();
      try{await ctl.track(targets[i]!.r.cid);}catch{}
    }
    toast(A.checkPendingDone(targets.length));
  } finally {checkProgress=null;await refresh();}
}
function toggleLiveSync() {
  const cid=CID(),next=!isLiveSync();
  S.liveSync=next;LS.set('liveSync',next);
  if(next){
    void ctl.watchRound(cid);
    render();
    void doVerify(cid,{quiet:false});
  }else{
    void ctl.watchRound(shouldWatchRound(cid)?cid:null);
    if(roundTimer&&detail()?.f.module!=='sealed'){clearInterval(roundTimer);roundTimer=null;}
    toast(L().app.syncPausedToast);
    render();
  }
}
const switchLanguage=()=>{
  const next=setLocale(nextLocale(L()));
  try{localStorage.setItem(LANG_KEY_STORAGE,next.key);}catch{}
  LS.set('language',next.key);
  try{
    const url=new URL(location.href);
    if(url.searchParams.has('lang')){url.searchParams.delete('lang');history.replaceState(null,'',url.href);}
  }catch{}
  applyShellLocale();
  chrome();
  render();
  if(modalOpen()){
    const kind=$('mTitle').dataset.modalKind;
    if(kind==='settings')openSettings();
    else if(kind==='wallet')openWallet();
    else if(kind==='help')openHelp();
  }
};
const switchTheme=()=>{
  S.theme=S.theme==='dark'?'light':'dark';
  LS.set('theme',S.theme);
  chrome();
  if(S.view==='round'){lastCanvasKey='';const d=detail();if(d){const ck=shardCanvasKey(d);if(ck){lastCanvasKey=ck;paintShardCanvases($('view'),d,S.theme);}}}
  if(modalOpen()&&$('mTitle').dataset.modalKind==='settings')openSettings();
};
const ACT: Record<string,()=>unknown>={
  closeModal:()=>closeModal(),create:onCreate,join:()=>onJoin(S.join),send:onSend,connectWallet:onConnectWallet,disconnect:onDisconnect,
  applyConn:onApplyConn,testConn:onTestConn,resetConn:onResetConn,switchNet:switchNetwork,switchLang:switchLanguage,switchTheme,openHelp,exportAll:onExportAll,refreshIndex:onRefreshIndex,moreIndex:onMoreIndex,
  toggleSearch:()=>{const open=!(S.searchOpen||!!S.query);S.searchOpen=open;if(!open)S.query='';render();if(open)setTimeout(()=>$('q')?.focus(),0);},
  syncNow:()=>{closeModal();void doVerify(CID(),{quiet:false});},toggleStar:()=>toggleStar(CID()),checkPending:onCheckPending,batchPayout:()=>runBatchSettlement('payout'),batchRefund:()=>runBatchSettlement('refund'),
  moreRound:()=>openRoundTools(CID()),verify:toggleLiveSync,
  track:()=>run(()=>ctl.track(CID())),recover:()=>run(()=>ctl.track(CID(),{recover:true}),{ok:L().app.sendDoneToast}),
  discard:()=>onDiscard(false),discardForce:()=>onDiscard(true),pickFile:()=>$<HTMLInputElement>('sFile').click(),
  pasteLatest:()=>{closeModal();go('explore');setTimeout(()=>$('joinText')?.focus(),50);},
  retryOtherShard:()=>{
    const p=pendingCongestion;closeModal();if(!p)return;
    const rec=buyShardConflicts.get(p.cid);if(rec)rec.count=0;
    void doVerify(p.cid,{quiet:true}).then(()=>refresh()).then(()=>prepareAutoBuyShard(p.cid,p.quantity));
  },
  openNewShard:()=>{
    const p=pendingCongestion;closeModal();if(!p)return;
    buyShardConflicts.delete(p.cid);
    void prepareAndConfirm({action:'BUY',quantity:p.quantity},p.cid);
  },
};
function onClick(ev: Event) {
  const t=(ev.target as Element).closest<HTMLElement>('[data-go2],[data-open],[data-indexed],[data-act],[data-proto-act],[data-fix],[data-filter],[data-sort],[data-proto],[data-dur],[data-durunit],[data-qty],[data-wtab],[data-connect],[data-dtab],[data-shard],[data-purchase],[data-pixelmode],[data-moretx]');
  if(!t)return;const d=t.dataset;
  if(d.protoAct){void prepareAndConfirm({action:d.protoAct,shardCid:d.shardCid??null,recIdx:d.recIdx!=null?Number(d.recIdx):null},S.cid);return;}
  if(d.go2)return go(d.go2);
  if(d.open)return go('round',d.open);
  if(d.indexed)return go('round',d.indexed);
  if(d.filter){S.filter=d.filter;return render();}
  if(d.sort){S.sort=d.sort;return render();}
  if(d.proto&&ctl.protocols.getById(d.proto)){S.form.protocol=d.proto;saveCreateForm();return render();}
  if(d.dur){S.form.dur=d.dur;saveCreateForm();return render();}
  const du=d.durunit;
  if(du==='m'||du==='h'||du==='d'){S.form.customUnit=du;saveCreateForm();return render();}
  if(d.qty){S.qty=d.qty;return render();}
  if(d.wtab){S.wtab=d.wtab;return openWallet();}
  if(d.connect){void connectExternalProvider(d.connect);return;}
  if(d.dtab==='rules'||d.dtab==='map'||d.dtab==='txs'){S.detailTab=d.dtab;return render();}
  if(d.shard){const idx=d.shard==='close'?null:Number(d.shard);S.shard=S.shard===idx?null:idx;S.purchase=null;return render();}
  if(d.purchase){const idx=Number(d.purchase);S.purchase=S.purchase===idx?null:idx;return render();}
  if(d.pixelmode!==undefined){S.pixelMode=d.pixelmode==='1';LS.set('pixelMode',S.pixelMode);return render();}
  if(d.moretx){S.txLimit=d.moretx==='all'?1_000_000:(S.txLimit??20)+Number(d.moretx);return render();}
  if(d.fix)return d.fix==='wallet'?openWallet():openSettings();
  const act=d.act;
  if((act==='share'||act==='export')&&d.round&&/^[0-9a-f]{64}$/.test(d.round)){
    const cid=d.round;closeModal();
    return void run(()=>act==='share'?onShare(cid):onExport(cid));
  }
  if(act&&ACT[act])return void ACT[act]!();
  if(act&&ACTION_INFO[act])return void onAction(act);
}
function onInput(ev: Event) {
  const el=ev.target as HTMLInputElement,id=el.id,v=el.value;
  if(id==='q'){S.query=v;return render();}
  if(id==='joinText'){S.join=v;return;}
  if(id==='cReg'){S.form.registry=el.checked;saveCreateForm();return render();}
  if(id==='cRegAddr'){S.form.registryAddr=v;saveCreateForm();return render();}
  const key=({cPrice:'price',cCap:'cap',cMin:'min',cCustom:'custom'} as Record<string,'price'|'cap'|'min'|'custom'|undefined>)[id];
  if(key){S.form[key]=v;saveCreateForm();return render();}
  if(id==='buyShardSelect'){S.buyShard=v||'auto';return render();}
  if(id==='qty'){
    S.qty=v;const D=detail();if(!D)return;
    const error=qtyError(v,D.f,D.a.BUY),hint=$('qtyCost'),button=$<HTMLButtonElement>('buySubmit'),g=gate('BUY');
    const tu=D.asset&&D.asset.kind!=='KAS'?D.asset.symbol:UNIT;
    const allBusy=!!(D.interactive?.buyShardSelector&&!D.interactive.buyShardSelector.options.length&&!D.interactive.buyShardSelector.canOpenNew);
    hint.textContent=qtyCost(v,D.f,D.a.BUY,tu,D.asset);hint.className=`small ${error?'err':'muted'}`;
    el.setAttribute('aria-invalid',error?'true':'false');
    button.disabled=!!error||allBusy||ctl.state.busy||!D.a.BUY?.ok||(!g.ok&&!g.fix);
  }
}
function bind() {
  deferViewWrite=deferPointerRender($('view'),render);
  initModal();
  $('view').addEventListener('click',onClick);$('view').addEventListener('input',onInput);$('view').addEventListener('change',onInput);
  $('view').addEventListener('keydown',ev=>{const el=(ev.target as HTMLElement).closest?.<HTMLElement>('[data-open],[data-indexed]');if((ev.key==='Enter'||ev.key===' ')&&el){ev.preventDefault();if(el.dataset.open)go('round',el.dataset.open);else if(el.dataset.indexed)go('round',el.dataset.indexed);}});
  $('modal').addEventListener('click',onClick);
  const setMenuOpen=(open: boolean)=>{
    const btn=document.getElementById('menuBtn'),drawer=document.getElementById('menuDrawer'),back=document.getElementById('menuBackdrop');
    if(!btn||!drawer||!back)return;
    if(open){
      const h=Math.round(document.querySelector('header.top')?.getBoundingClientRect().bottom??54);
      drawer.style.top=`${h}px`;back.style.top=`${h}px`;
    }
    btn.setAttribute('aria-expanded',open?'true':'false');
    btn.classList.toggle('open',open);
    drawer.hidden=!open;
    back.hidden=!open;
  };
  const closeMenu=()=>setMenuOpen(false);
  document.querySelectorAll<HTMLElement>('[data-go]').forEach(b=>b.addEventListener('click',()=>{closeMenu();go(b.dataset.go??'explore');}));
  document.addEventListener('click',ev=>{
    const target=ev.target as Element;
    const c=target.closest<HTMLElement>('[data-copy]');
    if(c){ev.stopPropagation();copyText(c.dataset.copy??'').then(()=>toast(L().common.copied),()=>toast(L().common.copyFailed,'warn'));}
  });
  $('walletBtn').onclick=()=>{closeMenu();openWallet();};
  $('settingsBtn').onclick=()=>{closeMenu();openSettings();};
  $('nodeChip').onclick=()=>{closeMenu();openSettings();};
  const footHelp=document.getElementById('footHelpBtn');if(footHelp)footHelp.onclick=openHelp;
  $('settingsBtn').innerHTML=ic('settings').s;
  const menuBtn=document.getElementById('menuBtn');
  if(menuBtn)menuBtn.onclick=()=>setMenuOpen(menuBtn.getAttribute('aria-expanded')!=='true');
  const menuBack=document.getElementById('menuBackdrop');
  if(menuBack)menuBack.onclick=closeMenu;
  const menuSettingsBtn=document.getElementById('menuSettingsBtn');
  if(menuSettingsBtn)menuSettingsBtn.onclick=()=>{closeMenu();openSettings();};
  const menuThemeBtn=document.getElementById('menuThemeBtn');
  if(menuThemeBtn)menuThemeBtn.onclick=switchTheme;
  document.addEventListener('keydown',ev=>{if(ev.key==='Escape')closeMenu();});
  window.addEventListener('hashchange',()=>{closeMenu();route();});
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden){
      if(ctl.state.wallet?.kind==='extension'&&!ctl.state.busy&&!modalOpen()){
        void (ctl.state.wallet as {ping?:()=>Promise<boolean>}).ping?.().then(ok=>{if(!ok)void refresh();});
      }
      if(S.view==='round'&&S.cid){
        detailSyncAt=0;
        void runDetailSync({allowIndexer:true,preferRest:true,immediate:true,rewatch:true});
      }else if(S.view==='explore'){
        void ctl.refreshIndex().then(()=>refresh()).catch(()=>{});
      }
      void pollDaa();void pollDrawProgress();
    }
    render();
  });
  window.addEventListener('pagehide',()=>ctl.disconnectWallet({keepSession:true}));
  // Same-origin tabs share localStorage: follow language / theme / node / service preferences (the live connection is NOT switched silently).
  window.addEventListener('storage',ev=>{
    if(ev.storageArea!==localStorage)return;
    if(ev.key===LANG_KEY_STORAGE){
      setLocale(resolveLocale(localStorage.getItem(LANG_KEY_STORAGE),[...navigator.languages]));
      applyShellLocale();chrome();render();
      if(modalOpen()){
        const kind=$('mTitle').dataset.modalKind;
        if(kind==='settings')openSettings();
        else if(kind==='wallet')openWallet();
      }
      return;
    }
    if(!ev.key?.startsWith(PREFIX))return;
    const k=ev.key.slice(PREFIX.length);
    if(k==='language'){setLocale(resolveLocale(LS.get('language',null),[...navigator.languages]));applyShellLocale();chrome();render();}
    else if(k==='theme'){const v=LS.get('theme',S.theme);if(v==='dark'||v==='light'){S.theme=v;chrome();}}
    else if(k==='nodes')S.nodes=LS.get('nodes',S.nodes);
    else if(k==='indexer')S.indexer=LS.get('indexer',S.indexer);
    else if(k==='touched'){touchedCache=null;rebuild();render();}
    else if(k==='owners'){ownersCache=null;rebuild();render();}
    else if(k==='myTxs'){myTxsCache=null;if(S.view==='mine')render();}
    else if(k==='saved'){savedCids=new Set<string>(LS.get<string[]>('saved',[]));render();}
  });
}

async function runDetailSync({allowIndexer=false,preferRest=false,skipIndexer=false,immediate=false,rewatch=false}: {allowIndexer?: boolean;preferRest?: boolean;skipIndexer?: boolean;immediate?: boolean;rewatch?: boolean}={}) {
  if(detailPolling||indexInitPending||document.hidden||ctl.state.busy||modalOpen()||S.view!=='round'||!S.cid)return;
  const nowMs=Date.now(),targetCid=S.cid;
  const curExisting=items.find(i=>i.r.cid===targetCid);
  const catchingUpExisting=verify.get(targetCid)?.state==='partial';
  if(!isLiveSync()&&curExisting&&!curExisting.r.intent&&!catchingUpExisting){
    if(rewatch)void ctl.watchRound(null);
    return;
  }
  const pollIntervalMs=ctl.state.watchedAddress?15000:3500;
  if(!immediate&&nowMs-detailSyncAt<pollIntervalMs)return;
  detailPolling=true;detailSyncAt=nowMs;
  try{
    const cur=items.find(i=>i.r.cid===targetCid);
    if(cur){
      if(!cur.r.terminal&&!cur.r.halted&&!cur.r.intent&&ctl.state.rpc&&!ctl.state.prepared&&verify.get(targetCid)?.state!=='checking'){
        const catchingUp=verify.get(targetCid)?.state==='partial';
        const staleGap=!catchingUp&&lastDetailOkAt>0&&nowMs-lastDetailOkAt>30000;
        const lastIdxAt=indexerUsedAt.get(targetCid)??0;
        const indexerReady=!!ctl.state.indexer&&(!lastIdxAt||nowMs-lastIdxAt>INDEXER_REUSE_MS);
        const useRemote=!skipIndexer&&!!ctl.state.indexer&&(allowIndexer||staleGap||indexerReady);
        if(useRemote)indexerUsedAt.set(targetCid,nowMs);
        const result=await ctl.syncRound(targetCid,{force:true,timeBudgetMs:catchingUp?8000:5000,skipIndexer:!useRemote,preferRest:preferRest||staleGap});
        if(!result.partial&&!result.skipped)lastDetailOkAt=Date.now();
        if(!result.unchanged&&!result.skipped){
          const prevVerify=verify.get(targetCid);
          if(result.partial||result.source==='rest')verify.set(targetCid,{state:'partial',at:Date.now(),fp:`${conn.nodeUrl??''}|`});
          await refresh();
          const after=items.find(i=>i.r.cid===targetCid);
          if(after&&isNodeVerified(after.r))verify.set(targetCid,{state:result.partial||result.source==='rest'?'partial':'ok',at:Date.now(),fp:fpOf(after.r)});
          else if(prevVerify)verify.delete(targetCid);
          render();
        }
        if(result.partial&&S.view==='round'&&S.cid===targetCid&&!document.hidden&&userVerifyPending!==targetCid){
          detailSyncAt=0;
          setTimeout(()=>{void runDetailSync({preferRest,immediate:true,rewatch});},120);
        }else if(rewatch&&S.view==='round'&&S.cid===targetCid){
          void ctl.watchRound(shouldWatchRound(targetCid)?targetCid:null);
        }
      }else if(cur.r.intent&&ctl.state.rpc&&!ctl.state.prepared&&['SUBMITTED','UNKNOWN','PREPARED'].includes(cur.r.intent.status)&&adapterOf(cur.r)?.viewMeta?.(activeNet)?.shardModel==='parallel'){
        const tr=await ctl.track(targetCid) as {accepted?: boolean}|undefined;
        if(tr?.accepted){
          await refresh();
          const after=items.find(i=>i.r.cid===targetCid);
          if(after&&isNodeVerified(after.r))verify.set(targetCid,{state:'ok',at:Date.now(),fp:fpOf(after.r)});
          void refreshBalance(true);
          render();
        }
      }else if(rewatch){
        void ctl.watchRound(shouldWatchRound(targetCid)?targetCid:null);
      }
    }else{
      if((!previewRound||previewRound.cid!==targetCid)&&!ctl.state.rpc)await hydrateRoundPreview(targetCid);
      if(ctl.state.rpc&&!ctl.isSyncing?.(targetCid)&&verify.get(targetCid)?.state!=='checking'){
        setTimeout(()=>{if(S.view==='round'&&S.cid===targetCid)void autoVerify(targetCid);},0);
      }
      if(rewatch&&S.view==='round'&&S.cid===targetCid)void ctl.watchRound(shouldWatchRound(targetCid)?targetCid:null);
    }
  }catch{if(rewatch&&S.view==='round'&&S.cid===targetCid)void ctl.watchRound(shouldWatchRound(targetCid)?targetCid:null);}
  finally{detailPolling=false;}
}

function installPwaManifest() {
  try {
    const link=document.getElementById('appManifest') as HTMLLinkElement|null;
    if(!link||!/^https?:$/i.test(location.protocol))return;
    const renderIcon=(size: number): string=>{
      const c=document.createElement('canvas');c.width=c.height=size;
      const g=c.getContext('2d');if(!g)return '';
      const s=size/2500;g.scale(s,s);
      g.fillStyle='#70C7BA';
      g.beginPath();g.arc(1250,1250,1200,0,Math.PI*2);g.fill();
      g.fillStyle='#FFFFFF';
      const pts:[number,number][]=[[1575.1,524.7],[1309.9,564.4],[1387.2,1078.6],[831.8,650.1],[668.9,863.3],[1155.4,1237.5],[668.9,1613.7],[831.8,1826.9],[1387.2,1398.4],[1309.9,1912.6],[1575.1,1952.3],[1681.6,1237.5]];
      g.beginPath();pts.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.closePath();g.fill();
      return c.toDataURL('image/png');
    };
    const icon192=renderIcon(192),icon512=renderIcon(512);
    const touchIcon=document.getElementById('appleTouchIcon') as HTMLLinkElement|null;
    if(touchIcon&&icon192)touchIcon.href=icon192;
    const startUrl=location.origin+location.pathname;
    const scope=location.origin+location.pathname.replace(/[^/]*$/,'');
    const manifest={
      id:startUrl,
      name:'Kaswin',
      short_name:'Kaswin',
      description:'Kaswin: decentralized lottery rounds on Kaspa L1 covenants.',
      start_url:startUrl,
      scope,
      display:'standalone',
      orientation:'portrait-primary',
      background_color:'#081119',
      theme_color:S.theme==='dark'?'#081119':'#f4f7f9',
      icons:[
        ...(icon192?[{src:icon192,sizes:'192x192',type:'image/png',purpose:'any maskable'}]:[]),
        ...(icon512?[{src:icon192,sizes:'512x512',type:'image/png',purpose:'any maskable'}]:[]),
      ],
    };
    link.href='data:application/manifest+json;charset=utf-8,'+encodeURIComponent(JSON.stringify(manifest));
  } catch {}
}

async function main() {
  installPwaManifest();
  protocols=buildProtocolRegistryFromBundles(protocolBundles,{defaultCreateProfileId,defaultUiCreateId});
  const defaultAdapter=protocols.defaultForCreate();
  primaryProfileId=defaultAdapter.profileId;
  if(primaryProfileId!==TN10_PROFILE_ID)throw new Error('PROFILE_ID');
  const initSpecs=protocols.createSpecs(activeNet);
  const curProto=S.form.protocol?protocols.getById(S.form.protocol):null;
  if(!curProto||(curProto.supportsNetwork&&!curProto.supportsNetwork(activeNet))){
    S.form.protocol=(initSpecs.find(s=>s.protocolId===protocols.defaultUiCreateId()&&s.supportedOnNet)??initSpecs.find(s=>s.supportedOnNet))?.protocolId??protocols.defaultUiCreateId();
  }
  store=await openStore({genesis:activeNet.genesis,profileId:primaryProfileId});
  ctl=makeController((defaultAdapter.profile as Profile|undefined)??{id:primaryProfileId},store,activeNet,discoveryCache,protocols);
  await ctl.restoreDiscovery();
  conn.discoveredSource=ctl.state.discoveredSource??null;
  ctl.onChange(schedule);bind();
  await refresh();route();void connectAuto();
  // Reconcile pending submissions and re-verify candidates in the background (query only; resend is always an explicit click).
  // A submitted-but-unresolved transaction is looked up every tick (2.5 s) so its acceptance shows up quickly; balances and
  // time-based buttons are refreshed every 8 s.
  setInterval(()=>{void runDetailSync();},1500);
  let lastSlow=0,polling=false;
  setInterval(async()=>{
    if(polling||ctl.state.busy||modalOpen())return;
    polling=true;
    try {
      const rounds=items.map(i=>i.r),waiting=rounds.find(r=>['SUBMITTED','UNKNOWN','PREPARED'].includes(r.intent?.status??'')),slow=!document.hidden&&Date.now()-lastSlow>=8000;
      if(!waiting&&!slow)return;
      if(slow)lastSlow=Date.now();
      const target=waiting??(document.hidden?undefined:rounds.find(r=>r.pending.length>0));
      if(target&&ctl.state.rpc){try{await ctl.track(target.cid);}catch{}await refresh();void refreshBalance(true);}
      else if(slow)void pollDaa();
      if(slow)void refreshBalance();
    } catch(e){ctl.log('warn',`后台刷新未完成：${errCode(e)}；稍后重试`);}
    finally{polling=false;}
  },2500);
}
main().catch(e=>{
  const A=L().app;
  put($('view'),html`<div class="panel"><h2>${A.fatalStartTitle}</h2><div class="notice bad">${A.fatalStartBody}</div></div>`);
  void e;
});
