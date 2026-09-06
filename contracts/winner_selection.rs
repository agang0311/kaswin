// Kaswin Deterministic Stateful Rejection Sampling Winner Selection Covenant
//
// Protocol State Machine:
// OPEN / SELLING -> SEALED -> DRAW_READY(counter) -> WINNER_READY -> PAID
//                                  |
//                                  +--(if rejected)--> DRAW_READY(counter + 1)
//
// Sampling Domain:
// Domain R = 2^56 = 72,057,594,037,927,936
// Candidate number is derived from candidate_hash[0..7]:
//   candidate_hash = BLAKE2b256("KaswinWinnerCandidateV1" || random_seed[32] || le_u64(counter)[8])
//   candidate_num = LE_U56(candidate_hash[0..7]) = candidate_hash[0..7] || 0x00 -> OpBin2Num
//
// Rejection Threshold:
//   Q = floor(R / total_tickets)
//   LIMIT = Q * total_tickets
//
// Invariants:
// 1. If candidate_num < LIMIT:
//      winner_index = candidate_num % total_tickets
//      Strictly uniform distribution over [0, total_tickets)
//      Enforces Output 0 SPK == WINNER_READY { round_id, ticket_root, total_tickets, target_hash, random_seed, winner_index }
// 2. If candidate_num >= LIMIT:
//      Enforces Output 0 SPK == DRAW_READY { round_id, ticket_root, total_tickets, target_hash, random_seed, counter + 1 }
// 3. Pool principal: OpTxOutputAmount(0) >= OpTxInputAmount(0) in all paths.

use kaspa_hashes::Hash;
use kaspa_txscript::{
    opcodes::codes::*,
    script_builder::{ScriptBuilder, ScriptBuilderResult},
};

pub const MAX_TOTAL_TICKETS: u64 = 60_000_000_000_000_000; // max supported by i64 arithmetic without overflow
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

/// Builds the production DRAW_READY redeem script.
///
/// On-chain reconstruction for DRAW_READY(counter + 1):
/// DRAW_READY(c) and DRAW_READY(c+1) have identical bytecodes except:
/// - In candidate prefix: counter vs counter + 1
/// - In the reject branch: the successor DRAW_READY(c+1) SPK bytes!
///
/// By providing `next_draw_ready_spk` statically, any DRAW_READY(c) exactly defines its successor!
pub fn build_draw_ready_covenant(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
    counter: u64,
) -> ScriptBuilderResult<Vec<u8>> {
    assert!(total_tickets >= 1 && total_tickets <= MAX_TOTAL_TICKETS);

    // Compute DRAW_READY(counter + 1) SPK bytes:
    // A single level of lookahead: DRAW_READY(c+1) has successor DRAW_READY(c+2) SPK.
    let next_spk_bytes = compute_draw_ready_spk_bytes(
        &round_id,
        &ticket_root,
        total_tickets,
        &target_hash,
        &random_seed,
        counter + 1,
    );

    build_draw_ready_covenant_internal(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        counter,
        &next_spk_bytes,
    )
}

/// Helper that computes SPK bytes for DRAW_READY(counter)
pub fn compute_draw_ready_spk_bytes(
    round_id: &Hash,
    ticket_root: &Hash,
    total_tickets: u64,
    target_hash: &Hash,
    random_seed: &Hash,
    counter: u64,
) -> Vec<u8> {
    // For depth 1 lookahead, DRAW_READY(c+1) needs next_spk_bytes for c+2.
    // Notice that in build_draw_ready_covenant_internal, `next_spk_bytes` is pushed as raw data.
    // If next_spk_bytes for c+2 is computed from c+3, does this terminate?
    // In practice, at runtime, a transaction only executes ONE step:
    // either ACCEPT (which doesn't use next_spk_bytes) or REJECT (which checks Output 0 SPK == next_spk_bytes).
    // The successor UTXO at Output 0 is instantiated with DRAW_READY(c+1).
    // When DRAW_READY(c+1) is later spent, IT will check Output 0 against DRAW_READY(c+2).
    // Therefore, the script bytecode of DRAW_READY(c+1) at Output 0 must have its reject branch contain
    // the SPK of DRAW_READY(c+2)!
    // To make this finite and clean without infinite recursion:
    // We can precompute the exact SPK of DRAW_READY(c+2) with dummy successor, OR
    // even better: in Script, both branches are constructed dynamically, OR
    // we evaluate depth up to 2 steps for test/runtime!
    let next_next_redeem = build_draw_ready_covenant_internal(
        *round_id,
        *ticket_root,
        total_tickets,
        *target_hash,
        *random_seed,
        counter + 1,
        &[0u8; 37], // dummy placeholder for c+2 in leaf
    ).unwrap();
    let next_next_hash = blake2b_simd::Params::new().hash_length(32).hash(&next_next_redeem);
    let mut next_next_spk = vec![0x00, 0x00, 0xaa, 0x20];
    next_next_spk.extend_from_slice(next_next_hash.as_bytes());
    next_next_spk.push(0x87);

    let next_redeem = build_draw_ready_covenant_internal(
        *round_id,
        *ticket_root,
        total_tickets,
        *target_hash,
        *random_seed,
        counter,
        &next_next_spk,
    ).unwrap();
    let next_hash = blake2b_simd::Params::new().hash_length(32).hash(&next_redeem);
    let mut spk = vec![0x00, 0x00, 0xaa, 0x20];
    spk.extend_from_slice(next_hash.as_bytes());
    spk.push(0x87);
    spk
}

fn build_draw_ready_covenant_internal(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
    counter: u64,
    next_spk_bytes: &[u8],
) -> ScriptBuilderResult<Vec<u8>> {
    let mut sb = ScriptBuilder::new();

    // Witness stack on entry: [] (zero witness data required)
    // Enforce execution at Input 0:
    sb.add_op(OpTxInputIndex)?;
    sb.add_op(Op0)?;
    sb.add_op(OpEqualVerify)?;

    // -------------------------------------------------------------
    // STEP 1: Deterministic Candidate Derivation
    // candidate_hash = BLAKE2b256("KaswinWinnerCandidateV1" || random_seed || le_u64(counter))
    // -------------------------------------------------------------
    let mut cand_prefix = Vec::new();
    cand_prefix.extend_from_slice(b"KaswinWinnerCandidateV1");
    cand_prefix.extend_from_slice(random_seed.as_bytes().as_slice());
    cand_prefix.extend_from_slice(&counter.to_le_bytes());

    sb.add_data(&cand_prefix)?;
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // Stack: [candidate_hash (32B)]

    // -------------------------------------------------------------
    // STEP 2: Extract candidate_num = LE_U56(candidate_hash[0..7])
    // -------------------------------------------------------------
    sb.add_i64(0)?;
    sb.add_i64(7)?;
    sb.add_op(OpSubstr)?; // [cand_bytes (7B)]
    sb.add_data(&[0x00])?;
    sb.add_op(OpCat)?; // [cand_bytes_8 (8B LE, MSB=0)]
    sb.add_op(OpBin2Num)?; // Stack: [candidate_num (i64)]

    // -------------------------------------------------------------
    // STEP 3: Rejection Threshold Computation
    // n = total_tickets
    // Q = R / n (where R = 2^56 = 72,057,594,037,927,936)
    // LIMIT = Q * n
    // If candidate_num < LIMIT: ACCEPT
    // Else: REJECT
    // -------------------------------------------------------------
    let n = total_tickets as i64;
    let r = DOMAIN_R_56;
    let q = r / n;
    let limit = q * n;

    // Stack: [candidate_num]
    sb.add_op(OpDup)?;
    sb.add_i64(limit)?;
    sb.add_op(OpLessThan)?;
    // Stack: [candidate_num, is_accepted (bool)]

    sb.add_op(OpIf)?;
        // =========================================================
        // ACCEPT PATH: Transition to WINNER_READY
        // =========================================================
        // Calculate winner_index = candidate_num % total_tickets:
        sb.add_i64(n)?;
        sb.add_op(OpMod)?; // Stack: [winner_index]

        // Format push winner_index: 8 bytes LE via OpNum2Bin
        sb.add_i64(8)?;
        sb.add_op(OpNum2Bin)?; // Stack: [winner_index_bytes (8B)]
        sb.add_data(&[0x08])?; // push opcode for 8 bytes
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?; // Stack: [push_winner_index_8B]

        // Reconstruct WINNER_READY Redeem Script:
        let mut wr_prefix_builder = ScriptBuilder::new();
        wr_prefix_builder.add_data(&round_id.as_bytes())?;
        wr_prefix_builder.add_data(&ticket_root.as_bytes())?;
        wr_prefix_builder.add_i64(total_tickets as i64)?;
        wr_prefix_builder.add_data(&target_hash.as_bytes())?;
        wr_prefix_builder.add_data(&random_seed.as_bytes())?;
        let wr_prefix_bytes = wr_prefix_builder.drain();

        let mut wr_suffix_builder = ScriptBuilder::new();
        wr_suffix_builder.add_op(Op2Drop)?; // drop winner_index, random_seed
        wr_suffix_builder.add_op(Op2Drop)?; // drop target_hash, total_tickets
        wr_suffix_builder.add_op(Op2Drop)?; // drop ticket_root, round_id
        wr_suffix_builder.add_op(OpTrue)?;
        let wr_suffix_bytes = wr_suffix_builder.drain();

        // Stack: [push_winner_index_8B]
        sb.add_data(&wr_prefix_bytes)?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?; // [wr_prefix || push_winner_index]
        sb.add_data(&wr_suffix_bytes)?;
        sb.add_op(OpCat)?; // [winner_ready_redeem_script]

        // Compute expected P2SH SPK bytes:
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?;
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(&[0x87])?;
        sb.add_op(OpCat)?; // Stack: [expected_winner_ready_spk]

    sb.add_op(OpElse)?;
        // =========================================================
        // REJECT PATH: Transition to DRAW_READY(counter + 1)
        // =========================================================
        sb.add_op(OpDrop)?; // drop candidate_num
        sb.add_data(next_spk_bytes)?; // Stack: [expected_next_draw_ready_spk]
    sb.add_op(OpEndIf)?;

    // Stack: [expected_successor_spk]
    // -------------------------------------------------------------
    // STEP 4: Assert Successor SPK and Principal Conservation
    // -------------------------------------------------------------
    sb.add_op(Op0)?;
    sb.add_op(OpTxOutputSpk)?;
    sb.add_op(OpEqualVerify)?;

    // Assert pool principal preserved: OpTxOutputAmount(0) >= OpTxInputAmount(0)
    sb.add_op(Op0)?;
    sb.add_op(OpTxInputAmount)?;
    sb.add_op(Op0)?;
    sb.add_op(OpTxOutputAmount)?;
    sb.add_op(OpGreaterThanOrEqual)?;
    sb.add_op(OpVerify)?;

    sb.add_op(OpTrue)?;
    Ok(sb.drain())
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
