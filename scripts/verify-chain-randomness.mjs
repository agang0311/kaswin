import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sources = ["raffle_round_v13.sil"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

for (const name of sources) {
  const source = fs.readFileSync(path.join(root, "src/contracts", name), "utf8");
  assert(source.includes("target_boundary = refund_after_daa + RANDOM_DELAY_DAA"), `${name} fixes an unsold round's randomness after ticket sales close`);
  assert(source.includes("target_boundary = OpTxInputDaaScore(this.activeInputIndex) + RANDOM_DELAY_DAA"), `${name} fixes a sold-out round's randomness after its final ticket`);
  assert(source.includes("OpBin2Num(seed.slice(0, 1) + 0x00)"), `${name} decodes random bytes as unsigned script numbers`);
  assert(source.includes("OpChainblockSeqCommit(target_hash)"), `${name} binds the random block to the selected chain`);
  assert((source.match(/OpChainblockSeqCommit\(/g) ?? []).length === 1, `${name} uses one fixed on-chain randomness beacon`);
  assert(source.includes("parent_daa < target_boundary && target_daa >= target_boundary"), `${name} accepts only the unique selected-chain boundary crossing`);
  assert(source.includes("target_before_daa.slice(18, 50)) == parent_hash"), `${name} binds the target header to its selected parent`);
  assert(source.includes("blockHash(parent_before_daa") && source.includes("byte[32] target_hash = blockHash(target_before_daa"), `${name} rehashes both supplied headers inside the covenant`);
  assert(source.includes("sha256(byte[](ticket_root) + byte[](target_hash) + byte[](seqcommit))"), `${name} binds the seed to tickets, proof of work, and chain sequencing`);
  assert(source.includes("require(winner_ticket_id == winner_from_seed)"), `${name} rejects a caller-selected winner`);
  assert(source.includes("merkleRoot(ticketBatchLeaf(winner_pubkey, winner_batch_start, winner_batch_count), winner_batch_index, winner_proof) == ticket_root"), `${name} binds the winning number to its committed purchase range`);
  assert(source.includes("tx.outputs[0].scriptPubKey == byte[](new ScriptPubKeyP2PK(winner_pubkey))") && source.includes("tx.outputs[0].value == prize"), `${name} enforces the prize address and amount`);
  assert(source.includes("require(tx.inputs.length == 1)"), `${name} allows a signature-free public draw trigger`);
  assert(source.includes("require(tx.outputs.length == 2)"), `${name} pays only the winner and returns the carrier remainder`);
  assert(source.includes("finalize_fee > 0 && finalize_fee <= MAX_FINALIZE_FEE"), `${name} caps the caller-supplied mass fee`);
  assert(!/caller_pubkey|caller_ticket_id|caller_proof/.test(source), `${name} does not require a participant authorization proof`);
  assert(source.includes("OpTxInputDaaScore(this.activeInputIndex) < refund_after_daa"), `${name} stops repeated buys after timeout`);
  assert(!source.includes("entrypoint function close"), `${name} finalizes without a close transaction`);
  assert(!/drand|groth16|oracle|random_anchor/i.test(source), `${name} has no external randomness dependency`);
}

const client = fs.readFileSync(path.join(root, "src/kaspa/chain-randomness.ts"), "utf8");
const app = fs.readFileSync(path.join(root, "src/app/App.tsx"), "utf8");
const raffleTypes = fs.readFileSync(path.join(root, "src/raffle/types.ts"), "utf8");
assert(client.includes('BigInt(`0x${normalized}`)'), "RPC blue work is always decoded as hexadecimal");
assert(client.includes("candidate.finalize()"), "node headers are rehashed before building a witness");
assert(client.includes("target.daaScore >= targetDaa && parent.daaScore < targetDaa"), "client selects the same boundary crossing enforced by the covenant");
assert(client.includes("target.parentsByLevel[0]?.[0]?.toLowerCase() !== parent.hash.toLowerCase()"), "client rejects a non-selected parent before submission");
assert(client.includes("while (low < high)") && client.includes("Math.floor((low + high) / 2)"), "anchored header lookup uses logarithmic selected-chain search");
assert(client.includes("BLOCK_LOOKUP_RETRIES = 3") && !client.includes("Promise.all(page.map"), "slow public nodes are retried without an unbounded concurrent block scan");
assert(client.includes("loadFromCandidates") && client.includes("candidateHashes.slice(0, 32)"), "untrusted blue-score lookup hints are bounded and revalidated through Kaspa RPC");
assert(!/indexer|fetch\(|https?:|oracle|attestation/i.test(client), "randomness is loaded only from the configured Kaspa RPC node");
assert(!/buyerCommitment|creatorCommitment|buyerSecret/.test(`${app}\n${raffleTypes}`), "client has no legacy commit-reveal state");

console.log("Chain-only randomness checks passed.");
