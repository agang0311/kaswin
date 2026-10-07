import { type Outpoint } from './covenant-id.js';
import * as S from './state.js';
import { type Action, type Transition } from './protocol.js';
import { type Output, type Transaction } from './transaction.js';
export declare function scriptPushes(bytes: Uint8Array): Uint8Array[];
/** SIL int ABI: signed ScriptNum, at most 8 bytes. Negative ignored fee is still data. */
export declare function scriptNumber(bytes: Uint8Array): bigint;
export declare function targetSeqOf(opening: Uint8Array): string;
export declare function decodeSpend(script: string, profile: S.Profile, contextOrigin?: Outpoint): {
    action: "BUY" | "CLOSE" | "DRAW_AND_PAY" | "TIMEOUT_REFUND" | "REFUND";
    module: "open" | "sealed" | "refunding";
    spent: S.Ledger;
    ledger: Uint8Array<ArrayBufferLike>;
    origin: Outpoint;
    actorKey: string;
    data: Uint8Array<ArrayBufferLike>;
    nextTail: Uint8Array<ArrayBufferLike>;
    witnessFee: bigint;
};
export type AcceptedRole = 'STATE' | 'WINNER' | 'CREATOR' | 'EXECUTOR' | 'BUYER_REFUND' | 'AUXILIARY';
export interface AcceptedOutput extends Output {
    role: AcceptedRole;
    constrained: boolean;
}
export interface AcceptedInterpretation {
    action: Action;
    module: S.Module;
    actorKey: string;
    spent: S.Ledger;
    next: S.Ledger | null;
    terminal: Transition['terminal'];
    witnessFee: bigint;
    fee: bigint | null;
    external: bigint | null;
    outputs: AcceptedOutput[];
    constrainedOutputs: number;
    draw: null | {
        opening: string;
        target: string;
        seqCommit: string;
        boundaryDaa: string;
    };
    winner: null | {
        record: number;
        ticket: number;
        key: string;
        ticketsInRecord: number;
        firstTicket: number;
        lastTicket: number;
        prize: bigint;
    };
}
export declare function interpretAccepted(x: S.Snapshot, p: S.Profile, tx: Transaction, inputValues?: readonly bigint[]): AcceptedInterpretation;
/** Only for matching an ALREADY ACCEPTED tx to our own approved draft. Byte-level
 * comparison stays strict except for the one int argument ignored by that action.
 * Do not use this to validate a wallet response or arbitrary unaccepted transactions. */
export declare function sameAcceptedWitnessExceptIgnoredFee(before: string, after: string, action: string): boolean;
