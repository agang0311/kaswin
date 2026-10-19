/** Kaspa v1 Schnorr sighash (SIGHASH_ALL), ported from rusty-kaspa cfafeb4 consensus/core/src/hashing/sighash.rs.
 * Hasher: BLAKE2b-256 keyed with "TransactionSigningHash" (crypto/hashes/src/hashers.rs).
 * v1 does NOT commit compute budgets or storage mass — the page therefore re-checks those fields itself.
 */
import {blake2b256, cat, le, unhex, ascii, ensure} from '../core.mjs';

const KEY = ascii('TransactionSigningHash');
const H = (...parts) => blake2b256(cat(...parts), KEY);
const u16 = n => le(BigInt(n), 2), u32 = n => le(BigInt(n), 4), u64 = n => le(BigInt(n), 8);
const varBytes = b => cat(u64(b.length), b);
const spkBytes = spk => cat(u16(spk.version), varBytes(unhex(spk.script)));
const ZERO = new Uint8Array(32);

/** @param tx library DTO, utxos input UTXOs (value/spk), index input to sign. SIGHASH_ALL only. */
export function schnorrSighash(tx, utxos, index) {
  ensure(tx.version === 1, 'SIGHASH_V1_ONLY');
  ensure(index >= 0 && index < tx.inputs.length && utxos.length === tx.inputs.length, 'SIGHASH_INDEX');
  const prev = H(...tx.inputs.flatMap(i => [unhex(i.previousOutpoint.transactionId, 32), u32(i.previousOutpoint.index)]));
  const seqs = H(...tx.inputs.map(i => u64(i.sequence)));
  const outs = H(...tx.outputs.map(o => cat(u64(o.value), spkBytes(o.scriptPublicKey), o.covenant ? cat(new Uint8Array([1]), u16(o.covenant.authorizingInput), unhex(o.covenant.covenantId, 32)) : new Uint8Array([0]))));
  const payload = tx.subnetworkId === '00'.repeat(20) && tx.payload === '' ? ZERO : H(varBytes(unhex(tx.payload)));
  const input = tx.inputs[index], utxo = utxos[index];
  return H(u16(tx.version), prev, seqs,
    unhex(input.previousOutpoint.transactionId, 32), u32(input.previousOutpoint.index),
    spkBytes(utxo.spk), u64(utxo.value), u64(input.sequence),
    outs, u64(tx.lockTime), unhex(tx.subnetworkId, 20), u64(tx.gas), payload, new Uint8Array([1]));
}
