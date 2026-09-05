// Kaswin Phase D Bounded Dynamic Forward Header Parser Covenant
//
// Implements deterministic forward DAA offset parsing and monolithic header authentication:
//
// 1. Witness provides monolithic un-partitioned canonical header preimages: [H_P, H_T]
// 2. T_hash = OpBlake2bWithKey("BlockHash", H_T)
// 3. OpChainblockSeqCommit(T_hash)
// 4. T_parent0 = H_T[18..50] (guaranteed selected parent by Toccata consensus)
// 5. L_T = OpBin2Num(H_T[2..10])
//    T_daa_offset = BoundedForwardParse(H_T, L_T, max_levels) + 116
//    T_daa = OpBin2Num(H_T[T_daa_offset .. T_daa_offset + 8])
// 6. P_hash = OpBlake2bWithKey("BlockHash", H_P)
// 7. require(T_parent0 == P_hash)
// 8. L_P = OpBin2Num(H_P[2..10])
//    P_daa_offset = BoundedForwardParse(H_P, L_P, max_levels) + 116
//    P_daa = OpBin2Num(H_P[P_daa_offset .. P_daa_offset + 8])
// 9. boundary = OpTxInputDaaScore(0) + delta
// 10. require(P_daa < boundary)
// 11. require(T_daa >= boundary)

use kaspa_txscript::{
    script_builder::ScriptBuilder,
    opcodes::codes::*,
    EngineFlags,
};

/// Appends the bounded dynamic forward header parser.
/// Max levels is the deployment network parameter (e.g. 70 for TN10 tests, 251 for TN10 max, 226 for Mainnet).
/// Input stack on entry: `[H]` (monolithic header preimage)
/// Stack on exit: `[H, daa_score (as number)]`
pub fn append_bounded_dynamic_forward_header_parser(sb: &mut ScriptBuilder, max_levels: usize) {
    // Stack: [H]
    // 1. Extract L = H[2..10]
    sb.add_op(OpDup).unwrap(); // [H, H]
    sb.add_i64(2).unwrap();
    sb.add_i64(10).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [H, L]

    // Validate 1 <= L <= max_levels
    sb.add_op(OpDup).unwrap();
    sb.add_i64(0).unwrap();
    sb.add_op(OpGreaterThan).unwrap();
    sb.add_op(OpVerify).unwrap(); // L >= 1

    sb.add_op(OpDup).unwrap();
    sb.add_i64(max_levels as i64).unwrap();
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // L <= max_levels

    // Initial offset = 10
    sb.add_i64(10).unwrap();
    // Stack: [H, L, offset]

    // 2. Bounded unrolling for i in 0..max_levels:
    for i in 0..max_levels {
        // Stack: [H, L, offset]
        sb.add_op(OpOver).unwrap(); // [H, L, offset, L]
        sb.add_i64(i as i64).unwrap(); // [H, L, offset, L, i]
        sb.add_op(OpGreaterThan).unwrap(); // [H, L, offset, (L > i)]
        sb.add_op(OpIf).unwrap();
            // i < L: read level_i_len from H[offset..offset+8]
            sb.add_i64(2).unwrap();
            sb.add_op(OpPick).unwrap(); // [H, L, offset, H]
            sb.add_op(OpOver).unwrap(); // [H, L, offset, H, offset]
            sb.add_op(OpDup).unwrap();
            sb.add_i64(8).unwrap();
            sb.add_op(OpAdd).unwrap();
            sb.add_op(OpSubstr).unwrap(); // [H, L, offset, k_i_bytes (8B)]
            sb.add_op(OpBin2Num).unwrap(); // [H, L, offset, k_i]
            sb.add_i64(32).unwrap();
            sb.add_op(OpMul).unwrap();
            sb.add_i64(8).unwrap();
            sb.add_op(OpAdd).unwrap();
            sb.add_op(OpAdd).unwrap(); // [H, L, new_offset]
        sb.add_op(OpEndIf).unwrap();
    }

    // Stack: [H, L, parents_end_offset]
    // Drop L:
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap();
    // Stack: [H, parents_end_offset]

    // 3. Add 116 (fixed middle fields length)
    sb.add_i64(116).unwrap();
    sb.add_op(OpAdd).unwrap();
    // Stack: [H, daa_offset]

    // 4. Slice DAA (8 bytes at daa_offset..daa_offset + 8) and convert with OpBin2Num:
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [H, daa_offset, daa_score (number)]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap(); // [H, daa_score]
}

/// Builds the complete bounded dynamic forward first-crossing covenant script.
/// Witness stack on entry: `[H_P, H_T]`
pub fn build_bounded_dynamic_covenant(delta_daa: i64, max_levels: usize) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // 1. Calculate boundary from ARMED input 0 DAA:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputDaaScore).unwrap();
    sb.add_i64(delta_daa).unwrap();
    sb.add_op(OpAdd).unwrap();
    // AltStack: [boundary]
    sb.add_op(OpToAltStack).unwrap();

    // Witness Stack: [H_P, H_T]
    // =========================================================================
    // Process Target Block T
    // =========================================================================
    // Extract direct_parents()[0] at 18..50 from H_T:
    sb.add_op(OpDup).unwrap();
    sb.add_i64(18).unwrap();
    sb.add_i64(50).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_parent0]

    // Compute BlockHash(H_T) and verify OpChainblockSeqCommit:
    sb.add_op(OpDup).unwrap();
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    sb.add_op(OpChainblockSeqCommit).unwrap();
    sb.add_op(OpDrop).unwrap();

    // Dynamic forward parse T_daa directly from H_T:
    append_bounded_dynamic_forward_header_parser(&mut sb, max_levels);
    // Stack: [H_P, H_T, T_daa_num]
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_parent0, T_daa_num]
    sb.add_op(OpDrop).unwrap(); // drop H_T!
    // Stack: [H_P]

    // =========================================================================
    // Process Parent Block P
    // =========================================================================
    sb.add_op(OpDup).unwrap();
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // [H_P, P_hash]

    sb.add_op(OpFromAltStack).unwrap(); // T_daa_num
    sb.add_op(OpFromAltStack).unwrap(); // T_parent0
    // Stack: [H_P, P_hash, T_daa_num, T_parent0]
    sb.add_op(OpRot).unwrap(); // [H_P, T_daa_num, T_parent0, P_hash]
    sb.add_op(OpEqualVerify).unwrap(); // REQUIRE T_parent0 == P_hash!
    // Stack: [H_P, T_daa_num]
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa_num]

    // Dynamic forward parse P_daa directly from H_P:
    append_bounded_dynamic_forward_header_parser(&mut sb, max_levels);
    // Stack: [H_P, P_daa_num]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop H_P -> [P_daa_num]

    // =========================================================================
    // First-Crossing Predicate Assertions
    // =========================================================================
    sb.add_op(OpFromAltStack).unwrap(); // T_daa_num
    sb.add_op(OpFromAltStack).unwrap(); // boundary
    // Stack: [P_daa_num, T_daa_num, boundary]

    sb.add_op(OpRot).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap(); // REQUIRE P_daa < boundary!

    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // REQUIRE T_daa >= boundary!

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

/// Legacy/historical aliases retained for test compatibility
pub fn build_canonical_first_crossing_covenant(delta_daa: i64, max_levels: usize) -> Vec<u8> {
    build_bounded_dynamic_covenant(delta_daa, max_levels)
}

pub fn build_authenticated_first_crossing_script(delta_daa: i64) -> Vec<u8> {
    build_repartition_proof_first_crossing_script(delta_daa)
}

pub fn build_dynamic_first_crossing_script(delta_daa: i64) -> Vec<u8> {
    build_repartition_proof_first_crossing_script(delta_daa)
}

pub fn build_repartition_proof_first_crossing_script(delta_daa: i64) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputDaaScore).unwrap();
    sb.add_i64(delta_daa).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpToAltStack).unwrap();

    sb.add_op(OpSize).unwrap();
    sb.add_i64(55).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpCat).unwrap();

    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();

    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(18).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();

    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();

    sb.add_op(OpChainblockSeqCommit).unwrap();
    sb.add_op(OpDrop).unwrap();

    sb.add_op(OpSize).unwrap();
    sb.add_i64(55).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpCat).unwrap();

    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();

    sb.add_op(OpFromAltStack).unwrap();
    sb.add_op(OpFromAltStack).unwrap();
    sb.add_op(OpRot).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpFromAltStack).unwrap();
    sb.add_op(OpFromAltStack).unwrap();
    sb.add_op(OpRot).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}
