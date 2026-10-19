// Bounded candidate pool. No imports with network side effects; open() must verify identity/capabilities.
export class NodePool {
  constructor(urls, {open, now = Date.now, cooldownMs = 30000} = {}) {
    this.urls = [...new Set(urls)]; this.open = open; this.now = now; this.cooldownMs = cooldownMs;
    this.health = new Map();
  }
  failed(url) {
    const old = this.health.get(url) ?? {};
    this.health.set(url, {...old, failures: (old.failures ?? 0) + 1, until: this.now() + this.cooldownMs});
  }
  async acquire({exclude = new Set(), identities = new Set(), signal} = {}) {
    // Preserve user ordering on first use; successful measured nodes precede unknown candidates later.
    const candidates = this.urls.filter(u => !exclude.has(u) && (this.health.get(u)?.until ?? 0) <= this.now())
      .sort((a, b) => (this.health.get(a)?.rtt ?? Infinity) - (this.health.get(b)?.rtt ?? Infinity));
    for (const url of candidates) {
      signal?.throwIfAborted();
      let rpc;
      try {
        const start = this.now(); rpc = await this.open(url);
        signal?.throwIfAborted();
        const id = rpc.info?.p2pId;
        if (id && identities.has(id)) { rpc.close(); continue; }
        this.health.set(url, {rtt: this.now() - start, failures: 0, until: 0}); return rpc;
      } catch (e) { rpc?.close(); if (signal?.aborted) throw signal.reason; this.failed(url); }
    }
    throw new Error('POOL_NO_ELIGIBLE_NODE');
  }
}
