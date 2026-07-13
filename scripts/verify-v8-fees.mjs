import fs from "node:fs";
import path from "node:path";
import {
  CovenantBinding, Hash, PrivateKey, ScriptBuilder, Transaction, TransactionOutput,
  initSync, payToAddressScript, payToScriptHashScript
} from "../node_modules/@onekeyfe/kaspa-wasm/kaspa.js";

const root = process.cwd();
const artifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-v8-tn12.artifact.json"), "utf8"));
initSync({ module: fs.readFileSync(path.join(root, "node_modules/@onekeyfe/kaspa-wasm/kaspa_bg.wasm.bin")) });

const TICKET_PRICE = 30_000_000n;
const CARRIER = 57_000_000n;
const CLOSE_FEE = 1_550_000n;
const BUY_FEE = 1_570_000n;
const STORAGE_MASS_PARAMETER = 1_000_000_000_000n;
const key = new PrivateKey("01".padStart(64, "0"));
const address = key.toAddress("testnet-10");
const p2pk = payToAddressScript(address);
const pubkey = Buffer.from(p2pk.toJSON().script, "hex").subarray(1, 33);
const covenantId = "aa".repeat(32);

function i64(value) {
  const bytes = Buffer.alloc(8);
  let remaining = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function pushData(bytes) {
  if (bytes.length <= 75) return Buffer.from([bytes.length, ...bytes]);
  if (bytes.length <= 0xff) return Buffer.from([0x4c, bytes.length, ...bytes]);
  return Buffer.from([0x4d, bytes.length & 0xff, bytes.length >> 8, ...bytes]);
}

function redeem(soldTickets, refundCursor) {
  const values = {
    max_tickets: 10n,
    ticket_price: TICKET_PRICE,
    creator_pubkey: pubkey,
    refund_after_daa: 1_000n,
    sold_tickets: BigInt(soldTickets),
    ticket_root: Buffer.alloc(32),
    frontier: Buffer.alloc(640),
    refund_cursor: BigInt(refundCursor)
  };
  const encoded = Buffer.concat(artifact.stateFields.map((field) => (
    pushData(field.type === "int" ? i64(values[field.name]) : Buffer.from(values[field.name]))
  )));
  const script = Buffer.from(artifact.script, "hex");
  encoded.copy(script, artifact.stateLayout.start);
  return script;
}

function action(name, currentRedeem, addArgs = () => undefined) {
  const entry = artifact.abi.find((candidate) => candidate.name === name);
  const builder = new ScriptBuilder({ flags: { covenantsEnabled: true } });
  addArgs(builder);
  builder.addI64(BigInt(entry.selector));
  builder.addData(currentRedeem);
  return builder.drain();
}

function utxo(index, amount, scriptPublicKey, covenant = false) {
  return {
    address,
    outpoint: { transactionId: (index + 1).toString(16).padStart(2, "0").repeat(32), index: 0 },
    amount,
    scriptPublicKey,
    blockDaaScore: 1n,
    isCoinbase: false,
    ...(covenant ? { covenantId: new Hash(covenantId) } : {})
  };
}

function covenantOutput(amount, script) {
  const output = new TransactionOutput(amount, payToScriptHashScript(script));
  output.covenant = new CovenantBinding(0, new Hash(covenantId));
  return output;
}

function transaction(inputs, outputs, type) {
  return new Transaction({
    version: 1,
    inputs,
    outputs,
    lockTime: 0n,
    subnetworkId: "00".repeat(20),
    gas: 0n,
    payload: Buffer.from(JSON.stringify({ app: "kaspa-raffle-static", type, version: "0.6.0", roundId: "11".repeat(32) })).toString("hex")
  });
}

function closeTx() {
  const open = redeem(10, 0);
  const closed = redeem(10, -1);
  const source = utxo(0, CARRIER + TICKET_PRICE * 10n, payToScriptHashScript(open), true);
  return transaction([{
    previousOutpoint: source.outpoint,
    signatureScript: action("close", open),
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: 4,
    utxo: source
  }], [covenantOutput(source.amount - CLOSE_FEE, closed)], "round-close");
}

function buyTx() {
  const open = redeem(0, 0);
  const next = redeem(8, 0);
  const source = utxo(1, CARRIER, payToScriptHashScript(open), true);
  const fundingScript = Buffer.from([0x51]);
  const funding = utxo(2, TICKET_PRICE * 8n + BUY_FEE, payToScriptHashScript(fundingScript));
  const fundingBuilder = new ScriptBuilder();
  fundingBuilder.addData(fundingScript);
  return transaction([
    {
      previousOutpoint: source.outpoint,
      signatureScript: action("buy", open, (builder) => { builder.addData(pubkey); builder.addI64(8n); }),
      sequence: 0n, sigOpCount: 0, computeBudget: 10, utxo: source
    },
    {
      previousOutpoint: funding.outpoint,
      signatureScript: fundingBuilder.drain(),
      sequence: 0n, sigOpCount: 0, computeBudget: 0, utxo: funding
    }
  ], [covenantOutput(source.amount + TICKET_PRICE * 8n, next)], "ticket");
}

function plurality(scriptBytes, hasCovenant) {
  return Math.ceil((63 + scriptBytes + (hasCovenant ? 32 : 0)) / 100);
}

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

function mass(tx) {
  const value = JSON.parse(tx.serializeToSafeJSON());
  const inputSizes = value.inputs.map((item) => 36 + 8 + item.signatureScript.length / 2 + 8 + 2);
  const outputSizes = value.outputs.map((item) => 8 + 2 + 8 + item.scriptPublicKey.slice(4).length / 2 + (item.covenant ? 34 : 0));
  const bytes = 2 + 8 + inputSizes.reduce((a, b) => a + b, 0) + 8 + outputSizes.reduce((a, b) => a + b, 0) + 8 + 20 + 8 + 32 + 8 + value.payload.length / 2;
  const compute = bytes + value.outputs.reduce((sum, item) => sum + (2 + item.scriptPublicKey.slice(4).length / 2) * 10, 0) + value.inputs.reduce((sum, item) => sum + item.computeBudget * 100, 0);
  const transient = bytes * 4;
  const inputs = value.inputs.map((item) => ({ amount: BigInt(item.utxo.amount), plurality: plurality(item.utxo.scriptPublicKey.slice(4).length / 2, Boolean(item.utxo.covenantId)) }));
  const outputs = value.outputs.map((item) => ({ amount: BigInt(item.value), plurality: plurality(item.scriptPublicKey.slice(4).length / 2, Boolean(item.covenant)) }));
  const storage = storageMass(inputs, outputs);
  const feeMass = Math.max(compute, Math.ceil(transient * 0.5));
  return { bytes, compute, transient, storage, fee: BigInt(feeMass) * 100n };
}

for (const [name, tx, committed] of [["buy-8", buyTx(), BUY_FEE], ["close", closeTx(), CLOSE_FEE]]) {
  const measured = mass(tx);
  const standard = measured.compute <= 500_000 && measured.transient <= 1_000_000 && measured.storage <= 500_000;
  const pass = standard && committed >= measured.fee;
  console.log(`${name}: bytes=${measured.bytes}, compute=${measured.compute}, transient=${measured.transient}, storage=${measured.storage}, required=${Number(measured.fee) / 1e8} KAS, committed=${Number(committed) / 1e8} KAS, ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}
