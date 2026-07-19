import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "protocol-manifest.json"), "utf8"));
const round = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-round-vnext.artifact.json"), "utf8"));
const refund = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled/raffle-refund-vnext.artifact.json"), "utf8"));
const roundSource = fs.readFileSync(path.join(root, "src/contracts/raffle_round_vnext.sil"), "utf8");
const refundSource = fs.readFileSync(path.join(root, "src/contracts/raffle_refund_vnext.sil"), "utf8");
function hashScript(artifact) { return createHash("sha256").update(Buffer.from(artifact.script, "hex")).digest("hex"); }
function assertArtifact(artifact, contract, entries) {
  assert.equal(artifact.contract, contract);
  assert.equal(Buffer.from(artifact.script, "hex").length, artifact.scriptLength);
  assert.ok(entries.every((name, selector) => artifact.abi.some((entry) => entry.name === name && entry.selector === selector)));
}
assert.equal(manifest.artifactStatus, "compiled");
assertArtifact(round, "RaffleRoundVNext", ["buy", "finalize", "startRefund", "closeEmpty", "topUp"]);
assertArtifact(refund, "RaffleRefundVNext", ["refundNext"]);
assert.deepEqual(round.abi.find((entry) => entry.name === "closeEmpty")?.inputs.map((input) => input.name), ["close_fee"]);
assert.equal(hashScript(round), manifest.roundArtifactSha256);
assert.equal(hashScript(refund), manifest.refundArtifactSha256);
assert.deepEqual(round.stateFields.map((field) => field.name), ["round_nonce", "max_tickets", "min_tickets", "max_batches", "ticket_price", "creator_pubkey", "sales_deadline_daa", "sold_tickets", "sold_batches", "ticket_root", "frontier", "refund_cursor", "refund_batch_cursor"]);
assert.deepEqual(refund.stateFields.map((field) => field.name), ["round_nonce", "ticket_price", "creator_pubkey", "sold_tickets", "sold_batches", "ticket_root", "refund_cursor", "refund_batch_cursor", "refund_fee_debt"]);
assert.ok(roundSource.includes("int constant MAX_ROUND_BATCHES = 1000"));
assert.ok(roundSource.includes("int constant MIN_REFUNDABLE_TICKET_PRICE = 100000000"));
assert.ok(roundSource.includes("int constant MAX_ROUND_PRINCIPAL = 4611686018427387904"));
assert.ok(roundSource.includes("ticket_price <= MAX_ROUND_PRINCIPAL / max_tickets"));
assert.ok(roundSource.includes("return(random_value % sold_tickets)"));
assert.ok(!roundSource.includes("require(random_value < sampling_limit)"));
assert.ok(roundSource.includes("ticket_price * (sold_tickets + ticket_count) + MIN_COVENANT_CARRIER"));
assert.ok(roundSource.includes("rootFromFrontier(sold_batches) == ticket_root"));
assert.ok(roundSource.includes("sold_tickets == max_tickets || (tx.locktime >= sales_deadline_daa && sold_tickets >= min_tickets)"));
assert.ok(roundSource.includes("sold_tickets == max_tickets || OpTxInputDaaScore(this.activeInputIndex) >= sales_deadline_daa"));
assert.ok(roundSource.includes("sold_tickets < min_tickets && OpTxInputDaaScore(this.activeInputIndex) < sales_deadline_daa"));
assert.ok(roundSource.includes("sold_tickets > 0 && sold_batches > 0 && sold_tickets < min_tickets"));
assert.ok(roundSource.includes("refund_fee_debt: refund_transition_fee"));
assert.ok(roundSource.includes("entrypoint function startRefund") && roundSource.includes("require(tx.inputs.length == 1)"));
assert.ok(refundSource.includes("int total_buyer_fee = refund_fee + refund_fee_debt"));
assert.ok(refundSource.includes("int constant MAX_REFUND_FEE = 20000000"));
assert.ok(refundSource.includes("ticket_price >= MIN_REFUNDABLE_TICKET_PRICE"));
assert.ok(refundSource.includes("ticket_price <= MAX_ROUND_PRINCIPAL / sold_tickets"));
assert.ok(refundSource.includes("refund_fee_debt <= MAX_REFUND_TRANSITION_FEE"));
assert.ok(refundSource.includes("tx.outputs[owner_output_index].value == principal - owner_fee"));
assert.ok(refundSource.includes("successor_value >= remaining_principal"));
assert.ok(refundSource.includes("require(tx.inputs.length == 1)"));
console.log("PASS compiled vNext artifact hashes, public close ABI, bounded draw fallback, carrier top-up, and one-batch buyer-funded refund liveness match the manifest.");
