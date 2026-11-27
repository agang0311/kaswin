/** Pure views for Kaswin: data + Locale in, HTML out. No controller, node, wallet or storage access; every action is a data-* hook
 * that app.ts binds. Completely covenant-agnostic: all protocol differences come from ProtocolCreateSpec, ProtocolViewMeta,
 * CompatibleProfile, RoundInteractiveModel, AssetDescriptor, AssetDelta, and ReceiptMatcherLike. */
import {drawReadiness} from './draw-readiness.ts';
import {recomputeDrawProof,buildPythonVerifyScript} from '../app/draw-verify.ts';
import {html,raw,ic} from './ui.ts';
import type {Raw} from './ui.ts';
import {ACTION_INFO,actionTitle,roleLabel,terminalLabel,errText} from './messages.ts';
import {formatTkas,parseTkas,shortHash} from './format.mjs';
import {getLocale,resolveLocale,localizeActionReason,localizeReviewInputKind,localizeReviewNote} from './locales/index.ts';
import type {Locale} from './locales/index.ts';
import {TN10_PROFILE_ID,TN10_ROLLING_REGISTRY} from '../../scripts/contract/protocol.mjs';
import {
  MAX_TICKETS,
  addressToSpk,
  defaultSequentialCreateSpec,
  formatAssetAmount,
  matchBuyReceiptAuto,
  matchRefundReceiptAuto,
  shardRefundReceiptsAuto,
} from '../app/bridge.ts';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';
import type {
  ActionState,
  AssetDescriptor,
  CompatibleProfile,
  ConfirmCtx,
  CreateForm,
  Ctx,
  Detail,
  DiscoveredRound,
  Facts,
  Intent,
  Item,
  NetInfo,
  Phase,
  ProtocolCreateSpec,
  Receipt,
  Round,
  ShardRecordView,
  ShardSettlementModel,
  ShardStatus,
  ShardView,
  VerifyState,
} from '../app/types.ts';

/** Protocol ceiling for one round's total tickets (state.ts MAX_TICKETS = 10,000,000); purchase count is separately capped at 256 sealed shards x 256 records = 65,536. */
export const MAX_TICKET_CAP=MAX_TICKETS;
export const MAX_SHARDS=256;
/** Largest round exercised on Testnet 10 so far (4,355 tickets / 17 sealed shards PAID; 771 tickets / 3 sealed shards REFUNDED). */
export const VERIFIED_TICKET_CAP=4355;
export const DEPOSIT_TKAS='4';
const locOf=(x?: Pick<Ctx,'L'|'lang'>|null): Locale=>x?.L??(x?.lang?resolveLocale(x.lang):getLocale());
const unitOf=(x?: {net?: {unit?: string}}|null): string=>x?.net?.unit??'KAS';
const kas=(v: bigint): string=>formatTkas(v);
const isTokenAsset=(a?: AssetDescriptor|null): a is AssetDescriptor & {kind: Exclude<AssetDescriptor['kind'],'KAS'>}=>!!a&&a.kind!=='KAS';
const fmtAmt=(v: bigint,a?: AssetDescriptor|null): string=>isTokenAsset(a)?formatAssetAmount(v,a,{maxFrac:a.decimals}):kas(v);
const signing=(w: Ctx['wallet']): boolean=>!!w&&(w.kind==='key'||w.kind==='extension');
/** Receipt fees come from stored / imported data: a malformed value shows a dash instead of aborting the render. */
const feeText=(v: unknown): string=>{try{return kas(BigInt(v as string));}catch{return '—';}};
const hash=(v: string|null|undefined,{n=10,link=null,L=getLocale()}: {n?: number;link?: string|null;L?: Locale}={}): Raw|string=>v?html`<span class="hash"><span class="mono">${link?html`<a class="hash-link" href="${link}" target="_blank" rel="noopener noreferrer">${shortHash(v,n,6)}</a>`:shortHash(v,n,6)}</span><button class="copy" data-copy="${v}" aria-label="${L.common.copy}" title="${L.common.copy}">${ic('copy')}</button></span>`:'—';
const kpi=(label: string,value: unknown,sub: unknown='')=>html`<div class="kpi"><small>${label}</small><strong>${value}</strong>${sub?html`<span>${sub}</span>`:''}</div>`;
const wait=(daa: bigint|null,until: bigint,L: Locale): string=>daa==null?L.format.waitNeedDaa:daa>=until?L.format.waitNow:L.format.waitAbout(L.format.daaDuration(until-daa));
const isFree=(a: string): boolean=>!!ACTION_INFO[a]?.free;

const compatOf=(x: Ctx|undefined,ref?: {profileId?: string|null;protocolId?: string|null}|null): CompatibleProfile|null=>{
  const list=x?.compatibleProfiles;if(!list?.length||!ref)return null;
  if(ref.profileId){const byPid=list.find(p=>p.profileId===ref.profileId);if(byPid)return byPid;}
  if(ref.protocolId){const byId=list.find(p=>p.protocolId===ref.protocolId);if(byId)return byId;}
  return null;
};
const assetOfDisc=(d: DiscoveredRound|undefined,x?: Ctx): AssetDescriptor|undefined=>d?.asset??compatOf(x,d)?.assetDescriptor;

/* ------------------------------------------------------------------ explore */
function stepText(i: Item,x: Ctx,L: Locale): string {
  const {r,f}=i,E=L.explore;
  if(r.terminal)return L.actions.stepTerminal[r.terminal]??L.actions.phaseLabel.done;
  if(r.halted)return E.stepHalted;
  if(r.intent||(r.pending??[]).length)return E.stepPending;
  if(!r.manager){
    if(f.module==='win')return E.stepShardWin;
    if(f.module==='refund')return E.stepShardRefund;
    return E.stepAwaitingGenesis;
  }
  const manager=r.manager;
  if(f.module==='sales')return x.daa!=null&&x.daa<f.closeEligibleDaa&&f.tickets<f.ticketCap?E.stepSalesWait(wait(x.daa,f.closeEligibleDaa,L)):E.stepSalesReady;
  if(f.module==='sealed')return E.stepSealedWait(wait(x.daa,manager.utxoDaa+100n,L));
  if(f.module==='win')return E.stepPayingShard(f.payCursor??0,f.shards);
  return E.stepRefundShard(f.refundShard??0,f.shards);
}
const safeBig=(v: string|null|undefined): bigint=>{try{return v!=null?BigInt(v):0n;}catch{return 0n;}};
function indexedPhase(d: DiscoveredRound,L: Locale): Phase {
  const p=L.actions.phaseLabel;
  if(d.terminal){
    if(d.terminal==='PAID')return {key:'paid',label:p.paid,tone:'gold'};
    if(d.terminal==='EMPTY')return {key:'empty',label:p.empty,tone:'muted'};
    if(d.terminal==='REFUNDED')return {key:'refunded',label:p.refunded,tone:'muted'};
    return {key:'done',label:terminalLabel(d.terminal,L),tone:'muted'};
  }
  if(d.module==='sales')return {key:'open',label:p.open,tone:'mint'};
  if(d.module==='sealed')return {key:'sealed',label:p.sealed,tone:'violet'};
  if(d.module==='win')return {key:'paying',label:p.paying,tone:'gold'};
  if(d.module==='refund')return {key:'refund',label:p.refund,tone:'amber'};
  if(d.phase==='CLOSING'){
    const cursor=Number((d.protocolData as Record<string,unknown>|undefined)?.cursor??d.settlementProgress?.done??0);
    return cursor<=0?{key:'open',label:p.open,tone:'mint'}:{key:'open',label:p.closing,tone:'mint'};
  }
  if(d.phase==='OPEN')return {key:'open',label:p.open,tone:'mint'};
  if(d.phase==='SEALED')return {key:'sealed',label:p.sealed,tone:'violet'};
  if(d.phase==='SETTLING')return {key:'paying',label:p.paying,tone:'gold'};
  if(d.phase==='REFUNDING')return {key:'refund',label:p.refund,tone:'amber'};
  if(d.phase==='DONE')return {key:'done',label:p.done,tone:'muted'};
  return {key:'open',label:p.active,tone:'mint'};
}
function indexedStep(d: DiscoveredRound,ph: Phase,L: Locale): string {
  const E=L.explore;
  if(d.terminal)return L.actions.stepTerminal[d.terminal]??L.actions.phaseLabel.done;
  if(ph.key==='open')return E.indexedStepOpen;
  if(ph.key==='sealed')return E.indexedStepSealed;
  if(ph.key==='paying')return E.indexedStepPaying;
  if(ph.key==='refund')return E.indexedStepRefund;
  return E.indexedStepDefault;
}
function isDiscFresher(i: Item,d: DiscoveredRound|undefined): d is DiscoveredRound {
  if(!d||i.r.terminal||i.r.intent||i.r.halted)return false;
  if(d.terminal)return true;
  const dt=d.ticketsSold??d.tickets;
  if(dt!=null&&i.f.tickets!=null&&dt>i.f.tickets)return true;
  if(d.buys!=null&&d.buys>i.r.receipts.filter(t=>t.action==='BUY'||t.action==='OPEN_SHARD').length)return true;
  return !!(d.module&&i.f.module&&d.module!==i.f.module&&!(i.f.module==='sealed'&&d.module==='sales'));
}
function localizePhase(ph: Phase,L: Locale): Phase {
  const p=L.actions.phaseLabel;
  const map: Record<string,string>={paid:p.paid,empty:p.empty,refunded:p.refunded,open:p.open,sealed:p.sealed,paying:p.paying,refund:p.refund,done:p.done,halted:p.halted};
  return map[ph.key]?{...ph,label:map[ph.key]!}:ph;
}
function card(i: Item,x: Ctx,freshDisc?: DiscoveredRound): Raw {
  const L=locOf(x),E=L.explore;
  const {r,f}=i,ph=freshDisc?indexedPhase(freshDisc,L):localizePhase(i.ph,L),price=f.ticketPrice;
  const asset=freshDisc?(assetOfDisc(freshDisc,x)??i.asset):i.asset;
  const isToken=isTokenAsset(asset);
  const tickets=freshDisc?(freshDisc.terminal?(freshDisc.bought??freshDisc.ticketsSold??freshDisc.tickets??f.tickets):(freshDisc.ticketsSold??freshDisc.tickets??f.tickets)):f.tickets;
  const isTerminal=!!(r.terminal||freshDisc?.terminal);
  const showCap=f.ticketCap>0&&f.ticketCap<65536;
  const have=tickets!=null,pct=have&&showCap?Math.min(100,tickets/f.ticketCap*100):isTerminal?100:0;
  const cta=L.actions.cardCta[ph.key]??L.common.viewDetails,u=isToken?asset.symbol:unitOf(x);
  const starred=!!x.saved?.has(r.cid);
  return html`<article class="card t-${ph.tone}" data-open="${r.cid}" tabindex="0" role="button" aria-label="${E.openRoundAria(shortHash(r.cid))}">
    <div class="row"><span class="badge t-${ph.tone}">${ph.label}</span><span class="badge asset-badge">${u}</span><span class="spacer"></span>${starred?html`<span class="star-mark" aria-hidden="true">★</span>`:''}</div>
    <div class="pool-head"><span class="pool-caption muted small">${E.cardPoolLabel(isTerminal)}</span>
      <div class="big">${have?fmtAmt(BigInt(tickets)*price,asset):'—'}<small>${u}</small></div></div>
    ${have?html`${showCap||isTerminal?html`<div class="bar"><i style="width:${pct}%"></i></div>`:''}<div class="row small muted"><span>${E.cardPerTicket(fmtAmt(price,asset),u)}</span><span>${E.cardSoldCount(tickets.toLocaleString(),f.ticketCap.toLocaleString(),showCap)}</span></div>`:html`<div class="small muted">${E.cardOpenDetails}</div>`}
    <div class="row card-foot"><span class="card-next">${freshDisc?indexedStep(freshDisc,ph,L):stepText(i,x,L)}</span><span class="card-cta">${cta} ${ic('arrow')}</span></div>
  </article>`;
}
const indexedKasPool=(d: DiscoveredRound): bigint=>{
  if(d.terminal)return 0n;
  if(d.poolValue!=null)return safeBig(d.poolValue);
  const tkt=d.ticketsSold??d.tickets;
  if(d.ticketPrice!=null&&tkt!=null)return BigInt(tkt)*safeBig(d.ticketPrice);
  const raw=safeBig(d.managerValue);
  return raw>400_000_000n?raw-400_000_000n:0n;
};
function indexedCard(d: DiscoveredRound,x?: Ctx): Raw {
  const L=locOf(x),E=L.explore;
  const asset=assetOfDisc(d,x),isToken=isTokenAsset(asset);
  const ph=indexedPhase(d,L),tkt=d.terminal?(d.bought??d.ticketsSold??d.tickets??0):(d.ticketsSold??d.tickets??0),isRest=d.source==='rest',u=isToken?asset.symbol:unitOf(x);
  const mval=indexedKasPool(d),cta=L.actions.cardCta[ph.key]??L.common.viewDetails;
  const rawPrice=d.ticketPrice?safeBig(d.ticketPrice):0n;
  const tokenPool=isToken&&rawPrice>0n?BigInt(tkt)*rawPrice:0n;
  const starred=!!x?.saved?.has(d.cid);
  const showCap=!!(d.ticketCap&&d.ticketCap>0&&d.ticketCap<65536);
  return html`<article class="card t-${ph.tone}" data-indexed="${d.cid}" tabindex="0" role="button" aria-label="${E.openRoundAria(shortHash(d.cid))}">
    <div class="row"><span class="badge t-${ph.tone}">${ph.label}</span><span class="badge asset-badge">${u}</span><span class="spacer"></span>${starred?html`<span class="star-mark" aria-hidden="true">★</span>`:''}</div>
    <div class="pool-head"><span class="pool-caption muted small">${E.cardPoolLabel(!!d.terminal)}</span>
      <div class="big">${isToken?(tokenPool>0n||rawPrice>0n?html`${fmtAmt(tokenPool,asset)}<small>${u}</small>`:html`${L.format.tickets(tkt)}`):(mval>0n?html`${kas(mval)}<small>${u}</small>`:html`${L.format.tickets(tkt)}`)}</div></div>
    ${d.terminal?html`<div class="bar"><i style="width:100%"></i></div>`:''}
    <div class="row small muted"><span>${rawPrice>0n?E.cardPerTicket(fmtAmt(rawPrice,asset),u):L.format.tickets(tkt)}</span><span>${rawPrice>0n?E.cardSoldCount(tkt.toLocaleString(),String(d.ticketCap??''),showCap):(d.terminal?E.cardSettled:'')}</span></div>
    <div class="row card-foot"><span class="card-next">${isRest?E.cardRestSync:indexedStep(d,ph,L)}</span><span class="card-cta">${cta} ${ic('arrow')}</span></div>
  </article>`;
}
interface ExploreEntry {cid: string;ph: Phase;value: bigint;at: number;item?: Item;disc?: DiscoveredRound}
const requiredCompatProfiles=(x: Pick<Ctx,'compatibleProfiles'|'net'>): CompatibleProfile[]=>
  (x.compatibleProfiles??[]).filter(p=>p.supportsNet!==false);
const missingProfilesOf=(x: Ctx)=>{
  const reported=Array.isArray(x.conn.indexerProfiles)&&x.conn.indexerProfiles.length?new Set(x.conn.indexerProfiles.map(p=>p.profileId)):null;
  if(!reported||!x.compatibleProfiles?.length)return null;
  return requiredCompatProfiles(x).filter(p=>!reported.has(p.profileId));
};
export function exploreView(x: Ctx): Raw {
  const L=locOf(x),E=L.explore;
  const all=x.items,disc=x.discovered??[],q=x.S.query.trim().toLowerCase();
  const discByCid=new Map(disc.map(d=>[d.cid,d])),localCids=new Set(all.map(i=>i.r.cid));
  const allEntries: ExploreEntry[]=[
    ...all.map(i=>{
      const d=discByCid.get(i.r.cid),fresh=isDiscFresher(i,d)?d:undefined;
      const asset=fresh?(assetOfDisc(fresh,x)??i.asset):i.asset,isToken=isTokenAsset(asset);
      const value=fresh
        ?(fresh.terminal?0n:!isToken&&(fresh.module==='sales'||fresh.module==='sealed')&&fresh.tickets!=null?BigInt(fresh.tickets)*i.f.ticketPrice:(indexedKasPool(fresh)>i.value?indexedKasPool(fresh):i.value))
        :i.value;
      return {cid:i.r.cid,ph:fresh?indexedPhase(fresh,L):localizePhase(i.ph,L),value,at:Math.max(i.at,d?.updatedAt??0),item:i,disc:fresh};
    }),
    ...disc.filter(d=>!localCids.has(d.cid)).map(d=>{const ph=indexedPhase(d,L);return {cid:d.cid,ph,value:indexedKasPool(d),at:d.updatedAt??0,disc:d};}),
  ];
  const isIncompatibleProfile=(pid: string|null|undefined)=>!!(pid&&x.supportedProfiles&&!x.supportedProfiles.has(pid));
  const isOther=(e: ExploreEntry)=>isIncompatibleProfile(e.disc?.profileId)||isIncompatibleProfile(e.item?.r.profileId)
    ||(e.item?(!e.item.f.module&&!e.item.r.terminal&&!e.item.r.intent):(!!e.disc?.module&&!['sales','sealed','win','refund'].includes(String(e.disc.module))&&!e.disc?.phase));
  const entries=allEntries.filter(e=>!isOther(e)),otherEntries=allEntries.filter(isOther);
  const is=(e: ExploreEntry,...k: string[])=>k.includes(e.ph.key);
  const isDone=(e: ExploreEntry)=>is(e,'paid','empty','refunded','done');
  const saved=x.saved??new Set<string>();
  const g: Record<string,number>={
    all:entries.length,
    live:entries.filter(e=>!isDone(e)).length,
    done:entries.filter(isDone).length,
    saved:entries.filter(e=>saved.has(e.cid)).length,
  };
  const phaseRank=(e: ExploreEntry): number=>{
    if(isDone(e))return 3;
    if(saved.has(e.cid))return 0;
    return is(e,'open')?1:2;
  };
  const rawFilter=x.S.filter||'live';
  const activeFilter=rawFilter==='open'?('live'):rawFilter;
  const list=entries.filter(e=>{
    if((activeFilter==='live')&&isDone(e))return false;
    if(activeFilter==='sealed'&&!is(e,'sealed'))return false;
    if(activeFilter==='settle'&&!is(e,'paying','refund'))return false;
    if(activeFilter==='done'&&!isDone(e))return false;
    if(activeFilter==='saved'&&!saved.has(e.cid))return false;
    return !q||e.cid.includes(q);
  }).sort((a,b)=>{
    const r=phaseRank(a)-phaseRank(b);
    if(r!==0)return r;
    return x.S.sort==='value'?(b.value>a.value?1:b.value<a.value?-1:b.at-a.at):b.at-a.at;
  });
  const filteredOther=otherEntries.filter(e=>!q||e.cid.includes(q));
  const seg: [string,string][]=[['live',E.filters.live],['done',E.filters.done],['saved',E.filters.saved]];
  const isRest=x.conn.discoveredSource==='rest',isCache=x.conn.discoveredSource==='cache';
  const missingProfiles=x.conn.indexer&&!x.conn.indexerStale?missingProfilesOf(x):null;
  const sourceNotice=isCache&&x.conn.indexerStale
    ?html`<div class="source-strip"><span class="dot"></span><span>${E.noticeCacheOffline(disc.length)}</span></div>`
    :missingProfiles&&missingProfiles.length
      ?html`<div class="notice warn">${E.noticeMissingProfiles(missingProfiles.map(p=>`${p.asset} (${shortHash(p.profileId,6,4)})`).join(L.listSep))}</div>`
      :'';
  const emptyInfo=E.emptyFiltered(entries.length,activeFilter!=='all');
  const searchOpen=!!(x.S.searchOpen||x.S.query);
  return html`
  <div class="toolbar plaza-toolbar${searchOpen?' search-open':''}">
    <div class="seg" role="group" aria-label="${E.filterAria}">${seg.map(([k,l])=>html`<button data-filter="${k}" aria-pressed="${activeFilter===k}">${l}<span class="c">${g[k]}</span></button>`)}</div>
    <span class="spacer"></span>
    <div class="plaza-tools">
      <button class="icon-btn plaza-search-btn${searchOpen?' on':''}" data-act="toggleSearch" aria-label="${E.searchPlaceholder}" title="${E.searchPlaceholder}" aria-expanded="${searchOpen}">${ic('search')}</button>
      ${x.conn.indexer||isRest||isCache||x.conn.node?html`<button class="icon-btn" data-act="refreshIndex" aria-label="${E.refreshListTitle}" title="${E.refreshListTitle}">${ic('refresh')}</button>`:''}
    </div>
    <label class="search search-sm plaza-search">${ic('search')}<input id="q" placeholder="${E.searchPlaceholder}" value="${x.S.query}" autocomplete="off" spellcheck="false"></label>
  </div>
  ${sourceNotice}
  <div class="grid">${list.length?list.map(e=>e.item?card(e.item,x,e.disc):indexedCard(e.disc!,x)):html`<div class="empty">${ic('ticket')}<p>${entries.length?html`${emptyInfo.before}${emptyInfo.linkText?html`<button class="link" data-filter="all">${emptyInfo.linkText}</button>${emptyInfo.after}`:''}`:E.emptyNone}<button class="link" data-go2="create">${E.emptyCreateLink}</button>${E.emptyTail}</p></div>`}</div>
  ${x.indexerMore?html`<div style="margin-top:12px;text-align:center"><button class="btn sm" data-act="moreIndex">${L.common.loadMore}</button></div>`:''}
  <details class="join-details"${x.S.join||!entries.length?' open':''}>
    <summary class="small muted">${ic('download')} <span>${E.joinSummary}</span></summary>
    <div class="joinrow" style="margin-top:10px"><input id="joinText" value="${x.S.join}" placeholder="${E.joinPlaceholder}" autocomplete="off" spellcheck="false" aria-label="${E.joinAria}"><button class="btn pri" data-act="join">${L.common.join}</button></div>
  </details>
  ${otherEntries.length?html`<details class="other-rounds-details">
    <summary class="small dim" title="${E.incompatibleTitle}">${ic('archive')}<span>${E.incompatibleSummary(otherEntries.length)}</span></summary>
    <div class="panel" style="margin-top:10px;background:var(--panel2);border:1px dashed var(--line2)">
      <div class="grid">${filteredOther.map(e=>e.item?card(e.item,x):indexedCard(e.disc!,x))}</div>
    </div>
  </details>`:''}`;
}

/* ------------------------------------------------------------------ create */
export interface CreateParse {ok: boolean;errors: string[];price: bigint|null;cap: number;min: number;mins: number;registry: boolean|string;registryAddr: string;isCustomRegistry: boolean}
export function parseCreate(
  form: CreateForm,
  net?: Pick<NetInfo,'key'|'addressPrefix'|'unit'|'label'|'registry'>,
  L: Locale=getLocale(),
  spec?: ProtocolCreateSpec|null,
  altProtoName?: string|null,
): CreateParse {
  const C=L.create;
  const resolved=spec??defaultSequentialCreateSpec(net as NetInfo|null);
  const defaultReg=net?.registry?.address??TN10_ROLLING_REGISTRY.address;
  const addrPrefix=net?.addressPrefix??'kaspatest';
  const asset=resolved.asset;
  const unit=isTokenAsset(asset)?asset.symbol:(net?.unit??asset.symbol);
  const label=net?.label??'Testnet 10';
  const useReg=form.registry!==false;
  const rawAddr=(form.registryAddr??'').trim().toLowerCase();
  const regAddr=rawAddr||defaultReg;
  const isCustomRegistry=useReg&&regAddr!==defaultReg;
  let registry: boolean|string=false,regValid=true;
  if(useReg){
    try{addressToSpk(regAddr,addrPrefix);registry=regAddr===defaultReg?true:regAddr;}
    catch{regValid=false;}
  }
  try {
    const rawPrice=form.price.trim(),intPrice=/^(0|[1-9][0-9]{0,11})$/.test(rawPrice);
    const price=intPrice?(asset.decimals===8?parseTkas(rawPrice):BigInt(rawPrice)*(10n**BigInt(asset.decimals))):null;
    const cap=resolved.fixedTicketCap!=null?resolved.fixedTicketCap:(/^[0-9]{1,8}$/.test(form.cap)?Number(form.cap):NaN);
    const min=resolved.fixedMinTickets!=null?resolved.fixedMinTickets:(/^[0-9]{1,8}$/.test(form.min)?Number(form.min):NaN);
    const customUnit=form.customUnit==='h'||form.customUnit==='d'?form.customUnit:'m';
    const customMult=customUnit==='d'?1440:customUnit==='h'?60:1;
    const mins=form.dur==='custom'?(/^[0-9]{1,5}$/.test(form.custom)?Number(form.custom)*customMult:NaN):Number(form.dur);
    const errors: string[]=[];
    if(!resolved.supportedOnNet)errors.push(C.errUnsupportedNet(label,unit,altProtoName??(net?.unit??'KAS')));
    if(price==null)errors.push(C.errPriceInt(unit));
    else if(price<resolved.priceMin)errors.push(C.errPriceMin(fmtAmt(resolved.priceMin,asset),unit));
    else if(resolved.priceMax!=null&&price>resolved.priceMax)errors.push(C.errPriceMax(fmtAmt(resolved.priceMax,asset),unit));
    if(resolved.fixedTicketCap==null&&!(cap>=resolved.minTicketCap&&cap<=resolved.maxTicketCap))errors.push(C.errCapRange(resolved.minTicketCap,resolved.maxTicketCap.toLocaleString()));
    if(resolved.fixedMinTickets==null&&!(min>=resolved.minTicketsFloor&&min<=cap))errors.push(C.errMinRange(resolved.minTicketsFloor));
    if(!(mins>=resolved.minCloseMinutes&&mins<=resolved.maxCloseMinutes))errors.push(C.errDurRange);
    if(useReg&&!regValid)errors.push(C.errRegAddr(label,addrPrefix));
    return {ok:!errors.length,errors,price,cap,min,mins,registry,registryAddr:regAddr,isCustomRegistry};
  } catch {return {ok:false,errors:[C.errPriceInt(unit)],price:null,cap:NaN,min:NaN,mins:NaN,registry:false,registryAddr:regAddr,isCustomRegistry};}
}
function createCta(x: Ctx,formOk: boolean,L: Locale): Raw {
  const C=L.create,w=x.wallet;
  if(signing(w))return x.busy
    ?html`<p class="small muted" role="status">${C.ctaBusyStatus}</p><button class="btn pri block" disabled aria-busy="true">${L.common.working}</button>`
    :html`<button class="btn pri block" data-act="create" ${formOk?'':'disabled'}>${ic('arrow')}${C.ctaReview}</button>`;
  if(w)return html`<div class="notice warn" style="margin-bottom:12px">${C.ctaReceiveOnlyWarn}</div><button class="btn pri block" data-fix="wallet">${ic('wallet')}${C.ctaConnectSigning}</button>`;
  return html`<button class="btn pri block" data-fix="wallet">${ic('wallet')}${C.ctaConnectToCreate}</button>`;
}
export function createView(x: Ctx): Raw {
  const L=locOf(x),C=L.create;
  const specs=x.createSpecs?.length?x.createSpecs:[defaultSequentialCreateSpec(x.net)];
  const f=x.S.form,spec=specs.find(s=>s.protocolId===f.protocol)??specs.find(s=>s.supportedOnNet)??specs[0]!;
  const altSpec=specs.find(s=>s.supportedOnNet&&s.protocolId!==spec.protocolId);
  const u=unitOf(x);
  const symOf=(s: ProtocolCreateSpec)=>isTokenAsset(s.asset)?s.asset.symbol:u;
  const symCounts=new Map<string,number>();
  for(const s of specs){const sym=symOf(s);symCounts.set(sym,(symCounts.get(sym)??0)+1);}
  const altLabel=altSpec?C.protoChoiceLabel(symOf(altSpec),altSpec.name,(symCounts.get(symOf(altSpec))??0)>1):u;
  const p=parseCreate(f,x.net,L,spec,altLabel);
  const ticketU=symOf(spec),defaultReg=x.net.registry.address;
  const useReg=f.registry!==false,regVal=f.registryAddr!==undefined?f.registryAddr:defaultReg;
  const depKas=kas(spec.creatorDepositSompi);
  const effMin=spec.fixedMinTickets??(Number.isFinite(p.min)?p.min:spec.minTicketsFloor);
  const advOpen=!useReg||p.isCustomRegistry||(spec.fixedTicketCap==null&&(!Number.isFinite(p.cap)||!Number.isFinite(p.min)||p.cap<spec.minTicketCap||p.cap>spec.maxTicketCap||p.min<spec.minTicketsFloor||p.min>p.cap));
  return html`
  <div class="create-shell">
    <div class="panel">
      <h2>${ic('create')} ${C.heading}</h2>
      <p class="sub">${C.sub}</p>
      <div class="form">
        ${specs.length>1?html`<div class="field full">${C.protocolLabel}
          <div class="pills currency-pills">
            ${specs.map(s=>{const sym=symOf(s);return html`<button type="button" data-proto="${s.protocolId}" aria-pressed="${s.protocolId===spec.protocolId}">${C.protoChoiceLabel(sym,s.name,(symCounts.get(sym)??0)>1)}</button>`;})}
          </div>
        </div>`:''}
        <label class="field full">${C.ticketPriceLabel(ticketU)}<input id="cPrice" value="${f.price}" inputmode="numeric" maxlength="12"><small>${C.ticketPriceHint(fmtAmt(spec.priceMin,spec.asset),ticketU)}</small></label>
        <div class="field full">${C.closeTimeLabel}<div class="pills">${L.actions.closePresets.map(([k,l])=>html`<button type="button" data-dur="${k}" aria-pressed="${f.dur===k}">${l}</button>`)}</div>
          ${f.dur==='custom'?(()=>{const cu=f.customUnit==='h'||f.customUnit==='d'?f.customUnit:'m';return html`<div class="custom-dur-row">
            <input id="cCustom" value="${f.custom}" inputmode="numeric" maxlength="5" placeholder="${C.customDurationPlaceholder(cu,spec.minCloseMinutes,spec.maxCloseMinutes)}">
            <div class="seg custom-unit" role="group" aria-label="${C.customUnitAria}">
              <button type="button" data-durunit="m" aria-pressed="${cu==='m'}">${C.unitMin}</button>
              <button type="button" data-durunit="h" aria-pressed="${cu==='h'}">${C.unitHour}</button>
              <button type="button" data-durunit="d" aria-pressed="${cu==='d'}">${C.unitDay}</button>
            </div>
          </div>`;})():''}
          <small>${C.closeRuleHint(effMin,ticketU)}</small></div>
        <details class="adv-details full"${advOpen?' open':''}>
          <summary class="small muted">${spec.fixedTicketCap!=null?C.moreOptionsPublicSummary:C.moreOptionsSummary}</summary>
          <div class="adv-body">
            ${spec.fixedTicketCap!=null
              ?html`<p class="small muted" style="margin:0">${C.fixedCapInfo(spec.fixedMinTickets??spec.minTicketsFloor)}</p>`
              :html`<div class="form">
                <label class="field">${C.ticketCapLabel}<input id="cCap" value="${f.cap}" inputmode="numeric" maxlength="8"><small>${C.ticketCapHint(spec.minTicketCap,spec.maxTicketCap.toLocaleString())}</small></label>
                <label class="field">${C.minTicketsLabel}<input id="cMin" value="${f.min}" inputmode="numeric" maxlength="8"><small>${C.minTicketsHint(spec.minTicketsFloor)}</small></label>
              </div>`}
            <label class="check"><input type="checkbox" id="cReg" ${useReg?'checked':''}>${C.advRegistryCheck(u)}</label>
            <label class="field" id="cRegBox" ${useReg?'':'hidden'}>${C.advRegistryAddrLabel}<input id="cRegAddr" value="${regVal}" spellcheck="false" autocomplete="off" placeholder="${defaultReg}">
              <small>${C.advRegistryAddrHint(u)}</small>
              ${p.isCustomRegistry?html`<small class="why">${C.advRegistryCustomWarn}</small>`:''}</label>
          </div>
        </details>
      </div>
      <div class="deposit-bar small muted">
        <span>${ic('lock')} ${C.depositNotice(depKas,u)}</span>
        ${signing(x.wallet)&&x.balance!=null?html`<span>${C.costCurrentBalance(kas(x.balance),u)}</span>`:''}
      </div>
      ${p.ok?'':html`<p class="err">${p.errors[0]}</p>`}
      <div style="margin-top:14px">${createCta(x,p.ok,L)}</div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ round detail */
function stepper(D: Detail,L: Locale): Raw {
  const {r,f}=D,refund=f.module==='refund'||r.terminal==='REFUNDED',labels=refund?L.actions.stepsRefund:L.actions.stepsNormal;
  const pos=r.terminal?4:f.module==='sealed'?1:f.module==='win'||f.module==='refund'?2:0;
  return html`<div class="stepper">${labels.map((l,i)=>html`<div class="step ${i<pos?'done':i===pos?'now':''} ${refund&&i>=2?'alt':''}"><div class="b">${i<pos?'✓':i+1}</div>${l}</div>`)}</div>`;
}
function actionCard(a: string,D: Detail,x: Ctx,L: Locale): Raw|'' {
  const R=L.round,{f}=D,s: ActionState=D.a[a]??{ok:false,reason:'不可用'},baseInfo=L.actions.info[a];
  if(!baseInfo)return '';
  const dAsset=D.asset,isToken=isTokenAsset(dAsset);
  const meta=D.protocolMeta,isParallel=meta?meta.shardModel==='parallel':isToken;
  const g=x.gate(a),u=unitOf(x),tu=isToken?dAsset.symbol:u;
  const freeSet=meta?.freeActions,actFree=freeSet?freeSet.includes(a):(!isParallel&&isFree(a));
  const po=isParallel?L.actions.parallelOverride[a]:undefined;
  const info=po?{title:po.title,verb:po.verb,desc:po.desc(u,tu),free:actFree}:{title:baseInfo.title,verb:baseInfo.verb,desc:baseInfo.desc(u),free:actFree};
  if(!s.ok&&/不适用|没有旧分片|不满足/.test(s.reason??''))return '';
  const draw=a==='DRAW'?drawReadiness(D,x):null;
  const waiting=!s.ok||!!draw&&!draw.ready,quantityError=a==='BUY'?qtyError(x.S.qty,f,s,L):null;
  const buySel=a==='BUY'?D.interactive?.buyShardSelector??null:null;
  const openShards=buySel?.options??[],canOpenNewShard=!!buySel?.canOpenNew;
  const rawBuyMode=x.S.buyShard??'auto';
  const effBuyMode=rawBuyMode==='new'&&canOpenNewShard?'new':openShards.some(o=>o.shardId===rawBuyMode)?rawBuyMode:'auto';
  const needsNewShardDeposit=!!(buySel&&((effBuyMode==='new'&&canOpenNewShard)||(!openShards.length&&canOpenNewShard)));
  const allLedgersBusy=!!(buySel&&!openShards.length&&!canOpenNewShard);
  const buyAdv=buySel?html`<details class="adv-details buy-adv"${effBuyMode!=='auto'?' open':''}>
    <summary class="small muted">${R.buyAdvSummary(buySel.activeOpenCount,buySel.maxActiveOpen)}</summary>
    <div class="adv-body">
      <label class="field">${R.shardSelectLabel}<select id="buyShardSelect">
        <option value="auto" ${effBuyMode==='auto'?'selected':''}>${openShards.length?R.shardAutoOption:R.shardAutoNewOption(buySel.depositKas,u)}</option>
        ${canOpenNewShard?html`<option value="new" ${effBuyMode==='new'?'selected':''}>${R.shardNewOption(buySel.depositKas,u,buySel.activeOpenCount,buySel.maxActiveOpen)}</option>`:''}
        ${openShards.map(o=>html`<option value="${o.shardId}" ${effBuyMode===o.shardId?'selected':''}>${R.shardExistingOption(shortHash(o.shardId,6,4),o.tickets,o.recordCount,o.maxRecords)}</option>`)}
      </select></label>
      <p class="small ${!canOpenNewShard&&openShards.length>=buySel.maxActiveOpen?'warn-text':'muted'}" style="margin:0">${!canOpenNewShard&&openShards.length>=buySel.maxActiveOpen?R.shardCapReachedHint(buySel.activeOpenCount,buySel.maxActiveOpen,256):R.buyAdvHint(buySel.depositKas,u)}</p>
    </div>
  </details>`:'';
  const extra=a==='BUY'?html`<div class="qtyrow"><label class="field">${R.qtyLabel}<input id="qty" value="${x.S.qty}" inputmode="numeric" maxlength="8" aria-describedby="qtyCost" aria-invalid="${quantityError?'true':'false'}"></label>
    <div class="pills">${[1,10].map(n=>html`<button type="button" data-qty="${n}" aria-pressed="${x.S.qty===String(n)}">${L.format.tickets(n)}</button>`)}</div></div>
    <p class="small ${quantityError?'err':'muted'}" id="qtyCost" role="status" aria-live="polite">${qtyCost(x.S.qty,f,s,tu,D.asset,L)}</p>
    ${needsNewShardDeposit?html`<p class="small muted" style="margin:4px 0 0">${R.firstShardDepositHint(buySel!.depositKas,u)}</p>`:''}
    ${allLedgersBusy?html`<p class="small warn-text" style="margin:4px 0 0">${R.shardCapReachedHint(buySel!.activeOpenCount,buySel!.maxActiveOpen,256)}</p>`:''}`:'';
  const label=x.busy?L.common.working:draw&&!draw.ready?draw.button:waiting?R.unavailable:g.ok?(draw?draw.button:a==='BUY'?(needsNewShardDeposit?R.buyNowDeposit(buySel!.depositKas,u):R.buyNow):info.verb):g.fix==='wallet'?(a==='BUY'?R.connectAndBuy:L.chrome.connectWallet):g.fix==='settings'?R.checkConnection:R.unavailable;
  const attr=x.busy?'disabled aria-busy="true"':waiting?'disabled':g.ok?`data-act="${a}"`:g.fix?`data-fix="${g.fix}"`:'disabled';
  const primary=(g.ok||g.fix==='wallet')&&!waiting;
  const canBatch=meta?meta.supportsBatchSettlement:!isParallel;
  return html`<div class="act ${a==='BUY'?'act-hero':''} ${waiting||x.busy?'off':''}"><h4>${info.title}${actFree?html`<span class="tag kas">${R.freeExecTag}</span>`:''}</h4>${a==='BUY'?'':html`<p>${info.desc}</p>`}${extra}
    ${x.busy?html`<div class="why" role="status">${g.reason??R.busyFallback}</div>`:waiting?html`<div class="why">${draw&&!draw.ready?draw.label:localizeActionReason(s.reason,L)}</div>`:g.ok||g.fix==='wallet'?'':html`<div class="why">${g.reason}</div>`}
    <button ${raw(a==='BUY'?'id="buySubmit"':'')} class="btn ${primary?'pri':''} block" ${raw((quantityError||allLedgersBusy)&&!x.busy&&!waiting&&(g.ok||g.fix)?`${attr} disabled`:attr)}>${label}</button>${buyAdv}${canBatch&&a==='PAY_OLD'&&s.ok&&g.ok&&!x.busy&&D.r.frozen.length>0?html`<button type="button" class="btn block" style="margin-top:8px" data-act="batchPayout">${R.batchPayoutBtn(D.r.frozen.length)}</button>`:canBatch&&a==='REFUND_OLD'&&s.ok&&g.ok&&!x.busy&&D.r.frozen.length>0?html`<button type="button" class="btn block" style="margin-top:8px" data-act="batchRefund">${R.batchRefundBtn(D.r.frozen.length)}</button>`:''}</div>`;
}
export function qtyError(text: string,f: Facts,s: ActionState|undefined,L: Locale=getLocale()): string|null {
  const R=L.round;
  if(!/^[1-9][0-9]{0,7}$/.test(text))return R.qtyErrInt;
  const n=Number(text),max=s?.maxQuantity??Math.max(0,f.ticketCap-f.tickets);
  if(n>MAX_TICKET_CAP)return R.qtyErrMax(MAX_TICKET_CAP);
  if(max>0&&n>max)return R.qtyErrRemaining(max);
  return null;
}
export function qtyCost(text: string,f: Facts,s: ActionState|undefined,unit='TKAS',asset?: AssetDescriptor,L: Locale=getLocale()): string {
  try {
    const error=qtyError(text,f,s,L);if(error)return error;
    const n=Number(text);
    return L.round.qtyCostLine(n,fmtAmt(f.ticketPrice,asset),fmtAmt(BigInt(n)*f.ticketPrice,asset),unit);
  } catch {return '';}
}
function rejectionHelp(i: Intent,x: Ctx,L: Locale): Raw {
  const R=L.round,k=classifyRejection(i),by=k.spender?html` ${hash(k.spender,{n:8,link:x.ex.tx(k.spender),L})}`:'';
  if(k.kind==='FUNDS_INPUT')return html`${R.rejectFundsInput.before}${by}${R.rejectFundsInput.after}`;
  if(k.kind==='ROUND_INPUT')return html`${R.rejectRoundInput.before}${by}${R.rejectRoundInput.after}`;
  if(k.kind==='ORPHAN')return html`${R.rejectOrphan}`;
  return html`${R.rejectOther}`;
}
function intentPanel(D: Detail,x: Ctx,L: Locale): Raw|'' {
  const r=D.r,i=r.intent;if(!i)return '';
  const R=L.round,rejected=i.status==='REJECTED',canDiscard=['REJECTED','UNSENT','SUBMITTED','UNKNOWN','PREPARED'].includes(i.status),busy=x.busy;
  const canRecover=D.protocolMeta?D.protocolMeta.supportsIntentResend:true;
  const pend=R.intentPendingDesc(canRecover);
  return html`<div class="notice ${rejected?'bad':'warn'}"><b>${rejected?R.intentRejected:R.intentPending}</b>${L.key==='zh-CN'?'：':': '}${actionTitle(i.action,L)}
    ${rejected?rejectionHelp(i,x,L):html`${pend.before}<b>${pend.bold}</b>${pend.after}`}
    ${i.txid?html`<div class="small muted" style="margin-top:6px">${R.intentTxid}${hash(i.txid,{n:14,link:x.ex.tx(i.txid),L})}</div>`:''}
    <div class="btnrow">
      ${rejected?'':html`<button class="btn sm" data-act="track" ${busy?'disabled':''}>${R.intentRefresh}</button>${canRecover?html`<button class="btn sm" data-act="recover" ${busy?'disabled':''}>${R.intentResend}</button>`:''}`}
      ${canDiscard?html`<button class="btn sm warn" data-act="discard" ${busy?'disabled':''}>${R.intentDiscard}</button>`:''}
    </div></div>`;
}
function verifyPanel(v: VerifyState|null,L: Locale,disc: DiscoveredRound|null=null,currentTickets: number|null=null): Raw|'' {
  if(!v)return '';
  const R=L.round,hasNewerDisc=disc&&currentTickets!=null&&(disc.tickets??0)>currentTickets;
  const hint=hasNewerDisc?R.verifyIndexHint((disc!.tickets??0).toLocaleString(),disc!.shards??0):'';
  if(v.state==='checking')return html`<div class="notice">${R.verifyChecking(hint)}</div>`;
  if(v.state==='partial')return html`<div class="notice warn">${R.verifyPartial(hint)}</div>`;
  if(v.state==='ok')return html`<div class="notice ok">${R.verifyOk(new Date(v.at??0).toLocaleTimeString(L.timeLocale))}</div>`;
  const transient=['INDEXER_TIMEOUT','INDEXER_UNAVAILABLE','RPC_TIMEOUT','NODE_REQUIRED','NODE_CLOSED'].includes(v.code??'');
  return html`<div class="notice ${transient?'warn':'bad'}"><b>${transient?R.verifyTransient:R.verifyMismatch}</b>${L.key==='zh-CN'?'：':': '}${errText(v.code??'',L)}</div>`;
}
const TX_SUMMARY_CACHE=new WeakMap<Receipt[],{hasShards: boolean;len: number;list: Receipt[];omittedBuys: number;omittedRefunds: number}>();
function txTable(D: Detail,x: Ctx,L: Locale): Raw {
  const R=L.round,r=D.r,hasShards=!!(D.shards&&D.shards.length);
  if(!r.receipts.length)return html`<p class="muted small">${R.txEmpty}</p>`;
  let cached=TX_SUMMARY_CACHE.get(r.receipts);
  if(!cached||cached.hasShards!==hasShards||cached.len!==r.receipts.length){
    const list: Receipt[]=[];
    let omittedBuys=0,omittedRefunds=0;
    for(const t of r.receipts){
      if(t.finalized===false){list.push(t);continue;}
      if(t.action==='BUY'||t.action==='OPEN_SHARD'){omittedBuys++;continue;}
      if(hasShards&&(t.action==='REFUND_OLD'||t.action==='REFUND_SELF'||t.action==='CLAIM_REFUND')){omittedRefunds++;continue;}
      list.push(t);
    }
    cached={hasShards,len:r.receipts.length,list,omittedBuys,omittedRefunds};
    TX_SUMMARY_CACHE.set(r.receipts,cached);
  }
  const {list,omittedBuys,omittedRefunds}=cached;
  const omittedParts=[omittedBuys>0?R.txOmittedBuys(omittedBuys.toLocaleString()):'',omittedRefunds>0?R.txOmittedRefunds(omittedRefunds.toLocaleString()):''].filter(Boolean);
  if(!list.length)return html`<p class="muted small">${R.txAllInMap(omittedParts.join(L.listSep))}</p>`;
  const limit=x.S.txLimit??20,total=list.length,shown=list.slice(Math.max(0,total-limit)).reverse();
  return html`<div class="tablewrap"><table><tr><th>${R.txColStep}</th><th>${R.txColTx}</th><th>${R.txColStatus}</th><th>${R.txColFee}</th></tr>${shown.map(t=>html`<tr>
    <td>${actionTitle(t.action,L)}</td><td>${hash(t.txid,{n:8,link:x.ex.tx(t.txid),L})}</td>
    <td>${t.finalized===false?html`<span class="badge t-violet">${R.txPendingBadge}</span>`:html`<span class="badge t-mint">${R.txAcceptedBadge}</span>`}</td><td class="mono">${feeText(t.feeSompi)}</td></tr>`)}</table></div>
    ${total>shown.length?html`<div class="btnrow"><span class="small muted">${R.txRecentCount(shown.length,total.toLocaleString())}</span><button type="button" class="btn sm" data-moretx="100">${R.txLoad100}</button><button type="button" class="btn sm" data-moretx="all">${R.txShowAll}</button></div>`:''}
    ${omittedParts.length?html`<p class="small muted" style="margin-top:8px">${R.txOmittedFoot(omittedParts.join(L.listSep))}</p>`:''}`;
}
const DOT_COLORS=['#49eacb','#60a5fa','#a78bfa','#f472b6','#f59e0b','#34d399','#f87171','#22d3ee','#c084fc','#fbbf24','#4ade80','#fb7185','#38bdf8','#e879f9','#a3e635','#fb923c'];
type Rgb=readonly [number,number,number];
const hexRgb=(h: string): Rgb=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
const DOT_RGBS: readonly Rgb[]=DOT_COLORS.map(hexRgb);
const WIN_RGB: Rgb=[251,191,36];
const SHARD_TONE: Record<ShardStatus,{tone: string;color: string}>={
  active:{tone:'t-mint',color:'var(--kas)'},
  frozen:{tone:'t-violet',color:'var(--sky)'},
  refunding:{tone:'t-amber',color:'var(--amber)'},
  settled:{tone:'t-mint',color:'var(--sky)'},
  refunded:{tone:'t-muted',color:'var(--violet)'},
};
const rangeText=(start: number,end: number): string=>start===end?`${start}`:`${start}–${end}`;
function keyColorIdx(key: string): number {
  let h=0x811c9dc5;
  for(let i=0;i<key.length;i++){h^=key.charCodeAt(i);h=Math.imul(h,0x01000193);}
  return (h>>>0)%DOT_COLORS.length;
}
const keyColor=(key: string): string=>DOT_COLORS[keyColorIdx(key)] as string;
const SHARD_TILE_CACHE=new WeakMap<ShardRecordView[],{theme: string;drawRec: number;len: number;refunded: number;rgba: Uint8ClampedArray}>();
const SHARD_STRIDE=18;
export function paintShardCanvases(root: ParentNode,D: Detail|null,theme='dark'): void {
  if(!D?.shards?.length)return;
  const cv=root.querySelector<HTMLCanvasElement>('canvas[data-shard-wall]');
  if(!cv)return;
  const ctx2d=cv.getContext('2d');
  if(!ctx2d)return;
  const shards=D.shards,cols=16,rows=Math.max(1,Math.ceil(shards.length/cols));
  const w=cols*SHARD_STRIDE,h=rows*SHARD_STRIDE;
  if(cv.width!==w)cv.width=w;
  if(cv.height!==h)cv.height=h;
  const draw=D.r.draw??null,light=theme==='light';
  const bgA: Rgb=light?[232,240,247]:[22,33,28],bgB: Rgb=light?[221,232,242]:[28,42,35];
  const archivedPaid: Rgb=light?[56,161,148]:[52,148,142],archivedRef: Rgb=light?[139,122,184]:[124,110,168];
  const setTilePx=(tile: Uint8ClampedArray,pos: number,rgb: Rgb,alpha=1)=>{
    const off=pos*4,bg=(((pos&15)+(pos>>4))&1)?bgB:bgA;
    if(alpha>=1){tile[off]=rgb[0];tile[off+1]=rgb[1];tile[off+2]=rgb[2];}
    else{tile[off]=Math.round(bg[0]+(rgb[0]-bg[0])*alpha);tile[off+1]=Math.round(bg[1]+(rgb[1]-bg[1])*alpha);tile[off+2]=Math.round(bg[2]+(rgb[2]-bg[2])*alpha);}
    tile[off+3]=255;
  };
  const img=ctx2d.createImageData(w,h),buf=img.data;
  for(let i=0;i<shards.length;i++){
    const sh=shards[i]!,col=i&15,row=i>>4,ox=col*SHARD_STRIDE+1,oy=row*SHARD_STRIDE+1;
    let tile: Uint8ClampedArray;
    if(sh.records===null){
      tile=new Uint8ClampedArray(1024);
      for(let p=0;p<256;p++)setTilePx(tile,p,((p&15)+(p>>4))&1?bgB:bgA,1);
      const mark=sh.status==='refunded'?archivedRef:archivedPaid;
      for(let y=2;y<14;y++)for(let x=2;x<14;x++){
        const edge=x===2||x===13||y===2||y===13,check=((x+y)&1)===0&&x>=4&&x<=11&&y>=4&&y<=11;
        if(edge||check)setTilePx(tile,y*16+x,mark,edge?.75:.45);
      }
    }else{
      const drawRec=draw&&draw.shard===sh.index?draw.record:-1;
      const cached=SHARD_TILE_CACHE.get(sh.records);
      if(cached&&cached.theme===theme&&cached.drawRec===drawRec&&cached.len===sh.records.length&&cached.refunded===sh.refundedRecords){
        tile=cached.rgba;
      }else{
        tile=new Uint8ClampedArray(1024);
        for(let p=0;p<256;p++)setTilePx(tile,p,((p&15)+(p>>4))&1?bgB:bgA,1);
        for(const rec of sh.records){
          if(rec.index<0||rec.index>=256)continue;
          const isWin=drawRec===rec.index;
          setTilePx(tile,rec.index,isWin?WIN_RGB:(DOT_RGBS[keyColorIdx(rec.key)] as Rgb),!isWin&&rec.refunded?.45:1);
        }
        SHARD_TILE_CACHE.set(sh.records,{theme,drawRec,len:sh.records.length,refunded:sh.refundedRecords,rgba:tile});
      }
    }
    for(let y=0;y<16;y++){
      const srcOff=y*64,dstOff=((oy+y)*w+ox)*4;
      buf.set(tile.subarray(srcOff,srcOff+64),dstOff);
    }
  }
  ctx2d.putImageData(img,0,0);
}
export function buyReceiptForRound(sh: ShardView,rec: ShardRecordView,r: Round,shards: ShardView[]|null|undefined,parallel?: boolean): Receipt|null {
  return matchBuyReceiptAuto(sh,rec,r,shards,parallel);
}
function buyReceiptFor(sh: ShardView,rec: ShardRecordView,D: Detail): Receipt|null {
  if(D.receiptMatcher)return D.receiptMatcher.buyReceipt(sh,rec);
  const isParallel=D.protocolMeta?D.protocolMeta.shardModel==='parallel':undefined;
  return matchBuyReceiptAuto(sh,rec,D.r,D.shards,isParallel);
}
export function refundReceiptForRound(sh: ShardView,rec: ShardRecordView,r: Round,shards: ShardView[]|null|undefined,parallel?: boolean): Receipt|null {
  return matchRefundReceiptAuto(sh,rec,r,shards,parallel);
}
function refundReceiptFor(sh: ShardView,rec: ShardRecordView,D: Detail): Receipt|null {
  if(D.receiptMatcher)return D.receiptMatcher.refundReceipt(sh,rec);
  const isParallel=D.protocolMeta?D.protocolMeta.shardModel==='parallel':undefined;
  return matchRefundReceiptAuto(sh,rec,D.r,D.shards,isParallel);
}
function shardRefundReceipts(sh: ShardView,D: Detail): Receipt[] {
  if(D.receiptMatcher)return D.receiptMatcher.shardRefunds(sh);
  const isParallel=D.protocolMeta?D.protocolMeta.shardModel==='parallel':undefined;
  return shardRefundReceiptsAuto(sh,D.r,D.shards,isParallel);
}
function purchaseTip(rec: ShardRecordView|null,sh: ShardView,D: Detail,x: Ctx,L: Locale): Raw {
  const R=L.round;
  if(!rec)return html`<p class="small muted" style="margin:6px 0 0">${R.tipDefault(sh.records?.length??0)}</p>`;
  const addr=x.ex.addrOfKey(rec.key)??rec.key,draw=D.r.draw??null,u=unitOf(x);
  const isWin=!!draw&&draw.shard===sh.index&&draw.record===rec.index;
  const buyRc=buyReceiptFor(sh,rec,D);
  const refundRc=rec.refunded?refundReceiptFor(sh,rec,D):null;
  const badge=isWin?html`<span class="badge t-gold">${R.tipWinBadge(draw.ticket+1)}</span>`:rec.refunded?html`<span class="badge t-muted">${R.tipRefundedBadge}</span>`:html`<span class="badge t-mint">${R.tipBuyBadge(rec.index+1)}</span>`;
  return html`<div class="purchase-tip">
    <div class="tip-head">${badge}<strong>${R.tipRange(rangeText(rec.startTicket,rec.endTicket),rec.count)}</strong>${rec.mine?html`<span class="tag kas">${L.common.you}</span>`:''}</div>
    <div class="tip-body">
      <span>${R.tipBuyer}${hash(addr,{n:10,link:x.ex.addr(addr),L})}</span>
      <span>${R.tipBuyTx}${buyRc?html`${hash(buyRc.txid,{n:10,link:x.ex.tx(buyRc.txid),L})} <span class="dim">${R.tipFeeMeta(buyRc.finalized!==false,feeText(buyRc.feeSompi),u)}</span>`:html`<span class="muted">${R.tipNoBuyIndex}</span>`}</span>
      ${rec.refunded?html`<span>${R.tipRefundTx}${refundRc?html`${hash(refundRc.txid,{n:10,link:x.ex.tx(refundRc.txid),L})} <span class="dim">${R.tipFeeMeta(refundRc.finalized!==false,feeText(refundRc.feeSompi),u)}</span>`:html`<span class="muted">${R.tipNoRefundIndex}</span>`}</span>`:''}
    </div>
  </div>`;
}
function selectedShardPanel(sh: ShardView,D: Detail,x: Ctx,L: Locale): Raw {
  const R=L.round,tone=SHARD_TONE[sh.status].tone,statusLabel=R.shardStatus[sh.status],recs=sh.records,draw=D.r.draw??null,pixelMode=!!x.S.pixelMode;
  const modeSwitch=recs&&recs.length?html`<div class="seg" role="group" aria-label="${R.shardModeAria}"><button type="button" data-pixelmode="0" aria-pressed="${!pixelMode}">${R.shardModeNum}</button><button type="button" data-pixelmode="1" aria-pressed="${pixelMode}">${R.shardModePixel}</button></div>`:'';
  const header=html`<div class="shard-head"><span class="badge ${tone}">${statusLabel}</span>
    <h4>${sh.kind==='active'?R.shardCurrentTitle:R.shardFrozenTitle(sh.index+1)}</h4>
    <span class="small muted">${R.shardHeaderMeta(rangeText(sh.startTicket,sh.endTicket),L.format.tickets(sh.tickets),recs?recs.length:null)}</span>
    ${sh.mineCount>0?html`<span class="tag kas">${R.shardMineTag(sh.mineCount.toLocaleString())}</span>`:''}<span class="spacer"></span>
    ${modeSwitch}<button type="button" class="btn sm" data-shard="close">${R.shardCollapse}</button></div>`;
  if(recs===null){
    const shardRefunds=sh.status==='refunded'||sh.status==='refunding'?shardRefundReceipts(sh,D):[];
    const body=R.shardRecycledBody(sh.status==='refunded',sh.tickets.toLocaleString(),!!sh.hash);
    return html`<div class="shard-detail">${header}
      <p class="muted small">${body.before}${sh.hash?html`${body.hashLabel}<span class="mono">${shortHash(sh.hash,10,6)}</span>`:''}${body.after}</p>
      ${shardRefunds.length?html`<div class="tip-body" style="margin-top:6px"><span>${R.shardRefundTxs(shardRefunds.length)}${shardRefunds.map(t=>hash(t.txid,{n:8,link:x.ex.tx(t.txid),L}))}</span></div>`:''}</div>`;
  }
  if(!recs.length)return html`<div class="shard-detail">${header}<p class="muted small">${R.shardNoBuys}</p></div>`;
  const addrCache=new Map<string,string>();
  const addrOf=(k: string): string=>{let a=addrCache.get(k);if(!a){a=x.ex.addrOfKey(k)??k;addrCache.set(k,a);}return a;};
  const selIdx=x.S.purchase??null,selRec=selIdx!=null?recs.find(r=>r.index===selIdx)??null:null;
  const cells=recs.map(rec=>{
    const isWin=!!draw&&draw.shard===sh.index&&draw.record===rec.index,isSel=selIdx===rec.index,addr=addrOf(rec.key);
    const title=R.shardCellTitle(rec.index+1,rangeText(rec.startTicket,rec.endTicket),rec.count,shortHash(addr,8,6),rec.mine,isWin?draw.ticket+1:null,rec.refunded);
    return html`<button type="button" class="cell${isWin?' w':''}${rec.mine?' me':''}${rec.refunded?' refunded':''}${isSel?' active':''}" style="--c:${keyColor(rec.key)}" data-purchase="${rec.index}" aria-pressed="${isSel}" aria-label="${R.shardCellAria(rec.index+1)}" title="${title}">${isWin?'🏆':rec.index+1}</button>`;
  });
  const emptyCount=Math.max(0,256-recs.length);
  const blanks=emptyCount>0?Array.from({length:emptyCount},()=>html`<span class="cell blank" aria-hidden="true"></span>`):[];
  const legend=draw&&draw.shard===sh.index?html`<div class="legend"><span><i style="--c:var(--gold)"></i>${R.shardWinLegend(draw.ticket+1,draw.record+1)}</span></div>`:'';
  return html`<div class="shard-detail">${header}
    <div class="matrix${pixelMode?' pixel':''}" role="region" aria-label="${R.shardMatrixAria}">${cells}${blanks}</div>
    ${purchaseTip(selRec,sh,D,x,L)}
    ${legend}
  </div>`;
}
function shardSection(D: Detail,x: Ctx,L: Locale): Raw {
  const R=L.round,{r,f}=D;
  if(r.terminal==='EMPTY')return html`<p class="muted small">${R.shardEmptyRound}</p>`;
  const shards=D.shards;
  if(r.terminal&&(!shards||!shards.length))return html`<p class="muted small">${R.shardTerminalNoData(terminalLabel(r.terminal,L),f.tickets.toLocaleString())}</p>`;
  if(!shards){
    if(f.tickets>0)return html`<p class="muted small">${R.shardNeedFullState(f.tickets.toLocaleString(),f.shards,f.localRecords)}</p>`;
    return html`<p class="muted small">${R.shardNoneYet}</p>`;
  }
  if(!shards.length)return html`<p class="muted small">${R.shardNoneYet}</p>`;
  const draw=r.draw??null,selIdx=x.S.shard??null,sel=selIdx!=null?shards.find(s=>s.index===selIdx)??null:null;
  const counts={frozen:shards.filter(s=>s.kind==='frozen').length,active:shards.filter(s=>s.kind==='active').length,
    refunding:shards.some(s=>s.status==='refunding'),done:shards.some(s=>s.records===null),mine:shards.some(s=>s.mineCount>0)};
  const rows=Math.max(1,Math.ceil(shards.length/16));
  const cells=shards.map(sh=>{
    const statusLabel=R.shardStatus[sh.status],isSel=sel?.index===sh.index,done=sh.records===null,isWinShard=!!draw&&draw.shard===sh.index;
    const title=R.shardCardTitle(sh.index+1,statusLabel,rangeText(sh.startTicket,sh.endTicket),L.format.tickets(sh.tickets),sh.recordCount,isWinShard?draw.ticket+1:null,sh.mineCount);
    return html`<button type="button" class="shard-card${isWinShard?' w':''}${done?' done':''}${sh.mineCount>0?' me':''}${isSel?' active':''}" data-shard="${sh.index}" aria-pressed="${isSel}" aria-label="${R.shardAria(sh.index+1)}" title="${title}"></button>`;
  });
  const legend=html`<div class="legend">
    ${counts.active?html`<span><i style="--c:${r.terminal?'var(--sky)':'var(--kas)'}"></i>${r.terminal?R.legendTail:R.legendCurrent}</span>`:''}
    ${counts.frozen?html`<span><i style="--c:var(--sky)"></i>${r.terminal==='PAID'?R.legendFrozenPaid(counts.frozen):r.terminal==='REFUNDED'?R.legendFrozenRefunded(counts.frozen):R.legendFrozen(counts.frozen)}</span>`:''}
    ${counts.refunding?html`<span><i style="--c:var(--amber)"></i>${R.legendRefunding}</span>`:''}
    ${counts.done?html`<span><i style="--c:var(--panel3);border:1px solid var(--line2)"></i>${R.legendRecycled}</span>`:''}
    ${counts.mine?html`<span><i style="--c:var(--kas);box-shadow:inset 0 0 0 1px #fff"></i>${R.legendMine}</span>`:''}
    ${draw?html`<span><i style="--c:var(--gold)"></i>${R.legendWinnerShard(draw.shard+1,draw.ticket+1)}</span>`:''}
  </div>`;
  const shardSettle=D.interactive?.shardSettlement?shardSettlementList(D.interactive.shardSettlement,D,x,L):'';
  return html`<p class="small muted" style="margin:0 0 8px">${R.shardSummary(r.terminal?R.shardEndedPrefix(terminalLabel(r.terminal,L)):'',shards.length,counts.frozen,f.tickets.toLocaleString())}</p>
    <div class="shard-wall"><div class="shard-wall-inner" style="--rows:${rows}">
      <canvas class="shard-wall-canvas" width="288" height="${rows*SHARD_STRIDE}" data-shard-wall="1" aria-hidden="true"></canvas>
      <div class="shard-grid" role="region" aria-label="${R.shardGridAria}">${cells}</div>
    </div></div>
    ${legend}
    ${sel?selectedShardPanel(sel,D,x,L):''}
    ${shardSettle}`;
}
function shardSettlementList(st: ShardSettlementModel,D: Detail,x: Ctx,L: Locale): Raw|'' {
  if(!st.groups.length)return '';
  const R=L.round,tu=isTokenAsset(D.asset)?D.asset.symbol:unitOf(x),rew=st.execRewardFormatted??'0',busy=x.busy||!signing(x.wallet);
  return html`<div class="list" style="display:grid;gap:8px;margin-top:12px">${st.groups.map(g=>html`
    <div class="card" style="padding:10px">
      <div class="row small"><strong>${R.shardItemLabel(shortHash(g.shardId,8,6))}</strong><span class="spacer"></span><span class="badge">${g.mode==='payout'?R.shardPayoutBadge:R.shardRefundBadge}</span></div>
      ${g.mode==='payout'?html`<div class="btnrow" style="margin-top:8px">
        ${g.selfPayoutOp?html`<button type="button" class="btn sm pri" data-proto-act="${g.selfPayoutOp.action}" data-shard-cid="${g.selfPayoutOp.shardCid}" ${busy?'disabled':''}>${R.shardPayoutSelfShort}</button>`:''}
        ${g.execPayoutOp?html`<button type="button" class="btn sm ${g.selfPayoutOp?'':'pri'}" data-proto-act="${g.execPayoutOp.action}" data-shard-cid="${g.execPayoutOp.shardCid}" ${busy?'disabled':''}>${R.shardPayoutExecShort(rew,tu)}</button>`:''}
      </div>`:''}
      ${g.mode==='refund'&&g.claims?html`<div style="margin-top:8px;display:grid;gap:6px">${g.claims.map(c=>html`<div class="row small"><span>#${c.recordIndex+1} (${shortHash(c.buyerKey,6,4)} · ${L.format.tickets(c.tickets)} · ${fmtAmt(c.amount,D.asset)} ${tu})</span><span class="spacer"></span>
        ${c.claimed?html`<span class="tag">${R.shardClaimedTag}</span>`:html`<button type="button" class="btn sm pri" data-proto-act="${c.op.action}" data-shard-cid="${c.op.shardCid}" data-rec-idx="${c.op.recIdx}" ${busy?'disabled':''}>${R.shardClaimShort}</button>`}</div>`)}</div>`:''}
    </div>`)}</div>`;
}
function shardSettlementHero(st: ShardSettlementModel,D: Detail,x: Ctx,L: Locale): Raw|'' {
  if(!st.groups.length)return '';
  const R=L.round,kasU=unitOf(x),tu=isTokenAsset(D.asset)?D.asset.symbol:kasU,rew=st.execRewardFormatted??'0',dep=st.depositKas;
  const hasRefund=st.mode==='refund';
  const canAct=!x.busy&&signing(x.wallet)&&!!x.conn.node;
  return html`<div class="act act-hero">
    <h4>${hasRefund?R.shardRefundHeroTitle(tu,dep,kasU):R.shardPayoutHeroTitle(tu,dep,kasU)}</h4>
    <p>${hasRefund?R.shardRefundHeroDesc(dep,kasU,tu):R.shardPayoutHeroDesc(dep,kasU,rew,tu)}</p>
    ${!signing(x.wallet)?html`<div class="why">${R.shardNeedWallet}</div><button type="button" class="btn pri block" data-fix="wallet">${R.shardConnectToClaim}</button>`:html`
      <div style="display:grid;gap:8px;margin-top:8px">${st.groups.map(g=>g.mode==='refund'&&g.claims?html`
        ${g.claims.map(c=>c.claimed?'':html`<button type="button" class="btn pri block" data-proto-act="${c.op.action}" data-shard-cid="${c.op.shardCid}" data-rec-idx="${c.op.recIdx}" ${canAct?'':'disabled'}>${x.busy?L.common.working:R.shardClaimBtn(fmtAmt(c.amount,D.asset),tu,shortHash(g.shardId,6,4),c.recordIndex+1)}</button>`)}
      `:html`<div class="btnrow">
        ${g.selfPayoutOp?html`<button type="button" class="btn pri" data-proto-act="${g.selfPayoutOp.action}" data-shard-cid="${g.selfPayoutOp.shardCid}" ${canAct?'':'disabled'}>${x.busy?L.common.working:R.shardPayoutSelfBtn(shortHash(g.shardId,6,4))}</button>`:''}
        ${g.execPayoutOp?html`<button type="button" class="btn ${g.selfPayoutOp?'':'pri'}" data-proto-act="${g.execPayoutOp.action}" data-shard-cid="${g.execPayoutOp.shardCid}" ${canAct?'':'disabled'}>${x.busy?L.common.working:R.shardPayoutExecBtn(rew,tu,shortHash(g.shardId,6,4))}</button>`:''}
      </div>`)}</div>`}
  </div>`;
}
function discoveredDetailView(d: DiscoveredRound,x: Ctx,L: Locale): Raw {
  const R=L.round,cp=compatOf(x,d),asset=assetOfDisc(d,x),isToken=isTokenAsset(asset),isParallel=isToken||!!d.settlementProgress;
  const ph=indexedPhase(d,L),kasU=unitOf(x),u=isToken?asset.symbol:kasU,cid=d.cid;
  const protoLabel=cp?.displayName??cp?.name??(isToken?`${u} (${asset.kind})`:kasU);
  const tkt=d.terminal?(d.bought??d.ticketsSold??d.tickets??0):(d.ticketsSold??d.tickets??0);
  const mval=indexedKasPool(d);
  const tokenPool=isToken&&d.ticketPrice?BigInt(tkt)*safeBig(d.ticketPrice):0n;
  const refund=d.module==='refund'||d.phase==='REFUNDING'||d.terminal==='REFUNDED',labels=refund?L.actions.stepsRefund:L.actions.stepsNormal;
  const pos=d.terminal?4:(d.module==='sealed'||d.phase==='SEALED')?1:(d.module==='win'||d.module==='refund'||d.phase==='SETTLING'||d.phase==='REFUNDING')?2:0;
  const isIncompat=!!(d.profileId&&x.supportedProfiles&&!x.supportedProfiles.has(d.profileId));
  const compatList=x.compatibleProfiles??[];
  const statusNotice=isIncompat
    ?html`<div class="notice warn">
      <h3>${R.incompatHeading}</h3>
      <p>${R.incompatBody}</p>
      <dl class="kv" style="margin:10px 0 8px">
        <dt>${R.incompatProtocolLabel}</dt><dd>${protoLabel}${d.protocolId?html` <span class="mono small muted">(${d.protocolId})</span>`:''}</dd>
        <dt>${R.incompatProfileLabel}</dt><dd><span class="mono small" style="word-break:break-all;user-select:all">${d.profileId}</span></dd>
        ${compatList.length?html`<dt>${R.incompatSupportedLabel}</dt><dd class="small muted">${compatList.map((p,i)=>html`${i?' · ':''}${p.asset}: <span class="mono">${shortHash(p.profileId,8,4)}</span>`)}</dd>`:''}
      </dl>
      <div class="btnrow" style="margin-top:8px">
        <button type="button" class="btn sm" data-copy="${d.profileId}">${ic('copy')}${R.copyProfileBtn}</button>
        <a class="btn sm ghost" href="https://github.com/agang0311/kaswin/releases" target="_blank" rel="noopener noreferrer">${R.findReleaseBtn}</a>
      </div>
    </div>`
    :x.verify?.state==='bad'
      ?verifyPanel(x.verify,L)
      :x.conn.node===false
        ?html`<div class="notice warn">${R.nodeDisconnectedNotice}</div>`
        :html`<div class="notice">${R.bgSyncingNotice}</div>`;
  const modHint=d.terminal
    ?L.actions.hintTerminal[d.terminal]??''
    :(isParallel&&L.actions.hintModuleParallel[d.module??'']?L.actions.hintModuleParallel[d.module??'']!(u,kasU):L.actions.hintModule[d.module??'']??'');
  const starred=!!x.saved?.has(cid);
  return html`
  <div class="round-shell">
  <div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}${L.common.back}</button><span class="spacer"></span>
    <button class="btn sm star-btn${starred?' starred':''}" data-act="toggleStar" aria-pressed="${starred?'true':'false'}">${ic('star')}${starred?L.common.starred:L.common.star}</button></div>
  <div class="panel t-${ph.tone} round-hero">
    <div class="row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="badge t-${ph.tone}">${ph.label}</span><span class="badge asset-badge">${u}</span><span class="spacer"></span>
      <span class="tag">${isIncompat?R.incompatibleBadge:R.localCacheSummary}</span></div>
    <div class="hero-kpis cols-2">
      ${kpi(d.terminal?R.kpiSoldTotal:R.kpiCurrentPool,isToken?`${fmtAmt(tokenPool,asset)} ${u}`:(mval>0n?`${kas(mval)} ${u}`:(d.terminal?R.kpiSettled:'—')))}
      ${kpi(R.kpiTicketsSold,L.format.tickets(tkt),d.buys!=null?L.format.buys(d.buys):R.kpiLoading)}
    </div>
    <div class="stepper">${labels.map((l,i)=>html`<div class="step ${i<pos?'done':i===pos?'now':''} ${refund&&i>=2?'alt':''}"><div class="b">${i<pos?'✓':i+1}</div>${l}</div>`)}</div>
    ${statusNotice}
    <p class="muted small" style="margin:8px 0 0">${modHint}</p>
  </div>
  </div>`;
}
const ORDER: Record<string,string[]>={sales:['BUY','CLOSE'],sealed:['DRAW','TIMEOUT'],win:['PAY_OLD','PAY_SELF'],refund:['REFUND_OLD','REFUND_SELF']};
function drawVerifySection(D: Detail,x: Ctx,L: Locale): Raw|'' {
  const {r,f}=D,R=L.round;
  if(!f.winnerKey&&!r.draw)return '';
  const draw=r.draw??null,proof=draw?.proof??null;
  if(!proof){
    return html`<details class="adv-details draw-verify-box" style="margin-top:12px">
      <summary class="small muted">${ic('check')} ${R.drawVerifySummary}</summary>
      <div class="adv-body"><p class="small muted" style="margin:0">${x.conn.node===false?R.drawVerifyNeedNode:R.drawVerifyLoading}</p></div>
    </details>`;
  }
  const check=recomputeDrawProof(proof);
  const pyScript=buildPythonVerifyScript(proof);
  const blockLink=x.ex.block?x.ex.block(proof.targetBlockHash):undefined;
  return html`<details class="adv-details draw-verify-box" style="margin-top:12px">
    <summary class="small">${ic('check')} ${R.drawVerifySummary}</summary>
    <div class="adv-body">
      <div class="notice ${check.ok?'ok':'bad'}" style="margin:0">${check.ok?R.drawVerifyOk(proof.winningTicket,(draw?.shard??0)+1,(draw?.record??0)+1):R.drawVerifyBad}</div>
      <dl class="kv">
        ${draw?.txid?html`<dt>${R.drawVerifyDrawTx}</dt><dd>${hash(draw.txid,{n:10,link:x.ex.tx(draw.txid),L})}</dd>`:''}
        <dt>${R.drawVerifySealedUtxo}</dt><dd class="mono small">${shortHash(proof.sealedTxid,10,6)}:${proof.sealedIndex}</dd>
        <dt>${R.drawVerifyBoundary}</dt><dd class="mono small">${R.drawVerifyBoundaryVal(proof.sealedDaa,proof.boundaryDaa)}</dd>
        <dt>${R.drawVerifyTargetBlock}</dt><dd>${hash(proof.targetBlockHash,{n:10,link:blockLink,L})}<div class="small muted mono">${R.drawVerifyTargetDaa(proof.parentBlockDaa,proof.targetBlockDaa,proof.boundaryDaa)}</div></dd>
        <dt>${R.drawVerifySeqCommit}</dt><dd>${hash(proof.sequenceCommitment,{n:10,L})}</dd>
        <dt>${R.drawVerifyTotal}</dt><dd class="mono">${proof.totalTickets.toLocaleString()}</dd>
        <dt>${R.drawVerifySeed}</dt><dd>${hash(proof.seed,{n:10,L})}</dd>
        <dt>${R.drawVerifyDigest}</dt><dd>${hash(proof.digest,{n:10,L})}</dd>
        <dt>${R.drawVerifySample}</dt><dd class="mono small">${R.drawVerifyFormula(proof.sample,proof.totalTickets,proof.winningTicket)}</dd>
      </dl>
      <div class="btnrow"><button type="button" class="btn sm" data-copy="${pyScript}">${ic('copy')}${R.drawVerifyCopyPython}</button></div>
      <p class="small muted" style="margin:0">${R.drawVerifyHint}</p>
    </div>
  </details>`;
}
export function roundView(x: Ctx): Raw {
  const L=locOf(x),R=L.round,D=x.detail,p=x.submission?.cid===x.S.cid?x.submission:null;
  const progress=p?html`<div class="notice ${p.error?'bad':''}" role="${p.error?'alert':'status'}" aria-live="polite" aria-busy="${p.error?'false':'true'}">
    <h3>${p.error?R.subFailedTitle:R.subSubmittingTitle}</h3>
    <p>${p.error?p.error:R.subSubmittingDesc}</p>
    ${p.error?html`<p>${R.subFailedHint}</p>`:''}
    <dl class="kv"><dt>${R.subAction}</dt><dd>${actionTitle(p.action,L)}</dd><dt>${R.subTxid}</dt><dd>${hash(p.txid,{n:14,L})}</dd></dl>
  </div>`:'';
  if(!D){
    if(p)return html`<div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}${L.common.backToList}</button></div><div class="panel"><h2>${R.roundHeading} ${hash(p.cid,{n:14,L})}</h2>${progress}</div>`;
    const disc=x.S.cid?x.discovered?.find(d=>d.cid===x.S.cid)??null:null;
    if(disc)return discoveredDetailView(disc,x,L);
    if(x.verify?.state==='checking'||x.conn.node===null)return html`<div class="empty"><p>${R.syncingOverview}</p></div>`;
    if(x.verify?.state==='bad')return html`<div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}${L.common.backToList}</button></div><div class="panel">${verifyPanel(x.verify,L)}</div>`;
    return html`<div class="empty">${R.notFound}<button class="link" data-go2="explore">${L.common.backToList}</button></div>`;
  }
  const {r,f}=D,dAsset=D.asset,meta=D.protocolMeta,isToken=isTokenAsset(dAsset),isParallel=meta?meta.shardModel==='parallel':(isToken||!!D.interactive?.shardSettlement);
  const ph=localizePhase(D.ph,L),price=f.ticketPrice,open=!r.terminal&&!r.halted&&!r.intent&&r.manager,u=unitOf(x),tu=isToken?dAsset.symbol:u;
  const maxShards=meta?.maxShards??MAX_SHARDS;
  const order=ORDER[f.module??'']??[];
  const cards=open?order.map(a=>{
    const st=D.a[a];
    if(a==='CLOSE'&&st&&!st.ok)return '';
    return actionCard(a,D,x,L);
  }).filter(c=>c!==''):[];
  const shardTopAct=D.interactive?.shardSettlement&&!r.terminal&&!r.halted&&!r.intent?shardSettlementHero(D.interactive.shardSettlement,D,x,L):'';
  const allCards=shardTopAct?[shardTopAct,...cards]:cards;
  const ownerAddr=f.owner?x.ex.addrOfKey(f.owner):null;
  const genesisTx=r.receipts.find(t=>t.action==='GENESIS');
  const mine=D.mine;
  const disc=x.discovered?.find(d=>d.cid===r.cid)??null;
  const detailVerifyNotice=D.preview
    ?html`<div class="notice">${R.previewNotice}</div>`
    :x.verify?.state==='bad'||x.verify?.state==='partial'
      ?verifyPanel(x.verify,L,disc,f.tickets)
      :(x.verify?.state==='checking'&&!x.conn.node&&!r.terminal
        ?html`<div class="notice">${R.localCacheLoadingNotice}</div>`
        :'');
  const dtab=x.S.detailTab??'rules';
  const salesRemainDaa=(): bigint|null=>{
    if(x.daa===null)return null;
    const raw=f.closeEligibleDaa-x.daa;
    if(raw<=0n)return 0n;
    if(!x.daaObservedAt)return raw;
    const elapsedDaa=BigInt(Math.max(0,Math.floor((Date.now()-x.daaObservedAt)/1000)))*10n;
    return raw>elapsedDaa+10n?raw-elapsedDaa:10n;
  };
  const remDaa=f.module==='sales'&&!D.a.CLOSE?.ok?salesRemainDaa():null;
  const closeHint=f.module==='sales'&&!D.a.CLOSE?.ok
    ?(remDaa===null?R.closeCountdownReading:`${R.closeWaitFallback}${L.format.daaDuration(remDaa)}`)
    :(f.module==='sales'?R.closeReadyFallback:'');
  const drawHint=f.module==='sealed'?drawReadiness(D,x):null;
  const statusBanner=drawHint
    ?html`<div class="notice round-countdown ${drawHint.ready?'ok':''}" role="status"><h3>${ic('clock')} ${drawHint.label}</h3><p>${drawHint.detail}</p>${drawHint.percent!==null?html`<progress max="100" value="${drawHint.percent}" aria-label="${drawHint.label}"></progress>`:''}</div>`
    :'';
  const heroCountdown=f.module==='sales'&&!r.terminal&&closeHint
    ?html`<div class="hero-countdown${D.a.CLOSE?.ok?' ok':''}" role="status">${ic('clock')} <span>${closeHint}</span></div>`
    :'';
  const actionSection=allCards.length?html`<div class="panel action-panel">
    ${statusBanner}
    <div class="actions${allCards.length===1?' single':''}">${allCards}</div>
  </div>`:(statusBanner?html`<div class="panel action-panel">${statusBanner}</div>`:(r.terminal?html`<div class="panel"><p class="muted" style="margin:0">${ph.label}${L.key==='zh-CN'?'：':': '}${L.actions.hintTerminal[r.terminal]??''}</p></div>`:''));
  const cp=compatOf(x,{profileId:r.profileId??meta?.profileId,protocolId:meta?.protocolId??r.protocolId??r.protocol});
  const roundProfileId=r.profileId??meta?.profileId??cp?.profileId??null;
  const protoLabel=meta?.displayName??cp?.displayName??cp?.name??(isToken?`${tu} (${dAsset.kind})`:u);
  const showCap=!isParallel&&f.ticketCap>0&&f.ticketCap<65536;
  const starred=!!x.saved?.has(r.cid);
  return html`
  <div class="round-shell">
  <div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}${L.common.back}</button><span class="spacer"></span>
    <button class="btn sm star-btn${starred?' starred':''}" data-act="toggleStar" aria-pressed="${starred?'true':'false'}">${ic('star')}${starred?L.common.starred:L.common.star}</button>
    <button class="btn sm" data-act="moreRound" aria-haspopup="dialog" aria-label="${R.toolsTitle}" ${D.preview?'disabled':''}>${L.common.more}</button></div>
  <div class="panel t-${ph.tone} round-hero">
    <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="badge t-${ph.tone}">${ph.label}</span>
      <span class="badge asset-badge">${tu}</span>
      ${D.preview?html`<span class="tag">${R.previewBadge}</span>`:''}
      <span class="spacer"></span>
      <span class="small muted">#${hash(r.cid,{n:6,L})}</span>
    </div>
    <div class="hero-kpis">
      ${kpi(r.terminal?R.kpiSoldTotal:R.kpiCurrentPool,f.tickets!=null?html`${fmtAmt(BigInt(f.tickets)*price,D.asset)} <span class="small muted">${tu}</span>`:'—',f.tickets!=null?R.kpiPerTicket(fmtAmt(price,D.asset),tu):'')}
      ${kpi(R.kpiTicketsSold,f.tickets!=null?R.kpiTicketsSoldVal(f.tickets.toLocaleString(),f.ticketCap.toLocaleString(),showCap):'—',f.tickets!=null?R.kpiMinDraw(f.minTickets):'')}
      ${f.winnerKey?kpi(R.kpiWinner,hash(x.ex.addrOfKey(f.winnerKey),{n:10,L}),D.isWinner?R.kpiWinnerYou:''):
        kpi(mine?R.kpiYouHold:R.kpiYourTickets,mine?L.format.tickets(mine.tickets):signing(x.wallet)?L.format.tickets(0):'—',mine&&mine.total>0&&(f.module==='sales'||f.module==='sealed')?R.kpiWinOdds((mine.tickets/mine.total*100).toFixed(2)):'')}
    </div>
    ${f.module||r.terminal?stepper(D,L):''}
    ${heroCountdown}
    ${progress}${intentPanel(D,x,L)}${detailVerifyNotice}
  </div>
  ${actionSection}
  <div class="panel detail-panel">
    <div class="detail-tabs seg" role="tablist" aria-label="${R.tabsAria}">
      <button type="button" role="tab" data-dtab="rules" aria-selected="${dtab==='rules'||dtab==='txs'}" aria-pressed="${dtab==='rules'||dtab==='txs'}">${ic('clock')} ${R.tabRules}</button>
      <button type="button" role="tab" data-dtab="map" aria-selected="${dtab==='map'}" aria-pressed="${dtab==='map'}">${ic('grid')} ${R.tabMap}</button>
    </div>
    <div class="detail-tab-body">
      ${dtab==='map'?shardSection(D,x,L):dtab==='txs'?txTable(D,x,L):html`<dl class="kv">
        <dt>${R.infoPrice}</dt><dd>${fmtAmt(price,D.asset)} ${tu}</dd>
        <dt>${R.infoMinDraw}</dt><dd>${R.infoMinDrawVal(f.minTickets)}</dd>
        <dt>${R.infoEarliestClose}</dt><dd>${f.closeEligibleDaa>0n?(x.daa!=null&&x.daa>=f.closeEligibleDaa?R.infoCloseReached:R.infoCloseApprox(wait(x.daa,f.closeEligibleDaa,L))):'—'}</dd>
        <dt>${R.infoCreator}</dt><dd>${ownerAddr?hash(ownerAddr,{n:10,link:x.ex.addr(ownerAddr),L}):html`<span class="muted">—</span>`}</dd>
        <dt>${R.infoGenesisTx}</dt><dd>${genesisTx?hash(genesisTx.txid,{n:10,link:x.ex.tx(genesisTx.txid),L}):html`<span class="muted">—</span>`}</dd>
      </dl>
      ${drawVerifySection(D,x,L)}
      <div style="margin-top:16px"><h4 style="margin:0 0 8px;font-size:13px">${R.tabTxs}</h4>${txTable(D,x,L)}</div>
      <details class="adv-details" style="margin-top:12px"><summary class="small muted">${R.techSummary}</summary><dl class="kv" style="margin-top:8px">
        <dt>${R.infoProtocol}</dt><dd>${protoLabel}</dd>
        <dt>${R.infoProfile}</dt><dd>${roundProfileId?html`${hash(roundProfileId,{n:12,L})} <span class="tag kas">${L.common.compatible}</span>`:html`<span class="muted">—</span>`}</dd>
        <dt>${isParallel?R.kpiActiveShards:R.kpiFrozenShards}</dt><dd>${isParallel?`${f.shards} / ${maxShards}`:L.format.shards(f.shards)}</dd>
        <dt>${R.techDrawWait}</dt><dd>${R.techDrawWaitVal}</dd>
        <dt>${R.techTimeout}</dt><dd>${R.techTimeoutVal}</dd>
        <dt>${R.techTotalFees}</dt><dd>${kas(r.fees)} ${u}</dd>
        <dt>${R.techFullCid}</dt><dd class="mono small">${r.cid}</dd>
        ${roundProfileId?html`<dt>${R.infoFullProfile}</dt><dd class="mono small">${roundProfileId}</dd>`:''}
        ${r.origin?html`<dt>${R.techOrigin}</dt><dd class="mono small" title="${R.techOriginTitle}">${shortHash(r.origin.transactionId,10,6)}:${r.origin.index}</dd>`:''}
        ${r.manager?html`<dt>${R.techStateUtxo}</dt><dd class="mono small">${shortHash(r.manager.outpoint.transactionId,10,6)}:${r.manager.outpoint.index}</dd><dt>${R.techLocked}</dt><dd>${kas(r.manager.value)} ${u}</dd>`:''}
        <dt>${R.techSource}</dt><dd>${r.source==='imported'?R.techSourceImported:R.techSourceLocal}</dd>
      </dl></details>`}
    </div>
  </div>
  </div>`;
}

export function roundToolsBody(cid: string,L: Locale=getLocale()): Raw {
  return html`<div class="round-tools-actions">
    <button type="button" class="btn block" data-act="share" data-round="${cid}">${ic('copy')}${L.round.toolsCopyShare}</button>
    <button type="button" class="btn block" data-act="export" data-round="${cid}">${ic('download')}${L.round.toolsExportFile}</button>
  </div>`;
}

/* ------------------------------------------------------------------ mine */
export function mineView(x: Ctx): Raw {
  const L=locOf(x),M=L.mine,R=L.round,w=x.wallet,u=unitOf(x),netLabel=L.chrome.netLabel(x.net.key);
  const mineRounds=w?(x.mine?.rounds??[]):[];
  const txs=w?(x.mine?.txs??[]):[];
  const pendingCount=x.items.filter(i=>(i.r.pending?.length??0)>0||(!!i.r.intent&&['SUBMITTED','UNKNOWN'].includes(i.r.intent.status))).length;
  return html`
  <div class="cols">
    <div class="panel"><h2>${ic('wallet')} ${M.walletHeading}</h2>
      ${w?html`<dl class="kv"><dt>${M.typeLabel}</dt><dd>${w.kind==='extension'?w.name??M.walletTypeExtFallback:w.kind==='key'?M.walletTypeMemory:M.walletTypePublic}</dd><dt>${M.addressLabel}</dt><dd>${hash(w.address,{n:16,link:x.ex.addr(w.address),L})}</dd>
        ${signing(w)?html`<dt>${M.balanceLabel}</dt><dd>${x.balance==null?M.balanceLoading:`${kas(x.balance)} ${u}`}</dd>`:''}</dl>
        <div class="btnrow" style="margin-top:12px"><button class="btn sm" data-fix="wallet">${M.manageWallet}</button></div>`
        :html`<p class="sub">${M.noWalletDesc}</p><button class="btn pri" data-fix="wallet">${ic('wallet')}${L.chrome.connectWallet}</button>`}
      <p class="small muted" style="margin:14px 0 0">${x.net.key==='mainnet'?M.netNoticeMainnet(netLabel):M.netNoticeTestnet(netLabel)}</p></div>
    <div class="panel"><h2>${ic('ledger')} ${M.myRoundsHeading}</h2>
      ${!w?html`<p class="muted small">${M.myRoundsConnect}</p>`:
        mineRounds.length?html`<div class="outs">${mineRounds.map(({item:i,tickets,created,won})=>{
          const tu=isTokenAsset(i.asset)?i.asset.symbol:u;
          const poolText=i.f.tickets!=null?`${fmtAmt(BigInt(i.f.tickets)*i.f.ticketPrice,i.asset)} ${tu}`:`#${shortHash(i.r.cid,6,4)}`;
          return html`<button class="out" data-open="${i.r.cid}" style="text-align:left;cursor:pointer"><span class="r">${localizePhase(i.ph,L).label}</span><span class="small"><b>${poolText}</b> <span class="muted mono">#${shortHash(i.r.cid,6,4)}</span></span><span class="v">${won?M.roleWon:tickets>0?M.roleMine(tickets):created?M.roleCreated:''}${i.f.tickets!=null?L.format.tickets(i.f.tickets):''}</span></button>`;
        })}</div>`
        :html`<p class="muted small">${M.myRoundsEmpty}</p>`}</div>
  </div>
  <div class="panel"><div class="row" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px"><h2 style="margin:0">${ic('check')} ${M.myTxsHeading}</h2><span class="spacer"></span>
    ${w?html`<button class="btn sm" data-act="checkPending" ${pendingCount&&!x.checkProgress&&!x.busy?'':'disabled'}>${x.checkProgress?x.checkProgress:M.checkPendingBtn(pendingCount)}</button>`:''}</div>
    ${!w?html`<p class="muted small">${M.myTxsConnect}</p>`:
      txs.length?html`<div class="tablewrap"><table><tr><th>${M.colRound}</th><th>${R.txColStep}</th><th>${R.txColTx}</th><th>${R.txColStatus}</th><th>${R.txColFee}</th></tr>${txs.map(({cid,t})=>html`<tr><td class="mono"><a class="link" href="#/round/${cid}">${shortHash(cid,8,4)}</a></td><td>${actionTitle(t.action,L)}</td><td>${hash(t.txid,{n:8,link:x.ex.tx(t.txid),L})}</td><td>${t.finalized===false?html`<span class="badge t-violet">${R.txPendingBadge}</span>`:html`<span class="badge t-mint">${R.txAcceptedBadge}</span>`}</td><td class="mono">${feeText(t.feeSompi)}</td></tr>`)}</table></div>`
      :html`<p class="muted small">${M.myTxsEmpty}</p>`}</div>`;
}

/* ------------------------------------------------------------------ how it works (modal) */
export function helpBody(x?: Ctx): Raw {
  const L=locOf(x),Ru=L.rules,u=unitOf(x),isMainnet=(x?.net?.key??'mainnet')==='mainnet',netLabel=L.chrome.netLabel(isMainnet?'mainnet':'tn10');
  const item=(n: string,t: string,d: string)=>html`<li><span class="n">${n}</span><div><b>${t}</b><span>${d}</span></div></li>`;
  const fallbackSpec=defaultSequentialCreateSpec(x?.net??null,{profileId:TN10_PROFILE_ID});
  const compatRows: CompatibleProfile[]=x?.compatibleProfiles?.length
    ?x.compatibleProfiles
    :[{protocolId:fallbackSpec.protocolId,name:fallbackSpec.name,displayName:fallbackSpec.displayName,asset:u,profileId:fallbackSpec.profileId,tokenCovenantId:null}];
  return html`
  <p class="sub" style="margin-top:0">${Ru.intro}</p>
  <div class="flow" style="box-shadow:none;margin-bottom:14px"><ol>
    ${Ru.steps.map(([n,t,d])=>item(n,t,d(u)))}
  </ol></div>
  <div class="adv-details" style="margin-bottom:12px">
    <h3 style="margin:0 0 8px;font-size:14px">${Ru.feesHeading}</h3>
    <dl class="kv">
      <dt>${Ru.depositLabel}</dt><dd>${Ru.depositValue(u)}</dd>
      <dt>${Ru.networkFeeLabel}</dt><dd>${Ru.networkFeeValue}</dd>
      <dt>${Ru.execRewardLabel}</dt><dd>${Ru.execRewardValue(u)}</dd>
    </dl>
  </div>
  <div class="notice warn" style="margin-bottom:12px"><b>${isMainnet?Ru.safetyBannerMainnet:Ru.safetyBannerTestnet}</b> ${Ru.safetyNoAudit}</div>
  <details class="adv-details">
    <summary class="small muted">${Ru.safetyHeading} · ${Ru.compatHeading}</summary>
    <div class="adv-body">
      <ul class="small muted" style="line-height:1.8;margin:0;padding-left:18px">
        ${Ru.safetyBullets(MAX_TICKET_CAP.toLocaleString(),netLabel,isMainnet).map(b=>html`<li>${b}</li>`)}
      </ul>
      <div class="tablewrap" style="margin-top:8px"><table>
        <thead><tr><th>${Ru.compatColProto}</th><th>${Ru.compatColAsset}</th><th>${Ru.compatColProfile}</th></tr></thead>
        <tbody>${compatRows.map(p=>html`<tr>
          <td><b>${p.displayName??`${p.asset} (${p.name})`}</b><div class="small muted mono">${p.protocolId}</div></td>
          <td>${p.asset}${p.tokenCovenantId?html`<div class="small muted">${Ru.compatToken(shortHash(p.tokenCovenantId,6,4))}</div>`:''}</td>
          <td class="mono small" style="word-break:break-all"><span style="user-select:all">${p.profileId}</span> <button type="button" class="copy-btn" data-copy="${p.profileId}" title="${L.round.copyProfileBtn}" aria-label="${L.round.copyProfileBtn}">${ic('copy')}</button></td>
        </tr>`)}</tbody>
      </table></div>
      <p class="small muted" style="margin:6px 0 0">${Ru.compatReleasesPrefix}<a class="link" href="https://github.com/agang0311/kaswin/releases" target="_blank" rel="noopener noreferrer">GitHub Releases ↗</a>${Ru.compatReleasesSuffix}</p>
    </div>
  </details>`;
}
export const rulesView=helpBody;

/* ------------------------------------------------------------------ dialogs */
export function walletBody(x: Ctx): Raw {
  const L=locOf(x),Dl=L.dialogs,M=L.mine,w=x.wallet,u=unitOf(x),isMainnet=x.net.key==='mainnet';
  if(w)return html`<dl class="kv"><dt>${M.typeLabel}</dt><dd>${w.kind==='extension'?w.name??M.walletTypeExtFallback:w.kind==='key'?M.walletTypeMemory:M.walletTypePublic}</dd><dt>${M.addressLabel}</dt><dd class="mono" style="word-break:break-all">${w.address}</dd>
    ${signing(w)?html`<dt>${M.balanceLabel}</dt><dd>${x.balance==null?M.balanceLoading:`${kas(x.balance)} ${u}`}</dd>`:''}</dl>
    <p class="sub" style="margin-top:12px">${w.kind==='extension'?Dl.walletExtNote:w.kind==='key'?Dl.walletKeyNote:Dl.walletPublicNote}</p>`;
  const tab=isMainnet&&x.S.wtab==='key'?'extension':x.S.wtab,options=x.walletOptions??[];
  const providers:[string,string,string,boolean][]=[
    ['kasware','KasWare',Dl.walletExtDesc,options.some(o=>o.id==='kasware')],
    ['kastle','Kastle',Dl.walletExtDesc,options.some(o=>o.id==='kastle')],
    ['kaspire','Kaspire',Dl.walletKaspireDesc,true],
  ].sort((a,b)=>(a[0]==='kaspire'?1:a[3]?-1:0)-(b[0]==='kaspire'?1:b[3]?-1:0)) as [string,string,string,boolean][];
  const hint=Dl.walletChooseHint(x.net.label);
  return html`<p class="err" id="wErr" role="alert"></p>
    ${tab==='extension'?html`<p class="sub" style="margin:0 0 12px">${hint.before}<b>${hint.bold}</b>${hint.after}</p>
      <div class="wallet-choices">${providers.map(([id,name,desc,ready])=>html`<button type="button" class="wallet-choice${ready&&id!=='kaspire'?' ready':''}" data-connect="${id}">
        <span class="wc-main"><b>${name}</b><small class="muted">${desc}</small></span>
        ${id==='kaspire'?html`<span class="tag">${Dl.walletTagKaspire}</span>`:ready?html`<span class="tag kas">${Dl.walletTagDetected}</span>`:html`<span class="tag">${Dl.walletTagNotInstalled}</span>`}
      </button>`)}</div>
      <div class="wallet-alt small muted"><span>${Dl.walletOtherPrefix}</span><button type="button" class="link" data-wtab="addr">${Dl.walletTabAddr}</button>${isMainnet?'':html`<span>·</span><button type="button" class="link" data-wtab="key">${Dl.walletTabKey}</button>`}</div>`
    :tab==='key'?html`<div class="wallet-back"><button type="button" class="link" data-wtab="extension">${ic('arrow')} ${Dl.walletBack}</button></div>
      <div class="notice warn"><b>${Dl.walletKeyWarnBold}</b>${Dl.walletKeyWarnRest}</div>
      <label class="field">${Dl.walletKeyField}<input id="wKey" type="password" autocomplete="off" data-lpignore="true" spellcheck="false" placeholder="${Dl.walletKeyPlaceholder}"></label>`
    :html`<div class="wallet-back"><button type="button" class="link" data-wtab="extension">${ic('arrow')} ${Dl.walletBack}</button></div>
      <label class="field">${Dl.walletAddrField(x.net.addressPrefix)}<input id="wAddr" autocomplete="off" spellcheck="false" placeholder="${Dl.walletAddrPlaceholder(x.net.addressPrefix)}"></label><p class="small muted">${Dl.walletAddrHint}</p>`}`;
}
export function settingsBody(x: Ctx): Raw {
  const L=locOf(x),Dl=L.dialogs,c=x.conn,isMainnet=x.net.key==='mainnet',netLabel=L.chrome.netLabel(x.net.key),otherNet=L.chrome.netLabel(isMainnet?'tn10':'mainnet');
  const otherLang=L.key==='en'?'简体中文':'English',isDark=x.S.theme!=='light';
  const reported=Array.isArray(c.indexerProfiles)&&c.indexerProfiles.length?new Set(c.indexerProfiles.map(p=>p.profileId)):null;
  const required=requiredCompatProfiles(x);
  const missing=reported&&required.length?required.filter(p=>!reported.has(p.profileId)):null;
  const indexerHint=c.indexer===true
    ?(c.indexerStale?Dl.indexerStale:missing===null?Dl.indexerConnected:missing.length?Dl.indexerMissing(missing.map(p=>p.asset).join(L.listSep)):Dl.indexerAllCovered)
    :(c.indexer===false?Dl.indexerFailed:Dl.indexerUnconfigured);
  return html`<div class="settings-list">
      <div class="settings-row">
        <div><b>${Dl.curNetLabel(netLabel)}</b><div class="small muted">${isMainnet?Dl.curNetSubMainnet:Dl.curNetSubTestnet}</div></div>
        <button type="button" class="btn sm" id="netBtn" data-act="switchNet">${Dl.switchNetBtn(otherNet)}</button>
      </div>
      <div class="settings-row">
        <div><b>${Dl.curLangLabel(L.label)}</b><div class="small muted">${Dl.curLangSub}</div></div>
        <button type="button" class="btn sm" id="languageBtn" data-act="switchLang">${Dl.switchLangBtn(otherLang)}</button>
      </div>
      <div class="settings-row">
        <div><b>${Dl.curThemeLabel(isDark)}</b><div class="small muted">${Dl.curThemeSub}</div></div>
        <button type="button" class="btn sm" id="themeBtn" data-act="switchTheme">${Dl.switchThemeBtn(isDark)}</button>
      </div>
      <div class="settings-row">
        <div><b>${Dl.helpRowTitle}</b><div class="small muted">${Dl.helpRowSub}</div></div>
        <button type="button" class="btn sm" data-act="openHelp">${Dl.helpRowBtn}</button>
      </div>
    </div>
    <details class="adv-details" style="margin-top:14px"${c.node!==true?' open':''}>
      <summary class="small muted">${Dl.advConnSummary}</summary>
      <div class="adv-body">
        <div class="form">
          <label class="field full">${Dl.nodesLabel(netLabel)}<textarea id="sNodes" rows="2" spellcheck="false" autocomplete="off" style="background:var(--panel);border:1px solid var(--line2);border-radius:10px;padding:10px 12px;width:100%">${x.S.nodes}</textarea>
            <small>${c.node===true?Dl.nodeConnected(c.nodeUrl??''):c.node===false?Dl.nodeConnectFailed:Dl.nodeNotConnected}</small></label>
          <label class="field full">${Dl.indexerLabel}<input id="sIndexer" value="${x.S.indexer}" spellcheck="false" autocomplete="off" placeholder="${Dl.indexerPlaceholder(x.net.key)}">
            <small>${indexerHint}</small></label>
        </div>
        <div class="btnrow"><button type="button" class="btn sm" data-act="testConn">${ic('refresh')}${Dl.testConnBtn}</button><button type="button" class="btn sm" data-act="resetConn">${Dl.resetConnBtn}</button><button type="button" class="btn sm pri" data-act="applyConn">${L.common.save}</button></div>
        <p class="err" id="sErr" role="alert"></p><div id="sProbe" style="display:grid;gap:8px"></div>
        <h4 style="margin:6px 0 0;font-size:13px">${Dl.backupHeading}</h4>
        <div class="btnrow"><button type="button" class="btn sm" data-act="exportAll">${ic('download')}${Dl.exportAll}</button>
          <button type="button" class="btn sm" data-act="pickFile">${ic('download')}${Dl.importFile}</button><input id="sFile" type="file" accept="application/json,.json" hidden></div>
        <details><summary class="small muted">${Dl.logsSummary}</summary><div class="log" style="margin-top:8px;max-height:180px;overflow:auto;font:12px var(--mono)">
          ${x.logs.length?x.logs.slice().reverse().slice(0,60).map(l=>html`<div class="${l.kind}">${new Date(l.at).toLocaleTimeString(L.timeLocale)} ${l.text}</div>`):Dl.logsEmpty}</div></details>
      </div>
    </details>`;
}

/** Confirmation of a prepared transaction: concise payment summary first (user's own token & KAS breakdown + where it goes), full on-chain outputs separated from contract rollovers. */
export function confirmBody(x: ConfirmCtx): Raw {
  const L=locOf(x),Dl=L.dialogs,p=x.prepared,rv=p.review,w=x.wallet,mine=w?.spk?.script,u=unitOf(x);
  const subAct=p.subAction??null;
  const rawTokenDelta=(rv.assetDeltas??[]).find(d=>isTokenAsset(d.asset)&&d.amount!==0n)??null;
  const isRefundForOther=subAct==='CLAIM_REFUND'&&rv.outputs.some(o=>o.role==='BUYER_REFUND'&&!o.mine);
  const isPayoutSelfForOther=subAct==='PAYOUT_SELF'&&rv.outputs.some(o=>o.role==='WINNER'&&!o.mine);
  const winnerOut=subAct==='PAYOUT_EXECUTOR'?rv.outputs.find(o=>o.role==='WINNER'&&o.mine&&o.tokenAmount!=null&&o.tokenAmount>0n):undefined;
  const otherTokenOut=rv.outputs.find(o=>!o.mine&&o.tokenAmount!=null&&o.tokenAmount>0n&&(o.role==='WINNER'||o.role==='BUYER_REFUND'))??null;
  const tokenDelta=(isRefundForOther||isPayoutSelfForOther)?null
    :(rawTokenDelta&&winnerOut?{...rawTokenDelta,amount:rawTokenDelta.amount+(winnerOut.tokenAmount??0n)}:rawTokenDelta);
  const depositDelta=(rv.assetDeltas??[]).find(d=>d.asset.kind==='KAS'&&d.role==='REFUNDABLE_DEPOSIT'&&d.amount<0n)??null;
  const authorized=rv.inputs.filter(i=>i.kind.includes('需签名')||i.kind.toLowerCase().includes('signed')).reduce((n,i)=>n+i.value,0n);
  const received=rv.outputs.filter(o=>o.mine||(!o.covenant&&o.script===mine)).reduce((n,o)=>n+o.value,0n);
  const net=received-authorized,pay=net<0n;
  const isMultiTx=!!subAct||!!rawTokenDelta;
  const returnedDeposit=isMultiTx?rv.outputs.filter(o=>o.rollover&&(o.mine||(!o.covenant&&o.script===mine))&&(o.role==='CREATOR'||o.role==='SHARD_DEPOSIT')).reduce((n,o)=>n+o.value,0n):0n;
  const paidNonRefundable=isMultiTx?rv.outputs.filter(o=>!o.rollover&&!(o.mine||(!o.covenant&&o.script===mine))&&!['MANAGER','SHARD_DEPOSIT','VAULT_DEPOSIT','FROZEN'].includes(o.role)).reduce((n,o)=>n+o.value,0n):0n;
  const tokenDestMap: Record<string,string>={
    OPEN_SHARD:Dl.confirmTokenDestNewShard,
    BUY:Dl.confirmTokenDestExistingShard,
    PAYOUT_SELF:Dl.confirmTokenDestSelfPayout,
    PAYOUT_EXECUTOR:Dl.confirmTokenDestExecPayout,
    CLAIM_REFUND:Dl.confirmTokenDestRefund,
  };
  const tokenHint=subAct?(subAct==='PAYOUT_EXECUTOR'&&winnerOut?Dl.confirmTokenDestExecWinner:tokenDestMap[subAct]??''):'';
  const depositHint=subAct==='OPEN_SHARD'?Dl.confirmDepositHintShard:Dl.confirmDepositHintMgr;
  const nonRefundHint=subAct==='GENESIS'?Dl.confirmNonRefundGenesis
    :(subAct==='PAYOUT_EXECUTOR'||subAct==='PAYOUT_SELF')?Dl.confirmNonRefundPayout
    :subAct==='CLAIM_REFUND'?Dl.confirmNonRefundRefund
    :Dl.confirmNonRefundOther;
  const roleLabelFor=(o: typeof rv.outputs[number]): string=>{
    if(o.role==='TOKEN_CHANGE'&&o.tokenSymbol)return L.actions.tokenChangeRole(o.tokenSymbol);
    if(o.role==='SHARD_DEPOSIT'&&!o.covenant)return Dl.confirmRoleShardReturn;
    if(o.role==='SHARD_DEPOSIT'&&o.rollover)return Dl.confirmRoleShardRollover;
    if(o.role==='VAULT_DEPOSIT'&&subAct==='BUY')return Dl.confirmRoleVaultBuy;
    if(o.role==='VAULT_DEPOSIT'&&o.rollover)return Dl.confirmRoleVaultRollover;
    if(o.role==='MANAGER'&&o.rollover)return Dl.confirmRoleMgrRollover;
    return roleLabel(o.role,L);
  };
  const fallbackTokenSym=tokenDelta?.asset.symbol??rawTokenDelta?.asset.symbol??otherTokenOut?.tokenSymbol??'';
  const renderOut=(o: typeof rv.outputs[number])=>{
    const isMine=!!o.mine||(!o.covenant&&o.script===mine);
    const sym=o.tokenSymbol??fallbackTokenSym;
    const covLabel=o.role==='TOKEN_CHANGE'?Dl.confirmCovTokenChange(sym):o.role==='BUYER_REFUND'?Dl.confirmCovBuyerRefund(sym):o.role==='WINNER'?Dl.confirmCovWinner(sym):o.role==='EXECUTOR'?Dl.confirmCovExec(sym):Dl.confirmCovDefault;
    const desc=o.note?localizeReviewNote(o.note,L):(o.covenant?covLabel:x.ex.addrOfScript(o.script));
    const tokAsset: AssetDescriptor|null=o.tokenAmount!=null&&o.tokenAmount>0n?{kind:'KCC20',symbol:sym,decimals:o.tokenDecimals??6,tokenCovenantId:null}:null;
    const tok=tokAsset?html`<span class="out-tok mono">${fmtAmt(o.tokenAmount!,tokAsset)} ${sym}</span>`:'';
    return html`<div class="out ${isMine?'mine':''} ${o.rollover&&!isMine?'rollover':''}"><span class="r">${roleLabelFor(o)}${tok}</span>
      <span class="out-addr ${o.note?'out-note':'mono'} small">${desc}${!o.note&&!o.covenant&&isMine?` · ${L.common.you}`:''}</span><span class="v">${kas(o.value)} ${u}</span></div>`;
  };
  const userOutputs=rv.outputs.filter(o=>!o.rollover||!!o.mine||(!o.covenant&&o.script===mine));
  const rolloverOutputs=rv.outputs.filter(o=>!!o.rollover&&!(!!o.mine||(!o.covenant&&o.script===mine)));
  const netSign=net===0n?'':(pay?'-':'+');
  const otherTokAsset: AssetDescriptor|null=otherTokenOut?{kind:'KCC20',symbol:otherTokenOut.tokenSymbol??fallbackTokenSym,decimals:otherTokenOut.tokenDecimals??6,tokenCovenantId:null}:null;
  const hasExtraKasBreakdown=!!depositDelta||returnedDeposit>0n||paidNonRefundable>0n;
  const showFeeRow=!isMultiTx||hasExtraKasBreakdown;
  return html`<p style="margin:0 0 12px;font-weight:600">${x.planText}</p>
    <div class="confirm-summary">
      ${tokenDelta?html`<div class="sum" style="border-top:0"><span class="sum-label"><span>${tokenDelta.amount<0n?Dl.confirmTokenSpend(tokenDelta.asset.symbol):Dl.confirmTokenReceive(tokenDelta.asset.symbol)}</span>${tokenHint?html`<span class="sum-hint">${tokenHint}</span>`:''}</span><span class="mono" style="font-size:16px;color:${tokenDelta.amount<0n?'var(--text)':'var(--kas-ink)'}">${tokenDelta.amount<0n?'-':'+'}${fmtAmt(tokenDelta.amount<0n?-tokenDelta.amount:tokenDelta.amount,tokenDelta.asset)} ${tokenDelta.asset.symbol}</span></div>`:''}
      ${otherTokenOut&&otherTokAsset?html`<div class="sum ${tokenDelta?'sum-sub':''}"${tokenDelta?'':html` style="border-top:0"`}><span class="sum-label"><span>${otherTokenOut.role==='WINNER'?Dl.confirmOtherWinner:Dl.confirmOtherBuyer}</span><span class="sum-hint">${otherTokenOut.role==='WINNER'?Dl.confirmOtherWinnerHint:Dl.confirmOtherBuyerHint}</span></span><span class="mono" style="${tokenDelta?'':'font-size:16px;color:var(--muted)'}">${fmtAmt(otherTokenOut.tokenAmount!,otherTokAsset)} ${otherTokAsset.symbol}</span></div>`:''}
      <div class="sum"${tokenDelta||otherTokenOut?'':html` style="border-top:0"`}><span class="sum-label"><span>${isMultiTx?Dl.confirmMultiNet(u):(pay?Dl.confirmPay:Dl.confirmReceive)}</span>${isMultiTx&&!hasExtraKasBreakdown?html`<span class="sum-hint">${Dl.confirmFeeHint}</span>`:''}</span><span class="mono" style="font-size:16px;color:${pay?'var(--text)':'var(--kas-ink)'}">${isMultiTx?netSign:''}${pay?kas(-net):kas(net)} ${u}</span></div>
      ${depositDelta?html`<div class="sum sum-sub"><span class="sum-label"><span>${Dl.confirmDepositLocked}</span><span class="sum-hint">${depositHint}</span></span><span class="mono">-${kas(-depositDelta.amount)} ${u}</span></div>`:''}
      ${returnedDeposit>0n?html`<div class="sum sum-sub"><span class="sum-label"><span>${Dl.confirmDepositReturned}</span><span class="sum-hint">${Dl.confirmDepositReturnedHint}</span></span><span class="mono" style="color:var(--kas-ink)">+${kas(returnedDeposit)} ${u}</span></div>`:''}
      ${paidNonRefundable>0n?html`<div class="sum sum-sub"><span class="sum-label"><span>${Dl.confirmNonRefundable}</span><span class="sum-hint">${nonRefundHint}</span></span><span class="mono">-${kas(paidNonRefundable)} ${u}</span></div>`:''}
      ${showFeeRow?html`<div class="sum ${isMultiTx?'sum-sub':''}"><span class="sum-label"><span>${isMultiTx?Dl.confirmFeeSub:Dl.confirmFee}</span>${isMultiTx?html`<span class="sum-hint">${Dl.confirmFeeHint}</span>`:''}</span><span class="mono">${isMultiTx?'-':''}${kas(rv.fee)} ${u}</span></div>`:''}
    </div>
    <details class="adv-details" style="margin-top:12px"><summary class="small muted">${Dl.confirmAdvSummary}</summary>
      <div class="adv-body">
        ${rolloverOutputs.length?html`<div class="outs-group">${Dl.confirmGroupUser}</div>`:''}
        <div class="outs">${userOutputs.map(renderOut)}</div>
        ${rolloverOutputs.length?html`<div class="outs-group">${Dl.confirmGroupRollover}</div><div class="outs">${rolloverOutputs.map(renderOut)}</div>`:''}
        <dl class="kv" style="margin-top:10px">
          <dt>${Dl.confirmTxid}</dt><dd class="mono small">${rv.txid}</dd><dt>${Dl.confirmFeerate}</dt><dd>${Dl.confirmFeerateVal(String(p.feerate),String(p.fee))}</dd>
          <dt>mass</dt><dd class="small">compute ${p.mass.computeMass} · transient ${p.mass.transientMass} · storage ${p.mass.storageMass}</dd>
          <dt>${Dl.confirmInputs}</dt><dd class="small">${rv.inputs.map((i,idx)=>html`${idx?html`<span>${L.key==='zh-CN'?'；':'; '}</span>`:''}#${i.index} ${kas(i.value)} ${u} · <span>${localizeReviewInputKind(i.kind,L)}</span>`)}</dd></dl>
      </div>
    </details>
    <p class="small muted" style="margin:10px 0 0">${w?.kind==='extension'?Dl.confirmFooterExt:Dl.confirmFooterLocal}</p>`;
}
