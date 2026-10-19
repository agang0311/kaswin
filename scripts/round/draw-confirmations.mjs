// KW21 target-confirmation helpers for V2.0.2. Client policy, NOT consensus finality or acceptance.
// cfafeb4: selected-chain blue score increases along selected parents. A retained C >= T+100 bounds depth.
import {decodeSpend, targetSeqOf} from '../core/lib/accepted.js';
import {fromLe, hex} from '../core/lib/bytes.js';
import {uint} from '../chain/json.mjs';
import {LIMITS, failure, pause, queryContext, sameConnectionContext, withDeadline, scopedLink} from '../chain/operation.mjs';

export const DRAW_MIN_CONFIRMATIONS = 100n;
export const DRAW_MAX_TARGET_DEPTH = 432_000n - 1000n;
export const DRAW_POLICY = Object.freeze({metric: 'sink.blueScore - target.blueScore', minConfirmations: '100',
  boundary: 'Client policy for the actual PASS-A first-crossing target; not irreversible finality'});
const need = (v, code) => { if (!v) throw failure(code); };
const confirmationCache = new WeakMap(), provenance = new WeakMap();
const targetKey = t => `${t.hash}/${t.sequenceCommitment}/${t.blueScore}`;
const unchanged = (a, b) => a.node === b.node && a.socket === b.socket && a.epoch === b.epoch && a.revision === b.revision;
export const DRAW_REUSE_MS = 5000;

export function drawTargetFromOpening(opening) {
  need(opening instanceof Uint8Array && opening.length === 240, 'PASS_A_LENGTH');
  const blueScore = fromLe(opening.slice(112, 120));
  need(blueScore < 1n << 63n, 'PASS_A_INTEGER');
  return {hash: hex(opening.slice(0, 32)), sequenceCommitment: targetSeqOf(opening), blueScore};
}
export function drawTargetFromRecord(record, profile) {
  if (!record.snapshot) {
    need(!record.draft.inputUtxos[0]?.covenantId && record.draft.action !== 'DRAW_AND_PAY', 'SEALED_SNAPSHOT_REQUIRED');
    return null;
  }
  const tx = record.signed ?? record.draft.transaction;
  const w = decodeSpend(tx.inputs[0].signatureScript, profile, record.snapshot.origin);
  need(w.action === record.draft.action, 'DRAFT_ACTION_MISMATCH');
  if (w.action !== 'DRAW_AND_PAY') return null;
  need(w.data.length === 244, 'DRAW_PROOF_MISSING');
  return drawTargetFromOpening(w.data.slice(0, 240));
}
function track(context, hash) {
  const node = context.node;
  if (typeof node.observeChainBlock !== 'function' || typeof node.chainBlockCurrent !== 'function') return null;
  const entry = node.observeChainBlock(hash);
  return {entry, revision: entry.revision};
}
function current(source, link) {
  const a = source.context, b = queryContext(link);
  if (a.node !== b.node || a.socket !== b.socket || a.epoch !== b.epoch || (a.socket && a.socket.readyState !== 1)) return false;
  if (!source.coverage || !a.node.chainObservationCurrent(source.coverage)) return false;
  // Without a retained depth anchor, keep the conservative global-revision fence.
  if (!source.targetTrack || !source.anchorTrack) return unchanged(a, b);
  return [source.targetTrack, source.anchorTrack].every(t => a.node.chainBlockCurrent(t.entry, t.revision));
}
/** C is NOT the random target. Its retained chain membership guarantees the minimum depth even after tip rollback.
 * Register invalidation before reading each header; unknown revisions/eviction/removed-and-readded hashes fail closed. */
async function confirmationAnchor(link, target, context) {
  let hash = (await link.call('getSink')).sink;
  for (let i = 0; i < 4; i++) {
    const token = track(context, hash);
    const b = (await link.call('getBlock', {hash, includeTransactions: false})).block;
    need(b?.header?.hash === hash, 'BLOCK_HASH_MISMATCH');
    need(typeof b.verboseData?.isChainBlock === 'boolean', 'PROOF_CONTEXT_UNKNOWN');
    if (!b.verboseData.isChainBlock) { hash = b.verboseData.selectedParentHash; continue; }
    const blue = uint(b.header.blueScore);
    if (blue < target.blueScore + DRAW_MIN_CONFIRMATIONS) return null;
    // Prefer a sufficiently deep selected parent, so a one-block tip replacement does not invalidate C needlessly.
    const parentHash = b.verboseData.selectedParentHash;
    if (blue > target.blueScore + DRAW_MIN_CONFIRMATIONS && /^[0-9a-f]{64}$/.test(parentHash ?? '')) {
      const parentToken = track(context, parentHash);
      const parent = (await link.call('getBlock', {hash: parentHash, includeTransactions: false})).block;
      need(parent?.header?.hash === parentHash, 'BLOCK_HASH_MISMATCH');
      need(typeof parent.verboseData?.isChainBlock === 'boolean', 'PROOF_CONTEXT_UNKNOWN');
      need(parent.verboseData.isChainBlock, 'DRAW_CONFIRMATION_STALE');
      const parentBlue = uint(parent.header.blueScore);
      need(parentBlue < blue, 'DRAW_TARGET_HEADER_MISMATCH');
      if (parentBlue >= target.blueScore + DRAW_MIN_CONFIRMATIONS) return {hash: parentHash, blueScore: parentBlue, token: parentToken};
    }
    return {hash, blueScore: blue, token};
  }
  throw failure('DRAW_CONFIRMATION_STALE');
}

/** Fresh by default. Explicit reuse has verifier provenance, the same connection, target/depth guards and a short TTL. */
export async function requireConfirmedDrawTarget(link, target, {maxAgeMs = 0} = {}) {
  need(Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0 && maxAgeMs <= DRAW_REUSE_MS, 'DRAW_REUSE_AGE');
  return withDeadline(async scope => {
    const rpc = scopedLink(link, scope);
    await rpc.connect?.();
    const before = queryContext(link), node = before.node;
    need(typeof node.holdChainObservation === 'function' && typeof node.chainObservationCurrent === 'function', 'CHAIN_OBSERVATION_REQUIRED');
    const coverage = await node.holdChainObservation(), context = queryContext(link);
    scope.check();
    need(sameConnectionContext(before, context) && node.chainObservationCurrent(coverage), 'DRAW_CONFIRMATION_STALE');
    const key = targetKey(target), now = Date.now();
    const previous = confirmationCache.get(context.node)?.get(key);
    if (maxAgeMs && previous?.observation && now >= previous.observation.observedAt && now - previous.observation.observedAt < maxAgeMs) {
      try { assertFreshDrawConfirmation(previous.observation, target, now, link); return previous.observation; }
      catch (e) { if (e?.safeCode !== 'DRAW_CONFIRMATION_STALE') throw e; }
    }
    const cache = confirmationsCache(context.node), attempt = {context, coverage, targetTrack: track(context, target.hash), anchorTrack: null};
    cache.set(key, attempt); // New failed/late checks must never revive an older positive observation.
    try {
      const b = (await rpc.call('getBlock', {hash: target.hash, includeTransactions: false})).block;
      need(b?.header?.hash === target.hash, 'BLOCK_HASH_MISMATCH');
      if (b.verboseData?.isChainBlock === false) throw failure('PROOF_CONTEXT_INVALID');
      need(b.verboseData?.isChainBlock === true, 'PROOF_CONTEXT_UNKNOWN');
      const blue = uint(b.header.blueScore);
      need(blue === target.blueScore && b.header.acceptedIdMerkleRoot === target.sequenceCommitment, 'DRAW_TARGET_HEADER_MISMATCH');
      const anchor = attempt.targetTrack ? await confirmationAnchor(rpc, target, context) : null;
      attempt.anchorTrack = anchor?.token ?? null;
      const sink = uint((await rpc.call('getSinkBlueScore')).blueScore);
      need(sink >= blue && (!anchor || sink >= anchor.blueScore), 'SINK_BEHIND');
      const confirmations = sink - blue;
      need(confirmations < DRAW_MAX_TARGET_DEPTH, 'PROOF_CONTEXT_INVALID');
      const observation = Object.freeze({...target, sinkBlueScore: sink, confirmations, observedAt: now,
        anchor: anchor ? Object.freeze({hash: anchor.hash, blueScore: anchor.blueScore}) : null});
      scope.check();
      if (confirmations < DRAW_MIN_CONFIRMATIONS) throw Object.assign(failure('DRAW_TARGET_UNCONFIRMED'), {drawConfirmation: observation});
      need(current(attempt, link) && cache.get(key) === attempt, 'DRAW_CONFIRMATION_STALE');
      provenance.set(observation, {...attempt, key}); attempt.observation = observation;
      assertFreshDrawConfirmation(observation, target, Date.now(), link);
      return observation;
    } catch (e) {
      if (cache.get(key) === attempt) cache.delete(key);
      throw e;
    }
  }, {timeoutMs: LIMITS.rpcMs, code: 'DRAW_CONFIRMATION_STALE'});
}
function confirmationsCache(node) {
  let cache = confirmationCache.get(node);
  if (!cache) { cache = new Map(); confirmationCache.set(node, cache); }
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  return cache;
}
export async function requireConfirmedDrawRecord(link, record, profile, options) {
  const target = drawTargetFromRecord(record, profile);
  return target ? requireConfirmedDrawTarget(link, target, options) : null;
}

/** Synchronous transport fence. No retries or sends here; only a current verifier-owned observation authorizes. */
export function assertFreshDrawConfirmation(observation, target, now = Date.now(), link = null) {
  if (link) {
    const source = provenance.get(observation), context = source?.context;
    need(source && current(source, link) && confirmationCache.get(context.node)?.get(source.key)?.observation === observation, 'DRAW_CONFIRMATION_STALE');
  }
  need(observation?.hash === target.hash && observation.sequenceCommitment === target.sequenceCommitment && observation.blueScore === target.blueScore,
    'DRAW_TARGET_HEADER_MISMATCH');
  need(observation.confirmations >= DRAW_MIN_CONFIRMATIONS && observation.confirmations < DRAW_MAX_TARGET_DEPTH, 'DRAW_TARGET_UNCONFIRMED');
  need(Number.isSafeInteger(observation.observedAt) && now >= observation.observedAt && now - observation.observedAt < LIMITS.rpcMs, 'DRAW_CONFIRMATION_STALE');
}

/** Bounded/cancellable planning wait. Retry reads of the SAME T, never a redraw, signature or broadcast. */
export async function waitForConfirmedDraw(task, scope, {check = () => {}, onWait = () => {}, onRetry = () => {}, pollMs = 2000} = {}) {
  for (;;) {
    scope.check(); check();
    try { const proof = await task(); scope.check(); check(); return proof; }
    catch (e) {
      scope.check(); check();
      const code = e?.safeCode ?? e?.code;
      if (code === 'DRAW_TARGET_UNCONFIRMED') onWait(e.drawConfirmation);
      else if (code === 'DRAW_CONFIRMATION_STALE' || code === 'READ_VIEW_CHANGED') onRetry(e);
      else throw e;
      await pause(pollMs, scope.signal);
    }
  }
}
