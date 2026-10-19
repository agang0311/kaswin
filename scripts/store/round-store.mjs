import {PROFILE_ID, hash32} from '../core.mjs';
import {checkRow} from '../round/rounds.mjs';
import {terminalSettled} from '../tracking/terminal-state.mjs';

/** Per-session views with optional persistence. Persisted verification is never current-session authority. */
export class RoundStore {
  constructor(openStore = null, {network, profile = PROFILE_ID} = {}) {
    this.network = hash32(network, '网络 Genesis');
    this.openStore = openStore; this.prefix = `${network}/${profile}/round/`; this.rows = new Map(); this.listeners = new Set(); this.revisions = new Map();
    this.loaded = null; this.queue = Promise.resolve(); this.backend = null;
  }
  async load() {
    return this.loaded ??= (async () => {
      try {
        this.backend = this.openStore ? await this.openStore() : null;
        for (const x of await this.backend?.list(this.prefix) ?? []) {
          const r = x.record.value;
          try { const view = r.view ? checkRow(r.view, {cached: true}) : null;
            if (view && view.cid !== r.cid) continue;
            const isTerm = !!(r.terminalVerified && terminalSettled(view, r.terminalCheck));
            this.rows.set(hash32(r.cid), {
              ...r,
              verified: isTerm,
              observed: isTerm,
              terminalVerified: isTerm,
              replay: r.replay ?? null,
              view: view ? {...view, terminalSettled: isTerm, _src: isTerm ? 'node' : 'cache'} : null
            });
          } catch {}
        }
      } catch { this.backend = null; }
    })();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  begin(cid) { const n = (this.revisions.get(cid) ?? 0) + 1; this.revisions.set(cid, n); return n; }
  invalidate(cid, {terminal = false, revision = null} = {}) {
    if (revision !== null && this.revisions.get(cid) !== revision) return;
    this.begin(cid); const r = this.rows.get(cid);
    if (r && (terminal || !r.terminalVerified)) {
      r.verified = false;
      if (terminal) { r.terminalVerified = false; r.terminalCheck = null; }
      if (r.view) r.view = {...r.view, terminalSettled: false, _src: 'cache'};
      if (terminal && r.view?.terminal) this.persist(cid, r);
    }
  }
  async list() { await this.load(); return [...this.rows.values()].map(x => structuredClone(x)); }
  async get(cid) { await this.load(); return structuredClone(this.rows.get(hash32(cid)) ?? null); }
  async remember(cid, {view = null, source, mine = null, revision = null, verified = false, replay = null, terminalCheck = null} = {}) {
    hash32(cid); await this.load();
    if (revision !== null && this.revisions.get(cid) !== revision) return null;
    if (view) { view = checkRow(structuredClone(view), {cached: true}); if (view.cid !== cid) throw new Error('ROUND_STORE_CID'); }
    const old = this.rows.get(cid) ?? {cid, sources: [], firstSeenAt: Date.now(), view: null, mine: false};
    // Fresh node observations may roll back progress. External list responses cannot overwrite them.
    const keep = old.observed && !verified;
    const finalView = keep ? old.view : view ?? old.view;
    const same = finalView?.latestTxid === old.view?.latestTxid && finalView?.accepting === old.view?.accepting && finalView?.terminal === old.view?.terminal;
    const check = verified ? terminalCheck : same ? old.terminalCheck ?? null : null;
    const isTerm = !!((verified || old.terminalVerified) && terminalSettled(finalView, check));
    if (finalView?.terminal) finalView.terminalSettled = isTerm;
    const next = {...old, view: finalView, verified: keep ? old.verified : verified, observed: old.observed || verified,
      terminalVerified: isTerm, terminalCheck: check, replay: replay ?? (same ? old.replay ?? null : null),
      sources: [...new Set([...old.sources, source].filter(Boolean))], mine: old.mine || mine === true, updatedAt: Date.now()};
    this.rows.set(cid, next);
    for (const fn of this.listeners) { try { fn(structuredClone(next)); } catch {} }
    this.persist(cid, {...next, verified: isTerm});
    return structuredClone(next);
  }
  persist(cid, value) {
    const snapshot = structuredClone(value);
    // Ordered revocations also fence a terminal result invalidated while an earlier disk write was in flight.
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!this.backend) return;
      const key = this.prefix + cid, current = await this.backend.get(key);
      await this.backend.compareAndSet(key, current?.revision ?? null, snapshot);
    }).catch(() => { this.backend = null; });
  }
  async forget(cid) {
    await this.load(); this.invalidate(cid); this.rows.delete(cid);
    this.queue = this.queue.catch(() => {}).then(async () => { if (!this.backend) return; const k = this.prefix + hash32(cid), cur = await this.backend.get(k); if (cur) await this.backend.remove(k, cur.revision); }).catch(() => { this.backend = null; });
    await this.queue;
  }
}
