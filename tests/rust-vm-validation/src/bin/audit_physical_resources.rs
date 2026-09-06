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

/// Standard P2PK 66-byte signature script placeholder:
/// 1 byte OP_DATA_65 + 64 byte Schnorr signature + 1 byte sighash type = 66 bytes.
fn make_p2pk_unlock_placeholder() -> Vec<u8> {
    vec![0x41; 66]
}

/// Standard 34-byte P2PK script public key: 0x00, 0x00, 32-byte pubkey
fn make_p2pk_spk(tag: u8) -> ScriptPublicKey {
    let mut script = vec![0x00, 0x00];
    script.extend(vec![tag; 32]);
    ScriptPublicKey::from_vec(0, script)
}

fn calc_min_relay_fee(fee_mass: u64) -> u64 {
    // fee = fee_mass (in grams) * fee_rate (in sompi/kg) / 1000
    (fee_mass * TOCCATA_DEFAULT_MINIMUM_RELAY_FEE_RATE) / 1000
}

struct PathAuditResult {
    pub name: String,
    pub kaswin_inputs: usize,
    pub ordinary_inputs: usize,
    pub outputs: usize,
    pub signature_script_bytes_total: usize,
    pub redeem_script_bytes: usize,
    pub serialized_tx_bytes: u64,
    pub used_script_units: u64,
    pub b_min: u64,
    pub compute_mass: u64,
    pub transient_mass: u64,
    pub normalized_transient_mass: u64,
    pub storage_mass: u64,
    pub normalized_storage_mass: u64,
    pub fee_mass: u64,
    pub default_min_relay_fee: u64,
    pub actual_fixture_fee: u64,
    pub fee_sufficient: bool,
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
    let creator_spk = ScriptPublicKey::from_vec(0, creator_refund_spk[2..].to_vec());

    let (genesis_out, covenant_id_c) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
        state_deposit,
    ).unwrap();

    let initial_open_redeem = build_initial_open_covenant(
        round_id,
        ticket_price,
        total_tickets,
        DELTA_DAA_V1,
        refund_lock_daa,
        creator_refund_spk.clone(),
    ).unwrap();

    let p2pk_sig_66 = make_p2pk_unlock_placeholder();
    let ordinary_fee_spk = make_p2pk_spk(0xfe);

    let audit_step = |
        name: &str,
        tx: &Transaction,
        pop: &PopulatedTransaction,
        kaswin_in_cnt: usize,
        redeem_script_bytes: usize,
        used_su: u64,
        b_min: u64,
        actual_fee: u64,
    | -> PathAuditResult {
        let non_ctx = mass_calc.calc_non_contextual_masses(tx);
        let ctx = mass_calc.calc_contextual_masses(pop).unwrap();

        let norm_transient = non_ctx.normalized_transient(&cofactors);
        let norm_storage = (ctx.storage_mass as f64 * cofactors.storage).ceil() as u64;
        let fee_mass = non_ctx.compute_mass.max(norm_transient);
        let default_min_relay_fee = calc_min_relay_fee(fee_mass);
        let est_size = transaction_estimated_serialized_size(tx);
        let sig_script_total: usize = tx.inputs.iter().map(|i| i.signature_script.len()).sum();

        PathAuditResult {
            name: name.to_string(),
            kaswin_inputs: kaswin_in_cnt,
            ordinary_inputs: tx.inputs.len() - kaswin_in_cnt,
            outputs: tx.outputs.len(),
            signature_script_bytes_total: sig_script_total,
            redeem_script_bytes,
            serialized_tx_bytes: est_size,
            used_script_units: used_su,
            b_min,
            compute_mass: non_ctx.compute_mass,
            transient_mass: non_ctx.transient_mass,
            normalized_transient_mass: norm_transient,
            storage_mass: ctx.storage_mass,
            normalized_storage_mass: norm_storage,
            fee_mass,
            default_min_relay_fee,
            actual_fixture_fee: actual_fee,
            fee_sufficient: actual_fee >= default_min_relay_fee,
        }
    };

    let mut results = Vec::new();

    // -------------------------------------------------------------
    // 1. CREATE (Funding Input 1.0 KAS -> Genesis 0.5 KAS + Change 0.498 KAS, Fee 0.002 KAS)
    // -------------------------------------------------------------
    let create_funding_val = 100_000_000u64; // 1.0 KAS
    let create_fee = 200_000u64; // 0.002 KAS
    let create_change = create_funding_val - state_deposit - create_fee;
    let tx_create = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            funding_outpoint,
            p2pk_sig_66.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            genesis_out.clone(),
            TransactionOutput {
                value: create_change,
                script_public_key: creator_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_create = PopulatedTransaction::new(&tx_create, vec![
        UtxoEntry::new(create_funding_val, creator_spk.clone(), 1_000_000, false, None),
    ]);
    results.push(audit_step("1. CREATE", &tx_create, &pop_create, 0, 0, 0, 0, create_fee));

    // -------------------------------------------------------------
    // 2. OPEN BUY (Buyer 0 buys 40 tickets)
    // Input 0: Genesis (0.5 KAS), Input 1: Buyer 0 (50 KAS)
    // Output 0: OPEN(sold=40, pc=1, 40.5 KAS), Output 1: Change (9.97 KAS)
    // -------------------------------------------------------------
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
    let pool_amt_40 = state_deposit + ticket_price * count_0; // 40.5 KAS
    let buyer0_funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(0xb0), 0);
    let buyer0_funding_val = 50_000_000_000u64; // 50 KAS
    let buyer0_ticket_payment = ticket_price * count_0; // 40 KAS
    let buy0_fee = 2_500_000u64; // 0.025 KAS
    let buyer0_change = buyer0_funding_val - buyer0_ticket_payment - buy0_fee;

    let tx_buy0 = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(funding_outpoint.transaction_id, 0),
                sig_buy0.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(8)),
            ),
            TransactionInput::new_with_mass(
                buyer0_funding_outpoint,
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_amt_40,
                script_public_key: open_spk_1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: buyer0_change,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_buy0 = PopulatedTransaction::new(&tx_buy0, vec![
        UtxoEntry::new(state_deposit, genesis_out.script_public_key.clone(), 1_000_000, false, Some(covenant_id_c)),
        UtxoEntry::new(buyer0_funding_val, ordinary_fee_spk.clone(), 1_000_000, false, None),
    ]);
    results.push(audit_step("2. OPEN BUY (Buyer 0, 40 tickets)", &tx_buy0, &pop_buy0, 1, initial_open_redeem.len(), 81107, 8, buy0_fee));

    // -------------------------------------------------------------
    // 3. OPEN FINAL BUY (Buyer 1 buys 60 tickets -> Sells out round)
    // -------------------------------------------------------------
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
    let full_pool = state_deposit + ticket_price * total_tickets; // 100.5 KAS

    let mut sig_sb_fb = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_fb.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_fb.add_data(&buyer_spk_1).unwrap();
    sig_sb_fb.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_fb.add_i64(ACTION_BUY).unwrap();
    sig_sb_fb.add_data(&open_redeem_1).unwrap();
    let sig_fb = sig_sb_fb.drain();

    let buyer1_funding_val = 70_000_000_000u64; // 70 KAS
    let buyer1_ticket_payment = ticket_price * count_1; // 60 KAS
    let fb_fee = 2_500_000u64; // 0.025 KAS
    let buyer1_change = buyer1_funding_val - buyer1_ticket_payment - fb_fee;

    let tx_fb = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x22), 0),
                sig_fb.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(7)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xb1), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: full_pool,
                script_public_key: sealed_spk.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: buyer1_change,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_fb = PopulatedTransaction::new(&tx_fb, vec![
        UtxoEntry::new(pool_amt_40, open_spk_1.clone(), 1_000_000, false, Some(covenant_id_c)),
        UtxoEntry::new(buyer1_funding_val, ordinary_fee_spk.clone(), 1_000_000, false, None),
    ]);
    results.push(audit_step("3. OPEN FINAL BUY (Buyer 1, 60 tickets)", &tx_fb, &pop_fb, 1, open_redeem_1.len(), 79715, 7, fb_fee));

    // -------------------------------------------------------------
    // 4. SEALED ACTION_DRAW
    // -------------------------------------------------------------
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

    let ordinary_fee_val = 1_000_000_000u64; // 10 KAS ordinary fee UTXO
    let draw_fee = 1_500_000u64;

    let tx_draw = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x33), 0),
                sig_draw.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(2)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee1), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: full_pool,
                script_public_key: draw_ready_spk_0.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ordinary_fee_val - draw_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_draw = PopulatedTransaction::new(&tx_draw, vec![
        UtxoEntry::new(full_pool, sealed_spk.clone(), d0, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), d0, false, None),
    ]);
    results.push(audit_step("4. SEALED ACTION_DRAW", &tx_draw, &pop_draw, 1, sealed_redeem.len(), 23781, 2, draw_fee));

    // -------------------------------------------------------------
    // 5. DRAW_READY ACCEPT -> WINNER_READY
    // -------------------------------------------------------------
    let winner_index = 71u64;
    let winner_ready_redeem = build_production_winner_ready_covenant(
        round_id, ticket_price, total_tickets, final_root, target_hash, random_seed, creator_refund_spk.clone(), winner_index,
    ).unwrap();
    let winner_ready_spk = pay_to_script_hash_script(&winner_ready_redeem);

    let mut sig_sb_dr_acc = ScriptBuilder::with_flags(flags);
    sig_sb_dr_acc.add_data(&draw_ready_redeem_0).unwrap();
    let sig_dr_acc = sig_sb_dr_acc.drain();
    let dr_acc_fee = 1_000_000u64;

    let tx_dr_acc = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x44), 0),
                sig_dr_acc.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(1)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee2), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: full_pool,
                script_public_key: winner_ready_spk.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ordinary_fee_val - dr_acc_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_dr_acc = PopulatedTransaction::new(&tx_dr_acc, vec![
        UtxoEntry::new(full_pool, draw_ready_spk_0.clone(), d0 + 1, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), d0 + 1, false, None),
    ]);
    results.push(audit_step("5. DRAW_READY ACCEPT -> WINNER_READY", &tx_dr_acc, &pop_dr_acc, 1, draw_ready_redeem_0.len(), 14734, 1, dr_acc_fee));

    // -------------------------------------------------------------
    // 6. DRAW_READY REJECT -> DRAW_READY(1)
    // -------------------------------------------------------------
    let draw_ready_redeem_1 = build_draw_ready_covenant(
        round_id, ticket_price, total_tickets, final_root, target_hash, random_seed, creator_refund_spk.clone(), 1,
    ).unwrap();
    let draw_ready_spk_1 = pay_to_script_hash_script(&draw_ready_redeem_1);
    let dr_rej_fee = 1_000_000u64;

    let tx_dr_rej = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x44), 0),
                sig_dr_acc.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(1)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee3), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: full_pool,
                script_public_key: draw_ready_spk_1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ordinary_fee_val - dr_rej_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_dr_rej = PopulatedTransaction::new(&tx_dr_rej, vec![
        UtxoEntry::new(full_pool, draw_ready_spk_0.clone(), d0 + 1, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), d0 + 1, false, None),
    ]);
    results.push(audit_step("6. DRAW_READY REJECT -> DRAW_READY(1)", &tx_dr_rej, &pop_dr_rej, 1, draw_ready_redeem_0.len(), 14812, 1, dr_rej_fee));

    // -------------------------------------------------------------
    // 7. WINNER_READY -> PAID (Atomic Settlement)
    // -------------------------------------------------------------
    let mut sig_sb_settle = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_settle.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_settle.add_data(&buyer_spk_1).unwrap();
    sig_sb_settle.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&40u64.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&1u64.to_le_bytes()).unwrap();
    sig_sb_settle.add_data(&winner_ready_redeem).unwrap();
    let sig_settle = sig_sb_settle.drain();
    let settle_fee = 1_500_000u64;

    let tx_settle = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x55), 0),
                sig_settle.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(1)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee4), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: ticket_price * total_tickets, // 100 KAS principal
                script_public_key: ScriptPublicKey::from_vec(0, buyer_spk_1[2..].to_vec()),
                covenant: None,
            },
            TransactionOutput {
                value: state_deposit, // 0.5 KAS deposit
                script_public_key: creator_spk.clone(),
                covenant: None,
            },
            TransactionOutput {
                value: ordinary_fee_val - settle_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_settle = PopulatedTransaction::new(&tx_settle, vec![
        UtxoEntry::new(full_pool, winner_ready_spk.clone(), d0 + 2, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), d0 + 2, false, None),
    ]);
    results.push(audit_step("7. WINNER_READY -> PAID (Atomic Settlement)", &tx_settle, &pop_settle, 1, winner_ready_redeem.len(), 15568, 1, settle_fee));

    // -------------------------------------------------------------
    // 8. SEALED -> FULL_REFUND
    // -------------------------------------------------------------
    let ref_redeem_0 = build_refunding_covenant(
        round_id, ticket_price, total_tickets, final_root, creator_refund_spk.clone(), final_pc, 0, total_tickets,
    ).unwrap();
    let ref_spk_0 = pay_to_script_hash_script(&ref_redeem_0);

    let mut sig_sb_fr = ScriptBuilder::with_flags(flags);
    sig_sb_fr.add_i64(ACTION_FULL_REFUND).unwrap();
    sig_sb_fr.add_data(&sealed_redeem).unwrap();
    let sig_fr = sig_sb_fr.drain();
    let fr_fee = 1_500_000u64;

    let tx_fr = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x66), 0),
                sig_fr.clone(),
                FULL_SALE_RECOVERY_DELAY_DAA_V1,
                ComputeCommit::ComputeBudget(ComputeBudget(2)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee5), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: full_pool,
                script_public_key: ref_spk_0.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ordinary_fee_val - fr_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_fr = PopulatedTransaction::new(&tx_fr, vec![
        UtxoEntry::new(full_pool, sealed_spk.clone(), d0, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), d0, false, None),
    ]);
    results.push(audit_step("8. SEALED -> FULL_REFUND", &tx_fr, &pop_fr, 1, sealed_redeem.len(), 20601, 2, fr_fee));

    // -------------------------------------------------------------
    // 9. RECOVER_EMPTY (Zero-sale)
    // -------------------------------------------------------------
    let mut sig_sb_empty = ScriptBuilder::with_flags(flags);
    sig_sb_empty.add_i64(ACTION_RECOVER_EMPTY).unwrap();
    sig_sb_empty.add_data(&initial_open_redeem).unwrap();
    let sig_empty = sig_sb_empty.drain();
    let empty_fee = 2_500_000u64;

    let tx_empty = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                funding_outpoint,
                sig_empty.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(1)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee6), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: state_deposit,
                script_public_key: creator_spk.clone(),
                covenant: None,
            },
            TransactionOutput {
                value: ordinary_fee_val - empty_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        refund_lock_daa, SubnetworkId::default(), 0, vec![],
    );
    let pop_empty = PopulatedTransaction::new(&tx_empty, vec![
        UtxoEntry::new(state_deposit, genesis_out.script_public_key.clone(), refund_lock_daa + 1, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), refund_lock_daa + 1, false, None),
    ]);
    results.push(audit_step("9. RECOVER_EMPTY (Zero-sale)", &tx_empty, &pop_empty, 1, initial_open_redeem.len(), 19918, 1, empty_fee));

    // -------------------------------------------------------------
    // 10. BEGIN_REFUND (Partial-sale)
    // -------------------------------------------------------------
    let partial_ref_redeem_c0 = build_refunding_covenant(
        round_id, ticket_price, total_tickets, root_0, creator_refund_spk.clone(), 1, 0, count_0,
    ).unwrap();
    let partial_ref_spk_c0 = pay_to_script_hash_script(&partial_ref_redeem_c0);

    let mut sig_sb_pbr = ScriptBuilder::with_flags(flags);
    sig_sb_pbr.add_i64(ACTION_BEGIN_REFUND).unwrap();
    sig_sb_pbr.add_data(&open_redeem_1).unwrap();
    let sig_pbr = sig_sb_pbr.drain();
    let pbr_fee = 2_500_000u64;

    let tx_pbr = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x77), 0),
                sig_pbr.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(3)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee7), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: pool_amt_40,
                script_public_key: partial_ref_spk_c0.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ordinary_fee_val - pbr_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        refund_lock_daa, SubnetworkId::default(), 0, vec![],
    );
    let pop_pbr = PopulatedTransaction::new(&tx_pbr, vec![
        UtxoEntry::new(pool_amt_40, open_spk_1.clone(), refund_lock_daa + 1, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), refund_lock_daa + 1, false, None),
    ]);
    results.push(audit_step("10. BEGIN_REFUND (Partial-sale)", &tx_pbr, &pop_pbr, 1, open_redeem_1.len(), 30302, 3, pbr_fee));

    // -------------------------------------------------------------
    // 11. REFUNDING normal (Step 1)
    // -------------------------------------------------------------
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
    let r1_fee = 1_000_000u64;

    let pool_rem_60 = full_pool - ticket_price * count_0;

    let tx_r1 = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x88), 0),
                sig_r1.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(2)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee8), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
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
            TransactionOutput {
                value: ordinary_fee_val - r1_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_r1 = PopulatedTransaction::new(&tx_r1, vec![
        UtxoEntry::new(full_pool, ref_spk_0.clone(), d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1, false, None),
    ]);
    results.push(audit_step("11. REFUNDING normal (Step 1)", &tx_r1, &pop_r1, 1, ref_redeem_0.len(), 24206, 2, r1_fee));

    // -------------------------------------------------------------
    // 12. REFUNDING final (Step 2)
    // -------------------------------------------------------------
    let mut sig_sb_r2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_r2.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_r2.add_data(&buyer_spk_1).unwrap();
    sig_sb_r2.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&40u64.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&1u64.to_le_bytes()).unwrap();
    sig_sb_r2.add_data(&ref_redeem_c1).unwrap();
    let sig_r2 = sig_sb_r2.drain();
    let r2_fee = 1_000_000u64;

    let tx_r2 = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0x99), 0),
                sig_r2.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(1)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee9), 0),
                p2pk_sig_66.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![
            TransactionOutput {
                value: state_deposit,
                script_public_key: creator_spk.clone(),
                covenant: None,
            },
            TransactionOutput {
                value: ticket_price * count_1,
                script_public_key: ScriptPublicKey::from_vec(0, buyer_spk_1[2..].to_vec()),
                covenant: None,
            },
            TransactionOutput {
                value: ordinary_fee_val - r2_fee,
                script_public_key: ordinary_fee_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_r2 = PopulatedTransaction::new(&tx_r2, vec![
        UtxoEntry::new(pool_rem_60, ref_spk_c1.clone(), d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1 + 1, false, Some(covenant_id_c)),
        UtxoEntry::new(ordinary_fee_val, ordinary_fee_spk.clone(), d0 + FULL_SALE_RECOVERY_DELAY_DAA_V1 + 1, false, None),
    ]);
    results.push(audit_step("12. REFUNDING final (Step 2)", &tx_r2, &pop_r2, 1, ref_redeem_c1.len(), 15817, 1, r2_fee));

    println!("==========================================================================================================================");
    println!("KASWIN V1 POST-TOCCATA FULL RELAYABLE TRANSACTION PHYSICAL RESOURCE AUDIT (12 PATHS)");
    println!("==========================================================================================================================");

    for r in &results {
        println!("=== {} ===", r.name);
        println!("  kaswin_inputs:               {}", r.kaswin_inputs);
        println!("  ordinary_inputs:             {}", r.ordinary_inputs);
        println!("  outputs:                     {}", r.outputs);
        println!("  signature_script_bytes_total:{} bytes", r.signature_script_bytes_total);
        println!("  redeem_script_bytes:         {} bytes", r.redeem_script_bytes);
        println!("  serialized_tx_bytes:         {} bytes", r.serialized_tx_bytes);
        println!("  used_script_units:           {} SU", r.used_script_units);
        println!("  B_min:                       ComputeBudget({})", r.b_min);
        println!("  compute_mass:                {} grams", r.compute_mass);
        println!("  transient_mass:              {} grams", r.transient_mass);
        println!("  normalized_transient_mass:   {} grams", r.normalized_transient_mass);
        println!("  storage_mass:                {} units", r.storage_mass);
        println!("  normalized_storage_mass:     {} grams", r.normalized_storage_mass);
        println!("  fee_mass:                    {} grams (max(compute, norm_transient))", r.fee_mass);
        println!("  default_min_relay_fee:       {} sompi ({:.6} KAS)", r.default_min_relay_fee, r.default_min_relay_fee as f64 / 1e8);
        println!("  actual_fixture_fee:          {} sompi ({:.6} KAS)", r.actual_fixture_fee, r.actual_fixture_fee as f64 / 1e8);
        println!("  fee_sufficient:              {} (actual >= min)", r.fee_sufficient);
        println!();
    }
}
