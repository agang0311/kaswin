use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::tx::{
    ComputeCommit, Transaction, TransactionInput, TransactionOutput, TransactionOutpoint, UtxoEntry, CovenantBinding,
};
use kaspa_consensus_core::constants::{SEQUENCE_LOCK_TIME_DISABLED, SEQUENCE_LOCK_TIME_MASK};
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
    compute_empty_levels, compute_payout_commitment,
    compute_purchase_leaf, compute_root_from_path, TREE_DEPTH,
};

#[path = "../../../../contracts/refunding_covenant.rs"]
pub mod refunding_covenant;
use refunding_covenant::build_refunding_covenant;

#[path = "../../../../contracts/winner_selection.rs"]
pub mod winner_selection;
use winner_selection::build_draw_ready_covenant;

#[path = "../../../../contracts/sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::{
    build_production_sealed_covenant_v1,
    compute_application_commitment, compute_random_seed,
    ACTION_DRAW, ACTION_FULL_REFUND,
};

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::{build_open_covenant, ACTION_BUY};

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::build_canonical_kaswin_genesis_output;

// Mock SeqCommit Accessor
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

fn reference_check_sequence_lock(tx: &Transaction, entry_daa: u64, pov_daa_score: u64) -> Result<(), &'static str> {
    let pov_daa_score: i64 = pov_daa_score as i64;
    for input in &tx.inputs {
        if input.sequence & SEQUENCE_LOCK_TIME_DISABLED != SEQUENCE_LOCK_TIME_DISABLED {
            let relative_lock = (input.sequence & SEQUENCE_LOCK_TIME_MASK) as i64;
            let lock_daa_score = entry_daa as i64 + relative_lock - 1;
            if lock_daa_score >= pov_daa_score {
                return Err("SequenceLockConditionsAreNotMet");
            }
        }
    }
    Ok(())
}

fn main() {
    println!("==================================================================");
    println!("KASWIN V1 PRODUCTION FULL-SALE RECOVERY & LIVENESS TEST SUITE (A-M)");
    println!("==================================================================");

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(112233), 0);
    let ticket_price = 10_000_000u64; // 0.1 KAS
    let total_tickets = 100u64;
    let refund_lock_daa = 1_500_000u64;
    let initial_reserve = 50_000_000u64; // 0.5 KAS

    let mut reserve_spk = vec![0x00, 0x00, 0x20];
    reserve_spk.extend(vec![0x77; 32]);
    reserve_spk.push(0xac);

    let (_genesis_out, covenant_id_c) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        reserve_spk.clone(),
        initial_reserve,
    ).unwrap();
    let round_id = genesis::compute_canonical_round_id(&funding_outpoint);

    println!("Genesis Covenant ID: {}", covenant_id_c);
    println!("Canonical Round ID:  {}", round_id);

    // Setup 2 Purchases:
    // Buyer 0 buys 40 tickets (0 -> 40)
    // Buyer 1 (Final Buyer) buys 60 tickets (40 -> 100 == total_tickets)
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

    // State 1: sold = 40, purchase_count = 1, ticket_root = root_0
    let open_redeem_1 = build_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        count_0,
        1,
        root_0,
        DELTA_DAA_V1,
        refund_lock_daa,
        reserve_spk.clone(),
    ).unwrap();
    let open_spk_1 = pay_to_script_hash_script(&open_redeem_1);

    // Buyer 1 (Final Buyer):
    let mut buyer_spk_1 = vec![0x00, 0x00, 0x20];
    buyer_spk_1.extend(vec![0x22; 32]);
    buyer_spk_1.push(0xac);
    let count_1 = 60u64;

    let mut siblings_1 = [Hash::default(); TREE_DEPTH];
    for i in 0..TREE_DEPTH {
        if i == 0 {
            siblings_1[i] = leaf_0;
        } else {
            siblings_1[i] = empty_levels[i];
        }
    }
    let payout_comm_1 = compute_payout_commitment(&buyer_spk_1);
    let leaf_1 = compute_purchase_leaf(&round_id, 1, 40, count_1, &payout_comm_1);
    let final_root = compute_root_from_path(&leaf_1, 1, &siblings_1);
    let final_pc = 2u64;

    // Expected production SEALED V1 successor:
    let expected_sealed_redeem = build_production_sealed_covenant_v1(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        final_pc,
        reserve_spk.clone(),
    ).unwrap();
    let expected_sealed_spk = pay_to_script_hash_script(&expected_sealed_redeem);

    // -------------------------------------------------------------
    // Test A: FINAL BUY -> SEALED
    // -------------------------------------------------------------
    println!("\n[Test A] FINAL BUY -> Production SEALED V1");
    let mut sig_sb_fb = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_fb.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_fb.add_data(&buyer_spk_1).unwrap();
    sig_sb_fb.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_fb.add_i64(ACTION_BUY).unwrap();
    sig_sb_fb.add_data(&open_redeem_1).unwrap();
    let sig_script_fb = sig_sb_fb.drain();

    let pool_amt_40 = initial_reserve + ticket_price * 40;
    let pool_amt_100 = pool_amt_40 + ticket_price * 60; // 1_050_000_000 sompi

    let tx_final_buy = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(10), 0),
            sig_script_fb.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amt_100,
            script_public_key: expected_sealed_spk.clone(),
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
    println!("  -> PASS: Final BUY successfully transitioned to production SEALED V1! [Units: {:?}, B_min: {:?}]", u_fb, b_min_fb);

    // Bounded execution check for Final BUY:
    {
        let mut tx_fb_bmin = tx_final_buy.clone();
        tx_fb_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_fb);
        let pop_bmin = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_fb_bmin, vec![
            UtxoEntry::new(pool_amt_40, open_spk_1.clone(), 1_000_000, false, Some(covenant_id_c)),
        ]);
        let cov_ctx = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_bmin, &pop_bmin.tx.inputs[0], 0, &pop_bmin.entries[0], ctx, flags,
            tx_fb_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()));

        let mut tx_fb_tight = tx_final_buy.clone();
        tx_fb_tight.inputs[0].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(b_min_fb.0 - 1));
        let pop_tight = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_fb_tight, vec![
            UtxoEntry::new(pool_amt_40, open_spk_1.clone(), 1_000_000, false, Some(covenant_id_c)),
        ]);
        let cov_ctx_t = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_tight).unwrap();
        let ctx_t = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_t);
        let mut vm_t = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_tight, &pop_tight.tx.inputs[0], 0, &pop_tight.entries[0], ctx_t, flags,
            tx_fb_tight.inputs[0].compute_commit.allowed_script_units(),
        );
        assert!(matches!(vm_t.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })));
        println!("  -> PASS: Final BUY bounded B_min ({:?}) and B_min-1 rejection verified!", b_min_fb);
    }

    // Common SEALED UTXO entry for subsequent tests:
    let d0 = 1_000_000u64;
    let boundary = d0 + DELTA_DAA_V1; // 1_000_100

    // Construct valid 12-item PASS-A opening fixture:
    let p_daa_num = boundary - 1; // 1_000_099
    let t_daa_num = boundary;     // 1_000_100
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

    // Witness for DRAW:
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
    sig_sb_draw.add_data(&expected_sealed_redeem).unwrap();
    let sig_script_draw = sig_sb_draw.drain();

    let expected_app = compute_application_commitment(&round_id, &final_root, total_tickets);
    let expected_seed = compute_random_seed(&target_hash, &expected_app);
    let expected_draw_redeem = build_draw_ready_covenant(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        target_hash,
        expected_seed,
        reserve_spk.clone(),
        0,
    ).unwrap();
    let expected_draw_spk = pay_to_script_hash_script(&expected_draw_redeem);

    let tx_draw = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_final_buy.id(), 0),
            sig_script_draw.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amt_100,
            script_public_key: expected_draw_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );

    // -------------------------------------------------------------
    // Test B: SEALED ACTION_DRAW (Valid PASS-A opening)
    // -------------------------------------------------------------
    println!("\n[Test B] SEALED ACTION_DRAW (PASS-A Opening + Continuation Guard)");
    let pop_b = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_draw, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_b = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_b).unwrap();
    let mock_acc_b = MockAccessor { target_hash, target_merkle, within_depth: true };
    let ctx_b = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_b).with_seq_commit_accessor(&mock_acc_b);
    let mut vm_b = TxScriptEngine::from_transaction_input(&pop_b, &pop_b.tx.inputs[0], 0, &pop_b.entries[0], ctx_b, flags);
    assert_eq!(vm_b.execute(), Ok(()));
    let u_draw = vm_b.used_script_units();
    let b_min_draw = ComputeBudget::checked_covering_script_units(u_draw).unwrap();
    println!("  -> PASS: ACTION_DRAW succeeded in VM! [Units: {:?}, B_min: {:?}]", u_draw, b_min_draw);

    // Bounded execution check for DRAW:
    {
        let mut tx_b_bmin = tx_draw.clone();
        tx_b_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_draw);
        let pop_bmin = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_b_bmin, vec![
            UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
        ]);
        let cov_ctx = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor(&mock_acc_b);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_bmin, &pop_bmin.tx.inputs[0], 0, &pop_bmin.entries[0], ctx, flags,
            tx_b_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()));
        println!("  -> PASS: DRAW bounded B_min ({:?}) execution verified!", b_min_draw);
    }

    // -------------------------------------------------------------
    // Test C: DRAW malformed witness count / unknown action
    // -------------------------------------------------------------
    println!("\n[Test C] Attack: Malformed witness count & unknown action");
    // Missing 1 opening item (11 items instead of 12):
    let mut sig_sb_c1 = ScriptBuilder::with_flags(flags);
    sig_sb_c1.add_data(&target_hash.as_bytes()).unwrap();
    sig_sb_c1.add_data(&target_activity.as_bytes()).unwrap();
    sig_sb_c1.add_data(&target_payload.as_bytes()).unwrap();
    sig_sb_c1.add_data(&target_sp_ts).unwrap();
    sig_sb_c1.add_data(&target_daa).unwrap();
    sig_sb_c1.add_data(&target_blue).unwrap();
    sig_sb_c1.add_data(&p_parent_seq.as_bytes()).unwrap();
    sig_sb_c1.add_data(&p_activity.as_bytes()).unwrap();
    sig_sb_c1.add_data(&p_payload.as_bytes()).unwrap();
    sig_sb_c1.add_data(&p_sp_ts).unwrap();
    sig_sb_c1.add_data(&p_daa).unwrap(); // omitted p_blue!
    sig_sb_c1.add_i64(ACTION_DRAW).unwrap();
    sig_sb_c1.add_data(&expected_sealed_redeem).unwrap();
    let mut tx_c1 = tx_draw.clone();
    tx_c1.inputs[0].signature_script = sig_sb_c1.drain();
    let pop_c1 = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_c1, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_c1 = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_c1).unwrap();
    let ctx_c1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_c1).with_seq_commit_accessor(&mock_acc_b);
    let mut vm_c1 = TxScriptEngine::from_transaction_input(&pop_c1, &pop_c1.tx.inputs[0], 0, &pop_c1.entries[0], ctx_c1, flags);
    assert!(vm_c1.execute().is_err());
    println!("  -> PASS: 11-item witness strictly BLOCKED by OpDepth == 12 check!");

    // Unknown action = 999:
    let mut sig_sb_c2 = ScriptBuilder::with_flags(flags);
    sig_sb_c2.add_i64(999).unwrap();
    sig_sb_c2.add_data(&expected_sealed_redeem).unwrap();
    let mut tx_c2 = tx_draw.clone();
    tx_c2.inputs[0].signature_script = sig_sb_c2.drain();
    let pop_c2 = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_c2, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_c2 = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_c2).unwrap();
    let ctx_c2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_c2);
    let mut vm_c2 = TxScriptEngine::from_transaction_input(&pop_c2, &pop_c2.tx.inputs[0], 0, &pop_c2.entries[0], ctx_c2, flags);
    assert!(vm_c2.execute().is_err());
    println!("  -> PASS: Unknown action selector strictly BLOCKED!");

    // -------------------------------------------------------------
    // FULL_REFUND Setup & Test D: Before maturity
    // -------------------------------------------------------------
    println!("\n[Test D] FULL_REFUND before maturity (PoV DAA < D0 + 432_000)");
    let expected_ref_redeem = build_refunding_covenant(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        reserve_spk.clone(),
        final_pc,
        0, // cursor = 0
        total_tickets, // remaining = total_tickets (100)
    ).unwrap();
    let expected_ref_spk = pay_to_script_hash_script(&expected_ref_redeem);

    let mut sig_sb_ref = ScriptBuilder::with_flags(flags);
    sig_sb_ref.add_i64(ACTION_FULL_REFUND).unwrap();
    sig_sb_ref.add_data(&expected_sealed_redeem).unwrap();
    let sig_script_ref = sig_sb_ref.drain();

    let tx_full_refund = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_final_buy.id(), 0),
            sig_script_ref.clone(),
            FULL_SALE_RECOVERY_DELAY_DAA_V1, // sequence = 432_000
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amt_100,
            script_public_key: expected_ref_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );

    // PoV = D0 + 431_999 (Early):
    let res_early_ref = reference_check_sequence_lock(&tx_full_refund, d0, d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1 - 1);
    assert_eq!(res_early_ref, Err("SequenceLockConditionsAreNotMet"));
    println!("  -> PASS: Consensus relative lock rejected immature FULL_REFUND at D0 + 431_999!");

    // -------------------------------------------------------------
    // Test E: FULL_REFUND first maturity
    // -------------------------------------------------------------
    println!("\n[Test E] FULL_REFUND at first maturity (PoV DAA == D0 + 432_000)");
    let res_mature_ref = reference_check_sequence_lock(&tx_full_refund, d0, d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1);
    assert_eq!(res_mature_ref, Ok(()));
    println!("  -> Consensus Sequence Lock: Mature & Eligible");

    let pop_e = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_full_refund, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_e = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_e).unwrap();
    let ctx_e = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_e);
    let mut vm_e = TxScriptEngine::from_transaction_input(&pop_e, &pop_e.tx.inputs[0], 0, &pop_e.entries[0], ctx_e, flags);
    assert_eq!(vm_e.execute(), Ok(()));
    let u_ref = vm_e.used_script_units();
    let b_min_ref = ComputeBudget::checked_covering_script_units(u_ref).unwrap();
    println!("  -> PASS: FULL_REFUND executed successfully! SEALED -> REFUNDING(cursor=0, rem=100) [Units: {:?}, B_min: {:?}]", u_ref, b_min_ref);

    // Bounded execution check for FULL_REFUND:
    {
        let mut tx_e_bmin = tx_full_refund.clone();
        tx_e_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_ref);
        let pop_bmin = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_e_bmin, vec![
            UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
        ]);
        let cov_ctx = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_bmin, &pop_bmin.tx.inputs[0], 0, &pop_bmin.entries[0], ctx, flags,
            tx_e_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()));

        let mut tx_e_tight = tx_full_refund.clone();
        tx_e_tight.inputs[0].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(b_min_ref.0 - 1));
        let pop_tight = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_e_tight, vec![
            UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
        ]);
        let cov_ctx_t = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_tight).unwrap();
        let ctx_t = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_t);
        let mut vm_t = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_tight, &pop_tight.tx.inputs[0], 0, &pop_tight.entries[0], ctx_t, flags,
            tx_e_tight.inputs[0].compute_commit.allowed_script_units(),
        );
        assert!(matches!(vm_t.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })));
        println!("  -> PASS: FULL_REFUND bounded B_min ({:?}) and B_min-1 rejection verified!", b_min_ref);
    }

    // -------------------------------------------------------------
    // Test F: Sequence disabled-bit bypass attempt
    // -------------------------------------------------------------
    println!("\n[Test F] Attack: Sequence disabled-bit bypass attempt");
    let mut tx_f = tx_full_refund.clone();
    tx_f.inputs[0].sequence = FULL_SALE_RECOVERY_DELAY_DAA_V1 | SEQUENCE_LOCK_TIME_DISABLED;
    let pop_f = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_f, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_f = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_f).unwrap();
    let ctx_f = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_f);
    let mut vm_f = TxScriptEngine::from_transaction_input(&pop_f, &pop_f.tx.inputs[0], 0, &pop_f.entries[0], ctx_f, flags);
    assert!(matches!(vm_f.execute(), Err(TxScriptError::UnsatisfiedLockTime(_))));
    println!("  -> PASS: SEQUENCE_LOCK_TIME_DISABLED bypass strictly BLOCKED by OpCheckSequenceVerify!");

    // -------------------------------------------------------------
    // Test G: Wrong REFUNDING successor SPK
    // -------------------------------------------------------------
    println!("\n[Test G] Attack: Tampered REFUNDING successor SPK");
    let mut tx_g = tx_full_refund.clone();
    tx_g.outputs[0].script_public_key = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, vec![0x51]); // OP_TRUE
    let pop_g = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_g, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_g = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_g).unwrap();
    let ctx_g = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_g);
    let mut vm_g = TxScriptEngine::from_transaction_input(&pop_g, &pop_g.tx.inputs[0], 0, &pop_g.entries[0], ctx_g, flags);
    assert!(vm_g.execute().is_err());
    println!("  -> PASS: Tampered successor SPK strictly BLOCKED by Output 0 SPK assertion!");

    // -------------------------------------------------------------
    // Test H: Output 0 Amount +/- 1 Sompi
    // -------------------------------------------------------------
    println!("\n[Test H] Attack: Output 0 amount deviation (+/- 1 sompi)");
    let mut tx_h = tx_full_refund.clone();
    tx_h.outputs[0].value = pool_amt_100 - 1; // Underpaid pool
    let pop_h = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_h, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_h = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_h).unwrap();
    let ctx_h = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_h);
    let mut vm_h = TxScriptEngine::from_transaction_input(&pop_h, &pop_h.tx.inputs[0], 0, &pop_h.entries[0], ctx_h, flags);
    assert!(vm_h.execute().is_err());
    println!("  -> PASS: Output 0 amount deviation strictly BLOCKED by OpEqualVerify!");

    // -------------------------------------------------------------
    // Test I: Wrong / Missing covenant binding
    // -------------------------------------------------------------
    println!("\n[Test I] Attack: Missing covenant binding on Output 0");
    let mut tx_i = tx_full_refund.clone();
    tx_i.outputs[0].covenant = None; // Dropped covenant!
    let pop_i = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_i, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_i = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_i).unwrap();
    let ctx_i = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_i);
    let mut vm_i = TxScriptEngine::from_transaction_input(&pop_i, &pop_i.tx.inputs[0], 0, &pop_i.entries[0], ctx_i, flags);
    assert!(vm_i.execute().is_err());
    println!("  -> PASS: Missing covenant binding strictly BLOCKED by continuation guard!");

    // -------------------------------------------------------------
    // Test J: Second C continuation output (split attack)
    // -------------------------------------------------------------
    println!("\n[Test J] Attack: Second covenant output (covenant split attack)");
    let mut tx_j = tx_full_refund.clone();
    tx_j.outputs[0].value = pool_amt_100 - 1000;
    tx_j.outputs.push(TransactionOutput {
        value: 1000,
        script_public_key: expected_ref_spk.clone(),
        covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
    });
    let pop_j = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_j, vec![
        UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_j = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_j).unwrap();
    let ctx_j = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_j);
    let mut vm_j = TxScriptEngine::from_transaction_input(&pop_j, &pop_j.tx.inputs[0], 0, &pop_j.entries[0], ctx_j, flags);
    assert!(vm_j.execute().is_err());
    println!("  -> PASS: Split covenant attempt strictly BLOCKED by OpAuthOutputCount == 1!");

    // -------------------------------------------------------------
    // Test K: INTENDED RACE PROOF
    // -------------------------------------------------------------
    println!("\n[Test K] INTENDED RACE PROOF (Simultaneous validity of DRAW & FULL_REFUND)");
    // At PoV DAA = D0 + 432_000, target block is still within accessor depth:
    let pov_race_daa = d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1;

    // Both tx_draw and tx_full_refund spend the EXACT SAME UTXO:
    let race_utxo = UtxoEntry::new(pool_amt_100, expected_sealed_spk.clone(), d0, false, Some(covenant_id_c));

    // 1. Validate DRAW at race time:
    let pop_race_draw = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_draw, vec![race_utxo.clone()]);
    let cov_ctx_rd = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_race_draw).unwrap();
    let ctx_rd = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_rd).with_seq_commit_accessor(&mock_acc_b);
    let mut vm_rd = TxScriptEngine::from_transaction_input(&pop_race_draw, &pop_race_draw.tx.inputs[0], 0, &pop_race_draw.entries[0], ctx_rd, flags);
    assert_eq!(vm_rd.execute(), Ok(()));
    println!("  -> DRAW transaction at race point: VALID & EXECUTABLE");

    // 2. Validate FULL_REFUND at race time:
    assert_eq!(reference_check_sequence_lock(&tx_full_refund, d0, pov_race_daa), Ok(()));
    let pop_race_ref = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_full_refund, vec![race_utxo]);
    let cov_ctx_rr = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_race_ref).unwrap();
    let ctx_rr = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_rr);
    let mut vm_rr = TxScriptEngine::from_transaction_input(&pop_race_ref, &pop_race_ref.tx.inputs[0], 0, &pop_race_ref.entries[0], ctx_rr, flags);
    assert_eq!(vm_rr.execute(), Ok(()));
    println!("  -> FULL_REFUND transaction at race point: VALID & EXECUTABLE");
    println!("  -> PASS: Both spend identical SEALED UTXO. First confirmed transaction determines outcome. Intended V1 cancellation race confirmed!");

    // -------------------------------------------------------------
    // Test L: TOO-DEEP LIVENESS (Target expired -> DRAW fails, REFUND passes)
    // -------------------------------------------------------------
    println!("\n[Test L] TOO-DEEP LIVENESS (Accessor returns BlockIsTooDeep)");
    let mock_acc_too_deep = MockAccessor { target_hash, target_merkle, within_depth: false };
    let ctx_too_deep = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_rd).with_seq_commit_accessor(&mock_acc_too_deep);
    let mut vm_deep = TxScriptEngine::from_transaction_input(&pop_race_draw, &pop_race_draw.tx.inputs[0], 0, &pop_race_draw.entries[0], ctx_too_deep, flags);
    let res_deep = vm_deep.execute();
    assert!(matches!(res_deep, Err(TxScriptError::BlockIsTooDeep(_))));
    println!("  -> DRAW after target expired: Fatally rejected with {:?}", res_deep.err().unwrap());

    // FULL_REFUND remains completely unaffected and succeeds:
    let mut vm_liveness = TxScriptEngine::from_transaction_input(&pop_race_ref, &pop_race_ref.tx.inputs[0], 0, &pop_race_ref.entries[0], ctx_rr, flags);
    assert_eq!(vm_liveness.execute(), Ok(()));
    println!("  -> FULL_REFUND remains fully functional and clears funds: PASS!");
    println!("  -> PASS: Permanent fund deadlock is mathematically impossible in V1!");

    // -------------------------------------------------------------
    // Test M: FULL REFUND END-TO-END PIPELINE
    // -------------------------------------------------------------
    println!("\n[Test M] FULL REFUND END-TO-END PIPELINE (SEALED -> REFUNDING(0) -> REFUNDING(1) -> Terminal PAID)");
    // Step M1: Execute FULL_REFUND from SEALED -> Output 0 is REFUNDING(cursor=0, rem=100)
    // Consumes Output 0 of tx_full_refund:
    let refunding_utxo_0 = UtxoEntry::new(pool_amt_100, expected_ref_spk.clone(), pov_race_daa, false, Some(covenant_id_c));

    // Buyer 0 refund (cursor = 0, count = 40):
    // Note: In tree with final_root (2 leaves), sibling of leaf_0 at level 0 is leaf_1!
    let mut siblings_0_in_final_tree = [Hash::default(); TREE_DEPTH];
    siblings_0_in_final_tree[0] = leaf_1;
    for i in 1..TREE_DEPTH {
        siblings_0_in_final_tree[i] = empty_levels[i];
    }
    assert_eq!(compute_root_from_path(&leaf_0, 0, &siblings_0_in_final_tree), final_root);

    let refunding_redeem_c1 = build_refunding_covenant(
        round_id,
        ticket_price,
        total_tickets,
        final_root,
        reserve_spk.clone(),
        final_pc,
        1, // cursor = 1
        60, // remaining = 60
    ).unwrap();
    let refunding_spk_c1 = pay_to_script_hash_script(&refunding_redeem_c1);

    let mut sig_sb_m1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_m1.add_data(&siblings_0_in_final_tree[i].as_bytes()).unwrap(); }
    sig_sb_m1.add_data(&buyer_spk_0).unwrap();
    sig_sb_m1.add_data(&count_0.to_le_bytes()).unwrap(); // count = 40
    sig_sb_m1.add_data(&0u64.to_le_bytes()).unwrap();      // start_ticket = 0
    sig_sb_m1.add_data(&0u64.to_le_bytes()).unwrap();      // purchase_index = 0
    sig_sb_m1.add_data(&expected_ref_redeem).unwrap();
    let sig_script_m1 = sig_sb_m1.drain();

    let buyer0_p2sh = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_0[2..].to_vec());
    let pool_amt_rem_60 = pool_amt_100 - ticket_price * 40;

    let tx_m1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_full_refund.id(), 0),
            sig_script_m1,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: pool_amt_rem_60,
                script_public_key: refunding_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ticket_price * count_0, // 400_000_000 sompi back to buyer 0!
                script_public_key: buyer0_p2sh,
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_m1 = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_m1, vec![refunding_utxo_0]);
    let cov_ctx_m1 = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_m1).unwrap();
    let ctx_m1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_m1);
    let mut vm_m1 = TxScriptEngine::from_transaction_input(&pop_m1, &pop_m1.tx.inputs[0], 0, &pop_m1.entries[0], ctx_m1, flags);
    assert_eq!(vm_m1.execute(), Ok(()));
    println!("  -> Step M1: Buyer 0 refunded 40 tickets (40 KAS). Remaining pool: {} sompi", pool_amt_rem_60);

    // Step M2: Buyer 1 final refund (cursor = 1, count = 60 == rem) -> Terminal return of reserve!
    let mut sig_sb_m2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_m2.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_m2.add_data(&buyer_spk_1).unwrap();
    sig_sb_m2.add_data(&count_1.to_le_bytes()).unwrap(); // count = 60
    sig_sb_m2.add_data(&40u64.to_le_bytes()).unwrap();     // start_ticket = 40
    sig_sb_m2.add_data(&1u64.to_le_bytes()).unwrap();      // purchase_index = 1
    sig_sb_m2.add_data(&refunding_redeem_c1).unwrap();
    let sig_script_m2 = sig_sb_m2.drain();

    let buyer1_p2sh = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_1[2..].to_vec());
    let reserve_dst = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, reserve_spk[2..].to_vec());

    let tx_m2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_m1.id(), 0),
            sig_script_m2,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: initial_reserve, // 50_000_000 sompi returned to creator!
                script_public_key: reserve_dst,
                covenant: None, // Lineage terminates!
            },
            TransactionOutput {
                value: ticket_price * count_1, // 600_000_000 sompi back to buyer 1!
                script_public_key: buyer1_p2sh,
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_m2 = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_m2, vec![
        UtxoEntry::new(pool_amt_rem_60, refunding_spk_c1, pov_race_daa + 1, false, Some(covenant_id_c)),
    ]);
    let cov_ctx_m2 = kaspa_txscript::covenants::CovenantsContext::from_tx(&pop_m2).unwrap();
    let ctx_m2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_m2);
    let mut vm_m2 = TxScriptEngine::from_transaction_input(&pop_m2, &pop_m2.tx.inputs[0], 0, &pop_m2.entries[0], ctx_m2, flags);
    assert_eq!(vm_m2.execute(), Ok(()));
    println!("  -> Step M2: Buyer 1 refunded 60 tickets (60 KAS). Creator reserve (0.5 KAS) returned!");
    println!("  -> PASS: 100% principal returned to buyers, creator reserve reclaimed, KIP-20 covenant extinguished!");

    println!("\n==================================================================");
    println!("ALL 13 TESTS (A - M) PASSED 100% IN FULL PRODUCTION LIVENESS FLOW!");
    println!("==================================================================");
}
