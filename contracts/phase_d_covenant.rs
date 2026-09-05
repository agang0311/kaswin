use kaspa_txscript::{
    script_builder::ScriptBuilder,
    opcodes::codes::*,
};

pub fn build_repartition_proof_first_crossing_script(delta_daa: i64) -> Vec<u8> {
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
    // 1. Assert T_tail is exactly 55 bytes
    sb.add_op(OpSize).unwrap(); // [..., T_tail, len(T_tail)]
    sb.add_i64(55).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // Strictly enforces T_tail == 55 bytes!

    // 2. Assert T_daa is exactly 8 bytes
    sb.add_op(OpSwap).unwrap(); // [..., T_between, T_tail, T_daa]
    sb.add_op(OpSize).unwrap(); // [..., T_between, T_tail, T_daa, len(T_daa)]
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // Strictly enforces T_daa == 8 bytes!

    // Save T_daa to AltStack for numeric comparison
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa]
    sb.add_op(OpSwap).unwrap(); // [..., T_between, T_daa, T_tail]
    sb.add_op(OpCat).unwrap();  // [..., T_between, T_daa_tail]
    sb.add_op(OpCat).unwrap();  // [..., T_before, T_p0, T_between_daa_tail]

    // 3. Assert T_parent0 is exactly 32 bytes
    sb.add_op(OpSwap).unwrap(); // [..., T_before, T_between_daa_tail, T_p0]
    sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // Strictly enforces T_parent0 == 32 bytes!

    // Save T_parent0 to AltStack
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa, T_parent0]
    sb.add_op(OpSwap).unwrap(); // [..., T_before, T_p0, T_between_daa_tail]
    sb.add_op(OpCat).unwrap();  // [..., T_before, T_p0_between_daa_tail]

    // 4. Assert T_before_parent0 is exactly 18 bytes
    sb.add_op(OpSwap).unwrap(); // [..., T_p0_between_daa_tail, T_before]
    sb.add_op(OpSize).unwrap();
    sb.add_i64(18).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // Strictly enforces T_before_parent0 == 18 bytes!
    sb.add_op(OpSwap).unwrap(); // [..., T_before, T_p0_between_daa_tail]
    sb.add_op(OpCat).unwrap();  // [P_before_daa, P_daa, P_tail, T_full_header]

    // Compute T_hash:
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    // Stack: [P_before_daa, P_daa, P_tail, T_hash]

    // Enforce OpChainblockSeqCommit(T_hash):
    sb.add_op(OpChainblockSeqCommit).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop seq_commit
    // Stack: [P_before_daa, P_daa, P_tail]

    // Step B: Process P
    // 5. Assert P_tail is exactly 55 bytes
    sb.add_op(OpSize).unwrap();
    sb.add_i64(55).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // Strictly enforces P_tail == 55 bytes!

    // 6. Assert P_daa is exactly 8 bytes
    sb.add_op(OpSwap).unwrap(); // [P_before_daa, P_tail, P_daa]
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // Strictly enforces P_daa == 8 bytes!

    // Save P_daa to AltStack
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa, T_parent0, P_daa]
    sb.add_op(OpSwap).unwrap(); // [P_before_daa, P_daa, P_tail]
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpCat).unwrap(); // [P_full_header]

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
    sb.add_op(OpBin2Num).unwrap();
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
