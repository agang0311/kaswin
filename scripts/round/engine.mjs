/** Kaswin V2 operation engine: GENESIS / BUY / CLOSE / DRAW_AND_PAY / TIMEOUT_REFUND / REFUND.
 * plan():   live snapshot from the configured node -> core builder -> consensus mass -> fee fixed point -> frozen plan.
 * execute(): user approval -> wallet signs ordinary inputs only -> local signed-field checks ->
 *            session record (+ optional IndexedDB persistence) -> ONE submit -> record outcome.
 * reconcile(): acceptance + exact approved economic/consensus fields and covenant witness.
 */
import {S, ensure, hash32, hex, unhex, availableActions, actionBudget, referenceTxId, stable, kas, errorText,
  REGISTRATION_SOMPI, refundBatch, PROFILE_ID, IndexedStore, UserError} from '../core.mjs';
import {requireNet} from '../chain/network-schema.mjs';
import {convergeFee, quoteMass, MassLimitError} from '../chain/mass.mjs';
import {FEE_TIERS, isIdle, waitSeconds, recommendTier, orderingRate} from '../chain/feetiers.mjs';
import {decodeSpend} from '../core/lib/accepted.js';
import {commonUtxos, verifyInputsLive, acceptedAt, searchAccepted, mempoolEntry, matchesDraft, inputDaaDrift, inputsState, REORG_RECHECK_DAA, acceptanceDepth} from '../chain/chain.mjs';
import {diagnose, inResendWindow, TRACKED, RESEND_LIMIT, DIAG_GAP_MS, PENDING_GRACE_MS, VERDICT_TEXT} from '../tracking/tracker.mjs';
import {classifySubmit, classifySubmitResponse, classifyInitialWebSubmit} from '../tracking/diagnosis.mjs';
import {signWithWallet} from '../wallet/kasware.mjs';
import {txToRpc, txFromRpc} from '../chain/nodes.mjs';
import {spkToAddress, addressToSpk} from '../wallet/address.mjs';
import {acquireDrawProof, waitForDrawTarget, checkDraftDraw, fenceDraw} from './passa.mjs';
import {liveRound} from './rounds.mjs';
import {reservedInputs, familyKeys} from '../tracking/reservations.mjs';
import {OperationEngine} from './operation-engine.mjs';
import {CasIntentStore} from '../store/intent-store.mjs';
import {SessionStore} from '../store/session-store.mjs';
import {selectedChainAnchor} from '../chain/selected-chain.mjs';
import {signedWire, assertSignedRecord} from '../tracking/signed-record.mjs';
import {requireTradingRelease} from '../release-safety.mjs';
import {uint} from '../chain/json.mjs';
import {queryRest} from '../chain/rest.mjs';
import {LEGACY_NODE_URLS} from '../chain/endpoints.mjs';
import {AcceptanceNotices} from '../tracking/acceptance-notices.mjs';
import {queryContext, sameQueryContext, sameConnectionContext, failure} from '../chain/operation.mjs';
import {AcceptanceEvidence} from '../chain/acceptance-evidence.mjs';

const FOLLOWING = new Set(['SUBMITTING', 'SUBMITTED', 'PENDING', 'UNKNOWN', 'RECHECKING', 'CONFIRMING', 'REPLACED']);
async function sharedRead(tasks, key, task) {
  if (tasks.has(key)) return structuredClone(await tasks.get(key));
  const work = Promise.resolve().then(task); tasks.set(key, work);
  try { return structuredClone(await work); }
  finally { if (tasks.get(key) === work) tasks.delete(key); }
}

// Node history errors below the retention root (fixed source + historical probe, not current network evidence).
const PRUNED = /retention root|cannot find header|cannot find full block/i;
const OFFLINE = /没有可用的 .* 节点|连接超时|无法连接|连接已关闭|节点请求超时|节点未连接|NODE_DISCONNECTED|NODE_CLOSED|RPC_TIMEOUT|RPC_OPERATION_TIMEOUT|CONNECT_TIMEOUT|CONNECTION_CANCELLED/;
/** Fresh records stay on the configured node; REST is an optional location hint only for old UNKNOWN records. */
export const REST_AFTER_MS = 10 * 60_000;
export const wantsRest = (r, now = Date.now()) => r?.status === 'UNKNOWN' && now - (r.createdAt ?? now) > REST_AFTER_MS;

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

/** REST supplies only a LOCATION; selected-chain acceptance and full approved fields are checked on the node.
 * PRUNED/UNAVAILABLE cannot authorize acceptance or release; CONFLICT means the node contradicts the hint. */
export async function verifyAtHint(link, record, accepting, claimedBlue = null, {evidence = null, origin = null} = {}) {
  hash32(accepting);
  let rpc;
  try { [rpc] = await link.connect(); } catch (err) { return {result: 'UNAVAILABLE', chainBlock: null, error: errorText(err)}; }
  let block;
  try { block = (await rpc.call('getBlock', {hash: accepting, includeTransactions: false})).block; }
  catch (err) {
    const m = errorText(err);
    if (OFFLINE.test(m)) return {result: 'UNAVAILABLE', chainBlock: null, error: m};
    if (!PRUNED.test(m)) return {result: 'ERROR', chainBlock: null, error: m};
    // Missing headers above the pruning point contradict REST; absence alone is not proof of pruning.
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
  if (claimedBlue != null && uint(block.header.blueScore) !== uint(claimedBlue)) return {result: 'CONFLICT', chainBlock: block.verboseData?.isChainBlock ?? null, error: `节点区块头 blue score ${block.header.blueScore} 与 REST 声称的 ${claimedBlue} 不符：以节点为准`};
  const chainBlock = block.verboseData?.isChainBlock;
  if (chainBlock === false) return {result: 'CONFLICT', chainBlock: false, error: '节点显示 REST 报告的接受块不在当前选中链上（REST 可能尚未反映重组），以节点为准'};
  if (chainBlock !== true) return {result: 'ERROR', chainBlock: null, error: '节点未返回选中链信息'};
  let proof = null;
  try {
    if (evidence) proof = await evidence.read(record.txid, accepting, {link, origin});
    const ev = proof?.ev ?? await acceptedAt(rpc, record.txid, accepting);
    return {result: 'VERIFIED', chainBlock: true, ev, fee: matchesDraft(ev, record.draft),
      ...(proof ? {virtualDaa: proof.virtualDaa, scope: proof.scope} : {})};
  } catch (err) {
    proof?.scope.close();
    const m = errorText(err);
    if (err?.code === 'NOT_ACCEPTED') return {result: 'CONFLICT', chainBlock: true, error: '节点显示该块的接受集合中没有这笔交易，以节点为准'};
    if (err?.code === 'NOT_CHAIN') return {result: 'CONFLICT', chainBlock: null, error: m};
    if (PRUNED.test(m)) return {result: 'PRUNED', chainBlock: true, error: m};
    if (OFFLINE.test(m)) return {result: 'UNAVAILABLE', chainBlock: true, error: m};
    if (/字段不一致|费用与批准|签名格式异常|txid 不符/.test(m)) return {result: 'CONFLICT', chainBlock: true, error: m};
    return {result: 'ERROR', chainBlock: true, error: m};
  }
}

import {CONTRACT_VERSION, requireRuntimeProfile} from '../contract/runtime.mjs';

export const STORE = 'kaswin-opus-f32';
const PLAN_TTL_MS = 90_000;
export const ACTION_LABEL = {GENESIS: '创建轮次', BUY: '购买', CLOSE: '封盘', DRAW_AND_PAY: '开奖并派奖', TIMEOUT_REFUND: '超时转退款', REFUND: '退款批次'};
const ROLE_LABEL = {WINNER: '中奖者奖金', CREATOR: '创建者押金返还', EXECUTOR: '执行者', BUYER_REFUND: '买家退款', CHANGE: '找零', STATE: '轮次状态（covenant 后继）', REGISTRY: 'Registry 登记'};
const key = o => `${o.transactionId}:${o.index}`;
/** First verified acceptance -> CONFIRMING; ACCEPTED only when acceptance is verified (again) with the accepting block at
 * least REORG_RECHECK_DAA deep. Every field check has already passed for this very block (acceptedAt + matchesDraft). */
export function acceptanceStep(r, ev, virtualDaa, threshold = REORG_RECHECK_DAA, now = Date.now()) {
  const depth = acceptanceDepth(virtualDaa, ev.acceptingDaa);
  const first = r.firstAcceptedAt && r.firstAccepting ? {firstAcceptedAt: r.firstAcceptedAt, firstAccepting: r.firstAccepting} : {firstAcceptedAt: now, firstAccepting: ev.accepting};
  if (depth >= threshold) return {...first, status: 'ACCEPTED', accepted: true, depthDaa: depth, recheckedAt: now,
    note: `节点当前选中链已接受，接受块已深入 ${depth} DAA 后再次核对；批准的输入、输出、费用和预算均已核对（合约费用见证严格匹配；不是不可逆最终性）`};
  return {...first, status: 'CONFIRMING', accepted: false, depthDaa: depth,
    note: `节点选中链已接受且字段一致；接受块目前深 ${depth} DAA，深入 ${threshold} DAA（约 10 秒）后再核对一次，防短程重组`};
}
// crypto.randomUUID / navigator.locks are secure-context only; plain-http LAN pages need fallbacks.
const planId = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); };
/** A renewable HTTP/LAN lease and input reservations reduce accidental duplicate work.
 * Their cross-tab guarantees require the durable backend; session fallback still relies on consensus single-spend. */
export function leaseLocks(openStore, ttlMs = 120_000) {
  ensure(Number.isSafeInteger(ttlMs) && ttlMs >= 30, '租约时长无效');
  return {
    async request(name, _opts, fn) {
      const store = await openStore(), k = `lock/${name}`, me = planId(), now = Date.now();
      const cur = await store.get(k);
      if (cur && cur.value.owner && cur.value.until > now) return fn(null);
      try { await store.compareAndSet(k, cur?.revision ?? null, {owner: me, until: now + ttlMs}); } catch { return fn(null); }
      let stopped = false, lost = false, renewal = null;
      const assertHeld = async () => {
        const c = await store.get(k);
        ensure(!lost && !stopped && c?.value.owner === me && c.value.until > Date.now(), '提交租约已失效，已停止提交', 'SUBMIT_LEASE_LOST');
      };
      const renew = async () => {
        const c = await store.get(k);
        ensure(!stopped && c?.value.owner === me && c.value.until > Date.now(), 'SUBMIT_LEASE_LOST');
        await store.compareAndSet(k, c.revision, {owner: me, until: Date.now() + ttlMs});
      };
      const timer = setInterval(() => {
        if (!stopped && !lost && !renewal) renewal = renew().catch(() => { lost = true; }).finally(() => { renewal = null; });
      }, Math.max(10, Math.floor(ttlMs / 3)));
      timer.unref?.();
      try { return await fn({name, lease: {key: k, owner: me}, assertHeld}); }
      finally {
        stopped = true; clearInterval(timer); if (renewal) await renewal;
        try { const c = await store.get(k); if (c?.value.owner === me) await store.compareAndSet(k, c.revision, {owner: null, until: 0}); } catch {}
      }
    },
  };
}

export class Engine {
  /** onLive(live, cid): display-only notice of each node-verified live snapshot read while planning (also when the
   * action then turns out unavailable). It cannot alter the plan; the page uses it to stop showing a stale view. */
  constructor({net, pair, profile, indexer, onStatus = () => {}, onLive = () => {}, openStore = () => IndexedStore.open(STORE), reserveInputs = true, locks = null, drawProof = acquireDrawProof, reorgRecheckDaa = REORG_RECHECK_DAA, restQuery, legacyUrls = LEGACY_NODE_URLS, resolveRound = null, onAccepted = () => {}}) {
    this.net = requireNet(net);
    ensure(!pair.net || pair.net.genesis === net.genesis, 'ENGINE_NETWORK_MISMATCH');
    this.prefix = `${net.genesis}/${PROFILE_ID}/tx/`;
    this.submitLock = net.web?.legacyConfig ? 'kaswin-opus-submit' : `kaswin-opus-submit/${net.genesis}`;
    if (restQuery === undefined) restQuery = record => queryRest(record, {net});
    if (typeof reorgRecheckDaa !== 'bigint' || reorgRecheckDaa < 0n) throw Error('REORG_RECHECK_DAA');
    if (typeof reserveInputs !== 'boolean') throw Error('RESERVATION_POLICY');
    Object.assign(this, {pair, profile, indexer, onStatus, onLive, openStore, reserveInputs, drawProof, reorgRecheckDaa, restQuery, legacyUrls}); this.plans = new Map(); this.tierBuilds = new Map(); this.planEpoch = 0; this.storeP = null;
    this.resolveRound = resolveRound; this.onAccepted = onAccepted;
    this.acceptance = new AcceptanceNotices(pair);
    this.evidenceOwner = Symbol('transaction-evidence'); this.evidence = new AcceptanceEvidence({link: pair, profileId: profile.id});
    this.evidence.onProof(proof => this.acceptance.remember(proof.ev.txid, proof.ev.accepting, proof.context, {wake: proof.origin !== this.evidenceOwner}));
    this.reconciles = new Map(); this.follows = new Map(); this.disposed = false;
    this.locks = locks === false ? {request: (_name, _options, task) => task({})}
      : locks ?? globalThis.navigator?.locks ?? leaseLocks(() => this.store());
  }
  store() { return this.storeP ??= Promise.resolve(new SessionStore(this.openStore)); }
  trackAcceptance(txid) { this.evidence.track(txid); return this.acceptance.track(txid); }
  releaseAcceptance(txid) { this.acceptance.release(txid); this.evidence.release(txid); }
  wakeAcceptance(txid) { this.acceptance.wake(txid); }
  waitForAcceptance(txid, ms, since = 0) { return this.acceptance.wait(txid, ms, since); }
  invalidatePlans() { this.planEpoch++; this.plans.clear(); this.tierBuilds.clear(); }
  discardPlan(plan) { if (this.plans.get(plan.id) === plan) { this.plans.delete(plan.id); this.tierBuilds.delete(plan.id); } }
  dispose() { this.disposed = true; this.invalidatePlans(); this.acceptance.stop(); this.evidence.dispose(); }
  async records() { const s = await this.store(); return (await s.list(this.prefix)).map(r => r.record.value).sort((a, b) => b.createdAt - a.createdAt); }
  /** Release a STALE submit lease. Only the IndexedDB lease used on plain-http pages can outlive its tab; browser Web
   * Locks are released automatically when the holding tab closes. A lease younger than its TTL is never released here,
   * because the tab holding it may be about to broadcast. Own exact-txid records additionally prevent repeat execution
   * within this session, with cross-tab input reservations when the persistent backend is available. */
  async resetLock() {
    const store = await this.store(), cur = await store.get(`lock/${this.submitLock}`);
    if (!cur?.value?.owner) return {released: false, reason: 'NO_LEASE'};
    ensure(cur.value.until <= Date.now(), `提交锁仍在有效期内（约 ${Math.ceil((cur.value.until - Date.now()) / 1000)} 秒后自动失效）。若另一个标签页正在等待钱包签名，请先在那里完成或取消。`);
    await store.compareAndSet(`lock/${this.submitLock}`, cur.revision, {owner: null, until: 0});
    return {released: true};
  }
  // Other Profiles contribute only outpoint reservations, never ledger/ABI or reconciliation context.
  async reserved() { return this.reserveInputs ? reservedInputs(await this.store(), this.net.genesis) : new Set(); }
  /** Newest locally-known node-verified state of a round (lets the creator/buyer continue before the indexer catches up).
   * Zero-depth policy (2026-10-13, option B): a CONFIRMING record (first selected-chain acceptance verified, fields
   * matched) is already a usable predecessor. It is only a candidate: liveRound() re-verifies the live UTXO and its
   * acceptance on the node before any plan, and the tracker keeps following it until the 100 DAA settlement recheck. */
  async localTip(cid, records = null) {
    const recs = (records ?? await this.records()).filter(r => r.cid === cid && ['ACCEPTED', 'CONFIRMING'].includes(r.status));
    const spent = new Set(recs.flatMap(r => r.inputs.map(key)));
    const head = recs.find(r => !spent.has(`${r.txid}:0`) && (r.nextLedger || r.terminal));
    return head ? {txid: head.txid, terminal: head.terminal, nextLedger: head.nextLedger, value: head.nextValue, spk: head.nextSpk, utxoDaa: head.acceptingDaa, accepting: head.accepting, origin: head.origin, genesisTxid: head.genesisTxid, inputs: head.inputs, at: head.verifiedAt} : null;
  }

  /** Only ordinary, non-coinbase UTXOs; coinbase spending is deliberately unsupported. */
  async funding(session, reservedSet = null) {
    const reserved = reservedSet ?? await this.reserved();
    const all = await commonUtxos(this.pair, session.address);
    return all.filter(u => !u.covenantId && !u.isCoinbase && stable(u.spk) === stable(session.spk) && !reserved.has(key(u.outpoint)))
      .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  }
  /** Greedy: largest UTXOs first, at most 8 (contract funding loop bound). */
  pick(utxos, need) {
    const out = []; let sum = 0n;
    for (const u of utxos) { if (out.length === 8) break; out.push(u); sum += u.value; if (sum >= need) return out; }
    throw new UserError(`钱包可用资金不足：需要约 ${kas(need)} ${this.net.unit}（含预留手续费），最多可用 8 个 UTXO 合计 ${kas(sum)} ${this.net.unit}。可先在钱包内合并 UTXO。`, 'FUNDS');
  }

  /** Build a frozen plan. request: {action, cid?, quantity?, config?, registry?, mode?} */
  async plan(request, session) {
    const planEpoch = this.planEpoch;
    ensure(!this.disposed, '页面运行会话已变化，请重新开始');
    requireTradingRelease(this.net);
    requireRuntimeProfile(this.profile);
    const {action} = request;
    ensure(ACTION_LABEL[action], '未知动作');
    ensure(session.network === this.net.networkId, 'WALLET_NETWORK_MISMATCH');
    this.onStatus(`检查 ${this.net.label} 节点连接与当前链状态…`);
    await this.pair.connect();
    const currentDaa = await this.pair.currentDaa();
    this.onStatus('探测网络费率与内存池…');
    const conditions = await this.pair.feeConditions({maxAgeMs: 10000}), feerate = conditions.normal.feerate;
    let live = null, op = null, proof = null, registry = null;
    if (action === 'GENESIS') {
      S.validateConfig(request.config);
      ensure(request.config.closeEligibleDaa > currentDaa + 60n, '封盘时间过近或已过：请重新选择时长');
      // true = the network's default registry; a string is a user-chosen address (Schnorr P2PK / P2SH, this network only).
      registry = request.registry === true ? this.net.registry.spk : typeof request.registry === 'string' ? addressToSpk(request.registry.trim(), this.net.addressPrefix) : null;
    } else {
      hash32(request.cid, 'Covenant ID');
      this.onStatus('读取轮次账本，并在节点上核对实时状态 UTXO…');
      live = this.resolveRound ? await this.resolveRound(request.cid) : await liveRound(this.pair, this.indexer, this.profile, request.cid, currentDaa, await this.localTip(request.cid));
      try { this.onLive(live, request.cid); } catch {}
      const acts = availableActions(live.snapshot, this.profile);
      ensure(acts.includes(action), `当前链上条件不允许「${ACTION_LABEL[action]}」：${explainUnavailable(action, live)}`, 'NOT_AVAILABLE');
      op = {action, actorKey: session.key};
      if (action === 'BUY') { ensure(Number.isSafeInteger(request.quantity) && request.quantity >= 1, '购买张数无效'); op.quantity = request.quantity; }
      if (action === 'DRAW_AND_PAY') {
        this.onStatus('采集并验证 PASS-A 随机证明（约 5–30 秒）…');
        proof = await this.drawProof(this.pair, this.profile, live, s => this.onStatus(s));
        proof.confirmation = await waitForDrawTarget(this.pair, proof.opening, this.onStatus);
        op.opening = proof.opening; op.accessor = {blockHash: proof.target.hash, sequenceCommitment: proof.target.seqCommit};
      }
    }
    // Funding requirement (principal + generous fee headroom; exact fee is the fixed point below).
    const s = live?.ledger;
    const principal = action === 'GENESIS' ? S.DEPOSIT + (registry ? REGISTRATION_SOMPI : 0n) : action === 'BUY' ? BigInt(op.quantity) * s.config.ticketPrice : 0n;
    const needsFunds = action !== 'DRAW_AND_PAY' && action !== 'REFUND';
    const pool = action === 'REFUND' ? refundBatch(s).pool : 0n;
    const reservedSet = await this.reserved();
    for (const i of live ? [live.snapshot.tip] : []) ensure(!reservedSet.has(key(i)), '本浏览器已有一笔花费此轮状态的提交尚未对账，请先在「交易记录」中对账', 'PENDING_LOCAL');
    if (needsFunds) this.onStatus('核对钱包可用资金…');
    let available = needsFunds ? await this.funding(session, reservedSet) : [], refundFundsLoaded = false;
    this.onStatus('计算交易质量与费率收敛…');
    const make = funds => OperationEngine.builder({profile: this.profile, ownerKey: session.key, config: request.config,
      registrySpk: registry, snapshot: live?.snapshot, operation: op, funds, computeBudget: live ? actionBudget(action, s) : undefined});
    // Two complete, independently funded quotes on the same live state (only the fee and, if needed, the funding differ):
    //  economy: the node's LOW bucket rate on max(compute, normalized transient) = the mempool admission rule
    //           (check_transaction_standard.rs). Storage mass is not paid for, so a storage-heavy transaction ranks low
    //           and may wait until the ready mempool fits a block (everything is taken then).
    //  fast:    the node's NORMAL bucket rate on the full ordering mass incl. storage (feerate_key.rs), cap-clamped.
    const priceTier = (mode, rate) => {
      let funds = needsFunds ? this.pick(available, principal + 3_000_000n) : [], priced, sponsored = false;
      for (let round = 0; ; round++) {
        try { priced = convergeFee(make(funds), rate, {mode, cap: this.net.maxFeePerTx}); break; }
        catch (e) {
          const code = e?.code ?? e?.message;
          if (action === 'REFUND' && funds.length === 0 && (code === 'REFUND_FEE_POOL' || e instanceof MassLimitError)) {
            // Pool k × 0.02 (+0.02 from the final deposit) too small, or storage mass too high: sponsor ONE wallet UTXO.
            const big = available.find(u => u.value >= 100_000_000n);
            ensure(big, `该批退款需要执行者赞助一笔普通输入（执行费池 ${kas(pool)} ${this.net.unit} 不足或存储质量超限），但钱包没有 ≥1 ${this.net.unit} 的可用 UTXO`, 'SPONSOR');
            funds = [big]; sponsored = true; continue;
          }
          if (needsFunds && (code === 'INSUFFICIENT_FUNDING' || code === 'GENESIS_FUNDS') && round < 3) { funds = this.pick(available, principal + 50_000_000n * BigInt(round + 1)); continue; }
          if (e instanceof MassLimitError) throw new UserError(`交易质量超出区块上限（storage ${e.quote.storageMass} / compute ${e.quote.computeMass}）。可改用面额更大的资金 UTXO。`, 'MASS');
          throw e;
        }
      }
      const draft = priced.draft;
      draft.txid = referenceTxId(draft.transaction);
      for (const f of draft.inputUtxos.slice(action === 'GENESIS' ? 0 : 1)) ensure(!reservedSet.has(key(f.outpoint)), '资金输入已被一笔未对账的本地提交占用', 'PENDING_LOCAL');
      return {priced, sponsored, rate};
    };
    const quoted = {}, failures = {};
    for (const [tier, mode, rate] of [['economy', 'standard', conditions.low.feerate], ['fast', 'load', conditions.normal.feerate]]) {
      try { quoted[tier] = priceTier(mode, rate); }
      catch (e) {
        if (action === 'REFUND' && e?.code === 'SPONSOR' && !refundFundsLoaded) {
          // State-only refunds do not need a wallet UTXO query. Discover sponsorship only when a quote requires it.
          refundFundsLoaded = true; available = await this.funding(session, reservedSet);
          try { quoted[tier] = priceTier(mode, rate); } catch (retry) { failures[tier] = retry; }
        } else failures[tier] = e;
      }
    }
    if (!quoted.economy && !quoted.fast) throw failures.fast ?? failures.economy;
    // Economy never costs more than fast; if it would (different funding), there is a single option.
    if (quoted.economy && quoted.fast && quoted.economy.priced.fee >= quoted.fast.priced.fee) quoted.economy = quoted.fast;
    const tiers = {};
    for (const t of FEE_TIERS) {
      const q = quoted[t];
      if (!q) { tiers[t] = {available: false, reason: errorText(failures[t])}; continue; }
      const p = q.priced, rate = orderingRate(p);
      tiers[t] = {available: true, fee: p.fee, mode: p.mode, bucketFeerate: q.rate, orderingFeerate: p.orderingFeerate, clamped: p.clamped, standardFee: p.standardFee, loadFee: p.loadFee, waitSeconds: waitSeconds(conditions, rate), belowLow: !isIdle(conditions) && rate < conditions.low.feerate, sponsored: q.sponsored, sameAs: q === quoted.fast && t === 'economy' ? 'fast' : null};
    }
    const recommended = !tiers.economy.available ? 'fast' : !tiers.fast.available ? 'economy' : recommendTier(conditions, tiers.economy, tiers.fast);
    // Capture a search hint during planning, not a new mandatory RPC after the user has signed.
    const anchor = await selectedChainAnchor(this.pair, null, {maxAgeMs: 30000});
    const base = {
      anchors: this.pair.nodes.map(n => ({url: n.url, sink: anchor})),
      lookupStart: /^[0-9a-f]{64}$/.test(live?.lookupStart ?? '') ? live.lookupStart : anchor,
      createdAt: Date.now(), action, session, feerate, currentDaa, conditions, network: {idle: isIdle(conditions)}, tiers, recommendedTier: recommended,
      proof: proof ? {target: proof.target, parent: proof.parent, boundaryDaa: proof.boundaryDaa, nodes: proof.nodes, confirmation: proof.confirmation} : null,
      request: structuredClone(request), // display-only; never authority for transaction or signing fields
      before: live ? {phase: live.ledger.phase, sold: live.ledger.sold, purchaseCount: live.ledger.purchaseCount, cursor: live.ledger.cursor, value: live.snapshot.value} : null,
      winner: action === 'DRAW_AND_PAY' ? proof.winner : null,
      origin: null, genesisTxid: live?.row?.genesisTxid ?? live?.genesisTxid ?? null,
    };
    const materialize = tier => {
      const {priced, sponsored} = quoted[tier], draft = priced.draft;
      return {
        tier, cid: action === 'GENESIS' ? draft.transaction.outputs[0].covenant.covenantId : request.cid,
        draft, fee: priced.fee, quote: priced.quote, sponsored,
        feeMode: priced.mode, orderingFeerate: priced.orderingFeerate, standardFee: priced.standardFee, loadFee: priced.loadFee, feeClamped: priced.clamped,
        outputs: describeOutputs(draft, live, session, this.net), budget: draft.transaction.inputs[0].computeBudget,
        after: draft.transition?.next ? {phase: draft.transition.next.phase, sold: draft.transition.next.sold, purchaseCount: draft.transition.next.purchaseCount, cursor: draft.transition.next.cursor, value: draft.transaction.outputs[0].value} : null,
        terminal: draft.transition?.terminal ?? null,
        origin: action === 'GENESIS' ? draft.inputUtxos[0].outpoint : live.snapshot.origin,
        nextLedger: action === 'GENESIS' ? hex(S.encodeLedger(S.newOpen(session.key, request.config))) : draft.transition.next ? hex(S.encodeLedger(draft.transition.next)) : null,
        nextValue: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].value : null, nextSpk: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].scriptPublicKey : null,
      };
    };
    const wanted = request.tier && tiers[request.tier]?.available ? request.tier : recommended;
    const plan = {id: planId(), ...base, ...materialize(wanted)};
    ensure(!this.disposed && planEpoch === this.planEpoch, '页面离开前台或核验会话已变化，请重新报价', 'PLAN_CONTEXT_CHANGED');
    this.tierBuilds.set(plan.id, materialize);
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Switch a quoted plan to the other fee tier. Returns a NEW plan (new id, same quote time and live state); the old
   * plan is invalidated, so an approval can only ever apply to the exact fee and outputs on screen. */
  chooseTier(plan, tier) {
    ensure(this.plans.get(plan.id) === plan, '交易计划已失效，请重新报价');
    ensure(FEE_TIERS.includes(tier) && plan.tiers?.[tier]?.available, '这一档手续费不可用');
    if (plan.tier === tier) return plan;
    const materialize = this.tierBuilds.get(plan.id);
    ensure(materialize, '交易计划已失效，请重新报价');
    const next = {...plan, ...materialize(tier), id: planId()};
    this.plans.delete(plan.id); this.tierBuilds.delete(plan.id);
    this.plans.set(next.id, next); this.tierBuilds.set(next.id, materialize);
    return next;
  }

  /** Fee bump (RBF) of this browser's own transaction that is still in the node mempool. Rebuilds the SAME transition on
   * the SAME inputs (the round state input plus the same wallet inputs), so the original and the replacement conflict
   * and at most one can ever be accepted. Only the fee changes; the builders take it from where they always do (wallet
   * change, the REFUND executor share, or the DRAW_AND_PAY prize via the bound fee witness). The node accepts the
   * replacement only if the original is still in its mempool and the new ordering feerate is strictly higher
   * (rusty-kaspa v2.1.0 RbfPolicy::Mandatory). Signing and submission go through the normal execute() path. */
  async planReplacement(txid, session, {feeMode = 'load'} = {}) {
    const planEpoch = this.planEpoch;
    ensure(!this.disposed, '页面运行会话已变化，请重新开始');
    requireTradingRelease(this.net);
    requireRuntimeProfile(this.profile);
    const store = await this.store(), cur = await store.get(this.prefix + hash32(txid));
    ensure(cur, '本浏览器没有这笔交易的记录');
    const old = cur.value;
    ensure(['SUBMITTED', 'PENDING', 'UNKNOWN'].includes(old.status) && !old.replacedBy, '只有尚未确认、且未被替换过的本机交易才能加速');
    ensure(old.session?.key === session.key && old.session?.address === session.address, '请连接提交这笔交易时使用的钱包账户');
    this.onStatus(`检查 ${this.net.label} 节点连接与当前链状态…`);
    await this.pair.connect();
    const currentDaa = await this.pair.currentDaa(), feerate = await this.pair.feerate();
    this.onStatus('确认原交易仍在节点内存池中…');
    const entry = await mempoolEntry(this.pair, txid);
    ensure(entry, '原交易已不在节点内存池中（可能已被接受、已被替换或已被挤出）：请先核对结果，不能替换', 'NOT_IN_MEMPOOL');
    ensure(entry.fee === old.fee, '节点内存池中的原交易费用与本机记录不符，已拒绝替换');
    // Inputs must still be live: the original is only in the mempool, so they are unspent in the UTXO set.
    await verifyInputsLive(this.pair, old.draft.inputUtxos);
    await checkDraftDraw(this.pair, old.draft, this.profile, old.origin);
    const d0 = old.draft, t0 = d0.transaction;
    let make, spent = null, budget = t0.inputs[0].computeBudget;
    if (old.action === 'GENESIS') {
      const s = S.decodeLedger(unhex(old.nextLedger));
      // Keep the original registration output (default or user-chosen address) byte-for-byte in the replacement.
      const reg = genesisRegistrySpk(t0, '20' + s.ownerKey + 'ac');
      make = OperationEngine.builder({profile: this.profile, ownerKey: session.key, config: s.config, funds: d0.inputUtxos, registrySpk: reg});
    } else {
      const in0 = d0.inputUtxos[0], w = decodeSpend(t0.inputs[0].signatureScript, this.profile, old.origin);
      const snapshot = {ledger: w.ledger, tip: in0.outpoint, origin: old.origin, scriptPublicKey: in0.spk, covenantId: in0.covenantId, value: in0.value, utxoDaa: in0.daa, currentDaa};
      spent = S.verifySnapshot(snapshot, this.profile);
      const op = {action: old.action, actorKey: session.key};
      if (old.action === 'BUY') op.quantity = d0.transition.next.sold - spent.sold;
      // The PASS-A opening is the first 240 bytes of the original witness data (protocol.js DRAW_AND_PAY: data = opening‖…);
      // the target recorded at planning time must match it, and the builder re-authenticates it.
      if (old.action === 'DRAW_AND_PAY') {
        ensure(old.proof?.target?.hash && w.data.length >= 240, '原开奖交易缺少随机证明，无法替换');
        op.opening = w.data.slice(0, 240); op.accessor = {blockHash: old.proof.target.hash, sequenceCommitment: old.proof.target.seqCommit};
      }
      make = OperationEngine.builder({profile: this.profile, snapshot, operation: op, funds: d0.inputUtxos.slice(1), computeBudget: budget});
    }
    // Strictly higher ordering feerate than the original: old fee / old mass < new fee / new mass. Same inputs and
    // output count give (almost) the same mass, so require new fee >= floor(old fee x new mass / old mass) + 1, plus
    // a 10% step so repeated bumps make visible progress under a moving estimate.
    const q0 = quoteMass(d0), m0 = [q0.computeMass, q0.normalizedTransient, q0.storageMass].reduce((a, b) => a > b ? a : b);
    const step = old.fee + old.fee / 10n + 1n;
    let priced = convergeFee(make, feerate, {mode: feeMode, minFee: step, cap: this.net.maxFeePerTx});
    const m1 = priced.orderingMass, strict = old.fee * m1 / m0 + 1n;
    if (priced.fee < strict) priced = convergeFee(make, feerate, {mode: feeMode, minFee: strict > step ? strict : step, cap: this.net.maxFeePerTx});
    ensure(priced.fee * m0 > old.fee * priced.orderingMass, '替换交易的费率没有严格高于原交易');
    const draft = priced.draft;
    draft.txid = referenceTxId(draft.transaction);
    ensure(draft.txid !== txid, '替换交易与原交易相同');
    ensure(stable(draft.inputUtxos.map(u => u.outpoint)) === stable(d0.inputUtxos.map(u => u.outpoint)), '替换交易必须花费完全相同的输入');
    if (old.action !== 'GENESIS') ensure(stable(draft.transition.next ?? null) === stable(d0.transition.next ?? null) && draft.transition.terminal === d0.transition.terminal, '替换交易的状态变化与原交易不一致');
    const plan = {
      anchors: old.anchors,
      id: planId(), createdAt: Date.now(), action: old.action, cid: old.cid, session, draft, fee: priced.fee, quote: priced.quote, feerate, currentDaa, sponsored: old.sponsored ?? false,
      feeMode: priced.mode, orderingFeerate: priced.orderingFeerate, standardFee: priced.standardFee, loadFee: priced.loadFee, feeClamped: priced.clamped,
      proof: old.proof ?? null, outputs: describeOutputs(draft, null, session, this.net), budget: draft.transaction.inputs[0].computeBudget,
      before: spent ? {phase: spent.phase, sold: spent.sold, purchaseCount: spent.purchaseCount, cursor: spent.cursor, value: d0.inputUtxos[0].value} : null,
      after: draft.transition?.next ? {phase: draft.transition.next.phase, sold: draft.transition.next.sold, purchaseCount: draft.transition.next.purchaseCount, cursor: draft.transition.next.cursor, value: draft.transaction.outputs[0].value} : null,
      terminal: draft.transition?.terminal ?? null, winner: old.winner ?? null,
      origin: old.origin, genesisTxid: old.action === 'GENESIS' ? draft.txid : old.genesisTxid,
      nextLedger: old.nextLedger, nextValue: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].value : null, nextSpk: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].scriptPublicKey : null,
      replaces: txid, replaceRoot: old.replaceRoot ?? txid, previousFee: old.fee, previousOrderingFeerate: old.orderingFeerate ?? null, replaceVia: 'replacement',
    };
    if (old.action === 'GENESIS') { plan.cid = draft.transaction.outputs[0].covenant.covenantId; ensure(plan.cid === old.cid, '替换创建交易的 Covenant ID 与原交易不一致'); }
    ensure(!this.disposed && planEpoch === this.planEpoch, '页面离开前台或核验会话已变化，请重新报价', 'PLAN_CONTEXT_CHANGED');
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Sign, retain the session record (+ optional durable copy), submit once. */
  async execute(plan, {approved, onProgress = () => {}, onPhase = () => {}} = {}) {
    const startedAt = Date.now(), phaseMs = {};
    let previousPhase = 'PREPARING', phaseAt = startedAt;
    const phase = value => {
      const at = Date.now();
      if (value !== previousPhase) { phaseMs[previousPhase] = (phaseMs[previousPhase] ?? 0) + Math.max(0, at - phaseAt); previousPhase = value; phaseAt = at; }
      try { onPhase(value); } catch {}
    };
    ensure(!this.disposed, '页面运行会话已变化，请重新开始');
    requireTradingRelease(this.net);
    requireRuntimeProfile(this.profile);
    ensure(approved === true, '尚未勾选批准');
    ensure(this.plans.get(plan.id) === plan, '交易计划已失效，请重新报价');
    this.plans.delete(plan.id); this.tierBuilds.delete(plan.id);
    ensure(Date.now() - plan.createdAt < PLAN_TTL_MS, '报价已超过 90 秒，请重新报价（链上状态与费率可能已变化）');
    ensure(this.locks, '浏览器不支持 Web Locks，无法防止多标签页重复提交');
    return this.locks.request(this.submitLock, {ifAvailable: true}, async lock => {
      ensure(lock, '另一个标签页正在提交交易，请稍后在交易记录中对账');
      const store = await this.store(), k = this.prefix + plan.draft.txid;
      ensure(typeof store.insertIfAbsentWithCheck === 'function', '记录库不支持原子输入占用，不能提交', 'ATOMIC_INTENT_STORE_REQUIRED');
      await lock.assertHeld?.();
      ensure(!(await store.get(k)), '这笔交易已有本地记录，只能对账，不能重复提交');
      const replacesKey = plan.replaces ? this.prefix + hash32(plan.replaces) : null;
      const reserved = this.reserveInputs ? await reservedInputs(store, this.net.genesis, replacesKey) : new Set();
      ensure(!plan.draft.inputUtxos.some(f => reserved.has(key(f.outpoint))), '输入已被另一笔未对账的本地提交占用');
      const approvedTx = structuredClone(plan.draft.transaction), approvedInputs = stable(plan.draft.inputUtxos);
      let sigs;
      const prepared = await OperationEngine.prepare({
        check: async () => { ensure(!this.disposed, '页面运行会话已变化，本次操作已停止', 'READ_VIEW_CHANGED'); requireTradingRelease(this.net); await lock.assertHeld?.(); },
        beforeSign: async () => {
          await checkDraftDraw(this.pair, plan.draft, this.profile, plan.origin);
          onProgress(plan.draft.authorizedInputIndices.length ? '请在 KasWare 中核对并签名（手机端请查看后台标签页或菜单底部的 KasWare）…' : '此动作无需钱包签名（无外部资金输入）…');
        },
        sign: async () => {
          phase('SIGNING');
          sigs = await signWithWallet(plan.draft, plan.session, {net: this.net, onWaiting: s => onProgress(s || '等待 KasWare 签名…')});
          const signed = structuredClone(plan.draft.transaction);
          for (const [i, sig] of sigs) signed.inputs[i].signatureScript = sig;
          ensure(referenceTxId(signed) === plan.draft.txid, '签名后交易 ID 变化，已拒绝');
          return signed;
        },
        afterSign: tx => {
          phase('VERIFYING');
          const normalized = structuredClone(tx);
          for (const i of plan.draft.authorizedInputIndices) normalized.inputs[i].signatureScript = approvedTx.inputs[i].signatureScript;
          ensure(signedWire(normalized) === signedWire(approvedTx) && stable(plan.draft.inputUtxos) === approvedInputs,
            '签名期间批准的交易字段或输入材料被改变', 'SIGNED_FIELDS_CHANGED');
          phase('PERSISTING');
        },
        makeRecord: async tx => {
          const anchors = plan.anchors;
          ensure(anchors?.length && anchors.every(a => /^[0-9a-f]{64}$/.test(a.sink)), '缺少已核验的查询起点', 'ANCHOR_REQUIRED');
          return {
        contractVersion: CONTRACT_VERSION, profileId: PROFILE_ID, networkGenesis: this.net.genesis,
        txid: plan.draft.txid, action: plan.action, cid: plan.cid, createdAt: Date.now(), status: 'SUBMITTING', accepted: false,
        fee: plan.fee, quote: plan.quote, budget: plan.budget, session: {address: plan.session.address, key: plan.session.key},
        inputs: plan.draft.inputUtxos.map(f => f.outpoint), draft: plan.draft, signed: tx, signedWire: signedWire(tx), anchors, cursors: Object.fromEntries(anchors.map(a => [a.url, a.sink])),
        outputs: plan.outputs, terminal: plan.terminal, winner: plan.winner, proof: plan.proof, orderingFeerate: plan.orderingFeerate ?? null, feeTier: plan.tier ?? null,
        ...(plan.replaces ? {replaces: plan.replaces, replaceRoot: plan.replaceRoot, previousFee: plan.previousFee} : {}),
        origin: plan.origin, lookupStart: plan.lookupStart ?? plan.anchors?.[0]?.sink ?? null,
        genesisTxid: plan.action === 'GENESIS' ? plan.draft.txid : plan.genesisTxid, nextLedger: plan.nextLedger, nextValue: plan.nextValue, nextSpk: plan.nextSpk, walletEchoDiffers: sigs.echoDiffers === true,
          };
        },
        persistence: new CasIntentStore(store, {durability: 'optional', reserveInputs: this.reserveInputs}),
        context: {networkGenesis: this.net.genesis, key: k, lease: lock.lease, replacesKey},
      });
      let {record, stored} = prepared;
      record = {...record, storage: store.persistent ? 'persistent' : 'session'};
      const tx = record.signed;
      // Register before transport; a selected-chain notification may beat the submit response. Only buffer a location.
      phase('SUBSCRIBING');
      await this.trackAcceptance(record.txid);
      phase('SUBMITTING');
      onProgress('正在提交已批准的交易…');
      let transportStartedAt = null, transportFinishedAt = null;
      try {
        await lock.assertHeld?.(); // failure preserves the session intent as UNKNOWN, never silently releases
        // Fee bump of a transaction still in the node mempool: RbfPolicy::Mandatory (exactly one conflicting mempool tx,
        // strictly higher feerate). Otherwise the ordinary submit (RbfPolicy::Forbidden). rusty-kaspa v2.1.0 flow_context.rs.
        const viaReplacement = plan.replaceVia === 'replacement';
        const observation = await checkDraftDraw(this.pair, {...plan.draft, transaction: tx}, this.profile, plan.origin);
        await lock.assertHeld?.();
        const beforeSend = () => { if (this.disposed) throw failure('READ_VIEW_CHANGED'); fenceDraw(observation, this.pair); };
        beforeSend(); // fresh connection-bound check directly before the actual send
        transportStartedAt = Date.now();
        const res = viaReplacement
          ? await this.pair.nodes[0].call('submitTransactionReplacement', {transaction: txToRpc(tx)}, undefined, {beforeSend})
          : await this.pair.nodes[0].call('submitTransaction', {transaction: txToRpc(tx), allowOrphan: false}, undefined, {beforeSend});
        transportFinishedAt = Date.now();
        ensure(res?.transactionId === plan.draft.txid, `节点返回的交易 ID 不一致：${res?.transactionId}`);
        let replacedTxid = null;
        if (viaReplacement) { try { replacedTxid = referenceTxId(txFromRpc(res.replacedTransaction)); } catch {} }
        record = {...record, status: 'SUBMITTED', submittedAt: Date.now(), submittedTo: this.pair.nodes[0].url,
          ...(viaReplacement ? {replacedInMempool: replacedTxid} : {})};
      } catch (e) {
        if (transportStartedAt !== null) transportFinishedAt = Date.now();
        const outcome = classifyInitialWebSubmit(e, plan.draft.txid);
        record = {...record, status: outcome.result === 'REJECTED' ? 'REJECTED' : 'UNKNOWN', error: errorText(e),
          ...(outcome.result === 'REJECTED' ? {rejection: {kind: outcome.kind, at: Date.now()}} : {})};
      }
      phase('RESULT');
      record = {...record, executionTimings: {schema: 'KASWIN_EXECUTION_TIMING_1', startedAt, finishedAt: phaseAt,
        elapsedMs: Math.max(0, phaseAt - startedAt), phaseMs: {...phaseMs}}};
      if (transportStartedAt !== null) record = {...record, transport: {startedAt: transportStartedAt, finishedAt: transportFinishedAt,
        elapsedMs: transportFinishedAt - transportStartedAt}};
      try { stored = await store.compareAndSet(k, stored.revision, record); } catch (e) { record = {...record, persistenceError: errorText(e)}; }
      // The replaced record stays open (it can still be accepted until a sibling is); it only gains a pointer.
      if (replacesKey && record.status === 'SUBMITTED') {
        for (let i = 0; i < 4; i++) {
          const cur = await store.get(replacesKey);
          if (!cur || ['ACCEPTED', 'CONFIRMING'].includes(cur.value.status)) break;
          try { await store.compareAndSet(replacesKey, cur.revision, {...cur.value, status: 'REPLACED', replacedBy: plan.draft.txid, replacedAt: Date.now()}); break; } catch {}
        }
      }
      if (!FOLLOWING.has(record.status)) this.releaseAcceptance(record.txid);
      return record;
    });
  }

  /** Repair only the search LOCATION, then run the same full node reconciliation. Never resubmits. */
  async reconcile(txid, onProgress = () => {}) {
    hash32(txid);
    return sharedRead(this.reconciles, txid, async () => {
      if (this.disposed) throw failure('ACCEPTANCE_TRACKER_STOPPED');
      const result = await this.#reconcile(txid, onProgress);
      if (!FOLLOWING.has(result.status)) this.releaseAcceptance(txid);
      return result;
    });
  }
  async #reconcile(txid, onProgress) {
    requireRuntimeProfile(this.profile);
    const store = await this.store(), k = this.prefix + hash32(txid);
    let cur = await store.get(k);
    ensure(cur, '本浏览器没有这笔交易的记录');
    if (cur.value.status === 'ARCHIVED') return cur.value;
    await this.trackAcceptance(txid);
    // A sticky witness is retained for re-testing, but the latest lookup slot belongs to this node check only.
    if (cur.value.restCheck) cur = await store.compareAndSet(k, cur.revision, {...cur.value, restCheck: null});
    try {
      const [rpc] = await this.pair.connect();
      let r = cur.value;
      // Retired endpoint cursors are merely hints, checked below and again by searchAccepted().
      const legacy = r.cursors?.[rpc.url] ? null : this.legacyUrls.map(u => r.cursors?.[u]).find(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h));
      if (legacy) { cur = await store.compareAndSet(k, cur.revision, {...r, cursors: {...r.cursors, [rpc.url]: legacy}}); r = cur.value; }
      const cursor = r.cursors?.[rpc.url] ?? r.anchors?.find(a => a.url === rpc.url)?.sink ?? r.anchors?.[0]?.sink;
      const shared = this.evidence.peek(txid);
      const hash = shared ? null : r.accepting ?? cursor;
      shared?.scope.close();
      if (hash && (r.accepting || !this.acceptance.peek(txid))) {
        const b = (await rpc.call('getBlock', {hash, includeTransactions: false})).block;
        ensure(b?.header?.hash === hash, '节点返回的区块哈希不符');
        if (b.verboseData?.isChainBlock === false) {
          onProgress('查询起点已离开选中链，正在寻找仍在链上的祖先…');
          const ancestor = await chainAncestor(rpc, b);
          if (ancestor) await store.compareAndSet(k, cur.revision, {...r, accepting: undefined,
            previousAccepting: r.accepting ?? r.previousAccepting, ...(r.accepting ? {displacedAt: Date.now(), displacedFrom: r.accepting} : {}),
            cursors: {...r.cursors, [rpc.url]: ancestor}, cursorRepairAt: Date.now()});
        }
      }
    } catch (err) {
      if (err?.message === 'STALE_CACHE_REVISION') throw err;
      // Pruning, offline nodes and exhausted walks are neither acceptance nor permission to release.
    }
    const result = await this.#reconcileNode(txid, onProgress);
    if (!this.restQuery || !wantsRest(result)) return result;
    return this.restBackup(k, result, onProgress);
  }

  /** Re-check acceptance and every approved field on the configured node. Internal: caller repairs cursors first. */
  async #reconcileNode(txid, onProgress) {
    const store = await this.store(), k = this.prefix + hash32(txid);
    let stored = await store.get(k); ensure(stored, '本浏览器没有这笔交易的记录');
    // Lost verdicts (CONFLICTED / DRIFTED) stay until the node proves acceptance again; never downgraded to UNKNOWN.
    const prev = stored.value.status, previousAccepting = stored.value.accepting;
    const sticky = ['REJECTED', 'REPLACED', 'SUPERSEDED', 'CONFLICTED', 'DRIFTED'].includes(prev) ? prev : null;
    let r = {...stored.value, status: sticky ?? 'RECHECKING', accepted: false, checkedAt: Date.now()};
    stored = await store.compareAndSet(k, stored.revision, r);
    let notice = null, verified = null, readScope = null;
    try {
      await this.pair.connect();
      const searchContext = queryContext(this.pair);
      this.evidence.suppressKnown(txid, r.accepting); // old/depth receipts must not rewind a newer detail view after reload
      const shared = this.evidence.peek(txid);
      notice = r.accepting || shared ? null : this.acceptance.peek(txid);
      const located = shared?.ev.accepting ?? r.accepting ?? notice?.accepting;
      shared?.scope.close();
      onProgress(located ? '已取得接受位置，正在核对本笔交易…' : '在选中链上查找接受记录…');
      const found = located ? [located] : []; let complete = true;
      for (const n of located ? [] : this.pair.nodes) {
        // Resume from this node's saved cursor; after switching nodes fall back to any submit-time anchor (a sink hash
        // that stays a selected-chain block on every synced node unless it was reorged out).
        const cursor = r.cursors?.[n.url] ?? r.anchors?.find(a => a.url === n.url)?.sink ?? r.anchors?.[0]?.sink;
        ensure(cursor, '缺少对账起点');
        const hit = await searchAccepted(n, txid, cursor);
        r.cursors = {...r.cursors, [n.url]: hit.cursor};
        this.pair.rememberChainAnchor?.(hit.cursor);
        if (hit.complete === false) complete = false;
        found.push(hit.accepting);
      }
      const late = this.evidence.peek(txid), accepting = found[0] ?? late?.ev.accepting;
      late?.scope.close();
      if (!accepting) {
        let entry = null; try { entry = await mempoolEntry(this.pair, txid); } catch {}
        if (!sameQueryContext(searchContext, queryContext(this.pair)) || this.acceptance.peek(txid) || this.evidence.has(txid)) throw failure('READ_VIEW_CHANGED');
        // searchComplete: the bounded search reached the selected-chain tip. Only then may the tracker diagnose absence.
        r = {...r, status: sticky ?? (entry ? 'PENDING' : 'UNKNOWN'), mempool: {present: !!entry, fee: entry?.fee ?? null, checkedAt: Date.now()}, searchComplete: complete,
          note: entry ? '交易在节点内存池中，等待被打包接受（在内存池中不等于已接受）' : '本次有界查询没有在选中链上找到，节点内存池中也没有（可能已被替换、被挤出、尚未传播或被短程重组撤销）；不代表失败。页面继续跟踪，只会按原签名字节重发'};
      } else {
        readScope?.close();
        const cached = this.evidence.peek(txid, {accepting});
        const settledProof = cached && acceptanceDepth(cached.virtualDaa, cached.ev.acceptingDaa) >= this.reorgRecheckDaa;
        cached?.scope.close();
        const observed = await this.evidence.read(txid, accepting, {origin: this.evidenceOwner,
          fresh: ['CONFIRMING', 'ACCEPTED'].includes(prev) && !settledProof});
        readScope = observed.scope;
        const {ev, virtualDaa} = observed;
        readScope.check(accepting);
        if (this.disposed || (notice && (!this.acceptance.current(txid, notice) || !sameConnectionContext(notice.context, observed.context)))) throw failure('READ_VIEW_CHANGED');
        const fee = matchesDraft(ev, r.draft);
        verified = observed;
        r = {...r, ...acceptanceStep(r, ev, virtualDaa, this.reorgRecheckDaa), accepting, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations, actualFee: fee, computeMass: ev.computeMass, storageMass: ev.tx.storageMass, verifiedAt: Date.now(),
          inputDaaDrift: inputDaaDrift(ev, r.draft), searchComplete: true, guard: r.guard ? {...r.guard, last: null, lastDiag: null} : r.guard};
      }
    } catch (e) {
      if (notice) this.acceptance.discard(txid, notice);
      verified = null;
      // A previously verified acceptance that is no longer on the selected chain was DISPLACED by a reorg (not rejected).
      const displaced = !!r.accepting && ['NOT_CHAIN', 'NOT_ACCEPTED', 'REORG'].includes(e?.code);
      r = {...r, status: sticky ?? 'UNKNOWN', accepted: false, error: errorText(e), searchComplete: false,
        // Clear the stale location so the next check repairs the off-chain cursor and searches again.
        ...(displaced ? {displacedAt: Date.now(), displacedFrom: r.accepting, previousAccepting: r.accepting, accepting: undefined, acceptingDaa: undefined, depthDaa: undefined} : {}),
        note: displaced ? '先前的接受块已离开选中链（短程重组）；保留输入占用，页面重新查找；若交易消失且输入仍未花费，只按原签名字节重发' : '本次核验未完成；保留输入占用，不改变交易内容'};
    }
    try {
      if (this.disposed) throw failure('ACCEPTANCE_TRACKER_STOPPED');
      const revoke = () => {
        verified = null;
        r = {...r, status: sticky ?? 'UNKNOWN', accepted: false, searchComplete: false, error: 'READ_VIEW_CHANGED',
          previousAccepting: r.accepting, accepting: undefined, acceptingDaa: undefined, depthDaa: undefined,
          note: '接受观察已失效；保留输入占用，重新核对'};
      };
      const current = () => !this.disposed && readScope.current(r.accepting) &&
        sameConnectionContext(readScope.context, queryContext(this.pair));
      if (verified && !current()) revoke();
      const saved = await store.compareAndSet(k, stored.revision, r);
      // Keep the read scope through the asynchronous CAS; a removed A must not leave a late positive on disk.
      if (verified && !current()) { revoke(); await store.compareAndSet(k, saved.revision, r); }
      if (verified && (!['CONFIRMING', 'ACCEPTED'].includes(prev) || previousAccepting !== r.accepting)) {
        // A depth recheck proves settlement of an old transaction; it must not rewind/cancel a newer detail read.
        try { this.onAccepted({cid: r.cid, ev: structuredClone(verified.ev), context: queryContext(this.pair)}); } catch {}
      }
      return this.settleFamily(r);
    } finally { readScope?.close(); }
  }
  /** Read-only REST lookup after UNKNOWN. Never submits, archives or releases inputs. */
  async restBackup(k, result, onProgress = () => {}) {
    const store = await this.store(), current = await store.get(k), txid = result.txid;
    ensure(current && current.value.status === 'UNKNOWN' && current.value.checkedAt === result.checkedAt, 'STALE_CACHE_REVISION');
    onProgress(`节点未能查明；正在向 ${new URL(this.net.rest).host} 查询（只发送交易 ID）…`);
    let check;
    try { check = await this.restQuery(result); }
    catch (err) { check = {outcome: 'ERROR', source: this.net.rest, checkedAt: Date.now(), error: errorText(err)}; }
    let witness = result.restWitness ?? null;
    if (check.outcome === 'ACCEPTED') {
      witness = check.fields?.ok === true ? {source: this.net.rest, txid, acceptingBlockHash: check.acceptingBlockHash,
        acceptingBlueScore: check.acceptingBlueScore ?? null, fields: check.fields, observedAt: check.checkedAt} : null;
    } else if (check.outcome === 'UNCONFIRMED') witness = null;
    // NOT_FOUND/ERROR carry no new information; retain an earlier observation, not an acceptance conclusion.
    const hint = check.outcome === 'ACCEPTED' ? {acceptingBlockHash: check.acceptingBlockHash, acceptingBlueScore: check.acceptingBlueScore ?? null, from: 'REST'}
      : witness ? {acceptingBlockHash: witness.acceptingBlockHash, acceptingBlueScore: witness.acceptingBlueScore ?? null, from: 'WITNESS'} : null;
    let v = null, node = null, virtualDaa = null;
    if (hint) {
      onProgress('正在用节点核对 REST 给出的接受块…');
      try { virtualDaa = await this.pair.currentDaa(); } catch {}
      v = await verifyAtHint(this.pair, result, hint.acceptingBlockHash, hint.acceptingBlueScore, {evidence: this.evidence, origin: this.evidenceOwner});
      if (v.virtualDaa !== undefined) virtualDaa = v.virtualDaa;
      node = {result: v.result, chainBlock: v.chainBlock ?? null, pruningBlue: v.pruningBlue ?? null, error: v.error ?? null, checkedAt: Date.now()};
      if (v.result === 'CONFLICT') witness = null;
    }
    const restCheck = {...check, txid, nodeCheckedAt: result.checkedAt, nodeSearch: result.error ?? result.note ?? null, hint, node};
    let next;
    if (v?.result === 'VERIFIED' && virtualDaa !== null) {
      const {error: _stale, ...base} = result, ev = v.ev, step = acceptanceStep(base, ev, virtualDaa, this.reorgRecheckDaa);
      next = {...base, ...step, accepting: hint.acceptingBlockHash, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations,
        actualFee: v.fee, computeMass: ev.computeMass, storageMass: ev.tx.storageMass, verifiedAt: Date.now(), locatedBy: 'REST',
        note: `${step.note}（REST 仅提供接受块位置）`, restWitness: witness, restCheck};
    } else next = {...result, restWitness: witness, restCheck};
    const proofCurrent = () => !this.disposed && (!v?.scope || v.scope.current(hint.acceptingBlockHash));
    const unknown = () => ({...result, accepted: false, searchComplete: false, restWitness: witness,
      restCheck: {...restCheck, node: {...node, result: 'ERROR', error: 'READ_VIEW_CHANGED'}},
      error: 'READ_VIEW_CHANGED', note: '节点接受观察已失效；保留输入占用，重新核对'});
    try {
      if (this.disposed) throw failure('ACCEPTANCE_TRACKER_STOPPED');
      if (v?.scope && !proofCurrent()) next = unknown();
      const saved = await store.compareAndSet(k, current.revision, next);
      if (v?.scope && !proofCurrent()) { next = unknown(); await store.compareAndSet(k, saved.revision, next); }
      return next;
    } finally { v?.scope?.close(); }
  }

  /** Zero-depth follow-up of this browser's own record (option B, 2026-10-13). Always reconciles (query) first. Only when
   * a COMPLETE bounded search did not find it on the selected chain does it diagnose (tracker.mjs). Verdicts act only on
   * two identical observations >= DIAG_GAP_MS apart, except DRIFT (immediate, as in the CLI). DROPPED -> resend of the
   * IDENTICAL signed bytes (automatic inside RESEND_WINDOW_MS, otherwise only on manualResend). CONFLICT / FUNDING /
   * PARENT_LOST -> CONFLICTED; DRIFT / PROOF_INVALID -> DRIFTED (inputs released; a new draw needs a new plan and a
   * new approval, never an automatic rebuild). Everything else only records the observation. */
  async follow(txid, {manualResend = false, onProgress = () => {}} = {}) {
    hash32(txid);
    return sharedRead(this.follows, `${txid}/${manualResend}`, () => this.#follow(txid, {manualResend, onProgress}));
  }
  async #follow(txid, {manualResend, onProgress}) {
    if (this.disposed) throw failure('ACCEPTANCE_TRACKER_STOPPED');
    const stored = await (await this.store()).get(this.prefix + txid);
    if (stored?.value.status === 'REJECTED') return stored.value; // explicit manual rechecks use reconcile(), never restart automatic work
    let r = await this.reconcile(txid, onProgress);
    if (r.status === 'REPLACED') r = await this.#reviveIfReplacementRejected(r);
    // A REPLACED member is diagnosed only for a lost verdict (never a resend), and only once no other member of its
    // fee-bump family can still take effect; otherwise its reservation would outlive a DRIFTED/CONFLICTED replacement.
    const replaced = r.status === 'REPLACED' && await this.#replacedLossDecidable(r);
    if (!(TRACKED.has(r.status) || replaced) || r.searchComplete !== true || !r.signed || (r.replacedBy && !replaced) || this.acceptance.peek(txid) || this.evidence.has(txid)) return r;
    if (!manualResend && !r.displacedAt && Date.now() - (r.lastResendAt ?? r.submittedAt ?? r.createdAt ?? 0) < PENDING_GRACE_MS) return r;
    onProgress('未在选中链上找到，正在诊断（只查询）…');
    const d = await diagnose(this.pair, r, await this.records(), this.profile);
    const store = await this.store(), k = this.prefix + hash32(txid);
    let cur = await store.get(k);
    // Bind to exactly this reconcile result: another tab or a newer check wins.
    if (this.disposed || this.acceptance.peek(txid) || this.evidence.has(txid)) return cur?.value ?? r;
    if (!cur || cur.value.checkedAt !== r.checkedAt || !(TRACKED.has(cur.value.status) || (replaced && cur.value.status === 'REPLACED'))) return cur?.value ?? r;
    const now = Date.now(), g = cur.value.guard ?? {}, streak = g.last === d.verdict ? g.since ?? now : now;
    const confirmed = d.verdict === 'DRIFT' || (g.last === d.verdict && now - streak >= DIAG_GAP_MS);
    const guard = {last: d.verdict, since: streak, at: now, ...(d.error ? {error: d.error} : {})};
    const lose = (status, reason) => ({...cur.value, status, accepted: false, guard, lostAt: now, lostReason: reason, note: VERDICT_TEXT[reason] ?? reason});
    let next = {...cur.value, guard, note: replaced ? cur.value.note : VERDICT_TEXT[d.verdict] ?? cur.value.note};
    if (confirmed && ['CONFLICT', 'FUNDING_CONFLICT', 'PARENT_LOST'].includes(d.verdict)) next = lose('CONFLICTED', d.verdict);
    else if (confirmed && ['DRIFT', 'PROOF_INVALID'].includes(d.verdict)) next = lose('DRIFTED', d.verdict);
    await store.compareAndSet(k, cur.revision, next);
    if (replaced || d.verdict !== 'DROPPED' || !(confirmed || manualResend)) return next;
    if (typeof next.signedWire !== 'string') return {...next, resendAvailable: false, note: '旧记录缺少原签名字节承诺，仅允许查询，不自动重发'};
    if (!manualResend && !inResendWindow(next, now)) return {...next, resendAvailable: true};
    if ((next.resends ?? 0) >= RESEND_LIMIT) return {...next, resendAvailable: false};
    onProgress('交易已从网络消失且输入仍未花费：按原签名字节重发…');
    return this.resend(txid);
  }
  /** True when a REPLACED record may get its own lost verdict: same-input family members exist, none is on the
   * selected chain, and every member that was not itself replaced is already lost (DRIFTED / CONFLICTED).
   * A REJECTED replacement revives its original instead (below). ARCHIVED and SUPERSEDED do not count: an archived
   * member may still have been accepted. */
  async #replacedLossDecidable(r) {
    const rows = await (await this.store()).list(this.prefix), keys = familyKeys(rows, this.prefix + hash32(r.txid));
    const others = rows.filter(x => keys.has(x.key)).map(x => x.record.value).filter(v => v.txid !== r.txid);
    const lost = v => ['DRIFTED', 'CONFLICTED'].includes(v.status);
    return others.some(lost) && others.every(v => v.status === 'REPLACED' || lost(v));
  }
  /** The node definitively REJECTED this record's direct replacement (two resend rejections in a row), so it never took
   * the original's place. The original returns to normal tracking: it may be diagnosed, resent with its identical signed
   * bytes and bumped again. Every member spends the same inputs, and each resend re-checks they are live and absent from
   * the mempool, so at most one member can still take effect. A bump chain is linear (only an unreplaced record can be
   * bumped), so reviving the direct parent of the rejected member is enough. */
  async #reviveIfReplacementRejected(r) {
    if (r.status !== 'REPLACED' || !r.replacedBy) return r;
    const store = await this.store(), rep = await store.get(this.prefix + hash32(r.replacedBy));
    if (rep?.value.status !== 'REJECTED') return r;
    const k = this.prefix + hash32(r.txid), cur = await store.get(k);
    if (!cur || cur.value.status !== 'REPLACED' || cur.value.replacedBy !== r.replacedBy) return cur?.value ?? r;
    const {replacedBy, replacedAt, ...rest} = cur.value;
    const next = {...rest, status: 'UNKNOWN', revivedFrom: replacedBy, revivedAt: Date.now(),
      note: `替换交易 ${replacedBy.slice(0, 12)}… 已被节点明确拒绝，恢复跟踪原交易`};
    try { return (await store.compareAndSet(k, cur.revision, next)).value; } catch { return (await store.get(k))?.value ?? r; }
  }
  /** The ONLY send outside execute(): the identical persisted signed bytes, under the submit lock, after fresh checks
   * (all inputs live with unchanged covenant/value/script, absent from the mempool, fresh 100 blue-score draw target),
   * with the attempt recorded before transport (session memory plus optional durable copy). Never rebuilds or signs. */
  async resend(txid) {
    requireTradingRelease(this.net);
    requireRuntimeProfile(this.profile);
    return this.locks.request(this.submitLock, {ifAvailable: true}, async lock => {
      const store = await this.store(), k = this.prefix + hash32(txid);
      let cur = await store.get(k);
      if (!lock) return cur?.value;
      ensure(cur && TRACKED.has(cur.value.status) && !cur.value.replacedBy && cur.value.signed, '这条记录当前不能重发', 'RESEND_SCOPE');
      const v = cur.value;
      assertSignedRecord(v, v.signedWire);
      // Old persisted records have no wire commitment. Do not infer original signature bytes from v1 txid.
      ensure(typeof v.signedWire === 'string', '旧记录缺少原签名字节承诺，仅允许查询，不自动重发', 'RESEND_WIRE_REQUIRED');
      ensure((v.resends ?? 0) < RESEND_LIMIT, '重发次数已达上限', 'RESEND_LIMIT');
      await lock.assertHeld?.();
      const st = await inputsState(this.pair, v.draft.inputUtxos);
      const same = st.every((x, i) => { const f = v.draft.inputUtxos[i]; return x.live && x.utxo.value === f.value && stable(x.utxo.spk) === stable(f.spk) && (x.utxo.covenantId ?? null) === (f.covenantId ?? null); });
      if (!same || (v.action === 'DRAW_AND_PAY' && st[0].utxo.daa !== v.draft.inputUtxos[0].daa)) return v; // conditions changed: diagnose again later
      if (await mempoolEntry(this.pair, v.txid)) return v;
      await this.trackAcceptance(txid);
      const observation = await checkDraftDraw(this.pair, {...v.draft, transaction: v.signed}, this.profile, v.origin, {maxAgeMs: 0});
      const attempt = (v.resends ?? 0) + 1, at = Date.now();
      await lock.assertHeld?.();
      cur = await store.compareAndSet(k, cur.revision, {...v, resends: attempt, lastResendAt: at, resendPending: {attempt, at}}); // retain the attempt first
      await lock.assertHeld?.();
      fenceDraw(observation, this.pair);
      let out;
      try {
        const res = await this.pair.nodes[0].call('submitTransaction', {transaction: txToRpc(v.signed), allowOrphan: false}, undefined, {beforeSend: () => { if (this.disposed) throw failure('READ_VIEW_CHANGED'); assertSignedRecord(v, v.signedWire); fenceDraw(observation, this.pair); }});
        out = classifySubmitResponse(res, v.txid);
      } catch (e) { out = classifySubmit(e, v.txid); }
      const log = [...(v.resendLog ?? []).slice(-9), {attempt, at, result: out.result, ...(out.message ? {message: out.message} : {})}];
      const rejections = out.result === 'REJECTED' ? (v.resendRejections ?? 0) + 1 : 0;
      const next = {...cur.value, resendPending: null, resendLog: log, resendRejections: rejections, guard: null,
        ...(out.result === 'SENT' || out.result === 'KNOWN' ? {status: 'SUBMITTED', submittedTo: this.pair.nodes[0].url} : {}),
        // Like the CLI: a definite rejection twice in a row is final (inputs released); once is retried later.
        ...(rejections >= 2 ? {status: 'REJECTED', error: out.message} : {}),
        note: `第 ${attempt} 次按原签名字节重发：${out.result}`};
      try { return (await store.compareAndSet(k, cur.revision, next)).value; } catch { return next; }
    });
  }
  /** Milliseconds until a CONFIRMING record's accepting block should be deep enough for the recheck, at the 10 DAA/s
   * target plus a margin (scheduling only; the recheck itself measures the depth on the node). */
  recheckDelayMs(r) {
    if (r?.status !== 'CONFIRMING') return null;
    const left = this.reorgRecheckDaa - BigInt(r.depthDaa ?? 0n);
    return Number(left > 0n ? left : 0n) * 100 + 1500;
  }
  /** A fee-bump family (original + replacements) spends the same inputs, so at most one member can be accepted.
   * Once one is ACCEPTED (node-verified), the others can never take effect: mark them SUPERSEDED (inputs released,
   * since they are spent by the accepted member). Never touches a record outside the family or changes ACCEPTED. */
  async settleFamily(r) {
    const root = r.replaceRoot ?? (r.replacedBy ? r.txid : null);
    if (!root) return r;
    const store = await this.store(), family = (await store.list(this.prefix)).filter(x => { const v = x.record.value; return v.txid === root || v.replaceRoot === root; });
    const winner = family.find(x => x.record.value.status === 'ACCEPTED')?.record.value;
    if (!winner) return r;
    let self = r;
    for (const x of family) {
      const v = x.record.value;
      if (v.txid === winner.txid || ['ACCEPTED', 'CONFIRMING', 'SUPERSEDED', 'ARCHIVED'].includes(v.status)) continue;
      const next = {...v, status: 'SUPERSEDED', supersededBy: winner.txid, supersededAt: Date.now(), accepted: false,
        note: `同一组替换交易中的 ${winner.txid.slice(0, 12)}… 已被接受；这笔花费相同输入，不可能再生效`};
      try { await store.compareAndSet(x.key, x.record.revision, next); if (v.txid === r.txid) self = next; } catch {}
    }
    return self;
  }

  /** User-confirmed archive: actual outpoint absence, not generic STALE_INPUT (amount/SPK/DAA mismatch).
   * Failed queries never release inputs. CAS preserves another tab's newer status. */
  async archive(txid) {
    requireRuntimeProfile(this.profile);
    const store = await this.store(), k = this.prefix + hash32(txid), cur = await store.get(k);
    ensure(cur, '没有此记录');
    ensure(!['ACCEPTED', 'CONFIRMING', 'ARCHIVED', 'SUBMITTING'].includes(cur.value.status), '此记录当前不能归档');
    await this.pair.connect();
    let absent = false;
    if (cur.value.status !== 'REJECTED') {
      for (const u of cur.value.draft.inputUtxos) {
        const address = spkToAddress(u.spk, this.net.addressPrefix); ensure(address, '输入脚本无法转换为地址');
        const live = await commonUtxos(this.pair, address);
        if (!live.some(v => v.outpoint.transactionId === u.outpoint.transactionId && v.outpoint.index === u.outpoint.index)) absent = true;
      }
      ensure(absent, '输入仍然未花费：结果未知时不能释放，请稍后核对。');
    }
    await store.compareAndSet(k, cur.revision, {...cur.value, status: 'ARCHIVED', archivedAt: Date.now(), archiveReason: absent ? 'INPUT_NO_LONGER_LIVE' : 'DEFINITE_REJECTION'});
  }
}

export function explainUnavailable(action, live) {
  const s = live.ledger, x = live.snapshot, d = x.currentDaa;
  if (action === 'BUY') return s.phase !== 1 ? '轮次已封盘' : s.sold >= s.config.ticketCap ? '本轮已售罄（票已售完）' : '本轮已售罄（购买记录已满 256 条）';
  if (action === 'CLOSE') return s.phase !== 1 ? '轮次不在开放阶段' : `未满票也未到封盘时间（还需约 ${s.config.closeEligibleDaa - d} DAA）`;
  if (action === 'DRAW_AND_PAY') return s.phase !== 2 ? '轮次不在封存待开奖阶段' : `封存后需等待 100 DAA（还差 ${x.utxoDaa + S.DRAW_DELAY - d} DAA）`;
  if (action === 'TIMEOUT_REFUND') return s.phase !== 2 ? '仅封存阶段可超时转退款' : `封存后 432000 DAA 才可超时转退款（还差 ${x.utxoDaa + S.TIMEOUT_DELAY - d} DAA）`;
  if (action === 'REFUND') return '轮次不在退款阶段';
  return '条件不满足';
}

/** GENESIS registration = output 1 when it is the builder's fixed-value ordinary output (any address). Change always goes to
 * the owner's P2PK and comes last, so an owner-address registration is recognized only when a change output follows it. */
export function genesisRegistrySpk(tx, ownerScript) {
  const o = tx.outputs[1];
  if (!o || o.covenant || o.value !== REGISTRATION_SOMPI) return null;
  return o.scriptPublicKey.script !== ownerScript || tx.outputs.length > 2 ? {version: o.scriptPublicKey.version, script: o.scriptPublicKey.script} : null;
}
/** Human-readable outputs with roles. */
export function describeOutputs(draft, live, session, net) {
  requireNet(net);
  const t = draft.transaction, roles = [];
  if (draft.transition?.next) roles.push('STATE');
  if (!draft.transition) { roles.push('STATE'); if (genesisRegistrySpk(t, session.spk.script)) roles.push('REGISTRY'); }
  for (const pmt of draft.transition?.payments ?? []) roles.push(pmt.role);
  while (roles.length < t.outputs.length) roles.push('CHANGE');
  return t.outputs.map((o, i) => {
    const addr = spkToAddress(o.scriptPublicKey, net.addressPrefix), mine = o.scriptPublicKey.script === session.spk.script;
    return {index: i, value: o.value, role: roles[i], label: ROLE_LABEL[roles[i]] ?? roles[i], address: addr, covenant: o.covenant?.covenantId ?? null, mine};
  });
}
export const roleLabel = r => ROLE_LABEL[r] ?? r;
