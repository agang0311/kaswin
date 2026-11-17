/** Offline Playwright browser test for candidate rolling-tn10.html.
 * Injects mock window.kasware / window.kastle, mock HTTP Service & Indexer, and mock Node WebSocket.
 * Uses only an unfunded synthetic test key; never touches real wallets or broadcasts to any real chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

import {openMemoryWallet} from '../../web/rolling-tn10/wallet.mjs';
import {encodeTagged} from '../../web/rolling-tn10/codec.mjs';
import {TN10_NETWORK_ID, TN10_GENESIS, TN10_PROFILE_ID, requestDigest, draftTxid, parseWire} from '../../web/rolling-tn10/protocol.mjs';
import {fixture, fund, OWNER, PRICE, FEE} from '../../experiments/rolling/fixtures.mjs';
import {buildGenesis} from '../../experiments/rolling/transactions.mjs';
import {redeem} from '../../experiments/rolling/profile.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {schnorrSign, schnorrVerify} from '../../scripts/wallet/schnorr.mjs';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {unhex, hex} from '../../scripts/rolling/core.mjs';
import {parseSpk, txToRpc} from '../../scripts/chain/nodes.mjs';
import {jsonText} from '../../scripts/chain/json.mjs';
import {loadDeploymentProfile} from '../../experiments/rolling/deployment-profile.mjs';

const CANDIDATE_HTML = resolve('tests/output/rolling-integration/candidate/rolling-tn10.html');
const TEST_SECRET = createHash('sha256').update('rolling-tn10-playwright-unfunded-test-key').digest('hex');

function makeIndexedRoundFixture(profile) {
  const f1 = fund(1, 10n * PRICE, OWNER);
  const g = buildGenesis(
    profile,
    OWNER,
    {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n},
    {funds: [f1], fee: FEE, budgets: [10]},
  );
  const gid = referenceTxId(g.transaction);
  const blockA = 'ab'.repeat(32);
  const roundObj = {
    v: 1,
    network: TN10_NETWORK_ID,
    profileId: TN10_PROFILE_ID,
    cid: g.cid,
    origin: g.origin,
    settings: {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n},
    manager: {
      outpoint: {transactionId: gid, index: 0},
      origin: g.origin,
      cid: g.cid,
      value: g.transaction.outputs[0].value,
      spk: g.transaction.outputs[0].scriptPublicKey,
      redeemScript: redeem(g.transition.next, profile),
      utxoDaa: 2000n,
      currentDaa: 2000n,
      daa: 2000n,
      covenantId: g.cid,
    },
    frozen: [],
    accepting: blockA,
    step: 1,
    buys: 0,
    bought: 0,
    fees: FEE,
    terminal: null,
    receipts: [{txid: gid, action: 'GENESIS', accepted: true, candidate: false, finalized: true, acceptingBlock: blockA, acceptingDaa: '2000', feeSompi: FEE.toString()}],
    pending: [],
    halted: null,
    source: 'imported',
    intent: null,
  };
  return {
    cid: g.cid,
    txid: gid,
    blockHash: blockA,
    daa: 2000n,
    tx: g.transaction,
    fund: f1,
    roundText: encodeTagged(roundObj),
  };
}

test('Candidate HTML: extension wallets (KasWare/Kastle), invalidation, signing, and Indexer discovery/sync', async t => {
  const html = await readFile(CANDIDATE_HTML, 'utf8');
  const profile = await loadDeploymentProfile();
  const mem = openMemoryWallet(TEST_SECRET);
  t.after(() => mem.close());
  const indexed = makeIndexedRoundFixture(profile);
  const submittedTxs = [];

  // Local HTTP server serving candidate HTML + mock Service + mock Indexer
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/rolling-tn10.html') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end(html);
      return;
    }
    const readJsonBody = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };

    // Mock budget/engine service (/svc/api/*)
    if (url.pathname === '/svc/api/info') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        ok: true,
        schema: 1,
        network: TN10_NETWORK_ID,
        profileId: TN10_PROFILE_ID,
        readOnly: true,
        holdsKeys: false,
        broadcasts: false,
        engine: {configured: true, binarySha256: 'e773577d46c755c291726ebe80d3b1f94615a20f604d8f681636559f3ba2d5b8'},
        limits: {},
      }));
      return;
    }
    if (url.pathname === '/svc/api/measure' || url.pathname === '/svc/api/verify') {
      const wire = await readJsonBody();
      const parsed = parseWire(wire);
      const auth = new Set(parsed.draft.authorizedInputIndices);
      const expected = wire.mode === 'measure'
        ? parsed.draft.transaction.inputs.flatMap((_, i) => auth.has(i) ? [] : [i])
        : parsed.draft.transaction.inputs.map((_, i) => i);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        ok: true,
        schema: 1,
        mode: wire.mode,
        network: TN10_NETWORK_ID,
        profileId: TN10_PROFILE_ID,
        requestDigest: requestDigest(wire),
        txid: draftTxid(parsed.draft),
        advisory: true,
        offlineScriptCheck: true,
        engine: {configured: true, binarySha256: 'e773577d46c755c291726ebe80d3b1f94615a20f604d8f681636559f3ba2d5b8'},
        inputs: expected.map(i => ({input: i, ok: true, minBudget: 0, usedScriptUnits: 0, limitedOk: true})),
      }));
      return;
    }

    // Mock Indexer (/idx/v1/*)
    if (url.pathname === '/idx/v1/info') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        schema: 1,
        network: TN10_NETWORK_ID,
        genesisHash: TN10_GENESIS,
        profileId: TN10_PROFILE_ID,
        status: 'UNVALIDATED',
        readOnly: true,
        stale: false,
        roundsCount: 1,
      }));
      return;
    }
    if (url.pathname === '/idx/v1/rounds') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        schema: 1,
        network: TN10_NETWORK_ID,
        genesisHash: TN10_GENESIS,
        profileId: TN10_PROFILE_ID,
        revision: '1',
        total: 1,
        rounds: [{
          cid: indexed.cid,
          module: 'sales',
          terminal: null,
          tickets: 0,
          shards: 0,
          frozenCount: 0,
          acceptingDaa: indexed.daa.toString(),
          fees: FEE.toString(),
        }],
        next: null,
        nextCursor: null,
      }));
      return;
    }
    if (url.pathname === `/idx/v1/rounds/${indexed.cid}/export`) {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        schema: 1,
        network: TN10_NETWORK_ID,
        genesisHash: TN10_GENESIS,
        profileId: TN10_PROFILE_ID,
        cid: indexed.cid,
        status: 'UNVALIDATED',
        revision: '1',
        head: {txid: indexed.txid, acceptingBlock: indexed.blockHash, acceptingDaa: indexed.daa.toString()},
        roundText: indexed.roundText,
        terminalProof: null,
      }));
      return;
    }

    res.writeHead(404, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: 'NOT_FOUND'}));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  t.after(() => new Promise(r => server.close(() => r())));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();

  // Sign helper exposed from Node test process for mock window.kasware / window.kastle
  const secretBytes = unhex(TEST_SECRET, 32);
  await page.exposeFunction('__mockExtSign', async (txJsonString, indices) => {
    const parsed = JSON.parse(txJsonString);
    const tx = {
      version: parsed.version,
      inputs: parsed.inputs.map(i => ({
        previousOutpoint: {transactionId: i.transactionId, index: i.index},
        signatureScript: i.signatureScript ?? '',
        sequence: BigInt(i.sequence),
        computeBudget: i.computeBudget ?? 0,
      })),
      outputs: parsed.outputs.map(o => ({
        value: BigInt(o.value),
        scriptPublicKey: parseSpk(o.scriptPublicKey),
        covenant: o.covenant ? {authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId} : null,
      })),
      lockTime: BigInt(parsed.lockTime),
      subnetworkId: parsed.subnetworkId,
      gas: BigInt(parsed.gas),
      payload: parsed.payload ?? '',
      storageMass: BigInt(parsed.storageMass ?? 0),
    };
    const utxos = parsed.inputs.map(i => ({
      value: BigInt(i.utxo.amount),
      spk: parseSpk(i.utxo.scriptPublicKey),
    }));
    for (const idx of indices) {
      const hash = schnorrSighash(tx, utxos, idx);
      const sig = schnorrSign(secretBytes, hash);
      assert.equal(await schnorrVerify(unhex(mem.key), hash, sig), true);
      parsed.inputs[idx].signatureScript = '41' + hex(sig) + '01';
    }
    return JSON.stringify(parsed);
  });

  // Intercept WebSocket node RPC completely offline
  await page.routeWebSocket('**/mock-node', ws => {
    ws.onMessage(raw => {
      const msg = JSON.parse(raw);
      const {id, method, params} = msg;
      const sendResult = payload => ws.send(jsonText({id, method, params: payload}));

      if (method === 'getServerInfo') {
        return sendResult({networkId: TN10_NETWORK_ID, isSynced: true, hasUtxoIndex: true, virtualDaaScore: '5000', serverVersion: '2.1.0'});
      }
      if (method === 'getBlockDagInfo') {
        return sendResult({network: TN10_NETWORK_ID, blockCount: '100', headerCount: '100', tipHashes: [indexed.blockHash], virtualDaaScore: '5000', pruningPointHash: TN10_GENESIS});
      }
      if (method === 'getSinkBlueScore') {
        return sendResult({blueScore: '100'});
      }
      if (method === 'getFeeEstimate') {
        return sendResult({estimate: {normalBuckets: [{feerate: 1, estimatedSeconds: 1}]}});
      }
      if (method === 'getUtxosByAddresses') {
        const addrs = params?.addresses ?? [];
        if (addrs.includes(mem.address)) {
          return sendResult({
            entries: [{
              address: mem.address,
              outpoint: {transactionId: 'aa'.repeat(32), index: 0},
              utxoEntry: {
                amount: String(10n * PRICE),
                scriptPublicKey: `000020${mem.key}ac`,
                blockDaaScore: '1000',
                isCoinbase: false,
                covenantId: null,
              },
            }],
          });
        }
        return sendResult({
          entries: [{
            outpoint: {transactionId: indexed.txid, index: 0},
            utxoEntry: {
              amount: indexed.tx.outputs[0].value.toString(),
              scriptPublicKey: `0000${indexed.tx.outputs[0].scriptPublicKey.script}`,
              blockDaaScore: indexed.daa.toString(),
              isCoinbase: false,
              covenantId: indexed.cid,
            },
          }],
        });
      }
      if (method === 'getBlock') {
        return sendResult({
          block: {
            header: {hash: params.hash, daaScore: indexed.daa.toString(), blueScore: '90', acceptedIdMerkleRoot: 'ee'.repeat(32)},
            verboseData: {isChainBlock: true, selectedParentHash: '01'.repeat(32), mergeSetBluesHashes: []},
            transactions: [],
          },
        });
      }
      if (method === 'getVirtualChainFromBlockV2') {
        const rpcTx = txToRpc(indexed.tx);
        rpcTx.inputs[0].verboseData = {
          utxoEntry: {
            amount: indexed.fund.value.toString(),
            scriptPublicKey: `0000${indexed.fund.spk.script}`,
            blockDaaScore: '0',
            isCoinbase: false,
            covenantId: null,
          },
        };
        rpcTx.verboseData = {transactionId: indexed.txid};
        return sendResult({
          removedChainBlockHashes: [],
          addedChainBlockHashes: [indexed.blockHash],
          chainBlockAcceptedTransactions: [{
            chainBlockHeader: {hash: indexed.blockHash, daaScore: indexed.daa.toString(), blueScore: '90'},
            acceptedTransactions: [rpcTx],
          }],
        });
      }
      if (method === 'submitTransaction') {
        submittedTxs.push(params?.transaction ?? params);
        return sendResult({transactionId: '12'.repeat(32)});
      }
      return sendResult({});
    });
  });

  // Inject mock window.kasware and window.kastle before page script runs
  await page.addInitScript(({address, pubkey}) => {
    const makeEmitter = () => {
      const map = new Map();
      return {
        on(ev, fn) { if (!map.has(ev)) map.set(ev, new Set()); map.get(ev).add(fn); },
        removeListener(ev, fn) { map.get(ev)?.delete(fn); },
        emit(ev, data) { for (const fn of map.get(ev) ?? []) fn(data); },
      };
    };
    const kwBus = makeEmitter();
    const klBus = makeEmitter();
    window.__emitKasware = (ev, data) => kwBus.emit(ev, data);
    window.__emitKastle = (ev, data) => klBus.emit(ev, data);

    window.kasware = {
      async requestAccounts() { return [address]; },
      async getAccounts() { return [address]; },
      async getNetwork() { return 'kaspa_testnet_10'; },
      async getPublicKey() { return pubkey; },
      on: kwBus.on,
      removeListener: kwBus.removeListener,
      async signPskt({txJsonString, options}) {
        const indices = (options?.signInputs ?? []).map(x => x.index);
        return window.__mockExtSign(txJsonString, indices);
      },
    };
    window.kastle = {
      async connect() { return true; },
      async getAccount() { return {address, publicKey: pubkey}; },
      async getNetwork() { return 'testnet-10'; },
      on: klBus.on,
      removeListener: klBus.removeListener,
      async signTx(network, txJsonString, scripts) {
        if (network !== 'testnet-10') throw new Error('BAD_NET');
        const indices = (scripts ?? []).map(x => x.inputIndex);
        return window.__mockExtSign(txJsonString, indices);
      },
    };
  }, {address: mem.address, pubkey: mem.key});

  await page.goto(`${origin}/rolling-tn10.html`);
  await page.waitForSelector('#walletBtn');

  // 1. Open wallet modal -> check all 3 tabs and extension options
  await page.click('#walletBtn');
  await page.waitForSelector('[data-wtab="extension"]');
  const optText = await page.locator('#wProvider').innerText();
  assert.doesNotMatch(optText, /未检测到/);

  await page.click('[data-wtab="key"]');
  await page.waitForSelector('#wKey');
  await page.click('[data-wtab="addr"]');
  await page.waitForSelector('#wAddr');
  await page.click('[data-wtab="extension"]');
  await page.waitForSelector('#wProvider');

  // Connect KasWare
  await page.selectOption('#wProvider', 'kasware');
  await page.click('[data-act="connectWallet"]');
  await page.waitForFunction(() => document.querySelector('#walletBtn')?.textContent?.includes('kaspatest:'));

  // 2. Emit accountsChanged -> wallet auto-invalidates
  await page.evaluate(() => window.__emitKasware('accountsChanged', []));
  await page.waitForFunction(() => !document.querySelector('#walletBtn')?.textContent?.includes('kaspatest:'));

  // Reconnect with Kastle
  await page.click('#walletBtn');
  await page.selectOption('#wProvider', 'kastle');
  await page.click('[data-act="connectWallet"]');
  await page.waitForFunction(() => document.querySelector('#walletBtn')?.textContent?.includes('kaspatest:'));

  // 3. Configure mock Node, Service, and Indexer in Settings
  await page.click('#settingsBtn');
  await page.waitForSelector('#sNodes');
  await page.fill('#sNodes', `ws://127.0.0.1:${port}/mock-node`);
  await page.fill('#sSvc', `${origin}/svc`);
  await page.fill('#sIndexer', `${origin}/idx/v1`);
  await page.click('[data-act="applyConn"]');
  await page.waitForFunction(() => document.querySelector('#mToasts')?.textContent?.includes('连接成功，设置已保存'), null, {timeout: 8000});
  await page.click('#mClose');
  await page.waitForFunction(() => document.querySelector('#modal')?.open === false, null, {timeout: 5000});

  // 4. Create GENESIS round and sign via extension wallet
  await page.click('[data-go="create"]');
  await page.waitForSelector('[data-act="create"]');
  await page.click('[data-act="create"]');
  try {
    await page.waitForSelector('[data-act="send"]', {timeout: 6000});
  } catch (e) {
    const diag = await page.evaluate(() => ({
      toasts: document.querySelector('#toasts')?.textContent,
      mToasts: document.querySelector('#mToasts')?.textContent,
      mTitle: document.querySelector('#mTitle')?.textContent,
    }));
    throw new Error(`Create did not open confirm modal: ${JSON.stringify(diag)}`);
  }
  const modalBody = await page.locator('#mBody').innerText();
  assert.match(modalBody, /在扩展钱包中确认签名/);

  await page.click('[data-act="send"]');
  try {
    await page.waitForFunction(() => location.hash.includes('#/round/'), null, {timeout: 6000});
  } catch (e) {
    const diag = await page.evaluate(() => ({
      hash: location.hash,
      submitted: 0,
      mToasts: document.querySelector('#mToasts')?.textContent,
      toasts: document.querySelector('#toasts')?.textContent,
      modalOpen: document.querySelector('#modal')?.open,
    }));
    diag.submitted = submittedTxs.length;
    throw new Error(`Send did not navigate to round: ${JSON.stringify(diag)}`);
  }
  assert.equal(submittedTxs.length, 1);

  // 5. Explore -> Indexer discovery -> syncIndexedRound
  await page.click('[data-go="explore"]');
  const discoverBtn = page.locator(`[data-indexed="${indexed.cid}"]`);
  try {
    await discoverBtn.waitFor({state: 'visible', timeout: 6000});
  } catch (e) {
    const diag = await page.evaluate(() => ({
      hash: location.hash,
      hasRefresh: !!document.querySelector('[data-act="refreshIndex"]'),
      toasts: document.querySelector('#toasts')?.textContent,
      viewText: document.querySelector('#view')?.textContent?.slice(0, 300),
    }));
    throw new Error(`Discover button not visible: ${JSON.stringify(diag)}`);
  }
  await discoverBtn.click();
  try {
    await page.waitForFunction(cid => location.hash.includes(cid), indexed.cid, {timeout: 6000});
  } catch (e) {
    const diag = await page.evaluate(() => ({
      hash: location.hash,
      toasts: document.querySelector('#toasts')?.textContent,
      mToasts: document.querySelector('#mToasts')?.textContent,
    }));
    throw new Error(`Indexed round did not open: ${JSON.stringify(diag)}`);
  }
  const roundText = await page.locator('#view').innerText();
  assert.match(roundText, /售票中|进行中|SALES/);
});
