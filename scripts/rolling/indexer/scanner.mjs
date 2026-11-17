/** Read-only TN10 chain scanner for the Rolling sidecar.
 * Discovers Rolling Genesis transactions and tracks accepted transitions via
 * getVirtualChainFromBlockV2 (Full), enforcing 100-DAA depth via RollingNodeAdapter
 * and reverting active instances on selected-chain removals (descendants first).
 * Never signs, broadcasts, or holds keys. Importing starts nothing.
 */
import {ascii} from '../../../scripts/core/lib/bytes.js';
import {outpointKey, referenceTxId} from '../../../scripts/core/lib/transaction.js';
import {REORG_RECHECK_DAA} from '../../../scripts/chain/chain.mjs';
import {checkServerIdentity} from '../../../scripts/chain/node-identity.mjs';
import {probeNode, parseSpk, txFromRpc} from '../../../scripts/chain/nodes.mjs';
import {RollingNodeAdapter} from '../../../experiments/rolling/node-adapter.mjs';
import {RollingIndexer} from '../../../experiments/rolling/indexer.mjs';
import {decodeSpend, identify, verifyManager} from '../core.mjs';
import * as S from '../core.mjs';
import {TN10, safeCode} from './config.mjs';

const GENESIS_PREFIX_HEX = S.hex(ascii('KASWIN_ROLLING_GENESIS_V1'));
const GENESIS_PAYLOAD_HEX_LEN = (25 + 32 + 59) * 2;

export class RollingScanner {
  #config;
  #profile;
  #store;
  #connectFn;
  #rpc = null;
  #link = null;
  #nodeAdapter = null;
  #indexer = null;
  #timer = null;
  #unsubChain = null;
  #running = false;
  #polling = false;
  #rescanWanted = false;
  #lastPollAt = null;
  #lastSuccessAt = null;
  #lastError = null;
  #virtualDaa = '0';
  #batchFacts = new Map();

  constructor({config, profile, store, connectFn = null}) {
    this.#config = config;
    this.#profile = profile;
    this.#store = store;
    this.#connectFn = connectFn;
  }

  get indexer() {
    return this.#indexer;
  }

  status() {
    const now = Date.now();
    const stale = this.#lastSuccessAt === null || (now - this.#lastSuccessAt) > this.#config.staleMs;
    return {
      running: this.#running,
      stale,
      lastPollAt: this.#lastPollAt ? new Date(this.#lastPollAt).toISOString() : null,
      lastSuccessAt: this.#lastSuccessAt ? new Date(this.#lastSuccessAt).toISOString() : null,
      lastError: this.#lastError,
      virtualDaa: this.#virtualDaa,
    };
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    await this.#connect();
    void this.pollOnce().catch(e => {
      this.#lastError = safeCode(e);
    });
    this.#timer = setInterval(() => {
      void this.pollOnce().catch(e => {
        this.#lastError = safeCode(e);
      });
    }, this.#config.pollMs);
    this.#timer.unref?.();
  }

  async stop() {
    this.#running = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#unsubChain) {
      try {this.#unsubChain();} catch {}
      this.#unsubChain = null;
    }
    if (this.#nodeAdapter) {
      try {this.#nodeAdapter.dispose();} catch {}
      this.#nodeAdapter = null;
    }
    if (this.#rpc) {
      try {this.#rpc.close();} catch {}
      this.#rpc = null;
    }
    this.#link = null;
    this.#indexer = null;
  }

  async #connect() {
    if (this.#rpc && this.#rpc.ws?.readyState === 1) return;
    if (this.#link && this.#connectFn && !this.#rpc) return;
    if (this.#nodeAdapter) {
      try {this.#nodeAdapter.dispose();} catch {}
    }
    if (this.#rpc) {
      try {this.#rpc.close?.();} catch {}
    }
    let rpc = null;
    let link = null;
    if (this.#connectFn) {
      const injected = await this.#connectFn();
      if (injected?.link) {
        link = injected.link;
        rpc = injected.rpc ?? null;
      } else {
        link = injected;
        rpc = injected;
      }
    } else {
      rpc = await probeNode(this.#config.endpoint, {
        net: TN10,
        verifyDag: true,
        timeoutMs: this.#config.rpcMs,
        maxFrameBytes: 256 * 1024 * 1024,
      });
      link = {
        net: TN10,
        nodes: [rpc],
        connect: async () => [rpc],
        call: rpc.call.bind(rpc),
        currentDaa: async () => {
          const info = await rpc.call('getServerInfo');
          checkServerIdentity(info, TN10.networkId);
          return BigInt(info.virtualDaaScore);
        },
        on: (kind, fn) => rpc.on(kind, kind === 'chain' ? data => fn({rpc, data}) : fn),
      };
    }
    const nodeAdapter = new RollingNodeAdapter({
      link,
      profile: this.#profile,
      archive: this.#store.archive,
    });
    const adapter = {
      authenticateAccepted: (txid, position) => {
        const key = `${txid}/${position?.acceptingBlockHash ?? ''}`;
        const hit = this.#batchFacts.get(key);
        if (hit) {
          this.#batchFacts.delete(key);
          return Promise.resolve(hit);
        }
        return nodeAdapter.authenticateAccepted(txid, position);
      },
      authenticateReversal: position => nodeAdapter.authenticateReversal(position),
      dispose: () => nodeAdapter.dispose(),
    };
    const indexer = new RollingIndexer({
      archive: this.#store.archive,
      profile: this.#profile,
      networkGenesis: this.#config.genesisHash,
      nodeAdapter: adapter,
    });
    this.#rpc = rpc;
    this.#link = link;
    this.#nodeAdapter = adapter;
    this.#indexer = indexer;

    if (rpc?.subscribeChain) {
      try {
        await rpc.subscribeChain(true, {includeAcceptedTransactionIds: false});
        this.#unsubChain = rpc.on('chain', () => {
          if (this.#running) {
            void this.pollOnce().catch(e => {
              this.#lastError = safeCode(e);
            });
          }
        });
      } catch {
        // Polling remains active if subscription is unavailable.
      }
    }
  }

  async pollOnce() {
    if (this.#polling) {
      this.#rescanWanted = true;
      return;
    }
    this.#polling = true;
    this.#lastPollAt = Date.now();
    try {
      do {
        this.#rescanWanted = false;
        await this.#connect();
        let caughtUp = false;
        let batches = 0;
        while (!caughtUp && this.#running && batches < 500) {
          const res = await this.#step();
          this.#lastSuccessAt = Date.now();
          this.#lastError = null;
          caughtUp = res.caughtUp;
          batches += 1;
        }
        if (!caughtUp) {
          await this.#step();
          this.#lastSuccessAt = Date.now();
          this.#lastError = null;
        }
      } while (this.#rescanWanted && this.#running);
    } catch (e) {
      this.#lastError = safeCode(e);
      throw e;
    } finally {
      this.#polling = false;
    }
  }

  async #step() {
    let cursor = await this.#store.getCursor();
    let startHash = cursor.lastBlockHash;

    // Verify our cursor block is still on the selected chain; if not, walk trail backwards.
    const headBlock = (await this.#link.call('getBlock', {hash: startHash, includeTransactions: false}))?.block;
    if (!headBlock || headBlock.verboseData?.isChainBlock !== true) {
      const removed = [startHash];
      const trail = [...(cursor.trail ?? [])];
      let rollbackTarget = null;
      while (trail.length > 0) {
        const prev = trail.pop();
        const b = (await this.#link.call('getBlock', {hash: prev.hash, includeTransactions: false}))?.block;
        if (b?.verboseData?.isChainBlock === true) {
          rollbackTarget = prev;
          break;
        }
        removed.push(prev.hash);
      }
      await this.#revertBlocks(removed);
      if (rollbackTarget) {
        cursor = await this.#store.saveCursor({
          lastBlockHash: rollbackTarget.hash,
          lastBlockDaa: rollbackTarget.daa,
          lastBlockBlueScore: rollbackTarget.blueScore,
          trail,
        });
        startHash = cursor.lastBlockHash;
      } else if (headBlock?.verboseData?.selectedParentHash) {
        startHash = headBlock.verboseData.selectedParentHash;
        cursor = await this.#store.saveCursor({lastBlockHash: startHash, trail: []});
      }
    }

    let fromFullVchain = true;
    let vchain;
    try {
      vchain = await this.#link.call('getVirtualChainFromBlockV2', {
        startHash,
        dataVerbosityLevel: 'Full',
        minConfirmationCount: 0,
      });
    } catch (e) {
      if (!['RPC_FRAME', 'NODE_DISCONNECTED', 'NODE_CLOSED'].includes(safeCode(e))) throw e;
      fromFullVchain = false;
      await this.#connect();
      const v1 = await this.#link.call('getVirtualChainFromBlock', {
        startHash,
        includeAcceptedTransactionIds: true,
      });
      const items = (v1?.acceptedTransactionIds ?? []).filter(it => it?.acceptingBlockHash);
      const rows = [];
      for (let off = 0; off < items.length; off += 16) {
        const chunk = items.slice(off, off + 16);
        const fetched = await Promise.all(chunk.map(async item => {
          const blockHash = item.acceptingBlockHash;
          const includeTransactions = (item.acceptedTransactionIds?.length ?? 0) > 1;
          const b = (await this.#link.call('getBlock', {hash: blockHash, includeTransactions}))?.block;
          if (!b?.header) return null;
          let acceptedTransactions = [];
          if (includeTransactions && Array.isArray(b.transactions)) {
            const accSet = new Set(item.acceptedTransactionIds);
            acceptedTransactions = b.transactions.filter(t => accSet.has(t?.verboseData?.transactionId));
          }
          return {chainBlockHeader: b.header, acceptedTransactions};
        }));
        for (const r of fetched) if (r) rows.push(r);
        this.#lastSuccessAt = Date.now();
      }
      vchain = {
        removedChainBlockHashes: v1?.removedChainBlockHashes ?? [],
        chainBlockAcceptedTransactions: rows,
      };
    }

    const removedHashes = vchain?.removedChainBlockHashes ?? [];
    if (removedHashes.length > 0) {
      await this.#revertBlocks(removedHashes);
      const removedSet = new Set(removedHashes);
      const trail = (cursor.trail ?? []).filter(t => !removedSet.has(t.hash));
      if (removedSet.has(cursor.lastBlockHash)) {
        const lastGood = trail.at(-1);
        cursor = await this.#store.saveCursor({
          lastBlockHash: lastGood?.hash ?? this.#config.startHash,
          lastBlockDaa: lastGood?.daa ?? '0',
          lastBlockBlueScore: lastGood?.blueScore ?? '0',
          trail,
        });
      }
    }

    const virtualDaa = await this.#link.currentDaa();
    this.#virtualDaa = virtualDaa.toString();

    const rows = vchain?.chainBlockAcceptedTransactions ?? [];
    let processedBlocks = 0;
    let shallowStop = false;
    const trail = [...(cursor.trail ?? [])];
    let pendingCursor = null;

    for (const row of rows) {
      if (processedBlocks >= this.#config.maxChainBlocks) break;
      const hdr = row?.chainBlockHeader;
      const blockHash = hdr?.hash;
      if (!blockHash) continue;
      const acceptingDaa = BigInt(hdr.daaScore);
      // Do not advance past blocks shallower than REORG_RECHECK_DAA (100 DAA).
      if (virtualDaa < acceptingDaa + REORG_RECHECK_DAA) {
        shallowStop = true;
        break;
      }

      const txs = row.acceptedTransactions ?? [];
      for (const rawTx of txs) {
        if (!this.#isRollingCandidate(rawTx)) continue;
        if (pendingCursor) {
          cursor = await this.#store.saveCursor(pendingCursor);
          pendingCursor = null;
        }
        await this.#ingestRawTx(rawTx, blockHash, acceptingDaa, virtualDaa, fromFullVchain);
        this.#lastSuccessAt = Date.now();
      }

      trail.push({
        hash: blockHash,
        daa: acceptingDaa.toString(),
        blueScore: String(hdr.blueScore ?? '0'),
      });
      if (trail.length > 512) trail.splice(0, trail.length - 512);
      pendingCursor = {
        lastBlockHash: blockHash,
        lastBlockDaa: acceptingDaa.toString(),
        lastBlockBlueScore: String(hdr.blueScore ?? '0'),
        virtualDaa: virtualDaa.toString(),
        trail: [...trail],
      };
      processedBlocks += 1;
    }

    if (pendingCursor) {
      cursor = await this.#store.saveCursor(pendingCursor);
    } else if (processedBlocks === 0) {
      await this.#store.saveCursor({virtualDaa: virtualDaa.toString()});
    }
    return {
      caughtUp: processedBlocks === 0 || shallowStop,
      processedBlocks,
    };
  }

  #isRollingCandidate(rawTx) {
    const payload = rawTx?.payload ?? '';
    if (
      typeof payload === 'string' &&
      payload.length === GENESIS_PAYLOAD_HEX_LEN &&
      payload.startsWith(GENESIS_PREFIX_HEX + this.#profile.id)
    ) {
      return true;
    }
    const outCid = rawTx?.outputs?.[0]?.verboseData?.covenant?.covenantId ??
      rawTx?.outputs?.[0]?.covenant?.covenantId ?? null;
    if (outCid && this.#store.hasCid(outCid)) return true;
    for (const inp of rawTx?.inputs ?? []) {
      const prev = inp?.previousOutpoint;
      if (prev && this.#store.cidForManagerOutpoint(`${prev.transactionId}:${prev.index}`)) {
        return true;
      }
      const inCid = inp?.verboseData?.utxoEntry?.covenantId ?? null;
      if (inCid && this.#store.hasCid(inCid)) return true;
    }
    return false;
  }

  async #buildBatchFacts(rawTx, tx, blockHash, acceptingDaa, virtualDaa) {
    if (virtualDaa < acceptingDaa + REORG_RECHECK_DAA) return null;
    const rawInputs = rawTx?.inputs;
    if (!Array.isArray(rawInputs) || rawInputs.length !== tx.inputs.length || !rawInputs.every(i => i?.verboseData?.utxoEntry)) {
      return null;
    }
    const inputs = rawInputs.map((i, idx) => {
      const u = i.verboseData.utxoEntry;
      return {
        outpoint: tx.inputs[idx].previousOutpoint,
        value: BigInt(u.amount),
        spk: typeof u.scriptPublicKey === 'string' ? parseSpk(u.scriptPublicKey) : u.scriptPublicKey,
        utxoDaa: BigInt(u.blockDaaScore),
        cid: u.covenantId ?? null,
      };
    });
    const facts = {
      accepted: true,
      networkGenesis: this.#config.genesisHash,
      transaction: tx,
      utxoDaa: acceptingDaa,
      currentDaa: acceptingDaa,
      observedVirtualDaa: virtualDaa,
      position: {acceptingBlockHash: blockHash},
      assertCurrent: () => {},
      release: () => {},
    };
    if (!inputs[0].cid || inputs[0].cid === S.ZERO) {
      facts.funds = inputs;
      return facts;
    }
    const own = decodeSpend(tx.inputs[0].signatureScript, this.#profile);
    const cid = inputs[0].cid;
    let origin;
    if (own.state.module === 'sales') {
      origin = {transactionId: S.hex(own.args.originTxId), index: Number(own.args.originIndex)};
    } else {
      const round = await this.#store.archive.getRound(this.#config.genesisHash, this.#profile.id, cid);
      if (!round?.origin) return null;
      origin = round.origin;
    }
    facts.manager = {...inputs[0], origin, currentDaa: acceptingDaa, redeemScript: own.raw};
    facts.targets = [];
    facts.funds = [];
    let funding = false;
    for (let i = 1; i < inputs.length; i++) {
      const u = inputs[i];
      if (u.cid && u.cid !== S.ZERO) {
        if (funding || u.cid !== cid) return null;
        const w = decodeSpend(tx.inputs[i].signatureScript, this.#profile);
        if (w.state.module !== 'frozen') return null;
        facts.targets.push({...u, redeemScript: w.raw});
      } else {
        funding = true;
        facts.funds.push(u);
      }
    }
    if (own.state.module === 'sealed' && own.args.action === 4n) {
      if (own.args.data.length < 240) return null;
      const hash = S.hex(own.args.data.slice(0, 32));
      const b = (await this.#link.call('getBlock', {hash, includeTransactions: false}))?.block;
      if (b?.header?.hash !== hash || b.verboseData?.isChainBlock !== true) return null;
      facts.accessor = {blockHash: hash, sequenceCommitment: b.header.acceptedIdMerkleRoot};
    }
    return facts;
  }

  async #ingestRawTx(rawTx, blockHash, acceptingDaa, virtualDaa, fromFullVchain = false) {
    const tx = txFromRpc(rawTx);
    const txid = rawTx?.verboseData?.transactionId ?? referenceTxId(tx);

    // Determine cid if already tracked so we can supply expectedRevision.
    let knownCid = null;
    for (const inp of tx.inputs) {
      const k = outpointKey(inp.previousOutpoint);
      const c = this.#store.cidForManagerOutpoint(k);
      if (c) {knownCid = c; break;}
    }
    if (!knownCid) {
      const outCid = tx.outputs?.[0]?.covenant?.covenantId ?? null;
      if (outCid && this.#store.hasCid(outCid)) knownCid = outCid;
    }
    const existing = knownCid ? await this.#store.getRound(knownCid) : null;
    const expectedRevision = existing?.revision ?? '0';

    const batchKey = `${txid}/${blockHash}`;
    if (fromFullVchain) {
      try {
        const fastFacts = await this.#buildBatchFacts(rawTx, tx, blockHash, acceptingDaa, virtualDaa);
        if (fastFacts) this.#batchFacts.set(batchKey, fastFacts);
      } catch {
        this.#batchFacts.delete(batchKey);
      }
    }
    let view;
    try {
      view = await this.#indexer.ingest(txid, {acceptingBlockHash: blockHash}, expectedRevision);
    } finally {
      this.#batchFacts.delete(batchKey);
    }

    // Extract event + export metadata from the committed journal event at view.revision.
    const events = await this.#store.archive.readEvents(
      this.#config.genesisHash,
      this.#profile.id,
      view.cid,
      {offset: Number(BigInt(view.revision) - 1n), limit: 1, revision: view.revision},
    );
    const event = events[0];
    if (!event || event.type !== 'ACCEPT') return;

    const inputSum = (rawTx.inputs ?? []).reduce(
      (sum, i) => sum + BigInt(i?.verboseData?.utxoEntry?.amount ?? 0),
      0n,
    );
    const outputSum = tx.outputs.reduce((sum, o) => sum + o.value, 0n);
    const feeSompi = (inputSum >= outputSum ? inputSum - outputSum : 0n).toString();

    let buysDelta = 0;
    let boughtDelta = 0;
    let accessor = null;
    let managerScriptHash = null;
    let managerOutpoint = null;
    const targets = [];

    if (event.action === 'BUY') {
      buysDelta = 1;
      const w = decodeSpend(tx.inputs[0].signatureScript, this.#profile);
      boughtDelta = Number(S.fromLe(w.args.data.slice(0, 4)));
    } else if (event.action === 'DRAW') {
      const w = decodeSpend(tx.inputs[0].signatureScript, this.#profile);
      const accessorHash = S.hex(w.args.data.slice(0, 32));
      const b = (await this.#link.call('getBlock', {hash: accessorHash, includeTransactions: false}))?.block;
      if (b?.header?.acceptedIdMerkleRoot) {
        accessor = {blockHash: accessorHash, sequenceCommitment: b.header.acceptedIdMerkleRoot};
      }
    }

    if (event.action !== 'GENESIS') {
      const prevManager = event.before?.manager;
      if (prevManager) {
        managerOutpoint = prevManager.outpoint;
        managerScriptHash = prevManager.scriptHash;
      }
      for (const t of event.before?.restoredFrozen ?? []) {
        targets.push({outpoint: t.outpoint, scriptHash: t.scriptHash});
      }
    }

    const summary = await this.#summarizeView(view, virtualDaa);
    const settings = await this.#extractSettings(view, tx);

    await this.#store.recordAccept({
      view,
      summary,
      txMeta: {
        txid,
        cid: view.cid,
        action: event.action,
        revision: view.revision,
        acceptingBlock: blockHash,
        acceptingDaa: acceptingDaa.toString(),
        instance: event.instance,
        feeSompi,
        quantity: boughtDelta,
      },
      blockEntry: {
        cid: view.cid,
        instance: event.instance,
        txid,
        action: event.action,
        revision: view.revision,
        acceptingBlock: blockHash,
        acceptingDaa: acceptingDaa.toString(),
      },
      exportDelta: {
        settings,
        buysDelta,
        boughtDelta,
        feeSompi,
        receipt: {
          txid,
          action: event.action,
          accepted: true,
          candidate: false,
          finalized: true,
          acceptingBlock: blockHash,
          acceptingDaa: acceptingDaa.toString(),
          feeSompi,
          computeMass: rawTx?.verboseData?.computeMass != null ? String(rawTx.verboseData.computeMass) : null,
          storageMass: rawTx?.verboseData?.storageMass != null ? String(rawTx.verboseData.storageMass) : '0',
          transientMass: '0',
        },
        proof: {
          txid,
          acceptingBlock: blockHash,
          action: event.action,
          managerOutpoint,
          managerScriptHash,
          targets,
          accessor,
        },
      },
    });
  }

  async revertBlocks(removedHashes) {
    await this.#connect();
    return this.#revertBlocks(removedHashes);
  }

  async #revertBlocks(removedHashes) {
    const candidates = [];
    let orderIndex = 0;
    for (const h of [...removedHashes].reverse()) {
      const entries = await this.#store.getBlockEntries(h);
      for (const e of [...entries].reverse()) {
        candidates.push({
          entry: e,
          daa: BigInt(e.acceptingDaa ?? '0'),
          revision: BigInt(e.revision ?? '0'),
          orderIndex: orderIndex++,
        });
      }
    }
    if (candidates.length === 0) return;

    // Sort all candidates (never pre-filter by current head) so descendants are reverted before parents.
    candidates.sort((a, b) => {
      if (b.daa !== a.daa) return b.daa > a.daa ? 1 : -1;
      if (b.revision !== a.revision) return b.revision > a.revision ? 1 : -1;
      return a.orderIndex - b.orderIndex;
    });

    for (const item of candidates) {
      const latest = await this.#store.getRound(item.entry.cid);
      if (!latest || latest.acceptance?.instance !== item.entry.instance) continue;
      const revertedView = await this.#indexer.revert(item.entry.cid, item.entry.instance, latest.revision);
      const summary = await this.#summarizeView(revertedView, BigInt(this.#virtualDaa || '0'));
      await this.#store.recordRevert({
        view: revertedView,
        summary,
        revertedInstance: item.entry.instance,
      });
    }
  }

  async #summarizeView(view, virtualDaa) {
    if (!view.manager) {
      return {
        module: null,
        tickets: 0,
        shards: 0,
        localRecords: 0,
        ticketPrice: '0',
        ticketCap: 0,
        minTickets: 0,
        closeEligibleDaa: '0',
      };
    }
    const pre = await this.#store.getPreimage(view.manager.scriptHash);
    if (!pre) {
      return {module: view.manager.module, tickets: 0, shards: 0, localRecords: 0};
    }
    const utxoDaa = BigInt(view.manager.utxoDaa);
    const currentDaa = virtualDaa > utxoDaa ? virtualDaa : utxoDaa;
    const s = verifyManager({
      outpoint: view.manager.outpoint,
      origin: view.origin,
      cid: view.cid,
      value: BigInt(view.manager.value),
      spk: {version: 0, script: `aa20${view.manager.scriptHash}87`},
      redeemScript: S.unhex(pre),
      utxoDaa,
      currentDaa,
      daa: utxoDaa,
      covenantId: view.cid,
    }, this.#profile);
    return {
      module: s.module,
      tickets: S.totalTickets(s),
      shards: s.indices.length,
      localRecords: s.records.length,
      ticketPrice: s.ticketPrice.toString(),
      ticketCap: s.ticketCap,
      minTickets: s.minTickets,
      closeEligibleDaa: s.closeEligibleDaa.toString(),
      winnerKey: s.winnerKey ?? null,
      payCursor: s.p ?? null,
      refundShard: s.r ?? null,
      refundCursor: s.c ?? null,
    };
  }

  async #extractSettings(view, tx) {
    if (view.manager) {
      const pre = await this.#store.getPreimage(view.manager.scriptHash);
      if (pre) {
        const s = identify(S.unhex(pre), this.#profile);
        return {
          ticketPrice: s.ticketPrice.toString(),
          ticketCap: s.ticketCap,
          minTickets: s.minTickets,
          closeEligibleDaa: s.closeEligibleDaa.toString(),
        };
      }
    }
    const raw = S.unhex(tx.payload);
    if (raw.length === 25 + 32 + 59) {
      const s = S.decode('sales', raw.slice(25 + 32));
      return {
        ticketPrice: s.ticketPrice.toString(),
        ticketCap: s.ticketCap,
        minTickets: s.minTickets,
        closeEligibleDaa: s.closeEligibleDaa.toString(),
      };
    }
    return {ticketPrice: '0', ticketCap: 3, minTickets: 3, closeEligibleDaa: '0'};
  }
}
