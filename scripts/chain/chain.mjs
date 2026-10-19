/** Chain facts from the configured Kaspa node: live UTXO checks, selected-chain acceptance, bounded acceptance search.
 * "Accepted" here = the tx appears in the accepted set of a block the node currently reports as a selected-chain block.
 * Inclusion in a block is NOT acceptance; acceptance is not irreversible finality. The node is trusted as the window
 * onto Kaspa consensus (project decision 2026-10-02).
 */
import {ensure, hash32, referenceTxId, stable, errorText} from '../core.mjs';
import {uint} from './json.mjs';
import {txFromRpc, utxoFromRpc, parseSpk, RpcError} from './nodes.mjs';
import {spkToAddress} from '../wallet/address.mjs';
import {linkNet} from './network-schema.mjs';
const addressOfLink = link => spk => spkToAddress(spk, linkNet(link).addressPrefix);

/** Live UTXOs of an address on the connected node. */
export async function commonUtxos(link, address) {
  const r = await link.call('getUtxosByAddresses', {addresses: [address]});
  ensure(Array.isArray(r?.entries) && r.entries.length <= 5000, '地址 UTXO 过多（>5000），超出本页有界读取范围');
  return r.entries.map(utxoFromRpc);
}

/** Every input must still be live and identical (value/script/DAA/covenant) on the node. */
export async function verifyInputsLive(pair, utxos, {allowDaaDrift = false, addressOf = addressOfLink(pair), readUtxos = commonUtxos} = {}) {
  const states = await inputsState(pair, utxos, {addressOf, readUtxos});
  return states.map(({utxo: u}, i) => {
    const f = utxos[i];
    inputNeed(u, `输入 ${f.outpoint.transactionId.slice(0, 10)}…:${f.outpoint.index} 已不是未花费 UTXO（可能已被其他交易花费）`);
    inputNeed(sameInput(u, f, {allowDaaDrift}), '输入金额/脚本/DAA/CID 与计划不一致');
    return u;
  });
}
function inputNeed(ok, message) {
  if (!ok) throw Object.assign(new Error(message), {code: 'STALE_INPUT', safeCode: 'STALE_INPUT'});
}
export const sameInput = (u, f, {allowDaaDrift = false} = {}) => !!u && u.value === f.value &&
  stable(u.spk) === stable(f.spk) && (allowDaaDrift || u.daa === f.daa) &&
  (u.covenantId ?? null) === (f.covenantId ?? null) && !u.isCoinbase;

/** Accepted transaction data at a known accepting chain block, on one node. */
export async function acceptedAt(rpc, txid, accepting) {
  hash32(txid); hash32(accepting);
  const b = (await rpc.call('getBlock', {hash: accepting, includeTransactions: false})).block;
  ensure(b?.header?.hash === accepting && b.verboseData?.isChainBlock === true, '接受块当前不在选中链上', 'NOT_CHAIN');
  const parent = hash32(b.verboseData.selectedParentHash);
  const sink = uint((await rpc.call('getSinkBlueScore')).blueScore), score = uint(b.header.blueScore);
  ensure(sink >= score, 'SINK_BEHIND');
  // minConfirmationCount trims the head so only `parent -> accepting` is returned (bounded payload).
  const v = await rpc.call('getVirtualChainFromBlockV2', {startHash: parent, dataVerbosityLevel: 'Full', minConfirmationCount: Number(sink - score > 0n ? sink - score - 1n : 0n)});
  ensure(Array.isArray(v?.removedChainBlockHashes) && v.removedChainBlockHashes.length === 0, '选中链在查询期间回滚', 'REORG');
  return acceptanceFromPage(v, txid, accepting, sink);
}

/** Shared Full-page validation. A caller must bind the page to its node/connection context. */
export function acceptanceFromPage(v, txid, accepting, sink = null) {
  hash32(txid); hash32(accepting);
  ensure(Array.isArray(v?.removedChainBlockHashes) && v.removedChainBlockHashes.length === 0, '查询期间链发生重组', 'REORG');
  ensure(Array.isArray(v.addedChainBlockHashes) && Array.isArray(v.chainBlockAcceptedTransactions), 'ACCEPTANCE_PAGE');
  const idx = v.addedChainBlockHashes.indexOf(accepting);
  ensure(idx >= 0 && v.chainBlockAcceptedTransactions.length === v.addedChainBlockHashes.length, '接受块不在返回的选中链区段中', 'NOT_CHAIN');
  const row = v.chainBlockAcceptedTransactions[idx];
  ensure(row?.chainBlockHeader?.hash === accepting, 'ACCEPTANCE_ROW');
  const hits = row.acceptedTransactions.filter(t => t.verboseData?.transactionId === txid);
  ensure(hits.length === 1, '该块的接受集合中没有此交易', 'NOT_ACCEPTED');
  const raw = hits[0], tx = txFromRpc(raw);
  ensure(referenceTxId(tx) === txid, '节点返回的交易字段与 txid 不符');
  const score = uint(row.chainBlockHeader.blueScore);
  return {txid, accepting, acceptingDaa: uint(row.chainBlockHeader.daaScore), acceptingBlueScore: score, confirmations: sink === null ? null : sink - score, tx,
    computeMass: raw.verboseData?.computeMass == null ? null : uint(raw.verboseData.computeMass),
    inputs: raw.inputs.map(i => i.verboseData?.utxoEntry ? {value: uint(i.verboseData.utxoEntry.amount), daa: uint(i.verboseData.utxoEntry.blockDaaScore), covenantId: i.verboseData.utxoEntry.covenantId ?? null, spk: i.verboseData.utxoEntry.scriptPublicKey} : null)};
}

/** Reorg recheck depth (project policy, NOT consensus finality). Read-only VSPC monitor (tools/vspc-reorg-monitor.mjs,
 * references/reorg-results): deepest selected-chain removal 83 DAA on mainnet over 24 h (2026-09-26/27; run marked
 * incomplete: 6 data gaps, 12,135 dropped events) and 75 DAA on TN10 over 5.3 h. A first acceptance is only a
 * candidate; the record becomes ACCEPTED when acceptance is verified again with the accepting block at least this deep
 * below the node's virtual DAA (about 10 s at 10 DAA/s). Deeper reorgs were not observed, not ruled out. */
export const REORG_RECHECK_DAA = 100n;
/** DAA depth of an accepting block below the virtual DAA read BEFORE the acceptance check (conservative). */
export const acceptanceDepth = (virtualDaa, acceptingDaa) => virtualDaa > acceptingDaa ? virtualDaa - acceptingDaa : 0n;

/** Accepted transaction at `accepting`, read from the connected node. */
export async function acceptedPair(link, txid, accepting) {
  return typeof link.pinned === 'function' ? link.pinned(view => acceptedAt(view, txid, accepting)) : acceptedAt(link, txid, accepting);
}

/** Bounded forward search for a txid on one node's selected chain starting at `cursor` (a chain block hash).
 * Uses v1 getVirtualChainFromBlock with accepted IDs (small payload). Returns {accepting|null, cursor}. */
export async function searchAccepted(rpc, txid, cursor, {pages = 40, sinkLagLimit = 400_000n} = {}) {
  // Each page returns <= 10 x mergeset_size_limit = 2,480 chain blocks on TN10 (rpc/service get_virtual_chain_from_block),
  // so 40 pages cover ~99k chain blocks (~2.7 h). Later calls resume from the saved cursor.
  hash32(txid); hash32(cursor);
  const start = (await rpc.call('getBlock', {hash: cursor, includeTransactions: false})).block;
  ensure(start?.verboseData?.isChainBlock === true, '对账游标已不在选中链上（可能发生重组），需从更早位置重新查询', 'CURSOR_REORG');
  const sink = uint((await rpc.call('getSinkBlueScore')).blueScore);
  ensure(sink - uint(start.header.blueScore) <= sinkLagLimit, '距离提交时间过久，超出有界查询范围；请使用浏览器或其他索引手动核对', 'SEARCH_RANGE');
  let at = cursor;
  for (let page = 0; page < pages; page++) {
    const r = await rpc.call('getVirtualChainFromBlock', {startHash: at, includeAcceptedTransactionIds: true});
    ensure(Array.isArray(r?.removedChainBlockHashes) && r.removedChainBlockHashes.length === 0, '查询期间游标被回滚', 'CURSOR_REORG');
    ensure(Array.isArray(r.acceptedTransactionIds) && r.addedChainBlockHashes.length <= 20000, 'SEARCH_PAGE');
    for (const row of r.acceptedTransactionIds) if (row.acceptedTransactionIds?.includes(txid)) return {accepting: hash32(row.acceptingBlockHash), cursor: at, complete: true};
    if (!r.addedChainBlockHashes.length) return {accepting: null, cursor: at, complete: true};
    at = r.addedChainBlockHashes.at(-1);
  }
  // Page budget exhausted before the tip: NOT a proof of absence (the reorg guard must not diagnose on this).
  return {accepting: null, cursor: at, complete: false};
}

/** Mempool entry of `txid` on the connected node: {fee,isOrphan} in the transaction OR orphan pool, null when the node reports
 * it absent. Pending is NOT accepted; absent is NOT rejected (it may already be accepted, replaced, or expired).
 * Network errors propagate (unknown is not absent). rusty-kaspa v2.1.0 rpc/service get_mempool_entry_call. */
export async function mempoolEntry(link, txid) {
  hash32(txid);
  try {
    const r = await link.call('getMempoolEntry', {transactionId: txid, includeOrphanPool: true, filterTransactionPool: false});
    const e = r?.mempoolEntry;
    ensure(e && e.transaction, '节点返回的内存池条目格式错误');
    return {fee: uint(e.fee), isOrphan: e.isOrphan === true};
  } catch (err) {
    // Fixed rpc/core/error.rs TransactionNotFound, not a missing method/route or unrelated txid.
    const message = typeof err?.rpc === 'string' ? err.rpc : err?.rpc?.message;
    if (err instanceof RpcError && err.method === 'getMempoolEntry' &&
        message === `Transaction ${txid} not found`) return null;
    throw err;
  }
}
/** Mempool presence on the connected node (pending ≠ accepted). Unknown (network error) counts as not present. */
export async function inMempool(pair, txid) {
  try { return !!(await mempoolEntry(pair, txid)); } catch { return false; }
}

/** Call ONLY after acceptedAt(): exact approved fields and covenant witness;
 * only authorized ordinary signatures may differ. Never a wallet-response check. */
export function matchesDraft(accepted, draft) {
  const need = (ok, code, message) => { if (!ok) throw Object.assign(new Error(message), {code, safeCode: code}); };
  const expect = structuredClone(draft.transaction), got = structuredClone(accepted.tx);
  for (const i of draft.authorizedInputIndices) { need(/^41[0-9a-f]{128}01$/.test(got.inputs[i]?.signatureScript ?? ''), 'ACCEPTED_SIGNATURE_FORMAT', '接受交易的签名格式异常'); expect.inputs[i].signatureScript = got.inputs[i].signatureScript; }
  need(stable(expect) === stable(got), 'ACCEPTED_FIELDS', '被接受的交易与批准的计划字段不一致');
  // Input DAA is chain context, not approved content: after a short reorg the SAME signed bytes may be re-accepted with a
  // re-accepted parent at another DAA (zero-depth chaining). Consensus validated that context; it is reported, not fatal.
  need(accepted.inputs?.length === draft.inputUtxos.length && accepted.inputs.every((u, i) => {
    const f = draft.inputUtxos[i];
    return u && u.value === f.value && stable(typeof u.spk === 'string' ? parseSpk(u.spk) : u.spk) === stable(f.spk) && (u.covenantId ?? null) === (f.covenantId ?? null);
  }), 'ACCEPTED_INPUTS', '接受交易输入上下文与批准记录不一致或缺失');
  const fee = accepted.inputs.reduce((a, u) => a + u.value, 0n) - got.outputs.reduce((a, o) => a + o.value, 0n);
  need(fee === draft.fee, 'ACTUAL_FEE', '实际费用与批准费用不一致');
  return fee;
}
/** Indices whose accepted input DAA differs from the approved draft (display/audit only; see matchesDraft). */
export const inputDaaDrift = (accepted, draft) => draft.inputUtxos.flatMap((f, i) => accepted.inputs?.[i] && accepted.inputs[i].daa !== f.daa ? [i] : []);
/** Outpoint liveness of each input on the connected node: {live, utxo} per input (utxo = the node's current entry).
 * Read-only; a failed request throws (unknown is never "spent"). Used by the reorg guard's diagnosis only. */
export async function inputsState(pair, utxos, {addressOf = addressOfLink(pair), readUtxos = commonUtxos} = {}) {
  const byAddr = new Map();
  for (const f of utxos) { const a = addressOf(f.spk); ensure(a, '输入脚本无法转换为地址'); (byAddr.get(a) ?? byAddr.set(a, []).get(a)).push(f); }
  const found = new Map();
  for (const [a, list] of byAddr) {
    const live = await readUtxos(pair, a);
    for (const f of list) found.set(f, live.find(x => x.outpoint.transactionId === f.outpoint.transactionId && x.outpoint.index === f.outpoint.index) ?? null);
  }
  return utxos.map(f => { const u = found.get(f); return {live: !!u, utxo: u}; });
}
