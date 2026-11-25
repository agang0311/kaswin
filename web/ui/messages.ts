/** User-facing wording facade backed by the active Locale (display only; never decides protocol validity). */
import type {Round, Facts, Phase} from '../app/types.ts';
import {getLocale, ZH_CN} from './locales/index.ts';
import type {Locale} from './locales/index.ts';

export const UNIT = 'TKAS';

/** Static default table (zh-CN) preserved for callers inspecting keys / `free` flag; rendered views use `L.actions.info`. */
export const ACTION_INFO: Record<string, {title: string; verb: string; free: boolean; desc: string}> = Object.fromEntries(
  Object.entries(ZH_CN.actions.info).map(([k, v]) => [k, {title: v.title, verb: v.verb, free: v.free, desc: v.desc(UNIT)}]),
);

export const actionTitle = (action: string, L: Locale = getLocale()): string =>
  L.actions.info[action]?.title ?? L.actions.extraTitle[action] ?? action;

export const ROLE_LABEL: Record<string, string> = ZH_CN.actions.roleLabel;
export const roleLabel = (role: string, L: Locale = getLocale()): string => L.actions.roleLabel[role] ?? role;

export const TERMINAL_LABEL: Record<string, string> = ZH_CN.actions.terminalLabel;
export const terminalLabel = (term: string, L: Locale = getLocale()): string => L.actions.terminalLabel[term] ?? term;

const codeOf = (e: unknown): unknown =>
  typeof e === 'string' ? e : (e as {code?: unknown; message?: unknown} | null | undefined)?.code ?? (e as {message?: unknown} | null | undefined)?.message;

/** UserError (code 'USER') carries a designed, user-facing sentence: show it directly instead of a bare code. */
const userMessage = (e: unknown): string | null => {
  const m = e as {code?: unknown; message?: unknown} | null | undefined;
  return m && m.code === 'USER' && typeof m.message === 'string' && m.message.length >= 4 && m.message.length <= 200 ? m.message : null;
};

export function errText(e: unknown, L: Locale = getLocale()): string {
  const um = userMessage(e);
  if (um) return um;
  const code = codeOf(e);
  if (typeof code === 'string' && L.errors.map[code]) return L.errors.map[code];
  const safe = typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code) ? code : 'UNKNOWN';
  return L.errors.fallback(safe);
}

export const errCode = (e: unknown): string => {
  const c = codeOf(e);
  return typeof c === 'string' && /^[A-Z0-9_]{2,64}$/.test(c) ? c : 'UNKNOWN';
};

export function phaseOf(r: Pick<Round, 'halted' | 'terminal' | 'manager' | 'intent'>, f: Pick<Facts, 'module'> | null | undefined, L: Locale = getLocale()): Phase {
  const p = L.actions.phaseLabel;
  if (r.halted) return {key: 'halted', label: p.halted, tone: 'amber'};
  if (r.terminal) {
    if (r.terminal === 'PAID') return {key: 'paid', label: p.paid, tone: 'gold'};
    if (r.terminal === 'EMPTY') return {key: 'empty', label: p.empty, tone: 'muted'};
    if (r.terminal === 'REFUNDED') return {key: 'refunded', label: p.refunded, tone: 'muted'};
    return {key: 'done', label: String(r.terminal), tone: 'muted'};
  }
  if (r.intent?.action === 'GENESIS') return {key: 'new', label: p.awaitingGenesis, tone: 'amber'};
  if (!r.manager) {
    if (f?.module === 'refund') return {key: 'refund', label: p.refund, tone: 'amber'};
    if (f?.module === 'win') return {key: 'paying', label: p.paying, tone: 'gold'};
    return {key: 'new', label: p.awaitingGenesis, tone: 'amber'};
  }
  if (f?.module === 'sales') return {key: 'open', label: p.open, tone: 'mint'};
  if (f?.module === 'sealed') return {key: 'sealed', label: p.sealed, tone: 'violet'};
  if (f?.module === 'win') return {key: 'paying', label: p.paying, tone: 'gold'};
  if (f?.module === 'refund') return {key: 'refund', label: p.refund, tone: 'amber'};
  return {key: 'new', label: p.loading, tone: 'amber'};
}

export const CLOSE_PRESETS: readonly [string, string][] = ZH_CN.actions.closePresets;
