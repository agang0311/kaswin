// Kaswin Phase D: KIP-21 PASS-A Opening Covenant (Production Path)
//
// Completely replaces the unbounded monolithic two-header witness parser.
// Opens SeqCommit(P) and SeqCommit(T) on the stack using 8x OpBlake3WithKey,
// authenticates T via OpChainblockSeqCommit(T_hash), and proves first-crossing.
//
// Raw witness size: 240 bytes (fixed, deterministic)
// SignatureScript: 570 bytes (vs >250,000 bytes under worst-case DAG headers)
// OpBlake3WithKey count: 8

use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

fn make_blake3_key(tag: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[..tag.len()].copy_from_slice(tag);
    key
}

/// Builds the production PASS-A redeem script for Phase D.
/// Boundary is passed or can be dynamically computed from tx inputs.
pub fn build_phase_d_pass_a_redeem_script(boundary: i64) -> ScriptBuilderResult<Vec<u8>> {
    let key_mergeset = make_blake3_key(b"SeqCommitMergesetContext");
    let key_branch = make_blake3_key(b"SeqCommitmentMerkleBranchHash");

    let mut builder = ScriptBuilder::new();

    // Witness stack on entry:
    // [0] target_hash (32B)
    // [1] target_activity (32B)
    // [2] target_payload (32B)
    // [3] target_sp_ts (8B)
    // [4] target_daa (8B)
    // [5] target_blue (8B)
    // [6] p_parent_seq (32B)
    // [7] p_activity (32B)
    // [8] p_payload (32B)
    // [9] p_sp_ts (8B)
    // [10] p_daa (8B)
    // [11] p_blue (8B)
    builder
        // Check P.daa < boundary
        .add_op(Op1)?
        .add_op(OpPick)?
        .add_i64(boundary)?
        .add_op(OpLessThan)?
        .add_op(OpVerify)?

        // Check T.daa >= boundary
        .add_op(Op7)?
        .add_op(OpPick)?
        .add_i64(boundary)?
        .add_op(OpGreaterThanOrEqual)?
        .add_op(OpVerify)?

        // --- STEP 1: Reconstruct C_P ---
        // Hash 1: P_ctx
        .add_op(OpCat)?
        .add_op(OpCat)?
        .add_data(&key_mergeset)?
        .add_op(OpBlake3WithKey)?

        // Hash 2: P_pd
        .add_op(OpSwap)?
        .add_op(OpCat)?
        .add_data(&key_branch)?
        .add_op(OpBlake3WithKey)?

        // Hash 3: P_sr
        .add_op(OpCat)?
        .add_data(&key_branch)?
        .add_op(OpBlake3WithKey)?

        // Hash 4: C_P = SeqCommit(P)
        .add_op(OpCat)?
        .add_data(&key_branch)?
        .add_op(OpBlake3WithKey)?

        // --- STEP 2: Reconstruct C_T using C_P as parent ---
        .add_i64(3)?
        .add_op(OpRoll)? // target_sp_ts
        .add_i64(3)?
        .add_op(OpRoll)? // target_daa
        .add_i64(3)?
        .add_op(OpRoll)? // target_blue
        // Hash 5: T_ctx
        .add_op(OpCat)?
        .add_op(OpCat)?
        .add_data(&key_mergeset)?
        .add_op(OpBlake3WithKey)?

        .add_i64(2)?
        .add_op(OpRoll)? // target_payload
        // Hash 6: T_pd
        .add_op(OpCat)?
        .add_data(&key_branch)?
        .add_op(OpBlake3WithKey)?

        .add_i64(2)?
        .add_op(OpRoll)? // target_activity
        // Hash 7: T_sr
        .add_op(OpSwap)?
        .add_op(OpCat)?
        .add_data(&key_branch)?
        .add_op(OpBlake3WithKey)?

        // Hash 8: C_T = SeqCommit(T)
        .add_op(OpCat)?
        .add_data(&key_branch)?
        .add_op(OpBlake3WithKey)?

        // --- STEP 3: Consensus OpChainblockSeqCommit Authentication ---
        .add_op(OpSwap)?
        .add_op(OpChainblockSeqCommit)? // actual_C_T
        .add_op(OpEqual)?; // verify C_T == actual_C_T

    Ok(builder.drain())
}
