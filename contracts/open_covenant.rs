// Updated OPEN Covenant with Refund Lifecycle & Action Dispatch
//
// Actions:
// ACTION_BUY           = 1
// ACTION_BEGIN_REFUND  = 2
// ACTION_RECOVER_EMPTY = 3

use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

#[path = "lineage.rs"]
pub mod lineage;

#[path = "ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{is_canonical_payout_spk, append_canonical_payout_spk_check, TREE_DEPTH};

#[path = "v1_constants.rs"]
pub mod v1_constants;

#[path = "sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::build_sealed_body_v1;

#[path = "refunding_covenant.rs"]
pub mod refunding_covenant;

pub const MAX_TOTAL_TICKETS: u64 = 100_000_000;
pub const LOCK_TIME_THRESHOLD: u64 = 500_000_000_000;

pub const ACTION_BUY: i64 = 1;
pub const ACTION_BEGIN_REFUND: i64 = 2;
pub const ACTION_RECOVER_EMPTY: i64 = 3;

pub fn build_open_prefix(
    round_id: &Hash,
    ticket_price: u64,
    total_tickets: u64,
    refund_lock_daa: u64,
    reserve_payout_spk: &[u8],
    sold_tickets: u64,
    purchase_count: u64,
    ticket_root: &Hash,
) -> Vec<u8> {
    assert!(is_canonical_payout_spk(reserve_payout_spk));
    assert!(refund_lock_daa > 0 && refund_lock_daa < LOCK_TIME_THRESHOLD);
    let mut sb = ScriptBuilder::new();
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&total_tickets.to_le_bytes()).unwrap();
    sb.add_data(&refund_lock_daa.to_le_bytes()).unwrap();
    sb.add_data(reserve_payout_spk).unwrap();
    sb.add_data(&sold_tickets.to_le_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.drain()
}

pub fn canonical_open_body_len(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    _delta_daa: u64,
    reserve_payout_spk_len: usize,
) -> usize {
    let mut guess = 4500usize;
    for _ in 0..16 {
        let body = build_open_covenant_body(round_id, ticket_price, total_tickets, _delta_daa, guess, reserve_payout_spk_len).unwrap();
        if body.len() == guess {
            return guess;
        }
        guess = body.len();
    }
    panic!("Failed to converge open body length");
}

pub fn build_initial_open_covenant(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    delta_daa: u64,
    refund_lock_daa: u64,
    reserve_payout_spk: Vec<u8>,
) -> ScriptBuilderResult<Vec<u8>> {
    let empty_root = ticket_commitment::compute_empty_root_27();
    build_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        0,
        0,
        empty_root,
        delta_daa,
        refund_lock_daa,
        reserve_payout_spk,
    )
}

pub fn build_open_covenant(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    sold_tickets: u64,
    purchase_count: u64,
    ticket_root: Hash,
    delta_daa: u64,
    refund_lock_daa: u64,
    reserve_payout_spk: Vec<u8>,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);
    assert!(sold_tickets <= total_tickets);
    assert!(is_canonical_payout_spk(&reserve_payout_spk));
    assert!(refund_lock_daa > 0 && refund_lock_daa < LOCK_TIME_THRESHOLD);

    let body_len = canonical_open_body_len(round_id, ticket_price, total_tickets, delta_daa, reserve_payout_spk.len());
    let prefix = build_open_prefix(
        &round_id,
        ticket_price,
        total_tickets,
        refund_lock_daa,
        &reserve_payout_spk,
        sold_tickets,
        purchase_count,
        &ticket_root,
    );
    let body = build_open_covenant_body(round_id, ticket_price, total_tickets, delta_daa, body_len, reserve_payout_spk.len())?;

    let mut full = Vec::new();
    full.extend_from_slice(&prefix);
    full.extend_from_slice(&body);
    Ok(full)
}

pub fn build_open_covenant_body(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    _delta_daa: u64,
    body_len: usize,
    reserve_payout_spk_len: usize,
) -> ScriptBuilderResult<Vec<u8>> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });

    // On entry to OPEN body:
    // Prefix has pushed 8 items:
    // Depth 0: ticket_root (32B)
    // Depth 1: purchase_count (8B)
    // Depth 2: sold_tickets (8B)
    // Depth 3: reserve_payout_spk (raw bytes)
    // Depth 4: refund_lock_daa (8B)
    // Depth 5: total_tickets (8B)
    // Depth 6: ticket_price (8B)
    // Depth 7: round_id (32B)
    //
    // Depth 8: action (1 = BUY, 2 = BEGIN_REFUND, 3 = RECOVER_EMPTY)

    // Branch on action:
    sb.add_i64(8)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?; // Stack: [..., action_num]

    sb.add_op(OpDup)?;
    sb.add_i64(ACTION_BUY)?;
    sb.add_op(OpEqual)?;
    sb.add_op(OpIf)?;
        // =========================================================
        // ACTION 1: BUY
        // =========================================================
        sb.add_op(OpDrop)?; // drop action_num
        // Stack on entry to BUY logic:
        // [siblings (27), payout_spk (1), count (1), action (1), prefix items (8)]
        // Total depth must be 38 items!
        sb.add_op(OpDepth)?;
        sb.add_i64(38)?;
        sb.add_op(OpNumEqualVerify)?;

        // Depths of BUY items:
        // Depth 0: ticket_root
        // Depth 1: purchase_count
        // Depth 2: sold_tickets
        // Depth 3: reserve_payout_spk
        // Depth 4: refund_lock_daa
        // Depth 5: total_tickets
        // Depth 6: ticket_price
        // Depth 7: round_id
        // Depth 8: action (1)
        // Depth 9: count (8B)
        // Depth 10: payout_spk
        // Depth 11..37: siblings[0..26] (27 items)

        // Width checks:
        sb.add_i64(9)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpSize)?;
        sb.add_i64(8)?;
        sb.add_op(OpNumEqualVerify)?;
        sb.add_op(OpDrop)?; // count

        for i in 11..38 {
            sb.add_i64(i as i64)?;
            sb.add_op(OpPick)?;
            sb.add_op(OpSize)?;
            sb.add_i64(32)?;
            sb.add_op(OpNumEqualVerify)?;
            sb.add_op(OpDrop)?;
        }

        // Canonical payout_spk check:
        append_canonical_payout_spk_check(&mut sb, 10)?;

        // Count bounds:
        sb.add_i64(9)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpBin2Num)?; // count_num
        sb.add_op(OpDup)?;
        sb.add_i64(1)?;
        sb.add_op(OpGreaterThanOrEqual)?;
        sb.add_op(OpVerify)?;

        // sold_after = sold_tickets + count:
        sb.add_op(Op3)?;
        sb.add_op(OpPick)?; // sold_tickets (depth 2 + 1)
        sb.add_op(OpBin2Num)?;
        sb.add_op(OpAdd)?; // sold_after
        sb.add_op(OpDup)?;
        sb.add_i64(7)?;
        sb.add_op(OpPick)?; // total_tickets (depth 5 + 2)
        sb.add_op(OpBin2Num)?;
        sb.add_op(OpLessThanOrEqual)?;
        sb.add_op(OpVerify)?;
        sb.add_op(OpToAltStack)?; // AltStack: [sold_after]

        // Exact payment verification:
        sb.add_i64(9)?;
        sb.add_op(OpPick)?; // count
        sb.add_op(OpBin2Num)?;
        sb.add_i64(7)?;
        sb.add_op(OpPick)?; // ticket_price (depth 6 + 1)
        sb.add_op(OpBin2Num)?;
        sb.add_op(OpMul)?;
        sb.add_op(Op0)?;
        sb.add_op(OpTxInputAmount)?;
        sb.add_op(OpAdd)?; // expected_exact
        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputAmount)?;
        sb.add_op(OpEqualVerify)?;

        // Enforce Singleton Continuation Guard:
        lineage::append_kaswin_singleton_continuation_guard(&mut sb)?;

        // Setup for Merkle tree:
        sb.add_op(Op1)?;
        sb.add_op(OpPick)?; // purchase_count
        sb.add_op(OpBin2Num)?;
        sb.add_op(OpDup)?;
        sb.add_op(Op1)?;
        sb.add_op(OpAdd)?; // next_pc
        sb.add_op(OpToAltStack)?; // AltStack: [sold_after, next_pc]
        sb.add_op(OpToAltStack)?; // AltStack: [sold_after, next_pc, current_pc]

        sb.add_op(Op0)?;
        sb.add_op(OpPick)?; // ticket_root
        sb.add_op(OpToAltStack)?; // AltStack: [sold_after, next_pc, current_pc, ticket_root]

        let empty_leaf = ticket_commitment::compute_empty_leaf();
        sb.add_data(&empty_leaf.as_bytes())?;
        sb.add_op(OpToAltStack)?; // AltStack: [sold_after, next_pc, current_pc, ticket_root, empty_leaf]

        // payout_comm:
        sb.add_i64(10)?;
        sb.add_op(OpPick)?; // payout_spk (depth 10)
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
        sb.add_op(OpToAltStack)?;     // Save payout_comm to AltStack, dstack is back to 38 items!

        // assemble purchase_leaf:
        // Original 38 items: Depth 0: ticket_root, Depth 1: purchase_count, Depth 2: sold_tickets,
        // Depth 7: round_id, Depth 9: count.
        sb.add_data(b"KaswinTicketRangeV1")?;
        sb.add_i64(8)?;
        sb.add_op(OpPick)?; // round_id (depth 7 + 1)
        sb.add_op(OpCat)?;
        sb.add_i64(2)?;
        sb.add_op(OpPick)?; // purchase_count (depth 1 + 1)
        sb.add_op(OpCat)?;
        sb.add_i64(3)?;
        sb.add_op(OpPick)?; // sold_tickets (depth 2 + 1)
        sb.add_op(OpCat)?;
        sb.add_i64(10)?;
        sb.add_op(OpPick)?; // count (depth 9 + 1)
        sb.add_op(OpCat)?;
        sb.add_op(OpFromAltStack)?; // pops payout_comm from AltStack!
        sb.add_op(OpCat)?;
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?; // purchase_leaf
        sb.add_op(OpToAltStack)?;

        // Clean top 11 items from dstack (8 prefix + 1 action + 1 count + 1 payout_spk = 11 items):
        for _ in 0..5 { sb.add_op(Op2Drop)?; }
        sb.add_op(OpDrop)?;
        // Stack has ONLY: [siblings[26..0]]!

        // Reshuffle AltStack:
        sb.add_op(OpFromAltStack)?; // purchase_leaf
        sb.add_op(OpFromAltStack)?; // empty_leaf
        sb.add_op(OpFromAltStack)?; // ticket_root
        sb.add_op(OpFromAltStack)?; // current_pc
        sb.add_op(OpSwap)?;
        sb.add_op(OpToAltStack)?;   // ticket_root
        sb.add_op(OpSwap)?;
        sb.add_op(OpToAltStack)?;   // empty_leaf
        sb.add_op(OpSwap)?;
        sb.add_op(OpToAltStack)?;   // purchase_leaf
        // dstack: [siblings, current_pc]

        // 27-level parallel SMT traversal:
        for i in 0..TREE_DEPTH {
            sb.add_op(OpDup)?;
            if i > 0 {
                sb.add_i64(1i64 << i)?;
                sb.add_op(OpDiv)?;
            }
            sb.add_i64(2)?;
            sb.add_op(OpMod)?;

            sb.add_i64(2)?;
            sb.add_op(OpRoll)?;
            sb.add_op(OpDup)?;

            sb.add_op(OpFromAltStack)?;
            sb.add_op(OpSwap)?;
            sb.add_i64(3)?;
            sb.add_op(OpPick)?;
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

            sb.add_op(OpFromAltStack)?;
            sb.add_op(OpFromAltStack)?;
            sb.add_i64(1)?;
            sb.add_op(OpRoll)?;
            sb.add_op(OpToAltStack)?;
            sb.add_op(OpSwap)?;
            sb.add_i64(2)?;
            sb.add_op(OpRoll)?;
            sb.add_op(OpIf)?;
                sb.add_op(OpSwap)?;
            sb.add_op(OpEndIf)?;
            sb.add_op(OpCat)?;
            sb.add_data(b"KaswinTicketNodeV1")?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?;
            sb.add_data(b"")?;
            sb.add_op(OpBlake2bWithKey)?;

            sb.add_op(OpFromAltStack)?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpToAltStack)?;
            sb.add_op(OpToAltStack)?;
        }

        sb.add_op(OpDrop)?; // drop current_pc
        sb.add_op(OpFromAltStack)?; // new_root
        sb.add_op(OpFromAltStack)?; // old_root
        sb.add_op(OpFromAltStack)?; // ticket_root
        sb.add_op(OpEqualVerify)?;  // Critical verification!

        sb.add_op(OpFromAltStack)?; // next_pc
        sb.add_op(OpFromAltStack)?; // sold_after

        // Transition: OPEN vs SEALED:
        sb.add_op(OpDup)?;
        sb.add_i64(total_tickets as i64)?;
        sb.add_op(OpLessThan)?;

        sb.add_op(OpIf)?;
            // Next OPEN prefix construction:
            // Introspect immutable part of OPEN prefix (from index 0 up to reserve_payout_spk included):
            // Immut prefix length = 3 (header) + 33 (round_id) + 9 (price) + 9 (total) + 9 (lock_daa) + (1 + reserve_payout_spk_len) = 64 + reserve_payout_spk_len.
            let immut_open_prefix_len = 64 + reserve_payout_spk_len;
            let full_open_prefix_len = immut_open_prefix_len + 9 + 9 + 33; // + sold[9] + pc[9] + root[33]
            let total_redeem_len = full_open_prefix_len + body_len;

            // 1. Format sold_after (9B push data: [0x08 || 8B_LE]):
            sb.add_i64(8)?;
            sb.add_op(OpNum2Bin)?;
            sb.add_data(&[0x08])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?; // [new_root, next_pc, push_sold]

            // 2. Format next_pc (9B push data: [0x08 || 8B_LE]):
            sb.add_op(OpSwap)?; // [new_root, push_sold, next_pc]
            sb.add_i64(8)?;
            sb.add_op(OpNum2Bin)?;
            sb.add_data(&[0x08])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?; // [new_root, push_sold, push_pc]

            // 3. Re-order on stack to [push_sold, push_pc, new_root] and format new_root:
            sb.add_op(OpSwap)?; // [new_root, push_pc, push_sold]
            sb.add_i64(2)?;
            sb.add_op(OpRoll)?; // [push_pc, push_sold, new_root]
            sb.add_data(&[0x20])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?; // [push_pc, push_sold, push_root]

            // 4. Save to AltStack in order [push_root, push_pc, push_sold]:
            sb.add_op(OpToAltStack)?; // astack: [push_root], dstack: [push_pc, push_sold]
            sb.add_op(OpSwap)?;       // dstack: [push_sold, push_pc]
            sb.add_op(OpToAltStack)?; // astack: [push_root, push_pc], dstack: [push_sold]
            sb.add_op(OpToAltStack)?; // astack: [push_root, push_pc, push_sold], dstack: []

            // 5. Slice immut prefix:
            sb.add_op(Op0)?;
            sb.add_op(OpTxInputScriptSigLen)?; // [sig_len]
            sb.add_op(OpDup)?;
            sb.add_i64(total_redeem_len as i64)?;
            sb.add_op(OpSub)?; // p_start = sig_len - total_redeem_len
            sb.add_op(OpDup)?;
            sb.add_i64(immut_open_prefix_len as i64)?;
            sb.add_op(OpAdd)?; // p_end = p_start + immut_open_prefix_len

            // Prepare [0, p_start, p_end] for OpTxInputScriptSigSubstr:
            sb.add_op(OpToAltStack)?; // astack: [..., p_end], dstack: [sig_len, p_start]
            sb.add_op(Op0)?;          // dstack: [sig_len, p_start, 0]
            sb.add_op(OpSwap)?;       // dstack: [sig_len, 0, p_start]
            sb.add_op(OpFromAltStack)?; // astack: [push_root, push_pc, push_sold], dstack: [sig_len, 0, p_start, p_end]
            sb.add_op(OpTxInputScriptSigSubstr)?; // dstack: [sig_len, immut_prefix]

            // 6. Concatenate prefix pieces:
            sb.add_op(OpFromAltStack)?; // pops push_sold -> [sig_len, immut_prefix, push_sold]
            sb.add_op(OpCat)?;          // [sig_len, immut_prefix || push_sold]
            sb.add_op(OpFromAltStack)?; // pops push_pc -> [sig_len, prefix_with_sold, push_pc]
            sb.add_op(OpCat)?;          // [sig_len, prefix_with_pc]
            sb.add_op(OpFromAltStack)?; // pops push_root -> [sig_len, prefix_with_pc, push_root]
            sb.add_op(OpCat)?;          // [sig_len, full_next_prefix]

            // 7. Slice body:
            sb.add_op(OpToAltStack)?; // astack: [full_next_prefix], dstack: [sig_len]
            sb.add_op(OpDup)?;
            sb.add_i64(body_len as i64)?;
            sb.add_op(OpSub)?; // body_start = sig_len - body_len
            sb.add_op(OpSwap)?; // [body_start, sig_len]
            sb.add_op(OpToAltStack)?; // astack: [full_next_prefix, sig_len], dstack: [body_start]
            sb.add_op(Op0)?;          // [body_start, 0]
            sb.add_op(OpSwap)?;       // [0, body_start]
            sb.add_op(OpFromAltStack)?; // astack: [full_next_prefix], dstack: [0, body_start, sig_len]
            sb.add_op(OpTxInputScriptSigSubstr)?; // [body_bytes]

            // 8. Concatenate prefix and body:
            sb.add_op(OpFromAltStack)?; // [body_bytes, full_next_prefix]
            sb.add_op(OpSwap)?;         // [full_next_prefix, body_bytes]
            sb.add_op(OpCat)?;          // [next_open_redeem_script]

            sb.add_data(b"")?;
            sb.add_op(OpBlake2bWithKey)?;
            sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?;
            sb.add_data(&[0x87])?;
            sb.add_op(OpCat)?;

            sb.add_op(Op0)?;
            sb.add_op(OpTxOutputSpk)?;
            sb.add_op(OpEqualVerify)?;

        sb.add_op(OpElse)?;
            // Sold out -> Transition to production SEALED V1:
            // Input stack: [new_root, next_pc, sold_after]
            sb.add_op(OpDrop)?; // drop sold_after
            // Stack now: [new_root, next_pc]

            // Format next_pc into push-data: [0x08 || next_pc(8B)]
            sb.add_i64(8)?;
            sb.add_op(OpNum2Bin)?;
            sb.add_data(&[0x08])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?; // [new_root, push_next_pc]
            sb.add_op(OpToAltStack)?; // AltStack: [push_next_pc], Stack: [new_root]

            // Format new_root into push-data: [0x20 || new_root(32B)]
            sb.add_data(&[0x20])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?; // [push_new_root]
            sb.add_op(OpToAltStack)?; // AltStack: [push_next_pc, push_new_root], Stack is EMPTY!

            // Introspect total_redeem_len of current OPEN input:
            let immut_open_prefix_len = 64 + reserve_payout_spk_len;
            let full_open_prefix_len = immut_open_prefix_len + 9 + 9 + 33;
            let total_redeem_len = full_open_prefix_len + body_len;

            // Calculate redeem_start in Input 0 scriptSig:
            sb.add_op(Op0)?;
            sb.add_op(OpTxInputScriptSigLen)?; // [sig_len]
            sb.add_i64(total_redeem_len as i64)?;
            sb.add_op(OpSub)?; // [redeem_start]

            // Slice Segment 1: [redeem_start + 0 .. redeem_start + 54]
            // (OpTxInputIndex[3] || round_id[33] || ticket_price[9] || total_tickets[9] = 54B)
            sb.add_op(OpDup)?; // [redeem_start, redeem_start]
            sb.add_op(OpToAltStack)?; // AltStack: [push_next_pc, push_new_root, redeem_start]
            sb.add_op(Op0)?;   // [redeem_start, 0]
            sb.add_op(OpSwap)?; // [0, redeem_start]
            sb.add_op(OpDup)?;  // [0, redeem_start, redeem_start]
            sb.add_i64(54)?;
            sb.add_op(OpAdd)?;  // [0, redeem_start, seg1_end]
            sb.add_op(OpTxInputScriptSigSubstr)?; // [open_prefix_54]

            // Append push_new_root from AltStack:
            sb.add_op(OpFromAltStack)?; // redeem_start
            sb.add_op(OpSwap)?;         // [redeem_start, open_prefix_54]
            sb.add_op(OpFromAltStack)?; // push_new_root
            sb.add_op(OpCat)?;          // [redeem_start, open_prefix_54 || push_new_root]

            // Append push_next_pc from AltStack:
            sb.add_op(OpFromAltStack)?; // push_next_pc
            sb.add_op(OpCat)?;          // [redeem_start, open_prefix_54 || push_new_root || push_next_pc]

            // Slice Segment 2 from OPEN Input 0: reserve_payout_spk
            // Starts at redeem_start + 63, ends at redeem_start + 63 + 1 + reserve_payout_spk_len
            sb.add_op(OpSwap)?; // [assembled_part, redeem_start]
            sb.add_op(Op0)?;
            sb.add_op(OpSwap)?; // [assembled_part, 0, redeem_start]
            sb.add_op(OpDup)?;  // [assembled_part, 0, redeem_start, redeem_start]
            sb.add_i64(63)?;
            sb.add_op(OpAdd)?;  // [assembled_part, 0, redeem_start, res_start]
            sb.add_op(OpSwap)?; // [assembled_part, 0, res_start, redeem_start]
            let res_end_offset = (63 + 1 + reserve_payout_spk_len) as i64;
            sb.add_i64(res_end_offset)?;
            sb.add_op(OpAdd)?;  // [assembled_part, 0, res_start, res_end]
            sb.add_op(OpTxInputScriptSigSubstr)?; // [assembled_part, push_reserve_spk]
            sb.add_op(OpCat)?;  // [assembled_sealed_prefix] (133B or 134B)

            // Append canonical production SEALED V1 body:
            let sealed_body = build_sealed_body_v1(total_tickets, reserve_payout_spk_len)?;
            for chunk in sealed_body.chunks(500) {
                sb.add_data(chunk)?;
                sb.add_op(OpCat)?;
            }

            // P2SH of production SEALED V1:
            sb.add_data(b"")?;
            sb.add_op(OpBlake2bWithKey)?;
            sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?;
            sb.add_data(&[0x87])?;
            sb.add_op(OpCat)?;

            sb.add_op(Op0)?;
            sb.add_op(OpTxOutputSpk)?;
            sb.add_op(OpEqualVerify)?;
        sb.add_op(OpEndIf)?;

    sb.add_op(OpElse)?;
        // Not BUY -> Check ACTION_BEGIN_REFUND vs ACTION_RECOVER_EMPTY
        sb.add_op(OpDup)?;
        sb.add_i64(ACTION_BEGIN_REFUND)?;
        sb.add_op(OpEqual)?;
        sb.add_op(OpIf)?;
            // =========================================================
            // ACTION 2: BEGIN_REFUND
            // =========================================================
            sb.add_op(OpDrop)?; // drop action_num
            // 1. sold_tickets > 0:
            sb.add_op(Op2)?;
            sb.add_op(OpPick)?; // sold_tickets
            sb.add_op(OpBin2Num)?;
            sb.add_op(Op0)?;
            sb.add_op(OpGreaterThan)?;
            sb.add_op(OpVerify)?;

            // 2. sold_tickets < total_tickets:
            sb.add_op(Op2)?;
            sb.add_op(OpPick)?; // sold_tickets
            sb.add_op(OpBin2Num)?;
            sb.add_i64(6)?;
            sb.add_op(OpPick)?; // total_tickets (depth 5 + 1)
            sb.add_op(OpBin2Num)?;
            sb.add_op(OpLessThan)?;
            sb.add_op(OpVerify)?;

            // 3. Time gate: refund_lock_daa OpCheckLockTimeVerify (pops in Kaspa!)
            sb.add_i64(4)?;
            sb.add_op(OpPick)?; // refund_lock_daa (8B LE)
            sb.add_op(OpCheckLockTimeVerify)?;

            // 4. Output 0 Amount == Input 0 Amount:
            sb.add_op(Op0)?;
            sb.add_op(OpTxInputAmount)?;
            sb.add_op(Op0)?;
            sb.add_op(OpTxOutputAmount)?;
            sb.add_op(OpEqualVerify)?;

            // 5. Output 0 SPK == P2SH(REFUNDING with cursor=0, rem=sold_tickets)
            // Construct REFUNDING prefix:
            let mut ref_head_sb = ScriptBuilder::new();
            ref_head_sb.add_op(OpTxInputIndex)?;
            ref_head_sb.add_op(Op0)?;
            ref_head_sb.add_op(OpEqualVerify)?;
            ref_head_sb.add_data(&round_id.as_bytes())?;
            ref_head_sb.add_data(&ticket_price.to_le_bytes())?;
            ref_head_sb.add_data(&total_tickets.to_le_bytes())?;
            let ref_head_bytes = ref_head_sb.drain();

            // Push ticket_root:
            sb.add_op(Op0)?;
            sb.add_op(OpPick)?; // ticket_root (depth 0)
            sb.add_data(&[0x20])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?; // [0x20 || ticket_root]

            // Prepend ref_head:
            sb.add_data(&ref_head_bytes)?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?; // [ref_head || push_root] (Depth 0)

            // Push reserve_payout_spk (raw bytes from depth 3, now depth 4):
            sb.add_i64(4)?;
            sb.add_op(OpPick)?; // reserve_payout_spk
            sb.add_op(OpSize)?;
            sb.add_i64(1)?;
            sb.add_op(OpNum2Bin)?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?; // [len_1b || reserve_payout_spk]
            sb.add_op(OpCat)?; // [ref_head || push_root || push_reserve] (Depth 0)

            // Push purchase_count (8B LE from depth 1, now depth 2):
            sb.add_op(Op2)?;
            sb.add_op(OpPick)?; // purchase_count
            sb.add_data(&[0x08])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?;
            sb.add_op(OpCat)?; // [ref_head || push_root || push_reserve || push_pc] (Depth 0)

            // Push cursor = 0 (8B LE):
            sb.add_data(&[0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])?;
            sb.add_op(OpCat)?;

            // Push remaining_tickets = sold_tickets (8B LE from depth 2, now depth 3):
            sb.add_op(Op3)?;
            sb.add_op(OpPick)?; // sold_tickets
            sb.add_data(&[0x08])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?;
            sb.add_op(OpCat)?; // [complete_initial_refunding_prefix]

            // Append static REFUNDING body:
            let ref_body = refunding_covenant::build_refunding_body(
                refunding_covenant::canonical_refunding_body_len(reserve_payout_spk_len),
                reserve_payout_spk_len,
            )?;
            // Chunked push to avoid 520B element limit:
            for chunk in ref_body.chunks(500) {
                sb.add_data(chunk)?;
                sb.add_op(OpCat)?;
            }

            // Compute expected P2SH SPK:
            sb.add_data(b"")?;
            sb.add_op(OpBlake2bWithKey)?;
            sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?;
            sb.add_data(&[0x87])?;
            sb.add_op(OpCat)?;

            // Assert Output 0 SPK matches:
            sb.add_op(Op0)?;
            sb.add_op(OpTxOutputSpk)?;
            sb.add_op(OpEqualVerify)?;

            // Enforce Singleton Continuation Guard:
            lineage::append_kaswin_singleton_continuation_guard(&mut sb)?;

            // Clean the 8 prefix items + 1 action_num from stack (9 items total):
            for _ in 0..4 { sb.add_op(Op2Drop)?; }
            sb.add_op(OpDrop)?;

        sb.add_op(OpElse)?;
            // =========================================================
            // ACTION 3: RECOVER_EMPTY
            // =========================================================
            sb.add_i64(ACTION_RECOVER_EMPTY)?;
            sb.add_op(OpEqualVerify)?; // Must be action 3!

            // 1. sold_tickets == 0:
            sb.add_op(Op2)?;
            sb.add_op(OpPick)?;
            sb.add_op(OpBin2Num)?;
            sb.add_op(Op0)?;
            sb.add_op(OpEqualVerify)?;

            // 2. purchase_count == 0:
            sb.add_op(Op1)?;
            sb.add_op(OpPick)?;
            sb.add_op(OpBin2Num)?;
            sb.add_op(Op0)?;
            sb.add_op(OpEqualVerify)?;

            // 3. Time gate: refund_lock_daa OpCheckLockTimeVerify (pops in Kaspa!)
            sb.add_i64(4)?;
            sb.add_op(OpPick)?; // refund_lock_daa
            sb.add_op(OpCheckLockTimeVerify)?;

            // 4. Output 0 SPK == reserve_payout_spk:
            sb.add_op(Op3)?;
            sb.add_op(OpPick)?; // reserve_payout_spk
            sb.add_op(Op0)?;
            sb.add_op(OpTxOutputSpk)?;
            sb.add_op(OpEqualVerify)?;

            // 5. Output 0 Amount == Input 0 Amount:
            sb.add_op(Op0)?;
            sb.add_op(OpTxInputAmount)?;
            sb.add_op(Op0)?;
            sb.add_op(OpTxOutputAmount)?;
            sb.add_op(OpEqualVerify)?;

            // 6. Terminal Lineage Guard:
            lineage::append_kaswin_terminal_lineage_guard(&mut sb)?;

            // Clean the 8 prefix items + 1 witness action item from stack (9 items total):
            for _ in 0..4 { sb.add_op(Op2Drop)?; }
            sb.add_op(OpDrop)?;
        sb.add_op(OpEndIf)?;
    sb.add_op(OpEndIf)?;

    sb.add_op(OpTrue)?;
    Ok(sb.drain())
}

// =============================================================================
// V1 Bounded Purchase Directory & Variable Sale Close Covenant Implementation
// =============================================================================

pub const ACTION_CLOSE: i64 = 2;

/// Builds canonical OPEN state prefix layout for bounded directory:
///   round_id (32B)
///   ticket_price (8B LE)
///   ticket_cap (8B LE)
///   min_tickets (8B LE)
///   sale_deadline (8B LE)
///   sold_tickets (8B LE)
///   purchase_count (8B LE)
///   ticket_root (32B)
///   creator_refund_spk (34B)
///   directory (variable P*36B)
pub fn build_directory_open_prefix(
    round_id: &Hash,
    ticket_price: u64,
    ticket_cap: u64,
    min_tickets: u64,
    sale_deadline: u64,
    sold_tickets: u64,
    purchase_count: u64,
    ticket_root: &Hash,
    creator_refund_spk: &[u8],
    directory: &[u8],
) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&ticket_cap.to_le_bytes()).unwrap();
    sb.add_data(&min_tickets.to_le_bytes()).unwrap();
    sb.add_data(&sale_deadline.to_le_bytes()).unwrap();
    sb.add_data(&sold_tickets.to_le_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.add_data(directory).unwrap();
    sb.drain()
}

fn append_runtime_directory_push(sb: &mut ScriptBuilder) -> ScriptBuilderResult<()> {
    sb.add_op(OpSize)?;
    sb.add_op(OpDup)?; sb.add_i64(75)?; sb.add_op(OpLessThanOrEqual)?;
    sb.add_op(OpIf)?;
        sb.add_i64(1)?; sb.add_op(OpNum2Bin)?;
        sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
    sb.add_op(OpElse)?;
        sb.add_op(OpDup)?; sb.add_i64(255)?; sb.add_op(OpLessThanOrEqual)?;
        sb.add_op(OpIf)?;
            sb.add_op(OpDup)?; sb.add_i64(127)?; sb.add_op(OpLessThanOrEqual)?;
            sb.add_op(OpIf)?;
                sb.add_i64(1)?; sb.add_op(OpNum2Bin)?;
            sb.add_op(OpElse)?;
                sb.add_i64(2)?; sb.add_op(OpNum2Bin)?;
                sb.add_i64(0)?; sb.add_i64(1)?; sb.add_op(OpSubstr)?;
            sb.add_op(OpEndIf)?;
            sb.add_data(&[0x4c])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
            sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
        sb.add_op(OpElse)?;
            sb.add_i64(2)?; sb.add_op(OpNum2Bin)?;
            sb.add_data(&[0x4d])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
            sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
        sb.add_op(OpEndIf)?;
    sb.add_op(OpEndIf)?;
    Ok(())
}

/// Builds production state-independent bounded-directory OPEN body supporting BUY (Action 1) and CLOSE (Action 2).
pub fn build_directory_open_body(static_body_len: usize) -> ScriptBuilderResult<Vec<u8>> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });

    // Step 0: Stash directory on AltStack:
    sb.add_op(OpToAltStack)?; // AltStack: [directory]

    // Validate 9 state parameters on dstack:
    sb.add_op(Op0)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(34)?; sb.add_op(OpEqualVerify)?; // creator_refund_spk (34B)

    sb.add_i64(1)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(32)?; sb.add_op(OpEqualVerify)?; // ticket_root (32B)

    sb.add_i64(2)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(8)?; sb.add_op(OpEqualVerify)?; // purchase_count (8B)

    sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(8)?; sb.add_op(OpEqualVerify)?; // sold_tickets (8B)

    sb.add_i64(4)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(8)?; sb.add_op(OpEqualVerify)?; // sale_deadline (8B)

    sb.add_i64(5)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(8)?; sb.add_op(OpEqualVerify)?; // min_tickets (8B)

    sb.add_i64(6)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(8)?; sb.add_op(OpEqualVerify)?; // ticket_cap (8B)

    sb.add_i64(7)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(8)?; sb.add_op(OpEqualVerify)?; // ticket_price (8B)

    sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
    sb.add_i64(32)?; sb.add_op(OpEqualVerify)?; // round_id (32B)

    // Action check on dstack:
    // Witness action is at depth 9:
    sb.add_i64(9)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // action (num)

    sb.add_op(OpDup)?;
    sb.add_i64(ACTION_BUY)?;
    sb.add_op(OpEqual)?;
    sb.add_op(OpIf)?;
        // =====================================================================
        // ACTION_BUY (1)
        // =====================================================================
        sb.add_op(OpDrop)?; // drop action

        // BUY witness items:
        // depth 9: action (1B)
        // depth 10: count (8B LE)
        // depth 11: buyer_payout_spk (34B P2PK: [0x20] || pubkey[32] || [0xac])
        // depth 12..38: 27 sibling hashes for SMT update
        sb.add_i64(10)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
        sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
        sb.add_i64(8)?; sb.add_op(OpNumEqualVerify)?;

        sb.add_i64(11)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
        sb.add_op(OpSwap)?; sb.add_op(OpDrop)?;
        sb.add_i64(34)?; sb.add_op(OpNumEqualVerify)?;

        // Enforce canonical xonly P2PK format: [0x20] || pubkey[32] || [0xac]
        sb.add_i64(11)?; sb.add_op(OpPick)?;
        sb.add_i64(0)?; sb.add_i64(1)?; sb.add_op(OpSubstr)?;
        sb.add_data(&[0x20])?; sb.add_op(OpEqualVerify)?;

        sb.add_i64(11)?; sb.add_op(OpPick)?;
        sb.add_i64(33)?; sb.add_i64(34)?; sb.add_op(OpSubstr)?;
        sb.add_data(&[0xac])?; sb.add_op(OpEqualVerify)?;

        // Assert count >= 1:
        sb.add_i64(10)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // count (num)
        sb.add_op(OpDup)?; sb.add_i64(1)?; sb.add_op(OpGreaterThanOrEqual)?; sb.add_op(OpVerify)?;

        // Assert sold_tickets + count <= ticket_cap:
        sb.add_i64(4)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // sold_tickets (depth 3 + 1)
        sb.add_op(OpAdd)?; // new_sold = sold_tickets + count
        sb.add_op(OpDup)?;
        sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // ticket_cap (depth 6 + 2)
        sb.add_op(OpLessThanOrEqual)?; sb.add_op(OpVerify)?; // new_sold <= ticket_cap

        // Assert purchase_count < 256:
        sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // purchase_count (depth 2 + 1)
        sb.add_i64(256)?;
        sb.add_op(OpLessThan)?; sb.add_op(OpVerify)?; // purchase_count < 256

        // Topology: 1 state input, 1 state output (additional funding inputs allowed via normal outputs)
        // KIP-20 Singleton continuation on Output 0:
        lineage::append_kaswin_singleton_continuation_guard(&mut sb)?;

        // Exact amount assertion: Output0Amount == Input0Amount + ticket_price * count:
        sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // ticket_price (depth 8)
        sb.add_i64(12)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // count (depth 11 + 1)
        sb.add_op(OpMul)?; // delta = ticket_price * count
        sb.add_op(Op0)?; sb.add_op(OpTxInputAmount)?;
        sb.add_op(OpAdd)?; // expected_output_amount
        sb.add_op(Op0)?; sb.add_op(OpTxOutputAmount)?;
        sb.add_op(OpEqualVerify)?;

        // Construct 36-byte new purchase record:
        // [0..4]: u32 LE new_sold, [4..36]: buyer_pubkey (extracted from 34B P2PK: bytes 1..33)
        sb.add_op(OpDup)?; // new_sold
        sb.add_i64(4)?; sb.add_op(OpNum2Bin)?; // 4-byte LE new_sold
        sb.add_i64(13)?; sb.add_op(OpPick)?; // buyer_payout_spk (depth 11 + 2)
        sb.add_i64(1)?; sb.add_i64(33)?; sb.add_op(OpSubstr)?; // 32-byte pubkey
        sb.add_op(OpCat)?; // 36-byte new record!

        // Append to directory on AltStack:
        sb.add_op(OpFromAltStack)?; // directory
        sb.add_op(OpSwap)?; // [directory, new_record]
        sb.add_op(OpCat)?; // new_directory!
        sb.add_op(OpToAltStack)?; // updated directory back to AltStack!

        // Verify 27-level SMT ticket_root update using canonical tags:
        // payout_commitment = BLAKE2b256("KaswinPayoutSpkV1" || le_u32(34) || buyer_payout_spk)
        sb.add_data(b"KaswinPayoutSpkV1")?;
        sb.add_data(&[0x22, 0x00, 0x00, 0x00])?;
        sb.add_op(OpCat)?;
        sb.add_i64(13)?; sb.add_op(OpPick)?; // buyer_payout_spk (depth 11 + 2)
        sb.add_op(OpCat)?;
        sb.add_data(b"")?; sb.add_op(OpBlake2bWithKey)?; // payout_commitment on dstack!

        // purchase_leaf = BLAKE2b256("KaswinTicketRangeV1" || round_id || le_u64(purchase_index) || le_u64(start_ticket) || le_u64(count) || payout_commitment)
        sb.add_data(b"KaswinTicketRangeV1")?;
        sb.add_i64(11)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; // round_id (depth 8 + 3)
        sb.add_i64(5)?; sb.add_op(OpPick)?; sb.add_i64(8)?; sb.add_op(OpNum2Bin)?; sb.add_op(OpCat)?; // purchase_count (depth 2 + 3)
        sb.add_i64(6)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; // sold_tickets (depth 3 + 3)
        sb.add_i64(13)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; // count (depth 10 + 3)
        sb.add_op(OpSwap)?; sb.add_op(OpCat)?; // payout_commitment
        sb.add_data(b"")?; sb.add_op(OpBlake2bWithKey)?; // new_leaf on dstack!

        // Push new_leaf and empty_leaf to AltStack:
        // AltStack before: [new_directory]
        sb.add_op(OpToAltStack)?; // AltStack: [new_directory, new_leaf]
        let empty_leaf = ticket_commitment::compute_empty_leaf();
        sb.add_data(&empty_leaf.as_bytes())?;
        sb.add_op(OpToAltStack)?; // AltStack: [new_directory, new_leaf, empty_leaf]

        // SMT 27-level parallel traversal:
        for level in 0..27 {
            // Pick purchase_count at depth 3 (under new_sold, creator_refund_spk, ticket_root):
            sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
            if level > 0 {
                sb.add_i64(1i64 << level)?;
                sb.add_op(OpDiv)?;
            }
            sb.add_i64(2)?; sb.add_op(OpMod)?; // bit (0 or 1) on dstack

            let sib_depth = 14 + level;
            sb.add_i64(sib_depth as i64)?; sb.add_op(OpPick)?; // [..., bit, sibling]
            sb.add_op(OpDup)?; // [..., bit, sibling, sibling]

            // Update old_hash:
            sb.add_op(OpFromAltStack)?; // pops old_hash. dstack: [..., bit, sibling, sibling, old_hash]
            sb.add_i64(3)?; sb.add_op(OpPick)?; // bit
            sb.add_op(OpIf)?;
                // bit == 1: sibling is left, old_hash is right -> OpCat does sibling || old_hash
            sb.add_op(OpElse)?;
                sb.add_op(OpSwap)?; // bit == 0: old_hash is left, sibling is right -> OpCat does old_hash || sibling
            sb.add_op(OpEndIf)?;
            sb.add_op(OpCat)?;
            sb.add_data(b"KaswinTicketNodeV1")?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?;
            sb.add_data(b"")?; sb.add_op(OpBlake2bWithKey)?; // new_old_hash
            sb.add_op(OpToAltStack)?; // AltStack: [new_directory, new_hash, new_old_hash]

            // Update new_hash:
            // dstack has: [..., bit, sibling]
            sb.add_op(OpFromAltStack)?; // pops new_old_hash
            sb.add_op(OpFromAltStack)?; // pops new_hash
            sb.add_op(OpSwap)?;
            sb.add_op(OpToAltStack)?; // AltStack: [new_directory, new_old_hash]
            // dstack: [..., bit, sibling, new_hash]
            sb.add_i64(2)?; sb.add_op(OpRoll)?; // moves bit to top: [..., sibling, new_hash, bit]
            sb.add_op(OpIf)?;
                // bit == 1: sibling || new_hash
            sb.add_op(OpElse)?;
                sb.add_op(OpSwap)?; // bit == 0: new_hash || sibling
            sb.add_op(OpEndIf)?;
            sb.add_op(OpCat)?;
            sb.add_data(b"KaswinTicketNodeV1")?;
            sb.add_op(OpSwap)?;
            sb.add_op(OpCat)?;
            sb.add_data(b"")?; sb.add_op(OpBlake2bWithKey)?; // new_new_hash

            sb.add_op(OpFromAltStack)?; // pops new_old_hash: [..., new_new_hash, new_old_hash]
            sb.add_op(OpSwap)?;
            sb.add_op(OpToAltStack)?; // pushes new_new_hash
            sb.add_op(OpToAltStack)?; // pushes new_old_hash
            // AltStack: [new_directory, new_new_hash, new_old_hash]
        }

        // Pop final_old_hash from AltStack:
        sb.add_op(OpFromAltStack)?; // final_old_hash
        // Assert final_old_hash == current ticket_root (depth 3 on dstack):
        sb.add_i64(3)?; sb.add_op(OpPick)?;
        sb.add_op(OpEqualVerify)?; // old_hash verified against current root!

        // Pop updated_ticket_root from AltStack:
        sb.add_op(OpFromAltStack)?; // updated_ticket_root on dstack!
        // dstack: [new_sold, updated_ticket_root] (depth 0 is root, depth 1 is new_sold)
        // AltStack: [new_directory]

        // Slice static directory OPEN body from scriptSig:
        sb.add_op(Op0)?; sb.add_op(OpTxInputScriptSigLen)?;
        sb.add_op(OpDup)?;
        sb.add_i64(static_body_len as i64)?; sb.add_op(OpSub)?;
        sb.add_op(OpSwap)?;
        sb.add_op(Op0)?; sb.add_op(OpRot)?; sb.add_op(OpRot)?;
        sb.add_op(OpTxInputScriptSigSubstr)?; // static body
        sb.add_op(OpToAltStack)?; // AltStack: [directory, static_body]

        // Reconstruct successor OPEN prefix:
        // [0xb9, 0x00, 0x88] (3B)
        sb.add_data(&[0xb9, 0x00, 0x88])?;
        // round_id (32B): depth 11
        sb.add_data(&[0x20])?; sb.add_i64(12)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
        // ticket_price (8B): depth 10
        sb.add_data(&[0x08])?; sb.add_i64(11)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
        // ticket_cap (8B): depth 9
        sb.add_data(&[0x08])?; sb.add_i64(10)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
        // min_tickets (8B): depth 8
        sb.add_data(&[0x08])?; sb.add_i64(9)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
        // sale_deadline (8B): depth 7
        sb.add_data(&[0x08])?; sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
        // new_sold (8B LE): on dstack at depth 2 (under prefix_bytes)
        sb.add_i64(2)?; sb.add_op(OpPick)?; sb.add_i64(8)?; sb.add_op(OpNum2Bin)?;
        sb.add_data(&[0x08])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
        // new_purchase_count (8B LE): purchase_count is at depth 5
        sb.add_i64(5)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; sb.add_i64(1)?; sb.add_op(OpAdd)?;
        sb.add_i64(8)?; sb.add_op(OpNum2Bin)?;
        sb.add_data(&[0x08])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
        // updated ticket_root (32B): on dstack at depth 1
        sb.add_data(&[0x20])?; sb.add_i64(2)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
        // creator_refund_spk (34B): at depth 4 (under prefix_bytes, prefix_so_far, updated_ticket_root, new_sold)
        sb.add_data(&[0x22])?; sb.add_i64(4)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;

        // Directory push: directory is on AltStack, static_body is under directory on AltStack:
        // AltStack was: [directory, static_body]
        // In Step 0: AltStack: [directory]. In Step Slicing: AltStack: [directory, static_body].
        // So FromAltStack pops static_body, then FromAltStack pops directory!
        sb.add_op(OpFromAltStack)?; // static_body
        sb.add_op(OpFromAltStack)?; // directory
        sb.add_op(OpSwap)?; // [static_body, directory]
        sb.add_op(OpToAltStack)?; // AltStack: [static_body]
        // Now dstack has: [prefix_so_far, directory]
        append_runtime_directory_push(&mut sb)?; // [prefix_so_far, pushed_directory]
        sb.add_op(OpCat)?; // [full_prefix]
        sb.add_op(OpFromAltStack)?; // [full_prefix, static_body]
        sb.add_op(OpCat)?; // full expected successor redeem script!

        sb.add_data(b"")?; sb.add_op(OpBlake2bWithKey)?;
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
        sb.add_data(&[0x87])?; sb.add_op(OpCat)?;
        sb.add_op(Op0)?; sb.add_op(OpTxOutputSpk)?;
        sb.add_op(OpEqualVerify)?;

        // Teardown stack:
        for _ in 0..41 {
            sb.add_op(OpDrop)?;
        }
        sb.add_op(OpTrue)?;

    sb.add_op(OpElse)?;
        // =====================================================================
        // ACTION_CLOSE (2)
        // =====================================================================
        sb.add_op(OpDrop)?; // drop action

        // CLOSE trigger assertion:
        // 1) sold_tickets == ticket_cap:
        sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // sold_tickets
        sb.add_i64(7)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // ticket_cap
        sb.add_op(OpEqual)?;

        // 2) purchase_count == 256:
        sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // purchase_count
        sb.add_i64(256)?;
        sb.add_op(OpEqual)?;
        sb.add_op(OpOr)?; // condition A: capacity reached

        // 3) Deadline check (Requirement 四):
        // If not capacity reached, strictly enforce tx.lock_time == sale_deadline AND sequence != MAX_SEQUENCE
        sb.add_op(OpDup)?;
        sb.add_op(OpIf)?;
            // Capacity reached: skip deadline
        sb.add_op(OpElse)?;
            sb.add_op(OpDrop)?; // drop false
            sb.add_i64(4)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // sale_deadline
            // Enforce tx.lock_time == sale_deadline:
            sb.add_op(OpDup)?;
            sb.add_op(OpTxLockTime)?;
            sb.add_op(OpEqualVerify)?;
            // Enforce OpCheckLockTimeVerify (which strictly requires input.sequence != u64::MAX):
            sb.add_op(OpCheckLockTimeVerify)?;
            sb.add_op(OpTrue)?; // deadline satisfied!
        sb.add_op(OpEndIf)?;
        sb.add_op(OpVerify)?; // Trigger verified!

        // Outcome dispatch: sold_tickets >= min_tickets -> SEALED else -> REFUNDING:
        sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // sold_tickets
        sb.add_i64(6)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // min_tickets
        sb.add_op(OpGreaterThanOrEqual)?;

        sb.add_op(OpIf)?;
            // -----------------------------------------------------------------
            // DISPATCH TO SEALED (sold_tickets >= min_tickets)
            // -----------------------------------------------------------------
            lineage::append_kaswin_singleton_continuation_guard(&mut sb)?;

            // Exact amount preservation:
            sb.add_op(Op0)?; sb.add_op(OpTxInputAmount)?;
            sb.add_op(Op0)?; sb.add_op(OpTxOutputAmount)?;
            sb.add_op(OpEqualVerify)?;

            // Reconstruct SEALED redeem script:
            // [0xb9, 0x00, 0x88] (3B)
            sb.add_data(&[0xb9, 0x00, 0x88])?;
            // round_id (32B): depth 10
            sb.add_data(&[0x20])?; sb.add_i64(10)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
            // ticket_price (8B): depth 9
            sb.add_data(&[0x08])?; sb.add_i64(9)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
            // draw_ticket_count = sold_tickets (8B): depth 5
            sb.add_data(&[0x08])?; sb.add_i64(5)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
            // ticket_root (32B): depth 3
            sb.add_data(&[0x20])?; sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
            // purchase_count (8B): depth 4
            sb.add_data(&[0x08])?; sb.add_i64(4)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
            // creator_refund_spk (34B): depth 2
            sb.add_data(&[0x22])?; sb.add_i64(2)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;

            // Directory from AltStack:
            sb.add_op(OpFromAltStack)?; // directory
            append_runtime_directory_push(&mut sb)?;
            sb.add_op(OpCat)?; // full SEALED prefix

            // Append production directory SEALED body:
            let sealed_body = sealed_covenant::build_directory_sealed_body()?;
            sb.add_data(&sealed_body)?;
            sb.add_op(OpCat)?; // full SEALED redeem script!

            // Output 0 SPK == P2SH(SEALED redeem):
            sb.add_data(b"")?; sb.add_op(OpBlake2bWithKey)?;
            sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
            sb.add_data(&[0x87])?; sb.add_op(OpCat)?;
            sb.add_op(Op0)?; sb.add_op(OpTxOutputSpk)?;
            sb.add_op(OpEqualVerify)?;

        sb.add_op(OpElse)?;
            // Check if sold_tickets == 0 && purchase_count == 0 (P = 0 Empty Round):
            sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // sold_tickets
            sb.add_op(Op0)?;
            sb.add_op(OpEqual)?;
            sb.add_i64(3)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?; // purchase_count (after OpEqual, depth 2+1=3)
            sb.add_op(Op0)?;
            sb.add_op(OpEqual)?;
            sb.add_op(OpAnd)?;
            sb.add_op(OpIf)?;
                // =============================================================
                // EMPTY ROUND TERMINAL RECOVERY (P = 0)
                // =============================================================
                // 1. Lineage destruction guards:
                // OpCovInputCount(C) == 1, OpAuthOutputCount(0) == 0,
                // OpCovOutputCount(C) == 0, OpOutputCovenantId(0) == ZERO_HASH,
                // OpOutputAuthorizingInput(0) == -1
                lineage::append_kaswin_terminal_lineage_guard(&mut sb)?;

                // 2. Output 0 SPK == [0x00, 0x00] || creator_refund_spk (36B SPK)
                sb.add_i64(0)?; sb.add_op(OpPick)?; // creator_refund_spk (34B)
                sb.add_data(&[0x00, 0x00])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?; // 36B SPK
                sb.add_op(Op0)?; sb.add_op(OpTxOutputSpk)?;
                sb.add_op(OpEqualVerify)?;

                // 3. Output 0 Amount == Input 0 Amount (exact 100% state_deposit return)
                sb.add_op(Op0)?; sb.add_op(OpTxInputAmount)?;
                sb.add_op(Op0)?; sb.add_op(OpTxOutputAmount)?;
                sb.add_op(OpEqualVerify)?;

                // 4. Drop directory from AltStack
                sb.add_op(OpFromAltStack)?; sb.add_op(OpDrop)?;

            sb.add_op(OpElse)?;
                // =============================================================
                // DISPATCH TO REFUNDING (sold_tickets < min_tickets && P > 0)
                // =============================================================
                lineage::append_kaswin_singleton_continuation_guard(&mut sb)?;

                // Exact amount preservation:
                sb.add_op(Op0)?; sb.add_op(OpTxInputAmount)?;
                sb.add_op(Op0)?; sb.add_op(OpTxOutputAmount)?;
                sb.add_op(OpEqualVerify)?;

                // Reconstruct initial REFUNDING redeem script (cursor = 0):
                // [0xb9, 0x00, 0x88] (3B)
                sb.add_data(&[0xb9, 0x00, 0x88])?;
                // round_id (32B): depth 10
                sb.add_data(&[0x20])?; sb.add_i64(10)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
                // ticket_price (8B): depth 9
                sb.add_data(&[0x08])?; sb.add_i64(9)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
                // purchase_count (8B): depth 4
                sb.add_data(&[0x08])?; sb.add_i64(4)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;
                // cursor = 0 (8B LE):
                sb.add_data(&[0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])?; sb.add_op(OpCat)?;
                // creator_refund_spk (34B): depth 2
                sb.add_data(&[0x22])?; sb.add_i64(2)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?; sb.add_op(OpCat)?;

                // Directory from AltStack:
                sb.add_op(OpFromAltStack)?; // directory
                append_runtime_directory_push(&mut sb)?;
                sb.add_op(OpCat)?; // full REFUNDING prefix

                // Append compact universal refunding body:
                let ref_body = refunding_covenant::compute_converged_compact_universal_body();
                sb.add_data(&ref_body)?;
                sb.add_op(OpCat)?; // full initial REFUNDING redeem script!

                // Output 0 SPK == P2SH(REFUNDING redeem):
                sb.add_data(b"")?; sb.add_op(OpBlake2bWithKey)?;
                sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
                sb.add_data(&[0x87])?; sb.add_op(OpCat)?;
                sb.add_op(Op0)?; sb.add_op(OpTxOutputSpk)?;
                sb.add_op(OpEqualVerify)?;
            sb.add_op(OpEndIf)?;
        sb.add_op(OpEndIf)?;

        // Teardown stack for CLOSE:
        for _ in 0..10 {
            sb.add_op(OpDrop)?;
        }
        sb.add_op(OpTrue)?;

    sb.add_op(OpEndIf)?;

    Ok(sb.drain())
}

pub fn compute_converged_directory_open_body() -> Vec<u8> {
    let mut guess = 3200usize;
    for _ in 0..20 {
        let body = build_directory_open_body(guess).unwrap();
        if body.len() == guess {
            return body;
        }
        guess = body.len();
    }
    build_directory_open_body(guess).unwrap()
}

pub fn build_initial_directory_open_covenant(
    round_id: Hash,
    ticket_price: u64,
    ticket_cap: u64,
    min_tickets: u64,
    sale_deadline: u64,
    creator_refund_spk: Vec<u8>,
) -> ScriptBuilderResult<Vec<u8>> {
    let empty_root = ticket_commitment::compute_empty_root_27();
    let body = compute_converged_directory_open_body();
    let prefix = build_directory_open_prefix(
        &round_id,
        ticket_price,
        ticket_cap,
        min_tickets,
        sale_deadline,
        0,
        0,
        &empty_root,
        &creator_refund_spk,
        &[], // initial directory is empty
    );
    let mut full = prefix;
    full.extend_from_slice(&body);
    Ok(full)
}

pub fn build_directory_open_covenant(
    round_id: Hash,
    ticket_price: u64,
    ticket_cap: u64,
    min_tickets: u64,
    sale_deadline: u64,
    sold_tickets: u64,
    purchase_count: u64,
    ticket_root: Hash,
    creator_refund_spk: Vec<u8>,
    directory: &[u8],
) -> ScriptBuilderResult<Vec<u8>> {
    let body = compute_converged_directory_open_body();
    let prefix = build_directory_open_prefix(
        &round_id,
        ticket_price,
        ticket_cap,
        min_tickets,
        sale_deadline,
        sold_tickets,
        purchase_count,
        &ticket_root,
        &creator_refund_spk,
        directory,
    );
    let mut full = prefix;
    full.extend_from_slice(&body);
    Ok(full)
}
