// Kaswin Canonical Winner Membership Verifier Script (Tree Depth = 27)
//
// Witness stack on entry:
// [0]     siblings[26] (root level sibling)
// ...
// [26]    siblings[0]  (leaf level sibling)
// [27]    payout_spk (raw script bytes)
// [28]    count (8 bytes LE data push)
// [29]    start_ticket (8 bytes LE data push)
// [30]    purchase_index (8 bytes LE data push)
// Total 31 witness items.
//
// Level 0 (leaf) up to level 26 (root):
// Siblings are popped from top of stack (siblings[0] first, then siblings[1], ..., siblings[26] last).

use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

pub const TREE_DEPTH: usize = 27;

/// Builds the standalone Winner Membership Verifier Redeem Script.
pub fn build_winner_membership_verifier_script(
    round_id: &Hash,
    ticket_root: &Hash,
    winner_index: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    let mut sb = ScriptBuilder::new();

    // Verify witness stack depth: 31 items
    sb.add_op(OpDepth)?;
    sb.add_i64(31)?;
    sb.add_op(OpNumEqualVerify)?;

    // -------------------------------------------------------------
    // STEP 0: Canonical Witness Width Checks
    // purchase_index (depth 0): exactly 8 bytes
    // start_ticket (depth 1): exactly 8 bytes
    // count (depth 2): exactly 8 bytes
    // siblings[0..26] (depths 4..30): each exactly 32 bytes
    // -------------------------------------------------------------
    // purchase_index:
    sb.add_op(Op0)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // start_ticket:
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // count:
    sb.add_op(Op2)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // siblings[0..26]:
    for i in 4..31 {
        sb.add_i64(i as i64)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpSize)?;
        sb.add_i64(32)?;
        sb.add_op(OpNumEqualVerify)?;
        sb.add_op(OpDrop)?;
    }

    // -------------------------------------------------------------
    // STEP 1: Range Interval Assertion:
    // start_ticket <= winner_index < start_ticket + count
    // -------------------------------------------------------------
    // Range check 1: start_ticket <= winner_index
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?; // start_ticket (8B LE)
    sb.add_op(OpBin2Num)?;
    sb.add_i64(winner_index as i64)?;
    sb.add_op(OpLessThanOrEqual)?;
    sb.add_op(OpVerify)?; // start_ticket <= winner_index verified!

    // Range check 2: winner_index < start_ticket + count
    sb.add_i64(winner_index as i64)?;
    sb.add_op(Op2)?;
    sb.add_op(OpPick)?; // start_ticket
    sb.add_op(OpBin2Num)?;
    sb.add_op(Op4)?;
    sb.add_op(OpPick)?; // count
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpAdd)?; // start_ticket + count
    sb.add_op(OpLessThan)?;
    sb.add_op(OpVerify)?; // winner_index < end_ticket verified!

    // -------------------------------------------------------------
    // STEP 2: Compute payout_commitment
    // payout_commitment = BLAKE2b256(b"KaswinPayoutSpkV1" || le_u32(len) || payout_spk)
    // -------------------------------------------------------------
    sb.add_i64(3)?;
    sb.add_op(OpPick)?; // [..., payout_spk]
    sb.add_op(OpSize)?;  // [..., payout_spk, len]
    sb.add_i64(4)?;
    sb.add_op(OpNum2Bin)?; // [..., payout_spk, len_4B_le]
    sb.add_data(b"KaswinPayoutSpkV1")?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?; // [..., payout_spk, prefix || len_4B_le]
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?; // [..., prefix || len_4B_le || payout_spk]
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // Stack: [siblings[26..0], payout_spk, count, start_ticket, purchase_index, payout_commitment (32B)]

    // -------------------------------------------------------------
    // STEP 3: Compute purchase_leaf
    // leaf = BLAKE2b256(b"KaswinTicketRangeV1" || round_id || purchase_index || start_ticket || count || payout_comm)
    // -------------------------------------------------------------
    sb.add_data(b"KaswinTicketRangeV1")?;
    sb.add_data(&round_id.as_bytes())?;
    sb.add_op(OpCat)?; // [..., payout_comm, range_prefix]

    sb.add_i64(2)?;
    sb.add_op(OpPick)?; // purchase_index (8B LE)
    sb.add_op(OpCat)?;

    sb.add_i64(3)?;
    sb.add_op(OpPick)?; // start_ticket (8B LE)
    sb.add_op(OpCat)?;

    sb.add_i64(4)?;
    sb.add_op(OpPick)?; // count (8B LE)
    sb.add_op(OpCat)?;

    sb.add_op(OpSwap)?; // [range_prefix_with_fields, payout_comm]
    sb.add_op(OpCat)?; // [full_leaf_preimage]
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // Stack: [siblings[26..0], payout_spk, count, start_ticket, purchase_index, leaf (32B)]

    // Move leaf to AltStack:
    sb.add_op(OpToAltStack)?; // AltStack: [current_hash = leaf]

    // Read purchase_index as number and preserve it on AltStack while dropping the 3 fields:
    sb.add_op(OpBin2Num)?; // Stack: [siblings[26..0], payout_spk, count, start_ticket, purchase_idx_num]
    sb.add_op(OpToAltStack)?; // AltStack: [leaf, purchase_idx_num]
    sb.add_op(Op2Drop)?; // drops start_ticket, count
    sb.add_op(OpDrop)?;  // drops payout_spk
    sb.add_op(OpFromAltStack)?; // Stack: [siblings[26..0], purchase_idx_num]
    // AltStack: [leaf]

    // -------------------------------------------------------------
    // STEP 4: Merkle Tree Bottom-Up Traversal (Level 0 up to Level 26)
    // -------------------------------------------------------------
    for i in 0..TREE_DEPTH {
        sb.add_op(OpDup)?;
        if i > 0 {
            sb.add_i64(1i64 << i)?;
            sb.add_op(OpDiv)?;
        }
        sb.add_i64(2)?;
        sb.add_op(OpMod)?; // Stack: [..., sibling_i, purchase_idx_num, bit_i]

        sb.add_op(OpFromAltStack)?; // current_hash (level i node)
        sb.add_i64(3)?;
        sb.add_op(OpRoll)?; // sibling_i to top! -> [..., purchase_idx_num, bit_i, current_hash, sibling_i]

        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // bit_i
        sb.add_op(OpIf)?;
            sb.add_op(OpSwap)?; // if bit == 1: sibling_i (left) || current_hash (right)
        sb.add_op(OpEndIf)?;

        sb.add_op(OpCat)?; // [left || right] (64 bytes)
        sb.add_data(b"KaswinTicketNodeV1")?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?; // [b"KaswinTicketNodeV1" || left || right]
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?; // new parent_hash at level i + 1 (32B)

        sb.add_op(OpToAltStack)?; // save to AltStack
    }

    // Drop purchase_idx_num:
    sb.add_op(OpDrop)?;

    // Retrieve final computed root from AltStack:
    sb.add_op(OpFromAltStack)?; // Stack: [computed_root]

    // -------------------------------------------------------------
    // STEP 5: Assert Computed Root == ticket_root
    // -------------------------------------------------------------
    sb.add_data(&ticket_root.as_bytes())?;
    sb.add_op(OpEqualVerify)?;

    sb.add_op(OpTrue)?;
    Ok(sb.drain())
}
