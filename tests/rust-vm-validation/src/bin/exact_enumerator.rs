use std::fs;
use std::str::FromStr;
use kaspa_hashes::Hash;
use kaspa_consensus_core::header::Header;
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

/// Exact-bytes enumerator for W' in 0..=24
fn enumerate_valid_w(header_bytes: &[u8]) -> Vec<usize> {
    let mut valid = Vec::new();
    let total_len = header_bytes.len();
    if total_len < 32 + 8 + 8 + 8 {
        return valid;
    }

    for w_candidate in 0..=24 {
        let suffix_len = 32 + w_candidate + 8 + 8 + 8;
        if total_len < suffix_len {
            continue;
        }

        // Slice from the tail
        let pruning_start = total_len - 32;
        let work_start = pruning_start - w_candidate;
        let work_len_start = work_start - 8;
        let blue_score_start = work_len_start - 8;
        let daa_start = blue_score_start - 8;

        let work = &header_bytes[work_start..pruning_start];
        let work_len_bytes = &header_bytes[work_len_start..work_start];

        // 1. Check decoded work_len
        let decoded_len = u64::from_le_bytes(work_len_bytes.try_into().unwrap());
        if decoded_len != w_candidate as u64 {
            continue;
        }

        // 2. Check no leading zero if W > 0
        if w_candidate > 0 && work[0] == 0 {
            continue;
        }

        valid.push(w_candidate);
    }
    valid
}

fn main() {
    println!("=== EXACT-BYTES ENUMERATOR VALIDATION ===");

    // 1. Real TN10 Headers
    let t_header = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/T-header.json");
    let p_header = parse_header_json("/root/kaswin/artifacts/tn10/phase-d/P-header.json");

    let t_bytes = serialize_full_header(&t_header);
    let p_bytes = serialize_full_header(&p_header);

    let t_valid = enumerate_valid_w(&t_bytes);
    let p_valid = enumerate_valid_w(&p_bytes);

    println!("Real TN10 P (W=7): canonical=7, valid candidates = {:?}", p_valid);
    println!("Real TN10 T (W=7): canonical=7, valid candidates = {:?}", t_valid);

    // 2. W=16 Fixture Construction
    println!("\n=== W=16 FIXTURE DUAL-PARSING AUDIT ===");
    let mut header_w16 = t_header.clone();
    let mut w16_work = [0u8; 24];
    // Work bytes: [08 00 00 00 00 00 00 00 | 01 11 22 33 44 55 66 77]
    w16_work[8..16].copy_from_slice(&[0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    w16_work[16..24].copy_from_slice(&[0x01, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    header_w16.blue_work = kaspa_consensus_core::BlueWorkType::from_be_bytes(w16_work);

    let w16_bytes = serialize_full_header(&header_w16);
    println!("W=16 Header total serialized bytes: {}", w16_bytes.len());

    let w16_valid = enumerate_valid_w(&w16_bytes);
    println!("W=16 Fixture valid candidates: {:?}", w16_valid);

    if w16_valid.len() > 1 {
        println!("\n>>> CRITICAL VULNERABILITY FOUND: Dual-parsing is REAL! Candidates: {:?} <<<", w16_valid);
        println!("Both W=16 and W'=8 are valid under current covenant grammar!");
    } else {
        println!("Single unique parse found.");
    }
}
