import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sdk = require('/root/kaspa/references/kaspa-wasm32-sdk/nodejs/kaspa');

/**
 * Phase D 27-byte Redeem Script Builder.
 * This script was executed on-chain in Phase D experiments.
 * Hex representation: 00c00164936b6b6c7c6c6ea2696b756bd4756c6b6c7b886c9f6951
 */
export function buildPhaseDRedeemScript(delta = 100n) {
  const sb = new sdk.ScriptBuilder();
  // Compute boundary = input 0 daa + delta
  sb.addOp(0x00); // input 0
  sb.addOp(0xc0); // OpTxInputDaaScore -> [d_arm]
  sb.addI64(delta); // [d_arm, 100]
  sb.addOp(0x93); // OpAdd -> [boundary]
  sb.addOp(0x6b); // OpToAltStack -> Alt: [boundary]

  // Witness stack on entry:
  // [P_hash (32B), P_daa (8B), T_hash (32B), T_daa (8B), T_parent0 (32B)]
  // 2. Check T_parent0 == P_hash
  sb.addOp(0x6b); // OpToAltStack -> Alt: [boundary, T_parent0]
  // Stack: [P_hash, P_daa, T_hash, T_daa]

  // Check T_daa >= boundary
  sb.addOp(0x6c); // OpFromAltStack -> T_parent0
  sb.addOp(0x7c); // OpSwap
  sb.addOp(0x6c); // OpFromAltStack -> boundary
  sb.addOp(0x6e); // Op2Dup
  sb.addOp(0xa2); // OpGreaterThanOrEqual
  sb.addOp(0x69); // OpVerify

  // Clean stack
  sb.addOp(0x6b); // OpToAltStack -> Alt: [boundary]
  sb.addOp(0x75); // OpDrop -> drop T_daa
  sb.addOp(0x6b); // OpToAltStack -> Alt: [boundary, T_parent0]
  // Stack: [P_hash, P_daa, T_hash]

  // OpChainblockSeqCommit(T_hash)
  sb.addOp(0xd4); // OpChainblockSeqCommit -> [P_hash, P_daa, seq_commit]
  sb.addOp(0x75); // OpDrop -> [P_hash, P_daa]

  // Check P_daa < boundary
  sb.addOp(0x6c); // OpFromAltStack -> T_parent0
  sb.addOp(0x6b); // OpToAltStack -> Alt: [T_parent0]
  sb.addOp(0x6c); // OpFromAltStack -> T_parent0
  // Stack: [P_hash, P_daa, T_parent0]
  sb.addOp(0x7b); // OpRot -> [P_daa, T_parent0, P_hash]
  sb.addOp(0x88); // OpEqualVerify (assert T_parent0 == P_hash)
  // Stack: [P_daa]

  sb.addOp(0x6c); // OpFromAltStack -> boundary
  sb.addOp(0x9f); // OpLessThan (assert P_daa < boundary)
  sb.addOp(0x69); // OpVerify

  sb.addOp(0x51); // OpTrue (1)

  return sb.drain();
}
