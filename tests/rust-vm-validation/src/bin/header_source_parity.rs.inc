// Source parity only: rusty-kaspa cfafeb4c093fa37a303f1b9f19c58f986b870ce3
// consensus/src/processes/transaction_validator/tx_validation_in_header_context.rs
// DIRECT PUB(crate) CALL NOT EXPOSED. Not real-node acceptance evidence.
fn header_source_parity(tx: &Transaction, daa: u64, median_time: u64) -> Result<(), &'static str> {
    use kaspa_consensus_core::constants::{TX_VERSION, TX_VERSION_TOCCATA};
    let threshold = kaspa_consensus_core::constants::LOCK_TIME_THRESHOLD;
    let context = if tx.lock_time < threshold { daa } else { median_time };
    if tx.lock_time != 0 && tx.lock_time >= context && tx.inputs.iter().any(|i| i.sequence != u64::MAX) {
        return Err("NotFinalized");
    }
    let active = MAINNET_PARAMS.toccata_activation.is_active(daa);
    if (active && tx.version > TX_VERSION_TOCCATA) || (!active && tx.version != TX_VERSION) {
        return Err("UnknownTxVersion");
    }
    let max = MAINNET_PARAMS.max_signature_script_len().get(daa);
    if tx.inputs.iter().any(|i| i.signature_script.len() > max) { return Err("TooBigSignatureScript"); }
    Ok(())
}
fn header_source_parity_tests() {
    let daa = 1_000_000_000;
    let time = kaspa_consensus_core::constants::LOCK_TIME_THRESHOLD + 100;
    let mut tx = Transaction::new(1, vec![TransactionInput::new_with_mass(TransactionOutpoint::new(Hash::default(),0),vec![],0,ComputeCommit::ComputeBudget(ComputeBudget(1)))],vec![],0,SubnetworkId::default(),0,vec![]);
    assert_eq!(header_source_parity(&tx,daa,time),Ok(()));
    for lock in [daa, daa+1, time, time+1] {
        tx.lock_time=lock;
        assert_eq!(header_source_parity(&tx,daa,time),Err("NotFinalized"));
        tx.inputs[0].sequence=u64::MAX;
        assert_eq!(header_source_parity(&tx,daa,time),Ok(()));
        tx.inputs[0].sequence=0;
    }
    for lock in [daa-1,time-1] {tx.lock_time=lock;assert_eq!(header_source_parity(&tx,daa,time),Ok(()));}
    tx.lock_time=0;
    tx.version=2;assert_eq!(header_source_parity(&tx,daa,time),Err("UnknownTxVersion"));
    tx.version=0;assert_eq!(header_source_parity(&tx,daa,time),Ok(()));assert_eq!(header_source_parity(&tx,0,time),Ok(()));
    tx.version=1;assert_eq!(header_source_parity(&tx,0,time),Err("UnknownTxVersion"));
    for d in [0,daa] {
        tx.version=if d==0 {0}else{1};
        tx.inputs[0].signature_script=vec![0;MAINNET_PARAMS.max_signature_script_len().get(d)];
        assert_eq!(header_source_parity(&tx,d,time),Ok(()));
        tx.inputs[0].signature_script.push(0);
        assert_eq!(header_source_parity(&tx,d,time),Err("TooBigSignatureScript"));
    }
    println!("DIRECT PUB(crate) CALL NOT EXPOSED; SOURCE-PARITY LOCAL PASS; REAL NODE HEADER ACCEPTANCE -> TN10 validation");
}
