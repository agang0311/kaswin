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
    // Key "BlockHash" (9 bytes)
    let key = b"BlockHash";
    sb.add_data(key).unwrap();
    // Stack: [header_preimage, key]
    sb.add_op(codes::OpBlake2bWithKey).unwrap();
    // Stack: [computed_hash]
    // The computed_hash is immediately passed to OpChainblockSeqCommit!
    sb.add_op(codes::OpChainblockSeqCommit).unwrap();
    // Stack: [seq_commit]
    sb.add_op(codes::OpDrop).unwrap();
    sb.add_op(codes::OpTrue).unwrap();
    sb.drain()
}

fn main() {
    println!("=== Real Script Header-to-BlockHash-to-SeqCommit VM Test ===");
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
    println!("Redeem Script Length: {} bytes", redeem_script.len());
    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&redeem_script);

    // Parse header
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

    // Serialize preimage
    let mut buf = Vec::new();
    buf.extend_from_slice(&header_valid.version.to_le_bytes());
    let expanded_len = header_valid.parents_by_level.expanded_len() as u64;
    buf.extend_from_slice(&expanded_len.to_le_bytes());
    for level in header_valid.parents_by_level.expanded_iter() {
        let level_len = level.len() as u64;
        buf.extend_from_slice(&level_len.to_le_bytes());
        for h in level.iter() {
            buf.extend_from_slice(&h.as_bytes());
        }
    }
    buf.extend_from_slice(&header_valid.hash_merkle_root.as_bytes());
    buf.extend_from_slice(&header_valid.accepted_id_merkle_root.as_bytes());
    buf.extend_from_slice(&header_valid.utxo_commitment.as_bytes());
    buf.extend_from_slice(&header_valid.timestamp.to_le_bytes());
    buf.extend_from_slice(&header_valid.bits.to_le_bytes());
    buf.extend_from_slice(&header_valid.nonce.to_le_bytes());
    buf.extend_from_slice(&header_valid.daa_score.to_le_bytes());
    buf.extend_from_slice(&header_valid.blue_score.to_le_bytes());
    let be_bytes = header_valid.blue_work.to_be_bytes();
    let start = be_bytes.iter().copied().position(|b| b != 0).unwrap_or(be_bytes.len());
    let work_slice = &be_bytes[start..];
    let work_len = work_slice.len() as u64;
    buf.extend_from_slice(&work_len.to_le_bytes());
    buf.extend_from_slice(work_slice);
    buf.extend_from_slice(&header_valid.pruning_point.as_bytes());

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // 1. Valid spend: push preimage, push redeem_script
    let mut sig_script = ScriptBuilder::with_flags(flags);
    sig_script.add_data(&buf).unwrap();
    sig_script.add_data(&redeem_script).unwrap();

    let tx = Transaction::new(
        0,
        vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_script.drain(), 0, 0)],
        vec![TransactionOutput::new(1000000, ScriptPublicKey::new(0, vec![0x51].into()))],
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
    let ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);
    let mut vm = TxScriptEngine::from_transaction_input(&populated_tx, &populated_tx.tx.inputs[0], 0, &populated_tx.entries[0], ctx, flags);

    let res = vm.execute();
    println!("VM execution with exact canonical header preimage: {:?}", res);
    assert!(res.is_ok(), "VM must succeed and OpChainblockSeqCommit must consume script-computed hash!");

    // 2. DAA Mutated Preimage spend
    let mut bad_buf = buf.clone();
    // DAA is located right after nonce:
    let last_idx = bad_buf.len() - 32 - 1 - 8 - 8 - 8; // near DAA
    bad_buf[last_idx] ^= 0x01; // flip 1 bit in DAA
    let mut bad_sig = ScriptBuilder::with_flags(flags);
    bad_sig.add_data(&bad_buf).unwrap();
    bad_sig.add_data(&redeem_script).unwrap();

    let bad_tx = Transaction::new(
        0,
        vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), bad_sig.drain(), 0, 0)],
        vec![TransactionOutput::new(1000000, ScriptPublicKey::new(0, vec![0x51].into()))],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let bad_entry = UtxoEntry::new(1000000, p2sh_spk, 562630000, false, None);
    let populated_bad_tx = PopulatedTransaction::new(&bad_tx, vec![bad_entry]);
    let cov_bad_ctx = CovenantsContext::from_tx(&populated_bad_tx).unwrap();
    let bad_ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_bad_ctx).with_seq_commit_accessor(&accessor);
    let mut bad_vm = TxScriptEngine::from_transaction_input(&populated_bad_tx, &populated_bad_tx.tx.inputs[0], 0, &populated_bad_tx.entries[0], bad_ctx, flags);
    let bad_res = bad_vm.execute();
    println!("VM execution with mutated DAA in preimage: {:?}", bad_res);
    assert!(bad_res.is_err(), "Mutated DAA must result in unknown hash and fail OpChainblockSeqCommit!");

    println!("\n>>> PHASE C VM DEMONSTRATION COMPLETE: SCRIPT RECONSTRUCTS BLOCKHASH AND BINDS DIRECTLY TO SEQCOMMIT! <<<");
}
