/** Browser session records with optional IndexedDB persistence. No wallet, network or filesystem access.
 * A backend outage keeps this session's exact records; application conflicts are never treated as outages.
 * Existing durable rows are read, never cleared or migrated. Session mode provides no cross-tab guarantee. */
const copy = x => structuredClone(x);
const semantic = e => /^(STALE_CACHE_REVISION|INTENT_ALREADY_EXISTS|INPUT_ALREADY_RESERVED|SUBMIT_LEASE_LOST|REPLACEMENT_|RESERVATION_|INPUT_RESERVATION_|DUPLICATE_INPUT|ATOMIC_CHECK_)/.test(e?.message ?? '');
export class SessionStore {
  constructor(openStore = null, {timeoutMs = 1500} = {}) {
    this.openStore = openStore; this.timeoutMs = timeoutMs;
    this.rows = new Map(); this.backend = null; this.ready = null; this.queue = Promise.resolve();
    this.persistent = false;
  }
  init() {
    return this.ready ??= (async () => {
      if (!this.openStore) return;
      let timer, expired = false;
      const opening = Promise.resolve().then(() => this.openStore()).then(async store => {
        if (expired) { store.close?.(); return null; }
        try {
          if (!['get', 'list', 'compareAndSet', 'insertIfAbsentWithCheck'].every(k => typeof store[k] === 'function')) throw Error('STORE_CAPABILITY');
          const rows = await store.list('');
          if (expired) { store.close?.(); return null; }
          return {store, rows};
        } catch (e) { store.close?.(); throw e; }
      });
      try {
        const result = await Promise.race([opening, new Promise(resolve => {
          timer = setTimeout(() => { expired = true; resolve(null); }, this.timeoutMs);
        })]);
        if (result) {
          for (const r of result.rows) this.rows.set(r.key, copy(r.record));
          this.backend = result.store; this.persistent = true;
        }
      } catch { expired = true; }
      finally { clearTimeout(timer); }
    })();
  }
  run(task) {
    const next = this.queue.then(async () => { await this.init(); return task(); });
    this.queue = next.catch(() => {});
    return next;
  }
  degrade() {
    try { this.backend?.close?.(); } catch {}
    this.backend = null; this.persistent = false;
  }
  async backendTask(task) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('OPTIONAL_STORE_TIMEOUT')), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async read(method, arg) {
    if (this.backend) {
      try {
        const value = await this.backendTask(() => this.backend[method](arg));
        if (method === 'get') {
          if (value) this.rows.set(arg, copy(value)); else this.rows.delete(arg);
        } else {
          for (const k of this.rows.keys()) if (k.startsWith(arg)) this.rows.delete(k);
          for (const r of value) this.rows.set(r.key, copy(r.record));
        }
      } catch { this.degrade(); }
    }
  }
  get(key) { return this.run(async () => { await this.read('get', key); return copy(this.rows.get(key) ?? null); }); }
  list(prefix) { return this.run(async () => { await this.read('list', prefix); return this.select(prefix); }); }
  select(prefix) { return [...this.rows].filter(([k]) => k.startsWith(prefix)).map(([key, record]) => ({key, record: copy(record)})); }
  compareAndSet(key, revision, value) {
    return this.run(async () => {
      if (this.backend) {
        try {
          const row = await this.backendTask(() => this.backend.compareAndSet(key, revision, value));
          this.rows.set(key, copy(row)); return copy(row);
        } catch (e) { if (semantic(e)) throw e; this.degrade(); }
      }
      const old = this.rows.get(key);
      if ((old?.revision ?? null) !== revision) throw Error('STALE_CACHE_REVISION');
      const row = {revision: (old?.revision ?? -1) + 1, value: copy(value)};
      this.rows.set(key, row); return copy(row);
    });
  }
  insertIfAbsentWithCheck(key, value, prefix, inspect) {
    return this.run(async () => {
      if (this.backend) {
        let inspectionError;
        try {
          const row = await this.backendTask(() => this.backend.insertIfAbsentWithCheck(key, value, prefix, rows => {
            try {
              const result = inspect(rows);
              if (result !== undefined) {
                if (result?.then) Promise.resolve(result).catch(() => {});
                throw Error('ATOMIC_CHECK_MUST_BE_SYNCHRONOUS');
              }
            } catch (e) { inspectionError = e; throw e; }
          }));
          this.rows.set(key, copy(row)); return copy(row);
        } catch (e) { if (inspectionError || semantic(e)) throw inspectionError ?? e; this.degrade(); }
      }
      if (this.rows.has(key)) throw Error('INTENT_ALREADY_EXISTS');
      const outcome = inspect(this.select(prefix));
      if (outcome !== undefined) {
        if (outcome?.then) Promise.resolve(outcome).catch(() => {});
        throw Error('ATOMIC_CHECK_MUST_BE_SYNCHRONOUS');
      }
      const row = {revision: 0, value: copy(value)};
      this.rows.set(key, row); return copy(row);
    });
  }
  remove(key, revision) {
    return this.run(async () => {
      if (this.backend) {
        try { await this.backendTask(() => this.backend.remove(key, revision)); this.rows.delete(key); return; }
        catch (e) { if (semantic(e)) throw e; this.degrade(); }
      }
      if (this.rows.get(key)?.revision !== revision) throw Error('STALE_CACHE_REVISION');
      this.rows.delete(key);
    });
  }
}
