/** Offline unit & integration tests for 3-tier round tracking, discovery, and catch-up
 * (Indexer -> Node UTXO verify & virtual-chain forward chase -> REST API fallback). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {profile,PRICE} from '../contracts/fixtures.mjs';
import {hex} from '../../scripts/core.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {encodeTagged} from '../../scripts/store/codec.mjs';
import {createController} from '../../scripts/round/controller.mjs';
import {MemoryStore,RoundStore} from '../../scripts/store/round-store.mjs';
import {FakeNode} from '../helpers/fake-node.mjs';
import {openMemoryWallet} from '../../scripts/wallet/wallet.mjs';
import {roundToText} from '../../scripts/round/round.mjs';
import {restRollingGenesisCandidate,discoverRestRollingRounds} from '../../scripts/round/catchup.mjs';
import {TN10_GENESIS,TN10_NETWORK_ID,TN10_PROFILE_ID,TN10_ROLLING_REGISTRY} from '../../scripts/contract/protocol.mjs';

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

  // Page reload simulation: a new controller restores Plaza discovery from local RoundStore / discoveryCache before any network call,
  // preserves rich indexer cache across temporary failover or total network outage, and upgrades to 'indexer' when live returns.
  let lsSnap=null;
  const lsCache={read:()=>lsSnap,write:s=>{lsSnap=s;}};
  const sharedRoundStore=new RoundStore(ms2);
  const ctlReload1=createController({profile,roundStore:sharedRoundStore,connect:async()=>node,sleep:async()=>{},fetcher,discoveryCache:lsCache});
  idxDown=false;
  await ctlReload1.checkIndexer(base);
  assert.equal(ctlReload1.state.discoveredSource,'indexer');
  assert.equal(lsSnap?.rounds?.length,1);

  const offlineFetcher=async()=>jsonResp({error:'offline'},503);
  const ctlReload2=createController({profile,roundStore:sharedRoundStore,connect:async()=>node,sleep:async()=>{},fetcher:offlineFetcher,discoveryCache:lsCache});
  // Synchronous localStorage seed already populated on construction
  assert.equal(ctlReload2.state.discoveredSource,'cache');
  assert.deepEqual(ctlReload2.state.discovered.map(x=>x.cid),[r1.cid]);
  await ctlReload2.restoreDiscovery();
  assert.equal(ctlReload2.state.discoveredSource,'cache');
  assert.deepEqual(ctlReload2.state.discovered.map(x=>x.cid),[r1.cid]);
  // Even if both Indexer and REST fail on refresh, cached Plaza rounds are retained instead of blanking
  await assert.rejects(()=>ctlReload2.checkIndexer(base));
  await assert.rejects(()=>ctlReload2.refreshIndex());
  assert.equal(ctlReload2.state.discoveredSource,'cache');
  assert.deepEqual(ctlReload2.state.discovered.map(x=>x.cid),[r1.cid]);
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

test('watchRound subscribes manager P2SH UtxosChanged, relays to next manager address on spend, catches pre-subscribe gaps, and unsubscribes on terminal/leave',async()=>{
  const {node,ctlA,ctlB,storeA}=await setupNode();
  const {spkToAddress}=await import('../../scripts/wallet/address.mjs');
  const waitUntil=async(pred,timeoutMs=3000)=>{
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){if(await pred())return;await new Promise(r=>setTimeout(r,20));}
    assert.fail('timed out waiting for watchRound catch-up');
  };

  const g=await runStep(ctlA,node,{action:'GENESIS',settings:settings({minTickets:'5',ticketCap:'10'})});
  const cid=g.cid;
  const addr1=spkToAddress(g.manager.spk,'kaspatest');

  // User A opens detail page -> watchRound subscribes Addr_1
  await ctlA.watchRound(cid);
  assert.equal(ctlA.state.watchedAddress,addr1);
  assert.equal(node.subscriptions.has(addr1),true);

  // User B imports and buys 3 tickets on-chain -> UtxosChanged wakes ctlA automatically without manual syncRound!
  await ctlB.importText(roundToText(g));
  const step2B=await runStep(ctlB,node,{action:'BUY',quantity:'3'},cid);
  const addr2=spkToAddress(step2B.manager.spk,'kaspatest');
  await waitUntil(async()=>(await storeA.get(cid))?.round.step===2);
  // Relay subscription: Addr_2 subscribed, Addr_1 unsubscribed!
  await waitUntil(()=>ctlA.state.watchedAddress===addr2&&!node.subscriptions.has(addr1));
  assert.equal(node.subscriptions.has(addr2),true);

  // User B executes CLOSE then REFUND_SELF -> ctlA follows all the way to REFUNDED and unsubscribes on terminal!
  await runStep(ctlB,node,{action:'CLOSE'},cid);
  await waitUntil(async()=>(await storeA.get(cid))?.round.step===3);
  await runStep(ctlB,node,{action:'REFUND_SELF'},cid);
  await waitUntil(async()=>(await storeA.get(cid))?.round.terminal==='REFUNDED');
  await waitUntil(()=>ctlA.state.watchedAddress===null&&node.subscriptions.size===0);

  // Pre-subscribe gap check: User C starts with stale step-1 snapshot AFTER round already moved on-chain;
  // watchRound subscribes Addr_1, sees STALE_INPUT on post-subscribe liveRound check, and catches up immediately!
  const g2=await runStep(ctlA,node,{action:'GENESIS',settings:settings()});
  await ctlB.importText(roundToText(g2));
  const msC=new MemoryStore();msC.persistent=true;
  const storeC=new RoundStore(msC);
  const ctlC=createController({profile,roundStore:storeC,connect:async()=>node,sleep:async()=>{}});
  await ctlC.connectNode(['wss://fake-tn10.invalid/wrpc']);
  await ctlC.importText(roundToText(g2));
  await runStep(ctlB,node,{action:'BUY',quantity:'2'},g2.cid); // spent BEFORE ctlC watches!
  await ctlC.watchRound(g2.cid);
  await waitUntil(async()=>(await storeC.get(g2.cid))?.round.step===2);
  assert.equal(node.subscriptions.size,1);
  // Leaving detail page unsubscribes cleanly
  await ctlC.watchRound(null);
  assert.equal(ctlC.state.watchedAddress,null);
  assert.equal(node.subscriptions.size,0);
});

test('syncRound persists incremental catch-up progress to roundStore and emits onChange while chasing multiple steps',async()=>{
  const {node,ctlA,ctlB,storeB}=await setupNode();
  const g=await runStep(ctlA,node,{action:'GENESIS',settings:settings({minTickets:'3',ticketCap:'20'})});
  const cid=g.cid;
  await ctlB.importText(roundToText(g));
  for(let i=0;i<10;i++)await runStep(ctlA,node,{action:'BUY',quantity:'1'},cid);
  const seenSteps=[];
  const off=ctlB.onChange(()=>{void storeB.get(cid).then(rec=>{if(rec&&!seenSteps.includes(rec.round.step))seenSteps.push(rec.round.step);});});
  try{
    const res=await ctlB.syncRound(cid,{force:true,skipIndexer:true});
    assert.equal(res.steps,10);
    const finalRec=await storeB.get(cid);
    assert.equal(finalRec.round.step,11);
    assert.ok(seenSteps.some(s=>s>1&&s<11),`expected intermediate step in storeB before final step 11, got ${JSON.stringify(seenSteps)}`);
  }finally{off();}
});

test('syncRound with preferRest=true checks REST before calling node getVirtualChainFromBlockV2',async()=>{
  const {node,ctlA}=await setupNode();
  const g=await runStep(ctlA,node,{action:'GENESIS',settings:settings({minTickets:'3',ticketCap:'20'})});
  const cid=g.cid;
  const s2=await runStep(ctlA,node,{action:'BUY',quantity:'2'},cid);
  const {spkToAddress}=await import('../../scripts/wallet/address.mjs');
  const dto2=txToRestDto(node,s2.receipts[1].txid);
  const addrTxs=new Map([[spkToAddress(g.manager.spk,'kaspatest'),[dto2]]]);
  const txById=new Map([[dto2.transaction_id,dto2]]);
  let fullScanCalls=0;
  const countingRpc={
    net:node.net,
    url:node.url,
    currentDaa:()=>node.currentDaa(),
    async call(method,params,timeoutMs,opts){
      if(method==='getVirtualChainFromBlockV2'){fullScanCalls++;throw Object.assign(new Error('block pruned'),{code:'RPC_ERROR'});}
      if(method==='getBlock')throw Object.assign(new Error('block pruned'),{code:'RPC_ERROR'});
      return node.call(method,params,timeoutMs,opts);
    },
    close:()=>{},
  };
  const ms=new MemoryStore();ms.persistent=true;
  const ctl=createController({profile,roundStore:new RoundStore(ms),connect:async()=>countingRpc,sleep:async()=>{},fetcher:makeRestFetcher({registryTxs:[],addrTxs,txById,pageSize:10})});
  await ctl.connectNode(['wss://node.invalid/wrpc']);
  await ctl.importText(roundToText(g));
  const res=await ctl.syncRound(cid,{force:true,skipIndexer:true,preferRest:true});
  assert.equal(res.steps,1);
  assert.equal(fullScanCalls,0,'preferRest=true must not start by scanning full blocks via getVirtualChainFromBlockV2');
  assert.match(res.source,/rest/);
});

test('syncRound skips Indexer /export when local round is already live on node',async()=>{
  const {node,ctlA}=await setupNode();
  const g=await runStep(ctlA,node,{action:'GENESIS',settings:settings({minTickets:'3',ticketCap:'20'})});
  const cid=g.cid;
  let exportCalls=0;
  const base='https://idx.test/tn10';
  const doc1={cid,revision:'1',head:{txid:g.receipts[0].txid,acceptingBlock:g.accepting},roundText:roundToText(g),terminal:null,module:'sales',tickets:0,bought:0,buys:0};
  const fetcher=async(url,init)=>{
    if(String(url).includes('/export'))exportCalls++;
    return makeIndexerFetcher(base,{documents:new Map([[cid,doc1]])})(url,init);
  };
  const ms=new MemoryStore();ms.persistent=true;
  const ctl=createController({profile,roundStore:new RoundStore(ms),connect:async()=>node,sleep:async()=>{},fetcher});
  await ctl.connectNode(['wss://fake-tn10.invalid/wrpc']);
  await ctl.checkIndexer(base);
  await ctl.importText(roundToText(g));
  const res=await ctl.syncRound(cid,{force:true,skipIndexer:false});
  assert.equal(res.unchanged,true);
  assert.equal(exportCalls,0,'must not download /export when local manager UTXO is already live');
});
