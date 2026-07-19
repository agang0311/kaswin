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
const covenantSource = fs.readFileSync(path.join(root, "src/kaspa/covenant.ts"), "utf8");
const transactionSource = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");
assert.match(covenantSource, /buildRaffleCloseEmptySignatureScript/);
assert.match(transactionSource, /closeEmptyRaffleCovenantRound/);

function buildCloseWitness(redeem, closeFee) {
  if (closeFee <= 0n) throw new Error("closeEmpty requires a positive fee");
  const closeEntry = artifact.abi.find((entry) => entry.name === "closeEmpty");
  assert.ok(closeEntry && closeEntry.selector !== null, "compiled ABI exposes closeEmpty selector");
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  builder.addI64(closeFee);
  builder.addI64(BigInt(closeEntry.selector));
  builder.addData(redeem);
  return builder.drain();
}

{
  const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const redeem = Uint8Array.from(Buffer.from(artifact.script, "hex"));
  const closeFee = 2_000_000n;
  const carrier = 140_000_000n;

  const signatureScriptHex = buildCloseWitness(redeem, closeFee);
  assert.ok(signatureScriptHex.endsWith(Buffer.from(redeem).toString("hex")), "closeEmpty witness must commit the exact current redeem script");
  assert.throws(() => buildCloseWitness(redeem, 0n));

  const covenantScript = payToScriptHashScript(redeem);
  const covenantAddress = addressFromScriptPublicKey(covenantScript, "testnet-10")?.toString();
  assert.ok(covenantAddress, "closeEmpty covenant input must derive a testnet address");
  const creatorScript = new ScriptPublicKey(0, `20${owner}ac`);
  const tx = new Transaction({
    version: 1,
    inputs: [{
      previousOutpoint: { transactionId: "33".repeat(32), index: 0 },
      signatureScript: signatureScriptHex,
      sequence: 0n,
      sigOpCount: 0,
      computeBudget: 24,
      utxo: { address: covenantAddress, outpoint: { transactionId: "33".repeat(32), index: 0 }, amount: carrier, scriptPublicKey: covenantScript, blockDaaScore: 1_000n, isCoinbase: false }
    }],
    outputs: [new TransactionOutput(carrier - closeFee, creatorScript)],
    lockTime: 1_000n,
    subnetworkId: "00".repeat(20), gas: 0n, payload: "", mass: 0n, storageMass: 0n
  });
  assert.equal(tx.outputs.length, 1, "closeEmpty creates no successor covenant output");
  assert.equal(tx.outputs[0].value, carrier - closeFee, "closeEmpty returns carrier minus its declared fee to creator");
  assert.ok(calculateTransactionMass("testnet-10", tx, 0) > 0n, "closeEmpty full transaction shape has measurable mass");
  const minimumFee = calculateTransactionFee("testnet-10", tx, 0);
  assert.ok(minimumFee !== undefined && minimumFee > 0n && minimumFee <= 20_000_000n, "closeEmpty full shape remains inside its covenant fee cap");
  console.log(`PASS vNext public closeEmpty construction: one creator-only output, mass=${calculateTransactionMass("testnet-10", tx, 0)}, minimumFee=${minimumFee}`);
}
