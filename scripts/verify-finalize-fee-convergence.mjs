import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  ScriptBuilder,
  ScriptPublicKey,
  Transaction,
  TransactionOutput,
  addressFromScriptPublicKey,
  calculateTransactionFee,
  calculateTransactionMass,
  initSync,
  payToScriptHashScript
} from "@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const requireFromScript = createRequire(import.meta.url);
const kaspaDirectory = path.dirname(requireFromScript.resolve("@onekeyfe/kaspa-wasm/kaspa.js"));
initSync({ module: fs.readFileSync(path.join(kaspaDirectory, "kaspa_bg.wasm.bin")) });

const artifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-vnext.artifact.json"), "utf8"));
const redeem = new Uint8Array(Buffer.from(artifact.script, "hex"));
const covenantScript = payToScriptHashScript(redeem);
const covenantAddress = addressFromScriptPublicKey(covenantScript, "testnet-10")?.toString();
const winnerScript = new ScriptPublicKey(0, `20${"11".repeat(32)}ac`);
const creatorScript = new ScriptPublicKey(0, `20${"22".repeat(32)}ac`);

function signatureScript(fee) {
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  // The finalized vNext witness carries two headers, a 20-level proof, and
  // the 6.2 kB state-bound covenant script. Its lengths match the live flow.
  builder.addData(new Uint8Array(220));
  builder.addI64(520_235_731n); builder.addI64(520_235_731n); builder.addData(new Uint8Array(32)); builder.addData(new Uint8Array(32));
  builder.addData(new Uint8Array(32)); builder.addData(new Uint8Array(220));
  builder.addI64(520_235_730n); builder.addI64(520_235_730n); builder.addData(new Uint8Array(32)); builder.addData(new Uint8Array(32));
  builder.addI64(fee); builder.addI64(0n); builder.addI64(0n); builder.addI64(0n); builder.addI64(1n);
  builder.addData(new Uint8Array(32)); builder.addData(new Uint8Array(640));
  builder.addI64(1n); builder.addData(redeem);
  return Buffer.from(builder.drain()).toString("hex");
}

function measuredFinalize(carrier, prize, fee) {
  const signature = signatureScript(fee);
  const tx = new Transaction({
    version: 1,
    inputs: [{
      previousOutpoint: { transactionId: "33".repeat(32), index: 0 }, signatureScript: signature,
      sequence: 0n, sigOpCount: 0, computeBudget: 200,
      utxo: { address: covenantAddress, outpoint: { transactionId: "33".repeat(32), index: 0 }, amount: prize + carrier, scriptPublicKey: covenantScript, blockDaaScore: 520_235_000n, isCoinbase: false }
    }],
    outputs: [new TransactionOutput(prize, winnerScript), new TransactionOutput(carrier - fee, creatorScript)],
    lockTime: 520_235_731n, subnetworkId: "00".repeat(20), gas: 0n, payload: "", mass: 0n, storageMass: 0n
  });
  return { fee: calculateTransactionFee("testnet-10", tx, 0), mass: calculateTransactionMass("testnet-10", tx, 0) };
}

function converge(carrier, prize) {
  let supplied = 0n;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const measured = measuredFinalize(carrier, prize, supplied);
    if (measured.fee === undefined) return { converged: false, reason: "mass-limit", attempt, mass: measured.mass };
    if (measured.fee <= supplied) return { converged: true, attempt, supplied, mass: measured.mass };
    supplied = measured.fee;
  }
  return { converged: false, reason: "iteration-limit" };
}

const currentRoundPrize = 150_000_000n;
const insufficientCarrier = converge(20_000_000n, currentRoundPrize);
assert.deepEqual(
  { converged: insufficientCarrier.converged, reason: insufficientCarrier.reason },
  { converged: false, reason: "mass-limit" },
  "a 0.2 KAS carrier cannot produce a relay-standard vNext finalize for a 1.5 KAS prize"
);

const legacySizedCarrier = converge(57_300_000n, currentRoundPrize);
assert.equal(legacySizedCarrier.converged, true, "the historical 0.573 KAS carrier can converge for this vNext settlement shape");

const defaultMinimumPrize = converge(57_300_000n, 30_000_000n);
assert.equal(defaultMinimumPrize.converged, true, "the 0.573 KAS carrier can also finalize the default 0.3 KAS minimum prize");

const safeCarrier = converge(100_000_000n, currentRoundPrize);
assert.equal(safeCarrier.converged, true, "a 1 KAS settlement carrier converges");
assert.ok(safeCarrier.mass <= 100_000n, "the converged finalize remains relay-standard");
assert.ok(safeCarrier.attempt < 8, "the safe carrier converges well within the production bound");
console.log(`PASS finalize fee convergence: 0.2 KAS reaches mass ${insufficientCarrier.mass}; 0.573 KAS converges at ${legacySizedCarrier.supplied} sompi (mass ${legacySizedCarrier.mass}) for 1.5 KAS and ${defaultMinimumPrize.supplied} sompi (mass ${defaultMinimumPrize.mass}) for 0.3 KAS; 1 KAS converges at ${safeCarrier.supplied} sompi (mass ${safeCarrier.mass}).`);
