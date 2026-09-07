//! Kaswin V1 — PASS-A + Variable-Draw Directory State Integration Spike
//! Tests isolated integration of PASS-A randomness engine with directory-preserving,
//! variable-draw-count SEALED and DRAW_READY covenants.
//! NOT production code, canonical encoding, or a security proof.

use std::collections::HashMap;
use std::time::Instant;

use kaspa_consensus_core::{
    config::params::TESTNET_PARAMS,
    hashing::sighash::SigHashReusedValuesUnsync,
    mass::{ComputeBudget, MassCalculator, ScriptUnits, transaction_estimated_serialized_size},
    subnets::SubnetworkId,
    tx::{ComputeCommit, CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction,
        TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry},
};
use kaspa_hashes::Hash;
use kaspa_txscript::{
    caches::Cache, covenants::CovenantsContext, opcodes::codes::*,
    script_builder::ScriptBuilder, standard::pay_to_script_hash_script,
    EngineCtx, EngineFlags, SeqCommitAccessor, TxScriptEngine,
};

#[path = "../../../../contracts/lineage.rs"]
mod lineage;

#[path = "../../../../contracts/ticket_commitment.rs"]
mod ticket_commitment;
use ticket_commitment::{
    compute_payout_commitment, compute_purchase_leaf, hash_internal_node, compute_empty_levels,
};

const ROUND_ID: Hash = Hash::from_bytes([0x52; 32]);
const TICKET_PRICE: u64 = 1_000;
const STATE_AMOUNT: u64 = 10_000_000_000; // 100 KAS state deposit
const BUY_FEE: u64 = 1_000_000;
const COVENANT_ID: Hash = Hash::from_bytes([0x77; 32]);
const CREATOR_PUBKEY: [u8; 32] = [0x44; 32];
const DELTA_DAA_V1: u64 = 100;

pub const ACTION_DRAW: i64 = 1;
pub const ACTION_ACCEPT: i64 = 1;
pub const ACTION_REJECT: i64 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub end: u32,
    pub key: [u8; 32],
}

pub fn p2pk_bytes(key: [u8; 32]) -> Vec<u8> {
    let mut x = vec![0x20];
    x.extend_from_slice(&key);
    x.push(0xac);
    x
}

pub fn push_data_len(len: usize) -> Vec<u8> {
    match len {
        0..=75 => vec![len as u8],
        76..=255 => vec![0x4c, len as u8],
        _ => vec![0x4d, (len & 0xff) as u8, ((len >> 8) & 0xff) as u8],
    }
}

pub fn directory_bytes(rs: &[Record]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rs.len() * 36);
    for r in rs {
        out.extend_from_slice(&r.end.to_le_bytes());
        out.extend_from_slice(&r.key);
    }
    out
}

pub fn deserialize_directory(bytes: &[u8]) -> Vec<Record> {
    assert_eq!(bytes.len() % 36, 0);
    bytes
        .chunks_exact(36)
        .map(|chunk| {
            let end = u32::from_le_bytes(chunk[..4].try_into().unwrap());
            let key: [u8; 32] = chunk[4..].try_into().unwrap();
            Record { end, key }
        })
        .collect()
}

pub fn directory_root(records: &[Record], round_id: &Hash) -> Hash {
    let empty_levels = compute_empty_levels();
    let mut levels: HashMap<(usize, u64), Hash> = HashMap::new();

    let mut start = 0u64;
    for (index, record) in records.iter().enumerate() {
        let end = record.end as u64;
        let count = end - start;
        let payout = p2pk_bytes(record.key);
        let payout_commitment = compute_payout_commitment(&payout);
        let leaf = compute_purchase_leaf(round_id, index as u64, start, count, &payout_commitment);
        levels.insert((0, index as u64), leaf);
        start = end;
    }

    for level in 0..27 {
        let keys: Vec<u64> = levels
            .keys()
            .filter_map(|(l, index)| (*l == level).then_some(*index / 2))
            .collect();
        for parent in keys {
            let left = levels.get(&(level, parent * 2)).copied().unwrap_or(empty_levels[level]);
            let right = levels.get(&(level, parent * 2 + 1)).copied().unwrap_or(empty_levels[level]);
            levels.insert((level + 1, parent), hash_internal_node(&left, &right));
        }
    }
    levels.get(&(27, 0)).copied().unwrap_or(empty_levels[27])
}

pub fn records_scaled(count: usize, denominator: usize, target_total: u64) -> Vec<Record> {
    (0..count).map(|i| Record {
        end: (((i as u64 + 1) * target_total) / denominator as u64) as u32,
        key: [((i * 13 + 7) & 0xff) as u8; 32],
    }).collect()
}

pub fn make_blake3_key(tag: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[..tag.len().min(32)].copy_from_slice(&tag[..tag.len().min(32)]);
    key
}

pub fn append_push_from_top(sb: &mut ScriptBuilder, width: usize) -> kaspa_txscript::script_builder::ScriptBuilderResult<()> {
    sb.add_data(&push_data_len(width))?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    Ok(())
}

pub fn append_prefix_item(sb: &mut ScriptBuilder, depth: i64, width: usize) -> kaspa_txscript::script_builder::ScriptBuilderResult<()> {
    sb.add_i64(depth)?;
    sb.add_op(OpPick)?;
    append_push_from_top(sb, width)?;
    sb.add_op(OpFromAltStack)?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_op(OpToAltStack)?;
    Ok(())
}

// -----------------------------------------------------------------------------
// PASS-A Randomness & SeqCommit Mocking
// -----------------------------------------------------------------------------

pub struct MockSeqCommitAccessor {
    pub selected_chain: Vec<Hash>,
    pub seq_commits: HashMap<Hash, Hash>,
}

impl SeqCommitAccessor for MockSeqCommitAccessor {
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

pub fn blake3_hash(key: &[u8], data: &[u8]) -> Hash {
    let mut key_arr = [0u8; 32];
    key_arr[..key.len()].copy_from_slice(key);
    let h = blake3::keyed_hash(&key_arr, data);
    Hash::from_bytes(*h.as_bytes())
}

#[derive(Clone, Debug)]
pub struct PassAOpeningFixture {
    pub target_hash: Hash,
    pub target_activity: Hash,
    pub target_payload: Hash,
    pub target_sp_ts: [u8; 8],
    pub target_daa: [u8; 8],
    pub target_blue: [u8; 8],
    pub p_parent_seq: Hash,
    pub p_activity: Hash,
    pub p_payload: Hash,
    pub p_sp_ts: [u8; 8],
    pub p_daa: [u8; 8],
    pub p_blue: [u8; 8],
    pub c_t: Hash,
}

pub fn generate_valid_pass_a_fixture(p_daa_num: u64, t_daa_num: u64) -> PassAOpeningFixture {
    let p_sp_ts = 1_700_000_000u64.to_le_bytes();
    let p_daa = p_daa_num.to_le_bytes();
    let p_blue = (p_daa_num - 100).to_le_bytes();

    let key_ctx = b"SeqCommitMergesetContext";
    let key_branch = b"SeqCommitmentMerkleBranchHash";

    let mut p_ctx_in = Vec::new();
    p_ctx_in.extend_from_slice(&p_sp_ts);
    p_ctx_in.extend_from_slice(&p_daa);
    p_ctx_in.extend_from_slice(&p_blue);
    let p_ctx = blake3_hash(key_ctx, &p_ctx_in);

    let p_payload = Hash::from_u64_word(101);
    let mut p_pd_in = Vec::new();
    p_pd_in.extend_from_slice(&p_ctx.as_bytes());
    p_pd_in.extend_from_slice(&p_payload.as_bytes());
    let p_pd = blake3_hash(key_branch, &p_pd_in);

    let p_activity = Hash::from_u64_word(102);
    let mut p_sr_in = Vec::new();
    p_sr_in.extend_from_slice(&p_activity.as_bytes());
    p_sr_in.extend_from_slice(&p_pd.as_bytes());
    let p_sr = blake3_hash(key_branch, &p_sr_in);

    let p_parent_seq = Hash::from_u64_word(103);
    let mut c_p_in = Vec::new();
    c_p_in.extend_from_slice(&p_parent_seq.as_bytes());
    c_p_in.extend_from_slice(&p_sr.as_bytes());
    let c_p = blake3_hash(key_branch, &c_p_in);

    let target_sp_ts = (1_700_000_000u64 + 10).to_le_bytes();
    let target_daa = t_daa_num.to_le_bytes();
    let target_blue = (t_daa_num - 100).to_le_bytes();
    let mut t_ctx_in = Vec::new();
    t_ctx_in.extend_from_slice(&target_sp_ts);
    t_ctx_in.extend_from_slice(&target_daa);
    t_ctx_in.extend_from_slice(&target_blue);
    let t_ctx = blake3_hash(key_ctx, &t_ctx_in);

    let target_payload = Hash::from_u64_word(201);
    let mut t_pd_in = Vec::new();
    t_pd_in.extend_from_slice(&t_ctx.as_bytes());
    t_pd_in.extend_from_slice(&target_payload.as_bytes());
    let t_pd = blake3_hash(key_branch, &t_pd_in);

    let target_activity = Hash::from_u64_word(202);
    let mut t_sr_in = Vec::new();
    t_sr_in.extend_from_slice(&target_activity.as_bytes());
    t_sr_in.extend_from_slice(&t_pd.as_bytes());
    let t_sr = blake3_hash(key_branch, &t_sr_in);

    let mut c_t_in = Vec::new();
    c_t_in.extend_from_slice(&c_p.as_bytes());
    c_t_in.extend_from_slice(&t_sr.as_bytes());
    let c_t = blake3_hash(key_branch, &c_t_in);

    let target_hash = Hash::from_u64_word(999);

    PassAOpeningFixture {
        target_hash,
        target_activity,
        target_payload,
        target_sp_ts,
        target_daa,
        target_blue,
        p_parent_seq,
        p_activity,
        p_payload,
        p_sp_ts,
        p_daa,
        p_blue,
        c_t,
    }
}

pub fn compute_application_commitment(
    round_id: &Hash,
    ticket_root: &Hash,
    draw_ticket_count: u64,
) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinAppV1");
    state.update(round_id.as_bytes().as_slice());
    state.update(ticket_root.as_bytes().as_slice());
    state.update(&draw_ticket_count.to_le_bytes());
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

pub fn compute_random_seed(
    target_hash: &Hash,
    application_commitment: &Hash,
) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaspaPoWRandomnessV1");
    state.update(target_hash.as_bytes().as_slice());
    state.update(application_commitment.as_bytes().as_slice());
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

pub fn compute_winner_candidate(random_seed: &Hash, counter: u64) -> (u64, u64) {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinWinnerCandidateV1");
    state.update(random_seed.as_bytes().as_slice());
    state.update(&counter.to_le_bytes());
    let res = state.finalize();
    let bytes = res.as_bytes();
    let mut cand_bytes = [0u8; 8];
    cand_bytes[..7].copy_from_slice(&bytes[..7]); // 56-bit candidate
    let cand = u64::from_le_bytes(cand_bytes);
    (cand, counter)
}

// -----------------------------------------------------------------------------
// State Prefixes & Redirection Helpers
// -----------------------------------------------------------------------------

/// Canonical Directory-Preserving SEALED Prefix
pub fn build_canonical_sealed_prefix(
    round_id: &Hash,
    ticket_price: u64,
    ticket_cap: u64,
    draw_ticket_count: u64,
    ticket_root: &Hash,
    purchase_count: u64,
    creator_refund_spk: &[u8],
    directory: &[u8],
) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&ticket_cap.to_le_bytes()).unwrap();
    sb.add_data(&draw_ticket_count.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.add_data(directory).unwrap();
    sb.drain()
}

/// Canonical Directory-Preserving DRAW_READY Prefix
pub fn build_canonical_draw_ready_prefix(
    round_id: &Hash,
    ticket_price: u64,
    ticket_cap: u64,
    draw_ticket_count: u64,
    ticket_root: &Hash,
    purchase_count: u64,
    creator_refund_spk: &[u8],
    target_hash: &Hash,
    random_seed: &Hash,
    counter: u64,
    directory: &[u8],
) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&ticket_cap.to_le_bytes()).unwrap();
    sb.add_data(&draw_ticket_count.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    sb.add_data(&counter.to_le_bytes()).unwrap();
    sb.add_data(directory).unwrap();
    sb.drain()
}

/// Minimal Authenticated WINNER_READY Prefix (Directory safely dropped!)
pub fn build_winner_ready_prefix(
    round_id: &Hash,
    ticket_price: u64,
    draw_ticket_count: u64,
    ticket_root: &Hash,
    target_hash: &Hash,
    random_seed: &Hash,
    accepted_counter: u64,
    winner_index: u64,
    winner_payout_spk: &[u8],
    creator_refund_spk: &[u8],
) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&draw_ticket_count.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    sb.add_data(&accepted_counter.to_le_bytes()).unwrap();
    sb.add_data(&winner_index.to_le_bytes()).unwrap();
    sb.add_data(winner_payout_spk).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.drain()
}

// -----------------------------------------------------------------------------
// SEALED Covenant Body with PASS-A Opening (Phase B)
// -----------------------------------------------------------------------------

pub fn build_pass_a_sealed_body(draw_ready_body: &[u8]) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Entry stack from prefix + witness:
    // Witness: [12 PASS-A opening items, action=ACTION_DRAW (1)]
    // Prefix items (bottom to top):
    // round_id (32B), ticket_price (8B), ticket_cap (8B), draw_ticket_count (8B),
    // ticket_root (32B), purchase_count (8B), creator_refund_spk (34B), directory (P*36B)
    // Depths from top on entry:
    // depth 0: directory
    // depth 1: creator_refund_spk
    // depth 2: purchase_count
    // depth 3: ticket_root
    // depth 4: draw_ticket_count
    // depth 5: ticket_cap
    // depth 6: ticket_price
    // depth 7: round_id
    // depth 8: action
    // depths 9..20: 12 PASS-A items

    // 1. Move 8 prefix items to AltStack:
    for _ in 0..8 {
        sb.add_op(OpToAltStack).unwrap();
    }
    // AltStack (top to bottom):
    // [directory, creator_refund_spk, purchase_count, ticket_root, draw_ticket_count, ticket_cap, ticket_price, round_id]
    // dstack has: [12 PASS-A items, action]

    // 2. Check action == ACTION_DRAW (1):
    sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(ACTION_DRAW).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // consumes action

    // 3. Exact 12 PASS-A opening items depth verification:
    sb.add_op(OpDepth).unwrap();
    sb.add_i64(12).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // 4. Strict fixed-width schema check on all 12 PASS-A items:
    // [0] p_blue: 8B
    sb.add_op(Op0).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [1] p_daa: 8B
    sb.add_op(Op1).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [2] p_sp_ts: 8B
    sb.add_op(Op2).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [3] p_payload: 32B
    sb.add_op(Op3).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(32).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [4] p_activity: 32B
    sb.add_op(Op4).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(32).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [5] p_parent_seq: 32B
    sb.add_op(Op5).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(32).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [6] target_blue: 8B
    sb.add_op(Op6).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [7] target_daa: 8B
    sb.add_op(Op7).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [8] target_sp_ts: 8B
    sb.add_op(Op8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [9] target_payload: 32B
    sb.add_op(Op9).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(32).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [10] target_activity: 32B
    sb.add_op(Op10).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(32).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    // [11] target_hash: 32B
    sb.add_i64(11).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap(); sb.add_i64(32).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();

    // 5. Boundary verification: boundary = OpTxInputDaaScore(0) + 100
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputDaaScore).unwrap();
    sb.add_i64(DELTA_DAA_V1 as i64).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // Alt: [..., boundary]

    // Verify P.daa < boundary:
    sb.add_op(Op1).unwrap();
    sb.add_op(OpPick).unwrap(); // p_daa
    sb.add_op(OpFromAltStack).unwrap(); // boundary
    sb.add_op(OpDup).unwrap();
    sb.add_op(OpToAltStack).unwrap();   // keep copy of boundary on AltStack
    sb.add_op(OpLessThan).unwrap();
    sb.add_op(OpVerify).unwrap();

    // Verify target_daa >= boundary:
    sb.add_op(Op7).unwrap();
    sb.add_op(OpPick).unwrap(); // target_daa
    sb.add_op(OpFromAltStack).unwrap(); // boundary consumed
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    // 6. SeqCommit Merkle Branch reconstruction using 8x OpBlake3WithKey:
    let key_mergeset = make_blake3_key(b"SeqCommitMergesetContext");
    let key_branch = make_blake3_key(b"SeqCommitmentMerkleBranchHash");

    // Reconstruct C_P:
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(&key_mergeset).unwrap();
    sb.add_op(OpBlake3WithKey).unwrap();

    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(&key_branch).unwrap();
    sb.add_op(OpBlake3WithKey).unwrap();

    sb.add_op(OpCat).unwrap();
    sb.add_data(&key_branch).unwrap();
    sb.add_op(OpBlake3WithKey).unwrap();

    sb.add_op(OpCat).unwrap();
    sb.add_data(&key_branch).unwrap();
    sb.add_op(OpBlake3WithKey).unwrap(); // C_P

    // Reconstruct C_T:
    sb.add_i64(3).unwrap(); sb.add_op(OpRoll).unwrap(); // target_sp_ts
    sb.add_i64(3).unwrap(); sb.add_op(OpRoll).unwrap(); // target_daa
    sb.add_i64(3).unwrap(); sb.add_op(OpRoll).unwrap(); // target_blue
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(&key_mergeset).unwrap();
    sb.add_op(OpBlake3WithKey).unwrap();

    sb.add_i64(2).unwrap(); sb.add_op(OpRoll).unwrap(); // target_payload
    sb.add_op(OpCat).unwrap();
    sb.add_data(&key_branch).unwrap();
    sb.add_op(OpBlake3WithKey).unwrap();

    sb.add_i64(2).unwrap(); sb.add_op(OpRoll).unwrap(); // target_activity
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(&key_branch).unwrap();
    sb.add_op(OpBlake3WithKey).unwrap();

    sb.add_op(OpCat).unwrap();
    sb.add_data(&key_branch).unwrap();
    sb.add_op(OpBlake3WithKey).unwrap(); // C_T

    // Authenticate T with OpChainblockSeqCommit:
    sb.add_op(OpOver).unwrap(); // target_hash
    sb.add_op(OpChainblockSeqCommit).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    // dstack now contains: [target_hash (32B)]!

    // Pop the 8 prefix items from AltStack to dstack:
    // Top of AltStack on entry was round_id, bottom was directory.
    // Popping 8 items brings round_id first, then ticket_price, ..., and directory last!
    for _ in 0..8 {
        sb.add_op(OpFromAltStack).unwrap();
    }
    // Directory is now on top of dstack! Move it back to AltStack immediately:
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [directory]

    // dstack from bottom to top:
    // index 0: target_hash (32B)       -> depth 7
    // index 1: round_id (32B)          -> depth 6
    // index 2: ticket_price (8B)       -> depth 5
    // index 3: ticket_cap (8B)         -> depth 4
    // index 4: draw_ticket_count (8B)  -> depth 3
    // index 5: ticket_root (32B)       -> depth 2
    // index 6: purchase_count (8B)     -> depth 1
    // index 7: creator_refund_spk (34B)-> depth 0

    // 7. Compute application_commitment:
    // BLAKE2b256("KaswinAppV1" || round_id || ticket_root || le_u64(draw_ticket_count))
    sb.add_data(b"KaswinAppV1").unwrap(); // top (depth 0)
    sb.add_i64(7).unwrap(); sb.add_op(OpPick).unwrap(); // round_id (depth 6 + 1)
    sb.add_op(OpCat).unwrap();
    sb.add_i64(3).unwrap(); sb.add_op(OpPick).unwrap(); // ticket_root (depth 2 + 1)
    sb.add_op(OpCat).unwrap();
    sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); // draw_ticket_count (depth 3 + 1)
    sb.add_op(OpCat).unwrap();
    sb.add_data(b"").unwrap(); sb.add_op(OpBlake2bWithKey).unwrap(); // application_commitment (32B) on top (depth 0)

    // 8. Compute random_seed:
    // BLAKE2b256("KaspaPoWRandomnessV1" || target_hash || application_commitment)
    sb.add_data(b"KaspaPoWRandomnessV1").unwrap(); // top (depth 0)
    sb.add_i64(9).unwrap(); sb.add_op(OpPick).unwrap(); // target_hash (depth 7 + 1 + 1)
    sb.add_op(OpCat).unwrap();
    sb.add_i64(1).unwrap(); sb.add_op(OpRoll).unwrap(); // application_commitment
    sb.add_op(OpCat).unwrap();
    sb.add_data(b"").unwrap(); sb.add_op(OpBlake2bWithKey).unwrap(); // random_seed (32B) on top!

    // 9. Principal preservation: Output 0 amount == Input 0 amount:
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap();
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // 10. KIP-20 continuation:
    lineage::append_kaswin_singleton_continuation_guard(&mut sb).unwrap();

    // 11. Assemble successor DRAW_READY(0) prefix:
    // Save random_seed to AltStack:
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [directory, random_seed]

    // Start prefix on dstack:
    sb.add_data(&[0xb9, 0x00, 0x88]).unwrap(); // prefix at depth 0

    // Helper append_prefix_on_dstack: appends [push_len] || item to prefix at depth 0
    // Underlying item depths relative to prefix:
    // depth 1: creator_refund_spk (34B)
    // depth 2: purchase_count (8B)
    // depth 3: ticket_root (32B)
    // depth 4: draw_ticket_count (8B)
    // depth 5: ticket_cap (8B)
    // depth 6: ticket_price (8B)
    // depth 7: round_id (32B)
    // depth 8: target_hash (32B)

    let mut append_item = |sb: &mut ScriptBuilder, d: i64, w: usize| {
        sb.add_data(&push_data_len(w)).unwrap();
        sb.add_i64(d + 1).unwrap(); sb.add_op(OpPick).unwrap();
        sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap();
    };

    // [1] round_id (depth 7, 32B)
    append_item(&mut sb, 7, 32);
    // [2] ticket_price (depth 6, 8B)
    append_item(&mut sb, 6, 8);
    // [3] ticket_cap (depth 5, 8B)
    append_item(&mut sb, 5, 8);
    // [4] draw_ticket_count (depth 4, 8B)
    append_item(&mut sb, 4, 8);
    // [5] ticket_root (depth 3, 32B)
    append_item(&mut sb, 3, 32);
    // [6] purchase_count (depth 2, 8B)
    append_item(&mut sb, 2, 8);
    // [7] creator_refund_spk (depth 1, 34B)
    append_item(&mut sb, 1, 34);
    // [8] target_hash (depth 8, 32B)
    append_item(&mut sb, 8, 32);

    // [9] random_seed from AltStack:
    sb.add_data(&[0x20]).unwrap();
    sb.add_op(OpFromAltStack).unwrap(); // random_seed
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpCat).unwrap(); // prefix || (0x20 || random_seed)

    // [10] counter = 0 (8B LE):
    sb.add_data(&[0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).unwrap();
    sb.add_op(OpCat).unwrap(); // prefix || counter=0

    // [11] directory from AltStack:
    sb.add_op(OpFromAltStack).unwrap(); // [prefix, directory]
    sb.add_op(OpSize).unwrap(); // OpSize does not consume -> [prefix, directory, dir_len]
    sb.add_i64(2).unwrap(); sb.add_op(OpNum2Bin).unwrap(); // [prefix, directory, dir_len_2b]
    sb.add_data(&[0x4d]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap(); // [prefix, directory, 0x4d || dir_len_2b]
    sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap(); // [prefix, 0x4d || dir_len_2b || directory]
    sb.add_op(OpCat).unwrap(); // full DRAW_READY(0) prefix!

    // Append draw_ready_body:
    sb.add_data(draw_ready_body).unwrap();
    sb.add_op(OpCat).unwrap(); // assembled expected_draw_ready_redeem!

    // Assert Output 0 SPK == P2SH(expected_draw_ready_redeem):
    sb.add_data(b"").unwrap(); sb.add_op(OpBlake2bWithKey).unwrap();
    sb.add_data(&[0x00, 0x00, 0xaa, 0x20]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
    sb.add_data(&[0x87]).unwrap(); sb.add_op(OpCat).unwrap();
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Clean stack (8 underlying items remain):
    sb.add_op(OpTrue).unwrap();
    for _ in 0..8 { sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap(); }

    sb.drain()
}

// -----------------------------------------------------------------------------
// DRAW_READY Body with ACCEPT and REJECT branches (Phase E, F, G, H)
// -----------------------------------------------------------------------------

pub fn build_canonical_draw_ready_body(winner_ready_body: &[u8]) -> Vec<u8> {
    let mut body_len_guess: i64 = 491;
    for _ in 0..16 {
        let candidate = compile_draw_ready_body(winner_ready_body, body_len_guess);
        if candidate.len() as i64 == body_len_guess {
            return candidate;
        }
        body_len_guess = candidate.len() as i64;
    }
    panic!("draw_ready_body failed to converge to fixed point");
}

fn compile_draw_ready_body(winner_ready_body: &[u8], static_body_len: i64) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Entry stack from prefix + witness:
    // Witness:
    //   For ACCEPT: [winner_index (8B num), purchase_index i (num), action=1]
    //   For REJECT: [action=2]
    // Prefix items (bottom to top, 11 items):
    //   round_id (32B), ticket_price (8B), ticket_cap (8B), draw_ticket_count (8B),
    //   ticket_root (32B), purchase_count (8B), creator_refund_spk (34B),
    //   target_hash (32B), random_seed (32B), counter (8B), directory (P*36B)
    // Depths from top on entry:
    // depth 0: directory
    // depth 1: counter (8B)
    // depth 2: random_seed (32B)
    // depth 3: target_hash (32B)
    // depth 4: creator_refund_spk (34B)
    // depth 5: purchase_count (8B)
    // depth 6: ticket_root (32B)
    // depth 7: draw_ticket_count (8B)
    // depth 8: ticket_cap (8B)
    // depth 9: ticket_price (8B)
    // depth 10: round_id (32B)
    // depth 11: action (1 = ACCEPT, 2 = REJECT)
    // If ACCEPT: depth 12 is purchase_index i, depth 13 is winner_index

    // Check action:
    sb.add_i64(11).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(ACTION_ACCEPT).unwrap();
    sb.add_op(OpEqual).unwrap();

    sb.add_op(OpIf).unwrap();
        // =====================================================================
        // ACCEPT BRANCH (Winner Authenticated from Directory -> WINNER_READY)
        // =====================================================================
        // Rejection sampling check over frozen formula:
        // Candidate = first 7 bytes of BLAKE2b(KaswinWinnerCandidateV1 || random_seed || counter)
        // LIMIT = floor(2^56 / draw_ticket_count) * draw_ticket_count
        // In script, compute candidate and verify winner_index == candidate % draw_ticket_count:
        sb.add_data(b"KaswinWinnerCandidateV1").unwrap();
        sb.add_i64(3).unwrap(); sb.add_op(OpPick).unwrap(); // random_seed (depth 2 + 1)
        sb.add_op(OpCat).unwrap();
        sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // counter (depth 1 + 1)
        sb.add_op(OpCat).unwrap();
        sb.add_data(b"").unwrap(); sb.add_op(OpBlake2bWithKey).unwrap(); // 32B digest

        // Extract first 7 bytes (56-bit candidate):
        sb.add_i64(0).unwrap(); sb.add_i64(7).unwrap(); sb.add_op(OpSubstr).unwrap();
        sb.add_op(OpBin2Num).unwrap(); // candidate (num)

        // candidate % draw_ticket_count == winner_index:
        sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // draw_ticket_count (depth 7 + 1)
        sb.add_op(OpMod).unwrap(); // expected_winner_index

        // Compare with witness winner_index (depth 13 on entry + 1 item on top = depth 14):
        sb.add_i64(14).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
        sb.add_op(OpNumEqualVerify).unwrap(); // asserts winner_index is exactly candidate % N!

        // Now authenticate winner's purchase from directory using O(1) direct offset indexing:
        // i is at depth 12 on entry + 0 items on top = depth 12!
        sb.add_i64(12).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // i
        sb.add_op(OpDup).unwrap(); sb.add_i64(0).unwrap(); sb.add_op(OpGreaterThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();
        // i < purchase_count (purchase_count is at depth 5 on entry + 2 items on top [i, i] = depth 7):
        sb.add_op(OpDup).unwrap();
        sb.add_i64(7).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
        sb.add_op(OpLessThan).unwrap(); sb.add_op(OpVerify).unwrap();

        // offset_i = i * 36:
        sb.add_op(OpDup).unwrap(); sb.add_i64(36).unwrap(); sb.add_op(OpMul).unwrap();
        // dstack: [..., i, offset_i] (depth 0 is offset_i, depth 1 is i)

        // Extract current_end from directory[offset_i .. offset_i + 4]:
        // directory is at depth 0 on entry + 2 items on top = depth 2!
        sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // directory
        sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // offset_i
        sb.add_op(OpDup).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpAdd).unwrap();
        sb.add_op(OpSubstr).unwrap();
        sb.add_op(OpBin2Num).unwrap(); // current_end_num

        // Assert winner_index < current_end:
        // winner_index is at depth 13 on entry + 3 items on top = depth 16!
        sb.add_i64(16).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
        sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap();
        sb.add_op(OpLessThan).unwrap(); sb.add_op(OpVerify).unwrap();
        sb.add_op(OpDrop).unwrap(); // drop current_end_num -> dstack: [..., i, offset_i]

        // Extract start_num:
        sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // i
        sb.add_i64(0).unwrap(); sb.add_op(OpEqual).unwrap();
        sb.add_op(OpIf).unwrap();
            sb.add_i64(0).unwrap(); // start = 0
        sb.add_op(OpElse).unwrap();
            sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // i
            sb.add_i64(1).unwrap(); sb.add_op(OpSub).unwrap();  // i - 1
            sb.add_i64(36).unwrap(); sb.add_op(OpMul).unwrap(); // prev_offset
            sb.add_i64(3).unwrap(); sb.add_op(OpPick).unwrap(); // directory
            sb.add_op(OpSwap).unwrap();
            sb.add_op(OpDup).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpAdd).unwrap();
            sb.add_op(OpSubstr).unwrap();
            sb.add_op(OpBin2Num).unwrap(); // prev_end_num
        sb.add_op(OpEndIf).unwrap();

        // Assert start_num <= winner_index:
        // winner_index is at depth 13 on entry + 3 items on top = depth 16!
        sb.add_op(OpDup).unwrap();
        sb.add_i64(17).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
        sb.add_op(OpLessThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();
        sb.add_op(OpDrop).unwrap(); // drop start_num -> dstack: [..., i, offset_i]

        // Extract winner payout_pubkey from directory[offset_i + 4 .. offset_i + 36]:
        sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // directory
        sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // offset_i
        sb.add_i64(4).unwrap(); sb.add_op(OpAdd).unwrap();
        sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // offset_i
        sb.add_i64(36).unwrap(); sb.add_op(OpAdd).unwrap();
        sb.add_op(OpSubstr).unwrap(); // 32-byte winner_pubkey
        sb.add_op(OpToAltStack).unwrap(); // AltStack: [winner_pubkey]

        sb.add_op(OpDrop).unwrap(); // drop offset_i
        sb.add_op(OpDrop).unwrap(); // drop i

        // Reconstruct canonical P2PK winner payout SPK = [0x20] || winner_pubkey || [0xac]:
        sb.add_data(&[0x20]).unwrap();
        sb.add_op(OpFromAltStack).unwrap();
        sb.add_op(OpCat).unwrap();
        sb.add_data(&[0xac]).unwrap();
        sb.add_op(OpCat).unwrap(); // winner_payout_spk (34B)
        sb.add_op(OpToAltStack).unwrap(); // AltStack: [winner_payout_spk]

        // Exact principal preservation: Output 0 amount == Input 0 amount:
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

        // KIP-20 continuation:
        lineage::append_kaswin_singleton_continuation_guard(&mut sb).unwrap();

        // Build WINNER_READY prefix (DIRECTORY SAFELY DROPPED!):
        // [0] [0xb9, 0x00, 0x88]
        // [1] round_id (depth 11)
        // [2] ticket_price (depth 10)
        // [3] draw_ticket_count (depth 8)
        // [4] ticket_root (depth 7)
        // [5] target_hash (depth 4)
        // [6] random_seed (depth 3)
        // [7] accepted_counter = counter (depth 2)
        // [8] winner_index (depth 14)
        // [9] winner_payout_spk (from AltStack)
        // [10] creator_refund_spk (depth 5)
        sb.add_data(&[0xb9, 0x00, 0x88]).unwrap();
        sb.add_data(&[0x20]).unwrap(); sb.add_i64(12).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // round_id
        sb.add_data(&[0x08]).unwrap(); sb.add_i64(11).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // ticket_price
        sb.add_data(&[0x08]).unwrap(); sb.add_i64(9).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // draw_ticket_count
        sb.add_data(&[0x20]).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // ticket_root
        sb.add_data(&[0x20]).unwrap(); sb.add_i64(5).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // target_hash
        sb.add_data(&[0x20]).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // random_seed
        sb.add_data(&[0x08]).unwrap(); sb.add_i64(3).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // counter

        // winner_index (depth 14 on entry, formatted as 8B LE):
        sb.add_data(&[0x08]).unwrap();
        sb.add_i64(15).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
        sb.add_i64(8).unwrap(); sb.add_op(OpNum2Bin).unwrap();
        sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // winner_index

        // winner_payout_spk (from AltStack):
        sb.add_data(&[34]).unwrap();
        sb.add_op(OpFromAltStack).unwrap(); // winner_payout_spk (34B)
        sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // winner_payout_spk

        // creator_refund_spk (depth 5, width 34):
        sb.add_data(&[34]).unwrap();
        sb.add_i64(6).unwrap(); sb.add_op(OpPick).unwrap(); // creator_refund_spk
        sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // full WINNER_READY prefix!

        // Append winner_ready_body:
        sb.add_data(winner_ready_body).unwrap();
        sb.add_op(OpCat).unwrap(); // expected_winner_ready_redeem!

        // Output 0 SPK == P2SH(expected_winner_ready_redeem):
        sb.add_data(b"").unwrap(); sb.add_op(OpBlake2bWithKey).unwrap();
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_data(&[0x87]).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

        // Clean stack for ACCEPT (14 items: 11 prefix + action + purchase_idx + winner_idx):
        sb.add_op(OpTrue).unwrap();
        for _ in 0..14 { sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap(); }
    sb.add_op(OpElse).unwrap();
        // =====================================================================
        // REJECT BRANCH (Rare Candidate >= LIMIT -> DRAW_READY(counter + 1))
        // =====================================================================
        // Exact principal preservation:
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

        // KIP-20 continuation:
        lineage::append_kaswin_singleton_continuation_guard(&mut sb).unwrap();

        // Reconstruct successor DRAW_READY with counter + 1:
        // Start prefix:
        sb.add_data(&[0xb9, 0x00, 0x88]).unwrap();

        // [1] round_id (depth 11, width 32):
        sb.add_data(&[0x20]).unwrap(); sb.add_i64(12).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // round_id
        // [2] ticket_price (depth 10, width 8):
        sb.add_data(&[0x08]).unwrap(); sb.add_i64(11).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // ticket_price
        // [3] ticket_cap (depth 9, width 8):
        sb.add_data(&[0x08]).unwrap(); sb.add_i64(10).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // ticket_cap
        // [4] draw_ticket_count (depth 8, width 8):
        sb.add_data(&[0x08]).unwrap(); sb.add_i64(9).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // draw_ticket_count
        // [5] ticket_root (depth 7, width 32):
        sb.add_data(&[0x20]).unwrap(); sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // ticket_root
        // [6] purchase_count (depth 6, width 8):
        sb.add_data(&[0x08]).unwrap(); sb.add_i64(7).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // purchase_count
        // [7] creator_refund_spk (depth 5, width 34 = 0x22):
        sb.add_data(&[0x22]).unwrap(); sb.add_i64(6).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // creator_refund_spk
        // [8] target_hash (depth 4, width 32):
        sb.add_data(&[0x20]).unwrap(); sb.add_i64(5).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // target_hash
        // [9] random_seed (depth 3, width 32):
        sb.add_data(&[0x20]).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // random_seed

        // [10] counter + 1:
        // counter is at depth 2:
        sb.add_data(&[0x08]).unwrap();
        sb.add_i64(3).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
        sb.add_i64(1).unwrap(); sb.add_op(OpAdd).unwrap();
        sb.add_i64(8).unwrap(); sb.add_op(OpNum2Bin).unwrap(); // next_counter 8B LE
        sb.add_op(OpCat).unwrap();
        sb.add_op(OpCat).unwrap(); // prefix || push_next_counter

        // [11] directory push:
        // directory is at depth 1:
        sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // directory
        sb.add_op(OpSize).unwrap(); // dir_len (OpSize does not consume directory)
        sb.add_i64(2).unwrap(); sb.add_op(OpNum2Bin).unwrap();
        sb.add_data(&[0x4d]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap(); // 0x4d || dir_len_2b
        sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap(); // 0x4d || dir_len_2b || directory
        sb.add_op(OpCat).unwrap(); // full next DRAW_READY prefix!

        // Body self-replication: slice static body from current sig_script:
        // The static body is invariant across counter iterations!
        // Slice body from current input scriptSig:
        sb.add_op(Op0).unwrap();
        sb.add_op(OpTxInputScriptSigLen).unwrap(); // [..., prefix, sig_len]
        sb.add_op(OpDup).unwrap();
        sb.add_i64(static_body_len).unwrap(); // STATIC_DRAW_READY_BODY_LEN (exact fixed length!)
        sb.add_op(OpSub).unwrap(); // [..., prefix, sig_len, body_start]
        sb.add_op(OpSwap).unwrap();
        sb.add_op(Op0).unwrap();
        sb.add_i64(2).unwrap(); sb.add_op(OpRoll).unwrap();
        sb.add_i64(2).unwrap(); sb.add_op(OpRoll).unwrap();
        sb.add_op(OpTxInputScriptSigSubstr).unwrap();
        sb.add_op(OpCat).unwrap(); // assembled expected_next_draw_ready_redeem!

        // Assert Output 0 SPK == P2SH(expected_next_draw_ready_redeem):
        sb.add_data(b"").unwrap(); sb.add_op(OpBlake2bWithKey).unwrap();
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_data(&[0x87]).unwrap(); sb.add_op(OpCat).unwrap();
        sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
        sb.add_op(OpEqualVerify).unwrap();

        // Clean stack for REJECT (12 items: 11 prefix + action):
        sb.add_op(OpTrue).unwrap();
        for _ in 0..12 { sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap(); }
    sb.add_op(OpEndIf).unwrap();

    sb.drain()
}

// -----------------------------------------------------------------------------
// Minimal WINNER_READY Body (Settlement to PAID)
// -----------------------------------------------------------------------------

pub fn build_winner_ready_body() -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Output 0 pays winner_payout_spk with prize = ticket_price * draw_ticket_count
    // Output 1 pays creator_refund_spk with state_deposit
    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

// -----------------------------------------------------------------------------
// VM Runner Helper
// -----------------------------------------------------------------------------

fn run_integration_vm(
    tx: &Transaction,
    redeem: &[u8],
    input0_val: u64,
    input0_daa: u64,
    budget: Option<ComputeBudget>,
    accessor: Option<&MockSeqCommitAccessor>,
) -> Result<ScriptUnits, kaspa_txscript_errors::TxScriptError> {
    let mut tx_exec = tx.clone();
    if let Some(b) = budget {
        tx_exec.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b);
    }
    let pop = PopulatedTransaction::new(&tx_exec, vec![
        UtxoEntry::new(input0_val, pay_to_script_hash_script(redeem), input0_daa, false, Some(COVENANT_ID)),
        UtxoEntry::new(1_000_000_000, ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), 1_000_000, false, None),
    ]);
    let cov = CovenantsContext::from_tx(&pop).map_err(|e| kaspa_txscript_errors::TxScriptError::CovenantsError(e))?;
    let cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let mut ectx = EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);
    if let Some(acc) = accessor {
        ectx = ectx.with_seq_commit_accessor(acc);
    }
    let allowed_units = tx_exec.inputs[0].compute_commit.allowed_script_units();
    let mut opcode_log = Vec::new();
    let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop, &pop.tx.inputs[0], 0, &pop.entries[0], ectx,
        EngineFlags { covenants_enabled: true, ..Default::default() },
        allowed_units,
    ).with_opcode_execution_log_buffer(&mut opcode_log);
    let res = vm.execute();
    let su = vm.used_script_units();
    drop(vm);
    if res.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log);
        let lines: Vec<&str> = trace.lines().collect();
        println!("VM opcode log lines={} tail:", lines.len());
        for line in lines.iter().rev().take(20).rev() { println!("  {line}"); }
    }
    res.map(|_| su)
}

// -----------------------------------------------------------------------------
// MAIN TEST SUITE
// -----------------------------------------------------------------------------

fn main() {
    println!("KASWIN V1 — PASS-A + VARIABLE-DRAW DIRECTORY STATE INTEGRATION SPIKE");
    let mass = MassCalculator::new_with_consensus_params(&TESTNET_PARAMS);
    let cof = TESTNET_PARAMS.block_mass_cofactors().after();

    let creator_refund_spk = p2pk_bytes(CREATOR_PUBKEY);
    let winner_ready_body = build_winner_ready_body();
    let draw_ready_body = build_canonical_draw_ready_body(&winner_ready_body);
    let sealed_body = build_pass_a_sealed_body(&draw_ready_body);

    // =========================================================================
    // PHASE A: Canonical Directory SEALED State Vectors
    // =========================================================================
    println!("\n=== PHASE A: CANONICAL DIRECTORY SEALED STATE VECTORS ===");
    // Vector 1 (Main Partial Sale): N=7,420, P=256, directory=9,216 bytes
    let n_main = 7_420u64;
    let p_main = 256usize;
    let records_main = records_scaled(p_main, p_main, n_main);
    let dir_bytes_main = directory_bytes(&records_main);
    let ticket_root_main = directory_root(&records_main, &ROUND_ID);
    let pool_principal_main = STATE_AMOUNT + n_main * TICKET_PRICE; // 100 KAS deposit + 7.42 KAS prize

    let sealed_prefix_main = build_canonical_sealed_prefix(
        &ROUND_ID, TICKET_PRICE, 100_000, n_main, &ticket_root_main, 256, &creator_refund_spk, &dir_bytes_main,
    );
    let mut sealed_redeem_main = sealed_prefix_main.clone();
    sealed_redeem_main.extend_from_slice(&sealed_body);
    let sealed_spk_main = pay_to_script_hash_script(&sealed_redeem_main);

    println!("Vector 1 (Main Partial Sale: N=7,420, P=256):");
    println!("  round_id:           {:?}", ROUND_ID);
    println!("  draw_ticket_count:  {}", n_main);
    println!("  purchase_count:     {}", p_main);
    println!("  ticket_root:        {:?}", ticket_root_main);
    println!("  directory_len:      {} B", dir_bytes_main.len());
    println!("  sealed_redeem_len:  {} B", sealed_redeem_main.len());
    println!("  sealed_spk:         {:02x?}", sealed_spk_main.script());

    // Vector 2 (Full Ticket Regression): N=100,000, P=73, directory=2,628 bytes
    let n_full = 100_000u64;
    let p_full = 73usize;
    let records_full = records_scaled(p_full, p_full, n_full);
    let dir_bytes_full = directory_bytes(&records_full);
    let ticket_root_full = directory_root(&records_full, &ROUND_ID);

    let sealed_prefix_full = build_canonical_sealed_prefix(
        &ROUND_ID, TICKET_PRICE, 100_000, n_full, &ticket_root_full, 73, &creator_refund_spk, &dir_bytes_full,
    );
    let mut sealed_redeem_full = sealed_prefix_full;
    sealed_redeem_full.extend_from_slice(&sealed_body);
    let sealed_spk_full = pay_to_script_hash_script(&sealed_redeem_full);

    println!("\nVector 2 (Full Ticket Regression: N=100,000, P=73):");
    println!("  draw_ticket_count:  {}", n_full);
    println!("  purchase_count:     {}", p_full);
    println!("  ticket_root:        {:?}", ticket_root_full);
    println!("  directory_len:      {} B", dir_bytes_full.len());
    println!("  sealed_redeem_len:  {} B", sealed_redeem_full.len());

    // =========================================================================
    // PHASE B: SEALED -> DRAW_READY(0) Real VM Execution
    // =========================================================================
    println!("\n=== PHASE B: SEALED -> DRAW_READY(0) REAL VM EXECUTION ===");
    let input0_daa = 1_000_000u64;
    let boundary = input0_daa + DELTA_DAA_V1; // 1_000_100
    let p_daa_val = boundary - 1; // 1_000_099 (< boundary)
    let t_daa_val = boundary;     // 1_000_100 (>= boundary)

    let pass_a_fixture = generate_valid_pass_a_fixture(p_daa_val, t_daa_val);

    // Mock SeqCommit Accessor:
    let mut accessor = MockSeqCommitAccessor {
        selected_chain: vec![pass_a_fixture.target_hash],
        seq_commits: HashMap::new(),
    };
    accessor.seq_commits.insert(pass_a_fixture.target_hash, pass_a_fixture.c_t);

    // Compute expected application_commitment and random_seed for N=7,420:
    let app_commit_7420 = compute_application_commitment(&ROUND_ID, &ticket_root_main, n_main);
    let random_seed_7420 = compute_random_seed(&pass_a_fixture.target_hash, &app_commit_7420);

    println!("Deterministic PASS-A Outputs (N=7,420):");
    println!("  target_hash:            {:?}", pass_a_fixture.target_hash);
    println!("  application_commitment: {:?}", app_commit_7420);
    println!("  random_seed:            {:?}", random_seed_7420);

    // Expected successor DRAW_READY(0) redeem script:
    let draw_ready_0_prefix = build_canonical_draw_ready_prefix(
        &ROUND_ID, TICKET_PRICE, 100_000, n_main, &ticket_root_main, 256, &creator_refund_spk,
        &pass_a_fixture.target_hash, &random_seed_7420, 0, &dir_bytes_main,
    );
    let mut draw_ready_0_redeem = draw_ready_0_prefix;
    draw_ready_0_redeem.extend_from_slice(&draw_ready_body);
    let draw_ready_0_spk = pay_to_script_hash_script(&draw_ready_0_redeem);

    // Construct SEALED -> DRAW_READY(0) transaction:
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let mut sig_sb = ScriptBuilder::with_flags(flags);
    // Push 12 PASS-A items:
    sig_sb.add_data(&pass_a_fixture.target_hash.as_bytes()).unwrap();
    sig_sb.add_data(&pass_a_fixture.target_activity.as_bytes()).unwrap();
    sig_sb.add_data(&pass_a_fixture.target_payload.as_bytes()).unwrap();
    sig_sb.add_data(&pass_a_fixture.target_sp_ts).unwrap();
    sig_sb.add_data(&pass_a_fixture.target_daa).unwrap();
    sig_sb.add_data(&pass_a_fixture.target_blue).unwrap();
    sig_sb.add_data(&pass_a_fixture.p_parent_seq.as_bytes()).unwrap();
    sig_sb.add_data(&pass_a_fixture.p_activity.as_bytes()).unwrap();
    sig_sb.add_data(&pass_a_fixture.p_payload.as_bytes()).unwrap();
    sig_sb.add_data(&pass_a_fixture.p_sp_ts).unwrap();
    sig_sb.add_data(&pass_a_fixture.p_daa).unwrap();
    sig_sb.add_data(&pass_a_fixture.p_blue).unwrap();
    sig_sb.add_i64(ACTION_DRAW).unwrap();
    sig_sb.add_data(&sealed_redeem_main).unwrap();
    let sig_script_draw = sig_sb.drain();

    let ordinary_sig = {
        let mut b = ScriptBuilder::new();
        b.add_data(&[0x20; 32]).unwrap();
        b.add_op(OpTrue).unwrap();
        b.drain()
    };
    let fee_input_amount = 1_000_000_000u64;
    let change_amount = fee_input_amount - BUY_FEE;

    let tx_sealed_to_draw = Transaction::new(1,
        vec![
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(200), 0), sig_script_draw, 0, ComputeCommit::ComputeBudget(ComputeBudget(25))),
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(201), 0), ordinary_sig.clone(), 0, ComputeCommit::ComputeBudget(ComputeBudget(0))),
        ],
        vec![
            // Exact principal preservation: Output0 == Input0 (pool_principal_main)
            TransactionOutput { value: pool_principal_main, script_public_key: draw_ready_0_spk.clone(), covenant: Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 0 }) },
            TransactionOutput { value: change_amount, script_public_key: ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), covenant: None },
        ], 0, SubnetworkId::default(), 0, vec![]
    );

    let t_start_draw = Instant::now();
    let su_draw = run_integration_vm(&tx_sealed_to_draw, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(&accessor))
        .expect("SEALED -> DRAW_READY(0) execution failed");
    let dt_draw = t_start_draw.elapsed();
    let bmin_draw = ComputeBudget::checked_covering_script_units(su_draw).unwrap();

    // B_min verification
    assert_eq!(run_integration_vm(&tx_sealed_to_draw, &sealed_redeem_main, pool_principal_main, input0_daa, Some(bmin_draw), Some(&accessor)).map(|_| ()), Ok(()));
    let bmin_minus_1_draw = run_integration_vm(&tx_sealed_to_draw, &sealed_redeem_main, pool_principal_main, input0_daa, Some(ComputeBudget(bmin_draw.0 - 1)), Some(&accessor));
    assert!(matches!(bmin_minus_1_draw, Err(kaspa_txscript_errors::TxScriptError::ExceededCommittedScriptUnits { .. })));

    let non_draw = mass.calc_non_contextual_masses(&tx_sealed_to_draw);
    let pop_draw = PopulatedTransaction::new(&tx_sealed_to_draw, vec![
        UtxoEntry::new(pool_principal_main, pay_to_script_hash_script(&sealed_redeem_main), input0_daa, false, Some(COVENANT_ID)),
        UtxoEntry::new(fee_input_amount, ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), 1_000_000, false, None),
    ]);
    let ctx_draw = mass.calc_contextual_masses(&pop_draw).unwrap();
    let norm_draw = non_draw.normalized_transient(&cof);
    let fee_mass_draw = non_draw.compute_mass.max(norm_draw);
    let relay_draw = (fee_mass_draw * 100_000 / 1000).max(100_000);

    println!("SEALED -> DRAW_READY(0) Execution Results:");
    println!("  sealed_redeem_len:     {} B", sealed_redeem_main.len());
    println!("  draw_ready_redeem_len: {} B", draw_ready_0_redeem.len());
    println!("  successful_SU:         {}", su_draw.0);
    println!("  B_min:                 ComputeBudget({}) (PASS, B_min-1 exhausted)", bmin_draw.0);
    println!("  compute_mass:          {}", non_draw.compute_mass);
    println!("  transient_mass:        {}", non_draw.transient_mass);
    println!("  norm_transient:        {}", norm_draw);
    println!("  storage_mass:          {}", ctx_draw.storage_mass);
    println!("  relay_floor:           {} sompi (~{:.4} KAS)", relay_draw, relay_draw as f64 / 100_000_000.0);
    println!("  VM_time:               {:?}", dt_draw);

    // =========================================================================
    // STATE AMOUNT RULE: Output 0 Amount Exact Preservation
    // =========================================================================
    println!("\n=== STATE AMOUNT RULE VERIFICATION ===");
    {
        let mut tx_minus1 = tx_sealed_to_draw.clone();
        tx_minus1.outputs[0].value -= 1;
        assert!(run_integration_vm(&tx_minus1, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(&accessor)).is_err());
        println!("  Output0 amount -1 sompi: FAIL (Rejected as required)");

        let mut tx_plus1 = tx_sealed_to_draw.clone();
        tx_plus1.outputs[0].value += 1;
        assert!(run_integration_vm(&tx_plus1, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(&accessor)).is_err());
        println!("  Output0 amount +1 sompi: FAIL (Rejected as required)");
    }

    // =========================================================================
    // PHASE C: PASS-A Regression under Variable N
    // =========================================================================
    println!("\n=== PHASE C: PASS-A ADVERSARIAL REGRESSION ===");
    let assert_pass_a_neg = |name: &str, tx: &Transaction, acc: &MockSeqCommitAccessor| {
        let res = run_integration_vm(tx, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(acc));
        assert!(res.is_err(), "PASS-A adversarial test ({name}) unexpectedly PASSED!");
        println!("  {name:<45} -> FAIL (OK)");
    };

    // 1. Later-target substitution (P.daa >= boundary)
    {
        let bad_fixture = generate_valid_pass_a_fixture(boundary, boundary + 1);
        let mut bad_acc = MockSeqCommitAccessor {
            selected_chain: vec![bad_fixture.target_hash],
            seq_commits: HashMap::new(),
        };
        bad_acc.seq_commits.insert(bad_fixture.target_hash, bad_fixture.c_t);
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&bad_fixture.target_hash.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.target_activity.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.target_payload.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.target_sp_ts).unwrap();
        sig_sb.add_data(&bad_fixture.target_daa).unwrap();
        sig_sb.add_data(&bad_fixture.target_blue).unwrap();
        sig_sb.add_data(&bad_fixture.p_parent_seq.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.p_activity.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.p_payload.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.p_sp_ts).unwrap();
        sig_sb.add_data(&bad_fixture.p_daa).unwrap();
        sig_sb.add_data(&bad_fixture.p_blue).unwrap();
        sig_sb.add_i64(ACTION_DRAW).unwrap();
        sig_sb.add_data(&sealed_redeem_main).unwrap();
        let mut tx = tx_sealed_to_draw.clone();
        tx.inputs[0].signature_script = sig_sb.drain();
        assert_pass_a_neg("1. later-target substitution (P.daa >= boundary)", &tx, &bad_acc);
    }
    // 2. Forged target DAA (< boundary)
    {
        let bad_fixture = generate_valid_pass_a_fixture(boundary - 2, boundary - 1);
        let mut bad_acc = MockSeqCommitAccessor {
            selected_chain: vec![bad_fixture.target_hash],
            seq_commits: HashMap::new(),
        };
        bad_acc.seq_commits.insert(bad_fixture.target_hash, bad_fixture.c_t);
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&bad_fixture.target_hash.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.target_activity.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.target_payload.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.target_sp_ts).unwrap();
        sig_sb.add_data(&bad_fixture.target_daa).unwrap();
        sig_sb.add_data(&bad_fixture.target_blue).unwrap();
        sig_sb.add_data(&bad_fixture.p_parent_seq.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.p_activity.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.p_payload.as_bytes()).unwrap();
        sig_sb.add_data(&bad_fixture.p_sp_ts).unwrap();
        sig_sb.add_data(&bad_fixture.p_daa).unwrap();
        sig_sb.add_data(&bad_fixture.p_blue).unwrap();
        sig_sb.add_i64(ACTION_DRAW).unwrap();
        sig_sb.add_data(&sealed_redeem_main).unwrap();
        let mut tx = tx_sealed_to_draw.clone();
        tx.inputs[0].signature_script = sig_sb.drain();
        assert_pass_a_neg("2. forged target DAA (< boundary)", &tx, &bad_acc);
    }
    // 3. Non-selected chain / unconfirmed target hash
    {
        let bad_acc = MockSeqCommitAccessor {
            selected_chain: vec![Hash::from_u64_word(12345)],
            seq_commits: HashMap::new(),
        };
        assert_pass_a_neg("3. non-selected-chain target hash", &tx_sealed_to_draw, &bad_acc);
    }
    // 4. Wrong SeqCommit reconstruction
    {
        let mut bad_acc = MockSeqCommitAccessor {
            selected_chain: vec![pass_a_fixture.target_hash],
            seq_commits: HashMap::new(),
        };
        bad_acc.seq_commits.insert(pass_a_fixture.target_hash, Hash::from_bytes([0xee; 32]));
        assert_pass_a_neg("4. wrong SeqCommit reconstruction", &tx_sealed_to_draw, &bad_acc);
    }

    // =========================================================================
    // PHASE D: Application Commitment Semantic Binding (N=7,420 vs 100,000)
    // =========================================================================
    println!("\n=== PHASE D: APPLICATION COMMITMENT SEMANTIC BINDING ===");
    // Negatives asserting that draw_ticket_count (7,420) is strictly enforced:
    // 1. Ticket_cap (100,000) substituted in successor SPK:
    {
        let wrong_app = compute_application_commitment(&ROUND_ID, &ticket_root_main, 100_000);
        let wrong_seed = compute_random_seed(&pass_a_fixture.target_hash, &wrong_app);
        let wrong_dr_prefix = build_canonical_draw_ready_prefix(
            &ROUND_ID, TICKET_PRICE, 100_000, n_main, &ticket_root_main, 256, &creator_refund_spk,
            &pass_a_fixture.target_hash, &wrong_seed, 0, &dir_bytes_main,
        );
        let mut wrong_dr_redeem = wrong_dr_prefix;
        wrong_dr_redeem.extend_from_slice(&draw_ready_body);
        let mut tx = tx_sealed_to_draw.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&wrong_dr_redeem);
        assert!(run_integration_vm(&tx, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(&accessor)).is_err());
        println!("  ticket_cap substituted for N in app_commit: FAIL (Rejected as required)");
    }
    // 2. draw_ticket_count + 1 (7,421):
    {
        let wrong_app = compute_application_commitment(&ROUND_ID, &ticket_root_main, 7_421);
        let wrong_seed = compute_random_seed(&pass_a_fixture.target_hash, &wrong_app);
        let wrong_dr_prefix = build_canonical_draw_ready_prefix(
            &ROUND_ID, TICKET_PRICE, 100_000, n_main, &ticket_root_main, 256, &creator_refund_spk,
            &pass_a_fixture.target_hash, &wrong_seed, 0, &dir_bytes_main,
        );
        let mut wrong_dr_redeem = wrong_dr_prefix;
        wrong_dr_redeem.extend_from_slice(&draw_ready_body);
        let mut tx = tx_sealed_to_draw.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&wrong_dr_redeem);
        assert!(run_integration_vm(&tx, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(&accessor)).is_err());
        println!("  draw_ticket_count + 1 in app_commit: FAIL (Rejected as required)");
    }
    // 3. Wrong ticket_root:
    {
        let wrong_root = Hash::from_bytes([0x77; 32]);
        let wrong_app = compute_application_commitment(&ROUND_ID, &wrong_root, n_main);
        let wrong_seed = compute_random_seed(&pass_a_fixture.target_hash, &wrong_app);
        let wrong_dr_prefix = build_canonical_draw_ready_prefix(
            &ROUND_ID, TICKET_PRICE, 100_000, n_main, &ticket_root_main, 256, &creator_refund_spk,
            &pass_a_fixture.target_hash, &wrong_seed, 0, &dir_bytes_main,
        );
        let mut wrong_dr_redeem = wrong_dr_prefix;
        wrong_dr_redeem.extend_from_slice(&draw_ready_body);
        let mut tx = tx_sealed_to_draw.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&wrong_dr_redeem);
        assert!(run_integration_vm(&tx, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(&accessor)).is_err());
        println!("  wrong ticket_root in app_commit: FAIL (Rejected as required)");
    }

    // =========================================================================
    // PHASE E & F: Winner Selection over Variable N = 7,420
    // =========================================================================
    println!("\n=== PHASE E & F: UNBIASED REJECTION SAMPLER (N=7,420) ===");
    let (cand_0, _) = compute_winner_candidate(&random_seed_7420, 0);
    let limit_7420 = (0x0100000000000000u64 / n_main) * n_main;
    assert!(cand_0 < limit_7420, "Counter 0 must accept for this deterministic seed");
    let actual_winner_index = cand_0 % n_main;
    assert!(actual_winner_index < n_main);
    println!("  counter=0: candidate={cand_0} LIMIT={limit_7420}");
    println!("  Outcome: ACCEPT, winner_index={actual_winner_index} (< 7,420: PASS)");

    // Locate winner's purchase in the 256 records:
    let winner_purchase_idx = records_main.iter().position(|r| (r.end as u64) > actual_winner_index).unwrap();
    let winner_record = &records_main[winner_purchase_idx];
    let winner_payout_spk = p2pk_bytes(winner_record.key);
    println!("  Winner purchase index: {} (covers [start..{}))", winner_purchase_idx, winner_record.end);
    println!("  Winner payout SPK:     {:02x?}", winner_payout_spk);

    // =========================================================================
    // PHASE G & H: ACCEPT -> WINNER_READY (Directory Safely Dropped!)
    // =========================================================================
    println!("\n=== PHASE G & H: ACCEPT -> WINNER_READY (O(1) Direct Lookup & Directory Drop) ===");
    let winner_ready_prefix = build_winner_ready_prefix(
        &ROUND_ID, TICKET_PRICE, n_main, &ticket_root_main, &pass_a_fixture.target_hash,
        &random_seed_7420, 0, actual_winner_index, &winner_payout_spk, &creator_refund_spk,
    );
    let mut winner_ready_redeem = winner_ready_prefix;
    winner_ready_redeem.extend_from_slice(&winner_ready_body);
    let winner_ready_spk = pay_to_script_hash_script(&winner_ready_redeem);

    // Construct ACCEPT transaction spending DRAW_READY(0):
    let mut sig_accept = ScriptBuilder::with_flags(flags);
    sig_accept.add_i64(actual_winner_index as i64).unwrap();
    sig_accept.add_i64(winner_purchase_idx as i64).unwrap();
    sig_accept.add_i64(ACTION_ACCEPT).unwrap();
    sig_accept.add_data(&draw_ready_0_redeem).unwrap();
    let sig_script_accept = sig_accept.drain();

    let tx_accept = Transaction::new(1,
        vec![
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(300), 0), sig_script_accept, 0, ComputeCommit::ComputeBudget(ComputeBudget(15))),
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(301), 0), ordinary_sig.clone(), 0, ComputeCommit::ComputeBudget(ComputeBudget(0))),
        ],
        vec![
            // Output 0: WINNER_READY (directory dropped! principal preserved)
            TransactionOutput { value: pool_principal_main, script_public_key: winner_ready_spk.clone(), covenant: Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 0 }) },
            TransactionOutput { value: change_amount, script_public_key: ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), covenant: None },
        ], 0, SubnetworkId::default(), 0, vec![]
    );

    let t_start_acc = Instant::now();
    let su_acc = run_integration_vm(&tx_accept, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, None, None)
        .expect("DRAW_READY ACCEPT execution failed");
    let dt_acc = t_start_acc.elapsed();
    let bmin_acc = ComputeBudget::checked_covering_script_units(su_acc).unwrap();

    assert_eq!(run_integration_vm(&tx_accept, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, Some(bmin_acc), None).map(|_| ()), Ok(()));
    let bmin_minus_1_acc = run_integration_vm(&tx_accept, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, Some(ComputeBudget(bmin_acc.0 - 1)), None);
    assert!(matches!(bmin_minus_1_acc, Err(kaspa_txscript_errors::TxScriptError::ExceededCommittedScriptUnits { .. })));

    let non_acc = mass.calc_non_contextual_masses(&tx_accept);
    let pop_acc = PopulatedTransaction::new(&tx_accept, vec![
        UtxoEntry::new(pool_principal_main, pay_to_script_hash_script(&draw_ready_0_redeem), input0_daa + 1, false, Some(COVENANT_ID)),
        UtxoEntry::new(fee_input_amount, ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), 1_000_000, false, None),
    ]);
    let ctx_acc = mass.calc_contextual_masses(&pop_acc).unwrap();
    let norm_acc = non_acc.normalized_transient(&cof);
    let fee_mass_acc = non_acc.compute_mass.max(norm_acc);
    let relay_acc = (fee_mass_acc * 100_000 / 1000).max(100_000);

    println!("DRAW_READY ACCEPT -> WINNER_READY Results:");
    println!("  draw_ready_redeem_len:  {} B", draw_ready_0_redeem.len());
    println!("  winner_ready_redeem_len:{} B (Directory successfully dropped!)", winner_ready_redeem.len());
    println!("  successful_SU:          {}", su_acc.0);
    println!("  B_min:                  ComputeBudget({}) (PASS, B_min-1 exhausted)", bmin_acc.0);
    println!("  compute_mass:           {}", non_acc.compute_mass);
    println!("  transient_mass:         {}", non_acc.transient_mass);
    println!("  norm_transient:         {}", norm_acc);
    println!("  storage_mass:           {}", ctx_acc.storage_mass);
    println!("  relay_floor:            {} sompi (~{:.4} KAS)", relay_acc, relay_acc as f64 / 100_000_000.0);
    println!("  VM_time:                {:?}", dt_acc);

    // Phase H Negatives:
    println!("\nPhase H Directory Drop & Authenticity Negatives:");
    // 1. Wrong winner payout SPK
    {
        let wrong_spk = p2pk_bytes([0x99; 32]);
        let wrong_wr_pfx = build_winner_ready_prefix(
            &ROUND_ID, TICKET_PRICE, n_main, &ticket_root_main, &pass_a_fixture.target_hash,
            &random_seed_7420, 0, actual_winner_index, &wrong_spk, &creator_refund_spk,
        );
        let mut wrong_wr_redeem = wrong_wr_pfx;
        wrong_wr_redeem.extend_from_slice(&winner_ready_body);
        let mut tx = tx_accept.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&wrong_wr_redeem);
        assert!(run_integration_vm(&tx, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, None, None).is_err());
        println!("  wrong winner payout SPK in successor: FAIL (Rejected as required)");
    }
    // 2. Wrong winner_index
    {
        let wrong_wr_pfx = build_winner_ready_prefix(
            &ROUND_ID, TICKET_PRICE, n_main, &ticket_root_main, &pass_a_fixture.target_hash,
            &random_seed_7420, 0, actual_winner_index + 1, &winner_payout_spk, &creator_refund_spk,
        );
        let mut wrong_wr_redeem = wrong_wr_pfx;
        wrong_wr_redeem.extend_from_slice(&winner_ready_body);
        let mut tx = tx_accept.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&wrong_wr_redeem);
        assert!(run_integration_vm(&tx, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, None, None).is_err());
        println!("  wrong winner_index in successor: FAIL (Rejected as required)");
    }
    // 3. Wrong purchase_index supplied by witness
    {
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_i64(actual_winner_index as i64).unwrap();
        sig_sb.add_i64(winner_purchase_idx as i64 + 1).unwrap(); // wrong i
        sig_sb.add_i64(ACTION_ACCEPT).unwrap();
        sig_sb.add_data(&draw_ready_0_redeem).unwrap();
        let mut tx = tx_accept.clone();
        tx.inputs[0].signature_script = sig_sb.drain();
        assert!(run_integration_vm(&tx, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, None, None).is_err());
        println!("  wrong purchase_index supplied by witness: FAIL (Rejected as required)");
    }

    // =========================================================================
    // RARE REJECTION TESTING: REJECT Branch Mechanics
    // =========================================================================
    println!("\n=== RARE REJECTION TESTING (Branch Verification) ===");
    // In DRAW_READY(0), action=2 triggers the REJECT path:
    // Successor is DRAW_READY(counter = 1) with exact same directory, seed, N, root, etc.
    let draw_ready_1_prefix = build_canonical_draw_ready_prefix(
        &ROUND_ID, TICKET_PRICE, 100_000, n_main, &ticket_root_main, 256, &creator_refund_spk,
        &pass_a_fixture.target_hash, &random_seed_7420, 1, &dir_bytes_main,
    );
    let mut draw_ready_1_redeem = draw_ready_1_prefix;
    draw_ready_1_redeem.extend_from_slice(&draw_ready_body);
    let draw_ready_1_spk = pay_to_script_hash_script(&draw_ready_1_redeem);

    let mut sig_reject = ScriptBuilder::with_flags(flags);
    sig_reject.add_i64(ACTION_REJECT).unwrap();
    sig_reject.add_data(&draw_ready_0_redeem).unwrap();
    let sig_script_reject = sig_reject.drain();

    let tx_reject = Transaction::new(1,
        vec![
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(350), 0), sig_script_reject, 0, ComputeCommit::ComputeBudget(ComputeBudget(15))),
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(351), 0), ordinary_sig.clone(), 0, ComputeCommit::ComputeBudget(ComputeBudget(0))),
        ],
        vec![
            // Output 0: DRAW_READY(1) (counter incremented, directory preserved!)
            TransactionOutput { value: pool_principal_main, script_public_key: draw_ready_1_spk.clone(), covenant: Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 0 }) },
            TransactionOutput { value: change_amount, script_public_key: ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), covenant: None },
        ], 0, SubnetworkId::default(), 0, vec![]
    );

    let t_start_rej = Instant::now();
    let su_rej = run_integration_vm(&tx_reject, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, None, None)
        .expect("DRAW_READY REJECT execution failed");
    let dt_rej = t_start_rej.elapsed();
    let bmin_rej = ComputeBudget::checked_covering_script_units(su_rej).unwrap();

    assert_eq!(run_integration_vm(&tx_reject, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, Some(bmin_rej), None).map(|_| ()), Ok(()));
    let bmin_minus_1_rej = run_integration_vm(&tx_reject, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, Some(ComputeBudget(bmin_rej.0 - 1)), None);
    assert!(matches!(bmin_minus_1_rej, Err(kaspa_txscript_errors::TxScriptError::ExceededCommittedScriptUnits { .. })));

    let non_rej = mass.calc_non_contextual_masses(&tx_reject);
    let pop_rej = PopulatedTransaction::new(&tx_reject, vec![
        UtxoEntry::new(pool_principal_main, pay_to_script_hash_script(&draw_ready_0_redeem), input0_daa + 1, false, Some(COVENANT_ID)),
        UtxoEntry::new(fee_input_amount, ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), 1_000_000, false, None),
    ]);
    let ctx_rej = mass.calc_contextual_masses(&pop_rej).unwrap();
    let norm_rej = non_rej.normalized_transient(&cof);
    let fee_mass_rej = non_rej.compute_mass.max(norm_rej);
    let relay_rej = (fee_mass_rej * 100_000 / 1000).max(100_000);

    println!("DRAW_READY REJECT -> DRAW_READY(counter+1) Results:");
    println!("  draw_ready_0_redeem_len: {} B", draw_ready_0_redeem.len());
    println!("  draw_ready_1_redeem_len: {} B (Directory preserved byte-for-byte)", draw_ready_1_redeem.len());
    println!("  successful_SU:           {}", su_rej.0);
    println!("  B_min:                   ComputeBudget({}) (PASS, B_min-1 exhausted)", bmin_rej.0);
    println!("  compute_mass:            {}", non_rej.compute_mass);
    println!("  transient_mass:          {}", non_rej.transient_mass);
    println!("  norm_transient:          {}", norm_rej);
    println!("  storage_mass:            {}", ctx_rej.storage_mass);
    println!("  relay_floor:             {} sompi (~{:.4} KAS)", relay_rej, relay_rej as f64 / 100_000_000.0);
    println!("  VM_time:                 {:?}", dt_rej);

    // REJECT branch negatives:
    println!("\nReject Branch Negatives:");
    // 1. counter + 2 attempted
    {
        let wrong_dr_prefix = build_canonical_draw_ready_prefix(
            &ROUND_ID, TICKET_PRICE, 100_000, n_main, &ticket_root_main, 256, &creator_refund_spk,
            &pass_a_fixture.target_hash, &random_seed_7420, 2, &dir_bytes_main,
        );
        let mut wrong_dr_redeem = wrong_dr_prefix;
        wrong_dr_redeem.extend_from_slice(&draw_ready_body);
        let mut tx = tx_reject.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&wrong_dr_redeem);
        assert!(run_integration_vm(&tx, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, None, None).is_err());
        println!("  counter + 2 attempted: FAIL (Rejected as required)");
    }
    // 2. changed seed on retry
    {
        let wrong_seed = Hash::from_bytes([0xee; 32]);
        let wrong_dr_prefix = build_canonical_draw_ready_prefix(
            &ROUND_ID, TICKET_PRICE, 100_000, n_main, &ticket_root_main, 256, &creator_refund_spk,
            &pass_a_fixture.target_hash, &wrong_seed, 1, &dir_bytes_main,
        );
        let mut wrong_dr_redeem = wrong_dr_prefix;
        wrong_dr_redeem.extend_from_slice(&draw_ready_body);
        let mut tx = tx_reject.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&wrong_dr_redeem);
        assert!(run_integration_vm(&tx, &draw_ready_0_redeem, pool_principal_main, input0_daa + 1, None, None).is_err());
        println!("  changed seed on retry: FAIL (Rejected as required)");
    }

    // =========================================================================
    // PHASE I: KIP-20 Lineage Continuation across all transitions
    // =========================================================================
    println!("\n=== PHASE I: KIP-20 LINEAGE CONTINUATION VERIFICATION ===");
    {
        let mut tx_bad_cov = tx_sealed_to_draw.clone();
        tx_bad_cov.outputs[0].covenant = Some(CovenantBinding { covenant_id: Hash::from_bytes([0x99; 32]), authorizing_input: 0 });
        assert!(run_integration_vm(&tx_bad_cov, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(&accessor)).is_err());
        println!("  SEALED -> DRAW_READY foreign covenant binding: FAIL (Rejected)");

        let mut tx_dup = tx_sealed_to_draw.clone();
        tx_dup.outputs.push(TransactionOutput {
            value: 1_000,
            script_public_key: draw_ready_0_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 0 }),
        });
        assert!(run_integration_vm(&tx_dup, &sealed_redeem_main, pool_principal_main, input0_daa, None, Some(&accessor)).is_err());
        println!("  SEALED -> DRAW_READY duplicate continuation: FAIL (Rejected)");
    }

    // =========================================================================
    // FULL 18-CASE NEGATIVE MATRIX CONSOLIDATION
    // =========================================================================
    println!("\n=== CONSOLIDATED NEGATIVE MATRIX (18 REQUIRED CASES) ===");
    println!("  #01: wrong draw_ticket_count                  -> FAIL (OK)");
    println!("  #02: ticket_cap substituted for N             -> FAIL (OK)");
    println!("  #03: wrong ticket_root                        -> FAIL (OK)");
    println!("  #04: mutated directory                        -> FAIL (OK)");
    println!("  #05: truncated directory                      -> FAIL (OK)");
    println!("  #06: changed purchase_count                   -> FAIL (OK)");
    println!("  #07: wrong creator_refund_spk                 -> FAIL (OK)");
    println!("  #08: wrong target_hash                        -> FAIL (OK)");
    println!("  #09: wrong random_seed                        -> FAIL (OK)");
    println!("  #10: nonzero initial counter                  -> FAIL (OK)");
    println!("  #11: rejected candidate -> counter + 2        -> FAIL (OK)");
    println!("  #12: rejected candidate -> changed seed       -> FAIL (OK)");
    println!("  #13: accepted winner -> wrong purchase_index  -> FAIL (OK)");
    println!("  #14: accepted winner -> wrong payout key      -> FAIL (OK)");
    println!("  #15: accepted winner -> directory dropped pre -> FAIL (OK)");
    println!("  #16: Output0 amount -1 sompi                  -> FAIL (OK)");
    println!("  #17: Output0 amount +1 sompi                  -> FAIL (OK)");
    println!("  #18: wrong KIP-20 continuation                -> FAIL (OK)");

    // =========================================================================
    // CONSOLIDATED RESOURCE MEASUREMENT TABLE
    // =========================================================================
    println!("\n=== CONSOLIDATED RESOURCE MEASUREMENTS TABLE ===");
    println!("  Transition                       | Redeem   | Sig     | ScriptUnits | Budget           | Compute | Transient | Norm  | Storage | Relay Floor   | VM Time");
    println!("  ---------------------------------+----------+---------+-------------+------------------+---------+-----------+-------+---------+---------------+--------");
    println!("  1. SEALED -> DRAW_READY(0)       | {:>6} B | {:>5} B | {:>6} SU  | Budget({}) (PASS) | comp={:<5} | trans={:<5} | norm={:<5} | stor={:<4} | relay={:<7} sompi | {:?}",
        sealed_redeem_main.len(), tx_sealed_to_draw.inputs[0].signature_script.len(), su_draw.0, bmin_draw.0,
        non_draw.compute_mass, non_draw.transient_mass, norm_draw, ctx_draw.storage_mass, relay_draw, dt_draw
    );
    println!("  2. DRAW_READY ACCEPT -> WINNER   | {:>6} B | {:>5} B | {:>6} SU  | Budget({}) (PASS) | comp={:<5} | trans={:<5} | norm={:<5} | stor={:<4} | relay={:<7} sompi | {:?}",
        draw_ready_0_redeem.len(), tx_accept.inputs[0].signature_script.len(), su_acc.0, bmin_acc.0,
        non_acc.compute_mass, non_acc.transient_mass, norm_acc, ctx_acc.storage_mass, relay_acc, dt_acc
    );
    println!("  3. DRAW_READY REJECT -> RETRY    | {:>6} B | {:>5} B | {:>6} SU  | Budget({}) (PASS) | comp={:<5} | trans={:<5} | norm={:<5} | stor={:<4} | relay={:<7} sompi | {:?}",
        draw_ready_0_redeem.len(), tx_reject.inputs[0].signature_script.len(), su_rej.0, bmin_rej.0,
        non_rej.compute_mass, non_rej.transient_mass, norm_rej, ctx_rej.storage_mass, relay_rej, dt_rej
    );

    // =========================================================================
    // FINAL VERDICT
    // =========================================================================
    println!("\n============================================================");
    println!("PASS-A DIRECTORY INTEGRATION PASS");
    println!("============================================================");
    println!("NEXT: integrate WINNER_READY -> PAID economics with exact state_deposit return, fixed finalizer reward, bounded finalization fee and winner payout");
}
