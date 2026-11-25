/** Locale registry & switching helpers (mirrors scripts/chain/ network switching). */
import {ZH_CN} from './zh-cn.ts';
import {EN} from './en.ts';
import type {Locale, LocaleKey} from './schema.ts';

export type {Locale, LocaleKey} from './schema.ts';
export {defineLocale, requireLocale} from './schema.ts';
export {ZH_CN} from './zh-cn.ts';
export {EN} from './en.ts';

export const LOCALES: readonly Locale[] = Object.freeze([ZH_CN, EN]);
const BY_KEY: ReadonlyMap<string, Locale> = new Map(LOCALES.map(l => [l.key, l]));

let current: Locale = ZH_CN;

export function resolveLocale(saved?: string | null, languages: readonly string[] = []): Locale {
  if (saved) {
    const exact = BY_KEY.get(saved);
    if (exact) return exact;
    if (/^en\b/i.test(saved)) return EN;
    if (/^zh\b/i.test(saved)) return ZH_CN;
  }
  const first = languages[0] ?? 'zh';
  return /^zh\b/i.test(first) ? ZH_CN : EN;
}

export function getLocale(): Locale { return current; }
export function setLocale(keyOrLocale: string | Locale): Locale {
  current = typeof keyOrLocale === 'string' ? resolveLocale(keyOrLocale) : keyOrLocale;
  return current;
}
export function nextLocale(loc: Locale = current): Locale {
  const idx = LOCALES.findIndex(l => l.key === loc.key);
  return LOCALES[(idx + 1 + LOCALES.length) % LOCALES.length] ?? ZH_CN;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
export function formatLocalTime(timestamp: number, L: Locale = current): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return '—';
  let fmt = timeFormatters.get(L.timeLocale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(L.timeLocale, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'shortOffset',
    });
    timeFormatters.set(L.timeLocale, fmt);
  }
  return fmt.format(timestamp);
}

/** Localize the fixed protocol-layer action reason strings produced by scripts/round/round.mjs & kusdt-v2/round.mjs. */
export function localizeActionReason(reason: string | undefined, L: Locale = current): string {
  if (!reason) return '';
  if (L.key === 'zh-CN') return reason;
  const exact: Record<string, string> = {
    '当前不可购买': 'Buying is not available right now',
    '当前不可封盘': 'Closing is not available right now',
    '当前不可开奖': 'Drawing is not available right now',
    '不适用': 'Not applicable',
    '不可用': 'Unavailable',
    '尚未满足封盘条件': 'Close conditions not yet met',
    '封盘满 100 DAA 后可开奖': 'Draw unlocks 100 DAA after closing',
    '封盘逾 12 小时未开奖可重掷': 'Reroll unlocks ~12 hours after closing if undrawn',
    '售卖已满/容量已满': 'Sold out / capacity reached',
    '已接近/超过超时窗口，不再抽奖': 'Near or past timeout window; draw disabled',
    '没有旧分片待支付': 'No sealed shards pending payout',
    '不满足自支付边界': 'Self-payout boundary not met',
    '没有旧分片待退款': 'No sealed shards pending refund',
    '不满足自退款边界': 'Self-refund boundary not met',
    '存在未完成交易意图：请先等待接受 / 恢复，不能新建交易': 'An unconfirmed transaction exists; wait for acceptance or recover first',
    '尚无 manager UTXO（创建交易未被接受）': 'No manager UTXO yet (genesis tx not accepted)',
    '本机记录无法按固定 Profile 解析': L.app.recordUnreadable,
  };
  if (exact[reason]) return exact[reason];
  let m: RegExpExecArray | null;
  if ((m = /^尚未到可封盘 DAA，还差 (\d+)$/.exec(reason))) return `${m[1]} DAA remaining before closing`;
  if ((m = /^尚未到可关闭 DAA，还差 (\d+)（约 (.+)）$/.exec(reason))) return `${m[1]} DAA remaining before closing`;
  if ((m = /^DRAW 需再等 (\d+) DAA（约 (.+)）$/.exec(reason))) return `Draw unlocks in ${m[1]} DAA`;
  if ((m = /^超时需再等 (\d+) DAA（约 (.+)）$/.exec(reason))) return `Timeout unlocks in ${m[1]} DAA`;
  if ((m = /^轮次已终结（(.+)）$/.exec(reason))) return `Round ended (${m[1]})`;
  if ((m = /^当前阶段（(.+)）不适用$/.exec(reason))) return `Not applicable in phase (${m[1]})`;
  if ((m = /^轮次已停止（(.+)）：/.exec(reason))) return L.round.haltedHint(m[1]!);
  return reason;
}

/** Localize input kind strings produced by protocol adapters. */
export function localizeReviewInputKind(kind: string, L: Locale = current): string {
  if (L.key === 'zh-CN') return kind;
  const exact: Record<string, string> = {
    '需签名（你的钱包）': 'Signed (your wallet)',
    '合约 UTXO': 'Covenant UTXO',
    '普通输入（需签名）': 'Wallet input (signed)',
    'covenant 输入': 'Covenant input',
    '免签输入': 'Unsigned input',
  };
  if (exact[kind]) return exact[kind];
  const m = /^需签名（你的 ([A-Za-z0-9_-]+)）$/.exec(kind);
  if (m) return `Signed (your ${m[1]})`;
  return kind;
}

/** Localize output note strings produced by protocol adapters. */
export function localizeReviewNote(note: string, L: Locale = current): string {
  if (L.key === 'zh-CN') return note;
  const exact: Record<string, string> = {
    '你垫付的轮次总管押金（结算后全额退回）': 'Round manager deposit you fund (returned in full on settlement)',
    '索引登记输出（用于探索列表发现，不可退）': 'Index registry output (for plaza discovery, non-refundable)',
    '原轮次总管 4 KAS 押金滚存（创建者押金，非你支出）': 'Existing round manager 4 KAS deposit rollover (creator deposit, not spent by you)',
    '原分片 2 KAS 押金滚存并封存（非你支出）': 'Existing shard 2 KAS deposit rollover & seal (not spent by you)',
    '合约退回你的 4 KAS 创建者押金': 'Contract returns your 4 KAS creator deposit',
    '合约退回创建者的 4 KAS 押金（非你支出）': 'Contract returns creator’s 4 KAS deposit (not spent by you)',
    '合约退回你的 4 KAS 分片押金': 'Contract returns your 4 KAS shard deposit',
    '合约退回首购者的 4 KAS 分片押金（非你支出）': 'Contract returns first buyer’s 4 KAS shard deposit (not spent by you)',
    '你垫付的新分片账本押金（分片结清时原路退回给你）': 'Your new shard ledger deposit (returned in full when shard settles)',
    '原分片账本 2 KAS 押金滚存（首购者垫付，非你支出）': 'Existing shard ledger 2 KAS deposit rollover (first buyer’s, not spent by you)',
    '原分片 2 KAS 押金滚存并转入可领款状态（非你支出）': 'Existing shard 2 KAS deposit rollover to claimable state (not spent by you)',
    '原分片账本 2 KAS 押金滚存（非你支出）': 'Existing shard ledger 2 KAS deposit rollover (not spent by you)',
    '退回你钱包的普通 KAS 找零': 'Ordinary KAS change returned to your wallet',
  };
  if (exact[note]) return exact[note];
  let m: RegExpExecArray | null;
  if ((m = /^你支付的 ([0-9.]+) ([A-Za-z0-9_-]+) 票款存入新分片金库 \+ 你垫付 2 KAS 可退押金$/.exec(note)))
    return `Your ${m[1]} ${m[2]} ticket payment into new shard vault + 2 KAS refundable deposit`;
  if ((m = /^你本次支付的 ([0-9.]+) ([A-Za-z0-9_-]+) 票款存入此金库（金库现存 ([0-9.]+) ([A-Za-z0-9_-]+)）；2 KAS 为原押金滚存，非你支出$/.exec(note)))
    return `Your ${m[1]} ${m[2]} ticket payment into vault (vault total ${m[3]} ${m[4]}); 2 KAS is existing deposit rollover`;
  if ((m = /^剩余未领票款 ([0-9.]+) ([A-Za-z0-9_-]+) 留存金库（2 KAS 原押金滚存，非你支出）$/.exec(note)))
    return `Remaining ${m[1]} ${m[2]} unclaimed tickets stay in vault (2 KAS deposit rollover)`;
  if ((m = /^退回你的 ([0-9.]+) ([A-Za-z0-9_-]+) 找零（含 1 KAS 代币载体，仍归你所有）$/.exec(note)))
    return `Your ${m[1]} ${m[2]} change returned (incl. 1 KAS token carrier, still yours)`;
  if ((m = /^你的 ([0-9.]+) ([A-Za-z0-9_-]+) 中奖奖金（含 1\.5 KAS 代币载体，仍归你所有）$/.exec(note)))
    return `Your ${m[1]} ${m[2]} winning prize (incl. 1.5 KAS token carrier, still yours)`;
  if ((m = /^发给中奖者的 ([0-9.]+) ([A-Za-z0-9_-]+) 奖金（含你垫付的 1\.5 KAS 载体，不可退）$/.exec(note)))
    return `${m[1]} ${m[2]} prize sent to winner (incl. 1.5 KAS carrier you fund, non-refundable)`;
  if ((m = /^你的 ([0-9.]+) ([A-Za-z0-9_-]+) 代推激励（含 1\.5 KAS 代币载体，仍归你所有）$/.exec(note)))
    return `Your ${m[1]} ${m[2]} executor incentive (incl. 1.5 KAS token carrier, still yours)`;
  if ((m = /^退回你的 ([0-9.]+) ([A-Za-z0-9_-]+) 票款（含 1\.5 KAS 代币载体，仍归你所有）$/.exec(note)))
    return `Your ${m[1]} ${m[2]} ticket refund (incl. 1.5 KAS token carrier, still yours)`;
  if ((m = /^退回买家的 ([0-9.]+) ([A-Za-z0-9_-]+) 票款（含 1\.5 KAS 载体，不可退）$/.exec(note)))
    return `${m[1]} ${m[2]} ticket refund sent to buyer (incl. 1.5 KAS carrier, non-refundable)`;
  return note;
}
