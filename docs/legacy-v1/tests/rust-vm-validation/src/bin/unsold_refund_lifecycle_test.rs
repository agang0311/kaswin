use kaspa_hashes::{Hash, ZERO_HASH};
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
use kaspa_txscript_errors::TxScriptError;
use kaspa_consensus_core::mass::{ComputeBudget, Mass, ScriptUnits};
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::config::params::TESTNET_PARAMS;
use kaspa_txscript::opcodes::codes::*;

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
    is_canonical_payout_spk,
    TREE_DEPTH,
};

#[path = "../../../../contracts/open_covenant.rs"]
pub mod open_covenant;
use open_covenant::{
    build_initial_open_covenant, build_open_covenant,
    ACTION_BUY, ACTION_BEGIN_REFUND, ACTION_RECOVER_EMPTY,
};

#[path = "../../../../contracts/genesis.rs"]
pub mod genesis;
use genesis::{build_canonical_kaswin_genesis_output, validate_canonical_kaswin_create};

#[path = "../../../../contracts/refunding_covenant.rs"]
pub mod refunding_covenant;
use refunding_covenant::build_refunding_covenant;

// Reference helper to check transaction finality under consensus rules (matching check_tx_is_finalized in rusty-kaspa)
// byte/logic-parity reference against pinned rusty-kaspa header-context predicate
fn reference_check_tx_finalized_in_daa_context(tx: &Transaction, block_daa_score: u64) -> Result<(), &'static str> {
    if tx.lock_time < block_daa_score {
        return Ok(());
    }
    for input in tx.inputs.iter() {
        if input.sequence != u64::MAX {
            return Err("Transaction not finalized in header context: lock_time not reached and inputs not max sequence");
        }
    }
    Ok(())
}

fn main() {
    println!("================================================================");
    println!("KASWIN UNSOLD REFUND LIFECYCLE & HEADER-CONTEXT VM MATRIX");
    println!("================================================================");

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    let ticket_price = 10_000_000u64; // 0.1 KAS
    let total_tickets = 100u64;
    let delta_daa = 100u64;
    let initial_reserve = 50_000_000u64; // 0.5 KAS
    let refund_lock_daa = 1_500_000u64; // DAA deadline for refund eligibility

    // Genesis funding outpoint:
    let funding_outpoint = TransactionOutpoint::new(Hash::from_u64_word(112233), 0);
    let canonical_round_id = compute_canonical_round_id(&funding_outpoint);

    // Creator reserve payout SPK (Class A PubKey 36B):
    let mut reserve_payout_spk = vec![0x00, 0x00, OpData32 as u8];
    reserve_payout_spk.extend(vec![0x77; 32]);
    reserve_payout_spk.push(OpCheckSig as u8);
    assert!(is_canonical_payout_spk(&reserve_payout_spk));

    let empty_levels = compute_empty_levels();
    let empty_leaf = compute_empty_leaf();

    // Canonical Genesis Output & Covenant ID:
    let (genesis_output_0, covenant_id_c) = build_canonical_kaswin_genesis_output(
        funding_outpoint,
        ticket_price,
        total_tickets,
        delta_daa,
        refund_lock_daa,
        reserve_payout_spk.clone(),
        initial_reserve,
    ).expect("valid canonical genesis creation");

    let default_reserve_spk = reserve_payout_spk.clone();
    let default_refund_lock_daa = refund_lock_daa;

    let initial_open_redeem = build_initial_open_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        delta_daa,
        refund_lock_daa,
        reserve_payout_spk.clone(),
    ).unwrap();
    let initial_open_spk = pay_to_script_hash_script(&initial_open_redeem);

    // Buyer 1 (Class A PubKey 36B):
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
        refund_lock_daa,
        reserve_payout_spk.clone(),
    ).unwrap();
    let next_open_spk_1 = pay_to_script_hash_script(&next_open_redeem_1);

    // -------------------------------------------------------------
    // A. BUY before deadline
    // -------------------------------------------------------------
    println!("[Test A] BUY before deadline (block DAA < refund_lock_daa)");
    let mut sig_sb_a = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_a.add_data(&siblings_1[i].as_bytes()).unwrap(); }
    sig_sb_a.add_data(&buyer_spk_1).unwrap();
    sig_sb_a.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_a.add_i64(ACTION_BUY).unwrap(); // action = 1
    sig_sb_a.add_data(&initial_open_redeem).unwrap();
    let sig_script_a = sig_sb_a.drain();

    let tx_a = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(1), 0),
            sig_script_a.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve + ticket_price * count_1,
            script_public_key: next_open_spk_1.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        0, // lock_time = 0
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_a = PopulatedTransaction::new(&tx_a, vec![UtxoEntry::new(
        initial_reserve,
        initial_open_spk.clone(),
        1_000_000, // DAA before deadline
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_a = CovenantsContext::from_tx(&pop_a).unwrap();
    let ctx_a = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_a);
    let mut log_a = Vec::new();
    let mut vm_a = TxScriptEngine::from_transaction_input(&pop_a, &pop_a.tx.inputs[0], 0, &pop_a.entries[0], ctx_a, flags)
        .with_opcode_execution_log_buffer(&mut log_a);
    let res_a = vm_a.execute();
    let u_buy = vm_a.used_script_units();
    let b_min_buy = ComputeBudget::checked_covering_script_units(u_buy).unwrap();
    if res_a != Ok(()) {
        let log_str = String::from_utf8_lossy(&log_a);
        let lines: Vec<&str> = log_str.lines().collect();
        println!("Test A failed! Total lines: {}", lines.len());
        let start = if lines.len() > 35 { lines.len() - 35 } else { 0 };
        for l in &lines[start..] {
            println!("{}", l);
        }
    }
    assert_eq!(res_a, Ok(()));
    println!("  -> PASS: BUY before deadline confirmed in VM! [Units: {:?}, B_min: {:?}]", u_buy, b_min_buy);

    // Strict B_min bounded script units execution proof:
    {
        let mut tx_a_bmin = tx_a.clone();
        tx_a_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_buy);
        let pop_a_bmin = PopulatedTransaction::new(&tx_a_bmin, vec![UtxoEntry::new(
            initial_reserve,
            initial_open_spk.clone(),
            1_000_000,
            false,
            Some(covenant_id_c),
        )]);
        let cov_ctx = CovenantsContext::from_tx(&pop_a_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_a_bmin,
            &pop_a_bmin.tx.inputs[0],
            0,
            &pop_a_bmin.entries[0],
            ctx,
            flags,
            tx_a_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()), "OPEN BUY must PASS with exact B_min");

        if b_min_buy.0 > 0 {
            let mut tx_a_tight = tx_a.clone();
            tx_a_tight.inputs[0].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(b_min_buy.0 - 1));
            let pop_a_tight = PopulatedTransaction::new(&tx_a_tight, vec![UtxoEntry::new(
                initial_reserve,
                initial_open_spk.clone(),
                1_000_000,
                false,
                Some(covenant_id_c),
            )]);
            let cov_ctx_tight = CovenantsContext::from_tx(&pop_a_tight).unwrap();
            let ctx_tight = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_tight);
            let mut vm_tight = TxScriptEngine::from_transaction_input_with_script_units_limit(
                &pop_a_tight,
                &pop_a_tight.tx.inputs[0],
                0,
                &pop_a_tight.entries[0],
                ctx_tight,
                flags,
                tx_a_tight.inputs[0].compute_commit.allowed_script_units(),
            );
            assert!(matches!(vm_tight.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })), "OPEN BUY must FAIL with B_min - 1");
        }
    }

    // -------------------------------------------------------------
    // B. BUY after deadline (proves race semantics: buying remains active)
    // -------------------------------------------------------------
    println!("\n[Test B] BUY after deadline (block DAA > refund_lock_daa, proves non-strict sales window)");
    let pop_b = PopulatedTransaction::new(&tx_a, vec![UtxoEntry::new(
        initial_reserve,
        initial_open_spk.clone(),
        2_000_000, // DAA after deadline (2M > 1.5M)
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_b = CovenantsContext::from_tx(&pop_b).unwrap();
    let ctx_b = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_b);
    let mut vm_b = TxScriptEngine::from_transaction_input(&pop_b, &pop_b.tx.inputs[0], 0, &pop_b.entries[0], ctx_b, flags);
    assert_eq!(vm_b.execute(), Ok(()));
    println!("  -> PASS: BUY after deadline confirmed in VM! Buying can compete with refund.");

    // -------------------------------------------------------------
    // C. BEGIN_REFUND before deadline (Header-Context & CLTV Rejection)
    // -------------------------------------------------------------
    println!("\n[Test C] BEGIN_REFUND before deadline (block DAA <= refund_lock_daa)");
    // Suppose state is OPEN(5, 1) with 1 purchase:
    let mut sig_sb_ref = ScriptBuilder::with_flags(flags);
    sig_sb_ref.add_i64(ACTION_BEGIN_REFUND).unwrap(); // action = 2
    sig_sb_ref.add_data(&next_open_redeem_1).unwrap();
    let sig_script_ref = sig_sb_ref.drain();

    let initial_refunding_redeem = build_refunding_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        root_1,
        reserve_payout_spk.clone(),
        1, // purchase_count = 1
        0, // cursor = 0
        5, // remaining_tickets = 5
    ).unwrap();
    let initial_refunding_spk = pay_to_script_hash_script(&initial_refunding_redeem);

    // If attacker attempts tx with lock_time = refund_lock_daa before block DAA reaches deadline:
    let tx_ref_early = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(2), 0),
            sig_script_ref.clone(),
            0, // input sequence != u64::MAX
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve + ticket_price * count_1,
            script_public_key: initial_refunding_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        refund_lock_daa, // 1_500_000
        SubnetworkId::default(),
        0,
        vec![],
    );

    // 1. Consensus Header Context Check: block DAA = 1_400_000 <= 1_500_000
    let res_header_c = reference_check_tx_finalized_in_daa_context(&tx_ref_early, 1_400_000);
    assert!(res_header_c.is_err());
    println!("  -> PASS: Consensus Header-Context rejected early refund transaction: {:?}", res_header_c);

    // Explicit DAA boundary checks against pinned consensus finality:
    assert_eq!(
        reference_check_tx_finalized_in_daa_context(&tx_ref_early, refund_lock_daa),
        Err("Transaction not finalized in header context: lock_time not reached and inputs not max sequence"),
        "block DAA == refund_lock_daa MUST fail header-context finality!"
    );
    assert_eq!(
        reference_check_tx_finalized_in_daa_context(&tx_ref_early, refund_lock_daa + 1),
        Ok(()),
        "block DAA == refund_lock_daa + 1 MUST pass header-context finality!"
    );
    println!("  -> PASS: Boundary verified: DAA == refund_lock_daa (FAIL) & DAA == refund_lock_daa + 1 (PASS)");

    // 2. TxScriptEngine CLTV Check if tx.lock_time was tampered lower than refund_lock_daa:
    let mut tx_ref_cltv_tamper = tx_ref_early.clone();
    tx_ref_cltv_tamper.lock_time = refund_lock_daa - 100; // lower lock_time
    let pop_c = PopulatedTransaction::new(&tx_ref_cltv_tamper, vec![UtxoEntry::new(
        initial_reserve + ticket_price * count_1,
        next_open_spk_1.clone(),
        1_400_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_c = CovenantsContext::from_tx(&pop_c).unwrap();
    let ctx_c = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_c);
    let mut vm_c = TxScriptEngine::from_transaction_input(&pop_c, &pop_c.tx.inputs[0], 0, &pop_c.entries[0], ctx_c, flags);
    assert!(vm_c.execute().is_err());
    println!("  -> PASS: OpCheckLockTimeVerify BLOCKED refund attempt before deadline!");

    // -------------------------------------------------------------
    // D. BEGIN_REFUND after deadline
    // -------------------------------------------------------------
    println!("\n[Test D] BEGIN_REFUND after deadline (block DAA = 1_600_000 > 1_500_000)");
    // 1. Consensus Header Context Check:
    let res_header_d = reference_check_tx_finalized_in_daa_context(&tx_ref_early, 1_600_000);
    assert_eq!(res_header_d, Ok(()));
    println!("  -> Consensus Header-Context: Finalized & Eligible");

    // 2. TxScriptEngine Execution:
    let pop_d = PopulatedTransaction::new(&tx_ref_early, vec![UtxoEntry::new(
        initial_reserve + ticket_price * count_1,
        next_open_spk_1.clone(),
        1_600_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_d = CovenantsContext::from_tx(&pop_d).unwrap();
    let ctx_d = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_d);
    let mut vm_d = TxScriptEngine::from_transaction_input(&pop_d, &pop_d.tx.inputs[0], 0, &pop_d.entries[0], ctx_d, flags);
    assert_eq!(vm_d.execute(), Ok(()));
    let u_begin_ref = vm_d.used_script_units();
    let b_min_begin_ref = ComputeBudget::checked_covering_script_units(u_begin_ref).unwrap();
    println!("  -> PASS: BEGIN_REFUND confirmed in VM! OPEN(5,1) -> REFUNDING(cursor=0, rem=5) [Units: {:?}, B_min: {:?}]", u_begin_ref, b_min_begin_ref);

    // Strict B_min bounded script units execution proof:
    {
        let mut tx_d_bmin = tx_ref_early.clone();
        tx_d_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_begin_ref);
        let pop_d_bmin = PopulatedTransaction::new(&tx_d_bmin, vec![UtxoEntry::new(
            initial_reserve + ticket_price * count_1,
            next_open_spk_1.clone(),
            1_600_000,
            false,
            Some(covenant_id_c),
        )]);
        let cov_ctx = CovenantsContext::from_tx(&pop_d_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_d_bmin,
            &pop_d_bmin.tx.inputs[0],
            0,
            &pop_d_bmin.entries[0],
            ctx,
            flags,
            tx_d_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()), "BEGIN_REFUND must PASS with exact B_min");

        if b_min_begin_ref.0 > 0 {
            let mut tx_d_tight = tx_ref_early.clone();
            tx_d_tight.inputs[0].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(b_min_begin_ref.0 - 1));
            let pop_d_tight = PopulatedTransaction::new(&tx_d_tight, vec![UtxoEntry::new(
                initial_reserve + ticket_price * count_1,
                next_open_spk_1.clone(),
                1_600_000,
                false,
                Some(covenant_id_c),
            )]);
            let cov_ctx_tight = CovenantsContext::from_tx(&pop_d_tight).unwrap();
            let ctx_tight = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_tight);
            let mut vm_tight = TxScriptEngine::from_transaction_input_with_script_units_limit(
                &pop_d_tight,
                &pop_d_tight.tx.inputs[0],
                0,
                &pop_d_tight.entries[0],
                ctx_tight,
                flags,
                tx_d_tight.inputs[0].compute_commit.allowed_script_units(),
            );
            assert!(matches!(vm_tight.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })), "BEGIN_REFUND must FAIL with B_min - 1");
        }
    }

    // -------------------------------------------------------------
    // E. BEGIN_REFUND with sold=0 (Must FAIL, cannot enter refunding when no tickets sold)
    // -------------------------------------------------------------
    println!("\n[Test E] Attack: BEGIN_REFUND with sold = 0");
    let mut sig_sb_e = ScriptBuilder::with_flags(flags);
    sig_sb_e.add_i64(ACTION_BEGIN_REFUND).unwrap();
    sig_sb_e.add_data(&initial_open_redeem).unwrap(); // sold = 0!
    let tx_e = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(3), 0),
            sig_sb_e.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve,
            script_public_key: initial_refunding_spk.clone(),
            covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
        }],
        refund_lock_daa,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_e = PopulatedTransaction::new(&tx_e, vec![UtxoEntry::new(
        initial_reserve,
        initial_open_spk.clone(),
        1_600_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_e = CovenantsContext::from_tx(&pop_e).unwrap();
    let ctx_e = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_e);
    let mut vm_e = TxScriptEngine::from_transaction_input(&pop_e, &pop_e.tx.inputs[0], 0, &pop_e.entries[0], ctx_e, flags);
    assert!(vm_e.execute().is_err());
    println!("  -> PASS: BEGIN_REFUND with sold=0 BLOCKED by sold_tickets > 0 check!");

    // -------------------------------------------------------------
    // F. recoverEmpty sold=0 after deadline
    // -------------------------------------------------------------
    println!("\n[Test F] RECOVER_EMPTY: sold=0 after deadline -> returns reserve to reserve_payout_spk");
    let mut sig_sb_f = ScriptBuilder::with_flags(flags);
    sig_sb_f.add_i64(ACTION_RECOVER_EMPTY).unwrap(); // action = 3
    sig_sb_f.add_data(&initial_open_redeem).unwrap();
    let sig_script_f = sig_sb_f.drain();

    let reserve_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, reserve_payout_spk[2..].to_vec());
    let tx_f = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(4), 0),
            sig_script_f,
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve,
            script_public_key: reserve_spk.clone(),
            covenant: None, // Lineage terminates!
        }],
        refund_lock_daa,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_f = PopulatedTransaction::new(&tx_f, vec![UtxoEntry::new(
        initial_reserve,
        initial_open_spk.clone(),
        1_600_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_f = CovenantsContext::from_tx(&pop_f).unwrap();
    let ctx_f = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_f);
    let mut vm_f = TxScriptEngine::from_transaction_input(&pop_f, &pop_f.tx.inputs[0], 0, &pop_f.entries[0], ctx_f, flags);
    assert_eq!(vm_f.execute(), Ok(()));
    let u_rec_empty = vm_f.used_script_units();
    let b_min_rec_empty = ComputeBudget::checked_covering_script_units(u_rec_empty).unwrap();
    println!("  -> PASS: RECOVER_EMPTY confirmed in VM! Lineage terminated and reserve reclaimed [Units: {:?}, B_min: {:?}]", u_rec_empty, b_min_rec_empty);

    // Strict B_min bounded script units execution proof:
    {
        let mut tx_f_bmin = tx_f.clone();
        tx_f_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_rec_empty);
        let pop_f_bmin = PopulatedTransaction::new(&tx_f_bmin, vec![UtxoEntry::new(
            initial_reserve,
            initial_open_spk.clone(),
            1_600_000,
            false,
            Some(covenant_id_c),
        )]);
        let cov_ctx = CovenantsContext::from_tx(&pop_f_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_f_bmin,
            &pop_f_bmin.tx.inputs[0],
            0,
            &pop_f_bmin.entries[0],
            ctx,
            flags,
            tx_f_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()), "RECOVER_EMPTY must PASS with exact B_min");

        if b_min_rec_empty.0 > 0 {
            let mut tx_f_tight = tx_f.clone();
            tx_f_tight.inputs[0].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(b_min_rec_empty.0 - 1));
            let pop_f_tight = PopulatedTransaction::new(&tx_f_tight, vec![UtxoEntry::new(
                initial_reserve,
                initial_open_spk.clone(),
                1_600_000,
                false,
                Some(covenant_id_c),
            )]);
            let cov_ctx_tight = CovenantsContext::from_tx(&pop_f_tight).unwrap();
            let ctx_tight = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_tight);
            let mut vm_tight = TxScriptEngine::from_transaction_input_with_script_units_limit(
                &pop_f_tight,
                &pop_f_tight.tx.inputs[0],
                0,
                &pop_f_tight.entries[0],
                ctx_tight,
                flags,
                tx_f_tight.inputs[0].compute_commit.allowed_script_units(),
            );
            assert!(matches!(vm_tight.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })), "RECOVER_EMPTY must FAIL with B_min - 1");
        }
    }

    // -------------------------------------------------------------
    // G. recoverEmpty sold > 0 (Must FAIL, cannot skim ticket funds)
    // -------------------------------------------------------------
    println!("\n[Test G] Attack: RECOVER_EMPTY when tickets were sold (sold = 5 > 0)");
    let mut sig_sb_g = ScriptBuilder::with_flags(flags);
    sig_sb_g.add_i64(ACTION_RECOVER_EMPTY).unwrap();
    sig_sb_g.add_data(&next_open_redeem_1).unwrap(); // sold = 5!
    let tx_g = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(5), 0),
            sig_sb_g.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: initial_reserve + ticket_price * count_1,
            script_public_key: reserve_spk.clone(),
            covenant: None,
        }],
        refund_lock_daa,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_g = PopulatedTransaction::new(&tx_g, vec![UtxoEntry::new(
        initial_reserve + ticket_price * count_1,
        next_open_spk_1.clone(),
        1_600_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_g = CovenantsContext::from_tx(&pop_g).unwrap();
    let ctx_g = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_g);
    let mut vm_g = TxScriptEngine::from_transaction_input(&pop_g, &pop_g.tx.inputs[0], 0, &pop_g.entries[0], ctx_g, flags);
    assert!(vm_g.execute().is_err());
    println!("  -> PASS: RECOVER_EMPTY with sold > 0 BLOCKED by sold_tickets == 0 check!");

    // -------------------------------------------------------------
    // H. Sequential Refund: cursor 0 -> cursor 1 -> terminal refund
    // -------------------------------------------------------------
    println!("\n[Test H] Sequential Refund across 2 purchases: cursor 0 -> cursor 1 -> terminal");

    // Buyer 2: Class B PubKeyECDSA (10 tickets, [5, 15))
    let mut buyer_spk_2 = vec![0x00, 0x00, OpData33 as u8];
    buyer_spk_2.extend(vec![0x22; 33]);
    buyer_spk_2.push(OpCheckSigECDSA as u8);
    let count_2 = 10u64;

    let mut siblings_2 = [Hash::default(); TREE_DEPTH];
    siblings_2[0] = leaf_1;
    for i in 1..TREE_DEPTH { siblings_2[i] = empty_levels[i]; }

    let payout_comm_2 = compute_payout_commitment(&buyer_spk_2);
    let leaf_2 = compute_purchase_leaf(&canonical_round_id, 1, 5, count_2, &payout_comm_2);
    let root_2 = compute_root_from_path(&leaf_2, 1, &siblings_2);

    // Let's re-derive siblings_1 in tree with root_2:
    let mut siblings_1_in_tree2 = [Hash::default(); TREE_DEPTH];
    siblings_1_in_tree2[0] = leaf_2;
    for i in 1..TREE_DEPTH { siblings_1_in_tree2[i] = empty_levels[i]; }
    assert_eq!(compute_root_from_path(&leaf_1, 0, &siblings_1_in_tree2), root_2);

    // Initial REFUNDING state for 2 purchases (total 15 tickets):
    // cursor = 0, rem = 15
    let refunding_redeem_c0 = build_refunding_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        root_2,
        reserve_payout_spk.clone(),
        2,  // purchase_count = 2
        0,  // cursor = 0
        15, // remaining_tickets = 15
    ).unwrap();
    let refunding_spk_c0 = pay_to_script_hash_script(&refunding_redeem_c0);

    // STEP H1: Refund Purchase 0 (cursor 0 -> cursor 1, rem 15 -> 10)
    let refunding_redeem_c1 = build_refunding_covenant(
        canonical_round_id,
        ticket_price,
        total_tickets,
        root_2,
        reserve_payout_spk.clone(),
        2,
        1,  // cursor' = 1
        10, // rem' = 10
    ).unwrap();
    let refunding_spk_c1 = pay_to_script_hash_script(&refunding_redeem_c1);

    let mut sig_sb_h1 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_h1.add_data(&siblings_1_in_tree2[i].as_bytes()).unwrap(); }
    sig_sb_h1.add_data(&buyer_spk_1).unwrap();
    sig_sb_h1.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_h1.add_data(&0u64.to_le_bytes()).unwrap(); // start_ticket = 0
    sig_sb_h1.add_data(&0u64.to_le_bytes()).unwrap(); // purchase_index = 0
    sig_sb_h1.add_data(&refunding_redeem_c0).unwrap();
    let sig_script_h1 = sig_sb_h1.drain();

    let buyer1_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_1[2..].to_vec());
    let pool_amt_15 = initial_reserve + ticket_price * 15;

    let tx_h1 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(10), 0),
            sig_script_h1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            // Output 0: next REFUNDING(cursor=1, rem=10)
            TransactionOutput {
                value: pool_amt_15 - ticket_price * count_1,
                script_public_key: refunding_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            // Output 1: buyer 1 refund
            TransactionOutput {
                value: ticket_price * count_1,
                script_public_key: buyer1_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_h1 = PopulatedTransaction::new(&tx_h1, vec![UtxoEntry::new(
        pool_amt_15,
        refunding_spk_c0.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_h1 = CovenantsContext::from_tx(&pop_h1).unwrap();
    let ctx_h1 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_h1);
    let mut vm_h1 = TxScriptEngine::from_transaction_input(&pop_h1, &pop_h1.tx.inputs[0], 0, &pop_h1.entries[0], ctx_h1, flags);
    assert_eq!(vm_h1.execute(), Ok(()));
    let u_ref_step = vm_h1.used_script_units();
    let b_min_ref_step = ComputeBudget::checked_covering_script_units(u_ref_step).unwrap();
    println!("  -> PASS: Step H1 (Refund Purchase 0) succeeded! [Units: {:?}, B_min: {:?}]", u_ref_step, b_min_ref_step);

    // Strict B_min bounded script units execution proof:
    {
        let mut tx_h1_bmin = tx_h1.clone();
        tx_h1_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_ref_step);
        let pop_h1_bmin = PopulatedTransaction::new(&tx_h1_bmin, vec![UtxoEntry::new(
            pool_amt_15,
            refunding_spk_c0.clone(),
            1_000_000,
            false,
            Some(covenant_id_c),
        )]);
        let cov_ctx = CovenantsContext::from_tx(&pop_h1_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_h1_bmin,
            &pop_h1_bmin.tx.inputs[0],
            0,
            &pop_h1_bmin.entries[0],
            ctx,
            flags,
            tx_h1_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()), "REFUNDING normal must PASS with exact B_min");

        if b_min_ref_step.0 > 0 {
            let mut tx_h1_tight = tx_h1.clone();
            tx_h1_tight.inputs[0].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(b_min_ref_step.0 - 1));
            let pop_h1_tight = PopulatedTransaction::new(&tx_h1_tight, vec![UtxoEntry::new(
                pool_amt_15,
                refunding_spk_c0.clone(),
                1_000_000,
                false,
                Some(covenant_id_c),
            )]);
            let cov_ctx_tight = CovenantsContext::from_tx(&pop_h1_tight).unwrap();
            let ctx_tight = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_tight);
            let mut vm_tight = TxScriptEngine::from_transaction_input_with_script_units_limit(
                &pop_h1_tight,
                &pop_h1_tight.tx.inputs[0],
                0,
                &pop_h1_tight.entries[0],
                ctx_tight,
                flags,
                tx_h1_tight.inputs[0].compute_commit.allowed_script_units(),
            );
            assert!(matches!(vm_tight.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })), "REFUNDING normal must FAIL with B_min - 1");
        }
    }

    // STEP H2: Final Refund Purchase 1 (cursor 1 -> terminal refund)
    let mut sig_sb_h2 = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_h2.add_data(&siblings_2[i].as_bytes()).unwrap(); }
    sig_sb_h2.add_data(&buyer_spk_2).unwrap();
    sig_sb_h2.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_h2.add_data(&5u64.to_le_bytes()).unwrap(); // start_ticket = 5
    sig_sb_h2.add_data(&1u64.to_le_bytes()).unwrap(); // purchase_index = 1
    sig_sb_h2.add_data(&refunding_redeem_c1).unwrap();
    let sig_script_h2 = sig_sb_h2.drain();

    let buyer2_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, buyer_spk_2[2..].to_vec());
    let pool_amt_10 = initial_reserve + ticket_price * 10;

    let tx_h2 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_h1.id(), 0), // Consumes Output 0 of Step H1!
            sig_script_h2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            // Output 0: reserve returned to creator!
            TransactionOutput {
                value: initial_reserve,
                script_public_key: reserve_spk.clone(),
                covenant: None, // Lineage terminates!
            },
            // Output 1: buyer 2 refund
            TransactionOutput {
                value: ticket_price * count_2,
                script_public_key: buyer2_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_h2 = PopulatedTransaction::new(&tx_h2, vec![UtxoEntry::new(
        pool_amt_10,
        refunding_spk_c1.clone(),
        1_000_001,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_h2 = CovenantsContext::from_tx(&pop_h2).unwrap();
    let ctx_h2 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_h2);
    let mut vm_h2 = TxScriptEngine::from_transaction_input(&pop_h2, &pop_h2.tx.inputs[0], 0, &pop_h2.entries[0], ctx_h2, flags);
    assert_eq!(vm_h2.execute(), Ok(()));
    let u_ref_final = vm_h2.used_script_units();
    let b_min_ref_final = ComputeBudget::checked_covering_script_units(u_ref_final).unwrap();
    println!("  -> PASS: Step H2 (Final Refund Purchase 1) succeeded! Lineage terminated and reserve reclaimed! [Units: {:?}, B_min: {:?}]", u_ref_final, b_min_ref_final);

    // Strict B_min bounded script units execution proof:
    {
        let mut tx_h2_bmin = tx_h2.clone();
        tx_h2_bmin.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b_min_ref_final);
        let pop_h2_bmin = PopulatedTransaction::new(&tx_h2_bmin, vec![UtxoEntry::new(
            pool_amt_10,
            refunding_spk_c1.clone(),
            1_000_001,
            false,
            Some(covenant_id_c),
        )]);
        let cov_ctx = CovenantsContext::from_tx(&pop_h2_bmin).unwrap();
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &pop_h2_bmin,
            &pop_h2_bmin.tx.inputs[0],
            0,
            &pop_h2_bmin.entries[0],
            ctx,
            flags,
            tx_h2_bmin.inputs[0].compute_commit.allowed_script_units(),
        );
        assert_eq!(vm.execute(), Ok(()), "REFUNDING final must PASS with exact B_min");

        if b_min_ref_final.0 > 0 {
            let mut tx_h2_tight = tx_h2.clone();
            tx_h2_tight.inputs[0].compute_commit = ComputeCommit::ComputeBudget(ComputeBudget(b_min_ref_final.0 - 1));
            let pop_h2_tight = PopulatedTransaction::new(&tx_h2_tight, vec![UtxoEntry::new(
                pool_amt_10,
                refunding_spk_c1.clone(),
                1_000_001,
                false,
                Some(covenant_id_c),
            )]);
            let cov_ctx_tight = CovenantsContext::from_tx(&pop_h2_tight).unwrap();
            let ctx_tight = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_tight);
            let mut vm_tight = TxScriptEngine::from_transaction_input_with_script_units_limit(
                &pop_h2_tight,
                &pop_h2_tight.tx.inputs[0],
                0,
                &pop_h2_tight.entries[0],
                ctx_tight,
                flags,
                tx_h2_tight.inputs[0].compute_commit.allowed_script_units(),
            );
            assert!(matches!(vm_tight.execute(), Err(TxScriptError::ExceededCommittedScriptUnits { .. })), "REFUNDING final must FAIL with B_min - 1");
        }
    }

    // -------------------------------------------------------------
    // I. Try refund purchase_index != cursor (Must FAIL)
    // -------------------------------------------------------------
    println!("\n[Test I] Attack: Attempting to refund purchase_index = 1 when cursor = 0");
    let mut sig_sb_i = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_i.add_data(&siblings_2[i].as_bytes()).unwrap(); }
    sig_sb_i.add_data(&buyer_spk_2).unwrap();
    sig_sb_i.add_data(&count_2.to_le_bytes()).unwrap();
    sig_sb_i.add_data(&5u64.to_le_bytes()).unwrap();
    sig_sb_i.add_data(&1u64.to_le_bytes()).unwrap(); // purchase_index = 1 != cursor (0)
    sig_sb_i.add_data(&refunding_redeem_c0).unwrap(); // cursor = 0!

    let tx_i = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(11), 0),
            sig_sb_i.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: pool_amt_15 - ticket_price * count_2,
                script_public_key: refunding_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ticket_price * count_2,
                script_public_key: buyer2_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_i = PopulatedTransaction::new(&tx_i, vec![UtxoEntry::new(
        pool_amt_15,
        refunding_spk_c0.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_i = CovenantsContext::from_tx(&pop_i).unwrap();
    let ctx_i = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_i);
    let mut vm_i = TxScriptEngine::from_transaction_input(&pop_i, &pop_i.tx.inputs[0], 0, &pop_i.entries[0], ctx_i, flags);
    assert!(vm_i.execute().is_err());
    println!("  -> PASS: Out-of-sequence refund attempt BLOCKED by purchase_index == refund_cursor check!");

    // -------------------------------------------------------------
    // J. Wrong Merkle proof (Must FAIL)
    // -------------------------------------------------------------
    println!("\n[Test J] Attack: Tampered sibling in refund Merkle proof");
    let mut bad_sibs = siblings_1_in_tree2;
    bad_sibs[4] = Hash::from_u64_word(0xbad);
    let mut sig_sb_j = ScriptBuilder::with_flags(flags);
    for i in (0..TREE_DEPTH).rev() { sig_sb_j.add_data(&bad_sibs[i].as_bytes()).unwrap(); }
    sig_sb_j.add_data(&buyer_spk_1).unwrap();
    sig_sb_j.add_data(&count_1.to_le_bytes()).unwrap();
    sig_sb_j.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_j.add_data(&0u64.to_le_bytes()).unwrap();
    sig_sb_j.add_data(&refunding_redeem_c0).unwrap();

    let tx_j = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(12), 0),
            sig_sb_j.drain(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: pool_amt_15 - ticket_price * count_1,
                script_public_key: refunding_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ticket_price * count_1,
                script_public_key: buyer1_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_j = PopulatedTransaction::new(&tx_j, vec![UtxoEntry::new(
        pool_amt_15,
        refunding_spk_c0.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_j = CovenantsContext::from_tx(&pop_j).unwrap();
    let ctx_j = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_j);
    let mut vm_j = TxScriptEngine::from_transaction_input(&pop_j, &pop_j.tx.inputs[0], 0, &pop_j.entries[0], ctx_j, flags);
    assert!(vm_j.execute().is_err());
    println!("  -> PASS: Tampered sibling in refund BLOCKED by ticket_root assertion!");

    // -------------------------------------------------------------
    // K. Wrong buyer refund amount by 1 sompi (Must FAIL)
    // -------------------------------------------------------------
    println!("\n[Test K] Attack: Buyer refund underpaid by 1 sompi");
    let tx_k = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(13), 0),
            sig_script_h1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: pool_amt_15 - ticket_price * count_1 + 1,
                script_public_key: refunding_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ticket_price * count_1 - 1, // 1 sompi short!
                script_public_key: buyer1_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_k = PopulatedTransaction::new(&tx_k, vec![UtxoEntry::new(
        pool_amt_15,
        refunding_spk_c0.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_k = CovenantsContext::from_tx(&pop_k).unwrap();
    let ctx_k = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_k);
    let mut vm_k = TxScriptEngine::from_transaction_input(&pop_k, &pop_k.tx.inputs[0], 0, &pop_k.entries[0], ctx_k, flags);
    assert!(vm_k.execute().is_err());
    println!("  -> PASS: Buyer refund amount deviation BLOCKED by exact Output 1 Amount check!");

    // -------------------------------------------------------------
    // L. Wrong buyer refund SPK (Must FAIL)
    // -------------------------------------------------------------
    println!("\n[Test L] Attack: Buyer refund redirected to thief SPK");
    let thief_spk = kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, vec![0x51]);
    let tx_l = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(14), 0),
            sig_script_h1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: pool_amt_15 - ticket_price * count_1,
                script_public_key: refunding_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ticket_price * count_1,
                script_public_key: thief_spk.clone(), // Redirected!
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_l = PopulatedTransaction::new(&tx_l, vec![UtxoEntry::new(
        pool_amt_15,
        refunding_spk_c0.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_l = CovenantsContext::from_tx(&pop_l).unwrap();
    let ctx_l = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_l);
    let mut vm_l = TxScriptEngine::from_transaction_input(&pop_l, &pop_l.tx.inputs[0], 0, &pop_l.entries[0], ctx_l, flags);
    assert!(vm_l.execute().is_err());
    println!("  -> PASS: Buyer refund SPK redirection BLOCKED by Output 1 SPK == payout_spk check!");

    // -------------------------------------------------------------
    // M. Normal refund tries two C continuation outputs (Must FAIL)
    // -------------------------------------------------------------
    println!("\n[Test M] Attack: Normal refund creates 2 covenant continuation outputs (split attack)");
    let tx_m = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(15), 0),
            sig_script_h1.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: pool_amt_15 - ticket_price * count_1 - 1000,
                script_public_key: refunding_spk_c1.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }),
            },
            TransactionOutput {
                value: ticket_price * count_1,
                script_public_key: buyer1_spk.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }), // Second C output!
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_m = PopulatedTransaction::new(&tx_m, vec![UtxoEntry::new(
        pool_amt_15,
        refunding_spk_c0.clone(),
        1_000_000,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_m = CovenantsContext::from_tx(&pop_m).unwrap();
    let ctx_m = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_m);
    let mut vm_m = TxScriptEngine::from_transaction_input(&pop_m, &pop_m.tx.inputs[0], 0, &pop_m.entries[0], ctx_m, flags);
    assert!(vm_m.execute().is_err());
    println!("  -> PASS: Split covenant attempt in normal refund BLOCKED by Output 1 covenant == None & OpAuthOutputCount!");

    // -------------------------------------------------------------
    // N. Final refund attempts to retain C (Must FAIL)
    // -------------------------------------------------------------
    println!("\n[Test N] Attack: Final refund attempts to retain covenant C on Output 0");
    let tx_n = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_h1.id(), 0),
            sig_script_h2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: initial_reserve,
                script_public_key: reserve_spk.clone(),
                covenant: Some(CovenantBinding { covenant_id: covenant_id_c, authorizing_input: 0 }), // tries to keep C!
            },
            TransactionOutput {
                value: ticket_price * count_2,
                script_public_key: buyer2_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_n = PopulatedTransaction::new(&tx_n, vec![UtxoEntry::new(
        pool_amt_10,
        refunding_spk_c1.clone(),
        1_000_001,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_n = CovenantsContext::from_tx(&pop_n).unwrap();
    let ctx_n = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_n);
    let mut vm_n = TxScriptEngine::from_transaction_input(&pop_n, &pop_n.tx.inputs[0], 0, &pop_n.entries[0], ctx_n, flags);
    assert!(vm_n.execute().is_err());
    println!("  -> PASS: Final refund retaining covenant C BLOCKED by terminal lineage termination guard!");

    // -------------------------------------------------------------
    // O. Final reserve SPK altered (Must FAIL)
    // -------------------------------------------------------------
    println!("\n[Test O] Attack: Final refund redirects reserve to altered thief SPK");
    let tx_o = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(tx_h1.id(), 0),
            sig_script_h2.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![
            TransactionOutput {
                value: initial_reserve,
                script_public_key: thief_spk.clone(), // Thief gets reserve!
                covenant: None,
            },
            TransactionOutput {
                value: ticket_price * count_2,
                script_public_key: buyer2_spk.clone(),
                covenant: None,
            },
        ],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_o = PopulatedTransaction::new(&tx_o, vec![UtxoEntry::new(
        pool_amt_10,
        refunding_spk_c1.clone(),
        1_000_001,
        false,
        Some(covenant_id_c),
    )]);
    let cov_ctx_o = CovenantsContext::from_tx(&pop_o).unwrap();
    let ctx_o = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_o);
    let mut vm_o = TxScriptEngine::from_transaction_input(&pop_o, &pop_o.tx.inputs[0], 0, &pop_o.entries[0], ctx_o, flags);
    assert!(vm_o.execute().is_err());
    println!("  -> PASS: Altered reserve SPK in final refund BLOCKED by Output 0 SPK == reserve_payout_spk check!");

    println!("\n===============================================================");
    println!("ALL 15 TESTS A THROUGH O PASSED 100% IN FULL LIFECYCLE CONTEXT!");
    println!("===============================================================");
}
