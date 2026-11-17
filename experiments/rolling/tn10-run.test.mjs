import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,profile,PRICE} from './fixtures.mjs';
import {prepare,advance,authenticateIntent,requiredFee,plan} from './tn10-run.mjs';
import {decodeTestWallet} from './test-signer.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {txToRpc} from '../../scripts/chain/nodes.mjs';
import {jsonText} from '../../scripts/chain/json.mjs';
import {TN10_PROFILE_ID} from './deployment-profile.mjs';
import {pubkeyToAddress} from '../../scripts/wallet/address.mjs';
import {p2pk} from '../../scripts/core/lib/covenant-id.js';
import {schnorrSign,xonlyPubkey} from '../../scripts/wallet/schnorr.mjs';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {hex} from './state.mjs';
import {quoteMass} from './mass.mjs';
const sk=createHash('sha256').update('kaswin-runner-offline-public-test-key').digest(),key=hex(xonlyPubkey(sk));
const signer={key,address:pubkeyToAddress(key,'kaspatest'),async sign(d){for(const i of d.authorizedInputIndices)d.transaction.inputs[i].signatureScript='41'+hex(schnorrSign(sk,schnorrSighash(d.transaction,d.inputUtxos,i)))+'01';}};
const funding={outpoint:{transactionId:'ab'.repeat(32),index:0},value:1000n*PRICE,spk:p2pk(key),daa:100n};
function rpcWith(inputs) {return {net:{addressPrefix:'kaspatest',...{}},async call(method,{addresses}) {
 assert.equal(method,'getUtxosByAddresses');
 return {entries:inputs.map(u=>({address:addresses[0],outpoint:u.outpoint,utxoEntry:{amount:u.value,scriptPublicKey:'0000'+u.spk.script,blockDaaScore:u.utxoDaa??u.daa,isCoinbase:false,covenantId:u.cid??null}}))};
 }};}
// verifyInputsLive requires the actual, validated network definition, not just a prefix.
import {TN10} from '../../scripts/chain/tn10.mjs';
const engineTest=(n,f)=>test(n,{skip:!process.env.KASWIN_VM_BIN},f);
test('larger TN10 plans cross the PAY_OLD batch limit and the third refund shard without changing the profile',()=>{
 const payout=plan('batch-payout'),refund=plan('three-shard-refund');
 assert.equal(Math.floor((payout.buys-1)/256),17);assert.equal(payout.tailQuantity,3);
 assert.equal(payout.buys-1+payout.tailQuantity,payout.ticketCap);assert.equal(payout.ticketCap,4355);
 assert.equal(Math.ceil(17/16),2);
 assert.equal(Math.floor((refund.buys-1)/256),3);assert.equal(refund.tailQuantity,3);
 assert.ok(refund.buys-1+refund.tailQuantity<refund.minTickets);
 assert.throws(()=>plan('timeout'),/SCENARIO/);
});
test('invalid wallet JSON never exposes source text in parser errors',()=>{
 assert.throws(()=>decodeTestWallet('{"privateKey":"sensitive-example",BAD'),e=>e.message==='TEST_WALLET_READ_FAILED');
});
test('fee calculation uses decimal arithmetic and respects relay floor',()=>{
 assert.equal(requiredFee({orderingMass:999n,relayFloor:100000n},'200.125'),199925n);
 assert.equal(requiredFee({orderingMass:1n,relayFloor:100000n},'1'),100000n);
});
engineTest('prepare GENESIS converges fee, commits storage mass, and executes its signed ordinary input',async()=>{
 const rpc=rpcWith([funding]);rpc.net=TN10;
 const p=await prepare(rpc,{closeEligibleDaa:1000n},profile,{action:'GENESIS'},signer,{ticketCap:3,minTickets:3});
 const q=quoteMass(p.draft);assert.equal(p.draft.transaction.storageMass,q.storageMass);assert.ok(p.draft.fee>=q.orderingMass*100n);
 assert.equal(p.engine.inputs.length,1);assert.equal(p.engine.inputs[0].limitedOk,true);
 const intent={network:TN10.networkId,profileId:TN10_PROFILE_ID,draft:p.draft,txid:referenceTxId(p.draft.transaction),wireDigest:createHash('sha256').update(jsonText(txToRpc(p.draft.transaction))).digest('hex')};
 authenticateIntent(intent);
 p.draft.transaction.inputs[0].signatureScript='00';
 assert.equal(referenceTxId(p.draft.transaction),intent.txid); // txid alone does not bind witness bytes
 assert.throws(()=>authenticateIntent(intent),/INTENT_CONTENT_CHANGED/);
});
engineTest('prepare BUY freeze commits a manager and frozen shard; advance records only authenticated outputs',async()=>{
 const f=fixture({module:'sales',local:255});const rpc=rpcWith([funding,f.manager]);rpc.net=TN10;
 const state={manager:f.manager,frozen:[],fees:0n,step:0,buys:255,bought:255,receipts:[]};
 const p=await prepare(rpc,state,profile,{action:'BUY',quantity:1},signer,{});
 assert.equal(p.engine.inputs.length,2);assert.ok(p.engine.inputs.every(x=>x.limitedOk));
 const txid='cd'.repeat(32),receipt={txid,acceptingDaa:500010n,observedVirtualDaa:500110n,acceptingBlock:'ef'.repeat(32),actualFee:p.draft.fee,nodeComputeMass:p.mass.computeMass,storageMass:p.mass.storageMass};
 advance(state,{...p,action:'BUY',quantity:1},receipt,profile);
 assert.equal(state.buys,256);assert.equal(state.frozen.length,1);assert.equal(state.frozen[0].value,256n*PRICE);assert.equal(state.manager.value,400000000n);assert.equal(state.intent,null);
});
