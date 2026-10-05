/** V2: reuse Opus signing/planning/single submission without weakening acceptance or release rules.
 * Engine increments: (1) bounded ancestor walk for an off-selected-chain search cursor; (2) TN10 REST lookup for
 * records the node could not resolve. REST only LOCATES the accepting block: if the trusted node still has it, the
 * normal selected-chain acceptance + full field comparison runs and only that sets ACCEPTED. If the node has pruned
 * it, the REST claim is kept as a separately labelled external witness; the shared journal status stays UNKNOWN.
 * No TTL release, synthetic acceptedTx, UTXO-only action fallback or local-history finality inference. */
import {Engine} from './shared/engine.mjs';
import {ensure, hash32, errorText, NETWORK_GENESIS, PROFILE_ID} from './shared/core.mjs';
import {commonUtxos, acceptedAt, matchesDraft} from './shared/chain.mjs';
import {spkToAddress} from './shared/lib/address.mjs';
import {uint} from './shared/lib/json.mjs';
import {queryRest, REST_BASE} from './rest.mjs';
import {LEGACY_NODE_URLS} from './endpoints.mjs';
const PREFIX = `${NETWORK_GENESIS}/${PROFILE_ID}/tx/`;
// Node errors for history below the retention root / missing headers (consensus error texts + live probe 2026-10-04).
const PRUNED = /retention root|cannot find header|cannot find full block/i;
/** Fresh submissions are found by the node's own search; do not send every new txid to a third party or poll it.
 * REST is consulted only when the node still cannot settle a record that is older than this. */
export const REST_AFTER_MS = 10 * 60_000;
export const wantsRest = (r, now = Date.now()) => r?.status === 'UNKNOWN' && now - (r.createdAt ?? now) > REST_AFTER_MS;
const OFFLINE = /没有可用的 TN10 节点|连接超时|无法连接|连接已关闭|节点请求超时|节点未连接|NODE_DISCONNECTED|NODE_CLOSED/;

export async function chainAncestor(rpc, block, limit = 64) {
  let b = block;
  for (let i = 0; i < limit && b; i++) {
    if (b.verboseData?.isChainBlock === true) return hash32(b.header.hash);
    const parent = b.verboseData?.selectedParentHash;
    if (!parent) return null;
    b = (await rpc.call('getBlock', {hash: hash32(parent), includeTransactions: false})).block;
    ensure(b?.header?.hash === parent, '节点祖先区块哈希不符');
  }
  return null;
}

/** Node check of a REST-reported accepting block. REST supplies only the LOCATION; the trusted node decides.
 * VERIFIED = same selected-chain acceptance + full field comparison as the normal reconcile path.
 * PRUNED / UNAVAILABLE = the node can neither verify nor contradict. CONFLICT = the node contradicts REST (node wins).
 * ERROR = anything else (fails closed: no REST-only display). */
export async function verifyAtHint(link, record, accepting, claimedBlue = null) {
  hash32(accepting);
  let rpc;
  try { [rpc] = await link.connect(); } catch (err) { return {result: 'UNAVAILABLE', chainBlock: null, error: errorText(err)}; }
  let block;
  try { block = (await rpc.call('getBlock', {hash: accepting, includeTransactions: false})).block; }
  catch (err) {
    const m = errorText(err);
    if (OFFLINE.test(m)) return {result: 'UNAVAILABLE', chainBlock: null, error: m};
    if (!PRUNED.test(m)) return {result: 'ERROR', chainBlock: null, error: m};
    // A missing header is consistent with pruning ONLY if the claimed block is older than the node's pruning point.
    // A synced node keeps headers above its pruning point, so a newer claim it lacks contradicts REST.
    if (claimedBlue == null) return {result: 'ERROR', chainBlock: null, error: 'REST 未提供接受块 blue score，无法判断节点缺块是否属于正常裁剪'};
    try {
      const pp = hash32((await rpc.call('getBlockDagInfo')).pruningPointHash);
      const ppBlock = (await rpc.call('getBlock', {hash: pp, includeTransactions: false})).block;
      ensure(ppBlock?.header?.hash === pp, '裁剪点区块哈希不符');
      const ppBlue = uint(ppBlock.header.blueScore);
      if (uint(claimedBlue) >= ppBlue) return {result: 'CONFLICT', chainBlock: null, pruningBlue: ppBlue.toString(), error: `节点裁剪点 blue score ${ppBlue}；REST 声称的接受块（${claimedBlue}）并不更早，节点却没有该区块头：以节点为准`};
      return {result: 'PRUNED', chainBlock: null, pruningBlue: ppBlue.toString(), error: m};
    } catch (e2) { const m2 = errorText(e2); return {result: OFFLINE.test(m2) ? 'UNAVAILABLE' : 'ERROR', chainBlock: null, error: m2}; }
  }
  if (block?.header?.hash !== accepting) return {result: 'ERROR', chainBlock: null, error: '节点返回的区块哈希不符'};
  // While the node still has the header, REST's blue score must agree with it.
  if (claimedBlue != null && uint(block.header.blueScore) !== uint(claimedBlue)) return {result: 'CONFLICT', chainBlock: block.verboseData?.isChainBlock ?? null, error: `节点区块头 blue score ${block.header.blueScore} 与 REST 声称的 ${claimedBlue} 不符：以节点为准`};
  const chainBlock = block.verboseData?.isChainBlock;
  if (chainBlock === false) return {result: 'CONFLICT', chainBlock: false, error: '节点显示 REST 报告的接受块不在当前选中链上（REST 可能尚未反映重组），以节点为准'};
  if (chainBlock !== true) return {result: 'ERROR', chainBlock: null, error: '节点未返回选中链信息'};
  try {
    const ev = await acceptedAt(rpc, record.txid, accepting);
    return {result: 'VERIFIED', chainBlock: true, ev, fee: matchesDraft(ev, record.draft)};
  } catch (err) {
    const m = errorText(err);
    if (err?.code === 'NOT_ACCEPTED') return {result: 'CONFLICT', chainBlock: true, error: '节点显示该块的接受集合中没有这笔交易，以节点为准'};
    if (err?.code === 'NOT_CHAIN') return {result: 'CONFLICT', chainBlock: null, error: m};
    if (PRUNED.test(m)) return {result: 'PRUNED', chainBlock: true, error: m};
    if (OFFLINE.test(m)) return {result: 'UNAVAILABLE', chainBlock: true, error: m};
    if (/字段不一致|费用与批准|签名格式异常|txid 不符/.test(m)) return {result: 'CONFLICT', chainBlock: true, error: m};
    return {result: 'ERROR', chainBlock: true, error: m};
  }
}

export class EngineV2 extends Engine {
  constructor({restQuery = queryRest, legacyUrls = LEGACY_NODE_URLS, ...options}) { super(options); this.restQuery = restQuery; this.legacyUrls = legacyUrls; }
  /** Unlike a generic STALE_INPUT error, actual outpoint absence establishes that it is no longer live.
   * Amount/SPK mismatch or a failed request is not permission to release. CAS preserves concurrent updates. */
  async archive(txid) {
    const store = await this.store(), k = PREFIX + hash32(txid), cur = await store.get(k);
    ensure(cur, '没有此记录');
    ensure(!['ACCEPTED', 'ARCHIVED', 'SUBMITTING'].includes(cur.value.status), '此记录当前不能归档');
    await this.pair.connect();
    let absent = false;
    if (cur.value.status !== 'REJECTED') {
      for (const u of cur.value.draft.inputUtxos) {
        const address = spkToAddress(u.spk); ensure(address, '输入脚本无法转换为地址');
        const live = await commonUtxos(this.pair, address);
        if (!live.some(v => v.outpoint.transactionId === u.outpoint.transactionId && v.outpoint.index === u.outpoint.index)) absent = true;
      }
      ensure(absent, '输入仍然未花费：结果未知时不能释放，请稍后核对。');
    }
    await store.compareAndSet(k, cur.revision, {...cur.value, status: 'ARCHIVED', archivedAt: Date.now(), archiveReason: absent ? 'INPUT_NO_LONGER_LIVE' : 'DEFINITE_REJECTION'});
  }
  async plan(request, session) {
    const p = await super.plan(request, session);
    // Display-only facts; transaction, signing and mass logic remain in the shared engine.
    p.request = structuredClone(request);
    return p;
  }
  async reconcile(txid, onProgress = () => {}) {
    const store = await this.store(), k = PREFIX + hash32(txid);
    let cur = await store.get(k);
    ensure(cur, '本浏览器没有这笔交易的记录');
    if (cur.value.status === 'ARCHIVED') return cur.value;
    // The latest-lookup slot belongs to one node check; clear it so a later node result never shows stale details.
    // (The sticky REST witness `restWitness` is kept and re-tested below.)
    if (cur.value.restCheck) cur = await store.compareAndSet(k, cur.revision, {...cur.value, restCheck: null});
    try {
      const [rpc] = await this.pair.connect();
      let r = cur.value;
      // 2026-10-04 endpoint change: resume from a search cursor saved under a retired URL of the same service instead of
      // restarting at the submit anchor. A cursor is only a chain-block hash: it is re-checked below (selected-chain
      // test / bounded ancestor walk) and again by the original search, so it can never establish acceptance by itself.
      const legacy = r.cursors?.[rpc.url] ? null : this.legacyUrls.map(u => r.cursors?.[u]).find(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h));
      if (legacy) { cur = await store.compareAndSet(k, cur.revision, {...r, cursors: {...r.cursors, [rpc.url]: legacy}}); r = cur.value; }
      const cursor = r.cursors?.[rpc.url] ?? r.anchors?.find(a => a.url === rpc.url)?.sink ?? r.anchors?.[0]?.sink;
      const hash = r.accepting ?? cursor;
      if (hash) {
        const b = (await rpc.call('getBlock', {hash, includeTransactions: false})).block;
        ensure(b?.header?.hash === hash, '节点返回的区块哈希不符');
        if (b.verboseData?.isChainBlock === false) {
          onProgress('查询起点已离开选中链，正在寻找仍在链上的祖先…');
          const ancestor = await chainAncestor(rpc, b);
          if (ancestor) await store.compareAndSet(k, cur.revision, {...r, accepting: undefined,
            previousAccepting: r.accepting ?? r.previousAccepting,
            cursors: {...r.cursors, [rpc.url]: ancestor}, cursorRepairAt: Date.now()});
        }
      }
    } catch (err) {
      // Preserve CAS conflict: another tab owns the latest revision. Do not write stale facts over it.
      if (err?.message === 'STALE_CACHE_REVISION') throw err;
      // Pruning, missing headers, network failures and exhausted walks are NOT acceptance or permission to release.
      // Let the original reconciliation report the actual failure and preserve its input reservation.
    }
    const result = await super.reconcile(txid, onProgress);
    if (!this.restQuery || !wantsRest(result)) return result;
    return this.restBackup(k, result, onProgress);
  }
  /** Read-only REST lookup after an UNKNOWN node result. Never submits, archives or releases inputs. */
  async restBackup(k, result, onProgress = () => {}) {
    const store = await this.store(), current = await store.get(k), txid = result.txid;
    // Bind to exactly this node check; another tab's newer check or archive wins.
    ensure(current && current.value.status === 'UNKNOWN' && current.value.checkedAt === result.checkedAt, 'STALE_CACHE_REVISION');
    onProgress('节点未能查明；正在向 api-tn10.kaspa.org 查询（只发送交易 ID）…');
    let check;
    try { check = await this.restQuery(result); }
    catch (err) { check = {outcome: 'ERROR', source: REST_BASE, checkedAt: Date.now(), error: errorText(err)}; }
    let witness = result.restWitness ?? null;
    if (check.outcome === 'ACCEPTED') {
      witness = check.fields?.ok === true ? {source: REST_BASE, txid, acceptingBlockHash: check.acceptingBlockHash,
        acceptingBlueScore: check.acceptingBlueScore ?? null, fields: check.fields, observedAt: check.checkedAt} : null;
    } else if (check.outcome === 'UNCONFIRMED') witness = null; // REST no longer reports acceptance: drop the old claim.
    // NOT_FOUND / ERROR carry no new information (REST retention, rate limit, network): keep an earlier observation.
    const hint = check.outcome === 'ACCEPTED' ? {acceptingBlockHash: check.acceptingBlockHash, acceptingBlueScore: check.acceptingBlueScore ?? null, from: 'REST'}
      : witness ? {acceptingBlockHash: witness.acceptingBlockHash, acceptingBlueScore: witness.acceptingBlueScore ?? null, from: 'WITNESS'} : null;
    let v = null, node = null;
    if (hint) {
      onProgress('正在用节点核对 REST 给出的接受块…');
      v = await verifyAtHint(this.pair, result, hint.acceptingBlockHash, hint.acceptingBlueScore);
      node = {result: v.result, chainBlock: v.chainBlock ?? null, pruningBlue: v.pruningBlue ?? null, error: v.error ?? null, checkedAt: Date.now()};
      if (v.result === 'CONFLICT') witness = null; // The trusted node contradicts REST: the node wins.
    }
    // nodeSearch: why the node's own search did not settle it (transparency; e.g. beyond the bounded range, pruned).
    const restCheck = {...check, txid, nodeCheckedAt: result.checkedAt, nodeSearch: result.error ?? result.note ?? null, hint, node};
    let next;
    if (v?.result === 'VERIFIED') {
      // Genuine node verification (the same checks as a normal reconcile); REST only located the block.
      const {error: _stale, ...base} = result, ev = v.ev;
      next = {...base, status: 'ACCEPTED', accepted: true, accepting: hint.acceptingBlockHash, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations,
        actualFee: v.fee, computeMass: ev.computeMass, storageMass: ev.tx.storageMass, verifiedAt: Date.now(), locatedBy: 'REST',
        note: '节点当前选中链已接受，且全部字段与批准计划一致（接受块位置由 REST 提供；不是不可逆最终性）', restWitness: witness, restCheck};
    } else next = {...result, restWitness: witness, restCheck};
    // Otherwise status stays UNKNOWN: inputs stay reserved, no localTip, no resubmission. REST-only is display-level.
    await store.compareAndSet(k, current.revision, next);
    return next;
  }
}
