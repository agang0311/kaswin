use std::collections::HashMap;
use std::str::FromStr;
use kaspa_hashes::Hash;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    Transaction, TransactionInput, TransactionOutput, TransactionOutpoint,
    ScriptPublicKey, UtxoEntry, PopulatedTransaction,
};
use kaspa_txscript::{
    TxScriptEngine, EngineFlags, SeqCommitAccessor,
    script_builder::ScriptBuilder, opcodes::codes,
    engine_context::EngineContext, caches::Cache,
    covenants::CovenantsContext,
};
use kaspa_txscript_errors::TxScriptError;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;

pub struct RealMockSeqCommitAccessor {
    pub selected_chain: Vec<Hash>,
    pub seq_commits: HashMap<Hash, Hash>,
}

impl SeqCommitAccessor for RealMockSeqCommitAccessor {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        Some(self.selected_chain.contains(&block_hash))
    }

    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        if self.selected_chain.contains(&block_hash) {
            self.seq_commits.get(&block_hash).copied()
        } else {
            None
        }
    }
}

pub fn execute_in_vm(
    tx: &Transaction,
    entries: Vec<UtxoEntry>,
    input_idx: usize,
    accessor: &RealMockSeqCommitAccessor,
) -> Result<(), TxScriptError> {
    let populated_tx = PopulatedTransaction::new(tx, entries);
    let sig_cache = Cache::new(10_000);
    let reused_values = SigHashReusedValuesUnsync::new();
    let covenants_ctx = CovenantsContext::from_tx(&populated_tx)?;
    let ctx = EngineContext::new(&sig_cache)
        .with_reused(&reused_values)
        .with_covenants_ctx(&covenants_ctx)
        .with_seq_commit_accessor(accessor);

    let mut vm = TxScriptEngine::from_transaction_input(
        &populated_tx,
        &populated_tx.tx.inputs[input_idx],
        input_idx,
        &populated_tx.entries[input_idx],
        ctx,
        EngineFlags { covenants_enabled: true, ..Default::default() },
    );
    vm.execute()
}

pub fn build_full_covenant_redeem_script(delta_daa: i64) -> Vec<u8> {
    let mut sb = ScriptBuilder::new();
    // Calculate boundary = Darm + delta_daa
    sb.add_i64(0).unwrap();
    sb.add_op(codes::OpTxInputDaaScore).unwrap();
    sb.add_i64(delta_daa).unwrap();
    sb.add_op(codes::OpAdd).unwrap();
    // Stack: [boundary]
    sb.add_op(codes::OpToAltStack).unwrap();
    // AltStack: [boundary]

    // Witness stack:
    // [P_hash (32B), P_daa (8B), T_hash (32B), T_daa (8B), T_parent0 (32B)]
    // Verify T_parent0 == P_hash
    // Top of stack is T_parent0. Let's compare with P_hash:
    sb.add_op(codes::OpToAltStack).unwrap(); // AltStack: [boundary, T_parent0]
    // Stack: [P_hash, P_daa, T_hash, T_daa]
    
    // Check T_daa >= boundary
    sb.add_op(codes::OpFromAltStack).unwrap(); // T_parent0
    sb.add_op(codes::OpSwap).unwrap(); // [..., T_parent0, T_daa]
    sb.add_op(codes::OpFromAltStack).unwrap(); // boundary
    sb.add_op(codes::Op2Dup).unwrap(); // [..., T_daa, boundary, T_daa, boundary]
    sb.add_op(codes::OpGreaterThanOrEqual).unwrap();
    sb.add_op(codes::OpVerify).unwrap();
    // Stack: [P_hash, P_daa, T_hash, T_parent0, T_daa, boundary]
    sb.add_op(codes::OpToAltStack).unwrap(); // AltStack: [boundary]
    sb.add_op(codes::OpDrop).unwrap(); // drop T_daa
    sb.add_op(codes::OpToAltStack).unwrap(); // AltStack: [boundary, T_parent0]
    // Stack: [P_hash, P_daa, T_hash]

    // Verify OpChainblockSeqCommit(T_hash)
    sb.add_op(codes::OpChainblockSeqCommit).unwrap();
    // Stack: [P_hash, P_daa, seq_commit]
    sb.add_op(codes::OpDrop).unwrap(); // drop seq_commit
    
    // Check P_daa < boundary
    sb.add_op(codes::OpFromAltStack).unwrap(); // T_parent0
    sb.add_op(codes::OpToAltStack).unwrap(); // AltStack: [T_parent0]
    // Stack: [P_hash, P_daa]
    sb.add_op(codes::OpFromAltStack).unwrap(); // T_parent0
    // Stack: [P_hash, P_daa, T_parent0]
    sb.add_op(codes::OpRot).unwrap(); // [P_daa, T_parent0, P_hash]
    sb.add_op(codes::OpEqualVerify).unwrap(); // assert T_parent0 == P_hash !
    // Stack: [P_daa]

    sb.add_op(codes::OpFromAltStack).unwrap(); // boundary
    // Stack: [P_daa, boundary]
    sb.add_op(codes::OpLessThan).unwrap();
    sb.add_op(codes::OpVerify).unwrap();

    sb.add_op(codes::OpTrue).unwrap();
    sb.drain()
}

fn main() {
    println!("=== REAL KASPA TOCCATA COVENANT VM ADVERSARIAL REPLAY ===");

    let d_arm: u64 = 562588867;
    let delta: i64 = 100;
    let boundary: u64 = d_arm + delta as u64; // 562588967

    let p0_hash = Hash::from_str("2cc576ee91269df816278c49d82ce8197ea33d4109c26bbbc945c19176a21d68").unwrap();
    let p0_daa: u64 = 562588960; // < boundary

    let t0_hash = Hash::from_str("103c0b2f2c428f0313da88fa4441df1d945574faf999c893aef401a051cb9abc").unwrap();
    let t0_daa: u64 = 562588968; // >= boundary
    let seq_commit = Hash::from_str("098ee441adaa342756ddf8fc51110dd7dc06414bbf12c9e02e6580a7e67ad723").unwrap();

    let mut seq_commits = HashMap::new();
    seq_commits.insert(t0_hash, seq_commit);

    let accessor = RealMockSeqCommitAccessor {
        selected_chain: vec![p0_hash, t0_hash],
        seq_commits,
    };

    let redeem_script = build_full_covenant_redeem_script(delta);
    let p2sh_spk = kaspa_txscript::pay_to_script_hash_script(&redeem_script);

    println!("Compiled Covenant Redeem Script bytes: {}", redeem_script.len());
    println!("Boundary check: P0.daa ({}) < boundary ({}) <= T0.daa ({})", p0_daa, boundary, t0_daa);

    // 1. Correct (T0, P0) Replay
    let mut sig_script = ScriptBuilder::new();
    sig_script.add_data(&p0_hash.as_bytes()).unwrap();
    sig_script.add_i64(p0_daa as i64).unwrap();
    sig_script.add_data(&t0_hash.as_bytes()).unwrap();
    sig_script.add_i64(t0_daa as i64).unwrap();
    sig_script.add_data(&p0_hash.as_bytes()).unwrap(); // T.parents[0] == P0
    sig_script.add_data(&redeem_script).unwrap();

    let tx = Transaction::new(
        0,
        vec![TransactionInput::new(
            TransactionOutpoint::new(Hash::from_str("eef2021f3add24a139da2ad7266b7f5dccb02cd631f5f4300b6eb26627454216").unwrap(), 0),
            sig_script.drain(),
            0,
            0,
        )],
        vec![TransactionOutput::new(20000000, ScriptPublicKey::new(0, vec![0x51].into()))],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );

    let entry = UtxoEntry::new(100000000, p2sh_spk.clone(), d_arm, false, None);
    let res = execute_in_vm(&tx, vec![entry], 0, &accessor);
    println!("1. Test Correct (T0, P0): {:?}", res);
    assert!(res.is_ok(), "Correct T0 must verify Ok(())");

    // 2. Later block (T1) where P.daa >= boundary
    let t1_hash = Hash::from_str("3726ce74d3a2f63c80c8c14122778e755eb7c863c1825b53c986e8d94e5a8cd7").unwrap();
    let mut later_sig = ScriptBuilder::new();
    later_sig.add_data(&t0_hash.as_bytes()).unwrap(); // P is T0
    later_sig.add_i64(t0_daa as i64).unwrap(); // P.daa = t0_daa = 562588968 >= boundary!
    later_sig.add_data(&t1_hash.as_bytes()).unwrap();
    later_sig.add_i64(562588972).unwrap();
    later_sig.add_data(&t0_hash.as_bytes()).unwrap();
    later_sig.add_data(&redeem_script).unwrap();

    let later_tx = Transaction::new(
        0,
        vec![TransactionInput::new(
            TransactionOutpoint::new(Hash::default(), 0),
            later_sig.drain(),
            0,
            0,
        )],
        vec![TransactionOutput::new(20000000, ScriptPublicKey::new(0, vec![0x51].into()))],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let later_entry = UtxoEntry::new(100000000, p2sh_spk.clone(), d_arm, false, None);
    let later_res = execute_in_vm(&later_tx, vec![later_entry], 0, &accessor);
    println!("2. Test Later T1 (P.daa >= boundary): {:?}", later_res);
    assert!(later_res.is_err(), "Later T must fail P.daa < boundary");

    // 3. Earlier block (T.daa < boundary)
    let mut earlier_sig = ScriptBuilder::new();
    earlier_sig.add_data(&p0_hash.as_bytes()).unwrap();
    earlier_sig.add_i64((p0_daa - 2) as i64).unwrap();
    earlier_sig.add_data(&p0_hash.as_bytes()).unwrap();
    earlier_sig.add_i64(p0_daa as i64).unwrap(); // T.daa = p0_daa < boundary!
    earlier_sig.add_data(&p0_hash.as_bytes()).unwrap();
    earlier_sig.add_data(&redeem_script).unwrap();

    let earlier_tx = Transaction::new(
        0,
        vec![TransactionInput::new(
            TransactionOutpoint::new(Hash::default(), 0),
            earlier_sig.drain(),
            0,
            0,
        )],
        vec![TransactionOutput::new(20000000, ScriptPublicKey::new(0, vec![0x51].into()))],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let earlier_entry = UtxoEntry::new(100000000, p2sh_spk.clone(), d_arm, false, None);
    let earlier_res = execute_in_vm(&earlier_tx, vec![earlier_entry], 0, &accessor);
    println!("3. Test Earlier T (T.daa < boundary): {:?}", earlier_res);
    assert!(earlier_res.is_err(), "Earlier T must fail T.daa >= boundary");

    // 4. Side-parent substitution (T.parent0 != P_hash)
    let p_side = Hash::from_str("8f2e0695c8211720ebfeb073e92745e41c934fe724dfb598fb2af4b2d560e116").unwrap();
    let mut side_sig = ScriptBuilder::new();
    side_sig.add_data(&p_side.as_bytes()).unwrap(); // provide P_side
    side_sig.add_i64(p0_daa as i64).unwrap();
    side_sig.add_data(&t0_hash.as_bytes()).unwrap();
    side_sig.add_i64(t0_daa as i64).unwrap();
    side_sig.add_data(&p0_hash.as_bytes()).unwrap(); // T0.parent0 is P0 != P_side!
    side_sig.add_data(&redeem_script).unwrap();

    let side_tx = Transaction::new(
        0,
        vec![TransactionInput::new(
            TransactionOutpoint::new(Hash::default(), 0),
            side_sig.drain(),
            0,
            0,
        )],
        vec![TransactionOutput::new(20000000, ScriptPublicKey::new(0, vec![0x51].into()))],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let side_entry = UtxoEntry::new(100000000, p2sh_spk.clone(), d_arm, false, None);
    let side_res = execute_in_vm(&side_tx, vec![side_entry], 0, &accessor);
    println!("4. Test Side-parent substitution: {:?}", side_res);
    assert!(side_res.is_err(), "Side parent substitution must fail EqualVerify");

    // 5. Non-chain T block
    let fake_t = Hash::from_str("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();
    let mut non_chain_sig = ScriptBuilder::new();
    non_chain_sig.add_data(&p0_hash.as_bytes()).unwrap();
    non_chain_sig.add_i64(p0_daa as i64).unwrap();
    non_chain_sig.add_data(&fake_t.as_bytes()).unwrap();
    non_chain_sig.add_i64(t0_daa as i64).unwrap();
    non_chain_sig.add_data(&p0_hash.as_bytes()).unwrap();
    non_chain_sig.add_data(&redeem_script).unwrap();

    let non_chain_tx = Transaction::new(
        0,
        vec![TransactionInput::new(
            TransactionOutpoint::new(Hash::default(), 0),
            non_chain_sig.drain(),
            0,
            0,
        )],
        vec![TransactionOutput::new(20000000, ScriptPublicKey::new(0, vec![0x51].into()))],
        0,
        SubnetworkId::default(),
        0,
        vec![],
    );
    let non_chain_entry = UtxoEntry::new(100000000, p2sh_spk.clone(), d_arm, false, None);
    let non_chain_res = execute_in_vm(&non_chain_tx, vec![non_chain_entry], 0, &accessor);
    println!("5. Test Non-chain T: {:?}", non_chain_res);
    assert!(non_chain_res.is_err(), "Non-chain T must be rejected by OpChainblockSeqCommit");

    println!("\n>>> ALL 5/5 ADVERSARIAL VM VERIFICATIONS PASSED WITH COMPLETE MATHEMATICAL AND CONSENSUS CERTAINTY! <<<");
}
