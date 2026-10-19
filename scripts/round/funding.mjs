// Ordinary self-transfer draft only. Callers still quote mass/fees and validate inputs/signatures before sending.
import {p2pk} from '../core/lib/covenant-id.js';
import {FUNDING_INPUT_BUDGET} from '../core/lib/protocol.js';
import {MAX_PAY_FEE as MAX_FEE} from '../core/lib/state.js';
const fail = code => { const e = new Error(code); e.safeCode = code; throw e; };
const need = (v, code) => { if (!v) fail(code); };

/** Ordinary self-transfer that splits one UTXO into exact-value outputs (+ change), all to the same key. */
export function buildSplit(source, key, values, fee) {
  need(values.length >= 1 && fee > 0n && fee <= MAX_FEE, 'SPLIT_SHAPE');
  const total = values.reduce((a, v) => a + v, 0n), change = source.value - total - fee;
  need(change >= 0n, 'SPLIT_FUNDS');
  const spk = p2pk(key), outputs = values.map(value => ({value, scriptPublicKey: spk, covenant: null}));
  if (change > 0n) outputs.push({value: change, scriptPublicKey: spk, covenant: null});
  return {transaction: {version: 1, inputs: [{previousOutpoint: source.outpoint, signatureScript: '', sequence: 0n, computeBudget: FUNDING_INPUT_BUDGET}],
    outputs, lockTime: 0n, subnetworkId: '00'.repeat(20), gas: 0n, payload: '', storageMass: 0n},
  inputUtxos: [source], authorizedInputIndices: [0], transition: null, origin: source.outpoint, action: 'FUND_SPLIT', walletDebit: fee, fee};
}
