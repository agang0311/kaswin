/** Exact persisted wire identity for both own-record trackers. v1 txid alone omits signatures. */
import {stable} from '../core/lib/bytes.js';
import {referenceTxId} from '../core/lib/transaction.js';
import {txToRpc} from '../chain/nodes.mjs';
import {failure} from '../chain/operation.mjs';
export const signedWire = signed => stable(txToRpc(signed));
export function assertSignedRecord(record, wire) {
  const txid = record.txid ?? record.draft.txid;
  if (!record.signed || txid !== record.draft.txid || referenceTxId(record.signed) !== txid ||
      (wire != null && signedWire(record.signed) !== wire)) throw failure('SEND_BYTES_CHANGED');
  return txid;
}
