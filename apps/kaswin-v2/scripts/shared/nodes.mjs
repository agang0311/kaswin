/** Direct TN10 JSON wRPC (no SDK/WASM) to ONE configured Kaspa node.
 * Trust model (project decision 2026-10-02): the page relies on the Kaspa network consensus as served by the node the
 * user configured (default: wss://tn10.kaspay.top/wrpc). It no longer cross-checks a second
 * node. Value safety still comes from L1 consensus: the covenant scripts are executed by every node, and the page only
 * signs transactions it built and verified itself against the fixed contract templates.
 * Message format (rusty-kaspa cfafeb4 / workflow-rpc): request {id,method,params}; response {id,params} or {id,error}.
 */
import {parseJson, jsonText, uint} from './lib/json.mjs';
import {ensure, hash32, NETWORK_ID, errorText} from './core.mjs';
import {requireTradingRelease} from './release-safety.mjs';

/** Default node. Public TN10 nodes are fallbacks,
 * tried in order only if the preferred node is unreachable or unsynced. */
export const DEFAULT_NODE = 'wss://tn10.kaspay.top/wrpc';
export const TN10_JSON_NODES = Object.freeze([
  DEFAULT_NODE,
  'wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json',
  'wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json',
  'wss://quark-10.kaspa.red/kaspa/testnet-10/wrpc/json',
  'wss://electron-10.kaspa.stream/kaspa/testnet-10/wrpc/json',
]);
const READ = new Set(['getServerInfo', 'getInfo', 'getBlockDagInfo', 'getSink', 'getSinkBlueScore', 'getBlock', 'getUtxosByAddresses',
  'getVirtualChainFromBlock', 'getVirtualChainFromBlockV2', 'getFeeEstimate', 'getSeqCommitLaneProof', 'getMempoolEntriesByAddresses', 'getMempoolEntry']);
const MAX_FRAME = 64 * 1024 * 1024;

/** Node endpoint: wss:// or ws:// (e.g. your own kaspad with `--rpclisten-json` on the LAN). */
export function nodeUrl(v) {
  const u = new URL(String(v).trim());
  ensure(u.protocol === 'wss:' || u.protocol === 'ws:', '节点地址必须以 wss:// 或 ws:// 开头');
  ensure(!u.username && !u.password && !u.search && !u.hash, '节点地址不能包含凭据、查询参数或片段');
  return u.href;
}

export class JsonRpc {
  constructor(url, {timeoutMs = 45000, WebSocketImpl = globalThis.WebSocket} = {}) {
    this.url = nodeUrl(url); this.timeoutMs = timeoutMs; this.WS = WebSocketImpl;
    this.ws = null; this.next = 0; this.pending = new Map(); this.info = null; this.closed = false;
  }
  connect() {
    if (this.ws) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let ws;
      try { ws = new this.WS(this.url); } catch (e) { reject(e); return; }
      this.ws = ws;
      const timer = setTimeout(() => { reject(new Error(`连接超时：${host(this.url)}`)); this.close(); }, Math.min(this.timeoutMs, 15000));
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`无法连接：${host(this.url)}`)); this.close(); };
      ws.onclose = () => { clearTimeout(timer); reject(new Error(`连接已关闭：${host(this.url)}`)); this.close(new Error('NODE_DISCONNECTED')); };
      ws.onmessage = ev => {
        try {
          if (typeof ev.data !== 'string' || ev.data.length > MAX_FRAME) throw new Error('RPC_FRAME');
          const m = parseJson(ev.data);
          const id = typeof m?.id === 'number' ? m.id : null;
          const p = id === null ? null : this.pending.get(id);
          if (!p) return;
          clearTimeout(p.timer); this.pending.delete(id);
          if (m.error !== undefined && m.error !== null) p.reject(new RpcError(p.method, m.error));
          else p.resolve(m.params);
        } catch (e) { this.close(e); }
      };
    });
    return this.ready;
  }
  async call(method, params = {}, timeoutMs = this.timeoutMs) {
    const submit = method === 'submitTransaction' || method === 'submitTransactionReplacement';
    ensure(READ.has(method) || submit, `未允许的节点方法 ${method}`);
    if (submit) requireTradingRelease();
    await this.connect();
    ensure(this.ws && this.ws.readyState === 1, `节点未连接：${host(this.url)}`);
    const id = ++this.next, text = `{"id":${id},"method":${JSON.stringify(method)},"params":${jsonText(params)}}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`节点请求超时 ${method}@${host(this.url)}`)); }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer, method});
      try { this.ws.send(text); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close(reason = new Error('NODE_CLOSED')) {
    const ws = this.ws; this.ws = null; this.closed = true;
    if (ws) { ws.onclose = ws.onerror = ws.onmessage = null; try { ws.close(); } catch {} }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear();
  }
}
export class RpcError extends Error {
  constructor(method, err) { super(`${method}: ${typeof err?.message === 'string' ? err.message : JSON.stringify(err)}`); this.name = 'RpcError'; this.rpc = err; }
}
export const host = url => { try { return new URL(url).host; } catch { return String(url); } };

/** Probe one node: network / sync / UTXO index / DAA / RTT. */
export async function probeNode(url, opts) {
  const rpc = new JsonRpc(url, opts), t0 = Date.now();
  try {
    const s = await rpc.call('getServerInfo');
    ensure(s?.networkId === NETWORK_ID, `${host(url)} 不是 Testnet 10`);
    ensure(s.isSynced === true, `${host(url)} 尚未同步`);
    ensure(s.hasUtxoIndex === true, `${host(url)} 未启用 UTXO 索引（kaspad 需加 --utxoindex）`);
    rpc.info = {version: String(s.serverVersion ?? ''), daa: uint(s.virtualDaaScore, 'DAA'), rtt: Date.now() - t0};
    return rpc;
  } catch (e) { rpc.close(); throw e; }
}

/** One node, chosen from an ordered list: the first reachable, synced TN10 node with a UTXO index wins.
 * Keeps the shape the rest of the app uses (`connect()`, `nodes[0]`, `both()` returns a 1-element array, `status()`). */
export class NodeLink {
  constructor(urls = TN10_JSON_NODES, opts = {}) { this.urls = [...new Set(urls.map(nodeUrl))]; ensure(this.urls.length, '至少需要配置一个节点'); this.opts = opts; this.nodes = []; this.opening = null; this.listeners = new Set(); this.heartbeat = null; this.rejected = []; }
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit() { for (const f of this.listeners) { try { f(this.status()); } catch {} } }
  status() { return {connected: this.nodes.length === 1, nodes: this.nodes.map(n => ({url: n.url, host: host(n.url), ...n.info})), rejected: this.rejected, preferred: this.urls[0]}; }
  get node() { return this.nodes[0]; }
  async connect() {
    if (this.nodes.length === 1 && this.nodes[0].ws) return this.nodes;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      this.close(false);
      const rejected = [];
      // Ordered fallback: try the preferred node first; only then the next ones (no fan-out to every public node).
      for (const url of this.urls) {
        try {
          const n = await probeNode(url, this.opts);
          this.nodes = [n]; this.rejected = rejected;
          n.ws.addEventListener?.('close', () => { if (this.nodes[0] === n) { this.nodes = []; this.emit(); } });
          clearInterval(this.heartbeat);
          // Some wRPC frontends drop idle sockets (~60 s behind Cloudflare): light heartbeat.
          this.heartbeat = setInterval(() => { for (const x of this.nodes) x.call('getSinkBlueScore').catch(() => {}); }, 20000);
          this.heartbeat.unref?.();
          this.emit();
          return this.nodes;
        } catch (e) { rejected.push({url, reason: errorText(e)}); }
      }
      this.rejected = rejected; this.emit();
      throw new Error(`没有可用的 TN10 节点：${rejected.map(r => `${host(r.url)}（${r.reason}）`).join('；')}`);
    })();
    try { return await this.opening; } finally { this.opening = null; }
  }
  close(emit = true) { clearInterval(this.heartbeat); this.heartbeat = null; for (const n of this.nodes) n.close(); this.nodes = []; if (emit) this.emit(); }
  /** Call on the connected node; returns [result] (array kept for call-site compatibility). */
  async both(method, params) { const [a] = await this.connect(); return [await a.call(method, params)]; }
  async call(method, params, timeoutMs) { const [a] = await this.connect(); return a.call(method, params, timeoutMs); }
  /** Current virtual DAA of the connected node; it must be a synced TN10 node with a UTXO index. */
  async currentDaa() {
    const s = await this.call('getServerInfo');
    ensure(s?.networkId === NETWORK_ID && s.isSynced === true && s.hasUtxoIndex === true, '节点不再同步、网络不符或未启用 UTXO 索引');
    const d = uint(s.virtualDaaScore); if (this.nodes[0]) this.nodes[0].info.daa = d; this.emit();
    return d;
  }
  /** Node fee estimate in sompi per gram of the mempool ORDERING mass max(compute, normalized transient, storage)
   * (rusty-kaspa cfafeb4 mining/src/mempool/model/frontier/feerate_key.rs from_tx). Price against that mass. */
  async feerate() {
    const e = await this.call('getFeeEstimate');
    const v = e?.estimate?.normalBuckets?.[0]?.feerate ?? e?.estimate?.priorityBucket?.feerate;
    ensure(typeof v === 'number' && Number.isFinite(v) && v > 0, '节点未返回费率');
    return v;
  }
}
/** @deprecated name kept so older imports keep working; it is a single-node link now. */
export const NodePair = NodeLink;

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
