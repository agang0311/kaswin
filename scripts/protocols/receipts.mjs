/** Protocol receipt-to-shard matching strategies.
 * Kept in scripts/protocols/ so view templates never contain covenant-specific receipt indexing math. */

export function sequentialBuyReceipt(sh, rec, r, shards) {
  if (!shards || !r?.receipts) return null;
  const buys = r.receipts.filter(t => t.action === 'BUY');
  let offset = 0;
  let total = 0;
  for (const s of shards) {
    if (s.recordCount == null) return null;
    if (s.index === sh.index) offset = total;
    total += s.recordCount;
  }
  if (buys.length !== total) return null;
  return buys[offset + rec.index] ?? null;
}

const frozenBatchesOf = sh => Math.ceil((sh.recordCount ?? sh.records?.length ?? 256) / 32);

function expectedRefundOldCount(frozenShards) {
  let n = 0;
  for (const sh of frozenShards) {
    if (sh.status === 'refunded') n += frozenBatchesOf(sh);
    else if (sh.status === 'refunding') n += Math.floor((sh.refundedRecords ?? 0) / 32);
  }
  return n;
}

export function sequentialRefundReceipt(sh, rec, r, shards) {
  if (!rec?.refunded || !shards || !r?.receipts) return null;
  const frozenShards = shards.filter(s => s.kind === 'frozen');
  const refundOlds = r.receipts.filter(t => t.action === 'REFUND_OLD');
  const expectedOld = expectedRefundOldCount(frozenShards);
  if (sh.kind === 'frozen') {
    if (refundOlds.length !== expectedOld) return null;
    let offset = 0;
    for (const s of frozenShards) {
      if (s.index === sh.index) break;
      offset += frozenBatchesOf(s);
    }
    return refundOlds[offset + Math.floor(rec.index / 32)] ?? null;
  }
  const activeCount = sh.recordCount ?? sh.records?.length ?? 0;
  if (frozenShards.length > 0 && activeCount > 0 && activeCount <= 2) {
    return refundOlds.length === expectedOld && expectedOld > 0 ? (refundOlds.at(-1) ?? null) : null;
  }
  const refundSelfs = r.receipts.filter(t => t.action === 'REFUND_SELF');
  const expectedSelf = sh.status === 'refunded'
    ? Math.ceil(activeCount / 32)
    : sh.status === 'refunding'
      ? Math.floor((sh.refundedRecords ?? 0) / 32)
      : 0;
  if (refundSelfs.length !== expectedSelf) return null;
  return refundSelfs[Math.floor(rec.index / 32)] ?? null;
}

export function sequentialShardRefundReceipts(sh, r, shards) {
  if (!shards || !r?.receipts) return [];
  const frozenShards = shards.filter(s => s.kind === 'frozen');
  const refundOlds = r.receipts.filter(t => t.action === 'REFUND_OLD');
  const expectedOld = expectedRefundOldCount(frozenShards);
  if (sh.kind === 'frozen') {
    if (refundOlds.length !== expectedOld || expectedOld === 0) return [];
    let offset = 0;
    for (const s of frozenShards) {
      if (s.index === sh.index) break;
      offset += frozenBatchesOf(s);
    }
    const count = sh.status === 'refunded'
      ? frozenBatchesOf(sh)
      : sh.status === 'refunding'
        ? Math.floor((sh.refundedRecords ?? 0) / 32)
        : 0;
    return count > 0 ? refundOlds.slice(offset, offset + count) : [];
  }
  const activeCount = sh.recordCount ?? sh.records?.length ?? 0;
  if (frozenShards.length > 0 && activeCount > 0 && activeCount <= 2) {
    return refundOlds.length === expectedOld && expectedOld > 0 && sh.status === 'refunded' ? [refundOlds.at(-1)] : [];
  }
  const refundSelfs = r.receipts.filter(t => t.action === 'REFUND_SELF');
  const expectedSelf = sh.status === 'refunded'
    ? Math.ceil(activeCount / 32)
    : sh.status === 'refunding'
      ? Math.floor((sh.refundedRecords ?? 0) / 32)
      : 0;
  return refundSelfs.length === expectedSelf ? refundSelfs : [];
}

export function parallelShardBuyReceipt(sh, rec, r, shards) {
  if (!shards || !r?.receipts) return null;
  const purchases = r.receipts.filter(t => t.action === 'OPEN_SHARD' || t.action === 'BUY');
  if (sh.hash) {
    const exact = purchases.find(t =>
      t.shardCid === sh.hash && (
        t.recordIndex === rec.index
        || (t.recordIndex == null && t.action === 'OPEN_SHARD' && rec.index === 0)
      ),
    );
    if (exact) return exact;
    const byShard = purchases.filter(t => t.shardCid === sh.hash);
    if (sh.recordCount != null && byShard.length === sh.recordCount) return byShard[rec.index] ?? null;
  }
  if (shards.length === 1 && sh.recordCount != null && purchases.length === sh.recordCount) {
    return purchases[rec.index] ?? null;
  }
  return null;
}

export function parallelShardRefundReceipt(sh, rec, r, shards) {
  if (!rec?.refunded || !shards || !r?.receipts) return null;
  const claims = r.receipts.filter(t => t.action === 'CLAIM_REFUND');
  if (sh.hash) {
    const exact = claims.find(t => t.shardCid === sh.hash && t.recIdx === rec.index);
    if (exact) return exact;
    if (sh.recordCount === 1 && rec.index === 0) {
      const byShard = claims.filter(t => t.shardCid === sh.hash);
      if (byShard.length === 1) return byShard[0];
    }
  }
  if (shards.length === 1 && sh.recordCount === 1 && rec.index === 0 && claims.length === 1) {
    return claims[0];
  }
  return null;
}

export function parallelShardRefundReceipts(sh, r, shards) {
  if (!shards || !r?.receipts) return [];
  const claims = r.receipts.filter(t => t.action === 'CLAIM_REFUND');
  if (sh.hash) {
    const byShard = claims.filter(t => t.shardCid === sh.hash);
    if (byShard.length) return byShard;
  }
  return shards.length === 1 ? claims : [];
}

const looksParallelReceipts = r =>
  Array.isArray(r?.receipts) && r.receipts.some(t => t.shardCid != null || t.action === 'OPEN_SHARD' || t.action === 'CLAIM_REFUND');

export function matchBuyReceiptAuto(sh, rec, r, shards, parallel = looksParallelReceipts(r)) {
  return parallel ? parallelShardBuyReceipt(sh, rec, r, shards) : sequentialBuyReceipt(sh, rec, r, shards);
}

export function matchRefundReceiptAuto(sh, rec, r, shards, parallel = looksParallelReceipts(r)) {
  return parallel ? parallelShardRefundReceipt(sh, rec, r, shards) : sequentialRefundReceipt(sh, rec, r, shards);
}

export function shardRefundReceiptsAuto(sh, r, shards, parallel = looksParallelReceipts(r)) {
  return parallel ? parallelShardRefundReceipts(sh, r, shards) : sequentialShardRefundReceipts(sh, r, shards);
}
