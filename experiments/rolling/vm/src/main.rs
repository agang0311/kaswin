//! Runs covenant inputs of prepared transactions through the real kaspa-txscript engine.
//! Usage: kaswin-rolling-vm <cases.ndjson> <results.ndjson>   (one JSON case / result per line)
//! Offline: no node, no network, no key and no signature. Funding (P2PK) inputs are never executed.
//! This is the script engine with a covenants context, NOT consensus: it does not check relative/absolute lock maturity
//! against the DAA score, mass, storage mass, double spends or acceptance.
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};

use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::subnets::SubnetworkId;
use kaspa_consensus_core::tx::{
    CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionInput, TransactionOutpoint, TransactionOutput,
    UtxoEntry, VerifiableTransaction,
};
use kaspa_hashes::Hash;
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{EngineCtx, EngineFlags, SeqCommitAccessor, TxScriptEngine};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    expect: String,
    tx: Tx,
    utxos: Vec<Utxo>,
    execute: Vec<usize>,
    #[serde(default)]
    seq: Vec<SeqEntry>,
    /// Judge the case by the run under the transaction's committed budgets (what consensus does) instead of the unlimited run.
    #[serde(default)]
    limited: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tx {
    version: u16,
    lock_time: String,
    inputs: Vec<In>,
    outputs: Vec<Out>,
    subnetwork_id: String,
    gas: String,
    payload: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct In {
    txid: String,
    index: u32,
    sigscript: String,
    sequence: String,
    compute_budget: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    value: String,
    spk_version: u16,
    spk: String,
    covenant: Option<Cov>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cov {
    authorizing_input: u16,
    covenant_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Utxo {
    value: String,
    spk_version: u16,
    spk: String,
    daa: String,
    covenant_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeqEntry {
    block_hash: String,
    commitment: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InputResult {
    input: usize,
    ok: bool,
    error: Option<String>,
    used_script_units: u64,
    min_budget: u64,
    /// Whether the budget committed in the transaction suffices (consensus: budget * 10_000 + 9_999 >= used).
    committed_budget_ok: bool,
    /// Second run with the engine limited to the committed allowance, exactly like consensus check_scripts.
    limited_ok: bool,
    limited_error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    name: String,
    expect: String,
    matches: bool,
    context_error: Option<String>,
    inputs: Vec<InputResult>,
}

struct Accessor(HashMap<Hash, Hash>);
impl SeqCommitAccessor for Accessor {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        self.0.contains_key(&block_hash).then_some(true)
    }
    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        self.0.get(&block_hash).copied()
    }
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex length");
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).expect("hex digit")).collect()
}
fn hash(text: &str) -> Hash {
    Hash::from_bytes(unhex(text).try_into().expect("32-byte hash"))
}
fn num(text: &str) -> u64 {
    text.parse().expect("decimal u64")
}
fn spk(version: u16, hex: &str) -> ScriptPublicKey {
    ScriptPublicKey::new(version, unhex(hex).into())
}

// Consensus: allowed = compute_budget * 10_000 + 9_999 (free allowance per input).
const UNITS_PER_BUDGET: u64 = 10_000;
const FREE_UNITS: u64 = 9_999;

fn run_case(case: &Case) -> CaseResult {
    let inputs: Vec<TransactionInput> = case
        .tx
        .inputs
        .iter()
        .map(|i| {
            TransactionInput::new_with_compute_budget(
                TransactionOutpoint::new(hash(&i.txid), i.index),
                unhex(&i.sigscript),
                num(&i.sequence),
                i.compute_budget,
            )
        })
        .collect();
    let outputs: Vec<TransactionOutput> = case
        .tx
        .outputs
        .iter()
        .map(|o| TransactionOutput {
            value: num(&o.value),
            script_public_key: spk(o.spk_version, &o.spk),
            covenant: o.covenant.as_ref().map(|c| CovenantBinding { authorizing_input: c.authorizing_input, covenant_id: hash(&c.covenant_id) }),
        })
        .collect();
    let tx = Transaction::new(
        case.tx.version,
        inputs,
        outputs,
        num(&case.tx.lock_time),
        SubnetworkId::from_bytes(unhex(&case.tx.subnetwork_id).try_into().expect("20-byte subnetwork")),
        num(&case.tx.gas),
        unhex(&case.tx.payload),
    );
    let entries: Vec<UtxoEntry> = case
        .utxos
        .iter()
        .map(|u| UtxoEntry::new(num(&u.value), spk(u.spk_version, &u.spk), num(&u.daa), false, u.covenant_id.as_deref().map(hash)))
        .collect();
    let accessor = Accessor(case.seq.iter().map(|s| (hash(&s.block_hash), hash(&s.commitment))).collect());
    let populated = PopulatedTransaction::new(&tx, entries);
    let mut result = CaseResult { name: case.name.clone(), expect: case.expect.clone(), matches: false, context_error: None, inputs: vec![] };
    let cov_ctx = match CovenantsContext::from_tx(&populated) {
        Ok(ctx) => ctx,
        Err(err) => {
            // Consensus would reject the transaction before running any script.
            result.context_error = Some(format!("{err:?}"));
            result.matches = case.expect == "fail";
            return result;
        }
    };
    for &idx in &case.execute {
        let input = &tx.inputs[idx];
        let utxo = populated.utxo(idx).expect("utxo for input");
        let reused = SigHashReusedValuesUnsync::new();
        let sig_cache = Cache::new(10_000);
        // Unlimited run first: measures what the input really consumes, whatever budget the transaction committed.
        let mut vm = TxScriptEngine::from_transaction_input(
            &populated,
            input,
            idx,
            utxo,
            EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor_opt(Some(&accessor)),
            EngineFlags::default(),
        );
        let outcome = vm.execute();
        let used = vm.used_script_units().0;
        let reused_limited = SigHashReusedValuesUnsync::new();
        let mut limited_vm = TxScriptEngine::from_transaction_input_with_script_units_limit(
            &populated,
            input,
            idx,
            utxo,
            EngineCtx::new(&sig_cache).with_reused(&reused_limited).with_covenants_ctx(&cov_ctx).with_seq_commit_accessor_opt(Some(&accessor)),
            EngineFlags::default(),
            input.compute_commit.allowed_script_units(),
        );
        let limited = limited_vm.execute();
        let committed = u64::from(input.compute_commit.compute_budget().expect("v1 input carries a compute budget"));
        result.inputs.push(InputResult {
            input: idx,
            ok: outcome.is_ok(),
            error: outcome.err().map(|e| format!("{e:?}")),
            used_script_units: used,
            min_budget: used.saturating_sub(FREE_UNITS).div_ceil(UNITS_PER_BUDGET),
            committed_budget_ok: used <= committed * UNITS_PER_BUDGET + FREE_UNITS,
            limited_ok: limited.is_ok(),
            limited_error: limited.err().map(|e| format!("{e:?}")),
        });
    }
    let all_ok = result.inputs.iter().all(|r| if case.limited { r.limited_ok } else { r.ok });
    result.matches = if case.expect == "pass" { all_ok } else { !all_ok };
    result
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() == 3, "usage: kaswin-rolling-vm <cases.ndjson> <results.ndjson>");
    let reader = BufReader::new(fs::File::open(&args[1]).expect("open cases"));
    let mut writer = BufWriter::new(fs::File::create(&args[2]).expect("create results"));
    let (mut total, mut bad) = (0usize, 0usize);
    for line in reader.lines() {
        let line = line.expect("read line");
        if line.trim().is_empty() {
            continue;
        }
        let case: Case = serde_json::from_str(&line).expect("parse case");
        let result = run_case(&case);
        total += 1;
        if !result.matches {
            bad += 1;
        }
        writeln!(writer, "{}", serde_json::to_string(&result).expect("serialize")).expect("write result");
    }
    writer.flush().expect("flush");
    println!("{total} cases, {bad} did not match their expectation");
    if bad > 0 {
        std::process::exit(1);
    }
}
