use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

#[path = "v1_constants.rs"]
pub mod v1_constants;
use v1_constants::{DELTA_DAA_V1, FULL_SALE_RECOVERY_DELAY_DAA_V1};

#[path = "ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::is_canonical_payout_spk;

#[path = "refunding_covenant.rs"]
pub mod refunding_covenant;
use refunding_covenant::{canonical_refunding_body_len, build_refunding_body};

#[path = "winner_selection.rs"]
pub mod winner_selection;
use winner_selection::{
    build_complete_draw_ready_suffix,
    MAX_TOTAL_TICKETS,
};

#[path = "lineage.rs"]
pub mod lineage;
use lineage::append_kaswin_singleton_continuation_guard;

pub const ACTION_DRAW: i64 = 1;
pub const ACTION_FULL_REFUND: i64 = 2;

fn make_blake3_key(tag: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[..tag.len()].copy_from_slice(tag);
    key
}

pub fn compute_application_commitment(
    round_id: &Hash,
    ticket_root: &Hash,
    total_tickets: u64,
) -> Hash {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS, "total_tickets out of bounds");
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

/// Builds the canonical prefix for production SEALED V1 covenant:
/// [0] OpTxInputIndex, Op0, OpEqualVerify (3B)
/// [1] round_id (33B)
/// [2] ticket_price (9B)
/// [3] total_tickets (9B)
/// [4] ticket_root (33B)
/// [5] purchase_count (9B)
/// [6] reserve_payout_spk (1 + len B)
pub fn build_sealed_prefix_v1(
    round_id: &Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: &Hash,
    purchase_count: u64,
    reserve_payout_spk: &[u8],
) -> Vec<u8> {
    assert!(is_canonical_payout_spk(reserve_payout_spk));
    let mut sb = ScriptBuilder::new();
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&total_tickets.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(reserve_payout_spk).unwrap();
    sb.drain()
}

/// Builds the state-independent body of production SEALED V1 covenant.
pub fn build_sealed_body_v1(total_tickets: u64, creator_refund_spk_len: usize) -> ScriptBuilderResult<Vec<u8>> {
    let mut sb = ScriptBuilder::new();

    // On entry to redeem script execution:
    // Move the 6 prefix items to AltStack:
    for _ in 0..6 {
        sb.add_op(OpToAltStack)?;
    }
    // AltStack top-to-bottom:
    // [round_id, ticket_price, total_tickets, ticket_root, purchase_count, reserve_payout_spk]
    // DStack top is now: action!

    sb.add_op(OpBin2Num)?;
    sb.add_op(OpDup)?;
    sb.add_i64(ACTION_DRAW)?;
    sb.add_op(OpEqual)?;

    sb.add_op(OpIf)?;
        // -------------------------------------------------------------
        // BRANCH 1: ACTION_DRAW (1)
        // -------------------------------------------------------------
        sb.add_op(OpDrop)?; // drop action

        // Exact witness opening count check:
        // Stack must have exactly 12 items on entry:
        sb.add_op(OpDepth)?;
        sb.add_i64(12)?;
        sb.add_op(OpNumEqualVerify)?;

        // -------------------------------------------------------------
        // Strict Fixed-Width Opening Schema Verification
        // Exactly identical to frozen build_sealed_to_draw_ready_covenant:
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
        // Derive Boundary from Authenticated Input 0 DAA Score
        // boundary = OpTxInputDaaScore(0) + DELTA_DAA_V1 (100)
        // -------------------------------------------------------------
        sb.add_op(Op0)?;
        sb.add_op(OpTxInputDaaScore)?;
        sb.add_i64(DELTA_DAA_V1 as i64)?;
        sb.add_op(OpAdd)?;
        sb.add_op(OpToAltStack)?; // AltStack: [..., boundary]

        // -------------------------------------------------------------
        // First-Crossing Predicate Checks on DAA scores
        // -------------------------------------------------------------
        sb.add_op(Op1)?;
        sb.add_op(OpPick)?; // [10] p_daa
        sb.add_op(OpFromAltStack)?; // boundary
        sb.add_op(OpDup)?;
        sb.add_op(OpToAltStack)?;   // keep copy on AltStack: [..., boundary]
        sb.add_op(OpLessThan)?;
        sb.add_op(OpVerify)?;

        sb.add_op(Op7)?;
        sb.add_op(OpPick)?; // [4] target_daa
        sb.add_op(OpFromAltStack)?; // boundary consumed
        sb.add_op(OpGreaterThanOrEqual)?;
        sb.add_op(OpVerify)?;

        // -------------------------------------------------------------
        // Reconstruct C_P and C_T via 8x OpBlake3WithKey
        // -------------------------------------------------------------
        let key_mergeset = make_blake3_key(b"SeqCommitMergesetContext");
        let key_branch = make_blake3_key(b"SeqCommitmentMerkleBranchHash");

        // Reconstruct C_P:
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

        // Reconstruct C_T:
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

        // Authenticate T with OpChainblockSeqCommit:
        sb.add_op(OpOver)?; // target_hash
        sb.add_op(OpChainblockSeqCommit)?;
        sb.add_op(OpEqualVerify)?;
        // DStack now contains: [target_hash]!

        // Bring the 6 prefix items back from AltStack to DStack:
        // AltStack was: [round_id, ticket_price, total_tickets, ticket_root, purchase_count, reserve_spk]
        sb.add_op(OpFromAltStack)?; // round_id
        sb.add_op(OpFromAltStack)?; // ticket_price
        sb.add_op(OpFromAltStack)?; // total_tickets
        sb.add_op(OpFromAltStack)?; // ticket_root
        sb.add_op(OpFromAltStack)?; // purchase_count
        sb.add_op(OpFromAltStack)?; // reserve_payout_spk

        // DStack now:
        // [target_hash, round_id, ticket_price, total_tickets, ticket_root, purchase_count, reserve_spk]
        // Depths from top:
        // 0: reserve_spk
        // 1: purchase_count
        // 2: ticket_root
        // 3: total_tickets
        // 4: ticket_price
        // 5: round_id
        // 6: target_hash

        // Compute application_commitment dynamically on stack:
        // BLAKE2b256("KaswinAppV1" || round_id || ticket_root || total_tickets)
        sb.add_data(b"KaswinAppV1")?;
        sb.add_i64(6)?;
        sb.add_op(OpPick)?; // round_id (index 1 -> depth 6)
        sb.add_op(OpCat)?;

        sb.add_i64(3)?;
        sb.add_op(OpPick)?; // ticket_root (index 4 -> depth 3)
        sb.add_op(OpCat)?;

        sb.add_i64(4)?;
        sb.add_op(OpPick)?; // total_tickets (index 3 -> depth 4)
        sb.add_op(OpCat)?;
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?; // app_comm

        // Compute random_seed:
        // BLAKE2b256("KaspaPoWRandomnessV1" || target_hash || app_comm)
        sb.add_data(b"KaspaPoWRandomnessV1")?;
        sb.add_i64(8)?;
        sb.add_op(OpPick)?; // target_hash (index 0 -> depth 8)
        sb.add_op(OpCat)?;
        sb.add_op(OpSwap)?; // app_comm
        sb.add_op(OpCat)?;
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?; // random_seed

        // DStack now:
        // [target_hash, round_id, ticket_price, total_tickets, ticket_root, purchase_count, reserve_spk, random_seed]
        // Depths:
        // 0: random_seed
        // 1: reserve_spk
        // 2: purchase_count
        // 3: ticket_root
        // 4: total_tickets
        // 5: ticket_price
        // 6: round_id
        // 7: target_hash

        // Reconstruct DRAW_READY(0) redeem script:
        // Prefix contains:
        // [0] OpTxInputIndex, Op0, OpEqualVerify (3B)
        // [1] round_id (33B)
        // [2] ticket_price (9B)
        // [3] total_tickets (9B)
        // [4] ticket_root (33B)
        // [5] target_hash (33B)
        // [6] random_seed (33B)
        // [7] creator_refund_spk (1 + len B)
        // Followed by counter = 0 (9B) and draw_ready_suffix.

        sb.add_data(&[OpTxInputIndex as u8, Op0 as u8, OpEqualVerify as u8, 0x20])?;
        sb.add_i64(7)?;
        sb.add_op(OpPick)?; // round_id (depth 7)
        sb.add_op(OpCat)?;

        // ticket_price: 0x08 || ticket_price (depth 6)
        sb.add_data(&[0x08])?;
        sb.add_op(OpCat)?;
        sb.add_i64(6)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpCat)?;

        // total_tickets: 0x08 || total_tickets (depth 5)
        sb.add_data(&[0x08])?;
        sb.add_op(OpCat)?;
        sb.add_i64(5)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpCat)?;

        // ticket_root: 0x20 || ticket_root (depth 4)
        sb.add_data(&[0x20])?;
        sb.add_op(OpCat)?;
        sb.add_i64(4)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpCat)?;

        // target_hash: 0x20 || target_hash (depth 8)
        sb.add_data(&[0x20])?;
        sb.add_op(OpCat)?;
        sb.add_i64(8)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpCat)?;

        // random_seed: 0x20 || random_seed (depth 1)
        sb.add_data(&[0x20])?;
        sb.add_op(OpCat)?;
        sb.add_i64(1)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpCat)?;

        // creator_refund_spk: push_byte || creator_refund_spk (depth 2)
        sb.add_data(&[creator_refund_spk_len as u8])?;
        sb.add_op(OpCat)?;
        sb.add_i64(2)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpCat)?;

        // Counter = 0: [0x08, 0, 0, 0, 0, 0, 0, 0, 0]
        sb.add_data(&[0x08, 0, 0, 0, 0, 0, 0, 0, 0])?;
        sb.add_op(OpCat)?;

        // Append draw_ready_suffix for given total_tickets and creator_refund_spk_len:
        let draw_ready_suffix = build_complete_draw_ready_suffix(total_tickets, creator_refund_spk_len);
        for chunk in draw_ready_suffix.chunks(500) {
            sb.add_data(chunk)?;
            sb.add_op(OpCat)?;
        }

        // P2SH SPK of DRAW_READY(0):
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?;
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(&[0x87])?;
        sb.add_op(OpCat)?;

        // Assert Output 0 SPK == expected_draw_ready_0_spk
        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputSpk)?;
        sb.add_op(OpEqualVerify)?;

        // Clean stack: drop remaining 8 items
        for _ in 0..8 {
            sb.add_op(OpDrop)?;
        }

    sb.add_op(OpElse)?;
        // -------------------------------------------------------------
        // BRANCH 2: ACTION_FULL_REFUND (2)
        // -------------------------------------------------------------
        sb.add_i64(ACTION_FULL_REFUND)?;
        sb.add_op(OpEqualVerify)?; // Rejects unknown action!

        // Exact witness opening check: DStack must have NO witness items (depth == 0)!
        sb.add_op(OpDepth)?;
        sb.add_op(Op0)?;
        sb.add_op(OpEqualVerify)?;

        // Enforce Relative Sequence Lock: FULL_SALE_RECOVERY_DELAY_DAA_V1 (432_000)
        sb.add_data(&FULL_SALE_RECOVERY_DELAY_DAA_V1.to_le_bytes())?;
        sb.add_op(OpCheckSequenceVerify)?;

        // Bring the 6 prefix items back from AltStack to DStack:
        sb.add_op(OpFromAltStack)?; // round_id
        sb.add_op(OpFromAltStack)?; // ticket_price
        sb.add_op(OpFromAltStack)?; // total_tickets
        sb.add_op(OpFromAltStack)?; // ticket_root
        sb.add_op(OpFromAltStack)?; // purchase_count
        sb.add_op(OpFromAltStack)?; // reserve_payout_spk

        // Construct REFUNDING prefix:
        sb.add_data(&[OpTxInputIndex as u8, Op0 as u8, OpEqualVerify as u8, 0x20])?;
        sb.add_i64(6)?;
        sb.add_op(OpPick)?; // round_id (depth 5 + 1)
        sb.add_op(OpCat)?;

        sb.add_data(&[0x08])?;
        sb.add_op(OpCat)?;
        sb.add_i64(5)?;
        sb.add_op(OpPick)?; // ticket_price (depth 4 + 1)
        sb.add_op(OpCat)?;

        sb.add_data(&[0x08])?;
        sb.add_op(OpCat)?;
        sb.add_i64(4)?;
        sb.add_op(OpPick)?; // total_tickets (depth 3 + 1)
        sb.add_op(OpCat)?;

        sb.add_data(&[0x20])?;
        sb.add_op(OpCat)?;
        sb.add_i64(3)?;
        sb.add_op(OpPick)?; // ticket_root (depth 2 + 1)
        sb.add_op(OpCat)?;

        // push creator_refund_spk:
        sb.add_data(&[creator_refund_spk_len as u8])?;
        sb.add_op(OpCat)?;
        sb.add_i64(1)?;
        sb.add_op(OpPick)?; // creator_refund_spk (depth 0 + 1)
        sb.add_op(OpCat)?;

        // push purchase_count:
        sb.add_data(&[0x08])?;
        sb.add_op(OpCat)?;
        sb.add_i64(2)?;
        sb.add_op(OpPick)?; // purchase_count (depth 1 + 1)
        sb.add_op(OpCat)?;

        // push refund_cursor = 0:
        sb.add_data(&[0x08, 0, 0, 0, 0, 0, 0, 0, 0])?;
        sb.add_op(OpCat)?;

        // push remaining_tickets = total_tickets:
        sb.add_data(&[0x08])?;
        sb.add_op(OpCat)?;
        sb.add_i64(4)?;
        sb.add_op(OpPick)?; // total_tickets (depth 3 + 1)
        sb.add_op(OpCat)?;

        // Append canonical refunding body:
        let ref_body_len = canonical_refunding_body_len(creator_refund_spk_len);
        let ref_body = build_refunding_body(ref_body_len, creator_refund_spk_len)?;
        for chunk in ref_body.chunks(500) {
            sb.add_data(chunk)?;
            sb.add_op(OpCat)?;
        }

        // P2SH SPK of initial REFUNDING:
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?;
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(&[0x87])?;
        sb.add_op(OpCat)?;

        // Assert Output 0 SPK == expected_refunding_spk:
        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputSpk)?;
        sb.add_op(OpEqualVerify)?;

        // Clean stack: drop the 6 prefix items
        for _ in 0..6 {
            sb.add_op(OpDrop)?;
        }

    sb.add_op(OpEndIf)?;

    // -------------------------------------------------------------
    // COMMON EXIT GUARDS (Both DRAW and FULL_REFUND)
    // -------------------------------------------------------------
    // 1. Output 0 Amount == Input 0 Amount (Exact preservation)
    sb.add_op(Op0)?;
    sb.add_op(OpTxInputAmount)?;
    sb.add_op(Op0)?;
    sb.add_op(OpTxOutputAmount)?;
    sb.add_op(OpEqualVerify)?;

    // 2. KIP-20 Singleton Continuation Guard
    append_kaswin_singleton_continuation_guard(&mut sb)?;

    sb.add_op(OpTrue)?;
    Ok(sb.drain())
}

/// Builds the complete production SEALED V1 covenant redeem script.
pub fn build_production_sealed_covenant_v1(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: Hash,
    purchase_count: u64,
    reserve_payout_spk: Vec<u8>,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(is_canonical_payout_spk(&reserve_payout_spk));
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);

    let prefix = build_sealed_prefix_v1(
        &round_id,
        ticket_price,
        total_tickets,
        &ticket_root,
        purchase_count,
        &reserve_payout_spk,
    );
    let body = build_sealed_body_v1(total_tickets, reserve_payout_spk.len())?;

    let mut full = prefix;
    full.extend(body);
    Ok(full)
}
