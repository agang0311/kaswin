use kaspa_consensus_core::config::params::TESTNET_PARAMS;
use kaspa_consensus_core::mass::{
    ComputeBudget, MassCalculator, transaction_estimated_serialized_size,
};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    ComputeCommit, CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction,
    TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry,
};
use kaspa_hashes::Hash;
use kaspa_txscript::{
    script_builder::ScriptBuilder, standard::pay_to_script_hash_script,
    EngineFlags,
};

#[path = "../../../../contracts/v1_constants.rs"]
pub mod v1_constants;
use v1_constants::{DELTA_DAA_V1, FULL_SALE_RECOVERY_DELAY_DAA_V1};

#[path = "../../../../contracts/ticket_commitment.rs"]
pub mod ticket_commitment;
use ticket_commitment::{
    compute_empty_levels, compute_payout_commitment, compute_purchase_leaf, compute_root_from_path,
    TREE_DEPTH,
};

#[path = "../../../../contracts/refunding_covenant.rs"]
pub mod refunding_covenant;
use refunding_covenant::build_refunding_covenant;

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;
use winner_ready_settlement::build_production_winner_ready_covenant;

#[path = "../../../../contracts/winner_selection.rs"]
pub mod winner_selection;
use winner_selection::build_draw_ready_covenant;

#[path = "../../../../contracts/sealed_covenant.rs"]
pub mod sealed_covenant;
use sealed_covenant::{
    build_production_sealed_covenant_v1, compute_application_commitment, compute_random_seed,
    ACTION_DRAW, ACTION_FULL_REFUND,
};

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::{build_initial_open_covenant, build_open_covenant, ACTION_BUY, ACTION_BEGIN_REFUND, ACTION_RECOVER_EMPTY};

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::build_canonical_kaswin_genesis_output;

// Standard Toccata default mempool relay fee rate: 100_000 sompi/kg = 100 sompi/gram
pub const TOCCATA_DEFAULT_MINIMUM_RELAY_FEE_RATE: u64 = 100_000;

fn calc_min_relay_fee(mass: u64) -> u64 {
    // fee = mass (in grams) * fee_rate (in sompi/kg) / 1000
    (mass * TOCCATA_DEFAULT_MINIMUM_RELAY_FEE_RATE) / 1000
}

fn main() {
    let params = &TESTNET_PARAMS;
    let mass_calc = MassCalculator::new_with_consensus_params(params);
    let cofactors = params.block_mass_cofactors().after();
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    let state_deposit = 50_000_000u64;  // 0.5 KAS
    let ticket_price = 100_000_000u64;  // 1.0 KAS
    let total_tickets = 100u64;
    let refund_lock_daa = 1_500_000u64;

    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(0xabc123), 0);
    let round_id = genesis::compute_canonical_round_id(&funding_outpoint);

    let mut creator_refund_spk = vec![0x00, 0x00, 0x20];
    creator_refund_spk.extend(vec![0xcc; 32]);
    creator_refund_spk.push(0xac);

    let (genesis_out, covenant_id_c) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
        state_deposit,
    ).unwrap();

    let initial_open_redeem = open_covenant::build_initial_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();

    // 1. CREATE Transaction (Size-realistic 66-byte P2PK Schnorr unlock placeholder: 65B signature + 1B sighash)
    let placeholder_p2pk_unlock_66 = vec![0x33; 66];
    let tx_create = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            funding_outpoint,
            placeholder_p2pk_unlock_66,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            genesis_out.clone(),
            TransactionOutput {
                value: 49_900_000,
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_create = PopulatedTransaction::new(&tx_create, vec![
        UtxoEntry::new(100_000_000, ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()), 1_000_000, false, None),
    ]);

    // 2. OPEN BUY (Buyer 0 buys 40 tickets)
    let empty_levels = compute_empty_levels();
    let mut buyer_spk_0 = vec![0x00, 0x00, 0x20];
    buyer_spk_0.extend(vec![0x11; 32]);
    buyer_spk_0.push(0xac);
    let count_0 = 40u64;

    let mut siblings_0 = [Hash::default(); TREE_DEPTH];
    for i in 0..TREE_DEPTH { siblings_0[i] = empty_levels[i]; }
    let payout_comm_0 = compute_payout_commitment(&buyer_spk_0);
    let leaf_0 = compute_purchase_leaf(&round_id, 0, 0, count_0, &payout_comm_0);
    let root_0 = compute_root_from_path(&leaf_0, 0, &siblings_0);

    let mut sig_sb_buy0 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_buy0.add_data(&siblings_0[i].as_bytes()).unwrap(); }
    sig_sb_buy0.add_data(&buyer_spk_0).unwrap();
    sig_sb_buy0.add_data(&count_0.to_le_bytes()).unwrap();
    sig_sb_buy0.add_i64(ACTION_BUY).unwrap();
    sig_sb_buy0.add_data(&initial_open_redeem).unwrap();
    let sig_buy0 = sig_sb_buy0.drain();

    let open_redeem_1 = build_open_covenant(
        round_id, ticket_price, total_tickets, count_0, 1, root_0, DELTA_DAA_V1, refund_lock_daa, creator_refund_spk.clone(),
    ).unwrap();
    let open_spk_1 = pay_to_script_hash_script(&open_redeem_1);
    let pool_amt_40 = state_deposit + ticket_price * count_0;

    let tx_buy0 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_create.id(), 0),
            sig_buy0.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(8)),
        )],
        vec![TransactionOutput {
            value: pool_amt_40,
            script_public_key: open_spk_1.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_buy0 = PopulatedTransaction::new(&tx_buy0, vec![
        UtxoEntry::new(state_deposit, genesis_out.script_public_key.clone(), 1_000_000, false, Some(covenant_id_c)),
    ]);

    // 3. OPEN FINAL BUY (Buyer 1 buys 60 tickets)
    let mut buyer_spk_1 = vec![0x00, 0x00, 0x20];
    buyer_spk_1.extend(vec![0x22; 32]);
    buyer_spk_1.push(0xac);
    let count_1 = 60u64;

    let mut siblings_1 = [Hash::default(); TREE_DEPTH];
    siblings_1[0] = leaf_0;
    for i in 1..TREE_DEPTH { siblings_1[i] = empty_levels[i]; }
    let payout_comm_1 = compute_payout_commitment(&buyer_spk_1);
    let leaf_1 = compute_purchase_leaf(&round_id, 1, 40, count_1, &payout_comm_1);
    let final_root = compute_root_from_path(&leaf_1, 1, &siblings_1);
    let final_pc = 2u64;

    let sealed_redeem = build_production_sealed_covenant_v1(
        round_id, ticket_price, total_tickets, final_root, final_pc, creator_refund_spk.clone(),
    ).unwrap();
    let sealed_spk = pay_to_script_hash_script(&sealed_redeem);
    let full_pool = state_deposit + ticket_price * total_tickets;

    let mut sig_sb_fb = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_fb.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_fb.add_data(&buyer_spk_1).unwrap();
    sig_sb_fb.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_fb.add_i64(ACTION_BUY).unwrap();
    sig_sb_fb.add_data(&open_redeem_1).unwrap();
    let sig_fb = sig_sb_fb.drain();

    let tx_fb = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_buy0.id(), 0),
            sig_fb.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(7)),
        )],
        vec![TransactionOutput {
            value: full_pool,
            script_public_key: sealed_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_fb = PopulatedTransaction::new(&tx_fb, vec![
        UtxoEntry::new(pool_amt_40, open_spk_1.clone(), 1_000_000, false, Some(covenant_id_c)),
    ]);

    // 4. SEALED ACTION_DRAW
    let d0 = 1_000_000u64;
    let boundary = d0 + DELTA_DAA_V1;
    let target_hash = Hash::from_u64_word(999);
    let app_comm = compute_application_commitment(&round_id, &final_root, total_tickets);
    let random_seed = compute_random_seed(&target_hash, &app_comm);

    let draw_ready_redeem_0 = build_draw_ready_covenant(
        round_id, ticket_price, total_tickets, final_root, target_hash, random_seed, creator_refund_spk.clone(), 0,
    ).unwrap();
    let draw_ready_spk_0 = pay_to_script_hash_script(&draw_ready_redeem_0);

    let mut sig_sb_draw = ScriptBuilder::with_flags(flags);
    sig_sb_draw.add_data(&target_hash.as_bytes()).unwrap();
    sig_sb_draw.add_data(&[0x01; 32]).unwrap();
    sig_sb_draw.add_data(&[0x02; 32]).unwrap();
    sig_sb_draw.add_data(&1_700_000_010u64.to_le_bytes()).unwrap();
    sig_sb_draw.add_data(&boundary.to_le_bytes()).unwrap();
    sig_sb_draw.add_data(&(boundary - 100).to_le_bytes()).unwrap();
    sig_sb_draw.add_data(&[0x03; 32]).unwrap();
    sig_sb_draw.add_data(&[0x04; 32]).unwrap();
    sig_sb_draw.add_data(&[0x05; 32]).unwrap();
    sig_sb_draw.add_data(&1_700_000_000u64.to_le_bytes()).unwrap();
    sig_sb_draw.add_data(&(boundary - 1).to_le_bytes()).unwrap();
    sig_sb_draw.add_data(&(boundary - 101).to_le_bytes()).unwrap();
    sig_sb_draw.add_i64(ACTION_DRAW).unwrap();
    sig_sb_draw.add_data(&sealed_redeem).unwrap();
    let sig_draw = sig_sb_draw.drain();

    let tx_draw = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_fb.id(), 0),
            sig_draw.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(2)),
        )],
        vec![TransactionOutput {
            value: full_pool,
            script_public_key: draw_ready_spk_0.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_draw = PopulatedTransaction::new(&tx_draw, vec![
        UtxoEntry::new(full_pool, sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);

    // 5. DRAW_READY ACCEPT -> WINNER_READY
    let winner_index = 71u64;
    let winner_ready_redeem = build_production_winner_ready_covenant(
        round_id, ticket_price, total_tickets, final_root, target_hash, random_seed, creator_refund_spk.clone(), winner_index,
    ).unwrap();
    let winner_ready_spk = pay_to_script_hash_script(&winner_ready_redeem);

    let mut sig_sb_dr_acc = ScriptBuilder::with_flags(flags);
    sig_sb_dr_acc.add_data(&draw_ready_redeem_0).unwrap();
    let sig_dr_acc = sig_sb_dr_acc.drain();

    let tx_dr_acc = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_draw.id(), 0),
            sig_dr_acc.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(1)),
        )],
        vec![TransactionOutput {
            value: full_pool,
            script_public_key: winner_ready_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_dr_acc = PopulatedTransaction::new(&tx_dr_acc, vec![
        UtxoEntry::new(full_pool, draw_ready_spk_0.clone(), d0 + 1, false, Some(covenant_id_c)),
    ]);

    // 6. DRAW_READY REJECT -> DRAW_READY(1)
    let draw_ready_redeem_1 = build_draw_ready_covenant(
        round_id, ticket_price, total_tickets, final_root, target_hash, random_seed, creator_refund_spk.clone(), 1,
    ).unwrap();
    let draw_ready_spk_1 = pay_to_script_hash_script(&draw_ready_redeem_1);

    let tx_dr_rej = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_draw.id(), 0),
            sig_dr_acc.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(1)),
        )],
        vec![TransactionOutput {
            value: full_pool,
            script_public_key: draw_ready_spk_1.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_dr_rej = PopulatedTransaction::new(&tx_dr_rej, vec![
        UtxoEntry::new(full_pool, draw_ready_spk_0.clone(), d0 + 1, false, Some(covenant_id_c)),
    ]);

    // 7. WINNER_READY -> PAID (Atomic Settlement)
    let mut sig_sb_settle = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_settle.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_settle.add_data(&buyer_spk_1).unwrap();
    sig_sb_settle.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&40u64.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&1u64.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&winner_ready_redeem).unwrap();
    let sig_settle = sig_sb_settle.drain();

    let tx_settle = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_dr_acc.id(), 0),
            sig_settle.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(1)),
        )],
        vec![
            TransactionOutput {
                value: ticket_price * total_tickets, // 100 KAS principal
                script_public_key: ScriptPublicKey::from_vec(0, buyer_spk_1[2..].to_vec()),
                covenant: None,
            },
            TransactionOutput {
                value: state_deposit, // 0.5 KAS deposit
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_settle = PopulatedTransaction::new(&tx_settle, vec![
        UtxoEntry::new(full_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
    ]);

    // 8. SEALED -> FULL_REFUND
    let ref_redeem_0 = build_refunding_covenant(
        round_id, ticket_price, total_tickets, final_root, creator_refund_spk.clone(), final_pc, 0, total_tickets,
    ).unwrap();
    let ref_spk_0 = pay_to_script_hash_script(&ref_redeem_0);

    let mut sig_sb_fr = ScriptBuilder::with_flags(flags);
    sig_sb_fr.add_i64(ACTION_FULL_REFUND).unwrap();
    sig_sb_fr.add_data(&sealed_redeem).unwrap();
    let sig_fr = sig_sb_fr.drain();

    let tx_fr = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_fb.id(), 0),
            sig_fr.clone(),
            FULL_SALE_RECOVERY_DELAY_DAA_V1,
            ComputeCommit::ComputeBudget(ComputeBudget(2)),
        )],
        vec![TransactionOutput {
            value: full_pool,
            script_public_key: ref_spk_0.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_fr = PopulatedTransaction::new(&tx_fr, vec![
        UtxoEntry::new(full_pool, sealed_spk.clone(), d0, false, Some(covenant_id_c)),
    ]);

    // 9. RECOVER_EMPTY (Zero-sale)
    let mut sig_sb_empty = ScriptBuilder::with_flags(flags);
    sig_sb_empty.add_i64(ACTION_RECOVER_EMPTY).unwrap();
    sig_sb_empty.add_data(&initial_open_redeem).unwrap();
    let sig_empty = sig_sb_empty.drain();

    let tx_empty = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            funding_outpoint,
            sig_empty.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(1)),
        )],
        vec![TransactionOutput {
            value: state_deposit,
            script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
            covenant: None,
        }],
        refund_lock_daa, SubnetworkId::default(), 0, vec![],
    );
    let pop_empty = PopulatedTransaction::new(&tx_empty, vec![
        UtxoEntry::new(state_deposit, genesis_out.script_public_key.clone(), refund_lock_daa + 1, false, Some(covenant_id_c)),
    ]);

    // 10. BEGIN_REFUND (Partial-sale)
    let partial_ref_redeem_c0 = build_refunding_covenant(
        round_id, ticket_price, total_tickets, root_0, creator_refund_spk.clone(), 1, 0, count_0,
    ).unwrap();
    let partial_ref_spk_c0 = pay_to_script_hash_script(&partial_ref_redeem_c0);

    let mut sig_sb_pbr = ScriptBuilder::with_flags(flags);
    sig_sb_pbr.add_i64(ACTION_BEGIN_REFUND).unwrap();
    sig_sb_pbr.add_data(&open_redeem_1).unwrap();
    let sig_pbr = sig_sb_pbr.drain();

    let tx_pbr = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_buy0.id(), 0),
            sig_pbr.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(3)),
        )],
        vec![TransactionOutput {
            value: pool_amt_40,
            script_public_key: partial_ref_spk_c0.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        refund_lock_daa, SubnetworkId::default(), 0, vec![],
    );
    let pop_pbr = PopulatedTransaction::new(&tx_pbr, vec![
        UtxoEntry::new(pool_amt_40, open_spk_1.clone(), refund_lock_daa + 1, false, Some(covenant_id_c)),
    ]);

    // 11. REFUNDING normal (Step 1)
    let ref_redeem_c1 = build_refunding_covenant(
        round_id, ticket_price, total_tickets, final_root, creator_refund_spk.clone(), final_pc, 1, 60,
    ).unwrap();
    let ref_spk_c1 = pay_to_script_hash_script(&ref_redeem_c1);

    let mut sibs_0_tree = [Hash::default(); TREE_DEPTH];
    sibs_0_tree[0] = leaf_1;
    for i in 1..TREE_DEPTH { sibs_0_tree[i] = empty_levels[i]; }

    let mut sig_sb_r1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r1.add_data(&sibs_0_tree[i].as_bytes()).unwrap(); }
    sig_sb_r1.add_data(&buyer_spk_0).unwrap();
    sig_sb_r1.add_data(&count_0.to_le_bytes()).unwrap();
    sig_sb_r1.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_r1.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_r1.add_data(&ref_redeem_0).unwrap();
    let sig_r1 = sig_sb_r1.drain();

    let pool_rem_60 = full_pool - ticket_price * count_0;

    let tx_r1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_fr.id(), 0),
            sig_r1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(2)),
        )],
        vec![
            TransactionOutput {
                value: pool_rem_60,
                script_public_key: ref_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ticket_price * count_0,
                script_public_key: ScriptPublicKey::from_vec(0, buyer_spk_0[2..].to_vec()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_r1 = PopulatedTransaction::new(&tx_r1, vec![
        UtxoEntry::new(full_pool, ref_spk_0.clone(), d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1, false, Some(covenant_id_c)),
    ]);

    // 12. REFUNDING final (Step 2)
    let mut sig_sb_r2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r2.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_r2.add_data(&buyer_spk_1).unwrap();
    sig_sb_r2.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&40u64.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&1u64.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&ref_redeem_c1).unwrap();
    let sig_r2 = sig_sb_r2.drain();

    let tx_r2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_r1.id(), 0),
            sig_r2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(1)),
        )],
        vec![
            TransactionOutput {
                value: state_deposit,
                script_public_key: ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec()),
                covenant: None,
            },
            TransactionOutput {
                value: ticket_price * count_1,
                script_public_key: ScriptPublicKey::from_vec(0, buyer_spk_1[2..].to_vec()),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_r2 = PopulatedTransaction::new(&tx_r2, vec![
        UtxoEntry::new(pool_rem_60, ref_spk_c1.clone(), d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1 + 1, false, Some(covenant_id_c)),
    ]);

    // AUDIT CALCULATION HELPER
    let audit_step = |name: &str, tx: &Transaction, pop: &PopulatedTransaction, redeem_len: usize, used_su: u64, b_min: u64| {
        let non_ctx = mass_calc.calc_non_contextual_masses(tx);
        let ctx = mass_calc.calc_contextual_masses(pop).unwrap();
        let compute_mass = non_ctx.compute_mass;
        let transient_mass = non_ctx.transient_mass;
        let storage_mass = ctx.storage_mass;

        let norm_transient = non_ctx.normalized_transient(&cofactors);
        let norm_storage = (storage_mass as f64 * cofactors.storage).ceil() as u64;
        let overall_mass = compute_mass.max(norm_transient).max(norm_storage);
        let min_fee = calc_min_relay_fee(overall_mass);
        let est_size = transaction_estimated_serialized_size(tx);

        println!("=== {} ===", name);
        println!("  signature_script_bytes:  {} bytes", tx.inputs[0].signature_script.len());
        println!("  redeem_script_bytes:     {} bytes", redeem_len);
        println!("  serialized_tx_bytes:     {} bytes", est_size);
        println!("  used_script_units:       {} SU", used_su);
        println!("  B_min:                   ComputeBudget({})", b_min);
        println!("  compute_mass:            {} grams", compute_mass);
        println!("  transient_mass:          {} grams (norm: {})", transient_mass, norm_transient);
        println!("  storage_mass:            {} units (norm: {})", storage_mass, norm_storage);
        println!("  overall_normalized_mass: {} grams", overall_mass);
        println!("  default_min_relay_fee:   {} sompi", min_fee);
        println!();
    };

    println!("==================================================================");
    println!("KASWIN V1 PRODUCTION PHYSICAL RESOURCE & MASS AUDIT (12 PATHS)");
    println!("==================================================================\n");

    audit_step("1. CREATE (with size-realistic 66B P2PK unlock placeholder)", &tx_create, &pop_create, 0, 0, 0);
    audit_step("2. OPEN BUY (Non-final, Buyer 0)", &tx_buy0, &pop_buy0, initial_open_redeem.len(), 81107, 8);
    audit_step("3. OPEN FINAL BUY (Buyer 1)", &tx_fb, &pop_fb, open_redeem_1.len(), 79715, 7);
    audit_step("4. SEALED ACTION_DRAW", &tx_draw, &pop_draw, sealed_redeem.len(), 23781, 2);
    audit_step("5. DRAW_READY ACCEPT -> WINNER_READY", &tx_dr_acc, &pop_dr_acc, draw_ready_redeem_0.len(), 14734, 1);
    audit_step("6. DRAW_READY REJECT -> DRAW_READY(1)", &tx_dr_rej, &pop_dr_rej, draw_ready_redeem_0.len(), 14812, 1);
    audit_step("7. WINNER_READY -> PAID (Atomic Settlement)", &tx_settle, &pop_settle, winner_ready_redeem.len(), 15568, 1);
    audit_step("8. SEALED -> FULL_REFUND", &tx_fr, &pop_fr, sealed_redeem.len(), 20601, 2);
    audit_step("9. RECOVER_EMPTY (Zero-sale)", &tx_empty, &pop_empty, initial_open_redeem.len(), 19918, 1);
    audit_step("10. BEGIN_REFUND (Partial-sale)", &tx_pbr, &pop_pbr, open_redeem_1.len(), 30302, 3);
    audit_step("11. REFUNDING normal (Step 1)", &tx_r1, &pop_r1, ref_redeem_0.len(), 24206, 2);
    audit_step("12. REFUNDING final (Step 2)", &tx_r2, &pop_r2, ref_redeem_c1.len(), 15817, 1);
}
