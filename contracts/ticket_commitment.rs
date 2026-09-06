// Kaswin Canonical Purchase Range Merkle Tree Specification & Reference Oracle
//
// Protocol Features:
// - Range Leaf: One leaf per BUY transaction covering [start_ticket, start_ticket + count)
// - Supports batch purchasing without leaf ballooning
// - Strictly consecutive, non-overlapping, zero-gap index intervals across [0, total_tickets)
// - Fixed Tree Depth = 27 (Capacity = 2^27 = 134,217,728 > 100,000,000 MAX_TOTAL_TICKETS)
// - Direction derived strictly from purchase_index bit i at depth level i
// - SMT append proof: verify old slot is empty_leaf, substitute new purchase_leaf, compute new root.

use kaspa_hashes::Hash;

pub const TREE_DEPTH: usize = 27;

/// Computes payout commitment:
/// BLAKE2b256(b"KaswinPayoutSpkV1" || le_u32(payout_spk.len()) || payout_spk)
pub fn compute_payout_commitment(payout_spk: &[u8]) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinPayoutSpkV1");
    state.update(&(payout_spk.len() as u32).to_le_bytes());
    state.update(payout_spk);
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

/// Computes purchase range leaf:
/// BLAKE2b256(
///     b"KaswinTicketRangeV1"
///     || round_id[32]
///     || le_u64(purchase_index)[8]
///     || le_u64(start_ticket)[8]
///     || le_u64(count)[8]
///     || payout_commitment[32]
/// )
pub fn compute_purchase_leaf(
    round_id: &Hash,
    purchase_index: u64,
    start_ticket: u64,
    count: u64,
    payout_commitment: &Hash,
) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinTicketRangeV1");
    state.update(round_id.as_bytes().as_slice());
    state.update(&purchase_index.to_le_bytes());
    state.update(&start_ticket.to_le_bytes());
    state.update(&count.to_le_bytes());
    state.update(payout_commitment.as_bytes().as_slice());
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

/// Computes internal node:
/// BLAKE2b256(b"KaswinTicketNodeV1" || left[32] || right[32])
pub fn hash_internal_node(left: &Hash, right: &Hash) -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinTicketNodeV1");
    state.update(left.as_bytes().as_slice());
    state.update(right.as_bytes().as_slice());
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

/// Computes empty leaf:
/// BLAKE2b256(b"KaswinTicketEmptyV1")
pub fn compute_empty_leaf() -> Hash {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinTicketEmptyV1");
    let res = state.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(res.as_bytes());
    Hash::from_bytes(out)
}

/// Precomputes empty tree nodes at all 28 levels (level 0 = empty_leaf, level 27 = EMPTY_ROOT_27)
pub fn compute_empty_levels() -> [Hash; 28] {
    let mut levels = [Hash::default(); 28];
    levels[0] = compute_empty_leaf();
    for i in 0..27 {
        levels[i + 1] = hash_internal_node(&levels[i], &levels[i]);
    }
    levels
}

/// Computes EMPTY_ROOT_27
pub fn compute_empty_root_27() -> Hash {
    compute_empty_levels()[27]
}

/// Reference Merkle path verification / root computation:
/// Traversing from level 0 to level 26 using bit `i` of index:
/// bit == 0 => current is LEFT, sibling is RIGHT -> H(current, sibling)
/// bit == 1 => sibling is LEFT, current is RIGHT -> H(sibling, current)
pub fn compute_root_from_path(
    leaf: &Hash,
    index: u64,
    siblings: &[Hash; TREE_DEPTH],
) -> Hash {
    let mut current = *leaf;
    for i in 0..TREE_DEPTH {
        let bit = (index >> i) & 1;
        let sibling = &siblings[i];
        if bit == 0 {
            current = hash_internal_node(&current, sibling);
        } else {
            current = hash_internal_node(sibling, &current);
        }
    }
    current
}

/// Pure Rust Reference Verifier for Winner Membership Proof:
/// Given ticket_root, winner_index, and purchase witness:
/// Checks:
/// 1. recompute payout_commitment
/// 2. recompute purchase_leaf
/// 3. recompute root using purchase_index bits and siblings
/// 4. root == ticket_root
/// 5. start_ticket <= winner_index < start_ticket + count
pub fn reference_verify_winner_membership(
    ticket_root: &Hash,
    winner_index: u64,
    round_id: &Hash,
    purchase_index: u64,
    start_ticket: u64,
    count: u64,
    payout_spk: &[u8],
    siblings: &[Hash; TREE_DEPTH],
) -> bool {
    if count == 0 {
        return false;
    }
    let end_ticket = match start_ticket.checked_add(count) {
        Some(end) => end,
        None => return false,
    };
    if winner_index < start_ticket || winner_index >= end_ticket {
        return false;
    }
    let payout_comm = compute_payout_commitment(payout_spk);
    let leaf = compute_purchase_leaf(round_id, purchase_index, start_ticket, count, &payout_comm);
    let computed_root = compute_root_from_path(&leaf, purchase_index, siblings);
    computed_root == *ticket_root
}
