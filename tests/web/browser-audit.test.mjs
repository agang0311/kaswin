// Candidate-page browser fault injection and settings checks. No wallet/key, signatures, broadcasts or fabricated node replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const URL_='https://cd311.cn:888/www/rolling-tn10/';
const candidate='/tmp/kaswin-rolling-campaign-candidate/index.html';
async function fixture() {
 const browser=await chromium.launch(),ctx=await browser.newContext();
 await ctx.route(URL_,route=>route.fulfill({path:candidate,contentType:'text/html'}));
 await ctx.addInitScript(()=>{
  window.failRead=false;window.injectedFailures=0;window.readsAfterFailure=0;window.unhandled=[];
  addEventListener('unhandledrejection',event=>window.unhandled.push(String(event.reason)));
  const original=IDBObjectStore.prototype.openCursor;
  IDBObjectStore.prototype.openCursor=function(...args){
   if(this.transaction.mode==='readonly') {
    if(window.failRead){window.failRead=false;window.injectedFailures++;throw new DOMException('injected readonly failure','UnknownError');}
    if(window.injectedFailures)window.readsAfterFailure++;
   }
   return original.apply(this,args);
  };
 });
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(URL_,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>document.querySelector('#nodeChip')?.textContent.includes('已连接'),null,{timeout:45000});
 return {browser,ctx,page,errors};
}
test('a poll refresh storage-read failure is caught and later refreshes recover',async()=>{
 const {browser,page,errors}=await fixture();
 try {
  await page.evaluate(()=>window.failRead=true);
  await page.waitForFunction(()=>window.injectedFailures===1&&window.readsAfterFailure>0,null,{timeout:20000});
  await page.locator('#settingsBtn').click();await page.locator('#modal details summary').click();
  assert.match(await page.locator('#modal .log').innerText(),/后台刷新未完成/);
  assert.deepEqual(await page.evaluate(()=>window.unhandled),[]);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('invalid node configuration stays editable and does not overwrite saved settings',async()=>{
 const {browser,page,errors}=await fixture();
 try {
  const before=await page.evaluate(()=>localStorage.getItem('kaswin-rolling-tn10:nodes'));
  await page.locator('#settingsBtn').click();await page.locator('#sNodes').fill('https://invalid.example.test');
  await page.locator('[data-act="applyConn"]').click();
  await page.waitForFunction(()=>document.querySelector('#sErr')?.textContent.length>0);
  assert.equal(await page.locator('#modal').evaluate(e=>e.open),true);
  assert.equal(await page.locator('#sNodes').inputValue(),'https://invalid.example.test');
  assert.equal(await page.evaluate(()=>localStorage.getItem('kaswin-rolling-tn10:nodes')),before);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('theme changes propagate to a second real tab',async()=>{
 const {browser,ctx,page,errors}=await fixture();
 try {
  const second=await ctx.newPage();await second.goto(URL_,{waitUntil:'networkidle'});
  const initial=await page.evaluate(()=>document.documentElement.dataset.theme);
  await page.locator('#themeBtn').click();
  await second.waitForFunction(initial=>document.documentElement.dataset.theme!==initial,initial);
  assert.equal(await second.evaluate(()=>document.documentElement.dataset.theme),await page.evaluate(()=>document.documentElement.dataset.theme));
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
