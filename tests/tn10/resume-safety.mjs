// Offline helpers: no SDK, wallet, signing, network connection or CLI side effects.
import fs from 'node:fs';
import path from 'node:path';
import {readPrivate} from './journal.mjs';
import {PROFILE, NETWORK} from './cli.mjs';
const need = (v, code) => {if (!v) throw Error(code);};
export function parseCapacityArgs(args, maxBatch) {
  const out = {mode: 'dry', batch: maxBatch}; const seen = new Set();
  for (const arg of args) {
    const match = /^(--dry|--execute|--round|--approval|--batch)(?:=(.*))?$/.exec(arg);
    need(match && !seen.has(match[1]), 'INVALID_OR_DUPLICATE_ARGUMENT');
    const [, key, value] = match; seen.add(key);
    if (key === '--dry' || key === '--execute') {need(value === undefined && !seen.has(key === '--dry' ? '--execute' : '--dry'), 'MODE_CONFLICT'); out.mode = key.slice(2);}
    else {need(value?.length, 'ARGUMENT_VALUE_REQUIRED'); out[key.slice(2)] = value;}
  }
  if (out.mode === 'dry') need(!out.round && !out.approval && !seen.has('--batch'), 'DRY_TAKES_NO_LIVE_ARGUMENTS');
  else {need(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(out.round ?? '') && path.isAbsolute(out.approval ?? ''), 'ROUND_AND_ABSOLUTE_APPROVAL_REQUIRED');}
  need(/^[1-9][0-9]*$/.test(String(out.batch)) && Number(out.batch) <= maxBatch, 'BATCH_RANGE');
  out.batch = Number(out.batch); return out;
}
export function capacityApproval(file, round, scenario, maxTransactions) {
  need(path.isAbsolute(file), 'APPROVAL_ABSOLUTE_PATH_REQUIRED');
  const a = JSON.parse(readPrivate(file));
  need(Object.keys(a).sort().join(',') === ['schema','networkGenesis','profileId','scenario','round','authorizationReference','expiresAt','maxTotalFeeSompi','walletKeys'].sort().join(','), 'APPROVAL_FIELDS');
  need(a.schema === 'KASWIN_TN10_APPROVAL_1' && a.networkGenesis === NETWORK && a.profileId === PROFILE && a.round === round && a.scenario === scenario, 'APPROVAL_SCOPE');
  need(/^[A-Za-z0-9._:-]{1,128}$/.test(a.authorizationReference ?? ''), 'AUTHORIZATION_REFERENCE_REQUIRED');
  need(Date.parse(a.expiresAt) > Date.now(), 'APPROVAL_EXPIRED');
  need(typeof a.maxTotalFeeSompi === 'string' && /^[1-9][0-9]*$/.test(a.maxTotalFeeSompi) && BigInt(a.maxTotalFeeSompi) <= BigInt(maxTransactions) * 50000000n, 'TOTAL_FEE_CAP');
  need(a.walletKeys && Object.keys(a.walletKeys).sort().join(',') === 'buyer1,buyer2,creator' && Object.values(a.walletKeys).every(k => /^[0-9a-f]{64}$/.test(k)) && new Set(Object.values(a.walletKeys)).size === 3, 'WALLET_SCOPE');
  return a;
}
export function prepareResume(journal, round, approval) {
  const used = journal.checkUnresolved({resumeRound: round}); // pending/orphaned evidence fails before wallet loading
  const dir = path.join(journal.root, round);
  if (!fs.existsSync(dir)) return {used, totalFee: 0n, latestStep: null};
  const run = JSON.parse(readPrivate(path.join(dir, 'run.json'))), old = run.approval;
  need(run.profileId === PROFILE && run.networkGenesis === NETWORK && old, 'RUN_SCOPE');
  for (const field of ['schema','networkGenesis','profileId','scenario','round','authorizationReference','maxTotalFeeSompi']) need(old[field] === approval[field], 'RESUME_APPROVAL_SCOPE');
  for (const role of ['creator','buyer1','buyer2']) need(old.walletKeys?.[role] === approval.walletKeys[role], 'RESUME_WALLET_SCOPE');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-intent.json')).sort((a,b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
  let totalFee = 0n, previous = null;
  files.forEach((f, index) => {
    need(Number(f.split('-')[0]) === index + 1, 'RESUME_STEP_GAP');
    const step = f.slice(0, -12), intent = JSON.parse(readPrivate(path.join(dir, f)));
    if (previous) need(intent.draft.transaction.inputs[0].previousOutpoint.transactionId === previous && intent.draft.transaction.inputs[0].previousOutpoint.index === 0, 'RESUME_LINEAGE');
    const receipt = JSON.parse(readPrivate(path.join(dir, `${step}-accepted.json`)));
    need(!receipt.terminal || index === files.length - 1, 'STEP_AFTER_TERMINAL');
    previous = receipt.txid; totalFee += BigInt(receipt.actualFeeSompi);
  });
  if (fs.existsSync(path.join(dir, 'complete.json'))) {
    need(files.length > 0, 'EMPTY_COMPLETED_RUN');
    const last = JSON.parse(readPrivate(path.join(dir, `${files.at(-1).slice(0, -12)}-accepted.json`)));
    const complete = JSON.parse(readPrivate(path.join(dir, 'complete.json')));
    need(last.terminal === complete.terminal, 'COMPLETE_TERMINAL_MISMATCH');
  }
  need(totalFee <= BigInt(approval.maxTotalFeeSompi), 'TOTAL_FEE_BUDGET_EXCEEDED');
  return {used, totalFee, latestStep: files.at(-1)?.slice(0, -12) ?? null};
}
export async function selectedChainAnchor(rpc, start = null) {
  let hash = start ?? (await rpc.call('getSink')).sink;
  for (let n = 0; n < 30; n++) {
    need(/^[0-9a-f]{64}$/.test(hash ?? ''), 'ANCHOR_REQUIRED');
    const block = (await rpc.call('getBlock', {hash, includeTransactions: false})).block;
    need((block?.header?.hash ?? block?.verboseData?.hash) === hash, 'ANCHOR_HASH_MISMATCH');
    if (block.verboseData?.isChainBlock === true) return hash;
    hash = block.verboseData?.selectedParentHash;
  }
  throw Error('SELECTED_CHAIN_ANCHOR_NOT_FOUND');
}
