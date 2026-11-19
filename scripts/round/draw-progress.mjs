/** Read-only draw progress. This observation never authorizes a signature or replaces full PASS-A verification. */
import {DRAW_DELAY,check} from '../core.mjs';
import {locateRollingDrawTarget} from './draw-proof.mjs';
import {requireConfirmedDrawTarget,DRAW_MIN_CONFIRMATIONS,DRAW_REUSE_MS} from './draw-confirmations.mjs';
import {uint} from '../chain/json.mjs';

const locatedByRpc=new WeakMap();
export async function readDrawProgress(rpc,round) {
  check(round.manager&&round.accepting,'ACCEPTING_BLOCK_REQUIRED');
  const boundary=round.manager.utxoDaa+DRAW_DELAY,cacheKey=`${round.cid}/${round.accepting}/${boundary}`;
  let rpcCache=rpc&&typeof rpc==='object'?locatedByRpc.get(rpc):null;
  if(!rpcCache&&rpc&&typeof rpc==='object'){rpcCache=new Map();locatedByRpc.set(rpc,rpcCache);}
  let located=rpcCache?.get(cacheKey)??null;
  if(!located){
    located=await locateRollingDrawTarget(rpc,round.accepting,boundary);
    if(!located)return {phase:'CHECKING',requiredConfirmations:DRAW_MIN_CONFIRMATIONS,observedAt:Date.now()};
    if(rpcCache){if(rpcCache.size>=32)rpcCache.delete(rpcCache.keys().next().value);rpcCache.set(cacheKey,located);}
  }
  const h=located.target,target={hash:h.hash,sequenceCommitment:h.acceptedIdMerkleRoot,blueScore:uint(h.blueScore)};
  try {
    const observation=await requireConfirmedDrawTarget(rpc,target,{maxAgeMs:DRAW_REUSE_MS});
    return {phase:'READY',confirmations:observation.confirmations,requiredConfirmations:DRAW_MIN_CONFIRMATIONS,observedAt:observation.observedAt};
  } catch(e) {
    if((e.safeCode??e.code)!=='DRAW_TARGET_UNCONFIRMED'||!e.drawConfirmation){
      rpcCache?.delete(cacheKey);
      throw e;
    }
    return {phase:'TARGET_WAIT',confirmations:e.drawConfirmation.confirmations,requiredConfirmations:DRAW_MIN_CONFIRMATIONS,observedAt:e.drawConfirmation.observedAt};
  }
}
