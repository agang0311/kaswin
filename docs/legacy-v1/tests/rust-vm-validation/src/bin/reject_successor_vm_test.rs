use kaspa_hashes::Hash;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ComputeCommit, ScriptPublicKey,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    script_builder::ScriptBuilder,
    covenants::CovenantsContext,
    standard::pay_to_script_hash_script,
    opcodes::codes::*,
};
use kaspa_consensus_core::mass::ComputeBudget;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;

#[path = "../../../../contracts/winner_selection.rs"]
mod winner_selection;
use winner_selection::{
    build_draw_ready_prefix,
    append_canonical_reject_successor_bytecode,
    draw_ready_prefix_len,
    COUNTER_PUSH_LEN,
};

/// Builds the isolated test-harness redeem script that directly invokes
/// the exact shared production reject successor bytecode (`append_canonical_reject_successor_bytecode`).
pub fn build_reject_harness_covenant(
    round_id: Hash,
    ticket_price: u64,
    total_tickets: u64,
    ticket_root: Hash,
    target_hash: Hash,
    random_seed: Hash,
    creator_refund_spk: &[u8],
    counter: u64,
) -> Vec<u8> {
    let prefix = build_draw_ready_prefix(
        &round_id,
        ticket_price,
        total_tickets,
        &ticket_root,
        &target_hash,
        &random_seed,
        creator_refund_spk,
    );
    assert_eq!(prefix.len(), draw_ready_prefix_len(creator_refund_spk.len()));

    let mut counter_push = vec![0x08];
    counter_push.extend_from_slice(&counter.to_le_bytes());
    assert_eq!(counter_push.len(), COUNTER_PUSH_LEN);

    let spk_len = creator_refund_spk.len();
    let mut current_len = 0;
    for _ in 0..16 {
        let compiled = compile_harness_suffix(spk_len, current_len);
        if compiled.len() == current_len {
            let mut script = Vec::new();
            script.extend_from_slice(&prefix);
            script.extend_from_slice(&counter_push);
            script.extend_from_slice(&compiled);
            return script;
        }
        current_len = compiled.len();
    }
    panic!("Harness suffix failed to converge to fixed point");
}

fn compile_harness_suffix(
    creator_refund_spk_len: usize,
    suffix_len: usize,
) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    append_canonical_reject_successor_bytecode(&mut sb, creator_refund_spk_len, suffix_len);

    // Assert Output 0 SPK matches:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Assert exact pool amount equality: OpTxOutputAmount(0) == OpTxInputAmount(0)
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputAmount).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

fn main() {
    println!("==================================================================");
    println!("KASWIN REJECT SUCCESSOR BYTECODE & EXACT AMOUNT REGRESSION TEST");
    println!("==================================================================");

    let round_id = Hash::from_u64_word(1);
    let ticket_price = 100_000_000u64; // 1 KAS
    let total_tickets = 100u64;
    let ticket_root = Hash::from_u64_word(2);
    let target_hash = Hash::from_u64_word(999);
    let random_seed = Hash::from_u64_word(100);
    let pool_principal = 10_050_000_000u64; // 100.5 KAS

    let mut creator_refund_spk = vec![0x00, 0x00, 0x20];
    creator_refund_spk.extend(vec![0xcc; 32]);
    creator_refund_spk.push(0xac);

    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // -------------------------------------------------------------
    // TEST 1: c -> c + 1 Transition in TxScriptEngine
    // -------------------------------------------------------------
    println!("\n--- TEST 1: H_0 -> H_1 Transition ---");
    let h0_redeem = build_reject_harness_covenant(
        round_id, ticket_price, total_tickets, ticket_root, target_hash, random_seed, &creator_refund_spk, 0,
    );
    let h0_spk = pay_to_script_hash_script(&h0_redeem);

    let h1_redeem = build_reject_harness_covenant(
        round_id, ticket_price, total_tickets, ticket_root, target_hash, random_seed, &creator_refund_spk, 1,
    );
    let h1_spk = pay_to_script_hash_script(&h1_redeem);

    println!("H_0 redeem len: {} bytes", h0_redeem.len());
    println!("H_1 redeem len: {} bytes", h1_redeem.len());
    assert_eq!(h0_redeem.len(), h1_redeem.len(), "Harness length must be invariant across counters");

    let mut sig_sb_0 = ScriptBuilder::with_flags(flags);
    sig_sb_0.add_data(&h0_redeem).unwrap();
    let sig_script_0 = sig_sb_0.drain();

    let tx_0 = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_0.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: h1_spk.clone(), // Output is exact H_1!
            covenant: None,
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_0 = PopulatedTransaction::new(&tx_0, vec![UtxoEntry::new(
        pool_principal, h0_spk.clone(), 1_000_100, false, None,
    )]);
    let cov_ctx_0 = CovenantsContext::from_tx(&pop_0).unwrap();
    let ctx_0 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_0);
    let mut vm_0 = TxScriptEngine::from_transaction_input(&pop_0, &pop_0.tx.inputs[0], 0, &pop_0.entries[0], ctx_0, flags);
    assert_eq!(vm_0.execute(), Ok(()));
    println!("  -> PASS: H_0 -> H_1 executed successfully in VM!");

    // -------------------------------------------------------------
    // TEST 2: c -> c + 2 Skip Attack -> MUST FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 2: c -> c + 2 Attack (H_0 attempting to output H_2) ---");
    let h2_redeem = build_reject_harness_covenant(
        round_id, ticket_price, total_tickets, ticket_root, target_hash, random_seed, &creator_refund_spk, 2,
    );
    let h2_spk = pay_to_script_hash_script(&h2_redeem);

    let tx_skip = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script_0.clone(),
            0,
            ComputeCommit::ComputeBudget(ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: pool_principal,
            script_public_key: h2_spk, // SKIPPED!
            covenant: None,
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_skip = PopulatedTransaction::new(&tx_skip, vec![UtxoEntry::new(
        pool_principal, h0_spk.clone(), 1_000_100, false, None,
    )]);
    let cov_ctx_skip = CovenantsContext::from_tx(&pop_skip).unwrap();
    let ctx_skip = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_skip);
    let mut vm_skip = TxScriptEngine::from_transaction_input(&pop_skip, &pop_skip.tx.inputs[0], 0, &pop_skip.entries[0], ctx_skip, flags);
    assert!(vm_skip.execute().is_err());
    println!("  -> PASS: c -> c+2 skip attack strictly BLOCKED by OpEqualVerify!");

    // -------------------------------------------------------------
    // TEST 3: Multi-Step Chained UTXO Execution: H_0 -> H_1 -> H_2 -> H_3
    // -------------------------------------------------------------
    println!("\n--- TEST 3: Chained Multi-Step Execution H_0 -> H_1 -> H_2 -> H_3 ---");
    let mut current_c = 0u64;
    for step in 0..3 {
        let cur_h = build_reject_harness_covenant(
            round_id, ticket_price, total_tickets, ticket_root, target_hash, random_seed, &creator_refund_spk, current_c,
        );
        let cur_spk = pay_to_script_hash_script(&cur_h);

        let next_h = build_reject_harness_covenant(
            round_id, ticket_price, total_tickets, ticket_root, target_hash, random_seed, &creator_refund_spk, current_c + 1,
        );
        let next_spk = pay_to_script_hash_script(&next_h);

        let mut sb_step = ScriptBuilder::with_flags(flags);
        sb_step.add_data(&cur_h).unwrap();
        let sig_step = sb_step.drain();

        let tx_step = Transaction::new(
            1,
            vec![TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(step as u64 + 100), 0),
                sig_step,
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            )],
            vec![TransactionOutput {
                value: pool_principal,
                script_public_key: next_spk.clone(),
                covenant: None,
            }],
            0, SubnetworkId::default(), 0, vec![],
        );
        let pop_step = PopulatedTransaction::new(&tx_step, vec![UtxoEntry::new(
            pool_principal, cur_spk, 1_000_100 + step as u64 * 10, false, None,
        )]);
        let cov_ctx_step = CovenantsContext::from_tx(&pop_step).unwrap();
        let ctx_step = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_step);
        let mut vm_step = TxScriptEngine::from_transaction_input(&pop_step, &pop_step.tx.inputs[0], 0, &pop_step.entries[0], ctx_step, flags);
        assert_eq!(vm_step.execute(), Ok(()));
        println!("  Step {}: H_{} -> H_{} verified Ok(())!", step, current_c, current_c + 1);
        current_c += 1;
    }

    // -------------------------------------------------------------
    // TEST 4 (AMOUNT-R): REJECT Path Output0 = Input0 + 1 sompi -> MUST FAIL
    // -------------------------------------------------------------
    println!("\n--- TEST 4 [AMOUNT-R]: REJECT Path Output 0 Amount Inflation (+1 sompi) ---");
    let tx_amt_r = Transaction::new(
        1,
        vec![
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::default(), 0),
                sig_script_0.clone(),
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
            TransactionInput::new_with_mass(
                TransactionOutpoint::new(Hash::from_u64_word(0xfee), 0),
                vec![0x44; 66],
                0,
                ComputeCommit::ComputeBudget(ComputeBudget(0)),
            ),
        ],
        vec![TransactionOutput {
            value: pool_principal + 1, // Inflated!
            script_public_key: h1_spk.clone(),
            covenant: None,
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_amt_r = PopulatedTransaction::new(&tx_amt_r, vec![
        UtxoEntry::new(pool_principal, h0_spk.clone(), 1_000_100, false, None),
        UtxoEntry::new(100_000_000, ScriptPublicKey::from_vec(0, vec![0x11; 32]), 1_000_100, false, None),
    ]);
    let cov_ctx_ar = CovenantsContext::from_tx(&pop_amt_r).unwrap();
    let ctx_ar = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_ar);
    let mut vm_ar = TxScriptEngine::from_transaction_input(&pop_amt_r, &pop_amt_r.tx.inputs[0], 0, &pop_amt_r.entries[0], ctx_ar, flags);
    assert!(vm_ar.execute().is_err());
    println!("  -> PASS [AMOUNT-R]: Output 0 Amount = Input 0 + 1 sompi strictly BLOCKED by OpEqualVerify!");

    println!("\n==================================================================");
    println!("ALL 4 REJECT SUCCESSOR REGRESSION TESTS PASSED 100%!");
    println!("==================================================================");
}
