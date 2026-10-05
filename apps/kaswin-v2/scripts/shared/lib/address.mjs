/** Kaspa CashAddr-style address codec, ported from rusty-kaspa cfafeb4 crypto/addresses/src/bech32.rs.
 * Supports TN10 ('kaspatest') P2PK Schnorr (version 0, 32-byte x-only key) and P2SH (version 8, 32-byte hash).
 */
import {ensure, ADDRESS_PREFIX} from '../core.mjs';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const REV = new Map([...CHARSET].map((c, i) => [c, i]));
function polymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if (c0 & 0x01n) c ^= 0x98f2bc8e61n;
    if (c0 & 0x02n) c ^= 0x79b76d99e2n;
    if (c0 & 0x04n) c ^= 0xf33e5fb3c4n;
    if (c0 & 0x08n) c ^= 0xae2eabe2a8n;
    if (c0 & 0x10n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
}
const checksum = (payload5, prefix) => polymod([...[...prefix].map(c => c.charCodeAt(0) & 0x1f), 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0]);
function conv8to5(bytes) {
  const out = []; let buff = 0, bits = 0;
  for (const b of bytes) { buff = (buff << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((buff >> bits) & 31); buff &= (1 << bits) - 1; } }
  if (bits > 0) out.push((buff << (5 - bits)) & 31);
  return out;
}
function conv5to8(five) {
  const out = []; let buff = 0, bits = 0;
  for (const c of five) { buff = (buff << 5) | c; bits += 5; while (bits >= 8) { bits -= 8; out.push((buff >> bits) & 255); buff &= (1 << bits) - 1; } }
  return out;
}
export function encodeAddress(version, payload, prefix = ADDRESS_PREFIX) {
  const five = conv8to5([version, ...payload]), sum = checksum(five, prefix);
  const sumBytes = []; for (let i = 4; i >= 0; i--) sumBytes.push(Number((sum >> BigInt(i * 8)) & 0xffn));
  return prefix + ':' + [...five, ...conv8to5(sumBytes)].map(i => CHARSET[i]).join('');
}
export function decodeAddress(address) {
  ensure(typeof address === 'string' && address.length < 200, '地址格式错误');
  const lower = address.toLowerCase(); ensure(lower === address || address.toUpperCase() === address, '地址大小写混用');
  const [prefix, body] = lower.split(':');
  ensure(prefix === ADDRESS_PREFIX && body && body.length >= 8, `仅支持 ${ADDRESS_PREFIX}: 地址（Testnet 10）`);
  const five = [...body].map(c => { const v = REV.get(c); ensure(v !== undefined, '地址包含非法字符'); return v; });
  const payload5 = five.slice(0, -8), sum5 = five.slice(-8);
  let given = 0n; for (const b of conv5to8(sum5)) given = (given << 8n) | BigInt(b);
  ensure(checksum(payload5, prefix) === given, '地址校验和错误');
  const bytes = conv5to8(payload5), version = bytes[0], data = Uint8Array.from(bytes.slice(1));
  ensure((version === 0 || version === 8) && data.length === 32, '仅支持 Schnorr P2PK 或 P2SH 地址');
  return {prefix, version, payload: data};
}
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));
/** scriptPublicKey of an address (txscript standard forms). */
export function addressToSpk(address) {
  const {version, payload} = decodeAddress(address);
  return version === 0 ? {version: 0, script: '20' + hex(payload) + 'ac'} : {version: 0, script: 'aa20' + hex(payload) + '87'};
}
/** Address of a standard spk; null for non-standard scripts. */
export function spkToAddress(spk) {
  if (spk?.version !== 0 || typeof spk.script !== 'string') return null;
  if (/^20[0-9a-f]{64}ac$/.test(spk.script)) return encodeAddress(0, unhex(spk.script.slice(2, 66)));
  if (/^aa20[0-9a-f]{64}87$/.test(spk.script)) return encodeAddress(8, unhex(spk.script.slice(4, 68)));
  return null;
}
export const pubkeyToAddress = xonly => encodeAddress(0, unhex(xonly));
export function addressToPubkey(address) { const {version, payload} = decodeAddress(address); ensure(version === 0, '需要 Schnorr P2PK 地址（kaspatest:q…）'); return hex(payload); }
