// Display-only Chromium tests. --live only reads existing LA rounds; never signs or submits.
import fs from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const html = await fs.readFile(new URL('../../../releases/kaswin-v2/index.html', import.meta.url));
const srv = http.createServer((q, r) => { r.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); r.end(html); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`, live = process.argv.includes('--live');
const browser = await chromium.launch(), errors = [], rows = [], untranslated = new Set();
const scan = async page => {
  const found = await page.evaluate(() => {
    const out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; if (n.parentElement.closest('script,style,textarea,[data-no-i18n]') || !n.parentElement.checkVisibility()) continue; if (/[\p{Script=Han}]/u.test(n.data)) out.push(n.data.trim()); }
    return out;
  });
  found.forEach(x => untranslated.add(x));
};
try {
  for (const [width, timezoneId] of [[1360, 'Asia/Shanghai'], [390, 'America/Los_Angeles'], [320, 'Europe/Berlin']]) {
    const ctx = await browser.newContext({viewport: {width, height: 900}, locale: 'en-US', timezoneId, colorScheme: 'dark'}), page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('websocket', ws => ws.on('framesent', ({payload}) => { if (String(payload).includes('submitTransaction')) errors.push('FORBIDDEN SUBMIT'); }));
    if (!live) await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await page.goto(base); await page.waitForSelector('.hero');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await page.waitForFunction(() => document.querySelector('.hero h1').textContent.includes('See every step'));
    assert.equal(await page.locator('#themeBtn').getAttribute('data-icon'), 'sun');
    assert.notEqual(await page.locator('#settingsBtn').innerHTML(), await page.locator('#themeBtn').innerHTML());
    await page.click('#themeBtn'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('#themeBtn').getAttribute('data-icon'), 'moon');
    await page.screenshot({path:new URL(`../test-results/screenshots/i18n-light-${width}.png`,import.meta.url).pathname});
    if (live) {
      await page.waitForSelector('.card', {timeout: 60000}); await scan(page);
      const clock = page.locator('time[data-local-time]').first();
      const timestamp = Number(await clock.getAttribute('data-local-time'));
      const expected = await page.evaluate(t => new Intl.DateTimeFormat('en-US', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(t), timestamp);
      assert.equal(await clock.textContent(), expected);
      await page.click('#languageBtn'); assert.equal(await clock.getAttribute('data-local-time'),String(timestamp));
      assert.match(await clock.textContent(),/GMT/);
      await page.click('#languageBtn'); assert.equal(await clock.textContent(),expected);
      await page.locator('.card:not([data-profile="other"])').first().click(); await page.waitForSelector('#verifyLatest');
      if(width===1360) { await page.click('#verifyLatest'); await page.waitForFunction(()=>document.querySelector('#verifyBox .notice') && !/Retrieving/.test(document.querySelector('#verifyBox').textContent),null,{timeout:90000}); await scan(page); }
    }
    await scan(page);
    await page.locator('.nav [data-go="create"]').click(); await page.waitForSelector('#cPrice');
    await page.fill('#cPrice', '2.5');
    await page.click('#languageBtn'); assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.locator('#cPrice').inputValue(), '2.5');
    await page.click('#languageBtn'); assert.equal(await page.locator('#cPrice').inputValue(), '2.5');
    await page.fill('#cMin', '999'); await scan(page); await page.fill('#cMin', '3');
    await scan(page);
    await page.locator('.nav [data-go="protocol"]').click(); await page.waitForSelector('#budgetPc'); await scan(page);
    await page.click('#pTheme'); assert.equal(await page.locator('#pTheme').getAttribute('data-icon'), 'sun');
    await page.click('#settingsBtn'); await page.waitForSelector('#sNodes');
    if(live && width===1360) {
      await page.click('#sTest'); await page.waitForFunction(()=>document.querySelectorAll('#sProbe .notice').length===2,null,{timeout:90000}); await scan(page);
      assert.equal(await page.locator('#sProbe .notice.ok').count(),2,await page.locator('#sProbe').textContent());
    }
    await page.fill('#sNodes', 'ws://127.0.0.1:18210'); await page.fill('#sIdx', 'http://127.0.0.1:8788');
    await page.locator('#mBody details').first().click(); await scan(page);
    // Change language in place even with a dialog open, without rebuilding inputs.
    await page.evaluate(() => document.querySelector('#languageBtn').click());
    assert.equal(await page.locator('#sNodes').inputValue(), 'ws://127.0.0.1:18210');
    await page.evaluate(() => document.querySelector('#languageBtn').click());
    assert.equal(await page.locator('#sIdx').inputValue(), 'http://127.0.0.1:8788');
    await page.click('#mClose');
    await page.locator('.nav [data-go="mine"]').click(); await page.waitForSelector('#mineList'); await scan(page);
    const zone = await page.locator('#localZone').textContent(); assert.ok(zone.includes(timezoneId));
    // Plain text translation must never become markup; custom inputs/data attributes stay untouched.
    await page.evaluate(() => {
      const d=document.createElement('div');d.id='i18nSafety';d.dataset.raw='结果未知';d.textContent='节点信息：<img src=x onerror=alert(1)>';document.body.append(d);
    });
    await page.waitForFunction(()=>document.querySelector('#i18nSafety').textContent.startsWith('Node information:'));
    assert.equal(await page.locator('#i18nSafety img').count(),0);
    assert.equal(await page.locator('#i18nSafety').getAttribute('data-raw'),'结果未知');
    await page.evaluate(()=>document.querySelector('#i18nSafety').remove());
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); assert.equal(overflow, false);
    await page.reload(); assert.equal(await page.locator('html').getAttribute('lang'), 'en'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('.nav [data-go="explore"]').click();
    await scan(page);
    await page.screenshot({path: new URL(`../test-results/screenshots/i18n-en-${width}.png`, import.meta.url).pathname, fullPage: true});
    await page.click('#languageBtn'); await page.reload();
    assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
    rows.push({width, timezoneId, zone, overflow, chinesePreferenceReload:true}); await ctx.close();
  }
} finally { await browser.close(); srv.close(); }
const report = {at: new Date().toISOString(), scope: live ? 'READ ONLY real LA index; UI localization, no wallet/sign/submit' : 'Offline browser UI only; external requests blocked', rows, errors, untranslated: [...untranslated]};
await fs.writeFile(new URL(`../test-results/i18n-${live ? 'live' : 'browser'}-report.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2)); assert.deepEqual(errors, []);
if (!process.argv.includes('--inventory')) assert.deepEqual([...untranslated], []);
