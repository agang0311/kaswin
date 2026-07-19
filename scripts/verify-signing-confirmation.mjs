import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/app/signing-preview.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { buildSigningPreview, buySnapshot, carrierTopUpSnapshot, registrySnapshot, openSigningConfirmation, cancelSigningConfirmation, decideSigningConfirmation, idleSigningConfirmationState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const snapshot = buySnapshot({ roundId: "round", covenantTxId: "tx", soldTickets: 4, ticketCount: 3, ticketPriceSompi: "100", refundAfterDaaScore: "200" });
const preview = buildSigningPreview({ operation: "buy", network: "testnet-10", address: "kaspatest:buyer", inputCount: "wallet selected", payment: "300 sompi", fee: "safe", carrier: "400", change: "kaspatest:buyer", covenant: "kaspatest:covenant", registry: "kaspatest:registry", ticketRange: "#5-#7", snapshot });
assert.equal(preview.snapshot, snapshot);
assert.equal(preview.ticketRange, "#5-#7");
for (const key of ["network", "address", "inputCount", "payment", "fee", "carrier", "change", "covenant", "registry", "ticketRange"]) assert.ok(preview[key]);
assert.ok(Object.isFrozen(preview), "preview must be an immutable copy");

const review = openSigningConfirmation(preview);
assert.equal(review.status, "review");
assert.notEqual(review.preview, preview, "opening must copy the reviewed snapshot");
assert.ok(Object.isFrozen(review.preview), "reviewed snapshot must remain immutable");
assert.equal(cancelSigningConfirmation(), idleSigningConfirmationState, "cancel returns to the idle state without execution");

const executable = decideSigningConfirmation(review, snapshot);
assert.deepEqual(executable.kind, "execute");
assert.equal(executable.operation, "buy");
const stale = decideSigningConfirmation(review, `${snapshot}:changed`);
assert.equal(stale.kind, "stale");
assert.equal(stale.state.status, "stale");
assert.equal(stale.state.preview, null, "stale buy must have no executable preview");
assert.equal(decideSigningConfirmation(stale.state, snapshot).kind, "none", "stale buy cannot silently recreate a signing action");

const topUpSnapshot = carrierTopUpSnapshot({ roundId: "round", covenantTxId: "tx", amountSompi: "57300000" });
const topUpReview = openSigningConfirmation(buildSigningPreview({ ...preview, operation: "top-up-carrier", snapshot: topUpSnapshot }));
assert.equal(decideSigningConfirmation(topUpReview, topUpSnapshot).kind, "execute", "unchanged carrier top-up may execute");
assert.equal(decideSigningConfirmation(topUpReview, `${topUpSnapshot}:changed`).kind, "stale", "changed carrier top-up cannot sign");

const publishSnapshot = registrySnapshot({ roundId: "round", createTxId: "create", registryAddress: "kaspatest:registry" });
const registryReview = openSigningConfirmation(buildSigningPreview({ ...preview, operation: "publish-registry", snapshot: publishSnapshot }));
assert.equal(decideSigningConfirmation(registryReview, publishSnapshot).kind, "execute", "unchanged Registry publication may execute");
assert.equal(decideSigningConfirmation(registryReview, `${publishSnapshot}:changed`).kind, "stale", "changed Registry publication cannot sign");

assert.throws(() => openSigningConfirmation({ ...preview, registry: "" }), /missing registry/, "incomplete preview must be rejected");
console.log("PASS signing confirmation state transitions and stale buy/carrier-top-up guards, including Registry publication");
