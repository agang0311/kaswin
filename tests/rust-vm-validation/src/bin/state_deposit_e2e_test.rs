use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::tx::{
    ComputeCommit, Transaction, TransactionInput, TransactionOutput, TransactionOutpoint, UtxoEntry, CovenantBinding,
};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::mass::ComputeBudget;
use kaspa_hashes::Hash;
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    script_builder::ScriptBuilder,
    standard::pay_to_script_hash_script,
    SeqCommitAccessor,
};
use kaspa_txscript_errors::TxScriptError;

#[path = "../../../../contracts/v1_constants.rs"]
pub mod v1_constants;
use v1_constants::{DELTA_DAA_V1, FULL_SALE_RECOVERY_DELAY_DAA_V1};

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_levels, compute_payout_commitment, compute_purchase_leaf, compute_root_from_path, TREE_DEPTH,
};

#[path = "../../../../contracts/refunding_covenant.rs"]
pub mod refunding_covenant;
use refunding_covenant::build_refunding_covenant;

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;
use winner_ready_settlement::build_production_winner_ready_covenant;

#[path = "../../../../contracts/winner_selection.rs"]
pub mod winner_selection;
use winner_selection::{
    build_draw_ready_covenant, reference_winner_step, WinnerStepResult,
};

#[path = "../../../../contracts/sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::{
    build_production_sealed_covenant_v1,
    compute_application_commitment, compute_random_seed,
    ACTION_DRAW, ACTION_FULL_REFUND,
};

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::{build_open_covenant, ACTION_BUY, ACTION_BEGIN_REFUND};

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::build_canonical_kaswin_genesis_output;

// Mock SeqCommit Accessor for PASS-A verification
struct MockAccessor {
    target_hash: Hash,
    target_merkle: Hash,
    within_depth: bool,
}

impl SeqCommitAccessor for MockAccessor {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        if block_hash == self.target_hash {
            Some(true)
        } else {
            Some(false)
        }
    }

    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        if block_hash == self.target_hash && self.within_depth {
            Some(self.target_merkle)
        } else {
            None
        }
    }
}

fn reference_check_tx_finalized_in_daa_context(tx: &Transaction, block_daa_score: u64) -> Result<(), &'static str> {
    if tx.lock_time < block_daa_score {
        return Ok(());
    }
    for input in tx.inputs.iter() {
        if input.sequence != u64::MAX {
            return Err("Transaction not finalized in header context: lock_time not reached and inputs not max sequence");
        }
    }
    Ok(())
}

fn main() {
    println!("==================================================================");
    println!("KASWIN V1 STATE DEPOSIT ECONOMIC MODEL E2E VERIFICATION SUITE");
    println!("==================================================================");

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    // -------------------------------------------------------------
    // SETUP ECONOMIC PARAMETERS (0.5 KAS deposit, 1 KAS ticket, 100 tickets)
    // -------------------------------------------------------------
    let state_deposit = 50_000_000u64;  // 0.5 KAS protocol state deposit
    let ticket_price  = 100_000_000u64; // 1.0 KAS per ticket
    let total_tickets = 100u64;         // 100 total tickets
    let refund_lock_daa = 1_500_000u64;

    let ticket_principal = ticket_price * total_tickets; // 100 KAS = 10_000_000_000 sompi
    let full_sale_pool = state_deposit + ticket_principal; // 100.5 KAS = 10_050_000_000 sompi

    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(0xabc123), 0);
    let round_id = genesis::compute_canonical_round_id(&funding_outpoint);

    let mut creator_refund_spk = vec![0x00, 0x00, 0x20];
    creator_refund_spk.extend(vec![0xcc; 32]);
    creator_refund_spk.push(0xac);

    // Prefix length invariants:
    assert_eq!(winner_selection::draw_ready_prefix_len(creator_refund_spk.len()), 190);
    assert_eq!(winner_selection::draw_ready_prefix_len(creator_refund_spk.len()) + winner_selection::COUNTER_PUSH_LEN, 199);
    println!("  -> DRAW_READY Immutable Prefix Len: 190 bytes; Complete Prefix with Counter: 199 bytes");

    let (_genesis_output_0, covenant_id_c) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
        state_deposit,
    ).unwrap();

    println!("Genesis Covenant ID C: {}", covenant_id_c);
    println!("State Deposit:         {} sompi (0.5 KAS)", state_deposit);
    println!("Ticket Principal:      {} sompi (100.0 KAS)", ticket_principal);
    println!("Full Pool (Input 0):   {} sompi (100.5 KAS)", full_sale_pool);

    // Setup 2 Purchases:
    // Buyer 0: buys 40 tickets (tickets 0..40, purchase_index = 0)
    // Buyer 1: buys 60 tickets (tickets 40..100, purchase_index = 1) -> Sells out round!
    let empty_levels = compute_empty_levels();

    let mut buyer_spk_0 = vec![0x00, 0x00, 0x20];
    buyer_spk_0.extend(vec![0x11; 32]);
    buyer_spk_0.push(0xac);
    let count_0 = 40u64;

    let mut siblings_0 = [Hash::default(); TREE_DEPTH];
    for i in 0..TREE_DEPTH { siblings_0[i] = empty_levels[i]; }
    let payout_comm_0 = compute_payout_commitment(&buyer_spk_0);
    let leaf_0 = compute_purchase_leaf(&round_id, 0, 0, count_0, &payout_comm_0);
    let root_0 = compute_root_from_path(&leaf_0, 0, &siblings_0);

    // State after Buyer 0: sold = 40, pc = 1, ticket_root = root_0
    // Pool amount = state_deposit + 40 KAS = 40_500_000_000 sompi
    let pool_amt_40 = state_deposit + ticket_price * count_0;
    let open_redeem_1 = build_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        count_0,
        1,
        root_0,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();
    let open_spk_1 = pay_to_script_hash_script(&open_redeem_1);

    // Buyer 1 (Final Buyer):
    let mut buyer_spk_1 = vec![0x00, 0x00, 0x20];
    buyer_spk_1.extend(vec![0x22; 32]);
    buyer_spk_1.push(0xac);
    let count_1 = 60u64;

    let mut siblings_1 = [Hash::default(); TREE_DEPTH];
    siblings_1[0] = leaf_0;
    for i in 1..TREE_DEPTH { siblings_1[i] = empty_levels[i]; }
    let payout_comm_1 = compute_payout_commitment(&buyer_spk_1);
    let leaf_1 = compute_purchase_leaf(&round_id, 1, 40, count_1, &payout_comm_1);
    let final_root = compute_root_from_path(&leaf_1, 1, &siblings_1);
    let final_pc = 2u64;

    // Expected production SEALED V1 successor:
    let sealed_redeem = build_production_sealed_covenant_v1(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        final_pc,
        creator_refund_spk.clone(),
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);

    // =============================================================
    // PART 1: NORMAL DRAW FULL PIPELINE (Final BUY -> SEALED -> DRAW_READY -> WINNER_READY -> PAID)
    // =============================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 1: NORMAL DRAW FULL PIPELINE WITH STATE DEPOSIT REFUND");
    println!("------------------------------------------------------------------");

    // 1.1 Final BUY -> SEALED
    let mut sig_sb_fb = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_fb.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_fb.add_data(&buyer_spk_1).unwrap();
    sig_sb_fb.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_fb.add_i64(ACTION_BUY).unwrap();
    sig_sb_fb.add_data(&open_redeem_1).unwrap();
    let sig_script_fb = sig_sb_fb.drain();

    let tx_final_buy = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(1), 0),
            sig_script_fb,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: full_sale_pool, // 100.5 KAS
            script_public_key: sealed_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_fb = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_final_buy, vec![
        UtxoEntry::new(pool_amt_40, open_spk_1.clone(), 1_000_000, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_fb = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_fb).unwrap();
    let ctx_fb = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_fb);
    let mut vm_fb = TxScriptEngine::from_transaction_input(&pop_fb, &pop_fb.tx.inputs[0], 0, &pop_fb.entries[0], ctx_fb, flags);
    assert_eq!(vm_fb.execute(), Ok(()));
    let u_fb = vm_fb.used_script_units();
    let b_min_fb = ComputeBudget::checked_covering_script_units(u_fb).unwrap();
    println!("  [Step 1.1] Final BUY -> SEALED (Pool: 100.5 KAS) PASS! [Units: {:?}, B_min: {:?}]", u_fb, b_min_fb);

    // 1.2 SEALED -> DRAW_READY(0) via PASS-A
    let d0 = 1_000_000u64;
    let boundary = d0 + DELTA_DAA_V1;

    let p_daa_num = boundary - 1;
    let t_daa_num = boundary;
    let p_sp_ts = 1_700_000_000u64.to_le_bytes();
    let p_daa = p_daa_num.to_le_bytes();
    let p_blue = (p_daa_num - 100).to_le_bytes();
    let key_ctx = b"SeqCommitMergesetContext";
    let key_branch = b"SeqCommitmentMerkleBranchHash";
    let mut key_ctx_arr = [0u8; 32]; key_ctx_arr[..key_ctx.len()].copy_from_slice(key_ctx);
    let mut key_branch_arr = [0u8; 32]; key_branch_arr[..key_branch.len()].copy_from_slice(key_branch);

    let mut p_ctx_in = Vec::new();
    p_ctx_in.extend_from_slice(&p_sp_ts); p_ctx_in.extend_from_slice(&p_daa); p_ctx_in.extend_from_slice(&p_blue);
    let p_ctx = blake3::keyed_hash(&key_ctx_arr, &p_ctx_in);

    let p_payload = Hash::from_u64_word(101);
    let mut p_pd_in = Vec::new();
    p_pd_in.extend_from_slice(p_ctx.as_bytes()); p_pd_in.extend_from_slice(&p_payload.as_bytes());
    let p_pd = blake3::keyed_hash(&key_branch_arr, &p_pd_in);

    let p_activity = Hash::from_u64_word(102);
    let mut p_sr_in = Vec::new();
    p_sr_in.extend_from_slice(&p_activity.as_bytes()); p_sr_in.extend_from_slice(p_pd.as_bytes());
    let p_sr = blake3::keyed_hash(&key_branch_arr, &p_sr_in);

    let p_parent_seq = Hash::from_u64_word(103);
    let mut c_p_in = Vec::new();
    c_p_in.extend_from_slice(&p_parent_seq.as_bytes()); c_p_in.extend_from_slice(p_sr.as_bytes());
    let c_p = blake3::keyed_hash(&key_branch_arr, &c_p_in);

    let target_sp_ts = (1_700_000_000u64 + 10).to_le_bytes();
    let target_daa = t_daa_num.to_le_bytes();
    let target_blue = (t_daa_num - 100).to_le_bytes();
    let mut t_ctx_in = Vec::new();
    t_ctx_in.extend_from_slice(&target_sp_ts); t_ctx_in.extend_from_slice(&target_daa); t_ctx_in.extend_from_slice(&target_blue);
    let t_ctx = blake3::keyed_hash(&key_ctx_arr, &t_ctx_in);

    let target_payload = Hash::from_u64_word(201);
    let mut t_pd_in = Vec::new();
    t_pd_in.extend_from_slice(t_ctx.as_bytes()); t_pd_in.extend_from_slice(&target_payload.as_bytes());
    let t_pd = blake3::keyed_hash(&key_branch_arr, &t_pd_in);

    let target_activity = Hash::from_u64_word(202);
    let mut t_sr_in = Vec::new();
    t_sr_in.extend_from_slice(&target_activity.as_bytes()); t_sr_in.extend_from_slice(t_pd.as_bytes());
    let t_sr = blake3::keyed_hash(&key_branch_arr, &t_sr_in);

    let mut c_t_in = Vec::new();
    c_t_in.extend_from_slice(c_p.as_bytes()); c_t_in.extend_from_slice(t_sr.as_bytes());
    let c_t = blake3::keyed_hash(&key_branch_arr, &c_t_in);
    let target_merkle = Hash::from_bytes(*c_t.as_bytes());
    let target_hash = Hash::from_u64_word(999);

    let mut sig_sb_draw = ScriptBuilder::with_flags(flags);
    sig_sb_draw.add_data(&target_hash.as_bytes()).unwrap();
    sig_sb_draw.add_data(&target_activity.as_bytes()).unwrap();
    sig_sb_draw.add_data(&target_payload.as_bytes()).unwrap();
    sig_sb_draw.add_data(&target_sp_ts).unwrap();
    sig_sb_draw.add_data(&target_daa).unwrap();
    sig_sb_draw.add_data(&target_blue).unwrap();
    sig_sb_draw.add_data(&p_parent_seq.as_bytes()).unwrap();
    sig_sb_draw.add_data(&p_activity.as_bytes()).unwrap();
    sig_sb_draw.add_data(&p_payload.as_bytes()).unwrap();
    sig_sb_draw.add_data(&p_sp_ts).unwrap();
    sig_sb_draw.add_data(&p_daa).unwrap();
    sig_sb_draw.add_data(&p_blue).unwrap();
    sig_sb_draw.add_i64(ACTION_DRAW).unwrap();
    sig_sb_draw.add_data(&sealed_redeem).unwrap();
    let sig_script_draw = sig_sb_draw.drain();

    let app_comm = compute_application_commitment(&round_id, &final_root, total_tickets);
    let random_seed = compute_random_seed(&target_hash, &app_comm);

    let draw_ready_redeem_0 = build_draw_ready_covenant(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        target_hash,
        random_seed,
        creator_refund_spk.clone(),
        0,
    ).unwrap();
    let draw_ready_spk_0 = pay_to_script_hash_script(&draw_ready_redeem_0);

    let tx_draw = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_final_buy.id(), 0),
            sig_script_draw,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: full_sale_pool, // 100.5 KAS
            script_public_key: draw_ready_spk_0.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_draw = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_draw, vec![
        UtxoEntry::new(full_sale_pool, sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_draw = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_draw).unwrap();
    let mock_accessor = MockAccessor { target_hash, target_merkle, within_depth: true };
    let ctx_draw = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_draw).with_seq_commit_accessor(&mock_accessor);
    let mut vm_draw = TxScriptEngine::from_transaction_input(&pop_draw, &pop_draw.tx.inputs[0], 0, &pop_draw.entries[0], ctx_draw, flags);
    assert_eq!(vm_draw.execute(), Ok(()));
    let u_draw = vm_draw.used_script_units();
    let b_min_draw = ComputeBudget::checked_covering_script_units(u_draw).unwrap();
    println!("  [Step 1.2] SEALED -> DRAW_READY(0) (Pool: 100.5 KAS) PASS! [Units: {:?}, B_min: {:?}]", u_draw, b_min_draw);

    // 1.3 DRAW_READY(0) -> WINNER_READY
    let step_res = reference_winner_step(total_tickets, &random_seed, 0);
    let winner_index = match step_res {
        WinnerStepResult::Accepted { winner_index } => winner_index,
        WinnerStepResult::Rejected { .. } => panic!("Expected acceptance at counter 0 for this seed"),
    };
    println!("  [Step 1.3] Random Seed yielded Winner Index: {} (in range [0, 100))", winner_index);

    let winner_ready_redeem = build_production_winner_ready_covenant(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        target_hash,
        random_seed,
        creator_refund_spk.clone(),
        winner_index,
    ).unwrap();
    let winner_ready_spk = pay_to_script_hash_script(&winner_ready_redeem);

    // Transition transaction from DRAW_READY(0) to WINNER_READY:
    let mut sig_sb_dr = ScriptBuilder::with_flags(flags);
    sig_sb_dr.add_data(&draw_ready_redeem_0).unwrap();
    let sig_script_dr = sig_sb_dr.drain();

    let tx_win_transition = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_draw.id(), 0),
            sig_script_dr,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: full_sale_pool, // 100.5 KAS
            script_public_key: winner_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_wt = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_win_transition, vec![
        UtxoEntry::new(full_sale_pool, draw_ready_spk_0.clone(), d0 + 1, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_wt = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_wt).unwrap();
    let ctx_wt = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_wt);
    let mut vm_wt = TxScriptEngine::from_transaction_input(&pop_wt, &pop_wt.tx.inputs[0], 0, &pop_wt.entries[0], ctx_wt, flags);
    assert_eq!(vm_wt.execute(), Ok(()));
    let u_wt = vm_wt.used_script_units();
    let b_min_wt = ComputeBudget::checked_covering_script_units(u_wt).unwrap();
    println!("  [Step 1.3] DRAW_READY(0) -> WINNER_READY({}) PASS! [Units: {:?}, B_min: {:?}]", winner_index, u_wt, b_min_wt);

    // 1.4 WINNER_READY -> PAID (Atomic Principal to Winner + State Deposit to Creator)
    // Identify winning purchase:
    let (winner_spk, winner_start, winner_count, winner_purchase_index, winner_siblings) = if winner_index < 40 {
        // Buyer 0 is the winner:
        let mut sibs = [Hash::default(); TREE_DEPTH];
        sibs[0] = leaf_1;
        for i in 1..TREE_DEPTH { sibs[i] = empty_levels[i]; }
        (buyer_spk_0.clone(), 0u64, count_0, 0u64, sibs)
    } else {
        // Buyer 1 is the winner:
        (buyer_spk_1.clone(), 40u64, count_1, 1u64, siblings_1)
    };

    let mut sig_sb_settle = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_settle.add_data(&winner_siblings[i].as_bytes()).unwrap(); }
    sig_sb_settle.add_data(&winner_spk).unwrap();
    sig_sb_settle.add_data(&winner_count.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&winner_start.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&winner_purchase_index.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&winner_ready_redeem).unwrap();
    let sig_script_settle = sig_sb_settle.drain();

    let winner_out_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, winner_spk[2..].to_vec());
    let creator_out_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec());

    let tx_settlement = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_win_transition.id(), 0),
            sig_script_settle.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            // Output 0: 100% Principal to Winner (100 KAS = 10_000_000_000 sompi)
            TransactionOutput {
                value: ticket_principal,
                script_public_key: winner_out_spk.clone(),
                covenant: None, // Lineage terminates!
            },
            // Output 1: 100% State Deposit to Creator (0.5 KAS = 50_000_000 sompi)
            TransactionOutput {
                value: state_deposit,
                script_public_key: creator_out_spk.clone(),
                covenant: None, // Lineage terminates!
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );

    let pop_settle = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_settlement, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_settle = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_settle).unwrap();
    let ctx_settle = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_settle);
    let mut vm_settle = TxScriptEngine::from_transaction_input(&pop_settle, &pop_settle.tx.inputs[0], 0, &pop_settle.entries[0], ctx_settle, flags);
    assert_eq!(vm_settle.execute(), Ok(()));
    let u_settle = vm_settle.used_script_units();
    let b_min_settle = ComputeBudget::checked_covering_script_units(u_settle).unwrap();
    println!("  [Step 1.4] WINNER_READY -> PAID (Winner: 100 KAS, Creator: 0.5 KAS) PASS!");
    println!("             [Used Script Units: {:?}, Minimum Bounded Budget B_min: {:?}]", u_settle, b_min_settle);

    // Bounded budget test for WINNER_READY -> PAID:
    {
        let mut tx_bmin = tx_settlement.clone();
        tx_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_settle);
        let pop_bmin = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_bmin, vec![
            UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
        ]);
        let cov_ctx = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_bmin, &pop_bmin.tx.inputs[0], 0, &pop_bmin.entries[0], ctx, flags,
            tx_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()));

        let mut tx_tight = tx_settlement.clone();
        tx_tight.inputs[0].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(b_min_settle.0 - 1));
        let pop_tight = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_tight, vec![
            UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
        ]);
        let cov_ctx_t = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_tight).unwrap();
        let ctx_t = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_t);
        let mut vm_t = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_tight, &pop_tight.tx.inputs[0], 0, &pop_tight.entries[0], ctx_t, flags,
            tx_tight.inputs[0].compute_commit.allowed_script_units(),
        );
        assert!(matches!(vm_t.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })));
        println!("  -> PASS: Bounded compute budget verified (passes at B_min, strictly rejected at B_min-1)!");
    }

    // =============================================================
    // PART 2: NEGATIVE ATTACK MATRIX ON SETTLEMENT (A - F)
    // =============================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 2: NEGATIVE ATTACK MATRIX ON SETTLEMENT (A - F)");
    println!("------------------------------------------------------------------");

    // Attack A: Winner attempts to claim entire 100.5 KAS (stealing deposit)
    let mut tx_att_a = tx_settlement.clone();
    tx_att_a.outputs = vec![TransactionOutput {
        value: full_sale_pool, // 100.5 KAS
        script_public_key: winner_out_spk.clone(),
        covenant: None,
    }];
    let pop_a = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_att_a, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_a = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_a).unwrap();
    let ctx_a = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_a);
    let mut vm_a = TxScriptEngine::from_transaction_input(&pop_a, &pop_a.tx.inputs[0], 0, &pop_a.entries[0], ctx_a, flags);
    assert!(vm_a.execute().is_err());
    println!("  [Attack A] Winner claiming 100.5 KAS (stealing deposit) -> BLOCKED!");

    // Attack B: Creator deposit underpaid by 1 sompi
    let mut tx_att_b = tx_settlement.clone();
    tx_att_b.outputs[1].value = state_deposit - 1;
    let pop_b = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_att_b, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_b = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_b).unwrap();
    let ctx_b = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_b);
    let mut vm_b = TxScriptEngine::from_transaction_input(&pop_b, &pop_b.tx.inputs[0], 0, &pop_b.entries[0], ctx_b, flags);
    assert!(vm_b.execute().is_err());
    println!("  [Attack B] Creator deposit underpaid by 1 sompi -> BLOCKED!");

    // Attack C: Creator refund SPK replaced by attacker SPK
    let mut tx_att_c = tx_settlement.clone();
    tx_att_c.outputs[1].script_public_key = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, vec![0xaa; 34]);
    let pop_c = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_att_c, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_c = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_c).unwrap();
    let ctx_c = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_c);
    let mut vm_c = TxScriptEngine::from_transaction_input(&pop_c, &pop_c.tx.inputs[0], 0, &pop_c.entries[0], ctx_c, flags);
    assert!(vm_c.execute().is_err());
    println!("  [Attack C] Creator refund SPK replaced by attacker SPK -> BLOCKED!");

    // Attack D: Winner underpaid by 1 sompi / Creator overpaid by 1 sompi
    let mut tx_att_d = tx_settlement.clone();
    tx_att_d.outputs[0].value = ticket_principal - 1;
    tx_att_d.outputs[1].value = state_deposit + 1;
    let pop_d = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_att_d, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_d = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_d).unwrap();
    let ctx_d = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_d);
    let mut vm_d = TxScriptEngine::from_transaction_input(&pop_d, &pop_d.tx.inputs[0], 0, &pop_d.entries[0], ctx_d, flags);
    assert!(vm_d.execute().is_err());
    println!("  [Attack D] Winner underpaid by 1 / Creator overpaid by 1 -> BLOCKED!");

    // Attack E: Winner overpaid by 1 sompi / Creator underpaid by 1 sompi
    let mut tx_att_e = tx_settlement.clone();
    tx_att_e.outputs[0].value = ticket_principal + 1;
    tx_att_e.outputs[1].value = state_deposit - 1;
    let pop_e = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_att_e, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_e = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_e).unwrap();
    let ctx_e = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_e);
    let mut vm_e = TxScriptEngine::from_transaction_input(&pop_e, &pop_e.tx.inputs[0], 0, &pop_e.entries[0], ctx_e, flags);
    assert!(vm_e.execute().is_err());
    println!("  [Attack E] Winner overpaid by 1 / Creator underpaid by 1 -> BLOCKED!");

    // Attack F: Output 1 carries covenant C (attempt to keep lineage alive)
    let mut tx_att_f = tx_settlement.clone();
    tx_att_f.outputs[1].covenant = Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 });
    let pop_f = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_att_f, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_f = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_f).unwrap();
    let ctx_f = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_f);
    let mut vm_f = TxScriptEngine::from_transaction_input(&pop_f, &pop_f.tx.inputs[0], 0, &pop_f.entries[0], ctx_f, flags);
    assert!(vm_f.execute().is_err());
    println!("  [Attack F] Output 1 carrying covenant C -> BLOCKED by terminal lineage guard!");

    // Attack G: Winner Output 0 carries foreign covenant D (attempt to escape Covenant=None)
    let foreign_cov_d = Hash::from_u64_word(0xdeadbeef);
    let mut tx_att_g = tx_settlement.clone();
    tx_att_g.outputs[0].covenant = Some(CovenantBinding { covenant_id: foreign_cov_d, authorizing_input: 0 });
    let pop_g = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_att_g, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let res_cov_g = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_g);
    assert!(res_cov_g.is_err(), "Foreign covenant D on Output 0 MUST be blocked by consensus CovenantsContext!");
    println!("  [Attack G] Winner Output 0 carrying foreign covenant D -> BLOCKED by consensus CovenantsContext!");

    // Attack H: Creator Output 1 carries foreign covenant D (attempt to escape Covenant=None)
    let mut tx_att_h = tx_settlement.clone();
    tx_att_h.outputs[1].covenant = Some(CovenantBinding { covenant_id: foreign_cov_d, authorizing_input: 0 });
    let pop_h = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_att_h, vec![
        UtxoEntry::new(full_sale_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);
    let res_cov_h = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_h);
    assert!(res_cov_h.is_err(), "Foreign covenant D on Output 1 MUST be blocked by consensus CovenantsContext!");
    println!("  [Attack H] Creator Output 1 carrying foreign covenant D -> BLOCKED by consensus CovenantsContext!");

    // =============================================================
    // PART 3: FULL-SALE TIMEOUT REFUND REGRESSION
    // =============================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 3: FULL-SALE TIMEOUT REFUND REGRESSION");
    println!("------------------------------------------------------------------");

    let refund_redeem_c0 = build_refunding_covenant(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        creator_refund_spk.clone(),
        final_pc,
        0, // cursor = 0
        total_tickets, // rem = 100
    ).unwrap();
    let refund_spk_c0 = pay_to_script_hash_script(&refund_redeem_c0);

    let mut sig_sb_fr = ScriptBuilder::with_flags(flags);
    sig_sb_fr.add_i64(ACTION_FULL_REFUND).unwrap();
    sig_sb_fr.add_data(&sealed_redeem).unwrap();
    let sig_script_fr = sig_sb_fr.drain();

    let tx_full_refund = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_final_buy.id(), 0),
            sig_script_fr,
            FULL_SALE_RECOVERY_DELAY_DAA_V1,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: full_sale_pool, // 100.5 KAS
            script_public_key: refund_spk_c0.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_fr = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_full_refund, vec![
        UtxoEntry::new(full_sale_pool, sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_fr = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_fr).unwrap();
    let ctx_fr = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_fr);
    let mut vm_fr = TxScriptEngine::from_transaction_input(&pop_fr, &pop_fr.tx.inputs[0], 0, &pop_fr.entries[0], ctx_fr, flags);
    assert_eq!(vm_fr.execute(), Ok(()));
    println!("  [Step 3.1] SEALED -> REFUNDING(cursor=0, rem=100) (Pool: 100.5 KAS) PASS!");

    // Refund Step 1: Refund Buyer 0 (40 tickets, 40 KAS)
    let refund_redeem_c1 = build_refunding_covenant(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        creator_refund_spk.clone(),
        final_pc,
        1,  // cursor = 1
        60, // rem = 60
    ).unwrap();
    let refund_spk_c1 = pay_to_script_hash_script(&refund_redeem_c1);

    let mut sibs_0_tree = [Hash::default(); TREE_DEPTH];
    sibs_0_tree[0] = leaf_1;
    for i in 1..TREE_DEPTH { sibs_0_tree[i] = empty_levels[i]; }

    let mut sig_sb_r1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r1.add_data(&sibs_0_tree[i].as_bytes()).unwrap(); }
    sig_sb_r1.add_data(&buyer_spk_0).unwrap();
    sig_sb_r1.add_data(&count_0.to_le_bytes()).unwrap();
    sig_sb_r1.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_r1.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_r1.add_data(&refund_redeem_c0).unwrap();
    let sig_script_r1 = sig_sb_r1.drain();

    let pool_rem_60 = full_sale_pool - ticket_price * count_0; // 60.5 KAS

    let tx_r1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_full_refund.id(), 0),
            sig_script_r1,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: pool_rem_60, // 60.5 KAS
                script_public_key: refund_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ticket_price * count_0, // 40 KAS back to Buyer 0!
                script_public_key: kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_0[2..].to_vec()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_r1 = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_r1, vec![
        UtxoEntry::new(full_sale_pool, refund_spk_c0.clone(), d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_r1 = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_r1).unwrap();
    let ctx_r1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_r1);
    let mut vm_r1 = TxScriptEngine::from_transaction_input(&pop_r1, &pop_r1.tx.inputs[0], 0, &pop_r1.entries[0], ctx_r1, flags);
    assert_eq!(vm_r1.execute(), Ok(()));
    println!("  [Step 3.2] Refund Step 1: Buyer 0 refunded 40 KAS. Remaining pool: 60.5 KAS PASS!");

    // Refund Step 2 (Final): Refund Buyer 1 (60 tickets, 60 KAS) -> Terminal Deposit Return!
    let mut sig_sb_r2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r2.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_r2.add_data(&buyer_spk_1).unwrap();
    sig_sb_r2.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&40u64.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&1u64.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&refund_redeem_c1).unwrap();
    let sig_script_r2 = sig_sb_r2.drain();

    let tx_r2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_r1.id(), 0),
            sig_script_r2,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: state_deposit, // 0.5 KAS returned to creator!
                script_public_key: creator_out_spk.clone(),
                covenant: None, // Lineage terminates!
            },
            TransactionOutput {
                value: ticket_price * count_1, // 60 KAS back to Buyer 1!
                script_public_key: kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_1[2..].to_vec()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_r2 = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_r2, vec![
        UtxoEntry::new(pool_rem_60, refund_spk_c1.clone(), d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1 + 1, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_r2 = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_r2).unwrap();
    let ctx_r2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_r2);
    let mut vm_r2 = TxScriptEngine::from_transaction_input(&pop_r2, &pop_r2.tx.inputs[0], 0, &pop_r2.entries[0], ctx_r2, flags);
    assert_eq!(vm_r2.execute(), Ok(()));
    println!("  [Step 3.3] Refund Step 2: Buyer 1 refunded 60 KAS. Creator reclaimed 0.5 KAS PASS!");
    println!("  -> Total Buyers Refunded: 100 KAS; Creator State Deposit Recovered: 0.5 KAS. Lineage terminated!");

    // =============================================================
    // PART 4: PARTIAL-SALE REFUND REGRESSION (OPEN -> REFUNDING -> PAID)
    // =============================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 4: PARTIAL-SALE REFUND REGRESSION");
    println!("------------------------------------------------------------------");

    // Suppose round sold only 40 tickets (Buyer 0).
    // DAA reaches refund_lock_daa (1_500_000).
    // State is OPEN(sold=40, pc=1, root=root_0).
    let partial_ref_redeem_c0 = build_refunding_covenant(
        round_id,
        ticket_price,
        total_tickets,
        root_0,
        creator_refund_spk.clone(),
        1, // purchase_count = 1
        0, // cursor = 0
        count_0, // rem = 40
    ).unwrap();
    let partial_ref_spk_c0 = pay_to_script_hash_script(&partial_ref_redeem_c0);

    let mut sig_sb_pbr = ScriptBuilder::with_flags(flags);
    sig_sb_pbr.add_i64(ACTION_BEGIN_REFUND).unwrap();
    sig_sb_pbr.add_data(&open_redeem_1).unwrap();
    let sig_script_pbr = sig_sb_pbr.drain();

    let tx_partial_begin = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(5), 0),
            sig_script_pbr,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amt_40, // 40.5 KAS
            script_public_key: partial_ref_spk_c0.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        refund_lock_daa, SubnetworkId::default(), 0, vec![],
    );

    // Consensus Header Context Boundary Verification:
    assert_eq!(
        reference_check_tx_finalized_in_daa_context(&tx_partial_begin, refund_lock_daa),
        Err("Transaction not finalized in header context: lock_time not reached and inputs not max sequence"),
        "block_daa == refund_lock_daa MUST fail header-context finality!"
    );
    assert_eq!(
        reference_check_tx_finalized_in_daa_context(&tx_partial_begin, refund_lock_daa + 1),
        Ok(()),
        "block_daa == refund_lock_daa + 1 MUST pass header-context finality!"
    );
    println!("  [Step 4.1 Boundary] DAA == refund_lock_daa (FAIL) & DAA == refund_lock_daa + 1 (PASS)");

    let pop_pbr = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_partial_begin, vec![
        UtxoEntry::new(pool_amt_40, open_spk_1.clone(), refund_lock_daa + 1, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_pbr = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_pbr).unwrap();
    let ctx_pbr = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_pbr);
    let mut vm_pbr = TxScriptEngine::from_transaction_input(&pop_pbr, &pop_pbr.tx.inputs[0], 0, &pop_pbr.entries[0], ctx_pbr, flags);
    assert_eq!(vm_pbr.execute(), Ok(()));
    println!("  [Step 4.1] OPEN(sold=40) -> REFUNDING(cursor=0, rem=40) (Pool: 40.5 KAS) PASS!");

    // Terminal refund for Buyer 0 (only purchase in partial sale):
    let mut sig_sb_pr_final = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_pr_final.add_data(&siblings_0[i].as_bytes()).unwrap(); }
    sig_sb_pr_final.add_data(&buyer_spk_0).unwrap();
    sig_sb_pr_final.add_data(&count_0.to_le_bytes()).unwrap();
    sig_sb_pr_final.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_pr_final.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_pr_final.add_data(&partial_ref_redeem_c0).unwrap();
    let sig_script_pr_final = sig_sb_pr_final.drain();

    let tx_partial_final = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_partial_begin.id(), 0),
            sig_script_pr_final,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: state_deposit, // 0.5 KAS returned to creator!
                script_public_key: creator_out_spk.clone(),
                covenant: None, // Lineage terminates!
            },
            TransactionOutput {
                value: ticket_price * count_0, // 40 KAS back to Buyer 0!
                script_public_key: kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_0[2..].to_vec()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_prf = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_partial_final, vec![
        UtxoEntry::new(pool_amt_40, partial_ref_spk_c0.clone(), refund_lock_daa + 1, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_prf = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_prf).unwrap();
    let ctx_prf = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_prf);
    let mut vm_prf = TxScriptEngine::from_transaction_input(&pop_prf, &pop_prf.tx.inputs[0], 0, &pop_prf.entries[0], ctx_prf, flags);
    assert_eq!(vm_prf.execute(), Ok(()));
    println!("  [Step 4.2] Terminal Partial Refund: Buyer 0 refunded 40 KAS. Creator reclaimed 0.5 KAS PASS!");
    println!("  -> Total Buyers Refunded: 40 KAS; Creator State Deposit Recovered: 0.5 KAS. Lineage terminated!");

    // =============================================================
    // PART 5: ZERO-SALE RECOVER_EMPTY STATE DEPOSIT RECOVERY
    // =============================================================
    println!("\n------------------------------------------------------------------");
    println!("PART 5: ZERO-SALE RECOVER_EMPTY STATE DEPOSIT RECOVERY");
    println!("------------------------------------------------------------------");

    // Initial Genesis OPEN covenant with 0 tickets sold:
    let initial_open_redeem = open_covenant::build_initial_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();
    let initial_open_spk = pay_to_script_hash_script(&initial_open_redeem);

    let mut sig_sb_empty = ScriptBuilder::with_flags(flags);
    sig_sb_empty.add_i64(open_covenant::ACTION_RECOVER_EMPTY).unwrap(); // action = 3
    sig_sb_empty.add_data(&initial_open_redeem).unwrap();
    let sig_script_empty = sig_sb_empty.drain();

    let tx_recover_empty = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            funding_outpoint,
            sig_script_empty,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: state_deposit, // 0.5 KAS returned to creator!
            script_public_key: creator_out_spk.clone(),
            covenant: None, // Lineage terminates!
        }],
        refund_lock_daa, SubnetworkId::default(), 0, vec![],
    );

    // 1. Boundary check before maturity:
    assert_eq!(
        reference_check_tx_finalized_in_daa_context(&tx_recover_empty, refund_lock_daa),
        Err("Transaction not finalized in header context: lock_time not reached and inputs not max sequence"),
        "Zero-sale RECOVER_EMPTY at block DAA == refund_lock_daa MUST fail header-context!"
    );
    assert_eq!(
        reference_check_tx_finalized_in_daa_context(&tx_recover_empty, refund_lock_daa + 1),
        Ok(()),
        "Zero-sale RECOVER_EMPTY at block DAA == refund_lock_daa + 1 MUST pass header-context!"
    );

    // 2. VM execution after maturity:
    let pop_empty = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_recover_empty, vec![
        UtxoEntry::new(state_deposit, initial_open_spk, refund_lock_daa + 1, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_empty = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_empty).unwrap();
    let ctx_empty = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_empty);
    let mut vm_empty = TxScriptEngine::from_transaction_input(&pop_empty, &pop_empty.tx.inputs[0], 0, &pop_empty.entries[0], ctx_empty, flags);
    assert_eq!(vm_empty.execute(), Ok(()));
    let u_empty = vm_empty.used_script_units();
    let b_min_empty = ComputeBudget::checked_covering_script_units(u_empty).unwrap();
    println!("  [Step 5.1] Zero-sale RECOVER_EMPTY PASS! [Units: {:?}, B_min: {:?}]", u_empty, b_min_empty);
    println!("  -> Sold: 0, Refunded: 0 KAS, Creator Recovered State Deposit: 0.5 KAS. Lineage terminated!");

    println!("\n==================================================================");
    println!("ALL TESTS IN STATE DEPOSIT ECONOMIC MODEL E2E SUITE PASSED 100%!");
    println!("==================================================================");
}
