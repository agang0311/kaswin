// On-demand primary + hot standby. Only the primary is exposed in nodes: multi-call proofs never mix peers.
import {NodeLink, probeNode, host} from './nodes.mjs';
import {NodePool} from './node-pool.mjs';
import {failure, queryContext, sameQueryContext, withDeadline} from './operation.mjs';
import {checkServerIdentity} from './node-identity.mjs';
import {uint} from './json.mjs';

export class DualNodeLink extends NodeLink {
  constructor(urls, opts = {}) {
    super(urls, {...opts, heartbeat: false, timeoutMs: opts.timeoutMs ?? 10000});
    this.events = new Map(); this.members = new Map(); this.watches = new Map(); this.acceptedWatches = new Set(); this.generation = 0;
    this.pool = new NodePool(this.urls, {open: opts.open ?? (async url => {
      const rpc = await probeNode(url, {...this.opts, net: this.net});
      try { rpc.info.p2pId = (await rpc.call('getInfo', {}, 5000)).p2pId ?? null; } catch {}
      return rpc;
    }), ...opts.pool});
    this.fillTask = null; this.ctl = new AbortController(); this.users = 0; this.activeCalls = 0;
  }
  on(kind, fn) { if (!this.events.has(kind)) this.events.set(kind, new Set()); this.events.get(kind).add(fn); return () => this.events.get(kind)?.delete(fn); }
  publish(kind, value) { for (const fn of this.events.get(kind) ?? []) { try { fn(value); } catch {} } }
  status() { return {...super.status(), standby: [...this.members.keys()].filter(n => n !== this.nodes[0]).map(n => ({url: n.url, host: host(n.url), ...n.info})), pool: [...this.pool.health]}; }
  retain() { this.users++; clearTimeout(this.idleTimer); let released = false; return () => { if (released) return; released = true; this.users--; this.idle(); }; }
  idle() { clearTimeout(this.idleTimer); if (!this.users && !this.activeCalls) { this.idleTimer = setTimeout(() => this.close(), 15000); this.idleTimer.unref?.(); } }
  attach(rpc) {
    const offs = [rpc.on('disconnect', () => this.drop(rpc)), rpc.on('utxos', data => this.publish('utxos', {rpc, data})),
      rpc.on('chain-removals', ({unknown}) => { if (unknown && rpc === this.nodes[0]) this.publish('gap', {reason: 'chain-data-unknown'}); }),
      rpc.on('chain', data => {
        if (data.removedChainBlockHashes.length) {
          // A standby removal is a reason to recheck, never a verdict on primary acceptance.
          if (rpc !== this.nodes[0] && this.nodes[0]) {
            const primary = this.nodes[0];
            if (typeof primary.noteChainRemoval === 'function') primary.noteChainRemoval(data.removedChainBlockHashes, {hint: true});
            else primary.chainRevision++;
          }
          this.readViews.clear();
        }
        this.publish('chain', {rpc, data});
      })];
    this.members.set(rpc, {offs, addresses: new Set(), chain: false, accepted: false, queue: Promise.resolve()});
  }
  drop(rpc) {
    const m = this.members.get(rpc); if (!m) return;
    this.members.delete(rpc); m.offs.forEach(f => f()); this.pool.failed(rpc.url); rpc.close();
    if (this.nodes[0] === rpc) {
      this.nodes = [...this.members.keys()].filter(n => n.ws?.readyState === 1).slice(0, 1);
      this.generation++; this.readViews.clear(); this._anchor = null; this.publish('gap', {reason: 'failover'});
      if (this.nodes[0]) void this.sync(this.nodes[0]).catch(() => {}); // Promote the standby's reduced scope to accepted IDs.
    }
    this.emit(); if (this.users) this.fill();
  }
  async connect() {
    if (this.nodes[0]?.ws?.readyState === 1) { this.fill(); return this.nodes; }
    if (this.opening) return this.opening;
    if (this.ctl.signal.aborted) this.ctl = new AbortController();
    const signal = this.ctl.signal;
    const work = this.pool.acquire({signal}).then(async rpc => {
      if (signal.aborted) { rpc.close(); throw signal.reason; }
      this.attach(rpc); this.nodes = [rpc]; this.generation++; this.publish('gap', {reason: 'connect'}); this.emit();
      await this.sync(rpc); this.fill(); return this.nodes;
    });
    this.opening = work;
    try { return await work; } finally { if (this.opening === work) this.opening = null; this.idle(); }
  }
  /** Foreground liveness: share the health slot, actually read the server, and allow only the existing READ failover.
   * OPEN alone is insufficient after a frozen mobile connection. A cancelled probe never drops a shared socket. */
  async ensureResponsive({signal, timeoutMs = 15000} = {}) {
    const release = this.retain();
    try {
      return await withDeadline(async scope => {
        const info = await this.readView('health',
          () => this.call('getServerInfo', {}, Math.min(5000, this.rpcMs, scope.remaining()), {signal: scope.signal}),
          {maxAgeMs: 0, signal: scope.signal}, value => {
            checkServerIdentity(value, this.net.networkId);
            const daa = uint(value.virtualDaaScore);
            if (this.nodes[0]) this.nodes[0].info.daa = daa;
            this.emit();
          });
        scope.check(); checkServerIdentity(info, this.net.networkId); uint(info.virtualDaaScore);
        return info;
      }, {timeoutMs: Math.min(timeoutMs, 15000), signal, code: 'FOREGROUND_NODE_TIMEOUT'});
    } finally { release(); }
  }
  fill() {
    if (this.fillTask || this.ctl.signal.aborted || !this.nodes.length || this.members.size >= 2) return;
    const signal = this.ctl.signal;
    const task = this.pool.acquire({signal, exclude: new Set([...this.members.keys()].map(n => n.url)),
      identities: new Set([...this.members.keys()].map(n => n.info?.p2pId).filter(Boolean))}).then(async rpc => {
      if (signal.aborted) { rpc.close(); return; }
      this.attach(rpc); await this.sync(rpc); this.emit();
    }).catch(() => {}).finally(() => { if (this.fillTask === task) this.fillTask = null; });
    this.fillTask = task;
  }
  sync(rpc) {
    const m = this.members.get(rpc); if (!m) return Promise.resolve();
    const work = m.queue.catch(() => {}).then(async () => {
      if (!this.members.has(rpc)) return;
      const wanted = new Set([...this.watches.values()].flatMap(x => [...x]));
      const added = [...wanted].filter(a => !m.addresses.has(a)), removed = [...m.addresses].filter(a => !wanted.has(a));
      const chain = this.watches.size > 0 || this.acceptedWatches.size > 0;
      const accepted = this.acceptedWatches.size > 0 && rpc === this.nodes[0];
      if (chain && (!m.chain || m.accepted !== accepted)) {
        // Fixed notify subscription semantics replace Reduced/All on Start, without an unsubscribe gap.
        await rpc.subscribeChain(true, {includeAcceptedTransactionIds: accepted}); m.chain = true; m.accepted = accepted;
      }
      // Subscribe successor first; periodic catch-up closes the address transition window.
      if (added.length) { await rpc.subscribe(added); added.forEach(a => m.addresses.add(a)); }
      if (removed.length) { await rpc.subscribe(removed, false); removed.forEach(a => m.addresses.delete(a)); }
      if (!chain && m.chain) { await rpc.subscribeChain(false, {includeAcceptedTransactionIds: m.accepted}); m.chain = false; m.accepted = false; }
    });
    m.queue = work; return work.catch(e => { if (rpc === this.nodes[0]) this.publish('gap', {reason: 'subscription-unavailable'}); throw e; });
  }
  async watch(key, addresses) {
    this.watches.set(key, new Set(addresses)); await this.connect();
    const primary = this.nodes[0];
    if (!primary) throw failure('READ_VIEW_CHANGED');
    // Only the primary's scope fences its proof. A slow/unavailable standby cannot hold a current primary read.
    for (const rpc of this.members.keys()) if (rpc !== primary) void this.sync(rpc).catch(() => {});
    await this.sync(primary);
    if (this.nodes[0] !== primary) throw failure('READ_VIEW_CHANGED');
  }
  unwatch(key) { this.watches.delete(key); for (const n of this.members.keys()) void this.sync(n).catch(() => {}); }
  /** Own pending records keep chain subscriptions independently of a visible round. IDs only on the primary. */
  async watchAccepted(key) {
    this.acceptedWatches.add(key); await this.connect();
    const primary = this.nodes[0];
    if (!primary) throw failure('READ_VIEW_CHANGED');
    // The hot standby is best-effort: it must not add a second peer's subscription RTT to the submit path.
    for (const n of this.members.keys()) if (n !== primary) void this.sync(n).catch(() => {});
    await this.sync(primary);
    if (this.nodes[0] !== primary) throw failure('READ_VIEW_CHANGED');
  }
  unwatchAccepted(key) { this.acceptedWatches.delete(key); for (const n of this.members.keys()) void this.sync(n).catch(() => {}); }
  /** A multi-RPC verification is pinned. On failover its caller retries the WHOLE verification, not a middle read. */
  async pinned(task, {signal, retries = 2} = {}) {
    const release = this.retain();
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        signal?.throwIfAborted();
        try {
          const [rpc] = await this.connect(), generation = this.generation, socket = rpc.ws, epoch = rpc.epoch;
          const check = () => {
            signal?.throwIfAborted();
            if (generation !== this.generation || rpc !== this.nodes[0] || rpc.ws !== socket || rpc.epoch !== epoch || rpc.ws?.readyState !== 1) {
              throw failure('READ_VIEW_CHANGED');
            }
          };
          const member = {url: rpc.url, info: rpc.info, readContext: () => queryContext(rpc), call: (...args) => link.call(...args)};
          const link = {nodes: [member], net: this.net, connect: async () => { check(); return [member]; }, readContext: () => queryContext(rpc),
            call: async (method, args, ms, options = {}) => { check(); const r = await rpc.call(method, args, ms, {...options, signal}); check(); return r; },
            currentDaa: async () => { const r = await link.call('getServerInfo', {}); return BigInt(r.virtualDaaScore); }};
          checkServerIdentity(await link.call('getServerInfo', {}), this.net.networkId);
          check(); const value = await task(link); check(); return value;
        } catch (e) {
          if (attempt < retries && (e?.code === 'READ_VIEW_CHANGED' || e?.message === 'READ_VIEW_CHANGED') && !signal?.aborted) {
            await new Promise(r => setTimeout(r, 200));
            continue;
          }
          throw e;
        }
      }
    } finally { release(); }
  }
  async call(method, params, timeoutMs = this.rpcMs, options = {}) {
    const submit = method === 'submitTransaction' || method === 'submitTransactionReplacement';
    this.activeCalls++; clearTimeout(this.idleTimer);
    try {
      for (let i = 0; i < (submit ? 1 : 2); i++) {
        options.signal?.throwIfAborted(); const [rpc] = await this.connect();
        try { return await rpc.call(method, params, timeoutMs, options); }
        catch (e) {
          if (submit || options.signal?.aborted || e?.rpc !== undefined) throw e;
          this.drop(rpc); if (i === 1) throw e;
        }
      }
    } finally { this.activeCalls--; this.idle(); }
  }
  close(emit = true) {
    this.ctl.abort(failure('CONNECTION_CANCELLED')); this.generation++; clearTimeout(this.idleTimer);
    for (const [n, m] of this.members) { m.offs.forEach(f => f()); n.close(); }
    this.members.clear(); this.nodes = []; this.readViews.clear(); this._anchor = null;
    this.opening = null; this.fillTask = null;
    this.publish('gap', {reason: 'closed'}); if (emit) this.emit();
  }
}
