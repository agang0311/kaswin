/** Consensus mass and fee quoting, ported from rusty-kaspa cfafeb4:
 *  consensus/core/src/mass/mod.rs (calc_non_contextual_masses, calc_storage_mass, utxo_plurality)
 *  mining/src/mempool/check_transaction_standard.rs (relay floor = max(compute, normalizedTransient) * 100000/1000, min 100000).
 * TESTNET_PARAMS: mass_per_tx_byte=1, mass_per_script_pub_key_byte=10, storage C = 10^12, block compute/storage 500000,
 * transient 1,000,000 post-Toccata (normalization factor 0.5), GRAMS_PER_COMPUTE_BUDGET_UNIT=100.
 * Default page fee ('load') = max(relay floor, ceil(node feerate × max(compute, normalizedTransient, storage))), clamped
 * to FEE_CAP but never below the relay admission minimum. The node estimate (getFeeEstimate) is per gram of that same
 * ordering mass (mining/src/mempool/model/frontier/feerate_key.rs from_tx).
 */
import {assertDraft, FEE_CAP, ensure} from './core.mjs';

const C = 1_000_000_000_000n, U64 = (1n << 64n) - 1n;
const bytesOf = h => BigInt(h.length / 2);
/** Every authorized (wallet) input is quoted with the final signed size: 66-byte signature script. */
export const SIGNED_SCRIPT_BYTES = 66n;
const plurality = (spkScriptHex, covenant) => (63n + bytesOf(spkScriptHex) + (covenant ? 32n : 0n) + 99n) / 100n;

export function storageMass(inputs, outputs) {
  const outs = outputs.map(o => ({p: plurality(o.scriptPublicKey.script, !!o.covenant), v: o.value}));
  const ins = inputs.map(f => ({p: plurality(f.spk.script, !!f.covenantId), v: f.value}));
  ensure(ins.length > 0 && outs.length > 0 && [...ins, ...outs].every(c => c.v > 0n), 'MASS_INPUTS');
  let op = 0n, harmonicOut = 0n;
  for (const o of outs) { op += o.p; harmonicOut += C * o.p * o.p / o.v; ensure(harmonicOut <= U64, 'MASS_OVERFLOW'); }
  const ip = ins.reduce((a, c) => a + c.p, 0n);
  const relaxed = op === 1n || (ins.length <= 2 && (ip === 1n || (op === 2n && ip === 2n)));
  if (relaxed) {
    let harmonicIn = 0n; for (const i of ins) harmonicIn += C * i.p * i.p / i.v; if (harmonicIn > U64) harmonicIn = U64;
    return harmonicOut > harmonicIn ? harmonicOut - harmonicIn : 0n;
  }
  const sum = ins.reduce((a, c) => a + c.v, 0n), mean = sum / ip > 0n ? sum / ip : 1n;
  let arith = ip * (C / mean); if (arith > U64) arith = U64;
  return harmonicOut > arith ? harmonicOut - arith : 0n;
}

/** Masses of the FINAL transaction (authorized inputs counted at signed size), without limit enforcement. */
export function massOf(draft) {
  assertDraft(draft);
  const t = draft.transaction, auth = new Set(draft.authorizedInputIndices);
  ensure(t.version === 1 && t.subnetworkId === '00'.repeat(20) && t.gas === 0n, 'MASS_V1_ONLY');
  let size = 2n + 8n + 8n + 8n + 20n + 8n + 32n + 8n + bytesOf(t.payload), budget = 0n, spkBytes = 0n;
  t.inputs.forEach((i, n) => {
    const sig = auth.has(n) ? SIGNED_SCRIPT_BYTES : bytesOf(i.signatureScript);
    size += 32n + 4n + 8n + sig + 8n + 2n;
    budget += BigInt(i.computeBudget ?? 0);
  });
  for (const o of t.outputs) { const len = bytesOf(o.scriptPublicKey.script); size += 8n + 2n + 8n + len + (o.covenant ? 34n : 0n); spkBytes += 2n + len; }
  const computeMass = size + spkBytes * 10n + budget * 100n, transientMass = size * 4n, normalizedTransient = (transientMass + 1n) / 2n;
  const storage = storageMass(draft.inputUtxos, t.outputs);
  const feeMass = computeMass > normalizedTransient ? computeMass : normalizedTransient;
  const relayFloor = feeMass * 100n > 100_000n ? feeMass * 100n : 100_000n;
  return {size, computeMass, transientMass, normalizedTransient, storageMass: storage, feeMass, relayFloor};
}
export class MassLimitError extends Error { constructor(q) { super(q.storageMass > 500_000n ? 'STORAGE_MASS_LIMIT' : 'COMPUTE_MASS_LIMIT'); this.quote = q; } }
/** Masses with the TN10 block-fit limits enforced (compute/storage 500,000; transient 1,000,000). */
export function quoteMass(draft) {
  const q = massOf(draft);
  if (q.computeMass > 500_000n || q.transientMass > 1_000_000n || q.storageMass > 500_000n) throw new MassLimitError(q);
  return q;
}

/** Exact rational for the node's JS-number feerate (sompi/gram), no float multiplication of mass. */
export function rateFraction(v) {
  ensure(typeof v === 'number' && Number.isFinite(v) && v > 0, '节点费率无效');
  const [m, e = '0'] = v.toString().toLowerCase().split('e'), [a, b = ''] = m.split('.'), scale = b.length - Number(e);
  ensure(Math.abs(scale) <= 30, '节点费率超出范围');
  return scale > 0 ? {n: BigInt(a + b), d: 10n ** BigInt(scale)} : {n: BigInt(a + b) * 10n ** BigInt(-scale), d: 1n};
}

/** Fee rule:
 *  - 'standard' (default, what every accepted F3.x TN10 transaction paid): max(relay floor, ceil(feerate × max(compute, normalizedTransient))).
 *    This is the mempool admission minimum (check_transaction_standard.rs); storage mass carries no extra relay floor there.
 *  - 'priority': ceil(feerate × max(compute, normalizedTransient, storage)) — mempool priority ordering uses the
 *    normalized max including storage (consensus/core tx.rs calculated_feerate), so this ranks like a normal tx under load.
 * Monotonically raise fee until the FINAL draft satisfies every requirement. A small
 * overestimate is allowed; a cycle never lowers the candidate. No unchecked fallback. */
/**  - 'load': the page default. 'priority' pricing (what the node's feerate estimate refers to), clamped to the cap but
 *    never below the 'standard' admission minimum. Under load (e.g. TN10 stress tests) a fee priced on compute/transient
 *    only is admitted to the mempool yet can wait there indefinitely when storage mass dominates the ordering mass.
 *    `clamped: true` means the cap kept the fee below the node's estimate: the transaction may queue. */
export function convergeFee(makeDraft, feerate, {cap = FEE_CAP, mode = 'standard'} = {}) {
  ensure(typeof cap === 'bigint' && cap > 0n && cap <= FEE_CAP, '手续费上限无效');
  ensure(['standard', 'priority', 'load'].includes(mode), '手续费模式无效');
  const {n, d} = rateFraction(feerate);
  let fee = 100_000n;
  for (let i = 0; i < 24; i++) {
    ensure(fee <= cap, `网络费 ${fee} sompi 超过保护上限`);
    const draft = makeDraft(fee);
    ensure(draft.fee === fee, '构建器费用与候选费用不一致');
    const q = quoteMass(draft);
    const ordering = [q.computeMass, q.normalizedTransient, q.storageMass].reduce((a, b) => a > b ? a : b);
    const atRate = mass => { const v = (mass * n + d - 1n) / d; return v > q.relayFloor ? v : q.relayFloor; };
    const standard = atRate(q.feeMass), byOrdering = atRate(ordering);
    ensure(standard <= cap, `网络费 ${standard} sompi 超过保护上限`);
    let required = mode === 'standard' ? standard : byOrdering, clamped = false;
    if (mode === 'load' && required > cap) { required = cap; clamped = true; }
    ensure(required <= cap, `网络费 ${required} sompi 超过保护上限`);
    if (fee >= required) {
      draft.transaction.storageMass = q.storageMass;
      // Effective mempool ordering feerate of the final draft, sompi/gram with 2 decimals (exact integer arithmetic).
      const centi = fee * 100n / ordering, orderingFeerate = `${centi / 100n}.${String(centi % 100n).padStart(2, '0')}`;
      return {draft, fee, quote: q, feerate, iterations: i + 1, mode, orderingMass: ordering, orderingFeerate, standardFee: standard, loadFee: byOrdering, clamped: clamped && fee < byOrdering};
    }
    fee = required;
  }
  throw new Error('费用计算未收敛，未生成可提交报价');
}
