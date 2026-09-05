use std::fs;
use std::str::FromStr;
use std::collections::HashMap;
use kaspa_hashes::{Hash, BlockHash, HasherBase};
use kaspa_consensus_core::header::Header;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    ScriptPublicKey, UtxoEntry, PopulatedTransaction,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, SeqCommitAccessor,
    script_builder::ScriptBuilder, opcodes::codes,
    engine_context::EngineContext, caches::Cache,
    covenants::CovenantsContext,
};
use kaspa_txscript_errors::TxScriptError;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use serde_json::Value;

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

fn build_header_binding_redeem_script() -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    let key = b"BlockHash";
    sb.add_data(key).unwrap();
    sb.add_op(codes::OpBlake2bWithKey).unwrap();
    sb.add_op(codes::OpChainblockSeqCommit).unwrap();
    sb.add_op(codes::OpDrop).unwrap();
    sb.add_op(codes::OpTrue).unwrap();
    sb.drain()
}

fn serialize_header(h: &Header) -> Vec<u8> {
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

fn run_test(
    header: &Header,
    redeem_script: &[u8],
    p2sh_spk: &ScriptPublicKey,
    accessor: &MockAccessor,
) -> Result<(), TxScriptError> {
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let buf = serialize_header(header);

    let mut sig_script = ScriptBuilder::with_flags(flags);
    sig_script.add_data(&buf).unwrap();
    sig_script.add_data(redeem_script).unwrap();

    let tx = Transaction::new(
        0,
        vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_script.drain(), 0, 0)],
        vec![],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let entry = UtxoEntry::new(1000000, p2sh_spk.clone(), 562630000, false, None);

    let populated_tx = PopulatedTransaction::new(&tx, vec![entry]);
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let cov_ctx = CovenantsContext::from_tx(&populated_tx).unwrap();
    let ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(accessor);
    let mut vm = TxScriptEngine::from_transaction_input(&populated_tx, &populated_tx.tx.inputs[0], 0, &populated_tx.entries[0], ctx, flags);

    vm.execute()
}

fn main() {
    println!("=== Real Script Header-to-BlockHash-to-SeqCommit Full Mutation Tests ===");
    let json_str = fs::read_to_string("/root/kaswin/artifacts/tn10/phase-c/phase-c-T-header.json").unwrap();
    let val: Value = serde_json::from_str(&json_str).unwrap();
    let expected_hash = Hash::from_str(val["hash"].as_str().unwrap()).unwrap();
    let accepted_id_merkle_root = Hash::from_str(val["acceptedIdMerkleRoot"].as_str().unwrap()).unwrap();

    let mut seq_commits = HashMap::new();
    seq_commits.insert(expected_hash, accepted_id_merkle_root);
    let accessor = MockAccessor {
        selected_chain: vec![expected_hash],
        seq_commits,
    };

    let redeem_script = build_header_binding_redeem_script();
    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&redeem_script);

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

    let header_valid = Header {
        hash: expected_hash,
        version,
        parents_by_level: parents_by_level.clone().try_into().unwrap(),
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

    // 1. Valid Header Replay
    let res_valid = run_test(&header_valid, &redeem_script, &p2sh_spk, &accessor);
    println!("1. Valid Header Replay: {:?}", res_valid);
    assert!(res_valid.is_ok());

    // 2. Structured DAA Mutation (header.daa_score += 1)
    let mut header_mutated_daa = header_valid.clone();
    header_mutated_daa.daa_score += 1;
    let res_daa = run_test(&header_mutated_daa, &redeem_script, &p2sh_spk, &accessor);
    println!("2. Structured DAA Mutation (daa_score + 1): {:?}", res_daa);
    assert!(matches!(res_daa, Err(TxScriptError::BlockNotSelected(_))));

    // 3. Parent[0] Mutation
    let mut header_mutated_p0 = header_valid.clone();
    let mut mutated_parents = parents_by_level.clone();
    mutated_parents[0][0] = Hash::from_str("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();
    header_mutated_p0.parents_by_level = mutated_parents.try_into().unwrap();
    let res_p0 = run_test(&header_mutated_p0, &redeem_script, &p2sh_spk, &accessor);
    println!("3. Parent[0] Mutation: {:?}", res_p0);
    assert!(matches!(res_p0, Err(TxScriptError::BlockNotSelected(_))));

    // 4. Nonce Mutation (header.nonce += 1)
    let mut header_mutated_nonce = header_valid.clone();
    header_mutated_nonce.nonce += 1;
    let res_nonce = run_test(&header_mutated_nonce, &redeem_script, &p2sh_spk, &accessor);
    println!("4. Nonce Mutation (nonce + 1): {:?}", res_nonce);
    assert!(matches!(res_nonce, Err(TxScriptError::BlockNotSelected(_))));

    println!("\n>>> ALL 3 STRUCTURED MUTATIONS CONFIRMED IN VM TO CAUSE BlockNotSelected IN OpChainblockSeqCommit! <<<");
}
