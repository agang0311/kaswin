import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import * as secp from "@noble/secp256k1";

const port = 18790;
const privateKey = "01".padStart(64, "0");
const masterSecret = "42".repeat(32);
const child = spawn(process.execPath, [path.resolve("oracle/raffle-oracle.mjs")], {
  env: {
    ...process.env,
    RAFFLE_ORACLE_PRIVATE_KEY: privateKey,
    RAFFLE_ORACLE_MASTER_SECRET: masterSecret,
    RAFFLE_ORACLE_PORT: String(port)
  },
  stdio: ["ignore", "ignore", "inherit"]
});

async function waitForOracle() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Oracle did not start.");
}

try {
  await waitForOracle();
  const roundId = "round-oracle-verification";
  const commitmentResponse = await fetch(`http://127.0.0.1:${port}/commitments/${roundId}`);
  const commitment = await commitmentResponse.json();
  const repeated = await (await fetch(`http://127.0.0.1:${port}/commitments/${roundId}`)).json();
  if (commitment.publicKey !== repeated.publicKey || commitment.commitment !== repeated.commitment) {
    throw new Error("Oracle commitment is not deterministic.");
  }
  const ticketRoot = "ab".repeat(32);
  const attestation = await (await fetch(
    `http://127.0.0.1:${port}/attestations/${roundId}?ticketRoot=${ticketRoot}`
  )).json();
  const seed = Buffer.from(attestation.seed, "hex");
  const expectedCommitment = createHash("sha256").update(seed).digest("hex");
  if (expectedCommitment !== commitment.commitment || attestation.commitment !== commitment.commitment) {
    throw new Error("Oracle revealed a seed outside its commitment.");
  }
  const message = createHash("sha256").update(Buffer.concat([Buffer.from(ticketRoot, "hex"), seed])).digest();
  if (!await secp.schnorr.verifyAsync(
    Buffer.from(attestation.signature, "hex"),
    message,
    Buffer.from(commitment.publicKey, "hex")
  )) {
    throw new Error("Oracle attestation signature is invalid.");
  }
  console.log(`Oracle commitment and root-bound attestation verified for ${commitment.publicKey}.`);
} finally {
  child.kill();
}
