/** Protocol-independent input reservations. Same database/network, across Profiles.
 * Never decode another Profile or release UNKNOWN on a timeout. */
const HASH = /^[0-9a-f]{64}$/;
const inputKey = o => {
  if (!HASH.test(o?.transactionId ?? '') || !Number.isInteger(o?.index) || o.index < 0 || o.index > 0xffffffff) throw Error('INPUT_RESERVATION_OUTPOINT_INVALID');
  return `${o.transactionId}:${o.index}`;
};
export function reservedFromRows(rows, networkGenesis) {
  if (!HASH.test(networkGenesis)) throw Error('RESERVATION_NETWORK');
  const prefix = `${networkGenesis}/`, reserved = new Set();
  for (const {key, record} of rows) {
    if (!key.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).split('/');
    if (parts.length !== 3 || parts[1] !== 'tx') continue;
    const r = record?.value;
    if (!HASH.test(parts[0]) || !HASH.test(parts[2]) || !r || typeof r.status !== 'string') throw Error('INPUT_RESERVATION_RECORD_INVALID');
    if (r.status === 'REJECTED' || r.status === 'ARCHIVED') continue;
    if (!Array.isArray(r.inputs) || r.inputs.length === 0) throw Error('INPUT_RESERVATION_RECORD_INVALID');
    for (const o of r.inputs) reserved.add(inputKey(o));
  }
  return reserved;
}
export async function reservedInputs(store, networkGenesis) {
  return reservedFromRows(await store.list(`${networkGenesis}/`), networkGenesis);
}
/** Required for submit; no non-atomic list()+CAS fallback for custom stores. */
export async function persistIntent(store, networkGenesis, key, record, lease = null) {
  if (!HASH.test(networkGenesis) || !key.startsWith(`${networkGenesis}/`)) throw Error('RESERVATION_NETWORK');
  if (typeof store.insertIfAbsentWithCheck !== 'function') throw Error('ATOMIC_INTENT_STORE_REQUIRED');
  const parts = key.slice(networkGenesis.length + 1).split('/');
  if (parts.length !== 3 || !HASH.test(parts[0]) || parts[1] !== 'tx' || !HASH.test(parts[2]) || record.txid !== parts[2] ||
      record.status !== 'SUBMITTING' || !Array.isArray(record.inputs) || record.inputs.length === 0) throw Error('INPUT_RESERVATION_RECORD_INVALID');
  const inputs = record.inputs.map(inputKey);
  if (new Set(inputs).size !== inputs.length) throw Error('DUPLICATE_INPUT');
  // Include the lease and ALL legacy/current Profile journals in the same transaction.
  return store.insertIfAbsentWithCheck(key, record, '', rows => {
    if (lease) {
      const r = rows.find(r => r.key === lease.key)?.record?.value;
      if (r?.owner !== lease.owner || !(r.until > Date.now())) throw Error('SUBMIT_LEASE_LOST');
    }
    const reserved = reservedFromRows(rows, networkGenesis);
    if (inputs.some(o => reserved.has(o))) throw Error('INPUT_ALREADY_RESERVED');
  });
}
