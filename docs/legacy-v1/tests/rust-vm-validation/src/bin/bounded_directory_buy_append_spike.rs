//! Isolated near-production bounded-directory BUY append + SEALED preservation + winner owner proof spike.
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
    EngineCtx, EngineFlags, TxScriptEngine,
};

#[path = "../../../../contracts/lineage.rs"]
mod lineage;

#[path = "../../../../contracts/ticket_commitment.rs"]
mod ticket_commitment;
use ticket_commitment::{
    compute_payout_commitment, compute_purchase_leaf, hash_internal_node, compute_empty_levels,
};

const MAX_TOTAL_TICKETS: u32 = 100_000;
const ROUND_ID: Hash = Hash::from_bytes([0x52; 32]);
const TICKET_PRICE: u64 = 1_000;
const REFUND_LOCK_DAA: u64 = 1_000_000;
const STATE_AMOUNT: u64 = 10_000_000_000; // 100 KAS state deposit
const BUY_FEE: u64 = 1_000_000;
const COVENANT_ID: Hash = Hash::from_bytes([0x77; 32]);
const CREATOR_PUBKEY: [u8; 32] = [0x44; 32];

#[derive(Clone, Debug, PartialEq, Eq)]
struct Record { end: u32, key: [u8; 32] }

fn p2pk_bytes(key: [u8; 32]) -> Vec<u8> {
    let mut x = vec![0x20];
    x.extend_from_slice(&key);
    x.push(0xac);
    x
}

fn records_with_denominator(count: usize, denominator: usize) -> Vec<Record> {
    (0..count).map(|i| Record {
        end: (((i as u64 + 1) * MAX_TOTAL_TICKETS as u64) / denominator as u64) as u32,
        key: [((i * 13) & 0xff) as u8; 32],
    }).collect()
}

fn records(count: usize) -> Vec<Record> { records_with_denominator(count, count) }

fn push_data_len(len: usize) -> Vec<u8> {
    match len {
        0..=75 => vec![len as u8],
        76..=255 => vec![0x4c, len as u8],
        _ => vec![0x4d, (len & 0xff) as u8, ((len >> 8) & 0xff) as u8],
    }
}

fn directory_bytes(rs: &[Record]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rs.len() * 36);
    for r in rs {
        out.extend_from_slice(&r.end.to_le_bytes());
        out.extend_from_slice(&r.key);
    }
    out
}

fn deserialize_directory(bytes: &[u8]) -> Vec<Record> {
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

fn directory_root(records: &[Record], round_id: &Hash) -> Hash {
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

// -----------------------------------------------------------------------------
// OPEN Covenant Builders
// -----------------------------------------------------------------------------

fn build_prefix(rs: &[Record], sold: u32, purchase_count: u32) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&ROUND_ID.as_bytes()).unwrap();
    sb.add_data(&TICKET_PRICE.to_le_bytes()).unwrap();
    sb.add_data(&MAX_TOTAL_TICKETS.to_le_bytes()).unwrap();
    sb.add_data(&REFUND_LOCK_DAA.to_le_bytes()).unwrap();
    sb.add_data(&sold.to_le_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(&directory_bytes(rs)).unwrap();
    sb.drain()
}

fn append_push_from_top(sb: &mut ScriptBuilder, width: usize) -> kaspa_txscript::script_builder::ScriptBuilderResult<()> {
    sb.add_data(&push_data_len(width))?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    Ok(())
}

fn append_prefix_item(sb: &mut ScriptBuilder, depth: i64, width: usize) -> kaspa_txscript::script_builder::ScriptBuilderResult<()> {
    sb.add_i64(depth)?;
    sb.add_op(OpPick)?;
    append_push_from_top(sb, width)?;
    sb.add_op(OpFromAltStack)?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_op(OpToAltStack)?;
    Ok(())
}

fn build_body(max_purchase_count: usize, body_len: usize) -> kaspa_txscript::script_builder::ScriptBuilderResult<Vec<u8>> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Entry stack, bottom to top: count, key, round_id, ticket_price,
    // max_total, refund_lock, sold_tickets, purchase_count, directory.
    sb.add_op(OpDepth)?;
    sb.add_i64(9)?;
    sb.add_op(OpNumEqualVerify)?;

    // Fixed witness widths: key=7, count=8.
    sb.add_i64(7)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_i64(32)?; sb.add_op(OpNumEqualVerify)?; sb.add_op(OpDrop)?;
    sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpSize)?;
    sb.add_i64(8)?; sb.add_op(OpNumEqualVerify)?; sb.add_op(OpDrop)?;

    // count >= 1.
    sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_i64(1)?; sb.add_op(OpGreaterThanOrEqual)?; sb.add_op(OpVerify)?;

    // sold_after = sold_before + count <= MAX_TOTAL_TICKETS.
    sb.add_i64(2)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_i64(9)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_op(OpAdd)?; sb.add_op(OpDup)?;
    sb.add_i64(6)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_op(OpLessThanOrEqual)?; sb.add_op(OpVerify)?;
    sb.add_i64(4)?; sb.add_op(OpNum2Bin)?;

    // Start canonical dynamic prefix and append immutable fields.
    sb.add_data(&[0xb9, 0x00, 0x88])?; sb.add_op(OpToAltStack)?;
    append_prefix_item(&mut sb, 7, 32)?; // round_id
    append_prefix_item(&mut sb, 6, 8)?;  // ticket_price
    append_prefix_item(&mut sb, 5, 4)?;  // max_total_tickets
    append_prefix_item(&mut sb, 4, 8)?;  // refund_lock_daa
    // sold_after is top of dstack; turn it into a push and append to prefix.
    sb.add_data(&[0x04])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
    sb.add_op(OpFromAltStack)?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?; sb.add_op(OpToAltStack)?;

    // Canonical payout P2PK check, while original entry layout is intact.
    sb.add_data(&[0x00, 0x00, 0x20])?;
    sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?;
    sb.add_data(&[0xac])?; sb.add_op(OpCat)?; sb.add_op(OpDrop)?;

    // purchase_count_after = purchase_count + 1 <= configured maximum.
    sb.add_i64(1)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_i64(1)?; sb.add_op(OpAdd)?; sb.add_op(OpDup)?;
    sb.add_i64(max_purchase_count as i64)?; sb.add_op(OpLessThanOrEqual)?; sb.add_op(OpVerify)?;
    sb.add_i64(4)?; sb.add_op(OpNum2Bin)?;
    sb.add_data(&[0x04])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
    sb.add_op(OpFromAltStack)?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?; sb.add_op(OpToAltStack)?;

    // Exact payment and singleton continuation.
    sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_i64(6)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_op(OpMul)?; sb.add_op(Op0)?; sb.add_op(OpTxInputAmount)?;
    sb.add_op(OpAdd)?; sb.add_op(Op0)?; sb.add_op(OpTxOutputAmount)?;
    sb.add_op(OpEqualVerify)?;
    lineage::append_kaswin_singleton_continuation_guard(&mut sb)?;

    // Build exactly old_directory || new_record.
    sb.add_i64(2)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_i64(9)?; sb.add_op(OpPick)?; sb.add_op(OpBin2Num)?;
    sb.add_op(OpAdd)?; sb.add_i64(4)?; sb.add_op(OpNum2Bin)?;
    sb.add_i64(8)?; sb.add_op(OpPick)?; sb.add_op(OpCat)?;
    // raw new directory: old directory is depth 1 because new_record is top.
    sb.add_i64(1)?; sb.add_op(OpPick)?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;

    // Runtime canonical Script push encoding.
    sb.add_op(OpSize)?;
    sb.add_op(OpDup)?; sb.add_i64(75)?; sb.add_op(OpLessThanOrEqual)?;
    sb.add_op(OpIf)?;
        sb.add_i64(1)?; sb.add_op(OpNum2Bin)?;
        sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
        sb.add_op(OpToAltStack)?;
    sb.add_op(OpElse)?;
        sb.add_op(OpDup)?; sb.add_i64(255)?; sb.add_op(OpLessThanOrEqual)?;
        sb.add_op(OpIf)?;
            sb.add_op(OpDup)?; sb.add_i64(127)?; sb.add_op(OpLessThanOrEqual)?;
            sb.add_op(OpIf)?;
                sb.add_i64(1)?; sb.add_op(OpNum2Bin)?;
            sb.add_op(OpElse)?;
                sb.add_i64(2)?; sb.add_op(OpNum2Bin)?;
                sb.add_i64(0)?; sb.add_i64(1)?; sb.add_op(OpSubstr)?;
            sb.add_op(OpEndIf)?;
            sb.add_data(&[0x4c])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
            sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
            sb.add_op(OpToAltStack)?;
        sb.add_op(OpElse)?;
            sb.add_i64(2)?; sb.add_op(OpNum2Bin)?;
            sb.add_data(&[0x4d])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
            sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
            sb.add_op(OpToAltStack)?;
        sb.add_op(OpEndIf)?;
    sb.add_op(OpEndIf)?;

    // Combine directory push with assembled prefix.
    sb.add_op(OpFromAltStack)?;
    sb.add_op(OpFromAltStack)?;
    sb.add_op(OpSwap)?;
    sb.add_op(OpCat)?;
    sb.add_op(OpToAltStack)?;

    // Recover only the invariant body from current old signature script.
    sb.add_op(OpFromAltStack)?;
    sb.add_op(Op0)?;
    sb.add_op(OpTxInputScriptSigLen)?;
    sb.add_op(OpDup)?; sb.add_i64(body_len as i64)?; sb.add_op(OpSub)?;
    sb.add_op(OpSwap)?;
    sb.add_op(Op0)?;
    sb.add_i64(2)?; sb.add_op(OpRoll)?;
    sb.add_i64(2)?; sb.add_op(OpRoll)?;
    sb.add_op(OpTxInputScriptSigSubstr)?;
    sb.add_op(OpCat)?;

    // Exact P2SH SPK equality.
    sb.add_data(b"")?; sb.add_op(OpBlake2bWithKey)?;
    sb.add_data(&[0x00, 0x00, 0xaa, 0x20])?; sb.add_op(OpSwap)?; sb.add_op(OpCat)?;
    sb.add_data(&[0x87])?; sb.add_op(OpCat)?; sb.add_op(Op0)?; sb.add_op(OpTxOutputSpk)?;
    sb.add_op(OpEqualVerify)?;

    // Clean stack.
    sb.add_op(OpTrue)?;
    for _ in 0..9 { sb.add_op(OpSwap)?; sb.add_op(OpDrop)?; }
    Ok(sb.drain())
}

fn body_len_fixed(max_purchase_count: usize) -> usize {
    let mut guess = 2_000usize;
    for _ in 0..32 {
        let body = build_body(max_purchase_count, guess).unwrap();
        if body.len() == guess { return guess; }
        guess = body.len();
    }
    panic!("static body length did not converge for N={max_purchase_count}");
}

fn build_redeem(rs: &[Record], sold: u32, purchase_count: u32, max_purchase_count: usize) -> Vec<u8> {
    let body_len = body_len_fixed(max_purchase_count);
    let mut out = build_prefix(rs, sold, purchase_count);
    out.extend_from_slice(&build_body(max_purchase_count, body_len).unwrap());
    out
}

fn make_fixture(old_redeem: &[u8], new_redeem: &[u8], old_amount: u64, payment: u64, count: u64, key: [u8; 32], covenant_id: Hash) -> Transaction {
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let mut sig = ScriptBuilder::with_flags(flags);
    sig.add_data(&count.to_le_bytes()).unwrap();
    sig.add_data(&key).unwrap();
    sig.add_data(old_redeem).unwrap();
    let state_sig = sig.drain();
    let ordinary_sig = {
        let mut b = ScriptBuilder::new();
        b.add_data(&[0x20; 32]).unwrap();
        b.add_op(OpTrue).unwrap();
        b.drain()
    };
    let change = 1_000_000_000u64 - payment - BUY_FEE;
    Transaction::new(1,
        vec![
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(1), 0), state_sig, 0, ComputeCommit::ComputeBudget(ComputeBudget(20))),
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(2), 0), ordinary_sig, 0, ComputeCommit::ComputeBudget(ComputeBudget(0))),
        ],
        vec![
            TransactionOutput { value: old_amount + payment, script_public_key: pay_to_script_hash_script(new_redeem), covenant: Some(CovenantBinding { covenant_id, authorizing_input: 0 }) },
            TransactionOutput { value: change, script_public_key: ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), covenant: None },
        ], 0, SubnetworkId::default(), 0, vec![])
}

// -----------------------------------------------------------------------------
// SEALED Directory Covenant Builders (Phase A & B)
// -----------------------------------------------------------------------------

/// Canonical Directory-Preserving SEALED Prefix (9,350 bytes for N=256)
fn build_sealed_dir_prefix(
    round_id: &Hash,
    ticket_price: u64,
    total_tickets: u64,
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
    sb.add_data(&total_tickets.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.add_data(directory).unwrap();
    sb.drain()
}

/// Static SEALED Directory Body (Winner lookup & settlement or pass-a draw)
fn build_sealed_dir_body(_total_tickets: u64, _creator_spk_len: usize) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Entry stack from prefix + witness:
    // [winner_index (8B num), i (num), round_id (32B), ticket_price (8B), total_tickets (8B),
    //  ticket_root (32B), purchase_count (8B), creator_refund_spk (34B), directory (9216B)]
    // Depth: directory=0, creator=1, pc=2, root=3, total=4, price=5, round=6, i=7, winner=8.

    // 1. Verify 0 <= i < 256:
    sb.add_i64(7).unwrap(); sb.add_op(OpPick).unwrap();
    sb.add_op(OpDup).unwrap(); sb.add_i64(0).unwrap(); sb.add_op(OpGreaterThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();
    sb.add_op(OpDup).unwrap(); sb.add_i64(256).unwrap(); sb.add_op(OpLessThan).unwrap(); sb.add_op(OpVerify).unwrap();

    // 2. Compute offset_i = i * 36:
    sb.add_op(OpDup).unwrap(); sb.add_i64(36).unwrap(); sb.add_op(OpMul).unwrap();

    // 3. Extract current_end = directory[offset_i .. offset_i + 4]:
    sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // directory is depth 2
    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // offset_i
    sb.add_op(OpDup).unwrap(); sb.add_i64(4).unwrap(); sb.add_op(OpAdd).unwrap();
    sb.add_op(OpSubstr).unwrap();
    sb.add_op(OpBin2Num).unwrap(); // current_end_num

    // Check winner_index < current_end:
    sb.add_i64(11).unwrap(); sb.add_op(OpPick).unwrap(); // winner_index
    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap();  // current_end_num
    sb.add_op(OpLessThan).unwrap(); sb.add_op(OpVerify).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop current_end_num

    // 4. Extract start_num:
    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // i
    sb.add_i64(0).unwrap(); sb.add_op(OpEqual).unwrap();
    sb.add_op(OpIf).unwrap();
        sb.add_i64(0).unwrap(); // start_num = 0
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

    // Check start_num <= winner_index:
    sb.add_op(OpDup).unwrap();
    sb.add_i64(12).unwrap(); sb.add_op(OpPick).unwrap(); // winner_index
    sb.add_op(OpLessThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();
    sb.add_op(OpDrop).unwrap(); // drop start_num

    // 5. Extract payout_pubkey = directory[offset_i + 4 .. offset_i + 36]:
    sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // directory
    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // offset_i
    sb.add_i64(4).unwrap(); sb.add_op(OpAdd).unwrap();  // offset_i + 4
    sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // offset_i
    sb.add_i64(36).unwrap(); sb.add_op(OpAdd).unwrap(); // offset_i + 36
    sb.add_op(OpSubstr).unwrap(); // 32-byte payout_pubkey
    sb.add_op(OpToAltStack).unwrap();

    sb.add_op(OpDrop).unwrap(); // drop offset_i
    sb.add_op(OpDrop).unwrap(); // drop i

    // Stack is now back to 9 entry items.
    // 6. Assert Output 0 SPK matches canonical P2PK(payout_pubkey):
    sb.add_data(&[0x20]).unwrap();
    sb.add_op(OpFromAltStack).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(&[0xac]).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_data(&[0x00, 0x00]).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // [0x00, 0x00, 0x20, key, 0xac]
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // 7. Assert Output 0 amount == ticket_price * total_tickets (net prize pool):
    sb.add_i64(5).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // ticket_price
    sb.add_i64(5).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // total_tickets
    sb.add_op(OpMul).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // 8. Assert Output 1 SPK == creator_refund_spk:
    sb.add_data(&[0x00, 0x00]).unwrap();
    sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // creator_refund_spk (depth 1 + 1)
    sb.add_op(OpCat).unwrap();
    sb.add_i64(1).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // 9. Assert Output 1 amount == state_deposit:
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap();
    sb.add_i64(6).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // price
    sb.add_i64(6).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // total
    sb.add_op(OpMul).unwrap();
    sb.add_op(OpSub).unwrap(); // Input0 - prize = state_deposit
    sb.add_i64(1).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // 10. Clean stack:
    sb.add_op(OpTrue).unwrap();
    for _ in 0..9 { sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap(); }

    sb.drain()
}

fn build_sealed_dir_redeem(
    round_id: &Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: &Hash,
    purchase_count: u64,
    creator_refund_spk: &[u8],
    directory: &[u8],
) -> Vec<u8> {
    let mut out = build_sealed_dir_prefix(round_id, ticket_price, total_tickets, ticket_root, purchase_count, creator_refund_spk, directory);
    out.extend_from_slice(&build_sealed_dir_body(total_tickets, creator_refund_spk.len()));
    out
}

// -----------------------------------------------------------------------------
// Final BUY (OPEN -> SEALED) Covenant Body (Phase B)
// -----------------------------------------------------------------------------

fn build_final_buy_open_body(sealed_body: &[u8], creator_refund_spk: &[u8]) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Entry stack:
    // [count (8B), key (32B), final_ticket_root (32B),
    //  round_id (32B), ticket_price (8B), max_total (4B), refund_lock (8B),
    //  sold_tickets (4B), purchase_count (4B), old_directory (9180B)]
    // Depth: dir=0, pc=1, sold=2, lock=3, max=4, price=5, round=6, root=7, key=8, count=9.
    sb.add_op(OpDepth).unwrap();
    sb.add_i64(10).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // Witness validations:
    sb.add_i64(9).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();
    sb.add_i64(7).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpSize).unwrap();
    sb.add_i64(32).unwrap(); sb.add_op(OpNumEqualVerify).unwrap(); sb.add_op(OpDrop).unwrap();

    // count >= 1:
    sb.add_i64(9).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(1).unwrap(); sb.add_op(OpGreaterThanOrEqual).unwrap(); sb.add_op(OpVerify).unwrap();

    // sold_after = sold_before + count: MUST EQUAL max_total_tickets (100,000)!
    sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(10).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_i64(5).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // max_total (depth 4+1)
    sb.add_op(OpNumEqualVerify).unwrap();

    // purchase_count_after = purchase_count + 1 == 256:
    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(1).unwrap(); sb.add_op(OpAdd).unwrap();
    sb.add_i64(256).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();

    // Exact payment: Output0 amount == Input0 amount + ticket_price * count:
    sb.add_i64(9).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(6).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // ticket_price (depth 5+1)
    sb.add_op(OpMul).unwrap();
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap();
    sb.add_op(OpAdd).unwrap();
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // KIP-20 continuation guard:
    lineage::append_kaswin_singleton_continuation_guard(&mut sb).unwrap();

    // Build final_directory = old_directory || new_record (9,216 bytes):
    sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); // max_total (100,000 LE u32)
    sb.add_i64(9).unwrap(); sb.add_op(OpPick).unwrap(); // buyer_key (depth 8+1)
    sb.add_op(OpCat).unwrap(); // new_record (36B)
    sb.add_i64(1).unwrap(); sb.add_op(OpPick).unwrap(); // old_directory (depth 0+1)
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap(); // final_directory (9,216B)
    // Add OP_PUSHDATA2 prefix: [0x4d, 0x00, 0x24] || final_directory:
    sb.add_data(&[0x4d, 0x00, 0x24]).unwrap();
    sb.add_op(OpSwap).unwrap();
    sb.add_op(OpCat).unwrap();
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [directory_push]

    // Assemble SEALED prefix on AltStack while dstack has the untouched 10 entry items:
    // depth 0: old_directory
    // depth 1: purchase_count
    // depth 2: sold_tickets
    // depth 3: refund_lock_daa
    // depth 4: max_total_tickets
    // depth 5: ticket_price
    // depth 6: round_id
    // depth 7: final_ticket_root
    // depth 8: buyer_key
    // depth 9: count
    sb.add_data(&[0xb9, 0x00, 0x88]).unwrap();
    sb.add_op(OpToAltStack).unwrap();

    // [1] round_id (depth 6)
    append_prefix_item(&mut sb, 6, 32).unwrap();

    // [2] ticket_price (depth 5)
    append_prefix_item(&mut sb, 5, 8).unwrap();

    // [3] total_tickets as 8 bytes LE (depth 4)
    sb.add_i64(4).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap();
    sb.add_i64(8).unwrap(); sb.add_op(OpNum2Bin).unwrap();
    append_push_from_top(&mut sb, 8).unwrap();
    sb.add_op(OpFromAltStack).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
    sb.add_op(OpToAltStack).unwrap();

    // [4] final_ticket_root (depth 7)
    append_prefix_item(&mut sb, 7, 32).unwrap();

    // [5] purchase_count = 256 (8 bytes LE):
    sb.add_data(&[0x08, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).unwrap();
    sb.add_op(OpFromAltStack).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
    sb.add_op(OpToAltStack).unwrap();

    // [6] creator_refund_spk:
    let mut creator_push = push_data_len(creator_refund_spk.len());
    creator_push.extend_from_slice(creator_refund_spk);
    sb.add_data(&creator_push).unwrap();
    sb.add_op(OpFromAltStack).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
    sb.add_op(OpToAltStack).unwrap();

    // Append directory push:
    // AltStack top is assembled_prefix; second is directory_push.
    // We want assembled_prefix || directory_push:
    sb.add_op(OpFromAltStack).unwrap(); // dstack: [assembled_prefix]
    sb.add_op(OpFromAltStack).unwrap(); // dstack: [assembled_prefix, directory_push]
    sb.add_op(OpCat).unwrap();          // dstack: [assembled_prefix || directory_push]

    // Append SEALED body:
    sb.add_data(sealed_body).unwrap();
    sb.add_op(OpCat).unwrap(); // assembled expected_sealed_redeem!

    // Exact P2SH SPK equality against Output 0:
    sb.add_data(b"").unwrap(); sb.add_op(OpBlake2bWithKey).unwrap();
    sb.add_data(&[0x00, 0x00, 0xaa, 0x20]).unwrap(); sb.add_op(OpSwap).unwrap(); sb.add_op(OpCat).unwrap();
    sb.add_data(&[0x87]).unwrap(); sb.add_op(OpCat).unwrap();
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Clean stack:
    sb.add_op(OpTrue).unwrap();
    for _ in 0..10 { sb.add_op(OpSwap).unwrap(); sb.add_op(OpDrop).unwrap(); }

    sb.drain()
}

// -----------------------------------------------------------------------------
// VM Execution Helper
// -----------------------------------------------------------------------------

fn run_vm(tx: &Transaction, old_redeem: &[u8], input0_amount: u64, budget: Option<ComputeBudget>) -> Result<(), kaspa_txscript_errors::TxScriptError> {
    let mut tx_exec = tx.clone();
    if let Some(b) = budget {
        tx_exec.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b);
    }
    let pop = PopulatedTransaction::new(&tx_exec, vec![
        UtxoEntry::new(input0_amount, pay_to_script_hash_script(old_redeem), 1_000_000, false, Some(COVENANT_ID)),
        UtxoEntry::new(1_000_000_000, ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), 1_000_000, false, None),
    ]);
    let cov = CovenantsContext::from_tx(&pop).map_err(|e| kaspa_txscript_errors::TxScriptError::CovenantsError(e))?;
    let cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let ectx = EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);
    let allowed_units = tx_exec.inputs[0].compute_commit.allowed_script_units();
    let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop, &pop.tx.inputs[0], 0, &pop.entries[0], ectx,
        EngineFlags { covenants_enabled: true, ..Default::default() },
        allowed_units,
    );
    vm.execute()
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

fn main() {
    println!("KASWIN V1 — DIRECTORY SEALED PRESERVATION + WINNER OWNER PROOF SPIKE");
    let mass = MassCalculator::new_with_consensus_params(&TESTNET_PARAMS);
    let cof = TESTNET_PARAMS.block_mass_cofactors().after();

    // =========================================================================
    // SECTION 1: Push Serialization Audit
    // =========================================================================
    println!("\n=== 1. DIRECTORY PUSH ENCODING AUDIT ===");
    let audit_sizes = [0, 1, 2, 75, 76, 127, 128, 144, 255, 256, 4608, 9216, 18432];
    for &sz in &audit_sizes {
        let prefix = push_data_len(sz);
        println!("payload_len={sz:<5} prefix_bytes={prefix:02x?} encoded_total_len={}", prefix.len() + sz);
    }

    // =========================================================================
    // SECTION 2: Tiny Diagnostic Sequence (0->1->2->3->4)
    // =========================================================================
    println!("\n=== 2. TINY DIAGNOSTIC SEQUENCE (N=4, 0->1, 1->2, 2->3, 3->4) ===");
    let n_tiny = 4;
    let body_len_tiny = body_len_fixed(n_tiny);
    let body_tiny = build_body(n_tiny, body_len_tiny).unwrap();
    let body_tiny_hash = blake2b_simd::Params::new().hash_length(32).hash(&body_tiny);

    for step in 1..=4 {
        let old_count = step - 1;
        let new_count = step;
        let old_rs: Vec<Record> = (0..old_count).map(|i| Record { end: ((i + 1) * 25_000) as u32, key: [((i * 13) & 0xff) as u8; 32] }).collect();
        let new_rs: Vec<Record> = (0..new_count).map(|i| Record { end: ((i + 1) * 25_000) as u32, key: [((i * 13) & 0xff) as u8; 32] }).collect();
        let sold_before = old_rs.last().map(|r| r.end).unwrap_or(0);
        let sold_after = new_rs.last().unwrap().end;
        let buy_count = (sold_after - sold_before) as u64;

        let old_redeem = build_redeem(&old_rs, sold_before, old_count as u32, n_tiny);
        let new_redeem = build_redeem(&new_rs, sold_after, new_count as u32, n_tiny);

        let tx = make_fixture(&old_redeem, &new_redeem, STATE_AMOUNT, buy_count * TICKET_PRICE, buy_count, new_rs.last().unwrap().key, COVENANT_ID);
        let vm_res = run_vm(&tx, &old_redeem, STATE_AMOUNT, None);
        println!(
            "tiny {}->{}: old_dir={}B new_dir={}B old_prefix={}B new_prefix={}B body_hash={:?} VM={:?}",
            old_count, new_count, old_rs.len() * 36, new_rs.len() * 36,
            old_redeem.len() - body_len_tiny, new_redeem.len() - body_len_tiny,
            body_tiny_hash, vm_res
        );
        assert_eq!(vm_res, Ok(()));
    }

    // =========================================================================
    // SECTION 3: Intermediate Legal BUY Append Benchmarks (N=128, 256, 512)
    // =========================================================================
    println!("\n=== 3. INTERMEDIATE LEGAL BUY BENCHMARKS (N=128, 256, 512) ===");
    for &n in &[128, 256, 512] {
        let old = records_with_denominator(n - 1, n);
        let new = records(n);
        let sold_before = old.last().map(|r| r.end).unwrap_or(0);
        let new_count = new.last().unwrap().end - sold_before;
        let old_redeem = build_redeem(&old, sold_before, (n - 1) as u32, n);
        let new_redeem = build_redeem(&new, MAX_TOTAL_TICKETS, n as u32, n);
        let tx = make_fixture(&old_redeem, &new_redeem, STATE_AMOUNT, (new_count as u64) * TICKET_PRICE, new_count as u64, new.last().unwrap().key, COVENANT_ID);
        assert_eq!(run_vm(&tx, &old_redeem, STATE_AMOUNT, None), Ok(()));
        println!("N={n} intermediate buy append: PASS");
    }

    // =========================================================================
    // PHASE A: Define Directory-Preserving SEALED State Layout
    // =========================================================================
    println!("\n=== PHASE A: DEFINITION OF DIRECTORY-PRESERVING SEALED STATE LAYOUT ===");
    let n_256 = 256;
    let full_records = records(n_256);
    let full_directory = directory_bytes(&full_records);
    let final_ticket_root = directory_root(&full_records, &ROUND_ID);
    let creator_refund_spk = p2pk_bytes(CREATOR_PUBKEY);

    let sealed_prefix = build_sealed_dir_prefix(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &full_directory);
    let sealed_body = build_sealed_dir_body(MAX_TOTAL_TICKETS as u64, creator_refund_spk.len());
    let sealed_redeem = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &full_directory);
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);

    println!("Candidate SEALED Layout:");
    println!("  round_id:           32 bytes (data push)");
    println!("  ticket_price:       8 bytes LE (data push)");
    println!("  total_tickets:      8 bytes LE (data push)");
    println!("  ticket_root:        32 bytes (data push)");
    println!("  purchase_count:     8 bytes LE = 256 (data push)");
    println!("  creator_refund_spk: {} bytes (data push)", creator_refund_spk.len());
    println!("  directory:          {} bytes (canonical OP_PUSHDATA2 push)", full_directory.len());
    println!("  sealed_prefix_len:  {} B", sealed_prefix.len());
    println!("  sealed_body_len:    {} B", sealed_body.len());
    println!("  sealed_redeem_len:  {} B", sealed_redeem.len());
    println!("  sealed_spk:         {:02x?}", sealed_spk.script());

    // =========================================================================
    // PHASE B: Final BUY: OPEN -> SEALED Directory (N=256)
    // =========================================================================
    println!("\n=== PHASE B: FINAL BUY: OPEN -> SEALED DIRECTORY (N=256) ===");
    let old_255_records = records_with_denominator(255, 256);
    let sold_before_final = old_255_records.last().unwrap().end;
    let final_buy_count = (MAX_TOTAL_TICKETS - sold_before_final) as u64;
    let buyer_final_key = full_records.last().unwrap().key;

    // Build OPEN covenant with final-buy body transitioning to SEALED:
    let open_final_buy_body = build_final_buy_open_body(&sealed_body, &creator_refund_spk);
    let mut open_final_buy_redeem = build_prefix(&old_255_records, sold_before_final, 255);
    open_final_buy_redeem.extend_from_slice(&open_final_buy_body);

    let final_payment = final_buy_count * TICKET_PRICE;
    let pool_amount_before = STATE_AMOUNT + (sold_before_final as u64) * TICKET_PRICE;
    let pool_amount_sealed = STATE_AMOUNT + (MAX_TOTAL_TICKETS as u64) * TICKET_PRICE;

    // Witness for final BUY: [count, buyer_key, final_ticket_root, old_redeem]
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let mut sig_fb = ScriptBuilder::with_flags(flags);
    sig_fb.add_data(&final_buy_count.to_le_bytes()).unwrap();
    sig_fb.add_data(&buyer_final_key).unwrap();
    sig_fb.add_data(&final_ticket_root.as_bytes()).unwrap();
    sig_fb.add_data(&open_final_buy_redeem).unwrap();
    let sig_script_fb = sig_fb.drain();

    let ordinary_sig = {
        let mut b = ScriptBuilder::new();
        b.add_data(&[0x20; 32]).unwrap();
        b.add_op(OpTrue).unwrap();
        b.drain()
    };
    let change_amount = 1_000_000_000u64 - final_payment - BUY_FEE;

    let tx_final_buy = Transaction::new(1,
        vec![
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(10), 0), sig_script_fb, 0, ComputeCommit::ComputeBudget(ComputeBudget(25))),
            TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(11), 0), ordinary_sig.clone(), 0, ComputeCommit::ComputeBudget(ComputeBudget(0))),
        ],
        vec![
            TransactionOutput { value: pool_amount_sealed, script_public_key: sealed_spk.clone(), covenant: Some(CovenantBinding { covenant_id: COVENANT_ID, authorizing_input: 0 }) },
            TransactionOutput { value: change_amount, script_public_key: ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), covenant: None },
        ], 0, SubnetworkId::default(), 0, vec![]
    );

    // Measure resources for positive final BUY
    let t_start_fb = Instant::now();
    let pop_fb = PopulatedTransaction::new(&tx_final_buy, vec![
        UtxoEntry::new(pool_amount_before, pay_to_script_hash_script(&open_final_buy_redeem), 1_000_000, false, Some(COVENANT_ID)),
        UtxoEntry::new(1_000_000_000, ScriptPublicKey::from_vec(0, p2pk_bytes([0x44; 32])), 1_000_000, false, None),
    ]);
    let non_fb = mass.calc_non_contextual_masses(&tx_final_buy);
    let ctx_fb = mass.calc_contextual_masses(&pop_fb).unwrap();
    let norm_fb = non_fb.normalized_transient(&cof);
    let fee_mass_fb = non_fb.compute_mass.max(norm_fb);
    let relay_fb = (fee_mass_fb * 100_000 / 1000).max(100_000);

    let cov_fb = CovenantsContext::from_tx(&pop_fb).unwrap();
    let cache_fb = Cache::new(1000);
    let reused_fb = SigHashReusedValuesUnsync::new();
    let ectx_fb = EngineCtx::new(&cache_fb).with_reused(&reused_fb).with_covenants_ctx(&cov_fb);
    let mut opcode_log_fb = Vec::new();
    let mut vm_fb = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop_fb, &pop_fb.tx.inputs[0], 0, &pop_fb.entries[0], ectx_fb,
        EngineFlags { covenants_enabled: true, ..Default::default() },
        tx_final_buy.inputs[0].compute_commit.allowed_script_units(),
    ).with_opcode_execution_log_buffer(&mut opcode_log_fb);
    let res_fb = vm_fb.execute();
    let dt_fb = t_start_fb.elapsed();
    let su_fb = vm_fb.used_script_units();
    drop(vm_fb);
    if res_fb.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log_fb);
        let lines: Vec<&str> = trace.lines().collect();
        println!("Final BUY opcode log lines={} tail:", lines.len());
        for line in lines.iter().rev().take(30).rev() { println!("  {line}"); }
    }
    assert_eq!(res_fb, Ok(()), "Final BUY VM execution failed");
    let bmin_fb = ComputeBudget::checked_covering_script_units(su_fb).unwrap();

    // B_min verification for final BUY
    let mut tx_bmin_fb = tx_final_buy.clone();
    tx_bmin_fb.inputs[0].compute_commit = ComputeCommit::ComputeBudget(bmin_fb);
    let bmin_res = run_vm(&tx_bmin_fb, &open_final_buy_redeem, pool_amount_before, Some(bmin_fb));
    if bmin_res.is_err() {
        println!("Final BUY B_min error: {:?}", bmin_res);
    }
    assert_eq!(bmin_res, Ok(()));
    let bmin_minus_1_fb_res = if bmin_fb.0 > 0 {
        let res_under = run_vm(&tx_bmin_fb, &open_final_buy_redeem, pool_amount_before, Some(ComputeBudget(bmin_fb.0 - 1)));
        assert!(matches!(res_under, Err(kaspa_txscript_errors::TxScriptError::ExceededCommittedScriptUnits { .. })));
        "PASS (exhaustion confirmed)"
    } else {
        "N/A"
    };

    println!("FINAL BUY (OPEN -> SEALED) RESOURCE RESULTS:");
    println!("  open_redeem_len:     {} B", open_final_buy_redeem.len());
    println!("  sealed_redeem_len:   {} B", sealed_redeem.len());
    println!("  sig_script_len:      {} B", tx_final_buy.inputs[0].signature_script.len());
    println!("  tx_estimated_size:   {} B", transaction_estimated_serialized_size(&tx_final_buy));
    println!("  successful_SU:       {}", su_fb.0);
    println!("  B_min:               ComputeBudget({}) ({})", bmin_fb.0, bmin_minus_1_fb_res);
    println!("  compute_mass:        {}", non_fb.compute_mass);
    println!("  transient_mass:      {}", non_fb.transient_mass);
    println!("  norm_transient:      {}", norm_fb);
    println!("  storage_mass:        {}", ctx_fb.storage_mass);
    println!("  relay_floor:         {} sompi (~{:.4} KAS)", relay_fb, relay_fb as f64 / 100_000_000.0);
    println!("  VM_execution_time:   {:?}", dt_fb);

    // Negative tests for Phase B:
    println!("\nPhase B Negative Tests:");
    let assert_fb_fail = |case_num: usize, name: &str, tx: &Transaction, redeem: &[u8]| {
        let res = run_vm(tx, redeem, pool_amount_before, None);
        assert!(res.is_err(), "Phase B Negative #{case_num} ({name}) unexpectedly PASSED!");
        println!("  #{case_num:02}: {name:<50} -> FAIL (OK)");
    };

    // 1. correct ticket_root but mutated SEALED directory
    {
        let mut tampered_dir = full_directory.clone();
        tampered_dir[100] ^= 0x01;
        let tampered_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &tampered_dir);
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&tampered_sealed);
        assert_fb_fail(1, "correct ticket_root but mutated directory", &tx, &open_final_buy_redeem);
    }
    // 2. correct directory but wrong ticket_root
    {
        let wrong_root = Hash::from_bytes([0x99; 32]);
        let wrong_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &wrong_root, 256, &creator_refund_spk, &full_directory);
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&wrong_sealed);
        assert_fb_fail(2, "correct directory but wrong ticket_root", &tx, &open_final_buy_redeem);
    }
    // 3. directory omitted in successor
    {
        let empty_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &[]);
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&empty_sealed);
        assert_fb_fail(3, "directory omitted in successor", &tx, &open_final_buy_redeem);
    }
    // 4. directory truncated (255 records instead of 256)
    {
        let trunc_dir = &full_directory[..255 * 36];
        let trunc_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, trunc_dir);
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&trunc_sealed);
        assert_fb_fail(4, "directory truncated", &tx, &open_final_buy_redeem);
    }
    // 5. directory extended (257 records)
    {
        let mut ext_dir = full_directory.clone();
        ext_dir.extend_from_slice(&[0xaa; 36]);
        let ext_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &ext_dir);
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&ext_sealed);
        assert_fb_fail(5, "directory extended", &tx, &open_final_buy_redeem);
    }
    // 6. records reordered
    {
        let mut reorder_records = full_records.clone();
        reorder_records.swap(10, 11);
        let reorder_dir = directory_bytes(&reorder_records);
        let reorder_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &reorder_dir);
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&reorder_sealed);
        assert_fb_fail(6, "records reordered", &tx, &open_final_buy_redeem);
    }
    // 7. final record payout key changed
    {
        let mut tampered_key = buyer_final_key;
        tampered_key[0] ^= 0x77;
        let mut tampered_records = full_records.clone();
        tampered_records.last_mut().unwrap().key = tampered_key;
        let tampered_dir = directory_bytes(&tampered_records);
        let tampered_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &tampered_dir);
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&tampered_sealed);
        assert_fb_fail(7, "final record payout key changed", &tx, &open_final_buy_redeem);
    }
    // 8. OPEN successor despite sold_after == total_tickets
    {
        let open_successor = build_redeem(&full_records, MAX_TOTAL_TICKETS, 256, 256);
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].script_public_key = pay_to_script_hash_script(&open_successor);
        assert_fb_fail(8, "OPEN successor despite sold_after == total_tickets", &tx, &open_final_buy_redeem);
    }
    // 9. wrong SEALED covenant binding
    {
        let mut tx = tx_final_buy.clone();
        tx.outputs[0].covenant = Some(CovenantBinding { covenant_id: Hash::from_bytes([0x99; 32]), authorizing_input: 0 });
        assert_fb_fail(9, "wrong SEALED covenant binding", &tx, &open_final_buy_redeem);
    }

    // =========================================================================
    // PHASE C: Fresh-Browser Recovery Property Verification
    // =========================================================================
    println!("\n=== PHASE C: FRESH-BROWSER RECOVERY PROPERTY ===");
    // Fresh browser sees ONLY sealed_redeem:
    // 1. Extract sealed ticket_root from prefix (bytes 55..87):
    let extracted_root_bytes: [u8; 32] = sealed_prefix[55..87].try_into().unwrap();
    let extracted_sealed_root = Hash::from_bytes(extracted_root_bytes);

    // 2. Extract directory bytes (bytes 134..134+9216):
    let extracted_directory_bytes = &sealed_prefix[134..134 + 9216];
    assert_eq!(extracted_directory_bytes.len(), 256 * 36);

    // 3. Deserialize all 256 records:
    let recovered_records = deserialize_directory(extracted_directory_bytes);
    assert_eq!(recovered_records.len(), 256);

    // 4. Verify each purchase start, count, payout SPK:
    let mut rec_start = 0u64;
    for (idx, rec) in recovered_records.iter().enumerate() {
        let rec_end = rec.end as u64;
        assert!(rec_end > rec_start);
        let _rec_count = rec_end - rec_start;
        let rec_payout_spk = p2pk_bytes(rec.key);
        assert_eq!(rec_payout_spk.len(), 34);
        assert_eq!(rec_payout_spk[0], 0x20);
        assert_eq!(rec_payout_spk[33], 0xac);
        if idx == 0 { assert_eq!(rec_start, 0); }
        if idx == 255 { assert_eq!(rec_end, MAX_TOTAL_TICKETS as u64); }
        rec_start = rec_end;
    }

    // 5. Recompute 27-level SMT ticket_root from recovered records alone:
    let recomputed_ticket_root = directory_root(&recovered_records, &ROUND_ID);

    // 6. Assert exact equality:
    assert_eq!(recomputed_ticket_root, extracted_sealed_root, "Fresh browser recovery root mismatch!");
    assert_eq!(recomputed_ticket_root, final_ticket_root);
    println!("  Recovered 256 purchase records from SEALED state alone: PASS");
    println!("  Recomputed 27-level SMT root: {:?}", recomputed_ticket_root);
    println!("  SEALED committed ticket_root: {:?}", extracted_sealed_root);
    println!("  Exact match assertion: PASS (Zero indexer / Zero old history required)");

    // =========================================================================
    // PHASE D: Winner Owner Lookup without O(P) Script Scan
    // =========================================================================
    println!("\n=== PHASE D: WINNER OWNER LOOKUP WITHOUT O(P) SCRIPT SCAN ===");

    let make_winner_lookup_tx = |winner_index: u64, purchase_idx: u64, payout_key: [u8; 32]| -> Transaction {
        let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_i64(winner_index as i64).unwrap();
        sig_sb.add_i64(purchase_idx as i64).unwrap();
        sig_sb.add_data(&sealed_redeem).unwrap();
        let sig_script = sig_sb.drain();

        let winner_spk = ScriptPublicKey::from_vec(0, p2pk_bytes(payout_key));
        let creator_spk = ScriptPublicKey::from_vec(0, creator_refund_spk.clone());

        let prize_amount = (MAX_TOTAL_TICKETS as u64) * TICKET_PRICE; // 100,000,000 sompi (1 KAS)
        let creator_state_deposit = STATE_AMOUNT; // 10,000,000,000 sompi (100 KAS)

        Transaction::new(1,
            vec![
                TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::from_u64_word(20), 0), sig_script, 0, ComputeCommit::ComputeBudget(ComputeBudget(10))),
            ],
            vec![
                TransactionOutput { value: prize_amount, script_public_key: winner_spk, covenant: None },
                TransactionOutput { value: creator_state_deposit, script_public_key: creator_spk, covenant: None },
            ], 0, SubnetworkId::default(), 0, vec![]
        )
    };

    let run_winner_vm = |tx: &Transaction, budget: Option<ComputeBudget>| -> Result<ScriptUnits, kaspa_txscript_errors::TxScriptError> {
        let mut tx_exec = tx.clone();
        if let Some(b) = budget {
            tx_exec.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b);
        }
        let pop = PopulatedTransaction::new(&tx_exec, vec![
            UtxoEntry::new(pool_amount_sealed, pay_to_script_hash_script(&sealed_redeem), 1_000_000, false, Some(COVENANT_ID)),
        ]);
        let cov = CovenantsContext::from_tx(&pop).map_err(|e| kaspa_txscript_errors::TxScriptError::CovenantsError(e))?;
        let cache = Cache::new(1000);
        let reused = SigHashReusedValuesUnsync::new();
        let ectx = EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);
        let allowed_units = tx_exec.inputs[0].compute_commit.allowed_script_units();
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop, &pop.tx.inputs[0], 0, &pop.entries[0], ectx,
            EngineFlags { covenants_enabled: true, ..Default::default() },
            allowed_units,
        );
        vm.execute().map(|_| vm.used_script_units())
    };

    // Case A: Winner in first purchase (i = 0)
    let winner_a = 100u64;
    let tx_a = make_winner_lookup_tx(winner_a, 0, full_records[0].key);
    let su_a = run_winner_vm(&tx_a, None).expect("Winner Case A failed");
    let _bmin_a = ComputeBudget::checked_covering_script_units(su_a).unwrap();
    println!("  Case A (first purchase, i=0, winner={winner_a}): PASS (SU={})", su_a.0);

    // Case B: Winner in middle purchase (i = 128)
    let start_128 = full_records[127].end as u64;
    let winner_b = start_128 + 10;
    let tx_b = make_winner_lookup_tx(winner_b, 128, full_records[128].key);
    let t_start_b = Instant::now();
    let su_b = run_winner_vm(&tx_b, None).expect("Winner Case B failed");
    let dt_b = t_start_b.elapsed();
    let bmin_b = ComputeBudget::checked_covering_script_units(su_b).unwrap();
    println!("  Case B (middle purchase, i=128, winner={winner_b}): PASS (SU={})", su_b.0);

    // Case C: Winner in last purchase (i = 255)
    let winner_c = 99_999u64;
    let tx_c = make_winner_lookup_tx(winner_c, 255, full_records[255].key);
    let su_c = run_winner_vm(&tx_c, None).expect("Winner Case C failed");
    let _bmin_c = ComputeBudget::checked_covering_script_units(su_c).unwrap();
    println!("  Case C (last purchase, i=255, winner={winner_c}): PASS (SU={})", su_c.0);

    // Resources for Case B:
    let pop_b = PopulatedTransaction::new(&tx_b, vec![
        UtxoEntry::new(pool_amount_sealed, pay_to_script_hash_script(&sealed_redeem), 1_000_000, false, Some(COVENANT_ID)),
    ]);
    let non_b = mass.calc_non_contextual_masses(&tx_b);
    let ctx_b = mass.calc_contextual_masses(&pop_b).unwrap();
    let norm_b = non_b.normalized_transient(&cof);
    let fee_mass_b = non_b.compute_mass.max(norm_b);
    let relay_b = (fee_mass_b * 100_000 / 1000).max(100_000);

    // B_min verification for Case B:
    assert_eq!(run_winner_vm(&tx_b, Some(bmin_b)).map(|_| ()), Ok(()));
    let bmin_minus_1_b_res = if bmin_b.0 > 0 {
        let res_under = run_winner_vm(&tx_b, Some(ComputeBudget(bmin_b.0 - 1)));
        assert!(matches!(res_under, Err(kaspa_txscript_errors::TxScriptError::ExceededCommittedScriptUnits { .. })));
        "PASS (exhaustion confirmed)"
    } else {
        "N/A"
    };

    println!("\nWINNER OWNER LOOKUP RESOURCE RESULTS (Case B, i=128):");
    println!("  sealed_redeem_len:   {} B", sealed_redeem.len());
    println!("  sig_script_len:      {} B", tx_b.inputs[0].signature_script.len());
    println!("  tx_estimated_size:   {} B", transaction_estimated_serialized_size(&tx_b));
    println!("  successful_SU:       {}", su_b.0);
    println!("  B_min:               ComputeBudget({}) ({})", bmin_b.0, bmin_minus_1_b_res);
    println!("  compute_mass:        {}", non_b.compute_mass);
    println!("  transient_mass:      {}", non_b.transient_mass);
    println!("  norm_transient:      {}", norm_b);
    println!("  storage_mass:        {}", ctx_b.storage_mass);
    println!("  relay_floor:         {} sompi (~{:.4} KAS)", relay_b, relay_b as f64 / 100_000_000.0);
    println!("  VM_execution_time:   {:?}", dt_b);

    // Phase D Negative Tests:
    println!("\nPhase D Negative Tests:");
    let assert_lookup_fail = |case_num: usize, name: &str, tx: &Transaction| {
        let res = run_winner_vm(tx, None);
        assert!(res.is_err(), "Phase D Negative #{case_num} ({name}) unexpectedly PASSED!");
        println!("  #{case_num:02}: {name:<40} -> FAIL (OK)");
    };

    // 1. i - 1 (offset too low, winner >= current_end)
    {
        let tx = make_winner_lookup_tx(winner_b, 127, full_records[127].key);
        assert_lookup_fail(1, "i - 1 (winner >= current_end)", &tx);
    }
    // 2. i + 1 (offset too high, winner < start)
    {
        let tx = make_winner_lookup_tx(winner_b, 129, full_records[129].key);
        assert_lookup_fail(2, "i + 1 (winner < start)", &tx);
    }
    // 3. wrong previous_end (tampered directory at previous position)
    {
        let mut tampered_records = full_records.clone();
        tampered_records[127].end = (winner_b + 1) as u32; // prev_end > winner
        let tampered_dir = directory_bytes(&tampered_records);
        let tampered_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &tampered_dir);
        let mut tx = tx_b.clone();
        let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_i64(winner_b as i64).unwrap();
        sig_sb.add_i64(128).unwrap();
        sig_sb.add_data(&tampered_sealed).unwrap();
        tx.inputs[0].signature_script = sig_sb.drain();
        assert_lookup_fail(3, "wrong previous_end (prev_end > winner)", &tx);
    }
    // 4. wrong current_end (tampered directory current_end <= winner)
    {
        let mut tampered_records = full_records.clone();
        tampered_records[128].end = winner_b as u32; // current_end <= winner
        let tampered_dir = directory_bytes(&tampered_records);
        let tampered_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &tampered_dir);
        let mut tx = tx_b.clone();
        let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_i64(winner_b as i64).unwrap();
        sig_sb.add_i64(128).unwrap();
        sig_sb.add_data(&tampered_sealed).unwrap();
        tx.inputs[0].signature_script = sig_sb.drain();
        assert_lookup_fail(4, "wrong current_end (current_end <= winner)", &tx);
    }
    // 5. wrong payout pubkey (tampered key in directory)
    {
        let mut tampered_records = full_records.clone();
        tampered_records[128].key[0] ^= 0x33;
        let tampered_dir = directory_bytes(&tampered_records);
        let tampered_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &tampered_dir);
        let mut tx = tx_b.clone();
        let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_i64(winner_b as i64).unwrap();
        sig_sb.add_i64(128).unwrap();
        sig_sb.add_data(&tampered_sealed).unwrap();
        tx.inputs[0].signature_script = sig_sb.drain();
        assert_lookup_fail(5, "wrong payout pubkey (SPK mismatch)", &tx);
    }
    // 6. winner == start - 1
    {
        let tx = make_winner_lookup_tx(start_128 - 1, 128, full_records[128].key);
        assert_lookup_fail(6, "winner == start - 1", &tx);
    }
    // 7. winner == current_end
    {
        let tx = make_winner_lookup_tx(full_records[128].end as u64, 128, full_records[128].key);
        assert_lookup_fail(7, "winner == current_end", &tx);
    }
    // 8. malformed index (negative)
    {
        let tx = make_winner_lookup_tx(winner_b, -1i64 as u64, full_records[128].key);
        assert_lookup_fail(8, "malformed index (negative)", &tx);
    }
    // 9. index >= purchase_count (256)
    {
        let tx = make_winner_lookup_tx(winner_b, 256, full_records[0].key);
        assert_lookup_fail(9, "index >= purchase_count (256)", &tx);
    }
    // 10. mutated directory on input
    {
        let mut tampered_dir = full_directory.clone();
        tampered_dir[50] ^= 0xff;
        let tampered_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &tampered_dir);
        let mut tx = tx_b.clone();
        let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_i64(winner_b as i64).unwrap();
        sig_sb.add_i64(128).unwrap();
        sig_sb.add_data(&tampered_sealed).unwrap();
        tx.inputs[0].signature_script = sig_sb.drain();
        assert_lookup_fail(10, "mutated directory (UTXO SPK mismatch)", &tx);
    }
    // 11. directory from another round
    {
        let foreign_records = records_with_denominator(256, 500);
        let foreign_dir = directory_bytes(&foreign_records);
        let foreign_sealed = build_sealed_dir_redeem(&ROUND_ID, TICKET_PRICE, MAX_TOTAL_TICKETS as u64, &final_ticket_root, 256, &creator_refund_spk, &foreign_dir);
        let mut tx = tx_b.clone();
        let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_i64(winner_b as i64).unwrap();
        sig_sb.add_i64(128).unwrap();
        sig_sb.add_data(&foreign_sealed).unwrap();
        tx.inputs[0].signature_script = sig_sb.drain();
        assert_lookup_fail(11, "directory from another round", &tx);
    }

    // =========================================================================
    // FINAL VERDICT
    // =========================================================================
    println!("\nDIRECTORY SEALED + WINNER OWNER PASS");
    println!("recommended V1 candidate: MAX_TOTAL_TICKETS = 100,000, MAX_PURCHASE_COUNT = 256");
    println!("NEXT: integrate frozen PASS-A randomness with directory-preserving SEALED/DRAW state");
}
