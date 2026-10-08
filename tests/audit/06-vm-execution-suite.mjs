// Explicit SCRIPT_VM suite; not full transaction, maturity, mass or calibration evidence.
// Requires separately built and reviewed pinned harness. This remediation did NOT run it.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checkVmResult} from './vm-result.mjs';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import * as builders from '../../packages/f3.2-core/lib/builders.js';
import {p2pk, p2sh} from '../../packages/f3.2-core/lib/covenant-id.js';
import {hex, unhex, cat} from '../../packages/f3.2-core/lib/bytes.js';
import {blake2b256} from '../../packages/f3.2-core/lib/hashes.js';

const execFileP = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');
const vmArgs = process.argv.slice(2);
assert.equal(vmArgs.length, 2, 'Usage: node 06-vm-execution-suite.mjs --vm --manifest=/absolute/reviewed.json');
assert.equal(vmArgs[0], '--vm', 'VM_REQUIRES_EXPLICIT_FLAG');
assert.ok(vmArgs[1].startsWith('--manifest='));
const manifestPath = vmArgs[1].slice(11); assert.ok(path.isAbsolute(manifestPath));
const pin = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(pin.schema, 'KASWIN_VM_BINARY_REVIEW_1');
assert.equal(pin.consensusCommit, 'cfafeb4c093fa37a303f1b9f19c58f986b870ce3');
assert.equal(pin.compilerCommit, '3ed973335b59269293564805cc2c58a14595ec03');
assert.equal(pin.review?.status, 'APPROVED');
assert.ok(typeof pin.review.reviewer === 'string' && pin.review.reviewer.trim());
assert.ok(Number.isFinite(Date.parse(pin.review.at)));
const VM_BIN = pin.binary; assert.ok(path.isAbsolute(VM_BIN));
assert.equal(sha(await fs.readFile(VM_BIN)), pin.binarySha256, 'VM_BINARY_PIN');
assert.equal(sha(await fs.readFile(new URL('./vm/hardened_vm.rs', import.meta.url))), pin.harnessSourceSha256, 'VM_SOURCE_PIN');

const {profile} = await loadV2Bundle(CONTRACTS);
assert.equal(profile.id, pin.profileId, 'VM_PROFILE_PIN');
const passA = JSON.parse(await fs.readFile(path.join(ROOT, 'apps/kaswin-v2/test/fixtures/pass-a-public.json'), 'utf8'));
const opening = Uint8Array.from(Buffer.from(passA.openingHex, 'hex'));

const KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const OTHER_KEY = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
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

function items(sig) {
  const raw = unhex(sig), out = []; let at = 0;
  while (at < raw.length) {
    const start = at, op = raw[at++]; let n = 0;
    if (op >= 1 && op <= 75) n = op;
    else if (op >= 76 && op <= 78) {
      const w = op === 76 ? 1 : op === 77 ? 2 : 4;
      for (let j = 0; j < w; j++) n += raw[at++] * 2**(8*j);
    }
    at += n; out.push(raw.slice(start, at));
  }
  return out;
}
const join = xs => hex(cat(...xs));

const funds = [{outpoint: {transactionId: '15'.repeat(32), index: 0}, value: 1000000000n, spk: p2pk(KEY), daa: 1n}];
const dummyAcc = {blockHash: '00'.repeat(32), commit: '00'.repeat(32)};
const drawAcc = {blockHash: passA.target.hash, commit: passA.target.seqCommit};

const cases = [];

// 1. Positive: BUY
const open0 = S.newOpen(KEY, BASE_CONFIG);
const xOpen = snap(open0);
const buy = builders.buildAction(xOpen, profile, {action: 'BUY', actorKey: KEY, quantity: 2}, 1000000n, funds);
cases.push({name: 'POS_BUY', draft: buy, accessor: dummyAcc, expectedPass: true});

// 2. Positive: CLOSE EMPTY
const xEmpty = snap(open0, 100n, 600n);
const closeEmpty = builders.buildAction(xEmpty, profile, {action: 'CLOSE', actorKey: KEY}, 1000000n, funds);
cases.push({name: 'POS_CLOSE_EMPTY', draft: closeEmpty, accessor: dummyAcc, expectedPass: true});

// 3. Positive: CLOSE TO SEALED
const sold3 = S.appendPurchase(open0, 3, KEY);
const xSold3 = snap(sold3, 100n, 600n);
const closeSealed = builders.buildAction(xSold3, profile, {action: 'CLOSE', actorKey: KEY}, 1000000n, funds);
cases.push({name: 'POS_CLOSE_SEALED', draft: closeSealed, accessor: dummyAcc, expectedPass: true});

// 4. Positive: CLOSE TO REFUNDING (sold 2 < minTickets 3)
const sold2 = S.appendPurchase(open0, 2, KEY);
const xSold2 = snap(sold2, 100n, 600n);
const closeRefunding = builders.buildAction(xSold2, profile, {action: 'CLOSE', actorKey: KEY}, 1000000n, funds);
cases.push({name: 'POS_CLOSE_REFUNDING', draft: closeRefunding, accessor: dummyAcc, expectedPass: true});

// 5. Positive: DRAW_AND_PAY (sealed after 100 DAA)
const sealed = {...sold3, phase: S.Phase.SEALED};
const xSealed = snap(sealed, 580025226n, 580025327n);
const draw = builders.buildAction(xSealed, profile, {
  action: 'DRAW_AND_PAY',
  actorKey: KEY,
  opening,
  accessor: {blockHash: passA.target.hash, sequenceCommitment: passA.target.seqCommit}
}, 1000000n, []);
cases.push({name: 'POS_DRAW_AND_PAY', draft: draw, accessor: drawAcc, expectedPass: true});

// 6. Positive: TIMEOUT_REFUND (sealed after 432000 DAA)
const xTimeout = snap(sealed, 100000n, 100000n + 432000n);
const timeout = builders.buildAction(xTimeout, profile, {action: 'TIMEOUT_REFUND', actorKey: KEY}, 1000000n, funds);
cases.push({name: 'POS_TIMEOUT_REFUND', draft: timeout, accessor: dummyAcc, expectedPass: true});

// 7. Positive: REFUND
const refunding = {...sold2, phase: S.Phase.REFUNDING};
const xRefund = snap(refunding, 501n, 502n);
const refund = builders.buildAction(xRefund, profile, {action: 'REFUND', actorKey: KEY}, 100000n, []);
cases.push({name: 'POS_REFUND', draft: refund, accessor: dummyAcc, expectedPass: true});

// 8. Negative: BUY with fee witness changed (tampered fee)
const badFeeBuy = structuredClone(buy);
const wBuy = items(badFeeBuy.transaction.inputs[0].signatureScript);
wBuy[7] = builders.pushInt(500000n); // tamper fee witness
badFeeBuy.transaction.inputs[0].signatureScript = join(wBuy);
cases.push({name: 'NEG_BUY_FEE_TAMPERED', draft: badFeeBuy, accessor: dummyAcc, expectedPass: false, expectedErrors: ['VerifyError'], control: 'POS_BUY'});

// 9. Negative: TIMEOUT with sequence lock 300 < 432000
const badSeqTimeout = structuredClone(timeout);
badSeqTimeout.transaction.inputs[0].sequence = 300n;
cases.push({name: 'NEG_TIMEOUT_SEQUENCE_300', draft: badSeqTimeout, accessor: dummyAcc, expectedPass: false, expectedErrors: ['UnsatisfiedLockTime'], control: 'POS_TIMEOUT_REFUND'});

// 10. Negative: REFUND executor output diverted to another key
const badExecRefund = structuredClone(refund);
badExecRefund.transaction.outputs[badExecRefund.transaction.outputs.length - 1].scriptPublicKey = p2pk(OTHER_KEY);
cases.push({name: 'NEG_REFUND_EXECUTOR_DIVERTER', draft: badExecRefund, accessor: dummyAcc, expectedPass: false, expectedErrors: ['VerifyError'], control: 'POS_REFUND'});

const evidenceRoot = path.join(ROOT, 'tests/audit/evidence');
await fs.mkdir(evidenceRoot, {recursive: true, mode: 0o700});
const evidence = await fs.mkdtemp(path.join(evidenceRoot, 'script-vm-'));
await fs.writeFile(path.join(evidence, 'binary-review.json'), JSON.stringify(pin, null, 2), {flag: 'wx', mode: 0o600});
const summary = [];
for (const tc of cases) {
  if (tc.control && !summary.some(r => r.name === tc.control && r.passed)) {
    summary.push({name: tc.name, passed: false, error: 'POSITIVE_CONTROL_FAILED'}); continue;
  }
  const jsonPath = path.join(evidence, `${tc.name}.json`);
  const input = JSON.stringify([{name: tc.name, profileId: profile.id, draft: tc.draft, accessor: tc.accessor}], (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  await fs.writeFile(jsonPath, input, {flag: 'wx', mode: 0o600});
  let stdout = '', stderr = '', exitCode = 0, signal = null;
  try {
    const result = await execFileP(VM_BIN, ['--exact', 'test_hardened_script_vm', '--nocapture', '--test-threads=1'],
      {env: {...process.env, F3VM_CASES: jsonPath}, timeout: 120000, maxBuffer: 4 * 1024 * 1024});
    stdout = result.stdout; stderr = result.stderr;
  } catch (e) {stdout = e.stdout ?? ''; stderr = e.stderr ?? ''; exitCode = e.code ?? 1; signal = e.signal ?? null;}
  await fs.writeFile(path.join(evidence, `${tc.name}.stdout`), stdout, {flag: 'wx'});
  await fs.writeFile(path.join(evidence, `${tc.name}.stderr`), stderr, {flag: 'wx'});
  try {
    const result = checkVmResult({stdout, exitCode, signal}, tc, profile.id);
    summary.push({name: tc.name, passed: true, inputSha256: sha(input), result});
  } catch (e) {summary.push({name: tc.name, passed: false, inputSha256: sha(input), exitCode, signal, error: e.message});}
}
await fs.writeFile(path.join(evidence, 'summary.json'), JSON.stringify({scope: 'SCRIPT_VM_ONLY', defaultBudgetCalibration: 'NOT_ESTABLISHED', fullTransactionValidation: 'NOT_RUN', summary}, null, 2));
console.log(`SCRIPT_VM: ${summary.filter(r => r.passed).length}/${cases.length}; evidence ${evidence}. Not budget approval or acceptance.`);
if (summary.some(r => !r.passed)) process.exitCode = 1;
