use kaspa_hashes::Hash;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ComputeCommit, CovenantBinding,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    script_builder::ScriptBuilder,
    covenants::CovenantsContext,
    standard::pay_to_script_hash_script,
};
use kaspa_consensus_core::mass::ComputeBudget;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;

#[path = "../../../../contracts/winner_selection.rs"]
mod winner_selection;
use winner_selection::{
    build_draw_ready_covenant,
    build_canonical_winner_ready_redeem_script,
    build_draw_ready_prefix,
    build_complete_draw_ready_suffix,
    canonical_suffix_len,
    reference_winner_step,
    WinnerStepResult,
    MAX_TOTAL_TICKETS,
    draw_ready_prefix_len,
    COUNTER_PUSH_LEN,
};

#[path = "../../../../contracts/sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::{
    build_production_sealed_covenant_v1,
    compute_application_commitment,
    compute_random_seed,
    ACTION_DRAW,
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

fn main() {
    println!("=== Testing Kaswin Winner Selection Canonical Layout & Self-Replication Suite ===");

    let cov_id = Hash::from_u64_word(0xc0c0c0);

    let round_id = Hash::from_u64_word(1);
    let ticket_price = 100_000_000u64; // 1 KAS
    let ticket_root = Hash::from_u64_word(2);
    let target_hash = Hash::from_u64_word(999);
    let pool_principal = 10_050_000_000u64; // 100.5 KAS

    let mut creator_refund_spk = vec![0x00, 0x00, 0x20];
    creator_refund_spk.extend(vec![0xcc; 32]);
    creator_refund_spk.push(0xac);

    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // -------------------------------------------------------------
    // TEST 1-4: Encoding-Class Layout & Suffix Fixed-Point Proof across N = [1, 100, 128, 100M]
    // -------------------------------------------------------------
    println!("\n--- TEST 1-4: Canonical Layout & Suffix Fixed-Point Verification ---");
    let test_ns = [1u64, 100u64, 128u64, 100_000_000u64];
    for &n in &test_ns {
        let sc_0 = build_draw_ready_covenant(round_id, ticket_price, n, ticket_root, target_hash, Hash::from_u64_word(100), creator_refund_spk.clone(), 0).unwrap();
        let sc_1 = build_draw_ready_covenant(round_id, ticket_price, n, ticket_root, target_hash, Hash::from_u64_word(100), creator_refund_spk.clone(), 1).unwrap();
        let sc_max = build_draw_ready_covenant(round_id, ticket_price, n, ticket_root, target_hash, Hash::from_u64_word(100), creator_refund_spk.clone(), 65535).unwrap();

        let prefix = build_draw_ready_prefix(&round_id, ticket_price, n, &ticket_root, &target_hash, &Hash::from_u64_word(100), &creator_refund_spk);
        assert_eq!(prefix.len(), draw_ready_prefix_len(creator_refund_spk.len()), "Prefix length must strictly be 190B for N={}", n);

        // Verify suffix fixed point:
        let s_len = canonical_suffix_len(n, creator_refund_spk.len());
        let actual_suffix = build_complete_draw_ready_suffix(n, creator_refund_spk.len());
        assert_eq!(s_len, actual_suffix.len(), "Suffix fixed point failed for N={}", n);

        assert_eq!(sc_0.len(), sc_1.len(), "Redeem length mismatch for N={}", n);
        assert_eq!(sc_0.len(), sc_max.len(), "Redeem length mismatch for N={} at max counter", n);
        println!("  N = {:<11}: prefix_len = {} (exact), suffix_len = {} (fixed point), total_len = {}", n, prefix.len(), s_len, sc_0.len());
    }
    println!("Canonical layout & strict suffix fixed-point verified for all test N classes [1, 100, 128, 100M]!");

    // -------------------------------------------------------------
    // TEST 5: SEALED -> Exact Production DRAW_READY(0) across N = [1, 100, 100M]
    // -------------------------------------------------------------
    println!("\n--- TEST 5: SEALED -> Exact Production DRAW_READY(0) across N=[1, 100, 100M] ---");
    let delta_daa = 100u64;
    let actual_sealed_daa = 1_000_000u64;
    let boundary = actual_sealed_daa + delta_daa;
    let pass_a_fixture = generate_valid_pass_a_fixture(boundary - 1, boundary);

    let mut seq_commits = std::collections::HashMap::new();
    seq_commits.insert(pass_a_fixture.target_hash, pass_a_fixture.c_t);
    let accessor = MockSeqCommitAccessor {
        selected_chain: vec![pass_a_fixture.target_hash],
        seq_commits,
    };

    for &n in &[1u64, 100u64, 100_000_000u64] {
        let app_commitment = compute_application_commitment(&round_id, &ticket_root, n);
        let derived_seed = compute_random_seed(&pass_a_fixture.target_hash, &app_commitment);

        let prod_draw_ready_0 = build_draw_ready_covenant(
            round_id,
            ticket_price,
            n,
            ticket_root,
            pass_a_fixture.target_hash,
            derived_seed,
            creator_refund_spk.clone(),
            0,
        ).unwrap();
        let prod_draw_ready_spk_0 = pay_to_script_hash_script(&prod_draw_ready_0);

        let sealed_redeem = build_production_sealed_covenant_v1(
            round_id,
            ticket_price,
            n,
            ticket_root,
            1,
            creator_refund_spk.clone(),
        ).unwrap();
        let sealed_spk = pay_to_script_hash_script(&sealed_redeem);

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
        sb_sealed.add_i64(ACTION_DRAW).unwrap();
        sb_sealed.add_data(&sealed_redeem).unwrap();
        let sig_script_sealed = sb_sealed.drain();

        let tx_sealed = Transaction::new(
            1,
            vec![TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(n), 0),
                sig_script_sealed,
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            )],
            vec![TransactionOutput {
                value: pool_principal,
                script_public_key: prod_draw_ready_spk_0.clone(),
                covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
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
            Some(cov_id),
        )]);
        let cov_ctx_s = CovenantsContext::from_tx(&pop_sealed).unwrap();
        let ctx_s = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_s).with_seq_commit_accessor(&accessor);
        let mut vm_s = TxScriptEngine::from_transaction_input(&pop_sealed, &pop_sealed.tx.inputs[0], 0, &pop_sealed.entries[0], ctx_s, flags);
        let res_s = vm_s.execute();
        assert_eq!(res_s, Ok(()), "SEALED -> DRAW_READY(0) failed for N={}", n);
        println!("  N = {:<11}: SEALED -> production DRAW_READY(0) OK! Used units: {}", n, vm_s.used_script_units().0);
    }

    // -------------------------------------------------------------
    // TEST 6: Production Successor Byte Identity for Representative Counters
    // -------------------------------------------------------------
    println!("\n--- TEST 6: Production Successor Byte Identity ---");
    let rep_counters = [0u64, 1u64, 2u64, 255u64, 65535u64, 1_000_000u64];
    let spk_len = creator_refund_spk.len();
    let prefix_len = draw_ready_prefix_len(spk_len);
    for &c in &rep_counters {
        let sc = build_draw_ready_covenant(round_id, ticket_price, 100, ticket_root, target_hash, Hash::from_u64_word(100), creator_refund_spk.clone(), c).unwrap();
        let expected_sc1 = build_draw_ready_covenant(round_id, ticket_price, 100, ticket_root, target_hash, Hash::from_u64_word(100), creator_refund_spk.clone(), c + 1).unwrap();

        let mut reconstructed = Vec::new();
        reconstructed.extend_from_slice(&sc[0..prefix_len]);
        reconstructed.push(0x08);
        reconstructed.extend_from_slice(&(c + 1).to_le_bytes());
        reconstructed.extend_from_slice(&sc[prefix_len + COUNTER_PUSH_LEN..]);

        assert_eq!(reconstructed, expected_sc1, "Byte identity mismatch at counter {}", c);
        assert_eq!(
            pay_to_script_hash_script(&reconstructed),
            pay_to_script_hash_script(&expected_sc1),
            "SPK identity mismatch at counter {}", c
        );
    }
    println!("Production successor byte identity verified 100% across counters [0, 1, 2, 255, 65535, 1M]!");

    // -------------------------------------------------------------
    // TEST 7: End-to-End Execution on Accepted Candidate -> WINNER_READY
    // -------------------------------------------------------------
    println!("\n--- TEST 7: Execution on Accepted Candidate -> WINNER_READY ---");
    let app_commitment_100 = compute_application_commitment(&round_id, &ticket_root, 100);
    let derived_seed_100 = compute_random_seed(&pass_a_fixture.target_hash, &app_commitment_100);

    let prod_c0 = build_draw_ready_covenant(
        round_id,
        ticket_price,
        100,
        ticket_root,
        pass_a_fixture.target_hash,
        derived_seed_100,
        creator_refund_spk.clone(),
        0,
    ).unwrap();
    let spk_prod_c0 = pay_to_script_hash_script(&prod_c0);

    let expected_winner = match reference_winner_step(100, &derived_seed_100, 0) {
        WinnerStepResult::Accepted { winner_index } => winner_index,
        _ => panic!("Expected accepted"),
    };
    let win_ready_redeem = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_price,
        100,
        ticket_root,
        pass_a_fixture.target_hash,
        derived_seed_100,
        creator_refund_spk.clone(),
        expected_winner,
    );
    let win_ready_spk = pay_to_script_hash_script(&win_ready_redeem);

    let mut sig_sb_accept = ScriptBuilder::with_flags(flags);
    sig_sb_accept.add_data(&prod_c0).unwrap();
    let sig_script_accept = sig_sb_accept.drain();

    let tx_accept = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(99), 0),
            sig_script_accept.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: win_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_accept = PopulatedTransaction::new(&tx_accept, vec![UtxoEntry::new(
        pool_principal,
        spk_prod_c0.clone(),
        1_000_100,
        false,
        Some(cov_id),
    )]);
    let cov_ctx_acc = CovenantsContext::from_tx(&pop_accept).unwrap();
    let ctx_acc = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_acc);
    let mut vm_accept = TxScriptEngine::from_transaction_input(&pop_accept, &pop_accept.tx.inputs[0], 0, &pop_accept.entries[0], ctx_acc, flags);
    let res_accept = vm_accept.execute();
    println!("Accept candidate execution result: {:?}", res_accept);
    assert_eq!(res_accept, Ok(()), "Accept candidate must transition to WINNER_READY");

    // -------------------------------------------------------------
    // TEST 8: Tampered Winner Output -> FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 8: Tampered Winner Output -> FAIL ---");
    let tampered_winner_redeem = build_canonical_winner_ready_redeem_script(
        round_id,
        ticket_price,
        100,
        ticket_root,
        pass_a_fixture.target_hash,
        derived_seed_100,
        creator_refund_spk.clone(),
        expected_winner + 1, // TAMPERED!
    );
    let tampered_winner_spk = pay_to_script_hash_script(&tampered_winner_redeem);

    let tx_tamp = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_accept,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: tampered_winner_spk,
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_tamp = PopulatedTransaction::new(&tx_tamp, vec![UtxoEntry::new(
        pool_principal,
        spk_prod_c0,
        1_000_100,
        false,
        Some(cov_id),
    )]);
    let cov_ctx_tamp = CovenantsContext::from_tx(&pop_tamp).unwrap();
    let ctx_tamp = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_tamp);
    let mut vm_tamp = TxScriptEngine::from_transaction_input(&pop_tamp, &pop_tamp.tx.inputs[0], 0, &pop_tamp.entries[0], ctx_tamp, flags);
    let res_tamp = vm_tamp.execute();
    println!("Tampered winner output execution result: {:?}", res_tamp);
    assert!(res_tamp.is_err(), "Tampered winner must FAIL SPK verification");

    // -------------------------------------------------------------
    // TEST 9: MAX_TOTAL_TICKETS Propagation & Out of Bounds Rejection
    // -------------------------------------------------------------
    println!("\n--- TEST 9: MAX_TOTAL_TICKETS Propagation ---");
    assert_eq!(MAX_TOTAL_TICKETS, 100_000_000);
    let zero_res = std::panic::catch_unwind(|| {
        build_production_sealed_covenant_v1(round_id, ticket_price, 0, ticket_root, 1, creator_refund_spk.clone()).unwrap();
    });
    assert!(zero_res.is_err(), "N=0 must panic in builder");
    let oob_res = std::panic::catch_unwind(|| {
        build_production_sealed_covenant_v1(round_id, ticket_price, MAX_TOTAL_TICKETS + 1, ticket_root, 1, creator_refund_spk.clone()).unwrap();
    });
    assert!(oob_res.is_err(), "N > MAX_TOTAL_TICKETS must panic in builder");
    println!("MAX_TOTAL_TICKETS = 100M defense-in-depth propagation verified!");

    println!("\n>>> ALL TESTS IN CANONICAL FIXED-WIDTH WINNER SELECTION SUITE PASSED! <<<");
}
