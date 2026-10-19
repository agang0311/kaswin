/** Kaswin V2.0.2 / TN10 — adapted from Opus, with Astra source labels and Gemini navigation ideas. */
import {S, PROFILE_ID, COMPILER_COMMIT, CONTRACT_TAG, makeProfile, unhex, hex, kas, shortHash, escapeHtml as e, ensure, errorText, daaDuration,
  actionBudget, BUDGET_MARGIN, availableActions, kasToSompi, FEE_CAP, UserError, DAA_PER_SECOND, IndexedStore} from '../../scripts/core.mjs';
import {networkOf, loadNetworkKey, saveNetworkKey, NETWORK_KEYS, NETWORKS} from './network.mjs';
import {createPublicNetworkContext} from '../../scripts/chain/network-context.mjs';
import {host, nodeUrl} from '../../scripts/chain/nodes.mjs';
import {DualNodeLink as NodeLink} from '../../scripts/chain/dual-node.mjs';
import {RoundDiscovery} from '../../scripts/round/discovery.mjs';
import {RoundTracker} from '../../scripts/tracking/round-tracker.mjs';
import {ForegroundRecovery, pendingRecoveryRecords} from '../../scripts/tracking/foreground-recovery.mjs';
import {webEndpoints, CONFIG_VERSION, migrateConfig, connectionNotices} from '../../scripts/chain/endpoints.mjs';
import {ACTION_LABEL, roleLabel} from '../../scripts/round/engine.mjs';
import {Engine} from '../../scripts/round/engine.mjs';
import {txStatus, txLabel, recordStatus as networkRecordStatus, needsAttention as networkNeedsAttention, plannedActions, cardStep, planSummary, walletFlow, CLOSE_OUTCOME, waitText} from '../ui/view.mjs';
import {drawReadinessView} from '../ui/draw-readiness.mjs';
import {readSession, waitForProvider, watchWallet, provider} from '../../scripts/wallet/kasware.mjs';
import {BROWSER_TEST_WALLET_ENABLED, browserTestWallet, importBrowserTestWallet, clearBrowserTestWallet, isBrowserTestWallet} from '../../scripts/wallet/browser-test.mjs';
import {indexerBase, listRounds, roundDetail, ledgerFromDetail, liveRound, viewFromLive, checkRow, stateConfirming, indexerBehind, phaseInfo as basePhaseInfo} from '../../scripts/round/rounds.mjs';
import {chooseView} from '../../scripts/round/progress.mjs';
const phaseInfo = row => { const p = basePhaseInfo(row); return p.key === 'refunded' ? {...p, label:'退款完成'} : p; };
import {replayAccepted} from '../../scripts/round/replay.mjs';
import {addressToSpk} from '../../scripts/wallet/address.mjs';
import {RoundCatalog} from './catalog.mjs';
import {frames as FRAMES} from '@kaswin/data';
import {chooseLanguage, getLanguage, setLanguage, installLocalization, formatLocalTime, localTimeZone, text} from '../ui/i18n.mjs';

/* ------------------------------------------------------------------ network binding */
/** The selected network is a runtime choice. Everything network-derived (context, explorer links, settings namespace,
 * endpoints, node link, engine, discovery, round cache) is rebuilt by bindNetwork(); the contract Profile is
 * network-free, so it is built once. Mainnet trading stays behind its own release gate (scripts/release-safety.mjs). */
let NET = networkOf(loadNetworkKey());
let context, LS, SETTINGS_PREFIX, DEFAULT_NODE, DEFAULT_NODES, DEFAULT_INDEXER;
let explorerTx, explorerAddress, explorerBlock, pubkeyToAddress, spkToAddress;
let pair, engine, discovery, catalog, CONFIG;
let detailTracker = null, listRequest = null;
let recovery = null, activeExecution = null, activeQuote = null, planningEpoch = 0;
const U = () => NET.unit;
const recordStatus = r => networkRecordStatus(r, NET);
const needsAttention = r => networkNeedsAttention(r, NET);

/* ------------------------------------------------------------------ boot */
const profile = makeProfile(Object.fromEntries(Object.entries(FRAMES).map(([m, f]) => [m, {...f, tail: unhex(f.tail)}])));
if (profile.id !== PROFILE_ID) throw new Error('嵌入的合约帧与固定 Profile 不一致，页面拒绝运行');
const $ = id => document.getElementById(id);
/** (Re)bind every network-derived value and rebuild the runtime objects for the selected network. */
function bindNetwork(key) {
  NET = networkOf(key);
  context = createPublicNetworkContext(NET);
  ({explorerTx, explorerAddress, explorerBlock, address: pubkeyToAddress, spkAddress: spkToAddress} = context);
  ({node: DEFAULT_NODE, nodes: DEFAULT_NODES, indexer: DEFAULT_INDEXER} = webEndpoints(NET));
  SETTINGS_PREFIX = NET.web?.legacyConfig ? 'kaswin-v2:' : `kaswin-v2:${NET.genesis}:`;
  LS = {get(k, d) { try { const v = localStorage.getItem(SETTINGS_PREFIX + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(SETTINGS_PREFIX + k, JSON.stringify(v)); } catch {} }};
}
/** Endpoint configuration (see endpoints.mjs). Defaults come from the selected network and are editable in Settings. */
function loadConfig() {
  const v = LS.get('configVersion', 0);
  if (v < CONFIG_VERSION) {
    const m = migrateConfig({version: v, nodes: LS.get('nodes', null), indexer: LS.get('indexer', null)}, NET);
    LS.set('nodes', m.nodes); LS.set('indexer', m.indexer); LS.set('configVersion', m.version);
  }
  const nodes = LS.get('nodes', null), indexer = LS.get('indexer', null);
  return {indexer: indexer === '' ? null : indexer || DEFAULT_INDEXER, nodes: Array.isArray(nodes) && nodes.length ? nodes : [...DEFAULT_NODES]};
}
bindNetwork(NET.key);
setLanguage(chooseLanguage(LS.get('language', null), navigator.languages));
const refreshLanguage = installLocalization();
CONFIG = loadConfig();
const state = {
  view: 'explore', indexer: CONFIG.indexer, live: null, liveAt: null, liveError: null, cached: 0, nodes: CONFIG.nodes,
  rows: [], details: new Map(), nodeViews: new Map(), meta: null, error: null, busy: false, filter: 'all', query: '', sort: 'new', saved: new Set(LS.get('saved', [])),
  otherRoundsOpen: false, nodeRecovering: false,
  session: null, walletEpoch: 0, round: null, roundLive: null, records: [], daa: null, theme: LS.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
};
document.documentElement.dataset.theme = state.theme;
function buildRuntime() {
  recovery?.pause(); state.nodeRecovering = false;
  engine?.dispose();
  if (pair) pair.close();
  stopDetail();
  pair = new NodeLink(state.nodes, {net: NET});
  pair.onChange(renderNodeChip);
  engine = new Engine({net: NET, pair, profile, indexer: safeBase(state.indexer), onLive: rememberNodeView, resolveRound: resolveCurrentRound, onAccepted: relayAccepted});
  catalog = new RoundCatalog(() => IndexedStore.open('kaswin-v2-rounds'), {network: NET.genesis});
  discovery = new RoundDiscovery({net: NET, base: safeBase(state.indexer), profile, evidence: engine.evidence});
}
buildRuntime();
function relayAccepted({cid, ev, context}) {
  if (detailTracker?.cid !== cid) return;
  if (detailTracker.evidence === engine.evidence) return; // both consumers already subscribe to the same evidence service
  detailTracker.offerAccepted({ev, context});
  const R = state.view === 'round' ? state.round : null;
  if (R?.cid === cid && !detailTracker.observationCurrent()) { R.syncing = true; R.live = null; render(); }
}
async function resolveCurrentRound(cid) {
  // All five non-GENESIS actions share the active detail session, including its in-flight node verification.
  // Display candidates and disk-loaded `verified` labels never select the fast path themselves.
  const tracker = detailTracker;
  if (tracker?.cid === cid && !tracker.stopped) return tracker.currentLive();
  return discovery.live(pair, cid, {known: (await catalog.get(cid))?.view});
}
function markDetailForRecovery() {
  const R = state.view === 'round' ? state.round : null;
  if (!R?.detail) return;
  if (R.detail.terminalSettled === true && R.detail._src === 'node') {
    R.history = true; R.historyAt ??= R.verifiedAt ?? R.detail.updatedAt;
    return;
  }
  if (R.live || R.detail._src === 'node') R.verifiedAt ??= R.detail.updatedAt;
  R.recovering = true; R.syncing = true; R.recoveryFailure = false; R.live = null;
  state.nodeViews.delete(R.cid);
  if (R.detail._src === 'node') R.detail = {...R.detail, _src: 'cache'};
}
function stopDetail() {
  if (state.round?.confirmTimer) clearTimeout(state.round.confirmTimer);
  if (state.round?.drawTimer) { clearInterval(state.round.drawTimer); state.round.drawTimer = null; }
  const cid = detailTracker?.cid;
  detailTracker?.stop(); detailTracker = null;
  if (state.round) state.round.nodeProgress = null;
  if (cid) state.nodeViews.delete(cid);
}
function adoptVerifiedRound(R, tracker) {
  if (state.round !== R || tracker?.cid !== R.cid || !tracker.observationCurrent() || tracker.observation.result.incomplete) return false;
  const result = tracker.observation.result, d = result.view;
  state.nodeViews.set(R.cid, d);
  R.detail = d; R.live = result.live ?? null; R.liveError = null; R.replay = result.replay ?? null; R.replayError = null;
  R.history = false; R.error = null; R.loading = false; R.verifiedAt = d.verifiedAt ?? d.updatedAt ?? Date.now();
  R.recovering = false; R.recoveryFailure = false; R.syncing = false; R.syncError = null; R.nodeProgress = null;
  R.staleNote = result.terminal && !result.terminalSettled ? '终局首次接受已核验，等待 100 DAA 后重新核验' : null;
  if (result.live) state.daa = result.live.snapshot.currentDaa;
  return true;
}
function trackDetail(cid, {force = false} = {}) {
  if (detailTracker) stopDetail();
  if (document.visibilityState === 'hidden') return;
  const R = state.round;
  if (!force && R.detail?.terminalSettled === true && R.detail?._src === 'node') {
    R.tracking = 'CURRENT'; R.staleNote = null; R.loading = false; R.recovering = false; R.syncing = false;
    render();
    return;
  }
  const tracker = new RoundTracker({link: pair, discovery, store: catalog, profile, cid, evidence: engine.evidence,
    onDrawProgress() {
      if (detailTracker === tracker && state.round === R && state.view === 'round') updateDrawReadiness();
    },
    onStatus(status, error) {
      if (detailTracker !== tracker || state.round !== R || state.view !== 'round') return;
      R.tracking = status; R.loading = !R.detail && !error;
      if (['SYNCING', 'CATCHING_UP', 'UNAVAILABLE'].includes(status)) R.syncing = !tracker.observationCurrent();
      if (status === 'CATCHING_UP') R.staleNote = '链上状态已变化，正在同步最新状态；约 2 秒后重试';
      if (status === 'UNAVAILABLE') { R.recoveryFailure = !!R.recovering; state.nodeViews.delete(cid); R.live = null; if (R.detail?._src === 'node') R.detail = {...R.detail, _src: 'cache'}; }
      const verifiedTerminal = R.detail?.terminalSettled === true && R.detail?._src === 'node';
      if (verifiedTerminal || status === 'CURRENT') R.staleNote = null;
      else if (error) R.staleNote = String(error?.message || error) === 'READ_VIEW_CHANGED' ? '节点链视图更新中，正在重试…' : errorText(error);
      else if (!R.staleNote && R.detail?.indexStatus === 'STALE') R.staleNote = '正在核对链上最新状态';
      // SYNCING/candidate callbacks keep the last failure visible until a complete CURRENT result clears it.
      if (!R.detail && error) R.error = errorText(error);
      render();
    },
    onUpdate(result) {
      if (detailTracker !== tracker || state.round !== R || state.view !== 'round') return;
      const d = result.view;
      if (result.incomplete) {
        if (Object.hasOwn(result, 'progress')) R.nodeProgress = result.progress;
        // A discovery candidate is display-only. It must not erase a verified snapshot while the SAME session refreshes.
        if (!R.live && (!R.recovering || !R.detail)) R.detail = d?._src === 'node' ? {...d, _src: 'cache'} : d;
        R.syncing = true; R.loading = false; R.error = null; render();
        return;
      }
      if (!adoptVerifiedRound(R, tracker)) return;
      finishRoundSync(R, tracker);
      finishRejectedSync(R, tracker);
      refreshOpenRecord(R.cid);
      render(); // A current detail proof must never wait behind a merge of every historical round/transaction.
      void mergedRows().then(rows => { if (detailTracker === tracker && state.round === R) state.rows = rows; }).catch(() => {});
    }});
  detailTracker = tracker;
  tracker.start();
  return tracker;
}
function safeBase(v) { try { return v ? indexerBase(v) : null; } catch { return DEFAULT_INDEXER ? indexerBase(DEFAULT_INDEXER) : null; } }

/* ------------------------------------------------------------------ icons */
import {icon} from '../ui/icons.mjs';

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
  if (view !== 'round') stopDetail();
  state.view = view;
  const hash = view === 'round' && param ? `#/round/${param}` : `#/${view}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  render();
}
window.addEventListener('popstate', route);
function route() {
  stopDetail();
  const m = /^#\/(\w+)(?:\/([0-9a-f]{64}))?$/.exec(location.hash);
  if (m && VIEWS.includes(m[1])) { state.view = m[1]; if (m[1] === 'round' && m[2]) openRound(m[2], {push: false}); else render(); }
  else { state.view = 'explore'; render(); }
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

/* ------------------------------------------------------------------ data sources */
/** One displayed view per CID from: live indexer, node-verified snapshots, this browser's own accepted transactions and
 * remembered rounds (IndexedDB). chooseView() orders them by the round's monotone state progress, never by comparing
 * timestamps from different machines. Nothing is dropped just because a source is offline. */
async function mergedRows() {
  const src = new Map(), slot = cid => src.get(cid) ?? src.set(cid, {}).get(cid);
  const remembered = await catalog.list();
  state.cached = remembered.length;
  for (const c of remembered) if (c?.cid) slot(c.cid).cache = {...(cachedView(c) ?? {cid: c.cid, contract: CONTRACT_TAG, indexStatus: 'UNKNOWN', phase: null, terminal: null, value: '0', updatedAt: Number.isSafeInteger(c.updatedAt) ? c.updatedAt : null}), _src: 'cache'};
  for (const c of remembered) if (c?.observed && c.view?.state) slot(c.cid).node = {...c.view, _src: c.verified ? 'node' : 'cache'};
  const records = await engine.records().catch(() => []); // one journal read for the whole merge, never one per CID
  for (const cid of await localCids(records)) { const d = await localDetail(cid, records); if (d) slot(cid).local = d; }
  for (const r of state.live ?? []) { const d = state.details.get(r.cid); slot(r.cid).index = d && r.latestTxid && d.latestTxid === r.latestTxid ? d : r; }
  for (const [cid, v] of state.nodeViews) slot(cid).node = v;
  return [...src.values()].map(chooseView).filter(Boolean);
}
/** The displayed view of a round, if it carries a decoded ledger. */
const shownDetail = cid => state.rows.find(r => r.cid === cid && r.state) ?? null;
/** IndexedDB views are untrusted (an older page or a hostile indexer may have written them): same schema checks as live rows. */
function cachedView(c) { try { return c?.view && c.view.cid === c.cid ? checkRow(c.view, {cached: true}) : null; } catch { return null; } }
async function localCids(records = null) { try { return [...new Set((records ?? await engine.records()).filter(r => !['REJECTED', 'ARCHIVED'].includes(r.status)).map(r => r.cid))]; } catch { return []; } }
async function loadRows({quiet = false, more = false} = {}) {
  if (state.loadingRows) return;
  state.loadingRows = true;
  const request = listRequest = new AbortController();
  if (!quiet) { state.busy = true; render(); }
  state.liveError = null;
  try {
    const p = more && state.listCursor
      ? await discovery.page({cursor: state.listCursor, signal: request.signal})
      : await discovery.refresh({known: state.rows, signal: request.signal});
    if (request !== listRequest) return;
    const rows = p.items;
    state.meta = {source: p.source === 'indexer' ? state.indexer : 'REST 备用查询', lastCheckpointAt: p.lastCheckpointAt, coverage: p.coverage, rejected: p.rejected};
    const incoming = rows.map(r => ({...r, _src: p.source === 'indexer' ? 'live' : r._src ?? 'rest'}));
    state.live = [...new Map([...(more ? state.live ?? [] : []), ...incoming].map(r => [r.cid, r])).values()]; state.liveAt = Date.now();
    state.listCursor = p.nextCursor; state.listLimited = !!p.nextCursor;
    for (const r of state.live) {
      if (r.state) state.details.set(r.cid, r);
      await catalog.remember(r.cid, {view: r, source: p.source});
    }
  } catch (err) {
    if (request !== listRequest) return;
    state.liveError = errorText(err);
    // Previous responses are no longer a live source after this refresh failed.
    state.live = null;
  }
  if (request !== listRequest) return;
  state.rows = await mergedRows();
  if (request !== listRequest) return;
  state.busy = false; state.loadingRows = false;
  if (state.view === 'explore') render();
  else if (state.view === 'mine') renderMineRounds();
}

/* ------------------------------------------------------------------ chips */
function renderNodeChip() {
  const st = pair.status(), el = $('nodeChip');
  if (!el) return;
  const n = st.nodes[0];
  if (state.nodeRecovering) {
    el.innerHTML = `<span class="dot"></span>${e(text('恢复节点核验中…'))}`;
    el.title = text(activeExecution?.engine === engine ? '等待当前签名或提交完成后恢复核验' : '正在检查节点连接与当前链状态');
    return;
  }
  el.innerHTML = `<span class="dot ${st.connected ? 'ok' : ''}"></span>${st.connected ? e(n.host.replace(/:443$/, '')) : '节点未连接'}`;
  el.title = st.connected ? `${n.url}\n${NET.label} 已同步 · DAA ${n.daa} · ${n.rtt} ms` : `首次需要链上数据时自动连接：${state.nodes[0]}`;
}
/** Network switch. Switches the DATA SOURCE only: it never signs, submits, or moves funds, and it never turns a
 * read-only build into a trading one. Mainnet keeps its own release gate (scripts/release-safety.mjs). */
function renderNetworkChip() {
  const b = $('netSwitch'), label = $('netSwitchLabel'), foot = $('footNetwork');
  if (b) {
    b.dataset.net = NET.key;
    b.title = `${NET.label}（${NET.unit}）· 点击切换网络 / Click to switch network`;
    if (label) label.textContent = NET.label;
  }
  if (foot) foot.textContent = `${NET.label} · ${NET.key === 'mainnet' ? `${NET.unit}（真实价值）` : `${NET.unit} 测试币`}`;
}
async function switchNetwork(key) {
  if (!NETWORK_KEYS.includes(key) || key === NET.key) return;
  const to = NETWORKS[key];
  if (to.key === 'mainnet' && !await confirmNetworkSwitch(to)) return;
  disconnectWallet();
  saveNetworkKey(key);
  // Rebind everything network-derived, then reload so no stale view, cache or wallet session carries over.
  bindNetwork(key);
  location.reload();
}
function confirmNetworkSwitch(to) {
  return new Promise(resolve => {
    modal('切换到 Kaspa 主网', `<div class="notice warn"><b>主网使用真实价值的 KAS。</b>切换网络本身不会签名或提交交易。签名前请核对网络、收款方和金额；只读页面不能签名或提交。</div>
      <p class="small muted">切换只更换数据来源，不会迁移或清除任何本地记录：两个网络的轮次缓存、交易记录和输入占用按各自 genesis 分开保存。</p>`, '');
    $('mFoot').innerHTML = `<button class="btn" id="nsCancel">取消</button><button class="btn warn" id="nsGo">切换到 ${e(to.label)}</button>`;
    $('mFoot').hidden = false;
    $('nsCancel').onclick = () => { closeModal(); resolve(false); };
    $('nsGo').onclick = () => { closeModal(); resolve(true); };
  });
}
$('netSwitch').onclick = () => switchNetwork(NET.key === 'tn10' ? 'mainnet' : 'tn10');
function renderWalletChip() {
  const b = $('walletBtn');
  if (state.session) { b.classList.add('on'); b.innerHTML = `${icon('wallet')}<span class="mono">${e(shortHash(state.session.address.slice(10), 5, 4))}</span>`; }
  else { b.classList.remove('on'); b.innerHTML = `${icon('wallet')}<span>${BROWSER_TEST_WALLET_ENABLED && NET.key === 'tn10' ? '连接钱包' : '连接 KasWare'}</span>`; }
}

/* ------------------------------------------------------------------ wallet */
let unwatchWallet = null;
function disconnectWallet() {
  unwatchWallet?.(); unwatchWallet = null;
  clearBrowserTestWallet();
  state.session = null; state.walletEpoch++;
  if ($('testWalletKey')) $('testWalletKey').value = '';
}
async function connectProvider(p = null) {
  const epoch = ++state.walletEpoch;
  try {
    p ??= await waitForProvider();
    const session = await readSession(p, {net: NET, request: true});
    ensure(epoch === state.walletEpoch && p === provider(), '钱包会话已变化，计划作废');
    unwatchWallet?.();
    state.session = session;
    toast(isBrowserTestWallet(p) ? '已连接 TN10 内存测试钱包，每笔交易仍须批准' : '已连接 KasWare（仅读取账户，不授予任何签名权限）');
    unwatchWallet = watchWallet(async () => {
      if (p !== provider()) return;
      const changedEpoch = ++state.walletEpoch;
      try {
        const next = await readSession(p, {net: NET});
        if (changedEpoch !== state.walletEpoch || p !== provider()) return;
        state.session = next; toast('钱包账户或网络已变化，未完成的报价已作废', 'warn');
      } catch (err) {
        if (changedEpoch !== state.walletEpoch || p !== provider()) return;
        state.session = null; toast(errorText(err), 'warn');
      }
      renderWalletChip(); render();
    }, p);
  } catch (err) {
    if (epoch === state.walletEpoch) {
      disconnectWallet();
      modal('连接钱包', `<div class="notice warn">${e(errorText(err))}</div><p class="muted">未连接钱包时，仍可浏览轮次、复验链上结果和使用费用计算器。</p>`);
    }
  }
  renderWalletChip(); render();
}
async function connectWallet() {
  if (state.session) return walletDialog();
  if (BROWSER_TEST_WALLET_ENABLED && NET.key === 'tn10') return testWalletDialog();
  return connectProvider();
}
function testWalletDialog() {
  return new Promise(resolve => {
    modal('连接钱包', `<p>选择 KasWare，或导入专用 TN10 测试私钥用于浏览器测试。</p>
      <div class="notice warn" id="testWalletNote">只使用专用测试钱包，不要输入主网钱包私钥或助记词。私钥仅留在当前页面内存；断开、切换网络或离开页面后清除。每笔交易仍须核对并批准。</div>
      <label class="field" for="testWalletKey"><span>TN10 测试私钥（64 位十六进制）</span>
        <input id="testWalletKey" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="64" aria-describedby="testWalletNote" data-no-i18n>
      </label>
      <div id="testWalletError" class="err" role="alert"></div>`,
      `<button class="btn" id="connectKasware">连接 KasWare</button><button class="btn pri" id="importTestWallet">导入测试钱包</button>`);
    const field = $('testWalletKey'), error = $('testWalletError');
    let pending = false;
    modalCleanup = () => { field.value = ''; if (pending) disconnectWallet(); resolve(); };
    const finish = () => { field.value = ''; modalCleanup = null; closeModal(); resolve(); };
    const disable = () => { $('connectKasware').disabled = true; $('importTestWallet').disabled = true; };
    $('connectKasware').onclick = async () => {
      field.value = ''; disable(); disconnectWallet(); pending = true;
      await connectProvider();
      // connectProvider may replace the dialog with an error; keep that error visible.
      if (field.isConnected) finish(); else resolve();
    };
    $('importTestWallet').onclick = async () => {
      let value = field.value, p;
      field.value = ''; error.textContent = '';
      try { p = importBrowserTestWallet(value, {net: NET}); }
      catch (err) {
        const messages = {TEST_WALLET_KEY_FORMAT: '请输入 64 位十六进制测试私钥', TEST_WALLET_KEY_RANGE: '测试私钥不是合法的 secp256k1 标量', TEST_WALLET_SECURE_CONTEXT_REQUIRED: '测试钱包需要 HTTPS 或 localhost 安全上下文'};
        error.textContent = text(messages[errorText(err)] ?? errorText(err)); return;
      }
      finally { value = ''; }
      disable(); pending = true;
      await connectProvider(p);
      if (field.isConnected) finish(); else resolve();
    };
  });
}
async function walletDialog() {
  const s = state.session, memory = isBrowserTestWallet(provider());
  modal('钱包', `${facts([['钱包类型', memory ? 'TN10 内存测试钱包' : 'KasWare'], ['网络', NET.label], ['地址', hashHtml(s.address, {link: explorerAddress(s.address), n: 14})], ['x-only 公钥', hashHtml(s.key)]])}
    <div id="balBox" class="notice">正在从节点读取可用余额…</div>
    <p class="muted small">${memory ? '私钥仅在当前页面内存；断开即清除。仅签署本页逐笔批准的普通资金输入。' : '本页只请求签名你明确批准的单笔交易中属于你的普通输入；永远不会调用 sendKaspa/pushTx，也不会读取私钥。'}</p>`,
    `<button class="btn" id="wDisc">${memory ? '断开并清除私钥' : '断开本页会话'}</button>`);
  $('wDisc').onclick = () => { disconnectWallet(); renderWalletChip(); closeModal(); render(); };
  try {
    const {commonUtxos} = await import('../../scripts/chain/chain.mjs');
    const u = await commonUtxos(pair, s.address), plain = u.filter(x => !x.covenantId), total = plain.reduce((a, x) => a + x.value, 0n);
    if ($('balBox')) $('balBox').outerHTML = `<div class="notice ok">节点上的普通 UTXO：<b>${plain.length}</b> 个，合计 <b>${kas(total)} ${e(U())}</b>（不含未确认交易，不是钱包全部历史）。</div>`;
  } catch (err) { if ($('balBox')) $('balBox').outerHTML = `<div class="notice warn">余额读取失败：${e(errorText(err))}</div>`; }
}
$('walletBtn').onclick = connectWallet;

/* ------------------------------------------------------------------ render root */
function render() {
  document.querySelectorAll('.nav [data-go]').forEach(b => b.setAttribute('aria-current', b.dataset.go === state.view || (state.view === 'round' && b.dataset.go === 'explore') ? 'page' : 'false'));
  renderWalletChip(); renderNodeChip(); renderNetworkChip();
  const v = $('view');
  v.className = 'view';
  ({explore: renderExplore, round: renderRound, create: renderCreate, mine: renderMine, protocol: renderProtocol})[state.view](v);
  renderPreferences();
}

/* ================================================================== EXPLORE */
function renderExplore(v) {
  const previousDetails = v.querySelector('.other-rounds-details');
  if (previousDetails) state.otherRoundsOpen = previousDetails.open;
  const rows = state.rows;
  const own = rows.filter(r => phaseInfo(r).key !== 'other'), otherList = rows.filter(r => phaseInfo(r).key === 'other'), others = otherList.length;
  const groups = {all: own.length, open: 0, sealed: 0, refund: 0, done: 0};
  for (const r of own) { const k = phaseInfo(r).key; if (k === 'open') groups.open++; else if (k === 'sealed') groups.sealed++; else if (k === 'refund') groups.refund++; else if (['paid', 'refunded', 'empty'].includes(k)) groups.done++; }
  const locked = own.reduce((a, r) => a + (r.terminal ? 0n : BigInt(r.value ?? '0')), 0n);
  const paid = own.filter(r => r.terminal === 'PAID').length;
  const q = state.query.trim().toLowerCase();
  let list = own.filter(r => {
    const k = phaseInfo(r).key;
    if (state.filter === 'saved' && !state.saved.has(r.cid)) return false;
    if (state.filter === 'open' && k !== 'open') return false;
    if (state.filter === 'sealed' && k !== 'sealed') return false;
    if (state.filter === 'refund' && k !== 'refund') return false;
    if (state.filter === 'done' && !['paid', 'refunded', 'empty'].includes(k)) return false;
    return !q || r.cid.includes(q) || (r.genesisTxid ?? '').includes(q) || (r.latestTxid ?? '').includes(q);
  });
  list.sort((a, b) => state.sort === 'value' ? (BigInt(b.value) > BigInt(a.value) ? 1 : -1) : (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const filteredOther = otherList.filter(r => !q || r.cid.includes(q) || (r.genesisTxid ?? '').includes(q) || (r.latestTxid ?? '').includes(q));
  v.innerHTML = `
  <section class="hero">
    <div>
      <h1>参与一轮，<em>看清每一步。</em></h1>
      <p>选择轮次、核对票款与费用，再确认交易。售票、开奖与退款规则由固定合约约束；${NET.key === 'mainnet' ? `使用主网 ${U()}，交易涉及真实资金。` : `使用 ${U()} 测试币。`}</p>
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
    <div class="kpi"><small>已知轮次</small><strong>${own.length}</strong><span>${state.live ? `索引 ${state.live.length}` : '实时索引未连接'} · 缓存 ${state.cached}${others ? ` · 另有其他 Profile ${others}（已折叠）` : ''}</span></div>
    <div class="kpi"><small>售票中</small><strong>${groups.open}</strong><span>可购买 / 可封盘</span></div>
    <div class="kpi"><small>待开奖 / 退款中</small><strong>${groups.sealed} / ${groups.refund}</strong><span>任何人可推进</span></div>
    <div class="kpi"><small>已派奖轮次</small><strong>${paid}</strong><span>共 ${groups.done} 轮已结束</span></div>
    <div class="kpi"><small>锁定价值</small><strong>${kas(locked)}</strong><span>${e(U())} · 进行中的轮次</span></div>
  </section>
  <div class="toolbar">
    <div class="seg" role="group" aria-label="筛选">${[['all', '全部'], ['open', '售票中'], ['sealed', '待开奖'], ['refund', '退款中'], ['done', '已结束'], ['saved', '★ 关注']].map(([k, l]) => `<button data-filter="${k}" aria-pressed="${state.filter === k}">${l}<span class="c">${k === 'saved' ? state.saved.size : groups[k] ?? ''}</span></button>`).join('')}</div>
    <label class="search">${icon('search')}<input id="q" placeholder="搜索 CID / 交易 ID，或粘贴 64 位 CID 直接打开" value="${e(state.query)}" autocomplete="off" spellcheck="false"></label>
    <div class="seg"><button data-sort="new" aria-pressed="${state.sort === 'new'}">最近</button><button data-sort="value" aria-pressed="${state.sort === 'value'}">锁定价值</button></div>
    <button class="icon-btn" id="refreshRows" aria-label="刷新">${icon('refresh')}</button>
    ${state.listCursor ? '<button class="btn sm" id="moreRows">加载更多</button>' : ''}
    ${others ? `
    <details class="other-rounds-details"${state.otherRoundsOpen ? ' open' : ''}>
      <summary class="btn ghost sm" style="cursor:pointer;color:var(--dim);border:1px solid var(--line)" title="查看不适用轮次（其他合约或旧 Profile）">
        ${icon('archive')}<span>不适用轮次 (${others})</span>
      </summary>
      <div class="other-rounds-box panel" style="margin-top:14px;background:var(--panel2);border:1px dashed var(--line2)">
        <div class="row" style="margin-bottom:12px;justify-content:space-between">
          <div>
            <h3 style="margin:0;font-size:14px;color:var(--dim)">不适用的轮次（${others}）</h3>
            <span class="muted small">以下轮次属于其他合约版本或历史 Profile，本页不支持直接交互</span>
          </div>
        </div>
        <div class="grid">${filteredOther.length ? filteredOther.map(card).join('') : '<div class="empty">无匹配的不适用轮次</div>'}</div>
      </div>
    </details>` : ''}
  </div>
  ${state.meta?.rejected ? `<div class="notice warn">索引返回的 ${e(state.meta.rejected)} 个轮次格式不合规，已忽略（不显示、不缓存）。若持续出现，请更换数据源。</div>` : ''}
  ${state.liveError ? `<div class="notice warn">实时索引暂不可用（<span class="mono">${e(state.indexer)}</span>）：${e(state.liveError)}。仍显示本机记住的轮次。<button class="link" id="openSettings">${icon('settings')}设置数据源</button></div>` : state.live ? `<div class="source-strip"><span class="dot ok"></span><span>索引数据 · ${timeHtml(state.liveAt)} · <b>尚未逐轮节点核验</b>${state.listLimited ? ' · 已达分页上限，并非完整列表' : ''}<br><span class="small muted">${e(state.meta?.source ?? '')} · 检查点 ${timeHtml(state.meta?.lastCheckpointAt)} · 操作前重新核对</span></span></div>` : ''}
  <div class="grid">${state.busy ? '<div class="empty">读取中…</div>' : list.length ? list.map(card).join('') : `<div class="empty">${icon('ticket')}<p>当前筛选下没有轮次。也可以<button class="link" data-go2="create">创建一个新轮次</button>。</p></div>`}</div>`;
  v.querySelectorAll('[data-go2]').forEach(b => b.onclick = () => go(b.dataset.go2));
  v.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { state.filter = b.dataset.filter; render(); });
  v.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { state.sort = b.dataset.sort; render(); });
  v.querySelectorAll('[data-cid]').forEach(c => c.onclick = ev => { if (ev.target.closest('[data-star],[data-copy]')) return; openRound(c.dataset.cid); });
  v.querySelectorAll('[data-star]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const c = b.dataset.star; state.saved.has(c) ? state.saved.delete(c) : state.saved.add(c); LS.set('saved', [...state.saved]); render(); });
  const otherDetails = v.querySelector('.other-rounds-details');
  if (otherDetails) otherDetails.ontoggle = () => { if (otherDetails.isConnected) state.otherRoundsOpen = otherDetails.open; };
  $('refreshRows').onclick = () => loadRows();
  if ($('moreRows')) $('moreRows').onclick = () => loadRows({more: true});
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
    <div class="card-next">${r.terminal ? `索引报告：${e(({PAID: '已派奖', REFUNDED: '已退款', EMPTY: '空轮结束'})[r.terminal] ?? r.terminal)}` : '索引报告：进行中'} · 本页只支持固定 V2.0.2 Profile，不读取账本、不复验、不提供操作</div>
    <div class="src">${({live: '索引数据', local: '本机记录', cache: '本机缓存 · 非实时'})[r._src] ?? '来源待核对'} · ${timeHtml(r.updatedAt)}</div>
  </article>`;
  const p = phaseInfo(r), d = r.state ? r : null, st = d?.state, saved = state.saved.has(r.cid);
  const sold = st?.sold ?? (typeof r.sold === 'number' ? r.sold : null);
  const cap = st?.config?.ticketCap ?? (typeof r.ticketCap === 'number' ? r.ticketCap : null);
  const count = st?.purchaseCount ?? (typeof r.purchaseCount === 'number' ? r.purchaseCount : null);
  const pct = sold !== null && cap ? Math.min(100, sold / cap * 100) : (r.terminal ? 100 : 0);
  const price = st ? BigInt(st.config.ticketPrice) : r.ticketPrice ? BigInt(r.ticketPrice) : 100000000n;
  const pool = sold !== null && price !== null ? BigInt(sold) * price : (r.value != null && r.value !== '0' ? BigInt(r.value) - (r.terminal ? 0n : S.DEPOSIT) : null);
  const headline = pool !== null ? kas(pool) : '—';
  const step = cardStep(r, d, state.daa, U());
  const hasMeta = sold !== null && cap !== null;
  return `<article class="card t-${p.tone}" data-cid="${r.cid}" tabindex="0" role="button" aria-label="打开轮次 ${shortHash(r.cid)}">
    <div class="row"><span class="badge t-${p.tone}">${p.label}</span><button class="copy" data-star="${r.cid}" aria-pressed="${saved}" aria-label="关注" style="color:${saved ? 'var(--gold)' : ''}">${icon('star')}</button></div>
    <div class="mono dim small">CID ${shortHash(r.cid, 12, 8)}</div>
    <div class="small muted">${r.terminal ? '历史票款总额 · 非实际奖金' : '票款奖池 · 不含押金'}</div>
    <div class="big">${headline}<small>${e(U())}</small></div>
    ${hasMeta ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="row small muted"><span>${e(sold.toLocaleString())} / ${e(cap.toLocaleString())} 张 · ${price ? kas(price) : '1'} ${e(U())}/张</span><span>${count ?? sold} 笔</span></div>` : `<div class="small muted">打开查看账本与购买目录</div>`}
    <div class="card-next">${e(step.text)}</div>
    <div class="src">${({rest: 'REST 备用线索 · 待节点核验', live: '索引数据 · 待节点核验', node: '节点已核验状态', local: '本机接受记录', cache: '本机缓存 · 非实时'})[r._src] ?? '来源待核对'} · ${timeHtml(r.updatedAt)}</div>
    <div class="card-cta">${p.key === 'open' ? '查看并购买' : p.key === 'sealed' ? '查看开奖条件' : p.key === 'refund' ? '查看退款进度' : '查看轮次详情'} ${icon('arrow')}</div>
  </article>`;
}

/* ================================================================== ROUND */
async function openRound(cid, {push = true} = {}) {
  stopDetail();
  state.round = {cid, loading: true, syncing: true, error: null, detail: shownDetail(cid), live: null, liveError: null, replay: null};
  state.view = 'round';
  if (push && location.hash !== `#/round/${cid}`) history.pushState(null, '', `#/round/${cid}`);
  render();
  const opening = state.round;
  await refreshRound(cid);
  if (state.view === 'round' && state.round === opening) trackDetail(cid);
}
/** Display cached/session data immediately. Network work belongs to the cancellable detail tracker. */
async function refreshRound(cid, {quiet = false} = {}) {
  const R = state.round;
  try {
    const loc = await localDetail(cid), entry = await catalog.get(cid);
    if (state.round !== R || R?.cid !== cid || state.view !== 'round') return;
    let d = chooseView({index: state.details.get(cid) ?? null, node: state.nodeViews.get(cid) ?? null, local: loc, cache: cachedView(entry)});
    if (entry?.terminalVerified && entry?.view) {
      d = entry.view; R.history = true; R.historyAt = entry.terminalCheck?.checkedAt;
      if (entry.replay) R.replay = entry.replay;
    } else if (!d?.state) {
      try {
        const cand = await discovery.candidate(cid, {known: d});
        if (cand && (state.round === R && state.view === 'round')) {
          if (cand.state) state.details.set(cid, cand);
          d = cand;
        }
      } catch {}
    }
    if (d) {
      if (d.state && !d.terminal) { try { ledgerFromDetail(d, profile); } catch {} }
      R.detail = d; R.loading = false;
    }
    R.error = null;
    if (!quiet) render();
    // Rendering a cached view is not a state invalidation. Notifications, accepted Fulls and explicit retries own reads.
  } catch (err) { if (state.round === R && !quiet) { R.loading = false; R.error = errorText(err); render(); } }
}
/** Display-only: every live snapshot this page verified on the node (plan, "verify current UTXO") becomes the round's
 * node view, so the page never keeps showing a state the node has already moved past. Actions still re-verify. */
function rememberNodeView(live, cid) {
  let v; try { v = viewFromLive(live, cid); } catch { return; }
  state.nodeViews.set(cid, v);
  void catalog.remember(cid, {view: v, source: 'node', verified: true}).catch(() => {});
  if (state.round?.cid === cid) void refreshRound(cid, {quiet: true});
  else void mergedRows().then(rows => { state.rows = rows; if (state.view === 'explore') render(); }).catch(() => {});
}
/** Build a detail view from this browser's own accepted records (indexer not caught up yet). Values are re-verified
 * against the configured active node before any action (liveRound), so this is only a display convenience. */
async function localDetail(cid, records = null) {
  records ??= await engine.records().catch(() => []);
  const tip = await engine.localTip(cid, records).catch(() => null);
  if (!tip) return null;
  // A terminal record has no successor ledger. Show the exact prior accepted ledger as historical participation,
  // never synthesize a successor or treat the prior input's locked value as a terminal prize.
  const previous = tip.terminal ? records.find(r => r.cid === cid && ['ACCEPTED', 'CONFIRMING'].includes(r.status) && r.nextLedger && tip.inputs.some(o => o.transactionId === r.txid && o.index === 0)) : null;
  const bytes = tip.nextLedger ?? previous?.nextLedger;
  if (!bytes) return null;
  const s = S.decodeLedger(unhex(bytes));
  return {cid, genesisTxid: tip.genesisTxid, contract: CONTRACT_TAG, status: tip.terminal ? 'close' : 'open', phase: s.phase, terminal: tip.terminal, indexStatus: 'LOCAL', tip: tip.terminal ? null : {transactionId: tip.txid, index: 0},
    value: tip.terminal ? '0' : String(tip.value), latestTxid: tip.txid, accepting: tip.accepting, utxoDaa: tip.terminal ? null : String(tip.utxoDaa), updatedAt: tip.at ?? Date.now(), origin: tip.origin, scriptPublicKey: tip.spk, _src: 'local',
    state: {...s, config: {...s.config, ticketPrice: s.config.ticketPrice.toString(), closeEligibleDaa: s.config.closeEligibleDaa.toString()}}, purchases: S.records(s)};
}
const STEPS = [['GENESIS', '创建'], ['OPEN', '售票'], ['SEALED', '封存'], ['DRAW', '开奖'], ['END', '结算']];
function stepper(d) {
  const ph = d.state?.phase, t = d.terminal;
  const pos = t === 'PAID' ? 5 : t === 'EMPTY' ? 5 : t === 'REFUNDED' ? 5 : ph === 1 ? 1 : ph === 2 ? 2 : ph === 5 ? 3 : 1;
  const labels = STEPS.map(([k, l], i) => i === 2 && (ph === 5 || t === 'REFUNDED') ? ['REFUNDING', '退款中'] : i === 3 && (ph === 5 || t === 'REFUNDED') ? ['REFUND', '分批退款'] : i === 4 && t ? ['END', t === 'PAID' ? '已派奖' : t === 'EMPTY' ? '空轮结束' : '已退款'] : [k, l]);
  const focus = Math.min(pos, labels.length - 1);
  return `<div class="stepper">${labels.map(([k, l], i) => `<div class="step ${i < pos ? 'done' : i === pos && !t ? 'now' : ''} ${k.startsWith('REFUND') ? 'alt' : ''}"${i === focus ? ' data-focus' : ''}><div class="b">${i < pos ? '✓' : i + 1}</div>${l}</div>`).join('')}</div>`;
}
/** Narrow screens scroll the stepper horizontally: keep the current step centered (horizontal only, page stays put). */
function centerStepper(root) {
  const bar = root.querySelector('.stepper'), step = bar?.querySelector('[data-focus]');
  if (!step || bar.scrollWidth <= bar.clientWidth) return;
  bar.scrollLeft = Math.max(0, step.offsetLeft - (bar.clientWidth - step.offsetWidth) / 2);
}
function renderRound(v) {
  const R = state.round;
  if (!R) { v.innerHTML = `<div class="empty">没有选择轮次。<button class="link" data-back>返回广场</button></div>`; v.querySelector('[data-back]').onclick = () => go('explore'); return; }
  if (R.loading && !R.detail) {
    v.innerHTML = `<div class="panel">正在向节点核验轮次 <span class="mono">${e(R.cid)}</span>… <button class="btn sm" id="retryEmptyRound">重新向节点同步</button></div>`;
    $('retryEmptyRound').onclick = () => retryRoundSync(R.cid); return;
  }
  if (R.error && !R.detail) { v.innerHTML = `<div class="panel"><div class="notice warn">${e(R.error)}</div><p class="muted">CID：<span class="mono">${e(R.cid)}</span>。${/不是固定的 V2\.0\.\d+ Profile/.test(R.error) ? '这是索引收录的其他（旧版）合约轮次；本页只支持固定 V2.0.2 Profile，不读取账本、不复验、不提供操作。' : '可在设置中切换 Indexer，或确认 CID 是否正确。'}</p><button class="btn sm" id="retryEmptyRound">重新向节点同步</button><button class="btn" id="back">${icon('arrow')}返回</button></div>`; $('retryEmptyRound').onclick = () => retryRoundSync(R.cid); $('back').onclick = () => go('explore'); return; }
  const d = R.detail, st = d.state, c = st.config, p = phaseInfo(d);
  // One local display tick only while viewing SEALED; chain reads belong to the existing detail session.
  if (st.phase === S.Phase.SEALED && detailTracker?.cid === d.cid && !document.hidden) {
    R.drawTimer ??= setInterval(() => { if (!document.hidden && detailTracker?.cid === R.cid && !R.syncing && !R.recovering) void detailTracker.draw?.pulse(); updateDrawReadiness(); }, 1000);
  } else if (R.drawTimer) { clearInterval(R.drawTimer); R.drawTimer = null; }
  let ledger = null, ledgerErr = null; try { ledger = ledgerFromDetail(d, profile); } catch (err) { ledgerErr = errorText(err); }
  const recs = ledger ? S.records(ledger) : [];
  const price = BigInt(c.ticketPrice), pool = BigInt(st.sold) * price;
  const me = state.session?.key;
  const myTickets = recs.filter(r => r.key === me).reduce((a, r) => a + r.count, 0);
  const draw = R.replay?.winner ?? null;
  const winRec = draw ? recs[draw.record] : null;
  const prizeEst = pool - S.FINALIZER;
  const closeDaa = BigInt(c.closeEligibleDaa), now = state.daa;
  const phase = R.syncing || R.recovering ? {tone: 'amber', label: text('正在同步最新状态')} : p;
  const current = !R.syncing && !R.recovering && !R.history && detailTracker?.cid === d.cid && detailTracker.observationCurrent();
  v.innerHTML = `
  <div class="toolbar"><button class="btn sm" id="back">${icon('arrow')}返回广场</button><span class="spacer"></span>
    <button class="btn sm" id="star">${icon('star')}${state.saved.has(d.cid) ? '已关注' : '关注'}</button>
    <button class="btn sm" id="exp">${icon('download')}导出</button></div>
  <div class="panel t-${phase.tone}" data-round-phase="${e(String(st.phase))}" data-current="${current === true}" data-terminal="${e(d.terminal ?? '')}">
    <div class="row" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="badge t-${phase.tone}">${phase.label}</span><span class="spacer"></span>${R.recovering ? '<span class="tag amber">恢复中 · 尚未完成本次核验</span>' : R.syncing ? '<span class="tag amber">同步中 · 等待节点核验</span>' : R.history ? '<span class="tag">历史核验记录</span>' : ({local: '<span class="tag kas">本机已接受 · 索引同步中</span>', node: '<span class="tag kas">节点已核验</span>', cache: '<span class="tag">本机缓存</span>', live: '<span class="tag amber">索引线索 · 节点核验中</span>'})[d._src] ?? ''}</div>
    ${R.recovering ? `<div class="notice" role="status" style="margin-top:8px"><span>${R.recoveryFailure ? '恢复核验尚未完成，等待重试。' : '正在恢复节点连接并核验最新状态。'}</span>${R.verifiedAt ? `<span>上次本机核验于</span> ${timeHtml(R.verifiedAt)}。` : ''}<span>当前保留上次取得的信息与明细，不能视为本次核验结果。</span></div>` : ''}
    ${R.syncError ? `<div class="notice warn" role="status">${e(R.syncError)} <button class="btn sm" id="retryRound">重新向节点同步</button></div>` : ''}
    ${R.syncing && R.nodeProgress ? `<div class="notice" role="status"><span>正在从节点追赶后继：已扫描</span> ${e(R.nodeProgress.pages)} <span>页；结果仍待完整核验。</span></div>` : ''}
    ${R.operationNotice ? `<div class="notice warn" role="status" style="margin-top:8px">${e(R.operationNotice)}</div>` : ''}
    ${R.staleNote && !(d.terminalSettled === true && d._src === 'node') ? `<div class="notice warn" style="margin-top:8px">${e(R.staleNote)}。当前展示为最近取得的轮次信息；操作前仍会向节点核对。</div>` : ''}
    <h2 style="margin:8px 0 14px">轮次 ${hashHtml(d.cid, {n: 14})}</h2>
    ${stepper(d)}
    <div class="cols3">
      <div class="kpi"><small>${d.terminal === 'PAID' ? '奖池（票款总额）' : '当前票款'}</small><strong>${kas(pool)} <span class="small muted">${e(U())}</span></strong><span>${e(st.sold.toLocaleString())} 张 × ${kas(price)} ${e(U())}</span></div>
      <div class="kpi"><small>售出 / 上限</small><strong>${e(st.sold.toLocaleString())} / ${e(c.ticketCap.toLocaleString())}</strong><span>开奖最低 ${e(c.minTickets)} 张 · ${e(st.purchaseCount)}/${e(c.purchaseCap)} 笔记录</span></div>
      <div class="kpi"><small>${d.terminal ? '结果' : '奖金上界（未扣网络费）'}</small><strong>${d.terminal === 'PAID' ? '已派奖' : d.terminal ? (d.terminal === 'EMPTY' ? '空轮' : '已退款') : kas(prizeEst > 0n ? prizeEst : 0n) + ` <span class="small muted">${e(U())}</span>`}</strong><span>${d.terminal ? '实际金额以接受交易输出为准' : st.sold < c.minTickets ? '当前未达开奖门槛；该数值不是可领奖金' : `此数值=票款−1 ${U()}；实际奖金还需减网络费`}</span></div>
    </div>
  </div>
  <div class="round-layout">
    <aside class="round-actions panel"><h3>${icon('arrow')} 下一步怎么做</h3>${actionsHtml(d, ledger)}</aside>
    <div class="round-main">
      <div class="panel">
        <h3>${icon('ticket')} 购买目录 · 票号分布</h3>
        ${ledgerErr ? `<div class="notice warn">账本无法按固定 Profile 解析：${e(ledgerErr)}</div>` : ''}
        ${recs.length ? matrix(recs, st.sold, draw, d, me) : '<p class="muted">还没有购买记录。</p>'}
        ${me ? `<p class="small muted" style="margin-top:8px">你在本轮持有 <b>${e(myTickets)}</b> 张票${st.sold ? `，中奖概率约 ${(myTickets / st.sold * 100).toFixed(2)}%` : ''}。</p>` : ''}
      </div>
      <div class="panel">
        <h3>${icon('shield')} 链上复验</h3>
        <p class="sub">所列交易的复验只核对该笔历史，不代表轮次最新状态。获取最新状态请使用“重新向节点同步”；结果仍须节点完整核验。</p>
        <div id="verifyBox">${R.replay ? replayHtml(R.replay) : R.replayError ? `<div class="notice warn">${e(R.replayError)}</div>` : ''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="verifyLatest" ${d.latestTxid && d.accepting ? '' : 'disabled'}>${icon('node')}复验所列历史交易</button>${!d.terminal ? `<button class="btn" id="verifyLive">${icon('refresh')}复验当前状态 UTXO</button>` : ''}</div>
        <div id="liveBox">${R.live ? liveHtml(R.live) : R.liveError ? `<div class="notice warn" style="margin-top:10px">${e(R.liveError)}</div>` : ''}</div>
      </div>
    </div>
    <div class="round-rules">
      <div class="panel">
        <h3>${icon('clock')} 规则与链上标识</h3>
        <dl class="kv">
          <dt>票价</dt><dd>${kas(price)} ${e(U())}</dd>
          <dt>最早封盘 DAA</dt><dd class="mono">${closeDaa}${now ? ` <span class="muted">（${now >= closeDaa ? '已到' : '约 ' + daaDuration(closeDaa - now) + ' 后'}）</span>` : ''}</dd>
          <dt>开奖等待</dt><dd>封存后 ${S.DRAW_DELAY} DAA（约 ${daaDuration(S.DRAW_DELAY)}）；本页另等实际目标块100次blue-score确认</dd>
          <dt>超时退款</dt><dd>封存后 ${S.TIMEOUT_DELAY} DAA（约 ${daaDuration(S.TIMEOUT_DELAY)}）</dd>
          <dt>退款执行费</dt><dd>每条记录 0.02 ${e(U())} · 每批最多 32 条</dd>
          <dt>创建者</dt><dd>${hashHtml(pubkeyToAddress(st.ownerKey), {link: explorerAddress(pubkeyToAddress(st.ownerKey)), n: 12})}</dd>
          <dt>Genesis</dt><dd>${hashHtml(d.genesisTxid, {link: explorerTx(d.genesisTxid)})}</dd>
          <dt>最近交易</dt><dd>${hashHtml(d.latestTxid, {link: d.latestTxid && explorerTx(d.latestTxid)})}</dd>
          <dt>接受块</dt><dd>${hashHtml(d.accepting, {link: d.accepting && explorerBlock(d.accepting)})}</dd>
          ${d.tip ? `<dt>状态 UTXO</dt><dd class="mono">${e(shortHash(d.tip.transactionId, 10, 6))}:${e(d.tip.index)}</dd>` : ''}
          <dt>${d._src === 'live' ? '索引更新' : '本机核验时间'}</dt><dd>${timeHtml(d.updatedAt)}</dd>
        </dl>
      </div>
    </div>
  </div>`;
  centerStepper(v);
  $('back').onclick = () => go('explore');
  $('star').onclick = () => { state.saved.has(d.cid) ? state.saved.delete(d.cid) : state.saved.add(d.cid); LS.set('saved', [...state.saved]); render(); };
  $('exp').onclick = () => download({kind: 'KASWIN_INDEXER_VIEW_NOT_CONSENSUS_PROOF', exportedAt: new Date().toISOString(), item: d, replay: R.replay}, `kaswin-${d.cid.slice(0, 12)}.json`);
  $('verifyLatest').onclick = () => verifyLatest(d);
  $('verifyLive') && ($('verifyLive').onclick = () => verifyLive(d));
  v.querySelectorAll('[data-act]').forEach(b => b.onclick = () => actionDialog(b.dataset.act, d));
  if ($('refreshRound')) $('refreshRound').onclick = () => retryRoundSync(d.cid);
  if ($('retryRoundAction')) $('retryRoundAction').onclick = () => retryRoundSync(d.cid);
  bindMatrixEvents(v, recs, d, draw, me, price);
  if ($('retryRound')) $('retryRound').onclick = () => retryRoundSync(d.cid);
}
/** A display-only hint, never inferred from the order of local pending/accepted records. */
function purchaseTxid(d, index, records) {
  const hint = d?.purchases?.[index]?.txid ?? (records.length === 1 && d?.state?.phase === 1 ? d.latestTxid : null);
  return typeof hint === 'string' && /^[0-9a-f]{64}$/.test(hint) ? hint : null;
}
function matrix(recs, sold, draw, d, me) {
  const drawRec = draw ? draw.record : null;

  const cells = recs.map((r, i) => {
    const isMe = r.key === me;
    const isWin = drawRec !== null && drawRec === i;
    const isRefunded = (d?.state?.phase === 5 && i < d?.state?.cursor) || d?.terminal === 'REFUNDED';
    const start = r.end - r.count + 1;
    const addr = pubkeyToAddress(r.key);

    const txid = purchaseTxid(d, i, recs);

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
    const cost = price ? kas(price * BigInt(r.count)) + ' ' + U() : '';
    const txid = purchaseTxid(d, i, recs);
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
        ${txid ? hashHtml(txid, {link: explorerTx(txid), n: 8, isTx: true}) : `<a class="btn sm" href="${e(explorerAddress(addr))}" target="_blank" rel="noopener noreferrer">在 kaspa.stream 查看买家 ↗</a>`}
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
function drawProgress() {
  const R = state.round, tracker = detailTracker;
  return R && !R.syncing && !R.recovering && !R.history && tracker?.cid === R.cid ? tracker.draw?.view() : null;
}
function drawWaitHtml(model) {
  return `<div class="draw-wait ${model.ready ? 'ok' : ''}"><b role="status">${e(model.label)}</b>${model.percent === null ? '' : `<progress max="100" value="${model.percent}" aria-label="开奖等待进度"></progress>`}${model.detail ? `<span class="small muted">${e(model.detail)}</span>` : ''}</div>`;
}
function updateDrawReadiness() {
  if (document.hidden || state.view !== 'round' || state.round?.detail?.state?.phase !== S.Phase.SEALED) return;
  const model = drawReadinessView(drawProgress(), Date.now(), U()), box = $('drawWait');
  if (box) box.innerHTML = drawWaitHtml(model);
  const button = document.querySelector('[data-act="DRAW_AND_PAY"]');
  if (button) { button.disabled = !model.ready; button.innerHTML = `${e(text(model.button))} ${icon('arrow')}`; }
}
function actionsHtml(d, ledger) {
  const syncing = state.round?.cid === d.cid && (state.round.syncing || state.round.recovering);
  if (d.terminal && syncing) return `<div class="notice">正在向节点核对轮次当前状态。</div><button class="btn sm" id="retryRoundAction">重新向节点同步</button>`;
  if (d.terminal) return `<div class="notice ok">本轮已结束（${d.terminal === 'PAID' ? '已派奖' : d.terminal === 'EMPTY' ? '空轮，押金已退回创建者' : '全部购买记录已退款'}）。资金已以普通 UTXO 形式离开合约，不再需要任何操作。</div>`;
  if (!ledger) return `<div class="notice warn">账本解析失败，无法操作。</div><button class="btn sm" id="retryRoundAction">重新向节点同步</button>`;
  const ph = ledger.phase, list = [];
  if (ph === 1) { list.push(['BUY', 'ticket', '购买', `${kas(ledger.config.ticketPrice)} ${U()}/张；剩余 ${ledger.config.ticketCap - ledger.sold} 张、${ledger.config.purchaseCap - ledger.purchaseCount} 笔记录`]); list.push(['CLOSE', 'lock', '封盘', ledger.sold >= ledger.config.minTickets ? '→ 封存，100 DAA后核验目标块100次确认' : ledger.sold === 0 ? '→ 空轮结束，押金退回创建者' : `→ 未达 ${ledger.config.minTickets} 张，转入退款`]); }
  if (ph === 2) { list.push(['DRAW_AND_PAY', 'trophy', '开奖并派奖', `两阶段等待（100 DAA 封存 + 目标块 100 blue score 确认）；任何人可执行，执行者获得 1 ${U()} 赏金`]); list.push(['TIMEOUT_REFUND', 'clock', '超时转退款', '封存 432000 DAA 仍未开奖时，任何人可转入退款']); }
  if (ph === 5) list.push(['REFUND', 'refund', `退款批次（${Math.min(32, ledger.purchaseCount - ledger.cursor)} 条）`, `已退 ${ledger.cursor}/${ledger.purchaseCount}；执行者获得本批执行费池扣除网络费后的余额`]);
  const proposed = plannedActions(d,state.daa), drawModel = drawReadinessView(drawProgress(), Date.now(), U());
  // A freshly accepted state is usable after node verification. Sync/recovery and indexer hints offer a fresh
  // node read/quote; display metadata grants neither signing approval nor submission permission.
  const behind = indexerBehind(d), recent = !behind && stateConfirming(d, state.daa) === true;
  const wait = behind ? `<div class="notice warn">索引报告：这里显示的状态已在链上被后续交易推进（${timeHtml(d.tipSpentSeenAt)} 发现），可以向节点同步并重新报价；报价仍须核验当前状态。</div>`
    : recent ? `<div class="notice">轮次最新状态刚被接受（接受块深度 ${e(d.depthDaa ?? '—')} DAA），可以直接继续。短程重组仍可能撤销它：报价前会再向节点核对，页面也会跟踪本机交易并在必要时按原签名字节重发。</div>` : '';
  return `${wait}<div class="actions">${list.map(([a, ic, title, desc]) => {
    const hint = proposed.find(x => x.action === a), isDraw = a === 'DRAW_AND_PAY';
    const blocked = isDraw ? !drawModel.ready : !syncing && !behind && (a === 'BUY' && hint?.available === false);
    const label = isDraw ? drawModel.button : syncing || behind ? a === 'BUY' ? '选择张数并核验' : '同步并报价' : blocked ? hint.reason : a === 'BUY' ? '选择张数' : '核验并'+(a==='REFUND'?'退款':ACTION_LABEL[a]);
    // Machine-readable block reason for clients/automation; display text stays localizable.
    const code = blocked && !isDraw ? hint?.reasonCode : null, why = code && hint.reasonDetail ? `<span class="small why" id="why-${a}">${e(hint.reasonDetail)}</span>` : '';
    return `<div class="act"><h4>${icon(ic)}${title}</h4><p>${desc}</p>${isDraw ? `<div id="drawWait">${drawWaitHtml(drawModel)}</div>` : hint?.until ? `<span class="small why">${waitText(hint.until,state.daa)} · 以报价时节点为准</span>` : ''}${why}${hint?.outcome ? `<span class="small muted">${CLOSE_OUTCOME[hint.outcome]}</span>` : ''}<button class="btn ${isDraw ? 'gold' : a === 'BUY' ? 'pri' : ''}" data-act="${a}"${code ? ` data-reason="${e(code)}"` : ''}${blocked ? ' disabled aria-disabled="true"' : ''}${why ? ` aria-describedby="why-${a}"` : ''}>${e(label)} ${icon('arrow')}</button></div>`;
  }).join('')}</div><p class="small muted">${ph===1?'到封盘时间不会自动停售，也不会自动封盘。':''}先核验与报价，确认前不会签名或提交。每次新操作都会向节点核验当前状态；同步未完成时可重试，刷新不会重新提交交易。</p><button class="link" id="refreshRound">重新向节点同步</button>`;
}
function replayHtml(x) {
  const lab = {STATE: '状态后继', WINNER: '中奖者', CREATOR: '创建者', EXECUTOR: '执行者', BUYER_REFUND: '买家退款', CHANGE: '找零', REGISTRY: 'Registry 登记', AUXILIARY: '辅助输出（非本轮约束）'};
  return `<div class="notice ok"><b>${e(ACTION_LABEL[x.action] ?? x.action)}</b> 已被选中链接受（接受块 DAA ${x.acceptingDaa}，确认深度约 ${x.confirmations}），${x.action === 'GENESIS' ? `创建公告、初始账本、固定 OPEN 模板、4 ${U()} 状态输出与 Covenant ID 推导均与固定 Profile 一致。` : `已重算并核对 ${x.constrainedOutputs} 个合约约束输出；其余输出仅展示节点已接受的实际内容，不视为合约保证的收款。`}</div>
  ${x.winner ? `<div class="notice" style="border-color:var(--gold);background:var(--gold-soft)">🏆 中奖记录 #${x.winner.record + 1}（票 ${x.winner.firstTicket}–${x.winner.lastTicket}），奖金 <b>${kas(x.winner.prize)} ${e(U())}</b> → ${hashHtml(pubkeyToAddress(x.winner.key), {link: explorerAddress(pubkeyToAddress(x.winner.key)), n: 12})}</div>` : ''}
  <div class="outs">${x.outputs.map((o, i) => `<div class="out"><span class="r">${i} · ${e(lab[o.role] ?? o.role)}</span><span class="out-addr">${outAddressHtml(o)}</span><span class="v">${kas(o.value)}</span></div>`).join('')}</div>
  <dl class="kv small" style="margin-top:8px"><dt>交易</dt><dd>${hashHtml(x.txid, {link: explorerTx(x.txid)})}</dd><dt>网络费</dt><dd>${kas(x.fee)} ${e(U())} · compute mass ${x.computeMass ?? '—'} · budget ${x.budget}</dd>${x.draw ? `<dt>PASS-A 目标块</dt><dd>${hashHtml(x.draw.target, {link: explorerBlock(x.draw.target)})} · 边界 DAA ${x.draw.boundaryDaa}；${x.draw.headerChecked ? '节点区块头的序列承诺与证明一致' : '当前未取得目标区块头，仅依赖已接受交易执行时的共识校验'}</dd>` : ''}</dl>`;
}
function liveHtml(l) {
  const acts = availableActions(l.snapshot, profile).filter(a => ACTION_LABEL[a]);
  return `<div class="notice ok" style="margin-top:10px">状态 UTXO 仍未花费；模板、Genesis CID、P2SH 与锁定金额 ${kas(l.snapshot.value)} ${e(U())} 均与固定 Profile 吻合。当前 DAA ${l.snapshot.currentDaa}。当前可执行：<b>${acts.map(a => ACTION_LABEL[a]).join('、') || '无（需等待）'}</b>。</div>`;
}
/** TN10 nodes keep ~30 h of block bodies (rusty-kaspa PRUNING_DURATION = 108,000 s); older accepting blocks are gone. */
function prunedHint(err) {
  return /cannot find header|block not found|not found|retention root/i.test(errorText(err))
    ? `该交易的接受块已被节点裁剪（${NET.label} 节点只保留有限的区块数据），无法再从节点在线复验。这不代表交易无效。`
    : null;
}
async function verifyLatest(d) {
  const R = state.round; const box = $('verifyBox'); box.innerHTML = '<div class="notice">从节点取回已接受交易…</div>';
  try {
    if (d.terminal) {
      trackDetail(d.cid, {force: true});
      const result = await detailTracker?.run();
      ensure(result?.replay && !result.incomplete, '终局复验尚未完成');
      R.replay = result.replay;
    } else R.replay = await replayAccepted(pair, profile, d.latestTxid, d.accepting, {origin: d.origin, cid: d.cid});
    R.history = false; R.replayError = null;
  }
  catch (err) { R.replay = null; R.replayError = prunedHint(err) ?? `复验未完成：${errorText(err)}`; }
  if (state.round === R) render();
}
async function verifyLive(d) {
  const R = state.round, activePair = pair;
  const tracker = detailTracker?.cid === d.cid ? detailTracker : trackDetail(d.cid, {force: true});
  const current = () => state.round === R && pair === activePair && detailTracker === tracker;
  $('liveBox').innerHTML = '<div class="notice" style="margin-top:10px">读取实时状态…</div>';
  try {
    ensure(tracker, '轮次节点同步尚未启动');
    // A complete terminal is a successful synchronization, even though it has no live state UTXO.
    const result = await tracker.synchronize();
    if (!current()) return;
    R.live = result.live ?? null; R.replay = result.replay ?? R.replay; R.liveError = null;
    if (R.live) state.daa = R.live.snapshot.currentDaa;
  } catch (err) { if (current()) { R.live = null; R.liveError = errorText(err); } }
  if (current()) render();
}

/* ------------------------------------------------------------------ action dialog */
async function actionDialog(action, d) {
  if (action === 'DRAW_AND_PAY' && !drawReadinessView(drawProgress(), Date.now(), U()).ready) { updateDrawReadiness(); return; }
  // A synchronizing display may request a fresh quote; Engine.currentLive still must verify the actual state first.
  if (!state.session) { await connectWallet(); if (!state.session) return; }
  const epoch = state.walletEpoch;
  if (action === 'BUY') {
    const st = d.state, max = Math.min(st.config.ticketCap - st.sold, 100000);
    modal('购买', `<div class="form"><label class="field full">购买张数<input id="qty" inputmode="numeric" value="1" maxlength="6"><small>本轮剩余 ${max} 张，${kas(BigInt(st.config.ticketPrice))} ${U()}/张；一次购买 = 1 条购买记录</small></label></div><div id="qtyTotal" class="sum"></div><p class="err" id="qErr"></p>`, `<button class="btn" id="cancel">取消</button><button class="btn pri" id="go">核验并报价 ${icon('arrow')}</button>`);
    const upd = () => { const q = $('qty').value.trim(); $('qtyTotal').innerHTML = /^[1-9][0-9]*$/.test(q) && +q <= max ? `<span>票款</span><span>${kas(BigInt(q) * BigInt(st.config.ticketPrice))} ${e(U())} + 网络费</span>` : ''; };
    $('qty').oninput = upd; upd(); $('cancel').onclick = closeModal;
    $('go').onclick = () => { const q = $('qty').value.trim(); if (!/^[1-9][0-9]{0,5}$/.test(q) || +q > max) { $('qErr').textContent = `请输入 1–${max} 的整数`; return; } runPlan({action, cid: d.cid, quantity: +q}, epoch); };
    return;
  }
  runPlan({action, cid: d.cid}, epoch);
}
const rateText = v => typeof v === 'number' && Number.isFinite(v) ? (v >= 100 ? v.toFixed(0) : v.toFixed(2)) : '—';
/** Estimated wait as text; the node's estimator is an expectation, not a promise. */
function waitText2(s, x) {
  if (x?.belowLow) return '要等网络空闲';
  if (s === null || s === undefined) return '无法估计';
  if (s < 1) return '约 1 秒内';
  if (s < 60) return `约 ${Math.ceil(s)} 秒`;
  if (s < 3600) return `约 ${Math.ceil(s / 60)} 分钟`;
  return s < 86400 ? `约 ${Math.ceil(s / 3600)} 小时` : '超过 1 天';
}
function networkLine(plan) {
  const c = plan.conditions, m = c.mempool;
  const busy = plan.network.idle ? '空闲' : '繁忙';
  const pool = m ? `待打包 ${m.readyCount} 笔（约 ${(m.readyMass / 500000).toFixed(1)} 个区块容量）` : '内存池规模未提供';
  return `网络${busy} · ${pool} · 节点费率 低 ${rateText(c.low.feerate)} / 正常 ${rateText(c.normal.feerate)} / 优先 ${rateText(c.priority.feerate)} sompi/gram · 探测于 ${timeHtml(c.checkedAt)}`;
}
function feeChoiceHtml(plan) {
  if (!plan.tiers || plan.replaces) return '';
  const card = (t, name, desc) => {
    const x = plan.tiers[t];
    if (!x.available) return `<button type="button" class="tier" data-tier="${t}" disabled aria-pressed="false"><b>${name}</b><span class="small muted">不可用：${e(x.reason)}</span></button>`;
    const rec = plan.recommendedTier === t ? '<span class="badge t-mint">推荐</span>' : '';
    return `<button type="button" class="tier" data-tier="${t}" aria-pressed="${plan.tier === t}"><span class="tier-h"><b>${name}</b>${rec}</span><span class="tier-fee">${kas(x.fee)} ${e(U())}</span><span class="small muted">预计等待 ${e(waitText2(x.waitSeconds, x))} · ${e(x.orderingFeerate)} sompi/gram</span><span class="small muted">${x.clamped ? `按节点费率需要 ${kas(x.loadFee)} ${U()}，已按 ${kas(FEE_CAP)} ${e(U())} 保护上限封顶，排序会低于正常档` : desc}</span></button>`;
  };
  const same = plan.tiers.economy.sameAs === 'fast';
  return `<div class="feebox"><p class="small muted net-line">${networkLine(plan)}</p>
    ${same ? `<p class="small muted">经济与快速报价相同（这笔交易的存储质量不高于计算质量），只有一档。</p>` : `<div class="tiers" role="group" aria-label="手续费档位">
      ${card('economy', '经济', '按节点低档费率、最低转发规则计价，不为存储质量付费；网络繁忙时可能排队较久，之后可在交易记录中加速')}
      ${card('fast', '快速', '按节点正常档费率、含存储质量的全部排序质量计价，繁忙时也按正常顺序打包')}
    </div>`}
    ${!same && plan.tier === 'economy' && !plan.network.idle ? `<div class="notice warn">网络繁忙：经济档可能在内存池中等待较久。在被接受或查明失败前输入保持占用，页面不会重发；可随时在交易记录中「加速」。</div>` : ''}
  </div>`;
}
function invalidateQuote() {
  const q = activeQuote;
  if (!q || (activeExecution?.engine === q.engine && activeExecution.quote === q)) return;
  q.stale = true; q.engine.discardPlan(q.plan);
  if (!$('modal').open) return;
  if ($('approve')) { $('approve').checked = false; $('approve').disabled = true; }
  if ($('sign')) $('sign').disabled = true;
  document.querySelectorAll('[data-tier]').forEach(b => { b.disabled = true; });
  if ($('xErr') && !$('xErr').textContent) $('xErr').textContent = text('旧报价已失效，请重新报价并再次批准。');
  if (!$('requote') && $('mFoot')) {
    const b = document.createElement('button'); b.id = 'requote'; b.className = 'btn pri'; b.textContent = text('重新报价');
    b.onclick = async () => {
      if (activeQuote !== q || (activeExecution?.engine === engine)) return;
      if (!state.session) { await connectWallet(); if (!state.session) return; }
      await q.replan();
    };
    $('mFoot').append(b);
  }
}
async function runPlan(request, epoch) {
  const planEngine = engine, planning = ++planningEpoch;
  const current = () => engine === planEngine && !planEngine.disposed && planning === planningEpoch;
  modal(ACTION_LABEL[request.action], `<ul class="progress" id="prog"><li class="run" id="pstat">准备…</li></ul><p class="err" id="pErr"></p>`);
  lockModal(true);
  planEngine.onStatus = s => { const el = $('pstat'); if (current() && el) el.textContent = s; };
  let plan;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await recovery?.flush();
      if (!current()) return;
      plan = await planEngine.plan(request, state.session);
      if (!current()) return;
      break;
    } catch (err) {
      if (!current() || !$('pErr')) return;
      const code = err?.safeCode ?? err?.code ?? err?.message;
      const isViewChange = code === 'READ_VIEW_CHANGED' || String(err?.message || err).includes('READ_VIEW_CHANGED');
      if (isViewChange && attempt < 2) {
        planEngine.onStatus('节点链视图变动，正在自动重试…');
        await new Promise(r => setTimeout(r, 350));
        continue;
      }
      if (request.cid && state.round?.cid === request.cid) void refreshRound(request.cid);
      lockModal(false); planEngine.onStatus = () => {};
      $('prog').innerHTML = '';
      const syncPending = code === 'ROUND_SYNC_PENDING' || code === 'STALE_TIP';
      if (syncPending && request.cid && state.round?.cid === request.cid) {
        state.round.syncing = !detailTracker?.observationCurrent();
        state.round.staleNote = state.round.syncing ? '节点尚未返回当前可操作状态，可重新向节点同步后再报价' : null;
        state.round.syncError = '本次报价未生成，尚未签名或提交。可点击重新向节点同步，再按最新状态报价。';
        if (state.round.syncing) detailTracker?.wake();
        render();
      }
      const nodeView = request.cid ? state.nodeViews.get(request.cid) : null;
      const racedClose = request.action === 'CLOSE' && code === 'NOT_AVAILABLE' && nodeView?.state && nodeView.state.phase !== 1;
      const endedRound = code === 'NOT_LIVE' && detailTracker?.cid === request.cid && detailTracker.observationCurrent() && detailTracker.observation.result.terminal;
      const phaseNotice = racedClose ? '封盘已由另一笔交易抢先完成，本次没有签名或提交。'
        : endedRound ? '轮次已由其他交易结束，本次没有签名或提交。' : null;
      if (phaseNotice && state.round?.cid === request.cid) { state.round.operationNotice = phaseNotice; render(); }
      $('pErr').textContent = phaseNotice ?? (syncPending ? '轮次状态正在同步，请稍后重试；本次操作尚未签名或提交'
        : code === 'DRAW_CONFIRMATION_STALE' || code === 'DRAW_CONFIRMATION_TIMEOUT'
        ? '开奖目标确认暂未完成，请稍后重新核对；本次尚未提交交易'
        : isViewChange ? '节点网络连接不稳定，请重新尝试' : errorText(err));
      $('mFoot').hidden = false;
      $('mFoot').innerHTML = `<button class="btn" id="cancel">关闭</button>${syncPending ? '<button class="btn pri" id="retryQuote">重新向节点同步并报价</button>' : ''}`;
      $('cancel').onclick = closeModal;
      if ($('retryQuote')) $('retryQuote').onclick = async () => {
        const button = $('retryQuote'); button.disabled = true;
        await retryRoundSync(request.cid);
        if (engine !== planEngine || !$('modal').open || $('retryQuote') !== button) return;
        if (detailTracker?.observationCurrent()) await runPlan(request, state.walletEpoch);
        else button.disabled = false;
      };
      return;
    }
  }
  if (!current()) return;
  planEngine.onStatus = () => {}; lockModal(false);
  if (epoch !== state.walletEpoch) { $('pErr').textContent = '钱包已变化，请重新开始'; return; }
  showPlan(plan, epoch);
}
function showPlan(plan, epoch, replan = () => runPlan(plan.request, state.walletEpoch)) {
  const planEngine = engine, quote = {engine, plan, replan, stale: false};
  if (state.round?.cid === plan.cid) { state.round.operationNotice = null; state.round.pendingRejection = null; }
  const t = plan.draft.transaction, mine = walletFlow(plan).received;
  const spent = walletFlow(plan).spent;
  const net = spent - mine;
  const expires = plan.createdAt + 90_000;
  const lab = o => `${roleLabel(o.role)}${o.mine ? ' · 你' : ''}`;
  modal(`确认：${ACTION_LABEL[plan.action]}`, `
    <div class="notice plan-summary"><b>这笔交易会做什么</b><p>${e(planSummary(plan, U()))}</p></div>
    ${plan.replaces ? `<div class="notice warn"><b>加速：替换内存池中的原交易</b><p>花费与原交易 ${hashHtml(plan.replaces, {link: explorerTx(plan.replaces)})} 完全相同的输入，状态变化相同，只把网络费从 ${kas(plan.previousFee)} 提高到 ${kas(plan.fee)} ${U()}（排序费率 ${e(plan.previousOrderingFeerate ?? '—')} → ${e(plan.orderingFeerate)} sompi/gram）。节点只在原交易仍在其内存池中、且新费率更高时接受替换。两笔最多只有一笔生效。</p></div>` : ''}
    ${plan.action === 'DRAW_AND_PAY' ? `<div class="notice" style="border-color:var(--gold);background:var(--gold-soft)">🏆 已从选中链构造并验证 PASS-A 随机证明。按合约规则，本次开奖中奖票为 <b>#${plan.winner.ticket}</b>（记录 #${plan.winner.record + 1}），买家 ${hashHtml(pubkeyToAddress(plan.winner.key), {n: 12})}。</div>` : ''}
    ${plan.action === 'DRAW_AND_PAY' ? `<div class="notice warn">开奖无需签名，第三方可能通过RBF竞争1 ${U()}执行赏金；中奖者不变，但其承担的网络费可能提高至0.5 ${U()}。本页等待100次目标确认不消除此风险。</div>` : ''}
    ${plan.sponsored ? `<div class="notice warn">本批退款的执行费池不足以覆盖网络费/存储质量，需由你的一笔普通 UTXO 赞助；赞助本金会随执行者输出退回给你。</div>` : ''}
    <h3 style="margin:0 0 8px">全部输出（${t.outputs.length}）</h3>
    <div class="outs">${plan.outputs.map(o => `<div class="out ${o.mine ? 'mine' : ''}"><span class="r">${o.index} · ${e(lab(o))}</span><span class="out-addr">${outAddressHtml(o)}</span><span class="v">${kas(o.value)}</span></div>`).join('')}</div>
    ${feeChoiceHtml(plan)}
    <div class="sum"><span>网络手续费</span><span>${kas(plan.fee)} ${e(U())}</span></div>
    ${plan.feeClamped ? `<div class="notice warn">按节点当前费率估计，这笔交易需要 ${kas(plan.loadFee)} ${e(U())} 才能按正常顺序被打包，已按 ${kas(FEE_CAP)} ${e(U())} 保护上限封顶。网络繁忙时它可能在内存池中等待较久；在被接受或查明失败前，页面会保留输入占用，不会重发。</div>` : plan.feeMode === 'load' && plan.loadFee > plan.standardFee ? `<p class="small muted">节点费率按交易全部质量（含存储质量）计价；仅满足最低转发费（${kas(plan.standardFee)} ${e(U())}）的交易在网络繁忙时可能长时间停留在内存池。</p>` : ''}
    <div class="sum"><span>你的钱包净支出</span><span>${net >= 0n ? kas(net) : '净收入 ' + kas(-net)} ${e(U())}</span></div>
    ${plan.before ? `<dl class="kv small"><dt>状态变化</dt><dd>阶段 ${plan.before.phase} → ${plan.after ? plan.after.phase : '终局 ' + plan.terminal}；售出 ${plan.before.sold} → ${plan.after?.sold ?? plan.before.sold}；记录 ${plan.before.purchaseCount} → ${plan.after?.purchaseCount ?? plan.before.purchaseCount}${plan.after && plan.after.cursor !== plan.before.cursor ? `；退款游标 ${plan.before.cursor} → ${plan.after.cursor}` : ''}</dd></dl>` : ''}
    <details style="margin-top:8px"><summary class="small muted">技术细节</summary><dl class="kv small" style="margin-top:8px">
      <dt>交易 ID</dt><dd class="mono">${e(plan.draft.txid)}</dd><dt>CID</dt><dd class="mono">${e(plan.cid)}</dd>
      <dt>Compute budget</dt><dd>输入 0：${plan.budget}（含 ${BUDGET_MARGIN} 单位余量）· 资金输入各 10</dd>
      <dt>质量</dt><dd>compute ${plan.quote.computeMass} · storage ${plan.quote.storageMass} · transient ${plan.quote.transientMass}</dd>
      <dt>费率</dt><dd>${plan.tiers ? `节点估计 低 ${rateText(plan.conditions.low.feerate)} / 正常 ${rateText(plan.conditions.normal.feerate)} / 优先 ${rateText(plan.conditions.priority.feerate)} sompi/gram` : `节点估计 ${plan.feerate} sompi/gram`} · 本笔实际 ${plan.orderingFeerate ?? '—'} sompi/gram（按排序质量）· 上限 ${kas(FEE_CAP)} ${U()}</dd>
      <dt>需签名输入</dt><dd>${plan.draft.authorizedInputIndices.join(', ') || '无（permissionless）'}</dd>
      ${t.lockTime ? `<dt>lockTime</dt><dd>${t.lockTime}</dd>` : ''}${t.inputs[0].sequence ? `<dt>sequence</dt><dd>${t.inputs[0].sequence}</dd>` : ''}
      ${plan.proof ? `<dt>PASS-A</dt><dd>目标块 ${e(shortHash(plan.proof.target.hash))} · 边界 DAA ${plan.proof.boundaryDaa} · 目标确认 ${plan.proof.confirmation?.confirmations ?? '发送前重验'}/100 blue score · 节点 ${e(plan.proof.nodes.join(' / '))}</dd>` : ''}
    </dl></details>
    <label class="check" style="margin-top:12px"><input type="checkbox" id="approve">我已核对全部输出与费用，只批准这一笔${NET.key === 'mainnet' ? '主网' : ' Testnet 10 '}交易</label>
    <p class="small muted" id="ttl"></p><ul class="progress" id="xprog"></ul><p class="err" id="xErr"></p>`,
    `<button class="btn" id="cancel">取消</button><button class="btn pri" id="sign" disabled>${plan.draft.authorizedInputIndices.length ? '签名并提交' : '提交'}</button>`);
  activeQuote = quote;
  const tick = setInterval(() => { const left = Math.max(0, Math.round((expires - Date.now()) / 1000)); if ($('ttl')) $('ttl').textContent = left ? `报价 ${left} 秒内有效` : '报价已过期，请重新报价'; if (!left) { if (activeQuote === quote) invalidateQuote(); clearInterval(tick); } }, 500);
  modalCleanup = () => { clearInterval(tick); planEngine.discardPlan(plan); if (activeQuote === quote) activeQuote = null; };
  $('approve').onchange = () => { $('sign').disabled = quote.stale || !$('approve').checked || Date.now() >= expires; };
  // Switching the fee tier yields a NEW plan (new id); the approval checkbox starts unchecked again.
  document.querySelectorAll('[data-tier]').forEach(b => b.onclick = () => {
    if (modalBusy || quote.stale || b.disabled || b.getAttribute('aria-pressed') === 'true') return;
    try { showPlan(planEngine.chooseTier(plan, b.dataset.tier), epoch, replan); }
    catch (err) { $('xErr').textContent = errorText(err); }
  });
  $('cancel').onclick = closeModal;
  $('sign').onclick = async () => {
    if (quote.stale || planEngine !== engine || (activeExecution?.engine === engine)) return;
    const execution = {engine: planEngine, quote, phase: 'PREPARING'};
    activeExecution = execution;
    lockModal(true);
    $('sign').disabled = true; $('approve').disabled = true; $('cancel').disabled = true;
    const log = s => { if (engine !== planEngine || planEngine.disposed) return; const li = document.createElement('li'); li.className = 'run'; li.textContent = s; const x = $('xprog'); if (!x) return; x.querySelectorAll('.run').forEach(n => n.className = 'ok'); x.append(li); };
    try {
      ensure(epoch === state.walletEpoch, '钱包会话已变化，计划作废');
      const rec = await planEngine.execute(plan, {approved: $('approve').checked, onProgress: log, onPhase: phase => {
        execution.phase = phase; if ($('xprog')) $('xprog').dataset.phase = phase;
      }});
      if (engine !== planEngine || planEngine.disposed) return;
      clearInterval(tick);
      if (['SUBMITTED', 'UNKNOWN'].includes(rec.status)) void catalog.remember(rec.cid, {source: rec.action === 'GENESIS' ? 'created' : 'traded', mine: true});
      $('xprog')?.querySelectorAll('.run').forEach(n => n.className = 'ok');
      lockModal(false); showRecord(rec, true);
      if (rec.status === 'REJECTED') void onRejected(rec, planEngine);
      if (['SUBMITTED','UNKNOWN'].includes(rec.status)) { toast(rec.status === 'UNKNOWN' ? '交易待核验，可能已被接受；请勿重新创建同类交易' : '正在跟踪结果；不会改变交易内容'); void autoReconcile(rec.txid); if (rec.replaces) void autoReconcile(rec.replaces); }
    } catch (err) {
      if (engine !== planEngine || planEngine.disposed || !$('xErr')) return;
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
    } finally {
      if (activeExecution === execution) activeExecution = null;
      if (activeQuote === quote) invalidateQuote();
      if (engine !== planEngine && !document.hidden) recovery?.request();
      else recovery?.schedule();
    }
  };
}
/** Bounded follow-up (~30 min, one loop per txid): engine.follow() queries first; only when a complete search misses
 * the transaction does it diagnose, and its only send is the IDENTICAL signed bytes (tracker.mjs). Keeps the open
 * record dialog in sync, so a stuck transaction shows as "in mempool" and can be bumped. */
const following = new Map();
async function autoReconcile(txid, first = 2500) {
  const followEngine = engine;
  if (following.get(txid) === followEngine) return;
  following.set(txid, followEngine);
  const followLink = pair, release = followLink.retain?.();
  try {
    await followEngine.trackAcceptance(txid);
    if (engine === followEngine) await followLoop(txid, first, followEngine);
  } catch (err) {
    if (engine === followEngine && !followEngine.disposed) toast(`跟踪暂未完成：${errorText(err)}`, 'warn');
  } finally {
    followEngine.releaseAcceptance(txid);
    if (following.get(txid) === followEngine) following.delete(txid);
    release?.();
  }
}
async function followLoop(txid, first, followEngine) {
  let wait = first, firstSeen = false, noticeVersion = 0;
  for (let i = 0; i < 40; i++) {
    noticeVersion = await followEngine.waitForAcceptance(txid, wait, noticeVersion);
    if (engine !== followEngine || followEngine.disposed) return;
    wait = Math.min(2500 + (i + 1) * 1500, 60_000);
    try {
      const r = await followEngine.follow(txid);
      if (engine !== followEngine || followEngine.disposed) return;
      if ($('modal').open && $('recTx')?.dataset.tx === txid && !modalBusy && ['PENDING', 'UNKNOWN', 'SUBMITTED', 'REPLACED', 'SUPERSEDED', 'CONFIRMING', 'REJECTED', 'CONFLICTED', 'DRIFTED'].includes(r.status)) showRecord(r);
      // Acceptance is already proven; next-step readiness waits for the current authenticated round state.
      if (r.status === 'CONFIRMING') {
        if (!firstSeen) { firstSeen = true; void onFirstAcceptance(r, followEngine); }
        wait = followEngine.recheckDelayMs(r); continue;
      }
      if (['REJECTED', 'CONFLICTED', 'DRIFTED'].includes(r.status)) {
        if (state.round?.awaitingAcceptance?.record.txid === r.txid) state.round.awaitingAcceptance = null;
        if (r.status === 'REJECTED') { void onRejected(r, followEngine); return; }
        toast(`${ACTION_LABEL[r.action]} ${txStatus(r.status).label}`, 'warn');
        state.details.delete(r.cid); state.rows = await mergedRows();
        if (state.round?.cid === r.cid) { detailTracker?.invalidate({anchor: true}); detailTracker?.wake(); state.round.live = null; void refreshRound(r.cid); } else if (state.view === 'mine') render();
        return;
      }
      if (r.status === 'SUPERSEDED') { if (state.view === 'mine') render(); return; }
      // Displaced by a reorg after a first acceptance: search fast again (the CONFIRMING view was just withdrawn).
      if (r.displacedAt && firstSeen) {
        firstSeen = false; wait = 2500;
        if (state.round?.cid === r.cid) {
          if (state.round.awaitingAcceptance?.record.txid === r.txid) state.round.awaitingAcceptance = null;
          state.round.readyKey = null; detailTracker?.invalidate({anchor: true}); detailTracker?.wake();
          state.round.syncing = true; state.round.live = null; void refreshRound(r.cid);
        }
      }
      if (['ACCEPTED','REST_ACCEPTED'].includes(recordStatus(r))) {
        toast(`${ACTION_LABEL[r.action]} ${txStatus(recordStatus(r)).label}`);
        if ($('modal').open && $('recTx')?.dataset.tx === txid) showRecord(r);
        if (recordStatus(r)==='REST_ACCEPTED') { if(state.view==='mine') render(); return; }
        state.details.delete(r.cid);
        state.rows = await mergedRows();
        if (!firstSeen) void onFirstAcceptance(r, followEngine);
        else if (state.round?.cid === r.cid) { detailTracker?.wake(); void refreshRound(r.cid); }
        return;
      }
    }
    catch {}
  }
}
/** Presentation readiness is separate from acceptance; a known-spent predecessor cannot unlock the next button. */
function readyForRecord(r, tracker = detailTracker) {
  if (!tracker || tracker.cid !== r.cid || !tracker.observationCurrent()) return false;
  const result = tracker.observation.result;
  if (result.incomplete) return false;
  const spent = r.draft?.inputUtxos?.find(u => u.covenantId === r.cid)?.outpoint;
  const tip = result.live?.snapshot.tip;
  return result.terminal || (!!tip && (!spent || tip.transactionId !== spent.transactionId || tip.index !== spent.index));
}
function finishRoundSync(R, tracker) {
  const pending = R.awaitingAcceptance;
  if (pending && pending.engine !== engine) { R.awaitingAcceptance = null; return false; }
  if (!pending || !readyForRecord(pending.record, tracker)) return false;
  const r = pending.record, key = `${r.txid}/${r.accepting}`;
  R.awaitingAcceptance = null; R.syncing = false;
  if (R.readyKey !== key) {
    R.readyKey = key;
    toast(`${ACTION_LABEL[r.action]} 已被选中链接受 · ${tracker.observation.result.terminal ? '轮次结果已同步' : '可继续下一步'}`);
  }
  return true;
}
let recordRefreshEpoch = 0;
function refreshOpenRecord(cid) {
  const txid = $('recTx')?.dataset.tx, activeEngine = engine, epoch = ++recordRefreshEpoch;
  if (!txid || !$('modal').open || modalBusy) return;
  void activeEngine.records().then(rs => {
    if (epoch !== recordRefreshEpoch || engine !== activeEngine || modalBusy || !$('modal').open || $('recTx')?.dataset.tx !== txid) return;
    const record = rs.find(r => r.cid === cid && r.txid === txid);
    if (record && !['RECHECKING', 'SUBMITTING'].includes(record.status)) showRecord(record);
  }).catch(() => {});
}
/** Join the SAME detail read. The UI stays held until its authenticated successor/terminal is actually published. */
async function onFirstAcceptance(r, activeEngine = engine) {
  if (engine !== activeEngine || activeEngine.disposed) return;
  state.details.delete(r.cid);
  if (r.action === 'GENESIS' && state.view === 'create') await openRound(r.cid);
  if (engine !== activeEngine || activeEngine.disposed) return;
  const R = state.view === 'round' && state.round?.cid === r.cid ? state.round : null;
  if (R) {
    R.awaitingAcceptance = {record: r, engine: activeEngine};
    R.syncing = !detailTracker?.observationCurrent();
    if (!document.hidden) {
      const tracker = detailTracker?.cid === r.cid ? detailTracker : trackDetail(r.cid);
      if (!finishRoundSync(R, tracker)) {
        render(); refreshOpenRecord(r.cid);
        try { await tracker?.synchronize(); }
        catch (error) {
          if (engine === activeEngine && state.round === R && R.awaitingAcceptance?.record === r) {
            R.syncError = '交易接受结果已核验；当前轮次尚未追赶完成。可重新向节点同步，新操作仍需报价核验。';
            R.staleNote = errorText(error);
          }
        }
        if (engine === activeEngine && state.round === R && detailTracker === tracker) {
          finishRoundSync(R, tracker); render(); refreshOpenRecord(r.cid);
        }
      } else { render(); refreshOpenRecord(r.cid); }
    }
  }
  try {
    const rows = await mergedRows();
    if (engine === activeEngine) { state.rows = rows; if (state.view === 'mine') render(); }
  } catch {}
}
/** Explicit read-only recovery is always available; it never signs, rebuilds or broadcasts a transaction. */
async function retryRoundSync(cid, {anchor = null} = {}) {
  const R = state.view === 'round' && state.round?.cid === cid ? state.round : null, activeEngine = engine;
  if (!R) return;
  if (R.retryWork) { if (detailTracker?.cid === cid) detailTracker.hintLookup(anchor); return R.retryWork; }
  const task = Promise.resolve().then(async () => {
    R.syncError = null; R.syncing = true; R.live = null;
    if (activeQuote?.plan.cid === cid) invalidateQuote();
    const tracker = detailTracker?.cid === cid ? detailTracker : trackDetail(cid, {force: true});
    render(); refreshOpenRecord(cid);
    const result = await tracker?.retry({anchor});
    if (engine !== activeEngine || state.round !== R || detailTracker !== tracker || !result) return;
    adoptVerifiedRound(R, tracker);
    finishRoundSync(R, tracker); finishRejectedSync(R, tracker); render(); refreshOpenRecord(cid);
  }).catch(error => {
    if (engine === activeEngine && state.round === R) {
      R.syncError = '节点尚未返回当前可操作状态。可重新向节点同步；新的操作仍会在报价前核验。';
      R.staleNote = errorText(error); render(); refreshOpenRecord(cid);
    }
  }).finally(() => { if (R.retryWork === task) R.retryWork = null; });
  R.retryWork = task;
  return task;
}
function finishRejectedSync(R, tracker) {
  const r = R.pendingRejection;
  if (!r || r.networkGenesis !== NET.genesis || !tracker?.observationCurrent()) return;
  const result = tracker.observation.result;
  if (result.incomplete) return;
  const spent = r.draft?.inputUtxos?.find(u => u.covenantId === r.cid)?.outpoint;
  const advanced = !!spent && readyForRecord(r, tracker);
  R.operationNotice = advanced
    ? r.action === 'CLOSE' && (result.terminal || result.live?.ledger.phase !== 1)
      ? '本次封盘被节点拒绝。轮次已由另一笔交易抢先封盘，页面已更新。'
      : '本次操作被节点拒绝。轮次已被其他交易抢先推进，请按最新状态重新报价。'
    : '本次操作被节点拒绝；已核验轮次当前状态，具体拒绝原因见交易记录。';
  R.pendingRejection = null;
}
/** Rejection feedback persists immediately. Every later verified update can complete its explanation. */
async function onRejected(r, activeEngine = engine) {
  if (engine !== activeEngine || activeEngine.disposed) return;
  toast(`${ACTION_LABEL[r.action]} 被节点拒绝，请查看交易记录中的原因`, 'bad');
  state.details.delete(r.cid);
  const R = state.view === 'round' && state.round?.cid === r.cid ? state.round : null;
  if (!R) { state.nodeViews.delete(r.cid); if (state.view === 'mine') render(); return; }
  if (R.awaitingAcceptance?.record.txid === r.txid) R.awaitingAcceptance = null;
  R.pendingRejection = r;
  // A late rejection must not erase the successor that this session has already verified.
  if (readyForRecord(r) && adoptVerifiedRound(R, detailTracker)) {
    finishRejectedSync(R, detailTracker); render(); refreshOpenRecord(r.cid); return;
  }
  state.nodeViews.delete(r.cid);
  R.live = null; R.syncing = true;
  R.operationNotice = r.action === 'CLOSE'
    ? '本次封盘被节点拒绝。正在核对是否已有其他交易抢先完成。'
    : '本次操作被节点拒绝。正在核对是否已有其他交易抢先推进。';
  if (R.detail) R.detail = {...R.detail, _src: 'cache', indexStatus: 'STALE'};
  render(); refreshOpenRecord(r.cid);
  const anchor = [r.lookupStart, ...(r.anchors ?? []).map(a => a.sink)].find(x => /^[0-9a-f]{64}$/.test(x ?? ''));
  if (!document.hidden) await retryRoundSync(r.cid, {anchor});
}
/** Manual identical-bytes resend: offered after a diagnosed "dropped" outside the automatic window. */
const canResend = r => ['SUBMITTED', 'PENDING', 'UNKNOWN'].includes(r.status) && !r.replacedBy && !!r.signed && r.guard?.last === 'DROPPED';
/** Fee bump is offered only for this browser's own unsettled, not-yet-replaced record (the node decides if it is in the mempool). */
const TRACKED_VIEW = new Set(['SUBMITTED', 'PENDING', 'UNKNOWN']);
const canBump = r => ['SUBMITTED', 'PENDING'].includes(r.status) && !r.replacedBy && (!r.mempool || r.mempool.present);
function replaceBox(r) {
  const rows = [];
  if (r.mempool) rows.push(['节点内存池', r.mempool.present ? `在内存池中 · 费用 ${kas(r.mempool.fee)} ${U()} · 核对于 ${timeHtml(r.mempool.checkedAt)}` : `未在内存池中 · 核对于 ${timeHtml(r.mempool.checkedAt)}`]);
  if (r.orderingFeerate) rows.push(['本笔排序费率', `${e(r.orderingFeerate)} sompi/gram${r.feeTier === 'economy' ? ' · 经济档' : r.feeTier === 'fast' ? ' · 快速档' : ''}`]);
  if (r.replaces) rows.push(['替换了', `${hashHtml(r.replaces, {link: explorerTx(r.replaces)})} · 原费用 ${kas(r.previousFee)} ${U()}`]);
  if (r.replacedBy) rows.push(['已被替换为', hashHtml(r.replacedBy, {link: explorerTx(r.replacedBy)})]);
  if (r.supersededBy) rows.push(['已生效的交易', hashHtml(r.supersededBy, {link: explorerTx(r.supersededBy)})]);
  return rows.length ? facts(rows) : '';
}
async function bumpFee(r) {
  if (!state.session) { await connectWallet(); if (!state.session) return; }
  const epoch = state.walletEpoch, planEngine = engine, planning = ++planningEpoch;
  const current = () => engine === planEngine && !planEngine.disposed && planning === planningEpoch;
  modal('加速交易', `<ul class="progress" id="prog"><li class="run" id="pstat">准备…</li></ul><p class="err" id="pErr"></p>`);
  lockModal(true);
  planEngine.onStatus = s => { const el = $('pstat'); if (current() && el) el.textContent = s; };
  let plan;
  try { await recovery?.flush(); if (!current()) return; plan = await planEngine.planReplacement(r.txid, state.session); }
  catch (err) { if (!current() || !$('pErr')) return; lockModal(false); planEngine.onStatus = () => {}; $('prog').innerHTML = ''; $('pErr').textContent = errorText(err); $('mFoot').hidden = false; $('mFoot').innerHTML = `<button class="btn" id="cancel">关闭</button>`; $('cancel').onclick = closeModal; return; }
  if (!current()) return;
  planEngine.onStatus = () => {}; lockModal(false);
  if (epoch !== state.walletEpoch) { $('pErr').textContent = '钱包已变化，请重新开始'; return; }
  showPlan(plan, epoch, () => bumpFee(r));
}
const recordLabel = (r, daa = state.daa) => txLabel(r, NET, daa, engine?.reorgRecheckDaa ?? 100n);
/** Display smoothing only: a short RECHECKING/UNKNOWN blip (incomplete read, the gap between leaving the mempool and the
 * chain search finding it) keeps the last settled view for 60 s. Stored status, data-state and every action keep using
 * the real record; a reorg displacement is shown at once. */
const lastShown = new Map(), SHOWN_GRACE_MS = 60_000;
function shownRecord(r) {
  const s = recordStatus(r), prev = lastShown.get(r.txid);
  if (!['UNKNOWN', 'RECHECKING'].includes(s)) { lastShown.set(r.txid, {r, at: Date.now()}); return r; }
  return prev && Date.now() - prev.at < SHOWN_GRACE_MS && !(r.displacedAt > prev.at) ? prev.r : r;
}
function statusBadge(r) { const v=shownRecord(r), t=txStatus(recordStatus(v)); return `<span class="badge t-${e(t.tone)}" data-tx-label>${e(recordLabel(v))}</span>`; }
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
function executionTiming(r) {
  const x = r.executionTimings, valid = n => Number.isSafeInteger(n) && n >= 0;
  if (x?.schema !== 'KASWIN_EXECUTION_TIMING_1' || ![x.startedAt, x.finishedAt, x.elapsedMs].every(valid)) return null;
  const phaseMs = Object.fromEntries(['PREPARING', 'SIGNING', 'VERIFYING', 'PERSISTING', 'SUBSCRIBING', 'SUBMITTING']
    .filter(k => valid(x.phaseMs?.[k])).map(k => [k, x.phaseMs[k]]));
  return {schema: x.schema, startedAt: x.startedAt, finishedAt: x.finishedAt, elapsedMs: x.elapsedMs, phaseMs};
}
// Normal progress is already in the status badge; the dialog only explains abnormal states.
const PLAIN_PROGRESS = new Set(['SUBMITTED', 'PENDING', 'CONFIRMING', 'ACCEPTED', 'REST_ACCEPTED']);
function showRecord(r, fresh = false) {
  recordRefreshEpoch++;
  const activeRound = state.view === 'round' && state.round?.cid === r.cid;
  const accepted = ['CONFIRMING', 'ACCEPTED'].includes(r.status);
  const ready = activeRound && readyForRecord(r);
  const previousError = ['CONFIRMING', 'ACCEPTED'].includes(r.status) && !!r.error;
  const viewChanged = r.status === 'UNKNOWN' && String(r.error ?? '').includes('READ_VIEW_CHANGED');
  const nodeMessage = viewChanged ? '节点连接或链视图在读取期间发生变化，本次核验需重试；这不代表交易失败，也不代表链上未接受。' : r.error;
  const timing = executionTiming(r), shown = shownRecord(r);
  const timingHtml = timing ? `<details><summary>${text('流程耗时')}</summary>${facts([
    [text('签署及签名核验'), `${timing.phaseMs.SIGNING ?? 0} ms`],
    [text('本地准备与记录'), `${(timing.phaseMs.PREPARING ?? 0) + (timing.phaseMs.VERIFYING ?? 0) + (timing.phaseMs.PERSISTING ?? 0)} ms`],
    [text('订阅准备'), `${timing.phaseMs.SUBSCRIBING ?? 0} ms`],
    [text('提交阶段'), `${timing.phaseMs.SUBMITTING ?? 0} ms`],
    [text('执行到提交结果'), `${timing.elapsedMs} ms`],
  ])}</details>` : '';
  modal(`${ACTION_LABEL[r.action] ?? r.action} · 交易记录`, `
    <div id="recTx" data-tx="${e(r.txid)}" data-state="${e(recordStatus(r))}" data-transport-ms="${e(r.transport?.elapsedMs ?? '')}" data-execution="${timing ? e(JSON.stringify(timing)) : ''}" data-round-ready="${ready ? 'true' : 'false'}"></div>
    ${PLAIN_PROGRESS.has(recordStatus(shown)) ? '' : `<div class="notice ${needsAttention(shown)?'warn':''}">${e(txStatus(recordStatus(shown)).meaning)}</div>`}
    ${r.status === 'REJECTED' && activeRound && state.round.operationNotice ? `<div class="notice warn">${e(state.round.operationNotice)}</div>` : ''}
    ${fresh && r.status === 'SUBMITTED' ? '<div class="notice ok">节点已接收交易。<b>接收 ≠ 接受</b>：页面会自动在选中链上核对，也可随时手动对账。</div>' : ''}
    ${shown.status === 'UNKNOWN' && needsAttention(r) ? '<div class="notice small">页面会继续查询。只有查明交易已消失且输入仍未花费时，才按原签名字节重发；不会自动重建交易或释放尚未查明的输入。</div>' : ''}
    ${['CONFLICTED', 'DRIFTED'].includes(r.status) ? `<div class="notice warn">${e(r.note ?? '')}。输入占用已释放；请刷新轮次后按最新链上状态重新报价。</div>` : ''}
    ${r.guard?.last && TRACKED_VIEW.has(r.status) ? `<p class="small muted">跟踪诊断：${e(r.note ?? r.guard.last)} · ${timeHtml(r.guard.at)}${r.resends ? ` · 已按原字节重发 ${e(r.resends)} 次` : ''}</p>` : ''}
    ${r.status === 'REJECTED' ? `<div class="notice bad">节点明确拒绝：${e(r.error ?? '')}。这是提交拒绝回执，不是整体余额证明。</div>` : ''}
    ${facts([['状态', statusBadge(r)], ['交易 ID', hashHtml(r.txid, {link: explorerTx(r.txid)})], ['轮次 CID', hashHtml(r.cid)], ['网络费', `${kas(r.fee)} ${U()}`], r.transport && ['节点提交往返', `${e(r.transport.elapsedMs)} ms`], r.actualFee !== undefined && ['实际费用', `${kas(r.actualFee)} ${U()}`], r.accepting && ['接受块', hashHtml(r.accepting, {link: explorerBlock(r.accepting)})], r.locatedBy === 'REST' && ['接受块定位', 'REST 提供位置，节点已完整复验'], r.acceptingDaa && ['接受 DAA', String(r.acceptingDaa)], r.depthDaa != null && ['接受块深度', `${String(r.depthDaa)} DAA（核对时）`], ['创建时间', timeHtml(r.createdAt)], r.verifiedAt && ['最近核验', timeHtml(r.verifiedAt)]])}
    ${timingHtml}
    ${replaceBox(r)}
    ${restBox(r)}
    ${r.note ? `<p class="small muted">节点核对：${e(r.note)}</p>` : ''}${r.error && !previousError && (needsAttention(r)||r.restCheck) ? `<p class="small muted">节点信息：${e(nodeMessage)}</p>${viewChanged ? `<details class="small muted"><summary>技术信息</summary><code>${e(r.error)}</code></details>` : ''}` : ''}
    ${previousError ? `<details class="small muted"><summary>此前未完成核验的技术信息（当前已核验接受）</summary><code>${e(r.error)}</code></details>` : ''}
    <h3 style="margin:14px 0 8px">本机批准的输出</h3><div class="outs">${(r.outputs ?? []).map(o => `<div class="out ${o.mine ? 'mine' : ''}"><span class="r">${o.index} · ${e(roleLabel(o.role))}</span><span class="out-addr">${outAddressHtml(o)}</span><span class="v">${kas(o.value)}</span></div>`).join('')}</div>`,
    `${accepted && activeRound ? '<button class="btn" id="retryRoundState">重新向节点同步</button>' : ''}${['UNKNOWN', 'REJECTED'].includes(recordStatus(r)) ? '<button class="btn warn" id="arch">检查是否可归档</button>' : ''}<button class="btn" id="dl">${icon('download')}导出</button>${canBump(r) ? '<button class="btn gold" id="bump">加速（提高手续费替换）</button>' : ''}${canResend(r) ? '<button class="btn warn" id="resend">按原签名字节重发</button>' : ''}${['ARCHIVED', 'SUPERSEDED'].includes(r.status)?'':'<button class="btn pri" id="rec">核对结果</button>'}`);
  if (recordStatus(shown) === 'CONFIRMING') {
    // Live "x confirms" only; 已接受 still comes from followLoop's node recheck re-rendering this dialog.
    const tickLink = pair; let busy = false;
    const tick = setInterval(async () => {
      if (busy || $('recTx')?.dataset.tx !== r.txid) return;
      busy = true;
      try { const daa = await tickLink.currentDaa(); const badge = $('mBody').querySelector('[data-tx-label]'); if (badge && $('recTx')?.dataset.tx === r.txid) badge.textContent = recordLabel(shown, daa); }
      catch {} finally { busy = false; }
    }, 1000);
    modalCleanup = () => clearInterval(tick);
  }
  if ($('retryRoundState')) $('retryRoundState').onclick = () => retryRoundSync(r.cid);
  if ($('bump')) $('bump').onclick = () => bumpFee(r);
  if ($('resend')) $('resend').onclick = async () => {
    $('resend').disabled = true; lockModal(true);
    const activeEngine = engine;
    try {
      const next = await activeEngine.follow(r.txid, {manualResend: true});
      if (engine !== activeEngine || activeEngine.disposed) return;
      lockModal(false); showRecord(next);
      if (next.status === 'REJECTED') void onRejected(next, activeEngine);
      else {
        if (['CONFIRMING', 'ACCEPTED'].includes(next.status)) void onFirstAcceptance(next, activeEngine);
        if (['CONFIRMING', 'SUBMITTED', 'PENDING', 'UNKNOWN', 'REPLACED'].includes(next.status)) void autoReconcile(next.txid);
      }
    }
    catch (err) { if (engine === activeEngine) { lockModal(false); toast(errorText(err), 'bad'); if ($('resend')) $('resend').disabled = false; } }
  };
  if ($('rec')) $('rec').onclick = async () => {
    const activeEngine = engine;
    $('rec').disabled = true; lockModal(true);
    const progress = message => { if (engine === activeEngine && $('rec')) $('rec').textContent = message; };
    try {
      const next = r.status === 'REJECTED' ? await activeEngine.reconcile(r.txid, progress) : await activeEngine.follow(r.txid, {onProgress: progress});
      if (engine !== activeEngine || activeEngine.disposed) return;
      lockModal(false); showRecord(next);
      if (next.status === 'REJECTED') void onRejected(next, activeEngine);
      else if (['CONFIRMING', 'ACCEPTED'].includes(next.status)) void onFirstAcceptance(next, activeEngine);
      if (['CONFIRMING', 'SUBMITTED', 'PENDING', 'UNKNOWN', 'REPLACED'].includes(next.status)) void autoReconcile(next.txid);
      if (state.view === 'mine') render();
    } catch (err) {
      if (engine === activeEngine) { lockModal(false); toast(errorText(err), 'bad'); if ($('rec')) $('rec').disabled = false; }
    }
  };
  $('dl').onclick = () => download({kind: 'KASWIN_LOCAL_RECORD', ...r}, `kaswin-tx-${r.txid.slice(0, 12)}.json`);
  $('arch') && ($('arch').onclick = async () => {
    if (!confirm(text('归档将释放本页的输入占用，但不会撤回网络中的交易，也不代表原交易失败。只有节点明确拒绝或输入已失效时才允许。继续检查？'))) return;
    lockModal(true); try { await engine.archive(r.txid); lockModal(false); toast('已归档；不代表原交易未曾生效'); closeModal(); if (state.view === 'mine') render(); } catch (err) { lockModal(false); toast(errorText(err), 'bad'); }
  });
}

/* ================================================================== CREATE */
const DURATIONS = [['10', '10 分钟'], ['30', '30 分钟'], ['60', '1 小时'], ['360', '6 小时'], ['1440', '24 小时'], ['custom', '自定义']];
const DEFAULT_CREATE = {price: '1', cap: '100000', min: '3', pcap: '256', dur: '60', custom: '120', registry: true};
function renderCreate(v) {
  const saved = LS.get('createForm', null);
  const f = state.createForm ??= (saved ? {...DEFAULT_CREATE, ...saved} : {...DEFAULT_CREATE});
  v.innerHTML = `
  <div class="cols">
    <div class="panel">
      <h2>${icon('create')} 创建一个新轮次</h2>
      <p class="sub">填写规则 → 查看完整费用 → 确认后提交。现在填写不会扣款，创建后的规则不可更改。</p>
      <div class="form">
        <label class="field">每张票价格（${e(U())}）<input id="cPrice" value="${e(f.price)}" inputmode="decimal" maxlength="20"><small>≥ 1 ${e(U())}，最多 8 位小数</small></label>
        <label class="field">总票数上限<input id="cCap" value="${e(f.cap)}" inputmode="numeric" maxlength="6"><small>3 – 100,000</small></label>
        <label class="field">开奖最低票数<input id="cMin" value="${e(f.min)}" inputmode="numeric" maxlength="6"><small>≥ 3；封盘时不足则全部退款</small></label>
        <details class="full advanced"><summary>高级规则 <span class="muted small">每次购买占一条记录 · 默认最多256条</span></summary><label class="field">购买记录上限<input id="cPcap" value="${e(f.pcap)}" inputmode="numeric" maxlength="3"><small>1 – 256；记录满时可提前封盘，即使票未售罄</small></label></details>
        <div class="field full">最早可封盘时间<div class="pills" id="cDur">${DURATIONS.map(([k, l]) => `<button type="button" data-dur="${k}" aria-pressed="${f.dur === k}">${l}</button>`).join('')}</div>
          <input id="cCustom" value="${e(f.custom)}" inputmode="numeric" maxlength="5" placeholder="分钟（1–10080）" ${f.dur === 'custom' ? '' : 'hidden'}>
          <small id="cDaa">按 ≈ ${DAA_PER_SECOND} DAA/秒换算；创建前从节点读取当前 DAA。时间到后才“允许”封盘，不会自动封盘；满票或满记录可提前封盘。</small></div>
        <label class="check full"><input type="checkbox" id="cReg" ${f.registry ? 'checked' : ''}>附加 0.2 ${e(U())} Registry 登记输出（供索引自动发现本轮）</label>
        <label class="field full" id="cRegBox" ${f.registry ? '' : 'hidden'}>登记地址<input id="cRegAddr" value="${e(f.registryAddrs?.[NET.key] ?? NET.registry.address)}" spellcheck="false" autocomplete="off" placeholder="${e(NET.registry.address)}">
          <small>默认是 Kaswin 登记地址（留空即默认）。仅支持本网络的 Schnorr P2PK 或 P2SH 地址；0.2 ${e(U())} 付给该地址，不可撤回。</small><small class="why" id="cRegWarn"></small></label>
      </div>
      <p class="err" id="cErr"></p>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn pri" id="cGo">${icon('arrow')}核验并报价</button></div>
    </div>
    <div>
      <div class="panel"><h3>预览</h3><div id="cPrev"></div></div>
      <div class="panel"><h3>你将支付</h3><dl class="kv"><dt>押金</dt><dd>4 ${e(U())}（派奖/空轮退4；全部退款完成后退3.98，0.02进执行费池）</dd><dt>Registry</dt><dd>0.2 ${e(U())}（可选，转入上方填写的登记地址）</dd><dt>网络费</dt><dd>按节点实时费率与交易质量精确报价，≤ 0.5 ${U()}</dd></dl>
      <p class="small muted">创建者没有特权：任何人都能封盘、开奖、超时转退款或执行退款批次；创建者只在终局收回押金。</p></div>
    </div>
  </div>`;
  const save = () => LS.set('createForm', {price: f.price, cap: f.cap, min: f.min, pcap: f.pcap, dur: f.dur, custom: f.custom, registry: f.registry, registryAddrs: f.registryAddrs});
  const read = () => {
    f.price = $('cPrice').value.trim(); f.cap = $('cCap').value.trim(); f.min = $('cMin').value.trim(); f.pcap = $('cPcap').value.trim(); f.custom = $('cCustom').value.trim(); f.registry = $('cReg').checked;
    const addr = $('cRegAddr').value.trim().toLowerCase() || NET.registry.address;
    // Only a custom address is remembered, so a future change of the network default is not pinned by an old copy.
    f.registryAddrs = {...f.registryAddrs, [NET.key]: addr === NET.registry.address ? undefined : addr}; $('cRegBox').hidden = !f.registry;
    save();
    // A non-default address is the user's choice; this page and the default indexer only discover the default one.
    $('cRegWarn').textContent = f.registry && addr !== NET.registry.address ? '已改为非默认地址：默认 Indexer 与 REST 只扫描默认登记地址，本轮不会被它们自动发现，只能由监听该地址的索引收录。' : '';
    let registry = false;
    if (f.registry) { try { addressToSpk(addr, NET.addressPrefix); } catch (err) { throw new UserError(`登记地址无效：${errorText(err)}`); } registry = addr === NET.registry.address ? true : addr; }
    const int = (s, lo, hi, n) => { ensure(/^[1-9][0-9]*$/.test(s) && +s >= lo && +s <= hi, `${n} 须为 ${lo}–${hi} 的整数`); return +s; };
    const minutes = f.dur === 'custom' ? int(f.custom, 1, 10080, '自定义分钟') : +f.dur;
    let price; try { price = kasToSompi(f.price); } catch { throw new UserError('票价格式错误（最多 8 位小数）'); }
    const cfg = {ticketPrice: price, ticketCap: int(f.cap, 3, 100000, '总票数'), purchaseCap: int(f.pcap, 1, 256, '购买记录上限'), minTickets: int(f.min, 3, 100000, '最低票数'), closeEligibleDaa: 1n};
    ensure(cfg.minTickets <= cfg.ticketCap, '最低票数不能超过总票数');
    ensure(price >= S.MIN_PRICE, `票价至少 1 ${U()}`);
    ensure(price <= (S.VALUE_LIMIT - S.DEPOSIT) / BigInt(cfg.ticketCap), '票价 × 总票数超出协议上限');
    return {cfg, minutes, registry};
  };
  const preview = () => {
    try {
      const {cfg, minutes} = read(); $('cErr').textContent = '';
      const pool = cfg.ticketPrice * BigInt(cfg.ticketCap);
      $('cPrev').innerHTML = facts([['满票奖池', `${kas(pool)} ${U()}`], ['满票时中奖者约得', `${kas(pool - S.FINALIZER)} ${U()}（−1 ${U()} 赏金 −网络费）`], ['单张中奖概率（满票）', `1 / ${cfg.ticketCap.toLocaleString()}`], ['最早封盘', `约 ${minutes >= 60 ? (minutes / 60).toFixed(minutes % 60 ? 1 : 0) + ' 小时' : minutes + ' 分钟'} 后`], ['购买记录', `${cfg.purchaseCap} 条（退款需 ${Math.ceil(cfg.purchaseCap / 32)} 批）`], ['不足 ' + cfg.minTickets + ' 张', `封盘后全部退款（每条扣 0.02 ${U()} 执行费）`]]);
    } catch (err) { $('cErr').textContent = errorText(err); $('cPrev').innerHTML = ''; }
  };
  v.querySelectorAll('input').forEach(i => { i.addEventListener('input', preview); i.addEventListener('change', preview); });
  v.querySelectorAll('[data-dur]').forEach(b => b.onclick = () => { f.dur = b.dataset.dur; save(); v.querySelectorAll('[data-dur]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); $('cCustom').hidden = f.dur !== 'custom'; preview(); });
  preview();
  $('cGo').onclick = async () => {
    try {
      const {cfg, minutes, registry} = read();
      if (!state.session) { await connectWallet(); if (!state.session) return; }
      $('cGo').disabled = true; $('cErr').textContent = '读取节点 DAA…';
      await pair.connect(); const daa = await pair.currentDaa(); state.daa = daa;
      cfg.closeEligibleDaa = daa + BigInt(minutes * 60 * DAA_PER_SECOND);
      $('cErr').textContent = '';
      await runPlan({action: 'GENESIS', config: cfg, registry}, state.walletEpoch);
    } catch (err) { $('cErr').textContent = errorText(err); }
    finally { $('cGo') && ($('cGo').disabled = false); }
  };
}

/* ================================================================== MINE */
async function renderMine(v) {
  v.innerHTML = `<div class="section-title"><div><span class="eyebrow">MY ACTIVITY</span><h2>我的交易与轮次</h2></div><button class="btn" id="checkAll">核对所有待确认交易</button></div>
  <div class="notice small">这里是<b>当前站点、当前浏览器</b>保存的当前 Profile 交易，不是钱包完整历史。其他 Profile 的记录不会迁移或在此对账，但同网络、同记录库中的未释放输入仍会阻止重复使用；请用对应版本处理原记录。其他域名、端口或记录库不共享此保护。页面会跟踪本机交易：先查询；交易从网络消失且输入仍未花费时，只按原签名字节重发（提交后 30 分钟内自动，之后需手动）；不改变交易内容，也不会自动归档。提交超过 10 分钟、节点仍查不明时，会把<b>交易 ID</b>发给公共 REST 索引 <b>api-tn10.kaspa.org</b> 备查（对方可见你的 IP）。REST 给出的接受块会再交给节点复验：复验通过标为「已接受」；节点已裁剪该段历史标为「已接受 · REST」；节点与 REST 矛盾则以节点为准，保持未知。</div>
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
  // This view uses the session catalogue; only the explicit refresh action fetches the list.
}
function renderMineRounds() {
  if (state.view !== 'mine' || !$('mineRounds')) return;
  const me = state.session?.key;
  const mine = me ? state.rows.filter(r => r.state && (r.state.ownerKey === me || r.purchases?.some(p => p.key === me))) : [];
  $('mineRoundsNote').innerHTML = state.live ? `轮次状态取自索引（${timeHtml(state.liveAt)} 读取），仍属待节点核验的候选信息。` : '索引暂未读取或不可用：以下为本机缓存/本机记录，可能不是最新状态。';
  $('mineRounds').innerHTML = !me ? '<div class="empty">连接钱包后显示你创建或购买过的轮次。</div>' : mine.length ? mine.map(card).join('') : '<div class="empty">已读取的详情中没有找到相关轮次；不代表全网没有你的参与记录。可在广场打开目标 CID。</div>';
  document.querySelectorAll('#mineRounds [data-cid]').forEach(c => c.onclick = () => openRound(c.dataset.cid));
}

/* ================================================================== FEE CALCULATOR (protocol page) */
// No inherited V2 fixed fee estimates: V2.0.2 fees are quoted from actual inputs/outputs and live node rates.

function budgetPanel(pc) {
  const st = {purchaseCount: pc, cursor: 0, sold: pc, config: {minTickets: 3}};
  const rows = [['第 ' + Math.min(pc + 1, 256) + ' 笔购买', 'BUY', {...st, purchaseCount: Math.min(pc, 255)}], ['封盘 → 封存', 'CLOSE', st], ['封盘 → 退款', 'CLOSE', {...st, config: {minTickets: 100000}}], ['开奖派奖', 'DRAW_AND_PAY', st], ['超时转退款', 'TIMEOUT_REFUND', st], ['首批退款', 'REFUND', st], ['后续退款批', 'REFUND', {...st, cursor: Math.min(32, pc - 1)}]].filter(r => !(r[1] === 'REFUND' && r[2].cursor >= pc));
  return `<label class="field">购买记录数：<b id="budgetPcV">${pc}</b><input type="range" class="slider" id="budgetPc" min="1" max="256" value="${pc}"></label>
    <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>动作</th><th>compute budget</th><th>约占质量</th><th>网络费</th></tr></thead><tbody>${rows.map(([l, a, s0]) => { const b = actionBudget(a, {...s0, phase: 1}); return `<tr><td>${e(l)}</td><td class="mono">${b}</td><td class="mono">${(b * 100).toLocaleString()} g</td><td class="mono">按实际交易报价</td></tr>`; }).join('')}</tbody></table></div>
    ${budgetChart()}
    <p class="small muted">交易手续费由原生交易 Mass 与节点实时费率动态迭代收敛，单笔风控上限 0.5 ${U()}。V2.0.2 已有离线 VM 2549 例预算矩阵与 TN10 实测记录（见项目验证文档）；不是本页真钱包验收或当前网络重新确认。compute budget 每单位对应 100 g 算力质量。</p>`;
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
          <li><b>Kaspa L1 共识</b>执行三份固定合约：状态后继、买家退款、中奖者奖金及创建者押金由脚本约束。退款末输出也绑定执行者；其他辅助输出按动作规则处理，本页另施严格找零与费用策略。</li>
          <li><b>随机数</b>来自封存 100 DAA 后首个跨越边界的选中链区块（PASS-A 序列承诺），合约在花费时用 OpChainblockSeqCommit 校验证明，伪造的证明只会让交易失败；不接受其他随机源，样本被拒也不重抽。</li>
          <li><b>本页</b>只是一个构建器：用嵌入的固定合约帧与核心库生成交易，用移植自 rusty-kaspa 的质量公式报价，用 BIP-340 校验钱包签名。</li>
          <li><b>Kaspa 节点</b>（默认 ${e(host(DEFAULT_NODE))} 提供的 kaspad 入口，可在设置中更换）是访问共识的入口：页面通过它读取 UTXO、接受数据与区块头，并提交交易。本页信任所配置节点如实反映 Kaspa 共识；资金规则本身由所有节点共同执行的合约脚本保证。</li>
          <li><b>Indexer</b> 只用于发现轮次和提供账本原文；所有数值在操作前都由节点复验。</li>
          <li><b>KasWare</b> 只签你自己的普通资金输入（SIGHASH_ALL）。v1 签名不覆盖 compute budget / storage mass，所以页面在签名后自行核对这些字段再提交。</li>
        </ul></div>
      <div class="panel"><h3>规则速查</h3><dl class="kv">
        <dt>购买</dt><dd>开放阶段任何人可买；每次购买追加一条目录记录（票号区间 + 买家公钥），票款精确进入状态 UTXO。</dd>
        <dt>封盘</dt><dd>满票、满设定的购买记录上限或到达封盘 DAA 后任何人可封：售出 ≥ 最低票数 → 封存；不足 → 退款；0 张 → 空轮，押金退创建者。</dd>
        <dt>开奖派奖</dt><dd>合约要求封存 ≥ 100 DAA；本页另等实际目标块100次blue-score确认。三个输出：中奖者（奖池 − 1 ${U()} − 网络费）、创建者押金4、执行者赏金1 ${U()}。网络费 ≤ 0.5 ${U()}。</dd>
        <dt>超时</dt><dd>封存 ≥ 432000 DAA 仍未开奖，任何人可转入退款阶段（仍需有人推进并能取得构建所需账本/证明；历史裁剪可能阻止本页构建）。</dd>
        <dt>退款</dt><dd>按购买顺序每批32条；每条退还张数×票价−0.02 ${U()}。执行费池付网络费，余额归执行者；最后一批押金退3.98 ${U()}，另0.02进入执行费池。</dd>
      </dl></div>
    </div>
    <div>
      <div class="panel"><h3>固定 Profile</h3>${facts([['Profile ID', hashHtml(PROFILE_ID)], ['当前网络', `${e(NET.label)}（${e(NET.unit)}）`], ['网络 Genesis', hashHtml(NET.genesis)], ['SilverScript', `v1.0.0 · <span class="mono">${COMPILER_COMMIT.slice(0, 10)}</span>`], ['OPEN', `${hashHtml(profile.frames.open.templateHash)} · ${profile.frames.open.tail.length} B`], ['SEALED', `${hashHtml(profile.frames.sealed.templateHash)} · ${profile.frames.sealed.tail.length} B`], ['REFUNDING', `${hashHtml(profile.frames.refunding.templateHash)} · ${profile.frames.refunding.tail.length} B`]])}
        <p class="small muted">页面启动时用嵌入的模板尾部重新计算模板哈希与 Profile ID，不一致即拒绝运行。</p></div>
      <div class="panel"><h3>${icon('gauge')} 计算预算与费用</h3><div id="budgetBox">${budgetPanel(state.budgetPc ?? 128)}</div></div>
    </div>
  </div>`;
  const bindBudget = () => { $('budgetPc').oninput = ev => { state.budgetPc = +ev.target.value; $('budgetBox').innerHTML = budgetPanel(state.budgetPc); bindBudget(); }; };
  bindBudget();
}
function settingsDialog() {
  const st = pair.status();
  modal('节点与索引配置', `<div class="notice small"><b>支持无证书连接：</b>节点可填 ws:// 或 wss://，索引器可填 http:// 或 https://。本页信任所选节点如实反映共识；切换地址是更换数据来源，不是增加独立验证。不会自动将明文地址改成加密地址。</div><div class="form">
    <label class="field full">Kaspa 节点（ws / wss · ${e(NET.label)} JSON wRPC，每行一个；首次按顺序连接，之后自动选择）<textarea id="sNodes" rows="5" spellcheck="false" style="background:var(--panel2);border:1px solid var(--line2);border-radius:10px;padding:10px;font:12px var(--mono);color:var(--text)">${e(state.nodes.join('\n'))}</textarea>
      <small>默认 <span class="mono">${e(DEFAULT_NODE)}</span>（${e(NET.label)} kaspad 入口；其后为公共节点）。首次按列表顺序连接第一个可用节点作为主节点；之后优先使用测得延迟更低的节点，连接失败的节点暂停 30 秒。页面另保持一个不同节点的热备连接，主节点断开时切换；每次多步核验固定在主节点上完成，不混用两个节点的数据，热备的通知只用于提醒重新核对。钱包只负责签名，签名后的交易由本页提交给主节点，不跨节点自动重试；若交易被短程重组撤销，只按原签名字节重发。空闲 15 秒后断开连接。资金规则由 Kaspa 共识执行，节点只是访问共识的入口。也可填自建 kaspad（启动参数 --rpclisten-json），例如本机 <span class="mono">ws://127.0.0.1:18210</span> 或局域网 <span class="mono">ws://192.168.1.10:18210</span>。请填完整协议和端口；节点必须提供 JSON wRPC，不能填写 gRPC 或 Borsh 端口。</small></label>
    <label class="field full">Indexer（http / https · 轮次发现）<input id="sIdx" value="${e(state.indexer ?? '')}" spellcheck="false" placeholder="${e(DEFAULT_INDEXER ?? '')}">
      <small>默认 <span class="mono">${e(DEFAULT_INDEXER ?? '未配置')}</span>。只用于列出轮次和提供账本原文；操作前页面会用节点核对。例如本机 <span class="mono">http://127.0.0.1:8788</span>、局域网 <span class="mono">http://192.168.1.10:8788</span>，也可填同源 <span class="mono">/indexer</span>。跨域服务需要允许当前网页来源（CORS）。</small></label>
    <details class="full small"><summary>没有证书，如何使用本地端口？</summary><p>把此 HTML 放到可信设备的本地 HTTP 静态服务中，例如用 <span class="mono">python3 -m http.server 8000 --bind 127.0.0.1</span> 提供专门只放网页的目录，然后打开 <span class="mono">http://127.0.0.1:8000/kaswin-v2.html</span>。节点填 ws://，索引器填 http://，无需证书。命令只提供静态文件，不代理 RPC，也不修复索引器 CORS；不要在钱包或私密文件目录运行。</p><p>更换网页协议、主机或端口会更换浏览器存储来源，旧交易记录不会自动搬过去；不要清站点数据或重发结果未知的交易。实际钱包扩展还需允许该网页来源，连接以浏览器和钱包的实际结果为准。</p></details>
    <div class="full" id="sWarn"></div></div>
    <div class="notice small" style="margin-top:6px">当前连接：${st.connected ? `<b>${e(st.nodes[0].host)}</b> · DAA ${e(String(st.nodes[0].daa))} · ${st.nodes[0].rtt} ms` : '未连接（首次需要链上数据时自动连接）'}</div>
    <p class="err" id="sErr"></p><div id="sProbe"></div>
    <details class="small" style="margin-top:8px"><summary class="muted">本机记住的轮次（${state.cached}）</summary><div id="sCache" style="margin-top:8px">读取中…</div></details>`,
    `<button class="btn" id="sTest">${icon('refresh')}测试连接</button><button class="btn" id="sReset">恢复默认</button><button class="btn pri" id="sSave">保存</button>`);
  const warn = () => { try {
    const nodes = $('sNodes').value.split(/\s+/).filter(Boolean).map(nodeUrl);
    const notices = connectionNotices({nodes, indexer: $('sIdx').value.trim() ? indexerBase($('sIdx').value) : null});
    $('sWarn').innerHTML = notices.map(w => `<div class="notice warn small">${e(w)}</div>`).join(''); $('sErr').textContent = '';
  } catch (err) { $('sWarn').innerHTML = ''; $('sErr').textContent = errorText(err); } };
  $('sIdx').oninput = $('sNodes').oninput = warn; warn();
  $('sReset').onclick = () => { $('sIdx').value = DEFAULT_INDEXER ?? ''; $('sNodes').value = DEFAULT_NODES.join('\n'); warn(); };
  $('sTest').onclick = async () => {
    $('sProbe').innerHTML = '<div class="notice">测试中…</div>';
    const parts = [];
    try {
      const urls = $('sNodes').value.split(/\s+/).filter(Boolean).map(nodeUrl);
      const link = new NodeLink(urls, {net: NET}); await link.connect(); const s2 = link.status(); link.close();
      parts.push(`<div class="notice ok">节点可用：<b>${e(s2.nodes[0].host)}</b>（${e(NET.label)} 已同步，含 UTXO 索引，${s2.nodes[0].rtt} ms）${s2.rejected.length ? `<br><span class="small">之前尝试失败：${s2.rejected.map(r => `${e(host(r.url))}：${e(r.reason)}`).join('；')}</span>` : ''}</div>`);
    } catch (err) { parts.push(`<div class="notice warn">节点：${e(errorText(err))}<br>请检查服务是否已启动、地址/端口/防火墙、JSON wRPC，以及上方浏览器连接提示。明文地址可以保存，但网页无法解除混合内容或本地网络权限限制。</div>`); }
    try { if (!$('sIdx').value.trim()) throw new Error('未配置 Indexer，将使用 REST 发现线索'); const p = await listRounds(indexerBase($('sIdx').value), {net: NET, limit: 200}); parts.push(`<div class="notice ok">Indexer 可用：${p.items.length} 个轮次${p.lastCheckpointAt ? `，检查点 ${timeHtml(p.lastCheckpointAt)}` : ''}。</div>`); }
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
      const idx = $('sIdx').value.trim() ? indexerBase($('sIdx').value) : null, urls = [...new Set($('sNodes').value.split(/\s+/).filter(Boolean).map(nodeUrl))];
      ensure(urls.length >= 1, '至少需要一个节点');
      state.indexer = idx; state.nodes = urls; LS.set('indexer', idx ?? ''); LS.set('nodes', urls); LS.set('configVersion', CONFIG_VERSION);
      recovery?.pause(); state.nodeRecovering = false; invalidateQuote(); markDetailForRecovery();
      stopDetail(); listRequest?.abort(); state.loadingRows = false;
      engine.dispose(); pair.close(); pair = new NodeLink(urls, {net: NET}); pair.onChange(renderNodeChip);
      engine = new Engine({net: NET, pair, profile, indexer: idx, onLive: rememberNodeView, resolveRound: resolveCurrentRound, onAccepted: relayAccepted}); state.nodeViews.clear();
      discovery = new RoundDiscovery({net: NET, base: idx, profile});
      closeModal(); toast('已保存'); renderNodeChip();
      if (state.view === 'round' && state.round?.cid) trackDetail(state.round.cid);
      void loadRows(); resumeRecords(engine);
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
  const b = $('themeBtn');
  b.setAttribute('data-no-i18n', '');
  b.innerHTML = icon(target);
  b.dataset.icon = target; b.title = text(label); b.setAttribute('aria-label', text(label));
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
// Records left open by a closed tab: resume tracking (query first; identical-bytes resend only inside its window).
async function resumeRecords(activeEngine, records = null) {
  try {
    const rs = records ?? await activeEngine.records();
    if (engine !== activeEngine || activeEngine.disposed || document.hidden) return;
    const running = txid => following.get(txid) === activeEngine;
    for (const r of pendingRecoveryRecords(rs, {cid: state.view === 'round' ? state.round?.cid : null, running})) {
      if (running(r.txid)) activeEngine.wakeAcceptance(r.txid);
      else void autoReconcile(r.txid, 0);
    }
  } catch {} // local record failure must not release reservations or grant send authority
}
recovery = new ForegroundRecovery({
  visible: () => !document.hidden,
  blocked: () => activeExecution?.engine === engine,
  onPending() {
    state.nodeRecovering = true; renderNodeChip();
    engine.invalidatePlans(); invalidateQuote(); markDetailForRecovery(); stopDetail();
    if (state.view === 'round') render();
  },
  async run({signal, current}) {
    const activeEngine = engine, link = pair, R = state.view === 'round' ? state.round : null;
    const rs = await activeEngine.records();
    if (!current() || engine !== activeEngine) return;
    const needsDetail = R && !(R.detail?.terminalSettled === true && R.detail?._src === 'node');
    if (!needsDetail && !pendingRecoveryRecords(rs).length && !link.status().connected) {
      state.nodeRecovering = false; renderNodeChip(); return;
    }
    const info = await link.ensureResponsive({signal});
    if (!current() || engine !== activeEngine) return;
    state.nodeRecovering = false; renderNodeChip();
    state.daa = BigInt(info.virtualDaaScore);
    // Pending waits must not sit behind a long full-round replay.
    await resumeRecords(activeEngine, rs);
    if (current() && engine === activeEngine && needsDetail && state.view === 'round' && state.round === R) {
      const tracker = trackDetail(R.cid);
      await tracker?.run();
    }
  },
  onError(error) {
    state.nodeRecovering = false; renderNodeChip();
    const R = state.view === 'round' ? state.round : null;
    if (R?.recovering) {
      R.recoveryFailure = true; R.staleNote = error?.safeCode === 'FOREGROUND_NODE_TIMEOUT' ? '节点恢复超时，请稍后重试' : errorText(error);
      // Retain the existing on-demand retry path even when the initial liveness probe failed.
      if (!detailTracker) trackDetail(R.cid);
      render();
    }
  },
});
void resumeRecords(engine);
void mergedRows().then(rows => { state.rows = rows; if(state.view==='explore') render(); }).then(() => loadRows({quiet: true}));
// List stays a session snapshot. Foreground recovery covers the current detail and bounded pending records only.
let foregroundWasHidden = document.hidden;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    foregroundWasHidden = true; recovery.pause();
    engine.invalidatePlans(); invalidateQuote(); markDetailForRecovery(); stopDetail();
  } else if (foregroundWasHidden) {
    foregroundWasHidden = false; recovery.request();
  }
});
window.addEventListener('online', () => { if (!document.hidden) recovery.request(); });
window.addEventListener('pagehide', () => {
  foregroundWasHidden = true; recovery.pause(); invalidateQuote();
  // Navigation/BFCache destroys the runtime; ordinary visibility changes retain an active signature flow.
  if (browserTestWallet() || $('testWalletKey')) disconnectWallet();
  lockModal(false); if ($('modal').open) closeModal();
  markDetailForRecovery(); stopDetail(); listRequest?.abort(); engine.dispose(); pair.close();
});
window.addEventListener('pageshow', ev => {
  if (!ev.persisted) return;
  buildRuntime(); foregroundWasHidden = false; renderWalletChip(); renderNodeChip();
  recovery.request();
});
document.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches?.('.card')) ev.target.click(); });
