/** Typed facade over the generic platform and protocol-registry modules used by web/.
 * Concrete covenant implementations are NEVER imported here — web/ talks strictly through ProtocolRegistryLike. */
import {readDrawProgress as readDrawProgressJs} from '../../scripts/round/draw-progress.mjs';
import {createController as controllerJs} from '../../scripts/round/controller.mjs';
import {openRoundStore as openStoreJs, RoundStore as RoundStoreJs} from '../../scripts/store/round-store.mjs';
import {MAX_TICKETS as MAX_TICKETS_JS, hex as hexJs, unhex as unhexJs} from '../../scripts/core.mjs';
import {commonUtxos as utxosJs, getAssetUtxos as assetUtxosJs} from '../../scripts/chain/chain.mjs';
import {
  createProtocolRegistry as registryJs,
  defaultSequentialCreateSpec as defaultCreateSpecJs,
  formatAssetAmount as formatAssetJs,
  kasAsset as kasAssetJs,
} from '../../scripts/protocols/registry.mjs';
import {buildProtocolRegistryFromBundles as buildInstalledJs} from '../../scripts/protocols/installed.mjs';
import {
  matchBuyReceiptAuto as matchBuyJs,
  matchRefundReceiptAuto as matchRefundJs,
  shardRefundReceiptsAuto as shardRefundsJs,
} from '../../scripts/protocols/receipts.mjs';
import {pubkeyToAddress as addressJs, addressToSpk as addressToSpkJs, spkToAddress as spkToAddressJs} from '../../scripts/wallet/address.mjs';
import {connectNetwork as connectNetworkJs, connectTN10 as connectTN10Js, nodeFeeRate as nodeFeeRateJs, mempoolSpentOutpoints as mempoolSpentJs} from '../../scripts/round/prepare.mjs';
import {createIndexerClient as indexerClientJs} from '../../scripts/round/indexer-client.mjs';
import type {
  AssetDescriptor,
  Controller,
  DiscoveryCacheLike,
  DrawProgress,
  IndexerProfileEntry,
  NetInfo,
  Profile,
  ProtocolAdapterLike,
  ProtocolCreateSpec,
  ProtocolRegistryLike,
  Receipt,
  Round,
  RoundStoreLike,
  RpcLike,
  ShardRecordView,
  ShardView,
  Utxo,
} from './types.ts';

export const readDrawProgress = (rpc: RpcLike, round: Round): Promise<DrawProgress> => (readDrawProgressJs as (r: unknown, s: unknown) => Promise<DrawProgress>)(rpc, round);
export const MAX_TICKETS: number = MAX_TICKETS_JS;
export const commonUtxos = (rpc: RpcLike, address: string): Promise<Utxo[]> => (utxosJs as (...a: unknown[]) => Promise<Utxo[]>)(rpc, address);
export const getAssetUtxos = (rpc: RpcLike, address: string, asset: AssetDescriptor): Promise<Utxo[]> => (assetUtxosJs as (...a: unknown[]) => Promise<Utxo[]>)(rpc, address, asset);
export const kasAsset = (net?: NetInfo | null): AssetDescriptor => (kasAssetJs as (n?: unknown) => AssetDescriptor)(net ?? null);
export const formatAssetAmount = (amount: bigint | string, asset: AssetDescriptor, opts?: {maxFrac?: number}): string => (formatAssetJs as (...a: unknown[]) => string)(amount, asset, opts);
export const defaultSequentialCreateSpec = (net?: NetInfo | null, opts?: {protocolId?: string; profileId?: string; name?: string; displayName?: string}): ProtocolCreateSpec =>
  (defaultCreateSpecJs as (...a: unknown[]) => ProtocolCreateSpec)(net ?? null, opts);
export const createProtocolRegistry = (adapters: ProtocolAdapterLike[], opts?: {defaultCreateProfileId?: string; defaultUiCreateId?: string}): ProtocolRegistryLike =>
  (registryJs as (...a: unknown[]) => ProtocolRegistryLike)(adapters, opts);
export const buildProtocolRegistryFromBundles = (bundles: unknown[], opts?: {defaultCreateProfileId?: string; defaultUiCreateId?: string}): ProtocolRegistryLike =>
  (buildInstalledJs as (b: unknown[], o?: unknown) => ProtocolRegistryLike)(bundles, opts);
export const matchBuyReceiptAuto = (sh: ShardView, rec: ShardRecordView, r: Round, shards: ShardView[] | null | undefined, parallel?: boolean): Receipt | null =>
  (matchBuyJs as (...a: unknown[]) => Receipt | null)(sh, rec, r, shards, parallel);
export const matchRefundReceiptAuto = (sh: ShardView, rec: ShardRecordView, r: Round, shards: ShardView[] | null | undefined, parallel?: boolean): Receipt | null =>
  (matchRefundJs as (...a: unknown[]) => Receipt | null)(sh, rec, r, shards, parallel);
export const shardRefundReceiptsAuto = (sh: ShardView, r: Round, shards: ShardView[] | null | undefined, parallel?: boolean): Receipt[] =>
  (shardRefundsJs as (...a: unknown[]) => Receipt[])(sh, r, shards, parallel);
export const pubkeyToAddress = (xonly: string, prefix: string): string => (addressJs as (...a: unknown[]) => string)(xonly, prefix);
export const addressToSpk = (address: string, prefix: string): {version: number; script: string} => (addressToSpkJs as (...a: unknown[]) => {version: number; script: string})(address, prefix);
export const spkToAddress = (spk: {version: number; script: string}, prefix: string): string => (spkToAddressJs as (...a: unknown[]) => string)(spk, prefix);
export const connectNetwork = (urls: string[], net: NetInfo): Promise<RpcLike & {close?(): void}> => (connectNetworkJs as unknown as (u: string[], o: {net: NetInfo}) => Promise<RpcLike & {close?(): void}>)(urls, {net});
export const connectTN10 = (urls: string[]): Promise<RpcLike & {close?(): void}> => (connectTN10Js as unknown as (u: string[]) => Promise<RpcLike & {close?(): void}>)(urls);
export const nodeFeeRate = (rpc: RpcLike): Promise<string> => (nodeFeeRateJs as (r: unknown) => Promise<string>)(rpc);
export const mempoolSpentOutpoints = (rpc: RpcLike, address: string): Promise<Set<string>> => (mempoolSpentJs as (r: unknown, a: string) => Promise<Set<string>>)(rpc, address);
export const hexBytes = (b: Uint8Array): string => (hexJs as (b: Uint8Array) => string)(b);
export const unhexBytes = (s: string, len?: number): Uint8Array => (unhexJs as (s: string, l?: number) => Uint8Array)(s, len);
export const createIndexerClient = (opts: {baseUrl: string; networkId?: string; genesisHash?: string; profileId?: string; profileIds?: string[]}): {
  info(): Promise<{roundsCount?: number; stale?: boolean; profiles?: IndexerProfileEntry[]}>;
  rounds(o?: {limit?: number}): Promise<{rounds: unknown[]}>;
  roundDetail(cid: string): Promise<Record<string, unknown>>;
  covenant(cid: string): Promise<{covenant: {role: string; roundCid: string; covenantId: string; stage: string; outpoint: {transactionId: string; index: number}; value: string; daaScore: string; spk: {version: number; script: string}; address: string; redeemHex: string}}>;
  walletActivity(pk: string, o?: {profileId?: string}): Promise<{activities: unknown[]; byProfile?: Record<string, unknown[]>}>;
} => (indexerClientJs as (o: unknown) => never)(opts);
export const openStore = async (opts: {genesis?: string; profileId?: string} = {}): Promise<RoundStoreLike> => new (RoundStoreJs as new (s: unknown, o?: unknown) => RoundStoreLike)(await openStoreJs(), opts);
export const makeController = (profile: Profile, roundStore: RoundStoreLike, net?: NetInfo, discoveryCache?: DiscoveryCacheLike | null, registry?: ProtocolRegistryLike | null): Controller =>
  (controllerJs as (o: unknown) => unknown)({profile, registry, roundStore, net, discoveryCache}) as Controller;
