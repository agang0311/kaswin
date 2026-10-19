// Runtime-only selected-chain evidence. Never accepts REST/disk/DOM receipts or sends transactions.
import {hash32, ensure} from '../core.mjs';
import {linkNet} from './network-schema.mjs';
import {acceptedAt, acceptanceFromPage} from './chain.mjs';
import {observeAcceptanceRead} from './acceptance-read.mjs';
import {queryContext, sameConnectionContext, sameQueryContext, failure, withDeadline, scopedLink} from './operation.mjs';

function join(work, signal) {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, {once: true});
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export class AcceptanceEvidence {
  constructor({link, profileId, maxAgeMs = 2000, maxEntries = 64, now = Date.now} = {}) {
    this.net = linkNet(link); hash32(profileId);
    ensure(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 2000 && Number.isSafeInteger(maxEntries) && maxEntries > 0 && maxEntries <= 64, 'EVIDENCE_BUDGET');
    Object.assign(this, {link, profileId, maxAgeMs, maxEntries, now});
    this.entries = new Map(); this.watches = new Map(); this.tasks = new Map(); this.scopes = new Set();
    this.sessions = new WeakMap(); this.pages = new WeakMap(); this.metadata = new WeakMap(); this.listeners = new Set();
    this.ctl = new AbortController(); this.stopped = false;
  }
  track(txid) { this.check(); hash32(txid); if (!this.watches.has(txid)) this.watches.set(txid, {last: null}); }
  suppressKnown(txid, accepting) {
    const watch = this.watches.get(txid);
    if (watch && !watch.last && /^[0-9a-f]{64}$/.test(accepting ?? '')) watch.last = {accepting, context: queryContext(this.link)};
    // Notification suppression only: this never creates evidence or skips a fresh depth check.
  }
  release(txid) { this.watches.delete(txid); }
  onProof(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  check(link = this.link) {
    if (this.stopped) throw failure('ACCEPTANCE_TRACKER_STOPPED');
    ensure(linkNet(link).genesis === this.net.genesis, 'EVIDENCE_NETWORK_MISMATCH');
  }
  valid(entry) {
    return !!entry && !this.stopped && entry.session.scope.current(entry.ev.accepting) &&
      sameConnectionContext(entry.context, queryContext(this.link));
  }
  copy(entry) {
    const ev = structuredClone(entry.ev); this.metadata.set(ev, entry);
    let closed = false;
    const current = hash => !closed && hash === entry.ev.accepting && this.valid(entry);
    return {ev, virtualDaa: entry.virtualDaa, origin: entry.origin, context: entry.context,
      scope: {context: entry.context, current, check: hash => { if (!current(hash)) throw failure('READ_VIEW_CHANGED'); }, close: () => { closed = true; }}};
  }
  peek(txid, {accepting = null, minDaa = 0n} = {}) {
    const entry = this.entries.get(txid), age = entry ? this.now() - entry.at : -1;
    if (!entry || age < 0 || age > this.maxAgeMs || !this.valid(entry)) { this.entries.delete(txid); return null; }
    if ((accepting && accepting !== entry.ev.accepting) || entry.virtualDaa < minDaa) return null;
    return this.copy(entry);
  }
  has(txid) { const proof = this.peek(txid); proof?.scope.close(); return !!proof; }
  readDaa(ev) {
    const entry = this.metadata.get(ev);
    return this.valid(entry) && entry.ev.txid === ev.txid && entry.ev.accepting === ev.accepting && entry.ev.acceptingDaa === ev.acceptingDaa ? entry.virtualDaa : null;
  }
  #publish(session, ev) {
    this.check(); session.scope.check(ev.accepting);
    ensure(typeof session.virtualDaa === 'bigint', 'EVIDENCE_READ_DAA');
    const key = `${ev.txid}/${ev.accepting}`;
    let entry = session.entries.get(key);
    if (!entry) {
      entry = {ev: structuredClone(ev), virtualDaa: session.virtualDaa, context: session.scope.context, origin: session.origin, session, at: this.now()};
      session.entries.set(key, entry);
      while (session.entries.size > this.maxEntries) session.entries.delete(session.entries.keys().next().value);
      this.entries.delete(ev.txid); this.entries.set(ev.txid, entry);
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
      const watch = this.watches.get(ev.txid), last = watch?.last;
      // Only a NEW acceptance location wakes consumers; depth rechecks must not create a self-waking follow loop.
      if (watch && (!last || last.accepting !== ev.accepting || !sameConnectionContext(last.context, entry.context))) {
        watch.last = {accepting: ev.accepting, context: entry.context};
        for (const fn of this.listeners) { try { fn(this.copy(entry)); } catch {} }
      }
    } else if (ev.confirmations !== null) {
      entry.ev.confirmations = ev.confirmations; // same captured Full; retain the more precise sink-depth annotation
    }
    this.metadata.set(ev, entry);
    return entry;
  }
  fromPage(link, page, txid, accepting, sink = null) {
    const session = this.pages.get(page);
    ensure(session && this.sessions.get(link) === session, 'EVIDENCE_PAGE_CONTEXT');
    const ev = acceptanceFromPage(page, txid, accepting, sink);
    session.scope.check(accepting);
    this.metadata.set(ev, {ev: structuredClone(ev), virtualDaa: session.virtualDaa, context: session.scope.context, session});
    return ev;
  }
  async capture(link, task, {origin = null, signal, wanted = []} = {}) {
    this.check(link); signal?.throwIfAborted();
    if (this.sessions.has(link)) return task(link, this.sessions.get(link));
    const scope = await observeAcceptanceRead(link, this.link);
    const session = {scope, origin, virtualDaa: null, entries: new Map(), timer: null};
    this.scopes.add(session);
    while (this.scopes.size > this.maxEntries) {
      const old = this.scopes.values().next().value; clearTimeout(old.timer); old.scope.close(); this.scopes.delete(old);
    }
    const close = () => { clearTimeout(session.timer); scope.close(); this.scopes.delete(session); };
    try {
      signal?.throwIfAborted(); this.check(link);
      const currentDaa = async (...args) => {
        const daa = await link.currentDaa(...args); signal?.throwIfAborted();
        if (session.virtualDaa === null) session.virtualDaa = daa; // never freshen an earlier Full with a later DAA
        return daa;
      };
      const view = {net: this.net, nodes: link.nodes, readContext: () => queryContext(link),
        connect: link.connect ? (...args) => link.connect(...args) : undefined, currentDaa,
        call: async (method, args, ms, options) => {
          signal?.throwIfAborted(); scope.check('');
          const full = method === 'getVirtualChainFromBlockV2' && args?.dataVerbosityLevel === 'Full';
          if (full && session.virtualDaa === null) await currentDaa();
          const result = await link.call(method, args, ms, options); signal?.throwIfAborted(); this.check(link);
          if (full) {
            this.pages.set(result, session);
            const targets = new Set([...this.watches.keys(), ...wanted]);
            for (const row of result.chainBlockAcceptedTransactions ?? []) for (const raw of row.acceptedTransactions ?? []) {
              const txid = raw.verboseData?.transactionId;
              if (!targets.has(txid)) continue;
              try { this.#publish(session, acceptanceFromPage(result, txid, row.chainBlockHeader.hash)); } catch {} // invalid data is never evidence
            }
          }
          return result;
        }};
      this.sessions.set(view, session);
      const result = await task(view, session);
      signal?.throwIfAborted(); this.check(link);
      const accepting = result?.view?.accepting ?? result?.ev?.accepting;
      if (accepting) scope.check(accepting);
      return result;
    } finally {
      if (!session.entries.size || this.stopped || !this.scopes.has(session)) close();
      else {
        // TTL governs NEW reuse. Keep the observer through existing consumers' asynchronous result persistence.
        session.timer = setTimeout(close, 30000); session.timer.unref?.();
        while (this.scopes.size > this.maxEntries) {
          const old = this.scopes.values().next().value; clearTimeout(old.timer); old.scope.close(); this.scopes.delete(old);
        }
      }
    }
  }
  async read(txid, accepting, {link = this.link, fresh = false, minDaa = 0n, origin = null, signal} = {}) {
    hash32(txid); hash32(accepting); this.check(link); signal?.throwIfAborted();
    ensure(typeof minDaa === 'bigint' && minDaa >= 0n, 'EVIDENCE_READ_DAA');
    await link.connect?.(); this.check(link); signal?.throwIfAborted();
    if (!fresh) { const hit = this.peek(txid, {accepting, minDaa}); if (hit) return hit; }
    const context = queryContext(link);
    ensure(sameConnectionContext(context, queryContext(this.link)), 'EVIDENCE_CONNECTION_MISMATCH');
    const key = `${txid}/${accepting}/${minDaa}`;
    let pending = this.tasks.get(key);
    if (!pending || !sameQueryContext(pending.context, context)) {
      const task = withDeadline(async budget => {
        const run = view => this.capture(view, async (shared, session) => {
          await shared.currentDaa();
          const ev = await acceptedAt(shared, txid, accepting);
          ensure(session.virtualDaa >= minDaa, 'EVIDENCE_DEPTH_PENDING');
          return this.#publish(session, ev);
        }, {origin, signal: budget.signal, wanted: [txid]});
        return this.link.pinned ? this.link.pinned(run, {signal: budget.signal, retries: 0}) : run(scopedLink(this.link, budget));
      }, {timeoutMs: 30000, signal: this.ctl.signal, code: 'ACCEPTANCE_READ_TIMEOUT'});
      pending = {context, task}; this.tasks.set(key, pending);
      // Both branches observe the task even if every individual consumer cancels its own wait.
      void task.then(() => { if (this.tasks.get(key) === pending) this.tasks.delete(key); }, () => { if (this.tasks.get(key) === pending) this.tasks.delete(key); });
    }
    const entry = await join(pending.task, signal); this.check(link); signal?.throwIfAborted();
    if (!sameConnectionContext(context, queryContext(this.link)) || !this.valid(entry)) throw failure('READ_VIEW_CHANGED');
    return this.copy(entry);
  }
  dispose() {
    if (this.stopped) return;
    this.stopped = true; this.ctl.abort(failure('ACCEPTANCE_TRACKER_STOPPED'));
    for (const session of this.scopes) { clearTimeout(session.timer); session.scope.close(); }
    this.scopes.clear(); this.entries.clear(); this.watches.clear(); this.listeners.clear();
  }
}
