/** Kaswin V2.0.2 protocol exports and network-neutral formatting. */
export {CONTRACT_VERSION, PROFILE_ID, CONTRACT_TAG, requireRuntimeVersion, requireRuntimeProfile} from './contract/runtime.mjs';
export {hex, unhex, cat, le, fromLe, ascii, stable, check, kasToSompi, sompiToKas, same} from './core/lib/bytes.js';
export * as S from './core/lib/state.js';
export {transition, availableActions, sample, authenticateDraw, drawWinner, recordOfTicket, refundBatch, timeoutDaa, actionBudget, actionUnits, ACTIONS, BUDGET_MARGIN} from './core/lib/protocol.js';
import {requireRuntimeProfile} from './contract/runtime.mjs';
import {buildAction as coreBuildAction, buildOpenGenesis as coreBuildOpenGenesis} from './core/lib/builders.js';
export {assertDraft, pushInt} from './core/lib/builders.js';
export function buildAction(snapshot, profile, ...args) { requireRuntimeProfile(profile); return coreBuildAction(snapshot, profile, ...args); }
export function buildOpenGenesis(profile, ...args) { requireRuntimeProfile(profile); return coreBuildOpenGenesis(profile, ...args); }
export {makeProfile, COMPILER_COMMIT} from './core/lib/artifacts.js';
export {acquirePassA, COINBASE_LANE_KEY} from './core/lib/pass-a.js';
export {referenceTxId} from './core/lib/transaction.js';
export {p2pk, p2sh, covenantId} from './core/lib/covenant-id.js';
export {blake2b256} from './core/lib/hashes.js';
export {REGISTRATION_SOMPI} from './core/lib/registry.js';
export {IndexedStore} from './core/lib/persistence.js';

/** rusty-kaspa cfafeb4 TESTNET_PARAMS: 10 blocks/s target; DAA score advances ~10/s. Approximation for UI timing only. */
export const DAA_PER_SECOND = 10;
/** Project policy: never authorize a network fee above 0.5 TKAS (equals the contract's MAX_PAY_FEE). */
export const FEE_CAP = 50_000_000n;
/** Same ordinary-input default as the core builder; no web-only budget patching. */
export {FUNDING_INPUT_BUDGET} from './core/lib/protocol.js';
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

