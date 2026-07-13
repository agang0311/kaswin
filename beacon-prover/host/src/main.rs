use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};

use anyhow::{bail, Context, Result};
use kaspa_raffle_beacon_methods::{KASPA_RAFFLE_DRAND_GUEST_ELF, KASPA_RAFFLE_DRAND_GUEST_ID};
use risc0_binfmt::Digestible;
use risc0_zkvm::{default_executor, default_prover, sha, ExecutorEnv, InnerReceipt, ProverOpts};
use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Response, Server, StatusCode};

const QUICKNET_CHAIN_HASH: &str =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToccataR0Proof {
    round: u64,
    randomness: String,
    claim: String,
    control_index: String,
    control_digests: String,
    seal: String,
    journal_digest: String,
    image_id: String,
    control_id: String,
    hashfn: u8,
}

#[derive(Deserialize)]
struct DrandBeacon {
    signature: String,
}

fn digest_hex(digest: impl AsRef<[u8]>) -> String {
    hex::encode(digest)
}

fn prove_beacon(round: u64, signature: [u8; 48]) -> Result<ToccataR0Proof> {
    let image_id_bytes = KASPA_RAFFLE_DRAND_GUEST_ID
        .iter()
        .flat_map(|word| word.to_le_bytes())
        .collect::<Vec<_>>();
    let mut env_builder = ExecutorEnv::builder();
    env_builder.write(&round)?.write_slice(&signature);
    let receipt = default_prover()
        .prove_with_opts(
            env_builder.build()?,
            KASPA_RAFFLE_DRAND_GUEST_ELF,
            &ProverOpts::succinct(),
        )?
        .receipt;
    receipt.verify(KASPA_RAFFLE_DRAND_GUEST_ID)?;

    let succinct = match &receipt.inner {
        InnerReceipt::Succinct(value) => value,
        _ => bail!("prover did not return a succinct receipt"),
    };
    let journal = &receipt.journal.bytes;
    if journal.len() != 40 || journal[..8] != round.to_le_bytes() {
        bail!("guest journal is not round_le_u64 || randomness");
    }

    Ok(ToccataR0Proof {
        round,
        randomness: hex::encode(&journal[8..]),
        claim: digest_hex(succinct.claim.digest::<sha::Impl>()),
        control_index: hex::encode(succinct.control_inclusion_proof.index.to_le_bytes()),
        control_digests: hex::encode(
            succinct
                .control_inclusion_proof
                .digests
                .iter()
                .flat_map(|digest| digest.as_bytes())
                .copied()
                .collect::<Vec<_>>(),
        ),
        seal: hex::encode(succinct.get_seal_bytes()),
        journal_digest: digest_hex(receipt.journal.digest::<sha::Impl>()),
        image_id: hex::encode(image_id_bytes),
        control_id: digest_hex(succinct.control_id),
        hashfn: match succinct.hashfn.as_str() {
            "poseidon2" => 1,
            other => bail!("unsupported succinct receipt hash function: {other}"),
        },
    })
}

fn fetch_quicknet_signature(round: u64) -> Result<[u8; 48]> {
    let url = format!("https://api.drand.sh/{QUICKNET_CHAIN_HASH}/public/{round}");
    let beacon: DrandBeacon = ureq::get(&url).call()?.into_json()?;
    let signature = hex::decode(beacon.signature).context("drand signature must be hex")?;
    signature
        .try_into()
        .map_err(|_| anyhow::anyhow!("quicknet signature must be 48 bytes"))
}

fn write_proof(path: &Path, proof: &ToccataR0Proof) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        format!("{}\n", serde_json::to_string_pretty(proof)?),
    )?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn response(body: String, status: u16) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap())
        .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
        .with_header(Header::from_bytes("Access-Control-Allow-Methods", "GET, OPTIONS").unwrap())
}

fn serve(bind: &str, cache_dir: PathBuf) -> Result<()> {
    fs::create_dir_all(&cache_dir)?;
    let server = Server::http(bind).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let in_progress = Arc::new(Mutex::new(HashSet::<u64>::new()));
    println!("serving drand RISC Zero proofs on http://{bind}");

    for request in server.incoming_requests() {
        if request.method() == &Method::Options {
            request.respond(response("{}".to_owned(), 204))?;
            continue;
        }
        let round = request
            .url()
            .strip_prefix("/proofs/")
            .and_then(|value| value.parse::<u64>().ok());
        let Some(round) = round else {
            request.respond(response(
                r#"{"error":"use GET /proofs/{round}"}"#.to_owned(),
                404,
            ))?;
            continue;
        };
        let proof_path = cache_dir.join(format!("{round}.json"));
        if proof_path.is_file() {
            request.respond(response(fs::read_to_string(proof_path)?, 200))?;
            continue;
        }

        let mut active = in_progress
            .lock()
            .map_err(|_| anyhow::anyhow!("proof job lock is poisoned"))?;
        let already_running = active.contains(&round);
        let busy_round = if already_running {
            None
        } else {
            active.iter().next().copied()
        };
        let started = !already_running && busy_round.is_none() && active.insert(round);
        drop(active);
        if let Some(busy_round) = busy_round {
            request.respond(response(
                serde_json::json!({
                    "error": format!("Proof worker is busy with drand round {busy_round}. Retry round {round} later.")
                })
                .to_string(),
                429,
            ))?;
            continue;
        }
        if started {
            let cache_dir = cache_dir.clone();
            let in_progress = Arc::clone(&in_progress);
            thread::spawn(move || {
                let result = fetch_quicknet_signature(round)
                    .and_then(|signature| prove_beacon(round, signature))
                    .and_then(|proof| {
                        write_proof(&cache_dir.join(format!("{round}.json")), &proof)
                    });
                if let Err(error) = result {
                    let _ = fs::write(
                        cache_dir.join(format!("{round}.error.txt")),
                        format!("{error:#}\n"),
                    );
                }
                if let Ok(mut active) = in_progress.lock() {
                    active.remove(&round);
                }
            });
        }
        let state = if started { "started" } else { "in progress" };
        request.respond(response(
            serde_json::json!({ "error": format!("Proof generation {state} for drand round {round}. Retry this request later.") }).to_string(),
            202
        ))?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let args = env::args().collect::<Vec<_>>();
    let image_id_bytes = KASPA_RAFFLE_DRAND_GUEST_ID
        .iter()
        .flat_map(|word| word.to_le_bytes())
        .collect::<Vec<_>>();
    if args.len() == 2 && args[1] == "image-id" {
        println!("{}", hex::encode(image_id_bytes));
        return Ok(());
    }
    if args.len() == 4 && args[1] == "serve" {
        return serve(&args[2], PathBuf::from(&args[3]));
    }
    if args.len() == 4 && args[1] == "execute" {
        let round = args[2]
            .parse::<u64>()
            .context("round must be an unsigned integer")?;
        let signature = hex::decode(&args[3]).context("signature must be hex")?;
        let signature: [u8; 48] = signature
            .try_into()
            .map_err(|_| anyhow::anyhow!("quicknet signature must be 48 bytes"))?;
        let mut env_builder = ExecutorEnv::builder();
        env_builder.write(&round)?.write_slice(&signature);
        let session =
            default_executor().execute(env_builder.build()?, KASPA_RAFFLE_DRAND_GUEST_ELF)?;
        if session.journal.bytes.len() != 40 || session.journal.bytes[..8] != round.to_le_bytes() {
            bail!("guest journal is not round_le_u64 || randomness");
        }
        println!(
            "{}",
            serde_json::json!({
                "round": round,
                "randomness": hex::encode(&session.journal.bytes[8..]),
                "cycles": session.cycles(),
                "segments": session.segments.len(),
            })
        );
        return Ok(());
    }
    if args.len() != 4 {
        bail!("usage: kaspa-raffle-beacon-prover image-id | execute <round> <signature-hex> | serve <bind> <cache-dir> | <round> <signature-hex> <output.json>");
    }

    let round = args[1]
        .parse::<u64>()
        .context("round must be an unsigned integer")?;
    let signature = hex::decode(&args[2]).context("signature must be hex")?;
    let signature: [u8; 48] = signature
        .try_into()
        .map_err(|_| anyhow::anyhow!("quicknet signature must be 48 bytes"))?;
    let proof = prove_beacon(round, signature)?;
    write_proof(Path::new(&args[3]), &proof)?;
    println!("wrote drand round {round} proof to {}", args[3]);
    Ok(())
}
