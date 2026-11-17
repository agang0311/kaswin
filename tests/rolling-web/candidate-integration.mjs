// Explicit real TN10 integration smoke for the candidate rolling-tn10.html + real VM service + real Rolling sidecar.
// Requires --execute. TIMEOUT is strictly excluded (reserved for the user's manual test).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {RollingPage} from './harness.mjs';
import {acquireWalletLock} from './lock.mjs';
import {requireCampaignCapacity, inspectKnownRounds} from './known-rounds.mjs';
import {
  saveJson,
  openEvidenceRpc,
  stableCursor,
  roundReady,
  readRound,
  sendQuote,
  executeAction,
  acceptanceEvidence,
  finalizedRound,
  pause,
} from './evidence.mjs';
import {startTn10Service} from '../../experiments/rolling/tn10-service.mjs';
import {createRollingSidecar} from '../../scripts/rolling/indexer/server.mjs';
import {TN10_PROFILE_ID} from '../../web/rolling-tn10/protocol.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '../output/rolling-runs');
const arg = (k, d = null) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

if (!process.argv.includes('--execute')) {
  console.error('EXPLICIT_EXECUTE_REQUIRED: pass --execute to run the TN10 candidate integration smoke');
  process.exit(1);
}

const NODE = arg('node', 'ws://127.0.0.1:18210');
const SIDECAR_RPC = arg('sidecar-rpc', NODE);
const WITH_SIDECAR = !process.argv.includes('--no-sidecar');
const SEALED_ONLY = process.argv.includes('--sealed-only');
const ROLE = arg('role', 'creator');
if (!['creator', 'b1', 'b2'].includes(ROLE)) throw new Error('ROLE');

const PAGE_PATH = path.resolve(arg('page', 'tests/output/rolling-integration/candidate/rolling-tn10.html'));
if (!fs.existsSync(PAGE_PATH)) throw new Error(`CANDIDATE_PAGE_MISSING ${PAGE_PATH}`);
const VM_BIN = process.env.KASWIN_VM_BIN;
if (!VM_BIN || !fs.existsSync(VM_BIN)) throw new Error('KASWIN_VM_BIN_REQUIRED');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  return {status: res.status, json: JSON.parse(text)};
}

async function waitForSidecar(baseUrl, fn, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    try {
      const value = await fn(baseUrl);
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await pause(1000);
  }
  throw new Error(`SIDECAR_WAIT_TIMEOUT ${last?.message ?? ''}`);
}

acquireWalletLock(ROOT, ROLE, SEALED_ONLY ? 'prepare sealed round for manual TIMEOUT' : 'candidate integration smoke');
await requireCampaignCapacity(1);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
const RUN = path.join(ROOT, `${stamp}-${SEALED_ONLY ? 'sealed-for-timeout' : 'candidate-integration'}`);
fs.mkdirSync(RUN, {recursive: true});
const log = (...args) => {
  const line = `${new Date().toISOString().slice(11, 23)} ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(RUN, 'run.log'), line + '\n');
};

const rpc = await openEvidenceRpc(NODE);
let svc = null;
let sidecar = null;
let page1 = null;
let page2 = null;

const record = {
  schema: 'KASWIN_ROLLING_CANDIDATE_INTEGRATION_1',
  startedAt: stamp,
  node: NODE,
  sidecarRpc: WITH_SIDECAR ? SIDECAR_RPC : null,
  pagePath: PAGE_PATH,
  role: ROLE,
  sealedOnly: SEALED_ONLY,
  pass: false,
};
const save = () => saveJson(path.join(RUN, 'run.json'), record);
save();

try {
  const cursor = await stableCursor(rpc, 150);
  record.cursor = cursor;

  svc = await startTn10Service({
    port: 0,
    host: '127.0.0.1',
    vmBin: VM_BIN,
    pagePath: PAGE_PATH,
  });
  const svcOrigin = `http://127.0.0.1:${svc.port}`;
  const pageUrl = `${svcOrigin}/rolling-tn10.html`;
  record.serviceUrl = svcOrigin;
  log(`started temp tn10-service at ${svcOrigin} serving ${PAGE_PATH}`);

  let indexerUrl = null;
  if (WITH_SIDECAR) {
    const sidecarPort = await freePort();
    const sidecarDir = path.join(RUN, 'sidecar-data');
    sidecar = await createRollingSidecar([
      `--data-dir=${sidecarDir}`,
      `--port=${sidecarPort}`,
      '--host=127.0.0.1',
      `--rpc=${SIDECAR_RPC}`,
      `--start-hash=${cursor}`,
      '--poll-ms=1000',
      '--stale-ms=30000',
      `--cors-origin=${svcOrigin}`,
    ]);
    const info = await sidecar.start();
    indexerUrl = `http://${info.host}:${info.port}${info.basePath}`;
    record.indexerUrl = indexerUrl;
    log(`started temp sidecar at ${indexerUrl} (startHash=${cursor.slice(0, 16)}...)`);
    await waitForSidecar(indexerUrl, async base => {
      const r = await fetchJson(`${base}/info`);
      return r.status === 200 && r.json.stale === false ? r.json : null;
    });
    log('sidecar initial poll ready (stale=false)');
  }

  // Phase 1: full payout lifecycle via candidate HTML + real VM service + real TN10 node
  page1 = new RollingPage({url: pageUrl, log, profileDir: path.join(RUN, 'profile-writer')});
  await page1.open();
  await page1.setSettings({
    node: NODE,
    service: svcOrigin,
    indexer: indexerUrl ?? '',
  });
  await page1.connect(ROLE);

  await page1.fillCreate({price: '1', cap: 5, min: 3, minutes: 1});
  await page1.clickCreate();
  if (!await page1.waitQuote()) throw new Error('GENESIS_QUOTE_TIMEOUT');
  let {round} = await sendQuote(page1, 'GENESIS', {log});
  record.cid = round.cid;
  saveJson(path.join(RUN, 'checkpoint.json'), round);
  save();
  log(`GENESIS confirmed: cid=${round.cid}`);

  for (let n = 1; n <= 3; n++) {
    const qty = page1.p.locator('#qty');
    if (await qty.count()) await qty.fill('1');
    ({round} = await executeAction(page1, 'BUY', {log}));
    if (round.buys !== n) throw new Error(`BUY_COUNT_MISMATCH ${round.buys} expected ${n}`);
    saveJson(path.join(RUN, 'checkpoint.json'), round);
  }

  ({round} = await executeAction(page1, 'CLOSE', {log, timeout: 360000}));
  if (SEALED_ONLY) {
    round = await roundReady(page1, r => !r.intent && r.pending.length === 0 && !r.terminal && r.receipts.length === 5, 180000);
    saveJson(path.join(RUN, 'round.json'), round);
    saveJson(path.join(RUN, 'checkpoint.json'), round);
    const evidence = [];
    for (const receipt of round.receipts) {
      const ev = await acceptanceEvidence(rpc, receipt.txid, {block: receipt.acceptingBlock, cursor});
      if (ev.feeSompi !== receipt.feeSompi) throw new Error('ACTUAL_FEE_DIFFERS_FROM_PAGE');
      ev.action = receipt.action;
      ev.transientMass = receipt.transientMass;
      evidence.push(ev);
      saveJson(path.join(RUN, 'acceptance.json'), evidence);
    }
    const browserErrors1 = page1.errors.filter(x => !/^\[console\] Failed to load resource:.*favicon/.test(x));
    if (browserErrors1.length) throw new Error(`BROWSER_ERROR_WRITER ${browserErrors1[0]}`);
    await page1.shot(RUN, 'final');
    const exportText = await page1.exportRoundText();
    const exportPath = path.join(RUN, 'sealed-round-export.json');
    fs.writeFileSync(exportPath, exportText, {mode: 0o600});

    const closeEv = evidence.at(-1);
    const closeAcceptingDaa = BigInt(closeEv.acceptingDaa);
    const timeoutEligibleDaa = closeAcceptingDaa + 432000n;
    const currentDaa = await rpc.currentDaa();
    const remainingDaa = timeoutEligibleDaa > currentDaa ? timeoutEligibleDaa - currentDaa : 0n;
    const estimatedSeconds = Math.ceil(Number(remainingDaa) / 10);

    record.terminal = round.terminal;
    record.phase = 'sealed';
    record.transactions = evidence.length;
    record.feeSompi = round.fees.toString();
    record.allAccepted = evidence.every(e => e.accepted && BigInt(e.depth) >= 100n);
    record.actions = evidence.reduce((counts, e) => ({...counts, [e.action]: (counts[e.action] ?? 0) + 1}), {});
    record.exportPath = exportPath;
    record.timeoutInfo = {
      closeTxid: closeEv.txid,
      closeAcceptingBlock: closeEv.acceptingBlock,
      closeAcceptingDaa: closeAcceptingDaa.toString(),
      timeoutDelayDaa: '432000',
      timeoutEligibleDaa: timeoutEligibleDaa.toString(),
      observedVirtualDaa: currentDaa.toString(),
      remainingDaa: remainingDaa.toString(),
      estimatedSecondsRemaining: estimatedSeconds,
      estimatedEligibleAtUtc: new Date(Date.now() + estimatedSeconds * 1000).toISOString(),
    };
    if (WITH_SIDECAR) {
      const sidecarRound = await waitForSidecar(indexerUrl, async base => {
        const r = await fetchJson(`${base}/rounds/${round.cid}`);
        return r.status === 200 && r.json?.summary?.module === 'sealed' && r.json?.revision === '5' ? r.json : null;
      });
      saveJson(path.join(RUN, 'sidecar-info.json'), (await fetchJson(`${indexerUrl}/info`)).json);
      saveJson(path.join(RUN, 'sidecar-round.json'), sidecarRound);
    }
    const activeReport = await inspectKnownRounds();
    fs.writeFileSync('tests/output/rolling-campaign/active-rounds.json', JSON.stringify(activeReport, null, 2) + '\n', {mode: 0o600});
    record.pass = record.allAccepted && round.buys === 3 && round.bought === 3 && round.terminal === null;
    if (!record.pass) throw new Error('SEALED_PREPARATION_FAILED');
    save();
    log(`SEALED round ready for manual TIMEOUT: cid=${round.cid}, timeoutEligibleDaa=${timeoutEligibleDaa}, export=${exportPath}`);
  } else {
  while (!round.terminal) {
    const phase = round.manager ? await page1.state() : null;
    let action = null;
    if (phase?.acts.includes('DRAW')) action = 'DRAW';
    else action = ['PAY_OLD', 'PAY_SELF'].find(a => phase?.acts.includes(a)) ?? null;
    if (!action) {
      await pause(500);
      round = await roundReady(page1);
      continue;
    }
    ({round} = await executeAction(page1, action, {log, timeout: 360000}));
    saveJson(path.join(RUN, 'checkpoint.json'), round);
  }

  const verified = await finalizedRound(page1, rpc, {cursor, dir: RUN, log});
  const browserErrors1 = page1.errors.filter(x => !/^\[console\] Failed to load resource:.*favicon/.test(x));
  if (browserErrors1.length) throw new Error(`BROWSER_ERROR_WRITER ${browserErrors1[0]}`);
  await page1.shot(RUN, 'final');

  record.terminal = verified.round.terminal;
  record.transactions = verified.evidence.length;
  record.feeSompi = verified.round.fees.toString();
  record.allAccepted = verified.evidence.every(e => e.accepted && BigInt(e.depth) >= 100n);
  record.actions = verified.evidence.reduce((counts, e) => ({...counts, [e.action]: (counts[e.action] ?? 0) + 1}), {});
  if (record.terminal !== 'PAID' || !record.allAccepted || verified.round.buys !== 3 || verified.round.bought !== 3) {
    throw new Error('LIFECYCLE_VERIFICATION_FAILED');
  }
  save();

  // Phase 2: sidecar indexing + stateless reader page sync & verification
  if (WITH_SIDECAR) {
    const sidecarRound = await waitForSidecar(indexerUrl, async base => {
      const r = await fetchJson(`${base}/rounds/${round.cid}`);
      return r.status === 200 && r.json?.terminal === 'PAID' ? r.json : null;
    });
    const sidecarInfo = (await fetchJson(`${indexerUrl}/info`)).json;
    const sidecarList = await fetchJson(`${indexerUrl}/rounds?limit=50`);
    const listed = sidecarList.status === 200 && sidecarList.json?.rounds?.some(x => x.cid === round.cid && x.terminal === 'PAID');
    if (!listed) throw new Error(`SIDECAR_LIST_MISSING ${round.cid}`);
    const txLookup = await fetchJson(`${indexerUrl}/txid/${verified.evidence.at(-1).txid}`);
    if (txLookup.status !== 200 || txLookup.json?.cid !== round.cid) {
      throw new Error(`SIDECAR_TXID_LOOKUP_MISMATCH ${txLookup.status}`);
    }
    if (sidecarInfo.profileId !== TN10_PROFILE_ID || sidecarInfo.readOnly !== true) {
      throw new Error('SIDECAR_INFO_MISMATCH');
    }
    saveJson(path.join(RUN, 'sidecar-info.json'), sidecarInfo);
    saveJson(path.join(RUN, 'sidecar-round.json'), sidecarRound);
    log(`sidecar indexed terminal=PAID at revision=${sidecarRound.revision}`);

    page2 = new RollingPage({url: pageUrl, log, profileDir: path.join(RUN, 'profile-reader')});
    await page2.open();
    await page2.setSettings({
      node: NODE,
      service: svcOrigin,
      indexer: indexerUrl,
    });
    await page2.clickAct('refreshIndex');
    const itemBtn = page2.p.locator(`[data-indexed="${round.cid}"]`);
    await itemBtn.waitFor({state: 'visible', timeout: 30000});
    await itemBtn.click({force: true});
    const syncedRound = await roundReady(page2, r => !r.intent && r.terminal === 'PAID' && r.receipts.length === 7, 60000);
    if (syncedRound.cid !== round.cid || syncedRound.buys !== 3 || syncedRound.bought !== 3) {
      throw new Error('INDEXER_READER_SYNC_MISMATCH');
    }
    const browserErrors2 = page2.errors.filter(x => !/^\[console\] Failed to load resource:.*favicon/.test(x));
    if (browserErrors2.length) throw new Error(`BROWSER_ERROR_READER ${browserErrors2[0]}`);
    await page2.shot(RUN, 'indexed-view');
    saveJson(path.join(RUN, 'indexed-round.json'), syncedRound);
    record.indexerSynced = true;
    log(`reader page discovered & node-verified cid=${round.cid} terminal=PAID receipts=${syncedRound.receipts.length}`);
  }

  record.pass = true;
  save();
  log(`PASSED candidate integration smoke: run=${RUN}`);
  }
} catch (e) {
  record.pass = false;
  record.error = String(e.message ?? e).slice(0, 600);
  if (page1?.p) {
    await page1.shot(RUN, 'failure').catch(() => {});
    if (!await page1.p.locator('#modal[open]').count().catch(() => false)) {
      await page1.exportRoundText().then(t => fs.writeFileSync(path.join(RUN, 'recovery-round.json'), t, {mode: 0o600})).catch(() => {});
    }
  }
  save();
  log(`FAILED candidate integration smoke: ${record.error}`);
  process.exitCode = 1;
} finally {
  await page2?.close_().catch(() => {});
  await page1?.close_().catch(() => {});
  await sidecar?.stop().catch(() => {});
  await svc?.close().catch(() => {});
  rpc.close();
}
