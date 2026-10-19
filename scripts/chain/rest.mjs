/** Historical REST lookup: (1) a LOCATION hint for node verification, (2) a labelled external witness.
 * Source: kaspa-ng/kaspa-rest-server@c638eb5cceff30591cd9b35b241752878a2cfad0 endpoints/get_transactions.py;
 * target OpenAPI v2.3.0 observed 2026-10-04. is_accepted comes from the transactions_acceptances table.
 * The DTO lacks sequence/lockTime/gas/SPK version/storageMass: never fabricate them, never treat REST as consensus. */
import {ensure, hash32, errorText} from '../core.mjs';
import {parseJson, uint} from './json.mjs';
import {requireNet} from './network-schema.mjs';
import {decodeAddress} from '../wallet/address.mjs';
const LIMIT = 1024 * 1024;
/** Bounded, lossless public REST transport. Raw API data remains a hint. */
export async function restJson(path, {net, signal, fetcher = globalThis.fetch, timeoutMs = 12000, maxBytes = 8 * LIMIT} = {}) {
  const base = requireNet(net).rest;
  const url = new URL(base);
  ensure(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'REST_ENDPOINT');
  ensure(path.startsWith('/') && !path.startsWith('//'), 'REST_PATH');
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const r = await fetcher(`${base.replace(/\/$/, '')}${path}`, {signal: sig, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error'});
  if (!r.ok) { await r.body?.cancel(); throw new Error(`REST_HTTP_${r.status}`); }
  const reader = r.body?.getReader(); ensure(reader, 'REST_BODY');
  let size = 0, text = ''; const decoder = new TextDecoder('utf-8', {fatal: true});
  try { for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.byteLength; ensure(size <= maxBytes, 'REST_BODY_LIMIT'); text += decoder.decode(value, {stream: true}); } text += decoder.decode(); }
  finally { await reader.cancel().catch(() => {}); }
  return parseJson(text);
}
export async function restAddressTransactions(address, {offset = 0, limit = 50, ...options} = {}) {
  decodeAddress(address, requireNet(options.net).addressPrefix);
  ensure(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'REST_PAGE');
  const items = await restJson(`/addresses/${encodeURIComponent(address)}/full-transactions?limit=${limit}&offset=${offset}`, options);
  ensure(Array.isArray(items) && items.length <= limit, 'REST_PAGE');
  return {items, nextOffset: items.length === limit ? offset + items.length : null};
}
export const restTransaction = (txid, options) => restJson(`/transactions/${hash32(txid)}?inputs=true&outputs=true`, options);
const bytes = (v, name) => { ensure(typeof v === 'string' && /^(?:[0-9a-f]{2})*$/i.test(v), `REST 缺少或损坏 ${name}`); return v.toLowerCase(); };
const eq = (a, b, name) => ensure(a === b, `REST 与本机批准记录不符：${name}`);
const rows = (items, expected, id, name) => {
  ensure(Array.isArray(items) && items.length === expected.length, `REST ${name}数量不符或缺失`);
  const byIndex = new Map();
  for (const item of items) {
    ensure(item && typeof item === 'object', `REST ${name}格式`);
    eq(hash32(item.transaction_id), id, `${name}交易ID`);
    const index = uint(item.index);
    ensure(index < BigInt(expected.length) && !byIndex.has(index.toString()), `REST ${name}索引重复或越界`);
    byIndex.set(index.toString(), item);
  }
  return expected.map((_, i) => byIndex.get(String(i)));
};

/** Acceptance claim only: txid binding, strict boolean, accepting block hash. 404/false are never rejection. */
export function restAcceptance(data, txid) {
  ensure(data && typeof data === 'object' && !Array.isArray(data), 'REST 响应格式不符');
  eq(hash32(data.transaction_id), hash32(txid), '交易ID');
  ensure(typeof data.is_accepted === 'boolean', 'REST 缺少 is_accepted');
  if (!data.is_accepted) return {outcome: 'UNCONFIRMED'};
  return {outcome: 'ACCEPTED', acceptingBlockHash: hash32(data.accepting_block_hash, 'REST 接受块'),
    acceptingBlueScore: data.accepting_block_blue_score == null ? null : uint(data.accepting_block_blue_score).toString()};
}

/** Compare ONLY fields supplied by the API with the locally approved/signed transaction. Throws on any mismatch. */
export function compareRestFields(data, record) {
  const id = hash32(record.txid), t = record.draft?.transaction;
  ensure(t?.inputs?.length && t?.outputs?.length, '本机缺少批准交易，不能比对 REST');
  eq(uint(data.version), uint(t.version), 'version');
  eq(bytes(data.subnetwork_id, 'subnetwork'), t.subnetworkId, 'subnetwork');
  // Pinned REST HexColumn maps an empty/unstored payload to null: null is consistent only with an empty local payload.
  if (data.payload == null) ensure(t.payload === '', 'REST 未提供非空 payload，无法比对');
  else eq(bytes(data.payload, 'payload'), t.payload, 'payload');
  const authorized = new Set(record.draft.authorizedInputIndices);
  rows(data.inputs, t.inputs, id, '输入').forEach((got, i) => {
    const exp = t.inputs[i];
    eq(hash32(got.previous_outpoint_hash), exp.previousOutpoint.transactionId, `输入${i} outpoint`);
    eq(uint(got.previous_outpoint_index), uint(exp.previousOutpoint.index), `输入${i} index`);
    eq(uint(got.compute_budget), uint(exp.computeBudget), `输入${i} computeBudget`);
    const sig = bytes(got.signature_script, 'signature_script');
    if (!authorized.has(i)) eq(sig, exp.signatureScript, `输入${i} covenant 见证`);
    else {
      ensure(/^41[0-9a-f]{128}01$/.test(sig), 'REST 钱包签名格式不符');
      // v1 txid omits signatures; this binds the witness to OUR submitted copy. Not a fresh BIP340 verification.
      if (record.signed?.inputs?.[i]) eq(sig, record.signed.inputs[i].signatureScript, `输入${i} 已签名见证`);
    }
  });
  rows(data.outputs, t.outputs, id, '输出').forEach((got, i) => {
    const exp = t.outputs[i];
    eq(uint(got.amount), exp.value, `输出${i}金额`);
    eq(bytes(got.script_public_key, 'script_public_key'), exp.scriptPublicKey.script, `输出${i}脚本`);
    // Explicit null is part of the pinned DTO; an absent field fails closed, even for ordinary outputs.
    if (exp.covenant) {
      eq(hash32(got.covenant_id), exp.covenant.covenantId, `输出${i} covenant ID`);
      eq(uint(got.covenant_authorizing_input), uint(exp.covenant.authorizingInput), `输出${i}授权输入`);
    } else {
      eq(got.covenant_id, null, `输出${i}普通绑定`);
      eq(got.covenant_authorizing_input, null, `输出${i}普通授权`);
    }
  });
  return {compared: 'version、subnetwork、payload；输入 outpoint/computeBudget/见证；输出数量/金额/脚本/covenant 绑定',
    unavailable: 'sequence、lockTime、gas、SPK version、storageMass；当前选中链证明与接受 DAA'};
}

export async function queryRest(record, {net, fetcher = globalThis.fetch, timeoutMs = 15_000, maxBytes = LIMIT} = {}) {
  const base = requireNet(net).rest;
  ensure(record.networkGenesis === undefined || record.networkGenesis === net.genesis, 'REST_NETWORK_MISMATCH');
  const url = `${base}/transactions/${hash32(record.txid)}?inputs=true&outputs=true`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: controller.signal});
    if (res.status === 404) return {outcome: 'NOT_FOUND', source: base, checkedAt: Date.now(), url};
    ensure(res.status === 200, `REST HTTP ${res.status}（未取得结果，不代表交易失败）`);
    ensure(res.body, 'REST 空响应');
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let length = 0, text = '';
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        ensure(length <= maxBytes, 'REST 响应超过大小上限');
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    const data = parseJson(text), claim = restAcceptance(data, record.txid);
    let fields = null;
    if (claim.outcome === 'ACCEPTED') {
      try { fields = {ok: true, ...compareRestFields(data, record)}; } catch (err) { fields = {ok: false, error: errorText(err)}; }
    }
    return {...claim, fields, source: base, checkedAt: Date.now(), url};
  } finally { clearTimeout(timer); }
}

/** REST-only display level. Requires: a stored REST witness (accepted + all API-supplied fields matched the local
 * approved transaction), a LATEST lookup bound to the latest node check that re-tested that witness's block on the
 * node, and a node result that can neither verify nor contradict it (pruned / unreachable). A node contradiction,
 * REST reporting not-accepted, or a field mismatch deletes the witness. A later REST 404/error (e.g. REST's own
 * retention) is no new information and keeps the witness, shown with its original observation time.
 * The shared Opus journal keeps node semantics (status UNKNOWN, inputs reserved). */
export function hasRestAcceptance(r, net) {
  requireNet(net);
  const w = r?.restWitness, c = r?.restCheck;
  return r?.status === 'UNKNOWN' && (r.networkGenesis === undefined || r.networkGenesis === net.genesis) && typeof r.checkedAt === 'number'
    && w?.source === net.rest && w.txid === r.txid && w.fields?.ok === true && /^[0-9a-f]{64}$/.test(w.acceptingBlockHash ?? '')
    && c?.txid === r.txid && c.nodeCheckedAt === r.checkedAt && c.hint?.acceptingBlockHash === w.acceptingBlockHash
    && ['PRUNED', 'UNAVAILABLE'].includes(c.node?.result);
}
export const recordStatus = (r, net) => hasRestAcceptance(r, net) ? 'REST_ACCEPTED' : r.status;
