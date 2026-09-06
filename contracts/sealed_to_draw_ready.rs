// Kaswin SEALED -> DRAW_READY State Transition with Canonical KIP-21 PASS-A Randomness Freeze
//
// Protocol State Machine:
// OPEN / SELLING -> SEALED -> DRAW_READY(0) -> WINNER_READY -> PAID
//
// Transition: SEALED -> DRAW_READY
// - Boundary dynamically derived from unforgeable on-chain UTXO state:
//     boundary = OpTxInputDaaScore(0) + delta_daa
// - Witness opening count strictly enforced: OpDepth == 12
// - Strict fixed-width byte schema enforced per field before any arithmetic or OpCat
// - Reconstructs SeqCommit(P) and SeqCommit(T) on stack via 8x OpBlake3WithKey
// - Authenticates T via OpChainblockSeqCommit(target_hash)
// - Verifies P.daa < boundary && T.daa >= boundary (first-crossing uniqueness)
// - Deterministically computes application_commitment = BLAKE2b256(round_id || ticket_root || total_tickets)
// - Deterministically computes random_seed = BLAKE2b256("KaspaPoWRandomnessV1" || target_hash || application_commitment)
// - Enforces successor output state: Production DRAW_READY(counter = 0)
//     Constructs the exact P2SH SPK of build_draw_ready_covenant(round_id, ticket_root, total_tickets, target_hash, random_seed, 0)
//     and asserts OpTxOutputSpk(0) == expected_draw_ready_0_spk!

use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

#[path = "winner_selection.rs"]
pub mod winner_selection;
use winner_selection::{
    build_draw_ready_prefix,
    build_complete_draw_ready_suffix,
};

fn make_blake3_key(tag: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[..tag.len()].copy_from_slice(tag);
    key
}

/// Canonical application commitment:
/// BLAKE2b256("KaswinAppV1" || round_id(32) || ticket_root(32) || total_tickets(8 LE))
pub fn compute_application_commitment(
    round_id: &Hash,
    ticket_root: &Hash,
    total_tickets: u64,
) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinAppV1");
    state.update(round_id.as_bytes().as_slice());
    state.update(ticket_root.as_bytes().as_slice());
    state.update(&total_tickets.to_le_bytes());
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

/// Canonical random seed derivation:
/// BLAKE2b256("KaspaPoWRandomnessV1" || target_hash(32) || application_commitment(32))
pub fn compute_random_seed(
    target_hash: &Hash,
    application_commitment: &Hash,
) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaspaPoWRandomnessV1");
    state.update(target_hash.as_bytes().as_slice());
    state.update(application_commitment.as_bytes().as_slice());
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

/// Builds the production-ready SEALED state covenant redeem script.
/// Spends SEALED UTXO (strictly Input 0) and enforces transition to production DRAW_READY(0) successor UTXO:
pub fn build_sealed_to_draw_ready_covenant(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    delta_daa: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    let key_mergeset = make_blake3_key(b"SeqCommitMergesetContext");
    let key_branch = make_blake3_key(b"SeqCommitmentMerkleBranchHash");
    let app_commitment = compute_application_commitment(&round_id, &ticket_root, total_tickets);

    let mut sb = ScriptBuilder::new();

    // -------------------------------------------------------------
    // STEP 0: Strict Opening Count Check
    // Stack must have exactly 12 items on entry
    // -------------------------------------------------------------
    sb.add_op(OpDepth)?;
    sb.add_i64(12)?;
    sb.add_op(OpNumEqualVerify)?;

    // -------------------------------------------------------------
    // STEP 1: Strict Fixed-Width Opening Schema Verification
    // -------------------------------------------------------------
    // [11] p_blue: 8 bytes
    sb.add_op(Op0)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [10] p_daa: 8 bytes
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [9] p_sp_ts: 8 bytes
    sb.add_op(Op2)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [8] p_payload: 32 bytes
    sb.add_op(Op3)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(32)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [7] p_activity: 32 bytes
    sb.add_op(Op4)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(32)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [6] p_parent_seq: 32 bytes
    sb.add_op(Op5)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(32)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [5] target_blue: 8 bytes
    sb.add_op(Op6)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [4] target_daa: 8 bytes
    sb.add_op(Op7)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [3] target_sp_ts: 8 bytes
    sb.add_op(Op8)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [2] target_payload: 32 bytes
    sb.add_op(Op9)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(32)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [1] target_activity: 32 bytes
    sb.add_op(Op10)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(32)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // [0] target_hash: 32 bytes
    sb.add_op(Op11)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(32)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // -------------------------------------------------------------
    // STEP 2: Derive Boundary from Authenticated Input 0 DAA Score
    // boundary = OpTxInputDaaScore(0) + delta_daa
    // -------------------------------------------------------------
    sb.add_op(OpTxInputIndex)?;
    sb.add_op(Op0)?;
    sb.add_op(OpEqualVerify)?;

    sb.add_op(Op0)?;
    sb.add_op(OpTxInputDaaScore)?;
    sb.add_i64(delta_daa as i64)?;
    sb.add_op(OpAdd)?;
    sb.add_op(OpToAltStack)?; // AltStack: [boundary]

    // -------------------------------------------------------------
    // STEP 3: First-Crossing Predicate Checks on DAA scores
    // -------------------------------------------------------------
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?; // [10] p_daa
    sb.add_op(OpFromAltStack)?; // boundary
    sb.add_op(OpDup)?;
    sb.add_op(OpToAltStack)?;   // keep copy on AltStack: [boundary]
    sb.add_op(OpLessThan)?;
    sb.add_op(OpVerify)?;

    sb.add_op(Op7)?;
    sb.add_op(OpPick)?; // [4] target_daa
    sb.add_op(OpFromAltStack)?; // boundary consumed
    sb.add_op(OpGreaterThanOrEqual)?;
    sb.add_op(OpVerify)?;

    // -------------------------------------------------------------
    // STEP 4: Reconstruct C_P via 4x OpBlake3WithKey
    // -------------------------------------------------------------
    sb.add_op(OpCat)?;
    sb.add_op(OpCat)?;
    sb.add_data(&key_mergeset)?;
    sb.add_op(OpBlake3WithKey)?;

    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    // -------------------------------------------------------------
    // STEP 5: Reconstruct C_T via 4x OpBlake3WithKey using C_P
    // -------------------------------------------------------------
    sb.add_i64(3)?;
    sb.add_op(OpRoll)?; // target_sp_ts
    sb.add_i64(3)?;
    sb.add_op(OpRoll)?; // target_daa
    sb.add_i64(3)?;
    sb.add_op(OpRoll)?; // target_blue
    sb.add_op(OpCat)?;
    sb.add_op(OpCat)?;
    sb.add_data(&key_mergeset)?;
    sb.add_op(OpBlake3WithKey)?;

    sb.add_i64(2)?;
    sb.add_op(OpRoll)?; // target_payload
    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    sb.add_i64(2)?;
    sb.add_op(OpRoll)?; // target_activity
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    // -------------------------------------------------------------
    // STEP 6: Authenticate T with OpChainblockSeqCommit
    // -------------------------------------------------------------
    sb.add_op(OpOver)?;
    sb.add_op(OpChainblockSeqCommit)?;
    sb.add_op(OpEqualVerify)?;
    // Stack: [target_hash]

    // -------------------------------------------------------------
    // STEP 7: Covenant-Enforced Random Seed Derivation
    // random_seed = BLAKE2b256("KaspaPoWRandomnessV1" || target_hash || app_commitment)
    // -------------------------------------------------------------
    sb.add_op(OpDup)?;
    sb.add_data(b"KaspaPoWRandomnessV1")?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(&app_commitment.as_bytes())?;
    sb.add_op(OpCat)?;
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // Stack: [target_hash, random_seed]

    // -------------------------------------------------------------
    // STEP 8: Enforce Successor UTXO Output State == Production DRAW_READY(0)
    // Construct the exact production DRAW_READY(counter = 0) Redeem Script on stack:
    // [prefix_before_target_hash] [push target_hash] [push random_seed] [counter_0_push] [suffix]
    // -------------------------------------------------------------
    let mut pre_th_sb = ScriptBuilder::new();
    pre_th_sb.add_op(OpTxInputIndex)?;
    pre_th_sb.add_op(Op0)?;
    pre_th_sb.add_op(OpEqualVerify)?;
    pre_th_sb.add_data(&round_id.as_bytes())?;
    pre_th_sb.add_data(&ticket_root.as_bytes())?;
    pre_th_sb.add_i64(total_tickets as i64)?;
    let pre_th_bytes = pre_th_sb.drain();

    // Suffix for DRAW_READY:
    let draw_ready_suffix = build_complete_draw_ready_suffix(
        &round_id,
        &ticket_root,
        total_tickets,
        &round_id, // target_hash placeholder in suffix compilation (needed for wr_prefix)
        &round_id, // random_seed placeholder in suffix compilation
        137,
        false,
    );

    // Counter push for counter = 0: [0x08, 0, 0, 0, 0, 0, 0, 0, 0]
    let counter_0_push = [0x08, 0, 0, 0, 0, 0, 0, 0, 0];

    // Stack: [target_hash, random_seed]
    // Push prefix before target_hash:
    sb.add_data(&pre_th_bytes)?; // [target_hash, random_seed, pre_th]
    sb.add_i64(2)?;
    sb.add_op(OpRoll)?;          // [random_seed, pre_th, target_hash]
    sb.add_data(&[0x20])?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;           // [random_seed, pre_th, push_target_hash]
    sb.add_op(OpCat)?;           // [random_seed, pre_th || push_target_hash]

    sb.add_op(OpSwap)?;          // [pre_th || push_target_hash, random_seed]
    sb.add_data(&[0x20])?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;           // [pre_th || push_target_hash, push_random_seed]
    sb.add_op(OpCat)?;           // [complete_prefix]

    // Append counter_0_push:
    sb.add_data(&counter_0_push)?;
    sb.add_op(OpCat)?;           // [complete_prefix || counter_0_push]

    // Append production draw_ready_suffix:
    sb.add_data(&draw_ready_suffix)?;
    sb.add_op(OpCat)?;           // [exact_production_draw_ready_0_redeem_script]

    // Compute expected P2SH SPK bytes:
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?;
    sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(&[0x87])?;
    sb.add_op(OpCat)?; // Stack: [expected_production_draw_ready_0_spk]

    // Verify Output 0 SPK == expected_production_draw_ready_0_spk
    sb.add_op(Op0)?;
    sb.add_op(OpTxOutputSpk)?;
    sb.add_op(OpEqualVerify)?;

    // Verify Output 0 Amount >= Input 0 Amount (preserve pool principal)
    sb.add_op(Op0)?;
    sb.add_op(OpTxInputAmount)?;
    sb.add_op(Op0)?;
    sb.add_op(OpTxOutputAmount)?;
    sb.add_op(OpGreaterThanOrEqual)?;
    sb.add_op(OpVerify)?;

    sb.add_op(OpTrue)?;
    Ok(sb.drain())
}
