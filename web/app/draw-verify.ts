import {ascii, blake2b256, cat, fromLe, hex, le, unhex} from '../../scripts/core.mjs';
import type {DrawVerificationProof} from './types.ts';

export interface RecomputedDrawProof {
  ok: boolean;
  seed: string;
  digest: string;
  sample: string;
  winningTicket: number;
  boundaryOk: boolean;
  rejectionOk: boolean;
}

/** Independently recompute the winning ticket from public on-chain draw inputs using BLAKE2b-256. */
export function recomputeDrawProof(p: DrawVerificationProof): RecomputedDrawProof {
  const boundary = BigInt(p.boundaryDaa);
  const sealedDaa = BigInt(p.sealedDaa);
  const parentDaa = BigInt(p.parentBlockDaa);
  const targetDaa = BigInt(p.targetBlockDaa);
  const total = BigInt(p.totalTickets);

  const seedBytes = blake2b256(cat(
    ascii(p.seedDomain),
    unhex(p.cid, 32),
    unhex(p.sealedTxid, 32),
    le(BigInt(p.sealedIndex), 4),
    le(boundary, 8),
    unhex(p.targetBlockHash, 32),
    unhex(p.sequenceCommitment, 32),
  ));
  const digestBytes = blake2b256(cat(
    ascii(p.sampleDomain),
    seedBytes,
    new Uint8Array(8),
  ));
  const sampleVal = fromLe(digestBytes.slice(0, 7));
  const winningTicket = Number(sampleVal % total) + 1;
  const space = 1n << 56n;
  const rejectionOk = !p.rejectionSampled || sampleVal < (space - (space % total));
  const boundaryOk = boundary === sealedDaa + 100n && parentDaa < boundary && targetDaa >= boundary;
  const seed = hex(seedBytes);
  const digest = hex(digestBytes);
  const sample = sampleVal.toString();
  const ok = boundaryOk
    && rejectionOk
    && seed === p.seed
    && digest === p.digest
    && sample === p.sample
    && winningTicket === p.winningTicket;
  return {ok, seed, digest, sample, winningTicket, boundaryOk, rejectionOk};
}

/** Zero-dependency Python 3 snippet so any player can verify the winning ticket outside Kaswin. */
export function buildPythonVerifyScript(p: DrawVerificationProof): string {
  const lines = [
    '# Kaswin independent draw verification (Python 3 stdlib only)',
    'import hashlib, struct',
    '',
    `cid = bytes.fromhex("${p.cid}")`,
    `sealed_txid = bytes.fromhex("${p.sealedTxid}")`,
    `sealed_index = ${p.sealedIndex}`,
    `boundary_daa = ${p.boundaryDaa}  # sealed_daa (${p.sealedDaa}) + 100`,
    `target_block_hash = bytes.fromhex("${p.targetBlockHash}")`,
    `sequence_commitment = bytes.fromhex("${p.sequenceCommitment}")`,
    `total_tickets = ${p.totalTickets}`,
    '',
    'seed = hashlib.blake2b(',
    `    b"${p.seedDomain}" + cid + sealed_txid`,
    '    + struct.pack("<IQ", sealed_index, boundary_daa)',
    '    + target_block_hash + sequence_commitment,',
    '    digest_size=32,',
    ').digest()',
    'digest = hashlib.blake2b(',
    `    b"${p.sampleDomain}" + seed + b"\\x00" * 8,`,
    '    digest_size=32,',
    ').digest()',
    'sample = int.from_bytes(digest[:7], "little")',
  ];
  if (p.rejectionSampled) {
    lines.push('space = 1 << 56');
    lines.push('assert sample < space - (space % total_tickets)');
  }
  lines.push('winning_ticket = (sample % total_tickets) + 1');
  lines.push('print("seed   =", seed.hex())');
  lines.push('print("digest =", digest.hex())');
  lines.push('print("sample =", sample)');
  lines.push('print(f"winning ticket = #{winning_ticket} / {total_tickets}")');
  lines.push(`assert winning_ticket == ${p.winningTicket}`);
  return lines.join('\n') + '\n';
}
