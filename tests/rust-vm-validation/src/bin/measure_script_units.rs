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

fn main() {
    println!("=== Production Candidate (max_levels=251) Single Source of Truth Measurement ===");

    let t_header = parse_header("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let p_header = parse_header("/root/kaswin/artifacts/tn10/phase-d/P-header.json");

    let t_bytes = serialize_full_header(&t_header);
    let p_bytes = serialize_full_header(&p_header);

    let max_levels = 251; // Production TN10 limit
    let delta_daa = 100i64;
    let d_arm = t_header.daa_score - 100;
    let seq_commit = t_header.accepted_id_merkle_root;

    // Single source of truth call:
    let script = build_bounded_dynamic_covenant(delta_daa, max_levels);
    println!("Redeem Script Bytes: {}", script.len());

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

    let sig_bytes = sig.drain();
    println!("Signature Script Bytes: {}", sig_bytes.len());

    // Tx Version 1 with ComputeCommit::ComputeBudget:
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

    let mut vm = TxScriptEngine::from_transaction_input(&pop_measure, &pop_measure.tx.inputs[0], 0, &pop_measure.entries[0], ctx, flags);
    let res = vm.execute();
    assert_eq!(res, Ok(()));

    let used_units = vm.used_script_units();
    println!("Actual Used Script Units: {}", used_units.0);

    let b_min = ComputeBudget::checked_covering_script_units(used_units).expect("budget must be computable");
    println!("Minimal ComputeBudget B_min: {}", b_min.value());

    let compute_mass = b_min.to_grams().0;
    println!("Compute Mass: {} gram", compute_mass);

    // Calculate total transaction mass (transient + compute)
    let total_tx_bytes = 2 + 2 + (32 + 4 + sig_bytes.len() + 8 + 2) + 1 + 8 + 20 + 8; // approx serialized tx size
    let transient_mass = total_tx_bytes as u64; // 1 gram per tx byte
    let total_mass = compute_mass.max(transient_mass);
    println!("Total Transaction Bytes: ~{} bytes", total_tx_bytes);
    println!("Transient Mass: {} gram", transient_mass);
    println!("Total Transaction Mass: {} gram (Block limit: 500,000 gram)", total_mass);
}
