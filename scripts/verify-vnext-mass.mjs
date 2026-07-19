import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  ScriptBuilder,
  ScriptPublicKey,
  Transaction,
  TransactionOutput,
  CovenantBinding,
  covenantId as deriveCovenantId,
  GenesisCovenantGroup,
  Hash,
  addressFromScriptPublicKey,
  calculateStorageMass,
  calculateTransactionFee,
  calculateTransactionMass,
  initSync,
  maximumStandardTransactionMass,
  payToScriptHashScript
} from "@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const requireFromScript = createRequire(import.meta.url);
const kaspaDirectory = path.dirname(requireFromScript.resolve("@onekeyfe/kaspa-wasm/kaspa.js"));
const artifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-vnext.artifact.json"), "utf8"));
const roundArtifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-vnext.artifact.json"), "utf8"));
const transactionsSource = fs.readFileSync(path.join(root, "src/kaspa/transactions.ts"), "utf8");
function sourceBudget(name) {
  const match = transactionsSource.match(new RegExp(`export const ${name} = (\\d+);`));
  assert.ok(match, `transaction builder exports ${name}`);
  return Number(match[1]);
}
function sourceSompi(name) {
  const match = transactionsSource.match(new RegExp(`export const ${name} = ([\\d_]+)n;`));
  assert.ok(match, `transaction builder exports ${name}`);
  return BigInt(match[1].replaceAll("_", ""));
}
const buyComputeBudget = sourceBudget("RAFFLE_BUY_COMPUTE_BUDGET");
const topUpComputeBudget = sourceBudget("RAFFLE_TOP_UP_COMPUTE_BUDGET");
const walletComputeBudget = sourceBudget("P2PK_WALLET_COMPUTE_BUDGET");
const refundTransitionComputeBudget = sourceBudget("GROUPED_REFUND_TRANSITION_COMPUTE_BUDGET");
const maxRefundComputeBudget = sourceBudget("GROUPED_REFUND_MAX_COMPUTE_BUDGET");
initSync({ module: fs.readFileSync(path.join(kaspaDirectory, "kaspa_bg.wasm.bin")) });

const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const nonce = "42".repeat(32);
const ticketPrice = 100_000_000n;
const carrier = 57_300_000n;
const refundFee = 20_000_000n;
const refundFeeDebt = 20_000_000n;
let batchCount = 13;
let proofBytes;
let ownerBytes;
let countBytes;
function configureBatchCount(value) {
  batchCount = value;
  proofBytes = new Uint8Array(640 * batchCount);
  ownerBytes = Uint8Array.from(Buffer.from(owner.repeat(batchCount), "hex"));
  countBytes = new Uint8Array(batchCount * 8);
  for (let index = 0; index < batchCount; index += 1) countBytes[index * 8] = 1;
}
configureBatchCount(batchCount);

function push(bytes) {
  if (bytes.length <= 75) return Uint8Array.from([bytes.length, ...bytes]);
  if (bytes.length <= 255) return Uint8Array.from([0x4c, bytes.length, ...bytes]);
  return Uint8Array.from([0x4d, bytes.length & 255, bytes.length >> 8, ...bytes]);
}
function i64(value) {
  const output = new Uint8Array(9); output[0] = 8;
  let next = BigInt(value);
  for (let index = 0; index < 8; index += 1) { output[index + 1] = Number(next & 255n); next >>= 8n; }
  return output;
}
function stateScript() {
  const fields = {
    round_nonce: push(Buffer.from(nonce, "hex")), ticket_price: i64(ticketPrice), creator_pubkey: push(Buffer.from(owner, "hex")),
    sold_tickets: i64(batchCount), sold_batches: i64(batchCount), ticket_root: push(Buffer.alloc(32, 0x55)),
    refund_cursor: i64(0), refund_batch_cursor: i64(0), refund_fee_debt: i64(refundFeeDebt)
  };
  const state = Buffer.concat(artifact.stateFields.map((field) => fields[field.name]));
  assert.equal(state.length, artifact.stateLayout.len, "vNext refund state layout is encoded exactly");
  const script = Buffer.from(artifact.script, "hex"); state.copy(script, artifact.stateLayout.start);
  return new Uint8Array(script);
}
function signatureScript(redeem) {
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  builder.addI64(refundFee);
  builder.addI64(BigInt(batchCount));
  builder.addData(ownerBytes); builder.addData(countBytes); builder.addData(proofBytes);
  builder.addI64(0n); builder.addData(redeem);
  return builder.drain();
}
function refundTransaction(network, final) {
  const redeem = stateScript();
  const covenantScript = payToScriptHashScript(redeem);
  const covenantAddress = addressFromScriptPublicKey(covenantScript, network)?.toString();
  assert.ok(covenantAddress, "vNext covenant derives a network address");
  const ownerScript = new ScriptPublicKey(0, `20${owner}ac`);
  const principal = ticketPrice * BigInt(batchCount);
  const inputValue = principal + carrier - refundFeeDebt;
  const totalBuyerFee = refundFee + refundFeeDebt;
  const feePerBatch = totalBuyerFee / BigInt(batchCount);
  const feeRemainder = totalBuyerFee % BigInt(batchCount);
  const outputs = Array.from({ length: batchCount }, (_, index) => new TransactionOutput(ticketPrice - feePerBatch - (index === 0 ? feeRemainder : 0n), ownerScript));
  if (final) outputs.push(new TransactionOutput(carrier, ownerScript));
  else outputs.unshift(new TransactionOutput(inputValue - principal, covenantScript));
  const tx = new Transaction({
    version: 1,
    inputs: [{
      previousOutpoint: { transactionId: "33".repeat(32), index: 0 },
      signatureScript: signatureScript(redeem),
      sequence: 0n,
      sigOpCount: 0,
      computeBudget: maxRefundComputeBudget,
      utxo: { address: covenantAddress, outpoint: { transactionId: "33".repeat(32), index: 0 }, amount: inputValue, scriptPublicKey: covenantScript, blockDaaScore: 474_175_565n, isCoinbase: false }
    }],
    outputs, lockTime: 474_175_565n, subnetworkId: "00".repeat(20), gas: 0n, payload: "", mass: 0n, storageMass: 0n
  });
  const storageMass = calculateStorageMass(network, [Number(inputValue)], outputs.map((output) => Number(output.value)));
  const totalMass = calculateTransactionMass(network, tx, 0);
  const fee = calculateTransactionFee(network, tx, 0);
  return { storageMass, totalMass, fee, outputs: outputs.length };
}

function roundStateScript() {
  const fields = {
    round_nonce: push(Buffer.from(nonce, "hex")), max_tickets: i64(100), min_tickets: i64(1), max_batches: i64(100),
    ticket_price: i64(ticketPrice), creator_pubkey: push(Buffer.from(owner, "hex")), sales_deadline_daa: i64(999_999_999),
    sold_tickets: i64(0), sold_batches: i64(0), ticket_root: push(Buffer.alloc(32)), frontier: push(Buffer.alloc(640)),
    refund_cursor: i64(0), refund_batch_cursor: i64(0)
  };
  const state = Buffer.concat(roundArtifact.stateFields.map((field) => fields[field.name]));
  assert.equal(state.length, roundArtifact.stateLayout.len, "vNext round state layout is encoded exactly");
  const script = Buffer.from(roundArtifact.script, "hex"); state.copy(script, roundArtifact.stateLayout.start);
  return new Uint8Array(script);
}

function startRefundTransaction(network) {
  const redeem = roundStateScript();
  const covenantScript = payToScriptHashScript(redeem);
  const covenantAddress = addressFromScriptPublicKey(covenantScript, network)?.toString();
  assert.ok(covenantAddress, "refund-transition covenant derives a network address");
  const refundTemplate = Buffer.from(artifact.script, "hex");
  const refundPrefix = refundTemplate.subarray(0, artifact.stateLayout.start);
  const refundSuffix = refundTemplate.subarray(artifact.stateLayout.start + artifact.stateLayout.len);
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  builder.addI64(refundFeeDebt); builder.addData(refundPrefix); builder.addData(refundSuffix);
  builder.addI64(2n); builder.addData(redeem);
  const inputValue = ticketPrice + carrier;
  const outputValue = inputValue - refundFeeDebt;
  const refundScript = payToScriptHashScript(stateScript());
  const tx = new Transaction({
    version: 1,
    inputs: [{
      previousOutpoint: { transactionId: "77".repeat(32), index: 0 }, signatureScript: builder.drain(), sequence: 0n, sigOpCount: 0,
      computeBudget: refundTransitionComputeBudget,
      utxo: { address: covenantAddress, outpoint: { transactionId: "77".repeat(32), index: 0 }, amount: inputValue, scriptPublicKey: covenantScript, blockDaaScore: 474_175_565n, isCoinbase: false }
    }],
    outputs: [new TransactionOutput(outputValue, refundScript)], lockTime: 474_175_565n, subnetworkId: "00".repeat(20), gas: 0n,
    payload: "ab".repeat(768), mass: 0n, storageMass: 0n
  });
  return { mass: calculateTransactionMass(network, tx, 0), fee: calculateTransactionFee(network, tx, 0), paidFee: refundFeeDebt };
}

function topUpTransaction(network) {
  const redeem = roundStateScript();
  const covenantScript = payToScriptHashScript(redeem);
  const covenantAddress = addressFromScriptPublicKey(covenantScript, network)?.toString();
  const fundingScript = new ScriptPublicKey(0, `20${owner}ac`);
  const fundingAddress = addressFromScriptPublicKey(fundingScript, network)?.toString();
  assert.ok(covenantAddress && fundingAddress, "top-up input addresses derive on the selected network");
  const topUpAmount = 19_000_000n;
  const startingFee = sourceSompi("COVENANT_TOP_UP_FEE_SOMPI");
  const maximumFee = sourceSompi("MAX_COVENANT_TOP_UP_FEE_SOMPI");
  const safeWalletChange = 200_000_000n;
  const fundingAmount = topUpAmount + maximumFee + safeWalletChange;
  const currentAmount = 57_300_000n;
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  builder.addI64(topUpAmount); builder.addI64(4n); builder.addData(redeem);
  const topUpSignatureScript = builder.drain();
  const fundingBuilder = new ScriptBuilder({ flags: { covenantsEnabled: true } }); fundingBuilder.addData(Buffer.alloc(65, 1));
  const fundingSignatureScript = fundingBuilder.drain();
  const payload = "ab".repeat(768);
  const byteLength = (value) => typeof value === "string" ? value.length / 2 : value.byteLength;
  const scriptLength = (script) => script.toJSON().script.length / 2;
  const build = (fee) => {
    const walletChange = fundingAmount - topUpAmount - fee;
    assert.ok(walletChange >= safeWalletChange, "top-up keeps storage-mass-safe wallet change");
    const outputs = [
      new TransactionOutput(currentAmount + topUpAmount, covenantScript),
      new TransactionOutput(walletChange, fundingScript)
    ];
    const tx = new Transaction({
      version: 1,
      inputs: [
        { previousOutpoint: { transactionId: "44".repeat(32), index: 0 }, signatureScript: topUpSignatureScript, sequence: 0n, sigOpCount: 0, computeBudget: topUpComputeBudget,
          utxo: { address: covenantAddress, outpoint: { transactionId: "44".repeat(32), index: 0 }, amount: currentAmount, scriptPublicKey: covenantScript, blockDaaScore: 474_175_565n, isCoinbase: false } },
        { previousOutpoint: { transactionId: "55".repeat(32), index: 0 }, signatureScript: fundingSignatureScript, sequence: 0n, sigOpCount: 0, computeBudget: walletComputeBudget,
          utxo: { address: fundingAddress, outpoint: { transactionId: "55".repeat(32), index: 0 }, amount: fundingAmount, scriptPublicKey: fundingScript, blockDaaScore: 474_175_565n, isCoinbase: false } }
      ],
      outputs, lockTime: 0n, subnetworkId: "00".repeat(20), gas: 0n, payload, mass: 0n, storageMass: 0n
    });
    tx.outputs[0].covenant = new CovenantBinding(0, new Hash("66".repeat(32)));
    let normalizedSize = 2 + 8;
    normalizedSize += 36 + 8 + byteLength(topUpSignatureScript) + 8 + 2;
    normalizedSize += 36 + 8 + byteLength(fundingSignatureScript) + 8 + 2;
    normalizedSize += 8;
    normalizedSize += outputs.reduce((size, output) => size + 8 + 2 + 8 + scriptLength(output.scriptPublicKey), 0);
    normalizedSize += 8 + 20 + 8 + 32 + 8 + payload.length / 2;
    const transientFee = BigInt(normalizedSize) * 2n * 100n;
    const staticFee = calculateTransactionFee(network, tx, 0);
    assert.ok(staticFee !== undefined, `${network} top-up static mass stays measurable`);
    return { tx, outputs, staticFee, transientFee, requiredFee: staticFee > transientFee ? staticFee : transientFee };
  };
  let paidFee = startingFee;
  let built = build(paidFee);
  for (let attempt = 0; built.requiredFee > paidFee && attempt < 8; attempt += 1) {
    paidFee = built.requiredFee;
    assert.ok(paidFee <= maximumFee, `${network} top-up converges below its fee cap`);
    built = build(paidFee);
  }
  assert.ok(built.requiredFee <= paidFee, `${network} top-up fee converges`);
  return {
    mass: calculateTransactionMass(network, built.tx, 0),
    fee: built.requiredFee,
    startingFee,
    maximumFee,
    paidFee,
    walletChange: built.outputs[1].value
  };
}

function walletSignatureScript() {
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  builder.addData(Buffer.alloc(65, 1));
  return builder.drain();
}

function p2pkInput(network, transactionId, amount, payloadScript = walletSignatureScript()) {
  const scriptPublicKey = new ScriptPublicKey(0, `20${owner}ac`);
  const address = addressFromScriptPublicKey(scriptPublicKey, network)?.toString();
  assert.ok(address, "wallet P2PK input address derives on the selected network");
  return {
    previousOutpoint: { transactionId, index: 0 }, signatureScript: payloadScript,
    sequence: 0n, sigOpCount: 0, computeBudget: walletComputeBudget,
    utxo: { address, outpoint: { transactionId, index: 0 }, amount, scriptPublicKey, blockDaaScore: 474_175_565n, isCoinbase: false }
  };
}

function measureFixedFeeTransaction(network, tx, paidFee, label) {
  const mass = calculateTransactionMass(network, tx, 0);
  const minimumFee = calculateTransactionFee(network, tx, 0);
  console.log(`MEASURE ${network} ${label}: totalMass=${mass}, minimumFee=${minimumFee}, paidFee=${paidFee}`);
  assert.ok(mass <= maximumStandardTransactionMass(), `${network} ${label} stays below standard mass`);
  assert.ok(minimumFee !== undefined && minimumFee <= paidFee, `${network} ${label} fixed fee covers its maximum payload shape`);
  console.log(`PASS ${network} ${label}: totalMass=${mass}, minimumFee=${minimumFee}, paidFee=${paidFee}`);
}

function createTransaction(network) {
  const carrierAmount = 57_300_000n;
  const paidFee = 6_000_000n;
  const redeem = roundStateScript();
  const covenantScript = payToScriptHashScript(redeem);
  const output = new TransactionOutput(carrierAmount, covenantScript);
  const genesisOutpoint = { transactionId: "66".repeat(32), index: 0 };
  const manualCovenantHash = deriveCovenantId(genesisOutpoint, [{ index: 0, output }]);
  const manualCovenantId = manualCovenantHash.toString();
  const tx = new Transaction({
    version: 1,
    inputs: [p2pkInput(network, "66".repeat(32), carrierAmount + paidFee)],
    outputs: [output], lockTime: 0n, subnetworkId: "00".repeat(20), gas: 0n,
    payload: "ab".repeat(1_536), mass: 0n, storageMass: 0n
  });
  tx.outputs[0].covenant = new CovenantBinding(0, manualCovenantHash);
  const automaticOutput = new TransactionOutput(carrierAmount, covenantScript);
  const automaticTx = new Transaction({
    version: 1,
    inputs: [p2pkInput(network, "66".repeat(32), carrierAmount + paidFee)],
    outputs: [automaticOutput], lockTime: 0n, subnetworkId: "00".repeat(20), gas: 0n,
    payload: "ab".repeat(1_536), mass: 0n, storageMass: 0n
  });
  automaticTx.populateGenesisCovenants([new GenesisCovenantGroup(0, [0])]);
  const automaticCovenantId = automaticTx.outputs[0].covenant?.covenantId.toString();
  assert.equal(manualCovenantId, automaticCovenantId, `${network} direct Genesis derivation matches bulk population`);
  return { tx, paidFee, covenantId: manualCovenantId };
}

function registryTransaction(network) {
  const paidFee = 500_000n;
  const markerAmount = 20_000_000n;
  const stagingAmount = markerAmount + paidFee;
  const markerScript = payToScriptHashScript(Uint8Array.from([0x51]));
  const tx = new Transaction({
    version: 1,
    inputs: [p2pkInput(network, "77".repeat(32), stagingAmount)],
    outputs: [new TransactionOutput(markerAmount, markerScript)],
    lockTime: 0n, subnetworkId: "00".repeat(20), gas: 0n,
    payload: "ab".repeat(1_536), mass: 0n, storageMass: 0n
  });
  return { tx, paidFee };
}

function standaloneNetRegistryTransaction(network) {
  const markerAmount = 1_000_000n;
  const paidFee = 500_000n;
  const markerScript = payToScriptHashScript(Uint8Array.from([0x51]));
  return new Transaction({
    version: 1,
    inputs: [p2pkInput(network, "78".repeat(32), markerAmount + paidFee)],
    outputs: [new TransactionOutput(markerAmount, markerScript)],
    lockTime: 0n, subnetworkId: "00".repeat(20), gas: 0n,
    payload: "ab".repeat(1_536), mass: 0n, storageMass: 0n
  });
}

function registryRefundTransaction(network) {
  const markerAmount = 20_000_000n;
  const paidFee = 1_000_000n;
  const redeem = Uint8Array.from([0x51]);
  const markerScript = payToScriptHashScript(redeem);
  const markerAddress = addressFromScriptPublicKey(markerScript, network)?.toString();
  assert.ok(markerAddress, "registry marker refund address derives on the selected network");
  const unlock = new ScriptBuilder(); unlock.addData(redeem);
  const tx = new Transaction({
    version: 1,
    inputs: [{ previousOutpoint: { transactionId: "aa".repeat(32), index: 0 }, signatureScript: unlock.drain(), sequence: 0n, sigOpCount: 0,
      utxo: { address: markerAddress, outpoint: { transactionId: "aa".repeat(32), index: 0 }, amount: markerAmount, scriptPublicKey: markerScript, blockDaaScore: 474_175_565n, isCoinbase: false } }],
    outputs: [new TransactionOutput(markerAmount - paidFee, new ScriptPublicKey(0, `20${owner}ac`))],
    lockTime: 0n, subnetworkId: "00".repeat(20), gas: 0n, payload: "", mass: 0n, storageMass: 0n
  });
  return { tx, paidFee };
}

function buyTransaction(network) {
  const currentAmount = 57_300_000n;
  const purchaseAmount = 100_000_000n;
  const paidFee = 2_100_000n;
  const safeWalletChange = 200_000_000n;
  const redeem = roundStateScript();
  const covenantScript = payToScriptHashScript(redeem);
  const covenantAddress = addressFromScriptPublicKey(covenantScript, network)?.toString();
  assert.ok(covenantAddress, "buy covenant address derives on the selected network");
  const buyAbi = roundArtifact.abi.find((entry) => entry.name === "buy");
  assert.ok(buyAbi && Number.isInteger(buyAbi.selector), "buy ABI selector is compiled");
  const buyBuilder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  buyBuilder.addData(Buffer.from(owner, "hex")); buyBuilder.addI64(1n); buyBuilder.addI64(BigInt(buyAbi.selector)); buyBuilder.addData(redeem);
  const covenantId = "11".repeat(32);
  const outputs = [
    new TransactionOutput(currentAmount + purchaseAmount, covenantScript),
    new TransactionOutput(safeWalletChange, new ScriptPublicKey(0, `20${owner}ac`))
  ];
  const tx = new Transaction({
    version: 1,
    inputs: [
      { previousOutpoint: { transactionId: "88".repeat(32), index: 0 }, signatureScript: buyBuilder.drain(), sequence: 0n, sigOpCount: 0, computeBudget: buyComputeBudget,
        utxo: { address: covenantAddress, outpoint: { transactionId: "88".repeat(32), index: 0 }, amount: currentAmount, scriptPublicKey: covenantScript, blockDaaScore: 474_175_565n, isCoinbase: false, covenantId: new Hash(covenantId) } },
      p2pkInput(network, "99".repeat(32), purchaseAmount + paidFee + safeWalletChange)
    ],
    outputs, lockTime: 999_999_998n, subnetworkId: "00".repeat(20), gas: 0n,
    payload: "ab".repeat(768), mass: 0n, storageMass: 0n
  });
  tx.outputs[0].covenant = new CovenantBinding(0, new Hash(covenantId));
  return { tx, paidFee };
}

for (const network of ["mainnet", "testnet-10"]) {
  const create = createTransaction(network);
  assert.match(create.covenantId, /^[0-9a-f]{64}$/, `${network} Genesis binding exposes a direct 32-byte covenant id`);
  assert.doesNotThrow(() => create.tx.serializeToSafeJSON(), `${network} Genesis transaction remains wallet-serializable`);
  measureFixedFeeTransaction(network, create.tx, create.paidFee, "round creation");
  const registry = registryTransaction(network);
  measureFixedFeeTransaction(network, registry.tx, registry.paidFee, "registry marker");
  const standaloneNetRegistry = standaloneNetRegistryTransaction(network);
  const standaloneNetRegistryMass = calculateTransactionMass(network, standaloneNetRegistry, 0);
  const standaloneNetRegistryFee = calculateTransactionFee(network, standaloneNetRegistry, 0);
  assert.ok(
    standaloneNetRegistryMass > maximumStandardTransactionMass() && standaloneNetRegistryFee === undefined,
    `${network} rejects a standalone 0.01 KAS Registry output as non-standard`
  );
  console.log(`PASS ${network} standalone 0.01 KAS Registry output is non-standard: totalMass=${standaloneNetRegistryMass}`);
  const registryRefund = registryRefundTransaction(network);
  measureFixedFeeTransaction(network, registryRefund.tx, registryRefund.paidFee, "registry marker settlement");
  const buy = buyTransaction(network);
  measureFixedFeeTransaction(network, buy.tx, buy.paidFee, "ticket purchase");
  assert.ok(ticketPrice - refundFee - refundFeeDebt >= 20_000_000n, `${network} minimum one-ticket refund leaves a relay-standard owner output at both fee caps`);
  const topUp = topUpTransaction(network);
  console.log(`MEASURE ${network} carrier top-up: totalMass=${topUp.mass}, minimumFee=${topUp.fee}, startingFee=${topUp.startingFee}, feeCap=${topUp.maximumFee}, paidFee=${topUp.paidFee}, walletChange=${topUp.walletChange}`);
  assert.ok(topUp.mass <= maximumStandardTransactionMass(), `${network} top-up stays below standard mass`);
  assert.ok(topUp.fee !== undefined && topUp.fee <= topUp.paidFee && topUp.paidFee <= topUp.maximumFee, `${network} top-up converges within its fee cap`);
  assert.ok(topUp.walletChange >= 200_000_000n, `${network} top-up returns storage-mass-safe wallet change`);
  console.log(`PASS ${network} carrier top-up: totalMass=${topUp.mass}, minimumFee=${topUp.fee}, paidFee=${topUp.paidFee}, walletChange=${topUp.walletChange}`);
  const transition = startRefundTransaction(network);
  console.log(`MEASURE ${network} refund transition: totalMass=${transition.mass}, minimumFee=${transition.fee}, feeCap=${transition.paidFee}`);
  assert.ok(transition.mass <= maximumStandardTransactionMass(), `${network} refund transition stays below standard mass`);
  assert.ok(transition.fee !== undefined && transition.fee <= transition.paidFee, `${network} refund-transition cap covers measured mass with the maximum production payload`);
  console.log(`PASS ${network} refund transition: totalMass=${transition.mass}, minimumFee=${transition.fee}, feeCap=${transition.paidFee}`);
  for (const final of [false, true]) {
    let chosen;
    for (let candidate = 13; candidate >= 1; candidate -= 1) {
      configureBatchCount(candidate);
      const measured = refundTransaction(network, final);
      if (measured.totalMass <= maximumStandardTransactionMass() && measured.fee !== undefined && measured.fee > 0n && measured.fee <= 20_000_000n) {
        chosen = { candidate, measured };
        break;
      }
    }
    assert.ok(chosen, `${network} has a standard refundable batch prefix`);
    assert.ok(chosen.measured.storageMass !== undefined && chosen.measured.storageMass >= 0n, `${network} storage mass is measured`);
    console.log(`PASS ${network} ${final ? "final" : "successor"}: maxBatches=${chosen.candidate}, outputs=${chosen.measured.outputs}, totalMass=${chosen.measured.totalMass}, storageMass=${chosen.measured.storageMass}, minimumFee=${chosen.measured.fee}`);
  }
  configureBatchCount(1);
  const worstCaseSingle = refundTransaction(network, true);
  assert.ok(worstCaseSingle.totalMass <= maximumStandardTransactionMass(), `${network} one-ticket refund remains standard at both covenant fee caps`);
  assert.ok(worstCaseSingle.fee !== undefined && worstCaseSingle.fee <= refundFee, `${network} refund fee cap covers the one-ticket worst-case transaction shape`);
  console.log(`PASS ${network} one-ticket liveness floor: ownerOutput=${ticketPrice - refundFee - refundFeeDebt}, totalMass=${worstCaseSingle.totalMass}, minimumFee=${worstCaseSingle.fee}`);
}
console.log("vNext refund transaction-shape mass and fee checks passed.");
