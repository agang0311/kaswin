import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,fund,profile,PRICE,FEE,rootId} from '../contracts/fixtures.mjs';
import {TN10_ROLLING_REGISTRY} from '../../scripts/contract/protocol.mjs';
import {buildAction,buildGenesis} from '../contracts/transactions.mjs';
import * as S from '../contracts/state.mjs';
import {openMemoryWallet} from '../../scripts/wallet/wallet.mjs';
import {emptyRound,advanceRound,availableActions,describeRound,shardCatalog,roundToText,roundFromText,validateRound,interpretGenesis,ROUND_VERSION} from '../../scripts/round/round.mjs';
import {encodeTagged,decodeTagged} from '../../scripts/store/codec.mjs';
import {profileFromData,profileToData} from '../../scripts/contract/profile-data.mjs';
import {MemoryStore,RoundStore} from '../../scripts/store/round-store.mjs';
import {parseTkas,formatTkas,parseUint} from '../../web/ui/format.mjs';
import {TN10_PROFILE_ID} from '../../scripts/contract/protocol.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {redeem,scriptHash} from '../contracts/profile.mjs';
import {p2sh} from '../../scripts/core/lib/covenant-id.js';

const w=openMemoryWallet(createHash('sha256').update('rolling-tn10-round-test-key').digest('hex'));
const nodeTx=d=>structuredClone(d.transaction);
const record=(f,{source='local'}={})=>({...emptyRound({cid:f.manager.cid,origin:f.manager.origin,
  settings:{ticketPrice:f.s.ticketPrice,ticketCap:f.s.ticketCap,minTickets:f.s.minTickets,closeEligibleDaa:f.s.closeEligibleDaa},source}),
  manager:{...f.manager,daa:f.manager.utxoDaa,covenantId:f.manager.cid},frozen:f.targets.map(t=>({...t,covenantId:t.cid,daa:t.utxoDaa,origin:f.manager.origin})),accepting:'ab'.repeat(32)});
test('amount parsing is exact decimal and strict',()=>{
  assert.equal(parseTkas('1'),100000000n);assert.equal(parseTkas('0.00000001'),1n);assert.equal(parseTkas('123.456'),12345600000n);
  for(const bad of ['1e3','-1','1.','.5','1.000000001','1,5',' 0x1','Infinity','01'])assert.throws(()=>parseTkas(bad),/AMOUNT_FORMAT/);
  assert.equal(formatTkas(123456789n),'1.23456789');assert.equal(formatTkas(100000000n),'1');
  assert.throws(()=>parseUint('1.5'));assert.equal(parseUint('600'),600n);
});
test('profile is re-derived from inlined frames and rejects any alteration',()=>{
  const data=profileToData(profile),p=profileFromData(JSON.parse(JSON.stringify(data)));
  assert.equal(p.id,TN10_PROFILE_ID);assert.equal(p.status,'UNVALIDATED');
  const t=JSON.parse(JSON.stringify(data));t.frames.sales.tail=t.frames.sales.tail.slice(0,-2)+'00';assert.throws(()=>profileFromData(t));
  const u=JSON.parse(JSON.stringify(data));u.id='11'.repeat(32);assert.throws(()=>profileFromData(u),/PROFILE_DATA/);
  const v=JSON.parse(JSON.stringify(data));v.frames.win.dispatchTag='00000000';assert.throws(()=>profileFromData(v));
});
test('tagged codec is lossless for bigint/bytes and rejects malformed tags',()=>{
  const v={a:123456789012345678901234n,b:Uint8Array.of(1,2,255),c:[{d:0n}]};
  assert.deepEqual(decodeTagged(encodeTagged(v)),v);
  assert.throws(()=>decodeTagged('{"a":{"$bigint":"-1"}}'),/STATE_BIGINT/);assert.throws(()=>decodeTagged('{"a":{"$bytes":"zz"}}'));
  assert.throws(()=>decodeTagged('x'.repeat(13_000_000)),/STATE_TEXT_SIZE/);
});
test('export/import round trip is data only: marked imported, offline-validated, tampering rejected',()=>{
  const f=fixture({module:'win',cnt:2,local:3,p:0}),r=record(f);
  const back=roundFromText(roundToText(r),profile);
  assert.equal(back.source,'imported');assert.equal(back.cid,r.cid);assert.equal(back.frozen.length,2);assert.deepEqual(back.manager.redeemScript,r.manager.redeemScript);
  const doc=decodeTagged(roundToText(r));
  const mut=fn=>{const x=structuredClone(doc);fn(x);return encodeTagged(x);};
  assert.throws(()=>roundFromText(mut(x=>{x.network='mainnet';}),profile),/ROUND_SCOPE/);
  assert.throws(()=>roundFromText(mut(x=>{x.profileId='11'.repeat(32);}),profile),/ROUND_SCOPE/);
  assert.throws(()=>roundFromText(mut(x=>{x.cid='11'.repeat(32);}),profile));
  assert.throws(()=>roundFromText(mut(x=>{x.manager.value+=1n;}),profile),/MANAGER_VALUE/);
  assert.throws(()=>roundFromText(mut(x=>{x.frozen[0].redeemScript=x.frozen[1].redeemScript;}),profile),/FROZEN_/);
  assert.throws(()=>roundFromText(mut(x=>{x.frozen[0].spk.script='aa20'+'00'.repeat(32)+'87';}),profile),/FROZEN_HASH/);
  assert.throws(()=>roundFromText(mut(x=>{x.manager.redeemScript[5]^=1;}),profile));
  assert.throws(()=>roundFromText('{"v":1}',profile));
  // receipts are rendered later (feeSompi as a bigint): a malformed one is refused at import
  const rc=(over={})=>({txid:'cd'.repeat(32),action:'BUY',feeSompi:'1000',finalized:true,...over});
  assert.equal(roundFromText(mut(x=>{x.receipts=[rc()];}),profile).receipts.length,1);
  for(const bad of [{feeSompi:'x'},{feeSompi:'-1'},{feeSompi:1000},{feeSompi:'1'.repeat(20)},{finalized:'yes'}])
    assert.throws(()=>roundFromText(mut(x=>{x.receipts=[rc(bad)];}),profile),/ROUND_RECEIPTS/,JSON.stringify(bad));
  // a pending candidate must carry a structurally complete intent: matching txid alone is not enough
  assert.throws(()=>roundFromText(mut(x=>{x.receipts=[rc({finalized:false})];x.pending=[{txid:'cd'.repeat(32),acceptingBlock:'ab'.repeat(32),acceptingDaa:'10',intent:{txid:'cd'.repeat(32)}}];}),profile),/PENDING_INTENT/);
});
test('distinct frozen UTXOs may have identical scripts; duplicate outpoints and wrong balances still fail',()=>{
  const f=fixture({module:'win',cnt:2,local:3,p:0});f.s.indices[1].hash=f.s.indices[0].hash;
  f.manager.redeemScript=redeem(f.s,profile);f.manager.spk=p2sh(scriptHash(f.s,profile));
  f.targets[1]={...f.targets[1],redeemScript:f.targets[0].redeemScript,spk:f.targets[0].spk};
  const r=record(f);validateRound(r,profile);assert.equal(roundFromText(roundToText(r),profile).frozen.length,2);
  const duplicate=structuredClone(r);duplicate.frozen[1].outpoint=duplicate.frozen[0].outpoint;assert.throws(()=>validateRound(duplicate,profile),/FROZEN_HASH/);
  const skim=structuredClone(r);skim.frozen[1].value--;assert.throws(()=>validateRound(skim,profile),/ROUND_FROZEN_VALUE/);
});
test('availableActions follows the protocol window for each phase and is blocked by a pending intent',()=>{
  const A=(f,daa)=>availableActions(record(f),profile,daa);
  let f=fixture({module:'sales',local:3,ticketCap:10,closeEligibleDaa:5000n}),a=A(f,2500n);
  assert.ok(a.BUY.ok&&a.BUY.maxQuantity===7&&!a.CLOSE.ok&&a.DRAW.ok===false);assert.ok(A(f,5000n).CLOSE.ok);
  f=fixture({module:'sales',local:10,ticketCap:10});a=A(f,0n);assert.ok(a.CLOSE.ok&&!a.BUY.ok);
  f=fixture({module:'sealed',local:3});
  assert.ok(!A(f,2000n+99n).DRAW.ok&&A(f,2000n+100n).DRAW.ok&&!A(f,2000n+S.TIMEOUT_DELAY-1000n).DRAW.ok&&!A(f,2000n+S.TIMEOUT_DELAY-1n).TIMEOUT.ok&&A(f,2000n+S.TIMEOUT_DELAY).TIMEOUT.ok);
  f=fixture({module:'win',cnt:1,local:3,p:0});a=A(f,0n);assert.ok(a.PAY_OLD.ok&&!a.PAY_SELF.ok);
  f=fixture({module:'win',local:3,p:0});a=A(f,0n);assert.ok(a.PAY_SELF.ok&&!a.PAY_OLD.ok);
  f=fixture({module:'refund',cnt:1,local:3,r:0,c:0});a=A(f,0n);assert.ok(a.REFUND_OLD.ok&&!a.REFUND_SELF.ok);
  f=fixture({module:'refund',local:3,r:0,c:0});a=A(f,0n);assert.ok(a.REFUND_SELF.ok);
  const r=record(f);r.intent={status:'UNKNOWN'};assert.ok(Object.values(availableActions(r,profile,0n)).every(x=>!x.ok&&/意图/.test(x.reason)));
  const t=record(f);t.terminal='PAID';assert.ok(Object.values(availableActions(t,profile,0n)).every(x=>!x.ok));
  assert.equal(describeRound(record(f),profile).module,'refund');
});
test('genesis acceptance is interpreted from the node-served transaction (payload ledger, cid, script hash)',()=>{
  const d=buildGenesis(profile,w.key,{ticketPrice:PRICE,ticketCap:10,minTickets:3,closeEligibleDaa:5000n},{funds:[fund(9,10n*PRICE,w.key)],fee:FEE,budgets:[10]});
  const g=interpretGenesis(nodeTx(d),profile);assert.equal(g.cid,d.cid);assert.equal(g.next.module,'sales');
  const bad=nodeTx(d);bad.outputs[0].value+=1n;assert.throws(()=>interpretGenesis(bad,profile),/GENESIS_COVENANT/);
  const bad2=nodeTx(d);bad2.payload=bad2.payload.slice(0,-2)+'01';assert.throws(()=>interpretGenesis(bad2,profile));
  const bad3=nodeTx(d);bad3.inputs[0].previousOutpoint={transactionId:'77'.repeat(32),index:0};assert.throws(()=>interpretGenesis(bad3,profile),/GENESIS_COVENANT/);
  const dReg=buildGenesis(profile,w.key,{ticketPrice:PRICE,ticketCap:10,minTickets:3,closeEligibleDaa:5000n},{funds:[fund(8,10n*PRICE,w.key)],fee:FEE,budgets:[10],registrySpk:TN10_ROLLING_REGISTRY.spk});
  assert.equal(dReg.transaction.outputs.length,3);assert.equal(interpretGenesis(nodeTx(dReg),profile).cid,dReg.cid);
  const bad4=nodeTx(dReg);bad4.outputs[1].covenant={covenantId:dReg.cid,authorizingInput:0};assert.throws(()=>interpretGenesis(bad4,profile),/GENESIS_EXTRA_COVENANT/);
  const intent={action:'GENESIS',draft:d,quantity:0,mass:{transientMass:1n}},base=emptyRound({cid:d.cid,origin:d.origin,settings:{ticketPrice:PRICE,ticketCap:10,minTickets:3,closeEligibleDaa:5000n}});
  const txid=referenceTxId(d.transaction),acc={txid,tx:nodeTx(d),acceptingBlock:'cd'.repeat(32),acceptingDaa:7000n,observedVirtualDaa:7100n,actualFee:d.fee,nodeComputeMass:null,storageMass:0n};
  const next=advanceRound(base,intent,acc,profile);
  assert.equal(next.manager.outpoint.transactionId,txid);assert.equal(next.manager.utxoDaa,7000n);assert.equal(next.step,1);assert.equal(next.fees,d.fee);assert.equal(next.intent,null);
  assert.equal(advanceRound(next,intent,acc,profile),next); // idempotent by txid: double application cannot happen
  validateRound(next,profile);
});
test('BUY acceptance advances from the accepted tx; freezing the 256th record creates a frozen shard',()=>{
  const f=fixture({module:'sales',local:255}),r=record(f);
  const d=buildAction(f.manager,profile,{action:'BUY',quantity:1,actorKey:w.key},{funds:[fund(4,10n*PRICE,w.key)],fee:FEE,budgets:[10,10]});
  const intent={action:'BUY',quantity:1,targetCount:0,accessor:null,draft:{...d,inputUtxos:d.inputUtxos.map(u=>({...u,daa:u.utxoDaa}))},mass:{transientMass:1n}};
  const acc={txid:referenceTxId(d.transaction),tx:nodeTx(d),acceptingBlock:'ee'.repeat(32),acceptingDaa:2500n,observedVirtualDaa:2700n,actualFee:d.fee,nodeComputeMass:5n,storageMass:1n};
  const next=advanceRound(r,intent,acc,profile);
  assert.equal(next.frozen.length,1);assert.equal(next.frozen[0].value,256n*PRICE);assert.equal(next.buys,1);assert.equal(next.bought,1);assert.equal(next.manager.value,S.DEPOSIT);
  validateRound(next,profile);
  // an accepted transaction that differs from what the contexts imply is refused
  const forged={...acc,tx:{...acc.tx,outputs:acc.tx.outputs.map((o,i)=>i===1?{...o,value:o.value+1n}:o)}};
  assert.throws(()=>advanceRound(r,intent,forged,profile));
});
test('RoundStore: atomic create, CAS replace, input reservation and persistence flag',async()=>{
  const ms=new MemoryStore(),rs=new RoundStore(ms);assert.equal(rs.persistent,false);
  const f=fixture({module:'sales',local:1}),r=record(f);
  const mk=(cid,outpoints)=>({...r,cid,intent:{status:'PREPARED',draft:{transaction:{inputs:outpoints.map(o=>({previousOutpoint:{transactionId:o,index:0}}))}}}});
  await rs.create(mk('aa'.repeat(32),['01'.repeat(32)]));
  await assert.rejects(()=>rs.create(mk('aa'.repeat(32),['02'.repeat(32)])),/INTENT_ALREADY_EXISTS/);
  await assert.rejects(()=>rs.create(mk('bb'.repeat(32),['01'.repeat(32)])),/INPUT_RESERVED_BY_PENDING_INTENT/);
  await rs.create(mk('cc'.repeat(32),['03'.repeat(32)]));
  assert.deepEqual([...await rs.reserved()].sort(),['01'.repeat(32)+':0','03'.repeat(32)+':0']);
  const cur=await rs.get('aa'.repeat(32));await rs.replace({...cur.round,intent:null},cur.revision);
  await assert.rejects(()=>rs.replace({...cur.round},cur.revision),/STALE_CACHE_REVISION/); // stale writers never overwrite
  assert.equal((await rs.list()).length,2);
});
test('shardCatalog decodes frozen + active shards, global ticket ranges, settled/refund progress, and terminal state',()=>{
  const emptyR=record(fixture({module:'sales',local:0}));
  assert.deepEqual(shardCatalog(emptyR,profile),[]);
  const termR=record(fixture({module:'win',cnt:1,local:3,p:1}));termR.terminal='PAID';termR.manager=null;termR.frozen=[];
  assert.equal(shardCatalog(termR,profile),null);
  const winF=fixture({module:'win',cnt:2,local:3,p:1}),winR={...record(winF),frozen:record(winF).frozen.slice(1)};
  const buyerKey=winF.s.records[0].key;
  const shards=shardCatalog(winR,profile,buyerKey);
  assert.equal(shards.length,3);
  assert.equal(shards[0].status,'settled');assert.equal(shards[0].records,null);assert.equal(shards[0].startTicket,1);
  assert.equal(shards[1].status,'frozen');assert.equal(shards[1].records.length,256);assert.equal(shards[1].startTicket,shards[0].endTicket+1);
  assert.equal(shards[2].kind,'active');assert.equal(shards[2].records.length,3);assert.equal(shards[2].records[0].startTicket,shards[1].endTicket+1);
  assert.ok(shards[2].mineCount>0&&shards[2].records[0].mine===true);
  const refF=fixture({module:'refund',cnt:2,local:3,r:1,c:32}),refR={...record(refF),frozen:record(refF).frozen.slice(1)};
  const rShards=shardCatalog(refR,profile);
  assert.equal(rShards[0].status,'refunded');assert.equal(rShards[0].records,null);
  assert.equal(rShards[1].status,'refunding');assert.equal(rShards[1].records[0].refunded,true);assert.equal(rShards[1].records[31].refunded,true);assert.equal(rShards[1].records[32].refunded,false);
  assert.equal(rShards[2].status,'frozen');assert.equal(rShards[2].records.length,3);
  // Terminal round with verified history (e.g. 17-shard PAID round) decodes all shards and trailing records
  const histR={...termR,bought:259,history:{terminal:'PAID',winnerKey:winF.s.winnerKey,localRecords:[{end:3,key:buyerKey}],
    shards:[{end:256,hash:winF.s.indices[0].hash,records:Array.from({length:256},(_,i)=>({end:i+1,key:buyerKey}))}]}};
  validateRound(histR,profile);
  const hShards=shardCatalog(histR,profile,buyerKey);
  assert.equal(hShards.length,2);assert.equal(hShards[0].status,'settled');assert.equal(hShards[0].records.length,256);
  assert.equal(hShards[1].kind,'active');assert.equal(hShards[1].records[0].startTicket,257);
  assert.equal(describeRound(histR,profile).shards,1);assert.equal(describeRound(histR,profile).winnerKey,winF.s.winnerKey);
  validateRound({...histR,draw:{txid:'cd'.repeat(32),shard:0,record:10,ticket:10}},profile);
  assert.throws(()=>validateRound({...histR,draw:{txid:'cd'.repeat(32),shard:0,record:256,ticket:0}},profile),/INTEGER_RANGE/);
});
