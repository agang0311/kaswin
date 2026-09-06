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
use kaspa_consensus_core::mass::{ComputeBudget, MassCalculator};
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;

#[path = "../../../../contracts/winner_selection.rs"]
mod winner_selection;
use winner_selection::{
    build_draw_ready_covenant,
    build_canonical_winner_ready_redeem_script,
    compute_draw_ready_spk_bytes,
    reference_winner_step,
    extract_candidate_num,
    compute_candidate_hash,
    WinnerStepResult,
    DOMAIN_R_56,
};

fn main() {
    println!("=== Testing Kaswin Stateful Rejection Sampling Winner Selection Suite ===");

    let round_id = Hash::from_u64_word(1);
    let ticket_root = Hash::from_u64_word(2);
    let target_hash = Hash::from_u64_word(999);
    let pool_principal = 50_000_000_000u64; // 500 KAS

    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // -------------------------------------------------------------
    // TEST 1: N=100 Canonical Candidate Accepted -> matches Rust reference
    // -------------------------------------------------------------
    println!("\n--- TEST 1: N=100 Canonical Candidate Accepted ---");
    let total_tickets_100 = 100u64;
    let random_seed_acc = Hash::from_u64_word(100);
    let ref_res_1 = reference_winner_step(&random_seed_acc, 0, total_tickets_100);
    let expected_winner_1 = match ref_res_1 {
        WinnerStepResult::Accepted { winner_index } => winner_index,
        _ => panic!("Expected accepted"),
    };
    println!("Found accepted seed at counter=0: winner_index = {}", expected_winner_1);

    let draw_ready_redeem_1 = build_draw_ready_covenant(
        round_id,
        ticket_root,
        total_tickets_100,
        target_hash,
        random_seed_acc,
        0,
    ).unwrap();
    let draw_ready_spk_1 = pay_to_script_hash_script(&draw_ready_redeem_1);

    let winner_ready_redeem_1 = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        total_tickets_100,
        target_hash,
        random_seed_acc,
        expected_winner_1,
    );
    let winner_ready_spk_1 = pay_to_script_hash_script(&winner_ready_redeem_1);

    let mut sig_sb_1 = ScriptBuilder::with_flags(flags);
    sig_sb_1.add_data(&draw_ready_redeem_1).unwrap();
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
            value: pool_principal,
            script_public_key: winner_ready_spk_1.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_1 = PopulatedTransaction::new(&tx_1, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk_1.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_1 = CovenantsContext::from_tx(&pop_1).unwrap();
    let ctx_1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_1);
    let mut vm_1 = TxScriptEngine::from_transaction_input(&pop_1, &pop_1.tx.inputs[0], 0, &pop_1.entries[0], ctx_1, flags);
    let res_1 = vm_1.execute();
    println!("Test 1 VM execution result: {:?}", res_1);
    assert_eq!(res_1, Ok(()), "N=100 accepted candidate MUST pass and match reference winner");

    // -------------------------------------------------------------
    // TEST 2: Rejection Zone Candidate -> MUST advance to DRAW_READY(counter + 1)
    // -------------------------------------------------------------
    println!("\n--- TEST 2: Rejection Zone Candidate -> DRAW_READY(counter+1) ---");
    let rej_seed = Hash::from_u64_word(1);
    let rej_counter = 0u64;
    let cand_num = extract_candidate_num(&compute_candidate_hash(&rej_seed, rej_counter));
    let n_rej = cand_num as u64;
    let r = DOMAIN_R_56;
    let limit_2 = (r / n_rej as i64) * n_rej as i64;
    println!("cand_num: {}, limit_2: {}, candidate_num < limit: {}", cand_num, limit_2, cand_num < limit_2);
    assert!(cand_num >= limit_2, "Must be in rejection zone!");
    assert_eq!(reference_winner_step(&rej_seed, rej_counter, n_rej), WinnerStepResult::Rejected { next_counter: rej_counter + 1 });

    // Build DRAW_READY(c):
    let draw_ready_rej_redeem = build_draw_ready_covenant(
        round_id,
        ticket_root,
        n_rej,
        target_hash,
        rej_seed,
        rej_counter,
    ).unwrap();
    let draw_ready_rej_spk = pay_to_script_hash_script(&draw_ready_rej_redeem);

    // Expected successor SPK is DRAW_READY(c + 1) calculated via helper:
    let next_spk_bytes = compute_draw_ready_spk_bytes(
        &round_id,
        &ticket_root,
        n_rej,
        &target_hash,
        &rej_seed,
        rej_counter + 1,
    );
    // Convert SPK bytes to ScriptPublicKey:
    // format of next_spk_bytes: [0x00, 0x00, script_bytes...]
    let draw_ready_next_spk = kaspa_consensus_core::tx::ScriptPublicKey::new(
        u16::from_be_bytes([next_spk_bytes[0], next_spk_bytes[1]]),
        kaspa_consensus_core::tx::ScriptVec::from_slice(&next_spk_bytes[2..]),
    );

    let mut sig_sb_2 = ScriptBuilder::with_flags(flags);
    sig_sb_2.add_data(&draw_ready_rej_redeem).unwrap();
    let sig_script_2 = sig_sb_2.drain();

    let tx_2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_next_spk.clone(), // Successor has counter + 1!
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_2 = PopulatedTransaction::new(&tx_2, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_rej_spk.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_2 = CovenantsContext::from_tx(&pop_2).unwrap();
    let ctx_2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_2);
    let mut vm_2 = TxScriptEngine::from_transaction_input(&pop_2, &pop_2.tx.inputs[0], 0, &pop_2.entries[0], ctx_2, flags);
    let res_2 = vm_2.execute();
    println!("Test 2 VM execution result: {:?}", res_2);
    assert_eq!(res_2, Ok(()), "Rejected candidate MUST successfully advance to DRAW_READY(counter + 1)");

    // -------------------------------------------------------------
    // TEST 3: Rejection Successor Attempt: Skip to counter + 2 -> FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 3: Rejection Successor Attempt counter + 2 -> FAIL ---");
    let draw_ready_skip2_bytes = compute_draw_ready_spk_bytes(
        &round_id,
        &ticket_root,
        n_rej,
        &target_hash,
        &rej_seed,
        rej_counter + 2, // SKIPPED TO COUNTER + 2!
    );
    let draw_ready_skip2_spk = kaspa_consensus_core::tx::ScriptPublicKey::new(
        u16::from_be_bytes([draw_ready_skip2_bytes[0], draw_ready_skip2_bytes[1]]),
        kaspa_consensus_core::tx::ScriptVec::from_slice(&draw_ready_skip2_bytes[2..]),
    );

    let tx_3 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_skip2_spk, // SKIPPED!
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_3 = PopulatedTransaction::new(&tx_3, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_rej_spk.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_3 = CovenantsContext::from_tx(&pop_3).unwrap();
    let ctx_3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_3);
    let mut vm_3 = TxScriptEngine::from_transaction_input(&pop_3, &pop_3.tx.inputs[0], 0, &pop_3.entries[0], ctx_3, flags);
    let res_3 = vm_3.execute();
    println!("Test 3 Result: {:?}", res_3);
    assert!(res_3.is_err(), "Skipping counter to c+2 MUST fail SPK check");

    // -------------------------------------------------------------
    // TEST 4: Caller attempts to force WINNER_READY when candidate was rejected -> FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 4: Attempting WINNER_READY on rejected candidate -> FAIL ---");
    let fake_winner_redeem = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        n_rej,
        target_hash,
        rej_seed,
        0,
    );
    let fake_winner_spk = pay_to_script_hash_script(&fake_winner_redeem);

    let tx_4 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: fake_winner_spk,
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_4 = PopulatedTransaction::new(&tx_4, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_rej_spk.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_4 = CovenantsContext::from_tx(&pop_4).unwrap();
    let ctx_4 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_4);
    let mut vm_4 = TxScriptEngine::from_transaction_input(&pop_4, &pop_4.tx.inputs[0], 0, &pop_4.entries[0], ctx_4, flags);
    let res_4 = vm_4.execute();
    println!("Test 4 Result: {:?}", res_4);
    assert!(res_4.is_err(), "Cannot force WINNER_READY when candidate was rejected");

    // -------------------------------------------------------------
    // TEST 5: Accepted candidate but tampered winner_index -> FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 5: Tampered winner_index -> FAIL ---");
    let tampered_winner_index = expected_winner_1 + 1; // TAMPERED!
    let tampered_winner_redeem = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        total_tickets_100,
        target_hash,
        random_seed_acc,
        tampered_winner_index,
    );
    let tampered_winner_spk = pay_to_script_hash_script(&tampered_winner_redeem);

    let tx_5 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: tampered_winner_spk,
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_5 = PopulatedTransaction::new(&tx_5, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk_1.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_5 = CovenantsContext::from_tx(&pop_5).unwrap();
    let ctx_5 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_5);
    let mut vm_5 = TxScriptEngine::from_transaction_input(&pop_5, &pop_5.tx.inputs[0], 0, &pop_5.entries[0], ctx_5, flags);
    let res_5 = vm_5.execute();
    println!("Test 5 Result: {:?}", res_5);
    assert!(res_5.is_err(), "Tampered winner_index must fail SPK verification");

    // -------------------------------------------------------------
    // TEST 6: N = 1 -> Winner must strictly be 0
    // -------------------------------------------------------------
    println!("\n--- TEST 6: N = 1 Edge Case ---");
    let n_1 = 1u64;
    assert_eq!(reference_winner_step(&random_seed_acc, 0, n_1), WinnerStepResult::Accepted { winner_index: 0 });

    let draw_ready_redeem_n1 = build_draw_ready_covenant(
        round_id,
        ticket_root,
        n_1,
        target_hash,
        random_seed_acc,
        0,
    ).unwrap();
    let draw_ready_spk_n1 = pay_to_script_hash_script(&draw_ready_redeem_n1);

    let winner_ready_redeem_n1 = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        n_1,
        target_hash,
        random_seed_acc,
        0,
    );
    let winner_ready_spk_n1 = pay_to_script_hash_script(&winner_ready_redeem_n1);

    let mut sig_sb_6 = ScriptBuilder::with_flags(flags);
    sig_sb_6.add_data(&draw_ready_redeem_n1).unwrap();
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
            value: pool_principal,
            script_public_key: winner_ready_spk_n1,
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_6 = PopulatedTransaction::new(&tx_6, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk_n1,
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_6 = CovenantsContext::from_tx(&pop_6).unwrap();
    let ctx_6 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_6);
    let mut vm_6 = TxScriptEngine::from_transaction_input(&pop_6, &pop_6.tx.inputs[0], 0, &pop_6.entries[0], ctx_6, flags);
    let res_6 = vm_6.execute();
    println!("Test 6 Result: {:?}", res_6);
    assert_eq!(res_6, Ok(()), "N = 1 must strictly yield winner = 0");

    // -------------------------------------------------------------
    // TEST 7: Representative Non-Power-of-Two N (N = 37)
    // -------------------------------------------------------------
    println!("\n--- TEST 7: Representative Non-Power-of-Two N (N = 37) ---");
    let n_37 = 37u64;
    let ref_37 = reference_winner_step(&random_seed_acc, 0, n_37);
    let expected_winner_37 = match ref_37 {
        WinnerStepResult::Accepted { winner_index } => winner_index,
        _ => panic!("Expected accept for this seed"),
    };
    let draw_ready_redeem_37 = build_draw_ready_covenant(
        round_id,
        ticket_root,
        n_37,
        target_hash,
        random_seed_acc,
        0,
    ).unwrap();
    let draw_ready_spk_37 = pay_to_script_hash_script(&draw_ready_redeem_37);

    let winner_ready_redeem_37 = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        n_37,
        target_hash,
        random_seed_acc,
        expected_winner_37,
    );
    let winner_ready_spk_37 = pay_to_script_hash_script(&winner_ready_redeem_37);

    let mut sig_sb_7 = ScriptBuilder::with_flags(flags);
    sig_sb_7.add_data(&draw_ready_redeem_37).unwrap();
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
            value: pool_principal,
            script_public_key: winner_ready_spk_37,
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_7 = PopulatedTransaction::new(&tx_7, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk_37,
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_7 = CovenantsContext::from_tx(&pop_7).unwrap();
    let ctx_7 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_7);
    let mut vm_7 = TxScriptEngine::from_transaction_input(&pop_7, &pop_7.tx.inputs[0], 0, &pop_7.entries[0], ctx_7, flags);
    let res_7 = vm_7.execute();
    println!("Test 7 Result (N=37): {:?}", res_7);
    assert_eq!(res_7, Ok(()), "N = 37 non-power-of-two MUST pass and match reference");

    // -------------------------------------------------------------
    // TEST 8: Large N Boundary (10,000,000 tickets)
    // -------------------------------------------------------------
    println!("\n--- TEST 8: Large N Boundary (10M tickets) ---");
    let n_10m = 10_000_000u64;
    let ref_10m = reference_winner_step(&random_seed_acc, 0, n_10m);
    let expected_winner_10m = match ref_10m {
        WinnerStepResult::Accepted { winner_index } => winner_index,
        _ => panic!("Expected accept for this seed"),
    };
    let draw_ready_redeem_10m = build_draw_ready_covenant(
        round_id,
        ticket_root,
        n_10m,
        target_hash,
        random_seed_acc,
        0,
    ).unwrap();
    let draw_ready_spk_10m = pay_to_script_hash_script(&draw_ready_redeem_10m);

    let winner_ready_redeem_10m = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        n_10m,
        target_hash,
        random_seed_acc,
        expected_winner_10m,
    );
    let winner_ready_spk_10m = pay_to_script_hash_script(&winner_ready_redeem_10m);

    let mut sig_sb_8 = ScriptBuilder::with_flags(flags);
    sig_sb_8.add_data(&draw_ready_redeem_10m).unwrap();
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
            value: pool_principal,
            script_public_key: winner_ready_spk_10m,
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_8 = PopulatedTransaction::new(&tx_8, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk_10m,
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_8 = CovenantsContext::from_tx(&pop_8).unwrap();
    let ctx_8 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_8);
    let mut vm_8 = TxScriptEngine::from_transaction_input(&pop_8, &pop_8.tx.inputs[0], 0, &pop_8.entries[0], ctx_8, flags);
    let res_8 = vm_8.execute();
    println!("Test 8 Result (N=10M): {:?}", res_8);
    assert_eq!(res_8, Ok(()), "N = 10M tickets MUST pass without arithmetic overflow");

    // -------------------------------------------------------------
    // TEST 9: Resource Measurement for ACCEPT & REJECT paths
    // -------------------------------------------------------------
    println!("\n--- TEST 9: Resource Measurement for ACCEPT & REJECT paths ---");
    let mc = MassCalculator::new(1, 10, 10_000_000);

    // Accept Path (tx_1):
    let wire_bytes_acc = borsh::to_vec(&tx_1).unwrap().len();
    let non_ctx_acc = mc.calc_non_contextual_masses(&tx_1);
    let used_units_acc = vm_1.used_script_units();

    // Reject Path (tx_2):
    let wire_bytes_rej = borsh::to_vec(&tx_2).unwrap().len();
    let non_ctx_rej = mc.calc_non_contextual_masses(&tx_2);
    let used_units_rej = vm_2.used_script_units();

    println!("===============================================================");
    println!("DRAW_READY ACCEPT PATH Resources:");
    println!("  SignatureScript Length      : {} bytes", sig_script_1.len());
    println!("  RedeemScript Length         : {} bytes", draw_ready_redeem_1.len());
    println!("  Actual Serialized Wire Bytes: {} bytes", wire_bytes_acc);
    println!("  Used Script Units           : {}", used_units_acc.0);
    println!("  Compute Mass                : {} gram", non_ctx_acc.compute_mass);
    println!("  Transient Mass              : {} gram", non_ctx_acc.transient_mass);
    println!("  Storage Mass                : 0 gram");
    println!("  Fee Mass (Overall)          : {} gram", std::cmp::max(non_ctx_acc.compute_mass, non_ctx_acc.transient_mass));
    println!("  Minimum Relay Fee           : {} sompi ({:.6} KAS)", std::cmp::max(non_ctx_acc.compute_mass, non_ctx_acc.transient_mass) * 100, (std::cmp::max(non_ctx_acc.compute_mass, non_ctx_acc.transient_mass) * 100) as f64 / 1e8);
    println!("---------------------------------------------------------------");
    println!("DRAW_READY REJECT PATH Resources:");
    println!("  SignatureScript Length      : {} bytes", sig_script_2.len());
    println!("  RedeemScript Length         : {} bytes", draw_ready_rej_redeem.len());
    println!("  Actual Serialized Wire Bytes: {} bytes", wire_bytes_rej);
    println!("  Used Script Units           : {}", used_units_rej.0);
    println!("  Compute Mass                : {} gram", non_ctx_rej.compute_mass);
    println!("  Transient Mass              : {} gram", non_ctx_rej.transient_mass);
    println!("  Storage Mass                : 0 gram");
    println!("  Fee Mass (Overall)          : {} gram", std::cmp::max(non_ctx_rej.compute_mass, non_ctx_rej.transient_mass));
    println!("  Minimum Relay Fee           : {} sompi ({:.6} KAS)", std::cmp::max(non_ctx_rej.compute_mass, non_ctx_rej.transient_mass) * 100, (std::cmp::max(non_ctx_rej.compute_mass, non_ctx_rej.transient_mass) * 100) as f64 / 1e8);
    println!("===============================================================");

    println!("\n>>> ALL TESTS 1 THROUGH 9 IN WINNER SELECTION SUITE PASSED! <<<");
}
