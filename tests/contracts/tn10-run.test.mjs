import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,profile,PRICE} from './fixtures.mjs';
import {prepare,advance,authenticateIntent,requiredFee,plan,saveRunState,loadRunState,readAllReceipts,selectOldShardBatch,stepFile,selectBuyerRole,selectBuyerKey} from './tn10-run.mjs';
import {resolvePhaseList,buildConsolidationDraft,normalizeConsolidationDraft,isTransientRunError} from './tn10-large-campaign.mjs';
import {decodeTestWallet,createDerivedBuyerPoolFromSecret} from './test-signer.mjs';
import {buildAction} from '../../scripts/core.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {txToRpc,txFromRpc,spkText} from '../../scripts/chain/nodes.mjs';
import {matchesDraft} from '../../scripts/chain/chain.mjs';
import {jsonText} from '../../scripts/chain/json.mjs';
import {TN10_PROFILE_ID} from '../../scripts/contract/bundle.mjs';
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
 const payout=plan('batch-payout'),refund=plan('three-shard-refund'),eight=plan('eight-shard-refund'),nineRefund=plan('nine-shard-refund'),seventeen=plan('seventeen-shard-refund');
 const ninePayout=plan('nine-shard-payout'),seventeenPayout=plan('seventeen-shard-payout'),full=plan('full-payout'),fullRefund=plan('full-refund');
 assert.equal(Math.floor((payout.buys-1)/256),17);assert.equal(payout.tailQuantity,3);
 assert.equal(payout.buys-1+payout.tailQuantity,payout.ticketCap);assert.equal(payout.ticketCap,4355);
 assert.equal(Math.ceil(17/16),2);
 assert.equal(Math.floor((refund.buys-1)/256),3);assert.equal(refund.tailQuantity,3);
 assert.ok(refund.buys-1+refund.tailQuantity<refund.minTickets);
 assert.equal(Math.floor((eight.buys-1)/256),8);assert.ok(eight.buys-1+eight.tailQuantity<eight.minTickets);
 assert.equal(Math.floor((nineRefund.buys-1)/256),9);assert.equal(nineRefund.buys,2305);assert.ok(nineRefund.buys-1+nineRefund.tailQuantity<nineRefund.minTickets);
 assert.equal(Math.floor((seventeen.buys-1)/256),17);assert.equal(seventeen.buys,4353);assert.ok(seventeen.buys-1+seventeen.tailQuantity<seventeen.minTickets);
 assert.equal(Math.floor((ninePayout.buys-1)/256),9);assert.equal(ninePayout.payoutBatch,8);assert.equal(ninePayout.ticketCap,2307);
 assert.equal(Math.floor((seventeenPayout.buys-1)/256),17);assert.equal(seventeenPayout.payoutBatch,16);assert.equal(seventeenPayout.ticketCap,4355);
 assert.equal(full.buys,65536);assert.equal(full.ticketCap,65536);assert.equal(full.minTickets,3);assert.equal(full.payoutBatch,16);assert.equal(full.defaultMaxSteps,70000);
 assert.equal(fullRefund.buys,65536);assert.equal(fullRefund.minTickets,65537);assert.equal(fullRefund.ticketCap,65537);
 assert.ok(fullRefund.minTickets<=fullRefund.ticketCap&&fullRefund.buys*fullRefund.quantity<fullRefund.minTickets);
 assert.throws(()=>plan('timeout'),/SCENARIO/);
});
test('selectOldShardBatch respects 8-shard and 16-shard PAY_OLD limits while keeping REFUND_OLD single-shard',()=>{
 const win9=fixture({module:'win',cnt:9,local:3,p:0});
 const b8First=selectOldShardBatch({frozen:win9.targets,payoutBatch:8},win9.s,profile,plan('nine-shard-payout'));
 assert.equal(b8First.action,'PAY_OLD');assert.equal(b8First.targets.length,8);
 const win9Tail=fixture({module:'win',cnt:9,local:3,p:8});
 const b8Second=selectOldShardBatch({frozen:win9Tail.targets,payoutBatch:8},win9Tail.s,profile,plan('nine-shard-payout'));
 assert.equal(b8Second.action,'PAY_OLD');assert.equal(b8Second.targets.length,1);

 const win17=fixture({module:'win',cnt:17,local:3,p:0});
 const b16First=selectOldShardBatch({frozen:win17.targets,payoutBatch:16},win17.s,profile,plan('seventeen-shard-payout'));
 assert.equal(b16First.action,'PAY_OLD');assert.equal(b16First.targets.length,16);
 const win17Tail=fixture({module:'win',cnt:17,local:3,p:16});
 const b16Second=selectOldShardBatch({frozen:win17Tail.targets,payoutBatch:16},win17Tail.s,profile,plan('seventeen-shard-payout'));
 assert.equal(b16Second.action,'PAY_OLD');assert.equal(b16Second.targets.length,1);

 const ref9=fixture({module:'refund',cnt:9,local:3,r:0,c:0,minTickets:2400,ticketCap:2400});
 const refBatch=selectOldShardBatch({frozen:ref9.targets,payoutBatch:8},ref9.s,profile,plan('nine-shard-refund'));
 assert.equal(refBatch.action,'REFUND_OLD');assert.equal(refBatch.targets.length,1);

 assert.equal(stepFile(0,'intent.json'),'steps/000/0-intent.json');
 assert.equal(stepFile(65554,'receipt.json'),'steps/065/65554-receipt.json');
 const phases=resolvePhaseList('full-payout-b16,full-payout-b8,seventeen-shard-refund,nine-shard-refund,seventeen-shard-payout-b16,nine-shard-payout-b8');
 assert.deepEqual(phases.map(p=>p.totalExpectedTransactions),[65555,65571,4492,2380,4359,2311]);
});
test('buildConsolidationDraft and normalizeConsolidationDraft match txFromRpc accepted shape in matchesDraft',async()=>{
 const batch=[
  {outpoint:{transactionId:'10'.repeat(32),index:0},value:98000000n,spk:p2pk(key),daa:100n,utxoDaa:100n,covenantId:null},
  {outpoint:{transactionId:'20'.repeat(32),index:1},value:98000000n,spk:p2pk(key),daa:101n,utxoDaa:101n,covenantId:null},
 ];
 const {draft}=buildConsolidationDraft(batch,p2pk(key),'1');
 assert.ok(draft.transaction.inputs.every(i=>!Object.hasOwn(i,'sigOpCount')&&i.computeBudget===10));
 await signer.sign(draft);
 const wire=txToRpc(draft.transaction),digest=createHash('sha256').update(jsonText(wire)).digest('hex');
 const accepted={tx:txFromRpc(wire),inputs:batch.map(u=>({value:u.value,daa:u.daa,covenantId:null,spk:spkText(u.spk)}))};
 assert.equal(matchesDraft(accepted,draft),draft.fee);

 const legacyDraft=structuredClone(draft);
 for(const inp of legacyDraft.transaction.inputs)inp.sigOpCount=1;
 assert.equal(createHash('sha256').update(jsonText(txToRpc(legacyDraft.transaction))).digest('hex'),digest);
 assert.equal(matchesDraft(accepted,normalizeConsolidationDraft(legacyDraft)),draft.fee);
 assert.equal(isTransientRunError('无法连接：vector-10.kaspa.green'),true);
 assert.equal(isTransientRunError('INSUFFICIENT_BUYER_BALANCE'),false);
 assert.deepEqual([0,1,2,3].map(i=>selectBuyerRole(i,null)),['buyer1','buyer2','creator','buyer1']);
 assert.equal(selectBuyerRole(2,null,new Set(['creator'])),'buyer1');
 assert.equal(selectBuyerRole(3002,null),'buyer2');
 assert.deepEqual([0,1,2,3].map(i=>selectBuyerRole(i,'A')),['buyer1','buyer1','buyer1','creator']);
 assert.equal(selectBuyerRole(3,'A',new Set(['creator'])),'buyer1');
 assert.equal(selectBuyerRole(0,'B'),'buyer2');
});
test('saveRunState externalizes finalized receipts and frozen scripts without bloating state.json',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kaswin-run-'));
 try {
  const redeem=new Uint8Array(9217).fill(0xab);
  const state={buys:256,frozen:[{outpoint:{transactionId:'11'.repeat(32),index:1},value:256n*PRICE,redeemScript:redeem}],
   receipts:[{txid:'aa'.repeat(32),action:'GENESIS',finalized:true},{txid:'bb'.repeat(32),action:'BUY',finalized:false}]};
  await saveRunState(dir,state);
  const rawState=await readFile(join(dir,'state.json'),'utf8');
  assert.ok(!rawState.includes('"redeemScript"'));
  assert.equal(state.receipts.length,1);assert.equal(state.receipts[0].txid,'bb'.repeat(32));
  assert.equal(state.frozen[0].redeemScript.length,9217); // kept in memory for active runner
  const reloaded=await loadRunState(dir);
  assert.deepEqual(reloaded.frozen[0].redeemScript,redeem);
  const all=await readAllReceipts(dir,reloaded);
  assert.deepEqual(all.map(r=>r.txid),['aa'.repeat(32),'bb'.repeat(32)]);
  // Re-flushing an already-logged receipt deduplicates cleanly by txid.
  reloaded.receipts[0].finalized=true;
  await saveRunState(dir,reloaded);
  const finalAll=await readAllReceipts(dir);
  assert.deepEqual(finalAll.map(r=>r.txid),['aa'.repeat(32),'bb'.repeat(32)]);
 }finally{await rm(dir,{recursive:true,force:true});}
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
 assert.ok(p.draft.transaction.outputs.some(o=>o.scriptPublicKey.script===TN10.registry.spk.script));
 assert.equal(p.engine.inputs.length,1);assert.equal(p.engine.inputs[0].limitedOk,true);
 const intent={network:TN10.networkId,profileId:TN10_PROFILE_ID,draft:p.draft,txid:referenceTxId(p.draft.transaction),wireDigest:createHash('sha256').update(jsonText(txToRpc(p.draft.transaction))).digest('hex')};
 authenticateIntent(intent);
 p.draft.transaction.inputs[0].signatureScript='00';
 assert.equal(referenceTxId(p.draft.transaction),intent.txid); // txid alone does not bind witness bytes
 assert.throws(()=>authenticateIntent(intent),/INTENT_CONTENT_CHANGED/);
});
test('derived buyer pool is deterministic, diverse across 32-record batches, and locks sweep recipient to baseAddress',async()=>{
 const pool1=createDerivedBuyerPoolFromSecret(sk,signer.address,64);
 const pool2=createDerivedBuyerPoolFromSecret(sk,signer.address,64);
 try {
  assert.equal(pool1.entries.length,64);
  assert.deepEqual(pool1.entries.map(e=>e.key),pool2.entries.map(e=>e.key));
  assert.equal(new Set(pool1.entries.map(e=>e.key)).size,64);
  const keys=pool1.entries.map(e=>e.key);
  assert.equal(selectBuyerKey(0,[]),null);
  const window32=Array.from({length:32},(_,i)=>selectBuyerKey(i,keys));
  assert.equal(new Set(window32).size,32);
  assert.notEqual(selectBuyerKey(0,keys),selectBuyerKey(256,keys));

  const target=pool1.entries[5];
  const singleUtxo=[{outpoint:{transactionId:'30'.repeat(32),index:0},value:500000000n,spk:target.spk,daa:100n,utxoDaa:100n,covenantId:null}];
  const {draft}=buildConsolidationDraft(singleUtxo,p2pk(key),'1',{minInputs:1});
  await pool1.signSweep(5,draft);
  assert.ok(draft.transaction.inputs[0].signatureScript.length>0);

  const wrongSpk=pool1.entries[6].spk;
  const {draft:badDraft}=buildConsolidationDraft(singleUtxo,wrongSpk,'1',{minInputs:1});
  await assert.rejects(()=>pool1.signSweep(5,badDraft),/DERIVED_SWEEP_RECIPIENT_SCOPE/);

  const f=fixture({module:'sales',local:0});
  assert.throws(()=>buildAction(f.manager,profile,{action:'BUY',actorKey:key,buyerKey:target.key,quantity:1},{funds:[funding],fee:2000000n,budgets:[65535,10]}),/STANDARD_SELF_PURCHASE/);
  const okDraft=buildAction(f.manager,profile,{action:'BUY',actorKey:key,buyerKey:target.key,quantity:1},{funds:[funding],fee:2000000n,budgets:[65535,10],allowDelegatedBuyer:true});
  assert.equal(okDraft.transition.next.records[0].key,target.key);
 }finally{pool1.close();pool2.close();}
 await assert.rejects(()=>pool1.signSweep(0,{fee:1000000n,transaction:{outputs:[]},inputUtxos:[],authorizedInputIndices:[]}),/SIGNER_CLOSED/);
});
engineTest('prepare BUY with delegated buyerKey commits buyerKey in manager state while funding & change stay with signer',async()=>{
 const pool=createDerivedBuyerPoolFromSecret(sk,signer.address,8);
 try {
  const f=fixture({module:'sales',local:0});const rpc=rpcWith([funding,f.manager]);rpc.net=TN10;
  const state={manager:f.manager,frozen:[],fees:0n,step:0,buys:0,bought:0,receipts:[]};
  const buyerKey=pool.entries[3].key;
  const p=await prepare(rpc,state,profile,{action:'BUY',quantity:1,buyerKey},signer,{});
  assert.equal(p.engine.inputs.length,2);assert.ok(p.engine.inputs.every(x=>x.limitedOk));
  assert.equal(p.draft.transition.next.records[0].key,buyerKey);
  const changeOut=p.draft.transaction.outputs.find(o=>!o.covenant);
  assert.equal(changeOut.scriptPublicKey.script,p2pk(key).script);
 }finally{pool.close();}
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
