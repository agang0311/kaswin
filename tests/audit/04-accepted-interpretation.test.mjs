// Synthetic local cases: genesis, EMPTY close, draw and missing input context.
// accepted:true/accessor are supplied assumptions, not network acceptance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import * as builders from '../../packages/f3.2-core/lib/builders.js';
import {interpretAccepted} from '../../packages/f3.2-core/lib/accepted.js';
import {verifyGenesisAnnouncement} from '../../packages/f3.2-core/lib/genesis-discovery.js';
import {p2pk, p2sh} from '../../packages/f3.2-core/lib/covenant-id.js';
import {hex} from '../../packages/f3.2-core/lib/bytes.js';
import {blake2b256} from '../../packages/f3.2-core/lib/hashes.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');
const {profile} = await loadV2Bundle(CONTRACTS);
const passA = JSON.parse(await fs.readFile(path.join(ROOT, 'apps/kaswin-v2/test/fixtures/pass-a-public.json'), 'utf8'));
const opening = Uint8Array.from(Buffer.from(passA.openingHex, 'hex'));

const KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const ORIGIN = {transactionId: '11'.repeat(32), index: 0};
const BASE_CONFIG = {ticketPrice: 100000000n, ticketCap: 10, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 500n};

function snap(s, utxoDaa = 100n, currentDaa = 101n) {
  return {
    ledger: S.encodeLedger(s),
    tip: {transactionId: '12'.repeat(32), index: 0},
    origin: ORIGIN,
    scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(s, profile)))),
    covenantId: S.rootId(ORIGIN, S.rootScript(s, profile)),
    value: S.valueOf(s),
    utxoDaa,
    currentDaa
  };
}

test('04.1 Genesis announcement authentication', () => {
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];
  const genesis = builders.buildOpenGenesis(profile, KEY, BASE_CONFIG, funds, 1000000n);
  const out0 = genesis.transaction.outputs[0];

  const verified = verifyGenesisAnnouncement({
    accepted: true,
    payload: genesis.transaction.payload,
    authorizingOutpoint: genesis.transaction.inputs[0].previousOutpoint,
    outputIndex: 0,
    value: out0.value,
    spk: out0.scriptPublicKey,
    covenantId: out0.covenant.covenantId,
    authorizingInput: out0.covenant.authorizingInput,
    covenantOutputIndices: [0]
  }, profile);

  assert.equal(verified.phase, S.Phase.OPEN);
  assert.equal(verified.ownerKey, KEY);
  assert.equal(verified.sold, 0);
  assert.equal(verified.purchaseCount, 0);
});

test('04.2 CLOSE (EMPTY) interpretation: creator deposit returned, terminal EMPTY', () => {
  const open = S.newOpen(KEY, BASE_CONFIG);
  const x = snap(open, 100n, 600n);
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];
  const close = builders.buildAction(x, profile, {action: 'CLOSE', actorKey: KEY}, 1000000n, funds);

  const interp = interpretAccepted(x, profile, close.transaction, [x.value, 1000000000n]);
  assert.equal(interp.action, 'CLOSE');
  assert.equal(interp.terminal, 'EMPTY');
  assert.equal(interp.next, null);

  const creatorOut = interp.outputs.find(o => o.role === 'CREATOR');
  assert.ok(creatorOut);
  assert.equal(creatorOut.value, S.DEPOSIT);
});

test('04.3 DRAW_AND_PAY interpretation: atomic winner prize, creator deposit, executor bounty', () => {
  const sold = S.appendPurchase(S.newOpen(KEY, BASE_CONFIG), 3, KEY);
  const sealed = {...sold, phase: S.Phase.SEALED};
  const x = snap(sealed, 580025226n, 580025327n);
  const draw = builders.buildAction(x, profile, {
    action: 'DRAW_AND_PAY',
    actorKey: KEY,
    opening,
    accessor: {blockHash: passA.target.hash, sequenceCommitment: passA.target.seqCommit}
  }, 1000000n, []);

  const interp = interpretAccepted(x, profile, draw.transaction, [x.value]);
  assert.equal(interp.action, 'DRAW_AND_PAY');
  assert.equal(interp.terminal, 'PAID');
  assert.ok(interp.winner);

  const roles = interp.outputs.map(o => o.role);
  assert.deepEqual(roles, ['WINNER', 'CREATOR', 'EXECUTOR']);
});

test('04.4 Missing funding context when multiple inputs present throws INPUT_VALUES_REQUIRED', () => {
  const open = S.newOpen(KEY, BASE_CONFIG);
  const x = snap(open);
  const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];
  const buy = builders.buildAction(x, profile, {action: 'BUY', actorKey: KEY, quantity: 1}, 1000000n, funds);

  // Calling interpretAccepted without inputValues when tx has 2 inputs:
  assert.throws(() => {
    interpretAccepted(x, profile, buy.transaction);
  }, /INPUT_VALUES_REQUIRED/, 'Multi-input spend without inputValues context must fail closed');
});
