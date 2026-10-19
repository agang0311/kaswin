// Own pending txids only. Notifications locate acceptance; they never prove approved fields or authorize a send.
import {hash32} from '../core.mjs';
import {linkNet} from '../chain/network-schema.mjs';
import {queryContext, sameConnectionContext, failure} from '../chain/operation.mjs';

export class AcceptanceNotices {
  constructor(link, {now = Date.now, maxAgeMs = 30000, subscribeWaitMs = 500} = {}) {
    if (!Number.isSafeInteger(subscribeWaitMs) || subscribeWaitMs < 0 || subscribeWaitMs > 500) throw failure('ACCEPTANCE_WAIT_BUDGET');
    this.subscribeWaitMs = subscribeWaitMs;
    this.link = link; this.net = linkNet(link); this.now = now; this.maxAgeMs = maxAgeMs;
    this.key = Symbol('own-acceptance'); this.entries = new Map(); this.stopped = false; this.ready = null; this.retryAt = 0; this.generation = 0;
    this.off = [link.on?.('chain', event => this.chain(event)), link.on?.('gap', () => this.invalidate())].filter(Boolean);
  }
  async track(txid) {
    hash32(txid); if (this.stopped) throw failure('ACCEPTANCE_TRACKER_STOPPED');
    if (!this.entries.has(txid)) this.entries.set(txid, {version: 0, hint: null, waiters: new Set()});
    if (typeof this.link.watchAccepted !== 'function') return; // Query-only adapters retain their existing path.
    this.releaseLink ??= this.link.retain?.();
    if (!this.ready && this.now() >= this.retryAt) {
      const generation = this.generation;
      const task = this.link.watchAccepted(this.key).catch(() => {
        // Subscription support/failure is not permission to fail, release or resend a transaction.
        if (!this.stopped && generation === this.generation) { this.retryAt = this.now() + 15000; this.invalidate(); }
      }).finally(() => { if (this.ready === task) this.ready = null; });
      this.ready = task;
    }
    const ready = this.ready;
    if (!ready) return;
    // IDs are registered before send, but a queued/unsupported subscription must not stall an approved transaction.
    // Keep the shared handshake running; missed notices are recovered by the existing cursor/Full path.
    let timer;
    try { await Promise.race([ready, new Promise(resolve => { timer = setTimeout(resolve, this.subscribeWaitMs); })]); }
    finally { clearTimeout(timer); }
  }
  /** A node Full supplies a location too. It never replaces full-field verification or an acceptance verdict. */
  remember(txid, accepting, context, {wake = true} = {}) {
    hash32(txid); hash32(accepting);
    const entry = this.entries.get(txid);
    if (this.stopped || !entry || !sameConnectionContext(context, queryContext(this.link))) return false;
    if (entry.hint?.accepting === accepting && sameConnectionContext(entry.hint.context, context)) entry.hint.at = this.now();
    else entry.hint = {txid, accepting, context, networkGenesis: this.net.genesis, at: this.now()};
    if (wake) this.signal(entry);
    return true;
  }
  signal(entry) { entry.version++; for (const wake of [...entry.waiters]) wake(); }
  invalidate() { for (const entry of this.entries.values()) { entry.hint = null; this.signal(entry); } }
  chain({rpc, data} = {}) {
    if (this.stopped || !data) return;
    if (rpc !== this.link.nodes?.[0]) return;
    const removed = data.removedChainBlockHashes;
    if (!Array.isArray(removed)) { this.invalidate(); return; }
    const gone = new Set(removed);
    for (const entry of this.entries.values()) if (entry.hint && gone.has(entry.hint.accepting)) {
      entry.hint = null; this.signal(entry);
    }
    const context = queryContext(rpc);
    if (!sameConnectionContext(context, queryContext(this.link))) return;
    const rows = data.acceptedTransactionIds;
    if (!Array.isArray(rows) || rows.length > 20000) return;
    const added = new Set(data.addedChainBlockHashes ?? []);
    let count = 0;
    for (const row of rows) {
      const ids = row?.acceptedTransactionIds;
      if (!/^[0-9a-f]{64}$/.test(row?.acceptingBlockHash ?? '') || !added.has(row.acceptingBlockHash) || !Array.isArray(ids)) continue;
      count += ids.length; if (count > 200000) { this.invalidate(); return; }
      for (const txid of ids) {
        const entry = this.entries.get(txid); if (!entry) continue;
        if (entry.hint?.accepting === row.acceptingBlockHash && sameConnectionContext(entry.hint.context, context)) continue;
        entry.hint = {txid, accepting: row.acceptingBlockHash, context, networkGenesis: this.net.genesis, at: this.now()};
        this.signal(entry);
      }
    }
  }
  peek(txid) {
    const hint = this.entries.get(txid)?.hint, age = hint ? this.now() - hint.at : -1;
    return hint && age >= 0 && age <= this.maxAgeMs && sameConnectionContext(hint.context, queryContext(this.link)) ? hint : null;
  }
  current(txid, hint) { return !!hint && this.peek(txid) === hint; }
  discard(txid, hint) {
    const entry = this.entries.get(txid);
    if (entry && entry.hint === hint) { entry.hint = null; this.signal(entry); }
  }
  wake(txid) { const entry = this.entries.get(txid); if (entry) this.signal(entry); }
  version(txid) { return this.entries.get(txid)?.version ?? 0; }
  /** Version handshake preserves a notification arriving during a prior verification (no lost wakeup). */
  async wait(txid, ms, since = 0) {
    if (this.stopped) throw failure('ACCEPTANCE_TRACKER_STOPPED');
    const entry = this.entries.get(txid);
    if (!entry || entry.version !== since) return this.version(txid);
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); entry.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(0, ms)); entry.waiters.add(done);
      if (this.stopped || entry.version !== since) done();
    });
    if (this.stopped) throw failure('ACCEPTANCE_TRACKER_STOPPED');
    return this.version(txid);
  }
  release(txid) {
    const entry = this.entries.get(txid); if (!entry) return;
    this.signal(entry); this.entries.delete(txid);
    if (!this.entries.size) {
      this.generation++; this.ready = null; this.retryAt = 0;
      this.link.unwatchAccepted?.(this.key); this.releaseLink?.(); this.releaseLink = null;
    }
  }
  stop() {
    if (this.stopped) return; this.stopped = true;
    this.off.forEach(off => off()); this.off = [];
    for (const txid of [...this.entries.keys()]) this.release(txid);
  }
}
