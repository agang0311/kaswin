/** Durable intent capability adapters. Common persist(context, record), deliberately different backend guarantees.
 * No fs import here; browser CAS storage cannot masquerade as a synchronous CLI event journal. */
import {persistIntent} from '../tracking/reservations.mjs';
export class CasIntentStore {
  constructor(store, {durability = 'required', reserveInputs = true} = {}) {
    this.store = store; this.durability = durability; this.reserveInputs = reserveInputs;
  }
  async persist({networkGenesis, key, lease = null, replacesKey = null}, record) {
    // Disabling advisory reservations does not disable the exact same-txid insert guard.
    const stored = this.reserveInputs
      ? await persistIntent(this.store, networkGenesis, key, record, lease, replacesKey)
      : await this.store.insertIfAbsentWithCheck(key, record, '', () => {});
    if (this.durability === 'required' && this.store.persistent === false) throw Error('DURABLE_STORE_REQUIRED');
    return stored;
  }
}
export class JournalIntentStore {
  constructor(journal) { this.journal = journal; this.durability = 'required'; }
  persist({round, step}, record) {
    if (!this.journal.locked) throw Error('LOCK_REQUIRED');
    const hash = requireSync(this.journal.persist(round, step, record));
    record.intentSha256 = hash;
    return hash;
  }
}
export function requireSync(result) {
  if (result?.then) {
    Promise.resolve(result).catch(() => {}); // observe a rejected tail; it never authorizes a send
    throw Error('SYNC_JOURNAL_REQUIRED');
  }
  return result;
}
