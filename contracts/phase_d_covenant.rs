use kaspa_txscript::{
    script_builder::ScriptBuilder,
    opcodes::codes::*,
};

/// Builds the production-ready dynamic canonical blue_work suffix binding covenant.
///
/// Witness Stack Layout (Bottom to Top):
///  0. P_before_daa
///  1. P_daa (8B)
///  2. P_blue_score (8B)
///  3. P_work_len (8B)
///  4. P_work (W_p bytes)
///  5. P_pruning (32B)
///  6. T_before_p0 (18B)
///  7. T_parent0 (32B)
///  8. T_between
///  9. T_daa (8B)
/// 10. T_blue_score (8B)
/// 11. T_work_len (8B)
/// 12. T_work (W_t bytes)
/// 13. T_pruning (32B)
pub fn build_dynamic_first_crossing_script(delta_daa: i64) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();

    // Calculate boundary = ARMED input 0 DAA + delta:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputDaaScore).unwrap();
    sb.add_i64(delta_daa).unwrap();
    sb.add_op(OpAdd).unwrap();
    // AltStack: [boundary]
    sb.add_op(OpToAltStack).unwrap();

    // =========================================================================
    // PART I: Target Block T Validation & Preimage Assembly
    // =========================================================================
    // Stack: [..., T_between, T_daa, T_blue_score, T_work_len, T_work, T_pruning]

    // 1. Validate T_pruning: len == 32
    sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // 2. Validate T_work and canonical no-leading-zero:
    // Stack: [..., T_work_len, T_work, T_pruning]
    sb.add_op(OpSwap).unwrap(); // [..., T_work_len, T_pruning, T_work]
    sb.add_op(OpSize).unwrap(); // [..., T_work_len, T_pruning, T_work, W_t]
    sb.add_op(OpDup).unwrap();
    sb.add_i64(24).unwrap();
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // W_t <= 24

    // Check no leading zero if W_t > 0:
    sb.add_op(OpOver).unwrap(); // T_work
    sb.add_op(OpOver).unwrap(); // W_t
    sb.add_op(OpIf).unwrap();
        sb.add_i64(0).unwrap();
        sb.add_i64(1).unwrap();
        sb.add_op(OpSubstr).unwrap();
        sb.add_data(&[0x00]).unwrap();
        sb.add_op(OpEqual).unwrap();
        sb.add_op(OpNot).unwrap();
        sb.add_op(OpVerify).unwrap(); // T_work[0] != 0
    sb.add_op(OpElse).unwrap();
        sb.add_op(OpDrop).unwrap();
    sb.add_op(OpEndIf).unwrap();
    // Stack: [..., T_work_len, T_pruning, T_work, W_t]

    // 3. Validate T_work_len: len == 8 and OpBin2Num(T_work_len) == W_t
    sb.add_op(OpRot).unwrap(); // [..., T_work_len, T_work, W_t, T_pruning]
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_pruning]
    // Stack: [..., T_work_len, T_work, W_t]
    sb.add_op(OpRot).unwrap(); // [..., T_work, W_t, T_work_len]
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // len(T_work_len) == 8
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [..., T_work, W_t, T_work_len, num(T_work_len)]
    sb.add_op(OpRot).unwrap(); // [..., T_work, T_work_len, num(T_work_len), W_t]
    sb.add_op(OpEqualVerify).unwrap(); // num(T_work_len) == W_t!

    // Assemble T tail: T_work_len || T_work || T_pruning
    // Stack: [..., T_work, T_work_len]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [..., T_work_len_and_work]
    sb.add_op(OpFromAltStack).unwrap(); // T_pruning
    sb.add_op(OpCat).unwrap(); // [..., T_work_and_pruning]

    // 4. Validate T_blue_score: len == 8
    sb.add_op(OpSwap).unwrap(); // [..., T_work_and_pruning, T_blue_score]
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [..., T_blue_score_and_tail]

    // 5. Validate T_daa: len == 8, save to AltStack, assemble with tail
    sb.add_op(OpSwap).unwrap(); // [..., T_blue_score_and_tail, T_daa]
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [..., T_between, T_daa_and_tail]
    sb.add_op(OpCat).unwrap(); // [..., T_before_p0, T_parent0, T_between_daa_tail]

    // 6. Validate T_parent0: len == 32, save to AltStack
    sb.add_op(OpSwap).unwrap(); // [..., T_before_p0, T_between_daa_tail, T_parent0]
    sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa, T_parent0]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [..., T_before_p0, T_p0_and_rest]

    // 7. Validate T_before_p0: len == 18
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(18).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [P_items..., T_full_header]

    // Compute BlockHash(T) and OpChainblockSeqCommit(T_hash):
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // [P_items..., T_hash]
    sb.add_op(OpChainblockSeqCommit).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop seq_commit
    // Stack: [P_before_daa, P_daa, P_blue_score, P_work_len, P_work, P_pruning]

    // =========================================================================
    // PART II: Parent Block P Validation & Preimage Assembly
    // =========================================================================
    // 8. Validate P_pruning: len == 32
    sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // 9. Validate P_work and canonical no-leading-zero:
    sb.add_op(OpSwap).unwrap(); // [..., P_work_len, P_pruning, P_work]
    sb.add_op(OpSize).unwrap(); // [..., P_work_len, P_pruning, P_work, W_p]
    sb.add_op(OpDup).unwrap();
    sb.add_i64(24).unwrap();
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpOver).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpIf).unwrap();
        sb.add_i64(0).unwrap();
        sb.add_i64(1).unwrap();
        sb.add_op(OpSubstr).unwrap();
        sb.add_data(&[0x00]).unwrap();
        sb.add_op(OpEqual).unwrap();
        sb.add_op(OpNot).unwrap();
        sb.add_op(OpVerify).unwrap();
    sb.add_op(OpElse).unwrap();
        sb.add_op(OpDrop).unwrap();
    sb.add_op(OpEndIf).unwrap();

    // 10. Validate P_work_len: len == 8 and OpBin2Num == W_p
    sb.add_op(OpRot).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa, T_parent0, P_pruning]
    sb.add_op(OpRot).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpRot).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpFromAltStack).unwrap(); // P_pruning
    sb.add_op(OpCat).unwrap(); // [P_before_daa, P_daa, P_blue_score, P_work_and_pruning]

    // 11. Validate P_blue_score: len == 8
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [P_before_daa, P_daa, P_blue_and_tail]

    // 12. Validate P_daa: len == 8, save to AltStack
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa, T_parent0, P_daa]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [P_before_daa, P_daa_and_tail]
    sb.add_op(OpCat).unwrap(); // [P_full_header]

    // Compute BlockHash(P):
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    // Stack: [P_hash]

    // =========================================================================
    // PART III: First-Crossing Predicate Assertions
    // =========================================================================
    // AltStack layout (bottom to top): [boundary, T_daa, T_parent0, P_daa]
    sb.add_op(OpFromAltStack).unwrap(); // P_daa
    sb.add_op(OpFromAltStack).unwrap(); // T_parent0
    // Stack: [P_hash, P_daa, T_parent0]
    sb.add_op(OpRot).unwrap(); // [P_daa, T_parent0, P_hash]
    sb.add_op(OpEqualVerify).unwrap(); // REQUIRE T_parent0 == P_hash!
    // Stack: [P_daa]

    // Check P_daa < boundary
    sb.add_op(OpBin2Num).unwrap(); // P_daa as number
    sb.add_op(OpFromAltStack).unwrap(); // T_daa
    sb.add_op(OpFromAltStack).unwrap(); // boundary
    // Stack: [P_daa_num, T_daa_bytes, boundary]
    sb.add_op(OpRot).unwrap(); // [T_daa_bytes, boundary, P_daa_num]
    sb.add_op(OpOver).unwrap(); // [T_daa_bytes, boundary, P_daa_num, boundary]
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap(); // REQUIRE P_daa < boundary!
    // Stack: [T_daa_bytes, boundary]

    // Check T_daa >= boundary
    sb.add_op(OpSwap).unwrap(); // [boundary, T_daa_bytes]
    sb.add_op(OpBin2Num).unwrap(); // [boundary, T_daa_num]
    sb.add_op(OpSwap).unwrap(); // [T_daa_num, boundary]
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // REQUIRE T_daa >= boundary!

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}
