/** Test-only in-memory TN10 node double (NOT part of the page graph; never imported by app.mjs). Implements exactly the
 * JSON-RPC methods the page uses, with a tiny selected chain, a UTXO set and a mempool. */
import {createHash} from 'node:crypto';
import {TN10} from '../../scripts/chain/tn10.mjs';
import {RpcError,txFromRpc,txToRpc} from '../../scripts/chain/nodes.mjs';
import {referenceTxId} from '../../scripts/core/lib/transaction.js';
import {spkToAddress} from '../../scripts/wallet/address.mjs';

const hash=n=>createHash('sha256').update('fake-block-'+n).digest('hex');
export class FakeNode {
  net=TN10;url='wss://fake-tn10.invalid/wrpc';utxos=new Map();mempool=new Map();chain=[];calls=[];dead=new Map();
  events=new Map();subscriptions=new Set();
  failSubmit=null;       // 'timeout' (sent, reply lost) | 'reject' (node error) | 'lost' (reply lost AND the tx never reached the pool)
  noMempoolQuery=false;  // true: getMempoolEntriesByAddresses fails (a node that does not serve it): selection must fall back to the node's own rejection
  beforeSubmit=null;     // hook(txid) invoked when the frame is handed to the transport
  constructor({blocks=60,daa=5000}={}) {for(let i=0;i<blocks;i++)this.#block(daa+10*i);}
  seq=0; // block hashes never repeat, even after a block was dropped
  on(kind,fn){if(!this.events.has(kind))this.events.set(kind,new Set());this.events.get(kind).add(fn);return()=>this.events.get(kind)?.delete(fn);}
  #emit(kind,data){for(const fn of this.events.get(kind)??[]){try{fn(data);}catch{}}}
  async subscribe(addresses,enabled=true){return this.call(enabled?'subscribe':'unsubscribe',{UtxosChanged:{addresses}});}
  #block(daa,accepted=[]) {const n=this.seq++;this.chain.push({hash:hash(n),blueScore:1000+this.chain.length,daa,accepted});return this.chain.at(-1);}
  get sinkDaa(){return BigInt(this.chain.at(-1).daa);}
  async currentDaa(){return this.sinkDaa;}
  addUtxo({txid,index=0,value,spk,daa,covenantId=null}) {this.utxos.set(`${txid}:${index}`,{outpoint:{transactionId:txid,index},value,spk,daa:BigInt(daa),covenantId,isCoinbase:false});}
  removeUtxo(txid,index=0){this.utxos.delete(`${txid}:${index}`);}
  /** Mine `n` chain blocks; the first one accepts everything in the mempool. */
  mine(n=1) {
    for(let i=0;i<n;i++) {
      const daa=this.chain.at(-1).daa+10,accepted=[],removed=[],added=[];
      const prefix=this.net?.addressPrefix??'kaspatest';
      if(i===0)for(const [txid,tx] of this.mempool) {
        if(!tx.inputs.every(x=>this.utxos.has(`${x.previousOutpoint.transactionId}:${x.previousOutpoint.index}`)))continue;
        const snaps=tx.inputs.map(x=>({...this.utxos.get(`${x.previousOutpoint.transactionId}:${x.previousOutpoint.index}`)}));
        for(const s of snaps){
          this.utxos.delete(`${s.outpoint.transactionId}:${s.outpoint.index}`);
          const addr=spkToAddress(s.spk,prefix);
          if(addr&&this.subscriptions.has(addr))removed.push({address:addr,outpoint:s.outpoint,utxoEntry:{amount:String(s.value),scriptPublicKey:'0000'+s.spk.script,blockDaaScore:String(s.daa),isCoinbase:false,covenantId:s.covenantId}});
        }
        tx.outputs.forEach((o,index)=>{
          this.addUtxo({txid,index,value:o.value,spk:o.scriptPublicKey,daa,covenantId:o.covenant?.covenantId??null});
          const addr=spkToAddress(o.scriptPublicKey,prefix);
          if(addr&&this.subscriptions.has(addr))added.push({address:addr,outpoint:{transactionId:txid,index},utxoEntry:{amount:String(o.value),scriptPublicKey:'0000'+o.scriptPublicKey.script,blockDaaScore:String(daa),isCoinbase:false,covenantId:o.covenant?.covenantId??null}});
        });
        accepted.push({txid,tx,snaps});
      }
      if(i===0)this.mempool.clear();
      this.#block(daa,accepted);
      if(removed.length||added.length)this.#emit('utxos',{added,removed});
    }
  }
  /** Shallow selected-chain reorg: the tip block (with the transactions it accepted) is replaced by a sibling at a slightly different DAA
   *  that accepts the SAME transactions; the old block stays known but is no longer a chain block. */
  reorgTip({dDaa=3}={}) {
    const b=this.chain.pop();this.dead.set(b.hash,b);
    const nb={hash:createHash('sha256').update('fake-reorg-'+b.hash).digest('hex'),blueScore:b.blueScore,daa:b.daa+dDaa,accepted:b.accepted};this.chain.push(nb);
    for(const {txid,tx} of b.accepted)tx.outputs.forEach((_,i)=>{const u=this.utxos.get(`${txid}:${i}`);if(u)u.daa=BigInt(nb.daa);});
    return nb;
  }
  /** The tip block is removed and its transactions are NOT re-accepted nor returned to the mempool (a lost candidate). */
  dropTip() {
    const b=this.chain.pop();this.dead.set(b.hash,b);
    for(const {txid,tx,snaps} of b.accepted) {
      tx.outputs.forEach((_,i)=>this.utxos.delete(`${txid}:${i}`));
      tx.inputs.forEach((x,i)=>this.utxos.set(`${x.previousOutpoint.transactionId}:${x.previousOutpoint.index}`,{...snaps[i]}));
    }
  }
  #acceptedRow(b) {
    return {chainBlockHeader:{hash:b.hash,blueScore:b.blueScore,daaScore:b.daa},acceptedTransactions:b.accepted.map(({txid,tx,snaps})=>{
      const raw=txToRpc(tx);raw.verboseData={transactionId:txid,computeMass:12345n};
      raw.inputs=raw.inputs.map((x,i)=>({...x,verboseData:{utxoEntry:{amount:snaps[i].value,blockDaaScore:snaps[i].daa,covenantId:snaps[i].covenantId,scriptPublicKey:'0000'+snaps[i].spk.script}}}));
      return raw;})};
  }
  #at(hashText) {const i=this.chain.findIndex(b=>b.hash===hashText);if(i<0)throw new RpcError('getBlock',{message:'block not found'});return i;}
  async call(method,params={},timeoutMs,opts={}) {
    this.calls.push(method);
    const sink=this.chain.at(-1);
    switch(method) {
      case 'getUtxosByAddresses': {
        const [a]=params.addresses;
        return {entries:[...this.utxos.values()].filter(u=>spkToAddress(u.spk,'kaspatest')===a).map(u=>({address:a,outpoint:u.outpoint,
          utxoEntry:{amount:u.value,scriptPublicKey:'0000'+u.spk.script,blockDaaScore:u.daa,isCoinbase:false,covenantId:u.covenantId}}))};
      }
      case 'getFeeEstimate': return {estimate:{priorityBucket:{feerate:2,estimatedSeconds:1},normalBuckets:[{feerate:1.5,estimatedSeconds:5}],lowBuckets:[{feerate:1,estimatedSeconds:50}]}};
      case 'getSink': return {sink:sink.hash};
      case 'getSinkBlueScore': return {blueScore:sink.blueScore};
      case 'getBlock': {
        const gone=this.dead.get(params.hash);
        if(gone)return {block:{header:{hash:gone.hash,blueScore:gone.blueScore,daaScore:gone.daa},verboseData:{isChainBlock:false,selectedParentHash:hash(-1)}}};
        const i=this.#at(params.hash),b=this.chain[i];
        return {block:{header:{hash:b.hash,blueScore:b.blueScore,daaScore:b.daa},verboseData:{isChainBlock:true,selectedParentHash:i>0?this.chain[i-1].hash:hash(-1)}}};
      }
      case 'getVirtualChainFromBlock': {
        const from=this.#at(params.startHash),added=this.chain.slice(from+1);
        return {removedChainBlockHashes:[],addedChainBlockHashes:added.map(b=>b.hash),acceptedTransactionIds:added.map(b=>({acceptingBlockHash:b.hash,acceptedTransactionIds:b.accepted.map(x=>x.txid)}))};
      }
      case 'getVirtualChainFromBlockV2': {
        const from=this.#at(params.startHash),limit=sink.blueScore-(params.minConfirmationCount??0),added=this.chain.slice(from+1).filter(b=>b.blueScore<=limit);
        return {removedChainBlockHashes:[],addedChainBlockHashes:added.map(b=>b.hash),chainBlockAcceptedTransactions:added.map(b=>this.#acceptedRow(b))};
      }
      case 'getMempoolEntry': {
        if(this.mempool.has(params.transactionId))return {mempoolEntry:{fee:'1',isOrphan:false,transaction:{}}};
        throw new RpcError('getMempoolEntry',{message:`Transaction ${params.transactionId} not found`});
      }
      case 'getMempoolEntriesByAddresses': {
        // Shape of rusty-kaspa v2.1.0 (read from a live node): {entries:[{address,sending:[{fee,is_orphan,transaction}],receiving:[...]}]}.
        // `sending` = pool transactions that spend an output owned by the address.
        if(this.noMempoolQuery)throw new RpcError('getMempoolEntriesByAddresses',{message:'method not available'});
        const owns=(x,a)=>{const u=this.utxos.get(`${x.previousOutpoint.transactionId}:${x.previousOutpoint.index}`);return !!u&&spkToAddress(u.spk,'kaspatest')===a;};
        return {entries:params.addresses.map(a=>({address:a,receiving:[],
          sending:[...this.mempool.values()].filter(t=>t.inputs.some(x=>owns(x,a)))
            .map(t=>({fee:'1',is_orphan:false,transaction:{inputs:t.inputs.map(x=>({previousOutpoint:{transactionId:x.previousOutpoint.transactionId,index:x.previousOutpoint.index}}))}}))}))};
      }
      case 'submitTransaction': {
        const tx=txFromRpc(params.transaction),txid=referenceTxId(tx);
        opts.beforeSend?.();this.beforeSubmit?.(txid);
        if(this.failSubmit==='reject')throw new RpcError('submitTransaction',{message:'rejected by the fake node'});
        const missing=tx.inputs.some(x=>!this.utxos.has(`${x.previousOutpoint.transactionId}:${x.previousOutpoint.index}`));
        if(missing)throw new RpcError('submitTransaction',{message:'missing inputs'});
        for(const [id,t] of this.mempool)if(id!==txid) {
          const hit=t.inputs.find(x=>tx.inputs.some(y=>y.previousOutpoint.transactionId===x.previousOutpoint.transactionId&&y.previousOutpoint.index===x.previousOutpoint.index));
          // the node's wording (mining/errors/src/mempool.rs): an outpoint prints as "(txid, index)"
          if(hit)throw new RpcError('submitTransaction',{message:`Rejected transaction ${txid}: output (${hit.previousOutpoint.transactionId}, ${hit.previousOutpoint.index}) already spent by transaction ${id} in the mempool`});
        }
        if(this.failSubmit!=='lost'){this.mempool.set(txid,tx);}
        if(this.failSubmit==='timeout'||this.failSubmit==='lost')throw Object.assign(new Error('RPC_TIMEOUT'),{safeCode:'RPC_TIMEOUT'});
        return {transactionId:txid};
      }
      case 'subscribe': {
        for(const a of params.UtxosChanged?.addresses??[])this.subscriptions.add(a);
        return {};
      }
      case 'unsubscribe': {
        for(const a of params.UtxosChanged?.addresses??[])this.subscriptions.delete(a);
        return {};
      }
      default: throw new Error('FAKE_NODE_UNSUPPORTED '+method);
    }
  }
  close(){this.subscriptions.clear();this.#emit('disconnect',new Error('NODE_CLOSED'));}
}
