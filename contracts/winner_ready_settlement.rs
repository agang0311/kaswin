// Kaswin Production WINNER_READY Settlement Covenant & Suffix
//
// Protocol Version: Kaswin V1 (Toccata Consensus Rules)
// Economic Model: State Deposit & Principal Segregation
//
// Prefix format:
//   OpTxInputIndex, Op0, OpEqualVerify (3B)
//   DataPush(round_id[32])             (33B)
//   DataPush(ticket_price[8])          (9B)
//   DataPush(total_tickets[8])         (9B)
//   DataPush(ticket_root[32])          (33B)
//   DataPush(target_hash[32])          (33B)
//   DataPush(random_seed[32])          (33B)
//   DataPush(creator_refund_spk[len])  (1 + len B)
//   DataPush(winner_index[8])          (9B)
//
// Witness stack on entry:
//   [0..26] siblings[26..0] (27 items, siblings[0] at top)
//   [27] payout_spk (raw bytes)
//   [28] count (8 bytes LE)
//   [29] start_ticket (8 bytes LE)
//   [30] purchase_index (8 bytes LE)
//
// Total Stack depth on entry to suffix: 39 items.
//
// Stack depths from top (0) on entry:
//   0: winner_index (8 bytes LE)
//   1: creator_refund_spk (raw bytes, 34..37B)
//   2: random_seed (32B)
//   3: target_hash (32B)
//   4: ticket_root (32B)
//   5: total_tickets (8 bytes LE)
//   6: ticket_price (8 bytes LE)
//   7: round_id (32B)
//   8: purchase_index (8 bytes LE)
//   9: start_ticket (8 bytes LE)
//   10: count (8 bytes LE)
//   11: payout_spk (raw bytes)
//   12..38: siblings[0..26] (32B each)

use kaspa_hashes::{Hash, ZERO_HASH};

#[path = "lineage.rs"]
pub mod lineage;

#[path = "ticket_commitment.rs"]
pub mod ticket_commitment;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

pub const TREE_DEPTH: usize = 27;
pub const MAX_TOTAL_TICKETS: u64 = 100_000_000;

/// Builds the production WINNER_READY Settlement Suffix.
/// This suffix enforces:
/// 1. Witness depth & canonical size checks (39 items)
/// 2. Interval inclusion: start_ticket <= winner_index < start_ticket + count
/// 3. Winner Principal Payment: Output 0 SPK == winner payout_spk, Amount == ticket_price * total_tickets
/// 4. Creator State Deposit Refund: Output 1 SPK == creator_refund_spk, Amount == Input0 - Principal (deposit > 0)
/// 5. Output 0 + Output 1 == Input 0 Amount
/// 6. Merkle proof verification: purchase_leaf in ticket_root (27 levels)
/// 7. Terminal Lineage Termination Guard: Output 0 & Output 1 Covenant == None, OpCovOutputCount(C) == 0.
pub fn build_winner_ready_settlement_suffix() -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });

    // -------------------------------------------------------------
    // STEP 0: Stack Depth & Witness Canonical Width Checks
    // -------------------------------------------------------------
    sb.add_op(OpDepth).unwrap();
    sb.add_i64(39).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // purchase_index (depth 8): exactly 8 bytes
    sb.add_i64(8).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDrop).unwrap();

    // start_ticket (depth 9): exactly 8 bytes
    sb.add_i64(9).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDrop).unwrap();

    // count (depth 10): exactly 8 bytes
    sb.add_i64(10).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDrop).unwrap();

    // siblings[0..26] (depths 12..38): each exactly 32 bytes
    for i in 12..39 {
        sb.add_i64(i as i64).unwrap();
        sb.add_op(OpPick).unwrap();
        sb.add_op(OpSize).unwrap();
        sb.add_i64(32).unwrap();
        sb.add_op(OpNumEqualVerify).unwrap();
        sb.add_op(OpDrop).unwrap();
    }

    // -------------------------------------------------------------
    // STEP 1: Range Interval Assertions
    // -------------------------------------------------------------
    // 1) Defense-in-depth: winner_index (depth 0) < total_tickets (depth 5)
    sb.add_op(Op0).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [..., winner_index_num] (depth 0)
    // total_tickets was depth 5 -> now depth 6!
    sb.add_i64(6).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [..., winner_index_num, total_tickets_num]
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap();  // Stack back to 39 items!

    // 2) start_ticket (depth 9) <= winner_index (depth 0):
    sb.add_i64(9).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [..., start_ticket_num] (depth 0)
    // winner_index was depth 0 -> now depth 1!
    sb.add_i64(1).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [..., start_ticket_num, winner_index_num]
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();  // Stack back to 39 items!

    // 3) winner_index (depth 0) < start_ticket (depth 9) + count (depth 10):
    sb.add_op(Op0).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [..., winner_index_num] (depth 0)
    // start_ticket was depth 9 -> now depth 10!
    sb.add_i64(10).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [..., winner_index_num, start_ticket_num] (depth 0)
    // count was depth 10 -> now depth 12!
    sb.add_i64(12).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [..., winner_index_num, start_ticket_num, count_num]
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap();  // Stack back to 39 items!

    // -------------------------------------------------------------
    // STEP 2: State Deposit & Principal Segregation Settlement
    // -------------------------------------------------------------
    // Enforce claimant payout_spk is canonical (depth 11):
    self::ticket_commitment::append_canonical_payout_spk_check(&mut sb, 11).unwrap();

    // Compute ticket_principal = ticket_price (depth 6) * total_tickets (depth 5)
    sb.add_i64(6).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [39 items, ticket_price_num] (depth 0)
    // total_tickets was depth 5 -> now depth 6!
    sb.add_i64(6).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [39 items, ticket_price_num, total_tickets_num]
    sb.add_op(OpMul).unwrap();     // [39 items, principal] (depth 0)

    // Read Input 0 amount:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputAmount).unwrap(); // [..., principal, in_amt]

    // Compute deposit = in_amt - principal
    sb.add_op(OpDup).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpSub).unwrap(); // [..., principal, in_amt, deposit]

    // Enforce deposit > 0
    sb.add_op(OpDup).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpGreaterThan).unwrap();
    sb.add_op(OpVerify).unwrap(); // [..., principal, in_amt, deposit]

    // Verify Output 0 Amount == principal
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_i64(3).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Verify Output 0 SPK == winner payout_spk (currently at depth 11 + 3 = 14)
    sb.add_i64(14).unwrap();
    sb.add_op(OpPick).unwrap(); // payout_spk
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Verify Output 1 Amount == deposit
    sb.add_op(Op1).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap(); // consumes deposit! Stack: [..., principal, in_amt]

    // Conservation check: Output 0 Amount + Output 1 Amount == in_amt
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(Op1).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpEqualVerify).unwrap(); // consumes in_amt! Stack: [..., principal]

    // Drop principal:
    sb.add_op(OpDrop).unwrap(); // Stack restored to original 39 items!

    // Verify Output 1 SPK == creator_refund_spk (depth 1)
    sb.add_i64(1).unwrap();
    sb.add_op(OpPick).unwrap(); // creator_refund_spk
    sb.add_op(Op1).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // -------------------------------------------------------------
    // STEP 3: Merkle Tree Setup
    // -------------------------------------------------------------
    // 1) Compute payout_comm from payout_spk (depth 11):
    sb.add_i64(11).unwrap();
    sb.add_op(OpPick).unwrap(); // payout_spk
    sb.add_op(OpSize).unwrap();
    sb.add_i64(4).unwrap();
    sb.add_op(OpNum2Bin).unwrap();
    sb.add_data(b"KaswinPayoutSpkV1").unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(b"").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // Stack: [39 items, payout_comm]

    // 2) Assemble purchase_leaf:
    sb.add_data(b"KaswinTicketRangeV1").unwrap(); // Stack: [..., payout_comm, tag]
    // round_id was depth 7 -> now depth 7 + 2 = 9
    sb.add_i64(9).unwrap();
    sb.add_op(OpPick).unwrap(); // round_id
    sb.add_op(OpCat).unwrap();

    // purchase_index was depth 8 -> now depth 8 + 2 = 10
    sb.add_i64(10).unwrap();
    sb.add_op(OpPick).unwrap(); // purchase_index
    sb.add_op(OpCat).unwrap();

    // start_ticket was depth 9 -> now depth 9 + 2 = 11
    sb.add_i64(11).unwrap();
    sb.add_op(OpPick).unwrap(); // start_ticket
    sb.add_op(OpCat).unwrap();

    // count was depth 10 -> now depth 10 + 2 = 12
    sb.add_i64(12).unwrap();
    sb.add_op(OpPick).unwrap(); // count
    sb.add_op(OpCat).unwrap();

    sb.add_op(OpSwap).unwrap(); // payout_comm
    sb.add_op(OpCat).unwrap();
    sb.add_data(b"").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // Stack: [39 items, purchase_leaf]

    // Save purchase_leaf to AltStack:
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [purchase_leaf]

    // Read purchase_index (depth 8) as number and move to AltStack:
    sb.add_i64(8).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [purchase_leaf, purchase_index_num]

    // Save ticket_root (depth 4) to AltStack:
    sb.add_i64(4).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [purchase_leaf, purchase_index_num, ticket_root]

    // Clean top 12 non-sibling items from dstack (6 pairs):
    for _ in 0..6 {
        sb.add_op(Op2Drop).unwrap();
    }
    // Stack now contains ONLY: [siblings[26..0]]!

    // Reshuffle AltStack:
    // AltStack currently: [purchase_leaf, purchase_index_num, ticket_root]
    // We want AltStack: [ticket_root, purchase_leaf]
    // And dstack: [siblings[26..0], purchase_index_num]
    sb.add_op(OpFromAltStack).unwrap(); // ticket_root -> to dstack
    sb.add_op(OpFromAltStack).unwrap(); // purchase_index_num -> to dstack
    sb.add_op(OpFromAltStack).unwrap(); // purchase_leaf -> to dstack
    // dstack: [siblings, ticket_root, purchase_index_num, purchase_leaf]
    sb.add_i64(2).unwrap();
    sb.add_op(OpRoll).unwrap(); // rolls ticket_root to top
    sb.add_op(OpToAltStack).unwrap(); // push ticket_root -> AltStack: [ticket_root]
    sb.add_op(OpToAltStack).unwrap(); // push purchase_leaf -> AltStack: [ticket_root, purchase_leaf]

    // Stack is now: [siblings[26..0], purchase_index_num]!

    // -------------------------------------------------------------
    // STEP 4: Merkle Tree Traversal (27 Levels)
    // -------------------------------------------------------------
    for i in 0..TREE_DEPTH {
        sb.add_op(OpDup).unwrap();
        if i > 0 {
            sb.add_i64(1i64 << i).unwrap();
            sb.add_op(OpDiv).unwrap();
        }
        sb.add_i64(2).unwrap();
        sb.add_op(OpMod).unwrap(); // Stack: [..., sibling_i, purchase_index_num, bit_i]

        sb.add_op(OpFromAltStack).unwrap(); // current_hash
        sb.add_i64(3).unwrap();
        sb.add_op(OpRoll).unwrap(); // sibling_i to top!

        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap(); // bit_i
        sb.add_op(OpIf).unwrap();
            sb.add_op(OpSwap).unwrap();
        sb.add_op(OpEndIf).unwrap();

        sb.add_op(OpCat).unwrap();
        sb.add_data(b"KaswinTicketNodeV1").unwrap();
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpCat).unwrap();
        sb.add_data(b"").unwrap();
        sb.add_op(OpBlake2bWithKey).unwrap();

        sb.add_op(OpToAltStack).unwrap();
    }

    // Drop purchase_index_num:
    sb.add_op(OpDrop).unwrap();

    // Pop computed_root and ticket_root from AltStack:
    sb.add_op(OpFromAltStack).unwrap(); // computed_root
    sb.add_op(OpFromAltStack).unwrap(); // ticket_root
    sb.add_op(OpEqualVerify).unwrap(); // Proven: Winner leaf is in ticket_root!

    // Enforce Terminal Lineage Termination Guard:
    self::lineage::append_kaswin_terminal_lineage_guard(&mut sb).unwrap();

    // Explicit check: Output 1 also has no covenant
    sb.add_i64(1).unwrap();
    sb.add_op(OpOutputCovenantId).unwrap();
    sb.add_data(&ZERO_HASH.as_bytes()).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_i64(1).unwrap();
    sb.add_op(OpOutputAuthorizingInput).unwrap();
    sb.add_i64(-1).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

/// Builds complete production WINNER_READY redeem script.
pub fn build_production_winner_ready_covenant(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: Hash,
    target_hash: Hash,
    random_seed: Hash,
    creator_refund_spk: Vec<u8>,
    winner_index: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);
    assert!(winner_index < total_tickets);

    let mut sb = ScriptBuilder::new();
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&total_tickets.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    sb.add_data(&creator_refund_spk).unwrap();

    let mut winner_sb = ScriptBuilder::new();
    winner_sb.add_data(&winner_index.to_le_bytes()).unwrap();
    let push_bytes = winner_sb.drain();
    sb.script_mut().extend_from_slice(&push_bytes);

    let suffix = build_winner_ready_settlement_suffix();
    sb.script_mut().extend_from_slice(&suffix);
    Ok(sb.drain())
}

// =============================================================================
// V1 1-in-3-out Terminal Settlement Implementation
// =============================================================================

#[path = "v1_constants.rs"]
pub mod v1_constants;
use v1_constants::{FINALIZER_REWARD_V1, MAX_FINALIZE_FEE_V1, MIN_WINNER_PAYOUT_V1};

/// Builds canonical production WINNER_READY prefix layout:
///   round_id (32B)
///   ticket_price (8B LE)
///   draw_ticket_count (8B LE)
///   ticket_root (32B)
///   target_hash (32B)
///   random_seed (32B)
///   accepted_counter (8B LE)
///   winner_index (8B LE)
///   winner_payout_spk (34B)
///   creator_refund_spk (34B)
pub fn build_winner_ready_prefix(
    round_id: &Hash,
    ticket_price: u64,
    draw_ticket_count: u64,
    ticket_root: &Hash,
    target_hash: &Hash,
    random_seed: &Hash,
    accepted_counter: u64,
    winner_index: u64,
    winner_payout_spk: &[u8],
    creator_refund_spk: &[u8],
) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&draw_ticket_count.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    sb.add_data(&accepted_counter.to_le_bytes()).unwrap();
    sb.add_data(&winner_index.to_le_bytes()).unwrap();
    sb.add_data(winner_payout_spk).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.drain()
}

/// Builds the production WINNER_READY -> PAID settlement body (1-in / 3-out topology).
pub fn build_winner_ready_settlement_body() -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });

    // Step 0: Stack Depth & Input Validation
    sb.add_op(OpDepth).unwrap();
    sb.add_i64(11).unwrap(); // 1 witness item (finalizer_payout_spk) + 10 prefix items
    sb.add_op(OpNumEqualVerify).unwrap();

    // Validate finalizer_payout_spk at depth 10 (34-byte P2PK):
    sb.add_i64(10).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(34).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDrop).unwrap();

    // Stash finalizer_payout_spk on AltStack:
    sb.add_i64(10).unwrap();
    sb.add_op(OpRoll).unwrap();
    sb.add_op(OpToAltStack).unwrap();

    // Validate prefix items:
    sb.add_op(Op0).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(34).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // creator_refund_spk (34B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(34).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // winner_payout_spk (34B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // winner_index (8B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(3).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // accepted_counter (8B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // random_seed (32B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(5).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // target_hash (32B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(6).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // ticket_root (32B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(7).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // draw_ticket_count (8B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // ticket_price (8B)
    sb.add_op(OpDrop).unwrap();

    sb.add_i64(9).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap(); sb.add_op(OpEqualVerify).unwrap(); // round_id (32B)
    sb.add_op(OpDrop).unwrap();

    // Step 1: Topology Assertion
    sb.add_op(OpTxInputCount).unwrap();
    sb.add_i64(1).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(OpTxOutputCount).unwrap();
    sb.add_i64(3).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // Step 2: KIP-20 Terminal Lineage Termination Guard
    sb.add_op(Op0).unwrap();
    sb.add_op(OpInputCovenantId).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_data(&ZERO_HASH.as_bytes()).unwrap();
    sb.add_op(OpEqual).unwrap();
    sb.add_op(OpNot).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpDup).unwrap();
    sb.add_op(OpCovInputCount).unwrap();
    sb.add_i64(1).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(Op0).unwrap();
    sb.add_op(OpAuthOutputCount).unwrap();
    sb.add_i64(0).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    sb.add_op(OpCovOutputCount).unwrap();
    sb.add_i64(0).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    for out_idx in 0..3 {
        sb.add_i64(out_idx as i64).unwrap();
        sb.add_op(OpOutputCovenantId).unwrap();
        sb.add_data(&ZERO_HASH.as_bytes()).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

        sb.add_i64(out_idx as i64).unwrap();
        sb.add_op(OpOutputAuthorizingInput).unwrap();
        sb.add_op(Op1Negate).unwrap();
        sb.add_op(OpNumEqualVerify).unwrap();
    }

    // Step 3: SPK Assertions (P2PK script version = 0)
    // Output 0 SPK == [00 00] || winner_payout_spk
    sb.add_i64(1).unwrap();
    sb.add_op(OpPick).unwrap(); // winner_payout_spk
    sb.add_data(&[0x00, 0x00]).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Output 1 SPK == [00 00] || creator_refund_spk
    sb.add_op(Op0).unwrap();
    sb.add_op(OpPick).unwrap(); // creator_refund_spk
    sb.add_data(&[0x00, 0x00]).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_op(Op1).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Output 2 SPK == [00 00] || finalizer_payout_spk
    sb.add_data(&[0x00, 0x00]).unwrap();
    sb.add_op(OpFromAltStack).unwrap(); // finalizer_payout_spk
    sb.add_op(OpCat).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Step 4: Economics & State Deposit Isolation
    // gross_pool = ticket_price * draw_ticket_count
    sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // ticket_price
    sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // draw_ticket_count
    sb.add_op(OpMul).unwrap(); // gross_pool

    // expected_state_deposit = Input0Amount - gross_pool
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputAmount).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpSub).unwrap(); // expected_state_deposit

    // Assert expected_state_deposit >= 1
    sb.add_op(OpDup).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpGreaterThan).unwrap();
    sb.add_op(OpVerify).unwrap();

    // Assert Output 1 Amount == expected_state_deposit
    sb.add_op(Op1).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Assert Output 2 Amount == FINALIZER_REWARD_V1 (1 KAS)
    sb.add_i64(2).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_i64(FINALIZER_REWARD_V1 as i64).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // Winner Net Payout Assertion:
    // Output 0 Amount >= MIN_WINNER_PAYOUT_V1
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_i64(MIN_WINNER_PAYOUT_V1 as i64).unwrap();
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    // Output 0 Amount <= gross_pool - FINALIZER_REWARD_V1
    sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // ticket_price
    sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // draw_ticket_count
    sb.add_op(OpMul).unwrap(); // gross_pool
    sb.add_i64(FINALIZER_REWARD_V1 as i64).unwrap();
    sb.add_op(OpSub).unwrap(); // max_winner_payout

    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_op(OpPick).unwrap(); // max_winner_payout
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    // Implicit miner fee F = max_winner_payout - Output0
    sb.add_op(OpSub).unwrap(); // F

    // Assert 0 <= F <= MAX_FINALIZE_FEE_V1
    sb.add_op(OpDup).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_i64(MAX_FINALIZE_FEE_V1 as i64).unwrap();
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    // Clean execution stack: 10 prefix parameters
    for _ in 0..10 {
        sb.add_op(OpDrop).unwrap();
    }
    sb.add_op(OpTrue).unwrap();

    sb.drain()
}

/// Builds complete production WINNER_READY 1-in-3-out redeem script.
pub fn build_production_winner_ready_3out_covenant(
    round_id: Hash,
    ticket_price: u64,
    draw_ticket_count: u64,
    ticket_root: Hash,
    target_hash: Hash,
    random_seed: Hash,
    accepted_counter: u64,
    winner_index: u64,
    winner_payout_spk: Vec<u8>,
    creator_refund_spk: Vec<u8>,
) -> Vec<u8> {
    let prefix = build_winner_ready_prefix(
        &round_id,
        ticket_price,
        draw_ticket_count,
        &ticket_root,
        &target_hash,
        &random_seed,
        accepted_counter,
        winner_index,
        &winner_payout_spk,
        &creator_refund_spk,
    );
    let body = build_winner_ready_settlement_body();
    let mut full = prefix;
    full.extend_from_slice(&body);
    full
}
