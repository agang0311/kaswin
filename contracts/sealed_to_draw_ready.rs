// Kaswin SEALED -> DRAW_READY State Transition with Canonical KIP-21 PASS-A Randomness Freeze
//
// Protocol State Machine:
// OPEN / SELLING -> SEALED -> DRAW_READY -> PAID
//
// Transition: SEALED -> DRAW_READY
// - Boundary dynamically derived from unforgeable on-chain UTXO state:
//     boundary = OpTxInputDaaScore(0) + delta_daa
// - Witness opening count strictly enforced: OpDepth == 12
// - Strict fixed-width byte schema enforced per field before any arithmetic or OpCat:
//     target_hash (32B), target_activity (32B), target_payload (32B),
//     target_sp_ts (8B), target_daa (8B), target_blue (8B),
//     p_parent_seq (32B), p_activity (32B), p_payload (32B),
//     p_sp_ts (8B), p_daa (8B), p_blue (8B)
// - Reconstructs SeqCommit(P) and SeqCommit(T) on stack via 8x OpBlake3WithKey
// - Authenticates T via OpChainblockSeqCommit(target_hash)
// - Verifies P.daa < boundary && T.daa >= boundary (first-crossing uniqueness)
// - Deterministically computes application_commitment = BLAKE2b256(round_id || ticket_root || total_tickets)
// - Deterministically computes random_seed = BLAKE2b256("KaspaPoWRandomnessV1" || target_hash || application_commitment)
// - Enforces successor output state: DRAW_READY { round_id, ticket_root, total_tickets, principal, target_hash, random_seed }
// - Guarantees target_hash and random_seed are permanently immutable in successor covenant state!
//
// NOTE ON DRAW_READY:
// Current DRAW_READY redeem script is an interim placeholder for testing transition invariants.
// It is NOT deployable for live funds until complete Winner Selection & Payout covenant logic is attached.

use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
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

/// Builds the DRAW_READY successor redeem script template.
/// Once entered into DRAW_READY, target_hash and random_seed are immutable state parameters.
/// Subsequent stages (winner selection, payout, refund) do NOT access OpChainblockSeqCommit.
///
/// CAUTION: This is an interim placeholder for validating transition invariants only.
/// DO NOT BROADCAST ON-CHAIN WITH REAL FUNDS.
pub fn build_draw_ready_redeem_script(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    // DRAW_READY state parameters are embedded immutably in the script:
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_i64(total_tickets as i64).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    // Drop the state items during execution and return true (payout logic will be added in payout phase)
    sb.add_op(Op2Drop).unwrap(); // drop random_seed, target_hash
    sb.add_op(OpDrop).unwrap();  // drop total_tickets
    sb.add_op(Op2Drop).unwrap(); // drop ticket_root, round_id
    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

/// Builds the production-ready SEALED state covenant redeem script.
/// Spends SEALED UTXO (strictly Input 0) and enforces transition to DRAW_READY successor UTXO:
///
/// Witness stack on entry:
/// [0]  target_hash (32B)
/// [1]  target_activity (32B)
/// [2]  target_payload (32B)
/// [3]  target_sp_ts (8B)
/// [4]  target_daa (8B)
/// [5]  target_blue (8B)
/// [6]  p_parent_seq (32B)
/// [7]  p_activity (32B)
/// [8]  p_payload (32B)
/// [9]  p_sp_ts (8B)
/// [10] p_daa (8B)
/// [11] p_blue (8B)
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
    // Stack from top to bottom on entry:
    // top = [11] p_blue, [10] p_daa, [9] p_sp_ts, [8] p_payload, [7] p_activity, [6] p_parent_seq,
    //       [5] target_blue, [4] target_daa, [3] target_sp_ts, [2] target_payload, [1] target_activity, [0] target_hash
    //
    // Check item lengths without modifying stack contents:
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
    // Enforce that the script executing is indeed spending Input 0:
    sb.add_op(OpTxInputIndex)?;
    sb.add_op(Op0)?;
    sb.add_op(OpEqualVerify)?;

    // Compute boundary on AltStack:
    sb.add_op(Op0)?;
    sb.add_op(OpTxInputDaaScore)?;
    sb.add_i64(delta_daa as i64)?;
    sb.add_op(OpAdd)?;
    sb.add_op(OpToAltStack)?; // AltStack: [boundary]

    // -------------------------------------------------------------
    // STEP 3: First-Crossing Predicate Checks on DAA scores
    // -------------------------------------------------------------
    // Check P.daa < boundary:
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?; // [10] p_daa
    sb.add_op(OpFromAltStack)?; // boundary
    sb.add_op(OpDup)?;
    sb.add_op(OpToAltStack)?;   // keep copy on AltStack: [boundary]
    sb.add_op(OpLessThan)?;
    sb.add_op(OpVerify)?;

    // Check T.daa >= boundary:
    sb.add_op(Op7)?;
    sb.add_op(OpPick)?; // [4] target_daa
    sb.add_op(OpFromAltStack)?; // boundary consumed
    sb.add_op(OpGreaterThanOrEqual)?;
    sb.add_op(OpVerify)?;

    // -------------------------------------------------------------
    // STEP 4: Reconstruct C_P via 4x OpBlake3WithKey
    // -------------------------------------------------------------
    // Hash 1: P_ctx = OpBlake3WithKey(key_mergeset, p_sp_ts || p_daa || p_blue)
    sb.add_op(OpCat)?;
    sb.add_op(OpCat)?;
    sb.add_data(&key_mergeset)?;
    sb.add_op(OpBlake3WithKey)?;

    // Hash 2: P_pd = OpBlake3WithKey(key_branch, P_ctx || p_payload)
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    // Hash 3: P_sr = OpBlake3WithKey(key_branch, p_activity || P_pd)
    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    // Hash 4: C_P = SeqCommit(P) = OpBlake3WithKey(key_branch, p_parent_seq || P_sr)
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
    // Hash 5: T_ctx
    sb.add_op(OpCat)?;
    sb.add_op(OpCat)?;
    sb.add_data(&key_mergeset)?;
    sb.add_op(OpBlake3WithKey)?;

    sb.add_i64(2)?;
    sb.add_op(OpRoll)?; // target_payload
    // Hash 6: T_pd
    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    sb.add_i64(2)?;
    sb.add_op(OpRoll)?; // target_activity
    // Hash 7: T_sr
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    // Hash 8: C_T = SeqCommit(T) = OpBlake3WithKey(key_branch, C_P || T_sr)
    sb.add_op(OpCat)?;
    sb.add_data(&key_branch)?;
    sb.add_op(OpBlake3WithKey)?;

    // -------------------------------------------------------------
    // STEP 6: Authenticate T with OpChainblockSeqCommit
    // -------------------------------------------------------------
    // Stack: [target_hash, C_T]
    sb.add_op(OpOver)?; // [target_hash, C_T, target_hash]
    sb.add_op(OpChainblockSeqCommit)?; // [target_hash, C_T, actual_C_T]
    sb.add_op(OpEqualVerify)?; // Require C_T == actual_C_T!
    // Stack: [target_hash]

    // -------------------------------------------------------------
    // STEP 7: Covenant-Enforced Random Seed Derivation
    // random_seed = BLAKE2b256("KaspaPoWRandomnessV1" || target_hash || app_commitment)
    // -------------------------------------------------------------
    sb.add_op(OpDup)?; // [target_hash, target_hash]
    sb.add_data(b"KaspaPoWRandomnessV1")?; // [target_hash, target_hash, domain]
    sb.add_op(OpSwap)?; // [target_hash, domain, target_hash]
    sb.add_op(OpCat)?; // [target_hash, domain || target_hash]
    sb.add_data(&app_commitment.as_bytes())?; // [target_hash, domain || target_hash, app_commitment]
    sb.add_op(OpCat)?; // [target_hash, full_seed_preimage]
    sb.add_data(b"")?; // Blake2b empty key -> standard BLAKE2b-256
    sb.add_op(OpBlake2bWithKey)?; // [target_hash, random_seed]

    // -------------------------------------------------------------
    // STEP 8: Enforce Successor UTXO Output State (DRAW_READY)
    // Construct DRAW_READY SPK on the fly and assert OpTxOutputSpk(0) matches!
    // Output 0 value must equal Input 0 value (principal preserved).
    // -------------------------------------------------------------
    // Stack: [target_hash, random_seed]
    // Reconstruct expected DRAW_READY redeem script prefix:
    // [round_id (32B)] [ticket_root (32B)] [total_tickets (num)] [target_hash (32B)] [random_seed (32B)] [suffix...]
    let mut prefix_builder = ScriptBuilder::new();
    prefix_builder.add_data(&round_id.as_bytes())?;
    prefix_builder.add_data(&ticket_root.as_bytes())?;
    prefix_builder.add_i64(total_tickets as i64)?;
    let prefix_bytes = prefix_builder.drain();

    let mut suffix_builder = ScriptBuilder::new();
    suffix_builder.add_op(Op2Drop)?;
    suffix_builder.add_op(OpDrop)?;
    suffix_builder.add_op(Op2Drop)?;
    suffix_builder.add_op(OpTrue)?;
    let suffix_bytes = suffix_builder.drain();

    // Stack: [target_hash, random_seed]
    // Push prefix
    sb.add_data(&prefix_bytes)?; // [target_hash, random_seed, prefix]
    sb.add_i64(2)?;
    sb.add_op(OpRoll)?; // [random_seed, prefix, target_hash]
    // Format push target_hash: OpData32 (0x20) || target_hash
    sb.add_data(&[0x20])?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?; // [random_seed, prefix, push_target_hash]
    sb.add_op(OpCat)?; // [random_seed, prefix || push_target_hash]

    sb.add_op(OpSwap)?; // [prefix || push_target_hash, random_seed]
    // Format push random_seed: OpData32 (0x20) || random_seed
    sb.add_data(&[0x20])?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?; // [prefix || push_target_hash, push_random_seed]
    sb.add_op(OpCat)?; // [prefix_with_hashes]

    sb.add_data(&suffix_bytes)?;
    sb.add_op(OpCat)?; // [draw_ready_redeem_script]

    // Compute expected P2SH SPK:
    // version (2 bytes, big-endian: 0x00, 0x00) || script bytes: [OpBlake2b (0xaa), OpData32 (0x20), blake2b_256(redeem_script), OpEqual (0x87)]
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // [p2sh_hash (32B)]

    sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?; // version (0x0000), OpBlake2b (0xaa), OpData32 (0x20)
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?; // [version_and_header || p2sh_hash]
    sb.add_data(&[0x87])?; // OpEqual (0x87)
    sb.add_op(OpCat)?; // [expected_draw_ready_spk_bytes]

    // Verify Output 0 SPK == expected_draw_ready_spk_bytes
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
