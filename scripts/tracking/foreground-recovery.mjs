// One foreground, read-only recovery task. Events are hints, never evidence or send authority.
import {failure} from '../chain/operation.mjs';
const PENDING_RECOVERY = new Set(['SUBMITTING', 'RECHECKING', 'CONFIRMING', 'SUBMITTED', 'PENDING', 'UNKNOWN', 'REPLACED']);
export function pendingRecoveryRecords(rows, {cid = null, running = () => false, limit = 10} = {}) {
  return rows.filter(r => PENDING_RECOVERY.has(r.status)).sort((a, b) =>
    Number(a.cid !== cid) - Number(b.cid !== cid) || Number(running(a.txid)) - Number(running(b.txid)) || (a.createdAt ?? 0) - (b.createdAt ?? 0)).slice(0, limit);
}

export class ForegroundRecovery {
  constructor({visible, blocked = () => false, run, onPending = () => {}, onError = () => {}}) {
    Object.assign(this, {visible, blocked, run, onPending, onError});
    this.epoch = 0; this.dirty = false; this.work = null; this.timer = null; this.ctl = null;
  }
  request() {
    if (!this.visible()) return;
    // visibility/pageshow/online arriving during the same recovery share its result.
    if (this.work && this.workEpoch === this.epoch) return this.work;
    this.dirty = true; this.onPending(); this.schedule();
    return this.work;
  }
  schedule() {
    if (!this.dirty || this.work || this.timer || !this.visible() || this.blocked()) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 50);
  }
  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.work) {
      const superseded = this.workEpoch !== this.epoch;
      const result = await this.work;
      return superseded ? this.flush() : result;
    }
    if (!this.dirty || !this.visible() || this.blocked()) return;
    this.dirty = false;
    const epoch = this.epoch, ctl = this.ctl = new AbortController(); this.workEpoch = epoch;
    const current = () => epoch === this.epoch && !ctl.signal.aborted && this.visible();
    const task = Promise.resolve().then(() => { if (current()) return this.run({signal: ctl.signal, current}); })
      .catch(error => { if (current()) this.onError(error); })
      .finally(() => {
        if (this.work === task) this.work = null;
        if (this.ctl === ctl) this.ctl = null;
        this.schedule();
      });
    this.work = task;
    return task;
  }
  pause() {
    this.epoch++; this.dirty = false;
    clearTimeout(this.timer); this.timer = null;
    this.ctl?.abort(failure('FOREGROUND_RECOVERY_CANCELLED'));
  }
}
