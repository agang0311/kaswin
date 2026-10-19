import {requireNet, linkNet} from '../chain/network-schema.mjs';
import {listRounds, roundDetail, ledgerFromDetail} from './rounds.mjs';
import {discoverRestRounds, RestRoundResolver, refreshRestCandidate} from './rest-rounds.mjs';

/** Explicit refresh only. Each provider owns its cursor; Indexer hashes never become REST offsets.
 * The Indexer gets a shorter budget than the generic fetch so an outage does not hold the first list paint. */
const INDEXER_MS = 6000;
export class RoundDiscovery {
  constructor({net, base, profile, rest = {}, evidence = null, list = listRounds, detail = roundDetail} = {}) {
    this.net = requireNet(net); rest = {...rest, net};
    Object.assign(this, {base, profile, rest, list, detail}); this.resolver = new RestRoundResolver(profile, {...rest, evidence});
  }
  async page({cursor = null, limit = 50, signal, fallback = true} = {}) {
    signal?.throwIfAborted();
    if (this.base && cursor?.source !== 'rest') {
      try { const p = await this.list(this.base, {net: this.net, cursor: cursor?.value ?? null, limit, signal, timeoutMs: INDEXER_MS});
        return {...p, source: 'indexer', nextCursor: p.nextCursor ? {source: 'indexer', value: p.nextCursor} : null};
      } catch (e) { signal?.throwIfAborted(); if (!fallback) throw e; }
    }
    const p = await discoverRestRounds(this.profile, {...this.rest, cursor: cursor?.source === 'rest' ? cursor.value : 0, limit, signal});
    return {...p, nextCursor: p.nextCursor === null ? null : {source: 'rest', value: p.nextCursor}};
  }
  async refresh({known = [], signal, pages = 4} = {}) {
    const items = new Map(); let cursor = null, source = null, coverage = null, rejected = 0, lastCheckpointAt = null;
    for (let i = 0; i < pages; i++) {
      let p;
      // Only the first page may switch provider; a later failure keeps the collected rows and the resumable cursor.
      try { p = await this.page({cursor, signal, fallback: i === 0}); }
      catch (e) { signal?.throwIfAborted(); if (i === 0) throw e; break; }
      source = p.source; coverage = p.coverage; rejected += p.rejected ?? 0; lastCheckpointAt = p.lastCheckpointAt ?? null;
      for (const row of p.items) items.set(row.cid, row);
      cursor = p.nextCursor; if (!cursor) break;
    }
    const targets = [...items.values()].slice(0, 100); let n = 0;
    // Same bounded detail budget for Indexer/REST; do not scan all historical rounds at startup.
    if (source === 'rest') for (const r of known.slice(0, 50)) if (!items.has(r.cid)) targets.push(r);
    await Promise.all(Array.from({length: 6}, async () => {
      while (n < targets.length) {
        const r = targets[n++]; signal?.throwIfAborted();
        try {
          const d = source === 'indexer' ? await this.detail(this.base, r.cid, {net: this.net, signal, timeoutMs: INDEXER_MS}) : await refreshRestCandidate(r, {...this.rest, signal});
          if (source === 'indexer' && !d.terminal) { try { ledgerFromDetail(d, this.profile); } catch {} }
          items.set(r.cid, {...d, _src: source === 'indexer' ? 'live' : 'rest'});
        } catch {
          signal?.throwIfAborted();
          const cur = items.get(r.cid) ?? r;
          items.set(r.cid, {...cur, _src: cur._src ?? 'cache'});
        }
      }
    }));
    return {items: [...items.values()], nextCursor: cursor, source, coverage, rejected, lastCheckpointAt};
  }
  async current(link, cid, {known = null, signal} = {}) {
    if (linkNet(link).genesis !== this.net.genesis) throw new Error('DISCOVERY_NETWORK_MISMATCH');
    const candidate = await this.candidate(cid, {known, signal});
    const run = pinned => this.resolver.resolve(pinned, cid, candidate, {signal});
    return typeof link.pinned === 'function' ? link.pinned(run, {signal}) : run(link);
  }
  async live(link, cid, options) {
    const r = await this.current(link, cid, options);
    if (!r.live) throw Object.assign(new Error(r.terminal ? '轮次已经结束，节点已核验' : '轮次正在补齐，暂不能操作'), {code: r.terminal ? 'NOT_LIVE' : 'STALE_TIP'});
    return r.live;
  }
  async candidate(cid, {known = null, signal} = {}) {
    if (known && (known._src === 'node' || known.verified)) {
      return known; // Node-verified proof (terminal or active) already in hand! Resolver verifies tip live on node.
    }
    try {
      if (!this.base) throw new Error('INDEXER_NOT_CONFIGURED');
      const row = await this.detail(this.base, cid, {net: this.net, signal, timeoutMs: INDEXER_MS});
      ledgerFromDetail(row, this.profile);
      return {...row, _src: 'live'};
    } catch {
      signal?.throwIfAborted();
      try {
        const restCandidate = await this.resolver.locate(cid, {signal});
        if (restCandidate) return {...restCandidate, _src: 'rest'};
      } catch {}
      return known ?? null;
    }
  }
}
