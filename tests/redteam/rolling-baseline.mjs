// Offline kaspa-redteam baselines for the Kaswin Rolling sharded prototype (Profile b56bcd9c…).
//
// Transactions come from experiments/rolling/fixtures.mjs + transactions.mjs: the real JS builder against the real
// compiled artifacts (silverc 1.0.1). Funding P2PK inputs are signed with the same deterministic PUBLIC throwaway key
// the rolling VM cases use, so the judge's as-given check can pass. Nothing here touches a node, a wallet or a key
// that holds funds; these transactions can never be broadcast.
//
//   node tests/redteam/rolling-baseline.mjs [--out=DIR]
//
// One file per template, because --baseline is per-file and one rejected transaction aborts the whole file.
// No `keys` are listed: every output the covenant pins is paid to a key fixed in the ledger, and redteam rewrites
// outputs that pay a listed key to its own attacker address (import.rs parse_outputs), which would break the
// as-given check. No `own` either: the only free output is the fee sink.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {S, profile, fixture, fund, quote, findDraw, PRICE, KAS, FEE} from '../../experiments/rolling/fixtures.mjs';
import {schnorrSighash} from '../../scripts/wallet/sighash.mjs';
import {schnorrSign, xonlyPubkey} from '../../scripts/wallet/schnorr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT = outArg ? path.resolve(outArg.slice(6))
  : path.join(ROOT, 'tests/output/redteam', new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z'), 'rolling');

// Same label -> same key as experiments/rolling/vm-cases.mjs (FUNDER_SK). Public, deterministic, never funded.
const SK = new Uint8Array(createHash('sha256').update('kaswin-rolling-vm-throwaway-key:funder').digest());
const FUNDER = Buffer.from(xonlyPubkey(SK)).toString('hex');
const KAS10 = 10n * KAS, PAY_FEE = 50_000_000n;
const F = (n, v) => fund(n, v, FUNDER);
const spkHex = spk => spk.version.toString(16).padStart(4, '0') + spk.script;
const dec = v => v.toString();

/** Draft + fixture -> one kaspa-redteam baseline transaction entry. */
function entry(name, f, d, {seq = []} = {}) {
  const t = d.transaction, utxos = d.inputUtxos.map(u => ({value: u.value, spk: u.spk}));
  for (const i of d.authorizedInputIndices) {
    t.inputs[i].signatureScript = '41' + Buffer.from(schnorrSign(SK, schnorrSighash(t, utxos, i))).toString('hex') + '01';
  }
  return {
    entry: {
      path: name,
      targets: [...Array(1 + Math.max(0, d.inputUtxos.length - 1 - d.authorizedInputIndices.length)).keys()],
      // The block this transaction would land in. DAA locks (CLOSE lockTime, TIMEOUT age) are checked against it.
      daaScore: dec(f.manager.currentDaa),
      tx: {
        version: t.version,
        inputs: t.inputs.map(i => ({
          previousOutpoint: {transactionId: i.previousOutpoint.transactionId, index: i.previousOutpoint.index},
          signatureScript: i.signatureScript, sequence: dec(i.sequence), computeBudget: i.computeBudget ?? 0,
        })),
        outputs: t.outputs.map(o => ({
          value: dec(o.value), scriptPublicKey: spkHex(o.scriptPublicKey),
          covenant: o.covenant ? {authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId} : null,
        })),
        lockTime: dec(t.lockTime), subnetworkId: t.subnetworkId, gas: 0, payload: t.payload,
      },
      utxos: d.inputUtxos.map(u => ({
        amount: dec(u.value), scriptPublicKey: spkHex(u.spk), blockDaaScore: dec(u.utxoDaa),
        isCoinbase: false, covenantId: u.covenantId ?? null,
      })),
    },
    seq,
  };
}

const BUDGETS = n => Array(n).fill(65535);   // never the limiting factor: the judge still enforces the committed units
function build(name, f, op, {targets = [], funds = [], fee = FEE} = {}) {
  const n = 1 + targets.length + funds.length;
  const {d} = quote(f, {...op, actorKey: FUNDER}, {targets, funds, fee, budgets: BUDGETS(n)});
  return entry(name, f, d, op.accessor ? {seq: [{blockHash: op.accessor.blockHash, commitment: op.accessor.sequenceCommitment}]} : {});
}

const files = {sales: [], sealed: [], win: [], refund: []};
const add = (m, e) => { files[m].push(e.entry); if (e.seq.length) seqCommitments[e.seq[0].blockHash] = e.seq[0].commitment; };
const seqCommitments = {};

// ---- sales: 256x256 sharding boundaries -------------------------------------------------------------
{
  const buy = (name, o, q, funds) => add('sales', build(name, fixture({module: 'sales', ...o}), {action: 'BUY', quantity: q},
    {funds: funds ?? [F(1, BigInt(q) * PRICE + KAS10)]}));
  const close = (name, o) => add('sales', build(name, fixture({module: 'sales', ...o}), {action: 'CLOSE'}, {funds: [F(2, KAS10)]}));

  buy('buy:first-record (cnt=0, local=0)', {}, 1);
  buy('buy:last-local-record (cnt=254, local=254)', {cnt: 254, local: 254}, 1);
  buy('buy:freezes-first-shard (cnt=0, local=255)', {local: 255}, 1);
  buy('buy:freezes-255th-shard (cnt=254, local=255)', {cnt: 254, local: 255}, 1);
  buy('buy:creates-shard-256 (cnt=255, local=255)', {cnt: 255, local: 255}, 1);
  buy('buy:multi-ticket-1000', {}, 1000);
  buy('buy:8-funding-inputs', {}, 1, Array.from({length: 8}, (_, i) => F(10 + i, 137500000n)));

  close('close:empty->EMPTY (cnt=0, local=0)', {});
  close('close:->SEALED (cnt=0, local=5)', {local: 5});
  close('close:->SEALED largest (cnt=255, local=255)', {cnt: 255, local: 255});
  close('close:->REFUND below minimum', {local: 5, minTickets: 100});
  close('close:->REFUND largest (cnt=255, local=255)', {cnt: 255, local: 255, minTickets: 70000});
  close('close:at cap, no lockTime', {local: 5, ticketCap: 5});
  close('close:full 256 shards (65536 records)', {cnt: 256, local: 0});
}

// ---- sealed: DRAW (old shard / local tail) and TIMEOUT ----------------------------------------------
{
  const draw = (name, o, old) => {
    const f = fixture({module: 'sealed', ...o, currentDaa: 2000n + S.DRAW_DELAY + 10n});
    add('sealed', build(name, f, findDraw(f, old), {funds: [F(3, KAS10)]}));
  };
  const timeout = (name, o) => add('sealed', build(name, fixture({module: 'sealed', ...o, currentDaa: 2000n + S.TIMEOUT_DELAY}),
    {action: 'TIMEOUT'}, {funds: [F(4, KAS10)]}));

  draw('draw:winner in old shard (cnt=2, local=10)', {cnt: 2, local: 10}, true);
  draw('draw:winner in local tail (cnt=2, local=10)', {cnt: 2, local: 10}, false);
  draw('draw:winner at full 256 shards (cnt=256, local=0)', {cnt: 256, local: 0}, true);
  timeout('timeout:->REFUND (cnt=2, local=10)', {cnt: 2, local: 10});
  timeout('timeout:->REFUND at full 256 shards', {cnt: 256, local: 0});
}

// ---- win: PAY_OLD batches (k=1/16, final merge) and PAY_SELF ---------------------------------------
{
  const payOld = (name, o, k) => {
    const f = fixture({module: 'win', ...o}), p = o.p ?? 0;
    add('win', build(name, f, {action: 'PAY_OLD'}, {targets: f.targets.slice(p, p + k), fee: PAY_FEE}));
  };
  const paySelf = (name, o) => add('win', build(name, fixture({module: 'win', ...o}), {action: 'PAY_SELF'}, {fee: PAY_FEE}));

  payOld('pay_old:k=1 nonfinal', {cnt: 255, local: 255}, 1);
  payOld('pay_old:k=16 nonfinal', {cnt: 255, local: 255}, 16);
  payOld('pay_old:k=16 nonfinal p=128', {cnt: 255, local: 255, p: 128}, 16);
  payOld('pay_old:k=16 nonfinal at full 256 shards', {cnt: 256, local: 0}, 16);
  payOld('pay_old:k=1 final merge', {cnt: 255, local: 2, p: 254}, 1);
  payOld('pay_old:k=16 final merge', {cnt: 16, local: 2, p: 0}, 16);
  payOld('pay_old:k=1 final merge, empty tail', {cnt: 2, local: 0, p: 1}, 1);
  payOld('pay_old:k=1 merge tail, not final', {cnt: 3, local: 2, p: 0}, 1);
  payOld('pay_old:k=1 tail too large to merge', {cnt: 2, local: 10, p: 1}, 1);
  paySelf('pay_self:largest (cnt=255, local=255)', {cnt: 255, local: 255, p: 255});
  paySelf('pay_self:smallest (cnt=0, local=3)', {local: 3, p: 0});
  payOld('pay_old:k=1 final merge at full 256 shards, empty tail', {cnt: 256, local: 0, p: 255}, 1);
}

// ---- refund: REFUND_OLD / REFUND_SELF -------------------------------------------------------------
{
  const refundOld = (name, o) => {
    const f = fixture({module: 'refund', ...o});
    add('refund', build(name, f, {action: 'REFUND_OLD'}, {targets: f.targets.slice(o.r, o.r + 1), fee: PAY_FEE}));
  };
  const refundSelf = (name, o, funds) => add('refund', build(name, fixture({module: 'refund', ...o}), {action: 'REFUND_SELF'},
    {funds, fee: 5_000_000n}));

  refundOld('refund_old:nonfinal r=0 c=0', {cnt: 255, local: 255, r: 0, c: 0});
  refundOld('refund_old:nonfinal r=0 c=32', {cnt: 255, local: 255, r: 0, c: 32});
  refundOld('refund_old:last batch of a shard', {cnt: 255, local: 255, r: 0, c: 224});
  refundOld('refund_old:last shard, no merge', {cnt: 255, local: 255, r: 254, c: 224});
  refundOld('refund_old:final merge, 36 outputs', {cnt: 255, local: 2, r: 254, c: 224});
  refundOld('refund_old:final merge, empty tail', {cnt: 2, local: 0, r: 1, c: 224});
  refundOld('refund_old:mid (cnt=100)', {cnt: 100, local: 50, r: 57, c: 96});
  refundOld('refund_old:full 256 shards, last shard', {cnt: 256, local: 0, r: 255, c: 224});
  refundSelf('refund_self:nonlast (cnt=0, local=255)', {local: 255, r: 0, c: 0}, [F(5, KAS)]);
  refundSelf('refund_self:last batch', {local: 255, r: 0, c: 224}, [F(5, KAS)]);
  refundSelf('refund_self:last batch, one record', {local: 33, r: 0, c: 32}, [F(5, KAS)]);
  refundSelf('refund_self:no funding input', {local: 255, r: 0, c: 32}, []);
  refundSelf('refund_self:8 funding inputs', {cnt: 3, local: 40, r: 3, c: 32}, Array.from({length: 8}, (_, i) => F(20 + i, 125000000n)));
}

fs.mkdirSync(OUT, {recursive: true});
const manifest = {format: 'kaswin-rolling-redteam-baseline-manifest/1', profileId: profile.id,
  generatedAt: new Date().toISOString(), funderPubkey: FUNDER, files: {}};
for (const [m, list] of Object.entries(files)) {
  if (!list.length) continue;
  const doc = {format: 'kaspa-redteam/baseline/1', daaScore: '500000', pastMedianTime: '1793500000000',
    ...(Object.keys(seqCommitments).length ? {seqCommitments} : {}), transactions: list};
  const file = path.join(OUT, `${m}.baseline.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  manifest.files[m] = {file: path.basename(file), transactions: list.length, paths: list.map(t => t.path)};
  console.log(`${m}: ${list.length} 笔 -> ${file}`);
  for (const t of list) console.log(`  ${t.path}  in=${t.tx.inputs.length} out=${t.tx.outputs.length} lockTime=${t.tx.lockTime} daa=${t.daaScore}`);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`manifest -> ${path.join(OUT, 'manifest.json')}`);
