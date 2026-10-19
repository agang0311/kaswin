// Refresh ONLY an in-memory snapshot already authenticated by this session's resolver.
// Does not establish transaction acceptance or trust a persisted/indexer `verified` label.
import {S, ensure, hash32, stable} from '../core.mjs';
import {commonUtxos, sameInput} from '../chain/chain.mjs';
import {linkNet} from '../chain/network-schema.mjs';
import {spkToAddress} from '../wallet/address.mjs';
import {requireRuntimeProfile} from '../contract/runtime.mjs';
import {PRUNED_BASIS} from './rounds.mjs';

export async function recheckLiveSnapshot(link, profile, cid, live) {
  requireRuntimeProfile(profile); hash32(cid);
  const next = structuredClone(live), x = next.snapshot, ev = next.acceptedTx;
  const ledger = S.verifySnapshot(x, profile);
  ensure(x.covenantId === cid, '详情快照不属于所选轮次', 'LIVE_SNAPSHOT_CID');
  // The live UTXO and the previous, fully verified accepted transaction must describe the same output. A state verified
  // below the pruning point has no body; the exact UTXO check below still applies (the pruning point only moves forward).
  const o = ev?.tx?.outputs?.[x.tip.index];
  if (next.basis === PRUNED_BASIS) ensure(ev == null && next.accepting == null, '详情快照来源不一致', 'LIVE_SNAPSHOT_EVIDENCE');
  else ensure(ev?.txid === x.tip.transactionId && ev.accepting === next.accepting && ev.acceptingDaa === x.utxoDaa &&
    o?.value === x.value && stable(o.scriptPublicKey) === stable(x.scriptPublicKey) && o.covenant?.covenantId === cid &&
    o.covenant.authorizingInput === 0, '详情快照与已核验接受交易不一致', 'LIVE_SNAPSHOT_EVIDENCE');
  const address = spkToAddress(x.scriptPublicKey, linkNet(link).addressPrefix);
  const rows = await commonUtxos(link, address);
  const u = rows.find(u => u.outpoint.transactionId === x.tip.transactionId && u.outpoint.index === x.tip.index);
  ensure(u, '轮次前驱已不在未花费集合中，正在补齐后继', 'STALE_TIP');
  const expected = {value: x.value, spk: x.scriptPublicKey, daa: x.utxoDaa, covenantId: cid};
  ensure(sameInput(u, expected), '实时状态 UTXO 的金额、SPK、CID 或 DAA 与已核验快照不一致', 'TIP_MISMATCH');
  const currentDaa = await link.currentDaa();
  ensure(currentDaa >= x.utxoDaa, '节点 DAA 落后于已核验状态', 'SINK_BEHIND');
  next.ledger = ledger; next.snapshot = {...x, currentDaa};
  return next;
}
