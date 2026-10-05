// Built V2: simulated pruned node + REST witnesses + real browser IDB. --live additionally probes
// real TN10 REST schema/CORS using a known historical txid; NOT the user's browser records or new transactions.
import fs from 'node:fs/promises';
import http from 'node:http';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {historyRecord,restDTO} from './rest-history.mjs';
import {jsonText} from '../scripts/shared/lib/json.mjs';
import {NETWORK_GENESIS,PROFILE_ID} from '../scripts/shared/core.mjs';
const html=await fs.readFile(new URL('../../../releases/kaswin-v2/index.html',import.meta.url));
const server=http.createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/html; charset=utf-8'});r.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/`,browser=await chromium.launch(),errors=[],requests=[],checks=[];
let live=null;
const english=process.argv.includes('--en'), untranslated=new Set();
async function scan(page) {
 if(!english)return;
 const words=await page.evaluate(()=>{const a=[],w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(w.nextNode()){const n=w.currentNode;if(n.parentElement.closest('script,style,textarea,[data-no-i18n]')||!n.parentElement.checkVisibility())continue;if(/[\p{Script=Han}]/u.test(n.data))a.push(n.data.trim());}return a;});
 words.forEach(s=>untranslated.add(s));
}
try {
 const ctx=await browser.newContext({locale:english?'en-US':'zh-CN',viewport:{width:390,height:844}}),page=await ctx.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket('**/*',ws=>ws.close()); // no node access or broadcasts
 await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
 const record=await historyRecord(),record2=await historyRecord('BUY2'),dto=restDTO(record);
 let mode='accept';
 await page.route('https://api-tn10.kaspa.org/transactions/**',route=>{
   requests.push({method:route.request().method(),url:route.request().url(),body:route.request().postData()});
   if(mode==='404')return route.fulfill({status:404,body:'{}',contentType:'application/json'});
   if(mode==='false')return route.fulfill({status:200,body:jsonText({...dto,is_accepted:false}),contentType:'application/json'});
   if(route.request().url().includes(record2.txid))return route.fulfill({status:200,body:jsonText({...restDTO(record2),outputs:[]}),contentType:'application/json'});
   return route.fulfill({status:200,body:jsonText(dto),contentType:'application/json'});
 });
 await page.goto(base+'#/mine');
 // Seed a public historical receipt as an UNKNOWN test fixture in this fresh browser profile.
 const encode=r=>JSON.stringify(r,(_k,v)=>typeof v==='bigint'?{$bigint:v.toString()}:v);
 await page.evaluate(async([serialized,prefix])=>{
  localStorage.setItem('kaswin-v2:configVersion','2');localStorage.setItem('kaswin-v2:nodes',JSON.stringify(['ws://localhost:1/closed']));
  const records=serialized.map(s=>JSON.parse(s,(_k,v)=>v&&typeof v==='object'&&'$bigint'in v?BigInt(v.$bigint):v));
  const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('kaswin-opus-f32',1);q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('records'))q.result.createObjectStore('records');};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');for(const r of records)tx.objectStore('records').put({revision:0,value:r},prefix+r.txid);tx.oncomplete=resolve;tx.onerror=reject;});db.close();
 },[[encode(record),encode(record2)],`${NETWORK_GENESIS}/${PROFILE_ID}/tx/`]);
 await page.reload();await page.waitForFunction(()=>document.querySelector('#mineSummary b')?.textContent==='2');
 await page.click('#checkAll');await page.waitForFunction(()=>document.querySelector('#mineSummary b')?.textContent==='1',null,{timeout:60000});
 const acceptedRow=page.locator('#mineList tbody tr').filter({hasText:/已接受 · REST|Accepted · REST/});
 assert.equal(await acceptedRow.count(),1);await acceptedRow.locator('[data-rec]').click();
 assert.match(await page.locator('#mBody').textContent(),/外部历史索引证据|external historical index evidence/);assert.match(await page.locator('#mBody').textContent(),/api-tn10.kaspa.org/);
 assert.equal(await page.locator('#arch').count(),0);checks.push('batch: REST accepted overlay removes 1 pending; mismatched outputs remain UNKNOWN');
 await scan(page);
 await page.screenshot({path:new URL(english?'../test-results/screenshots/rest-en-390.png':'../test-results/screenshots/rest-390.png',import.meta.url).pathname,fullPage:true});
 await page.click('#mClose');await page.reload();await page.waitForSelector('#mineList tbody tr');
 assert.equal(await page.locator('#mineList tbody tr').filter({hasText:/已接受 · REST|Accepted · REST/}).count(),1);checks.push('overlay persists across reload');
 const restRow=()=>page.locator('#mineList tbody tr').filter({hasText:/已接受 · REST|Accepted · REST/});
 // REST 404 later (e.g. REST's own retention) is no new information: the earlier witness stays, shown with its time.
 await restRow().locator('[data-rec]').click();mode='404';await page.click('#rec');
 await page.waitForFunction(()=>/(最近一次 REST 查询|Latest REST query)[\s\S]*(未找到|Not found)/.test(document.querySelector('#mBody')?.textContent??''),null,{timeout:60000});
 assert.match(await page.locator('#mBody .badge').first().textContent(),/已接受 · REST|Accepted · REST/);assert.match(await page.locator('#mBody').textContent(),/首次观察|First observed/);
 await scan(page);
 checks.push('single recheck: REST 404 keeps the earlier witness (no new information), still never releases/resubmits');
 // REST now says NOT accepted: the claim is withdrawn, record returns to UNKNOWN (never "rejected").
 await page.click('#mClose');mode='false';await restRow().locator('[data-rec]').click();await page.click('#rec');
 await page.waitForFunction(()=>/结果未知|Unknown result/.test(document.querySelector('#mBody .badge')?.textContent??''),null,{timeout:60000});
 assert.match(await page.locator('#mBody').textContent(),/报告未接受|Reports not accepted/); await scan(page);checks.push('REST is_accepted=false withdraws the witness -> UNKNOWN, not rejected');
 await page.click('#mClose');await page.waitForFunction(()=>document.querySelector('#mineSummary b')?.textContent==='2');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.ok(requests.length>=3);assert.ok(requests.every(r=>r.method==='GET'&&r.body===null));
 if(process.argv.includes('--live')){
  const c=await browser.newContext(),p=await c.newPage();
  // Separate context: no fake KasWare, no stored transactions, no node access. Only public REST GET.
  await p.route('**/*',r=>r.request().url().startsWith(base)||r.request().url().startsWith('https://api-tn10.kaspa.org/transactions/')?r.continue():r.abort());
  await p.routeWebSocket('**/*',ws=>ws.close());await p.goto(base);
  live=await p.evaluate(async()=>{const id='6f09604b1dcf720095041451f68486705432c5bc7723a5e82ddd8cf2cb1cae0c',url=`https://api-tn10.kaspa.org/transactions/${id}?inputs=true&outputs=true`;
   const r=await fetch(url,{method:'GET',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)}),d=await r.json();
   return {url,status:r.status,transactionId:d.transaction_id,isAccepted:d.is_accepted,accepting:d.accepting_block_hash,inputs:d.inputs?.length,outputs:d.outputs?.length,scope:'real REST browser CORS/schema/acceptance flag only; no independent local draft of this tx in this test'};});
  assert.equal(live.status,200);assert.equal(live.isAccepted,true);assert.equal(live.transactionId,'6f09604b1dcf720095041451f68486705432c5bc7723a5e82ddd8cf2cb1cae0c');await c.close();
 }
} finally {await browser.close();server.close();}
const report={at:new Date().toISOString(),sha256:createHash('sha256').update(html).digest('hex'),scope:'simulated pruning/REST with public historical signed receipt; real Chromium IDB; no real signing or submit',checks,requests,live,errors,language:english?'en':'zh-CN',untranslated:[...untranslated]};
await fs.writeFile(new URL(english?'../test-results/rest-browser-en-report.json':'../test-results/rest-browser-report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));assert.deepEqual(errors,[]);if(!process.argv.includes('--inventory'))assert.deepEqual([...untranslated],[]);
