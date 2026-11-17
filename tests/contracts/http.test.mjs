import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequestHandler} from '../../scripts/indexer/http.mjs';
async function host(t,indexer,opts) {
 const server=createServer(createRequestHandler(indexer,opts));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return `http://127.0.0.1:${server.address().port}/v1/rolling/${indexer.network}/${indexer.profile.id}/`;
}
const indexer=request=>({network:'aa'.repeat(32),profile:{id:'bb'.repeat(32)},request});
test('HTTP rejects unauthenticated uploads before entering the indexer',async t=>{
 let calls=0;const base=await host(t,indexer(async()=>{calls++;return {status:200,body:{}};}));
 const r=await fetch(base+'preimages/'+'cc'.repeat(32),{method:'PUT',headers:{'content-type':'application/json'},body:'{"redeemScript":"00"}'});
 assert.equal(r.status,403);assert.equal(calls,0);
});
test('HTTP domain isolation and oversize upload fail closed',async t=>{
 let calls=0;const base=await host(t,indexer(async()=>{calls++;return {status:200,body:{}};}),{authorizeUpload:()=>true});
 assert.equal((await fetch(base.replace('bb'.repeat(32),'dd'.repeat(32))+'rounds/x')).status,404);
 const r=await fetch(base+'preimages/'+'cc'.repeat(32),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({redeemScript:'00'.repeat(260000)})});
 assert.equal(r.status,413);assert.equal(calls,0);
});
test('HTTP exports a complete NDJSON stream and hides internal error text',async t=>{
 const base=await host(t,indexer(async(_method,path)=>{
  if(path==='broken')throw new Error('private-filesystem-location');
  return {status:200,stream:(async function*(){yield {type:'round'};yield {type:'end',events:0,preimages:0};})()};
 }));
 const stream=await fetch(base+'export');assert.equal(stream.headers.get('content-type'),'application/x-ndjson; charset=utf-8');
 assert.deepEqual((await stream.text()).trim().split('\n').map(JSON.parse),[{type:'round'},{type:'end',events:0,preimages:0}]);
 const error=await fetch(base+'broken');assert.equal(error.status,500);assert.deepEqual(await error.json(),{error:'REQUEST_FAILED'});
});
