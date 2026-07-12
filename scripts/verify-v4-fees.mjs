import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  CovenantBinding,
  GenesisCovenantGroup,
  Hash,
  PrivateKey,
  ScriptBuilder,
  Transaction,
  TransactionOutput,
  initSync,
  payToAddressScript,
  payToScriptHashScript
} from "../node_modules/@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const artifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v4.artifact.json"), "utf8"));
const wasm = fs.readFileSync(path.join(root, "node_modules/@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin"));
initSync({ module: wasm });

const NETWORK = "testnet-10";
const MAX_TICKETS = 1_000_000;
const TICKET_PRICE = 30_000_000n;
const CARRIER = 20_000_000n;
const ZERO_SUBNETWORK_ID = "00".repeat(20);
const STORAGE_MASS_PARAMETER = 1_000_000_000_000n;
const MASS_LIMITS = { storage: 500_000, compute: 500_000, transient: 1_000_000 };
const BUDGETS = { buy: 7, finalize: 18, auth: 11, refund: 7 };

const privateKeys = [1, 2, 3].map((value) => new PrivateKey(value.toString(16).padStart(64, "0")));
const addresses = privateKeys.map((key) => key.toAddress(NETWORK));
const addressScripts = addresses.map(payToAddressScript);
const publicKeys = addressScripts.map((script) => new Uint8Array(Buffer.from(script.toJSON().script, "hex").subarray(1, 33)));

function hash(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function pair(left, right) {
  return hash(Buffer.concat([left, right]));
}

const emptyNodes = [Buffer.alloc(32)];
for (let level = 1; level < 20; level += 1) emptyNodes.push(pair(emptyNodes[level - 1], emptyNodes[level - 1]));
const emptyNodeTable = Buffer.concat(emptyNodes);
const emptyRoot = pair(emptyNodes[19], emptyNodes[19]);
const firstLeaf = hash(publicKeys[0]);
const secondLeaf = hash(publicKeys[1]);
const firstFrontier = Buffer.alloc(640);
firstLeaf.copy(firstFrontier, 0);
let firstRoot = firstLeaf;
for (let level = 0; level < 20; level += 1) firstRoot = pair(firstRoot, emptyNodes[level]);
const secondFrontier = Buffer.from(firstFrontier);
const firstPair = pair(firstLeaf, secondLeaf);
firstPair.copy(secondFrontier, 32);
let secondRoot = firstPair;
for (let level = 1; level < 20; level += 1) secondRoot = pair(secondRoot, emptyNodes[level]);
const firstProof = Buffer.concat([secondLeaf, ...emptyNodes.slice(1)]);
const secondProof = Buffer.concat([firstLeaf, ...emptyNodes.slice(1)]);

function i64(value) {
  const encoded = new Uint8Array(8);
  let remaining = value < 0n ? -value : value;
  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (value < 0n) encoded[7] |= 0x80;
  return encoded;
}

function pushData(bytes) {
  if (bytes.length <= 75) return new Uint8Array([bytes.length, ...bytes]);
  if (bytes.length <= 0xff) return new Uint8Array([0x4c, bytes.length, ...bytes]);
  if (bytes.length <= 0xffff) return new Uint8Array([0x4d, bytes.length & 0xff, bytes.length >> 8, ...bytes]);
  throw new Error(`State value is too large: ${bytes.length} bytes.`);
}

function fixedByteLength(type) {
  const match = /^byte\[(\d+)]$/.exec(type);
  return match ? Number(match[1]) : null;
}

function stateScript({ soldTickets, ticketRoot, frontier, refundCursor = 0 }) {
  const values = {
    max_tickets: BigInt(MAX_TICKETS),
    ticket_price: TICKET_PRICE,
    creator_pubkey: publicKeys[0],
    oracle_pubkey: publicKeys[2],
    refund_after_daa: 1n,
    sold_tickets: BigInt(soldTickets),
    ticket_root: ticketRoot,
    frontier,
    refund_cursor: BigInt(refundCursor)
  };
  const chunks = artifact.stateFields.map((field) => {
    if (field.type === "int") return pushData(i64(values[field.name]));
    const expected = fixedByteLength(field.type);
    const value = new Uint8Array(values[field.name]);
    if (expected === null || value.length !== expected) throw new Error(`Invalid ${field.name} state value.`);
    return pushData(value);
  });
  const state = Buffer.concat(chunks.map(Buffer.from));
  if (state.length !== artifact.stateLayout.len) throw new Error(`State is ${state.length}, expected ${artifact.stateLayout.len}.`);
  const script = Buffer.from(artifact.script, "hex");
  state.copy(script, artifact.stateLayout.start);
  return new Uint8Array(script);
}

const states = {
  empty: stateScript({ soldTickets: 0, ticketRoot: emptyRoot, frontier: Buffer.alloc(640) }),
  one: stateScript({ soldTickets: 1, ticketRoot: firstRoot, frontier: firstFrontier }),
  two: stateScript({ soldTickets: 2, ticketRoot: secondRoot, frontier: secondFrontier }),
  twoAfterRefund: stateScript({ soldTickets: 2, ticketRoot: secondRoot, frontier: secondFrontier, refundCursor: 1 })
};

function entrypointScript(name, redeemScript, addArgs) {
  const entry = artifact.abi.find((candidate) => candidate.name === name);
  if (!entry || entry.selector === null) throw new Error(`Missing ${name} ABI selector.`);
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  addArgs?.(builder);
  if (!artifact.withoutSelector) builder.addI64(BigInt(entry.selector));
  builder.addData(redeemScript);
  return builder.drain();
}

function utxo(index, amount, scriptPublicKey, address, covenantId) {
  return {
    address,
    outpoint: { transactionId: (index + 1).toString(16).padStart(2, "0").repeat(32), index: 0 },
    amount,
    scriptPublicKey,
    blockDaaScore: 1n,
    isCoinbase: false,
    ...(covenantId ? { covenantId: new Hash(covenantId) } : {})
  };
}

function input(entry, signatureScript, computeBudget = 0) {
  return {
    previousOutpoint: entry.outpoint,
    signatureScript,
    sequence: 0n,
    sigOpCount: 0,
    computeBudget,
    utxo: entry
  };
}

function payload(type, extra = {}) {
  return Buffer.from(JSON.stringify({
    app: "kaspa-raffle-static",
    type,
    version: "0.2.0-v4",
    roundId: "11".repeat(32),
    createdAt: "2026-12-31T23:59:59.999Z",
    ...extra
  })).toString("hex");
}

function tx(inputs, outputs, type, extra = {}, lockTime = 0n) {
  return new Transaction({
    version: 1,
    inputs,
    outputs,
    lockTime,
    subnetworkId: ZERO_SUBNETWORK_ID,
    gas: 0n,
    payload: payload(type, extra)
  });
}

function covenantOutput(amount, redeem, covenantId, authorizingInput = 0) {
  const output = new TransactionOutput(amount, payToScriptHashScript(redeem));
  output.covenant = new CovenantBinding(authorizingInput, new Hash(covenantId));
  return output;
}

function buildCreate() {
  const lowCostRedeem = new Uint8Array([0x51]);
  const staging = utxo(0, CARRIER + 200_000n, payToScriptHashScript(lowCostRedeem));
  const builder = new ScriptBuilder();
  builder.addData(lowCostRedeem);
  const transaction = tx(
    [input(staging, builder.drain())],
    [new TransactionOutput(CARRIER, payToScriptHashScript(states.empty))],
    "round-create",
    { ticketPrice: TICKET_PRICE.toString(), maxTickets: MAX_TICKETS }
  );
  transaction.populateGenesisCovenants([new GenesisCovenantGroup(0, [0])]);
  return transaction;
}

function buildBuy() {
  const covenantId = "aa".repeat(32);
  const covenant = utxo(1, CARRIER, payToScriptHashScript(states.empty), undefined, covenantId);
  const fundingRedeem = new Uint8Array([0x51]);
  const funding = utxo(2, TICKET_PRICE + 2_000_000n, payToScriptHashScript(fundingRedeem));
  const buyScript = entrypointScript("buy", states.empty, (builder) => builder.addData(publicKeys[0]));
  const fundingBuilder = new ScriptBuilder();
  fundingBuilder.addData(fundingRedeem);
  return tx(
    [input(covenant, buyScript, BUDGETS.buy), input(funding, fundingBuilder.drain())],
    [covenantOutput(CARRIER + TICKET_PRICE, states.one, covenantId)],
    "ticket",
    { ticketId: 0, buyer: addresses[0].toString(), buyerPubkey: Buffer.from(publicKeys[0]).toString("hex"), paidAmount: TICKET_PRICE.toString() }
  );
}

function buildFinalize() {
  const covenantId = "aa".repeat(32);
  const covenant = utxo(3, CARRIER + TICKET_PRICE * 2n, payToScriptHashScript(states.two), undefined, covenantId);
  const authAmount = 5_000_000n;
  const auth = utxo(4, authAmount, addressScripts[0], addresses[0]);
  const script = entrypointScript("finalize", states.two, (builder) => {
    builder.addData(new Uint8Array(64).fill(0x33));
    builder.addData(new Uint8Array(32).fill(0x44));
    builder.addI64(1n);
    builder.addData(publicKeys[1]);
    builder.addData(secondProof);
    builder.addI64(0n);
    builder.addData(publicKeys[0]);
    builder.addData(firstProof);
  });
  return tx(
    [input(covenant, script, BUDGETS.finalize), input(auth, "00".repeat(66), BUDGETS.auth)],
    [
      new TransactionOutput(TICKET_PRICE * 2n, addressScripts[1]),
      new TransactionOutput(CARRIER - 2_200_000n, addressScripts[0]),
      new TransactionOutput(authAmount, addressScripts[0])
    ],
    "round-finalize",
    { winnerTicketId: 1, winnerAddress: addresses[1].toString(), amount: (TICKET_PRICE * 2n).toString(), oracleSignature: "33".repeat(64) },
    1n
  );
}

function buildContinuingRefund() {
  const covenantId = "aa".repeat(32);
  const covenant = utxo(5, CARRIER + TICKET_PRICE * 2n, payToScriptHashScript(states.two), undefined, covenantId);
  const script = entrypointScript("refundNext", states.two, (builder) => {
    builder.addI64(0n);
    builder.addData(publicKeys[0]);
    builder.addData(firstProof);
  });
  return tx(
    [input(covenant, script, BUDGETS.refund)],
    [
      covenantOutput(CARRIER + TICKET_PRICE, states.twoAfterRefund, covenantId),
      new TransactionOutput(TICKET_PRICE - 1_900_000n, addressScripts[0])
    ],
    "round-refund-ticket",
    { ticketId: 0, owner: addresses[0].toString(), amount: (TICKET_PRICE - 1_900_000n).toString() },
    1n
  );
}

function buildLastRefund() {
  const covenantId = "aa".repeat(32);
  const covenant = utxo(6, CARRIER + TICKET_PRICE, payToScriptHashScript(states.one), undefined, covenantId);
  const script = entrypointScript("refundNext", states.one, (builder) => {
    builder.addI64(0n);
    builder.addData(publicKeys[0]);
    builder.addData(Buffer.concat(emptyNodes));
  });
  return tx(
    [input(covenant, script, BUDGETS.refund)],
    [
      new TransactionOutput(TICKET_PRICE - 1_900_000n, addressScripts[0]),
      new TransactionOutput(CARRIER, addressScripts[0])
    ],
    "round-refund-ticket",
    { ticketId: 0, owner: addresses[0].toString(), amount: (TICKET_PRICE - 1_900_000n).toString() },
    1n
  );
}

function plurality(scriptByteLength, hasCovenant) {
  return Math.ceil((63 + scriptByteLength + (hasCovenant ? 32 : 0)) / 100);
}

function storageMass(inputs, outputs) {
  const outputPlurality = outputs.reduce((total, output) => total + output.plurality, 0);
  const harmonicOutputs = outputs.reduce((total, output) => total + STORAGE_MASS_PARAMETER * BigInt(output.plurality ** 2) / output.amount, 0n);
  const inputPlurality = inputs.reduce((total, value) => total + value.plurality, 0);
  const relaxed = outputPlurality === 1 || inputPlurality === 1 || (outputPlurality === 2 && inputPlurality === 2);
  if (relaxed) {
    const harmonicInputs = inputs.reduce((total, value) => total + STORAGE_MASS_PARAMETER * BigInt(value.plurality ** 2) / value.amount, 0n);
    return Number(harmonicOutputs > harmonicInputs ? harmonicOutputs - harmonicInputs : 0n);
  }
  const inputAmount = inputs.reduce((total, value) => total + value.amount, 0n);
  const arithmeticInputs = BigInt(inputPlurality) * (STORAGE_MASS_PARAMETER / (inputAmount / BigInt(inputPlurality) || 1n));
  return Number(harmonicOutputs > arithmeticInputs ? harmonicOutputs - arithmeticInputs : 0n);
}

function toccataMass(transaction) {
  const value = JSON.parse(transaction.serializeToSafeJSON());
  const inputSizes = value.inputs.map((txInput) => 36 + 8 + txInput.signatureScript.length / 2 + 8 + 2);
  const outputSizes = value.outputs.map((output) => 8 + 2 + 8 + output.scriptPublicKey.slice(4).length / 2 + (output.covenant ? 34 : 0));
  const size = 2 + 8 + inputSizes.reduce((sum, item) => sum + item, 0) + 8 + outputSizes.reduce((sum, item) => sum + item, 0) +
    8 + 20 + 8 + 32 + 8 + value.payload.length / 2;
  const outputScriptMass = value.outputs.reduce((sum, output) => sum + (2 + output.scriptPublicKey.slice(4).length / 2) * 10, 0);
  const computeMass = size + outputScriptMass + value.inputs.reduce((sum, txInput) => sum + (txInput.computeBudget ?? 0) * 100, 0);
  const transientMass = size * 4;
  const normalizedTransientMass = Math.ceil(transientMass * 0.5);
  const inputCells = value.inputs.map((txInput) => ({
    amount: BigInt(txInput.utxo.amount),
    plurality: plurality(txInput.utxo.scriptPublicKey.slice(4).length / 2, Boolean(txInput.utxo.covenantId))
  }));
  const outputCells = value.outputs.map((output) => ({
    amount: BigInt(output.value),
    plurality: plurality(output.scriptPublicKey.slice(4).length / 2, Boolean(output.covenant))
  }));
  const persistentStorageMass = storageMass(inputCells, outputCells);
  const feeMass = Math.max(computeMass, normalizedTransientMass);
  return {
    bytes: size,
    computeMass,
    transientMass,
    storageMass: persistentStorageMass,
    feeMass,
    requiredFee: BigInt(feeMass) * 100n,
    standard: computeMass <= MASS_LIMITS.compute && transientMass <= MASS_LIMITS.transient && persistentStorageMass <= MASS_LIMITS.storage
  };
}

function roundedFee(requiredFee) {
  const quantum = 100_000n;
  return ((requiredFee + quantum - 1n) / quantum + 1n) * quantum;
}

const cases = [
  ["create", buildCreate()],
  ["buy-one-ticket", buildBuy()],
  ["finalize-two-proofs", buildFinalize()],
  ["refund-with-successor", buildContinuingRefund()],
  ["refund-last-ticket", buildLastRefund()]
];

let failed = false;
console.log("V4 Toccata v1 exact transaction mass");
console.log("case                         bytes compute transient storage required KAS recommended KAS result");
for (const [name, transaction] of cases) {
  const mass = toccataMass(transaction);
  failed ||= !mass.standard;
  console.log(
    `${name.padEnd(28)} ${String(mass.bytes).padStart(5)} ${String(mass.computeMass).padStart(7)} ${String(mass.transientMass).padStart(9)} ` +
    `${String(mass.storageMass).padStart(7)} ${(Number(mass.requiredFee) / 1e8).toFixed(6).padStart(12)} ` +
    `${(Number(roundedFee(mass.requiredFee)) / 1e8).toFixed(6).padStart(15)} ${mass.standard ? "PASS" : "NON-STANDARD"}`
  );
}
if (failed) process.exitCode = 1;
