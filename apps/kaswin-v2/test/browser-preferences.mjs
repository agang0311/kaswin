// Actual release DOM, mocked discovery only. No wallet, signing, node or external requests.
// Protect the collapsed-list interaction and persisted creation parameters across reloads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {chromium} from 'playwright';
const html = await fs.readFile(new URL('../../../releases/kaswin-v2/index.html', import.meta.url));
const srv = http.createServer((q, r) => {r.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'}); r.end(html);});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;
let browser;
const results = [];
try {
  browser = await chromium.launch();
  for (const width of [1360, 390, 320]) {
    const ctx = await browser.newContext({locale: 'zh-CN', viewport: {width, height: 900}});
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => {
      const url = r.request().url();
      if (url.startsWith(base)) return r.continue();
      if (url.includes('/v1/rounds?')) return r.fulfill({json: {network: 'testnet-10', requiresIndependentVerification: true,
        items: [{cid: '11'.repeat(32), indexStatus: 'LIVE', contract: 'old-profile', terminal: null, phase: 1, value: '20000000', updatedAt: 1}], nextCursor: null}});
      return r.abort();
    });
    await page.goto(base); await page.waitForSelector('.other-rounds-details');
    const details = page.locator('.other-rounds-details');
    assert.equal(await details.evaluate(el => el.open), false);
    assert.equal(await details.evaluate(el => el.previousElementSibling.id), 'refreshRows');
    assert.equal(await page.locator('#view > .grid .card').count(), 0);
    await details.locator('summary').click();
    await page.fill('#q', '11');
    assert.equal(await details.evaluate(el => el.open), true);
    assert.equal(await details.locator('.card').count(), 1);
    await page.fill('#q', '22');
    assert.equal(await details.evaluate(el => el.open), true);
    assert.equal(await details.locator('.card').count(), 0);
    await details.locator('summary').click(); await page.fill('#q', '11');
    assert.equal(await details.evaluate(el => el.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('.nav [data-go="create"]').click();
    assert.equal(await page.inputValue('#cCap'), '100000');
    await page.fill('#cPrice', '2.12345678'); await page.fill('#cCap', '99999'); await page.fill('#cMin', '7');
    await page.click('[data-dur="custom"]'); await page.fill('#cCustom', '180');
    await page.click('.advanced summary'); await page.fill('#cPcap', '100'); await page.uncheck('#cReg');
    await page.reload(); await page.waitForSelector('#cCap');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('kaswin-v2:createForm'))),
      {price: '2.12345678', cap: '99999', min: '7', pcap: '100', dur: 'custom', custom: '180', registry: false});
    for (const [id, value] of Object.entries({cPrice: '2.12345678', cCap: '99999', cMin: '7', cPcap: '100', cCustom: '180'}))
      assert.equal(await page.inputValue('#' + id), value);
    assert.equal(await page.isChecked('#cReg'), false);
    assert.equal(await page.locator('[data-dur="custom"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []); results.push({width, passed: true}); await ctx.close();
  }
} finally { await browser?.close(); await new Promise(r => srv.close(r)); }
console.log(JSON.stringify({scope: 'OFFLINE_BROWSER_UI_ONLY', results}, null, 2));
