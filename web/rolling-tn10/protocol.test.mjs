import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fixture,fund,profile,PRICE,FEE} from '../../experiments/rolling/fixtures.mjs';
import {buildAction} from '../../experiments/rolling/transactions.mjs';
import {toWire,parseWire,requestDigest,draftTxid,checkServiceReply,LIMITS,TN10_PROFILE_ID} from './protocol.mjs';
import {openMemoryWallet} from './wallet.mjs';
import {TN10_PROFILE_ID as DEPLOYED} from '../../experiments/rolling/deployment-profile.mjs';

const pin=JSON.parse(readFileSync(new URL('../../experiments/rolling/engine-pin.json',import.meta.url),'utf8')).binarySha256;
const sk=createHash('sha256').update('rolling-tn10-protocol-test-key').digest('hex');
const wallet=openMemoryWallet(sk);
const buy=()=>{const f=fixture({module:'sales'});return buildAction(f.manager,profile,{action:'BUY',quantity:1,actorKey:wallet.key},{funds:[fund(2,10n*PRICE,wallet.key)],fee:FEE,budgets:[10,10]});};
const clone=x=>structuredClone(x);
const replyFor=(wire,over={})=>{
  const {draft}=parseWire(wire),auth=new Set(draft.authorizedInputIndices);
  const idx=wire.mode==='measure'?draft.transaction.inputs.flatMap((_,i)=>auth.has(i)?[]:[i]):draft.transaction.inputs.map((_,i)=>i);
  return {schema:1,ok:true,mode:wire.mode,network:'testnet-10',profileId:TN10_PROFILE_ID,requestDigest:requestDigest(wire),txid:draftTxid(draft),
    engine:{binarySha256:pin},advisory:true,offlineScriptCheck:true,notConsensus:true,
    inputs:idx.map(i=>({input:i,ok:true,limitedOk:true,minBudget:3,usedScriptUnits:1})),...over};
};
test('client Profile constant equals the deployment loader constant',()=>assert.equal(TN10_PROFILE_ID,DEPLOYED));
test('wire encodes only strings/ints, round-trips canonically and is strict',()=>{
  const d=buy(),w=toWire('measure',d),p=parseWire(JSON.parse(JSON.stringify(w)));
  assert.equal(draftTxid(p.draft),draftTxid(d));assert.deepEqual(p.draft.authorizedInputIndices,[1]);
  assert.doesNotThrow(()=>JSON.stringify(w)); // JSON.stringify throws on any leaked bigint
  const bad=(mut,re)=>{const x=clone(w);mut(x);assert.throws(()=>parseWire(x),re);};
  bad(x=>{x.extra=1;},/WIRE_SHAPE/);
  bad(x=>{delete x.accessor;},/WIRE_SHAPE/);
  bad(x=>{x.network='mainnet';},/WIRE_NETWORK/);
  bad(x=>{x.profileId='00'.repeat(32);},/WIRE_PROFILE/);
  bad(x=>{x.transaction.inputs[0].signatureScript=x.transaction.inputs[0].signatureScript.toUpperCase();},/WIRE_/);
  bad(x=>{x.transaction.outputs[0].value='1e9';},/WIRE_OUTPUT_VALUE/);
  bad(x=>{x.transaction.outputs[0].value='01';},/WIRE_OUTPUT_VALUE/);
  bad(x=>{x.transaction.inputs[1].signatureScript='41'+'aa'.repeat(64)+'01';},/WIRE_ORDINARY_WITNESS/); // unsigned mode forbids a witness
  bad(x=>{x.transaction.inputs[0].signatureScript='';},/WIRE_COVENANT_WITNESS/);
  bad(x=>{x.authorizedInputIndices=[1,1];},/WIRE_AUTH_ORDER/);
  bad(x=>{x.authorizedInputIndices=[5];},/WIRE_AUTH_INDEX/);
  bad(x=>{x.inputUtxos.pop();},/WIRE_UTXO_COUNT/);
  bad(x=>{x.transaction.inputs[0].signatureScript='aa'.repeat(LIMITS.sigScriptBytes+1);},/WIRE_SIGSCRIPT_SIZE/);
  bad(x=>{x.transaction.gas='1';},/WIRE_NATIVE_ONLY/);
  bad(x=>{x.transaction.version=0;},/WIRE_TX_VERSION/);
  bad(x=>{x.accessor={blockHash:'zz',sequenceCommitment:'00'.repeat(32)};},/WIRE_ACCESSOR/);
  const proto=JSON.parse(JSON.stringify(w).replace('"schema":1','"__proto__":{"a":1},"schema":1'));
  assert.throws(()=>parseWire(proto),/WIRE_SHAPE/);
});
test('digest binds every part of the request (witness, budget, utxo, accessor, mode)',()=>{
  const d=buy(),base=toWire('verify',{...d,transaction:{...d.transaction,inputs:d.transaction.inputs.map((i,n)=>n===1?{...i,signatureScript:'41'+'11'.repeat(64)+'01'}:i)}});
  const digest=requestDigest(base);
  const variants=[w=>{w.transaction.inputs[1].signatureScript='41'+'22'.repeat(64)+'01';},w=>{w.transaction.inputs[0].computeBudget++;},w=>{w.inputUtxos[0].daa='1';},
    w=>{w.accessor={blockHash:'11'.repeat(32),sequenceCommitment:'22'.repeat(32)};},w=>{w.mode='measure';},w=>{w.transaction.lockTime='7';},w=>{w.transaction.storageMass='1';}];
  const seen=new Set([digest]);
  for(const v of variants){const w=clone(base);v(w);const x=requestDigest(w);assert.ok(!seen.has(x));seen.add(x);}
  assert.equal(requestDigest(clone(base)),digest);
});
test('service replies are accepted only when bound to the exact request',()=>{
  const d=buy(),wire=toWire('measure',d),good=replyFor(wire);
  assert.deepEqual(checkServiceReply(wire,good,{enginePin:pin}).inputs,[{input:0,minBudget:3,usedScriptUnits:1}]);
  const other=toWire('measure',{...d,fee:d.fee});other.transaction.lockTime='0';
  const bad=(over,re)=>assert.throws(()=>checkServiceReply(wire,{...good,...over},{enginePin:pin}),re);
  bad({requestDigest:'00'.repeat(32)},/REPLY_DIGEST_MISMATCH/);
  bad({txid:'00'.repeat(32)},/REPLY_TXID_MISMATCH/);
  bad({mode:'verify'},/REPLY_SCOPE/);bad({network:'mainnet'},/REPLY_SCOPE/);bad({ok:false},/REPLY_NOT_OK/);
  bad({advisory:false},/REPLY_NOT_ADVISORY/);bad({inputs:[]},/REPLY_INPUT_COVERAGE/);
  bad({inputs:[{input:1,ok:true,minBudget:3,usedScriptUnits:1}]},/REPLY_INPUT/);
  bad({engine:{binarySha256:'ab'.repeat(32)}},/REPLY_ENGINE_PIN/);
  // A reply for another quote of the same transaction family cannot be reused.
  const budgetChanged=clone(wire);budgetChanged.transaction.inputs[0].computeBudget=1;
  assert.throws(()=>checkServiceReply(budgetChanged,good,{enginePin:pin}),/REPLY_DIGEST_MISMATCH/);
  assert.ok(other);
});
test('verify replies must cover ALL inputs and show the committed budget sufficed',async()=>{
  const d=buy();await wallet.sign(d);
  const wire=toWire('verify',d),good=replyFor(wire);
  assert.equal(checkServiceReply(wire,good,{enginePin:pin}).inputs.length,2);
  assert.throws(()=>checkServiceReply(wire,{...good,inputs:good.inputs.slice(1)},{enginePin:pin}),/REPLY_INPUT_COVERAGE/);
  assert.throws(()=>checkServiceReply(wire,{...good,inputs:good.inputs.map(x=>({...x,minBudget:11}))},{enginePin:pin}),/REPLY_LIMITED/);
  assert.throws(()=>checkServiceReply(wire,{...good,inputs:good.inputs.map(x=>({...x,limitedOk:false}))},{enginePin:pin}),/REPLY_LIMITED/);
});
