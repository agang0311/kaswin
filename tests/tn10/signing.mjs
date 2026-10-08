// No SDK import or key access here. The caller supplies an approved signing closure.
import {schnorrVerify} from '../../apps/kaswin-v2/scripts/shared/lib/schnorr.mjs';
import {schnorrSighash} from '../../apps/kaswin-v2/scripts/shared/lib/sighash.mjs';
import {unhex} from '../../packages/f3.2-core/lib/bytes.js';
import {referenceTxId} from '../../packages/f3.2-core/lib/transaction.js';
export async function signDraft(draft, publicKey, signInput, verify = schnorrVerify) {
  const signed = structuredClone(draft.transaction);
  for (const i of draft.authorizedInputIndices) {
    const sig = await signInput(i);
    if (typeof sig !== 'string' || !/^41[0-9a-f]{128}01$/.test(sig)) throw Error('SIGNATURE_FORMAT');
    if (!await verify(unhex(publicKey, 32), schnorrSighash(draft.transaction, draft.inputUtxos, i), unhex(sig.slice(2, 130), 64))) throw Error('SIGNATURE_INVALID');
    signed.inputs[i].signatureScript = sig;
  }
  if (referenceTxId(signed) !== draft.txid) throw Error('SIGNED_TXID_CHANGED');
  return signed;
}
