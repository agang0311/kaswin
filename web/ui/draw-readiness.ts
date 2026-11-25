/** Display-only countdown backed by active Locale. Wall-clock estimates never unlock an action or increment observed chain scores. */
import {DRAW_DELAY, TIMEOUT_DELAY} from '../../scripts/core.mjs';
import type {Ctx, Detail} from '../app/types.ts';
import {getLocale} from './locales/index.ts';

interface Readiness {ready: boolean; label: string; button: string; detail: string; percent: number | null}

const estimatedSeconds = (remaining: bigint, observedAt: number | undefined, now: number): bigint => {
  const elapsed = observedAt ? BigInt(Math.max(0, Math.floor((now - observedAt) / 1000))) : 0n;
  const seconds = (remaining + 9n) / 10n;
  return seconds > elapsed ? seconds - elapsed : 0n;
};

export function drawReadiness(D: Detail, x: Ctx, now = Date.now()): Readiness {
  const d = (x.L ?? getLocale()).drawReadiness;
  const manager = D.r.manager, daa = x.daa;
  const checking: Readiness = {ready: false, label: d.checkingLabel, button: d.checkingButton, detail: d.checkingDetail, percent: null};
  if (!manager || daa === null) return checking;
  const current = daa > manager.utxoDaa ? daa : manager.utxoDaa, boundary = manager.utxoDaa + DRAW_DELAY;
  if (current >= manager.utxoDaa + TIMEOUT_DELAY - 1000n) {
    return {ready: false, label: d.windowClosedLabel, button: d.windowClosedButton, detail: d.windowClosedDetail, percent: null};
  }
  if (current < boundary) {
    const remaining = boundary - current, seconds = estimatedSeconds(remaining, x.daaObservedAt, now);
    return {
      ready: false,
      label: d.sealWaitLabel,
      button: d.sealWaitButton,
      detail: seconds > 0n ? d.sealWaitDetail(remaining, seconds) : d.sealWaitArrived,
      percent: Number((DRAW_DELAY - remaining) * 100n / DRAW_DELAY),
    };
  }
  const p = x.drawProgress;
  if (!p || p.phase === 'CHECKING') return {...checking, label: d.locateTargetLabel};
  if (p.phase === 'UNAVAILABLE' || now - p.observedAt > 15000) return {...checking, label: d.unavailableLabel, detail: d.unavailableDetail};
  const count = p.confirmations ?? 0n, required = p.requiredConfirmations;
  if (p.phase === 'READY' && required > 0n && count >= required) {
    return {ready: true, label: d.readyLabel, button: d.readyButton, detail: d.readyDetail(count, required), percent: 100};
  }
  if (required <= 0n) return checking;
  const remaining = required > count ? required - count : 0n, seconds = estimatedSeconds(remaining, p.observedAt, now);
  return {
    ready: false,
    label: d.targetConfirmLabel,
    button: d.targetConfirmButton,
    detail: seconds > 0n ? d.targetConfirmDetail(count, required, seconds) : d.targetConfirmWaiting(count, required),
    percent: Number((count > required ? required : count) * 100n / required),
  };
}
