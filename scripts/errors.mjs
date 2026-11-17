/** Shared public errors. No contract, wallet, node or storage dependencies. */
export const HASH = /^[0-9a-f]{64}$/;
export class UserError extends Error {
  constructor(message, code = 'USER') { super(message); this.name = 'UserError'; this.code = code; }
}
export function ensure(value, message, code) { if (!value) throw new UserError(message, code); return value; }
export function hash32(v, what = '哈希') { ensure(typeof v === 'string' && HASH.test(v), `${what}必须是 64 位小写十六进制`); return v; }
export const errorText = e => (e && typeof e === 'object' && 'message' in e) ? String(e.message) : String(e);
