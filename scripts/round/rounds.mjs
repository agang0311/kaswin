/** Round views.
 *  - Indexer (discovery only): /v1/rounds, /v1/rounds/:cid. Bounded GET, lossless integers, schema-checked.
 *  - liveRound(): indexer preimage -> ledger re-encoded -> verifySnapshot (templates, CID, SPK, value) ->
 *    tip UTXO checked live on the configured node -> its accepting tx checked on that node.
 *    The indexer is never trusted for value; the node is trusted as the window onto Kaspa consensus.
 */
import {S, ensure, hash32, cat, le, hex, unhex, p2sh, blake2b256, CONTRACT_TAG, UserError, stable} from '../core.mjs';
import {requireNet, linkNet} from '../chain/network-schema.mjs';
import {parseJson, uint} from '../chain/json.mjs';
import {commonUtxos, acceptedPair} from '../chain/chain.mjs';
import {decodeSpend, interpretAccepted} from '../core/lib/accepted.js';
import {parseSpk} from '../chain/nodes.mjs';
import {spkToAddress} from '../wallet/address.mjs';
import {compareProgress} from './progress.mjs';

import {CONTRACT_VERSION, requireRuntimeProfile} from '../contract/runtime.mjs';

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
/** Multi-network indexers select the view with `?network=<key>`. TN10 stays unqualified: legacy single-network TN10
 * deployments reject unknown query keys, and a multi-network indexer serves TN10 as its primary view. The response
 * network/genesis is still checked below, so a wrong view fails closed either way. */
const viewParams = (net, q = new URLSearchParams()) => { if (net.key !== 'tn10') q.set('network', net.key); return q; };
const withView = (url, net) => { const q = viewParams(net).toString(); return q ? `${url}?${q}` : url; };
function meta(d, net) {
  requireNet(net);
  ensure(d && d.network === net.networkId, `Indexer 网络不是 ${net.label}`);
  ensure(d.networkGenesis == null || d.networkGenesis === net.genesis, `Indexer genesis 不是 ${net.label}`);
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
  S.checkPhase(st.phase); hash32(st.ownerKey, '创建者公钥');
  int(c.ticketCap, 3, S.MAX_TICKETS, '票数上限'); int(c.purchaseCap, 1, S.MAX_PURCHASES, '购买记录上限'); int(c.minTickets, 3, c.ticketCap, '最低票数');
  int(st.sold, 0, c.ticketCap, '售出票数'); int(st.purchaseCount, 0, Math.min(c.purchaseCap, st.sold), '购买记录数'); int(st.cursor, 0, S.MAX_PURCHASES, '退款游标');
  // KW21 has no persisted random/anchor fields; never decode a KW20 view as this ledger.
  for (const f of ['anchorDaa', 'anchorIndex', 'anchorTxId', 'seed', 'counter', 'winnerPlusOne', 'targetHash', 'targetSeq']) ensure(!Object.hasOwn(st, f), '非 KW21 账本字段');
  // Rebuild the exact ledger (directory included when supplied) and let the core library enforce every invariant.
  let prev = 0;
  if (purchases != null) ensure(Array.isArray(purchases) && purchases.length === st.purchaseCount, '购买目录数量与账本不一致');
  const list = purchases ?? null;
  const dir = list ? cat(...list.map(p => { ensure(p && typeof p === 'object' && Number.isSafeInteger(p.end) && p.end > prev && p.count === p.end - prev, '购买目录不连续'); prev = p.end; return cat(le(BigInt(p.end), 4), unhex(hash32(p.key, '买家公钥'), 32)); })) : null;
  const s = {phase: st.phase, ownerKey: st.ownerKey,
    config: {ticketPrice: uint(c.ticketPrice, '票价'), ticketCap: c.ticketCap, purchaseCap: c.purchaseCap, minTickets: c.minTickets, closeEligibleDaa: uint(c.closeEligibleDaa, '封盘 DAA')},
    sold: st.sold, purchaseCount: list ? st.purchaseCount : 0, cursor: list ? st.cursor : 0, directory: dir ?? new Uint8Array()};
  if (list) S.validateLedger(s);
  else { S.validateConfig(s.config); ensure((st.sold === 0) === (st.purchaseCount === 0), '售出票数与购买记录不一致'); }
}
/** `cached`: a view read back from this browser's IndexedDB (possibly written by an older page version) — it is just as
 * untrusted as a fresh indexer response, and may additionally carry the page's own placeholder statuses. */
export function checkRow(v, {cached = false} = {}) {
  ensure(v && typeof v === 'object', '轮次格式错误'); hash32(v.cid, 'CID');
  ensure(['LIVE', 'FINAL', 'TERMINAL', 'STALE', 'ROLLED_BACK', ...(cached ? ['UNKNOWN', 'LOCAL', 'NODE'] : [])].includes(v.indexStatus), '未知索引状态');
  if (v.contract != null) ensure(typeof v.contract === 'string' && v.contract.length <= 128, '合约标识格式错误');
  ensure(v.terminal === null || ['PAID', 'EMPTY', 'REFUNDED'].includes(v.terminal), '未知终局');
  ensure(v.phase === null || (Number.isInteger(v.phase) && v.phase >= 1 && v.phase <= 5), '未知阶段');
  if (v.tip) { hash32(v.tip.transactionId); ensure(Number.isInteger(v.tip.index) && v.tip.index >= 0, 'tip'); }
  uint(v.value, 'VALUE');
  // Summary display fields of rows without a ledger feed BigInt/number formatting in cards. Reject malformed ones here,
  // so they reach neither a template nor the persistent cache (cached views are re-checked on load as well).
  if (v.ticketPrice != null) uint(v.ticketPrice, 'ticketPrice');
  for (const f of ['sold', 'ticketCap', 'purchaseCount', 'minTickets', 'purchaseCap']) if (v[f] != null) ensure(Number.isSafeInteger(v[f]) && v[f] >= 0, `${f}格式错误`);
  for (const field of ['genesisTxid', 'latestTxid', 'accepting']) if (v[field] != null) hash32(v[field], field);
  if (v.purchases != null) {
    ensure(Array.isArray(v.purchases) && v.purchases.length <= S.MAX_PURCHASES, '购买目录格式错误');
    for (const p of v.purchases) { ensure(p && typeof p === 'object', '购买记录格式错误'); if (p.txid != null) hash32(p.txid, '购买交易 ID'); }
  }
  if (v.contract === CONTRACT_TAG) {
    ensure(v.phase === null || [1, 2, 5].includes(v.phase), `未知 ${CONTRACT_VERSION} 阶段`);
    if (v.state != null) checkState(v.state, v.purchases);
  } else {
    // Other Profiles are summaries only: no foreign ledger reaches a template or our cache.
    v = {...v}; delete v.state; delete v.purchases;
  }
  for (const f of ['updatedAt', 'liveSeenAt']) if (v[f] != null) ensure(Number.isSafeInteger(v[f]) && v[f] >= 0, `${f}格式错误`);
  // Optional reorg-depth flag (indexer 2026-10-10+); older indexers omit it. Display/gating hint only, never trusted for value.
  if (v.acceptance != null) ensure(['CONFIRMING', 'ACCEPTED', 'FINAL', 'UNKNOWN'].includes(v.acceptance), '未知接受状态');
  for (const f of ['acceptingDaa', 'depthDaa']) if (v[f] != null) uint(v[f], f);
  if (v.tipSpentSeenAt != null) ensure(Number.isSafeInteger(v.tipSpentSeenAt) && v.tipSpentSeenAt >= 0, 'tipSpentSeenAt格式错误');
  return v;
}
/** The indexer itself reports that its current tip was already seen spent (successor not resolved yet): out of date. */
export const indexerBehind = d => !!d && d._src === 'live' && !d.terminal && Number.isSafeInteger(d.tipSpentSeenAt);
/** Is the round's current state still inside the short-reorg window? Uses the node's own virtual DAA when known (the
 * indexer's depth is from its last checkpoint and may be seconds old). `null` when the indexer gave no depth data. */
export function stateConfirming(d, virtualDaa = null, recheck = 100n) {
  if (!d || d.terminal || d._src !== 'live' || d.acceptance == null) return null;
  if (d.acceptance === 'FINAL' || d.acceptance === 'UNKNOWN') return d.acceptance === 'FINAL' ? false : null;
  if (virtualDaa != null && d.acceptingDaa != null) return BigInt(virtualDaa) - BigInt(d.acceptingDaa) < recheck;
  return d.acceptance === 'CONFIRMING';
}
export async function listRounds(base, {net, status = null, cursor = null, limit = 100, signal, timeoutMs} = {}) {
  requireNet(net);
  const q = new URLSearchParams({limit: String(limit)}); if (status) q.set('status', status); if (cursor) q.set('cursor', hash32(cursor));
  const d = await getJson(`${base}/v1/rounds?${viewParams(net, q)}`, {signal, timeoutMs});
  const m = meta(d, net); ensure(Array.isArray(d.items) && d.items.length <= 200, '分页超限');
  // One malformed row must not hide the honest ones: drop it (and count it) instead of rejecting the page.
  const items = []; let rejected = 0;
  for (const v of d.items) { try { items.push(checkRow(v)); } catch { rejected++; } }
  return {...m, items, rejected, nextCursor: d.nextCursor == null ? null : hash32(d.nextCursor, '分页游标')};
}
export async function roundDetail(base, cid, {net, signal, timeoutMs} = {}) {
  requireNet(net);
  const d = await getJson(withView(`${base}/v1/rounds/${hash32(cid, 'CID')}`, net), {signal, timeoutMs});
  meta(d, net); const r = checkRow(d.item);
  ensure(r.cid === cid, 'Indexer 返回了不同 CID');
  return r;
}

/** Rebuild the consensus ledger bytes from an indexer detail (the ledger is then re-validated by the core library). */
export function ledgerFromDetail(r, profile) {
  requireRuntimeProfile(profile);
  ensure(r.contract === CONTRACT_TAG, `不是固定的 ${CONTRACT_VERSION} Profile（${r.contract}）`);
  checkState(r.state, r.purchases);
  ensure(r.state && Array.isArray(r.purchases) && r.purchases.length <= S.MAX_PURCHASES, '索引详情缺少账本或购买目录');
  // Cached views are just as untrusted as fresh indexer responses.
  for (const p of r.purchases) { ensure(p && typeof p === 'object', '购买记录格式错误'); if (p.txid != null) hash32(p.txid, '购买交易 ID'); }
  const st = r.state, c = st.config;
  let prev = 0;
  const dir = cat(...r.purchases.map(p => { ensure(Number.isInteger(p.end) && p.end > prev && p.count === p.end - prev, '购买目录不连续'); prev = p.end; return cat(le(BigInt(p.end), 4), unhex(hash32(p.key, '买家公钥'), 32)); }));
  const s = {phase: st.phase, ownerKey: st.ownerKey,
    config: {ticketPrice: uint(c.ticketPrice), ticketCap: c.ticketCap, purchaseCap: c.purchaseCap, minTickets: c.minTickets, closeEligibleDaa: uint(c.closeEligibleDaa)},
    sold: st.sold, purchaseCount: st.purchaseCount, cursor: st.cursor, directory: dir};
  S.validateLedger(s);
  return s;
}

/** Live, verified snapshot of an active round.
 * Source of the ledger preimage: the indexer, or (if newer) this browser's own ACCEPTED record. Either way the
 * preimage is only a candidate: it must re-encode to the P2SH of a UTXO that is live on the node, whose creating
 * transaction the node reports as accepted on the selected chain. */
export async function liveRound(pair, base, profile, cid, currentDaa, local = null, {candidate, signal} = {}) {
  requireRuntimeProfile(profile);
  const net = linkNet(pair);
  let r = null, idxErr = null;
  try { r = candidate ?? await roundDetail(base, cid, {net, signal}); } catch (err) { idxErr = err; }
  const cands = [];
  if (r && !r.terminal && r.tip && !['STALE', 'ROLLED_BACK'].includes(r.indexStatus)) cands.push({ledger: ledgerFromDetail(r, profile), tip: r.tip, origin: r.origin, spk: r.scriptPublicKey, value: uint(r.value), utxoDaa: uint(r.utxoDaa), accepting: r.accepting, genesisTxid: r.genesisTxid, source: 'indexer'});
  if (local && !local.terminal && local.nextLedger) {
    const s = S.decodeLedger(unhex(local.nextLedger)); S.validateLedger(s);
    const c = {ledger: s, tip: {transactionId: local.txid, index: 0}, origin: local.origin, spk: local.spk, value: local.value, utxoDaa: local.utxoDaa, accepting: local.accepting, genesisTxid: local.genesisTxid ?? r?.genesisTxid ?? null, source: 'local'};
    // This browser's accepted successor goes first when it is further along (the indexer has not caught up). Ordered by
    // the state machine's monotone progress, never by timestamps from different machines. Either way it is only a candidate.
    if (!cands.length || compareProgress(s, cands[0].ledger) > 0) cands.unshift(c); else cands.push(c);
  }
  if (!cands.length) {
    if (r?.terminal || local?.terminal) {
      const terminal = await verifyRoundTerminal(pair, profile, cid, r?.terminal ? r : local);
      throw Object.assign(new UserError(`轮次已结束（${terminal.terminal}，节点已核验）`, 'NOT_LIVE'), {terminal});
    }
    if (r) throw new UserError('索引状态不可操作（STALE / 回滚 / 无 tip）', 'NOT_LIVE');
    throw idxErr ?? new UserError('无法取得轮次状态', 'NOT_LIVE');
  }
  // Only "this outpoint is not in the node's UTXO set" (spent by a newer transition, or a local record reorged out)
  // lets the next candidate be tried; the node decides. Any mismatch on a live outpoint is an error, not a fallback.
  for (let i = 0; ; i++) {
    try { return {...await verifyCandidate(pair, profile, cid, currentDaa, cands[i]), row: r ?? {cid, genesisTxid: cands[i].genesisTxid}}; }
    catch (err) {
      // Zero-depth: this browser's own CONFIRMING successor may have just been displaced or re-accepted elsewhere by a
      // short reorg. It is only a hint, so a mismatch skips it (the tracker repairs the record); an indexer candidate's
      // mismatch is still an error. The node decides either way; nothing is inferred from the skipped candidate.
      const localMoved = cands[i].source === 'local' && ['TIP_MISMATCH', 'NOT_CHAIN', 'NOT_ACCEPTED', 'REORG'].includes(err?.code);
      if (err?.code !== 'STALE_TIP' && !localMoved) throw err;
      if (i === cands.length - 1) {
        if (localMoved) throw new UserError('本机最近一笔交易刚受短程重组影响，正在重新核对；请稍候几秒再报价', 'LOCAL_REORG');
        if (local?.terminal) {
          const terminal = await verifyRoundTerminal(pair, profile, cid, local);
          throw Object.assign(new UserError(`轮次已结束（${terminal.terminal}，节点已核验）`, 'NOT_LIVE'), {terminal});
        }
        throw err;
      }
    }
  }
}
/** A terminal discovery row is a hint, never proof. Decode the actual spend and verify canonical identity,
 * input context, zero continuation and every constrained payment; no browser history is needed. */
export async function verifyRoundTerminal(pair, profile, cid, hint) {
  requireRuntimeProfile(profile); hash32(cid);
  const txid = hash32(hint.latestTxid ?? hint.txid), accepting = hash32(hint.accepting);
  const ev = await acceptedPair(pair, txid, accepting), u = ev.inputs?.[0];
  ensure(u && u.covenantId === cid && ev.inputs.every(Boolean), '终局输入材料不足或 CID 不符', 'TERMINAL_INPUT_CONTEXT');
  const w = decodeSpend(ev.tx.inputs[0].signatureScript, profile, hint.origin);
  const snapshot = {ledger: w.ledger, tip: ev.tx.inputs[0].previousOutpoint, origin: w.origin,
    scriptPublicKey: typeof u.spk === 'string' ? parseSpk(u.spk) : u.spk, covenantId: cid, value: u.value,
    utxoDaa: u.daa, currentDaa: ev.acceptingDaa};
  const result = interpretAccepted(snapshot, profile, ev.tx, ev.inputs.map(i => i.value));
  ensure(result.terminal && result.terminal === hint.terminal && !result.next, '外部终局提示与实际接受交易不符', 'TERMINAL_MISMATCH');
  return {terminal: result.terminal, txid, accepting, acceptedTx: ev, outputs: result.outputs, snapshot};
}
export async function verifyCandidate(pair, profile, cid, currentDaa, cand) {
  hash32(cand.origin?.transactionId, 'origin'); ensure(cand.accepting, '缺少接受块提示');
  const snapshot = {ledger: S.encodeLedger(cand.ledger), tip: cand.tip, origin: cand.origin, scriptPublicKey: cand.spk, covenantId: cid, value: cand.value, utxoDaa: cand.utxoDaa, currentDaa};
  S.verifySnapshot(snapshot, profile); // pinned frame + canonical OPEN CID + P2SH + exact locked value
  const addr = spkToAddress(snapshot.scriptPublicKey, linkNet(pair).addressPrefix);
  const live = await commonUtxos(pair, addr);
  const u = live.find(x => x.outpoint.transactionId === cand.tip.transactionId && x.outpoint.index === cand.tip.index);
  ensure(u, '轮次状态 UTXO 已不是未花费输出（可能刚被他人推进，请稍后刷新再试）', 'STALE_TIP');
  ensure(u.value === snapshot.value && stable(u.spk) === stable(snapshot.scriptPublicKey) && u.daa === snapshot.utxoDaa && u.covenantId === cid, '实时 UTXO 与账本不一致', 'TIP_MISMATCH');
  let acc;
  try { acc = await acceptedPair(pair, cand.tip.transactionId, cand.accepting); }
  catch (err) {
    // The node may have pruned the accepting block. Only a state below its pruning point may go on without the body.
    let pruned = null;
    try { pruned = await liveBelowPruningPoint(pair, profile, cid, cand, currentDaa); } catch {}
    if (!pruned || stable(pruned.snapshot.tip) !== stable(cand.tip)) throw err;
    return {...pruned, source: cand.source, genesisTxid: cand.genesisTxid};
  }
  const o = acc.tx.outputs[cand.tip.index];
  ensure(o && o.value === snapshot.value && stable(o.scriptPublicKey) === stable(snapshot.scriptPublicKey) && o.covenant?.covenantId === cid && acc.acceptingDaa === snapshot.utxoDaa, '接受交易输出与状态 UTXO 不一致');
  return {ledger: cand.ledger, snapshot, accepting: cand.accepting, acceptedTx: acc, source: cand.source, genesisTxid: cand.genesisTxid};
}
export const PRUNED_BASIS = 'UTXO_BELOW_PRUNING_POINT';
/** Live state whose accepting block the node has pruned, so no accepted transaction body can be read.
 * The UTXO alone still authenticates it: the address is derived from the candidate ledger itself (P2SH of the ledger
 * script), exactly one live UTXO there must carry this CID, and verifySnapshot binds origin (CID = rootId(origin, OPEN
 * root)), ledger (P2SH) and value. Being in the node's UTXO set means its creating transaction was accepted; a UTXO DAA
 * below the pruning point's DAA means that acceptance precedes the pruning point and can no longer be reorganized.
 * Only the "body output equals UTXO" consistency check and the accepting block location are lost: such a live state
 * has accepting/acceptedTx null and cannot feed PASS-A (DRAW_AND_PAY), which needs the accepted SEALED body. */
export async function liveBelowPruningPoint(link, profile, cid, cand, currentDaa = null) {
  requireRuntimeProfile(profile); hash32(cid); hash32(cand?.origin?.transactionId, 'origin');
  const read = async rpc => {
    S.validateLedger(cand.ledger);
    const spk = p2sh(hex(blake2b256(S.scriptOf(cand.ledger, profile))));
    const rows = (await commonUtxos(rpc, spkToAddress(spk, linkNet(rpc).addressPrefix))).filter(u => u.covenantId === cid);
    ensure(rows.length <= 1, '同一轮次存在多个状态 UTXO', 'TIP_MISMATCH');
    ensure(rows.length === 1, '账本对应的状态 UTXO 已不是未花费输出（可能已被推进）', 'STALE_TIP');
    const u = rows[0];
    ensure(!u.isCoinbase && stable(u.spk) === stable(spk), '实时 UTXO 与账本不一致', 'TIP_MISMATCH');
    const pp = hash32((await rpc.call('getBlockDagInfo')).pruningPointHash);
    const header = (await rpc.call('getBlock', {hash: pp, includeTransactions: false})).block?.header;
    ensure(header?.hash === pp, '裁剪点区块哈希不符');
    const ppDaa = uint(header.daaScore);
    ensure(u.daa < ppDaa, '状态 UTXO 不早于节点裁剪点，仍须核验完整接受交易', 'NOT_PRUNED');
    const now = currentDaa ?? await rpc.currentDaa();
    ensure(now >= u.daa, '节点 DAA 落后于状态 UTXO', 'SINK_BEHIND');
    const snapshot = {ledger: S.encodeLedger(cand.ledger), tip: u.outpoint, origin: cand.origin, scriptPublicKey: spk,
      covenantId: cid, value: u.value, utxoDaa: u.daa, currentDaa: now};
    const ledger = S.verifySnapshot(snapshot, profile); // pinned frame + canonical OPEN CID + P2SH + exact locked value
    return {ledger, snapshot, accepting: null, acceptedTx: null, basis: PRUNED_BASIS, pruningPoint: {hash: pp, daa: ppDaa},
      source: cand.source ?? null, genesisTxid: cand.genesisTxid ?? null};
  };
  return typeof link.pinned === 'function' ? link.pinned(read) : read(link);
}
/** Display view of a node-verified live snapshot (same shape as an indexer detail). The ledger preimage re-encodes to
 * the P2SH of the live UTXO, so phase, sales and purchase directory shown here are exactly what the chain locks. */
export function viewFromLive(live, cid, now = Date.now()) {
  const s = live.ledger, x = live.snapshot;
  return {cid, genesisTxid: live.genesisTxid ?? live.row?.genesisTxid ?? null, contract: CONTRACT_TAG, status: s.phase === 1 ? 'open' : s.phase === 5 ? 'close' : 'sealed',
    phase: s.phase, terminal: null, indexStatus: 'NODE', tip: x.tip, value: String(x.value), latestTxid: x.tip.transactionId, accepting: live.accepting,
    utxoDaa: String(x.utxoDaa), updatedAt: now, verifiedAt: now, origin: x.origin, scriptPublicKey: x.scriptPublicKey, _src: 'node',
    state: {...s, config: {...s.config, ticketPrice: s.config.ticketPrice.toString(), closeEligibleDaa: s.config.closeEligibleDaa.toString()}, directory: undefined},
    purchases: S.records(s)};
}

/** Pure view helpers (work on archive rows and indexer rows alike). */
export function phaseInfo(row) {
  if (row.contract !== CONTRACT_TAG) return {key: 'other', label: '其他 Profile', tone: 'muted'};
  if (row.indexStatus === 'STALE') return {key: 'stale', label: '待同步', tone: 'amber'};
  if (row.indexStatus === 'ROLLED_BACK') return {key: 'stale', label: '已回滚', tone: 'amber'};
  if (row.terminal === 'PAID') return {key: 'paid', label: '已派奖', tone: 'gold'};
  if (row.terminal === 'REFUNDED') return {key: 'refunded', label: '已全额退款', tone: 'muted'};
  if (row.terminal === 'EMPTY') return {key: 'empty', label: '空轮结束', tone: 'muted'};
  return ({1: {key: 'open', label: '售票中', tone: 'mint'}, 2: {key: 'sealed', label: '已封存 · 待开奖', tone: 'violet'}, 5: {key: 'refund', label: '退款中', tone: 'amber'}})[row.phase] ?? {key: 'other', label: '未知', tone: 'muted'};
}
