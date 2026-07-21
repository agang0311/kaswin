import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sources = ["raffle_round_v16.sil"];

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
const history = fs.readFileSync(path.join(root, "src/kaspa/history.ts"), "utf8");
assert(client.includes('BigInt(`0x${normalized}`)'), "RPC blue work is always decoded as hexadecimal");
assert(client.includes("candidate.finalize()"), "node headers are rehashed before building a witness");
assert(client.includes("target.daaScore >= targetDaa && parent.daaScore < targetDaa"), "client selects the same boundary crossing enforced by the covenant");
assert(client.includes("target.parentsByLevel[0]?.[0]?.toLowerCase() !== parent.hash.toLowerCase()"), "client rejects a non-selected parent before submission");
assert(client.includes("targetResponse.block.verboseData?.isChainBlock !== true") && client.includes("parentResponse.block.verboseData?.isChainBlock !== true"), "candidate blocks are revalidated as selected-chain blocks through Kaspa RPC");
assert(history.includes("return blockHintHashes(chainBlocks)") && history.includes("return blockHintHashes(forwardChain)"), "history lookup never returns non-chain blocks as randomness candidates");
assert(client.includes("while (low < high)") && client.includes("Math.floor((low + high) / 2)"), "anchored header lookup uses logarithmic selected-chain search");
assert(client.includes("BLOCK_LOOKUP_RETRIES = 3") && !client.includes("Promise.all(page.map"), "slow public nodes are retried without an unbounded concurrent block scan");
assert(client.includes("WITNESS_LOOKUP_TIMEOUT_MS = 45_000") && client.includes("Randomness witness lookup"), "randomness lookup has a bounded end-to-end timeout");
assert(client.includes("ANCHOR_BLOCK_TIMEOUT_MS = 5_000") && client.includes("ANCHORED_HEADERS_TIMEOUT_MS = 8_000") && client.includes("VIRTUAL_CHAIN_TIMEOUT_MS = 12_000"), "a slow anchor RPC probe cannot consume the full randomness deadline");
assert(client.includes("CANDIDATE_LOOKUP_BUDGET_MS = 12_000") && client.includes("CANDIDATE_BLOCK_TIMEOUT_MS, 1"), "candidate header hints have a bounded no-retry fallback budget");
assert(client.includes("retention root"), "public-node retention-root header lookup failures fall through to alternate randomness lookup paths");
assert(client.includes("includeVirtualChain = true") && client.includes("loadFromAnchor(connection, anchorHash, targetBoundaryDaa, false)") && client.indexOf("pair = await loadFromCandidates") < client.lastIndexOf("pair = await loadFromAnchor(connection, anchorHash, targetBoundaryDaa)"), "candidate hints run before the slower virtual-chain anchor fallback");
assert(client.includes("SINK_HEADERS_TIMEOUT_MS = 6_000") && client.includes("SINK_HEADERS_LOOKUP_BUDGET_MS = 10_000") && client.includes("Date.now() < deadline"), "sink header fallback has a bounded per-request and total budget");
assert(client.includes('withRpcTimeout(connection.client.getBlockDagInfo(), "DAG information lookup")') && client.includes('"Selected-chain header lookup"'), "DAG and header RPC lookups cannot leave the draw UI waiting forever");
assert(client.includes('isAscending: true') && client.includes('"Anchored selected-chain header lookup"') && client.includes("MAX_ANCHORED_HEADER_DISTANCE"), "old rounds can locate the random boundary from their confirmed chain anchor");
assert(client.includes("loadFromCandidates") && client.includes("candidateHashes.slice(0, 32)"), "untrusted blue-score lookup hints are bounded and revalidated through Kaspa RPC");
assert(client.indexOf("pair = await loadFromAnchor") < client.indexOf("pair = await loadFromCandidates"), "confirmed round anchors are tried before optional history hints");
assert(client.includes("loadFromRestHistory") && client.includes("const target = headerWitness(pair.target)") && client.includes("const parent = headerWitness(pair.parent)"), "a REST transport fallback still rehashes both candidate headers before submission");
assert(client.includes("parent.daaScore < targetDaa") && client.includes("target.parentsByLevel[0]?.[0]?.toLowerCase() !== parent.hash.toLowerCase()"), "REST candidates must cross the selected-chain DAA boundary with the expected parent");
assert(client.includes("walkRestSelectedParents") && client.includes("REST_SELECTED_PARENT_WALK_LIMIT = 256"), "REST fallback can walk selected parents when the first history candidate is after the random DAA boundary");
assert(client.includes("blueScoreLt=${probeBlue + 1n}") && client.includes("candidate.blueScore - (candidate.daaScore - targetDaa)"), "REST fallback corrects backwards when blue-score estimation lands after the target DAA");
assert(client.includes("loadRestSelectedChainChildren") && client.includes("childrenHashes") && client.includes("child.verboseData?.isChainBlock !== true"), "REST fallback can recover when the blue-score probe lands on a non-chain block with selected-chain children");
assert(!/buyerCommitment|creatorCommitment|buyerSecret/.test(`${app}\n${raffleTypes}`), "client has no legacy commit-reveal state");

console.log("Chain-only randomness checks passed.");
