use kaspa_hashes::Hash;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ComputeCommit,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    SeqCommitAccessor,
    script_builder::ScriptBuilder,
    covenants::CovenantsContext,
    standard::pay_to_script_hash_script,
};
use kaspa_consensus_core::mass::{ComputeBudget, MassCalculator};
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use std::collections::HashMap;

#[path = "../../../../contracts/sealed_to_draw_ready.rs"]
mod sealed_to_draw_ready;
use sealed_to_draw_ready::{
    build_sealed_to_draw_ready_covenant,
    build_draw_ready_redeem_script,
    compute_application_commitment,
    compute_random_seed,
};

struct MockSeqCommitAccessor {
    pub selected_chain: Vec<Hash>,
    pub seq_commits: HashMap<Hash, Hash>,
}

impl SeqCommitAccessor for MockSeqCommitAccessor {
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

    // 1. P_ctx = H(key_ctx, p_sp_ts || p_daa || p_blue)
    let mut p_ctx_in = Vec::new();
    p_ctx_in.extend_from_slice(&p_sp_ts);
    p_ctx_in.extend_from_slice(&p_daa);
    p_ctx_in.extend_from_slice(&p_blue);
    let p_ctx = blake3_hash(key_ctx, &p_ctx_in);

    // 2. P_pd = H(key_branch, p_ctx || p_payload)
    let p_payload = Hash::from_u64_word(101);
    let mut p_pd_in = Vec::new();
    p_pd_in.extend_from_slice(&p_ctx.as_bytes());
    p_pd_in.extend_from_slice(&p_payload.as_bytes());
    let p_pd = blake3_hash(key_branch, &p_pd_in);

    // 3. P_sr = H(key_branch, p_activity || p_pd)
    let p_activity = Hash::from_u64_word(102);
    let mut p_sr_in = Vec::new();
    p_sr_in.extend_from_slice(&p_activity.as_bytes());
    p_sr_in.extend_from_slice(&p_pd.as_bytes());
    let p_sr = blake3_hash(key_branch, &p_sr_in);

    // 4. C_P = H(key_branch, p_parent_seq || p_sr)
    let p_parent_seq = Hash::from_u64_word(103);
    let mut c_p_in = Vec::new();
    c_p_in.extend_from_slice(&p_parent_seq.as_bytes());
    c_p_in.extend_from_slice(&p_sr.as_bytes());
    let c_p = blake3_hash(key_branch, &c_p_in);

    // 5. T_ctx = H(key_ctx, target_sp_ts || target_daa || target_blue)
    let target_sp_ts = (1_700_000_000u64 + 10).to_le_bytes();
    let target_daa = t_daa_num.to_le_bytes();
    let target_blue = (t_daa_num - 100).to_le_bytes();
    let mut t_ctx_in = Vec::new();
    t_ctx_in.extend_from_slice(&target_sp_ts);
    t_ctx_in.extend_from_slice(&target_daa);
    t_ctx_in.extend_from_slice(&target_blue);
    let t_ctx = blake3_hash(key_ctx, &t_ctx_in);

    // 6. T_pd = H(key_branch, t_ctx || target_payload)
    let target_payload = Hash::from_u64_word(201);
    let mut t_pd_in = Vec::new();
    t_pd_in.extend_from_slice(&t_ctx.as_bytes());
    t_pd_in.extend_from_slice(&target_payload.as_bytes());
    let t_pd = blake3_hash(key_branch, &t_pd_in);

    // 7. T_sr = H(key_branch, target_activity || t_pd)
    let target_activity = Hash::from_u64_word(202);
    let mut t_sr_in = Vec::new();
    t_sr_in.extend_from_slice(&target_activity.as_bytes());
    t_sr_in.extend_from_slice(&t_pd.as_bytes());
    let t_sr = blake3_hash(key_branch, &t_sr_in);

    // 8. C_T = H(key_branch, C_P || t_sr)
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

fn build_witness_stack(f: &PassAOpeningFixture, redeem_script: &[u8]) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    // Order in witness:
    // [0] target_hash (32B)
    sb.add_data(&f.target_hash.as_bytes()).unwrap();
    // [1] target_activity (32B)
    sb.add_data(&f.target_activity.as_bytes()).unwrap();
    // [2] target_payload (32B)
    sb.add_data(&f.target_payload.as_bytes()).unwrap();
    // [3] target_sp_ts (8B)
    sb.add_data(&f.target_sp_ts).unwrap();
    // [4] target_daa (8B)
    sb.add_data(&f.target_daa).unwrap();
    // [5] target_blue (8B)
    sb.add_data(&f.target_blue).unwrap();
    // [6] p_parent_seq (32B)
    sb.add_data(&f.p_parent_seq.as_bytes()).unwrap();
    // [7] p_activity (32B)
    sb.add_data(&f.p_activity.as_bytes()).unwrap();
    // [8] p_payload (32B)
    sb.add_data(&f.p_payload.as_bytes()).unwrap();
    // [9] p_sp_ts (8B)
    sb.add_data(&f.p_sp_ts).unwrap();
    // [10] p_daa (8B)
    sb.add_data(&f.p_daa).unwrap();
    // [11] p_blue (8B)
    sb.add_data(&f.p_blue).unwrap();
    // Finally push redeem script for P2SH
    sb.add_data(redeem_script).unwrap();
    sb.drain()
}

fn main() {
    println!("=== Testing Kaswin SEALED -> DRAW_READY State Transition Suite ===");

    let round_id = Hash::from_u64_word(1);
    let ticket_root = Hash::from_u64_word(2);
    let total_tickets = 100u64;
    let pool_principal = 50_000_000_000u64; // 500 KAS

    let sealed_base_daa = 1_000_000u64;
    let delta_daa = 100u64;
    let boundary = sealed_base_daa + delta_daa; // 1_000_100

    let p_daa_val = boundary - 1; // 1_000_099 (strictly < boundary)
    let t_daa_val = boundary;     // 1_000_100 (>= boundary)

    // Build the SEALED covenant script:
    let sealed_redeem = build_sealed_to_draw_ready_covenant(
        round_id,
        ticket_root,
        total_tickets,
        sealed_base_daa,
        delta_daa,
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);
    println!("SEALED Redeem Script size: {} bytes", sealed_redeem.len());

    let fixture = generate_valid_pass_a_fixture(p_daa_val, t_daa_val);

    // Compute expected random seed and DRAW_READY successor SPK:
    let app_commitment = compute_application_commitment(&round_id, &ticket_root, total_tickets);
    let expected_seed = compute_random_seed(&fixture.target_hash, &app_commitment);

    let draw_ready_redeem = build_draw_ready_redeem_script(
        round_id,
        ticket_root,
        total_tickets,
        fixture.target_hash,
        expected_seed,
    );
    let draw_ready_spk = pay_to_script_hash_script(&draw_ready_redeem);
    println!("Expected DRAW_READY Redeem Script size: {} bytes", draw_ready_redeem.len());
    println!("Expected DRAW_READY SPK size: {} bytes", draw_ready_spk.script().len());

    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    let mut seq_commits = HashMap::new();
    seq_commits.insert(fixture.target_hash, fixture.c_t);
    let accessor = MockSeqCommitAccessor {
        selected_chain: vec![fixture.target_hash],
        seq_commits,
    };

    // -------------------------------------------------------------
    // TEST A: Normal Freeze (SEALED -> DRAW_READY must PASS)
    // -------------------------------------------------------------
    println!("\n--- TEST A: Normal Freeze ---");
    let sig_script_a = build_witness_stack(&fixture, &sealed_redeem);

    // 1. Initial measurement with large budget to discover actual script units
    let tx_measure = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_a.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(u16::MAX)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_measure = PopulatedTransaction::new(&tx_measure, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        sealed_base_daa,
        false,
        None,
    )]);
    let cov_ctx_measure = CovenantsContext::from_tx(&pop_measure).unwrap();
    let ctx_measure = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_measure).with_seq_commit_accessor(&accessor);
    let mut vm_measure = TxScriptEngine::from_transaction_input(&pop_measure, &pop_measure.tx.inputs[0], 0, &pop_measure.entries[0], ctx_measure, flags);
    let res_measure = vm_measure.execute();
    assert_eq!(res_measure, Ok(()));
    let used_units = vm_measure.used_script_units();
    println!("Test A Actual Used Script Units: {}", used_units.0);

    // Compute minimal covering ComputeBudget:
    // With 3,469 units, since 3,469 < 9,999 (free units), b_min = ComputeBudget(0)!
    let b_min = ComputeBudget::checked_covering_script_units(used_units).expect("Compute budget must be valid");
    println!("Calculated minimal ComputeBudget: {}", b_min.value());
    assert_eq!(b_min.value(), 0, "Since 3469 <= 9999 free units, required budget is exactly 0");

    let tx_a = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_a.clone(),
            0,
            ComputeCommit::ComputeBudget(b_min),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_a = PopulatedTransaction::new(&tx_a, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        sealed_base_daa,
        false,
        None,
    )]);
    let cov_ctx_a = CovenantsContext::from_tx(&pop_a).unwrap();
    let ctx_a = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_a).with_seq_commit_accessor(&accessor);
    let mut vm_a = TxScriptEngine::from_transaction_input(&pop_a, &pop_a.tx.inputs[0], 0, &pop_a.entries[0], ctx_a, flags);
    let res_a = vm_a.execute();
    println!("Test A Result with minimal ComputeBudget({}): {:?}", b_min.value(), res_a);
    assert_eq!(res_a, Ok(()), "Normal freeze MUST pass");

    // -------------------------------------------------------------
    // TEST B: Wrong T DAA (tamper target_daa -> commitment mismatch -> FAIL)
    // -------------------------------------------------------------
    println!("\n--- TEST B: Wrong T DAA ---");
    let mut fixture_b = generate_valid_pass_a_fixture(p_daa_val, t_daa_val);
    fixture_b.target_daa = (t_daa_val + 1).to_le_bytes(); // modified!
    let sig_script_b = build_witness_stack(&fixture_b, &sealed_redeem);
    let tx_b = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_b,
            0,
            ComputeCommit::ComputeBudget(b_min),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_b = PopulatedTransaction::new(&tx_b, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        sealed_base_daa,
        false,
        None,
    )]);
    let cov_ctx_b = CovenantsContext::from_tx(&pop_b).unwrap();
    let ctx_b = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_b).with_seq_commit_accessor(&accessor);
    let mut vm_b = TxScriptEngine::from_transaction_input(&pop_b, &pop_b.tx.inputs[0], 0, &pop_b.entries[0], ctx_b, flags);
    let res_b = vm_b.execute();
    println!("Test B Result: {:?}", res_b);
    assert!(res_b.is_err(), "Tampered T DAA must fail commitment check");

    // -------------------------------------------------------------
    // TEST C: Wrong P DAA (P.daa >= boundary -> FAIL)
    // -------------------------------------------------------------
    println!("\n--- TEST C: Wrong P DAA (P.daa >= boundary) ---");
    let fixture_c = generate_valid_pass_a_fixture(boundary, t_daa_val);
    let mut seq_commits_c = HashMap::new();
    seq_commits_c.insert(fixture_c.target_hash, fixture_c.c_t);
    let accessor_c = MockSeqCommitAccessor {
        selected_chain: vec![fixture_c.target_hash],
        seq_commits: seq_commits_c,
    };
    let sig_script_c = build_witness_stack(&fixture_c, &sealed_redeem);
    let tx_c = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_c,
            0,
            ComputeCommit::ComputeBudget(b_min),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_c = PopulatedTransaction::new(&tx_c, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        sealed_base_daa,
        false,
        None,
    )]);
    let cov_ctx_c = CovenantsContext::from_tx(&pop_c).unwrap();
    let ctx_c = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_c).with_seq_commit_accessor(&accessor_c);
    let mut vm_c = TxScriptEngine::from_transaction_input(&pop_c, &pop_c.tx.inputs[0], 0, &pop_c.entries[0], ctx_c, flags);
    let res_c = vm_c.execute();
    println!("Test C Result: {:?}", res_c);
    assert!(res_c.is_err(), "P.daa >= boundary must fail");

    // -------------------------------------------------------------
    // TEST D: Later-Target Attack (parent DAA already >= boundary -> FAIL)
    // -------------------------------------------------------------
    println!("\n--- TEST D: Later-Target Attack (parent DAA >= boundary) ---");
    let fixture_d = generate_valid_pass_a_fixture(boundary + 5, boundary + 6);
    let mut seq_commits_d = HashMap::new();
    seq_commits_d.insert(fixture_d.target_hash, fixture_d.c_t);
    let accessor_d = MockSeqCommitAccessor {
        selected_chain: vec![fixture_d.target_hash],
        seq_commits: seq_commits_d,
    };
    let sig_script_d = build_witness_stack(&fixture_d, &sealed_redeem);
    let tx_d = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_d,
            0,
            ComputeCommit::ComputeBudget(b_min),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_d = PopulatedTransaction::new(&tx_d, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        sealed_base_daa,
        false,
        None,
    )]);
    let cov_ctx_d = CovenantsContext::from_tx(&pop_d).unwrap();
    let ctx_d = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_d).with_seq_commit_accessor(&accessor_d);
    let mut vm_d = TxScriptEngine::from_transaction_input(&pop_d, &pop_d.tx.inputs[0], 0, &pop_d.entries[0], ctx_d, flags);
    let res_d = vm_d.execute();
    println!("Test D Result: {:?}", res_d);
    assert!(res_d.is_err(), "Later target attack MUST fail first crossing predicate");

    // -------------------------------------------------------------
    // TEST E: Wrong Target Hash in SeqCommit
    // -------------------------------------------------------------
    println!("\n--- TEST E: Wrong Target Hash in SeqCommit ---");
    let mut fixture_e = generate_valid_pass_a_fixture(p_daa_val, t_daa_val);
    fixture_e.target_hash = Hash::from_u64_word(8888); // different hash!
    let mut seq_commits_e = HashMap::new();
    seq_commits_e.insert(fixture_e.target_hash, Hash::from_u64_word(7777)); // different commitment
    let accessor_e = MockSeqCommitAccessor {
        selected_chain: vec![fixture_e.target_hash],
        seq_commits: seq_commits_e,
    };
    let sig_script_e = build_witness_stack(&fixture_e, &sealed_redeem);
    let tx_e = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_e,
            0,
            ComputeCommit::ComputeBudget(b_min),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_spk.clone(),
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_e = PopulatedTransaction::new(&tx_e, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        sealed_base_daa,
        false,
        None,
    )]);
    let cov_ctx_e = CovenantsContext::from_tx(&pop_e).unwrap();
    let ctx_e = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_e).with_seq_commit_accessor(&accessor_e);
    let mut vm_e = TxScriptEngine::from_transaction_input(&pop_e, &pop_e.tx.inputs[0], 0, &pop_e.entries[0], ctx_e, flags);
    let res_e = vm_e.execute();
    println!("Test E Result: {:?}", res_e);
    assert!(res_e.is_err(), "Mismatched SeqCommit must fail");

    // -------------------------------------------------------------
    // TEST F: Seed Tampering / Output State Tampering
    // Caller attempts to substitute a fake random_seed in Output 0 SPK!
    // -------------------------------------------------------------
    println!("\n--- TEST F: Seed Tampering in Successor Output ---");
    let fake_seed = Hash::from_u64_word(0xbad_5eed);
    let fake_draw_ready_redeem = build_draw_ready_redeem_script(
        round_id,
        ticket_root,
        total_tickets,
        fixture.target_hash,
        fake_seed, // TAMPERED!
    );
    let fake_draw_ready_spk = pay_to_script_hash_script(&fake_draw_ready_redeem);
    let tx_f = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_a.clone(),
            0,
            ComputeCommit::ComputeBudget(b_min),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: fake_draw_ready_spk, // TAMPERED SPK!
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_f = PopulatedTransaction::new(&tx_f, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        sealed_base_daa,
        false,
        None,
    )]);
    let cov_ctx_f = CovenantsContext::from_tx(&pop_f).unwrap();
    let ctx_f = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_f).with_seq_commit_accessor(&accessor);
    let mut vm_f = TxScriptEngine::from_transaction_input(&pop_f, &pop_f.tx.inputs[0], 0, &pop_f.entries[0], ctx_f, flags);
    let res_f = vm_f.execute();
    println!("Test F Result: {:?}", res_f);
    assert!(res_f.is_err(), "Tampered random seed in output must be rejected by covenant");

    // -------------------------------------------------------------
    // TEST G: Cross-Round Replay Attack
    // Trying to spend Round 2's SEALED contract using Round 1's DRAW_READY SPK
    // -------------------------------------------------------------
    println!("\n--- TEST G: Cross-Round Replay Attack ---");
    let round_id_2 = Hash::from_u64_word(2); // different round!
    let sealed_redeem_round_2 = build_sealed_to_draw_ready_covenant(
        round_id_2,
        ticket_root,
        total_tickets,
        sealed_base_daa,
        delta_daa,
    ).unwrap();
    let sealed_spk_round_2 = pay_to_script_hash_script(&sealed_redeem_round_2);

    let sig_script_g = build_witness_stack(&fixture, &sealed_redeem_round_2);
    // Attempting to direct outputs to Round 1's draw_ready_spk:
    let tx_g = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_g,
            0,
            ComputeCommit::ComputeBudget(b_min),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: draw_ready_spk.clone(), // Round 1 SPK!
            covenant: None,
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_g = PopulatedTransaction::new(&tx_g, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk_round_2,
        sealed_base_daa,
        false,
        None,
    )]);
    let cov_ctx_g = CovenantsContext::from_tx(&pop_g).unwrap();
    let ctx_g = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_g).with_seq_commit_accessor(&accessor);
    let mut vm_g = TxScriptEngine::from_transaction_input(&pop_g, &pop_g.tx.inputs[0], 0, &pop_g.entries[0], ctx_g, flags);
    let res_g = vm_g.execute();
    println!("Test G Result: {:?}", res_g);
    assert!(res_g.is_err(), "Cross-round replay must fail output SPK check");

    // -------------------------------------------------------------
    // TEST H: Resource Measurement for Complete SEALED -> DRAW_READY Transaction
    // -------------------------------------------------------------
    println!("\n--- TEST H: Resource Measurement ---");
    let mc = MassCalculator::new(1, 10, 10_000_000);
    let non_ctx = mc.calc_non_contextual_masses(&tx_a);
    let serialized_bytes = non_ctx.transient_mass / 10;
    let compute_mass = non_ctx.compute_mass;
    let transient_mass = non_ctx.transient_mass;
    let storage_mass = 0u64; // Simple 1 in 1 out standard value transfer
    let fee_mass = std::cmp::max(compute_mass, transient_mass);
    let min_relay_fee = fee_mass * 100; // 100 sompi / gram

    println!("===============================================================");
    println!("SEALED -> DRAW_READY Transaction Resource Audit:");
    println!("  SignatureScript Length    : {} bytes", sig_script_a.len());
    println!("  RedeemScript Length       : {} bytes", sealed_redeem.len());
    println!("  Full Transaction Est Bytes: {} bytes", serialized_bytes);
    println!("  Compute Mass              : {} gram", compute_mass);
    println!("  Transient Mass            : {} gram", transient_mass);
    println!("  Storage Mass              : {} gram", storage_mass);
    println!("  Fee Mass (Overall)        : {} gram", fee_mass);
    println!("  Minimum Relay Fee         : {} sompi ({:.6} KAS)", min_relay_fee, min_relay_fee as f64 / 1e8);
    println!("===============================================================");

    println!("\n>>> ALL TESTS IN SEALED -> DRAW_READY SUITE PASSED! <<<");
}
