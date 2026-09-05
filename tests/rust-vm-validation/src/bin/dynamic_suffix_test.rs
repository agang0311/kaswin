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
    script_builder::ScriptBuilder,
    engine_context::EngineContext, caches::Cache,
    covenants::CovenantsContext,
};
use kaspa_txscript_errors::TxScriptError;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use serde_json::Value;

#[path = "../../../../contracts/phase_d_covenant.rs"]
mod phase_d_covenant;
use phase_d_covenant::build_dynamic_first_crossing_script;

struct MockAccessor {
    selected_chain: Vec<Hash>,
    seq_commits: HashMap<Hash, Hash>,
}

impl SeqCommitAccessor for MockAccessor {
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

fn parse_header_json(path: &str) -> (Header, Value) {
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

    let header = Header {
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
    };
    (header, val)
}

struct HeaderDynamicParts {
    before_p0: Vec<u8>,
    parent0: [u8; 32],
    between: Vec<u8>,
    daa_bytes: [u8; 8],
    blue_score: [u8; 8],
    work_len: [u8; 8],
    work_bytes: Vec<u8>,
    pruning: [u8; 32],
}

struct ParentDynamicParts {
    before_daa: Vec<u8>,
    daa_bytes: [u8; 8],
    blue_score: [u8; 8],
    work_len: [u8; 8],
    work_bytes: Vec<u8>,
    pruning: [u8; 32],
}

fn decompose_t_dynamic(h: &Header) -> HeaderDynamicParts {
    let mut before_p0 = Vec::new();
    before_p0.extend_from_slice(&h.version.to_le_bytes());
    let expanded_len = h.parents_by_level.expanded_len() as u64;
    before_p0.extend_from_slice(&expanded_len.to_le_bytes());
    let level0_len = h.parents_by_level.get(0).unwrap().len() as u64;
    before_p0.extend_from_slice(&level0_len.to_le_bytes());

    let parent0 = h.parents_by_level.get(0).unwrap()[0].as_bytes();

    let mut between = Vec::new();
    for p in h.parents_by_level.get(0).unwrap().iter().skip(1) {
        between.extend_from_slice(&p.as_bytes());
    }
    for level in h.parents_by_level.expanded_iter().skip(1) {
        let level_len = level.len() as u64;
        between.extend_from_slice(&level_len.to_le_bytes());
        for hash in level.iter() {
            between.extend_from_slice(&hash.as_bytes());
        }
    }
    between.extend_from_slice(&h.hash_merkle_root.as_bytes());
    between.extend_from_slice(&h.accepted_id_merkle_root.as_bytes());
    between.extend_from_slice(&h.utxo_commitment.as_bytes());
    between.extend_from_slice(&h.timestamp.to_le_bytes());
    between.extend_from_slice(&h.bits.to_le_bytes());
    between.extend_from_slice(&h.nonce.to_le_bytes());

    let daa_bytes = h.daa_score.to_le_bytes();
    let blue_score = h.blue_score.to_le_bytes();

    let be_bytes = h.blue_work.to_be_bytes();
    let start = be_bytes.iter().copied().position(|b| b != 0).unwrap_or(be_bytes.len());
    let work_slice = &be_bytes[start..];
    let work_len = (work_slice.len() as u64).to_le_bytes();
    let work_bytes = work_slice.to_vec();
    let pruning = h.pruning_point.as_bytes();

    HeaderDynamicParts {
        before_p0,
        parent0,
        between,
        daa_bytes,
        blue_score,
        work_len,
        work_bytes,
        pruning,
    }
}

fn decompose_p_dynamic(h: &Header) -> ParentDynamicParts {
    let mut before_daa = Vec::new();
    before_daa.extend_from_slice(&h.version.to_le_bytes());
    let expanded_len = h.parents_by_level.expanded_len() as u64;
    before_daa.extend_from_slice(&expanded_len.to_le_bytes());
    for level in h.parents_by_level.expanded_iter() {
        let level_len = level.len() as u64;
        before_daa.extend_from_slice(&level_len.to_le_bytes());
        for hash in level.iter() {
            before_daa.extend_from_slice(&hash.as_bytes());
        }
    }
    before_daa.extend_from_slice(&h.hash_merkle_root.as_bytes());
    before_daa.extend_from_slice(&h.accepted_id_merkle_root.as_bytes());
    before_daa.extend_from_slice(&h.utxo_commitment.as_bytes());
    before_daa.extend_from_slice(&h.timestamp.to_le_bytes());
    before_daa.extend_from_slice(&h.bits.to_le_bytes());
    before_daa.extend_from_slice(&h.nonce.to_le_bytes());

    let daa_bytes = h.daa_score.to_le_bytes();
    let blue_score = h.blue_score.to_le_bytes();

    let be_bytes = h.blue_work.to_be_bytes();
    let start = be_bytes.iter().copied().position(|b| b != 0).unwrap_or(be_bytes.len());
    let work_slice = &be_bytes[start..];
    let work_len = (work_slice.len() as u64).to_le_bytes();
    let work_bytes = work_slice.to_vec();
    let pruning = h.pruning_point.as_bytes();

    ParentDynamicParts {
        before_daa,
        daa_bytes,
        blue_score,
        work_len,
        work_bytes,
        pruning,
    }
}

fn reassemble_hash(p: &Header) -> Hash {
    kaspa_consensus_core::hashing::header::hash(p)
}

fn run_dynamic_test(
    p_parts: &ParentDynamicParts,
    t_parts: &HeaderDynamicParts,
    t_hash: Hash,
    p_hash: Hash,
    seq_commit: Hash,
    d_arm: u64,
    delta: i64,
) -> Result<(), TxScriptError> {
    let redeem_script = build_dynamic_first_crossing_script(delta);
    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&redeem_script);

    let mut seq_commits = HashMap::new();
    seq_commits.insert(t_hash, seq_commit);
    let accessor = MockAccessor {
        selected_chain: vec![p_hash, t_hash],
        seq_commits,
    };

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // Stack (bottom to top):
    // P_before_daa, P_daa, P_blue_score, P_work_len, P_work, P_pruning,
    // T_before_p0, T_parent0, T_between, T_daa, T_blue_score, T_work_len, T_work, T_pruning, redeem_script
    let mut sig = ScriptBuilder::with_flags(flags);
    sig.add_data(&p_parts.before_daa).unwrap();
    sig.add_data(&p_parts.daa_bytes).unwrap();
    sig.add_data(&p_parts.blue_score).unwrap();
    sig.add_data(&p_parts.work_len).unwrap();
    sig.add_data(&p_parts.work_bytes).unwrap();
    sig.add_data(&p_parts.pruning).unwrap();

    sig.add_data(&t_parts.before_p0).unwrap();
    sig.add_data(&t_parts.parent0).unwrap();
    sig.add_data(&t_parts.between).unwrap();
    sig.add_data(&t_parts.daa_bytes).unwrap();
    sig.add_data(&t_parts.blue_score).unwrap();
    sig.add_data(&t_parts.work_len).unwrap();
    sig.add_data(&t_parts.work_bytes).unwrap();
    sig.add_data(&t_parts.pruning).unwrap();
    sig.add_data(&redeem_script).unwrap();

    let tx = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop = PopulatedTransaction::new(&tx, vec![UtxoEntry::new(1000000, p2sh_spk, d_arm, false, None)]);
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let cov_ctx = CovenantsContext::from_tx(&pop).unwrap();
    let ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);
    TxScriptEngine::from_transaction_input(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx, flags).execute()
}

fn main() {
    println!("=== DYNAMIC BLUE_WORK FIRST-CROSSING TEST MATRIX ===");

    let (t_real, _) = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let (p_real, _) = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/P-header.json");

    let p_real_parts = decompose_p_dynamic(&p_real);
    let t_real_parts = decompose_t_dynamic(&t_real);

    println!("Real TN10 Header T blue_work len: {} bytes (W=7)", t_real_parts.work_bytes.len());
    println!("Real TN10 Header P blue_work len: {} bytes (W=7)", p_real_parts.work_bytes.len());

    let delta = 100i64;
    let d_arm = t_real.daa_score - 100; // boundary = t_real.daa_score

    // -------------------------------------------------------------
    // CASE A: W=7, REAL TN10 Canonical Segmentation -> PASS
    // -------------------------------------------------------------
    let res_a = run_dynamic_test(&p_real_parts, &t_real_parts, t_real.hash, p_real.hash, t_real.accepted_id_merkle_root, d_arm, delta);
    println!("CASE A [REAL TN10] (W=7, Canonical Segmentation): {:?}", res_a);
    assert!(res_a.is_ok(), "Case A must PASS");

    // -------------------------------------------------------------
    // CASE B: W=6, VM CANONICAL FIXTURE -> PASS
    // -------------------------------------------------------------
    let mut t_w6 = t_real.clone();
    let mut p_w6 = p_real.clone();
    let mut w6_bytes = [0u8; 24];
    w6_bytes[18..24].copy_from_slice(&[0x05, 0x11, 0x22, 0x33, 0x44, 0x55]); // 6 bytes, first byte is 0x05 != 0
    t_w6.blue_work = kaspa_consensus_core::BlueWorkType::from_be_bytes(w6_bytes);
    p_w6.blue_work = kaspa_consensus_core::BlueWorkType::from_be_bytes(w6_bytes);
    t_w6.hash = reassemble_hash(&t_w6);
    p_w6.hash = reassemble_hash(&p_w6);
    let mut t_w6_parents = Vec::new();
    t_w6_parents.push(vec![p_w6.hash]);
    for lvl in t_real.parents_by_level.expanded_iter().skip(1) {
        t_w6_parents.push(lvl.to_vec());
    }
    t_w6.parents_by_level = t_w6_parents.try_into().unwrap();
    t_w6.hash = reassemble_hash(&t_w6);

    let p_w6_parts = decompose_p_dynamic(&p_w6);
    let t_w6_parts = decompose_t_dynamic(&t_w6);
    assert_eq!(t_w6_parts.work_bytes.len(), 6);

    let res_b = run_dynamic_test(&p_w6_parts, &t_w6_parts, t_w6.hash, p_w6.hash, t_w6.accepted_id_merkle_root, d_arm, delta);
    println!("CASE B [VM CANONICAL FIXTURE] (W=6, Canonical Segmentation): {:?}", res_b);
    assert!(res_b.is_ok(), "Case B must PASS");

    // -------------------------------------------------------------
    // CASE C: W=8, VM CANONICAL FIXTURE -> PASS
    // -------------------------------------------------------------
    let mut t_w8 = t_real.clone();
    let mut p_w8 = p_real.clone();
    let mut w8_bytes = [0u8; 24];
    w8_bytes[16..24].copy_from_slice(&[0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]); // 8 bytes, first byte is 0x01 != 0
    t_w8.blue_work = kaspa_consensus_core::BlueWorkType::from_be_bytes(w8_bytes);
    p_w8.blue_work = kaspa_consensus_core::BlueWorkType::from_be_bytes(w8_bytes);
    t_w8.hash = reassemble_hash(&t_w8);
    p_w8.hash = reassemble_hash(&p_w8);
    let mut t_w8_parents = Vec::new();
    t_w8_parents.push(vec![p_w8.hash]);
    for lvl in t_real.parents_by_level.expanded_iter().skip(1) {
        t_w8_parents.push(lvl.to_vec());
    }
    t_w8.parents_by_level = t_w8_parents.try_into().unwrap();
    t_w8.hash = reassemble_hash(&t_w8);

    let p_w8_parts = decompose_p_dynamic(&p_w8);
    let t_w8_parts = decompose_t_dynamic(&t_w8);
    assert_eq!(t_w8_parts.work_bytes.len(), 8);

    let res_c = run_dynamic_test(&p_w8_parts, &t_w8_parts, t_w8.hash, p_w8.hash, t_w8.accepted_id_merkle_root, d_arm, delta);
    println!("CASE C [VM CANONICAL FIXTURE] (W=8, Canonical Segmentation): {:?}", res_c);
    assert!(res_c.is_ok(), "Case C must PASS");

    // -------------------------------------------------------------
    // CASE D: Repartition attack (shifting DAA to non-DAA field) -> MUST FAIL
    // -------------------------------------------------------------
    let mut p_bad_repartition = decompose_p_dynamic(&p_real);
    p_bad_repartition.daa_bytes = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]; // 1 < boundary
    let res_d = run_dynamic_test(&p_bad_repartition, &t_real_parts, t_real.hash, p_real.hash, t_real.accepted_id_merkle_root, d_arm, delta);
    println!("CASE D [REPARTITION ATTACK] (Corrupting DAA boundary): {:?}", res_d);
    assert!(res_d.is_err(), "Case D MUST FAIL");

    // -------------------------------------------------------------
    // CASE E: blue_work_len != len(blue_work_bytes) -> MUST FAIL
    // -------------------------------------------------------------
    let mut t_bad_len = decompose_t_dynamic(&t_real);
    t_bad_len.work_len = (8u64).to_le_bytes(); // declared 8, but work_bytes is 7!
    let res_e = run_dynamic_test(&p_real_parts, &t_bad_len, t_real.hash, p_real.hash, t_real.accepted_id_merkle_root, d_arm, delta);
    println!("CASE E [LENGTH MISMATCH] (work_len != len(work)): {:?}", res_e);
    assert!(matches!(res_e, Err(TxScriptError::VerifyError)), "Case E MUST FAIL on OpEqualVerify!");

    // -------------------------------------------------------------
    // CASE F: Non-canonical leading zero in blue_work -> MUST FAIL
    // -------------------------------------------------------------
    let mut t_leading_zero = decompose_t_dynamic(&t_real);
    let mut bad_work = vec![0x00]; // prepend non-canonical leading zero!
    bad_work.extend_from_slice(&t_leading_zero.work_bytes);
    t_leading_zero.work_bytes = bad_work;
    t_leading_zero.work_len = (t_leading_zero.work_bytes.len() as u64).to_le_bytes();
    let res_f = run_dynamic_test(&p_real_parts, &t_leading_zero, t_real.hash, p_real.hash, t_real.accepted_id_merkle_root, d_arm, delta);
    println!("CASE F [NON-CANONICAL LEADING ZERO] (work has leading 0x00): {:?}", res_f);
    assert!(matches!(res_f, Err(TxScriptError::VerifyError)), "Case F MUST FAIL on OpVerify leading zero check!");

    println!("\n>>> ALL 6 CASES (A, B, C: PASS | D, E, F: FAIL) PROVEN WITH ZERO HARDCODED W=7 ASSUMPTION! <<<");
}
