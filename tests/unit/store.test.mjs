import test from 'node:test';
import assert from 'node:assert/strict';
import {RoundStore,MemoryStore} from '../../scripts/store/round-store.mjs';
const pending=()=>({status:'PREPARED',draft:{transaction:{inputs:[{previousOutpoint:{transactionId:'ab'.repeat(32),index:0}}]}}});
test('two existing rounds cannot reserve the same funding input, even from concurrently prepared drafts',async()=>{
 const store=new RoundStore(new MemoryStore()),a={cid:'11'.repeat(32),intent:null},b={cid:'22'.repeat(32),intent:null};
 await store.create(a);await store.create(b);
 const results=await Promise.allSettled([store.replace({...a,intent:pending()},0),store.replace({...b,intent:pending()},0)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/INPUT_RESERVED/);
 assert.equal((await store.list()).filter(r=>r.round.intent).length,1);
});
