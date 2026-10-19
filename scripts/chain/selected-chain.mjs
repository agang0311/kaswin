// Bounded selected-chain anchor lookup. A location hint is not transaction acceptance.
const need = (v, code) => {if (!v) throw Error(code);};
export async function selectedChainAnchor(rpc, start = null, {maxAgeMs = 0} = {}) {
  need(Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0 && maxAgeMs <= 30000, 'ANCHOR_AGE');
  const known = rpc.knownAnchor, now = Date.now();
  if (!start && maxAgeMs && known && now >= known.observedAt && now - known.observedAt < maxAgeMs) return known.hash;
  let hash = start ?? (await rpc.call('getSink')).sink;
  for (let n = 0; n < 30; n++) {
    need(/^[0-9a-f]{64}$/.test(hash ?? ''), 'ANCHOR_REQUIRED');
    const block = (await rpc.call('getBlock', {hash, includeTransactions: false})).block;
    need((block?.header?.hash ?? block?.verboseData?.hash) === hash, 'ANCHOR_HASH_MISMATCH');
    if (block.verboseData?.isChainBlock === true) { rpc.rememberChainAnchor?.(hash); return hash; }
    hash = block.verboseData?.selectedParentHash;
  }
  throw Error('SELECTED_CHAIN_ANCHOR_NOT_FOUND');
}
