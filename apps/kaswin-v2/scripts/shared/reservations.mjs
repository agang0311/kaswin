/** Protocol-independent input reservations. Same database/network, across Profiles.
 * Never decode another Profile or release UNKNOWN on a timeout. */
const HASH = /^[0-9a-f]{64}$/;
const inputKey = o => {
  if (!HASH.test(o?.transactionId ?? '') || !Number.isInteger(o?.index) || o.index < 0 || o.index > 0xffffffff) throw Error('INPUT_RESERVATION_OUTPOINT_INVALID');
  return `${o.transactionId}:${o.index}`;
};
/** Keys of the fee-bump family of `replacesKey` (original + every replacement, same root) that spend exactly the same
 * outpoints as it. Only these may be excluded when reserving inputs for a further replacement. */
export function familyKeys(rows, replacesKey) {
  const old = rows.find(r => r.key === replacesKey)?.record?.value;
  if (!old || !Array.isArray(old.inputs)) return new Set();
  const root = old.replaceRoot ?? old.txid, ins = old.inputs.map(inputKey).join(',');
  return new Set(rows.filter(r => { const v = r.record?.value; return v && (v.txid === root || v.replaceRoot === root) && Array.isArray(v.inputs) && v.inputs.map(inputKey).join(',') === ins; }).map(r => r.key));
}
export function reservedFromRows(rows, networkGenesis, except = null) {
  if (!HASH.test(networkGenesis)) throw Error('RESERVATION_NETWORK');
  const prefix = `${networkGenesis}/`, reserved = new Set();
  for (const {key, record} of rows) {
    if (!key.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).split('/');
    if (parts.length !== 3 || parts[1] !== 'tx') continue;
    const r = record?.value;
    if (!HASH.test(parts[0]) || !HASH.test(parts[2]) || !r || typeof r.status !== 'string') throw Error('INPUT_RESERVATION_RECORD_INVALID');
    if (r.status === 'REJECTED' || r.status === 'ARCHIVED' || r.status === 'SUPERSEDED' || except?.has(key)) continue;
    if (!Array.isArray(r.inputs) || r.inputs.length === 0) throw Error('INPUT_RESERVATION_RECORD_INVALID');
    for (const o of r.inputs) reserved.add(inputKey(o));
  }
  return reserved;
}
export async function reservedInputs(store, networkGenesis, replacesKey = null) {
  const rows = await store.list(`${networkGenesis}/`);
  return reservedFromRows(rows, networkGenesis, replacesKey ? familyKeys(rows, replacesKey) : null);
}
const OPEN_FOR_REPLACEMENT = new Set(['SUBMITTED', 'PENDING', 'UNKNOWN', 'RECHECKING']);
/** Required for submit; no non-atomic list()+CAS fallback for custom stores. */
/** `replaces`: key of this browser's own unsettled record that the new transaction replaces (fee bump). The new record
 * must spend EXACTLY the same outpoints (so the two conflict and at most one can be accepted); overlap with any other
 * record is still refused. Checked inside the same atomic insert. */
export async function persistIntent(store, networkGenesis, key, record, lease = null, replaces = null) {
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
    if (replaces) {
      const old = rows.find(r => r.key === replaces)?.record?.value;
      if (!old || !OPEN_FOR_REPLACEMENT.has(old.status) || old.replacedBy) throw Error('REPLACEMENT_TARGET_NOT_OPEN');
      const same = Array.isArray(old.inputs) && old.inputs.length === inputs.length && old.inputs.map(inputKey).every((o, i) => o === inputs[i]);
      if (!same) throw Error('REPLACEMENT_INPUTS_DIFFER');
      if (record.replaceRoot !== (old.replaceRoot ?? old.txid)) throw Error('REPLACEMENT_ROOT_MISMATCH');
    }
    const reserved = reservedFromRows(rows, networkGenesis, replaces ? familyKeys(rows, replaces) : null);
    if (inputs.some(o => reserved.has(o))) throw Error('INPUT_ALREADY_RESERVED');
  });
}
