/** Byte-level state codecs for Kaswin kUSDT v2 (manager, shards, and KCC-20 external vault).
 * All integers are little-endian; u63 values are non-negative signed 64-bit integers. */
import {blake2b256, cat, check, fromLe, hex, le, p2sh, pushBytes, scriptNumber, unhex} from '../../core.mjs';
import {blake3} from '../../core/lib/blake3.js';

const u63 = n => {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  check(v >= 0n && v < (1n << 63n), 'KUSDT_V2_U63');
  return v;
};
import {
  DECISION,
  KCC20_EXT_TEMPLATE_HASH,
  KCC20_OWNER_SCHEME,
  KCC20_PREFIX_HEX,
  KCC20_SUFFIX_LEN,
  KUSDT_V2_VERSION,
  MAX_RECORDS_PER_SHARD,
  MAX_SHARDS,
  PRICE_MIN,
  STAGE,
} from './constants.mjs';

const ZERO32 = '00'.repeat(32);

function encodeMHeader(h) {
  check(h.version === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  const creatorPk = unhex(h.creatorPk, 32);
  const price = u63(h.price);
  check(price >= PRICE_MIN, 'KUSDT_V2_PRICE_MIN');
  const closeDaa = u63(h.closeDaa);
  check(Number.isInteger(h.openedCount) && h.openedCount >= 0 && h.openedCount <= MAX_SHARDS, 'KUSDT_V2_OPENED_COUNT');
  check(Number.isInteger(h.cursor) && h.cursor >= 0 && h.cursor <= h.openedCount, 'KUSDT_V2_CURSOR');
  check(Number.isInteger(h.totalTickets) && h.totalTickets >= 0, 'KUSDT_V2_TOTAL_TICKETS');
  return cat(
    Uint8Array.of(h.stage, h.version),
    creatorPk,
    le(price, 8),
    le(closeDaa, 8),
    le(BigInt(h.openedCount), 2),
    le(BigInt(h.cursor), 2),
    le(BigInt(h.totalTickets), 4),
    Uint8Array.of(h.decision ?? DECISION.UNDECIDED, h.reserved ?? 0),
  );
}

function decodeMHeader(raw) {
  check(raw.length >= 60, 'KUSDT_V2_HEADER_LEN');
  return {
    stage: raw[0],
    version: raw[1],
    creatorPk: hex(raw.slice(2, 34)),
    price: fromLe(raw.slice(34, 42)),
    closeDaa: fromLe(raw.slice(42, 50)),
    openedCount: Number(fromLe(raw.slice(50, 52))),
    cursor: Number(fromLe(raw.slice(52, 54))),
    totalTickets: Number(fromLe(raw.slice(54, 58))),
    decision: raw[58],
    reserved: raw[59],
  };
}

export function encodeManagerOpenOrSealedState(s) {
  check(s.stage === STAGE.M_OPEN || s.stage === STAGE.M_SEALED, 'KUSDT_V2_STAGE');
  const entries = s.entries ?? [];
  check(entries.length === s.openedCount, 'KUSDT_V2_ENTRY_COUNT');
  const header = encodeMHeader(s);
  const parts = [header];
  for (const e of entries) {
    parts.push(
      unhex(e.shardCid, 32),
      unhex(e.ledgerHash ?? ZERO32, 32),
      le(BigInt(e.cumTickets ?? 0), 4),
    );
  }
  return cat(...parts);
}

export function decodeManagerOpenOrSealedState(raw) {
  const h = decodeMHeader(raw);
  check(h.stage === STAGE.M_OPEN || h.stage === STAGE.M_SEALED, 'KUSDT_V2_STAGE');
  check(h.version === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  check(h.openedCount <= MAX_SHARDS, 'KUSDT_V2_OPENED_COUNT');
  check(raw.length === 60 + h.openedCount * 68, 'KUSDT_V2_MANAGER_LEN');
  const entries = [];
  for (let i = 0; i < h.openedCount; i++) {
    const off = 60 + i * 68;
    entries.push({
      shardCid: hex(raw.slice(off, off + 32)),
      ledgerHash: hex(raw.slice(off + 32, off + 64)),
      cumTickets: Number(fromLe(raw.slice(off + 64, off + 68))),
    });
  }
  return {...h, entries};
}

export function encodeManagerDispatchState(s) {
  check(s.stage === STAGE.M_DISPATCH, 'KUSDT_V2_STAGE');
  const shardCids = s.shardCids ?? [];
  check(shardCids.length === s.openedCount, 'KUSDT_V2_SHARD_CID_COUNT');
  const header = encodeMHeader(s);
  const winnerPk = unhex(s.winnerPk ?? ZERO32, 32);
  return cat(header, winnerPk, ...shardCids.map(c => unhex(c, 32)));
}

export function decodeManagerDispatchState(raw) {
  const h = decodeMHeader(raw);
  check(h.stage === STAGE.M_DISPATCH, 'KUSDT_V2_STAGE');
  check(h.version === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  check(h.openedCount <= MAX_SHARDS, 'KUSDT_V2_OPENED_COUNT');
  check(raw.length === 92 + h.openedCount * 32, 'KUSDT_V2_DISPATCH_LEN');
  const winnerPk = hex(raw.slice(60, 92));
  const shardCids = [];
  for (let i = 0; i < h.openedCount; i++) {
    const off = 92 + i * 32;
    shardCids.push(hex(raw.slice(off, off + 32)));
  }
  return {...h, winnerPk, shardCids};
}

export function decodeManagerState(raw) {
  check(raw.length >= 60, 'KUSDT_V2_MANAGER_LEN');
  if (raw[0] === STAGE.M_OPEN || raw[0] === STAGE.M_SEALED) return decodeManagerOpenOrSealedState(raw);
  if (raw[0] === STAGE.M_DISPATCH) return decodeManagerDispatchState(raw);
  throw new Error('KUSDT_V2_MANAGER_STAGE');
}

function encodeRecords(records) {
  const parts = [];
  let prev = 0;
  for (const r of records) {
    check(Number.isInteger(r.cumTickets) && r.cumTickets > prev, 'KUSDT_V2_RECORD_CUM');
    prev = r.cumTickets;
    parts.push(le(BigInt(r.cumTickets), 4), unhex(r.buyerPk, 32));
  }
  return cat(...parts);
}

function decodeRecords(raw, offset, count) {
  const records = [];
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const off = offset + i * 36;
    const cumTickets = Number(fromLe(raw.slice(off, off + 4)));
    check(cumTickets > prev, 'KUSDT_V2_RECORD_CUM');
    prev = cumTickets;
    records.push({cumTickets, buyerPk: hex(raw.slice(off + 4, off + 36))});
  }
  return records;
}

export function encodeShardOpenOrFrozenState(s) {
  check(s.stage === STAGE.S_OPEN || s.stage === STAGE.S_FROZEN, 'KUSDT_V2_SHARD_STAGE');
  check((s.version ?? KUSDT_V2_VERSION) === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  const records = s.records ?? [];
  check(records.length >= 1 && records.length <= MAX_RECORDS_PER_SHARD, 'KUSDT_V2_RECORD_COUNT');
  return cat(
    Uint8Array.of(s.stage, KUSDT_V2_VERSION),
    unhex(s.managerCid, 32),
    unhex(s.firstBuyerPk, 32),
    le(u63(s.price), 8),
    le(BigInt(records.length), 2),
    encodeRecords(records),
  );
}

export function decodeShardOpenOrFrozenState(raw) {
  check(raw.length >= 76, 'KUSDT_V2_SHARD_LEN');
  const stage = raw[0], version = raw[1];
  check(stage === STAGE.S_OPEN || stage === STAGE.S_FROZEN, 'KUSDT_V2_SHARD_STAGE');
  check(version === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  const recordCount = Number(fromLe(raw.slice(74, 76)));
  check(recordCount >= 1 && recordCount <= MAX_RECORDS_PER_SHARD, 'KUSDT_V2_RECORD_COUNT');
  check(raw.length === 76 + recordCount * 36, 'KUSDT_V2_SHARD_LEN');
  return {
    stage,
    version,
    managerCid: hex(raw.slice(2, 34)),
    firstBuyerPk: hex(raw.slice(34, 66)),
    price: fromLe(raw.slice(66, 74)),
    recordCount,
    records: decodeRecords(raw, 76, recordCount),
  };
}

export function encodeShardPayoutState(s) {
  check((s.stage ?? STAGE.S_PAYOUT) === STAGE.S_PAYOUT, 'KUSDT_V2_SHARD_STAGE');
  check((s.version ?? KUSDT_V2_VERSION) === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  check(Number.isInteger(s.shardTickets) && s.shardTickets >= 1, 'KUSDT_V2_SHARD_TICKETS');
  return cat(
    Uint8Array.of(STAGE.S_PAYOUT, KUSDT_V2_VERSION),
    unhex(s.firstBuyerPk, 32),
    unhex(s.winnerPk, 32),
    le(u63(s.vaultAmount), 8),
    unhex(s.managerCid, 32),
    le(BigInt(s.shardTickets), 4),
  );
}

export function decodeShardPayoutState(raw) {
  check(raw.length === 110, 'KUSDT_V2_PAYOUT_LEN');
  check(raw[0] === STAGE.S_PAYOUT, 'KUSDT_V2_SHARD_STAGE');
  check(raw[1] === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  return {
    stage: raw[0],
    version: raw[1],
    firstBuyerPk: hex(raw.slice(2, 34)),
    winnerPk: hex(raw.slice(34, 66)),
    vaultAmount: fromLe(raw.slice(66, 74)),
    managerCid: hex(raw.slice(74, 106)),
    shardTickets: Number(fromLe(raw.slice(106, 110))),
  };
}

export function encodeShardRefundState(s) {
  check((s.stage ?? STAGE.S_REFUND) === STAGE.S_REFUND, 'KUSDT_V2_SHARD_STAGE');
  check((s.version ?? KUSDT_V2_VERSION) === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  const records = s.records ?? [];
  check(records.length === 1 || records.length === 2, 'KUSDT_V2_REFUND_RECORDS');
  const claimedMask = s.claimedMask ?? 0;
  check(Number.isInteger(claimedMask) && claimedMask >= 0 && claimedMask <= 3, 'KUSDT_V2_CLAIMED_MASK');
  return cat(
    Uint8Array.of(STAGE.S_REFUND, KUSDT_V2_VERSION),
    unhex(s.firstBuyerPk, 32),
    le(u63(s.price), 8),
    Uint8Array.of(records.length, claimedMask),
    encodeRecords(records),
  );
}

export function decodeShardRefundState(raw) {
  check(raw.length === 80 || raw.length === 116, 'KUSDT_V2_REFUND_LEN');
  check(raw[0] === STAGE.S_REFUND, 'KUSDT_V2_SHARD_STAGE');
  check(raw[1] === KUSDT_V2_VERSION, 'KUSDT_V2_VERSION');
  const recordCount = raw[42];
  check(recordCount === 1 || recordCount === 2, 'KUSDT_V2_REFUND_RECORDS');
  check(raw.length === 44 + recordCount * 36, 'KUSDT_V2_REFUND_LEN');
  return {
    stage: raw[0],
    version: raw[1],
    firstBuyerPk: hex(raw.slice(2, 34)),
    price: fromLe(raw.slice(34, 42)),
    recordCount,
    claimedMask: raw[43],
    records: decodeRecords(raw, 44, recordCount),
  };
}

export function decodeShardState(raw) {
  check(raw.length >= 76, 'KUSDT_V2_SHARD_LEN');
  if (raw[0] === STAGE.S_OPEN || raw[0] === STAGE.S_FROZEN) return decodeShardOpenOrFrozenState(raw);
  if (raw[0] === STAGE.S_PAYOUT) return decodeShardPayoutState(raw);
  if (raw[0] === STAGE.S_REFUND) return decodeShardRefundState(raw);
  throw new Error('KUSDT_V2_SHARD_STAGE');
}

function encodeOpNum2Bin8(n) {
  const v = u63(n);
  const b = le(v, 8);
  check((b[7] & 0x80) === 0, 'KUSDT_V2_KCC20_AMOUNT');
  return b;
}

export function encodeKcc20State({
  amount,
  owner,
  ownerScheme = KCC20_OWNER_SCHEME.P2PK_SCHNORR,
  borrowScheme = 0,
  borrowGuard = ZERO32,
  extensionCommitment = ZERO32,
}) {
  check(ownerScheme === KCC20_OWNER_SCHEME.P2PK_SCHNORR || ownerScheme === KCC20_OWNER_SCHEME.OWNER_COVENANT_ID, 'KUSDT_V2_OWNER_SCHEME');
  check(Number.isInteger(borrowScheme) && borrowScheme >= 0 && borrowScheme <= 3, 'KUSDT_V2_BORROW_SCHEME');
  return cat(
    Uint8Array.of(0x08),
    encodeOpNum2Bin8(amount),
    Uint8Array.of(0x20),
    unhex(owner, 32),
    Uint8Array.of(0x01, ownerScheme),
    Uint8Array.of(0x01, borrowScheme),
    Uint8Array.of(0x20),
    unhex(borrowGuard, 32),
    Uint8Array.of(0x20),
    unhex(extensionCommitment, 32),
  );
}

const KCC20_LEADER_TAG = unhex('79c71c23', 4);
const KCC20_DELEGATE_TAG = unhex('fd3ef14a', 4);

/** Build an Argent KCC-20 P2SH witness (leader transfer or delegate transfer_delegator).
 * When ownerScheme === P2PK_SCHNORR and sig65 is omitted, writes 65 zero bytes and returns sigOffset. */
export function buildKcc20Witness({
  nextStates = [],
  redeemBytes,
  leader = true,
  ownerScheme = KCC20_OWNER_SCHEME.P2PK_SCHNORR,
  sig65 = null,
}) {
  const redeem = typeof redeemBytes === 'string' ? unhex(redeemBytes) : redeemBytes;
  check(redeem instanceof Uint8Array && redeem.length === 34 + 112 + KCC20_SUFFIX_LEN, 'KUSDT_V2_KCC20_REDEEM_LEN');
  if (leader) {
    check(Array.isArray(nextStates) && nextStates.length >= 1 && nextStates.length <= 3, 'KUSDT_V2_KCC20_NEXT_STATES');
    const col0 = cat(...nextStates.map(s => encodeOpNum2Bin8(s.amount)));
    const col1 = cat(...nextStates.map(s => unhex(s.owner, 32)));
    const col2 = cat(...nextStates.map(s => Uint8Array.of(s.ownerScheme ?? KCC20_OWNER_SCHEME.P2PK_SCHNORR)));
    const col3 = cat(...nextStates.map(s => Uint8Array.of(s.borrowScheme ?? 0)));
    const col4 = cat(...nextStates.map(s => unhex(s.borrowGuard ?? ZERO32, 32)));
    const col5 = cat(...nextStates.map(s => unhex(s.extensionCommitment ?? ZERO32, 32)));
    const prefix = cat(pushBytes(col0), pushBytes(col1), pushBytes(col2), pushBytes(col3), pushBytes(col4), pushBytes(col5));
    let witnessArg;
    let sigOffset = null;
    if (ownerScheme === KCC20_OWNER_SCHEME.OWNER_COVENANT_ID) {
      witnessArg = Uint8Array.of(0x00);
    } else if (ownerScheme === KCC20_OWNER_SCHEME.P2PK_SCHNORR) {
      const sigBytes = sig65 ? (typeof sig65 === 'string' ? unhex(sig65, 65) : sig65) : new Uint8Array(65);
      check(sigBytes.length === 65, 'KUSDT_V2_KCC20_SIG_LEN');
      witnessArg = cat(Uint8Array.of(0x00), sigBytes);
      sigOffset = prefix.length + 2; // 1B push opcode (0x42 for 66B) + 1B PATH_NORMAL (0x00)
    } else {
      throw new Error('KUSDT_V2_OWNER_SCHEME');
    }
    const full = cat(prefix, pushBytes(witnessArg), pushBytes(KCC20_LEADER_TAG), pushBytes(redeem));
    return {scriptHex: hex(full), sigOffset};
  }
  let witnessArg;
  let sigOffset = null;
  if (ownerScheme === KCC20_OWNER_SCHEME.OWNER_COVENANT_ID) {
    witnessArg = new Uint8Array(0);
  } else if (ownerScheme === KCC20_OWNER_SCHEME.P2PK_SCHNORR) {
    const sigBytes = sig65 ? (typeof sig65 === 'string' ? unhex(sig65, 65) : sig65) : new Uint8Array(65);
    check(sigBytes.length === 65, 'KUSDT_V2_KCC20_SIG_LEN');
    witnessArg = sigBytes;
    sigOffset = 1; // 1B push opcode (0x41 for 65B)
  } else {
    throw new Error('KUSDT_V2_OWNER_SCHEME');
  }
  const full = cat(pushBytes(witnessArg), pushBytes(KCC20_DELEGATE_TAG), pushBytes(redeem));
  return {scriptHex: hex(full), sigOffset};
}

export function decodeKcc20State(raw) {
  check(raw.length === 112, 'KUSDT_V2_KCC20_STATE_LEN');
  check(raw[0] === 0x08 && raw[9] === 0x20 && raw[42] === 0x01 && raw[44] === 0x01 && raw[46] === 0x20 && raw[79] === 0x20, 'KUSDT_V2_KCC20_STATE_LAYOUT');
  return {
    amount: scriptNumber(raw.slice(1, 9)),
    owner: hex(raw.slice(10, 42)),
    ownerScheme: raw[43],
    borrowScheme: raw[45],
    borrowGuard: hex(raw.slice(47, 79)),
    extensionCommitment: hex(raw.slice(80, 112)),
  };
}

export function verifyKcc20Suffix(suffix) {
  check(suffix instanceof Uint8Array && suffix.length === KCC20_SUFFIX_LEN, 'KUSDT_V2_KCC20_SUFFIX_LEN');
  const prefix = unhex(KCC20_PREFIX_HEX);
  const h = hex(blake3(cat(le(BigInt(prefix.length), 8), prefix, le(BigInt(suffix.length), 8), suffix)));
  check(h === KCC20_EXT_TEMPLATE_HASH, 'KUSDT_V2_KCC20_TEMPLATE_HASH');
  return suffix;
}

export function extractKcc20Suffix(redeemBytes) {
  check(redeemBytes instanceof Uint8Array && redeemBytes.length === 34 + 112 + KCC20_SUFFIX_LEN, 'KUSDT_V2_KCC20_REDEEM_LEN');
  return verifyKcc20Suffix(redeemBytes.slice(34 + 112));
}

export function kcc20RedeemAndSpk(state, suffix) {
  verifyKcc20Suffix(suffix);
  const prefix = unhex(KCC20_PREFIX_HEX);
  const encoded = encodeKcc20State(state);
  const redeem = cat(prefix, encoded, suffix);
  return {redeem, scriptPubKey: p2sh(hex(blake2b256(redeem)))};
}
