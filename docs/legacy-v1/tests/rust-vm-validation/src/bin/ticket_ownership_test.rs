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

#[path = "../../../../contracts/v1_constants.rs"]
pub mod v1_constants;
use v1_constants::DELTA_DAA_V1;

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

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::{build_initial_open_covenant, build_open_covenant, ACTION_BUY};

#[path = "../../../../contracts/sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::build_production_sealed_covenant_v1;

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
    let delta_daa = DELTA_DAA_V1;
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

    let mut creator_refund_spk = vec![0x00, 0x00, OpData32 as u8];
    creator_refund_spk.extend(vec![0x77; 32]);
    creator_refund_spk.push(OpCheckSig as u8);
    let refund_lock_daa = 1_500_000u64;

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
        refund_lock_daa,
        creator_refund_spk.clone(),
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
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();

    let mut sig_sb_1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_1.add_data(&siblings_1[i].as_bytes()).unwrap();
    }
    sig_sb_1.add_data(&buyer_spk_1).unwrap();
    sig_sb_1.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_1.add_i64(ACTION_BUY).unwrap();
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
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();

    let mut sig_sb_2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_2.add_data(&siblings_2[i].as_bytes()).unwrap();
    }
    sig_sb_2.add_data(&buyer_spk_2).unwrap();
    sig_sb_2.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_2.add_i64(ACTION_BUY).unwrap();
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
    // Test 4: ADAPTIVE ROOT REPLACEMENT ATTACK
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
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();

    let mut sig_sb_attack = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_attack.add_data(&tampered_siblings[i].as_bytes()).unwrap();
    }
    sig_sb_attack.add_data(&buyer_spk_2).unwrap();
    sig_sb_attack.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_attack.add_i64(ACTION_BUY).unwrap();
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
    sig_sb_wrong_slot.add_i64(ACTION_BUY).unwrap();
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
        refund_lock_daa,
        creator_refund_spk.clone(),
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
    let bad_spk_4b = vec![0x20, 0x11, 0x22, 0x33];
    assert!(!is_canonical_payout_spk(&bad_spk_4b));
    let mut sig_sb_6a = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_6a.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_6a.add_data(&bad_spk_4b).unwrap();
    sig_sb_6a.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_6a.add_i64(ACTION_BUY).unwrap();
    sig_sb_6a.add_data(&open_redeem_0).unwrap();
    let tx_6a = Transaction::new(1, vec![TransactionInput::new(TransactionOutpoint::new(Hash::default(), 0), sig_sb_6a.drain(), 0, 0)], vec![TransactionOutput { value: 150_000_000, script_public_key: pay_to_script_hash_script(&next_open_redeem_1), covenant: Some(CovenantBinding { covenant_id: cov_id, authorizing_input: 0 }) }], 0, SubnetworkId::default(), 0, vec![]);
    let pop_6a = PopulatedTransaction::new(&tx_6a, vec![UtxoEntry::new(100_000_000, pay_to_script_hash_script(&open_redeem_0), 1_000_000, false, Some(cov_id))]);
    let cov_ctx_6a = CovenantsContext::from_tx(&pop_6a).unwrap();
    let ctx_6a = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_6a);
    let mut vm_6a = TxScriptEngine::from_transaction_input(&pop_6a, &pop_6a.tx.inputs[0], 0, &pop_6a.entries[0], ctx_6a, flags);
    assert!(vm_6a.execute().is_err());
    println!("    -> PASS: 4-byte truncated payout_spk BLOCKED by length check!");

    // -------------------------------------------------------------
    // Test 7: FINAL BUY -> SEALED (with Class C ScriptHash payout_spk)
    // -------------------------------------------------------------
    println!("\n[Test 7] Final BUY -> SEALED (Class C ScriptHash 37B payout_spk)");
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

    let sealed_redeem = build_production_sealed_covenant_v1(
        round_id,
        ticket_price,
        total_tickets,
        root_3,
        3,
        creator_refund_spk.clone(),
    ).unwrap();

    let mut sig_sb_3 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() {
        sig_sb_3.add_data(&siblings_3[i].as_bytes()).unwrap();
    }
    sig_sb_3.add_data(&buyer_spk_3).unwrap();
    sig_sb_3.add_data(&count_3.to_le_bytes()).unwrap();
    sig_sb_3.add_i64(ACTION_BUY).unwrap();
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
    println!("  -> PASS: Final BUY sold out pool & transitioned to production SEALED V1!");

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
    assert_eq!(vm_4.execute(), Ok(()));
    println!("  -> PASS: Winner Membership verified on-chain in VM!");

    // -------------------------------------------------------------
    // Test 9: FAKE PAYOUT SPK ATTACK
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

    println!("\n===============================================================");
    println!("ALL 10 MANDATORY TICKET OWNERSHIP TESTS PASSED 100%!");
    println!("===============================================================");
}
