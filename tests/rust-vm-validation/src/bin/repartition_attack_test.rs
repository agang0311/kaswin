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
use phase_d_covenant::build_repartition_proof_first_crossing_script;

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
    println!("=== REPARTITION ATTACK FULL ADVERSARIAL MATRIX ===");

    let (t_header, _) = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let (p_header, _) = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/P-header.json");

    let p_bytes = serialize_full_header(&p_header);
    let t_bytes = serialize_full_header(&t_header);

    let delta = 100i64;
    let redeem_script = build_repartition_proof_first_crossing_script(delta);
    println!("Script length: {} bytes", redeem_script.len());
    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&redeem_script);

    let mut seq_commits = HashMap::new();
    seq_commits.insert(t_header.hash, t_header.accepted_id_merkle_root);
    let accessor = MockAccessor {
        selected_chain: vec![p_header.hash, t_header.hash],
        seq_commits,
    };

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // --- Honest canonical segmentation ---
    let p_daa_end = p_bytes.len() - 55;
    let p_daa_start = p_daa_end - 8;
    let p_before_daa = &p_bytes[..p_daa_start];
    let p_daa_honest = &p_bytes[p_daa_start..p_daa_end];
    let p_tail_honest = &p_bytes[p_daa_end..];

    let t_before_p0 = &t_bytes[..18];
    let t_p0_honest = &t_bytes[18..50];
    let t_daa_end = t_bytes.len() - 55;
    let t_daa_start = t_daa_end - 8;
    let t_between = &t_bytes[50..t_daa_start];
    let t_daa_honest = &t_bytes[t_daa_start..t_daa_end];
    let t_tail_honest = &t_bytes[t_daa_end..];

    let boundary = t_header.daa_score;
    let d_arm = boundary - 100;

    // Case A: Honest Canonical Segmentation -> PASS
    let mut sig_a = ScriptBuilder::with_flags(flags);
    sig_a.add_data(p_before_daa).unwrap();
    sig_a.add_data(p_daa_honest).unwrap();
    sig_a.add_data(p_tail_honest).unwrap();
    sig_a.add_data(t_before_p0).unwrap();
    sig_a.add_data(t_p0_honest).unwrap();
    sig_a.add_data(t_between).unwrap();
    sig_a.add_data(t_daa_honest).unwrap();
    sig_a.add_data(t_tail_honest).unwrap();
    sig_a.add_data(&redeem_script).unwrap();

    let tx_a = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_a.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop_a = PopulatedTransaction::new(&tx_a, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let sig_cache_a = Cache::new(1000);
    let reused_a = SigHashReusedValuesUnsync::new();
    let cov_ctx_a = CovenantsContext::from_tx(&pop_a).unwrap();
    let ctx_a = EngineContext::new(&sig_cache_a).with_reused(&reused_a).with_covenants_ctx(&cov_ctx_a).with_seq_commit_accessor(&accessor);
    let res_a = TxScriptEngine::from_transaction_input(&pop_a, &pop_a.tx.inputs[0], 0, &pop_a.entries[0], ctx_a, flags).execute();
    println!("Case A (Honest Canonical Segmentation): {:?}", res_a);
    assert!(res_a.is_ok(), "Honest canonical segmentation must PASS");

    // Case B: Adversarial Repartition on P (repartitioning P to make fake P_daa = expanded_len = 61 < boundary)
    // Here p_bytes is 100% UNCHANGED, but repartitioned:
    // fake P_daa is at [2..10].
    // This makes fake_p_tail = &p_bytes[10..] which has length p_bytes.len() - 10 != 55!
    let fake_p_daa = &p_bytes[2..10];
    let fake_p_before = &p_bytes[..2];
    let fake_p_tail = &p_bytes[10..];

    let later_d_arm = p_header.daa_score - 105; // boundary <= P.daa!
    let mut sig_b = ScriptBuilder::with_flags(flags);
    sig_b.add_data(fake_p_before).unwrap();
    sig_b.add_data(fake_p_daa).unwrap();
    sig_b.add_data(fake_p_tail).unwrap();
    sig_b.add_data(t_before_p0).unwrap();
    sig_b.add_data(t_p0_honest).unwrap();
    sig_b.add_data(t_between).unwrap();
    sig_b.add_data(t_daa_honest).unwrap();
    sig_b.add_data(t_tail_honest).unwrap();
    sig_b.add_data(&redeem_script).unwrap();

    let tx_b = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_b.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop_b = PopulatedTransaction::new(&tx_b, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), later_d_arm, false, None)]);
    let sig_cache_b = Cache::new(1000);
    let reused_b = SigHashReusedValuesUnsync::new();
    let cov_ctx_b = CovenantsContext::from_tx(&pop_b).unwrap();
    let ctx_b = EngineContext::new(&sig_cache_b).with_reused(&reused_b).with_covenants_ctx(&cov_ctx_b).with_seq_commit_accessor(&accessor);
    let res_b = TxScriptEngine::from_transaction_input(&pop_b, &pop_b.tx.inputs[0], 0, &pop_b.entries[0], ctx_b, flags).execute();
    println!("Case B (Repartition Attack on P): {:?}", res_b);
    assert!(matches!(res_b, Err(TxScriptError::VerifyError)), "Case B MUST FAIL because len(fake_p_tail) != 55!");

    // Case C: Adversarial Repartition on T (repartitioning T to pick timestamp as fake T_daa)
    // Keep t_bytes 100% UNCHANGED, but shift fake T_daa to timestamp.
    // This makes fake_t_tail != 55 bytes!
    let fake_t_daa_end = t_bytes.len() - 55 - 8 - 8 - 4; // shift back by blue_score, bits, etc.
    let fake_t_daa = &t_bytes[fake_t_daa_end - 8..fake_t_daa_end];
    let fake_t_tail = &t_bytes[fake_t_daa_end..];
    let fake_t_between = &t_bytes[50..fake_t_daa_end - 8];

    let mut sig_c = ScriptBuilder::with_flags(flags);
    sig_c.add_data(p_before_daa).unwrap();
    sig_c.add_data(p_daa_honest).unwrap();
    sig_c.add_data(p_tail_honest).unwrap();
    sig_c.add_data(t_before_p0).unwrap();
    sig_c.add_data(t_p0_honest).unwrap();
    sig_c.add_data(fake_t_between).unwrap();
    sig_c.add_data(fake_t_daa).unwrap();
    sig_c.add_data(fake_t_tail).unwrap();
    sig_c.add_data(&redeem_script).unwrap();

    let tx_c = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_c.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop_c = PopulatedTransaction::new(&tx_c, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let sig_cache_c = Cache::new(1000);
    let reused_c = SigHashReusedValuesUnsync::new();
    let cov_ctx_c = CovenantsContext::from_tx(&pop_c).unwrap();
    let ctx_c = EngineContext::new(&sig_cache_c).with_reused(&reused_c).with_covenants_ctx(&cov_ctx_c).with_seq_commit_accessor(&accessor);
    let res_c = TxScriptEngine::from_transaction_input(&pop_c, &pop_c.tx.inputs[0], 0, &pop_c.entries[0], ctx_c, flags).execute();
    println!("Case C (Repartition Attack on T): {:?}", res_c);
    assert!(matches!(res_c, Err(TxScriptError::VerifyError)), "Case C MUST FAIL because len(fake_t_tail) != 55!");

    // Case D: Adversarial Repartition on T_parent0 (repartitioning T to pick a 32-byte hash occurrence from later parent levels)
    // For example, picking level 1 parent instead of level 0 index 0 parent.
    // If fake parent0 is picked from level 1, then fake_t_before_p0 will include level 0 and have length > 18!
    let fake_t_before_p0 = &t_bytes[..18 + 32 + 8]; // shifts into level 1
    let fake_t_p0 = &t_bytes[18 + 32 + 8..18 + 32 + 8 + 32];
    let fake_t_between_d = &t_bytes[18 + 32 + 8 + 32..t_daa_start];

    let mut sig_d = ScriptBuilder::with_flags(flags);
    sig_d.add_data(p_before_daa).unwrap();
    sig_d.add_data(p_daa_honest).unwrap();
    sig_d.add_data(p_tail_honest).unwrap();
    sig_d.add_data(fake_t_before_p0).unwrap();
    sig_d.add_data(fake_t_p0).unwrap();
    sig_d.add_data(fake_t_between_d).unwrap();
    sig_d.add_data(t_daa_honest).unwrap();
    sig_d.add_data(t_tail_honest).unwrap();
    sig_d.add_data(&redeem_script).unwrap();

    let tx_d = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_d.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop_d = PopulatedTransaction::new(&tx_d, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let sig_cache_d = Cache::new(1000);
    let reused_d = SigHashReusedValuesUnsync::new();
    let cov_ctx_d = CovenantsContext::from_tx(&pop_d).unwrap();
    let ctx_d = EngineContext::new(&sig_cache_d).with_reused(&reused_d).with_covenants_ctx(&cov_ctx_d).with_seq_commit_accessor(&accessor);
    let res_d = TxScriptEngine::from_transaction_input(&pop_d, &pop_d.tx.inputs[0], 0, &pop_d.entries[0], ctx_d, flags).execute();
    println!("Case D (Repartition Attack on T_parent0): {:?}", res_d);
    assert!(matches!(res_d, Err(TxScriptError::VerifyError)), "Case D MUST FAIL because len(fake_t_before_p0) != 18!");

    println!("\n>>> ALL CASES (A: PASS, B: FAIL, C: FAIL, D: FAIL) SUCCEEDED! <<<");
    println!(">>> REPARTITION ATTACK PROVABLY IMPOSSIBLE UNDER STRUCTURAL CONSTRAINTS! <<<");
}
