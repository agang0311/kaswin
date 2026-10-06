/** PASS-A draw proof (V2 SEALED -> DRAW_AND_PAY), built with the pinned core acquirePassA() over JSON wRPC from the
 * configured node. The proof is self-checking (SMT lane proof + header sequencing commitments), and at spend time
 * every node re-checks it on-chain with OpChainblockSeqCommit, so a wrong proof cannot produce a valid payout; it would
 * only make the transaction fail. The winner is predicted with the same transition the contract enforces
 * (authenticateDraw -> sample -> winnerRecord). A rejected sample is NOT re-drawn: the round can then only exit through
 * TIMEOUT_REFUND (protocol rule, no alternative randomness source).
 */
import {S, ensure, acquirePassA, authenticateDraw, sample, winnerRecord, hex, errorText, SEQ_COMMIT_DEPTH} from './core.mjs';
import {uint} from './lib/json.mjs';
import {host} from './nodes.mjs';

function providerFor(rpc, live) {
  const out0 = live.acceptedTx.tx.outputs[live.snapshot.tip.index];
  return {
    // The SEALED state's creating transaction (CLOSE) was already verified accepted by liveRound().
    getAcceptedClose: async txid => { ensure(txid === live.snapshot.tip.transactionId, 'CLOSE_TXID'); return {isAccepted: true, acceptingBlockHash: live.accepting, output0: {amount: out0.value, scriptPublicKey: out0.scriptPublicKey.script, covenantId: out0.covenant.covenantId}}; },
    getSinkBlueScore: () => rpc.call('getSinkBlueScore'),
    getVirtualChainFromBlockV2: arg => rpc.call('getVirtualChainFromBlockV2', {...arg, dataVerbosityLevel: 'Low'}, 60000),
    getBlock: arg => rpc.call('getBlock', arg, 45000),
    getSeqCommitLaneProof: (h, k) => rpc.call('getSeqCommitLaneProof', {blockHash: h, laneKey: k}, 60000),
  };
}

export async function acquireDrawProof(link, profile, live, onStatus = () => {}) {
  const s = live.ledger, x = live.snapshot;
  ensure(s.phase === S.Phase.SEALED, '轮次不在封存阶段');
  ensure(x.currentDaa >= x.utxoDaa + S.DRAW_DELAY, `封存后需等待 ${S.DRAW_DELAY} DAA`);
  const [n] = await link.connect();
  onStatus(`节点 ${host(n.url)}：定位首个跨越边界的选中链区块并构造证明…`);
  let p;
  try { p = await acquirePassA(x, profile, providerFor(n, live)); }
  catch (e) { throw new Error(`节点 ${host(n.url)} 未能构造 PASS-A：${errorText(e)}`); }
  // OpChainblockSeqCommit only resolves the target within finality depth of the spending block's selected parent.
  const sink = uint((await n.call('getSinkBlueScore')).blueScore);
  const tBlue = uint((await n.call('getBlock', {hash: p.target.hash, includeTransactions: false})).block.header.blueScore);
  ensure(sink - tBlue < SEQ_COMMIT_DEPTH - 1000n, '开奖目标区块已超出共识可访问深度（约 12 小时），只能等待超时退款');
  // Predict exactly what the contract will compute.
  const drawn = authenticateDraw(x, s, p.opening, {blockHash: p.target.hash, sequenceCommitment: p.target.seqCommit});
  const smp = sample(drawn);
  ensure(smp.ticket !== null, '本轮随机样本落入拒绝区间（概率 < 1/2^40 量级）。协议不允许重抽，只能在超时后转退款。', 'SAMPLE_REJECTED');
  const accepted = {...drawn, phase: S.Phase.WINNER_READY, winnerPlusOne: smp.ticket + 1};
  const idx = winnerRecord(accepted), rec = S.records(accepted)[idx];
  return {opening: p.opening, openingHex: p.openingHex, target: p.target, parent: p.parent, boundaryDaa: p.boundaryDaa,
    nodes: [host(n.url)], seed: drawn.seed,
    winner: {ticket: smp.ticket + 1, record: idx, key: rec.key, recordTickets: rec.count, sampleValue: smp.value.toString(), limit: smp.limit.toString()}};
}

/** Offline replay of an archived draw (no network): recompute seed → ticket → record from a SEALED ledger + opening. */
export function replayDraw(profile, snapshot, ledger, openingHex, target) {
  const opening = Uint8Array.from(openingHex.match(/../g), b => parseInt(b, 16));
  const drawn = authenticateDraw({...snapshot, currentDaa: snapshot.utxoDaa + S.DRAW_DELAY}, ledger, opening, target);
  const smp = sample(drawn);
  if (smp.ticket === null) return {rejected: true, seed: drawn.seed};
  const accepted = {...drawn, phase: S.Phase.WINNER_READY, winnerPlusOne: smp.ticket + 1}, idx = winnerRecord(accepted);
  return {seed: drawn.seed, ticket: smp.ticket + 1, record: idx, key: S.records(accepted)[idx].key, sampleValue: smp.value, limit: smp.limit};
}
export {hex};
