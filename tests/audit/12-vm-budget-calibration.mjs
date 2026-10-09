// VM budget calibration for the pinned V2 Profile. SCRIPT_VM only: measures script units per input under the
// web/builder default computeBudget, for every reachable (action, directory size, refund cursor) the budget gate requires,
// plus worst-case funding-input counts. No network, wallet, signing of real keys, or broadcast.
//
// Usage: node tests/audit/12-vm-budget-calibration.mjs --vm --manifest=/abs/binary-review.json [--out=/abs/dir] [--quick]
//   --quick : boundary sample only (directory sizes 0,1,2,31,32,33,63,64,65,127,128,129,254,255,256), for fast iteration.
// Output: <out>/cases.json, <out>/results.jsonl, <out>/summary.json, <out>/budget-evidence.candidate.json
// The candidate evidence file is NOT approved by this script; review and pinning are separate, explicit steps.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadV2Bundle, sha256 as fileSha} from '../../contracts/f3.2/tools/linking.mjs';
import * as S from '../../packages/f3.2-core/lib/state.js';
import * as P from '../../packages/f3.2-core/lib/protocol.js';
import * as builders from '../../packages/f3.2-core/lib/builders.js';
import {p2pk, p2sh} from '../../packages/f3.2-core/lib/covenant-id.js';
import {hex} from '../../packages/f3.2-core/lib/bytes.js';
import {blake2b256} from '../../packages/f3.2-core/lib/hashes.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');
const sha = b => createHash('sha256').update(b).digest('hex');
const args = process.argv.slice(2);
assert.equal(args[0], '--vm', 'VM_REQUIRES_EXPLICIT_FLAG');
const opt = Object.fromEntries(args.slice(1).map(a => { const m = /^--([a-z]+)(?:=(.*))?$/.exec(a); assert.ok(m, 'BAD_ARG ' + a); return [m[1], m[2] ?? true]; }));
assert.ok(typeof opt.manifest === 'string' && path.isAbsolute(opt.manifest), 'ABSOLUTE_MANIFEST_REQUIRED');
for (const k of Object.keys(opt)) assert.ok(['manifest', 'out', 'quick'].includes(k), 'UNKNOWN_ARG ' + k);

// ---------- pinned binary ----------
const pin = JSON.parse(await fs.readFile(opt.manifest, 'utf8'));
assert.equal(pin.schema, 'KASWIN_VM_BINARY_REVIEW_1');
assert.equal(pin.consensusCommit, 'cfafeb4c093fa37a303f1b9f19c58f986b870ce3');
assert.equal(pin.compilerCommit, '3ed973335b59269293564805cc2c58a14595ec03');
assert.equal(pin.review?.status, 'APPROVED');
assert.equal(sha(await fs.readFile(pin.binary)), pin.binarySha256, 'VM_BINARY_PIN');
assert.equal(sha(await fs.readFile(new URL('./vm/hardened_vm.rs', import.meta.url))), pin.harnessSourceSha256, 'VM_SOURCE_PIN');
const {profile, pins} = await loadV2Bundle(CONTRACTS);
assert.equal(profile.id, pin.profileId, 'VM_PROFILE_PIN');

// ---------- synthetic, public inputs ----------
const passA = JSON.parse(await fs.readFile(path.join(ROOT, 'apps/kaswin-v2/test/fixtures/pass-a-public.json'), 'utf8'));
const opening = Uint8Array.from(Buffer.from(passA.openingHex, 'hex'));
const KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'; // secret scalar 1 (public test key)
const buyerKey = i => hex(blake2b256(new TextEncoder().encode('kaswin-vm-buyer-' + i)));   // 32-byte x-only stand-ins; directory bytes only
const ORIGIN = {transactionId: '11'.repeat(32), index: 0};
const TIP = {transactionId: '12'.repeat(32), index: 0};
const ZERO_ACC = {blockHash: '00'.repeat(32), commit: '00'.repeat(32)};
const DRAW_ACC = {blockHash: passA.target.hash, commit: passA.target.seqCommit};
const DRAW_UTXO_DAA = BigInt(passA.boundaryDaa) - S.DRAW_DELAY, DRAW_NOW = BigInt(passA.target.daa);
const FEE = 1_000_000n;
const fund = (i, value = 1_000_000_000_000n) => ({outpoint: {transactionId: hex(blake2b256(new TextEncoder().encode('fund-' + i))), index: 0}, value, spk: p2pk(KEY), daa: 1n});
const funds = n => Array.from({length: n}, (_, i) => fund(i, n === 1 ? 1_000_000_000_000n : 200_000_000_000n));

function snap(s, utxoDaa, currentDaa) {
  return {ledger: S.encodeLedger(s), tip: TIP, origin: ORIGIN, scriptPublicKey: p2sh(hex(blake2b256(S.scriptOf(s, profile)))),
    covenantId: S.rootId(ORIGIN, S.rootScript(s, profile)), value: S.valueOf(s), utxoDaa, currentDaa};
}
/** OPEN ledger with `pc` purchase records and `sold` tickets (sold >= pc), ticketCap/minTickets chosen per case. */
function openLedger(pc, sold, {ticketCap = Math.max(sold, 3, 256), minTickets = 3} = {}) {
  ticketCap = Math.max(ticketCap, minTickets, sold);
  let s = S.newOpen(KEY, {ticketPrice: 100_000_000n, ticketCap, purchaseCap: 256, minTickets, closeEligibleDaa: 500n});
  for (let i = 0; i < pc; i++) s = S.appendPurchase(s, i < pc - 1 ? 1 : sold - (pc - 1), buyerKey(i));
  return s;
}
const recordOf = s => S.records(s);

// ---------- case matrix (mirrors contracts/f3.2/tools/budget-gate.mjs requiredCases) ----------
const QUICK = [0, 1, 2, 31, 32, 33, 63, 64, 65, 127, 128, 129, 254, 255, 256];
const sizes = opt.quick ? QUICK : Array.from({length: 257}, (_, i) => i);
const cases = [];
const add = (pathName, ledger, draft, accessor, extra = {}) => cases.push({pathName, ledger, draft, accessor, ...extra});

// GENESIS has no covenant input script; its default budget only covers the P2PK funding signature.
for (const n of [1, 8]) {
  const config = {ticketPrice: 100_000_000n, ticketCap: 256, purchaseCap: 256, minTickets: 3, closeEligibleDaa: 500n};
  add('GENESIS', null, builders.buildOpenGenesis(profile, KEY, config, funds(n), FEE), ZERO_ACC, {fundingInputs: n});
}
for (const pc of sizes) {
  // BUY at directory size pc (0..255), worst-case funding counts at the boundaries.
  if (pc < 256) for (const n of (opt.quick || [0, 255].includes(pc) ? [1, 8] : [1])) {
    const s = openLedger(pc, pc);
    add('BUY', s, builders.buildAction(snap(s, 100n, 101n), profile, {action: 'BUY', actorKey: KEY, quantity: 1}, FEE, funds(n)), ZERO_ACC, {fundingInputs: n});
  }
  if (pc === 0) {
    const s = openLedger(0, 0);
    add('CLOSE_EMPTY', s, builders.buildAction(snap(s, 100n, 600n), profile, {action: 'CLOSE', actorKey: KEY}, FEE, funds(1)), ZERO_ACC, {fundingInputs: 1});
    continue;
  }
  // CLOSE -> SEALED (sold >= minTickets) and CLOSE -> REFUNDING (sold < minTickets).
  { const s = openLedger(pc, Math.max(pc, 3), {minTickets: 3});
    add('CLOSE_SEALED', s, builders.buildAction(snap(s, 100n, 600n), profile, {action: 'CLOSE', actorKey: KEY}, FEE, funds(1)), ZERO_ACC, {fundingInputs: 1}); }
  { const s = openLedger(pc, pc + 1, {minTickets: pc + 2});
    add('CLOSE_REFUNDING', s, builders.buildAction(snap(s, 100n, 600n), profile, {action: 'CLOSE', actorKey: KEY}, FEE, funds(1)), ZERO_ACC, {fundingInputs: 1}); }
  // SEALED actions.
  { const s = {...openLedger(pc, Math.max(pc, 3)), phase: S.Phase.SEALED};
    // DRAW_AND_PAY: the public PASS-A fixture fixes the seed inputs except the ledger; scan the sold count for a non-rejected sample.
    let d = null;
    for (let extra = 0; extra < 64 && !d; extra++) {
      const t = {...openLedger(pc, Math.max(pc, 3) + extra, {ticketCap: Math.max(pc, 3) + 64}), phase: S.Phase.SEALED};
      try { d = {s: t, draft: builders.buildAction(snap(t, DRAW_UTXO_DAA, DRAW_NOW), profile, {action: 'DRAW_AND_PAY', actorKey: KEY, opening, accessor: {blockHash: passA.target.hash, sequenceCommitment: passA.target.seqCommit}}, FEE, [])}; }
      catch (e) { if (!/SAMPLE_REJECTED/.test(String(e?.code ?? e?.message))) throw e; }
    }
    assert.ok(d, 'NO_ACCEPTED_SAMPLE ' + pc);
    add('DRAW_AND_PAY', d.s, d.draft, DRAW_ACC, {fundingInputs: 0});
    for (const n of (opt.quick || pc === 256 ? [1, 8] : [1]))
      add('TIMEOUT_REFUND', s, builders.buildAction(snap(s, 100_000n, 100_000n + S.TIMEOUT_DELAY), profile, {action: 'TIMEOUT_REFUND', actorKey: KEY}, FEE, funds(n)), ZERO_ACC, {fundingInputs: n});
  }
  // REFUNDING: every batch start cursor (multiples of 32), no external funding (fee from the executor pool).
  for (let cursor = 0; cursor < pc; cursor += 32) {
    const s = {...openLedger(pc, pc), phase: S.Phase.REFUNDING, cursor};
    const k = Math.min(32, pc - cursor), fee = BigInt(k) * S.REFUND_FEE > FEE ? FEE : BigInt(k) * S.REFUND_FEE - 1n;
    const name = pc - cursor <= 32 ? 'REFUND_FINAL' : 'REFUND_INTERMEDIATE';
    add(name, s, builders.buildAction(snap(s, 501n, 502n), profile, {action: 'REFUND', actorKey: KEY}, fee, []), ZERO_ACC, {fundingInputs: 0});
    if (cursor === 0 && (opt.quick || pc === 256)) { // sponsored variant: one external input (engine fallback path)
      add(name, s, builders.buildAction(snap(s, 501n, 502n), profile, {action: 'REFUND', actorKey: KEY}, FEE, funds(1)), ZERO_ACC, {fundingInputs: 1, sponsored: true});
    }
  }
}

// ---------- value-magnitude stress: realistic/maximal numbers (wider pushes) at small and boundary directory sizes ----------
// TN10/mainnet DAA ~6e8, max fee 0.5 KAS, 8 funding inputs, large ticket price. Script units grow with pushed bytes,
// so the tiny DAA/price values above are not a worst case.
const STRESS = opt.quick ? [1, 4, 256] : [0, 1, 2, 3, 4, 5, 6, 8, 12, 16, 31, 32, 33, 63, 64, 65, 71, 72, 128, 255, 256];
const BIG_DAA = 600_000_000n, MAX_FEE = 50_000_000n;
function bigLedger(pc, sold, minTickets = 3) {
  const ticketCap = Math.max(sold, minTickets, 256), price = (S.VALUE_LIMIT - S.DEPOSIT) / BigInt(ticketCap) / 4n; // large but within contract limits
  let s = S.newOpen(KEY, {ticketPrice: price, ticketCap, purchaseCap: 256, minTickets, closeEligibleDaa: BIG_DAA});
  for (let i = 0; i < pc; i++) s = S.appendPurchase(s, i < pc - 1 ? 1 : sold - (pc - 1), buyerKey(i));
  return s;
}
const bigFunds = n => Array.from({length: n}, (_, i) => fund(1000 + i, (S.VALUE_LIMIT - 1n) / 9n));
for (const pc of STRESS) {
  const tag = {fundingInputs: 8, stress: true};
  if (pc < 256) { const s = bigLedger(pc, pc);
    add('BUY', s, builders.buildAction(snap(s, BIG_DAA, BIG_DAA + 1n), profile, {action: 'BUY', actorKey: KEY, quantity: 1}, MAX_FEE, bigFunds(8)), ZERO_ACC, tag); }
  if (pc === 0) { const s = bigLedger(0, 0);
    add('CLOSE_EMPTY', s, builders.buildAction(snap(s, BIG_DAA, BIG_DAA + 10n), profile, {action: 'CLOSE', actorKey: KEY}, MAX_FEE, bigFunds(8)), ZERO_ACC, tag); continue; }
  { const s = bigLedger(pc, Math.max(pc, 3));
    add('CLOSE_SEALED', s, builders.buildAction(snap(s, BIG_DAA, BIG_DAA + 10n), profile, {action: 'CLOSE', actorKey: KEY}, MAX_FEE, bigFunds(8)), ZERO_ACC, tag); }
  { const s = bigLedger(pc, pc + 1, pc + 2);
    add('CLOSE_REFUNDING', s, builders.buildAction(snap(s, BIG_DAA, BIG_DAA + 10n), profile, {action: 'CLOSE', actorKey: KEY}, MAX_FEE, bigFunds(8)), ZERO_ACC, tag); }
  { const s = {...bigLedger(pc, Math.max(pc, 3)), phase: S.Phase.SEALED};
    add('TIMEOUT_REFUND', s, builders.buildAction(snap(s, BIG_DAA, BIG_DAA + S.TIMEOUT_DELAY), profile, {action: 'TIMEOUT_REFUND', actorKey: KEY}, MAX_FEE, bigFunds(8)), ZERO_ACC, tag); }
  for (const cursor of [0, Math.floor((pc - 1) / 32) * 32].filter((v, i, a) => a.indexOf(v) === i)) {
    const s = {...bigLedger(pc, pc), phase: S.Phase.REFUNDING, cursor};
    add(pc - cursor <= 32 ? 'REFUND_FINAL' : 'REFUND_INTERMEDIATE', s, builders.buildAction(snap(s, BIG_DAA, BIG_DAA + 1n), profile, {action: 'REFUND', actorKey: KEY}, MAX_FEE, bigFunds(1)), ZERO_ACC, {fundingInputs: 1, sponsored: true, stress: true});
  }
}

// ---------- run (batched; one harness process per batch) ----------
const out = opt.out ?? path.join(ROOT, 'tests/audit/evidence', 'vm-budget-' + new Date().toISOString().replace(/[:.]/g, '-'));
assert.ok(path.isAbsolute(out));
await fs.mkdir(out, {recursive: true, mode: 0o700});
const ser = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v);
const named = cases.map((c, i) => ({...c, name: `${String(i).padStart(4, '0')}-${c.pathName}-pc${c.ledger?.purchaseCount ?? 0}-c${c.ledger?.cursor ?? 0}-f${c.fundingInputs}${c.sponsored ? '-sp' : ''}${c.stress ? '-big' : ''}`}));
await fs.writeFile(path.join(out, 'cases.json'), ser(named.map(c => ({name: c.name, pathName: c.pathName, purchaseCount: c.ledger?.purchaseCount ?? 0, sold: c.ledger?.sold ?? 0,
  cursor: c.ledger?.cursor ?? 0, fundingInputs: c.fundingInputs, sponsored: !!c.sponsored, budgets: c.draft.transaction.inputs.map(i => i.computeBudget),
  scriptSigBytes: c.draft.transaction.inputs[0].signatureScript.length / 2}))));

function runBatch(batch, file) {
  return new Promise((resolve, reject) => {
    const cp = spawn(pin.binary, ['--exact', 'test_hardened_script_vm', '--nocapture', '--test-threads=1'], {env: {PATH: process.env.PATH, F3VM_CASES: file}});
    let stdout = '', stderr = '';
    cp.stdout.on('data', d => stdout += d); cp.stderr.on('data', d => stderr += d);
    const timer = setTimeout(() => cp.kill('SIGKILL'), 600_000);
    cp.on('error', reject);
    cp.on('close', (code, signal) => { clearTimeout(timer); resolve({code, signal, stdout, stderr}); });
  });
}
const BATCH = 64, results = [];
const t0 = Date.now();
for (let at = 0; at < named.length; at += BATCH) {
  const batch = named.slice(at, at + BATCH), file = path.join(out, `batch-${String(at / BATCH).padStart(3, '0')}.json`);
  await fs.writeFile(file, ser(batch.map(c => ({name: c.name, profileId: profile.id, draft: c.draft, accessor: c.accessor}))), {mode: 0o600});
  const r = await runBatch(batch, file);
  await fs.writeFile(file.replace(/\.json$/, '.stdout'), r.stdout); await fs.writeFile(file.replace(/\.json$/, '.stderr'), r.stderr);
  assert.equal(r.signal, null, 'VM_INFRA_SIGNAL batch ' + at); assert.equal(r.code, 0, 'VM_INFRA_EXIT batch ' + at);
  const lines = r.stdout.split('\n').filter(s => s.startsWith('KASWIN_VM_RESULT ')).map(s => JSON.parse(s.slice(17)));
  assert.equal(lines.length, batch.length, 'VM_RESULT_COUNT batch ' + at);
  lines.forEach((v, i) => { assert.equal(v.name, batch[i].name); assert.equal(v.profileId, profile.id); results.push({c: batch[i], v}); });
  process.stdout.write(`\r${results.length}/${named.length} cases (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
process.stdout.write('\n');

// ---------- evaluate ----------
const allowed = b => 9999 + 10000 * b;
const rows = results.map(({c, v}) => {
  const action = c.pathName.startsWith('CLOSE_') ? 'CLOSE' : c.pathName.startsWith('REFUND_') ? 'REFUND' : c.pathName;
  const used = v.units[0] ?? null, budget = v.budgets[0];
  const envelope = action === 'GENESIS' ? null : P.actionUnits(action, c.ledger);
  const fundingOk = v.units.slice(1).every((u, i) => u <= allowed(v.budgets[i + 1]));
  return {name: c.name, path: c.pathName, purchaseCount: c.ledger?.purchaseCount ?? 0, sold: c.ledger?.sold ?? 0, cursor: c.ledger?.cursor ?? 0,
    fundingInputs: c.fundingInputs, sponsored: !!c.sponsored, stress: !!c.stress, status: v.status, error: v.error, detail: v.detail ?? null,
    budget, allowed: allowed(budget), used, headroom: used == null ? null : allowed(budget) - used,
    headroomPct: used == null ? null : +((allowed(budget) - used) / allowed(budget) * 100).toFixed(2),
    envelope, withinEnvelope: envelope == null ? null : used <= envelope, fundingUnits: v.units.slice(1), fundingOk,
    pass: v.status === 'ACCEPT' && used <= allowed(budget) && (envelope == null || used <= envelope) && fundingOk};
});
await fs.writeFile(path.join(out, 'results.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const byPath = {};
for (const r of rows) {
  const g = byPath[r.path] ??= {cases: 0, pass: 0, fail: [], minHeadroom: null, minHeadroomPct: null, worst: null, maxUsed: 0, maxEnvelopeSlackPct: null};
  g.cases++; if (r.pass) g.pass++; else g.fail.push({name: r.name, status: r.status, error: r.error, used: r.used, allowed: r.allowed, envelope: r.envelope});
  if (r.used != null) {
    if (g.minHeadroom == null || r.headroom < g.minHeadroom) { g.minHeadroom = r.headroom; g.minHeadroomPct = r.headroomPct; g.worst = r.name; }
    g.maxUsed = Math.max(g.maxUsed, r.used);
    if (r.envelope) { const slack = +((r.envelope - r.used) / r.envelope * 100).toFixed(2); g.maxEnvelopeSlackPct = Math.max(g.maxEnvelopeSlackPct ?? slack, slack); g.minEnvelopeSlackPct = Math.min(g.minEnvelopeSlackPct ?? slack, slack); }
  }
}
const summary = {schema: 'KASWIN_V2_VM_BUDGET_RUN_1', scope: 'SCRIPT_VM_ONLY', quick: !!opt.quick, profileId: profile.id,
  consensusCommit: pin.consensusCommit, compilerCommit: pin.compilerCommit, binarySha256: pin.binarySha256, harnessSourceSha256: pin.harnessSourceSha256,
  protocolSourceSha256: fileSha(await fs.readFile(path.join(ROOT, 'packages/f3.2-core/src/protocol.ts'))),
  buildersSourceSha256: fileSha(await fs.readFile(path.join(ROOT, 'packages/f3.2-core/src/builders.ts'))),
  cases: rows.length, passed: rows.filter(r => r.pass).length, byPath, seconds: Math.round((Date.now() - t0) / 1000),
  notCovered: ['full-transaction validation (mass, storage mass, relative-lock maturity, relay, node acceptance)', 'real SeqCommit accessor (mocked to the public PASS-A fixture)', 'real wallet signatures (public test scalar 1)']};
await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));

// Candidate evidence in the exact shape contracts/f3.2/tools/budget-gate.mjs expects (review left PENDING).
if (!opt.quick) {
  const resultsSha = sha(await fs.readFile(path.join(out, 'results.jsonl')));
  const candidate = {schema: 'KASWIN_V2_BUDGET_REVIEW_1', profileId: profile.id, compilerCommit: pins.compilerCommit, compilerBinarySha256: pins.compilerBinarySha256,
    consensusCommit: pin.consensusCommit, protocolSourceSha256: summary.protocolSourceSha256, buildersSourceSha256: summary.buildersSourceSha256,
    vmBinarySha256: pin.binarySha256, vmHarnessSourceSha256: pin.harnessSourceSha256,
    review: {status: 'PENDING', reviewer: null, at: null},
    coverage: {maxPurchases: 256, refundBatch: 32, defaultBudgetsExecuted: true, allSupportedDirectorySizesAndRefundCursors: true,
      actions: ['GENESIS', 'BUY', 'CLOSE_EMPTY', 'CLOSE_SEALED', 'CLOSE_REFUNDING', 'DRAW_AND_PAY', 'TIMEOUT_REFUND', 'REFUND_INTERMEDIATE', 'REFUND_FINAL']},
    measurements: rows.filter(r => !r.stress).filter(r => r.fundingInputs <= 1 && !r.sponsored || r.path === 'GENESIS' && r.fundingInputs === 1 || ['DRAW_AND_PAY', 'REFUND_FINAL', 'REFUND_INTERMEDIATE'].includes(r.path) && !r.sponsored)
      .filter((r, i, a) => a.findIndex(x => x.path === r.path && x.purchaseCount === r.purchaseCount && x.cursor === r.cursor) === i)
      .map(r => ({path: r.path, passed: r.pass, budget: r.budget, usedScriptUnits: r.used, evidenceFile: 'results.jsonl', evidenceSha256: resultsSha,
        ...(r.path === 'GENESIS' ? {} : {ledger: ledgerSummary(r)})}))};
  await fs.writeFile(path.join(out, 'budget-evidence.candidate.json'), JSON.stringify(candidate, null, 2));
}
function ledgerSummary(r) {
  const c = results.find(x => x.c.name === r.name).c.ledger;
  return {purchaseCount: c.purchaseCount, cursor: c.cursor, sold: c.sold, config: {minTickets: c.config.minTickets}};
}
console.log(JSON.stringify({out, cases: summary.cases, passed: summary.passed, seconds: summary.seconds}, null, 0));
for (const [k, g] of Object.entries(byPath)) console.log(k.padEnd(20), `${g.pass}/${g.cases}`, 'minHeadroom', g.minHeadroom, `(${g.minHeadroomPct}%)`, 'maxUsed', g.maxUsed,
  'envelopeSlack', g.minEnvelopeSlackPct ?? '-', '..', g.maxEnvelopeSlackPct ?? '-', '%', g.fail.length ? 'FAIL ' + JSON.stringify(g.fail.slice(0, 3)) : '');
if (rows.some(r => !r.pass)) process.exitCode = 1;
