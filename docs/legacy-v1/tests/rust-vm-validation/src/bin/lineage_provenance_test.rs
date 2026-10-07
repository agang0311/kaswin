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
use kaspa_txscript::opcodes::codes::*;
use kaspa_txscript::SeqCommitAccessor;
use std::collections::HashMap;

#[path = "../../../../contracts/v1_constants.rs"]
pub mod v1_constants;
use v1_constants::DELTA_DAA_V1;

#[path = "../../../../contracts/lineage.rs"]
pub mod lineage;

#[path = "../../../../contracts/round_id.rs"]
pub mod round_id;
use round_id::compute_canonical_round_id;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_leaf,
    compute_empty_root_27,
    compute_empty_levels,
    compute_payout_commitment,
    compute_purchase_leaf,
    compute_root_from_path,
    TREE_DEPTH,
};

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::{build_initial_open_covenant, build_open_covenant, ACTION_BUY};

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::{build_canonical_kaswin_genesis_output, validate_canonical_kaswin_create};

#[path = "../../../../contracts/sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::{
    build_production_sealed_covenant_v1,
    compute_application_commitment,
    compute_random_seed,
    ACTION_DRAW,
};

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;
use winner_ready_settlement::build_production_winner_ready_covenant;

#[path = "../../../../contracts/winner_selection.rs"]
pub mod winner_selection;
use winner_selection::{
    build_draw_ready_covenant,
    build_canonical_winner_ready_redeem_script,
    extract_candidate_num,
    compute_candidate_hash,
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

fn build_pass_a_witness(f: &PassAOpeningFixture, redeem_script: &[u8]) -> Vec<u8> {
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
    sb.add_i64(ACTION_DRAW).unwrap();
    sb.add_data(redeem_script).unwrap();
    sb.drain()
}

fn main() {
    println!("================================================================");
    println!("KASWIN KIP-20 PROVENANCE & SINGLETON COVENANT LINEAGE TEST MATRIX");
    println!("================================================================");

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    let ticket_price = 10_000_000u64; // 0.1 KAS
    let total_tickets = 100u64;
    let delta_daa = DELTA_DAA_V1;
    let state_deposit = 50_000_000u64; // 0.5 KAS

    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(12345), 0);
    let canonical_round_id = compute_canonical_round_id(&funding_outpoint);

    let empty_root = compute_empty_root_27();
    let empty_levels = compute_empty_levels();
    let empty_leaf = compute_empty_leaf();

    let mut creator_refund_spk = vec![0x00, 0x00, OpData32 as u8];
    creator_refund_spk.extend(vec![0x77; 32]);
    creator_refund_spk.push(OpCheckSig as u8);
    let refund_lock_daa = 1_500_000u64;

    // -------------------------------------------------------------
    // TEST 1 — Canonical CREATE
    // -------------------------------------------------------------
    println!("\n[Test 1] Canonical CREATE transaction -> canonical initial OPEN output 0 with KIP-20 covenant ID");

    let (mut initial_output, official_covenant_id) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        delta_daa,
        refund_lock_daa,
        creator_refund_spk.clone(),
        state_deposit,
    ).unwrap();
    let initial_open_spk = initial_output.script_public_key.clone();

    let tx_create = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            funding_outpoint,
            vec![0x33; 66],
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![initial_output.clone()],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );

    let pop_create = PopulatedTransaction::new(&tx_create, vec![UtxoEntry::new(
        state_deposit + 10_000_000,
        kaspa_txscript::standard::pay_to_script_hash_script(&[0x51]),
        1_000_000,
        false,
        None,
    )]);

    let cov_ctx_create = CovenantsContext::from_tx(&pop_create);
    assert!(cov_ctx_create.is_ok());
    println!("  -> CovenantsContext::from_tx: PASS");

    let validated_c = validate_canonical_kaswin_create(
        &tx_create,
        ticket_price,
        total_tickets,
        delta_daa,
        refund_lock_daa,
        &creator_refund_spk,
        state_deposit,
    ).unwrap();
    assert_eq!(validated_c, official_covenant_id);
    println!("  -> validate_canonical_kaswin_create: PASS (covenant_id = {})", validated_c);

    // -------------------------------------------------------------
    // TEST 2 — Noncanonical Initial Root
    // -------------------------------------------------------------
    println!("\n[Test 2] Noncanonical Initial Root (root != EMPTY_ROOT_27)");
    let bad_root = Hash::from_u64_word(0xbad);
    let noncanonical_open = build_open_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        0,
        0,
        bad_root,
        delta_daa,
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();
    let tx_bad_root = Transaction::new(
        1,
        vec![TransactionInput::new(funding_outpoint, vec![], 0, 0)],
        vec![TransactionOutput {
            value: state_deposit,
            script_public_key: pay_to_script_hash_script(&noncanonical_open),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    assert!(validate_canonical_kaswin_create(&tx_bad_root, ticket_price, total_tickets, delta_daa, refund_lock_daa, &creator_refund_spk, state_deposit).is_err());
    println!("  -> PASS: Noncanonical initial root rejected by validate_canonical_kaswin_create");

    // -------------------------------------------------------------
    // TEST 3 — Noncanonical Initial State
    // -------------------------------------------------------------
    println!("\n[Test 3] Noncanonical Initial State (sold = 5, pc = 1 at genesis)");
    let noncanonical_state_open = build_open_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        5,
        1,
        empty_root,
        delta_daa,
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();
    let tx_bad_state = Transaction::new(
        1,
        vec![TransactionInput::new(funding_outpoint, vec![], 0, 0)],
        vec![TransactionOutput {
            value: state_deposit,
            script_public_key: pay_to_script_hash_script(&noncanonical_state_open),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    assert!(validate_canonical_kaswin_create(&tx_bad_state, ticket_price, total_tickets, delta_daa, refund_lock_daa, &creator_refund_spk, state_deposit).is_err());
    println!("  -> PASS: Noncanonical initial state rejected by validate_canonical_kaswin_create");

    // -------------------------------------------------------------
    // TEST 4 — Multi-genesis Group Attack
    // -------------------------------------------------------------
    println!("\n[Test 4] Multi-genesis Group Attack: single funding input attempting to create 2 Kaswin outputs");
    let tx_multi_genesis = Transaction::new(
        1,
        vec![TransactionInput::new(funding_outpoint, vec![], 0, 0)],
        vec![
            initial_output.clone(),
            initial_output.clone(),
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    assert!(validate_canonical_kaswin_create(&tx_multi_genesis, ticket_price, total_tickets, delta_daa, refund_lock_daa, &creator_refund_spk, state_deposit).is_err());
    println!("  -> PASS: Multi-genesis output attempt rejected by validate_canonical_kaswin_create");

    // -------------------------------------------------------------
    // TEST 5 — CREATE -> BUY0
    // -------------------------------------------------------------
    println!("\n[Test 5] CREATE -> BUY0: consuming genesis Output 0, propagating C -> OPEN(5,1)(C)");
    let mut buyer_spk_1 = vec![0x00, 0x00, OpData32 as u8];
    buyer_spk_1.extend(vec![0x11; 32]);
    buyer_spk_1.push(OpCheckSig as u8);
    let count_1 = 5u64;

    let mut siblings_1 = [Hash::default(); TREE_DEPTH];
    for i in 0..TREE_DEPTH { siblings_1[i] = empty_levels[i]; }

    let payout_comm_1 = compute_payout_commitment(&buyer_spk_1);
    let leaf_1 = compute_purchase_leaf(&canonical_round_id, 0, 0, count_1, &payout_comm_1);
    let root_1 = compute_root_from_path(&leaf_1, 0, &siblings_1);

    let initial_open_redeem = build_initial_open_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        delta_daa,
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();

    let next_open_redeem_1 = build_open_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        count_1,
        1,
        root_1,
        delta_daa,
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();
    let next_open_spk_1 = pay_to_script_hash_script(&next_open_redeem_1);

    let mut sig_sb_buy1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_buy1.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_buy1.add_data(&buyer_spk_1).unwrap();
    sig_sb_buy1.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_buy1.add_i64(ACTION_BUY).unwrap();
    sig_sb_buy1.add_data(&initial_open_redeem).unwrap();
    let sig_script_buy1 = sig_sb_buy1.drain();

    let tx_buy1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_create.id(), 0),
            sig_script_buy1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: state_deposit + ticket_price * count_1,
            script_public_key: next_open_spk_1.clone(),
            covenant: Some(CovenantBinding {
                covenant_id: official_covenant_id,
                authorizing_input: 0,
            }),
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );

    let pop_buy1 = PopulatedTransaction::new(&tx_buy1, vec![UtxoEntry::new(
        state_deposit,
        initial_open_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_buy1 = CovenantsContext::from_tx(&pop_buy1).unwrap();
    let ctx_buy1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_buy1);
    let mut vm_buy1 = TxScriptEngine::from_transaction_input(&pop_buy1, &pop_buy1.tx.inputs[0], 0, &pop_buy1.entries[0], ctx_buy1, flags);
    let res_buy1 = vm_buy1.execute();
    assert_eq!(res_buy1, Ok(()));
    let u_buy1 = vm_buy1.used_script_units();
    let b_min_buy1 = ComputeBudget::checked_covering_script_units(u_buy1).unwrap();
    println!("  -> PASS: BUY0 successfully consumed Genesis Output 0 and preserved C [Units: {:?}, B_min: {:?}]", u_buy1, b_min_buy1);

    // -------------------------------------------------------------
    // TEST 6 — Missing Continuation Binding
    // -------------------------------------------------------------
    println!("\n[Test 6] Attack: Missing Continuation Binding (Output 0.covenant = None)");
    let tx_missing_cov = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_create.id(), 0),
            sig_script_buy1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: state_deposit + ticket_price * count_1,
            script_public_key: next_open_spk_1.clone(),
            covenant: None,
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_missing = PopulatedTransaction::new(&tx_missing_cov, vec![UtxoEntry::new(
        state_deposit,
        initial_open_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_m = CovenantsContext::from_tx(&pop_missing).unwrap();
    let ctx_m = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_m);
    let mut vm_m = TxScriptEngine::from_transaction_input(&pop_missing, &pop_missing.tx.inputs[0], 0, &pop_missing.entries[0], ctx_m, flags);
    assert!(vm_m.execute().is_err());
    println!("  -> PASS: Missing continuation binding BLOCKED by OpOutputCovenantId / OpAuthOutputCount!");

    // -------------------------------------------------------------
    // TEST 7 — Final BUY -> Production SEALED
    // -------------------------------------------------------------
    println!("\n[Test 7] Final BUY -> SEALED: preserving covenant_id C");
    let mut buyer_spk_final = vec![0x00, 0x00, OpBlake2b as u8, OpData32 as u8];
    buyer_spk_final.extend(vec![0x33; 32]);
    buyer_spk_final.push(OpEqual as u8);
    let count_final = 95u64;

    let payout_comm_f = compute_payout_commitment(&buyer_spk_final);
    let leaf_f = compute_purchase_leaf(&canonical_round_id, 1, 5, count_final, &payout_comm_f);

    let mut siblings_f = [Hash::default(); TREE_DEPTH];
    siblings_f[0] = leaf_1;
    for i in 1..TREE_DEPTH { siblings_f[i] = empty_levels[i]; }
    let root_final = compute_root_from_path(&leaf_f, 1, &siblings_f);

    let sealed_redeem = build_production_sealed_covenant_v1(
        canonical_round_id,
        ticket_price,
        total_tickets,
        root_final,
        2,
        creator_refund_spk.clone(),
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);

    let mut sig_sb_f = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_f.add_data(&siblings_f[i].as_bytes()).unwrap(); }
    sig_sb_f.add_data(&buyer_spk_final).unwrap();
    sig_sb_f.add_data(&count_final.to_le_bytes()).unwrap();
    sig_sb_f.add_i64(ACTION_BUY).unwrap();
    sig_sb_f.add_data(&next_open_redeem_1).unwrap();
    let sig_script_f = sig_sb_f.drain();

    let full_pool = state_deposit + ticket_price * total_tickets;

    let tx_sealed = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_buy1.id(), 0),
            sig_script_f,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: full_pool,
            script_public_key: sealed_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_sealed = PopulatedTransaction::new(&tx_sealed, vec![UtxoEntry::new(
        state_deposit + ticket_price * count_1,
        next_open_spk_1.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_s = CovenantsContext::from_tx(&pop_sealed).unwrap();
    let ctx_s = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_s);
    let mut vm_s = TxScriptEngine::from_transaction_input(&pop_sealed, &pop_sealed.tx.inputs[0], 0, &pop_sealed.entries[0], ctx_s, flags);
    assert_eq!(vm_s.execute(), Ok(()));
    println!("  -> PASS: Final BUY successfully transitioned OPEN(C) -> SEALED(C)");

    // -------------------------------------------------------------
    // TEST 8 — SEALED -> DRAW_READY(0, C)
    // -------------------------------------------------------------
    println!("\n[Test 8] SEALED(C) -> DRAW_READY(0, C): preserving C");
    let fixture_p_daa = 1_000_099u64;
    let fixture_t_daa = 1_000_100u64;
    let fixture = generate_valid_pass_a_fixture(fixture_p_daa, fixture_t_daa);

    let app_comm = compute_application_commitment(&canonical_round_id, &root_final, total_tickets);
    let seed = compute_random_seed(&fixture.target_hash, &app_comm);

    let draw_ready_redeem = build_draw_ready_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        root_final,
        fixture.target_hash,
        seed,
        creator_refund_spk.clone(),
        0,
    ).unwrap();
    let draw_ready_spk = pay_to_script_hash_script(&draw_ready_redeem);

    let sig_script_draw = build_pass_a_witness(&fixture, &sealed_redeem);

    let tx_draw = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_sealed.id(), 0),
            sig_script_draw,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: full_pool,
            script_public_key: draw_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_draw = PopulatedTransaction::new(&tx_draw, vec![UtxoEntry::new(
        full_pool,
        sealed_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let seq_accessor = MockSeqCommitAccessor {
        selected_chain: vec![fixture.target_hash],
        seq_commits: HashMap::from([(fixture.target_hash, fixture.c_t)]),
    };
    let cov_ctx_d = CovenantsContext::from_tx(&pop_draw).unwrap();
    let ctx_d = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_d).with_seq_commit_accessor(&seq_accessor);
    let mut vm_d = TxScriptEngine::from_transaction_input(&pop_draw, &pop_draw.tx.inputs[0], 0, &pop_draw.entries[0], ctx_d, flags);
    assert_eq!(vm_d.execute(), Ok(()));
    println!("  -> PASS: SEALED(C) successfully transitioned to DRAW_READY(0, C)");

    // -------------------------------------------------------------
    // TEST 9 — Terminal PAID (Winner gets Principal, Creator gets Deposit, Covenant Extinguished)
    // -------------------------------------------------------------
    println!("\n[Test 9] Terminal PAID: WINNER_READY(C) -> Output 0 (Principal) + Output 1 (Deposit), Covenant None");

    let cand_hash = compute_candidate_hash(&seed, 0);
    let cand_num = extract_candidate_num(&cand_hash);
    let winner_index = (cand_num % 100) as u64;

    let prod_winner_ready = build_canonical_winner_ready_redeem_script(
        canonical_round_id,
        ticket_price,
        total_tickets,
        root_final,
        fixture.target_hash,
        seed,
        creator_refund_spk.clone(),
        winner_index,
    );
    let prod_winner_ready_spk = pay_to_script_hash_script(&prod_winner_ready);

    let mut sig_sb_accept = ScriptBuilder::with_flags(flags);
    sig_sb_accept.add_data(&draw_ready_redeem).unwrap();
    let sig_script_accept = sig_sb_accept.drain();

    let tx_accept = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_draw.id(), 0),
            sig_script_accept,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: full_pool,
            script_public_key: prod_winner_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_accept = PopulatedTransaction::new(&tx_accept, vec![UtxoEntry::new(
        full_pool,
        draw_ready_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_acc = CovenantsContext::from_tx(&pop_accept).unwrap();
    let ctx_acc = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_acc);
    let mut vm_acc = TxScriptEngine::from_transaction_input(&pop_accept, &pop_accept.tx.inputs[0], 0, &pop_accept.entries[0], ctx_acc, flags);
    assert_eq!(vm_acc.execute(), Ok(()));

    // Consuming WINNER_READY -> PAID
    let (winner_spk, winner_start, winner_count, winner_purchase_index, winner_siblings) = if winner_index < 5 {
        (buyer_spk_1.clone(), 0u64, count_1, 0u64, {
            let mut s = [Hash::default(); TREE_DEPTH];
            s[0] = leaf_f;
            for i in 1..TREE_DEPTH { s[i] = empty_levels[i]; }
            s
        })
    } else {
        (buyer_spk_final.clone(), 5u64, count_final, 1u64, siblings_f)
    };

    let mut sig_sb_settle = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_settle.add_data(&winner_siblings[i].as_bytes()).unwrap(); }
    sig_sb_settle.add_data(&winner_spk).unwrap();
    sig_sb_settle.add_data(&winner_count.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&winner_start.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&winner_purchase_index.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&prod_winner_ready).unwrap();
    let sig_script_settle = sig_sb_settle.drain();

    let tx_settle = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_accept.id(), 0),
            sig_script_settle,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: ticket_price * total_tickets, // 100 KAS principal
                script_public_key: kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, winner_spk[2..].to_vec()),
                covenant: None, // Lineage strictly TERMINATED!
            },
            TransactionOutput {
                value: state_deposit, // 0.5 KAS deposit returned to creator
                script_public_key: kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
                covenant: None, // Lineage strictly TERMINATED!
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_settle = PopulatedTransaction::new(&tx_settle, vec![UtxoEntry::new(
        full_pool,
        prod_winner_ready_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_set = CovenantsContext::from_tx(&pop_settle).unwrap();
    let ctx_set = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_set);
    let mut vm_set = TxScriptEngine::from_transaction_input(&pop_settle, &pop_settle.tx.inputs[0], 0, &pop_settle.entries[0], ctx_set, flags);
    assert_eq!(vm_set.execute(), Ok(()));
    println!("  -> PASS: Terminal PAID executed successfully, covenant destroyed!");

    println!("\n===============================================================");
    println!("ALL 9 MANDATORY LINEAGE PROVENANCE TESTS PASSED 100%!");
    println!("===============================================================");
}
