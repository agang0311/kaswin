import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chooseLanguage, englishText, formatLocalTime, setLanguage, text} from '../visual/i18n.mjs';
import {EN} from '../visual/messages-en.mjs';
import {TX_STATUS, planSummary} from '../visual/view.mjs';

test('saved language wins; first browser language selects Chinese or English', () => {
  assert.equal(chooseLanguage('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(chooseLanguage('en', ['zh-TW']), 'en');
  assert.equal(chooseLanguage(null, ['zh-TW']), 'zh-CN');
  assert.equal(chooseLanguage('invalid', ['de-DE']), 'en');
  assert.equal(chooseLanguage(null), 'zh-CN');
});
test('catalog keys unique, placeholders preserved, safety statuses fully translated', () => {
  assert.equal(new Set(EN.map(([s]) => s)).size, EN.length);
  for (const [s, t] of EN) assert.deepEqual([...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), [...t.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), s);
  for (const s of Object.values(TX_STATUS)) {
    assert.doesNotMatch(englishText(s.label), /\p{Script=Han}/u);
    assert.doesNotMatch(englishText(s.meaning), /\p{Script=Han}/u);
  }
  assert.match(englishText(TX_STATUS.UNKNOWN.meaning), /remain reserved/);
  assert.match(englishText(TX_STATUS.REST_ACCEPTED.meaning), /not full node verification/);
  assert.match(englishText(TX_STATUS.ACCEPTED.meaning), /not irreversible finality/);
});
test('dynamic action summaries translate while preserving exact decimal amounts', () => {
  const en = englishText(planSummary({action: 'BUY', before: {sold: 0}, after: {sold: 3}, fee: 12345678n}));
  assert.match(en, /Buy 3 tickets, #1–#3/); assert.match(en, /0\.12345678 TKAS/);
  assert.doesNotMatch(en, /\p{Script=Han}/u);
  assert.equal(englishText('external <img src=x onerror=alert(1)> 原始诊断'), 'external <img src=x onerror=alert(1)> 原始诊断');
  setLanguage('en'); assert.equal(text('保存'), 'Save'); setLanguage('zh-CN'); assert.equal(text('保存'), '保存');
});
test('local dates follow system timezone and seasonal offset, not selected language', () => {
  const module = new URL('../visual/i18n.mjs', import.meta.url).href;
  const sample = tz => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {formatLocalTime} from ${JSON.stringify(module)}; console.log(JSON.stringify([formatLocalTime(Date.UTC(2026,0,1,0), 'en'),formatLocalTime(Date.UTC(2026,6,1,0), 'en'),formatLocalTime(Date.UTC(2026,0,1,0), 'zh-CN')]));`], {env: {...process.env, TZ: tz}}).toString());
  const sh = sample('Asia/Shanghai'), la = sample('America/Los_Angeles'), berlin = sample('Europe/Berlin');
  assert.match(sh[0], /01\/01\/2026, 08:00:00 GMT\+8/);
  assert.match(la[0], /12\/31\/2025, 16:00:00 GMT-8/); assert.match(la[1], /17:00:00 GMT-7/);
  assert.match(berlin[0], /01:00:00 GMT\+1/); assert.match(berlin[1], /02:00:00 GMT\+2/);
  assert.match(sh[2], /08:00:00/); assert.match(sh[2], /GMT\+8/);
  for (const x of [null, undefined, '2026-01-01', NaN, Infinity, 1e20]) assert.equal(formatLocalTime(x), '—');
});
