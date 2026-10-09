/** Persistent round catalogue (IndexedDB, same origin). It remembers every round this browser has seen, created,
 * bought into, or opened by CID, with the last indexer/chain view, so a refresh never "loses" a round.
 * Cached views are display data only: every action re-reads the round and re-verifies it on the configured active node.
 */
import {IndexedStore, NETWORK_GENESIS, PROFILE_ID, hash32} from './core.mjs';
import {compareProgress} from './progress.mjs';

const PREFIX = `${NETWORK_GENESIS}/${PROFILE_ID}/round/`;
const STORE = 'kaswin-opus-rounds';

export class RoundCatalog {
  constructor(openStore = () => IndexedStore.open(STORE)) { this.openStore = openStore; this.p = null; }
  store() { return this.p ??= this.openStore(); }
  /** All remembered rounds: [{cid, view, sources:Set-like array, firstSeenAt, updatedAt, mine}] */
  async list() {
    try { return (await (await this.store()).list(PREFIX)).map(r => r.record.value); } catch { return []; }
  }
  async get(cid) { try { return (await (await this.store()).get(PREFIX + hash32(cid)))?.value ?? null; } catch { return null; } }
  /** Upsert; `view` is an indexer-shaped row (with or without detail). A view replaces the remembered one unless the
   * remembered one is further along the round's state machine (timestamps from different machines are not compared). */
  async remember(cid, {view = null, source, mine = null} = {}) {
    hash32(cid);
    const s = await this.store(), k = PREFIX + cid;
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await s.get(k), old = cur?.value ?? {cid, sources: [], firstSeenAt: Date.now(), view: null, mine: false};
      const keepOld = old.view && view && old.view.state && compareProgress(old.view, view) > 0;
      const next = {...old, view: keepOld ? old.view : (view ?? old.view), sources: [...new Set([...(old.sources ?? []), source].filter(Boolean))],
        mine: old.mine || mine === true, updatedAt: Date.now()};
      try { await s.compareAndSet(k, cur?.revision ?? null, next); return next; } catch (e) { if (attempt === 3) throw e; }
    }
    return null;
  }
  async forget(cid) {
    const s = await this.store(), k = PREFIX + hash32(cid), cur = await s.get(k);
    if (cur) await s.remove(k, cur.revision);
  }
}
