// Kaswin Production WINNER_READY Settlement Covenant & Suffix
//
// Prefix format:
//   OpTxInputIndex, Op0, OpEqualVerify
//   DataPush(round_id[32])
//   DataPush(ticket_root[32])
//   DataPush(total_tickets[8])
//   DataPush(target_hash[32])
//   DataPush(random_seed[32])
//   DataPush(winner_index[8])
//
// Witness stack on entry:
//   [0..26] siblings[26..0] (27 items, siblings[0] at top)
//   [27] payout_spk (raw bytes)
//   [28] count (8 bytes LE)
//   [29] start_ticket (8 bytes LE)
//   [30] purchase_index (8 bytes LE)
//
// Stack depth on entry to suffix: 37 items.

use kaspa_hashes::Hash;

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
/// This suffix is stateless and depends only on the 6 prefix variables pushed to the stack.
pub fn build_winner_ready_settlement_suffix() -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });

    // -------------------------------------------------------------
    // STEP 0: Stack Depth & Witness Canonical Width Checks
    // -------------------------------------------------------------
    sb.add_op(OpDepth).unwrap();
    sb.add_i64(37).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // purchase_index (depth 6): exactly 8 bytes
    sb.add_i64(6).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDrop).unwrap();

    // start_ticket (depth 7): exactly 8 bytes
    sb.add_i64(7).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDrop).unwrap();

    // count (depth 8): exactly 8 bytes
    sb.add_i64(8).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();
    sb.add_op(OpDrop).unwrap();

    // siblings[0..26] (depths 10..36): each exactly 32 bytes
    for i in 10..37 {
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
    // 1) Defense-in-depth: winner_index < total_tickets
    sb.add_op(Op0).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(Op4).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap();

    // 2) start_ticket <= winner_index:
    sb.add_op(Op7).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(Op1).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    // 3) winner_index < start_ticket + count:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(10).unwrap();
    sb.add_op(OpPick).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap();

    // -------------------------------------------------------------
    // STEP 2: Exact Principal Payment & Output 0 SPK Binding
    // -------------------------------------------------------------
    // Enforce claimant payout_spk is canonical (defense-in-depth):
    self::ticket_commitment::append_canonical_payout_spk_check(&mut sb, 9).unwrap();

    // 1) Exact payment: OpTxOutputAmount(0) == OpTxInputAmount(0)
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputAmount).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // 2) Output 0 SPK == claimant payout_spk:
    sb.add_i64(9).unwrap();
    sb.add_op(OpPick).unwrap(); // payout_spk
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // -------------------------------------------------------------
    // STEP 3: Merkle Tree Setup
    // -------------------------------------------------------------
    // 1) Compute payout_comm:
    sb.add_i64(9).unwrap();
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
    sb.add_op(OpBlake2bWithKey).unwrap(); // Stack: [37 items, payout_comm]

    // 2) Assemble purchase_leaf:
    sb.add_data(b"KaswinTicketRangeV1").unwrap();
    sb.add_i64(7).unwrap();
    sb.add_op(OpPick).unwrap(); // round_id (depth 7)
    sb.add_op(OpCat).unwrap();

    sb.add_i64(8).unwrap();
    sb.add_op(OpPick).unwrap(); // purchase_index (depth 8)
    sb.add_op(OpCat).unwrap();

    sb.add_i64(9).unwrap();
    sb.add_op(OpPick).unwrap(); // start_ticket (depth 9)
    sb.add_op(OpCat).unwrap();

    sb.add_i64(10).unwrap();
    sb.add_op(OpPick).unwrap(); // count (depth 10)
    sb.add_op(OpCat).unwrap();

    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(b"").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // Stack: [37 items, purchase_leaf]

    // Save purchase_leaf to AltStack:
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [purchase_leaf]

    // Read purchase_index as number and move to AltStack:
    sb.add_i64(6).unwrap();
    sb.add_op(OpPick).unwrap(); // purchase_index
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [purchase_leaf, purchase_index_num]

    // Save ticket_root to AltStack:
    sb.add_op(Op4).unwrap();
    sb.add_op(OpPick).unwrap(); // ticket_root
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [purchase_leaf, purchase_index_num, ticket_root]

    // Clean top 10 non-sibling items from dstack:
    for _ in 0..5 {
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

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

/// Builds complete production WINNER_READY redeem script.
pub fn build_production_winner_ready_covenant(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
    winner_index: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);
    assert!(winner_index < total_tickets);

    let mut sb = ScriptBuilder::new();
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&total_tickets.to_le_bytes()).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();

    let mut winner_sb = ScriptBuilder::new();
    winner_sb.add_data(&winner_index.to_le_bytes()).unwrap();
    let push_bytes = winner_sb.drain();
    sb.script_mut().extend_from_slice(&push_bytes);

    let suffix = build_winner_ready_settlement_suffix();
    sb.script_mut().extend_from_slice(&suffix);
    Ok(sb.drain())
}
