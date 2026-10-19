import {ensure} from '../core.mjs';
import {RestRoundResolver} from '../round/rest-rounds.mjs';
import {recheckLiveSnapshot} from '../round/live-snapshot.mjs';
import {selectedChainAnchor} from '../chain/selected-chain.mjs';
import {queryContext, sameQueryContext, sameConnectionContext, failure, withDeadline, pause} from '../chain/operation.mjs';
import {spkToAddress} from '../wallet/address.mjs';
import {linkNet} from '../chain/network-schema.mjs';
import {DrawReadiness} from './draw-readiness.mjs';
import {REORG_RECHECK_DAA} from '../chain/chain.mjs';

/** One detail session. Owns verified snapshots AND in-flight reads for every non-GENESIS action.
 * Notifications invalidate/wake the session; neither an event nor a persisted `verified` flag grants authority. */
export class RoundTracker {
  constructor({link, discovery, store, profile, cid, evidence = null, onUpdate = () => {}, onStatus = () => {}, onDrawProgress = null, intervalMs = 15000, actionWaitMs = 8000, resolver} = {}) {
    this.net = linkNet(link);
    ensure(store?.network === this.net.genesis, 'TRACKER_STORE_NETWORK_MISMATCH');
    ensure(!discovery?.net || discovery.net.genesis === this.net.genesis, 'TRACKER_DISCOVERY_NETWORK_MISMATCH');
    ensure(!evidence || (evidence.net.genesis === this.net.genesis && evidence.profileId === profile.id), 'TRACKER_EVIDENCE_CONTEXT');
    ensure(Number.isSafeInteger(actionWaitMs) && actionWaitMs > 0 && actionWaitMs <= 8000, 'ROUND_SYNC_BUDGET');
    Object.assign(this, {link, discovery, store, profile, cid, evidence, onUpdate, onStatus, intervalMs, actionWaitMs});
    this.draw = onDrawProgress ? new DrawReadiness({link, profile, onUpdate: onDrawProgress,
      current: () => !this.stopped && this.observationCurrent() && !this.observation.result.incomplete ? this.observation.result.live : null}) : null;
    this.resolver = resolver ?? new RestRoundResolver(profile, {...discovery?.rest, net: this.net, evidence});
    this.key = Symbol(cid); this.epoch = 0; this.off = []; this.stopped = true; this.work = null; this.dirty = false;
    this.version = 0; this.hardVersion = 0; this.checkpoint = null; this.lookupStart = null; this.observation = null; this.liveWork = null; this.lastError = null;
  }
  invalidate({anchor = false, candidate = false, cancel = false, utxo = false, revokeTerminal = false} = {}) {
    const settled = this.terminal;
    this.version++; this.dirty = true;
    if (!utxo) { this.hardVersion++; this.acceptedEvidence = null; }
    this.observation = null; this.draw?.invalidate(); this.store.invalidate(this.cid, {terminal: revokeTerminal || !settled});
    if (anchor) { this.anchor = null; this.lookupStart = null; this.checkpoint = null; this.resolver.resetSearch?.(this.cid); }
    if (candidate) this.candidate = null;
    if (cancel) this.readCtl?.abort(failure('READ_VIEW_CHANGED'));
  }
  /** Current-runtime node Full acceptance only (never disk/REST); replay and actual live checks remain mandatory. */
  offerAccepted({ev, context, shared = false}) {
    const belongs = ev?.tx?.outputs?.some(o => o.covenant?.covenantId === this.cid) || ev?.inputs?.some(u => u?.covenantId === this.cid);
    if (this.stopped || !belongs || !sameQueryContext(context, queryContext(this.link))) return false;
    if (this.observationCurrent() && this.observation.result.view.latestTxid === ev?.txid) return true;
    const checkpoint = this.checkpoint;
    if (checkpoint?.daa != null && typeof ev.acceptingDaa === 'bigint' && ev.acceptingDaa < checkpoint.daa &&
        sameConnectionContext(checkpoint.context, context)) return true; // older accepted history is not a new head
    const joining = shared && (this.work || this.liveWork);
    this.invalidate(joining ? {utxo: true} : {cancel: true});
    if (!joining) this.candidate = {latestTxid: ev.txid, accepting: ev.accepting, origin: this.candidate?.origin, genesisTxid: this.candidate?.genesisTxid};
    this.acceptedEvidence = {ev: structuredClone(ev), context, at: Date.now()};
    this.onStatus('SYNCING'); this.wake();
    return true;
  }
  get terminal() { return this.observation?.result.terminal === true && this.observation.result.terminalSettled === true; }
  acceptingBlocks() {
    return new Set([this.candidate?.accepting, this.checkpoint?.view.accepting, this.observation?.result.view?.accepting, this.acceptedEvidence?.ev.accepting, this.readScope?.accepting].filter(Boolean));
  }
  rememberCheckpoint(result, context) {
    this.candidate = result.candidate ?? result.view;
    const daa = result.live?.snapshot.utxoDaa ?? result.terminalCheck?.acceptingDaa;
    this.checkpoint = {view: result.view, context, daa: daa == null ? null : BigInt(daa)};
  }
  start() {
    if (!this.stopped) return this.work;
    this.stopped = false; this.epoch++; this.release = this.link.retain?.(); this.ctl = new AbortController();
    this.off = [this.link.on?.('utxos', ({rpc} = {}) => {
      if (this.terminal) return;
      // A standby hint must not cancel a primary read or erase a fresh Engine handoff.
      if (rpc && rpc !== this.link.nodes?.[0]) { if (!this.work && !this.liveWork) this.wake(); return; }
      this.invalidate({utxo: true}); this.onStatus('SYNCING'); this.wake();
    }), this.link.on?.('chain', ({rpc, data} = {}) => {
      const removed = data?.removedChainBlockHashes;
      this.draw?.hint(); // The existing subscription wakes read-only progress; notifications never supply scores.
      if (!removed?.length) return;
      if (this.terminal) {
        // A settled final state is only a 100-DAA recheck, not finality. The PRIMARY connection explicitly removing its
        // accepting block revokes it in memory and on disk, then the round is resolved again. Standby reports do not.
        if (rpc && rpc !== this.link.nodes?.[0]) return;
        const accepting = this.acceptingBlocks();
        if (!removed.some(hash => accepting.has(hash))) return;
        this.invalidate({anchor: true, revokeTerminal: true}); this.onStatus('REORGED'); this.wake();
        return;
      }
      const accepting = this.acceptingBlocks(), relevant = removed.some(hash => accepting.has(hash));
      if (rpc && rpc !== this.link.nodes?.[0]) {
        // Standby observations never revoke a primary verdict. An already-running primary read answers this hint.
        if (relevant && !this.work && !this.liveWork) this.wake();
        return;
      }
      if (this.readScope) for (const hash of removed) {
        if (this.readScope.removed.size >= 20000) { this.readScope.overflow = true; break; }
        this.readScope.removed.add(hash);
      }
      if (removed.includes(this.anchor?.hash)) this.anchor = null;
      if (removed.includes(this.lookupStart?.hash)) this.lookupStart = null;
      if (relevant) { this.invalidate({anchor: true}); this.onStatus('SYNCING'); this.wake(); }
    }), this.link.on?.('gap', () => {
      // Notifications may have been missed (failover, reconnect, subscription failure, unknown chain data). A settled
      // final view is not current any more, but a gap is no evidence of a reorg: invalidate() keeps it on disk as a
      // historical record (no revokeTerminal) and only drops the in-memory observation, so it is verified afresh.
      const settled = this.terminal;
      this.invalidate({anchor: true}); this.onStatus(settled ? 'TERMINAL_RECHECK' : 'SYNCING'); this.wake();
    }), this.evidence?.onProof(proof => {
      if (this.stopped || proof.origin === this.key) return; // the active detail read already owns this very body
      this.offerAccepted({ev: proof.ev, context: proof.context, shared: true});
    })].filter(Boolean);
    this.wake(); return this.work;
  }
  wake() {
    if (this.stopped || this.terminal || this.work || this.liveWork || this.wakeScheduled) return;
    // A request to refresh is not evidence that the current observation has become invalid.
    clearTimeout(this.timer); this.wakeScheduled = true;
    this.timer = setTimeout(() => { this.wakeScheduled = false; this.timer = null; if (!this.stopped && !this.terminal) void this.run(); }, 100);
  }
  observationCurrent(observation = this.observation) {
    return !!observation && observation === this.observation && !this.dirty && observation.version === this.version &&
      sameConnectionContext(observation.context, queryContext(this.link));
  }
  /** A single shared action read. Never uses the page's display fields or a disk-loaded authority flag. */
  async currentLive() {
    if (this.stopped) throw failure('TRACKER_STOPPED');
    const epoch = this.epoch;
    const finish = read => {
      if (this.stopped || epoch !== this.epoch) throw failure('TRACKER_STOPPED');
      if (!read?.observation || !this.observationCurrent(read.observation)) throw failure('READ_VIEW_CHANGED');
      const live = structuredClone(read.live), anchor = read.observation.result.anchor?.hash;
      if (/^[0-9a-f]{64}$/.test(anchor ?? '')) live.lookupStart = anchor; // a read-before-proof location hint, never authority
      return live;
    };
    if (this.liveWork) return finish(await this.liveWork);
    const task = withDeadline(scope => this.readLive(scope), {timeoutMs: this.actionWaitMs, signal: this.ctl.signal, code: 'ROUND_SYNC_PENDING'});
    this.liveWork = task;
    try { return finish(await task); }
    finally {
      if (this.liveWork === task) this.liveWork = null;
      if (!this.stopped && !this.terminal && !this.work && !this.wakeScheduled) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(), this.dirty || (!this.observation && !this.lastError) ? 2000 : this.intervalMs);
        this.timer.unref?.();
      }
    }
  }
  /** A presentation barrier, including terminal results. Never promotes a candidate or a saved acceptance flag. */
  async synchronize() {
    try { await this.currentLive(); }
    catch (e) { if ((e?.code ?? e?.safeCode) !== 'NOT_LIVE') throw e; }
    if (!this.observationCurrent() || this.observation.result.incomplete) throw failure('ROUND_SYNC_PENDING');
    return structuredClone(this.observation.result);
  }
  hintLookup(anchor) {
    if (!/^[0-9a-f]{64}$/.test(anchor ?? '')) return false;
    this.lookupStart = {hash: anchor, at: Date.now(), context: queryContext(this.link)}; this.wake(); return true;
  }
  async retry({anchor = null} = {}) {
    this.hintLookup(anchor);
    // Join an in-flight proof. A retry request alone must not cancel the successor that is already arriving.
    this.wake();
    return this.synchronize();
  }
  async readLive(scope) {
    const epoch = this.epoch, signal = scope.signal;
    const check = () => { scope.check(); if (this.stopped || epoch !== this.epoch) throw failure('TRACKER_STOPPED'); };
    for (let attempt = 0; attempt < 3; attempt++) {
      check();
      // Wait for the SAME full refresh already running (or requested by a notification), rather than launching another
      // discovery/acceptance walk. A just-completed full read already checked its UTXO: no immediate duplicate query.
      if (this.work || this.wakeScheduled || !this.observationCurrent()) {
        const result = await (this.work ?? this.run()); check();
        if (this.lastError) {
          const code = this.lastError.safeCode ?? this.lastError.code;
          if (!['READ_VIEW_CHANGED', 'STALE_TIP'].includes(code)) throw this.lastError;
          if (attempt < 2) await pause(250 * (attempt + 1), signal);
          continue;
        }
        if (!result) continue;
        ensure(!result.terminal, '轮次已经结束，节点已核验', 'NOT_LIVE');
        if (!result.live || result.incomplete) {
          this.onStatus('CATCHING_UP');
          if (attempt < 2) await pause(250 * (attempt + 1), signal);
          continue;
        }
        if (!this.observationCurrent()) continue;
        return {live: result.live, observation: this.observation};
      }
      const observed = this.observation;
      clearTimeout(this.timer); this.wakeScheduled = false; // This exact read covers the queued wake; finally restores tracking.
      ensure(!observed.result.terminal, '轮次已经结束，节点已核验', 'NOT_LIVE');
      ensure(observed.result.live && !observed.result.incomplete, '轮次状态正在同步，请稍后重试；本次操作尚未签名或提交', 'ROUND_SYNC_PENDING');
      let context;
      try {
        const live = await this.link.pinned(async link => {
          check();
          if (!sameConnectionContext(observed.context, queryContext(link))) throw failure('READ_VIEW_CHANGED');
          const value = await recheckLiveSnapshot(link, this.profile, this.cid, observed.result.live); check();
          context = queryContext(link); return value;
        }, {signal});
        check();
        if (!this.observationCurrent(observed) || !sameConnectionContext(context, queryContext(this.link))) continue;
        this.observation = {...observed, result: {...observed.result, live}};
        this.draw?.hint();
        return {live, observation: this.observation};
      } catch (e) {
        check();
        const recoverable = ['STALE_TIP', 'READ_VIEW_CHANGED'].includes(e?.safeCode ?? e?.code);
        // A late lightweight failure belongs to its old observation. Do not erase a newer Full handoff/result.
        if (this.observation === observed) { this.invalidate(); this.wake(); }
        if (!recoverable) throw e;
        this.onStatus('CATCHING_UP');
      }
    }
    throw failure('ROUND_SYNC_PENDING');
  }
  async run() {
    if (this.work || this.stopped) return this.work;
    clearTimeout(this.timer); this.wakeScheduled = false;
    this.dirty = false; this.lastError = null;
    const epoch = this.epoch, lifetime = this.ctl.signal, readCtl = new AbortController();
    const abort = () => readCtl.abort(lifetime.reason); lifetime.addEventListener('abort', abort, {once: true});
    if (lifetime.aborted) abort();
    this.readCtl = readCtl;
    const signal = readCtl.signal;
    const check = () => { signal.throwIfAborted(); if (epoch !== this.epoch || this.stopped) throw failure('TRACKER_STOPPED'); };
    let incomplete = false, readScope = null;
    const task = (async () => {
      this.onStatus('SYNCING');
      if (!this.candidate) {
        if (this.acceptedEvidence) {
          const ev = this.acceptedEvidence.ev;
          this.candidate = {latestTxid: ev.txid, accepting: ev.accepting};
        } else {
          const known = (await this.store.get(this.cid))?.view; check();
          // Disk is a location hint only: the resolver still checks the actual body/origin/script/live UTXO on node.
          this.candidate = known?.latestTxid && known?.origin ? known : await this.discovery.candidate(this.cid, {known, signal}); check();
        }
      }
      if (this.candidate?.state && !this.observation) {
        this.onUpdate({view: this.candidate, incomplete: true, candidate: this.candidate});
      }
      await this.link.watch?.(this.key, this.candidate?.scriptPublicKey && !this.candidate.terminal ? [spkToAddress(this.candidate.scriptPublicKey, this.net.addressPrefix)] : []); check();
      // Initial connect/subscription can raise a gap. The reads below start after it, so consume that wakeup here.
      this.dirty = false;
      const version = this.version;
      let context, hardVersion;
      const result = await this.link.pinned(async link => {
        readScope = {removed: new Set(), overflow: false}; this.readScope = readScope;
        const before = typeof this.link.readContext === 'function' ? queryContext(link) : null;
        hardVersion = this.hardVersion;
        const start = await selectedChainAnchor(link); check();
        const hint = this.lookupStart;
        const usableHint = hint && Date.now() - hint.at < 30000 && sameConnectionContext(hint.context, queryContext(link));
        const recent = usableHint ? hint.hash : this.anchor && Date.now() - this.anchor.at < 30000 ? this.anchor.hash : start;
        if (this.lookupStart === hint) this.lookupStart = null; // consume once; an in-flight read cannot erase a newer hint
        const offered = this.acceptedEvidence, age = offered ? Date.now() - offered.at : -1;
        let initialEvidence = age >= 0 && age <= 2000 && sameQueryContext(offered.context, queryContext(link)) ? offered.ev : null;
        const shared = initialEvidence && this.evidence?.peek(initialEvidence.txid, {accepting: initialEvidence.accepting});
        if (shared) { initialEvidence = shared.ev; shared.scope.close(); } // retain the actual read-before-Full DAA provenance
        if (this.acceptedEvidence === offered) this.acceptedEvidence = null;
        const r = await this.resolver.resolve(link, this.cid, this.candidate, {signal, anchor: recent, initialEvidence, origin: this.key}); check();
        readScope.accepting = r.view.accepting;
        if (hardVersion === this.hardVersion && !readScope.overflow && !readScope.removed.has(r.view.accepting))
          this.rememberCheckpoint(r, queryContext(link)); // accepted history remains a useful hint if its live output is spent next
        await this.link.watch?.(this.key, r.view.tip && r.view.scriptPublicKey ? [spkToAddress(r.view.scriptPublicKey, this.net.addressPrefix)] : []); check();
        let readVersion = version;
        if (this.hardVersion === hardVersion && this.version !== version && r.live) {
          // An earlier UTXO change may already be reflected by this result. Cover it with a NEW exact live read;
          // any further change during that read is still rejected below. Gap/reorg/new-acceptance cannot be covered.
          readVersion = this.version;
          r.live = await recheckLiveSnapshot(link, this.profile, this.cid, r.live); check();
        }
        context = typeof this.link.readContext === 'function' ? queryContext(link) : null;
        if (before && !sameConnectionContext(before, context)) throw failure('READ_VIEW_CHANGED');
        if (readScope.overflow || readScope.removed.has(r.view.accepting)) throw failure('READ_VIEW_CHANGED');
        return {...r, readVersion, anchor: {hash: start, at: Date.now()}};
      }, {signal}); check();
      const hardInvalid = () => hardVersion !== this.hardVersion || readScope?.overflow || readScope?.removed.has(result.view.accepting) ||
        (context && !sameConnectionContext(context, queryContext(this.link)));
      // Even a now-spent authenticated result advances the next LOOKUP. It does not grant operation authority.
      if (!hardInvalid()) {
        this.rememberCheckpoint(result, context); this.anchor = result.anchor;
      }
      const invalid = () => hardInvalid() || result.readVersion !== this.version;
      if (invalid()) { this.dirty = true; return; }
      this.dirty = false;
      incomplete = !!result.incomplete;
      const revision = this.store.begin(this.cid);
      const row = await this.store.remember(this.cid, {view: result.view, source: incomplete ? 'recovery' : 'node', verified: !incomplete,
        revision, replay: result.replay ?? null, terminalCheck: result.terminalCheck ?? null}); check();
      if (!row || invalid()) { if (row) this.store.invalidate(this.cid, {terminal: true, revision}); this.dirty = true; return; }
      this.candidate = result.candidate ?? result.view; this.anchor = result.anchor;
      // Connection objects stay in memory; only result.view/replay go to the persistent cache above.
      this.observation = incomplete ? null : {result: structuredClone(result), context, version: result.readVersion};
      // A final view keeps its chain-only watch (no addresses) and connection lease while this detail is open, so an
      // explicit removal of its accepting block still reaches the handler above. stop() releases both.
      this.onUpdate(result); this.draw?.hint(); this.onStatus(incomplete ? 'CATCHING_UP' : result.terminal && !this.terminal ? 'CONFIRMING' : 'CURRENT');
      return result;
    })().catch(e => {
      if (!signal.aborted && epoch === this.epoch) {
        this.lastError = e; this.invalidate(); this.onStatus('UNAVAILABLE', e);
        const changed = ['READ_VIEW_CHANGED', 'STALE_TIP'].includes(e?.safeCode ?? e?.code ?? e?.message);
        if (!changed && !this.checkpoint) this.candidate = null;
        this.dirty = changed; this.anchor = null;
      }
    }).finally(() => {
      lifetime.removeEventListener('abort', abort);
      if (this.readCtl === readCtl) this.readCtl = null;
      if (this.work === task) this.work = null;
      if (this.readScope === readScope) this.readScope = null;
      if (!this.stopped && !this.terminal) {
        clearTimeout(this.timer);
        const pending = this.observation?.result, depth = BigInt(pending?.terminalCheck?.depthDaa ?? 0);
        const settleDelay = pending?.terminal ? Number(REORG_RECHECK_DAA > depth ? REORG_RECHECK_DAA - depth : 0n) * 100 + 1500 : this.intervalMs;
        this.timer = setTimeout(() => { if (!this.stopped && !this.terminal) void this.run(); }, this.dirty || incomplete ? 2000 : settleDelay);
        this.timer.unref?.();
      }
    });
    this.work = task; return task;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.epoch++; this.wakeScheduled = false; clearTimeout(this.timer); this.ctl.abort(failure('TRACKER_STOPPED'));
    this.off.forEach(f => f()); this.off = []; this.link.unwatch?.(this.key); this.release?.(); this.release = null;
    this.invalidate({anchor: true}); this.readScope = null; this.candidate = null;
  }
}
