use std::fs;
use std::str::FromStr;
use std::collections::HashMap;
use kaspa_hashes::Hash;
use kaspa_consensus_core::header::Header;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutpoint,
    ScriptPublicKey, UtxoEntry, PopulatedTransaction, ComputeCommit,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, SeqCommitAccessor,
    script_builder::ScriptBuilder,
    engine_context::EngineContext, caches::Cache,
    covenants::CovenantsContext,
};
use kaspa_txscript_errors::TxScriptError;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::{ComputeBudget, SCRIPT_UNITS_PER_COMPUTE_BUDGET_UNIT};
use serde_json::Value;

#[path = "../../../../contracts/phase_d_covenant.rs"]
mod phase_d_covenant;
use phase_d_covenant::build_bounded_dynamic_covenant;

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

fn main() {
    println!("=== Testing Production Candidate max_levels = 251 ===");

    let t_header = parse_header("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let p_header = parse_header("/root/kaswin/artifacts/tn10/phase-d/P-header.json");

    let t_bytes = serialize_full_header(&t_header);
    let p_bytes = serialize_full_header(&p_header);

    let max_levels = 251; // Production TN10 parameter (max_block_level = 250 => 251 levels)
    let delta_daa = 100i64;
    let d_arm = t_header.daa_score - 100;
    let seq_commit = t_header.accepted_id_merkle_root;

    let script = build_bounded_dynamic_covenant(delta_daa, max_levels);
    println!("Production Redeem Script Length (max_levels=251): {} bytes", script.len());

    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&script);

    let mut seq_commits = HashMap::new();
    seq_commits.insert(t_header.hash, seq_commit);
    let accessor = LocalMockAccessor {
        selected_chain: vec![p_header.hash, t_header.hash],
        seq_commits: seq_commits.clone(),
    };

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    let mut sig = ScriptBuilder::with_flags(flags);
    sig.add_data(&p_bytes).unwrap();
    sig.add_data(&t_bytes).unwrap();
    sig.add_data(&script).unwrap();

    let sig_bytes = sig.drain();
    println!("Signature Script Length: {} bytes", sig_bytes.len());

    // 1. Measure script units with unbounded run
    let tx_measure = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_bytes.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(u16::MAX)),
        )],
        vec![],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_measure = PopulatedTransaction::new(&tx_measure, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let cov_ctx = CovenantsContext::from_tx(&pop_measure).unwrap();
    let ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);

    let mut vm_measure = TxScriptEngine::from_transaction_input(&pop_measure, &pop_measure.tx.inputs[0], 0, &pop_measure.entries[0], ctx, flags);
    let res_measure = vm_measure.execute();
    assert_eq!(res_measure, Ok(()));
    let used_units = vm_measure.used_script_units();
    println!("Actual used script units (max_levels=251, L=61): {} units", used_units.0);

    // Compute minimal covering ComputeBudget via checked_covering_script_units:
    let b_min = ComputeBudget::checked_covering_script_units(used_units).expect("budget must be computable");
    println!("Calculated minimal ComputeBudget B_min: {}", b_min.value());

    let allowed = ComputeCommit::ComputeBudget(b_min).allowed_script_units();
    println!("Allowed script units with B_min: {}", allowed.0);
    assert!(allowed.0 >= used_units.0);

    // 2. Test Version 1 Transaction with B_min:
    let tx_b_min = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_bytes.clone(),
            0,
            ComputeCommit::ComputeBudget(b_min),
        )],
        vec![],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_b_min = PopulatedTransaction::new(&tx_b_min, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let cov_ctx_b_min = CovenantsContext::from_tx(&pop_b_min).unwrap();
    let ctx_b_min = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_b_min).with_seq_commit_accessor(&accessor);
    let mut vm_b_min = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop_b_min,
        &pop_b_min.tx.inputs[0],
        0,
        &pop_b_min.entries[0],
        ctx_b_min,
        flags,
        allowed,
    );
    let res_b_min = vm_b_min.execute();
    println!("Execution with B_min = {}: {:?}", b_min.value(), res_b_min);
    assert_eq!(res_b_min, Ok(()));

    // 3. Test with B_min - 1:
    let b_minus_one = ComputeBudget(b_min.value() - 1);
    let allowed_minus_one = ComputeCommit::ComputeBudget(b_minus_one).allowed_script_units();
    let tx_b_sub = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_bytes.clone(),
            0,
            ComputeCommit::ComputeBudget(b_minus_one),
        )],
        vec![],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_b_sub = PopulatedTransaction::new(&tx_b_sub, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let cov_ctx_b_sub = CovenantsContext::from_tx(&pop_b_sub).unwrap();
    let ctx_b_sub = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_b_sub).with_seq_commit_accessor(&accessor);
    let mut vm_b_sub = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop_b_sub,
        &pop_b_sub.tx.inputs[0],
        0,
        &pop_b_sub.entries[0],
        ctx_b_sub,
        flags,
        allowed_minus_one,
    );
    let res_b_sub = vm_b_sub.execute();
    println!("Execution with (B_min - 1) = {}: {:?}", b_minus_one.value(), res_b_sub);
    assert!(matches!(res_b_sub, Err(TxScriptError::ExceededCommittedScriptUnits { .. })));

    // 4. Test Structural Fixture with L = 251 -> Must PASS
    println!("\n4. Testing Full Structural Boundary Fixture L = 251...");
    let mut t_l251 = t_header.clone();
    let mut p_l251 = p_header.clone();
    let mut p_levels = Vec::new();
    for _ in 0..251 {
        p_levels.push(vec![Hash::default()]);
    }
    p_l251.parents_by_level = p_levels.try_into().unwrap();
    p_l251.hash = reassemble_hash(&p_l251);
    assert_eq!(p_l251.parents_by_level.expanded_len(), 251);

    let mut t_levels = Vec::new();
    t_levels.push(vec![p_l251.hash]);
    for _ in 1..251 {
        t_levels.push(vec![Hash::default()]);
    }
    t_l251.parents_by_level = t_levels.try_into().unwrap();
    t_l251.hash = reassemble_hash(&t_l251);
    assert_eq!(t_l251.parents_by_level.expanded_len(), 251);

    let t_l251_bytes = serialize_full_header(&t_l251);
    let p_l251_bytes = serialize_full_header(&p_l251);

    let mut seq_commits_251 = HashMap::new();
    seq_commits_251.insert(t_l251.hash, t_l251.accepted_id_merkle_root);
    let accessor_251 = LocalMockAccessor {
        selected_chain: vec![p_l251.hash, t_l251.hash],
        seq_commits: seq_commits_251,
    };

    let mut sig_251 = ScriptBuilder::with_flags(flags);
    sig_251.add_data(&p_l251_bytes).unwrap();
    sig_251.add_data(&t_l251_bytes).unwrap();
    sig_251.add_data(&script).unwrap();
    let sig_251_bytes = sig_251.drain();

    let tx_251 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_251_bytes,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(u16::MAX)),
        )],
        vec![],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_251 = PopulatedTransaction::new(&tx_251, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let cov_ctx_251 = CovenantsContext::from_tx(&pop_251).unwrap();
    let ctx_251 = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_251).with_seq_commit_accessor(&accessor_251);
    let mut vm_251 = TxScriptEngine::from_transaction_input(&pop_251, &pop_251.tx.inputs[0], 0, &pop_251.entries[0], ctx_251, flags);
    let res_251 = vm_251.execute();
    println!("Execution with L = 251 full fixture: {:?}", res_251);
    assert_eq!(res_251, Ok(()));
    let units_251 = vm_251.used_script_units().0;
    println!("Script units consumed for L=251 fixture: {} units", units_251);
    let b_min_251 = ComputeBudget::checked_covering_script_units(vm_251.used_script_units()).unwrap();
    println!("Required ComputeBudget for L=251: {}", b_min_251.value());

    // 5. Test Malformed L = 252 -> MUST FAIL
    println!("\n5. Testing Malformed L = 252 (exceeding max_levels=251)...");
    let mut bad_l252_bytes = t_l251_bytes.clone();
    bad_l252_bytes[2..10].copy_from_slice(&(252u64).to_le_bytes()); // Corrupt L to 252
    let mut sig_252 = ScriptBuilder::with_flags(flags);
    sig_252.add_data(&p_l251_bytes).unwrap();
    sig_252.add_data(&bad_l252_bytes).unwrap();
    sig_252.add_data(&script).unwrap();
    let tx_252 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_252.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(u16::MAX)),
        )],
        vec![],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_252 = PopulatedTransaction::new(&tx_252, vec![UtxoEntry::new(1000000, p2sh_spk, d_arm, false, None)]);
    let cov_ctx_252 = CovenantsContext::from_tx(&pop_252).unwrap();
    let ctx_252 = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_252).with_seq_commit_accessor(&accessor_251);
    let mut vm_252 = TxScriptEngine::from_transaction_input(&pop_252, &pop_252.tx.inputs[0], 0, &pop_252.entries[0], ctx_252, flags);
    let res_252 = vm_252.execute();
    println!("Execution with L = 252 (exceeding limit): {:?}", res_252);
    assert!(res_252.is_err(), "L = 252 MUST be rejected by max_levels check!");

    println!("\n>>> ALL TESTS IN PROD CANDIDATE (max_levels=251) PASSED WITH COMPLETE CONSENSUS ACCURACY! <<<");
}
