/** Kaswin V2 operation engine: GENESIS / BUY / CLOSE / DRAW_AND_PAY / TIMEOUT_REFUND / REFUND.
 * plan():   live snapshot from the configured node -> core builder -> consensus mass -> fee fixed point -> frozen plan.
 * execute(): user approval -> recheck session + inputs on the node -> wallet signs ordinary inputs only ->
 *            signatures verified -> intent persisted in IndexedDB -> ONE submit -> record outcome.
 * reconcile(): acceptance + exact approved economic/consensus fields and covenant witness.
 */
import {S, ensure, hash32, hex, buildAction, buildOpenGenesis, availableActions, actionBudget, referenceTxId, stable, kas, errorText,
  DEFAULT_REGISTRY_SPK, REGISTRATION_SOMPI, PROFILE_ID, NETWORK_GENESIS, IndexedStore, UserError} from './core.mjs';
import {convergeFee, MassLimitError} from './mass.mjs';
import {commonUtxos, verifyInputsLive, acceptedPair, searchAccepted, inMempool, matchesDraft} from './chain.mjs';
import {signWithWallet} from './wallet.mjs';
import {txToRpc} from './nodes.mjs';
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
  constructor({pair, profile, indexer, onStatus = () => {}, openStore = () => IndexedStore.open(STORE), locks = null, drawProof = acquireDrawProof}) {
    Object.assign(this, {pair, profile, indexer, onStatus, openStore, drawProof}); this.plans = new Map(); this.storeP = null;
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
    const feerate = await this.pair.feerate();
    let live = null, op = null, proof = null, registry = null;
    if (action === 'GENESIS') {
      S.validateConfig(request.config);
      ensure(request.config.closeEligibleDaa > currentDaa + 60n, '封盘时间过近或已过：请重新选择时长');
      registry = request.registry ? DEFAULT_REGISTRY_SPK : null;
    } else {
      hash32(request.cid, 'Covenant ID');
      this.onStatus('读取轮次账本，并在节点上核对实时状态 UTXO…');
      live = await liveRound(this.pair, this.indexer, this.profile, request.cid, currentDaa, await this.localTip(request.cid));
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
    let funds = needsFunds ? this.pick(available, principal + 3_000_000n) : [], priced, sponsored = false;
    const attempt = f => convergeFee(make(f), feerate, {mode: request.feeMode ?? 'standard'});
    for (let round = 0; ; round++) {
      try { priced = attempt(funds); break; }
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
    const plan = {
      id: planId(), createdAt: Date.now(), action, cid: action === 'GENESIS' ? draft.transaction.outputs[0].covenant.covenantId : request.cid,
      session, draft, fee: priced.fee, quote: priced.quote, feerate, currentDaa, sponsored, proof: proof ? {target: proof.target, parent: proof.parent, boundaryDaa: proof.boundaryDaa, nodes: proof.nodes} : null,
      outputs: describeOutputs(draft, live, session), budget: draft.transaction.inputs[0].computeBudget,
      before: live ? {phase: live.ledger.phase, sold: live.ledger.sold, purchaseCount: live.ledger.purchaseCount, cursor: live.ledger.cursor, value: live.snapshot.value} : null,
      after: draft.transition?.next ? {phase: draft.transition.next.phase, sold: draft.transition.next.sold, purchaseCount: draft.transition.next.purchaseCount, cursor: draft.transition.next.cursor, value: draft.transaction.outputs[0].value} : null,
      terminal: draft.transition?.terminal ?? null,
      winner: action === 'DRAW_AND_PAY' ? proof.winner : null,
      origin: action === 'GENESIS' ? draft.inputUtxos[0].outpoint : live.snapshot.origin, genesisTxid: live?.row?.genesisTxid ?? null,
      nextLedger: action === 'GENESIS' ? hex(S.encodeLedger(S.newOpen(session.key, request.config))) : draft.transition.next ? hex(S.encodeLedger(draft.transition.next)) : null,
      nextValue: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].value : null, nextSpk: draft.transaction.outputs[0].covenant ? draft.transaction.outputs[0].scriptPublicKey : null,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Sign, persist, submit once. Returns the stored record. */
  async execute(plan, {approved, onProgress = () => {}} = {}) {
    requireTradingRelease();
    ensure(approved === true, '尚未勾选批准');
    ensure(this.plans.get(plan.id) === plan, '交易计划已失效，请重新报价');
    this.plans.delete(plan.id);
    ensure(Date.now() - plan.createdAt < PLAN_TTL_MS, '报价已超过 90 秒，请重新报价（链上状态与费率可能已变化）');
    ensure(this.locks, '浏览器不支持 Web Locks，无法防止多标签页重复提交');
    return this.locks.request('kaswin-opus-submit', {ifAvailable: true}, async lock => {
      ensure(lock, '另一个标签页正在提交交易，请稍后在交易记录中对账');
      const store = await this.store(), k = PREFIX + plan.draft.txid;
      ensure(typeof store.insertIfAbsentWithCheck === 'function', '记录库不支持原子输入占用，不能提交', 'ATOMIC_INTENT_STORE_REQUIRED');
      await lock.assertHeld?.();
      ensure(!(await store.get(k)), '这笔交易已有本地记录，只能对账，不能重复提交');
      const reserved = await this.reserved();
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
        outputs: plan.outputs, terminal: plan.terminal, winner: plan.winner, proof: plan.proof,
        origin: plan.origin, genesisTxid: plan.action === 'GENESIS' ? plan.draft.txid : plan.genesisTxid, nextLedger: plan.nextLedger, nextValue: plan.nextValue, nextSpk: plan.nextSpk, walletEchoDiffers: sigs.echoDiffers === true,
      };
      await lock.assertHeld?.();
      let stored = await persistIntent(store, NETWORK_GENESIS, k, record, lock.lease); // atomic outpoint check + durable intent
      onProgress('意图已持久化，正在单次提交…');
      try {
        await lock.assertHeld?.(); // failure preserves the durable intent as UNKNOWN, never silently releases
        const res = await this.pair.nodes[0].call('submitTransaction', {transaction: txToRpc(tx), allowOrphan: false});
        ensure(res?.transactionId === plan.draft.txid, `节点返回的交易 ID 不一致：${res?.transactionId}`);
        record = {...record, status: 'SUBMITTED', submittedAt: Date.now(), submittedTo: this.pair.nodes[0].url};
      } catch (e) {
        const msg = errorText(e);
        // A definite mempool rejection that names this txid is recorded as REJECTED (inputs released); anything else is UNKNOWN.
        const definite = /Rejected transaction/i.test(msg) && msg.includes(plan.draft.txid) && !/already/i.test(msg);
        record = {...record, status: definite ? 'REJECTED' : 'UNKNOWN', error: msg};
      }
      try { stored = await store.compareAndSet(k, stored.revision, record); } catch (e) { record = {...record, persistenceError: errorText(e)}; }
      return record;
    });
  }

  /** Re-check acceptance on the configured active node. Never resubmits. */
  async reconcile(txid, onProgress = () => {}) {
    const store = await this.store(), k = PREFIX + hash32(txid);
    let stored = await store.get(k); ensure(stored, '本浏览器没有这笔交易的记录');
    let r = {...stored.value, status: stored.value.status === 'REJECTED' ? 'REJECTED' : 'RECHECKING', accepted: false, checkedAt: Date.now()};
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
        const pending = await inMempool(this.pair, txid);
        r = {...r, status: pending ? 'PENDING' : (r.status === 'REJECTED' ? 'REJECTED' : 'UNKNOWN'), note: pending ? '交易仍在内存池中，等待被接受' : '本次有界查询没有在选中链上找到；不代表失败，不会重发'};
      } else {
        const ev = await acceptedPair(this.pair, txid, accepting);
        const fee = matchesDraft(ev, r.draft);
        r = {...r, status: 'ACCEPTED', accepted: true, accepting, acceptingDaa: ev.acceptingDaa, confirmations: ev.confirmations, actualFee: fee, computeMass: ev.computeMass, storageMass: ev.tx.storageMass, verifiedAt: Date.now(),
          note: '节点当前选中链已接受，批准的输入、输出、费用和预算均已核对（合约费用见证严格匹配；不是不可逆最终性）'};
      }
    } catch (e) {
      r = {...r, status: r.status === 'REJECTED' ? 'REJECTED' : 'UNKNOWN', accepted: false, error: errorText(e), note: '本次核验未完成；保留输入占用，不会重发'};
    }
    await store.compareAndSet(k, stored.revision, r);
    return r;
  }

  /** User-confirmed release of a REJECTED/UNKNOWN record's input reservation (e.g. inputs verified spent elsewhere). */
  async archive(txid) {
    const store = await this.store(), k = PREFIX + hash32(txid), stored = await store.get(k);
    ensure(stored, '没有此记录');
    ensure(stored.value.status !== 'ACCEPTED', '已接受的交易不能归档释放');
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
