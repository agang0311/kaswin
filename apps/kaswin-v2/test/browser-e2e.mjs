// Real Chromium + the BUILT single file, driven through the UI. The two "nodes" and the indexer are a simulated TN10
// (Node side, same JSON wRPC message format) and the wallet is a simulated KasWare signing with the PUBLIC test key sk=1
// via the pinned SDK in Node. This tests the UI and the engine end-to-end; it is NOT a real-chain or real-extension test.
import {createRequire} from 'node:module';
import http from 'node:http';
import fs from 'node:fs/promises';
import {WebSocketServer} from 'ws';
import {SimChain, simIndexer, loadProfile, sdk, TEST_SK, TEST_ADDRESS, TEST_KEY} from './sim.mjs';
import {parseJson, jsonText} from '../scripts/shared/lib/json.mjs';
import {S} from '../scripts/shared/core.mjs';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const manifest = JSON.parse(await fs.readFile(new URL('../../../releases/kaswin-v2/build-manifest.json', import.meta.url), 'utf8'));
if (manifest.tradingEnabled !== true) throw Error('READ_ONLY_CANDIDATE: trading-flow E2E requires an independently approved trading build, never bypass the candidate gate');
const profile = loadProfile(), chain = new SimChain(), idx = simIndexer(chain, profile);
chain.fund(TEST_ADDRESS, 60_000_000_000n);
chain.fund(TEST_ADDRESS, 60_000_000_000n);

// ---- simulated node over a real WebSocket
const httpServer = http.createServer(async (req, res) => {
  if (req.url.startsWith('/indexer/')) {
    const r = await idx.fetch('http://x' + req.url.slice('/indexer'.length));
    res.writeHead(r.status, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}); res.end(await r.text()); return;
  }
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(await fs.readFile(new URL('../../../releases/kaswin-v2/index.html', import.meta.url)));
});
const wss = new WebSocketServer({noServer: true});
httpServer.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, ws => {
  const methods = chain.rpcFor(req.url.includes('alpha') ? 'p2p-alpha' : 'p2p-beta');
  ws.on('message', buf => {
    const m = parseJson(buf.toString());
    let reply; try { const f = methods[m.method]; if (!f) throw {message: 'unsupported ' + m.method}; reply = {id: m.id, params: f(m.params)}; } catch (e) { reply = {id: m.id, error: {message: e.message ?? String(e)}}; }
    ws.send(jsonText(reply));
  });
}));
import os from 'node:os';
const lan = process.argv.includes('--lan') ? Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address : null;
await new Promise(r => httpServer.listen(0, lan ?? '127.0.0.1', r));
const hostName = lan ?? '127.0.0.1', port = httpServer.address().port, base = `http://${hostName}:${port}`;
const nodes = [`ws://${lan ?? 'localhost'}:${port}/alpha/kaspa/testnet-10/wrpc/json`];

// ---- simulated wallet: page-side shim forwarding signPskt to Node (pinned SDK, public key sk=1)
const pk = new sdk.PrivateKey(TEST_SK);
const signPskt = ({txJsonString, options}) => {
  const tx = sdk.Transaction.deserializeFromSafeJSON(txJsonString), out = JSON.parse(tx.serializeToSafeJSON());
  for (const {index} of options.signInputs) out.inputs[index].signatureScript = sdk.createInputSignature(tx, index, pk, sdk.SighashType.All);
  return JSON.stringify(out);
};
const browser = await chromium.launch();
const english = process.argv.includes('--en'), untranslated = new Set();
const errors = [], steps = [];
const ctx = await browser.newContext({viewport: {width: 1360, height: 900}, locale: english ? 'en-US' : 'zh-CN'});
async function scanEnglish() {
  if (!english) return;
  const words = await page.evaluate(() => {
    const out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; if (n.parentElement.closest('script,style,textarea,[data-no-i18n]') || !n.parentElement.checkVisibility()) continue; if (/[\p{Script=Han}]/u.test(n.data)) out.push(n.data.trim()); }
    return out;
  });
  words.forEach(s => untranslated.add(s));
}
await ctx.exposeFunction('__simSign', arg => signPskt(JSON.parse(arg)));
await ctx.addInitScript(([address, key]) => {
  window.kasware = {requestAccounts: async () => [address], getAccounts: async () => [address], getNetwork: async () => 'kaspa_testnet_10', getPublicKey: async () => '02' + key,
    signPskt: async p => window.__simSign(JSON.stringify(p)), on() {}, removeListener() {}};
}, [TEST_ADDRESS, TEST_KEY]);
const page = await ctx.newPage();
page.on('load', async () => { try { steps.push(['context', String(await page.evaluate(() => `secure=${isSecureContext} subtle=${!!crypto.subtle} locks=${!!navigator.locks}`))]); } catch {} });
page.on('pageerror', e => errors.push(e.message));
// Chromium logs every HTTP 404 as a console error; 404 from the indexer for a not-yet-indexed round is expected here.
page.on('console', m => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
const shot = name => process.argv.includes('--shots') ? page.waitForTimeout(400).then(() => page.screenshot({path: new URL(`../test-results/screenshots/e2e-${name}.png`, import.meta.url).pathname})) : null;

async function approveAndSubmit(label) {
  await page.waitForSelector('#approve', {timeout: 60000});
  await shot(label + '-plan');
  await scanEnglish();
  if (english) {
    // Switching labels must not discard or silently approve the current plan.
    await page.evaluate(() => document.querySelector('#languageBtn').click());
    if (await page.locator('#approve').isChecked()) throw Error('Language switch approved transaction');
    await page.evaluate(() => document.querySelector('#languageBtn').click());
  }
  await page.check('#approve');
  await page.click('#sign');
  await page.waitForSelector('#recTx', {state: 'attached', timeout: 60000});
  const status = await page.locator('#mBody .badge').first().textContent();
  steps.push([label, status]);
  // wait for auto-reconcile to report acceptance
  await page.waitForFunction(() => /已接受|Accepted/.test(document.querySelector('#mBody .badge')?.textContent ?? ''), null, {timeout: 60000});
  await scanEnglish();
  await shot(label + '-accepted');
  await page.click('#mClose');
}
try {
  await page.goto(base + '/#/create');
  await page.evaluate(([idxUrl, ns]) => { localStorage.setItem('kaswin-v2:configVersion','2'); localStorage.setItem('kaswin-v2:indexer', JSON.stringify(idxUrl)); localStorage.setItem('kaswin-v2:nodes', JSON.stringify(ns)); }, [base + '/indexer', nodes]);
  await page.reload();
  await page.waitForSelector('#cPrice');
  await page.fill('#cPrice', '1'); await page.fill('#cCap', '3'); await page.fill('#cMin', '3');
  await page.click('.advanced summary'); await page.fill('#cPcap', '256');
  await page.click('[data-dur="10"]');
  await page.click('#cGo');
  await approveAndSubmit('genesis');
  // The new round: track it in the simulated indexer from the chain's accepted genesis (as the real indexer would via Registry).
  const g = [...chain.accepted.values()].at(-1), cid = g.tx.outputs[0].covenant.covenantId;
  // Lagging indexer whose server clock is far ahead: it keeps serving the OPEN genesis state with a later timestamp.
  // The page must follow its own accepted transactions anyway (state progress, never cross-machine timestamps).
  const genesisTxid = [...chain.accepted.keys()].at(-1), HEADER_AT = 'KASWIN_GENESIS_V2'.length + 32;
  idx.track(cid, {genesisTxid, origin: g.tx.inputs[0].previousOutpoint, tip: {transactionId: genesisTxid, index: 0},
    ledger: Buffer.from(g.tx.payload, 'hex').subarray(HEADER_AT), updatedAt: Date.now() + 365 * 86400_000});
  await page.goto(base + '/#/round/' + cid);
  await page.waitForSelector('[data-act="BUY"]', {timeout: 60000});
  await shot('round-open');
  for (let i = 0; i < 3; i++) {
    await page.click('[data-act="BUY"]');
    await page.waitForSelector('#qty'); await page.fill('#qty', '1'); await page.click('#go');
    await approveAndSubmit('buy' + (i + 1));
    await page.waitForSelector(i < 2 ? '[data-act="BUY"]' : '[data-act="CLOSE"]', {timeout: 60000});
  }
  await page.click('[data-act="CLOSE"]');
  await approveAndSubmit('close');
  await page.waitForSelector('[data-act="TIMEOUT_REFUND"]', {timeout: 60000});
  steps.push(['sealed-while-indexer-open', String(await page.locator('[data-act="BUY"]').count() === 0 && (await page.locator('.round-actions').textContent()).includes(english ? 'Draw' : '开奖'))]);
  if (await page.locator('[data-act="BUY"]').count()) throw Error('SEALED round shown as OPEN while the indexer lags');
  // Too early: the page must explain instead of building a transaction.
  await page.click('[data-act="TIMEOUT_REFUND"]');
  await page.waitForFunction(() => /432000 DAA|还差/.test(document.getElementById('pErr')?.textContent ?? ''), null, {timeout: 60000});
  steps.push(['timeout-too-early', await page.locator('#pErr').textContent()]);
  await scanEnglish();
  await page.click('#mClose');
  // Jump simulated score, not 432000 allocated blocks; this is not consensus evidence.
  chain.daa += S.TIMEOUT_DELAY; chain.blue += S.TIMEOUT_DELAY; chain.addBlock();
  await page.click('[data-act="TIMEOUT_REFUND"]');
  await approveAndSubmit('timeout');
  await page.waitForSelector('[data-act="REFUND"]', {timeout: 60000});
  await page.click('[data-act="REFUND"]');
  await approveAndSubmit('refund');
  // "Mine" view lists all six submissions as accepted.
  await page.goto(base + '/#/mine');
  await page.waitForFunction(() => document.querySelectorAll('#mineList tbody tr').length >= 6, null, {timeout: 30000});
  steps.push(['mine-rows', String(await page.locator('#mineList tbody tr').count())]);
  await scanEnglish();
  await shot('mine');
} catch (e) { errors.push('E2E: ' + e.message.split('\n')[0]); await page.screenshot({path: new URL('../test-results/screenshots/e2e-failure.png', import.meta.url).pathname}).catch(() => {}); }
finally { await browser.close(); httpServer.close(); wss.close(); }
const final = [...chain.accepted.values()].map(a => a.tx.outputs.length);
const report = {at: new Date().toISOString(), origin: base, steps, errors, submits: chain.submits, acceptedTxs: chain.accepted.size, outputsPerTx: final,
  untranslated: [...untranslated], language: english ? 'en' : 'zh-CN',
  scope: 'built kaswin-v2.html in Chromium; simulated TN10 node over a real WebSocket + simulated indexer; simulated KasWare signing with public test key; NOT a real chain or real extension'};
await fs.writeFile(new URL(english ? '../test-results/e2e-en-report.json' : lan ? '../test-results/e2e-lan-report.json' : '../test-results/e2e-report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
if (errors.length || (untranslated.size && !process.argv.includes('--inventory'))) process.exit(1);
