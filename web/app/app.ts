/** Browser entry for the rolling TN10 page (user-facing). Wiring only: all protocol behaviour lives in controller.mjs, all markup in views.mjs.
 * No console output; interpolated text is escaped by html``; the private key lives in the wallet closure, its input is emptied as soon as it is
 * read, and everything is wiped on disconnect / pagehide. localStorage holds only non-sensitive preferences. */
import {DRAW_DELAY,TIMEOUT_DELAY} from '../../scripts/core.mjs';
import {profileData} from '@kaswin/rolling-profile';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {loadProfile,openStore,makeController,describeRound,availableActions,shardCatalog,verifyDrawReceipt,identify,commonUtxos,pubkeyToAddress,connectNetwork,createIndexerClient,readDrawProgress} from './bridge.ts';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';
import {chooseLanguage,getLanguage,setLanguage,installLocalization} from '../ui/i18n.mjs';
import {EN} from '../ui/messages-en.mjs';
import {parseNodeList} from './settings.ts';
import {deferPointerRender} from '../ui/interaction.ts';
import {availableExtensionWallets} from '../../scripts/wallet/extension-wallet.mjs';
import {isMobileBrowser,KASPIRE_WAKE_LINK,renderPairingQrDataUrl,triggerAppLink,warmKaspireClient} from '../../scripts/wallet/kaspire-wallet.mjs';
import {indexerBase} from '../../scripts/round/indexer-client.mjs';
import {formatTkas,shortHash} from '../ui/format.mjs';
import {TN10_PROFILE_ID} from '../../scripts/contract/protocol.mjs';
import {$,put,html,ic,toast,copyText,download,modal,closeModal,lockModal,initModal,modalOpen} from '../ui/ui.ts';
import {ACTION_INFO,errText,errCode,phaseOf} from '../ui/messages.ts';
import {exploreView,createView,roundView,roundToolsBody,mineView,rulesView,walletBody,settingsBody,confirmBody,parseCreate,qtyCost,qtyError} from '../ui/views.ts';
import {drawReadiness} from '../ui/draw-readiness.ts';
import type {Raw} from '../ui/ui.ts';
import {makeShare,parseShare} from './share.ts';
import type {Ctx,ConfirmCtx,Conn,Controller,Detail,DiscoveryCacheLike,DiscoveryCacheSnapshot,DrawProgress,DrawResult,Explorer,Facts,Gate,Hex,Holdings,Item,MineData,NetInfo,Prepared,Profile,Receipt,Round,RoundStoreLike,RpcLike,ShardView,SubmissionProgress,UiState,VerifyState,WalletView} from './types.ts';

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
setLanguage(chooseLanguage(LS.get('language',null),[...navigator.languages]));
const refreshLanguage=installLocalization(document,{
  messages:EN,
  titles:activeNet.key==='mainnet'
    ?{en:'Kaswin Rolling · Kaspa Mainnet','zh-CN':'Kaswin Rolling · Kaspa 主网'}
    :{en:'Kaswin Rolling · Testnet 10 experiment','zh-CN':'Kaswin Rolling · Testnet 10 实验版'},
  descriptions:activeNet.key==='mainnet'
    ?{en:'Kaswin Rolling: lottery rounds with rolling purchase shards on Kaspa mainnet. Review tickets, fees and each step before approving a transaction.','zh-CN':'Kaswin Rolling：Kaspa 主网不限购买笔数的抽奖轮次。查看票款、费用和每一步，再确认你的交易。'}
    :{en:'Kaswin Rolling (Testnet 10 experiment): lottery rounds with rolling purchase shards. Review tickets, fees and each step before approving a Kaspa testnet transaction.','zh-CN':'Kaswin Rolling（Testnet 10 实验版）：不限购买笔数的抽奖轮次。查看票款、费用和每一步，再确认你的 Kaspa 测试网交易。'},
});
const defaultNode=activeNet.web.nodes.join('\n');
const defaultIndexer=activeNet.web.indexer;
const initialIndexer=((): string=>{
  const saved=LS.get<string|null>('indexer',null);
  if(saved===null)return defaultIndexer;
  if(activeNet.key==='mainnet'&&saved.replace(/\/+$/,'')==='https://indexer.kaspay.top/mainnet')return defaultIndexer;
  // Migrate the previous Profile-qualified API on the same host; preserve explicitly configured hosts and empty opt-out.
  return saved.replace(/\/+$/,'').replace(`/rolling/v1/${TN10_PROFILE_ID}`,'');
})();
const ex: Explorer={
  tx:(id: string)=>`${EX}/transactions/${id}`,addr:(a: string)=>`${EX}/addresses/${a}`,
  addrOfKey:(k: string|null)=>k?pubkeyToAddress(k,ADDR_PREFIX):null,
  addrOfScript:(s: string)=>{const m=/^20([0-9a-f]{64})ac$/.exec(s);return m?pubkeyToAddress(m[1] as string,ADDR_PREFIX):shortHash(s,10,6);},
};
const S: UiState={view:'explore',cid:null,filter:'all',sort:'new',query:'',qty:'1',join:'',wtab:'extension',theme:LS.get('theme','dark'),shard:null,purchase:null,txLimit:20,budgetPc:32,
  form:{price:'1',cap:'100',min:'3',dur:'60',custom:'',registry:true,...LS.get<Partial<UiState['form']>>('form',{})},nodes:LS.get('nodes',defaultNode),indexer:initialIndexer,walletProvider:LS.get('walletProvider','kasware')};
const conn: Conn={node:null,nodeUrl:null,indexer:null,indexerUrl:null,indexerStale:false,discoveredSource:null};
const verify=new Map<string,VerifyState>();
let savedCids=new Set<string>(LS.get<string[]>('saved',[]));
let checkProgress: string|null=null,roundTimer: ReturnType<typeof setInterval>|null=null,daaObservedAt=0;
let drawObservation: {rpc: RpcLike; key: string; value: DrawProgress}|null=null,drawReading=false,drawReadAt=0;
let profile: Profile,store: RoundStoreLike,ctl: Controller,items: Item[]=[],daa: bigint|null=null,balance: bigint|null=null,balanceAt=0,renderQueued=false,lastBusy=false,lastHtml='',refreshSeq=0,daaPolling=false,lastRounds: Round[]=[],settingsOpened={nodes:'',indexer:''};
let shardCache: {key: string;shards: ShardView[]|null}={key:'',shards:null};
const itemCache=new Map<string,{fp: string;item: Item}>();
const drawCache=new Map<string,DrawResult>(),drawTried=new Set<string>();
const canSign=(wallet: WalletView|null): boolean=>!!wallet&&(wallet.kind==='key'||wallet.kind==='extension');
let submission: SubmissionProgress|null=null;
let lastWallet: WalletView|null=null;
let previewRound: Round|null=null,previewSeq=0;
let detailSyncAt=0,detailPolling=false,lastDetailOkAt=0;

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
function buildItem(r: Round,d: bigint|null,t: Record<string,number>,own: Record<string,string>): Item {
  const daaKey=r.terminal?'':(d??'');
  const fp=[r.step,r.terminal??'',r.manager?`${r.manager.outpoint.transactionId}:${r.manager.outpoint.index}`:'-',r.frozen.length,r.intent?.status??'',r.halted??'',r.pending?.length??0,daaKey,t[r.cid]??0,own[r.cid]??''].join('|');
  const cached=itemCache.get(r.cid);
  if(cached&&cached.fp===fp&&cached.item.r===r)return cached.item;
  let f: Partial<Facts>,a: Item['a'];
  try {f=describeRound(r,profile,d);a=availableActions(r,profile,d??0n);}
  catch {f={module:null};a=Object.fromEntries(Object.keys(ACTION_INFO).map(k=>[k,{ok:false,reason:'本机记录无法按固定 Profile 解析'}]));}
  const st=r.settings;
  // Rules come from the creation settings; a finished round has no manager UTXO any more, so its total comes from the recorded buys.
  const facts: Facts={module:null,ticketPrice:st.ticketPrice,ticketCap:st.ticketCap,minTickets:st.minTickets,closeEligibleDaa:st.closeEligibleDaa,shards:0,localRecords:0,owner:own[r.cid]??null,winnerKey:null,payCursor:null,refundShard:null,...f,
    tickets:f.tickets??(r.terminal?r.bought:0)};
  if(!facts.owner)facts.owner=own[r.cid]??null;   // the owner is only readable while the round has a manager UTXO; later it comes from the cache below
  const value=r.manager?r.manager.value+r.frozen.reduce((n: bigint,x)=>n+x.value,0n):0n;
  const item: Item={r,f: facts,a,ph:phaseOf(r,facts),value,at:t[r.cid]??0};
  itemCache.set(r.cid,{fp,item});
  return item;
}
/** Tickets the connected wallet holds in the open shards (sales / sealed only; finished shards no longer exist as UTXOs). */
function holdings(it: Item,shards: ShardView[]|null=null): Holdings|null {
  const key=ctl.state.wallet?.key,{r,f}=it;
  if(!key||!r.manager||!['sales','sealed'].includes(f.module??''))return null;
  if(shards){
    let mine=0,total=0;
    for(const s of shards){mine+=s.mineCount;total+=s.tickets;}
    return {tickets:mine,total};
  }
  try {
    let mine=0,total=0;
    const add=(recs: {end: number;key: string}[])=>{let prev=0;for(const x of recs){const c=x.end-prev;prev=x.end;total+=c;if(x.key===key)mine+=c;}};
    const m=identify(r.manager.redeemScript,profile);if(m.module==='frozen')return null;add(m.records);
    for(const z of r.frozen){const s=identify(z.redeemScript,profile);add(s.records);}
    return {tickets:mine,total};
  } catch {return null;}
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
  lastRounds=rs;rebuild();
  if(previewRound&&items.some(i=>i.r.cid===previewRound!.cid))previewRound=null;
  const ls=ctl.state.lastSynced;
  if(ls&&S.cid===ls.cid&&Date.now()-ls.at<10000){
    const it=items.find(i=>i.r.cid===ls.cid);
    if(it&&!it.r.intent){
      const syncedFp=[ls.nodeUrl,ls.managerOutpoint,ls.step,ls.frozen,''].join('|');
      if(fpOf(it.r)===syncedFp)verify.set(ls.cid,{state:'ok',at:ls.at,fp:syncedFp});
    }
  }
  render();
  void pollDaa();
  if(S.view==='round'&&S.cid){void autoVerify(S.cid);void resolveDrawHint(S.cid);void pollDrawProgress();}
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
    let value: DrawProgress;
    try {value=await readDrawProgress(rpc,D.r);}
    catch {value={phase:'UNAVAILABLE',requiredConfirmations:100n,observedAt:Date.now()};}
    if(rpc===ctl.state.rpc&&S.view==='round'&&S.cid===D.r.cid&&drawKey(detail()?.r??D.r)===key){drawObservation={rpc,key,value};render();}
  } finally {drawReading=false;}
}
function gate(a: string): Gate {
  const c=ctl.state,free=!!ACTION_INFO[a]?.free;
  if(!store.persistent)return {ok:false,reason:'这个浏览器没有可用的本地存储，无法安全发送。请换用普通（非隐私）窗口。'};
  if(!c.rpc)return {ok:false,reason:'节点未连接。',fix:'settings'};
  if(S.view==='round'&&S.cid&&!items.some(i=>i.r.cid===S.cid))return {ok:false,reason:'正在向节点核对链上状态，核对完成后即可操作。'};
  if(!c.wallet)return {ok:false,reason:free?'需要一个收款地址来领取奖励。':'需要先连接钱包。',fix:'wallet'};
  if(!free&&!canSign(c.wallet))return {ok:false,reason:'这一步需要能签名的钱包支付手续费。',fix:'wallet'};
  if(c.busy)return {ok:false,reason:`正在${c.busyLabel??'处理上一步'}，请稍候。`};
  return {ok:true};
}
const shardsFor=(it: Item): ShardView[]|null=>{
  const wk=ctl.state.wallet?.key??'',key=[it.r.cid,it.r.terminal??'',it.r.manager?`${it.r.manager.outpoint.transactionId}:${it.r.manager.outpoint.index}`:'-',it.r.step,it.r.frozen.length,it.r.history?'h':'',wk].join('|');
  if(shardCache.key===key)return shardCache.shards;
  let shards: ShardView[]|null=null;
  try{shards=shardCatalog(it.r,profile,wk||null);}catch{shards=null;}
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
  const cachedDraw=it.r.draw??drawCache.get(it.r.cid)??null;
  const r=cachedDraw&&!it.r.draw?{...it.r,draw:cachedDraw}:it.r;
  const shards=shardsFor(it);
  return {...it,r,preview:isPreview,mine:holdings(it,shards),isWinner:!!it.f.winnerKey&&it.f.winnerKey===ctl.state.wallet?.key,shards};
};
async function hydrateRoundPreview(cid: string) {
  if(items.some(i=>i.r.cid===cid))return;
  const seq=++previewSeq;
  const cached=await ctl.cachedPreview(cid);
  if(seq!==previewSeq||S.view!=='round'||S.cid!==cid||items.some(i=>i.r.cid===cid))return;
  if(cached&&(!previewRound||previewRound.cid!==cid||cached.step>previewRound.step)){previewRound=cached;render();}
  if(ctl.state.rpc&&verify.get(cid)?.state==='checking')return;
  const fresh=await ctl.loadPreview(cid);
  if(seq!==previewSeq||S.view!=='round'||S.cid!==cid||items.some(i=>i.r.cid===cid))return;
  if(fresh&&(!previewRound||previewRound.cid!==cid||fresh.step>=previewRound.step||!!fresh.terminal)){previewRound=fresh;render();}
}
function mineData(): MineData|null {
  const w=ctl.state.wallet;if(!w)return null;
  const myTxSet=new Set(myTxs()[w.key]??[]);
  const rounds: MineData['rounds']=[],txs: {cid: Hex; t: Receipt}[]=[];
  for(const i of items){
    const created=i.f.owner===w.key,won=!!i.f.winnerKey&&i.f.winnerKey===w.key;
    let shards: ShardView[]|null=null;
    try{shards=shardCatalog(i.r,profile,w.key);}catch{shards=null;}
    const tickets=shards?shards.reduce((n,s)=>n+s.mineCount,0):0;
    const hasMyTx=i.r.receipts.some(t=>myTxSet.has(t.txid))||(!!i.r.intent?.txid&&myTxSet.has(i.r.intent.txid));
    if(created||won||tickets>0||hasMyTx)rounds.push({item:i,tickets,created,won});
    const myBuyTxids=new Set<string>();
    if(shards){
      const buys=i.r.receipts.filter(t=>t.action==='BUY');
      let offset=0,total=0,ok=true;
      for(const s of shards){if(s.recordCount==null){ok=false;break;}total+=s.recordCount;}
      if(ok&&buys.length===total){
        for(const s of shards){
          if(s.records)for(const rec of s.records)if(rec.mine){const rc=buys[offset+rec.index];if(rc)myBuyTxids.add(rc.txid);}
          offset+=s.recordCount??0;
        }
      }
    }
    for(const t of i.r.receipts){
      if(myTxSet.has(t.txid)||(t.action==='GENESIS'&&created)||(t.action==='BUY'&&myBuyTxids.has(t.txid)))txs.push({cid:i.r.cid,t});
    }
  }
  return {rounds,txs:txs.reverse().slice(0,100)};
}
async function resolveDrawHint(cid: string) {
  const it=items.find(i=>i.r.cid===cid);const rpc=ctl.state.rpc;
  if(!it||!rpc||it.r.draw||drawCache.has(cid)||drawTried.has(cid)||!it.r.receipts.some(t=>t.action==='DRAW'))return;
  drawTried.add(cid);
  try{const d=await verifyDrawReceipt(it.r,rpc,profile);if(d){drawCache.set(cid,d);if(S.view==='round'&&S.cid===cid)render();}}catch{}
}
const observedDrawProgress=(): DrawProgress|null=>{
  const r=items.find(i=>i.r.cid===S.cid)?.r;
  return r&&drawObservation?.rpc===ctl.state.rpc&&drawObservation.key===drawKey(r)?drawObservation.value:null;
};
const ctxt=(): Ctx=>{conn.discoveredSource=ctl.state.discoveredSource??null;return {net:activeNet,items,S,wallet:ctl.state.wallet,balance,daa,conn,busy:ctl.state.busy,ex,logs:ctl.state.logs,gate,detail:S.view==='round'?detail():null,
  mine:S.view==='mine'?mineData():null,verify:verifyFor(S.cid),discovered:ctl.state.discovered,indexerMore:ctl.state.indexerCursor!==null,walletOptions:availableExtensionWallets(),saved:savedCids,checkProgress,submission,daaObservedAt,drawProgress:observedDrawProgress()};};

/* ------------------------------------------------------------------ render */
interface Focus {id: string;s: number|null;e: number|null}
function captureFocus(): Focus|null {const a=document.activeElement as HTMLInputElement|null;return a&&a.id&&$('view').contains(a)?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null;}
function restoreFocus(f: Focus|null) {if(!f)return;const el=$<HTMLInputElement>(f.id);if(!el)return;el.focus({preventScroll:true});try{el.setSelectionRange(f.s,f.e);}catch{}}
let lastFooterKey='',lastThemeIcon='';
function chrome() {
  const ok=conn.node===true,bad=conn.node===false,chip=$('nodeChip');
  const label=ok?'已连接':bad?'节点连接失败，点此处理':'连接中…';
  (chip.querySelector('.dot') as HTMLElement).className='dot '+(ok?'ok':bad?'bad':'warn');
  (chip.lastChild as ChildNode).textContent=`${activeNet.label} · ${label}`;
  const netBtn=document.getElementById('netBtn');
  if(netBtn)netBtn.textContent=`${activeNet.key==='mainnet'?'Mainnet':'Testnet 10'} ⇄`;
  const footerNet=document.getElementById('footerNet'),fk=`${activeNet.key}|${profile?.id??TN10_PROFILE_ID}`;
  if(footerNet&&fk!==lastFooterKey){lastFooterKey=fk;put(footerNet,html`${activeNet.label} · ${UNIT} · 节点核对共识 · Profile <span class="mono" id="profileId">${profile?.id??TN10_PROFILE_ID}</span>`);}
  const w=ctl?.state.wallet,b=$('walletBtn');
  b.className='wbtn'+(w?' on':'');
  b.textContent=w?`${shortHash(w.address,14,4)}${canSign(w)&&balance!=null?` · ${formatTkas(balance)} ${UNIT}`:w.kind==='public'?' · 仅收款':''}`:'连接钱包';
  document.querySelectorAll<HTMLElement>('.nav [data-go]').forEach(n=>{if(n.dataset.go===(S.view==='round'?'explore':S.view))n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});
  document.documentElement.dataset.theme=S.theme;
  const themeColor=document.getElementById('themeColorMeta');
  if(themeColor)themeColor.setAttribute('content',S.theme==='dark'?'#081119':'#f4f7f9');
  const themeLabel=S.theme==='dark'?'切换为浅色模式':'切换为深色模式';
  if(lastThemeIcon!==S.theme){lastThemeIcon=S.theme;$('themeBtn').innerHTML=ic(S.theme==='dark'?'sun':'moon').s;}
  $('themeBtn').setAttribute('aria-label',themeLabel);$('themeBtn').title=themeLabel;
  $('languageBtn').textContent=getLanguage()==='en'?'中文':'EN';
}
function syncRoundTimer(x: Ctx) {
  const mod=x.detail?.f.module;
  const need=S.view==='round'&&!document.hidden&&!!ctl.state.rpc&&(mod==='sealed'||(mod==='sales'&&!x.detail?.a.CLOSE?.ok));
  if(need&&!roundTimer)roundTimer=setInterval(()=>{if(!document.hidden){void pollDaa();if(S.view==='round'&&detail()?.f.module==='sealed'){void pollDrawProgress();render();}}},1000);
  else if(!need&&roundTimer){clearInterval(roundTimer);roundTimer=null;}
}
function render() {
  const focus=captureFocus();
  let body: Raw;
  try {
    const x=ctxt();
    syncRoundTimer(x);
    body=S.view==='create'?createView(x):S.view==='round'?roundView(x):S.view==='mine'?mineView(x):S.view==='protocol'?rulesView(x):exploreView(x);
  } catch(e) {
    // One malformed record must not blank the whole page: say so, keep navigation alive.
    body=html`<div class="notice bad"><b>这一页显示失败</b>（${(e as Error)?.name??'Error'}）。通常是导入的数据格式异常，其他页面不受影响；重新导入原始数据即可恢复。<div class="btnrow"><button class="btn sm" data-go2="explore">返回轮次列表</button></div></div>`;
  }
  const out=html`${store.persistent?'':html`<div class="notice bad">这个浏览器没有可用的本地存储（可能是隐私窗口）：为避免“发出后没有记录”，已禁止发送交易。请换用普通窗口。</div>`}${body}`;
  // Periodic refreshes often produce identical markup: skip the DOM write so <details>, scroll and selection are left alone.
  if(out.s!==lastHtml&&!deferViewWrite()){lastHtml=out.s;put($('view'),out);restoreFocus(focus);}
  chrome();
}
const schedule=()=>{
  if(lastWallet!==ctl.state.wallet){
    const had=!!lastWallet;lastWallet=ctl.state.wallet;balance=null;
    if(had&&!lastWallet&&!ctl.state.busy&&modalOpen()&&$('mTitle').dataset.sourceTitle?.startsWith('确认交易')){closeModal();toast('钱包连接已变化，请重新连接并报价。','warn');}
  }
  // Button availability comes from controller state, not the next asynchronous IndexedDB snapshot.
  // Paint foreground busy transitions now; reconcile round data separately. Background checks never set busy.
  if(lastBusy!==ctl.state.busy){lastBusy=ctl.state.busy;render();}
  if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;refresh().catch(()=>{});});
};

/* ------------------------------------------------------------------ navigation */
const VIEWS=['explore','create','mine','protocol','round'];
function route() {
  if(location.hash.startsWith('#join=')){const code=location.href;history.replaceState(null,'',location.pathname+'#/explore');S.view='explore';S.cid=null;S.shard=null;S.purchase=null;S.txLimit=20;previewRound=null;void ctl.watchRound(null);render();void onJoin(code);return;}
  const m=/^#\/(\w+)(?:\/([0-9a-f]{64}))?$/.exec(location.hash);
  const nextView=m&&VIEWS.includes(m[1])?m[1]:'explore',nextCid=m?.[2]??null;
  if(nextView!==S.view||nextCid!==S.cid){S.shard=null;S.purchase=null;S.txLimit=20;if(previewRound?.cid!==nextCid)previewRound=null;if(nextView==='round'&&nextCid)verify.delete(nextCid);}
  S.view=nextView;S.cid=nextCid;if(S.view==='round'&&!S.cid)S.view='explore';
  if(S.view!=='round')previewRound=null;
  void ctl.watchRound(S.view==='round'?S.cid:null);
  if(S.view==='round'&&S.cid){touch(S.cid);void hydrateRoundPreview(S.cid);void autoVerify(S.cid);void resolveDrawHint(S.cid);void pollDrawProgress();}
  render();
}
function go(view: string,cid: string|null=null) {
  if(view==='round'&&cid)verify.delete(cid);
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
  if(errCode(e)==='WALLET_FUNDS_INSUFFICIENT'&&action==='REFUND_SELF') {
    toast(`${errText(e)} 这一步退款不一定需要付手续费：可以在钱包里改用「仅收款地址」再试，奖励会发到那个地址。`,'bad');return;
  }
  if(errCode(e)==='STALE_INPUT') {
    modal('这一轮的状态已更新',html`<p>${errText(e)}</p>`,html`<button class="btn" data-act="closeModal">知道了</button>${S.cid?html`<button class="btn pri" data-act="syncNow">同步最新状态</button>`:html`<button class="btn pri" data-act="pasteLatest">粘贴最新分享链接</button>`}`);
  } else toast(errText(e),'bad');
}
/** A verification result only counts for the node and round state it was obtained for: importing different data over the same CID (file or link), a state
 * change, or switching node makes the fingerprint differ, so a stale green tick can never describe data it did not check. */
const fpOf=(r: Round): string=>[conn.nodeUrl??'',r.manager?`${r.manager.outpoint.transactionId}:${r.manager.outpoint.index}`:'-',r.step,r.frozen.length,r.intent?.status??''].join('|');
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
  if(it&&(it.r.terminal||it.r.intent))return;
  if(!it&&!/^[0-9a-f]{64}$/.test(cid))return;
  if(!it&&S.indexer.trim()&&conn.indexer===null&&!conn.indexerStale)return;
  await doVerify(cid);
}
async function doVerify(cid: string,{quiet=true}: {quiet?: boolean}={}) {
  const it=items.find(i=>i.r.cid===cid);
  const fp=it?fpOf(it.r):'loading';
  const prev=verify.get(cid);
  if(!quiet||!prev||prev.state==='bad'){verify.set(cid,{state:'checking',fp});render();}
  try {
    const res=await ctl.syncRound(cid,{lookup:!it,allowHalted:true,force:true,timeBudgetMs:6000});
    await refresh();
    const after=items.find(i=>i.r.cid===res.cid);
    if(res.skipped){
      verify.delete(cid);
    }else if(res.partial||res.source==='rest'){
      verify.set(res.cid,{state:'partial',at:Date.now(),fp:after?fpOf(after.r):fp});
      if(res.partial){detailSyncAt=0;setTimeout(()=>{void runDetailSync({immediate:true,skipIndexer:true});},120);}
      if(!quiet)toast(`已先同步 ${res.steps??0} 步最新状态，后台将继续追赶`);
    }else{
      lastDetailOkAt=Date.now();
      verify.set(res.cid,{state:'ok',at:Date.now(),fp:after?fpOf(after.r):fp});
      if(res.cid!==cid&&S.view==='round'&&S.cid===cid){touch(res.cid);go('round',res.cid);return;}
      if(!quiet)toast(res.steps&&res.steps>0?`已向节点核对并追赶 ${res.steps} 步最新状态`:'已向节点核对：状态与链上一致');
    }
  } catch(e) {
    if(errCode(e)==='BUSY'){verify.delete(cid);if(!quiet)toast(errText(e),'warn');}   // another operation is running: not a verdict
    else {verify.set(cid,{state:'bad',code:errCode(e),fp});if(!quiet)failure(e);}
  }
  render();
}
function saveCreateForm() {
  const f=S.form,raw=(f.registryAddr??'').trim().toLowerCase();
  const customAddr=raw&&raw!==activeNet.registry.address?f.registryAddr:undefined;
  LS.set('form',{price:f.price,cap:f.cap,min:f.min,dur:f.dur,custom:f.custom,registry:f.registry!==false,registryAddr:customAddr});
}
function planText(p: Prepared): string {
  const fee=formatTkas(p.review.fee),n=p.targetCount,hasReg=p.review.outputs.some(o=>o.role==='REGISTRATION');
  const text: Record<string,string>={
    GENESIS:`创建新轮次：锁定 4 ${UNIT} 押金${hasReg?`并附带 0.2 ${UNIT} 索引登记输出`:'（不附带索引登记输出）'}，规则创建后不可修改。网络费 ${fee} ${UNIT}。`,
    BUY:`购买 ${p.op.quantity} 张票，票款进入合约，另付网络费 ${fee} ${UNIT}。如果别人抢先操作了这一轮，这笔交易会被节点拒绝，不会扣款。`,
    CLOSE:`封盘：结束售票，由票数决定开奖、退款或退还押金。发起者承担网络费 ${fee} ${UNIT}。`,
    DRAW:`开奖：按链上证明抽出中奖票，结果由合约校验。发起者承担网络费 ${fee} ${UNIT}。`,
    TIMEOUT:`转入退款：封盘后已超过约 12 小时无人开奖。发起者承担网络费 ${fee} ${UNIT}。`,
    PAY_OLD:`派奖：处理 ${n} 个已封存分片，票款并入奖金；你获得 ${n} ${UNIT} 执行奖励，网络费 ${fee} ${UNIT} 从奖池扣。`,
    PAY_SELF:`派奖结算：奖金付给中奖者，押金退回创建者；你获得 1 ${UNIT} 执行奖励，网络费 ${fee} ${UNIT} 从奖池扣。`,
    REFUND_OLD:`退款：处理一个封存分片的一批购买记录（最多 32 条），每条扣 0.02 ${UNIT} 执行费；执行费池扣除网络费后归你。`,
    REFUND_SELF:`退款：退还当前分片剩余的购买记录，创建者取回押金。执行费池扣除网络费后归你。`,
  };
  return text[p.op.action]??'';
}
async function prepareAndConfirm(choice: Record<string,unknown>,cid: string|null) {
  lockModal(true);
  modal('准备交易',html`<ul class="progress"><li class="run">正在核对链上状态、用脚本引擎测量预算并计算网络费…</li></ul><p class="small muted">通常几秒，最长可能几十秒。请不要关闭页面。</p>`);
  try {await ctl.prepare(choice,cid);}
  catch(e) {lockModal(false);closeModal();failure(e,String(choice.action??''));await refresh();return;}
  lockModal(false);showConfirm();
}
function showConfirm() {
  const p: Prepared|null=ctl.state.prepared,w=ctl.state.wallet;if(!p||!w)return;
  const x: ConfirmCtx={...ctxt(),prepared:p,planText:planText(p)};
  modal(`确认交易 · ${ACTION_INFO[p.op.action]?.title??p.op.action}`,confirmBody(x),
    html`<button class="btn" data-act="closeModal">取消</button><button class="btn pri" data-act="send">${p.review.inputs.some(i=>i.kind.includes('需签名'))?'确认并签名发送':'确认发送（无需签名）'}</button>`,
    {onClose:()=>{if(ctl.state.prepared){ctl.discardPrepared();render();}}});
}
async function onSend() {
  const p: Prepared|null=ctl.state.prepared;if(!p){closeModal();toast('报价已失效，请重新核对。','warn');return;}
  const {cid}=p,genesis=p.op.action==='GENESIS',signerKey=ctl.state.wallet?.key??null,creatorKey=genesis?signerKey:null,txid=p.review?.txid??null;
  lockModal(true);$('mFoot').hidden=true;
  const isKaspire=ctl.state.wallet?.id==='kaspire',needsSig=p.review.inputs.some(i=>i.kind.includes('需签名'));
  put($('mBody'),html`<ul class="progress"><li class="run">${ctl.state.wallet?.kind==='extension'&&needsSig?`请在 ${ctl.state.wallet.name??'扩展钱包'} 中确认签名；页面随后验签、检查、保存并提交…`:'正在核对签名、检查已签名交易、保存记录并提交…'}</li></ul>${isKaspire&&needsSig?html`<div class="btnrow" style="margin:8px 0"><a class="btn sm" href="${KASPIRE_WAKE_LINK}">打开 Kaspire 确认签名</a></div>`:''}<p class="small muted">请不要关闭页面。</p>`);
  let status: string;
  try {
    status=await ctl.signAndSend({onSigned:()=>{
      submission={cid,action:p.op.action,txid};
      lockModal(false);closeModal();go('round',cid);
    }});
  }
  catch(e) {
    if(submission?.cid===cid)submission={...submission,error:errText(e)};
    lockModal(false);closeModal();toast(errText(e),'bad');await refresh();return;
  }
  lockModal(false);closeModal();
  if(status==='SUBMITTED')toast('已提交，等待节点确认。确认前页面会自动更新。');
  else if(status==='REJECTED'){
    const rejectedKind=classifyRejection(items.find(i=>i.r.cid===cid)?.r.intent).kind;
    toast(rejectedKind==='ROUND_INPUT'?'交易被节点拒绝：这一轮已被抢先推进，正在自动同步最新状态…':'交易被节点拒绝。详情见轮次页。','bad');
  }
  else if(status==='UNSENT')toast('交易没有发出，请重试。','warn');
  else toast('提交结果暂未确认，页面会自动核对，请不要重复操作。','warn');
  touch(cid);verify.delete(cid);
  if(signerKey&&txid&&status!=='UNSENT'&&status!=='REJECTED')recordMyTx(signerKey,txid);
  if(creatorKey&&status!=='UNSENT'){const own=owners();own[cid]=creatorKey;LS.set('owners',own);}   // readable from the manager only while the round is live
  await refresh();
  submission=null;render();
  if(status==='REJECTED'&&!genesis&&classifyRejection(items.find(i=>i.r.cid===cid)?.r.intent).kind==='ROUND_INPUT')void doVerify(cid,{quiet:true});
  void refreshBalance(true);
  if(status!=='UNSENT'&&status!=='REJECTED')void ctl.track(cid).then(refresh,()=>{});
}
async function onAction(a: string) {
  if(modalOpen())return;
  if(ctl.state.busy){toast(`正在${ctl.state.busyLabel??'处理上一步'}，请稍候。`,'warn');return;}
  const choice: Record<string,unknown>={action:a};
  if(a==='BUY'){
    const D=detail();if(!D){toast('没有找到这一轮。','warn');return;}
    const error=qtyError(S.qty,D.f,D.a.BUY);if(error){toast(error,'warn');return;}
    choice.quantity=S.qty.trim();
  }
  if(a==='DRAW'){
    const D=detail();if(!D)return;
    const readiness=drawReadiness(D,ctxt());if(!readiness.ready){toast(readiness.detail,'warn');void pollDrawProgress();return;}
  }
  await prepareAndConfirm(choice,S.cid);
}
async function onCreate() {
  const p=parseCreate(S.form,activeNet);if(!p.ok){toast(p.errors[0],'warn');return;}
  const w=ctl.state.wallet;
  if(!canSign(w)){if(w)toast('当前是「仅收款地址」，创建轮次需要能签名的钱包。','warn');openWallet();return;}
  await prepareAndConfirm({action:'GENESIS',registry:p.registry,settings:{ticketPrice:S.form.price.trim(),ticketCap:S.form.cap.trim(),minTickets:S.form.min.trim(),closeMinutes:String(p.mins)}},null);
}
async function onJoin(input: unknown) {
  if(typeof input==='string'&&/^[0-9a-f]{64}$/i.test(input.trim())){
    const id=input.trim().toLowerCase();
    S.join='';touch(id);verify.delete(id);go('round',id);return;
  }
  try {
    const text=await parseShare(input),cid=await ctl.importText(text);
    touch(cid);verify.delete(cid);S.join='';toast('已加入这一轮，正在向节点核对…');await refresh();go('round',cid);
  } catch(e) {toast(errText(e),'bad');}
}
async function onRefreshIndex(){
  try{
    if(!ctl.state.indexer&&S.indexer.trim()){
      const err=await connectIndexerPart(S.indexer.trim());
      if(!err){await refresh();toast('已从索引刷新列表');return;}
    }
    const res=await ctl.refreshIndex() as {fallbackFrom?: unknown;skipped?: string}|undefined;
    conn.indexerStale=!!ctl.state.indexerInfo?.stale||!!res?.fallbackFrom;
    conn.discoveredSource=ctl.state.discoveredSource??null;
    await refresh();
    if(!res?.skipped)toast(conn.discoveredSource==='rest'?'已从 REST 备选刷新列表':'已从索引刷新列表');
  }
  catch(e){conn.indexerStale=!!ctl.state.indexer||!!S.indexer.trim();conn.discoveredSource=ctl.state.discoveredSource??null;toast(errText(e),'warn');render();}
}
async function onMoreIndex(){try{await ctl.moreIndex();await refresh();}catch(e){toast(errText(e),'warn');}}
function openRoundTools(cid: string) {
  modal('更多轮次操作',roundToolsBody(cid),html`<button class="btn" data-act="closeModal">关闭</button>`);
}
async function onShare(cid: string) {
  const text=await ctl.exportText(cid),code=await makeShare(text),link=`${location.origin}${location.pathname}#join=${code}`;
  try {await copyText(link);toast(link.length>6000?'分享链接已复制（较长，部分聊天软件可能截断；也可以用「导出」发送文件）':'分享链接已复制');}
  catch {toast('复制失败，请改用「导出」','warn');}
}
async function onExport(cid: string) {download(`kaswin-rolling-${cid.slice(0,12)}.json`,await ctl.exportText(cid));}
async function onExportAll() {
  const rounds: string[]=[];for(const r of await ctl.rounds())rounds.push(await ctl.exportText(r as unknown as string));
  if(!rounds.length){toast('还没有轮次可导出','warn');return;}
  download('kaswin-rolling-rounds.json',JSON.stringify({kind:'KASWIN_ROLLING_BUNDLE',rounds}));
}
async function onImportFile(file: File|undefined) {
  if(!file||file.size>5_000_000){toast('文件为空或太大','warn');return;}
  const text=await file.text();let n=0;
  try {
    let list: unknown[]=[text];
    if(text.trimStart().startsWith('{')){const o=JSON.parse(text) as {kind?: string;rounds?: unknown};if(o?.kind==='KASWIN_ROLLING_BUNDLE'&&Array.isArray(o.rounds)&&o.rounds.length<=200)list=o.rounds;}
    for(const t of list){const cid=await ctl.importText(String(t));verify.delete(cid);n++;}
    toast(`已导入 ${n} 个轮次，页面会向节点重新核对`);
  } catch(e) {toast(errText(e),'bad');}
  await refresh();
}
let balanceInflight: Promise<void>|null=null;
async function refreshBalance(force=false) {
  const w=ctl.state.wallet,rpc=ctl.state.rpc;
  if(!w||!canSign(w)||!rpc){balance=null;return;}
  if(!force&&Date.now()-balanceAt<30000)return;
  if(balanceInflight)return balanceInflight;
  balanceAt=Date.now();
  balanceInflight=(async()=>{
    try {balance=(await commonUtxos(rpc,w.address)).filter(u=>!u.isCoinbase&&!u.covenantId).reduce((n,u)=>n+u.value,0n);}catch{balance=null;}
    chrome();if(modalOpen()&&$('mTitle').dataset.sourceTitle==='钱包')openWallet();else render();
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
  const nodes=nodesOrEmpty(S.nodes);
  const nodeTask=(async()=>{
    if(nodes.length)await connectNodePart(nodes);else conn.node=false;   // a stored value that no longer validates counts as a failed node, not a crash
    chrome();await refresh();void refreshBalance(true);
    if(S.view==='round'&&S.cid&&items.some(i=>i.r.cid===S.cid))void autoVerify(S.cid);
  })();
  const indexTask=(async()=>{
    let idxErr: unknown=null;
    if(S.indexer.trim())idxErr=await connectIndexerPart(S.indexer.trim());
    if(!S.indexer.trim()||idxErr){try{await ctl.refreshIndex();}catch{}}
    conn.discoveredSource=ctl.state.discoveredSource??null;
    if(S.cid&&verify.get(S.cid)?.fp==='loading'&&verify.get(S.cid)?.state==='bad')verify.delete(S.cid);
    if(S.view==='round'&&S.cid&&!items.some(i=>i.r.cid===S.cid))void hydrateRoundPreview(S.cid);
    chrome();await refresh();
  })();
  await Promise.all([nodeTask,indexTask]);
  if(S.view==='round'&&S.cid)void autoVerify(S.cid);   // an imported or deep-linked round opened before the node/indexer was ready
}
function openSettings() {
  settingsOpened={nodes:S.nodes,indexer:S.indexer};   // what this dialog was opened with: only fields the user actually edits are saved
  modal('高级设置',settingsBody(ctxt()),html`<button class="btn" data-act="testConn">${ic('refresh')}测试连接</button><button class="btn" data-act="resetConn">恢复默认</button><button class="btn pri" data-act="applyConn">保存</button><button class="btn" data-act="closeModal">关闭</button>`);
  $<HTMLInputElement>('sFile').onchange=ev=>{const el=ev.target as HTMLInputElement;void onImportFile(el.files?.[0]);el.value='';};
}
function openWallet() {
  const x=ctxt(),w=x.wallet;
  if(!w)warmKaspireClient();
  modal('钱包',walletBody(x),w?html`<button class="btn warn" data-act="disconnect">断开钱包</button><button class="btn" data-act="closeModal">关闭</button>`
    :html`<button class="btn" data-act="closeModal">取消</button><button class="btn pri" data-act="connectWallet">连接</button>`);
}
/** Error text next to the field that caused it (dialogs hide page-level feedback); falls back to a toast when the slot is gone. */
function inlineError(id: string,text: string) {
  const el=document.getElementById(id);
  if(el)el.textContent=text;else toast(text,'bad');
}
async function onConnectWallet() {
  if(ctl.state.busy){inlineError('wErr','正在处理上一步，请稍候。');return;}
  try {
    if(S.wtab==='key'){
      if(activeNet.key==='mainnet')throw Object.assign(new Error('MAINNET_MEMORY_KEY_DISABLED'),{code:'MAINNET_MEMORY_KEY_DISABLED'});
      const el=$<HTMLInputElement>('wKey'),v=el.value;el.value='';ctl.openWallet(v);
    }
    else if(S.wtab==='extension'){
      const id=$<HTMLSelectElement>('wProvider').value;
      if(id==='kaspire'){
        const abort=new AbortController();
        const cancel=()=>{abort.abort();lockModal(false);closeModal();};
        lockModal(true);
        put($('mBody'),html`<ul class="progress"><li class="run">正在连接 WalletConnect 中继，准备 Kaspire 配对…</li></ul><p class="small muted">如果已有授权会话将直接恢复，否则会显示拉起链接与二维码。</p>`);
        put($('mFoot'),html`<button class="btn" id="kaspireCancel">取消</button>`);
        $('kaspireCancel').onclick=cancel;
        try {
          await ctl.connectExternalWallet('kaspire',{
            signal:abort.signal,
            onPairingUri:async({wcUri,schemeUri,appLink}:{wcUri: string;schemeUri: string;appLink: string})=>{
              if(abort.signal.aborted)return;
              let qr='';
              try{qr=await renderPairingQrDataUrl(appLink);}catch{}
              if(abort.signal.aborted)return;
              put($('mBody'),html`
                <p class="sub" style="margin-top:0">请使用手机 <b>Kaspire</b> 钱包授权连接（请在 Kaspire 中切换到 <b>${activeNet.label}</b>）：</p>
                ${qr?html`<div style="display:flex;justify-content:center;margin:12px 0"><img src="${qr}" alt="Kaspire 配对二维码" style="width:200px;height:200px;border-radius:10px;background:#fff;padding:8px"></div>`:''}
                <div class="btnrow" style="justify-content:center;margin-top:10px">
                  <a class="btn pri" href="${schemeUri}">打开 Kaspire 授权连接</a>
                  <button class="btn" type="button" data-copy="${wcUri}">复制配对链接</button>
                </div>
                <p class="small muted" style="text-align:center;margin-top:10px">等待 Kaspire 确认中…（最长 2 分钟）</p>`);
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
        lockModal(true);try{await ctl.connectExternalWallet(id);}finally{lockModal(false);}
      }
      S.walletProvider=id;LS.set('walletProvider',id);
    } else ctl.usePublicAddress($<HTMLInputElement>('wAddr').value);
  } catch(e) {inlineError('wErr',errText(e));return;}   // a toast would sit behind the open dialog
  closeModal();toast('钱包已连接');void refreshBalance(true);render();
}
function onDisconnect() {ctl.disconnectWallet();balance=null;closeModal();toast('钱包已断开');render();}
/** Validate -> try to connect -> save ONLY what connected, and only the fields that were edited. A bad value never replaces a working configuration, and a
 * dialog opened earlier in another tab cannot overwrite a field it did not change (the old code wrote both fields back). */
function onResetConn() {
  $<HTMLTextAreaElement>('sNodes').value=defaultNode;
  $<HTMLInputElement>('sIndexer').value=defaultIndexer;
  inlineError('sErr','');
  const probe=$('sProbe');if(probe)put(probe,html``);
  toast('已填入默认地址，点「保存」后生效');
}
async function onTestConn() {
  inlineError('sErr','');
  const probe=$('sProbe');if(!probe)return;
  put(probe,html`<div class="notice">正在测试连接…</div>`);
  const parts: Raw[]=[];
  try {
    const urls=parseNodeList($<HTMLTextAreaElement>('sNodes').value,defaultNode);
    const t0=Date.now();
    const rpc=await connectNetwork(urls,activeNet);
    try {
      const d=await rpc.currentDaa();
      parts.push(html`<div class="notice ok">节点可用：<b>${rpc.url??urls[0]}</b>（${activeNet.label} 已同步，含 UTXO 索引 · DAA ${String(d)} · ${Date.now()-t0} ms）</div>`);
    } finally {rpc.close?.();}
  } catch(e) {
    parts.push(html`<div class="notice warn">节点：${errText(e)}</div>`);
  }
  try {
    const raw=$<HTMLInputElement>('sIndexer').value.trim();
    if(!raw)parts.push(html`<div class="notice">索引：未配置，将使用 REST API 备用查询。</div>`);
    else {
      const baseUrl=indexerBase(raw),client=createIndexerClient({baseUrl,networkId:activeNet.networkId,genesisHash:activeNet.genesis,profileId:profile.id}),info=await client.info();
      const cnt=info.roundsCount??(await client.rounds({limit:100})).rounds.length;
      parts.push(html`<div class="notice ok">索引可用：共 ${cnt} 个轮次${info.stale?'（索引正在追赶）':''}。</div>`);
    }
  } catch(e) {
    parts.push(html`<div class="notice warn">索引：${errText(e)}</div>`);
  }
  if($('sProbe'))put($('sProbe'),html`${parts}`);
}
async function onApplyConn() {
  const nodesText=$<HTMLTextAreaElement>('sNodes').value,indexText=$<HTMLInputElement>('sIndexer').value;
  const nodesChanged=nodesText.trim()!==settingsOpened.nodes.trim(),indexChanged=indexText.trim()!==settingsOpened.indexer.trim();
  const problems: string[]=[];let newNodes: string[]|null=null,newIndex: string|null=null;
  try {if(nodesChanged)newNodes=parseNodeList(nodesText,defaultNode);} catch(e) {problems.push(errText(e));}
  try {if(indexChanged)newIndex=indexText.trim()?indexerBase(indexText):'';} catch(e) {problems.push(errText(e));}
  if(problems.length){inlineError('sErr',problems.join(' '));return;}
  if(newNodes){
    const previous=nodesOrEmpty(S.nodes),err=await connectNodePart(newNodes);
    if(!err){S.nodes=newNodes.join('\n');LS.set('nodes',S.nodes);}
    else{problems.push(`节点没有保存：${errText(err)}已保留原配置。`);if(previous.length)await connectNodePart(previous);}
  }
  if(newIndex!==null){
    const err=await connectIndexerPart(newIndex);
    if(!err){S.indexer=newIndex;LS.set('indexer',newIndex);if(!newIndex){try{await ctl.refreshIndex();}catch{}}conn.discoveredSource=ctl.state.discoveredSource??null;}
    else problems.push(`索引地址没有保存：${errText(err)}已保留原配置。`);
  }
  if(!nodesChanged&&!indexChanged)await connectAuto();   // nothing edited: just re-check the current configuration
  chrome();await refresh();void refreshBalance(true);
  if(modalOpen()&&$('mTitle').dataset.sourceTitle==='高级设置'){
    openSettings();
    if(problems.length){   // keep what the user typed so it can be corrected
      $<HTMLTextAreaElement>('sNodes').value=nodesText;$<HTMLInputElement>('sIndexer').value=indexText;inlineError('sErr',problems.join(' '));
    } else toast('连接成功，设置已保存');
  }
}
/** Drop the pending intent. SEARCH_RANGE (the node can no longer search that far back) needs an explicit second confirmation for the forced path. */
async function onDiscard(force=false) {
  const cid=CID();
  try {
    const kind=classifyRejection(items.find(i=>i.r.cid===cid)?.r.intent).kind; // read before discarding: only the node's own wording decides which advice applies
    await ctl.discard(cid,{force});
    if(force)closeModal();
    toast(kind==='FUNDS_INPUT'||kind==='ORPHAN'?'已放弃这笔交易。等几秒、让前一笔确认后，重新操作即可。':'已放弃这笔交易。请导入最新的分享链接后继续。');
  } catch(e) {
    if(!force&&errCode(e)==='SEARCH_RANGE') {
      const txid=items.find(i=>i.r.cid===cid)?.r.intent?.txid;
      modal('无法自动确认这笔交易',html`<p>${errText(e)}</p>
        <p>如果这笔交易的输入已经全部被花掉，你可以「强制放弃」：页面只在 <b>所有输入都已被花掉、内存池里也没有这笔交易</b> 时才会执行，放弃后请导入最新的分享链接。不会新建任何替代交易。</p>
        ${txid?html`<p class="small muted">交易 ID：<span class="mono">${txid}</span></p>`:''}
        <p class="small muted">如果还有输入没被花掉，页面会直接判定这笔交易从未成功，那种情况下请用「重新发送（原签名）」或普通的「放弃这笔」。</p>`,
        html`<button class="btn" data-act="closeModal">取消</button><button class="btn warn" data-act="discardForce">强制放弃</button>`);
    } else {if(force)closeModal();toast(errText(e),'bad');}
  } finally {await refresh();}
}

/* ------------------------------------------------------------------ events */
const CID=(): string=>S.cid as string;   // only reachable from the round page, where the route guarantees a cid
function toggleStar(cid: string) {
  if(savedCids.has(cid)){savedCids.delete(cid);toast('已取消关注');}
  else{savedCids.add(cid);toast('已添加到「★ 关注」');}
  LS.set('saved',[...savedCids]);
  render();
}
async function onCheckPending() {
  if(checkProgress||ctl.state.busy)return;
  if(!ctl.state.rpc){toast('节点未连接。','warn');return;}
  const targets=items.filter(i=>(i.r.pending?.length??0)>0||(!!i.r.intent&&['SUBMITTED','UNKNOWN'].includes(i.r.intent.status))).slice(0,20);
  if(!targets.length){toast('没有待确认的交易');return;}
  try {
    for(let i=0;i<targets.length;i++){
      checkProgress=`核对中 ${i+1}/${targets.length}…`;render();
      try{await ctl.track(targets[i]!.r.cid);}catch{}
    }
    toast(`已完成 ${targets.length} 个轮次的待确认核对`);
  } finally {checkProgress=null;await refresh();}
}
const ACT: Record<string,()=>unknown>={
  closeModal:()=>closeModal(),create:onCreate,join:()=>onJoin(S.join),send:onSend,connectWallet:onConnectWallet,disconnect:onDisconnect,
  applyConn:onApplyConn,testConn:onTestConn,resetConn:onResetConn,switchNet:switchNetwork,exportAll:onExportAll,refreshIndex:onRefreshIndex,moreIndex:onMoreIndex,
  syncNow:()=>{closeModal();void doVerify(CID(),{quiet:false});},toggleStar:()=>toggleStar(CID()),checkPending:onCheckPending,
  moreRound:()=>openRoundTools(CID()),verify:()=>doVerify(CID(),{quiet:false}),
  track:()=>run(()=>ctl.track(CID())),recover:()=>run(()=>ctl.track(CID(),{recover:true}),{ok:'已核对输入并重发原签名'}),
  discard:()=>onDiscard(false),discardForce:()=>onDiscard(true),pickFile:()=>$<HTMLInputElement>('sFile').click(),
  pasteLatest:()=>{closeModal();go('explore');setTimeout(()=>$('joinText')?.focus(),50);},
};
function onClick(ev: Event) {
  const t=(ev.target as Element).closest<HTMLElement>('[data-go2],[data-open],[data-indexed],[data-act],[data-fix],[data-filter],[data-sort],[data-dur],[data-qty],[data-wtab],[data-shard],[data-purchase],[data-moretx]');
  if(!t)return;const d=t.dataset;
  if(d.go2)return go(d.go2);
  if(d.open)return go('round',d.open);
  if(d.indexed)return go('round',d.indexed);
  if(d.filter){S.filter=d.filter;return render();}
  if(d.sort){S.sort=d.sort;return render();}
  if(d.dur){S.form.dur=d.dur;saveCreateForm();return render();}
  if(d.qty){S.qty=d.qty;return render();}
  if(d.wtab){S.wtab=d.wtab;return openWallet();}
  if(d.shard){const idx=d.shard==='close'?null:Number(d.shard);S.shard=S.shard===idx?null:idx;S.purchase=null;return render();}
  if(d.purchase){const idx=Number(d.purchase);S.purchase=S.purchase===idx?null:idx;return render();}
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
  if(id==='budgetPc'){S.budgetPc=Number(v);return render();}
  if(id==='cReg'){S.form.registry=el.checked;saveCreateForm();return render();}
  if(id==='cRegAddr'){S.form.registryAddr=v;saveCreateForm();return render();}
  const key=({cPrice:'price',cCap:'cap',cMin:'min',cCustom:'custom'} as Record<string,keyof UiState['form']|undefined>)[id];
  if(key&&key!=='registry'){S.form[key]=v;saveCreateForm();return render();}
  if(id==='qty'){
    S.qty=v;const D=detail();if(!D)return;
    const error=qtyError(v,D.f,D.a.BUY),hint=$('qtyCost'),button=$<HTMLButtonElement>('buySubmit'),g=gate('BUY');
    hint.textContent=qtyCost(v,D.f,D.a.BUY,UNIT);hint.className=`small ${error?'err':'muted'}`;
    el.setAttribute('aria-invalid',error?'true':'false');
    button.disabled=!!error||ctl.state.busy||!D.a.BUY?.ok||(!g.ok&&!g.fix);
  }
}
function bind() {
  deferViewWrite=deferPointerRender($('view'),render);
  initModal();
  $('view').addEventListener('click',onClick);$('view').addEventListener('input',onInput);
  $('view').addEventListener('keydown',ev=>{const el=(ev.target as HTMLElement).closest?.<HTMLElement>('[data-open],[data-indexed]');if((ev.key==='Enter'||ev.key===' ')&&el){ev.preventDefault();if(el.dataset.open)go('round',el.dataset.open);else if(el.dataset.indexed)go('round',el.dataset.indexed);}});
  $('modal').addEventListener('click',onClick);
  document.querySelectorAll<HTMLElement>('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go??'explore')));
  document.addEventListener('click',ev=>{
    const target=ev.target as Element;
    const c=target.closest<HTMLElement>('[data-copy]');
    if(c){ev.stopPropagation();copyText(c.dataset.copy??'').then(()=>toast('已复制'),()=>toast('复制失败','warn'));}
  });
  $('walletBtn').onclick=openWallet;$('settingsBtn').onclick=openSettings;$('nodeChip').onclick=openSettings;
  const netBtn=document.getElementById('netBtn');if(netBtn)netBtn.onclick=switchNetwork;
  $('githubBtn').innerHTML=ic('github').s;
  $('settingsBtn').innerHTML=ic('settings').s;
  $('themeBtn').onclick=()=>{S.theme=S.theme==='dark'?'light':'dark';LS.set('theme',S.theme);chrome();};
  $('languageBtn').onclick=()=>{
    setLanguage(getLanguage()==='en'?'zh-CN':'en');LS.set('language',getLanguage());
    refreshLanguage();$('languageBtn').textContent=getLanguage()==='en'?'中文':'EN';
  };
  window.addEventListener('hashchange',route);
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden){
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
    if(ev.storageArea!==localStorage||!ev.key?.startsWith(PREFIX))return;
    const k=ev.key.slice(PREFIX.length);
    if(k==='language'){setLanguage(chooseLanguage(LS.get('language',null),[...navigator.languages]));refreshLanguage();$('languageBtn').textContent=getLanguage()==='en'?'中文':'EN';}
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
  if(detailPolling||document.hidden||ctl.state.busy||modalOpen()||S.view!=='round'||!S.cid)return;
  const nowMs=Date.now(),targetCid=S.cid;
  const pollIntervalMs=ctl.state.watchedAddress?15000:3500;
  if(!immediate&&nowMs-detailSyncAt<pollIntervalMs)return;
  detailPolling=true;detailSyncAt=nowMs;
  try{
    const cur=items.find(i=>i.r.cid===targetCid);
    if(cur){
      if(!cur.r.terminal&&!cur.r.halted&&!cur.r.intent&&ctl.state.rpc&&!ctl.state.prepared&&verify.get(targetCid)?.state!=='checking'){
        const catchingUp=verify.get(targetCid)?.state==='partial';
        const staleGap=!catchingUp&&lastDetailOkAt>0&&nowMs-lastDetailOkAt>30000;
        const useRemote=!skipIndexer&&(allowIndexer||staleGap);
        const result=await ctl.syncRound(targetCid,{force:true,timeBudgetMs:catchingUp?8000:5000,skipIndexer:!useRemote,preferRest:preferRest||staleGap});
        if(!result.partial&&!result.skipped)lastDetailOkAt=Date.now();
        if(!result.unchanged&&!result.skipped){
          const prevVerify=verify.get(targetCid);
          if(result.partial||result.source==='rest')verify.set(targetCid,{state:'partial',at:Date.now(),fp:`${conn.nodeUrl??''}|`});
          await refresh();
          const after=items.find(i=>i.r.cid===targetCid);
          if(after)verify.set(targetCid,{state:result.partial||result.source==='rest'?'partial':'ok',at:Date.now(),fp:fpOf(after.r)});
          else if(prevVerify)verify.delete(targetCid);
          render();
        }
        if(result.partial&&S.view==='round'&&S.cid===targetCid&&!document.hidden){
          detailSyncAt=0;
          setTimeout(()=>{void runDetailSync({preferRest,skipIndexer:true,immediate:true,rewatch});},120);
        }else if(rewatch&&S.view==='round'&&S.cid===targetCid){
          void ctl.watchRound(targetCid);
        }
      }else if(rewatch){
        void ctl.watchRound(targetCid);
      }
    }else{
      if(!previewRound||previewRound.cid!==targetCid)await hydrateRoundPreview(targetCid);
      if(ctl.state.rpc&&!ctl.isSyncing?.(targetCid)&&verify.get(targetCid)?.state!=='checking'){
        setTimeout(()=>{if(S.view==='round'&&S.cid===targetCid)void autoVerify(targetCid);},0);
      }
      if(rewatch&&S.view==='round'&&S.cid===targetCid)void ctl.watchRound(targetCid);
    }
  }catch{if(rewatch&&S.view==='round'&&S.cid===targetCid)void ctl.watchRound(targetCid);}
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
      name:'Kaswin Rolling',
      short_name:'Kaswin',
      description:'Kaswin Rolling: decentralized lottery rounds on Kaspa L1 covenants.',
      start_url:startUrl,
      scope,
      display:'standalone',
      orientation:'portrait-primary',
      background_color:'#081119',
      theme_color:S.theme==='dark'?'#081119':'#f4f7f9',
      icons:[
        ...(icon192?[{src:icon192,sizes:'192x192',type:'image/png',purpose:'any maskable'}]:[]),
        ...(icon512?[{src:icon512,sizes:'512x512',type:'image/png',purpose:'any maskable'}]:[]),
      ],
    };
    link.href='data:application/manifest+json;charset=utf-8,'+encodeURIComponent(JSON.stringify(manifest));
  } catch {}
}

async function main() {
  installPwaManifest();
  profile=loadProfile(profileData);                 // the browser re-derives the Profile id (assertProfile)
  if(profile.id!==TN10_PROFILE_ID)throw new Error('PROFILE_ID');
  store=await openStore({genesis:activeNet.genesis,profileId:profile.id});
  ctl=makeController(profile,store,activeNet,discoveryCache);
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
      if(target&&ctl.state.rpc){try{await ctl.track(target.cid);}catch{}await refresh();}
      else if(slow)void pollDaa();
      if(slow)void refreshBalance();
    } catch(e){ctl.log('warn',`后台刷新未完成：${errCode(e)}；稍后重试`);}
    finally{polling=false;}
  },2500);
}
main().catch(e=>{
  (document.getElementById('view') as HTMLElement).innerHTML='<div class="panel"><h2>页面无法启动</h2><div class="notice bad">合约 Profile 或本地存储初始化失败；页面不会在未验证 Profile 的情况下运行。</div></div>';
  void e;
});
