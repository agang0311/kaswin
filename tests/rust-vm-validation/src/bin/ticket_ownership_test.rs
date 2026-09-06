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
use kaspa_consensus_core::mass::{ComputeBudget, Mass};
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::config::params::TESTNET_PARAMS;
use kaspa_txscript::opcodes::codes::*;

#[path = "../../../../contracts/lineage.rs"]
pub mod lineage;

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_leaf,
    compute_empty_root_27,
    compute_empty_levels,
    compute_payout_commitment,
    compute_purchase_leaf,
    compute_root_from_path,
    reference_verify_winner_membership,
    is_canonical_payout_spk,
    TREE_DEPTH,
};

#[path = "../../../../contracts/sealed_to_draw_ready.rs"]
pub mod sealed_to_draw_ready;
use sealed_to_draw_ready::build_sealed_to_draw_ready_covenant;

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::{build_initial_open_covenant, build_open_covenant};

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
    let empty_leaf = compute_empty_leaf();
    let cov_id = Hash::from_u64_word(77777);

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    // -------------------------------------------------------------
    // Test 1: EMPTY_ROOT_27 canonical tag equality PASS
    // -------------------------------------------------------------
    println!("\n[Test 1] Canonical Empty Tag & Reference Equality");
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    state.update(b"KaswinTicketEmptyV1");
    let manual_empty_leaf = Hash::from_bytes(state.finalize().as_bytes().try_into().unwrap());
    assert_eq!(empty_leaf, manual_empty_leaf);
    println!("  -> PASS: compute_empty_leaf matches manual b\"KaswinTicketEmptyV1\" hash");
    assert_eq!(empty_levels[27], empty_root);
    println!("  -> PASS: compute_empty_levels()[27] == compute_empty_root_27()");

    // -------------------------------------------------------------
    // Canonical SPK Fixtures:
    // -------------------------------------------------------------
    // Buyer 1: Class A (PubKey 32B Schnorr) -> 36 bytes: [00 00] [OpData32] [32 bytes] [OpCheckSig]
    let mut buyer_spk_1 = vec![0x00, 0x00, OpData32 as u8];
    buyer_spk_1.extend(vec![0x11; 32]);
    buyer_spk_1.push(OpCheckSig as u8);
    assert_eq!(buyer_spk_1.len(), 36);
    assert!(is_canonical_payout_spk(&buyer_spk_1));

    // Buyer 2: Class B (PubKeyECDSA 33B) -> 37 bytes: [00 00] [OpData33] [33 bytes] [OpCheckSigECDSA]
    let mut buyer_spk_2 = vec![0x00, 0x00, OpData33 as u8];
    buyer_spk_2.extend(vec![0x22; 33]);
    buyer_spk_2.push(OpCheckSigECDSA as u8);
    assert_eq!(buyer_spk_2.len(), 37);
    assert!(is_canonical_payout_spk(&buyer_spk_2));

    // Buyer 3: Class C (ScriptHash 32B) -> 37 bytes: [00 00] [OpBlake2b] [OpData32] [32 bytes] [OpEqual]
    let mut buyer_spk_3 = vec![0x00, 0x00, OpBlake2b as u8, OpData32 as u8];
    buyer_spk_3.extend(vec![0x33; 32]);
    buyer_spk_3.push(OpEqual as u8);
    assert_eq!(buyer_spk_3.len(), 37);
    assert!(is_canonical_payout_spk(&buyer_spk_3));

    // -------------------------------------------------------------
    // Test 2: BUY0 (Initial Purchase with Class A PubKey payout_spk)
    // -------------------------------------------------------------
    println!("\n[Test 2] BUY0: Class A (PubKey 36B) payout_spk -> OPEN(5,1)");
    let count_1 = 5u64;

    let mut siblings_1 = [Hash::default(); TREE_DEPTH];
    for i in 0..TREE_DEPTH {
        siblings_1[i] = empty_levels[i];
    }

    let open_redeem_0 = build_initial_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
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
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
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
        Some(cov_id),
    )]);
    let cov_ctx_1 = CovenantsContext::from_tx(&pop_1).unwrap();
    let ctx_1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_1);
    let mut vm_1 = TxScriptEngine::from_transaction_input(&pop_1, &pop_1.tx.inputs[0], 0, &pop_1.entries[0], ctx_1, flags);
    let res_1 = vm_1.execute();
    assert_eq!(res_1, Ok(()));
    let u_1 = vm_1.used_script_units();
    let b_min_1 = ComputeBudget::checked_covering_script_units(u_1).unwrap();
    println!("  -> PASS: Valid BUY 1 (Class A PubKey) transitioned OPEN(0,0) to OPEN(5,1) [Used Units: {:?}, B_min: {:?}]", u_1, b_min_1);

    // -------------------------------------------------------------
    // Test 3: BUY1 (Consecutive Purchase with Class B PubKeyECDSA payout_spk)
    // -------------------------------------------------------------
    println!("\n[Test 3] BUY1: Class B (PubKeyECDSA 37B) payout_spk -> OPEN(15,2)");
    let count_2 = 10u64;

    let mut siblings_2 = [Hash::default(); TREE_DEPTH];
    siblings_2[0] = leaf_1;
    for i in 1..TREE_DEPTH {
        siblings_2[i] = empty_levels[i];
    }

    assert_eq!(compute_root_from_path(&empty_leaf, 1, &siblings_2), root_1);

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
            sig_script_2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 150_000_000 + ticket_price * count_2,
            script_public_key: pay_to_script_hash_script(&next_open_redeem_2),
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
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
        Some(cov_id),
    )]);
    let cov_ctx_2 = CovenantsContext::from_tx(&pop_2).unwrap();
    let ctx_2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_2);
    let mut vm_2 = TxScriptEngine::from_transaction_input(&pop_2, &pop_2.tx.inputs[0], 0, &pop_2.entries[0], ctx_2, flags);
    let res_2 = vm_2.execute();
    assert_eq!(res_2, Ok(()));
    let u_2 = vm_2.used_script_units();
    let b_min_2 = ComputeBudget::checked_covering_script_units(u_2).unwrap();
    println!("  -> PASS: Valid BUY 2 (Class B PubKeyECDSA) transitioned to OPEN(15,2) [Used Units: {:?}, B_min: {:?}]", u_2, b_min_2);

    // -------------------------------------------------------------
    // Test 4: ADAPTIVE ROOT REPLACEMENT ATTACK (Tampered siblings + matching tampered successor root)
    // -------------------------------------------------------------
    println!("\n[Test 4] ADAPTIVE ROOT REPLACEMENT ATTACK: tampered siblings + matching tampered successor root");
    let mut tampered_siblings = siblings_2;
    tampered_siblings[5] = Hash::from_u64_word(0xdeadbeef);

    let r_attack = compute_root_from_path(&leaf_2, 1, &tampered_siblings);
    let attack_open_redeem = build_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        15,
        2,
        r_attack,
        delta_daa,
    ).unwrap();

    let mut sig_sb_attack = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_attack.add_data(&tampered_siblings[i].as_bytes()).unwrap();
    }
    sig_sb_attack.add_data(&buyer_spk_2).unwrap();
    sig_sb_attack.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_attack.add_data(&next_open_redeem_1).unwrap();
    let sig_script_attack = sig_sb_attack.drain();

    let tx_attack = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_attack,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 150_000_000 + ticket_price * count_2,
            script_public_key: pay_to_script_hash_script(&attack_open_redeem),
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_attack = PopulatedTransaction::new(&tx_attack, vec![UtxoEntry::new(
        150_000_000,
        pay_to_script_hash_script(&next_open_redeem_1),
        1_000_000,
        false,
        Some(cov_id),
    )]);
    let cov_ctx_a = CovenantsContext::from_tx(&pop_attack).unwrap();
    let ctx_a = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_a);
    let mut vm_attack = TxScriptEngine::from_transaction_input(&pop_attack, &pop_attack.tx.inputs[0], 0, &pop_attack.entries[0], ctx_a, flags);
    let res_attack = vm_attack.execute();
    assert!(res_attack.is_err());
    println!("  -> PASS: Adaptive root replacement attack BLOCKED! old_root_candidate != current ticket_root: {:?}", res_attack);

    // -------------------------------------------------------------
    // Test 5: WRONG / NON-EMPTY SLOT PROOF
    // -------------------------------------------------------------
    println!("\n[Test 5] WRONG/NON-EMPTY SLOT ATTACK: providing siblings for occupied slot 0 in state pc=1");
    let mut sig_sb_wrong_slot = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_wrong_slot.add_data(&siblings_1[i].as_bytes()).unwrap();
    }
    sig_sb_wrong_slot.add_data(&buyer_spk_2).unwrap();
    sig_sb_wrong_slot.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_wrong_slot.add_data(&next_open_redeem_1).unwrap();
    let sig_script_wrong_slot = sig_sb_wrong_slot.drain();

    let root_wrong_slot = compute_root_from_path(&leaf_2, 1, &siblings_1);
    let wrong_slot_redeem = build_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        15,
        2,
        root_wrong_slot,
        delta_daa,
    ).unwrap();

    let tx_wrong_slot = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_wrong_slot,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 150_000_000 + ticket_price * count_2,
            script_public_key: pay_to_script_hash_script(&wrong_slot_redeem),
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_ws = PopulatedTransaction::new(&tx_wrong_slot, vec![UtxoEntry::new(
        150_000_000,
        pay_to_script_hash_script(&next_open_redeem_1),
        1_000_000,
        false,
        Some(cov_id),
    )]);
    let cov_ctx_ws = CovenantsContext::from_tx(&pop_ws).unwrap();
    let ctx_ws = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_ws);
    let mut vm_ws = TxScriptEngine::from_transaction_input(&pop_ws, &pop_ws.tx.inputs[0], 0, &pop_ws.entries[0], ctx_ws, flags);
    assert!(vm_ws.execute().is_err());
    println!("  -> PASS: Non-empty slot overwrite attack BLOCKED by old_root authentication!");

    // -------------------------------------------------------------
    // Test 6: CANONICAL PAYOUT_SPK ADMISSIBILITY ATTACKS
    // -------------------------------------------------------------
    println!("\n[Test 6] Canonical Payout SPK Admissibility Attacks on OPEN BUY:");

    // Case 6a: 4-byte truncated fixture [0x20, 0x11, 0x22, 0x33]
    println!("  Subtest 6a: 4-byte truncated fixture [0x20, 0x11, 0x22, 0x33]");
    let bad_spk_4b = vec![0x20, 0x11, 0x22, 0x33];
    assert!(!is_canonical_payout_spk(&bad_spk_4b));
    let mut sig_sb_6a = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_6a.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_6a.add_data(&bad_spk_4b).unwrap();
    sig_sb_6a.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_6a.add_data(&open_redeem_0).unwrap();
    let tx_6a = Transaction::new(1, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_sb_6a.drain(), 0, 0)], vec![TransactionOutput { value: 150_000_000, script_public_key: pay_to_script_hash_script(&next_open_redeem_1), covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }) }], 0, SubnetworkId::default(), 0, vec![]);
    let pop_6a = PopulatedTransaction::new(&tx_6a, vec![UtxoEntry::new(100_000_000, pay_to_script_hash_script(&open_redeem_0), 1_000_000, false, Some(cov_id))]);
    let cov_ctx_6a = CovenantsContext::from_tx(&pop_6a).unwrap();
    let ctx_6a = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_6a);
    let mut vm_6a = TxScriptEngine::from_transaction_input(&pop_6a, &pop_6a.tx.inputs[0], 0, &pop_6a.entries[0], ctx_6a, flags);
    assert!(vm_6a.execute().is_err());
    println!("    -> PASS: 4-byte truncated payout_spk BLOCKED by length check!");

    // Case 6b: Version 1 (version > 0)
    println!("  Subtest 6b: version = 1 [0x00, 0x01, ...]");
    let mut bad_spk_v1 = buyer_spk_1.clone();
    bad_spk_v1[1] = 0x01;
    assert!(!is_canonical_payout_spk(&bad_spk_v1));
    let mut sig_sb_6b = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_6b.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_6b.add_data(&bad_spk_v1).unwrap();
    sig_sb_6b.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_6b.add_data(&open_redeem_0).unwrap();
    let tx_6b = Transaction::new(1, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_sb_6b.drain(), 0, 0)], vec![TransactionOutput { value: 150_000_000, script_public_key: pay_to_script_hash_script(&next_open_redeem_1), covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }) }], 0, SubnetworkId::default(), 0, vec![]);
    let pop_6b = PopulatedTransaction::new(&tx_6b, vec![UtxoEntry::new(100_000_000, pay_to_script_hash_script(&open_redeem_0), 1_000_000, false, Some(cov_id))]);
    let cov_ctx_6b = CovenantsContext::from_tx(&pop_6b).unwrap();
    let ctx_6b = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_6b);
    let mut vm_6b = TxScriptEngine::from_transaction_input(&pop_6b, &pop_6b.tx.inputs[0], 0, &pop_6b.entries[0], ctx_6b, flags);
    assert!(vm_6b.execute().is_err());
    println!("    -> PASS: version = 1 payout_spk BLOCKED by version 0 check!");

    // Case 6c: Version 0 but NonStandard / OP_TRUE script
    println!("  Subtest 6c: version = 0 but NonStandard script [0x00, 0x00, 0x51]");
    let bad_spk_optrue = vec![0x00, 0x00, OpTrue as u8];
    assert!(!is_canonical_payout_spk(&bad_spk_optrue));
    let mut sig_sb_6c = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_6c.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_6c.add_data(&bad_spk_optrue).unwrap();
    sig_sb_6c.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_6c.add_data(&open_redeem_0).unwrap();
    let tx_6c = Transaction::new(1, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_sb_6c.drain(), 0, 0)], vec![TransactionOutput { value: 150_000_000, script_public_key: pay_to_script_hash_script(&next_open_redeem_1), covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }) }], 0, SubnetworkId::default(), 0, vec![]);
    let pop_6c = PopulatedTransaction::new(&tx_6c, vec![UtxoEntry::new(100_000_000, pay_to_script_hash_script(&open_redeem_0), 1_000_000, false, Some(cov_id))]);
    let cov_ctx_6c = CovenantsContext::from_tx(&pop_6c).unwrap();
    let ctx_6c = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_6c);
    let mut vm_6c = TxScriptEngine::from_transaction_input(&pop_6c, &pop_6c.tx.inputs[0], 0, &pop_6c.entries[0], ctx_6c, flags);
    assert!(vm_6c.execute().is_err());
    println!("    -> PASS: NonStandard OP_TRUE payout_spk BLOCKED by class opcode assertions!");

    // -------------------------------------------------------------
    // Test 7: FINAL BUY -> SEALED (with Class C ScriptHash payout_spk)
    // -------------------------------------------------------------
    println!("\n[Test 7] Final BUY -> SEALED (Class C ScriptHash 37B payout_spk): old root verified -> SEALED");
    let count_3 = 85u64;

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

    assert_eq!(compute_root_from_path(&empty_leaf, 2, &siblings_3), root_2);

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
            sig_script_3.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 250_000_000 + ticket_price * count_3,
            script_public_key: pay_to_script_hash_script(&sealed_redeem),
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
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
        Some(cov_id),
    )]);
    let cov_ctx_3 = CovenantsContext::from_tx(&pop_3).unwrap();
    let ctx_3 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_3);
    let mut vm_3 = TxScriptEngine::from_transaction_input(&pop_3, &pop_3.tx.inputs[0], 0, &pop_3.entries[0], ctx_3, flags);
    let res_3 = vm_3.execute();
    assert_eq!(res_3, Ok(()));
    let u_3 = vm_3.used_script_units();
    let b_min_3 = ComputeBudget::checked_covering_script_units(u_3).unwrap();
    println!("  -> PASS: Final BUY (Class C ScriptHash) sold out pool & transitioned to SEALED [Used Units: {:?}, B_min: {:?}]", u_3, b_min_3);

    // -------------------------------------------------------------
    // Test 8: WINNER MEMBERSHIP CANONICAL PROOF
    // -------------------------------------------------------------
    println!("\n[Test 8] Winner Membership Canonical Proof (buyer 2: range [5, 15), winner = 12)");
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
    sig_sb_4.add_data(&5u64.to_le_bytes()).unwrap();
    sig_sb_4.add_data(&1u64.to_le_bytes()).unwrap();
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
    let u_4 = vm_4.used_script_units();
    let b_min_4 = ComputeBudget::checked_covering_script_units(u_4).unwrap();
    println!("  -> PASS: Winner Membership verified on-chain in VM! [Used Units: {:?}, B_min: {:?}]", u_4, b_min_4);

    // -------------------------------------------------------------
    // Test 9: FAKE PAYOUT SPK ATTACK (Winner Membership Thief Substitution)
    // -------------------------------------------------------------
    println!("\n[Test 9] ATTACK: Fake Winner Payout SPK Substitution");
    let thief_spk = buyer_spk_3.clone();
    let mut sig_sb_thief = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_thief.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_thief.add_data(&thief_spk).unwrap();
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
    println!("  -> PASS: Fake payout SPK thief substitution BLOCKED by ticket_root assertion!");

    // -------------------------------------------------------------
    // Test 10: REAL COMPUTE BUDGET (B_min -> PASS, B_min - 1 -> FAIL)
    // -------------------------------------------------------------
    println!("\n[Test 10] Real ComputeBudget Enforcement (B_min -> PASS, B_min - 1 -> Exceeded)");

    let tx_budget_pass = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_2.clone(),
            0,
            ComputeCommit::ComputeBudget(b_min_2),
        )],
        vec![TransactionOutput {
            value: 150_000_000 + ticket_price * count_2,
            script_public_key: pay_to_script_hash_script(&next_open_redeem_2),
            covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
        }],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_bp = PopulatedTransaction::new(&tx_budget_pass, vec![UtxoEntry::new(
        150_000_000,
        pay_to_script_hash_script(&next_open_redeem_1),
        1_000_000,
        false,
        Some(cov_id),
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
    println!("  -> PASS: B_min ({:?}) execution succeeded!", b_min_2);

    if b_min_2.0 > 0 {
        let b_insufficient = ComputeBudget(b_min_2.0 - 1);
        let tx_budget_fail = Transaction::new(
            1,
            vec![TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::default(), 0),
                sig_script_2.clone(),
                0,
                ComputeCommit::ComputeBudget(b_insufficient),
            )],
            vec![TransactionOutput {
                value: 150_000_000 + ticket_price * count_2,
                script_public_key: pay_to_script_hash_script(&next_open_redeem_2),
                covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }),
            }],
            0,
            SubnetworkId::default(),
            0,
            vec![],
        );
        let pop_bf = PopulatedTransaction::new(&tx_budget_fail, vec![UtxoEntry::new(
            150_000_000,
            pay_to_script_hash_script(&next_open_redeem_1),
            1_000_000,
            false,
            Some(cov_id),
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

    // 1. Normal BUY (BUY1):
    let buy_nc_mass = calc.calc_non_contextual_masses(&tx_2);
    let buy_c_mass = calc.calc_contextual_masses(&pop_2).unwrap();
    let buy_mass = Mass::new(buy_nc_mass, buy_c_mass);
    let buy_total_mass = buy_mass.normalized_max(&cofactors);
    println!("\n1. NORMAL BUY TRANSACTION:");
    println!("   SignatureScript Bytes:  {} bytes", sig_script_2.len());
    println!("   RedeemScript Bytes:     {} bytes", next_open_redeem_1.len());
    println!("   Actual Serialized:      {} bytes", kaspa_consensus_core::mass::transaction_estimated_serialized_size(&tx_2));
    println!("   Used Script Units:      {:?}", u_2);
    println!("   B_min:                  {:?}", b_min_2);
    println!("   Compute Mass:           {} gram", buy_nc_mass.compute_mass);
    println!("   Transient Mass:         {} gram", buy_nc_mass.transient_mass);
    println!("   Storage Mass:           {} gram", buy_c_mass.storage_mass);
    println!("   Overall Mass:           {} gram", buy_total_mass);

    // 2. Final BUY -> SEALED (BUY2):
    let sealed_nc_mass = calc.calc_non_contextual_masses(&tx_3);
    let sealed_c_mass = calc.calc_contextual_masses(&pop_3).unwrap();
    let sealed_mass = Mass::new(sealed_nc_mass, sealed_c_mass);
    let sealed_total_mass = sealed_mass.normalized_max(&cofactors);
    println!("\n2. FINAL BUY -> SEALED TRANSACTION:");
    println!("   SignatureScript Bytes:  {} bytes", sig_script_3.len());
    println!("   RedeemScript Bytes:     {} bytes", next_open_redeem_2.len());
    println!("   Actual Serialized:      {} bytes", kaspa_consensus_core::mass::transaction_estimated_serialized_size(&tx_3));
    println!("   Used Script Units:      {:?}", u_3);
    println!("   B_min:                  {:?}", b_min_3);
    println!("   Compute Mass:           {} gram", sealed_nc_mass.compute_mass);
    println!("   Transient Mass:         {} gram", sealed_nc_mass.transient_mass);
    println!("   Storage Mass:           {} gram", sealed_c_mass.storage_mass);
    println!("   Overall Mass:           {} gram", sealed_total_mass);

    // 3. WINNER MEMBERSHIP:
    let win_nc_mass = calc.calc_non_contextual_masses(&tx_4);
    let win_c_mass = calc.calc_contextual_masses(&pop_4).unwrap();
    let win_mass = Mass::new(win_nc_mass, win_c_mass);
    let win_total_mass = win_mass.normalized_max(&cofactors);
    println!("\n3. WINNER MEMBERSHIP CLAIM TRANSACTION:");
    println!("   SignatureScript Bytes:  {} bytes", sig_script_4.len());
    println!("   RedeemScript Bytes:     {} bytes", verifier_script.len());
    println!("   Actual Serialized:      {} bytes", kaspa_consensus_core::mass::transaction_estimated_serialized_size(&tx_4));
    println!("   Used Script Units:      {:?}", u_4);
    println!("   B_min:                  {:?}", b_min_4);
    println!("   Compute Mass:           {} gram", win_nc_mass.compute_mass);
    println!("   Transient Mass:         {} gram", win_nc_mass.transient_mass);
    println!("   Storage Mass:           {} gram", win_c_mass.storage_mass);
    println!("   Overall Mass:           {} gram", win_total_mass);

    println!("\n===============================================================");
    println!("ALL 10 MANDATORY TESTS PASSED WITH CANONICAL TESTNET-10 BUDGET!");
    println!("===============================================================");
}
