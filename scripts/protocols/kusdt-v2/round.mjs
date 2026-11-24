/** Round model, validation, availableActions, and ProtocolAdapter summary for Kaswin kUSDT v2. */
import {blake2b256, check, covenantId, hex, p2sh, same, unhex} from '../../core.mjs';
import {
  CLOSE_DAA_MAX,
  DECISION,
  KUSDT_V2_PROTOCOL_ID,
  KUSDT_V2_VERSION,
  MANAGER_DEPOSIT,
  MAX_BATCH,
  MAX_RECORDS_PER_SHARD,
  MAX_SHARDS,
  MIN_DRAW_TICKETS,
  PRICE_MAX,
  PRICE_MIN,
  REROLL_TIMEOUT_DAA,
  STAGE,
  kusdtAsset,
} from './constants.mjs';
import {redeemForState, verifyKusdtV2Redeem} from './profile.mjs';

const HASH64 = /^[0-9a-f]{64}$/;
const ZERO32 = '00'.repeat(32);

/** Canonical empty M_OPEN genesis root check (C-01 off-chain defense):
 * proves managerCid is derived from an empty M_OPEN (openedCount=0, cursor=0, totalTickets=0, decision=0, reserved=0)
 * spent from `origin` with MANAGER_DEPOSIT at output index 0. */
export function verifyKusdtV2GenesisRoot({cid, origin, price, closeDaa, creatorPk, profile}) {
  check(typeof cid === 'string' && HASH64.test(cid), 'KUSDT_V2_CID');
  check(origin && typeof origin.transactionId === 'string' && HASH64.test(origin.transactionId.toLowerCase()) && Number.isInteger(Number(origin.index)) && Number(origin.index) >= 0, 'KUSDT_V2_GENESIS_ORIGIN');
  const p = BigInt(price), c = BigInt(closeDaa);
  check(p >= PRICE_MIN && p <= PRICE_MAX, 'KUSDT_V2_PRICE_RANGE');
  check(c > 0n && c < CLOSE_DAA_MAX, 'KUSDT_V2_CLOSE_DAA');
  check(typeof creatorPk === 'string' && HASH64.test(creatorPk.toLowerCase()), 'KUSDT_V2_CREATOR_PK');
  const emptyRedeem = redeemForState({
    stage: STAGE.M_OPEN,
    version: KUSDT_V2_VERSION,
    creatorPk: creatorPk.toLowerCase(),
    price: p,
    closeDaa: c,
    openedCount: 0,
    cursor: 0,
    totalTickets: 0,
    decision: DECISION.UNDECIDED,
    reserved: 0,
    entries: [],
  }, profile);
  const emptySpk = p2sh(hex(blake2b256(emptyRedeem)));
  const expectedCid = covenantId(
    {transactionId: origin.transactionId.toLowerCase(), index: Number(origin.index)},
    [{index: 0, value: MANAGER_DEPOSIT, spk: emptySpk}],
  );
  check(expectedCid === cid.toLowerCase(), 'KUSDT_V2_GENESIS_ROOT_MISMATCH');
  return true;
}

function shardListOf(round) {
  if (Array.isArray(round?.kusdt?.shards) && round.kusdt.shards.length) return round.kusdt.shards;
  if (round?.shards && typeof round.shards === 'object') {
    return Array.isArray(round.shards) ? round.shards : Object.values(round.shards);
  }
  return Array.isArray(round?.kusdt?.shards) ? round.kusdt.shards : [];
}

export function emptyKusdtV2Round({cid, settings, profileId = null} = {}) {
  check(typeof cid === 'string' && HASH64.test(cid), 'KUSDT_V2_CID');
  check(settings && typeof settings === 'object', 'KUSDT_V2_SETTINGS');
  const ticketPrice = BigInt(settings.ticketPrice);
  const closeDaa = BigInt(settings.closeDaa);
  check(ticketPrice >= PRICE_MIN, 'KUSDT_V2_PRICE_MIN');
  check(closeDaa > 0n, 'KUSDT_V2_CLOSE_DAA');
  check(typeof settings.creatorPk === 'string' && HASH64.test(settings.creatorPk), 'KUSDT_V2_CREATOR_PK');
  return {
    protocol: KUSDT_V2_PROTOCOL_ID,
    profileId,
    cid,
    settings: {
      ticketPrice,
      closeDaa,
      creatorPk: settings.creatorPk,
    },
    manager: null,
    shards: {},
    winnerPk: null,
    terminal: null,
    receipts: [],
  };
}

export function decodeManagerFromRound(round, profile) {
  const src = round?.manager?.redeem ?? round?.manager?.redeemScript;
  if (!src) return null;
  const raw = typeof src === 'string' ? unhex(src) : src;
  return verifyKusdtV2Redeem(raw, profile, 'manager');
}

export function decodeShardFromRound(shard, profile) {
  const src = shard?.redeem ?? shard?.redeemScript;
  if (!src) return null;
  const raw = typeof src === 'string' ? unhex(src) : src;
  return verifyKusdtV2Redeem(raw, profile, 'shard');
}

export function validateKusdtV2Round(round, profile, {profileId = null, requireGenesisRoot = false} = {}) {
  check(round && typeof round === 'object', 'KUSDT_V2_ROUND');
  check(typeof round.cid === 'string' && HASH64.test(round.cid), 'KUSDT_V2_CID');
  if (profileId && round.profileId) check(round.profileId === profileId, 'KUSDT_V2_PROFILE_MISMATCH');
  check(round.settings && typeof round.settings === 'object', 'KUSDT_V2_SETTINGS');
  const ticketPrice = BigInt(round.settings.ticketPrice);
  const closeDaa = BigInt(round.settings.closeDaa ?? round.settings.closeEligibleDaa ?? round.kusdt?.closeDaa ?? 0n);
  check(ticketPrice >= PRICE_MIN && ticketPrice <= PRICE_MAX, 'KUSDT_V2_PRICE_MIN');
  check(closeDaa > 0n && closeDaa < CLOSE_DAA_MAX, 'KUSDT_V2_CLOSE_DAA');
  const creatorPk = round.settings.creatorPk ?? round.kusdt?.creatorPk;
  check(typeof creatorPk === 'string' && HASH64.test(creatorPk), 'KUSDT_V2_CREATOR_PK');

  let mgr = null;
  if (round.manager && (round.manager.redeem || round.manager.redeemScript)) {
    mgr = decodeManagerFromRound(round, profile);
    check(mgr.state.version === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
    check(mgr.state.price === ticketPrice, 'KUSDT_V2_PRICE_MISMATCH');
    check(mgr.state.closeDaa === closeDaa, 'KUSDT_V2_CLOSE_DAA_MISMATCH');
    check(mgr.state.creatorPk === creatorPk, 'KUSDT_V2_CREATOR_MISMATCH');
  }
  if (requireGenesisRoot || round.origin?.transactionId) {
    verifyKusdtV2GenesisRoot({cid: round.cid, origin: round.origin, price: ticketPrice, closeDaa, creatorPk, profile});
  }
  const knownDir = mgr
    ? new Set(
        Array.isArray(mgr.state.entries)
          ? mgr.state.entries.map(e => e.shardCid)
          : (Array.isArray(mgr.state.shardCids) ? mgr.state.shardCids : []),
      )
    : null;
  const checkShardEntry = (shardCid, shard) => {
    check(HASH64.test(shardCid), 'KUSDT_V2_SHARD_CID');
    if (knownDir) check(knownDir.has(shardCid), 'KUSDT_V2_SHARD_NOT_IN_DIRECTORY');
    if (shard?.redeem || shard?.redeemScript) {
      const dec = decodeShardFromRound(shard, profile);
      if (dec?.state?.managerCid) check(dec.state.managerCid === round.cid, 'KUSDT_V2_SHARD_MANAGER_MISMATCH');
    }
  };
  const shards = round.shards && !Array.isArray(round.shards) ? round.shards : {};
  for (const [shardCid, shard] of Object.entries(shards)) checkShardEntry(shardCid, shard);
  if (Array.isArray(round.kusdt?.shards)) {
    for (const shard of round.kusdt.shards) {
      if (!shard) continue;
      checkShardEntry(shard.shardCid, shard);
    }
  }
  return {round, manager: mgr};
}

export function kusdtV2RoundToText(round) {
  // Strip local transient intent/pending state so share codes carry only round state (H-05)
  const clean = round && typeof round === 'object' ? {...round, intent: null, pending: []} : round;
  return JSON.stringify(clean, (_, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array) return hex(v);
    return v;
  });
}

function hydrateShardObj(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {...s};
  if (out.value != null) out.value = BigInt(out.value);
  if (out.daaScore != null) out.daaScore = BigInt(out.daaScore);
  if (out.utxoDaa != null) out.utxoDaa = BigInt(out.utxoDaa);
  if (out.vaultValue != null) out.vaultValue = BigInt(out.vaultValue);
  if (out.vaultAmount != null) out.vaultAmount = BigInt(out.vaultAmount);
  if (typeof out.redeem === 'string') out.redeem = unhex(out.redeem);
  if (typeof out.redeemScript === 'string') out.redeemScript = unhex(out.redeemScript);
  if (typeof out.frozenRedeem === 'string') out.frozenRedeem = unhex(out.frozenRedeem);
  return out;
}

export function kusdtV2RoundFromText(text, profile, {profileId = null} = {}) {
  const parsed = JSON.parse(text);
  const closeVal = parsed.settings?.closeDaa ?? parsed.settings?.closeEligibleDaa ?? parsed.kusdt?.closeDaa;
  const round = {
    ...parsed,
    intent: null,
    pending: [],
    fees: parsed.fees != null ? BigInt(parsed.fees) : 0n,
    settings: {
      ...parsed.settings,
      ticketPrice: BigInt(parsed.settings.ticketPrice),
      closeDaa: BigInt(closeVal),
      ...(parsed.settings?.closeEligibleDaa != null ? {closeEligibleDaa: BigInt(parsed.settings.closeEligibleDaa)} : {closeEligibleDaa: BigInt(closeVal)}),
    },
  };
  if (round.manager) {
    round.manager = {...round.manager};
    if (round.manager.value != null) round.manager.value = BigInt(round.manager.value);
    if (round.manager.utxoDaa != null) round.manager.utxoDaa = BigInt(round.manager.utxoDaa);
    if (round.manager.daaScore != null) round.manager.daaScore = BigInt(round.manager.daaScore);
    if (round.manager.daa != null) round.manager.daa = BigInt(round.manager.daa);
    if (typeof round.manager.redeem === 'string') round.manager.redeem = unhex(round.manager.redeem);
    if (typeof round.manager.redeemScript === 'string') round.manager.redeemScript = unhex(round.manager.redeemScript);
  }
  if (round.shards && !Array.isArray(round.shards)) {
    const nextShards = {};
    for (const [k, s] of Object.entries(round.shards)) nextShards[k] = hydrateShardObj(s);
    round.shards = nextShards;
  }
  if (round.kusdt && typeof round.kusdt === 'object') {
    round.kusdt = {
      ...round.kusdt,
      price: BigInt(round.kusdt.price ?? round.settings.ticketPrice),
      closeDaa: BigInt(round.kusdt.closeDaa ?? closeVal),
      shards: Array.isArray(round.kusdt.shards) ? round.kusdt.shards.map(hydrateShardObj) : [],
    };
  }
  validateKusdtV2Round(round, profile, {profileId});
  return round;
}

function countShardTickets(shardState) {
  if (!shardState) return 0;
  if (shardState.stage === STAGE.S_OPEN || shardState.stage === STAGE.S_FROZEN) {
    const recs = shardState.records ?? [];
    return recs.length ? recs[recs.length - 1].cumTickets : 0;
  }
  if (shardState.stage === STAGE.S_PAYOUT) return shardState.shardTickets;
  if (shardState.stage === STAGE.S_REFUND) {
    const recs = shardState.records ?? [];
    return recs.length ? recs[recs.length - 1].cumTickets : 0;
  }
  return 0;
}

export function availableKusdtV2Actions(round, profile, currentDaa = 0n) {
  const daa = BigInt(currentDaa ?? 0n);
  const actions = [];
  if (round.terminal) return actions;

  const mgr = round.manager ? decodeManagerFromRound(round, profile)?.state : null;
  if (mgr) {
    if (mgr.stage === STAGE.M_OPEN) {
      if (mgr.cursor === 0 && mgr.openedCount < MAX_SHARDS && daa < mgr.closeDaa) {
        actions.push('OPEN_SHARD');
      }
      if (daa >= mgr.closeDaa) {
        if (mgr.openedCount === 0) actions.push('EMPTY_CLOSE');
        else if (mgr.cursor < mgr.openedCount) actions.push('COLLECT_BATCH');
      }
    } else if (mgr.stage === STAGE.M_SEALED) {
      const utxoDaa = BigInt(round.manager.utxoDaa ?? 0n);
      if (daa >= utxoDaa + 100n) actions.push('DRAW');
      if (daa >= utxoDaa + REROLL_TIMEOUT_DAA) actions.push('REROLL');
    } else if (mgr.stage === STAGE.M_DISPATCH) {
      if (mgr.cursor < mgr.openedCount) actions.push('DISPATCH_BATCH');
    }
  }

  for (const shard of shardListOf(round)) {
    if (!shard || shard.terminal || !(shard.redeem || shard.redeemScript)) continue;
    const {state} = decodeShardFromRound(shard, profile);
    if (state.stage === STAGE.S_OPEN) {
      if (state.recordCount < MAX_RECORDS_PER_SHARD && (!mgr || (mgr.stage === STAGE.M_OPEN && mgr.cursor === 0 && daa < mgr.closeDaa))) {
        if (!actions.includes('BUY')) actions.push('BUY');
      }
    } else if (state.stage === STAGE.S_PAYOUT) {
      if (!actions.includes('PAYOUT_EXECUTOR')) actions.push('PAYOUT_EXECUTOR');
      if (!actions.includes('PAYOUT_SELF')) actions.push('PAYOUT_SELF');
    } else if (state.stage === STAGE.S_REFUND) {
      const allClaimed = state.recordCount === 1 ? (state.claimedMask & 1) === 1 : (state.claimedMask & 3) === 3;
      if (!allClaimed && !actions.includes('CLAIM_REFUND')) actions.push('CLAIM_REFUND');
    }
  }
  return actions;
}

export function kusdtV2Summary(round, {profile, kusdtCid, currentDaa = 0n} = {}) {
  const cid = kusdtCid ?? profile?.kusdtCid;
  const asset = kusdtAsset(cid);
  const daa = BigInt(currentDaa ?? 0n);

  let phase = 'OPEN';
  let subPhase = 'm_open';
  let settlementProgress = null;
  let ticketsSold = 0;
  let openedCount = 0;
  let cursor = 0;
  let winnerPk = round.winnerPk ?? null;

  const shardEntries = shardListOf(round);
  const liveShards = shardEntries.filter(s => s && !s.terminal);
  let settledShards = shardEntries.filter(s => s && s.terminal).length;

  let mgrState = null;
  if (round.manager?.redeem || round.manager?.redeemScript) {
    try {
      mgrState = decodeManagerFromRound(round, profile).state;
    } catch {}
  }

  if (round.terminal === 'EMPTY' || round.terminal === 'PAID' || round.terminal === 'REFUNDED') {
    phase = 'DONE';
    subPhase = round.terminal;
    if (mgrState) {
      openedCount = mgrState.openedCount;
      ticketsSold = mgrState.totalTickets;
    } else if (round.kusdt) {
      openedCount = Number(round.kusdt.openedCount ?? shardEntries.length);
      ticketsSold = Number(round.kusdt.totalTickets ?? 0);
    }
  } else if (mgrState) {
    openedCount = mgrState.openedCount;
    cursor = mgrState.cursor;
    if (mgrState.stage === STAGE.M_OPEN) {
      if (mgrState.cursor > 0 || daa >= mgrState.closeDaa) {
        phase = 'CLOSING';
        subPhase = 'collecting';
        settlementProgress = {done: mgrState.cursor, total: mgrState.openedCount, labelKey: 'COLLECT'};
      } else {
        phase = 'OPEN';
        subPhase = 'm_open';
      }
      // Sum live shard tickets during OPEN when available, otherwise use manager totalTickets
      let sum = 0;
      for (const s of shardEntries) {
        if (!(s?.redeem || s?.redeemScript)) continue;
        try {sum += countShardTickets(decodeShardFromRound(s, profile).state);} catch {}
      }
      ticketsSold = Math.max(mgrState.totalTickets, sum);
    } else if (mgrState.stage === STAGE.M_SEALED) {
      phase = 'SEALED';
      subPhase = 'm_sealed';
      ticketsSold = mgrState.totalTickets;
    } else if (mgrState.stage === STAGE.M_DISPATCH) {
      ticketsSold = mgrState.totalTickets;
      if (mgrState.decision === DECISION.REFUND) {
        phase = 'REFUNDING';
        subPhase = 'm_dispatch_refund';
        settlementProgress = {done: settledShards, total: Math.max(openedCount, settledShards + liveShards.length), labelKey: 'REFUND'};
      } else {
        phase = 'SETTLING';
        subPhase = 'm_dispatch_payout';
        if (mgrState.winnerPk && mgrState.winnerPk !== ZERO32) winnerPk = mgrState.winnerPk;
        settlementProgress = {done: settledShards, total: Math.max(openedCount, settledShards + liveShards.length), labelKey: 'PAYOUT'};
      }
    }
  } else if (liveShards.length > 0) {
    // Manager already destroyed after DISPATCH_BATCH; shards still being settled/refunded
    let hasRefund = false;
    for (const s of liveShards) {
      try {
        const st = decodeShardFromRound(s, profile).state;
        ticketsSold += countShardTickets(st);
        if (st.stage === STAGE.S_REFUND) hasRefund = true;
        if (st.stage === STAGE.S_PAYOUT && st.winnerPk) winnerPk = st.winnerPk;
      } catch {}
    }
    phase = hasRefund ? 'REFUNDING' : 'SETTLING';
    subPhase = hasRefund ? 's_refund' : 's_payout';
    const total = settledShards + liveShards.length;
    settlementProgress = {done: settledShards, total, labelKey: hasRefund ? 'REFUND' : 'PAYOUT'};
  }

  return {
    protocolId: KUSDT_V2_PROTOCOL_ID,
    profileId: round.profileId ?? profile.id,
    roundId: round.cid,
    asset,
    phase,
    subPhase,
    terminal: round.terminal ?? null,
    ticketsSold,
    ticketCap: MAX_SHARDS * MAX_RECORDS_PER_SHARD,
    ticketPrice: round.settings.ticketPrice,
    settlementProgress,
    protocolData: {
      openedCount,
      cursor,
      maxBatch: MAX_BATCH,
      minDrawTickets: MIN_DRAW_TICKETS,
      closeDaa: round.settings.closeDaa,
      creatorPk: round.settings.creatorPk,
      winnerPk,
      shards: shardEntries.map((s, idx) => ({
        shardCid: s?.shardCid ?? Object.keys(round.shards ?? {})[idx] ?? '',
        terminal: !!s?.terminal,
        firstBuyerPk: s?.firstBuyerPk ?? null,
        tickets: s?.tickets ?? null,
      })),
    },
  };
}

export function describeKusdtV2Round(round, currentDaa = null) {
  const k = round?.kusdt ?? {};
  const stage = k.stage ?? (round?.manager ? STAGE.M_OPEN : null);
  const shardsList = Array.isArray(k.shards) ? k.shards : [];
  const hasRefundShard = shardsList.some(s => !s?.terminal && s?.stage === STAGE.S_REFUND);
  const hasPayoutShard = shardsList.some(s => !s?.terminal && s?.stage === STAGE.S_PAYOUT);
  const mod = round?.terminal
    ? null
    : stage === STAGE.M_OPEN
      ? 'sales'
      : stage === STAGE.M_SEALED
        ? 'sealed'
        : (stage === STAGE.M_DISPATCH || !round?.manager)
          ? (k.decision === DECISION.REFUND || hasRefundShard ? 'refund' : (k.decision === DECISION.PAYOUT || hasPayoutShard ? 'win' : 'sales'))
          : 'sales';
  const ticketPrice = BigInt(k.price ?? round?.settings?.ticketPrice ?? 1_000_000n);
  const closeEligibleDaa = BigInt(k.closeDaa ?? round?.settings?.closeEligibleDaa ?? round?.settings?.closeDaa ?? 0n);
  const tickets = Number(k.totalTickets ?? round?.bought ?? 0);
  const shards = Number(k.openedCount ?? 0);
  const cursor = Number(k.cursor ?? 0);
  const rawWinner = k.winnerPk ?? round?.winnerPk ?? null;
  const winnerKey = typeof rawWinner === 'string' && rawWinner !== ZERO32 ? rawWinner : null;
  return {
    module: mod,
    ticketPrice,
    ticketCap: MAX_SHARDS * MAX_RECORDS_PER_SHARD,
    minTickets: MIN_DRAW_TICKETS,
    closeEligibleDaa,
    tickets,
    shards,
    localRecords: 0,
    owner: k.creatorPk ?? round?.settings?.creatorPk ?? null,
    winnerKey,
    payCursor: cursor,
    refundShard: cursor,
    currentDaa,
  };
}

export function kusdtV2ShardCatalog(round, walletKey = null) {
  const rawShards = round?.kusdt?.shards ?? [];
  const isRefundRound = round?.terminal === 'REFUNDED' || round?.kusdt?.decision === DECISION.REFUND;
  let startTicket = 1;
  return rawShards.map((s, idx) => {
    let prev = 0;
    let mineCount = 0;
    let refundedRecords = 0;
    const records = Array.isArray(s.records)
      ? s.records.map((rec, ri) => {
          const c = rec.cumTickets - prev;
          const st = startTicket + prev;
          prev = rec.cumTickets;
          const mine = !!walletKey && rec.buyerPk === walletKey;
          if (mine) mineCount += c;
          const refunded = !!s.terminal && isRefundRound ? true : !!((s.claimedMask ?? 0) & (1 << ri));
          if (refunded) refundedRecords++;
          return {
            index: ri,
            startTicket: st,
            endTicket: st + c - 1,
            count: c,
            key: rec.buyerPk,
            mine,
            refunded,
          };
        })
      : null;
    const tickets = Number(s.tickets ?? 0);
    const endTicket = startTicket + Math.max(0, tickets) - 1;
    startTicket += Math.max(0, tickets);
    const status = s.terminal
      ? (isRefundRound || s.stage === STAGE.S_REFUND ? 'refunded' : 'settled')
      : s.stage === STAGE.S_REFUND
        ? 'refunding'
        : s.stage === STAGE.S_FROZEN
          ? 'frozen'
          : 'active';
    return {
      index: idx,
      kind: s.stage === STAGE.S_OPEN ? 'active' : 'frozen',
      status,
      startTicket: tickets > 0 ? endTicket - tickets + 1 : startTicket,
      endTicket,
      tickets,
      recordCount: Number(s.recordCount ?? (records ? records.length : 0)),
      records,
      hash: s.shardCid,
      refundedRecords,
      mineCount,
    };
  });
}

export function kusdtV2UiActions(round, currentDaa = null) {
  const f = describeKusdtV2Round(round, currentDaa);
  const k = round?.kusdt ?? {};
  const mod = f.module;
  const cursor = Number(k.cursor ?? 0);
  const opened = Number(k.openedCount ?? 0);
  const closeDaa = f.closeEligibleDaa;
  const mgr = round?.manager ?? null;
  const daa = currentDaa != null ? BigInt(currentDaa) : null;
  const daaReached = daa != null && closeDaa > 0n && daa >= closeDaa;
  const openShards = (k.shards ?? []).filter(s => !s.terminal && s.stage === STAGE.S_OPEN && Number(s.recordCount ?? 0) < MAX_RECORDS_PER_SHARD);
  if (round?.terminal || round?.halted || !mgr) {
    return {
      BUY: {ok: false, reason: '当前不可购买'},
      CLOSE: {ok: false, reason: '当前不可封盘'},
      DRAW: {ok: false, reason: '当前不可开奖'},
      TIMEOUT: {ok: false, reason: '不适用'},
      PAY_OLD: {ok: false, reason: '不适用'},
      PAY_SELF: {ok: false, reason: '不适用'},
      REFUND_OLD: {ok: false, reason: '不适用'},
      REFUND_SELF: {ok: false, reason: '不适用'},
    };
  }
  return {
    BUY: mod === 'sales' && cursor === 0 && (opened < MAX_SHARDS || openShards.length > 0)
      ? {ok: true, maxQuantity: MAX_SHARDS * MAX_RECORDS_PER_SHARD}
      : {ok: false, reason: '当前不可购买'},
    CLOSE: mod === 'sales' && daaReached && cursor < Math.max(1, opened)
      ? {ok: true}
      : {ok: false, reason: closeDaa > 0n && daa != null && daa < closeDaa ? `尚未到可封盘 DAA，还差 ${(closeDaa - daa).toString()}` : '尚未满足封盘条件'},
    DRAW: mod === 'sealed' && daa != null && daa >= BigInt(mgr.utxoDaa ?? 0n) + 100n
      ? {ok: true}
      : {ok: false, reason: '封盘满 100 DAA 后可开奖'},
    TIMEOUT: mod === 'sealed' && daa != null && daa >= BigInt(mgr.utxoDaa ?? 0n) + REROLL_TIMEOUT_DAA
      ? {ok: true}
      : {ok: false, reason: '封盘逾 12 小时未开奖可重掷'},
    PAY_OLD: mod === 'win' && cursor < opened ? {ok: true} : {ok: false, reason: '不适用'},
    PAY_SELF: {ok: false, reason: '不适用'},
    REFUND_OLD: mod === 'refund' && cursor < opened ? {ok: true} : {ok: false, reason: '不适用'},
    REFUND_SELF: {ok: false, reason: '不适用'},
  };
}
