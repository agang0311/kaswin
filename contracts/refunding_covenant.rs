// Kaswin Production REFUNDING Covenant State Machine
//
// State Encoding in Redeem Script:
// Prefix:
//   OpTxInputIndex, Op0, OpEqualVerify (3B)
//   DataPush(round_id[32]) (33B)
//   DataPush(ticket_price[8]) (9B)
//   DataPush(total_tickets[8]) (9B)
//   DataPush(ticket_root[32]) (33B)
//   DataPush(reserve_payout_spk[36 or 37]) (1 + len B)
//   DataPush(purchase_count[8]) (9B)
//   DataPush(refund_cursor[8]) (9B)
//   DataPush(remaining_tickets[8]) (9B)
//
// Witness stack on entry:
//   [0..26] siblings[26..0] (27 items)
//   [27] payout_spk (36 or 37 bytes)
//   [28] count (8 bytes LE)
//   [29] start_ticket (8 bytes LE)
//   [30] purchase_index (8 bytes LE)
//
// Total stack depth on entry to body: 31 + 8 = 39 items.

use kaspa_hashes::{Hash, ZERO_HASH};
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

#[path = "lineage.rs"]
pub mod lineage;

#[path = "ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{is_canonical_payout_spk, append_canonical_payout_spk_check, TREE_DEPTH};

pub fn build_refunding_prefix(
    round_id: &Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: &Hash,
    reserve_payout_spk: &[u8],
    purchase_count: u64,
    refund_cursor: u64,
    remaining_tickets: u64,
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
    sb.add_data(reserve_payout_spk).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(&refund_cursor.to_le_bytes()).unwrap();
    sb.add_data(&remaining_tickets.to_le_bytes()).unwrap();
    sb.drain()
}

pub fn canonical_refunding_body_len(reserve_payout_spk_len: usize) -> usize {
    let mut guess = 3500usize;
    for _ in 0..16 {
        let body = build_refunding_body(guess, reserve_payout_spk_len).unwrap();
        if body.len() == guess {
            return guess;
        }
        guess = body.len();
    }
    panic!("Failed to converge refunding body length");
}

pub fn build_refunding_covenant(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: Hash,
    reserve_payout_spk: Vec<u8>,
    purchase_count: u64,
    refund_cursor: u64,
    remaining_tickets: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(is_canonical_payout_spk(&reserve_payout_spk));
    assert!(refund_cursor <= purchase_count);

    let body_len = canonical_refunding_body_len(reserve_payout_spk.len());
    let prefix = build_refunding_prefix(
        &round_id,
        ticket_price,
        total_tickets,
        &ticket_root,
        &reserve_payout_spk,
        purchase_count,
        refund_cursor,
        remaining_tickets,
    );
    let body = build_refunding_body(body_len, reserve_payout_spk.len())?;

    let mut full = Vec::new();
    full.extend_from_slice(&prefix);
    full.extend_from_slice(&body);
    Ok(full)
}

pub fn build_refunding_body(
    body_len: usize,
    reserve_payout_spk_len: usize,
) -> ScriptBuilderResult<Vec<u8>> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });

    // Stack depth check: 39 items
    sb.add_op(OpDepth)?;
    sb.add_i64(39)?;
    sb.add_op(OpNumEqualVerify)?;

    // -------------------------------------------------------------
    // STEP 0: Witness Canonical Width Checks
    // purchase_index (depth 8): 8B
    // start_ticket (depth 9): 8B
    // count (depth 10): 8B
    // siblings (depths 12..38): 32B each (27 items)
    // payout_spk (depth 11): canonical SPK check
    // -------------------------------------------------------------
    sb.add_i64(8)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    sb.add_i64(9)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    sb.add_i64(10)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    for i in 12..39 {
        sb.add_i64(i as i64)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpSize)?;
        sb.add_i64(32)?;
        sb.add_op(OpNumEqualVerify)?;
        sb.add_op(OpDrop)?;
    }

    append_canonical_payout_spk_check(&mut sb, 11)?;

    // -------------------------------------------------------------
    // STEP 1: Cursor & Ticket Bounds Checks
    // Depth 0: remaining_tickets (8B)
    // Depth 1: refund_cursor (8B)
    // Depth 2: purchase_count (8B)
    // Depth 3: reserve_payout_spk
    // Depth 4: ticket_root (32B)
    // Depth 5: total_tickets (8B)
    // Depth 6: ticket_price (8B)
    // Depth 7: round_id (32B)
    // Depth 8: purchase_index (8B)
    // Depth 9: start_ticket (8B)
    // Depth 10: count (8B)
    // Depth 11: payout_spk
    // Depth 12..38: siblings[0..26]
    // -------------------------------------------------------------
    // 1) purchase_index == refund_cursor:
    sb.add_i64(8)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(Op2)?;
    sb.add_op(OpPick)?; // refund_cursor
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpEqualVerify)?;

    // 2) count >= 1:
    sb.add_i64(10)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpDup)?;
    sb.add_i64(1)?;
    sb.add_op(OpGreaterThanOrEqual)?;
    sb.add_op(OpVerify)?;

    // 3) count <= remaining_tickets:
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?; // remaining_tickets
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpLessThanOrEqual)?;
    sb.add_op(OpVerify)?;

    // -------------------------------------------------------------
    // STEP 2: Buyer Output 1 Verification (Immediate Payout)
    // Output 1 SPK == payout_spk
    // Output 1 Amount == ticket_price * count
    // Output 1 covenant == None
    // -------------------------------------------------------------
    // Output 1 SPK:
    sb.add_i64(11)?;
    sb.add_op(OpPick)?; // payout_spk
    sb.add_op(Op1)?;
    sb.add_op(OpTxOutputSpk)?;
    sb.add_op(OpEqualVerify)?;

    // Output 1 Amount == ticket_price * count:
    sb.add_i64(6)?;
    sb.add_op(OpPick)?; // ticket_price
    sb.add_op(OpBin2Num)?;
    sb.add_i64(11)?;
    sb.add_op(OpPick)?; // count
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpMul)?; // delta_refund
    sb.add_op(OpDup)?;
    sb.add_op(Op1)?;
    sb.add_op(OpTxOutputAmount)?;
    sb.add_op(OpEqualVerify)?; // Output 1 Amount verified!
    // delta_refund is at Depth 0!
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund]

    // Output 1 has covenant == None:
    sb.add_op(Op1)?;
    sb.add_op(OpOutputCovenantId)?;
    sb.add_data(&ZERO_HASH.as_bytes())?;
    sb.add_op(OpEqualVerify)?;
    sb.add_op(Op1)?;
    sb.add_op(OpOutputAuthorizingInput)?;
    sb.add_i64(-1)?;
    sb.add_op(OpNumEqualVerify)?;

    // -------------------------------------------------------------
    // STEP 3: Setup AltStack & Compute Merkle purchase_leaf
    // -------------------------------------------------------------
    // Save numbers needed for Step 4 to AltStack:
    // count_num:
    sb.add_i64(10)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund, count_num]

    // refund_cursor_num:
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund, count_num, refund_cursor_num]

    // purchase_count_num:
    sb.add_op(Op2)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund, count_num, refund_cursor_num, purchase_count_num]

    // remaining_tickets_num:
    sb.add_op(Op0)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund, count_num, refund_cursor_num, purchase_count_num, remaining_tickets_num]

    // reserve_payout_spk:
    sb.add_op(Op3)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund, count_num, refund_cursor_num, purchase_count_num, remaining_tickets_num, reserve_payout_spk]

    // Compute payout_comm:
    sb.add_i64(11)?;
    sb.add_op(OpPick)?; // payout_spk
    sb.add_op(OpSize)?;
    sb.add_i64(4)?;
    sb.add_op(OpNum2Bin)?;
    sb.add_data(b"KaswinPayoutSpkV1")?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // payout_comm
    sb.add_op(OpToAltStack)?;     // Save payout_comm to AltStack, dstack is back to 39 items!

    // Assemble purchase_leaf:
    // Original 39 items: round_id is at Depth 7, purchase_index at Depth 8,
    // start_ticket at Depth 9, count at Depth 10.
    sb.add_data(b"KaswinTicketRangeV1")?; // Depth 0 (all original items shifted by +1)
    sb.add_i64(8)?;
    sb.add_op(OpPick)?; // round_id (depth 7 + 1)
    sb.add_op(OpCat)?;

    sb.add_i64(9)?;
    sb.add_op(OpPick)?; // purchase_index (depth 8 + 1)
    sb.add_op(OpCat)?;

    sb.add_i64(10)?;
    sb.add_op(OpPick)?; // start_ticket (depth 9 + 1)
    sb.add_op(OpCat)?;

    sb.add_i64(11)?;
    sb.add_op(OpPick)?; // count (depth 10 + 1)
    sb.add_op(OpCat)?;

    sb.add_op(OpFromAltStack)?; // pops payout_comm from AltStack!
    sb.add_op(OpCat)?;
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // purchase_leaf

    // Save purchase_leaf:
    sb.add_op(OpToAltStack)?; // AltStack: [..., reserve_spk, purchase_leaf]

    // Read purchase_index as number (original depth 8):
    sb.add_i64(8)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpToAltStack)?; // AltStack: [..., purchase_leaf, purchase_index_num]

    // Save ticket_root (original depth 4):
    sb.add_op(Op4)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpToAltStack)?; // AltStack: [..., purchase_leaf, purchase_index_num, ticket_root]

    // Clean top 12 non-sibling items from dstack:
    for _ in 0..6 {
        sb.add_op(Op2Drop)?;
    }
    // Stack has ONLY: [siblings[26..0]]!

    // Reshuffle AltStack:
    sb.add_op(OpFromAltStack)?; // ticket_root
    sb.add_op(OpFromAltStack)?; // purchase_index_num
    sb.add_op(OpFromAltStack)?; // purchase_leaf
    sb.add_i64(2)?;
    sb.add_op(OpRoll)?;         // ticket_root
    sb.add_op(OpToAltStack)?;   // push ticket_root
    sb.add_op(OpToAltStack)?;   // push purchase_leaf

    // Stack is now: [siblings[26..0], purchase_index_num]!
    // AltStack top is purchase_leaf, second is ticket_root!

    // -------------------------------------------------------------
    // STEP 4: Merkle Tree SMT Traversal (27 Levels)
    // -------------------------------------------------------------
    for i in 0..TREE_DEPTH {
        sb.add_op(OpDup)?;
        if i > 0 {
            sb.add_i64(1i64 << i)?;
            sb.add_op(OpDiv)?;
        }
        sb.add_i64(2)?;
        sb.add_op(OpMod)?;

        sb.add_op(OpFromAltStack)?; // current_hash
        sb.add_i64(3)?;
        sb.add_op(OpRoll)?; // sibling_i

        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // bit_i
        sb.add_op(OpIf)?;
            sb.add_op(OpSwap)?;
        sb.add_op(OpEndIf)?;

        sb.add_op(OpCat)?;
        sb.add_data(b"KaswinTicketNodeV1")?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?;

        sb.add_op(OpToAltStack)?;
    }

    // Drop purchase_index_num:
    sb.add_op(OpDrop)?;

    // Pop computed_root and ticket_root from AltStack:
    sb.add_op(OpFromAltStack)?; // computed_root
    sb.add_op(OpFromAltStack)?; // ticket_root
    sb.add_op(OpEqualVerify)?;  // Proven: Buyer leaf is authentic!

    // -------------------------------------------------------------
    // STEP 5: Successor Dispatch: Normal Refund Step vs Final Step
    // AltStack currently contains from bottom to top:
    // [delta_refund, count_num, refund_cursor_num, purchase_count_num, remaining_tickets_num, reserve_payout_spk]
    // -------------------------------------------------------------
    sb.add_op(OpFromAltStack)?; // reserve_payout_spk (raw bytes)
    sb.add_op(OpFromAltStack)?; // remaining_tickets_num
    sb.add_op(OpFromAltStack)?; // purchase_count_num
    sb.add_op(OpFromAltStack)?; // refund_cursor_num
    sb.add_op(OpFromAltStack)?; // count_num
    sb.add_op(OpFromAltStack)?; // delta_refund

    // Stack: [reserve_payout_spk, rem_num, pc_num, cursor_num, count_num, delta_refund]
    // Output 0 Amount must be Input 0 Amount - delta_refund:
    sb.add_op(Op0)?;
    sb.add_op(OpTxInputAmount)?;
    sb.add_op(OpSwap)?; // [..., Input0, delta_refund]
    sb.add_op(OpSub)?;  // expected_output_0_amount
    sb.add_op(Op0)?;
    sb.add_op(OpTxOutputAmount)?;
    sb.add_op(OpEqualVerify)?; // Output 0 Amount verified!

    // Stack: [reserve_payout_spk, rem_num, pc_num, cursor_num, count_num]
    // Check if cursor + 1 < purchase_count:
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?; // cursor_num
    sb.add_op(Op1)?;
    sb.add_op(OpAdd)?;  // next_cursor_num
    sb.add_op(Op3)?;
    sb.add_op(OpPick)?; // pc_num
    sb.add_op(OpLessThan)?;

    sb.add_op(OpIf)?;
        // --- NORMAL REFUND STEP ---
        // Stack: [reserve_payout_spk, rem_num, pc_num, cursor_num, count_num]
        // next_rem_num = rem_num - count_num:
        sb.add_op(Op3)?;
        sb.add_op(OpPick)?; // rem_num
        sb.add_op(Op1)?;
        sb.add_op(OpPick)?; // count_num
        sb.add_op(OpSub)?;  // next_rem_num

        // next_cursor_num = cursor_num + 1:
        sb.add_op(Op2)?;
        sb.add_op(OpPick)?; // cursor_num
        sb.add_op(Op1)?;
        sb.add_op(OpAdd)?;  // next_cursor_num

        // We construct next REFUNDING prefix:
        // slice immutable prefix part from current script:
        // current prefix: [OpTxInputIndex, Op0, OpEqualVerify, round_id[32], ticket_price[8], total_tickets[8], ticket_root[32], reserve_payout_spk, purchase_count[8]]
        // Let's introspect current prefix:
        // total prefix length = 3 + 33 + 9 + 9 + 33 + (1 + reserve_payout_spk_len) + 9 + 9 + 9 = 106 + reserve_payout_spk_len + 9 + 9 = 124 + reserve_payout_spk_len.
        // The immutable prefix length (up to purchase_count included) = 3 + 33 + 9 + 9 + 33 + (1 + reserve_payout_spk_len) + 9 = 97 + reserve_payout_spk_len.
        let immut_prefix_len = 97 + reserve_payout_spk_len;
        let prefix_len = immut_prefix_len + 18; // plus cursor[9] and rem[9]
        let total_redeem_len = prefix_len + body_len;

        sb.add_op(Op0)?;
        sb.add_op(OpTxInputScriptSigLen)?; // [..., next_rem_num, next_cursor_num, sig_len]
        sb.add_op(OpDup)?;
        sb.add_i64(total_redeem_len as i64)?;
        sb.add_op(OpSub)?; // p_start = sig_len - total_redeem_len

        sb.add_op(OpDup)?;
        sb.add_i64(immut_prefix_len as i64)?;
        sb.add_op(OpAdd)?; // p_end = p_start + immut_prefix_len

        sb.add_op(Op0)?;
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // p_start
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // p_end
        sb.add_op(OpTxInputScriptSigSubstr)?; // Stack: [..., next_rem_num, next_cursor_num, sig_len, immut_prefix]

        // Push next_cursor (9B):
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // next_cursor_num
        sb.add_i64(8)?;
        sb.add_op(OpNum2Bin)?;
        sb.add_data(&[0x08])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_op(OpCat)?; // [..., next_rem_num, sig_len, immut_prefix || push_next_cursor]

        // Push next_rem (9B):
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // next_rem_num
        sb.add_i64(8)?;
        sb.add_op(OpNum2Bin)?;
        sb.add_data(&[0x08])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_op(OpCat)?; // [..., sig_len, complete_next_prefix]

        // Slice body from current input script:
        sb.add_op(OpSwap)?; // [complete_next_prefix, sig_len]
        sb.add_op(OpDup)?;
        sb.add_i64(body_len as i64)?;
        sb.add_op(OpSub)?; // body_start = sig_len - body_len

        sb.add_op(Op0)?;
        sb.add_i64(1)?;
        sb.add_op(OpRoll)?; // body_start
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // sig_len
        sb.add_op(OpTxInputScriptSigSubstr)?; // [complete_next_prefix, body_bytes]
        sb.add_op(OpCat)?; // [next_refunding_redeem_script]

        // Compute expected P2SH SPK:
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?;
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(&[0x87])?;
        sb.add_op(OpCat)?; // [expected_spk]

        // Assert Output 0 SPK matches:
        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputSpk)?;
        sb.add_op(OpEqualVerify)?;

        // Enforce Singleton Continuation Guard:
        lineage::append_kaswin_singleton_continuation_guard(&mut sb)?;

        // Drop the 5 saved stack items:
        for _ in 0..2 { sb.add_op(Op2Drop)?; }
        sb.add_op(OpDrop)?;

    sb.add_op(OpElse)?;
        // --- FINAL REFUND STEP ---
        // Stack: [reserve_payout_spk, rem_num, pc_num, cursor_num, count_num]
        // 1) Must satisfy: count_num == rem_num!
        sb.add_op(Op0)?;
        sb.add_op(OpPick)?; // count_num
        sb.add_op(Op4)?;
        sb.add_op(OpPick)?; // rem_num
        sb.add_op(OpEqualVerify)?; // Verified: all tickets refunded!

        // 2) Output 0 SPK == reserve_payout_spk:
        // reserve_payout_spk is at depth 4!
        sb.add_op(Op4)?;
        sb.add_op(OpPick)?;
        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputSpk)?;
        sb.add_op(OpEqualVerify)?; // Verified: remaining reserve returned to reserve_payout_spk!

        // 3) Terminate lineage:
        lineage::append_kaswin_terminal_lineage_guard(&mut sb)?;

        // Drop remaining 5 stack items:
        for _ in 0..2 { sb.add_op(Op2Drop)?; }
        sb.add_op(OpDrop)?;

    sb.add_op(OpEndIf)?;

    sb.add_op(OpTrue)?;
    Ok(sb.drain())
}
