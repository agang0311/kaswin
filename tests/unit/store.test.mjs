import test from 'node:test';
import assert from 'node:assert/strict';
import {RoundStore,MemoryStore,sanitizeDiscoveredRounds} from '../../scripts/store/round-store.mjs';
const pending=()=>({status:'PREPARED',draft:{transaction:{inputs:[{previousOutpoint:{transactionId:'ab'.repeat(32),index:0}}]}}});
test('two existing rounds cannot reserve the same funding input, even from concurrently prepared drafts',async()=>{
 const store=new RoundStore(new MemoryStore()),a={cid:'11'.repeat(32),intent:null},b={cid:'22'.repeat(32),intent:null};
 await store.create(a);await store.create(b);
 const results=await Promise.allSettled([store.replace({...a,intent:pending()},0),store.replace({...b,intent:pending()},0)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/INPUT_RESERVED/);
 assert.equal((await store.list()).filter(r=>r.round.intent).length,1);
});

test('discovery cache persists per genesis/profile namespace, sanitizes entries, and never leaks into round list or reservations',async()=>{
 const rawStore=new MemoryStore();
 const tn10Store=new RoundStore(rawStore,{genesis:'11'.repeat(32),profileId:'aa'.repeat(32)});
 const mainStore=new RoundStore(rawStore,{genesis:'22'.repeat(32),profileId:'aa'.repeat(32)});
 await tn10Store.create({cid:'33'.repeat(32),intent:pending()});
 await tn10Store.writeDiscovery({
  rounds:[
   {cid:'44'.repeat(32),terminal:'PAID',module:'win',tickets:10,bought:10,buys:1,managerValue:'0',acceptingDaa:'595020946',updatedAt:1794922732461},
   {cid:'bad-cid',terminal:'PAID'},
   null,
  ],
  origin:'indexer',
  base:'https://cd311.cn:888/indexer/mainnet',
  savedAt:123456,
 });
 const restored=await tn10Store.readDiscovery();
 assert.equal(restored?.savedAt,123456);
 assert.equal(restored?.origin,'indexer');
 assert.equal(restored?.rounds.length,1);
 assert.equal(restored?.rounds[0].cid,'44'.repeat(32));
 assert.equal(restored?.rounds[0].terminal,'PAID');
 // Isolated by genesis
 assert.equal(await mainStore.readDiscovery(),null);
 // Never appears in roundStore.list() or interferes with reserved()
 assert.deepEqual((await tn10Store.list()).map(x=>x.round.cid),['33'.repeat(32)]);
 assert.equal((await tn10Store.reserved()).has('ab'.repeat(32)+':0'),true);
 assert.equal(sanitizeDiscoveredRounds([{cid:'55'.repeat(32),tickets:-1,managerValue:'not-uint'}])[0].tickets,undefined);
 assert.equal(sanitizeDiscoveredRounds([{cid:'55'.repeat(32),managerValue:'not-uint'}])[0].managerValue,null);

 // Preview cache is isolated from round/ and discovery, and cleaned up on removePreview
 await tn10Store.savePreview('66'.repeat(32),'sample-round-text');
 assert.equal(await tn10Store.getPreview('66'.repeat(32)),'sample-round-text');
 assert.equal(await mainStore.getPreview('66'.repeat(32)),null);
 assert.deepEqual((await tn10Store.list()).map(x=>x.round.cid),['33'.repeat(32)]);
 await tn10Store.removePreview('66'.repeat(32));
 assert.equal(await tn10Store.getPreview('66'.repeat(32)),null);
});
