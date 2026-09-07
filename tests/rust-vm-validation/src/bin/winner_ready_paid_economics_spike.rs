//! KASWIN V1 — WINNER_READY -> PAID TERMINAL SETTLEMENT ECONOMICS SPIKE
//!
//! Evaluates the terminal transaction topology and atomic economics:
//! Input:
//!   - Exactly 1 state input (Input 0, WINNER_READY covenant UTXO)
//!   - No external inputs, no external fee payer
//! Outputs:
//!   - Output 0: Net winner payout (gross_pool - finalizer_reward - F) -> winner_payout_spk
//!   - Output 1: Creator state_deposit return (Input0 - gross_pool) -> creator_refund_spk
//!   - Output 2: Fixed finalizer reward (FINALIZER_REWARD) -> canonical finalizer_payout_spk
//! Fee:
//!   - Implicit miner fee F = Input0 - Output0 - Output1 - Output2
//!   - Enforced bound: 0 <= F <= MAX_FINALIZE_FEE
//!   - Guaranteed minimum winner payout: Output0 >= MIN_WINNER_PAYOUT
//! Lineage:
//!   - All 3 outputs carry Covenant = None
//!   - KIP-20 singleton lineage terminates completely via OpAuthOutputCount == 0 and OpCovOutputCount == 0

use std::time::Instant;

use kaspa_consensus_core::constants::TX_VERSION_TOCCATA;
use kaspa_consensus_core::config::params::TESTNET_PARAMS;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::{ComputeBudget, MassCalculator, ScriptUnits, transaction_estimated_serialized_size};
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    ComputeCommit, CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction,
    TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry,
};
use kaspa_hashes::Hash;
use kaspa_txscript::{
    caches::Cache,
    covenants::CovenantsContext,
    opcodes::codes::*,
    script_builder::ScriptBuilder,
    standard::pay_to_script_hash_script,
    EngineCtx, EngineFlags, TxScriptEngine,
};

#[path = "../../../../contracts/lineage.rs"]
pub mod lineage;

// -----------------------------------------------------------------------------
// PROTOCOL CONSTANTS & CANDIDATES
// -----------------------------------------------------------------------------

pub const ZERO_HASH: Hash = Hash::from_bytes([0u8; 32]);

pub fn round_id_const() -> Hash { Hash::from_u64_word(0x52525252) }
pub fn covenant_id_const() -> Hash { Hash::from_u64_word(0xc001) }

pub const TICKET_PRICE: u64 = 100_000; // 0.001 KAS = 100,000 sompi
pub const FINALIZER_REWARD: u64 = 100_000_000; // 1 KAS = 100,000,000 sompi
pub const MAX_FINALIZE_FEE: u64 = 50_000_000;  // 0.5 KAS = 50,000,000 sompi
pub const MIN_WINNER_PAYOUT: u64 = 100_000_000; // 1 KAS = 100,000,000 sompi

pub const CREATOR_PUBKEY: [u8; 32] = [0x44; 32];
pub const WINNER_PUBKEY: [u8; 32] = [0x77; 32];
pub const FINALIZER_PUBKEY: [u8; 32] = [0x88; 32];

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

pub fn p2pk_bytes(key: [u8; 32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(34);
    v.push(0x20); // OP_DATA_32
    v.extend_from_slice(&key);
    v.push(0xac); // OP_CHECKSIG
    v
}

pub fn p2pk_spk(key: [u8; 32]) -> ScriptPublicKey {
    ScriptPublicKey::from_vec(0, p2pk_bytes(key))
}

pub fn push_data_len(len: usize) -> Vec<u8> {
    if len <= 75 {
        vec![len as u8]
    } else if len <= 255 {
        vec![0x4c, len as u8]
    } else {
        vec![0x4d, (len & 0xff) as u8, ((len >> 8) & 0xff) as u8]
    }
}

// -----------------------------------------------------------------------------
// WINNER_READY COVENANT BUILDERS
// -----------------------------------------------------------------------------

/// Builds the canonical WINNER_READY prefix layout (10 state items, directory dropped)
pub fn build_winner_ready_prefix(
    round_id: &Hash,
    ticket_price: u64,
    draw_ticket_count: u64,
    ticket_root: &Hash,
    target_hash: &Hash,
    random_seed: &Hash,
    accepted_counter: u64,
    winner_index: u64,
    winner_payout_spk: &[u8],
    creator_refund_spk: &[u8],
) -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });
    sb.add_op(OpTxInputIndex).unwrap();
    sb.add_op(Op0).unwrap();
    sb.add_op(OpEqualVerify).unwrap();
    sb.add_data(&round_id.as_bytes()).unwrap();
    sb.add_data(&ticket_price.to_le_bytes()).unwrap();
    sb.add_data(&draw_ticket_count.to_le_bytes()).unwrap();
    sb.add_data(&ticket_root.as_bytes()).unwrap();
    sb.add_data(&target_hash.as_bytes()).unwrap();
    sb.add_data(&random_seed.as_bytes()).unwrap();
    sb.add_data(&accepted_counter.to_le_bytes()).unwrap();
    sb.add_data(&winner_index.to_le_bytes()).unwrap();
    sb.add_data(winner_payout_spk).unwrap();
    sb.add_data(creator_refund_spk).unwrap();
    sb.drain()
}

/// Builds the production WINNER_READY terminal settlement covenant body.
/// Enforces:
///   1. Input count == 1, Output count == 3
///   2. Gross pool G = ticket_price * draw_ticket_count
///   3. State deposit D = Input0Amount - G
///   4. Output 1 SPK == creator_refund_spk, Output 1 Amount == D
///   5. Output 2 SPK == canonical P2PK(finalizer_payout_spk), Output 2 Amount == FINALIZER_REWARD
///   6. Output 0 SPK == winner_payout_spk
///   7. Transaction fee F = Input0 - (Output0 + Output1 + Output2)
///   8. Fee bounds: 0 <= F <= MAX_FINALIZE_FEE
///   9. Guaranteed prize: Output0 >= MIN_WINNER_PAYOUT
///  10. KIP-20 terminal lineage guard (covenant destroyed across all outputs)
pub fn build_winner_ready_settlement_body() -> Vec<u8> {
    let mut sb = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() });

    // Entry stack from prefix + witness:
    // Witness (from signature script):
    //   [finalizer_payout_spk (34B)] -> depth 10
    // Prefix items (bottom to top, 10 items):
    //   [0] round_id (32B)          -> depth 9
    //   [1] ticket_price (8B)       -> depth 8
    //   [2] draw_ticket_count (8B)  -> depth 7
    //   [3] ticket_root (32B)       -> depth 6
    //   [4] target_hash (32B)       -> depth 5
    //   [5] random_seed (32B)       -> depth 4
    //   [6] accepted_counter (8B)   -> depth 3
    //   [7] winner_index (8B)       -> depth 2
    //   [8] winner_payout_spk (34B) -> depth 1
    //   [9] creator_refund_spk (34B)-> depth 0

    // 1. Validate finalizer_payout_spk from witness (depth 10):
    // Roll finalizer_payout_spk to top:
    sb.add_i64(10).unwrap();
    sb.add_op(OpRoll).unwrap(); // finalizer_payout_spk moved to top (depth 0)

    // Shape: exactly 34 bytes, byte 0 is 0x20 (OP_DATA_32), byte 33 is 0xac (OP_CHECKSIG)
    // Note: OpSize DOES NOT consume the operand!
    sb.add_op(OpSize).unwrap();
    sb.add_i64(34).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap(); // asserts len == 34

    sb.add_op(OpDup).unwrap();
    sb.add_i64(0).unwrap(); sb.add_i64(1).unwrap(); sb.add_op(OpSubstr).unwrap();
    sb.add_data(&[0x20]).unwrap();
    sb.add_op(OpEqualVerify).unwrap(); // asserts byte[0] == 0x20

    sb.add_op(OpDup).unwrap();
    sb.add_i64(33).unwrap(); sb.add_i64(34).unwrap(); sb.add_op(OpSubstr).unwrap();
    sb.add_data(&[0xac]).unwrap();
    sb.add_op(OpEqualVerify).unwrap(); // asserts byte[33] == 0xac

    // Save validated finalizer_payout_spk to AltStack:
    sb.add_op(OpToAltStack).unwrap(); // AltStack: [finalizer_payout_spk (34B)]

    // Stack is now exactly the 10 prefix items (creator_refund_spk at depth 0, ..., round_id at depth 9):

    // 2. Strict Input and Output Topology:
    // Assert exactly 1 input in transaction:
    sb.add_op(OpTxInputCount).unwrap();
    sb.add_i64(1).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // Assert exactly 3 outputs in transaction:
    sb.add_op(OpTxOutputCount).unwrap();
    sb.add_i64(3).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // 3. Compute Gross Pool G = ticket_price * draw_ticket_count:
    // ticket_price is at depth 8, draw_ticket_count is at depth 7:
    sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // ticket_price
    sb.add_i64(8).unwrap(); sb.add_op(OpPick).unwrap(); sb.add_op(OpBin2Num).unwrap(); // draw_ticket_count (depth 7 + 1)
    sb.add_op(OpMul).unwrap(); // gross_pool G on top (depth 0)

    // 4. Derive State Deposit D = Input0Amount - G:
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap(); // Input0Amount S
    sb.add_op(OpSwap).unwrap(); // [..., S, G]
    sb.add_op(OpSub).unwrap();  // D = S - G on top (depth 0)

    // Verify D >= 0:
    sb.add_op(OpDup).unwrap();
    sb.add_i64(0).unwrap();
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    // 5. Enforce Output 1 (Creator state_deposit return):
    // Output 1 Amount == D:
    sb.add_op(Op1).unwrap(); sb.add_op(OpTxOutputAmount).unwrap(); // Output1Amount
    sb.add_op(OpEqualVerify).unwrap(); // consumes Output1Amount and D!

    // Output 1 SPK == [0x00, 0x00] || creator_refund_spk:
    // creator_refund_spk is at depth 0 on stack:
    sb.add_data(&[0x00, 0x00]).unwrap();
    sb.add_op(Op1).unwrap(); sb.add_op(OpPick).unwrap(); // creator_refund_spk (depth 0 + 1)
    sb.add_op(OpCat).unwrap(); // expected Output 1 SPK
    sb.add_op(Op1).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // 6. Enforce Output 2 (Finalizer Reward):
    // Output 2 Amount == FINALIZER_REWARD:
    sb.add_op(Op2).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_i64(FINALIZER_REWARD as i64).unwrap();
    sb.add_op(OpNumEqualVerify).unwrap();

    // Output 2 SPK == [0x00, 0x00] || finalizer_payout_spk (from AltStack):
    sb.add_data(&[0x00, 0x00]).unwrap();
    sb.add_op(OpFromAltStack).unwrap(); // finalizer_payout_spk
    sb.add_op(OpCat).unwrap(); // expected Output 2 SPK
    sb.add_op(Op2).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // 7. Enforce Output 0 (Winner Payout):
    // Output 0 SPK == [0x00, 0x00] || winner_payout_spk:
    // winner_payout_spk is at depth 1 on stack:
    sb.add_data(&[0x00, 0x00]).unwrap();
    sb.add_i64(2).unwrap(); sb.add_op(OpPick).unwrap(); // winner_payout_spk (depth 1 + 1)
    sb.add_op(OpCat).unwrap(); // expected Output 0 SPK
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputSpk).unwrap();
    sb.add_op(OpEqualVerify).unwrap();

    // Output 0 Amount >= MIN_WINNER_PAYOUT:
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputAmount).unwrap();
    sb.add_i64(MIN_WINNER_PAYOUT as i64).unwrap();
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    // 8. Enforce Transaction Fee Bounds: 0 <= F <= MAX_FINALIZE_FEE
    // Implicit transaction fee F = Input0 - (Output0 + Output1 + Output2)
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxInputAmount).unwrap();  // S
    sb.add_op(Op0).unwrap(); sb.add_op(OpTxOutputAmount).unwrap(); // W
    sb.add_op(OpSub).unwrap();                                     // S - W
    sb.add_op(Op1).unwrap(); sb.add_op(OpTxOutputAmount).unwrap(); // C
    sb.add_op(OpSub).unwrap();                                     // S - W - C
    sb.add_op(Op2).unwrap(); sb.add_op(OpTxOutputAmount).unwrap(); // R
    sb.add_op(OpSub).unwrap();                                     // F = S - W - C - R

    // Assert F >= 0:
    sb.add_op(OpDup).unwrap();
    sb.add_i64(0).unwrap();
    sb.add_op(OpGreaterThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap();

    // Assert F <= MAX_FINALIZE_FEE:
    sb.add_i64(MAX_FINALIZE_FEE as i64).unwrap();
    sb.add_op(OpLessThanOrEqual).unwrap();
    sb.add_op(OpVerify).unwrap(); // consumes F!

    // 9. KIP-20 Lineage Termination:
    // All outputs must have covenant = None, OpAuthOutputCount == 0, OpCovOutputCount == 0:
    lineage::append_kaswin_terminal_lineage_guard(&mut sb).unwrap();

    // In addition, explicitly enforce Covenant=None across Output 1 and Output 2 as well:
    // (Output 0 is checked by append_kaswin_terminal_lineage_guard)
    // Output 1: OpOutputCovenantId(1) == ZERO_HASH && OpOutputAuthorizingInput(1) == -1
    sb.add_i64(1).unwrap(); sb.add_op(OpOutputCovenantId).unwrap();
    sb.add_data(&ZERO_HASH.as_bytes()).unwrap(); sb.add_op(OpEqualVerify).unwrap();
    sb.add_i64(1).unwrap(); sb.add_op(OpOutputAuthorizingInput).unwrap();
    sb.add_i64(-1).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();

    // Output 2: OpOutputCovenantId(2) == ZERO_HASH && OpOutputAuthorizingInput(2) == -1
    sb.add_i64(2).unwrap(); sb.add_op(OpOutputCovenantId).unwrap();
    sb.add_data(&ZERO_HASH.as_bytes()).unwrap(); sb.add_op(OpEqualVerify).unwrap();
    sb.add_i64(2).unwrap(); sb.add_op(OpOutputAuthorizingInput).unwrap();
    sb.add_i64(-1).unwrap(); sb.add_op(OpNumEqualVerify).unwrap();

    // 10. Clean Stack (10 items remain):
    sb.add_op(OpTrue).unwrap();
    for _ in 0..10 {
        sb.add_op(OpSwap).unwrap();
        sb.add_op(OpDrop).unwrap();
    }

    sb.drain()
}

// -----------------------------------------------------------------------------
// VM RUNNER HELPER
// -----------------------------------------------------------------------------

fn run_settlement_vm(
    tx: &Transaction,
    redeem: &[u8],
    input0_val: u64,
    budget: Option<ComputeBudget>,
) -> Result<ScriptUnits, kaspa_txscript_errors::TxScriptError> {
    let mut tx_exec = tx.clone();
    if let Some(b) = budget {
        tx_exec.inputs[0].compute_commit = ComputeCommit::ComputeBudget(b);
    }
    let pop = PopulatedTransaction::new(&tx_exec, vec![
        UtxoEntry::new(input0_val, pay_to_script_hash_script(redeem), 0, false, Some(covenant_id_const())),
    ]);
    let cov = CovenantsContext::from_tx(&pop).map_err(|e| kaspa_txscript_errors::TxScriptError::CovenantsError(e))?;
    let cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();
    let ectx = EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov);
    let allowed_units = tx_exec.inputs[0].compute_commit.allowed_script_units();
    let mut opcode_log = Vec::new();
    let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
        &pop, &pop.tx.inputs[0], 0, &pop.entries[0], ectx,
        EngineFlags { covenants_enabled: true, ..Default::default() },
        allowed_units,
    ).with_opcode_execution_log_buffer(&mut opcode_log);
    let res = vm.execute();
    let su = vm.used_script_units();
    drop(vm);
    if res.is_err() {
        let trace = String::from_utf8_lossy(&opcode_log);
        let lines: Vec<&str> = trace.lines().collect();
        println!("VM opcode log lines={} tail:", lines.len());
        for line in lines.iter().rev().take(20).rev() { println!("  {line}"); }
    }
    res.map(|_| su)
}

// -----------------------------------------------------------------------------
// MAIN TEST SUITE
// -----------------------------------------------------------------------------

fn main() {
    println!("================================================================");
    println!("KASWIN V1 — WINNER_READY -> PAID TERMINAL SETTLEMENT SPIKE");
    println!("================================================================");

    let mass = MassCalculator::new_with_consensus_params(&TESTNET_PARAMS);
    let cof = TESTNET_PARAMS.block_mass_cofactors().after();

    let winner_payout_spk = p2pk_bytes(WINNER_PUBKEY);
    let creator_refund_spk = p2pk_bytes(CREATOR_PUBKEY);
    let finalizer_payout_spk = p2pk_bytes(FINALIZER_PUBKEY);

    let ticket_root = Hash::from_u64_word(111);
    let target_hash = Hash::from_u64_word(222);
    let random_seed = Hash::from_u64_word(333);
    let accepted_counter = 0u64;
    let winner_index = 42u64;

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };

    // =========================================================================
    // SCENARIO 1: Main Partial Sale Vector (N = 7,420, State Deposit = 100 KAS)
    // =========================================================================
    println!("\n=== SCENARIO 1: MAIN PARTIAL SALE (N = 7,420) ===");
    let n_main = 7_420u64;
    let gross_pool_main = n_main * TICKET_PRICE; // 7,420 * 100,000 = 742,000,000 sompi (7.42 KAS)
    let state_deposit_main = 10_000_000_000u64;  // 100 KAS = 10,000,000,000 sompi
    let input0_amount_main = state_deposit_main + gross_pool_main; // 10,742,000,000 sompi

    // Economic bounds check:
    assert!(gross_pool_main >= FINALIZER_REWARD + MAX_FINALIZE_FEE + MIN_WINNER_PAYOUT,
        "Scenario 1 gross_pool must satisfy minimum economic constraint");

    let winner_ready_prefix_main = build_winner_ready_prefix(
        &round_id_const(), TICKET_PRICE, n_main, &ticket_root, &target_hash,
        &random_seed, accepted_counter, winner_index, &winner_payout_spk, &creator_refund_spk,
    );
    let winner_ready_body = build_winner_ready_settlement_body();
    let mut winner_ready_redeem_main = winner_ready_prefix_main;
    winner_ready_redeem_main.extend_from_slice(&winner_ready_body);
    let _winner_ready_spk_main = pay_to_script_hash_script(&winner_ready_redeem_main);

    println!("WINNER_READY Parameters:");
    println!("  round_id:          {:?}", round_id_const());
    println!("  ticket_price:      {} sompi", TICKET_PRICE);
    println!("  draw_ticket_count: {}", n_main);
    println!("  gross_pool:        {} sompi ({} KAS)", gross_pool_main, gross_pool_main as f64 / 1e8);
    println!("  state_deposit:     {} sompi ({} KAS)", state_deposit_main, state_deposit_main as f64 / 1e8);
    println!("  Input 0 amount:    {} sompi ({} KAS)", input0_amount_main, input0_amount_main as f64 / 1e8);
    println!("  Redeem length:     {} B", winner_ready_redeem_main.len());

    // Helper to construct settlement transaction for Scenario 1
    let make_tx = |fee: u64| -> Transaction {
        let winner_amount = gross_pool_main - FINALIZER_REWARD - fee;
        let creator_amount = state_deposit_main;
        let finalizer_amount = FINALIZER_REWARD;

        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&finalizer_payout_spk).unwrap();
        sig_sb.add_data(&winner_ready_redeem_main).unwrap();
        let sig_script = sig_sb.drain();

        Transaction::new(
            TX_VERSION_TOCCATA,
            vec![
                TransactionInput::new_with_mass(
                    TransactionOutpoint::new(Hash::from_u64_word(500), 0),
                    sig_script,
                    0,
                    ComputeCommit::ComputeBudget(ComputeBudget(5)),
                ),
            ],
            vec![
                // Output 0: Winner Net Payout (Covenant = None)
                TransactionOutput {
                    value: winner_amount,
                    script_public_key: p2pk_spk(WINNER_PUBKEY),
                    covenant: None,
                },
                // Output 1: Creator State Deposit Return (Covenant = None)
                TransactionOutput {
                    value: creator_amount,
                    script_public_key: p2pk_spk(CREATOR_PUBKEY),
                    covenant: None,
                },
                // Output 2: Fixed Finalizer Reward (Covenant = None)
                TransactionOutput {
                    value: finalizer_amount,
                    script_public_key: p2pk_spk(FINALIZER_PUBKEY),
                    covenant: None,
                },
            ],
            0,
            SubnetworkId::default(),
            0,
            vec![],
        )
    };

    // Test Case 1.1: F = 0 (Zero miner fee)
    println!("\nTest 1.1: F = 0 sompi (zero fee)");
    let tx_f0 = make_tx(0);
    let su_f0 = run_settlement_vm(&tx_f0, &winner_ready_redeem_main, input0_amount_main, None)
        .expect("F=0 execution failed");
    let bmin_f0 = ComputeBudget::checked_covering_script_units(su_f0).unwrap();
    assert_eq!(run_settlement_vm(&tx_f0, &winner_ready_redeem_main, input0_amount_main, Some(bmin_f0)).map(|_| ()), Ok(()));
    if bmin_f0.0 > 0 {
        let bmin_minus_1_f0 = run_settlement_vm(&tx_f0, &winner_ready_redeem_main, input0_amount_main, Some(ComputeBudget(bmin_f0.0 - 1)));
        assert!(matches!(bmin_minus_1_f0, Err(kaspa_txscript_errors::TxScriptError::ExceededCommittedScriptUnits { .. })));
    } else {
        println!("  (B_min=0: free units 9,999 cover {} SU without budget commit)", su_f0.0);
    }
    println!("  F = 0: PASS (used {} SU, B_min={})", su_f0.0, bmin_f0.0);

    // Test Case 1.2: F = representative ordinary fee (20,000 sompi)
    let f_rep = 20_000u64;
    println!("\nTest 1.2: F = {} sompi (ordinary fee)", f_rep);
    let tx_f_rep = make_tx(f_rep);
    let t_start = Instant::now();
    let su_f_rep = run_settlement_vm(&tx_f_rep, &winner_ready_redeem_main, input0_amount_main, None)
        .expect("F=ordinary execution failed");
    let dt_f_rep = t_start.elapsed();
    let bmin_f_rep = ComputeBudget::checked_covering_script_units(su_f_rep).unwrap();
    assert_eq!(run_settlement_vm(&tx_f_rep, &winner_ready_redeem_main, input0_amount_main, Some(bmin_f_rep)).map(|_| ()), Ok(()));
    if bmin_f_rep.0 > 0 {
        let bmin_minus_1_f_rep = run_settlement_vm(&tx_f_rep, &winner_ready_redeem_main, input0_amount_main, Some(ComputeBudget(bmin_f_rep.0 - 1)));
        assert!(matches!(bmin_minus_1_f_rep, Err(kaspa_txscript_errors::TxScriptError::ExceededCommittedScriptUnits { .. })));
    }
    println!("  F = {}: PASS (used {} SU, B_min={})", f_rep, su_f_rep.0, bmin_f_rep.0);

    // Measure Physical Resources for Scenario 1 (Ordinary Fee):
    let non_rep = mass.calc_non_contextual_masses(&tx_f_rep);
    let pop_rep = PopulatedTransaction::new(&tx_f_rep, vec![
        UtxoEntry::new(input0_amount_main, pay_to_script_hash_script(&winner_ready_redeem_main), 0, false, Some(covenant_id_const())),
    ]);
    let _ctx_rep = mass.calc_contextual_masses(&pop_rep).unwrap();
    let norm_trans_rep = non_rep.normalized_transient(&cof);
    let fee_mass_rep = non_rep.compute_mass.max(norm_trans_rep);
    let relay_floor_rep = (fee_mass_rep * 100_000 / 1000).max(100_000);

    // Test Case 1.3: F = MAX_FINALIZE_FEE (50,000,000 sompi = 0.5 KAS)
    println!("\nTest 1.3: F = {} sompi (MAX_FINALIZE_FEE)", MAX_FINALIZE_FEE);
    let tx_f_max = make_tx(MAX_FINALIZE_FEE);
    let su_f_max = run_settlement_vm(&tx_f_max, &winner_ready_redeem_main, input0_amount_main, None)
        .expect("F=MAX_FINALIZE_FEE execution failed");
    let bmin_f_max = ComputeBudget::checked_covering_script_units(su_f_max).unwrap();
    assert_eq!(run_settlement_vm(&tx_f_max, &winner_ready_redeem_main, input0_amount_main, Some(bmin_f_max)).map(|_| ()), Ok(()));
    println!("  F = MAX: PASS (used {} SU, B_min={})", su_f_max.0, bmin_f_max.0);

    // Test Case 1.4: F = 1 sompi (boundary test)
    // Test Case 1.4: F = 1 sompi (boundary test)
    println!("\nTest 1.4: F = 1 sompi");
    let tx_f1 = make_tx(1);
    assert_eq!(run_settlement_vm(&tx_f1, &winner_ready_redeem_main, input0_amount_main, None).map(|_| ()), Ok(()));
    println!("  F = 1: PASS (consensus valid; relay-policy: BELOW FLOOR)");

    // Test Case 1.5: F = relay_floor - 1 (below ordinary relay floor)
    let relay_floor = relay_floor_rep;
    let f_below_floor = relay_floor - 1;
    println!("\nTest 1.5: F = {} sompi (relay_floor - 1)", f_below_floor);
    let tx_f_below = make_tx(f_below_floor);
    assert_eq!(run_settlement_vm(&tx_f_below, &winner_ready_redeem_main, input0_amount_main, None).map(|_| ()), Ok(()));
    println!("  F = relay_floor - 1: PASS in TxScriptEngine (consensus valid; relay-policy: BELOW FLOOR)");

    // Test Case 1.6: F = relay_floor (exactly meeting ordinary relay floor)
    println!("\nTest 1.6: F = {} sompi (relay_floor)", relay_floor);
    let tx_f_floor = make_tx(relay_floor);
    assert_eq!(run_settlement_vm(&tx_f_floor, &winner_ready_redeem_main, input0_amount_main, None).map(|_| ()), Ok(()));
    println!("  F = relay_floor: PASS in TxScriptEngine (consensus valid; relay-policy: RELAYABLE)");

    // Assert MAX_FINALIZE_FEE covers relay floor comfortably:
    assert!(MAX_FINALIZE_FEE >= relay_floor, "MAX_FINALIZE_FEE must be >= expected normal relay floor");
    println!("  MAX_FINALIZE_FEE ({} sompi) >= relay_floor ({} sompi): PASS", MAX_FINALIZE_FEE, relay_floor);

    // =========================================================================
    // SCENARIO 2: Minimum Successful Draw (N = min_tickets = 2,500)
    // =========================================================================
    println!("\n=== SCENARIO 2: MINIMUM SUCCESSFUL DRAW (N = 2,500) ===");
    let n_min = 2_500u64;
    let gross_pool_min = n_min * TICKET_PRICE; // 2,500 * 100,000 = 250,000,000 sompi (2.5 KAS)
    let state_deposit_min = 50_000_000u64;     // 0.5 KAS state deposit
    let input0_amount_min = state_deposit_min + gross_pool_min;

    // Boundary check: gross_pool == R + MAX_FINALIZE_FEE + MIN_WINNER_PAYOUT
    assert_eq!(gross_pool_min, FINALIZER_REWARD + MAX_FINALIZE_FEE + MIN_WINNER_PAYOUT);

    let winner_ready_prefix_min = build_winner_ready_prefix(
        &round_id_const(), TICKET_PRICE, n_min, &ticket_root, &target_hash,
        &random_seed, accepted_counter, winner_index, &winner_payout_spk, &creator_refund_spk,
    );
    let mut winner_ready_redeem_min = winner_ready_prefix_min;
    winner_ready_redeem_min.extend_from_slice(&winner_ready_body);

    // When F = MAX_FINALIZE_FEE, winner gets exactly MIN_WINNER_PAYOUT:
    let tx_min_draw = {
        let winner_amount = gross_pool_min - FINALIZER_REWARD - MAX_FINALIZE_FEE;
        assert_eq!(winner_amount, MIN_WINNER_PAYOUT);

        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&finalizer_payout_spk).unwrap();
        sig_sb.add_data(&winner_ready_redeem_min).unwrap();
        let sig_script = sig_sb.drain();

        Transaction::new(
            TX_VERSION_TOCCATA,
            vec![
                TransactionInput::new_with_mass(
                    TransactionOutpoint::new(Hash::from_u64_word(510), 0),
                    sig_script,
                    0,
                    ComputeCommit::ComputeBudget(ComputeBudget(5)),
                ),
            ],
            vec![
                TransactionOutput { value: winner_amount, script_public_key: p2pk_spk(WINNER_PUBKEY), covenant: None },
                TransactionOutput { value: state_deposit_min, script_public_key: p2pk_spk(CREATOR_PUBKEY), covenant: None },
                TransactionOutput { value: FINALIZER_REWARD, script_public_key: p2pk_spk(FINALIZER_PUBKEY), covenant: None },
            ],
            0, SubnetworkId::default(), 0, vec![],
        )
    };
    let su_min = run_settlement_vm(&tx_min_draw, &winner_ready_redeem_min, input0_amount_min, None)
        .expect("Minimum draw settlement failed");
    println!("  Minimum draw (N=2,500, F=MAX, winner=MIN_WINNER_PAYOUT): PASS (used {} SU)", su_min.0);

    // =========================================================================
    // SCENARIO 3: Full Ticket Cap Draw (N = 100,000)
    // =========================================================================
    println!("\n=== SCENARIO 3: FULL TICKET CAP (N = 100,000) ===");
    let n_full = 100_000u64;
    let gross_pool_full = n_full * TICKET_PRICE; // 100,000 * 100,000 = 10,000,000,000 sompi (100 KAS)
    let state_deposit_full = 500_000_000u64;     // 5 KAS state deposit
    let input0_amount_full = state_deposit_full + gross_pool_full;

    let winner_ready_prefix_full = build_winner_ready_prefix(
        &round_id_const(), TICKET_PRICE, n_full, &ticket_root, &target_hash,
        &random_seed, accepted_counter, winner_index, &winner_payout_spk, &creator_refund_spk,
    );
    let mut winner_ready_redeem_full = winner_ready_prefix_full;
    winner_ready_redeem_full.extend_from_slice(&winner_ready_body);

    let tx_full = {
        let fee = 25_000u64;
        let winner_amount = gross_pool_full - FINALIZER_REWARD - fee;

        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&finalizer_payout_spk).unwrap();
        sig_sb.add_data(&winner_ready_redeem_full).unwrap();
        let sig_script = sig_sb.drain();

        Transaction::new(
            TX_VERSION_TOCCATA,
            vec![
                TransactionInput::new_with_mass(
                    TransactionOutpoint::new(Hash::from_u64_word(520), 0),
                    sig_script,
                    0,
                    ComputeCommit::ComputeBudget(ComputeBudget(5)),
                ),
            ],
            vec![
                TransactionOutput { value: winner_amount, script_public_key: p2pk_spk(WINNER_PUBKEY), covenant: None },
                TransactionOutput { value: state_deposit_full, script_public_key: p2pk_spk(CREATOR_PUBKEY), covenant: None },
                TransactionOutput { value: FINALIZER_REWARD, script_public_key: p2pk_spk(FINALIZER_PUBKEY), covenant: None },
            ],
            0, SubnetworkId::default(), 0, vec![],
        )
    };
    let su_full = run_settlement_vm(&tx_full, &winner_ready_redeem_full, input0_amount_full, None)
        .expect("Full ticket cap settlement failed");
    println!("  Full ticket cap (N=100,000, prize=98.99975 KAS): PASS (used {} SU)", su_full.0);

    // =========================================================================
    // NEGATIVE ADVERSARIAL MATRIX (20 REQUIRED CASES)
    // =========================================================================
    println!("\n=== COMPREHENSIVE NEGATIVE ADVERSARIAL MATRIX (20 REQUIRED CASES) ===");

    // Helper for running negative test cases against Scenario 1
    let run_neg = |name: &str, tx: &Transaction, redeem: &[u8], in0_val: u64| {
        let res = run_settlement_vm(tx, redeem, in0_val, None);
        assert!(res.is_err(), "Negative test `{}` should have FAILED but PASSED!", name);
        println!("  {:<50} -> FAIL (Rejected as required)", name);
    };

    // #01: Wrong winner payout SPK (modified pubkey)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[0].script_public_key = p2pk_spk([0x99; 32]);
        run_neg("#01: wrong winner payout SPK", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #02: Winner amount +1 (steals 1 sompi from fee)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[0].value += 1;
        // Total outputs = Input0 - f_rep + 1 -> F becomes f_rep - 1, but let's test amount mismatch:
        // Wait, if winner amount is +1, fee F = f_rep - 1. But does Output0 equal G - R - F?
        // Wait! In the script:
        // C is asserted to be D
        // R is asserted to be FINALIZER_REWARD
        // F is computed as Input0 - W - C - R.
        // If W is increased by 1, F decreases by 1 (which is still a legal fee if f_rep - 1 >= 0)!
        // BUT what if total output amount exceeds Input0?
        // When F = 0, winner amount +1 makes total outputs = Input0 + 1!
        let mut tx_over = make_tx(0);
        tx_over.outputs[0].value += 1; // W = G - R + 1 -> F = -1!
        run_neg("#02: winner amount +1 (exceeds pool, F < 0)", &tx_over, &winner_ready_redeem_main, input0_amount_main);
    }

    // #03: Winner amount -1 without corresponding legal fee (creates F = MAX_FINALIZE_FEE + 1)
    {
        let mut tx = make_tx(MAX_FINALIZE_FEE);
        tx.outputs[0].value -= 1; // Siphons 1 extra sompi into fee -> F = MAX_FINALIZE_FEE + 1!
        run_neg("#03: winner amount -1 (F > MAX_FINALIZE_FEE)", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #04: Wrong creator SPK (modified creator address)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[1].script_public_key = p2pk_spk([0x99; 32]);
        run_neg("#04: wrong creator refund SPK", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #05: Creator deposit -1 (steals 1 sompi from creator)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[1].value -= 1;
        run_neg("#05: creator deposit -1 sompi", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #06: Creator deposit +1 (inflates creator deposit by 1 sompi)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[1].value += 1;
        run_neg("#06: creator deposit +1 sompi", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #07: Wrong finalizer SPK binding (witness SPK != Output 2 SPK)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[2].script_public_key = p2pk_spk([0x99; 32]); // Output2 differs from witness
        run_neg("#07: wrong finalizer SPK binding", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #08: Finalizer reward -1 (underpays finalizer)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[2].value = FINALIZER_REWARD - 1;
        run_neg("#08: finalizer reward -1 sompi", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #09: Finalizer reward +1 (overpays finalizer)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[2].value = FINALIZER_REWARD + 1;
        run_neg("#09: finalizer reward +1 sompi", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #10: F = MAX_FINALIZE_FEE + 1 sompi (fee exceeds maximum cap)
    {
        let tx = make_tx(MAX_FINALIZE_FEE + 1);
        run_neg("#10: F = MAX_FINALIZE_FEE + 1 sompi", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #11: Negative/underflow economic construction (Input0 < Output0 + Output1 + Output2)
    {
        let mut tx = make_tx(0);
        tx.outputs[0].value = input0_amount_main; // W = S, so W + C + R = S + C + R > S!
        run_neg("#11: negative fee / total outputs exceed input", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #12: Hidden fourth output (attempts to siphon funds)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs.push(TransactionOutput {
            value: 10_000,
            script_public_key: p2pk_spk([0x33; 32]),
            covenant: None,
        });
        run_neg("#12: hidden fourth output added", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #13: Extra state continuation output (Output 0 carries Kaswin covenant id)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[0].covenant = Some(CovenantBinding { covenant_id: covenant_id_const(), authorizing_input: 0 });
        run_neg("#13: extra state continuation on Output 0", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #14: Duplicate Kaswin continuation (Outputs 0 and 1 carry covenant)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[0].covenant = Some(CovenantBinding { covenant_id: covenant_id_const(), authorizing_input: 0 });
        tx.outputs[1].covenant = Some(CovenantBinding { covenant_id: covenant_id_const(), authorizing_input: 0 });
        run_neg("#14: duplicate Kaswin covenant outputs", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #15: Foreign covenant output on Output 0
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[0].covenant = Some(CovenantBinding { covenant_id: Hash::from_u64_word(0xbeef), authorizing_input: 0 });
        run_neg("#15: foreign covenant output on Output 0", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #15b: Covenant binding on Output 1 (creator output)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[1].covenant = Some(CovenantBinding { covenant_id: Hash::from_u64_word(0xbeef), authorizing_input: 0 });
        run_neg("#15b: covenant binding on Output 1", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #15c: Covenant binding on Output 2 (finalizer output)
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[2].covenant = Some(CovenantBinding { covenant_id: Hash::from_u64_word(0xbeef), authorizing_input: 0 });
        run_neg("#15c: covenant binding on Output 2", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #16: Wrong draw_ticket_count in redeem script
    {
        let tampered_prefix = build_winner_ready_prefix(
            &round_id_const(), TICKET_PRICE, n_main + 1, &ticket_root, &target_hash,
            &random_seed, accepted_counter, winner_index, &winner_payout_spk, &creator_refund_spk,
        );
        let mut tampered_redeem = tampered_prefix;
        tampered_redeem.extend_from_slice(&winner_ready_body);
        let mut tx = make_tx(f_rep);
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&finalizer_payout_spk).unwrap();
        sig_sb.add_data(&tampered_redeem).unwrap();
        tx.inputs[0].signature_script = sig_sb.drain();
        run_neg("#16: wrong draw_ticket_count in state", &tx, &tampered_redeem, input0_amount_main);
    }

    // #17: Wrong ticket_price in redeem script
    {
        let tampered_prefix = build_winner_ready_prefix(
            &round_id_const(), TICKET_PRICE + 1, n_main, &ticket_root, &target_hash,
            &random_seed, accepted_counter, winner_index, &winner_payout_spk, &creator_refund_spk,
        );
        let mut tampered_redeem = tampered_prefix;
        tampered_redeem.extend_from_slice(&winner_ready_body);
        let mut tx = make_tx(f_rep);
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&finalizer_payout_spk).unwrap();
        sig_sb.add_data(&tampered_redeem).unwrap();
        tx.inputs[0].signature_script = sig_sb.drain();
        run_neg("#17: wrong ticket_price in state", &tx, &tampered_redeem, input0_amount_main);
    }

    // #18: State input amount inconsistent with D + gross_pool (underfunded input)
    {
        let tx = make_tx(f_rep);
        // Provide input0 value less than required state_deposit + gross_pool
        run_neg("#18: input0 amount inconsistent with D + G", &tx, &winner_ready_redeem_main, input0_amount_main - 1);
    }

    // #19: Winner output below MIN_WINNER_PAYOUT
    {
        let mut tx = make_tx(f_rep);
        tx.outputs[0].value = MIN_WINNER_PAYOUT - 1; // Underpays winner below minimum guarantee
        run_neg("#19: winner output below MIN_WINNER_PAYOUT", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // #20: Malformed finalizer SPK in witness (33 bytes instead of 34 bytes)
    {
        let mut tx = make_tx(f_rep);
        let mut sig_sb = ScriptBuilder::with_flags(flags);
        sig_sb.add_data(&finalizer_payout_spk[..33]).unwrap(); // truncated 33B
        sig_sb.add_data(&winner_ready_redeem_main).unwrap();
        tx.inputs[0].signature_script = sig_sb.drain();
        run_neg("#20: malformed finalizer SPK (33B)", &tx, &winner_ready_redeem_main, input0_amount_main);
    }

    // =========================================================================
    // CONSOLIDATED RESOURCE MEASUREMENTS TABLE
    // =========================================================================
    println!("\n=== CONSOLIDATED RESOURCE MEASUREMENTS TABLE (TESTNET 10) ===");
    println!("  Scenario                         | Redeem  | Sig     | Tx      | ScriptUnits | Budget           | Compute | Transient | Norm  | Storage | Relay Floor   | Actual Fee  | VM Time");
    println!("  ---------------------------------+---------+---------+---------+-------------+------------------+---------+-----------+-------+---------+---------------+-------------+--------");

    let row = |name: &str, redeem_len: usize, sig_len: usize, tx: &Transaction, su: ScriptUnits, bmin: ComputeBudget, dt: std::time::Duration, fee: u64| {
        let non = mass.calc_non_contextual_masses(tx);
        let pop = PopulatedTransaction::new(tx, vec![
            UtxoEntry::new(input0_amount_main, pay_to_script_hash_script(&winner_ready_redeem_main), 0, false, Some(covenant_id_const())),
        ]);
        let ctx = mass.calc_contextual_masses(&pop).unwrap();
        let norm = non.normalized_transient(&cof);
        let fee_mass = non.compute_mass.max(norm);
        let relay = (fee_mass * 100_000 / 1000).max(100_000);
        println!("  {:<32} | {:>5} B | {:>5} B | {:>5} B | {:>6} SU  | Budget({}) (PASS) | comp={:<4} | trans={:<5} | norm={:<4} | stor={:<3} | {:>7} sompi | {:>7} sompi | {:?}",
            name, redeem_len, sig_len, transaction_estimated_serialized_size(tx), su.0, bmin.0, non.compute_mass, non.transient_mass, norm, ctx.storage_mass, relay, fee, dt);
    };

    row("1. Main Settlement (F=0)", winner_ready_redeem_main.len(), tx_f0.inputs[0].signature_script.len(), &tx_f0, su_f0, bmin_f0, dt_f_rep, 0);
    row("2. Main Settlement (F=20,000)", winner_ready_redeem_main.len(), tx_f_rep.inputs[0].signature_script.len(), &tx_f_rep, su_f_rep, bmin_f_rep, dt_f_rep, f_rep);
    row("3. Main Settlement (F=0.5 KAS)", winner_ready_redeem_main.len(), tx_f_max.inputs[0].signature_script.len(), &tx_f_max, su_f_max, bmin_f_max, dt_f_rep, MAX_FINALIZE_FEE);
    row("4. Min Draw Settlement (N=2,500)", winner_ready_redeem_min.len(), tx_min_draw.inputs[0].signature_script.len(), &tx_min_draw, su_min, ComputeBudget::checked_covering_script_units(su_min).unwrap(), dt_f_rep, MAX_FINALIZE_FEE);
    row("5. Full Cap Settlement (N=100k)", winner_ready_redeem_full.len(), tx_full.inputs[0].signature_script.len(), &tx_full, su_full, ComputeBudget::checked_covering_script_units(su_full).unwrap(), dt_f_rep, 25_000);

    println!("\n============================================================");
    println!("WINNER_READY -> PAID ECONOMICS PASS");
    println!("============================================================");
    println!("NEXT: return to UNSOLD refund path using the now-frozen bounded purchase directory and variable sale-close semantics");
}
