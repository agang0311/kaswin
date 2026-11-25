import type {BuyShardSelectorModel} from './types.ts';

export type BuyShardOption = BuyShardSelectorModel['options'][number];
export const BUY_SHARD_CONGESTION_THRESHOLD = 3;

export function pickRandomBuyShard(
  options: readonly BuyShardOption[],
  exclude: ReadonlySet<string> = new Set(),
  rng: () => number = Math.random,
  {allowFallback = false}: {allowFallback?: boolean} = {},
): BuyShardOption | null {
  if (!options.length) return null;
  const fresh = options.filter(o => !exclude.has(o.shardId));
  const pool = fresh.length ? fresh : (allowFallback ? options : []);
  if (!pool.length) return null;
  const raw = rng();
  const clamped = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999999) : 0;
  return pool[Math.floor(clamped * pool.length)] ?? pool[0]!;
}

export function isShardUtxoConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as {code?: unknown; safeCode?: unknown; message?: unknown};
  const code = String(rec.code ?? '');
  const safe = String(rec.safeCode ?? '');
  if (code === 'STALE_INPUT' || safe === 'STALE_INPUT' || safe === 'SHARD_FULL') return true;
  const msg = String(rec.message ?? '');
  return /\bSTALE_INPUT\b|outpoint.*(missing|spent|not found)|already spent|utxo.*(spent|missing|stale)/i.test(msg);
}

export function shouldWarnShardCongestion(
  conflictCount: number,
  selector: BuyShardSelectorModel | null | undefined,
): boolean {
  if (conflictCount < BUY_SHARD_CONGESTION_THRESHOLD) return false;
  if (!selector || !selector.canOpenNew) return false;
  return selector.activeOpenCount < selector.maxActiveOpen;
}
