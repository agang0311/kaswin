import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileArchive} from './archive.mjs';
// Storage-only fixtures. No transaction acceptance is claimed or simulated as evidence.
// Run record: VALIDATION.md.
const net='11'.repeat(32),profile='22'.repeat(32),cid='33'.repeat(32),A='44'.repeat(32),B='55'.repeat(32);
const snapshot=event=>({networkGenesis:net,profileId:profile,cid,manager:null,frozen:[],event});
async function store(t) {
  const root=await mkdtemp(join(tmpdir(),'kaswin-rolling-archive-'));t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,archive:new FileArchive(root)};
}
test('snapshot CAS rejects a stale writer and journal pages expose only committed revisions',async t=>{
  const {archive}=await store(t);
  await archive.update(net,profile,cid,'0',()=>snapshot({type:'ACCEPT',instance:A}));
  await assert.rejects(()=>archive.update(net,profile,cid,'0',()=>snapshot({type:'ACCEPT',instance:B})),e=>e.code==='REVISION_CONFLICT');
  const current=await archive.getRound(net,profile,cid);assert.equal(current.revision,'1');assert.equal(current.event,undefined);
  const events=await archive.readEvents(net,profile,cid,{offset:0,limit:100,revision:'1'});
  assert.equal(events.length,1);assert.equal(events[0].instance,A);
});
test('accept, revert, and reaccept the same instance selects the latest journal fact',async t=>{
  const {archive}=await store(t);
  await archive.update(net,profile,cid,'0',()=>snapshot({type:'ACCEPT',instance:A}));
  await archive.update(net,profile,cid,'1',()=>snapshot({type:'REVERT',reverts:A}));
  assert.equal(await archive.activeInstance(net,profile,cid,A),null);
  await archive.update(net,profile,cid,'2',()=>snapshot({type:'ACCEPT',instance:A}));
  assert.equal((await archive.activeInstance(net,profile,cid,A)).revision,'3');
});
test('an interrupted receipt update cannot hide a committed instance after its revision is reused',async t=>{
  const {root,archive}=await store(t);
  await archive.update(net,profile,cid,'0',()=>snapshot({type:'ACCEPT',instance:A}));
  const key=[net,profile,cid].join('-'),receipts=join(root,'receipts',key),journal=join(root,'journal',key);
  await mkdir(receipts,{recursive:true});await mkdir(journal,{recursive:true});
  await writeFile(join(journal,'2.json'),JSON.stringify({type:'REVERT',reverts:A,revision:'2'}));
  await writeFile(join(receipts,A+'.json'),JSON.stringify({type:'REVERT',revision:'2'}));
  assert.equal((await archive.activeInstance(net,profile,cid,A)).revision,'1');
  await archive.update(net,profile,cid,'1',()=>snapshot({type:'ACCEPT',instance:B}));
  assert.equal((await archive.activeInstance(net,profile,cid,A)).revision,'1');
  assert.equal((await archive.activeInstance(net,profile,cid,B)).revision,'2');
});
test('immutable original bytes cannot be replaced under an existing preimage key',async t=>{
  const {archive}=await store(t);
  await archive.putPreimage(net,profile,A,'0102');await archive.putPreimage(net,profile,A,'0102');
  await assert.rejects(()=>archive.putPreimage(net,profile,A,'0103'),e=>e.code==='IMMUTABLE_PREIMAGE_CONFLICT');
  assert.equal(await archive.getPreimage(net,profile,A),'0102');
});
