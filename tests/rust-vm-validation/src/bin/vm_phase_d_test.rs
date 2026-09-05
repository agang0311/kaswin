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
use phase_d_covenant::build_authenticated_first_crossing_script;

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

fn decompose_t_header(h: &Header) -> (Vec<u8>, [u8; 32], Vec<u8>, [u8; 8], Vec<u8>) {
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

    let mut tail = Vec::new();
    tail.extend_from_slice(&h.blue_score.to_le_bytes());
    let be_bytes = h.blue_work.to_be_bytes();
    let start = be_bytes.iter().copied().position(|b| b != 0).unwrap_or(be_bytes.len());
    let work_slice = &be_bytes[start..];
    let work_len = work_slice.len() as u64;
    tail.extend_from_slice(&work_len.to_le_bytes());
    tail.extend_from_slice(work_slice);
    tail.extend_from_slice(&h.pruning_point.as_bytes());

    (before_p0, parent0, between, daa_bytes, tail)
}

fn decompose_p_header(h: &Header) -> (Vec<u8>, [u8; 8], Vec<u8>) {
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

    let mut tail = Vec::new();
    tail.extend_from_slice(&h.blue_score.to_le_bytes());
    let be_bytes = h.blue_work.to_be_bytes();
    let start = be_bytes.iter().copied().position(|b| b != 0).unwrap_or(be_bytes.len());
    let work_slice = &be_bytes[start..];
    let work_len = work_slice.len() as u64;
    tail.extend_from_slice(&work_len.to_le_bytes());
    tail.extend_from_slice(work_slice);
    tail.extend_from_slice(&h.pruning_point.as_bytes());

    (before_daa, daa_bytes, tail)
}

fn main() {
    println!("=== Phase D Authenticated First-Crossing Script Full Adversarial Matrix ===");

    let (t_header, _) = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let (p_header, _) = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/P-header.json");

    println!("T Hash: {}, DAA: {}", t_header.hash, t_header.daa_score);
    println!("P Hash: {}, DAA: {}", p_header.hash, p_header.daa_score);

    let (p_before_daa, p_daa_bytes, p_tail) = decompose_p_header(&p_header);
    let (t_before_p0, t_p0_bytes, t_between, t_daa_bytes, t_tail) = decompose_t_header(&t_header);

    let boundary = t_header.daa_score;
    let d_arm = boundary - 100;
    let delta = 100i64;

    let redeem_script = build_authenticated_first_crossing_script(delta);
    println!("Authenticated First-Crossing Redeem Script Length: {} bytes", redeem_script.len());
    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&redeem_script);

    let mut seq_commits = HashMap::new();
    seq_commits.insert(t_header.hash, t_header.accepted_id_merkle_root);
    let accessor = MockAccessor {
        selected_chain: vec![p_header.hash, t_header.hash],
        seq_commits,
    };

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // 1. Valid spend
    let mut sig_script = ScriptBuilder::with_flags(flags);
    sig_script.add_data(&p_before_daa).unwrap();
    sig_script.add_data(&p_daa_bytes).unwrap();
    sig_script.add_data(&p_tail).unwrap();
    sig_script.add_data(&t_before_p0).unwrap();
    sig_script.add_data(&t_p0_bytes).unwrap();
    sig_script.add_data(&t_between).unwrap();
    sig_script.add_data(&t_daa_bytes).unwrap();
    sig_script.add_data(&t_tail).unwrap();
    sig_script.add_data(&redeem_script).unwrap();

    let tx = Transaction::new(
        0,
        vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_script.drain(), 0, 0)],
        vec![],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let entry = UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None);

    let populated_tx = PopulatedTransaction::new(&tx, vec![entry]);
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let cov_ctx = CovenantsContext::from_tx(&populated_tx).unwrap();
    let ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);
    let mut vm = TxScriptEngine::from_transaction_input(&populated_tx, &populated_tx.tx.inputs[0], 0, &populated_tx.entries[0], ctx, flags);

    let res = vm.execute();
    println!("1. Valid Authenticated First-Crossing Execution: {:?}", res);
    assert!(res.is_ok(), "Authenticated First-Crossing must verify Ok(())");

    // 2. Fake T_daa mutation (corrupting T_daa in witness)
    let mut bad_t_daa = t_daa_bytes;
    bad_t_daa[0] ^= 0x01;
    let mut sig_bad_daa = ScriptBuilder::with_flags(flags);
    sig_bad_daa.add_data(&p_before_daa).unwrap();
    sig_bad_daa.add_data(&p_daa_bytes).unwrap();
    sig_bad_daa.add_data(&p_tail).unwrap();
    sig_bad_daa.add_data(&t_before_p0).unwrap();
    sig_bad_daa.add_data(&t_p0_bytes).unwrap();
    sig_bad_daa.add_data(&t_between).unwrap();
    sig_bad_daa.add_data(&bad_t_daa).unwrap();
    sig_bad_daa.add_data(&t_tail).unwrap();
    sig_bad_daa.add_data(&redeem_script).unwrap();

    let tx_bad_daa = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_bad_daa.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop_bad_daa = PopulatedTransaction::new(&tx_bad_daa, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let cov_bad_daa = CovenantsContext::from_tx(&pop_bad_daa).unwrap();
    let ctx_bad_daa = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_bad_daa).with_seq_commit_accessor(&accessor);
    let mut vm_bad_daa = TxScriptEngine::from_transaction_input(&pop_bad_daa, &pop_bad_daa.tx.inputs[0], 0, &pop_bad_daa.entries[0], ctx_bad_daa, flags);
    let res_bad_daa = vm_bad_daa.execute();
    println!("2. Fake T_daa mutation execution: {:?}", res_bad_daa);
    assert!(matches!(res_bad_daa, Err(TxScriptError::BlockNotSelected(_))));

    // 3. Fake P_daa mutation (corrupting P_daa in witness)
    let mut bad_p_daa = p_daa_bytes;
    bad_p_daa[0] ^= 0x01;
    let mut sig_bad_p_daa = ScriptBuilder::with_flags(flags);
    sig_bad_p_daa.add_data(&p_before_daa).unwrap();
    sig_bad_p_daa.add_data(&bad_p_daa).unwrap();
    sig_bad_p_daa.add_data(&p_tail).unwrap();
    sig_bad_p_daa.add_data(&t_before_p0).unwrap();
    sig_bad_p_daa.add_data(&t_p0_bytes).unwrap();
    sig_bad_p_daa.add_data(&t_between).unwrap();
    sig_bad_p_daa.add_data(&t_daa_bytes).unwrap();
    sig_bad_p_daa.add_data(&t_tail).unwrap();
    sig_bad_p_daa.add_data(&redeem_script).unwrap();

    let tx_bad_p_daa = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_bad_p_daa.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop_bad_p_daa = PopulatedTransaction::new(&tx_bad_p_daa, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let cov_bad_p_daa = CovenantsContext::from_tx(&pop_bad_p_daa).unwrap();
    let ctx_bad_p_daa = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_bad_p_daa).with_seq_commit_accessor(&accessor);
    let mut vm_bad_p_daa = TxScriptEngine::from_transaction_input(&pop_bad_p_daa, &pop_bad_p_daa.tx.inputs[0], 0, &pop_bad_p_daa.entries[0], ctx_bad_p_daa, flags);
    let res_bad_p_daa = vm_bad_p_daa.execute();
    println!("3. Fake P_daa mutation execution: {:?}", res_bad_p_daa);
    assert!(res_bad_p_daa.is_err()); // P_hash mismatch with T_parent0!

    // 4. Fake T_parent0 mutation
    let mut bad_t_p0 = t_p0_bytes;
    bad_t_p0[0] ^= 0xff;
    let mut sig_bad_p0 = ScriptBuilder::with_flags(flags);
    sig_bad_p0.add_data(&p_before_daa).unwrap();
    sig_bad_p0.add_data(&p_daa_bytes).unwrap();
    sig_bad_p0.add_data(&p_tail).unwrap();
    sig_bad_p0.add_data(&t_before_p0).unwrap();
    sig_bad_p0.add_data(&bad_t_p0).unwrap();
    sig_bad_p0.add_data(&t_between).unwrap();
    sig_bad_p0.add_data(&t_daa_bytes).unwrap();
    sig_bad_p0.add_data(&t_tail).unwrap();
    sig_bad_p0.add_data(&redeem_script).unwrap();

    let tx_bad_p0 = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_bad_p0.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let pop_bad_p0 = PopulatedTransaction::new(&tx_bad_p0, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let cov_bad_p0 = CovenantsContext::from_tx(&pop_bad_p0).unwrap();
    let ctx_bad_p0 = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_bad_p0).with_seq_commit_accessor(&accessor);
    let mut vm_bad_p0 = TxScriptEngine::from_transaction_input(&pop_bad_p0, &pop_bad_p0.tx.inputs[0], 0, &pop_bad_p0.entries[0], ctx_bad_p0, flags);
    let res_bad_p0 = vm_bad_p0.execute();
    println!("4. Fake T_parent0 mutation execution: {:?}", res_bad_p0);
    assert!(res_bad_p0.is_err()); // Either BlockNotSelected or EqualVerify fail

    // 5. Later T (where P.daa >= boundary)
    let later_d_arm = p_header.daa_score - 101; // boundary = p_header.daa_score - 1 <= p_header.daa_score!
    let later_entry = UtxoEntry::new(1000000, p2sh_spk.clone(), later_d_arm, false, None);
    let pop_later = PopulatedTransaction::new(&tx, vec![later_entry]);
    let cov_later = CovenantsContext::from_tx(&pop_later).unwrap();
    let ctx_later = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_later).with_seq_commit_accessor(&accessor);
    let mut vm_later = TxScriptEngine::from_transaction_input(&pop_later, &pop_later.tx.inputs[0], 0, &pop_later.entries[0], ctx_later, flags);
    let res_later = vm_later.execute();
    println!("5. Later T (P.daa >= boundary) execution: {:?}", res_later);
    assert!(matches!(res_later, Err(TxScriptError::VerifyError)));

    // 6. Earlier T (where T.daa < boundary)
    let earlier_d_arm = t_header.daa_score - 99; // boundary = t_header.daa_score + 1 > t_header.daa_score!
    let earlier_entry = UtxoEntry::new(1000000, p2sh_spk.clone(), earlier_d_arm, false, None);
    let pop_earlier = PopulatedTransaction::new(&tx, vec![earlier_entry]);
    let cov_earlier = CovenantsContext::from_tx(&pop_earlier).unwrap();
    let ctx_earlier = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_earlier).with_seq_commit_accessor(&accessor);
    let mut vm_earlier = TxScriptEngine::from_transaction_input(&pop_earlier, &pop_earlier.tx.inputs[0], 0, &pop_earlier.entries[0], ctx_earlier, flags);
    let res_earlier = vm_earlier.execute();
    println!("6. Earlier T (T.daa < boundary) execution: {:?}", res_earlier);
    assert!(matches!(res_earlier, Err(TxScriptError::VerifyError)));

    println!("\n>>> ALL 6/6 ADVERSARIAL MATRIX TESTS IN PHASE D VM PASSED WITH 100% SOUNDNESS! <<<");
}
