// Real native IndexedDB across two tabs. Synthetic records; no network/wallet/SDK.
import {chromium} from 'playwright';
import {build} from 'esbuild';
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const bundle=await build({absWorkingDir:repo,stdin:{resolveDir:repo,contents:"export {IndexedStore} from './packages/f3.2-core/lib/persistence.js'; export {persistIntent,reservedInputs} from './apps/kaswin-v2/scripts/shared/reservations.mjs';"},bundle:true,write:false,format:'iife',globalName:'TestStore',platform:'browser'});
const server=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html'});r.end('<!doctype html><title>IDB regression</title>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch();let report;
try {
 const ctx=await browser.newContext(),pages=await Promise.all([ctx.newPage(),ctx.newPage()]);
 for(const page of pages){await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addScriptTag({content:bundle.outputFiles[0].text});}
 const results=await Promise.all(pages.map((page,i)=>page.evaluate(async i=>{
  const db=await TestStore.IndexedStore.open('isolated-native-idb-test'),network='11'.repeat(32),profile=(i?'22':'33').repeat(32),txid=(i?'44':'55').repeat(32);
  try{await TestStore.persistIntent(db,network,`${network}/${profile}/tx/${txid}`,{txid,status:'SUBMITTING',inputs:[{transactionId:'66'.repeat(32),index:0}]});return 'INSERTED';}catch(e){return e.message;}finally{db.close();}
 },i)));
 assert.deepEqual([...results].sort(),['INPUT_ALREADY_RESERVED','INSERTED'].sort());
 await pages[0].reload();await pages[0].addScriptTag({content:bundle.outputFiles[0].text});
 const retained=await pages[0].evaluate(async()=>{const db=await TestStore.IndexedStore.open('isolated-native-idb-test');const rows=await db.list('');await db.compareAndSet(rows[0].key,rows[0].record.revision,{...rows[0].record.value,status:'UNKNOWN',createdAt:0});const n=(await TestStore.reservedInputs(db,'11'.repeat(32))).size;db.close();return n;});
 assert.equal(retained,1);report={at:new Date().toISOString(),scope:'REAL_CHROMIUM_NATIVE_IDB_SYNTHETIC_RECORDS_NO_CHAIN',results,unknownReservationsAfterReload:retained};
}finally{await browser.close();server.close();}
await fs.writeFile(new URL('../test-results/native-idb-report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(report);
