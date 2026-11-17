/** Pure views for the rolling page: data in, HTML out. No controller, node, wallet or storage access; every action is a data-* hook
 * that app.mjs binds. Interpolated values are escaped by html``; whether an action is allowed is decided elsewhere (x.gate). */
import {html,raw,ic} from './ui.ts';
import type {Raw} from './ui.ts';
import {ACTION_INFO,ROLE_LABEL,TERMINAL_LABEL,CLOSE_PRESETS,UNIT,errText} from './messages.ts';
import {formatTkas,parseTkas,shortHash,daaDuration} from './format.mjs';
import {TN10_ROLLING_REGISTRY} from '../../scripts/contract/protocol.mjs';
import {addressToSpk,managerBoundUnits,unitsToBudget} from '../app/bridge.ts';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';
import type {Ctx,ConfirmCtx,CreateForm,Detail,DiscoveredRound,Facts,ActionState,Intent,Item,Phase,Receipt,Round,ShardRecordView,ShardStatus,ShardView,VerifyState} from '../app/types.ts';

/** Protocol ceiling for one round: 256 sealed shards x 256 purchases = 65,536 (state.mjs MAX_TICKETS is 10,000,000; the shard limit is what binds). */
export const MAX_TICKET_CAP=65536;
/** Largest round exercised on Testnet 10 so far (4,355 tickets / 17 sealed shards PAID; 771 tickets / 3 sealed shards REFUNDED). */
export const VERIFIED_TICKET_CAP=4355;
export const DEPOSIT_TKAS='4';
const kas=(v: bigint): string=>formatTkas(v);
const signing=(w: Ctx['wallet']): boolean=>!!w&&(w.kind==='key'||w.kind==='extension');
/** Receipt fees come from stored / imported data: a malformed value shows a dash instead of aborting the render. */
const feeText=(v: unknown): string=>{try{return kas(BigInt(v as string));}catch{return '—';}};
const hash=(v: string|null|undefined,{n=10,link=null}: {n?: number;link?: string|null}={}): Raw|string=>v?html`<span class="hash"><span class="mono">${link?html`<a class="hash-link" href="${link}" target="_blank" rel="noopener noreferrer">${shortHash(v,n,6)}</a>`:shortHash(v,n,6)}</span><button class="copy" data-copy="${v}" aria-label="复制" title="复制">${ic('copy')}</button></span>`:'—';
const kpi=(label: string,value: unknown,sub: unknown='')=>html`<div class="kpi"><small>${label}</small><strong>${value}</strong><span>${sub}</span></div>`;
const fact=(k: string,v: unknown): Raw|string=>v==null||v===false?'':html`<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`;
const wait=(daa: bigint|null,until: bigint): string=>daa==null?'需读取节点 DAA':daa>=until?'现在可操作':`约 ${daaDuration(until-daa)} 后`;
const isFree=(a: string): boolean=>!!ACTION_INFO[a]?.free;

/* ------------------------------------------------------------------ explore */
const STEP_TERMINAL: Record<string,string>={PAID:'已派奖 · 奖金见交易输出',EMPTY:'无人购买 · 押金已退回',REFUNDED:'退款完成 · 每条记录扣 0.02 TKAS'};
function stepText(i: Item,x: Ctx): string {
  const {r,f}=i;
  if(r.terminal)return STEP_TERMINAL[r.terminal]??'已结束';
  if(r.halted)return '有交易未能确认，需要核对后重新导入';
  if(r.intent||(r.pending??[]).length)return '交易确认中 · 稍候自动更新';
  if(!r.manager)return '等待创建交易被节点确认';
  const manager=r.manager;
  if(f.module==='sales')return x.daa!=null&&x.daa<f.closeEligibleDaa&&f.tickets<f.ticketCap?`售票中 · ${wait(x.daa,f.closeEligibleDaa)}可封盘`:'任何人可封盘 · 票数够则开奖，不足则退款';
  if(f.module==='sealed')return `已封存 · ${wait(x.daa,manager.utxoDaa+100n)}可开奖`;
  if(f.module==='win')return `派奖中 · 已处理 ${f.payCursor}/${f.shards} 个封存分片`;
  return `退款中 · 封存分片 ${f.refundShard}/${f.shards}`;
}
const CARD_CTA: Record<string,string>={open:'查看并购买',sealed:'查看开奖条件',paying:'查看派奖进度',refund:'查看退款进度'};
const safeBig=(v: string|null|undefined): bigint=>{try{return v!=null?BigInt(v):0n;}catch{return 0n;}};
const INDEXED_TERM_PHASE: Record<string,Phase>={PAID:{key:'paid',label:'已派奖',tone:'gold'},EMPTY:{key:'empty',label:'空轮结束',tone:'muted'},REFUNDED:{key:'refunded',label:'退款完成',tone:'muted'}};
const INDEXED_MOD_PHASE: Record<string,Phase>={sales:{key:'open',label:'售票中',tone:'mint'},sealed:{key:'sealed',label:'待开奖',tone:'violet'},win:{key:'paying',label:'派奖中',tone:'gold'},refund:{key:'refund',label:'退款中',tone:'amber'}};
function indexedPhase(d: DiscoveredRound): Phase {
  if(d.terminal)return INDEXED_TERM_PHASE[d.terminal]??{key:'done',label:TERMINAL_LABEL[d.terminal]??String(d.terminal),tone:'muted'};
  if(d.module&&INDEXED_MOD_PHASE[d.module])return INDEXED_MOD_PHASE[d.module];
  return {key:'open',label:'进行中',tone:'mint'};
}
function indexedStep(d: DiscoveredRound,ph: Phase): string {
  if(d.terminal)return STEP_TERMINAL[d.terminal]??'已结束';
  if(ph.key==='open')return '售票中 · 点击核对当前票数、票价与封盘时间';
  if(ph.key==='sealed')return '已封存 · 达到等待时间后任何人可开奖';
  if(ph.key==='paying')return '派奖中 · 打开查看分片派奖进度';
  if(ph.key==='refund')return '退款中 · 打开查看分片退款进度';
  return '点击由当前节点核对最新状态';
}
function card(i: Item,x: Ctx): Raw {
  const {r,f,ph}=i,price=f.ticketPrice,have=f.tickets!=null,pct=have&&f.ticketCap?Math.min(100,f.tickets/f.ticketCap*100):r.terminal?100:0;
  const cta=CARD_CTA[ph.key]??'查看轮次详情';
  return html`<article class="card t-${ph.tone}" data-open="${r.cid}" tabindex="0" role="button" aria-label="打开轮次 ${shortHash(r.cid)}">
    <div class="row"><span class="badge t-${ph.tone}">${ph.label}</span><span class="tag">${r.source==='imported'?'已同步':'我创建的'}</span></div>
    <div class="mono dim small">CID ${shortHash(r.cid,12,8)}</div>
    <div class="small muted">${r.terminal?'历史票款总额 · 非实际奖金':'票款奖池 · 不含押金'}</div>
    <div class="big">${have?kas(BigInt(f.tickets)*price):'—'}<small>${UNIT}</small></div>
    ${have?html`<div class="bar"><i style="width:${pct}%"></i></div><div class="row small muted"><span>${f.tickets.toLocaleString()} / ${f.ticketCap.toLocaleString()} 张 · ${kas(price)} ${UNIT}/张</span><span>${f.shards>0?`${f.shards} 个封存分片`:''}</span></div>`:html`<div class="small muted">打开查看详情</div>`}
    <div class="card-next">${stepText(i,x)}</div>
    <div class="src">${r.source==='imported'?'本机已同步 · 操作前会向节点核对':'本机记录'}</div>
    <div class="card-cta">${cta} ${ic('arrow')}</div>
  </article>`;
}
function indexedCard(d: DiscoveredRound): Raw {
  const ph=indexedPhase(d),tkt=d.terminal?(d.bought??d.tickets??0):(d.tickets??0),isRest=d.source==='rest';
  const sc=d.shards||(d.terminal&&(d.buys??0)>=256?Math.floor((d.buys??0)/256):0);
  const mval=!d.terminal?safeBig(d.managerValue):0n,cta=CARD_CTA[ph.key]??'查看轮次详情';
  const subParts=[sc>0?`${sc} 个封存分片`:'未满 1 个分片'];
  if(d.buys!=null)subParts.push(`${d.buys.toLocaleString()} 笔购买`);
  return html`<article class="card t-${ph.tone}" data-indexed="${d.cid}" tabindex="0" role="button" aria-label="打开轮次 ${shortHash(d.cid)}">
    <div class="row"><span class="badge t-${ph.tone}">${ph.label}</span><span class="tag">${isRest?'REST 发现':'索引发现'}</span></div>
    <div class="mono dim small">CID ${shortHash(d.cid,12,8)}</div>
    <div class="small muted">${d.terminal?'历史售出票数 · 点击查看详情':isRest?'创世登记摘要 · 点击向节点追赶':'索引摘要 · 点击向节点核对'}</div>
    <div class="big">${tkt.toLocaleString()}<small>张</small></div>
    ${d.terminal?html`<div class="bar"><i style="width:100%"></i></div>`:''}
    <div class="row small muted"><span>${subParts.join(' · ')}</span><span>${mval>0n?`状态锁定 ${kas(mval)} ${UNIT}`:''}</span></div>
    <div class="card-next">${isRest?'点击后由节点 / REST 自动追赶最新进度':indexedStep(d,ph)}</div>
    <div class="src">${isRest?'REST API 发现 · 点击后由节点核对':'索引数据 · 点击后由节点核对'}</div>
    <div class="card-cta">${cta} ${ic('arrow')}</div>
  </article>`;
}
interface ExploreEntry {cid: string;ph: Phase;value: bigint;at: number;item?: Item;disc?: DiscoveredRound}
export function exploreView(x: Ctx): Raw {
  const all=x.items,disc=x.discovered??[],q=x.S.query.trim().toLowerCase();
  const discByCid=new Map(disc.map(d=>[d.cid,d])),localCids=new Set(all.map(i=>i.r.cid));
  const allEntries: ExploreEntry[]=[
    ...all.map(i=>({cid:i.r.cid,ph:i.ph,value:i.value,at:Math.max(i.at,discByCid.get(i.r.cid)?.updatedAt??0),item:i})),
    ...disc.filter(d=>!localCids.has(d.cid)).map(d=>{const ph=indexedPhase(d);return {cid:d.cid,ph,value:d.terminal?0n:safeBig(d.managerValue),at:d.updatedAt??0,disc:d};}),
  ];
  const isOther=(e: ExploreEntry)=>e.item?(!e.item.f.module&&!e.item.r.terminal):(!!e.disc?.module&&!['sales','sealed','win','refund'].includes(String(e.disc.module)));
  const entries=allEntries.filter(e=>!isOther(e)),otherEntries=allEntries.filter(isOther);
  const is=(e: ExploreEntry,...k: string[])=>k.includes(e.ph.key);
  const saved=x.saved??new Set<string>();
  const g: Record<string,number>={all:entries.length,open:entries.filter(e=>is(e,'open')).length,sealed:entries.filter(e=>is(e,'sealed')).length,
    settle:entries.filter(e=>is(e,'paying','refund')).length,done:entries.filter(e=>is(e,'paid','empty','refunded','done')).length,
    saved:entries.filter(e=>saved.has(e.cid)).length};
  const paid=entries.filter(e=>is(e,'paid')).length;
  const locked=entries.reduce((n: bigint,e)=>n+e.value,0n);
  const list=entries.filter(e=>{
    const f=x.S.filter;if(f==='open'&&!is(e,'open'))return false;if(f==='sealed'&&!is(e,'sealed'))return false;
    if(f==='settle'&&!is(e,'paying','refund'))return false;if(f==='done'&&!is(e,'paid','empty','refunded','done'))return false;
    if(f==='saved'&&!saved.has(e.cid))return false;
    return !q||e.cid.includes(q);
  }).sort((a,b)=>x.S.sort==='value'?(b.value>a.value?1:b.value<a.value?-1:b.at-a.at):b.at-a.at);
  const filteredOther=otherEntries.filter(e=>!q||e.cid.includes(q));
  const seg: [string,string][]=[['all','全部'],['open','售票中'],['sealed','待开奖'],['settle','派奖/退款'],['done','已结束'],['saved','★ 关注']];
  const isRest=x.conn.discoveredSource==='rest';
  const sourceNotice=isRest
    ?html`<div class="source-strip"><span class="dot"></span><span>${x.conn.indexerStale?'索引暂不可用，已切换为 REST API 备用查询':'未连接索引，已使用 REST API 备用查询'}（共 ${disc.length} 轮，本机已核对 ${all.length} 轮）· <b>点进轮次后会自动向节点 / REST 追赶最新状态</b></span></div>`
    :x.conn.indexerStale
      ?html`<div class="notice warn">索引正在追赶最新链状态，列表可能暂未包含刚确认的轮次；点击任意轮次仍会向当前节点核对。</div>`
      :x.conn.indexer
        ?html`<div class="source-strip"><span class="dot ok"></span><span>已连接只读索引（共 ${disc.length} 轮，其中本机已核对 ${all.length} 轮）· <b>点击任意轮次会再由节点核对并追赶最新进度</b></span></div>`
        :'';
  return html`
  <section class="hero">
    <div>
      <h1>参与一轮，<em>看清每一步。</em></h1>
      <p>选择轮次、核对票款与费用，再确认交易。售票、开奖、派奖与退款由固定合约约束，购买笔数不受 256 笔限制。使用 ${UNIT} 测试币。</p>
      <div class="hero-actions"><button class="btn pri" data-go2="create">${ic('create')}创建轮次</button><button class="btn ghost" data-go2="protocol">${ic('shield')}规则说明</button></div>
    </div>
    <div class="flow"><span class="eyebrow">HOW IT WORKS</span><h3>从买票到结算，去向清楚</h3><ol>
      <li><span class="n">01</span><div><b>选轮次 · 买票</b><span>票价、剩余票数、最低开奖门槛先看清</span></div></li>
      <li><span class="n">02</span><div><b>封盘 · 确定下一步</b><span>达到门槛可开奖；不足则分批退款</span></div></li>
      <li><span class="n">03</span><div><b>链上开奖 · 直接到账</b><span>任何人可推进，付款输出可逐项核对</span></div></li>
    </ol></div>
  </section>
  <div class="section-title"><h2>轮次广场</h2><span class="muted small">当前数据源中的已知轮次 · 非全网统计</span></div>
  <section class="kpis">
    ${kpi('已知轮次',entries.length,isRest?`REST 备用 ${disc.length} · 本机 ${all.length}`:x.conn.indexer?`索引 ${disc.length} · 本机 ${all.length}`:`本机创建 ${all.filter(i=>i.r.source!=='imported').length} · 导入 ${all.filter(i=>i.r.source==='imported').length}`)}
    ${kpi('售票中',g.open,'可购买 / 可封盘')}
    ${kpi('待开奖 / 结算中',`${g.sealed} / ${g.settle}`,'任何人可推进')}
    ${kpi('已派奖轮次',paid,`共 ${g.done} 轮已结束`)}
    ${kpi('锁定价值',kas(locked),`${UNIT} · 进行中的轮次`)}
  </section>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="筛选">${seg.map(([k,l])=>html`<button data-filter="${k}" aria-pressed="${x.S.filter===k}">${l}<span class="c">${g[k]}</span></button>`)}</div>
    <label class="search">${ic('search')}<input id="q" placeholder="搜索 CID" value="${x.S.query}" autocomplete="off" spellcheck="false"></label>
    <div class="seg"><button data-sort="new" aria-pressed="${x.S.sort==='new'}">最近</button><button data-sort="value" aria-pressed="${x.S.sort==='value'}">锁定价值</button></div>
    ${x.conn.indexer||isRest||x.conn.node?html`<button class="icon-btn" data-act="refreshIndex" aria-label="刷新列表" title="刷新轮次列表（索引 / REST 备用）">${ic('refresh')}</button>`:''}
    ${x.indexerMore?html`<button class="btn sm" data-act="moreIndex">加载更多</button>`:''}
    ${otherEntries.length?html`<details class="other-rounds-details">
      <summary class="btn ghost sm" title="查看无法按当前固定 Profile 解析的轮次">${ic('archive')}<span>不适用轮次 (${otherEntries.length})</span></summary>
      <div class="panel" style="margin-top:12px;background:var(--panel2);border:1px dashed var(--line2)">
        <p class="small muted" style="margin-top:0">以下轮次无法按当前固定 Profile 解析，页面不提供操作。</p>
        <div class="grid">${filteredOther.map(e=>e.item?card(e.item,x):indexedCard(e.disc!))}</div>
      </div>
    </details>`:''}
  </div>
  ${sourceNotice}
  <div class="grid">${list.length?list.map(e=>e.item?card(e.item,x):indexedCard(e.disc!)):html`<div class="empty">${ic('ticket')}<p>${entries.length?'当前筛选下没有轮次。':'还没有轮次。'}你可以<button class="link" data-go2="create">创建一个新轮次</button>，或在下方粘贴分享链接 / CID 加入。</p></div>`}</div>
  <div class="panel join" style="margin-top:22px">
    <div><h3>${ic('download')} 加入轮次</h3><p class="sub">粘贴分享链接，或直接输入 CID / 交易 ID（页面将按 索引 → 节点 → REST API 顺序核对并追赶最新进度）。</p></div>
    <div class="joinrow"><input id="joinText" value="${x.S.join}" placeholder="分享链接、轮次数据、CID 或交易 ID" autocomplete="off" spellcheck="false" aria-label="分享链接或轮次 ID"><button class="btn pri" data-act="join">加入</button></div>
  </div>`;
}

/* ------------------------------------------------------------------ create */
export interface CreateParse {ok: boolean;errors: string[];price: bigint|null;cap: number;min: number;mins: number;registry: boolean|string;registryAddr: string;isCustomRegistry: boolean}
export function parseCreate(form: CreateForm): CreateParse {
  const useReg=form.registry!==false;
  const rawAddr=(form.registryAddr??'').trim().toLowerCase();
  const regAddr=rawAddr||TN10_ROLLING_REGISTRY.address;
  const isCustomRegistry=useReg&&regAddr!==TN10_ROLLING_REGISTRY.address;
  let registry: boolean|string=false,regValid=true;
  if(useReg){
    try{addressToSpk(regAddr,'kaspatest');registry=regAddr===TN10_ROLLING_REGISTRY.address?true:regAddr;}
    catch{regValid=false;}
  }
  try {
    const price=parseTkas(form.price),cap=/^[0-9]{1,7}$/.test(form.cap)?Number(form.cap):NaN,min=/^[0-9]{1,7}$/.test(form.min)?Number(form.min):NaN;
    const mins=form.dur==='custom'?(/^[0-9]{1,5}$/.test(form.custom)?Number(form.custom):NaN):Number(form.dur);
    const errors: string[]=[];
    if(price<100000000n)errors.push('票价至少 1 TKAS');
    if(!(cap>=3&&cap<=MAX_TICKET_CAP))errors.push(`票数上限需在 3 – ${MAX_TICKET_CAP.toLocaleString()} 之间`);
    if(!(min>=3&&min<=cap))errors.push('最低票数需 ≥ 3 且不超过票数上限');
    if(!(mins>=1&&mins<=10080))errors.push('封盘等待时间需在 1 分钟 – 7 天之间');
    if(useReg&&!regValid)errors.push('登记地址无效：需要是 Testnet 10（kaspatest:）的 Schnorr P2PK 或 P2SH 地址');
    return {ok:!errors.length,errors,price,cap,min,mins,registry,registryAddr:regAddr,isCustomRegistry};
  } catch {return {ok:false,errors:['票价格式不正确（最多 8 位小数）'],price:null,cap:NaN,min:NaN,mins:NaN,registry:false,registryAddr:regAddr,isCustomRegistry};}
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
  const f=x.S.form,p=parseCreate(f),good=p.price!=null&&p.cap>=3&&p.cap<=MAX_TICKET_CAP,shards=good?Math.ceil(p.cap/256):0,over=good&&p.cap>VERIFIED_TICKET_CAP;
  const pool=p.price!=null&&good?BigInt(p.cap)*p.price:null,dur=p.mins>=1?daaDuration(BigInt(p.mins)*600n):'—';
  const useReg=f.registry!==false,regVal=f.registryAddr!==undefined?f.registryAddr:TN10_ROLLING_REGISTRY.address;
  return html`
  <div class="cols">
    <div class="panel">
      <h2>${ic('create')} 创建一个新轮次</h2>
      <p class="sub">填写规则 → 查看完整费用 → 确认后提交。现在填写不会扣款，创建后的规则不可更改。</p>
      <div class="form">
        <label class="field">每张票价格（${UNIT}）<input id="cPrice" value="${f.price}" inputmode="decimal" maxlength="20"><small>≥ 1 ${UNIT}，最多 8 位小数</small></label>
        <label class="field">总票数上限<input id="cCap" value="${f.cap}" inputmode="numeric" maxlength="7"><small>3 – ${MAX_TICKET_CAP.toLocaleString()}</small></label>
        <label class="field">开奖最低票数<input id="cMin" value="${f.min}" inputmode="numeric" maxlength="7"><small>≥ 3；封盘时不足则全部退款</small></label>
        <div class="field full">最早可封盘时间<div class="pills">${CLOSE_PRESETS.map(([k,l])=>html`<button type="button" data-dur="${k}" aria-pressed="${f.dur===k}">${l}</button>`)}</div>
          ${f.dur==='custom'?html`<input id="cCustom" value="${f.custom}" inputmode="numeric" maxlength="5" placeholder="分钟（1 – 10080）">`:''}
          <small>时间到了才“允许”封盘，不会自动封盘；票卖满时可提前封盘。按约 10 DAA/秒换算，创建时读取当前 DAA。</small></div>
        <label class="check full"><input type="checkbox" id="cReg" ${useReg?'checked':''}>附加 0.2 ${UNIT} Registry 登记输出（供索引自动发现本轮）</label>
        <label class="field full" id="cRegBox" ${useReg?'':'hidden'}>登记地址<input id="cRegAddr" value="${regVal}" spellcheck="false" autocomplete="off" placeholder="${TN10_ROLLING_REGISTRY.address}">
          <small>默认是 Kaswin 登记地址（留空即默认）。仅支持 Testnet 10 的 Schnorr P2PK 或 P2SH 地址；0.2 ${UNIT} 付给该地址，不可撤回。</small>
          ${p.isCustomRegistry?html`<small class="why">已改为非默认地址：默认 Indexer 与 REST 只扫描默认登记地址，本轮不会被它们自动发现，只能由监听该地址的索引收录。</small>`:''}</label>
      </div>
      ${p.ok?'':html`<p class="err">${p.errors[0]}</p>`}
      ${over?html`<div class="notice warn" style="margin-top:12px"><b>超出已验证范围。</b>Testnet 10 上目前实测到 ${VERIFIED_TICKET_CAP.toLocaleString()} 张（17 个封存分片）的完整派奖与 771 张（3 个封存分片）的批量退款；${p.cap.toLocaleString()} 张最多会产生约 ${shards} 个封存分片，更大规模的多分片路径尚未经实链验证。仅限测试币。</div>`:html`<div class="notice" style="margin-top:12px">Testnet 10 上已实测到 ${VERIFIED_TICKET_CAP.toLocaleString()} 张（17 个封存分片）的完整派奖与 771 张（3 个封存分片）的批量退款。</div>`}
      ${createCta(x,p.ok)}
    </div>
    <div>
      <div class="panel"><h3>预览</h3><div class="facts">
        ${fact('售满时的票款',pool==null?'—':`${kas(pool)} ${UNIT}`)}
        ${fact('每张票中奖概率（售满）',good?`1 / ${p.cap.toLocaleString()}`:'—')}
        ${fact('最早封盘',`约 ${dur} 后`)}
        ${fact('封存分片',good?`最多约 ${shards} 个（每 256 笔购买封存一个）`:'—')}
        ${fact('执行者奖励',good?`约 ${shards} ${UNIT}（每个分片 1 ${UNIT}，从奖池扣）`:'—')}
        ${fact(`低于 ${Number.isFinite(p.min)?p.min:'最低'} 张`,'全部退款，每条购买记录扣 0.02 TKAS 执行费')}
      </div></div>
      <div class="panel"><h3>你需要付出</h3><dl class="kv">
        <dt>押金</dt><dd>${DEPOSIT_TKAS} ${UNIT}（派奖或无人购买时全额退回；全部退款完成时退回 3.98）</dd>
        <dt>登记输出</dt><dd>${useReg?`0.2 ${UNIT}（可选，转入上方填写的登记地址）`:`不附加（不进入公共索引，仅可通过分享链接加入）`}</dd>
        <dt>网络费</dt><dd>确认前按节点实时费率报价（通常不到 0.1 ${UNIT}）</dd>
        <dt>钱包至少</dt><dd>约 ${useReg?'4.5':'4.3'} ${UNIT}${signing(x.wallet)&&x.balance!=null?html` <span class="muted">（当前余额 ${kas(x.balance)} ${UNIT}）</span>`:''}</dd>
      </dl><p class="sub" style="margin:12px 0 0">创建者没有特权：任何人都可以封盘、开奖、派奖、退款。创建者只在最后取回押金。</p></div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ round detail */
const STEPS_NORMAL=['创建 · 售票','封盘 · 待开奖','派奖','完成'],STEPS_REFUND=['创建 · 售票','封盘','退款','完成'];
function stepper(D: Detail): Raw {
  const {r,f}=D,refund=f.module==='refund'||r.terminal==='REFUNDED',labels=refund?STEPS_REFUND:STEPS_NORMAL;
  const pos=r.terminal?4:f.module==='sealed'?1:f.module==='win'||f.module==='refund'?2:0;
  return html`<div class="stepper">${labels.map((l,i)=>html`<div class="step ${i<pos?'done':i===pos?'now':''} ${refund&&i>=2?'alt':''}"><div class="b">${i<pos?'✓':i+1}</div>${l}</div>`)}</div>`;
}
const HINT_TERMINAL: Record<string,string>={PAID:'奖金已付给中奖者，押金已退回创建者。',EMPTY:'无人购买，押金已退回创建者。',REFUNDED:'所有购买记录已退款，每条扣 0.02 TKAS 执行费。'};
const HINT_MODULE: Record<string,string>={sales:'售票中。时间到后任何人可封盘；票卖满也可提前封盘。',sealed:'已封存，等待开奖。开奖由链上数据决定，任何人无法挑选。',
  win:'已开奖，正在派奖。任何人都可以推进，无需签名。',refund:'票数不足，正在分批退款。任何人都可以推进，无需签名。'};
function nextHint(D: Detail): string {
  const {r,f}=D;
  if(r.terminal)return HINT_TERMINAL[r.terminal]??'';
  if(r.halted)return `这一轮已停止（${r.halted}）：有交易既没有被确认也不在内存池。请核对后让对方发最新分享链接重新导入。`;
  if(r.intent)return '有一笔交易还在等待确认，期间不能发起新的操作。';
  return HINT_MODULE[f.module??'']??'';
}
function actionCard(a: string,D: Detail,x: Ctx): Raw|'' {
  const {f}=D,s: ActionState=D.a[a]??{ok:false,reason:'不可用'},info=ACTION_INFO[a];
  if(!info)return '';
  const g=x.gate(a);
  if(!s.ok&&/不适用|没有旧分片|不满足/.test(s.reason??''))return '';
  const waiting=!s.ok;
  const extra=a==='BUY'?html`<div class="qtyrow"><label class="field">数量<input id="qty" value="${x.S.qty}" inputmode="numeric" maxlength="6"></label>
    <div class="pills">${[1,5,10].map(n=>html`<button type="button" data-qty="${n}">${n}</button>`)}</div></div>
    <p class="small muted" id="qtyCost">${qtyCost(x.S.qty,f,s)}</p>`:'';
  const label=x.busy?'处理中…':waiting?'暂不可用':g.ok?info.verb:g.fix==='wallet'?'连接钱包':g.fix==='settings'?'检查连接':'暂不可用';
  const attr=x.busy?'disabled aria-busy="true"':waiting?'disabled':g.ok?`data-act="${a}"`:g.fix?`data-fix="${g.fix}"`:'disabled';
  return html`<div class="act ${waiting||x.busy?'off':''}"><h4>${info.title}</h4><p>${info.desc}</p>
    <div class="small muted">${isFree(a)?'无需签名 · 只需一个收款地址领取奖励':'需要钱包付手续费 / 票款'}</div>${extra}
    ${x.busy?html`<div class="why" role="status">${g.reason??'正在处理上一步，请稍候。'}</div>`:waiting?html`<div class="why">${s.reason}</div>`:g.ok?'':html`<div class="why">${g.reason}</div>`}
    <button class="btn ${g.ok&&!waiting?'pri':''} block" ${raw(attr)}>${label}</button></div>`;
}
export function qtyCost(text: string,f: Facts,s?: ActionState): string {
  try {
    if(!/^[1-9][0-9]{0,6}$/.test(String(text).trim()))return '请输入要购买的张数';
    const n=Number(text),max=s?.maxQuantity??Infinity;
    if(n>max)return `最多还能买 ${max} 张`;
    return `${n} 张 × ${kas(f.ticketPrice)} = ${kas(BigInt(n)*f.ticketPrice)} ${UNIT}，另付网络费（确认前报价）`;
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
  const rejected=i.status==='REJECTED',canDiscard=['REJECTED','UNSENT','SUBMITTED','UNKNOWN','PREPARED'].includes(i.status),busy=x.busy;
  return html`<div class="notice ${rejected?'bad':'warn'}"><b>${rejected?'这笔交易被节点拒绝':'有一笔交易正在等待确认'}</b>：${ACTION_INFO[i.action]?.title??i.action}
    ${rejected?rejectionHelp(i,x):html`。页面会自动查询结果；你也可以手动刷新。<b>不要重复发起同样的操作</b>，需要重发时只会使用原来的签名。`}
    <div class="btnrow">
      ${rejected?'':html`<button class="btn sm" data-act="track" ${busy?'disabled':''}>刷新状态</button><button class="btn sm" data-act="recover" ${busy?'disabled':''}>重新发送（原签名）</button>`}
      ${canDiscard?html`<button class="btn sm warn" data-act="discard" ${busy?'disabled':''}>放弃这笔</button>`:''}
    </div></div>`;
}
function verifyPanel(v: VerifyState|null): Raw|'' {
  if(!v)return '';
  if(v.state==='checking')return html`<div class="notice">正在向节点核对这一轮的链上状态…</div>`;
  if(v.state==='ok')return html`<div class="notice ok">已向节点核对（${new Date(v.at??0).toLocaleTimeString()}）：本机记录与链上状态一致。</div>`;
  return html`<div class="notice bad"><b>与链上状态不一致</b>：${errText(v.code??'')}</div>`;
}
function txTable(D: Detail,x: Ctx): Raw {
  const r=D.r,hasShards=!!(D.shards&&D.shards.length);
  if(!r.receipts.length)return html`<p class="muted small">还没有已确认的交易。</p>`;
  // Confirmed BUY receipts (and confirmed REFUND_OLD/REFUND_SELF when shard dot-map is present) are represented per-shard/purchase above.
  const list=r.receipts.filter(t=>{
    if(t.finalized===false)return true;
    if(t.action==='BUY')return false;
    if(hasShards&&(t.action==='REFUND_OLD'||t.action==='REFUND_SELF'))return false;
    return true;
  });
  const omittedBuys=r.receipts.filter(t=>t.action==='BUY'&&t.finalized!==false).length;
  const omittedRefunds=hasShards?r.receipts.filter(t=>(t.action==='REFUND_OLD'||t.action==='REFUND_SELF')&&t.finalized!==false).length:0;
  const omittedParts=[omittedBuys>0?`${omittedBuys.toLocaleString()} 笔已确认购买交易`:'',omittedRefunds>0?`${omittedRefunds.toLocaleString()} 笔已确认退款交易`:''].filter(Boolean);
  if(!list.length)return html`<p class="muted small">共 ${omittedParts.join('、')}，请在上方分片点图中查看；尚无封盘、开奖或结算交易。</p>`;
  const limit=x.S.txLimit??20,total=list.length,shown=list.slice(Math.max(0,total-limit)).reverse();
  return html`<div class="tablewrap"><table><tr><th>步骤</th><th>交易</th><th>状态</th><th>网络费</th></tr>${shown.map(t=>html`<tr>
    <td>${ACTION_INFO[t.action]?.title??t.action}</td><td>${hash(t.txid,{n:8,link:x.ex.tx(t.txid)})}</td>
    <td>${t.finalized===false?html`<span class="badge t-violet">确认中</span>`:html`<span class="badge t-mint">已接受</span>`}</td><td class="mono">${feeText(t.feeSompi)}</td></tr>`)}</table></div>
    ${total>shown.length?html`<div class="btnrow"><span class="small muted">已显示最近 ${shown.length} / ${total.toLocaleString()} 笔阶段交易</span><button type="button" class="btn sm" data-moretx="100">再加载 100 笔</button><button type="button" class="btn sm" data-moretx="all">显示全部</button></div>`:''}
    ${omittedParts.length?html`<p class="small muted" style="margin-top:8px">已省略 ${omittedParts.join('、')}（请在上方分片点图按片查看）。</p>`:''}
    ${r.pending?.length?html`<p class="small muted" style="margin-top:8px">“确认中”表示已进入节点选中链；满约 100 DAA（约 10 秒）后页面会自动复核，浅层重组时同一笔交易通常会在别的区块重新被接受。</p>`:''}`;
}
const DOT_COLORS=['#49eacb','#60a5fa','#a78bfa','#f472b6','#f59e0b','#34d399','#f87171','#22d3ee','#c084fc','#fbbf24','#4ade80','#fb7185'];
const SHARD_META: Record<ShardStatus,{label: string;tone: string;color: string}>={
  active:{label:'当前分片',tone:'t-mint',color:'var(--kas)'},
  frozen:{label:'已封存',tone:'t-violet',color:'var(--sky)'},
  refunding:{label:'退款中',tone:'t-amber',color:'var(--amber)'},
  settled:{label:'已派奖',tone:'t-mint',color:'var(--sky)'},
  refunded:{label:'已退款',tone:'t-muted',color:'var(--violet)'},
};
const rangeText=(start: number,end: number): string=>start===end?`${start}`:`${start}–${end}`;
function makeKeyColor(recs: ShardRecordView[]): (k: string)=>string {
  const m=new Map<string,string>();
  return k=>{let c=m.get(k);if(!c){c=DOT_COLORS[m.size%DOT_COLORS.length] as string;m.set(k,c);}return c;};
}
function buyReceiptFor(sh: ShardView,rec: ShardRecordView,D: Detail): Receipt|null {
  const shards=D.shards;if(!shards)return null;
  const buys=D.r.receipts.filter(t=>t.action==='BUY');
  let offset=0,total=0;
  for(const s of shards){
    if(s.recordCount==null)return null;
    if(s.index===sh.index)offset=total;
    total+=s.recordCount;
  }
  if(buys.length!==total)return null;
  return buys[offset+rec.index]??null;
}
const frozenBatchesOf=(s: ShardView): number=>Math.ceil((s.recordCount??256)/32);
function expectedRefundOldCount(D: Detail,frozenShards: ShardView[]): number {
  let n=0;
  for(const s of frozenShards){
    if(s.status==='refunded')n+=frozenBatchesOf(s);
    else if(s.status==='refunding')n+=Math.floor(s.refundedRecords/32);
  }
  return n;
}
function refundReceiptFor(sh: ShardView,rec: ShardRecordView,D: Detail): Receipt|null {
  if(!rec.refunded||!D.shards)return null;
  const frozenShards=D.shards.filter(s=>s.kind==='frozen');
  const refundOlds=D.r.receipts.filter(t=>t.action==='REFUND_OLD');
  const expectedOld=expectedRefundOldCount(D,frozenShards);
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
  const refundSelfs=D.r.receipts.filter(t=>t.action==='REFUND_SELF');
  const expectedSelf=sh.status==='refunded'?Math.ceil(activeCount/32):sh.status==='refunding'?Math.floor(sh.refundedRecords/32):0;
  if(refundSelfs.length!==expectedSelf)return null;
  return refundSelfs[Math.floor(rec.index/32)]??null;
}
function shardRefundReceipts(sh: ShardView,D: Detail): Receipt[] {
  if(!D.shards)return [];
  const frozenShards=D.shards.filter(s=>s.kind==='frozen');
  const refundOlds=D.r.receipts.filter(t=>t.action==='REFUND_OLD');
  const expectedOld=expectedRefundOldCount(D,frozenShards);
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
  if(!rec)return html`<div class="matrix-tip"><div class="tip-placeholder">${ic('search')}<span>点击分片内任意方格查看该笔购买的票号、买家、购买${sh.status==='refunded'||sh.status==='refunding'?'与退款':''}交易（本分片共 ${sh.records?.length??0} 笔）</span></div></div>`;
  const addr=x.ex.addrOfKey(rec.key)??rec.key,draw=D.r.draw??null;
  const isWin=!!draw&&draw.shard===sh.index&&draw.record===rec.index;
  const buyRc=buyReceiptFor(sh,rec,D);
  const refundRc=rec.refunded?refundReceiptFor(sh,rec,D):null;
  const badge=isWin?html`<span class="badge t-gold">🏆 中奖记录（中奖票 #${draw.ticket+1}）</span>`:rec.refunded?html`<span class="badge t-muted">已退款</span>`:html`<span class="badge t-mint">第 ${rec.index+1} 笔购买</span>`;
  return html`<div class="matrix-tip">
    <div class="tip-head">${badge}<strong>票号 #${rangeText(rec.startTicket,rec.endTicket)}</strong><span class="tag">${rec.count.toLocaleString()} 张</span>
      <span class="muted">${kas(BigInt(rec.count)*D.f.ticketPrice)} ${UNIT}</span><span class="spacer"></span>${rec.mine?html`<span class="tag kas">我</span>`:''}</div>
    <div class="tip-body"><span>买家：${hash(addr,{n:10,link:x.ex.addr(addr)})}</span>
      <span>购买交易：${buyRc?html`${hash(buyRc.txid,{n:10,link:x.ex.tx(buyRc.txid)})} <span class="dim">(${buyRc.finalized===false?'确认中':'已接受'} · 网络费 ${feeText(buyRc.feeSompi)} ${UNIT})</span>`:html`<span class="muted">本机未保留完整购买交易索引</span>`}</span>
      ${rec.refunded?html`<span>退款交易：${refundRc?html`${hash(refundRc.txid,{n:10,link:x.ex.tx(refundRc.txid)})} <span class="dim">(${refundRc.finalized===false?'确认中':'已接受'} · 网络费 ${feeText(refundRc.feeSompi)} ${UNIT})</span>`:html`<span class="muted">本机未保留完整退款交易索引</span>`}</span>`:''}
    </div>
  </div>`;
}
function selectedShardPanel(sh: ShardView,D: Detail,x: Ctx): Raw {
  const meta=SHARD_META[sh.status],recs=sh.records,draw=D.r.draw??null;
  const header=html`<div class="shard-head"><span class="badge ${meta.tone}">${meta.label}</span>
    <h4>${sh.kind==='active'?'当前分片':`封存分片 #${sh.index+1}`}</h4>
    <span class="small muted">票号 #${rangeText(sh.startTicket,sh.endTicket)} · ${sh.tickets.toLocaleString()} 张${recs?` · ${recs.length} 笔购买`:''}</span>
    ${sh.mineCount>0?html`<span class="tag kas">我持有 ${sh.mineCount.toLocaleString()} 张</span>`:''}<span class="spacer"></span>
    <button type="button" class="btn sm" data-shard="close">收起分片</button></div>`;
  if(recs===null){
    const shardRefunds=sh.status==='refunded'||sh.status==='refunding'?shardRefundReceipts(sh,D):[];
    return html`<div class="shard-detail">${header}
      <p class="muted small">该分片已完成${sh.status==='refunded'?'退款':'派奖'}并被合约回收，链上 UTXO 不再保留逐笔明文记录（共 ${sh.tickets.toLocaleString()} 张票${sh.hash?html`，分片哈希 <span class="mono">${shortHash(sh.hash,10,6)}</span>`:''}）。</p>
      ${shardRefunds.length?html`<div class="tip-body" style="margin-top:6px"><span>退款交易（${shardRefunds.length} 批）：${shardRefunds.map(t=>hash(t.txid,{n:8,link:x.ex.tx(t.txid)}))}</span></div>`:''}</div>`;
  }
  if(!recs.length)return html`<div class="shard-detail">${header}<p class="muted small">这个分片还没有购买记录。</p></div>`;
  const addrCache=new Map<string,string>();
  const addrOf=(k: string): string=>{let a=addrCache.get(k);if(!a){a=x.ex.addrOfKey(k)??k;addrCache.set(k,a);}return a;};
  const colorOf=makeKeyColor(recs),selIdx=x.S.purchase??null,selRec=selIdx!=null?recs.find(r=>r.index===selIdx)??null:null;
  const cells=recs.map(rec=>{
    const isWin=!!draw&&draw.shard===sh.index&&draw.record===rec.index,isSel=selIdx===rec.index,addr=addrOf(rec.key);
    const range=rangeText(rec.startTicket,rec.endTicket),st=isWin?` · 🏆 中奖票 #${draw.ticket+1}`:rec.refunded?' · 已退款':'';
    const title=`第 ${rec.index+1} 笔 · 票号 #${range} (${rec.count} 张) · 买家 ${shortHash(addr,8,6)}${rec.mine?' (我)':''}${st}`;
    return html`<button type="button" class="cell${isWin?' w':''}${rec.mine?' me':''}${rec.refunded?' refunded':''}${isSel?' active':''}" style="--c:${colorOf(rec.key)}" data-purchase="${rec.index}" aria-pressed="${isSel}" aria-label="第 ${rec.index+1} 笔购买" title="${title}">${isWin?'🏆':rec.index+1}</button>`;
  });
  const owners=[...new Set(recs.map(r=>r.key))];
  const legend=html`<div class="legend">${owners.slice(0,8).map(k=>{
    const addr=addrOf(k),cnt=recs.filter(r=>r.key===k).reduce((n,r)=>n+r.count,0);
    return html`<span><i style="--c:${colorOf(k)}"></i><span class="mono">${shortHash(addr,10,4)}</span> ${cnt.toLocaleString()} 张</span>`;
  })}${owners.length>8?html`<span>…共 ${owners.length} 位买家</span>`:''}${draw&&draw.shard===sh.index?html`<span><i style="--c:var(--gold)"></i>中奖票 #${draw.ticket+1}（第 ${draw.record+1} 笔）</span>`:''}</div>`;
  return html`<div class="shard-detail">${header}
    <div class="matrix" role="region" aria-label="分片购买点图">${cells}</div>
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
  const cells=shards.map(sh=>{
    const meta=SHARD_META[sh.status],isSel=sel?.index===sh.index,done=sh.records===null,isWinShard=!!draw&&draw.shard===sh.index;
    const title=`分片 #${sh.index+1}（${meta.label}）· 票号 #${rangeText(sh.startTicket,sh.endTicket)}（${sh.tickets.toLocaleString()} 张${sh.recordCount!=null?` / ${sh.recordCount} 笔`:''}）${isWinShard?` · 🏆 含中奖票 #${draw.ticket+1}`:''}${sh.mineCount>0?` · 我持有 ${sh.mineCount} 张`:''}`;
    return html`<button type="button" class="cell${isWinShard?' w':''}${done?' done':''}${sh.mineCount>0?' me':''}${isSel?' active':''}" style="--c:${done?'var(--panel3)':meta.color}" data-shard="${sh.index}" aria-pressed="${isSel}" aria-label="分片 ${sh.index+1}" title="${title}">${isWinShard?'🏆':sh.index+1}</button>`;
  });
  const legend=html`<div class="legend">
    ${counts.active?html`<span><i style="--c:${r.terminal?'var(--sky)':'var(--kas)'}"></i>${r.terminal?'尾部分片':'当前分片'}</span>`:''}
    ${counts.frozen?html`<span><i style="--c:var(--sky)"></i>${r.terminal==='PAID'?'历史封存（已派奖）':r.terminal==='REFUNDED'?'历史封存（已退款）':'已封存'} (${counts.frozen})</span>`:''}
    ${counts.refunding?html`<span><i style="--c:var(--amber)"></i>退款中</span>`:''}
    ${counts.done?html`<span><i style="--c:var(--panel3);border:1px solid var(--line2)"></i>已回收（无逐笔记录）</span>`:''}
    ${counts.mine?html`<span><i style="--c:var(--kas);box-shadow:inset 0 0 0 1px #fff"></i>含我的票</span>`:''}
    ${draw?html`<span><i style="--c:var(--gold)"></i>中奖分片 #${draw.shard+1}（中奖票 #${draw.ticket+1}）</span>`:''}
  </div>`;
  return html`<p class="small muted" style="margin:0 0 8px">${r.terminal?`本轮已结束（${TERMINAL_LABEL[r.terminal]??r.terminal}），`:''}共 ${shards.length} 个分片（封存 ${counts.frozen} 个${counts.active?` · ${r.terminal?'尾部':'当前'} 1 个`:''}），总计 ${f.tickets.toLocaleString()} 张票。点击任意分片点图查看该分片内的购买记录。</p>
    <div class="matrix shards" role="region" aria-label="分片分布">${cells}</div>
    ${legend}
    ${sel?selectedShardPanel(sel,D,x):html`<div class="matrix-tip"><div class="tip-placeholder">${ic('search')}<span>点击上方任意分片方格，查看该分片的购买点图与明细（每片最多 256 笔）</span></div></div>`}`;
}
const ORDER: Record<string,string[]>={sales:['BUY','CLOSE'],sealed:['DRAW','TIMEOUT'],win:['PAY_OLD','PAY_SELF'],refund:['REFUND_OLD','REFUND_SELF']};
export function roundView(x: Ctx): Raw {
  const D=x.detail;
  if(!D){
    if(x.verify?.state==='checking')return html`<div class="empty"><p>正在通过索引、节点与 REST API 同步轮次最新状态…</p></div>`;
    return html`<div class="empty">没有找到这一轮。<button class="link" data-go2="explore">返回轮次列表</button></div>`;
  }
  const {r,f,ph}=D,price=f.ticketPrice,open=!r.terminal&&!r.halted&&!r.intent&&r.manager;
  const order=ORDER[f.module??'']??[];
  const cards=open?order.map(a=>actionCard(a,D,x)).filter(c=>c!==''):[];
  const mine=D.mine,ownerAddr=x.ex.addrOfKey(f.owner);
  // The creation transaction is the GENESIS receipt. `r.origin` is NOT it: it is the output GENESIS spent as its first input (the covenant's genesis outpoint, created by an earlier transaction).
  const genesisTx=r.receipts.find(t=>t.action==='GENESIS');
  return html`
  <div class="toolbar"><button class="btn sm" data-go2="explore">${ic('arrow')}返回</button><span class="spacer"></span>
    <button class="btn sm" data-act="toggleStar">${ic('star')}${x.saved?.has(r.cid)?'已关注':'关注'}</button>
    ${!r.terminal?html`<button class="btn sm" data-act="verify" title="同步最新进度并向节点核对" ${raw(x.busy||x.verify?.state==='checking'?'disabled aria-busy="true"':'')}>${ic('refresh')}${x.verify?.state==='checking'?'刷新中…':'刷新状态'}</button>`:''}
    <button type="button" class="btn sm" data-act="moreRound" aria-haspopup="dialog" aria-label="更多轮次操作">更多</button></div>
  <div class="panel t-${ph.tone}">
    <div class="row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="badge t-${ph.tone}">${ph.label}</span><span class="spacer"></span>
      ${r.source==='imported'?html`<span class="tag amber">导入 · 操作前向节点核对</span>`:''}</div>
    <h2 style="margin:8px 0 14px">轮次 ${hash(r.cid,{n:14})}</h2>
    ${f.module||r.terminal?stepper(D):''}
    ${intentPanel(r,x)}${verifyPanel(x.verify)}
    <p class="muted" style="margin:0 0 12px">${nextHint(D)}</p>
    <div class="cols3">
      ${kpi(r.terminal==='PAID'?'奖池（票款总额）':'当前票款',f.tickets!=null?html`${kas(BigInt(f.tickets)*price)} <span class="small muted">${UNIT}</span>`:'—',f.tickets!=null?`${f.tickets.toLocaleString()} 张 × ${kas(price)} ${UNIT}`:'')}
      ${kpi('售出 / 上限',f.tickets!=null?`${f.tickets.toLocaleString()} / ${f.ticketCap.toLocaleString()}`:'—',f.tickets!=null?`开奖最低 ${f.minTickets} 张 · ${f.shards} 个封存分片 + ${f.localRecords} 笔当前记录`:'')}
      ${f.winnerKey?kpi('中奖者',hash(x.ex.addrOfKey(f.winnerKey),{n:12}),D.isWinner?'就是你！':'奖金将付给该地址'):
        kpi(mine?'你持有':'你的票',mine?`${mine.tickets.toLocaleString()} 张`:signing(x.wallet)?'0 张':'—',mine&&mine.total>0?`中奖概率约 ${(mine.tickets/mine.total*100).toFixed(2)}%`:signing(x.wallet)?'还没买票':'连接钱包后显示')}
    </div>
  </div>
  <div class="round-layout">
    <aside class="round-actions panel"><h3>${ic('arrow')} 下一步怎么做</h3>
      ${r.terminal?html`<div class="notice ok">${TERMINAL_LABEL[r.terminal]}：${nextHint(D)}</div>`:cards.length?html`<div class="actions" style="grid-template-columns:1fr">${cards}</div>`:html`<p class="muted small">${r.intent?'等待上面那笔交易确认。':r.halted?'这一轮已停止。':'暂时没有可执行的操作。'}</p>`}
    </aside>
    <div class="round-main">
      <div class="panel"><h3>${ic('ticket')} 分片点图 · 购买记录</h3>${shardSection(D,x)}</div>
      <div class="panel"><h3>${ic('ledger')} 交易记录</h3>${txTable(D,x)}</div>
    </div>
    <div class="round-rules">
      <div class="panel"><h3>${ic('clock')} 规则与链上标识</h3><dl class="kv">
        <dt>票价</dt><dd>${kas(price)} ${UNIT}</dd>
        <dt>开奖最低票数</dt><dd>${f.minTickets} 张（不足则退款）</dd>
        <dt>最早封盘</dt><dd>${x.daa!=null&&x.daa>=f.closeEligibleDaa?'已到时间':`约 ${wait(x.daa,f.closeEligibleDaa)}`}<span class="muted small"> · 票卖满可提前</span></dd>
        <dt>开奖等待</dt><dd>封盘后约 100 DAA（约 10 秒）</dd>
        <dt>超时转退款</dt><dd>封盘后约 12 小时无人开奖时</dd>
        <dt>分片</dt><dd>每 256 笔购买封存一个，购买笔数不设上限</dd>
        <dt>创建者</dt><dd>${ownerAddr?hash(ownerAddr,{n:12,link:x.ex.addr(ownerAddr)}):html`<span class="muted">本机没有记录${r.terminal?'（轮次结束后合约状态不再保留创建者，押金已退回）':''}</span>`}</dd>
        <dt>创建交易</dt><dd>${genesisTx?hash(genesisTx.txid,{n:10,link:x.ex.tx(genesisTx.txid)}):html`<span class="muted">—</span>`}</dd>
        <dt>累计网络费</dt><dd>${kas(r.fees)} ${UNIT}</dd>
      </dl>
      <details style="margin-top:10px"><summary class="small muted">技术信息</summary><dl class="kv" style="margin-top:8px">
        <dt>完整 CID</dt><dd class="mono small">${r.cid}</dd>
        ${r.origin?html`<dt>创世输出</dt><dd class="mono small" title="创建这一轮时被花掉的资金输出（合约 ID 由它推出），不是创建交易本身">${shortHash(r.origin.transactionId,10,6)}:${r.origin.index}</dd>`:''}
        ${r.manager?html`<dt>状态 UTXO</dt><dd class="mono small">${shortHash(r.manager.outpoint.transactionId,10,6)}:${r.manager.outpoint.index}</dd><dt>合约锁定</dt><dd>${kas(r.manager.value)} ${UNIT}</dd>`:''}
        <dt>数据来源</dt><dd>${r.source==='imported'?'导入（未认证；每次操作前核对链上 UTXO）':'本页创建'}</dd>
      </dl></details></div>
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
  const w=x.wallet;
  const mineRounds=w?(x.mine?.rounds??[]):[];
  const txs=w?(x.mine?.txs??[]):[];
  const pendingCount=x.items.filter(i=>(i.r.pending?.length??0)>0||(!!i.r.intent&&['SUBMITTED','UNKNOWN'].includes(i.r.intent.status))).length;
  return html`
  <div class="cols">
    <div class="panel"><h2>${ic('wallet')} 钱包</h2>
      ${w?html`<dl class="kv"><dt>类型</dt><dd>${w.kind==='extension'?w.name??'扩展钱包':w.kind==='key'?'内存钱包（私钥只在本页内存）':'仅收款地址（不能签名）'}</dd><dt>地址</dt><dd>${hash(w.address,{n:16,link:x.ex.addr(w.address)})}</dd>
        ${signing(w)?html`<dt>余额</dt><dd>${x.balance==null?'读取中…':`${kas(x.balance)} ${UNIT}`}</dd>`:''}</dl>
        <div class="btnrow" style="margin-top:12px"><button class="btn sm" data-fix="wallet">管理钱包</button></div>`
        :html`<p class="sub">还没有连接钱包。连接后才能创建、购买、封盘和开奖；派奖与退款通常只需要一个收款地址。</p><button class="btn pri" data-fix="wallet">${ic('wallet')}连接钱包</button>`}
      <div class="notice warn" style="margin-top:14px">本页仅使用 Testnet 10。选择内存私钥模式时只用一次性测试密钥；使用扩展时，私钥保留在扩展中。</div></div>
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
function budgetChart(): Raw {
  const W=520,H=210,P=30;
  const fam:[string,string,string,number][]=[
    ['BUY','购买','#49eacb',3],['CLOSE','封盘','#60a5fa',3],['DRAW','开奖','#f5c451',3],
    ['TIMEOUT','超时转退款','#a78bfa',3],['REFUND_SELF','自退款','#f87171',257],
  ];
  const x=(n: number)=>P+(W-2*P)*n/256,y=(b: number)=>H-P-(H-2*P)*Math.min(b,160)/160;
  const path=(a: string,minT: number)=>Array.from({length:256},(_,i)=>i+1).map((n,i)=>`${i?'L':'M'}${x(n).toFixed(1)},${y(calcBudget(a,n===256&&a==='BUY'?255:n,minT)).toFixed(1)}`).join('');
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rolling 预算曲线">
    <g class="grid">${[0,40,80,120,160].map(b=>html`<line x1="${P}" x2="${W-P}" y1="${y(b)}" y2="${y(b)}"/><text x="2" y="${y(b)+3}">${b}</text>`)}${[0,64,128,192,256].map(n=>html`<text x="${x(n)-6}" y="${H-10}">${n}</text>`)}</g>
    ${fam.map(([a,_l,c,m])=>html`<path class="l" d="${path(a,m)}" stroke="${c}"/>`)}
  </svg><div class="legend">${fam.map(([_a,l,c])=>html`<span><i style="--c:${c}"></i>${l}</span>`)}</div>`;
}
function budgetPanel(pc: number): Raw {
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
    <p class="small muted">交易手续费由真实交易质量与节点实时费率动态迭代收敛，单笔风控上限 0.5 ${UNIT}（派奖 ≤1 ${UNIT}）。此表基于离线拟合上界模型（仅供预估，共识接受以节点为准）。</p>`;
}
export function rulesView(x?: Ctx): Raw {
  const pc=x?.S?.budgetPc??32;
  const item=(n: string,t: string,d: string)=>html`<li><span class="n">${n}</span><div><b>${t}</b><span>${d}</span></div></li>`;
  return html`
  <div class="panel"><h2>${ic('shield')} 规则说明</h2><p class="sub">Rolling 是“滚动分片”的抽奖合约：购买笔数不受单片 256 笔的限制。下面是你需要知道的全部规则。</p>
    <div class="flow" style="box-shadow:none"><ol>
      ${item('01','创建 · 售票','创建者设定票价、票数上限、最低票数和最早封盘时间，并锁入 4 TKAS 押金。任何人可以买票。')}
      ${item('02','满 256 笔自动封存','每满 256 笔购买，当前分片封存、开一个新分片继续卖。购买笔数不设上限。')}
      ${item('03','封盘','到了最早封盘时间（或票卖满）后任何人可封盘。票数达到最低票数则进入开奖；不足则转入退款；无人购买则退回押金。')}
      ${item('04','开奖','封盘后约 100 DAA（约 10 秒），任何人可开奖。中奖票由链上数据决定，创建者、买家和执行者都无法挑选或预测。')}
      ${item('05','派奖 · 退款','任何人都可以推进，无需签名。派奖：奖金付给中奖者，押金退创建者，执行者每个分片拿 1 TKAS。退款：每条购买记录扣 0.02 TKAS 执行费，其余原路退回。')}
    </ol></div></div>
  <div class="cols">
    <div class="panel"><h3>费用与押金</h3><dl class="kv">
      <dt>押金</dt><dd>4 TKAS，派奖或无人购买时全额退回创建者；全部退款完成时退回 3.98。</dd>
      <dt>网络费</dt><dd>每笔交易按节点实时费率计算，确认前会明确报价。</dd>
      <dt>执行奖励</dt><dd>派奖：每个分片 1 TKAS（从奖池扣）。退款：每条记录 0.02 TKAS 汇成执行费池，扣除网络费后归执行者。</dd></dl></div>
    <div class="panel"><h3>谁能做什么</h3><dl class="kv">
      <dt>创建者</dt><dd>没有特权，只在最后取回押金。</dd>
      <dt>任何人</dt><dd>买票、封盘、开奖、派奖、退款。派奖和退款无需签名，只需要一个领取奖励的地址。</dd>
      <dt>多人参与</dt><dd>用「复制分享链接」把一轮发给朋友，对方在「加入轮次」粘贴。别人操作后你的本机记录会过期，需要重新获取最新链接。</dd></dl></div>
  </div>
  <div class="panel"><h3>${ic('gauge')} 费用与算力预算计算器</h3>${budgetPanel(pc)}</div>
  <div class="panel"><h3>${ic('lock')} 请先了解这些限制</h3>
    <div class="notice warn"><b>这是 Testnet 10 实验版。</b>合约 Profile 证据状态为 UNVALIDATED，尚未完成全部上线前验证，不要用于主网或真实资产。TKAS 没有真实价值。</div>
    <ul class="small muted" style="line-height:1.9;margin:0;padding-left:18px">
      <li>已在 Testnet 10 实测：空轮、售罄提前封盘、超时转退款（TIMEOUT → REFUND_SELF）、多批次派奖（最高 ${VERIFIED_TICKET_CAP.toLocaleString()} 张票、17 个封存分片）、批量退款（最高 771 张票、3 个封存分片），以及同钱包并发避让与跨节点并发抢购冲突恢复。创建时票数上限可到 ${MAX_TICKET_CAP.toLocaleString()} 张（协议上限：256 个封存分片 × 256 笔购买）；超过 ${VERIFIED_TICKET_CAP.toLocaleString()} 张的轮次页面会标出“超出已验证范围”。</li>
      <li>尚未在实链完全验证：外部浏览器扩展对其余分支的实链签名（目前 KasWare 已在实链完成 TIMEOUT 与 REFUND_SELF；Kastle 及其余分支扩展实链签名尚未覆盖）、高于已测规模（超过 17 个分片的派奖、超过 3 个分片的退款、三人以上同时抢购），以及超出已观测深度的链重组恢复。</li>
      <li>钱包支持：支持 KasWare / Kastle 的 Testnet 10 Schnorr 账户（扩展逐笔确认与交易一致性核对已在离线与模拟注入中验证，其中 KasWare 已在实链完成 TIMEOUT 与 REFUND_SELF 签名广播，其余分支及 Kastle 扩展实链签名仍待实测）；也可使用测试内存私钥或公开收款地址。</li>
      <li>索引与备份：页面默认接入只读 Rolling 索引，并支持在无索引或索引滞后时按「索引 → 节点虚链追赶 → REST API」自动同步最新进度；无索引或离线时仍可通过分享链接和文件导入/导出使用，建议定期导出记录备份。</li>
      <li>交易确认基准：交易是否被接受只以 Testnet 10 节点选中链上的复核结果为准，页面与本地预算公式的离线核对都不等于共识验证。</li></ul></div>`;
}

/* ------------------------------------------------------------------ dialogs */
export function walletBody(x: Ctx): Raw {
  const w=x.wallet;
  if(w)return html`<dl class="kv"><dt>类型</dt><dd>${w.kind==='extension'?w.name??'扩展钱包':w.kind==='key'?'内存钱包':'仅收款地址（不能签名）'}</dd><dt>地址</dt><dd class="mono" style="word-break:break-all">${w.address}</dd>
    ${signing(w)?html`<dt>余额</dt><dd>${x.balance==null?'读取中…':`${kas(x.balance)} ${UNIT}`}</dd>`:''}</dl>
    <p class="sub" style="margin-top:12px">${w.kind==='extension'?'签名由扩展钱包确认，本页不会取得私钥。':w.kind==='key'?'断开后私钥会从本页内存清除。':'这个地址只能收取免签动作的执行奖励。'}</p>`;
  const tab=x.S.wtab,options=x.walletOptions??[],preferred=options.some(o=>o.id===x.S.walletProvider)?x.S.walletProvider:options[0]?.id??'kasware';
  return html`<div class="seg" style="margin-bottom:12px;flex-wrap:wrap"><button data-wtab="extension" aria-pressed="${tab==='extension'}">扩展 / Kaspire</button><button data-wtab="key" aria-pressed="${tab==='key'}">测试私钥</button><button data-wtab="addr" aria-pressed="${tab==='addr'}">仅收款地址</button></div>
    <p class="err" id="wErr" role="alert"></p>
    ${tab==='extension'?html`<label class="field">外部钱包<select id="wProvider">
        ${['kasware','kastle'].map(id=>html`<option value="${id}" ${preferred===id?'selected':''}>${id==='kasware'?'KasWare 扩展':'Kastle 扩展'}${options.some(o=>o.id===id)?'':'（未检测到）'}</option>`)}
        <option value="kaspire" ${preferred==='kaspire'?'selected':''}>Kaspire 手机 App（WalletConnect）</option>
      </select></label>
      <p class="sub">KasWare / Kastle 需在扩展中切换到 Testnet 10；Kaspire 可在手机浏览器直接拉起 App，或用手机 Kaspire 扫码连接。页面只请求指定输入的签名，核对后由页面提交，不会读取私钥。</p>`
    :tab==='key'?html`<div class="notice warn"><b>只使用一次性的 Testnet 10 私钥</b>。不要输入主网或有真实资产的私钥。私钥只放在本页内存，读取后立即清空输入框，不写入磁盘、不上传。</div>
      <label class="field">TN10 私钥（64 位十六进制）<input id="wKey" type="password" autocomplete="off" data-lpignore="true" spellcheck="false" placeholder="粘贴后点击“连接”"></label><p class="small muted">刷新或关闭页面即清除，本页不提供私钥和测试币。</p>`
    :html`<label class="field">收款地址（kaspatest:q…）<input id="wAddr" autocomplete="off" spellcheck="false" placeholder="kaspatest:q…"></label><p class="small muted">派奖和退款通常无需签名，执行者奖励发到此地址；少数退款尾批需要改用有资金的钱包辅助。</p>`}`;
}
export function settingsBody(x: Ctx): Raw {
  const c=x.conn;
  return html`<div class="notice">一般不需要修改。节点和索引默认指向当前数据源；只有出现连接问题或你有自己的节点时才需要改动。</div>
    <div class="form">
      <label class="field full">Testnet 10 节点（每行一个 wss:// 地址）<textarea id="sNodes" rows="2" spellcheck="false" autocomplete="off" style="background:var(--panel2);border:1px solid var(--line2);border-radius:10px;padding:10px 12px;width:100%">${x.S.nodes}</textarea>
        <small>${c.node===true?`已连接 · ${c.nodeUrl??''}`:c.node===false?'连接失败':'未连接'}。只有连接成功的新地址才会被保存，失败时保留原配置。</small></label>
      <label class="field full">Rolling 索引 API（可选）<input id="sIndexer" value="${x.S.indexer??''}" spellcheck="false" autocomplete="off" placeholder="https://你的索引服务/tn10/rolling/v1/ProfileID">
        <small>${c.indexer===true?(c.indexerStale?'索引暂不可用':'索引已连接'):c.indexer===false?'连接失败':'未配置'}。用于发现轮次和同步他人推进的状态；页面仍会向当前节点核对。留空可继续用分享链接。</small></label>
    </div>
    <p class="err" id="sErr" role="alert"></p><div id="sProbe" style="display:grid;gap:8px;margin-top:8px"></div>
    <h3 style="margin-top:16px">备份与恢复</h3>
    <p class="sub">本机意图与轮次记录保存在当前浏览器。索引可帮助找回链上状态；换设备或清除浏览器数据前仍应导出。</p>
    <div class="btnrow"><button class="btn" data-act="exportAll">${ic('download')}导出全部轮次</button>
      <button class="btn" data-act="pickFile">${ic('download')}导入轮次文件</button><input id="sFile" type="file" accept="application/json,.json" hidden></div>
    <details style="margin-top:16px"><summary class="small muted">运行日志（不含私钥）</summary><div class="log" style="margin-top:8px;max-height:220px;overflow:auto;font:12px var(--mono)">
      ${x.logs.length?x.logs.slice().reverse().slice(0,60).map(l=>html`<div class="${l.kind}">${new Date(l.at).toLocaleTimeString()} ${l.text}</div>`):'暂无日志'}</div></details>`;
}

/** Confirmation of a prepared transaction: what you pay / receive first, details collapsed. */
export function confirmBody(x: ConfirmCtx): Raw {
  const p=x.prepared,rv=p.review,w=x.wallet,mine=w?.spk?.script;
  const authorized=rv.inputs.filter(i=>i.kind.includes('需签名')).reduce((n,i)=>n+i.value,0n);
  const received=rv.outputs.filter(o=>!o.covenant&&o.script===mine).reduce((n,o)=>n+o.value,0n);
  const net=received-authorized,pay=net<0n;
  return html`<p style="margin:0 0 12px">${x.planText}</p>
    <div class="sum" style="border-top:0"><span>${pay?'你将支付（含网络费）':'你预计收到'}</span><span class="mono">${pay?kas(-net):kas(net)} ${UNIT}</span></div>
    <div class="sum"><span>网络费</span><span class="mono">${kas(rv.fee)} ${UNIT}</span></div>
    <h3 style="margin-top:14px">资金去向</h3>
    <div class="outs">${rv.outputs.map(o=>html`<div class="out ${!o.covenant&&o.script===mine?'mine':''}"><span class="r">${ROLE_LABEL[o.role]??o.role}</span>
      <span class="out-addr mono small">${o.covenant?'合约（轮次状态）':x.ex.addrOfScript(o.script)}${!o.covenant&&o.script===mine?' · 你':''}</span><span class="v">${kas(o.value)} ${UNIT}</span></div>`)}</div>
    <details style="margin-top:12px"><summary class="small muted">技术细节</summary><dl class="kv" style="margin-top:8px">
      <dt>交易 ID</dt><dd class="mono small">${rv.txid}</dd><dt>费率</dt><dd>${p.feerate} sompi/克（${p.fee} sompi）</dd>
      <dt>mass</dt><dd class="small">compute ${p.mass.computeMass} · transient ${p.mass.transientMass} · storage ${p.mass.storageMass}</dd>
      <dt>输入</dt><dd class="small">${rv.inputs.map(i=>`#${i.index} ${kas(i.value)} ${UNIT} · ${i.kind}`).join('；')}</dd></dl></details>
    <p class="small muted" style="margin-top:10px">点击确认后：${w?.kind==='extension'?'在扩展钱包中确认签名 → 本页验签':'本页在本地签名并验签'} → 保存记录 → 提交给节点。是否被接受以节点选中链为准。</p>`;
}
