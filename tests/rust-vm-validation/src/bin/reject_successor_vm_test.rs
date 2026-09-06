use kaspa_hashes::Hash;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    UtxoEntry, PopulatedTransaction, ComputeCommit,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    script_builder::ScriptBuilder,
    covenants::CovenantsContext,
    standard::pay_to_script_hash_script,
    opcodes::codes::*,
};
use kaspa_consensus_core::mass::{ComputeBudget, MassCalculator};
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;

#[path = "../../../../contracts/winner_ready_settlement.rs"]
pub mod winner_ready_settlement;

#[path = "../../../../contracts/winner_selection.rs"]
mod winner_selection;
use winner_selection::{
    build_draw_ready_prefix,
    append_canonical_reject_successor_bytecode,
    DRAW_READY_PREFIX_LEN,
    COUNTER_PUSH_LEN,
};

/// Builds the isolated test-harness redeem script that directly invokes
/// the exact shared production reject successor bytecode (`append_canonical_reject_successor_bytecode`).
///
/// In this harness:
/// - PREFIX: exactly identical to production DRAW_READY prefix (144 bytes)
/// - COUNTER_PUSH: exactly identical to production DRAW_READY counter push (9 bytes: 0x08 || le_u64)
/// - Suffix: exactly re-creates the stack without embedding another counter push!
///   Notice that after the prefix and counter_push run, the stack has:
///   [round_id, ticket_root, total_tickets_bytes, target_hash, random_seed, counter_bytes]!
///   WHICH IS THE EXACT OPELSE ENTRANCE STATE!
///   So the suffix DOES NOT NEED TO DROP AND RE-PUSH ANYTHING!
///   It directly calls `append_canonical_reject_successor_bytecode(&mut sb, suffix_len)`!
pub fn build_reject_harness_covenant(
    round_id: Hash,
    ticket_root: Hash,
    total_tickets: u64,
    target_hash: Hash,
    random_seed: Hash,
    counter: u64,
) -> Vec<u8> {
    let prefix = build_draw_ready_prefix(&round_id, &ticket_root, total_tickets, &target_hash, &random_seed);
    assert_eq!(prefix.len(), DRAW_READY_PREFIX_LEN);

    let mut counter_push = vec![0x08];
    counter_push.extend_from_slice(&counter.to_le_bytes());
    assert_eq!(counter_push.len(), COUNTER_PUSH_LEN);

    // Suffix compilation with exact fixed-point convergence:
    let mut current_len = 0;
    for _ in 0..16 {
        let compiled = compile_harness_suffix(current_len);
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
    suffix_len: usize,
) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    // At entry of suffix, the stack has:
    // [round_id, ticket_root, total_tickets_bytes, target_hash, random_seed, counter_bytes]
    // which is the 100% exact stack state at the entrance of the production reject branch!
    // Directly call the shared production reject bytecode:
    append_canonical_reject_successor_bytecode(&mut sb, suffix_len);

    // Assert Output 0 SPK matches:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Assert pool principal preserved:
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxInputAmount).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    sb.add_op(OpTrue).unwrap();
    sb.drain()
}

fn main() {
    println!("=== Testing Reject Successor Bytecode in Isolated VM Harness ===");

    let round_id = Hash::from_u64_word(1);
    let ticket_root = Hash::from_u64_word(2);
    let target_hash = Hash::from_u64_word(999);
    let pool_principal = 50_000_000_000u64; // 500 KAS
    let total_tickets = 100u64;
    let random_seed = Hash::from_u64_word(100);

    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // -------------------------------------------------------------
    // TEST 1: c -> c + 1 Transition in TxScriptEngine
    // -------------------------------------------------------------
    println!("\n--- TEST 1: H_0 -> H_1 Transition ---");
    let h0_redeem = build_reject_harness_covenant(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        0,
    );
    let h0_spk = pay_to_script_hash_script(&h0_redeem);

    let h1_redeem = build_reject_harness_covenant(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        1,
    );
    let h1_spk = pay_to_script_hash_script(&h1_redeem);

    println!("H_0 redeem len: {}", h0_redeem.len());
    println!("H_1 redeem len: {}", h1_redeem.len());
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
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_0 = PopulatedTransaction::new(&tx_0, vec![UtxoEntry::new(
        pool_principal,
        h0_spk.clone(),
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_0 = CovenantsContext::from_tx(&pop_0).unwrap();
    let ctx_0 = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_0);
    let mut vm_0 = TxScriptEngine::from_transaction_input(&pop_0, &pop_0.tx.inputs[0], 0, &pop_0.entries[0], ctx_0, flags);
    let res_0 = vm_0.execute();
    println!("H_0 -> H_1 VM execution result: {:?}", res_0);
    assert_eq!(res_0, Ok(()), "Shared reject successor bytecode MUST pass in TxScriptEngine for c -> c+1");
    let used_units_rej = vm_0.used_script_units();
    println!("Reject harness used script units: {}", used_units_rej.0);

    // -------------------------------------------------------------
    // TEST 2: c -> c + 2 Attack -> MUST FAIL at OpEqualVerify
    // -------------------------------------------------------------
    println!("\n--- TEST 2: c -> c + 2 Attack (H_0 attempting to output H_2) ---");
    let h2_redeem = build_reject_harness_covenant(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
        2, // SKIPPED TO COUNTER = 2!
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
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let pop_skip = PopulatedTransaction::new(&tx_skip, vec![UtxoEntry::new(
        pool_principal,
        h0_spk,
        1_000_100,
        false,
        None,
    )]);
    let cov_ctx_skip = CovenantsContext::from_tx(&pop_skip).unwrap();
    let ctx_skip = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_skip);
    let mut vm_skip = TxScriptEngine::from_transaction_input(&pop_skip, &pop_skip.tx.inputs[0], 0, &pop_skip.entries[0], ctx_skip, flags);
    let res_skip = vm_skip.execute();
    println!("c -> c+2 skip attack result: {:?}", res_skip);
    assert!(res_skip.is_err(), "Skipping counter to c+2 MUST fail OpEqualVerify in VM");
    println!("c -> c+2 skip attack successfully rejected by VM!");

    // -------------------------------------------------------------
    // TEST 3: Multi-Step Chained UTXO Execution: H_0 -> H_1 -> H_2 -> H_3
    // -------------------------------------------------------------
    println!("\n--- TEST 3: Chained Multi-Step Execution H_0 -> H_1 -> H_2 -> H_3 ---");
    let mut current_c = 0u64;
    for step in 0..3 {
        let cur_h = build_reject_harness_covenant(round_id, ticket_root, total_tickets, target_hash, random_seed, current_c);
        let cur_spk = pay_to_script_hash_script(&cur_h);

        let next_h = build_reject_harness_covenant(round_id, ticket_root, total_tickets, target_hash, random_seed, current_c + 1);
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
            0,
            SubnetworkId::default(),
            0,
            vec![],
        );
        let pop_step = PopulatedTransaction::new(&tx_step, vec![UtxoEntry::new(
            pool_principal,
            cur_spk,
            1_000_100 + step as u64 * 10,
            false,
            None,
        )]);
        let cov_ctx_step = CovenantsContext::from_tx(&pop_step).unwrap();
        let ctx_step = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx_step);
        let mut vm_step = TxScriptEngine::from_transaction_input(&pop_step, &pop_step.tx.inputs[0], 0, &pop_step.entries[0], ctx_step, flags);
        let res_step = vm_step.execute();
        assert_eq!(res_step, Ok(()), "Chained step {} (H_{} -> H_{}) failed", step, current_c, current_c + 1);
        println!("  Step {}: H_{} -> H_{} verified Ok(())!", step, current_c, current_c + 1);
        current_c += 1;
    }
    println!("Chained multi-step execution H_0 -> H_1 -> H_2 -> H_3 successfully verified in VM!");

    // -------------------------------------------------------------
    // TEST 4: Resource Measurement for Reject Successor Transaction
    // -------------------------------------------------------------
    println!("\n--- TEST 4: Resource Measurement ---");
    let mc = MassCalculator::new(1, 10, 10_000_000);
    let wire_bytes_0 = borsh::to_vec(&tx_0).unwrap().len();
    let non_ctx_0 = mc.calc_non_contextual_masses(&tx_0);

    println!("===============================================================");
    println!("REJECT SUCCESSOR (H_0 -> H_1) Transaction Resource Audit:");
    println!("  SignatureScript Length      : {} bytes", sig_script_0.len());
    println!("  RedeemScript Length         : {} bytes", h0_redeem.len());
    println!("  Actual Wire Bytes           : {} bytes", wire_bytes_0);
    println!("  Used Script Units           : {}", used_units_rej.0);
    println!("  Compute Mass                : {} gram", non_ctx_0.compute_mass);
    println!("  Transient Mass              : {} gram", non_ctx_0.transient_mass);
    println!("  Fee Mass (Overall)          : {} gram", std::cmp::max(non_ctx_0.compute_mass, non_ctx_0.transient_mass));
    println!("  Minimum Relay Fee           : {} sompi ({:.6} KAS)", std::cmp::max(non_ctx_0.compute_mass, non_ctx_0.transient_mass) * 100, (std::cmp::max(non_ctx_0.compute_mass, non_ctx_0.transient_mass) * 100) as f64 / 1e8);
    println!("===============================================================");

    println!("\n>>> ALL TESTS IN REJECT SUCCESSOR VM TEST SUITE PASSED! <<<");
}
