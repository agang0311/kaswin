/** Kaswin kUSDT v2 (256 parallel shards) ProtocolAdapter implementation. */
import {blake2b256, check, convergeFee, covenantId, fromLe, hex, p2pk, p2sh, referenceTxId, REGISTRATION_SOMPI, ResourceLimit, same, scriptNumber, scriptPushes, targetSeqOf, unhex} from '../core.mjs';
import {verifyOrdinarySignatures} from '../wallet/wallet.mjs';
import {commonUtxos, commonUtxosByAddresses, getAssetUtxos} from '../chain/chain.mjs';
import {txToRpc} from '../chain/nodes.mjs';
import {mempoolSpentOutpoints} from '../round/prepare.mjs';
import {acquirePassAProof} from '../round/draw-proof.mjs';
import {assertFreshDrawConfirmation, confirmDrawTargetWithRetry, drawTargetFromOpening} from '../round/draw-confirmations.mjs';
import {addressToSpk, spkToAddress} from '../wallet/address.mjs';
import {kasAsset} from './registry.mjs';
import {parallelShardBuyReceipt, parallelShardRefundReceipt, parallelShardRefundReceipts} from './receipts.mjs';
import {
  DECISION,
  EXECUTOR_REWARD,
  FEE_CAP,
  KCC20_OWNER_SCHEME,
  KCC20_PREFIX_HEX,
  KCC20_SUFFIX_LEN,
  KUSDT_V2_PROTOCOL_ID,
  KUSDT_V2_VERSION,
  MANAGER_DEPOSIT,
  MAX_ACTIVE_OPEN_SHARDS,
  MAX_BATCH,
  MAX_RECORDS_PER_SHARD,
  MAX_SHARDS,
  MIN_DRAW_TICKETS,
  PRICE_MAX,
  PRICE_MIN,
  SHARD_TOTAL_DEPOSIT,
  SHARD_VAULT_DEPOSIT,
  STAGE,
  WINNER_CARRIER_MIN,
  kusdtAsset,
} from './kusdt-v2/constants.mjs';
import {decodeKcc20State, decodeShardOpenOrFrozenState, kcc20RedeemAndSpk, verifyKcc20Suffix} from './kusdt-v2/codec.mjs';
import {encodeKusdtV2State, redeemForState, verifyKusdtV2Redeem} from './kusdt-v2/profile.mjs';
import {kusdtDrawSample, resolveKusdtDrawWinner, verifyKusdtDrawReceipt} from './kusdt-v2/draw.mjs';
export {kusdtDrawSample, resolveKusdtDrawWinner, verifyKusdtDrawReceipt};
import {
  availableKusdtV2Actions,
  describeKusdtV2Round,
  emptyKusdtV2Round,
  kusdtV2RoundFromText,
  kusdtV2RoundToText,
  kusdtV2ShardCatalog,
  kusdtV2Summary,
  kusdtV2UiActions,
  validateKusdtV2Round,
  verifyKusdtV2GenesisRoot,
} from './kusdt-v2/round.mjs';
import {
  buildBuyTx,
  buildClaimRefundTx,
  buildCollectBatchTx,
  buildCreateRoundTx,
  buildDispatchBatchTx,
  buildDrawTx,
  buildEmptyCloseTx,
  buildOpenShardTx,
  buildPayoutTx,
  buildRerollTx,
} from './kusdt-v2/tx.mjs';

const ZERO32 = '00'.repeat(32);
const HASH64 = /^[0-9a-f]{64}$/;
const KASCOV_MAINNET_BASE = 'https://kascov.io/data/mainnet';
const KASVIO_MAINNET_BASE = 'https://kasvio.network/api/kcc20/v4';
const STEP_DOWN_CODES = new Set(['FEE_CAP', 'COMPUTE_MASS_LIMIT', 'TRANSIENT_MASS_LIMIT', 'STORAGE_MASS_LIMIT']);

function isResourceStepDownError(e) {
  return e instanceof ResourceLimit || STEP_DOWN_CODES.has(e?.code) || STEP_DOWN_CODES.has(e?.message);
}

/** Try batch sizes k = items.length .. 1, stepping down ONLY on resource/fee-cap limits (never on state/funds errors). */
export function prepareBatchWithStepDown(items, buildForSlice) {
  check(Array.isArray(items) && items.length >= 1, 'STALE_INPUT');
  let lastErr = null;
  for (let k = items.length; k >= 1; k--) {
    try {
      return {...buildForSlice(items.slice(0, k)), batchSize: k};
    } catch (e) {
      if (!isResourceStepDownError(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

function popcount(n) {
  let x = Number(n) >>> 0;
  let c = 0;
  while (x) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}

function compareTuples(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function normWinnerPk(pk) {
  return typeof pk === 'string' && HASH64.test(pk) && pk !== ZERO32 ? pk : null;
}

function mgrProgress(st, terminal = null, {managerDestroyed = false} = {}) {
  if (terminal) return [9, 0, 0, 0];
  if (managerDestroyed) return [4, 0, 0, 0];
  if (!st) return [0, 0, 0, 0];
  if (st.stage === STAGE.M_OPEN) return [1, Number(st.openedCount ?? 0), Number(st.cursor ?? 0), Number(st.totalTickets ?? 0)];
  if (st.stage === STAGE.M_SEALED) return [2, Number(st.openedCount ?? 0), 0, Number(st.totalTickets ?? 0)];
  if (st.stage === STAGE.M_DISPATCH) return [3, Number(st.openedCount ?? 0), Number(st.cursor ?? 0), Number(st.totalTickets ?? 0)];
  return [0, 0, 0, 0];
}

function shardProgress(sh) {
  if (!sh) return [0, 0, 0, 0];
  if (sh.terminal) return [9, 0, 0, 0];
  const st = Number(sh.stage ?? 0);
  const rank = st === STAGE.S_OPEN ? 1 : st === STAGE.S_FROZEN ? 2 : (st === STAGE.S_PAYOUT || st === STAGE.S_REFUND) ? 3 : 0;
  const recCount = Number(sh.recordCount ?? (Array.isArray(sh.records) ? sh.records.length : 0));
  return [rank, recCount, Number(sh.tickets ?? 0), popcount(sh.claimedMask ?? 0)];
}

function shardEntryFromState({shardCid, state, redeem, spk, outpoint, value, daaScore = 0n, terminal = false, frozenRedeem = null, frozenRecords = null}) {
  const recs = Array.isArray(state?.records)
    ? state.records
    : (Array.isArray(frozenRecords) ? frozenRecords : null);
  const tickets = recs?.length
    ? recs[recs.length - 1].cumTickets
    : (typeof state?.shardTickets === 'number' ? state.shardTickets : 0);
  const price = state?.price != null ? BigInt(state.price) : null;
  const vaultAmount = state?.vaultAmount != null
    ? BigInt(state.vaultAmount)
    : (price != null ? BigInt(tickets) * price : undefined);
  const effectiveFrozenRedeem = frozenRedeem ?? (Number(state?.stage) === STAGE.S_FROZEN && redeem ? redeem : null);
  return {
    shardCid,
    stage: Number(state?.stage ?? STAGE.S_OPEN),
    terminal: !!terminal,
    firstBuyerPk: state?.firstBuyerPk ?? null,
    tickets,
    recordCount: recs ? recs.length : Number(state?.recordCount ?? 0),
    ...(recs ? {records: recs} : {}),
    ...(typeof state?.claimedMask === 'number' ? {claimedMask: state.claimedMask} : {}),
    ...(vaultAmount !== undefined ? {vaultAmount} : {}),
    ...(typeof state?.winnerPk === 'string' ? {winnerPk: state.winnerPk} : {}),
    ...(outpoint ? {outpoint} : {}),
    ...(value != null ? {value: BigInt(value)} : {}),
    ...(spk ? {spk} : {}),
    daaScore: BigInt(daaScore ?? 0n),
    ...(redeem ? {redeem} : {}),
    ...(effectiveFrozenRedeem ? {frozenRedeem: effectiveFrozenRedeem} : {}),
  };
}

function preserveHistoricalShard(nextSh, prevSh) {
  if (!nextSh || !prevSh) return nextSh;
  const sameTickets = !prevSh.tickets || !nextSh.tickets || Number(prevSh.tickets) === Number(nextSh.tickets);
  const prevFrozen = prevSh.frozenRedeem ?? (prevSh.stage === STAGE.S_FROZEN ? prevSh.redeem : null);
  const needRecs = !Array.isArray(nextSh.records) && Array.isArray(prevSh.records) && prevSh.records.length > 0 && sameTickets;
  const needFrozen = !nextSh.frozenRedeem && !!prevFrozen && sameTickets;
  if (!needRecs && !needFrozen) return nextSh;
  return {
    ...nextSh,
    ...(needRecs ? {records: prevSh.records, recordCount: prevSh.records.length} : {}),
    ...(needFrozen ? {frozenRedeem: prevFrozen} : {}),
  };
}

async function fetchAcceptingBlockViaRest(txid, net, fetcher) {
  if (!HASH64.test(String(txid ?? '')) || !net?.rest || typeof fetcher !== 'function') return null;
  try {
    const restBase = net.rest.replace(/\/$/, '');
    const tx = await fetchJsonBounded(fetcher, `${restBase}/transactions/${encodeURIComponent(txid)}`);
    const h = String(tx?.accepting_block_hash ?? '').toLowerCase();
    return tx?.is_accepted === true && HASH64.test(h) ? h : null;
  } catch {
    return null;
  }
}

async function probeLiveOutpoint(rpc, spk, outpoint, expectedCid, prefix, {allowSameSpk = false} = {}) {
  if (!rpc || !spk) return {ok: false, hit: null};
  try {
    const live = await commonUtxos(rpc, spkToAddress(spk, prefix));
    let hit = outpoint?.transactionId
      ? live.find(u =>
          (!expectedCid || u.covenantId === expectedCid)
          && u.outpoint?.transactionId === outpoint.transactionId
          && u.outpoint?.index === outpoint.index
        )
      : null;
    if (!hit && allowSameSpk) {
      hit = live.find(u => (!expectedCid || u.covenantId === expectedCid) && u.outpoint) ?? null;
    }
    return {ok: true, hit: hit ?? null};
  } catch {
    return {ok: false, hit: null};
  }
}

/** Open shard that can still accept standalone BUY (s_open.sil enforces rc < 256). */
export function isBuyableOpenShard(sh) {
  return !!(sh && !sh.terminal && sh.stage === STAGE.S_OPEN && Number(sh.recordCount ?? 0) < MAX_RECORDS_PER_SHARD);
}

/** Shard that can be spent standalone without touching Manager:
 * - S_OPEN with recordCount < 256 (BUY)
 * - S_PAYOUT / S_REFUND non-terminal (PAYOUT_SELF / PAYOUT_EXECUTOR / CLAIM_REFUND)
 * Full 256-record S_OPEN shards and S_FROZEN shards can only move alongside Manager (COLLECT_BATCH / DISPATCH_BATCH). */
export function isMutableStandaloneShard(sh) {
  if (!sh || sh.terminal) return false;
  if (sh.stage === STAGE.S_OPEN) return Number(sh.recordCount ?? 0) < MAX_RECORDS_PER_SHARD;
  if (sh.stage === STAGE.S_PAYOUT || sh.stage === STAGE.S_REFUND) return true;
  return false;
}

/** Active WebSocket watch targets for a kusdt-v2 round: Manager (when live) + standalone-mutable shards only. */
export function kusdtV2WatchTargets(round, prefix, {maxAddresses = 64} = {}) {
  if (!round || round.terminal || round.halted) return null;
  if (round.step === 0 || round.intent?.action === 'GENESIS') {
    const spk = round.manager?.spk ?? round.intent?.draft?.transaction?.outputs?.[0]?.scriptPublicKey ?? null;
    if (!spk) return null;
    return {mode: 'genesis', addresses: [spkToAddress(spk, prefix)], tipKeys: []};
  }
  const limit = Math.max(1, Math.min(256, Number(maxAddresses) || 64));
  const addresses = [];
  const addrSet = new Set();
  const tipKeys = [];
  const addTarget = (spk, outpoint) => {
    if (!spk) return;
    const addr = spkToAddress(spk, prefix);
    if (!addrSet.has(addr)) {
      if (addresses.length >= limit) return;
      addrSet.add(addr);
      addresses.push(addr);
    }
    if (outpoint?.transactionId && outpoint.index != null) {
      tipKeys.push(`${outpoint.transactionId}:${Number(outpoint.index)}`);
    }
  };
  if (round.manager?.spk) addTarget(round.manager.spk, round.manager.outpoint);
  const shards = Array.isArray(round.kusdt?.shards) ? round.kusdt.shards : [];
  for (const sh of shards) {
    if (!isMutableStandaloneShard(sh) || !sh.spk || !sh.outpoint) continue;
    addTarget(sh.spk, sh.outpoint);
  }
  if (!addresses.length) return null;
  return {mode: 'manager', addresses, tipKeys};
}

/** Batched live outpoint probe using chunked getUtxosByAddresses (default 64 addresses per RPC). */
async function batchProbeLiveOutpoints(rpc, items, prefix, {chunkSize = 64} = {}) {
  const results = new Map();
  if (!rpc || !Array.isArray(items) || !items.length) return results;
  const valid = [];
  for (const item of items) {
    if (!item?.spk) {
      results.set(item.index, {ok: false, hit: null});
      continue;
    }
    valid.push({...item, address: spkToAddress(item.spk, prefix)});
  }
  const step = Math.max(1, Math.min(256, Number(chunkSize) || 64));
  for (let offset = 0; offset < valid.length; offset += step) {
    const slice = valid.slice(offset, offset + step);
    const batchAddrs = [...new Set(slice.map(x => x.address))];
    try {
      const live = await commonUtxosByAddresses(rpc, batchAddrs, {chunkSize: step});
      const byOutpoint = new Map();
      for (const u of live) {
        if (u?.outpoint?.transactionId && u.outpoint.index != null) {
          byOutpoint.set(`${u.outpoint.transactionId}:${Number(u.outpoint.index)}`, u);
        }
      }
      for (const item of slice) {
        const opKey = item.outpoint?.transactionId && item.outpoint.index != null
          ? `${item.outpoint.transactionId}:${Number(item.outpoint.index)}`
          : null;
        const cand = opKey ? byOutpoint.get(opKey) ?? null : null;
        const hit = cand && (!item.expectedCid || cand.covenantId === item.expectedCid) ? cand : null;
        results.set(item.index, {ok: true, hit});
      }
    } catch {
      for (const item of slice) results.set(item.index, {ok: false, hit: null});
    }
  }
  return results;
}

function upsertShard(map, sh) {
  if (!sh?.shardCid) return;
  const prev = map.get(sh.shardCid);
  if (!prev) {
    map.set(sh.shardCid, sh);
    return;
  }
  const cmp = compareTuples(shardProgress(sh), shardProgress(prev));
  if (cmp > 0) {
    map.set(sh.shardCid, preserveHistoricalShard(sh, prev));
  } else if (cmp === 0 && ((!prev.redeem && sh.redeem) || (!prev.records && sh.records) || (!prev.frozenRedeem && sh.frozenRedeem))) {
    map.set(sh.shardCid, preserveHistoricalShard(sh, prev));
  }
}

function normalizeKusdtReceipt(rc) {
  if (!rc || typeof rc !== 'object' || typeof rc.txid !== 'string') return null;
  const txid = rc.txid.toLowerCase();
  if (!HASH64.test(txid)) return null;
  const out = {
    action: String(rc.action ?? ''),
    txid,
    feeSompi: rc.feeSompi != null && String(rc.feeSompi) !== '' ? String(rc.feeSompi) : '0',
    finalized: rc.finalized !== false,
  };
  if (typeof rc.shardCid === 'string' && HASH64.test(rc.shardCid.toLowerCase())) out.shardCid = rc.shardCid.toLowerCase();
  if (Number.isInteger(rc.recordIndex) && rc.recordIndex >= 0) out.recordIndex = rc.recordIndex;
  if (Number.isInteger(rc.recIdx) && rc.recIdx >= 0) out.recIdx = rc.recIdx;
  if (typeof rc.acceptingBlock === 'string' && HASH64.test(rc.acceptingBlock.toLowerCase())) out.acceptingBlock = rc.acceptingBlock.toLowerCase();
  if (rc.acceptingDaa != null && /^[0-9]+$/.test(String(rc.acceptingDaa))) out.acceptingDaa = String(rc.acceptingDaa);
  return out;
}

function mergeKusdtReceipts(primary = [], secondary = []) {
  const byTxid = new Map();
  const order = [];
  const upsert = (raw, preferIncoming) => {
    const norm = normalizeKusdtReceipt(raw);
    if (!norm) return;
    const prev = byTxid.get(norm.txid);
    if (!prev) {
      byTxid.set(norm.txid, norm);
      order.push(norm.txid);
      return;
    }
    const a = preferIncoming ? prev : norm;
    const b = preferIncoming ? norm : prev;
    const merged = {
      action: b.action || a.action,
      txid: norm.txid,
      feeSompi: (b.feeSompi != null && String(b.feeSompi) !== '0') ? String(b.feeSompi) : String(a.feeSompi ?? b.feeSompi ?? '0'),
      finalized: Boolean(a.finalized || b.finalized),
      ...(b.shardCid || a.shardCid ? {shardCid: b.shardCid ?? a.shardCid} : {}),
      ...(b.recordIndex != null || a.recordIndex != null ? {recordIndex: b.recordIndex ?? a.recordIndex} : {}),
      ...(b.recIdx != null || a.recIdx != null ? {recIdx: b.recIdx ?? a.recIdx} : {}),
      ...(b.acceptingBlock || a.acceptingBlock ? {acceptingBlock: b.acceptingBlock ?? a.acceptingBlock} : {}),
      ...(b.acceptingDaa || a.acceptingDaa ? {acceptingDaa: b.acceptingDaa ?? a.acceptingDaa} : {}),
    };
    byTxid.set(norm.txid, merged);
  };
  for (const rc of (Array.isArray(primary) ? primary : [])) upsert(rc, true);
  for (const rc of (Array.isArray(secondary) ? secondary : [])) upsert(rc, false);
  return order.map(txid => byTxid.get(txid));
}

function restTxFee(tx) {
  if (!tx || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs) || !tx.inputs.length) return '0';
  let inSum = 0n;
  for (const inp of tx.inputs) {
    const amt = inp?.previous_outpoint_amount ?? inp?.utxo_entry?.amount;
    if (amt == null) return '0';
    try { inSum += BigInt(String(amt)); } catch { return '0'; }
  }
  let outSum = 0n;
  for (const out of tx.outputs) {
    if (out?.amount == null) return '0';
    try { outSum += BigInt(String(out.amount)); } catch { return '0'; }
  }
  return inSum >= outSum ? (inSum - outSum).toString() : '0';
}

async function catchupKusdtManagerViaRest({rpc, manager, cid, shards = [], profile, net, fetcher, maxHops = 16}) {
  if (!net?.rest || typeof fetcher !== 'function' || !manager?.outpoint?.transactionId || !manager?.spk || !manager?.redeemScript) {
    return {advanced: false, manager, state: null, shards, terminal: null, nodeVerified: false, receipts: []};
  }
  const prefix = net.addressPrefix ?? 'kaspatest';
  const restBase = net.rest.replace(/\/$/, '');
  const shardMap = new Map();
  for (const s of shards) if (s?.shardCid) shardMap.set(s.shardCid, s);
  const caughtReceipts = [];
  let curMgr = manager;
  let lastState = null;
  let hops = 0;

  for (let hop = 0; hop < maxHops; hop++) {
    let curState;
    try {
      curState = verifyKusdtV2Redeem(curMgr.redeemScript, profile, 'manager').state;
    } catch {
      break;
    }
    let txs;
    try {
      const addr = spkToAddress(curMgr.spk, prefix);
      txs = await fetchJsonBounded(fetcher, `${restBase}/addresses/${encodeURIComponent(addr)}/full-transactions?limit=20`);
    } catch {
      break;
    }
    if (!Array.isArray(txs)) break;

    let spendTx = null;
    let spendIn = null;
    for (const tx of txs) {
      if (tx?.is_accepted !== true || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) continue;
      const inp = tx.inputs.find(i =>
        String(i?.previous_outpoint_hash ?? '').toLowerCase() === curMgr.outpoint.transactionId
        && Number(i?.previous_outpoint_index) === curMgr.outpoint.index
      );
      if (inp) {
        spendTx = tx;
        spendIn = inp;
        break;
      }
    }
    if (!spendTx || !spendIn) break;
    const txid = String(spendTx.transaction_id ?? '').toLowerCase();
    if (!HASH64.test(txid)) break;

    let pushes;
    try {
      pushes = scriptPushes(unhex(String(spendIn.signature_script ?? '').toLowerCase()));
    } catch {
      break;
    }
    if (pushes.length < 3 || !same(pushes[pushes.length - 1], curMgr.redeemScript)) break;
    let action;
    try {
      action = scriptNumber(pushes[0]);
    } catch {
      break;
    }
    const outAt = idx => spendTx.outputs.find(o => Number(o?.index) === idx);
    const inAt = idx => spendTx.inputs.find(i => Number(i?.index) === idx);

    let nextMgrState = null;
    let nextMgrRedeem = null;
    let nextMgrSpk = null;
    let out0 = outAt(0);

    if (curState.stage === STAGE.M_OPEN && action === 1n) {
      // OPEN_SHARD: 7-arg spend(action, originTxId, originIndex, ownTailBytes, shardTail, extraBytes, data)
      if (pushes.length < 9) break;
      const data = pushes[6];
      if (!(data instanceof Uint8Array) || data.length !== 36) break;
      const qty = Number(fromLe(data.slice(0, 4)));
      if (!Number.isInteger(qty) || qty < 1) break;
      const buyerPk = hex(data.slice(4, 36));
      const out1 = outAt(1);
      const authIn = inAt(1);
      if (!out0 || !out1 || !authIn) break;
      const authTxid = String(authIn.previous_outpoint_hash ?? '').toLowerCase();
      const authIdx = Number(authIn.previous_outpoint_index);
      if (!HASH64.test(authTxid) || !Number.isSafeInteger(authIdx) || authIdx < 0) break;

      const shardState = {
        stage: STAGE.S_OPEN,
        version: KUSDT_V2_VERSION,
        managerCid: cid,
        firstBuyerPk: buyerPk,
        price: curState.price,
        records: [{cumTickets: qty, buyerPk}],
      };
      const shardRedeem = redeemForState(shardState, profile);
      const shardSpk = p2sh(hex(blake2b256(shardRedeem)));
      if (String(out1.script_public_key ?? '').toLowerCase() !== shardSpk.script) break;
      const shardValue = BigInt(String(out1.amount));
      const out1Cid = typeof out1.covenant_id === 'string' && HASH64.test(out1.covenant_id.toLowerCase())
        ? out1.covenant_id.toLowerCase()
        : null;
      const expectedShardCid = out1Cid ?? covenantId({transactionId: authTxid, index: authIdx}, [{index: 1, value: shardValue, spk: shardSpk}]);

      nextMgrState = {
        ...curState,
        openedCount: curState.openedCount + 1,
        entries: [...curState.entries, {shardCid: expectedShardCid, ledgerHash: ZERO32, cumTickets: 0}],
      };
      nextMgrRedeem = redeemForState(nextMgrState, profile);
      nextMgrSpk = p2sh(hex(blake2b256(nextMgrRedeem)));
      if (String(out0.script_public_key ?? '').toLowerCase() !== nextMgrSpk.script) break;
      if (out0.covenant_id != null && String(out0.covenant_id).toLowerCase() !== cid) break;

      upsertShard(shardMap, shardEntryFromState({
        shardCid: expectedShardCid,
        state: shardState,
        redeem: shardRedeem,
        spk: shardSpk,
        outpoint: {transactionId: txid, index: 1},
        value: shardValue,
        daaScore: 0n,
      }));
      caughtReceipts.push({action: 'OPEN_SHARD', txid, feeSompi: restTxFee(spendTx), finalized: true, shardCid: expectedShardCid, recordIndex: 0});
    } else if (curState.stage === STAGE.M_OPEN && action === 2n) {
      // EMPTY_CLOSE
      if (curState.openedCount !== 0 || !out0) break;
      if (String(out0.script_public_key ?? '').toLowerCase() !== p2pk(curState.creatorPk).script) break;
      if (spendTx.outputs.some(o => String(o?.covenant_id ?? '').toLowerCase() === cid)) break;
      caughtReceipts.push({action: 'EMPTY_CLOSE', txid, feeSompi: restTxFee(spendTx), finalized: true});
      return {advanced: true, manager: null, state: null, shards: [...shardMap.values()], terminal: 'EMPTY', nodeVerified: true, receipts: caughtReceipts};
    } else if (curState.stage === STAGE.M_OPEN && action === 3n) {
      // COLLECT_BATCH: 7-arg spend(action, originTxId, originIndex, ownTailBytes, shardTail, extraBytes, data)
      if (pushes.length < 9 || !out0) break;
      const data = pushes[6];
      if (!(data instanceof Uint8Array) || data.length < 6) break;
      const k = Number(fromLe(data.slice(0, 2)));
      if (!Number.isInteger(k) || k < 1 || k > 8 || curState.cursor + k > curState.openedCount) break;
      const entries = curState.entries.map(e => ({...e}));
      let totalTickets = curState.totalTickets;
      const frozenUpdates = [];
      let batchOk = true;
      for (let i = 0; i < k; i++) {
        const sIn = inAt(i + 1);
        const sOut = outAt(i + 1);
        if (!sIn || !sOut) { batchOk = false; break; }
        let sState;
        try {
          const sPushes = scriptPushes(unhex(String(sIn.signature_script ?? '').toLowerCase()));
          const sRedeem = sPushes[sPushes.length - 1];
          sState = verifyKusdtV2Redeem(sRedeem, profile, 'shard').state;
        } catch { batchOk = false; break; }
        if (sState.stage !== STAGE.S_OPEN || !sState.records?.length) { batchOk = false; break; }
        const frozen = {...sState, stage: STAGE.S_FROZEN};
        const frozenRedeem = redeemForState(frozen, profile);
        const frozenSpk = p2sh(hex(blake2b256(frozenRedeem)));
        if (String(sOut.script_public_key ?? '').toLowerCase() !== frozenSpk.script) { batchOk = false; break; }
        const idx = curState.cursor + i;
        totalTickets += sState.records[sState.records.length - 1].cumTickets;
        entries[idx] = {
          shardCid: entries[idx].shardCid,
          ledgerHash: hex(blake2b256(encodeKusdtV2State(frozen))),
          cumTickets: totalTickets,
        };
        frozenUpdates.push(shardEntryFromState({
          shardCid: entries[idx].shardCid,
          state: frozen,
          redeem: frozenRedeem,
          spk: frozenSpk,
          outpoint: {transactionId: txid, index: i + 1},
          value: BigInt(String(sOut.amount)),
          daaScore: 0n,
        }));
      }
      if (!batchOk) break;
      const nextCursor = curState.cursor + k;
      const done = nextCursor === curState.openedCount;
      if (!done) {
        nextMgrState = {...curState, cursor: nextCursor, totalTickets, entries};
      } else if (totalTickets < MIN_DRAW_TICKETS) {
        nextMgrState = {
          stage: STAGE.M_DISPATCH,
          version: KUSDT_V2_VERSION,
          creatorPk: curState.creatorPk,
          price: curState.price,
          closeDaa: curState.closeDaa,
          openedCount: curState.openedCount,
          cursor: 0,
          totalTickets,
          decision: DECISION.REFUND,
          reserved: 0,
          winnerPk: ZERO32,
          shardCids: entries.map(e => e.shardCid),
        };
      } else {
        nextMgrState = {...curState, stage: STAGE.M_SEALED, cursor: 0, totalTickets, entries};
      }
      nextMgrRedeem = redeemForState(nextMgrState, profile);
      nextMgrSpk = p2sh(hex(blake2b256(nextMgrRedeem)));
      if (String(out0.script_public_key ?? '').toLowerCase() !== nextMgrSpk.script) break;
      if (out0.covenant_id != null && String(out0.covenant_id).toLowerCase() !== cid) break;
      for (const fsh of frozenUpdates) upsertShard(shardMap, fsh);
      const colAcc = String(spendTx.accepting_block_hash ?? '').toLowerCase();
      caughtReceipts.push({action: 'COLLECT_BATCH', txid, feeSompi: restTxFee(spendTx), finalized: true, ...(HASH64.test(colAcc) ? {acceptingBlock: colAcc} : {})});
    } else if (curState.stage === STAGE.M_SEALED && action === 1n) {
      // DRAW: pushes[3] = proof(240B) || j(u16 LE) || i(u16 LE) || frozenState(...)
      if (pushes.length < 6 || !out0) break;
      const data = pushes[3];
      if (!(data instanceof Uint8Array) || data.length <= 244) break;
      const j = Number(fromLe(data.slice(240, 242)));
      const i = Number(fromLe(data.slice(242, 244)));
      const frozenBytes = data.slice(244);
      if (j < 0 || j >= curState.entries.length) break;
      if (hex(blake2b256(frozenBytes)) !== curState.entries[j].ledgerHash) break;
      let frozen;
      try { frozen = decodeShardOpenOrFrozenState(frozenBytes); } catch { break; }
      if (frozen.stage !== STAGE.S_FROZEN || i < 0 || i >= frozen.records.length) break;
      const winnerPk = frozen.records[i].buyerPk;
      nextMgrState = {
        stage: STAGE.M_DISPATCH,
        version: KUSDT_V2_VERSION,
        creatorPk: curState.creatorPk,
        price: curState.price,
        closeDaa: curState.closeDaa,
        openedCount: curState.openedCount,
        cursor: 0,
        totalTickets: curState.totalTickets,
        decision: DECISION.PAYOUT,
        reserved: 0,
        winnerPk,
        shardCids: curState.entries.map(e => e.shardCid),
      };
      nextMgrRedeem = redeemForState(nextMgrState, profile);
      nextMgrSpk = p2sh(hex(blake2b256(nextMgrRedeem)));
      if (String(out0.script_public_key ?? '').toLowerCase() !== nextMgrSpk.script) break;
      if (out0.covenant_id != null && String(out0.covenant_id).toLowerCase() !== cid) break;
      const drawAcc = String(spendTx.accepting_block_hash ?? '').toLowerCase();
      caughtReceipts.push({action: 'DRAW', txid, feeSompi: restTxFee(spendTx), finalized: true, ...(HASH64.test(drawAcc) ? {acceptingBlock: drawAcc} : {})});
    } else if (curState.stage === STAGE.M_SEALED && action === 2n) {
      // REROLL: self-continuation with identical state
      if (!out0) break;
      nextMgrState = curState;
      nextMgrRedeem = redeemForState(nextMgrState, profile);
      nextMgrSpk = p2sh(hex(blake2b256(nextMgrRedeem)));
      if (String(out0.script_public_key ?? '').toLowerCase() !== nextMgrSpk.script) break;
      if (out0.covenant_id != null && String(out0.covenant_id).toLowerCase() !== cid) break;
      const rrAcc = String(spendTx.accepting_block_hash ?? '').toLowerCase();
      caughtReceipts.push({action: 'REROLL', txid, feeSompi: restTxFee(spendTx), finalized: true, ...(HASH64.test(rrAcc) ? {acceptingBlock: rrAcc} : {})});
    } else if (curState.stage === STAGE.M_DISPATCH) {
      // DISPATCH_BATCH: pushes[0] = k
      let k;
      try { k = Number(scriptNumber(pushes[0])); } catch { break; }
      if (!Number.isInteger(k) || k < 1 || k > 8 || curState.cursor + k > curState.openedCount || !out0) break;
      const isPayout = curState.decision === DECISION.PAYOUT;
      const dispatched = [];
      let batchOk = true;
      for (let i = 0; i < k; i++) {
        const sIn = inAt(i + 1);
        const sOut = outAt(i + 1);
        if (!sIn || !sOut) { batchOk = false; break; }
        let frozen, sRedeem;
        try {
          const sPushes = scriptPushes(unhex(String(sIn.signature_script ?? '').toLowerCase()));
          sRedeem = sPushes[sPushes.length - 1];
          frozen = verifyKusdtV2Redeem(sRedeem, profile, 'shard').state;
        } catch { batchOk = false; break; }
        if (frozen.stage !== STAGE.S_FROZEN || !frozen.records?.length) { batchOk = false; break; }
        const scid = curState.shardCids[curState.cursor + i];
        const shardTickets = frozen.records[frozen.records.length - 1].cumTickets;
        const nextSh = isPayout
          ? {
              stage: STAGE.S_PAYOUT,
              version: KUSDT_V2_VERSION,
              firstBuyerPk: frozen.firstBuyerPk,
              winnerPk: curState.winnerPk,
              vaultAmount: BigInt(shardTickets) * curState.price,
              managerCid: cid,
              shardTickets,
            }
          : {
              stage: STAGE.S_REFUND,
              version: KUSDT_V2_VERSION,
              firstBuyerPk: frozen.firstBuyerPk,
              price: frozen.price,
              recordCount: frozen.records.length,
              claimedMask: 0,
              records: frozen.records,
            };
        const nextShRedeem = redeemForState(nextSh, profile);
        const nextShSpk = p2sh(hex(blake2b256(nextShRedeem)));
        if (String(sOut.script_public_key ?? '').toLowerCase() !== nextShSpk.script) { batchOk = false; break; }
        if (sOut.covenant_id != null && String(sOut.covenant_id).toLowerCase() !== scid) { batchOk = false; break; }
        dispatched.push(shardEntryFromState({
          shardCid: scid,
          state: nextSh,
          redeem: nextShRedeem,
          spk: nextShSpk,
          outpoint: {transactionId: txid, index: i + 1},
          value: BigInt(String(sOut.amount)),
          daaScore: 0n,
          frozenRedeem: sRedeem,
          frozenRecords: frozen.records,
        }));
      }
      if (!batchOk) break;
      const nextCursor = curState.cursor + k;
      const done = nextCursor === curState.openedCount;
      if (done) {
        if (String(out0.script_public_key ?? '').toLowerCase() !== p2pk(curState.creatorPk).script) break;
        if (spendTx.outputs.some(o => String(o?.covenant_id ?? '').toLowerCase() === cid)) break;
        for (const dsh of dispatched) upsertShard(shardMap, dsh);
        caughtReceipts.push({action: 'DISPATCH_BATCH', txid, feeSompi: restTxFee(spendTx), finalized: true});
        return {
          advanced: true,
          manager: null,
          state: {...curState, cursor: nextCursor},
          shards: [...shardMap.values()],
          terminal: null,
          nodeVerified: false,
          receipts: caughtReceipts,
        };
      }
      nextMgrState = {...curState, cursor: nextCursor};
      nextMgrRedeem = redeemForState(nextMgrState, profile);
      nextMgrSpk = p2sh(hex(blake2b256(nextMgrRedeem)));
      if (String(out0.script_public_key ?? '').toLowerCase() !== nextMgrSpk.script) break;
      if (out0.covenant_id != null && String(out0.covenant_id).toLowerCase() !== cid) break;
      for (const dsh of dispatched) upsertShard(shardMap, dsh);
      caughtReceipts.push({action: 'DISPATCH_BATCH', txid, feeSompi: restTxFee(spendTx), finalized: true});
    } else {
      break;
    }

    hops++;
    lastState = nextMgrState;
    curMgr = {
      outpoint: {transactionId: txid, index: 0},
      value: BigInt(String(out0.amount)),
      spk: nextMgrSpk,
      utxoDaa: 0n,
      daaScore: 0n,
      daa: 0n,
      covenantId: cid,
      redeemScript: nextMgrRedeem,
    };
    const live = await probeLiveOutpoint(rpc, curMgr.spk, curMgr.outpoint, cid, prefix, {allowSameSpk: true});
    if (live.ok && live.hit) {
      const d = live.hit.daa ?? live.hit.utxoDaa ?? 0n;
      curMgr = {
        ...curMgr,
        outpoint: live.hit.outpoint,
        value: live.hit.value,
        spk: live.hit.spk ?? curMgr.spk,
        utxoDaa: d,
        daaScore: d,
        daa: d,
      };
      return {advanced: true, manager: curMgr, state: nextMgrState, shards: [...shardMap.values()], terminal: null, nodeVerified: true, receipts: caughtReceipts};
    }
  }

  return {advanced: hops > 0, manager: curMgr, state: lastState, shards: [...shardMap.values()], terminal: null, nodeVerified: false, receipts: caughtReceipts};
}

async function catchupKusdtShardViaRest({rpc, shard, profile, net, fetcher, maxHops = 16}) {
  if (!net?.rest || typeof fetcher !== 'function' || !shard || shard.terminal || shard.stage !== STAGE.S_OPEN || !shard.outpoint?.transactionId || !shard.spk || !shard.redeem) {
    return {advanced: false, shard, live: false, receipts: []};
  }
  const prefix = net.addressPrefix ?? 'kaspatest';
  const restBase = net.rest.replace(/\/$/, '');
  const caughtReceipts = [];
  let curSh = shard;
  let hops = 0;

  for (let hop = 0; hop < maxHops; hop++) {
    let curState;
    try {
      curState = verifyKusdtV2Redeem(curSh.redeem, profile, 'shard').state;
    } catch {
      break;
    }
    if (curState.stage !== STAGE.S_OPEN || !curState.records?.length) break;

    let txs;
    try {
      const addr = spkToAddress(curSh.spk, prefix);
      txs = await fetchJsonBounded(fetcher, `${restBase}/addresses/${encodeURIComponent(addr)}/full-transactions?limit=20`);
    } catch {
      break;
    }
    if (!Array.isArray(txs)) break;

    let spendTx = null;
    let spendIn = null;
    for (const tx of txs) {
      if (tx?.is_accepted !== true || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) continue;
      const inp = tx.inputs.find(i =>
        String(i?.previous_outpoint_hash ?? '').toLowerCase() === curSh.outpoint.transactionId
        && Number(i?.previous_outpoint_index) === curSh.outpoint.index
      );
      if (inp) {
        spendTx = tx;
        spendIn = inp;
        break;
      }
    }
    if (!spendTx || !spendIn) break;
    const txid = String(spendTx.transaction_id ?? '').toLowerCase();
    if (!HASH64.test(txid)) break;

    let pushes;
    try {
      pushes = scriptPushes(unhex(String(spendIn.signature_script ?? '').toLowerCase()));
    } catch {
      break;
    }
    if (pushes.length < 3 || !same(pushes[pushes.length - 1], curSh.redeem)) break;
    let action;
    try {
      action = scriptNumber(pushes[0]);
    } catch {
      break;
    }

    if (action === 1n) {
      // BUY on S_OPEN shard
      if (pushes.length < 8) break;
      let qty;
      try { qty = Number(scriptNumber(pushes[1])); } catch { break; }
      if (!Number.isInteger(qty) || qty < 1 || !(pushes[2] instanceof Uint8Array) || pushes[2].length !== 32) break;
      const buyerPk = hex(pushes[2]);
      const prevTickets = curState.records[curState.records.length - 1].cumTickets;
      const nextState = {...curState, records: [...curState.records, {cumTickets: prevTickets + qty, buyerPk}]};
      const nextRedeem = redeemForState(nextState, profile);
      const nextSpk = p2sh(hex(blake2b256(nextRedeem)));
      const out0 = spendTx.outputs.find(o => Number(o?.index) === 0);
      if (!out0 || String(out0.script_public_key ?? '').toLowerCase() !== nextSpk.script) break;
      if (out0.covenant_id != null && String(out0.covenant_id).toLowerCase() !== curSh.shardCid) break;
      hops++;
      caughtReceipts.push({
        action: 'BUY',
        txid,
        feeSompi: restTxFee(spendTx),
        finalized: true,
        shardCid: curSh.shardCid,
        recordIndex: nextState.records.length - 1,
      });
      curSh = shardEntryFromState({
        shardCid: curSh.shardCid,
        state: nextState,
        redeem: nextRedeem,
        spk: nextSpk,
        outpoint: {transactionId: txid, index: 0},
        value: BigInt(String(out0.amount)),
        daaScore: 0n,
      });
      const live = await probeLiveOutpoint(rpc, curSh.spk, curSh.outpoint, curSh.shardCid, prefix);
      if (live.ok && live.hit) {
        curSh = {...curSh, value: live.hit.value, spk: live.hit.spk ?? curSh.spk, daaScore: live.hit.daa ?? live.hit.utxoDaa ?? 0n};
        return {advanced: true, shard: curSh, live: true, receipts: caughtReceipts};
      }
    } else if (action === 2n) {
      // COLLECT_BATCH froze shard to S_FROZEN
      const nextState = {...curState, stage: STAGE.S_FROZEN};
      const nextRedeem = redeemForState(nextState, profile);
      const nextSpk = p2sh(hex(blake2b256(nextRedeem)));
      const sOut = spendTx.outputs.find(o =>
        String(o?.script_public_key ?? '').toLowerCase() === nextSpk.script
        && (o.covenant_id == null || String(o.covenant_id).toLowerCase() === curSh.shardCid)
      );
      if (!sOut) break;
      hops++;
      curSh = shardEntryFromState({
        shardCid: curSh.shardCid,
        state: nextState,
        redeem: nextRedeem,
        spk: nextSpk,
        outpoint: {transactionId: txid, index: Number(sOut.index)},
        value: BigInt(String(sOut.amount)),
        daaScore: 0n,
      });
      const live = await probeLiveOutpoint(rpc, curSh.spk, curSh.outpoint, curSh.shardCid, prefix);
      if (live.ok && live.hit) {
        curSh = {...curSh, value: live.hit.value, spk: live.hit.spk ?? curSh.spk, daaScore: live.hit.daa ?? live.hit.utxoDaa ?? 0n};
      }
      return {advanced: true, shard: curSh, live: !!(live.ok && live.hit), receipts: caughtReceipts};
    } else {
      break;
    }
  }
  return {advanced: hops > 0, shard: curSh, live: false, receipts: caughtReceipts};
}

async function catchupKusdtSettlementShardViaRest({rpc, shard, profile, net, fetcher, maxHops = 4}) {
  if (!net?.rest || typeof fetcher !== 'function' || !shard || shard.terminal || (shard.stage !== STAGE.S_PAYOUT && shard.stage !== STAGE.S_REFUND) || !shard.outpoint?.transactionId || !shard.spk || !shard.redeem) {
    return {advanced: false, shard, live: false, receipts: []};
  }
  const prefix = net.addressPrefix ?? 'kaspatest';
  const restBase = net.rest.replace(/\/$/, '');
  const caughtReceipts = [];
  let curSh = shard;
  let hops = 0;

  for (let hop = 0; hop < maxHops; hop++) {
    let curState;
    try {
      curState = verifyKusdtV2Redeem(curSh.redeem, profile, 'shard').state;
    } catch {
      break;
    }
    let txs;
    try {
      const addr = spkToAddress(curSh.spk, prefix);
      txs = await fetchJsonBounded(fetcher, `${restBase}/addresses/${encodeURIComponent(addr)}/full-transactions?limit=20`);
    } catch {
      break;
    }
    if (!Array.isArray(txs)) break;

    let spendTx = null;
    let spendIn = null;
    for (const tx of txs) {
      if (tx?.is_accepted !== true || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) continue;
      const inp = tx.inputs.find(i =>
        String(i?.previous_outpoint_hash ?? '').toLowerCase() === curSh.outpoint.transactionId
        && Number(i?.previous_outpoint_index) === curSh.outpoint.index
      );
      if (inp) {
        spendTx = tx;
        spendIn = inp;
        break;
      }
    }
    if (!spendTx || !spendIn) break;
    const txid = String(spendTx.transaction_id ?? '').toLowerCase();
    if (!HASH64.test(txid)) break;

    let pushes;
    try {
      pushes = scriptPushes(unhex(String(spendIn.signature_script ?? '').toLowerCase()));
    } catch {
      break;
    }
    if (pushes.length < 2 || !same(pushes[pushes.length - 1], curSh.redeem)) break;

    if (curState.stage === STAGE.S_PAYOUT) {
      if (spendTx.outputs.some(o => String(o?.covenant_id ?? '').toLowerCase() === curSh.shardCid)) break;
      let payAction = 'PAYOUT_SELF';
      try { if (scriptNumber(pushes[0]) === 1n) payAction = 'PAYOUT_EXECUTOR'; } catch {}
      caughtReceipts.push({action: payAction, txid, feeSompi: restTxFee(spendTx), finalized: true, shardCid: curSh.shardCid});
      return {advanced: true, shard: {...curSh, terminal: true}, live: false, receipts: caughtReceipts};
    }

    if (curState.stage === STAGE.S_REFUND) {
      let recIdx;
      try { recIdx = Number(scriptNumber(pushes[0])); } catch { break; }
      if (!Number.isInteger(recIdx) || recIdx < 0 || recIdx >= curState.recordCount) break;
      const nextMask = curState.claimedMask | (1 << recIdx);
      const fullMask = curState.recordCount === 1 ? 1 : 3;
      if (nextMask === fullMask) {
        if (spendTx.outputs.some(o => String(o?.covenant_id ?? '').toLowerCase() === curSh.shardCid)) break;
        caughtReceipts.push({action: 'CLAIM_REFUND', txid, feeSompi: restTxFee(spendTx), finalized: true, shardCid: curSh.shardCid, recIdx});
        return {advanced: true, shard: {...curSh, claimedMask: nextMask, terminal: true}, live: false, receipts: caughtReceipts};
      }
      const nextState = {...curState, claimedMask: nextMask};
      const nextRedeem = redeemForState(nextState, profile);
      const nextSpk = p2sh(hex(blake2b256(nextRedeem)));
      const out0 = spendTx.outputs.find(o => Number(o?.index) === 0);
      if (!out0 || String(out0.script_public_key ?? '').toLowerCase() !== nextSpk.script) break;
      if (out0.covenant_id != null && String(out0.covenant_id).toLowerCase() !== curSh.shardCid) break;
      hops++;
      caughtReceipts.push({action: 'CLAIM_REFUND', txid, feeSompi: restTxFee(spendTx), finalized: true, shardCid: curSh.shardCid, recIdx});
      curSh = shardEntryFromState({
        shardCid: curSh.shardCid,
        state: nextState,
        redeem: nextRedeem,
        spk: nextSpk,
        outpoint: {transactionId: txid, index: 0},
        value: BigInt(String(out0.amount)),
        daaScore: 0n,
      });
      const live = await probeLiveOutpoint(rpc, curSh.spk, curSh.outpoint, curSh.shardCid, prefix);
      if (live.ok && live.hit) {
        curSh = {...curSh, value: live.hit.value, spk: live.hit.spk ?? curSh.spk, daaScore: live.hit.daa ?? live.hit.utxoDaa ?? 0n};
        return {advanced: true, shard: curSh, live: true, receipts: caughtReceipts};
      }
    } else {
      break;
    }
  }
  return {advanced: hops > 0, shard: curSh, live: false, receipts: caughtReceipts};
}

function formatKusdt6(amount) {
  const n = BigInt(amount);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

async function fetchJsonBounded(fetcher, url, timeoutMs = 10_000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {method: 'GET', credentials: 'omit', cache: 'no-store', signal: abort.signal});
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Discover a P2PK owner's KCC-20 (kUSDT) cells via Kascov (primary) / Kasvio (fallback),
 * then verify every cell's pinned template hash, state layout, P2SH hash, AND live unspent state on the user's own Kaspa node. */
const KCC20_CAND_CACHE_MS = 15_000;
const kcc20CandCacheByFetcher = new WeakMap();
const kcc20CandInflightByFetcher = new WeakMap();

function kcc20CacheMap(store, fetcher) {
  let m = store.get(fetcher);
  if (!m) {
    m = new Map();
    store.set(fetcher, m);
  }
  return m;
}

export function invalidateOwnerKcc20Cache(ownerPk, fetcher = globalThis.fetch) {
  if (typeof fetcher !== 'function') return;
  const cache = kcc20CandCacheByFetcher.get(fetcher);
  if (!cache) return;
  if (!ownerPk) {
    cache.clear();
    return;
  }
  const suffix = `:${ownerPk}`;
  for (const k of [...cache.keys()]) {
    if (k.endsWith(suffix)) cache.delete(k);
  }
}

async function fetchOwnerKcc20Candidates({ownerPk, kusdtCid, kcc20Suffix, net = null, fetcher = globalThis.fetch, bypassCache = false}) {
  if (net?.key !== 'mainnet' || typeof fetcher !== 'function') {
    return {candidates: [], source: null, discoveryError: null, fromCache: false};
  }
  const cacheKey = `${net.key}:${kusdtCid}:${ownerPk}`;
  const cache = kcc20CacheMap(kcc20CandCacheByFetcher, fetcher);
  if (!bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < KCC20_CAND_CACHE_MS) {
      return {candidates: hit.candidates, source: hit.source, discoveryError: null, fromCache: true};
    }
  }
  const inflight = kcc20CacheMap(kcc20CandInflightByFetcher, fetcher);
  if (!bypassCache && inflight.has(cacheKey)) {
    return await inflight.get(cacheKey);
  }
  const task = (async () => {
    const prefixBytes = unhex(KCC20_PREFIX_HEX);
    const candidates = [];
    let source = null;
    let discoveryError = null;
    try {
      const data = await fetchJsonBounded(fetcher, `${KASCOV_MAINNET_BASE}/token/${kusdtCid}/cells?owner=00${ownerPk}&limit=1000`);
      check(data?.network === 'mainnet' && data?.token_id === kusdtCid && data?.owner === `00${ownerPk}` && Array.isArray(data.cells), 'KASCOV_RESPONSE');
      for (const cell of data.cells) {
        if (!cell || cell.is_minter !== false) continue;
        const parts = String(cell.outpoint ?? '').split(':');
        if (parts.length !== 2 || !HASH64.test(parts[0]) || !/^\d+$/.test(parts[1])) continue;
        const index = Number(parts[1]);
        if (!Number.isSafeInteger(index) || index < 0) continue;
        const rawHex = String(cell.program_hex ?? '').toLowerCase();
        if (rawHex.length !== (34 + 112 + KCC20_SUFFIX_LEN) * 2) continue;
        let redeem;
        try { redeem = unhex(rawHex); } catch { continue; }
        if (!same(redeem.slice(0, 34), prefixBytes) || !same(redeem.slice(34 + 112), kcc20Suffix)) continue;
        let st;
        try { st = decodeKcc20State(redeem.slice(34, 146)); } catch { continue; }
        if (st.owner !== ownerPk || st.ownerScheme !== KCC20_OWNER_SCHEME.P2PK_SCHNORR) continue;
        if (st.borrowScheme < 0 || st.borrowScheme > 3 || st.extensionCommitment !== ZERO32 || st.amount <= 0n) continue;
        if (cell.amount_str != null && String(cell.amount_str) !== st.amount.toString()) continue;
        const spk = p2sh(hex(blake2b256(redeem)));
        if (cell.script_hex && spk.script !== String(cell.script_hex).toLowerCase()) continue;
        candidates.push({outpoint: {transactionId: parts[0], index}, amount: st.amount, redeem, spk});
      }
      source = 'kascov';
    } catch (e) {
      discoveryError = e;
      try {
        const resp = await fetchJsonBounded(fetcher, `${KASVIO_MAINNET_BASE}/tokens/${kusdtCid}/balance?owner=${ownerPk}&scheme=00`);
        const d = resp?.data;
        check(resp?.meta?.network === 'mainnet' && d?.covenant_id === kusdtCid && d?.owner_value === ownerPk && d?.owner_scheme === 0 && Array.isArray(d.outputs), 'KASVIO_RESPONSE');
        for (const o of d.outputs) {
          if (!o || !HASH64.test(String(o.txid ?? '')) || !Number.isSafeInteger(Number(o.output_index))) continue;
          let amt;
          try { amt = BigInt(String(o.balance_raw ?? '0')); } catch { continue; }
          if (amt <= 0n) continue;
          const outpoint = {transactionId: String(o.txid).toLowerCase(), index: Number(o.output_index)};
          for (const borrowScheme of [0, 1]) {
            const {redeem, scriptPubKey: spk} = kcc20RedeemAndSpk(
              {amount: amt, owner: ownerPk, ownerScheme: KCC20_OWNER_SCHEME.P2PK_SCHNORR, borrowScheme},
              kcc20Suffix,
            );
            candidates.push({outpoint, amount: amt, redeem, spk});
          }
        }
        source = 'kasvio';
        discoveryError = null;
      } catch (e2) {
        discoveryError = e2;
      }
    }
    if (!discoveryError && source) {
      cache.set(cacheKey, {candidates, source, at: Date.now()});
    }
    return {candidates, source, discoveryError, fromCache: false};
  })().finally(() => {
    if (inflight.get(cacheKey) === task) inflight.delete(cacheKey);
  });
  if (!bypassCache) inflight.set(cacheKey, task);
  return await task;
}

export async function prefetchOwnerKcc20Candidates({ownerPk, kusdtCid, kcc20Suffix, net = null, fetcher = globalThis.fetch}) {
  if (typeof ownerPk !== 'string' || !HASH64.test(ownerPk) || typeof kusdtCid !== 'string' || !HASH64.test(kusdtCid) || !kcc20Suffix) return;
  try {
    verifyKcc20Suffix(kcc20Suffix);
    await fetchOwnerKcc20Candidates({ownerPk, kusdtCid, kcc20Suffix, net, fetcher});
  } catch {}
}

async function verifyKcc20CandidatesOnNode({rpc, candidates, kusdtCid, prefix}) {
  if (!candidates.length) return [];
  const byAddr = new Map();
  for (const cand of candidates) {
    const addr = spkToAddress(cand.spk, prefix);
    const list = byAddr.get(addr);
    if (list) list.push(cand);
    else byAddr.set(addr, [cand]);
  }
  const addrs = [...byAddr.keys()];
  const liveCells = [];
  const seen = new Set();
  for (let i = 0; i < addrs.length; i += 64) {
    const batch = addrs.slice(i, i + 64);
    try {
      const [utxos, spent] = await Promise.all([
        commonUtxosByAddresses(rpc, batch, {chunkSize: 64}),
        mempoolSpentOutpoints(rpc, batch).catch(() => new Set()),
      ]);
      const utxoByOutpoint = new Map();
      for (const u of utxos) {
        if (!u?.outpoint || u.isCoinbase || u.covenantId !== kusdtCid) continue;
        utxoByOutpoint.set(`${u.outpoint.transactionId}:${u.outpoint.index}`, u);
      }
      for (const addr of batch) {
        for (const cand of byAddr.get(addr) ?? []) {
          const key = `${cand.outpoint.transactionId}:${cand.outpoint.index}`;
          if (seen.has(key) || spent.has(key)) continue;
          const hit = utxoByOutpoint.get(key);
          if (!hit || hit.spk?.script !== cand.spk.script) continue;
          seen.add(key);
          const d = hit.daa ?? hit.utxoDaa ?? 0n;
          liveCells.push({
            outpoint: hit.outpoint,
            value: hit.value,
            spk: hit.spk ?? cand.spk,
            daa: d,
            utxoDaa: d,
            covenantId: kusdtCid,
            amount: cand.amount,
            redeem: cand.redeem,
          });
        }
      }
    } catch {}
  }
  return liveCells;
}

export async function discoverOwnerKcc20Utxos({rpc, ownerPk, kusdtCid, kcc20Suffix, net = null, fetcher = globalThis.fetch, bypassCache = false}) {
  check(typeof ownerPk === 'string' && HASH64.test(ownerPk), 'KUSDT_V2_OWNER_PK');
  check(typeof kusdtCid === 'string' && HASH64.test(kusdtCid), 'KUSDT_V2_CID');
  verifyKcc20Suffix(kcc20Suffix);
  const prefix = net?.addressPrefix ?? 'kaspa';
  let fetched = await fetchOwnerKcc20Candidates({ownerPk, kusdtCid, kcc20Suffix, net, fetcher, bypassCache});
  let liveCells = await verifyKcc20CandidatesOnNode({rpc, candidates: fetched.candidates, kusdtCid, prefix});
  if (fetched.fromCache && !liveCells.length) {
    fetched = await fetchOwnerKcc20Candidates({ownerPk, kusdtCid, kcc20Suffix, net, fetcher, bypassCache: true});
    liveCells = await verifyKcc20CandidatesOnNode({rpc, candidates: fetched.candidates, kusdtCid, prefix});
  }
  return {cells: liveCells, source: fetched.source, discoveryError: fetched.discoveryError};
}

/** Select the cleanest subset of KCC-20 cells within maxInputs (prefer single smallest cell >= cost; else largest-first). */
export function selectKcc20Cells(cells, cost, maxInputs = 3) {
  const totalBalance = cells.reduce((s, c) => s + BigInt(c.amount), 0n);
  const single = cells
    .filter(c => BigInt(c.amount) >= cost)
    .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0));
  if (single.length) return {selected: [single[0]], totalBalance, maxReachable: totalBalance};
  const desc = [...cells].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
  const selected = [];
  let sum = 0n;
  for (const c of desc) {
    if (selected.length >= maxInputs) break;
    selected.push(c);
    sum += BigInt(c.amount);
    if (sum >= cost) break;
  }
  const maxReachable = desc.slice(0, maxInputs).reduce((s, c) => s + BigInt(c.amount), 0n);
  return {selected: sum >= cost ? selected : [], totalBalance, maxReachable};
}

async function findLiveVaultUtxo({rpc, shardCid, amount, kusdtCid, kcc20Suffix, prefix}) {
  const {redeem, scriptPubKey: spk} = kcc20RedeemAndSpk(
    {amount, owner: shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID},
    kcc20Suffix,
  );
  const utxos = await commonUtxos(rpc, spkToAddress(spk, prefix));
  const hit = utxos.find(u => !u.isCoinbase && u.covenantId === kusdtCid && u.spk?.script === spk.script && u.value === SHARD_VAULT_DEPOSIT && u.outpoint);
  check(hit, 'STALE_INPUT');
  const d = hit.daa ?? hit.utxoDaa ?? 0n;
  return {outpoint: hit.outpoint, value: hit.value, spk: hit.spk ?? spk, daa: d, utxoDaa: d, covenantId: kusdtCid, amount, redeem};
}

export function buildKusdtV2AssetDeltas({action, qty = 0, price = 0n, vaultAmount = 0n, refundAmount = 0n, registrationSompi = 0n, fee = 0n, net = null, kusdtCid}) {
  const kas = kasAsset(net);
  const kusdt = kusdtAsset(kusdtCid);
  const deltas = [];
  if (action === 'CREATE_ROUND') {
    deltas.push({asset: kas, amount: -400_000_000n, role: 'REFUNDABLE_DEPOSIT'});
    if (registrationSompi > 0n) deltas.push({asset: kas, amount: -BigInt(registrationSompi), role: 'NET'});
  } else if (action === 'OPEN_SHARD') {
    deltas.push({asset: kusdt, amount: -(BigInt(qty) * BigInt(price)), role: 'NET'});
    deltas.push({asset: kas, amount: -SHARD_TOTAL_DEPOSIT, role: 'REFUNDABLE_DEPOSIT'});
  } else if (action === 'BUY') {
    deltas.push({asset: kusdt, amount: -(BigInt(qty) * BigInt(price)), role: 'NET'});
  } else if (action === 'PAYOUT_EXECUTOR') {
    deltas.push({asset: kusdt, amount: EXECUTOR_REWARD, role: 'NET'});
    deltas.push({asset: kas, amount: -(WINNER_CARRIER_MIN * 2n), role: 'CARRIER'});
  } else if (action === 'PAYOUT_SELF') {
    deltas.push({asset: kusdt, amount: BigInt(vaultAmount), role: 'NET'});
    deltas.push({asset: kas, amount: -WINNER_CARRIER_MIN, role: 'CARRIER'});
  } else if (action === 'CLAIM_REFUND') {
    deltas.push({asset: kusdt, amount: BigInt(refundAmount), role: 'NET'});
    deltas.push({asset: kas, amount: -WINNER_CARRIER_MIN, role: 'CARRIER'});
  }
  if (fee > 0n) deltas.push({asset: kas, amount: -BigInt(fee), role: 'FEE'});
  return deltas;
}

export function kusdtV2InteractiveModel(round, {isWinner = false} = {}) {
  const k = round?.kusdt;
  if (!k) return null;
  const shards = Array.isArray(k.shards) ? k.shards : [];
  const openShards = shards.filter(sh => !sh.terminal && sh.stage === STAGE.S_OPEN && Number(sh.recordCount ?? 0) < MAX_RECORDS_PER_SHARD);
  const openedTotal = Number(k.openedCount ?? 0);
  const buyShardSelector = {
    canOpenNew: openShards.length < MAX_ACTIVE_OPEN_SHARDS && openedTotal < MAX_SHARDS,
    activeOpenCount: openShards.length,
    maxActiveOpen: MAX_ACTIVE_OPEN_SHARDS,
    depositKas: '4',
    options: openShards.map(sh => ({
      shardId: sh.shardCid,
      tickets: Number(sh.tickets ?? 0),
      recordCount: Number(sh.recordCount ?? 0),
      maxRecords: MAX_RECORDS_PER_SHARD,
    })),
  };
  const actShards = shards.filter(s => !s.terminal && (s.stage === STAGE.S_PAYOUT || s.stage === STAGE.S_REFUND));
  const price = BigInt(k.price ?? round?.settings?.ticketPrice ?? 1_000_000n);
  const shardSettlement = actShards.length
    ? {
        mode: actShards.some(s => s.stage === STAGE.S_REFUND) ? 'refund' : 'payout',
        depositKas: '4',
        execRewardFormatted: '0.5',
        groups: actShards.map(s => {
          if (s.stage === STAGE.S_REFUND) {
            const recs = Array.isArray(s.records) ? s.records : [];
            return {
              shardId: s.shardCid,
              mode: 'refund',
              claims: recs.map((rec, idx) => {
                const prev = idx === 0 ? 0 : recs[idx - 1].cumTickets;
                const qty = rec.cumTickets - prev;
                const claimed = ((s.claimedMask ?? 0) & (1 << idx)) !== 0;
                return {
                  recordIndex: idx,
                  buyerKey: rec.buyerPk,
                  tickets: qty,
                  amount: BigInt(qty) * price,
                  claimed,
                  op: {action: 'CLAIM_REFUND', shardCid: s.shardCid, recIdx: idx},
                };
              }),
            };
          }
          return {
            shardId: s.shardCid,
            mode: 'payout',
            selfPayoutOp: isWinner ? {action: 'PAYOUT_SELF', shardCid: s.shardCid} : null,
            execPayoutOp: {action: 'PAYOUT_EXECUTOR', shardCid: s.shardCid},
          };
        }),
      }
    : null;
  return {buyShardSelector, shardSettlement};
}

export function createKusdtV2Adapter({profile, kusdtCid = null, kcc20Suffix = null, canCreate = true} = {}) {
  check(profile && typeof profile.id === 'string' && profile.frames?.m_open, 'KUSDT_V2_PROFILE');
  const effectiveCid = kusdtCid ?? profile.kusdtCid;
  const profileId = profile.id;
  const defaultSuffix = kcc20Suffix instanceof Uint8Array ? kcc20Suffix : (typeof kcc20Suffix === 'string' ? unhex(kcc20Suffix) : null);

  async function selectKasFunding(rpc, wallet, reserved = new Set()) {
    const kasDesc = {kind: 'KAS', symbol: 'KAS', decimals: 8, tokenCovenantId: null};
    const [raw, inPool] = await Promise.all([
      getAssetUtxos(rpc, wallet.address, kasDesc),
      mempoolSpentOutpoints(rpc, wallet.address),
    ]);
    const live = raw
      .filter(u => {
        if (!u.outpoint) return false;
        const k = `${u.outpoint.transactionId}:${u.outpoint.index}`;
        return !inPool.has(k) && !reserved.has(k);
      })
      .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))
      .map(u => ({...u, utxoDaa: u.utxoDaa ?? u.daa ?? 0n}));
    if (!live.length && raw.length && (inPool.size || reserved.size)) {
      throw Object.assign(new Error('WALLET_FUNDS_PENDING'), {code: 'WALLET_FUNDS_PENDING'});
    }
    return live;
  }

  return Object.freeze({
    id: KUSDT_V2_PROTOCOL_ID,
    name: 'kUSDT v2 (Parallel Shards)',
    profileId,
    profile,
    supportedNetworks: Object.freeze(['mainnet']),
    supportsNetwork(net = null) {
      return !net || net.key === 'mainnet';
    },
    displayName() {
      return 'kUSDT v2 (KCC-20)';
    },
    capabilities: Object.freeze({
      canCreate: !!canCreate,
      multiShardSelect: true,
      pullRefund: true,
      supportsExecIncentive: true,
      supportsBudgetCalculator: false,
      supportsBatchSettlement: false,
      supportsIntentResend: false,
      freeActions: Object.freeze([]),
      customRoundSync: true,
      customLifecycle: true,
    }),
    assetFor() {
      return kusdtAsset(effectiveCid);
    },
    prefetchForWallet({wallet, net = null, fetcher = globalThis.fetch} = {}) {
      if (!wallet?.key || !defaultSuffix) return;
      void prefetchOwnerKcc20Candidates({ownerPk: wallet.key, kusdtCid: effectiveCid, kcc20Suffix: defaultSuffix, net, fetcher});
    },
    invalidateWalletCache(ownerPk, fetcher = globalThis.fetch) {
      invalidateOwnerKcc20Cache(ownerPk, fetcher);
    },
    matchesRound(r) {
      if (!r || typeof r !== 'object') return false;
      if (r.profileId) return r.profileId === profileId;
      return !!r.kusdt || r.protocol === KUSDT_V2_PROTOCOL_ID || r.protocolId === KUSDT_V2_PROTOCOL_ID;
    },
    viewMeta() {
      return Object.freeze({
        protocolId: KUSDT_V2_PROTOCOL_ID,
        profileId,
        displayName: 'kUSDT v2 (KCC-20)',
        shardModel: 'parallel',
        maxShards: MAX_SHARDS,
        supportsBatchSettlement: false,
        supportsIntentResend: false,
        freeActions: Object.freeze([]),
        actionStyle: 'parallel_dispatch',
      });
    },
    createSpec(net = null) {
      return Object.freeze({
        protocolId: KUSDT_V2_PROTOCOL_ID,
        profileId,
        name: 'kUSDT v2',
        displayName: 'kUSDT v2 (KCC-20)',
        layout: 'parallel_fixed_shards',
        supportedOnNet: !net || net.key === 'mainnet',
        asset: kusdtAsset(effectiveCid),
        priceMin: PRICE_MIN,
        priceMax: PRICE_MAX,
        fixedTicketCap: MAX_SHARDS * MAX_RECORDS_PER_SHARD,
        minTicketCap: MIN_DRAW_TICKETS,
        maxTicketCap: MAX_SHARDS * MAX_RECORDS_PER_SHARD,
        fixedMinTickets: MIN_DRAW_TICKETS,
        minTicketsFloor: MIN_DRAW_TICKETS,
        shardSize: MAX_RECORDS_PER_SHARD,
        maxShards: MAX_SHARDS,
        creatorDepositSompi: MANAGER_DEPOSIT,
        minCloseMinutes: 1,
        maxCloseMinutes: 10080,
      });
    },
    roundFingerprint(r) {
      if (!r) return '';
      const k = r.kusdt;
      const shKey = (k?.shards ?? []).map(s => `${s.shardCid}:${s.outpoint?.transactionId ?? ''}:${s.outpoint?.index ?? ''}:${s.stage ?? 0}:${s.tickets ?? 0}:${s.terminal ? 1 : 0}:${s.claimedMask ?? 0}:${s.records?.length ?? 0}:${s.frozenRedeem ? 1 : 0}`).join(',');
      const rcKey = (r.receipts ?? []).map(t => `${t.txid}:${t.action}:${t.finalized === false ? 0 : 1}:${t.feeSompi ?? ''}:${t.shardCid ?? ''}:${t.recordIndex ?? ''}:${t.recIdx ?? ''}:${t.acceptingBlock ?? ''}`).join(';');
      return `${r.terminal ?? ''}|${r.manager?.outpoint?.transactionId ?? ''}:${r.manager?.outpoint?.index ?? ''}|${r.accepting ?? ''}|${r.draw ? `${r.draw.txid}:${r.draw.shard}:${r.draw.record}:${r.draw.ticket}` : ''}|${k?.stage ?? ''}|${k?.totalTickets ?? 0}|${k?.openedCount ?? 0}|${k?.cursor ?? 0}|${k?.decision ?? 0}|${!!k?.nodeVerified}|${rcKey}|${shKey}`;
    },
    isNodeVerified(r) {
      return !!r?.terminal || !!r?.kusdt?.nodeVerified;
    },
    isTerminalImmutable() {
      return false;
    },
    lockedSompi(r) {
      return r?.manager ? BigInt(r.manager.value ?? 0n) : 0n;
    },
    holdingsOf(r, facts, shards, walletKey) {
      if (!walletKey || r?.terminal || !shards || !['sales', 'sealed', 'win', 'refund'].includes(facts?.module ?? '')) return null;
      let mine = 0;
      let total = 0;
      for (const s of shards) { mine += s.mineCount; total += s.tickets; }
      return {tickets: mine, total};
    },
    interactiveModel(r, opts = {}) {
      return kusdtV2InteractiveModel(r, opts);
    },
    matchBuyReceipt(sh, rec, r, shards) { return parallelShardBuyReceipt(sh, rec, r, shards); },
    matchRefundReceipt(sh, rec, r, shards) { return parallelShardRefundReceipt(sh, rec, r, shards); },
    shardRefundReceipts(sh, r, shards) { return parallelShardRefundReceipts(sh, r, shards); },
    isPurchaseReceipt(t) { return t?.action === 'BUY' || t?.action === 'OPEN_SHARD'; },
    isRefundReceipt(t) { return t?.action === 'CLAIM_REFUND'; },
    verifyDrawReceipt(r, rpc, opts) { return verifyKusdtDrawReceipt(r, rpc, profile, opts); },
    buildPreparedIntent({prepared: p, signed, now = Date.now}) {
      const act = p.subAction ?? p.kusdtAction ?? p.op.action;
      return {
        status: 'PREPARED',
        action: act,
        txid: signed.txid,
        profileId,
        draft: signed.draft,
        createdAtMs: typeof now === 'function' ? now() : now,
        nextManagerState: p.managerState ?? null,
        nextShardState: p.shardState ?? null,
        nextShardStates: p.shardStates ?? null,
        shardCid: p.shardCid ?? p.op?.shardCid ?? null,
        recordIndex: act === 'OPEN_SHARD' ? 0 : (act === 'BUY' && Array.isArray(p.shardState?.records) ? p.shardState.records.length - 1 : null),
        recIdx: act === 'CLAIM_REFUND' && p.op?.recIdx != null ? Number(p.op.recIdx) : null,
        proof: p.passAProof ?? null,
        drawResult: p.drawResult ?? null,
      };
    },
    createGenesisRound({prepared: p, signed, intent, wallet}) {
      const mgrSpk = p.transaction?.outputs?.[0]?.scriptPublicKey ?? null;
      return {
        cid: p.cid,
        profileId,
        source: 'created',
        terminal: null,
        halted: null,
        intent,
        manager: p.managerRedeem && mgrSpk ? {
          outpoint: {transactionId: signed.txid, index: 0},
          value: MANAGER_DEPOSIT,
          spk: mgrSpk,
          utxoDaa: 0n,
          daaScore: 0n,
          covenantId: p.cid,
          redeemScript: p.managerRedeem,
        } : null,
        frozen: [],
        receipts: [{action: 'GENESIS', txid: signed.txid, feeSompi: String(p.fee ?? 0), finalized: false}],
        pending: [],
        fees: BigInt(p.fee ?? 0),
        origin: p.transaction?.inputs?.[0]?.previousOutpoint ?? null,
        settings: {...p.settings, closeDaa: p.settings.closeEligibleDaa, creatorPk: wallet.key},
        bought: 0,
        step: 0,
        kusdt: {
          stage: 1,
          price: p.settings.ticketPrice,
          closeDaa: p.settings.closeEligibleDaa,
          openedCount: 0,
          cursor: 0,
          totalTickets: 0,
          decision: 0,
          creatorPk: wallet.key,
          winnerPk: null,
          nodeVerified: false,
          shards: [],
        },
      };
    },
    canAttachIntent(round, intent) {
      return !round.intent && (!!round.manager || ['PAYOUT_EXECUTOR', 'PAYOUT_SELF', 'CLAIM_REFUND'].includes(intent.action));
    },
    shouldRemoveOnGenesisDiscard(round, intent) {
      return !round?.kusdt?.nodeVerified && (round?.receipts?.length ?? 0) <= 1 && intent?.action === 'GENESIS';
    },
    emptyRound(args) {
      return emptyKusdtV2Round({...args, profileId});
    },
    validateRound(r, opts = {}) {
      return validateKusdtV2Round(r, profile, {...opts, profileId});
    },
    roundFromText(text, opts = {}) {
      return kusdtV2RoundFromText(text, profile, {...opts, profileId});
    },
    roundToText(r) {
      return kusdtV2RoundToText(r);
    },
    availableActions(r, currentDaa = 0n) {
      return availableKusdtV2Actions(r, profile, currentDaa);
    },
    prepareOperation(args) {
      const {action, net = null, feerate = null} = args;
      const defaultFee = action === 'CREATE_ROUND' || action === 'EMPTY_CLOSE' || action === 'REROLL'
        ? 10_000n
        : action === 'COLLECT_BATCH' || action === 'DISPATCH_BATCH'
          ? 40_000n
          : action === 'OPEN_SHARD' || action === 'DRAW'
            ? 25_000n
            : action === 'PAYOUT_EXECUTOR' || action === 'PAYOUT_SELF' || action === 'CLAIM_REFUND'
              ? 15_000n
              : 20_000n;
      const buildWithFee = f => {
        if (action === 'CREATE_ROUND') return buildCreateRoundTx({...args, fee: f, profile});
        if (action === 'OPEN_SHARD') return buildOpenShardTx({...args, fee: f, profile});
        if (action === 'BUY') return buildBuyTx({...args, fee: f, profile});
        if (action === 'EMPTY_CLOSE') return buildEmptyCloseTx({...args, fee: f, profile});
        if (action === 'COLLECT_BATCH') return buildCollectBatchTx({...args, fee: f, profile});
        if (action === 'DRAW') return buildDrawTx({...args, fee: f, profile});
        if (action === 'REROLL') return buildRerollTx({...args, fee: f, profile});
        if (action === 'DISPATCH_BATCH') return buildDispatchBatchTx({...args, fee: f, profile});
        if (action === 'PAYOUT_EXECUTOR' || action === 'PAYOUT_SELF') return buildPayoutTx({...args, fee: f, profile});
        if (action === 'CLAIM_REFUND') return buildClaimRefundTx({...args, fee: f, profile});
        throw new Error(`KUSDT_V2_UNKNOWN_ACTION:${action}`);
      };
      let built;
      let fee;
      if (args.fee != null) {
        fee = BigInt(args.fee);
        built = buildWithFee(fee);
      } else if (feerate != null) {
        let lastBuilt = null;
        const converged = convergeFee(f => {
          lastBuilt = buildWithFee(f);
          return lastBuilt.draft;
        }, String(feerate), {cap: FEE_CAP});
        built = {...lastBuilt, mass: converged.quote, fee: converged.fee, txid: referenceTxId(lastBuilt.transaction)};
        fee = converged.fee;
      } else {
        fee = defaultFee;
        built = buildWithFee(fee);
      }

      const assetDeltas = buildKusdtV2AssetDeltas({
        action,
        qty: args.qty,
        price: args.price ?? args.round?.settings?.ticketPrice ?? 0n,
        vaultAmount: args.vaultAmount ?? 0n,
        refundAmount: args.refundAmount ?? 0n,
        registrationSompi: action === 'CREATE_ROUND' && args.registrySpk ? REGISTRATION_SOMPI : 0n,
        fee,
        net,
        kusdtCid: effectiveCid,
      });
      return {
        ...built,
        fee,
        feerate: feerate != null ? String(feerate) : null,
        assetDeltas,
        review: {
          txid: built.txid ?? referenceTxId(built.transaction),
          fee,
          assetDeltas,
        },
      };
    },
    async signAndRecord({wallet, prepared, submit, signal = null}) {
      check(wallet && typeof wallet.sign === 'function', 'KUSDT_V2_WALLET');
      const draft = prepared?.draft ?? prepared;
      check(draft && draft.transaction && Array.isArray(draft.inputUtxos) && Array.isArray(draft.authorizedInputIndices), 'KUSDT_V2_DRAFT');
      await wallet.sign(draft, {signal});
      await verifyOrdinarySignatures(draft);
      const txid = submit ? await submit(draft.transaction) : referenceTxId(draft.transaction);
      return {txid, transaction: draft.transaction, draft};
    },
    authenticateIntent(intent) {
      check(intent && typeof intent === 'object' && intent.cid && intent.action, 'KUSDT_V2_INTENT');
      check(!intent.profileId || intent.profileId === profileId, 'KUSDT_V2_PROFILE_MISMATCH');
      return intent;
    },
    verifyIndexedSnapshot(doc) {
      check(doc && typeof doc === 'object' && doc.cid, 'KUSDT_V2_INDEXED_DOC');
      if (doc.profileId) check(doc.profileId === profileId, 'KUSDT_V2_PROFILE_MISMATCH');
      return doc;
    },
    materializeIndexedDocument(doc) {
      check(doc && typeof doc === 'object' && doc.cid, 'KUSDT_V2_INDEXED_DOC');
      if (doc.round) validateKusdtV2Round(doc.round, profile, {profileId});
      return doc.round ?? emptyKusdtV2Round({
        cid: doc.cid,
        settings: doc.settings,
        profileId,
      });
    },
    async syncRound({rpc = null, indexer = null, round = null, cid = null, net = null, fetcher = globalThis.fetch} = {}) {
      const targetCid = cid ?? round?.cid;
      if (!indexer && !rpc && round) {
        validateKusdtV2Round(round, profile, {profileId});
        return {round, changed: false};
      }
      check(typeof targetCid === 'string' && /^[0-9a-f]{64}$/.test(targetCid), 'KUSDT_V2_CID');
      const prefix = net?.addressPrefix ?? 'kaspatest';
      const prevK = round?.kusdt ?? {};
      let stage = prevK.stage ?? STAGE.M_OPEN;
      let price = BigInt(prevK.price ?? round?.settings?.ticketPrice ?? 1_000_000n);
      let closeDaa = BigInt(prevK.closeDaa ?? round?.settings?.closeEligibleDaa ?? round?.settings?.closeDaa ?? 0n);
      let openedCount = Number(prevK.openedCount ?? 0);
      let cursor = Number(prevK.cursor ?? 0);
      let totalTickets = Number(prevK.totalTickets ?? round?.bought ?? 0);
      let mgrTotalTickets = 0;
      let detTicketsSold = 0;
      let decision = Number(prevK.decision ?? 0);
      let creatorPk = prevK.creatorPk ?? round?.settings?.creatorPk ?? null;
      let winnerPk = normWinnerPk(prevK.winnerPk ?? round?.winnerPk ?? null);
      let terminal = round?.terminal ?? null;
      let manager = round?.manager ?? null;
      const shardMap = new Map();
      for (const s of (Array.isArray(prevK.shards) ? prevK.shards : [])) {
        if (s?.shardCid) shardMap.set(s.shardCid, s);
      }
      let origin = round?.origin ?? null;
      let genesisTxid = round?.receipts?.find(r => r.action === 'GENESIS')?.txid ?? null;

      let localMgrState = null;
      if (manager?.redeemScript) {
        try {
          localMgrState = verifyKusdtV2Redeem(manager.redeemScript, profile, 'manager').state;
          stage = Number(localMgrState.stage);
          price = BigInt(localMgrState.price);
          closeDaa = BigInt(localMgrState.closeDaa);
          openedCount = Number(localMgrState.openedCount);
          cursor = Number(localMgrState.cursor);
          mgrTotalTickets = Number(localMgrState.totalTickets ?? 0);
          decision = Number(localMgrState.decision ?? 0);
          creatorPk = localMgrState.creatorPk;
          winnerPk = normWinnerPk(localMgrState.winnerPk) ?? winnerPk;
        } catch {}
      }

      // Check local manager live on node BEFORE allowing a lagging indexer to overwrite it
      let nodeVerified = false;
      let localMgrLive = false;
      if (rpc && !terminal && manager?.spk) {
        const probe = await probeLiveOutpoint(rpc, manager.spk, manager.outpoint, targetCid, prefix, {allowSameSpk: true});
        if (probe.ok && probe.hit) {
          const d = probe.hit.daa ?? probe.hit.utxoDaa ?? 0n;
          manager = {
            ...manager,
            outpoint: probe.hit.outpoint,
            value: probe.hit.value,
            spk: probe.hit.spk ?? manager.spk,
            utxoDaa: d,
            daaScore: d,
            daa: d,
            covenantId: targetCid,
          };
          localMgrLive = true;
          nodeVerified = true;
        }
      }

      let detMatchesFinal = false;
      let detCandidateTerminal = null;
      let detHeadTxid = null;
      let detHeadAccepting = null;
      let detDrawHint = null;
      let canonicalShardOrder = null;
      if (localMgrState?.entries?.length) canonicalShardOrder = localMgrState.entries.map(e => e.shardCid);
      else if (localMgrState?.shardCids?.length) canonicalShardOrder = [...localMgrState.shardCids];
      const kciReceipts = [];
      const caughtReceipts = [];
      let detProfileMismatch = false;
      if (indexer) {
        try {
          const det = await indexer.roundDetail(targetCid);
          if (det?.profileId && det.profileId !== profile.id) {
            detProfileMismatch = true;
            throw new Error('UNSUPPORTED_PROFILE');
          }
          const pd = det.protocolData ?? det.summary?.protocolData ?? {};
          if (!origin && det.origin?.transactionId) origin = det.origin;
          if (typeof det.head?.txid === 'string' && HASH64.test(det.head.txid.toLowerCase())) detHeadTxid = det.head.txid.toLowerCase();
          if (typeof det.head?.acceptingBlock === 'string' && HASH64.test(det.head.acceptingBlock.toLowerCase())) detHeadAccepting = det.head.acceptingBlock.toLowerCase();
          if (det.draw && typeof det.draw === 'object'
            && typeof det.draw.txid === 'string' && HASH64.test(det.draw.txid.toLowerCase())
            && Number.isInteger(det.draw.shard) && det.draw.shard >= 0
            && Number.isInteger(det.draw.record) && det.draw.record >= 0
            && Number.isInteger(det.draw.ticket) && det.draw.ticket >= 0) {
            detDrawHint = {
              txid: det.draw.txid.toLowerCase(),
              shard: det.draw.shard,
              record: det.draw.record,
              ticket: det.draw.ticket,
            };
          }
          if (Array.isArray(det.receipts)) {
            for (const rc of det.receipts) {
              const norm = normalizeKusdtReceipt(rc);
              if (norm) kciReceipts.push(norm);
            }
          } else if (typeof indexer.roundHistory === 'function') {
            try {
              let histCursor = null;
              for (let page = 0; page < 5; page++) {
                const hist = await indexer.roundHistory(targetCid, {cursor: histCursor, limit: 200});
                for (const ev of (hist.events ?? [])) {
                  if (!ev || ev.type === 'ROLLBACK' || ev.status === 'ROLLED_BACK') continue;
                  const norm = normalizeKusdtReceipt({
                    action: ev.action,
                    txid: ev.txid,
                    feeSompi: ev.feeSompi ?? '0',
                    finalized: ev.status === 'FINAL' || ev.status === 'ACCEPTED',
                    shardCid: ev.shardCid,
                    recordIndex: ev.recordIndex,
                    recIdx: ev.recIdx,
                    acceptingBlock: ev.position?.acceptingBlockHash,
                    acceptingDaa: ev.position?.acceptingDaa,
                  });
                  if (norm) kciReceipts.push(norm);
                }
                if (!hist.nextCursor) break;
                histCursor = hist.nextCursor;
              }
            } catch {}
          }
          if (!genesisTxid) {
            const genRc = kciReceipts.find(r => r.action === 'GENESIS');
            if (genRc) genesisTxid = genRc.txid;
            else if (typeof det.head?.txid === 'string' && det.terminal == null && det.summary?.terminal == null && Number(det.revision ?? 0) <= 1) {
              genesisTxid = det.head.txid;
            }
          }
          const rawDetTerminal = det.terminal ?? det.summary?.terminal ?? null;
          const detTerminal = (rawDetTerminal === 'EMPTY' || rawDetTerminal === 'PAID' || rawDetTerminal === 'REFUNDED') ? rawDetTerminal : null;

          const parseDetMgr = m => {
            if (!m?.redeemHex || !m?.outpoint || m?.value == null || !m?.spk) return null;
            const redeemBytes = unhex(m.redeemHex);
            const mgrSt = verifyKusdtV2Redeem(redeemBytes, profile, 'manager').state;
            const mgrDaa = BigInt(m.daaScore ?? m.utxoDaa ?? '0');
            return {
              state: mgrSt,
              manager: {
                outpoint: m.outpoint,
                value: BigInt(m.value),
                spk: m.spk,
                utxoDaa: mgrDaa,
                daaScore: mgrDaa,
                daa: mgrDaa,
                covenantId: targetCid,
                redeemScript: redeemBytes,
              },
            };
          };

          let detParsed = null;
          if (!detTerminal) {
            if (det.manager) {
              try { detParsed = parseDetMgr(det.manager); } catch {}
            }
            if (!detParsed) {
              try {
                const cov = (await indexer.covenant(targetCid)).covenant;
                detParsed = parseDetMgr(cov);
              } catch {}
            }
          }

          const detMgrMatchesLocal = !!(
            detParsed?.manager?.outpoint
            && manager?.outpoint
            && detParsed.manager.outpoint.transactionId === manager.outpoint.transactionId
            && detParsed.manager.outpoint.index === manager.outpoint.index
          );
          const detSubPhase = String(det.summary?.subPhase ?? '');
          const detPhase = String(det.summary?.phase ?? '');
          const detManagerDestroyed = !detTerminal && !detParsed && det.manager == null
            && (detSubPhase === 's_refund' || detSubPhase === 's_payout');
          const localManagerDestroyed = !terminal && !manager && [...shardMap.values()].some(s => s && (s.terminal || s.stage === STAGE.S_PAYOUT || s.stage === STAGE.S_REFUND));
          const detProg = mgrProgress(detParsed?.state ?? null, detTerminal, {managerDestroyed: detManagerDestroyed});
          const localProg = mgrProgress(localMgrState, terminal, {managerDestroyed: localManagerDestroyed});
          const detNotBehind = !localMgrLive
            ? ((!localMgrState && !localManagerDestroyed) || compareTuples(detProg, localProg) >= 0)
            : detMgrMatchesLocal;

          if (detNotBehind) {
            if (detTerminal != null && !localMgrLive) detCandidateTerminal = detTerminal;
            if (typeof det.summary?.ticketsSold === 'number') detTicketsSold = det.summary.ticketsSold;
            if (pd.openedCount != null) openedCount = Math.max(openedCount, Number(pd.openedCount));
            if (pd.cursor != null) cursor = Number(pd.cursor);
            if (typeof pd.creatorPk === 'string') creatorPk = pd.creatorPk;
            if (normWinnerPk(pd.winnerPk)) winnerPk = normWinnerPk(pd.winnerPk);
            if (det.summary?.ticketPrice != null) {
              try { price = BigInt(String(det.summary.ticketPrice)); } catch {}
            }
            if (pd.closeDaa) {
              try { closeDaa = BigInt(String(pd.closeDaa)); } catch {}
            }
            if (detCandidateTerminal) {
              // H-03: do not blindly trust KCI terminal before probing live shard UTXOs on node
              if (!localMgrLive) {
                manager = null;
                stage = null;
                nodeVerified = false;
              }
            } else if (detParsed) {
              const mgrSt = detParsed.state;
              if (!localMgrLive) manager = detParsed.manager;
              stage = Number(mgrSt.stage);
              price = BigInt(mgrSt.price);
              closeDaa = BigInt(mgrSt.closeDaa);
              openedCount = Number(mgrSt.openedCount);
              cursor = Number(mgrSt.cursor);
              mgrTotalTickets = Number(mgrSt.totalTickets ?? 0);
              decision = Number(mgrSt.decision ?? 0);
              creatorPk = mgrSt.creatorPk;
              winnerPk = normWinnerPk(mgrSt.winnerPk) ?? winnerPk;
              if (!genesisTxid && Number(det.revision ?? 0) <= 1 && openedCount === 0 && cursor === 0 && stage === STAGE.M_OPEN) {
                genesisTxid = detParsed.manager.outpoint.transactionId;
              }
              detMatchesFinal = true;
            } else if ((detManagerDestroyed || det.manager === null) && !localMgrLive) {
              manager = null;
              stage = STAGE.M_DISPATCH;
              cursor = Math.max(cursor, openedCount);
              if (detSubPhase === 's_refund' || detPhase === 'REFUNDING') decision = DECISION.REFUND;
              else if (detSubPhase === 's_payout' || detPhase === 'SETTLING') decision = DECISION.PAYOUT;
              detMatchesFinal = true;
            }
          }

          const rawShards = Array.isArray(pd.shards) ? pd.shards : [];
          const detShardsMap = det.shards && typeof det.shards === 'object' ? det.shards : null;
          const pendingReplaceChecks = [];
          for (const rs of rawShards) {
            const scid = String(rs.shardCid ?? '');
            if (!scid) continue;
            let idxSh = {
              shardCid: scid,
              stage: 0,
              terminal: !!rs.terminal,
              firstBuyerPk: rs.firstBuyerPk ?? null,
              tickets: Number(rs.tickets ?? 0),
              recordCount: 0,
              vaultAmount: rs.vaultAmount != null ? BigInt(String(rs.vaultAmount)) : undefined,
            };
            const detSh = detShardsMap?.[scid] ?? null;
            let frozenRedeem = null;
            let frozenRecords = null;
            if (typeof detSh?.frozenRedeemHex === 'string' && detSh.frozenRedeemHex.length > 0) {
              try {
                const frBytes = unhex(detSh.frozenRedeemHex);
                const frSt = verifyKusdtV2Redeem(frBytes, profile, 'shard').state;
                if (frSt.stage === STAGE.S_FROZEN && Array.isArray(frSt.records)) {
                  frozenRedeem = frBytes;
                  frozenRecords = frSt.records;
                }
              } catch {}
            }
            if (detSh?.redeemHex) {
              try {
                const sRedeem = unhex(detSh.redeemHex);
                const sst = verifyKusdtV2Redeem(sRedeem, profile, 'shard').state;
                const claimedMask = typeof sst.claimedMask === 'number' || typeof detSh.state?.claimedMask === 'number'
                  ? Math.max(Number(sst.claimedMask ?? 0), Number(detSh.state?.claimedMask ?? 0))
                  : undefined;
                idxSh = shardEntryFromState({
                  shardCid: scid,
                  state: claimedMask !== undefined ? {...sst, claimedMask} : sst,
                  redeem: sRedeem,
                  spk: detSh.spk ?? p2sh(hex(blake2b256(sRedeem))),
                  outpoint: detSh.outpoint ?? null,
                  value: detSh.value != null ? BigInt(detSh.value) : 200_000_000n,
                  daaScore: BigInt(detSh.utxoDaa ?? detSh.daaScore ?? 0n),
                  terminal: !!(detSh.terminal || rs.terminal),
                  frozenRedeem,
                  frozenRecords,
                });
              } catch {}
            }
            if (!idxSh.redeem && !idxSh.terminal) {
              try {
                const scov = (await indexer.covenant(scid)).covenant;
                const sRedeem = unhex(scov.redeemHex);
                const sst = verifyKusdtV2Redeem(sRedeem, profile, 'shard').state;
                idxSh = shardEntryFromState({
                  shardCid: scid,
                  state: sst,
                  redeem: sRedeem,
                  spk: scov.spk,
                  outpoint: scov.outpoint,
                  value: BigInt(scov.value),
                  daaScore: BigInt(scov.daaScore ?? 0n),
                  frozenRedeem,
                  frozenRecords,
                });
              } catch {}
            }
            const existing = shardMap.get(scid);
            if (!existing) {
              shardMap.set(scid, idxSh);
            } else {
              const sameOut = !!(existing.outpoint && idxSh.outpoint
                && existing.outpoint.transactionId === idxSh.outpoint.transactionId
                && existing.outpoint.index === idxSh.outpoint.index);
              if (sameOut) {
                if ((!existing.redeem && idxSh.redeem) || (!existing.records && idxSh.records) || (!existing.frozenRedeem && idxSh.frozenRedeem)) {
                  shardMap.set(scid, preserveHistoricalShard(idxSh, existing));
                }
              } else {
                const cmp = compareTuples(shardProgress(idxSh), shardProgress(existing));
                if (cmp > 0) {
                  if (!existing.terminal && existing.spk && existing.outpoint && rpc) {
                    pendingReplaceChecks.push({index: scid, scid, existing, idxSh, spk: existing.spk, outpoint: existing.outpoint, expectedCid: scid});
                  } else {
                    shardMap.set(scid, preserveHistoricalShard(idxSh, existing));
                  }
                } else if (cmp === 0 && ((!existing.redeem && idxSh.redeem) || (!existing.records && idxSh.records) || (!existing.frozenRedeem && idxSh.frozenRedeem))) {
                  shardMap.set(scid, preserveHistoricalShard(idxSh, existing));
                }
              }
            }
          }
          if (pendingReplaceChecks.length) {
            const exLiveMap = await batchProbeLiveOutpoints(rpc, pendingReplaceChecks, prefix, {chunkSize: 64});
            for (const item of pendingReplaceChecks) {
              const exLive = exLiveMap.get(item.scid) ?? {ok: false, hit: null};
              if (!(exLive.ok && exLive.hit)) {
                shardMap.set(item.scid, preserveHistoricalShard(item.idxSh, item.existing));
              }
            }
          }
        } catch {}
      }
      if (detProfileMismatch) {
        throw Object.assign(new Error('UNSUPPORTED_PROFILE'), {code: 'UNSUPPORTED_PROFILE', safeCode: 'UNSUPPORTED_PROFILE'});
      }

      // Verify manager live on node; if spent while indexer lags, chase via REST + crypto verification + live node check
      if (rpc && !terminal && manager?.spk && !nodeVerified) {
        const mgrProbe = await probeLiveOutpoint(rpc, manager.spk, manager.outpoint, targetCid, prefix, {allowSameSpk: true});
        if (mgrProbe.ok && mgrProbe.hit) {
          const d = mgrProbe.hit.daa ?? mgrProbe.hit.utxoDaa ?? 0n;
          manager = {
            ...manager,
            outpoint: mgrProbe.hit.outpoint,
            value: mgrProbe.hit.value,
            spk: mgrProbe.hit.spk ?? manager.spk,
            utxoDaa: d,
            daaScore: d,
            daa: d,
            covenantId: targetCid,
          };
          nodeVerified = true;
        } else if (mgrProbe.ok && !mgrProbe.hit && round?.intent?.action !== 'GENESIS' && manager.redeemScript) {
          const caught = await catchupKusdtManagerViaRest({
            rpc,
            manager,
            cid: targetCid,
            shards: [...shardMap.values()],
            profile,
            net,
            fetcher,
          });
          if (caught.advanced) {
            detMatchesFinal = false;
            manager = caught.manager;
            terminal = caught.terminal;
            nodeVerified = caught.nodeVerified;
            for (const sh of caught.shards) upsertShard(shardMap, sh);
            if (Array.isArray(caught.receipts)) caughtReceipts.push(...caught.receipts);
            if (terminal) {
              stage = null;
            } else if (caught.state) {
              stage = Number(caught.state.stage);
              price = BigInt(caught.state.price);
              closeDaa = BigInt(caught.state.closeDaa);
              openedCount = Number(caught.state.openedCount);
              cursor = Number(caught.state.cursor);
              mgrTotalTickets = Number(caught.state.totalTickets ?? 0);
              decision = Number(caught.state.decision ?? 0);
              creatorPk = caught.state.creatorPk;
              winnerPk = normWinnerPk(caught.state.winnerPk) ?? winnerPk;
            }
          }
        }
      }

      // Verify each non-terminal shard live on node; if spent, chase via REST + node check
      if (manager?.redeemScript) {
        try {
          const finalMgrSt = verifyKusdtV2Redeem(manager.redeemScript, profile, 'manager').state;
          if (finalMgrSt.entries?.length) canonicalShardOrder = finalMgrSt.entries.map(e => e.shardCid);
          else if (finalMgrSt.shardCids?.length) canonicalShardOrder = [...finalMgrSt.shardCids];
        } catch {}
      }
      const shards = canonicalShardOrder?.length
        ? canonicalShardOrder.map(scid => shardMap.get(scid)).filter(Boolean)
        : [...shardMap.values()];
      let nonTerminalShards = 0;
      let liveNonTerminalShards = 0;
      if (rpc && !terminal) {
        const probeTargets = [];
        for (let i = 0; i < shards.length; i++) {
          const sh = shards[i];
          if (!sh || sh.terminal) continue;
          nonTerminalShards++;
          // Full 256-record S_OPEN shards and S_FROZEN shards cannot move standalone (only alongside Manager
          // in COLLECT_BATCH / DISPATCH_BATCH), so skip polling them while Manager is live.
          if (manager && !isMutableStandaloneShard(sh)) {
            if (nodeVerified) liveNonTerminalShards++;
            continue;
          }
          if (!sh.outpoint || !sh.spk) continue;
          probeTargets.push({index: i, spk: sh.spk, outpoint: sh.outpoint, expectedCid: sh.shardCid});
        }
        const probeMap = probeTargets.length
          ? await batchProbeLiveOutpoints(rpc, probeTargets, prefix, {chunkSize: 64})
          : new Map();
        for (const item of probeTargets) {
          const i = item.index;
          const sh = shards[i];
          const shProbe = probeMap.get(i) ?? {ok: false, hit: null};
          if (shProbe.ok && shProbe.hit) {
            shards[i] = {
              ...sh,
              value: shProbe.hit.value,
              spk: shProbe.hit.spk ?? sh.spk,
              daaScore: shProbe.hit.daa ?? shProbe.hit.utxoDaa ?? sh.daaScore ?? 0n,
            };
            liveNonTerminalShards++;
          } else if (shProbe.ok && !shProbe.hit && sh.stage === STAGE.S_OPEN && sh.redeem) {
            const caughtSh = await catchupKusdtShardViaRest({rpc, shard: sh, profile, net, fetcher});
            if (caughtSh.advanced) {
              shards[i] = caughtSh.shard;
              if (caughtSh.live) liveNonTerminalShards++;
              if (Array.isArray(caughtSh.receipts)) caughtReceipts.push(...caughtSh.receipts);
            }
          } else if (shProbe.ok && !shProbe.hit && (sh.stage === STAGE.S_PAYOUT || sh.stage === STAGE.S_REFUND) && sh.redeem) {
            const caughtSettle = await catchupKusdtSettlementShardViaRest({rpc, shard: sh, profile, net, fetcher});
            if (caughtSettle.advanced) {
              shards[i] = caughtSettle.shard;
              if (caughtSettle.shard.terminal) nonTerminalShards--;
              else if (caughtSettle.live) liveNonTerminalShards++;
              if (Array.isArray(caughtSettle.receipts)) caughtReceipts.push(...caughtSettle.receipts);
            }
          }
        }
      }

      // H-03: verify KCI-claimed terminal against live manager/shard UTXOs on node before accepting it
      if (!terminal && detCandidateTerminal && !localMgrLive) {
        let anyLiveOnNode = false;
        let mgrConfirmedGone = !!round?.manager && !localMgrLive;
        let probedTerminalShards = 0;
        if (rpc) {
          // Probe canonical empty M_OPEN on node if genesis params are known (prevents KCI lying terminal while M_OPEN is still live)
          if (!mgrConfirmedGone && price > 0n && closeDaa > 0n && creatorPk && HASH64.test(creatorPk)) {
            try {
              const emptyMgrRedeem = redeemForState({
                stage: STAGE.M_OPEN, version: KUSDT_V2_VERSION, creatorPk, price, closeDaa,
                openedCount: 0, cursor: 0, totalTickets: 0, decision: DECISION.UNDECIDED, reserved: 0, entries: [],
              }, profile);
              const emptyMgrSpk = p2sh(hex(blake2b256(emptyMgrRedeem)));
              const mProbe = await probeLiveOutpoint(rpc, emptyMgrSpk, null, targetCid, prefix);
              if (mProbe.ok) {
                if (mProbe.hit) {
                  anyLiveOnNode = true;
                  const d = mProbe.hit.daa ?? mProbe.hit.utxoDaa ?? 0n;
                  manager = {outpoint: mProbe.hit.outpoint, value: mProbe.hit.value, spk: mProbe.hit.spk ?? emptyMgrSpk, utxoDaa: d, daaScore: d, daa: d, covenantId: targetCid, redeemScript: emptyMgrRedeem};
                  stage = STAGE.M_OPEN;
                  nodeVerified = true;
                } else {
                  mgrConfirmedGone = true;
                }
              }
            } catch {}
          }
          if (!anyLiveOnNode && shards.length > 0) {
            const termProbes = [];
            for (let i = 0; i < shards.length; i++) {
              const sh = shards[i];
              if (sh?.spk) termProbes.push({index: i, spk: sh.spk, outpoint: sh.outpoint ?? null, expectedCid: sh.shardCid});
            }
            if (termProbes.length) {
              const termProbeMap = await batchProbeLiveOutpoints(rpc, termProbes, prefix, {chunkSize: 64});
              for (const p of termProbes) {
                const res = termProbeMap.get(p.index);
                if (res?.ok) {
                  probedTerminalShards++;
                  if (res.hit) {
                    anyLiveOnNode = true;
                    const sh = shards[p.index];
                    shards[p.index] = {
                      ...sh,
                      terminal: false,
                      outpoint: res.hit.outpoint,
                      value: res.hit.value,
                      daaScore: res.hit.daa ?? res.hit.utxoDaa ?? sh.daaScore ?? 0n,
                    };
                    nonTerminalShards++;
                    liveNonTerminalShards++;
                  }
                }
              }
            }
          }
        }
        if (!anyLiveOnNode) {
          const hasNodeProof = detCandidateTerminal === 'EMPTY'
            ? mgrConfirmedGone
            : (probedTerminalShards > 0 && mgrConfirmedGone);
          if (hasNodeProof || detCandidateTerminal === 'EMPTY' || !rpc) {
            terminal = detCandidateTerminal;
            manager = null;
            stage = null;
            nodeVerified = hasNodeProof;
          }
        }
      }

      // Post-DISPATCH_BATCH: manager was intentionally destroyed; verify liveness/terminality from shards
      if (!terminal && !manager && shards.length > 0) {
        if (shards.every(s => s && s.terminal)) {
          terminal = (decision === DECISION.REFUND || shards.some(s => s.stage === STAGE.S_REFUND)) ? 'REFUNDED' : 'PAID';
          stage = null;
          nodeVerified = true;
        } else {
          if (shards.some(s => !s.terminal && s.stage === STAGE.S_REFUND)) {
            stage = STAGE.M_DISPATCH;
            decision = DECISION.REFUND;
          } else if (shards.some(s => !s.terminal && s.stage === STAGE.S_PAYOUT)) {
            stage = STAGE.M_DISPATCH;
            decision = DECISION.PAYOUT;
            const winSh = shards.find(s => !s.terminal && normWinnerPk(s.winnerPk));
            if (winSh) winnerPk = normWinnerPk(winSh.winnerPk);
          }
          if (nonTerminalShards > 0 && liveNonTerminalShards === nonTerminalShards) {
            nodeVerified = true;
          }
        }
      }

      // C-01 off-chain defense: verify canonical empty M_OPEN genesis root whenever origin & settings are known
      let genesisRootVerified = !!round?.kusdt?.genesisRootVerified;
      let genesisRootInvalid = !!round?.kusdt?.genesisRootInvalid;
      if (origin?.transactionId && price > 0n && closeDaa > 0n && creatorPk && HASH64.test(creatorPk)) {
        try {
          verifyKusdtV2GenesisRoot({cid: targetCid, origin, price, closeDaa, creatorPk, profile});
          genesisRootVerified = true;
          genesisRootInvalid = false;
        } catch (e) {
          if (e?.message === 'KUSDT_V2_GENESIS_ROOT_MISMATCH' || e?.code === 'KUSDT_V2_GENESIS_ROOT_MISMATCH') {
            genesisRootInvalid = true;
            genesisRootVerified = false;
            nodeVerified = false;
          }
        }
      }

      const shardTicketSum = shards.reduce((sum, sh) => sum + Number(sh?.tickets ?? 0), 0);
      if (stage === STAGE.M_OPEN) {
        openedCount = Math.max(openedCount, shards.length);
        totalTickets = Math.max(mgrTotalTickets, shardTicketSum, detMatchesFinal ? detTicketsSold : 0);
      } else {
        totalTickets = Math.max(mgrTotalTickets, shardTicketSum, detMatchesFinal ? detTicketsSold : 0, Number(totalTickets ?? 0));
      }

      const prevReceipts = Array.isArray(round?.receipts)
        ? round.receipts.map(r => (r.action === 'GENESIS' && (nodeVerified || terminal) ? {...r, finalized: true} : r))
        : [];
      const mergedReceipts = mergeKusdtReceipts(kciReceipts, [...prevReceipts, ...caughtReceipts]);
      if (genesisTxid && !mergedReceipts.some(r => r.action === 'GENESIS')) {
        mergedReceipts.unshift({action: 'GENESIS', txid: genesisTxid, feeSompi: '0', finalized: nodeVerified || !!terminal});
      }
      let fees = 0n;
      for (const rc of mergedReceipts) {
        try { fees += BigInt(rc.feeSompi ?? 0); } catch {}
      }
      const mgrTxid = manager?.outpoint?.transactionId?.toLowerCase() ?? null;
      let accepting = null;
      if (mgrTxid) {
        const rcMatch = mergedReceipts.find(rc => rc.txid === mgrTxid && typeof rc.acceptingBlock === 'string' && HASH64.test(rc.acceptingBlock));
        if (rcMatch) accepting = rcMatch.acceptingBlock;
        else if (detHeadTxid === mgrTxid && detHeadAccepting) accepting = detHeadAccepting;
        else if (round?.manager?.outpoint?.transactionId?.toLowerCase() === mgrTxid && typeof round?.accepting === 'string' && HASH64.test(round.accepting)) {
          accepting = round.accepting;
        } else if (stage === STAGE.M_SEALED) {
          accepting = await fetchAcceptingBlockViaRest(mgrTxid, net, fetcher);
        }
      } else if (detHeadAccepting) {
        accepting = detHeadAccepting;
      } else if (typeof round?.accepting === 'string' && HASH64.test(round.accepting)) {
        accepting = round.accepting;
      }
      // H-03: never write unverified KCI det.draw into round.draw (which would short-circuit app.ts verifyKusdtDrawReceipt)
      const nextDraw = round?.draw ?? null;
      const nextStep = round?.intent?.action === 'GENESIS' && !nodeVerified && !terminal
        ? 0
        : Math.max(1, Number(round?.step ?? 0), mergedReceipts.length);
      const nextRound = {
        cid: targetCid,
        profileId,
        source: round?.source ?? 'indexed',
        terminal,
        halted: round?.halted ?? null,
        intent: round?.intent ?? null,
        manager,
        frozen: [],
        receipts: mergedReceipts,
        pending: [],
        fees,
        origin,
        accepting,
        ...(nextDraw ? {draw: nextDraw} : {}),
        ...(detDrawHint ? {drawHint: detDrawHint} : {}),
        settings: {
          ticketPrice: price,
          ticketCap: 65536,
          minTickets: 3,
          closeEligibleDaa: closeDaa,
          closeDaa,
          creatorPk: creatorPk ?? '00'.repeat(32),
        },
        bought: totalTickets,
        step: nextStep,
        kusdt: {
          stage,
          price,
          closeDaa,
          openedCount,
          cursor,
          totalTickets,
          decision,
          creatorPk,
          winnerPk,
          nodeVerified,
          genesisRootVerified,
          genesisRootInvalid,
          shards,
        },
      };
      return {
        round: nextRound,
        changed: true,
        partial: false,
        source: nodeVerified ? 'node' : (indexer ? 'indexer' : 'node'),
      };
    },
    describeRound(r, currentDaa = null) {
      return describeKusdtV2Round(r, currentDaa);
    },
    matchesProfile(r) {
      if (!r || typeof r !== 'object') return false;
      if (r.profileId && r.profileId !== profile.id) return false;
      const k = r.kusdt ?? {};
      if (k.genesisRootInvalid) return false;
      if (r.manager?.redeemScript instanceof Uint8Array) {
        try { verifyKusdtV2Redeem(r.manager.redeemScript, profile, 'manager'); }
        catch { return false; }
      }
      const creatorPk = k.creatorPk ?? r.settings?.creatorPk ?? null;
      const price = BigInt(k.price ?? r.settings?.ticketPrice ?? 0n);
      const closeDaa = BigInt(k.closeDaa ?? r.settings?.closeDaa ?? r.settings?.closeEligibleDaa ?? 0n);
      if (r.origin?.transactionId && creatorPk && HASH64.test(creatorPk) && price > 0n && closeDaa > 0n) {
        try {
          verifyKusdtV2GenesisRoot({cid: r.cid, origin: r.origin, price, closeDaa, creatorPk, profile});
        } catch {
          return false;
        }
      }
      return true;
    },
    uiActions(r, currentDaa = null) {
      return kusdtV2UiActions(r, currentDaa);
    },
    shardCatalog(r, walletKey = null) {
      return kusdtV2ShardCatalog(r, walletKey);
    },
    watchTargets(r, prefix) {
      return kusdtV2WatchTargets(r, prefix);
    },
    async prepareForController({rpc, indexer = null, round = null, choice, wallet, feerate, reserved = new Set(), net = null, fetcher = globalThis.fetch}) {
      const prefix = net?.addressPrefix ?? 'kaspatest';
      const suffix = defaultSuffix;
      const uiAction = choice.action;
      if (uiAction === 'GENESIS') {
        const st = choice.settings;
        const kasUtxos = await selectKasFunding(rpc, wallet, reserved);
        const registrySpk = choice.registry === true
          ? net?.registry?.spk ?? null
          : (typeof choice.registry === 'string' ? addressToSpk(choice.registry, prefix) : null);
        const prepared = this.prepareOperation({
          action: 'CREATE_ROUND',
          creatorPk: wallet.key,
          price: st.ticketPrice,
          closeDaa: st.closeEligibleDaa,
          fundingUtxos: kasUtxos,
          changeSpk: wallet.spk,
          registrySpk,
          feerate,
          net,
        });
        const auth = new Set(prepared.authorizedInputIndices ?? []);
        return {
          ...prepared,
          feerate: String(feerate),
          op: choice,
          targetCount: 0,
          roundCid: prepared.cid,
          subAction: 'GENESIS',
          kusdtAction: 'GENESIS',
          review: {
            txid: prepared.txid,
            fee: prepared.fee,
            assetDeltas: prepared.assetDeltas,
            inputs: (prepared.inputUtxos ?? []).map((u, idx) => ({
              index: idx,
              value: BigInt(u.value ?? 0n),
              kind: auth.has(idx) ? '需签名（你的钱包）' : '合约 UTXO',
            })),
            outputs: (prepared.transaction?.outputs ?? []).map(o => {
              const covId = o.covenant?.covenantId ?? o.covenantId;
              const isMine = !covId && o.scriptPublicKey?.script === wallet.spk.script;
              const role = covId ? 'MANAGER' : (isMine ? 'CHANGE' : 'REGISTRATION');
              const note = role === 'MANAGER'
                ? '你垫付的轮次总管押金（结算后全额退回）'
                : role === 'CHANGE'
                  ? '退回你钱包的普通 KAS 找零'
                  : '索引登记输出（用于探索列表发现，不可退）';
              return {
                role,
                script: o.scriptPublicKey?.script ?? '',
                value: BigInt(o.value ?? 0n),
                covenant: !!covId,
                mine: isMine,
                rollover: false,
                note,
              };
            }),
          },
        };
      }

      check(round, 'ROUND_NOT_FOUND');
      check(!round.terminal, 'ROUND_TERMINAL');
      const k = round.kusdt ?? {};
      const price = BigInt(k.price ?? round.settings?.ticketPrice ?? 1_000_000n);
      const shards = Array.isArray(k.shards) ? k.shards : [];
      const targetCid = uiAction === 'BUY' ? (choice.shardCid || null) : null;
      if (uiAction === 'BUY') {
        const buyableShards = shards.filter(isBuyableOpenShard);
        if (!targetCid) {
          if (buyableShards.length >= MAX_ACTIVE_OPEN_SHARDS) {
            throw Object.assign(
              new Error(`当前已有 ${buyableShards.length} 个未满活动分片（上限 ${MAX_ACTIVE_OPEN_SHARDS} 个），请从已有分片购票（免押金）；任一分片满 ${MAX_RECORDS_PER_SHARD} 笔后自动释放名额。`),
              {code: 'USER', safeCode: 'MAX_ACTIVE_SHARDS'},
            );
          }
          if (Number(k.openedCount ?? shards.length) >= MAX_SHARDS) {
            throw Object.assign(
              new Error(`本轮已达 ${MAX_SHARDS} 个分片上限，请从现有未满分片购票。`),
              {code: 'USER', safeCode: 'MAX_SHARDS_REACHED'},
            );
          }
        } else {
          const chosenSh = shards.find(s => s.shardCid === targetCid);
          if (chosenSh && !chosenSh.terminal && chosenSh.stage === STAGE.S_OPEN && Number(chosenSh.recordCount ?? 0) >= MAX_RECORDS_PER_SHARD) {
            throw Object.assign(
              new Error(`该分片已满 ${MAX_RECORDS_PER_SHARD} 笔购买，请切换其他未满分片。`),
              {code: 'USER', safeCode: 'SHARD_FULL'},
            );
          }
        }
      }
      let kusdtAction = uiAction;
      let prepared;
      let refundBuyerPk = null;
      let payoutWinnerPk = null;
      const reviewMeta = {
        tokenPaid: 0n,
        tokenChange: 0n,
        vaultTokenAmount: 0n,
        refundTokenAmount: 0n,
        remVaultTokenAmount: 0n,
        winnerTokenAmount: 0n,
        execTokenAmount: 0n,
      };
      const resolveOrigin = async () => {
        if (round.origin?.transactionId) return round.origin;
        if (indexer) {
          try {
            const det = await indexer.roundDetail(round.cid);
            if (det?.origin?.transactionId) return det.origin;
          } catch {}
        }
        const genTxid = (round.receipts ?? []).find(rc => rc.action === 'GENESIS' && HASH64.test(String(rc.txid ?? '')))?.txid;
        if (genTxid) {
          const restBase = restBaseOf(net);
          if (restBase) {
            try {
              const gtx = await fetchJson(`${restBase}/transactions/${genTxid}?inputs=true&outputs=false`, fetcher);
              const in0 = gtx?.inputs?.[0];
              if (in0 && HASH64.test(String(in0.previous_outpoint_hash ?? '').toLowerCase())) {
                return {transactionId: String(in0.previous_outpoint_hash).toLowerCase(), index: Number(in0.previous_outpoint_index ?? 0)};
              }
            } catch {}
          }
        }
        check(false, 'KUSDT_V2_GENESIS_ORIGIN');
      };
      const loadManagerAndKas = async () => {
        check(round.manager && round.manager.outpoint && round.manager.spk, 'STALE_INPUT');
        const [liveMgrUtxos, kasUtxos] = await Promise.all([
          commonUtxos(rpc, spkToAddress(round.manager.spk, prefix)),
          selectKasFunding(rpc, wallet, reserved),
        ]);
        const liveMgr = liveMgrUtxos.find(u =>
          u.covenantId === round.cid
          && u.outpoint?.transactionId === round.manager.outpoint.transactionId
          && u.outpoint?.index === round.manager.outpoint.index
        );
        check(liveMgr, 'STALE_INPUT');
        const mgrArg = {
          outpoint: liveMgr.outpoint,
          value: liveMgr.value,
          spk: liveMgr.spk ?? round.manager.spk,
          daaScore: liveMgr.daa ?? liveMgr.utxoDaa ?? round.manager.utxoDaa ?? 0n,
          daa: liveMgr.daa ?? liveMgr.utxoDaa ?? round.manager.utxoDaa ?? 0n,
          covenantId: round.cid,
          redeem: round.manager.redeemScript,
        };
        return {mgrArg, kasUtxos};
      };
      if (uiAction === 'BUY') {
        // C-01 fail-closed off-chain defense: ALWAYS verify canonical empty M_OPEN genesis root before BUY/OPEN_SHARD
        if (k.genesisRootInvalid) {
          throw Object.assign(new Error('该轮次未通过规范创世校验，已禁止参与。'), {code: 'USER', safeCode: 'KUSDT_V2_GENESIS_ROOT_MISMATCH'});
        }
        check(suffix, 'KUSDT_V2_KCC20_SUFFIX_REQUIRED');
        const qty = Number(choice.quantity);
        check(Number.isInteger(qty) && qty >= 1, 'QUANTITY');
        const cost = BigInt(qty) * price;
        const maxKcc20Inputs = targetCid ? 2 : 3;

        // Pre-validate local contract records and compute expected vault address before parallel RPC fan-out.
        let sh = null, sst = null, oldTickets = 0, expectedVault = null;
        const probeAddrs = [];
        if (targetCid) {
          check(round.manager?.spk && round.manager?.redeemScript, 'STALE_INPUT');
          sh = shards.find(s => s.shardCid === targetCid);
          check(sh && sh.outpoint && sh.redeem && sh.spk, 'STALE_INPUT');
          sst = verifyKusdtV2Redeem(sh.redeem, profile, 'shard').state;
          oldTickets = sst.records?.[sst.records.length - 1]?.cumTickets ?? Number(sh.tickets ?? 0);
          probeAddrs.push(spkToAddress(round.manager.spk, prefix), spkToAddress(sh.spk, prefix));
          if (!sh.vaultUtxo) {
            const vAmt = BigInt(oldTickets) * sst.price;
            expectedVault = {...kcc20RedeemAndSpk({amount: vAmt, owner: sh.shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, suffix), amount: vAmt};
            probeAddrs.push(spkToAddress(expectedVault.scriptPubKey, prefix));
          }
        } else {
          check(round.manager && round.manager.outpoint && round.manager.spk, 'STALE_INPUT');
          probeAddrs.push(spkToAddress(round.manager.spk, prefix));
        }

        // Parallel I/O fan-out: KAS funding + genesis origin + KCC-20 discovery/verification + batched contract UTXO probe.
        const [kasRes, originRes, discovered, contractUtxos] = await Promise.all([
          selectKasFunding(rpc, wallet, reserved).then(v => ({ok: true, v}), e => ({ok: false, e})),
          resolveOrigin().then(v => ({ok: true, v}), e => ({ok: false, e})),
          discoverOwnerKcc20Utxos({rpc, ownerPk: wallet.key, kusdtCid: effectiveCid, kcc20Suffix: suffix, net, fetcher}),
          commonUtxosByAddresses(rpc, probeAddrs, {chunkSize: 64}),
        ]);

        let buyOrigin;
        try {
          if (!originRes.ok) throw originRes.e;
          buyOrigin = originRes.v;
          verifyKusdtV2GenesisRoot({
            cid: round.cid,
            origin: buyOrigin,
            price,
            closeDaa: BigInt(k.closeDaa ?? round.settings?.closeDaa ?? 0n),
            creatorPk: k.creatorPk ?? round.settings?.creatorPk,
            profile,
          });
        } catch {
          throw Object.assign(new Error('该轮次未通过规范创世校验，已禁止参与。'), {code: 'USER', safeCode: 'KUSDT_V2_GENESIS_ROOT_MISMATCH'});
        }

        const liveMgr = contractUtxos.find(u =>
          u.covenantId === round.cid
          && u.outpoint?.transactionId === round.manager.outpoint.transactionId
          && u.outpoint?.index === round.manager.outpoint.index
        );

        // C-01 shard directory defense: when buying into an existing shard, verify targetCid belongs to live M_OPEN.entries on node!
        if (targetCid) {
          let mgrStForDir = null;
          if (liveMgr) {
            mgrStForDir = verifyKusdtV2Redeem(round.manager.redeemScript, profile, 'manager').state;
          } else {
            const caught = await catchupKusdtManagerViaRest({rpc, cid: round.cid, manager: round.manager, profile, net, fetcher, shardMap: new Map()});
            if (caught.advanced && caught.state) mgrStForDir = caught.state;
          }
          check(mgrStForDir && mgrStForDir.stage === STAGE.M_OPEN, 'STALE_INPUT');
          if (!(mgrStForDir.entries ?? []).some(e => e.shardCid === targetCid)) {
            throw Object.assign(new Error('该分片不属于本轮官方目录，已禁止购买。'), {code: 'USER', safeCode: 'KUSDT_V2_SHARD_NOT_IN_DIRECTORY'});
          }
        } else {
          check(liveMgr, 'STALE_INPUT');
        }

        if (!kasRes.ok) throw kasRes.e;
        const kasUtxos = kasRes.v;

        let kcc20Utxos = (discovered.cells ?? []).filter(u => !u?.outpoint || !reserved.has(`${u.outpoint.transactionId}:${u.outpoint.index}`));
        if (!kcc20Utxos.length && net?.key !== 'mainnet') {
          kcc20Utxos = (await getAssetUtxos(rpc, wallet.address, kusdtAsset(effectiveCid)))
            .filter(u => !u?.outpoint || !reserved.has(`${u.outpoint.transactionId}:${u.outpoint.index}`));
        }
        if (!kcc20Utxos.length) {
          if (net?.key === 'tn10') {
            throw Object.assign(new Error('TN10 测试网不包含主网 kUSDT 代币，当前钱包无可用 kUSDT UTXO。'), {code: 'USER'});
          }
          if (discovered.discoveryError) {
            throw Object.assign(new Error('查询 KCC-20（kUSDT）UTXO 索引失败，请稍后重试。'), {code: 'USER'});
          }
          throw Object.assign(new Error('当前钱包未检测到可用的 kUSDT（KCC-20）UTXO，请先转入 kUSDT 或等待刚收到的交易确认后再试。'), {code: 'USER'});
        }
        const picked = selectKcc20Cells(kcc20Utxos, cost, maxKcc20Inputs);
        if (!picked.selected.length) {
          if (picked.totalBalance < cost) {
            throw Object.assign(new Error(`当前钱包可用 kUSDT 余额不足：余额 ${formatKusdt6(picked.totalBalance)} kUSDT，本次需要 ${formatKusdt6(cost)} kUSDT。`), {code: 'USER'});
          }
          throw Object.assign(new Error(`当前钱包 kUSDT 分散在过多小额 UTXO 中（单笔最多合并 ${maxKcc20Inputs} 个 kUSDT 输入，最多凑出 ${formatKusdt6(picked.maxReachable)} kUSDT），请先在钱包内合并一笔后再试。`), {code: 'USER'});
        }
        const pickedSum = picked.selected.reduce((s, c) => s + BigInt(c.amount), 0n);
        reviewMeta.tokenPaid = cost;
        reviewMeta.tokenChange = pickedSum - cost;
        try {
          if (!targetCid) {
            const mgrArg = {
              outpoint: liveMgr.outpoint,
              value: liveMgr.value,
              spk: liveMgr.spk ?? round.manager.spk,
              daaScore: liveMgr.daa ?? liveMgr.utxoDaa ?? round.manager.utxoDaa ?? 0n,
              daa: liveMgr.daa ?? liveMgr.utxoDaa ?? round.manager.utxoDaa ?? 0n,
              covenantId: round.cid,
              redeem: round.manager.redeemScript,
            };
            kusdtAction = 'OPEN_SHARD';
            reviewMeta.vaultTokenAmount = cost;
            prepared = this.prepareOperation({
              action: 'OPEN_SHARD',
              managerUtxo: mgrArg,
              managerCid: round.cid,
              origin: buyOrigin,
              buyerPk: wallet.key,
              qty,
              price,
              buyerKasUtxos: kasUtxos,
              buyerKcc20Utxos: picked.selected,
              kcc20Suffix: suffix,
              changeSpk: wallet.spk,
              feerate,
              net,
            });
          } else {
            const shLive = contractUtxos.find(u => u.outpoint?.transactionId === sh.outpoint.transactionId && u.outpoint?.index === sh.outpoint.index);
            check(shLive, 'STALE_INPUT');
            let vaultUtxo = sh.vaultUtxo;
            if (!vaultUtxo && expectedVault) {
              const vHit = contractUtxos.find(u => !u.isCoinbase && u.covenantId === effectiveCid && u.spk?.script === expectedVault.scriptPubKey.script && u.value === SHARD_VAULT_DEPOSIT && u.outpoint);
              check(vHit, 'STALE_INPUT');
              const vd = vHit.daa ?? vHit.utxoDaa ?? 0n;
              vaultUtxo = {outpoint: vHit.outpoint, value: vHit.value, spk: vHit.spk ?? expectedVault.scriptPubKey, daa: vd, utxoDaa: vd, covenantId: effectiveCid, amount: expectedVault.amount, redeem: expectedVault.redeem};
            }
            reviewMeta.vaultTokenAmount = BigInt(oldTickets + qty) * sst.price;
            prepared = this.prepareOperation({
              action: 'BUY',
              shardUtxo: {outpoint: shLive.outpoint, value: shLive.value, spk: sh.spk, daa: shLive.daa ?? sh.daaScore, covenantId: sh.shardCid, redeem: sh.redeem},
              shardCid: sh.shardCid,
              vaultUtxo,
              buyerPk: wallet.key,
              qty,
              price: sst.price,
              buyerKasUtxos: kasUtxos,
              buyerKcc20Utxos: picked.selected,
              kcc20Suffix: suffix,
              changeSpk: wallet.spk,
              feerate,
              net,
            });
          }
        } catch (e) {
          if (e?.message === 'KUSDT_V2_INSUFFICIENT_KAS' || e?.code === 'KUSDT_V2_INSUFFICIENT_KAS') {
            throw Object.assign(new Error(targetCid
              ? '当前钱包可用 KAS 余额不足以支付网络费与找零承载押金。'
              : '当前钱包可用 KAS 余额不足：开新分片需锁定 4 KAS 可退押金（结算后全额退还）及网络费。'), {code: 'USER'});
          }
          throw e;
        }
      } else if (uiAction === 'CLOSE') {
        kusdtAction = Number(k.openedCount ?? 0) === 0 ? 'EMPTY_CLOSE' : 'COLLECT_BATCH';
        if (kusdtAction === 'EMPTY_CLOSE') {
          const [{mgrArg, kasUtxos}, roundOrigin] = await Promise.all([loadManagerAndKas(), resolveOrigin()]);
          prepared = this.prepareOperation({action: 'EMPTY_CLOSE', managerUtxo: mgrArg, managerCid: round.cid, origin: roundOrigin, fundingUtxos: kasUtxos, changeSpk: wallet.spk, feerate, net});
        } else {
          // H-06: strictly contiguous prefix from cursor (never skip missing shard[cursor]), and verify live on node
          const curIdx = Number(k.cursor ?? 0);
          const rawSlice = shards.slice(curIdx, curIdx + MAX_BATCH);
          const contiguous = [];
          for (const s of rawSlice) {
            if (!s?.outpoint || !s?.redeem || !s?.spk) break;
            contiguous.push(s);
          }
          check(contiguous.length > 0, 'STALE_INPUT');
          const [{mgrArg, kasUtxos}, roundOrigin, probeRes] = await Promise.all([
            loadManagerAndKas(),
            resolveOrigin(),
            batchProbeLiveOutpoints(rpc, contiguous.map((s, i) => ({index: i, spk: s.spk, outpoint: s.outpoint, expectedCid: s.shardCid})), prefix),
          ]);
          const batch = [];
          for (let i = 0; i < contiguous.length; i++) {
            const hit = probeRes.get(i)?.hit;
            if (!hit) break;
            const s = contiguous[i];
            batch.push({outpoint: hit.outpoint, value: hit.value, spk: s.spk, daa: hit.daa ?? hit.utxoDaa ?? s.daaScore, covenantId: s.shardCid, redeem: s.redeem});
          }
          check(batch.length > 0, 'STALE_INPUT');
          prepared = prepareBatchWithStepDown(batch, slice =>
            this.prepareOperation({action: 'COLLECT_BATCH', managerUtxo: mgrArg, managerCid: round.cid, origin: roundOrigin, shardUtxos: slice, fundingUtxos: kasUtxos, changeSpk: wallet.spk, feerate, net}));
        }
      } else if (uiAction === 'TIMEOUT') {
        const {mgrArg, kasUtxos} = await loadManagerAndKas();
        kusdtAction = 'REROLL';
        prepared = this.prepareOperation({action: 'REROLL', managerUtxo: mgrArg, managerCid: round.cid, fundingUtxos: kasUtxos, changeSpk: wallet.spk, feerate, net});
      } else if (uiAction === 'PAY_OLD' || uiAction === 'REFUND_OLD') {
        kusdtAction = 'DISPATCH_BATCH';
        const curIdx = Number(k.cursor ?? 0);
        const rawSlice = shards.slice(curIdx, curIdx + MAX_BATCH);
        const contiguous = [];
        for (const s of rawSlice) {
          if (!s?.outpoint || !s?.redeem || !s?.spk) break;
          contiguous.push(s);
        }
        check(contiguous.length > 0, 'STALE_INPUT');
        const [{mgrArg, kasUtxos}, probeRes] = await Promise.all([
          loadManagerAndKas(),
          batchProbeLiveOutpoints(rpc, contiguous.map((s, i) => ({index: i, spk: s.spk, outpoint: s.outpoint, expectedCid: s.shardCid})), prefix),
        ]);
        const batch = [];
        for (let i = 0; i < contiguous.length; i++) {
          const hit = probeRes.get(i)?.hit;
          if (!hit) break;
          const s = contiguous[i];
          batch.push({outpoint: hit.outpoint, value: hit.value, spk: s.spk, daa: hit.daa ?? hit.utxoDaa ?? s.daaScore, covenantId: s.shardCid, redeem: s.redeem});
        }
        check(batch.length > 0, 'STALE_INPUT');
        prepared = prepareBatchWithStepDown(batch, slice =>
          this.prepareOperation({action: 'DISPATCH_BATCH', managerUtxo: mgrArg, managerCid: round.cid, frozenShardUtxos: slice, fundingUtxos: kasUtxos, changeSpk: wallet.spk, feerate, net}));
      } else if (uiAction === 'DRAW') {
        const [{mgrArg, kasUtxos}, currentDaa] = await Promise.all([loadManagerAndKas(), rpc.currentDaa()]);
        const mgrTxid = mgrArg.outpoint.transactionId.toLowerCase();
        let accepting = (round.receipts ?? []).find(rc => rc.txid === mgrTxid && HASH64.test(String(rc.acceptingBlock ?? '')))?.acceptingBlock
          ?? (round.manager?.outpoint?.transactionId?.toLowerCase() === mgrTxid && HASH64.test(String(round.accepting ?? '')) ? round.accepting : null);
        let det = null;
        if (!accepting && indexer) {
          try {
            det = await indexer.roundDetail(round.cid);
            accepting = (det.receipts ?? []).find(rc => String(rc?.txid ?? '').toLowerCase() === mgrTxid && HASH64.test(String(rc?.acceptingBlock ?? '')))?.acceptingBlock
              ?? (String(det.head?.txid ?? '').toLowerCase() === mgrTxid && HASH64.test(String(det.head?.acceptingBlock ?? '')) ? det.head.acceptingBlock : null);
          } catch {}
        }
        if (!accepting) accepting = await fetchAcceptingBlockViaRest(mgrTxid, net, fetcher);
        check(accepting && HASH64.test(accepting), 'ACCEPTING_BLOCK_REQUIRED');

        const proofObj = await acquirePassAProof(
          rpc,
          {outpoint: mgrArg.outpoint, value: mgrArg.value, cid: round.cid, spk: mgrArg.spk, utxoDaa: BigInt(mgrArg.daa), currentDaa},
          accepting,
        );
        const mgrState = verifyKusdtV2Redeem(mgrArg.redeem, profile, 'manager').state;
        const sample = kusdtDrawSample({
          cid: round.cid,
          outpoint: mgrArg.outpoint,
          utxoDaa: mgrArg.daa,
          currentDaa,
          totalTickets: mgrState.totalTickets,
          proof: proofObj.opening,
          accessor: proofObj.accessor,
        });
        const winShardIdx = mgrState.entries.findIndex(e => sample.ticket < e.cumTickets);
        check(winShardIdx >= 0, 'DRAW_SHARD_INDEX');
        const winShardCid = mgrState.entries[winShardIdx].shardCid;
        let shardsForDraw = shards;
        const existingWin = shards.find(s => s?.shardCid === winShardCid && (s.frozenRedeem || s.redeem));
        if (!existingWin && indexer) {
          let fetchedRedeem = null;
          try {
            if (!det) det = await indexer.roundDetail(round.cid);
            const detSh = det?.shards?.[winShardCid];
            if (detSh?.frozenRedeemHex) fetchedRedeem = unhex(detSh.frozenRedeemHex);
            else if (detSh?.redeemHex) fetchedRedeem = unhex(detSh.redeemHex);
          } catch {}
          if (!fetchedRedeem) {
            try {
              const cov = (await indexer.covenant(winShardCid)).covenant;
              if (cov?.redeemHex) fetchedRedeem = unhex(cov.redeemHex);
            } catch {}
          }
          if (fetchedRedeem) {
            shardsForDraw = [...shards.filter(s => s?.shardCid !== winShardCid), {shardCid: winShardCid, redeem: fetchedRedeem, frozenRedeem: fetchedRedeem}];
          }
        }
        const win = resolveKusdtDrawWinner(mgrState, shardsForDraw, sample.ticket, profile);
        prepared = this.prepareOperation({
          action: 'DRAW',
          managerUtxo: mgrArg,
          managerCid: round.cid,
          passAProof: proofObj.opening,
          shardIndex: win.shardIndex,
          recordIndex: win.recordIndex,
          frozenShardState: win.frozenShardState,
          fundingUtxos: kasUtxos,
          changeSpk: wallet.spk,
          feerate,
          net,
        });
        prepared.drawConfirmation = proofObj.confirmation;
        prepared.passAProof = proofObj.opening;
        prepared.drawResult = {
          txid: prepared.txid,
          shard: win.shardIndex,
          record: win.recordIndex,
          ticket: sample.ticket,
          proof: {
            scheme: 'kusdt-v2',
            seedDomain: 'KASWIN_KUSDT_DRAW_V1',
            sampleDomain: 'KASWIN_KUSDT_SAMPLE_V1',
            cid: round.cid,
            sealedTxid: mgrArg.outpoint.transactionId,
            sealedIndex: Number(mgrArg.outpoint.index),
            sealedDaa: sample.sealedDaa,
            boundaryDaa: sample.boundaryDaa,
            targetBlockHash: sample.targetHash,
            targetBlockDaa: sample.targetBlockDaa,
            parentBlockDaa: sample.parentBlockDaa,
            sequenceCommitment: sample.sequenceCommitment,
            seed: sample.seed,
            digest: sample.digest,
            sample: sample.sample,
            totalTickets: mgrState.totalTickets,
            winningTicket: sample.ticket + 1,
            rejectionSampled: false,
          },
        };
      } else if (uiAction === 'PAYOUT_EXECUTOR' || uiAction === 'PAYOUT_SELF' || uiAction === 'CLAIM_REFUND') {
        check(suffix, 'KUSDT_V2_KCC20_SUFFIX_REQUIRED');
        const sh = shards.find(s => s.shardCid === choice.shardCid);
        check(sh?.outpoint && sh?.redeem && sh?.spk, 'STALE_INPUT');
        const sst = verifyKusdtV2Redeem(sh.redeem, profile, 'shard').state;
        let vaultAmt = sst.vaultAmount ?? 0n;
        let recIdx = 0, refundAmount = 0n;
        if (uiAction === 'CLAIM_REFUND') {
          check(choice.recIdx != null, 'KUSDT_V2_REC_IDX');
          recIdx = Number(choice.recIdx);
          const prevCum = recIdx === 0 ? 0 : sst.records[recIdx - 1].cumTickets;
          refundAmount = BigInt(sst.records[recIdx].cumTickets - prevCum) * sst.price;
          refundBuyerPk = sst.records[recIdx].buyerPk;
          vaultAmt = 0n;
          for (let ri = 0; ri < sst.recordCount; ri++) {
            if ((sst.claimedMask & (1 << ri)) === 0) {
              const prev = ri === 0 ? 0 : sst.records[ri - 1].cumTickets;
              vaultAmt += BigInt(sst.records[ri].cumTickets - prev) * sst.price;
            }
          }
        } else {
          payoutWinnerPk = normWinnerPk(sst.winnerPk);
        }
        const expectedVault = sh.vaultUtxo
          ? null
          : kcc20RedeemAndSpk({amount: vaultAmt, owner: sh.shardCid, ownerScheme: KCC20_OWNER_SCHEME.OWNER_COVENANT_ID}, suffix);
        const settleAddrs = [spkToAddress(sh.spk, prefix)];
        if (expectedVault) settleAddrs.push(spkToAddress(expectedVault.scriptPubKey, prefix));
        const [kasUtxos, settleUtxos] = await Promise.all([
          selectKasFunding(rpc, wallet, reserved),
          commonUtxosByAddresses(rpc, settleAddrs, {chunkSize: 64}),
        ]);
        const shLive = settleUtxos.find(u => u.outpoint?.transactionId === sh.outpoint.transactionId && u.outpoint?.index === sh.outpoint.index);
        check(shLive, 'STALE_INPUT');
        const shardArg = {outpoint: shLive.outpoint, value: shLive.value, spk: sh.spk, daa: shLive.daa ?? sh.daaScore, covenantId: sh.shardCid, redeem: sh.redeem};
        let vaultUtxo = sh.vaultUtxo;
        if (!vaultUtxo && expectedVault) {
          const vHit = settleUtxos.find(u => !u.isCoinbase && u.covenantId === effectiveCid && u.spk?.script === expectedVault.scriptPubKey.script && u.value === SHARD_VAULT_DEPOSIT && u.outpoint);
          check(vHit, 'STALE_INPUT');
          const vd = vHit.daa ?? vHit.utxoDaa ?? 0n;
          vaultUtxo = {outpoint: vHit.outpoint, value: vHit.value, spk: vHit.spk ?? expectedVault.scriptPubKey, daa: vd, utxoDaa: vd, covenantId: effectiveCid, amount: vaultAmt, redeem: expectedVault.redeem};
        }
        if (uiAction === 'CLAIM_REFUND') {
          reviewMeta.refundTokenAmount = refundAmount;
          reviewMeta.remVaultTokenAmount = vaultAmt > refundAmount ? vaultAmt - refundAmount : 0n;
          prepared = this.prepareOperation({action: 'CLAIM_REFUND', shardUtxo: shardArg, shardCid: sh.shardCid, vaultUtxo, recIdx, refundAmount, fundingUtxos: kasUtxos, kcc20Suffix: suffix, changeSpk: wallet.spk, feerate, net});
        } else {
          reviewMeta.winnerTokenAmount = uiAction === 'PAYOUT_EXECUTOR' && vaultAmt > EXECUTOR_REWARD ? vaultAmt - EXECUTOR_REWARD : vaultAmt;
          reviewMeta.execTokenAmount = uiAction === 'PAYOUT_EXECUTOR' ? EXECUTOR_REWARD : 0n;
          prepared = this.prepareOperation({action: uiAction, shardUtxo: shardArg, shardCid: sh.shardCid, vaultUtxo, vaultAmount: vaultAmt, executorPk: uiAction === 'PAYOUT_EXECUTOR' ? wallet.key : null, fundingUtxos: kasUtxos, kcc20Suffix: suffix, changeSpk: wallet.spk, feerate, net});
        }
      } else {
        throw new Error(`KUSDT_V2_UNKNOWN_ACTION:${uiAction}`);
      }

      const auth = new Set(prepared.authorizedInputIndices ?? []);
      const scriptIdx = new Set((prepared.scriptInputs ?? []).map(si => si.inputIndex));
      return {
        ...prepared,
        feerate: String(feerate),
        op: choice,
        targetCount: prepared.batchSize ?? 0,
        roundCid: round.cid,
        subAction: kusdtAction,
        kusdtAction,
        review: {
          txid: prepared.txid,
          fee: prepared.fee,
          assetDeltas: prepared.assetDeltas,
          inputs: (prepared.inputUtxos ?? []).map((u, idx) => ({
            index: idx,
            value: BigInt(u.value ?? 0n),
            kind: auth.has(idx) ? '需签名（你的钱包）' : (scriptIdx.has(idx) ? '需签名（你的 kUSDT）' : '合约 UTXO'),
          })),
          outputs: (prepared.transaction?.outputs ?? []).map((o, idx) => {
            const covId = o.covenant?.covenantId ?? o.covenantId;
            const script = o.scriptPublicKey?.script ?? '';
            const isTokenChange = !!covId && covId === effectiveCid && !!prepared.kcc20ChangeSpk && script === prepared.kcc20ChangeSpk;
            const isKasChange = !covId && script === wallet.spk.script;
            const isClaimBuyerCell = kusdtAction === 'CLAIM_REFUND' && covId === effectiveCid
              && ((prepared.shardState == null && idx === 1) || (prepared.shardState != null && idx === 2));
            const isPayoutWinnerCell = (kusdtAction === 'PAYOUT_SELF' || kusdtAction === 'PAYOUT_EXECUTOR') && covId === effectiveCid && idx === 1;
            const isPayoutExecCell = kusdtAction === 'PAYOUT_EXECUTOR' && covId === effectiveCid && idx === 2;
            const isDepositReturn = !covId && idx === 0 && ['DISPATCH_BATCH', 'EMPTY_CLOSE', 'CLAIM_REFUND', 'PAYOUT_SELF', 'PAYOUT_EXECUTOR'].includes(kusdtAction);
            const role = isTokenChange
              ? 'TOKEN_CHANGE'
              : isClaimBuyerCell
                ? 'BUYER_REFUND'
                : isPayoutWinnerCell
                  ? 'WINNER'
                  : isPayoutExecCell
                    ? 'EXECUTOR'
                    : isDepositReturn
                      ? (['DISPATCH_BATCH', 'EMPTY_CLOSE'].includes(kusdtAction) ? 'CREATOR' : 'SHARD_DEPOSIT')
                      : covId === effectiveCid
                        ? 'VAULT_DEPOSIT'
                        : covId === round.cid
                          ? 'MANAGER'
                          : covId
                            ? (kusdtAction === 'COLLECT_BATCH' ? 'FROZEN' : 'SHARD_DEPOSIT')
                            : (isKasChange ? 'CHANGE' : 'REGISTRATION');
            const mine = isTokenChange
              || isKasChange
              || (isClaimBuyerCell && refundBuyerPk === wallet.key)
              || (isPayoutWinnerCell && payoutWinnerPk === wallet.key)
              || isPayoutExecCell;
            let rollover = false;
            let note = '';
            let tokenAmount;
            if (role === 'MANAGER') {
              rollover = true;
              note = '原轮次总管 4 KAS 押金滚存（创建者押金，非你支出）';
            } else if (role === 'FROZEN') {
              rollover = true;
              note = '原分片 2 KAS 押金滚存并封存（非你支出）';
            } else if (role === 'CREATOR' && isDepositReturn) {
              rollover = true;
              note = mine ? '合约退回你的 4 KAS 创建者押金' : '合约退回创建者的 4 KAS 押金（非你支出）';
            } else if (role === 'SHARD_DEPOSIT' && isDepositReturn) {
              rollover = true;
              note = mine ? '合约退回你的 4 KAS 分片押金' : '合约退回首购者的 4 KAS 分片押金（非你支出）';
            } else if (role === 'SHARD_DEPOSIT') {
              if (kusdtAction === 'OPEN_SHARD') {
                rollover = false;
                note = '你垫付的新分片账本押金（分片结清时原路退回给你）';
              } else if (kusdtAction === 'BUY') {
                rollover = true;
                note = '原分片账本 2 KAS 押金滚存（首购者垫付，非你支出）';
              } else if (kusdtAction === 'DISPATCH_BATCH') {
                rollover = true;
                note = '原分片 2 KAS 押金滚存并转入可领款状态（非你支出）';
              } else {
                rollover = true;
                note = '原分片账本 2 KAS 押金滚存（非你支出）';
              }
            } else if (role === 'VAULT_DEPOSIT') {
              if (kusdtAction === 'OPEN_SHARD') {
                rollover = false;
                tokenAmount = reviewMeta.vaultTokenAmount;
                note = `你支付的 ${formatKusdt6(reviewMeta.tokenPaid)} kUSDT 票款存入新分片金库 + 你垫付 2 KAS 可退押金`;
              } else if (kusdtAction === 'BUY') {
                rollover = false;
                tokenAmount = reviewMeta.vaultTokenAmount;
                note = `你本次支付的 ${formatKusdt6(reviewMeta.tokenPaid)} kUSDT 票款存入此金库（金库现存 ${formatKusdt6(reviewMeta.vaultTokenAmount)} kUSDT）；2 KAS 为原押金滚存，非你支出`;
              } else if (kusdtAction === 'CLAIM_REFUND') {
                rollover = true;
                tokenAmount = reviewMeta.remVaultTokenAmount;
                note = `剩余未领票款 ${formatKusdt6(reviewMeta.remVaultTokenAmount)} kUSDT 留存金库（2 KAS 原押金滚存，非你支出）`;
              }
            } else if (role === 'TOKEN_CHANGE') {
              tokenAmount = reviewMeta.tokenChange;
              note = `退回你的 ${formatKusdt6(reviewMeta.tokenChange)} kUSDT 找零（含 1 KAS 代币载体，仍归你所有）`;
            } else if (role === 'WINNER') {
              tokenAmount = reviewMeta.winnerTokenAmount;
              note = mine
                ? `你的 ${formatKusdt6(reviewMeta.winnerTokenAmount)} kUSDT 中奖奖金（含 1.5 KAS 代币载体，仍归你所有）`
                : `发给中奖者的 ${formatKusdt6(reviewMeta.winnerTokenAmount)} kUSDT 奖金（含你垫付的 1.5 KAS 载体，不可退）`;
            } else if (role === 'EXECUTOR') {
              tokenAmount = reviewMeta.execTokenAmount;
              note = `你的 ${formatKusdt6(reviewMeta.execTokenAmount)} kUSDT 代推激励（含 1.5 KAS 代币载体，仍归你所有）`;
            } else if (role === 'BUYER_REFUND') {
              tokenAmount = reviewMeta.refundTokenAmount;
              note = mine
                ? `退回你的 ${formatKusdt6(reviewMeta.refundTokenAmount)} kUSDT 票款（含 1.5 KAS 代币载体，仍归你所有）`
                : `退回买家的 ${formatKusdt6(reviewMeta.refundTokenAmount)} kUSDT 票款（含 1.5 KAS 载体，不可退）`;
            } else if (role === 'CHANGE') {
              note = '退回你钱包的普通 KAS 找零';
            }
            return {
              role,
              script,
              value: BigInt(o.value ?? 0n),
              covenant: !!covId,
              mine,
              rollover,
              ...(note ? {note} : {}),
              ...(tokenAmount != null && tokenAmount > 0n ? {tokenAmount, tokenSymbol: 'kUSDT', tokenDecimals: 6} : {}),
            };
          }),
        },
      };
    },
    /** Send persisted kusdt-v2 intent bytes with beforeSend submissionAttempted barrier (C-02)
     * and fresh PASS-A 100 blue-score confirmation gate for DRAW (H-04). */
    async submitIntent(rpc, intent, {beforeSend = () => {}} = {}) {
      let sent = false;
      try {
        check(intent?.draft?.transaction, 'INTENT_DRAFT_MISSING');
        const tx = intent.draft.transaction;
        const now = typeof rpc.currentDaa === 'function' ? await rpc.currentDaa() : null;
        if (now != null && tx.lockTime != null && BigInt(tx.lockTime) > 0n) {
          check(BigInt(tx.lockTime) < BigInt(now), 'SUBMIT_LOCK_MATURITY');
        }
        let confirmation = null;
        if (intent.action === 'DRAW') {
          const proofBytes = intent.proof instanceof Uint8Array
            ? intent.proof
            : (typeof intent.proof === 'string' && intent.proof.length > 0 ? unhex(intent.proof) : null);
          check(proofBytes instanceof Uint8Array, 'DRAW_PROOF_MISSING');
          confirmation = await confirmDrawTargetWithRetry(rpc, drawTargetFromOpening(proofBytes));
        }
        const wire = txToRpc(tx);
        const result = await rpc.call('submitTransaction', {transaction: wire, allowOrphan: false}, 30000, {
          beforeSend: () => {
            if (confirmation) assertFreshDrawConfirmation(confirmation, confirmation, Date.now(), rpc);
            beforeSend();
            sent = true;
          },
        });
        const resTxid = typeof result === 'string' ? result : (result?.transactionId ?? result?.txid ?? intent.txid);
        check(resTxid === intent.txid, 'SUBMIT_TXID');
        return {result};
      } catch (e) {
        if (e && typeof e === 'object') e.submissionAttempted = sent;
        throw e;
      }
    },
    async trackRoundIntent({rpc, indexer = null, round, recover = false, net = null, fetcher = globalThis.fetch}) {
      const intent = round?.intent;
      if (!intent) return {accepted: false, round};
      const prefix = net?.addressPrefix ?? 'kaspatest';
      const txid = intent.txid;

      // H-02: ALWAYS check whether the transaction was already accepted BEFORE probing inputs for recover!
      let confirmed = false;
      const hitsByIndex = new Map();
      const outputs = intent.draft?.transaction?.outputs ?? [];
      for (let i = 0; i < Math.min(3, outputs.length); i++) {
        const out = outputs[i];
        if (!out?.scriptPublicKey) continue;
        try {
          const utxos = await commonUtxos(rpc, spkToAddress(out.scriptPublicKey, prefix));
          const hit = utxos.find(u => u.outpoint?.transactionId === txid && u.outpoint?.index === i)
            ?? utxos.find(u => u.outpoint?.transactionId === txid);
          if (hit) {
            confirmed = true;
            hitsByIndex.set(i, hit);
          }
        } catch {}
      }
      if (!confirmed) {
        const synced = await this.syncRound({rpc, indexer, round, cid: round.cid, net, fetcher});
        if (synced.round.kusdt?.nodeVerified && synced.round.manager?.outpoint?.transactionId === txid) confirmed = true;
        else if (synced.round.terminal && (intent.action === 'CLOSE' || intent.action === 'EMPTY_CLOSE')) confirmed = true;
        else if (synced.round.kusdt?.shards?.some(s => s.outpoint?.transactionId === txid)) confirmed = true;
        else if (intent.action === 'OPEN_SHARD' && intent.shardCid && synced.round.kusdt?.shards?.some(s => s.shardCid === intent.shardCid)) confirmed = true;
        else if (synced.round.receipts?.some(r => r.txid === txid && r.finalized === true)) confirmed = true;
        if (confirmed) {
          round = synced.round;
        } else {
          if (recover && intent.draft?.transaction) {
            const inputs = intent.draft.inputUtxos ?? [];
            const spent = [];
            for (const inp of inputs) {
              if (!inp?.spk || !inp?.outpoint) continue;
              const live = await commonUtxos(rpc, spkToAddress(inp.spk, prefix));
              if (!live.some(u => u.outpoint?.transactionId === inp.outpoint.transactionId && u.outpoint?.index === inp.outpoint.index)) {
                spent.push(`${inp.outpoint.transactionId}:${inp.outpoint.index}`);
              }
            }
            if (spent.length) {
              const next = {
                ...synced.round,
                intent: {...intent, status: 'REJECTED', nodeError: `UTXO ${spent[0]} already spent`},
              };
              return {accepted: false, round: next};
            }
            await this.submitIntent(rpc, intent, {network: net?.networkId});
            return {accepted: false, round: {...synced.round, intent: {...intent, status: 'SUBMITTED'}}};
          }
          return {accepted: false, round: synced.round};
        }
      }

      const localRecIndex = intent.action === 'OPEN_SHARD'
        ? 0
        : (intent.action === 'BUY'
          ? (Number.isInteger(intent.recordIndex) ? intent.recordIndex : (Array.isArray(intent.nextShardState?.records) ? intent.nextShardState.records.length - 1 : undefined))
          : undefined);
      const localRecIdx = intent.action === 'CLAIM_REFUND' && Number.isInteger(intent.recIdx) ? intent.recIdx : undefined;
      const localConfirmedReceipt = {
        action: intent.action,
        txid,
        feeSompi: String(intent.draft?.fee ?? 0),
        finalized: true,
        ...(intent.shardCid ? {shardCid: intent.shardCid} : {}),
        ...(localRecIndex !== undefined ? {recordIndex: localRecIndex} : {}),
        ...(localRecIdx !== undefined ? {recIdx: localRecIdx} : {}),
      };
      const nextReceipts = mergeKusdtReceipts(round.receipts ?? [], [localConfirmedReceipt]);
      const nextStep = Math.max(1, Number(round.step ?? 0) + (intent.action === 'GENESIS' ? 0 : 1));
      const hit0 = hitsByIndex.get(0) ?? null;
      const hit1 = hitsByIndex.get(1) ?? null;
      const prevK = round.kusdt ?? {};
      let nextManager = round.manager;
      let nextTerminal = round.terminal ?? null;
      let nextKusdt = {
        ...prevK,
        shards: Array.isArray(prevK.shards) ? [...prevK.shards] : [],
      };
      let confirmedMgrHit = null;

      const replaceOrAppendShard = sh => {
        const idx = nextKusdt.shards.findIndex(s => s.shardCid === sh.shardCid);
        if (idx >= 0) nextKusdt.shards[idx] = sh;
        else nextKusdt.shards.push(sh);
      };

      if (intent.action === 'GENESIS') {
        if (hit0 && round.manager) {
          confirmedMgrHit = hit0;
          const d0 = hit0.daa ?? hit0.utxoDaa ?? 0n;
          nextManager = {
            ...round.manager,
            outpoint: hit0.outpoint,
            value: hit0.value,
            spk: hit0.spk ?? round.manager.spk,
            utxoDaa: d0,
            daaScore: d0,
            daa: d0,
            covenantId: round.cid,
          };
          nextKusdt.nodeVerified = true;
        }
      } else if (intent.action === 'OPEN_SHARD') {
        if (intent.nextManagerState) {
          const nextMgrRedeem = redeemForState(intent.nextManagerState, profile);
          const nextMgrSpk = p2sh(hex(blake2b256(nextMgrRedeem)));
          const d0 = hit0?.daa ?? hit0?.utxoDaa ?? 0n;
          nextManager = {
            outpoint: hit0?.outpoint ?? {transactionId: txid, index: 0},
            value: hit0?.value ?? BigInt(outputs[0]?.value ?? 400_000_000n),
            spk: hit0?.spk ?? nextMgrSpk,
            utxoDaa: d0,
            daaScore: d0,
            daa: d0,
            covenantId: round.cid,
            redeemScript: nextMgrRedeem,
          };
          if (hit0) confirmedMgrHit = hit0;
          nextKusdt.stage = Number(intent.nextManagerState.stage);
          nextKusdt.openedCount = Number(intent.nextManagerState.openedCount);
          nextKusdt.cursor = Number(intent.nextManagerState.cursor);
          nextKusdt.nodeVerified = !!hit0;
        }
        if (intent.nextShardState && intent.shardCid) {
          const nextShRedeem = redeemForState(intent.nextShardState, profile);
          const nextShSpk = p2sh(hex(blake2b256(nextShRedeem)));
          replaceOrAppendShard(shardEntryFromState({
            shardCid: intent.shardCid,
            state: intent.nextShardState,
            redeem: nextShRedeem,
            spk: hit1?.spk ?? nextShSpk,
            outpoint: hit1?.outpoint ?? {transactionId: txid, index: 1},
            value: hit1?.value ?? BigInt(outputs[1]?.value ?? 200_000_000n),
            daaScore: hit1?.daa ?? hit1?.utxoDaa ?? 0n,
          }));
        }
        nextKusdt.totalTickets = nextKusdt.shards.reduce((sum, s) => sum + Number(s?.tickets ?? 0), 0);
        nextKusdt.openedCount = Math.max(Number(nextKusdt.openedCount ?? 0), nextKusdt.shards.length);
      } else if (intent.action === 'BUY') {
        if (intent.nextShardState && intent.shardCid) {
          const nextShRedeem = redeemForState(intent.nextShardState, profile);
          const nextShSpk = p2sh(hex(blake2b256(nextShRedeem)));
          replaceOrAppendShard(shardEntryFromState({
            shardCid: intent.shardCid,
            state: intent.nextShardState,
            redeem: nextShRedeem,
            spk: hit0?.spk ?? nextShSpk,
            outpoint: hit0?.outpoint ?? {transactionId: txid, index: 0},
            value: hit0?.value ?? BigInt(outputs[0]?.value ?? 200_000_000n),
            daaScore: hit0?.daa ?? hit0?.utxoDaa ?? 0n,
          }));
          nextKusdt.totalTickets = nextKusdt.shards.reduce((sum, s) => sum + Number(s?.tickets ?? 0), 0);
        }
      } else if (intent.action === 'EMPTY_CLOSE') {
        nextTerminal = 'EMPTY';
        nextManager = null;
        nextKusdt.stage = null;
      } else if (intent.action === 'DISPATCH_BATCH' || intent.nextManagerState) {
        const hasMgrOut = (outputs[0]?.covenant?.covenantId ?? outputs[0]?.covenantId) === round.cid;
        if (hasMgrOut && intent.nextManagerState) {
          const nextMgrRedeem = redeemForState(intent.nextManagerState, profile);
          const nextMgrSpk = p2sh(hex(blake2b256(nextMgrRedeem)));
          const d0 = hit0?.daa ?? hit0?.utxoDaa ?? 0n;
          nextManager = {
            outpoint: hit0?.outpoint ?? {transactionId: txid, index: 0},
            value: hit0?.value ?? BigInt(outputs[0]?.value ?? 400_000_000n),
            spk: hit0?.spk ?? nextMgrSpk,
            utxoDaa: d0,
            daaScore: d0,
            daa: d0,
            covenantId: round.cid,
            redeemScript: nextMgrRedeem,
          };
          if (hit0) confirmedMgrHit = hit0;
        } else if (!hasMgrOut) {
          nextManager = null;
          nextKusdt.cursor = Math.max(Number(nextKusdt.cursor ?? 0), Number(nextKusdt.openedCount ?? nextKusdt.shards.length));
        }
        if (intent.nextManagerState) {
          nextKusdt.stage = Number(intent.nextManagerState.stage);
          nextKusdt.openedCount = Number(intent.nextManagerState.openedCount);
          nextKusdt.cursor = Number(intent.nextManagerState.cursor);
          nextKusdt.totalTickets = Math.max(Number(intent.nextManagerState.totalTickets ?? 0), Number(nextKusdt.totalTickets ?? 0));
          nextKusdt.decision = Number(intent.nextManagerState.decision ?? 0);
          nextKusdt.winnerPk = normWinnerPk(intent.nextManagerState.winnerPk) ?? normWinnerPk(nextKusdt.winnerPk);
        }
        if (Array.isArray(intent.nextShardStates)) {
          for (let j = 0; j < intent.nextShardStates.length; j++) {
            const sst = intent.nextShardStates[j];
            const outIdx = j + 1;
            const out = outputs[outIdx];
            const scid = out?.covenant?.covenantId ?? out?.covenantId;
            if (!sst || !scid) continue;
            const sRedeem = redeemForState(sst, profile);
            const sSpk = p2sh(hex(blake2b256(sRedeem)));
            const shHit = hitsByIndex.get(outIdx) ?? null;
            const prevSh = nextKusdt.shards.find(s => s?.shardCid === scid) ?? null;
            replaceOrAppendShard(preserveHistoricalShard(shardEntryFromState({
              shardCid: scid,
              state: sst,
              redeem: sRedeem,
              spk: shHit?.spk ?? sSpk,
              outpoint: shHit?.outpoint ?? {transactionId: txid, index: outIdx},
              value: shHit?.value ?? BigInt(out?.value ?? 200_000_000n),
              daaScore: shHit?.daa ?? shHit?.utxoDaa ?? 0n,
            }), prevSh));
          }
          if (!hasMgrOut && hitsByIndex.has(1)) nextKusdt.nodeVerified = true;
        }
      } else if ((intent.action === 'PAYOUT_EXECUTOR' || intent.action === 'PAYOUT_SELF') && intent.shardCid) {
        nextKusdt.shards = nextKusdt.shards.map(s => s.shardCid === intent.shardCid ? {...s, terminal: true} : s);
        if (!nextManager && nextKusdt.shards.length > 0 && nextKusdt.shards.every(s => s.terminal)) {
          nextTerminal = 'PAID';
          nextKusdt.stage = null;
          nextKusdt.nodeVerified = true;
        }
      } else if (intent.action === 'CLAIM_REFUND' && intent.shardCid) {
        const continues = (outputs[0]?.covenant?.covenantId ?? outputs[0]?.covenantId) === intent.shardCid;
        if (continues && intent.nextShardState) {
          const sRedeem = redeemForState(intent.nextShardState, profile);
          const sSpk = p2sh(hex(blake2b256(sRedeem)));
          replaceOrAppendShard(shardEntryFromState({
            shardCid: intent.shardCid,
            state: intent.nextShardState,
            redeem: sRedeem,
            spk: hit0?.spk ?? sSpk,
            outpoint: hit0?.outpoint ?? {transactionId: txid, index: 0},
            value: hit0?.value ?? BigInt(outputs[0]?.value ?? 200_000_000n),
            daaScore: hit0?.daa ?? hit0?.utxoDaa ?? 0n,
          }));
        } else {
          nextKusdt.shards = nextKusdt.shards.map(s => s.shardCid === intent.shardCid ? {...s, terminal: true} : s);
          if (!nextManager && nextKusdt.shards.length > 0 && nextKusdt.shards.every(s => s.terminal)) {
            nextTerminal = 'REFUNDED';
            nextKusdt.stage = null;
            nextKusdt.nodeVerified = true;
          }
        }
      }

      const nextDraw = intent.action === 'DRAW' && intent.drawResult
        ? intent.drawResult
        : (round.draw ?? null);
      const preSync = {
        ...round,
        intent: null,
        step: nextStep,
        terminal: nextTerminal,
        manager: nextManager,
        accepting: nextManager?.outpoint?.transactionId === round.manager?.outpoint?.transactionId ? (round.accepting ?? null) : null,
        ...(nextDraw ? {draw: nextDraw} : {}),
        bought: Number(nextKusdt.totalTickets ?? round.bought ?? 0),
        kusdt: nextKusdt,
        receipts: nextReceipts,
      };
      const syncedAfter = await this.syncRound({rpc, indexer, round: preSync, cid: round.cid, net, fetcher});
      const finalReceipts = mergeKusdtReceipts(syncedAfter.round.receipts ?? [], nextReceipts);
      let finalFees = 0n;
      for (const rc of finalReceipts) {
        try { finalFees += BigInt(rc.feeSompi ?? 0); } catch {}
      }
      const finalDraw = syncedAfter.round.draw ?? nextDraw ?? null;
      const finalRound = {
        ...syncedAfter.round,
        intent: null,
        step: Math.max(nextStep, Number(syncedAfter.round.step ?? 0), finalReceipts.length),
        receipts: finalReceipts,
        fees: finalFees,
        ...(finalDraw ? {draw: finalDraw} : {}),
        ...(confirmedMgrHit && !syncedAfter.round.terminal && !syncedAfter.round.kusdt?.nodeVerified
          ? {manager: nextManager, kusdt: {...syncedAfter.round.kusdt, nodeVerified: true}}
          : {}),
      };
      return {accepted: true, round: finalRound};
    },
    toRoundSummary(r, opts = {}) {
      return kusdtV2Summary(r, {...opts, profile, kusdtCid: effectiveCid});
    },
  });
}
