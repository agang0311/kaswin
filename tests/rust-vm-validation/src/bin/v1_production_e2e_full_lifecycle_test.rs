#![allow(unused_imports, unused_variables, dead_code)]
// Kaswin V1 Production Full Lifecycle E2E Test Suite
//
// Verifies all production consensus, monetary conservation, committed ScriptUnits,
// standard relay floors, and empty-round liveness gates:
//
// Part 1: Real Connected Production SUCCESS E2E:
//         CREATE -> OPEN -> BUY #1 (30) -> BUY #2 (10) -> BUY #3 (55)
//         -> CLOSE (sold=95 < cap=100 && sold=95 >= min=90)
//         -> SEALED (draw_ticket_count=95) -> DRAW_READY(0) -> ACCEPT -> WINNER_READY -> PAID
//         * Every step spends exact previous transaction outpoint.
//         * Every BUY includes external buyer funding UTXO (Input 1) and buyer change (Output 1).
//         * Zero SpendTooHigh: total_in = total_out + actual_fee.
//         * actual_fee >= measured relay_floor on every transition.
//         * Committed ScriptUnits: B_min PASS, B_min-1 FAILS (or B_min=0 labeled).
//         * 1-in-3-out WINNER_READY -> PAID terminates covenant lineage.
// Part 2: Real Connected Production REFUND E2E (P=17):
//         OPEN(17 records) -> CLOSE (sold=51 < min=60) -> REFUNDING(cur=0)
//         -> Step 0 (K=9) -> REFUNDING(cur=9) -> Step 1 (K=8 terminal) -> PAID/TERMINAL
//         * Exact connected chain: CLOSE Output 0 IS Step 0 Input 0; Step 0 Output 0 IS Step 1 Input 0!
//         * Fees deducted from buyer principal (<= 1.5M sompi), net refund >= 10k sompi.
//         * Step 1 returns 100% creator state deposit and terminates lineage.
// Part 3: Boundary Verifications (P=1 and P=256 Real Transactions):
//         * P=1: Real single-step terminal refund transaction, committed VM PASS, deposit returned.
//         * P=256: Real 16-step connected refund chain (K=16 each), all outpoints exact, lineage terminated.
// Part 4: P=0 Empty Round Direct Terminal Recovery:
//         * CREATE -> 0 BUY -> deadline CLOSE -> EMPTY TERMINAL.
//         * 2-in-2-out topology: 100% deposit returned to creator, sponsor pays fee.
//         * Minimal negative tests: P=0 entering refunding, amount theft, SPK mismatch, hidden continuation.
// Part 5: 10-Row Final Production Resource Table.

use kaspa_hashes::Hash;
use kaspa_consensus_core::tx::{
    ComputeCommit, Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ScriptPublicKey, CovenantBinding, VerifiableTransaction,
};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::mass::{ComputeBudget, MassCalculator, ScriptUnits, transaction_estimated_serialized_size};
use kaspa_consensus_core::config::params::MAINNET_PARAMS;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, EngineCtxUnsync, caches::Cache,
    script_builder::ScriptBuilder,
    standard::pay_to_script_hash_script,
    covenants::CovenantsContext,
    opcodes::codes::*,
    SeqCommitAccessor,
};
use kaspa_txscript_errors::TxScriptError;
use std::collections::HashMap;

// Compile the pinned validator directly, without copying or changing upstream
// rules or linking the full node/storage stack. Its crate::constants imports
// resolve to the same consensus-core constants as the upstream node.
pub mod constants { pub use kaspa_consensus_core::constants::*; }
#[path = "/root/kaspa/references/rusty-kaspa/consensus/src/processes/transaction_validator/mod.rs"]
mod transaction_validator;

#[path = "../../../../contracts/v1_constants.rs"]
pub mod v1_constants;
use v1_constants::*;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_leaf, compute_empty_levels, compute_empty_root_27,
    compute_payout_commitment, compute_purchase_leaf, compute_root_from_path,
    hash_internal_node,
};

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::*;

#[path = "../../../../contracts/sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::*;

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;
use winner_ready_settlement::build_production_winner_ready_3out_covenant;

#[path = "../../../../contracts/winner_selection.rs"]
pub mod winner_selection;
use winner_selection::{
    build_directory_draw_ready_covenant, compute_candidate_hash, extract_candidate_num,
    ACTION_ACCEPT, ACTION_REJECT,
};

#[path = "../../../../contracts/refunding_covenant.rs"]
pub mod refunding_covenant;
use refunding_covenant::*;

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::*;

struct MockSeqCommitAccessor {
    selected_chain: Vec<Hash>,
    seq_commits: HashMap<Hash, Hash>,
}

impl SeqCommitAccessor for MockSeqCommitAccessor {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        Some(self.selected_chain.contains(&block_hash))
    }
    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        self.seq_commits.get(&block_hash).copied()
    }
}

fn blake3_hash(key: [u8; 32], data: &[u8]) -> Hash {
    let h = blake3::keyed_hash(&key, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(h.as_bytes());
    Hash::from_bytes(out)
}

struct PassAOpeningFixture {
    target_hash: Hash,
    target_activity: Hash,
    target_payload: Hash,
    target_sp_ts: [u8; 8],
    target_daa: [u8; 8],
    target_blue: [u8; 8],
    p_parent_seq: Hash,
    p_activity: Hash,
    p_payload: Hash,
    p_sp_ts: [u8; 8],
    p_daa: [u8; 8],
    p_blue: [u8; 8],
    c_t: Hash,
}

fn generate_valid_pass_a_fixture(p_daa_num: u64, t_daa_num: u64) -> PassAOpeningFixture {
    let mut key_ctx = [0u8; 32];
    key_ctx[..b"SeqCommitMergesetContext".len()].copy_from_slice(b"SeqCommitMergesetContext");
    let mut key_branch = [0u8; 32];
    key_branch[..b"SeqCommitmentMerkleBranchHash".len()].copy_from_slice(b"SeqCommitmentMerkleBranchHash");

    let p_sp_ts = 1_000_000u64.to_le_bytes();
    let p_daa = p_daa_num.to_le_bytes();
    let p_blue = (p_daa_num - 100).to_le_bytes();
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

    let target_sp_ts = 1_000_001u64.to_le_bytes();
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

/// In-memory test-only Schnorr signing helper authorized for offline unit tests.
/// Produces genuine 66-byte signature scripts [0x41 || 64B sig || 0x01] for ordinary funding inputs.
fn sign_p2pk_input(
    tx: &mut Transaction,
    input_idx: usize,
    keypair: &secp256k1::Keypair,
    entries: &[UtxoEntry],
) {
    // Schnorr verification costs 100,000 script units under the pinned
    // 1,000-gram sigop charge; budget zero only grants 9,999 units.
    tx.inputs[input_idx].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(10));
    // Include the final signature wire length AND committed verification cost
    // before setting ordinary change. Never deduct this fee from Output 0.
    tx.inputs[input_idx].signature_script = vec![0; 66];
    let params = &MAINNET_PARAMS;
    let calculator = MassCalculator::new_with_consensus_params(params);
    let masses = calculator.calc_non_contextual_masses(tx);
    let cofactors = params.block_mass_cofactors().after();
    let floor = masses.compute_mass.max(masses.normalized_transient(&cofactors)) * 100;
    let total_in: u64 = entries.iter().map(|entry| entry.amount).sum();
    let total_out: u64 = tx.outputs.iter().map(|output| output.value).sum();
    let current_fee = total_in.checked_sub(total_out).expect("signing SpendTooHigh transaction");
    if current_fee < floor {
        let change = tx.outputs.last_mut().expect("missing sponsor change");
        assert!(change.covenant.is_none(), "cannot debit covenant state as change");
        change.value = change.value.checked_sub(floor - current_fee).expect("insufficient sponsor change");
    }
    let storage = calculator.calc_contextual_masses(&PopulatedTransaction::new(tx, entries.to_vec())).expect("mass incomputable").storage_mass;
    tx.set_storage_mass(storage);
    let pop = PopulatedTransaction::new(tx, entries.to_vec());
    let reused = SigHashReusedValuesUnsync::new();
    let sig_hash = kaspa_consensus_core::hashing::sighash::calc_schnorr_signature_hash(
        &pop,
        input_idx,
        SIG_HASH_ALL,
        &reused,
    );
    let msg = secp256k1::Message::from_digest_slice(sig_hash.as_bytes().as_slice()).unwrap();
    let sig: [u8; 64] = *keypair.sign_schnorr(msg).as_ref();
    let mut sig_script = Vec::with_capacity(66);
    sig_script.push(65u8);
    sig_script.extend_from_slice(&sig);
    sig_script.push(SIG_HASH_ALL.to_u8());
    tx.inputs[input_idx].signature_script = sig_script;
    tx.finalize();
}

#[derive(Clone, Debug)]
pub struct ResourceRecord {
    pub transition_name: &'static str,
    pub redeem_bytes: usize,
    pub sigscript_bytes: usize,
    pub tx_bytes: usize,
    pub script_units: u64,
    pub b_min: ComputeBudget,
    pub compute_mass: u64,
    pub transient_mass: u64,
    pub normalized_transient: u64,
    pub storage_mass: u64,
    pub fee_mass: u64,
    pub relay_floor: u64,
    pub actual_fee: u64,
}

fn measure_and_verify_transition(
    name: &'static str,
    redeem_len: usize,
    pop: &PopulatedTransaction,
    input_idx: usize,
    ctx: EngineCtxUnsync<'_>,
    flags: EngineFlags,
    mass_calc: &MassCalculator,
    cofactors: &kaspa_consensus_core::mass::MassCofactors,
) -> (ResourceRecord, ComputeBudget) {
    // 1. Measure ScriptUnits with a generous covering limit:
    let cov_limit = ScriptUnits(450_000);
    let mut opcode_log = Vec::new();
    let mut vm_measure = TxScriptEngine::from_transaction_input_with_script_units_limit(
        pop, &pop.tx.inputs[input_idx], input_idx, &pop.entries[input_idx], ctx, flags, cov_limit,
    ).with_opcode_execution_log_buffer(&mut opcode_log);
    let res_m = vm_measure.execute();
    if res_m.is_err() {
        drop(vm_measure);
        let trace = String::from_utf8_lossy(&opcode_log);
        for line in trace.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev() {
            println!("  {line}");
        }
        panic!("Measurement run failed for {}", name);
    }
    let su = vm_measure.used_script_units();
    let b_min = ComputeBudget::checked_covering_script_units(su).unwrap();

    // 2. Run at exact B_min: must PASS
    let limit_bmin = ComputeCommit::ComputeBudget(b_min).allowed_script_units();
    let mut vm_bmin = TxScriptEngine::from_transaction_input_with_script_units_limit(
        pop, &pop.tx.inputs[input_idx], input_idx, &pop.entries[input_idx], ctx, flags, limit_bmin,
    );
    assert_eq!(vm_bmin.execute(), Ok(()), "B_min execution failed for {}", name);

    // 3. Exhaustion verification:
    if b_min.0 > 0 {
        let b_under = ComputeBudget(b_min.0 - 1);
        let limit_under = ComputeCommit::ComputeBudget(b_under).allowed_script_units();
        let mut vm_under = TxScriptEngine::from_transaction_input_with_script_units_limit(
            pop, &pop.tx.inputs[input_idx], input_idx, &pop.entries[input_idx], ctx, flags, limit_under,
        );
        let res_under = vm_under.execute();
        assert!(
            matches!(res_under, Err(TxScriptError::ExceededCommittedScriptUnits { used: _, limit: _ })),
            "B_min-1 should fail with ExceededCommittedScriptUnits for {}", name
        );
    }

    // Acceptance uses each actual transaction input's committed budget, including
    // ordinary sponsor signatures. B_min probes above are not acceptance evidence.
    let transaction_sighash_cache = SigHashReusedValuesUnsync::new();
    let funding_sig_cache = Cache::new(100);
    let funding_cov_context = CovenantsContext::from_tx(pop).expect("invalid covenant bindings");
    let funding_ctx = EngineCtx::new(&funding_sig_cache)
        .with_reused(&transaction_sighash_cache).with_covenants_ctx(&funding_cov_context);
    for (index, (input, entry)) in pop.populated_inputs().enumerate() {
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            pop, input, index, entry, if index == input_idx { ctx } else { funding_ctx }, flags, input.compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()), "{}: committed input {} failed", name, index);
    }
    let total_in = pop.entries.iter().try_fold(0u64, |sum, entry| sum.checked_add(entry.amount)).expect("input sum overflow");
    let total_out = pop.tx.outputs.iter().try_fold(0u64, |sum, output| sum.checked_add(output.value)).expect("output sum overflow");
    let actual_fee = total_in.checked_sub(total_out).expect("SpendTooHigh: outputs exceed inputs");

    // Run pinned transaction rules in addition to the committed script checks
    // above. SkipScriptChecks avoids repeating those checks, NOT monetary/mass
    // validation. The sequence commitment accessor remains fixture-backed.
    let params = &MAINNET_PARAMS;
    let validator = transaction_validator::TransactionValidator::new(
        params.max_tx_inputs, params.max_tx_outputs, params.new_max_signature_script_len,
        params.max_script_public_key_len, params.coinbase_payload_script_public_key_max_len,
        params.coinbase_maturity, params.ghostdag_k,
        std::sync::Arc::new(kaspa_txscript::caches::TxScriptCacheCounters::default()),
        mass_calc.clone(), params.toccata_activation, params.mass_per_sig_op,
    );
    // Storage commitment is excluded from transaction ID and Schnorr sighash
    // in the pinned implementation; set it on the final populated transaction.
    let final_storage_mass = mass_calc.calc_contextual_masses(pop).expect("mass incomputable").storage_mass;
    pop.tx.set_storage_mass(final_storage_mass);
    let context_daa = 1_000_000_000u64.max(pop.tx.lock_time + 1);
    validator.validate_tx_in_isolation(pop.tx).expect("transaction isolation rules");
    validator.validate_tx_in_header_context_with_args(pop.tx, context_daa, 0).expect("header contextual rules");
    let checked_fee = validator.validate_populated_transaction_and_get_fee(
        pop, context_daa, context_daa,
        transaction_validator::tx_validation_in_utxo_context::TxValidationFlags::SkipScriptChecks,
        None, None,
    ).expect("populated transaction consensus rules");
    assert_eq!(checked_fee, actual_fee);

    // 4. Calculate real masses & relay floor:
    let non_ctx = mass_calc.calc_non_contextual_masses(&pop.tx);
    let norm_transient = non_ctx.normalized_transient(cofactors);
    let fee_mass = non_ctx.compute_mass.max(norm_transient);
    let relay_floor = (fee_mass * 100_000 / 1000).max(100_000);
    let ctx_masses = mass_calc.calc_contextual_masses(pop).expect("contextual mass is not computable");
    let storage_mass = ctx_masses.storage_mass;
    assert!(actual_fee >= relay_floor, "{}: fee {} below relay floor {}", name, actual_fee, relay_floor);
    // Pinned post-Toccata block capacities: an individually oversized transaction
    // cannot be included even if its scripts and minimum fee pass.
    assert!(non_ctx.compute_mass <= 500_000, "{}: compute mass exceeds block capacity", name);
    assert!(non_ctx.transient_mass <= 1_000_000, "{}: transient mass exceeds block capacity", name);
    assert!(storage_mass <= 500_000, "{}: storage mass {} exceeds block capacity", name, storage_mass);
    let tx_bytes = transaction_estimated_serialized_size(&pop.tx) as usize;
    let sig_bytes = pop.tx.inputs[input_idx].signature_script.len();

    let record = ResourceRecord {
        transition_name: name,
        redeem_bytes: redeem_len,
        sigscript_bytes: sig_bytes,
        tx_bytes,
        script_units: su.0,
        b_min,
        compute_mass: non_ctx.compute_mass,
        transient_mass: non_ctx.transient_mass,
        normalized_transient: norm_transient,
        storage_mass,
        fee_mass,
        relay_floor,
        actual_fee,
    };

    (record, b_min)
}

fn main() {
    println!("==================================================================");
    println!("KASWIN V1 PRODUCTION E2E FULL LIFECYCLE VERIFICATION SUITE");
    println!("==================================================================");

    let mass_calc = MassCalculator::new_with_consensus_params(&MAINNET_PARAMS);
    let cofactors = MAINNET_PARAMS.block_mass_cofactors().after();
    let flags = EngineFlags { covenants_enabled: true, sigop_script_units: kaspa_consensus_core::mass::Gram(1000).into() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    let mut resource_table: Vec<ResourceRecord> = Vec::new();

    // =========================================================================
    // PART 1: REAL CONNECTED PRODUCTION SUCCESS E2E PIPELINE
    // =========================================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 1: REAL CONNECTED PRODUCTION SUCCESS E2E PIPELINE");
    println!("------------------------------------------------------------------");

    // Parameters:
    let ticket_price = 3_000_000u64; // 0.03 KAS (>= 1,510,000 MIN_TICKET_PRICE)
    let ticket_cap = 100u64;
    let min_tickets = 90u64;
    let state_deposit = 50_000_000u64; // 0.5 KAS
    let sale_deadline = 1_000_500u64;

    // Ephemeral Creator Keypair (in-memory test only):
    let creator_keypair = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[0x44; 32]).unwrap();
    let mut creator_refund_spk = vec![0x00, 0x00, 0x20];
    creator_refund_spk.extend_from_slice(&creator_keypair.x_only_public_key().0.serialize());
    creator_refund_spk.push(0xac);
    let creator_refund_script = creator_refund_spk[2..].to_vec();

    // [1.1] CREATE Transaction
    println!("\n[Step 1.1] CREATE: Genesis Output & Covenant ID derivation");
    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(0xabc), 0);
    let (genesis_output, covenant_id_c) = build_directory_genesis_output(
        funding_outpoint, ticket_price, ticket_cap, min_tickets, sale_deadline, creator_refund_spk.clone(), state_deposit,
    ).unwrap();
    let round_id = compute_canonical_round_id(&funding_outpoint);

    let tx_create = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(funding_outpoint, vec![0x33; 66], 0, ComputeCommit::ComputeBudget(ComputeBudget(0)))],
        vec![genesis_output.clone()],
        0, SubnetworkId::default(), 0, vec![],
    );
    println!("  -> CREATE transaction created: id = {}", tx_create.id());

    // [1.2] BUY #1 (count = 30)
    println!("\n[Step 1.2] BUY #1: Buyer 1 purchases 30 tickets [0..30)");
    let buyer1_keypair = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[0x11; 32]).unwrap();
    let mut buyer1_p2pk = vec![0x20];
    buyer1_p2pk.extend_from_slice(&buyer1_keypair.x_only_public_key().0.serialize());
    buyer1_p2pk.push(0xac);
    let count1 = 30u64;

    let empty_levels = compute_empty_levels();
    let mut siblings_1 = [Hash::default(); ticket_commitment::TREE_DEPTH];
    for i in 0..ticket_commitment::TREE_DEPTH { siblings_1[i] = empty_levels[i]; }

    let payout_comm_1 = compute_payout_commitment(&buyer1_p2pk);
    let leaf_1 = compute_purchase_leaf(&round_id, 0, 0, count1, &payout_comm_1);
    let root_1 = compute_root_from_path(&leaf_1, 0, &siblings_1);

    let dir_1 = {
        let mut d = Vec::new();
        d.extend_from_slice(&(30u32).to_le_bytes());
        d.extend_from_slice(&buyer1_keypair.x_only_public_key().0.serialize());
        d
    };

    let next_open_redeem_1 = build_directory_open_covenant(
        round_id, ticket_price, ticket_cap, min_tickets, sale_deadline, 30, 1, root_1, creator_refund_script.clone(), &dir_1,
    ).unwrap();
    let next_open_spk_1 = pay_to_script_hash_script(&next_open_redeem_1);

    let initial_open_redeem = build_initial_directory_open_covenant(
        round_id, ticket_price, ticket_cap, min_tickets, sale_deadline, creator_refund_script.clone(),
    ).unwrap();

    let mut sig_sb_1 = ScriptBuilder::with_flags(flags);
    for i in (0..ticket_commitment::TREE_DEPTH).rev() { sig_sb_1.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_1.add_data(&buyer1_p2pk).unwrap();
    sig_sb_1.add_data(&count1.to_le_bytes()).unwrap();
    sig_sb_1.add_i64(1).unwrap(); // ACTION_BUY = 1
    sig_sb_1.add_data(&initial_open_redeem).unwrap();
    let sig_script_1 = sig_sb_1.drain();

    let pool_1 = state_deposit + ticket_price * count1; // 50M + 90M = 140M sompi
    let buyer1_funding_amount = 100_000_000u64; // 1 KAS
    let mut tx_buy1 = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(tx_create.id(), 0), // PREVIOUS OUTPOINT EXACT!
                sig_script_1.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xb1_001), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_1,
                script_public_key: next_open_spk_1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 0, // adjusted below
                script_public_key: ScriptPublicKey::from_vec(0, buyer1_p2pk.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_buy1 = mass_calc.calc_non_contextual_masses(&tx_buy1);
    let floor_buy1 = ((non_buy1.compute_mass.max(non_buy1.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_buy1 = floor_buy1 + 50_000;
    let buyer1_change = buyer1_funding_amount - ticket_price * count1 - actual_fee_buy1;
    tx_buy1.outputs[1].value = buyer1_change;

    let buyer1_funding_utxo = UtxoEntry::new(buyer1_funding_amount, ScriptPublicKey::from_vec(0, buyer1_p2pk.clone()), 1_000_000, false, None);
    let entries_buy1 = vec![
        UtxoEntry::new(state_deposit, genesis_output.script_public_key.clone(), 1_000_000, false, Some(covenant_id_c)),
        buyer1_funding_utxo,
    ];
    sign_p2pk_input(&mut tx_buy1, 1, &buyer1_keypair, &entries_buy1);

    // Verify monetary conservation:
    let total_in_buy1 = state_deposit + buyer1_funding_amount;
    let total_out_buy1 = pool_1 + buyer1_change;
    assert!(total_in_buy1 >= total_out_buy1, "SpendTooHigh!");
    assert_eq!(total_in_buy1 - total_out_buy1, actual_fee_buy1);

    let pop_buy1 = PopulatedTransaction::new(&tx_buy1, entries_buy1);
    let cov_buy1 = CovenantsContext::from_tx(&pop_buy1).unwrap();
    let ctx_buy1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_buy1);

    let (rec_buy1, bmin_buy1) = measure_and_verify_transition(
        "BUY #1", initial_open_redeem.len(), &pop_buy1, 0, ctx_buy1, flags, &mass_calc, &cofactors,
    );
    assert!(actual_fee_buy1 >= rec_buy1.relay_floor, "BUY 1 fee below relay floor");
    println!("  -> BUY #1 PASS: pool = {} sompi, actual_fee = {} >= relay_floor {}", pool_1, actual_fee_buy1, rec_buy1.relay_floor);

    // [1.3] BUY #2 (count = 10)
    println!("\n[Step 1.3] BUY #2: Buyer 2 purchases 10 tickets [30..40)");
    let buyer2_keypair = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[0x22; 32]).unwrap();
    let mut buyer2_p2pk = vec![0x20];
    buyer2_p2pk.extend_from_slice(&buyer2_keypair.x_only_public_key().0.serialize());
    buyer2_p2pk.push(0xac);
    let count2 = 10u64;

    let mut siblings_2 = [Hash::default(); ticket_commitment::TREE_DEPTH];
    siblings_2[0] = leaf_1;
    for i in 1..ticket_commitment::TREE_DEPTH { siblings_2[i] = empty_levels[i]; }

    let payout_comm_2 = compute_payout_commitment(&buyer2_p2pk);
    let leaf_2 = compute_purchase_leaf(&round_id, 1, 30, count2, &payout_comm_2);
    let root_2 = compute_root_from_path(&leaf_2, 1, &siblings_2);

    let dir_2 = {
        let mut d = dir_1.clone();
        d.extend_from_slice(&(40u32).to_le_bytes());
        d.extend_from_slice(&buyer2_keypair.x_only_public_key().0.serialize());
        d
    };

    let next_open_redeem_2 = build_directory_open_covenant(
        round_id, ticket_price, ticket_cap, min_tickets, sale_deadline, 40, 2, root_2, creator_refund_script.clone(), &dir_2,
    ).unwrap();
    let next_open_spk_2 = pay_to_script_hash_script(&next_open_redeem_2);

    let mut sig_sb_2 = ScriptBuilder::with_flags(flags);
    for i in (0..ticket_commitment::TREE_DEPTH).rev() { sig_sb_2.add_data(&siblings_2[i].as_bytes()).unwrap(); }
    sig_sb_2.add_data(&buyer2_p2pk).unwrap();
    sig_sb_2.add_data(&count2.to_le_bytes()).unwrap();
    sig_sb_2.add_i64(1).unwrap();
    sig_sb_2.add_data(&next_open_redeem_1).unwrap();
    let sig_script_2 = sig_sb_2.drain();

    let pool_2 = pool_1 + ticket_price * count2; // 140M + 30M = 170M sompi
    let buyer2_funding_amount = 50_000_000u64;

    let mut tx_buy2 = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(tx_buy1.id(), 0), // PREVIOUS OUTPOINT EXACT!
                sig_script_2.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xb2_001), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_2,
                script_public_key: next_open_spk_2.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 0,
                script_public_key: ScriptPublicKey::from_vec(0, buyer2_p2pk.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_buy2 = mass_calc.calc_non_contextual_masses(&tx_buy2);
    let floor_buy2 = ((non_buy2.compute_mass.max(non_buy2.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_buy2 = floor_buy2 + 50_000;
    let buyer2_change = buyer2_funding_amount - ticket_price * count2 - actual_fee_buy2;
    tx_buy2.outputs[1].value = buyer2_change;

    let buyer2_funding_utxo = UtxoEntry::new(buyer2_funding_amount, ScriptPublicKey::from_vec(0, buyer2_p2pk.clone()), 1_000_000, false, None);
    let entries_buy2 = vec![
        UtxoEntry::new(pool_1, next_open_spk_1.clone(), 1_000_000, false, Some(covenant_id_c)),
        buyer2_funding_utxo,
    ];
    sign_p2pk_input(&mut tx_buy2, 1, &buyer2_keypair, &entries_buy2);

    let pop_buy2 = PopulatedTransaction::new(&tx_buy2, entries_buy2);
    let cov_buy2 = CovenantsContext::from_tx(&pop_buy2).unwrap();
    let ctx_buy2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_buy2);

    let (rec_buy2, bmin_buy2) = measure_and_verify_transition(
        "BUY #2", next_open_redeem_1.len(), &pop_buy2, 0, ctx_buy2, flags, &mass_calc, &cofactors,
    );
    assert!(actual_fee_buy2 >= rec_buy2.relay_floor, "BUY 2 fee below relay floor");
    println!("  -> BUY #2 PASS: pool = {} sompi, actual_fee = {} >= relay_floor {}", pool_2, actual_fee_buy2, rec_buy2.relay_floor);

    // [1.4] BUY #3 (count = 55)
    println!("\n[Step 1.4] BUY #3: Buyer 3 purchases 55 tickets [40..95)");
    let buyer3_keypair = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[0x33; 32]).unwrap();
    let mut buyer3_p2pk = vec![0x20];
    buyer3_p2pk.extend_from_slice(&buyer3_keypair.x_only_public_key().0.serialize());
    buyer3_p2pk.push(0xac);
    let count3 = 55u64;

    let empty_leaf = compute_empty_leaf();
    let node_0_1 = hash_internal_node(&leaf_1, &leaf_2);
    let mut siblings_3 = [Hash::default(); ticket_commitment::TREE_DEPTH];
    siblings_3[0] = empty_leaf;
    siblings_3[1] = node_0_1;
    for i in 2..ticket_commitment::TREE_DEPTH { siblings_3[i] = empty_levels[i]; }

    let payout_comm_3 = compute_payout_commitment(&buyer3_p2pk);
    let leaf_3 = compute_purchase_leaf(&round_id, 2, 40, count3, &payout_comm_3);
    let root_3 = compute_root_from_path(&leaf_3, 2, &siblings_3);

    let dir_3 = {
        let mut d = dir_2.clone();
        d.extend_from_slice(&(95u32).to_le_bytes());
        d.extend_from_slice(&buyer3_keypair.x_only_public_key().0.serialize());
        d
    };

    let next_open_redeem_3 = build_directory_open_covenant(
        round_id, ticket_price, ticket_cap, min_tickets, sale_deadline, 95, 3, root_3, creator_refund_script.clone(), &dir_3,
    ).unwrap();
    let next_open_spk_3 = pay_to_script_hash_script(&next_open_redeem_3);

    let mut sig_sb_3 = ScriptBuilder::with_flags(flags);
    for i in (0..ticket_commitment::TREE_DEPTH).rev() { sig_sb_3.add_data(&siblings_3[i].as_bytes()).unwrap(); }
    sig_sb_3.add_data(&buyer3_p2pk).unwrap();
    sig_sb_3.add_data(&count3.to_le_bytes()).unwrap();
    sig_sb_3.add_i64(1).unwrap();
    sig_sb_3.add_data(&next_open_redeem_2).unwrap();
    let sig_script_3 = sig_sb_3.drain();

    let pool_3 = pool_2 + ticket_price * count3; // 170M + 165M = 335M sompi
    let buyer3_funding_amount = 200_000_000u64;

    let mut tx_buy3 = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(tx_buy2.id(), 0), // PREVIOUS OUTPOINT EXACT!
                sig_script_3.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xb3_001), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_3,
                script_public_key: next_open_spk_3.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 0,
                script_public_key: ScriptPublicKey::from_vec(0, buyer3_p2pk.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_buy3 = mass_calc.calc_non_contextual_masses(&tx_buy3);
    let floor_buy3 = ((non_buy3.compute_mass.max(non_buy3.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_buy3 = floor_buy3 + 50_000;
    let buyer3_change = buyer3_funding_amount - ticket_price * count3 - actual_fee_buy3;
    tx_buy3.outputs[1].value = buyer3_change;

    let buyer3_funding_utxo = UtxoEntry::new(buyer3_funding_amount, ScriptPublicKey::from_vec(0, buyer3_p2pk.clone()), 1_000_000, false, None);
    let entries_buy3 = vec![
        UtxoEntry::new(pool_2, next_open_spk_2.clone(), 1_000_000, false, Some(covenant_id_c)),
        buyer3_funding_utxo,
    ];
    sign_p2pk_input(&mut tx_buy3, 1, &buyer3_keypair, &entries_buy3);

    let pop_buy3 = PopulatedTransaction::new(&tx_buy3, entries_buy3);
    let cov_buy3 = CovenantsContext::from_tx(&pop_buy3).unwrap();
    let ctx_buy3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_buy3);

    let (rec_buy3, bmin_buy3) = measure_and_verify_transition(
        "BUY max relevant (BUY 3)", next_open_redeem_2.len(), &pop_buy3, 0, ctx_buy3, flags, &mass_calc, &cofactors,
    );
    assert!(actual_fee_buy3 >= rec_buy3.relay_floor, "BUY 3 fee below relay floor");
    resource_table.push(rec_buy3.clone());
    println!("  -> BUY #3 PASS: pool = {} sompi, actual_fee = {} >= relay_floor {}", pool_3, actual_fee_buy3, rec_buy3.relay_floor);

    // [1.5] CLOSE: Deadline close transitions to SEALED (sold=95 >= min=90)
    println!("\n[Step 1.5] CLOSE: Deadline close transitions to SEALED (draw_ticket_count = 95 != ticket_cap = 100)");
    let sealed_redeem = build_directory_sealed_covenant(
        round_id, ticket_price, 95, root_3, 3, creator_refund_script.clone(), dir_3.clone(),
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);

    let sponsor_keypair = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[0x55; 32]).unwrap();
    let mut sponsor_p2pk = vec![0x20];
    sponsor_p2pk.extend_from_slice(&sponsor_keypair.x_only_public_key().0.serialize());
    sponsor_p2pk.push(0xac);

    let sponsor_funding_close = 10_000_000u64;

    let mut tx_close = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(tx_buy3.id(), 0), // PREVIOUS OUTPOINT EXACT!
                {
                    let mut sb = ScriptBuilder::with_flags(flags);
                    sb.add_i64(ACTION_CLOSE).unwrap();
                    sb.add_data(&next_open_redeem_3).unwrap();
                    sb.drain()
                },
                0, // sequence != MAX
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfe_001), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_3, // Exact state deposit + principal preservation!
                script_public_key: sealed_spk.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 0,
                script_public_key: ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()),
                covenant: None,
            },
        ],
        sale_deadline, // tx.lock_time == sale_deadline
        SubnetworkId::default(), 0, vec![],
    );

    let non_close = mass_calc.calc_non_contextual_masses(&tx_close);
    let floor_close = ((non_close.compute_mass.max(non_close.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_close = floor_close + 50_000;
    let sponsor_change_close = sponsor_funding_close - actual_fee_close;
    tx_close.outputs[1].value = sponsor_change_close;

    let entries_close = vec![
        UtxoEntry::new(pool_3, next_open_spk_3.clone(), 1_000_000, false, Some(covenant_id_c)),
        UtxoEntry::new(sponsor_funding_close, ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()), 1_000_000, false, None),
    ];
    sign_p2pk_input(&mut tx_close, 1, &sponsor_keypair, &entries_close);

    let pop_close = PopulatedTransaction::new(&tx_close, entries_close);
    let cov_close = CovenantsContext::from_tx(&pop_close).unwrap();
    let ctx_close = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_close);

    let (rec_close_sealed, bmin_close) = measure_and_verify_transition(
        "CLOSE -> SEALED", next_open_redeem_3.len(), &pop_close, 0, ctx_close, flags, &mass_calc, &cofactors,
    );
    assert!(actual_fee_close >= rec_close_sealed.relay_floor, "CLOSE fee below relay floor");
    resource_table.push(rec_close_sealed.clone());
    println!("  -> CLOSE PASS: transitioned OPEN(95) -> SEALED(95), fee = {} >= relay_floor {}", actual_fee_close, rec_close_sealed.relay_floor);

    // [1.6] SEALED -> DRAW_READY(0): PASS-A Entropy Opening
    println!("\n[Step 1.6] SEALED -> DRAW_READY(0): PASS-A Entropy Opening");
    let fixture = generate_valid_pass_a_fixture(100, 250);
    let mut seq_commits_map = HashMap::new();
    seq_commits_map.insert(fixture.target_hash, fixture.c_t);
    let seq_accessor = MockSeqCommitAccessor {
        selected_chain: vec![fixture.target_hash],
        seq_commits: seq_commits_map,
    };

    let app_comm = compute_application_commitment(&round_id, &root_3, 95);
    let random_seed = compute_random_seed(&fixture.target_hash, &app_comm);

    let draw_ready_0_redeem = build_directory_draw_ready_covenant(
        round_id, ticket_price, 95, root_3, 3, fixture.target_hash, random_seed, 0, creator_refund_script.clone(), dir_3.clone(),
    );
    let draw_ready_0_spk = pay_to_script_hash_script(&draw_ready_0_redeem);

    let mut sig_sb_draw = ScriptBuilder::with_flags(flags);
    sig_sb_draw.add_data(&fixture.target_hash.as_bytes()).unwrap();
    sig_sb_draw.add_data(&fixture.target_activity.as_bytes()).unwrap();
    sig_sb_draw.add_data(&fixture.target_payload.as_bytes()).unwrap();
    sig_sb_draw.add_data(&fixture.target_sp_ts).unwrap();
    sig_sb_draw.add_data(&fixture.target_daa).unwrap();
    sig_sb_draw.add_data(&fixture.target_blue).unwrap();
    sig_sb_draw.add_data(&fixture.p_parent_seq.as_bytes()).unwrap();
    sig_sb_draw.add_data(&fixture.p_activity.as_bytes()).unwrap();
    sig_sb_draw.add_data(&fixture.p_payload.as_bytes()).unwrap();
    sig_sb_draw.add_data(&fixture.p_sp_ts).unwrap();
    sig_sb_draw.add_data(&fixture.p_daa).unwrap();
    sig_sb_draw.add_data(&fixture.p_blue).unwrap();
    sig_sb_draw.add_i64(ACTION_DRAW).unwrap();
    sig_sb_draw.add_data(&sealed_redeem).unwrap();

    let sponsor_funding_draw = 10_000_000u64;

    let mut tx_draw = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(tx_close.id(), 0), // PREVIOUS OUTPOINT EXACT!
                sig_sb_draw.drain(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfe_002), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_3, // Exact state preservation!
                script_public_key: draw_ready_0_spk.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 0,
                script_public_key: ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_draw = mass_calc.calc_non_contextual_masses(&tx_draw);
    let floor_draw = ((non_draw.compute_mass.max(non_draw.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_draw = floor_draw + 50_000;
    let sponsor_change_draw = sponsor_funding_draw - actual_fee_draw;
    tx_draw.outputs[1].value = sponsor_change_draw;

    let entries_draw = vec![
        UtxoEntry::new(pool_3, sealed_spk.clone(), 100, false, Some(covenant_id_c)),
        UtxoEntry::new(sponsor_funding_draw, ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()), 1_000_000, false, None),
    ];
    sign_p2pk_input(&mut tx_draw, 1, &sponsor_keypair, &entries_draw);

    let pop_draw = PopulatedTransaction::new(&tx_draw, entries_draw);
    let cov_draw = CovenantsContext::from_tx(&pop_draw).unwrap();
    let ctx_draw = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_draw).with_seq_commit_accessor_opt(Some(&seq_accessor));

    let (rec_sealed_draw, bmin_draw) = measure_and_verify_transition(
        "SEALED -> DRAW_READY", sealed_redeem.len(), &pop_draw, 0, ctx_draw, flags, &mass_calc, &cofactors,
    );
    assert!(rec_sealed_draw.actual_fee >= rec_sealed_draw.relay_floor, "DRAW fee below relay floor");
    resource_table.push(rec_sealed_draw.clone());
    println!("  -> SEALED -> DRAW_READY(0) PASS: fee = {} >= relay_floor {}", rec_sealed_draw.actual_fee, rec_sealed_draw.relay_floor);

    // [1.7] DRAW_READY(0) -> WINNER_READY: ACCEPT with Directory Range Lookup
    println!("\n[Step 1.7] DRAW_READY(0) -> WINNER_READY: ACCEPT with Directory Range Lookup");
    let cand_hash = compute_candidate_hash(&random_seed, 0);
    let cand_num = extract_candidate_num(&cand_hash);
    let limit = (DOMAIN_R_56_V1 / 95) * 95;
    let winner_index = (cand_num % 95) as u64; // Domain N = 95
    assert_eq!(winner_index, 19); // deterministic seed yields candidate 19
    // Purchase 0 covers [0..30), index 19 falls in Purchase 0 (Buyer 1)!

    let winner_ready_redeem = build_production_winner_ready_3out_covenant(
        round_id, ticket_price, 95, root_3,
        fixture.target_hash, random_seed, 0, winner_index, buyer1_p2pk.clone(), creator_refund_script.clone(),
    );
    let winner_ready_spk = pay_to_script_hash_script(&winner_ready_redeem);

    let mut sig_sb_accept = ScriptBuilder::with_flags(flags);
    sig_sb_accept.add_data(&(0u64).to_le_bytes()).unwrap(); // purchase_index = 0 (8B LE)
    sig_sb_accept.add_data(&draw_ready_0_redeem).unwrap();

    let sponsor_funding_acc = 10_000_000u64;

    let mut tx_accept = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(tx_draw.id(), 0), // PREVIOUS OUTPOINT EXACT!
                sig_sb_accept.drain(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfe_003), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_3, // Exact state preservation!
                script_public_key: winner_ready_spk.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 0,
                script_public_key: ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_acc = mass_calc.calc_non_contextual_masses(&tx_accept);
    let floor_acc = ((non_acc.compute_mass.max(non_acc.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_acc = floor_acc + 50_000;
    let sponsor_change_acc = sponsor_funding_acc - actual_fee_acc;
    tx_accept.outputs[1].value = sponsor_change_acc;

    let entries_accept = vec![
        UtxoEntry::new(pool_3, draw_ready_0_spk.clone(), 1_000_000, false, Some(covenant_id_c)),
        UtxoEntry::new(sponsor_funding_acc, ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()), 1_000_000, false, None),
    ];
    sign_p2pk_input(&mut tx_accept, 1, &sponsor_keypair, &entries_accept);

    let pop_accept = PopulatedTransaction::new(&tx_accept, entries_accept);
    let cov_accept = CovenantsContext::from_tx(&pop_accept).unwrap();
    let ctx_accept = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_accept);

    let (rec_accept, bmin_accept) = measure_and_verify_transition(
        "DRAW_READY ACCEPT", draw_ready_0_redeem.len(), &pop_accept, 0, ctx_accept, flags, &mass_calc, &cofactors,
    );
    assert!(rec_accept.actual_fee >= rec_accept.relay_floor, "ACCEPT fee below relay floor");
    resource_table.push(rec_accept.clone());
    println!("  -> DRAW_READY ACCEPT PASS: winner index 45 authenticated to purchase 2, fee = {} >= relay_floor {}", rec_accept.actual_fee, rec_accept.relay_floor);

    // [1.7b] DRAW_READY -> REJECT -> DRAW_READY(c+1) (Measurement for resource table)
    // To authentically trigger the REJECT path (candidate_num >= LIMIT), we use N = 2^55 + 1
    // where LIMIT = N and seed [0u8; 32] produces candidate_num = 69,657,251,021,652,173 >= LIMIT.
    let n_reject = (1u64 << 55) + 1;
    let seed_reject = Hash::from_bytes([0u8; 32]);
    let draw_ready_rej_0 = build_directory_draw_ready_covenant(
        round_id, ticket_price, n_reject, root_3, 3, fixture.target_hash, seed_reject, 0, creator_refund_script.clone(), dir_3.clone(),
    );
    let draw_ready_rej_0_spk = pay_to_script_hash_script(&draw_ready_rej_0);

    let draw_ready_rej_1 = build_directory_draw_ready_covenant(
        round_id, ticket_price, n_reject, root_3, 3, fixture.target_hash, seed_reject, 1, creator_refund_script.clone(), dir_3.clone(),
    );
    let draw_ready_rej_1_spk = pay_to_script_hash_script(&draw_ready_rej_1);

    let mut sig_sb_reject = ScriptBuilder::with_flags(flags);
    sig_sb_reject.add_data(&draw_ready_rej_0).unwrap();

    let mut tx_reject = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(tx_draw.id(), 0),
                sig_sb_reject.drain(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfe_004), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_3,
                script_public_key: draw_ready_rej_1_spk.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 0,
                script_public_key: ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_rej = mass_calc.calc_non_contextual_masses(&tx_reject);
    let floor_rej = ((non_rej.compute_mass.max(non_rej.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_rej = floor_rej + 50_000;
    let sponsor_change_rej = sponsor_funding_acc - actual_fee_rej;
    tx_reject.outputs[1].value = sponsor_change_rej;

    let entries_reject = vec![
        UtxoEntry::new(pool_3, draw_ready_rej_0_spk.clone(), 1_000_000, false, Some(covenant_id_c)),
        UtxoEntry::new(sponsor_funding_acc, ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()), 1_000_000, false, None),
    ];
    sign_p2pk_input(&mut tx_reject, 1, &sponsor_keypair, &entries_reject);
    let pop_reject = PopulatedTransaction::new(&tx_reject, entries_reject);
    let cov_reject = CovenantsContext::from_tx(&pop_reject).unwrap();
    let ctx_reject = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_reject);

    let (rec_reject, bmin_reject) = measure_and_verify_transition(
        "DRAW_READY REJECT", draw_ready_rej_0.len(), &pop_reject, 0, ctx_reject, flags, &mass_calc, &cofactors,
    );
    resource_table.push(rec_reject.clone());
    println!("  -> DRAW_READY REJECT PASS: measured B_min = {:?}, relay_floor = {}", bmin_reject, rec_reject.relay_floor);

    // [1.8] WINNER_READY -> PAID: 1-in-3-out Terminal Settlement
    println!("\n[Step 1.8] WINNER_READY -> PAID: 1-in-3-out Terminal Settlement");
    let gross_pool = 95 * ticket_price; // 285,000,000 sompi (2.85 KAS)
    let finalizer_reward_amount = 100_000_000u64; // 1 KAS

    let finalizer_keypair = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[0x77; 32]).unwrap();
    let mut finalizer_p2pk = vec![0x20];
    finalizer_p2pk.extend_from_slice(&finalizer_keypair.x_only_public_key().0.serialize());
    finalizer_p2pk.push(0xac);

    let mut sig_sb_paid = ScriptBuilder::with_flags(flags);
    sig_sb_paid.add_data(&finalizer_p2pk).unwrap(); // witness finalizer SPK
    sig_sb_paid.add_data(&winner_ready_redeem).unwrap();

    let mut tx_paid = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_accept.id(), 0), // PREVIOUS OUTPOINT EXACT!
            sig_sb_paid.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)), // B_min = 0 (fits in free allowance)
        )],
        vec![
            TransactionOutput {
                value: 0, // set below
                script_public_key: ScriptPublicKey::from_vec(0, buyer1_p2pk.clone()),
                covenant: None,
            },
            TransactionOutput {
                value: state_deposit, // 100% exact creator deposit return!
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_script.clone()),
                covenant: None,
            },
            TransactionOutput {
                value: finalizer_reward_amount,
                script_public_key: ScriptPublicKey::from_vec(0, finalizer_p2pk.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_paid = mass_calc.calc_non_contextual_masses(&tx_paid);
    let floor_paid = ((non_paid.compute_mass.max(non_paid.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let miner_fee_paid = floor_paid + 10_000;
    let winner_net_payout = gross_pool - finalizer_reward_amount - miner_fee_paid;
    tx_paid.outputs[0].value = winner_net_payout;

    let entries_paid = vec![
        UtxoEntry::new(pool_3, winner_ready_spk.clone(), 1_000_000, false, Some(covenant_id_c)),
    ];
    let pop_paid = PopulatedTransaction::new(&tx_paid, entries_paid);
    let cov_paid = CovenantsContext::from_tx(&pop_paid).unwrap();
    let ctx_paid = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_paid);

    let (rec_paid, bmin_paid) = measure_and_verify_transition(
        "WINNER_READY -> PAID", winner_ready_redeem.len(), &pop_paid, 0, ctx_paid, flags, &mass_calc, &cofactors,
    );
    assert_eq!(bmin_paid.0, 0, "PAID settlement must fit in free allowance (B_min = 0)");
    resource_table.push(rec_paid.clone());
    println!("  -> WINNER_READY -> PAID PASS: 1-in-3-out settlement executed Ok(()), B_min = 0 (free allowance)");

    // =========================================================================
    // PART 2: REAL CONNECTED PRODUCTION REFUND E2E PIPELINE (P=17)
    // =========================================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 2: REAL CONNECTED PRODUCTION REFUND E2E PIPELINE (P=17)");
    println!("------------------------------------------------------------------");

    let round_id_ref = Hash::from_u64_word(0xdef);
    let cov_id_ref = Hash::from_u64_word(0xaaa);

    // Construct 17 non-uniform purchase records:
    let mut records17 = Vec::new();
    let mut cum17 = 0u32;
    for i in 0..17 {
        cum17 += 3; // 3 tickets per purchase -> total 51 tickets
        let mut pk = [0u8; 32];
        pk[0] = (i + 1) as u8;
        records17.push((cum17, pk));
    }
    let mut dir17 = Vec::new();
    for (end, pk) in &records17 {
        dir17.extend_from_slice(&end.to_le_bytes());
        dir17.extend_from_slice(pk);
    }
    let total_sold17 = 51u64;
    let min_tickets_ref = 60u64; // sold 51 < min 60 -> routes to REFUND!

    let open_redeem_17 = build_directory_open_covenant(
        round_id_ref, ticket_price, ticket_cap, min_tickets_ref, sale_deadline,
        total_sold17, 17, Hash::from_u64_word(0x17), creator_refund_script.clone(), &dir17,
    ).unwrap();
    let open_spk_17 = pay_to_script_hash_script(&open_redeem_17);

    let initial_refund_amount = state_deposit + total_sold17 * ticket_price; // 50M + 153M = 203M sompi

    // CLOSE transaction to REFUNDING(cursor = 0):
    let ref_redeem_0 = build_compact_universal_refunding_covenant(
        round_id_ref, ticket_price, 17, 0, creator_refund_script.clone(), dir17.clone(),
    );
    let ref_spk_0 = pay_to_script_hash_script(&ref_redeem_0);

    let sponsor_funding_ref = 10_000_000u64;

    let mut tx_close_ref = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xc17), 0),
                {
                    let mut sb = ScriptBuilder::with_flags(flags);
                    sb.add_i64(ACTION_CLOSE).unwrap();
                    sb.add_data(&open_redeem_17).unwrap();
                    sb.drain()
                },
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfe17), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: initial_refund_amount,
                script_public_key: ref_spk_0.clone(),
                covenant: Some(CovenantBinding { covenant_id: cov_id_ref, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 0,
                script_public_key: ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()),
                covenant: None,
            },
        ],
        sale_deadline, SubnetworkId::default(), 0, vec![],
    );

    let non_close_ref = mass_calc.calc_non_contextual_masses(&tx_close_ref);
    let floor_close_ref = ((non_close_ref.compute_mass.max(non_close_ref.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_close_ref = floor_close_ref + 50_000;
    let sponsor_change_ref = sponsor_funding_ref - actual_fee_close_ref;
    tx_close_ref.outputs[1].value = sponsor_change_ref;

    let entries_close_ref = vec![
        UtxoEntry::new(initial_refund_amount, open_spk_17.clone(), 1_000_000, false, Some(cov_id_ref)),
        UtxoEntry::new(sponsor_funding_ref, ScriptPublicKey::from_vec(0, sponsor_p2pk.clone()), 1_000_000, false, None),
    ];
    sign_p2pk_input(&mut tx_close_ref, 1, &sponsor_keypair, &entries_close_ref);

    let pop_close_ref = PopulatedTransaction::new(&tx_close_ref, entries_close_ref);
    let cov_close_ref = CovenantsContext::from_tx(&pop_close_ref).unwrap();
    let ctx_close_ref = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_close_ref);

    let (rec_close_ref, bmin_close_ref) = measure_and_verify_transition(
        "CLOSE -> REFUNDING", open_redeem_17.len(), &pop_close_ref, 0, ctx_close_ref, flags, &mass_calc, &cofactors,
    );
    resource_table.push(rec_close_ref.clone());
    println!("  -> CLOSE -> REFUNDING PASS: Output 0 is REFUNDING(cur=0), fee = {} >= relay_floor {}", actual_fee_close_ref, rec_close_ref.relay_floor);

    // Step 2.1: Refund Step 0 (K=9, Non-terminal)
    // SPENDS tx_close_ref Output 0!
    println!("\n[Step 2.1] Refund Step 0: Refunding purchases 0..9 (K=9, non-terminal)");
    let fee_guess_step0 = 250_000u64;
    let mut outputs_step0 = Vec::new();
    let mut gross_step0 = 0u64;

    for j in 0..9 {
        let gross_j = 3 * ticket_price; // 9,000,000 sompi
        gross_step0 += gross_j;
        let refund_j = gross_j - fee_guess_step0;
        let mut buyer_p2pk = vec![0x20];
        buyer_p2pk.extend_from_slice(&records17[j].1);
        buyer_p2pk.push(0xac);
        outputs_step0.push(TransactionOutput {
            value: refund_j,
            script_public_key: ScriptPublicKey::from_vec(0, buyer_p2pk),
            covenant: None,
        });
    }

    let next_amount_1 = initial_refund_amount - gross_step0;
    let ref_redeem_1 = build_compact_universal_refunding_covenant(
        round_id_ref, ticket_price, 17, 9, creator_refund_script.clone(), dir17.clone(),
    );
    let ref_spk_1 = pay_to_script_hash_script(&ref_redeem_1);

    outputs_step0.insert(0, TransactionOutput {
        value: next_amount_1,
        script_public_key: ref_spk_1.clone(),
        covenant: Some(CovenantBinding { covenant_id: cov_id_ref, authorizing_input: 0 }),
    });

    let mut sig_sb_ref0 = ScriptBuilder::with_flags(flags);
    for _ in 0..9 { sig_sb_ref0.add_data(&fee_guess_step0.to_le_bytes()).unwrap(); }
    sig_sb_ref0.add_i64(9).unwrap();
    sig_sb_ref0.add_data(&ref_redeem_0).unwrap();

    let mut tx_ref0 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_close_ref.id(), 0), // PREVIOUS OUTPOINT EXACT (CLOSE Output 0)!
            sig_sb_ref0.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(40)),
        )],
        outputs_step0,
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_ref0 = mass_calc.calc_non_contextual_masses(&tx_ref0);
    let floor_ref0 = ((non_ref0.compute_mass.max(non_ref0.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let fee_per_buyer0 = ((floor_ref0 + 50_000 + 8) / 9).max(250_000);
    assert!(fee_per_buyer0 <= MAX_REFUND_FEE_V1);
    let fees_step0 = vec![fee_per_buyer0; 9];
    for j in 0..9 {
        tx_ref0.outputs[j + 1].value = 3 * ticket_price - fee_per_buyer0;
    }
    let mut sig_sb_ref0_final = ScriptBuilder::with_flags(flags);
    for f in fees_step0.iter().rev() { sig_sb_ref0_final.add_data(&f.to_le_bytes()).unwrap(); }
    sig_sb_ref0_final.add_i64(9).unwrap();
    sig_sb_ref0_final.add_data(&ref_redeem_0).unwrap();
    tx_ref0.inputs[0].signature_script = sig_sb_ref0_final.drain();

    let actual_fee_ref0: u64 = fees_step0.iter().sum();
    let entries_ref0 = vec![
        UtxoEntry::new(initial_refund_amount, ref_spk_0.clone(), 1_000_000, false, Some(cov_id_ref)),
    ];
    let pop_ref0 = PopulatedTransaction::new(&tx_ref0, entries_ref0);
    let cov_ref0 = CovenantsContext::from_tx(&pop_ref0).unwrap();
    let ctx_ref0 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ref0);

    let (rec_ref0, bmin_ref0) = measure_and_verify_transition(
        "REFUND Step 0 (K=9)", ref_redeem_0.len(), &pop_ref0, 0, ctx_ref0, flags, &mass_calc, &cofactors,
    );
    assert!(actual_fee_ref0 >= rec_ref0.relay_floor, "Refund Step 0 fee below relay floor");
    println!("  -> Step 0 (K=9) PASS: remaining pool = {} sompi, actual_fee = {} >= relay_floor {}", next_amount_1, actual_fee_ref0, rec_ref0.relay_floor);

    // Step 2.2: Refund Step 1 (K=8, Terminal)
    // SPENDS tx_ref0 Output 0!
    println!("\n[Step 2.2] Refund Step 1: Refunding purchases 9..17 (K=8, terminal, creator deposit return)");
    let fee_guess_step1 = 250_000u64;
    let mut outputs_step1 = Vec::new();

    for j in 0..8 {
        let gross_j = 3 * ticket_price;
        let refund_j = gross_j - fee_guess_step1;
        let mut buyer_p2pk = vec![0x20];
        buyer_p2pk.extend_from_slice(&records17[9 + j].1);
        buyer_p2pk.push(0xac);
        outputs_step1.push(TransactionOutput {
            value: refund_j,
            script_public_key: ScriptPublicKey::from_vec(0, buyer_p2pk),
            covenant: None,
        });
    }

    // Output 8 returns creator state deposit:
    outputs_step1.push(TransactionOutput {
        value: state_deposit,
        script_public_key: ScriptPublicKey::from_vec(0, creator_refund_script.clone()),
        covenant: None, // Lineage terminated!
    });

    let mut sig_sb_ref1 = ScriptBuilder::with_flags(flags);
    for _ in 0..8 { sig_sb_ref1.add_data(&fee_guess_step1.to_le_bytes()).unwrap(); }
    sig_sb_ref1.add_i64(8).unwrap();
    sig_sb_ref1.add_data(&ref_redeem_1).unwrap();

    let mut tx_ref1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_ref0.id(), 0), // PREVIOUS OUTPOINT EXACT (Step 0 Output 0)!
            sig_sb_ref1.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(40)),
        )],
        outputs_step1,
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_ref1 = mass_calc.calc_non_contextual_masses(&tx_ref1);
    let floor_ref1 = ((non_ref1.compute_mass.max(non_ref1.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let fee_per_buyer1 = ((floor_ref1 + 50_000 + 7) / 8).max(250_000);
    assert!(fee_per_buyer1 <= MAX_REFUND_FEE_V1);
    let fees_step1 = vec![fee_per_buyer1; 8];
    for j in 0..8 {
        tx_ref1.outputs[j].value = 3 * ticket_price - fee_per_buyer1;
    }
    let mut sig_sb_ref1_final = ScriptBuilder::with_flags(flags);
    for f in fees_step1.iter().rev() { sig_sb_ref1_final.add_data(&f.to_le_bytes()).unwrap(); }
    sig_sb_ref1_final.add_i64(8).unwrap();
    sig_sb_ref1_final.add_data(&ref_redeem_1).unwrap();
    tx_ref1.inputs[0].signature_script = sig_sb_ref1_final.drain();

    let actual_fee_ref1: u64 = fees_step1.iter().sum();
    let entries_ref1 = vec![
        UtxoEntry::new(next_amount_1, ref_spk_1.clone(), 1_000_000, false, Some(cov_id_ref)),
    ];
    let pop_ref1 = PopulatedTransaction::new(&tx_ref1, entries_ref1);
    let cov_ref1 = CovenantsContext::from_tx(&pop_ref1).unwrap();
    let ctx_ref1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ref1);

    let (rec_ref1, bmin_ref1) = measure_and_verify_transition(
        "REFUND Step 1 (K=8 terminal)", ref_redeem_1.len(), &pop_ref1, 0, ctx_ref1, flags, &mass_calc, &cofactors,
    );
    assert!(actual_fee_ref1 >= rec_ref1.relay_floor, "Refund Step 1 fee below relay floor");
    println!("  -> Step 1 (K=8 terminal) PASS: creator deposit 50M returned, lineage terminated 100%!");

    // =========================================================================
    // PART 3: BOUNDARY VERIFICATIONS (P=1 and P=256 Real Transactions)
    // =========================================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 3: BOUNDARY VERIFICATIONS (P=1 and P=256 Real Transactions)");
    println!("------------------------------------------------------------------");

    // P = 1 Real Terminal Refund
    println!("\n[Step 3.1] P = 1 Real Terminal Refund Transaction");
    let round_id_p1 = Hash::from_u64_word(0x111);
    let cov_id_p1 = Hash::from_u64_word(0x222);
    let mut dir1 = Vec::new();
    dir1.extend_from_slice(&10u32.to_le_bytes());
    dir1.extend_from_slice(&[0xaa; 32]);
    let ref_redeem_p1 = build_compact_universal_refunding_covenant(
        round_id_p1, ticket_price, 1, 0, creator_refund_script.clone(), dir1.clone(),
    );
    let ref_spk_p1 = pay_to_script_hash_script(&ref_redeem_p1);
    let p1_pool = state_deposit + 10 * ticket_price; // 50M + 30M = 80M sompi

    let mut buyer1_p2pk_p1 = vec![0x20];
    buyer1_p2pk_p1.extend_from_slice(&[0xaa; 32]);
    buyer1_p2pk_p1.push(0xac);

    let mut sig_sb_p1 = ScriptBuilder::with_flags(flags);
    sig_sb_p1.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_p1.add_i64(1).unwrap();
    sig_sb_p1.add_data(&ref_redeem_p1).unwrap();

    let mut tx_p1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(0x333), 0),
            sig_sb_p1.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(40)),
        )],
        vec![
            TransactionOutput {
                value: 30_000_000, // adjusted below
                script_public_key: ScriptPublicKey::from_vec(0, buyer1_p2pk_p1),
                covenant: None,
            },
            TransactionOutput {
                value: state_deposit,
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_script.clone()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let non_p1 = mass_calc.calc_non_contextual_masses(&tx_p1);
    let floor_p1 = ((non_p1.compute_mass.max(non_p1.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let fee_p1 = floor_p1 + 50_000;
    assert!(fee_p1 <= MAX_REFUND_FEE_V1, "P=1 fee must be <= MAX_REFUND_FEE_V1");
    tx_p1.outputs[0].value = 30_000_000 - fee_p1;

    let mut sig_sb_p1_final = ScriptBuilder::with_flags(flags);
    sig_sb_p1_final.add_data(&fee_p1.to_le_bytes()).unwrap();
    sig_sb_p1_final.add_i64(1).unwrap();
    sig_sb_p1_final.add_data(&ref_redeem_p1).unwrap();
    tx_p1.inputs[0].signature_script = sig_sb_p1_final.drain();

    let pop_p1 = PopulatedTransaction::new(&tx_p1, vec![
        UtxoEntry::new(p1_pool, ref_spk_p1.clone(), 1_000_000, false, Some(cov_id_p1)),
    ]);
    let cov_p1 = CovenantsContext::from_tx(&pop_p1).unwrap();
    let ctx_p1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_p1);
    let (rec_p1, _) = measure_and_verify_transition(
        "REFUND P=1", ref_redeem_p1.len(), &pop_p1, 0, ctx_p1, flags, &mass_calc, &cofactors,
    );
    assert!(fee_p1 >= rec_p1.relay_floor);
    println!("  -> P=1 terminal refund PASS: fee = {} >= relay_floor {}", fee_p1, rec_p1.relay_floor);

    // P = 256 Real Connected 16-Step Refund Chain (K=16 each)
    println!("\n[Step 3.2] P = 256 Real Connected 16-Step Refund Chain");
    let round_id_p256 = Hash::from_u64_word(0x256);
    let cov_id_p256 = Hash::from_u64_word(0x257);
    let mut dir256 = Vec::new();
    let mut cum256 = 0u32;
    for i in 0..256 {
        cum256 += 2;
        dir256.extend_from_slice(&cum256.to_le_bytes());
        dir256.extend_from_slice(&[(i % 250 + 1) as u8; 32]);
    }
    let total_tickets_256 = cum256 as u64; // 512 tickets
    let initial_pool_256 = state_deposit + total_tickets_256 * ticket_price;

    let mut current_tx_id = Hash::from_u64_word(0x999);
    let mut current_pool = initial_pool_256;
    let mut current_cursor = 0usize;

    for step in 0..16 {
        let k = 16usize;
        let is_terminal = step == 15;
        let cur_redeem = build_compact_universal_refunding_covenant(
            round_id_p256, ticket_price, 256, current_cursor as u64, creator_refund_script.clone(), dir256.clone(),
        );
        let cur_spk = pay_to_script_hash_script(&cur_redeem);

        let fee_guess_256 = 200_000u64;
        let mut outputs_step = Vec::new();
        let mut gross_step = 0u64;

        for j in 0..k {
            let gross_j = 2 * ticket_price;
            gross_step += gross_j;
            let p_idx = step * 16 + j;
            let pk_full = [(p_idx % 250 + 1) as u8; 32];
            let mut buyer_p2pk_step = vec![0x20];
            buyer_p2pk_step.extend_from_slice(&pk_full);
            buyer_p2pk_step.push(0xac);
            outputs_step.push(TransactionOutput {
                value: gross_j - fee_guess_256,
                script_public_key: ScriptPublicKey::from_vec(0, buyer_p2pk_step),
                covenant: None,
            });
        }

        let next_pool = current_pool - gross_step;

        if !is_terminal {
            let next_redeem = build_compact_universal_refunding_covenant(
                round_id_p256, ticket_price, 256, (current_cursor + k) as u64, creator_refund_script.clone(), dir256.clone(),
            );
            let next_spk = pay_to_script_hash_script(&next_redeem);
            outputs_step.insert(0, TransactionOutput {
                value: next_pool,
                script_public_key: next_spk,
                covenant: Some(CovenantBinding { covenant_id: cov_id_p256, authorizing_input: 0 }),
            });
        } else {
            outputs_step.push(TransactionOutput {
                value: state_deposit,
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_script.clone()),
                covenant: None,
            });
        }

        let mut sig_sb = ScriptBuilder::with_flags(flags);
        for _ in 0..k { sig_sb.add_data(&fee_guess_256.to_le_bytes()).unwrap(); }
        sig_sb.add_i64(k as i64).unwrap();
        sig_sb.add_data(&cur_redeem).unwrap();

        let mut tx_step = Transaction::new(
            1,
            vec![TransactionInput::new_with_mass(
                TransactionOutpoint::new(current_tx_id, 0), // Connected chain!
                sig_sb.drain(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            )],
            outputs_step,
            0, SubnetworkId::default(), 0, vec![],
        );

        let non_step = mass_calc.calc_non_contextual_masses(&tx_step);
        let floor_step = ((non_step.compute_mass.max(non_step.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
        let fee_per_buyer = ((floor_step + 50_000 + 15) / 16).max(200_000);
        assert!(fee_per_buyer <= MAX_REFUND_FEE_V1);
        let fees_step = vec![fee_per_buyer; k];
        for j in 0..k {
            let out_idx = if !is_terminal { j + 1 } else { j };
            tx_step.outputs[out_idx].value = 2 * ticket_price - fee_per_buyer;
        }
        let mut sig_sb_final = ScriptBuilder::with_flags(flags);
        for f in fees_step.iter().rev() { sig_sb_final.add_data(&f.to_le_bytes()).unwrap(); }
        sig_sb_final.add_i64(k as i64).unwrap();
        sig_sb_final.add_data(&cur_redeem).unwrap();
        tx_step.inputs[0].signature_script = sig_sb_final.drain();

        let pop_step = PopulatedTransaction::new(&tx_step, vec![
            UtxoEntry::new(current_pool, cur_spk, 1_000_000, false, Some(cov_id_p256)),
        ]);
        let cov_step = CovenantsContext::from_tx(&pop_step).unwrap();
        let ctx_step = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_step);

        if step == 0 {
            let (rec_p256_non_term, _) = measure_and_verify_transition(
                "REFUND P=256 non-terminal", cur_redeem.len(), &pop_step, 0, ctx_step, flags, &mass_calc, &cofactors,
            );
            assert!(16 * fee_per_buyer >= rec_p256_non_term.relay_floor);
            resource_table.push(rec_p256_non_term);
        } else if is_terminal {
            let (rec_p256_term, _) = measure_and_verify_transition(
                "REFUND P=256 terminal", cur_redeem.len(), &pop_step, 0, ctx_step, flags, &mass_calc, &cofactors,
            );
            assert!(16 * fee_per_buyer >= rec_p256_term.relay_floor);
            resource_table.push(rec_p256_term);
        } else {
            let limit = tx_step.inputs[0].compute_commit.allowed_script_units();
            let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
                &pop_step, &pop_step.tx.inputs[0], 0, &pop_step.entries[0], ctx_step, flags, limit,
            );
            assert_eq!(vm.execute(), Ok(()));
        }

        current_tx_id = tx_step.id();
        current_pool = next_pool;
        current_cursor += k;
    }
    println!("  -> P=256 connected 16-step refund chain PASS: all 16 transactions executed Ok(())!");

    // =========================================================================
    // PART 4: P=0 EMPTY ROUND DIRECT TERMINAL RECOVERY & NEGATIVES
    // =========================================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 4: P=0 EMPTY ROUND DIRECT TERMINAL RECOVERY & NEGATIVES");
    println!("------------------------------------------------------------------");

    let round_id_p0 = Hash::from_u64_word(0x888);
    let cov_id_p0 = Hash::from_u64_word(0x999);
    let empty_root = compute_empty_root_27();

    let empty_open_redeem = build_directory_open_covenant(
        round_id_p0, ticket_price, ticket_cap, min_tickets, sale_deadline,
        0, 0, empty_root, creator_refund_script.clone(), &[],
    ).unwrap();
    let empty_open_spk = pay_to_script_hash_script(&empty_open_redeem);

    let sponsor_p0_keypair = secp256k1::Keypair::from_seckey_slice(secp256k1::SECP256K1, &[0x88; 32]).unwrap();
    let mut sponsor_p0_p2pk = vec![0x20];
    sponsor_p0_p2pk.extend_from_slice(&sponsor_p0_keypair.x_only_public_key().0.serialize());
    sponsor_p0_p2pk.push(0xac);

    let sponsor_funding_p0 = 10_000_000u64;

    let mut tx_empty = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x801), 0),
                {
                    let mut sb = ScriptBuilder::with_flags(flags);
                    sb.add_i64(ACTION_CLOSE).unwrap();
                    sb.add_data(&empty_open_redeem).unwrap();
                    sb.drain()
                },
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(40)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x802), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: state_deposit, // 100% exact return!
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_script.clone()),
                covenant: None,
            },
            TransactionOutput {
                value: 0,
                script_public_key: ScriptPublicKey::from_vec(0, sponsor_p0_p2pk.clone()),
                covenant: None,
            },
        ],
        sale_deadline, SubnetworkId::default(), 0, vec![],
    );

    let non_empty = mass_calc.calc_non_contextual_masses(&tx_empty);
    let floor_empty = ((non_empty.compute_mass.max(non_empty.normalized_transient(&cofactors))) * 100_000 / 1000).max(100_000);
    let actual_fee_p0 = floor_empty + 50_000;
    let sponsor_change_p0 = sponsor_funding_p0 - actual_fee_p0;
    tx_empty.outputs[1].value = sponsor_change_p0;

    let entries_empty = vec![
        UtxoEntry::new(state_deposit, empty_open_spk.clone(), 1_000_000, false, Some(cov_id_p0)),
        UtxoEntry::new(sponsor_funding_p0, ScriptPublicKey::from_vec(0, sponsor_p0_p2pk.clone()), 1_000_000, false, None),
    ];
    sign_p2pk_input(&mut tx_empty, 1, &sponsor_p0_keypair, &entries_empty);

    let pop_empty = PopulatedTransaction::new(&tx_empty, entries_empty);
    let cov_empty = CovenantsContext::from_tx(&pop_empty).unwrap();
    let ctx_empty = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_empty);

    let (rec_empty, _) = measure_and_verify_transition(
        "EMPTY CLOSE terminal", empty_open_redeem.len(), &pop_empty, 0, ctx_empty, flags, &mass_calc, &cofactors,
    );
    assert!(actual_fee_p0 >= rec_empty.relay_floor);
    resource_table.push(rec_empty.clone());
    println!("  -> EMPTY CLOSE PASS: 100% deposit returned, lineage terminated, fee = {} >= relay_floor {}", actual_fee_p0, rec_empty.relay_floor);

    // Minimal Negative Tests for P=0:
    // 4.1: P=0 attempting to enter REFUNDING successor -> MUST FAIL
    let ref_redeem_p0 = build_compact_universal_refunding_covenant(
        round_id_p0, ticket_price, 0, 0, creator_refund_script.clone(), vec![],
    );
    let ref_spk_p0 = pay_to_script_hash_script(&ref_redeem_p0);
    let tx_p0_ref_attack = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(0x801), 0),
            {
                let mut sb = ScriptBuilder::with_flags(flags);
                sb.add_i64(ACTION_CLOSE).unwrap();
                sb.add_data(&empty_open_redeem).unwrap();
                sb.drain()
            },
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(10)),
        )],
        vec![TransactionOutput {
            value: state_deposit,
            script_public_key: ref_spk_p0.clone(),
            covenant: Some(CovenantBinding { covenant_id: cov_id_p0, authorizing_input: 0 }),
        }],
        sale_deadline, SubnetworkId::default(), 0, vec![],
    );
    let pop_p0_ref_attack = PopulatedTransaction::new(&tx_p0_ref_attack, vec![
        UtxoEntry::new(state_deposit, empty_open_spk.clone(), 1_000_000, false, Some(cov_id_p0)),
    ]);
    let cov_ctx_p0_ref = CovenantsContext::from_tx(&pop_p0_ref_attack).unwrap();
    let ctx_p0_ref = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_p0_ref);
    let mut vm_p0_ref = TxScriptEngine::from_transaction_input(
        &pop_p0_ref_attack, &pop_p0_ref_attack.tx.inputs[0], 0, &pop_p0_ref_attack.entries[0], ctx_p0_ref, flags,
    );
    assert!(vm_p0_ref.execute().is_err());
    println!("  -> NEGATIVE PASS [4.1]: P=0 attempting to output REFUNDING successor strictly REJECTED!");

    // 4.2: Creator output amount theft (-1 sompi) -> MUST FAIL
    let mut tx_p0_theft = tx_empty.clone();
    tx_p0_theft.outputs[0].value = state_deposit - 1;
    let pop_p0_theft = PopulatedTransaction::new(&tx_p0_theft, vec![
        UtxoEntry::new(state_deposit, empty_open_spk.clone(), 1_000_000, false, Some(cov_id_p0)),
        UtxoEntry::new(sponsor_funding_p0, ScriptPublicKey::from_vec(0, sponsor_p0_p2pk.clone()), 1_000_000, false, None),
    ]);
    let cov_ctx_theft = CovenantsContext::from_tx(&pop_p0_theft).unwrap();
    let ctx_theft = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_theft);
    let mut vm_p0_theft = TxScriptEngine::from_transaction_input(
        &pop_p0_theft, &pop_p0_theft.tx.inputs[0], 0, &pop_p0_theft.entries[0], ctx_theft, flags,
    );
    assert!(vm_p0_theft.execute().is_err());
    println!("  -> NEGATIVE PASS [4.2]: Creator deposit theft (-1 sompi) strictly REJECTED by OpEqualVerify!");

    // 4.3: Creator SPK mismatch -> MUST FAIL
    let mut tx_p0_spk_m = tx_empty.clone();
    tx_p0_spk_m.outputs[0].script_public_key = ScriptPublicKey::from_vec(0, vec![0x20, 0x99, 0xac]);
    let pop_p0_spk_m = PopulatedTransaction::new(&tx_p0_spk_m, vec![
        UtxoEntry::new(state_deposit, empty_open_spk.clone(), 1_000_000, false, Some(cov_id_p0)),
        UtxoEntry::new(sponsor_funding_p0, ScriptPublicKey::from_vec(0, sponsor_p0_p2pk.clone()), 1_000_000, false, None),
    ]);
    let cov_ctx_spk_m = CovenantsContext::from_tx(&pop_p0_spk_m).unwrap();
    let ctx_spk_m = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_spk_m);
    let mut vm_p0_spk_m = TxScriptEngine::from_transaction_input(
        &pop_p0_spk_m, &pop_p0_spk_m.tx.inputs[0], 0, &pop_p0_spk_m.entries[0], ctx_spk_m, flags,
    );
    assert!(vm_p0_spk_m.execute().is_err());
    println!("  -> NEGATIVE PASS [4.3]: Creator SPK mismatch strictly REJECTED by OpEqualVerify!");

    // 4.4: Hidden same-C continuation on Output 1 -> MUST FAIL
    let mut tx_p0_hidden = tx_empty.clone();
    tx_p0_hidden.outputs[1].covenant = Some(CovenantBinding { covenant_id: cov_id_p0, authorizing_input: 0 });
    let pop_p0_hidden = PopulatedTransaction::new(&tx_p0_hidden, vec![
        UtxoEntry::new(state_deposit, empty_open_spk.clone(), 1_000_000, false, Some(cov_id_p0)),
        UtxoEntry::new(sponsor_funding_p0, ScriptPublicKey::from_vec(0, sponsor_p0_p2pk.clone()), 1_000_000, false, None),
    ]);
    let cov_ctx_hidden = CovenantsContext::from_tx(&pop_p0_hidden).unwrap();
    let ctx_hidden = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_hidden);
    let mut vm_p0_hidden = TxScriptEngine::from_transaction_input(
        &pop_p0_hidden, &pop_p0_hidden.tx.inputs[0], 0, &pop_p0_hidden.entries[0], ctx_hidden, flags,
    );
    assert!(vm_p0_hidden.execute().is_err());
    println!("  -> NEGATIVE PASS [4.4]: Hidden same-C continuation strictly REJECTED by OpCovOutputCount == 0!");

    // =========================================================================
    // PART 5: 10-ROW FINAL PRODUCTION RESOURCE TABLE
    // =========================================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 5: FINAL PRODUCTION RESOURCE MEASUREMENTS TABLE (10 TRANSITIONS)");
    println!("------------------------------------------------------------------");
    println!("{:<28} | {:>8} | {:>8} | {:>8} | {:>11} | {:>9} | {:>7} | {:>7} | {:>7} | {:>7} | {:>7} | {:>13}",
        "Transition", "Redeem", "SigScr", "TxSize", "ScriptUnits", "Budget", "Compute", "Trans", "NormTr", "Storage", "FeeMass", "Relay Floor");
    println!("{}", "-".repeat(146));

    for r in &resource_table {
        println!("{:<28} | {:>7}B | {:>7}B | {:>7}B | {:>11} | {:>9?} | {:>7} | {:>7} | {:>7} | {:>7} | {:>7} | {:>10} sompi",
            r.transition_name, r.redeem_bytes, r.sigscript_bytes, r.tx_bytes, r.script_units, r.b_min,
            r.compute_mass, r.transient_mass, r.normalized_transient, r.storage_mass, r.fee_mass, r.relay_floor);
    }
    println!("{}", "-".repeat(146));

    println!("\n==================================================================");
    println!("ALL KASWIN V1 PRODUCTION FULL LIFECYCLE E2E TESTS PASSED 100%!");
    println!("==================================================================");
}
