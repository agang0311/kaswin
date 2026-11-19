/** Rolling PASS-A acquisition. Reuses the production verifier assemblePassA, never the old-profile snapshot codec. */
import {assemblePassA,COINBASE_LANE_KEY} from '../core/lib/pass-a.js';
import {acceptedAt} from '../chain/chain.mjs';
import {requireConfirmedDrawTarget,drawTargetFromOpening} from './draw-confirmations.mjs';
import {verifyManager} from '../core.mjs';
import {uint} from '../chain/json.mjs';
import {DRAW_DELAY,TIMEOUT_DELAY,check,unhex} from '../core.mjs';
function header(b) {
 const h=b?.header;unhex(h?.hash,32);unhex(h.acceptedIdMerkleRoot,32);
 check(typeof h.blueWork==='string'&&/^(?:[0-9a-f]{2}){1,24}$/.test(h.blueWork),'PROOF_BLUE_WORK');
 const number=v=>{const n=uint(v);check(n<1n<<63n,'PROOF_INTEGER');return n;};
 return {hash:h.hash,seqCommit:h.acceptedIdMerkleRoot,blueWork:h.blueWork,daa:number(h.daaScore),blue:number(h.blueScore),timestamp:number(h.timestamp),selectedParent:h.parentsByLevel?.[0]?.[0]};
}
async function block(rpc,hash,body=false,chain=true) {
 const b=(await rpc.call('getBlock',{hash,includeTransactions:body})).block,h=header(b);
 check(h.hash===hash,'PROOF_BLOCK_HASH');
 if(chain) {check(b.verboseData?.isChainBlock===true,'PROOF_NOT_SELECTED_CHAIN');unhex(h.selectedParent,32);}
 const out={header:h};
 if(body) {
   check(b.transactions?.[0]?.subnetworkId==='0100000000000000000000000000000000000000','PROOF_COINBASE');
   out.coinbasePayload=b.transactions[0].payload;
   if(chain) {out.blues=b.verboseData.mergeSetBluesHashes;out.reds=b.verboseData.mergeSetRedsHashes;
     check(Array.isArray(out.blues)&&Array.isArray(out.reds)&&out.blues[0]===h.selectedParent,'PROOF_MERGESET');
     const all=[...out.blues,...out.reds];check(all.length<=1024&&new Set(all).size===all.length,'PROOF_MERGESET_BOUND');}
 }
 return out;
}
/** Locate the actual PASS-A first-crossing target; shared by proof acquisition and read-only UI progress. */
export async function locateRollingDrawTarget(rpc,accepting,boundary) {
 let prev=await block(rpc,accepting);
 const sink=BigInt((await rpc.call('getSinkBlueScore')).blueScore),distance=sink-prev.header.blue;
 const minConfirmationCount=Number(distance>256n?distance-256n:0n);
 for(let page=0;page<8;page++) {
   const v=await rpc.call('getVirtualChainFromBlockV2',{startHash:prev.header.hash,dataVerbosityLevel:'Low',minConfirmationCount});
   check(Array.isArray(v.removedChainBlockHashes)&&v.removedChainBlockHashes.length===0&&Array.isArray(v.addedChainBlockHashes)&&v.addedChainBlockHashes.length<=512&&v.chainBlockAcceptedTransactions?.length===v.addedChainBlockHashes.length,'PROOF_CHAIN_PAGE');
   for(let i=0;i<v.addedChainBlockHashes.length;i++) {
     const h=v.chainBlockAcceptedTransactions[i].chainBlockHeader;check(h.hash===v.addedChainBlockHashes[i]&&BigInt(h.daaScore)>prev.header.daa,'PROOF_CHAIN_ORDER');
     if(BigInt(h.daaScore)>=boundary)return {parentHash:prev.header.hash,target:h};
     prev={header:{hash:h.hash,daa:BigInt(h.daaScore)}};
   }
   if(!v.addedChainBlockHashes.length)break;
 }
 return null;
}
export async function acquireRollingProof(rpc,manager,profile,accepting) {
 const s=verifyManager(manager,profile);check(s.module==='sealed','PROOF_SEALED');
 const ev=await acceptedAt(rpc,manager.outpoint.transactionId,accepting),o=ev.tx.outputs[manager.outpoint.index];
 check(o?.value===manager.value&&o.covenant?.covenantId===manager.cid&&o.scriptPublicKey.script===manager.spk.script&&ev.acceptingDaa===manager.utxoDaa,'PROOF_CLOSE_CONTEXT');
 const boundary=manager.utxoDaa+DRAW_DELAY;
 check(manager.currentDaa>=boundary&&manager.currentDaa<manager.utxoDaa+TIMEOUT_DELAY-1000n,'PROOF_WINDOW');
 const located=await locateRollingDrawTarget(rpc,accepting,boundary);
 check(located,'PROOF_FIRST_CROSSING');
 const parent=await block(rpc,located.parentHash,true),target=await block(rpc,located.target.hash,true);
 check(target.header.selectedParent===parent.header.hash,'PROOF_FIRST_CROSSING');
 const blocks=new Map([[parent.header.hash,parent],[target.header.hash,target]]);
 for(const hash of new Set([...parent.blues,...parent.reds,...target.blues,...target.reds,parent.header.selectedParent,target.header.selectedParent])) {
   unhex(hash,32);if(!blocks.has(hash))blocks.set(hash,await block(rpc,hash,true,false));
 }
 const [parentLane,targetLane]=await Promise.all([parent,target].map(b=>rpc.call('getSeqCommitLaneProof',{blockHash:b.header.hash,laneKey:COINBASE_LANE_KEY})));
 const proof=assemblePassA({boundaryDaa:boundary,parent,target,parentLane:{...parentLane,laneKey:COINBASE_LANE_KEY},targetLane:{...targetLane,laneKey:COINBASE_LANE_KEY},blocks});
 for(const b of [parent,target]) {const fresh=await block(rpc,b.header.hash);check(fresh.header.seqCommit===b.header.seqCommit&&fresh.header.selectedParent===b.header.selectedParent,'PROOF_REORG');}
 const confirmation=await requireConfirmedDrawTarget(rpc,drawTargetFromOpening(proof.opening));
 return {...proof,confirmation,accessor:{blockHash:proof.target.hash,sequenceCommitment:proof.target.seqCommit}};
}
