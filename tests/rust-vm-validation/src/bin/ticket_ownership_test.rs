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
use kaspa_consensus_core::mass::ComputeBudget;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_root_27,
    compute_empty_levels,
    compute_payout_commitment,
    compute_purchase_leaf,
    compute_root_from_path,
    reference_verify_winner_membership,
    TREE_DEPTH,
};

#[path = "../../../../contracts/sealed_to_draw_ready.rs"]
pub mod sealed_to_draw_ready;
use sealed_to_draw_ready::build_sealed_to_draw_ready_covenant;

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::build_open_covenant;

#[path = "../../../../contracts/winner_membership.rs"]
pub mod winner_membership;
use winner_membership::build_winner_membership_verifier_script;

fn main() {
    println!("================================================================");
    println!("KASWIN CANONICAL TICKET COMMITMENT & VERIFICATION VM TEST MATRIX");
    println!("================================================================");

    let round_id = Hash::from_u64_word(42);
    let ticket_price = 10_000_000u64; // 0.1 KAS
    let total_tickets = 100u64;
    let delta_daa = 100u64;
    let empty_root = compute_empty_root_27();
    let empty_levels = compute_empty_levels();

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    // -------------------------------------------------------------
    // Test Case 1: Initial Purchase (OPEN -> OPEN)
    // -------------------------------------------------------------
    println!("\n[Test 1] OPEN -> BUY 5 Tickets -> OPEN(sold=5, pc=1)");
    let buyer_spk_1 = vec![0x20, 0x11, 0x22, 0x33];
    let count_1 = 5u64;

    let mut siblings_1 = [Hash::default(); TREE_DEPTH];
    for i in 0..TREE_DEPTH {
        siblings_1[i] = empty_levels[i];
    }

    let open_redeem_0 = build_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        0,
        0,
        empty_root,
        delta_daa,
    ).unwrap();

    let payout_comm_1 = compute_payout_commitment(&buyer_spk_1);
    let leaf_1 = compute_purchase_leaf(&round_id, 0, 0, count_1, &payout_comm_1);
    let root_1 = compute_root_from_path(&leaf_1, 0, &siblings_1);

    let next_open_redeem_1 = build_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        count_1,
        1,
        root_1,
        delta_daa,
    ).unwrap();

    let mut sig_sb_1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_1.add_data(&siblings_1[i].as_bytes()).unwrap();
    }
    sig_sb_1.add_data(&buyer_spk_1).unwrap();
    sig_sb_1.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_1.add_data(&open_redeem_0).unwrap();
    let sig_script_1 = sig_sb_1.drain();

    let tx_1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 100_000_000 + ticket_price * count_1,
            script_public_key: pay_to_script_hash_script(&next_open_redeem_1),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_1 = PopulatedTransaction::new(&tx_1, vec![UtxoEntry::new(
        100_000_000,
        pay_to_script_hash_script(&open_redeem_0),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_1 = CovenantsContext::from_tx(&pop_1).unwrap();
    let ctx_1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_1);
    let mut vm_1 = TxScriptEngine::from_transaction_input(&pop_1, &pop_1.tx.inputs[0], 0, &pop_1.entries[0], ctx_1, flags);
    let res_1 = vm_1.execute();
    assert_eq!(res_1, Ok(()));
    println!("  -> PASS: Valid BUY 1 transitioned OPEN(0,0) to OPEN(5,1)");

    // -------------------------------------------------------------
    // Test Case 2: Second Consecutive Purchase (OPEN(5,1) -> OPEN(15,2))
    // -------------------------------------------------------------
    println!("\n[Test 2] Consecutive Purchase OPEN(5,1) -> BUY 10 Tickets -> OPEN(sold=15, pc=2)");
    let buyer_spk_2 = vec![0x20, 0xaa, 0xbb, 0xcc];
    let count_2 = 10u64;

    let mut siblings_2 = [Hash::default(); TREE_DEPTH];
    siblings_2[0] = leaf_1;
    for i in 1..TREE_DEPTH {
        siblings_2[i] = empty_levels[i];
    }

    let payout_comm_2 = compute_payout_commitment(&buyer_spk_2);
    let leaf_2 = compute_purchase_leaf(&round_id, 1, 5, count_2, &payout_comm_2);
    let root_2 = compute_root_from_path(&leaf_2, 1, &siblings_2);

    let next_open_redeem_2 = build_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        15,
        2,
        root_2,
        delta_daa,
    ).unwrap();

    let mut sig_sb_2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_2.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_2.add_data(&buyer_spk_2).unwrap();
    sig_sb_2.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_2.add_data(&next_open_redeem_1).unwrap();
    let sig_script_2 = sig_sb_2.drain();

    let tx_2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_2,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 150_000_000 + ticket_price * count_2,
            script_public_key: pay_to_script_hash_script(&next_open_redeem_2),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_2 = PopulatedTransaction::new(&tx_2, vec![UtxoEntry::new(
        150_000_000,
        pay_to_script_hash_script(&next_open_redeem_1),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_2 = CovenantsContext::from_tx(&pop_2).unwrap();
    let ctx_2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_2);
    let mut vm_2 = TxScriptEngine::from_transaction_input(&pop_2, &pop_2.tx.inputs[0], 0, &pop_2.entries[0], ctx_2, flags);
    let res_2 = vm_2.execute();
    assert_eq!(res_2, Ok(()));
    println!("  -> PASS: Valid consecutive BUY transitioned OPEN(5,1) to OPEN(15,2)");

    // -------------------------------------------------------------
    // Test Case 3: Sold-Out Transition (OPEN -> SEALED)
    // -------------------------------------------------------------
    println!("\n[Test 3] Sold-Out Transition OPEN(15,2) -> BUY 85 Tickets -> SEALED");
    let buyer_spk_3 = vec![0x20, 0x33, 0x44, 0x55];
    let count_3 = 85u64; // exactly reaches 100 sold_tickets!

    // Compute sibling path for purchase_index = 2:
    // Bit 0 of 2 is 0 -> right sibling is empty_levels[0]
    // Bit 1 of 2 is 1 -> left sibling is parent of (leaf_1, leaf_2)
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
    let leaf_3 = compute_purchase_leaf(&round_id, 2, 15, count_3, &payout_comm_3);
    let root_3 = compute_root_from_path(&leaf_3, 2, &siblings_3);

    let sealed_redeem = build_sealed_to_draw_ready_covenant(
        round_id,
        root_3,
        total_tickets,
        delta_daa,
    ).unwrap();

    let mut sig_sb_3 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_3.add_data(&siblings_3[i].as_bytes()).unwrap();
    }
    sig_sb_3.add_data(&buyer_spk_3).unwrap();
    sig_sb_3.add_data(&count_3.to_le_bytes()).unwrap();
    sig_sb_3.add_data(&next_open_redeem_2).unwrap();
    let sig_script_3 = sig_sb_3.drain();

    let tx_3 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_3,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 250_000_000 + ticket_price * count_3,
            script_public_key: pay_to_script_hash_script(&sealed_redeem),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_3 = PopulatedTransaction::new(&tx_3, vec![UtxoEntry::new(
        250_000_000,
        pay_to_script_hash_script(&next_open_redeem_2),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_3 = CovenantsContext::from_tx(&pop_3).unwrap();
    let ctx_3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_3);
    let mut log_output_3 = Vec::new();
    let mut vm_3 = TxScriptEngine::from_transaction_input(&pop_3, &pop_3.tx.inputs[0], 0, &pop_3.entries[0], ctx_3, flags)
        .with_opcode_execution_log_buffer(&mut log_output_3);
    let res_3 = vm_3.execute();
    if res_3 != Ok(()) {
        let log_str = String::from_utf8_lossy(&log_output_3);
        let lines: Vec<&str> = log_str.lines().collect();
        println!("Test 3 failed! Total log lines: {}", lines.len());
        let start = if lines.len() > 30 { lines.len() - 30 } else { 0 };
        for l in &lines[start..] {
            println!("{}", l);
        }
    }
    assert_eq!(res_3, Ok(()));
    println!("  -> PASS: Sold out BUY atomically transitioned OPEN(15,2) to SEALED!");

    // -------------------------------------------------------------
    // Test Case 4: Standalone Winner Membership Verifier
    // -------------------------------------------------------------
    println!("\n[Test 4] Standalone Winner Membership Verifier Script (buyer 2: range [5, 15), winner = 12)");
    let winner_index = 12u64;
    assert!(reference_verify_winner_membership(
        &root_2,
        winner_index,
        &round_id,
        1,
        5,
        count_2,
        &buyer_spk_2,
        &siblings_2,
    ));

    let verifier_script = build_winner_membership_verifier_script(&round_id, &root_2, winner_index).unwrap();

    let mut sig_sb_4 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_4.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_4.add_data(&buyer_spk_2).unwrap();
    sig_sb_4.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_4.add_data(&5u64.to_le_bytes()).unwrap(); // start_ticket = 5
    sig_sb_4.add_data(&1u64.to_le_bytes()).unwrap(); // purchase_index = 1
    sig_sb_4.add_data(&verifier_script).unwrap();
    let sig_script_4 = sig_sb_4.drain();

    let tx_4 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_4.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 1000,
            script_public_key: pay_to_script_hash_script(&verifier_script),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_4 = PopulatedTransaction::new(&tx_4, vec![UtxoEntry::new(
        1000,
        pay_to_script_hash_script(&verifier_script),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_4 = CovenantsContext::from_tx(&pop_4).unwrap();
    let ctx_4 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_4);
    let mut vm_4 = TxScriptEngine::from_transaction_input(&pop_4, &pop_4.tx.inputs[0], 0, &pop_4.entries[0], ctx_4, flags);
    let res_4 = vm_4.execute();
    assert_eq!(res_4, Ok(()));
    println!("  -> PASS: On-chain Winner Membership Verifier verified winner = 12 against leaf 2 root!");

    // -------------------------------------------------------------
    // Test Case 5: Attack - Underpayment (Output 0 Amount < Required)
    // -------------------------------------------------------------
    println!("\n[Test 5] Attack: Underpayment (paying 0.4 KAS for 5 tickets costing 0.5 KAS)");
    let tx_underpay = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 100_000_000 + ticket_price * count_1 - 1, // 1 sompi short!
            script_public_key: pay_to_script_hash_script(&next_open_redeem_1),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_underpay = PopulatedTransaction::new(&tx_underpay, vec![UtxoEntry::new(
        100_000_000,
        pay_to_script_hash_script(&open_redeem_0),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_u = CovenantsContext::from_tx(&pop_underpay).unwrap();
    let ctx_u = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_u);
    let mut vm_u = TxScriptEngine::from_transaction_input(&pop_underpay, &pop_underpay.tx.inputs[0], 0, &pop_underpay.entries[0], ctx_u, flags);
    assert!(vm_u.execute().is_err());
    println!("  -> PASS: Underpayment attack blocked by OpGreaterThanOrEqual check!");

    // -------------------------------------------------------------
    // Test Case 6: Attack - Overselling (count exceeds remaining tickets)
    // -------------------------------------------------------------
    println!("\n[Test 6] Attack: Overselling (buying 86 tickets when only 85 remain)");
    let count_oversell = 86u64;
    let mut sig_sb_over = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_over.add_data(&siblings_3[i].as_bytes()).unwrap();
    }
    sig_sb_over.add_data(&buyer_spk_3).unwrap();
    sig_sb_over.add_data(&count_oversell.to_le_bytes()).unwrap();
    sig_sb_over.add_data(&next_open_redeem_2).unwrap();
    let sig_script_over = sig_sb_over.drain();

    let tx_over = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_over,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 250_000_000 + ticket_price * count_oversell,
            script_public_key: pay_to_script_hash_script(&sealed_redeem),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_over = PopulatedTransaction::new(&tx_over, vec![UtxoEntry::new(
        250_000_000,
        pay_to_script_hash_script(&next_open_redeem_2),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_o = CovenantsContext::from_tx(&pop_over).unwrap();
    let ctx_o = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_o);
    let mut vm_over = TxScriptEngine::from_transaction_input(&pop_over, &pop_over.tx.inputs[0], 0, &pop_over.entries[0], ctx_o, flags);
    assert!(vm_over.execute().is_err());
    println!("  -> PASS: Oversell attack blocked by sold_after <= total_tickets check!");

    // -------------------------------------------------------------
    // Test Case 7: Attack - Zero Ticket Purchase (count = 0)
    // -------------------------------------------------------------
    println!("\n[Test 7] Attack: Zero Ticket Purchase (count = 0)");
    let count_zero = 0u64;
    let mut sig_sb_zero = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_zero.add_data(&siblings_1[i].as_bytes()).unwrap();
    }
    sig_sb_zero.add_data(&buyer_spk_1).unwrap();
    sig_sb_zero.add_data(&count_zero.to_le_bytes()).unwrap();
    sig_sb_zero.add_data(&open_redeem_0).unwrap();
    let sig_script_zero = sig_sb_zero.drain();

    let tx_zero = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_zero,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 100_000_000,
            script_public_key: pay_to_script_hash_script(&open_redeem_0),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_zero = PopulatedTransaction::new(&tx_zero, vec![UtxoEntry::new(
        100_000_000,
        pay_to_script_hash_script(&open_redeem_0),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_z = CovenantsContext::from_tx(&pop_zero).unwrap();
    let ctx_z = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_z);
    let mut vm_zero = TxScriptEngine::from_transaction_input(&pop_zero, &pop_zero.tx.inputs[0], 0, &pop_zero.entries[0], ctx_z, flags);
    assert!(vm_zero.execute().is_err());
    println!("  -> PASS: Zero ticket purchase attack blocked by count >= 1 check!");

    // -------------------------------------------------------------
    // Test Case 8: Attack - Counterfeit SPK Successor Transition
    // -------------------------------------------------------------
    println!("\n[Test 8] Attack: Counterfeit Successor SPK (redirecting pool funds to attacker SPK)");
    let attacker_spk = kaspa_txscript::standard::pay_to_script_hash_script(&[0x51]); // OP_TRUE
    let tx_counterfeit = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 100_000_000 + ticket_price * count_1,
            script_public_key: attacker_spk,
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_counterfeit = PopulatedTransaction::new(&tx_counterfeit, vec![UtxoEntry::new(
        100_000_000,
        pay_to_script_hash_script(&open_redeem_0),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_c = CovenantsContext::from_tx(&pop_counterfeit).unwrap();
    let ctx_c = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_c);
    let mut vm_counterfeit = TxScriptEngine::from_transaction_input(&pop_counterfeit, &pop_counterfeit.tx.inputs[0], 0, &pop_counterfeit.entries[0], ctx_c, flags);
    assert!(vm_counterfeit.execute().is_err());
    println!("  -> PASS: Counterfeit SPK attack blocked by OpTxOutputSpk(0) check!");

    // -------------------------------------------------------------
    // Test Case 9: Attack - Merkle Fraud Sibling Injection
    // -------------------------------------------------------------
    println!("\n[Test 9] Attack: Merkle Fraud Path (tampered sibling hash in witness)");
    let mut tampered_siblings = siblings_1;
    tampered_siblings[5] = Hash::from_u64_word(0xbadbadbad);
    let mut sig_sb_tamper = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_tamper.add_data(&tampered_siblings[i].as_bytes()).unwrap();
    }
    sig_sb_tamper.add_data(&buyer_spk_1).unwrap();
    sig_sb_tamper.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_tamper.add_data(&open_redeem_0).unwrap();
    let sig_script_tamper = sig_sb_tamper.drain();

    let tx_tamper = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_tamper,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 100_000_000 + ticket_price * count_1,
            script_public_key: pay_to_script_hash_script(&next_open_redeem_1),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_tamper = PopulatedTransaction::new(&tx_tamper, vec![UtxoEntry::new(
        100_000_000,
        pay_to_script_hash_script(&open_redeem_0),
        1_000_000,
        false,
        None,
    )]);
    let cov_ctx_t = CovenantsContext::from_tx(&pop_tamper).unwrap();
    let ctx_t = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_t);
    let mut vm_tamper = TxScriptEngine::from_transaction_input(&pop_tamper, &pop_tamper.tx.inputs[0], 0, &pop_tamper.entries[0], ctx_t, flags);
    assert!(vm_tamper.execute().is_err());
    println!("  -> PASS: Tampered sibling attack fails because resulting root does not match output SPK!");

    // -------------------------------------------------------------
    // Test Case 10: Attack - Out-of-Bounds Winner Membership Index
    // -------------------------------------------------------------
    println!("\n[Test 10] Attack: Winner Membership out-of-bounds (winner = 15 for range [5, 15))");
    let out_of_bounds_winner = 15u64; // index 15 is NOT in [5, 15)!
    let verifier_script_oob = build_winner_membership_verifier_script(&round_id, &root_2, out_of_bounds_winner).unwrap();
    let mut sig_sb_oob = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_oob.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_oob.add_data(&buyer_spk_2).unwrap();
    sig_sb_oob.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_oob.add_data(&5u64.to_le_bytes()).unwrap();
    sig_sb_oob.add_data(&1u64.to_le_bytes()).unwrap();
    sig_sb_oob.add_data(&verifier_script_oob).unwrap();
    let sig_script_oob = sig_sb_oob.drain();

    let tx_oob = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_oob,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 1000,
            script_public_key: pay_to_script_hash_script(&verifier_script_oob),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_oob = PopulatedTransaction::new(&tx_oob, vec![UtxoEntry::new(
        1000,
        pay_to_script_hash_script(&verifier_script_oob),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_oob = CovenantsContext::from_tx(&pop_oob).unwrap();
    let ctx_oob = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_oob);
    let mut vm_oob = TxScriptEngine::from_transaction_input(&pop_oob, &pop_oob.tx.inputs[0], 0, &pop_oob.entries[0], ctx_oob, flags);
    assert!(vm_oob.execute().is_err());
    println!("  -> PASS: Out-of-bounds winner index blocked by winner < start + count check!");

    // -------------------------------------------------------------
    // Test Case 11: Attack - Fake Winner Payout SPK Substitution
    // -------------------------------------------------------------
    println!("\n[Test 11] Attack: Fake Winner Payout SPK (substituting thief SPK in Merkle leaf)");
    let thief_spk = vec![0x20, 0xde, 0xad, 0xbe, 0xef];
    let mut sig_sb_thief = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_thief.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_thief.add_data(&thief_spk).unwrap(); // substituted SPK!
    sig_sb_thief.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_thief.add_data(&5u64.to_le_bytes()).unwrap();
    sig_sb_thief.add_data(&1u64.to_le_bytes()).unwrap();
    sig_sb_thief.add_data(&verifier_script).unwrap();
    let sig_script_thief = sig_sb_thief.drain();

    let tx_thief = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_thief,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 1000,
            script_public_key: pay_to_script_hash_script(&verifier_script),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_thief = PopulatedTransaction::new(&tx_thief, vec![UtxoEntry::new(
        1000,
        pay_to_script_hash_script(&verifier_script),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_th = CovenantsContext::from_tx(&pop_thief).unwrap();
    let ctx_th = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_th);
    let mut vm_thief = TxScriptEngine::from_transaction_input(&pop_thief, &pop_thief.tx.inputs[0], 0, &pop_thief.entries[0], ctx_th, flags);
    assert!(vm_thief.execute().is_err());
    println!("  -> PASS: Fake payout SPK attack blocked because computed leaf root != ticket_root!");

    // -------------------------------------------------------------
    // Test Case 12: Resource Measurements
    // -------------------------------------------------------------
    println!("\n[Test 12] Resource Measurements");
    println!("  OPEN Prefix Length:                 {} bytes", open_redeem_0[0..105].len());
    println!("  OPEN Body Length:                   {} bytes", open_redeem_0.len() - 105);
    println!("  Total OPEN Redeem Script Length:    {} bytes", open_redeem_0.len());
    println!("  Winner Membership Verifier Length:  {} bytes", verifier_script.len());
    println!("  Witness Signature Script Length:    {} bytes (31 items)", sig_script_4.len());

    let calc = kaspa_consensus_core::mass::MassCalculator::new(1, 1, 10_000_000_000);
    let non_contextual = calc.calc_non_contextual_masses(&pop_1.tx);
    println!("  Non-Contextual BUY Tx Mass:         {:?}", non_contextual);

    println!("\n================================================================");
    println!("ALL 12 TEST CASES PASSED 100% IN TXSCRIPT ENGINE CONTEXT!");
    println!("================================================================");
}
