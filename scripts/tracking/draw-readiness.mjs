// Read-only, detail-scoped draw hints. No wallet, builder, intent store or submission authority.
import {S, stable} from '../core.mjs';
import {acquireRoundProof, confirmRoundTarget} from '../round/passa.mjs';
import {drawTargetFromOpening, assertFreshDrawConfirmation, DRAW_REUSE_MS, DRAW_MIN_CONFIRMATIONS, DRAW_MAX_TARGET_DEPTH} from '../round/draw-confirmations.mjs';
import {failure, queryContext, sameConnectionContext, scopedLink, withDeadline} from '../chain/operation.mjs';
import {uint} from '../chain/json.mjs';

// A READY view whose short-lived confirmation expired is re-verified silently; only these read failures may keep it
// on screen meanwhile (bounded by READY_GRACE_MS). Display only: the draw quote always re-proves and re-confirms.
const READY_GRACE_MS = 60_000;
const TRANSIENT = new Set(['DRAW_CONFIRMATION_STALE', 'READ_VIEW_CHANGED', 'DRAW_READINESS_TIMEOUT', 'RPC_OPERATION_TIMEOUT',
  'OPERATION_TIMEOUT', 'SINK_BEHIND', 'PROOF_CONTEXT_UNKNOWN']);
const identity = live => stable({snapshot: {...live.snapshot, currentDaa: null}, accepting: live.accepting});
export class DrawReadiness {
  constructor({link, profile, current, onUpdate = () => {}, acquire = acquireRoundProof, confirm = confirmRoundTarget, intervalMs = 2000} = {}) {
    Object.assign(this, {link, profile, current, onUpdate, acquire, confirm, intervalMs});
    this.version = 0; this.nextAt = 0; this.binding = null; this.progress = null; this.work = null;
  }
  invalidate() {
    this.version++; clearTimeout(this.timer); this.timer = null; this.ctl?.abort(failure('READ_VIEW_CHANGED'));
    this.binding = null; this.nextAt = 0; this.confirmation = null; this.readyAt = 0;
    if (this.progress) { this.progress = null; this.onUpdate(null); }
  }
  live() {
    const live = this.current();
    return live?.ledger?.phase === S.Phase.SEALED ? live : null;
  }
  bound() {
    const live = this.live();
    return live && this.binding?.key === identity(live) && sameConnectionContext(this.binding.context, queryContext(this.link)) ? live : null;
  }
  publish(value) { this.progress = {...value, requiredConfirmations: DRAW_MIN_CONFIRMATIONS}; this.onUpdate(this.progress); }
  view() {
    if (!this.bound()) return null;
    if (this.progress?.phase === 'READY') {
      try { assertFreshDrawConfirmation(this.confirmation, this.confirmation, Date.now(), this.link); }
      catch { return {...this.progress, refreshing: true}; }
    }
    return this.progress;
  }
  /** Called by the existing detail refresh/chain subscription, never a recursive RPC polling loop. */
  hint() {
    const live = this.live();
    if (!live) { this.invalidate(); return; }
    if (!this.bound()) {
      this.invalidate();
      this.binding = {key: identity(live), context: queryContext(this.link)};
      this.publish({phase: 'CHECKING', sealedDaa: live.snapshot.utxoDaa, boundaryDaa: live.snapshot.utxoDaa + S.DRAW_DELAY,
        currentDaa: live.snapshot.currentDaa});
    }
    if (this.progress?.phase === 'READY') {
      try { assertFreshDrawConfirmation(this.confirmation, this.confirmation, Date.now(), this.link); return; }
      catch { this.confirmation = null; } // keep READY on screen; the read below refreshes it
    }
    if (this.work) { this.requested = true; return; }
    if (this.timer) return;
    // Frequent blocks coalesce into one read; a failed node/proof backs off independently of notifications.
    this.timer = setTimeout(() => { this.timer = null; void this.read(); }, Math.max(0, this.nextAt - Date.now()));
    this.timer.unref?.();
  }
  /** Display-only live counters between full reads: node DAA and sink blue score. Never yields READY: the count stays
   * below the requirement until read() completes the full target confirmation. */
  async pulse() {
    const p = this.progress;
    if (this.pulsing || !p || !this.bound() || !['DAA_WAIT', 'TARGET_CHECKING', 'TARGET_WAIT'].includes(p.phase)) return;
    this.pulsing = true;
    const version = this.version, binding = this.binding;
    try {
      const {daa, sink} = await withDeadline(scope => this.link.pinned(async link => {
        if (!sameConnectionContext(binding.context, queryContext(link))) throw failure('READ_VIEW_CHANGED');
        const rpc = scopedLink(link, scope), daa = await rpc.currentDaa(); scope.check();
        const sink = p.target?.blueScore != null ? uint((await rpc.call('getSinkBlueScore')).blueScore) : null; scope.check();
        return {daa, sink};
      }, {signal: scope.signal, retries: 0}), {timeoutMs: 5000, code: 'DRAW_PULSE_TIMEOUT'});
      const cur = this.progress;
      if (version !== this.version || binding !== this.binding || !this.bound() || cur !== p) return;
      if (daa < p.currentDaa) return;
      const next = {...p, currentDaa: daa, observedAt: Date.now()};
      if (p.phase === 'DAA_WAIT' && daa >= p.boundaryDaa) { this.publish({...next, phase: 'TARGET_CHECKING'}); this.hint(); return; }
      if (p.phase === 'TARGET_WAIT' && sink !== null && sink >= p.target.blueScore) {
        const live = sink - p.target.blueScore, cap = DRAW_MIN_CONFIRMATIONS - 1n;
        if (live > (p.confirmations ?? 0n)) next.confirmations = live > cap ? cap : live;
        if (live >= DRAW_MIN_CONFIRMATIONS) { this.publish(next); this.hint(); return; }
      }
      this.publish(next);
    } catch {} finally { this.pulsing = false; }
  }
  async read() {
    if (this.work || !this.bound()) return;
    const version = this.version, binding = this.binding, live = this.bound(), ctl = new AbortController();
    this.ctl = ctl; this.requested = false; this.nextAt = Date.now() + this.intervalMs;
    let observedDaa = live.snapshot.currentDaa;
    const check = scope => { scope.check(); if (version !== this.version || binding !== this.binding || !this.bound()) throw failure('READ_VIEW_CHANGED'); };
    const task = withDeadline(scope => this.link.pinned(async link => {
      check(scope);
      if (!sameConnectionContext(binding.context, queryContext(link))) throw failure('READ_VIEW_CHANGED');
      const rpc = scopedLink(link, scope), currentDaa = await rpc.currentDaa(); check(scope);
      if (currentDaa < live.snapshot.utxoDaa) throw failure('SINK_BEHIND');
      observedDaa = currentDaa;
      const base = {sealedDaa: live.snapshot.utxoDaa, boundaryDaa: live.snapshot.utxoDaa + S.DRAW_DELAY, currentDaa, observedAt: Date.now()};
      // Page timeout policy only: refund maturity and actual submission remain independently verified.
      if (currentDaa >= live.snapshot.utxoDaa + S.TIMEOUT_DELAY) return {...base, phase: 'EXPIRED'};
      if (currentDaa < base.boundaryDaa) return {...base, phase: 'DAA_WAIT'};
      if (!this.progress?.target && !this.progress?.retargeting) this.publish({...base, phase: 'TARGET_CHECKING'});
      // Acquire the SAME first-crossing target used by normal planning. DAA is never a proxy for target depth.
      let proof;
      try {
        proof = await this.acquire(rpc, this.profile, {...live, snapshot: {...live.snapshot, currentDaa}}); check(scope);
      } catch (e) {
        check(scope);
        if (['TARGET_CROSSING_BLOCK_NOT_FOUND', 'CANDIDATE_NOT_FIRST_CROSSING'].includes(e?.safeCode ?? e?.code ?? e?.message)) {
          return {...base, phase: 'TARGET_WAIT', target: null, confirmations: 0n, observedAt: Date.now()};
        }
        throw e;
      }
      const target = drawTargetFromOpening(proof.opening);
      try {
        const confirmation = await this.confirm(rpc, target, {maxAgeMs: DRAW_REUSE_MS}); check(scope);
        return {...base, phase: 'READY', target, confirmations: confirmation.confirmations, confirmation};
      } catch (e) {
        check(scope);
        if (e?.safeCode !== 'DRAW_TARGET_UNCONFIRMED') throw e;
        return {...base, phase: 'TARGET_WAIT', target, confirmations: e.drawConfirmation.confirmations, observedAt: Date.now()};
      }
    }, {signal: scope.signal, retries: 0}), {signal: ctl.signal, timeoutMs: 30000, code: 'DRAW_READINESS_TIMEOUT'});
    this.work = task;
    try {
      const result = await task;
      if (version !== this.version || binding !== this.binding || !this.bound()) return;
      const {confirmation, ...progress} = result;
      if (confirmation) assertFreshDrawConfirmation(confirmation, confirmation, Date.now(), this.link);
      this.confirmation = confirmation ?? null;
      // A full read started before the latest pulse must not move the displayed counters backwards.
      const shown = this.progress;
      if (progress.phase === 'DAA_WAIT' && shown?.phase === 'DAA_WAIT' && shown.currentDaa > progress.currentDaa)
        Object.assign(progress, {currentDaa: shown.currentDaa, observedAt: shown.observedAt});
      if (progress.phase === 'TARGET_WAIT' && shown?.phase === 'TARGET_WAIT' && shown.target?.hash === progress.target?.hash) {
        if (shown.confirmations > progress.confirmations) progress.confirmations = shown.confirmations;
        if (shown.currentDaa > progress.currentDaa) progress.currentDaa = shown.currentDaa;
      }
      if (progress.phase === 'READY') this.readyAt = Date.now();
      this.publish(progress);
    } catch (e) {
      if (ctl.signal.aborted || version !== this.version || binding !== this.binding || !this.bound()) return;
      this.confirmation = null;
      const base = {sealedDaa: live.snapshot.utxoDaa, boundaryDaa: live.snapshot.utxoDaa + S.DRAW_DELAY, currentDaa: observedDaa};
      if ((e?.safeCode ?? e?.code) === 'PROOF_CONTEXT_INVALID') {
        // Too deep only after DRAW_MAX_TARGET_DEPTH (blue-score depth never exceeds the DAA distance). Earlier, the target
        // left the selected chain in a short reorg: re-locate the first-crossing block soon instead of claiming a timeout.
        if (observedDaa - live.snapshot.utxoDaa >= DRAW_MAX_TARGET_DEPTH) { this.nextAt = Date.now() + 15000; this.publish({...base, phase: 'EXPIRED'}); return; }
        this.nextAt = Date.now() + 2000; this.requested = true; this.publish({...base, phase: 'TARGET_CHECKING', retargeting: true}); return;
      }
      if (this.progress?.phase === 'READY' && TRANSIENT.has(e?.safeCode ?? e?.code) && Date.now() - (this.readyAt ?? 0) < READY_GRACE_MS) {
        this.nextAt = Date.now() + 2000; this.requested = true; return;
      }
      this.nextAt = Date.now() + 15000;
      this.publish({phase: 'UNAVAILABLE', sealedDaa: live.snapshot.utxoDaa, boundaryDaa: live.snapshot.utxoDaa + S.DRAW_DELAY,
        currentDaa: observedDaa, code: e?.safeCode ?? 'DRAW_READINESS_UNAVAILABLE'});
    } finally {
      if (this.work === task) this.work = null;
      if (this.ctl === ctl) this.ctl = null;
      if (this.requested) { this.requested = false; this.hint(); }
    }
  }
}
