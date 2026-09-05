// Kaswin Phase D Authenticated First-Crossing Covenant
// Implements full cryptographic binding:
// 1. T_header = T_before_parent0 || T_parent0 || T_between_p0_and_daa || T_daa || T_tail
// 2. BlockHash(T_header) via OpBlake2bWithKey("BlockHash")
// 3. OpChainblockSeqCommit(T_hash)
// 4. P_header = P_before_daa || P_daa || P_tail
// 5. BlockHash(P_header) via OpBlake2bWithKey("BlockHash")
// 6. require(T_parent0 == P_hash)
// 7. boundary = OpTxInputDaaScore(0) + delta
// 8. require(OpBin2Num(T_daa) >= boundary)
// 9. require(OpBin2Num(P_daa) < boundary)

use kaspa_txscript::{
    script_builder::ScriptBuilder,
    opcodes::codes::*,
};

pub fn build_authenticated_first_crossing_script(delta_daa: i64) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();

    // 1. Calculate boundary from ARMED input 0 DAA:
    // Stack: []
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputDaaScore).unwrap();
    sb.add_i64(delta_daa).unwrap();
    sb.add_op(OpAdd).unwrap();
    // Stack: [boundary]
    sb.add_op(OpToAltStack).unwrap();
    // AltStack: [boundary]

    // Witness Stack on entry (bottom to top):
    // [P_before_daa, P_daa (8B), P_tail,
    //  T_before_parent0, T_parent0 (32B), T_between, T_daa (8B), T_tail]

    // Step A: Process T
    // Top of stack is T_tail.
    // Concatenate T components:
    // Stack: [..., T_before_parent0, T_parent0, T_between, T_daa, T_tail]
    // We need T_daa for numeric comparison later, so let's save a copy to AltStack!
    sb.add_op(OpSwap).unwrap(); // [..., T_before, T_p0, T_between, T_tail, T_daa]
    sb.add_op(OpDup).unwrap();  // duplicate T_daa
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa]
    sb.add_op(OpSwap).unwrap(); // [..., T_before, T_p0, T_between, T_daa, T_tail]
    sb.add_op(OpCat).unwrap();  // [..., T_before, T_p0, T_between, T_daa_tail]
    sb.add_op(OpCat).unwrap();  // [..., T_before, T_p0, T_between_daa_tail]

    // Save T_parent0 for comparison with P_hash!
    sb.add_op(OpSwap).unwrap(); // [..., T_before, T_between_daa_tail, T_parent0]
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa, T_parent0]
    sb.add_op(OpSwap).unwrap(); // [..., T_before, T_parent0, T_between_daa_tail]
    sb.add_op(OpCat).unwrap();  // [..., T_before, T_p0_between_daa_tail]
    sb.add_op(OpCat).unwrap();  // [P_before_daa, P_daa, P_tail, T_full_header]

    // Compute T_hash:
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    // Stack: [P_before_daa, P_daa, P_tail, T_hash]

    // Enforce OpChainblockSeqCommit(T_hash):
    sb.add_op(OpChainblockSeqCommit).unwrap();
    // Stack: [P_before_daa, P_daa, P_tail, T_seq_commit]
    sb.add_op(OpDrop).unwrap(); // drop seq_commit
    // Stack: [P_before_daa, P_daa, P_tail]

    // Step B: Process P
    // We need P_daa for numeric comparison later, save a copy to AltStack!
    sb.add_op(OpSwap).unwrap(); // [P_before_daa, P_tail, P_daa]
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa, T_parent0, P_daa]
    sb.add_op(OpSwap).unwrap(); // [P_before_daa, P_daa, P_tail]
    sb.add_op(OpCat).unwrap();  // [P_before_daa, P_daa_tail]
    sb.add_op(OpCat).unwrap();  // [P_full_header]

    // Compute P_hash:
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    // Stack: [P_hash]

    // Step C: Verify T_parent0 == P_hash
    sb.add_op(OpFromAltStack).unwrap(); // P_daa
    sb.add_op(OpFromAltStack).unwrap(); // T_parent0
    // Stack: [P_hash, P_daa, T_parent0]
    sb.add_op(OpRot).unwrap(); // [P_daa, T_parent0, P_hash]
    sb.add_op(OpEqualVerify).unwrap(); // Enforces T_parent0 == P_hash!
    // Stack: [P_daa]

    // Step D: Verify P_daa < boundary
    sb.add_op(OpBin2Num).unwrap(); // converts 8-byte LE to script number!
    sb.add_op(OpFromAltStack).unwrap(); // T_daa
    sb.add_op(OpFromAltStack).unwrap(); // boundary
    // Stack: [P_daa_num, T_daa_bytes, boundary]
    sb.add_op(OpRot).unwrap(); // [T_daa_bytes, boundary, P_daa_num]
    sb.add_op(OpOver).unwrap(); // [T_daa_bytes, boundary, P_daa_num, boundary]
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap(); // Enforces P_daa < boundary!
    // Stack: [T_daa_bytes, boundary]

    // Step E: Verify T_daa >= boundary
    sb.add_op(OpSwap).unwrap(); // [boundary, T_daa_bytes]
    sb.add_op(OpBin2Num).unwrap(); // [boundary, T_daa_num]
    sb.add_op(OpSwap).unwrap(); // [T_daa_num, boundary]
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // Enforces T_daa >= boundary!

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}
