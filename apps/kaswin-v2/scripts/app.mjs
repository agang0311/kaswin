/** Kaswin V2 — adapted from Opus, with Astra source labels and Gemini navigation ideas. */
import {S, PROFILE_ID, NETWORK_GENESIS, COMPILER_COMMIT, CONTRACT_TAG, makeProfile, unhex, hex, blake2b256, p2sh, kas, shortHash, escapeHtml as e, ensure, errorText, daaDuration,
  explorerTx, explorerAddress, explorerBlock, actionBudget, actionUnits, BUDGET_MARGIN, availableActions, kasToSompi, FEE_CAP, UserError, DAA_PER_SECOND, IndexedStore} from './shared/core.mjs';
import {NodeLink, host, nodeUrl} from './shared/nodes.mjs';
import {DEFAULT_NODE, DEFAULT_NODES, DEFAULT_INDEXER, CONFIG_VERSION, migrateConfig, connectionNotices} from './endpoints.mjs';
import {ACTION_LABEL, roleLabel, explainUnavailable, STORE} from './shared/engine.mjs';
import {EngineV2 as Engine} from './engine2.mjs';
import {txStatus, recordStatus, needsAttention, roundFacts, plannedActions, cardStep, planSummary, walletFlow, CLOSE_OUTCOME, waitText} from '../visual/view.mjs';
import {readSession, waitForProvider, watchWallet, provider} from './shared/wallet.mjs';
import {indexerBase, listRounds, roundDetail, ledgerFromDetail, liveRound, phaseInfo as basePhaseInfo} from './shared/rounds.mjs';
const phaseInfo = row => { const p = basePhaseInfo(row); return p.key === 'refunded' ? {...p, label:'退款完成'} : p; };
import {replayAccepted} from './shared/replay.mjs';
import {RoundCatalog} from './shared/catalog.mjs';
import {pubkeyToAddress, spkToAddress} from './shared/lib/address.mjs';
import {frames as FRAMES} from '@kaswin/data';
import {chooseLanguage, getLanguage, setLanguage, installLocalization, formatLocalTime, localTimeZone, text} from '../visual/i18n.mjs';

/* ------------------------------------------------------------------ boot */
const profile = makeProfile(NETWORK_GENESIS, Object.fromEntries(Object.entries(FRAMES).map(([m, f]) => [m, {...f, tail: unhex(f.tail)}])));
if (profile.id !== PROFILE_ID) throw new Error('嵌入的合约帧与固定 Profile 不一致，页面拒绝运行');
const $ = id => document.getElementById(id);
const LS = {get(k, d) { try { const v = localStorage.getItem('kaswin-v2:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('kaswin-v2:' + k, JSON.stringify(v)); } catch {} }};
/** Endpoint configuration (see endpoints.mjs). Defaults: wss://tn10.kaspay.top/wrpc + https://tn10.kaspay.top/indexer.
 * Both are editable in Settings and stored per browser; saved settings are migrated automatically. */
function loadConfig() {
  const v = LS.get('configVersion', 0);
  if (v < CONFIG_VERSION) {
    const m = migrateConfig({version: v, nodes: LS.get('nodes', null), indexer: LS.get('indexer', null)});
    LS.set('nodes', m.nodes); LS.set('indexer', m.indexer); LS.set('configVersion', m.version);
  }
  const nodes = LS.get('nodes', null);
  return {indexer: LS.get('indexer', null) || DEFAULT_INDEXER, nodes: Array.isArray(nodes) && nodes.length ? nodes : [...DEFAULT_NODES]};
}
setLanguage(chooseLanguage(LS.get('language', null), navigator.languages));
const refreshLanguage = installLocalization();
const CONFIG = loadConfig();
const state = {
  view: 'explore', indexer: CONFIG.indexer, live: null, liveAt: null, liveError: null, cached: 0, nodes: CONFIG.nodes,
  rows: [], details: new Map(), meta: null, error: null, busy: false, filter: 'all', query: '', sort: 'new', saved: new Set(LS.get('saved', [])),
  session: null, walletEpoch: 0, round: null, roundLive: null, records: [], daa: null, theme: LS.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
};
document.documentElement.dataset.theme = state.theme;
let pair = new NodeLink(state.nodes);
pair.onChange(renderNodeChip);
let engine = new Engine({pair, profile, indexer: safeBase(state.indexer)});
const catalog = new RoundCatalog(() => IndexedStore.open('kaswin-v2-rounds'));
function safeBase(v) { try { return indexerBase(v); } catch { return indexerBase(DEFAULT_INDEXER); } }

/* ------------------------------------------------------------------ icons */
import {icon} from '../visual/icons.mjs';

/* ------------------------------------------------------------------ helpers */
const hashHtml = (h, {link = null, n = 10, isTx = false, isAddr = false} = {}) => {
  if (!h) return '—';
  let targetLink = link;
  if (!targetLink) {
    if (isTx || (/^[0-9a-f]{64}$/i.test(h) && !h.startsWith('kaspa'))) {
      targetLink = isTx ? explorerTx(h) : null;
    } else if (isAddr || (typeof h === 'string' && (h.startsWith('kaspa:') || h.startsWith('kaspatest:')))) {
      targetLink = explorerAddress(h);
    }
  }
  const short = e(shortHash(h, n, 8));
  const textHtml = targetLink
    ? `<a href="${e(targetLink)}" target="_blank" rel="noopener noreferrer" class="mono hash-link" title="${e(h)}">${short}</a>`
    : `<span class="mono" title="${e(h)}">${short}</span>`;
  return `<span class="hash">${textHtml}<button class="copy" data-copy="${e(h)}" aria-label="复制">${icon('copy')}</button>${targetLink ? `<a class="copy" href="${e(targetLink)}" target="_blank" rel="noopener noreferrer" aria-label="在 kaspa.stream 查看">${icon('ext')}</a>` : ''}</span>`;
};
function outAddressHtml(o) {
  if (o.covenant) {
    const cid = o.covenant.covenantId || o.covenant;
    return `<span class="mono small muted" title="covenant ${e(cid)}">covenant ${e(shortHash(cid, 8, 6))}</span>`;
  }
  const addr = o.address ?? (o.scriptPublicKey ? spkToAddress(o.scriptPublicKey) : null);
  if (addr) {
    return hashHtml(addr, {link: explorerAddress(addr), n: 10, isAddr: true});
  }
  return `<span class="mono small muted">${e(o.scriptPublicKey?.script?.slice(0, 20) ?? '—')}…</span>`;
}
const facts = list => `<dl class="facts">${list.filter(Boolean).map(([k, v]) => `<div class="fact"><dt>${e(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const time = t => formatLocalTime(t);
const timeHtml = t => typeof t === 'number' && Number.isFinite(t) && Number.isFinite(new Date(t).getTime()) ? `<time data-local-time="${t}" datetime="${new Date(t).toISOString()}">${e(time(t))}</time>` : '—';
function toast(msg, tone = '') { const d = document.createElement('div'); d.className = 'toast ' + tone; d.textContent = msg; $('toasts').append(d); setTimeout(() => d.remove(), tone === 'bad' ? 9000 : 4500); }
function copyText(t) {
  if (navigator.clipboard && isSecureContext) return navigator.clipboard.writeText(t);
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove(); return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
}
document.addEventListener('click', ev => { const c = ev.target.closest('[data-copy]'); if (c) { ev.stopPropagation(); copyText(c.dataset.copy).then(() => toast('已复制'), () => toast('复制失败', 'warn')); } });
function download(obj, name) { const blob = new Blob([JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v, 2)], {type: 'application/json'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
const COLORS = ['#49eacb', '#60a5fa', '#a78bfa', '#f472b6', '#f59e0b', '#34d399', '#f87171', '#22d3ee', '#c084fc', '#fbbf24', '#4ade80', '#fb7185'];
const keyColor = (() => { const m = new Map(); return k => { if (!m.has(k)) m.set(k, COLORS[m.size % COLORS.length]); return m.get(k); }; })();

/* ------------------------------------------------------------------ modal */
let modalCleanup = null, modalBusy = false;
function lockModal(busy) { modalBusy = busy; $('mClose').disabled = busy; }
function modal(title, body, foot = '') {
  modalCleanup?.(); modalCleanup = null;
  $('mTitle').textContent = title; $('mBody').innerHTML = body; $('mFoot').innerHTML = foot; $('mFoot').hidden = !foot;
  if (!$('modal').open) $('modal').showModal();
  $('mBody').scrollTop = 0;
}
function closeModal() { if (modalBusy) return; modalCleanup?.(); modalCleanup = null; if ($('modal').open) $('modal').close(); }
$('mClose').onclick = closeModal;
$('modal').addEventListener('cancel', ev => { if (modalBusy) { ev.preventDefault(); return; } modalCleanup?.(); modalCleanup = null; });

/* ------------------------------------------------------------------ navigation */
const VIEWS = ['explore', 'round', 'create', 'mine', 'protocol'];
function go(view, param = null) {
  ensure(VIEWS.includes(view), 'VIEW');
  state.view = view;
  const hash = view === 'round' && param ? `#/round/${param}` : `#/${view}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  render();
}
window.addEventListener('popstate', route);
function route() {
  const m = /^#\/(\w+)(?:\/([0-9a-f]{64}))?$/.exec(location.hash);
  if (m && VIEWS.includes(m[1])) { state.view = m[1]; if (m[1] === 'round' && m[2]) openRound(m[2], {push: false}); else render(); }
  else { state.view = 'explore'; render(); }
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

/* ------------------------------------------------------------------ data sources */
/** Merge: remembered rounds (IndexedDB) < this browser's own transactions < live indexer.
 * Later sources replace earlier views of the same CID; nothing is ever dropped just because a source is offline. */
async function mergedRows() {
  const map = new Map();
  const put = (row, src) => { if (!row?.cid) return; const old = map.get(row.cid); const take = !old || rank(src) >= rank(old._src); map.set(row.cid, take ? {...row, _src: src, _also: [...new Set([...(old?._also ?? []), old?._src].filter(Boolean))]} : {...old, _also: [...new Set([...(old._also ?? []), src])]}); };
  const rank = s => ({cache: 1, local: 2, live: 3})[s] ?? 0;
  const remembered = await catalog.list();
  state.cached = remembered.length;
  for (const c of remembered) put(c.view ?? {cid: c.cid, contract: 'kaswin-f3@' + PROFILE_ID.slice(0, 16), indexStatus: 'UNKNOWN', phase: null, terminal: null, value: '0', updatedAt: c.updatedAt}, 'cache');
  for (const cid of await localCids()) { const d = await localDetail(cid); if (d) put(d, 'local'); }
  for (const r of state.live ?? []) put(r, 'live');
  for (const r of map.values()) if (r.state && !state.details.has(r.cid)) state.details.set(r.cid, r);
  return [...map.values()];
}
async function localCids() { try { return [...new Set((await engine.records()).filter(r => !['REJECTED', 'ARCHIVED'].includes(r.status)).map(r => r.cid))]; } catch { return []; } }
async function loadRows({quiet = false} = {}) {
  if (state.loadingRows) return;
  state.loadingRows = true;
  if (!quiet) { state.busy = true; render(); }
  state.liveError = null;
  try {
    const base = indexerBase(state.indexer), rows = []; let cursor = null, pages = 0;
    do { const p = await listRounds(base, {cursor, limit: 200}); rows.push(...p.items); cursor = p.nextCursor; state.meta = {source: base, lastCheckpointAt: p.lastCheckpointAt, coverage: p.coverage}; } while (cursor && ++pages < 10);
    state.live = rows.map(r => ({...r, _src: 'live'})); state.liveAt = Date.now();
    state.listLimited = !!cursor;
    // List rows are summaries. Fetch a bounded batch of details, not fake zero prices/prizes.
    const targets = rows.filter(r => { if (r.contract !== CONTRACT_TAG) return false; const d = state.details.get(r.cid); return !d?.state || d.latestTxid !== r.latestTxid || d.updatedAt !== r.updatedAt; }).slice(0, 24);
    let next = 0;
    await Promise.all(Array.from({length: 4}, async () => {
      while (next < targets.length) { const r = targets[next++]; try {
        const d = {...await roundDetail(base, r.cid), _src:'live'}; ledgerFromDetail(d, profile);
        state.details.set(r.cid,d);
      } catch { state.details.delete(r.cid); } }
    }));
    for (const r of rows) { const d = state.details.get(r.cid); void catalog.remember(r.cid, {view: d?.latestTxid === r.latestTxid ? d : r, source: 'indexer'}).catch(() => {}); }
  } catch (err) {
    state.liveError = errorText(err);
    // Previous responses are no longer a live source after this refresh failed.
    state.live = null;
  }
  state.rows = await mergedRows();
  state.busy = false; state.loadingRows = false;
  if (state.view === 'explore') render();
  else if (state.view === 'mine') renderMineRounds();
}

/* ------------------------------------------------------------------ chips */
function renderNodeChip() {
  const st = pair.status(), el = $('nodeChip');
  if (!el) return;
  const n = st.nodes[0];
  el.innerHTML = `<span class="dot ${st.connected ? 'ok' : ''}"></span>${st.connected ? e(n.host.replace(/:443$/, '')) : '节点未连接'}`;
  el.title = st.connected ? `${n.url}\nTN10 已同步 · DAA ${n.daa} · ${n.rtt} ms` : `首次需要链上数据时自动连接：${state.nodes[0]}`;
}
function renderWalletChip() {
  const b = $('walletBtn');
  if (state.session) { b.classList.add('on'); b.innerHTML = `${icon('wallet')}<span class="mono">${e(shortHash(state.session.address.slice(10), 5, 4))}</span>`; }
  else { b.classList.remove('on'); b.innerHTML = `${icon('wallet')}<span>连接 KasWare</span>`; }
}

/* ------------------------------------------------------------------ wallet */
async function connectWallet() {
  if (state.session) return walletDialog();
  try {
    const p = await waitForProvider();
    state.session = await readSession(p, {request: true}); state.walletEpoch++;
    toast('已连接 KasWare（仅读取账户，不授予任何签名权限）');
    watchWallet(async () => { state.walletEpoch++; try { state.session = await readSession(provider()); toast('钱包账户或网络已变化，未完成的报价已作废', 'warn'); } catch (err) { state.session = null; toast(errorText(err), 'warn'); } renderWalletChip(); render(); });
  } catch (err) { modal('连接钱包', `<div class="notice warn">${e(errorText(err))}</div><p class="muted">未连接钱包时，仍可浏览轮次、复验链上结果和使用费用计算器。本页永远不会要求私钥或助记词。</p>`); }
  renderWalletChip(); render();
}
async function walletDialog() {
  const s = state.session;
  modal('钱包', `${facts([['网络', 'Testnet 10'], ['地址', hashHtml(s.address, {link: explorerAddress(s.address), n: 14})], ['x-only 公钥', hashHtml(s.key)]])}
    <div id="balBox" class="notice">正在从节点读取可用余额…</div>
    <p class="muted small">本页只请求签名你明确批准的单笔交易中属于你的普通输入；永远不会调用 sendKaspa/pushTx，也不会读取私钥。</p>`,
    `<button class="btn" id="wDisc">断开本页会话</button>`);
  $('wDisc').onclick = () => { state.session = null; state.walletEpoch++; renderWalletChip(); closeModal(); render(); };
  try {
    const {commonUtxos} = await import('./shared/chain.mjs');
    const u = await commonUtxos(pair, s.address), plain = u.filter(x => !x.covenantId), total = plain.reduce((a, x) => a + x.value, 0n);
    if ($('balBox')) $('balBox').outerHTML = `<div class="notice ok">节点上的普通 UTXO：<b>${plain.length}</b> 个，合计 <b>${kas(total)} TKAS</b>（不含未确认交易，不是钱包全部历史）。</div>`;
  } catch (err) { if ($('balBox')) $('balBox').outerHTML = `<div class="notice warn">余额读取失败：${e(errorText(err))}</div>`; }
}
$('walletBtn').onclick = connectWallet;

/* ------------------------------------------------------------------ render root */
function render() {
  document.querySelectorAll('.nav [data-go]').forEach(b => b.setAttribute('aria-current', b.dataset.go === state.view || (state.view === 'round' && b.dataset.go === 'explore') ? 'page' : 'false'));
  renderWalletChip(); renderNodeChip();
  const v = $('view');
  v.className = 'view';
  ({explore: renderExplore, round: renderRound, create: renderCreate, mine: renderMine, protocol: renderProtocol})[state.view](v);
  renderPreferences();
}

/* ================================================================== EXPLORE */
function renderExplore(v) {
  const rows = state.rows, groups = {all: rows.length, open: 0, sealed: 0, refund: 0, done: 0};
  for (const r of rows) { const k = phaseInfo(r).key; if (k === 'open') groups.open++; else if (k === 'sealed') groups.sealed++; else if (k === 'refund') groups.refund++; else if (['paid', 'refunded', 'empty'].includes(k)) groups.done++; }
  const own = rows.filter(r => phaseInfo(r).key !== 'other'), others = rows.length - own.length;
  const locked = own.reduce((a, r) => a + (r.terminal ? 0n : BigInt(r.value ?? '0')), 0n);
  const paid = own.filter(r => r.terminal === 'PAID').length;
  const q = state.query.trim().toLowerCase();
  let list = rows.filter(r => {
    const k = phaseInfo(r).key;
    if (state.filter === 'saved' && !state.saved.has(r.cid)) return false;
    if (state.filter === 'open' && k !== 'open') return false;
    if (state.filter === 'sealed' && k !== 'sealed') return false;
    if (state.filter === 'refund' && k !== 'refund') return false;
    if (state.filter === 'done' && !['paid', 'refunded', 'empty'].includes(k)) return false;
    return !q || r.cid.includes(q) || (r.genesisTxid ?? '').includes(q) || (r.latestTxid ?? '').includes(q);
  });
  list.sort((a, b) => state.sort === 'value' ? (BigInt(b.value) > BigInt(a.value) ? 1 : -1) : (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  v.innerHTML = `
  <section class="hero">
    <div>
      <span class="eyebrow">KASPA L1 · TESTNET 10</span>
      <h1>参与一轮，<em>看清每一步。</em></h1>
      <p>选择轮次、核对票款与费用，再确认交易。售票、开奖与退款规则由固定合约约束；使用 TKAS 测试币。</p>
      <div class="hero-actions"><button class="btn pri" data-go2="create">${icon('create')}创建轮次</button><button class="btn ghost" data-go2="protocol">${icon('shield')}协议说明</button></div>
    </div>
    <div class="flow"><span class="eyebrow">HOW IT WORKS</span><h3>从买票到结算，去向清楚</h3><ol>
      <li><span class="n">01</span><div><b>选轮次 · 买票</b><span>票价、剩余票数、最低开奖门槛先看清</span></div></li>
      <li><span class="n">02</span><div><b>封盘 · 确定下一步</b><span>达到门槛可开奖；不足则分批退款</span></div></li>
      <li><span class="n">03</span><div><b>链上开奖 · 直接到账</b><span>任何人可推进，付款输出可逐项核对</span></div></li>
    </ol></div>
  </section>
  <div class="section-title"><h2>轮次广场</h2><span class="muted small">当前数据源中的已知轮次 · 非全网统计</span></div>
  <section class="kpis">
    <div class="kpi"><small>已知轮次</small><strong>${own.length}</strong><span>${state.live ? `索引 ${state.live.length}` : '实时索引未连接'} · 缓存 ${state.cached}${others ? ` · 另有其他 Profile ${others}（仅显示）` : ''}</span></div>
    <div class="kpi"><small>售票中</small><strong>${groups.open}</strong><span>可购买 / 可封盘</span></div>
    <div class="kpi"><small>待开奖 / 退款中</small><strong>${groups.sealed} / ${groups.refund}</strong><span>任何人可推进</span></div>
    <div class="kpi"><small>已派奖轮次</small><strong>${paid}</strong><span>共 ${groups.done} 轮已结束</span></div>
    <div class="kpi"><small>锁定价值</small><strong>${kas(locked)}</strong><span>TKAS · 进行中的轮次</span></div>
  </section>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="筛选">${[['all', '全部'], ['open', '售票中'], ['sealed', '待开奖'], ['refund', '退款中'], ['done', '已结束'], ['saved', '★ 关注']].map(([k, l]) => `<button data-filter="${k}" aria-pressed="${state.filter === k}">${l}<span class="c">${k === 'saved' ? state.saved.size : groups[k] ?? ''}</span></button>`).join('')}</div>
    <label class="search">${icon('search')}<input id="q" placeholder="搜索 CID / 交易 ID，或粘贴 64 位 CID 直接打开" value="${e(state.query)}" autocomplete="off" spellcheck="false"></label>
    <div class="seg"><button data-sort="new" aria-pressed="${state.sort === 'new'}">最近</button><button data-sort="value" aria-pressed="${state.sort === 'value'}">锁定价值</button></div>
    <button class="icon-btn" id="refreshRows" aria-label="刷新">${icon('refresh')}</button>
  </div>
  ${state.liveError ? `<div class="notice warn">实时索引暂不可用（<span class="mono">${e(state.indexer)}</span>）：${e(state.liveError)}。仍显示本机记住的轮次。<button class="link" id="openSettings">${icon('settings')}设置数据源</button></div>` : state.live ? `<div class="source-strip"><span class="dot ok"></span><span>索引数据 · ${timeHtml(state.liveAt)} · <b>尚未逐轮节点核验</b>${state.listLimited ? ' · 已达分页上限，并非完整列表' : ''}<br><span class="small muted">${e(state.meta?.source ?? '')} · 检查点 ${timeHtml(state.meta?.lastCheckpointAt)} · 操作前重新核对</span></span></div>` : ''}
  <div class="grid">${state.busy ? '<div class="empty">读取中…</div>' : list.length ? list.map(card).join('') : `<div class="empty">${icon('ticket')}<p>当前筛选下没有轮次。也可以<button class="link" data-go2="create">创建一个新轮次</button>。</p></div>`}</div>`;
  v.querySelectorAll('[data-go2]').forEach(b => b.onclick = () => go(b.dataset.go2));
  v.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { state.filter = b.dataset.filter; render(); });
  v.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { state.sort = b.dataset.sort; render(); });
  v.querySelectorAll('[data-cid]').forEach(c => c.onclick = ev => { if (ev.target.closest('[data-star],[data-copy]')) return; openRound(c.dataset.cid); });
  v.querySelectorAll('[data-star]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const c = b.dataset.star; state.saved.has(c) ? state.saved.delete(c) : state.saved.add(c); LS.set('saved', [...state.saved]); render(); });
  $('refreshRows').onclick = () => loadRows();
  $('openSettings') && ($('openSettings').onclick = settingsDialog);
  const qi = $('q');
  qi.oninput = () => { state.query = qi.value; const c = qi.value.trim().toLowerCase(); if (/^[0-9a-f]{64}$/.test(c) && !state.rows.some(r => r.cid === c)) { openRound(c); return; } renderExploreGrid(); };
  function renderExploreGrid() { const pos = qi.selectionStart; render(); const n = $('q'); n.focus(); n.setSelectionRange(pos, pos); }
}
function card(r) {
  if (phaseInfo(r).key === 'other') return `<article class="card t-muted" data-cid="${r.cid}" data-profile="other" tabindex="0" role="button" aria-label="打开轮次 ${shortHash(r.cid)}">
    <div class="row"><span class="badge t-muted">其他 Profile</span></div>
    <div class="mono dim small">CID ${shortHash(r.cid, 12, 8)}</div>
    <div class="small muted">合约 <span class="mono">${e(r.contract ?? '未知')}</span></div>
    <div class="card-next">${r.terminal ? `索引报告：${e(({PAID: '已派奖', REFUNDED: '已退款', EMPTY: '空轮结束'})[r.terminal] ?? r.terminal)}` : '索引报告：进行中'} · 本页只支持固定 F3.2 Profile，不读取账本、不复验、不提供操作</div>
    <div class="src">${({live: '索引数据', local: '本机记录', cache: '本机缓存 · 非实时'})[r._src] ?? '来源待核对'} · ${timeHtml(r.updatedAt)}</div>
  </article>`;
  const p = phaseInfo(r), candidate = state.details.get(r.cid), d = candidate?.latestTxid === r.latestTxid ? candidate : null, st = d?.state, saved = state.saved.has(r.cid);
  const sold = st?.sold ?? null, cap = st?.config?.ticketCap ?? null, pct = sold !== null && cap ? Math.min(100, sold / cap * 100) : (r.terminal ? 100 : 0);
  const price = st ? BigInt(st.config.ticketPrice) : null, pool = st ? BigInt(st.sold) * price : null;
  const headline = pool !== null ? kas(pool) : '—';
  const step = cardStep(r,d,state.daa);
  return `<article class="card t-${p.tone}" data-cid="${r.cid}" tabindex="0" role="button" aria-label="打开轮次 ${shortHash(r.cid)}">
    <div class="row"><span class="badge t-${p.tone}">${p.label}</span><button class="copy" data-star="${r.cid}" aria-pressed="${saved}" aria-label="关注" style="color:${saved ? 'var(--gold)' : ''}">${icon('star')}</button></div>
    <div class="mono dim small">CID ${shortHash(r.cid, 12, 8)}</div>
    <div class="small muted">${r.terminal ? '历史票款总额 · 非实际奖金' : '票款奖池 · 不含押金'}</div>
    <div class="big">${headline}<small>TKAS</small></div>
    ${st ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="row small muted"><span>${sold.toLocaleString()} / ${cap.toLocaleString()} 张 · ${kas(price)} TKAS/张</span><span>${st.purchaseCount} 笔</span></div>` : `<div class="small muted">打开查看账本与购买目录</div>`}
    <div class="card-next">${e(step.text)}</div>
    <div class="src">${({live: '索引数据 · 待节点核验', local: '本机接受记录', cache: '本机缓存 · 非实时'})[r._src] ?? '来源待核对'} · ${timeHtml(r.updatedAt)}</div>
    <div class="card-cta">${p.key === 'open' ? '查看并购买' : p.key === 'sealed' ? '查看开奖条件' : p.key === 'refund' ? '查看退款进度' : '查看轮次详情'} ${icon('arrow')}</div>
  </article>`;
}

/* ================================================================== ROUND */
async function openRound(cid, {push = true} = {}) {
  state.round = {cid, loading: true, error: null, detail: state.details.get(cid) ?? null, live: null, liveError: null, replay: null};
  state.view = 'round';
  if (push && location.hash !== `#/round/${cid}`) history.pushState(null, '', `#/round/${cid}`);
  render();
  try {
    let d = state.details.get(cid), fresh = null, idxErr = null;
    {
      try { fresh = {...await roundDetail(indexerBase(state.indexer), cid), _src: 'live'}; } catch (err) { idxErr = err; }
    }
    const loc = await localDetail(cid);
    // Prefer the newer of (indexer, this browser's accepted successor); fall back to the remembered snapshot.
    if (fresh && loc && loc.state && fresh.state && !fresh.terminal && (loc.terminal || loc.state.purchaseCount > fresh.state.purchaseCount || loc.state.phase !== fresh.state.phase || loc.state.cursor !== fresh.state.cursor) && loc.updatedAt > (fresh.updatedAt ?? 0)) d = loc;
    else if (fresh) d = fresh;
    else if (loc) d = loc;
    else if (!d) { const c = await catalog.get(cid); if (c?.view?.state) d = {...c.view, _src: 'cache'}; }
    if (!fresh && !loc && d) d = {...d, _src:'cache'};
    if (!d) throw idxErr ?? new Error('找不到这个轮次');
    ledgerFromDetail(d, profile);
    state.details.set(cid, d);
    void catalog.remember(cid, {view: d, source: d._src === 'live' ? 'indexer' : d._src === 'local' ? 'local' : 'opened', mine: d.state?.ownerKey === state.session?.key || undefined}).catch(() => {});
    if (state.round?.cid !== cid) return;
    state.round.detail = d; state.round.loading = false; state.round.staleNote = d._src !== 'live' && idxErr ? errorText(idxErr) : null;
    void engine.records().then(recs => { state.records = recs; if (state.round?.cid === cid && state.view === 'round') render(); }).catch(() => {});
    render();
    if (!d.terminal) {
      const current = state.round;
      void pair.currentDaa().then(daa => { state.daa = daa; if (state.round === current && state.view === 'round') render(); }).catch(() => {});
    }
  } catch (err) { if (state.round?.cid === cid) { state.round.loading = false; state.round.error = errorText(err); render(); } }
}
/** Build a detail view from this browser's own accepted records (indexer not caught up yet). Values are re-verified
 * against both nodes before any action (liveRound), so this is only a display convenience. */
async function localDetail(cid) {
  const tip = await engine.localTip(cid).catch(() => null);
  if (!tip) return null;
  // A terminal record has no successor ledger. Show the exact prior accepted ledger as historical participation,
  // never synthesize a successor or treat the prior input's locked value as a terminal prize.
  const previous = tip.terminal ? (await engine.records()).find(r => r.cid === cid && r.status === 'ACCEPTED' && r.nextLedger && tip.inputs.some(o => o.transactionId === r.txid && o.index === 0)) : null;
  const bytes = tip.nextLedger ?? previous?.nextLedger;
  if (!bytes) return null;
  const s = S.decodeLedger(unhex(bytes));
  return {cid, genesisTxid: tip.genesisTxid, contract: 'kaswin-f3@' + PROFILE_ID.slice(0, 16), status: tip.terminal ? 'close' : 'open', phase: s.phase, terminal: tip.terminal, indexStatus: 'LOCAL', tip: tip.terminal ? null : {transactionId: tip.txid, index: 0},
    value: tip.terminal ? '0' : String(tip.value), latestTxid: tip.txid, accepting: tip.accepting, utxoDaa: tip.terminal ? null : String(tip.utxoDaa), updatedAt: tip.at ?? Date.now(), origin: tip.origin, scriptPublicKey: tip.spk, _src: 'local',
    state: {...s, config: {...s.config, ticketPrice: s.config.ticketPrice.toString(), closeEligibleDaa: s.config.closeEligibleDaa.toString()}, anchorDaa: s.anchorDaa.toString()}, purchases: S.records(s)};
}
const STEPS = [['GENESIS', '创建'], ['OPEN', '售票'], ['SEALED', '封存'], ['DRAW', '开奖'], ['END', '结算']];
function stepper(d) {
  const ph = d.state?.phase, t = d.terminal;
  const pos = t === 'PAID' ? 5 : t === 'EMPTY' ? 5 : t === 'REFUNDED' ? 5 : ph === 1 ? 1 : ph === 2 ? 2 : ph === 5 ? 3 : 1;
  const labels = STEPS.map(([k, l], i) => i === 2 && (ph === 5 || t === 'REFUNDED') ? ['REFUNDING', '退款中'] : i === 3 && (ph === 5 || t === 'REFUNDED') ? ['REFUND', '分批退款'] : i === 4 && t ? ['END', t === 'PAID' ? '已派奖' : t === 'EMPTY' ? '空轮结束' : '已退款'] : [k, l]);
  return `<div class="stepper">${labels.map(([k, l], i) => `<div class="step ${i < pos ? 'done' : i === pos && !t ? 'now' : ''} ${k.startsWith('REFUND') ? 'alt' : ''}"><div class="b">${i < pos ? '✓' : i + 1}</div>${l}</div>`).join('')}</div>`;
}
function renderRound(v) {
  const R = state.round;
  if (!R) { v.innerHTML = `<div class="empty">没有选择轮次。<button class="link" data-back>返回广场</button></div>`; v.querySelector('[data-back]').onclick = () => go('explore'); return; }
  if (R.loading && !R.detail) { v.innerHTML = `<div class="panel">读取轮次 <span class="mono">${e(R.cid)}</span>…</div>`; return; }
  if (R.error && !R.detail) { v.innerHTML = `<div class="panel"><div class="notice warn">${e(R.error)}</div><p class="muted">CID：<span class="mono">${e(R.cid)}</span>。${/不是固定的 F3.2 Profile/.test(R.error) ? '这是索引收录的其他（旧版）合约轮次；本页只支持固定 F3.2 Profile，不读取账本、不复验、不提供操作。' : '可在设置中切换 Indexer，或确认 CID 是否正确。'}</p><button class="btn" id="back">${icon('arrow')}返回</button></div>`; $('back').onclick = () => go('explore'); return; }
  const d = R.detail, st = d.state, c = st.config, p = phaseInfo(d);
  let ledger = null, ledgerErr = null; try { ledger = ledgerFromDetail(d, profile); } catch (err) { ledgerErr = errorText(err); }
  const recs = ledger ? S.records(ledger) : [];
  const price = BigInt(c.ticketPrice), pool = BigInt(st.sold) * price;
  const me = state.session?.key;
  const myTickets = recs.filter(r => r.key === me).reduce((a, r) => a + r.count, 0);
  const draw = R.replay?.winner ?? null;
  const winRec = draw ? recs[draw.record] : null;
  const prizeEst = pool - S.FINALIZER;
  const closeDaa = BigInt(c.closeEligibleDaa), now = state.daa;
  v.innerHTML = `
  <div class="toolbar"><button class="btn sm" id="back">${icon('arrow')}返回广场</button><span class="spacer"></span>
    <button class="btn sm" id="star">${icon('star')}${state.saved.has(d.cid) ? '已关注' : '关注'}</button>
    <button class="btn sm" id="exp">${icon('download')}导出</button></div>
  <div class="panel t-${p.tone}">
    <div class="row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="badge t-${p.tone}">${p.label}</span><span class="mono small muted">${e(d.indexStatus)}</span><span class="spacer"></span>${({local: '<span class="tag kas">本机已接受 · 索引同步中</span>', cache: '<span class="tag">本机缓存</span>'})[d._src] ?? ''}</div>
    ${R.staleNote ? `<div class="notice warn" style="margin-top:8px">索引暂不可用（${e(R.staleNote)}），显示的是${d._src === 'local' ? '本机已被链上接受的最新状态' : '本机记住的快照'}；操作前仍会向节点核对。</div>` : ''}
    <h2 style="margin-top:8px">轮次 ${hashHtml(d.cid, {n: 14})}</h2>
    <div class="source-strip small">${d._src === 'live' ? '索引详情' : d._src === 'local' ? '本机接受记录' : '本机缓存'} · 更新于 ${timeHtml(d.updatedAt)} · ${R.live ? '本次已核验当前 UTXO' : R.replay ? '本次已复验最近交易' : '本次尚未完成节点核验'}。索引展示不是接受证明。</div>
    ${stepper(d)}
    <div class="cols3">
      <div class="kpi"><small>${d.terminal === 'PAID' ? '奖池（票款总额）' : '当前票款'}</small><strong>${kas(pool)} <span class="small muted">TKAS</span></strong><span>${st.sold.toLocaleString()} 张 × ${kas(price)} TKAS</span></div>
      <div class="kpi"><small>售出 / 上限</small><strong>${st.sold.toLocaleString()} / ${c.ticketCap.toLocaleString()}</strong><span>开奖最低 ${c.minTickets} 张 · ${st.purchaseCount}/${c.purchaseCap} 笔记录</span></div>
      <div class="kpi"><small>${d.terminal ? '结果' : '奖金上界（未扣网络费）'}</small><strong>${d.terminal === 'PAID' ? '已派奖' : d.terminal ? (d.terminal === 'EMPTY' ? '空轮' : '已退款') : kas(prizeEst > 0n ? prizeEst : 0n) + ' <span class="small muted">TKAS</span>'}</strong><span>${d.terminal ? '详情来源见上方；实际金额以接受交易输出为准' : st.sold < c.minTickets ? '当前未达开奖门槛；该数值不是可领奖金' : '此数值=票款−1 TKAS；实际奖金还需减网络费'}</span></div>
    </div>
  </div>
  <div class="round-layout">
    <aside class="round-actions panel"><h3>${icon('arrow')} 下一步怎么做</h3>${actionsHtml(d, ledger)}</aside>
    <div class="round-main">
      <div class="panel">
        <h3>${icon('ticket')} 购买目录 · 票号分布</h3>
        ${ledgerErr ? `<div class="notice warn">账本无法按固定 Profile 解析：${e(ledgerErr)}</div>` : ''}
        ${recs.length ? matrix(recs, st.sold, draw, d, me) : '<p class="muted">还没有购买记录。</p>'}
        ${me ? `<p class="small muted" style="margin-top:8px">你在本轮持有 <b>${myTickets}</b> 张票${st.sold ? `，中奖概率约 ${(myTickets / st.sold * 100).toFixed(2)}%` : ''}。</p>` : ''}
      </div>
      <div class="panel">
        <h3>${icon('shield')} 链上复验</h3>
        <p class="sub">使用索引提供的交易/接受块提示，向所配置节点查询接受证据，并重算输出；不把索引声明当作验证结果。历史被裁剪时可能无法复验。</p>
        <div id="verifyBox">${R.replay ? replayHtml(R.replay) : R.replayError ? `<div class="notice warn">${e(R.replayError)}</div>` : ''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="verifyLatest" ${d.latestTxid && d.accepting ? '' : 'disabled'}>${icon('node')}复验最近一笔状态交易</button>${!d.terminal ? `<button class="btn" id="verifyLive">${icon('refresh')}复验当前状态 UTXO</button>` : ''}</div>
        <div id="liveBox">${R.live ? liveHtml(R.live) : R.liveError ? `<div class="notice warn" style="margin-top:10px">${e(R.liveError)}</div>` : ''}</div>
      </div>
    </div>
    <div class="round-rules">
      <div class="panel">
        <h3>${icon('clock')} 规则与链上标识</h3>
        <dl class="kv">
          <dt>票价</dt><dd>${kas(price)} TKAS</dd>
          <dt>最早封盘 DAA</dt><dd class="mono">${closeDaa}${now ? ` <span class="muted">（${now >= closeDaa ? '已到' : '约 ' + daaDuration(closeDaa - now) + ' 后'}）</span>` : ''}</dd>
          <dt>开奖等待</dt><dd>封存后 ${S.DRAW_DELAY} DAA（约 ${daaDuration(S.DRAW_DELAY)}）</dd>
          <dt>超时退款</dt><dd>封存后 ${S.TIMEOUT_DELAY} DAA（约 ${daaDuration(S.TIMEOUT_DELAY)}）</dd>
          <dt>退款执行费</dt><dd>每条记录 0.01 TKAS · 每批最多 32 条</dd>
          <dt>创建者</dt><dd>${hashHtml(pubkeyToAddress(st.ownerKey), {link: explorerAddress(pubkeyToAddress(st.ownerKey)), n: 12})}</dd>
          <dt>Genesis</dt><dd>${hashHtml(d.genesisTxid, {link: explorerTx(d.genesisTxid)})}</dd>
          <dt>最近交易</dt><dd>${hashHtml(d.latestTxid, {link: d.latestTxid && explorerTx(d.latestTxid)})}</dd>
          <dt>接受块</dt><dd>${hashHtml(d.accepting, {link: d.accepting && explorerBlock(d.accepting)})}</dd>
          ${d.tip ? `<dt>状态 UTXO</dt><dd class="mono">${e(shortHash(d.tip.transactionId, 10, 6))}:${d.tip.index}</dd>` : ''}
          <dt>索引更新</dt><dd>${timeHtml(d.updatedAt)}</dd>
        </dl>
      </div>
    </div>
  </div>`;
  $('back').onclick = () => go('explore');
  $('star').onclick = () => { state.saved.has(d.cid) ? state.saved.delete(d.cid) : state.saved.add(d.cid); LS.set('saved', [...state.saved]); render(); };
  $('exp').onclick = () => download({kind: 'KASWIN_INDEXER_VIEW_NOT_CONSENSUS_PROOF', exportedAt: new Date().toISOString(), item: d, replay: R.replay}, `kaswin-${d.cid.slice(0, 12)}.json`);
  $('verifyLatest').onclick = () => verifyLatest(d);
  $('verifyLive') && ($('verifyLive').onclick = () => verifyLive(d));
  v.querySelectorAll('[data-act]').forEach(b => b.onclick = () => actionDialog(b.dataset.act, d));
  if ($('refreshRound')) $('refreshRound').onclick = async () => { try { state.daa=await pair.currentDaa(); } catch {} await openRound(d.cid,{push:false}); };
  bindMatrixEvents(v, recs, d, draw, me, price);
}
function matrix(recs, sold, draw, d, me) {
  const price = d?.state?.config?.ticketPrice ? BigInt(d.state.config.ticketPrice) : null;
  const drawRec = draw ? draw.record : null;
  const myBuys = (state.records || []).filter(x => x.cid === d?.cid && x.action === 'BUY' && !['REJECTED', 'ARCHIVED'].includes(x.status));
  let myBuyIdx = 0;

  const cells = recs.map((r, i) => {
    const isMe = r.key === me;
    const isWin = drawRec !== null && drawRec === i;
    const isRefunded = (d?.state?.phase === 5 && i < d?.state?.cursor) || d?.terminal === 'REFUNDED';
    const start = r.end - r.count + 1;
    const addr = pubkeyToAddress(r.key);

    let txid = r.txid || d?.purchases?.[i]?.txid || null;
    if (!txid && recs.length === 1 && d?.state?.phase === 1 && d?.latestTxid) {
      txid = d.latestTxid;
    }
    if (!txid && isMe && myBuys[myBuyIdx]?.txid) {
      txid = myBuys[myBuyIdx++].txid;
    }

    const href = txid ? explorerTx(txid) : explorerAddress(addr);
    const rangeText = `${start}${r.count > 1 ? '–' + r.end : ''}`;
    const statusText = isWin ? ' · 🏆 中奖' : isRefunded ? ' · 已退款' : '';
    const title = `第 ${i + 1} 笔购买 · 票号 #${rangeText} (${r.count} 张) · 买家: ${shortHash(addr, 8, 6)}${isMe ? ' (我)' : ''}${statusText}${txid ? ' · TXID: ' + shortHash(txid, 8, 6) : ''} · 点击在 kaspa.stream 查看`;
    const label = isWin ? '🏆' : String(i + 1);

    return `<a class="cell${isWin ? ' w' : ''}${isMe ? ' me' : ''}" style="--c:${keyColor(r.key)}" href="${e(href)}" target="_blank" rel="noopener noreferrer" data-idx="${i}" aria-label="第 ${i + 1} 笔购买" title="${e(title)}">${label}</a>`;
  });

  const owners = [...new Set(recs.map(x => x.key))];
  const placeholder = `<div class="tip-placeholder">${icon('search')}<span>点击或悬停方格查看购买详情 · 点击跳转 kaspa.stream</span></div>`;

  return `<div class="matrix" role="region" aria-label="购买分布">${cells.join('')}</div>
  <div class="matrix-tip" id="matrixTip">${placeholder}</div>
  <div class="legend">${owners.slice(0, 8).map(k => `<span><i style="--c:${keyColor(k)}"></i><span class="mono">${e(shortHash(k, 6, 4))}</span> ${recs.filter(x => x.key === k).reduce((a, x) => a + x.count, 0)} 张</span>`).join('')}${owners.length > 8 ? `<span>…共 ${owners.length} 位买家</span>` : ''}${draw ? `<span><i style="--c:var(--gold)"></i>中奖票 #${draw.ticket !== undefined ? draw.ticket : (draw.firstTicket + (draw.firstTicket !== draw.lastTicket ? '–' + draw.lastTicket : ''))}</span>` : ''}</div>`;
}

function bindMatrixEvents(v, recs, d, draw, me, price) {
  const tip = $('matrixTip');
  if (!tip || !recs.length) return;
  const placeholder = `<div class="tip-placeholder">${icon('search')}<span>点击或悬停方格查看购买详情 · 点击跳转 kaspa.stream</span></div>`;
  const myBuys = (state.records || []).filter(x => x.cid === d.cid && x.action === 'BUY' && !['REJECTED', 'ARCHIVED'].includes(x.status));
  let activeIdx = null;

  function renderTip(i) {
    const r = recs[i];
    if (!r) return;
    const isMe = r.key === me;
    const isWin = draw && draw.record === i;
    const isRefunded = (d.state?.phase === 5 && i < d.state?.cursor) || d.terminal === 'REFUNDED';
    const start = r.end - r.count + 1;
    const rangeText = `${start}${r.count > 1 ? '–' + r.end : ''}`;
    const addr = pubkeyToAddress(r.key);
    const cost = price ? kas(price * BigInt(r.count)) + ' TKAS' : '';
    let txid = r.txid || d.purchases?.[i]?.txid || null;
    if (!txid && recs.length === 1 && d.state?.phase === 1 && d.latestTxid) txid = d.latestTxid;
    if (!txid && isMe) {
      const myIdx = recs.slice(0, i).filter(x => x.key === me).length;
      if (myBuys[myIdx]?.txid) txid = myBuys[myIdx].txid;
    }
    const tone = isWin ? 't-gold' : isMe ? 't-pri' : '';
    const badgeLabel = isWin ? '🏆 中奖记录' : isRefunded ? '已退款' : '第 ' + (i + 1) + ' 笔购买';
    tip.innerHTML = `
      <div class="tip-head">
        <span class="badge ${tone}">${badgeLabel}</span>
        <strong>票号 #${rangeText}</strong>
        <span class="tag">${r.count} 张</span>
        ${cost ? `<span class="muted">${cost}</span>` : ''}
        <span class="spacer"></span>
        ${isMe ? '<span class="tag kas">我</span>' : ''}
      </div>
      <div class="tip-body">
        <span>买家：<span class="mono">${hashHtml(addr, {link: explorerAddress(addr), isAddr: true, n: 10})}</span></span>
        <span class="spacer"></span>
        ${txid ? `<a class="btn sm mono" href="${explorerTx(txid)}" target="_blank" rel="noopener noreferrer">${shortHash(txid, 8, 6)} ↗</a>` : `<a class="btn sm" href="${explorerAddress(addr)}" target="_blank" rel="noopener noreferrer">在 kaspa.stream 查看买家 ↗</a>`}
      </div>`;
  }

  const cells = v.querySelectorAll('.matrix .cell');
  cells.forEach(cell => {
    const i = Number(cell.dataset.idx);

    cell.onmouseenter = cell.onfocus = () => {
      if (matchMedia('(hover: hover)').matches) {
        renderTip(i);
      }
    };

    cell.addEventListener('click', ev => {
      const isTouch = ev.pointerType === 'touch' || !matchMedia('(hover: hover)').matches;
      if (isTouch && activeIdx !== i) {
        ev.preventDefault();
        activeIdx = i;
        cells.forEach(c => c.classList.remove('active'));
        cell.classList.add('active');
        renderTip(i);
      }
    });
  });

  const matrixEl = v.querySelector('.matrix');
  if (matrixEl) {
    matrixEl.onmouseleave = () => {
      if (matchMedia('(hover: hover)').matches && activeIdx === null) {
        tip.innerHTML = placeholder;
      }
    };
  }
}
function actionsHtml(d, ledger) {
  if (d.terminal) return `<div class="notice ok">本轮已结束（${d.terminal === 'PAID' ? '已派奖' : d.terminal === 'EMPTY' ? '空轮，押金已退回创建者' : '全部购买记录已退款'}）。资金已以普通 UTXO 形式离开合约，不再需要任何操作。</div>`;
  if (!ledger) return `<div class="notice warn">账本解析失败，无法操作。</div>`;
  const ph = ledger.phase, list = [];
  if (ph === 1) { list.push(['BUY', 'ticket', '购买', `${kas(ledger.config.ticketPrice)} TKAS/张；剩余 ${ledger.config.ticketCap - ledger.sold} 张、${ledger.config.purchaseCap - ledger.purchaseCount} 笔记录`]); list.push(['CLOSE', 'lock', '封盘', ledger.sold >= ledger.config.minTickets ? '→ 封存，100 DAA 后可开奖' : ledger.sold === 0 ? '→ 空轮结束，押金退回创建者' : `→ 未达 ${ledger.config.minTickets} 张，转入退款`]); }
  if (ph === 2) { list.push(['DRAW_AND_PAY', 'trophy', '开奖并派奖', '任何人可执行，执行者获得 1 TKAS 赏金；奖金直接付给中奖者']); list.push(['TIMEOUT_REFUND', 'clock', '超时转退款', '封存 300 DAA 仍未开奖时，任何人可转入退款']); }
  if (ph === 5) list.push(['REFUND', 'refund', `退款批次（${Math.min(32, ledger.purchaseCount - ledger.cursor)} 条）`, `已退 ${ledger.cursor}/${ledger.purchaseCount}；执行者获得本批执行费池扣除网络费后的余额`]);
  const proposed = plannedActions(d,state.daa);
  return `<div class="actions">${list.map(([a, ic, title, desc]) => {
    const hint = proposed.find(x => x.action === a), blocked = a === 'BUY' && hint?.available === false;
    return `<div class="act"><h4>${icon(ic)}${title}</h4><p>${desc}</p>${hint?.until ? `<span class="small why">${waitText(hint.until,state.daa)} · 以报价时节点为准</span>` : ''}${hint?.outcome ? `<span class="small muted">${CLOSE_OUTCOME[hint.outcome]}</span>` : ''}<button class="btn ${a === 'DRAW_AND_PAY' ? 'gold' : a === 'BUY' ? 'pri' : ''}" data-act="${a}" ${blocked?'disabled':''}>${blocked ? hint.reason : a === 'BUY' ? '选择张数' : '核验并'+(a==='REFUND'?'退款':ACTION_LABEL[a])} ${icon('arrow')}</button></div>`;
  }).join('')}</div><p class="small muted">${ph===1?'到封盘时间不会自动停售，也不会自动封盘。':''}先核验与报价，确认前不会签名或提交。刷新状态不会重新提交交易。</p><button class="link" id="refreshRound">刷新轮次与节点时间</button>`;
}
function replayHtml(x) {
  const lab = {STATE: '状态后继', WINNER: '中奖者', CREATOR: '创建者', EXECUTOR: '执行者', BUYER_REFUND: '买家退款', CHANGE: '找零', REGISTRY: 'Registry 登记'};
  return `<div class="notice ok"><b>${e(ACTION_LABEL[x.action] ?? x.action)}</b> 已被选中链接受（接受块 DAA ${x.acceptingDaa}，确认深度约 ${x.confirmations}），${x.action === 'GENESIS' ? '创建公告、初始账本、模板路由、0.2 TKAS 状态输出与 Covenant ID 推导均与固定 Profile 一致。' : `全部 ${x.outputs.length} 个输出与固定合约规则重算结果逐字节一致。`}</div>
  ${x.winner ? `<div class="notice" style="border-color:var(--gold);background:var(--gold-soft)">🏆 中奖记录 #${x.winner.record + 1}（票 ${x.winner.firstTicket}–${x.winner.lastTicket}），奖金 <b>${kas(x.winner.prize)} TKAS</b> → ${hashHtml(pubkeyToAddress(x.winner.key), {link: explorerAddress(pubkeyToAddress(x.winner.key)), n: 12})}</div>` : ''}
  <div class="outs">${x.outputs.map((o, i) => `<div class="out"><span class="r">${i} · ${e(lab[o.role] ?? o.role)}</span><span class="out-addr">${outAddressHtml(o)}</span><span class="v">${kas(o.value)}</span></div>`).join('')}</div>
  <dl class="kv small" style="margin-top:8px"><dt>交易</dt><dd>${hashHtml(x.txid, {link: explorerTx(x.txid)})}</dd><dt>网络费</dt><dd>${kas(x.fee)} TKAS · compute mass ${x.computeMass ?? '—'} · budget ${x.budget}</dd>${x.draw ? `<dt>PASS-A 目标块</dt><dd>${hashHtml(x.draw.target, {link: explorerBlock(x.draw.target)})} · DAA ${x.draw.targetDaa} ≥ 边界 ${x.draw.boundaryDaa}；节点区块头的序列承诺与证明一致</dd>` : ''}</dl>`;
}
function liveHtml(l) {
  const acts = availableActions(l.snapshot, profile).filter(a => ACTION_LABEL[a]);
  return `<div class="notice ok" style="margin-top:10px">状态 UTXO 仍未花费；模板、Genesis CID、P2SH 与锁定金额 ${kas(l.snapshot.value)} TKAS 均与固定 Profile 吻合。当前 DAA ${l.snapshot.currentDaa}。当前可执行：<b>${acts.map(a => ACTION_LABEL[a]).join('、') || '无（需等待）'}</b>。</div>`;
}
/** TN10 nodes keep ~30 h of block bodies (rusty-kaspa PRUNING_DURATION = 108,000 s); older accepting blocks are gone. */
function prunedHint(err) {
  return /cannot find header|block not found|not found|retention root/i.test(errorText(err))
    ? '该交易的接受块已被节点裁剪（Testnet 10 只保留约 30 小时的区块数据），无法再从节点在线复验。这不代表交易无效。'
    : null;
}
async function verifyLatest(d) {
  const R = state.round; const box = $('verifyBox'); box.innerHTML = '<div class="notice">从节点取回已接受交易…</div>';
  try { R.replay = await replayAccepted(pair, profile, d.latestTxid, d.accepting); R.replayError = null; }
  catch (err) { R.replay = null; R.replayError = prunedHint(err) ?? `复验未完成：${errorText(err)}`; }
  if (state.round === R) render();
}
async function verifyLive(d) {
  const R = state.round; $('liveBox').innerHTML = '<div class="notice" style="margin-top:10px">读取实时状态…</div>';
  try { await pair.connect(); state.daa = await pair.currentDaa(); R.live = await liveRound(pair, indexerBase(state.indexer), profile, d.cid, state.daa); R.liveError = null; }
  catch (err) { R.live = null; R.liveError = errorText(err); }
  if (state.round === R) render();
}

/* ------------------------------------------------------------------ action dialog */
async function actionDialog(action, d) {
  if (!state.session) { await connectWallet(); if (!state.session) return; }
  const epoch = state.walletEpoch;
  if (action === 'BUY') {
    const st = d.state, max = Math.min(st.config.ticketCap - st.sold, 100000);
    modal('购买', `<div class="form"><label class="field full">购买张数<input id="qty" inputmode="numeric" value="1" maxlength="6"><small>本轮剩余 ${max} 张，${kas(BigInt(st.config.ticketPrice))} TKAS/张；一次购买 = 1 条购买记录</small></label></div><div id="qtyTotal" class="sum"></div><p class="err" id="qErr"></p>`, `<button class="btn" id="cancel">取消</button><button class="btn pri" id="go">核验并报价 ${icon('arrow')}</button>`);
    const upd = () => { const q = $('qty').value.trim(); $('qtyTotal').innerHTML = /^[1-9][0-9]*$/.test(q) && +q <= max ? `<span>票款</span><span>${kas(BigInt(q) * BigInt(st.config.ticketPrice))} TKAS + 网络费</span>` : ''; };
    $('qty').oninput = upd; upd(); $('cancel').onclick = closeModal;
    $('go').onclick = () => { const q = $('qty').value.trim(); if (!/^[1-9][0-9]{0,5}$/.test(q) || +q > max) { $('qErr').textContent = `请输入 1–${max} 的整数`; return; } runPlan({action, cid: d.cid, quantity: +q}, epoch); };
    return;
  }
  runPlan({action, cid: d.cid}, epoch);
}
const STAGES = {plan: ['连接节点', '读取并复验状态 UTXO', '构建交易并计算精确费用'], exec: ['再次确认输入未花费', '钱包签名（仅你的普通输入）', '验证签名并持久化意图', '单次提交到节点']};
async function runPlan(request, epoch) {
  modal(ACTION_LABEL[request.action], `<ul class="progress" id="prog"><li class="run" id="pstat">准备…</li></ul><p class="err" id="pErr"></p>`);
  lockModal(true);
  engine.onStatus = s => { const el = $('pstat'); if (el) el.textContent = s; };
  let plan;
  try { plan = await engine.plan(request, state.session); }
  catch (err) { lockModal(false); engine.onStatus = () => {}; $('prog').innerHTML = ''; $('pErr').textContent = errorText(err); $('mFoot').hidden = false; $('mFoot').innerHTML = `<button class="btn" id="cancel">关闭</button>`; $('cancel').onclick = closeModal; return; }
  engine.onStatus = () => {}; lockModal(false);
  if (epoch !== state.walletEpoch) { $('pErr').textContent = '钱包已变化，请重新开始'; return; }
  showPlan(plan, epoch);
}
function showPlan(plan, epoch) {
  const t = plan.draft.transaction, mine = walletFlow(plan).received;
  const spent = walletFlow(plan).spent;
  const net = spent - mine;
  const expires = plan.createdAt + 90_000;
  const lab = o => `${roleLabel(o.role)}${o.mine ? ' · 你' : ''}`;
  modal(`确认：${ACTION_LABEL[plan.action]}`, `
    <div class="notice plan-summary"><b>这笔交易会做什么</b><p>${e(planSummary(plan))}</p></div>
    ${plan.action === 'DRAW_AND_PAY' ? `<div class="notice" style="border-color:var(--gold);background:var(--gold-soft)">🏆 已从选中链构造并验证 PASS-A 随机证明。按合约规则，本次开奖中奖票为 <b>#${plan.winner.ticket}</b>（记录 #${plan.winner.record + 1}），买家 ${hashHtml(pubkeyToAddress(plan.winner.key), {n: 12})}。</div>` : ''}
    ${plan.sponsored ? `<div class="notice warn">本批退款的执行费池不足以覆盖网络费/存储质量，需由你的一笔普通 UTXO 赞助；赞助本金会随执行者输出退回给你。</div>` : ''}
    <h3 style="margin:0 0 8px">全部输出（${t.outputs.length}）</h3>
    <div class="outs">${plan.outputs.map(o => `<div class="out ${o.mine ? 'mine' : ''}"><span class="r">${o.index} · ${e(lab(o))}</span><span class="out-addr">${outAddressHtml(o)}</span><span class="v">${kas(o.value)}</span></div>`).join('')}</div>
    <div class="sum"><span>网络手续费</span><span>${kas(plan.fee)} TKAS</span></div>
    <div class="sum"><span>你的钱包净支出</span><span>${net >= 0n ? kas(net) : '净收入 ' + kas(-net)} TKAS</span></div>
    ${plan.before ? `<dl class="kv small"><dt>状态变化</dt><dd>阶段 ${plan.before.phase} → ${plan.after ? plan.after.phase : '终局 ' + plan.terminal}；售出 ${plan.before.sold} → ${plan.after?.sold ?? plan.before.sold}；记录 ${plan.before.purchaseCount} → ${plan.after?.purchaseCount ?? plan.before.purchaseCount}${plan.after && plan.after.cursor !== plan.before.cursor ? `；退款游标 ${plan.before.cursor} → ${plan.after.cursor}` : ''}</dd></dl>` : ''}
    <details style="margin-top:8px"><summary class="small muted">技术细节</summary><dl class="kv small" style="margin-top:8px">
      <dt>交易 ID</dt><dd class="mono">${e(plan.draft.txid)}</dd><dt>CID</dt><dd class="mono">${e(plan.cid)}</dd>
      <dt>Compute budget</dt><dd>输入 0：${plan.budget}（含 ${BUDGET_MARGIN} 单位余量）· 资金输入各 10</dd>
      <dt>质量</dt><dd>compute ${plan.quote.computeMass} · storage ${plan.quote.storageMass} · transient ${plan.quote.transientMass}</dd>
      <dt>费率</dt><dd>节点普通费率 ${plan.feerate} sompi/gram · 上限 ${kas(FEE_CAP)} TKAS</dd>
      <dt>需签名输入</dt><dd>${plan.draft.authorizedInputIndices.join(', ') || '无（permissionless）'}</dd>
      ${t.lockTime ? `<dt>lockTime</dt><dd>${t.lockTime}</dd>` : ''}${t.inputs[0].sequence ? `<dt>sequence</dt><dd>${t.inputs[0].sequence}</dd>` : ''}
      ${plan.proof ? `<dt>PASS-A</dt><dd>目标块 ${e(shortHash(plan.proof.target.hash))} · 边界 DAA ${plan.proof.boundaryDaa} · 节点 ${e(plan.proof.nodes.join(' / '))}</dd>` : ''}
    </dl></details>
    <label class="check" style="margin-top:12px"><input type="checkbox" id="approve">我已核对全部输出与费用，只批准这一笔 Testnet 10 交易</label>
    <p class="small muted" id="ttl"></p><ul class="progress" id="xprog"></ul><p class="err" id="xErr"></p>`,
    `<button class="btn" id="cancel">取消</button><button class="btn pri" id="sign" disabled>${plan.draft.authorizedInputIndices.length ? '签名并提交' : '提交'}</button>`);
  const tick = setInterval(() => { const left = Math.max(0, Math.round((expires - Date.now()) / 1000)); if ($('ttl')) $('ttl').textContent = left ? `报价 ${left} 秒内有效` : '报价已过期，请重新报价'; if (!left) { $('sign') && ($('sign').disabled = true); clearInterval(tick); } }, 500);
  modalCleanup = () => clearInterval(tick);
  $('approve').onchange = () => { $('sign').disabled = !$('approve').checked || Date.now() >= expires; };
  $('cancel').onclick = closeModal;
  $('sign').onclick = async () => {
    lockModal(true);
    $('sign').disabled = true; $('approve').disabled = true; $('cancel').disabled = true;
    const log = s => { const li = document.createElement('li'); li.className = 'run'; li.textContent = s; const x = $('xprog'); if (!x) return; x.querySelectorAll('.run').forEach(n => n.className = 'ok'); x.append(li); };
    try {
      ensure(epoch === state.walletEpoch, '钱包会话已变化，计划作废');
      const rec = await engine.execute(plan, {approved: $('approve').checked, onProgress: log});
      clearInterval(tick);
      if (['SUBMITTED', 'UNKNOWN'].includes(rec.status)) void catalog.remember(rec.cid, {source: rec.action === 'GENESIS' ? 'created' : 'traded', mine: true});
      $('xprog')?.querySelectorAll('.run').forEach(n => n.className = 'ok');
      lockModal(false); showRecord(rec, true);
      if (['SUBMITTED','UNKNOWN'].includes(rec.status)) { toast('正在核对结果；只查询，不重新提交'); void autoReconcile(rec.txid); }
    } catch (err) {
      lockModal(false);
      const msg = errorText(err);
      if (msg.includes('另一个标签页正在提交交易')) {
        const usesLease = !navigator.locks;
        $('xErr').innerHTML = `${e(msg)}<br><small class="muted">${usesLease ? '本页通过 http 打开，使用本地租约锁：持有锁的标签页关闭后，最长 2 分钟自动失效。若确认没有其他标签页在等待签名，可在失效后释放。' : '浏览器会在持有锁的标签页关闭后自动释放。请先在另一个标签页（或手机后台的 KasWare 页面）完成或取消签名。'}</small>${usesLease ? '<br><button class="btn sm" id="unlockBtn" style="margin-top:6px">释放已过期的提交锁</button>' : ''}`;
        if (usesLease) $('unlockBtn').onclick = async () => {
          try { const r = await engine.resetLock(); toast(r.released ? '已释放过期的提交锁' : '当前没有提交锁'); $('xErr').textContent = '请重新报价后再提交。'; }
          catch (err2) { toast(errorText(err2), 'warn'); }
        };
      } else {
        $('xErr').textContent = msg;
      }
      $('cancel').disabled = false;
      $('cancel').textContent = '关闭';
    }
  };
}
async function autoReconcile(txid) {
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 2500 + i * 1500));
    try {
      const r = await engine.reconcile(txid);
      if (['ACCEPTED','REST_ACCEPTED'].includes(recordStatus(r))) {
        toast(`${ACTION_LABEL[r.action]} ${txStatus(recordStatus(r)).label}`);
        if ($('modal').open && $('recTx')?.dataset.tx === txid) showRecord(r);
        if (recordStatus(r)==='REST_ACCEPTED') { if(state.view==='mine') render(); return; }
        state.details.delete(r.cid);
        state.rows = await mergedRows();
        if (r.action === 'GENESIS' && state.view === 'create') void openRound(r.cid);
        else if (state.round?.cid === r.cid) { state.round.replay = null; state.round.live = null; void openRound(r.cid, {push: false}); }
        return;
      }
    }
    catch {}
  }
}
function statusBadge(r) { const t=txStatus(recordStatus(r)); return `<span class="badge t-${e(t.tone)}">${e(t.label)}</span>`; }
const REST_OUTCOME = {ACCEPTED: '报告已接受', UNCONFIRMED: '报告未接受（不代表失败）', NOT_FOUND: '未找到（REST 也可能有保存期限；不代表失败）', ERROR: '查询未完成（不代表失败）'};
const REST_NODE = {VERIFIED: '节点已在该块完整复验，结果以节点为准', PRUNED: '节点已裁剪这段历史，既无法复验也无法反驳', UNAVAILABLE: '节点暂不可用，未能复验', CONFLICT: '节点与 REST 矛盾：以节点为准，保持结果未知', ERROR: '节点核对未完成，保持结果未知'};
function restBox(r) {
  const c = r.restCheck, w = r.restWitness; if (!c && !w) return '';
  const rows = [];
  if (c?.nodeSearch) rows.push(['节点自行查找', e(c.nodeSearch)]);
  if (c) rows.push(['最近一次 REST 查询', `${timeHtml(c.checkedAt)} · ${e(REST_OUTCOME[c.outcome] ?? '未知')}`]);
  if (c?.outcome === 'ACCEPTED' && !c.fields?.ok) rows.push(['字段比对', `<span class="err">与本机批准记录不一致或无法比对：${e(c.fields?.error ?? '')}</span>`]);
  if (w) {
    rows.push(['REST 接受证据', `首次观察 ${timeHtml(w.observedAt)}；接受块 ${hashHtml(w.acceptingBlockHash, {link: explorerBlock(w.acceptingBlockHash)})}`]);
    rows.push(['字段比对', `一致：${e(w.fields.compared)}`], ['REST 未提供', e(w.fields.unavailable)]);
  }
  if (c?.node) rows.push(['节点核对该接受块', e(c.node.result === 'PRUNED' && c.node.chainBlock === true ? '节点确认该块仍在当前选中链上，但接受数据已裁剪，无法逐字段复验' : c.node.result === 'PRUNED' ? `该块早于节点裁剪点（blue score ${c.node.pruningBlue ?? '?'}）已被删除，节点既无法复验也无法反驳` : REST_NODE[c.node.result] ?? c.node.result)]);
  return `<div class="notice small"><b>REST 备用查询</b>（${e(c?.source ?? w.source)}，第三方公开索引；只发送交易 ID）${facts(rows)}${c?.node?.error && c.node.result !== 'VERIFIED' ? `<p class="muted">节点信息：${e(c.node.error)}</p>` : ''}${c?.error ? `<p class="err">${e(c.error)}</p>` : ''}<p>REST 可能滞后或缓存；它只作历史证据展示。输入占用、归档门槛和后续轮次操作仍只认节点结果，不会因 REST 结果重发或释放。</p></div>`;
}
function showRecord(r, fresh = false) {
  modal(`${ACTION_LABEL[r.action] ?? r.action} · 交易记录`, `
    <div id="recTx" data-tx="${r.txid}"></div>
    <div class="notice ${needsAttention(r)?'warn':''}">${e(txStatus(recordStatus(r)).meaning)}</div>
    ${fresh && r.status === 'SUBMITTED' ? '<div class="notice ok">节点已接收交易。<b>接收 ≠ 接受</b>：页面会自动在选中链上核对，也可随时手动对账。</div>' : ''}
    ${r.status === 'UNKNOWN' && needsAttention(r) ? '<div class="notice warn">提交结果未知（例如网络中断）。交易可能已经广播。<b>不要重新创建同类交易</b>；请点击对账。相关输入在本页保持占用，防止重复花费。</div>' : ''}
    ${r.status === 'REJECTED' ? `<div class="notice bad">节点明确拒绝：${e(r.error ?? '')}。这是提交拒绝回执，不是整体余额证明。</div>` : ''}
    ${facts([['状态', statusBadge(r)], ['交易 ID', hashHtml(r.txid, {link: explorerTx(r.txid)})], ['轮次 CID', hashHtml(r.cid)], ['网络费', `${kas(r.fee)} TKAS`], r.actualFee !== undefined && ['实际费用', `${kas(r.actualFee)} TKAS`], r.accepting && ['接受块', hashHtml(r.accepting, {link: explorerBlock(r.accepting)})], r.locatedBy === 'REST' && ['接受块定位', 'REST 提供位置，节点已完整复验'], r.acceptingDaa && ['接受 DAA', String(r.acceptingDaa)], ['创建时间', timeHtml(r.createdAt)], r.verifiedAt && ['最近核验', timeHtml(r.verifiedAt)]])}
    ${restBox(r)}
    ${r.note ? `<p class="small muted">节点核对：${e(r.note)}</p>` : ''}${r.error && (needsAttention(r)||r.restCheck) ? `<p class="small muted">节点信息：${e(r.error)}</p>` : ''}
    <h3 style="margin:14px 0 8px">本机批准的输出</h3><div class="outs">${(r.outputs ?? []).map(o => `<div class="out ${o.mine ? 'mine' : ''}"><span class="r">${o.index} · ${e(roleLabel(o.role))}</span><span class="out-addr">${outAddressHtml(o)}</span><span class="v">${kas(o.value)}</span></div>`).join('')}</div>`,
    `${['UNKNOWN', 'REJECTED'].includes(recordStatus(r)) ? '<button class="btn warn" id="arch">检查是否可归档</button>' : ''}<button class="btn" id="dl">${icon('download')}导出</button>${r.status==='ARCHIVED'?'':'<button class="btn pri" id="rec">核对结果（不重发）</button>'}`);
  if ($('rec')) $('rec').onclick = async () => { $('rec').disabled = true; lockModal(true); try { const next=await engine.reconcile(r.txid,text=>{if($('rec')) $('rec').textContent=text;}); lockModal(false); showRecord(next); if(state.view==='mine') render(); } catch (err) { lockModal(false); toast(errorText(err), 'bad'); if($('rec')) $('rec').disabled = false; } };
  $('dl').onclick = () => download({kind: 'KASWIN_LOCAL_RECORD', ...r}, `kaswin-tx-${r.txid.slice(0, 12)}.json`);
  $('arch') && ($('arch').onclick = async () => {
    if (!confirm(text('归档将释放本页的输入占用，但不会撤回网络中的交易，也不代表原交易失败。只有节点明确拒绝或输入已失效时才允许。继续检查？'))) return;
    lockModal(true); try { await engine.archive(r.txid); lockModal(false); toast('已归档；不代表原交易未曾生效'); closeModal(); if (state.view === 'mine') render(); } catch (err) { lockModal(false); toast(errorText(err), 'bad'); }
  });
}

/* ================================================================== CREATE */
const DURATIONS = [['10', '10 分钟'], ['30', '30 分钟'], ['60', '1 小时'], ['360', '6 小时'], ['1440', '24 小时'], ['custom', '自定义']];
function renderCreate(v) {
  const f = state.createForm ??= {price: '1', cap: '256', min: '3', pcap: '256', dur: '60', custom: '120', registry: true};
  v.innerHTML = `
  <div class="cols">
    <div class="panel">
      <h2>${icon('create')} 创建一个新轮次</h2>
      <p class="sub">填写规则 → 查看完整费用 → 确认后提交。现在填写不会扣款，创建后的规则不可更改。</p>
      <div class="form">
        <label class="field">每张票价格（TKAS）<input id="cPrice" value="${e(f.price)}" inputmode="decimal" maxlength="20"><small>≥ 1 TKAS，最多 8 位小数</small></label>
        <label class="field">总票数上限<input id="cCap" value="${e(f.cap)}" inputmode="numeric" maxlength="6"><small>3 – 100,000</small></label>
        <label class="field">开奖最低票数<input id="cMin" value="${e(f.min)}" inputmode="numeric" maxlength="6"><small>≥ 3；封盘时不足则全部退款</small></label>
        <details class="full advanced"><summary>高级规则 <span class="muted small">每次购买占一条记录 · 默认最多256条</span></summary><label class="field">购买记录上限<input id="cPcap" value="${e(f.pcap)}" inputmode="numeric" maxlength="3"><small>1 – 256；记录满时可提前封盘，即使票未售罄</small></label></details>
        <div class="field full">最早可封盘时间<div class="pills" id="cDur">${DURATIONS.map(([k, l]) => `<button type="button" data-dur="${k}" aria-pressed="${f.dur === k}">${l}</button>`).join('')}</div>
          <input id="cCustom" value="${e(f.custom)}" inputmode="numeric" maxlength="5" placeholder="分钟（1–10080）" ${f.dur === 'custom' ? '' : 'hidden'}>
          <small id="cDaa">按 TN10 ≈ ${DAA_PER_SECOND} DAA/秒换算；创建前从节点读取当前 DAA。时间到后才“允许”封盘，不会自动封盘；满票或满记录可提前封盘。</small></div>
        <label class="check full"><input type="checkbox" id="cReg" ${f.registry ? 'checked' : ''}>附加 0.05 TKAS Registry 登记输出（供索引自动发现本轮）</label>
      </div>
      <p class="err" id="cErr"></p>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn pri" id="cGo">${icon('arrow')}核验并报价</button><button class="btn" id="cExport">${icon('download')}导出未签名配置</button></div>
    </div>
    <div>
      <div class="panel"><h3>预览</h3><div id="cPrev"></div></div>
      <div class="panel"><h3>你将支付</h3><dl class="kv"><dt>押金</dt><dd>0.2 TKAS（终局时退回：派奖/空轮/全部退款完成后）</dd><dt>Registry</dt><dd>0.05 TKAS（可选，转入固定登记地址）</dd><dt>网络费</dt><dd>按节点实时费率与交易质量精确报价，≤ 0.5 TKAS</dd></dl>
      <p class="small muted">创建者没有特权：任何人都能封盘、开奖、超时转退款或执行退款批次；创建者只在终局收回押金。</p></div>
    </div>
  </div>`;
  const read = () => {
    f.price = $('cPrice').value.trim(); f.cap = $('cCap').value.trim(); f.min = $('cMin').value.trim(); f.pcap = $('cPcap').value.trim(); f.custom = $('cCustom').value.trim(); f.registry = $('cReg').checked;
    const int = (s, lo, hi, n) => { ensure(/^[1-9][0-9]*$/.test(s) && +s >= lo && +s <= hi, `${n} 须为 ${lo}–${hi} 的整数`); return +s; };
    const minutes = f.dur === 'custom' ? int(f.custom, 1, 10080, '自定义分钟') : +f.dur;
    let price; try { price = kasToSompi(f.price); } catch { throw new UserError('票价格式错误（最多 8 位小数）'); }
    const cfg = {ticketPrice: price, ticketCap: int(f.cap, 3, 100000, '总票数'), purchaseCap: int(f.pcap, 1, 256, '购买记录上限'), minTickets: int(f.min, 3, 100000, '最低票数'), closeEligibleDaa: 1n};
    ensure(cfg.minTickets <= cfg.ticketCap, '最低票数不能超过总票数');
    ensure(price >= S.MIN_PRICE, '票价至少 1 TKAS');
    ensure(price <= (S.VALUE_LIMIT - S.DEPOSIT) / BigInt(cfg.ticketCap), '票价 × 总票数超出协议上限');
    return {cfg, minutes};
  };
  const preview = () => {
    try {
      const {cfg, minutes} = read(); $('cErr').textContent = '';
      const pool = cfg.ticketPrice * BigInt(cfg.ticketCap);
      $('cPrev').innerHTML = facts([['满票奖池', `${kas(pool)} TKAS`], ['满票时中奖者约得', `${kas(pool - S.FINALIZER)} TKAS（−1 TKAS 赏金 −网络费）`], ['单张中奖概率（满票）', `1 / ${cfg.ticketCap.toLocaleString()}`], ['最早封盘', `约 ${minutes >= 60 ? (minutes / 60).toFixed(minutes % 60 ? 1 : 0) + ' 小时' : minutes + ' 分钟'} 后`], ['购买记录', `${cfg.purchaseCap} 条（退款需 ${Math.ceil(cfg.purchaseCap / 32)} 批）`], ['不足 ' + cfg.minTickets + ' 张', '封盘后全部退款（每条扣 0.01 TKAS 执行费）']]);
    } catch (err) { $('cErr').textContent = errorText(err); $('cPrev').innerHTML = ''; }
  };
  v.querySelectorAll('input').forEach(i => i.addEventListener('input', preview));
  v.querySelectorAll('[data-dur]').forEach(b => b.onclick = () => { f.dur = b.dataset.dur; v.querySelectorAll('[data-dur]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); $('cCustom').hidden = f.dur !== 'custom'; preview(); });
  preview();
  $('cExport').onclick = () => { try { const {cfg, minutes} = read(); download({kind: 'KASWIN_F32_UNSIGNED_CONFIGURATION', profileId: PROFILE_ID, network: 'testnet-10', durationMinutes: minutes, config: {...cfg, closeEligibleDaa: '（创建时由节点 DAA 计算）'}, note: '仅参数，不是交易'}, 'kaswin-config.json'); } catch (err) { $('cErr').textContent = errorText(err); } };
  $('cGo').onclick = async () => {
    try {
      const {cfg, minutes} = read();
      if (!state.session) { await connectWallet(); if (!state.session) return; }
      $('cGo').disabled = true; $('cErr').textContent = '读取节点 DAA…';
      await pair.connect(); const daa = await pair.currentDaa(); state.daa = daa;
      cfg.closeEligibleDaa = daa + BigInt(minutes * 60 * DAA_PER_SECOND);
      $('cErr').textContent = '';
      await runPlan({action: 'GENESIS', config: cfg, registry: f.registry}, state.walletEpoch);
    } catch (err) { $('cErr').textContent = errorText(err); }
    finally { $('cGo') && ($('cGo').disabled = false); }
  };
}

/* ================================================================== MINE */
async function renderMine(v) {
  v.innerHTML = `<div class="section-title"><div><span class="eyebrow">MY ACTIVITY</span><h2>我的交易与轮次</h2></div><button class="btn" id="checkAll">核对所有待确认交易</button></div>
  <div class="notice small">这里是<b>当前站点、当前浏览器</b>保存的交易，不是钱包完整历史。同源 Opus / 使用相同记录库的 Gemini 记录可见；其他域名、端口或 Astra 不共享。核对只查询、不重发，也不会自动归档。提交超过 10 分钟、节点仍查不明时，会把<b>交易 ID</b>发给公共 REST 索引 <b>api-tn10.kaspa.org</b> 备查（对方可见你的 IP）。REST 给出的接受块会再交给节点复验：复验通过标为「已接受」；节点已裁剪该段历史标为「已接受 · REST」；节点与 REST 矛盾则以节点为准，保持未知。</div>
  <div class="panel"><div id="mineSummary"></div><div id="mineList">读取中…</div><p id="checkProgress" class="small muted"></p></div>
  <div class="panel"><h3>我参与的轮次（已读取详情的范围内）</h3><p id="mineRoundsNote" class="small muted"></p><div id="mineRounds" class="grid"></div></div>`;
  try {
    const recs = await engine.records();
    if (state.view !== 'mine' || !$('mineList')) return;
    const pending=recs.filter(needsAttention);
    $('mineSummary').innerHTML=`<div class="activity-count"><b>${pending.length}</b> 笔待确认 <span class="muted">/ 共 ${recs.length} 条本机记录</span></div>`;
    $('checkAll').disabled=!pending.length||state.checking;
    $('checkAll').onclick=async()=>{
      if(state.checking) return; state.checking=true;
      $('checkAll').disabled=true;
      try {
        for (const [i,r] of pending.slice(0,50).entries()) {
          if($('checkProgress')) $('checkProgress').textContent=`正在核对 ${i+1}/${Math.min(50,pending.length)}，不会广播…`;
          try { await engine.reconcile(r.txid,text=>{if($('checkProgress')) $('checkProgress').textContent=`${i+1}/${Math.min(50,pending.length)} · ${text}`;}); } catch {}
        }
      } finally { state.checking=false; }
      toast('本次有界核对完成；仍未知的记录继续保留输入占用');
      state.rows = await mergedRows();
      if(state.view==='mine') render();
    };
    $('mineList').innerHTML = recs.length ? `<div class="tablewrap"><table><thead><tr><th>时间</th><th>动作</th><th>状态</th><th>交易</th><th>费用</th><th></th></tr></thead><tbody>${recs.map((r, i) => `<tr><td>${timeHtml(r.createdAt)}</td><td>${e(ACTION_LABEL[r.action] ?? r.action)}</td><td>${statusBadge(r)}</td><td>${hashHtml(r.txid, {link: explorerTx(r.txid), n: 8, isTx: true})}</td><td>${kas(r.fee)}</td><td><button class="btn sm" data-rec="${i}">查看详情</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">还没有提交记录。</p>';
    v.querySelectorAll('[data-rec]').forEach(b => b.onclick = () => showRecord(recs[+b.dataset.rec]));
  } catch (err) { if($('mineList')) $('mineList').innerHTML = `<div class="notice warn">本地记录不可用：${e(errorText(err))}</div>`; }
  renderMineRounds();
  // The round list is otherwise refreshed only on the explore page: refresh it if older than 30 s.
  if (!state.liveAt || Date.now() - state.liveAt > 30_000) void loadRows({quiet: true});
}
function renderMineRounds() {
  if (state.view !== 'mine' || !$('mineRounds')) return;
  const me = state.session?.key;
  const mine = me ? state.rows.filter(r => { const d = state.details.get(r.cid); return d?.state && (d.state.ownerKey === me || d.purchases?.some(p => p.key === me)); }) : [];
  $('mineRoundsNote').innerHTML = state.live ? `轮次状态取自索引（${timeHtml(state.liveAt)} 读取），仍属待节点核验的候选信息。` : '索引暂未读取或不可用：以下为本机缓存/本机记录，可能不是最新状态。';
  $('mineRounds').innerHTML = !me ? '<div class="empty">连接钱包后显示你创建或购买过的轮次。</div>' : mine.length ? mine.map(card).join('') : '<div class="empty">已读取的详情中没有找到相关轮次；不代表全网没有你的参与记录。可在广场打开目标 CID。</div>';
  document.querySelectorAll('#mineRounds [data-cid]').forEach(c => c.onclick = () => openRound(c.dataset.cid));
}

/* ================================================================== FEE CALCULATOR (protocol page) */
function budgetPanel(pc) {
  const st = {purchaseCount: pc, cursor: 0, sold: pc, config: {minTickets: 3}};
  const rows = [['第 ' + Math.min(pc + 1, 256) + ' 笔购买', 'BUY', {...st, purchaseCount: Math.min(pc, 255)}], ['封盘 → 封存', 'CLOSE', st], ['封盘 → 退款', 'CLOSE', {...st, config: {minTickets: 100000}}], ['开奖派奖', 'DRAW_AND_PAY', st], ['超时转退款', 'TIMEOUT_REFUND', st], ['首批退款', 'REFUND', st], ['后续退款批', 'REFUND', {...st, cursor: Math.min(32, pc - 1)}]].filter(r => !(r[1] === 'REFUND' && r[2].cursor >= pc));
  return `<label class="field">购买记录数：<b id="budgetPcV">${pc}</b><input type="range" class="slider" id="budgetPc" min="1" max="256" value="${pc}"></label>
    <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>动作</th><th>compute budget</th><th>约占质量</th><th>最低网络费（约）</th></tr></thead><tbody>${rows.map(([l, a, s0]) => { const b = actionBudget(a, {...s0, phase: 1}); return `<tr><td>${e(l)}</td><td class="mono">${b}</td><td class="mono">${(b * 100).toLocaleString()} g</td><td class="mono">${kas(BigInt(b) * 10_000n)} TKAS 起</td></tr>`; }).join('')}</tbody></table></div>
    ${budgetChart()}
    <p class="small muted">交易手续费 = max(最低转发费, 节点费率 × 交易质量)，其中 compute budget 每单位计 100 g 质量。页面在报价时按实际交易精确计算，单笔上限 0.5 TKAS。</p>`;
}
function budgetChart() {
  const W = 520, H = 210, P = 30, fam = [['BUY', '#49eacb'], ['CLOSE', '#60a5fa'], ['DRAW_AND_PAY', '#f5c451'], ['TIMEOUT_REFUND', '#a78bfa'], ['REFUND', '#f87171']];
  const x = n => P + (W - 2 * P) * n / 256, y = b => H - P - (H - 2 * P) * b / 220;
  const path = a => Array.from({length: 256}, (_, i) => i + 1).map((n, i) => `${i ? 'L' : 'M'}${x(n).toFixed(1)},${y(actionBudget(a, {phase: 1, purchaseCount: a === 'BUY' ? n - 1 : n, cursor: a === 'REFUND' && n > 32 ? 32 : 0, sold: n, config: {minTickets: 3}})).toFixed(1)}`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="预算曲线"><g class="grid">${[0, 50, 100, 150, 200].map(b => `<line x1="${P}" x2="${W - P}" y1="${y(b)}" y2="${y(b)}"/><text x="2" y="${y(b) + 3}">${b}</text>`).join('')}${[0, 64, 128, 192, 256].map(n => `<text x="${x(n) - 6}" y="${H - 10}">${n}</text>`).join('')}</g>${fam.map(([a, c]) => `<path class="l" d="${path(a)}" stroke="${c}"/>`).join('')}</svg><div class="legend">${fam.map(([a, c]) => `<span><i style="--c:${c}"></i>${ACTION_LABEL[a]}</span>`).join('')}</div>`;
}

/* ================================================================== PROTOCOL */
function renderProtocol(v) {
  v.innerHTML = `
  <div class="cols">
    <div>
      <div class="panel"><h2>${icon('shield')} 你在信任什么</h2>
        <ul style="padding-left:18px;margin:0;display:grid;gap:8px">
          <li><b>Kaspa L1 共识</b>执行三份固定合约：每次状态转换的输出（金额、收款人、后继状态脚本）都由旧状态的脚本逐字节约束。</li>
          <li><b>随机数</b>来自封存 100 DAA 后首个跨越边界的选中链区块（PASS-A 序列承诺），合约在花费时用 OpChainblockSeqCommit 校验证明，伪造的证明只会让交易失败；不接受其他随机源，样本被拒也不重抽。</li>
          <li><b>本页</b>只是一个构建器：用嵌入的固定合约帧与核心库生成交易，用移植自 rusty-kaspa 的质量公式报价，用 BIP-340 校验钱包签名。</li>
          <li><b>Kaspa 节点</b>（默认 ${e(host(DEFAULT_NODE))} 提供的 kaspad 入口，可在设置中更换）是访问共识的入口：页面通过它读取 UTXO、接受数据与区块头，并提交交易。本页信任所配置节点如实反映 Kaspa 共识；资金规则本身由所有节点共同执行的合约脚本保证。</li>
          <li><b>Indexer</b> 只用于发现轮次和提供账本原文；所有数值在操作前都由节点复验。</li>
          <li><b>KasWare</b> 只签你自己的普通资金输入（SIGHASH_ALL）。v1 签名不覆盖 compute budget / storage mass，所以页面在签名后自行核对这些字段再提交。</li>
        </ul></div>
      <div class="panel"><h3>规则速查</h3><dl class="kv">
        <dt>购买</dt><dd>开放阶段任何人可买；每次购买追加一条目录记录（票号区间 + 买家公钥），票款精确进入状态 UTXO。</dd>
        <dt>封盘</dt><dd>满票、满设定的购买记录上限或到达封盘 DAA 后任何人可封：售出 ≥ 最低票数 → 封存；不足 → 退款；0 张 → 空轮，押金退创建者。</dd>
        <dt>开奖派奖</dt><dd>封存 ≥ 100 DAA 后任何人可执行，一笔交易内三个输出：中奖者（奖池 − 1 TKAS − 网络费）、创建者押金 0.2、执行者赏金 1 TKAS。网络费 ≤ 0.5 TKAS。</dd>
        <dt>超时</dt><dd>封存 ≥ 300 DAA 仍未开奖，任何人可转入退款阶段（仍需有人推进并能取得构建所需账本/证明；历史裁剪可能阻止本页构建）。</dd>
        <dt>退款</dt><dd>按购买顺序每批 32 条；每条退还 张数×票价 − 0.01 TKAS，0.01 进入执行费池付网络费、余额归执行者；最后一批同时退押金。</dd>
      </dl></div>
    </div>
    <div>
      <div class="panel"><h3>固定 Profile</h3>${facts([['Profile ID', hashHtml(PROFILE_ID)], ['网络 Genesis（TN10）', hashHtml(NETWORK_GENESIS)], ['SilverScript', `v1.0.0 · <span class="mono">${COMPILER_COMMIT.slice(0, 10)}</span>`], ['OPEN', `${hashHtml(profile.frames.open.templateHash)} · ${profile.frames.open.tail.length} B`], ['SEALED', `${hashHtml(profile.frames.sealed.templateHash)} · ${profile.frames.sealed.tail.length} B`], ['REFUNDING', `${hashHtml(profile.frames.refunding.templateHash)} · ${profile.frames.refunding.tail.length} B`]])}
        <p class="small muted">页面启动时用嵌入的模板尾部重新计算模板哈希与 Profile ID，不一致即拒绝运行。</p></div>
      <div class="panel"><h3>${icon('gauge')} 计算预算与费用</h3><div id="budgetBox">${budgetPanel(state.budgetPc ?? 128)}</div></div>
      <div class="panel"><h3>数据源设置</h3><button class="btn" id="pSettings">${icon('settings')}Indexer 与节点</button>
        <button class="btn" id="pTheme">${icon('sun')}切换主题</button></div>
    </div>
  </div>`;
  $('pSettings').onclick = settingsDialog;
  $('pTheme').onclick = toggleTheme;
  const bindBudget = () => { $('budgetPc').oninput = ev => { state.budgetPc = +ev.target.value; $('budgetBox').innerHTML = budgetPanel(state.budgetPc); bindBudget(); }; };
  bindBudget();
}
function settingsDialog() {
  const st = pair.status();
  modal('节点与索引配置', `<div class="notice small"><b>支持无证书连接：</b>节点可填 ws:// 或 wss://，索引器可填 http:// 或 https://。本页信任所选节点如实反映共识；切换地址是更换数据来源，不是增加独立验证。不会自动将明文地址改成加密地址。</div><div class="form">
    <label class="field full">Kaspa 节点（ws / wss · TN10 JSON wRPC，每行一个，按顺序使用第一个可用的）<textarea id="sNodes" rows="5" spellcheck="false" style="background:var(--panel2);border:1px solid var(--line2);border-radius:10px;padding:10px;font:12px var(--mono);color:var(--text)">${e(state.nodes.join('\n'))}</textarea>
      <small>默认 <span class="mono">${e(DEFAULT_NODE)}</span>（运营方提供的 TN10 kaspad 入口；其后为公共节点，仅在前面的不可用时按顺序使用）。页面只使用一个节点，通过它读取链上状态并提交交易；资金规则由 Kaspa 共识执行，节点只是访问共识的入口。也可填自建 kaspad（启动参数 --rpclisten-json），例如本机 <span class="mono">ws://127.0.0.1:18210</span> 或局域网 <span class="mono">ws://192.168.1.10:18210</span>。请填完整协议和端口；节点必须提供 JSON wRPC，不能填写 gRPC 或 Borsh 端口。</small></label>
    <label class="field full">Indexer（http / https · 轮次发现）<input id="sIdx" value="${e(state.indexer)}" spellcheck="false" placeholder="${e(DEFAULT_INDEXER)}">
      <small>默认 <span class="mono">${e(DEFAULT_INDEXER)}</span>。只用于列出轮次和提供账本原文；操作前页面会用节点核对。例如本机 <span class="mono">http://127.0.0.1:8788</span>、局域网 <span class="mono">http://192.168.1.10:8788</span>，也可填同源 <span class="mono">/indexer</span>。跨域服务需要允许当前网页来源（CORS）。</small></label>
    <details class="full small"><summary>没有证书，如何使用本地端口？</summary><p>把此 HTML 放到可信设备的本地 HTTP 静态服务中，例如用 <span class="mono">python3 -m http.server 8000 --bind 127.0.0.1</span> 提供专门只放网页的目录，然后打开 <span class="mono">http://127.0.0.1:8000/kaswin-v2.html</span>。节点填 ws://，索引器填 http://，无需证书。命令只提供静态文件，不代理 RPC，也不修复索引器 CORS；不要在钱包或私密文件目录运行。</p><p>更换网页协议、主机或端口会更换浏览器存储来源，旧交易记录不会自动搬过去；不要清站点数据或重发结果未知的交易。实际钱包扩展还需允许该网页来源，连接以浏览器和钱包的实际结果为准。</p></details>
    <div class="full" id="sWarn"></div></div>
    <div class="notice small" style="margin-top:6px">当前连接：${st.connected ? `<b>${e(st.nodes[0].host)}</b> · DAA ${e(String(st.nodes[0].daa))} · ${st.nodes[0].rtt} ms` : '未连接（首次需要链上数据时自动连接）'}</div>
    <p class="err" id="sErr"></p><div id="sProbe"></div>
    <details class="small" style="margin-top:8px"><summary class="muted">本机记住的轮次（${state.cached}）</summary><div id="sCache" style="margin-top:8px">读取中…</div></details>`,
    `<button class="btn" id="sTest">${icon('refresh')}测试连接</button><button class="btn" id="sReset">恢复默认</button><button class="btn pri" id="sSave">保存</button>`);
  const warn = () => { try {
    const nodes = $('sNodes').value.split(/\s+/).filter(Boolean).map(nodeUrl);
    const notices = connectionNotices({nodes, indexer: indexerBase($('sIdx').value)});
    $('sWarn').innerHTML = notices.map(w => `<div class="notice warn small">${e(w)}</div>`).join(''); $('sErr').textContent = '';
  } catch (err) { $('sWarn').innerHTML = ''; $('sErr').textContent = errorText(err); } };
  $('sIdx').oninput = $('sNodes').oninput = warn; warn();
  $('sReset').onclick = () => { $('sIdx').value = DEFAULT_INDEXER; $('sNodes').value = DEFAULT_NODES.join('\n'); warn(); };
  $('sTest').onclick = async () => {
    $('sProbe').innerHTML = '<div class="notice">测试中…</div>';
    const parts = [];
    try {
      const urls = $('sNodes').value.split(/\s+/).filter(Boolean).map(nodeUrl);
      const link = new NodeLink(urls); await link.connect(); const s2 = link.status(); link.close();
      parts.push(`<div class="notice ok">节点可用：<b>${e(s2.nodes[0].host)}</b>（TN10 已同步，含 UTXO 索引，${s2.nodes[0].rtt} ms）${s2.rejected.length ? `<br><span class="small">之前尝试失败：${s2.rejected.map(r => `${e(host(r.url))}：${e(r.reason)}`).join('；')}</span>` : ''}</div>`);
    } catch (err) { parts.push(`<div class="notice warn">节点：${e(errorText(err))}<br>请检查服务是否已启动、地址/端口/防火墙、JSON wRPC，以及上方浏览器连接提示。明文地址可以保存，但网页无法解除混合内容或本地网络权限限制。</div>`); }
    try { const p = await listRounds(indexerBase($('sIdx').value), {limit: 200}); parts.push(`<div class="notice ok">Indexer 可用：${p.items.length} 个轮次${p.lastCheckpointAt ? `，检查点 ${timeHtml(p.lastCheckpointAt)}` : ''}。</div>`); }
    catch (err) { const m = errorText(err); parts.push(`<div class="notice warn">Indexer：${e(m)}${/fetch|Failed|NetworkError|Load failed/i.test(m) ? '<br>可能是服务/网络不可达、CORS、混合内容或本地网络权限限制。请检查服务、端口与上方提示；索引器需允许当前网页的 Origin。用本地 HTTP 打开网页不需要证书，但不会自动消除跨域限制。' : ''}</div>`); }
    if ($('sProbe')) $('sProbe').innerHTML = parts.join('');
  };
  void catalog.list().then(list => {
    if (!$('sCache')) return;
    $('sCache').innerHTML = list.length ? list.map(c => `<div style="display:flex;gap:8px;align-items:center;margin:3px 0"><span class="mono">${e(shortHash(c.cid, 10, 6))}</span><span class="muted">${e((c.sources ?? []).join(' / '))}</span><span class="spacer"></span><button class="btn sm" data-forget="${c.cid}">移除</button></div>`).join('') : '<span class="muted">还没有记住任何轮次。</span>';
    $('sCache').querySelectorAll('[data-forget]').forEach(b => b.onclick = async () => { await catalog.forget(b.dataset.forget); state.details.delete(b.dataset.forget); b.parentElement.remove(); state.rows = await mergedRows(); });
  });
  $('sSave').onclick = () => {
    try {
      const idx = indexerBase($('sIdx').value), urls = [...new Set($('sNodes').value.split(/\s+/).filter(Boolean).map(nodeUrl))];
      ensure(urls.length >= 1, '至少需要一个节点');
      state.indexer = idx; state.nodes = urls; LS.set('indexer', idx); LS.set('nodes', urls); LS.set('configVersion', CONFIG_VERSION);
      pair.close(); pair = new NodeLink(urls); pair.onChange(renderNodeChip);
      engine = new Engine({pair, profile, indexer: idx});
      closeModal(); toast('已保存'); renderNodeChip(); void loadRows();
    } catch (err) { $('sErr').textContent = errorText(err); }
  };
}
function renderPreferences() {
  $('settingsBtn').innerHTML = icon('settings');
  $('settingsBtn').title = text('数据源设置');
  $('settingsBtn').setAttribute('aria-label', text('数据源设置'));
  if ($('githubBtn')) {
    $('githubBtn').innerHTML = icon('github');
    $('githubBtn').title = text('GitHub 源码仓库');
    $('githubBtn').setAttribute('aria-label', text('GitHub 源码仓库'));
  }
  const target = state.theme === 'dark' ? 'sun' : 'moon';
  const label = state.theme === 'dark' ? '切换为浅色模式' : '切换为深色模式';
  for (const b of [$('themeBtn'), $('pTheme')].filter(Boolean)) {
    b.setAttribute('data-no-i18n', '');
    b.innerHTML = icon(target) + (b.id === 'pTheme' ? text(label) : '');
    b.dataset.icon = target; b.title = text(label); b.setAttribute('aria-label', text(label));
  }
  $('languageBtn').textContent = getLanguage() === 'en' ? '中文' : 'EN';
  $('languageBtn').title = $('languageBtn').getAttribute('aria-label');
  $('localZone').textContent = text(`本地时区：${localTimeZone()}`);
}
function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = state.theme; LS.set('theme', state.theme); renderPreferences(); }
$('languageBtn').onclick = () => {
  // No reload or re-render: preserve forms, approval checkbox, TTL, modal and pending operations.
  setLanguage(getLanguage() === 'en' ? 'zh-CN' : 'en'); LS.set('language', getLanguage());
  refreshLanguage(); renderPreferences();
};
$('themeBtn').onclick = toggleTheme;
$('settingsBtn').onclick = settingsDialog;
$('nodeChip').onclick = async () => { try { await pair.connect(); state.daa = await pair.currentDaa(); toast(`节点已连接 · DAA ${state.daa}`); } catch (err) { toast(errorText(err), 'bad'); } };

/* ------------------------------------------------------------------ start */
route();
void mergedRows().then(rows => { state.rows = rows; if(state.view==='explore') render(); }).then(() => loadRows({quiet: true}));
// Keep the live view fresh while the tab is visible.
setInterval(() => { if (document.visibilityState === 'visible' && ['explore', 'mine'].includes(state.view)) void loadRows({quiet: true}); }, 60_000);
document.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches?.('.card')) ev.target.click(); });
