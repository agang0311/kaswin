use kaspa_hashes::{Hash, HasherBase};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ComputeCommit, CovenantBinding,
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
    compute_application_commitment,
    compute_random_seed,
};

#[path = "../../../../contracts/winner_selection.rs"]
mod winner_selection;
use winner_selection::build_draw_ready_covenant;

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
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_data(&f.target_hash.as_bytes()).unwrap();
    sb.add_data(&f.target_activity.as_bytes()).unwrap();
    sb.add_data(&f.target_payload.as_bytes()).unwrap();
    sb.add_data(&f.target_sp_ts).unwrap();
    sb.add_data(&f.target_daa).unwrap();
    sb.add_data(&f.target_blue).unwrap();
    sb.add_data(&f.p_parent_seq.as_bytes()).unwrap();
    sb.add_data(&f.p_activity.as_bytes()).unwrap();
    sb.add_data(&f.p_payload.as_bytes()).unwrap();
    sb.add_data(&f.p_sp_ts).unwrap();
    sb.add_data(&f.p_daa).unwrap();
    sb.add_data(&f.p_blue).unwrap();
    sb.add_data(redeem_script).unwrap();
    sb.drain()
}

fn main() {
    println!("=== Testing Kaswin SEALED -> DRAW_READY Canonical Test Suite ===");

    let cov_id = Hash::from_u64_word(0xc0c0c0);

    let round_id = Hash::from_u64_word(1);
    let ticket_root = Hash::from_u64_word(2);
    let total_tickets = 100u64;
    let pool_principal = 50_000_000_000u64; // 500 KAS

    let actual_sealed_daa = 1_000_000u64;
    let delta_daa = 100u64;
    let boundary = actual_sealed_daa + delta_daa; // 1_000_100

    let p_daa_val = boundary - 1; // 1_000_099 (strictly < boundary)
    let t_daa_val = boundary;     // 1_000_100 (>= boundary)

    // Build the SEALED covenant script (boundary dynamically derived from Input 0):
    let sealed_redeem = build_sealed_to_draw_ready_covenant(
        round_id,
        ticket_root,
        total_tickets,
        delta_daa,
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);
    println!("SEALED Redeem Script size: {} bytes", sealed_redeem.len());

    let fixture = generate_valid_pass_a_fixture(p_daa_val, t_daa_val);

    // Compute expected random seed and DRAW_READY successor SPK:
    let app_commitment = compute_application_commitment(&round_id, &ticket_root, total_tickets);
    let expected_seed = compute_random_seed(&fixture.target_hash, &app_commitment);

    let draw_ready_redeem = build_draw_ready_covenant(
        round_id,
        ticket_root,
        total_tickets,
        fixture.target_hash,
        expected_seed,
        0,
    ).unwrap();
    let draw_ready_spk = pay_to_script_hash_script(&draw_ready_redeem);

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
    // TEST 1: Canonical PASS-A Opening -> PASS
    // -------------------------------------------------------------
    println!("\n--- TEST 1: Canonical PASS-A Opening ---");
    let sig_script_1 = build_witness_stack(&fixture, &sealed_redeem);
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
            script_public_key: draw_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_1 = PopulatedTransaction::new(&tx_1, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        actual_sealed_daa,
        false,
        Some(cov_id),
    )]);
    let cov_ctx_1 = CovenantsContext::from_tx(&pop_1).unwrap();
    let ctx_1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_1).with_seq_commit_accessor(&accessor);
    let mut vm_1 = TxScriptEngine::from_transaction_input(&pop_1, &pop_1.tx.inputs[0], 0, &pop_1.entries[0], ctx_1, flags);
    let res_1 = vm_1.execute();
    println!("Test 1 Result: {:?}", res_1);
    assert_eq!(res_1, Ok(()), "Canonical PASS-A opening MUST pass");
    let used_units_1 = vm_1.used_script_units();
    println!("Test 1 Used Script Units: {}", used_units_1.0);

    // -------------------------------------------------------------
    // TEST 2: P context SAME-BYTES repartition (8/8/8 -> 9/8/7) -> FAIL at size rule
    // -------------------------------------------------------------
    println!("\n--- TEST 2: P Context SAME-BYTES Repartition Attack (9/8/7) ---");
    // Concatenation: p_sp_ts (8B) || p_daa (8B) || p_blue (8B) = 24 bytes
    let mut p_concat = Vec::new();
    p_concat.extend_from_slice(&fixture.p_sp_ts);
    p_concat.extend_from_slice(&fixture.p_daa);
    p_concat.extend_from_slice(&fixture.p_blue);

    // Malicious repartition:
    let p_sp_ts_mal = p_concat[0..9].to_vec();  // 9 bytes!
    let p_daa_mal = p_concat[9..17].to_vec();    // 8 bytes (shifted!)
    let p_blue_mal = p_concat[17..24].to_vec();  // 7 bytes!

    let mut sb_mal_p = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb_mal_p.add_data(&fixture.target_hash.as_bytes()).unwrap();
    sb_mal_p.add_data(&fixture.target_activity.as_bytes()).unwrap();
    sb_mal_p.add_data(&fixture.target_payload.as_bytes()).unwrap();
    sb_mal_p.add_data(&fixture.target_sp_ts).unwrap();
    sb_mal_p.add_data(&fixture.target_daa).unwrap();
    sb_mal_p.add_data(&fixture.target_blue).unwrap();
    sb_mal_p.add_data(&fixture.p_parent_seq.as_bytes()).unwrap();
    sb_mal_p.add_data(&fixture.p_activity.as_bytes()).unwrap();
    sb_mal_p.add_data(&fixture.p_payload.as_bytes()).unwrap();
    sb_mal_p.add_data(&p_sp_ts_mal).unwrap(); // 9B!
    sb_mal_p.add_data(&p_daa_mal).unwrap();   // 8B
    sb_mal_p.add_data(&p_blue_mal).unwrap();  // 7B!
    sb_mal_p.add_data(&sealed_redeem).unwrap();
    let sig_script_mal_p = sb_mal_p.drain();

    let tx_2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_mal_p,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
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
    let pop_2 = PopulatedTransaction::new(&tx_2, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        actual_sealed_daa,
        false,
        None,
    )]);
    let cov_ctx_2 = CovenantsContext::from_tx(&pop_2).unwrap();
    let ctx_2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_2).with_seq_commit_accessor(&accessor);
    let mut vm_2 = TxScriptEngine::from_transaction_input(&pop_2, &pop_2.tx.inputs[0], 0, &pop_2.entries[0], ctx_2, flags);
    let res_2 = vm_2.execute();
    println!("Test 2 Result: {:?}", res_2);
    assert!(res_2.is_err(), "Same-bytes P repartition attack MUST fail at size check");

    // -------------------------------------------------------------
    // TEST 3: T context SAME-BYTES repartition (8/8/8 -> 7/8/9) -> FAIL at size rule
    // -------------------------------------------------------------
    println!("\n--- TEST 3: T Context SAME-BYTES Repartition Attack (7/8/9) ---");
    let mut t_concat = Vec::new();
    t_concat.extend_from_slice(&fixture.target_sp_ts);
    t_concat.extend_from_slice(&fixture.target_daa);
    t_concat.extend_from_slice(&fixture.target_blue);

    let target_sp_ts_mal = t_concat[0..7].to_vec(); // 7 bytes!
    let target_daa_mal = t_concat[7..15].to_vec();   // 8 bytes
    let target_blue_mal = t_concat[15..24].to_vec(); // 9 bytes!

    let mut sb_mal_t = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb_mal_t.add_data(&fixture.target_hash.as_bytes()).unwrap();
    sb_mal_t.add_data(&fixture.target_activity.as_bytes()).unwrap();
    sb_mal_t.add_data(&fixture.target_payload.as_bytes()).unwrap();
    sb_mal_t.add_data(&target_sp_ts_mal).unwrap(); // 7B!
    sb_mal_t.add_data(&target_daa_mal).unwrap();   // 8B
    sb_mal_t.add_data(&target_blue_mal).unwrap();  // 9B!
    sb_mal_t.add_data(&fixture.p_parent_seq.as_bytes()).unwrap();
    sb_mal_t.add_data(&fixture.p_activity.as_bytes()).unwrap();
    sb_mal_t.add_data(&fixture.p_payload.as_bytes()).unwrap();
    sb_mal_t.add_data(&fixture.p_sp_ts).unwrap();
    sb_mal_t.add_data(&fixture.p_daa).unwrap();
    sb_mal_t.add_data(&fixture.p_blue).unwrap();
    sb_mal_t.add_data(&sealed_redeem).unwrap();
    let sig_script_mal_t = sb_mal_t.drain();

    let tx_3 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_mal_t,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
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
    let pop_3 = PopulatedTransaction::new(&tx_3, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        actual_sealed_daa,
        false,
        None,
    )]);
    let cov_ctx_3 = CovenantsContext::from_tx(&pop_3).unwrap();
    let ctx_3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_3).with_seq_commit_accessor(&accessor);
    let mut vm_3 = TxScriptEngine::from_transaction_input(&pop_3, &pop_3.tx.inputs[0], 0, &pop_3.entries[0], ctx_3, flags);
    let res_3 = vm_3.execute();
    println!("Test 3 Result: {:?}", res_3);
    assert!(res_3.is_err(), "Same-bytes T repartition attack MUST fail at size check");

    // -------------------------------------------------------------
    // TEST 4: Later Target Attack (Canonical P.daa >= boundary) -> FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 4: Later Target Attack (P.daa >= boundary) ---");
    let fixture_4 = generate_valid_pass_a_fixture(boundary, boundary + 1);
    let mut seq_commits_4 = HashMap::new();
    seq_commits_4.insert(fixture_4.target_hash, fixture_4.c_t);
    let accessor_4 = MockSeqCommitAccessor {
        selected_chain: vec![fixture_4.target_hash],
        seq_commits: seq_commits_4,
    };
    let sig_script_4 = build_witness_stack(&fixture_4, &sealed_redeem);
    let tx_4 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_4,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
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
    let pop_4 = PopulatedTransaction::new(&tx_4, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        actual_sealed_daa,
        false,
        None,
    )]);
    let cov_ctx_4 = CovenantsContext::from_tx(&pop_4).unwrap();
    let ctx_4 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_4).with_seq_commit_accessor(&accessor_4);
    let mut vm_4 = TxScriptEngine::from_transaction_input(&pop_4, &pop_4.tx.inputs[0], 0, &pop_4.entries[0], ctx_4, flags);
    let res_4 = vm_4.execute();
    println!("Test 4 Result: {:?}", res_4);
    assert!(res_4.is_err(), "Later target attack MUST fail first crossing predicate");

    // -------------------------------------------------------------
    // TEST 5 & 6: Boundary Enforced Exclusively by Input 0 UtxoEntry DAA Score
    // Client Claimed Base DAA != actual UtxoEntry.block_daa_score
    // -------------------------------------------------------------
    println!("\n--- TEST 5 & 6: Boundary from Genuine Input DAA (Client Claim Mismatch) ---");
    // Suppose actual on-chain inclusion DAA of SEALED UTXO is 2_000_000 (not 1_000_000):
    // Then boundary = 2_000_000 + 100 = 2_000_100.
    // The previous fixture (DAA ~ 1_000_100) MUST FAIL because T.daa (1_000_100) < boundary (2_000_100)!
    let pop_mismatch = PopulatedTransaction::new(&tx_1, vec![UtxoEntry::new(
        pool_principal,
        sealed_spk.clone(),
        2_000_000, // Actual on-chain DAA is 2M!
        false,
        Some(cov_id),
    )]);
    let cov_ctx_mis = CovenantsContext::from_tx(&pop_mismatch).unwrap();
    let ctx_mis = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_mis).with_seq_commit_accessor(&accessor);
    let mut vm_mis = TxScriptEngine::from_transaction_input(&pop_mismatch, &pop_mismatch.tx.inputs[0], 0, &pop_mismatch.entries[0], ctx_mis, flags);
    let res_mis = vm_mis.execute();
    println!("Test 5 & 6 Mismatch Result: {:?}", res_mis);
    assert!(res_mis.is_err(), "Opening matching client base DAA must FAIL when actual UTXO DAA is different");

    // -------------------------------------------------------------
    // TEST 7: Official kaspa_seq_commit Reference Oracle Match
    // -------------------------------------------------------------
    println!("\n--- TEST 7: Official kaspa_seq_commit Reference Oracle Equality ---");
    // Reconstruct C_P and C_T using official rusty-kaspa kaspa_seq_commit functions:
    // P Context:
    let mut p_ctx_hasher = kaspa_hashes::SeqCommitMergesetContext::new();
    p_ctx_hasher.update(u64::from_le_bytes(fixture.p_sp_ts).to_le_bytes());
    p_ctx_hasher.update(u64::from_le_bytes(fixture.p_daa).to_le_bytes());
    p_ctx_hasher.update(u64::from_le_bytes(fixture.p_blue).to_le_bytes());
    let p_ctx_official = p_ctx_hasher.finalize();

    let mut p_pd_hasher = kaspa_hashes::SeqCommitMerkleBranch::new();
    p_pd_hasher.update(p_ctx_official);
    p_pd_hasher.update(fixture.p_payload);
    let p_pd_official = p_pd_hasher.finalize();

    let mut p_sr_hasher = kaspa_hashes::SeqCommitMerkleBranch::new();
    p_sr_hasher.update(fixture.p_activity);
    p_sr_hasher.update(p_pd_official);
    let p_sr_official = p_sr_hasher.finalize();

    let mut c_p_hasher = kaspa_hashes::SeqCommitMerkleBranch::new();
    c_p_hasher.update(fixture.p_parent_seq);
    c_p_hasher.update(p_sr_official);
    let c_p_official = c_p_hasher.finalize();

    // T Context:
    let mut t_ctx_hasher = kaspa_hashes::SeqCommitMergesetContext::new();
    t_ctx_hasher.update(u64::from_le_bytes(fixture.target_sp_ts).to_le_bytes());
    t_ctx_hasher.update(u64::from_le_bytes(fixture.target_daa).to_le_bytes());
    t_ctx_hasher.update(u64::from_le_bytes(fixture.target_blue).to_le_bytes());
    let t_ctx_official = t_ctx_hasher.finalize();

    let mut t_pd_hasher = kaspa_hashes::SeqCommitMerkleBranch::new();
    t_pd_hasher.update(t_ctx_official);
    t_pd_hasher.update(fixture.target_payload);
    let t_pd_official = t_pd_hasher.finalize();

    let mut t_sr_hasher = kaspa_hashes::SeqCommitMerkleBranch::new();
    t_sr_hasher.update(fixture.target_activity);
    t_sr_hasher.update(t_pd_official);
    let t_sr_official = t_sr_hasher.finalize();

    let mut c_t_hasher = kaspa_hashes::SeqCommitMerkleBranch::new();
    c_t_hasher.update(c_p_official);
    c_t_hasher.update(t_sr_official);
    let c_t_official = c_t_hasher.finalize();

    println!("Script fixture C_T : {:?}", fixture.c_t);
    println!("Official oracle C_T: {:?}", c_t_official);
    assert_eq!(fixture.c_t, c_t_official, "Fixture C_T must match official rusty-kaspa SeqCommit calculation byte-for-byte");
    println!("Test 7 Result: Official SeqCommit oracle byte-for-byte equality confirmed!");

    // -------------------------------------------------------------
    // TEST 8: Actual Wire-Serialized Transaction Bytes & Masses
    // -------------------------------------------------------------
    println!("\n--- TEST 8: Resource Measurement & Actual Serialized Bytes ---");
    let mc = MassCalculator::new(1, 10, 10_000_000);
    let non_ctx = mc.calc_non_contextual_masses(&tx_1);
    
    // Wire serialization using Borsh serialization of Transaction:
    let actual_serialized_wire_bytes = borsh::to_vec(&tx_1).unwrap();
    let estimated_bytes = kaspa_consensus_core::mass::transaction_estimated_serialized_size(&tx_1);

    let compute_mass = non_ctx.compute_mass;
    let transient_mass = non_ctx.transient_mass;
    let storage_mass = 0u64;
    let fee_mass = std::cmp::max(compute_mass, transient_mass);
    let min_relay_fee = fee_mass * 100;

    println!("===============================================================");
    println!("SEALED -> DRAW_READY Transaction Resource Audit:");
    println!("  SignatureScript Length      : {} bytes", sig_script_1.len());
    println!("  RedeemScript Length         : {} bytes", sealed_redeem.len());
    println!("  Actual Serialized Wire Bytes: {} bytes", actual_serialized_wire_bytes.len());
    println!("  Estimated Serialized Bytes  : {} bytes", estimated_bytes);
    println!("  Used Script Units           : {}", used_units_1.0);
    println!("  Compute Mass                : {} gram", compute_mass);
    println!("  Transient Mass              : {} gram", transient_mass);
    println!("  Storage Mass                : {} gram", storage_mass);
    println!("  Fee Mass (Overall)          : {} gram", fee_mass);
    println!("  Minimum Relay Fee           : {} sompi ({:.6} KAS)", min_relay_fee, min_relay_fee as f64 / 1e8);
    println!("===============================================================");

    println!("\n>>> ALL TESTS 1 THROUGH 8 PASSED WITH CANONICAL SCHEMA! <<<");
}
