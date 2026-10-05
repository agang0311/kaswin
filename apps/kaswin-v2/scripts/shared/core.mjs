/** Kaswin Opus core: pinned F3.2 constants and re-exports of the audited core package (no new protocol logic here). */
export {hex, unhex, cat, le, fromLe, ascii, stable, check, kasToSompi, sompiToKas, same} from '../../../../packages/f3.2-core/lib/bytes.js';
export * as S from '../../../../packages/f3.2-core/lib/state.js';
export {transition, availableActions, sample, authenticateDraw, winnerRecord, timeoutDaa, actionBudget, actionUnits, ACTIONS, BUDGET_MARGIN} from '../../../../packages/f3.2-core/lib/protocol.js';
export {buildAction, buildOpenGenesis, assertDraft, pushInt} from '../../../../packages/f3.2-core/lib/builders.js';
export {makeProfile, COMPILER_COMMIT} from '../../../../packages/f3.2-core/lib/artifacts.js';
export {acquirePassA, COINBASE_LANE_KEY} from '../../../../packages/f3.2-core/lib/pass-a.js';
export {referenceTxId} from '../../../../packages/f3.2-core/lib/transaction.js';
export {p2pk, p2sh, covenantId} from '../../../../packages/f3.2-core/lib/covenant-id.js';
export {blake2b256} from '../../../../packages/f3.2-core/lib/hashes.js';
export {DEFAULT_REGISTRY_SPK, DEFAULT_REGISTRY_ADDRESS, REGISTRATION_SOMPI} from '../../../../packages/f3.2-core/lib/registry.js';
export {IndexedStore} from '../../../../packages/f3.2-core/lib/persistence.js';

export const PROFILE_ID = '7ca61d81be1a2448d16b18cb2bdce845c91ed4993a6da0fd26b14d211fbce863';
export const NETWORK_GENESIS = 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';
export const NETWORK_ID = 'testnet-10';
export const ADDRESS_PREFIX = 'kaspatest';
export const KASWARE_NETWORK = 'kaspa_testnet_10';
export const CONTRACT_TAG = 'kaswin-f3@' + PROFILE_ID.slice(0, 16);
export const EXPLORER = 'https://tn10.kaspa.stream';
/** rusty-kaspa cfafeb4 TESTNET_PARAMS: 10 blocks/s target; DAA score advances ~10/s. Approximation for UI timing only. */
export const DAA_PER_SECOND = 10;
/** Project policy: never authorize a network fee above 0.5 TKAS (equals the contract's MAX_PAY_FEE). */
export const FEE_CAP = 50_000_000n;
/** P2PK funding input: one OpCheckSig = 100,000 script units > 9,999 free; 10 units of budget cover it (VM-measured). */
export const FUNDING_INPUT_BUDGET = 10;
/** Selected-chain finality depth (TN10 10 BPS x 43,200 s): OpChainblockSeqCommit only resolves T within this blue-score depth. */
export const SEQ_COMMIT_DEPTH = 432_000n;
export const HASH = /^[0-9a-f]{64}$/;

export class UserError extends Error {
  constructor(message, code = 'USER') { super(message); this.name = 'UserError'; this.code = code; }
}
export function ensure(value, message, code) { if (!value) throw new UserError(message, code); return value; }
export function hash32(v, what = '哈希') { ensure(typeof v === 'string' && HASH.test(v), `${what}必须是 64 位小写十六进制`); return v; }
export const errorText = e => (e && typeof e === 'object' && 'message' in e) ? String(e.message) : String(e);

/** Exact sompi → decimal TKAS text, trailing zeros trimmed. */
export function kas(sompi, {plus = false} = {}) {
  const v = typeof sompi === 'bigint' ? sompi : BigInt(sompi);
  const neg = v < 0n, a = neg ? -v : v, whole = a / 100_000_000n, frac = (a % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : plus && v > 0n ? '+' : '') + w + (frac ? '.' + frac : '');
}
export const shortHash = (h, a = 8, b = 6) => !h ? '—' : h.length <= a + b + 1 ? h : `${h.slice(0, a)}…${h.slice(-b)}`;
export function escapeHtml(v) { return String(v).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
/** Approximate wall-clock duration for a DAA delta (TN10 ~10 DAA/s). */
export function daaDuration(delta) {
  const d = typeof delta === 'bigint' ? Number(delta) : delta;
  if (!Number.isFinite(d)) return '—';
  const s = Math.max(0, Math.round(d / DAA_PER_SECOND));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor(s % 3600 / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor(s % 86400 / 3600)} 小时`;
}
export const explorerTx = txid => `${EXPLORER}/transactions/${txid}`;
export const explorerAddress = a => `${EXPLORER}/addresses/${a}`;
export const explorerBlock = h => `${EXPLORER}/blocks/${h}`;
