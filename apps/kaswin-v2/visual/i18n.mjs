/** V2 display-only localization. Never visits values, URLs, data attributes, or engine objects. */
import {EN} from './messages-en.mjs';
export const normalize = s => String(s).replace(/\s+/g, ' ').trim();
export function chooseLanguage(saved, languages = []) {
  if (saved === 'zh-CN' || saved === 'en') return saved;
  return /^zh\b/i.test(languages[0] ?? 'zh') ? 'zh-CN' : 'en';
}
let language = 'zh-CN';
export const getLanguage = () => language;
export function setLanguage(value) { language = value === 'en' ? 'en' : 'zh-CN'; }
const literal = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = new Map(), patterns = [];
for (const [source, english] of EN) {
  const key = normalize(source);
  if (!/\{\d+\}/.test(key)) { exact.set(key, english); continue; }
  const ids = [], pieces = key.split(/(\{\d+\})/);
  const regex = new RegExp('^' + pieces.map(p => /^\{\d+\}$/.test(p) ? (ids.push(p), '(.*?)') : literal(p)).join('') + '$', 'u');
  patterns.push({regex, ids, english, weight: key.replace(/\{\d+\}/g, '').length});
}
patterns.sort((a, b) => b.weight - a.weight);
export function englishText(value, depth = 0) {
  const s = normalize(value);
  if (exact.has(s)) return exact.get(s);
  if (depth < 5) for (const p of patterns) {
    const m = p.regex.exec(s); if (!m) continue;
    const vars = Object.fromEntries(p.ids.map((id, i) => [id, englishText(m[i + 1], depth + 1)]));
    return p.english.replace(/\{\d+\}/g, id => vars[id] ?? id);
  }
  // Unmapped external diagnostics are retained verbatim, never reclassified as success.
  return s;
}
export const text = s => language === 'en' ? englishText(s) : s;
export function localTimeZone() { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
export function formatLocalTime(timestamp, lang = language) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return '—';
  // No hard-coded timezone: the browser/OS supplies it, including DST for this instant.
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).format(timestamp);
}
export function installLocalization(doc = document) {
  const sources = new WeakMap();
  const excluded = node => node.parentElement?.closest('script,style,textarea,input,[data-no-i18n]');
  function apply(node, key, read, write) {
    const current = read();
    let entries = sources.get(node); if (!entries) sources.set(node, entries = new Map());
    let entry = entries.get(key);
    if (!entry || current !== entry.last) entry = {source: current, last: current};
    const translated = text(entry.source);
    const leading = entry.source.match(/^\s*/)[0], trailing = entry.source.match(/\s*$/)[0];
    const next = language === 'en' && translated !== normalize(entry.source) ? leading + translated + trailing : entry.source;
    if (current !== next) write(next);
    entry.last = next; entries.set(key, entry);
  }
  function walk(root) {
    if (root.nodeType === 3) {
      if (!excluded(root)) apply(root, 'text', () => root.data, v => { root.data = v; });
      return;
    }
    if (![1, 9].includes(root.nodeType) || root.matches?.('script,style,textarea,input,[data-no-i18n]')) {
      // Placeholder is a label; input/textarea contents are never translated.
      if (root.nodeType === 1 && root.hasAttribute('placeholder')) apply(root, 'placeholder', () => root.getAttribute('placeholder'), v => root.setAttribute('placeholder', v));
      return;
    }
    if (root.hasAttribute?.('data-local-time')) {
      const value = formatLocalTime(Number(root.dataset.localTime));
      if (root.textContent !== value) root.textContent = value;
      return;
    }
    for (const attr of ['aria-label', 'title', 'placeholder']) if (root.hasAttribute?.(attr)) apply(root, attr, () => root.getAttribute(attr), v => root.setAttribute(attr, v));
    for (const child of root.childNodes) walk(child);
  }
  const observer = new MutationObserver(records => {
    observer.disconnect();
    for (const r of records) {
      if (r.type === 'childList') for (const node of r.addedNodes) walk(node);
      else walk(r.target);
    }
    observe();
  });
  const observe = () => observer.observe(doc.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder']});
  const refresh = () => {
    observer.disconnect(); doc.documentElement.lang = language;
    walk(doc.documentElement);
    doc.title = language === 'en' ? 'Kaswin V2 · Clarity at every step' : 'Kaswin V2 · 每一步，都看得清';
    doc.querySelector('meta[name="description"]')?.setAttribute('content', language === 'en' ? 'Kaswin V2: review tickets, fees, purchase records and data sources before approving a Kaspa Testnet 10 transaction.' : 'Kaswin V2：查看票款、费用、购买记录和数据来源，再确认你的 Kaspa Testnet 10 交易。');
    observe();
  };
  refresh(); return refresh;
}
