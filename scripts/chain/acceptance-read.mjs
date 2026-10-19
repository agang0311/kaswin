// A finite acceptance read: physical connection + relevant removals, including hashes unknown at read start.
// No acceptance is inferred here. Without subscription coverage callers retain the strict revision fence.
import {failure, queryContext, sameConnectionContext, sameQueryContext} from './operation.mjs';

export async function observeAcceptanceRead(link, events = link) {
  await link.connect?.();
  const node = queryContext(link).node;
  let coverage = null;
  try { coverage = await node.holdChainObservation?.(); } catch {} // Query-only fallback still checks the full body.
  const context = queryContext(link), removed = new Set(); let unknown = false, closed = false;
  const collect = ({hashes, unknown: gap = false, hint = false}) => {
    if (hint) return; // A standby observation cannot revoke a primary acceptance verdict.
    if (gap || !Array.isArray(hashes)) { unknown = true; return; }
    for (const hash of hashes) { if (removed.size >= 20000) { unknown = true; break; } removed.add(hash); }
  };
  const offs = [node.on?.('chain-removals', collect), events.on?.('chain', ({rpc, data} = {}) => {
    if (!rpc || rpc === node) collect({hashes: data?.removedChainBlockHashes});
  }), events.on?.('gap', () => { unknown = true; })].filter(Boolean);
  return {
    context,
    current(hash) {
      return !closed && !unknown && !removed.has(hash) && sameConnectionContext(context, queryContext(link)) &&
        (coverage ? node.chainObservationCurrent(coverage) : sameQueryContext(context, queryContext(link)));
    },
    check(hash) { if (!this.current(hash)) throw failure('READ_VIEW_CHANGED'); },
    close() { closed = true; offs.forEach(off => off()); },
  };
}
