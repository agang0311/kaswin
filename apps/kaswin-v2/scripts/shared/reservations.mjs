/** Protocol-independent input reservations. Never decode another Profile's ledger or release its records.
 * Same IndexedDB + network only; records()/reconcile()/archive() remain current-Profile operations.
 */
const HASH = /^[0-9a-f]{64}$/;
export async function reservedInputs(store, networkGenesis) {
  if (!HASH.test(networkGenesis)) throw Error('RESERVATION_NETWORK');
  const prefix = `${networkGenesis}/`, reserved = new Set();
  for (const {key, record} of await store.list(prefix)) {
    const parts = key.slice(prefix.length).split('/');
    if (parts.length !== 3 || parts[1] !== 'tx') continue; // Round caches and locks are not intents.
    const r = record?.value;
    if (!HASH.test(parts[0]) || !HASH.test(parts[2]) || !r || typeof r.status !== 'string') throw Error('INPUT_RESERVATION_RECORD_INVALID');
    if (r.status === 'REJECTED' || r.status === 'ARCHIVED') continue;
    // Unknown statuses also reserve inputs. Corrupt intent data blocks spending rather than silently releasing it.
    if (!Array.isArray(r.inputs) || r.inputs.length === 0) throw Error('INPUT_RESERVATION_RECORD_INVALID');
    for (const o of r.inputs) {
      if (!HASH.test(o?.transactionId ?? '') || !Number.isInteger(o?.index) || o.index < 0 || o.index > 0xffffffff) throw Error('INPUT_RESERVATION_OUTPOINT_INVALID');
      reserved.add(`${o.transactionId}:${o.index}`);
    }
  }
  return reserved;
}
