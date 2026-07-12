use std::{env, fs};

use anyhow::{bail, Context, Result};
use kaspa_raffle_beacon_methods::{KASPA_RAFFLE_DRAND_GUEST_ELF, KASPA_RAFFLE_DRAND_GUEST_ID};
use risc0_binfmt::Digestible;
use risc0_zkvm::{default_prover, sha, ExecutorEnv, InnerReceipt, ProverOpts};
use serde::Serialize;

#[derive(Serialize)]
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

fn digest_hex(digest: impl AsRef<[u8]>) -> String {
    hex::encode(digest)
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
    if args.len() != 4 {
        bail!("usage: kaspa-raffle-beacon-prover image-id | <round> <signature-hex> <output.json>");
    }

    let round = args[1].parse::<u64>().context("round must be an unsigned integer")?;
    let signature = hex::decode(&args[2]).context("signature must be hex")?;
    let signature: [u8; 48] = signature.try_into().map_err(|_| anyhow::anyhow!("quicknet signature must be 48 bytes"))?;
    let env = ExecutorEnv::builder().write(&round)?.write(&signature)?.build()?;
    let receipt = default_prover()
        .prove_with_opts(env, KASPA_RAFFLE_DRAND_GUEST_ELF, &ProverOpts::succinct())?
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

    let proof = ToccataR0Proof {
        round,
        randomness: hex::encode(&journal[8..]),
        claim: digest_hex(succinct.claim.digest::<sha::Impl>()),
        control_index: hex::encode(succinct.control_inclusion_proof.index.to_le_bytes()),
        control_digests: hex::encode(
            succinct.control_inclusion_proof.digests.iter().flat_map(|digest| digest.as_bytes()).copied().collect::<Vec<_>>()
        ),
        seal: hex::encode(succinct.get_seal_bytes()),
        journal_digest: digest_hex(receipt.journal.digest::<sha::Impl>()),
        image_id: hex::encode(image_id_bytes),
        control_id: digest_hex(succinct.control_id),
        hashfn: match succinct.hashfn.as_str() {
            "poseidon2" => 1,
            other => bail!("unsupported succinct receipt hash function: {other}"),
        },
    };

    fs::write(&args[3], format!("{}\n", serde_json::to_string_pretty(&proof)?))?;
    println!("wrote drand round {round} proof to {}", args[3]);
    Ok(())
}
