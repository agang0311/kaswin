import test from 'node:test';
import assert from 'node:assert/strict';
import {RpcError} from '../../scripts/chain/nodes.mjs';
import {absentEvidence} from './evidence.mjs';
const cursor='11'.repeat(32),txid='22'.repeat(32);
function reorgRpc(failures){
 let reads=0,poolReads=0;const starts=[];
 return {starts,get reads(){return reads;},get poolReads(){return poolReads;},async call(method,params){
  if(method==='getBlock')return {block:{header:{blueScore:'100'},verboseData:{isChainBlock:true}}};
  if(method==='getSinkBlueScore')return {blueScore:'101'};
  if(method==='getVirtualChainFromBlock'){
   starts.push(params.startHash);reads++;
   return {removedChainBlockHashes:reads<=failures?['33'.repeat(32)]:[],addedChainBlockHashes:[],acceptedTransactionIds:[]};
  }
  if(method==='getMempoolEntry'){poolReads++;throw new RpcError(method,{message:`Transaction ${txid} not found`});}
  throw new Error(`UNEXPECTED_RPC_${method}`);
 }};
}
test('read evidence restarts the same range after a selected-chain pagination reorg',async()=>{
 const rpc=reorgRpc(1),result=await absentEvidence(rpc,txid,cursor);
 assert.deepEqual(rpc.starts,[cursor,cursor]);assert.equal(result.cursorRetries,1);
 assert.equal(result.accepted,false);assert.equal(result.complete,true);assert.equal(result.inMempool,false);
});
test('persistent pagination reorg remains unknown and never becomes negative evidence',async()=>{
 const rpc=reorgRpc(Infinity);
 await assert.rejects(absentEvidence(rpc,txid,cursor),e=>e.code==='CURSOR_REORG');
 assert.equal(rpc.reads,4);assert.equal(rpc.poolReads,0);assert.ok(rpc.starts.every(x=>x===cursor));
});
