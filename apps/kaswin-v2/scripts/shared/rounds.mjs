/** Round views.
 *  - Indexer (discovery only): /v1/rounds, /v1/rounds/:cid. Bounded GET, lossless integers, schema-checked.
 *  - liveRound(): indexer preimage -> ledger re-encoded -> verifySnapshot (templates, CID, SPK, value) ->
 *    tip UTXO checked live on the configured node -> its accepting tx checked on that node.
 *    The indexer is never trusted for value; the node is trusted as the window onto Kaspa consensus.
 */
import {S, ensure, hash32, cat, le, unhex, CONTRACT_TAG, NETWORK_GENESIS, UserError, stable} from './core.mjs';
import {parseJson, uint} from './lib/json.mjs';
import {commonUtxos, acceptedPair} from './chain.mjs';
import {spkToAddress} from './lib/address.mjs';

const MAX_BODY = 4 * 1024 * 1024;

/** Indexer endpoint. Any http(s) URL is accepted: the indexer is a discovery hint, never a source of value, and every
 * action re-verifies on the configured node. Plain http is fine for localhost/LAN/same-origin setups; the UI shows a warning
 * when it would cross the public Internet (a network attacker could then hide rounds or feed bogus candidates —
 * which the node checks reject — but cannot redirect funds). Browsers still block http fetches from an https page
 * (mixed content); in that case serve the page over http too, or proxy the indexer under the page's origin. */
export function indexerBase(v) {
  const u = new URL(String(v).trim(), globalThis.location?.href ?? 'http://localhost/');
  ensure(u.protocol === 'https:' || u.protocol === 'http:', 'Indexer 地址必须以 http:// 或 https:// 开头');
  ensure(!u.username && !u.password && !u.search && !u.hash, 'Indexer 地址不能包含凭据、查询参数或片段');
  return u.href.replace(/\/$/, '');
}
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local|[a-z0-9-]+)$/i;
/** null if fine; otherwise a short human warning about this endpoint choice. */
export function indexerWarning(base, pageUrl = globalThis.location?.href ?? '') {
  const u = new URL(base), page = pageUrl ? new URL(pageUrl) : null;
  if (page?.protocol === 'https:' && u.protocol === 'http:') return '本页通过 https 打开，浏览器会拦截 http 索引（混合内容）。请改用 https 索引、同源 /indexer 代理，或用 http 打开本页。';
  if (u.protocol === 'http:' && !PRIVATE_HOST.test(u.hostname) && u.origin !== page?.origin) return '这是公网上的明文 http 地址：传输可能被篡改而隐藏轮次。资金安全不受影响（操作前都会向节点核对），但建议用 https 或局域网地址。';
  return null;
}
export async function getJson(url, {signal, timeoutMs = 12000} = {}) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const r = await fetch(url, {method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: sig});
  if (r.status === 404) { await r.body?.cancel(); throw new UserError('该 Indexer 尚未收录此轮次（404 不代表链上不存在）', 'NOT_INDEXED'); }
  if (!r.ok) { await r.body?.cancel(); throw new UserError(`Indexer HTTP ${r.status}`, 'HTTP'); }
  const reader = r.body.getReader(), parts = []; let n = 0;
  try { for (;;) { const {value, done} = await reader.read(); if (done) break; n += value.length; ensure(n <= MAX_BODY, 'Indexer 响应超过 4 MiB'); parts.push(value); } }
  catch (e) { await reader.cancel().catch(() => {}); throw e; }
  const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return parseJson(new TextDecoder('utf-8', {fatal: true}).decode(all));
}
function meta(d) {
  ensure(d && d.network === 'testnet-10', 'Indexer 网络不是 Testnet 10');
  ensure(d.requiresIndependentVerification === true, 'Indexer 响应缺少“需独立核验”声明');
  return {coverage: d.coverage, lastCheckpointAt: typeof d.lastCheckpointAt === 'number' ? d.lastCheckpointAt : null};
}
const int = (n, min, max, what) => ensure(Number.isSafeInteger(n) && n >= min && n <= max, `${what}格式错误`);
/** Any `state` carried by an indexer row or a cached view is untrusted display data. It must be a complete, canonical
 * ledger summary (exact types/ranges via the core validator) before it can reach any template. */
function checkState(st, purchases) {
  ensure(st && typeof st === 'object' && !Array.isArray(st), '账本格式错误');
  const c = st.config;
  ensure(c && typeof c === 'object' && !Array.isArray(c), '账本配置格式错误');
  int(st.phase, 1, 5, '阶段'); hash32(st.ownerKey, '创建者公钥');
  int(c.ticketCap, 3, S.MAX_TICKETS, '票数上限'); int(c.purchaseCap, 1, S.MAX_PURCHASES, '购买记录上限'); int(c.minTickets, 3, c.ticketCap, '最低票数');
  int(st.sold, 0, c.ticketCap, '售出票数'); int(st.purchaseCount, 0, Math.min(c.purchaseCap, st.sold), '购买记录数'); int(st.cursor, 0, S.MAX_PURCHASES, '退款游标');
  int(st.anchorIndex, 0, 0xffffffff, '锚点索引'); int(st.counter, 0, 0xffffffff, '计数'); int(st.winnerPlusOne, 0, S.MAX_TICKETS, '中奖票号');
  for (const f of ['anchorTxId', 'seed', 'targetHash', 'targetSeq']) hash32(st[f], f);
  // Rebuild the exact ledger (directory included when supplied) and let the core library enforce every invariant.
  let prev = 0;
  if (purchases != null) ensure(Array.isArray(purchases) && purchases.length === st.purchaseCount, '购买目录数量与账本不一致');
  const list = purchases ?? null;
  const dir = list ? cat(...list.map(p => { ensure(p && typeof p === 'object' && Number.isSafeInteger(p.end) && p.end > prev && p.count === p.end - prev, '购买目录不连续'); prev = p.end; return cat(le(BigInt(p.end), 4), unhex(hash32(p.key, '买家公钥'), 32)); })) : null;
  const s = {phase: st.phase, ownerKey: st.ownerKey,
    config: {ticketPrice: uint(c.ticketPrice, '票价'), ticketCap: c.ticketCap, purchaseCap: c.purchaseCap, minTickets: c.minTickets, closeEligibleDaa: uint(c.closeEligibleDaa, '封盘 DAA')},
    sold: st.sold, purchaseCount: list ? st.purchaseCount : 0, cursor: list ? st.cursor : 0, anchorDaa: uint(st.anchorDaa, '锚点 DAA'), anchorTxId: st.anchorTxId, anchorIndex: st.anchorIndex,
    seed: st.seed, counter: st.counter, winnerPlusOne: st.winnerPlusOne, targetHash: st.targetHash, targetSeq: st.targetSeq, directory: dir ?? new Uint8Array()};
  if (list) S.validateLedger(s);
  else { S.validateConfig(s.config); ensure((st.sold === 0) === (st.purchaseCount === 0), '售出票数与购买记录不一致'); }
}
/** `cached`: a view read back from this browser's IndexedDB (possibly written by an older page version) — it is just as
 * untrusted as a fresh indexer response, and may additionally carry the page's own placeholder statuses. */
export function checkRow(v, {cached = false} = {}) {
  ensure(v && typeof v === 'object', '轮次格式错误'); hash32(v.cid, 'CID');
  ensure(['LIVE', 'FINAL', 'TERMINAL', 'STALE', 'ROLLED_BACK', ...(cached ? ['UNKNOWN', 'LOCAL'] : [])].includes(v.indexStatus), '未知索引状态');
  if (v.contract != null) ensure(typeof v.contract === 'string' && v.contract.length <= 128, '合约标识格式错误');
  ensure(v.terminal === null || ['PAID', 'EMPTY', 'REFUNDED'].includes(v.terminal), '未知终局');
  ensure(v.phase === null || (Number.isInteger(v.phase) && v.phase >= 1 && v.phase <= 5), '未知阶段');
  if (v.tip) { hash32(v.tip.transactionId); ensure(Number.isInteger(v.tip.index) && v.tip.index >= 0, 'tip'); }
  uint(v.value, 'VALUE');
  for (const field of ['genesisTxid', 'latestTxid', 'accepting']) if (v[field] != null) hash32(v[field], field);
  if (v.purchases != null) {
    ensure(Array.isArray(v.purchases) && v.purchases.length <= S.MAX_PURCHASES, '购买目录格式错误');
    for (const p of v.purchases) { ensure(p && typeof p === 'object', '购买记录格式错误'); if (p.txid != null) hash32(p.txid, '购买交易 ID'); }
  }
  if (v.state != null) checkState(v.state, v.purchases);
  for (const f of ['updatedAt', 'liveSeenAt']) if (v[f] != null) ensure(Number.isSafeInteger(v[f]) && v[f] >= 0, `${f}格式错误`);
  return v;
}
export async function listRounds(base, {status = null, cursor = null, limit = 100, signal} = {}) {
  const q = new URLSearchParams({limit: String(limit)}); if (status) q.set('status', status); if (cursor) q.set('cursor', hash32(cursor));
  const d = await getJson(`${base}/v1/rounds?${q}`, {signal});
  const m = meta(d); ensure(Array.isArray(d.items) && d.items.length <= 200, '分页超限');
  // One malformed row must not hide the honest ones: drop it (and count it) instead of rejecting the page.
  const items = []; let rejected = 0;
  for (const v of d.items) { try { items.push(checkRow(v)); } catch { rejected++; } }
  return {...m, items, rejected, nextCursor: d.nextCursor == null ? null : hash32(d.nextCursor, '分页游标')};
}
export async function roundDetail(base, cid, {signal} = {}) {
  const d = await getJson(`${base}/v1/rounds/${hash32(cid, 'CID')}`, {signal});
  meta(d); const r = checkRow(d.item);
  ensure(r.cid === cid, 'Indexer 返回了不同 CID');
  return r;
}

/** Rebuild the consensus ledger bytes from an indexer detail (the ledger is then re-validated by the core library). */
export function ledgerFromDetail(r, profile) {
  ensure(r.contract === CONTRACT_TAG, `不是固定的 V2 Profile（${r.contract}）`);
  ensure(r.state && Array.isArray(r.purchases) && r.purchases.length <= S.MAX_PURCHASES, '索引详情缺少账本或购买目录');
  // Cached views are just as untrusted as fresh indexer responses.
  for (const p of r.purchases) { ensure(p && typeof p === 'object', '购买记录格式错误'); if (p.txid != null) hash32(p.txid, '购买交易 ID'); }
  const st = r.state, c = st.config;
  let prev = 0;
  const dir = cat(...r.purchases.map(p => { ensure(Number.isInteger(p.end) && p.end > prev && p.count === p.end - prev, '购买目录不连续'); prev = p.end; return cat(le(BigInt(p.end), 4), unhex(hash32(p.key, '买家公钥'), 32)); }));
  const s = {phase: st.phase, ownerKey: st.ownerKey,
    config: {ticketPrice: uint(c.ticketPrice), ticketCap: c.ticketCap, purchaseCap: c.purchaseCap, minTickets: c.minTickets, closeEligibleDaa: uint(c.closeEligibleDaa)},
    sold: st.sold, purchaseCount: st.purchaseCount, cursor: st.cursor, anchorDaa: uint(st.anchorDaa), anchorTxId: st.anchorTxId, anchorIndex: st.anchorIndex,
    seed: st.seed, counter: st.counter, winnerPlusOne: st.winnerPlusOne, targetHash: st.targetHash, targetSeq: st.targetSeq, directory: dir};
  S.validateLedger(s);
  return s;
}

/** Live, verified snapshot of an active round.
 * Source of the ledger preimage: the indexer, or (if newer) this browser's own ACCEPTED record. Either way the
 * preimage is only a candidate: it must re-encode to the P2SH of a UTXO that is live on the node, whose creating
 * transaction the node reports as accepted on the selected chain. */
export async function liveRound(pair, base, profile, cid, currentDaa, local = null) {
  let r = null, idxErr = null;
  try { r = await roundDetail(base, cid); } catch (err) { idxErr = err; }
  let cand = null;
  if (r && !r.terminal && r.tip && !['STALE', 'ROLLED_BACK'].includes(r.indexStatus)) cand = {ledger: ledgerFromDetail(r, profile), tip: r.tip, origin: r.origin, spk: r.scriptPublicKey, value: uint(r.value), utxoDaa: uint(r.utxoDaa), accepting: r.accepting, genesisTxid: r.genesisTxid, source: 'indexer'};
  // Prefer the local accepted successor if the indexer has not caught up with it yet.
  const localIsNewer = local && !local.terminal && local.nextLedger &&
    (!cand || local.inputs.some(o => o.transactionId === cand.tip.transactionId && o.index === cand.tip.index));
  if (localIsNewer) {
    const s = S.decodeLedger(unhex(local.nextLedger)); S.validateLedger(s);
    cand = {ledger: s, tip: {transactionId: local.txid, index: 0}, origin: local.origin, spk: local.spk, value: local.value, utxoDaa: local.utxoDaa, accepting: local.accepting, genesisTxid: local.genesisTxid ?? r?.genesisTxid ?? null, source: 'local'};
  }
  if (!cand) {
    if (r?.terminal) throw new UserError(`轮次已结束（${r.terminal}）`, 'NOT_LIVE');
    if (r) throw new UserError('索引状态不可操作（STALE / 回滚 / 无 tip）', 'NOT_LIVE');
    throw idxErr ?? new UserError('无法取得轮次状态', 'NOT_LIVE');
  }
  hash32(cand.origin?.transactionId, 'origin'); ensure(cand.accepting, '缺少接受块提示');
  const snapshot = {ledger: S.encodeLedger(cand.ledger), tip: cand.tip, origin: cand.origin, scriptPublicKey: cand.spk, covenantId: cid, value: cand.value, utxoDaa: cand.utxoDaa, currentDaa};
  S.verifySnapshot(snapshot, profile); // pinned frame + canonical OPEN CID + P2SH + exact locked value
  const addr = spkToAddress(snapshot.scriptPublicKey);
  const live = await commonUtxos(pair, addr);
  const u = live.find(x => x.outpoint.transactionId === cand.tip.transactionId && x.outpoint.index === cand.tip.index);
  ensure(u, '轮次状态 UTXO 已不是未花费输出（可能刚被他人推进，请稍后刷新再试）', 'STALE_TIP');
  ensure(u.value === snapshot.value && stable(u.spk) === stable(snapshot.scriptPublicKey) && u.daa === snapshot.utxoDaa && u.covenantId === cid, '实时 UTXO 与账本不一致', 'STALE_TIP');
  const acc = await acceptedPair(pair, cand.tip.transactionId, cand.accepting);
  const o = acc.tx.outputs[cand.tip.index];
  ensure(o && o.value === snapshot.value && stable(o.scriptPublicKey) === stable(snapshot.scriptPublicKey) && o.covenant?.covenantId === cid && acc.acceptingDaa === snapshot.utxoDaa, '接受交易输出与状态 UTXO 不一致');
  return {row: r ?? {cid, genesisTxid: cand.genesisTxid}, ledger: cand.ledger, snapshot, accepting: cand.accepting, acceptedTx: acc, source: cand.source};
}

/** Pure view helpers (work on archive rows and indexer rows alike). */
export function phaseInfo(row) {
  if (row.contract && row.contract !== CONTRACT_TAG) return {key: 'other', label: '其他 Profile', tone: 'muted'};
  if (row.indexStatus === 'STALE') return {key: 'stale', label: '待同步', tone: 'amber'};
  if (row.indexStatus === 'ROLLED_BACK') return {key: 'stale', label: '已回滚', tone: 'amber'};
  if (row.terminal === 'PAID') return {key: 'paid', label: '已派奖', tone: 'gold'};
  if (row.terminal === 'REFUNDED') return {key: 'refunded', label: '已全额退款', tone: 'muted'};
  if (row.terminal === 'EMPTY') return {key: 'empty', label: '空轮结束', tone: 'muted'};
  return ({1: {key: 'open', label: '售票中', tone: 'mint'}, 2: {key: 'sealed', label: '已封存 · 待开奖', tone: 'violet'}, 3: {key: 'sealed', label: '抽样中', tone: 'violet'}, 4: {key: 'sealed', label: '待派奖', tone: 'violet'}, 5: {key: 'refund', label: '退款中', tone: 'amber'}})[row.phase] ?? {key: 'other', label: '未知', tone: 'muted'};
}
