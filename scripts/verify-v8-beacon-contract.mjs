import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const imageId = "060dbe80dd89c0d429c13382557218ec629262a7c85d397fe8ce0d7de51cfe87";
const variants = [
  {
    name: "mainnet",
    contract: "RaffleRoundV8Mainnet",
    source: "raffle_round_v8_mainnet.sil",
    artifact: "raffle-round-v8-mainnet.artifact.json",
    anchorDaa: 484_727_113n,
    anchorRound: 30_363_105n,
    offset: 14_205_535n,
    delay: 40n
  },
  {
    name: "tn12",
    contract: "RaffleRoundV8Tn12",
    source: "raffle_round_v8_tn12.sil",
    artifact: "raffle-round-v8-tn12.artifact.json",
    anchorDaa: 515_340_645n,
    anchorRound: 30_363_105n,
    offset: 13_185_084n,
    delay: 5n
  }
];

function expectedRound(daa, variant) {
  return daa / 30n + variant.offset + variant.delay;
}

for (const variant of variants) {
  const source = fs.readFileSync(path.join(root, "src/contracts", variant.source), "utf8");
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "src/contracts/compiled", variant.artifact), "utf8"));

  assert.equal(artifact.contract, variant.contract);
  assert.deepEqual(artifact.abi.map((entry) => entry.name), ["buy", "close", "finalize", "startRefund"]);
  assert.ok(artifact.scriptLength < 7_500, `${variant.name} round script is unexpectedly large`);
  assert.ok(source.includes(`DRAND_GUEST_IMAGE_ID = 0x${imageId}`));
  assert.ok(source.includes(`DRAND_ROUND_OFFSET = ${variant.offset}`));
  assert.ok(source.includes(`DRAND_DELAY_ROUNDS = ${variant.delay}`));
  assert.ok(source.includes("OpTxInputDaaScore(this.activeInputIndex) / 30"));
  assert.ok(source.includes("entrypoint function close()"));
  assert.ok(source.includes("refund_cursor: -1"), `${variant.name} close does not lock ticket sales`);
  assert.ok(source.includes("require(refund_cursor == -1);"), `${variant.name} finalize does not require the closed state`);
  assert.ok(source.includes("OpZkPrecompile("));
  assert.ok(!source.includes("oracle_"), `${variant.name} still contains legacy Oracle state`);

  assert.equal(expectedRound(variant.anchorDaa, variant), variant.anchorRound + variant.delay);
  assert.equal(expectedRound(variant.anchorDaa + 30n, variant), variant.anchorRound + variant.delay + 1n);
  assert.ok(expectedRound(variant.anchorDaa + 300n, variant) > expectedRound(variant.anchorDaa, variant));
}

const round = 123n;
const signature = Buffer.from(
  "b75c69d0b72a5d906e854e808ba7e2accb1542ac355ae486d591aa9d43765482e26cd02df835d3546d23c4b13e0dfc92",
  "hex"
);
const randomness = crypto.createHash("sha256").update(signature).digest();
const roundLe = Buffer.alloc(8);
roundLe.writeBigUInt64LE(round);
const journalDigest = crypto.createHash("sha256").update(Buffer.concat([roundLe, randomness])).digest("hex");
assert.equal(journalDigest.length, 64);

const ticketRoot = Buffer.alloc(32, 0x42);
const winnerSeed = crypto.createHash("sha256").update(Buffer.concat([ticketRoot, randomness])).digest();
let sample = 0n;
for (let index = 0; index < 7; index += 1) sample += BigInt(winnerSeed[index]) << BigInt(index * 8);
const winner = sample % 1_000_000n;
assert.ok(winner >= 0n && winner < 1_000_000n);

console.log(`V8 fixed-image contracts passed for Mainnet and TN12. Journal ${journalDigest}; sample winner ${winner}.`);
