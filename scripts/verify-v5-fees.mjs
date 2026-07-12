import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CovenantBinding, Hash, PrivateKey, ScriptBuilder, Transaction, TransactionOutput,
  initSync, payToAddressScript, payToScriptHashScript
} from "../node_modules/@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const roundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v5.artifact.json"), "utf8"));
const refundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-v1.artifact.json"), "utf8"));
initSync({ module: fs.readFileSync(path.join(root, "node_modules/@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin")) });

const NETWORK = "testnet-10";
const TICKET_PRICE = 30_000_000n;
const CARRIER = 20_000_000n;
const TRANSITION_FEE = 2_230_000n;
const BATCH_FEE_PER_TICKET = 150_000n;
const SINGLE_FEE = 1_900_000n;
const STORAGE_MASS_PARAMETER = 1_000_000_000_000n;
const MASS_LIMITS = { storage: 500_000, compute: 500_000, transient: 1_000_000 };
const BUDGETS = { finalize: 36, auth: 11, transition: 4, batch: 5, single: 4 };
const ZERO_SUBNETWORK_ID = "00".repeat(20);
const key = new PrivateKey("01".padStart(64, "0"));
const address = key.toAddress(NETWORK);
const p2pk = payToAddressScript(address);
const pubkey = Buffer.from(p2pk.toJSON().script, "hex").subarray(1, 33);

function hash(bytes) { return createHash("sha256").update(bytes).digest(); }
function pair(left, right) { return hash(Buffer.concat([left, right])); }
const emptyNodes = [Buffer.alloc(32)];
for (let level = 1; level < 20; level += 1) emptyNodes.push(pair(emptyNodes[level - 1], emptyNodes[level - 1]));
const emptyRoot = pair(emptyNodes[19], emptyNodes[19]);
const leaf = hash(pubkey);
const oracleSeed = Buffer.alloc(32, 0x11);
const oracleSeed2 = Buffer.alloc(32, 0x22);
const oracleSeed3 = Buffer.alloc(32, 0x33);

function tree(count) {
  let nodes = Array.from({ length: count }, () => leaf);
  const levels = [nodes];
  for (let level = 0; level < 20; level += 1) {
    const parents = [];
    for (let index = 0; index < nodes.length; index += 2) parents.push(pair(nodes[index], nodes[index + 1] ?? emptyNodes[level]));
    nodes = parents;
    levels.push(nodes);
  }
  return { root: nodes[0], levels };
}

function rangeProof8(value, first) {
  const proof = [];
  let pathIndex = first >> 3;
  for (let level = 3; level < 20; level += 1) {
    proof.push(value.levels[level][pathIndex ^ 1] ?? emptyNodes[level]);
    pathIndex >>= 1;
  }
  return Buffer.concat(proof);
}

function ticketProof(value, ticketId) {
  const proof = [];
  let pathIndex = ticketId;
  for (let level = 0; level < 20; level += 1) {
    proof.push(value.levels[level][pathIndex ^ 1] ?? emptyNodes[level]);
    pathIndex >>= 1;
  }
  return Buffer.concat(proof);
}

function i64(value) {
  const bytes = Buffer.alloc(8);
  let remaining = BigInt(value);
  for (let index = 0; index < 8; index += 1) { bytes[index] = Number(remaining & 0xffn); remaining >>= 8n; }
  return bytes;
}

function pushData(bytes) {
  if (bytes.length <= 75) return Buffer.from([bytes.length, ...bytes]);
  if (bytes.length <= 0xff) return Buffer.from([0x4c, bytes.length, ...bytes]);
  return Buffer.from([0x4d, bytes.length & 0xff, bytes.length >> 8, ...bytes]);
}

function materialize(artifact, values) {
  const chunks = artifact.stateFields.map((field) => {
    if (field.type === "int") return pushData(i64(values[field.name]));
    return pushData(Buffer.from(values[field.name]));
  });
  const state = Buffer.concat(chunks);
  if (state.length !== artifact.stateLayout.len) throw new Error(`${artifact.contract} state layout mismatch.`);
  const script = Buffer.from(artifact.script, "hex");
  state.copy(script, artifact.stateLayout.start);
  return script;
}

const tree10 = tree(10);
const tree11 = tree(11);
function roundRedeemFor(count, root) {
  return materialize(roundArtifact, {
    max_tickets: 1_000_000n, ticket_price: TICKET_PRICE, creator_pubkey: pubkey, oracle_pubkey: pubkey,
    oracle_pubkey_2: pubkey, oracle_pubkey_3: pubkey,
    oracle_commitment: hash(oracleSeed), oracle_commitment_2: hash(oracleSeed2), oracle_commitment_3: hash(oracleSeed3),
    refund_after_daa: 1n, sold_tickets: BigInt(count), ticket_root: root, frontier: Buffer.alloc(640), refund_cursor: 0n
  });
}
const roundRedeem = roundRedeemFor(10, tree10.root);
const roundRedeem11 = roundRedeemFor(11, tree11.root);
function refundRedeem(cursor) {
  return materialize(refundArtifact, {
    ticket_price: TICKET_PRICE, creator_pubkey: pubkey, sold_tickets: 10n, ticket_root: tree10.root, refund_cursor: BigInt(cursor)
  });
}
const refund0 = refundRedeem(0);
const refund8 = refundRedeem(8);
const refund9 = refundRedeem(9);
const refundPrefix = Buffer.from(refundArtifact.script, "hex").subarray(0, refundArtifact.stateLayout.start);
const refundSuffix = Buffer.from(refundArtifact.script, "hex").subarray(refundArtifact.stateLayout.start + refundArtifact.stateLayout.len);

function action(artifact, name, redeem, addArgs) {
  const entry = artifact.abi.find((candidate) => candidate.name === name);
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  addArgs(builder);
  builder.addI64(BigInt(entry.selector));
  builder.addData(redeem);
  return builder.drain();
}

function utxo(index, amount, redeem, covenantId) {
  return {
    outpoint: { transactionId: (index + 1).toString(16).padStart(2, "0").repeat(32), index: 0 },
    amount, scriptPublicKey: payToScriptHashScript(redeem), blockDaaScore: 1n, isCoinbase: false,
    covenantId: new Hash(covenantId)
  };
}
function plainUtxo(index, amount, scriptPublicKey, addressValue) {
  return {
    address: addressValue,
    outpoint: { transactionId: (index + 20).toString(16).padStart(2, "0").repeat(32), index: 0 },
    amount, scriptPublicKey, blockDaaScore: 1n, isCoinbase: false
  };
}
function input(entry, signatureScript, computeBudget) {
  return { previousOutpoint: entry.outpoint, signatureScript, sequence: 0n, sigOpCount: 0, computeBudget, utxo: entry };
}
function covenantOutput(amount, redeem, covenantId) {
  const output = new TransactionOutput(amount, payToScriptHashScript(redeem));
  output.covenant = new CovenantBinding(0, new Hash(covenantId));
  return output;
}
function tx(inputs, outputs, payloadType) {
  return new Transaction({
    version: 1, inputs, outputs, lockTime: 1n, subnetworkId: ZERO_SUBNETWORK_ID, gas: 0n,
    payload: Buffer.from(JSON.stringify({ app: "kaspa-raffle-static", type: payloadType, version: "0.3.0-v5", roundId: "11".repeat(32) })).toString("hex")
  });
}

const covenantId = "aa".repeat(32);
function buyFee(ticketCount) {
  void ticketCount;
  return 1_570_000n;
}
function buyBudget(ticketCount) {
  return 8 + (ticketCount === 8 ? 2 : ticketCount >= 2 ? 1 : 0);
}
function buyTx(ticketCount) {
  const sourceRedeem = roundRedeemFor(0, emptyRoot);
  const nextRedeem = roundRedeemFor(ticketCount, tree(ticketCount).root);
  const purchase = TICKET_PRICE * BigInt(ticketCount);
  const source = utxo(10, CARRIER, sourceRedeem, covenantId);
  const fundingRedeem = Buffer.from([0x51]);
  const funding = plainUtxo(11, purchase + buyFee(ticketCount), payToScriptHashScript(fundingRedeem));
  const fundingBuilder = new ScriptBuilder();
  fundingBuilder.addData(fundingRedeem);
  const sig = action(roundArtifact, "buy", sourceRedeem, (builder) => {
    builder.addData(pubkey);
    builder.addI64(BigInt(ticketCount));
  });
  return tx(
    [input(source, sig, buyBudget(ticketCount)), input(funding, fundingBuilder.drain(), 0)],
    [covenantOutput(source.amount + purchase, nextRedeem, covenantId)],
    "ticket"
  );
}
function finalizeTx() {
  const source = utxo(12, CARRIER + TICKET_PRICE * 10n, roundRedeem, covenantId);
  const authAmount = 5_000_000n;
  const auth = plainUtxo(13, authAmount, p2pk, address);
  const proof = ticketProof(tree10, 0);
  const sig = action(roundArtifact, "finalize", roundRedeem, (builder) => {
    builder.addData(Buffer.alloc(64, 0x33)); builder.addData(oracleSeed);
    builder.addData(Buffer.alloc(64, 0x44)); builder.addData(oracleSeed2);
    builder.addData(Buffer.alloc(64, 0x55)); builder.addData(oracleSeed3);
    builder.addI64(0n); builder.addData(pubkey); builder.addData(proof);
    builder.addI64(0n); builder.addData(pubkey); builder.addData(proof);
  });
  return tx(
    [input(source, sig, BUDGETS.finalize), input(auth, "00".repeat(66), BUDGETS.auth)],
    [
      new TransactionOutput(TICKET_PRICE * 10n, p2pk),
      new TransactionOutput(CARRIER - 2_200_000n, p2pk),
      new TransactionOutput(authAmount, p2pk)
    ],
    "round-finalize"
  );
}
function transitionTx() {
  const source = utxo(0, CARRIER + TICKET_PRICE * 10n, roundRedeem, covenantId);
  const sig = action(roundArtifact, "startRefund", roundRedeem, (builder) => {
    builder.addData(refundPrefix); builder.addData(refundSuffix);
  });
  return tx([input(source, sig, BUDGETS.transition)], [covenantOutput(source.amount - TRANSITION_FEE, refund0, covenantId)], "round-refund-start");
}
function batchTx() {
  const source = utxo(1, CARRIER - TRANSITION_FEE + TICKET_PRICE * 10n, refund0, covenantId);
  const sig = action(refundArtifact, "refundBatch8", refund0, (builder) => {
    builder.addData(Buffer.concat(Array.from({ length: 8 }, () => pubkey)));
    builder.addData(rangeProof8(tree10, 0));
  });
  return tx(
    [input(source, sig, BUDGETS.batch)],
    [covenantOutput(source.amount - TICKET_PRICE * 8n, refund8, covenantId), ...Array.from({ length: 8 }, () => new TransactionOutput(TICKET_PRICE - BATCH_FEE_PER_TICKET, p2pk))],
    "round-refund-batch"
  );
}
function singleTx(last) {
  const cursor = last ? 9 : 8;
  const redeem = last ? refund9 : refund8;
  const source = utxo(last ? 3 : 2, CARRIER - TRANSITION_FEE + TICKET_PRICE * BigInt(10 - cursor), redeem, covenantId);
  const sig = action(refundArtifact, "refundNext", redeem, (builder) => {
    builder.addI64(BigInt(cursor)); builder.addData(pubkey); builder.addData(ticketProof(tree10, cursor));
  });
  const outputs = last
    ? [new TransactionOutput(TICKET_PRICE - SINGLE_FEE, p2pk), new TransactionOutput(CARRIER - TRANSITION_FEE, p2pk)]
    : [covenantOutput(source.amount - TICKET_PRICE, refund9, covenantId), new TransactionOutput(TICKET_PRICE - SINGLE_FEE, p2pk)];
  return tx([input(source, sig, BUDGETS.single)], outputs, "round-refund-ticket");
}

function plurality(scriptBytes, hasCovenant) { return Math.ceil((63 + scriptBytes + (hasCovenant ? 32 : 0)) / 100); }
function storageMass(inputs, outputs) {
  const outputPlurality = outputs.reduce((sum, item) => sum + item.plurality, 0);
  const harmonicOutputs = outputs.reduce((sum, item) => sum + STORAGE_MASS_PARAMETER * BigInt(item.plurality ** 2) / item.amount, 0n);
  const inputPlurality = inputs.reduce((sum, item) => sum + item.plurality, 0);
  const relaxed = outputPlurality === 1 || inputPlurality === 1 || (outputPlurality === 2 && inputPlurality === 2);
  if (relaxed) {
    const harmonicInputs = inputs.reduce((sum, item) => sum + STORAGE_MASS_PARAMETER * BigInt(item.plurality ** 2) / item.amount, 0n);
    return Number(harmonicOutputs > harmonicInputs ? harmonicOutputs - harmonicInputs : 0n);
  }
  const inputAmount = inputs.reduce((sum, item) => sum + item.amount, 0n);
  const arithmeticInputs = BigInt(inputPlurality) * (STORAGE_MASS_PARAMETER / (inputAmount / BigInt(inputPlurality) || 1n));
  return Number(harmonicOutputs > arithmeticInputs ? harmonicOutputs - arithmeticInputs : 0n);
}
function mass(transaction) {
  const value = JSON.parse(transaction.serializeToSafeJSON());
  const inputSizes = value.inputs.map((item) => 36 + 8 + item.signatureScript.length / 2 + 8 + 2);
  const outputSizes = value.outputs.map((item) => 8 + 2 + 8 + item.scriptPublicKey.slice(4).length / 2 + (item.covenant ? 34 : 0));
  const bytes = 2 + 8 + inputSizes.reduce((a, b) => a + b, 0) + 8 + outputSizes.reduce((a, b) => a + b, 0) + 8 + 20 + 8 + 32 + 8 + value.payload.length / 2;
  const compute = bytes + value.outputs.reduce((sum, item) => sum + (2 + item.scriptPublicKey.slice(4).length / 2) * 10, 0) + value.inputs.reduce((sum, item) => sum + item.computeBudget * 100, 0);
  const transient = bytes * 4;
  const inputs = value.inputs.map((item) => ({ amount: BigInt(item.utxo.amount), plurality: plurality(item.utxo.scriptPublicKey.slice(4).length / 2, Boolean(item.utxo.covenantId)) }));
  const outputs = value.outputs.map((item) => ({ amount: BigInt(item.value), plurality: plurality(item.scriptPublicKey.slice(4).length / 2, Boolean(item.covenant)) }));
  const storage = storageMass(inputs, outputs);
  const feeMass = Math.max(compute, Math.ceil(transient * 0.5));
  const fee = BigInt(feeMass) * 100n;
  return { bytes, compute, transient, storage, fee, standard: compute <= MASS_LIMITS.compute && transient <= MASS_LIMITS.transient && storage <= MASS_LIMITS.storage };
}

const cases = [
  ["buy-1-ticket", buyTx(1), buyFee(1)],
  ["buy-2-tickets", buyTx(2), buyFee(2)],
  ["buy-8-tickets", buyTx(8), buyFee(8)],
  ["finalize", finalizeTx(), 2_200_000n],
  ["start-refund", transitionTx(), TRANSITION_FEE],
  ["batch8-refund", batchTx(), BATCH_FEE_PER_TICKET * 8n],
  ["single-tail", singleTx(false), SINGLE_FEE],
  ["final-single-tail", singleTx(true), SINGLE_FEE]
];
let failed = false;
console.log("V5 split-refund Toccata v1 exact transaction mass");
console.log("case                 bytes compute transient storage required KAS result");
for (const [name, transaction, committedFee] of cases) {
  const value = mass(transaction);
  const passes = value.standard && committedFee >= value.fee;
  failed ||= !passes;
  console.log(`${name.padEnd(20)} ${String(value.bytes).padStart(5)} ${String(value.compute).padStart(7)} ${String(value.transient).padStart(9)} ${String(value.storage).padStart(7)} ${(Number(value.fee) / 1e8).toFixed(6).padStart(12)} ${passes ? "PASS" : "NON-STANDARD/UNDERFUNDED"}`);
}
if (failed) process.exitCode = 1;
