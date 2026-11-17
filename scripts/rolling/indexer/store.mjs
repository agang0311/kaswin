/** Durable single-writer store for the TN10 Rolling sidecar.
 * Wraps FileArchive (preimages, rounds, journal, receipts) and adds atomic cursor,
 * round-index, txid->cid, block->instances, and export-metadata persistence.
 * Importing this file does not touch the filesystem or start any background work.
 */
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FileArchive} from '../../../experiments/rolling/archive.mjs';
import {check, identify, unhex} from '../core.mjs';
import {DEFAULTS, SCHEMA, fail, hash, need} from './config.mjs';

const TRAIL_LIMIT = 512;

function seg(value) {
  hash(value);
  return value;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function atomicWriteText(path, text) {
  const dir = dirname(path);
  const firstCreated = await mkdir(dir, {recursive: true, mode: 0o700});
  if (firstCreated) {
    const stop = resolve(dirname(firstCreated));
    let at = resolve(dir);
    for (;;) {
      const d = await open(at, 'r');
      try {await d.sync();} finally {await d.close();}
      if (at === stop || dirname(at) === at) break;
      at = dirname(at);
    }
  }
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  let file = null;
  try {
    file = await open(tmp, 'wx', 0o600);
    await file.writeFile(text, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await rename(tmp, path);
    const d = await open(dir, 'r');
    try {await d.sync();} finally {await d.close();}
  } finally {
    if (file) await file.close();
    await unlink(tmp).catch(e => {if (e.code !== 'ENOENT') throw e;});
  }
}

async function atomicWriteJson(path, value) {
  await atomicWriteText(path, JSON.stringify(value));
}

export class RollingStore {
  #root;
  #archive;
  #network;
  #genesisHash;
  #profileId;
  #lockHandle = null;
  #lockPath;
  #queue = Promise.resolve();
  #liveManagers = new Map(); // outpointKey -> cid
  #knownCids = new Set();

  constructor({dataDir, network, genesisHash, profileId}) {
    need(typeof dataDir === 'string' && dataDir.length > 0, 'ARCHIVE_ROOT', 500);
    this.#root = resolve(dataDir);
    this.#network = network;
    this.#genesisHash = seg(genesisHash);
    this.#profileId = seg(profileId);
    this.#archive = new FileArchive(join(this.#root, 'archive'));
    this.#lockPath = join(this.#root, 'writer.lock');
  }

  get archive() {
    return this.#archive;
  }

  get root() {
    return this.#root;
  }

  async #exclusive(fn) {
    const prev = this.#queue;
    let release;
    this.#queue = new Promise(r => {release = r;});
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async acquireLock() {
    if (this.#lockHandle) return;
    await mkdir(this.#root, {recursive: true, mode: 0o700});
    try {
      this.#lockHandle = await open(this.#lockPath, 'wx', 0o600);
      await this.#lockHandle.writeFile(JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
      await this.#lockHandle.sync();
    } catch (e) {
      if (e.code === 'EEXIST') throw fail('WRITER_LOCKED', 503);
      throw e;
    }
  }

  async releaseLock() {
    if (!this.#lockHandle) return;
    try {await this.#lockHandle.close();} catch {}
    this.#lockHandle = null;
    await unlink(this.#lockPath).catch(e => {if (e.code !== 'ENOENT') throw e;});
  }

  async init(startHash) {
    seg(startHash);
    await this.#exclusive(async () => {
      const cursor = await this.getCursor();
      if (!cursor) {
        await atomicWriteJson(join(this.#root, 'meta', 'cursor.json'), {
          schema: SCHEMA,
          network: this.#network,
          genesisHash: this.#genesisHash,
          profileId: this.#profileId,
          startHash,
          lastBlockHash: startHash,
          lastBlockDaa: '0',
          lastBlockBlueScore: '0',
          virtualDaa: '0',
          revision: '0',
          updatedAt: new Date().toISOString(),
          trail: [],
        });
      }
      const index = await this.#readIndex();
      if (!index) {
        await atomicWriteJson(join(this.#root, 'meta', 'rounds-index.json'), {
          schema: SCHEMA,
          network: this.#network,
          genesisHash: this.#genesisHash,
          profileId: this.#profileId,
          revision: '0',
          rounds: [],
        });
      } else {
        for (const r of index.rounds) {
          this.#knownCids.add(r.cid);
          if (r.managerOutpoint && !r.terminal) {
            this.#liveManagers.set(`${r.managerOutpoint.transactionId}:${r.managerOutpoint.index}`, r.cid);
          }
        }
      }
    });
  }

  hasCid(cid) {
    return this.#knownCids.has(cid);
  }

  cidForManagerOutpoint(outpointKey) {
    return this.#liveManagers.get(outpointKey) ?? null;
  }

  async getCursor() {
    return readJson(join(this.#root, 'meta', 'cursor.json'));
  }

  async saveCursor(patch) {
    return this.#exclusive(async () => {
      const current = await this.getCursor();
      need(current, 'CURSOR_NOT_INITIALIZED', 500);
      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      if (Array.isArray(next.trail) && next.trail.length > TRAIL_LIMIT) {
        next.trail = next.trail.slice(next.trail.length - TRAIL_LIMIT);
      }
      await atomicWriteJson(join(this.#root, 'meta', 'cursor.json'), next);
      return next;
    });
  }

  async #readIndex() {
    return readJson(join(this.#root, 'meta', 'rounds-index.json'));
  }

  async listRounds({cursor = null, limit = DEFAULTS.pageLimit} = {}) {
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= DEFAULTS.maxPageLimit, 'PAGE_LIMIT');
    const index = await this.#readIndex();
    need(index, 'INDEX_NOT_INITIALIZED', 500);
    const total = index.rounds.length;
    let offset = 0;
    if (cursor) {
      need(typeof cursor === 'string' && cursor.length <= 4096, 'CURSOR_SIZE', 400);
      let decoded;
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        throw fail('INVALID_CURSOR', 400);
      }
      if (
        decoded?.network !== this.#network ||
        decoded?.genesisHash !== this.#genesisHash ||
        decoded?.profileId !== this.#profileId ||
        decoded?.revision !== index.revision
      ) {
        throw fail('CURSOR_STALE', 409);
      }
      check(Number.isSafeInteger(decoded.offset) && decoded.offset >= 0 && decoded.offset <= total, 'INVALID_CURSOR');
      offset = decoded.offset;
    }
    const rounds = index.rounds.slice(offset, offset + limit);
    const nextOffset = offset + rounds.length;
    const next = nextOffset < total
      ? Buffer.from(JSON.stringify({
          network: this.#network,
          genesisHash: this.#genesisHash,
          profileId: this.#profileId,
          revision: index.revision,
          offset: nextOffset,
        })).toString('base64url')
      : null;
    return {revision: index.revision, total, rounds, next};
  }

  async getRound(cid) {
    seg(cid);
    return this.#archive.getRound(this.#genesisHash, this.#profileId, cid);
  }

  async getRoundExportMeta(cid) {
    seg(cid);
    return readJson(join(this.#root, 'meta', 'export', `${cid}.json`));
  }

  async getTxidMapping(txid) {
    seg(txid);
    return readJson(join(this.#root, 'meta', 'txids', txid.slice(0, 2), `${txid}.json`));
  }

  async getBlockEntries(blockHash) {
    seg(blockHash);
    return (await readJson(join(this.#root, 'meta', 'blocks', blockHash.slice(0, 2), `${blockHash}.json`))) ?? [];
  }

  async getPreimage(scriptHash) {
    seg(scriptHash);
    return this.#archive.getPreimage(this.#genesisHash, this.#profileId, scriptHash);
  }

  async readHistory(cid, {cursor = null, limit = 100} = {}) {
    seg(cid);
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'HISTORY_LIMIT');
    const view = await this.getRound(cid);
    if (!view) return null;
    check(BigInt(view.revision) <= BigInt(Number.MAX_SAFE_INTEGER), 'REVISION_RANGE');
    const count = Number(view.revision);
    let offset = 0;
    if (cursor) {
      need(typeof cursor === 'string' && cursor.length <= 4096, 'CURSOR_SIZE', 400);
      let c;
      try {
        c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        throw fail('INVALID_CURSOR', 400);
      }
      if (
        c?.network !== this.#genesisHash ||
        c?.profile !== this.#profileId ||
        c?.cid !== cid ||
        c?.revision !== view.revision
      ) {
        throw fail('CURSOR_STALE', 409);
      }
      offset = check(Number.isSafeInteger(c.offset) && c.offset >= 0 && c.offset <= count, 'INVALID_CURSOR') || c.offset;
    }
    const events = await this.#archive.readEvents(this.#genesisHash, this.#profileId, cid, {
      offset,
      limit,
      revision: view.revision,
    });
    const nextOffset = offset + events.length;
    const next = nextOffset < count
      ? Buffer.from(JSON.stringify({
          network: this.#genesisHash,
          profile: this.#profileId,
          cid,
          revision: view.revision,
          offset: nextOffset,
        })).toString('base64url')
      : null;
    return {revision: view.revision, events, next};
  }

  async recordAccept({view, summary, txMeta, blockEntry, exportDelta}) {
    return this.#exclusive(async () => {
      const cid = seg(view.cid);
      const txid = seg(txMeta.txid);
      const blockHash = seg(txMeta.acceptingBlock);

      // 1. Update export metadata with undo stack keyed by instance
      const expPath = join(this.#root, 'meta', 'export', `${cid}.json`);
      const exp = (await readJson(expPath)) ?? {
        schema: SCHEMA,
        cid,
        origin: view.origin,
        settings: exportDelta.settings,
        step: 0,
        buys: 0,
        bought: 0,
        fees: '0',
        accepting: null,
        receipts: [],
        proofs: [],
      };
      if (!exp.proofs.some(p => p.instance === txMeta.instance)) {
        const prevAccepting = exp.accepting;
        exp.step += 1;
        exp.buys += exportDelta.buysDelta;
        exp.bought += exportDelta.boughtDelta;
        exp.fees = (BigInt(exp.fees) + BigInt(exportDelta.feeSompi)).toString();
        exp.accepting = blockHash;
        exp.receipts.push(exportDelta.receipt);
        exp.proofs.push({
          instance: txMeta.instance,
          prevAccepting,
          buysDelta: exportDelta.buysDelta,
          boughtDelta: exportDelta.boughtDelta,
          feeSompi: exportDelta.feeSompi,
          proof: exportDelta.proof,
        });
        exp.committedView = {
          cid: view.cid,
          origin: view.origin,
          revision: view.revision,
          terminal: view.terminal,
          manager: view.manager,
          frozen: view.frozen,
          acceptance: view.acceptance,
        };
        await atomicWriteJson(expPath, exp);
      }

      // 2. Write txid -> cid mapping
      await atomicWriteJson(join(this.#root, 'meta', 'txids', txid.slice(0, 2), `${txid}.json`), {
        schema: SCHEMA,
        network: this.#network,
        genesisHash: this.#genesisHash,
        profileId: this.#profileId,
        ...txMeta,
      });

      // 3. Append block -> instance entry
      const blkPath = join(this.#root, 'meta', 'blocks', blockHash.slice(0, 2), `${blockHash}.json`);
      const blk = (await readJson(blkPath)) ?? [];
      if (!blk.some(e => e.cid === cid && e.instance === txMeta.instance)) {
        blk.push(blockEntry);
        await atomicWriteJson(blkPath, blk);
      }

      // 4. Update rounds index & live manager map
      const index = (await this.#readIndex()) ?? {
        schema: SCHEMA,
        network: this.#network,
        genesisHash: this.#genesisHash,
        profileId: this.#profileId,
        revision: '0',
        rounds: [],
      };
      const oldEntry = index.rounds.find(r => r.cid === cid);
      if (oldEntry?.managerOutpoint) {
        this.#liveManagers.delete(`${oldEntry.managerOutpoint.transactionId}:${oldEntry.managerOutpoint.index}`);
      }
      const nextEntry = {
        cid,
        origin: view.origin,
        module: summary.module,
        terminal: view.terminal,
        tickets: summary.tickets,
        shards: summary.shards,
        frozenCount: view.frozen.length,
        managerOutpoint: view.manager?.outpoint ?? null,
        managerValue: view.manager?.value ?? null,
        acceptingBlock: view.acceptance?.position?.acceptingBlockHash ?? blockHash,
        acceptingDaa: view.acceptance?.acceptingDaa ?? txMeta.acceptingDaa,
        step: exp.step,
        buys: exp.buys,
        bought: exp.bought,
        fees: exp.fees,
        roundRevision: view.revision,
        updatedAt: new Date().toISOString(),
      };
      const filtered = index.rounds.filter(r => r.cid !== cid);
      filtered.push(nextEntry);
      filtered.sort((a, b) => {
        const da = BigInt(a.acceptingDaa ?? '0');
        const db = BigInt(b.acceptingDaa ?? '0');
        if (db > da) return 1;
        if (db < da) return -1;
        return a.cid.localeCompare(b.cid);
      });
      const nextRev = (BigInt(index.revision) + 1n).toString();
      await atomicWriteJson(join(this.#root, 'meta', 'rounds-index.json'), {
        ...index,
        revision: nextRev,
        rounds: filtered,
      });

      this.#knownCids.add(cid);
      if (nextEntry.managerOutpoint && !nextEntry.terminal) {
        this.#liveManagers.set(`${nextEntry.managerOutpoint.transactionId}:${nextEntry.managerOutpoint.index}`, cid);
      }
      return {globalRevision: nextRev, entry: nextEntry};
    });
  }

  async recordRevert({view, summary, revertedInstance}) {
    return this.#exclusive(async () => {
      const cid = seg(view.cid);
      seg(revertedInstance);
      const expPath = join(this.#root, 'meta', 'export', `${cid}.json`);
      const exp = await readJson(expPath);
      let revertedTxid = null;
      if (exp && exp.proofs.length > 0) {
        const idx = exp.proofs.findIndex(p => p.instance === revertedInstance);
        if (idx >= 0) {
          const [removed] = exp.proofs.splice(idx, 1);
          revertedTxid = removed.proof?.txid ?? null;
          exp.step = Math.max(0, exp.step - 1);
          exp.buys = Math.max(0, exp.buys - removed.buysDelta);
          exp.bought = Math.max(0, exp.bought - removed.boughtDelta);
          const nextFees = BigInt(exp.fees) - BigInt(removed.feeSompi);
          exp.fees = (nextFees >= 0n ? nextFees : 0n).toString();
          exp.accepting = removed.prevAccepting ?? null;
          if (revertedTxid) {
            exp.receipts = exp.receipts.filter(r => r.txid !== revertedTxid);
          }
          exp.committedView = {
            cid: view.cid,
            origin: view.origin,
            revision: view.revision,
            terminal: view.terminal,
            manager: view.manager,
            frozen: view.frozen,
            acceptance: view.acceptance,
          };
          await atomicWriteJson(expPath, exp);
        }
      }

      if (revertedTxid && /^[0-9a-f]{64}$/.test(revertedTxid)) {
        await unlink(join(this.#root, 'meta', 'txids', revertedTxid.slice(0, 2), `${revertedTxid}.json`)).catch(e => {
          if (e.code !== 'ENOENT') throw e;
        });
      }

      const index = await this.#readIndex();
      if (!index) return null;
      const oldEntry = index.rounds.find(r => r.cid === cid);
      if (oldEntry?.managerOutpoint) {
        this.#liveManagers.delete(`${oldEntry.managerOutpoint.transactionId}:${oldEntry.managerOutpoint.index}`);
      }
      const filtered = index.rounds.filter(r => r.cid !== cid);
      if (view.terminal !== 'GENESIS_REVERTED') {
        const nextEntry = {
          cid,
          origin: view.origin,
          module: summary?.module ?? null,
          terminal: view.terminal,
          tickets: summary?.tickets ?? 0,
          shards: summary?.shards ?? 0,
          frozenCount: view.frozen.length,
          managerOutpoint: view.manager?.outpoint ?? null,
          managerValue: view.manager?.value ?? null,
          acceptingBlock: view.acceptance?.position?.acceptingBlockHash ?? null,
          acceptingDaa: view.acceptance?.acceptingDaa ?? '0',
          step: exp?.step ?? 0,
          buys: exp?.buys ?? 0,
          bought: exp?.bought ?? 0,
          fees: exp?.fees ?? '0',
          roundRevision: view.revision,
          updatedAt: new Date().toISOString(),
        };
        filtered.push(nextEntry);
        if (nextEntry.managerOutpoint && !nextEntry.terminal) {
          this.#liveManagers.set(`${nextEntry.managerOutpoint.transactionId}:${nextEntry.managerOutpoint.index}`, cid);
        }
      }
      filtered.sort((a, b) => {
        const da = BigInt(a.acceptingDaa ?? '0');
        const db = BigInt(b.acceptingDaa ?? '0');
        if (db > da) return 1;
        if (db < da) return -1;
        return a.cid.localeCompare(b.cid);
      });
      const nextRev = (BigInt(index.revision) + 1n).toString();
      await atomicWriteJson(join(this.#root, 'meta', 'rounds-index.json'), {
        ...index,
        revision: nextRev,
        rounds: filtered,
      });
      return {globalRevision: nextRev};
    });
  }

  async exportRoundPayload(cid, profile) {
    seg(cid);
    return this.#exclusive(async () => {
      const exp = await this.getRoundExportMeta(cid);
      const view = exp?.committedView ?? await this.getRound(cid);
      if (!view || view.terminal === 'GENESIS_REVERTED') return null;
      need(exp, 'EXPORT_META_MISSING', 500);

      let manager = null;
      if (view.manager) {
        const pre = await this.getPreimage(view.manager.scriptHash);
        need(pre, 'MISSING_MANAGER_PREIMAGE', 500);
        const utxoDaa = BigInt(view.manager.utxoDaa);
        const obsDaa = view.acceptance?.observedVirtualDaa ? BigInt(view.acceptance.observedVirtualDaa) : utxoDaa;
        manager = {
          outpoint: view.manager.outpoint,
          origin: view.origin,
          cid: view.cid,
          value: BigInt(view.manager.value),
          spk: {version: 0, script: p2shScript(view.manager.scriptHash)},
          redeemScript: unhex(pre),
          utxoDaa,
          currentDaa: obsDaa >= utxoDaa ? obsDaa : utxoDaa,
          daa: utxoDaa,
          covenantId: view.cid,
        };
      }

      const frozen = [];
      for (const f of view.frozen) {
        const pre = await this.getPreimage(f.scriptHash);
        need(pre, 'MISSING_FROZEN_PREIMAGE', 500);
        const utxoDaa = BigInt(f.utxoDaa);
        frozen.push({
          outpoint: f.outpoint,
          cid: view.cid,
          covenantId: view.cid,
          origin: view.origin,
          value: BigInt(f.value),
          spk: {version: 0, script: p2shScript(f.scriptHash)},
          redeemScript: unhex(pre),
          utxoDaa,
          daa: utxoDaa,
        });
      }

      const lastProofEntry = exp.proofs.at(-1) ?? null;
      let terminalProof = null;
      if (view.terminal && lastProofEntry?.proof) {
        const p = lastProofEntry.proof;
        const managerRedeemHex = p.managerScriptHash ? await this.getPreimage(p.managerScriptHash) : null;
        const targets = [];
        for (const t of p.targets ?? []) {
          const redeemHex = await this.getPreimage(t.scriptHash);
          need(redeemHex, 'MISSING_TARGET_PREIMAGE', 500);
          targets.push({outpoint: t.outpoint, scriptHash: t.scriptHash, redeemHex});
        }
        terminalProof = {
          txid: p.txid,
          acceptingBlock: p.acceptingBlock,
          action: p.action,
          managerOutpoint: p.managerOutpoint,
          managerRedeemHex,
          targets,
          accessor: p.accessor ?? null,
        };
      }

      const roundObj = {
        v: 1,
        network: this.#network,
        profileId: this.#profileId,
        cid: view.cid,
        origin: view.origin,
        settings: {
          ticketPrice: BigInt(exp.settings.ticketPrice),
          ticketCap: exp.settings.ticketCap,
          minTickets: exp.settings.minTickets,
          closeEligibleDaa: BigInt(exp.settings.closeEligibleDaa),
        },
        manager,
        frozen,
        accepting: view.acceptance?.position?.acceptingBlockHash ?? exp.accepting ?? null,
        step: exp.step,
        buys: exp.buys,
        bought: exp.bought,
        fees: BigInt(exp.fees),
        terminal: view.terminal,
        receipts: exp.receipts,
        pending: [],
        halted: null,
        source: 'imported',
        intent: null,
      };
      let historicalShards = null;
      if (view.terminal && view.terminal !== 'EMPTY' && terminalProof?.managerRedeemHex) {
        try {
          const mgrState = identify(unhex(terminalProof.managerRedeemHex), profile);
          if (Array.isArray(mgrState?.indices) && mgrState.indices.length > 0) {
            const items = [];
            let complete = true;
            for (const idx of mgrState.indices) {
              const redeemHex = await this.getPreimage(idx.hash);
              if (!redeemHex) {complete = false; break;}
              items.push({hash: idx.hash, redeemHex});
            }
            if (complete) historicalShards = {terminalManagerHex: terminalProof.managerRedeemHex, shards: items};
          }
        } catch {}
      }
      return {view, roundObj, terminalProof, historicalShards};
    });
  }
}

function p2shScript(scriptHashHex) {
  unhex(scriptHashHex, 32);
  return `aa20${scriptHashHex}87`;
}
