/** Shapes shared by the presentation layer (type-only module: nothing here exists at runtime). The protocol modules stay plain .mjs
 * (their behaviour is what the TN10 runs and offline tests cover); these types describe only the parts the views read. */
export type Hex = string;
export type Tone = 'mint' | 'violet' | 'amber' | 'gold' | 'muted';
export interface Outpoint {transactionId: Hex; index: number}
export interface Receipt {action: string; txid: Hex; feeSompi: string | number | bigint; finalized?: boolean}
export interface Intent {status: string; action: string; txid?: string; nodeError?: string|null; draft?: {inputUtxos?: {outpoint?: {transactionId: string; index: number|string}; covenantId?: string|null}[]}}
export interface ManagerUtxo {value: bigint; outpoint: Outpoint; utxoDaa: bigint; redeemScript: Uint8Array}
export interface FrozenUtxo {value: bigint; redeemScript: Uint8Array}
export interface Settings {ticketPrice: bigint; ticketCap: number; minTickets: number; closeEligibleDaa: bigint}
export interface DrawResult {txid: Hex; shard: number; record: number; ticket: number}
export interface RoundHistoryShard {end: number; hash: Hex; records: TicketRecord[] | null}
export interface RoundHistory {terminal: 'PAID' | 'REFUNDED'; winnerKey: Hex | null; localRecords: TicketRecord[]; shards: RoundHistoryShard[]}
export interface Round {
  cid: Hex; source: string; terminal: string | null; halted: string | null; intent: Intent | null;
  manager: ManagerUtxo | null; frozen: FrozenUtxo[]; receipts: Receipt[]; pending: unknown[]; fees: bigint;
  origin: Outpoint | null; accepting?: Hex | null; settings: Settings; bought: number; step: number; history?: RoundHistory | null; draw?: DrawResult | null;
  indexer?: {prunedAtNode?: boolean; base?: string; revision?: string; headTxid?: string; acceptingBlock?: string; checkedAt?: number} | null;
}
export interface Facts {
  module: string | null; ticketPrice: bigint; ticketCap: number; minTickets: number; closeEligibleDaa: bigint;
  tickets: number; shards: number; localRecords: number; owner: Hex | null; winnerKey: Hex | null; payCursor: number | null; refundShard: number | null;
}
export interface ActionState {ok: boolean; reason?: string; maxQuantity?: number; remaining?: number}
export interface Phase {key: string; label: string; tone: Tone}
export interface Item {r: Round; f: Facts; a: Record<string, ActionState>; ph: Phase; value: bigint; at: number}
export type ShardStatus = 'active' | 'frozen' | 'settled' | 'refunding' | 'refunded';
export interface ShardRecordView {
  index: number; startTicket: number; endTicket: number; count: number; key: Hex; mine: boolean; refunded: boolean;
}
export interface ShardView {
  index: number; kind: 'frozen' | 'active'; status: ShardStatus; startTicket: number; endTicket: number; tickets: number;
  recordCount: number | null; records: ShardRecordView[] | null; hash: Hex | null; refundedRecords: number; mineCount: number;
}
export interface Holdings {tickets: number; total: number}
export interface Detail extends Item {mine: Holdings | null; isWinner: boolean; shards?: ShardView[] | null; preview?: boolean}
export interface MineRound {item: Item; tickets: number; created: boolean; won: boolean}
export interface MineData {rounds: MineRound[]; txs: {cid: Hex; t: Receipt}[]}
export interface WalletView {kind: string; address: string; key: Hex; spk: {script: string}; canSign?: boolean; id?: string; name?: string}
export interface DiscoveredRound {
  cid: string; terminal?: string|null; module?: string|null; phase?: string|number;
  tickets?: number; shards?: number; bought?: number; buys?: number;
  managerValue?: string|null; acceptingDaa?: string|number|null; updatedAt?: number|null;
  source?: 'indexer'|'rest'; genesisTxid?: string;
}
export interface DiscoveryCacheSnapshot {
  rounds: DiscoveredRound[];
  origin?: 'indexer'|'rest';
  base?: string;
  savedAt?: number;
}
export interface DiscoveryCacheLike {
  read(): DiscoveryCacheSnapshot|null;
  write(snapshot: DiscoveryCacheSnapshot): void;
}
export interface Conn {node?: boolean | null; nodeUrl?: string | null; indexer?: boolean|null; indexerUrl?: string|null; indexerStale?: boolean; discoveredSource?: 'indexer'|'rest'|'cache'|null}
export interface Gate {ok: boolean; reason?: string; fix?: string}
export interface Explorer {tx(id: Hex): string; addr(a: string): string; addrOfKey(k: Hex | null): string | null; addrOfScript(s: string): string}
export interface LogLine {at: number; kind: string; text: string}
/** `fp` binds a result to the node and round state it was obtained for; a different state or node makes it stale (see app.ts verifyFor). */
export interface VerifyState {state: 'checking' | 'ok' | 'partial' | 'bad'; at?: number; code?: string; fp?: string}
export interface CreateForm {price: string; cap: string; min: string; dur: string; custom: string; registry?: boolean; registryAddr?: string}
export interface UiState {
  view: string; cid: string | null; filter: string; sort: string; query: string; qty: string; join: string; wtab: string; theme: string;
  shard?: number | null; purchase?: number | null; pixelMode?: boolean; liveSync?: boolean; detailTab?: 'map' | 'txs' | 'rules'; txLimit?: number; budgetPc?: number;
  form: CreateForm; nodes: string; indexer: string; walletProvider: string;
}
export interface NetInfo {
  key: 'mainnet' | 'tn10'; label: string; unit: 'KAS' | 'TKAS'; networkId: string; genesis: string;
  addressPrefix: string; explorer: string; registry: {address: string; spk: {version: number; script: string}};
  web: {nodes: string[]; indexer: string};
}
export interface DrawProgress {
  phase: 'CHECKING' | 'TARGET_WAIT' | 'READY' | 'UNAVAILABLE'; requiredConfirmations: bigint;
  confirmations?: bigint; observedAt: number;
}
export interface SubmissionProgress {cid: Hex; action: string; txid: Hex | null; error?: string}
export interface Ctx {
  net: NetInfo;
  items: Item[]; S: UiState; wallet: WalletView | null; balance: bigint | null; daa: bigint | null; conn: Conn; busy: boolean;
  ex: Explorer; logs: LogLine[]; gate(action: string): Gate; detail: Detail | null; mine?: MineData | null; verify: VerifyState | null;
  discovered?: DiscoveredRound[]; indexerMore?: boolean; walletOptions?: {id: string;name: string}[];
  saved?: Set<string>; checkProgress?: string | null; submission?: SubmissionProgress | null;
  drawProgress?: DrawProgress | null; daaObservedAt?: number;
}
export interface ReviewInput {index: number; value: bigint; kind: string}
export interface ReviewOutput {role: string; value: bigint; script: string; covenant: boolean}
export interface Prepared {
  op: {action: string; quantity?: number}; review: {txid: Hex; fee: bigint; inputs: ReviewInput[]; outputs: ReviewOutput[]};
  fee: bigint | number; feerate: string | number | bigint; mass: {computeMass: unknown; transientMass: unknown; storageMass: unknown}; targetCount: number; cid: Hex;
}
export interface ConfirmCtx extends Ctx {prepared: Prepared; planText: string}

/* ---- what the page needs from the (untyped, evidence-bearing) .mjs protocol modules; see bridge.ts ---- */
export interface Profile {id: string}
export interface RoundStoreLike {persistent: boolean}
export interface RpcLike {url?: string; currentDaa(): Promise<bigint>}
export interface LastSyncedInfo {
  cid: Hex; nodeUrl: string; managerOutpoint: string; step: number; frozen: number; at: number;
}
export interface CtlState {
  rpc: RpcLike | null;
  wallet: WalletView | null; prepared: Prepared | null; busy: boolean; busyLabel: string | null; logs: LogLine[];
  indexer: unknown|null; indexerInfo: {stale?: boolean}|null; indexerCursor: string|null; discovered: DiscoveredRound[]; discoveredSource?: 'indexer'|'rest'|'cache'|null; discoveredCachedAt?: number|null;
  watchedAddress?: string|null; lastSynced?: LastSyncedInfo|null;
}
export interface Controller {
  state: CtlState;
  onChange(f: () => void): () => void;
  log(kind: string, text: string): void;
  watchRound(cid: string | null): Promise<unknown>;
  cachedPreview(cid: string): Promise<Round | null>;
  loadPreview(cid: string): Promise<Round | null>;
  rounds(): Promise<Round[]>;
  connectNode(urls: string[]): Promise<void>;
  openWallet(privateKeyText: string): string;
  usePublicAddress(address: string): string;
  connectExternalWallet(id: string, opts?: Record<string, unknown>): Promise<string>;
  disconnectWallet(opts?: {keepSession?: boolean}): void;
  restoreDiscovery(): Promise<DiscoveredRound[]>;
  checkIndexer(base: string): Promise<unknown>;
  refreshIndex(): Promise<unknown>;
  moreIndex(): Promise<unknown>;
  syncRound(input: string, opts?: {lookup?: boolean;allowHalted?: boolean;force?: boolean;timeBudgetMs?: number|null;skipIndexer?: boolean;preferRest?: boolean}): Promise<{cid: string;skipped?: string;unchanged?: boolean;source?: string;caughtUp?: boolean;steps?: number;terminal?: string|null;partial?: boolean}>;
  isSyncing?(cid: string): boolean;
  syncIndexedRound(input: string, opts?: {lookup?: boolean;allowHalted?: boolean}): Promise<{cid: string;skipped?: string;unchanged?: boolean;terminal?: string|null}>;
  prepare(choice: Record<string, unknown>, cid: string | null): Promise<Prepared>;
  discardPrepared(): void;
  signAndSend(opts?: {onSigned?: () => void}): Promise<string>;
  track(cid: string, opts?: {recover?: boolean}): Promise<unknown>;
  discard(cid: string, opts?: {force?: boolean}): Promise<unknown>;
  verifyLive(cid: string): Promise<unknown>;
  exportText(cid: string): Promise<string>;
  importText(text: string): Promise<string>;
}
export interface Utxo {value: bigint; isCoinbase?: boolean; covenantId?: unknown}
export interface TicketRecord {end: number; key: Hex}
