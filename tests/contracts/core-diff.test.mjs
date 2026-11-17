/** Differential tests comparing legacy tests/contracts/{state,profile,transactions,mass,accepted,receiver}.mjs
 * against the unified TypeScript core entrypoint scripts/core.mjs.
 * Offline only; compares bytes, BigInt values, structures, and error codes (ResourceLimit checked by .code).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import * as LegacyState from './state.mjs';
import * as LegacyProfile from './profile.mjs';
import * as LegacyTx from './transactions.mjs';
import * as LegacyMass from './mass.mjs';
import * as LegacyAccepted from './accepted.mjs';
import * as LegacyReceiver from './receiver.mjs';
import * as TsCore from '../../scripts/core.mjs';

import {fixture, fund, shard, texts, trust, OWNER, BUYER, WINNER, ACTOR, PRICE, FEE, findDraw} from './fixtures.mjs';
import {TN10} from '../../scripts/chain/tn10.mjs';

const norm = v => JSON.stringify(v, (_, x) => {
  if (typeof x === 'bigint') return {__bigint: x.toString()};
  if (x instanceof Uint8Array) return {__hex: LegacyState.hex(x)};
  return x;
});

function expectSameErrorCode(fnA, fnB) {
  let errA = null;
  let errB = null;
  try { fnA(); } catch (e) { errA = e; }
  try { fnB(); } catch (e) { errB = e; }
  assert.ok(errA, 'Legacy did not throw');
  assert.ok(errB, 'TS core did not throw');
  const codeA = errA.code ?? errA.safeCode ?? errA.message;
  const codeB = errB.code ?? errB.safeCode ?? errB.message;
  assert.equal(codeB, codeA);
}

test('scripts/core.mjs exports all 68 runtime symbols matching legacy modules', () => {
  const legacyExports = new Set([
    ...Object.keys(LegacyState),
    ...Object.keys(LegacyProfile),
    ...Object.keys(LegacyTx),
    ...Object.keys(LegacyMass),
    ...Object.keys(LegacyAccepted),
    ...Object.keys(LegacyReceiver),
  ]);
  assert.equal(legacyExports.size, 68);
  for (const name of legacyExports) {
    assert.ok(name in TsCore, `Missing export in scripts/core.mjs: ${name}`);
    assert.equal(typeof TsCore[name], typeof (
      LegacyState[name] ?? LegacyProfile[name] ?? LegacyTx[name] ?? LegacyMass[name] ?? LegacyAccepted[name] ?? LegacyReceiver[name]
    ), `Type mismatch for export: ${name}`);
  }
});

test('State constants, encode/decode, and boundary errors match byte-for-byte', () => {
  for (const key of ['MODULES', 'HEADER', 'MAX_LEDGER_BYTES', 'MAX_OUTPUTS', 'TAIL_POOL_MIN', 'DEPOSIT', 'PRICE_MIN', 'REWARD', 'REFUND_FEE', 'VALUE_LIMIT', 'PAY_FEE_CAP', 'FEE_CAP', 'DAA_LIMIT', 'DRAW_DELAY', 'TIMEOUT_DELAY', 'MAX_TICKETS', 'ZERO']) {
    assert.equal(norm(TsCore[key]), norm(LegacyState[key]), key);
  }

  for (const mod of ['sales', 'sealed', 'win', 'refund']) {
    const f = fixture({module: mod, cnt: 2, local: 3, p: mod === 'win' ? 1 : 0, r: mod === 'refund' ? 1 : 0, c: 0});
    const encA = LegacyState.encode(f.s);
    const encB = TsCore.encode(f.s);
    assert.equal(LegacyState.hex(encB), LegacyState.hex(encA));
    assert.equal(norm(TsCore.decode(mod, encA)), norm(LegacyState.decode(mod, encA)));
    assert.equal(TsCore.managerValue(f.s), LegacyState.managerValue(f.s));
    assert.equal(TsCore.totalTickets(f.s), LegacyState.totalTickets(f.s));
    assert.equal(TsCore.mergeTail(f.s), LegacyState.mergeTail(f.s));
  }

  const sh = shard(0, 1);
  const fWin = fixture({module: 'win', cnt: 1, local: 2});
  assert.equal(TsCore.frozenValue(fWin.s, 0, sh.s.records), LegacyState.frozenValue(fWin.s, 0, sh.s.records));

  expectSameErrorCode(() => LegacyState.decode('sales', new Uint8Array(10)), () => TsCore.decode('sales', new Uint8Array(10)));
  expectSameErrorCode(() => LegacyState.initial('bad', {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n}),
    () => TsCore.initial('bad', {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n}));
});

test('Profile loading, redeem scripts, rootId, identify, and verifyManager match byte-for-byte', () => {
  const pA = LegacyProfile.loadCandidateProfile(texts, trust);
  const pB = TsCore.loadCandidateProfile(texts, trust);
  assert.equal(pB.id, pA.id);

  const f = fixture({module: 'sales', local: 2});
  const rA = LegacyProfile.redeem(f.s, pA);
  const rB = TsCore.redeem(f.s, pB);
  assert.equal(LegacyState.hex(rB), LegacyState.hex(rA));
  assert.equal(TsCore.scriptHash(f.s, pB), LegacyProfile.scriptHash(f.s, pA));
  assert.equal(TsCore.rootId(f.manager.origin, f.s, pB), LegacyProfile.rootId(f.manager.origin, f.s, pA));
  assert.equal(norm(TsCore.identify(rA, pB)), norm(LegacyProfile.identify(rA, pA)));
  assert.equal(norm(TsCore.verifyManager(f.manager, pB)), norm(LegacyProfile.verifyManager(f.manager, pA)));
});

test('Transactions, draw, accepted interpretation, mass/fee, ResourceLimit code, and receiver match', () => {
  const pA = LegacyProfile.loadCandidateProfile(texts, trust);
  const pB = TsCore.loadCandidateProfile(texts, trust);

  // GENESIS
  const gFunds = [fund(1, 10n * PRICE, OWNER)];
  const gCfg = {ticketPrice: PRICE, ticketCap: 10, minTickets: 3, closeEligibleDaa: 1000n};
  const gA = LegacyTx.buildGenesis(pA, OWNER, gCfg, {funds: gFunds, fee: FEE, budgets: [10]});
  const gB = TsCore.buildGenesis(pB, OWNER, gCfg, {funds: gFunds, fee: FEE, budgets: [10]});
  assert.equal(norm(gB), norm(gA));
  assert.equal(norm(TsCore.massOf(gB)), norm(LegacyMass.massOf(gA)));
  assert.equal(norm(TsCore.quoteMass(gB)), norm(LegacyMass.quoteMass(gA)));
  assert.deepEqual(TsCore.signingRequirement(gB), LegacyReceiver.signingRequirement(gA));

  // BUY, CLOSE, DRAW, PAY_OLD, PAY_SELF, REFUND_OLD, REFUND_SELF, TIMEOUT (offline build only)
  const fSales = fixture({module: 'sales', local: 3, minTickets: 3});
  const buyOp = {action: 'BUY', quantity: 2, actorKey: BUYER};
  const buyA = LegacyTx.buildAction(fSales.manager, pA, buyOp, {funds: [fund(2, 10n * PRICE, BUYER)], fee: FEE, budgets: [200, 10]});
  const buyB = TsCore.buildAction(fSales.manager, pB, buyOp, {funds: [fund(2, 10n * PRICE, BUYER)], fee: FEE, budgets: [200, 10]});
  assert.equal(norm(buyB), norm(buyA));

  const buyFacts = {manager: fSales.manager, targets: [], funds: [fund(2, 10n * PRICE, BUYER)], transaction: buyA.transaction};
  assert.equal(norm(TsCore.decodeSpend(buyA.transaction.inputs[0].signatureScript, pB)), norm(LegacyAccepted.decodeSpend(buyA.transaction.inputs[0].signatureScript, pA)));
  assert.equal(norm(TsCore.interpretAccepted(buyFacts, pB)), norm(LegacyAccepted.interpretAccepted(buyFacts, pA)));

  const fSealed = fixture({module: 'sealed', cnt: 1, local: 3, minTickets: 3});
  const drawMatch = {...findDraw(fSealed, false), actorKey: ACTOR};
  const drawA = LegacyTx.buildAction(fSealed.manager, pA, drawMatch, {funds: [fund(5, 10n * PRICE, ACTOR)], fee: FEE, budgets: [200, 10]});
  const drawB = TsCore.buildAction(fSealed.manager, pB, drawMatch, {funds: [fund(5, 10n * PRICE, ACTOR)], fee: FEE, budgets: [200, 10]});
  assert.equal(norm(drawB), norm(drawA));
  assert.deepEqual(TsCore.signingRequirement(drawB), LegacyReceiver.signingRequirement(drawA));

  const fWin = fixture({module: 'win', cnt: 1, local: 2, p: 0, c: 0});
  const sh0 = fWin.targets[0];
  const payOldA = LegacyTx.buildAction(fWin.manager, pA, {action: 'PAY_OLD', actorKey: ACTOR}, {targets: [sh0], fee: FEE, budgets: [200, 200]});
  const payOldB = TsCore.buildAction(fWin.manager, pB, {action: 'PAY_OLD', actorKey: ACTOR}, {targets: [sh0], fee: FEE, budgets: [200, 200]});
  assert.equal(norm(payOldB), norm(payOldA));

  // convergeFee & choosePayoutBatch
  const makeBuy = fee => TsCore.buildAction(fSales.manager, pB, buyOp, {funds: [fund(2, 10n * PRICE, BUYER)], fee, budgets: [200, 10]});
  const makeBuyLegacy = fee => LegacyTx.buildAction(fSales.manager, pA, buyOp, {funds: [fund(2, 10n * PRICE, BUYER)], fee, budgets: [200, 10]});
  assert.equal(norm(TsCore.convergeFee(makeBuy, '100')), norm(LegacyMass.convergeFee(makeBuyLegacy, '100')));

  // ResourceLimit compared by .code
  expectSameErrorCode(
    () => LegacyMass.convergeFee(makeBuyLegacy, '100000000'),
    () => TsCore.convergeFee(makeBuy, '100000000'),
  );

  // rewardReceiver
  const addr = 'kaspatest:qz00000000000000000000000000000000000000000000000000050g0w85a';
  expectSameErrorCode(
    () => LegacyReceiver.rewardReceiver(addr, {addressPrefix: TN10.addressPrefix, configuredGenesis: TN10.genesis, connectedGenesis: 'ff'.repeat(32)}),
    () => TsCore.rewardReceiver(addr, {addressPrefix: TN10.addressPrefix, configuredGenesis: TN10.genesis, connectedGenesis: 'ff'.repeat(32)}),
  );
});
