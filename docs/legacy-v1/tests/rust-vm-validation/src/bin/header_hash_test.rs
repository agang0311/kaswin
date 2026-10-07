use std::fs;
use std::str::FromStr;
use kaspa_hashes::Hash;
use kaspa_consensus_core::header::Header;
use serde_json::Value;

fn serialize_canonical_preimage(header: &Header) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&header.version.to_le_bytes());
    let expanded_len = header.parents_by_level.expanded_len() as u64;
    buf.extend_from_slice(&expanded_len.to_le_bytes());
    for level in header.parents_by_level.expanded_iter() {
        let level_len = level.len() as u64;
        buf.extend_from_slice(&level_len.to_le_bytes());
        for h in level.iter() {
            buf.extend_from_slice(&h.as_bytes());
        }
    }
    buf.extend_from_slice(&header.hash_merkle_root.as_bytes());
    buf.extend_from_slice(&header.accepted_id_merkle_root.as_bytes());
    buf.extend_from_slice(&header.utxo_commitment.as_bytes());
    buf.extend_from_slice(&header.timestamp.to_le_bytes());
    buf.extend_from_slice(&header.bits.to_le_bytes());
    buf.extend_from_slice(&header.nonce.to_le_bytes());
    buf.extend_from_slice(&header.daa_score.to_le_bytes());
    buf.extend_from_slice(&header.blue_score.to_le_bytes());
    let be_bytes = header.blue_work.to_be_bytes();
    let start = be_bytes.iter().copied().position(|b| b != 0).unwrap_or(be_bytes.len());
    let work_slice = &be_bytes[start..];
    let work_len = work_slice.len() as u64;
    buf.extend_from_slice(&work_len.to_le_bytes());
    buf.extend_from_slice(work_slice);
    buf.extend_from_slice(&header.pruning_point.as_bytes());
    buf
}

fn hash_preimage(preimage: &[u8]) -> Hash {
    let key = b"BlockHash";
    let hash_simd = blake2b_simd::Params::new().hash_length(32).key(key).to_state().update(preimage).finalize();
    Hash::from_slice(hash_simd.as_bytes())
}

fn main() {
    let json_str = fs::read_to_string("/root/kaswin/artifacts/tn10/phase-c/phase-c-T-header.json").unwrap();
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

    println!("=== 1. Valid Header Hash Verification ===");
    let valid_preimage = serialize_canonical_preimage(&header_valid);
    let valid_hash = hash_preimage(&valid_preimage);
    println!("Valid computed: {}", valid_hash);
    println!("Expected RPC:   {}", expected_hash);
    assert_eq!(valid_hash, expected_hash);
    println!("Result: MATCH\n");

    println!("=== 2. DAA Score Mutation Test (daa_score + 1) ===");
    let mut header_mutated_daa = header_valid.clone();
    header_mutated_daa.daa_score += 1;
    let mutated_daa_preimage = serialize_canonical_preimage(&header_mutated_daa);
    let mutated_daa_hash = hash_preimage(&mutated_daa_preimage);
    println!("Mutated DAA hash: {}", mutated_daa_hash);
    assert_ne!(mutated_daa_hash, expected_hash, "Mutated DAA must produce different hash!");
    println!("Result: REJECTED (Hash mismatch)\n");

    println!("=== 3. Parent[0] Mutation Test ===");
    let mut header_mutated_p0 = header_valid.clone();
    let mut mutated_parents = parents_by_level.clone();
    mutated_parents[0][0] = Hash::from_str("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();
    header_mutated_p0.parents_by_level = mutated_parents.try_into().unwrap();
    let mutated_p0_preimage = serialize_canonical_preimage(&header_mutated_p0);
    let mutated_p0_hash = hash_preimage(&mutated_p0_preimage);
    println!("Mutated Parent[0] hash: {}", mutated_p0_hash);
    assert_ne!(mutated_p0_hash, expected_hash, "Mutated Parent[0] must produce different hash!");
    println!("Result: REJECTED (Hash mismatch)\n");

    println!("=== 4. Nonce Mutation Test (nonce + 1) ===");
    let mut header_mutated_nonce = header_valid.clone();
    header_mutated_nonce.nonce += 1;
    let mutated_nonce_preimage = serialize_canonical_preimage(&header_mutated_nonce);
    let mutated_nonce_hash = hash_preimage(&mutated_nonce_preimage);
    println!("Mutated Nonce hash: {}", mutated_nonce_hash);
    assert_ne!(mutated_nonce_hash, expected_hash, "Mutated Nonce must produce different hash!");
    println!("Result: REJECTED (Hash mismatch)\n");

    println!(">>> ALL 4 MUTATION TESTS SUCCEEDED: DAA, PARENT0, AND NONCE ARE INSEPARABLY BOUND TO BLOCKHASH! <<<");
}
