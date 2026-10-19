/** Direct JSON wRPC (no SDK/WASM) to ONE explicitly configured Kaspa network/node.
 * Trust model (project decision 2026-10-02): the page relies on Kaspa consensus as served by the configured node;
 * endpoint/network defaults belong to the caller. There is no independent-consensus quorum here.
 * Value safety comes from L1 covenant validation and the page's own approved transaction/signature checks.
 * Message format (rusty-kaspa cfafeb4 / workflow-rpc): request {id,method,params}; response {id,params} or {id,error}.
 */
import {parseJson, jsonText, uint} from './json.mjs';
import {ensure, hash32, errorText} from '../core.mjs';
import {requireSubmitPermission} from '../release-safety.mjs';
import {parseFeeEstimate} from './feetiers.mjs';
import {LIMITS, withDeadline, scopedLink, pause, failure, requireSyncPermission, queryContext, sameQueryContext, sameConnectionContext} from './operation.mjs';
import {assertNodeNetwork, checkServerIdentity} from './node-identity.mjs';
import {requireNet} from './network-schema.mjs';

const READ = new Set(['getServerInfo', 'getInfo', 'getBlockDagInfo', 'getSink', 'getSinkBlueScore', 'getBlock', 'getUtxosByAddresses',
  'getVirtualChainFromBlock', 'getVirtualChainFromBlockV2', 'getFeeEstimate', 'getFeeEstimateExperimental', 'getSeqCommitLaneProof', 'getMempoolEntriesByAddresses', 'getMempoolEntry']);
const MAX_FRAME = 64 * 1024 * 1024;

/** Node endpoint: wss:// or ws:// (e.g. your own kaspad with `--rpclisten-json` on the LAN). */
export function nodeUrl(v) {
  const u = new URL(String(v).trim());
  ensure(u.protocol === 'wss:' || u.protocol === 'ws:', '节点地址必须以 wss:// 或 ws:// 开头');
  ensure(!u.username && !u.password && !u.search && !u.hash, '节点地址不能包含凭据、查询参数或片段');
  return u.href;
}

export class JsonRpc {
  constructor(url, {timeoutMs = 30_000, maxTimeoutMs = Infinity, WebSocketImpl = globalThis.WebSocket, net = null} = {}) {
    this.url = nodeUrl(url); this.timeoutMs = timeoutMs; this.maxTimeoutMs = maxTimeoutMs; this.WS = WebSocketImpl; this.net = net;
    this.ws = null; this.next = 0; this.pending = new Map(); this.info = null; this.closed = false;
    this.epoch = 0; this.chainRevision = 0; this.events = new Map();
    this.chainBlocks = new Map(); this.chainBlocksRevision = 0;
    this.chainWanted = false; this.chainAccepted = false; this.chainActive = false; this.chainScope = false;
    this.chainCoverage = null; this.chainLeaseUntil = 0; this.chainSession = 0; this.chainQueue = Promise.resolve();
  }
  on(kind, fn) {
    if (!this.events.has(kind)) this.events.set(kind, new Set());
    this.events.get(kind).add(fn); return () => this.events.get(kind)?.delete(fn);
  }
  notify(kind, data) { for (const fn of this.events.get(kind) ?? []) { try { fn(data); } catch {} } }
  async subscribe(addresses, enabled = true) {
    ensure(Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 256, 'SUBSCRIPTION_ADDRESSES');
    return this.call(enabled ? 'subscribe' : 'unsubscribe', {UtxosChanged: {addresses}});
  }
  async subscribeChain(enabled = true, {includeAcceptedTransactionIds = false} = {}) {
    ensure(typeof includeAcceptedTransactionIds === 'boolean', 'CHAIN_SUBSCRIPTION_SCOPE');
    this.chainWanted = enabled; this.chainAccepted = includeAcceptedTransactionIds;
    return this.syncChainSubscription();
  }
  // Logical manager demand and short verifier leases share ONE scope; neither can unsubscribe the other.
  syncChainSubscription() {
    const session = this.chainSession;
    const work = this.chainQueue.catch(() => {}).then(async () => {
      if (session !== this.chainSession) throw failure('READ_VIEW_CHANGED');
      const wanted = this.chainWanted || Date.now() < this.chainLeaseUntil;
      const accepted = this.chainWanted && this.chainAccepted;
      if (wanted && this.chainActive && this.chainCoverage && this.chainScope === accepted) return;
      if (!wanted && !this.chainActive) return;
      if (!wanted) this.chainCoverage = null; // revoke before the asynchronous unsubscribe
      try {
        await this.call(wanted ? 'subscribe' : 'unsubscribe', {VirtualChainChanged: {include_accepted_transaction_ids: accepted}});
        if (session !== this.chainSession || this.ws?.readyState !== 1) throw failure('READ_VIEW_CHANGED');
        this.chainActive = wanted; this.chainScope = accepted;
        this.chainCoverage = wanted ? this.chainCoverage ?? Object.freeze({socket: this.ws, epoch: this.epoch}) : null;
      } catch (e) {
        if (session === this.chainSession) { this.chainActive = false; this.chainCoverage = null; }
        throw e;
      }
    });
    this.chainQueue = work; return work;
  }
  refreshChainLease() {
    this.chainLeaseUntil = Date.now() + LIMITS.rpcMs * 2;
    clearTimeout(this.chainLeaseTimer);
    this.chainLeaseTimer = setTimeout(() => {
      this.chainLeaseUntil = 0;
      void this.syncChainSubscription().catch(() => {});
    }, LIMITS.rpcMs * 2);
    this.chainLeaseTimer.unref?.();
  }
  async holdChainObservation() {
    await this.connect();
    if (this.chainBlocksRevision !== this.chainRevision) this.noteChainRemoval(null);
    const session = this.chainSession;
    this.refreshChainLease(); // Also clean up a lease whose subscription attempt fails or outlives its caller.
    await this.syncChainSubscription();
    if (session !== this.chainSession || !this.chainActive || !this.chainCoverage) throw failure('CHAIN_OBSERVATION_REQUIRED');
    this.refreshChainLease();
    return this.chainCoverage;
  }
  chainObservationCurrent(coverage) {
    return !!coverage && coverage === this.chainCoverage && this.chainActive && this.ws === coverage.socket &&
      this.epoch === coverage.epoch && this.ws?.readyState === 1 && this.chainBlocksRevision === this.chainRevision;
  }
  // Bounded invalidation metadata, NOT a membership proof. Callers still read getBlock on this connection.
  observeChainBlock(hash) {
    hash32(hash);
    if (this.chainBlocksRevision !== this.chainRevision) {
      for (const entry of this.chainBlocks.values()) entry.revision++;
      this.chainBlocksRevision = this.chainRevision;
    }
    let entry = this.chainBlocks.get(hash);
    if (!entry) {
      if (this.chainBlocks.size >= 64) this.chainBlocks.delete(this.chainBlocks.keys().next().value);
      entry = {hash, revision: 0}; this.chainBlocks.set(hash, entry);
    }
    return entry;
  }
  chainBlockCurrent(entry, revision) {
    return this.chainBlocksRevision === this.chainRevision && this.chainBlocks.get(entry.hash) === entry && entry.revision === revision;
  }
  noteChainRemoval(hashes, {hint = false} = {}) {
    const known = Array.isArray(hashes) && hashes.every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash));
    if (known && !hashes.length) return;
    if (!known || this.chainBlocksRevision !== this.chainRevision) for (const entry of this.chainBlocks.values()) entry.revision++;
    this.chainRevision++;
    for (const hash of known ? hashes : []) { const entry = this.chainBlocks.get(hash); if (entry) entry.revision++; }
    this.chainBlocksRevision = this.chainRevision;
    if (!known) this.chainCoverage = null;
    this.notify('chain-removals', {hashes: known ? hashes : [], unknown: !known, hint});
  }
  connect() {
    if (this.ws) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let ws;
      try { ws = new this.WS(this.url); } catch (e) { reject(e); return; }
      this.ws = ws; this.epoch++;
      this.closed = false;
      const timer = setTimeout(() => { reject(new Error(`连接超时：${host(this.url)}`)); this.close(); }, Math.min(this.timeoutMs, 15000));
      this.cancelConnect = reason => { clearTimeout(timer); reject(reason); };
      ws.onopen = () => { clearTimeout(timer); this.cancelConnect = null; resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`无法连接：${host(this.url)}`)); this.close(); };
      ws.onclose = () => { clearTimeout(timer); reject(new Error(`连接已关闭：${host(this.url)}`)); this.close(new Error('NODE_DISCONNECTED')); };
      ws.onmessage = ev => {
        try {
          if (typeof ev.data !== 'string' || ev.data.length > MAX_FRAME) throw new Error('RPC_FRAME');
          const m = parseJson(ev.data);
          const id = typeof m?.id === 'number' ? m.id : null;
          const p = id === null ? null : this.pending.get(id);
          if (!p) {
            if (m.id != null) return;
            try {
              const kind = (m.method === 'utxosChangedNotification' || m.params?.UtxosChanged) ? 'utxos'
                : (m.method === 'virtualChainChangedNotification' || m.params?.VirtualChainChanged) ? 'chain' : null;
              if (kind) {
                const d = m.params?.VirtualChainChanged ?? m.params?.UtxosChanged ?? m.params;
                if (d && typeof d === 'object') {
                  if (kind === 'chain') {
                    const removed = Array.isArray(d.removedChainBlockHashes) ? d.removedChainBlockHashes : [];
                    const added = Array.isArray(d.addedChainBlockHashes) ? d.addedChainBlockHashes : [];
                    this.noteChainRemoval(d.removedChainBlockHashes);
                    this.notify(kind, {...d, removedChainBlockHashes: removed, addedChainBlockHashes: added});
                  } else if (kind === 'utxos') {
                    const added = Array.isArray(d.added) ? d.added : [];
                    const removed = Array.isArray(d.removed) ? d.removed : [];
                    this.notify(kind, {...d, added, removed});
                  }
                }
              }
            } catch {}
            return;
          }
          clearTimeout(p.timer); this.pending.delete(id);
          if (m.error !== undefined && m.error !== null) p.reject(new RpcError(p.method, m.error));
          else {
            if (m.params?.removedChainBlockHashes?.length) this.noteChainRemoval(m.params.removedChainBlockHashes);
            p.resolve(m.params);
          }
        } catch (e) { this.close(e); }
      };
    });
    return this.ready;
  }
  async call(method, params = {}, timeoutMs = this.timeoutMs, {signal, beforeSend = () => {}, submitPermit = null} = {}) {
    timeoutMs = Math.min(timeoutMs, this.maxTimeoutMs);
    const submit = method === 'submitTransaction' || method === 'submitTransactionReplacement';
    if (!READ.has(method) && !submit && method !== 'subscribe' && method !== 'unsubscribe') throw failure('RPC_METHOD');
    if (submit) requireSubmitPermission(this.net, submitPermit, {method, transaction: params.transaction});
    let pendingId = null;
    return withDeadline(async scope => {
      await this.connect(); scope.check();
      if (this.ws?.readyState !== 1) throw failure('NODE_DISCONNECTED');
      const sentParams = submit ? structuredClone(params) : params;
      const id = ++this.next, text = `{"id":${id},"method":${JSON.stringify(method)},"params":${jsonText(sentParams)}}`;
      pendingId = id;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(failure('RPC_TIMEOUT')); }, timeoutMs);
        this.pending.set(id, {resolve, reject, timer, method});
        try {
          requireSyncPermission(beforeSend());
          scope.check(); // no await between synchronous permission fence and transport
          if (submit) requireSubmitPermission(this.net, submitPermit, {method, transaction: sentParams.transaction});
          scope.check();
          this.ws.send(text);
        } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
      });
      scope.check(); return result;
    }, {timeoutMs, signal, code: 'RPC_TIMEOUT', onCancel: reason => {
      // Cancel this request only; other consumers may share this socket.
      const p = this.pending.get(pendingId);
      if (p) { clearTimeout(p.timer); this.pending.delete(pendingId); p.reject(reason); }
    }});
  }
  close(reason = new Error('NODE_CLOSED')) {
    const ws = this.ws; this.ws = null; this.closed = true; this.epoch++;
    this.cancelConnect?.(reason); this.cancelConnect = null;
    if (ws) { ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null; try { ws.close(); } catch {} }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear(); this.chainBlocks.clear(); this.chainBlocksRevision = this.chainRevision;
    clearTimeout(this.chainLeaseTimer); this.chainSession++; this.chainCoverage = null; this.chainActive = false;
    this.chainWanted = false; this.chainAccepted = false; this.chainLeaseUntil = 0;
    if (ws) this.notify('disconnect', reason);
  }
}
export class RpcError extends Error {
  constructor(method, err) { super(`${method}: ${typeof err?.message === 'string' ? err.message : JSON.stringify(err)}`); this.name = 'RpcError'; this.method = method; this.rpc = err; }
}
export const host = url => { try { return new URL(url).host; } catch { return String(url); } };

/** Probe one node: network / sync / UTXO index / DAA / RTT. */
export async function probeNode(url, opts = {}) {
  const net = requireNet(opts.net);
  const rpc = new JsonRpc(url, opts);
  try {
    await identify(rpc, net, opts.verifyDag === true);
    return rpc;
  } catch (e) { rpc.close(); throw e; }
}
async function identify(rpc, net, verifyDag, scope = null) {
  const start = Date.now(), view = scope ? scopedLink(rpc, scope) : rpc;
  const id = verifyDag ? await assertNodeNetwork(view, net) : checkServerIdentity(await view.call('getServerInfo'), net.networkId);
  scope?.check();
  rpc.info = {version: id.serverVersion, daa: BigInt(id.virtualDaa), rtt: Date.now() - start};
}

/** One node, chosen from an ordered list: the first reachable, synced node on the explicit network with a UTXO index wins.
 * `connect()` returns the active RPC list; `call()` applies the configured operation deadline and retry policy. */
export class NodeLink {
  constructor(urls, opts = {}) {
    this.net = requireNet(opts.net);
    ensure(Array.isArray(urls), 'NODE_URLS_REQUIRED');
    this.urls = [...new Set(urls.map(nodeUrl))]; ensure(this.urls.length, '至少需要配置一个节点');
    this.opts = opts;
    // Policy (2026-10-17): a single RPC/step never exceeds 30s; longer waits repeat bounded steps.
    this.rpcMs = Math.min(opts.timeoutMs ?? 30_000, 30_000); this.stepMs = Math.min(opts.stepMs ?? 30_000, 30_000);
    this.connectMs = Math.min(opts.connectMs ?? Math.max(30_000, this.urls.length * this.rpcMs * 2), 30_000);
    this.nodes = []; this.opening = null; this.connectionCancel = null; this.listeners = new Set(); this.heartbeat = null; this.rejected = [];
    this.readViews = new Map(); this._anchor = null;
  }
  readContext() { return queryContext(this.nodes[0] ?? {ws: null}); }
  rememberChainAnchor(hash) { this._anchor = {hash: hash32(hash), observedAt: Date.now(), context: this.readContext()}; }
  get knownAnchor() { return this._anchor && sameQueryContext(this._anchor.context, this.readContext()) ? this._anchor : null; }
  /** Fresh by default. Reuse is explicit, bounded, connection/reorg-scoped and never used for submission RPCs. */
  async readView(key, task, {maxAgeMs = 0, signal} = {}, apply = () => {}, retries = 1) {
    ensure(Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0 && maxAgeMs <= 10000, 'READ_VIEW_AGE');
    if (signal?.aborted) throw signal.reason;
    await this.connect();
    const context = this.readContext(), now = Date.now(), previous = this.readViews.get(key);
    // Health/fee estimates do not depend on any particular selected-chain block.
    const sameContext = key === 'health' || key === 'fees' ? sameConnectionContext : sameQueryContext;
    if (maxAgeMs && previous?.value !== undefined && sameContext(previous.context, context) &&
        now >= previous.observedAt && now - previous.observedAt < maxAgeMs) {
      apply(previous.value); return structuredClone(previous.value);
    }
    // A scoped caller owns its cancellation; do not share its in-flight deadline with unrelated callers.
    if (!signal && previous?.pending && sameContext(previous.context, context)) return structuredClone(await previous.pending);
    const entry = {context, observedAt: now};
    const pending = Promise.resolve().then(task).then(value => {
      if (signal?.aborted) throw signal.reason;
      if (!sameContext(context, this.readContext())) {
        if (retries) return this.readView(key, task, {maxAgeMs: 0, signal}, apply, retries - 1);
        throw failure('READ_VIEW_CHANGED');
      }
      if (this.readViews.get(key) === entry) { entry.value = structuredClone(value); apply(entry.value); }
      return value;
    }).finally(() => { if (this.readViews.get(key) === entry) delete entry.pending; });
    entry.pending = pending; this.readViews.set(key, entry);
    try { return structuredClone(await pending); }
    catch (e) { if (this.readViews.get(key) === entry) this.readViews.delete(key); throw e; }
  }
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit() { for (const f of this.listeners) { try { f(this.status()); } catch {} } }
  status() { return {connected: this.nodes.length === 1, nodes: this.nodes.map(n => ({url: n.url, host: host(n.url), ...n.info})), rejected: this.rejected, preferred: this.urls[0]}; }
  async connect({exclude = new Set()} = {}) {
    if (this.nodes.length === 1 && this.nodes[0].ws && !exclude.has(this.nodes[0].url)) return this.nodes;
    if (this.opening) {
      const nodes = await this.opening;
      if (!nodes.some(n => exclude.has(n.url))) return nodes;
      // A concurrent connection may have selected this operation's failed endpoint.
      return this.connect({exclude});
    }
    this.close(false);
    const cancel = new AbortController(); this.connectionCancel = cancel;
    let active = null;
    const opening = this.opening = withDeadline(async scope => {
      const rejected = [];
      for (const url of this.urls) {
        scope.check();
        if (exclude.has(url)) continue;
        const n = active = new JsonRpc(url, {...this.opts, timeoutMs: this.rpcMs});
        try {
          await identify(n, this.net, this.opts.verifyDag === true, scope); scope.check();
          this.nodes = [n]; this.rejected = rejected; active = null;
          n.ws.addEventListener?.('close', () => { if (this.nodes[0] === n) { this.nodes = []; this.emit(); } });
          if (this.opts.heartbeat !== false) {
            this.heartbeat = setInterval(() => { for (const x of this.nodes) x.call('getSinkBlueScore').catch(() => {}); }, 20000);
            this.heartbeat.unref?.();
          }
          this.emit(); return this.nodes;
        } catch (e) { n.close(); scope.check(); rejected.push({url, reason: errorText(e), code: e?.safeCode}); }
      }
      this.rejected = rejected; this.emit();
      const code = rejected.length && rejected.every(r => r.code === 'NODE_NETWORK_MISMATCH') ? 'NODE_NETWORK_MISMATCH' : 'NO_NODE';
      throw Object.assign(failure(code), {message: `没有可用的 ${this.net.label} 节点：${rejected.map(r => `${host(r.url)}（${r.reason}）`).join('；')}`});
    }, {timeoutMs: this.connectMs, signal: cancel.signal, code: 'CONNECT_TIMEOUT', onCancel: () => active?.close()});
    try { return await opening; } finally { if (this.opening === opening) this.opening = null; if (this.connectionCancel === cancel) this.connectionCancel = null; }
  }
  close(emit = true) {
    this.connectionCancel?.abort(failure('CONNECTION_CANCELLED'));
    clearInterval(this.heartbeat); this.heartbeat = null;
    for (const n of this.nodes) n.close(); this.nodes = []; this.readViews.clear(); this._anchor = null;
    if (emit) this.emit();
  }
  async call(method, params, timeoutMs = this.stepMs, options = {}) {
    return withDeadline(async scope => {
      const attempts = READ.has(method) ? (this.opts.readAttempts ?? 1) : 1;
      const failed = new Set();
      for (let attempt = 0; attempt < attempts; attempt++) {
        let rpc;
        try {
          [rpc] = await this.connect({exclude: failed}); scope.check();
          const result = await rpc.call(method, params, Math.min(this.rpcMs, scope.remaining()),
            {...options, signal: scope.signal, beforeSend: () => { scope.check(); return options.beforeSend?.(); }});
          scope.check(); return result;
        } catch (e) {
          scope.check();
          if (attempt === attempts - 1 || e?.safeCode === 'NODE_NETWORK_MISMATCH') throw e;
          if (!rpc) throw e; // connect already exhausted its eligible candidates
          failed.add(rpc.url);
          if (!this.urls.some(url => !failed.has(url))) throw e;
          if (this.nodes[0] === rpc) this.close(false);
          await pause(500, scope.signal);
        }
      }
    }, {timeoutMs: Math.min(timeoutMs, this.stepMs), signal: options.signal, code: 'RPC_OPERATION_TIMEOUT', onCancel: () => this.close(false)});
  }
  /** Current virtual DAA of the connected node; it must match this.net, be synced and have a UTXO index. */
  async currentDaa(options = {}) {
    const s = await this.readView('health', () => this.call('getServerInfo', {}, this.rpcMs, options), options, info => {
      checkServerIdentity(info, this.net.networkId);
      const daa = uint(info.virtualDaaScore);
      if (this.nodes[0]) this.nodes[0].info.daa = daa;
      this.emit();
    });
    checkServerIdentity(s, this.net.networkId);
    return uint(s.virtualDaaScore);
  }
  /** Node fee estimate in sompi per gram of the mempool ORDERING mass max(compute, normalized transient, storage)
   * (rusty-kaspa cfafeb4 mining/src/mempool/model/frontier/feerate_key.rs from_tx). Price against that mass. */
  async feerate(options = {}) { return (await this.feeConditions(options)).normal.feerate; }
  /** Fee buckets plus, when the node serves it, the ready-mempool size (getFeeEstimateExperimental verbose; read-only,
   * rusty-kaspa v2.1.0 rpc/core). Falls back to getFeeEstimate; never guesses mempool data it was not given. */
  async feeConditions(options = {}) {
    return this.readView('fees', async () => {
      let r = null;
      try { r = await this.call('getFeeEstimateExperimental', {verbose: true}, 8000, options); }
      catch (e) { if (options.signal?.aborted) throw options.signal.reason; }
      if (r?.estimate) { try { return parseFeeEstimate(r, r.verbose ?? null); } catch {} }
      return parseFeeEstimate(await this.call('getFeeEstimate', {}, this.rpcMs, options));
    }, options);
  }
}
/** Multi-network policy adapter; all connection/RPC/fee algorithms live above. No network table in browser graph. */
export class NetworkLink extends NodeLink {
  constructor(net, opts = {}) {
    super(net.nodes, {...opts, net, verifyDag: true, timeoutMs: LIMITS.rpcMs, stepMs: LIMITS.stepMs,
      connectMs: LIMITS.connectMs, maxTimeoutMs: LIMITS.rpcMs, readAttempts: 3, heartbeat: false});
  }
}
export class NetworkRpc extends JsonRpc {
  constructor(url, opts = {}) { super(url, {...opts, timeoutMs: LIMITS.rpcMs, maxTimeoutMs: LIMITS.rpcMs}); }
}

/** RPC transaction JSON (human-readable serde of RpcTransaction) <-> library DTO. */
export function parseSpk(raw) {
  ensure(typeof raw === 'string' && /^[0-9a-f]{4}(?:[0-9a-f]{2})*$/i.test(raw), '节点返回的 scriptPublicKey 格式错误');
  return {version: parseInt(raw.slice(0, 4), 16), script: raw.slice(4).toLowerCase()};
}
export const spkText = spk => spk.version.toString(16).padStart(4, '0') + spk.script;
export function txFromRpc(t) {
  ensure(t && Array.isArray(t.inputs) && Array.isArray(t.outputs) && Number.isInteger(t.version), '节点交易缺少完整字段');
  return {
    version: t.version,
    inputs: t.inputs.map(i => ({previousOutpoint: {transactionId: hash32(i.previousOutpoint.transactionId), index: Number(uint(i.previousOutpoint.index))}, signatureScript: String(i.signatureScript).toLowerCase(), sequence: uint(i.sequence), computeBudget: Number(uint(i.computeBudget ?? 0))})),
    outputs: t.outputs.map(o => ({value: uint(o.value), scriptPublicKey: parseSpk(o.scriptPublicKey), covenant: o.covenant ? {covenantId: hash32(o.covenant.covenantId), authorizingInput: Number(uint(o.covenant.authorizingInput))} : null})),
    lockTime: uint(t.lockTime), subnetworkId: String(t.subnetworkId).toLowerCase(), gas: uint(t.gas), payload: String(t.payload ?? '').toLowerCase(),
    storageMass: uint(t.storageMass ?? t.mass ?? 0),
  };
}
export function txToRpc(t) {
  return {
    version: t.version,
    inputs: t.inputs.map(i => ({previousOutpoint: {transactionId: i.previousOutpoint.transactionId, index: i.previousOutpoint.index}, signatureScript: i.signatureScript, sequence: i.sequence, sigOpCount: 0, computeBudget: i.computeBudget ?? 0, verboseData: null})),
    outputs: t.outputs.map(o => ({value: o.value, scriptPublicKey: spkText(o.scriptPublicKey), verboseData: null, covenant: o.covenant ? {authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId} : null})),
    lockTime: t.lockTime, subnetworkId: t.subnetworkId, gas: t.gas, payload: t.payload, storageMass: t.storageMass, verboseData: null,
  };
}
/** UTXO entry from getUtxosByAddresses. */
export function utxoFromRpc(e) {
  const u = e.utxoEntry;
  return {outpoint: {transactionId: hash32(e.outpoint.transactionId), index: Number(uint(e.outpoint.index))}, value: uint(u.amount), spk: parseSpk(u.scriptPublicKey), daa: uint(u.blockDaaScore), covenantId: u.covenantId ?? null, isCoinbase: u.isCoinbase === true, address: e.address};
}
