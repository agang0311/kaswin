// Real HTTP + WebSocket transports in Chromium; read-only simulated JSON wRPC and indexer, NOT live-chain evidence.
// Exercises Settings inputs/save/reload/test, including cross-origin HTTP CORS; no wallet, key, signing or submit.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {chromium} from 'playwright';
const html = await fs.readFile(new URL('../../../releases/kaswin-v2/index.html', import.meta.url));
const browser = await chromium.launch(), report = {at: new Date().toISOString(), sha256: createHash('sha256').update(html).digest('hex'), scope: 'local HTTP/WS real transport, simulated read-only services; no real wallet/chain', rows: [], errors: []};
const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
try {
  for (const host of ['127.0.0.1', ...(lan ? [lan] : [])]) {
    const web = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(html); });
    await new Promise(r => web.listen(0, host, r));
    const base = `http://${host}:${web.address().port}`, methods = [], origins = [];
    const service = http.createServer((req, res) => {
      origins.push(req.headers.origin ?? null);
      res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': base});
      res.end(JSON.stringify({network: 'testnet-10', requiresIndependentVerification: true, items: [], nextCursor: null, lastCheckpointAt: Date.now()}));
    });
    const wss = new WebSocketServer({server: service});
    wss.on('connection', ws => ws.on('message', buf => {
      const msg = JSON.parse(buf.toString()); methods.push(msg.method);
      const params = msg.method === 'getServerInfo' ? {networkId: 'testnet-10', isSynced: true, hasUtxoIndex: true, virtualDaaScore: 600000000, serverVersion: 'read-only-test'} : msg.method === 'getSinkBlueScore' ? {blueScore: 590000000} : null;
      ws.send(JSON.stringify(params ? {id: msg.id, params} : {id: msg.id, error: {message: 'FORBIDDEN: ' + msg.method}}));
    }));
    await new Promise(r => service.listen(0, host, r));
    const node = `ws://${host}:${service.address().port}/json`, indexer = `http://${host}:${service.address().port}/indexer`;
    const ctx = await browser.newContext({locale: 'zh-CN', viewport: {width: 390, height: 900}});
    try {
      // Keep all startup traffic local, but enter/persist the explicit WS list through the UI, not storage injection.
      await ctx.addInitScript(indexer => { if (!localStorage.getItem('kaswin-v2:configVersion')) {
        localStorage.setItem('kaswin-v2:configVersion', '3'); localStorage.setItem('kaswin-v2:indexer', JSON.stringify(indexer));
      } }, indexer);
      const p = await ctx.newPage(); p.on('pageerror', e => report.errors.push(e.message));
      await p.route('**/*', r => r.request().url().startsWith(base) || r.request().url().startsWith(indexer) ? r.continue() : r.abort());
      await p.goto(base); await p.click('#settingsBtn');
      await p.fill('#sNodes', node); await p.fill('#sIdx', indexer);
      assert.equal(await p.locator('#sErr').textContent(), '');
      assert.match(await p.locator('#sWarn').textContent(), /无需 TLS 证书/);
      assert.doesNotMatch(await p.locator('#sWarn').textContent(), /混合内容/);
      await p.click('#sSave'); await p.waitForSelector('#sNodes', {state: 'hidden'});
      await p.reload(); await p.click('#settingsBtn');
      assert.equal(await p.locator('#sNodes').inputValue(), node); assert.equal(await p.locator('#sIdx').inputValue(), indexer);
      await p.click('#sTest'); await p.waitForFunction(() => /节点可用/.test(document.querySelector('#sProbe')?.textContent ?? '') && /Indexer 可用/.test(document.querySelector('#sProbe')?.textContent ?? ''));
      const probe = await p.locator('#sProbe').textContent();
      assert.ok(methods.includes('getServerInfo')); assert.ok(origins.includes(base)); assert.equal(methods.includes('submitTransaction'), false);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      report.rows.push({page: base, node, indexer, saveReload: true, probe, crossOrigin: true, origins: [...new Set(origins)], methods: [...new Set(methods)]});
    } finally { await ctx.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await Promise.all([new Promise(r => web.close(r)), new Promise(r => service.close(r))]); }
  }
  // HTTPS warning is advisory: valid plaintext settings can still be saved. Network blocked here; not a bypass test.
  const ctx = await browser.newContext({locale: 'zh-CN'}), p = await ctx.newPage();
  p.on('pageerror', e => report.errors.push(e.message));
  await p.route('**/*', r => r.request().url().startsWith('https://v2.example.test/') ? r.fulfill({contentType: 'text/html', body: html}) : r.abort());
  await p.routeWebSocket('**/*', ws => ws.close());
  await p.goto('https://v2.example.test/'); await p.click('#settingsBtn');
  await p.fill('#sNodes', 'ws://192.168.1.10:18210'); await p.fill('#sIdx', 'http://192.168.1.10:8788');
  assert.match(await p.locator('#sWarn').textContent(), /混合内容/); assert.equal(await p.locator('#sErr').textContent(), '');
  await p.click('#sSave'); await p.waitForSelector('#sNodes', {state: 'hidden'});
  await p.reload(); await p.click('#settingsBtn');
  assert.equal(await p.locator('#sNodes').inputValue(), 'ws://192.168.1.10:18210/');
  assert.equal(await p.locator('#sIdx').inputValue(), 'http://192.168.1.10:8788');
  report.httpsAdvisorySave = true;
  await ctx.close();
} finally { await browser.close(); }
assert.deepEqual(report.errors, []);
await fs.writeFile(new URL('../test-results/plaintext-browser-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
