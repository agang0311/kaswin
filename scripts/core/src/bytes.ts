/** Binary helpers. Application data are not Kaspa wire transactions. */
export class KaswinError extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = 'KaswinError'; }
}
export function check(ok: unknown, code: string, message = code): asserts ok {
    if (!ok)
        throw new KaswinError(code, message);
}
export function uint(value: bigint, bits = 63): bigint {
    check(typeof value === 'bigint' && value >= 0n && value < (1n << BigInt(bits)), 'INTEGER_RANGE');
    return value;
}
export function integer(n: number, min: number, max: number): number {
    check(Number.isSafeInteger(n) && n >= min && n <= max, 'INTEGER_RANGE');
    return n;
}
export function hex(bytes: Uint8Array): string { return [...bytes].map(x => x.toString(16).padStart(2, '0')).join(''); }
export function unhex(value: string, length?: number): Uint8Array {
    check(typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value), 'NONCANONICAL_HEX');
    const out = Uint8Array.from(value.match(/../g) ?? [], x => parseInt(x, 16));
    if (length !== undefined)
        check(out.length === length, 'BYTE_LENGTH');
    return out;
}
export function key(value: string): string { unhex(value, 32); return value; }
export function cat(...parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
export const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
export function le(n: bigint, width: number): Uint8Array {
    uint(n, width * 8);
    const b = new Uint8Array(width);
    for (let i = 0; i < width; i++) {
        b[i] = Number(n & 255n);
        n >>= 8n;
    }
    return b;
}
export function fromLe(b: Uint8Array): bigint {
    let n = 0n;
    for (let i = b.length - 1; i >= 0; i--)
        n = (n << 8n) | BigInt(b[i]!);
    return n;
}
export function same(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length)
        return false;
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d |= a[i]! ^ b[i]!;
    return d === 0;
}
/** Exact decimal KAS parser. Never rounds a floating point amount. */
export function kasToSompi(s: string): bigint {
    check(/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(s), 'BAD_KAS_AMOUNT');
    const [a, b = ''] = s.split('.');
    return BigInt(a!) * 100000000n + BigInt(b.padEnd(8, '0'));
}
export function sompiToKas(n: bigint): string {
    uint(n);
    return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, '0')}`;
}
export function abortIfNeeded(signal?: AbortSignal): void { signal?.throwIfAborted(); }
/** Unambiguous typed snapshot for mutation checks, NOT a consensus serializer. */
export function stable(value: unknown): string {
    if (value === null)
        return '["null"]';
    if (value === undefined)
        return '["undefined"]';
    if (typeof value === 'bigint')
        return '["bigint",' + JSON.stringify(value.toString()) + ']';
    if (typeof value === 'string')
        return '["string",' + JSON.stringify(value) + ']';
    if (typeof value === 'boolean')
        return '["boolean",' + JSON.stringify(value) + ']';
    if (typeof value === 'number') {
        check(Number.isFinite(value), 'NONFINITE_NUMBER');
        return '["number",' + (Object.is(value, -0) ? '"-0"' : String(value)) + ']';
    }
    if (value instanceof Uint8Array)
        return '["bytes",' + JSON.stringify(hex(value)) + ']';
    if (Array.isArray(value))
        return '["array",[' + value.map(stable).join(',') + ']]';
    check(typeof value === 'object', 'NON_DATA_VALUE');
    check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'NON_PLAIN_DTO');
    const o = value as Record<string, unknown>;
    return '["object",[' + Object.keys(o).sort().map(k => '[' + JSON.stringify(k) + ',' + stable(o[k]) + ']').join(',') + ']]';
}
