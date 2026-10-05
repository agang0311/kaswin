// Built V2 in Chromium. (1) Saved v2 settings with retired endpoints are migrated once; settings/reset show defaults.
// (2) --live: READ ONLY against the new defaults (kaspay node + kaspay indexer): rounds incl. other-Profile rows render without
// errors; no wallet, no signing, no submission; asserts no request ever goes to legacy endpoints.
import fs from 'node:fs/promises';
import http from 'node:http';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const html = await fs.readFile(new URL('../../../releases/kaswin-v2/index.html', import.meta.url));
assert.doesNotMatch(html.toString(), /cd311\.cn/, 'built HTML must not contain cd311');
assert.doesNotMatch(html.toString(), /legacy\.kaspa\.test:18210\/(wrpc|indexer)/, 'built HTML must not contain retired endpoint URLs');
const srv = http.createServer((_q, r) => { r.writeHead(200, {'content-type': 'text/html; charset=utf-8'}); r.end(html); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`, live = process.argv.includes('--live');
const browser = await chromium.launch(), errors = [], retired = [], report = {at: new Date().toISOString(), sha256: createHash('sha256').update(html).digest('hex'), live};
try {
  const ctx = await browser.newContext({locale: 'zh-CN', viewport: {width: 390, height: 844}}), page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const watch = url => { if (/legacy\.kaspa\.test/.test(url)) retired.push(url); };
  page.on('request', r => watch(r.url())); page.on('websocket', ws => { watch(ws.url()); ws.on('framesent', ({payload}) => { if (String(payload).includes('submitTransaction')) errors.push('FORBIDDEN SUBMIT'); }); });
  if (!live) { await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort()); await page.routeWebSocket('**/*', ws => ws.close()); }
  // A browser that used the previous version: configVersion 2 with the old default list + old indexer.
  await page.goto(base + '#/mine'); await page.waitForSelector('#mineList');
  await page.evaluate(() => { localStorage.setItem('kaswin-v2:configVersion', '2'); localStorage.setItem('kaswin-v2:indexer', JSON.stringify('https://legacy.kaspa.test:18210/indexer'));
    localStorage.setItem('kaswin-v2:nodes', JSON.stringify(['wss://legacy.kaspa.test:18210/wrpc', 'wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json', 'wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json', 'wss://quark-10.kaspa.red/kaspa/testnet-10/wrpc/json', 'wss://electron-10.kaspa.stream/kaspa/testnet-10/wrpc/json'])); });
  await page.goto(base); await page.waitForSelector('.hero');
  report.saved = await page.evaluate(() => ({version: localStorage.getItem('kaswin-v2:configVersion'), nodes: localStorage.getItem('kaswin-v2:nodes'), indexer: localStorage.getItem('kaswin-v2:indexer')}));
  assert.deepEqual(report.saved, {version: '4', nodes: 'null', indexer: 'null'});
  await page.click('#settingsBtn'); await page.waitForSelector('#sNodes');
  report.settings = {nodes: (await page.locator('#sNodes').inputValue()).split('\n'), indexer: await page.locator('#sIdx').inputValue()};
  assert.equal(report.settings.nodes[0], 'wss://tn10.kaspay.top/wrpc'); assert.equal(report.settings.indexer, 'https://tn10.kaspay.top/indexer');
  assert.doesNotMatch(await page.locator('#mBody').textContent(), /legacy\.kaspa\.test/);
  await page.fill('#sIdx', 'https://example.org/x'); await page.click('#sReset');
  assert.equal(await page.locator('#sIdx').inputValue(), 'https://tn10.kaspay.top/indexer'); assert.equal((await page.locator('#sNodes').inputValue()).split('\n')[0], 'wss://tn10.kaspay.top/wrpc');
  await page.click('#mClose');
  await page.locator('.nav [data-go="protocol"]').click(); await page.waitForSelector('#budgetPc');
  report.protocolNode = (await page.locator('main').textContent()).match(/默认 [^ ]*tn10\.kaspay\.top[^，,]*/)?.[0] ?? null; assert.ok(report.protocolNode);
  if (live) {
    await page.locator('.nav [data-go="explore"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, null, {timeout: 90000});
    await page.waitForTimeout(4000); // let bounded detail hydration finish
    report.cards = await page.locator('.card').evaluateAll(cs => cs.map(c => `${c.querySelector('.badge')?.textContent} | ${c.querySelector('.mono')?.textContent}`));
    report.otherProfileCards = await page.locator('.card[data-profile="other"]').count();
    report.kpi = await page.locator('.kpi').first().textContent();
    report.source = await page.locator('.source-strip').first().textContent();
    assert.match(report.source, /tn10\.kaspay\.top\/indexer/);
    if (report.otherProfileCards) { await page.locator('.card[data-profile="other"]').first().click(); await page.waitForSelector('.notice.warn');
      report.otherProfileDetail = await page.locator('main').textContent(); assert.match(report.otherProfileDetail, /其他（旧版）合约轮次/); await page.goBack(); }
    // Mobile intentionally hides the status chip. Exercise the visible desktop control, then check mobile layout again.
    await page.setViewportSize({width: 1360, height: 900});
    await page.click('#nodeChip'); await page.waitForFunction(() => document.querySelector('#nodeChip .dot')?.classList.contains('ok'), null, {timeout: 60000});
    report.node = await page.locator('#nodeChip').getAttribute('title');
    assert.match(report.node ?? '', /tn10\.kaspay\.top/);
    await page.setViewportSize({width: 390, height: 844});
    await page.screenshot({path: new URL('../test-results/screenshots/la-live-390.png', import.meta.url).pathname, fullPage: true});
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
} finally { await browser.close(); srv.close(); }
report.retiredRequests = retired; report.errors = errors;
await fs.writeFile(new URL(`../test-results/${live ? 'endpoints-live' : 'endpoints-migration'}-report.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(errors, []); assert.deepEqual(retired, []);
