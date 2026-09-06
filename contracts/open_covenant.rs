// Kaswin Canonical OPEN Covenant State Machine
//
// State Encoding in Redeem Script:
// Prefix (Fixed 105 bytes):
//   OpTxInputIndex, Op0, OpEqualVerify
//   DataPush(round_id[32])
//   DataPush(le_u64(ticket_price)[8])
//   DataPush(le_u64(total_tickets)[8])
//   DataPush(le_u64(sold_tickets)[8])
//   DataPush(le_u64(purchase_count)[8])
//   DataPush(ticket_root[32])
//
// Witness stack on entry:
//   [0]      siblings[26]
//   ...
//   [26]     siblings[0]
//   [27]     payout_spk
//   [28]     count (8 bytes LE)
//
// Total stack depth on entry to body: 35 items.

use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

pub const TREE_DEPTH: usize = 27;
pub const MAX_TOTAL_TICKETS: u64 = 100_000_000;
pub const OPEN_PREFIX_LEN: usize = 105;

pub fn build_open_prefix(
    round_id: &Hash,
    ticket_price: u64,
    total_tickets: u64,
    sold_tickets: u64,
    purchase_count: u64,
    ticket_root: &Hash,
) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&total_tickets.to_le_bytes()).unwrap();
    sb.add_data(&sold_tickets.to_le_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    let res = sb.drain();
    assert_eq!(res.len(), OPEN_PREFIX_LEN);
    res
}

pub fn canonical_open_body_len(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    delta_daa: u64,
) -> usize {
    let mut guess = 1500usize;
    for _ in 0..16 {
        let body = build_open_covenant_body(round_id, ticket_price, total_tickets, delta_daa, guess).unwrap();
        if body.len() == guess {
            return guess;
        }
        guess = body.len();
    }
    panic!("Failed to converge open body length");
}

pub fn build_open_covenant(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    sold_tickets: u64,
    purchase_count: u64,
    ticket_root: Hash,
    delta_daa: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);
    assert!(sold_tickets <= total_tickets);

    let body_len = canonical_open_body_len(round_id, ticket_price, total_tickets, delta_daa);
    let prefix = build_open_prefix(&round_id, ticket_price, total_tickets, sold_tickets, purchase_count, &ticket_root);
    let body = build_open_covenant_body(round_id, ticket_price, total_tickets, delta_daa, body_len)?;

    let mut full = Vec::new();
    full.extend_from_slice(&prefix);
    full.extend_from_slice(&body);
    Ok(full)
}

fn build_open_covenant_body(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    delta_daa: u64,
    body_len: usize,
) -> ScriptBuilderResult<Vec<u8>> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });

    // Witness Stack on entry (bottom to top):
    // [0..26] siblings[26..0] (27 items)
    // [27] payout_spk (1 item)
    // [28] count (8B LE data push) (1 item)
    // Plus 6 state items pushed by prefix:
    // [29] round_id (depth 5)
    // [30] ticket_price (depth 4)
    // [31] total_tickets (depth 3)
    // [32] sold_tickets (depth 2)
    // [33] purchase_count (depth 1)
    // [34] ticket_root (depth 0)
    // Total stack depth = 35 items!
    sb.add_op(OpDepth)?;
    sb.add_i64(35)?;
    sb.add_op(OpNumEqualVerify)?;

    // -------------------------------------------------------------
    // STEP 1: Count Validation and Interval Calculation
    // -------------------------------------------------------------
    sb.add_i64(6)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?; // [..., count_num]

    sb.add_op(OpDup)?;
    sb.add_i64(1)?;
    sb.add_op(OpGreaterThanOrEqual)?;
    sb.add_op(OpVerify)?; // count >= 1 verified!

    // sold_after = sold_tickets + count
    // count_num is at depth 0, sold_tickets is at depth 2 + 1 = 3!
    sb.add_op(Op3)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpAdd)?; // Stack top is now: [..., sold_after]

    // Verify sold_after <= total_tickets:
    sb.add_op(OpDup)?;
    sb.add_i64(5)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpLessThanOrEqual)?;
    sb.add_op(OpVerify)?; // sold_after <= total_tickets verified!

    // Put sold_after on AltStack:
    sb.add_op(OpToAltStack)?; // AltStack: [sold_after]
    // Stack is back to initial 35 items!

    // -------------------------------------------------------------
    // STEP 2: Atomic Payment Verification
    // Output 0 Value >= Input 0 Value + ticket_price * count
    // (i.e. expected_min <= actual_output)
    // -------------------------------------------------------------
    sb.add_i64(6)?;
    sb.add_op(OpPick)?; // count
    sb.add_op(OpBin2Num)?;
    sb.add_i64(5)?;
    sb.add_op(OpPick)?; // ticket_price (depth 4 + 1 = depth 5)
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpMul)?; // delta_payment = ticket_price * count

    sb.add_op(Op0)?;
    sb.add_op(OpTxInputAmount)?;
    sb.add_op(OpAdd)?; // expected_min_output_amount (depth 1)

    sb.add_op(Op0)?;
    sb.add_op(OpTxOutputAmount)?; // actual_output_amount (depth 0)
    sb.add_op(OpLessThanOrEqual)?; // expected_min <= actual_output verified!
    sb.add_op(OpVerify)?;
    // Stack is back to initial 35 items!

    // -------------------------------------------------------------
    // STEP 3: Compute purchase_leaf and save state to AltStack
    // -------------------------------------------------------------
    // 1) Compute next_purchase_count_num and save to AltStack:
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?; // purchase_count (depth 1)
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpDup)?;  // [..., purchase_count_num, purchase_count_num]
    sb.add_op(Op1)?;
    sb.add_op(OpAdd)?;  // [..., purchase_count_num, next_purchase_count_num]
    sb.add_op(OpToAltStack)?; // AltStack: [sold_after, next_purchase_count_num]
    sb.add_op(OpToAltStack)?; // AltStack: [sold_after, next_purchase_count_num, current_purchase_count_num]
    // Stack is back to initial 35 items!

    // 2) Compute payout_comm:
    sb.add_i64(7)?;
    sb.add_op(OpPick)?; // payout_spk (depth 7)
    sb.add_op(OpSize)?;
    sb.add_i64(4)?;
    sb.add_op(OpNum2Bin)?; // len_4b
    sb.add_data(b"KaswinPayoutSpkV1")?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // Stack: [initial 35 items, payout_comm (32B)]

    // 3) Assemble purchase_leaf:
    sb.add_data(b"KaswinTicketRangeV1")?;
    sb.add_i64(7)?;
    sb.add_op(OpPick)?; // round_id (depth 6 + 1 = 7)
    sb.add_op(OpCat)?;

    sb.add_i64(3)?;
    sb.add_op(OpPick)?; // purchase_count (depth 2 + 1 = 3)
    sb.add_op(OpCat)?;

    sb.add_i64(4)?;
    sb.add_op(OpPick)?; // sold_tickets (depth 3 + 1 = 4)
    sb.add_op(OpCat)?;

    sb.add_i64(8)?;
    sb.add_op(OpPick)?; // count (depth 7 + 1 = 8)
    sb.add_op(OpCat)?;

    sb.add_op(OpSwap)?; // [range_preimage, payout_comm]
    sb.add_op(OpCat)?;
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // Stack: [initial 35 items, purchase_leaf (32B)]

    // Move purchase_leaf to AltStack right under current_purchase_count_num:
    sb.add_op(OpFromAltStack)?; // [initial 35 items, purchase_leaf, current_purchase_count_num]
    sb.add_op(OpSwap)?;         // [initial 35 items, current_purchase_count_num, purchase_leaf]
    sb.add_op(OpToAltStack)?;   // AltStack: [sold_after, next_purchase_count_num, purchase_leaf]
    sb.add_op(OpToAltStack)?;   // AltStack: [sold_after, next_purchase_count_num, purchase_leaf, current_purchase_count_num]

    // Clean top 8 non-sibling items:
    for _ in 0..4 {
        sb.add_op(Op2Drop)?;
    }
    // Stack now contains ONLY: [siblings[26..0]] (27 items, siblings[0] at top)!

    // Bring current_purchase_count_num to dstack:
    sb.add_op(OpFromAltStack)?;
    // Stack: [siblings[26..0], current_purchase_count_num]
    // AltStack: [sold_after, next_purchase_count_num, purchase_leaf]
    // Top of AltStack is purchase_leaf!

    // -------------------------------------------------------------
    // STEP 4: Merkle Tree New-Root Computation (Level 0 up to Level 26)
    // -------------------------------------------------------------
    for i in 0..TREE_DEPTH {
        sb.add_op(OpDup)?;
        if i > 0 {
            sb.add_i64(1i64 << i)?;
            sb.add_op(OpDiv)?;
        }
        sb.add_i64(2)?;
        sb.add_op(OpMod)?; // [..., sibling_i, current_purchase_count_num, bit_i]

        sb.add_op(OpFromAltStack)?; // current_hash
        sb.add_i64(3)?;
        sb.add_op(OpRoll)?; // sibling_i to top!

        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // bit_i
        sb.add_op(OpIf)?;
            sb.add_op(OpSwap)?;
        sb.add_op(OpEndIf)?;

        sb.add_op(OpCat)?; // [left || right]
        sb.add_data(b"KaswinTicketNodeV1")?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?; // [b"KaswinTicketNodeV1" || left || right]
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?; // parent_hash

        sb.add_op(OpToAltStack)?; // save to AltStack
    }

    // Drop current_purchase_count_num:
    sb.add_op(OpDrop)?;

    // Retrieve new_root, next_purchase_count_num, and sold_after:
    sb.add_op(OpFromAltStack)?; // new_root (32B)
    sb.add_op(OpFromAltStack)?; // next_purchase_count_num (num)
    sb.add_op(OpFromAltStack)?; // sold_after (num)

    // Stack: [new_root, next_purchase_count_num, sold_after]

    // -------------------------------------------------------------
    // STEP 5: Successor Transition Branching
    // If sold_after < total_tickets -> Transition to OPEN successor
    // If sold_after == total_tickets -> Atomic Transition to SEALED
    // -------------------------------------------------------------
    sb.add_op(OpDup)?;
    sb.add_i64(total_tickets as i64)?;
    sb.add_op(OpLessThan)?;

    sb.add_op(OpIf)?;
        // --- TRANSITION TO OPEN ---
        let mut open_head_sb = ScriptBuilder::new();
        open_head_sb.add_op(OpTxInputIndex)?;
        open_head_sb.add_op(Op0)?;
        open_head_sb.add_op(OpEqualVerify)?;
        open_head_sb.add_data(&round_id.as_bytes())?;
        open_head_sb.add_data(&ticket_price.to_le_bytes())?;
        open_head_sb.add_data(&total_tickets.to_le_bytes())?;
        let open_head_bytes = open_head_sb.drain();

        sb.add_i64(8)?;
        sb.add_op(OpNum2Bin)?; // sold_after_bytes (8B LE)
        sb.add_data(&[0x08])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;     // push_sold_after (9B)

        sb.add_data(&open_head_bytes)?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;     // [open_head || push_sold_after]

        // Next push_purchase_count:
        sb.add_i64(1)?;
        sb.add_op(OpRoll)?;    // next_purchase_count_num
        sb.add_i64(8)?;
        sb.add_op(OpNum2Bin)?; // 8B LE
        sb.add_data(&[0x08])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;     // push_next_purchase_count (9B)
        sb.add_op(OpCat)?;     // [open_head || push_sold_after || push_purchase_count]

        // Next push_ticket_root:
        sb.add_data(&[0x20])?;
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?;    // new_root (32B)
        sb.add_op(OpCat)?;     // [0x20 || new_root]
        sb.add_op(OpCat)?;     // [exact_105_byte_open_prefix]

        // Self-Replicating Body Introspection:
        sb.add_op(Op0)?;
        sb.add_op(OpTxInputScriptSigLen)?; // Stack: [prefix, sig_len]
        sb.add_op(OpDup)?;
        sb.add_i64(body_len as i64)?;
        sb.add_op(OpSub)?; // body_start = sig_len - body_len

        sb.add_op(Op0)?;
        sb.add_i64(1)?;
        sb.add_op(OpRoll)?; // body_start
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // sig_len
        sb.add_op(OpTxInputScriptSigSubstr)?; // Stack: [prefix, body_bytes]

        sb.add_op(OpCat)?; // Stack: [exact_successor_open_redeem_script]

        // Compute expected P2SH SPK:
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?;
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(&[0x87])?;
        sb.add_op(OpCat)?; // Stack: [expected_open_spk]

    sb.add_op(OpElse)?;
        // --- ATOMIC TRANSITION TO SEALED ---
        sb.add_op(OpDrop)?; // drop sold_after
        sb.add_op(OpDrop)?; // drop next_purchase_count_num
        // Stack: [new_root]

        // 1) Compute application_commitment on-the-fly:
        // app_commitment = BLAKE2b256(b"KaswinAppV1" || round_id || new_root || le_u64(total_tickets))
        sb.add_op(OpDup)?; // [new_root, new_root]
        sb.add_data(b"KaswinAppV1")?;
        sb.add_data(&round_id.as_bytes())?;
        sb.add_op(OpCat)?; // [new_root, new_root, prefix || round_id]
        sb.add_op(OpSwap)?; // [new_root, prefix || round_id, new_root]
        sb.add_op(OpCat)?;  // [new_root, prefix || round_id || new_root]
        sb.add_data(&total_tickets.to_le_bytes())?;
        sb.add_op(OpCat)?;  // [new_root, app_preimage]
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?; // Stack: [new_root, app_commitment (32B)]

        // 2) Split SEALED template into 3 parts:
        let (part1, part2, part3) = split_sealed_covenant_into_3_parts(round_id, total_tickets, delta_daa);

        // Part 1 || app_commitment:
        sb.add_data(&part1)?;
        sb.add_op(OpSwap)?; // [new_root, part1, app_commitment]
        sb.add_op(OpCat)?;  // [new_root, part1 || app_commitment]

        // (Part 1 || app_commitment) || Part 2:
        sb.add_data(&part2)?;
        sb.add_op(OpCat)?;  // [new_root, part1 || app_comm || part2]

        // (Part 1 || app_commitment || Part 2) || new_root:
        sb.add_op(OpSwap)?; // [part1 || app_comm || part2, new_root]
        sb.add_op(OpCat)?;  // [part1 || app_comm || part2 || new_root]

        // ((Part 1 || app_commitment || Part 2) || new_root) || Part 3:
        sb.add_data(&part3)?;
        sb.add_op(OpCat)?;  // Stack: [exact_prod_sealed_redeem_script]!

        // Compute expected P2SH SPK:
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?;
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(&[0x87])?;
        sb.add_op(OpCat)?; // Stack: [expected_sealed_spk]

    sb.add_op(OpEndIf)?;

    // Assert Output 0 SPK matches:
    sb.add_op(Op0)?;
    sb.add_op(OpTxOutputSpk)?;
    sb.add_op(OpEqualVerify)?;

    sb.add_op(OpTrue)?;
    Ok(sb.drain())
}

pub fn split_sealed_covenant_into_3_parts(
    round_id: Hash,
    total_tickets: u64,
    delta_daa: u64,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let dummy_root = Hash::from_u64_word(0xdeadbeef);
    let dummy_app = crate::sealed_to_draw_ready::compute_application_commitment(
        &round_id,
        &dummy_root,
        total_tickets,
    );
    let full = crate::sealed_to_draw_ready::build_sealed_to_draw_ready_covenant(
        round_id,
        dummy_root,
        total_tickets,
        delta_daa,
    ).unwrap();

    let push_app = [0x20].iter().chain(dummy_app.as_bytes().iter()).copied().collect::<Vec<u8>>();
    let pos_app = full.windows(push_app.len()).position(|w| w == push_app.as_slice()).expect("push app found");

    let push_root = [0x20].iter().chain(dummy_root.as_bytes().iter()).copied().collect::<Vec<u8>>();
    let pos_root = full.windows(push_root.len()).position(|w| w == push_root.as_slice()).expect("push root found");

    let part1 = full[0..pos_app + 1].to_vec();
    let part2 = full[pos_app + push_app.len()..pos_root + 1].to_vec();
    let part3 = full[pos_root + push_root.len()..].to_vec();
    (part1, part2, part3)
}
