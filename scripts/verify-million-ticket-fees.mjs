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
const artifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round.artifact.json"), "utf8"));
const contractSource = fs.readFileSync(path.join(root, "src/contracts/raffle_round.sil"), "utf8");
const transactionSource = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");
const wasm = fs.readFileSync(path.join(root, "node_modules/@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin"));
initSync({ module: wasm });

const NETWORK = "testnet-10";
const MAX_TICKETS = 1_000_000;
const MAX_BATCHES = 20;
const TICKET_PRICE = 30_000_000n;
const ZERO_SUBNETWORK_ID = "00".repeat(20);
const ZERO32 = new Uint8Array(32);
const LOW_COST_REDEEM_SCRIPT = new Uint8Array([0x51]);
const STORAGE_MASS_PARAMETER = 1_000_000_000_000n;
const MASS_LIMITS = { storage: 500_000, compute: 500_000, transient: 1_000_000 };

function sourceBigInt(name) {
  const match = transactionSource.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([0-9_]+)n`));
  if (!match) throw new Error(`Missing bigint constant ${name}.`);
  return BigInt(match[1].replaceAll("_", ""));
}

function sourceNumber(name) {
  const match = transactionSource.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)`));
  if (!match) throw new Error(`Missing numeric constant ${name}.`);
  return Number(match[1].replaceAll("_", ""));
}

const fees = {
  create: sourceBigInt("COVENANT_CREATE_FEE_SOMPI"),
  buy: sourceBigInt("COVENANT_BUY_FEE_SOMPI"),
  finalize: sourceBigInt("COVENANT_FINALIZE_FEE_SOMPI"),
  refund: sourceBigInt("COVENANT_REFUND_FEE_SOMPI")
};
const carrier = sourceBigInt("DEFAULT_COVENANT_CARRIER_SOMPI");
const budgets = {
  buy: sourceNumber("RAFFLE_BUY_COMPUTE_BUDGET"),
  finalize: sourceNumber("RAFFLE_FINALIZE_COMPUTE_BUDGET"),
  auth: sourceNumber("RAFFLE_PARTICIPANT_AUTH_COMPUTE_BUDGET"),
  refund: sourceNumber("RAFFLE_REFUND_COMPUTE_BUDGET")
};

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

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

function stateScript({ soldTickets, soldBatches, batchEnds, owners }) {
  const values = Object.fromEntries(
    artifact.stateFields.map((field) => [field.name, field.type === "byte[32]" ? ZERO32 : 0n])
  );
  values.max_tickets = BigInt(MAX_TICKETS);
  values.ticket_price = TICKET_PRICE;
  values.creator_pubkey = publicKeys[0];
  values.oracle_pubkey = publicKeys[1];
  values.refund_after_daa = 1n;
  values.sold_tickets = BigInt(soldTickets);
  values.sold_batches = BigInt(soldBatches);
  values.ticket_root = soldTickets ? new Uint8Array(32).fill(0x22) : ZERO32;

  for (let index = 0; index < MAX_BATCHES; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    values[`batch_end_${suffix}`] = BigInt(batchEnds[index] ?? 0);
    values[`owner_${suffix}`] = owners[index] ?? ZERO32;
  }

  const encoded = [];
  for (const field of artifact.stateFields) {
    const value = values[field.name];
    encoded.push(field.type === "int" ? new Uint8Array([8, ...i64(value)]) : new Uint8Array([32, ...value]));
  }
  const state = Buffer.concat(encoded.map(Buffer.from));
  if (state.length !== artifact.stateLayout.len) throw new Error("Fixture state length does not match artifact.");
  const script = Buffer.from(artifact.script, "hex");
  state.copy(script, artifact.stateLayout.start);
  return new Uint8Array(script);
}

function entrypointScript(name, redeemScript, pushArgs) {
  const entry = artifact.abi.find((candidate) => candidate.name === name);
  if (!entry || entry.selector === null) throw new Error(`Missing ${name} ABI selector.`);
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  pushArgs?.(builder);
  if (!artifact.withoutSelector) builder.addI64(BigInt(entry.selector));
  builder.addData(redeemScript);
  return builder.drain();
}

function scriptPubkeyBytes(scriptPublicKey) {
  return Buffer.from(scriptPublicKey.toJSON().script, "hex");
}

function xOnlyPubkey(scriptPublicKey) {
  return new Uint8Array(scriptPubkeyBytes(scriptPublicKey).subarray(1, 33));
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

function tx(inputs, outputs, payload, lockTime = 0n) {
  return new Transaction({
    version: 1,
    inputs,
    outputs,
    lockTime,
    subnetworkId: ZERO_SUBNETWORK_ID,
    gas: 0n,
    payload: hex(new TextEncoder().encode(JSON.stringify(payload)))
  });
}

function plurality(scriptByteLength, hasCovenant) {
  return Math.ceil((63 + scriptByteLength + (hasCovenant ? 32 : 0)) / 100);
}

function storageMass(inputs, outputs) {
  const outputPlurality = outputs.reduce((total, output) => total + output.plurality, 0);
  const harmonicOutputs = outputs.reduce(
    (total, output) => total + STORAGE_MASS_PARAMETER * BigInt(output.plurality ** 2) / output.amount,
    0n
  );
  const inputPlurality = inputs.reduce((total, inputValue) => total + inputValue.plurality, 0);
  const relaxed = outputPlurality === 1 || inputPlurality === 1 || (outputPlurality === 2 && inputPlurality === 2);

  if (relaxed) {
    const harmonicInputs = inputs.reduce(
      (total, inputValue) => total + STORAGE_MASS_PARAMETER * BigInt(inputValue.plurality ** 2) / inputValue.amount,
      0n
    );
    return Number(harmonicOutputs > harmonicInputs ? harmonicOutputs - harmonicInputs : 0n);
  }

  const inputAmount = inputs.reduce((total, inputValue) => total + inputValue.amount, 0n);
  const arithmeticInputs = BigInt(inputPlurality) * (STORAGE_MASS_PARAMETER / (inputAmount / BigInt(inputPlurality) || 1n));
  return Number(harmonicOutputs > arithmeticInputs ? harmonicOutputs - arithmeticInputs : 0n);
}

function toccataMass(transaction) {
  const value = JSON.parse(transaction.serializeToSafeJSON());
  const inputSizes = value.inputs.map((txInput) => 36 + 8 + txInput.signatureScript.length / 2 + 8 + 2);
  const outputSizes = value.outputs.map((output) => {
    const scriptLength = output.scriptPublicKey.slice(4).length / 2;
    return 8 + 2 + 8 + scriptLength + (output.covenant ? 34 : 0);
  });
  const size = 2 + 8 + inputSizes.reduce((total, current) => total + current, 0) + 8 +
    outputSizes.reduce((total, current) => total + current, 0) + 8 + 20 + 8 + 32 + 8 + value.payload.length / 2;
  const outputScriptMass = value.outputs.reduce(
    (total, output) => total + (2 + output.scriptPublicKey.slice(4).length / 2) * 10,
    0
  );
  const computeMass = size + outputScriptMass + value.inputs.reduce(
    (total, txInput) => total + (txInput.computeBudget ?? 0) * 100,
    0
  );
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
    computeMass,
    transientMass,
    normalizedTransientMass,
    storageMass: persistentStorageMass,
    feeMass,
    requiredFee: BigInt(feeMass) * 100n,
    standard: computeMass <= MASS_LIMITS.compute && transientMass <= MASS_LIMITS.transient && persistentStorageMass <= MASS_LIMITS.storage
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

function buildCreate() {
  const redeem = stateScript({ soldTickets: 0, soldBatches: 0, batchEnds: [], owners: [] });
  const stagingScript = payToScriptHashScript(LOW_COST_REDEEM_SCRIPT);
  const stagingAmount = carrier + fees.create;
  const staging = utxo(0, stagingAmount, stagingScript);
  const builder = new ScriptBuilder();
  builder.addData(LOW_COST_REDEEM_SCRIPT);
  const transaction = tx(
    [input(staging, builder.drain())],
    [new TransactionOutput(carrier, payToScriptHashScript(redeem))],
    {
      app: "kaspa-raffle-static",
      type: "round-create",
      version: "0.1.14",
      roundId: "11".repeat(32),
      creator: addresses[0].toString(),
      ticketPrice: TICKET_PRICE.toString(),
      maxTickets: MAX_TICKETS,
      minTickets: 1,
      creatorPubkey: hex(publicKeys[0]),
      oraclePublicKey: hex(publicKeys[1]),
      createdAtDaaScore: "999999999999",
      refundAfterDaaScore: "999999999999",
      refundTimeoutSeconds: "2592000",
      refundTimeoutDaa: "25920000",
      registryAddress: addresses[0].toString(),
      createdAt: "2026-12-31T23:59:59.999Z"
    }
  );
  transaction.populateGenesisCovenants([new GenesisCovenantGroup(0, [0])]);
  return transaction;
}

function batchFixture(soldBatches) {
  const perBatch = MAX_TICKETS / MAX_BATCHES;
  const ends = Array.from({ length: soldBatches }, (_, index) => (index + 1) * perBatch);
  return { ends, owners: publicKeys.slice(0, soldBatches) };
}

function buildBuy({ previousTickets, previousBatches, ticketCount }) {
  const previous = batchFixture(previousBatches);
  const nextEnds = [...previous.ends, previousTickets + ticketCount];
  const nextOwners = [...previous.owners, publicKeys[previousBatches]];
  const currentRedeem = stateScript({
    soldTickets: previousTickets,
    soldBatches: previousBatches,
    batchEnds: previous.ends,
    owners: previous.owners
  });
  const nextRedeem = stateScript({
    soldTickets: previousTickets + ticketCount,
    soldBatches: previousBatches + 1,
    batchEnds: nextEnds,
    owners: nextOwners
  });
  const purchase = TICKET_PRICE * BigInt(ticketCount);
  const currentAmount = carrier + TICKET_PRICE * BigInt(previousTickets);
  const covenantId = "aa".repeat(32);
  const covenantUtxo = utxo(1, currentAmount, payToScriptHashScript(currentRedeem), undefined, covenantId);
  const stagingUtxo = utxo(2, purchase + fees.buy, payToScriptHashScript(LOW_COST_REDEEM_SCRIPT));
  const buyScript = entrypointScript("buy", currentRedeem, (builder) => {
    builder.addData(new Uint8Array(32).fill(0x22));
    builder.addData(nextOwners.at(-1));
    builder.addI64(BigInt(ticketCount));
  });
  const stagingBuilder = new ScriptBuilder();
  stagingBuilder.addData(LOW_COST_REDEEM_SCRIPT);
  const successor = new TransactionOutput(currentAmount + purchase, payToScriptHashScript(nextRedeem));
  successor.covenant = new CovenantBinding(0, new Hash(covenantId));
  return tx(
    [input(covenantUtxo, buyScript, budgets.buy), input(stagingUtxo, stagingBuilder.drain())],
    [successor],
    {
      app: "kaspa-raffle-static",
      type: "ticket",
      version: "0.1.14",
      roundId: "11".repeat(32),
      ticketId: previousTickets + 1,
      buyer: addresses[previousBatches].toString(),
      buyerPubkey: hex(nextOwners.at(-1)),
      buyerCommitment: "22".repeat(32),
      ticketCount,
      paidAmount: purchase.toString(),
      createdAt: "2026-12-31T23:59:59.999Z"
    }
  );
}

function soldOutState(batchEnds) {
  const fixture = batchEnds
    ? { ends: batchEnds, owners: publicKeys.slice(0, batchEnds.length) }
    : batchFixture(MAX_BATCHES);
  const redeem = stateScript({ soldTickets: MAX_TICKETS, soldBatches: MAX_BATCHES, batchEnds: fixture.ends, owners: fixture.owners });
  return { ...fixture, redeem };
}

function buildFinalize() {
  const { redeem } = soldOutState();
  const pot = TICKET_PRICE * BigInt(MAX_TICKETS);
  const covenantId = "aa".repeat(32);
  const covenantUtxo = utxo(3, carrier + pot, payToScriptHashScript(redeem), undefined, covenantId);
  const authAmount = 5_000_000n;
  const authUtxo = utxo(4, authAmount, addressScripts[2], addresses[2]);
  const winnerScript = addressScripts[19];
  const finalizeScript = entrypointScript("finalize", redeem, (builder) => {
    builder.addData(new Uint8Array(64).fill(0x33));
    builder.addData(new Uint8Array(32).fill(0x44));
    builder.addI64(BigInt(MAX_TICKETS - 1));
    builder.addData(xOnlyPubkey(winnerScript));
    builder.addData(xOnlyPubkey(addressScripts[2]));
  });
  return tx(
    [input(covenantUtxo, finalizeScript, budgets.finalize), input(authUtxo, "00".repeat(66), budgets.auth)],
    [
      new TransactionOutput(pot, winnerScript),
      new TransactionOutput(carrier - fees.finalize, addressScripts[0]),
      new TransactionOutput(authAmount, addressScripts[2])
    ],
    {
      app: "kaspa-raffle-static",
      type: "round-finalize",
      version: "0.1.14",
      roundId: "11".repeat(32),
      winnerTicketId: MAX_TICKETS,
      winnerAddress: addresses[19].toString(),
      amount: pot.toString(),
      randomSeed: "55".repeat(32),
      oracleSeed: "44".repeat(32),
      oracleSignature: "33".repeat(64),
      finalizedAt: "2026-12-31T23:59:59.999Z"
    }
  );
}

function buildRefund(batchEnds) {
  const { redeem, ends } = soldOutState(batchEnds);
  const pot = TICKET_PRICE * BigInt(MAX_TICKETS);
  const covenantId = "aa".repeat(32);
  const covenantUtxo = utxo(5, carrier + pot, payToScriptHashScript(redeem), undefined, covenantId);
  const refundScript = entrypointScript("refund_all", redeem);
  let previousEnd = 0;
  const outputs = ends.map((batchEnd, index) => {
    const amount = TICKET_PRICE * BigInt(batchEnd - previousEnd);
    previousEnd = batchEnd;
    return new TransactionOutput(amount, addressScripts[index]);
  });
  outputs.push(new TransactionOutput(carrier - fees.refund, addressScripts[0]));
  return tx(
    [input(covenantUtxo, refundScript, budgets.refund)],
    outputs,
    {
      app: "kaspa-raffle-static",
      type: "round-refund",
      version: "0.1.14",
      roundId: "11".repeat(32),
      soldTickets: MAX_TICKETS,
      amount: pot.toString(),
      refundAfterDaaScore: "999999999999",
      refundedAt: "2026-12-31T23:59:59.999Z"
    },
    1n
  );
}

const privateKeys = Array.from({ length: MAX_BATCHES }, (_, index) => new PrivateKey((index + 1).toString(16).padStart(64, "0")));
const addresses = privateKeys.map((key) => key.toAddress(NETWORK));
const addressScripts = addresses.map(payToAddressScript);
const publicKeys = addressScripts.map(xOnlyPubkey);

if (!contractSource.includes("max_tickets <= 1000000")) throw new Error("Compiled source does not allow 1000000 tickets.");

const cases = [
  { name: "create-1m", transaction: buildCreate(), fee: fees.create, expectStandard: true },
  { name: "buy-1m-single-batch", transaction: buildBuy({ previousTickets: 0, previousBatches: 0, ticketCount: MAX_TICKETS }), fee: fees.buy, expectStandard: true },
  { name: "buy-1m-final-of-20", transaction: buildBuy({ previousTickets: 950_000, previousBatches: 19, ticketCount: 50_000 }), fee: fees.buy, expectStandard: true },
  { name: "finalize-1m-20-batches", transaction: buildFinalize(), fee: fees.finalize, expectStandard: true },
  { name: "refund-1m-20-balanced", transaction: buildRefund(), fee: fees.refund, expectStandard: true },
  {
    name: "refund-1m-20-skewed",
    transaction: buildRefund([...Array.from({ length: 19 }, (_, index) => index + 1), MAX_TICKETS]),
    fee: fees.refund,
    expectStandard: false
  }
];

let failed = false;
console.log("Million-ticket Toccata v1 fee verification");
console.log("case                           compute transient storage fee-mass required KAS configured KAS result");

for (const { name, transaction, fee: configuredFee, expectStandard } of cases) {
  const mass = toccataMass(transaction);
  const requiredFee = mass.requiredFee;
  const feeOk = configuredFee >= requiredFee;
  const ok = feeOk && mass.standard === expectStandard;
  failed ||= !ok;
  const requiredKas = (Number(requiredFee) / 1e8).toFixed(6);
  const configuredKas = (Number(configuredFee) / 1e8).toFixed(6);
  console.log(
    `${name.padEnd(30)} ${String(mass.computeMass).padStart(7)} ${String(mass.transientMass).padStart(9)} ` +
    `${String(mass.storageMass).padStart(7)} ${String(mass.feeMass).padStart(8)} ${requiredKas.padStart(12)} ` +
    `${configuredKas.padStart(14)} ${mass.standard ? (ok ? "PASS" : "FAIL") : (ok ? "EXPECTED STORAGE REJECT" : "FAIL")}`
  );
}

if (failed) {
  console.error("At least one current fixed fee is insufficient for the exact million-ticket transaction fixture.");
  process.exitCode = 1;
} else {
  console.log("All configured fixed fees cover the exact million-ticket fixtures; the skewed 20-batch refund is correctly detected as non-standard due to storage mass.");
}
