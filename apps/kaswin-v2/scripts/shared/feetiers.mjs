/** Network fee conditions and wait estimates, from the node's own estimator (rusty-kaspa v2.1.0, the version the
 * default TN10 node reports; mining/src/feerate/mod.rs):
 *   time(f) = c1 + c1·c2 / f^ALPHA, ALPHA = 3 (mining/src/mempool/model/frontier/selectors.rs);
 *   priority bucket = expected inclusion in the next block, normal = sub-minute (and >= the 0.66 quantile),
 *   low = sub-hour (and >= the 0.25 quantile); all clamped below by the minimum standard feerate.
 * The buckets are points on that one curve, so two distinct points fix c1 and K = c1·c2 and the curve gives an estimate
 * for any feerate (sompi per gram of ordering mass max(compute, normalized transient, storage)).
 * When the ready mempool fits into one block (total ordering mass <= 500,000), the block template takes every ready
 * transaction regardless of feerate (mining/src/mempool/model/frontier.rs build_selector, TakeAllSelector).
 * DISPLAY ONLY: these Numbers never price a transaction; amounts stay bigint in mass.mjs. */
import {ensure} from './core.mjs';

export const BLOCK_MASS = 500_000;
export const FEE_TIERS = Object.freeze(['economy', 'fast']);

const bucket = x => x && typeof x.feerate === 'number' && Number.isFinite(x.feerate) && x.feerate > 0
  && typeof x.estimatedSeconds === 'number' && Number.isFinite(x.estimatedSeconds) && x.estimatedSeconds >= 0
  ? {feerate: x.feerate, seconds: x.estimatedSeconds} : null;
const count = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** getFeeEstimate / getFeeEstimateExperimental response -> conditions. `verbose` (optional) is the experimental call's
 * verbose block; missing or malformed verbose data is dropped, never guessed. */
export function parseFeeEstimate(response, verbose = null, checkedAt = Date.now()) {
  const est = response?.estimate ?? {};
  const normal = bucket(est.normalBuckets?.[0]) ?? bucket(est.priorityBucket);
  ensure(normal, '节点未返回费率');
  const priority = bucket(est.priorityBucket) ?? normal;
  const low = bucket(est.lowBuckets?.[0]) ?? bucket(est.normalBuckets?.at(-1)) ?? normal;
  let mempool = null;
  if (verbose) {
    const readyCount = count(verbose.mempoolReadyTransactionsCount), readyMass = count(verbose.mempoolReadyTransactionsTotalMass);
    if (readyCount !== null && readyMass !== null) mempool = {readyCount, readyMass, massPerSecond: count(verbose.networkMassPerSecond)};
  }
  return {low, normal, priority, mempool, checkedAt};
}

/** The ready mempool fits into one block (everything is taken), or the estimator collapsed to a single feerate. */
export const isIdle = c => (c.mempool !== null && c.mempool.readyMass <= BLOCK_MASS) || !(c.priority.feerate > c.low.feerate * (1 + 1e-9));

/** Estimated seconds until inclusion for an ordering feerate (sompi/gram), on the node's own curve; null if the curve
 * cannot be fitted. Never below the next-block estimate. */
export function waitSeconds(c, feerate) {
  ensure(typeof feerate === 'number' && Number.isFinite(feerate) && feerate > 0, '费率无效');
  if (isIdle(c)) return c.priority.seconds;
  const a = c.priority, z = c.low;
  if (!(z.seconds > a.seconds)) return feerate >= a.feerate ? a.seconds : null;
  const K = (z.seconds - a.seconds) / (z.feerate ** -3 - a.feerate ** -3);
  if (!(K > 0) || !Number.isFinite(K)) return null;
  const c1 = Math.max(0, a.seconds - K * a.feerate ** -3), t = c1 + K / feerate ** 3;
  return Number.isFinite(t) ? Math.max(t, a.seconds) : null;
}

/** Recommend economy when it costs the same, the network is idle, or it is expected within a minute (the node's own
 * "normal" target). Below the low bucket on a busy network the curve is not a useful promise (the estimator models
 * steady load; a ready mempool that shrinks below one block takes everything), so fast is recommended there. */
export function recommendTier(c, economy, fast) {
  if (economy.fee >= fast.fee || isIdle(c)) return 'economy';
  const t = economy.waitSeconds;
  return !economy.belowLow && t !== null && t <= 60 ? 'economy' : 'fast';
}

/** Ordering feerate of a priced draft as a display Number (fee and mass are bigint). */
export const orderingRate = priced => Number(priced.fee) / Number(priced.orderingMass);
