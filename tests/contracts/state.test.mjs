import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,encode,decode,phase,managerValue,frozenValue,mergeTail,DEPOSIT,validate} from './state.mjs';
const KEY='11'.repeat(32),HASH='22'.repeat(32);
const config={ticketPrice:100000000n,ticketCap:10000000,minTickets:3,closeEligibleDaa:123456n};
const records=n=>Array.from({length:n},(_,i)=>({end:i+1,key:KEY}));
const manager=(n,local,module='sales',extra={})=>phase(initial(KEY,config),module,{
  indices:Array.from({length:n},(_,i)=>({hash:HASH,end:256*(i+1)})),records:records(local),...extra});
// Pure codec/arithmetic checks only; not a VM or acceptance test. Run record: VALIDATION.md.
test('canonical 59-byte genesis header has no legacy phase/count fields',()=>{
  const raw=encode(initial(KEY,config));assert.equal(raw.length,59);assert.equal(raw[0],1);
  assert.deepEqual([...raw.slice(33,41)],[0,225,245,5,0,0,0,0]);
  assert.deepEqual([...raw.slice(57,59)],[0,0]);assert.deepEqual(decode('sales',raw),initial(KEY,config));
});
test('N=256 uses two bytes and represents 65536 purchases with an empty manager',()=>{
  const s=manager(256,0),raw=encode(s);assert.deepEqual([...raw.slice(57,59)],[0,1]);
  assert.equal(decode('sales',raw).indices.length*256,65536);assert.equal(raw.length,9275);
  assert.throws(()=>validate({...s,records:records(1)}));
});
test('max manager is 255 indices plus 255 records; all header offsets differ',()=>{
  assert.equal(encode(manager(255,255)).length,18419);
  assert.equal(encode(manager(255,255,'win',{winnerKey:KEY,p:0})).length,18453);
  assert.equal(encode(manager(255,255,'refund',{r:0,c:0})).length,18423);
});
test('reject truncated partitions, zero ticket increments and N reinterpretation',()=>{
  const raw=encode(manager(1,2));assert.throws(()=>decode('sales',raw.slice(0,-1)));
  const bad=raw.slice();bad[57]=2;assert.throws(()=>decode('sales',bad));
  assert.throws(()=>validate(manager(0,1,'sales',{records:[{end:0,key:KEY}]})));
  assert.throws(()=>validate(manager(0,2,'sales',{records:[{end:2,key:KEY},{end:2,key:KEY}]})));
});
test('r/c distinguish partially refunded old shard from manager own balance',()=>{
  const s=manager(2,40,'refund',{r:0,c:32});
  assert.equal(managerValue(s),4400000000n);
  assert.equal(frozenValue(s,0,records(256)),22400000000n);
  assert.equal(frozenValue(s,1,records(256)),25600000000n);
  const own={...s,r:2};assert.equal(managerValue(own),DEPOSIT+800000000n);
  assert.throws(()=>validate({...s,c:256}));assert.throws(()=>validate({...s,c:1}));
});
test('WIN stores the cursor at byte 91 and rejects the old ticket-bearing layout',()=>{
  const s=manager(2,3,'win',{winnerKey:KEY,p:1}),raw=encode(s);
  assert.deepEqual([...raw.slice(91,93)],[1,0]);assert.equal(raw.length,93+36*5);
  assert.deepEqual(decode('win',raw),s);assert.equal(Object.hasOwn(decode('win',raw),'ticket'),false);
  const legacy=new Uint8Array(raw.length+4);legacy.set(raw.slice(0,91));legacy.set(raw.slice(91),95);
  assert.throws(()=>decode('win',legacy));assert.throws(()=>encode({...s,ticket:0}));
});
test('tail merge uses original sompi value, includes empty tails and excludes exactly 3 KAS',()=>{
  assert.equal(mergeTail(manager(1,0)),true);assert.equal(mergeTail(manager(1,2)),true);
  assert.equal(mergeTail(manager(1,3)),false);assert.equal(mergeTail(manager(0,2)),false);
  for(const [price,expected] of [[299999999n,true],[300000000n,false],[300000001n,false]])
    assert.equal(mergeTail(manager(1,1,'sales',{ticketPrice:price})),expected);
  assert.equal(mergeTail(manager(1,2,'sales',{ticketPrice:149999999n})),true);
  assert.equal(mergeTail(manager(1,2,'sales',{ticketPrice:150000000n})),false);
});
test('merged tails cannot leave a live p=N or r=N manager',()=>{
  for(const local of [0,1,2]) {
    assert.throws(()=>manager(1,local,'win',{winnerKey:KEY,p:1}));
    assert.throws(()=>manager(1,local,'refund',{r:1,c:0}));
  }
  assert.doesNotThrow(()=>manager(1,3,'win',{winnerKey:KEY,p:1}));
  assert.doesNotThrow(()=>manager(1,3,'refund',{r:1,c:0}));
  assert.throws(()=>manager(0,0,'refund',{r:0,c:0}));
});
test('a small remaining refund balance does not change the original merge decision',()=>{
  const s=manager(1,33,'refund',{r:1,c:32});
  assert.equal(managerValue(s),DEPOSIT+100000000n);assert.equal(mergeTail(s),false);
});
test('10M-ticket and total-value boundaries stay in exact integers',()=>{
  const s=initial(KEY,{...config,ticketPrice:899999960n});assert.doesNotThrow(()=>validate(s));
  assert.throws(()=>initial(KEY,{...config,ticketPrice:899999961n}));
  const big=phase(s,'sales',{records:[{end:10000000,key:KEY}]});
  assert.equal(managerValue(big),9000000000000000n);
  assert.throws(()=>validate({...big,records:[{end:10000001,key:KEY}]}));
});
