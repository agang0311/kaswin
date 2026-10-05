// Built V2 in real Chromium. --live is READ ONLY: no provider, no signing/submission.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const html=await fs.readFile(new URL('../../../releases/kaswin-v2/index.html',import.meta.url));
assert.doesNotMatch(html.toString(),/实验室|renderLab|f256|f32-20260930|STALE_WALLET|MEMPOOL_EXPIRY/);
const live=process.argv.includes('--live'),srv=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(html);});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${srv.address().port}/`;
const browser=await chromium.launch(),errors=[],rows=[];
try{
 for(const width of live?[1360,390]:[1360,390,320]){
  const ctx=await browser.newContext({locale:'zh-CN',viewport:{width,height:900},colorScheme:'dark'}),page=await ctx.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('websocket',ws=>ws.on('framesent',({payload})=>{if(String(payload).includes('submitTransaction'))errors.push('FORBIDDEN REAL SUBMIT');}));
  if(!live)await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
  await page.goto(base);await page.waitForSelector('.hero');
  if(live)await page.waitForFunction(()=>document.querySelectorAll('.card').length>0,null,{timeout:60000});
  else await page.waitForSelector('.notice.warn');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width<721)await page.locator('.nav [data-go="mine"]').click();
  if(width<721){await page.waitForSelector('#mineList');await page.locator('.nav [data-go="explore"]').click();}
  const count=await page.locator('.card').count();if(!live)assert.equal(count,0);
  await page.screenshot({path:new URL(`../test-results/screenshots/${live?'live':'offline'}-${width}.png`,import.meta.url).pathname,fullPage:true});
  const row={width,cards:count};
  if(live){
    row.headlines=await page.locator('.card .big').allTextContents();
    row.sources=await page.locator('.card .src').allTextContents();
    if(width===1360){
      await page.click('#nodeChip');await page.waitForFunction(()=>document.querySelector('#nodeChip .dot')?.classList.contains('ok'),null,{timeout:45000});
      row.node=await page.locator('#nodeChip').getAttribute('title');
    }
    await page.locator('.card').first().click();await page.waitForSelector('#verifyLatest');
    await page.screenshot({path:new URL(`../test-results/screenshots/round-${width}.png`,import.meta.url).pathname,fullPage:true});
    if(width===1360){
      await page.click('#verifyLatest');await page.waitForFunction(()=>/逐字节一致|固定 Profile 一致|复验未完成|已被节点裁剪/.test(document.querySelector('#verifyBox')?.textContent??''),null,{timeout:90000});
      row.replay=await page.locator('#verifyBox').textContent();
      // Reload with indexer inaccessible: source must say cached, not live.
      await page.route('**/indexer/**',r=>r.abort());await page.goto(base);await page.waitForSelector('.notice.warn');
      row.cachedCards=await page.locator('.card').count();assert.ok(row.cachedCards>0);
      row.cachedSource=await page.locator('.card .src').first().textContent();assert.match(row.cachedSource,/缓存/);
    }
  }
  await page.locator('.nav [data-go="create"]').click();await page.waitForSelector('#cPrice');
  assert.equal(await page.locator('#cPcap').isVisible(),false);
  await page.fill('#cPrice','0.1');assert.match(await page.locator('#cErr').textContent(),/至少/);
  await page.fill('#cPrice','1');await page.click('.advanced summary');assert.equal(await page.locator('#cPcap').isVisible(),true);
  await page.screenshot({path:new URL(`../test-results/screenshots/create-${width}.png`,import.meta.url).pathname,fullPage:true});
  await page.locator('.nav [data-go="protocol"]').click();await page.waitForSelector('#budgetPc');assert.equal(await page.locator('#budgetBox tbody tr').count(),7);
  await page.click('#settingsBtn');await page.waitForSelector('#sNodes');assert.match(await page.locator('#sNodes').inputValue(),/wss:/);
  await page.click('#mClose');await page.goto(base+'#/lab');await page.waitForSelector('.hero');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  rows.push(row);await ctx.close();
 }
}finally{await browser.close();srv.close();}
const report={at:new Date().toISOString(),scope:live?'READ-ONLY real configured TN10 node and indexer; cache fallback; no wallet/sign/submit':'offline UI only, external requests blocked',rows,errors};
await fs.writeFile(new URL(`../test-results/${live?'live-readonly':'browser-smoke'}-report.json`,import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(errors,[]);
