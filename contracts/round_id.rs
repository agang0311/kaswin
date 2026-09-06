use kaspa_hashes::Hash;
use kaspa_consensus_core::tx::TransactionOutpoint;

/// Canonical round_id derivation from genesis funding outpoint:
/// BLAKE2b256(b"KaswinRoundV1" || funding_outpoint.txid[32] || le_u32(funding_outpoint.index)[4])
pub fn compute_canonical_round_id(funding_outpoint: &TransactionOutpoint) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinRoundV1");
    state.update(funding_outpoint.transaction_id.as_bytes().as_slice());
    state.update(&funding_outpoint.index.to_le_bytes());
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}
