/** Which round view to DISPLAY. Pure: no network, no trust decision — every action still re-reads and re-verifies the
 * round on the configured node (liveRound), whatever is shown here.
 *
 * Kaswin V2 transitions follow one graph and every accepted one strictly increases (terminal, phase, purchaseCount, cursor):
 *   BUY: OPEN, purchaseCount + 1        CLOSE: OPEN -> SEALED | REFUNDING | EMPTY
 *   DRAW_AND_PAY: SEALED -> PAID        TIMEOUT_REFUND: SEALED -> REFUNDING
 *   REFUND: REFUNDING, cursor + k | -> REFUNDED
 * (phases 3/4 exist only inside one DRAW_AND_PAY transaction, never as a live UTXO.)
 * So "which view is further along" needs no timestamps. Timestamps written by different machines (indexer server vs this
 * browser) are not comparable and never decide which state is shown. */
export function roundProgress(v) {
  if (!v || typeof v !== 'object') return null;
  const st = v.state && typeof v.state === 'object' ? v.state : v;
  const n = x => Number.isSafeInteger(x) && x >= 0 ? x : null, phase = st.phase ?? v.phase;
  return [v.terminal ? 1 : 0, Number.isInteger(phase) ? phase : null, n(st.purchaseCount), n(st.cursor)];
}
/** >0: a is further along; <0: b is; 0: same point; null: not decidable from the fields present (e.g. summary rows). */
export function compareProgress(a, b) {
  const x = roundProgress(a), y = roundProgress(b);
  if (!x || !y) return null;
  if (x[0] !== y[0]) return x[0] - y[0];
  if (x[0] === 1) return 0; // both terminal
  for (let i = 1; i < x.length; i++) {
    if (x[i] === null || y[i] === null) return null;
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}
// v replaces best if strictly further along, or if best is only a summary row (no counters, order undecidable) of the
// very same tip and v carries the decoded ledger for it. An undecidable pair otherwise keeps best.
const beats = (v, best) => {
  if (!best) return true;
  const c = compareProgress(v, best);
  return c > 0 || (c === null && !best.state && !!v.state && v.latestTxid === best.latestTxid);
};
/** Timestamps used below are all observation times taken by THIS browser's clock: index._fetchedAt (when the page read
 * the indexer), node.verifiedAt (when the page verified the live UTXO on the node), local.updatedAt (when the page verified
 * its own transaction as accepted). Server-written times (indexer updatedAt) are never compared with them.
 * index: indexer row/detail. node: node-verified live snapshot. local: this browser's own ACCEPTED successor.
 * cache: remembered, untrusted, last resort.
 * - Further along wins; on ties the indexer view stays (it may carry purchase txid hints).
 * - Same point but a different tip (e.g. a reorg replaced a transition): the later observation wins.
 * - A local view further along than a node view verified AFTER it was reorged out or replaced, so it is ignored. */
export function chooseView({index = null, node = null, local = null, cache = null} = {}) {
  let best = index;
  if (node && (beats(node, best) || (compareProgress(node, best) === 0 && node.latestTxid !== best.latestTxid && (node.verifiedAt ?? 0) >= (best._fetchedAt ?? 0)))) best = node;
  const superseded = !!(local && node && compareProgress(local, node) > 0 && (node.verifiedAt ?? 0) > (local.updatedAt ?? 0));
  if (local && !superseded && beats(local, best)) best = local;
  return best ?? cache;
}
