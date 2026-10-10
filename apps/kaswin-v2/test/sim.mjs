/** Test harness (Node only, never bundled): simulated TN10 endpoints speaking the JSON wRPC subset,
 * an in-memory indexer, and a KasWare-like wallet that signs with the PUBLIC test key sk=1 via the pinned SDK.
 * The chain applies transactions by the same core transition the contract encodes; it is a simulator, not consensus.
 */
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../../contracts/f3.2/tools/linking.mjs';
import {S, referenceTxId, hex, unhex, stable, PROFILE_ID, CONTRACT_TAG} from '../scripts/shared/core.mjs';
import {parseJson, jsonText} from '../scripts/shared/lib/json.mjs';
import {txFromRpc, spkText} from '../scripts/shared/nodes.mjs';
import {spkToAddress, pubkeyToAddress} from '../scripts/shared/lib/address.mjs';
import {schnorrSighash} from '../scripts/shared/lib/sighash.mjs';
import {massOf} from '../scripts/shared/mass.mjs';

const require = createRequire(import.meta.url);
export const sdk = require(process.env.KASPA_SDK_PATH || '../../../references/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js');
export const TEST_SK = '0000000000000000000000000000000000000000000000000000000000000001';
export const TEST_KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
export const TEST_ADDRESS = pubkeyToAddress(TEST_KEY);

// Fail closed on stale F3.2 artifacts; simulation must not silently relabel an old Profile as V2.
const bundle = await loadV2Bundle(fileURLToPath(new URL('../../../contracts/f3.2/', import.meta.url)));
export function loadProfile() {
  if (bundle.profile.id !== PROFILE_ID) throw Error('PROFILE');
  return structuredClone(bundle.profile);
}

/** Shared ledger of UTXOs and accepted txs; each "node" is a view with its own p2pId. */
export class SimChain {
  constructor({daa = 600_000_000n, blue = 590_000_000n} = {}) {
    this.daa = daa; this.blue = blue; this.utxos = new Map(); this.accepted = new Map(); this.blocks = new Map();
    this.chain = []; this.mempool = new Map(); this.submits = 0; this.rejectNext = null; this.dropResponse = false; this.serial = 1;
    this.addBlock();
  }
  h() { return (this.serial++).toString(16).padStart(64, '0'); }
  addBlock(acceptedTxs = []) {
    const hash = this.h(), parent = this.chain.at(-1) ?? null;
    this.daa += 1n; this.blue += 1n;
    const b = {hash, parent, daa: this.daa, blue: this.blue, txs: acceptedTxs};
    this.blocks.set(hash, b); this.chain.push(hash); return b;
  }
  advance(n) { for (let i = 0; i < n; i++) this.addBlock(); }
  /** Short selected-chain reorg: the chain block `hash` is replaced by a sibling with the same selected parent and DAA.
   * reaccept=true: the sibling accepts the same transactions (same UTXO effects). reaccept=false: they are undone
   * (inputs restored, outputs removed, no longer accepted). Returns the sibling hash. Simulator, not consensus. */
  reorgBlock(hash, {reaccept = true} = {}) {
    const i = this.chain.indexOf(hash); if (i < 0) throw Error('NOT_CHAIN');
    const b = this.blocks.get(hash), sib = this.h();
    this.blocks.set(sib, {...b, hash: sib, txs: reaccept ? [...b.txs] : []});
    this.chain[i] = sib;
    if (this.chain[i + 1]) this.blocks.get(this.chain[i + 1]).parent = sib;
    for (const id of reaccept ? [] : b.txs) {
      const a = this.accepted.get(id);
      a.tx.outputs.forEach((_, index) => this.utxos.delete(`${id}:${index}`));
      for (const u of a.inputs) this.utxos.set(`${u.outpoint.transactionId}:${u.outpoint.index}`, u);
      this.accepted.delete(id);
    }
    for (const id of reaccept ? b.txs : []) this.accepted.get(id).block = sib;
    return sib;
  }
  fund(address, value) {
    const spk = {version: 0, script: '20' + TEST_KEY + 'ac'};
    const op = {transactionId: this.h(), index: 0};
    this.utxos.set(`${op.transactionId}:0`, {outpoint: op, value, spk, daa: this.daa - 2000n, covenantId: null, address});
    return op;
  }
  /** Accept a signed RPC tx: check inputs exist + signatures length, apply. Contract logic is trusted from the builder (simulation). */
  accept(rpcTx) {
    const tx = txFromRpc(rpcTx), id = referenceTxId(tx);
    for (const i of tx.inputs) if (!this.utxos.has(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`)) throw Error(`Rejected transaction ${id}: transaction ${id} is an orphan where orphan is disallowed`);
    const inputs = tx.inputs.map(i => this.utxos.get(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`));
    const fee = inputs.reduce((a, u) => a + u.value, 0n) - tx.outputs.reduce((a, o) => a + o.value, 0n);
    if (fee <= 0n) throw Error(`Rejected transaction ${id}: fee`);
    tx.inputs.forEach((i, n) => { if (inputs[n].spk.script.startsWith('20') && !/^41[0-9a-f]{128}01$/.test(i.signatureScript)) throw Error(`Rejected transaction ${id}: signature`); });
    for (const i of tx.inputs) this.utxos.delete(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`);
    const block = this.addBlock([id]);
    tx.outputs.forEach((o, index) => this.utxos.set(`${id}:${index}`, {outpoint: {transactionId: id, index}, value: o.value, spk: o.scriptPublicKey, daa: block.daa, covenantId: o.covenant?.covenantId ?? null, address: spkToAddress(o.scriptPublicKey)}));
    const enrichedRpc = structuredClone(rpcTx);
    enrichedRpc.inputs.forEach((inp, idx) => {
      const u = inputs[idx];
      inp.verboseData = {
        utxoEntry: {
          amount: u.value.toString(),
          scriptPublicKey: spkText(u.spk),
          blockDaaScore: u.daa.toString(),
          covenantId: u.covenantId ?? null,
          isCoinbase: false,
        }
      };
    });
    this.accepted.set(id, {tx, rpc: enrichedRpc, block: block.hash, inputs});
    return id;
  }
  /** Opt-in mempool model (chain.holdInMempool = true), mirroring rusty-kaspa v2.1.0 mempool RBF:
   * submitTransaction = RbfPolicy::Forbidden (any double spend of a mempool tx is rejected);
   * submitTransactionReplacement = RbfPolicy::Mandatory (exactly one conflicting mempool tx, strictly higher
   * fee / max(compute, normalized transient, storage)). mine(txid) accepts a held transaction. A simulator, not consensus. */
  toMempool(rpcTx, replacement) {
    const tx = txFromRpc(rpcTx), id = referenceTxId(tx), ops = tx.inputs.map(i => `${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`);
    if (this.accepted.has(id)) throw Error(`Rejected transaction ${id}: transaction ${id} was already accepted by the consensus`);
    if (this.mempool.has(id)) throw Error(`Rejected transaction ${id}: transaction ${id} is already in the mempool`);
    for (const o of ops) if (!this.utxos.has(o)) throw Error(`Rejected transaction ${id}: transaction ${id} is an orphan where orphan is disallowed`);
    const inputs = ops.map(o => this.utxos.get(o));
    const fee = inputs.reduce((a, u) => a + u.value, 0n) - tx.outputs.reduce((a, o) => a + o.value, 0n);
    const q = massOf({transaction: tx, inputUtxos: inputs.map(u => ({outpoint: u.outpoint, value: u.value, spk: u.spk, daa: u.daa, covenantId: u.covenantId})), authorizedInputIndices: [], fee});
    const mass = [q.computeMass, q.normalizedTransient, q.storageMass].reduce((a, b) => a > b ? a : b);
    if (fee < q.relayFloor) throw Error(`Rejected transaction ${id}: transaction ${id} is not standard: insufficient fee`);
    const conflicts = [...this.mempool.values()].filter(m => m.ops.some(o => ops.includes(o)));
    let replaced = null;
    if (!replacement) { if (conflicts.length) throw Error(`Rejected transaction ${id}: output ${conflicts[0].ops.find(o => ops.includes(o))} already spent by transaction ${conflicts[0].id} in the mempool`); }
    else {
      if (!conflicts.length) throw Error(`Rejected transaction ${id}: replace by fee found no double spending transaction in the mempool`);
      if (conflicts.length > 1) throw Error(`Rejected transaction ${id}: replace by fee found more than one double spending transaction in the mempool`);
      const old = conflicts[0];
      if (!(fee * old.mass > old.fee * mass)) throw Error(`Rejected transaction ${id}: output ${old.ops[0]} already spent by transaction ${old.id} in the mempool`);
      this.mempool.delete(old.id); replaced = old;
    }
    this.mempool.set(id, {id, rpc: structuredClone(rpcTx), ops, fee, mass});
    return replacement ? {id, replaced} : id;
  }
  mine(txid) { const m = this.mempool.get(txid); if (!m) throw Error('NOT_IN_MEMPOOL'); this.mempool.delete(txid); return this.accept(m.rpc); }
  /** The mempool drops a transaction (eviction/expiry) without it being accepted. */
  evict(txid) { this.mempool.delete(txid); }
  rpcFor(p2pId) {
    const chain = this;
    const header = b => ({hash: b.hash, daaScore: Number(b.daa), blueScore: Number(b.blue), parentsByLevel: [[b.parent ?? '00'.repeat(32)]], acceptedIdMerkleRoot: b.seqCommit ?? '00'.repeat(32), blueWork: '01', timestamp: 1});
    const methods = {
      getServerInfo: () => ({networkId: 'testnet-10', isSynced: true, hasUtxoIndex: true, virtualDaaScore: Number(chain.daa), serverVersion: 'sim'}),
      getInfo: () => ({p2pId}),
      getSink: () => ({sink: chain.chain.at(-1)}),
      getSinkBlueScore: () => ({blueScore: Number(chain.blue)}),
      getFeeEstimate: () => chain.feeEstimate ? {estimate: chain.feeEstimate.estimate} : {estimate: {normalBuckets: [{feerate: 1, estimatedSeconds: 1}], priorityBucket: {feerate: 1, estimatedSeconds: 1}}},
      // Optional (chain.feeEstimate = {estimate, verbose}); absent by default so the page's getFeeEstimate fallback is exercised.
      getFeeEstimateExperimental: () => { if (!chain.feeEstimate?.verbose) throw {message: 'unsupported getFeeEstimateExperimental'}; return chain.feeEstimate; },
      getUtxosByAddresses: ({addresses}) => ({entries: [...chain.utxos.values()].filter(u => addresses.includes(u.address)).map(u => ({address: u.address, outpoint: u.outpoint, utxoEntry: {amount: u.value.toString(), scriptPublicKey: spkText(u.spk), blockDaaScore: u.daa.toString(), isCoinbase: false, covenantId: u.covenantId}}))}),
      getBlock: ({hash}) => { const b = chain.blocks.get(hash); if (!b) throw {message: 'block not found'}; return {block: {header: header(b), verboseData: {isChainBlock: chain.chain.includes(hash), selectedParentHash: b.parent ?? '00'.repeat(32)}}}; },
      getVirtualChainFromBlockV2: ({startHash}) => {
        const i = chain.chain.indexOf(startHash); if (i < 0) throw {message: 'unknown start'};
        const added = chain.chain.slice(i + 1, i + 6);
        return {removedChainBlockHashes: [], addedChainBlockHashes: added, chainBlockAcceptedTransactions: added.map(h => { const b = chain.blocks.get(h); return {chainBlockHeader: header(b), acceptedTransactions: b.txs.map(id => { const a = chain.accepted.get(id); return {...a.rpc, verboseData: {transactionId: id, computeMass: 1000}}; })}; })};
      },
      getVirtualChainFromBlock: ({startHash}) => {
        const i = chain.chain.indexOf(startHash); if (i < 0) throw {message: 'unknown start'};
        const added = chain.chain.slice(i + 1);
        return {removedChainBlockHashes: [], addedChainBlockHashes: added, acceptedTransactionIds: added.map(h => ({acceptingBlockHash: h, acceptedTransactionIds: chain.blocks.get(h).txs}))};
      },
      getMempoolEntry: ({transactionId}) => {
        const m = chain.mempool.get(transactionId);
        if (!m) throw {message: `Transaction ${transactionId} not found`};
        return {mempoolEntry: {fee: Number(m.fee), transaction: m.rpc, isOrphan: false}};
      },
      submitTransaction: ({transaction}) => {
        chain.submits++;
        if (chain.rejectNext) { const m = chain.rejectNext; chain.rejectNext = null; throw {message: m}; }
        const id = chain.holdInMempool ? chain.toMempool(transaction, false) : chain.accept(transaction);
        if (chain.dropResponse) { chain.dropResponse = false; throw {message: 'connection reset'}; }
        return {transactionId: id};
      },
      submitTransactionReplacement: ({transaction}) => {
        chain.submits++;
        const {id, replaced} = chain.toMempool(transaction, true);
        return {transactionId: id, replacedTransaction: replaced.rpc};
      },
    };
    return methods;
  }
}

/** Minimal WebSocket shim for JsonRpc: url host selects the node view. */
export function wsFactory(chain) {
  return class SimWS {
    constructor(url) { this.url = url; this.readyState = 0; const p2p = new URL(url).host; this.methods = chain.rpcFor('p2p-' + p2p.split('.')[0]); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
    send(text) {
      const m = parseJson(text);
      setTimeout(() => {
        let reply;
        try { const f = this.methods[m.method]; if (!f) throw {message: `unsupported ${m.method}`}; reply = {id: m.id, params: f(m.params)}; }
        catch (e) { reply = {id: m.id, error: {message: e.message ?? String(e)}}; }
        this.onmessage?.({data: jsonText(reply)});
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 3; }
  };
}

/** KasWare-like provider signing with the public test key via the pinned SDK. */
export function fakeKasware({network = 'kaspa_testnet_10', mutate = null, wrongKey = false} = {}) {
  const pk = new sdk.PrivateKey(wrongKey ? '0000000000000000000000000000000000000000000000000000000000000002' : TEST_SK);
  const calls = [];
  return {
    calls,
    requestAccounts: async () => [TEST_ADDRESS], getAccounts: async () => [TEST_ADDRESS], getNetwork: async () => network,
    getPublicKey: async () => '02' + TEST_KEY,
    signPskt: async ({txJsonString, options}) => {
      calls.push(options);
      const tx = sdk.Transaction.deserializeFromSafeJSON(txJsonString);
      const out = JSON.parse(tx.serializeToSafeJSON());
      for (const {index} of options.signInputs) out.inputs[index].signatureScript = sdk.createInputSignature(tx, index, pk, sdk.SighashType.All);
      if (mutate) mutate(out);
      return JSON.stringify(out);
    },
    on() {}, removeListener() {},
  };
}

/** In-memory Store with the same compareAndSet/list contract as core persistence.ts IndexedStore (tests only). */
export class MemoryStore {
  constructor() { this.map = new Map(); this.failNextWrite = false; }
  async get(k) { const v = this.map.get(k); return v ? structuredClone(v) : null; }
  async compareAndSet(k, rev, value) {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('IDB_WRITE_FAILED'); }
    const prev = this.map.get(k); if ((prev?.revision ?? null) !== rev) throw new Error('STALE_CACHE_REVISION');
    const rec = {revision: (prev?.revision ?? -1) + 1, value: structuredClone(value)}; this.map.set(k, rec); return structuredClone(rec);
  }
  async insertIfAbsentWithCheck(k, value, prefix, inspect) {
    // Synchronous critical section for this single-process simulator; NOT proof of cross-tab IDB atomicity.
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('IDB_WRITE_FAILED'); }
    if (this.map.has(k)) throw Error('INTENT_ALREADY_EXISTS');
    const rows = [...this.map].filter(([key]) => key.startsWith(prefix)).map(([key, record]) => ({key, record: structuredClone(record)}));
    if (inspect(rows) !== undefined) throw Error('ATOMIC_CHECK_MUST_BE_SYNCHRONOUS');
    const rec = {revision: 0, value: structuredClone(value)}; this.map.set(k, rec); return structuredClone(rec);
  }
  async list(prefix) { return [...this.map].filter(([k]) => k.startsWith(prefix)).map(([key, record]) => ({key, record: structuredClone(record)})); }
}
export const testLocks = {busy: false, async request(_name, _opts, f) { if (this.busy) return f(null); this.busy = true; try { return await f({}); } finally { this.busy = false; } }};

/** In-memory indexer serving /v1/rounds/:cid from the simulated chain state. */
export function simIndexer(chain, profile) {
  const rounds = new Map(); // cid -> {genesisTxid, origin, tip, accepting, ledger}
  return {
    rounds,
    track(cid, data) { rounds.set(cid, data); },
    fetch: async url => {
      if (/\/v1\/rounds(\?|$)/.test(url)) return new Response(jsonText({items: [], nextCursor: null, network: 'testnet-10', coverage: 'tracked-rounds-only', requiresIndependentVerification: true, lastCheckpointAt: Date.now()}), {status: 200});
      const m = /\/v1\/rounds\/([0-9a-f]{64})$/.exec(url);
      const r = m && rounds.get(m[1]);
      if (!r) return new Response('{"detail":"NOT_INDEXED"}', {status: 404});
      const s = S.decodeLedger(r.ledger);
      // A lagging indexer keeps serving its last recorded tip even after that UTXO was spent: read it from the accepted tx.
      const a = chain.accepted.get(r.tip.transactionId), o = a?.tx.outputs[r.tip.index];
      const u = chain.utxos.get(`${r.tip.transactionId}:${r.tip.index}`) ?? (o && {value: o.value, spk: o.scriptPublicKey, daa: chain.blocks.get(a.block).daa});
      const item = {cid: m[1], genesisTxid: r.genesisTxid, contract: CONTRACT_TAG, status: 'open', phase: s.phase, terminal: r.terminal ?? null, indexStatus: r.terminal ? 'TERMINAL' : 'LIVE',
        tip: r.terminal ? null : r.tip, address: null, value: r.terminal ? '0' : u.value.toString(), latestTxid: r.tip.transactionId, accepting: chain.accepted.get(r.tip.transactionId).block, utxoDaa: u ? u.daa.toString() : null,
        updatedAt: r.updatedAt ?? Date.now(), liveSeenAt: r.updatedAt ?? Date.now(),
        state: {...s, config: {...s.config, ticketPrice: s.config.ticketPrice.toString(), closeEligibleDaa: s.config.closeEligibleDaa.toString()}, anchorDaa: s.anchorDaa.toString(), directory: undefined},
        purchases: S.records(s), origin: r.origin, scriptPublicKey: u?.spk ?? null};
      return new Response(jsonText({item, network: 'testnet-10', coverage: 'tracked-rounds-only', requiresIndependentVerification: true, lastCheckpointAt: Date.now()}), {status: 200});
    },
  };
}
export {hex, unhex, stable, schnorrSighash};
