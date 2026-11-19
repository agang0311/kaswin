/** Read-only draw progress. This observation never authorizes a signature or replaces full PASS-A verification. */
import {DRAW_DELAY,check} from '../core.mjs';
import {locateRollingDrawTarget} from './draw-proof.mjs';
import {requireConfirmedDrawTarget,DRAW_MIN_CONFIRMATIONS} from './draw-confirmations.mjs';
import {uint} from '../chain/json.mjs';

export async function readDrawProgress(rpc,round) {
  check(round.manager&&round.accepting,'ACCEPTING_BLOCK_REQUIRED');
  const located=await locateRollingDrawTarget(rpc,round.accepting,round.manager.utxoDaa+DRAW_DELAY);
  if(!located)return {phase:'CHECKING',requiredConfirmations:DRAW_MIN_CONFIRMATIONS,observedAt:Date.now()};
  const h=located.target,target={hash:h.hash,sequenceCommitment:h.acceptedIdMerkleRoot,blueScore:uint(h.blueScore)};
  try {
    const observation=await requireConfirmedDrawTarget(rpc,target);
    return {phase:'READY',confirmations:observation.confirmations,requiredConfirmations:DRAW_MIN_CONFIRMATIONS,observedAt:observation.observedAt};
  } catch(e) {
    if((e.safeCode??e.code)!=='DRAW_TARGET_UNCONFIRMED'||!e.drawConfirmation)throw e;
    return {phase:'TARGET_WAIT',confirmations:e.drawConfirmation.confirmations,requiredConfirmations:DRAW_MIN_CONFIRMATIONS,observedAt:e.drawConfirmation.observedAt};
  }
}
