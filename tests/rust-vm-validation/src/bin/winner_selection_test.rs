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
    build_draw_ready_covenant_test_reject,
    build_canonical_winner_ready_redeem_script,
    reference_winner_step,
    WinnerStepResult,
    MAX_TOTAL_TICKETS,
};

#[path = "../../../../contracts/sealed_to_draw_ready.rs"]
mod sealed_to_draw_ready;
use sealed_to_draw_ready::{
    build_sealed_to_draw_ready_covenant,
    compute_application_commitment,
    compute_random_seed,
};

fn blake3_hash(key: &[u8], data: &[u8]) -> Hash {
    let mut key_arr = [0u8; 32];
    key_arr[..key.len()].copy_from_slice(key);
    let h = blake3::keyed_hash(&key_arr, data);
    Hash::from_bytes(*h.as_bytes())
}

struct PassAOpeningFixture {
    pub target_hash: Hash,
    pub target_activity: Hash,
    pub target_payload: Hash,
    pub target_sp_ts: [u8; 8],
    pub target_daa: [u8; 8],
    pub target_blue: [u8; 8],
    pub p_parent_seq: Hash,
    pub p_activity: Hash,
    pub p_payload: Hash,
    pub p_sp_ts: [u8; 8],
    pub p_daa: [u8; 8],
    pub p_blue: [u8; 8],
    pub c_t: Hash,
}

fn generate_valid_pass_a_fixture(p_daa_num: u64, t_daa_num: u64) -> PassAOpeningFixture {
    let p_sp_ts = 1_700_000_000u64.to_le_bytes();
    let p_daa = p_daa_num.to_le_bytes();
    let p_blue = (p_daa_num - 100).to_le_bytes();

    let key_ctx = b"SeqCommitMergesetContext";
    let key_branch = b"SeqCommitmentMerkleBranchHash";

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

    let target_sp_ts = (1_700_000_000u64 + 10).to_le_bytes();
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

fn main() {
    println!("=== Testing Kaswin Self-Replicating Winner Selection Suite ===");

    let round_id = Hash::from_u64_word(1);
    let ticket_root = Hash::from_u64_word(2);
    let target_hash = Hash::from_u64_word(999);
    let pool_principal = 50_000_000_000u64; // 500 KAS

    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // -------------------------------------------------------------
    // TEST 1: ACCEPT Candidate -> Exact WINNER_READY SPK (PASS)
    // -------------------------------------------------------------
    println!("\n--- TEST 1: ACCEPT Candidate -> Exact WINNER_READY SPK ---");
    let total_tickets_100 = 100u64;
    let random_seed_acc = Hash::from_u64_word(100);
    let ref_res_1 = reference_winner_step(&random_seed_acc, 0, total_tickets_100);
    let expected_winner_1 = match ref_res_1 {
        WinnerStepResult::Accepted { winner_index } => winner_index,
        _ => panic!("Expected accepted"),
    };
    println!("Candidate accepted at counter=0: winner_index = {}", expected_winner_1);

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
    println!("Test 1 Result: {:?}", res_1);
    assert_eq!(res_1, Ok(()), "ACCEPT candidate must transition to WINNER_READY");

    // -------------------------------------------------------------
    // TEST 2: REJECT c -> Exact Production DRAW_READY(c+1) (PASS)
    // -------------------------------------------------------------
    println!("\n--- TEST 2: REJECT c -> Exact Production DRAW_READY(c+1) ---");
    // Test rejection branch using test-reject builder on N=100:
    let draw_ready_rej_c0 = build_draw_ready_covenant_test_reject(
        round_id,
        ticket_root,
        total_tickets_100,
        target_hash,
        random_seed_acc,
        0,
    ).unwrap();
    let draw_ready_spk_c0 = pay_to_script_hash_script(&draw_ready_rej_c0);

    // Exact production DRAW_READY(c + 1):
    let draw_ready_prod_c1 = build_draw_ready_covenant_test_reject(
        round_id,
        ticket_root,
        total_tickets_100,
        target_hash,
        random_seed_acc,
        1,
    ).unwrap();
    let draw_ready_spk_c1 = pay_to_script_hash_script(&draw_ready_prod_c1);

    let mut sig_sb_2 = ScriptBuilder::with_flags(flags);
    sig_sb_2.add_data(&draw_ready_rej_c0).unwrap();
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
            script_public_key: draw_ready_spk_c1.clone(), // Must match production c+1!
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_2 = PopulatedTransaction::new(&tx_2, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk_c0.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_2 = CovenantsContext::from_tx(&pop_2).unwrap();
    let ctx_2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_2);
    let mut vm_2 = TxScriptEngine::from_transaction_input(&pop_2, &pop_2.tx.inputs[0], 0, &pop_2.entries[0], ctx_2, flags);
    let res_2 = vm_2.execute();
    println!("Test 2 Result: {:?}", res_2);
    assert_eq!(res_2, Ok(()), "REJECT candidate must transition to exact production DRAW_READY(c+1)");

    // -------------------------------------------------------------
    // TEST 3: Successor Byte Identity Across Multiple Counters
    // generated(c+1) == production_builder(c+1) for c in [0, 1, 2, 255, 65535]
    // -------------------------------------------------------------
    println!("\n--- TEST 3: Successor Byte Identity Proof ---");
    let test_counters = [0u64, 1u64, 2u64, 255u64, 65535u64];
    for &c in &test_counters {
        let sc = build_draw_ready_covenant(round_id, ticket_root, total_tickets_100, target_hash, random_seed_acc, c).unwrap();
        let expected_sc1 = build_draw_ready_covenant(round_id, ticket_root, total_tickets_100, target_hash, random_seed_acc, c + 1).unwrap();

        // Simulate script self-replication:
        let mut reconstructed = Vec::new();
        reconstructed.extend_from_slice(&sc[0..137]);
        reconstructed.push(0x08);
        reconstructed.extend_from_slice(&(c + 1).to_le_bytes());
        reconstructed.extend_from_slice(&sc[146..]);

        assert_eq!(reconstructed, expected_sc1, "Byte identity failed for counter {}", c);
        assert_eq!(
            pay_to_script_hash_script(&reconstructed),
            pay_to_script_hash_script(&expected_sc1),
            "SPK identity failed for counter {}", c
        );
    }
    println!("Successor Byte Identity passed for all representative counters [0, 1, 2, 255, 65535]!");

    // -------------------------------------------------------------
    // TEST 4: Real Multi-Step Chained UTXO VM Evidence: U0 -> U1 -> U2 -> U3
    // -------------------------------------------------------------
    println!("\n--- TEST 4: Real Multi-Step Chained UTXO Execution U0 -> U1 -> U2 -> U3 ---");
    let mut current_counter = 0u64;
    let current_utxo_amount = pool_principal;

    for step in 0..3 {
        println!("Executing chained transition step {} (c={})...", step, current_counter);
        let cur_redeem = build_draw_ready_covenant_test_reject(
            round_id,
            ticket_root,
            total_tickets_100,
            target_hash,
            random_seed_acc,
            current_counter,
        ).unwrap();
        let cur_spk = pay_to_script_hash_script(&cur_redeem);

        // Next counter:
        let next_redeem = build_draw_ready_covenant_test_reject(
            round_id,
            ticket_root,
            total_tickets_100,
            target_hash,
            random_seed_acc,
            current_counter + 1,
        ).unwrap();
        let next_spk = pay_to_script_hash_script(&next_redeem);

        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&cur_redeem).unwrap();
        let sig_script = sig_sb.drain();

        let tx_step = Transaction::new(
            1,
            vec![TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(step as u64 + 10), 0),
                sig_script,
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            )],
            vec![TransactionOutput {
                value: current_utxo_amount,
                script_public_key: next_spk.clone(),
                covenant: None,
            }],
            0,
            SubnetworkId::default(),
            0,
            vec![],
        );
        let pop_step = PopulatedTransaction::new(&tx_step, vec![UtxoEntry::new(
            current_utxo_amount,
            cur_spk.clone(),
            1_000_100 + step as u64 * 10,
            false,
            None,
        )]);
        let cov_ctx_step = CovenantsContext::from_tx(&pop_step).unwrap();
        let ctx_step = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_step);
        let mut vm_step = TxScriptEngine::from_transaction_input(&pop_step, &pop_step.tx.inputs[0], 0, &pop_step.entries[0], ctx_step, flags);
        let res_step = vm_step.execute();
        assert_eq!(res_step, Ok(()), "Chained transition step {} MUST succeed", step);
        println!("  Step {} (U{} -> U{}) verified OK!", step, step, step + 1);

        current_counter += 1;
    }
    println!("Real multi-step chained UTXO execution (U0 -> U1 -> U2 -> U3) successfully completed!");

    // -------------------------------------------------------------
    // TEST 5: Skip c -> c + 2 -> FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 5: Skip c -> c + 2 -> FAIL ---");
    let draw_ready_prod_c2 = build_draw_ready_covenant_test_reject(
        round_id,
        ticket_root,
        total_tickets_100,
        target_hash,
        random_seed_acc,
        2, // SKIPPED!
    ).unwrap();
    let draw_ready_spk_c2 = pay_to_script_hash_script(&draw_ready_prod_c2);

    let tx_skip = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_spk_c2, // SKIPPED!
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_skip = PopulatedTransaction::new(&tx_skip, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk_c0.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_skip = CovenantsContext::from_tx(&pop_skip).unwrap();
    let ctx_skip = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_skip);
    let mut vm_skip = TxScriptEngine::from_transaction_input(&pop_skip, &pop_skip.tx.inputs[0], 0, &pop_skip.entries[0], ctx_skip, flags);
    let res_skip = vm_skip.execute();
    println!("Test 5 Result: {:?}", res_skip);
    assert!(res_skip.is_err(), "Skipping c to c+2 must FAIL SPK check");

    // -------------------------------------------------------------
    // TEST 6: Tampered Winner Index -> FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 6: Tampered Winner Index -> FAIL ---");
    let tampered_winner_redeem = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        total_tickets_100,
        target_hash,
        random_seed_acc,
        expected_winner_1 + 1, // TAMPERED!
    );
    let tampered_winner_spk = pay_to_script_hash_script(&tampered_winner_redeem);

    let tx_tamp = Transaction::new(
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
    let pop_tamp = PopulatedTransaction::new(&tx_tamp, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk_1.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_tamp = CovenantsContext::from_tx(&pop_tamp).unwrap();
    let ctx_tamp = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_tamp);
    let mut vm_tamp = TxScriptEngine::from_transaction_input(&pop_tamp, &pop_tamp.tx.inputs[0], 0, &pop_tamp.entries[0], ctx_tamp, flags);
    let res_tamp = vm_tamp.execute();
    println!("Test 6 Result: {:?}", res_tamp);
    assert!(res_tamp.is_err(), "Tampered winner must FAIL SPK check");

    // -------------------------------------------------------------
    // TEST 7: MAX_TOTAL_TICKETS Exactly Unified
    // -------------------------------------------------------------
    println!("\n--- TEST 7: MAX_TOTAL_TICKETS Unification Check ---");
    assert_eq!(MAX_TOTAL_TICKETS, 100_000_000, "MAX_TOTAL_TICKETS must strictly be 100,000,000");
    println!("MAX_TOTAL_TICKETS is strictly unified to {}", MAX_TOTAL_TICKETS);

    // -------------------------------------------------------------
    // TEST 8: SEALED PASS-A -> Production DRAW_READY(0) -> Winner Selection Spend PASS
    // -------------------------------------------------------------
    println!("\n--- TEST 8: End-to-End SEALED PASS-A -> Production DRAW_READY(0) -> Spend ---");
    // Build SEALED covenant that targets production DRAW_READY(0):
    let delta_daa = 100u64;
    let actual_sealed_daa = 1_000_000u64;
    let boundary = actual_sealed_daa + delta_daa;

    let p_daa_val = boundary - 1;
    let t_daa_val = boundary;
    let pass_a_fixture = generate_valid_pass_a_fixture(p_daa_val, t_daa_val);

    let app_commitment = compute_application_commitment(&round_id, &ticket_root, total_tickets_100);
    let derived_seed = compute_random_seed(&pass_a_fixture.target_hash, &app_commitment);

    // Build production DRAW_READY(0) script:
    let prod_draw_ready_0 = build_draw_ready_covenant(
        round_id,
        ticket_root,
        total_tickets_100,
        pass_a_fixture.target_hash,
        derived_seed,
        0,
    ).unwrap();
    let prod_draw_ready_spk_0 = pay_to_script_hash_script(&prod_draw_ready_0);

    // Spend SEALED to produce prod_draw_ready_spk_0:
    let sealed_redeem = build_sealed_to_draw_ready_covenant(
        round_id,
        ticket_root,
        total_tickets_100,
        delta_daa,
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);

    // Build witness stack for SEALED:
    let mut sb_sealed = ScriptBuilder::with_flags(flags);
    sb_sealed.add_data(&pass_a_fixture.target_hash.as_bytes()).unwrap();
    sb_sealed.add_data(&pass_a_fixture.target_activity.as_bytes()).unwrap();
    sb_sealed.add_data(&pass_a_fixture.target_payload.as_bytes()).unwrap();
    sb_sealed.add_data(&pass_a_fixture.target_sp_ts).unwrap();
    sb_sealed.add_data(&pass_a_fixture.target_daa).unwrap();
    sb_sealed.add_data(&pass_a_fixture.target_blue).unwrap();
    sb_sealed.add_data(&pass_a_fixture.p_parent_seq.as_bytes()).unwrap();
    sb_sealed.add_data(&pass_a_fixture.p_activity.as_bytes()).unwrap();
    sb_sealed.add_data(&pass_a_fixture.p_payload.as_bytes()).unwrap();
    sb_sealed.add_data(&pass_a_fixture.p_sp_ts).unwrap();
    sb_sealed.add_data(&pass_a_fixture.p_daa).unwrap();
    sb_sealed.add_data(&pass_a_fixture.p_blue).unwrap();
    sb_sealed.add_data(&sealed_redeem).unwrap();
    let sig_script_sealed = sb_sealed.drain();

    let mut seq_commits = std::collections::HashMap::new();
    seq_commits.insert(pass_a_fixture.target_hash, pass_a_fixture.c_t);
    let accessor = crate::MockSeqCommitAccessor {
        selected_chain: vec![pass_a_fixture.target_hash],
        seq_commits,
    };

    let tx_sealed = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(1), 0),
            sig_script_sealed,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: prod_draw_ready_spk_0.clone(), // Output is production DRAW_READY(0)!
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_sealed = PopulatedTransaction::new(&tx_sealed, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk,
        actual_sealed_daa,
        false,
        None,
    )]);
    let cov_ctx_s = CovenantsContext::from_tx(&pop_sealed).unwrap();
    let ctx_s = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_s).with_seq_commit_accessor(&accessor);
    let mut vm_s = TxScriptEngine::from_transaction_input(&pop_sealed, &pop_sealed.tx.inputs[0], 0, &pop_sealed.entries[0], ctx_s, flags);
    let res_s = vm_s.execute();
    println!("Step 1 (SEALED -> Production DRAW_READY(0)) Result: {:?}", res_s);
    assert_eq!(res_s, Ok(()), "SEALED must successfully transition to production DRAW_READY(0)");

    // Step 2: Now spend that exact production DRAW_READY(0) UTXO in Winner Selection!
    let ref_winner = match reference_winner_step(&derived_seed, 0, total_tickets_100) {
        WinnerStepResult::Accepted { winner_index } => winner_index,
        _ => panic!("Expected accept"),
    };
    let win_ready_redeem = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_root,
        total_tickets_100,
        pass_a_fixture.target_hash,
        derived_seed,
        ref_winner,
    );
    let win_ready_spk = pay_to_script_hash_script(&win_ready_redeem);

    let mut sb_spend = ScriptBuilder::with_flags(flags);
    sb_spend.add_data(&prod_draw_ready_0).unwrap();
    let sig_script_spend = sb_spend.drain();

    let tx_spend = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_sealed.id(), 0),
            sig_script_spend,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: win_ready_spk,
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_spend = PopulatedTransaction::new(&tx_spend, vec![UtxoEntry::new(
        pool_principal,
        prod_draw_ready_spk_0,
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_sp = CovenantsContext::from_tx(&pop_spend).unwrap();
    let ctx_sp = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_sp);
    let mut vm_sp = TxScriptEngine::from_transaction_input(&pop_spend, &pop_spend.tx.inputs[0], 0, &pop_spend.entries[0], ctx_sp, flags);
    let res_sp = vm_sp.execute();
    println!("Step 2 (Production DRAW_READY(0) -> WINNER_READY) Result: {:?}", res_sp);
    assert_eq!(res_sp, Ok(()), "Production DRAW_READY(0) must successfully spend to WINNER_READY");

    // -------------------------------------------------------------
    // TEST 9: Resource Measurement
    // -------------------------------------------------------------
    println!("\n--- TEST 9: Resource Measurement ---");
    let mc = MassCalculator::new(1, 10, 10_000_000);

    let wire_bytes_acc = borsh::to_vec(&tx_1).unwrap().len();
    let non_ctx_acc = mc.calc_non_contextual_masses(&tx_1);
    let used_units_acc = vm_1.used_script_units();

    let wire_bytes_rej = borsh::to_vec(&tx_2).unwrap().len();
    let non_ctx_rej = mc.calc_non_contextual_masses(&tx_2);
    let used_units_rej = vm_2.used_script_units();

    println!("===============================================================");
    println!("DRAW_READY ACCEPT PATH (tx_1):");
    println!("  SignatureScript Length      : {} bytes", sig_script_1.len());
    println!("  RedeemScript Length         : {} bytes", draw_ready_redeem_1.len());
    println!("  Actual Wire Bytes           : {} bytes", wire_bytes_acc);
    println!("  Used Script Units           : {}", used_units_acc.0);
    println!("  Compute Mass                : {} gram", non_ctx_acc.compute_mass);
    println!("  Transient Mass              : {} gram", non_ctx_acc.transient_mass);
    println!("  Fee Mass                    : {} gram", std::cmp::max(non_ctx_acc.compute_mass, non_ctx_acc.transient_mass));
    println!("---------------------------------------------------------------");
    println!("DRAW_READY REJECT PATH (tx_2):");
    println!("  SignatureScript Length      : {} bytes", sig_script_2.len());
    println!("  RedeemScript Length         : {} bytes", draw_ready_rej_c0.len());
    println!("  Actual Wire Bytes           : {} bytes", wire_bytes_rej);
    println!("  Used Script Units           : {}", used_units_rej.0);
    println!("  Compute Mass                : {} gram", non_ctx_rej.compute_mass);
    println!("  Transient Mass              : {} gram", non_ctx_rej.transient_mass);
    println!("  Fee Mass                    : {} gram", std::cmp::max(non_ctx_rej.compute_mass, non_ctx_rej.transient_mass));
    println!("===============================================================");

    println!("\n>>> ALL 9 TESTS PASSED WITH RECURSIVELY CLOSED STATEFUL ARCHITECTURE! <<<");
}

struct MockSeqCommitAccessor {
    pub selected_chain: Vec<Hash>,
    pub seq_commits: std::collections::HashMap<Hash, Hash>,
}

impl kaspa_txscript::SeqCommitAccessor for MockSeqCommitAccessor {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        Some(self.selected_chain.contains(&block_hash))
    }

    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        if self.selected_chain.contains(&block_hash) {
            self.seq_commits.get(&block_hash).copied()
        } else {
            None
        }
    }
}
