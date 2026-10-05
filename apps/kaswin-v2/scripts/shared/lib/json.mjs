/** O(n) JSON reader/writer for node, indexer and wallet payloads.
 * Integers outside the IEEE-754 safe range are returned as decimal strings (never rounded).
 * `__proto__` keys are stored as own data properties (no prototype pollution).
 */
import {hex} from '../core.mjs';

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function parseJson(text) {
  if (typeof text !== 'string') throw new TypeError('JSON_TEXT');
  const n = text.length;
  let i = 0;
  const fail = (what) => { throw new SyntaxError(`JSON_${what}@${i}`); };
  const skip = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++; else return;
    }
  };
  const string = () => {
    const start = ++i;
    let j = start, escaped = false;
    for (;;) {
      if (j >= n) fail('STRING');
      const c = text.charCodeAt(j);
      if (c === 0x22) break;
      if (c === 0x5c) { escaped = true; j += 2; continue; }
      if (c < 0x20) fail('CONTROL');
      j++;
    }
    i = j + 1;
    const raw = text.slice(start, j);
    return escaped ? JSON.parse('"' + raw + '"') : raw;
  };
  const digits = () => { const s = i; while (i < n) { const c = text.charCodeAt(i); if (c >= 0x30 && c <= 0x39) i++; else break; } return i > s; };
  const number = () => {
    const start = i;
    if (text.charCodeAt(i) === 0x2d) i++;
    if (!digits()) fail('NUMBER');
    let integer = true;
    if (text.charCodeAt(i) === 0x2e) { integer = false; i++; if (!digits()) fail('FRACTION'); }
    const e = text.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      integer = false; i++;
      const s = text.charCodeAt(i); if (s === 0x2b || s === 0x2d) i++;
      if (!digits()) fail('EXPONENT');
    }
    const token = text.slice(start, i);
    if (token.length > 400) fail('NUMBER_LENGTH');
    if (integer && token.length > 15) { const b = BigInt(token); if (b > SAFE || b < -SAFE) return token; }
    const v = Number(token);
    if (!Number.isFinite(v)) fail('NUMBER_RANGE');
    return v;
  };
  const value = (depth) => {
    if (depth > 256) fail('DEPTH');
    skip();
    const c = text.charCodeAt(i);
    if (c === 0x7b) {
      i++; const o = {}; skip();
      if (text.charCodeAt(i) === 0x7d) { i++; return o; }
      for (;;) {
        skip(); if (text.charCodeAt(i) !== 0x22) fail('KEY');
        const k = string(); skip();
        if (text.charCodeAt(i) !== 0x3a) fail('COLON');
        i++;
        const v = value(depth + 1);
        Object.defineProperty(o, k, {value: v, enumerable: true, writable: true, configurable: true});
        skip();
        const d = text.charCodeAt(i++);
        if (d === 0x2c) continue;
        if (d === 0x7d) return o;
        fail('OBJECT');
      }
    }
    if (c === 0x5b) {
      i++; const a = []; skip();
      if (text.charCodeAt(i) === 0x5d) { i++; return a; }
      for (;;) {
        a.push(value(depth + 1)); skip();
        const d = text.charCodeAt(i++);
        if (d === 0x2c) continue;
        if (d === 0x5d) return a;
        fail('ARRAY');
      }
    }
    if (c === 0x22) return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    return number();
  };
  const result = value(0);
  skip();
  if (i !== n) fail('TRAILING');
  return result;
}

/** JSON writer: bigint -> digits, Uint8Array -> hex string, undefined object members omitted. */
export function jsonText(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'bigint': return v.toString();
    case 'number': if (!Number.isFinite(v)) throw new TypeError('JSON_NUMBER'); return String(v);
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'object':
      if (Array.isArray(v)) return '[' + v.map(jsonText).join(',') + ']';
      if (v instanceof Uint8Array) return JSON.stringify(hex(v));
      return '{' + Object.keys(v).filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + jsonText(v[k])).join(',') + '}';
    default: throw new TypeError('JSON_VALUE');
  }
}

/** Lossless non-negative integer from a JSON field (safe number or decimal string). */
export function uint(v, code = 'INTEGER') {
  if (typeof v === 'bigint' && v >= 0n) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0|[1-9][0-9]{0,24})$/.test(v)) return BigInt(v);
  throw new Error(code);
}
