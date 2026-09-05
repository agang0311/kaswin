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

fn append_forward_header_parser(sb: &mut ScriptBuilder, expanded_len: usize) {
    sb.add_i64(10).unwrap();
    for _ in 0..expanded_len {
        sb.add_op(OpOver).unwrap();
        sb.add_op(OpOver).unwrap();
        sb.add_op(OpDup).unwrap();
        sb.add_i64(8).unwrap();
        sb.add_op(OpAdd).unwrap();
        sb.add_op(OpSubstr).unwrap();
        sb.add_op(OpBin2Num).unwrap();
        sb.add_i64(32).unwrap();
        sb.add_op(OpMul).unwrap();
        sb.add_i64(8).unwrap();
        sb.add_op(OpAdd).unwrap();
        sb.add_op(OpAdd).unwrap();
    }
    sb.add_i64(116).unwrap();
    sb.add_op(OpAdd).unwrap();

    sb.add_op(OpOver).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpDup).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap();
}

fn build_script(delta_daa: i64, expanded_len: usize) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputDaaScore).unwrap();
    sb.add_i64(delta_daa).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpToAltStack).unwrap();

    // T:
    sb.add_op(OpDup).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_i64(10).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(expanded_len as i64).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_op(OpDup).unwrap();
    sb.add_i64(18).unwrap();
    sb.add_i64(50).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_parent0]

    sb.add_op(OpDup).unwrap();
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap();
    sb.add_op(OpChainblockSeqCommit).unwrap();
    sb.add_op(OpDrop).unwrap();

    append_forward_header_parser(&mut sb, expanded_len);
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_parent0, T_daa_num]
    sb.add_op(OpDrop).unwrap(); // drop H_T!

    // P:
    sb.add_op(OpDup).unwrap();
    sb.add_i64(2).unwrap();
    sb.add_i64(10).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(expanded_len as i64).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_op(OpDup).unwrap();
    sb.add_data(b"BlockHash").unwrap();
    sb.add_op(OpBlake2bWithKey).unwrap(); // [H_P, P_hash]

    sb.add_op(OpFromAltStack).unwrap(); // T_daa_num
    sb.add_op(OpFromAltStack).unwrap(); // T_parent0
    sb.add_op(OpRot).unwrap(); // [H_P, T_daa_num, T_parent0, P_hash]
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [boundary, T_daa_num]

    append_forward_header_parser(&mut sb, expanded_len);
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop H_P -> [P_daa_num]

    sb.add_op(OpFromAltStack).unwrap(); // T_daa_num
    sb.add_op(OpFromAltStack).unwrap(); // boundary

    sb.add_op(OpRot).unwrap();
    sb.add_op(OpOver).unwrap();
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

fn main() {
    let t_header = parse_header("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let p_header = parse_header("/root/kaswin/artifacts/tn10/phase-d/P-header.json");

    let t_bytes = serialize_full_header(&t_header);
    let p_bytes = serialize_full_header(&p_header);

    let expanded_len = 61;
    let delta_daa = 100i64;
    let d_arm = t_header.daa_score - 100;
    let seq_commit = t_header.accepted_id_merkle_root;

    let script = build_script(delta_daa, expanded_len);
    println!("Total script length: {} bytes", script.len());

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
    let pop = PopulatedTransaction::new(&tx, vec![UtxoEntry::new(1000000, p2sh_spk.clone(), d_arm, false, None)]);
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let cov_ctx = CovenantsContext::from_tx(&pop).unwrap();
    let ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);

    // Run VM with max limit to measure actual used_script_units
    let mut vm = TxScriptEngine::from_transaction_input(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx, flags);
    let res = vm.execute();
    println!("Execution result: {:?}", res);
    assert_eq!(res, Ok(()));

    // How many script units were used?
    let used_units = vm.used_script_units();
    println!("Actual used script units: {} units", used_units.0);

    let req_budget = (used_units.0 + SCRIPT_UNITS_PER_COMPUTE_BUDGET_UNIT - 1) / SCRIPT_UNITS_PER_COMPUTE_BUDGET_UNIT;
    println!("Required ComputeBudget units: {}", req_budget);
    let compute_mass = req_budget * 100;
    println!("Resulting compute mass: {} gram", compute_mass);

    // Test running with EXACT script units limit via from_transaction_input_with_script_units_limit!
    let ctx2 = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);
    let mut vm_limited = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop,
        &pop.tx.inputs[0],
        0,
        &pop.entries[0],
        ctx2,
        flags,
        used_units,
    );
    let res_limited = vm_limited.execute();
    println!("Execution with exact script units limit: {:?}", res_limited);
    assert_eq!(res_limited, Ok(()));

    // Test with used_units - 1 to prove that the limit is enforced strictly!
    let ctx3 = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&accessor);
    let mut vm_too_tight = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop,
        &pop.tx.inputs[0],
        0,
        &pop.entries[0],
        ctx3,
        flags,
        used_units - kaspa_consensus_core::mass::ScriptUnits(1),
    );
    let res_too_tight = vm_too_tight.execute();
    println!("Execution with (used_units - 1): {:?}", res_too_tight);
    assert!(matches!(res_too_tight, Err(TxScriptError::ExceededCommittedScriptUnits { .. })));
    println!(">>> Script units meter strictly validated! <<<");
}
