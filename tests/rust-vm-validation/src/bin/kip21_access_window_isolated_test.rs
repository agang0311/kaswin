use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::tx::ComputeCommit;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{Transaction, TransactionInput, TransactionOutput, TransactionOutpoint, UtxoEntry, VerifiableTransaction};
use kaspa_consensus_core::constants::{SEQUENCE_LOCK_TIME_DISABLED, SEQUENCE_LOCK_TIME_MASK};
use kaspa_hashes::Hash;
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, EngineCtx, caches::Cache,
    script_builder::ScriptBuilder, SeqCommitAccessor,
    opcodes::codes::*,
};
use kaspa_txscript_errors::TxScriptError;

// Mock SeqCommit accessor to test within-depth vs too-deep
struct MockAccessor {
    within_depth: bool,
    expected_hash: Hash,
    commitment: Hash,
}

impl SeqCommitAccessor for MockAccessor {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        if block_hash == self.expected_hash {
            Some(true)
        } else {
            Some(false)
        }
    }

    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        if block_hash == self.expected_hash && self.within_depth {
            Some(self.commitment)
        } else {
            None
        }
    }
}

// Logic parity with consensus UTXO context check_sequence_lock
fn reference_check_sequence_lock(tx: &impl VerifiableTransaction, pov_daa_score: u64) -> Result<(), &'static str> {
    let pov_daa_score: i64 = pov_daa_score as i64;
    for (input, entry) in tx.populated_inputs() {
        if input.sequence & SEQUENCE_LOCK_TIME_DISABLED != SEQUENCE_LOCK_TIME_DISABLED {
            let relative_lock = (input.sequence & SEQUENCE_LOCK_TIME_MASK) as i64;
            let lock_daa_score = entry.block_daa_score as i64 + relative_lock - 1;
            if lock_daa_score >= pov_daa_score {
                return Err("SequenceLockConditionsAreNotMet");
            }
        }
    }
    Ok(())
}

fn main() {
    println!("===============================================================");
    println!("KASWIN ISOLATED KIP-21 ACCESS-WINDOW & SEQUENCE-LOCK PROOFS");
    println!("===============================================================");

    let flags = EngineFlags { covenants_enabled: true, ..Default::default() };
    let sig_cache = Cache::new(1000);
    let reused = SigHashReusedValuesUnsync::new();

    let target_hash = Hash::from_u64_word(0x12345678);
    let fake_merkle_root = Hash::from_u64_word(0xabcdef01);

    // -------------------------------------------------------------
    // Test A: target within accessor -> OpChainblockSeqCommit PASS
    // -------------------------------------------------------------
    println!("\n[Test A] target within accessor threshold -> OpChainblockSeqCommit PASS");
    let mut sb_a = ScriptBuilder::with_flags(flags);
    sb_a.add_data(&target_hash.as_bytes()).unwrap();
    sb_a.add_op(OpChainblockSeqCommit).unwrap();
    sb_a.add_data(&fake_merkle_root.as_bytes()).unwrap();
    sb_a.add_op(OpEqual).unwrap();
    let script_a = sb_a.drain();

    let tx_a = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(1), 0),
            vec![],
            0,
            ComputeCommit::ComputeBudget(kaspa_consensus_core::mass::ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 10_000_000,
            script_public_key: kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, vec![]),
            covenant: None,
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_a = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_a, vec![
        UtxoEntry::new(10_000_000, kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, script_a.clone()), 100_000, false, None)
    ]);
    let acc_a = MockAccessor { within_depth: true, expected_hash: target_hash, commitment: fake_merkle_root };
    let ctx_a = EngineCtx::new(&sig_cache).with_reused(&reused).with_seq_commit_accessor(&acc_a);
    let mut vm_a = TxScriptEngine::from_transaction_input(&pop_a, &pop_a.tx.inputs[0], 0, &pop_a.entries[0], ctx_a, flags);
    let res_a = vm_a.execute();
    assert_eq!(res_a, Ok(()));
    println!("  -> PASS: OpChainblockSeqCommit succeeded within accessor window!");

    // -------------------------------------------------------------
    // Test B: same target when seq_commitment_within_depth = None -> BlockIsTooDeep
    // -------------------------------------------------------------
    println!("\n[Test B] same target when accessor depth exceeded -> BlockIsTooDeep");
    let acc_b = MockAccessor { within_depth: false, expected_hash: target_hash, commitment: fake_merkle_root };
    let ctx_b = EngineCtx::new(&sig_cache).with_reused(&reused).with_seq_commit_accessor(&acc_b);
    let mut vm_b = TxScriptEngine::from_transaction_input(&pop_a, &pop_a.tx.inputs[0], 0, &pop_a.entries[0], ctx_b, flags);
    let res_b = vm_b.execute();
    println!("  -> Execution result when depth exceeded: {:?}", res_b);
    assert!(matches!(res_b, Err(TxScriptError::BlockIsTooDeep(_))));
    println!("  -> PASS: Exceeded depth returned fatal TxScriptError::BlockIsTooDeep, NOT false!");

    // -------------------------------------------------------------
    // Test C: relative recovery before sequence maturity -> SequenceLockConditionsAreNotMet
    // -------------------------------------------------------------
    println!("\n[Test C] relative recovery before sequence maturity (PoV DAA < D0 + G)");
    let d0 = 1_000_000u64;
    let g = 5_000u64; // relative lock = 5000 DAA units
    let mut tx_c = Transaction::new(
        1,
        vec![TransactionInput::new_with_mass(
            TransactionOutpoint::new(Hash::from_u64_word(2), 0),
            vec![],
            g, // sequence = g (relative lock enabled, mask = g)
            ComputeCommit::ComputeBudget(kaspa_consensus_core::mass::ComputeBudget(0)),
        )],
        vec![TransactionOutput {
            value: 10_000_000,
            script_public_key: kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, vec![]),
            covenant: None,
        }],
        0, SubnetworkId::default(), 0, vec![],
    );
    let pop_c = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_c, vec![
        UtxoEntry::new(10_000_000, kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, vec![]), d0, false, None)
    ]);
    // lock_daa = d0 + g - 1 = 1_004_999
    // If pov_daa_score = 1_004_999: lock_daa >= pov_daa -> NOT MET!
    let res_c = reference_check_sequence_lock(&pop_c, d0 + g - 1);
    assert!(res_c.is_err());
    println!("  -> PASS: PoV DAA (D0 + G - 1) rejected with {:?}", res_c.err().unwrap());

    // -------------------------------------------------------------
    // Test D: relative recovery at first eligible DAA -> PASS
    // -------------------------------------------------------------
    println!("\n[Test D] relative recovery at first eligible DAA (PoV DAA == D0 + G)");
    // lock_daa = 1_004_999 < 1_005_000 -> MET!
    let res_d = reference_check_sequence_lock(&pop_c, d0 + g);
    assert_eq!(res_d, Ok(()));
    println!("  -> PASS: PoV DAA (D0 + G) is fully mature and accepted by sequence lock!");

    // Also check OpCheckSequenceVerify in VM for Test D:
    let mut sb_csv = ScriptBuilder::with_flags(flags);
    sb_csv.add_data(&g.to_le_bytes()).unwrap();
    sb_csv.add_op(OpCheckSequenceVerify).unwrap();
    sb_csv.add_op(OpTrue).unwrap();
    let script_csv = sb_csv.drain();

    let pop_d_vm = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_c, vec![
        UtxoEntry::new(10_000_000, kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, script_csv.clone()), d0, false, None)
    ]);
    let ctx_csv = EngineCtx::new(&sig_cache).with_reused(&reused);
    let mut vm_csv = TxScriptEngine::from_transaction_input(&pop_d_vm, &pop_d_vm.tx.inputs[0], 0, &pop_d_vm.entries[0], ctx_csv, flags);
    assert_eq!(vm_csv.execute(), Ok(()));
    println!("  -> PASS: OpCheckSequenceVerify executed Ok(()) with matching sequence!");

    // -------------------------------------------------------------
    // Test E: sequence disable bit bypass attempt -> FAIL
    // -------------------------------------------------------------
    println!("\n[Test E] sequence disable bit bypass attempt");
    // If an attacker sets SEQUENCE_LOCK_TIME_DISABLED in input.sequence to bypass relative delay:
    let mut tx_e = tx_c.clone();
    tx_e.inputs[0].sequence = g | SEQUENCE_LOCK_TIME_DISABLED;
    let pop_e_vm = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_e, vec![
        UtxoEntry::new(10_000_000, kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, script_csv.clone()), d0, false, None)
    ]);
    let ctx_e = EngineCtx::new(&sig_cache).with_reused(&reused);
    let mut vm_e = TxScriptEngine::from_transaction_input(&pop_e_vm, &pop_e_vm.tx.inputs[0], 0, &pop_e_vm.entries[0], ctx_e, flags);
    let res_e = vm_e.execute();
    println!("  -> OpCheckSequenceVerify with disabled bit set: {:?}", res_e);
    assert!(matches!(res_e, Err(TxScriptError::UnsatisfiedLockTime(_))));
    println!("  -> PASS: SEQUENCE_LOCK_TIME_DISABLED bypass strictly BLOCKED by OpCheckSequenceVerify!");

    // -------------------------------------------------------------
    // Test F: show that accessor-too-deep status cannot be caught as a script boolean
    // -------------------------------------------------------------
    println!("\n[Test F] show that accessor-too-deep status cannot be caught as a script boolean");
    // In Bitcoin/Kaspa script, there is no TRY/CATCH opcode. If OpChainblockSeqCommit encounters BlockIsTooDeep,
    // execution halts immediately with error.
    let mut sb_f = ScriptBuilder::with_flags(flags);
    sb_f.add_data(&target_hash.as_bytes()).unwrap();
    sb_f.add_op(OpChainblockSeqCommit).unwrap();
    // Suppose a script author tried: IF draw ELSE refund
    sb_f.add_op(OpIf).unwrap();
    sb_f.add_op(OpTrue).unwrap();
    sb_f.add_op(OpElse).unwrap();
    sb_f.add_op(OpTrue).unwrap();
    sb_f.add_op(OpEndIf).unwrap();
    let script_f = sb_f.drain();

    let pop_f = kaspa_consensus_core::tx::PopulatedTransaction::new(&tx_a, vec![
        UtxoEntry::new(10_000_000, kaspa_consensus_core::tx::ScriptPublicKey::from_vec(0, script_f), 100_000, false, None)
    ]);
    let ctx_f = EngineCtx::new(&sig_cache).with_reused(&reused).with_seq_commit_accessor(&acc_b);
    let mut vm_f = TxScriptEngine::from_transaction_input(&pop_f, &pop_f.tx.inputs[0], 0, &pop_f.entries[0], ctx_f, flags);
    let res_f = vm_f.execute();
    assert!(matches!(res_f, Err(TxScriptError::BlockIsTooDeep(_))));
    println!("  -> PASS: OpChainblockSeqCommit halts execution immediately on BlockIsTooDeep; cannot be branched or caught!");

    println!("\n===============================================================");
    println!("ALL 6 ISOLATED TESTS (A - F) PASSED 100%!");
    println!("===============================================================");
}
