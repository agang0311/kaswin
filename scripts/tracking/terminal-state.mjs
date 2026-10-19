// Historical terminal cache policy. This validates a recorded recheck, never establishes current acceptance.
import {REORG_RECHECK_DAA, acceptanceDepth} from '../chain/chain.mjs';
export const TERMINAL_CHECK_SCHEMA = 'KASWIN_TERMINAL_RECHECK_1';
export function terminalCheck(view, virtualDaa, acceptingDaa, now = Date.now()) {
  return {schema: TERMINAL_CHECK_SCHEMA, txid: view.latestTxid, accepting: view.accepting,
    acceptingDaa: String(acceptingDaa), virtualDaa: String(virtualDaa), depthDaa: String(acceptanceDepth(virtualDaa, acceptingDaa)), checkedAt: now};
}
export function terminalSettled(view, evidence) {
  const decimal = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,24})$/.test(x);
  if (!view?.terminal || evidence?.schema !== TERMINAL_CHECK_SCHEMA || evidence.txid !== view.latestTxid || evidence.accepting !== view.accepting ||
      !/^[0-9a-f]{64}$/.test(evidence.txid ?? '') || !/^[0-9a-f]{64}$/.test(evidence.accepting ?? '') ||
      ![evidence.acceptingDaa, evidence.virtualDaa, evidence.depthDaa].every(decimal) ||
      !Number.isSafeInteger(evidence.checkedAt) || evidence.checkedAt < 0) return false;
  const depth = acceptanceDepth(BigInt(evidence.virtualDaa), BigInt(evidence.acceptingDaa));
  return depth >= REORG_RECHECK_DAA && depth === BigInt(evidence.depthDaa);
}
