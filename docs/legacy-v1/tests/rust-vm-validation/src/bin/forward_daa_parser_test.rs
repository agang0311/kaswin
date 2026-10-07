use std::fs;
use std::str::FromStr;
use kaspa_hashes::Hash;
use kaspa_consensus_core::header::Header;
use kaspa_txscript::{
    TxScriptEngine, EngineFlags,
    script_builder::ScriptBuilder, opcodes::codes::*,
};
use serde_json::Value;

fn parse_header_json(path: &str) -> Header {
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
    println!("=== Testing Unrolled Forward DAA Offset Parser in Kaspa Script ===");

    let t_header = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let t_bytes = serialize_full_header(&t_header);
    println!("Total header preimage length: {} bytes", t_bytes.len());

    let expanded_len = t_header.parents_by_level.expanded_len();
    println!("Expanded parent levels count: {}", expanded_len);

    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Witness pushes H (entire preimage) on stack.
    // Stack: [H]
    // 1. Initial offset = 10 (2B version + 8B expanded_len)
    sb.add_i64(10).unwrap();
    // Stack: [H, offset]

    // 2. Unroll expanded_len levels:
    for _ in 0..expanded_len {
        // Stack: [H, current_offset]
        sb.add_op(OpOver).unwrap(); // [H, offset, H]
        sb.add_op(OpOver).unwrap(); // [H, offset, H, offset]
        sb.add_op(OpDup).unwrap();  // [H, offset, H, offset, offset]
        sb.add_i64(8).unwrap();
        sb.add_op(OpAdd).unwrap();  // [H, offset, H, offset, offset + 8]
        sb.add_op(OpSubstr).unwrap(); // [H, offset, level_len_bytes (8B)]
        sb.add_op(OpBin2Num).unwrap(); // [H, offset, k_i]
        sb.add_i64(32).unwrap();
        sb.add_op(OpMul).unwrap();  // [H, offset, 32 * k_i]
        sb.add_i64(8).unwrap();
        sb.add_op(OpAdd).unwrap();  // [H, offset, 8 + 32 * k_i]
        sb.add_op(OpAdd).unwrap();  // [H, new_offset]
    }

    // Stack: [H, parents_end_offset]
    // 3. Add 116 (fixed middle fields length)
    sb.add_i64(116).unwrap();
    sb.add_op(OpAdd).unwrap();
    // Stack: [H, daa_offset]

    // 4. Slice DAA (8 bytes at daa_offset..daa_offset + 8)
    sb.add_op(OpOver).unwrap(); // [H, daa_offset, H]
    sb.add_op(OpOver).unwrap(); // [H, daa_offset, H, daa_offset]
    sb.add_op(OpDup).unwrap();
    sb.add_i64(8).unwrap();
    sb.add_op(OpAdd).unwrap();  // [H, daa_offset, H, daa_offset, daa_offset + 8]
    sb.add_op(OpSubstr).unwrap(); // [H, daa_offset, daa_bytes (8B)]
    sb.add_op(OpBin2Num).unwrap(); // [H, daa_offset, daa_score]

    // 5. Compare with expected DAA
    sb.add_i64(t_header.daa_score as i64).unwrap();
    sb.add_op(OpEqual).unwrap();
    // Stack: [H, daa_offset, is_daa_equal]
    sb.add_op(OpVerify).unwrap();

    // 6. Also extract direct_parents()[0] at 18..50 from H:
    sb.add_op(OpDrop).unwrap(); // drop daa_offset
    // Stack: [H]
    sb.add_i64(18).unwrap();
    sb.add_i64(50).unwrap();
    sb.add_op(OpSubstr).unwrap();
    // Stack: [parent0]
    sb.add_data(&t_header.parents_by_level.get(0).unwrap()[0].as_bytes()).unwrap();
    sb.add_op(OpEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpTrue).unwrap();

    let script = sb.drain();
    println!("Script length for {} levels: {} bytes", expanded_len, script.len());

    // Execute in TxScriptEngine!
    use kaspa_consensus_core::subnets::SubnetworkId;
    use kaspa_consensus_core::tx::{
        Transaction, TransactionInput, TransactionOutpoint,
        ScriptPublicKey, UtxoEntry, PopulatedTransaction,
    };
    use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
    use kaspa_txscript::{caches::Cache, covenants::CovenantsContext, engine_context::EngineContext};

    let mut sig = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sig.add_data(&t_bytes).unwrap();
    sig.add_data(&script).unwrap();

    let tx = Transaction::new(0, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig.drain(), 0, 0)], vec![], 0, SubnetworkId::default(), 0, vec![]);
    let p2sh = kaspa_txscript::pay_to_script_hash_script(&script);
    let entry = UtxoEntry::new(1000000, p2sh, 562630000, false, None);
    let pop = PopulatedTransaction::new(&tx, vec![entry]);
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let cov_ctx = CovenantsContext::from_tx(&pop).unwrap();
    let ctx = EngineContext::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
    let mut vm = TxScriptEngine::from_transaction_input(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx, EngineFlags { covenants_enabled: true, ..Default::default() });

    let res = vm.execute();
    println!("VM Execution Result: {:?}", res);
    assert!(res.is_ok(), "Forward DAA Offset Parser in Kaspa Script must execute Ok(())!");
    println!(">>> FORWARD DAA PARSER EXECUTED AND FULLY VALIDATED IN KASPA VM! <<<");
}
