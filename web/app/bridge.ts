/** Typed facade over the plain-JS protocol modules the page uses. The .mjs files keep their behaviour (and their TN10 evidence / offline tests);
 * this file only gives their entry points precise TypeScript signatures so app.ts and views.ts are fully type-checked. Nothing is re-implemented. */
import {readDrawProgress as readDrawProgressJs} from '../../scripts/round/draw-progress.mjs';
import {describeRound as describeJs,availableActions as availableJs,shardCatalog as shardCatalogJs} from '../../scripts/round/round.mjs';
import {verifyDrawReceipt as verifyDrawJs} from '../../scripts/round/indexer-client.mjs';
import {createController as controllerJs} from '../../scripts/round/controller.mjs';
import {profileFromData as profileJs} from '../../scripts/contract/profile-data.mjs';
import {openRoundStore as openStoreJs,RoundStore as RoundStoreJs} from '../../scripts/store/round-store.mjs';
import {identify as identifyJs,MAX_TICKETS as MAX_TICKETS_JS} from '../../scripts/core.mjs';
import {commonUtxos as utxosJs} from '../../scripts/chain/chain.mjs';
import {pubkeyToAddress as addressJs,addressToSpk as addressToSpkJs} from '../../scripts/wallet/address.mjs';
import {managerBoundUnits as boundUnitsJs,unitsToBudget as unitsToBudgetJs} from '../../scripts/round/budget.mjs';
import {connectNetwork as connectNetworkJs,connectTN10 as connectTN10Js} from '../../scripts/round/prepare.mjs';
import {createIndexerClient as indexerClientJs} from '../../scripts/round/indexer-client.mjs';
import type {ActionState,Controller,DiscoveryCacheLike,DrawProgress,DrawResult,Facts,NetInfo,Profile,Round,RoundStoreLike,RpcLike,ShardView,TicketRecord,Utxo} from './types.ts';

export const readDrawProgress = (rpc: RpcLike, round: Round): Promise<DrawProgress> => (readDrawProgressJs as (r: unknown, s: unknown) => Promise<DrawProgress>)(rpc, round);
export const loadProfile = (data: unknown): Profile => profileJs(data) as Profile;
export const describeRound = (r: Round, profile: Profile, daa: bigint | null): Partial<Facts> => (describeJs as (...a: unknown[]) => Partial<Facts>)(r, profile, daa ?? undefined);
export const availableActions = (r: Round, profile: Profile, daa: bigint): Record<string, ActionState> => (availableJs as (...a: unknown[]) => Record<string, ActionState>)(r, profile, daa);
export const shardCatalog = (r: Round, profile: Profile, walletKey: string | null = null): ShardView[] | null => (shardCatalogJs as (...a: unknown[]) => ShardView[] | null)(r, profile, walletKey);
export const verifyDrawReceipt = (r: Round, rpc: RpcLike, profile: Profile): Promise<DrawResult | null> => (verifyDrawJs as (...a: unknown[]) => Promise<DrawResult | null>)(r, rpc, profile);
export const MAX_TICKETS: number = MAX_TICKETS_JS;
export const identify = (redeemScript: Uint8Array, profile: Profile): {module: string; records: TicketRecord[]} => (identifyJs as (...a: unknown[]) => {module: string; records: TicketRecord[]})(redeemScript, profile);
export const commonUtxos = (rpc: RpcLike, address: string): Promise<Utxo[]> => (utxosJs as (...a: unknown[]) => Promise<Utxo[]>)(rpc, address);
export const pubkeyToAddress = (xonly: string, prefix: string): string => (addressJs as (...a: unknown[]) => string)(xonly, prefix);
export const addressToSpk = (address: string, prefix: string): {version: number; script: string} => (addressToSpkJs as (...a: unknown[]) => {version: number; script: string})(address, prefix);
export const managerBoundUnits = (action: string, opts: unknown): number => (boundUnitsJs as (...a: unknown[]) => number)(action, opts);
export const unitsToBudget = (units: number): number => (unitsToBudgetJs as (u: number) => number)(units);
export const connectNetwork = (urls: string[], net: NetInfo): Promise<RpcLike & {close?(): void}> => (connectNetworkJs as unknown as (u: string[], o: {net: NetInfo}) => Promise<RpcLike & {close?(): void}>)(urls, {net});
export const connectTN10 = (urls: string[]): Promise<RpcLike & {close?(): void}> => (connectTN10Js as unknown as (u: string[]) => Promise<RpcLike & {close?(): void}>)(urls);
export const createIndexerClient = (opts: {baseUrl: string; networkId?: string; genesisHash?: string; profileId?: string}): {info(): Promise<{roundsCount?: number;stale?: boolean}>;rounds(o?: {limit?: number}): Promise<{rounds: unknown[]}>} =>
  (indexerClientJs as (o: unknown) => {info(): Promise<{roundsCount?: number;stale?: boolean}>;rounds(o?: {limit?: number}): Promise<{rounds: unknown[]}>})(opts);
export const openStore = async (opts: {genesis?: string; profileId?: string} = {}): Promise<RoundStoreLike> => new (RoundStoreJs as new (s: unknown, o?: unknown) => RoundStoreLike)(await openStoreJs(), opts);
export const makeController = (profile: Profile, roundStore: RoundStoreLike, net?: NetInfo, discoveryCache?: DiscoveryCacheLike | null): Controller =>
  (controllerJs as (o: unknown) => unknown)({profile, roundStore, net, discoveryCache}) as Controller;
