/** Kaswin V2 operation engine: GENESIS / BUY / CLOSE / DRAW_AND_PAY / TIMEOUT_REFUND / REFUND.
 * plan():   live snapshot from the configured node -> core builder -> consensus mass -> fee fixed point -> frozen plan.
 * execute(): user approval -> recheck session + inputs on the node -> wallet signs ordinary inputs only ->
 *            signatures verified -> intent persisted in IndexedDB -> ONE submit -> record outcome.
 * reconcile(): acceptance + exact approved economic/consensus fields and covenant witness.
 */
import {S, ensure, hash32, hex, unhex, buildAction, buildOpenGenesis, availableActions, actionBudget, referenceTxId, stable, kas, errorText,
  DEFAULT_REGISTRY_SPK, REGISTRATION_SOMPI, PROFILE_ID, NETWORK_GENESIS, IndexedStore, UserError} from './core.mjs';
import {convergeFee, quoteMass, MassLimitError} from './mass.mjs';
import {FEE_TIERS, isIdle, waitSeconds, recommendTier, orderingRate} from './feetiers.mjs';
import {decodeSpend} from '../../../../packages/f3.2-core/lib/accepted.js';
import {commonUtxos, verifyInputsLive, acceptedPair, searchAccepted, mempoolEntry, matchesDraft, REORG_RECHECK_DAA, acceptanceDepth} from './chain.mjs';
import {signWithWallet} from './wallet.mjs';
import {txToRpc, txFromRpc} from './nodes.mjs';
import {spkToAddress} from './lib/address.mjs';
import {acquireDrawProof} from './passa.mjs';
import {liveRound} from './rounds.mjs';
import {reservedInputs, persistIntent} from './reservations.mjs';
import {requireTradingRelease} from './release-safety.mjs';

export const STORE = 'kaswin-opus-f32';
const PREFIX = `${NETWORK_GENESIS}/${PROFILE_ID}/tx/`;
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
/** A renewable HTTP/LAN lease is advisory. The atomic input-reserving journal insert
 * is the durable side-effect guard, even after tab suspension or an expired lease. */
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
  constructor({pair, profile, indexer, onStatus = () => {}, onLive = () => {}, openStore = () => IndexedStore.open(STORE), locks = null, drawProof = acquireDrawProof, reorgRecheckDaa = REORG_RECHECK_DAA}) {
    if (typeof reorgRecheckDaa !== 'bigint' || reorgRecheckDaa < 0n) throw Error('REORG_RECHECK_DAA');
    Object.assign(this, {pair, profile, indexer, onStatus, onLive, openStore, drawProof, reorgRecheckDaa}); this.plans = new Map(); this.tierBuilds = new Map(); this.storeP = null;
    this.locks = locks ?? globalThis.navigator?.locks ?? leaseLocks(() => this.store());
  }
  store() { return this.storeP ??= this.openStore(); }
  async records() { const s = await this.store(); return (await s.list(PREFIX)).map(r => r.record.value).sort((a, b) => b.createdAt - a.createdAt); }
  /** Release a STALE submit lease. Only the IndexedDB lease used on plain-http pages can outlive its tab; browser Web
   * Locks are released automatically when the holding tab closes. A lease younger than its TTL is never released here,
   * because the tab holding it may be about to broadcast. Duplicate broadcasts are also blocked independently: every
   * signed transaction is persisted (txid key + reserved inputs) before submission. */
  async resetLock() {
    const store = await this.store(), cur = await store.get('lock/kaswin-opus-submit');
    if (!cur?.value?.owner) return {released: false, reason: 'NO_LEASE'};
    ensure(cur.value.until <= Date.now(), `提交锁仍在有效期内（约 ${Math.ceil((cur.value.until - Date.now()) / 1000)} 秒后自动失效）。若另一个标签页正在等待钱包签名，请先在那里完成或取消。`);
    await store.compareAndSet('lock/kaswin-opus-submit', cur.revision, {owner: null, until: 0});
    return {released: true};
  }
  // Other Profiles contribute only outpoint reservations, never ledger/ABI or reconciliation context.
  async reserved() { return reservedInputs(await this.store(), NETWORK_GENESIS); }
  /** Newest locally-known ACCEPTED state of a round (lets the creator/buyer continue before the indexer catches up). */
  async localTip(cid) {
    const recs = (await this.records()).filter(r => r.cid === cid && r.status === 'ACCEPTED');
    const spent = new Set(recs.flatMap(r => r.inputs.map(key)));
    const head = recs.find(r => !spent.has(`${r.txid}:0`) && (r.nextLedger || r.terminal));
    return head ? {txid: head.txid, terminal: head.terminal, nextLedger: head.nextLedger, value: head.nextValue, spk: head.nextSpk, utxoDaa: head.acceptingDaa, accepting: head.accepting, origin: head.origin, genesisTxid: head.genesisTxid, inputs: head.inputs, at: head.verifiedAt} : null;
  }

  /** Only ordinary, non-coinbase UTXOs; coinbase spending is deliberately unsupported. */
  async funding(session) {
    const reserved = await this.reserved();
    const all = await commonUtxos(this.pair, session.address);
    return all.filter(u => !u.covenantId && !u.isCoinbase && stable(u.spk) === stable(session.spk) && !reserved.has(key(u.outpoint)))
      .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  }
  /** Greedy: largest UTXOs first, at most 8 (contract funding loop bound). */
  pick(utxos, need) {
    const out = []; let sum = 0n;
    for (const u of utxos) { if (out.length === 8) break; out.push(u); sum += u.value; if (sum >= need) return out; }
    throw new UserError(`钱包可用资金不足：需要约 ${kas(need)} TKAS（含预留手续费），最多可用 8 个 UTXO 合计 ${kas(sum)} TKAS。可先在钱包内合并 UTXO。`, 'FUNDS');
  }

  /** Build a frozen plan. request: {action, cid?, quantity?, config?, registry?, mode?} */
  async plan(request, session) {
    requireTradingRelease();
    const {action} = request;
    ensure(ACTION_LABEL[action], '未知动作');
    this.onStatus('连接 TN10 节点…');
    await this.pair.connect();
    const currentDaa = await this.pair.currentDaa();
    this.onStatus('探测网络费率与内存池…');
    const conditions = await this.pair.feeConditions(), feerate = conditions.normal.feerate;
    let live = null, op = null, proof = null, registry = null;
    if (action === 'GENESIS') {
      S.validateConfig(request.config);
      ensure(request.config.closeEligibleDaa > currentDaa + 60n, '封盘时间过近或已过：请重新选择时长');
      registry = request.registry ? DEFAULT_REGISTRY_SPK : null;
    } else {
      hash32(request.cid, 'Covenant ID');
      this.onStatus('读取轮次账本，并在节点上核对实时状态 UTXO…');
      live = await liveRound(this.pair, this.indexer, this.profile, request.cid, currentDaa, await this.localTip(request.cid));
      try { this.onLive(live, request.cid); } catch {}
      const acts = availableActions(live.snapshot, this.profile);
      ensure(acts.includes(action), `当前链上条件不允许「${ACTION_LABEL[action]}」：${explainUnavailable(action, live)}`, 'NOT_AVAILABLE');
      op = {action, actorKey: session.key};
      if (action === 'BUY') { ensure(Number.isSafeInteger(request.quantity) && request.quantity >= 1, '购买张数无效'); op.quantity = request.quantity; }
      if (action === 'DRAW_AND_PAY') {
        this.onStatus('采集并验证 PASS-A 随机证明（约 5–30 秒）…');
        proof = await this.drawProof(this.pair, this.profile, live, s => this.onStatus(s));
        op.opening = proof.opening; op.accessor = {blockHash: proof.target.hash, sequenceCommitment: proof.target.seqCommit};
      }
    }
    // Funding requirement (principal + generous fee headroom; exact fee is the fixed point below).
    const s = live?.ledger;
    const principal = action === 'GENESIS' ? S.DEPOSIT + (registry ? REGISTRATION_SOMPI : 0n) : action === 'BUY' ? BigInt(op.quantity) * s.config.ticketPrice : 0n;
    const needsFunds = action !== 'DRAW_AND_PAY' && action !== 'REFUND';
    const pool = action === 'REFUND' ? BigInt(Math.min(32, s.purchaseCount - s.cursor)) * S.REFUND_FEE : 0n;
    const reservedSet = await this.reserved();
    for (const i of live ? [live.snapshot.tip] : []) ensure(!reservedSet.has(key(i)), '本浏览器已有一笔花费此轮状态的提交尚未对账，请先在「交易记录」中对账', 'PENDING_LOCAL');
    const available = needsFunds || action === 'REFUND' ? await this.funding(session) : [];
    const make = funds => fee => action === 'GENESIS' ? buildOpenGenesis(this.profile, session.key, request.config, funds, fee, registry) : buildAction(live.snapshot, this.profile, op, fee, funds, actionBudget(action, s));
    // Two complete, independently funded quotes on the same live state (only the fee and, if needed, the funding differ):
    //  economy: the node's LOW bucket rate on max(compute, normalized transient) = the mempool admission rule
    //           (check_transaction_standard.rs). Storage mass is not paid for, so a storage-heavy transaction ranks low
    //           and may wait until the ready mempool fits a block (everything is taken then).
    //  fast:    the node's NORMAL bucket rate on the full ordering mass incl. storage (feerate_key.rs), cap-clamped.
    const priceTier = (mode, rate) => {
      let funds = needsFunds ? this.pick(available, principal + 3_000_000n) : [], priced, sponsored = false;
      for (let round = 0; ; round++) {
        try { priced = convergeFee(make(funds), rate, {mode}); break; }
        catch (e) {
          const code = e?.code ?? e?.message;
          if (action === 'REFUND' && funds.length === 0 && (code === 'REFUND_FEE_POOL' || e instanceof MassLimitError)) {
            // Executor pool (k × 0.01) too small or an all-tiny-output batch exceeds storage mass: sponsor with ONE wallet UTXO.
            const big = available.find(u => u.value >= 100_000_000n);
            ensure(big, `该批退款需要执行者赞助一笔普通输入（执行费池 ${kas(pool)} TKAS 不足或存储质量超限），但钱包没有 ≥1 TKAS 的可用 UTXO`, 'SPONSOR');
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
      try { quoted[tier] = priceTier(mode, rate); } catch (e) { failures[tier] = e; }
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
    const base = {
      createdAt: Date.now(), action, session, feerate, currentDaa, conditions, network: {idle: isIdle(conditions)}, tiers, recommendedTier: recommended,
      proof: proof ? {target: proof.target, parent: proof.parent, boundaryDaa: proof.boundaryDaa, nodes: proof.nodes} : null,
      before: live ? {phase: live.ledger.phase, sold: live.ledger.sold, purchaseCount: live.ledger.purchaseCount, cursor: live.ledger.cursor, value: live.snapshot.value} : null,
      winner: action === 'DRAW_AND_PAY' ? proof.winner : null,
      origin: null, genesisTxid: live?.row?.genesisTxid ?? null,
    };
    const materialize = tier => {
      const {priced, sponsored} = quoted[tier], draft = priced.draft;
      return {
        tier, cid: action === 'GENESIS' ? draft.transaction.outputs[0].covenant.covenantId : request.cid,
        draft, fee: priced.fee, quote: priced.quote, sponsored,
        feeMode: priced.mode, orderingFeerate: priced.orderingFeerate, standardFee: priced.standardFee, loadFee: priced.loadFee, feeClamped: priced.clamped,
        outputs: describeOutputs(draft, live, session), budget: draft.transaction.inputs[0].computeBudget,
        after: draft.transition?.next ? {phase: draft.transition.next.phase, sold: draft.transition.next.sold, purchaseCount: draft.transition.next.purchaseCount, cursor: draft.transition.next.cursor, value: draft.transaction.outputs[0].value} : null,
        terminal: draft.transition?.terminal ?? null,
        origin: action === 'GENESIS' ? draft.inputUtxos[0].outpoint : live.snapshot.origin,
        nextLedger: action === 'GENESIS' ? hex(S.encodeLedger(S.newOpen(session.key, request.config))) : draft.transition.next ? hex(S.encodeLedger(draft.transition.next)) : null,
        nextValue: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].value : null, nextSpk: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].scriptPublicKey : null,
      };
    };
    const wanted = request.tier && tiers[request.tier]?.available ? request.tier : recommended;
    const plan = {id: planId(), ...base, ...materialize(wanted)};
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
    requireTradingRelease();
    const store = await this.store(), cur = await store.get(PREFIX + hash32(txid));
    ensure(cur, '本浏览器没有这笔交易的记录');
    const old = cur.value;
    ensure(['SUBMITTED', 'PENDING', 'UNKNOWN'].includes(old.status) && !old.replacedBy, '只有尚未确认、且未被替换过的本机交易才能加速');
    ensure(old.session?.key === session.key && old.session?.address === session.address, '请连接提交这笔交易时使用的钱包账户');
    this.onStatus('连接 TN10 节点…');
    await this.pair.connect();
    const currentDaa = await this.pair.currentDaa(), feerate = await this.pair.feerate();
    this.onStatus('确认原交易仍在节点内存池中…');
    const entry = await mempoolEntry(this.pair, txid);
    ensure(entry, '原交易已不在节点内存池中（可能已被接受、已被替换或已被挤出）：请先核对结果，不能替换', 'NOT_IN_MEMPOOL');
    ensure(entry.fee === old.fee, '节点内存池中的原交易费用与本机记录不符，已拒绝替换');
    // Inputs must still be live: the original is only in the mempool, so they are unspent in the UTXO set.
    await verifyInputsLive(this.pair, old.draft.inputUtxos);
    const d0 = old.draft, t0 = d0.transaction;
    let make, spent = null, budget = t0.inputs[0].computeBudget;
    if (old.action === 'GENESIS') {
      const reg = t0.outputs.length > 1 && t0.outputs[1].scriptPublicKey.script === DEFAULT_REGISTRY_SPK.script && !t0.outputs[1].covenant;
      const s = S.decodeLedger(unhex(old.nextLedger));
      make = fee => buildOpenGenesis(this.profile, session.key, s.config, d0.inputUtxos, fee, reg ? DEFAULT_REGISTRY_SPK : null);
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
      make = fee => buildAction(snapshot, this.profile, op, fee, d0.inputUtxos.slice(1), budget);
    }
    // Strictly higher ordering feerate than the original: old fee / old mass < new fee / new mass. Same inputs and
    // output count give (almost) the same mass, so require new fee >= floor(old fee x new mass / old mass) + 1, plus
    // a 10% step so repeated bumps make visible progress under a moving estimate.
    const q0 = quoteMass(d0), m0 = [q0.computeMass, q0.normalizedTransient, q0.storageMass].reduce((a, b) => a > b ? a : b);
    const step = old.fee + old.fee / 10n + 1n;
    let priced = convergeFee(make, feerate, {mode: feeMode, minFee: step});
    const m1 = priced.orderingMass, strict = old.fee * m1 / m0 + 1n;
    if (priced.fee < strict) priced = convergeFee(make, feerate, {mode: feeMode, minFee: strict > step ? strict : step});
    ensure(priced.fee * m0 > old.fee * priced.orderingMass, '替换交易的费率没有严格高于原交易');
    const draft = priced.draft;
    draft.txid = referenceTxId(draft.transaction);
    ensure(draft.txid !== txid, '替换交易与原交易相同');
    ensure(stable(draft.inputUtxos.map(u => u.outpoint)) === stable(d0.inputUtxos.map(u => u.outpoint)), '替换交易必须花费完全相同的输入');
    if (old.action !== 'GENESIS') ensure(stable(draft.transition.next ?? null) === stable(d0.transition.next ?? null) && draft.transition.terminal === d0.transition.terminal, '替换交易的状态变化与原交易不一致');
    const plan = {
      id: planId(), createdAt: Date.now(), action: old.action, cid: old.cid, session, draft, fee: priced.fee, quote: priced.quote, feerate, currentDaa, sponsored: old.sponsored ?? false,
      feeMode: priced.mode, orderingFeerate: priced.orderingFeerate, standardFee: priced.standardFee, loadFee: priced.loadFee, feeClamped: priced.clamped,
      proof: old.proof ?? null, outputs: describeOutputs(draft, null, session), budget: draft.transaction.inputs[0].computeBudget,
      before: spent ? {phase: spent.phase, sold: spent.sold, purchaseCount: spent.purchaseCount, cursor: spent.cursor, value: d0.inputUtxos[0].value} : null,
      after: draft.transition?.next ? {phase: draft.transition.next.phase, sold: draft.transition.next.sold, purchaseCount: draft.transition.next.purchaseCount, cursor: draft.transition.next.cursor, value: draft.transaction.outputs[0].value} : null,
      terminal: draft.transition?.terminal ?? null, winner: old.winner ?? null,
      origin: old.origin, genesisTxid: old.action === 'GENESIS' ? draft.txid : old.genesisTxid,
      nextLedger: old.nextLedger, nextValue: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].value : null, nextSpk: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].scriptPublicKey : null,
      replaces: txid, replaceRoot: old.replaceRoot ?? txid, previousFee: old.fee, previousOrderingFeerate: old.orderingFeerate ?? null, replaceVia: 'replacement',
    };
    if (old.action === 'GENESIS') { plan.cid = draft.transaction.outputs[0].covenant.covenantId; ensure(plan.cid === old.cid, '替换创建交易的 Covenant ID 与原交易不一致'); }
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Sign, persist, submit once. Returns the stored record. */
  async execute(plan, {approved, onProgress = () => {}} = {}) {
    requireTradingRelease();
    ensure(approved === true, '尚未勾选批准');
    ensure(this.plans.get(plan.id) === plan, '交易计划已失效，请重新报价');
    this.plans.delete(plan.id); this.tierBuilds.delete(plan.id);
    ensure(Date.now() - plan.createdAt < PLAN_TTL_MS, '报价已超过 90 秒，请重新报价（链上状态与费率可能已变化）');
    ensure(this.locks, '浏览器不支持 Web Locks，无法防止多标签页重复提交');
    return this.locks.request('kaswin-opus-submit', {ifAvailable: true}, async lock => {
      ensure(lock, '另一个标签页正在提交交易，请稍后在交易记录中对账');
      const store = await this.store(), k = PREFIX + plan.draft.txid;
      ensure(typeof store.insertIfAbsentWithCheck === 'function', '记录库不支持原子输入占用，不能提交', 'ATOMIC_INTENT_STORE_REQUIRED');
      await lock.assertHeld?.();
      ensure(!(await store.get(k)), '这笔交易已有本地记录，只能对账，不能重复提交');
      const replacesKey = plan.replaces ? PREFIX + hash32(plan.replaces) : null;
      const reserved = await reservedInputs(store, NETWORK_GENESIS, replacesKey);
      ensure(!plan.draft.inputUtxos.some(f => reserved.has(key(f.outpoint))), '输入已被另一笔未对账的本地提交占用');
      onProgress('再次确认所有输入仍未花费…');
      await this.pair.currentDaa();
      await verifyInputsLive(this.pair, plan.draft.inputUtxos);
      onProgress(plan.draft.authorizedInputIndices.length ? '请在 KasWare 中核对并签名（手机端请查看后台标签页或菜单底部的 KasWare）…' : '此动作无需钱包签名（无外部资金输入）…');
      await lock.assertHeld?.();
      const sigs = await signWithWallet(plan.draft, plan.session, {onWaiting: s => onProgress(s || '等待 KasWare 签名…')});
      await lock.assertHeld?.();
      const tx = structuredClone(plan.draft.transaction);
      for (const [i, sig] of sigs) tx.inputs[i].signatureScript = sig;
      ensure(referenceTxId(tx) === plan.draft.txid, '签名后交易 ID 变化，已拒绝');
      onProgress('签名后再次确认输入未被花费…');
      await verifyInputsLive(this.pair, plan.draft.inputUtxos);
      const anchors = await Promise.all(this.pair.nodes.map(async n => ({url: n.url, sink: hash32((await n.call('getSink')).sink)})));
      let record = {
        txid: plan.draft.txid, action: plan.action, cid: plan.cid, createdAt: Date.now(), status: 'SUBMITTING', accepted: false,
        fee: plan.fee, quote: plan.quote, budget: plan.budget, session: {address: plan.session.address, key: plan.session.key},
        inputs: plan.draft.inputUtxos.map(f => f.outpoint), draft: plan.draft, signed: tx, anchors, cursors: Object.fromEntries(anchors.map(a => [a.url, a.sink])),
        outputs: plan.outputs, terminal: plan.terminal, winner: plan.winner, proof: plan.proof, orderingFeerate: plan.orderingFeerate ?? null, feeTier: plan.tier ?? null,
        ...(plan.replaces ? {replaces: plan.replaces, replaceRoot: plan.replaceRoot, previousFee: plan.previousFee} : {}),
        origin: plan.origin, genesisTxid: plan.action === 'GENESIS' ? plan.draft.txid : plan.genesisTxid, nextLedger: plan.nextLedger, nextValue: plan.nextValue, nextSpk: plan.nextSpk, walletEchoDiffers: sigs.echoDiffers === true,
      };
      await lock.assertHeld?.();
      let stored = await persistIntent(store, NETWORK_GENESIS, k, record, lock.lease, replacesKey); // atomic outpoint check + durable intent
      onProgress('意图已持久化，正在单次提交…');
      try {
        await lock.assertHeld?.(); // failure preserves the durable intent as UNKNOWN, never silently releases
        // Fee bump of a transaction still in the node mempool: RbfPolicy::Mandatory (exactly one conflicting mempool tx,
        // strictly higher feerate). Otherwise the ordinary submit (RbfPolicy::Forbidden). rusty-kaspa v2.1.0 flow_context.rs.
        const viaReplacement = plan.replaceVia === 'replacement';
        const res = viaReplacement
          ? await this.pair.nodes[0].call('submitTransactionReplacement', {transaction: txToRpc(tx)})
          : await this.pair.nodes[0].call('submitTransaction', {transaction: txToRpc(tx), allowOrphan: false});
        ensure(res?.transactionId === plan.draft.txid, `节点返回的交易 ID 不一致：${res?.transactionId}`);
        let replacedTxid = null;
        if (viaReplacement) { try { replacedTxid = referenceTxId(txFromRpc(res.replacedTransaction)); } catch {} }
        record = {...record, status: 'SUBMITTED', submittedAt: Date.now(), submittedTo: this.pair.nodes[0].url,
          ...(viaReplacement ? {replacedInMempool: replacedTxid} : {})};
      } catch (e) {
        const msg = errorText(e);
        // A definite mempool rejection that names this txid is recorded as REJECTED (inputs released); anything else is UNKNOWN.
        // "already accepted / already in the mempool / orphan pool" means THIS transaction exists: not a rejection.
        // (mining/errors/src/mempool.rs v2.1.0; "output … already spent by transaction … in the mempool" IS a rejection.)
        const definite = /Rejected transaction/i.test(msg) && msg.includes(plan.draft.txid) && !/was already accepted|is already in the mempool|already in the orphan pool/i.test(msg);
        record = {...record, status: definite ? 'REJECTED' : 'UNKNOWN', error: msg};
      }
      try { stored = await store.compareAndSet(k, stored.revision, record); } catch (e) { record = {...record, persistenceError: errorText(e)}; }
      // The replaced record stays open (it can still be accepted until a sibling is); it only gains a pointer.
      if (replacesKey && record.status === 'SUBMITTED') {
        for (let i = 0; i < 4; i++) {
          const cur = await store.get(replacesKey);
          if (!cur || ['ACCEPTED', 'CONFIRMING'].includes(cur.value.status)) break;
          try { await store.compareAndSet(replacesKey, cur.revision, {...cur.value, status: 'REPLACED', replacedBy: plan.draft.txid, replacedAt: Date.now()}); break; } catch {}
        }
      }
      return record;
    });
  }

  /** Re-check acceptance on the configured active node. Never resubmits. */
  async reconcile(txid, onProgress = () => {}) {
    const store = await this.store(), k = PREFIX + hash32(txid);
    let stored = await store.get(k); ensure(stored, '本浏览器没有这笔交易的记录');
    const prev = stored.value.status, sticky = prev === 'REJECTED' || prev === 'REPLACED' || prev === 'SUPERSEDED' ? prev : null;
    let r = {...stored.value, status: sticky ?? 'RECHECKING', accepted: false, checkedAt: Date.now()};
    stored = await store.compareAndSet(k, stored.revision, r);
    try {
      await this.pair.connect();
      onProgress('在选中链上查找接受记录…');
      const found = [];
      for (const n of this.pair.nodes) {
        // Resume from this node's saved cursor; after switching nodes fall back to any submit-time anchor (a sink hash
        // that stays a selected-chain block on every synced node unless it was reorged out).
        const cursor = r.cursors?.[n.url] ?? r.anchors?.find(a => a.url === n.url)?.sink ?? r.anchors?.[0]?.sink;
        ensure(cursor, '缺少对账起点');
        const hit = r.accepting ? {accepting: r.accepting, cursor} : await searchAccepted(n, txid, cursor);
        if (!r.accepting) r.cursors = {...r.cursors, [n.url]: hit.cursor};
        found.push(hit.accepting);
      }
      const accepting = found[0];
      if (!accepting) {
        let entry = null; try { entry = await mempoolEntry(this.pair, txid); } catch {}
        r = {...r, status: sticky ?? (entry ? 'PENDING' : 'UNKNOWN'), mempool: {present: !!entry, fee: entry?.fee ?? null, checkedAt: Date.now()},
          note: entry ? '交易在节点内存池中，等待被打包接受（在内存池中不等于已接受）' : '本次有界查询没有在选中链上找到，节点内存池中也没有（可能已被替换、被挤出或尚未传播）；不代表失败，不会自动重发'};
      } else {
        const virtualDaa = await this.pair.currentDaa(); // read before the check: the depth below is a lower bound
        const ev = await acceptedPair(this.pair, txid, accepting);
        const fee = matchesDraft(ev, r.draft);
        r = {...r, ...acceptanceStep(r, ev, virtualDaa, this.reorgRecheckDaa), accepting, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations, actualFee: fee, computeMass: ev.computeMass, storageMass: ev.tx.storageMass, verifiedAt: Date.now()};
      }
    } catch (e) {
      r = {...r, status: sticky ?? 'UNKNOWN', accepted: false, error: errorText(e), note: '本次核验未完成；保留输入占用，不会重发'};
    }
    await store.compareAndSet(k, stored.revision, r);
    return this.settleFamily(r);
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
    const store = await this.store(), family = (await store.list(PREFIX)).filter(x => { const v = x.record.value; return v.txid === root || v.replaceRoot === root; });
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

  /** User-confirmed release of a REJECTED/UNKNOWN record's input reservation (e.g. inputs verified spent elsewhere). */
  async archive(txid) {
    const store = await this.store(), k = PREFIX + hash32(txid), stored = await store.get(k);
    ensure(stored, '没有此记录');
    ensure(!['ACCEPTED', 'CONFIRMING'].includes(stored.value.status), '已接受的交易不能归档释放');
    const inputs = stored.value.draft.inputUtxos;
    await this.pair.connect();
    // Release only if at least one input is provably no longer live on the configured node (cannot double-spend anymore),
    // or the record is a definite rejection.
    let spent = false;
    try { await verifyInputsLive(this.pair, inputs); } catch (e) { spent = e?.code === 'STALE_INPUT'; }
    ensure(spent || stored.value.status === 'REJECTED', '输入仍然未花费：若交易仍在传播，释放后再次提交可能导致重复。请稍后再对账。');
    await store.compareAndSet(k, stored.revision, {...stored.value, status: 'ARCHIVED', archivedAt: Date.now()});
  }
}

export function explainUnavailable(action, live) {
  const s = live.ledger, x = live.snapshot, d = x.currentDaa;
  if (action === 'BUY') return s.phase !== 1 ? '轮次已封盘' : s.sold >= s.config.ticketCap ? '票已售罄' : '购买记录已满 256 条';
  if (action === 'CLOSE') return s.phase !== 1 ? '轮次不在开放阶段' : `未满票也未到封盘时间（还需约 ${s.config.closeEligibleDaa - d} DAA）`;
  if (action === 'DRAW_AND_PAY') return s.phase !== 2 ? '轮次不在封存待开奖阶段' : `封存后需等待 100 DAA（还差 ${x.utxoDaa + S.DRAW_DELAY - d} DAA）`;
  if (action === 'TIMEOUT_REFUND') return s.phase !== 2 ? '仅封存阶段可超时转退款' : `封存后 432000 DAA 才可超时转退款（还差 ${x.utxoDaa + S.TIMEOUT_DELAY - d} DAA）`;
  if (action === 'REFUND') return '轮次不在退款阶段';
  return '条件不满足';
}

/** Human-readable outputs with roles. */
export function describeOutputs(draft, live, session) {
  const t = draft.transaction, roles = [];
  if (draft.transition?.next) roles.push('STATE');
  if (!draft.transition) { roles.push('STATE'); if (t.outputs.length > 1 && t.outputs[1].scriptPublicKey.script === DEFAULT_REGISTRY_SPK.script) roles.push('REGISTRY'); }
  for (const pmt of draft.transition?.payments ?? []) roles.push(pmt.role);
  while (roles.length < t.outputs.length) roles.push('CHANGE');
  return t.outputs.map((o, i) => {
    const addr = spkToAddress(o.scriptPublicKey), mine = o.scriptPublicKey.script === session.spk.script;
    return {index: i, value: o.value, role: roles[i], label: ROLE_LABEL[roles[i]] ?? roles[i], address: addr, covenant: o.covenant?.covenantId ?? null, mine};
  });
}
export const roleLabel = r => ROLE_LABEL[r] ?? r;
