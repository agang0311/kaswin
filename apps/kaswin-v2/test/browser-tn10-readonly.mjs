// Explicit --live: public GET/wRPC reads only; no provider requests, keys or submit.
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
if(process.argv[2]!=='--live')throw Error('Explicit --live required');
const html=await fs.readFile(new URL('../../../releases/kaswin-v2/index.html',import.meta.url));
const server=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html'});r.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch();let report;
try{
 const page=await browser.newPage();const errors=[],sent=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('websocket',ws=>ws.on('framesent',({payload})=>sent.push(String(payload))));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForSelector('.hero');
 const hasKasware=await page.evaluate(()=>typeof window.kasware!=='undefined');
 await page.click('#nodeChip');await page.waitForFunction(()=>document.querySelector('#nodeChip .dot')?.classList.contains('ok'),null,{timeout:45000});
 const node=await page.locator('#nodeChip').getAttribute('title');
 const idx=await page.evaluate(async()=>{const r=await fetch('https://tn10.kaspay.top/indexer/v1/rounds?limit=200',{credentials:'omit'});if(!r.ok)throw Error(`INDEXER_HTTP_${r.status}`);return r.json();});
 const contracts={};for(const row of idx.items)contracts[row.contract]=(contracts[row.contract]??0)+1;
 assert.equal(idx.network,'testnet-10');assert.equal(sent.some(s=>s.includes('submitTransaction')),false);assert.deepEqual(errors,[]);
 report={at:new Date().toISOString(),artifactSha256:createHash('sha256').update(html).digest('hex'),scope:'REAL_TN10_READONLY_BROWSER_NO_WALLET_SIGN_OR_SUBMIT',node,indexerContracts:contracts,discoveryCoverage:idx.discoveryCoverage,newProfileRows:idx.items.filter(r=>r.contract==='kaswin-v2@7aaf76fe5e218007').length,kaswareProviderPresent:hasKasware,realWalletE2e:hasKasware?'NOT_RUN':'BLOCKED_NO_EXTENSION_IN_AUTOMATION_CONTEXT',errors};
}finally{await browser.close();server.close();}
await fs.writeFile(new URL('../test-results/tn10-readonly-report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
