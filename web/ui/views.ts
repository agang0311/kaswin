/** Pure views for the rolling page: data in, HTML out. No controller, node, wallet or storage access; every action is a data-* hook
 * that app.mjs binds. Interpolated values are escaped by html``; whether an action is allowed is decided elsewhere (x.gate). */
import {drawReadiness} from './draw-readiness.ts';
import {html,raw,ic} from './ui.ts';
import type {Raw} from './ui.ts';
import {ACTION_INFO,actionTitle,ROLE_LABEL,TERMINAL_LABEL,CLOSE_PRESETS,errText} from './messages.ts';
import {formatTkas,parseTkas,shortHash,daaDuration} from './format.mjs';
import {TN10_PROFILE_ID,TN10_ROLLING_REGISTRY} from '../../scripts/contract/protocol.mjs';
import {MAX_TICKETS,MAX_ACTIVE_OPEN_SHARDS,addressToSpk,managerBoundUnits,unitsToBudget} from '../app/bridge.ts';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';
import type {AssetDescriptor,Ctx,ConfirmCtx,CreateForm,Detail,DiscoveredRound,Facts,ActionState,Intent,Item,KusdtLiveState,NetInfo,Phase,Receipt,Round,ShardRecordView,ShardStatus,ShardView,VerifyState} from '../app/types.ts';

/** Protocol ceiling for one round's total tickets (state.ts MAX_TICKETS = 10,000,000); purchase count is separately capped at 256 sealed shards x 256 records = 65,536. */
export const MAX_TICKET_CAP=MAX_TICKETS;
export const MAX_SHARDS=256;
/** Largest round exercised on Testnet 10 so far (4,355 tickets / 17 sealed shards PAID; 771 tickets / 3 sealed shards REFUNDED). */
export const VERIFIED_TICKET_CAP=4355;
export const DEPOSIT_TKAS='4';
const unitOf=(x?: {net?: {unit?: string}}|null): string=>x?.net?.unit??'KAS';
const kas=(v: bigint): string=>formatTkas(v);
const signing=(w: Ctx['wallet']): boolean=>!!w&&(w.kind==='key'||w.kind==='extension');
/** Receipt fees come from stored / imported data: a malformed value shows a dash instead of aborting the render. */
const feeText=(v: unknown): string=>{try{return kas(BigInt(v as string));}catch{return '—';}};
const hash=(v: string|null|undefined,{n=10,link=null}: {n?: number;link?: string|null}={}): Raw|string=>v?html`<span class="hash"><span class="mono">${link?html`<a class="hash-link" href="${link}" target="_blank" rel="noopener noreferrer">${shortHash(v,n,6)}</a>`:shortHash(v,n,6)}</span><button class="copy" data-copy="${v}" aria-label="复制" title="复制">${ic('copy')}</button></span>`:'—';
const kpi=(label: string,value: unknown,sub: unknown='')=>html`<div class="kpi"><small>${label}</small><strong>${value}</strong>${sub?html`<span>${sub}</span>`:''}</div>`;
const fact=(k: string,v: unknown): Raw|string=>v==null||v===false?'':html`<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`;
const wait=(daa: bigint|null,until: bigint): string=>daa==null?'需读取节点 DAA':daa>=until?'现在可操作':`约 ${daaDuration(until-daa)} 后`;
const isFree=(a: string): boolean=>!!ACTION_INFO[a]?.free;

/* ------------------------------------------------------------------ explore */
const STEP_TERMINAL: Record<string,string>={PAID:'已派奖',EMPTY:'无人购买 · 已退押金',REFUNDED:'已全部退款'};
function stepText(i: Item,x: Ctx): string {
  const {r,f}=i;
  if(r.terminal)return STEP_TERMINAL[r.terminal]??'已结束';
  if(r.halted)return '交易未确认，请重新核对';
  if(r.intent||(r.pending??[]).length)return '交易确认中…';
  if(!r.manager){
    if(r.kusdt&&f.module==='win')return '派奖中 · 等待领取分片奖金';
    if(r.kusdt&&f.module==='refund')return '退款中 · 等待领取分片退款';
    return '等待创建确认…';
  }
  const manager=r.manager;
  if(f.module==='sales')return x.daa!=null&&x.daa<f.closeEligibleDaa&&f.tickets<f.ticketCap?`售票中 · ${wait(x.daa,f.closeEligibleDaa)}可封盘`:'已满条件 · 可立即封盘';
  if(f.module==='sealed')return `已封存 · ${wait(x.daa,manager.utxoDaa+100n)}可开奖`;
  if(f.module==='win')return `派奖中 · 分片 ${f.payCursor}/${f.shards}`;
  return `退款中 · 分片 ${f.refundShard}/${f.shards}`;
}
const CARD_CTA: Record<string,string>={open:'立即参与',sealed:'去开奖',paying:'查看派奖',refund:'查看退款'};
const safeBig=(v: string|null|undefined): bigint=>{try{return v!=null?BigInt(v):0n;}catch{return 0n;}};
const INDEXED_TERM_PHASE: Record<string,Phase>={PAID:{key:'paid',label:'已派奖',tone:'gold'},EMPTY:{key:'empty',label:'空轮结束',tone:'muted'},REFUNDED:{key:'refunded',label:'退款完成',tone:'muted'}};
const INDEXED_MOD_PHASE: Record<string,Phase>={sales:{key:'open',label:'售票中',tone:'mint'},sealed:{key:'sealed',label:'待开奖',tone:'violet'},win:{key:'paying',label:'派奖中',tone:'gold'},refund:{key:'refund',label:'退款中',tone:'amber'}};
const INDEXED_UNI_PHASE: Record<string,Phase>={OPEN:{key:'open',label:'售票中',tone:'mint'},CLOSING:{key:'open',label:'封盘汇总',tone:'mint'},SEALED:{key:'sealed',label:'待开奖',tone:'violet'},SETTLING:{key:'paying',label:'派奖中',tone:'gold'},REFUNDING:{key:'refund',label:'退款中',tone:'amber'},DONE:{key:'done',label:'已结束',tone:'muted'}};
function indexedPhase(d: DiscoveredRound): Phase {
  if(d.terminal)return INDEXED_TERM_PHASE[d.terminal]??{key:'done',label:TERMINAL_LABEL[d.terminal]??String(d.terminal),tone:'muted'};
  if(d.module&&INDEXED_MOD_PHASE[d.module])return INDEXED_MOD_PHASE[d.module];
  if(d.phase==='CLOSING'){
    const cursor=Number((d.protocolData as Record<string,unknown>|undefined)?.cursor??d.settlementProgress?.done??0);
    if(cursor<=0)return INDEXED_UNI_PHASE.OPEN!;
  }
  if(typeof d.phase==='string'&&INDEXED_UNI_PHASE[d.phase])return INDEXED_UNI_PHASE[d.phase];
  return {key:'open',label:'进行中',tone:'mint'};
}
function indexedStep(d: DiscoveredRound,ph: Phase): string {
  if(d.terminal)return STEP_TERMINAL[d.terminal]??'已结束';
  if(ph.key==='open')return '售票中 · 点击查看票价与进度';
  if(ph.key==='sealed')return '待开奖 · 点击查看开奖倒计时';
  if(ph.key==='paying')return '派奖中 · 点击查看分片进度';
  if(ph.key==='refund')return '退款中 · 点击查看退款进度';
  return '点击查看最新状态';
}
function isDiscFresher(i: Item,d: DiscoveredRound|undefined): d is DiscoveredRound {
  if(!d||i.r.terminal||i.r.intent||i.r.halted)return false;
  if(d.terminal)return true;
  const dt=d.ticketsSold??d.tickets;
  if(dt!=null&&i.f.tickets!=null&&dt>i.f.tickets)return true;
  if(d.buys!=null&&d.buys>i.r.receipts.filter(t=>t.action==='BUY'||t.action==='OPEN_SHARD').length)return true;
  return !!(d.module&&i.f.module&&d.module!==i.f.module&&!(i.f.module==='sealed'&&d.module==='sales'));
}
function card(i: Item,x: Ctx,freshDisc?: DiscoveredRound): Raw {
  const {r,f}=i,ph=freshDisc?indexedPhase(freshDisc):i.ph,price=f.ticketPrice;
  const isKusdt=!!r.kusdt||freshDisc?.protocolId==='kusdt-v2'||freshDisc?.asset?.kind==='KCC20';
  const asset: AssetDescriptor|undefined=isKusdt?(freshDisc?.asset??{kind:'KCC20',symbol:'kUSDT',decimals:6,tokenCovenantId:null}):undefined;
  const tickets=freshDisc?(freshDisc.terminal?(freshDisc.bought??freshDisc.ticketsSold??freshDisc.tickets??f.tickets):(freshDisc.ticketsSold??freshDisc.tickets??f.tickets)):f.tickets;
  const shards=freshDisc?(freshDisc.shards||(freshDisc.terminal&&(freshDisc.buys??0)>=256?Math.floor((freshDisc.buys??0)/256):f.shards)):f.shards;
  const isTerminal=!!(r.terminal||freshDisc?.terminal);
  const have=tickets!=null,pct=have&&f.ticketCap?Math.min(100,tickets/f.ticketCap*100):isTerminal?100:0;
  const cta=CARD_CTA[ph.key]??'查看详情',u=isKusdt?(asset?.symbol??'kUSDT'):unitOf(x);
  return html`<article class="card t-${ph.tone}" data-open="${r.cid}" tabindex="0" role="button" aria-label="打开轮次 ${shortHash(r.cid)}">
    <div class="row"><span class="badge t-${ph.tone}">${ph.label}</span>${isKusdt?html`<span class="badge">${u}</span>`:''}<span class="mono dim small">#${shortHash(r.cid,6,4)}</span></div>
    <div class="big">${have?fmtAmt(BigInt(tickets)*price,asset):'—'}<small>${u}</small></div>
    ${have?html`<div class="bar"><i style="width:${pct}%"></i></div><div class="row small muted"><span>${tickets.toLocaleString()} / ${f.ticketCap.toLocaleString()} 张 · ${fmtAmt(price,asset)} ${u}/张</span><span>${shards>0?`${shards} 片`:''}</span></div>`:html`<div class="small muted">打开查看详情</div>`}
    <div class="row card-foot"><span class="card-next">${freshDisc?indexedStep(freshDisc,ph):stepText(i,x)}</span><span class="card-cta">${cta} ${ic('arrow')}</span></div>
  </article>`;
}
function formatKcc20(amount: bigint, decimals = 6): string {
  const neg = amount < 0n, abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base, frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}
function indexedCard(d: DiscoveredRound,x?: Ctx): Raw {
  const isKusdt = d.protocolId === 'kusdt-v2' || d.asset?.kind === 'KCC20';
  const ph=indexedPhase(d),tkt=d.terminal?(d.bought??d.ticketsSold??d.tickets??0):(d.ticketsSold??d.tickets??0),isRest=d.source==='rest',u=isKusdt?(d.asset?.symbol??'kUSDT'):unitOf(x);
  const sc=d.shards||(d.terminal&&(d.buys??0)>=256?Math.floor((d.buys??0)/256):0);
  const mval=!d.terminal?safeBig(d.managerValue):0n,cta=CARD_CTA[ph.key]??'查看详情';
  const kusdtPool = isKusdt && d.ticketPrice ? BigInt(tkt) * safeBig(d.ticketPrice) : 0n;
  const subParts=[`${tkt.toLocaleString()} 张`];
  if(sc>0)subParts.push(`${sc} 片`);
  if(d.buys!=null&&d.buys!==tkt)subParts.push(`${d.buys.toLocaleString()} 笔`);
  return html`<article class="card t-${ph.tone}" data-indexed="${d.cid}" tabindex="0" role="button" aria-label="打开轮次 ${shortHash(d.cid)}">
    <div class="row"><span class="badge t-${ph.tone}">${ph.label}</span>${isKusdt?html`<span class="badge">${u}</span>`:''}<span class="mono dim small">#${shortHash(d.cid,6,4)}</span></div>
    <div class="big">${isKusdt?(kusdtPool>0n?html`${formatKcc20(kusdtPool,d.asset?.decimals??6)}<small>${u}</small>`:html`${tkt.toLocaleString()}<small>张</small>`):(mval>0n?html`${kas(mval)}<small>${u}</small>`:html`${tkt.toLocaleString()}<small>张</small>`)}</div>
    ${d.terminal?html`<div class="bar"><i style="width:100%"></i></div>`:''}
    <div class="row small muted"><span>${subParts.join(' · ')}</span><span>${d.terminal?'已结算':''}</span></div>
    <div class="row card-foot"><span class="card-next">${isRest?'点击同步最新进度':indexedStep(d,ph)}</span><span class="card-cta">${cta} ${ic('arrow')}</span></div>
  </article>`;
}
interface ExploreEntry {cid: string;ph: Phase;value: bigint;at: number;item?: Item;disc?: DiscoveredRound}
export function exploreView(x: Ctx): Raw {
  const all=x.items,disc=x.discovered??[],q=x.S.query.trim().toLowerCase();
  const discByCid=new Map(disc.map(d=>[d.cid,d])),localCids=new Set(all.map(i=>i.r.cid));
  const allEntries: ExploreEntry[]=[
    ...all.map(i=>{
      const d=discByCid.get(i.r.cid),fresh=isDiscFresher(i,d)?d:undefined,isKusdt=!!i.r.kusdt||fresh?.protocolId==='kusdt-v2';
      const value=fresh
        ?(fresh.terminal?0n:!isKusdt&&(fresh.module==='sales'||fresh.module==='sealed')&&fresh.tickets!=null?BigInt(fresh.tickets)*i.f.ticketPrice+400_000_000n:(safeBig(fresh.managerValue)>i.value?safeBig(fresh.managerValue):i.value))
        :i.value;
      return {cid:i.r.cid,ph:fresh?indexedPhase(fresh):i.ph,value,at:Math.max(i.at,d?.updatedAt??0),item:i,disc:fresh};
    }),
    ...disc.filter(d=>!localCids.has(d.cid)).map(d=>{const ph=indexedPhase(d);return {cid:d.cid,ph,value:d.terminal?0n:safeBig(d.managerValue),at:d.updatedAt??0,disc:d};}),
  ];
  const isIncompatibleProfile=(pid: string|null|undefined)=>!!(pid&&x.supportedProfiles&&!x.supportedProfiles.has(pid));
  const isOther=(e: ExploreEntry)=>isIncompatibleProfile(e.disc?.profileId)||isIncompatibleProfile(e.item?.r.profileId)
    ||(e.item?(!e.item.f.module&&!e.item.r.terminal&&!e.item.r.intent):(e.disc?.protocolId!=='kusdt-v2'&&!!e.disc?.module&&!['sales','sealed','win','refund'].includes(String(e.disc.module))));
  const entries=allEntries.filter(e=>!isOther(e)),otherEntries=allEntries.filter(isOther);
  const is=(e: ExploreEntry,...k: string[])=>k.includes(e.ph.key);
  const saved=x.saved??new Set<string>();
  const g: Record<string,number>={all:entries.length,open:entries.filter(e=>is(e,'open')).length,sealed:entries.filter(e=>is(e,'sealed')).length,
    settle:entries.filter(e=>is(e,'paying','refund')).length,done:entries.filter(e=>is(e,'paid','empty','refunded','done')).length,
    saved:entries.filter(e=>saved.has(e.cid)).length};
  const paid=entries.filter(e=>is(e,'paid')).length;
  const locked=entries.reduce((n: bigint,e)=>n+e.value,0n);
  const phaseRank=(e: ExploreEntry): number=>{
    if(is(e,'paid','empty','refunded','done'))return 3;
    if(saved.has(e.cid))return 0;
    return is(e,'open')?1:2;
  };
  const list=entries.filter(e=>{
    const f=x.S.filter;if(f==='open'&&!is(e,'open'))return false;if(f==='sealed'&&!is(e,'sealed'))return false;
    if(f==='settle'&&!is(e,'paying','refund'))return false;if(f==='done'&&!is(e,'paid','empty','refunded','done'))return false;
    if(f==='saved'&&!saved.has(e.cid))return false;
    return !q||e.cid.includes(q);
  }).sort((a,b)=>{
    const r=phaseRank(a)-phaseRank(b);
    if(r!==0)return r;
    return x.S.sort==='value'?(b.value>a.value?1:b.value<a.value?-1:b.at-a.at):b.at-a.at;
  });
  const filteredOther=otherEntries.filter(e=>!q||e.cid.includes(q));
  const seg: [string,string][]=[['saved','★ 关注'],['open','售票中'],['sealed','待开奖'],['settle','派奖/退款'],['done','已结束'],['all','全部']];
const missingProfilesOf=(x: Ctx)=>{
  const reported=Array.isArray(x.conn.indexerProfiles)&&x.conn.indexerProfiles.length?new Set(x.conn.indexerProfiles.map(p=>p.profileId)):null;
  if(!reported||!x.compatibleProfiles?.length)return null;
  const required=x.compatibleProfiles.filter(p=>x.net.key==='mainnet'||p.protocolId!=='kusdt-v2');
  return required.filter(p=>!reported.has(p.profileId));
};
const isRest=x.conn.discoveredSource==='rest',isCache=x.conn.discoveredSource==='cache';
  const missingProfiles=x.conn.indexer&&!x.conn.indexerStale?missingProfilesOf(x):null;
  const sourceNotice=isCache&&x.conn.indexerStale
    ?html`<div class="source-strip"><span class="dot"></span><span>索引暂不可用，当前显示本地缓存列表（${disc.length} 轮）</span></div>`
    :isRest
    ?html`<div class="source-strip"><span class="dot"></span><span>${x.conn.indexerStale?'索引暂不可用，已切换为 REST API 备用查询':'使用 REST API 备用查询'}（${disc.length} 轮）</span></div>`
    :x.conn.indexerStale
      ?html`<div class="notice warn">索引正在追赶最新链状态，点击任意轮次会向节点核对。</div>`
      :missingProfiles&&missingProfiles.length
        ?html`<div class="notice warn">当前索引未覆盖本页的 ${missingProfiles.map(p=>`${p.asset} (${shortHash(p.profileId,6,4)})`).join('、')} 合约 Profile，相关新轮次可能无法自动发现；请在「高级设置」切换或升级索引。</div>`
        :'';
  const u=unitOf(x);
  const sourceLabel=isCache?`本地缓存 ${disc.length}`:isRest?`REST 备用 ${disc.length}`:x.conn.indexer?`索引 ${disc.length}`:'';
  return html`
  <div class="section-title plaza-head">
    <div>
      <h2>轮次广场</h2>
      <div class="plaza-meta small muted">
        <span>共 <b>${entries.length}</b> 轮</span>
        <span>售票中 <b>${g.open}</b></span>
        <span>待开奖/结算 <b>${g.sealed+g.settle}</b></span>
        <span>锁定 <b>${kas(locked)} ${u}</b></span>
        ${sourceLabel?html`<span class="dim">${sourceLabel}</span>`:''}
      </div>
    </div>
    <div class="hero-actions"><button class="btn pri sm" data-go2="create">${ic('create')}发起抽奖</button><button class="btn ghost sm" data-go2="protocol">${ic('shield')}规则</button></div>
  </div>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="筛选">${seg.map(([k,l])=>html`<button data-filter="${k}" aria-pressed="${x.S.filter===k}">${l}<span class="c">${g[k]}</span></button>`)}</div>
    <label class="search search-sm">${ic('search')}<input id="q" placeholder="搜索轮次编号" value="${x.S.query}" autocomplete="off" spellcheck="false"></label>
    <div class="seg"><button data-sort="new" aria-pressed="${x.S.sort==='new'}">最新</button><button data-sort="value" aria-pressed="${x.S.sort==='value'}">奖池</button></div>
    ${x.conn.indexer||isRest||isCache||x.conn.node?html`<button class="icon-btn" data-act="refreshIndex" aria-label="刷新列表" title="刷新轮次列表">${ic('refresh')}</button>`:''}
    ${x.indexerMore?html`<button class="btn sm" data-act="moreIndex">加载更多</button>`:''}
  </div>
  ${sourceNotice}
  <div class="grid">${list.length?list.map(e=>e.item?card(e.item,x,e.disc):indexedCard(e.disc!,x)):html`<div class="empty">${ic('ticket')}<p>${entries.length?html`当前筛选下没有轮次。${x.S.filter!=='all'?html`<button class="link" data-filter="all">查看全部轮次 (${entries.length})</button> 或 `:''}`:'还没有轮次。'}你可以<button class="link" data-go2="create">发起一个新轮次</button>，或在下方通过分享链接加入。</p></div>`}</div>
  <details class="join-details"${x.S.join||!entries.length?' open':''}>
    <summary class="small muted">${ic('download')} <span>有分享链接或轮次编号？点此加入</span></summary>
    <div class="joinrow" style="margin-top:10px"><input id="joinText" value="${x.S.join}" placeholder="粘贴分享链接、轮次编号或交易 ID" autocomplete="off" spellcheck="false" aria-label="分享链接或轮次 ID"><button class="btn pri" data-act="join">加入</button></div>
  </details>
  ${otherEntries.length?html`<details class="other-rounds-details">
    <summary class="small dim" title="查看属于旧版或当前版本不兼容合约 Profile 的轮次">${ic('archive')}<span>不兼容轮次 (${otherEntries.length})</span></summary>
    <div class="panel" style="margin-top:10px;background:var(--panel2);border:1px dashed var(--line2)">
      <div class="grid">${filteredOther.map(e=>e.item?card(e.item,x):indexedCard(e.disc!,x))}</div>
    </div>
  </details>`:''}`;
}

/* ------------------------------------------------------------------ create */
export interface CreateParse {ok: boolean;errors: string[];price: bigint|null;cap: number;min: number;mins: number;registry: boolean|string;registryAddr: string;isCustomRegistry: boolean}
export function parseCreate(form: CreateForm,net?: Pick<NetInfo,'addressPrefix'|'unit'|'label'|'registry'>): CreateParse {
  const isKusdt=form.protocol==='kusdt-v2';
  const defaultReg=net?.registry?.address??TN10_ROLLING_REGISTRY.address;
  const addrPrefix=net?.addressPrefix??'kaspatest';
  const unit=isKusdt?'kUSDT':(net?.unit??'TKAS');
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
    const price=intPrice?(isKusdt?BigInt(rawPrice)*1_000_000n:parseTkas(rawPrice)):null;
    const cap=isKusdt?65536:(/^[0-9]{1,8}$/.test(form.cap)?Number(form.cap):NaN);
    const min=isKusdt?3:(/^[0-9]{1,8}$/.test(form.min)?Number(form.min):NaN);
    const mins=form.dur==='custom'?(/^[0-9]{1,5}$/.test(form.custom)?Number(form.custom):NaN):Number(form.dur);
    const errors: string[]=[];
    if(isKusdt&&addrPrefix==='kaspatest')errors.push('TN10 测试网不包含主网 kUSDT 代币，请切换到 Rolling v1（TKAS）创建测试轮次。');
    if(price==null)errors.push(`票价需为正整数 ${unit}（不含小数）`);
    else if(isKusdt?price<1_000_000n:price<100000000n)errors.push(`票价至少 1 ${unit}`);
    else if(isKusdt&&price>500_000_000_000_000_000n)errors.push(`票价不能超过 500,000,000,000 ${unit}`);
    if(!isKusdt&&!(cap>=3&&cap<=MAX_TICKET_CAP))errors.push(`票数上限需在 3 – ${MAX_TICKET_CAP.toLocaleString()} 之间`);
    if(!isKusdt&&!(min>=3&&min<=cap))errors.push('最低票数需 ≥ 3 且不超过票数上限');
    if(!(mins>=1&&mins<=10080))errors.push('封盘等待时间需在 1 分钟 – 7 天之间');
    if(useReg&&!regValid)errors.push(`登记地址无效：需要是 ${label}（${addrPrefix}:）的 Schnorr P2PK 或 P2SH 地址`);
    return {ok:!errors.length,errors,price,cap,min,mins,registry,registryAddr:regAddr,isCustomRegistry};
  } catch {return {ok:false,errors:[`票价需为正整数 ${unit}（不含小数）`],price:null,cap:NaN,min:NaN,mins:NaN,registry:false,registryAddr:regAddr,isCustomRegistry};}
}
/** The button says what will really happen: only a private-key wallet can create (deposit + network fee); a receive-only address cannot. */
function createCta(x: Ctx,formOk: boolean): Raw {
  const w=x.wallet;
  if(signing(w))return x.busy
    ?html`<p class="small muted" role="status">正在处理上一步，请稍候。</p><button class="btn pri" disabled aria-busy="true">处理中…</button>`
    :html`<button class="btn pri" data-act="create" ${formOk?'':'disabled'}>${ic('arrow')}核对并报价</button>`;
  if(w)return html`<div class="notice warn" style="margin-top:12px">当前连接的是「仅收款地址」，它不能签名，创建轮次需要能签名的钱包支付押金和网络费。</div><button class="btn pri" data-fix="wallet">${ic('wallet')}连接签名钱包</button>`;
  return html`<button class="btn pri" data-fix="wallet">${ic('wallet')}连接钱包后创建</button>`;
}
export function createView(x: Ctx): Raw {
  const f=x.S.form,isKusdt=f.protocol==='kusdt-v2',p=parseCreate(f,x.net);
  const good=isKusdt?(p.price!=null&&p.price>=1_000_000n):(p.price!=null&&p.price>=100000000n&&p.cap>=3&&p.cap<=MAX_TICKET_CAP);
  const shards=good?(isKusdt?256:Math.min(MAX_SHARDS,Math.ceil(p.cap/256))):0;
  const pool=p.price!=null&&good?BigInt(p.cap)*p.price:null,dur=p.mins>=1?daaDuration(BigInt(p.mins)*600n):'—';
  const u=unitOf(x),ticketU=isKusdt?'kUSDT':u,defaultReg=x.net.registry.address;
  const useReg=f.registry!==false,regVal=f.registryAddr!==undefined?f.registryAddr:defaultReg;
  return html`
  <div class="cols">
    <div class="panel">
      <h2>${ic('create')} 发起一轮抽奖</h2>
      <p class="sub">${isKusdt?'kUSDT v2（256 并行分片 · 0 抽成 · 12 小时重掷保护）':'设置票价、总票数与最早封盘时间（创建后上链不可更改）。'}</p>
      <div class="field full" style="margin-bottom:12px">协议版本
        <div class="pills">
          <button type="button" data-proto="kusdt-v2" aria-pressed="${isKusdt}">kUSDT v2（256 并行分片 · kUSDT）</button>
          <button type="button" data-proto="rolling-v1" aria-pressed="${!isKusdt}">Rolling v1（${u}）</button>
        </div>
      </div>
      <div class="form">
        <label class="field">每张票价格（${ticketU}）<input id="cPrice" value="${f.price}" inputmode="numeric" maxlength="12"><small>≥ 1 ${ticketU} 的整数</small></label>
        ${isKusdt?html`
          <div class="field">分片容量<div class="small muted" style="padding:8px 0">最多 256 片 × 256 条记录（按实际到点封盘）</div></div>
          <div class="field">开奖门槛<div class="small muted" style="padding:8px 0">≥ 3 张开奖；1–2 张自助退款</div></div>
        `:html`
          <label class="field">总票数上限<input id="cCap" value="${f.cap}" inputmode="numeric" maxlength="8"><small>3 – ${MAX_TICKET_CAP.toLocaleString()}</small></label>
          <label class="field">开奖最低票数<input id="cMin" value="${f.min}" inputmode="numeric" maxlength="8"><small>≥ 3；不足则全部退款</small></label>
        `}
        <div class="field full">最早可封盘时间<div class="pills">${CLOSE_PRESETS.map(([k,l])=>html`<button type="button" data-dur="${k}" aria-pressed="${f.dur===k}">${l}</button>`)}</div>
          ${f.dur==='custom'?html`<input id="cCustom" value="${f.custom}" inputmode="numeric" maxlength="5" placeholder="分钟（1 – 10080）">`:''}
          <small>${isKusdt?'仅按到期 DAA 触发封盘与批处理汇总。':'到时或售满后任何人均可封盘开奖。'}</small></div>
        <details class="adv-details full"${!useReg||p.isCustomRegistry?' open':''}>
          <summary class="small muted">高级设置（公共索引登记，默认开启）</summary>
          <div class="adv-body">
            <label class="check"><input type="checkbox" id="cReg" ${useReg?'checked':''}>附加 0.2 ${u} Registry 登记输出（供广场自动发现本轮）</label>
            <label class="field" id="cRegBox" ${useReg?'':'hidden'}>登记地址<input id="cRegAddr" value="${regVal}" spellcheck="false" autocomplete="off" placeholder="${defaultReg}">
              <small>留空使用默认登记地址（0.2 ${u}，不可撤回）。</small>
              ${p.isCustomRegistry?html`<small class="why">已改为非默认地址：默认索引不会自动收录本轮。</small>`:''}</label>
          </div>
        </details>
      </div>
      ${p.ok?'':html`<p class="err">${p.errors[0]}</p>`}
      <div style="margin-top:14px">${createCta(x,p.ok)}</div>
    </div>
    <div>
      <div class="panel"><h3>预览</h3><div class="facts">
        ${fact('计价资产',isKusdt?'kUSDT (KCC-20)':u)}
        ${fact(isKusdt?'单轮容量':'售满票款',isKusdt?'256 并行分片':(pool==null?'—':`${kas(pool)} ${u}`))}
        ${fact('最早封盘',`约 ${dur} 后`)}
        ${fact('封存分片',good?(isKusdt?'最多 256 个':'最多约 '+shards+' 个'):'—')}
        ${fact(`低于 ${Number.isFinite(p.min)?p.min:'最低'} 张`,isKusdt?'小额自助退款（Pull）':`全部退款（每笔扣 0.02 ${u}）`)}
      </div></div>
      <div class="panel"><h3>你需要付出</h3><dl class="kv">
        <dt>押金</dt><dd>${DEPOSIT_TKAS} ${u}（结算后退回创建者）</dd>
        <dt>登记输出</dt><dd>${useReg?`0.2 ${u}（供广场自动发现本轮）`:`不附加（不进入公共索引，仅可通过 CID 加入）`}</dd>
        ${isKusdt?html`<dt>协议抽成</dt><dd>0%（100% 奖池归赢家；第三方代推派奖每片 0.5 kUSDT 激励）</dd>`:''}
        <dt>建议余额</dt><dd>约 ${useReg?'4.5':'4.3'} ${u}${signing(x.wallet)&&x.balance!=null?html` <span class="muted">（余额 ${kas(x.balance)} ${u}）</span>`:''}</dd>
      </dl></div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ round detail */
const STEPS_NORMAL=['售票','待开奖','派奖','完成'],STEPS_REFUND=['售票','封盘','退款','完成'];
function stepper(D: Detail): Raw {
  const {r,f}=D,refund=f.module==='refund'||r.terminal==='REFUNDED',labels=refund?STEPS_REFUND:STEPS_NORMAL;
  const pos=r.terminal?4:f.module==='sealed'?1:f.module==='win'||f.module==='refund'?2:0;
  return html`<div class="stepper">${labels.map((l,i)=>html`<div class="step ${i<pos?'done':i===pos?'now':''} ${refund&&i>=2?'alt':''}"><div class="b">${i<pos?'✓':i+1}</div>${l}</div>`)}</div>`;
}
const HINT_TERMINAL: Record<string,string>={PAID:'奖金已派发，押金已退回创建者。',EMPTY:'无人购买，押金已退回创建者。',REFUNDED:'全部购买记录已退款。'};
const HINT_MODULE: Record<string,string>={sales:'售票中 · 到时或售满后可封盘。',sealed:'已封盘 · 等待链上随机数开奖。',
  win:'已开奖 · 可免签推进分片派奖。',refund:'票数不足 · 可免签推进分批退款。'};
const HINT_MODULE_KUSDT: Record<string,string>={sales:'售票中 · 到时后可封盘汇总。',sealed:'已封盘 · 等待链上随机数开奖。',
  win:'已开奖 · 先下发派奖许可，再在分片派发 kUSDT 奖金与退还押金。',refund:'票数不足 · 先下发退款许可（退回创建者 4 KAS 押金），再在分片自助领回 kUSDT 与分片押金。'};
function nextHint(D: Detail): string {
  const {r,f}=D;
  if(r.terminal)return HINT_TERMINAL[r.terminal]??'';
  if(r.halted)return `这一轮已停止（${r.halted}）：有交易未确认，请重新核对或导入。`;
  if(r.intent)return '有交易等待确认中，期间不能发起新操作。';
  return (D.asset?.kind==='KCC20'?HINT_MODULE_KUSDT[f.module??'']:null)??HINT_MODULE[f.module??'']??'';
}
const fmtAmt=(v: bigint,a?: AssetDescriptor)=>a?.kind==='KCC20'?formatKcc20(v,a.decimals):kas(v);
const KUSDT_ACTION_COPY: Record<string,{title:string;verb:string;desc:(u: string)=>string}>={
  CLOSE:{title:'封盘汇总',verb:'封盘汇总',desc:u=>`按批冻结最多 8 个分片；满 3 张进开奖，不足 3 张转退款，0 票直接退回 4 ${u} 押金。`},
  TIMEOUT:{title:'超时重掷',verb:'超时重掷',desc:()=>'封盘逾约 12 小时未开奖时重置开奖等待窗口。'},
  PAY_OLD:{title:'下发派奖许可',verb:'下发派奖许可',desc:u=>`批量将最多 8 个已封存分片转为待派奖状态；最后一批同时退回创建者 4 ${u} 押金（完成后在分片派发 kUSDT 奖金）。`},
  REFUND_OLD:{title:'下发退款许可',verb:'下发退款许可',desc:u=>`批量将最多 8 个已封存分片转为可自助退款状态；最后一批同时退回创建者 4 ${u} 押金（完成后点击「自助退款」领回 kUSDT 与 4 ${u} 分片押金）。`},
};
function actionCard(a: string,D: Detail,x: Ctx): Raw|'' {
  const {f}=D,s: ActionState=D.a[a]??{ok:false,reason:'不可用'},baseInfo=ACTION_INFO[a];
  if(!baseInfo)return '';
  const g=x.gate(a),isKusdt=D.asset?.kind==='KCC20',tu=isKusdt?D.asset!.symbol:unitOf(x);
  const ku=KUSDT_ACTION_COPY[a];
  const info=isKusdt&&ku?{...baseInfo,title:ku.title,verb:ku.verb,desc:ku.desc(unitOf(x)),free:false}:baseInfo;
  if(!s.ok&&/不适用|没有旧分片|不满足/.test(s.reason??''))return '';
  const draw=a==='DRAW'?drawReadiness(D,x):null;
  const waiting=!s.ok||!!draw&&!draw.ready,quantityError=a==='BUY'?qtyError(x.S.qty,f,s):null;
  const openShards=isKusdt?(D.kusdt?.shards??[]).filter(sh=>!sh.terminal&&sh.stage===0x11&&sh.recordCount<256):[];
  const canOpenNewShard=isKusdt&&openShards.length<MAX_ACTIVE_OPEN_SHARDS&&f.shards<MAX_SHARDS;
  const extra=a==='BUY'?html`<div class="qtyrow"><label class="field">购买数量<input id="qty" value="${x.S.qty}" inputmode="numeric" maxlength="8" aria-describedby="qtyCost" aria-invalid="${quantityError?'true':'false'}"></label>
    <div class="pills">${[1,5,10].map(n=>html`<button type="button" data-qty="${n}" aria-pressed="${x.S.qty===String(n)}">${n} 张</button>`)}</div></div>
    ${openShards.length?html`<label class="field" style="margin-top:8px">分片选择<select id="kShardCid">${openShards.map(sh=>html`<option value="${sh.shardCid}">已有分片 #${shortHash(sh.shardCid,6,4)}（${sh.tickets} 张 · ${sh.recordCount}/256 笔 · 免押金）</option>`)}${canOpenNewShard?html`<option value="">开新片（含 4 ${unitOf(x)} 可退押金 · 活动分片 ${openShards.length}/${MAX_ACTIVE_OPEN_SHARDS}）</option>`:''}</select></label>`:''}
    ${isKusdt&&openShards.length>=MAX_ACTIVE_OPEN_SHARDS?html`<p class="small muted" style="margin:4px 0 0">当前已有 ${openShards.length}/${MAX_ACTIVE_OPEN_SHARDS} 个可买活动分片，满 256 笔后自动释放新分片名额。</p>`:''}
    <p class="small ${quantityError?'err':'muted'}" id="qtyCost" role="status" aria-live="polite">${qtyCost(x.S.qty,f,s,tu,D.asset)}</p>`:'';
  const label=x.busy?'处理中…':draw&&!draw.ready?draw.button:waiting?'暂不可用':g.ok?(draw?draw.button:a==='BUY'?(isKusdt&&!openShards.length?`立即购买（含 4 ${unitOf(x)} 可退押金）`:'立即购买'):info.verb):g.fix==='wallet'?(a==='BUY'?'连接钱包并购买':'连接钱包'):g.fix==='settings'?'检查连接':'暂不可用';
  const attr=x.busy?'disabled aria-busy="true"':waiting?'disabled':g.ok?`data-act="${a}"`:g.fix?`data-fix="${g.fix}"`:'disabled';
  const primary=(g.ok||g.fix==='wallet')&&!waiting;
  return html`<div class="act ${a==='BUY'?'act-hero':''} ${waiting||x.busy?'off':''}"><h4>${info.title}${!isKusdt&&isFree(a)?html`<span class="tag kas">免签领奖</span>`:''}</h4>${a==='BUY'?'':html`<p>${info.desc.replace(/\bTKAS\b/g,unitOf(x))}</p>`}${extra}
    ${x.busy?html`<div class="why" role="status">${g.reason??'正在处理上一步，请稍候。'}</div>`:waiting?html`<div class="why">${draw&&!draw.ready?draw.label:s.reason}</div>`:g.ok||g.fix==='wallet'?'':html`<div class="why">${g.reason}</div>`}
    <button ${raw(a==='BUY'?'id="buySubmit"':'')} class="btn ${primary?'pri':''} block" ${raw(attr)} ${raw(quantityError&&!x.busy&&!waiting&&(g.ok||g.fix)?'disabled':'')}>${label}</button>${!isKusdt&&a==='PAY_OLD'&&s.ok&&g.ok&&!x.busy&&D.r.frozen.length>0?html`<button type="button" class="btn block" style="margin-top:8px" data-act="batchPayout">一键连续派奖（剩 ${D.r.frozen.length} 片）</button>`:!isKusdt&&a==='REFUND_OLD'&&s.ok&&g.ok&&!x.busy&&D.r.frozen.length>0?html`<button type="button" class="btn block" style="margin-top:8px" data-act="batchRefund">一键连续退款（剩 ${D.r.frozen.length} 片）</button>`:!isKusdt&&a==='REFUND_SELF'&&s.ok&&g.ok&&!x.busy&&D.r.frozen.length===0&&f.localRecords>32?html`<button type="button" class="btn block" style="margin-top:8px" data-act="batchRefund">一键连续退款</button>`:''}</div>`;
}
export function qtyError(text: string,f: Facts,s?: ActionState): string|null {
  const q=String(text).trim();
  if(!/^[1-9][0-9]{0,7}$/.test(q))return '请输入要购买的张数';
  const max=Math.max(0,Math.min(s?.maxQuantity??Infinity,f.ticketCap-f.tickets));
  return Number(q)>max?`最多还能买 ${max} 张`:null;
}
export function qtyCost(text: string,f: Facts,s?: ActionState,unit='KAS',asset?: AssetDescriptor): string {
  try {
    const error=qtyError(text,f,s);if(error)return error;
    const n=Number(text);
    return `${n} 张 × ${fmtAmt(f.ticketPrice,asset)} = ${fmtAmt(BigInt(n)*f.ticketPrice,asset)} ${unit}，另付网络费（确认前报价）`;
  } catch {return '';}
}
/** Why the node refused, in terms of what the user can do. The kind comes from the node's own message (conflict.mjs); unknown wording gets the generic text. */
function rejectionHelp(i: Intent,x: Ctx): Raw {
  const k=classifyRejection(i),by=k.spender?html` ${hash(k.spender,{n:8,link:x.ex.tx(k.spender)})}`:'';
  if(k.kind==='FUNDS_INPUT')return html`。你钱包里的一笔资金已被另一笔还没确认的交易${by}占用（常见于同一个钱包在别的页面、标签页或脚本里同时操作）。节点没有收下这笔，不会扣款。请放弃这笔，等那笔确认后再重新操作；页面现在会自动避开被占用的资金。`;
  if(k.kind==='ROUND_INPUT')return html`。这一轮的合约输出已被另一笔还没确认的交易${by}占用，说明别人抢先操作了同一轮。节点没有收下这笔，不会扣款。请放弃这笔，再用「加入轮次」导入对方发来的最新分享链接。`;
  if(k.kind==='ORPHAN')return html`。节点找不到这笔交易所依赖的上一笔交易（可能还没传到这个节点）。节点没有收下这笔，不会扣款。请放弃这笔，等几秒后重新操作。`;
  return html`。常见原因是别人抢先操作了同一轮，你的本机记录已过期。请放弃这笔，再用「加入轮次」导入对方发来的最新分享链接。`;
}
function intentPanel(r: Round,x: Ctx): Raw|'' {
  const i=r.intent;if(!i)return '';
  const rejected=i.status==='REJECTED',canDiscard=['REJECTED','UNSENT','SUBMITTED','UNKNOWN','PREPARED'].includes(i.status),busy=x.busy,canRecover=r.source!=='kusdt';
  return html`<div class="notice ${rejected?'bad':'warn'}"><b>${rejected?'这笔交易被节点拒绝':'有一笔交易正在等待确认'}</b>：${actionTitle(i.action)}
    ${rejected?rejectionHelp(i,x):html`。页面会自动查询结果；你也可以手动刷新。<b>不要重复发起同样的操作</b>${canRecover?'，需要重发时只会使用原来的签名':''}。`}
    ${i.txid?html`<div class="small muted" style="margin-top:6px">交易 ID：${hash(i.txid,{n:14,link:x.ex.tx(i.txid)})}</div>`:''}
    <div class="btnrow">
      ${rejected?'':html`<button class="btn sm" data-act="track" ${busy?'disabled':''}>刷新状态</button>${canRecover?html`<button class="btn sm" data-act="recover" ${busy?'disabled':''}>重新发送（原签名）</button>`:''}`}
      ${canDiscard?html`<button class="btn sm warn" data-act="discard" ${busy?'disabled':''}>放弃这笔</button>`:''}
    </div></div>`;
}
function verifyPanel(v: VerifyState|null,disc: DiscoveredRound|null=null,currentTickets: number|null=null): Raw|'' {
  if(!v)return '';
  const hasNewerDisc=disc&&currentTickets!=null&&(disc.tickets??0)>currentTickets;
  const hint=hasNewerDisc?`（索引最新已达 ${(disc!.tickets??0).toLocaleString()} 张 · ${disc!.shards??0} 片）`:'';
  if(v.state==='checking')return html`<div class="notice">正在向节点核对链上状态${hint}…</div>`;
  if(v.state==='partial')return html`<div class="notice warn">已同步部分进度，后台正在继续追赶${hint}…</div>`;
  if(v.state==='ok')return html`<div class="notice ok">已向节点核对（${new Date(v.at??0).toLocaleTimeString()}）</div>`;
  const transient=['INDEXER_TIMEOUT','INDEXER_UNAVAILABLE','RPC_TIMEOUT','NODE_REQUIRED','NODE_CLOSED'].includes(v.code??'');
  return html`<div class="notice ${transient?'warn':'bad'}"><b>${transient?'同步未完成':'与链上状态不一致'}</b>：${errText(v.code??'')}</div>`;
}
const TX_SUMMARY_CACHE=new WeakMap<Receipt[],{hasShards: boolean;len: number;list: Receipt[];omittedBuys: number;omittedRefunds: number}>();
function txTable(D: Detail,x: Ctx): Raw {
  const r=D.r,hasShards=!!(D.shards&&D.shards.length);
  if(!r.receipts.length)return html`<p class="muted small">还没有已确认的交易。</p>`;
  // Confirmed BUY receipts (and confirmed REFUND_OLD/REFUND_SELF when shard dot-map is present) are represented per-shard/purchase above.
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
  const omittedParts=[omittedBuys>0?`${omittedBuys.toLocaleString()} 笔已确认购买交易`:'',omittedRefunds>0?`${omittedRefunds.toLocaleString()} 笔已确认退款交易`:''].filter(Boolean);
  if(!list.length)return html`<p class="muted small">共 ${omittedParts.join('、')}，请在上方分片点图中查看。</p>`;
  const limit=x.S.txLimit??20,total=list.length,shown=list.slice(Math.max(0,total-limit)).reverse();
  return html`<div class="tablewrap"><table><tr><th>步骤</th><th>交易</th><th>状态</th><th>网络费</th></tr>${shown.map(t=>html`<tr>
    <td>${actionTitle(t.action)}</td><td>${hash(t.txid,{n:8,link:x.ex.tx(t.txid)})}</td>
    <td>${t.finalized===false?html`<span class="badge t-violet">确认中</span>`:html`<span class="badge t-mint">已接受</span>`}</td><td class="mono">${feeText(t.feeSompi)}</td></tr>`)}</table></div>
    ${total>shown.length?html`<div class="btnrow"><span class="small muted">最近 ${shown.length} / ${total.toLocaleString()} 笔</span><button type="button" class="btn sm" data-moretx="100">再加载 100 笔</button><button type="button" class="btn sm" data-moretx="all">显示全部</button></div>`:''}
    ${omittedParts.length?html`<p class="small muted" style="margin-top:8px">已省略 ${omittedParts.join('、')}（见上方分片点图）。</p>`:''}`;
}
const DOT_COLORS=['#49eacb','#60a5fa','#a78bfa','#f472b6','#f59e0b','#34d399','#f87171','#22d3ee','#c084fc','#fbbf24','#4ade80','#fb7185','#38bdf8','#e879f9','#a3e635','#fb923c'];
type Rgb=readonly [number,number,number];
const hexRgb=(h: string): Rgb=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
const DOT_RGBS: readonly Rgb[]=DOT_COLORS.map(hexRgb);
const WIN_RGB: Rgb=[251,191,36];
const SHARD_META: Record<ShardStatus,{label: string;tone: string;color: string}>={
  active:{label:'当前分片',tone:'t-mint',color:'var(--kas)'},
  frozen:{label:'已封存',tone:'t-violet',color:'var(--sky)'},
  refunding:{label:'退款中',tone:'t-amber',color:'var(--amber)'},
  settled:{label:'已派奖',tone:'t-mint',color:'var(--sky)'},
  refunded:{label:'已退款',tone:'t-muted',color:'var(--violet)'},
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
/** Paint the entire shard pixel-map wall onto a single shared <canvas> (16 cols × rows, 16×16 sharp pixels per shard + 1px slot margin).
 * Using a single canvas eliminates 150-256 separate GPU canvas surfaces that cause scroll jank, while caching immutable frozen shard tiles. */
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
export function buyReceiptForRound(sh: ShardView,rec: ShardRecordView,r: Round,shards: ShardView[]|null|undefined,isKusdt=!!r.kusdt): Receipt|null {
  if(!shards)return null;
  if(isKusdt){
    const purchases=r.receipts.filter(t=>t.action==='OPEN_SHARD'||t.action==='BUY');
    if(sh.hash){
      const exact=purchases.find(t=>
        t.shardCid===sh.hash&&(
          t.recordIndex===rec.index
          ||(t.recordIndex==null&&t.action==='OPEN_SHARD'&&rec.index===0)
        )
      );
      if(exact)return exact;
      const byShard=purchases.filter(t=>t.shardCid===sh.hash);
      if(sh.recordCount!=null&&byShard.length===sh.recordCount)return byShard[rec.index]??null;
    }
    if(shards.length===1&&sh.recordCount!=null&&purchases.length===sh.recordCount){
      return purchases[rec.index]??null;
    }
    return null;
  }
  const buys=r.receipts.filter(t=>t.action==='BUY');
  let offset=0,total=0;
  for(const s of shards){
    if(s.recordCount==null)return null;
    if(s.index===sh.index)offset=total;
    total+=s.recordCount;
  }
  if(buys.length!==total)return null;
  return buys[offset+rec.index]??null;
}
function buyReceiptFor(sh: ShardView,rec: ShardRecordView,D: Detail): Receipt|null {
  return buyReceiptForRound(sh,rec,D.r,D.shards,!!D.r.kusdt||D.asset?.kind==='KCC20');
}
const frozenBatchesOf=(s: ShardView): number=>Math.ceil((s.recordCount??256)/32);
function expectedRefundOldCount(frozenShards: ShardView[]): number {
  let n=0;
  for(const s of frozenShards){
    if(s.status==='refunded')n+=frozenBatchesOf(s);
    else if(s.status==='refunding')n+=Math.floor(s.refundedRecords/32);
  }
  return n;
}
export function refundReceiptForRound(sh: ShardView,rec: ShardRecordView,r: Round,shards: ShardView[]|null|undefined,isKusdt=!!r.kusdt): Receipt|null {
  if(!rec.refunded||!shards)return null;
  if(isKusdt){
    const claims=r.receipts.filter(t=>t.action==='CLAIM_REFUND');
    if(sh.hash){
      const exact=claims.find(t=>t.shardCid===sh.hash&&t.recIdx===rec.index);
      if(exact)return exact;
      if(sh.recordCount===1&&rec.index===0){
        const byShard=claims.filter(t=>t.shardCid===sh.hash);
        if(byShard.length===1)return byShard[0]!;
      }
    }
    if(shards.length===1&&sh.recordCount===1&&rec.index===0&&claims.length===1){
      return claims[0]!;
    }
    return null;
  }
  const frozenShards=shards.filter(s=>s.kind==='frozen');
  const refundOlds=r.receipts.filter(t=>t.action==='REFUND_OLD');
  const expectedOld=expectedRefundOldCount(frozenShards);
  if(sh.kind==='frozen'){
    if(refundOlds.length!==expectedOld)return null;
    let offset=0;
    for(const s of frozenShards){if(s.index===sh.index)break;offset+=frozenBatchesOf(s);}
    return refundOlds[offset+Math.floor(rec.index/32)]??null;
  }
  const activeCount=sh.recordCount??sh.records?.length??0;
  if(frozenShards.length>0&&activeCount>0&&activeCount<=2){
    return refundOlds.length===expectedOld&&expectedOld>0?(refundOlds.at(-1)??null):null;
  }
  const refundSelfs=r.receipts.filter(t=>t.action==='REFUND_SELF');
  const expectedSelf=sh.status==='refunded'?Math.ceil(activeCount/32):sh.status==='refunding'?Math.floor(sh.refundedRecords/32):0;
  if(refundSelfs.length!==expectedSelf)return null;
  return refundSelfs[Math.floor(rec.index/32)]??null;
}
function refundReceiptFor(sh: ShardView,rec: ShardRecordView,D: Detail): Receipt|null {
  return refundReceiptForRound(sh,rec,D.r,D.shards,!!D.r.kusdt||D.asset?.kind==='KCC20');
}
function shardRefundReceipts(sh: ShardView,D: Detail): Receipt[] {
  if(!D.shards)return [];
  if(D.r.kusdt||D.asset?.kind==='KCC20'){
    const claims=D.r.receipts.filter(t=>t.action==='CLAIM_REFUND');
    if(sh.hash){
      const byShard=claims.filter(t=>t.shardCid===sh.hash);
      if(byShard.length)return byShard;
    }
    return D.shards.length===1?claims:[];
  }
  const frozenShards=D.shards.filter(s=>s.kind==='frozen');
  const refundOlds=D.r.receipts.filter(t=>t.action==='REFUND_OLD');
  const expectedOld=expectedRefundOldCount(frozenShards);
  if(sh.kind==='frozen'){
    if(refundOlds.length!==expectedOld||expectedOld===0)return [];
    let offset=0;
    for(const s of frozenShards){if(s.index===sh.index)break;offset+=frozenBatchesOf(s);}
    const count=sh.status==='refunded'?frozenBatchesOf(sh):sh.status==='refunding'?Math.floor(sh.refundedRecords/32):0;
    return count>0?refundOlds.slice(offset,offset+count):[];
  }
  const activeCount=sh.recordCount??sh.records?.length??0;
  if(frozenShards.length>0&&activeCount>0&&activeCount<=2){
    return refundOlds.length===expectedOld&&expectedOld>0&&sh.status==='refunded'?[refundOlds.at(-1)!]:[];
  }
  const refundSelfs=D.r.receipts.filter(t=>t.action==='REFUND_SELF');
  const expectedSelf=sh.status==='refunded'?Math.ceil(activeCount/32):sh.status==='refunding'?Math.floor(sh.refundedRecords/32):0;
  return refundSelfs.length===expectedSelf?refundSelfs:[];
}
function purchaseTip(rec: ShardRecordView|null,sh: ShardView,D: Detail,x: Ctx): Raw {
  if(!rec)return html`<p class="small muted" style="margin:6px 0 0">点击上方方格查看该笔购买的票号、买家与交易（共 ${sh.records?.length??0} 笔）。</p>`;
  const addr=x.ex.addrOfKey(rec.key)??rec.key,draw=D.r.draw??null;
  const isWin=!!draw&&draw.shard===sh.index&&draw.record===rec.index;
  const buyRc=buyReceiptFor(sh,rec,D);
  const refundRc=rec.refunded?refundReceiptFor(sh,rec,D):null;
  const badge=isWin?html`<span class="badge t-gold">🏆 中奖记录（中奖票 #${draw.ticket+1}）</span>`:rec.refunded?html`<span class="badge t-muted">已退款</span>`:html`<span class="badge t-mint">第 ${rec.index+1} 笔购买</span>`;
  const u=unitOf(x),isKusdt=D.asset?.kind==='KCC20',tu=isKusdt?D.asset!.symbol:u;
  return html`<div class="matrix-tip">
    <div class="tip-head">${badge}<strong>票号 #${rangeText(rec.startTicket,rec.endTicket)}</strong><span class="tag">${rec.count.toLocaleString()} 张</span>
      <span class="muted">${fmtAmt(BigInt(rec.count)*D.f.ticketPrice,D.asset)} ${tu}</span><span class="spacer"></span>${rec.mine?html`<span class="tag kas">我</span>`:''}</div>
    <div class="tip-body"><span>买家：${hash(addr,{n:10,link:x.ex.addr(addr)})}</span>
      <span>购买交易：${buyRc?html`${hash(buyRc.txid,{n:10,link:x.ex.tx(buyRc.txid)})} <span class="dim">(${buyRc.finalized===false?'确认中':'已接受'} · 网络费 ${feeText(buyRc.feeSompi)} ${u})</span>`:html`<span class="muted">本机未保留完整购买交易索引</span>`}</span>
      ${rec.refunded?html`<span>退款交易：${refundRc?html`${hash(refundRc.txid,{n:10,link:x.ex.tx(refundRc.txid)})} <span class="dim">(${refundRc.finalized===false?'确认中':'已接受'} · 网络费 ${feeText(refundRc.feeSompi)} ${u})</span>`:html`<span class="muted">本机未保留完整退款交易索引</span>`}</span>`:''}
    </div>
  </div>`;
}
function selectedShardPanel(sh: ShardView,D: Detail,x: Ctx): Raw {
  const meta=SHARD_META[sh.status],recs=sh.records,draw=D.r.draw??null,pixelMode=!!x.S.pixelMode;
  const modeSwitch=recs&&recs.length?html`<div class="seg" role="group" aria-label="点图模式"><button type="button" data-pixelmode="0" aria-pressed="${!pixelMode}">编号</button><button type="button" data-pixelmode="1" aria-pressed="${pixelMode}">纯像素</button></div>`:'';
  const header=html`<div class="shard-head"><span class="badge ${meta.tone}">${meta.label}</span>
    <h4>${sh.kind==='active'?'当前分片':`封存分片 #${sh.index+1}`}</h4>
    <span class="small muted">票号 #${rangeText(sh.startTicket,sh.endTicket)} · ${sh.tickets.toLocaleString()} 张${recs?` · ${recs.length} 笔购买`:''}</span>
    ${sh.mineCount>0?html`<span class="tag kas">我持有 ${sh.mineCount.toLocaleString()} 张</span>`:''}<span class="spacer"></span>
    ${modeSwitch}<button type="button" class="btn sm" data-shard="close">收起分片</button></div>`;
  if(recs===null){
    const shardRefunds=sh.status==='refunded'||sh.status==='refunding'?shardRefundReceipts(sh,D):[];
    return html`<div class="shard-detail">${header}
      <p class="muted small">该分片已完成${sh.status==='refunded'?'退款':'派奖'}并被合约回收，链上 UTXO 不再保留逐笔明文记录（共 ${sh.tickets.toLocaleString()} 张票${sh.hash?html`，分片哈希 <span class="mono">${shortHash(sh.hash,10,6)}</span>`:''}）。</p>
      ${shardRefunds.length?html`<div class="tip-body" style="margin-top:6px"><span>退款交易（${shardRefunds.length} 批）：${shardRefunds.map(t=>hash(t.txid,{n:8,link:x.ex.tx(t.txid)}))}</span></div>`:''}</div>`;
  }
  if(!recs.length)return html`<div class="shard-detail">${header}<p class="muted small">这个分片还没有购买记录。</p></div>`;
  const addrCache=new Map<string,string>();
  const addrOf=(k: string): string=>{let a=addrCache.get(k);if(!a){a=x.ex.addrOfKey(k)??k;addrCache.set(k,a);}return a;};
  const selIdx=x.S.purchase??null,selRec=selIdx!=null?recs.find(r=>r.index===selIdx)??null:null;
  const cells=recs.map(rec=>{
    const isWin=!!draw&&draw.shard===sh.index&&draw.record===rec.index,isSel=selIdx===rec.index,addr=addrOf(rec.key);
    const range=rangeText(rec.startTicket,rec.endTicket),st=isWin?` · 🏆 中奖票 #${draw.ticket+1}`:rec.refunded?' · 已退款':'';
    const title=`第 ${rec.index+1} 笔 · 票号 #${range} (${rec.count} 张) · 买家 ${shortHash(addr,8,6)}${rec.mine?' (我)':''}${st}`;
    return html`<button type="button" class="cell${isWin?' w':''}${rec.mine?' me':''}${rec.refunded?' refunded':''}${isSel?' active':''}" style="--c:${keyColor(rec.key)}" data-purchase="${rec.index}" aria-pressed="${isSel}" aria-label="第 ${rec.index+1} 笔购买" title="${title}">${isWin?'🏆':rec.index+1}</button>`;
  });
  const emptyCount=Math.max(0,256-recs.length);
  const blanks=emptyCount>0?Array.from({length:emptyCount},()=>html`<span class="cell blank" aria-hidden="true"></span>`):[];
  const legend=draw&&draw.shard===sh.index?html`<div class="legend"><span><i style="--c:var(--gold)"></i>中奖票 #${draw.ticket+1}（第 ${draw.record+1} 笔）</span></div>`:'';
  return html`<div class="shard-detail">${header}
    <div class="matrix${pixelMode?' pixel':''}" role="region" aria-label="分片购买点图">${cells}${blanks}</div>
    ${purchaseTip(selRec,sh,D,x)}
    ${legend}
  </div>`;
}
function shardSection(D: Detail,x: Ctx): Raw {
  const {r,f}=D;
  if(r.terminal==='EMPTY')return html`<p class="muted small">本轮无人购买，已结束并退还创建者押金。</p>`;
  const shards=D.shards;
  if(r.terminal&&(!shards||!shards.length))return html`<p class="muted small">本轮已结束（${TERMINAL_LABEL[r.terminal]??r.terminal}），共售出 ${f.tickets.toLocaleString()} 张票；合约分片 UTXO 已全部结算并回收，请查看下方交易记录。</p>`;
  if(!shards){
    if(f.tickets>0)return html`<p class="muted small">当前已售 ${f.tickets.toLocaleString()} 张票（${f.shards} 个封存分片，当前分片 ${f.localRecords} 笔购买）；需要完整合约状态才能展开分片点图。</p>`;
    return html`<p class="muted small">还没有购买记录（每满 256 笔购买将自动封存为一个分片）。</p>`;
  }
  if(!shards.length)return html`<p class="muted small">还没有购买记录（每满 256 笔购买将自动封存为一个分片）。</p>`;
  const sel=x.S.shard!=null?shards.find(s=>s.index===x.S.shard)??null:null,draw=D.r.draw??null;
  const counts={frozen:shards.filter(s=>s.kind==='frozen').length,active:shards.filter(s=>s.kind==='active').length,
    refunding:shards.some(s=>s.status==='refunding'),done:shards.some(s=>s.records===null),mine:shards.some(s=>s.mineCount>0)};
  const rows=Math.max(1,Math.ceil(shards.length/16));
  const cells=shards.map(sh=>{
    const meta=SHARD_META[sh.status],isSel=sel?.index===sh.index,done=sh.records===null,isWinShard=!!draw&&draw.shard===sh.index;
    const title=`分片 #${sh.index+1}（${meta.label}）· 票号 #${rangeText(sh.startTicket,sh.endTicket)}（${sh.tickets.toLocaleString()} 张${sh.recordCount!=null?` / ${sh.recordCount} 笔`:''}）${isWinShard?` · 🏆 含中奖票 #${draw.ticket+1}`:''}${sh.mineCount>0?` · 我持有 ${sh.mineCount} 张`:''}`;
    return html`<button type="button" class="shard-card${isWinShard?' w':''}${done?' done':''}${sh.mineCount>0?' me':''}${isSel?' active':''}" data-shard="${sh.index}" aria-pressed="${isSel}" aria-label="分片 ${sh.index+1}" title="${title}"></button>`;
  });
  const legend=html`<div class="legend">
    ${counts.active?html`<span><i style="--c:${r.terminal?'var(--sky)':'var(--kas)'}"></i>${r.terminal?'尾部分片':'当前分片'}</span>`:''}
    ${counts.frozen?html`<span><i style="--c:var(--sky)"></i>${r.terminal==='PAID'?'历史封存（已派奖）':r.terminal==='REFUNDED'?'历史封存（已退款）':'已封存'} (${counts.frozen})</span>`:''}
    ${counts.refunding?html`<span><i style="--c:var(--amber)"></i>退款中</span>`:''}
    ${counts.done?html`<span><i style="--c:var(--panel3);border:1px solid var(--line2)"></i>已回收（无逐笔记录）</span>`:''}
    ${counts.mine?html`<span><i style="--c:var(--kas);box-shadow:inset 0 0 0 1px #fff"></i>含我的票</span>`:''}
    ${draw?html`<span><i style="--c:var(--gold)"></i>中奖分片 #${draw.shard+1}（中奖票 #${draw.ticket+1}）</span>`:''}
  </div>`;
  const kusdtShardActs=D.kusdt?kusdtShardActions(D.kusdt,D,x):'';
  return html`<p class="small muted" style="margin:0 0 8px">${r.terminal?`本轮已结束（${TERMINAL_LABEL[r.terminal]??r.terminal}），`:''}共 ${shards.length} 个分片（封存 ${counts.frozen} 个）· ${f.tickets.toLocaleString()} 张票 · 点击任意分片点图查看 16×16 像素明细</p>
    <div class="shard-wall"><div class="shard-wall-inner" style="--rows:${rows}">
      <canvas class="shard-wall-canvas" width="288" height="${rows*SHARD_STRIDE}" data-shard-wall="1" aria-hidden="true"></canvas>
      <div class="shard-grid" role="region" aria-label="分片分布">${cells}</div>
    </div></div>
    ${legend}
    ${sel?selectedShardPanel(sel,D,x):''}
    ${kusdtShardActs}`;
}
function kusdtShardActions(live: KusdtLiveState,D: Detail,x: Ctx): Raw|'' {
  const actShards=live.shards.filter(s=>!s.terminal&&(s.stage===0x13||s.stage===0x14));
  if(!actShards.length)return '';
  const u=D.asset?.symbol??'kUSDT',dec=D.asset?.decimals??6,busy=x.busy||!signing(x.wallet);
  return html`<div class="list" style="display:grid;gap:8px;margin-top:12px">${actShards.map(s=>html`
    <div class="card" style="padding:10px">
      <div class="row small"><strong>分片 #${shortHash(s.shardCid,8,6)}</strong><span class="spacer"></span><span class="badge">${s.stage===0x13?'待派奖':'待退款'}</span></div>
      ${s.stage===0x13?html`<div class="btnrow" style="margin-top:8px">
        ${D.isWinner?html`<button type="button" class="btn sm pri" data-kusdt-act="PAYOUT_SELF" data-shard-cid="${s.shardCid}" ${busy?'disabled':''}>赢家自推（领全额奖金）</button>`:''}
        <button type="button" class="btn sm ${D.isWinner?'':'pri'}" data-kusdt-act="PAYOUT_EXECUTOR" data-shard-cid="${s.shardCid}" ${busy?'disabled':''}>代推派奖（赚 0.5 ${u}）</button>
      </div>`:''}
      ${s.stage===0x14&&s.records?html`<div style="margin-top:8px;display:grid;gap:6px">${s.records.map((rec,idx)=>{
        const prev=idx===0?0:s.records![idx-1]!.cumTickets,qty=rec.cumTickets-prev,claimed=((s.claimedMask??0)&(1<<idx))!==0;
        return html`<div class="row small"><span>#${idx+1}（${shortHash(rec.buyerPk,6,4)} · ${qty} 张 · ${formatKcc20(BigInt(qty)*live.price,dec)} ${u}）</span><span class="spacer"></span>
          ${claimed?html`<span class="tag">已领取</span>`:html`<button type="button" class="btn sm pri" data-kusdt-act="CLAIM_REFUND" data-shard-cid="${s.shardCid}" data-rec-idx="${idx}" ${busy?'disabled':''}>自助退款</button>`}</div>`;
      })}</div>`:''}
    </div>`)}</div>`;
}
function kusdtShardTopAction(live: KusdtLiveState,D: Detail,x: Ctx): Raw|'' {
  const actShards=live.shards.filter(s=>!s.terminal&&(s.stage===0x13||s.stage===0x14));
  if(!actShards.length)return '';
  const u=D.asset?.symbol??'kUSDT',dec=D.asset?.decimals??6,kasU=unitOf(x);
  const hasRefund=actShards.some(s=>s.stage===0x14);
  const canAct=!x.busy&&signing(x.wallet)&&!!x.conn.node;
  return html`<div class="act act-hero">
    <h4>${hasRefund?`自助退款（领回 ${u} 与 4 ${kasU} 分片押金）`:`分片派奖（${u} 奖金与 4 ${kasU} 分片押金）`}</h4>
    <p>${hasRefund
      ?`本轮已下发退款许可（创建者 4 ${kasU} 押金已退回）。点击下方按钮从分片金库领回对应的 ${u} 票款；最后一条记录领取时自动退回 4 ${kasU} 分片/金库押金。`
      :`本轮已下发派奖许可（创建者 4 ${kasU} 押金已退回）。任何人均可代推派奖（赚 0.5 ${u} 激励），赢家也可自推免激励领回全额奖金。`}</p>
    ${!signing(x.wallet)?html`<div class="why">需要先连接可签名的钱包支付少量网络费。</div><button type="button" class="btn pri block" data-fix="wallet">连接钱包并领取</button>`:html`
      <div style="display:grid;gap:8px;margin-top:8px">${actShards.map(s=>s.stage===0x14&&s.records?html`
        ${s.records.map((rec,idx)=>{
          const prev=idx===0?0:s.records![idx-1]!.cumTickets,qty=rec.cumTickets-prev,claimed=((s.claimedMask??0)&(1<<idx))!==0;
          const amt=formatKcc20(BigInt(qty)*live.price,dec);
          return claimed?'':html`<button type="button" class="btn pri block" data-kusdt-act="CLAIM_REFUND" data-shard-cid="${s.shardCid}" data-rec-idx="${idx}" ${canAct?'':'disabled'}>${x.busy?'处理中…':`自助退款 · 领回 ${amt} ${u}（分片 #${shortHash(s.shardCid,6,4)} #${idx+1}）`}</button>`;
        })}
      `:html`<div class="btnrow">
        ${D.isWinner?html`<button type="button" class="btn pri" data-kusdt-act="PAYOUT_SELF" data-shard-cid="${s.shardCid}" ${canAct?'':'disabled'}>${x.busy?'处理中…':`赢家自推（领全额奖金 · #${shortHash(s.shardCid,6,4)}）`}</button>`:''}
        <button type="button" class="btn ${D.isWinner?'':'pri'}" data-kusdt-act="PAYOUT_EXECUTOR" data-shard-cid="${s.shardCid}" ${canAct?'':'disabled'}>${x.busy?'处理中…':`代推派奖（赚 0.5 ${u} · #${shortHash(s.shardCid,6,4)}）`}</button>
      </div>`)}</div>`}
  </div>`;
}
function roundCountdown(D: Detail,x: Ctx): Raw|'' {
  const {r,f}=D;if(r.terminal||r.halted||r.intent||!r.manager)return '';
  if(f.module==='sales')return html`<div class="notice round-countdown" role="status"><h3>${ic('clock')} 最早封盘倒计时</h3><p>${x.daa===null?'正在读取节点时间…':D.a.CLOSE?.ok?'已满足封盘条件，任何人可封盘。':`距最早封盘还有约 ${daaDuration(f.closeEligibleDaa-x.daa)}`}</p></div>`;
  if(f.module!=='sealed')return '';
  const m=drawReadiness(D,x);
  return html`<div class="notice round-countdown ${m.ready?'ok':''}" role="status"><h3>${ic('clock')} ${m.label}</h3>
    <p>${m.detail}</p>${m.percent!==null?html`<progress max="100" value="${m.percent}" aria-label="${m.label}"></progress>`:''}</div>`;
}
function liveSyncToggle(x: Ctx): Raw {
  const on=x.S.liveSync!==false,checking=on&&(x.verify?.state==='checking'||x.conn.node===null);
  const title=on?'实时同步已开启，点击暂停':'实时同步已暂停，点击恢复并立即同步';
  const label=on?(checking?'实时同步中…':'实时同步'):'同步已暂停';
  return html`<button type="button" class="btn sm live-toggle${on?' on':''}" data-act="verify" role="switch" aria-checked="${on}" title="${title}" ${raw(x.busy?'disabled aria-busy="true"':(checking?'aria-busy="true"':''))}><i class="dot${on?(checking?' warn':' ok'):''}" aria-hidden="true"></i>${label}</button>`;
}
function discoveredDetailView(d: DiscoveredRound,x: Ctx): Raw {
  const isKusdt=d.protocolId==='kusdt-v2'||d.asset?.kind==='KCC20';
  const ph=indexedPhase(d),u=isKusdt?(d.asset?.symbol??'kUSDT'):unitOf(x),cid=d.cid;
  const tkt=d.terminal?(d.bought??d.ticketsSold??d.tickets??0):(d.ticketsSold??d.tickets??0);
  const sc=d.shards||(d.terminal&&(d.buys??0)>=256?Math.floor((d.buys??0)/256):0);
  const mval=!d.terminal?safeBig(d.managerValue):0n;
  const kusdtPool=isKusdt&&d.ticketPrice?BigInt(tkt)*safeBig(d.ticketPrice):0n;
  const refund=d.module==='refund'||d.phase==='REFUNDING'||d.terminal==='REFUNDED',labels=refund?STEPS_REFUND:STEPS_NORMAL;
  const pos=d.terminal?4:(d.module==='sealed'||d.phase==='SEALED')?1:(d.module==='win'||d.module==='refund'||d.phase==='SETTLING'||d.phase==='REFUNDING')?2:0;
  const isIncompat=!!(d.profileId&&x.supportedProfiles&&!x.supportedProfiles.has(d.profileId));
  const compatList=x.compatibleProfiles??[];
  const statusNotice=isIncompat
    ?html`<div class="notice warn">
      <h3>当前版本不兼容此轮次的合约 Profile（仅供只读查看）</h3>
      <p>如需查看完整明细或继续操作此轮次，请按下方完整合约 Profile 前往 GitHub Releases 查找兼容该 Profile 的对应 Kaswin 版本。</p>
      <dl class="kv" style="margin:10px 0 8px">
        <dt>轮次协议</dt><dd>${isKusdt?'kUSDT v2 (KCC-20)':'KAS (Rolling v1)'}${d.protocolId?html` <span class="mono small muted">(${d.protocolId})</span>`:''}</dd>
        <dt>轮次合约 Profile</dt><dd><span class="mono small" style="word-break:break-all;user-select:all">${d.profileId}</span></dd>
        ${compatList.length?html`<dt>本页兼容 Profile</dt><dd class="small muted">${compatList.map((p,i)=>html`${i?' · ':''}${p.asset}: <span class="mono">${shortHash(p.profileId,8,4)}</span>`)}</dd>`:''}
      </dl>
      <div class="btnrow" style="margin-top:8px">
        <button type="button" class="btn sm" data-copy="${d.profileId}">${ic('copy')}复制合约 Profile</button>
        <a class="btn sm ghost" href="https://github.com/agang0311/kaswin/releases" target="_blank" rel="noopener noreferrer">前往 GitHub Releases 查找对应版本 ↗</a>
      </div>
    </div>`
    :x.verify?.state==='bad'
      ?verifyPanel(x.verify)
      :x.conn.node===false
        ?html`<div class="notice warn">节点未连接，先展示本地缓存摘要；连接节点后自动同步最新状态。</div>`
        :html`<div class="notice">正在后台同步分片明细并向节点核对最新状态…</div>`;
  const profileRow=d.profileId&&!isIncompat
    ?html`<dl class="kv" style="margin:12px 0 0"><dt>合约协议</dt><dd>${isKusdt?'kUSDT v2 (KCC-20)':'KAS (Rolling v1)'}</dd><dt>合约 Profile</dt><dd>${hash(d.profileId,{n:12})} <span class="tag kas">兼容</span></dd></dl>`
    :'';
  return html`
  <div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}返回</button><span class="spacer"></span>
    <button class="btn sm" data-act="toggleStar">${ic('star')}${x.saved?.has(cid)?'已关注':'关注'}</button>
    ${!d.terminal&&!isIncompat?liveSyncToggle(x):''}</div>
  <div class="panel t-${ph.tone}">
    <div class="row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="badge t-${ph.tone}">${ph.label}</span>${isKusdt?html`<span class="badge">${u}</span>`:''}<span class="spacer"></span>
      <span class="tag">${isIncompat?'不兼容轮次（只读）':'本地缓存摘要'}</span></div>
    <h2 style="margin:8px 0 14px">轮次 ${hash(cid,{n:14})}</h2>
    <div class="stepper">${labels.map((l,i)=>html`<div class="step ${i<pos?'done':i===pos?'now':''} ${refund&&i>=2?'alt':''}"><div class="b">${i<pos?'✓':i+1}</div>${l}</div>`)}</div>
    ${statusNotice}
    <p class="muted" style="margin:0 0 12px">${d.terminal?HINT_TERMINAL[d.terminal]??'':HINT_MODULE[d.module??'']??''}</p>
    <div class="cols3">
      ${kpi(d.terminal?'历史售出票数':'当前已售票数',`${tkt.toLocaleString()} 张`,d.buys!=null?`${d.buys.toLocaleString()} 笔购买`:'读取中…')}
      ${kpi(isKusdt?'活跃分片':'封存分片',`${sc}`)}
      ${kpi(isKusdt?(d.terminal?'已售总额':'当前奖池'):'合约锁定',isKusdt?`${formatKcc20(kusdtPool,d.asset?.decimals??6)} ${u}`:(mval>0n?`${kas(mval)} ${u}`:(d.terminal?'已结算':'—')))}
    </div>
    ${profileRow}
  </div>`;
}
const ORDER: Record<string,string[]>={sales:['BUY','CLOSE'],sealed:['DRAW','TIMEOUT'],win:['PAY_OLD','PAY_SELF'],refund:['REFUND_OLD','REFUND_SELF']};
export function roundView(x: Ctx): Raw {
  const D=x.detail,p=x.submission?.cid===x.S.cid?x.submission:null;
  const progress=p?html`<div class="notice ${p.error?'bad':''}" role="${p.error?'alert':'status'}" aria-live="polite" aria-busy="${p.error?'false':'true'}">
    <h3>${p.error?'交易处理未完成':'已签名，正在保存并提交交易…'}</h3>
    <p>${p.error?p.error:'签名已完成。提交结果与节点接受状态将在本页自动更新，请不要关闭页面。'}</p>
    ${p.error?html`<p>请查看运行日志；如有待确认交易，请先核对状态，避免重复操作。</p>`:''}
    <dl class="kv"><dt>操作</dt><dd>${actionTitle(p.action)}</dd><dt>交易 ID</dt><dd>${hash(p.txid,{n:14})}</dd></dl>
  </div>`:'';
  if(!D){
    if(p)return html`<div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}返回轮次列表</button></div><div class="panel"><h2>轮次 ${hash(p.cid,{n:14})}</h2>${progress}</div>`;
    const disc=x.S.cid?x.discovered?.find(d=>d.cid===x.S.cid)??null:null;
    if(disc)return discoveredDetailView(disc,x);
    if(x.verify?.state==='checking'||x.conn.node===null)return html`<div class="empty"><p>正在通过索引、节点与 REST API 同步轮次最新状态…</p></div>`;
    if(x.verify?.state==='bad')return html`<div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}返回轮次列表</button></div><div class="panel">${verifyPanel(x.verify)}</div>`;
    return html`<div class="empty">没有找到这一轮。<button class="link" data-go2="explore">返回轮次列表</button></div>`;
  }
  const {r,f,ph}=D,price=f.ticketPrice,open=!r.terminal&&!r.halted&&!r.intent&&r.manager,u=unitOf(x),isKusdt=D.asset?.kind==='KCC20',tu=isKusdt?D.asset!.symbol:u;
  const order=ORDER[f.module??'']??[];
  const blockedNotes: string[]=[];
  const cards=open?order.map(a=>{
    const st=D.a[a];
    if(a==='CLOSE'&&st&&!st.ok){
      if(st.reason&&!/不适用|没有旧分片|不满足/.test(st.reason))blockedNotes.push(st.reason);
      return '';
    }
    return actionCard(a,D,x);
  }).filter(c=>c!==''):[];
  const mine=D.mine,ownerAddr=x.ex.addrOfKey(f.owner);
  // The creation transaction is the GENESIS receipt. `r.origin` is NOT it: it is the output GENESIS spent as its first input (the covenant's genesis outpoint, created by an earlier transaction).
  const genesisTx=r.receipts.find(t=>t.action==='GENESIS');
  const disc=x.discovered?.find(d=>d.cid===r.cid)??null;
  const isPrunedArchive=!!r.terminal&&!!r.indexer?.prunedAtNode;
  const isVerifiedOk=!D.preview&&!isPrunedArchive&&x.verify?.state==='ok';
  const detailVerifyNotice=D.preview
    ?(x.verify?.state==='bad'?verifyPanel(x.verify):x.conn.node===false
      ?html`<div class="notice warn">当前节点未连接，先展示本地缓存的轮次明细；连接节点并核对通过后即可操作。</div>`
      :html`<div class="notice">已加载本地/索引明细快照，正在后台向节点核对链上共识状态…</div>`)
    :(x.verify&&x.verify.state!=='ok'?verifyPanel(x.verify,disc,f.tickets):(!r.terminal&&!r.intent&&x.conn.node===null)
      ?html`<div class="notice">已加载本地存储记录，正在后台连接节点核对最新链上状态…</div>`
      :'');
  const dtab=x.S.detailTab??'map';
  const closeHint=f.module==='sales'&&!D.a.CLOSE?.ok
    ?(x.daa===null?'正在读取最早可封盘时间…':`距最早可封盘约 ${daaDuration(f.closeEligibleDaa-x.daa)}`)
    :'';
  const kusdtTop=!r.terminal&&!r.halted&&!r.intent&&!r.manager&&isKusdt&&D.kusdt?kusdtShardTopAction(D.kusdt,D,x):'';
  const actionSection=r.terminal
    ?html`<div class="notice ok" style="margin-bottom:16px">${TERMINAL_LABEL[r.terminal]}：${nextHint(D)}</div>`
    :html`<div class="panel action-panel">
      ${f.module==='sealed'?roundCountdown(D,x):''}
      ${cards.length?html`<div class="actions ${cards.length===1?'single':''}">${cards}</div>`:kusdtTop?html`<div class="actions single">${kusdtTop}</div>`:html`<p class="muted small" style="margin:0">${r.intent?'等待上面那笔交易确认。':r.halted?'这一轮已停止。':'暂时没有可执行的操作。'}</p>`}
      ${closeHint||blockedNotes.length?html`<p class="small muted action-foot">${ic('clock')} ${closeHint||blockedNotes[0]}${closeHint&&blockedNotes.length&&blockedNotes[0]!==closeHint?html` · <span>${blockedNotes[0]}</span>`:''}</p>`:''}
    </div>`;
  return html`
  <div class="round-shell">
  <div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}返回</button><span class="spacer"></span>
    <button class="btn sm" data-act="toggleStar">${ic('star')}${x.saved?.has(r.cid)?'已关注':'关注'}</button>
    ${!r.terminal||D.preview?liveSyncToggle(x):''}
    <button type="button" class="btn sm" data-act="moreRound" aria-haspopup="dialog" aria-label="更多轮次操作" ${raw(D.preview?'disabled title="完成节点核对后可分享或导出"':'')}>更多</button></div>
  <div class="panel t-${ph.tone}">
    <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="badge t-${ph.tone}">${ph.label}</span>
      ${isKusdt?html`<span class="badge">${tu}</span>`:''}
      <span class="muted small">轮次 ${hash(r.cid,{n:8})}</span>
      <span class="spacer"></span>
      ${D.preview?html`<span class="tag amber">本地预览 · 后台核对中</span>`:isPrunedArchive?html`<span class="tag" title="该轮次已结束且区块早于节点裁剪窗口，当前展示经离线校验的索引历史存档">历史存档 · 节点已裁剪</span>`:isVerifiedOk?html`<span class="verify-chip" title="已向节点核对（${new Date(x.verify!.at??0).toLocaleTimeString()}）">✓ 已向节点核对</span>`:''}
    </div>
    <div class="cols3" style="margin:14px 0 12px">
      ${kpi(r.terminal?'已售总额':'当前奖池',f.tickets!=null?html`${fmtAmt(BigInt(f.tickets)*price,D.asset)} <span class="small muted">${tu}</span>`:'—',f.tickets!=null?`每张 ${fmtAmt(price,D.asset)} ${tu}`:'')}
      ${kpi(isKusdt?'已售 / 分片':'已售 / 上限',f.tickets!=null?(isKusdt?`${f.tickets.toLocaleString()} 张 · ${f.shards} / 256 片`:`${f.tickets.toLocaleString()} / ${f.ticketCap.toLocaleString()}`):'—',f.tickets!=null?`最低 ${f.minTickets} 张开奖`:'')}
      ${f.winnerKey?kpi('中奖者',hash(x.ex.addrOfKey(f.winnerKey),{n:12}),D.isWinner?'就是你！':''):
        kpi(mine?'你持有':'你的票',mine?`${mine.tickets.toLocaleString()} 张`:signing(x.wallet)?'0 张':'—',mine&&mine.total>0&&(f.module==='sales'||f.module==='sealed')?`中奖概率约 ${(mine.tickets/mine.total*100).toFixed(2)}%`:'')}
    </div>
    ${f.module||r.terminal?stepper(D):''}
    ${progress}${intentPanel(r,x)}${detailVerifyNotice}
  </div>
  ${actionSection}
  <div class="panel detail-panel">
    <div class="detail-tabs seg" role="tablist" aria-label="轮次详情">
      <button type="button" role="tab" data-dtab="map" aria-selected="${dtab==='map'}" aria-pressed="${dtab==='map'}">${ic('ticket')} 票号分布</button>
      <button type="button" role="tab" data-dtab="txs" aria-selected="${dtab==='txs'}" aria-pressed="${dtab==='txs'}">${ic('ledger')} 交易记录</button>
      <button type="button" role="tab" data-dtab="rules" aria-selected="${dtab==='rules'}" aria-pressed="${dtab==='rules'}">${ic('clock')} 规则与信息</button>
    </div>
    <div class="detail-tab-body">
      ${dtab==='map'?shardSection(D,x):dtab==='txs'?txTable(D,x):(()=>{
        const roundProfileId=r.profileId??x.compatibleProfiles?.find(cp=>cp.protocolId===(isKusdt?'kusdt-v2':'rolling-v1'))?.profileId??null;
        return html`<dl class="kv">
        <dt>合约协议</dt><dd>${isKusdt?'kUSDT v2 (KCC-20)':'KAS (Rolling v1)'}</dd>
        <dt>合约 Profile</dt><dd>${roundProfileId?html`${hash(roundProfileId,{n:12})} <span class="tag kas">兼容</span>`:html`<span class="muted">—</span>`}</dd>
        <dt>票价</dt><dd>${fmtAmt(price,D.asset)} ${tu}</dd>
        <dt>最低开奖票数</dt><dd>${f.minTickets} 张（不足自动退款）</dd>
        <dt>最早可封盘</dt><dd>${f.closeEligibleDaa>0n?(x.daa!=null&&x.daa>=f.closeEligibleDaa?'已到时间':`约 ${wait(x.daa,f.closeEligibleDaa)}`):'—'}</dd>
        <dt>${isKusdt?'活跃分片':'已封存分片'}</dt><dd>${isKusdt?`${f.shards} / 256 片`:`${f.shards} 片`}</dd>
        <dt>创建者</dt><dd>${ownerAddr?hash(ownerAddr,{n:10,link:x.ex.addr(ownerAddr)}):html`<span class="muted">—</span>`}</dd>
        <dt>创建交易</dt><dd>${genesisTx?hash(genesisTx.txid,{n:10,link:x.ex.tx(genesisTx.txid)}):html`<span class="muted">—</span>`}</dd>
      </dl>
      <details class="adv-details" style="margin-top:12px"><summary class="small muted">链上技术信息</summary><dl class="kv" style="margin-top:8px">
        <dt>开奖等待</dt><dd>封盘后约 100 DAA（~10 秒）</dd>
        <dt>超时转退款</dt><dd>封盘后约 12 小时未开奖</dd>
        <dt>累计网络费</dt><dd>${kas(r.fees)} ${u}</dd>
        <dt>完整 CID</dt><dd class="mono small">${r.cid}</dd>
        ${roundProfileId?html`<dt>完整 Profile</dt><dd class="mono small">${roundProfileId}</dd>`:''}
        ${r.origin?html`<dt>创世输出</dt><dd class="mono small" title="创建这一轮时被花掉的资金输出（合约 ID 由它推出），不是创建交易本身">${shortHash(r.origin.transactionId,10,6)}:${r.origin.index}</dd>`:''}
        ${r.manager?html`<dt>状态 UTXO</dt><dd class="mono small">${shortHash(r.manager.outpoint.transactionId,10,6)}:${r.manager.outpoint.index}</dd><dt>合约锁定</dt><dd>${kas(r.manager.value)} ${u}</dd>`:''}
        <dt>数据来源</dt><dd>${r.source==='imported'?'导入':'本页创建'}</dd>
      </dl></details>`;})()}
    </div>
  </div>
  </div>`;
}

export function roundToolsBody(cid: string): Raw {
  return html`<div class="round-tools-actions">
    <button type="button" class="btn block" data-act="share" data-round="${cid}">${ic('copy')}复制分享链接</button>
    <button type="button" class="btn block" data-act="export" data-round="${cid}">${ic('download')}导出轮次文件</button>
  </div>`;
}

/* ------------------------------------------------------------------ mine */
export function mineView(x: Ctx): Raw {
  const w=x.wallet,u=unitOf(x);
  const mineRounds=w?(x.mine?.rounds??[]):[];
  const txs=w?(x.mine?.txs??[]):[];
  const pendingCount=x.items.filter(i=>(i.r.pending?.length??0)>0||(!!i.r.intent&&['SUBMITTED','UNKNOWN'].includes(i.r.intent.status))).length;
  return html`
  <div class="cols">
    <div class="panel"><h2>${ic('wallet')} 钱包</h2>
      ${w?html`<dl class="kv"><dt>类型</dt><dd>${w.kind==='extension'?w.name??'扩展钱包':w.kind==='key'?'内存钱包（私钥只在本页内存）':'仅收款地址（不能签名）'}</dd><dt>地址</dt><dd>${hash(w.address,{n:16,link:x.ex.addr(w.address)})}</dd>
        ${signing(w)?html`<dt>余额</dt><dd>${x.balance==null?'读取中…':`${kas(x.balance)} ${u}`}</dd>`:''}</dl>
        <div class="btnrow" style="margin-top:12px"><button class="btn sm" data-fix="wallet">管理钱包</button></div>`
        :html`<p class="sub">还没有连接钱包。连接后才能创建、购买、封盘和开奖；派奖与退款通常只需要一个收款地址。</p><button class="btn pri" data-fix="wallet">${ic('wallet')}连接钱包</button>`}
      <div class="notice warn" style="margin-top:14px">当前网络为 ${x.net.label}。${x.net.key==='mainnet'?'主网已禁用内存明文私钥，请使用扩展钱包或 Kaspire。':'选择内存私钥模式时只用一次性测试密钥；使用扩展时，私钥保留在扩展中。'}</div></div>
    <div class="panel"><h2>${ic('ledger')} 我参与的轮次</h2>
      ${!w?html`<p class="muted small">连接钱包后显示你创建、买票、中奖或在本机操作过的轮次。</p>`:
        mineRounds.length?html`<div class="outs">${mineRounds.map(({item:i,tickets,created,won})=>html`<button class="out" data-open="${i.r.cid}" style="text-align:left;cursor:pointer"><span class="r">${i.ph.label}</span><span class="mono small">${shortHash(i.r.cid,12,8)}</span><span class="v">${won?'🏆 中奖 · ':tickets>0?`我 ${tickets} 张 · `:created?'创建 · ':''}${i.f.tickets!=null?`${i.f.tickets}/${i.f.ticketCap}`:''}</span></button>`)}</div>`
        :html`<p class="muted small">当前钱包还没有参与的轮次（在「轮次广场」看过的轮次不会列入这里）。</p>`}</div>
  </div>
  <div class="panel"><div class="row" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px"><h2 style="margin:0">${ic('check')} 我的交易</h2><span class="spacer"></span>
    <button class="btn sm" data-act="checkPending" ${pendingCount&&!x.checkProgress&&!x.busy?'':'disabled'}>${x.checkProgress?x.checkProgress:`核对所有待确认交易 (${pendingCount})`}</button></div>
    ${!w?html`<p class="muted small">连接钱包后显示你的交易记录。</p>`:
      txs.length?html`<div class="tablewrap"><table><tr><th>轮次</th><th>步骤</th><th>交易</th><th>状态</th><th>网络费</th></tr>${txs.map(({cid,t})=>html`<tr><td class="mono"><a class="link" href="#/round/${cid}">${shortHash(cid,8,4)}</a></td><td>${ACTION_INFO[t.action]?.title??t.action}</td><td>${hash(t.txid,{n:8,link:x.ex.tx(t.txid)})}</td><td>${t.finalized===false?html`<span class="badge t-violet">确认中</span>`:html`<span class="badge t-mint">已接受</span>`}</td><td class="mono">${feeText(t.feeSompi)}</td></tr>`)}</table></div>`
      :html`<p class="muted small">当前钱包还没有交易记录。</p>`}</div>`;
}

/* ------------------------------------------------------------------ rules */
function calcBudget(action: string,pc: number,minTickets=3): number {
  const recs=Array.from({length:pc},(_,i)=>({end:i+1}));
  const st={indices:[],records:recs,minTickets,p:0,r:0,c:0};
  const funds=action==='REFUND_SELF'?[]:[{value:1n}];
  return unitsToBudget(managerBoundUnits(action,{state:st,targets:[],funds}));
}
let cachedBudgetChart: Raw|null=null;
function budgetChart(): Raw {
  if(cachedBudgetChart)return cachedBudgetChart;
  const W=520,H=210,P=30;
  const fam:[string,string,string,number][]=[
    ['BUY','购买','#49eacb',3],['CLOSE','封盘','#60a5fa',3],['DRAW','开奖','#f5c451',3],
    ['TIMEOUT','超时转退款','#a78bfa',3],['REFUND_SELF','自退款','#f87171',257],
  ];
  const x=(n: number)=>P+(W-2*P)*n/256,y=(b: number)=>H-P-(H-2*P)*Math.min(b,160)/160;
  const path=(a: string,minT: number)=>Array.from({length:256},(_,i)=>i+1).map((n,i)=>`${i?'L':'M'}${x(n).toFixed(1)},${y(calcBudget(a,n===256&&a==='BUY'?255:n,minT)).toFixed(1)}`).join('');
  cachedBudgetChart=html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rolling 预算曲线">
    <g class="grid">${[0,40,80,120,160].map(b=>html`<line x1="${P}" x2="${W-P}" y1="${y(b)}" y2="${y(b)}"/><text x="2" y="${y(b)+3}">${b}</text>`)}${[0,64,128,192,256].map(n=>html`<text x="${x(n)-6}" y="${H-10}">${n}</text>`)}</g>
    ${fam.map(([a,_l,c,m])=>html`<path class="l" d="${path(a,m)}" stroke="${c}"/>`)}
  </svg><div class="legend">${fam.map(([_a,l,c])=>html`<span><i style="--c:${c}"></i>${l}</span>`)}</div>`;
  return cachedBudgetChart;
}
function budgetPanel(pc: number,unit='KAS'): Raw {
  const safePc=Math.max(1,Math.min(256,Math.trunc(pc)||32));
  const rows:[string,string,number,number][]=[
    [`第 ${Math.min(safePc+1,256)} 笔购买`,'BUY',Math.min(safePc,255),3],
    ['封盘 → 封存','CLOSE',safePc,3],
    ['封盘 → 退款','CLOSE',safePc,safePc+1],
    ['开奖（当前分片）','DRAW',safePc,3],
    ['超时转退款','TIMEOUT',safePc,3],
    ['自退款（≤32 条）','REFUND_SELF',safePc,safePc+1],
  ];
  return html`<label class="field">当前分片购买记录数：<b id="budgetPcV">${safePc}</b>
    <input type="range" class="slider" id="budgetPc" min="1" max="256" value="${safePc}"></label>
    <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>动作</th><th>compute budget</th><th>约占算力质量</th><th>网络费</th></tr></thead>
    <tbody>${rows.map(([l,a,n,minT])=>{const b=calcBudget(a,n,minT);return html`<tr><td>${l}</td><td class="mono">${b}</td><td class="mono">${(b*10000).toLocaleString()} units</td><td class="mono">按实际交易报价</td></tr>`;})}</tbody></table></div>
    ${budgetChart()}
    <p class="small muted">交易手续费由真实交易质量与节点实时费率动态迭代收敛，单笔风控上限 0.5 ${unit}（派奖 ≤1 ${unit}）。此表基于离线拟合上界模型（仅供预估，共识接受以节点为准）。</p>`;
}
export function rulesView(x?: Ctx): Raw {
  const pc=x?.S?.budgetPc??32,u=unitOf(x),netLabel=x?.net?.label??'Kaspa mainnet',isMainnet=(x?.net?.key??'mainnet')==='mainnet';
  const item=(n: string,t: string,d: string)=>html`<li><span class="n">${n}</span><div><b>${t}</b><span>${d}</span></div></li>`;
  return html`
  <div class="panel"><h2>${ic('shield')} 规则说明</h2><p class="sub">Rolling 是“滚动分片”的抽奖合约：购买笔数不受单片 256 笔的限制。下面是你需要知道的全部规则。</p>
    <div class="flow" style="box-shadow:none"><ol>
      ${item('01','创建 · 售票',`创建者设定票价、票数上限、最低票数和最早封盘时间，并锁入 4 ${u} 押金。任何人可以买票。`)}
      ${item('02','满 256 笔自动封存','每满 256 笔购买，当前分片封存、开一个新分片继续卖。购买笔数不设上限。')}
      ${item('03','封盘','到了最早封盘时间（或票卖满）后任何人可封盘。票数达到最低票数则进入开奖；不足则转入退款；无人购买则退回押金。')}
      ${item('04','开奖','封盘后约 100 DAA（约 10 秒），任何人可开奖。中奖票由链上数据决定，创建者、买家和执行者都无法挑选或预测。')}
      ${item('05','派奖 · 退款',`任何人都可以推进，无需签名；多批处理可使用「一键连续派奖」或「一键连续退款」自动分批推进。派奖：奖金付给中奖者，押金退创建者，执行者每个分片拿 1 ${u}。退款：每条购买记录扣 0.02 ${u} 执行费，其余原路退回。`)}
    </ol></div></div>
  <div class="cols">
    <div class="panel"><h3>费用与押金</h3><dl class="kv">
      <dt>押金</dt><dd>4 ${u}，派奖或无人购买时全额退回创建者；全部退款完成时退回 3.98。</dd>
      <dt>网络费</dt><dd>每笔交易按节点实时费率计算，确认前会明确报价。</dd>
      <dt>执行奖励</dt><dd>派奖：每个分片 1 ${u}（从奖池扣）。退款：每条记录 0.02 ${u} 汇成执行费池，扣除网络费后归执行者。</dd></dl></div>
    <div class="panel"><h3>谁能做什么</h3><dl class="kv">
      <dt>创建者</dt><dd>没有特权，只在最后取回押金。</dd>
      <dt>任何人</dt><dd>买票、封盘、开奖、派奖、退款。派奖和退款无需签名，只需要一个领取奖励的地址。</dd>
      <dt>多人参与</dt><dd>用「复制分享链接」把一轮发给朋友，对方在「加入轮次」粘贴。别人操作后你的本机记录会过期，需要重新获取最新链接。</dd></dl></div>
  </div>
  <div class="panel"><h3>${ic('shield')} 本版本兼容的合约 Profile</h3>
    <p class="sub" style="margin-top:0">本页仅对以下经密码学固定校验的合约 Profile 提供交易构造与节点复核；属于其他历史或旧版 Profile 的轮次会自动归入广场底部「不兼容轮次」分栏，仅供只读查看。</p>
    <div class="tablewrap"><table>
      <thead><tr><th>协议</th><th>计价资产</th><th>合约 Profile ID</th></tr></thead>
      <tbody>${(x?.compatibleProfiles?.length?x.compatibleProfiles:[{protocolId:'rolling-v1',name:'Rolling v1',asset:u,profileId:TN10_PROFILE_ID,tokenCovenantId:null}]).map(p=>html`<tr>
        <td><b>${p.protocolId==='kusdt-v2'?'kUSDT v2 (KCC-20)':'KAS (Rolling v1)'}</b><div class="small muted mono">${p.protocolId}</div></td>
        <td>${p.asset}${p.tokenCovenantId?html`<div class="small muted">代币 ${shortHash(p.tokenCovenantId,6,4)}</div>`:''}</td>
        <td class="mono small" style="word-break:break-all"><span style="user-select:all">${p.profileId}</span> <button type="button" class="copy-btn" data-copy="${p.profileId}" title="复制合约 Profile" aria-label="复制合约 Profile">${ic('copy')}</button></td>
      </tr>`)}</tbody>
    </table></div>
    <p class="small muted" style="margin:10px 0 0">若需操作旧版 Profile 的历史轮次，请前往 <a class="link" href="https://github.com/agang0311/kaswin/releases" target="_blank" rel="noopener noreferrer">GitHub Releases ↗</a> 下载对应声明该 Profile 的历史版本（详见仓库 CHANGELOG.md）。</p>
  </div>
  <div class="panel"><h3>${ic('gauge')} 费用与算力预算计算器</h3>${budgetPanel(pc,u)}</div>
  <div class="panel"><h3>${ic('lock')} 安全与使用须知</h3>
    <div class="notice warn"><b>${isMainnet?'当前为 Kaspa 主网（Rolling 候选 Profile）':'这是 Testnet 10 实验版'}。</b>未经第三方安全审计，请谨慎控制投入金额。</div>
    <ul class="small muted" style="line-height:1.9;margin:0;padding-left:18px">
      <li>轮次规模上限：创建时票数上限可到 ${MAX_TICKET_CAP.toLocaleString()} 张；分片按购买笔数计算，单轮最多 256 个封存分片（65,536 笔购买）。</li>
      <li>钱包支持：支持 KasWare / Kastle 的 ${netLabel} Schnorr 账户与 Kaspire 钱包；${isMainnet?'主网已禁用内存明文私钥，':'也可使用测试内存私钥，'}免签动作可使用公开收款地址。</li>
      <li>索引与恢复：页面默认接入只读 Rolling 索引，并支持在节点历史已裁剪时经由「索引 → 节点虚链追赶 → REST API」自动同步并恢复冻结分片原像；无索引时也可通过分享链接或文件导入/导出备份。</li>
      <li>交易确认基准：交易是否被接受只以 ${netLabel} 节点选中链上的复核结果为准；主网多冻结分片与 TIMEOUT 等极端场景仍建议小额先行验证。</li></ul></div>`;
}

/* ------------------------------------------------------------------ dialogs */
export function walletBody(x: Ctx): Raw {
  const w=x.wallet,u=unitOf(x),isMainnet=x.net.key==='mainnet';
  if(w)return html`<dl class="kv"><dt>类型</dt><dd>${w.kind==='extension'?w.name??'扩展钱包':w.kind==='key'?'内存钱包':'仅收款地址（不能签名）'}</dd><dt>地址</dt><dd class="mono" style="word-break:break-all">${w.address}</dd>
    ${signing(w)?html`<dt>余额</dt><dd>${x.balance==null?'读取中…':`${kas(x.balance)} ${u}`}</dd>`:''}</dl>
    <p class="sub" style="margin-top:12px">${w.kind==='extension'?'签名由扩展钱包确认，本页不会取得私钥。':w.kind==='key'?'断开后私钥会从本页内存清除。':'这个地址只能收取免签动作的执行奖励。'}</p>`;
  const tab=isMainnet&&x.S.wtab==='key'?'extension':x.S.wtab,options=x.walletOptions??[];
  const providers:[string,string,string,boolean][]=[
    ['kasware','KasWare','浏览器扩展钱包',options.some(o=>o.id==='kasware')],
    ['kastle','Kastle','浏览器扩展钱包',options.some(o=>o.id==='kastle')],
    ['kaspire','Kaspire','手机 App（扫码或拉起授权）',true],
  ].sort((a,b)=>(a[0]==='kaspire'?1:a[3]?-1:0)-(b[0]==='kaspire'?1:b[3]?-1:0)) as [string,string,string,boolean][];
  return html`<p class="err" id="wErr" role="alert"></p>
    ${tab==='extension'?html`<p class="sub" style="margin:0 0 12px">选择钱包即可连接（请切换到 <b>${x.net.label}</b>）：</p>
      <div class="wallet-choices">${providers.map(([id,name,desc,ready])=>html`<button type="button" class="wallet-choice${ready&&id!=='kaspire'?' ready':''}" data-connect="${id}">
        <span class="wc-main"><b>${name}</b><small class="muted">${desc}</small></span>
        ${id==='kaspire'?html`<span class="tag">扫码 / App</span>`:ready?html`<span class="tag kas">已检测到</span>`:html`<span class="tag">未安装</span>`}
      </button>`)}</div>
      <div class="wallet-alt small muted"><span>其他方式：</span><button type="button" class="link" data-wtab="addr">仅填收款地址（免签领奖）</button>${isMainnet?'':html`<span>·</span><button type="button" class="link" data-wtab="key">测试私钥</button>`}</div>`
    :tab==='key'?html`<div class="wallet-back"><button type="button" class="link" data-wtab="extension">${ic('arrow')} 返回常用钱包</button></div>
      <div class="notice warn"><b>仅限一次性 Testnet 10 测试私钥</b>，仅保存在当前页面内存。</div>
      <label class="field">TN10 私钥（64 位十六进制）<input id="wKey" type="password" autocomplete="off" data-lpignore="true" spellcheck="false" placeholder="粘贴后点击“连接”"></label>`
    :html`<div class="wallet-back"><button type="button" class="link" data-wtab="extension">${ic('arrow')} 返回常用钱包</button></div>
      <label class="field">收款地址（${x.net.addressPrefix}:q…）<input id="wAddr" autocomplete="off" spellcheck="false" placeholder="${x.net.addressPrefix}:q…"></label><p class="small muted">用于接收派奖与退款的免签执行奖励，不能用于买票或发起抽奖。</p>`}`;
}
export function settingsBody(x: Ctx): Raw {
  const c=x.conn,isMainnet=x.net.key==='mainnet';
  const reported=Array.isArray(c.indexerProfiles)&&c.indexerProfiles.length?new Set(c.indexerProfiles.map(p=>p.profileId)):null;
  const required=(x.compatibleProfiles??[]).filter(p=>isMainnet||p.protocolId!=='kusdt-v2');
  const missing=reported&&required.length?required.filter(p=>!reported.has(p.profileId)):null;
  const indexerHint=c.indexer===true
    ?(c.indexerStale?'索引暂不可用':missing===null?'索引已连接':missing.length?`索引已连接 · 未覆盖 ${missing.map(p=>p.asset).join('、')} Profile`:'索引已连接 · 已覆盖全部兼容 Profile')
    :(c.indexer===false?'连接失败':'未配置');
  return html`<div class="row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;padding:10px 12px;background:var(--panel2);border-radius:10px;border:1px solid var(--line2)">
      <div><b>当前网络：${x.net.label}</b><div class="small muted">${isMainnet?'默认主网 · 禁用内存私钥':'测试网络 · 可用测试私钥'}</div></div>
      <button type="button" class="btn sm" data-act="switchNet">切换到 ${isMainnet?'Testnet 10':'Kaspa 主网'}</button>
    </div>
    <div class="form">
      <label class="field full">${x.net.label} 节点（每行一个 wss:// 地址）<textarea id="sNodes" rows="2" spellcheck="false" autocomplete="off" style="background:var(--panel2);border:1px solid var(--line2);border-radius:10px;padding:10px 12px;width:100%">${x.S.nodes}</textarea>
        <small>${c.node===true?`已连接 · ${c.nodeUrl??''}`:c.node===false?'连接失败':'未连接'}</small></label>
      <label class="field full">索引 API（可选）<input id="sIndexer" value="${x.S.indexer??''}" spellcheck="false" autocomplete="off" placeholder="https://你的索引服务/${x.net.key}">
        <small>${indexerHint}</small></label>
    </div>
    <p class="err" id="sErr" role="alert"></p><div id="sProbe" style="display:grid;gap:8px;margin-top:8px"></div>
    <h3 style="margin-top:16px">备份与恢复</h3>
    <div class="btnrow"><button class="btn" data-act="exportAll">${ic('download')}导出全部轮次</button>
      <button class="btn" data-act="pickFile">${ic('download')}导入轮次文件</button><input id="sFile" type="file" accept="application/json,.json" hidden></div>
    <details style="margin-top:16px"><summary class="small muted">运行日志（不含私钥）</summary><div class="log" style="margin-top:8px;max-height:220px;overflow:auto;font:12px var(--mono)">
      ${x.logs.length?x.logs.slice().reverse().slice(0,60).map(l=>html`<div class="${l.kind}">${new Date(l.at).toLocaleTimeString()} ${l.text}</div>`):'暂无日志'}</div></details>`;
}

/** Confirmation of a prepared transaction: concise payment summary first (user's own kUSDT & KAS breakdown + where it goes), full on-chain outputs separated from contract rollovers. */
export function confirmBody(x: ConfirmCtx): Raw {
  const p=x.prepared,rv=p.review,w=x.wallet,mine=w?.spk?.script,u=unitOf(x);
  const rawTokenDelta=(rv.assetDeltas??[]).find(d=>d.asset.kind==='KCC20'&&d.amount!==0n)??null;
  const isRefundForOther=p.kusdtAction==='CLAIM_REFUND'&&rv.outputs.some(o=>o.role==='BUYER_REFUND'&&!o.mine);
  const isPayoutSelfForOther=p.kusdtAction==='PAYOUT_SELF'&&rv.outputs.some(o=>o.role==='WINNER'&&!o.mine);
  const winnerOut=p.kusdtAction==='PAYOUT_EXECUTOR'?rv.outputs.find(o=>o.role==='WINNER'&&o.mine&&o.tokenAmount!=null&&o.tokenAmount>0n):undefined;
  const otherTokenOut=rv.outputs.find(o=>!o.mine&&o.tokenAmount!=null&&o.tokenAmount>0n&&(o.role==='WINNER'||o.role==='BUYER_REFUND'))??null;
  const tokenDelta=(isRefundForOther||isPayoutSelfForOther)?null
    :(rawTokenDelta&&winnerOut?{...rawTokenDelta,amount:rawTokenDelta.amount+(winnerOut.tokenAmount??0n)}:rawTokenDelta);
  const depositDelta=(rv.assetDeltas??[]).find(d=>d.asset.kind==='KAS'&&d.role==='REFUNDABLE_DEPOSIT'&&d.amount<0n)??null;
  const authorized=rv.inputs.filter(i=>i.kind.includes('需签名')).reduce((n,i)=>n+i.value,0n);
  const received=rv.outputs.filter(o=>o.mine||(!o.covenant&&o.script===mine)).reduce((n,o)=>n+o.value,0n);
  const net=received-authorized,pay=net<0n;
  const isKusdtTx=!!p.kusdtAction;
  const returnedDeposit=isKusdtTx?rv.outputs.filter(o=>o.rollover&&(o.mine||(!o.covenant&&o.script===mine))&&(o.role==='CREATOR'||o.role==='SHARD_DEPOSIT')).reduce((n,o)=>n+o.value,0n):0n;
  const paidNonRefundable=isKusdtTx?rv.outputs.filter(o=>!o.rollover&&!(o.mine||(!o.covenant&&o.script===mine))&&!['MANAGER','SHARD_DEPOSIT','VAULT_DEPOSIT','FROZEN'].includes(o.role)).reduce((n,o)=>n+o.value,0n):0n;
  const tokenDest: Record<string,string>={
    OPEN_SHARD:'去向：存入新分片金库（中奖后派发给赢家）',
    BUY:'去向：存入已有分片金库（中奖后派发给赢家）',
    PAYOUT_SELF:'来源：分片金库全额奖金 → 归你钱包',
    PAYOUT_EXECUTOR:winnerOut?'来源：分片金库全额奖金（含代推激励）→ 归你钱包':'来源：分片金库代推激励 → 归你钱包',
    CLAIM_REFUND:'来源：分片金库退回票款 → 归你钱包',
  };
  const depositHint=p.kusdtAction==='OPEN_SHARD'?'去向：分片账本 2 + 分片金库 2，本片结清全额退回':'去向：轮次总管合约，结算后全额退回';
  const nonRefundHint=p.kusdtAction==='GENESIS'?'去向：索引登记输出（供列表发现）'
    :(p.kusdtAction==='PAYOUT_EXECUTOR'||p.kusdtAction==='PAYOUT_SELF')?'去向：中奖者代币细胞载体（1.5 KAS）'
    :p.kusdtAction==='CLAIM_REFUND'?'去向：买家退款代币细胞载体（1.5 KAS）'
    :'去向：外部接收方（不可退）';
  const roleLabelFor=(o: typeof rv.outputs[number]): string=>{
    if(o.role==='SHARD_DEPOSIT'&&!o.covenant)return '分片押金退回';
    if(o.role==='SHARD_DEPOSIT'&&o.rollover)return '分片账本（原押金滚存）';
    if(o.role==='VAULT_DEPOSIT'&&p.kusdtAction==='BUY')return '分片金库（存票款）';
    if(o.role==='VAULT_DEPOSIT'&&o.rollover)return '分片金库（原押金滚存）';
    if(o.role==='MANAGER'&&o.rollover)return '轮次状态（原押金滚存）';
    return ROLE_LABEL[o.role]??o.role;
  };
  const renderOut=(o: typeof rv.outputs[number])=>{
    const isMine=!!o.mine||(!o.covenant&&o.script===mine);
    const covLabel=o.role==='TOKEN_CHANGE'?'你的 kUSDT 找零细胞':o.role==='BUYER_REFUND'?'你的 kUSDT 退款细胞':o.role==='WINNER'?'中奖者 kUSDT 细胞':o.role==='EXECUTOR'?'执行者 kUSDT 奖励细胞':'合约（轮次状态）';
    const desc=o.note?o.note:(o.covenant?covLabel:x.ex.addrOfScript(o.script));
    const tok=o.tokenAmount!=null&&o.tokenAmount>0n?html`<span class="out-tok mono">${formatKcc20(o.tokenAmount,o.tokenDecimals??6)} ${o.tokenSymbol??'kUSDT'}</span>`:'';
    return html`<div class="out ${isMine?'mine':''} ${o.rollover&&!isMine?'rollover':''}"><span class="r">${roleLabelFor(o)}${tok}</span>
      <span class="out-addr ${o.note?'out-note':'mono'} small">${desc}${!o.note&&!o.covenant&&isMine?' · 你':''}</span><span class="v">${kas(o.value)} ${u}</span></div>`;
  };
  const userOutputs=rv.outputs.filter(o=>!o.rollover||!!o.mine||(!o.covenant&&o.script===mine));
  const rolloverOutputs=rv.outputs.filter(o=>!!o.rollover&&!(!!o.mine||(!o.covenant&&o.script===mine)));
  const netSign=net===0n?'':(pay?'-':'+');
  return html`<p style="margin:0 0 12px;font-weight:600">${x.planText}</p>
    <div class="confirm-summary">
      ${tokenDelta?html`<div class="sum" style="border-top:0"><span class="sum-label"><span>${tokenDelta.amount<0n?'你的 kUSDT 支出':'你的 kUSDT 到账'}</span>${p.kusdtAction&&tokenDest[p.kusdtAction]?html`<span class="sum-hint">${tokenDest[p.kusdtAction]}</span>`:''}</span><span class="mono" style="font-size:16px;color:${tokenDelta.amount<0n?'var(--text)':'var(--kas-ink)'}">${tokenDelta.amount<0n?'-':'+'}${formatKcc20(tokenDelta.amount<0n?-tokenDelta.amount:tokenDelta.amount,tokenDelta.asset.decimals)} ${tokenDelta.asset.symbol}</span></div>`:''}
      ${otherTokenOut?html`<div class="sum ${tokenDelta?'sum-sub':''}"${tokenDelta?'':html` style="border-top:0"`}><span class="sum-label"><span>${otherTokenOut.role==='WINNER'?'合约派发给中奖者':'合约退回给买家'}</span><span class="sum-hint">${otherTokenOut.role==='WINNER'?'去向：分片金库奖金发给中奖者（非你钱包）':'去向：分片金库票款退回原买家（非你钱包）'}</span></span><span class="mono" style="${tokenDelta?'':'font-size:16px;color:var(--muted)'}">${formatKcc20(otherTokenOut.tokenAmount!,otherTokenOut.tokenDecimals??6)} ${otherTokenOut.tokenSymbol??'kUSDT'}</span></div>`:''}
      <div class="sum"${tokenDelta||otherTokenOut?'':html` style="border-top:0"`}><span class="sum-label"><span>${isKusdtTx?`你的 ${u} 净变动`:(pay?'你将支付（含网络费）':'你预计收到')}</span>${isKusdtTx?html`<span class="sum-hint">仅计算你钱包的实际进出，不含合约原有押金滚存</span>`:''}</span><span class="mono" style="font-size:16px;color:${pay?'var(--text)':'var(--kas-ink)'}">${isKusdtTx?netSign:''}${pay?kas(-net):kas(net)} ${u}</span></div>
      ${depositDelta?html`<div class="sum sum-sub"><span class="sum-label"><span>其中 · 暂锁可退押金</span><span class="sum-hint">${depositHint}</span></span><span class="mono">-${kas(-depositDelta.amount)} ${u}</span></div>`:''}
      ${returnedDeposit>0n?html`<div class="sum sum-sub"><span class="sum-label"><span>其中 · 合约退回押金</span><span class="sum-hint">去向：原路退回你的钱包</span></span><span class="mono" style="color:var(--kas-ink)">+${kas(returnedDeposit)} ${u}</span></div>`:''}
      ${paidNonRefundable>0n?html`<div class="sum sum-sub"><span class="sum-label"><span>其中 · 不可退支出</span><span class="sum-hint">${nonRefundHint}</span></span><span class="mono">-${kas(paidNonRefundable)} ${u}</span></div>`:''}
      <div class="sum ${isKusdtTx?'sum-sub':''}"><span class="sum-label"><span>${isKusdtTx?'其中 · 网络费':'网络费'}</span>${isKusdtTx?html`<span class="sum-hint">去向：矿工手续费（不可退）</span>`:''}</span><span class="mono">${isKusdtTx?'-':''}${kas(rv.fee)} ${u}</span></div>
    </div>
    <details class="adv-details" style="margin-top:12px"><summary class="small muted">查看链上明细（资金去向与技术参数）</summary>
      <div class="adv-body">
        ${rolloverOutputs.length?html`<div class="outs-group">涉及你的资金去向</div>`:''}
        <div class="outs">${userOutputs.map(renderOut)}</div>
        ${rolloverOutputs.length?html`<div class="outs-group">合约原有状态滚存（非你支出，不从你钱包扣除）</div><div class="outs">${rolloverOutputs.map(renderOut)}</div>`:''}
        <dl class="kv" style="margin-top:10px">
          <dt>交易 ID</dt><dd class="mono small">${rv.txid}</dd><dt>费率</dt><dd>${p.feerate} sompi/克（${p.fee} sompi）</dd>
          <dt>mass</dt><dd class="small">compute ${p.mass.computeMass} · transient ${p.mass.transientMass} · storage ${p.mass.storageMass}</dd>
          <dt>输入</dt><dd class="small">${rv.inputs.map((i,idx)=>html`${idx?html`<span>；</span>`:''}#${i.index} ${kas(i.value)} ${u} · <span>${i.kind}</span>`)}</dd></dl>
      </div>
    </details>
    <p class="small muted" style="margin:10px 0 0">点击确认后将在${w?.kind==='extension'?'钱包扩展中授权签名':'本页本地签名'}并提交到链上。</p>`;
}
