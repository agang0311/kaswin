import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,profile,PRICE} from '../contracts/fixtures.mjs';
import {p2pk} from '../../scripts/core/lib/covenant-id.js';
import {createController} from '../../scripts/round/controller.mjs';
import {runEngine} from '../contracts/engine-gate.mjs';
import {MemoryStore,RoundStore} from '../../scripts/store/round-store.mjs';
import {FakeNode} from '../helpers/fake-node.mjs';
import {pickTargets,mempoolSpentOutpoints} from '../../scripts/round/prepare.mjs';
import {classifyRejection} from '../../scripts/tracking/conflict.mjs';
import {DEPOSIT,REWARD,REFUND_FEE} from '../contracts/state.mjs';
import {redeem,identify} from '../contracts/profile.mjs';
import {openMemoryWallet} from '../../scripts/wallet/wallet.mjs';
import {roundToText,emptyRound} from '../../scripts/round/round.mjs';
import {decodeTagged,encodeTagged} from '../../scripts/store/codec.mjs';

const SECRET=createHash('sha256').update('rolling-tn10-controller-test-key').digest('hex');
const KAS=100000000n;
const WALLET=openMemoryWallet(SECRET);

async function setup({real=false,daa=5000}={}) {
  const node=new FakeNode({daa}),ms=new MemoryStore();ms.persistent=true;
  const roundStore=new RoundStore(ms);
  node.addUtxo({txid:'a1'.repeat(32),value:100n*KAS,spk:WALLET.spk,daa:100});
  const ctl=createController({profile,roundStore,connect:async()=>node,sleep:async()=>{}});
  await ctl.connectNode(['wss://fake-tn10.invalid/wrpc']);
  ctl.openWallet(SECRET);
  return {node,ms,roundStore,ctl,realVm:!!real};
}
const settings=(over={})=>({ticketPrice:'1',ticketCap:'10',minTickets:'3',closeMinutes:'0',...over});
/** prepare -> signAndSend -> optional real-VM limited verification -> first acceptance -> mine until >=100 DAA deep -> track promotes it. */
async function runAccepted({node,ctl,roundStore,realVm=false},choice,cid,inspect=()=>{}) {
  await ctl.prepare(choice,cid);
  const p=ctl.state.prepared,rcid=p.cid;inspect(p);
  assert.equal(await ctl.signAndSend(),'SUBMITTED');
  if(realVm) {
    const saved=(await roundStore.get(rcid)).round.intent;
    const res=runEngine(saved.draft,{accessor:saved.accessor??null,limited:true});
    assert.ok(res.inputs.every(x=>x.ok&&x.limitedOk),`${choice.action} exceeded local calibrated budget in kaswin-rolling-vm`);
  }
  let r=await ctl.track(rcid);assert.equal(r.accepted,false);
  node.mine(1);r=await ctl.track(rcid);assert.equal(r.accepted,false);assert.equal(r.candidate,true); // first selected-chain acceptance = candidate
  let cand=(await roundStore.get(rcid)).round;assert.equal(cand.intent,null);assert.equal(cand.pending.length,1);assert.equal(cand.receipts.at(-1).finalized,false); // already advanced
  node.mine(11);r=await ctl.track(rcid);assert.equal(r.accepted,true);
  const round=(await roundStore.get(rcid)).round;assert.equal(round.pending.length,0);assert.ok(round.receipts.every(x=>x.finalized===true&&x.accepted===true));
  return round;
}

async function refundScenario(real=false) {
  const {node,ctl,roundStore,realVm}=await setup({real});
  let r=await runAccepted({node,ctl,roundStore,realVm},{action:'GENESIS',settings:settings({minTickets:'5',ticketCap:'10'})});
  const cid=r.cid;
  assert.equal(r.step,1);assert.equal(r.manager.value,400000000n);assert.equal(r.intent,null);assert.equal(r.source,'local');assert.equal(r.receipts[0].action,'GENESIS');
  // BUY 3 tickets (below the 5-ticket minimum)
  r=await runAccepted({node,ctl,roundStore,realVm},{action:'BUY',quantity:'3'},cid);
  assert.equal(r.bought,3);assert.equal(r.manager.value,400000000n+3n*PRICE);
  // blocked actions while below the close time? closeMinutes=0 so CLOSE is allowed; below minimum -> refund phase
  r=await runAccepted({node,ctl,roundStore,realVm},{action:'CLOSE'},cid);
  assert.equal((await ctl.describe(cid)).facts.module,'refund');
  r=await runAccepted({node,ctl,roundStore,realVm},{action:'REFUND_SELF'},cid);
  assert.equal(r.terminal,'REFUNDED');assert.equal(r.manager,null);assert.equal(r.receipts.length,4);
  // the buyer got the refund (ticket price minus refund fee) at their own address; creator got the deposit back minus fee
  const mine=[...node.utxos.values()].filter(u=>u.spk.script===WALLET.spk.script).reduce((n,u)=>n+u.value,0n);
  assert.ok(mine>99n*KAS&&mine<100n*KAS,`wallet ends slightly below its start: ${mine}`);
  assert.equal((await ctl.describe(cid)).actions.BUY.ok,false);
}
test('create -> BUY -> CLOSE(below minimum) -> REFUND_SELF: every step persists before send, advances on the first acceptance and is promoted by the deep recheck',()=>refundScenario());
test('V2.0.2 pacing: the next step is prepared right after the first acceptance; candidates are promoted in order once 100 DAA deep',async()=>{
  const {node,ctl,roundStore}=await setup();
  await ctl.prepare({action:'GENESIS',settings:settings()});const cid=ctl.state.prepared.cid;assert.equal(await ctl.signAndSend(),'SUBMITTED');
  node.mine(1);let r=await ctl.track(cid);assert.equal(r.candidate,true);
  await ctl.prepare({action:'BUY',quantity:'2'},cid);assert.equal(await ctl.signAndSend(),'SUBMITTED'); // no waiting for 100 DAA
  node.mine(1);r=await ctl.track(cid);assert.equal(r.candidate,true);
  let round=(await roundStore.get(cid)).round;
  assert.equal(round.step,2);assert.equal(round.bought,2);assert.equal(round.pending.length,2);assert.ok(round.receipts.every(x=>x.candidate===true&&x.accepted===false));
  const reserved=await roundStore.reserved(); // inputs spent by unverified candidates are never reused as funding
  for(const p of round.pending)for(const i of p.intent.draft.transaction.inputs)assert.ok(reserved.has(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`));
  assert.equal((await ctl.describe(cid)).facts.pending,2);
  node.mine(11);r=await ctl.track(cid);assert.equal(r.accepted,true);assert.equal(r.pending.finalized,2);
  round=(await roundStore.get(cid)).round;
  assert.deepEqual(round.receipts.map(x=>[x.action,x.finalized,x.accepted]),[['GENESIS',true,true],['BUY',true,true]]);assert.equal(round.pending.length,0);
  assert.ok(round.receipts.every(x=>BigInt(x.finalDepth)>=100n));
});
test('a shallow reorg that moves the accepting block is followed: same signed bytes re-accepted, history kept, created UTXOs refreshed',async()=>{
  const {node,ctl,roundStore}=await setup();
  await ctl.prepare({action:'GENESIS',settings:settings()});const cid=ctl.state.prepared.cid;await ctl.signAndSend();
  node.mine(1);await ctl.track(cid);
  let round=(await roundStore.get(cid)).round;const old={block:round.receipts[0].acceptingBlock,daa:BigInt(round.receipts[0].acceptingDaa)};
  node.reorgTip({dDaa:3});
  let r=await ctl.track(cid);assert.equal(r.pending.reaccepted,1);assert.equal(r.accepted,false);
  round=(await roundStore.get(cid)).round;const rc=round.receipts[0];
  assert.notEqual(rc.acceptingBlock,old.block);assert.equal(BigInt(rc.acceptingDaa),old.daa+3n);assert.deepEqual(rc.reaccepted,[{acceptingBlock:old.block,acceptingDaa:old.daa.toString()}]);
  assert.equal(round.manager.utxoDaa,old.daa+3n);assert.equal(round.accepting,rc.acceptingBlock);assert.equal(round.pending[0].acceptingBlock,rc.acceptingBlock);
  await ctl.prepare({action:'BUY',quantity:'1'},cid);assert.equal(await ctl.signAndSend(),'SUBMITTED'); // chaining continues on the refreshed context
  node.mine(1);await ctl.track(cid);node.mine(11);r=await ctl.track(cid);assert.equal(r.accepted,true);
  round=(await roundStore.get(cid)).round;assert.ok(round.receipts.every(x=>x.finalized===true));assert.equal(round.pending.length,0);assert.equal(round.receipts[0].reaccepted.length,1);
});
test('a candidate that is neither accepted nor in the mempool halts the round and blocks further steps',async()=>{
  const {node,ctl,roundStore}=await setup();
  await ctl.prepare({action:'GENESIS',settings:settings()});const cid=ctl.state.prepared.cid;await ctl.signAndSend();
  node.mine(1);await ctl.track(cid);
  node.dropTip();
  await assert.rejects(()=>ctl.track(cid),/CANDIDATE_DROPPED/);
  const round=(await roundStore.get(cid)).round;assert.equal(round.halted,'CANDIDATE_DROPPED');assert.equal(round.pending.length,1); // nothing is silently erased
  await assert.rejects(()=>ctl.prepare({action:'BUY',quantity:'1'},cid),/ROUND_HALTED/);
  assert.ok(Object.values((await ctl.describe(cid)).actions).every(a=>a.ok===false&&/已停止/.test(a.reason)));
});
test('a candidate that is only waiting in the mempool is not dropped before the grace period',async()=>{
  const {node,ctl,roundStore}=await setup();
  await ctl.prepare({action:'GENESIS',settings:settings()});const cid=ctl.state.prepared.cid;await ctl.signAndSend();
  node.mine(1);await ctl.track(cid);
  const entry=(await roundStore.get(cid)).round.pending[0];
  node.dropTip();node.mempool.set(entry.txid,entry.intent.draft.transaction); // back in the pool, not yet re-accepted
  let r=await ctl.track(cid);assert.equal(r.accepted,false);assert.equal(r.pending.waiting,1);
  const round=(await roundStore.get(cid)).round;assert.equal(round.halted,null);assert.equal(round.pending.length,1);assert.equal(typeof round.pending[0].limboSince,'number');
  node.mine(1);r=await ctl.track(cid);assert.equal(r.pending.reaccepted,1); // accepted again in a new block
});
test('REFUND_OLD / PAY_OLD target selection tells apart shards that share a script by their expected value',()=>{
  const f=fixture({module:'refund',cnt:2,local:3,r:0,c:32});
  f.s.indices[1].hash=f.s.indices[0].hash;f.targets[1]={...f.targets[1],redeemScript:f.targets[0].redeemScript,spk:f.targets[0].spk};
  f.manager.redeemScript=redeem(f.s,profile);
  assert.ok(f.targets[0].value<f.targets[1].value); // the shard at the refund cursor was partly refunded
  const round={frozen:[f.targets[1],f.targets[0]]}; // the list order that selected the wrong (full-value) UTXO before
  const out=pickTargets(round,f.s,profile,'REFUND_OLD');
  assert.equal(out.length,1);assert.equal(out[0].outpoint.transactionId,f.targets[0].outpoint.transactionId);assert.equal(out[0].value,f.targets[0].value);
  const w=fixture({module:'win',cnt:2,local:3,p:0});
  w.s.indices[1].hash=w.s.indices[0].hash;w.targets[1]={...w.targets[1],redeemScript:w.targets[0].redeemScript,spk:w.targets[0].spk};
  const both=pickTargets({frozen:[...w.targets].reverse()},w.s,profile,'PAY_OLD');
  assert.deepEqual(both.map(x=>x.outpoint.transactionId).sort(),w.targets.map(x=>x.outpoint.transactionId).sort()); // both shards, no duplicate
});
/** Two users, two page controllers (separate stores and wallets), one node. */
function user(node,secret,{now}={}) {
  const ms=new MemoryStore();ms.persistent=true;const roundStore=new RoundStore(ms),wallet=openMemoryWallet(secret);
  node.addUtxo({txid:createHash('sha256').update('fund-'+secret).digest('hex'),value:100n*KAS,spk:wallet.spk,daa:100});
  const ctl=createController({profile,roundStore,connect:async()=>node,sleep:async()=>{},...(now?{now}:{})});
  return {ctl,roundStore,wallet,secret};
}
test('two buyers press send on the same manager at once: one wins, the loser can discard (its input was spent elsewhere), re-import and buy',async()=>{
  const node=new FakeNode({daa:5000}),A=user(node,SECRET),B=user(node,createHash('sha256').update('rolling-tn10-second-buyer').digest('hex'));
  for(const u of [A,B]){await u.ctl.connectNode(['wss://fake-tn10.invalid/wrpc']);u.ctl.openWallet(u.secret);}
  await A.ctl.prepare({action:'GENESIS',settings:settings()});const cid=A.ctl.state.prepared.cid;await A.ctl.signAndSend();node.mine(1);await A.ctl.track(cid);
  await B.ctl.importText(await A.ctl.exportText(cid)); // B restores A's state (still holding a candidate)
  await A.ctl.prepare({action:'BUY',quantity:'1'},cid);await B.ctl.prepare({action:'BUY',quantity:'1'},cid); // both hold a BUY on the SAME manager outpoint
  assert.equal(await A.ctl.signAndSend(),'SUBMITTED');
  assert.equal(await B.ctl.signAndSend(),'REJECTED'); // the node refuses the conflicting spend
  const lost=(await B.roundStore.get(cid)).round.intent;assert.match(lost.nodeError,/already spent by transaction/);
  node.mine(1); // A's BUY is accepted: the manager outpoint is now spent
  await A.ctl.track(cid);
  // old behaviour: STALE_INPUT here and no way out (import is refused while the intent is stored)
  const winnerState=await A.ctl.exportText(cid);
  await assert.rejects(()=>B.ctl.importText(winnerState),/IMPORT_WOULD_REPLACE_LOCAL_INTENT/);
  await B.ctl.discard(cid);assert.equal((await B.roundStore.get(cid)).round.intent,null);
  assert.ok(B.ctl.state.logs.some(l=>l.kind==='warn'&&/已过期/.test(l.text)));
  await assert.rejects(()=>B.ctl.prepare({action:'BUY',quantity:'1'},cid),/STALE_INPUT/); // the old local state still cannot be used
  assert.ok(B.ctl.state.logs.some(l=>/可能已过期/.test(l.text)));
  await B.ctl.importText(await A.ctl.exportText(cid)); // recovery: take the winner's state
  await B.ctl.prepare({action:'BUY',quantity:'1'},cid);assert.equal(await B.ctl.signAndSend(),'SUBMITTED');
  node.mine(1);await B.ctl.track(cid);node.mine(11);const r=await B.ctl.track(cid);assert.equal(r.accepted,true);
  const round=(await B.roundStore.get(cid)).round;
  assert.equal(round.bought,2);assert.deepEqual(round.receipts.map(x=>x.action),['GENESIS','BUY','BUY']);assert.ok(round.receipts.every(x=>x.finalized===true));assert.equal(round.pending.length,0);
});
test('a SUBMITTED loser whose competitor won through another node: discard needs a gone input, no mempool entry, no acceptance and the grace period; then it recovers',async()=>{
  const node=new FakeNode({daa:5000}),offset={ms:0},A=user(node,SECRET),B=user(node,createHash('sha256').update('rolling-tn10-second-buyer').digest('hex'),{now:()=>Date.now()+offset.ms});
  for(const u of [A,B]){await u.ctl.connectNode(['wss://fake-tn10.invalid/wrpc']);u.ctl.openWallet(u.secret);}
  await A.ctl.prepare({action:'GENESIS',settings:settings()});const cid=A.ctl.state.prepared.cid;await A.ctl.signAndSend();node.mine(1);await A.ctl.track(cid);
  await B.ctl.importText(await A.ctl.exportText(cid));
  await A.ctl.prepare({action:'BUY',quantity:'1'},cid);await B.ctl.prepare({action:'BUY',quantity:'1'},cid);
  // B's frame reaches B's node: submitted, in the pool. A's conflicting BUY wins elsewhere and is accepted; B's pool entry is evicted.
  assert.equal(await B.ctl.signAndSend(),'SUBMITTED');const lost=(await B.roundStore.get(cid)).round.intent;
  node.mempool.delete(lost.txid);
  assert.equal(await A.ctl.signAndSend(),'SUBMITTED');node.mine(1);await A.ctl.track(cid);
  let t=await B.ctl.track(cid,{recover:true});assert.equal(t.accepted,false);assert.equal(t.inputsGone,true); // the page sees: not accepted, inputs gone
  await assert.rejects(()=>B.ctl.discard(cid),/INTENT_TOO_RECENT/); // not before the grace period
  const winnerState=await A.ctl.exportText(cid);
  await assert.rejects(()=>B.ctl.importText(winnerState),/IMPORT_WOULD_REPLACE_LOCAL_INTENT/);
  offset.ms=4*60*1000;
  node.mempool.set(lost.txid,lost.draft.transaction); // while the node still holds it nothing may be dropped
  await assert.rejects(()=>B.ctl.discard(cid),/INTENT_IN_MEMPOOL/);node.mempool.delete(lost.txid);
  await B.ctl.discard(cid);assert.equal((await B.roundStore.get(cid)).round.intent,null);
  await B.ctl.importText(winnerState);await B.ctl.prepare({action:'BUY',quantity:'1'},cid);assert.equal(await B.ctl.signAndSend(),'SUBMITTED');
  node.mine(1);await B.ctl.track(cid);node.mine(11);await B.ctl.track(cid);
  const round=(await B.roundStore.get(cid)).round;assert.equal(round.bought,2);assert.ok(round.receipts.every(x=>x.finalized===true));
});
test('a SUBMITTED intent whose inputs are all still live is never discarded (use recovery); an accepted one cannot be discarded either',async()=>{
  const {node,ctl,roundStore}=await setup();
  node.failSubmit='lost';await ctl.prepare({action:'GENESIS',settings:settings()});await ctl.signAndSend();
  const cid=(await ctl.rounds())[0].cid,i=(await roundStore.get(cid)).round.intent;assert.equal(i.status,'UNKNOWN');
  await assert.rejects(()=>ctl.discard(cid),/INTENT_INPUTS_STILL_LIVE/);assert.equal((await roundStore.get(cid)).round.intent.txid,i.txid);
  node.failSubmit=null;await ctl.track(cid,{recover:true});node.mine(1);
  await assert.rejects(()=>ctl.discard(cid),/INTENT_ACCEPTANCE_UNRESOLVED|NO_PENDING_INTENT/); // accepted: nothing to discard
});
test('discard stays strict: an input that is still present but different is never treated as spent elsewhere',async()=>{
  const {node,ctl,roundStore}=await setup();
  node.failSubmit='reject';await ctl.prepare({action:'GENESIS',settings:settings()});await ctl.signAndSend();
  const cid=(await ctl.rounds())[0].cid,i=(await roundStore.get(cid)).round.intent,op=i.draft.transaction.inputs[0].previousOutpoint;
  node.utxos.get(`${op.transactionId}:${op.index}`).value+=1n; // same outpoint, different content
  await assert.rejects(()=>ctl.discard(cid),/STALE_INPUT/);assert.equal((await roundStore.get(cid)).round.intent.txid,i.txid);
});
test('the intent is durable before the frame is handed to the transport',async()=>{
  const {node,ctl,roundStore}=await setup();
  let seen=null;
  node.beforeSubmit=txid=>{seen=roundStore.store.list(roundStore.prefix).then(rows=>rows.map(x=>x.record.value.intent).find(i=>i?.txid===txid));};
  await ctl.prepare({action:'GENESIS',settings:settings()});
  const txid=ctl.state.prepared.review.txid;await ctl.signAndSend();
  const i=await seen;assert.equal(i.txid,txid);assert.equal(i.status,'PREPARED');assert.ok(i.draft.transaction.inputs.every(x=>x.signatureScript.length>0));
  assert.equal((await roundStore.get(i.draft.cid)).round.intent.status,'SUBMITTED');
});
test('unknown submit keeps the intent, blocks any replacement, and recovery resends the SAME bytes',async()=>{
  const {node,ctl,roundStore}=await setup();
  node.failSubmit='lost'; // reply lost and the tx never reached the node
  await ctl.prepare({action:'GENESIS',settings:settings()});
  const first=ctl.state.prepared.review.txid;
  assert.equal(await ctl.signAndSend(),'UNKNOWN');
  const cid=ctl.state.logs.length&&(await ctl.rounds())[0].cid,round=(await roundStore.get(cid)).round;
  assert.equal(round.intent.status,'UNKNOWN');assert.equal(round.intent.txid,first);
  const bytes=JSON.stringify(round.intent.draft.transaction,(_,v)=>typeof v==='bigint'?v.toString():v);
  // a new transaction for the same round/inputs is refused: no silent replacement
  await assert.rejects(()=>ctl.prepare({action:'BUY',quantity:'1'},cid),/INTENT_UNRESOLVED_REPLACEMENT_BLOCKED/);
  await assert.rejects(()=>ctl.prepare({action:'GENESIS',settings:settings()}),/WALLET_FUNDS_INSUFFICIENT/); // the only funding UTXO is reserved by the pending intent
  // plain query does not resend anything
  let t=await ctl.track(cid);assert.equal(t.accepted,false);assert.equal(node.mempool.size,0);
  // explicit recovery: tx absent from mempool + inputs still live -> resend identical bytes
  node.failSubmit=null;t=await ctl.track(cid,{recover:true});
  assert.equal(t.resubmitted,true);assert.ok(node.mempool.has(first));
  assert.equal((await roundStore.get(cid)).round.intent.status,'SUBMITTED');
  assert.equal(JSON.stringify((await roundStore.get(cid)).round.intent.draft.transaction,(_,v)=>typeof v==='bigint'?v.toString():v),bytes);
  node.mine(12);t=await ctl.track(cid);assert.equal(t.accepted,true);
  assert.equal((await roundStore.get(cid)).round.manager.outpoint.transactionId,first);
});
test('unknown submit that the node DID take is simply accepted later; no resend happens',async()=>{
  const {node,ctl,roundStore}=await setup();
  node.failSubmit='timeout';await ctl.prepare({action:'GENESIS',settings:settings()});
  assert.equal(await ctl.signAndSend(),'UNKNOWN');const cid=(await ctl.rounds())[0].cid;
  node.failSubmit='reject'; // any resend attempt would now fail loudly
  const submits=()=>node.calls.filter(c=>c==='submitTransaction').length,before=submits();
  node.mine(12);const t=await ctl.track(cid,{recover:true});
  assert.equal(t.accepted,true);assert.equal(submits(),before);
});
test('inputs spent elsewhere: recovery reports it, keeps the intent and never builds a new transaction',async()=>{
  const {node,ctl,roundStore}=await setup();
  node.failSubmit='lost';await ctl.prepare({action:'GENESIS',settings:settings()});await ctl.signAndSend();
  const cid=(await ctl.rounds())[0].cid,i=(await roundStore.get(cid)).round.intent;
  node.removeUtxo(i.draft.transaction.inputs[0].previousOutpoint.transactionId,i.draft.transaction.inputs[0].previousOutpoint.index);
  node.failSubmit=null;const t=await ctl.track(cid,{recover:true});
  assert.equal(t.accepted,false);assert.equal(t.inputsGone,true);
  assert.equal((await roundStore.get(cid)).round.intent.txid,i.txid);assert.equal(node.mempool.size,0);
});
test('node rejection is recorded; discard needs proof it is neither accepted nor pending, then a fresh prepare works',async()=>{
  const {node,ctl,roundStore}=await setup();
  node.failSubmit='reject';await ctl.prepare({action:'GENESIS',settings:settings()});
  assert.equal(await ctl.signAndSend(),'REJECTED');const cid=(await ctl.rounds())[0].cid;
  assert.equal((await roundStore.get(cid)).round.intent.status,'REJECTED');
  await assert.rejects(()=>ctl.track(cid,{recover:true}),/RECORDED_REJECTION_REQUIRES_REVIEW/);
  await ctl.discard(cid);assert.equal((await ctl.rounds()).length,0); // genesis that never existed is removed
  node.failSubmit=null;await ctl.prepare({action:'GENESIS',settings:settings()});assert.equal(await ctl.signAndSend(),'SUBMITTED');
});
test('an unsent failure (nothing reached the transport) is dropped; durable-store and wallet requirements are enforced',async()=>{
  const {ctl,roundStore,ms}=await setup();
  ms.persistent=false;await assert.rejects(()=>ctl.prepare({action:'GENESIS',settings:settings()}),/DURABLE_STORE_REQUIRED/);ms.persistent=true;
  ctl.disconnectWallet();await assert.rejects(()=>ctl.prepare({action:'GENESIS',settings:settings()}),/WALLET_REQUIRED/);
  ctl.usePublicAddress(WALLET.address);await assert.rejects(()=>ctl.prepare({action:'GENESIS',settings:settings()}),/WALLET_KEY_REQUIRED/);
  assert.equal((await roundStore.list()).length,0);
});
test('disconnect wipes the key: the signer is closed and a prepared draft cannot be signed afterwards',async()=>{
  const {ctl}=await setup();
  await ctl.prepare({action:'GENESIS',settings:settings()});const w=ctl.state.wallet;
  ctl.disconnectWallet();assert.equal(w.closed,true);assert.equal(ctl.state.prepared,null);assert.equal(ctl.state.wallet,null);
  await assert.rejects(()=>ctl.signAndSend(),/NOTHING_PREPARED/);
});
/** Import a `win`-phase record (state only), put its UTXOs on the fake node and run the permissionless payout with a PUBLIC address only. */
async function payoutScenario(real=false) {
  const {node,ctl,roundStore,realVm}=await setup({real});
  const f=fixture({module:'win',cnt:2,local:3,p:0}),cid=f.manager.cid;
  const rec={...emptyRound({cid,origin:f.manager.origin,settings:{ticketPrice:f.s.ticketPrice,ticketCap:f.s.ticketCap,minTickets:f.s.minTickets,closeEligibleDaa:f.s.closeEligibleDaa}}),
    manager:{...f.manager,daa:f.manager.utxoDaa,covenantId:cid},frozen:f.targets.map(t=>({...t,covenantId:cid,daa:t.utxoDaa,origin:f.manager.origin})),accepting:'ab'.repeat(32)};
  assert.equal(await ctl.importText(roundToText(rec)),cid);
  assert.equal((await roundStore.get(cid)).round.source,'imported');
  ctl.usePublicAddress(WALLET.address);
  // not on the node yet -> refuse to prepare anything
  await assert.rejects(()=>ctl.prepare({action:'PAY_OLD'},cid),/STALE_INPUT/);
  await assert.rejects(()=>ctl.verifyLive(cid),/STALE_INPUT/);
  node.addUtxo({txid:f.manager.outpoint.transactionId,index:0,value:f.manager.value,spk:f.manager.spk,daa:f.manager.utxoDaa,covenantId:cid});
  for(const t of f.targets)node.addUtxo({txid:t.outpoint.transactionId,index:t.outpoint.index,value:t.value,spk:t.spk,daa:t.utxoDaa,covenantId:cid});
  assert.deepEqual(await ctl.verifyLive(cid),{module:'win',frozen:2});
  // a value mismatch on the node (e.g. a stale/forged import) is refused
  node.utxos.get(`${f.manager.outpoint.transactionId}:0`).value+=1n;await assert.rejects(()=>ctl.verifyLive(cid),/STALE_INPUT/);node.utxos.get(`${f.manager.outpoint.transactionId}:0`).value-=1n;
  let r=await runAccepted({node,ctl,roundStore,realVm},{action:'PAY_OLD'},cid);
  assert.equal(r.frozen.length,0);assert.equal((await ctl.describe(cid)).facts.payCursor,2);assert.equal(r.terminal,null);
  assert.ok(ctl.state.prepared===null);
  r=await runAccepted({node,ctl,roundStore,realVm},{action:'PAY_SELF'},cid);
  assert.equal(r.terminal,'PAID');assert.equal(r.manager,null);
  // executor rewards (PAY_OLD 2*REWARD + PAY_SELF REWARD) landed on the PUBLIC address; no private key was involved in these actions
  const got=[...node.utxos.values()].filter(u=>u.spk.script===WALLET.spk.script&&u.value<5n*KAS).reduce((n,u)=>n+u.value,0n);
  assert.equal(got,3n*100000000n);
}
test('imported record is unauthenticated until the live UTXOs match; PAY_OLD then PAY_SELF run with a public address only',()=>payoutScenario());
/** Import a state record and put its UTXOs on the fake node (state data + live UTXOs = what a user would restore). */
async function restore(ctl,node,f,cid=f.manager.cid) {
  const rec={...emptyRound({cid,origin:f.manager.origin,settings:{ticketPrice:f.s.ticketPrice,ticketCap:f.s.ticketCap,minTickets:f.s.minTickets,closeEligibleDaa:f.s.closeEligibleDaa}}),
    manager:{...f.manager,daa:f.manager.utxoDaa,covenantId:cid},frozen:f.targets.map(t=>({...t,covenantId:cid,daa:t.utxoDaa,origin:f.manager.origin})),accepting:'ab'.repeat(32)};
  await ctl.importText(roundToText(rec));
  node.addUtxo({txid:f.manager.outpoint.transactionId,index:0,value:f.manager.value,spk:f.manager.spk,daa:f.manager.utxoDaa,covenantId:cid});
  for(const t of f.targets)node.addUtxo({txid:t.outpoint.transactionId,index:t.outpoint.index,value:t.value,spk:t.spk,daa:t.utxoDaa,covenantId:cid});
  return cid;
}
// Simulated variants use advisory budgets; real-engine variants below reuse these flows with simulated node acceptance only.
async function multiPayoutScenario(cnt,real=false) {
  const env=await setup({real}),{node,ctl,roundStore}=env,f=fixture({module:'win',cnt,local:3,p:0});
  const cid=await restore(ctl,node,f);ctl.usePublicAddress(WALLET.address);
  const point=x=>`${x.transactionId}:${x.index}`,funding='a1'.repeat(32)+':0';
  const balance=script=>[...node.utxos.values()].filter(u=>!u.covenantId&&u.spk.script===script).reduce((n,u)=>n+u.value,0n);
  const atOutput=(tx,script)=>tx.outputs.filter(o=>!o.covenant&&o.scriptPublicKey.script===script).reduce((n,o)=>n+o.value,0n);
  const executorBefore=balance(WALLET.spk.script),winnerScript=p2pk(f.s.winnerKey).script,ownerScript=p2pk(f.s.ownerKey).script;
  const consumed=new Set(),batches=[];let paid=0,totalFee=0n,round;
  while(paid<cnt) {
    const before=(await roundStore.get(cid)).round;let k,fee;
    round=await runAccepted(env,{action:'PAY_OLD'},cid,prepared=>{
      k=prepared.targetCount;fee=prepared.draft.fee;totalFee+=fee;batches.push(k);
      assert.ok(k>=1&&k<=16);assert.deepEqual(prepared.draft.authorizedInputIndices,[]);
      assert.deepEqual(prepared.draft.transaction.inputs.map(i=>point(i.previousOutpoint)),[point(before.manager.outpoint),...f.targets.slice(paid,paid+k).map(t=>point(t.outpoint))]);
      for(const t of f.targets.slice(paid,paid+k)){assert.equal(consumed.has(point(t.outpoint)),false);consumed.add(point(t.outpoint));}
      assert.equal(atOutput(prepared.draft.transaction,winnerScript),256n*BigInt(k)*PRICE-BigInt(k)*REWARD-fee);
      assert.equal(atOutput(prepared.draft.transaction,WALLET.spk.script),BigInt(k)*REWARD);
      assert.equal(prepared.draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-prepared.draft.transaction.outputs.reduce((n,o)=>n+o.value,0n),fee);
    });
    paid+=k;assert.equal((await ctl.describe(cid)).facts.payCursor,paid);assert.equal(round.frozen.length,cnt-paid);
    assert.equal(round.manager.value,DEPOSIT+3n*PRICE);assert.equal(round.terminal,null);
    for(const target of f.targets.slice(paid)) {
      const u=node.utxos.get(point(target.outpoint));assert.ok(u);assert.equal(u.value,target.value);assert.deepEqual(u.spk,target.spk);assert.equal(u.daa,target.utxoDaa);
    }
  }
  assert.equal(consumed.size,cnt);
  if(!real)assert.deepEqual(batches,cnt===17?[16,1]:[16,16,8]);
  else {assert.ok(batches.length>=Math.ceil(cnt/16));assert.equal(batches.reduce((n,k)=>n+k,0),cnt);}
  assert.equal((await ctl.describe(cid)).actions.PAY_OLD.ok,false);assert.equal((await ctl.describe(cid)).actions.PAY_SELF.ok,true);
  round=await runAccepted(env,{action:'PAY_SELF'},cid,p=>{assert.deepEqual(p.draft.authorizedInputIndices,[]);totalFee+=p.draft.fee;});
  assert.equal(round.terminal,'PAID');assert.equal(round.manager,null);assert.equal(round.frozen.length,0);
  assert.equal(balance(WALLET.spk.script)-executorBefore,BigInt(cnt+1)*REWARD);
  assert.equal(balance(ownerScript),DEPOSIT);assert.equal(balance(winnerScript),(256n*BigInt(cnt)+3n)*PRICE-BigInt(cnt+1)*REWARD-totalFee);
  assert.equal(node.utxos.get(funding).value,100n*KAS);assert.equal(round.fees,totalFee);
}
for(const cnt of [17,40])test(`simulated ${cnt}-shard payout: disjoint batches, recipient amounts, public executor and final deposit`,()=>multiPayoutScenario(cnt));
async function multiRefundScenario(real=false) {
  const env=await setup({real}),{node,ctl,roundStore}=env,f=fixture({module:'refund',cnt:3,local:35,r:0,c:224,per:2});
  const cid=await restore(ctl,node,f);ctl.usePublicAddress(WALLET.address);
  const point=x=>`${x.transactionId}:${x.index}`,ownerScript=p2pk(f.s.ownerKey).script;
  const balance=script=>[...node.utxos.values()].filter(u=>!u.covenantId&&u.spk.script===script).reduce((n,u)=>n+u.value,0n);
  const executorBefore=balance(WALLET.spk.script),expectedBuyerTotals=new Map(),live=new Map(f.targets.map((t,j)=>[j,{outpoint:t.outpoint,value:t.value}]));
  let shard=0,cursor=224,oldBatches=0,totalFee=0n,round;
  while(shard<3) {
    const before=(await roundStore.get(cid)).round,original=f.targets[shard],target=live.get(shard),records=identify(original.redeemScript,profile).records.slice(cursor,cursor+32);
    round=await runAccepted(env,{action:'REFUND_OLD'},cid,p=>{
      const tx=p.draft.transaction;assert.equal(p.targetCount,1);assert.deepEqual(p.draft.authorizedInputIndices,[]);
      assert.deepEqual(tx.inputs.map(i=>point(i.previousOutpoint)),[point(before.manager.outpoint),point(target.outpoint)]);
      assert.equal(p.draft.inputUtxos[1].value,target.value);totalFee+=p.draft.fee;
      const refunds=tx.outputs.filter(o=>!o.covenant&&o.scriptPublicKey.script!==WALLET.spk.script);
      assert.equal(refunds.length,32);
      for(let n=0;n<32;n++) {
        const script=p2pk(records[n].key).script;assert.equal(refunds[n].scriptPublicKey.script,script);assert.equal(refunds[n].value,2n*PRICE-REFUND_FEE);
        expectedBuyerTotals.set(script,(expectedBuyerTotals.get(script)??0n)+2n*PRICE-REFUND_FEE);
      }
      const executor=tx.outputs.find(o=>!o.covenant&&o.scriptPublicKey.script===WALLET.spk.script);
      assert.equal(executor.value,32n*REFUND_FEE-p.draft.fee);
      assert.equal(p.draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-tx.outputs.reduce((n,o)=>n+o.value,0n),p.draft.fee);
    });
    oldBatches++;cursor+=32;
    if(cursor===256){live.delete(shard);shard++;cursor=0;}
    else {
      const replacement=round.frozen.find(z=>z.spk.script===original.spk.script);assert.ok(replacement);assert.equal(replacement.outpoint.transactionId,round.receipts.at(-1).txid);
      assert.equal(replacement.value,BigInt(256-cursor)*2n*PRICE);live.set(shard,{outpoint:replacement.outpoint,value:replacement.value});
    }
    const facts=(await ctl.describe(cid)).facts;assert.equal(facts.refundShard,shard);assert.equal(facts.refundCursor,cursor);
    assert.equal(round.manager.value,DEPOSIT+70n*PRICE);assert.equal(round.frozen.length,live.size);
    for(let j=shard+1;j<3;j++){const u=node.utxos.get(point(f.targets[j].outpoint));assert.ok(u);assert.equal(u.value,f.targets[j].value);assert.deepEqual(u.spk,f.targets[j].spk);}
  }
  assert.equal(oldBatches,17);assert.equal((await ctl.describe(cid)).actions.REFUND_OLD.ok,false);
  if(real)ctl.openWallet(SECRET); // Also exercise explicitly funded local refunds against the real engine.
  for(const count of [32,3]) {
    round=await runAccepted(env,{action:'REFUND_SELF'},cid,p=>{
      assert.equal(p.draft.transaction.inputs.length,real?2:1);assert.deepEqual(p.draft.authorizedInputIndices,real?[1]:[]);totalFee+=p.draft.fee;
      const buyers=p.draft.transaction.outputs.filter(o=>!o.covenant&&o.scriptPublicKey.script!==WALLET.spk.script&&o.scriptPublicKey.script!==ownerScript);
      assert.equal(buyers.length,count);
      const script=p2pk(f.s.records[0].key).script;
      for(const buyer of buyers){assert.equal(buyer.scriptPublicKey.script,script);assert.equal(buyer.value,2n*PRICE-REFUND_FEE);expectedBuyerTotals.set(script,(expectedBuyerTotals.get(script)??0n)+buyer.value);}
    });
    if(count===32){assert.equal(round.manager.value,DEPOSIT+6n*PRICE);assert.equal((await ctl.describe(cid)).facts.refundCursor,32);assert.equal(round.terminal,null);}
  }
  assert.equal(round.terminal,'REFUNDED');assert.equal(round.manager,null);assert.equal(round.frozen.length,0);
  for(const[script,value]of expectedBuyerTotals)assert.equal(balance(script),value);
  assert.equal(balance(ownerScript),DEPOSIT-REFUND_FEE);
  assert.equal(balance(WALLET.spk.script)-executorBefore,580n*REFUND_FEE-totalFee);
  if(real)assert.equal(node.utxos.has('a1'.repeat(32)+':0'),false);else assert.equal(node.utxos.get('a1'.repeat(32)+':0').value,100n*KAS);
  assert.equal(round.fees,totalFee);
}
test('simulated refund: shard-end crossing, replacement frozen outpoints, two-ticket records and a partial local batch',()=>multiRefundScenario());

test('simulated public refund resource boundary: refuse before submission, then settle with an explicitly funded key wallet',async()=>{
  const env=await setup(),{node,ctl,roundStore}=env,f=fixture({module:'refund',cnt:3,local:33,r:3,c:32,per:2});
  f.targets=[]; // all old shards were already refunded; only the final local record remains
  const cid=await restore(ctl,node,f);ctl.usePublicAddress(WALLET.address);
  await assert.rejects(()=>ctl.prepare({action:'REFUND_SELF'},cid),/STORAGE_MASS_LIMIT/);
  assert.equal(node.calls.includes('submitTransaction'),false);assert.equal(ctl.state.prepared,null);
  assert.equal((await roundStore.get(cid)).round.intent,null);assert.equal(node.utxos.get('a1'.repeat(32)+':0').value,100n*KAS);
  ctl.openWallet(SECRET);let fee;
  const round=await runAccepted(env,{action:'REFUND_SELF'},cid,p=>{
    assert.deepEqual(p.draft.authorizedInputIndices,[1]);assert.equal(p.draft.transaction.inputs.length,2);fee=p.draft.fee;
    assert.equal(p.draft.inputUtxos.reduce((n,u)=>n+u.value,0n)-p.draft.transaction.outputs.reduce((n,o)=>n+o.value,0n),fee);
  });
  const balance=key=>[...node.utxos.values()].filter(u=>!u.covenantId&&u.spk.script===p2pk(key).script).reduce((n,u)=>n+u.value,0n);
  assert.equal(round.terminal,'REFUNDED');assert.equal(round.manager,null);assert.equal(node.utxos.has('a1'.repeat(32)+':0'),false);
  assert.equal(balance(f.s.records[32].key),2n*PRICE-REFUND_FEE);assert.equal(balance(f.s.ownerKey),DEPOSIT-REFUND_FEE);
  assert.equal(balance(WALLET.key),100n*KAS+2n*REFUND_FEE-fee);
});

async function timeoutRefundScenario(real=false) {
  const {node,ctl,roundStore,realVm}=await setup({real,daa:500000});
  // TIMEOUT: only once the 432000-DAA window after the close has passed; needs a funded (key) wallet
  const sealed=fixture({module:'sealed',local:3}),cid=await restore(ctl,node,sealed);
  assert.equal((await ctl.describe(cid)).actions.TIMEOUT.ok,true);
  let r=await runAccepted({node,ctl,roundStore,realVm},{action:'TIMEOUT'},cid);
  assert.equal((await ctl.describe(cid)).facts.module,'refund');
  // REFUND_OLD: one old shard per transaction (32 refunds), permissionless -> public address only
  const refund=fixture({module:'refund',cnt:1,local:3,r:0,c:0}),cid2=await restore(ctl,node,refund);
  ctl.usePublicAddress(WALLET.address);
  assert.equal((await ctl.describe(cid2)).actions.REFUND_OLD.ok,true);
  r=await runAccepted({node,ctl,roundStore,realVm},{action:'REFUND_OLD'},cid2);
  assert.equal((await ctl.describe(cid2)).facts.refundCursor,32);assert.equal(r.frozen.length,1);
  assert.equal(r.frozen[0].value,refund.targets[0].value-32n*PRICE); // the shard keeps what has not been refunded yet
}
test('TIMEOUT (after the window) and REFUND_OLD (public address) via imported state',()=>timeoutRefundScenario());
test('import cannot overwrite a local unresolved intent and rejects tampered or foreign state',async()=>{
  const {node,ctl,roundStore}=await setup();
  node.failSubmit='lost';await ctl.prepare({action:'GENESIS',settings:settings()});await ctl.signAndSend();
  const cid=(await ctl.rounds())[0].cid,text=await ctl.exportText(cid);
  assert.match(text,/"status": "UNKNOWN"/);
  const ok=await ctl.importText(text);assert.equal(ok,cid); // same intent: allowed (idempotent)
  const doc=decodeTagged(text);doc.intent.draft.transaction.inputs[0].signatureScript='41'+'00'.repeat(64)+'01'; // damaged witness
  await assert.rejects(()=>ctl.importText(encodeTagged(doc)),/INTENT_CONTENT_CHANGED|SIGNATURE_INVALID/);
  const doc2=decodeTagged(text);doc2.intent.draft.transaction.outputs[0].value+=1n;
  await assert.rejects(()=>ctl.importText(encodeTagged(doc2)));
  await assert.rejects(()=>ctl.importText('{"v":1,"network":"mainnet"}'));
  assert.equal((await roundStore.get(cid)).round.intent.status,'UNKNOWN');
});

// --- Same flows, but budgets/verification come from the REAL pinned script engine through the real HTTP service (needs KASWIN_VM_BIN) ---
/* --- double-spend conflicts (2026-11-15; written, NOT_RUN) ---------------------------------------------------------------------------------
 * Origin: two harness runs shared one wallet; each page profile reserved only its own inputs, picked the same largest UTXO, and the node answered
 * "output (txid, i) already spent by transaction … in the mempool". The page neither avoided the input nor recognised the rejection. */
test('same wallet in two pages: the second page skips an input the mempool already spends (WALLET_FUNDS_PENDING), then uses the change once it confirms',async()=>{
  const node=new FakeNode({daa:5000}),A=user(node,SECRET),B=user(node,SECRET); // same wallet, separate stores: B cannot see A's reserved inputs
  for(const u of [A,B]){await u.ctl.connectNode(['wss://fake-tn10.invalid/wrpc']);u.ctl.openWallet(u.secret);}
  await A.ctl.prepare({action:'GENESIS',settings:settings()});
  assert.equal(await A.ctl.signAndSend(),'SUBMITTED'); // spends the wallet's only UTXO; still unconfirmed
  await assert.rejects(()=>B.ctl.prepare({action:'GENESIS',settings:settings({ticketPrice:'2'})}),/WALLET_FUNDS_PENDING/); // before: picked the same input, node rejected at send
  node.mine(1); // A's transaction is accepted; its change output is now a confirmed UTXO
  await B.ctl.prepare({action:'GENESIS',settings:settings({ticketPrice:'2'})});
  assert.ok(B.ctl.state.prepared);
});
test('mempool query unavailable: selection falls back, the node rejects at send, and the rejection is classified as a wallet-funds conflict naming the other transaction',async()=>{
  const node=new FakeNode({daa:5000}),A=user(node,SECRET),B=user(node,SECRET);
  node.noMempoolQuery=true;
  for(const u of [A,B]){await u.ctl.connectNode(['wss://fake-tn10.invalid/wrpc']);u.ctl.openWallet(u.secret);}
  await A.ctl.prepare({action:'GENESIS',settings:settings()});const txA=A.ctl.state.prepared.review.txid;
  assert.equal(await A.ctl.signAndSend(),'SUBMITTED');
  await B.ctl.prepare({action:'GENESIS',settings:settings({ticketPrice:'2'})}); // different outputs => different txid, same funding outpoint
  assert.equal(await B.ctl.signAndSend(),'REJECTED');
  const cid=(await B.ctl.rounds())[0].cid,intent=(await B.roundStore.get(cid)).round.intent;
  assert.match(intent.nodeError,/output \([0-9a-f]{64}, 0\) already spent by transaction [0-9a-f]{64} in the mempool/);
  const k=classifyRejection(intent);
  assert.equal(k.kind,'FUNDS_INPUT');assert.equal(k.spender,txA);
  assert.ok(B.ctl.state.logs.some(l=>/资金输入.*占用/.test(l.text))); // the log names the cause
});
test('mempoolSpentOutpoints: collects every outpoint the address\' pending transactions spend; malformed entries and a failing node yield nothing extra',async()=>{
  const T='a'.repeat(64);
  const rpc={async call(m,p){assert.equal(m,'getMempoolEntriesByAddresses');assert.deepEqual(p.addresses,['kaspatest:x']);
    return {entries:[{address:'kaspatest:x',receiving:[],sending:[{transaction:{inputs:[{previousOutpoint:{transactionId:T,index:0}},{previousOutpoint:{transactionId:T,index:2}}]}},
      {transaction:{inputs:[{previousOutpoint:{transactionId:'not-an-outpoint'}},{}]}},{}]}]};}};
  assert.deepEqual([...await mempoolSpentOutpoints(rpc,'kaspatest:x')].sort(),[`${T}:0`,`${T}:2`]);
  assert.equal((await mempoolSpentOutpoints({async call(){throw new Error('boom');}},'kaspatest:x')).size,0);
  assert.equal((await mempoolSpentOutpoints({async call(){return {};}},'kaspatest:x')).size,0);
});
test('classifyRejection: reads the node wording; foreign outpoints and unknown text are never guessed',()=>{
  const T='a'.repeat(64),S='b'.repeat(64),F='c'.repeat(64),C='d'.repeat(64);
  const msg=(o,i)=>`submitTransaction: Rejected transaction ${F}: output (${o}, ${i}) already spent by transaction ${S} in the mempool`;
  const draft={inputUtxos:[{outpoint:{transactionId:T,index:0},covenantId:C},{outpoint:{transactionId:F,index:1},covenantId:null}]};
  assert.deepEqual(classifyRejection({nodeError:msg(T,0),draft}),{kind:'ROUND_INPUT',spender:S,outpoint:`${T}:0`});
  assert.deepEqual(classifyRejection({nodeError:msg(F,1),draft}),{kind:'FUNDS_INPUT',spender:S,outpoint:`${F}:1`});
  assert.equal(classifyRejection({nodeError:msg(T,1),draft}).kind,'OTHER'); // not one of the inputs we signed
  assert.equal(classifyRejection({nodeError:`submitTransaction: Rejected transaction ${F}: transaction ${F} is an orphan where orphan is disallowed`}).kind,'ORPHAN');
  assert.equal(classifyRejection({nodeError:'submitTransaction: rejected by the fake node',draft}).kind,'OTHER');
  assert.equal(classifyRejection({draft}).kind,'OTHER');assert.equal(classifyRejection(null).kind,'OTHER');
});

test('background verification leaves actions available; a click reserves foreground busy immediately and repeated verification shares the active read',async()=>{
  const {node,ctl,roundStore}=await setup();
  const round=await runAccepted({node,ctl,roundStore},{action:'GENESIS',settings:settings()});
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),call=node.call.bind(node);
  let held=false;
  node.call=async(method,...args)=>{
    if(method==='getUtxosByAddresses'&&!held){held=true;entered.resolve();await release.promise;}
    return call(method,...args);
  };
  const verify=ctl.verifyLive(round.cid);
  await entered.promise;
  let prepared,again;
  try {
    assert.equal(ctl.state.busy,false,'background node I/O must not disable transaction actions');
    again=ctl.verifyLive(round.cid); // same read is reused; it must not run later and reject on an obsolete record
    prepared=ctl.prepare({action:'BUY',quantity:'1'},round.cid);
    assert.equal(ctl.state.busy,true,'the click reserves the operation before its first await');
    assert.equal(ctl.state.busyLabel,'准备交易');
    await assert.rejects(()=>ctl.prepare({action:'BUY',quantity:'1'},round.cid),/BUSY/);
  } finally {release.resolve();}
  await Promise.all([verify,again,prepared]);
  assert.equal(ctl.state.prepared.op.action,'BUY');assert.equal(ctl.state.busy,false);assert.equal(ctl.state.busyLabel,null);
});

test('pending recheck stays single-writer with preparation, promotes once, and foreground work precedes queued background verification',async()=>{
  const {node,ctl,roundStore}=await setup();
  await ctl.prepare({action:'GENESIS',settings:settings()});const cid=ctl.state.prepared.cid;
  await ctl.signAndSend();node.mine(1);await ctl.track(cid);node.mine(11);
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),call=node.call.bind(node);
  let held=false;
  node.call=async(method,...args)=>{
    if(method==='getBlock'&&!held){held=true;entered.resolve();await release.promise;}
    return call(method,...args);
  };
  const checking=ctl.track(cid);await entered.promise;
  let duplicate,verifying,prepared;
  try {
    assert.equal(ctl.state.busy,false);
    duplicate=ctl.track(cid);
    verifying=ctl.verifyLive(cid); // queued first, but the following click must take priority
    prepared=ctl.prepare({action:'BUY',quantity:'1'},cid);
    assert.equal(ctl.state.busy,true);
  } finally {release.resolve();}
  const [first,second]=await Promise.all([checking,duplicate,verifying,prepared]);
  assert.equal(first.pending.finalized,1);assert.equal(second.pending.finalized,1);
  const saved=(await roundStore.get(cid)).round;
  assert.equal(saved.pending.length,0);assert.equal(saved.receipts.length,1);assert.equal(saved.receipts[0].finalized,true);
  assert.equal(saved.intent,null);assert.ok(ctl.state.prepared);
  const texts=ctl.state.logs.map(l=>l.text),lastDraft=texts.findLastIndex(x=>x.startsWith('草案已生成：')),lastVerify=texts.findLastIndex(x=>x.startsWith('链上核对通过：'));
  assert.ok(lastDraft<lastVerify,'the user operation must run before queued background verification');
});

test('a failed background check releases the single-writer queue and the queued click still prepares a transaction',async()=>{
  const {node,ctl,roundStore}=await setup();
  const round=await runAccepted({node,ctl,roundStore},{action:'GENESIS',settings:settings()});
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),call=node.call.bind(node);
  let held=false;
  node.call=async(method,...args)=>{
    if(method==='getUtxosByAddresses'&&!held){held=true;entered.resolve();await release.promise;throw new Error('RPC_TIMEOUT');}
    return call(method,...args);
  };
  const checked=assert.rejects(()=>ctl.verifyLive(round.cid),/RPC_TIMEOUT/);
  await entered.promise;
  const prepared=ctl.prepare({action:'BUY',quantity:'1'},round.cid);
  release.resolve();await Promise.all([checked,prepared]);
  assert.equal(ctl.state.prepared.op.action,'BUY');assert.equal(ctl.state.busy,false);
});

const engineTest=(name,fn)=>test(name,{skip:!process.env.KASWIN_VM_BIN,timeout:600000},fn);
for(const cnt of [17,40])engineTest(`REAL ENGINE: multi-batch ${cnt}-shard payout with simulated node`,()=>multiPayoutScenario(cnt,true));
engineTest('REAL ENGINE: cross-shard refund cursor and funded residual with simulated node',()=>multiRefundScenario(true));
engineTest('REAL ENGINE: create -> BUY -> CLOSE -> REFUND_SELF through local calibrated budgets',()=>refundScenario(true));
engineTest('REAL ENGINE: imported win state, PAY_OLD (2 shards) then PAY_SELF with a public address',()=>payoutScenario(true));
engineTest('REAL ENGINE: TIMEOUT and REFUND_OLD via imported state',()=>timeoutRefundScenario(true));
engineTest('REAL ENGINE: sealed phase transition (CLOSE at/above the minimum) validates',async()=>{
  const {node,ctl,roundStore,realVm}=await setup({real:true});
  let r=await runAccepted({node,ctl,roundStore,realVm},{action:'GENESIS',settings:settings()});
  r=await runAccepted({node,ctl,roundStore,realVm},{action:'BUY',quantity:'3'},r.cid);
  r=await runAccepted({node,ctl,roundStore,realVm},{action:'CLOSE'},r.cid);
  assert.equal((await ctl.describe(r.cid)).facts.module,'sealed');assert.equal(r.terminal,null);
});

test('GENESIS registry option supports default V2.0.2 address, custom TN10 address, opt-out, and rejects invalid addresses',async()=>{
  const {ctl}=await setup();
  await ctl.prepare({action:'GENESIS',settings:settings()});
  let reg=ctl.state.prepared.review.outputs.filter(o=>o.role==='REGISTRATION');
  assert.equal(reg.length,1);
  assert.equal(reg[0].value,20_000_000n);
  assert.equal(reg[0].script,'2096390521e27482c9ded675d215e5156379b42ca6fa0b5b23d7075ccc5efffa38ac');
  ctl.discardPrepared();

  const customAddr='kaspatest:qz5ksvzrlr5qjkltejvadpvc2u36d5u7ul2krjqfh9jpzm5jk5f2cpctvz792';
  await ctl.prepare({action:'GENESIS',registry:customAddr,settings:settings()});
  reg=ctl.state.prepared.review.outputs.filter(o=>o.role==='REGISTRATION');
  assert.equal(reg.length,1);
  assert.equal(reg[0].script,'20a9683043f8e8095bebcc99d685985723a6d39ee7d561c809b964116e92b512acac');
  ctl.discardPrepared();

  await ctl.prepare({action:'GENESIS',registry:false,settings:settings()});
  reg=ctl.state.prepared.review.outputs.filter(o=>o.role==='REGISTRATION');
  assert.equal(reg.length,0);
  ctl.discardPrepared();

  await assert.rejects(()=>ctl.prepare({action:'GENESIS',registry:'not-an-address',settings:settings()}),/REGISTRY_ADDRESS/);
});
