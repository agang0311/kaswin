/** KIP-20 bytes; no signature, no RPC attestation, no fabricated Factory hash. */
import { ascii, cat, check, hex, integer, le, same, unhex, uint } from './bytes.js';
import { blake2b256 } from './hashes.js';
export interface Outpoint {
    transactionId: string;
    index: number;
}
export interface Spk {
    version: number;
    script: string;
}
export interface AuthorizedOutput {
    index: number;
    value: bigint;
    spk: Spk;
}
export function p2sh(scriptHash: string, version = 0): Spk {
    unhex(scriptHash, 32);
    integer(version, 0, 65535);
    return { version, script: 'aa20' + scriptHash + '87' };
}
export function p2pk(publicKey: string): Spk {
    unhex(publicKey, 32);
    return { version: 0, script: '20' + publicKey + 'ac' };
}
export function spkBytes(spk: Spk): Uint8Array {
    integer(spk.version, 0, 65535);
    return cat(le(BigInt(spk.version), 2), unhex(spk.script));
}
export function covenantPreimage(origin: Outpoint, outputs: readonly AuthorizedOutput[]): Uint8Array {
    const txid = unhex(origin.transactionId, 32);
    integer(origin.index, 0, 0xffffffff);
    check(outputs.length > 0 && outputs.length <= 65536, 'AUTH_COUNT');
    const parts = [txid, le(BigInt(origin.index), 4), le(BigInt(outputs.length), 8)];
    let previous = -1;
    for (const output of outputs) {
        integer(output.index, 0, 0xffffffff);
        check(output.index > previous, 'AUTH_ORDER');
        previous = output.index;
        uint(output.value, 64);
        integer(output.spk.version, 0, 65535);
        const script = unhex(output.spk.script);
        check(script.length <= 1000000, 'SPK_LIMIT');
        parts.push(le(BigInt(output.index), 4), le(output.value, 8), le(BigInt(output.spk.version), 2), le(BigInt(script.length), 8), script);
    }
    return cat(...parts);
}
export function covenantId(origin: Outpoint, outputs: readonly AuthorizedOutput[]): string {
    return hex(blake2b256(covenantPreimage(origin, outputs), ascii('CovenantID')));
}
