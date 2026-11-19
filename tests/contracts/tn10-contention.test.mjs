import test from 'node:test';
import assert from 'node:assert/strict';
import {packIpc,unpackIpc,parseContentionRoles,parseNodeCandidates,connectCandidateNodes,pickWinningOutcome,verifyContentionReceipt,searchWithReorg,waitContentionOutcome,shuffleWorkers} from './tn10-contention.mjs';
import {buildFeeRateLadder} from './tn10-run.mjs';
import {p2pk} from '../../scripts/core/lib/covenant-id.js';

test('tn10-contention helpers: role validation, IPC bigint/bytes round-trip, single winner extraction',()=>{
  assert.deepEqual(parseContentionRoles('creator,buyer1,buyer2'),['creator','buyer1','buyer2']);
  assert.deepEqual(parseContentionRoles('buyer1,buyer2'),['buyer1','buyer2']);
  assert.throws(()=>parseContentionRoles('buyer1'),/CONTENTION_MIN_TWO_ROLES/);
  assert.throws(()=>parseContentionRoles('buyer1,buyer1'),/CONTENTION_MIN_TWO_ROLES/);
  assert.throws(()=>parseContentionRoles('creator,unknown'),/UNKNOWN_ROLE/);

  const sample={bigint:123456789012345n,bytes:new Uint8Array([1,2,255]),nested:{ok:true}};
  const roundTripped=unpackIpc(packIpc(sample));
  assert.equal(roundTripped.bigint,123456789012345n);
  assert.deepEqual(roundTripped.bytes,new Uint8Array([1,2,255]));
  assert.equal(roundTripped.nested.ok,true);

  const outcomes=[
    {role:'creator',pid:101,txid:'a'.repeat(64),status:'REJECTED'},
    {role:'buyer1',pid:102,txid:'b'.repeat(64),status:'SUBMITTED'},
    {role:'buyer2',pid:103,txid:'c'.repeat(64),status:'REJECTED'},
  ];
  const res=pickWinningOutcome(outcomes,new Set(['b'.repeat(64)]));
  assert.equal(res.winner.role,'buyer1');
  assert.deepEqual(res.losers.map(l=>l.role),['creator','buyer2']);
  assert.throws(()=>pickWinningOutcome(outcomes,new Set()),/CONTENTION_EXPECTED_SINGLE_WINNER:got=0/);
  assert.throws(()=>pickWinningOutcome(outcomes,new Set(['a'.repeat(64),'b'.repeat(64)])),/CONTENTION_EXPECTED_SINGLE_WINNER:got=2/);
});

test('verifyContentionReceipt validates settle() shape without inputs[].outpoint and rejects wrong manager spend',()=>{
  const mgrOut={transactionId:'11'.repeat(32),index:0};
  const mgrSpk=p2pk('22'.repeat(32)),fundSpk=p2pk('33'.repeat(32));
  const draft={
    fee:1000n,
    authorizedInputIndices:[1],
    inputUtxos:[
      {outpoint:mgrOut,value:500000000n,spk:mgrSpk,covenantId:'cc'.repeat(32)},
      {outpoint:{transactionId:'44'.repeat(32),index:1},value:200000000n,spk:fundSpk,covenantId:null},
    ],
    transaction:{
      version:1,
      inputs:[
        {previousOutpoint:mgrOut,signatureScript:'aa',sequence:0n},
        {previousOutpoint:{transactionId:'44'.repeat(32),index:1},signatureScript:'',sequence:0n},
      ],
      outputs:[{value:699999000n,scriptPublicKey:mgrSpk,covenant:{covenantId:'cc'.repeat(32),authorizingInput:0}}],
      lockTime:0n,subnetworkId:'00'.repeat(20),gas:0n,payload:'',storageMass:0n,
    },
  };
  const signedTx=structuredClone(draft.transaction);
  signedTx.inputs[1].signatureScript='41'+'ab'.repeat(64)+'01';
  // Exact shape returned by settle(): inputs entries carry {value, spk, daa, covenantId} with NO .outpoint
  const settleReceipt={
    txid:'55'.repeat(32),
    transaction:signedTx,
    inputs:[
      {value:500000000n,spk:mgrSpk,daa:100n,covenantId:'cc'.repeat(32)},
      {value:200000000n,spk:fundSpk,daa:101n,covenantId:null},
    ],
  };
  assert.equal(verifyContentionReceipt(settleReceipt,{outpoint:mgrOut},draft),settleReceipt);
  assert.throws(()=>verifyContentionReceipt(settleReceipt,{outpoint:{transactionId:'99'.repeat(32),index:0}},draft),/WINNER_DID_NOT_SPEND_CONTESTED_MANAGER/);
});

test('searchWithReorg steps back via chainCursor on CURSOR_REORG instead of crashing',async()=>{
  const h=n=>n.toString(16).padStart(64,'0');
  const bReorged='aa'.repeat(32),bChain='bb'.repeat(32),txid='ee'.repeat(32);
  const b=i=>h(0x100+i);
  const parents=new Map([[bReorged,[false,bChain]],[bChain,[true,b(1)]]]);
  for(let i=1;i<=17;i++)parents.set(b(i),[true,i===17?'00'.repeat(32):b(i+1)]);
  let vCalls=0;
  const mockRpc={
    async call(method,{startHash,hash}={}) {
      if(method==='getBlock') {
        const [isChain,selectedParentHash]=parents.get(hash)??[];
        return {block:{header:{hash,blueScore:'10'},verboseData:{isChainBlock:isChain,selectedParentHash}}};
      }
      if(method==='getSinkBlueScore')return {blueScore:'12'};
      if(method==='getVirtualChainFromBlock') {
        vCalls++;
        return {removedChainBlockHashes:[],addedChainBlockHashes:[],acceptedTransactionIds:[]};
      }
      throw new Error(`unexpected:${method}`);
    },
  };
  const res=await searchWithReorg(mockRpc,txid,bReorged,{pages:1});
  assert.equal(vCalls,1);
  assert.equal(res.cursor,b(16));
  assert.equal(res.found.complete,true);
});

test('shuffleWorkers produces a non-mutating permutation and varies first element across random runs',()=>{
  const orig=['creator','buyer1','buyer2'];
  const fixed=shuffleWorkers(orig,()=>0);
  assert.deepEqual(orig,['creator','buyer1','buyer2']);
  assert.deepEqual([...fixed].sort(),[...orig].sort());
  const firsts=new Set();
  for(let i=0;i<64;i++)firsts.add(shuffleWorkers(orig)[0]);
  assert.equal(firsts.size,3);
});

test('buildFeeRateLadder prioritizes boosted priority (when congested) -> priority -> normal -> low -> 1',()=>{
  assert.deepEqual(buildFeeRateLadder({priority:{feerate:268.15},normal:{feerate:166.99},low:{feerate:112.88}}),['336','269','167','113','1']);
  assert.deepEqual(buildFeeRateLadder({priority:{feerate:1},normal:{feerate:1},low:{feerate:1}}),['1']);
});

test('searchWithReorg advances cursor across complete:false pages and waitContentionOutcome tracks per-candidate cursors',async()=>{
  const h=n=>n.toString(16).padStart(64,'0');
  const winTx='aa'.repeat(32),loseTx='bb'.repeat(32);
  const rpc={
    async call(method,params){
      if(method==='getBlock')return {block:{header:{hash:params.hash,blueScore:100},verboseData:{isChainBlock:true}}};
      if(method==='getSinkBlueScore')return {blueScore:200};
      if(method==='getVirtualChainFromBlock'){
        const start=parseInt(params.startHash,16);
        if(start>=10)return {removedChainBlockHashes:[],addedChainBlockHashes:[],acceptedTransactionIds:[]};
        const next=h(start+1);
        const txs=start===8?[winTx]:[];
        return {removedChainBlockHashes:[],addedChainBlockHashes:[next],acceptedTransactionIds:[{acceptingBlockHash:next,acceptedTransactionIds:txs}]};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const r1=await searchWithReorg(rpc,winTx,h(1),{pages:3});
  assert.equal(r1.found.complete,false);
  assert.equal(r1.found.accepting,null);
  assert.equal(r1.cursor,h(4),'searchWithReorg must advance cursor to last scanned block');
  const r2=await searchWithReorg(rpc,winTx,r1.cursor,{pages:6});
  assert.equal(r2.found.accepting,h(9));
  const out=await waitContentionOutcome(rpc,[
    {role:'buyer1',txid:loseTx,status:'SUBMITTED'},
    {role:'creator',txid:winTx,status:'SUBMITTED'},
  ],h(1),{timeoutMs:2000,pollMs:10});
  assert.equal(out.winner.role,'creator');
  assert.equal(out.winner.txid,winTx);
});

test('waitContentionOutcome keeps pre-submit cursor when tip is reached with complete:true so later acceptance is not skipped',async()=>{
  const h=n=>n.toString(16).padStart(64,'0');
  const winTx='cc'.repeat(32),loseTx='dd'.repeat(32);
  let tipPollCount=0;
  const rpc={
    async call(method,params){
      if(method==='getBlock')return {block:{header:{hash:params.hash,blueScore:100},verboseData:{isChainBlock:true}}};
      if(method==='getSinkBlueScore')return {blueScore:200};
      if(method==='getVirtualChainFromBlock'){
        const start=parseInt(params.startHash,16);
        if(start===1){
          tipPollCount++;
          const txs=tipPollCount>=2?[winTx]:[];
          return {removedChainBlockHashes:[],addedChainBlockHashes:[h(2)],acceptedTransactionIds:[{acceptingBlockHash:h(2),acceptedTransactionIds:txs}]};
        }
        return {removedChainBlockHashes:[],addedChainBlockHashes:[],acceptedTransactionIds:[]};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const out=await waitContentionOutcome(rpc,[
    {role:'creator',txid:winTx,status:'SUBMITTED'},
    {role:'buyer1',txid:loseTx,status:'SUBMITTED'},
  ],h(1),{timeoutMs:2000,pollMs:10});
  assert.equal(out.winner.txid,winTx);
  assert.ok(tipPollCount>=2);
});

test('parseNodeCandidates prefers local node and appends public TN10 fallbacks',()=>{
  const list=parseNodeCandidates('ws://127.0.0.1:18210');
  assert.equal(list[0],'ws://127.0.0.1:18210');
  assert.ok(list.length>=4);
  assert.ok(list.slice(1).every(u=>u.startsWith('wss://')));
  assert.deepEqual(parseNodeCandidates('wss://custom.example/wrpc'),['wss://custom.example/wrpc']);
});

test('connectCandidateNodes probes single URLs sequentially and falls back when local fails',async()=>{
  const tried=[];
  const rpc=await connectCandidateNodes(['ws://127.0.0.1:18210','wss://pub1.example/wrpc','wss://pub2.example/wrpc'],async url=>{
    assert.equal(typeof url,'string');
    tried.push(url);
    if(url.startsWith('ws://127.0.0.1'))throw new Error('NODE_UNSYNCED');
    return {url};
  });
  assert.equal(rpc.url,'wss://pub1.example/wrpc');
  assert.deepEqual(tried,['ws://127.0.0.1:18210','wss://pub1.example/wrpc']);
});
