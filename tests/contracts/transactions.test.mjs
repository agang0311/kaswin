import test from 'node:test';
import assert from 'node:assert/strict';
import {p2pk,p2sh} from '../../scripts/core/lib/covenant-id.js';
import {cat,hex,le,unhex} from '../../scripts/core/lib/bytes.js';
import {pushBytes, pushInt} from '../../scripts/core/lib/script.js';
import * as S from './state.mjs';
import {COMPILER_COMMIT,profileId,templateHash,redeem,rootId,scriptHash} from './profile.mjs';
import {ACTION,buildAction} from './transactions.mjs';
import {interpretAccepted} from './accepted.mjs';

// Pure JS policy/encoding regression fixtures only. Run record: VALIDATION.md.
// The short tails below are deliberately synthetic: no compiled artifact, VM success,
// budget measurement, signature, block inclusion or node acceptance is claimed.
const OWNER='11'.repeat(32),BUYER='22'.repeat(32),WINNER='33'.repeat(32),ACTOR='44'.repeat(32);
const id=n=>BigInt(n).toString(16).padStart(64,'0');
const frames=Object.fromEntries(S.MODULES.map((module,i)=>{
  const tail=Uint8Array.of(0x6c,0x51+i,0x75);
  return [module,{tail,templateHash:templateHash(tail),dispatchTag:(i+1).toString(16).padStart(8,'0'),sourceSha256:id(i+1)}];
}));
const profile={frames,id:profileId(frames),compilerCommit:COMPILER_COMMIT,status:'UNVALIDATED'};
const config={ticketPrice:100000000n,ticketCap:10000000,minTickets:3,closeEligibleDaa:1000n};
const records=n=>Array.from({length:n},(_,i)=>({end:i+1,key:BUYER}));
function fixture({module='win',n=1,local=0,price=config.ticketPrice,p=0,r=0,c=0,localRecords=records(local)}={}) {
  const shard={module:'frozen',records:records(256)},hash=scriptHash(shard,profile);
  const s=S.phase(S.initial(OWNER,{...config,ticketPrice:price}),module,{
    indices:Array.from({length:n},(_,i)=>({hash,end:256*(i+1)})),records:localRecords,
    ...(module==='win'?{winnerKey:WINNER,p}:module==='refund'?{r,c}:{})});
  const origin={transactionId:id(5000),index:0},cid=rootId(origin,s,profile);
  const manager={outpoint:{transactionId:id(6000),index:0},cid,origin,spk:p2sh(scriptHash(s,profile)),
    value:S.managerValue(s),redeemScript:redeem(s,profile),utxoDaa:2000n,currentDaa:500000n};
  const targets=Array.from({length:n},(_,j)=>({outpoint:{transactionId:id(7000+j),index:1},cid,
    spk:p2sh(hash),value:S.frozenValue(s,j,shard.records),redeemScript:redeem(shard,profile),utxoDaa:1000n}));
  return {s,manager,targets};
}
function build(f,action,{targets=[],fee=100000000n,funds=[]}={}) {
  return buildAction(f.manager,profile,{action,actorKey:ACTOR},{targets,funds,fee,budgets:Array(1+targets.length+funds.length).fill(0)});
}
function interpreted(f,d,targets=[],funds=[]) {
  return interpretAccepted({manager:f.manager,targets,funds,transaction:d.transaction},profile);
}
const valueSum=outs=>outs.reduce((n,o)=>n+o.value,0n);

test('last PAY_OLD handles 1 or 16 shards with empty, one-record and two-record tails',()=>{
  for(const n of [1,16])for(const local of [0,1,2]) {
    const f=fixture({n,local}),d=build(f,'PAY_OLD',{targets:f.targets});
    assert.equal(d.transaction.inputs.length,n+1);assert.deepEqual(d.authorizedInputIndices,[]);
    assert.deepEqual(d.roles,['WINNER','CREATOR','EXECUTOR']);assert.equal(d.transition.next,null);
    assert.equal(d.transition.terminal,'PAID');assert.ok(d.transaction.outputs.every(o=>o.covenant===null));
    assert.equal(d.transaction.outputs[0].value,BigInt(256*n+local-n-1)*100000000n);
    assert.equal(d.transaction.outputs[1].value,S.DEPOSIT);assert.equal(d.transaction.outputs[2].value,BigInt(n)*S.REWARD);
    assert.equal(valueSum(d.transaction.outputs)+d.fee,f.manager.value+f.targets.reduce((v,t)=>v+t.value,0n));
    assert.equal(interpreted(f,d,f.targets).terminal,'PAID');
  }
});
test('a nonfinal batch preserves the tail and deposit while advancing only old shards',()=>{
  const f=fixture({n:2,local:2}),d=build(f,'PAY_OLD',{targets:[f.targets[0]]});
  assert.equal(d.transition.next.p,1);assert.equal(d.transition.terminal,null);
  assert.deepEqual(d.roles,['MANAGER','WINNER','EXECUTOR']);
  assert.equal(d.transaction.outputs[0].value,f.manager.value);
  assert.deepEqual(d.transition.next.records,f.s.records);
});
test('exactly 3 KAS stays for PAY_SELF, even if it is just one purchased ticket',()=>{
  for(const [local,price] of [[3,100000000n],[1,300000000n]]) {
    const f=fixture({local,price}),old=build(f,'PAY_OLD',{targets:f.targets});
    assert.equal(old.transition.next.p,1);assert.equal(old.transition.terminal,null);
    const own=fixture({local,price,p:1}),d=build(own,'PAY_SELF');
    assert.equal(d.transaction.outputs[0].value,100000000n);
    assert.equal(d.transaction.outputs[1].value,S.DEPOSIT);assert.equal(d.transition.terminal,'PAID');
  }
  assert.equal(build(fixture({n:0,local:3}),'PAY_SELF').transition.terminal,'PAID');
});
test('final REFUND_OLD pays 32+m buyers and the full deposit in 34/35/36 outputs',()=>{
  for(const local of [0,1,2]) {
    const f=fixture({module:'refund',local,c:224}),d=build(f,'REFUND_OLD',{targets:f.targets,fee:50000000n});
    assert.equal(d.transaction.outputs.length,34+local);assert.equal(d.transition.next,null);
    assert.equal(d.transition.terminal,'REFUNDED');assert.deepEqual(d.authorizedInputIndices,[]);
    assert.ok(d.transaction.outputs.every(o=>o.covenant===null));
    for(let i=0;i<32+local;i++) {
      assert.equal(d.roles[i],'BUYER_REFUND');assert.equal(d.transaction.outputs[i].value,98000000n);
      assert.deepEqual(d.transaction.outputs[i].scriptPublicKey,p2pk(BUYER));
    }
    assert.equal(d.transaction.outputs[32+local].value,S.DEPOSIT);
    assert.equal(d.transaction.outputs[33+local].value,BigInt(32+local)*S.REFUND_FEE-50000000n);
    assert.equal(valueSum(d.transaction.outputs)+d.fee,f.manager.value+f.targets[0].value);
    assert.equal(interpreted(f,d,f.targets).terminal,'REFUNDED');
  }
});
test('merged refund fees count purchase records, not tickets',()=>{
  const f=fixture({module:'refund',c:224,localRecords:[{end:2,key:BUYER}]}),d=build(f,'REFUND_OLD',{targets:f.targets,fee:50000000n});
  assert.equal(d.transaction.outputs.length,35);assert.equal(d.transaction.outputs[32].value,198000000n);
  assert.equal(d.transaction.outputs[34].value,16000000n);
});
test('old refund nonterminal layouts retain the manager and advance c or r',()=>{
  const partial=fixture({module:'refund',local:2,c:0}),a=build(partial,'REFUND_OLD',{targets:partial.targets,fee:50000000n});
  assert.equal(a.transaction.outputs.length,35);assert.equal(a.transition.next.c,32);
  assert.equal(a.transaction.outputs[0].value,partial.manager.value);
  assert.equal(a.transaction.outputs[1].value,22400000000n);
  const more=fixture({module:'refund',n:2,local:2,c:224}),b=build(more,'REFUND_OLD',{targets:[more.targets[0]],fee:50000000n});
  assert.equal(b.transaction.outputs.length,34);assert.equal(b.transition.next.r,1);assert.equal(b.transition.next.c,0);
  assert.equal(b.transaction.outputs[0].value,more.manager.value);
});
test('nonmerged own refund keeps the original decision after only 1 KAS remains',()=>{
  const f=fixture({module:'refund',local:33,r:1,c:32});assert.equal(S.mergeTail(f.s),false);
  const funds=[{outpoint:{transactionId:id(8000),index:0},value:2000000n,spk:p2pk(ACTOR),utxoDaa:0n}];
  const d=build(f,'REFUND_SELF',{fee:5000000n,funds});
  assert.deepEqual(d.authorizedInputIndices,[1]);assert.equal(d.transaction.outputs[0].value,98000000n);
  assert.equal(d.transaction.outputs[1].value,398000000n);assert.equal(d.transaction.outputs[2].value,1000000n);
  assert.equal(interpreted(f,d,[],funds).terminal,'REFUNDED');
});
test('retired actions cannot be built or decoded as a current action',()=>{
  const f=fixture({local:1});
  for(const name of ['MERGE_TAIL','EMPTY_EXIT']) {
    assert.equal(Object.hasOwn(ACTION,name),false);
    assert.throws(()=>build(f,name),e=>e.code==='ACTION');
  }
  const valid=build(f,'PAY_OLD',{targets:f.targets}),frame=profile.frames.win;
  for(const action of [22n,23n]) {
    const tx=structuredClone(valid.transaction);
    tx.inputs[0].signatureScript=hex(cat(pushInt(action),pushInt(BigInt(frame.tail.length)),
      pushBytes(le(BigInt(f.targets[0].redeemScript.length),4)),pushBytes(unhex(frame.dispatchTag)),pushBytes(f.manager.redeemScript)));
    assert.throws(()=>interpretAccepted({manager:f.manager,targets:f.targets,transaction:tx},profile),e=>e.code==='UNSUPPORTED_ACTION');
  }
});
test('the interpreter rejects a hidden successor, reduced tail refund, or skimmed deposit',()=>{
  const f=fixture({module:'refund',local:2,c:224}),d=build(f,'REFUND_OLD',{targets:f.targets,fee:10000000n});
  for(const index of [32,34]) {
    const tx=structuredClone(d.transaction);tx.outputs[index].value-=1n;tx.outputs[35].value+=1n;
    assert.throws(()=>interpretAccepted({manager:f.manager,targets:f.targets,transaction:tx},profile),e=>e.code==='OUTPUT_EFFECTS');
  }
  const tx=structuredClone(d.transaction);tx.outputs[0].covenant={covenantId:f.manager.cid,authorizingInput:0};
  assert.throws(()=>interpretAccepted({manager:f.manager,targets:f.targets,transaction:tx},profile),e=>e.code==='OUTPUT_EFFECTS');
});
