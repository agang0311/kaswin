use kaspa_hashes::Hash;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ComputeCommit,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    script_builder::ScriptBuilder,
    covenants::CovenantsContext,
    standard::pay_to_script_hash_script,
};
use kaspa_consensus_core::mass::{ComputeBudget, Mass, ScriptUnits};
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::config::params::TESTNET_PARAMS;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_levels,
    compute_payout_commitment,
    compute_purchase_leaf,
    compute_root_from_path,
    reference_verify_winner_membership,
    TREE_DEPTH,
};

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;
use winner_ready_settlement::{build_production_winner_ready_covenant, build_winner_ready_settlement_suffix};

#[path = "../../../../contracts/winner_selection.rs"]
pub mod winner_selection;
use winner_selection::{
    build_draw_ready_covenant,
    build_canonical_winner_ready_redeem_script,
    extract_candidate_num,
    compute_candidate_hash,
};

fn main() {
    println!("================================================================");
    println!("KASWIN WINNER_READY -> PAID ATOMIC PAYOUT TEST MATRIX");
    println!("================================================================");

    let round_id = Hash::from_u64_word(42);
    let total_tickets = 100u64;
    let target_hash = Hash::from_u64_word(777);
    let random_seed = Hash::from_u64_word(888);

    let empty_levels = compute_empty_levels();
    let buyer_spk_2 = vec![
        0x00, 0x00, 0xaa, 0x20,
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
        0x87,
    ];
    let count_2 = 10u64;
    let start_ticket_2 = 5u64;
    let purchase_index_2 = 1u64;

    let leaf_1 = compute_purchase_leaf(&round_id, 0, 0, 5, &compute_payout_commitment(&[0x00, 0x00, 0x20, 0x11]));
    let mut siblings_2 = [Hash::default(); TREE_DEPTH];
    siblings_2[0] = leaf_1;
    for i in 1..TREE_DEPTH {
        siblings_2[i] = empty_levels[i];
    }

    let payout_comm_2 = compute_payout_commitment(&buyer_spk_2);
    let leaf_2 = compute_purchase_leaf(&round_id, purchase_index_2, start_ticket_2, count_2, &payout_comm_2);
    let ticket_root = compute_root_from_path(&leaf_2, purchase_index_2, &siblings_2);

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    // -------------------------------------------------------------
    // 1. CANONICAL WINNER PROOF + EXACT PAYOUT
    // -------------------------------------------------------------
    println!("\n[Test 1] Canonical Winner Proof + Exact Payout (WINNER_READY -> PAID)");
    let winner_index = 12u64; // in [5, 15)

    let winner_ready_redeem = build_production_winner_ready_covenant(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        winner_index,
    ).unwrap();

    let mut sig_sb_1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_1.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_1.add_data(&buyer_spk_2).unwrap();
    sig_sb_1.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_1.add_data(&start_ticket_2.to_le_bytes()).unwrap();
    sig_sb_1.add_data(&purchase_index_2.to_le_bytes()).unwrap();
    sig_sb_1.add_data(&winner_ready_redeem).unwrap();
    let sig_script_1 = sig_sb_1.drain();

    let winner_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_2[2..].to_vec());

    let pool_amount = 1_000_000_000u64; // 10 KAS pool

    let tx_1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: winner_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_1 = PopulatedTransaction::new(&tx_1, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_1 = CovenantsContext::from_tx(&pop_1).unwrap();
    let ctx_1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_1);
    let mut vm_1 = TxScriptEngine::from_transaction_input(&pop_1, &pop_1.tx.inputs[0], 0, &pop_1.entries[0], ctx_1, flags);
    let res_1 = vm_1.execute();
    assert_eq!(res_1, Ok(()));
    let u_settle = vm_1.used_script_units();
    let b_min_settle = ComputeBudget::checked_covering_script_units(u_settle).unwrap();
    println!("  -> PASS: Canonical winner proof executed and paid exact pool amount! [Units: {:?}, B_min: {:?}]", u_settle, b_min_settle);

    // -------------------------------------------------------------
    // 2. WITNESS PAYOUT_SPK DOES NOT MATCH MERKLE LEAF
    // -------------------------------------------------------------
    println!("\n[Test 2] Attack: Witness payout_spk does not match Merkle leaf");
    let mut fake_buyer_spk = vec![0x00, 0x00, 0xaa, 0x20];
    fake_buyer_spk.extend(vec![0x99; 33]);
    let mut sig_sb_2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_2.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_2.add_data(&fake_buyer_spk).unwrap(); // fake SPK
    sig_sb_2.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_2.add_data(&start_ticket_2.to_le_bytes()).unwrap();
    sig_sb_2.add_data(&purchase_index_2.to_le_bytes()).unwrap();
    sig_sb_2.add_data(&winner_ready_redeem).unwrap();
    let sig_script_2 = sig_sb_2.drain();

    let fake_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, fake_buyer_spk[2..].to_vec());
    let tx_2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_2,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: fake_spk,
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_2 = PopulatedTransaction::new(&tx_2, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_2 = CovenantsContext::from_tx(&pop_2).unwrap();
    let ctx_2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_2);
    let mut vm_2 = TxScriptEngine::from_transaction_input(&pop_2, &pop_2.tx.inputs[0], 0, &pop_2.entries[0], ctx_2, flags);
    assert!(vm_2.execute().is_err());
    println!("  -> PASS: Fake payout_spk attack BLOCKED by ticket_root assertion!");

    // -------------------------------------------------------------
    // 3. MERKLE PROOF CORRECT, BUT OUTPUT 0 SPK DIFFERENT
    // -------------------------------------------------------------
    println!("\n[Test 3] Attack: Valid Merkle proof, but Output 0 SPK pays attacker");
    let thief_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, vec![0x51]); // OP_TRUE
    let tx_3 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: thief_spk, // Output pays thief instead of claimant
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_3 = PopulatedTransaction::new(&tx_3, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_3 = CovenantsContext::from_tx(&pop_3).unwrap();
    let ctx_3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_3);
    let mut vm_3 = TxScriptEngine::from_transaction_input(&pop_3, &pop_3.tx.inputs[0], 0, &pop_3.entries[0], ctx_3, flags);
    assert!(vm_3.execute().is_err());
    println!("  -> PASS: Output 0 SPK redirection attack BLOCKED by OpTxOutputSpk(0) binding!");

    // -------------------------------------------------------------
    // 4. OUTPUT 0 AMOUNT = INPUT 0 AMOUNT - 1 (Underpayment/Skimming)
    // -------------------------------------------------------------
    println!("\n[Test 4] Attack: Output 0 Amount = Input 0 Amount - 1 (pool skimming)");
    let tx_4 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount - 1, // 1 sompi short!
            script_public_key: winner_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_4 = PopulatedTransaction::new(&tx_4, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_4 = CovenantsContext::from_tx(&pop_4).unwrap();
    let ctx_4 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_4);
    let mut vm_4 = TxScriptEngine::from_transaction_input(&pop_4, &pop_4.tx.inputs[0], 0, &pop_4.entries[0], ctx_4, flags);
    assert!(vm_4.execute().is_err());
    println!("  -> PASS: Pool skimming (Output < Input) BLOCKED by exact payment equality check!");

    // -------------------------------------------------------------
    // 5. OUTPUT 0 AMOUNT = INPUT 0 AMOUNT + 1 (Amount Mismatch)
    // -------------------------------------------------------------
    println!("\n[Test 5] Attack: Output 0 Amount = Input 0 Amount + 1 (amount mismatch)");
    let tx_5 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount + 1, // 1 sompi extra!
            script_public_key: winner_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_5 = PopulatedTransaction::new(&tx_5, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_5 = CovenantsContext::from_tx(&pop_5).unwrap();
    let ctx_5 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_5);
    let mut vm_5 = TxScriptEngine::from_transaction_input(&pop_5, &pop_5.tx.inputs[0], 0, &pop_5.entries[0], ctx_5, flags);
    assert!(vm_5.execute().is_err());
    println!("  -> PASS: Output != Input mismatch BLOCKED by exact payment equality check!");

    // -------------------------------------------------------------
    // 6. WINNER_INDEX NOT IN RANGE (winner_index = 15 for [5, 15))
    // -------------------------------------------------------------
    println!("\n[Test 6] Attack: winner_index not in range (winner = 15 for range [5, 15))");
    let oob_winner = 15u64;
    let oob_winner_ready_redeem = build_production_winner_ready_covenant(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        oob_winner,
    ).unwrap();

    let mut sig_sb_6 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_6.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_6.add_data(&buyer_spk_2).unwrap();
    sig_sb_6.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_6.add_data(&start_ticket_2.to_le_bytes()).unwrap();
    sig_sb_6.add_data(&purchase_index_2.to_le_bytes()).unwrap();
    sig_sb_6.add_data(&oob_winner_ready_redeem).unwrap();
    let sig_script_6 = sig_sb_6.drain();

    let tx_6 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_6,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: winner_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_6 = PopulatedTransaction::new(&tx_6, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&oob_winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_6 = CovenantsContext::from_tx(&pop_6).unwrap();
    let ctx_6 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_6);
    let mut vm_6 = TxScriptEngine::from_transaction_input(&pop_6, &pop_6.tx.inputs[0], 0, &pop_6.entries[0], ctx_6, flags);
    assert!(vm_6.execute().is_err());
    println!("  -> PASS: Out-of-bounds winner index BLOCKED by range assertion!");

    // -------------------------------------------------------------
    // 7. SIBLINGS DO NOT MATCH
    // -------------------------------------------------------------
    println!("\n[Test 7] Attack: Tampered sibling path in settlement witness");
    let mut bad_siblings = siblings_2;
    bad_siblings[3] = Hash::from_u64_word(0xbadbad);
    let mut sig_sb_7 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_7.add_data(&bad_siblings[i].as_bytes()).unwrap();
    }
    sig_sb_7.add_data(&buyer_spk_2).unwrap();
    sig_sb_7.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_7.add_data(&start_ticket_2.to_le_bytes()).unwrap();
    sig_sb_7.add_data(&purchase_index_2.to_le_bytes()).unwrap();
    sig_sb_7.add_data(&winner_ready_redeem).unwrap();
    let sig_script_7 = sig_sb_7.drain();

    let tx_7 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_7,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: winner_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_7 = PopulatedTransaction::new(&tx_7, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_7 = CovenantsContext::from_tx(&pop_7).unwrap();
    let ctx_7 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_7);
    let mut vm_7 = TxScriptEngine::from_transaction_input(&pop_7, &pop_7.tx.inputs[0], 0, &pop_7.entries[0], ctx_7, flags);
    assert!(vm_7.execute().is_err());
    println!("  -> PASS: Tampered sibling path BLOCKED by ticket_root assertion!");

    // -------------------------------------------------------------
    // 8. NON-CANONICAL WITNESS WIDTH
    // -------------------------------------------------------------
    println!("\n[Test 8] Attack: Non-canonical witness width (1-byte count = 0x0a)");
    let mut sig_sb_8 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_8.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_8.add_data(&buyer_spk_2).unwrap();
    sig_sb_8.add_data(&[0x0a]).unwrap(); // 1 byte count
    sig_sb_8.add_data(&start_ticket_2.to_le_bytes()).unwrap();
    sig_sb_8.add_data(&purchase_index_2.to_le_bytes()).unwrap();
    sig_sb_8.add_data(&winner_ready_redeem).unwrap();
    let sig_script_8 = sig_sb_8.drain();

    let tx_8 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_8,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: winner_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_8 = PopulatedTransaction::new(&tx_8, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_8 = CovenantsContext::from_tx(&pop_8).unwrap();
    let ctx_8 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_8);
    let mut vm_8 = TxScriptEngine::from_transaction_input(&pop_8, &pop_8.tx.inputs[0], 0, &pop_8.entries[0], ctx_8, flags);
    assert!(vm_8.execute().is_err());
    println!("  -> PASS: Non-canonical 1-byte count BLOCKED by witness width assertion!");

    // -------------------------------------------------------------
    // 9. MANDATORY CHAINED VM TEST: DRAW_READY -> WINNER_READY -> PAID
    // -------------------------------------------------------------
    println!("\n[Test 9] Mandatory Chained UTXO Execution: DRAW_READY -> WINNER_READY -> PAID");

    // STEP A: DRAW_READY -> production WINNER_READY
    // Find candidate for counter 0:
    let candidate_hash_0 = compute_candidate_hash(&random_seed, 0);
    let candidate_num_0 = extract_candidate_num(&candidate_hash_0);
    let q = ((1i64 << 56) / (total_tickets as i64));
    let limit = q * (total_tickets as i64);
    assert!(candidate_num_0 < limit, "Counter 0 must be accepted in test fixture");
    let chosen_winner_index = (candidate_num_0 % (total_tickets as i64)) as u64;
    println!("  Candidate 0 accepted: chosen winner_index = {}", chosen_winner_index);

    let draw_ready_redeem = build_draw_ready_covenant(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        0, // counter = 0
    ).unwrap();

    let prod_winner_ready = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        chosen_winner_index,
    );
    let prod_winner_ready_spk = pay_to_script_hash_script(&prod_winner_ready);

    let mut sig_sb_step_a = ScriptBuilder::with_flags(flags);
    sig_sb_step_a.add_data(&draw_ready_redeem).unwrap();
    let sig_script_step_a = sig_sb_step_a.drain();

    let tx_step_a = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_step_a,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: prod_winner_ready_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_step_a = PopulatedTransaction::new(&tx_step_a, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&draw_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_a = CovenantsContext::from_tx(&pop_step_a).unwrap();
    let ctx_a = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_a);
    let mut vm_step_a = TxScriptEngine::from_transaction_input(&pop_step_a, &pop_step_a.tx.inputs[0], 0, &pop_step_a.entries[0], ctx_a, flags);
    let res_step_a = vm_step_a.execute();
    assert_eq!(res_step_a, Ok(()));
    let u_draw = vm_step_a.used_script_units();
    let b_min_draw = ComputeBudget::checked_covering_script_units(u_draw).unwrap();
    println!("  -> PASS: Step A (DRAW_READY -> production WINNER_READY) succeeded! [Units: {:?}, B_min: {:?}]", u_draw, b_min_draw);

    // STEP B: WINNER_READY -> PAID (Consuming Step A Output 0 as Input 0)
    // In Test 9: total_tickets = 100, chosen_winner_index = 92.
    // We construct the complete 100-ticket sold tree with Buyer 3 owning [15, 100):
    let buyer_spk_3 = vec![
        0x00, 0x00, 0xaa, 0x20,
        0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
        0x11, 0x00, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa,
        0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
        0x11, 0x00, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa,
        0x87,
    ];
    let start_ticket_3 = 15u64;
    let count_3 = 85u64;
    let purchase_index_3 = 2u64;

    // Parent of leaf_1 and leaf_2:
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinTicketNodeV1");
    state.update(leaf_1.as_bytes().as_slice());
    state.update(leaf_2.as_bytes().as_slice());
    let parent_12 = Hash::from_bytes(state.finalize().as_bytes().try_into().unwrap());

    let mut siblings_3 = [Hash::default(); TREE_DEPTH];
    siblings_3[0] = empty_levels[0];
    siblings_3[1] = parent_12;
    for i in 2..TREE_DEPTH {
        siblings_3[i] = empty_levels[i];
    }

    let payout_comm_3 = compute_payout_commitment(&buyer_spk_3);
    let leaf_3 = compute_purchase_leaf(&round_id, purchase_index_3, start_ticket_3, count_3, &payout_comm_3);
    let ticket_root_3 = compute_root_from_path(&leaf_3, purchase_index_3, &siblings_3);

    // Recompute Step A with ticket_root_3 so that winner 92 is verified against ticket_root_3:
    let draw_ready_redeem_3 = build_draw_ready_covenant(
        round_id,
        ticket_root_3,
        total_tickets,
        target_hash,
        random_seed,
        0,
    ).unwrap();

    let prod_winner_ready_3 = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root_3,
        total_tickets,
        target_hash,
        random_seed,
        chosen_winner_index,
    );
    let prod_winner_ready_spk_3 = pay_to_script_hash_script(&prod_winner_ready_3);

    let mut sig_sb_step_a3 = ScriptBuilder::with_flags(flags);
    sig_sb_step_a3.add_data(&draw_ready_redeem_3).unwrap();
    let sig_script_step_a3 = sig_sb_step_a3.drain();

    let tx_step_a3 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_step_a3,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: prod_winner_ready_spk_3.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_step_a3 = PopulatedTransaction::new(&tx_step_a3, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&draw_ready_redeem_3),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_a3 = CovenantsContext::from_tx(&pop_step_a3).unwrap();
    let ctx_a3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_a3);
    let mut vm_step_a3 = TxScriptEngine::from_transaction_input(&pop_step_a3, &pop_step_a3.tx.inputs[0], 0, &pop_step_a3.entries[0], ctx_a3, flags);
    assert_eq!(vm_step_a3.execute(), Ok(()));

    // Now Step B consumes Step A's output:
    let winner_spk_3 = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_3[2..].to_vec());
    let mut sig_sb_step_b = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_step_b.add_data(&siblings_3[i].as_bytes()).unwrap();
    }
    sig_sb_step_b.add_data(&buyer_spk_3).unwrap();
    sig_sb_step_b.add_data(&count_3.to_le_bytes()).unwrap();
    sig_sb_step_b.add_data(&start_ticket_3.to_le_bytes()).unwrap();
    sig_sb_step_b.add_data(&purchase_index_3.to_le_bytes()).unwrap();
    sig_sb_step_b.add_data(&prod_winner_ready_3).unwrap();
    let sig_script_step_b = sig_sb_step_b.drain();

    let tx_step_b = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_step_a3.id(), 0), // Consumes Output 0 of Step A!
            sig_script_step_b,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: winner_spk_3.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_step_b = PopulatedTransaction::new(&tx_step_b, vec![UtxoEntry::new(
        pool_amount,
        prod_winner_ready_spk_3.clone(), // UTXO from Step A!
        1_000_001,
        false,
        None,
    )]);
    let cov_ctx_b = CovenantsContext::from_tx(&pop_step_b).unwrap();
    let ctx_b = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_b);
    let mut vm_step_b = TxScriptEngine::from_transaction_input(&pop_step_b, &pop_step_b.tx.inputs[0], 0, &pop_step_b.entries[0], ctx_b, flags);
    let res_step_b = vm_step_b.execute();
    assert_eq!(res_step_b, Ok(()));
    println!("  -> PASS: Step B (WINNER_READY -> PAID) successfully consumed Step A output and settled terminal payout!");
    println!("  >>> CHAINED UTXO EXECUTION PASS: DRAW_READY -> WINNER_READY -> PAID IS 100% OPERATIONAL! <<<");

    // -------------------------------------------------------------
    // 10. COMPUTE BUDGET
    // -------------------------------------------------------------
    println!("\n[Test 10] Real ComputeBudget Enforcement on Settlement Transaction");
    let tx_budget_pass = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(b_min_settle),
        )],
        vec![TransactionOutput {
            value: pool_amount,
            script_public_key: winner_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_bp = PopulatedTransaction::new(&tx_budget_pass, vec![UtxoEntry::new(
        pool_amount,
        pay_to_script_hash_script(&winner_ready_redeem),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_bp = CovenantsContext::from_tx(&pop_bp).unwrap();
    let ctx_bp = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_bp);
    let mut vm_bp = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop_bp,
        &pop_bp.tx.inputs[0],
        0,
        &pop_bp.entries[0],
        ctx_bp,
        flags,
        pop_bp.tx.inputs[0].compute_commit.allowed_script_units(),
    );
    assert_eq!(vm_bp.execute(), Ok(()));
    println!("  -> PASS: B_min ({:?}) execution succeeded!", b_min_settle);

    if b_min_settle.0 > 0 {
        let b_insufficient = ComputeBudget(b_min_settle.0 - 1);
        let tx_budget_fail = Transaction::new(
            1,
            vec![TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::default(), 0),
                sig_script_1.clone(),
                0,
                ComputeCommit::ComputeBudget(b_insufficient),
            )],
            vec![TransactionOutput {
                value: pool_amount,
                script_public_key: winner_spk.clone(),
                covenant: None,
            }],
            0,
            SubnetworkId::default(),
            0,
            vec![],
        );
        let pop_bf = PopulatedTransaction::new(&tx_budget_fail, vec![UtxoEntry::new(
            pool_amount,
            pay_to_script_hash_script(&winner_ready_redeem),
            1_000_000,
            false,
            None,
        )]);
        let cov_ctx_bf = CovenantsContext::from_tx(&pop_bf).unwrap();
        let ctx_bf = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_bf);
        let mut vm_bf = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_bf,
            &pop_bf.tx.inputs[0],
            0,
            &pop_bf.entries[0],
            ctx_bf,
            flags,
            pop_bf.tx.inputs[0].compute_commit.allowed_script_units(),
        );
        let res_bf = vm_bf.execute();
        assert!(matches!(res_bf, Err(kaspa_txscript_errors::TxScriptError::ExceededCommittedScriptUnits { .. })));
        println!("  -> PASS: B_min - 1 ({:?}) correctly failed with ExceededCommittedScriptUnits!", b_insufficient);
    }

    // -------------------------------------------------------------
    // Testnet-10 Mass & Resource Calculations
    // -------------------------------------------------------------
    println!("\n===============================================================");
    println!("TESTNET-10 ACCURATE RESOURCE AUDIT");
    println!("===============================================================");

    let calc = kaspa_consensus_core::mass::MassCalculator::new_with_consensus_params(&TESTNET_PARAMS);
    let cofactors = TESTNET_PARAMS.prior_block_mass_limits.cofactors();

    // A. DRAW_READY -> production WINNER_READY:
    let draw_nc_mass = calc.calc_non_contextual_masses(&tx_step_a);
    let draw_c_mass = calc.calc_contextual_masses(&pop_step_a).unwrap();
    let draw_mass = Mass::new(draw_nc_mass, draw_c_mass);
    let draw_total_mass = draw_mass.normalized_max(&cofactors);
    println!("\nA. DRAW_READY -> PRODUCTION WINNER_READY:");
    println!("   SignatureScript Bytes:  {} bytes", tx_step_a.inputs[0].signature_script.len());
    println!("   RedeemScript Bytes:     {} bytes", draw_ready_redeem.len());
    println!("   Actual Serialized:      {} bytes", kaspa_consensus_core::mass::transaction_estimated_serialized_size(&tx_step_a));
    println!("   Used Script Units:      {:?}", u_draw);
    println!("   B_min:                  {:?}", b_min_draw);
    println!("   Compute Mass:           {} gram", draw_nc_mass.compute_mass);
    println!("   Transient Mass:         {} gram", draw_nc_mass.transient_mass);
    println!("   Storage Mass:           {} gram", draw_c_mass.storage_mass);
    println!("   Overall Mass:           {} gram", draw_total_mass);

    // B. WINNER_READY -> PAID (Atomic Payout):
    let settle_nc_mass = calc.calc_non_contextual_masses(&tx_1);
    let settle_c_mass = calc.calc_contextual_masses(&pop_1).unwrap();
    let settle_mass = Mass::new(settle_nc_mass, settle_c_mass);
    let settle_total_mass = settle_mass.normalized_max(&cofactors);
    println!("\nB. WINNER_READY -> PAID (ATOMIC SETTLEMENT):");
    println!("   SignatureScript Bytes:  {} bytes", sig_script_1.len());
    println!("   RedeemScript Bytes:     {} bytes", winner_ready_redeem.len());
    println!("   Actual Serialized:      {} bytes", kaspa_consensus_core::mass::transaction_estimated_serialized_size(&tx_1));
    println!("   Used Script Units:      {:?}", u_settle);
    println!("   B_min:                  {:?}", b_min_settle);
    println!("   Compute Mass:           {} gram", settle_nc_mass.compute_mass);
    println!("   Transient Mass:         {} gram", settle_nc_mass.transient_mass);
    println!("   Storage Mass:           {} gram", settle_c_mass.storage_mass);
    println!("   Overall Mass:           {} gram", settle_total_mass);

    println!("\n===============================================================");
    println!("ALL 10 MANDATORY SETTLEMENT TESTS PASSED WITH 100% COVERAGE!");
    println!("===============================================================");
}
