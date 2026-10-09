// Source-only harness for the pinned cfafeb4 Kaspa API. NOT compiled/run in remediation.
// Install as an integration test in the separately pinned local Rust workspace.
// Scope: SCRIPT VM only. No contextual maturity, relay, storage-mass or real SeqCommit proof.
use std::str::FromStr;
use kaspa_consensus_core::{Hash, subnets::SubnetworkId,
    tx::{Transaction, TransactionInput, TransactionOutput, TransactionOutpoint, ScriptPublicKey,
        UtxoEntry, PopulatedTransaction, CovenantBinding}, hashing::sighash::SigHashReusedValuesUnsync};
use kaspa_txscript::{TxScriptEngine, EngineCtx, EngineFlags, caches::Cache, covenants::CovenantsContext};
use serde_json::{Value, json};
struct Access { block: Hash, commit: Hash }
impl kaspa_txscript::SeqCommitAccessor for Access {
    fn is_chain_ancestor_from_pov(&self, h: Hash) -> Option<bool> { Some(h == self.block) }
    fn seq_commitment_within_depth(&self, h: Hash) -> Option<Hash> { (h == self.block).then_some(self.commit) }
}
fn bytes(s: &str) -> Vec<u8> {
    assert_eq!(s.len() % 2, 0);
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2], 16).unwrap()).collect()
}
fn num(v: &Value) -> u64 {v.as_u64().unwrap_or_else(|| v.as_str().unwrap().parse().unwrap())}
fn outpoint(v: &Value) -> TransactionOutpoint {
    TransactionOutpoint::new(Hash::from_str(v["transactionId"].as_str().unwrap()).unwrap(), u32::try_from(num(&v["index"])).unwrap())
}
fn spk(v: &Value) -> ScriptPublicKey {
    ScriptPublicKey::new(u16::try_from(num(&v["version"])).unwrap(), bytes(v["script"].as_str().unwrap()).into())
}
fn run(c: &Value) -> Value {
    let d = &c["draft"]; let t = &d["transaction"];
    let budgets: Vec<u16> = t["inputs"].as_array().unwrap().iter().map(|i| u16::try_from(num(&i["computeBudget"])).unwrap()).collect();
    let inputs = t["inputs"].as_array().unwrap().iter().map(|i| TransactionInput::new_with_compute_budget(
        outpoint(&i["previousOutpoint"]), bytes(i["signatureScript"].as_str().unwrap()), num(&i["sequence"]), u16::try_from(num(&i["computeBudget"])).unwrap())).collect();
    let outputs = t["outputs"].as_array().unwrap().iter().map(|o| {
        let mut x = TransactionOutput::new(num(&o["value"]), spk(&o["scriptPublicKey"]));
        if !o["covenant"].is_null() {x.covenant = Some(CovenantBinding {
            authorizing_input: u16::try_from(num(&o["covenant"]["authorizingInput"])).unwrap(),
            covenant_id: Hash::from_str(o["covenant"]["covenantId"].as_str().unwrap()).unwrap()});}
        x
    }).collect();
    assert_eq!(num(&t["version"]), 1); assert_eq!(num(&t["gas"]), 0);
    assert_eq!(t["subnetworkId"].as_str().unwrap(), "0000000000000000000000000000000000000000");
    let mut tx = Transaction::new(1, inputs, outputs, num(&t["lockTime"]), SubnetworkId::default(), 0, bytes(t["payload"].as_str().unwrap()));
    let entries: Vec<_> = d["inputUtxos"].as_array().unwrap().iter().map(|u| UtxoEntry::new(
        num(&u["value"]), spk(&u["spk"]), num(&u["daa"]), false,
        u["covenantId"].as_str().map(|s| Hash::from_str(s).unwrap()))).collect();
    // Public synthetic test scalar only. Never read a wallet or use a real key.
    let mut secret = [0u8; 32]; secret[31] = 1;
    let secp = secp256k1::Secp256k1::new();
    let key = secp256k1::Keypair::from_seckey_slice(&secp, &secret).unwrap();
    // Sign exactly the inputs the builder marks as wallet-authorized (GENESIS: all funding inputs incl. index 0;
    // actions: funding inputs after the covenant state input 0).
    let authorized: Vec<usize> = d["authorizedInputIndices"].as_array().unwrap().iter().map(|v| usize::try_from(num(v)).unwrap()).collect();
    for &i in &authorized {
        let h = kaspa_consensus_core::hashing::sighash::calc_schnorr_signature_hash(
            &PopulatedTransaction::new(&tx, entries.clone()), i,
            kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL, &SigHashReusedValuesUnsync::new());
        let sig = key.sign_schnorr(secp256k1::Message::from_digest_slice(&h.as_bytes()).unwrap());
        tx.inputs[i].signature_script = vec![65];
        tx.inputs[i].signature_script.extend_from_slice(sig.as_ref()); tx.inputs[i].signature_script.push(1);
    }
    tx.finalize();
    let mut result = json!({"schema":"KASWIN_SCRIPT_VM_1", "scope":"SCRIPT_VM_NOT_FULL_TRANSACTION",
        "name":c["name"], "profileId":c["profileId"], "budgets":budgets,
        "status":"ERROR", "input":null, "error":null, "units":[]});
    let pop = PopulatedTransaction::new(&tx, entries.clone());
    let cov = match CovenantsContext::from_tx(&pop) {
        Ok(c) => c, Err(_) => {result["error"] = json!("CovenantsContextError"); return result;}
    };
    let access = Access {block:Hash::from_str(c["accessor"]["blockHash"].as_str().unwrap()).unwrap(),
        commit:Hash::from_str(c["accessor"]["commit"].as_str().unwrap()).unwrap()};
    let cache = Cache::new(10000); let reused = SigHashReusedValuesUnsync::new();
    let mut units = Vec::new();
    for i in 0..tx.inputs.len() {
        let mut vm = TxScriptEngine::from_transaction_input_with_script_units_limit(&pop, &tx.inputs[i], i, &entries[i],
            EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov).with_seq_commit_accessor(&access),
            EngineFlags {covenants_enabled:true, ..Default::default()}, tx.inputs[i].compute_commit.allowed_script_units());
        let res = vm.execute(); units.push(vm.used_script_units().0);
        if let Err(e) = res {
            let full = format!("{e:?}");
            let category = full.split('(').next().unwrap();
            result["status"] = json!("REJECT"); result["input"] = json!(i);
            result["error"] = json!(category); result["detail"] = json!(full); result["units"] = json!(units);
            return result;
        }
    }
    result["status"] = json!("ACCEPT"); result["units"] = json!(units); result
}
#[test]
fn test_hardened_script_vm() {
    let input = std::fs::read_to_string(std::env::var("F3VM_CASES").expect("F3VM_CASES required")).unwrap();
    let cases: Value = serde_json::from_str(&input).unwrap();
    for c in cases.as_array().unwrap() {
        // Panic/parse/infrastructure failure exits nonzero, never a successful negative assertion.
        // libtest may have printed its test-name prefix without a newline.
        println!("\nKASWIN_VM_RESULT {}", run(c));
    }
}
