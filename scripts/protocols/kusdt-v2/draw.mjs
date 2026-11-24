/** Kaswin kUSDT v2 DRAW randomness sampling, winner resolution, and node-authenticated DRAW verification.
 * Mirrors contracts/kusdt-v2/m_sealed.sil byte-for-byte. */
import {blake2b256, cat, check, DAA_LIMIT, fromLe, hex, le, scriptNumber, scriptPushes, unhex} from '../../core.mjs';
import {domainHash} from '../../core/lib/blake3.js';
import {acceptedAt} from '../../chain/chain.mjs';
import {DRAW_DELAY_DAA, MIN_DRAW_TICKETS, REROLL_TIMEOUT_DAA, STAGE} from './constants.mjs';
import {decodeShardOpenOrFrozenState} from './codec.mjs';
import {encodeKusdtV2State, verifyKusdtV2Redeem} from './profile.mjs';

const HASH64 = /^[0-9a-f]{64}$/;
const ASCII_DRAW_V1 = new TextEncoder().encode('KASWIN_KUSDT_DRAW_V1');
const ASCII_SAMPLE_V1 = new TextEncoder().encode('KASWIN_KUSDT_SAMPLE_V1');

function openingInt(proof, offset) {
  const n = fromLe(proof.slice(offset, offset + 8));
  check(n < (1n << 63n), 'PROOF_INTEGER');
  return n;
}

function openSeq(proof, base, parent) {
  const branch = (a, b) => domainHash('SeqCommitmentMerkleBranchHash', cat(a, b));
  return branch(
    parent,
    branch(
      proof.slice(base, base + 32),
      branch(domainHash('SeqCommitMergesetContext', proof.slice(base + 64, base + 88)), proof.slice(base + 32, base + 64)),
    ),
  );
}

/** Verify 240B PASS-A proof against accessor and compute 0-based winning ticket index in [0, totalTickets). */
export function kusdtDrawSample({cid, outpoint, utxoDaa, currentDaa, totalTickets, proof, accessor}) {
  check(proof instanceof Uint8Array && proof.length === 240 && accessor, 'DRAW_PROOF');
  check(Number.isInteger(totalTickets) && totalTickets >= MIN_DRAW_TICKETS, 'DRAW_MIN_TICKETS');
  const d = BigInt(utxoDaa);
  const cur = BigInt(currentDaa);
  check(d >= 0n && d < DAA_LIMIT - REROLL_TIMEOUT_DAA && cur >= d + DRAW_DELAY_DAA, 'DRAW_MATURITY');
  const boundary = d + DRAW_DELAY_DAA;
  const td = openingInt(proof, 104);
  check(openingInt(proof, 224) < boundary && td >= boundary && td < DAA_LIMIT, 'FIRST_CROSSING');
  check(openingInt(proof, 112) > openingInt(proof, 232), 'BLUE_ORDER');
  openingInt(proof, 96);
  openingInt(proof, 216);
  const seq1 = openSeq(proof, 152, proof.slice(120, 152));
  const seq = openSeq(proof, 32, seq1);
  const target = hex(proof.slice(0, 32));
  check(accessor.blockHash === target && accessor.sequenceCommitment === hex(seq), 'CHAIN_ACCESSOR');
  const seed = blake2b256(cat(
    ASCII_DRAW_V1,
    unhex(cid, 32),
    unhex(outpoint.transactionId, 32),
    le(BigInt(outpoint.index), 4),
    le(boundary, 8),
    proof.slice(0, 32),
    seq,
  ));
  const digest = blake2b256(cat(ASCII_SAMPLE_V1, seed, new Uint8Array(8)));
  const sample = fromLe(digest.slice(0, 7));
  const ticket = Number(sample % BigInt(totalTickets));
  return {ticket, seed: hex(seed), proof, targetHash: target, sequenceCommitment: hex(seq)};
}

/** Locate the winning (shardIndex, recordIndex) and verify the S_FROZEN preimage against mgrState.entries[j].ledgerHash. */
export function resolveKusdtDrawWinner(mgrState, shards, ticket, profile) {
  check(mgrState?.stage === STAGE.M_SEALED && Array.isArray(mgrState.entries) && mgrState.entries.length > 0, 'KUSDT_V2_NOT_SEALED');
  check(Number.isInteger(ticket) && ticket >= 0 && ticket < mgrState.totalTickets, 'DRAW_TICKET_RANGE');
  const shardIndex = mgrState.entries.findIndex(e => ticket < e.cumTickets);
  check(shardIndex >= 0, 'DRAW_SHARD_INDEX');
  const start = shardIndex === 0 ? 0 : mgrState.entries[shardIndex - 1].cumTickets;
  const end = mgrState.entries[shardIndex].cumTickets;
  check(start <= ticket && ticket < end, 'DRAW_SHARD_RANGE');
  const entry = mgrState.entries[shardIndex];
  const sh = Array.isArray(shards) ? shards.find(s => s?.shardCid === entry.shardCid) : null;
  const rawRedeem = sh?.frozenRedeem ?? sh?.redeem ?? null;
  check(rawRedeem, 'DRAW_SHARD_PREIMAGE_MISSING');
  const redeemBytes = typeof rawRedeem === 'string' ? unhex(rawRedeem) : rawRedeem;
  const frozenState = verifyKusdtV2Redeem(redeemBytes, profile, 'shard').state;
  check(frozenState.stage === STAGE.S_FROZEN, 'DRAW_SHARD_NOT_FROZEN');
  const encodedFrozen = encodeKusdtV2State(frozenState);
  check(hex(blake2b256(encodedFrozen)) === entry.ledgerHash, 'DRAW_LEDGER_HASH');
  const recs = frozenState.records;
  check(Array.isArray(recs) && recs.length > 0 && recs[recs.length - 1].cumTickets === end - start, 'DRAW_SHARD_TICKETS');
  const localT = ticket - start;
  const recordIndex = recs.findIndex(r => localT < r.cumTickets);
  check(recordIndex >= 0, 'DRAW_RECORD_INDEX');
  const before = recordIndex === 0 ? 0 : recs[recordIndex - 1].cumTickets;
  const after = recs[recordIndex].cumTickets;
  check(before <= localT && localT < after, 'DRAW_RECORD_RANGE');
  return {
    shardIndex,
    recordIndex,
    shardCid: entry.shardCid,
    frozenShardState: frozenState,
    winnerPk: recs[recordIndex].buyerPk,
  };
}

/** Extract node-authenticated kUSDT v2 DRAW winning shard/record/ticket directly from the DRAW tx witness & target block. */
export async function verifyKusdtDrawReceipt(round, rpc, profile) {
  const drawRc = round?.receipts?.find(x =>
    x?.action === 'DRAW'
    && typeof x.acceptingBlock === 'string' && HASH64.test(x.acceptingBlock)
    && typeof x.txid === 'string' && HASH64.test(x.txid)
  );
  if (!drawRc) return null;
  const ev = await acceptedAt(rpc, drawRc.txid, drawRc.acceptingBlock);
  const tx = ev.tx;
  const pushes = scriptPushes(unhex(String(tx.inputs[0].signatureScript ?? '').toLowerCase()));
  check(pushes.length >= 6, 'DRAW_WITNESS');
  check(scriptNumber(pushes[0]) === 1n, 'INDEXER_DRAW_ACTION');
  const mgrRedeem = pushes[pushes.length - 1];
  const mgrState = verifyKusdtV2Redeem(mgrRedeem, profile, 'manager').state;
  check(mgrState.stage === STAGE.M_SEALED, 'KUSDT_V2_NOT_SEALED');
  const data = pushes[3];
  check(data instanceof Uint8Array && data.length > 244, 'DRAW_DATA_LEN');
  const proof = data.slice(0, 240);
  const shard = Number(fromLe(data.slice(240, 242)));
  const record = Number(fromLe(data.slice(242, 244)));
  const frozenBytes = data.slice(244);
  check(shard >= 0 && shard < mgrState.entries.length, 'DRAW_SHARD_INDEX');
  check(hex(blake2b256(frozenBytes)) === mgrState.entries[shard].ledgerHash, 'DRAW_LEDGER_HASH');
  const frozen = decodeShardOpenOrFrozenState(frozenBytes);
  check(frozen.stage === STAGE.S_FROZEN && record >= 0 && record < frozen.records.length, 'DRAW_RECORD_INDEX');
  const targetHash = hex(proof.slice(0, 32));
  const tb = (await rpc.call('getBlock', {hash: targetHash, includeTransactions: false}))?.block;
  check(tb?.header?.hash === targetHash && tb.verboseData?.isChainBlock === true, 'DRAW_TARGET_NOT_CHAIN');
  const sample = kusdtDrawSample({
    cid: round.cid,
    outpoint: tx.inputs[0].previousOutpoint,
    utxoDaa: ev.inputs[0].daa,
    currentDaa: ev.acceptingDaa,
    totalTickets: mgrState.totalTickets,
    proof,
    accessor: {blockHash: targetHash, sequenceCommitment: tb.header.acceptedIdMerkleRoot},
  });
  const start = shard === 0 ? 0 : mgrState.entries[shard - 1].cumTickets;
  const localT = sample.ticket - start;
  const before = record === 0 ? 0 : frozen.records[record - 1].cumTickets;
  const after = frozen.records[record].cumTickets;
  check(localT >= before && localT < after, 'DRAW_WINNING_RECORD_MISMATCH');
  return {txid: drawRc.txid, shard, record, ticket: sample.ticket};
}
