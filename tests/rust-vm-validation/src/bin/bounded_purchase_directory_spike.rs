//! Isolated bounded purchase-directory feasibility/resource spike.
//! NOT a production covenant, NOT a canonical encoding, and NOT a security proof.
//! This measures candidate state/data sizes and host reconstruction costs only.

use std::collections::HashMap;
use std::time::Instant;

use blake2b_simd::Params;
use kaspa_consensus_core::config::params::TESTNET_PARAMS;
use kaspa_consensus_core::mass::{
    transaction_estimated_serialized_size, ComputeBudget, MassCalculator,
};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    ComputeCommit, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionInput,
    TransactionOutpoint, TransactionOutput, UtxoEntry,
};
use kaspa_hashes::Hash;
use kaspa_txscript::{
    caches::Cache, opcodes::codes::*,
    script_builder::ScriptBuilder, standard::pay_to_script_hash_script, EngineCtx, EngineFlags,
    TxScriptEngine,
};

#[path = "../../../../contracts/ticket_commitment.rs"]
mod ticket_commitment;
use ticket_commitment::{compute_payout_commitment, compute_purchase_leaf, hash_internal_node};

const MAX_TOTAL_TICKETS_CANDIDATE: u32 = 1_000_000;
const PURCHASE_COUNTS: [usize; 6] = [64, 128, 256, 512, 1024, 2048];
const ROUND_ID: Hash = Hash::from_bytes([0x42; 32]);
const TICKET_PRICE: u64 = 100_000;
const STATE_DEPOSIT: u64 = 100_000_000;
const RELAY_FEE_PER_KG: u64 = 100_000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Record {
    cumulative_end_ticket: u32,
    payout_xonly: [u8; 32],
}

fn p2pk_spk(xonly: &[u8; 32]) -> Vec<u8> {
    let mut spk = Vec::with_capacity(36);
    spk.extend_from_slice(&[0x00, 0x00, 0x20]);
    spk.extend_from_slice(xonly);
    spk.push(0xac);
    spk
}

fn records_for(count: usize) -> Vec<Record> {
    (0..count)
        .map(|i| {
            let end = (((i as u64 + 1) * MAX_TOTAL_TICKETS_CANDIDATE as u64) / count as u64) as u32;
            Record { cumulative_end_ticket: end, payout_xonly: [i as u8; 32] }
        })
        .collect()
}

fn serialize_directory(records: &[Record], u64_end: bool) -> Vec<u8> {
    let width = if u64_end { 40 } else { 36 };
    let mut bytes = Vec::with_capacity(records.len() * width);
    for record in records {
        if u64_end {
            bytes.extend_from_slice(&(record.cumulative_end_ticket as u64).to_le_bytes());
        } else {
            bytes.extend_from_slice(&record.cumulative_end_ticket.to_le_bytes());
        }
        bytes.extend_from_slice(&record.payout_xonly);
    }
    bytes
}

fn deserialize_directory(bytes: &[u8], u64_end: bool) -> Vec<Record> {
    let width = if u64_end { 40 } else { 36 };
    assert_eq!(bytes.len() % width, 0);
    bytes
        .chunks_exact(width)
        .map(|chunk| {
            let end = if u64_end {
                u64::from_le_bytes(chunk[..8].try_into().unwrap()) as u32
            } else {
                u32::from_le_bytes(chunk[..4].try_into().unwrap())
            };
            let key: [u8; 32] = chunk[width - 32..].try_into().unwrap();
            Record { cumulative_end_ticket: end, payout_xonly: key }
        })
        .collect()
}

fn validate_directory(records: &[Record]) {
    let mut previous = 0u32;
    for record in records {
        assert!(record.cumulative_end_ticket > previous);
        assert!(record.cumulative_end_ticket <= MAX_TOTAL_TICKETS_CANDIDATE);
        let spk = p2pk_spk(&record.payout_xonly);
        assert_eq!(spk.len(), 36);
        previous = record.cumulative_end_ticket;
    }
    assert_eq!(previous, MAX_TOTAL_TICKETS_CANDIDATE);
}

fn directory_root(records: &[Record]) -> Hash {
    // Sparse tree construction over the existing frozen 27-level range-leaf tree.
    let mut levels: HashMap<(usize, u64), Hash> = HashMap::new();
    let mut empty = vec![Hash::default(); 28];
    let mut state = Params::new().hash_length(32).to_state();
    state.update(b"KaswinTicketEmptyV1");
    let digest = state.finalize();
    let mut empty_leaf = [0u8; 32];
    empty_leaf.copy_from_slice(digest.as_bytes());
    empty[0] = Hash::from_bytes(empty_leaf);
    for level in 0..27 {
        empty[level + 1] = hash_internal_node(&empty[level], &empty[level]);
    }

    let mut start = 0u64;
    for (index, record) in records.iter().enumerate() {
        let end = record.cumulative_end_ticket as u64;
        let count = end - start;
        let payout = p2pk_spk(&record.payout_xonly);
        let payout_commitment = compute_payout_commitment(&payout);
        let leaf = compute_purchase_leaf(&ROUND_ID, index as u64, start, count, &payout_commitment);
        levels.insert((0, index as u64), leaf);
        start = end;
    }

    for level in 0..27 {
        let keys: Vec<u64> = levels
            .keys()
            .filter_map(|(l, index)| (*l == level).then_some(*index / 2))
            .collect();
        for parent in keys {
            let left = levels.get(&(level, parent * 2)).copied().unwrap_or(empty[level]);
            let right = levels.get(&(level, parent * 2 + 1)).copied().unwrap_or(empty[level]);
            levels.insert((level + 1, parent), hash_internal_node(&left, &right));
        }
    }
    levels.get(&(27, 0)).copied().unwrap_or(empty[27])
}

fn state_payload_bytes(records: &[Record], directory: &[u8], u64_end: bool) -> usize {
    // Candidate only: fixed state fields plus an explicit directory byte vector.
    // The u32/u64 choice is the only directory format variable in this spike.
    let end_width = if u64_end { 8 } else { 4 };
    let fixed = 32 + 8 + 4 + 4 + 4 + 32 + 4 + 4 + 4;
    assert_eq!(directory.len(), records.len() * (end_width + 32));
    fixed + directory.len()
}

fn build_candidate_redeem(records: &[Record], u64_end: bool, sold: u32, purchase_count: u32, root: &Hash) -> Vec<u8> {
    let directory = serialize_directory(records, u64_end);
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let mut sb = ScriptBuilder::with_flags(flags);
    sb.add_data(&ROUND_ID.as_bytes()).unwrap();
    sb.add_data(&TICKET_PRICE.to_le_bytes()).unwrap();
    sb.add_data(&MAX_TOTAL_TICKETS_CANDIDATE.to_le_bytes()).unwrap();
    sb.add_data(&sold.to_le_bytes()).unwrap();
    sb.add_data(&purchase_count.to_le_bytes()).unwrap();
    sb.add_data(&root.as_bytes()).unwrap();
    sb.add_data(&directory).unwrap();
    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

fn p2pk_unlock() -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    sb.add_data(&[0x20; 32]).unwrap();
    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

fn candidate_transaction(old_redeem: &[u8], new_redeem: &[u8], fee: u64) -> Transaction {
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let mut state_sig = ScriptBuilder::with_flags(flags);
    state_sig.add_data(new_redeem).unwrap();
    let state_sig = state_sig.drain();
    let ordinary_sig = p2pk_unlock();
    let old_spk = pay_to_script_hash_script(old_redeem);
    let new_spk = pay_to_script_hash_script(new_redeem);
    let ordinary_spk = ScriptPublicKey::from_vec(0, vec![0x20, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0xac]);
    let state_input = TransactionInput::new_with_mass(
        TransactionOutpoint::new(Hash::from_u64_word(1), 0),
        state_sig,
        0,
        ComputeCommit::ComputeBudget(ComputeBudget(1)),
    );
    let fee_input = TransactionInput::new_with_mass(
        TransactionOutpoint::new(Hash::from_u64_word(2), 0),
        ordinary_sig,
        0,
        ComputeCommit::ComputeBudget(ComputeBudget(0)),
    );
    let tx = Transaction::new(
        1,
        vec![state_input, fee_input],
        vec![
            TransactionOutput { value: STATE_DEPOSIT, script_public_key: new_spk, covenant: None },
            TransactionOutput { value: fee, script_public_key: ordinary_spk, covenant: None },
        ],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let _ = (old_spk, fee);
    tx
}

fn synthetic_vm_metric(directory: &[u8]) -> (u64, u64, u128) {
    // This is a deliberately synthetic boundary check, not a production directory covenant.
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let mut redeem_builder = ScriptBuilder::with_flags(flags);
    redeem_builder.add_op(OpDrop).unwrap();
    redeem_builder.add_op(OpTrue).unwrap();
    let redeem = redeem_builder.drain();
    let spk = pay_to_script_hash_script(&redeem);
    let mut sig_builder = ScriptBuilder::with_flags(flags);
    sig_builder.add_data(directory).unwrap();
    sig_builder.add_data(&redeem).unwrap();
    let signature_script = sig_builder.drain();
    let tx = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(3), 0),
            signature_script,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(1)),
        )],
        vec![TransactionOutput { value: 1, script_public_key: ScriptPublicKey::from_vec(0, vec![OpTrue]), covenant: None }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop = PopulatedTransaction::new(&tx, vec![UtxoEntry::new(1, spk, 1_000_000, false, None)]);
    let cache = Cache::new(1000);
    let reused = kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync::new();
    let ctx = EngineCtx::new(&cache).with_reused(&reused);
    let start = Instant::now();
    let mut vm = TxScriptEngine::from_transaction_input(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx, flags);
    assert_eq!(vm.execute(), Ok(()));
    let elapsed = start.elapsed().as_nanos();
    let units = vm.used_script_units().0;
    let b_min = ComputeBudget::checked_covering_script_units(vm.used_script_units()).unwrap().0;
    (units, b_min as u64, elapsed)
}

fn main() {
    println!("BOUNDED PURCHASE DIRECTORY SPIKE (HOST + SYNTHETIC VM; NOT PRODUCTION)");
    println!("MAX_TOTAL_TICKETS candidate = {}", MAX_TOTAL_TICKETS_CANDIDATE);
    let mass_calc = MassCalculator::new_with_consensus_params(&TESTNET_PARAMS);
    let cofactors = TESTNET_PARAMS.block_mass_cofactors().after();

    for &max_count in &PURCHASE_COUNTS {
        for &u64_end in &[false, true] {
            let records_before = records_for(max_count - 1);
            let records_after = records_for(max_count);
            validate_directory(&records_after);
            let dir_before = serialize_directory(&records_before, u64_end);
            let dir_after = serialize_directory(&records_after, u64_end);
            assert_eq!(deserialize_directory(&dir_after, u64_end), records_after);
            let root_before = directory_root(&records_before);
            let root_after = directory_root(&records_after);
            let old_redeem = build_candidate_redeem(&records_before, u64_end, records_before.last().map(|x| x.cumulative_end_ticket).unwrap_or(0), (max_count - 1) as u32, &root_before);
            let new_redeem = build_candidate_redeem(&records_after, u64_end, MAX_TOTAL_TICKETS_CANDIDATE, max_count as u32, &root_after);
            let tx = candidate_transaction(&old_redeem, &new_redeem, 1_000_000);
            let pop = PopulatedTransaction::new(
                &tx,
                vec![
                    UtxoEntry::new(STATE_DEPOSIT, pay_to_script_hash_script(&old_redeem), 1_000_000, false, None),
                    UtxoEntry::new(STATE_DEPOSIT + 1_000_000, ScriptPublicKey::from_vec(0, vec![OpTrue]), 1_000_000, false, None),
                ],
            );
            let non_ctx = mass_calc.calc_non_contextual_masses(&tx);
            let ctx_mass = mass_calc.calc_contextual_masses(&pop).unwrap();
            let norm_transient = non_ctx.normalized_transient(&cofactors);
            let fee_mass = non_ctx.compute_mass.max(norm_transient);
            let relay_floor = (fee_mass * RELAY_FEE_PER_KG / 1000).max(RELAY_FEE_PER_KG);
            let (su, b_min, vm_ns) = synthetic_vm_metric(&dir_after);
            let scan_start = Instant::now();
            let mut lookup = Vec::new();
            for target in [1u32, MAX_TOTAL_TICKETS_CANDIDATE / 2, MAX_TOTAL_TICKETS_CANDIDATE - 1] {
                let idx = records_after.partition_point(|record| record.cumulative_end_ticket <= target);
                lookup.push(idx);
            }
            let lookup_ns = scan_start.elapsed().as_nanos();
            let construct_ns = {
                let start = Instant::now();
                let _ = build_candidate_redeem(&records_after, u64_end, MAX_TOTAL_TICKETS_CANDIDATE, max_count as u32, &root_after);
                start.elapsed().as_nanos()
            };
            println!(
                "K={max_count:4} end={} dir={}B payload={}B redeem={}B spk={}B sig={}B tx_est={}B SU={su} Bmin={b_min} compute={} transient={} norm_transient={} storage={} relay={} root={:?} lookup={:?} lookup_ns={} construct_ns={} vm_ns={}",
                if u64_end { "u64" } else { "u32" },
                dir_after.len(),
                state_payload_bytes(&records_after, &dir_after, u64_end),
                new_redeem.len(),
                pay_to_script_hash_script(&new_redeem).script().len(),
                tx.inputs.iter().map(|input| input.signature_script.len()).sum::<usize>(),
                transaction_estimated_serialized_size(&tx),
                non_ctx.compute_mass,
                non_ctx.transient_mass,
                norm_transient,
                ctx_mass.storage_mass,
                relay_floor,
                root_after,
                lookup,
                lookup_ns,
                construct_ns,
                vm_ns,
            );
            assert!(root_before != root_after);
        }
    }
}
