/** Offline Playwright browser regression for:
 *  1) Dual-network switching (Testnet 10 <-> Kaspa Mainnet, TKAS/KAS unit adaptation, key-tab gating on mainnet)
 *  2) Continuous batch settlement: batchPayout (PAY_OLD -> PAY_SELF -> PAID) and batchRefund (REFUND_OLD -> REFUND_SELF -> REFUNDED)
 *  3) Pruned-node REST fallback recovery (reconstructs GENESIS + BUY redeemScript preimage when Indexer is absent and node pruned blocks)
 * Uses only synthetic test data and offline FakeNode/REST mocks; never touches real wallets or chains.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {buildKaswin} from '../../build/build.mjs';

import {FakeNode} from '../helpers/fake-node.mjs';
import {fixture, profile, PRICE, FEE, OWNER} from '../contracts/fixtures.mjs';
import {buildGenesis} from '../contracts/transactions.mjs';
import {emptyRound, roundToText} from '../../scripts/round/round.mjs';
import {openMemoryWallet} from '../../scripts/wallet/wallet.mjs';
import {createController} from '../../scripts/round/controller.mjs';
import {MemoryStore, RoundStore} from '../../scripts/store/round-store.mjs';
import {TN10_GENESIS, TN10_NETWORK_ID, TN10_PROFILE_ID} from '../../scripts/contract/protocol.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {MAINNET} from '../../scripts/chain/mainnet.mjs';
import {jsonText} from '../../scripts/chain/json.mjs';
import {txToRpc} from '../../scripts/chain/nodes.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {hex} from '../../scripts/core.mjs';
import {spkToAddress} from '../../scripts/wallet/address.mjs';

let builtTn10HtmlPromise = null;
async function loadCurrentTn10Html() {
  if (!builtTn10HtmlPromise) {
    builtTn10HtmlPromise = (async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kaswin-batch-browser-'));
      try {
        return (await buildKaswin({mode: 'tn10', outDir: tmpDir})).html;
      } finally {
        await rm(tmpDir, {recursive: true, force: true});
      }
    })();
  }
  return builtTn10HtmlPromise;
}
const KAS = 100000000n;
const EXEC_KEY = createHash('sha256').update('kaswin-batch-browser-exec').digest('hex');
const EXEC_WALLET = openMemoryWallet(EXEC_KEY);

function makeSeededRound(f) {
  const cid = f.manager.cid;
  const rec = {
    ...emptyRound({
      cid,
      origin: f.manager.origin,
      settings: {
        ticketPrice: f.s.ticketPrice,
        ticketCap: f.s.ticketCap,
        minTickets: f.s.minTickets,
        closeEligibleDaa: f.s.closeEligibleDaa,
      },
    }),
    manager: {...f.manager, daa: f.manager.utxoDaa, covenantId: cid},
    frozen: f.targets.map(t => ({...t, covenantId: cid, daa: t.utxoDaa, origin: f.manager.origin})),
    accepting: 'ab'.repeat(32),
  };
  return {cid, rec};
}

function addRoundUtxos(node, f) {
  const cid = f.manager.cid;
  node.addUtxo({txid: f.manager.outpoint.transactionId, index: 0, value: f.manager.value, spk: f.manager.spk, daa: f.manager.utxoDaa, covenantId: cid});
  for (const t of f.targets) {
    node.addUtxo({txid: t.outpoint.transactionId, index: t.outpoint.index, value: t.value, spk: t.spk, daa: t.utxoDaa, covenantId: cid});
  }
}

function txToRestDto(node, txid) {
  let rec = null, acceptingBlock = null;
  for (const b of node.chain) {
    const hit = b.accepted.find(x => x.txid === txid);
    if (hit) { rec = hit; acceptingBlock = b.hash; break; }
  }
  assert.ok(rec, `missing tx in FakeNode chain: ${txid}`);
  const tx = rec.tx;
  return {
    transaction_id: txid,
    is_accepted: true,
    accepting_block_hash: acceptingBlock,
    block_time: 1_700_000_000_000,
    payload: typeof tx.payload === 'string' ? tx.payload : (tx.payload && tx.payload.length ? hex(tx.payload) : ''),
    inputs: tx.inputs.map((inp, index) => ({
      index,
      previous_outpoint_hash: inp.previousOutpoint.transactionId,
      previous_outpoint_index: String(inp.previousOutpoint.index),
      signature_script: typeof inp.signatureScript === 'string' ? inp.signatureScript : hex(inp.signatureScript),
    })),
    outputs: tx.outputs.map((out, index) => ({
      index,
      amount: Number(out.value),
      script_public_key: out.scriptPublicKey.script,
      covenant_id: out.covenant?.covenantId ?? null,
      covenant_authorizing_input: out.covenant ? String(out.covenant.authorizingInput) : null,
    })),
  };
}

test('Offline browser: dual-network switch, batchPayout/batchRefund, and pruned-node REST preimage recovery', async () => {
  const html = await loadCurrentTn10Html();

  // Prepare FakeNode for batchPayout & batchRefund
  const node = new FakeNode({daa: 5000});
  const winF = fixture({module: 'win', cnt: 2, local: 3, p: 0});
  const refundF = fixture({module: 'refund', cnt: 1, local: 35, r: 0, c: 224, per: 2});
  const winSeed = makeSeededRound(winF);
  const refundSeed = makeSeededRound(refundF);
  addRoundUtxos(node, winF);

  // Prepare a pruned-node round (GENESIS -> BUY) for REST preimage recovery
  const prunedNode = new FakeNode({daa: 5000});
  const KEY_A = createHash('sha256').update('pruned-rest-browser-a').digest('hex');
  const KEY_B = createHash('sha256').update('pruned-rest-browser-b').digest('hex');
  const W_A = openMemoryWallet(KEY_A);
  const W_B = openMemoryWallet(KEY_B);
  prunedNode.addUtxo({txid: 'c1'.repeat(32), value: 100n * KAS, spk: W_A.spk, daa: 100});
  prunedNode.addUtxo({txid: 'd1'.repeat(32), value: 100n * KAS, spk: W_B.spk, daa: 100});
  const msA = new MemoryStore(); msA.persistent = true;
  const msB = new MemoryStore(); msB.persistent = true;
  const ctlA = createController({profile, roundStore: new RoundStore(msA), connect: async () => prunedNode, sleep: async () => {}});
  const ctlB = createController({profile, roundStore: new RoundStore(msB), connect: async () => prunedNode, sleep: async () => {}});
  await ctlA.connectNode(['wss://fake-tn10.invalid/wrpc']);
  await ctlB.connectNode(['wss://fake-tn10.invalid/wrpc']);
  ctlA.openWallet(KEY_A);
  ctlB.openWallet(KEY_B);
  await ctlA.prepare({action: 'GENESIS', settings: {ticketPrice: '1', ticketCap: '10', minTickets: '3', closeMinutes: '0'}}, null);
  const prunedCid = ctlA.state.prepared.cid;
  await ctlA.signAndSend();
  prunedNode.mine(1);
  await ctlA.track(prunedCid);
  const gRound = (await ctlA.rounds()).find(x => x.cid === prunedCid);
  await ctlB.importText(roundToText(gRound));
  await ctlB.prepare({action: 'BUY', quantity: '2'}, prunedCid);
  await ctlB.signAndSend();
  prunedNode.mine(1);
  await ctlB.track(prunedCid);
  const bRound = (await ctlB.rounds()).find(x => x.cid === prunedCid);

  const gTxid = bRound.receipts[0].txid;
  const bTxid = bRound.receipts[1].txid;
  const gDto = txToRestDto(prunedNode, gTxid);
  const bDto = txToRestDto(prunedNode, bTxid);
  const restByAddr = new Map([
    [spkToAddress(gRound.manager.spk, 'kaspatest'), [bDto]],
  ]);
  const restByTx = new Map([[gTxid, gDto], [bTxid, bDto]]);

  let prunedMode = false;
  let mockNet = 'tn10';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/index.html' || url.pathname === '/') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const {port} = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({locale: 'zh-CN'});
  const page = await ctx.newPage();

  // Route TN10 REST API calls offline
  await page.route('https://api-tn10.kaspa.org/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/addresses/') && url.pathname.endsWith('/full-transactions')) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const addr = decodeURIComponent(url.pathname.split('/')[2]);
      const list = offset > 0 ? [] : (restByAddr.get(addr) ?? (addr === TN10.registry.address ? [gDto] : []));
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(list)});
    }
    if (url.pathname.startsWith('/transactions/')) {
      const id = url.pathname.split('/')[2];
      const dto = restByTx.get(id);
      if (dto) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(dto)});
      return route.fulfill({status: 404, contentType: 'application/json', body: '{}'});
    }
    return route.fulfill({status: 404, contentType: 'application/json', body: '{}'});
  });

  // Intercept WebSocket RPC offline
  await page.routeWebSocket('**/mock-node', ws => {
    ws.onMessage(async raw => {
      const msg = JSON.parse(raw);
      const {id, method, params} = msg;
      const sendResult = payload => ws.send(JSON.stringify({id, method, params: payload}, (_, v) => typeof v === 'bigint' ? v.toString() : v));
      const sendError = message => ws.send(JSON.stringify({id, method, error: {message}}));

      const activeNode = prunedMode ? prunedNode : node;
      const netId = mockNet === 'mainnet' ? MAINNET.networkId : TN10_NETWORK_ID;
      const genesisHash = mockNet === 'mainnet' ? MAINNET.genesis : TN10_GENESIS;
      if (method === 'getServerInfo') {
        return sendResult({networkId: netId, isSynced: true, hasUtxoIndex: true, virtualDaaScore: String(activeNode.sinkDaa), serverVersion: '2.1.0'});
      }
      if (method === 'getBlockDagInfo') {
        return sendResult({network: netId, blockCount: '100', headerCount: '100', tipHashes: [activeNode.chain.at(-1).hash], virtualDaaScore: String(activeNode.sinkDaa), pruningPointHash: genesisHash});
      }
      if (prunedMode && (method === 'getBlock' || method === 'getVirtualChainFromBlockV2')) {
        return sendError('block pruned');
      }
      try {
        const res = await activeNode.call(method, params);
        if (method === 'submitTransaction') activeNode.mine(1);
        return sendResult(res);
      } catch (e) {
        return sendError(e?.message ?? 'RPC_ERROR');
      }
    });
  });

  await page.addInitScript(({wsUrl}) => {
    localStorage.setItem('kaswin:language', 'zh-CN');
    localStorage.setItem('kaswin-rolling-tn10:nodes', JSON.stringify(wsUrl));
    localStorage.setItem('kaswin-rolling-tn10:indexer', JSON.stringify(''));
    localStorage.setItem('kaswin-rolling-tn10:language', JSON.stringify('zh'));
    localStorage.setItem('kaswin-rolling-mainnet:nodes', JSON.stringify(wsUrl));
    localStorage.setItem('kaswin-rolling-mainnet:indexer', JSON.stringify(''));
    localStorage.setItem('kaswin-rolling-mainnet:language', JSON.stringify('zh'));
  }, {wsUrl: `ws://127.0.0.1:${port}/mock-node`});

  try {
    await page.goto(`${origin}/index.html`);
    await page.waitForSelector('#walletBtn');
    await page.waitForFunction(() => document.querySelector('#nodeChip')?.textContent?.includes('已连接'));

    // 1. Dual-network switch (Testnet 10 -> Mainnet -> Testnet 10)
    await page.click('#settingsBtn');
    await page.waitForSelector('[data-act="switchNet"]');
    assert.match(await page.locator('#mBody').innerText(), /Testnet 10/);
    mockNet = 'mainnet';
    await page.click('[data-act="switchNet"]');
    await page.waitForFunction(() => document.querySelector('#nodeChip')?.textContent?.includes('Kaspa 主网') && document.querySelector('#nodeChip')?.textContent?.includes('已连接'));
    assert.match(await page.locator('#footerNet').innerText(), /· KAS\b/);

    // On mainnet, wallet modal hides test private key tab
    await page.click('#walletBtn');
    await page.waitForSelector('[data-connect="kasware"]');
    assert.equal(await page.locator('[data-wtab="key"]').count(), 0);
    await page.click('[data-act="closeModal"]');

    // Switch back to Testnet 10
    await page.click('#settingsBtn');
    await page.waitForSelector('[data-act="switchNet"]');
    assert.match(await page.locator('#mBody').innerText(), /Kaspa 主网/);
    mockNet = 'tn10';
    await page.click('[data-act="switchNet"]');
    await page.waitForFunction(() => document.querySelector('#nodeChip')?.textContent?.includes('Testnet 10') && document.querySelector('#nodeChip')?.textContent?.includes('已连接'));
    assert.match(await page.locator('#footerNet').innerText(), /· TKAS\b/);

    // Connect public recipient address for free settlement actions
    await page.click('#walletBtn');
    await page.waitForSelector('[data-wtab="addr"]');
    await page.click('[data-wtab="addr"]');
    await page.fill('#wAddr', EXEC_WALLET.address);
    await page.click('[data-act="connectWallet"]');
    await page.waitForFunction(() => document.querySelector('#walletBtn')?.dataset?.address?.includes('kaspatest:'));

    const ensureJoinOpen = async () => {
      if (!(await page.locator('#joinText').isVisible())) await page.click('.join-details summary');
    };

    // 2. Import win round (2 frozen shards) -> run batchPayout -> PAID
    await ensureJoinOpen();
    await page.fill('#joinText', roundToText(winSeed.rec));
    await page.click('[data-act="join"]');
    await page.waitForSelector('[data-act="batchPayout"]');
    await page.click('[data-act="batchPayout"]');
    try {
      await page.waitForFunction(() => document.querySelector('#mTitle')?.textContent?.includes('连续派奖已完成'), null, {timeout: 8000});
    } catch (e) {
      console.log('BATCH_PAYOUT_MODAL:', await page.locator('#mTitle').innerText(), 'BODY:', await page.locator('#mBody').innerText());
      throw e;
    }
    assert.match(await page.locator('#mBody').innerText(), /共处理 2 批/);
    await page.click('[data-act="closeModal"]');
    await page.waitForFunction(() => document.body.innerText.includes('已派奖'));

    // 3. Import refund round (1 frozen shard + 35 local records) -> run batchRefund -> REFUNDED
    addRoundUtxos(node, refundF);
    await page.click('[data-go="explore"]');
    await ensureJoinOpen();
    await page.fill('#joinText', roundToText(refundSeed.rec));
    await page.click('[data-act="join"]');
    await page.waitForSelector('[data-act="batchRefund"]');
    await page.click('[data-act="batchRefund"]');
    await page.waitForFunction(() => document.querySelector('#mTitle')?.textContent?.includes('连续退款已完成'), null, {timeout: 20000});
    assert.match(await page.locator('#mBody').innerText(), /共处理 3 批/);
    await page.click('[data-act="closeModal"]');
    await page.waitForFunction(() => document.body.innerText.includes('退款完成'));

    // 4. Pruned-node REST preimage recovery (GENESIS + BUY via REST when node pruned getBlock/V2)
    prunedMode = true;
    await page.click('[data-go="explore"]');
    await ensureJoinOpen();
    await page.fill('#joinText', prunedCid);
    await page.click('[data-act="join"]');
    await page.waitForFunction(() => document.body.innerText.includes('2 / 10') || document.body.innerText.includes('2 张') || document.body.innerText.includes('已售 2'), null, {timeout: 8000}).catch(async e => {
      console.log('PRUNED_BODY:', (await page.locator('body').innerText()).slice(0, 800));
      throw e;
    });
  } finally {
    await browser.close();
    server.close();
  }
});

test('Offline browser: blank page recovers >256-buy frozen-shard redeemScript preimage via KCI/Indexer on pruned node and completes batchPayout', async () => {
  const html = await loadCurrentTn10Html();
  const node = new FakeNode({daa: 10000});
  const winF = fixture({module: 'win', cnt: 2, local: 3, p: 0});
  const winSeed = makeSeededRound(winF);
  winSeed.rec.receipts = [{action: 'DRAW', txid: winF.manager.outpoint.transactionId, feeSompi: '1000000', finalized: true}];
  winSeed.rec.fees = 1000000n;
  addRoundUtxos(node, winF);
  const prunedHashes = new Set([...node.chain.map(b => b.hash), 'ab'.repeat(32)]);
  node.mine(20); // 20 unpruned tip blocks above the pruning point for live settlement tracking
  const exportedText = roundToText(winSeed.rec);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/index.html' || url.pathname === '/') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end(html);
      return;
    }
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
          cid: winSeed.cid,
          module: 'win',
          terminal: null,
          tickets: 515,
          shards: 2,
          frozenCount: 2,
          buys: 515,
          bought: 515,
          acceptingDaa: String(winF.manager.utxoDaa),
          fees: FEE.toString(),
        }],
        next: null,
      }));
      return;
    }
    if (url.pathname === `/idx/v1/rounds/${winSeed.cid}/export`) {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({
        schema: 1,
        network: TN10_NETWORK_ID,
        genesisHash: TN10_GENESIS,
        profileId: TN10_PROFILE_ID,
        cid: winSeed.cid,
        revision: '1',
        head: {txid: winF.manager.outpoint.transactionId, acceptingBlock: 'ab'.repeat(32)},
        roundText: exportedText,
      }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const {port} = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({locale: 'zh-CN'});
  const page = await ctx.newPage();

  // Pruned node: getBlock and getVirtualChainFromBlockV2 fail, but live UTXOs and submitTransaction work
  await page.routeWebSocket('**/mock-pruned-node', ws => {
    ws.onMessage(async raw => {
      const msg = JSON.parse(raw);
      const {id, method, params} = msg;
      const sendResult = payload => ws.send(JSON.stringify({id, method, params: payload}, (_, v) => typeof v === 'bigint' ? v.toString() : v));
      const sendError = message => ws.send(JSON.stringify({id, method, error: {message}}));
      if (method === 'getServerInfo') {
        return sendResult({networkId: TN10_NETWORK_ID, isSynced: true, hasUtxoIndex: true, virtualDaaScore: String(node.sinkDaa), serverVersion: '2.1.0'});
      }
      if (method === 'getBlockDagInfo') {
        return sendResult({network: TN10_NETWORK_ID, blockCount: '100', headerCount: '100', tipHashes: [node.chain.at(-1).hash], virtualDaaScore: String(node.sinkDaa), pruningPointHash: TN10_GENESIS});
      }
      if ((method === 'getBlock' && prunedHashes.has(params?.hash)) ||
          (method === 'getVirtualChainFromBlockV2' && prunedHashes.has(params?.startHash))) {
        return sendError('block pruned');
      }
      try {
        const res = await node.call(method, params);
        if (method === 'submitTransaction') node.mine(1);
        return sendResult(res);
      } catch (e) {
        return sendError(e?.message ?? 'RPC_ERROR');
      }
    });
  });

  await page.addInitScript(({wsUrl, idxUrl}) => {
    localStorage.setItem('kaswin-rolling-tn10:nodes', JSON.stringify(wsUrl));
    localStorage.setItem('kaswin:language', 'zh-CN');
    localStorage.setItem('kaswin-rolling-tn10:indexer', JSON.stringify(idxUrl));
    localStorage.setItem('kaswin-rolling-tn10:language', JSON.stringify('zh'));
  }, {wsUrl: `ws://127.0.0.1:${port}/mock-pruned-node`, idxUrl: `${origin}/idx/v1`});

  try {
    await page.goto(`${origin}/index.html`);
    await page.waitForSelector('#walletBtn');
    await page.waitForFunction(() => document.querySelector('#nodeChip')?.textContent?.includes('已连接'));

    // Connect public recipient address
    await page.click('#walletBtn');
    await page.waitForSelector('[data-wtab="addr"]');
    await page.click('[data-wtab="addr"]');
    await page.fill('#wAddr', EXEC_WALLET.address);
    await page.click('[data-act="connectWallet"]');
    await page.waitForFunction(() => document.querySelector('#walletBtn')?.dataset?.address?.includes('kaspatest:'));
    assert.match(await page.locator('#walletBtn').innerText(), /只读地址|Watch-only/);

    // Open discovered >256-buy round from Indexer on blank browser -> recovers frozen shard redeemScript preimages -> batchPayout -> PAID
    await page.click('[data-filter="live"]');
    const card = page.locator(`[data-indexed="${winSeed.cid}"]`);
    await card.waitFor({state: 'visible', timeout: 8000});
    await card.click();
    await page.waitForSelector('[data-act="batchPayout"]', {timeout: 5000}).catch(async e => {
      console.log('TEST2_VIEW:', (await page.locator('#view').innerText()).slice(0, 600));
      throw e;
    });
    await page.click('[data-act="batchPayout"]');
    await page.waitForFunction(() => document.querySelector('#mTitle')?.textContent?.includes('连续派奖已完成'), null, {timeout: 20000});
    assert.match(await page.locator('#mBody').innerText(), /共处理 2 批/);
    await page.click('[data-act="closeModal"]');
    await page.waitForFunction(() => document.body.innerText.includes('已派奖'));
  } finally {
    await browser.close();
    server.close();
  }
});
