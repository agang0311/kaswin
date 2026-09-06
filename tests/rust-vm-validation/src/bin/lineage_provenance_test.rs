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
use open_covenant::{build_initial_open_covenant, build_open_covenant};

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::validate_canonical_kaswin_create;

#[path = "../../../../contracts/sealed_to_draw_ready.rs"]
pub mod sealed_to_draw_ready;
use sealed_to_draw_ready::build_sealed_to_draw_ready_covenant;

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;

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
    let delta_daa = 100u64;
    let initial_reserve = 50_000_000u64; // 0.5 KAS

    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(12345), 0);
    let canonical_round_id = compute_canonical_round_id(&funding_outpoint);

    let empty_root = compute_empty_root_27();
    let empty_levels = compute_empty_levels();
    let empty_leaf = compute_empty_leaf();

    // -------------------------------------------------------------
    // TEST 1 — Canonical CREATE
    // -------------------------------------------------------------
    println!("\n[Test 1] Canonical CREATE transaction -> canonical initial OPEN output 0 with KIP-20 covenant ID");

    let initial_open_redeem = build_initial_open_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        delta_daa,
    ).unwrap();
    let initial_open_spk = pay_to_script_hash_script(&initial_open_redeem);

    let mut initial_output = TransactionOutput {
        value: initial_reserve,
        script_public_key: initial_open_spk.clone(),
        covenant: None,
    };

    let official_covenant_id = kaspa_consensus_core::hashing::covenant_id::covenant_id(
        funding_outpoint,
        std::iter::once((0u32, &initial_output)),
    );

    initial_output.covenant = Some(CovenantBinding {
        covenant_id: official_covenant_id,
        authorizing_input: 0,
    });

    let tx_create = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            funding_outpoint,
            vec![],
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
        initial_reserve + 10_000_000,
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
        initial_reserve,
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
    ).unwrap();
    let tx_bad_root = Transaction::new(
        1,
        vec![TransactionInput::new(funding_outpoint, vec![], 0, 0)],
        vec![TransactionOutput {
            value: initial_reserve,
            script_public_key: pay_to_script_hash_script(&noncanonical_open),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    assert!(validate_canonical_kaswin_create(&tx_bad_root, ticket_price, total_tickets, delta_daa, initial_reserve).is_err());
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
    ).unwrap();
    let tx_bad_state = Transaction::new(
        1,
        vec![TransactionInput::new(funding_outpoint, vec![], 0, 0)],
        vec![TransactionOutput {
            value: initial_reserve,
            script_public_key: pay_to_script_hash_script(&noncanonical_state_open),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    assert!(validate_canonical_kaswin_create(&tx_bad_state, ticket_price, total_tickets, delta_daa, initial_reserve).is_err());
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
    assert!(validate_canonical_kaswin_create(&tx_multi_genesis, ticket_price, total_tickets, delta_daa, initial_reserve).is_err());
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

    let next_open_redeem_1 = build_open_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        count_1,
        1,
        root_1,
        delta_daa,
    ).unwrap();
    let next_open_spk_1 = pay_to_script_hash_script(&next_open_redeem_1);

    let mut sig_sb_buy1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_buy1.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_buy1.add_data(&buyer_spk_1).unwrap();
    sig_sb_buy1.add_data(&count_1.to_le_bytes()).unwrap();
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
            value: initial_reserve + ticket_price * count_1,
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
        initial_reserve,
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
            value: initial_reserve + ticket_price * count_1,
            script_public_key: next_open_spk_1.clone(),
            covenant: None,
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_missing = PopulatedTransaction::new(&tx_missing_cov, vec![UtxoEntry::new(
        initial_reserve,
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
    // TEST 7 — Wrong Covenant ID
    // -------------------------------------------------------------
    println!("\n[Test 7] Attack: Wrong Covenant ID (Output 0 binding C2 != C)");
    let wrong_c = Hash::from_u64_word(0x99999);
    let tx_wrong_cov = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_create.id(), 0),
            sig_script_buy1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve + ticket_price * count_1,
            script_public_key: next_open_spk_1.clone(),
            covenant: Some(CovenantBinding { covenant_id: wrong_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_wrong_c = PopulatedTransaction::new(&tx_wrong_cov, vec![UtxoEntry::new(
        initial_reserve,
        initial_open_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_wc = CovenantsContext::from_tx(&pop_wrong_c);
    if let Ok(cov_ctx) = cov_ctx_wc {
        let ctx_wc = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm_wc = TxScriptEngine::from_transaction_input(&pop_wrong_c, &pop_wrong_c.tx.inputs[0], 0, &pop_wrong_c.entries[0], ctx_wc, flags);
        assert!(vm_wc.execute().is_err());
    } else {
        println!("  -> KIP-20 Consensus Context directly rejected: {:?}", cov_ctx_wc.err().unwrap());
    }
    println!("  -> PASS: Wrong covenant ID substitution BLOCKED by consensus / script!");

    // -------------------------------------------------------------
    // TEST 8 — Wrong Authorizing Input
    // -------------------------------------------------------------
    println!("\n[Test 8] Attack: Wrong Authorizing Input (authorizing_input = 1)");
    let tx_wrong_auth = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(tx_create.id(), 0),
                sig_script_buy1.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(555), 0),
                vec![],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![TransactionOutput {
            value: initial_reserve + ticket_price * count_1,
            script_public_key: next_open_spk_1.clone(),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 1 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_wa = PopulatedTransaction::new(&tx_wrong_auth, vec![
        UtxoEntry::new(initial_reserve, initial_open_spk.clone(), 1_000_000, false, Some(official_covenant_id)),
        UtxoEntry::new(10_000_000, initial_open_spk.clone(), 1_000_000, false, None),
    ]);
    let cov_ctx_wa = CovenantsContext::from_tx(&pop_wa);
    if let Ok(cov_ctx) = cov_ctx_wa {
        let ctx_wa = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm_wa = TxScriptEngine::from_transaction_input(&pop_wa, &pop_wa.tx.inputs[0], 0, &pop_wa.entries[0], ctx_wa, flags);
        assert!(vm_wa.execute().is_err());
    } else {
        println!("  -> KIP-20 Consensus Context directly rejected: {:?}", cov_ctx_wa.err().unwrap());
    }
    println!("  -> PASS: Wrong authorizing_input BLOCKED by consensus / script!");

    // -------------------------------------------------------------
    // TEST 9 — Two Authorized Children Attack
    // -------------------------------------------------------------
    println!("\n[Test 9] Attack: Two Authorized Children from single state input (split attack)");
    let tx_two_children = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_create.id(), 0),
            sig_script_buy1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: initial_reserve + ticket_price * count_1,
                script_public_key: next_open_spk_1.clone(),
                covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: 1000,
                script_public_key: next_open_spk_1.clone(),
                covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_tc = PopulatedTransaction::new(&tx_two_children, vec![UtxoEntry::new(
        initial_reserve,
        initial_open_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_tc = CovenantsContext::from_tx(&pop_tc).unwrap();
    let ctx_tc = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_tc);
    let mut vm_tc = TxScriptEngine::from_transaction_input(&pop_tc, &pop_tc.tx.inputs[0], 0, &pop_tc.entries[0], ctx_tc, flags);
    assert!(vm_tc.execute().is_err());
    println!("  -> PASS: Two authorized children attack BLOCKED by OpAuthOutputCount(0) == 1!");

    // -------------------------------------------------------------
    // TEST 10 — Final BUY -> SEALED
    // -------------------------------------------------------------
    println!("\n[Test 10] Final BUY -> SEALED: preserving covenant_id C");
    let mut buyer_spk_3 = vec![0x00, 0x00, OpBlake2b as u8, OpData32 as u8];
    buyer_spk_3.extend(vec![0x33; 32]);
    buyer_spk_3.push(OpEqual as u8);
    let start_ticket_3 = 15u64;
    let count_3 = 85u64;
    let purchase_index_3 = 2u64;

    let mut buyer_spk_2 = vec![0x00, 0x00, OpData33 as u8];
    buyer_spk_2.extend(vec![0x22; 33]);
    buyer_spk_2.push(OpCheckSigECDSA as u8);
    let leaf_2 = compute_purchase_leaf(&canonical_round_id, 1, 5, 10, &compute_payout_commitment(&buyer_spk_2));

    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinTicketNodeV1");
    state.update(leaf_1.as_bytes().as_slice());
    state.update(leaf_2.as_bytes().as_slice());
    let parent_12 = Hash::from_bytes(state.finalize().as_bytes().try_into().unwrap());

    let mut siblings_3 = [Hash::default(); TREE_DEPTH];
    siblings_3[0] = empty_levels[0];
    siblings_3[1] = parent_12;
    for i in 2..TREE_DEPTH { siblings_3[i] = empty_levels[i]; }

    let payout_comm_3 = compute_payout_commitment(&buyer_spk_3);
    let leaf_3 = compute_purchase_leaf(&canonical_round_id, purchase_index_3, start_ticket_3, count_3, &payout_comm_3);
    let root_3 = compute_root_from_path(&leaf_3, purchase_index_3, &siblings_3);

    let sealed_redeem = build_sealed_to_draw_ready_covenant(
        canonical_round_id,
        root_3,
        total_tickets,
        delta_daa,
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);

    let mut siblings_2 = [Hash::default(); TREE_DEPTH];
    siblings_2[0] = leaf_1;
    for i in 1..TREE_DEPTH { siblings_2[i] = empty_levels[i]; }

    let open_redeem_15 = build_open_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        15,
        2,
        compute_root_from_path(&leaf_2, 1, &siblings_2),
        delta_daa,
    ).unwrap();

    let mut sig_sb_buy3 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_buy3.add_data(&siblings_3[i].as_bytes()).unwrap(); }
    sig_sb_buy3.add_data(&buyer_spk_3).unwrap();
    sig_sb_buy3.add_data(&count_3.to_le_bytes()).unwrap();
    sig_sb_buy3.add_data(&open_redeem_15).unwrap();
    let sig_script_buy3 = sig_sb_buy3.drain();

    let tx_sealed = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(777), 0),
            sig_script_buy3,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve + ticket_price * 100,
            script_public_key: sealed_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_sealed = PopulatedTransaction::new(&tx_sealed, vec![UtxoEntry::new(
        initial_reserve + ticket_price * 15,
        pay_to_script_hash_script(&open_redeem_15),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_s = CovenantsContext::from_tx(&pop_sealed).unwrap();
    let ctx_s = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_s);
    let mut vm_s = TxScriptEngine::from_transaction_input(&pop_sealed, &pop_sealed.tx.inputs[0], 0, &pop_sealed.entries[0], ctx_s, flags);
    let res_s = vm_s.execute();
    assert_eq!(res_s, Ok(()));
    println!("  -> PASS: Final BUY successfully transitioned OPEN(C) -> SEALED(C)");

    // -------------------------------------------------------------
    // TEST 11 — SEALED -> DRAW_READY
    // -------------------------------------------------------------
    println!("\n[Test 11] SEALED(C) -> DRAW_READY(0, C): preserving C");
    let fixture_p_daa = 1_000_099u64;
    let fixture_t_daa = 1_000_100u64;
    let fixture = generate_valid_pass_a_fixture(fixture_p_daa, fixture_t_daa);

    let app_comm = sealed_to_draw_ready::compute_application_commitment(&canonical_round_id, &root_3, total_tickets);
    let seed = sealed_to_draw_ready::compute_random_seed(&fixture.target_hash, &app_comm);

    let draw_ready_redeem = build_draw_ready_covenant(
        canonical_round_id,
        root_3,
        total_tickets,
        fixture.target_hash,
        seed,
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
            value: initial_reserve + ticket_price * 100,
            script_public_key: draw_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_draw = PopulatedTransaction::new(&tx_draw, vec![UtxoEntry::new(
        initial_reserve + ticket_price * 100,
        sealed_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let mut seq_accessor = MockSeqCommitAccessor {
        selected_chain: vec![fixture.target_hash],
        seq_commits: HashMap::from([(fixture.target_hash, fixture.c_t)]),
    };
    let cov_ctx_d = CovenantsContext::from_tx(&pop_draw).unwrap();
    let ctx_d = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_d).with_seq_commit_accessor(&seq_accessor);
    let mut vm_d = TxScriptEngine::from_transaction_input(&pop_draw, &pop_draw.tx.inputs[0], 0, &pop_draw.entries[0], ctx_d, flags);
    let res_d = vm_d.execute();
    assert_eq!(res_d, Ok(()));
    println!("  -> PASS: SEALED(C) successfully transitioned to DRAW_READY(0, C)");

    // -------------------------------------------------------------
    // TEST 12 — DRAW Reject / Accept (preserving C)
    // -------------------------------------------------------------
    println!("\n[Test 12] DRAW_READY accept -> WINNER_READY(C): preserving C");
    let cand_hash = compute_candidate_hash(&seed, 0);
    let cand_num = extract_candidate_num(&cand_hash);
    let winner_index = (cand_num % 100) as u64;

    let prod_winner_ready = build_canonical_winner_ready_redeem_script(
        canonical_round_id,
        root_3,
        total_tickets,
        fixture.target_hash,
        seed,
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
            value: initial_reserve + ticket_price * 100,
            script_public_key: prod_winner_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_accept = PopulatedTransaction::new(&tx_accept, vec![UtxoEntry::new(
        initial_reserve + ticket_price * 100,
        draw_ready_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_acc = CovenantsContext::from_tx(&pop_accept).unwrap();
    let ctx_acc = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_acc);
    let mut vm_acc = TxScriptEngine::from_transaction_input(&pop_accept, &pop_accept.tx.inputs[0], 0, &pop_accept.entries[0], ctx_acc, flags);
    let res_acc = vm_acc.execute();
    assert_eq!(res_acc, Ok(()));
    println!("  -> PASS: DRAW_READY(C) accept branch produced WINNER_READY(C)");

    // -------------------------------------------------------------
    // TEST 13 — Terminal PAID
    // -------------------------------------------------------------
    println!("\n[Test 13] Terminal PAID: WINNER_READY(C) -> ordinary payout Output 0 (covenant = None)");
    let winner_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_3[2..].to_vec());

    let mut sig_sb_settle = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_settle.add_data(&siblings_3[i].as_bytes()).unwrap(); }
    sig_sb_settle.add_data(&buyer_spk_3).unwrap();
    sig_sb_settle.add_data(&count_3.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&start_ticket_3.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&purchase_index_3.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&prod_winner_ready).unwrap();
    let sig_script_settle = sig_sb_settle.drain();

    let tx_settle = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_accept.id(), 0),
            sig_script_settle.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve + ticket_price * 100,
            script_public_key: winner_spk.clone(),
            covenant: None, // Lineage strictly TERMINATED!
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_settle = PopulatedTransaction::new(&tx_settle, vec![UtxoEntry::new(
        initial_reserve + ticket_price * 100,
        prod_winner_ready_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_set = CovenantsContext::from_tx(&pop_settle).unwrap();
    let ctx_set = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_set);
    let mut vm_set = TxScriptEngine::from_transaction_input(&pop_settle, &pop_settle.tx.inputs[0], 0, &pop_settle.entries[0], ctx_set, flags);
    let res_set = vm_set.execute();
    assert_eq!(res_set, Ok(()));
    println!("  -> PASS: Terminal PAID executed successfully, covenant destroyed!");

    // -------------------------------------------------------------
    // TEST 14 — PAID Attempts to Retain C
    // -------------------------------------------------------------
    println!("\n[Test 14] Attack: PAID attempts to retain covenant binding C on payout Output 0");
    let tx_retain_c = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_accept.id(), 0),
            sig_script_settle,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve + ticket_price * 100,
            script_public_key: winner_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: official_covenant_id, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_retain = PopulatedTransaction::new(&tx_retain_c, vec![UtxoEntry::new(
        initial_reserve + ticket_price * 100,
        prod_winner_ready_spk.clone(),
        1_000_000,
        false,
        Some(official_covenant_id),
    )]);
    let cov_ctx_ret = CovenantsContext::from_tx(&pop_retain).unwrap();
    let ctx_ret = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_ret);
    let mut vm_ret = TxScriptEngine::from_transaction_input(&pop_retain, &pop_retain.tx.inputs[0], 0, &pop_retain.entries[0], ctx_ret, flags);
    assert!(vm_ret.execute().is_err());
    println!("  -> PASS: Payout retaining covenant ID BLOCKED by OpAuthOutputCount(0) == 0 / OpCovOutputCount(C) == 0!");

    // -------------------------------------------------------------
    // ComputeBudget Recalibration across Key Transitions
    // -------------------------------------------------------------
    println!("\n===============================================================");
    println!("COMPUTE BUDGET RECALIBRATION FOR SINGLETON LINEAGE");
    println!("===============================================================");
    let u_open = vm_buy1.used_script_units();
    let b_open = ComputeBudget::checked_covering_script_units(u_open).unwrap();
    println!("1. OPEN BUY:            {:?} units -> B_min = {:?}", u_open, b_open);

    let u_sealed = vm_d.used_script_units();
    let b_sealed = ComputeBudget::checked_covering_script_units(u_sealed).unwrap();
    println!("2. SEALED -> DRAW:      {:?} units -> B_min = {:?}", u_sealed, b_sealed);

    let u_draw_accept = vm_acc.used_script_units();
    let b_draw_accept = ComputeBudget::checked_covering_script_units(u_draw_accept).unwrap();
    println!("3. DRAW -> WINNER:      {:?} units -> B_min = {:?}", u_draw_accept, b_draw_accept);

    let u_paid = vm_set.used_script_units();
    let b_paid = ComputeBudget::checked_covering_script_units(u_paid).unwrap();
    println!("4. WINNER -> PAID:      {:?} units -> B_min = {:?}", u_paid, b_paid);

    println!("\n===============================================================");
    println!("ALL 14 MANDATORY LINEAGE TESTS PASSED 100%!");
    println!("===============================================================");
}
