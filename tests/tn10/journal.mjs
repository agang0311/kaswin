/** Local Linux evidence journal. Single fixed root across Profiles and rounds.
 * Fail closed: incomplete writes, stale locks and every uncertain intent block execute.
 * No TTL, resubmit, reset or automatic reservation release. Not a cross-device lock. */
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import {createHash, randomUUID} from 'node:crypto';
export const sha256 = b => createHash('sha256').update(b).digest('hex');
export const json = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v, 2) + '\n';
const roundName = n => {if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(n)) throw Error('INVALID_ROUND'); return n;};
const stepName = n => {if (!/^\d{2,4}-[A-Z_0-9]+$/.test(n)) throw Error('INVALID_STEP'); return n;};
function syncDir(dir) {const fd = fs.openSync(dir, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
export function privateDir(dir, create = false) {
  if (create) {try {fs.mkdirSync(dir, {mode: 0o700});} catch (e) {if (e.code !== 'EEXIST') throw e;}}
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700 || st.uid !== process.getuid()) throw Error('PRIVATE_DIRECTORY_REQUIRED');
}
export function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid() || st.nlink !== 1 || st.size > 16 * 1024 * 1024) throw Error('PRIVATE_FILE_REQUIRED');
    return fs.readFileSync(fd);
  } finally {fs.closeSync(fd);}
}
export function writeOnce(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  syncDir(path.dirname(file));
}
export class Journal {
  constructor(root, {create = false} = {}) {this.root = root; privateDir(root, create); this.locked = false;}
  lock() {writeOnce(path.join(this.root, 'execute.lock'), json({pid: process.pid, at: new Date().toISOString()})); this.locked = true;}
  unlock() {if (this.locked) {fs.unlinkSync(path.join(this.root, 'execute.lock')); syncDir(this.root); this.locked = false;}}
  roundDir(round) {const dir = path.join(this.root, roundName(round)); privateDir(dir); return dir;}
  start(round, metadata) {
    if (!this.locked) throw Error('LOCK_REQUIRED');
    const dir = path.join(this.root, roundName(round));
    fs.mkdirSync(dir, {mode: 0o700}); syncDir(this.root); // NEVER resume execute or reuse a dry directory
    writeOnce(path.join(dir, 'run.json'), json(metadata)); return dir;
  }
  checkUnresolved() {
    if (!this.locked) throw Error('LOCK_REQUIRED');
    const reserved = new Set();
    for (const e of fs.readdirSync(this.root, {withFileTypes: true})) {
      if (e.name === 'execute.lock') continue;
      if (!e.isDirectory() || e.isSymbolicLink()) throw Error('UNRECOGNIZED_EVIDENCE_ENTRY');
      const dir = this.roundDir(e.name);
      const run = JSON.parse(readPrivate(path.join(dir, 'run.json')));
      if (run.schema !== 'KASWIN_TN10_RUN_2') throw Error('UNRECOGNIZED_RUN_SCHEMA');
      // An interrupted run blocks new runs even if its last submitted tx was accepted.
      const complete = JSON.parse(readPrivate(path.join(dir, 'complete.json')));
      if (complete.status !== 'COMPLETED' || !['EMPTY', 'PAID', 'REFUNDED'].includes(complete.terminal)) throw Error('INCOMPLETE_PRIOR_RUN');
      for (const name of fs.readdirSync(dir).filter(n => n.endsWith('-intent.json'))) {
        const step = name.slice(0, -12), intent = JSON.parse(readPrivate(path.join(dir, name)));
        const receipt = JSON.parse(readPrivate(path.join(dir, `${step}-accepted.json`)));
        if (intent.schema !== 'KASWIN_TN10_INTENT_2' || intent.profileId !== run.profileId || intent.networkGenesis !== run.networkGenesis ||
            receipt.schema !== 'KASWIN_TN10_ACCEPTED_2' || receipt.status !== 'ACCEPTED' || receipt.txid !== intent.txid ||
            receipt.profileId !== intent.profileId || receipt.networkGenesis !== intent.networkGenesis ||
            receipt.intentSha256 !== sha256(readPrivate(path.join(dir, name)))) throw Error('UNRESOLVED_INTENT');
        if (!Array.isArray(intent.draft?.inputUtxos) || !intent.draft.inputUtxos.length) throw Error('INTENT_INPUTS_REQUIRED');
        for (const u of intent.draft.inputUtxos) {
          if (!/^[0-9a-f]{64}$/.test(u.outpoint?.transactionId ?? '') || !Number.isSafeInteger(u.outpoint.index) || u.outpoint.index < 0) throw Error('INTENT_INPUT_INVALID');
          reserved.add(`${u.outpoint.transactionId}:${u.outpoint.index}`);
        }
      }
    }
    return reserved; // even accepted inputs are not automatically reused after a reorg
  }
  persist(round, step, record) {
    if (!this.locked) throw Error('LOCK_REQUIRED');
    const dir = this.roundDir(round); stepName(step);
    // v8 preserves bigints/Uint8Arrays; only this local private file is deserialized.
    // Orphaned/partial writes block the unfinished run rather than silently freeing it.
    const raw = v8.serialize(record);
    writeOnce(path.join(dir, `${step}-record.bin`), raw);
    const intent = {schema: 'KASWIN_TN10_INTENT_2', mode: 'execute', status: 'SUBMITTING', networkGenesis: record.networkGenesis,
      profileId: record.profileId, txid: record.draft.txid, step, recordSha256: sha256(raw), anchor: record.anchor,
      draft: record.draft, signed: record.signed, snapshot: record.snapshot};
    writeOnce(path.join(dir, `${step}-intent.json`), json(intent));
    return sha256(Buffer.from(json(intent)));
  }
  load(round, step) {
    const dir = this.roundDir(round); stepName(step);
    const rawIntent = readPrivate(path.join(dir, `${step}-intent.json`)), intent = JSON.parse(rawIntent);
    if (intent.schema !== 'KASWIN_TN10_INTENT_2' || intent.mode !== 'execute' || intent.step !== step) throw Error('INTENT_SCHEMA');
    const raw = readPrivate(path.join(dir, `${step}-record.bin`));
    if (sha256(raw) !== intent.recordSha256) throw Error('RECORD_HASH_MISMATCH');
    const record = v8.deserialize(raw);
    if (record.draft.txid !== intent.txid) throw Error('RECORD_TXID_MISMATCH');
    return {...record, intentSha256: sha256(rawIntent)};
  }
  event(round, step, status, data = {}) {
    const dir = this.roundDir(round); stepName(step);
    writeOnce(path.join(dir, `${step}-${status}-${randomUUID()}.json`), json({...data, status, at: new Date().toISOString()}));
  }
  accepted(round, step, receipt) {writeOnce(path.join(this.roundDir(round), `${stepName(step)}-accepted.json`), json(receipt));}
  complete(round, terminal) {
    if (!this.locked) throw Error('LOCK_REQUIRED');
    writeOnce(path.join(this.roundDir(round), 'complete.json'), json({status: 'COMPLETED', terminal, at: new Date().toISOString()}));
  }
}
