// Kaswin Deterministic Stateful Rejection Sampling Winner Selection Covenant
//
// Protocol State Machine:
// OPEN / SELLING -> SEALED -> DRAW_READY(counter) -> WINNER_READY -> PAID
//                                  |
//                                  +--(if rejected)--> DRAW_READY(counter + 1)
//
// Truly Self-Replicating Successor Architecture:
// In the reject path, DRAW_READY(c) dynamically constructs the exact Redeem Script of DRAW_READY(c + 1)
// via script introspection (`OpTxInputScriptSigSubstr`), completely eliminating lookahead recursion,
// dummy leaves, or off-chain precomputed successor chains.

use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

pub const MAX_TOTAL_TICKETS: u64 = 100_000_000; // 100M tickets max strictly unified across protocol
pub const DOMAIN_R_56: i64 = 1i64 << 56; // 72,057,594,037,927,936

/// Pure Rust Reference Oracle for Winner Selection Step
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum WinnerStepResult {
    Accepted { winner_index: u64 },
    Rejected { next_counter: u64 },
}

/// Computes the candidate hash:
/// BLAKE2b256("KaswinWinnerCandidateV1" || random_seed[32] || le_u64(counter)[8])
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

/// Extracts candidate_num in domain [0, 2^56)
pub fn extract_candidate_num(candidate_hash: &Hash) -> i64 {
    let b = candidate_hash.as_bytes();
    let mut buf = [0u8; 8];
    buf[0..7].copy_from_slice(&b[0..7]);
    buf[7] = 0x00; // strictly non-negative
    i64::from_le_bytes(buf)
}

/// Rust reference oracle implementing rejection sampling
pub fn reference_winner_step(
    random_seed: &Hash,
    counter: u64,
    total_tickets: u64,
) -> WinnerStepResult {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS, "Invalid total_tickets");
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

/// Static Prefix before counter in DRAW_READY redeem script
pub fn build_draw_ready_prefix(
    round_id: &Hash,
    ticket_root: &Hash,
    total_tickets: u64,
    target_hash: &Hash,
    random_seed: &Hash,
) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    // Enforce execution at Input 0:
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Push state constants:
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_i64(total_tickets as i64).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    sb.drain()
}

/// Builds the production DRAW_READY redeem script.
pub fn build_draw_ready_covenant(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
    counter: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    build_draw_ready_covenant_internal(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        counter,
        false,
    )
}

/// Test-only branch fixture builder to verify rejection transition logic
/// without violating production MAX_TOTAL_TICKETS = 100_000_000
pub fn build_draw_ready_covenant_test_reject(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
    counter: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    build_draw_ready_covenant_internal(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        counter,
        true, // force reject path
    )
}

fn build_draw_ready_covenant_internal(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
    counter: u64,
    force_reject: bool,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);

    let prefix = build_draw_ready_prefix(&round_id, &ticket_root, total_tickets, &target_hash, &random_seed);
    let prefix_len = prefix.len();

    let mut counter_push = vec![0x08];
    counter_push.extend_from_slice(&counter.to_le_bytes());

    let suffix = build_complete_draw_ready_suffix(
        &round_id,
        &ticket_root,
        total_tickets,
        &target_hash,
        &random_seed,
        prefix_len,
        force_reject,
    );

    let mut full_script = Vec::new();
    full_script.extend_from_slice(&prefix);
    full_script.extend_from_slice(&counter_push);
    full_script.extend_from_slice(&suffix);
    Ok(full_script)
}

pub fn build_complete_draw_ready_suffix(
    round_id: &Hash,
    ticket_root: &Hash,
    total_tickets: u64,
    target_hash: &Hash,
    random_seed: &Hash,
    prefix_len: usize,
    force_reject: bool,
) -> Vec<u8> {
    // 3-pass convergence loop to guarantee exact suffix length:
    let mut current_len = 0;
    for _ in 0..5 {
        let compiled = compile_suffix_body(
            round_id,
            ticket_root,
            total_tickets,
            target_hash,
            random_seed,
            prefix_len,
            current_len,
            force_reject,
        );
        if compiled.len() == current_len {
            return compiled;
        }
        current_len = compiled.len();
    }
    compile_suffix_body(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        prefix_len,
        current_len,
        force_reject,
    )
}

fn compile_suffix_body(
    round_id: &Hash,
    ticket_root: &Hash,
    total_tickets: u64,
    target_hash: &Hash,
    random_seed: &Hash,
    prefix_len: usize,
    suffix_len: usize,
    force_reject: bool,
) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    // At entry of suffix, the stack has:
    // [round_id, ticket_root, total_tickets, target_hash, random_seed, counter_bytes]
    //
    // STEP 1: Compute candidate_hash
    sb.add_op(OpDup).unwrap(); // [..., random_seed, counter_bytes, counter_bytes]
    sb.add_i64(2).unwrap();
    sb.add_op(OpPick).unwrap(); // [..., random_seed, counter_bytes, counter_bytes, random_seed]
    sb.add_data(b"KaswinWinnerCandidateV1").unwrap(); // [..., counter_bytes, random_seed, prefix]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [..., counter_bytes, prefix || random_seed]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [..., prefix || random_seed || counter_bytes]
    sb.add_data(b"").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // Stack: [round_id, ticket_root, total_tickets, target_hash, random_seed, counter_bytes, candidate_hash (32B)]

    // STEP 2: Extract candidate_num = LE_U56(candidate_hash[0..7])
    sb.add_i64(0).unwrap();
    sb.add_i64(7).unwrap();
    sb.add_op(OpSubstr).unwrap(); // [..., counter_bytes, cand_bytes (7B)]
    sb.add_data(&[0x00]).unwrap();
    sb.add_op(OpCat).unwrap(); // [..., counter_bytes, cand_bytes_8 (8B LE, MSB=0)]
    sb.add_op(OpBin2Num).unwrap(); // Stack: [round_id, ticket_root, total_tickets, target_hash, random_seed, counter_bytes, candidate_num (i64)]

    // STEP 3: Rejection Threshold Computation
    let n = total_tickets as i64;
    let r = DOMAIN_R_56;
    let q = r / n;
    let limit = q * n;

    if force_reject {
        // Test-only branch fixture: inverts predicate to force rejection path on test seed
        sb.add_op(OpDup).unwrap();
        sb.add_i64(limit).unwrap();
        sb.add_op(OpGreaterThanOrEqual).unwrap();
    } else {
        sb.add_op(OpDup).unwrap();
        sb.add_i64(limit).unwrap();
        sb.add_op(OpLessThan).unwrap();
    }
    // Stack: [round_id, ticket_root, total_tickets, target_hash, random_seed, counter_bytes, candidate_num, is_accepted (bool)]

    sb.add_op(OpIf).unwrap();
        // =========================================================
        // ACCEPT PATH: Transition to WINNER_READY
        // =========================================================
        sb.add_i64(n).unwrap();
        sb.add_op(OpMod).unwrap(); // Stack: [round_id, ticket_root, total_tickets, target_hash, random_seed, counter_bytes, winner_index]
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpDrop).unwrap(); // drop counter_bytes -> Stack: [round_id, ticket_root, total_tickets, target_hash, random_seed, winner_index]

        // Format push winner_index: 8 bytes LE via OpNum2Bin
        sb.add_i64(8).unwrap();
        sb.add_op(OpNum2Bin).unwrap(); // Stack: [..., random_seed, winner_index_bytes (8B)]
        sb.add_data(&[0x08]).unwrap(); // push opcode for 8 bytes
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpCat).unwrap(); // Stack: [..., random_seed, push_winner_index_8B]

        // Dynamic construction of WINNER_READY Redeem Script from stack items:
        // [round_id (32B)] [ticket_root (32B)] [total_tickets (num)] [target_hash (32B)] [random_seed (32B)] [push_winner_index] [suffix]
        // Stack currently has:
        // [round_id, ticket_root, total_tickets, target_hash, random_seed, push_winner_index_8B]
        let mut wr_suffix_builder = ScriptBuilder::new();
        wr_suffix_builder.add_op(Op2Drop).unwrap(); // drop winner_index, random_seed
        wr_suffix_builder.add_op(Op2Drop).unwrap(); // drop target_hash, total_tickets
        wr_suffix_builder.add_op(Op2Drop).unwrap(); // drop ticket_root, round_id
        wr_suffix_builder.add_op(OpTrue).unwrap();
        let wr_suffix_bytes = wr_suffix_builder.drain();

        // Slice prefix from current input signature script!
        // SignatureScript has [push_header, prefix, counter_push, suffix]
        // prefix is identical in both DRAW_READY and WINNER_READY!
        // So we can extract prefix directly from OpTxInputScriptSigSubstr:
        sb.add_op(Op0).unwrap();
        sb.add_op(OpTxInputScriptSigLen).unwrap(); // [..., push_winner_index, sig_len]

        let total_redeem_len = (prefix_len + 9 + suffix_len) as i64;
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
        sb.add_data(&wr_suffix_bytes).unwrap();
        sb.add_op(OpCat).unwrap();  // [..., winner_ready_redeem_script]

        // Drop the 5 stack state items below winner_ready_redeem_script:
        sb.add_i64(5).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap();
        sb.add_i64(4).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap();
        sb.add_i64(3).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap();
        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap();
        sb.add_i64(1).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap(); // Stack: [winner_ready_redeem_script]

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
        // REJECT PATH: Self-Replication via Script Introspection
        // =========================================================
        // Stack at entry of else: [round_id, ticket_root, total_tickets, target_hash, random_seed, counter_bytes, candidate_num]
        sb.add_op(OpDrop).unwrap(); // drop candidate_num -> Stack: [round_id, ticket_root, total_tickets, target_hash, random_seed, counter_bytes]

        // Drop the 5 state items:
        sb.add_i64(5).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap(); // dropped round_id
        sb.add_i64(4).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap(); // dropped ticket_root
        sb.add_i64(3).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap(); // dropped total_tickets
        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap(); // dropped target_hash
        sb.add_i64(1).unwrap();
        sb.add_op(OpRoll).unwrap();
        sb.add_op(OpDrop).unwrap(); // dropped random_seed -> Stack: [counter_bytes]

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

        let total_redeem_len = (prefix_len + 9 + suffix_len) as i64;

        // Compute p_start = sig_len - total_redeem_len
        sb.add_op(OpDup).unwrap();
        sb.add_i64(total_redeem_len).unwrap();
        sb.add_op(OpSub).unwrap(); // Stack: [next_counter_push, sig_len, p_start]

        // Compute p_end = p_start + prefix_len
        sb.add_op(OpDup).unwrap();
        sb.add_i64(prefix_len as i64).unwrap();
        sb.add_op(OpAdd).unwrap(); // Stack: [next_counter_push, sig_len, p_start, p_end]

        // Slice prefix: from p_start to p_end
        sb.add_i64(0).unwrap();    // [next_counter_push, sig_len, p_start, p_end, 0]
        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap(); // [next_counter_push, sig_len, p_end, 0, p_start]
        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap(); // [next_counter_push, sig_len, 0, p_start, p_end]
        sb.add_op(OpTxInputScriptSigSubstr).unwrap(); // Stack: [next_counter_push, sig_len, prefix_bytes]

        // Concatenate prefix || next_counter_push:
        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap(); // [sig_len, prefix_bytes, next_counter_push]
        sb.add_op(OpCat).unwrap();  // Stack: [sig_len, prefix || next_counter_push]

        // Compute s_start = sig_len - suffix_len
        sb.add_op(OpSwap).unwrap(); // Stack: [prefix || next_counter_push, sig_len]
        sb.add_op(OpDup).unwrap();
        sb.add_i64(suffix_len as i64).unwrap();
        sb.add_op(OpSub).unwrap(); // Stack: [prefix || next_counter_push, sig_len, s_start]

        // Slice suffix: from s_start to sig_len (s_end)
        sb.add_i64(0).unwrap();    // [prefix || next_counter_push, sig_len, s_start, 0]
        sb.add_i64(1).unwrap();
        sb.add_op(OpRoll).unwrap(); // [prefix || next_counter_push, sig_len, 0, s_start]
        sb.add_i64(2).unwrap();
        sb.add_op(OpRoll).unwrap(); // [prefix || next_counter_push, 0, s_start, sig_len]
        sb.add_op(OpTxInputScriptSigSubstr).unwrap(); // Stack: [prefix || next_counter_push, suffix_bytes]

        // Form complete successor DRAW_READY(counter + 1) redeem script:
        sb.add_op(OpCat).unwrap(); // Stack: [successor_draw_ready_redeem_script]

        // Compute expected P2SH SPK bytes for successor:
        sb.add_data(b"").unwrap();
        sb.add_op(OpBlake2bWithKey).unwrap();
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20]).unwrap();
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpCat).unwrap();
        sb.add_data(&[0x87]).unwrap();
        sb.add_op(OpCat).unwrap(); // Stack: [expected_successor_draw_ready_spk]

    sb.add_op(OpEndIf).unwrap();

    // Stack: [expected_successor_spk]
    // STEP 4: Assert Successor SPK and Principal Conservation
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Assert pool principal preserved: OpTxOutputAmount(0) >= OpTxInputAmount(0)
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputAmount).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

/// Canonical formatted WINNER_READY redeem script that matches the on-the-fly construction
pub fn build_canonical_winner_ready_redeem_script(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
    winner_index: u64,
) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    // Enforce execution at Input 0:
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_i64(total_tickets as i64).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    // 8-byte minimal push for winner_index:
    let mut winner_sb = ScriptBuilder::new();
    winner_sb.add_data(&winner_index.to_le_bytes()).unwrap();
    let push_bytes = winner_sb.drain();
    sb.script_mut().extend_from_slice(&push_bytes);
    // Suffix:
    sb.add_op(Op2Drop).unwrap();
    sb.add_op(Op2Drop).unwrap();
    sb.add_op(Op2Drop).unwrap();
    sb.add_op(OpTrue).unwrap();
    sb.drain()
}
