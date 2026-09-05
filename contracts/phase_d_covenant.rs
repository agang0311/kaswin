// Kaswin Phase D Forward-Parsing First-Crossing Covenant
// Implements deterministic forward DAA offset parsing and monolithic header authentication:
//
// 1. Witness provides monolithic un-partitioned canonical header preimages: [H_P, H_T]
// 2. T_hash = OpBlake2bWithKey("BlockHash", H_T)
// 3. OpChainblockSeqCommit(T_hash)
// 4. T_parent0 = H_T[18..50] (guaranteed selected parent by Toccata consensus)
// 5. T_daa_offset = ForwardParseParents(H_T) + 116
//    T_daa = OpBin2Num(H_T[T_daa_offset .. T_daa_offset + 8])
// 6. P_hash = OpBlake2bWithKey("BlockHash", H_P)
// 7. require(T_parent0 == P_hash)
// 8. P_daa_offset = ForwardParseParents(H_P) + 116
//    P_daa = OpBin2Num(H_P[P_daa_offset .. P_daa_offset + 8])
// 9. boundary = OpTxInputDaaScore(0) + delta
// 10. require(P_daa < boundary)
// 11. require(T_daa >= boundary)

use kaspa_txscript::{
    script_builder::ScriptBuilder,
    opcodes::codes::*,
    EngineFlags,
};

fn append_forward_header_parser(sb: &mut ScriptBuilder, expanded_len: usize) {
    sb.add_i64(10).unwrap();
    for _ in 0..expanded_len {
        sb.add_op(OpOver).unwrap();
        sb.add_op(OpOver).unwrap();
        sb.add_op(OpDup).unwrap();
        sb.add_i64(8).unwrap();
        sb.add_op(OpAdd).unwrap();
        sb.add_op(OpSubstr).unwrap();
        sb.add_op(OpBin2Num).unwrap();
        sb.add_i64(32).unwrap();
        sb.add_op(OpMul).unwrap();
        sb.add_i64(8).unwrap();
        sb.add_op(OpAdd).unwrap();
        sb.add_op(OpAdd).unwrap();
    }
    sb.add_i64(116).unwrap();
    sb.add_op(OpAdd).unwrap();

    sb.add_op(OpOver).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap();
}

pub fn build_canonical_first_crossing_covenant(delta_daa: i64, expanded_len: usize) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputDaaScore).unwrap();
    sb.add_i64(delta_daa).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpToAltStack).unwrap();

    // Witness Stack on entry: [H_P, H_T]
    // =========================================================================
    // Process Target Block T
    // =========================================================================
    sb.add_op(OpDup).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_i64(10).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(expanded_len as i64).unwrap();
    sb.add_op(OpEqualVerify).unwrap(); // Assert H_T.expanded_len == expanded_len!

    sb.add_op(OpDup).unwrap();
    sb.add_i64(18).unwrap();
    sb.add_i64(50).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_parent0]

    sb.add_op(OpDup).unwrap();
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    sb.add_op(OpChainblockSeqCommit).unwrap();
    sb.add_op(OpDrop).unwrap();

    append_forward_header_parser(&mut sb, expanded_len);
    // Stack: [H_P, H_T, T_daa_num]
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_parent0, T_daa_num]
    sb.add_op(OpDrop).unwrap(); // drop H_T!
    // Stack: [H_P]

    // =========================================================================
    // Process Parent Block P
    // =========================================================================
    sb.add_op(OpDup).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_i64(10).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(expanded_len as i64).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_op(OpDup).unwrap();
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // [H_P, P_hash]

    sb.add_op(OpFromAltStack).unwrap(); // T_daa_num
    sb.add_op(OpFromAltStack).unwrap(); // T_parent0
    // Stack: [H_P, P_hash, T_daa_num, T_parent0]
    sb.add_op(OpRot).unwrap(); // [H_P, T_daa_num, T_parent0, P_hash]
    sb.add_op(OpEqualVerify).unwrap();
    // Stack: [H_P, T_daa_num]
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa_num]

    append_forward_header_parser(&mut sb, expanded_len);
    // Stack: [H_P, P_daa_num]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop H_P -> [P_daa_num]

    // =========================================================================
    // First-Crossing Predicate Assertions
    // =========================================================================
    sb.add_op(OpFromAltStack).unwrap(); // T_daa_num
    sb.add_op(OpFromAltStack).unwrap(); // boundary
    // Stack: [P_daa_num, T_daa_num, boundary]

    sb.add_op(OpRot).unwrap(); // [T_daa_num, boundary, P_daa_num]
    sb.add_op(OpOver).unwrap(); // [T_daa_num, boundary, P_daa_num, boundary]
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap(); // REQUIRE P_daa < boundary!
    // Stack: [T_daa_num, boundary]

    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // REQUIRE T_daa >= boundary!

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

/// Legacy/historical builders retained for audit tests
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
