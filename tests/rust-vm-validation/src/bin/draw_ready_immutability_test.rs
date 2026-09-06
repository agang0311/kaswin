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
};
use kaspa_consensus_core::mass::ComputeBudget;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;

#[path = "../../../../contracts/sealed_to_draw_ready.rs"]
mod sealed_to_draw_ready;
use sealed_to_draw_ready::build_draw_ready_redeem_script;

fn main() {
    println!("=== Testing DRAW_READY Output Execution (No SeqCommit access required) ===");

    let round_id = Hash::from_u64_word(1);
    let ticket_root = Hash::from_u64_word(2);
    let total_tickets = 100u64;
    let target_hash = Hash::from_u64_word(999);
    let random_seed = Hash::from_u64_word(123456);
    let pool_principal = 50_000_000_000u64;

    let draw_ready_redeem = build_draw_ready_redeem_script(
        round_id,
        ticket_root,
        total_tickets,
        target_hash,
        random_seed,
    );
    let draw_ready_spk = pay_to_script_hash_script(&draw_ready_redeem);

    // Spending DRAW_READY requires NO Header preimages and NO OpChainblockSeqCommit:
    let mut sig_sb = ScriptBuilder::new();
    sig_sb.add_data(&draw_ready_redeem).unwrap();
    let sig_script = sig_sb.drain();

    let tx = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::default(), 0),
            sig_script,
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
    let pop = PopulatedTransaction::new(&tx, vec![UtxoEntry::new(
        pool_principal,
        draw_ready_spk,
        1_000_200,
        false,
        None,
    )]);

    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let cov_ctx = CovenantsContext::from_tx(&pop).unwrap();
    // EngineContext WITHOUT seq_commit_accessor!
    let ctx = EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx);

    let mut vm = TxScriptEngine::from_transaction_input(&pop, &pop.tx.inputs[0], 0, &pop.entries[0], ctx, flags);
    let res = vm.execute();
    println!("Execution result without SeqCommit accessor: {:?}", res);
    assert_eq!(res, Ok(()), "DRAW_READY must execute without SeqCommit access!");
    println!(">>> DRAW_READY completely decoupled from SeqCommit access window! <<<");
}
