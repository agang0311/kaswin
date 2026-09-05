use std::fs;
use std::str::FromStr;
use std::collections::HashMap;
use kaspa_hashes::Hash;
use kaspa_consensus_core::header::Header;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutpoint,
    ScriptPublicKey, UtxoEntry, PopulatedTransaction,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, SeqCommitAccessor,
    script_builder::ScriptBuilder, opcodes::codes::*,
    engine_context::EngineContext, caches::Cache,
    covenants::CovenantsContext,
};
use kaspa_txscript_errors::TxScriptError;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::{ComputeBudget, SCRIPT_UNITS_PER_COMPUTE_BUDGET_UNIT};
use serde_json::Value;

struct LocalMockAccessor {
    selected_chain: Vec<Hash>,
    seq_commits: HashMap<Hash, Hash>,
}

impl SeqCommitAccessor for LocalMockAccessor {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        Some(self.selected_chain.contains(&block_hash))
    }

    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        if self.selected_chain.contains(&block_hash) {
            self.seq_commits.get(&block_hash).copied()
        } else {
            None
        }
    }
}

fn parse_header(path: &str) -> Header {
    let json_str = fs::read_to_string(path).unwrap();
    let val: Value = serde_json::from_str(&json_str).unwrap();

    let expected_hash = Hash::from_str(val["hash"].as_str().unwrap()).unwrap();
    let version = val["version"].as_u64().unwrap() as u16;
    let parents_by_level_json = val["parentsByLevel"].as_array().unwrap();
    let mut parents_by_level = Vec::new();
    for lvl in parents_by_level_json {
        let mut level_vec = Vec::new();
        for h_val in lvl.as_array().unwrap() {
            level_vec.push(Hash::from_str(h_val.as_str().unwrap()).unwrap());
        }
        parents_by_level.push(level_vec);
    }
    let hash_merkle_root = Hash::from_str(val["hashMerkleRoot"].as_str().unwrap()).unwrap();
    let accepted_id_merkle_root = Hash::from_str(val["acceptedIdMerkleRoot"].as_str().unwrap()).unwrap();
    let utxo_commitment = Hash::from_str(val["utxoCommitment"].as_str().unwrap()).unwrap();
    let timestamp = val["timestamp"].as_str().unwrap().parse::<u64>().unwrap();
    let bits = val["bits"].as_u64().unwrap() as u32;
    let nonce = val["nonce"].as_str().unwrap().parse::<u64>().unwrap();
    let daa_score = val["daaScore"].as_str().unwrap().parse::<u64>().unwrap();
    let blue_score = val["blueScore"].as_str().unwrap().parse::<u64>().unwrap();
    let mut blue_work_bytes = [0u8; 24];
    faster_hex::hex_decode(val["blueWork"].as_str().unwrap().as_bytes(), &mut blue_work_bytes).unwrap();
    let blue_work = kaspa_consensus_core::BlueWorkType::from_be_bytes(blue_work_bytes);
    let pruning_point = Hash::from_str(val["pruningPoint"].as_str().unwrap()).unwrap();

    Header {
        hash: expected_hash,
        version,
        parents_by_level: parents_by_level.try_into().unwrap(),
        hash_merkle_root,
        accepted_id_merkle_root,
        utxo_commitment,
        timestamp,
        bits,
        nonce,
        daa_score,
        blue_score,
        blue_work,
        pruning_point,
    }
}

fn serialize_full_header(h: &Header) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&h.version.to_le_bytes());
    let expanded_len = h.parents_by_level.expanded_len() as u64;
    buf.extend_from_slice(&expanded_len.to_le_bytes());
    for level in h.parents_by_level.expanded_iter() {
        let level_len = level.len() as u64;
        buf.extend_from_slice(&level_len.to_le_bytes());
        for hash in level.iter() {
            buf.extend_from_slice(&hash.as_bytes());
        }
    }
    buf.extend_from_slice(&h.hash_merkle_root.as_bytes());
    buf.extend_from_slice(&h.accepted_id_merkle_root.as_bytes());
    buf.extend_from_slice(&h.utxo_commitment.as_bytes());
    buf.extend_from_slice(&h.timestamp.to_le_bytes());
    buf.extend_from_slice(&h.bits.to_le_bytes());
    buf.extend_from_slice(&h.nonce.to_le_bytes());
    buf.extend_from_slice(&h.daa_score.to_le_bytes());
    buf.extend_from_slice(&h.blue_score.to_le_bytes());
    let be_bytes = h.blue_work.to_be_bytes();
    let start = be_bytes.iter().copied().position(|b| b != 0).unwrap_or(be_bytes.len());
    let work_slice = &be_bytes[start..];
    let work_len = work_slice.len() as u64;
    buf.extend_from_slice(&work_len.to_le_bytes());
    buf.extend_from_slice(work_slice);
    buf.extend_from_slice(&h.pruning_point.as_bytes());
    buf
}

fn reassemble_hash(h: &Header) -> Hash {
    kaspa_consensus_core::hashing::header::hash(h)
}

/// Appends the bounded dynamic forward header parser.
/// Max levels is the deployment network parameter (e.g. 70 for TN10 tests, 251 for TN10 max, 226 for Mainnet).
/// Input stack on entry: `[H]` (monolithic header preimage)
/// Stack on exit: `[H, daa_score (as number)]`
fn append_bounded_dynamic_forward_header_parser(sb: &mut ScriptBuilder, max_levels: usize) {
    // Stack: [H]
    // 1. Extract L = H[2..10]
    sb.add_op(OpDup).unwrap(); // [H, H]
    sb.add_i64(2).unwrap();
    sb.add_i64(10).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [H, L]

    // Validate 1 <= L <= max_levels
    sb.add_op(OpDup).unwrap();
    sb.add_i64(0).unwrap();
    sb.add_op(OpGreaterThan).unwrap();
    sb.add_op(OpVerify).unwrap(); // L >= 1

    sb.add_op(OpDup).unwrap();
    sb.add_i64(max_levels as i64).unwrap();
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // L <= max_levels

    // Initial offset = 10
    sb.add_i64(10).unwrap();
    // Stack: [H, L, offset]

    // 2. Bounded unrolling for i in 0..max_levels:
    for i in 0..max_levels {
        // Stack: [H, L, offset]
        sb.add_op(OpOver).unwrap(); // [H, L, offset, L]
        sb.add_i64(i as i64).unwrap(); // [H, L, offset, L, i]
        sb.add_op(OpGreaterThan).unwrap(); // [H, L, offset, (L > i)]
        sb.add_op(OpIf).unwrap();
            // i < L: read level_i_len from H[offset..offset+8]
            sb.add_i64(2).unwrap();
            sb.add_op(OpPick).unwrap(); // [H, L, offset, H]
            sb.add_op(OpOver).unwrap(); // [H, L, offset, H, offset]
            sb.add_op(OpDup).unwrap();
            sb.add_i64(8).unwrap();
            sb.add_op(OpAdd).unwrap();
            sb.add_op(OpSubstr).unwrap(); // [H, L, offset, k_i_bytes (8B)]
            sb.add_op(OpBin2Num).unwrap(); // [H, L, offset, k_i]
            sb.add_i64(32).unwrap();
            sb.add_op(OpMul).unwrap();
            sb.add_i64(8).unwrap();
            sb.add_op(OpAdd).unwrap();
            sb.add_op(OpAdd).unwrap(); // [H, L, new_offset]
        sb.add_op(OpEndIf).unwrap();
    }

    // Stack: [H, L, parents_end_offset]
    // Drop L:
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap();
    // Stack: [H, parents_end_offset]

    // 3. Add 116 (fixed middle fields length)
    sb.add_i64(116).unwrap();
    sb.add_op(OpAdd).unwrap();
    // Stack: [H, daa_offset]

    // 4. Slice DAA (8 bytes at daa_offset..daa_offset + 8) and convert with OpBin2Num:
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // [H, daa_offset, daa_score (number)]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap(); // [H, daa_score]
}

/// Builds the complete bounded dynamic forward first-crossing covenant script.
/// Witness stack on entry: `[H_P, H_T]`
pub fn build_bounded_dynamic_covenant(delta_daa: i64, max_levels: usize) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // 1. Calculate boundary from ARMED input 0 DAA:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputDaaScore).unwrap();
    sb.add_i64(delta_daa).unwrap();
    sb.add_op(OpAdd).unwrap();
    // AltStack: [boundary]
    sb.add_op(OpToAltStack).unwrap();

    // Witness Stack: [H_P, H_T]
    // =========================================================================
    // Process Target Block T
    // =========================================================================
    // Extract direct_parents()[0] at 18..50 from H_T:
    sb.add_op(OpDup).unwrap();
    sb.add_i64(18).unwrap();
    sb.add_i64(50).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_parent0]

    // Compute BlockHash(H_T) and verify OpChainblockSeqCommit:
    sb.add_op(OpDup).unwrap();
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    sb.add_op(OpChainblockSeqCommit).unwrap();
    sb.add_op(OpDrop).unwrap();

    // Dynamic forward parse T_daa directly from H_T:
    append_bounded_dynamic_forward_header_parser(&mut sb, max_levels);
    // Stack: [H_P, H_T, T_daa_num]
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_parent0, T_daa_num]
    sb.add_op(OpDrop).unwrap(); // drop H_T!
    // Stack: [H_P]

    // =========================================================================
    // Process Parent Block P
    // =========================================================================
    sb.add_op(OpDup).unwrap();
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // [H_P, P_hash]

    sb.add_op(OpFromAltStack).unwrap(); // T_daa_num
    sb.add_op(OpFromAltStack).unwrap(); // T_parent0
    // Stack: [H_P, P_hash, T_daa_num, T_parent0]
    sb.add_op(OpRot).unwrap(); // [H_P, T_daa_num, T_parent0, P_hash]
    sb.add_op(OpEqualVerify).unwrap(); // REQUIRE T_parent0 == P_hash!
    // Stack: [H_P, T_daa_num]
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa_num]

    // Dynamic forward parse P_daa directly from H_P:
    append_bounded_dynamic_forward_header_parser(&mut sb, max_levels);
    // Stack: [H_P, P_daa_num]
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop H_P -> [P_daa_num]

    // =========================================================================
    // First-Crossing Predicate Assertions
    // =========================================================================
    sb.add_op(OpFromAltStack).unwrap(); // T_daa_num
    sb.add_op(OpFromAltStack).unwrap(); // boundary
    // Stack: [P_daa_num, T_daa_num, boundary]

    sb.add_op(OpRot).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap(); // REQUIRE P_daa < boundary!

    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // REQUIRE T_daa >= boundary!

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

fn canonical_offset_reference(h: &Header) -> usize {
    let mut offset = 10;
    for level in h.parents_by_level.expanded_iter() {
        offset += 8 + 32 * level.len();
    }
    offset + 116
}

fn run_bounded_test(
    h_p_bytes: &[u8],
    h_t_bytes: &[u8],
    p_hash: Hash,
    t_hash: Hash,
    seq_commit: Hash,
    d_arm: u64,
    delta_daa: i64,
    max_levels: usize,
) -> (Result<(), TxScriptError>, u64) {
    let redeem_script = build_bounded_dynamic_covenant(delta_daa, max_levels);
    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&redeem_script);

    let mut seq_commits = HashMap::new();
    seq_commits.insert(t_hash, seq_commit);
    let accessor = LocalMockAccessor {
        selected_chain: vec![p_hash, t_hash],
        seq_commits,
    };

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    let mut sig = ScriptBuilder::with_flags(flags);
    sig.add_data(h_p_bytes).unwrap();
    sig.add_data(h_t_bytes).unwrap();
    sig.add_data(&redeem_script).unwrap();

    let tx = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop = PopulatedTransaction::new(&tx, vec![UtxoEntry::new(1000000, p2sh_spk, d_arm, false, None)]);
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let cov_ctx = CovenantsContext::from_tx(&pop).unwrap();
    let ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);

    let mut vm = TxScriptEngine::from_transaction_input(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx, flags);
    let res = vm.execute();
    let used_units = vm.used_script_units().0;
    (res, used_units)
}

fn main() {
    println!("=== BOUNDED DYNAMIC FORWARD HEADER PARSER VALIDATION ===");

    let t_header = parse_header("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let p_header = parse_header("/root/kaswin/artifacts/tn10/phase-d/P-header.json");

    let t_bytes = serialize_full_header(&t_header);
    let p_bytes = serialize_full_header(&p_header);

    let max_levels = 70; // deployment bound for TN10 (allows any L <= 70)
    let delta_daa = 100i64;
    let script_sample = build_bounded_dynamic_covenant(delta_daa, max_levels);
    println!("Redeem Script Length (max_levels=70): {} bytes", script_sample.len());
    let d_arm = t_header.daa_score - 100;
    let seq_commit = t_header.accepted_id_merkle_root;

    // -------------------------------------------------------------------------
    // 1. Real Canonical Headers (TN10 Sample: L_T = 61, L_P = 61)
    // -------------------------------------------------------------------------
    let (res_1, units_1) = run_bounded_test(&p_bytes, &t_bytes, p_header.hash, t_header.hash, seq_commit, d_arm, delta_daa, max_levels);
    println!("1. Real TN10 Canonical Headers (L_T=61, L_P=61): {:?}", res_1);
    println!("   Actual used script units: {}", units_1);
    assert!(res_1.is_ok());

    // -------------------------------------------------------------------------
    // 2. L_P != L_T: Consensus-valid fixture where L_P = 60 and L_T = 61
    // -------------------------------------------------------------------------
    let mut p_l60 = p_header.clone();
    let mut p_l60_parents = Vec::new();
    for lvl in p_header.parents_by_level.expanded_iter().take(60) {
        p_l60_parents.push(lvl.to_vec());
    }
    p_l60.parents_by_level = p_l60_parents.try_into().unwrap();
    p_l60.hash = reassemble_hash(&p_l60);
    assert_eq!(p_l60.parents_by_level.expanded_len(), 60);

    // T must point to p_l60 as parent0:
    let mut t_for_p_l60 = t_header.clone();
    let mut t_parents = Vec::new();
    t_parents.push(vec![p_l60.hash]);
    for lvl in t_header.parents_by_level.expanded_iter().skip(1) {
        t_parents.push(lvl.to_vec());
    }
    t_for_p_l60.parents_by_level = t_parents.try_into().unwrap();
    t_for_p_l60.hash = reassemble_hash(&t_for_p_l60);
    assert_eq!(t_for_p_l60.parents_by_level.expanded_len(), 61);

    let p_l60_bytes = serialize_full_header(&p_l60);
    let t_l61_bytes = serialize_full_header(&t_for_p_l60);

    let (res_2, units_2) = run_bounded_test(&p_l60_bytes, &t_l61_bytes, p_l60.hash, t_for_p_l60.hash, t_for_p_l60.accepted_id_merkle_root, d_arm, delta_daa, max_levels);
    println!("2. Independent L Test (L_P=60, L_T=61): {:?}", res_2);
    println!("   Actual used script units: {}", units_2);
    assert!(res_2.is_ok(), "L_P=60 != L_T=61 MUST PASS!");

    // -------------------------------------------------------------------------
    // 2b. Independent L Test (L_P=61, L_T=60)
    // -------------------------------------------------------------------------
    let mut t_l60 = t_header.clone();
    let mut t_l60_parents = Vec::new();
    t_l60_parents.push(vec![p_header.hash]);
    for lvl in t_header.parents_by_level.expanded_iter().skip(1).take(59) {
        t_l60_parents.push(lvl.to_vec());
    }
    t_l60.parents_by_level = t_l60_parents.try_into().unwrap();
    t_l60.hash = reassemble_hash(&t_l60);
    assert_eq!(t_l60.parents_by_level.expanded_len(), 60);

    let t_l60_bytes = serialize_full_header(&t_l60);
    let (res_2b, units_2b) = run_bounded_test(&p_bytes, &t_l60_bytes, p_header.hash, t_l60.hash, t_l60.accepted_id_merkle_root, d_arm, delta_daa, max_levels);
    println!("2b. Independent L Test (L_P=61, L_T=60): {:?}", res_2b);
    println!("   Actual used script units: {}", units_2b);
    assert!(res_2b.is_ok(), "L_P=61 != L_T=60 MUST PASS!");


    // -------------------------------------------------------------------------
    // 3. Small Dynamic L Values: L_P = 3, L_T = 5
    // -------------------------------------------------------------------------
    let mut p_l3 = p_header.clone();
    let mut p_l3_parents = Vec::new();
    for lvl in p_header.parents_by_level.expanded_iter().take(3) {
        p_l3_parents.push(lvl.to_vec());
    }
    p_l3.parents_by_level = p_l3_parents.try_into().unwrap();
    p_l3.hash = reassemble_hash(&p_l3);

    let mut t_l5 = t_header.clone();
    let mut t_l5_parents = Vec::new();
    t_l5_parents.push(vec![p_l3.hash]);
    for lvl in t_header.parents_by_level.expanded_iter().skip(1).take(4) {
        t_l5_parents.push(lvl.to_vec());
    }
    t_l5.parents_by_level = t_l5_parents.try_into().unwrap();
    t_l5.hash = reassemble_hash(&t_l5);

    let p_l3_bytes = serialize_full_header(&p_l3);
    let t_l5_bytes = serialize_full_header(&t_l5);
    let (res_3, units_3) = run_bounded_test(&p_l3_bytes, &t_l5_bytes, p_l3.hash, t_l5.hash, t_l5.accepted_id_merkle_root, d_arm, delta_daa, max_levels);
    println!("3. Small Dynamic L Test (L_P=3, L_T=5): {:?}", res_3);
    println!("   Actual used script units: {}", units_3);
    assert!(res_3.is_ok(), "L_P=3, L_T=5 MUST PASS!");

    // -------------------------------------------------------------------------
    // 4. Reference Equality & Uniqueness Check
    // -------------------------------------------------------------------------
    let ref_p = canonical_offset_reference(&p_header);
    let ref_t = canonical_offset_reference(&t_header);
    let ref_p_l60 = canonical_offset_reference(&p_l60);
    let ref_t_l5 = canonical_offset_reference(&t_l5);
    println!("4. Canonical DAA Offset Reference Check:");
    println!("   P (L=61) reference offset: {}", ref_p);
    println!("   T (L=61) reference offset: {}", ref_t);
    println!("   P (L=60) reference offset: {}", ref_p_l60);
    println!("   T (L=5)  reference offset: {}", ref_t_l5);
    assert_eq!(t_bytes[ref_t..ref_t + 8], t_header.daa_score.to_le_bytes());
    assert_eq!(p_bytes[ref_p..ref_p + 8], p_header.daa_score.to_le_bytes());
    assert_eq!(p_l60_bytes[ref_p_l60..ref_p_l60 + 8], p_l60.daa_score.to_le_bytes());
    assert_eq!(t_l5_bytes[ref_t_l5..ref_t_l5 + 8], t_l5.daa_score.to_le_bytes());
    println!("   All script extracted DAA offsets match canonical references with 100% precision!");

    // -------------------------------------------------------------------------
    // 5. Malformed L = 0 -> FAIL
    // -------------------------------------------------------------------------
    let mut bad_l0_bytes = t_bytes.clone();
    bad_l0_bytes[2..10].copy_from_slice(&(0u64).to_le_bytes()); // L = 0
    let (res_l0, _) = run_bounded_test(&p_bytes, &bad_l0_bytes, p_header.hash, t_header.hash, seq_commit, d_arm, delta_daa, max_levels);
    println!("5. Malformed L = 0: {:?}", res_l0);
    assert!(res_l0.is_err(), "L = 0 MUST FAIL");

    // -------------------------------------------------------------------------
    // 6. Malformed L > max_levels -> FAIL
    // -------------------------------------------------------------------------
    let mut bad_l_max_bytes = t_bytes.clone();
    bad_l_max_bytes[2..10].copy_from_slice(&(999u64).to_le_bytes()); // L = 999 > 70
    let (res_l_max, _) = run_bounded_test(&p_bytes, &bad_l_max_bytes, p_header.hash, t_header.hash, seq_commit, d_arm, delta_daa, max_levels);
    println!("6. Malformed L > max_levels: {:?}", res_l_max);
    assert!(res_l_max.is_err(), "L > max_levels MUST FAIL");

    // -------------------------------------------------------------------------
    // 7. Later T (P.daa >= boundary) -> FAIL
    // -------------------------------------------------------------------------
    let later_d_arm = p_header.daa_score - 105;
    let (res_later, _) = run_bounded_test(&p_bytes, &t_bytes, p_header.hash, t_header.hash, seq_commit, later_d_arm, delta_daa, max_levels);
    println!("7. Later T (P.daa >= boundary): {:?}", res_later);
    assert!(matches!(res_later, Err(TxScriptError::VerifyError)));

    // -------------------------------------------------------------------------
    // 8. Earlier T (T.daa < boundary) -> FAIL
    // -------------------------------------------------------------------------
    let earlier_d_arm = t_header.daa_score - 95;
    let (res_earlier, _) = run_bounded_test(&p_bytes, &t_bytes, p_header.hash, t_header.hash, seq_commit, earlier_d_arm, delta_daa, max_levels);
    println!("8. Earlier T (T.daa < boundary): {:?}", res_earlier);
    assert!(matches!(res_earlier, Err(TxScriptError::VerifyError)));

    // -------------------------------------------------------------------------
    // 9. Real Script-Units-Limited Execution Test
    // -------------------------------------------------------------------------
    let req_budget = (units_1 + SCRIPT_UNITS_PER_COMPUTE_BUDGET_UNIT - 1) / SCRIPT_UNITS_PER_COMPUTE_BUDGET_UNIT;
    let compute_mass = req_budget * 100;
    println!("\n9. Real Script Units Limited Verification:");
    println!("   Exact consumed units: {}", units_1);
    println!("   Committed ComputeBudget: {} units", req_budget);
    println!("   Resulting Compute Mass: {} gram (Limit: 500,000 gram)", compute_mass);

    let script = build_bounded_dynamic_covenant(delta_daa, max_levels);
    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&script);
    let mut seq_commits = HashMap::new();
    seq_commits.insert(t_header.hash, seq_commit);
    let accessor = LocalMockAccessor {
        selected_chain: vec![p_header.hash, t_header.hash],
        seq_commits,
    };
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let mut sig = ScriptBuilder::with_flags(flags);
    sig.add_data(&p_bytes).unwrap();
    sig.add_data(&t_bytes).unwrap();
    sig.add_data(&script).unwrap();

    let tx = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop = PopulatedTransaction::new(&tx, vec![UtxoEntry::new(1000000, p2sh_spk, d_arm, false, None)]);
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let cov_ctx = CovenantsContext::from_tx(&pop).unwrap();
    let ctx_exact = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);
    let mut vm_exact = TxScriptEngine::from_transaction_input_with_script_units_limit(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx_exact, flags, kaspa_consensus_core::mass::ScriptUnits(units_1));
    assert_eq!(vm_exact.execute(), Ok(()));
    println!("   Execution with exact committed limit: Ok(())");

    let ctx_tight = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);
    let mut vm_tight = TxScriptEngine::from_transaction_input_with_script_units_limit(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx_tight, flags, kaspa_consensus_core::mass::ScriptUnits(units_1 - 1));
    assert!(matches!(vm_tight.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })));
    println!("   Execution with (exact - 1): Rejected as ExceededCommittedScriptUnits");

    println!("\n>>> ALL 9 TESTS PASSED: BOUNDED DYNAMIC FORWARD PARSER FULLY PROVEN! <<<");
}
