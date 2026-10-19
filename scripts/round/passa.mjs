/** V2.0.2 transient draw, never a phase-3/4 ledger. Confirmation is Web/CLI policy, not consensus. */
import {S, ensure, acquirePassA, drawWinner, authenticateDraw, sample, recordOfTicket, unhex, errorText, stable} from '../core.mjs';
import {host} from '../chain/nodes.mjs';
import {drawTargetFromOpening, requireConfirmedDrawTarget, waitForConfirmedDraw, assertFreshDrawConfirmation, DRAW_REUSE_MS} from './draw-confirmations.mjs';
import {decodeSpend} from '../core/lib/accepted.js';
import {withDeadline, scopedLink, failure, queryContext, sameQueryContext} from '../chain/operation.mjs';

import {requireRuntimeProfile} from '../contract/runtime.mjs';

export function providerFor(rpc, live) {
  const out0 = live.acceptedTx.tx.outputs[live.snapshot.tip.index];
  return {
    getAcceptedClose: async txid => { ensure(txid === live.snapshot.tip.transactionId, 'CLOSE_TXID'); return {isAccepted: true, acceptingBlockHash: live.accepting, output0: {amount: out0.value, scriptPublicKey: out0.scriptPublicKey.script, covenantId: out0.covenant.covenantId}}; },
    getSinkBlueScore: () => rpc.call('getSinkBlueScore'),
    getVirtualChainFromBlockV2: arg => rpc.call('getVirtualChainFromBlockV2', {...arg, dataVerbosityLevel: 'Low'}, 30_000),
    getBlock: arg => rpc.call('getBlock', arg, 30_000),
    getSeqCommitLaneProof: (h, k) => rpc.call('getSeqCommitLaneProof', {blockHash: h, laneKey: k}, 30_000),
  };
}
const proofCache = new WeakMap();
function invalidateFailedTarget(link, target, error) {
  if (error?.safeCode !== 'DRAW_TARGET_UNCONFIRMED') {
    const cache = proofCache.get(queryContext(link).node);
    for (const [key, entry] of cache ?? []) if (entry.proof.target.hash === target.hash) cache.delete(key);
  }
  throw error;
}
/** Same sealed outpoint/DAA/ledger and connection only; confirmation depth is checked separately on every use. */
export async function acquireRoundProof(rpc, profile, live) {
  requireRuntimeProfile(profile);
  const x = live.snapshot, s = live.ledger;
  if (s.phase !== S.Phase.SEALED || x.currentDaa < x.utxoDaa + S.DRAW_DELAY) throw failure('DRAW_NOT_READY');
  // PASS-A needs the accepted SEALED body. A sealed state already below the pruning point is far past the draw window.
  ensure(live.acceptedTx, '封存交易的接受块已被节点裁剪，无法取得开奖证明；该轮应走超时退款', 'DRAW_HISTORY_PRUNED');
  const context = queryContext(rpc), key = stable({profile: profile.id, snapshot: {...x, currentDaa: null}, accepting: live.accepting});
  let cache = proofCache.get(context.node);
  if (!cache) { cache = new Map(); proofCache.set(context.node, cache); }
  const previous = cache.get(key), now = Date.now();
  if (previous && sameQueryContext(previous.context, context) && now >= previous.at && now - previous.at < 30000)
    return structuredClone(previous.proof);
  const proof = await acquirePassA(x, profile, providerFor(rpc, live));
  if (sameQueryContext(context, queryContext(rpc))) {
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    cache.set(key, {context, at: now, proof: structuredClone(proof)});
  }
  return proof;
}
function winnerFor(profile, live, p) {
  const w = drawWinner(live.snapshot, live.ledger, p.opening, {blockHash: p.target.hash, sequenceCommitment: p.target.seqCommit});
  const rec = S.records(live.ledger)[w.record];
  return {ticket: w.ticket + 1, record: w.record, key: rec.key, seed: w.draw.seed, target: p.target.hash,
    recordTickets: rec.count, sampleValue: w.sample.value.toString(), limit: w.sample.limit.toString()};
}
export async function acquireConfirmedDrawProof(link, profile, live) {
  requireRuntimeProfile(profile);
  const [rpc] = await link.connect(), p = await acquireRoundProof(rpc, profile, live);
  const target = drawTargetFromOpening(p.opening);
  const confirmation = await requireConfirmedDrawTarget(rpc, target, {maxAgeMs: DRAW_REUSE_MS})
    .catch(e => invalidateFailedTarget(rpc, target, e));
  return {opening: p.opening, accessor: {blockHash: p.target.hash, sequenceCommitment: p.target.seqCommit},
    confirmation, winner: winnerFor(profile, live, p)};
}
export async function acquireDrawProof(link, profile, live, onStatus = () => {}) {
  requireRuntimeProfile(profile);
  const s = live.ledger, x = live.snapshot;
  ensure(s.phase === S.Phase.SEALED, '轮次不在封存阶段');
  ensure(x.currentDaa >= x.utxoDaa + S.DRAW_DELAY, `封存后需等待 ${S.DRAW_DELAY} DAA`);
  const [rpc] = await link.connect();
  onStatus(`节点 ${host(rpc.url)}：定位首个跨越边界的选中链区块并构造证明…`);
  let p;
  try { p = await acquireRoundProof(rpc, profile, live); }
  catch (e) { throw new Error(`节点 ${host(rpc.url)} 未能构造 PASS-A：${errorText(e)}`); }
  const winner = winnerFor(profile, live, p);
  return {...p, nodes: [host(rpc.url)], seed: winner.seed, winner};
}
/** Bounded planning wait. All acquisition functions, including injected ones, must pass this gate. */
export async function waitForDrawTarget(link, opening, onStatus = () => {}) {
  const target = drawTargetFromOpening(opening);
  return withDeadline(scope => waitForConfirmedDraw(() => requireConfirmedDrawTarget(scopedLink(link, scope), target, {maxAgeMs: DRAW_REUSE_MS}), scope,
    {onWait: x => onStatus(`开奖目标块确认 ${x.confirmations}/100（blue score）；仅查询，不提交…`),
      onRetry: () => onStatus('正在重新核对开奖目标确认…')}),
    {timeoutMs: 30_000, code: 'DRAW_CONFIRMATION_TIMEOUT'}).catch(e => invalidateFailedTarget(link, target, e));
}
/** Decode the actual witness (not mutable plan labels) before signing and immediately before transport. */
export async function checkDraftDraw(link, draft, profile, origin, options = {maxAgeMs: DRAW_REUSE_MS}) {
  requireRuntimeProfile(profile);
  if (!draft.inputUtxos[0]?.covenantId) { ensure(draft.action === 'CREATE_ROUND', 'SEALED_SNAPSHOT_REQUIRED'); return null; }
  const w = decodeSpend(draft.transaction.inputs[0].signatureScript, profile, origin);
  ensure(w.action === draft.action, 'DRAFT_ACTION_MISMATCH');
  if (w.action !== 'DRAW_AND_PAY') return null;
  ensure(w.data.length === 244, 'DRAW_PROOF_MISSING');
  const target = drawTargetFromOpening(w.data.slice(0, 240));
  return requireConfirmedDrawTarget(link, target, options).catch(e => invalidateFailedTarget(link, target, e));
}
/** Readiness display: a target that left the selected chain (short reorg) or is too deep must not be served from the
 * proof cache again, so the next read re-locates the first-crossing block. Other failures keep the cached proof. */
export function confirmRoundTarget(rpc, target, options) {
  return requireConfirmedDrawTarget(rpc, target, options)
    .catch(e => { if (e?.safeCode === 'PROOF_CONTEXT_INVALID') return invalidateFailedTarget(rpc, target, e); throw e; });
}
export function fenceDraw(observation, link = null) { if (observation) assertFreshDrawConfirmation(observation, observation, Date.now(), link); }
/** Historical replay does NOT retroactively impose our submission confirmation policy. */
export function replayDraw(profile, snapshot, ledger, openingHex, target) {
  requireRuntimeProfile(profile);
  const draw = authenticateDraw({...snapshot, currentDaa: snapshot.utxoDaa + S.DRAW_DELAY}, ledger, unhex(openingHex), target);
  const smp = sample(draw.seed, ledger.sold);
  if (smp.ticket === null) return {rejected: true, seed: draw.seed};
  const idx = recordOfTicket(ledger, smp.ticket);
  return {seed: draw.seed, ticket: smp.ticket + 1, record: idx, key: S.records(ledger)[idx].key, sampleValue: smp.value, limit: smp.limit};
}
