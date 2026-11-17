/** Read-only HTTP service handler for the TN10 Rolling sidecar.
 * Exposes /tn10/rolling/v1/{profileId}, /v1/rolling/{genesisHash}/{profileId}, and /v1.
 * Public GET/HEAD/OPTIONS only; no public write endpoints, no keys, no signing, no broadcast.
 * Importing this file starts no listener.
 */
import {encodeTagged} from '../../../web/rolling-tn10/codec.mjs';
import {verifyManager} from '../core.mjs';
import * as S from '../core.mjs';
import {SCHEMA, fail, hash, need, safeCode, wire} from './config.mjs';

function corsHeaders(req, config) {
  const origin = req.headers.origin;
  let allowOrigin = '*';
  if (config.corsOrigins && config.corsOrigins.length > 0) {
    allowOrigin = origin && config.corsOrigins.includes(origin) ? origin : config.corsOrigins[0];
  }
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'origin',
  };
}

function sendJson(req, res, status, body, config) {
  const text = wire(body);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > config.maxResponseBytes) {
    const errBytes = Buffer.from(JSON.stringify({error: 'RESPONSE_TOO_LARGE'}), 'utf8');
    res.writeHead(500, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': errBytes.length,
      ...corsHeaders(req, config),
    });
    res.end(req.method === 'HEAD' ? undefined : errBytes);
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': bytes.length,
    ...corsHeaders(req, config),
  });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

async function writeNdjsonLine(res, row) {
  if (res.destroyed) throw fail('EXPORT_CONNECTION_CLOSED', 499);
  if (res.write(wire(row) + '\n')) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {cleanup(); resolve();};
    const onClose = () => {cleanup(); reject(fail('EXPORT_CONNECTION_CLOSED', 499));};
    const onError = e => {cleanup(); reject(e);};
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (res.destroyed) onClose();
  });
}

export class RollingIndexerService {
  #config;
  #profile;
  #store;
  #scanner;
  #activeRequests = 0;
  #rateBuckets = new Map(); // ip -> { windowStart, count }

  constructor({config, profile, store, scanner}) {
    this.#config = config;
    this.#profile = profile;
    this.#store = store;
    this.#scanner = scanner;
  }

  #prefixes() {
    return [
      `/tn10/rolling/v1/${this.#config.profileId}`,
      `/v1/rolling/${this.#config.genesisHash}/${this.#config.profileId}`,
      '/v1',
    ];
  }

  #stripPrefix(pathname) {
    for (const p of this.#prefixes()) {
      if (pathname === p) return '/';
      if (pathname.startsWith(p + '/')) return pathname.slice(p.length);
    }
    return null;
  }

  #checkRateLimit(req) {
    const ip = req.socket?.remoteAddress ?? 'local';
    const now = Date.now();
    let bucket = this.#rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= 60_000) {
      bucket = {windowStart: now, count: 0};
      this.#rateBuckets.set(ip, bucket);
      if (this.#rateBuckets.size > 4096) {
        const oldestKey = this.#rateBuckets.keys().next().value;
        this.#rateBuckets.delete(oldestKey);
      }
    }
    bucket.count += 1;
    if (bucket.count > this.#config.maxRequestsPerMinute) {
      throw fail('RATE_LIMITED', 429);
    }
  }

  async #roundDetail(cid) {
    hash(cid);
    const view = await this.#store.getRound(cid);
    if (!view || view.terminal === 'GENESIS_REVERTED') return null;
    const exp = await this.#store.getRoundExportMeta(cid);
    const scan = this.#scanner.status();
    const virtualDaa = BigInt(scan.virtualDaa || '0');
    const acceptingDaa = BigInt(view.acceptance?.acceptingDaa ?? '0');
    const depthDaa = virtualDaa > acceptingDaa ? (virtualDaa - acceptingDaa).toString() : '0';

    let summary = {
      module: null,
      ticketPrice: exp?.settings?.ticketPrice ?? '0',
      ticketCap: exp?.settings?.ticketCap ?? 0,
      minTickets: exp?.settings?.minTickets ?? 0,
      closeEligibleDaa: exp?.settings?.closeEligibleDaa ?? '0',
      tickets: 0,
      shards: 0,
      localRecords: 0,
      frozenCount: view.frozen.length,
      step: exp?.step ?? 0,
      buys: exp?.buys ?? 0,
      bought: exp?.bought ?? 0,
      fees: exp?.fees ?? '0',
      winnerKey: null,
      payCursor: null,
      refundShard: null,
      refundCursor: null,
    };

    if (view.manager) {
      const pre = await this.#store.getPreimage(view.manager.scriptHash);
      need(pre, 'MISSING_MANAGER_PREIMAGE', 500);
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
      summary = {
        ...summary,
        module: s.module,
        ticketPrice: s.ticketPrice.toString(),
        ticketCap: s.ticketCap,
        minTickets: s.minTickets,
        closeEligibleDaa: s.closeEligibleDaa.toString(),
        tickets: S.totalTickets(s),
        shards: s.indices.length,
        localRecords: s.records.length,
        winnerKey: s.winnerKey ?? null,
        payCursor: s.p ?? null,
        refundShard: s.r ?? null,
        refundCursor: s.c ?? null,
      };
    }

    const head = view.acceptance ? {
      instance: view.acceptance.instance,
      txid: view.acceptance.txid,
      acceptingBlock: view.acceptance.position?.acceptingBlockHash ?? null,
      acceptingDaa: view.acceptance.acceptingDaa,
      observedVirtualDaa: view.acceptance.observedVirtualDaa ?? null,
      depthDaa,
    } : null;

    return {
      schema: SCHEMA,
      network: this.#config.network,
      genesisHash: this.#config.genesisHash,
      profileId: this.#config.profileId,
      status: 'UNVALIDATED',
      cid: view.cid,
      origin: view.origin,
      revision: view.revision,
      terminal: view.terminal,
      manager: view.manager,
      frozen: view.frozen,
      summary,
      head,
    };
  }

  async handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(req, this.#config),
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    if (this.#activeRequests >= this.#config.maxConcurrentRequests) {
      sendJson(req, res, 503, {error: 'BUSY'}, this.#config);
      return;
    }

    this.#activeRequests += 1;
    try {
      this.#checkRateLimit(req);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(req, res, 405, {error: 'METHOD_NOT_ALLOWED'}, this.#config);
        return;
      }
      need(typeof req.url === 'string' && req.url.length <= this.#config.maxUrlBytes, 'REQUEST_PATH', 400);
      const url = new URL(req.url, 'https://rolling.invalid');
      const rel = this.#stripPrefix(url.pathname);
      if (rel === null) {
        sendJson(req, res, 404, {error: 'UNSUPPORTED_DOMAIN'}, this.#config);
        return;
      }

      const parts = rel.split('/').filter(Boolean);

      // GET /info
      if (parts.length === 1 && parts[0] === 'info') {
        const cursor = await this.#store.getCursor();
        need(cursor, 'CURSOR_NOT_INITIALIZED', 503);
        const list = await this.#store.listRounds({limit: 1});
        const scan = this.#scanner.status();
        sendJson(req, res, 200, {
          schema: SCHEMA,
          network: this.#config.network,
          genesisHash: this.#config.genesisHash,
          profileId: this.#config.profileId,
          status: 'UNVALIDATED',
          readOnly: true,
          cursor: {
            blockHash: cursor.lastBlockHash,
            daa: cursor.lastBlockDaa,
            blueScore: cursor.lastBlockBlueScore,
            virtualDaa: cursor.virtualDaa,
          },
          revision: list.revision,
          stale: scan.stale,
          running: scan.running,
          lastPollAt: scan.lastPollAt,
          lastSuccessAt: scan.lastSuccessAt,
          lastError: scan.lastError,
          roundsCount: list.total,
        }, this.#config);
        return;
      }

      // GET /rounds?cursor=&limit=
      if (parts.length === 1 && parts[0] === 'rounds') {
        const limitText = url.searchParams.get('limit') ?? String(this.#config.pageLimit);
        need(/^[0-9]{1,3}$/.test(limitText), 'PAGE_LIMIT', 400);
        const limit = Number(limitText);
        need(limit >= 1 && limit <= this.#config.maxPageLimit, 'PAGE_LIMIT', 400);
        const list = await this.#store.listRounds({
          cursor: url.searchParams.get('cursor'),
          limit,
        });
        sendJson(req, res, 200, {
          schema: SCHEMA,
          network: this.#config.network,
          genesisHash: this.#config.genesisHash,
          profileId: this.#config.profileId,
          status: 'UNVALIDATED',
          revision: list.revision,
          total: list.total,
          rounds: list.rounds,
          next: list.next,
          nextCursor: list.next,
        }, this.#config);
        return;
      }

      // GET /rounds/:cid
      if (parts.length === 2 && parts[0] === 'rounds') {
        const detail = await this.#roundDetail(parts[1]);
        if (!detail) {
          sendJson(req, res, 404, {error: 'ROUND_NOT_FOUND'}, this.#config);
          return;
        }
        sendJson(req, res, 200, detail, this.#config);
        return;
      }

      // GET /rounds/:cid/history?cursor=&limit=
      if (parts.length === 3 && parts[0] === 'rounds' && parts[2] === 'history') {
        const cid = hash(parts[1]);
        const limitText = url.searchParams.get('limit') ?? '100';
        need(/^[0-9]{1,3}$/.test(limitText), 'HISTORY_LIMIT', 400);
        const limit = Number(limitText);
        need(limit >= 1 && limit <= 100, 'HISTORY_LIMIT', 400);
        const hist = this.#scanner.indexer
          ? await this.#scanner.indexer.history(cid, {cursor: url.searchParams.get('cursor'), limit})
          : await this.#store.readHistory(cid, {cursor: url.searchParams.get('cursor'), limit});
        if (!hist) {
          sendJson(req, res, 404, {error: 'ROUND_NOT_FOUND'}, this.#config);
          return;
        }
        sendJson(req, res, 200, {
          schema: SCHEMA,
          network: this.#config.network,
          genesisHash: this.#config.genesisHash,
          profileId: this.#config.profileId,
          cid,
          ...hist,
          nextCursor: hist.next,
        }, this.#config);
        return;
      }

      // GET /rounds/:cid/export
      if (parts.length === 3 && parts[0] === 'rounds' && parts[2] === 'export') {
        const cid = hash(parts[1]);
        const format = url.searchParams.get('format');
        if (format === 'ndjson') {
          const view = await this.#store.getRound(cid);
          if (!view || view.terminal === 'GENESIS_REVERTED') {
            sendJson(req, res, 404, {error: 'ROUND_NOT_FOUND'}, this.#config);
            return;
          }
          need(this.#scanner.indexer, 'INDEXER_NOT_READY', 503);
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...corsHeaders(req, this.#config),
          });
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          for await (const row of this.#scanner.indexer.exportEntries(view)) {
            await writeNdjsonLine(res, row);
          }
          res.end();
          return;
        }

        const exported = await this.#store.exportRoundPayload(cid, this.#profile);
        if (!exported) {
          sendJson(req, res, 404, {error: 'ROUND_NOT_FOUND'}, this.#config);
          return;
        }
        const {view, roundObj, terminalProof, historicalShards} = exported;
        const roundText = encodeTagged(roundObj);
        const head = view.acceptance ? {
          instance: view.acceptance.instance,
          txid: view.acceptance.txid,
          acceptingBlock: view.acceptance.position?.acceptingBlockHash ?? null,
          acceptingDaa: view.acceptance.acceptingDaa,
          observedVirtualDaa: view.acceptance.observedVirtualDaa ?? null,
        } : null;

        sendJson(req, res, 200, {
          schema: SCHEMA,
          network: this.#config.network,
          genesisHash: this.#config.genesisHash,
          profileId: this.#config.profileId,
          cid: view.cid,
          status: 'UNVALIDATED',
          revision: view.revision,
          head,
          roundText,
          terminalProof,
          historicalShards: historicalShards ?? null,
        }, this.#config);
        return;
      }

      // GET /txid/:txid
      if (parts.length === 2 && parts[0] === 'txid') {
        const txid = hash(parts[1]);
        const mapping = await this.#store.getTxidMapping(txid);
        if (!mapping) {
          sendJson(req, res, 404, {error: 'TXID_NOT_FOUND'}, this.#config);
          return;
        }
        sendJson(req, res, 200, {
          schema: SCHEMA,
          network: this.#config.network,
          genesisHash: this.#config.genesisHash,
          profileId: this.#config.profileId,
          txid: mapping.txid,
          cid: mapping.cid,
          action: mapping.action,
          revision: mapping.revision,
          acceptingBlock: mapping.acceptingBlock,
          acceptingDaa: mapping.acceptingDaa,
          instance: mapping.instance,
          feeSompi: mapping.feeSompi,
          quantity: mapping.quantity,
        }, this.#config);
        return;
      }

      sendJson(req, res, 404, {error: 'NOT_FOUND'}, this.#config);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const code = safeCode(e);
      const conflict = ['CURSOR_STALE', 'REVISION_CONFLICT', 'IMMUTABLE_PREIMAGE_CONFLICT'].includes(code);
      const status = typeof e?.status === 'number'
        ? e.status
        : conflict
          ? 409
          : code !== 'INDEXER_UNAVAILABLE'
            ? 400
            : 500;
      sendJson(req, res, status, {error: code}, this.#config);
    } finally {
      this.#activeRequests -= 1;
    }
  }
}
