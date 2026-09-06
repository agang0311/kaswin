// Kaswin Winner Selection & Suffix Self-Replication Covenant
//
// Protocol Version: Kaswin V1 (Toccata Consensus Rules)
// State Machine: DRAW_READY -> DRAW_READY(counter+1) [REJECT]
//                DRAW_READY -> WINNER_READY          [ACCEPT]
//
// State Propagation:
//   Propagates round_id, ticket_price, total_tickets, ticket_root,
//   target_hash, random_seed, creator_refund_spk from SEALED into DRAW_READY and WINNER_READY.

use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

#[path = "lineage.rs"]
pub mod lineage;

#[path = "winner_ready_settlement.rs"]
pub mod winner_ready_settlement;

pub const MAX_TOTAL_TICKETS: u64 = 100_000_000;
pub const COUNTER_PUSH_LEN: usize = 9; // 0x08 push opcode + 8 bytes LE counter
pub const DOMAIN_R_56: i64 = 1i64 << 56; // 72,057,594,037,927,936

pub fn draw_ready_prefix_len(creator_refund_spk_len: usize) -> usize {
    // 3 (OpTxInputIndex, Op0, OpEqualVerify)
    // + 33 (round_id)
    // + 9  (ticket_price)
    // + 9  (total_tickets)
    // + 33 (ticket_root)
    // + 33 (target_hash)
    // + 33 (random_seed)
    // + 1 + creator_refund_spk_len
    154 + creator_refund_spk_len
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WinnerStepResult {
    Accepted { winner_index: u64 },
    Rejected { next_counter: u64 },
}

pub fn compute_candidate_hash(random_seed: &Hash, counter: u64) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinWinnerCandidateV1");
    state.update(random_seed.as_bytes().as_slice());
    state.update(&counter.to_le_bytes());
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

pub fn extract_candidate_num(candidate_hash: &Hash) -> i64 {
    let bytes = candidate_hash.as_bytes();
    let mut num_bytes = [0u8; 8];
    num_bytes[0..7].copy_from_slice(&bytes[0..7]);
    num_bytes[7] = 0;
    i64::from_le_bytes(num_bytes)
}

pub fn reference_winner_step(
    total_tickets: u64,
    random_seed: &Hash,
    counter: u64,
) -> WinnerStepResult {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);
    if total_tickets == 1 {
        return WinnerStepResult::Accepted { winner_index: 0 };
    }
    let cand_hash = compute_candidate_hash(random_seed, counter);
    let cand_num = extract_candidate_num(&cand_hash);

    let n = total_tickets as i64;
    let q = DOMAIN_R_56 / n;
    let limit = q * n;

    if cand_num < limit {
        let winner = (cand_num % n) as u64;
        WinnerStepResult::Accepted { winner_index: winner }
    } else {
        WinnerStepResult::Rejected { next_counter: counter + 1 }
    }
}

/// Static Prefix before counter in DRAW_READY redeem script.
pub fn build_draw_ready_prefix(
    round_id: &Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: &Hash,
    target_hash: &Hash,
    random_seed: &Hash,
    creator_refund_spk: &[u8],
) -> Vec<u8> {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);
    let mut sb = ScriptBuilder::new();
    // Enforce execution at Input 0:
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Push state constants:
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&total_tickets.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    let prefix = sb.drain();
    assert_eq!(prefix.len(), draw_ready_prefix_len(creator_refund_spk.len()));
    prefix
}

/// Builds the shared canonical self-replicating reject successor bytecode.
pub fn append_canonical_reject_successor_bytecode(
    sb: &mut ScriptBuilder,
    creator_refund_spk_len: usize,
    suffix_len: usize,
) {
    // Drop the 7 state items below counter_bytes:
    // [round_id, ticket_price, total_tickets, ticket_root, target_hash, random_seed, creator_refund_spk, counter_bytes]
    for i in (1..=7).rev() {
        sb.add_i64(i).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap();
    }
    // Stack: [counter_bytes]

    // Calculate next_counter = counter + 1:
    sb.add_op(OpBin2Num).unwrap(); // [counter (i64)]
    sb.add_i64(1).unwrap();
    sb.add_op(OpAdd).unwrap(); // [counter + 1]
    sb.add_i64(8).unwrap();
    sb.add_op(OpNum2Bin).unwrap(); // [next_counter_bytes (8B LE)]
    // Prepend push opcode 0x08 for counter push item:
    sb.add_data(&[0x08]).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // Stack: [next_counter_push (9B: 0x08 || next_counter[8])]

    // Introspect current Input 0 SignatureScript:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputScriptSigLen).unwrap(); // Stack: [next_counter_push, sig_len]

    let prefix_len = draw_ready_prefix_len(creator_refund_spk_len);
    let total_redeem_len = (prefix_len + COUNTER_PUSH_LEN + suffix_len) as i64;

    // Compute p_start = sig_len - total_redeem_len
    sb.add_op(OpDup).unwrap();
    sb.add_i64(total_redeem_len).unwrap();
    sb.add_op(OpSub).unwrap(); // Stack: [next_counter_push, sig_len, p_start]

    // Compute p_end = p_start + prefix_len
    sb.add_op(OpDup).unwrap();
    sb.add_i64(prefix_len as i64).unwrap();
    sb.add_op(OpAdd).unwrap(); // Stack: [next_counter_push, sig_len, p_start, p_end]

    // Slice prefix: from p_start to p_end
    sb.add_i64(0).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_op(OpRoll).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_op(OpRoll).unwrap();
    sb.add_op(OpTxInputScriptSigSubstr).unwrap(); // Stack: [next_counter_push, sig_len, prefix_bytes]

    // Concatenate prefix || next_counter_push:
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop sig_len -> Stack: [next_counter_push, prefix_bytes]
    sb.add_i64(1).unwrap();
    sb.add_op(OpRoll).unwrap();
    sb.add_op(OpCat).unwrap(); // Stack: [prefix || next_counter_push]

    // Introspect suffix_bytes: [sig_len - suffix_len .. sig_len]
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputScriptSigLen).unwrap(); // Stack: [combined_prefix, sig_len]
    sb.add_op(OpDup).unwrap();
    sb.add_i64(suffix_len as i64).unwrap();
    sb.add_op(OpSub).unwrap(); // Stack: [combined_prefix, sig_len, s_start]
    sb.add_op(OpSwap).unwrap(); // Stack: [combined_prefix, s_start, sig_len]
    sb.add_op(Op0).unwrap();    // Stack: [combined_prefix, s_start, sig_len, 0]
    sb.add_i64(2).unwrap();
    sb.add_op(OpRoll).unwrap(); // Stack: [combined_prefix, sig_len, 0, s_start]
    sb.add_i64(2).unwrap();
    sb.add_op(OpRoll).unwrap(); // Stack: [combined_prefix, 0, s_start, sig_len]
    sb.add_op(OpTxInputScriptSigSubstr).unwrap(); // Stack: [combined_prefix, suffix_bytes]

    // Assemble complete self-replicated script:
    sb.add_op(OpCat).unwrap(); // Stack: [next_redeem_script]

    // Compute expected P2SH SPK:
    sb.add_data(b"").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    sb.add_data(&[0x00, 0x00, 0xaa, 0x20]).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(&[0x87]).unwrap();
    sb.add_op(OpCat).unwrap(); // Stack: [expected_next_draw_ready_spk]
}

/// Builds complete DRAW_READY redeem script for a given round state and counter.
pub fn build_draw_ready_covenant(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: Hash,
    target_hash: Hash,
    random_seed: Hash,
    creator_refund_spk: Vec<u8>,
    counter: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS, "total_tickets out of bounds");
    assert!(counter <= i64::MAX as u64, "counter exceeds i64::MAX");

    let prefix = build_draw_ready_prefix(
        &round_id,
        ticket_price,
        total_tickets,
        &ticket_root,
        &target_hash,
        &random_seed,
        &creator_refund_spk,
    );

    let mut counter_push = vec![0x08];
    counter_push.extend_from_slice(&counter.to_le_bytes());

    let suffix = build_complete_draw_ready_suffix(
        total_tickets,
        creator_refund_spk.len(),
    );

    let mut full_script = Vec::new();
    full_script.extend_from_slice(&prefix);
    full_script.extend_from_slice(&counter_push);
    full_script.extend_from_slice(&suffix);
    Ok(full_script)
}

/// Returns the exact canonical suffix length for a given total_tickets and creator_refund_spk_len.
pub fn canonical_suffix_len(total_tickets: u64, creator_refund_spk_len: usize) -> usize {
    build_complete_draw_ready_suffix(total_tickets, creator_refund_spk_len).len()
}

/// Builds complete suffix with strict fixed-point convergence enforcement.
pub fn build_complete_draw_ready_suffix(
    total_tickets: u64,
    creator_refund_spk_len: usize,
) -> Vec<u8> {
    let mut current_len = 0;
    for _ in 0..16 {
        let compiled = compile_suffix_body(
            total_tickets,
            creator_refund_spk_len,
            current_len,
        );
        if compiled.len() == current_len {
            return compiled;
        }
        current_len = compiled.len();
    }
    panic!("Strict fixed point failed to converge for total_tickets = {}", total_tickets);
}

fn compile_suffix_body(
    total_tickets: u64,
    creator_refund_spk_len: usize,
    suffix_len: usize,
) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    // At entry of suffix, the stack has:
    // [round_id, ticket_price, total_tickets_bytes, ticket_root, target_hash, random_seed, creator_refund_spk, counter_bytes]
    //
    // STEP 1: Compute candidate_hash
    sb.add_op(OpDup).unwrap(); // [..., counter_bytes, counter_bytes]
    sb.add_i64(3).unwrap();
    sb.add_op(OpPick).unwrap(); // [..., counter_bytes, counter_bytes, random_seed]
    sb.add_data(b"KaswinWinnerCandidateV1").unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(b"").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // [..., counter_bytes, candidate_hash (32B)]

    // STEP 2: Extract candidate_num = LE_U56(candidate_hash[0..7])
    sb.add_i64(0).unwrap();
    sb.add_i64(7).unwrap();
    sb.add_op(OpSubstr).unwrap(); // [..., counter_bytes, cand_bytes (7B)]
    sb.add_data(&[0x00]).unwrap();
    sb.add_op(OpCat).unwrap(); // [..., counter_bytes, cand_bytes_8 (8B LE, MSB=0)]
    sb.add_op(OpBin2Num).unwrap(); // [..., counter_bytes, candidate_num (i64)]

    // STEP 3: Rejection Threshold Computation
    let n = total_tickets as i64;
    let r = DOMAIN_R_56;
    let q = r / n;
    let limit = q * n;

    sb.add_op(OpDup).unwrap();
    sb.add_i64(limit).unwrap();
    sb.add_op(OpLessThan).unwrap();
    // Stack: [round_id, ticket_price, total_tickets_bytes, ticket_root, target_hash, random_seed, creator_refund_spk, counter_bytes, candidate_num, is_accepted]

    sb.add_op(OpIf).unwrap();
        // =========================================================
        // ACCEPT PATH: Transition to WINNER_READY
        // =========================================================
        sb.add_i64(n).unwrap();
        sb.add_op(OpMod).unwrap(); // [..., creator_refund_spk, counter_bytes, winner_index]
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpDrop).unwrap(); // drop counter_bytes -> [..., creator_refund_spk, winner_index]

        // Format push winner_index: 8 bytes LE via OpNum2Bin
        sb.add_i64(8).unwrap();
        sb.add_op(OpNum2Bin).unwrap();
        sb.add_data(&[0x08]).unwrap();
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpCat).unwrap(); // [..., creator_refund_spk, push_winner_index_8B]

        // Dynamic construction of production WINNER_READY Redeem Script from current prefix:
        let wr_suffix_bytes = self::winner_ready_settlement::build_winner_ready_settlement_suffix();

        // Slice prefix from current input signature script:
        sb.add_op(Op0).unwrap();
        sb.add_op(OpTxInputScriptSigLen).unwrap(); // [..., push_winner_index, sig_len]

        let prefix_len = draw_ready_prefix_len(creator_refund_spk_len);
        let total_redeem_len = (prefix_len + COUNTER_PUSH_LEN + suffix_len) as i64;
        sb.add_op(OpDup).unwrap();
        sb.add_i64(total_redeem_len).unwrap();
        sb.add_op(OpSub).unwrap(); // [..., push_winner_index, sig_len, p_start]

        sb.add_op(OpDup).unwrap();
        sb.add_i64(prefix_len as i64).unwrap();
        sb.add_op(OpAdd).unwrap(); // [..., push_winner_index, sig_len, p_start, p_end]

        sb.add_i64(0).unwrap();
        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpTxInputScriptSigSubstr).unwrap(); // [..., push_winner_index, sig_len, prefix_bytes]

        // Concatenate prefix || push_winner_index:
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpDrop).unwrap(); // drop sig_len -> [..., push_winner_index, prefix_bytes]
        sb.add_i64(1).unwrap();
        sb.add_op(OpRoll).unwrap(); // [..., prefix_bytes, push_winner_index]
        sb.add_op(OpCat).unwrap();  // [..., prefix || push_winner_index]

        // Concatenate production settlement suffix in <= 520B chunks:
        for chunk in wr_suffix_bytes.chunks(500) {
            sb.add_data(chunk).unwrap();
            sb.add_op(OpCat).unwrap();
        }
        // Stack: [round_id, ticket_price, total_tickets_bytes, ticket_root, target_hash, random_seed, creator_refund_spk, winner_ready_redeem_script]

        // Drop the 7 state items below winner_ready_redeem_script:
        for i in (1..=7).rev() {
            sb.add_i64(i).unwrap();
            sb.add_op(OpRoll).unwrap();
            sb.add_op(OpDrop).unwrap();
        }
        // Stack: [winner_ready_redeem_script]

        // Compute expected P2SH SPK bytes:
        sb.add_data(b"").unwrap();
        sb.add_op(OpBlake2bWithKey).unwrap();
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20]).unwrap();
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpCat).unwrap();
        sb.add_data(&[0x87]).unwrap();
        sb.add_op(OpCat).unwrap(); // Stack: [expected_winner_ready_spk]

    sb.add_op(OpElse).unwrap();
        // =========================================================
        // REJECT PATH: Shared Canonical Self-Replication
        // =========================================================
        sb.add_op(OpDrop).unwrap(); // drop candidate_num
        append_canonical_reject_successor_bytecode(&mut sb, creator_refund_spk_len, suffix_len);

    sb.add_op(OpEndIf).unwrap();

    // Stack: [expected_successor_spk]
    // STEP 4: Assert Successor SPK and Principal Conservation
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Assert exact pool amount equality: OpTxOutputAmount(0) == OpTxInputAmount(0)
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputAmount).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Enforce Singleton Continuation Lineage Guard:
    self::lineage::append_kaswin_singleton_continuation_guard(&mut sb).unwrap();

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

/// Canonical formatted WINNER_READY redeem script that matches the on-the-fly construction
pub fn build_canonical_winner_ready_redeem_script(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: Hash,
    target_hash: Hash,
    random_seed: Hash,
    creator_refund_spk: Vec<u8>,
    winner_index: u64,
) -> Vec<u8> {
    self::winner_ready_settlement::build_production_winner_ready_covenant(
        round_id,
        ticket_price,
        total_tickets,
        ticket_root,
        target_hash,
        random_seed,
        creator_refund_spk,
        winner_index,
    ).unwrap()
}
