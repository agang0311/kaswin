import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Languages,
  Link2,
  RefreshCw,
  RefreshCcw,
  Settings,
  ShieldCheck,
  Ticket,
  Trophy,
  Upload,
  WalletCards
} from "lucide-react";
import {
  addressFromPubkeyHex,
  assertRaffleCovenantReady,
  getRaffleCovenantStatus,
  pubkeyHexFromAddress,
  raffleWinnerIndexFromSeed,
  roundIdToBytes32
} from "../kaspa/covenant";
import { CHAIN_RANDOM_DELAY_DAA, loadChainRandomnessWitness } from "../kaspa/chain-randomness";
import { loadAcceptedOutpointSpend, loadBlockHashesNearDaa, loadIndexedRaffleHistory, loadRaffleHistory, loadTransactionChainAnchor, type RaffleHistoryRound } from "../kaspa/history";
import {
  DEFAULT_RAFFLE_INDEX_API,
  checkRaffleIndexer,
  loadIndexedBatchProof,
  loadIndexedTicketProof,
  requiresRaffleIndexerProof
} from "../kaspa/indexer";
import {
  connectBrowserRpc,
  disconnectBrowserRpc,
  getAddressBalanceSompi,
  type KaspaRpcEndpoint,
  type KaspaNodeStatus,
  type KaspaRpcConnection
} from "../kaspa/rpc";
import {
  NETWORK_PROFILES,
  assertToccataActive,
  networkFromAddress,
  normalizeNetworkId,
  requireNetworkProfile,
  type SupportedNetworkId
} from "../kaspa/networks";
import {
  assertValidKaspaAddress,
  buyRaffleCovenantTicket,
  COVENANT_CREATE_FEE_SOMPI,
  COVENANT_TOP_UP_FEE_SOMPI,
  closeEmptyRaffleCovenantRound,
  covenantBuyFeeSompi,
  covenantFinalizeFeeSompi,
  covenantRefundMaxFeeSompi,
  covenantRefundFeeSompi,
  createRaffleCovenantRound,
  DEFAULT_COVENANT_CARRIER_SOMPI,
  DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI,
  finalizeRaffleCovenantRound,
  getRaffleRegistryConfig,
  LEGACY_REFUND_TRANSITION_SPONSOR_SOMPI,
  MAX_COVENANT_CLOSE_FEE_SOMPI,
  MAX_COVENANT_FINALIZE_FEE_SOMPI,
  MAX_REFUND_PURCHASE_BATCHES_PER_TX,
  MIN_COVENANT_CARRIER_SOMPI,
  MIN_COVENANT_TOP_UP_SOMPI,
  REGISTRY_MARKER_REFUND_FEE_SOMPI,
  REGISTRY_PAYMENT_FEE_SOMPI,
  currentRaffleCovenantDaaScore,
  REFUND_TRANSITION_FEE_SOMPI,
  refundRaffleCovenantRound,
  refundRaffleRegistryMarker,
  sendKaspaPayment,
  transactionRejectionRequiresStateRefresh,
  topUpRaffleCovenantCarrier
} from "../kaspa/transactions";
import {
  connectBrowserWallet,
  disconnectBrowserWallet,
  listWalletAdapters,
  readConnectedBrowserWallet,
  subscribeBrowserWallet,
  withWalletBalance,
  type BrowserTestWallet,
  type WalletAdapterOption
} from "../kaspa/wallet";
import {
  createEmptyMetadata,
  archivedReleaseForRaffleContractVersion,
  hasFixedRefundTransitionFee,
  isSupportedRaffleContractVersion,
  isQuarantinedRaffleContractVersion,
  isVNextRaffleContractVersion,
  MAX_ROUND_PRINCIPAL_SOMPI,
  MIN_REFUNDABLE_TICKET_PRICE_SOMPI,
  parseMetadata,
  RAFFLE_CONTRACT_VERSION,
  raffleContractVersionForNetwork,
  stringifyMetadata,
  supportsGroupedRefunds
} from "../raffle/metadata";
import {
  cacheParticipatedRound,
  hasCachedParticipatedRound,
  loadCachedRaffleHistory,
  loadCachedRound,
  updateCachedParticipatedRoundFromHistory
} from "../raffle/local-rounds";
import { randomHex } from "../raffle/randomness";
import { verifyRaffleState } from "../raffle/state";
import { buildTicketBatchProof, TICKET_EMPTY_FRONTIER_HEX, TICKET_EMPTY_ROOT_HEX } from "../raffle/merkle";
import { buildBatchProof as buildVNextBatchProof } from "../protocol/merkle";
import { bytesToHex } from "../protocol/encoding";
import { deriveDrawSeed, drawRandomnessBaseDaaScore } from "../protocol/randomness";
import { PROTOCOL_MANIFEST } from "../protocol/manifest";
import { findTicketRange, hasCompleteTicketBatchHistory, ticketRangeCount, ticketRangeEnd, totalTicketCount } from "../raffle/tickets";
import { preferAdvancedRaffleCovenant, preferMoreCompleteRaffleHistoryTickets } from "../raffle/history-merge";
import type { FinalizeState, RaffleMetadata, RoundState, TicketState } from "../raffle/types";
import { translate, translateRuntimeText, type Language, type TranslationValues } from "./i18n";
import { CreateRoundPanel } from "./components/CreateRoundPanel";
import { ActionWorkspace } from "./components/ActionWorkspace";
import { SourceWorkspace } from "./components/SourceWorkspace";
import { AdvancedSettingsPanel } from "./components/AdvancedSettingsPanel";
import { SigningConfirmationDialog } from "./components/SigningConfirmationDialog";
import { ExplorerLink, ExplorerText } from "./components/ExplorerLink";
import { derivePageEligibility, type RoundActionTab, type RoundSourceTab } from "./state-machine";
import { buildSigningPreview, buySnapshot, cancelSigningConfirmation, carrierTopUpSnapshot, decideSigningConfirmation, idleSigningConfirmationState, openSigningConfirmation, registrySnapshot, type SigningConfirmationState } from "./signing-preview";
import packageJson from "../../package.json";

const emptyMetadata = createEmptyMetadata();
const KASPA_DAA_PER_SECOND = 10n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 60n * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24n * SECONDS_PER_HOUR;
const SECONDS_PER_MONTH = 30n * SECONDS_PER_DAY;
const TESTNET_REFUND_TIMEOUT_SECONDS = 10n * SECONDS_PER_MINUTE;
const MAINNET_REFUND_TIMEOUT_SECONDS = SECONDS_PER_DAY;
const NETWORK_ENDPOINTS_STORAGE_KEY = "kaspa-raffle-network-endpoints-v1";
const INDEX_ENDPOINTS_STORAGE_KEY = "kaspa-raffle-index-endpoints-v1";
const LANGUAGE_STORAGE_KEY = "kaspa-raffle-language-v1";
const INTRO_GUIDES_STORAGE_KEY = "kaspa-raffle-intro-guides-seen-v1";
type ChainFeedbackTarget = "create" | "buy" | "draw" | "refund" | "carrier" | "close";

function recoverTicketStatesFromCovenantBatches(input: {
  roundId: string;
  ticketPrice: bigint;
  covenant?: RaffleMetadata["covenant"];
  network: SupportedNetworkId;
}): TicketState[] {
  const covenant = input.covenant;
  if (!covenant || covenant.soldTickets <= 0) return [];
  const ownerPubkeys = covenant.ticketOwnerPubkeys ?? [];
  const ends = covenant.ticketBatchEnds ?? ownerPubkeys.map((_, index) => index + 1);
  if (!ownerPubkeys.length || ownerPubkeys.length !== ends.length) return [];
  if (ends[ends.length - 1] !== covenant.soldTickets) return [];

  const tickets: TicketState[] = [];
  let firstTicketId = 1;
  for (let index = 0; index < ownerPubkeys.length; index += 1) {
    const end = ends[index];
    if (!Number.isSafeInteger(end) || end < firstTicketId) return [];
    const ownerPubkey = ownerPubkeys[index];
    if (!/^[0-9a-f]{64}$/i.test(ownerPubkey)) return [];
    tickets.push({
      appId: "KASPA_RAFFLE_TICKET_V1",
      roundId: input.roundId,
      ticketId: firstTicketId,
      ticketCount: end - firstTicketId + 1,
      owner: addressFromPubkeyHex(ownerPubkey, input.network),
      ownerPubkey,
      paidAmount: input.ticketPrice,
      ticketTxId: covenant.txId
    });
    firstTicketId = end + 1;
  }
  return firstTicketId - 1 === covenant.soldTickets ? tickets : [];
}

function historyRoundNeedsIndexer(historyRound: RaffleHistoryRound): boolean {
  const soldTickets = historyRound.soldTickets ?? totalTicketCount(historyRound.tickets);
  const soldBatches = historyRound.latestCovenant?.soldBatches ?? historyRound.tickets.length;
  const completeLocalHistory = hasCompleteTicketBatchHistory(historyRound.tickets, soldTickets, soldBatches);
  return soldTickets > 0 && requiresRaffleIndexerProof(historyRound.maxTickets ?? 0, completeLocalHistory);
}

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === "en" || saved === "zh") {
      return saved;
    }
  } catch {
    // Use the browser language when storage is unavailable.
  }

  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function initialIntroGuidesSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_GUIDES_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

type NetworkEndpointMode = KaspaRpcEndpoint["mode"];
type NetworkEndpointSettings = { mode: NetworkEndpointMode; url: string };
type NetworkRpcEndpoints = Record<SupportedNetworkId, NetworkEndpointSettings>;
type NetworkTextEndpoints = Record<SupportedNetworkId, string>;

function defaultNetworkEndpoints(): NetworkRpcEndpoints {
  return Object.fromEntries(NETWORK_PROFILES.map((profile) => [
    profile.id,
    { mode: profile.defaultRpcMode, url: profile.suggestedRpcUrl }
  ])) as NetworkRpcEndpoints;
}

function normalizeNetworkEndpoint(
  value: unknown,
  fallback: NetworkEndpointSettings
): NetworkEndpointSettings {
  if (typeof value === "string") {
    return { mode: "custom", url: value.trim() || fallback.url };
  }

  if (value && typeof value === "object") {
    const maybeEndpoint = value as Partial<NetworkEndpointSettings>;
    const mode = maybeEndpoint.mode === "custom" ? "custom" : "resolver";
    return {
      mode,
      url: typeof maybeEndpoint.url === "string" && maybeEndpoint.url.trim()
        ? maybeEndpoint.url.trim()
        : fallback.url
    };
  }

  return fallback;
}

function loadNetworkEndpoints(): NetworkRpcEndpoints {
  const defaults = defaultNetworkEndpoints();

  try {
    const saved = JSON.parse(localStorage.getItem(NETWORK_ENDPOINTS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return {
      mainnet: normalizeNetworkEndpoint(saved.mainnet, defaults.mainnet),
      "testnet-10": normalizeNetworkEndpoint(saved["testnet-10"], defaults["testnet-10"])
    };
  } catch {
    return defaults;
  }
}

function loadIndexEndpoints(): NetworkTextEndpoints {
  const defaults: NetworkTextEndpoints = {
    mainnet: DEFAULT_RAFFLE_INDEX_API,
    "testnet-10": DEFAULT_RAFFLE_INDEX_API
  };
  try {
    const saved = JSON.parse(localStorage.getItem(INDEX_ENDPOINTS_STORAGE_KEY) ?? "{}") as Partial<NetworkTextEndpoints>;
    return {
      mainnet: saved.mainnet?.trim() || defaults.mainnet,
      "testnet-10": saved["testnet-10"]?.trim() || defaults["testnet-10"]
    };
  } catch {
    return defaults;
  }
}

function validateRpcUrl(value: string): string {
  const normalized = value.trim();

  if (!/^wss?:\/\//i.test(normalized)) {
    throw new Error("The node endpoint must start with ws:// or wss://.");
  }

  return normalized;
}

function rpcTargetFromSettings(endpoint: NetworkEndpointSettings): KaspaRpcEndpoint {
  return endpoint.mode === "resolver"
    ? { mode: "resolver" }
    : { mode: "custom", url: validateRpcUrl(endpoint.url) };
}

type RefundTimeoutPart = "months" | "days" | "hours" | "minutes" | "seconds";
type RefundTimeoutParts = Record<RefundTimeoutPart, string>;

function defaultRefundTimeoutSeconds(network: string): bigint {
  return network === "mainnet" ? MAINNET_REFUND_TIMEOUT_SECONDS : TESTNET_REFUND_TIMEOUT_SECONDS;
}

const DEFAULT_REFUND_TIMEOUT_PARTS = refundTimeoutPartsFromSeconds(defaultRefundTimeoutSeconds("testnet-10"));

const REFUND_TIMEOUT_FIELDS: Array<{ key: RefundTimeoutPart; labelKey: string }> = [
  { key: "months", labelKey: "duration.months" },
  { key: "days", labelKey: "duration.days" },
  { key: "hours", labelKey: "duration.hours" },
  { key: "minutes", labelKey: "duration.minutes" },
  { key: "seconds", labelKey: "duration.seconds" }
];

function formatKasAmount(value: bigint, unit = "KAS") {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} ${unit}`;
}

function formatKasCompactAmount(value: bigint, unit = "KAS") {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").slice(0, 3);
  return `${whole.toLocaleString()}.${fraction} ${unit}`;
}
function parsePositiveSompi(value: string, fieldName: string) {
  try {
    const parsed = BigInt(value.trim());

    if (parsed <= 0n) {
      throw new Error(`${fieldName} must be greater than zero.`);
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes(fieldName)) {
      throw error;
    }

    throw new Error(`${fieldName} must be a valid KAS amount.`);
  }
}

function parseMinimumSompi(value: string, fieldName: string, minimum: bigint) {
  const parsed = parsePositiveSompi(value, fieldName);

  if (parsed < minimum) {
    throw new Error(`${fieldName} must be at least ${formatKasAmount(minimum)} for the current Toccata storage-mass floor.`);
  }

  return parsed;
}

function sompiToKasInput(value: string) {
  try {
    const sompi = BigInt(value || "0");
    const whole = sompi / 100_000_000n;
    const fraction = (sompi % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return "0";
  }
}

function kasInputToSompi(value: string) {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{0,8}))?$/.exec(normalized);

  if (!match) {
    return "0";
  }

  return (BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0") || "0")).toString();
}

function shortValue(value: string | undefined, size = 8) {
  if (!value) {
    return "pending";
  }

  return value.length > size * 2 + 3 ? `${value.slice(0, size)}...${value.slice(-size)}` : value;
}

function parseDurationPart(value: string, fieldName: string): bigint {
  const normalized = value.trim();

  if (!normalized) {
    return 0n;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${fieldName} must be a non-negative whole number.`);
  }

  return BigInt(normalized);
}

function refundTimeoutSecondsFromParts(parts: RefundTimeoutParts): bigint {
  return (
    parseDurationPart(parts.months, "Refund timeout months") * SECONDS_PER_MONTH +
    parseDurationPart(parts.days, "Refund timeout days") * SECONDS_PER_DAY +
    parseDurationPart(parts.hours, "Refund timeout hours") * SECONDS_PER_HOUR +
    parseDurationPart(parts.minutes, "Refund timeout minutes") * SECONDS_PER_MINUTE +
    parseDurationPart(parts.seconds, "Refund timeout seconds")
  );
}

function refundTimeoutDaaFromParts(parts: RefundTimeoutParts): bigint {
  return refundTimeoutSecondsFromParts(parts) * KASPA_DAA_PER_SECOND;
}

function refundTimeoutPartsFromSeconds(totalSeconds: bigint): RefundTimeoutParts {
  let remaining = totalSeconds < 0n ? 0n : totalSeconds;
  const months = remaining / SECONDS_PER_MONTH;
  remaining %= SECONDS_PER_MONTH;
  const days = remaining / SECONDS_PER_DAY;
  remaining %= SECONDS_PER_DAY;
  const hours = remaining / SECONDS_PER_HOUR;
  remaining %= SECONDS_PER_HOUR;
  const minutes = remaining / SECONDS_PER_MINUTE;
  const seconds = remaining % SECONDS_PER_MINUTE;

  return {
    months: months.toString(),
    days: days.toString(),
    hours: hours.toString(),
    minutes: minutes.toString(),
    seconds: seconds.toString()
  };
}

function formatDurationSeconds(totalSeconds: bigint, language: Language): string {
  const parts = refundTimeoutPartsFromSeconds(totalSeconds);
  return language === "zh"
    ? `${parts.months}月 ${parts.days}天 ${parts.hours}时 ${parts.minutes}分 ${parts.seconds}秒`
    : `${parts.months} mo ${parts.days} d ${parts.hours} h ${parts.minutes} m ${parts.seconds} s`;
}

function formatRefundTimeoutParts(parts: RefundTimeoutParts, language: Language): string {
  try {
    return formatDurationSeconds(refundTimeoutSecondsFromParts(parts), language);
  } catch {
    return "invalid";
  }
}

function normalizeDurationInput(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function encodePayload(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function encodeRegistryPayload(metadata: RaffleMetadata) {
  const covenant = metadata.covenant;
  if (!metadata.roundId || !metadata.createTxId || !metadata.registryAddress || !covenant) {
    throw new Error("The current round is missing data required to publish its Registry record.");
  }
  return encodePayload({
    app: "kaspa-raffle-static",
    type: "round-register",
    version: metadata.version,
    roundId: metadata.roundId,
    createTxId: metadata.createTxId,
    treasuryAddress: covenant.address,
    covenantId: covenant.covenantId,
    creator: metadata.creatorAddress,
    ticketPrice: metadata.ticketPrice,
    maxTickets: metadata.maxTickets,
    minTickets: metadata.minTickets,
    maxBatches: metadata.maxBatches ?? 100,
    roundNonce: metadata.roundNonce ?? metadata.roundId,
    salesDeadlineDaa: metadata.salesDeadlineDaa ?? covenant.refundAfterDaaScore,
    creatorPubkey: metadata.creatorPubkey ?? covenant.creatorPubkey,
    createdAtDaaScore: metadata.createdAtDaaScore,
    refundAfterDaaScore: metadata.refundAfterDaaScore ?? covenant.refundAfterDaaScore,
    chainSearchHintHash: covenant.chainSearchHintHash ?? metadata.startBlockHash,
    refundTimeoutSeconds: metadata.refundTimeoutSeconds,
    refundTimeoutDaa: metadata.refundTimeoutDaa,
    registryAddress: metadata.registryAddress,
    contractVersion: metadata.contractVersion,
    registeredAt: new Date().toISOString()
  });
}

function encodeShareMetadata(metadata: RaffleMetadata) {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeShareMetadata(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return parseMetadata(new TextDecoder().decode(bytes));
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message || fallback;
  }

  const message = String(error || "");
  return message || fallback;
}

async function withWalletConnectionTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeoutId: number | undefined;

  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error("Wallet connection timed out after 20 seconds. Unlock the wallet extension, approve the connection, then try again.")),
        20_000
      );
    })
  ]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function shouldShrinkRefundBatch(error: unknown): boolean {
  const message = errorMessage(error, "");
  return /refund batch candidate|standard mass limit|storage[- ]mass(?: minimum)?|compute mass .*larger than|max allowed size|covenant fee cap/i.test(message);
}

async function currentVirtualDaaScore(connection: KaspaRpcConnection): Promise<bigint> {
  let timeoutId: number | undefined;
  const serverInfo = await Promise.race([
    connection.client.getServerInfo(),
    new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error("Current DAA lookup timed out after 30 seconds.")), 30_000);
    })
  ]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
  return BigInt(serverInfo.virtualDaaScore?.toString() ?? connection.status.daaScore ?? "0");
}

function formatDate(value: number | undefined, language: Language) {
  return value
    ? new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US")
    : language === "zh"
      ? "未知"
      : "unknown";
}

function refundTimeoutSecondsFromMetadata(metadata: Pick<RaffleMetadata, "network" | "refundTimeoutSeconds" | "refundTimeoutDaa">): bigint {
  if (metadata.refundTimeoutSeconds && /^\d+$/.test(metadata.refundTimeoutSeconds)) {
    return BigInt(metadata.refundTimeoutSeconds);
  }

  if (metadata.refundTimeoutDaa && /^\d+$/.test(metadata.refundTimeoutDaa)) {
    return BigInt(metadata.refundTimeoutDaa) / KASPA_DAA_PER_SECOND;
  }

  return defaultRefundTimeoutSeconds(metadata.network);
}

export function App() {
  const rpcConnectionRef = useRef<KaspaRpcConnection | null>(null);
  const networkPickerRef = useRef<HTMLDivElement | null>(null);
  const walletPickerRef = useRef<HTMLDivElement | null>(null);
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const [networkEndpoints, setNetworkEndpoints] = useState<NetworkRpcEndpoints>(() => loadNetworkEndpoints());
  const [indexEndpoints, setIndexEndpoints] = useState<NetworkTextEndpoints>(() => loadIndexEndpoints());
  const [networkId, setNetworkId] = useState<SupportedNetworkId>("testnet-10");
  const [introGuidesSeen] = useState(initialIntroGuidesSeen);
  const [rpcUrl, setRpcUrl] = useState(() => loadNetworkEndpoints()["testnet-10"].url);
  const [isNetworkMenuOpen, setIsNetworkMenuOpen] = useState(false);
  const [networkSettingsId, setNetworkSettingsId] = useState<SupportedNetworkId | null>(null);
  const [networkEndpointModeDraft, setNetworkEndpointModeDraft] = useState<NetworkEndpointMode>("resolver");
  const [networkEndpointDraft, setNetworkEndpointDraft] = useState("");
  const [nodeStatus, setNodeStatus] = useState<KaspaNodeStatus>({
    connected: false,
    network: "unknown",
    syncStatus: "unknown"
  });
  const [isConnectingNode, setIsConnectingNode] = useState(false);
  const [virtualDaaScore, setVirtualDaaScore] = useState(0n);
  const [virtualDaaObservedAt, setVirtualDaaObservedAt] = useState(() => Date.now());
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [rpcError, setRpcError] = useState("");
  const [wallet, setWallet] = useState<BrowserTestWallet | null>(null);
  const [walletError, setWalletError] = useState("");
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);
  const [isWalletMenuOpen, setIsWalletMenuOpen] = useState(false);
  const [walletOptions, setWalletOptions] = useState<WalletAdapterOption[]>(() => listWalletAdapters());
  const [metadata, setMetadata] = useState<RaffleMetadata>(emptyMetadata);
  const [createParameters, setCreateParameters] = useState<Pick<RaffleMetadata, "ticketPrice" | "maxTickets" | "minTickets" | "maxBatches">>(() => ({
    ticketPrice: emptyMetadata.ticketPrice,
    maxTickets: emptyMetadata.maxTickets,
    minTickets: emptyMetadata.minTickets,
    maxBatches: emptyMetadata.maxBatches
  }));
  const [metadataText, setMetadataText] = useState(stringifyMetadata(emptyMetadata));
  const [metadataError, setMetadataError] = useState("");
  const [metadataMessage, setMetadataMessage] = useState("");
  const [ticketQuantity, setTicketQuantity] = useState("1");
  const [tickets, setTickets] = useState<TicketState[]>([]);
  const [finalized, setFinalized] = useState<FinalizeState | undefined>();
  const [terminalRoundStatus, setTerminalRoundStatus] = useState<"Refunded" | "Finalized" | "Closed" | undefined>();
  const [chainMessage, setChainMessage] = useState("");
  const [chainError, setChainError] = useState("");
  const [chainFeedbackTarget, setChainFeedbackTarget] = useState<ChainFeedbackTarget>("buy");
  const [isCreatingRound, setIsCreatingRound] = useState(false);
  const [isPublishingRegistry, setIsPublishingRegistry] = useState(false);
  const [isRecoveringRegistryMarker, setIsRecoveringRegistryMarker] = useState(false);
  const [registryRecoveryMessage, setRegistryRecoveryMessage] = useState("");
  const [registryRecoveryError, setRegistryRecoveryError] = useState("");
  const [isBuying, setIsBuying] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isClosingEmptyRound, setIsClosingEmptyRound] = useState(false);
  const [isRefundingRound, setIsRefundingRound] = useState(false);
  const [isToppingUpCarrier, setIsToppingUpCarrier] = useState(false);
  const [refundProgress, setRefundProgress] = useState<{ cursor: number; total: number } | null>(null);
  const [signingConfirmation, setSigningConfirmation] = useState<SigningConfirmationState>(idleSigningConfirmationState);
  const [isConfirmingSigning, setIsConfirmingSigning] = useState(false);
  const [covenantCarrierSompi, setCovenantCarrierSompi] = useState(DEFAULT_COVENANT_CARRIER_SOMPI.toString());
  const [topUpCarrierKas, setTopUpCarrierKas] = useState("0.19");
  const [refundTimeoutParts, setRefundTimeoutParts] = useState<RefundTimeoutParts>(DEFAULT_REFUND_TIMEOUT_PARTS);
  const [historyApiBase, setHistoryApiBase] = useState(requireNetworkProfile("testnet-10").historyApiBase);
  const [indexApiBase, setIndexApiBase] = useState(() => loadIndexEndpoints()["testnet-10"]);
  const [historyAddress, setHistoryAddress] = useState("");
  const [registryAddress, setRegistryAddress] = useState("");
  const [registryAutoRefund, setRegistryAutoRefund] = useState(false);
  const [createRegistryAddress, setCreateRegistryAddress] = useState("");
  const [historyRounds, setHistoryRounds] = useState<RaffleHistoryRound[]>(() => loadCachedRaffleHistory("testnet-10"));
  const [selectedHistoryRoundId, setSelectedHistoryRoundId] = useState(
    () => loadCachedRaffleHistory("testnet-10")[0]?.roundId ?? ""
  );
  const [historyError, setHistoryError] = useState("");
  const [historyMessage, setHistoryMessage] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isCheckingIndexer, setIsCheckingIndexer] = useState(false);
  const [indexerCheckState, setIndexerCheckState] = useState<"idle" | "ready" | "error">("idle");
  const [indexerCheckMessage, setIndexerCheckMessage] = useState("");
  const [roundSourceTab, setRoundSourceTab] = useState<RoundSourceTab>("history");
  const [isRoundSourceOpen, setIsRoundSourceOpen] = useState(false);
  const [roundActionTab, setRoundActionTab] = useState<RoundActionTab>("buy");
  const isCreatingRoundRef = useRef(false);
  const isPublishingRegistryRef = useRef(false);
  const isRecoveringRegistryMarkerRef = useRef(false);
  const isBuyingRef = useRef(false);
  const isFinalizingRef = useRef(false);
  const isClosingEmptyRoundRef = useRef(false);
  const isRefundingRoundRef = useRef(false);
  const isToppingUpCarrierRef = useRef(false);
  const isConnectingNodeRef = useRef(false);
  const covenantStatus = useMemo(() => getRaffleCovenantStatus(), []);
  const orderedHistoryRounds = useMemo(
    () => [...historyRounds].sort((left, right) => Number(historyRoundIsPlayable(right)) - Number(historyRoundIsPlayable(left))),
    [historyRounds, virtualDaaScore]
  );
  const selectedHistoryRound = useMemo(
    () => orderedHistoryRounds.find((historyRound) => historyRound.roundId === selectedHistoryRoundId) ?? orderedHistoryRounds[0],
    [orderedHistoryRounds, selectedHistoryRoundId]
  );
  const selectedHistoryRoundPlayable = Boolean(selectedHistoryRound && historyRoundIsPlayable(selectedHistoryRound));
  const playableHistoryRoundCount = orderedHistoryRounds.filter(historyRoundIsPlayable).length;
  const activeSoldBatches = metadata.covenant?.soldBatches ?? metadata.covenant?.ticketOwnerPubkeys.length ?? tickets.length;
  const registryPublicationPending = Boolean(
    metadata.covenant && metadata.createTxId && metadata.registryAddress && !metadata.registryTxId
  );
  const registryMarkerRefundPending = Boolean(
    metadata.registryTxId &&
    !metadata.registryRefundTxId &&
    metadata.registryAddress &&
    metadata.registryAddress === registryAddress &&
    registryAutoRefund
  );
  const activeLocalHistoryComplete = metadata.covenant
    ? hasCompleteTicketBatchHistory(tickets, metadata.covenant.soldTickets, activeSoldBatches)
    : true;
  const activeRoundNeedsIndexer = Boolean(
    metadata.covenant &&
    metadata.covenant.soldTickets > 0 &&
    requiresRaffleIndexerProof(metadata.maxTickets, activeLocalHistoryComplete)
  );
  const selectedHistoryRoundRequiresIndexer = Boolean(
    selectedHistoryRound && historyRoundNeedsIndexer(selectedHistoryRound)
  );
  const selectedHistoryRoundArchivedRelease = selectedHistoryRound
    ? archivedReleaseForRaffleContractVersion(selectedHistoryRound.contractVersion ?? "")
    : undefined;
  const selectedHistoryRoundQuarantined = Boolean(
    selectedHistoryRound && isQuarantinedRaffleContractVersion(selectedHistoryRound.contractVersion ?? "")
  );
  const refundTimeoutSeconds = useMemo(() => {
    try {
      return refundTimeoutSecondsFromParts(refundTimeoutParts);
    } catch {
      return 0n;
    }
  }, [refundTimeoutParts]);
  const refundTimeoutDaa = useMemo(() => refundTimeoutSeconds * KASPA_DAA_PER_SECOND, [refundTimeoutSeconds]);
  const recommendedMaxBatches = useMemo(() => {
    const interval = BigInt(PROTOCOL_MANIFEST.recommendedSecondsPerPurchaseBatch);
    const rawRecommendation = interval > 0n ? refundTimeoutSeconds / interval : 0n;
    const clamped = rawRecommendation < 1n
      ? 1n
      : rawRecommendation > BigInt(PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches)
        ? BigInt(PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches)
        : rawRecommendation;
    return Number(clamped);
  }, [refundTimeoutSeconds]);
  const refundTimeoutDisplay = useMemo(
    () => formatRefundTimeoutParts(refundTimeoutParts, language),
    [language, refundTimeoutParts]
  );
  const selectedNetwork = requireNetworkProfile(networkId);
  const currentNetworkEndpoint = networkEndpoints[networkId];
  const currencyUnit = networkId === "testnet-10" ? "TKAS" : "KAS";
  const localizeCurrencyUnit = (value: string) => currencyUnit === "KAS"
    ? value
    : value.replace(/\bKAS\b/g, currencyUnit);
  const formatKas = (value: bigint) => formatKasAmount(value, currencyUnit);
  const formatKasCompact = (value: bigint) => formatKasCompactAmount(value, currencyUnit);
  const t = (key: string, values?: TranslationValues) => localizeCurrencyUnit(translate(language, key, values));
  const rt = (value: string) => localizeCurrencyUnit(translateRuntimeText(language, value.replace(/\bTKAS\b/g, "KAS")));
  const networkLabel = (id: SupportedNetworkId) => t(id === "mainnet" ? "network.mainnet" : "network.testnet10");
  const endpointSummary = (endpoint: NetworkEndpointSettings) => (
    endpoint.mode === "resolver" ? t("node.resolver") : endpoint.url
  );

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    if (introGuidesSeen) {
      return;
    }

    try {
      localStorage.setItem(INTRO_GUIDES_STORAGE_KEY, "1");
    } catch {
      // Keep guides visible if the browser does not allow local storage.
    }
  }, [introGuidesSeen]);

  useEffect(() => {
    if (!isNetworkMenuOpen && !isWalletMenuOpen) {
      return;
    }

    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (isNetworkMenuOpen && !networkPickerRef.current?.contains(target)) {
        setIsNetworkMenuOpen(false);
        setNetworkSettingsId(null);
      }
      if (isWalletMenuOpen && !walletPickerRef.current?.contains(target)) {
        setIsWalletMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      setIsNetworkMenuOpen(false);
      setNetworkSettingsId(null);
      setIsWalletMenuOpen(false);
    };

    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isNetworkMenuOpen, isWalletMenuOpen]);

  useEffect(() => {
    setMetadataText(stringifyMetadata(metadata));
  }, [metadata]);

  useEffect(() => {
    if (!metadata.roundId || !metadata.covenant && !finalized) return;

    const walletAddress = wallet?.address.toLowerCase();
    const walletPubkey = wallet?.publicKey.toLowerCase();
    const participatedWithConnectedWallet = Boolean(wallet && (
      metadata.creatorAddress?.toLowerCase() === walletAddress ||
      metadata.creatorPubkey?.toLowerCase() === walletPubkey ||
      tickets.some((ticket) => (
        ticket.owner.toLowerCase() === walletAddress ||
        ticket.ownerPubkey?.toLowerCase() === walletPubkey
      ))
    ));

    if (
      participatedWithConnectedWallet ||
      hasCachedParticipatedRound(metadata.network, metadata.roundId)
    ) {
      cacheParticipatedRound(metadata, tickets, finalized);
      setHistoryRounds((current) => current.map((historyRound) => (
        historyRound.roundId === metadata.roundId && !historyRound.localCachedAt
          ? { ...historyRound, localCachedAt: Date.now() }
          : historyRound
      )));
    }
  }, [finalized, metadata, tickets, wallet]);

  useEffect(() => {
    if (!nodeStatus.connected || !rpcConnectionRef.current) {
      setVirtualDaaScore(0n);
      return;
    }

    let cancelled = false;
    const refreshDaa = async () => {
      const score = await currentVirtualDaaScore(rpcConnectionRef.current!);
      if (!cancelled) {
        setVirtualDaaScore(score);
        setVirtualDaaObservedAt(Date.now());
        setNodeStatus((current) => ({ ...current, daaScore: score.toString() }));
      }
    };

    void refreshDaa().catch(() => undefined);
    const interval = window.setInterval(() => void refreshDaa().catch(() => undefined), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [nodeStatus.connected]);

  useEffect(() => {
    const interval = window.setInterval(() => setCountdownNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    loadSharedRoundFromUrl();
  }, []);

  useEffect(() => {
    if (!wallet) {
      return;
    }

    const syncConnectedAccount = () => {
      let walletNetwork: SupportedNetworkId;
      try {
        walletNetwork = requireConnectedPageNetworkForWallet();
      } catch (error) {
        setWallet(null);
        setWalletError(error instanceof Error ? error.message : "Unable to update the connected wallet.");
        return;
      }

      void readConnectedBrowserWallet(wallet, walletNetwork)
        .then(async (nextWallet) => {
          if (!nextWallet) {
            setWallet(null);
            return;
          }

          const connection = rpcConnectionRef.current;
          if (!connection) throw new Error("Connect a Kaspa node before updating the wallet account.");
          const balanceSompi = await getAddressBalanceSompi(connection, nextWallet.address);
          setWallet(withWalletBalance(nextWallet, balanceSompi));
          setWalletError("");
        })
        .catch((error) => {
          setWallet(null);
          setWalletError(error instanceof Error ? error.message : "Unable to update the connected wallet.");
        });
    };
    const unsubscribe = subscribeBrowserWallet(wallet, syncConnectedAccount);

    return unsubscribe;
  }, [networkId, wallet?.adapterId, wallet?.address]);

  useEffect(() => {
    let cancelled = false;

    void getRaffleRegistryConfig(networkId)
      .then((config) => {
        if (!cancelled) {
          setRegistryAddress(config.address);
          setRegistryAutoRefund(config.autoRefund);
          setCreateRegistryAddress((current) => current || config.address);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRegistryAddress("");
          setRegistryAutoRefund(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [networkId]);

  const round = useMemo<RoundState>(() => {
    const ticketPrice = BigInt(metadata.ticketPrice || "0");
    const covenant = metadata.covenant;
    const covenantStatus = covenant?.status;
    const localSoldTickets = totalTicketCount(tickets);
    const soldTickets = Math.max(localSoldTickets, covenant?.soldTickets ?? 0);
    const status: RoundState["status"] = terminalRoundStatus ?? (finalized
      ? "Finalized"
      : covenantStatus === "Refunding" || covenantStatus === "Refunded"
        ? covenantStatus
      : covenantStatus === "Closed" || localSoldTickets >= metadata.maxTickets
        ? "Closed"
        : "Open");
    const refundedTickets = terminalRoundStatus === "Refunded"
      ? soldTickets
      : covenant?.status === "Refunding" || covenant?.status === "Refunded"
      ? covenant.refundCursor ?? 0
      : 0;
    const potAmount = ticketPrice * BigInt(Math.max(0, soldTickets - refundedTickets));

    return {
      appId: "KASPA_RAFFLE_ROUND_V1",
      contractVersion: metadata.contractVersion,
      roundId: metadata.roundId || "pending-round",
      creator: metadata.creatorAddress || wallet?.address || "no-wallet",
      ticketPrice,
      maxTickets: metadata.maxTickets,
      minTickets: metadata.minTickets,
      maxBatches: metadata.maxBatches,
      roundNonce: metadata.roundNonce,
      salesDeadlineDaa: metadata.salesDeadlineDaa,
      soldTickets,
      potAmount,
      feeBps: 0,
      status,
      randomnessMode: "kaspa-chain-pow",
      creatorPubkey: covenant?.creatorPubkey ?? metadata.creatorPubkey ?? (wallet ? pubkeyHexFromAddress(wallet.address) : ""),
      refundAfterDaaScore: covenant?.refundAfterDaaScore ?? metadata.refundAfterDaaScore ?? "0",
      ticketRoot: covenant?.ticketRoot ?? "",
      ticketFrontier: covenant?.ticketFrontier,
      refundCursor: covenant?.refundCursor ?? 0,
      refundBatchCursor: covenant?.refundBatchCursor ?? 0,
      soldBatches: covenant?.soldBatches ?? covenant?.ticketOwnerPubkeys.length ?? tickets.length,
      ticketBatchEnds: covenant?.ticketBatchEnds ?? tickets.map(ticketRangeEnd),
      ticketOwnerPubkeys: covenant?.ticketOwnerPubkeys ?? tickets.map((ticket) => ticket.ownerPubkey).filter(Boolean) as string[]
    };
  }, [finalized, metadata, terminalRoundStatus, tickets, wallet]);

  const hasCurrentRound = Boolean(metadata.roundId || metadata.covenant);
  const remainingTickets = Math.max(0, metadata.maxTickets - round.soldTickets);
  const parsedTicketQuantity = Number(ticketQuantity);
  const ticketQuantityIsAvailable = Number.isInteger(parsedTicketQuantity) &&
    parsedTicketQuantity > 0 &&
    parsedTicketQuantity <= remainingTickets;
  const purchaseTotal = ticketQuantityIsAvailable
    ? round.ticketPrice * BigInt(parsedTicketQuantity)
    : 0n;
  const createCarrierAmount = useMemo(() => {
    try {
      return BigInt(covenantCarrierSompi || "0");
    } catch {
      return 0n;
    }
  }, [covenantCarrierSompi]);
  const activeCreateRegistryAddress = createRegistryAddress.trim() || registryAddress;
  const usesDefaultRegistry = Boolean(registryAddress) && activeCreateRegistryAddress === registryAddress;
  const usesAutoRefundRegistry = usesDefaultRegistry && registryAutoRefund;
  const registryMarkerRefundAmount = DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI - REGISTRY_MARKER_REFUND_FEE_SOMPI;
  const createCostTooltip = usesAutoRefundRegistry
    ? t("cost.create.default", {
        carrier: formatKas(createCarrierAmount),
        createFee: formatKas(COVENANT_CREATE_FEE_SOMPI),
        marker: formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI),
        registryNet: formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI),
        registryFee: formatKas(REGISTRY_PAYMENT_FEE_SOMPI),
        refund: formatKas(registryMarkerRefundAmount),
        refundFee: formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI)
      })
    : t(usesDefaultRegistry ? "cost.create.retained" : "cost.create.custom", {
        carrier: formatKas(createCarrierAmount),
        createFee: formatKas(COVENANT_CREATE_FEE_SOMPI),
        marker: formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI),
        registryFee: formatKas(REGISTRY_PAYMENT_FEE_SOMPI)
      });
  const buyCostTooltip = t("cost.buy", { price: formatKas(purchaseTotal), fee: formatKas(covenantBuyFeeSompi(round.contractVersion, parsedTicketQuantity)) });
  const payoutCostTooltip = t("cost.payout", {
    prize: formatKas(round.potAmount),
    fee: formatKas(covenantFinalizeFeeSompi(round.contractVersion)),
    maxFee: formatKas(MAX_COVENANT_FINALIZE_FEE_SOMPI)
  });
  const emptyCloseCostTooltip = t("cost.closeEmpty", {
    carrier: formatKas(metadata.covenant
      ? BigInt(metadata.covenant.amountSompi) - BigInt(metadata.covenant.soldTickets) * BigInt(metadata.ticketPrice)
      : 0n),
    maxFee: formatKas(MAX_COVENANT_CLOSE_FEE_SOMPI)
  });
  const remainingRefundBatches = Math.max(
    1,
    (metadata.covenant?.soldBatches ?? metadata.covenant?.ticketOwnerPubkeys.length ?? 1) -
      (metadata.covenant?.refundBatchCursor ?? 0)
  );
  const estimatedRefundBatchCount = supportsGroupedRefunds(round.contractVersion)
    ? Math.min(MAX_REFUND_PURCHASE_BATCHES_PER_TX, remainingRefundBatches)
    : 1;
  const refundCostTooltip = t(hasFixedRefundTransitionFee(round.contractVersion) ? "cost.refund.legacy" : "cost.refund.current", {
    fee: formatKas(covenantRefundFeeSompi(round.contractVersion, estimatedRefundBatchCount)),
    transitionFee: formatKas(REFUND_TRANSITION_FEE_SOMPI),
    sponsor: formatKas(LEGACY_REFUND_TRANSITION_SPONSOR_SOMPI),
    maxFee: formatKas(covenantRefundMaxFeeSompi(round.contractVersion)),
    batches: estimatedRefundBatchCount
  });
  const refundAfterDaaScore = BigInt(metadata.covenant?.refundAfterDaaScore || metadata.refundAfterDaaScore || "0");
  const refundAvailable = Boolean(metadata.covenant) && refundAfterDaaScore > 0n && virtualDaaScore >= refundAfterDaaScore;
  const rescueBuyCandidate = Boolean(
    metadata.covenant &&
    metadata.covenant.status === "Open" &&
    refundAvailable &&
    metadata.covenant.soldTickets >= metadata.minTickets &&
    metadata.covenant.soldTickets < metadata.maxTickets &&
    !finalized &&
    !terminalRoundStatus
  );
  const rescueBuyQuantityOk = Number.isInteger(parsedTicketQuantity) && parsedTicketQuantity === 1;
  const rescueBuyAvailable = rescueBuyCandidate && rescueBuyQuantityOk && ticketQuantityIsAvailable;
  const rescueBuyNotice = rescueBuyCandidate
    ? t("rescueBuy.notice", { total: formatKas(BigInt(metadata.ticketPrice || "0")) })
    : "";
  useEffect(() => {
    if (metadata.covenant && !finalized && (metadata.covenant.soldTickets >= metadata.maxTickets || refundAvailable)) {
      setRoundActionTab("payout");
    }
  }, [finalized, metadata.covenant, metadata.maxTickets, refundAvailable]);
  useEffect(() => {
    if (rescueBuyAvailable) setRoundActionTab("buy");
  }, [rescueBuyAvailable]);
  const refundCountdownParts = useMemo(() => {
    if (!metadata.covenant || refundAfterDaaScore <= 0n || virtualDaaScore <= 0n) {
      return null;
    }

    // The node refreshes its DAA score every five seconds; advance the display between refreshes.
    const elapsedSeconds = BigInt(Math.max(0, Math.floor((countdownNow - virtualDaaObservedAt) / 1_000)));
    const displayedDaaScore = virtualDaaScore + elapsedSeconds * KASPA_DAA_PER_SECOND;
    const remainingDaa = refundAfterDaaScore > displayedDaaScore ? refundAfterDaaScore - displayedDaaScore : 0n;
    const remainingSeconds = (remainingDaa + KASPA_DAA_PER_SECOND - 1n) / KASPA_DAA_PER_SECOND;
    return refundTimeoutPartsFromSeconds(remainingSeconds);
  }, [countdownNow, metadata.covenant, refundAfterDaaScore, virtualDaaObservedAt, virtualDaaScore]);
  const drawTimeReached = round.soldTickets >= round.maxTickets || refundAvailable;
  const pageEligibility = derivePageEligibility({
    covenant: metadata.covenant ? {
      status: metadata.covenant.status,
      soldTickets: metadata.covenant.soldTickets,
      minTickets: metadata.minTickets,
      creatorPubkey: metadata.covenant.creatorPubkey
    } : undefined,
    finalized: Boolean(finalized || terminalRoundStatus),
    ticketQuantityIsAvailable,
    refundAvailable,
    drawTimeReached,
    covenantEnabled: covenantStatus.enabled && isSupportedRaffleContractVersion(metadata.contractVersion),
    walletPublicKey: wallet?.publicKey,
    isCreating: isCreatingRound,
    isBuying,
    isFinalizing,
    isClosingEmpty: isClosingEmptyRound,
    isRefunding: isRefundingRound
  });
  const {
    canStartNewRound,
    canBuy: eligibleCanBuy,
    canDraw: eligibleCanDraw,
    canRefund: eligibleCanRefund,
    canCloseEmpty: eligibleCanCloseEmpty
  } = pageEligibility;
  const finalizeCarrierSompi = metadata.covenant
    ? BigInt(metadata.covenant.amountSompi) - BigInt(metadata.covenant.soldTickets) * BigInt(metadata.ticketPrice)
    : 0n;
  const supportsCarrierTopUp = metadata.contractVersion === RAFFLE_CONTRACT_VERSION &&
    (!metadata.covenant || (metadata.covenant.soldTickets < metadata.minTickets && !refundAvailable));
  const carrierTopUpNeededSompi = finalizeCarrierSompi < MIN_COVENANT_CARRIER_SOMPI
    ? MIN_COVENANT_CARRIER_SOMPI - finalizeCarrierSompi
    : 0n;
  const drawBlockedReason = metadata.covenant && refundAvailable && metadata.covenant.soldTickets < metadata.minTickets
    ? t("finalizeBlocked.minimum", {
        sold: metadata.covenant.soldTickets.toLocaleString(),
        min: metadata.minTickets.toLocaleString()
      })
    : metadata.covenant && finalizeCarrierSompi < MIN_COVENANT_CARRIER_SOMPI
      ? t(supportsCarrierTopUp
        ? "finalizeBlocked.carrier.topUp"
        : metadata.contractVersion === RAFFLE_CONTRACT_VERSION
          ? "finalizeBlocked.carrier.locked"
          : "finalizeBlocked.carrier.legacy", {
        carrier: formatKas(finalizeCarrierSompi),
        minimum: formatKas(MIN_COVENANT_CARRIER_SOMPI),
        needed: formatKas(carrierTopUpNeededSompi)
        })
      : "";
  const buyBlockedReason = metadata.covenant && finalizeCarrierSompi < MIN_COVENANT_CARRIER_SOMPI
    ? t(supportsCarrierTopUp ? "buyBlocked.carrier.topUp" : "buyBlocked.carrier.locked", {
        carrier: formatKas(finalizeCarrierSompi),
        minimum: formatKas(MIN_COVENANT_CARRIER_SOMPI),
        needed: formatKas(carrierTopUpNeededSompi)
      })
    : "";
  const canBuy = (eligibleCanBuy || rescueBuyAvailable) && !buyBlockedReason && !isToppingUpCarrier;
  const canDraw = eligibleCanDraw && !drawBlockedReason && !isToppingUpCarrier;
  const canRefund = eligibleCanRefund && !isToppingUpCarrier;
  const canCloseEmpty = eligibleCanCloseEmpty && !isToppingUpCarrier;
  const parsedTopUpCarrierSompi = BigInt(kasInputToSompi(topUpCarrierKas));
  const canTopUpCarrier = Boolean(
    metadata.covenant &&
    wallet &&
    nodeStatus.connected &&
    supportsCarrierTopUp &&
    !finalized &&
    (metadata.covenant.status === "Open" || metadata.covenant.status === "Closed") &&
    parsedTopUpCarrierSompi >= MIN_COVENANT_TOP_UP_SOMPI &&
    !isCreatingRound && !isBuying && !isFinalizing && !isClosingEmptyRound && !isRefundingRound && !isToppingUpCarrier
  );
  const refundBlockedReason = !metadata.covenant || eligibleCanRefund
    ? ""
    : !nodeStatus.connected
      ? t("refundBlocked.node")
      : !covenantStatus.enabled
        ? t("refundBlocked.contract")
        : !refundAvailable
          ? t("refundBlocked.wait")
          : metadata.covenant.soldTickets >= metadata.minTickets
            ? t("refundBlocked.minimum", { sold: metadata.covenant.soldTickets.toLocaleString(), min: metadata.minTickets.toLocaleString() })
            : "";
  // ActionWorkspace uses canBuy; its equivalent UI policy is
  // disabled={isBuying || Boolean(finalized) || !ticketQuantityIsAvailable}.
  const networkSwitchDisabled = !pageEligibility.canSwitchNetwork || isToppingUpCarrier;

  useEffect(() => {
    const covenant = metadata.covenant;
    if (!covenant || metadata.contractVersion !== RAFFLE_CONTRACT_VERSION) return;
    const carrier = BigInt(covenant.amountSompi) - BigInt(covenant.soldTickets) * BigInt(metadata.ticketPrice);
    const needed = carrier < MIN_COVENANT_CARRIER_SOMPI
      ? MIN_COVENANT_CARRIER_SOMPI - carrier
      : 0n;
    const suggested = needed > MIN_COVENANT_TOP_UP_SOMPI ? needed : MIN_COVENANT_TOP_UP_SOMPI;
    setTopUpCarrierKas(sompiToKasInput(suggested.toString()));
  }, [metadata.contractVersion, metadata.covenant?.txId, metadata.ticketPrice]);

  const soldPercent = metadata.maxTickets > 0
    ? Math.min(100, (round.soldTickets / metadata.maxTickets) * 100)
    : 0;
  const ticketBatches = useMemo(() => {
    const batches = new Map<string, { txId: string; start: number; end: number; owner: string; count: number; amount: bigint }>();

    for (const ticket of [...tickets].sort((left, right) => left.ticketId - right.ticketId)) {
      const key = ticket.ticketTxId || `ticket-${ticket.ticketId}`;
      const existing = batches.get(key);
      const count = ticketRangeCount(ticket);

      if (existing) {
        existing.end = ticketRangeEnd(ticket);
        existing.count += count;
        existing.amount += ticket.paidAmount * BigInt(count);
      } else {
        batches.set(key, {
          txId: ticket.ticketTxId,
          start: ticket.ticketId,
          end: ticketRangeEnd(ticket),
          owner: ticket.owner,
          count,
          amount: ticket.paidAmount * BigInt(count)
        });
      }
    }

    return [...batches.values()];
  }, [tickets]);
  const selectedHistoryBatches = useMemo(() => {
    if (!selectedHistoryRound) {
      return [];
    }

    const batches = new Map<string, { txId: string; start: number; end: number; owner: string; count: number; amount: bigint }>();

    for (const ticket of [...selectedHistoryRound.tickets].sort((left, right) => left.ticketId - right.ticketId)) {
      const existing = batches.get(ticket.txId);
      const count = ticketRangeCount(ticket);

      if (existing) {
        existing.end = ticketRangeEnd(ticket);
        existing.count += count;
        existing.amount += ticket.paidAmount * BigInt(count);
      } else {
        batches.set(ticket.txId, {
          txId: ticket.txId,
          start: ticket.ticketId,
          end: ticketRangeEnd(ticket),
          owner: ticket.buyer,
          count,
          amount: ticket.paidAmount * BigInt(count)
        });
      }
    }

    return [...batches.values()];
  }, [selectedHistoryRound]);

  const verification = useMemo(() => verifyRaffleState({ round, tickets, finalized }), [finalized, round, tickets]);

  async function buildLocalBatchWitness(ticketId: number) {
    const covenant = metadata.covenant;
    if (!covenant || totalTicketCount(tickets) < covenant.soldTickets) {
      throw new Error("The complete ticket set is not available in this browser. Load the round history first.");
    }
    const orderedBatches = [...tickets].sort((left, right) => left.ticketId - right.ticketId);
    const batchIndex = orderedBatches.findIndex((ticket) => ticketId >= ticket.ticketId && ticketId <= ticketRangeEnd(ticket));
    const ticket = orderedBatches[batchIndex];
    if (!ticket) throw new Error(`Ticket #${ticketId} is missing from local history.`);
    const vNextRoundNonceHex = isVNextRaffleContractVersion(metadata.contractVersion)
      ? bytesToHex(await roundIdToBytes32(metadata.roundNonce || metadata.roundId))
      : "";
    const proof = isVNextRaffleContractVersion(metadata.contractVersion)
      ? await buildVNextBatchProof(
          orderedBatches.map((batch) => ({
            roundNonceHex: vNextRoundNonceHex,
            ownerPubkeyHex: batch.ownerPubkey || pubkeyHexFromAddress(batch.owner),
            firstTicketId: batch.ticketId - 1,
            ticketCount: ticketRangeCount(batch)
          })),
          batchIndex
        )
      : await buildTicketBatchProof(orderedBatches, batchIndex);
    if (proof.rootHex !== covenant.ticketRoot) throw new Error("Local ticket history does not match the covenant root.");
    return { ticket, batchIndex, proofHex: proof.proofHex };
  }

  function persistNetworkEndpoints(next: NetworkRpcEndpoints) {
    setNetworkEndpoints(next);
    localStorage.setItem(NETWORK_ENDPOINTS_STORAGE_KEY, JSON.stringify(next));
  }

  function handleRpcUrlInput(value: string) {
    setRpcUrl(value);
    persistNetworkEndpoints({ ...networkEndpoints, [networkId]: { mode: "custom", url: value } });
  }

  function handleIndexApiInput(value: string) {
    setIndexApiBase(value);
    setIndexerCheckState("idle");
    setIndexerCheckMessage("");
    const next = { ...indexEndpoints, [networkId]: value };
    setIndexEndpoints(next);
    localStorage.setItem(INDEX_ENDPOINTS_STORAGE_KEY, JSON.stringify(next));
  }

  async function requireReadyIndexer() {
    setIsCheckingIndexer(true);
    setIndexerCheckState("idle");
    setIndexerCheckMessage("");

    try {
      const health = await checkRaffleIndexer(indexApiBase);
      if (normalizeNetworkId(health.network) !== networkId) {
        throw new Error(t("indexerWrongNetwork", { actual: health.network, expected: networkLabel(networkId) }));
      }
      setIndexerCheckState("ready");
      setIndexerCheckMessage(t("indexerReady", {
        rounds: health.rounds.toLocaleString(),
        sync: health.syncing ? t("indexerStatus.syncing") : t("indexerStatus.ready")
      }));
      return health;
    } catch (error) {
      const detail = errorMessage(error, "Unable to reach the raffle indexer.");
      setIndexerCheckState("error");
      setIndexerCheckMessage(t("indexerConnectionFailed", { detail }));
      throw new Error(t("indexerRequiredError", { detail }));
    } finally {
      setIsCheckingIndexer(false);
    }
  }

  async function handleCheckIndexer() {
    await requireReadyIndexer().catch(() => undefined);
  }

  function openNetworkSettings(profileId: SupportedNetworkId) {
    const endpoint = networkEndpoints[profileId];
    setNetworkSettingsId(profileId);
    setNetworkEndpointModeDraft(endpoint.mode);
    setNetworkEndpointDraft(endpoint.url);
    setRpcError("");
  }

  function saveNetworkSettings() {
    if (!networkSettingsId) {
      return;
    }

    try {
      const endpoint: NetworkEndpointSettings = networkEndpointModeDraft === "resolver"
        ? { mode: "resolver", url: networkEndpointDraft.trim() || requireNetworkProfile(networkSettingsId).suggestedRpcUrl }
        : { mode: "custom", url: validateRpcUrl(networkEndpointDraft) };
      const next = { ...networkEndpoints, [networkSettingsId]: endpoint };
      persistNetworkEndpoints(next);
      setNetworkEndpoints(next);

      if (networkSettingsId === networkId) {
        setRpcUrl(endpoint.url);
        if (rpcConnectionRef.current) {
          void disconnectBrowserRpc(rpcConnectionRef.current).catch(() => undefined);
          rpcConnectionRef.current = null;
          setNodeStatus({ connected: false, network: "unknown", syncStatus: "unknown" });
        }
        void handleConnect(endpoint);
      }

      setNetworkSettingsId(null);
      setRpcError("");
    } catch (error) {
      setRpcError(errorMessage(error, "Unable to save the node endpoint."));
    }
  }

  async function handleSelectNetwork(nextNetwork: SupportedNetworkId) {
    if (nextNetwork === networkId) {
      setIsNetworkMenuOpen(false);
      return;
    }

    if (metadata.covenant && !canStartNewRound) {
      const confirmed = window.confirm(
        t("confirmSwitch")
      );

      if (!confirmed) {
        return;
      }
    }

    const nextProfile = requireNetworkProfile(nextNetwork);
    await disconnectBrowserRpc(rpcConnectionRef.current).catch(() => undefined);

    if (wallet) {
      await disconnectBrowserWallet(wallet).catch(() => undefined);
    }

    rpcConnectionRef.current = null;
    setNodeStatus({ connected: false, network: "unknown", syncStatus: "unknown" });
    setVirtualDaaScore(0n);
    setWallet(null);
    setNetworkId(nextNetwork);
    setRpcUrl(networkEndpoints[nextNetwork].url);
    setHistoryApiBase(nextProfile.historyApiBase);
    setIndexApiBase(indexEndpoints[nextNetwork]);
    setRefundTimeoutParts(refundTimeoutPartsFromSeconds(defaultRefundTimeoutSeconds(nextNetwork)));
    setHistoryAddress("");
    setRegistryAddress("");
    setRegistryAutoRefund(false);
    setCreateRegistryAddress("");
    const cachedRounds = loadCachedRaffleHistory(nextNetwork);
    setHistoryRounds(cachedRounds);
    setSelectedHistoryRoundId(cachedRounds[0]?.roundId ?? "");
    setMetadata(createEmptyMetadata(nextNetwork));
    setTickets([]);
    setFinalized(undefined);
    setTerminalRoundStatus(undefined);
    setChainError("");
    setChainMessage("");
    setRpcError("");
    setWalletError("");
    setMetadataError("");
    setMetadataMessage("");
    setHistoryError("");
    setHistoryMessage("");
    setIndexerCheckState("idle");
    setIndexerCheckMessage("");
    setRoundSourceTab("history");
    setIsRoundSourceOpen(false);
    setRoundActionTab("buy");
    setNetworkSettingsId(null);
    setIsNetworkMenuOpen(false);
  }

  async function handleConnect(endpointOverride?: NetworkEndpointSettings) {
    if (isConnectingNodeRef.current) {
      return;
    }

    isConnectingNodeRef.current = true;
    setIsConnectingNode(true);
    setRpcError("");

    try {
      await disconnectBrowserRpc(rpcConnectionRef.current);
      const selectedEndpoint = endpointOverride ?? currentNetworkEndpoint;
      const endpointSettings = selectedEndpoint.mode === "custom"
        ? { ...selectedEndpoint, url: endpointOverride?.url ?? rpcUrl }
        : selectedEndpoint;
      const endpoint = rpcTargetFromSettings(endpointSettings);
      const connection = await connectBrowserRpc(endpoint, networkId);
      const connectedNetwork = normalizeNetworkId(connection.status.network);

      if (connectedNetwork !== networkId) {
        await disconnectBrowserRpc(connection);
        throw new Error(`The node reports ${connection.status.network}, but ${networkLabel(selectedNetwork.id)} is selected.`);
      }

      rpcConnectionRef.current = connection;
      setNodeStatus({ ...connection.status, network: connectedNetwork });
      if (endpointSettings.mode === "custom") {
        persistNetworkEndpoints({ ...networkEndpoints, [networkId]: endpointSettings });
      }

      setMetadata((current) => (
        current.createTxId || current.covenant
          ? current
          : { ...current, network: connectedNetwork }
      ));

      if (wallet) {
        try {
          const nextWallet = await readConnectedBrowserWallet(wallet, connectedNetwork);
          if (!nextWallet) {
            setWallet(null);
          } else {
            const balanceSompi = await getAddressBalanceSompi(connection, nextWallet.address);
            setWallet(withWalletBalance(nextWallet, balanceSompi));
            setWalletError("");
          }
        } catch (error) {
          setWallet(null);
          setWalletError(error instanceof Error ? error.message : "Unable to update the connected wallet.");
        }
      }
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : "Unable to connect to node.");
      setNodeStatus((current) => ({ ...current, connected: false }));
    } finally {
      isConnectingNodeRef.current = false;
      setIsConnectingNode(false);
    }
  }

  useEffect(() => {
    if (nodeStatus.connected || rpcConnectionRef.current || isConnectingNodeRef.current || isConnectingNode) {
      return;
    }

    // Connect on first load, after changing networks, and after applying a
    // node endpoint. A short retry keeps timeout-based actions usable when a
    // resolver or custom endpoint is briefly unavailable.
    const reconnectDelay = rpcError ? 5_000 : 0;
    const timer = window.setTimeout(() => void handleConnect(), reconnectDelay);
    return () => window.clearTimeout(timer);
  }, [currentNetworkEndpoint.mode, currentNetworkEndpoint.url, isConnectingNode, networkId, nodeStatus.connected, rpcError]);

  function handleToggleWalletMenu() {
    setWalletOptions(listWalletAdapters());
    setIsWalletMenuOpen((current) => !current);
    setWalletError("");
  }

  function requireConnectedPageNetworkForWallet(): SupportedNetworkId {
    const connection = rpcConnectionRef.current;

    if (!connection || !nodeStatus.connected) {
      throw new Error("Connect a Kaspa node before connecting a wallet.");
    }

    const connectedNetwork = normalizeNetworkId(connection.status.network);
    if (connectedNetwork !== networkId) {
      throw new Error(`The connected node reports ${connection.status.network || "unknown"}, but ${networkLabel(networkId)} is selected.`);
    }

    return connectedNetwork as SupportedNetworkId;
  }

  async function handleConnectWallet(adapterId: string) {
    setWalletError("");
    setIsConnectingWallet(true);
    setIsWalletMenuOpen(false);

    try {
      const walletNetwork = requireConnectedPageNetworkForWallet();
      let connectedWallet = await withWalletConnectionTimeout(connectBrowserWallet(adapterId, walletNetwork));

      let balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current!, connectedWallet.address);
      if (balanceSompi === 0n) {
        await new Promise((resolve) => window.setTimeout(resolve, 750));
        balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current!, connectedWallet.address);
      }
      connectedWallet = withWalletBalance(connectedWallet, balanceSompi);

      setWallet(connectedWallet);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Unable to connect the selected wallet.");
    } finally {
      setIsConnectingWallet(false);
    }
  }

  async function handleDisconnectWallet() {
    setWalletError("");

    try {
      if (wallet) {
        await disconnectBrowserWallet(wallet);
      }
      setWallet(null);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Unable to disconnect KasWare Wallet.");
    }
  }

  async function handleRefreshBalance() {
    setWalletError("");

    if (!wallet) {
      setWalletError("Connect a wallet first.");
      return;
    }

    if (!rpcConnectionRef.current) {
      setWalletError("Connect to a Kaspa wRPC node first.");
      return;
    }

    try {
      const balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current, wallet.address);
      setWallet(withWalletBalance(wallet, balanceSompi));
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Unable to refresh balance.");
    }
  }

  function prepareRoundForCreate(forceNew = false) {
    const roundId = forceNew || !metadata.roundId ? `round-${randomHex(8)}` : metadata.roundId;
    return roundId;
  }

  function applyMetadata(nextMetadata: RaffleMetadata, message: string) {
    const profile = requireNetworkProfile(nextMetadata.network);
    const normalizedMetadata = { ...nextMetadata, network: profile.id };
    const loadedRefundTimeoutSeconds = refundTimeoutSecondsFromMetadata(normalizedMetadata);
    const networkChanged = profile.id !== networkId || rpcConnectionRef.current?.status.network !== profile.id;

    if (networkChanged) {
      void disconnectBrowserRpc(rpcConnectionRef.current).catch(() => undefined);
      rpcConnectionRef.current = null;
      setNodeStatus({ connected: false, network: "unknown", syncStatus: "unknown" });
      setVirtualDaaScore(0n);
      if (wallet) {
        void disconnectBrowserWallet(wallet).catch(() => undefined);
        setWallet(null);
        setWalletError("");
      }
    }

    setMetadata(normalizedMetadata);
    setTerminalRoundStatus(
      normalizedMetadata.covenant?.status === "Refunded"
        ? "Refunded"
        : normalizedMetadata.covenant?.status === "Finalized"
          ? "Finalized"
          : undefined
    );
    setRefundTimeoutParts(refundTimeoutPartsFromSeconds(loadedRefundTimeoutSeconds));
    setNetworkId(profile.id);
    setRpcUrl(networkEndpoints[profile.id].url);
    setHistoryApiBase(profile.historyApiBase);
    setIndexApiBase(indexEndpoints[profile.id]);
    setCreateRegistryAddress(normalizedMetadata.registryAddress ?? "");
    setHistoryAddress(normalizedMetadata.registryAddress ?? "");
    setTickets(recoverTicketStatesFromCovenantBatches({
      roundId: normalizedMetadata.roundId,
      ticketPrice: BigInt(normalizedMetadata.ticketPrice || "0"),
      covenant: normalizedMetadata.covenant,
      network: profile.id
    }));
    setFinalized(undefined);
    setChainError("");
    setChainMessage("");
    setRegistryRecoveryError("");
    setRegistryRecoveryMessage("");
    setMetadataError("");
    setMetadataMessage(message);
  }

  function handleImportMetadata() {
    try {
      applyMetadata(parseMetadata(metadataText), "Round metadata loaded.");
    } catch (error) {
      setMetadataMessage("");
      setMetadataError(errorMessage(error, "Unable to import round metadata."));
    }
  }

  async function handleCopyRoundLink() {
    try {
      const shareMetadata = parseMetadata(stringifyMetadata(metadata));
      const url = new URL(window.location.href);
      url.searchParams.set("round", encodeShareMetadata(shareMetadata));
      await navigator.clipboard.writeText(url.toString());
      setMetadataError("");
      setMetadataMessage("Round link copied.");
    } catch (error) {
      setMetadataMessage("");
      setMetadataError(errorMessage(error, "Unable to copy round link."));
    }
  }

  function loadSharedRoundFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const sharedRound = params.get("round");

    if (!sharedRound) {
      return;
    }

    try {
      applyMetadata(decodeShareMetadata(sharedRound), "Shared round loaded from URL.");
    } catch (error) {
      setMetadataMessage("");
      setMetadataError(errorMessage(error, "Unable to load shared round from URL."));
    }
  }

  function requestCreateSigningConfirmation() {
    setChainFeedbackTarget("create");
    setChainError("");
    setChainMessage("");
    if (!wallet) {
      setChainError("Connect a funded creator wallet first.");
      return;
    }
    if (!/^\d+$/.test(createParameters.ticketPrice) || BigInt(createParameters.ticketPrice) < MIN_REFUNDABLE_TICKET_PRICE_SOMPI) {
      setChainError(`Ticket price must be at least ${formatKas(MIN_REFUNDABLE_TICKET_PRICE_SOMPI)} so even a one-ticket purchase remains refundable at the covenant fee caps.`);
      return;
    }
    if (BigInt(createParameters.ticketPrice) * BigInt(createParameters.maxTickets) > MAX_ROUND_PRINCIPAL_SOMPI) {
      setChainError(`Ticket price multiplied by max tickets must not exceed ${formatKas(MAX_ROUND_PRINCIPAL_SOMPI)}.`);
      return;
    }
    if (!Number.isSafeInteger(createParameters.minTickets) || createParameters.minTickets < 1 || createParameters.minTickets > createParameters.maxTickets) {
      setChainError("Minimum draw tickets must be a whole number from 1 to the total ticket count.");
      return;
    }
    setSigningConfirmation(openSigningConfirmation(buildSigningPreview({
      operation: "create",
      network: networkLabel(networkId),
      address: wallet.address,
      inputCount: t("signing.input.create"),
      payment: t("signing.payment.create", {
        carrier: formatKas(createCarrierAmount),
        marker: formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI),
        refund: formatKas(registryMarkerRefundAmount),
        registryNet: formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI)
      }),
      fee: t("signing.fee.create", { fee: formatKas(COVENANT_CREATE_FEE_SOMPI), registryFee: formatKas(REGISTRY_PAYMENT_FEE_SOMPI) }),
      carrier: formatKas(createCarrierAmount),
      change: wallet.address,
      covenant: t("signing.covenant.derived"),
      registry: activeCreateRegistryAddress || t("signing.notConfigured"),
      ticketRange: t("signing.ticketRange.none")
    })));
  }

  async function executeCreateCovenantRound() {
    setChainFeedbackTarget("create");
    setChainError("");
    setChainMessage("");
    setRegistryRecoveryError("");
    setRegistryRecoveryMessage("");
    let createdRecoveryNotice = "";

    if (isCreatingRoundRef.current) {
      return;
    }

    isCreatingRoundRef.current = true;
    setIsCreatingRound(true);

    try {
      assertRaffleCovenantReady();

      if (!wallet) {
        throw new Error("Connect a funded creator wallet first.");
      }

      if (!rpcConnectionRef.current) {
        throw new Error("Connect to a Kaspa wRPC node first.");
      }

      if (!canStartNewRound) {
        throw new Error("This round already has a covenant UTXO.");
      }

      if (createParameters.maxTickets > 1_000_000) {
        throw new Error("This covenant supports at most 1000000 tickets per round.");
      }

      const carrierAmountSompi = parseMinimumSompi(
        covenantCarrierSompi,
        "Carrier reserve",
        MIN_COVENANT_CARRIER_SOMPI
      );
      const targetRegistryAddress = activeCreateRegistryAddress;

      if (!targetRegistryAddress) {
        throw new Error("Set a Registry address before creating the round.");
      }

      await assertValidKaspaAddress(targetRegistryAddress, "Registry address");

      if (networkFromAddress(targetRegistryAddress) !== networkId) {
        throw new Error(`Registry address must belong to ${networkLabel(selectedNetwork.id)}.`);
      }

      const autoRefundRegistryMarker = usesAutoRefundRegistry;
      const refundDelaySeconds = refundTimeoutSecondsFromParts(refundTimeoutParts);
      const refundDelayDaa = refundDelaySeconds * KASPA_DAA_PER_SECOND;

      if (refundDelayDaa <= 0n) {
        throw new Error("Refund timeout must be greater than zero seconds.");
      }

      const creationDagInfo = await rpcConnectionRef.current.client.getBlockDagInfo();
      const createdAtDaaScore = creationDagInfo.virtualDaaScore;
      const chainSearchHintHash = creationDagInfo.sink;
      assertToccataActive(networkId, createdAtDaaScore);
      const refundAfterDaaScore = createdAtDaaScore + refundDelayDaa;
      const creatorPubkey = pubkeyHexFromAddress(wallet.address);
      const roundId = prepareRoundForCreate(Boolean(metadata.covenant));
      const contractVersion = raffleContractVersionForNetwork(networkId);
      const creationRound: RoundState = {
        ...round,
        contractVersion,
        roundId,
        creator: wallet.address,
        creatorPubkey,
        ticketPrice: BigInt(createParameters.ticketPrice),
        maxTickets: createParameters.maxTickets,
        minTickets: createParameters.minTickets,
        soldTickets: 0,
        potAmount: 0n,
        status: "Open",
        ticketRoot: TICKET_EMPTY_ROOT_HEX,
        ticketFrontier: TICKET_EMPTY_FRONTIER_HEX,
        chainSearchHintHash,
        // vNext commits these values in the Round covenant. roundId is a
        // public 32-byte nonce as well as the shareable identifier.
        roundNonce: roundId,
        maxBatches: createParameters.maxBatches ?? 100,
        salesDeadlineDaa: refundAfterDaaScore.toString(),
        refundCursor: 0,
        refundBatchCursor: 0,
        soldBatches: 0,
        ticketBatchEnds: [],
        refundAfterDaaScore: refundAfterDaaScore.toString(),
        ticketOwnerPubkeys: []
      };
      const payload = encodePayload({
        app: "kaspa-raffle-static",
        type: "round-create",
        version: metadata.version,
        roundId,
        creator: wallet.address,
        ticketPrice: createParameters.ticketPrice,
        maxTickets: createParameters.maxTickets,
        minTickets: createParameters.minTickets,
        maxBatches: createParameters.maxBatches ?? 100,
        roundNonce: roundId,
        salesDeadlineDaa: refundAfterDaaScore.toString(),
        creatorPubkey,
        createdAtDaaScore: createdAtDaaScore.toString(),
        refundAfterDaaScore: refundAfterDaaScore.toString(),
        chainSearchHintHash,
        refundTimeoutSeconds: refundDelaySeconds.toString(),
        refundTimeoutDaa: refundDelayDaa.toString(),
        registryAddress: targetRegistryAddress,
        contractVersion,
        createdAt: new Date().toISOString()
      });
      const result = await createRaffleCovenantRound({
        connection: rpcConnectionRef.current,
        wallet,
        round: creationRound,
        carrierAmountSompi,
        payload
      });

      if (!result.covenant) {
        throw new Error("Covenant round was created without a cursor.");
      }

      // Persist the authoritative covenant cursor before Registry publication,
      // marker refund, delays, or balance refresh. Any of those secondary
      // operations may fail after the carrier is already on chain.
      const createdMetadata: RaffleMetadata = {
        ...metadata,
        ...createParameters,
        roundId,
        roundNonce: roundId,
        contractVersion,
        createTxId: result.txId,
        creatorAddress: wallet.address,
        creatorPubkey,
        createdAtDaaScore: createdAtDaaScore.toString(),
        startBlockHash: chainSearchHintHash,
        refundTimeoutSeconds: refundDelaySeconds.toString(),
        refundTimeoutDaa: refundDelayDaa.toString(),
        salesDeadlineDaa: refundAfterDaaScore.toString(),
        refundAfterDaaScore: refundAfterDaaScore.toString(),
        treasuryAddress: result.covenant.address,
        registryAddress: targetRegistryAddress,
        covenant: result.covenant
      };
      const createdCacheSaved = cacheParticipatedRound(createdMetadata, []);
      setMetadata(createdMetadata);
      setTickets([]);
      setFinalized(undefined);
      setTerminalRoundStatus(undefined);
      setRoundActionTab("buy");
      createdRecoveryNotice = createdCacheSaved
        ? ` Covenant creation succeeded and was saved locally. Round ID ${roundId}; create transaction ${result.txId}.`
        : ` Covenant creation succeeded, but browser storage was unavailable. Keep this page open and copy Round ID ${roundId} and create transaction ${result.txId}.`;

      let registryTxIds: string[] = [];
      let registryRefundTxId = "";
      let registryPaymentFeeSompi = 0n;
      let registryWarning = "";

      try {
        setChainMessage(
          `Covenant round created: ${result.txId}. Waiting for confirmed wallet inputs before the separate Registry signing request.`
        );
        const registryResult = await sendKaspaPayment({
          connection: rpcConnectionRef.current,
          wallet,
          toAddress: targetRegistryAddress,
          amountSompi: DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI,
          payload: encodeRegistryPayload(createdMetadata),
          confirmedParentOutpoint: {
            address: result.covenant.address,
            transactionId: result.txId,
            index: result.covenant.outputIndex
          },
          excludedOutpoints: result.spentWalletOutpoints
        });
        registryTxIds = registryResult.txIds;
        registryPaymentFeeSompi = registryResult.feeSompi;

        const markerTxId = registryTxIds[registryTxIds.length - 1];
        if (markerTxId) {
          const publishedMetadata = { ...createdMetadata, registryTxId: markerTxId };
          setMetadata(publishedMetadata);
          cacheParticipatedRound(publishedMetadata, []);
        }

        if (markerTxId && autoRefundRegistryMarker) {
          try {
            registryRefundTxId = await refundRaffleRegistryMarker({
              connection: rpcConnectionRef.current,
              registryAddress: targetRegistryAddress,
              markerTxId,
              refundAddress: wallet.address
            });
            const settledMetadata = { ...createdMetadata, registryTxId: markerTxId, registryRefundTxId };
            setMetadata(settledMetadata);
            cacheParticipatedRound(settledMetadata, []);
          } catch (error) {
            registryWarning = `Registry marker refund failed: ${errorMessage(error, "Unable to refund registry marker.")}`;
          }
        }
      } catch (error) {
        registryWarning = `Registry indexing failed: ${errorMessage(error, "Unable to register round.")}`;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 4_000));
      const balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current, wallet.address);

      setWallet(withWalletBalance(wallet, balanceSompi));
      setMetadata((current) => ({
        ...current,
        roundId,
        roundNonce: roundId,
        contractVersion,
        createTxId: result.txId,
        creatorAddress: wallet.address,
        creatorPubkey,
        createdAtDaaScore: createdAtDaaScore.toString(),
        startBlockHash: chainSearchHintHash,
        refundTimeoutSeconds: refundDelaySeconds.toString(),
        refundTimeoutDaa: refundDelayDaa.toString(),
        salesDeadlineDaa: refundAfterDaaScore.toString(),
        refundAfterDaaScore: refundAfterDaaScore.toString(),
        treasuryAddress: result.covenant?.address ?? current.treasuryAddress,
        registryAddress: targetRegistryAddress,
        covenant: result.covenant
      }));
      setTickets([]);
      setFinalized(undefined);
      setRoundActionTab("buy");
      setHistoryAddress(targetRegistryAddress);
      setHistoryRounds((current) => [{
        roundId,
        registryTxId: registryTxIds.at(-1),
        registryRefundTxId: registryRefundTxId || undefined,
        registryAddress: targetRegistryAddress,
        createTxId: result.txId,
        treasuryAddress: result.covenant!.address,
        covenantId: result.covenant!.covenantId,
        latestCovenant: result.covenant,
        creator: wallet.address,
        creatorPubkey,
        createdAtDaaScore: createdAtDaaScore.toString(),
        refundTimeoutSeconds: refundDelaySeconds.toString(),
        maxBatches: createParameters.maxBatches ?? 100,
        roundNonce: roundId,
        salesDeadlineDaa: refundAfterDaaScore.toString(),
        refundAfterDaaScore: refundAfterDaaScore.toString(),
        chainSearchHintHash,
        refundTimeoutDaa: refundDelayDaa.toString(),
        ticketPrice: BigInt(createParameters.ticketPrice),
        maxTickets: createParameters.maxTickets,
        minTickets: createParameters.minTickets,
        version: metadata.version,
        contractVersion,
        tickets: [],
        payouts: [],
        potAmount: 0n,
        soldTickets: 0,
        lastBlockTime: Date.now()
      }, ...current.filter((historyRound) => historyRound.roundId !== roundId)]);
      setSelectedHistoryRoundId(roundId);
      const registryResultMessage = registryTxIds.length
        ? autoRefundRegistryMarker
          ? `Registry marker sent ${formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI)} to ${targetRegistryAddress}; wallet network fee ${formatKas(registryPaymentFeeSompi)}. ${registryRefundTxId ? `${formatKas(registryMarkerRefundAmount)} returned; non-refundable Registry cost ${formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI)}: ${registryRefundTxId}.` : "Automatic marker return is pending or failed."}`
          : `Registry marker sent ${formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI)} to ${targetRegistryAddress}; payment fee ${formatKas(registryPaymentFeeSompi)}. ${usesDefaultRegistry ? "The default registry marker remains at its address for public indexing." : "Custom registry markers are not automatically refunded."}`
        : "Registry marker was not submitted.";
      setChainMessage(
        `Covenant round created: ${result.txId} (single create-transaction network fee ${formatKas(result.feeSompi ?? COVENANT_CREATE_FEE_SOMPI)}${result.fundingFeeSompi ? `; fallback funding fee ${formatKas(result.fundingFeeSompi)}` : "; no preliminary funding transaction"}). ${registryResultMessage}`
      );
      setChainError(registryWarning);
      setRegistryRecoveryError(registryWarning);
      setRegistryRecoveryMessage(registryTxIds.length ? registryResultMessage : "");
    } catch (error) {
      if (!createdRecoveryNotice && !metadata.covenant) {
        setMetadata((current) => current.covenant ? current : {
          ...current,
          roundId: "",
          createTxId: "",
          treasuryAddress: ""
        });
      }
      setChainError(`${errorMessage(error, "Unable to create covenant round.")}${createdRecoveryNotice}`);
    } finally {
      isCreatingRoundRef.current = false;
      setIsCreatingRound(false);
    }
  }

  function requestRegistrySigningConfirmation() {
    setRegistryRecoveryError("");
    setRegistryRecoveryMessage("");
    const covenant = metadata.covenant;
    const targetRegistryAddress = metadata.registryAddress?.trim();
    if (!wallet) {
      setRegistryRecoveryError("Connect a funded wallet before publishing the Registry record.");
      return;
    }
    if (!covenant || !metadata.roundId || !metadata.createTxId || !targetRegistryAddress) {
      setRegistryRecoveryError("The current round is missing data required to publish its Registry record.");
      return;
    }
    if (metadata.registryTxId) {
      setRegistryRecoveryMessage(`Registry record already published: ${metadata.registryTxId}`);
      return;
    }
    setSigningConfirmation(openSigningConfirmation(buildSigningPreview({
      operation: "publish-registry",
      network: networkLabel(networkId),
      address: wallet.address,
      inputCount: t("signing.input.registry"),
      payment: t("signing.payment.registry", {
        marker: formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI),
        refund: formatKas(registryMarkerRefundAmount),
        registryNet: formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI)
      }),
      fee: t("signing.fee.registry", { fee: formatKas(REGISTRY_PAYMENT_FEE_SOMPI) }),
      carrier: formatKas(BigInt(covenant.amountSompi)),
      change: wallet.address,
      covenant: covenant.address,
      registry: targetRegistryAddress,
      ticketRange: t("signing.ticketRange.none"),
      snapshot: registrySnapshot({ roundId: metadata.roundId, createTxId: metadata.createTxId, registryAddress: targetRegistryAddress })
    })));
  }

  async function executeRegistryPublication() {
    if (isPublishingRegistryRef.current) return;
    isPublishingRegistryRef.current = true;
    setIsPublishingRegistry(true);
    setRegistryRecoveryError("");
    setRegistryRecoveryMessage("");

    try {
      if (!wallet) throw new Error("Connect a funded wallet before publishing the Registry record.");
      if (!rpcConnectionRef.current) throw new Error("Connect to a Kaspa wRPC node first.");
      const covenant = metadata.covenant;
      const targetRegistryAddress = metadata.registryAddress?.trim();
      if (!covenant || !metadata.roundId || !metadata.createTxId || !targetRegistryAddress) {
        throw new Error("The current round is missing data required to publish its Registry record.");
      }
      if (metadata.registryTxId) {
        setRegistryRecoveryMessage(`Registry record already published: ${metadata.registryTxId}`);
        return;
      }

      // Avoid charging for a duplicate marker after a lost RPC response. A
      // recovery publish is allowed only after the read-only Registry history
      // confirms that this exact round/create pair is still absent.
      let existingRound: RaffleHistoryRound | undefined;
      try {
        existingRound = (await loadRaffleHistory(historyApiBase, targetRegistryAddress)).find((candidate) => (
          candidate.roundId === metadata.roundId &&
          (!candidate.createTxId || candidate.createTxId === metadata.createTxId) &&
          Boolean(candidate.registryTxId)
        ));
      } catch {
        throw new Error("Registry history could not be checked, so no duplicate publication or wallet signing request was attempted. Restore the History service and retry.");
      }
      if (existingRound?.registryTxId) {
        const recoveredMetadata = { ...metadata, registryTxId: existingRound.registryTxId };
        setMetadata(recoveredMetadata);
        cacheParticipatedRound(recoveredMetadata, tickets, finalized);
        setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
          ? { ...historyRound, registryTxId: existingRound!.registryTxId }
          : historyRound));
        setRegistryRecoveryMessage(`Registry record was already accepted and has been recovered: ${existingRound.registryTxId}`);
        return;
      }

      setRegistryRecoveryMessage("Waiting for confirmed wallet inputs before the Registry signing request…");
      const registryResult = await sendKaspaPayment({
        connection: rpcConnectionRef.current,
        wallet,
        toAddress: targetRegistryAddress,
        amountSompi: DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI,
        payload: encodeRegistryPayload(metadata),
        confirmedParentOutpoint: {
          address: covenant.address,
          transactionId: metadata.createTxId,
          index: 0
        }
      });
      const markerTxId = registryResult.txIds.at(-1);
      if (!markerTxId) throw new Error("Registry publication returned no transaction id.");

      let nextMetadata = { ...metadata, registryTxId: markerTxId };
      setMetadata(nextMetadata);
      cacheParticipatedRound(nextMetadata, tickets, finalized);
      setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
        ? { ...historyRound, registryTxId: markerTxId }
        : historyRound));

      let refundTxId = "";
      if (targetRegistryAddress === registryAddress && registryAutoRefund) {
        refundTxId = await refundRaffleRegistryMarker({
          connection: rpcConnectionRef.current,
          registryAddress: targetRegistryAddress,
          markerTxId,
          refundAddress: wallet.address
        });
        nextMetadata = { ...nextMetadata, registryRefundTxId: refundTxId };
        setMetadata(nextMetadata);
        cacheParticipatedRound(nextMetadata, tickets, finalized);
      }
      setRegistryRecoveryMessage(
        `Registry record published: ${markerTxId} (wallet network fee ${formatKas(registryResult.feeSompi)}). ` +
        (refundTxId
          ? `${formatKas(registryMarkerRefundAmount)} returned in ${refundTxId}; non-refundable Registry cost ${formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI)}.`
          : "The marker remains at the configured Registry address.")
      );
    } catch (error) {
      setRegistryRecoveryError(errorMessage(error, "Unable to publish the Registry record."));
    } finally {
      isPublishingRegistryRef.current = false;
      setIsPublishingRegistry(false);
    }
  }

  async function executeRegistryMarkerRecovery() {
    if (isRecoveringRegistryMarkerRef.current) return;
    isRecoveringRegistryMarkerRef.current = true;
    setIsRecoveringRegistryMarker(true);
    setRegistryRecoveryError("");
    setRegistryRecoveryMessage("");

    try {
      const markerTxId = metadata.registryTxId;
      const targetRegistryAddress = metadata.registryAddress?.trim();
      const refundAddress = metadata.creatorAddress?.trim();
      const committedCreatorPubkey = metadata.covenant?.creatorPubkey || metadata.creatorPubkey;
      if (!markerTxId || !targetRegistryAddress || !refundAddress || !committedCreatorPubkey) {
        throw new Error("The current round is missing data required to recover its Registry marker return.");
      }
      if (pubkeyHexFromAddress(refundAddress).toLowerCase() !== committedCreatorPubkey.toLowerCase()) {
        throw new Error("The Registry marker return address does not match the creator public key committed by the covenant.");
      }
      if (metadata.registryRefundTxId) {
        setRegistryRecoveryMessage(`Registry marker return already recorded: ${metadata.registryRefundTxId}`);
        return;
      }
      if (targetRegistryAddress !== registryAddress || !registryAutoRefund) {
        throw new Error("This Registry address does not use the automatic Kaswin marker-return policy.");
      }

      // A lost RPC response must not make the page blindly submit the same
      // outpoint again. The public History service is only used to discover an
      // accepted spender; the expected refund address and amount are checked
      // locally before that transaction id is trusted.
      let acceptedSpend: Awaited<ReturnType<typeof loadAcceptedOutpointSpend>>;
      try {
        acceptedSpend = await loadAcceptedOutpointSpend(
          historyApiBase,
          targetRegistryAddress,
          markerTxId,
          0,
          500
        );
      } catch {
        throw new Error("Registry marker history could not be checked, so no recovery transaction was attempted. Restore the History service and retry.");
      }

      if (acceptedSpend) {
        const expectedOutputs = acceptedSpend.outputs.filter((output) => (
          output.address === refundAddress && output.amount === registryMarkerRefundAmount
        ));
        if (acceptedSpend.outputs.length !== 1 || expectedOutputs.length !== 1) {
          throw new Error(
            `Registry marker ${markerTxId} was already spent by ${acceptedSpend.transactionId}, but it did not return the exact ${formatKas(registryMarkerRefundAmount)} to the committed creator address. No retry was attempted.`
          );
        }
        const recoveredMetadata = { ...metadata, registryRefundTxId: acceptedSpend.transactionId };
        setMetadata(recoveredMetadata);
        cacheParticipatedRound(recoveredMetadata, tickets, finalized);
        setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
          ? { ...historyRound, registryRefundTxId: acceptedSpend!.transactionId }
          : historyRound));
        setRegistryRecoveryMessage(`Registry marker return was already accepted and has been recovered: ${acceptedSpend.transactionId}`);
        return;
      }

      if (!rpcConnectionRef.current) throw new Error("Connect to a Kaspa wRPC node before recovering the Registry marker return.");
      setRegistryRecoveryMessage("Waiting for the Registry marker to be confirmed before its public return…");
      const refundTxId = await refundRaffleRegistryMarker({
        connection: rpcConnectionRef.current,
        registryAddress: targetRegistryAddress,
        markerTxId,
        refundAddress
      });
      const recoveredMetadata = { ...metadata, registryRefundTxId: refundTxId };
      setMetadata(recoveredMetadata);
      cacheParticipatedRound(recoveredMetadata, tickets, finalized);
      setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
        ? { ...historyRound, registryRefundTxId: refundTxId }
        : historyRound));
      setRegistryRecoveryMessage(
        `${formatKas(registryMarkerRefundAmount)} Registry marker return submitted to the creator: ${refundTxId}. ` +
        `${formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI)} remains the non-refundable Registry cost.`
      );
    } catch (error) {
      setRegistryRecoveryError(errorMessage(error, "Unable to recover the Registry marker return."));
    } finally {
      isRecoveringRegistryMarkerRef.current = false;
      setIsRecoveringRegistryMarker(false);
    }
  }

  function ticketSalesClosedMessage(covenant: NonNullable<RaffleMetadata["covenant"]>) {
    const values = { daa: covenant.refundAfterDaaScore || metadata.refundAfterDaaScore || "0" };
    if (covenant.soldTickets === 0) return t("salesClosed.empty", values);
    if (covenant.soldTickets < metadata.minTickets) return t("salesClosed.refund", values);
    return t("salesClosed.draw", values);
  }

  function settlementFeedbackTarget(covenant: NonNullable<RaffleMetadata["covenant"]>): ChainFeedbackTarget {
    if (covenant.soldTickets === 0) return "close";
    if (covenant.soldTickets < metadata.minTickets) return "refund";
    return "draw";
  }

  function requestBuySigningConfirmation() {
    setChainFeedbackTarget("buy");
    setChainError("");
    setChainMessage("");
    const covenant = metadata.covenant;
    if (!covenant || !metadata.roundId) {
      setChainError("Create or load a raffle round before buying tickets.");
      return;
    }
    const salesDeadline = BigInt(covenant.refundAfterDaaScore || "0");
    if (salesDeadline > 0n && virtualDaaScore >= salesDeadline && !rescueBuyAvailable) {
      if (rescueBuyCandidate && !rescueBuyQuantityOk) {
        setChainError(t("rescueBuy.oneTicketOnly"));
        return;
      }
      setRoundActionTab("payout");
      setChainFeedbackTarget(settlementFeedbackTarget(covenant));
      setChainError(ticketSalesClosedMessage(covenant));
      return;
    }
    if (!wallet) {
      setChainError("Connect a funded buyer wallet first.");
      return;
    }
    const quantity = Number(ticketQuantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > metadata.maxTickets - covenant.soldTickets) {
      setChainError("Ticket quantity must be a positive whole number within the remaining ticket range.");
      return;
    }
    const payment = BigInt(metadata.ticketPrice || "0") * BigInt(quantity);
    setSigningConfirmation(openSigningConfirmation(buildSigningPreview({
      operation: "buy",
      network: networkLabel(networkId),
      address: wallet.address,
      inputCount: t("signing.input.buy"),
      payment: formatKas(payment),
      fee: t("signing.fee.buy", { fee: formatKas(covenantBuyFeeSompi(round.contractVersion, quantity)) }),
      carrier: `${formatKas(BigInt(covenant.amountSompi))} → ${formatKas(BigInt(covenant.amountSompi) + payment)}`,
      change: wallet.address,
      covenant: covenant.address,
      registry: metadata.registryAddress || registryAddress || t("signing.notApplicable"),
      ticketRange: quantity === 1 ? `#${covenant.soldTickets + 1}` : `#${covenant.soldTickets + 1}-#${covenant.soldTickets + quantity}`,
      snapshot: buySnapshot({ roundId: metadata.roundId, covenantTxId: covenant.txId, soldTickets: covenant.soldTickets, ticketCount: quantity, ticketPriceSompi: metadata.ticketPrice, refundAfterDaaScore: covenant.refundAfterDaaScore })
    })));
  }

  async function executeBuyTicket() {
    setChainFeedbackTarget("buy");
    setChainError("");
    setChainMessage("");

    if (isBuyingRef.current) {
      return;
    }

    isBuyingRef.current = true;
    setIsBuying(true);

    try {
      if (!wallet) {
        throw new Error("Connect a funded buyer wallet first.");
      }

      if (!rpcConnectionRef.current) {
        throw new Error("Connect to a Kaspa wRPC node first.");
      }

      const currentDaaScore = await currentVirtualDaaScore(rpcConnectionRef.current);
      assertToccataActive(networkId, currentDaaScore);

      if (!metadata.roundId || !metadata.covenant) {
        throw new Error("Create or load a raffle round before buying tickets.");
      }

      if (finalized) {
        throw new Error("This round is already finalized.");
      }

      const covenant = metadata.covenant;

      if (!covenant) {
        throw new Error("Create or import a covenant round before buying tickets.");
      }

      if (covenant.status !== "Open") {
        throw new Error("This covenant round is not open for tickets.");
      }

      const refundAfterDaaScore = BigInt(covenant.refundAfterDaaScore || "0");
      if (currentDaaScore >= refundAfterDaaScore && !rescueBuyAvailable) {
        if (rescueBuyCandidate && !rescueBuyQuantityOk) {
          throw new Error(t("rescueBuy.oneTicketOnly"));
        }
        setRoundActionTab("payout");
        setChainFeedbackTarget(settlementFeedbackTarget(covenant));
        throw new Error(ticketSalesClosedMessage(covenant));
      }

      if (covenant.soldTickets >= metadata.maxTickets) {
        setRoundActionTab("payout");
        setChainFeedbackTarget("draw");
        throw new Error("This round has reached its max ticket count.");
      }

      const quantity = Number(ticketQuantity);

      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new Error("Ticket quantity must be a positive integer.");
      }

      if (quantity > metadata.maxTickets - covenant.soldTickets) {
        throw new Error("Ticket quantity exceeds the remaining tickets.");
      }

      const paidAmount = BigInt(metadata.ticketPrice || "0");
      const purchaseAmount = paidAmount * BigInt(quantity);

      if (paidAmount <= 0n) {
        throw new Error("Ticket price must be greater than zero.");
      }

      const ticketId = covenant.soldTickets + 1;
      const ownerPubkey = pubkeyHexFromAddress(wallet.address);
      const nextTicket: TicketState = {
        appId: "KASPA_RAFFLE_TICKET_V1",
        roundId: metadata.roundId,
        ticketId,
        ticketCount: quantity,
        owner: wallet.address,
        ownerPubkey,
        paidAmount,
        ticketTxId: ""
      };
      const currentChainHash = (await rpcConnectionRef.current.client.getBlockDagInfo()).sink;
      const chainSearchHintHash = currentChainHash;
      const payload = {
        app: "kaspa-raffle-static",
        type: "ticket",
        version: metadata.version,
        roundId: metadata.roundId,
        ticketId,
        buyer: wallet.address,
        buyerPubkey: ownerPubkey,
        ticketCount: quantity,
        paidAmount: purchaseAmount.toString(),
        chainSearchHintHash,
        createdAt: new Date().toISOString()
      };
      const payment = await buyRaffleCovenantTicket({
        connection: rpcConnectionRef.current,
        wallet,
        round: {
          ...round,
          soldTickets: covenant.soldTickets,
          potAmount: BigInt(covenant.potAmount),
          status: "Open",
          ticketRoot: covenant.ticketRoot,
          ticketFrontier: covenant.ticketFrontier,
          refundCursor: covenant.refundCursor ?? 0,
          refundBatchCursor: covenant.refundBatchCursor ?? 0,
          creatorPubkey: covenant.creatorPubkey,
          refundAfterDaaScore: covenant.refundAfterDaaScore,
          soldBatches: covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length,
          ticketBatchEnds: covenant.ticketBatchEnds ?? covenant.ticketOwnerPubkeys.map((_, index) => index + 1),
          ticketOwnerPubkeys: covenant.ticketOwnerPubkeys
        },
        covenant,
        ticket: nextTicket,
        ticketCount: quantity,
        chainSearchHintHash,
        allowDeadlineRescueBuy: rescueBuyAvailable,
        payload: encodePayload(payload)
      });

      if (!payment.covenant) {
        throw new Error("Ticket transaction did not return the next covenant cursor.");
      }

      const txId = payment.txId;
      await new Promise((resolve) => window.setTimeout(resolve, 4_000));
      const balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current, wallet.address);

      setWallet(withWalletBalance(wallet, balanceSompi));
      setMetadata((current) => ({
        ...current,
        covenant: payment.covenant,
        treasuryAddress: payment.covenant?.address ?? current.treasuryAddress
      }));
      setTickets((current) => [...current, { ...nextTicket, ticketTxId: txId }]);
      setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
        ? {
            ...historyRound,
            latestCovenant: payment.covenant,
            soldTickets: payment.covenant!.soldTickets,
            potAmount: BigInt(payment.covenant!.potAmount),
            tickets: [
              ...historyRound.tickets.filter((ticket) => ticket.txId !== txId),
              {
                txId,
                ticketId,
                ticketCount: quantity,
                buyer: wallet.address,
                buyerPubkey: ownerPubkey,
                paidAmount
              }
            ]
          }
        : historyRound));
      setTicketQuantity("1");
      setChainMessage(
        quantity === 1
          ? `Ticket #${ticketId} submitted: ${txId} (single-transaction network fee ${formatKas(payment.feeSompi ?? 0n)}; one wallet approval).`
          : `Tickets #${ticketId}-${ticketId + quantity - 1} submitted: ${txId} (single-transaction network fee ${formatKas(payment.feeSompi ?? 0n)}; one wallet approval).`
      );
    } catch (error) {
      const message = errorMessage(error, "Unable to buy ticket.");
      if (transactionRejectionRequiresStateRefresh(error)) {
        setChainError(`${message} The round list is being refreshed now; inspect and reload the newest covenant before opening another wallet request.`);
        void handleLoadHistory();
      } else {
        setChainError(message);
      }
    } finally {
      isBuyingRef.current = false;
      setIsBuying(false);
    }
  }

  async function handleFinalizeLocal() {
    setChainFeedbackTarget("draw");
    setChainError("");
    setChainMessage("");

    if (isFinalizingRef.current) {
      return;
    }

    isFinalizingRef.current = true;
    setIsFinalizing(true);

    try {
      if (finalized?.payoutTxId) {
        setChainMessage(`Winner #${finalized.winnerTicketId} was paid: ${finalized.payoutTxId}`);
        return;
      }

      assertRaffleCovenantReady();

      const covenant = metadata.covenant;

      if (!covenant) {
        throw new Error("Create or import a covenant round first.");
      }

      if (covenant.status !== "Open") {
        throw new Error("This round is no longer available to finalize.");
      }

      if (!rpcConnectionRef.current) {
        throw new Error("Connect to a Kaspa wRPC node first.");
      }

      const currentDaaScore = await currentVirtualDaaScore(rpcConnectionRef.current);
      assertToccataActive(networkId, currentDaaScore);

      if (covenant.soldTickets < metadata.minTickets) {
        throw new Error("Not enough tickets to finalize this round.");
      }

      if (covenant.soldTickets < metadata.maxTickets) {
        const finalizeAfterDaaScore = BigInt(covenant.refundAfterDaaScore || "0");

        if (currentDaaScore < finalizeAfterDaaScore) {
          const remainingSeconds = (finalizeAfterDaaScore - currentDaaScore + KASPA_DAA_PER_SECOND - 1n) / KASPA_DAA_PER_SECOND;
          throw new Error(
            `Round can finalize when sold out or in about ${formatDurationSeconds(remainingSeconds, language)}.`
          );
        }
      }

      const activeCovenant = covenant;
      const activeRound: RoundState = {
        ...round,
        soldTickets: activeCovenant.soldTickets,
        potAmount: BigInt(activeCovenant.potAmount),
        status: "Open",
        ticketRoot: activeCovenant.ticketRoot,
        ticketFrontier: activeCovenant.ticketFrontier,
        refundCursor: activeCovenant.refundCursor ?? 0,
        refundBatchCursor: activeCovenant.refundBatchCursor ?? 0,
        creatorPubkey: activeCovenant.creatorPubkey,
        refundAfterDaaScore: activeCovenant.refundAfterDaaScore,
        soldBatches: activeCovenant.soldBatches ?? activeCovenant.ticketOwnerPubkeys.length,
        ticketBatchEnds: activeCovenant.ticketBatchEnds ?? activeCovenant.ticketOwnerPubkeys.map((_, index) => index + 1),
        ticketOwnerPubkeys: activeCovenant.ticketOwnerPubkeys
      };

      if (activeRound.potAmount <= 0n) {
        throw new Error("Prize amount must be greater than zero.");
      }

      const hasCompleteLocalHistory = hasCompleteTicketBatchHistory(
        tickets,
        activeCovenant.soldTickets,
        activeCovenant.soldBatches ?? activeCovenant.ticketOwnerPubkeys.length
      );
      const requiresIndexerProof = requiresRaffleIndexerProof(metadata.maxTickets, hasCompleteLocalHistory);
      if (requiresIndexerProof) await requireReadyIndexer();

      const covenantDaaScore = await currentRaffleCovenantDaaScore(rpcConnectionRef.current, activeCovenant);
      const salesDeadlineDaaScore = BigInt(activeCovenant.refundAfterDaaScore || "0");
      const randomnessBaseDaaScore = drawRandomnessBaseDaaScore({
        covenantDaaScore,
        salesDeadlineDaaScore,
        soldTickets: activeCovenant.soldTickets,
        maxTickets: metadata.maxTickets
      });
      // A ticket is necessarily accepted before its draw boundary. Prefer the newest
      // ticket's accepted-chain block over the much older creation anchor, especially
      // when restoring a timed-out round from browser storage.
      const latestTicketTxId = [...tickets]
        .sort((left, right) => right.ticketId - left.ticketId)
        .find((ticket) => /^[0-9a-f]{64}$/i.test(ticket.ticketTxId))?.ticketTxId;
      const randomnessAnchorHash = (
        latestTicketTxId
          ? await loadTransactionChainAnchor(historyApiBase, latestTicketTxId).catch(() => undefined)
          : undefined
      ) ?? activeCovenant.chainSearchHintHash
        ?? metadata.startBlockHash
        ?? (metadata.createTxId
          ? await loadTransactionChainAnchor(historyApiBase, metadata.createTxId).catch(() => undefined)
          : undefined);
      let randomnessCandidateHashes: string[] = [];
      if (randomnessAnchorHash) {
        try {
          const anchorResponse = await rpcConnectionRef.current.client.getBlock({
            hash: randomnessAnchorHash,
            includeTransactions: false
          });
          const anchorHeader = anchorResponse.block.header;
          const targetBoundaryDaa = randomnessBaseDaaScore + CHAIN_RANDOM_DELAY_DAA;
          if (anchorHeader.daaScore <= targetBoundaryDaa) {
            const estimatedBlueScore = anchorHeader.blueScore + targetBoundaryDaa - anchorHeader.daaScore;
            randomnessCandidateHashes = await loadBlockHashesNearDaa(historyApiBase, estimatedBlueScore, targetBoundaryDaa);
          }
        } catch {
          // Candidate hashes are only a lookup optimization; the RPC path remains authoritative.
        }
      }
      const randomnessWitness = await loadChainRandomnessWitness(
        rpcConnectionRef.current,
        randomnessBaseDaaScore,
        activeRound.ticketRoot,
        randomnessAnchorHash,
        randomnessCandidateHashes,
        historyApiBase
      );
      const randomSeed = isVNextRaffleContractVersion(metadata.contractVersion)
        ? bytesToHex(await deriveDrawSeed(
            bytesToHex(await roundIdToBytes32(metadata.roundNonce || metadata.roundId)),
            activeRound.ticketRoot,
            randomnessWitness.target.hash,
            randomnessWitness.target.seqcommit
          ))
        : randomnessWitness.randomSeedHex;
      const winnerIndex = await raffleWinnerIndexFromSeed(randomSeed, activeCovenant.soldTickets);
      const winnerRange = findTicketRange(tickets, winnerIndex + 1);
      let winner = winnerRange;
      let winnerBatchIndex = winnerRange
        ? [...tickets].sort((left, right) => left.ticketId - right.ticketId).findIndex((ticket) => ticket === winnerRange)
        : -1;

      let winnerProofHex: string | undefined;
      if (requiresIndexerProof) {
          const indexedWinner = await loadIndexedTicketProof(indexApiBase, metadata.roundId, winnerIndex + 1).catch((error) => {
            throw new Error(t("indexerRequiredError", { detail: errorMessage(error, "Unable to load the winner proof.") }));
          });
          if (indexedWinner.rootHex !== activeCovenant.ticketRoot) {
            throw new Error("Raffle index is behind the current covenant root.");
          }
          winner = {
            appId: "KASPA_RAFFLE_TICKET_V1",
            roundId: metadata.roundId,
            ticketId: indexedWinner.firstTicketId,
            ticketCount: indexedWinner.ticketCount,
            owner: indexedWinner.owner,
            ownerPubkey: indexedWinner.ownerPubkey,
            paidAmount: BigInt(metadata.ticketPrice),
            ticketTxId: indexedWinner.transactionId || ""
          };
          winnerBatchIndex = indexedWinner.batchIndex;
          winnerProofHex = indexedWinner.proofHex;
      } else {
        const winnerWitness = await buildLocalBatchWitness(winnerIndex + 1);
        winner = winnerWitness.ticket;
        winnerBatchIndex = winnerWitness.batchIndex;
        winnerProofHex = winnerWitness.proofHex;
      }

      if (!winner) {
        throw new Error("Winner ticket details and proof are not available yet.");
      }

      const nextFinalized: FinalizeState = finalized ?? {
        appId: "KASPA_RAFFLE_FINAL_V1",
        roundId: metadata.roundId || "pending-round",
        randomSeed,
        targetBlockHash: randomnessWitness.target.hash,
        targetDaaScore: randomnessWitness.target.daaScore.toString(),
        winnerTicketId: winnerIndex + 1,
        winnerAddress: winner.owner,
        payoutTxId: ""
      };

      if (nextFinalized.payoutTxId) {
        setChainMessage(`Winner #${nextFinalized.winnerTicketId} was paid: ${nextFinalized.payoutTxId}`);
        return;
      }

      const result = await finalizeRaffleCovenantRound({
        connection: rpcConnectionRef.current,
        round: activeRound,
        covenant: activeCovenant,
        randomnessWitness,
        winner,
        winnerTicketId: winnerIndex + 1,
        winnerBatchIndex,
        winnerProofHex,
        payload: encodePayload({
          app: "kaspa-raffle-static",
          type: "round-finalize",
          roundId: metadata.roundId,
          winnerTicketId: winnerIndex + 1,
          winnerAddress: winner.owner,
          amount: activeRound.potAmount.toString()
        })
      });

      setFinalized({
        ...nextFinalized,
        payoutTxId: result.txId
      });
      setRoundActionTab("payout");
      setMetadata((current) => ({
        ...current,
        covenant: current.covenant
          ? {
              ...current.covenant,
              txId: result.txId,
              status: "Finalized"
            }
          : current.covenant
      }));
      setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
        ? {
            ...historyRound,
            latestCovenant: undefined,
            soldTickets: activeCovenant.soldTickets,
            potAmount: activeRound.potAmount,
            payouts: [{
              txId: result.txId,
              winnerTicketId: winnerIndex + 1,
              winnerAddress: winner.owner,
              amount: activeRound.potAmount
            }, ...historyRound.payouts.filter((payout) => payout.txId !== result.txId)]
          }
        : historyRound));
      setChainMessage(`Winner #${winnerIndex + 1} was paid: ${result.txId} (finalize fee ${formatKas(result.feeSompi ?? 0n)}).`);
    } catch (error) {
      const message = errorMessage(error, "Unable to finalize covenant round.");
      if (transactionRejectionRequiresStateRefresh(error)) {
        setChainError(`${message} The round list is being refreshed now; inspect and reload the newest covenant before opening another wallet request.`);
        void handleLoadHistory();
      } else {
        setChainError(message);
      }
    } finally {
      isFinalizingRef.current = false;
      setIsFinalizing(false);
    }
  }

  function requestCarrierTopUpSigningConfirmation() {
    setChainFeedbackTarget("carrier");
    setChainError("");
    setChainMessage("");
    const covenant = metadata.covenant;
    const amountSompi = BigInt(kasInputToSompi(topUpCarrierKas));
    if (!wallet) {
      setChainError("Connect a funded wallet before adding carrier.");
      return;
    }
    if (!covenant || !metadata.roundId) {
      setChainError("Create or load an active raffle round before adding carrier.");
      return;
    }
    if (metadata.contractVersion !== RAFFLE_CONTRACT_VERSION) {
      setChainError("This already-deployed covenant version does not support carrier top-ups.");
      return;
    }
    if (amountSompi < MIN_COVENANT_TOP_UP_SOMPI) {
      setChainError(`Carrier top-up amount must be at least ${formatKas(MIN_COVENANT_TOP_UP_SOMPI)}.`);
      return;
    }
    const before = BigInt(covenant.amountSompi);
    setSigningConfirmation(openSigningConfirmation(buildSigningPreview({
      operation: "top-up-carrier",
      network: networkLabel(networkId),
      address: wallet.address,
      inputCount: t("signing.input.topUpCarrier"),
      payment: formatKas(amountSompi),
      fee: t("signing.fee.topUpCarrier", { fee: formatKas(COVENANT_TOP_UP_FEE_SOMPI) }),
      carrier: t("signing.carrier.transition", { before: formatKas(before), after: formatKas(before + amountSompi) }),
      change: wallet.address,
      covenant: covenant.address,
      registry: metadata.registryAddress || registryAddress || t("signing.notApplicable"),
      ticketRange: t("signing.notApplicable"),
      snapshot: carrierTopUpSnapshot({ roundId: metadata.roundId, covenantTxId: covenant.txId, amountSompi: amountSompi.toString() })
    })));
  }

  async function executeCarrierTopUp() {
    setChainFeedbackTarget("carrier");
    setChainError("");
    setChainMessage("");
    if (isToppingUpCarrierRef.current) return;
    isToppingUpCarrierRef.current = true;
    setIsToppingUpCarrier(true);

    try {
      if (!wallet) throw new Error("Connect a funded wallet before adding carrier.");
      if (!rpcConnectionRef.current) throw new Error("Connect to a Kaspa wRPC node first.");
      const covenant = metadata.covenant;
      if (!covenant || !metadata.roundId) throw new Error("Create or load an active raffle round before adding carrier.");
      const amountSompi = BigInt(kasInputToSompi(topUpCarrierKas));
      if (amountSompi < MIN_COVENANT_TOP_UP_SOMPI) throw new Error(`Carrier top-up amount must be at least ${formatKas(MIN_COVENANT_TOP_UP_SOMPI)}.`);

      const result = await topUpRaffleCovenantCarrier({
        connection: rpcConnectionRef.current,
        wallet,
        round: {
          ...round,
          soldTickets: covenant.soldTickets,
          potAmount: BigInt(covenant.potAmount),
          status: covenant.status,
          ticketRoot: covenant.ticketRoot,
          ticketFrontier: covenant.ticketFrontier,
          refundCursor: covenant.refundCursor ?? 0,
          refundBatchCursor: covenant.refundBatchCursor ?? 0,
          refundFeeDebtSompi: covenant.refundFeeDebtSompi ?? "0",
          creatorPubkey: covenant.creatorPubkey,
          refundAfterDaaScore: covenant.refundAfterDaaScore,
          soldBatches: covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length,
          ticketBatchEnds: covenant.ticketBatchEnds ?? covenant.ticketOwnerPubkeys.map((_, index) => index + 1),
          ticketOwnerPubkeys: covenant.ticketOwnerPubkeys
        },
        covenant,
        amountSompi,
        payload: encodePayload({
          app: "kaspa-raffle-static",
          type: "round-carrier-topup",
          version: metadata.version,
          contractVersion: metadata.contractVersion,
          roundId: metadata.roundId,
          covenantId: covenant.covenantId,
          previousCovenantTxId: covenant.txId,
          amountSompi: amountSompi.toString(),
          topUpBy: wallet.address,
          createdAt: new Date().toISOString()
        })
      });
      if (!result.covenant) throw new Error("Carrier top-up did not return the next covenant cursor.");

      setMetadata((current) => ({
        ...current,
        covenant: result.covenant,
        treasuryAddress: result.covenant?.address ?? current.treasuryAddress
      }));
      setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
        ? { ...historyRound, latestCovenant: result.covenant }
        : historyRound));
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      const balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current, wallet.address);
      setWallet(withWalletBalance(wallet, balanceSompi));
      setChainMessage(`Added ${formatKas(amountSompi)} of carrier: ${result.txId} (covenant fee ${formatKas(result.feeSompi ?? 0n)}; wallet funding fee ${formatKas(result.fundingFeeSompi ?? 0n)}).`);
    } catch (error) {
      setChainError(errorMessage(error, "Unable to add covenant carrier."));
    } finally {
      isToppingUpCarrierRef.current = false;
      setIsToppingUpCarrier(false);
    }
  }

  function requestRefundSigningConfirmation() {
    setChainFeedbackTarget("refund");
    setChainError("");
    setChainMessage("");
    const covenant = metadata.covenant;
    if (!covenant) {
      setChainError("Create or import a covenant round first.");
      return;
    }
    const firstTicket = (covenant.refundCursor ?? 0) + 1;
    const finalTicket = covenant.soldTickets;
    const sponsor = wallet?.address ?? t("signing.sponsor.none");
    setSigningConfirmation(openSigningConfirmation(buildSigningPreview({
      operation: "sponsor-refund",
      network: networkLabel(networkId),
      address: sponsor,
      inputCount: wallet ? t("signing.input.refund.wallet") : t("signing.input.refund.none"),
      payment: t("signing.payment.refund", { range: firstTicket <= finalTicket ? `#${firstTicket}-#${finalTicket}` : t("signing.ticketRange.none") }),
      fee: t("signing.fee.refund", { fee: formatKas(covenantRefundMaxFeeSompi(round.contractVersion)) }),
      carrier: formatKas(BigInt(covenant.amountSompi)),
      change: wallet?.address ?? t("signing.change.refund"),
      covenant: covenant.address,
      registry: metadata.registryAddress || registryAddress || t("signing.notApplicable"),
      ticketRange: firstTicket <= finalTicket ? `#${firstTicket}-#${finalTicket}` : t("signing.ticketRange.none")
    })));
  }

  async function executeRefundTimedOutRound() {
    setChainFeedbackTarget("refund");
    setChainError("");
    setChainMessage("");
    if (isRefundingRoundRef.current) return;

    isRefundingRoundRef.current = true;
    setIsRefundingRound(true);
    setRefundProgress({ cursor: metadata.covenant?.refundCursor ?? 0, total: metadata.covenant?.soldTickets ?? 0 });

    try {
      assertRaffleCovenantReady();
      if (!rpcConnectionRef.current) throw new Error("Connect to a Kaspa wRPC node first.");
      if (finalized?.payoutTxId || metadata.covenant?.status === "Finalized") throw new Error("This round is already finalized.");

      const covenant = metadata.covenant;
      if (!covenant) throw new Error("Create or import a covenant round first.");
      if (covenant.soldTickets <= 0) throw new Error("There are no tickets to refund.");

      const currentDaaScore = await currentVirtualDaaScore(rpcConnectionRef.current);
      assertToccataActive(networkId, currentDaaScore);
      const refundAfterDaaScore = BigInt(covenant.refundAfterDaaScore || "0");
      if (currentDaaScore < refundAfterDaaScore) {
        const remainingDaa = refundAfterDaaScore - currentDaaScore;
        const remainingSeconds = (remainingDaa + KASPA_DAA_PER_SECOND - 1n) / KASPA_DAA_PER_SECOND;
        throw new Error(
          `Refund opens in about ${formatDurationSeconds(remainingSeconds, language)} at DAA ${refundAfterDaaScore}. Current DAA is ${currentDaaScore}.`
        );
      }
      if (covenant.soldTickets >= metadata.minTickets) {
        throw new Error("This round met its minimum ticket requirement and must be finalized instead of refunded.");
      }

      const hasCompleteLocalHistory = hasCompleteTicketBatchHistory(
        tickets,
        covenant.soldTickets,
        covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length
      );
      const requiresIndexerProof = requiresRaffleIndexerProof(metadata.maxTickets, hasCompleteLocalHistory);
      if (requiresIndexerProof) await requireReadyIndexer();

      const roundFromCovenant = (active: NonNullable<RaffleMetadata["covenant"]>): RoundState => ({
        ...round,
        soldTickets: active.soldTickets,
        potAmount: BigInt(active.potAmount),
        status: active.status,
        ticketRoot: active.ticketRoot,
        ticketFrontier: active.ticketFrontier,
        refundCursor: active.refundCursor ?? 0,
        refundBatchCursor: active.refundBatchCursor ?? 0,
        creatorPubkey: active.creatorPubkey,
        refundAfterDaaScore: active.refundAfterDaaScore,
        soldBatches: active.soldBatches ?? active.ticketOwnerPubkeys.length,
        ticketBatchEnds: active.ticketBatchEnds ?? tickets.map(ticketRangeEnd),
        ticketOwnerPubkeys: active.ticketOwnerPubkeys
      });

      let activeCovenant = covenant;
      let lastTxId = "";
      let broadcastFeeSompi = 0n;
      if (activeCovenant.status !== "Refunding") {
        const transition = await refundRaffleCovenantRound({
          connection: rpcConnectionRef.current,
          sponsorWallet: wallet ?? undefined,
          round: roundFromCovenant(activeCovenant),
          covenant: activeCovenant,
          tickets,
          payload: encodePayload({
            app: "kaspa-raffle-static",
            type: "round-refund-start",
            roundId: metadata.roundId,
            refundCursor: 0,
            refundBatchCursor: 0
          }),
          refundStartPayload: (refundFeeDebtSompi) => encodePayload({
            app: "kaspa-raffle-static",
            type: "round-refund-start",
            roundId: metadata.roundId,
            refundCursor: 0,
            refundBatchCursor: 0,
            refundFeeDebtSompi: refundFeeDebtSompi.toString()
          })
        });
        lastTxId = transition.txId;
        broadcastFeeSompi += transition.feeSompi ?? 0n;
        if (!transition.covenant) throw new Error("Refund transition did not create its successor covenant.");
        activeCovenant = transition.covenant;
        setMetadata((current) => ({ ...current, covenant: activeCovenant }));
        setChainMessage(`Batch refund contract started: ${transition.txId}`);
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }

      while (activeCovenant) {
        const firstBatchIndex = activeCovenant.refundBatchCursor ?? 0;
        let nextTicketId = (activeCovenant.refundCursor ?? 0) + 1;
        const remainingPurchaseBatches = (activeCovenant.soldBatches ?? activeCovenant.ticketOwnerPubkeys.length) - firstBatchIndex;
        const contractBatchLimit = supportsGroupedRefunds(metadata.contractVersion)
          ? MAX_REFUND_PURCHASE_BATCHES_PER_TX
          : 1;
        const targetBatchCount = Math.min(contractBatchLimit, remainingPurchaseBatches);
        const refundBatches: Array<{ ticket: TicketState; batchIndex: number; ownerProofHex: string }> = [];

        for (let offset = 0; offset < targetBatchCount; offset += 1) {
          const batchIndex = firstBatchIndex + offset;
          let ticket: TicketState;
          let proofHex: string;
          if (requiresIndexerProof) {
            const indexed = await loadIndexedBatchProof(indexApiBase, metadata.roundId, batchIndex).catch((error) => {
              throw new Error(t("indexerRequiredError", { detail: errorMessage(error, "Unable to load the refund proof.") }));
            });
            if (indexed.rootHex !== activeCovenant.ticketRoot) throw new Error("Raffle index is behind the current covenant root.");
            if (indexed.firstTicketId !== nextTicketId) throw new Error("Raffle index refund batch is not the next on-chain batch.");
            ticket = {
              appId: "KASPA_RAFFLE_TICKET_V1",
              roundId: metadata.roundId,
              ticketId: indexed.firstTicketId,
              ticketCount: indexed.ticketCount,
              owner: indexed.owner,
              ownerPubkey: indexed.ownerPubkey,
              paidAmount: BigInt(metadata.ticketPrice),
              ticketTxId: indexed.transactionId || ""
            };
            proofHex = indexed.proofHex;
          } else {
            const local = await buildLocalBatchWitness(nextTicketId);
            if (local.batchIndex !== batchIndex) throw new Error("Local refund batch cursor does not match the covenant.");
            ticket = local.ticket;
            proofHex = local.proofHex;
          }
          refundBatches.push({ ticket, batchIndex, ownerProofHex: proofHex });
          nextTicketId += ticketRangeCount(ticket);
        }

        let candidateBatches = refundBatches;
        let ticketCount = 0;
        let step: Awaited<ReturnType<typeof refundRaffleCovenantRound>>;
        while (true) {
          ticketCount = candidateBatches.reduce((total, batch) => total + ticketRangeCount(batch.ticket), 0);
          try {
            step = await refundRaffleCovenantRound({
              connection: rpcConnectionRef.current,
              round: roundFromCovenant(activeCovenant),
              covenant: activeCovenant,
              tickets,
              refundBatches: candidateBatches,
              payload: encodePayload({
                app: "kaspa-raffle-static",
                type: "round-refund-batch",
                roundId: metadata.roundId,
                refundCursor: activeCovenant.refundCursor ?? 0,
                refundBatchCursor: firstBatchIndex,
                ticketCount,
                batchCount: candidateBatches.length
              })
            });
            break;
          } catch (error) {
            if (candidateBatches.length <= 1 || !shouldShrinkRefundBatch(error)) throw error;
            candidateBatches = candidateBatches.slice(0, -1);
          }
        }
        lastTxId = step.txId;
        broadcastFeeSompi += step.feeSompi ?? 0n;
        activeCovenant = step.covenant!;
        const cursor = activeCovenant?.refundCursor ?? covenant.soldTickets;
        setRefundProgress({ cursor, total: covenant.soldTickets });
        setMetadata((current) => ({
          ...current,
          covenant: activeCovenant ?? (current.covenant
            ? { ...current.covenant, txId: step.txId, status: "Refunded", refundCursor: covenant.soldTickets, refundBatchCursor: covenant.soldBatches, potAmount: "0" }
            : current.covenant)
        }));
        setChainMessage(activeCovenant
          ? `Refunded ${(step.refundedTicketCount ?? ticketCount).toLocaleString()} tickets from ${step.refundedBatchCount ?? candidateBatches.length} purchase batches; cursor ${cursor}/${covenant.soldTickets}: ${step.txId}`
          : `Timed-out round refunded: ${step.txId}`);
        if (activeCovenant) await new Promise((resolve) => window.setTimeout(resolve, 750));
      }

      setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
        ? { ...historyRound, latestCovenant: undefined, refundTxId: lastTxId }
        : historyRound));
      setChainMessage(`Timed-out round refunded: ${lastTxId} (exact network fees broadcast in this run ${formatKas(broadcastFeeSompi)}, deducted from refunded purchase payments; caller wallet 0 KAS).`);
    } catch (error) {
      setChainError(errorMessage(error, "Unable to refund timed-out round."));
    } finally {
      isRefundingRoundRef.current = false;
      setIsRefundingRound(false);
    }
  }

  async function confirmSigningPreview() {
    const preview = signingConfirmation.preview;
    if (!preview || isConfirmingSigning) return;

    // A Buy confirmation is bound to the exact covenant cursor and quantity the
    // user reviewed. Never open a replacement wallet request after a stale
    // cursor; the user must inspect a newly generated preview instead.
    const covenant = metadata.covenant;
    const quantity = Number(ticketQuantity);
    const currentSnapshot = covenant && metadata.roundId
      ? preview.operation === "top-up-carrier"
        ? carrierTopUpSnapshot({ roundId: metadata.roundId, covenantTxId: covenant.txId, amountSompi: kasInputToSompi(topUpCarrierKas) })
        : preview.operation === "publish-registry"
          ? registrySnapshot({ roundId: metadata.roundId, createTxId: metadata.createTxId, registryAddress: metadata.registryAddress ?? "" })
        : buySnapshot({ roundId: metadata.roundId, covenantTxId: covenant.txId, soldTickets: covenant.soldTickets, ticketCount: quantity, ticketPriceSompi: metadata.ticketPrice, refundAfterDaaScore: covenant.refundAfterDaaScore })
      : undefined;
    const decision = decideSigningConfirmation(signingConfirmation, currentSnapshot);
    if (decision.kind === "stale") {
      setSigningConfirmation(decision.state);
      setChainError("The covenant state or amount changed after this preview. No wallet request was made; review the updated action before signing.");
      return;
    }
    if (decision.kind !== "execute") return;

    setIsConfirmingSigning(true);
    try {
      if (decision.operation === "create") await executeCreateCovenantRound();
      if (decision.operation === "publish-registry") await executeRegistryPublication();
      if (decision.operation === "buy") await executeBuyTicket();
      if (decision.operation === "top-up-carrier") await executeCarrierTopUp();
      if (decision.operation === "sponsor-refund") await executeRefundTimedOutRound();
    } finally {
      setIsConfirmingSigning(false);
      setSigningConfirmation(cancelSigningConfirmation());
    }
  }

  async function handleCloseEmptyRound() {
    setChainFeedbackTarget("close");
    setChainError("");
    setChainMessage("");
    if (isClosingEmptyRoundRef.current) return;
    isClosingEmptyRoundRef.current = true;
    setIsClosingEmptyRound(true);

    try {
      assertRaffleCovenantReady();
      if (!rpcConnectionRef.current) throw new Error("Connect to a Kaspa wRPC node first.");
      const covenant = metadata.covenant;
      if (!covenant) throw new Error("Create or import a covenant round first.");
      if (covenant.soldTickets !== 0 || (covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length) !== 0) {
        throw new Error("Only an empty round can use the close action.");
      }
      const currentDaaScore = await currentVirtualDaaScore(rpcConnectionRef.current);
      const closeAfterDaa = BigInt(covenant.refundAfterDaaScore || "0");
      if (currentDaaScore < closeAfterDaa) {
        throw new Error(`Empty-round close opens at DAA ${closeAfterDaa}; current DAA is ${currentDaaScore}.`);
      }
      const result = await closeEmptyRaffleCovenantRound({
        connection: rpcConnectionRef.current,
        round: {
          ...round,
          soldTickets: 0,
          soldBatches: 0,
          potAmount: 0n,
          status: "Open",
          ticketRoot: covenant.ticketRoot,
          ticketFrontier: covenant.ticketFrontier,
          refundCursor: covenant.refundCursor ?? 0,
          refundBatchCursor: covenant.refundBatchCursor ?? 0,
          creatorPubkey: covenant.creatorPubkey,
          refundAfterDaaScore: covenant.refundAfterDaaScore,
          ticketBatchEnds: [],
          ticketOwnerPubkeys: []
        },
        covenant,
        payload: encodePayload({ app: "kaspa-raffle-static", type: "round-close-empty", roundId: metadata.roundId })
      });
      setMetadata((current) => ({ ...current, covenant: undefined }));
      setTerminalRoundStatus("Closed");
      setHistoryRounds((current) => current.map((historyRound) => historyRound.roundId === metadata.roundId
        ? { ...historyRound, latestCovenant: undefined }
        : historyRound));
      setChainMessage(`Empty round closed and carrier returned to the creator: ${result.txId} (fee ${formatKas(result.feeSompi ?? 0n)}).`);
    } catch (error) {
      setChainError(errorMessage(error, "Unable to close the empty covenant round."));
    } finally {
      isClosingEmptyRoundRef.current = false;
      setIsClosingEmptyRound(false);
    }
  }

  async function handleLoadHistory() {
    setHistoryError("");
    setHistoryMessage("");
    setIsLoadingHistory(true);

    try {
      const targetAddress = (
        historyAddress || registryAddress || metadata.registryAddress || metadata.treasuryAddress || ""
      ).trim();
      const byRoundId = new Map<string, RaffleHistoryRound>();
      const cachedRounds = loadCachedRaffleHistory(networkId);
      for (const cachedRound of cachedRounds) {
        byRoundId.set(cachedRound.roundId, cachedRound);
      }
      const registryAddresses = new Set<string>();
      if (targetAddress) registryAddresses.add(targetAddress);
      for (const cachedRound of cachedRounds) {
        if (cachedRound.registryAddress) registryAddresses.add(cachedRound.registryAddress);
      }
      if (!registryAddresses.size && !byRoundId.size) {
        throw new Error("Set a registry address to load history.");
      }

      const restResults = await Promise.allSettled(
        [...registryAddresses].map((address) => loadRaffleHistory(historyApiBase, address))
      );
      for (const restResult of restResults) {
        if (restResult.status !== "fulfilled") continue;

        for (const historyRound of restResult.value) {
          const cachedRound = byRoundId.get(historyRound.roundId);
          const incomingHasFinalState = Boolean(historyRound.refundTxId || historyRound.payouts.length);
          const cachedHasFinalState = Boolean(cachedRound?.refundTxId || cachedRound?.payouts.length);
          const mergedTickets = cachedRound
            ? preferMoreCompleteRaffleHistoryTickets(cachedRound.tickets, historyRound.tickets)
            : historyRound.tickets;
          const mergedCovenant = incomingHasFinalState || cachedHasFinalState
            ? undefined
            : preferAdvancedRaffleCovenant(cachedRound?.latestCovenant, historyRound.latestCovenant);
          const mergedSoldTickets = Math.max(
            cachedRound?.soldTickets ?? totalTicketCount(cachedRound?.tickets ?? []),
            historyRound.soldTickets ?? totalTicketCount(historyRound.tickets),
            totalTicketCount(mergedTickets),
            mergedCovenant?.soldTickets ?? 0
          );
          byRoundId.set(historyRound.roundId, cachedRound ? {
            ...cachedRound,
            ...historyRound,
            latestCovenant: mergedCovenant,
            tickets: mergedTickets,
            payouts: historyRound.payouts.length ? historyRound.payouts : cachedRound.payouts,
            soldTickets: mergedSoldTickets,
            refundCursor: Math.max(cachedRound.refundCursor ?? 0, historyRound.refundCursor ?? 0),
            refundBatchCursor: Math.max(cachedRound.refundBatchCursor ?? 0, historyRound.refundBatchCursor ?? 0),
            potAmount: incomingHasFinalState
              ? historyRound.potAmount
              : mergedCovenant
                ? BigInt(mergedCovenant.potAmount)
                : cachedRound.potAmount,
            chainSearchHintHash: historyRound.chainSearchHintHash ?? cachedRound.chainSearchHintHash
          } : historyRound);
        }
      }
      const roundsNeedingIndexer = [...byRoundId.values()].filter(historyRoundNeedsIndexer);
      const needsIndexer = roundsNeedingIndexer.length > 0;
      const indexResult = needsIndexer
        ? await Promise.allSettled([loadIndexedRaffleHistory(indexApiBase)]).then(([result]) => result)
        : undefined;
      if (indexResult?.status === "fulfilled") {
        for (const indexedRound of indexResult.value) {
          const restRound = byRoundId.get(indexedRound.roundId);
          const incomingHasFinalState = Boolean(indexedRound.refundTxId || indexedRound.payouts.length);
          const cachedHasFinalState = Boolean(restRound?.refundTxId || restRound?.payouts.length);
          const mergedTickets = restRound
            ? preferMoreCompleteRaffleHistoryTickets(restRound.tickets, indexedRound.tickets)
            : indexedRound.tickets;
          const mergedCovenant = incomingHasFinalState || cachedHasFinalState
            ? undefined
            : preferAdvancedRaffleCovenant(restRound?.latestCovenant, indexedRound.latestCovenant);
          byRoundId.set(indexedRound.roundId, restRound ? {
            ...restRound,
            ...indexedRound,
            registryTxId: restRound.registryTxId,
            registryRefundTxId: restRound.registryRefundTxId,
            latestCovenant: mergedCovenant,
            tickets: mergedTickets,
            payouts: indexedRound.payouts.length ? indexedRound.payouts : restRound.payouts,
            soldTickets: Math.max(
              restRound.soldTickets ?? totalTicketCount(restRound.tickets),
              indexedRound.soldTickets ?? totalTicketCount(indexedRound.tickets),
              totalTicketCount(mergedTickets),
              mergedCovenant?.soldTickets ?? 0
            ),
            refundCursor: Math.max(restRound.refundCursor ?? 0, indexedRound.refundCursor ?? 0),
            refundBatchCursor: Math.max(restRound.refundBatchCursor ?? 0, indexedRound.refundBatchCursor ?? 0),
            potAmount: incomingHasFinalState
              ? indexedRound.potAmount
              : mergedCovenant
                ? BigInt(mergedCovenant.potAmount)
                : restRound.potAmount
          } : indexedRound);
        }
      }
      const firstRestFailure = restResults.find((result) => result.status === "rejected");
      if (!byRoundId.size && firstRestFailure?.status === "rejected") throw firstRestFailure.reason;
      let unindexedLargeRounds = 0;
      if (needsIndexer && indexResult?.status === "rejected") {
        unindexedLargeRounds = roundsNeedingIndexer.length;
      }
      const rounds = [...byRoundId.values()].sort((left, right) => {
        const leftDaa = BigInt(left.createdAtDaaScore || "0");
        const rightDaa = BigInt(right.createdAtDaaScore || "0");
        return leftDaa === rightDaa ? 0 : leftDaa > rightDaa ? -1 : 1;
      });

      for (const historyRound of rounds) {
        if (historyRound.localCachedAt) {
          updateCachedParticipatedRoundFromHistory(networkId, historyRound);
        }
      }

      if (targetAddress) setHistoryAddress(targetAddress);
      setHistoryRounds(rounds);
      setSelectedHistoryRoundId((current) => current && rounds.some((historyRound) => historyRound.roundId === current)
        ? current
        : rounds.find(historyRoundIsPlayable)?.roundId ?? rounds[0]?.roundId ?? "");
      setHistoryMessage(
        `Loaded ${rounds.length} raffle round${rounds.length === 1 ? "" : "s"}. ` +
        (!registryAddresses.size
          ? "These participated rounds came from browser storage."
          : indexResult?.status === "fulfilled"
          ? "Large-round proofs came from the configured index."
          : unindexedLargeRounds
            ? `Showing ${unindexedLargeRounds} large round${unindexedLargeRounds === 1 ? "" : "s"} from the registry without index proofs.`
            : "No raffle index was needed.")
      );
    } catch (error) {
      setHistoryError(errorMessage(error, "Unable to load raffle history."));
    } finally {
      setIsLoadingHistory(false);
    }
  }

  function historyRoundStatus(historyRound: RaffleHistoryRound) {
    return historyRound.refundTxId
      ? "Refunded"
      : historyRound.payouts[0]
        ? "Paid"
        : historyRound.latestCovenant?.status === "Refunding"
          ? "Refunding"
          : historyRound.latestCovenant?.status === "Refunded"
            ? "Refunded"
            : historyRound.latestCovenant?.status === "Finalized"
              ? "Paid"
              : historyRound.latestCovenant?.status === "Closed" || (
                (historyRound.maxTickets ?? 0) > 0 && (historyRound.soldTickets ?? 0) >= (historyRound.maxTickets ?? 0)
              )
                ? "Closed"
              : "Open";
  }

  function historyRoundIsPlayable(historyRound: RaffleHistoryRound) {
    const covenant = historyRound.latestCovenant;
    if (!covenant || covenant.status !== "Open") return false;
    if (archivedReleaseForRaffleContractVersion(historyRound.contractVersion ?? "") || isQuarantinedRaffleContractVersion(historyRound.contractVersion ?? "")) return false;
    const soldTickets = historyRound.soldTickets ?? covenant.soldTickets;
    if ((historyRound.maxTickets ?? 0) <= soldTickets) return false;
    const deadline = BigInt(covenant.refundAfterDaaScore || historyRound.refundAfterDaaScore || "0");
    return deadline > 0n && (virtualDaaScore <= 0n || virtualDaaScore < deadline);
  }

  function networkFromKaspaAddress(address: string) {
    return networkFromAddress(address) ?? networkId;
  }

  function refundTimeoutSecondsFromHistoryRound(historyRound: RaffleHistoryRound, network: SupportedNetworkId): bigint {
    if (historyRound.refundTimeoutSeconds && /^\d+$/.test(historyRound.refundTimeoutSeconds)) {
      return BigInt(historyRound.refundTimeoutSeconds);
    }

    if (historyRound.refundTimeoutDaa && /^\d+$/.test(historyRound.refundTimeoutDaa)) {
      return BigInt(historyRound.refundTimeoutDaa) / KASPA_DAA_PER_SECOND;
    }

    return defaultRefundTimeoutSeconds(network);
  }

  async function handleJoinSelectedHistoryRound() {
    setHistoryError("");
    setHistoryMessage("");
    setChainError("");
    setChainMessage("");
    setRegistryRecoveryError("");
    setRegistryRecoveryMessage("");

    if (!selectedHistoryRound) {
      setHistoryError("Select a round first.");
      return;
    }

    const archivedRelease = archivedReleaseForRaffleContractVersion(selectedHistoryRound.contractVersion ?? "");
    if (!isSupportedRaffleContractVersion(selectedHistoryRound.contractVersion ?? "")) {
      setHistoryError(isQuarantinedRaffleContractVersion(selectedHistoryRound.contractVersion ?? "")
        ? t("quarantinedRound", { version: selectedHistoryRound.contractVersion || t("unknown") })
        : t("legacyRoundRequiresRelease", {
            version: selectedHistoryRound.contractVersion || t("unknown"),
            release: archivedRelease ?? "an archived Kaswin release"
          }));
      return;
    }

    const cachedRound = loadCachedRound(networkId, selectedHistoryRound.roundId);
    if (cachedRound) {
      const loadedProfile = requireNetworkProfile(normalizeNetworkId(cachedRound.metadata.network));
      const loadedNetwork = loadedProfile.id;
      const selectedPayout = selectedHistoryRound.payouts[0];
      const selectedRefunded = Boolean(
        selectedHistoryRound.refundTxId || selectedHistoryRound.latestCovenant?.status === "Refunded"
      );
      const selectedFinalized = Boolean(selectedPayout || selectedHistoryRound.latestCovenant?.status === "Finalized");
      const observedCovenant = selectedHistoryRound.latestCovenant ?? cachedRound.metadata.covenant;
      const restoredCovenant = selectedRefunded && observedCovenant
        ? {
            ...observedCovenant,
            txId: selectedHistoryRound.refundTxId ?? observedCovenant.txId,
            amountSompi: "0",
            potAmount: "0",
            status: "Refunded" as const,
            refundCursor: selectedHistoryRound.soldTickets ?? observedCovenant.soldTickets,
            refundBatchCursor: observedCovenant.soldBatches ?? observedCovenant.ticketOwnerPubkeys.length,
            refundFeeDebtSompi: "0"
          }
        : selectedFinalized
          ? undefined
          : observedCovenant;
      const restoredFinalized = selectedPayout
        ? cachedRound.finalized ?? {
            appId: "KASPA_RAFFLE_FINAL_V1" as const,
            roundId: selectedHistoryRound.roundId,
            randomSeed: "history-result",
            targetBlockHash: "",
            targetDaaScore: "0",
            winnerTicketId: selectedPayout.winnerTicketId,
            winnerAddress: selectedPayout.winnerAddress,
            payoutTxId: selectedPayout.txId
          }
        : selectedFinalized
          ? cachedRound.finalized
          : undefined;
      const selectedHistoryTickets = selectedHistoryRound.tickets.map((ticket) => ({
        appId: "KASPA_RAFFLE_TICKET_V1" as const,
        roundId: selectedHistoryRound.roundId,
        ticketId: ticket.ticketId,
        ticketCount: ticket.ticketCount,
        owner: ticket.buyer,
        ownerPubkey: ticket.buyerPubkey,
        paidAmount: ticket.paidAmount,
        ticketTxId: ticket.txId
      }));
      const restoredTickets = selectedHistoryTickets.length
        ? selectedHistoryTickets
        : cachedRound.tickets.length
          ? cachedRound.tickets
        : recoverTicketStatesFromCovenantBatches({
            roundId: selectedHistoryRound.roundId,
            ticketPrice: BigInt(cachedRound.metadata.ticketPrice || selectedHistoryRound.ticketPrice || 0),
            covenant: restoredCovenant,
            network: loadedNetwork
          });
      const restoredMetadata = {
        ...cachedRound.metadata,
        covenant: restoredCovenant,
        treasuryAddress: restoredCovenant?.address ?? cachedRound.metadata.treasuryAddress,
        registryAddress: selectedHistoryRound.registryAddress ?? cachedRound.metadata.registryAddress,
        registryTxId: selectedHistoryRound.registryTxId ?? cachedRound.metadata.registryTxId,
        registryRefundTxId: selectedHistoryRound.registryRefundTxId ?? cachedRound.metadata.registryRefundTxId
      };

      setNetworkId(loadedNetwork);
      setRpcUrl(networkEndpoints[loadedNetwork].url);
      setHistoryApiBase(loadedProfile.historyApiBase);
      setIndexApiBase(indexEndpoints[loadedNetwork]);
      setCreateRegistryAddress(restoredMetadata.registryAddress ?? "");
      setHistoryAddress(restoredMetadata.registryAddress ?? "");
      setRefundTimeoutParts(refundTimeoutPartsFromSeconds(refundTimeoutSecondsFromMetadata(restoredMetadata)));
      setMetadata(restoredMetadata);
      setTickets(restoredTickets);
      setFinalized(restoredFinalized);
      setTerminalRoundStatus(selectedRefunded ? "Refunded" : selectedFinalized ? "Finalized" : undefined);
      setRoundActionTab(restoredCovenant?.status === "Open" ? "buy" : "payout");
      setIsRoundSourceOpen(false);
      setMetadataMessage("Round restored from browser storage.");
      setHistoryMessage(`Restored ${selectedHistoryRound.roundId} from this browser.`);
      return;
    }

    const covenant = selectedHistoryRound.latestCovenant;

    if (!covenant || (covenant.status !== "Open" && covenant.status !== "Closed" && covenant.status !== "Refunding")) {
      setHistoryError("Selected round has no active covenant to load.");
      return;
    }

    if (
      selectedHistoryRound.ticketPrice === undefined ||
      selectedHistoryRound.maxTickets === undefined ||
      selectedHistoryRound.minTickets === undefined ||
      !selectedHistoryRound.contractVersion
    ) {
      setHistoryError("Selected round is missing metadata needed to join.");
      return;
    }

    const loadedNetwork = networkFromKaspaAddress(covenant.address);
    const loadedProfile = requireNetworkProfile(loadedNetwork);
    if (!isSupportedRaffleContractVersion(selectedHistoryRound.contractVersion)) {
      setHistoryError("Selected round uses a contract that is not supported on this network.");
      return;
    }
    const loadedCarrierSompi = BigInt(covenant.amountSompi) -
      selectedHistoryRound.ticketPrice * BigInt(covenant.soldTickets);
    const loadedCarrierWarning = loadedCarrierSompi < MIN_COVENANT_CARRIER_SOMPI;
    const loadedRefundTimeoutSeconds = refundTimeoutSecondsFromHistoryRound(selectedHistoryRound, loadedNetwork);
    const loadedRegistryAddress = selectedHistoryRound.registryAddress ?? (historyAddress || registryAddress);
    const startBlockHash = selectedHistoryRound.createTxId
      ? await loadTransactionChainAnchor(loadedProfile.historyApiBase, selectedHistoryRound.createTxId).catch(() => undefined)
      : undefined;
    const loadedTickets = selectedHistoryRound.tickets.length
        ? selectedHistoryRound.tickets.map((ticket) => ({
            appId: "KASPA_RAFFLE_TICKET_V1" as const,
            roundId: selectedHistoryRound.roundId,
            ticketId: ticket.ticketId,
            ticketCount: ticket.ticketCount,
            owner: ticket.buyer,
            ownerPubkey: ticket.buyerPubkey,
            paidAmount: ticket.paidAmount,
            ticketTxId: ticket.txId
          }))
        : recoverTicketStatesFromCovenantBatches({
            roundId: selectedHistoryRound.roundId,
            ticketPrice: selectedHistoryRound.ticketPrice,
            covenant,
            network: loadedNetwork
          });

    setNetworkId(loadedNetwork);
    setRpcUrl(networkEndpoints[loadedNetwork].url);
    setHistoryApiBase(loadedProfile.historyApiBase);
    setIndexApiBase(indexEndpoints[loadedNetwork]);
    setCreateRegistryAddress(loadedRegistryAddress);
    setRefundTimeoutParts(refundTimeoutPartsFromSeconds(loadedRefundTimeoutSeconds));
    setMetadata({
      app: "kaspa-raffle-static",
      version: selectedHistoryRound.version ?? emptyMetadata.version,
      network: loadedNetwork,
      roundId: selectedHistoryRound.roundId,
      createTxId: selectedHistoryRound.createTxId ?? "",
      startBlockHash,
      createdAtDaaScore: selectedHistoryRound.createdAtDaaScore,
      refundTimeoutSeconds: loadedRefundTimeoutSeconds.toString(),
      refundTimeoutDaa: selectedHistoryRound.refundTimeoutDaa,
      ticketPrice: selectedHistoryRound.ticketPrice.toString(),
      maxTickets: selectedHistoryRound.maxTickets,
      minTickets: selectedHistoryRound.minTickets,
      maxBatches: selectedHistoryRound.maxBatches,
      roundNonce: selectedHistoryRound.roundNonce,
      salesDeadlineDaa: selectedHistoryRound.salesDeadlineDaa,
      creatorAddress: selectedHistoryRound.creator ?? "",
      creatorPubkey: selectedHistoryRound.creatorPubkey ?? covenant.creatorPubkey,
      refundAfterDaaScore: selectedHistoryRound.refundAfterDaaScore ?? covenant.refundAfterDaaScore,
      treasuryAddress: covenant.address,
      registryAddress: loadedRegistryAddress,
      registryTxId: selectedHistoryRound.registryTxId,
      registryRefundTxId: selectedHistoryRound.registryRefundTxId,
      covenant,
      contractVersion: selectedHistoryRound.contractVersion ?? emptyMetadata.contractVersion
    });
    setTickets(loadedTickets);
    setFinalized(undefined);
    setTerminalRoundStatus(undefined);
    setRoundActionTab(covenant.status === "Open" ? "buy" : "payout");
    setIsRoundSourceOpen(false);
    setMetadataMessage("Round loaded from history.");
    setHistoryMessage(
      loadedCarrierWarning
        ? selectedHistoryRound.contractVersion === RAFFLE_CONTRACT_VERSION && covenant.soldTickets < selectedHistoryRound.minTickets
          ? `Loaded ${selectedHistoryRound.roundId}. Its ${formatKas(loadedCarrierSompi)} carrier is below the ${formatKas(MIN_COVENANT_CARRIER_SOMPI)} settlement minimum. Buying is blocked; top up carrier before anyone buys.`
          : `Loaded ${selectedHistoryRound.roundId}. Its ${formatKas(loadedCarrierSompi)} carrier is below the ${formatKas(MIN_COVENANT_CARRIER_SOMPI)} settlement minimum and cannot be safely settled; keep it in recovery review.`
        : `Loaded ${selectedHistoryRound.roundId}. You can buy if open, or finalize/refund when eligible.`
    );
  }

  function updateCreateParameters<K extends keyof typeof createParameters>(key: K, value: (typeof createParameters)[K]) {
    setCreateParameters((current) => ({
      ...current,
      [key]: value
    }));
  }

  function updateRefundTimeoutPart(key: RefundTimeoutPart, value: string) {
    setRefundTimeoutParts((current) => ({
      ...current,
      [key]: normalizeDurationInput(value)
    }));
  }

  function openRoundWorkspace(tab: RoundSourceTab) {
    setRoundSourceTab(tab);
    setIsRoundSourceOpen(true);
    window.requestAnimationFrame(() => {
      document.getElementById("round-source-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function renderIndexerRequirement(input: {
    maxTickets: number;
    soldTickets: number;
    soldBatches: number;
    knownTickets: number;
    knownBatches: number;
  }) {
    return (
      <div className="indexer-requirement" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <div className="indexer-requirement-content">
          <strong>{t("indexerRequiredTitle")}</strong>
          <p>{t("indexerRequiredDetail", {
            max: input.maxTickets.toLocaleString(),
            sold: input.soldTickets.toLocaleString(),
            known: input.knownTickets.toLocaleString(),
            batches: input.knownBatches.toLocaleString(),
            totalBatches: input.soldBatches.toLocaleString()
          })}</p>
          <div className="indexer-config-row">
            <label className="field">
              <span>{t("raffleIndexApi")}</span>
              <input
                type="url"
                value={indexApiBase}
                onChange={(event) => handleIndexApiInput(event.target.value)}
                placeholder={DEFAULT_RAFFLE_INDEX_API}
              />
            </label>
            <button type="button" className="secondary" onClick={handleCheckIndexer} disabled={isCheckingIndexer}>
              <ShieldCheck size={17} />
              {isCheckingIndexer ? t("checkingIndexer") : t("checkIndexer")}
            </button>
          </div>
          {indexerCheckMessage ? (
            <p className={`indexer-check-message ${indexerCheckState}`}>{indexerCheckMessage}</p>
          ) : null}
        </div>
      </div>
    );
  }

  const chainFeedback = chainError || chainMessage ? <>
    {chainError ? <p className="error-text action-message"><ExplorerText network={networkId} text={rt(chainError)} /></p> : null}
    {chainMessage ? <p className="success-text action-message"><ExplorerText network={networkId} text={rt(chainMessage)} /></p> : null}
  </> : undefined;

  const showIntroGuides = !introGuidesSeen;
  const gameplayGuide = showIntroGuides ? (
    <section className="gameplay-guide" aria-labelledby="gameplay-title">
      <div className="gameplay-heading">
        <div>
          <p className="eyebrow">{t("gameplay.eyebrow")}</p>
          <h2 id="gameplay-title">{t("gameplay.title")}</h2>
          <p>{t("gameplay.description")}</p>
        </div>
        <span className="gameplay-protocol-badge"><ShieldCheck size={17} />{t("gameplay.badge")}</span>
      </div>
      <div className="gameplay-flow">
        <article><span className="gameplay-step">01</span><Ticket size={22} aria-hidden="true" /><div><h3>{t("gameplay.step.buy.title")}</h3><p>{t("gameplay.step.buy.detail")}</p></div></article>
        <article><span className="gameplay-step">02</span><RefreshCcw size={22} aria-hidden="true" /><div><h3>{t("gameplay.step.wait.title")}</h3><p>{t("gameplay.step.wait.detail")}</p></div></article>
        <article><span className="gameplay-step">03</span><Trophy size={22} aria-hidden="true" /><div><h3>{t("gameplay.step.settle.title")}</h3><p>{t("gameplay.step.settle.detail")}</p></div></article>
      </div>
      <div className="gameplay-trust-strip" aria-label={t("gameplay.advantages")}>
        <span><ShieldCheck size={16} />{t("gameplay.trust.prize")}</span><span><RefreshCcw size={16} />{t("gameplay.trust.public")}</span><span><Trophy size={16} />{t("gameplay.trust.random")}</span><span><Link2 size={16} />{t("gameplay.trust.transparent")}</span>
      </div>
      <p className="gameplay-fee-note">{t("gameplay.feeNote")}</p>
    </section>
  ) : null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p className="kicker">Kaspa Toccata · {networkLabel(selectedNetwork.id)}</p>
          <div className="brand-lockup">
            <h1 className="brand-heading">
              {t("app.title")}
              <span className="app-version">v{packageJson.version}</span>
            </h1>
            <div className="kaspa-brand-mark" aria-hidden="true">
              <span className="kaspa-symbol">K</span>
              <span className="kaspa-wordmark">KASPA</span>
              <span className="kaspa-network-tag">{selectedNetwork.id === "testnet-10" ? "TN10" : "MAINNET"}</span>
            </div>
          </div>
        </div>
        <div className="header-tools">
          <label className="language-picker">
            <Languages size={17} aria-hidden="true" />
            <span className="visually-hidden">{t("language")}</span>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as Language)}
              aria-label={t("language")}
            >
              <option value="zh">{t("language.chinese")}</option>
              <option value="en">{t("language.english")}</option>
            </select>
          </label>
        </div>
      </header>

      <section className={`notice-band${networkId === "mainnet" ? " mainnet" : ""}`}>
        <AlertTriangle size={18} />
        <p>
          {networkId === "mainnet"
            ? t("notice.mainnet")
            : t("notice.testnet")}
        </p>
      </section>

      <details className="rescue-guide-disclosure">
        <summary>{t("rescueGuide.summary")}</summary>
        <p>{t("rescueGuide.detail")}</p>
      </details>

      {gameplayGuide}

      <section className="setup-strip header-connectivity" aria-label={t("connection.aria")}>
        <div className="setup-group setup-network-group">
          <div className="network-picker" ref={networkPickerRef}>
          <button
            type="button"
            className="network-trigger secondary"
            onClick={() => {
              setIsNetworkMenuOpen((current) => !current);
              setNetworkSettingsId(null);
              setRpcError("");
            }}
            disabled={networkSwitchDisabled}
            aria-haspopup="menu"
            aria-expanded={isNetworkMenuOpen}
          >
            <span>
              <small>{t("network")}</small>
              <strong>{networkLabel(selectedNetwork.id)}</strong>
              <small className={`network-connection-state${nodeStatus.connected ? " connected" : isConnectingNode ? " connecting" : rpcError ? " failed" : ""}`}>
                {nodeStatus.connected ? t("node.ready") : isConnectingNode ? t("connecting") : rpcError ? t("node.failed") : t("node.offline")}
              </small>
            </span>
            <ChevronDown size={17} />
          </button>

          {isNetworkMenuOpen ? (
            <div className="network-menu" role="menu" aria-label={t("network.switch")}>
              <div className="network-menu-title">{t("network.switch")}</div>
              <div className="network-menu-connection">
                <span>
                  <small>{t("node")}</small>
                  <strong>{nodeStatus.connected ? t("node.ready") : isConnectingNode ? t("connecting") : rpcError ? t("node.failed") : t("node.offline")}</strong>
                </span>
              </div>
              {NETWORK_PROFILES.map((profile) => {
                const selected = profile.id === networkId;
                const editing = profile.id === networkSettingsId;

                return (
                  <div className="network-menu-row" key={profile.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={`network-option${selected ? " selected" : ""}`}
                      onClick={() => void handleSelectNetwork(profile.id)}
                    >
                      <span className="network-check" aria-hidden="true">{selected ? <Check size={16} /> : null}</span>
                      <span className="network-option-copy">
                        <strong>{networkLabel(profile.id)}{profile.id === "testnet-10" ? <small className="network-code">TN10</small> : null}</strong>
                        <small>{endpointSummary(networkEndpoints[profile.id])}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="network-settings-button"
                      onClick={() => openNetworkSettings(profile.id)}
                      aria-label={t("network.configure", { network: networkLabel(profile.id) })}
                    >
                      <Settings size={18} />
                    </button>
                    {editing ? (
                      <div className="network-endpoint-editor">
                        <div className="endpoint-mode-toggle" role="radiogroup" aria-label={t("node.source")}>
                          <label>
                            <input
                              type="radio"
                              name={`node-source-${profile.id}`}
                              checked={networkEndpointModeDraft === "resolver"}
                              onChange={() => setNetworkEndpointModeDraft("resolver")}
                            />
                            <span>{t("node.resolver")}</span>
                          </label>
                          <label>
                            <input
                              type="radio"
                              name={`node-source-${profile.id}`}
                              checked={networkEndpointModeDraft === "custom"}
                              onChange={() => setNetworkEndpointModeDraft("custom")}
                            />
                            <span>{t("node.custom")}</span>
                          </label>
                        </div>
                        <label className="field">
                          <span>{networkLabel(profile.id)} {t("node")}</span>
                          <input
                            value={networkEndpointDraft}
                            onChange={(event) => setNetworkEndpointDraft(event.target.value)}
                            disabled={networkEndpointModeDraft === "resolver"}
                            autoFocus
                          />
                        </label>
                        <button type="button" onClick={saveNetworkSettings}>{t("apply")}</button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          </div>

        </div>

        <div className="setup-group setup-wallet-group">
          <div className="wallet-summary">
            <div className="wallet-balance" tabIndex={wallet ? 0 : undefined} aria-label={wallet ? `${t("balance")}: ${formatKas(wallet.balanceSompi)}` : undefined}>
              <span className="summary-label">{t("balance")}</span>
              <strong>{wallet ? formatKasCompact(wallet.balanceSompi) : t("unknown")}</strong>
              {wallet ? <span className="wallet-balance-full" role="tooltip">{formatKas(wallet.balanceSompi)}</span> : null}
            </div>
            <button type="button" className="icon-button secondary" onClick={handleRefreshBalance} aria-label={t("refreshBalance")}>
              <RefreshCw size={17} />
            </button>
          </div>

          <div className="wallet-actions">
            {wallet ? (
              <button type="button" className="secondary" onClick={handleDisconnectWallet}>{t("disconnectWallet", { wallet: wallet.providerName })}</button>
            ) : (
              <div className="wallet-picker" ref={walletPickerRef}>
                <button
                  type="button"
                  onClick={handleToggleWalletMenu}
                  disabled={isConnectingWallet}
                  aria-haspopup="menu"
                  aria-expanded={isWalletMenuOpen}
                >
                  <WalletCards size={17} />
                  {isConnectingWallet ? t("connecting") : t("connectWallet")}
                </button>
                {isWalletMenuOpen ? (
                  <div className="wallet-menu" role="menu" aria-label={t("chooseWallet")}>
                    {walletOptions.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitem"
                        className="wallet-menu-item"
                        disabled={!option.installed}
                        onClick={() => handleConnectWallet(option.id)}
                      >
                        <span>{option.name}</span>
                        <small>{option.installed ? t("detected") : t("notInstalled")}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {rpcError ? <p className="error-text strip-message">{rt(rpcError)}</p> : null}
        {walletError ? <p className="error-text strip-message">{rt(walletError)}</p> : null}
      </section>

      <div className="round-primary-workspace">
      <section className={`round-overview${hasCurrentRound ? "" : " empty"}`}>
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">{t("currentRound")}</p>
            <h2>{metadata.roundId ? shortValue(metadata.roundId, 12) : t("currentRound.empty")}</h2>
          </div>
          <div className="heading-actions">
            {hasCurrentRound ? <span className={`round-status status-${round.status.toLowerCase()}`}>{t(`status.${round.status}`)}</span> : null}
            {metadata.roundId ? (
              <button type="button" className="icon-button secondary" onClick={handleCopyRoundLink} aria-label={t("copyRoundLink")}>
                <Link2 size={17} />
              </button>
            ) : null}
            <button
              type="button"
              className={`round-source-menu-button${isRoundSourceOpen ? " active" : ""}`}
              aria-expanded={isRoundSourceOpen}
              aria-controls="round-source-content"
              onClick={() => setIsRoundSourceOpen((current) => !current)}
            >
              {t("roundManager.menu")}
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {registryPublicationPending || registryMarkerRefundPending || registryRecoveryMessage || registryRecoveryError ? (
          <section className="registry-recovery-panel" aria-live="polite">
            <div>
              <strong>{registryPublicationPending
                ? t("registry.publishPending")
                : registryMarkerRefundPending
                  ? t("registry.refundPending")
                  : t("registryTx")}</strong>
              <p>{registryPublicationPending
                ? t("registry.publishPendingDetail")
                : registryMarkerRefundPending
                  ? t("registry.refundPendingDetail")
                  : null}</p>
            </div>
            {registryPublicationPending ? (
              <button type="button" className="secondary" onClick={requestRegistrySigningConfirmation} disabled={isPublishingRegistry || !wallet || !nodeStatus.connected}>
                {isPublishingRegistry ? t("registry.publishing") : t("registry.publishButton")}
              </button>
            ) : null}
            {registryMarkerRefundPending ? (
              <button type="button" className="secondary" onClick={executeRegistryMarkerRecovery} disabled={isRecoveringRegistryMarker || !nodeStatus.connected}>
                {isRecoveringRegistryMarker ? t("registry.refunding") : t("registry.refundButton")}
              </button>
            ) : null}
            {registryRecoveryError ? <p className="error-text registry-recovery-feedback">{rt(registryRecoveryError)}</p> : null}
            {registryRecoveryMessage ? <p className="success-text registry-recovery-feedback">{rt(registryRecoveryMessage)}</p> : null}
          </section>
        ) : null}

        {hasCurrentRound ? <>
        <div className="key-metrics">
          <div>
            <span>{t("ticketsSold")}</span>
            <strong>{round.soldTickets.toLocaleString()} / {round.maxTickets.toLocaleString()}</strong>
          </div>
          <div>
            <span>{t("prizePot")}</span>
            <strong>{formatKas(round.potAmount)}</strong>
          </div>
          <div>
            <span>{t("ticketPrice")}</span>
            <strong>{formatKas(round.ticketPrice)}</strong>
          </div>
          <div>
            <span>{t("drawRefund")}</span>
            {refundCountdownParts ? (
              <time className="round-countdown" dateTime={`PT${refundCountdownParts.months}M${refundCountdownParts.days}DT${refundCountdownParts.hours}H${refundCountdownParts.minutes}M${refundCountdownParts.seconds}S`} aria-live="polite">
                {REFUND_TIMEOUT_FIELDS.map((field) => (
                  <span className="countdown-unit" key={field.key}>
                    <b>{refundCountdownParts[field.key].padStart(2, "0")}</b>
                    <small>{t(field.labelKey)}</small>
                  </span>
                ))}
              </time>
            ) : (
              <strong>{metadata.covenant ? t("pending") : refundTimeoutDisplay}</strong>
            )}
          </div>
        </div>

        <div className="progress-track" aria-label={t("ticketProgress")}>
          <span style={{ width: `${soldPercent}%` }} />
        </div>

        {ticketBatches.length ? (
          <details className="disclosure compact-disclosure">
            <summary>{t(ticketBatches.length === 1 ? "purchaseBatch.one" : "purchaseBatch", { count: ticketBatches.length.toLocaleString() })}</summary>
            <div className="batch-list">
              {ticketBatches.map((batch) => (
                <div className="batch-row" key={batch.txId || `${batch.start}-${batch.end}`}>
                  <ExplorerLink kind="transaction" network={networkId} value={batch.txId} label={<strong>#{batch.start}{batch.end > batch.start ? `-${batch.end}` : ""}</strong>} />
                  <span>{t(batch.count === 1 ? "ticketCount.one" : "ticketCount", { count: batch.count.toLocaleString() })}</span>
                  <ExplorerLink className="mono" kind="address" network={networkId} value={batch.owner} />
                  <span>{formatKas(batch.amount)}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        </> : <div className="round-overview-empty">
          <p>{t("currentRound.emptyHint")}</p>
        </div>}
      </section>

      <ActionWorkspace
          activeIndexerRequirement={activeRoundNeedsIndexer && metadata.covenant ? renderIndexerRequirement({ maxTickets: metadata.maxTickets, soldTickets: metadata.covenant.soldTickets, soldBatches: activeSoldBatches, knownTickets: totalTicketCount(tickets), knownBatches: tickets.length }) : null}
          actionTab={roundActionTab}
          buyBlockedReason={buyBlockedReason}
          buyNotice={rescueBuyNotice}
          buyCostTooltip={buyCostTooltip}
          canBuy={canBuy}
          canCloseEmpty={canCloseEmpty}
          canDraw={canDraw}
          canRefund={canRefund}
          canTopUpCarrier={canTopUpCarrier}
          drawBlockedReason={drawBlockedReason}
          emptyCloseCostTooltip={emptyCloseCostTooltip}
          feedback={chainFeedback}
          feedbackTarget={chainFeedbackTarget}
          finalized={finalized}
          formatKas={formatKas}
          isBuying={isBuying}
          isClosingEmpty={isClosingEmptyRound}
          isFinalizing={isFinalizing}
          isRefunding={isRefundingRound}
          isToppingUpCarrier={isToppingUpCarrier}
          metadata={metadata}
          network={networkId}
          onBuy={requestBuySigningConfirmation}
          onCloseEmpty={handleCloseEmptyRound}
          onDraw={handleFinalizeLocal}
          onRefund={requestRefundSigningConfirmation}
          onTopUpCarrier={requestCarrierTopUpSigningConfirmation}
          onSelectTab={setRoundActionTab}
          parsedTicketQuantity={parsedTicketQuantity}
          payoutCostTooltip={payoutCostTooltip}
          purchaseTotal={purchaseTotal}
          refundAvailable={refundAvailable}
          refundBlockedReason={refundBlockedReason}
          refundCostTooltip={refundCostTooltip}
          refundProgress={refundProgress}
          remainingTickets={remainingTickets}
          round={round}
          setTicketQuantity={setTicketQuantity}
          setTopUpCarrierKas={setTopUpCarrierKas}
          shortValue={shortValue}
          t={t}
          ticketQuantity={ticketQuantity}
          topUpCarrierKas={topUpCarrierKas}
          supportsCarrierTopUp={supportsCarrierTopUp}
        />

      <div id="round-source-workspace" className="round-source-anchor embedded">
        <SourceWorkspace
        embedded
        expanded={isRoundSourceOpen}
        sourceTab={roundSourceTab}
        onExpandedChange={setIsRoundSourceOpen}
        onSelectTab={setRoundSourceTab}
        t={t}
        createPanel={<CreateRoundPanel
            canStartNewRound={canStartNewRound}
            createCostTooltip={createCostTooltip}
            createRegistryAddress={createRegistryAddress}
            covenantCarrierSompi={covenantCarrierSompi}
            finalized={Boolean(finalized)}
            feedback={chainFeedbackTarget === "create" ? chainFeedback : undefined}
            formatKas={formatKas}
            isCreatingRound={isCreatingRound}
            metadata={createParameters}
            maxPurchaseBatches={PROTOCOL_MANIFEST.maxRelaySafePurchaseBatches}
            recommendedMaxBatches={recommendedMaxBatches}
            minimumTicketPrice={formatKas(MIN_REFUNDABLE_TICKET_PRICE_SOMPI)}
            networkId={networkId}
            onCreate={requestCreateSigningConfirmation}
            onRegistryAddressChange={setCreateRegistryAddress}
            onResetRegistry={() => setCreateRegistryAddress(registryAddress)}
            onTimeoutChange={updateRefundTimeoutPart}
            onUpdateMetadata={updateCreateParameters}
            refundTimeoutDisplay={refundTimeoutDisplay}
            refundTimeoutFields={REFUND_TIMEOUT_FIELDS}
            refundTimeoutParts={refundTimeoutParts}
            registryAddress={registryAddress}
            registryMarkerRefundAmount={registryMarkerRefundAmount}
            setCarrierSompi={setCovenantCarrierSompi}
            sompiToKasInput={sompiToKasInput}
            kasInputToSompi={kasInputToSompi}
            t={t}
            usesAutoRefundRegistry={usesAutoRefundRegistry}
            usesDefaultRegistry={usesDefaultRegistry}
          />}
        historyPanel={<section id="round-history-panel" className="history-section history-tab-panel" role="tabpanel" aria-labelledby="round-history-tab raffle-history-title">
        <div className="section-heading-row">
          <div className="history-title-block">
            <p className="eyebrow">{t("onChainActivity")}</p>
            <h2 id="raffle-history-title">{t("raffleHistory")}</h2>
            <p className="history-summary" aria-live="polite">
              {historyRounds.length
                ? t("historySummary", {
                    playable: playableHistoryRoundCount.toLocaleString(),
                    rounds: historyRounds.length.toLocaleString(),
                    local: historyRounds.filter((historyRound) => historyRound.localCachedAt).length.toLocaleString(),
                    paid: historyRounds.filter((historyRound) => historyRoundStatus(historyRound) === "Paid").length.toLocaleString(),
                    refunded: historyRounds.filter((historyRound) => historyRoundStatus(historyRound) === "Refunded").length.toLocaleString()
                  })
                : isLoadingHistory
                  ? t("readingHistory")
                  : t("historyResults")}
            </p>
          </div>
          <button type="button" className="history-refresh" onClick={handleLoadHistory} disabled={isLoadingHistory}>
            <RefreshCw size={17} />
            {isLoadingHistory ? t("loadingHistory") : t("refreshHistory")}
          </button>
        </div>

        {historyError ? <p className="error-text">{rt(historyError)}</p> : null}
        {historyMessage ? <p className="success-text">{rt(historyMessage)}</p> : null}

        {historyRounds.length ? (
          <>
            <div className="history-round-picker">
              <label className="field history-select">
                <span>{t("round")}</span>
                <select
                  value={selectedHistoryRound?.roundId ?? ""}
                  onChange={(event) => setSelectedHistoryRoundId(event.target.value)}
                >
                  {orderedHistoryRounds.map((historyRound) => (
                    <option key={historyRound.roundId} value={historyRound.roundId}>
                      {historyRoundIsPlayable(historyRound) ? `${t("openToJoin")} - ` : ""}{historyRound.localCachedAt ? `${t("savedLocally")} - ` : ""}{historyRound.roundId} - {t(`status.${historyRoundStatus(historyRound)}`)} - {t((historyRound.soldTickets ?? totalTicketCount(historyRound.tickets)) === 1 ? "ticketCount.one" : "ticketCount", { count: (historyRound.soldTickets ?? totalTicketCount(historyRound.tickets)).toLocaleString() })}{historyRoundNeedsIndexer(historyRound) ? ` - ${t("indexerRequiredShort")}` : ""}
                    </option>
                  ))}
                </select>
              </label>

              {selectedHistoryRound && (selectedHistoryRound.latestCovenant || selectedHistoryRound.localCachedAt) ? (
                <button
                  type="button"
                  className={selectedHistoryRoundPlayable ? "join-round-button" : "secondary"}
                  onClick={handleJoinSelectedHistoryRound}
                  disabled={Boolean(
                    (selectedHistoryRound.latestCovenant?.status === "Refunded" && !selectedHistoryRound.localCachedAt) ||
                    selectedHistoryRoundArchivedRelease || selectedHistoryRoundQuarantined
                  )}
                >
                  {t(selectedHistoryRoundPlayable ? "joinThisRound" : "loadThisRound")}
                </button>
              ) : null}
            </div>

            {selectedHistoryRound ? (
              <div className="history-detail">
                <div className="key-metrics history-metrics">
                  <div><span>{t("status")}</span><strong>{t(`status.${historyRoundStatus(selectedHistoryRound)}`)}</strong></div>
                  <div><span>{t("tickets")}</span><strong>{(selectedHistoryRound.soldTickets ?? totalTicketCount(selectedHistoryRound.tickets)).toLocaleString()}</strong></div>
                  <div><span>{t("pot")}</span><strong>{formatKas(selectedHistoryRound.potAmount)}</strong></div>
                  <div>
                    <span>{t("winner")}</span>
                    <strong>{selectedHistoryRound.payouts[0] ? `#${selectedHistoryRound.payouts[0].winnerTicketId}` : t("pending")}</strong>
                  </div>
                </div>

                {selectedHistoryRoundArchivedRelease ? (
                  <p className="error-text">
                    {t("legacyRoundRequiresRelease", {
                      version: selectedHistoryRound.contractVersion ?? t("unknown"),
                      release: selectedHistoryRoundArchivedRelease
                    })}{" "}
                    <a
                      href={`https://github.com/agang0311/kaswin/releases/tag/${selectedHistoryRoundArchivedRelease}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("downloadCompatibleRelease")}
                    </a>
                  </p>
                ) : null}

                {selectedHistoryRoundQuarantined ? (
                  <p className="error-text">
                    {t("quarantinedRound", { version: selectedHistoryRound.contractVersion ?? t("unknown") })}
                  </p>
                ) : null}

                {selectedHistoryRoundRequiresIndexer ? renderIndexerRequirement({
                  maxTickets: selectedHistoryRound.maxTickets ?? 0,
                  soldTickets: selectedHistoryRound.soldTickets ?? totalTicketCount(selectedHistoryRound.tickets),
                  soldBatches: selectedHistoryRound.latestCovenant?.soldBatches ?? selectedHistoryRound.tickets.length,
                  knownTickets: totalTicketCount(selectedHistoryRound.tickets),
                  knownBatches: selectedHistoryRound.tickets.length
                }) : null}

                <details className="disclosure compact-disclosure">
                  <summary>{t(selectedHistoryBatches.length === 1 ? "purchaseBatch.one" : "purchaseBatch", { count: selectedHistoryBatches.length.toLocaleString() })}</summary>
                  <div className="batch-list">
                    {selectedHistoryBatches.map((batch) => (
                      <div className="batch-row" key={batch.txId}>
                        <ExplorerLink kind="transaction" network={networkId} value={batch.txId} label={<strong>#{batch.start}{batch.end > batch.start ? `-${batch.end}` : ""}</strong>} />
                        <span>{t(batch.count === 1 ? "ticketCount.one" : "ticketCount", { count: batch.count.toLocaleString() })}</span>
                        <ExplorerLink className="mono" kind="address" network={networkId} value={batch.owner} />
                        <span>{formatKas(batch.amount)}</span>
                      </div>
                    ))}
                  </div>
                </details>

                <details className="disclosure compact-disclosure">
                  <summary>{t("transactionsTiming")}</summary>
                  <dl className="stat-list dense disclosure-body">
                    <div><dt>{t("contractVersion")}</dt><dd>{selectedHistoryRound.contractVersion || t("unknown")}</dd></div>
                    <div><dt>{t("registryTx")}</dt><dd className="mono"><ExplorerLink compact={false} kind="transaction" network={networkId} value={selectedHistoryRound.registryTxId} />{!selectedHistoryRound.registryTxId ? t("unknown") : null}</dd></div>
                    <div><dt>{t("covenant")}</dt><dd className="mono"><ExplorerLink compact={false} kind="address" network={networkId} value={selectedHistoryRound.latestCovenant?.address ?? selectedHistoryRound.treasuryAddress} />{!selectedHistoryRound.latestCovenant?.address && !selectedHistoryRound.treasuryAddress ? t("unknown") : null}</dd></div>
                    <div><dt>{t("refundTx")}</dt><dd className="mono"><ExplorerLink compact={false} kind="transaction" network={networkId} value={selectedHistoryRound.refundTxId} />{!selectedHistoryRound.refundTxId ? t("pending") : null}</dd></div>
                    <div><dt>{t("refundAfterDaa")}</dt><dd className="mono">{selectedHistoryRound.latestCovenant?.refundAfterDaaScore ?? selectedHistoryRound.refundAfterDaaScore ?? t("unknown")}</dd></div>
                    <div><dt>{t("lastSeen")}</dt><dd>{formatDate(selectedHistoryRound.lastBlockTime, language)}</dd></div>
                    {selectedHistoryRound.payouts[0] ? (
                      <div><dt>{t("payoutTx")}</dt><dd className="mono"><ExplorerLink compact={false} kind="transaction" network={networkId} value={selectedHistoryRound.payouts[0].txId} /></dd></div>
                    ) : null}
                  </dl>
                </details>
              </div>
            ) : null}
          </>
        ) : (
          <p className="history-empty">{t("noIndexedRounds")}</p>
        )}

        <details className="disclosure compact-disclosure">
          <summary>{t("historySource")}</summary>
          <div className="form-grid disclosure-body">
            <label className="field">
              <span>{t("restApi")}</span>
              <input value={historyApiBase} onChange={(event) => setHistoryApiBase(event.target.value)} />
            </label>
            <label className="field">
              <span>{t("raffleIndexApi")}</span>
              <input value={indexApiBase} onChange={(event) => handleIndexApiInput(event.target.value)} />
              <small>{t("indexerWhenNeeded")}</small>
            </label>
            <label className="field">
              <span>{t("registryAddress")}</span>
              <input
                value={historyAddress || metadata.registryAddress || registryAddress || metadata.treasuryAddress || ""}
                onChange={(event) => setHistoryAddress(event.target.value)}
                placeholder={networkId === "mainnet" ? "kaspa:..." : "kaspatest:..."}
              />
            </label>
          </div>
        </details>
      </section>}
        />
      </div>
      </div>

      {showIntroGuides && !metadata.roundId && !metadata.covenant ? (
        <section className="getting-started" aria-labelledby="getting-started-title">
          <div className="getting-started-heading">
            <div><p className="eyebrow">{t("gettingStarted.eyebrow")}</p><h2 id="getting-started-title">{t("gettingStarted.title")}</h2></div>
            <span className="onboarding-progress">{t("gettingStarted.progress", { complete: Number(nodeStatus.connected) + Number(Boolean(wallet)) })}</span>
            <p>{t("gettingStarted.description")}</p>
          </div>
          <ol className="getting-started-steps">
            <li className={nodeStatus.connected ? "complete" : ""}><span className="step-number">1</span><div><strong>{t("gettingStarted.node.title")}</strong><p>{nodeStatus.connected ? t("gettingStarted.node.ready") : t("gettingStarted.node.detail")}</p></div>{nodeStatus.connected ? <CheckCircle2 size={20} aria-label={t("gettingStarted.complete")} /> : <span className="onboarding-node-state">{isConnectingNode ? t("connecting") : t("node.offline")}</span>}</li>
            <li className={wallet ? "complete" : ""}><span className="step-number">2</span><div><strong>{t("gettingStarted.wallet.title")}</strong><p>{wallet ? t("gettingStarted.wallet.ready", { wallet: shortValue(wallet.address, 8) }) : t("gettingStarted.wallet.detail")}</p></div>{!wallet ? <button type="button" className="secondary" onClick={handleToggleWalletMenu}>{t("connectWallet")}</button> : <CheckCircle2 size={20} aria-label={t("gettingStarted.complete")} />}</li>
            <li><span className="step-number">3</span><div><strong>{t("gettingStarted.round.title")}</strong><p>{t("gettingStarted.round.detail")}</p></div><div className="getting-started-actions"><button type="button" onClick={() => openRoundWorkspace("history")}>{t("gettingStarted.load")}</button><button type="button" className="secondary" onClick={() => openRoundWorkspace("create")}>{t("gettingStarted.create")}</button></div></li>
          </ol>
        </section>
      ) : null}

      <AdvancedSettingsPanel title={t("advanced")}>
          <section>
            <h3>{t("roundSettings")}</h3>
            <div className="form-grid">
              <label className="field">
                <span>{t("carrierReserveKas")}</span>
                <input
                  inputMode="decimal"
                  value={sompiToKasInput(covenantCarrierSompi)}
                  onChange={(event) => setCovenantCarrierSompi(kasInputToSompi(event.target.value))}
                />
              </label>
            </div>
            <dl className="stat-list dense">
              <div><dt>{t("network")}</dt><dd>{networkLabel(networkId)}</dd></div>
              <div><dt>{t("roundId")}</dt><dd className="mono">{metadata.roundId || t("pending")}</dd></div>
              <div><dt>{t("covenant")}</dt><dd className="mono"><ExplorerLink compact={false} kind="address" network={networkId} value={metadata.treasuryAddress} />{!metadata.treasuryAddress ? t("pending") : null}</dd></div>
              <div><dt>{t("refundAfterDaa")}</dt><dd className="mono">{metadata.covenant?.refundAfterDaaScore || metadata.refundAfterDaaScore || t("pending")}</dd></div>
              <div><dt>{t("contractVersion")}</dt><dd>{metadata.contractVersion}</dd></div>
            </dl>
          </section>

          <section>
            <h3>{t("nodeDiagnostics")}</h3>
            <dl className="stat-list dense">
              <div><dt>{t("network")}</dt><dd>{nodeStatus.network === "mainnet" || nodeStatus.network === "testnet-10" ? networkLabel(nodeStatus.network) : t("unknown")}</dd></div>
              <div><dt>{t("sync")}</dt><dd>{t(`sync.${nodeStatus.syncStatus}`)}</dd></div>
              <div><dt>{t("utxoIndex")}</dt><dd>{nodeStatus.hasUtxoIndex === undefined ? t("unknown") : nodeStatus.hasUtxoIndex ? t("enabled") : t("disabled")}</dd></div>
              <div><dt>{t("latency")}</dt><dd>{nodeStatus.latencyMs ? `${nodeStatus.latencyMs} ms` : t("unknown")}</dd></div>
              <div><dt>{t("version")}</dt><dd>{nodeStatus.serverVersion ?? t("unknown")}</dd></div>
            </dl>
          </section>

          <section className="technical-wide">
            <h3>{t("roundMetadata")}</h3>
            <textarea
              spellCheck={false}
              value={metadataText}
              onChange={(event) => setMetadataText(event.target.value)}
            />
            <div className="button-row">
              <button type="button" className="secondary" onClick={handleImportMetadata}>
                <Upload size={17} />
                {t("importJson")}
              </button>
              <button type="button" className="secondary" onClick={handleCopyRoundLink}>
                <Link2 size={17} />
                {t("copyLink")}
              </button>
            </div>
            {metadataError ? <p className="error-text">{rt(metadataError)}</p> : null}
            {metadataMessage ? <p className="success-text">{rt(metadataMessage)}</p> : null}
          </section>

          <section className="technical-wide">
            <h3>{t("contractVerification")}</h3>
            <div className={verification.ok ? "verify-box ok" : "verify-box"}>
              <ShieldCheck size={20} />
              <span>{verification.ok ? t("localChecksPassed") : t("localChecksIssues")}</span>
            </div>
            <dl className="stat-list dense">
              <div><dt>{t("contractRuntime")}</dt><dd>{covenantStatus.contract}</dd></div>
              <div><dt>{t("artifactStatus")}</dt><dd>{covenantStatus.status}</dd></div>
              <div><dt>{t("ticketRoot")}</dt><dd className="mono">{metadata.covenant?.ticketRoot || t("pending")}</dd></div>
              <div><dt>{t("createTx")}</dt><dd className="mono"><ExplorerLink compact={false} kind="transaction" network={networkId} value={metadata.createTxId} />{!metadata.createTxId ? t("pending") : null}</dd></div>
            </dl>
            {[...verification.errors, ...verification.warnings].length ? (
              <ul className="message-list">
                {[...verification.errors, ...verification.warnings].map((message) => <li key={message}>{rt(message)}</li>)}
              </ul>
            ) : null}
          </section>
      </AdvancedSettingsPanel>
      <SigningConfirmationDialog
        language={language}
        preview={signingConfirmation.preview}
        confirming={isConfirmingSigning}
        onCancel={() => setSigningConfirmation(cancelSigningConfirmation())}
        onConfirm={confirmSigningPreview}
      />
    </main>
  );
}
