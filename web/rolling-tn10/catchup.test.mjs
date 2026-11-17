/** Offline unit & integration tests for 3-tier round tracking, discovery, and catch-up
 * (Indexer -> Node UTXO verify & virtual-chain forward chase -> REST API fallback). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {profile,PRICE} from '../../experiments/rolling/fixtures.mjs';
import {hex} from '../../scripts/rolling/core.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {encodeTagged} from './codec.mjs';
import {createController} from './controller.mjs';
import {MemoryStore,RoundStore} from './store.mjs';
import {FakeNode} from './fake-node.mjs';
import {openMemoryWallet} from './wallet.mjs';
import {roundToText} from './round.mjs';
import {restRollingGenesisCandidate,discoverRestRollingRounds} from './catchup.mjs';
import {TN10_GENESIS,TN10_NETWORK_ID,TN10_PROFILE_ID,TN10_ROLLING_REGISTRY} from './protocol.mjs';

const KAS=100000000n;
const KEY_A=createHash('sha256').update('rolling-tn10-catchup-user-a').digest('hex');
const KEY_B=createHash('sha256').update('rolling-tn10-catchup-user-b').digest('hex');
const W_A=openMemoryWallet(KEY_A);
const W_B=openMemoryWallet(KEY_B);
const settings=(over={})=>({ticketPrice:'1',ticketCap:'10',minTickets:'3',closeMinutes:'0',...over});

function jsonResp(body,status=200) {
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
}

async function setupNode() {
  const node=new FakeNode({daa:5000});
  node.addUtxo({txid:'a1'.repeat(32),value:100n*KAS,spk:W_A.spk,daa:100});
  node.addUtxo({txid:'b1'.repeat(32),value:100n*KAS,spk:W_B.spk,daa:100});
  const msA=new MemoryStore();msA.persistent=true;
  const msB=new MemoryStore();msB.persistent=true;
  const storeA=new RoundStore(msA),storeB=new RoundStore(msB);
  const ctlA=createController({profile,roundStore:storeA,connect:async()=>node,sleep:async()=>{}});
  const ctlB=createController({profile,roundStore:storeB,connect:async()=>node,sleep:async()=>{}});
  await ctlA.connectNode(['wss://fake-tn10.invalid/wrpc']);
  await ctlB.connectNode(['wss://fake-tn10.invalid/wrpc']);
  ctlA.openWallet(KEY_A);
  ctlB.openWallet(KEY_B);
  return {node,storeA,storeB,ctlA,ctlB};
}

async function runStep(ctl,node,choice,cid=null,{mineBlocks=1}={}) {
  await ctl.prepare(choice,cid);
  const rcid=ctl.state.prepared.cid;
  assert.equal(await ctl.signAndSend(),'SUBMITTED');
  node.mine(mineBlocks);
  const res=await ctl.track(rcid);
  assert.ok(res.candidate||res.accepted);
  return (await ctl.rounds()).find(x=>x.cid===rcid);
}

/** Convert an accepted FakeNode transaction into a pinned Kaspa TN10 REST transaction DTO. */
function txToRestDto(node,txid) {
  let rec=null,acceptingBlock=null;
  for(const b of node.chain){
    const hit=b.accepted.find(x=>x.txid===txid);
    if(hit){rec=hit;acceptingBlock=b.hash;break;}
  }
  assert.ok(rec,`missing tx in FakeNode chain: ${txid}`);
  const tx=rec.tx;
  return {
    transaction_id:txid,
    is_accepted:true,
    accepting_block_hash:acceptingBlock,
    block_time:1_700_000_000_000,
    payload:typeof tx.payload==='string'?tx.payload:(tx.payload&&tx.payload.length?hex(tx.payload):''),
    inputs:tx.inputs.map((inp,index)=>({
      index,
      previous_outpoint_hash:inp.previousOutpoint.transactionId,
      previous_outpoint_index:String(inp.previousOutpoint.index),
      signature_script:typeof inp.signatureScript==='string'?inp.signatureScript:hex(inp.signatureScript),
    })),
    outputs:tx.outputs.map((out,index)=>({
      index,
      amount:Number(out.value),
      script_public_key:out.scriptPublicKey.script,
      covenant_id:out.covenant?.covenantId??null,
      covenant_authorizing_input:out.covenant?String(out.covenant.authorizingInput):null,
    })),
  };
}

function makeIndexerFetcher(base,{stale=false,fail=false,documents=new Map()}={}) {
  const txMap=new Map();
  for(const doc of documents.values())if(doc.head?.txid)txMap.set(doc.head.txid,doc.cid);
  const list=[...documents.values()].map(d=>({
    cid:d.cid,terminal:d.terminal??null,module:d.module??'sales',tickets:d.tickets??0,shards:0,
    bought:d.bought??0,buys:d.buys??0,managerValue:d.managerValue??'400000000',acceptingDaa:null,updatedAt:d.updatedAt??100,
  }));
  return async(url)=>{
    const u=String(url);
    if(!u.startsWith(base))return jsonResp({error:'unexpected'},404);
    if(fail)return jsonResp({error:'down'},503);
    const path=u.slice(base.length);
    const scope={schema:1,network:TN10_NETWORK_ID,genesisHash:TN10_GENESIS,profileId:TN10_PROFILE_ID};
    if(path==='/info')return jsonResp({...scope,readOnly:true,status:'UNVALIDATED',stale,cursor:{daa:5000},roundsCount:list.length});
    if(path.startsWith('/rounds?'))return jsonResp({...scope,rounds:list,nextCursor:null});
    const mExport=/^\/rounds\/([0-9a-f]{64})\/export$/.exec(path);
    if(mExport){
      const doc=documents.get(mExport[1]);
      return doc?jsonResp({...scope,...doc}):jsonResp({error:'not found'},404);
    }
    const mTx=/^\/tx\/([0-9a-f]{64})$/.exec(path);
    if(mTx){
      const cid=txMap.get(mTx[1]);
      return cid?jsonResp({...scope,cid}):jsonResp({error:'not found'},404);
    }
    return jsonResp({error:'not found'},404);
  };
}

function makeRestFetcher({registryTxs=[],addrTxs=new Map(),txById=new Map(),pageSize=1}={}) {
  return async(url)=>{
    const u=new URL(String(url));
    const mAddr=/\/addresses\/([^/]+)\/full-transactions$/.exec(u.pathname);
    if(mAddr){
      const addr=decodeURIComponent(mAddr[1]),offset=Number(u.searchParams.get('offset')??'0');
      const items=addr===TN10_ROLLING_REGISTRY.address?registryTxs:(addrTxs.get(addr)??[]);
      return jsonResp(items.slice(offset,offset+pageSize));
    }
    const mTx=/\/transactions\/([0-9a-f]{64})$/.exec(u.pathname);
    if(mTx){
      const raw=txById.get(mTx[1]);
      return raw?jsonResp(raw):jsonResp({error:'not found'},404);
    }
    return jsonResp({error:'unexpected url'},404);
  };
}

test('explore discovery uses TN10 REST fallback without Indexer and falls back cleanly when Indexer fails',async()=>{
  const {node,ctlA}=await setupNode();
  const r1=await runStep(ctlA,node,{action:'GENESIS',settings:settings()});
  const r2=await runStep(ctlA,node,{action:'GENESIS',settings:settings()});
  const dto1=txToRestDto(node,r1.receipts[0].txid),dto2=txToRestDto(node,r2.receipts[0].txid);
  const forged={...dto1,transaction_id:'cc'.repeat(32),outputs:dto1.outputs.filter(o=>o.index===0)}; // missing REGISTRATION output

  // Direct REST discovery + pagination + forged tx rejection
  const page1=await discoverRestRollingRounds({profile,cursor:0,limit:2,fetcher:makeRestFetcher({registryTxs:[dto1,forged,dto2],pageSize:2})});
  assert.equal(page1.source,'rest');assert.equal(page1.rejected,1);
  assert.equal(page1.rounds.length,1);assert.equal(page1.rounds[0].cid,r1.cid);assert.equal(page1.nextCursor,2);
  const page2=await discoverRestRollingRounds({profile,cursor:page1.nextCursor,limit:2,fetcher:makeRestFetcher({registryTxs:[dto1,forged,dto2],pageSize:2})});
  assert.equal(page2.rounds[0].cid,r2.cid);

  // Controller with NO Indexer uses REST on refreshIndex() and moreIndex() (page 1 has 50 items so nextCursor=50)
  const ms=new MemoryStore();ms.persistent=true;
  const page50=[dto1,...Array(49).fill(forged),dto2];
  const ctlRest=createController({profile,roundStore:new RoundStore(ms),connect:async()=>node,sleep:async()=>{},fetcher:makeRestFetcher({registryTxs:page50,pageSize:50})});
  const first=await ctlRest.refreshIndex();
  assert.equal(first.source,'rest');assert.equal(ctlRest.state.discoveredSource,'rest');
  assert.deepEqual(ctlRest.state.discovered.map(x=>x.cid),[r1.cid]);
  await ctlRest.moreIndex();
  assert.deepEqual(ctlRest.state.discovered.map(x=>x.cid),[r1.cid,r2.cid]);

  // Controller WITH Indexer seamlessly falls back to REST when Indexer starts returning 503
  const base='https://idx.test/tn10';
  let idxDown=false;
  const doc1={cid:r1.cid,revision:'1',head:{txid:r1.receipts[0].txid,acceptingBlock:r1.accepting},roundText:roundToText(r1)};
  const fetcher=async(url,init)=>String(url).startsWith(base)
    ?makeIndexerFetcher(base,{fail:idxDown,documents:new Map([[r1.cid,doc1]])})(url,init)
    :makeRestFetcher({registryTxs:[dto1,dto2],pageSize:10})(url,init);
  const ms2=new MemoryStore();ms2.persistent=true;
  const ctlFailover=createController({profile,roundStore:new RoundStore(ms2),connect:async()=>node,sleep:async()=>{},fetcher});
  await ctlFailover.checkIndexer(base);
  assert.equal(ctlFailover.state.discoveredSource,'indexer');
  idxDown=true;
  const fell=await ctlFailover.refreshIndex();
  assert.equal(fell.source,'rest');assert.equal(ctlFailover.state.discoveredSource,'rest');
  assert.equal(ctlFailover.state.indexerInfo.stale,true);
  assert.equal(ctlFailover.state.discovered.length,2);
});

test('syncRound fetches Indexer seed once, detects STALE_INPUT on node, and chases virtual-chain forward through BUY -> CLOSE -> REFUND_SELF',async()=>{
  const {node,ctlA,ctlB}=await setupNode();
  // Real Indexer exports settled snapshots (>=100 DAA deep, pending=[]); mine 15 blocks (150 DAA) for GENESIS
  const g=await runStep(ctlA,node,{action:'GENESIS',settings:settings({minTickets:'5',ticketCap:'10'})},null,{mineBlocks:15});
  const cid=g.cid;
  // Indexer only knows GENESIS (step 1)
  const doc1={cid,revision:'1',head:{txid:g.receipts[0].txid,acceptingBlock:g.accepting},roundText:roundToText(g),terminal:null,module:'sales',tickets:0,bought:0,buys:0};

  // Meanwhile User B buys (below minTickets=5), User A catches up 1 step, closes, and finishes REFUND_SELF (Indexer hasn't synced steps 2..4!)
  await ctlB.importText(roundToText(g));
  await runStep(ctlB,node,{action:'BUY',quantity:'3'},cid);
  const r2=await ctlA.syncRound(cid); // mid-round catch-up for User A too!
  assert.equal(r2.steps,1);assert.equal(r2.caughtUp,true);
  await runStep(ctlA,node,{action:'CLOSE'},cid);
  await runStep(ctlA,node,{action:'REFUND_SELF'},cid);

  // Fresh User C has Indexer stuck at step 1 -> syncRound chases all the way to REFUNDED via FakeNode!
  const base='https://idx.test/tn10';
  const msC=new MemoryStore();msC.persistent=true;
  const storeC=new RoundStore(msC);
  const ctlC=createController({profile,roundStore:storeC,connect:async()=>node,sleep:async()=>{},fetcher:makeIndexerFetcher(base,{documents:new Map([[cid,doc1]])})});
  await ctlC.connectNode(['wss://fake-tn10.invalid/wrpc']);
  await ctlC.checkIndexer(base);
  const res=await ctlC.syncRound(cid);
  assert.equal(res.cid,cid);assert.equal(res.caughtUp,true);assert.equal(res.steps,3);assert.equal(res.terminal,'REFUNDED');
  const saved=(await storeC.get(cid)).round;
  assert.equal(saved.step,4);assert.equal(saved.bought,3);assert.equal(saved.buys,1);assert.equal(saved.terminal,'REFUNDED');
  assert.deepEqual(saved.receipts.map(x=>x.action),['GENESIS','BUY','CLOSE','REFUND_SELF']);
  // Existing verifyLive still strictly throws STALE_INPUT if called on an un-synced stale record
  await assert.rejects(()=>ctlB.verifyLive(cid),/STALE_INPUT/);
});

test('syncRound chases mid-round so participant can immediately prepare next BUY without manual share link',async()=>{
  const {node,ctlA,ctlB}=await setupNode();
  const g=await runStep(ctlA,node,{action:'GENESIS',settings:settings()});
  const cid=g.cid;
  await ctlB.importText(roundToText(g));
  await runStep(ctlA,node,{action:'BUY',quantity:'2'},cid);
  // ctlB was stuck at step 1; calling syncRound advances ctlB to step 2 on node (no Indexer at all)
  const res=await ctlB.syncRound(cid);
  assert.equal(res.caughtUp,true);assert.equal(res.steps,1);assert.equal(res.source,'node');
  await ctlB.prepare({action:'BUY',quantity:'1'},cid);
  assert.equal(ctlB.state.prepared.op.action,'BUY');
  ctlB.discardPrepared();
});

test('REST fallback reconstructs GENESIS and pruned historical BUY steps when Indexer is absent and node pruned early blocks',async()=>{
  const {node,ctlA,ctlB}=await setupNode();
  const g=await runStep(ctlA,node,{action:'GENESIS',settings:settings({minTickets:'3',ticketCap:'20'})});
  const cid=g.cid;
  const s2=await runStep(ctlA,node,{action:'BUY',quantity:'2'},cid);
  await ctlB.importText(roundToText(s2));
  const s3=await runStep(ctlB,node,{action:'BUY',quantity:'1'},cid);

  // Build REST fixtures from the real signed FakeNode transactions
  const txids=[g.receipts[0].txid,s2.receipts[1].txid,s3.receipts[2].txid];
  const dtos=txids.map(id=>txToRestDto(node,id));
  const addrTxs=new Map([
    [W_A.address,[dtos[0]]],
    [s2.manager.spk?`kaspatest:placeholder`:'',[]],
  ]);
  // Put step transactions on their spent manager addresses (FakeNode keeps the exact same P2SH spk address)
  const {spkToAddress}=await import('../../scripts/wallet/address.mjs');
  addrTxs.set(spkToAddress(g.manager.spk,'kaspatest'),[dtos[1]]);
  addrTxs.set(spkToAddress(s2.manager.spk,'kaspatest'),[dtos[2]]);
  const txById=new Map(txids.map((id,i)=>[id,dtos[i]]));
  const fetcher=makeRestFetcher({registryTxs:[dtos[0]],addrTxs,txById,pageSize:10});

  // Simulate a pruned node that still has the live UTXOs + chain tip, but pruned all earlier blocks (getBlock throws for old accepting blocks)
  const prunedRpc={
    net:node.net,
    url:node.url,
    currentDaa:()=>node.currentDaa(),
    async call(method,params,timeoutMs,opts){
      if(method==='getBlock'||method==='getVirtualChainFromBlockV2'){throw Object.assign(new Error('block pruned'),{code:'RPC_ERROR'});}
      return node.call(method,params,timeoutMs,opts);
    },
    close:()=>{},
  };

  const msC=new MemoryStore();msC.persistent=true;
  const storeC=new RoundStore(msC);
  const ctlC=createController({profile,roundStore:storeC,connect:async()=>prunedRpc,sleep:async()=>{},fetcher});
  await ctlC.connectNode(['wss://pruned-tn10.invalid/wrpc']);

  // Lookup by CID with no Indexer and pruned node history -> locates GENESIS via REST, chases 2 BUYs via REST, verifies live tip UTXO on node!
  const res=await ctlC.syncRound(cid);
  assert.equal(res.cid,cid);assert.equal(res.steps,2);assert.equal(res.caughtUp,true);
  assert.match(res.source,/rest/);
  const synced=(await storeC.get(cid)).round;
  assert.equal(synced.step,3);assert.equal(synced.bought,3);assert.equal(synced.buys,2);
  assert.deepEqual(synced.receipts.map(x=>x.action),['GENESIS','BUY','BUY']);
  // Lookup by GENESIS txid via REST also resolves cleanly
  const msD=new MemoryStore();msD.persistent=true;
  const ctlD=createController({profile,roundStore:new RoundStore(msD),connect:async()=>prunedRpc,sleep:async()=>{},fetcher});
  await ctlD.connectNode(['wss://pruned-tn10.invalid/wrpc']);
  const byTx=await ctlD.syncRound(txids[0],{lookup:true});
  assert.equal(byTx.cid,cid);
});

test('syncRound never overwrites a round with an unresolved local intent or pending candidate',async()=>{
  const {node,ctlA,ctlB,storeB}=await setupNode();
  const g=await runStep(ctlA,node,{action:'GENESIS',settings:settings()});
  const cid=g.cid;
  await ctlB.importText(roundToText(g));
  // User B prepares an intent locally while node still has GENESIS live
  await ctlB.prepare({action:'BUY',quantity:'1'},cid);
  const sk=await ctlB.syncRound(cid);
  assert.equal(sk.skipped,'LOCAL_PENDING');
  // User B sends with lost reply -> persisted UNKNOWN intent locally
  node.failSubmit='lost';
  const st=await ctlB.signAndSend();
  node.failSubmit=null;
  assert.equal(st,'UNKNOWN');
  // Meanwhile User A advances round on chain
  await runStep(ctlA,node,{action:'BUY',quantity:'1'},cid);
  // Persisted UNKNOWN intent must still block syncRound from overwriting local round/intent
  const sk2=await ctlB.syncRound(cid);
  assert.equal(sk2.skipped,'LOCAL_PENDING');
  const saved=(await storeB.get(cid)).round;
  assert.equal(saved.intent?.status,'UNKNOWN');
  assert.equal(saved.step,1);
});

test('restRollingGenesisCandidate rejects forged genesis without registration or with extra covenant',()=>{
  const basePayload=`${hex(new TextEncoder().encode('KW_ROLL1'))}${profile.id}`;
  assert.throws(()=>restRollingGenesisCandidate({payload:basePayload,inputs:[]},profile),/STATE|SHORT|NOT_GENESIS|ORIGIN/);
});
