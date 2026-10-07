use kaspa_hashes::{Hash, ZERO_HASH};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ComputeCommit, CovenantBinding,
    ScriptPublicKey,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    script_builder::ScriptBuilder,
    covenants::CovenantsContext,
    standard::pay_to_script_hash_script,
};
use kaspa_consensus_core::mass::ComputeBudget;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_txscript::opcodes::codes::*;

#[path = "../../../../contracts/lineage.rs"]
pub mod lineage;

#[path = "../../../../contracts/round_id.rs"]
pub mod round_id;
use round_id::compute_canonical_round_id;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_levels,
    compute_payout_commitment,
    compute_purchase_leaf,
    compute_root_from_path,
    is_canonical_payout_spk,
    append_canonical_payout_spk_check,
    TREE_DEPTH,
};

pub fn build_refund_claims_prefix(
    round_id: &Hash,
    ticket_price: u64,
    remaining_root: &Hash,
    creator_refund_spk: &[u8],
) -> Vec<u8> {
    assert!(is_canonical_payout_spk(creator_refund_spk));
    let mut sb = ScriptBuilder::new();
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&remaining_root.as_bytes()).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.drain()
}

pub fn canonical_refund_claims_body_len(creator_refund_spk_len: usize) -> usize {
    let mut guess = 3400usize;
    for _ in 0..16 {
        let body = build_refund_claims_body(guess, creator_refund_spk_len).unwrap();
        if body.len() == guess {
            return guess;
        }
        guess = body.len();
    }
    panic!("Failed to converge refund_claims body length");
}

pub fn build_refund_claims_covenant(
    round_id: Hash,
    ticket_price: u64,
    remaining_root: Hash,
    creator_refund_spk: Vec<u8>,
) -> Result<Vec<u8>, kaspa_txscript::script_builder::ScriptBuilderError> {
    assert!(is_canonical_payout_spk(&creator_refund_spk));
    let body_len = canonical_refund_claims_body_len(creator_refund_spk.len());
    let prefix = build_refund_claims_prefix(&round_id, ticket_price, &remaining_root, &creator_refund_spk);
    let body = build_refund_claims_body(body_len, creator_refund_spk.len())?;
    let mut full = Vec::new();
    full.extend_from_slice(&prefix);
    full.extend_from_slice(&body);
    Ok(full)
}

pub fn build_refund_claims_body(
    body_len: usize,
    creator_refund_spk_len: usize,
) -> Result<Vec<u8>, kaspa_txscript::script_builder::ScriptBuilderError> {
    let mut sb = ScriptBuilder::with_flags(kaspa_txscript::EngineFlags { covenants_enabled: true, ..Default::default() });

    // Stack depth check: exactly 35 items
    sb.add_op(OpDepth)?;
    sb.add_i64(35)?;
    sb.add_op(OpNumEqualVerify)?;

    // STEP 0: Witness Canonical Width Checks
    sb.add_i64(4)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    sb.add_i64(5)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    sb.add_i64(6)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpSize)?;
    sb.add_i64(8)?;
    sb.add_op(OpNumEqualVerify)?;
    sb.add_op(OpDrop)?;

    // payout_spk canonical SPK check:
    append_canonical_payout_spk_check(&mut sb, 7)?;

    // siblings width checks (27 items):
    for i in 0..TREE_DEPTH {
        let depth = 8 + i as i64;
        sb.add_i64(depth)?;
        sb.add_op(OpPick)?;
        sb.add_op(OpSize)?;
        sb.add_i64(32)?;
        sb.add_op(OpNumEqualVerify)?;
        sb.add_op(OpDrop)?;
    }

    // STEP 1: Range & Value Checks
    sb.add_i64(6)?;
    sb.add_op(OpPick)?; // count
    sb.add_op(OpBin2Num)?;
    sb.add_op(Op0)?;
    sb.add_op(OpGreaterThan)?;
    sb.add_op(OpVerify)?;

    sb.add_i64(5)?;
    sb.add_op(OpPick)?; // start_ticket
    sb.add_op(OpBin2Num)?;
    sb.add_op(Op0)?;
    sb.add_op(OpGreaterThanOrEqual)?;
    sb.add_op(OpVerify)?;

    sb.add_i64(4)?;
    sb.add_op(OpPick)?; // purchase_index
    sb.add_op(OpBin2Num)?;
    sb.add_op(Op0)?;
    sb.add_op(OpGreaterThanOrEqual)?;
    sb.add_op(OpVerify)?;

    // STEP 2: Verify Buyer Output (Output 1)
    // Output 1 SPK == payout_spk
    sb.add_i64(7)?;
    sb.add_op(OpPick)?; // payout_spk
    sb.add_op(Op1)?;
    sb.add_op(OpTxOutputSpk)?;
    sb.add_op(OpEqualVerify)?;

    // Output 1 Amount == ticket_price * count:
    sb.add_i64(2)?;
    sb.add_op(OpPick)?; // ticket_price
    sb.add_op(OpBin2Num)?;
    sb.add_i64(7)?;
    sb.add_op(OpPick)?; // count
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpMul)?; // delta_refund
    sb.add_op(OpDup)?;
    sb.add_op(Op1)?;
    sb.add_op(OpTxOutputAmount)?;
    sb.add_op(OpEqualVerify)?;
    // delta_refund is at depth 0
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund]

    // Output 1 covenant == None:
    sb.add_op(Op1)?;
    sb.add_op(OpOutputCovenantId)?;
    sb.add_data(&ZERO_HASH.as_bytes())?;
    sb.add_op(OpEqualVerify)?;
    sb.add_op(Op1)?;
    sb.add_op(OpOutputAuthorizingInput)?;
    sb.add_i64(-1)?;
    sb.add_op(OpNumEqualVerify)?;

    // STEP 3: Setup AltStack & Compute Merkle purchase_leaf
    // Save to AltStack:
    // purchase_index_num:
    sb.add_i64(4)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpBin2Num)?;
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund, purchase_index_num]

    // creator_refund_spk:
    sb.add_op(Op0)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund, purchase_index_num, creator_refund_spk]

    // remaining_root:
    sb.add_op(Op1)?;
    sb.add_op(OpPick)?;
    sb.add_op(OpToAltStack)?; // AltStack: [delta_refund, purchase_index_num, creator_refund_spk, remaining_root]

    // Compute payout_commitment = BLAKE2b256(b"KaswinPayoutSpkV1" || le_u32(payout_spk.len()) || payout_spk):
    sb.add_i64(7)?;
    sb.add_op(OpPick)?; // payout_spk
    sb.add_op(OpSize)?;
    sb.add_i64(4)?;
    sb.add_op(OpNum2Bin)?;
    sb.add_data(b"KaswinPayoutSpkV1")?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // [payout_comm]
    sb.add_op(OpToAltStack)?; // AltStack: [..., payout_comm]

    // Compute purchase_leaf:
    sb.add_data(b"KaswinTicketRangeV1")?;
    sb.add_i64(4)?;
    sb.add_op(OpPick)?; // round_id
    sb.add_op(OpCat)?;
    sb.add_i64(5)?;
    sb.add_op(OpPick)?; // purchase_index
    sb.add_op(OpCat)?;
    sb.add_i64(6)?;
    sb.add_op(OpPick)?; // start_ticket
    sb.add_op(OpCat)?;
    sb.add_i64(7)?;
    sb.add_op(OpPick)?; // count
    sb.add_op(OpCat)?;
    sb.add_op(OpFromAltStack)?; // payout_comm
    sb.add_op(OpCat)?;
    sb.add_data(b"")?;
    sb.add_op(OpBlake2bWithKey)?; // purchase_leaf at Depth 0
    sb.add_op(OpToAltStack)?; // AltStack: [..., remaining_root, purchase_leaf]

    // Clean top 8 non-sibling items from dstack:
    for _ in 0..4 {
        sb.add_op(Op2Drop)?;
    }
    // Stack has ONLY: [siblings[26..0]]!

    // Compute empty_leaf:
    let empty_leaf = ticket_commitment::compute_empty_leaf();
    sb.add_data(&empty_leaf.as_bytes())?;
    sb.add_op(OpToAltStack)?; // AltStack: [..., remaining_root, purchase_leaf, empty_leaf]

    // Reshuffle AltStack:
    // AltStack currently: [delta_refund, purchase_index_num, creator_refund_spk, remaining_root, purchase_leaf, empty_leaf]
    sb.add_op(OpFromAltStack)?; // empty_leaf (new_hash candidate)
    sb.add_op(OpFromAltStack)?; // purchase_leaf (old_hash candidate)
    sb.add_op(OpFromAltStack)?; // remaining_root
    sb.add_op(OpFromAltStack)?; // creator_refund_spk
    sb.add_op(OpFromAltStack)?; // purchase_index_num

    // dstack: [siblings[26..0], empty_leaf, purchase_leaf, remaining_root, creator_refund_spk, purchase_index_num]
    sb.add_i64(2)?;
    sb.add_op(OpRoll)?; // remaining_root
    sb.add_op(OpToAltStack)?;
    sb.add_i64(1)?;
    sb.add_op(OpRoll)?; // creator_refund_spk
    sb.add_op(OpToAltStack)?;
    sb.add_i64(2)?;
    sb.add_op(OpRoll)?; // purchase_leaf
    sb.add_op(OpToAltStack)?;
    sb.add_i64(1)?;
    sb.add_op(OpRoll)?; // empty_leaf
    sb.add_op(OpToAltStack)?;
    // dstack now: [siblings[26..0], purchase_index_num]!
    // AltStack from bottom: [delta_refund, remaining_root, creator_refund_spk, old_hash=purchase_leaf, new_hash=empty_leaf]

    // STEP 4: Parallel Dual-Root SMT Traversal (27 Levels)
    for i in 0..TREE_DEPTH {
        sb.add_op(OpDup)?;
        if i > 0 {
            sb.add_i64(1i64 << i)?;
            sb.add_op(OpDiv)?;
        }
        sb.add_i64(2)?;
        sb.add_op(OpMod)?; // bit_i at depth 0

        // Roll sibling_i from below:
        // siblings are at depth 2 (since dstack has [siblings..., purchase_index_num, bit_i])
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // sibling_i
        sb.add_op(OpDup)?;   // duplicate sibling_i

        // Hash old branch:
        sb.add_op(OpFromAltStack)?; // new_hash
        sb.add_op(OpFromAltStack)?; // old_hash
        // dstack: [..., purchase_index_num, bit_i, sibling_i, sibling_i, new_hash, old_hash]
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // sibling_i
        sb.add_i64(4)?;
        sb.add_op(OpPick)?; // bit_i
        sb.add_op(OpIf)?;
            sb.add_op(OpSwap)?;
        sb.add_op(OpEndIf)?;
        sb.add_op(OpCat)?;
        sb.add_data(b"KaswinTicketNodeV1")?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?; // next_old_hash
        sb.add_op(OpToAltStack)?;     // AltStack: [..., next_old_hash]

        // Hash new branch:
        // dstack: [..., purchase_index_num, bit_i, sibling_i, new_hash]
        sb.add_op(OpSwap)?; // [..., sibling_i, new_hash] -> [..., new_hash, sibling_i]
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // bit_i
        sb.add_op(OpIf)?;
            sb.add_op(OpSwap)?;
        sb.add_op(OpEndIf)?;
        sb.add_op(OpCat)?;
        sb.add_data(b"KaswinTicketNodeV1")?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?; // next_new_hash

        // Restore AltStack order: [..., next_old_hash, next_new_hash]
        sb.add_op(OpFromAltStack)?; // next_old_hash
        sb.add_op(OpSwap)?;
        sb.add_op(OpToAltStack)?;   // push next_old_hash
        sb.add_op(OpToAltStack)?;   // push next_new_hash
    }

    sb.add_op(OpDrop)?; // drop purchase_index_num
    // AltStack currently: [delta_refund, remaining_root, creator_refund_spk, old_root, new_root]
    sb.add_op(OpFromAltStack)?; // new_root
    sb.add_op(OpFromAltStack)?; // old_root
    sb.add_op(OpSwap)?;         // [old_root, new_root]
    sb.add_op(OpToAltStack)?;   // AltStack: [delta_refund, remaining_root, creator_refund_spk, new_root], dstack: [old_root]
    sb.add_op(OpFromAltStack)?; // new_root
    sb.add_op(OpFromAltStack)?; // creator_refund_spk
    sb.add_op(OpFromAltStack)?; // remaining_root
    // dstack: [old_root, new_root, creator_refund_spk, remaining_root]
    // We want to verify old_root == remaining_root:
    sb.add_i64(3)?;
    sb.add_op(OpRoll)?; // [new_root, creator_refund_spk, remaining_root, old_root]
    sb.add_op(OpEqualVerify)?; // old_root == remaining_root! dstack: [new_root, creator_refund_spk]
    sb.add_op(OpSwap)?; // [creator_refund_spk, new_root]

    // STEP 5: Successor Dispatch: Continuation vs Terminal
    let empty_root_27 = ticket_commitment::compute_empty_root_27();
    sb.add_op(OpDup)?; // [creator_refund_spk, new_root, new_root]
    sb.add_data(&empty_root_27.as_bytes())?;
    sb.add_op(OpEqual)?; // boolean: is_empty_root -> [creator_refund_spk, new_root, is_empty_root]

    sb.add_op(OpIf)?;
        // =========================================================
        // TERMINAL CLAIM: new_root == EMPTY_ROOT_27
        // =========================================================
        sb.add_op(OpDrop)?; // drop new_root, stack has [creator_refund_spk]

        // Output 0 SPK == creator_refund_spk:
        sb.add_op(OpDup)?;
        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputSpk)?;
        sb.add_op(OpEqualVerify)?;

        // Output 0 Amount == Input 0 Amount - delta_refund:
        sb.add_op(Op0)?;
        sb.add_op(OpTxInputAmount)?;
        sb.add_op(OpFromAltStack)?; // delta_refund
        sb.add_op(OpSub)?; // expected_terminal_creator_amount
        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputAmount)?;
        sb.add_op(OpEqualVerify)?;

        // Terminal Lineage Guard:
        lineage::append_kaswin_terminal_lineage_guard(&mut sb)?;

        sb.add_op(OpDrop)?; // drop creator_refund_spk

    sb.add_op(OpElse)?;
        // =========================================================
        // CONTINUATION CLAIM: new_root != EMPTY_ROOT_27
        // =========================================================
        // dstack has: [creator_refund_spk, new_root]
        sb.add_op(Op0)?;
        sb.add_op(OpTxInputAmount)?;
        sb.add_op(OpFromAltStack)?; // delta_refund
        sb.add_op(OpSub)?; // expected_next_claims_amount
        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputAmount)?;
        sb.add_op(OpEqualVerify)?;

        // Enforce Singleton Continuation Guard on Output 0:
        lineage::append_kaswin_singleton_continuation_guard(&mut sb)?;

        // Reconstruct successor REFUND_CLAIMS redeem script:
        // Input prefix = OpTxInputIndex(1) + Op0(1) + OpEqualVerify(1) + round_id(33) + ticket_price(9) + remaining_root(33) + creator_spk(1+len)
        // immut prefix = 3 + 33 + 9 = 45 bytes
        // full prefix = 45 + 33 + (1 + creator_refund_spk_len) = 79 + creator_refund_spk_len
        let immut_prefix_len = 45;
        let full_prefix_len = immut_prefix_len + 33 + (1 + creator_refund_spk_len);
        let total_redeem_len = full_prefix_len + body_len;

        // dstack: [creator_refund_spk, new_root]
        // 1. Format new_root push: [0x20 || new_root(32B)]
        sb.add_data(&[0x20])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?; // [creator_refund_spk, push_new_root]

        // 2. Format creator_refund_spk push: [len || creator_refund_spk]
        sb.add_op(OpSwap)?; // [push_new_root, creator_refund_spk]
        let spk_len_byte = creator_refund_spk_len as u8;
        sb.add_data(&[spk_len_byte])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?; // [push_new_root, push_creator_spk]

        // 3. Combine into tail_prefix:
        sb.add_op(OpCat)?; // [push_new_root || push_creator_spk]
        sb.add_op(OpToAltStack)?; // AltStack: [tail_prefix], dstack: EMPTY!

        // 4. Introspect immutable prefix (45 bytes) from Input 0 signature script:
        // Calculate redeem_start in Input 0 scriptSig:
        sb.add_op(Op0)?;
        sb.add_op(OpTxInputScriptSigLen)?; // [sig_len]
        sb.add_i64(total_redeem_len as i64)?;
        sb.add_op(OpSub)?; // [redeem_start]

        sb.add_op(Op0)?;   // [redeem_start, 0]
        sb.add_op(OpSwap)?; // [0, redeem_start]
        sb.add_op(OpDup)?;  // [0, redeem_start, redeem_start]
        sb.add_i64(immut_prefix_len as i64)?;
        sb.add_op(OpAdd)?;  // [0, redeem_start, immut_prefix_end]
        sb.add_op(OpTxInputScriptSigSubstr)?; // [immut_prefix_bytes]

        // Assemble full_next_prefix = immut_prefix || tail_prefix:
        sb.add_op(OpFromAltStack)?; // [immut_prefix_bytes, tail_prefix]
        sb.add_op(OpCat)?;          // [full_next_prefix]
        sb.add_op(OpToAltStack)?;   // AltStack: [full_next_prefix]

        // 5. Slice body: [sig_len - body_len .. sig_len]
        sb.add_op(Op0)?;
        sb.add_op(OpTxInputScriptSigLen)?; // [sig_len]
        sb.add_op(OpDup)?;
        sb.add_i64(body_len as i64)?;
        sb.add_op(OpSub)?; // body_start = sig_len - body_len
        sb.add_op(Op0)?;
        sb.add_op(OpSwap)?; // [sig_len, 0, body_start]
        sb.add_i64(2)?;
        sb.add_op(OpRoll)?; // [0, body_start, sig_len]
        sb.add_op(OpTxInputScriptSigSubstr)?; // [body_bytes]

        // Concatenate: [full_next_prefix, body_bytes]
        sb.add_op(OpFromAltStack)?; // [body_bytes, full_next_prefix]
        sb.add_op(OpSwap)?;         // [full_next_prefix, body_bytes]
        sb.add_op(OpCat)?;          // [next_refund_claims_redeem_script]

        // 6. Compute P2SH SPK and verify Output 0:
        sb.add_data(b"")?;
        sb.add_op(OpBlake2bWithKey)?;
        sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?;
        sb.add_op(OpSwap)?;
        sb.add_op(OpCat)?;
        sb.add_data(&[0x87])?;
        sb.add_op(OpCat)?;

        sb.add_op(Op0)?;
        sb.add_op(OpTxOutputSpk)?;
        sb.add_op(OpEqualVerify)?;

    sb.add_op(OpEndIf)?;

    sb.add_op(OpTrue)?;
    Ok(sb.drain())
}

// -------------------------------------------------------------
// SMT Multi-Leaf Helpers for Building Trees
// -------------------------------------------------------------
// -------------------------------------------------------------
// SMT Multi-Leaf Helpers for Building Trees (Sparse Frontier)
// -------------------------------------------------------------
use std::sync::atomic::{AtomicUsize, Ordering};
static HASH_INTERNAL_COUNT: AtomicUsize = AtomicUsize::new(0);

fn counted_hash_internal_node(left: &Hash, right: &Hash) -> Hash {
    HASH_INTERNAL_COUNT.fetch_add(1, Ordering::SeqCst);
    ticket_commitment::hash_internal_node(left, right)
}

struct PurchaseRecord {
    index: u64,
    start: u64,
    count: u64,
    payout_spk: Vec<u8>,
}

/// Sparse SMT helper that prunes empty subtrees:
/// Computes sparse frontier of nodes: map (level, index) -> Hash.
/// Only non-empty subtrees are evaluated and stored.
/// If a node (l, idx) is not in the map, its value is empty_levels[l] without any hashing.
fn build_sparse_tree(
    leaves: &std::collections::HashMap<u64, Hash>,
    empty_levels: &[Hash; 28],
) -> std::collections::HashMap<(usize, u64), Hash> {
    let mut tree = std::collections::HashMap::new();
    let mut current_level: std::collections::HashMap<u64, Hash> = leaves.clone();

    for (&idx, &hash) in leaves.iter() {
        tree.insert((0, idx), hash);
    }

    for l in 0..TREE_DEPTH {
        let mut parent_indices = std::collections::BTreeSet::new();
        for &idx in current_level.keys() {
            parent_indices.insert(idx / 2);
        }

        let mut next_level = std::collections::HashMap::new();
        for p_idx in parent_indices {
            let left_idx = p_idx * 2;
            let right_idx = p_idx * 2 + 1;
            let left_hash = current_level.get(&left_idx).copied().unwrap_or(empty_levels[l]);
            let right_hash = current_level.get(&right_idx).copied().unwrap_or(empty_levels[l]);
            let parent_hash = counted_hash_internal_node(&left_hash, &right_hash);
            tree.insert((l + 1, p_idx), parent_hash);
            next_level.insert(p_idx, parent_hash);
        }
        current_level = next_level;
    }

    tree
}

fn get_sparse_node(
    l: usize,
    idx: u64,
    tree: &std::collections::HashMap<(usize, u64), Hash>,
    empty_levels: &[Hash; 28],
) -> Hash {
    tree.get(&(l, idx)).copied().unwrap_or(empty_levels[l])
}

fn build_3_purchase_tree(
    round_id: &Hash,
    purchases: &[PurchaseRecord; 3],
) -> (Hash, [[Hash; TREE_DEPTH]; 3]) {
    let mut leaves = std::collections::HashMap::new();
    for p in purchases.iter() {
        let p_comm = compute_payout_commitment(&p.payout_spk);
        let leaf = compute_purchase_leaf(round_id, p.index, p.start, p.count, &p_comm);
        leaves.insert(p.index, leaf);
    }
    let empty_levels = compute_empty_levels();

    HASH_INTERNAL_COUNT.store(0, Ordering::SeqCst);
    let tree = build_sparse_tree(&leaves, &empty_levels);
    let total_hashes = HASH_INTERNAL_COUNT.load(Ordering::SeqCst);
    println!("  [Sparse Tree Construction] Total hash_internal_node calls: {}", total_hashes);
    assert!(total_hashes < 500, "FATAL REGRESSION: sparse tree hash count {} exceeded bound 500!", total_hashes);

    let root = get_sparse_node(TREE_DEPTH, 0, &tree, &empty_levels);

    let mut sibs = [[Hash::default(); TREE_DEPTH]; 3];
    for (i, p) in purchases.iter().enumerate() {
        for l in 0..TREE_DEPTH {
            let sib_idx = (p.index >> l) ^ 1;
            sibs[i][l] = get_sparse_node(l, sib_idx, &tree, &empty_levels);
        }
    }

    (root, sibs)
}


fn main() {
    println!("================================================================");
    println!("KASWIN REFUND_CLAIMS ANY-ORDER & DOUBLE-CLAIM ISOLATED PROOF");
    println!("================================================================");

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    let ticket_price = 10_000_000u64; // 0.1 KAS
    let state_deposit = 50_000_000u64; // 0.5 KAS
    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(999888), 0);
    let canonical_round_id = compute_canonical_round_id(&funding_outpoint);
    let covenant_id_c = Hash::from_u64_word(123456789);

    // Creator refund SPK (Class A PubKey 36B):
    let mut creator_refund_spk = vec![0x00, 0x00, OpData32 as u8];
    creator_refund_spk.extend(vec![0x77; 32]);
    creator_refund_spk.push(OpCheckSig as u8);
    assert!(is_canonical_payout_spk(&creator_refund_spk));

    // Buyer 0:
    let mut buyer_0 = vec![0x00, 0x00, OpData32 as u8];
    buyer_0.extend(vec![0x10; 32]);
    buyer_0.push(OpCheckSig as u8);

    // Buyer 1:
    let mut buyer_1 = vec![0x00, 0x00, OpData32 as u8];
    buyer_1.extend(vec![0x20; 32]);
    buyer_1.push(OpCheckSig as u8);

    // Buyer 2:
    let mut buyer_2 = vec![0x00, 0x00, OpData32 as u8];
    buyer_2.extend(vec![0x30; 32]);
    buyer_2.push(OpCheckSig as u8);

    let purchases = [
        PurchaseRecord { index: 0, start: 0, count: 5, payout_spk: buyer_0.clone() },
        PurchaseRecord { index: 1, start: 5, count: 10, payout_spk: buyer_1.clone() },
        PurchaseRecord { index: 2, start: 15, count: 2, payout_spk: buyer_2.clone() },
    ];

    let total_sold_tickets = 5 + 10 + 2; // 17 tickets
    let initial_claims_amount = state_deposit + ticket_price * total_sold_tickets;

    let (root_initial, sibs_initial) = build_3_purchase_tree(&canonical_round_id, &purchases);

    let covenant_initial = build_refund_claims_covenant(
        canonical_round_id,
        ticket_price,
        root_initial,
        creator_refund_spk.clone(),
    ).unwrap();
    let spk_claims_initial = pay_to_script_hash_script(&covenant_initial);

    println!("Initial REFUND_CLAIMS redeem length: {} bytes", covenant_initial.len());
    println!("Initial root: {}", root_initial);

    // -------------------------------------------------------------
    // R1: Claim Purchase #2 FIRST (Any-Order Demonstration)
    // -------------------------------------------------------------
    println!("\n[Test R1] Claim purchase #2 FIRST (out of order)");
    // After claiming #2, leaf 2 becomes empty_leaf!
    let empty_leaf = ticket_commitment::compute_empty_leaf();
    let root_after_2 = compute_root_from_path(&empty_leaf, 2, &sibs_initial[2]);
    let covenant_after_2 = build_refund_claims_covenant(
        canonical_round_id,
        ticket_price,
        root_after_2,
        creator_refund_spk.clone(),
    ).unwrap();
    let spk_claims_after_2 = pay_to_script_hash_script(&covenant_after_2);

    let refund_amount_2 = ticket_price * purchases[2].count;
    let out0_amount_after_2 = initial_claims_amount - refund_amount_2;

    let mut sig_sb_2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_2.add_data(&sibs_initial[2][i].as_bytes()).unwrap(); }
    sig_sb_2.add_data(&purchases[2].payout_spk).unwrap();
    sig_sb_2.add_data(&purchases[2].count.to_le_bytes()).unwrap();
    sig_sb_2.add_data(&purchases[2].start.to_le_bytes()).unwrap();
    sig_sb_2.add_data(&purchases[2].index.to_le_bytes()).unwrap();
    sig_sb_2.add_data(&covenant_initial).unwrap();
    let sig_script_2 = sig_sb_2.drain();

    let tx_r1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(1), 0),
            sig_script_2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: out0_amount_after_2,
                script_public_key: spk_claims_after_2.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: refund_amount_2,
                script_public_key: ScriptPublicKey::from_vec(0, purchases[2].payout_spk[2..].to_vec()),
                covenant: None,
            },
        ],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_r1 = PopulatedTransaction::new(&tx_r1, vec![UtxoEntry::new(
        initial_claims_amount,
        spk_claims_initial.clone(),
        0,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_r1 = CovenantsContext::from_tx(&pop_r1).unwrap();
    let ctx_r1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_r1);
    let mut log_r1 = Vec::new();
    let mut vm_r1 = TxScriptEngine::from_transaction_input(&pop_r1, &pop_r1.tx.inputs[0], 0, &pop_r1.entries[0], ctx_r1, flags)
        .with_opcode_execution_log_buffer(&mut log_r1);
    let res_r1 = vm_r1.execute();
    let u_r1 = vm_r1.used_script_units();
    let b_r1 = ComputeBudget::checked_covering_script_units(u_r1).unwrap();
    if res_r1 != Ok(()) {
        let log_str = String::from_utf8_lossy(&log_r1);
        for l in log_str.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev() {
            println!("{}", l);
        }
    }
    assert_eq!(res_r1, Ok(()));
    println!("  -> PASS: Claim #2 (FIRST) succeeded in TxScriptEngine! [Units: {:?}, B_min: {:?}]", u_r1, b_r1);

    // -------------------------------------------------------------
    // R4: DOUBLE CLAIM #2 MUST FAIL!
    // Attempting to claim #2 again against root_after_2
    // -------------------------------------------------------------
    println!("\n[Test R4] DOUBLE CLAIM purchase #2 against updated remaining_root (Must FAIL)");
    let tx_r4 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(2), 0),
            sig_script_2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: out0_amount_after_2 - refund_amount_2,
                script_public_key: spk_claims_after_2.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: refund_amount_2,
                script_public_key: ScriptPublicKey::from_vec(0, purchases[2].payout_spk[2..].to_vec()),
                covenant: None,
            },
        ],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_r4 = PopulatedTransaction::new(&tx_r4, vec![UtxoEntry::new(
        out0_amount_after_2,
        spk_claims_after_2.clone(),
        0,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_r4 = CovenantsContext::from_tx(&pop_r4).unwrap();
    let ctx_r4 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_r4);
    let mut vm_r4 = TxScriptEngine::from_transaction_input(&pop_r4, &pop_r4.tx.inputs[0], 0, &pop_r4.entries[0], ctx_r4, flags);
    let res_r4 = vm_r4.execute();
    assert!(res_r4.is_err());
    println!("  -> PASS: Double claim #2 rejected with {:?} (leaf is now empty!)", res_r4.err().unwrap());

    // -------------------------------------------------------------
    // R2: Claim Purchase #0 SECOND
    // -------------------------------------------------------------
    println!("\n[Test R2] Claim purchase #0 SECOND");
    // Notice: sibs for purchase 0 in the tree after leaf 2 was deleted:
    // Does purchase 0 share siblings with purchase 2?
    // Purchase 0 is idx 0 (bit0=0, bit1=0). Sibling at L0 is idx 1 (purchase 1).
    // Sibling at L1 is idx 2/3 (which contains purchase 2!).
    // So the sibling at L1 for purchase 0 changed because leaf 2 was deleted!
    // Let's recompute the exact active sibling path for purchase 0 against root_after_2:
    let mut active_leaves_after_2 = std::collections::HashMap::new();
    let p_comm_0 = compute_payout_commitment(&purchases[0].payout_spk);
    let leaf_0 = compute_purchase_leaf(&canonical_round_id, 0, 0, purchases[0].count, &p_comm_0);
    let p_comm_1 = compute_payout_commitment(&purchases[1].payout_spk);
    let leaf_1 = compute_purchase_leaf(&canonical_round_id, 1, 5, purchases[1].count, &p_comm_1);
    active_leaves_after_2.insert(0, leaf_0);
    active_leaves_after_2.insert(1, leaf_1);
    // leaf 2 is EMPTY!
    let empty_levels = compute_empty_levels();
    let tree_after_2 = build_sparse_tree(&active_leaves_after_2, &empty_levels);
    let mut sibs_0_after_2 = [Hash::default(); TREE_DEPTH];
    for l in 0..TREE_DEPTH {
        let sib_idx = (purchases[0].index >> l) ^ 1;
        sibs_0_after_2[l] = get_sparse_node(l, sib_idx, &tree_after_2, &empty_levels);
    }
    // Verify sibs_0_after_2 against root_after_2:
    assert_eq!(compute_root_from_path(&leaf_0, 0, &sibs_0_after_2), root_after_2);

    let root_after_0 = compute_root_from_path(&empty_leaf, 0, &sibs_0_after_2);
    let covenant_after_0 = build_refund_claims_covenant(
        canonical_round_id,
        ticket_price,
        root_after_0,
        creator_refund_spk.clone(),
    ).unwrap();
    let spk_claims_after_0 = pay_to_script_hash_script(&covenant_after_0);

    let refund_amount_0 = ticket_price * purchases[0].count;
    let out0_amount_after_0 = out0_amount_after_2 - refund_amount_0;

    let mut sig_sb_0 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_0.add_data(&sibs_0_after_2[i].as_bytes()).unwrap(); }
    sig_sb_0.add_data(&purchases[0].payout_spk).unwrap();
    sig_sb_0.add_data(&purchases[0].count.to_le_bytes()).unwrap();
    sig_sb_0.add_data(&purchases[0].start.to_le_bytes()).unwrap();
    sig_sb_0.add_data(&purchases[0].index.to_le_bytes()).unwrap();
    sig_sb_0.add_data(&covenant_after_2).unwrap();
    let sig_script_0 = sig_sb_0.drain();

    let tx_r2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(3), 0),
            sig_script_0.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: out0_amount_after_0,
                script_public_key: spk_claims_after_0.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: refund_amount_0,
                script_public_key: ScriptPublicKey::from_vec(0, purchases[0].payout_spk[2..].to_vec()),
                covenant: None,
            },
        ],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_r2 = PopulatedTransaction::new(&tx_r2, vec![UtxoEntry::new(
        out0_amount_after_2,
        spk_claims_after_2.clone(),
        0,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_r2 = CovenantsContext::from_tx(&pop_r2).unwrap();
    let ctx_r2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_r2);
    let mut vm_r2 = TxScriptEngine::from_transaction_input(&pop_r2, &pop_r2.tx.inputs[0], 0, &pop_r2.entries[0], ctx_r2, flags);
    let res_r2 = vm_r2.execute();
    assert_eq!(res_r2, Ok(()));
    println!("  -> PASS: Claim #0 (SECOND) succeeded in TxScriptEngine!");

    // -------------------------------------------------------------
    // R3: Claim Purchase #1 THIRD (TERMINAL CLAIM)
    // Only purchase 1 remains. After claiming 1, new_root == EMPTY_ROOT_27!
    // -------------------------------------------------------------
    println!("\n[Test R3] Claim purchase #1 THIRD (TERMINAL -> EMPTY_ROOT_27)");
    let mut active_leaves_after_0 = std::collections::HashMap::new();
    active_leaves_after_0.insert(1, leaf_1);
    let tree_after_0 = build_sparse_tree(&active_leaves_after_0, &empty_levels);
    let mut sibs_1_after_0 = [Hash::default(); TREE_DEPTH];
    for l in 0..TREE_DEPTH {
        let sib_idx = (purchases[1].index >> l) ^ 1;
        sibs_1_after_0[l] = get_sparse_node(l, sib_idx, &tree_after_0, &empty_levels);
    }
    assert_eq!(compute_root_from_path(&leaf_1, 1, &sibs_1_after_0), root_after_0);

    let terminal_root = compute_root_from_path(&empty_leaf, 1, &sibs_1_after_0);
    assert_eq!(terminal_root, ticket_commitment::compute_empty_root_27());
    println!("  Confirmed: terminal root matches EMPTY_ROOT_27 exactly!");

    let refund_amount_1 = ticket_price * purchases[1].count;
    let terminal_creator_amount = out0_amount_after_0 - refund_amount_1;
    assert_eq!(terminal_creator_amount, state_deposit);
    println!("  Confirmed: terminal_creator_amount == state_deposit ({} sompi) exactly!", terminal_creator_amount);

    let mut sig_sb_1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_1.add_data(&sibs_1_after_0[i].as_bytes()).unwrap(); }
    sig_sb_1.add_data(&purchases[1].payout_spk).unwrap();
    sig_sb_1.add_data(&purchases[1].count.to_le_bytes()).unwrap();
    sig_sb_1.add_data(&purchases[1].start.to_le_bytes()).unwrap();
    sig_sb_1.add_data(&purchases[1].index.to_le_bytes()).unwrap();
    sig_sb_1.add_data(&covenant_after_0).unwrap();
    let sig_script_1 = sig_sb_1.drain();

    let tx_r3 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(4), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: terminal_creator_amount,
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
                covenant: None, // KIP-20 destroyed!
            },
            TransactionOutput {
                value: refund_amount_1,
                script_public_key: ScriptPublicKey::from_vec(0, purchases[1].payout_spk[2..].to_vec()),
                covenant: None,
            },
        ],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_r3 = PopulatedTransaction::new(&tx_r3, vec![UtxoEntry::new(
        out0_amount_after_0,
        spk_claims_after_0.clone(),
        0,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_r3 = CovenantsContext::from_tx(&pop_r3).unwrap();
    let ctx_r3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_r3);
    let mut vm_r3 = TxScriptEngine::from_transaction_input(&pop_r3, &pop_r3.tx.inputs[0], 0, &pop_r3.entries[0], ctx_r3, flags);
    let res_r3 = vm_r3.execute();
    let u_r3 = vm_r3.used_script_units();
    let b_r3 = ComputeBudget::checked_covering_script_units(u_r3).unwrap();
    assert_eq!(res_r3, Ok(()));
    println!("  -> PASS: Terminal claim #1 executed! Output 0 pays exact state_deposit, Covenant destroyed! [Units: {:?}, B_min: {:?}]", u_r3, b_r3);

    // -------------------------------------------------------------
    // NEGATIVE TESTS R5 - R18
    // -------------------------------------------------------------
    println!("\n--- RUNNING NEGATIVE TEST SUITE (R5 - R18) ---");

    // Helper macro to run negative test
    let run_neg_test = |name: &str, tx: Transaction, entry_val: u64, entry_spk: ScriptPublicKey| {
        let pop = PopulatedTransaction::new(&tx, vec![UtxoEntry::new(
            entry_val,
            entry_spk,
            0,
            false,
            Some(covenant_id_c),
        )]);
        let cov_ctx_res = CovenantsContext::from_tx(&pop);
        if let Err(cov_err) = cov_ctx_res {
            println!("  -> PASS: {} correctly rejected by consensus covenants check: {:?}", name, cov_err);
            return;
        }
        let cov_ctx = cov_ctx_res.unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx, flags);
        let res = vm.execute();
        assert!(res.is_err(), "Test {} expected error but passed!", name);
        println!("  -> PASS: {} correctly failed with {:?}", name, res.err().unwrap());
    };

    // R5: Wrong payout_spk in witness
    let mut sig_sb_r5 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r5.add_data(&sibs_initial[2][i].as_bytes()).unwrap(); }
    sig_sb_r5.add_data(&purchases[0].payout_spk).unwrap(); // wrong spk!
    sig_sb_r5.add_data(&purchases[2].count.to_le_bytes()).unwrap();
    sig_sb_r5.add_data(&purchases[2].start.to_le_bytes()).unwrap();
    sig_sb_r5.add_data(&purchases[2].index.to_le_bytes()).unwrap();
    sig_sb_r5.add_data(&covenant_initial).unwrap();
    let mut tx_r5 = tx_r1.clone();
    tx_r5.inputs[0].signature_script = sig_sb_r5.drain();
    run_neg_test("R5: wrong payout_spk", tx_r5, initial_claims_amount, spk_claims_initial.clone());

    // R6: Wrong purchase_index
    let mut sig_sb_r6 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r6.add_data(&sibs_initial[2][i].as_bytes()).unwrap(); }
    sig_sb_r6.add_data(&purchases[2].payout_spk).unwrap();
    sig_sb_r6.add_data(&purchases[2].count.to_le_bytes()).unwrap();
    sig_sb_r6.add_data(&purchases[2].start.to_le_bytes()).unwrap();
    sig_sb_r6.add_data(&7u64.to_le_bytes()).unwrap(); // wrong index!
    sig_sb_r6.add_data(&covenant_initial).unwrap();
    let mut tx_r6 = tx_r1.clone();
    tx_r6.inputs[0].signature_script = sig_sb_r6.drain();
    run_neg_test("R6: wrong purchase_index", tx_r6, initial_claims_amount, spk_claims_initial.clone());

    // R7: Wrong start_ticket
    let mut sig_sb_r7 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r7.add_data(&sibs_initial[2][i].as_bytes()).unwrap(); }
    sig_sb_r7.add_data(&purchases[2].payout_spk).unwrap();
    sig_sb_r7.add_data(&purchases[2].count.to_le_bytes()).unwrap();
    sig_sb_r7.add_data(&99u64.to_le_bytes()).unwrap(); // wrong start!
    sig_sb_r7.add_data(&purchases[2].index.to_le_bytes()).unwrap();
    sig_sb_r7.add_data(&covenant_initial).unwrap();
    let mut tx_r7 = tx_r1.clone();
    tx_r7.inputs[0].signature_script = sig_sb_r7.drain();
    run_neg_test("R7: wrong start_ticket", tx_r7, initial_claims_amount, spk_claims_initial.clone());

    // R8: Wrong count
    let mut sig_sb_r8 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r8.add_data(&sibs_initial[2][i].as_bytes()).unwrap(); }
    sig_sb_r8.add_data(&purchases[2].payout_spk).unwrap();
    sig_sb_r8.add_data(&3u64.to_le_bytes()).unwrap(); // wrong count!
    sig_sb_r8.add_data(&purchases[2].start.to_le_bytes()).unwrap();
    sig_sb_r8.add_data(&purchases[2].index.to_le_bytes()).unwrap();
    sig_sb_r8.add_data(&covenant_initial).unwrap();
    let mut tx_r8 = tx_r1.clone();
    tx_r8.inputs[0].signature_script = sig_sb_r8.drain();
    run_neg_test("R8: wrong count", tx_r8, initial_claims_amount, spk_claims_initial.clone());

    // R9: Wrong sibling
    let mut wrong_sibs = sibs_initial[2];
    wrong_sibs[0] = Hash::from_u64_word(777);
    let mut sig_sb_r9 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r9.add_data(&wrong_sibs[i].as_bytes()).unwrap(); }
    sig_sb_r9.add_data(&purchases[2].payout_spk).unwrap();
    sig_sb_r9.add_data(&purchases[2].count.to_le_bytes()).unwrap();
    sig_sb_r9.add_data(&purchases[2].start.to_le_bytes()).unwrap();
    sig_sb_r9.add_data(&purchases[2].index.to_le_bytes()).unwrap();
    sig_sb_r9.add_data(&covenant_initial).unwrap();
    let mut tx_r9 = tx_r1.clone();
    tx_r9.inputs[0].signature_script = sig_sb_r9.drain();
    run_neg_test("R9: wrong sibling", tx_r9, initial_claims_amount, spk_claims_initial.clone());

    // R10: Successor root mismatch (tampered output SPK)
    let mut tx_r10 = tx_r1.clone();
    tx_r10.outputs[0].script_public_key = spk_claims_initial.clone(); // didn't update to root_after_2!
    run_neg_test("R10: successor root mismatch", tx_r10, initial_claims_amount, spk_claims_initial.clone());

    // R11: Refund amount - 1
    let mut tx_r11 = tx_r1.clone();
    tx_r11.outputs[1].value = refund_amount_2 - 1;
    run_neg_test("R11: refund amount underpaid by 1", tx_r11, initial_claims_amount, spk_claims_initial.clone());

    // R12: Refund amount + 1
    let mut tx_r12 = tx_r1.clone();
    tx_r12.outputs[1].value = refund_amount_2 + 1;
    run_neg_test("R12: refund amount overpaid by 1", tx_r12, initial_claims_amount, spk_claims_initial.clone());

    // R13: Fee deducted from buyer principal
    let mut tx_r13 = tx_r1.clone();
    tx_r13.outputs[1].value = refund_amount_2 - 10_000;
    run_neg_test("R13: fee deducted from buyer principal", tx_r13, initial_claims_amount, spk_claims_initial.clone());

    // R14: Fee deducted from state amount
    let mut tx_r14 = tx_r1.clone();
    tx_r14.outputs[0].value = out0_amount_after_2 - 10_000;
    run_neg_test("R14: fee deducted from state amount", tx_r14, initial_claims_amount, spk_claims_initial.clone());

    // R15: Foreign covenant on buyer output
    let mut tx_r15 = tx_r1.clone();
    tx_r15.outputs[1].covenant = Some(CovenantBinding { covenant_id: Hash::from_u64_word(888), authorizing_input: 0 });
    run_neg_test("R15: foreign covenant on buyer output", tx_r15, initial_claims_amount, spk_claims_initial.clone());

    // R16: Second C continuation on buyer output
    let mut tx_r16 = tx_r1.clone();
    tx_r16.outputs[1].covenant = Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 });
    run_neg_test("R16: second C continuation on buyer output", tx_r16, initial_claims_amount, spk_claims_initial.clone());

    // R17: Terminal claim before root == EMPTY_ROOT (e.g. prematurely executing terminal branch on claim #2)
    // If we try to craft tx_r1 as a terminal claim where Output 0 pays creator_refund_spk:
    let mut tx_r17 = tx_r1.clone();
    tx_r17.outputs[0].script_public_key = ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec());
    tx_r17.outputs[0].covenant = None;
    run_neg_test("R17: premature terminal output when root != EMPTY_ROOT", tx_r17, initial_claims_amount, spk_claims_initial.clone());

    // R18: Non-canonical buyer payout SPK in witness (e.g. truncated SPK rejected by append_canonical_payout_spk_check)
    let mut sig_sb_r18 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r18.add_data(&sibs_initial[2][i].as_bytes()).unwrap(); }
    sig_sb_r18.add_data(&[0x00, 0x00, 0x01, 0x02]).unwrap(); // non-canonical 4-byte SPK!
    sig_sb_r18.add_data(&purchases[2].count.to_le_bytes()).unwrap();
    sig_sb_r18.add_data(&purchases[2].start.to_le_bytes()).unwrap();
    sig_sb_r18.add_data(&purchases[2].index.to_le_bytes()).unwrap();
    sig_sb_r18.add_data(&covenant_initial).unwrap();
    let mut tx_r18 = tx_r1.clone();
    tx_r18.inputs[0].signature_script = sig_sb_r18.drain();
    run_neg_test("R18: non-canonical buyer payout SPK", tx_r18, initial_claims_amount, spk_claims_initial.clone());

    println!("\n================================================================");
    println!("ALL R1 - R18 ANY-ORDER CLAIM & REFUND PROOFS PASSED 100%!");
    println!("================================================================");
}
