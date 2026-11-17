/** Offline tests for the TN10 Rolling sidecar (config, store, scanner reorg, HTTP service, export round-trip).
 * Uses synthetic accepted fixtures and an in-process loopback HTTP server on an ephemeral port.
 * Does NOT start a node, touch 8788 / /var/lib/kci*, read real keys, sign, or broadcast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {configFromArgs, DEFAULTS, SCHEMA, TN10, TN10_PROFILE_ID} from '../../scripts/indexer/config.mjs';
import {RollingStore} from '../../scripts/indexer/store.mjs';
import {RollingScanner} from '../../scripts/indexer/scanner.mjs';
import {RollingIndexerService} from '../../scripts/indexer/service.mjs';
import '../../scripts/indexer/server.mjs';

import {RollingIndexer} from '../../scripts/indexer/indexer.mjs';
import {buildGenesis, buildAction} from '../contracts/transactions.mjs';
import {profile, fund, OWNER, PRICE, FEE} from '../contracts/fixtures.mjs';
import {redeem} from '../contracts/profile.mjs';
import * as S from '../contracts/state.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {roundFromText} from '../../scripts/round/round.mjs';

function makeAcceptEntry(d, blockHash, daa, extras = {}) {
  return {
    accepted: true,
    networkGenesis: TN10.genesis,
    transaction: d.transaction,
    utxoDaa: daa,
    currentDaa: daa + 120n,
    observedVirtualDaa: daa + 120n,
    position: {acceptingBlockHash: blockHash},
    funds: d.inputUtxos,
    assertCurrent() {},
    release() {},
    ...extras,
  };
}

async function seedSyntheticLifecycle(store, {dirPrefix = '11'} = {}) {
  const facts = new Map();
  const nodeAdapter = {
    async authenticateAccepted(id) {
      return facts.get(id);
    },
    async authenticateReversal() {
      return {removed: true, networkGenesis: TN10.genesis};
    },
  };
  const indexer = new RollingIndexer({
    archive: store.archive,
    profile,
    networkGenesis: TN10.genesis,
    nodeAdapter,
  });

  const blockA = `${dirPrefix}`.repeat(32);
  const blockB = `${Number(dirPrefix) + 11}`.slice(0, 2).padStart(2, '0').repeat(32);
  const blockC = `${Number(dirPrefix) + 22}`.slice(0, 2).padStart(2, '0').repeat(32);
  const blockD = `${Number(dirPrefix) + 33}`.slice(0, 2).padStart(2, '0').repeat(32);

  const g = buildGenesis(
    profile,
    OWNER,
    {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n},
    {funds: [fund(1, 10n * PRICE, OWNER)], fee: FEE, budgets: [10]},
  );
  const gid = referenceTxId(g.transaction);
  facts.set(gid, makeAcceptEntry(g, blockA, 2000n));
  let view = await indexer.ingest(gid, {acceptingBlockHash: blockA}, '0');

  await store.recordAccept({
    view,
    summary: {module: 'sales', tickets: 0, shards: 0, localRecords: 0, ticketPrice: PRICE.toString(), ticketCap: 10, minTickets: 3, closeEligibleDaa: '1000'},
    txMeta: {
      txid: gid,
      cid: view.cid,
      action: 'GENESIS',
      revision: view.revision,
      acceptingBlock: blockA,
      acceptingDaa: '2000',
      instance: view.acceptance.instance,
      feeSompi: FEE.toString(),
      quantity: 0,
    },
    blockEntry: {cid: view.cid, instance: view.acceptance.instance, txid: gid, action: 'GENESIS', revision: view.revision, acceptingBlock: blockA, acceptingDaa: '2000'},
    exportDelta: {
      settings: {ticketPrice: PRICE.toString(), ticketCap: 10, minTickets: 3, closeEligibleDaa: '1000'},
      buysDelta: 0,
      boughtDelta: 0,
      feeSompi: FEE.toString(),
      receipt: {txid: gid, action: 'GENESIS', accepted: true, candidate: false, finalized: true, acceptingBlock: blockA, acceptingDaa: '2000', feeSompi: FEE.toString(), computeMass: '1000', storageMass: '0', transientMass: '0'},
      proof: {txid: gid, acceptingBlock: blockA, action: 'GENESIS', managerOutpoint: null, managerScriptHash: null, targets: [], accessor: null},
    },
  });

  const steps = [
    {action: 'BUY', block: blockB, daa: 2010n, qty: 1},
    {action: 'CLOSE', block: blockC, daa: 2020n, qty: 0},
    {action: 'REFUND_SELF', block: blockD, daa: 2030n, qty: 0},
  ];
  let prev = g;
  let prevId = gid;
  const txids = {genesis: gid};

  for (const st of steps) {
    const s = prev.transition.next;
    const manager = {
      outpoint: {transactionId: prevId, index: 0},
      value: prev.transaction.outputs[0].value,
      spk: prev.transaction.outputs[0].scriptPublicKey,
      cid: g.cid,
      origin: g.origin,
      redeemScript: redeem(s, profile),
      utxoDaa: st.daa - 10n,
      currentDaa: st.daa,
    };
    const funds = [fund(10 + Number(view.revision), 10n * PRICE, OWNER)];
    const d = buildAction(manager, profile, {action: st.action, actorKey: OWNER, quantity: st.qty || 1}, {funds, fee: FEE, budgets: [300, 10]});
    const id = referenceTxId(d.transaction);
    txids[st.action.toLowerCase()] = id;

    facts.set(id, makeAcceptEntry(d, st.block, st.daa, {manager, targets: [], funds}));
    view = await indexer.ingest(id, {acceptingBlockHash: st.block}, view.revision);

    const events = await store.archive.readEvents(TN10.genesis, profile.id, view.cid, {
      offset: Number(BigInt(view.revision) - 1n),
      limit: 1,
      revision: view.revision,
    });
    const ev = events[0];
    const nextState = view.manager ? d.transition.next : null;
    await store.recordAccept({
      view,
      summary: {
        module: nextState?.module ?? null,
        tickets: nextState ? S.totalTickets(nextState) : 0,
        shards: nextState ? nextState.indices.length : 0,
        localRecords: nextState ? nextState.records.length : 0,
        ticketPrice: PRICE.toString(),
        ticketCap: 10,
        minTickets: 3,
        closeEligibleDaa: '1000',
      },
      txMeta: {
        txid: id,
        cid: view.cid,
        action: st.action,
        revision: view.revision,
        acceptingBlock: st.block,
        acceptingDaa: st.daa.toString(),
        instance: view.acceptance.instance,
        feeSompi: FEE.toString(),
        quantity: st.qty,
      },
      blockEntry: {cid: view.cid, instance: view.acceptance.instance, txid: id, action: st.action, revision: view.revision, acceptingBlock: st.block, acceptingDaa: st.daa.toString()},
      exportDelta: {
        settings: {ticketPrice: PRICE.toString(), ticketCap: 10, minTickets: 3, closeEligibleDaa: '1000'},
        buysDelta: st.action === 'BUY' ? 1 : 0,
        boughtDelta: st.qty,
        feeSompi: FEE.toString(),
        receipt: {txid: id, action: st.action, accepted: true, candidate: false, finalized: true, acceptingBlock: st.block, acceptingDaa: st.daa.toString(), feeSompi: FEE.toString(), computeMass: '1000', storageMass: '0', transientMass: '0'},
        proof: {
          txid: id,
          acceptingBlock: st.block,
          action: st.action,
          managerOutpoint: ev.before?.manager?.outpoint ?? null,
          managerScriptHash: ev.before?.manager?.scriptHash ?? null,
          targets: (ev.before?.restoredFrozen ?? []).map(t => ({outpoint: t.outpoint, scriptHash: t.scriptHash})),
          accessor: st.action === 'REFUND_SELF' ? {blockHash: 'ee'.repeat(32), sequenceCommitment: 'ff'.repeat(32)} : null,
        },
      },
    });
    prev = d;
    prevId = id;
  }

  return {indexer, cid: g.cid, txids, blocks: {blockA, blockB, blockC, blockD}};
}

async function startTestServer(service, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    void service.handleRequest(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  return {
    baseUrl: `http://${host}:${addr.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

test('configFromArgs enforces loopback defaults (127.0.0.1:18212) and rejects non-loopback or invalid args', () => {
  const cfg = configFromArgs([]);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 18212);
  assert.equal(cfg.endpoint, 'ws://127.0.0.1:18210');
  assert.equal(cfg.network, TN10.networkId);
  assert.equal(cfg.profileId, TN10_PROFILE_ID);

  assert.throws(() => configFromArgs(['--host=0.0.0.0']), /LOOPBACK_HTTP_REQUIRED/);
  assert.throws(() => configFromArgs(['--rpc=ws://192.168.1.10:18210']), /LOOPBACK_RPC_REQUIRED/);
  assert.throws(() => configFromArgs(['--rpc=wss://127.0.0.1:18210']), /LOOPBACK_RPC_REQUIRED/);
  assert.throws(() => configFromArgs(['--network=mainnet']), /UNSUPPORTED_NETWORK/);
  assert.throws(() => configFromArgs(['--profile=' + '00'.repeat(32)]), /UNSUPPORTED_PROFILE/);
  assert.throws(() => configFromArgs(['--unknown=1']), /INVALID_ARGUMENT/);
});

test('RollingStore enforces single-writer writer.lock, atomic cursor, pagination, and 409 CURSOR_STALE', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-sidecar-store-'));
  t.after(() => rm(dir, {recursive: true, force: true}));

  const storeA = new RollingStore({dataDir: dir, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id});
  const storeB = new RollingStore({dataDir: dir, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id});

  await storeA.acquireLock();
  await assert.rejects(() => storeB.acquireLock(), e => e.code === 'WRITER_LOCKED' && e.status === 503);
  await storeA.releaseLock();

  await storeB.acquireLock();
  await storeB.releaseLock();

  await storeA.acquireLock();
  t.after(() => storeA.releaseLock());
  await storeA.init(TN10.genesis);

  const cursor = await storeA.getCursor();
  assert.equal(cursor.lastBlockHash, TN10.genesis);
  assert.equal(cursor.revision, '0');
  const cursorStat = await stat(join(dir, 'meta', 'cursor.json'));
  assert.ok(cursorStat.isFile());

  // Seed 3 rounds to test pagination and stale cursor
  await seedSyntheticLifecycle(storeA, {dirPrefix: '11'});
  const g2 = buildGenesis(profile, OWNER, {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n}, {funds: [fund(2, 10n * PRICE, OWNER)], fee: FEE, budgets: [10]});
  const g3 = buildGenesis(profile, OWNER, {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n}, {funds: [fund(3, 10n * PRICE, OWNER)], fee: FEE, budgets: [10]});
  for (const [idx, g] of [g2, g3].entries()) {
    const id = referenceTxId(g.transaction);
    const blk = `${31 + idx}`.repeat(32);
    const indexer = new RollingIndexer({
      archive: storeA.archive,
      profile,
      networkGenesis: TN10.genesis,
      nodeAdapter: {
        async authenticateAccepted() {
          return makeAcceptEntry(g, blk, BigInt(2100 + idx));
        },
      },
    });
    const view = await indexer.ingest(id, {acceptingBlockHash: blk}, '0');
    await storeA.recordAccept({
      view,
      summary: {module: 'sales', tickets: 0, shards: 0, localRecords: 0},
      txMeta: {txid: id, cid: view.cid, action: 'GENESIS', revision: view.revision, acceptingBlock: blk, acceptingDaa: String(2100 + idx), instance: view.acceptance.instance, feeSompi: FEE.toString(), quantity: 0},
      blockEntry: {cid: view.cid, instance: view.acceptance.instance, txid: id, action: 'GENESIS', acceptingBlock: blk, acceptingDaa: String(2100 + idx)},
      exportDelta: {settings: {ticketPrice: PRICE.toString(), ticketCap: 10, minTickets: 3, closeEligibleDaa: '1000'}, buysDelta: 0, boughtDelta: 0, feeSompi: FEE.toString(), receipt: {txid: id, action: 'GENESIS', accepted: true, candidate: false, finalized: true, acceptingBlock: blk, acceptingDaa: String(2100 + idx), feeSompi: FEE.toString()}, proof: {txid: id, acceptingBlock: blk, action: 'GENESIS', managerOutpoint: null, managerScriptHash: null, targets: [], accessor: null}},
    });
  }

  const page1 = await storeA.listRounds({limit: 2});
  assert.equal(page1.total, 3);
  assert.equal(page1.rounds.length, 2);
  assert.ok(page1.next);

  const page2 = await storeA.listRounds({cursor: page1.next, limit: 2});
  assert.equal(page2.rounds.length, 1);
  assert.equal(page2.next, null);

  // Mutate index revision -> old cursor must reject with 409 CURSOR_STALE
  await storeA.recordAccept({
    view: await storeA.getRound(page1.rounds[0].cid),
    summary: {module: 'sales', tickets: 0, shards: 0, localRecords: 0},
    txMeta: {txid: 'aa'.repeat(32), cid: page1.rounds[0].cid, action: 'GENESIS', revision: '1', acceptingBlock: 'ab'.repeat(32), acceptingDaa: '2200', instance: 'cd'.repeat(32), feeSompi: '0', quantity: 0},
    blockEntry: {cid: page1.rounds[0].cid, instance: 'cd'.repeat(32), txid: 'aa'.repeat(32), action: 'GENESIS', acceptingBlock: 'ab'.repeat(32), acceptingDaa: '2200'},
    exportDelta: {settings: {ticketPrice: PRICE.toString(), ticketCap: 10, minTickets: 3, closeEligibleDaa: '1000'}, buysDelta: 0, boughtDelta: 0, feeSompi: '0', receipt: {txid: 'aa'.repeat(32), action: 'GENESIS'}, proof: {txid: 'aa'.repeat(32), acceptingBlock: 'ab'.repeat(32), action: 'GENESIS', managerOutpoint: null, managerScriptHash: null, targets: [], accessor: null}},
  });

  await assert.rejects(() => storeA.listRounds({cursor: page1.next, limit: 2}), e => e.code === 'CURSOR_STALE' && e.status === 409);
});

test('GET /rounds/:cid/export round-trips into roundFromText with complete head and terminalProof', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-sidecar-export-'));
  t.after(() => rm(dir, {recursive: true, force: true}));

  const store = new RollingStore({dataDir: dir, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id});
  await store.acquireLock();
  t.after(() => store.releaseLock());
  await store.init(TN10.genesis);

  const {cid, txids, blocks} = await seedSyntheticLifecycle(store, {dirPrefix: '12'});
  const config = {...DEFAULTS, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id};
  const scannerStub = {indexer: null, status: () => ({running: true, stale: false, lastPollAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastError: null, virtualDaa: '2200'})};
  const service = new RollingIndexerService({config, profile, store, scanner: scannerStub});

  const srv = await startTestServer(service);
  t.after(() => srv.close());

  const prefix = `/tn10/rolling/v1/${profile.id}`;
  const res = await fetch(`${srv.baseUrl}${prefix}/rounds/${cid}/export`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.schema, SCHEMA);
  assert.equal(body.cid, cid);
  assert.equal(body.status, 'UNVALIDATED');
  assert.equal(body.head.txid, txids.refund_self);
  assert.equal(body.head.acceptingBlock, blocks.blockD);
  assert.equal(body.head.acceptingDaa, '2030');

  assert.ok(body.terminalProof);
  assert.equal(body.terminalProof.txid, txids.refund_self);
  assert.equal(body.terminalProof.acceptingBlock, blocks.blockD);
  assert.equal(body.terminalProof.action, 'REFUND_SELF');
  assert.ok(body.terminalProof.managerOutpoint);
  assert.match(body.terminalProof.managerRedeemHex, /^[0-9a-f]+$/);
  assert.ok(Array.isArray(body.terminalProof.targets));
  assert.deepEqual(body.terminalProof.accessor, {blockHash: 'ee'.repeat(32), sequenceCommitment: 'ff'.repeat(32)});

  // Lossless import into scripts/round/round.mjs
  const imported = roundFromText(body.roundText, profile);
  assert.equal(imported.cid, cid);
  assert.equal(imported.terminal, 'REFUNDED');
  assert.equal(imported.step, 4);
  assert.equal(imported.buys, 1);
  assert.equal(imported.bought, 1);
  assert.equal(imported.fees, 4n * FEE);
  assert.equal(imported.receipts.length, 4);

  // /v1 alias & decimal string checks on /rounds
  const roundsRes = await fetch(`${srv.baseUrl}/v1/rounds`);
  assert.equal(roundsRes.status, 200);
  const roundsBody = await roundsRes.json();
  assert.equal(roundsBody.rounds.length, 1);
  assert.equal(roundsBody.next, null);
  assert.equal(roundsBody.nextCursor, null);
  assert.equal(typeof roundsBody.rounds[0].fees, 'string');
  assert.match(roundsBody.rounds[0].fees, /^[0-9]+$/);

  // /rounds/:cid/history pagination exposes both next and nextCursor
  const hist1Res = await fetch(`${srv.baseUrl}/v1/rounds/${cid}/history?limit=2`);
  assert.equal(hist1Res.status, 200);
  const hist1 = await hist1Res.json();
  assert.equal(hist1.events.length, 2);
  assert.ok(hist1.next);
  assert.equal(hist1.nextCursor, hist1.next);

  const hist2Res = await fetch(`${srv.baseUrl}/v1/rounds/${cid}/history?limit=2&cursor=${encodeURIComponent(hist1.nextCursor)}`);
  assert.equal(hist2Res.status, 200);
  const hist2 = await hist2Res.json();
  assert.equal(hist2.events.length, 2);
  assert.equal(hist2.next, null);
  assert.equal(hist2.nextCursor, null);
});

test('RollingScanner.revertBlocks reverts descendants first, cleans txid->cid mappings, and service returns 503 on missing data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-sidecar-reorg-'));
  t.after(() => rm(dir, {recursive: true, force: true}));

  const store = new RollingStore({dataDir: dir, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id});
  await store.acquireLock();
  t.after(() => store.releaseLock());
  await store.init(TN10.genesis);

  const {cid, txids, blocks} = await seedSyntheticLifecycle(store, {dirPrefix: '14'});

  const config = {...DEFAULTS, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id};
  const removedSet = new Set([blocks.blockC, blocks.blockD]);
  const mockNode = {
    url: 'ws://127.0.0.1:18210',
    ws: {readyState: 1},
    on: () => () => {},
    async call(method, params) {
      if (method === 'getBlock') {
        return {
          block: {
            header: {hash: params.hash, daaScore: '2020'},
            verboseData: {isChainBlock: !removedSet.has(params.hash)},
          },
        };
      }
      if (method === 'getServerInfo') {
        return {networkName: TN10.networkId, virtualDaaScore: '2200', isSynced: true};
      }
      throw new Error(`UNEXPECTED_RPC_${method}`);
    },
  };
  const link = {
    net: TN10,
    nodes: [mockNode],
    connect: async () => [mockNode],
    currentDaa: async () => 2200n,
    on: () => () => {},
    call: mockNode.call,
  };

  const scanner = new RollingScanner({
    config,
    profile,
    store,
    connectFn: async () => ({link, rpc: null}),
  });
  t.after(() => scanner.stop());

  await scanner.revertBlocks([blocks.blockC, blocks.blockD]);

  const after = await store.getRound(cid);
  assert.equal(after.terminal, null);
  assert.equal(after.acceptance.txid, txids.buy);
  assert.equal(after.revision, '6');
  assert.equal(await store.getTxidMapping(txids.refund_self), null);
  assert.equal(await store.getTxidMapping(txids.close), null);
  assert.equal((await store.getTxidMapping(txids.buy)).cid, cid);
  assert.equal((await store.getTxidMapping(txids.genesis)).cid, cid);

  // Missing preimage / uninitialized cursor -> 500 / 503 error JSON instead of fake empty 200
  const uninitDir = await mkdtemp(join(tmpdir(), 'rolling-sidecar-uninit-'));
  t.after(() => rm(uninitDir, {recursive: true, force: true}));
  const uninitStore = new RollingStore({dataDir: uninitDir, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id});
  const service = new RollingIndexerService({
    config,
    profile,
    store: uninitStore,
    scanner: {indexer: null, status: () => ({running: false, stale: true, lastPollAt: null, lastSuccessAt: null, lastError: 'NODE_DOWN', virtualDaa: '0'})},
  });
  const srv = await startTestServer(service);
  t.after(() => srv.close());

  const infoRes = await fetch(`${srv.baseUrl}/v1/info`);
  assert.equal(infoRes.status, 503);
  const infoErr = await infoRes.json();
  assert.equal(infoErr.error, 'CURSOR_NOT_INITIALIZED');
});

test('HTTP service enforces read-only 405, URL limit, rate limit 429, and concurrency 503', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-sidecar-sec-'));
  t.after(() => rm(dir, {recursive: true, force: true}));

  const store = new RollingStore({dataDir: dir, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id});
  await store.acquireLock();
  t.after(() => store.releaseLock());
  await store.init(TN10.genesis);

  const config = {
    ...DEFAULTS,
    network: TN10.networkId,
    genesisHash: TN10.genesis,
    profileId: profile.id,
    maxUrlBytes: 128,
    maxRequestsPerMinute: 4,
    maxConcurrentRequests: 1,
  };
  const scannerStub = {indexer: null, status: () => ({running: true, stale: false, lastPollAt: null, lastSuccessAt: null, lastError: null, virtualDaa: '0'})};
  const service = new RollingIndexerService({config, profile, store, scanner: scannerStub});

  const srv = await startTestServer(service);
  t.after(() => srv.close());

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await fetch(`${srv.baseUrl}/v1/info`, {method});
    assert.equal(r.status, 405);
    assert.equal((await r.json()).error, 'METHOD_NOT_ALLOWED');
  }

  const longRes = await fetch(`${srv.baseUrl}/v1/info?pad=${'a'.repeat(200)}`);
  assert.equal(longRes.status, 400);
  assert.equal((await longRes.json()).error, 'REQUEST_PATH');

  // 4th request hits rate limit (maxRequestsPerMinute = 4, and we already did 3 write + 1 long = 4!)
  const rateRes = await fetch(`${srv.baseUrl}/v1/info`);
  assert.equal(rateRes.status, 429);
  assert.equal((await rateRes.json()).error, 'RATE_LIMITED');

  // Concurrency limit check via direct handleRequest mock
  const slowStore = {
    getCursor: () => new Promise(resolve => setTimeout(() => resolve({lastBlockHash: TN10.genesis, lastBlockDaa: '0', lastBlockBlueScore: '0', virtualDaa: '0'}), 50)),
    listRounds: async () => ({revision: '0', total: 0, rounds: [], next: null}),
  };
  const concService = new RollingIndexerService({
    config: {...config, maxRequestsPerMinute: 100, maxConcurrentRequests: 1},
    profile,
    store: slowStore,
    scanner: scannerStub,
  });
  const concSrv = await startTestServer(concService);
  t.after(() => concSrv.close());

  const [r1, r2] = await Promise.all([
    fetch(`${concSrv.baseUrl}/v1/info`),
    fetch(`${concSrv.baseUrl}/v1/info`),
  ]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 503]);
});

test('RollingScanner.status() reports stale initially and sidecar modules contain no signing/broadcasting primitives', async () => {
  const scanner = new RollingScanner({
    config: {...DEFAULTS, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id},
    profile,
    store: {},
  });
  assert.equal(scanner.status().stale, true);
  assert.equal(scanner.status().running, false);

  for (const file of ['config.mjs', 'store.mjs', 'scanner.mjs', 'service.mjs', 'server.mjs']) {
    const src = await readFile(new URL(`../../scripts/indexer/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /schnorrSign|submitTransaction|privateKey/i, file);
  }
});

test('exportRoundPayload uses committedView so archive writes ahead of recordAccept never cause INDEXER_HEAD_BINDING', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-sidecar-race-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = new RollingStore({dataDir: dir, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id});
  await store.init(TN10.genesis);
  const {cid} = await seedSyntheticLifecycle(store, {dirPrefix: '21'});
  const before = await store.exportRoundPayload(cid, profile);
  const committedTxid = before.roundObj.receipts.at(-1).txid;
  assert.equal(before.view.acceptance.txid, committedTxid);

  // Simulate archive advancing one revision ahead of recordAccept (mid-ingest before recordAccept commits exp).
  const curArchive = await store.archive.getRound(TN10.genesis, profile.id, cid);
  await store.archive.update(TN10.genesis, profile.id, cid, curArchive.revision, cur => ({
    ...cur,
    acceptance: {...cur.acceptance, txid: 'ff'.repeat(32)},
    event: {type: 'ACCEPT', instance: 'ee'.repeat(32)},
  }));

  const during = await store.exportRoundPayload(cid, profile);
  assert.equal(during.view.acceptance.txid, committedTxid);
  assert.equal(during.roundObj.receipts.at(-1).txid, committedTxid);
  assert.equal(during.roundObj.accepting, before.roundObj.accepting);
});

test('RollingScanner falls back to V1 getVirtualChainFromBlock + getBlock when V2 exceeds WebSocket payload cap (NODE_CLOSED)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-sidecar-v1fallback-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = new RollingStore({dataDir: dir, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id});
  await store.init(TN10.genesis);
  const block1 = 'aa'.repeat(32);
  let calls = 0;
  const link = {
    net: TN10,
    nodes: [],
    currentDaa: async () => 5000n,
    on: () => () => {},
    async call(method, params) {
      if (method === 'getBlock' && params.hash === TN10.genesis) return {block: {header: {hash: TN10.genesis, daaScore: '100', blueScore: '1'}, verboseData: {isChainBlock: true}}};
      if (method === 'getBlock' && params.hash === block1) return {block: {header: {hash: block1, daaScore: '200', blueScore: '2'}, verboseData: {isChainBlock: true}}};
      if (method === 'getVirtualChainFromBlockV2') {calls++; throw Object.assign(new Error('NODE_CLOSED'), {code: 'NODE_CLOSED'});}
      if (method === 'getVirtualChainFromBlock') return {removedChainBlockHashes: [], acceptedTransactionIds: [{acceptingBlockHash: block1, acceptedTransactionIds: ['00'.repeat(32)]}]};
      throw new Error(`UNEXPECTED_${method}`);
    },
  };
  const scanner = new RollingScanner({
    config: {...DEFAULTS, network: TN10.networkId, genesisHash: TN10.genesis, profileId: profile.id},
    profile,
    store,
    connectFn: async () => ({link, rpc: null}),
  });
  await scanner.pollOnce();
  assert.ok(calls >= 1);
  const cursor = await store.getCursor();
  assert.equal(cursor.lastBlockHash, block1);
  assert.equal(cursor.lastBlockDaa, '200');
});
