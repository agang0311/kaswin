import { useEffect, useMemo, useRef, useState } from "react";
import * as secp from "@noble/secp256k1";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Languages,
  Link2,
  Plug,
  RefreshCw,
  Settings,
  ShieldCheck,
  Ticket,
  Upload,
  WalletCards
} from "lucide-react";
import {
  assertRaffleCovenantReady,
  buildFinalizeSeedHex,
  buildNextTicketRootHex,
  bytesToHex,
  getRaffleCovenantStatus,
  isParticipantFinalizeContractVersion,
  pubkeyHexFromAddress,
  raffleWinnerIndexFromSeed
} from "../kaspa/covenant";
import { loadRaffleHistory, type RaffleHistoryRound } from "../kaspa/history";
import {
  connectBrowserRpc,
  disconnectBrowserRpc,
  getAddressBalanceSompi,
  type KaspaNodeStatus,
  type KaspaRpcConnection
} from "../kaspa/rpc";
import {
  NETWORK_PROFILES,
  networkFromAddress,
  normalizeNetworkId,
  requireNetworkProfile,
  type SupportedNetworkId
} from "../kaspa/networks";
import {
  assertValidKaspaAddress,
  buyRaffleCovenantTicket,
  COVENANT_BUY_FEE_SOMPI,
  COVENANT_CREATE_FEE_SOMPI,
  covenantFinalizeFeeSompi,
  covenantRefundFeeSompi,
  createRaffleCovenantRound,
  DEFAULT_COVENANT_CARRIER_SOMPI,
  DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI,
  finalizeRaffleCovenantRound,
  getRaffleRegistryConfig,
  MIN_COVENANT_CARRIER_SOMPI,
  REGISTRY_MARKER_REFUND_FEE_SOMPI,
  refundRaffleCovenantRound,
  refundRaffleRegistryMarker,
  sendKaspaPayment
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
import { createEmptyMetadata, parseMetadata, stringifyMetadata } from "../raffle/metadata";
import { hexToBytes, randomHex, sha256Hex } from "../raffle/randomness";
import { verifyRaffleState } from "../raffle/state";
import type { FinalizeState, RaffleMetadata, RoundState, TicketState } from "../raffle/types";
import { translate, translateRuntimeText, type Language, type TranslationValues } from "./i18n";

const emptyMetadata = createEmptyMetadata();
const KASPA_DAA_PER_SECOND = 10n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 60n * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24n * SECONDS_PER_HOUR;
const SECONDS_PER_MONTH = 30n * SECONDS_PER_DAY;
const DEFAULT_REFUND_TIMEOUT_SECONDS = 10n * SECONDS_PER_MINUTE;
const NETWORK_ENDPOINTS_STORAGE_KEY = "kaspa-raffle-network-endpoints-v1";
const LANGUAGE_STORAGE_KEY = "kaspa-raffle-language-v1";

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

type NetworkEndpoints = Record<SupportedNetworkId, string>;

function defaultNetworkEndpoints(): NetworkEndpoints {
  return Object.fromEntries(NETWORK_PROFILES.map((profile) => [profile.id, profile.defaultRpcUrl])) as NetworkEndpoints;
}

function loadNetworkEndpoints(): NetworkEndpoints {
  const defaults = defaultNetworkEndpoints();

  try {
    const saved = JSON.parse(localStorage.getItem(NETWORK_ENDPOINTS_STORAGE_KEY) ?? "{}") as Partial<NetworkEndpoints>;
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

type RefundTimeoutPart = "months" | "days" | "hours" | "minutes" | "seconds";
type RefundTimeoutParts = Record<RefundTimeoutPart, string>;

const DEFAULT_REFUND_TIMEOUT_PARTS: RefundTimeoutParts = {
  months: "0",
  days: "0",
  hours: "0",
  minutes: "10",
  seconds: "0"
};

const REFUND_TIMEOUT_FIELDS: Array<{ key: RefundTimeoutPart; labelKey: string }> = [
  { key: "months", labelKey: "duration.months" },
  { key: "days", labelKey: "duration.days" },
  { key: "hours", labelKey: "duration.hours" },
  { key: "minutes", labelKey: "duration.minutes" },
  { key: "seconds", labelKey: "duration.seconds" }
];

function formatKas(value: bigint) {
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} KAS`;
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
    throw new Error(`${fieldName} must be at least ${formatKas(minimum)} for the current Toccata storage-mass floor.`);
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

function oraclePublicKeyFromPrivateKey(privateKeyHex: string) {
  return bytesToHex(secp.schnorr.getPublicKey(hexToBytes(privateKeyHex)));
}

async function signOracleSeed(privateKeyHex: string, oracleSeedHex: string) {
  const seed = hexToBytes(oracleSeedHex);

  if (seed.length !== 32) {
    throw new Error("Oracle seed must be exactly 32 bytes.");
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(seed)));
  return bytesToHex(await secp.schnorr.signAsync(digest, hexToBytes(privateKeyHex)));
}

function encodePayload(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
}

const DEV_ORACLE_KEY_PREFIX = "kaspa-raffle-static:dev-oracle:";
const OPEN_DEV_ORACLE_DERIVATION_PREFIX = "kaspa-raffle-static:open-dev-oracle:v1:";

function devOracleStorageKey(roundId: string, oraclePublicKey: string) {
  return `${DEV_ORACLE_KEY_PREFIX}${roundId}:${oraclePublicKey}`;
}

function rememberDevOracleKey(roundId: string, oraclePublicKey: string, oraclePrivateKey: string) {
  if (!roundId || !oraclePublicKey || !/^[0-9a-f]{64}$/.test(oraclePrivateKey)) {
    return;
  }

  try {
    localStorage.setItem(devOracleStorageKey(roundId, oraclePublicKey), oraclePrivateKey);
  } catch {
    // Local dev convenience only; external oracle attestations still work.
  }
}

function restoreDevOracleKey(roundId: string, oraclePublicKey: string) {
  if (!roundId || !oraclePublicKey) {
    return "";
  }

  try {
    const privateKey = localStorage.getItem(devOracleStorageKey(roundId, oraclePublicKey)) ?? "";

    if (/^[0-9a-f]{64}$/.test(privateKey) && oraclePublicKeyFromPrivateKey(privateKey) === oraclePublicKey) {
      return privateKey;
    }
  } catch {
    return "";
  }

  return "";
}

async function deriveOpenDevOracleKey(roundId: string): Promise<string> {
  for (let nonce = 0; nonce < 256; nonce += 1) {
    const privateKey = await sha256Hex(`${OPEN_DEV_ORACLE_DERIVATION_PREFIX}${roundId}:${nonce}`);

    if (secp.utils.isValidSecretKey(hexToBytes(privateKey))) {
      return privateKey;
    }
  }

  throw new Error("Unable to derive the open development oracle key.");
}

async function recoverDevOracleKey(roundId: string, oraclePublicKey: string): Promise<string> {
  const storedKey = restoreDevOracleKey(roundId, oraclePublicKey);

  if (storedKey) {
    return storedKey;
  }

  const derivedKey = await deriveOpenDevOracleKey(roundId);

  if (oraclePublicKeyFromPrivateKey(derivedKey) !== oraclePublicKey) {
    return "";
  }

  rememberDevOracleKey(roundId, oraclePublicKey, derivedKey);
  return derivedKey;
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
  return error instanceof Error ? error.message : String(error || fallback);
}

async function currentVirtualDaaScore(connection: KaspaRpcConnection): Promise<bigint> {
  const serverInfo = await connection.client.getServerInfo();
  return BigInt(serverInfo.virtualDaaScore?.toString() ?? connection.status.daaScore ?? "0");
}

function formatDate(value: number | undefined, language: Language) {
  return value
    ? new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US")
    : language === "zh"
      ? "未知"
      : "unknown";
}

function refundTimeoutSecondsFromMetadata(metadata: Pick<RaffleMetadata, "refundTimeoutSeconds" | "refundTimeoutDaa">): bigint {
  if (metadata.refundTimeoutSeconds && /^\d+$/.test(metadata.refundTimeoutSeconds)) {
    return BigInt(metadata.refundTimeoutSeconds);
  }

  if (metadata.refundTimeoutDaa && /^\d+$/.test(metadata.refundTimeoutDaa)) {
    return BigInt(metadata.refundTimeoutDaa) / KASPA_DAA_PER_SECOND;
  }

  return DEFAULT_REFUND_TIMEOUT_SECONDS;
}

export function App() {
  const rpcConnectionRef = useRef<KaspaRpcConnection | null>(null);
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const [networkEndpoints, setNetworkEndpoints] = useState<NetworkEndpoints>(() => loadNetworkEndpoints());
  const [networkId, setNetworkId] = useState<SupportedNetworkId>("testnet-10");
  const [rpcUrl, setRpcUrl] = useState(() => loadNetworkEndpoints()["testnet-10"]);
  const [isNetworkMenuOpen, setIsNetworkMenuOpen] = useState(false);
  const [networkSettingsId, setNetworkSettingsId] = useState<SupportedNetworkId | null>(null);
  const [networkEndpointDraft, setNetworkEndpointDraft] = useState("");
  const [nodeStatus, setNodeStatus] = useState<KaspaNodeStatus>({
    connected: false,
    network: "unknown",
    syncStatus: "unknown"
  });
  const [virtualDaaScore, setVirtualDaaScore] = useState(0n);
  const [rpcError, setRpcError] = useState("");
  const [wallet, setWallet] = useState<BrowserTestWallet | null>(null);
  const [walletError, setWalletError] = useState("");
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);
  const [isWalletMenuOpen, setIsWalletMenuOpen] = useState(false);
  const [walletOptions, setWalletOptions] = useState<WalletAdapterOption[]>(() => listWalletAdapters());
  const [metadata, setMetadata] = useState<RaffleMetadata>(emptyMetadata);
  const [metadataText, setMetadataText] = useState(stringifyMetadata(emptyMetadata));
  const [metadataError, setMetadataError] = useState("");
  const [metadataMessage, setMetadataMessage] = useState("");
  const [oraclePrivateKey, setOraclePrivateKey] = useState("");
  const [oracleSeed, setOracleSeed] = useState("");
  const [oracleSignature, setOracleSignature] = useState("");
  const [buyerSecret, setBuyerSecret] = useState("");
  const [ticketQuantity, setTicketQuantity] = useState("1");
  const [tickets, setTickets] = useState<TicketState[]>([]);
  const [finalized, setFinalized] = useState<FinalizeState | undefined>();
  const [chainMessage, setChainMessage] = useState("");
  const [chainError, setChainError] = useState("");
  const [isCreatingRound, setIsCreatingRound] = useState(false);
  const [isBuying, setIsBuying] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isRefundingRound, setIsRefundingRound] = useState(false);
  const [covenantCarrierSompi, setCovenantCarrierSompi] = useState(DEFAULT_COVENANT_CARRIER_SOMPI.toString());
  const [refundTimeoutParts, setRefundTimeoutParts] = useState<RefundTimeoutParts>(DEFAULT_REFUND_TIMEOUT_PARTS);
  const [historyApiBase, setHistoryApiBase] = useState(requireNetworkProfile("testnet-10").historyApiBase);
  const [historyAddress, setHistoryAddress] = useState("");
  const [registryAddress, setRegistryAddress] = useState("");
  const [registryAutoRefund, setRegistryAutoRefund] = useState(false);
  const [createRegistryAddress, setCreateRegistryAddress] = useState("");
  const [historyRounds, setHistoryRounds] = useState<RaffleHistoryRound[]>([]);
  const [selectedHistoryRoundId, setSelectedHistoryRoundId] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyMessage, setHistoryMessage] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [roundSourceTab, setRoundSourceTab] = useState<"create" | "history">("create");
  const [roundActionTab, setRoundActionTab] = useState<"buy" | "payout">("buy");
  const isCreatingRoundRef = useRef(false);
  const isBuyingRef = useRef(false);
  const isFinalizingRef = useRef(false);
  const isRefundingRoundRef = useRef(false);
  const covenantStatus = useMemo(() => getRaffleCovenantStatus(), []);
  const canStartNewRound =
    !metadata.covenant ||
    Boolean(finalized) ||
    metadata.covenant.status === "Finalized" ||
    metadata.covenant.status === "Refunding" ||
    metadata.covenant.status === "Refunded";
  const selectedHistoryRound = useMemo(
    () => historyRounds.find((historyRound) => historyRound.roundId === selectedHistoryRoundId) ?? historyRounds[0],
    [historyRounds, selectedHistoryRoundId]
  );
  const refundTimeoutSeconds = useMemo(() => {
    try {
      return refundTimeoutSecondsFromParts(refundTimeoutParts);
    } catch {
      return 0n;
    }
  }, [refundTimeoutParts]);
  const refundTimeoutDaa = useMemo(() => refundTimeoutSeconds * KASPA_DAA_PER_SECOND, [refundTimeoutSeconds]);
  const refundTimeoutDisplay = useMemo(
    () => formatRefundTimeoutParts(refundTimeoutParts, language),
    [language, refundTimeoutParts]
  );
  const selectedNetwork = requireNetworkProfile(networkId);
  const networkSwitchDisabled = isCreatingRound || isBuying || isFinalizing || isRefundingRound;
  const t = (key: string, values?: TranslationValues) => translate(language, key, values);
  const rt = (value: string) => translateRuntimeText(language, value);
  const networkLabel = (id: SupportedNetworkId) => t(id === "mainnet" ? "network.mainnet" : "network.testnet10");

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    setMetadataText(stringifyMetadata(metadata));
  }, [metadata]);

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
    loadSharedRoundFromUrl();
  }, []);

  useEffect(() => {
    if (!wallet) {
      return;
    }

    const syncConnectedAccount = () => {
      void readConnectedBrowserWallet(wallet, rpcConnectionRef.current?.status.network ?? networkId)
        .then(async (nextWallet) => {
          if (!nextWallet) {
            setWallet(null);
            return;
          }

          const balanceSompi = rpcConnectionRef.current
            ? await getAddressBalanceSompi(rpcConnectionRef.current, nextWallet.address)
            : 0n;
          setWallet(withWalletBalance(nextWallet, balanceSompi));
          setWalletError("");
        })
        .catch((error) => setWalletError(error instanceof Error ? error.message : "Unable to update the connected wallet."));
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
    const status: RoundState["status"] = finalized
      ? "Finalized"
      : covenantStatus === "Refunding" || covenantStatus === "Refunded"
        ? covenantStatus
      : covenantStatus === "Closed" || tickets.length >= metadata.maxTickets
        ? "Closed"
        : "Open";
    const soldTickets = Math.max(tickets.length, covenant?.soldTickets ?? 0);
    const potAmount = covenant ? BigInt(covenant.potAmount) : BigInt(tickets.length) * ticketPrice;

    return {
      appId: "KASPA_RAFFLE_ROUND_V1",
      contractVersion: metadata.contractVersion,
      roundId: metadata.roundId || "pending-round",
      creator: metadata.creatorAddress || wallet?.address || "no-wallet",
      ticketPrice,
      maxTickets: metadata.maxTickets,
      minTickets: metadata.minTickets,
      soldTickets,
      potAmount,
      feeBps: 0,
      status,
      randomnessMode: "oracle",
      creatorPubkey: covenant?.creatorPubkey ?? metadata.creatorPubkey ?? (wallet ? pubkeyHexFromAddress(wallet.address) : ""),
      oraclePublicKey: metadata.oraclePublicKey,
      refundAfterDaaScore: covenant?.refundAfterDaaScore ?? metadata.refundAfterDaaScore ?? "0",
      ticketRoot: covenant?.ticketRoot ?? "",
      soldBatches: covenant?.soldBatches ?? covenant?.ticketOwnerPubkeys.length ?? tickets.length,
      ticketBatchEnds: covenant?.ticketBatchEnds ?? (covenant?.ticketOwnerPubkeys ?? tickets).map((_, index) => index + 1),
      ticketOwnerPubkeys: covenant?.ticketOwnerPubkeys ?? tickets.map((ticket) => ticket.ownerPubkey).filter(Boolean) as string[]
    };
  }, [finalized, metadata, tickets.length, wallet]);

  const remainingTickets = Math.max(0, metadata.maxTickets - round.soldTickets);
  const parsedTicketQuantity = Number(ticketQuantity);
  const purchaseTotal = Number.isInteger(parsedTicketQuantity) && parsedTicketQuantity > 0
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
        refund: formatKas(registryMarkerRefundAmount),
        refundFee: formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI)
      })
    : t(usesDefaultRegistry ? "cost.create.retained" : "cost.create.custom", {
        carrier: formatKas(createCarrierAmount),
        createFee: formatKas(COVENANT_CREATE_FEE_SOMPI),
        marker: formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI)
      });
  const buyCostTooltip = t("cost.buy", { price: formatKas(purchaseTotal), fee: formatKas(COVENANT_BUY_FEE_SOMPI) });
  const payoutCostTooltip = t("cost.payout", { prize: formatKas(round.potAmount), fee: formatKas(covenantFinalizeFeeSompi(round.contractVersion)) });
  const refundCostTooltip = t("cost.refund", { refund: formatKas(round.potAmount), fee: formatKas(covenantRefundFeeSompi(round.contractVersion)) });
  const refundAfterDaaScore = BigInt(metadata.covenant?.refundAfterDaaScore || metadata.refundAfterDaaScore || "0");
  const refundAvailable = Boolean(metadata.covenant) && refundAfterDaaScore > 0n && virtualDaaScore >= refundAfterDaaScore;
  const participantFinalizeEnabled = isParticipantFinalizeContractVersion(metadata.contractVersion);
  const walletIsParticipant = Boolean(
    wallet && metadata.covenant?.ticketOwnerPubkeys.includes(pubkeyHexFromAddress(wallet.address))
  );
  const drawTimeReached = round.soldTickets >= round.maxTickets || refundAvailable;
  const soldPercent = metadata.maxTickets > 0
    ? Math.min(100, (round.soldTickets / metadata.maxTickets) * 100)
    : 0;
  const ticketBatches = useMemo(() => {
    const batches = new Map<string, { txId: string; start: number; end: number; owner: string; count: number; amount: bigint }>();

    for (const ticket of [...tickets].sort((left, right) => left.ticketId - right.ticketId)) {
      const key = ticket.ticketTxId || `ticket-${ticket.ticketId}`;
      const existing = batches.get(key);

      if (existing) {
        existing.end = ticket.ticketId;
        existing.count += 1;
        existing.amount += ticket.paidAmount;
      } else {
        batches.set(key, {
          txId: ticket.ticketTxId,
          start: ticket.ticketId,
          end: ticket.ticketId,
          owner: ticket.owner,
          count: 1,
          amount: ticket.paidAmount
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

      if (existing) {
        existing.end = ticket.ticketId;
        existing.count += 1;
        existing.amount += ticket.paidAmount;
      } else {
        batches.set(ticket.txId, {
          txId: ticket.txId,
          start: ticket.ticketId,
          end: ticket.ticketId,
          owner: ticket.buyer,
          count: 1,
          amount: ticket.paidAmount
        });
      }
    }

    return [...batches.values()];
  }, [selectedHistoryRound]);

  const verification = useMemo(() => verifyRaffleState({ round, tickets, finalized }), [finalized, round, tickets]);

  function persistNetworkEndpoints(next: NetworkEndpoints) {
    setNetworkEndpoints(next);
    localStorage.setItem(NETWORK_ENDPOINTS_STORAGE_KEY, JSON.stringify(next));
  }

  function handleRpcUrlInput(value: string) {
    setRpcUrl(value);
    persistNetworkEndpoints({ ...networkEndpoints, [networkId]: value });
  }

  function openNetworkSettings(profileId: SupportedNetworkId) {
    setNetworkSettingsId(profileId);
    setNetworkEndpointDraft(networkEndpoints[profileId]);
    setRpcError("");
  }

  function saveNetworkSettings() {
    if (!networkSettingsId) {
      return;
    }

    try {
      const endpoint = validateRpcUrl(networkEndpointDraft);
      const next = { ...networkEndpoints, [networkSettingsId]: endpoint };
      persistNetworkEndpoints(next);

      if (networkSettingsId === networkId) {
        setRpcUrl(endpoint);
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
    setRpcUrl(networkEndpoints[nextNetwork]);
    setHistoryApiBase(nextProfile.historyApiBase);
    setHistoryAddress("");
    setRegistryAddress("");
    setRegistryAutoRefund(false);
    setCreateRegistryAddress("");
    setHistoryRounds([]);
    setSelectedHistoryRoundId("");
    setMetadata(createEmptyMetadata(nextNetwork));
    setTickets([]);
    setFinalized(undefined);
    setOraclePrivateKey("");
    setOracleSeed("");
    setOracleSignature("");
    setBuyerSecret("");
    setChainError("");
    setChainMessage("");
    setRpcError("");
    setWalletError("");
    setMetadataError("");
    setMetadataMessage("");
    setHistoryError("");
    setHistoryMessage("");
    setRoundSourceTab("create");
    setRoundActionTab("buy");
    setNetworkSettingsId(null);
    setIsNetworkMenuOpen(false);
  }

  async function handleConnect() {
    setRpcError("");

    try {
      await disconnectBrowserRpc(rpcConnectionRef.current);
      const endpoint = validateRpcUrl(rpcUrl);
      const connection = await connectBrowserRpc(endpoint, networkId);
      const connectedNetwork = normalizeNetworkId(connection.status.network);

      if (connectedNetwork !== networkId) {
        await disconnectBrowserRpc(connection);
        throw new Error(`The node reports ${connection.status.network}, but ${networkLabel(selectedNetwork.id)} is selected.`);
      }

      rpcConnectionRef.current = connection;
      setNodeStatus({ ...connection.status, network: connectedNetwork });
      handleRpcUrlInput(endpoint);

      setMetadata((current) => (
        current.createTxId || current.covenant
          ? current
          : { ...current, network: connectedNetwork }
      ));

      if (wallet) {
        const balanceSompi = await getAddressBalanceSompi(connection, wallet.address);
        setWallet(withWalletBalance({ ...wallet, network: connectedNetwork }, balanceSompi));
      }
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : "Unable to connect to node.");
      setNodeStatus((current) => ({ ...current, connected: false }));
    }
  }

  async function handleDisconnect() {
    await disconnectBrowserRpc(rpcConnectionRef.current);
    rpcConnectionRef.current = null;
    setNodeStatus({ connected: false, network: "unknown", syncStatus: "unknown" });
  }

  function handleToggleWalletMenu() {
    setWalletOptions(listWalletAdapters());
    setIsWalletMenuOpen((current) => !current);
    setWalletError("");
  }

  async function handleConnectWallet(adapterId: string) {
    setWalletError("");
    setIsConnectingWallet(true);
    setIsWalletMenuOpen(false);

    try {
      const walletNetwork = rpcConnectionRef.current?.status.network ?? networkId;
      let connectedWallet = await connectBrowserWallet(adapterId, walletNetwork);

      if (rpcConnectionRef.current) {
        const balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current, connectedWallet.address);
        connectedWallet = withWalletBalance(connectedWallet, balanceSompi);
      }

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

  async function prepareOracleForCreate(forceNew = false) {
    const roundId = forceNew || !metadata.roundId ? `round-${randomHex(8)}` : metadata.roundId;
    const canReuseKey =
      !forceNew &&
      /^[0-9a-f]{64}$/.test(oraclePrivateKey) &&
      (!metadata.oraclePublicKey || oraclePublicKeyFromPrivateKey(oraclePrivateKey) === metadata.oraclePublicKey);
    const privateKey = canReuseKey ? oraclePrivateKey : await deriveOpenDevOracleKey(roundId);
    const publicKey = oraclePublicKeyFromPrivateKey(privateKey);

    setOraclePrivateKey(privateKey);
    rememberDevOracleKey(roundId, publicKey, privateKey);

    if (forceNew || !metadata.roundId || !metadata.oraclePublicKey) {
      setTickets([]);
      setFinalized(undefined);
      setOracleSeed("");
      setOracleSignature("");
      setMetadata((current) => ({
        ...current,
        roundId,
        createTxId: "",
        creatorCommitment: "",
        oraclePublicKey: publicKey,
        treasuryAddress: "",
        covenant: undefined
      }));
    }

    return { privateKey, publicKey, roundId };
  }

  function handleOraclePrivateKeyInput(value: string) {
    const normalizedPrivateKey = value.trim().toLowerCase();
    setOraclePrivateKey(normalizedPrivateKey);
    setChainMessage("");

    if (!normalizedPrivateKey) {
      setChainError("");
      return;
    }

    if (!/^[0-9a-f]{64}$/.test(normalizedPrivateKey)) {
      setChainError("Oracle private key must be 32 bytes of hex.");
      return;
    }

    const publicKey = oraclePublicKeyFromPrivateKey(normalizedPrivateKey);
    setMetadata((current) => ({ ...current, oraclePublicKey: current.covenant ? current.oraclePublicKey : publicKey }));
    setChainError("");
    setChainMessage("Oracle key ready for dev attestation.");
  }

  function applyMetadata(nextMetadata: RaffleMetadata, message: string) {
    const profile = requireNetworkProfile(nextMetadata.network);
    const normalizedMetadata = { ...nextMetadata, network: profile.id };
    const restoredOraclePrivateKey = restoreDevOracleKey(normalizedMetadata.roundId, normalizedMetadata.oraclePublicKey);
    const loadedRefundTimeoutSeconds = refundTimeoutSecondsFromMetadata(normalizedMetadata);

    setMetadata(normalizedMetadata);
    setRefundTimeoutParts(refundTimeoutPartsFromSeconds(loadedRefundTimeoutSeconds));
    setNetworkId(profile.id);
    setRpcUrl(networkEndpoints[profile.id]);
    setHistoryApiBase(profile.historyApiBase);
    setCreateRegistryAddress(normalizedMetadata.registryAddress ?? "");
    setHistoryAddress(normalizedMetadata.registryAddress ?? "");
    setTickets([]);
    setFinalized(undefined);
    setOraclePrivateKey(restoredOraclePrivateKey);
    setOracleSeed("");
    setOracleSignature("");
    setBuyerSecret("");
    setChainError("");
    setChainMessage("");
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
    const sharedRound = new URLSearchParams(window.location.search).get("round");

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

  async function handleCreateCovenantRound() {
    setChainError("");
    setChainMessage("");

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

      if (metadata.maxTickets > 1000) {
        throw new Error("This covenant supports at most 1000 tickets per round.");
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

      const createdAtDaaScore = await currentVirtualDaaScore(rpcConnectionRef.current);
      const refundAfterDaaScore = createdAtDaaScore + refundDelayDaa;
      const creatorPubkey = pubkeyHexFromAddress(wallet.address);
      const prepared = await prepareOracleForCreate(Boolean(metadata.covenant));
      const creationRound: RoundState = {
        ...round,
        roundId: prepared.roundId,
        creator: wallet.address,
        creatorPubkey,
        soldTickets: 0,
        potAmount: 0n,
        status: "Open",
        ticketRoot: "",
        soldBatches: 0,
        ticketBatchEnds: [],
        oraclePublicKey: prepared.publicKey,
        refundAfterDaaScore: refundAfterDaaScore.toString(),
        ticketOwnerPubkeys: []
      };
      const payload = encodePayload({
        app: "kaspa-raffle-static",
        type: "round-create",
        version: metadata.version,
        roundId: prepared.roundId,
        creator: wallet.address,
        ticketPrice: metadata.ticketPrice,
        maxTickets: metadata.maxTickets,
        minTickets: metadata.minTickets,
        creatorPubkey,
        oraclePublicKey: prepared.publicKey,
        createdAtDaaScore: createdAtDaaScore.toString(),
        refundAfterDaaScore: refundAfterDaaScore.toString(),
        refundTimeoutSeconds: refundDelaySeconds.toString(),
        refundTimeoutDaa: refundDelayDaa.toString(),
        registryAddress: targetRegistryAddress,
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

      let registryTxIds: string[] = [];
      let registryRefundTxId = "";
      let registryPaymentFeeSompi = 0n;
      let registryWarning = "";

      try {
        const registryResult = await sendKaspaPayment({
          connection: rpcConnectionRef.current,
          wallet,
          toAddress: targetRegistryAddress,
          amountSompi: DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI,
          payload: encodePayload({
            app: "kaspa-raffle-static",
            type: "round-register",
            version: metadata.version,
            roundId: prepared.roundId,
            createTxId: result.txId,
            treasuryAddress: result.covenant.address,
            covenantId: result.covenant.covenantId,
            creator: wallet.address,
            ticketPrice: metadata.ticketPrice,
            maxTickets: metadata.maxTickets,
            minTickets: metadata.minTickets,
            creatorPubkey,
            oraclePublicKey: prepared.publicKey,
            createdAtDaaScore: createdAtDaaScore.toString(),
            refundAfterDaaScore: refundAfterDaaScore.toString(),
            refundTimeoutSeconds: refundDelaySeconds.toString(),
            refundTimeoutDaa: refundDelayDaa.toString(),
            registryAddress: targetRegistryAddress,
            contractVersion: metadata.contractVersion,
            registeredAt: new Date().toISOString()
          })
        });
        registryTxIds = registryResult.txIds;
        registryPaymentFeeSompi = registryResult.feeSompi;

        const markerTxId = registryTxIds[registryTxIds.length - 1];

        if (markerTxId && autoRefundRegistryMarker) {
          try {
            registryRefundTxId = await refundRaffleRegistryMarker({
              connection: rpcConnectionRef.current,
              registryAddress: targetRegistryAddress,
              markerTxId,
              refundAddress: wallet.address
            });
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
        roundId: prepared.roundId,
        creatorCommitment: "",
        oraclePublicKey: prepared.publicKey,
        createTxId: result.txId,
        creatorAddress: wallet.address,
        creatorPubkey,
        createdAtDaaScore: createdAtDaaScore.toString(),
        refundTimeoutSeconds: refundDelaySeconds.toString(),
        refundAfterDaaScore: refundAfterDaaScore.toString(),
        treasuryAddress: result.covenant?.address ?? current.treasuryAddress,
        registryAddress: targetRegistryAddress,
        covenant: result.covenant
      }));
      setTickets([]);
      setFinalized(undefined);
      setRoundActionTab("buy");
      setHistoryAddress(targetRegistryAddress);
      const registryResultMessage = registryTxIds.length
        ? autoRefundRegistryMarker
          ? `Registry marker sent ${formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI)} to ${targetRegistryAddress}; payment fee ${formatKas(registryPaymentFeeSompi)}. ${registryRefundTxId ? `${formatKas(registryMarkerRefundAmount)} returned after the ${formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI)} refund fee: ${registryRefundTxId}.` : "Automatic marker refund is pending or failed."}`
          : `Registry marker sent ${formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI)} to ${targetRegistryAddress}; payment fee ${formatKas(registryPaymentFeeSompi)}. Custom registry markers are not automatically refunded.`
        : "Registry marker was not submitted.";
      setChainMessage(`Covenant round created: ${result.txId}. ${registryResultMessage}`);
      setChainError(registryWarning);
    } catch (error) {
      setChainError(errorMessage(error, "Unable to create covenant round."));
    } finally {
      isCreatingRoundRef.current = false;
      setIsCreatingRound(false);
    }
  }

  async function handleBuyTicket() {
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

      if (!metadata.roundId || !metadata.oraclePublicKey) {
        throw new Error("Create or join an oracle-backed round before buying tickets.");
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

      if (covenant.soldTickets >= metadata.maxTickets) {
        throw new Error("This round has reached its max ticket count.");
      }

      const quantity = Number(ticketQuantity);

      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new Error("Ticket quantity must be a positive integer.");
      }

      if (quantity > metadata.maxTickets - covenant.soldTickets) {
        throw new Error("Ticket quantity exceeds the remaining tickets.");
      }

      if ((covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length) >= 20) {
        throw new Error("This round has reached its maximum of 20 purchase batches.");
      }

      const paidAmount = BigInt(metadata.ticketPrice || "0");
      const purchaseAmount = paidAmount * BigInt(quantity);

      if (paidAmount <= 0n) {
        throw new Error("Ticket price must be greater than zero.");
      }

      const ticketId = covenant.soldTickets + 1;
      const secret = randomHex(32);
      const buyerCommitment = await sha256Hex(secret);
      const ownerPubkey = pubkeyHexFromAddress(wallet.address);
      const nextTicket: TicketState = {
        appId: "KASPA_RAFFLE_TICKET_V1",
        roundId: metadata.roundId,
        ticketId,
        owner: wallet.address,
        ownerPubkey,
        paidAmount,
        buyerCommitment,
        ticketTxId: ""
      };
      const payload = {
        app: "kaspa-raffle-static",
        type: "ticket",
        version: metadata.version,
        roundId: metadata.roundId,
        ticketId,
        buyer: wallet.address,
        buyerPubkey: ownerPubkey,
        buyerCommitment,
        ticketCount: quantity,
        paidAmount: purchaseAmount.toString(),
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
          creatorPubkey: covenant.creatorPubkey,
          refundAfterDaaScore: covenant.refundAfterDaaScore,
          soldBatches: covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length,
          ticketBatchEnds: covenant.ticketBatchEnds ?? covenant.ticketOwnerPubkeys.map((_, index) => index + 1),
          ticketOwnerPubkeys: covenant.ticketOwnerPubkeys
        },
        covenant,
        ticket: nextTicket,
        ticketCount: quantity,
        payload: encodePayload(payload)
      });

      if (!payment.covenant) {
        throw new Error("Ticket transaction did not return the next covenant cursor.");
      }

      const txId = payment.txId;
      await new Promise((resolve) => window.setTimeout(resolve, 4_000));
      const balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current, wallet.address);

      setBuyerSecret(secret);
      setWallet(withWalletBalance(wallet, balanceSompi));
      setMetadata((current) => ({
        ...current,
        covenant: payment.covenant,
        treasuryAddress: payment.covenant?.address ?? current.treasuryAddress
      }));
      setTickets((current) => [
        ...current,
        ...Array.from({ length: quantity }, (_, offset) => ({
          ...nextTicket,
          ticketId: ticketId + offset,
          ticketTxId: txId
        }))
      ]);
      setTicketQuantity("1");
      setChainMessage(
        quantity === 1
          ? `Ticket #${ticketId} submitted: ${txId}`
          : `Tickets #${ticketId}-${ticketId + quantity - 1} submitted: ${txId}`
      );
    } catch (error) {
      setChainError(errorMessage(error, "Unable to buy ticket."));
    } finally {
      isBuyingRef.current = false;
      setIsBuying(false);
    }
  }

  async function handleFinalizeLocal() {
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

      if (!isParticipantFinalizeContractVersion(metadata.contractVersion)) {
        throw new Error("This legacy round does not enforce participant-only drawing. Refund it after timeout or create a new round.");
      }

      if (!wallet) {
        throw new Error("Connect a participant wallet before drawing this round.");
      }

      if (!covenant.ticketOwnerPubkeys.includes(pubkeyHexFromAddress(wallet.address))) {
        throw new Error("Only a wallet that bought tickets in this round can draw and pay the winner.");
      }

      if (covenant.status !== "Open" && covenant.status !== "Closed") {
        throw new Error("This round is no longer available to finalize.");
      }

      if (!rpcConnectionRef.current) {
        throw new Error("Connect to a Kaspa wRPC node first.");
      }

      if (covenant.soldTickets < metadata.minTickets) {
        throw new Error("Not enough tickets to finalize this round.");
      }

      if (covenant.soldTickets < metadata.maxTickets) {
        const currentDaaScore = await currentVirtualDaaScore(rpcConnectionRef.current);
        const finalizeAfterDaaScore = BigInt(covenant.refundAfterDaaScore || "0");

        if (currentDaaScore < finalizeAfterDaaScore) {
          const remainingSeconds = (finalizeAfterDaaScore - currentDaaScore + KASPA_DAA_PER_SECOND - 1n) / KASPA_DAA_PER_SECOND;
          throw new Error(
            `Round can finalize when sold out or in about ${formatDurationSeconds(remainingSeconds, language)}.`
          );
        }
      }

      if (tickets.length < covenant.soldTickets) {
        throw new Error("All ticket details must be loaded before finalize so the winner address can be verified.");
      }

      const ticketRoot = await replayTicketRoot(metadata.roundId, tickets, covenant.soldTickets, metadata.contractVersion);

      if (ticketRoot !== covenant.ticketRoot) {
        throw new Error("Loaded ticket details do not match the covenant ticket root. Reload the correct round metadata before finalizing.");
      }

      const closedRound: RoundState = {
        ...round,
        soldTickets: covenant.soldTickets,
        potAmount: BigInt(covenant.potAmount),
        status: "Closed",
        ticketRoot: covenant.ticketRoot,
        creatorPubkey: covenant.creatorPubkey,
        refundAfterDaaScore: covenant.refundAfterDaaScore,
        soldBatches: covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length,
        ticketBatchEnds: covenant.ticketBatchEnds ?? covenant.ticketOwnerPubkeys.map((_, index) => index + 1),
        ticketOwnerPubkeys: covenant.ticketOwnerPubkeys
      };

      if (closedRound.potAmount <= 0n) {
        throw new Error("Prize amount must be greater than zero.");
      }

      let finalizeOracleSeed = oracleSeed;
      let finalizeOracleSignature = oracleSignature;
      let signingOracleKey = oraclePrivateKey;
      let hasMatchingLocalOracleKey =
        /^[0-9a-f]{64}$/.test(signingOracleKey) &&
        oraclePublicKeyFromPrivateKey(signingOracleKey) === metadata.oraclePublicKey;

      if (!hasMatchingLocalOracleKey) {
        signingOracleKey = await recoverDevOracleKey(metadata.roundId, metadata.oraclePublicKey);
        hasMatchingLocalOracleKey = Boolean(signingOracleKey);

        if (signingOracleKey) {
          setOraclePrivateKey(signingOracleKey);
        }
      }

      if (hasMatchingLocalOracleKey) {
        finalizeOracleSeed = randomHex(32);
        finalizeOracleSignature = await signOracleSeed(signingOracleKey, finalizeOracleSeed);
        setOracleSeed(finalizeOracleSeed);
        setOracleSignature(finalizeOracleSignature);
      } else if (!finalizeOracleSeed || !finalizeOracleSignature) {
        throw new Error("This legacy round uses a creator-only oracle key. Finalize it in the creator browser, provide an external attestation, or refund it after timeout.");
      }

      const randomSeed = await buildFinalizeSeedHex(closedRound, finalizeOracleSeed);
      const winnerIndex = raffleWinnerIndexFromSeed(randomSeed, covenant.soldTickets);
      const winner = tickets[winnerIndex];

      if (!winner) {
        throw new Error("Winner ticket details are not loaded in this browser yet.");
      }

      const nextFinalized: FinalizeState = finalized ?? {
        appId: "KASPA_RAFFLE_FINAL_V1",
        roundId: metadata.roundId || "pending-round",
        randomSeed,
        oracleSeed: finalizeOracleSeed,
        oracleSignature: finalizeOracleSignature,
        winnerTicketId: winner.ticketId,
        winnerAddress: winner.owner,
        payoutTxId: ""
      };

      if (nextFinalized.payoutTxId) {
        setChainMessage(`Winner #${nextFinalized.winnerTicketId} was paid: ${nextFinalized.payoutTxId}`);
        return;
      }

      const result = await finalizeRaffleCovenantRound({
        connection: rpcConnectionRef.current,
        wallet,
        round: closedRound,
        covenant,
        oracleSeedHex: finalizeOracleSeed,
        oracleSignatureHex: finalizeOracleSignature,
        winner,
        payload: encodePayload({
          app: "kaspa-raffle-static",
          type: "round-finalize",
          version: metadata.version,
          roundId: metadata.roundId,
          winnerTicketId: winner.ticketId,
          winnerAddress: winner.owner,
          amount: closedRound.potAmount.toString(),
          randomSeed,
          oracleSeed: finalizeOracleSeed,
          oracleSignature: finalizeOracleSignature,
          finalizedAt: new Date().toISOString()
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
      setChainMessage(`Winner #${winner.ticketId} was paid: ${result.txId}`);
    } catch (error) {
      setChainError(errorMessage(error, "Unable to finalize covenant round."));
    } finally {
      isFinalizingRef.current = false;
      setIsFinalizing(false);
    }
  }

  async function handleRefundTimedOutRound() {
    setChainError("");
    setChainMessage("");

    if (isRefundingRoundRef.current) {
      return;
    }

    isRefundingRoundRef.current = true;
    setIsRefundingRound(true);

    try {
      assertRaffleCovenantReady();

      if (!rpcConnectionRef.current) {
        throw new Error("Connect to a Kaspa wRPC node first.");
      }

      if (finalized?.payoutTxId || metadata.covenant?.status === "Finalized") {
        throw new Error("This round is already finalized.");
      }

      const covenant = metadata.covenant;

      if (!covenant) {
        throw new Error("Create or import a covenant round first.");
      }

      if (covenant.soldTickets <= 0) {
        throw new Error("There are no tickets to refund.");
      }

      if (tickets.length < covenant.soldTickets) {
        throw new Error("All ticket details must be loaded before refund.");
      }

      const currentDaaScore = await currentVirtualDaaScore(rpcConnectionRef.current);
      const refundAfterDaaScore = BigInt(covenant.refundAfterDaaScore || "0");

      if (currentDaaScore < refundAfterDaaScore) {
        const remainingDaa = refundAfterDaaScore - currentDaaScore;
        const remainingSeconds = (remainingDaa + KASPA_DAA_PER_SECOND - 1n) / KASPA_DAA_PER_SECOND;

        throw new Error(
          `Refund opens in about ${formatDurationSeconds(remainingSeconds, language)} at DAA ${refundAfterDaaScore.toString()}. Current DAA is ${currentDaaScore.toString()}.`
        );
      }

      const result = await refundRaffleCovenantRound({
        connection: rpcConnectionRef.current,
        round: {
          ...round,
          soldTickets: covenant.soldTickets,
          potAmount: BigInt(covenant.potAmount),
          status: covenant.status,
          ticketRoot: covenant.ticketRoot,
          creatorPubkey: covenant.creatorPubkey,
          refundAfterDaaScore: covenant.refundAfterDaaScore,
          soldBatches: covenant.soldBatches ?? covenant.ticketOwnerPubkeys.length,
          ticketBatchEnds: covenant.ticketBatchEnds ?? covenant.ticketOwnerPubkeys.map((_, index) => index + 1),
          ticketOwnerPubkeys: covenant.ticketOwnerPubkeys
        },
        covenant,
        tickets,
        payload: encodePayload({
          app: "kaspa-raffle-static",
          type: "round-refund",
          version: metadata.version,
          roundId: metadata.roundId,
          soldTickets: covenant.soldTickets,
          amount: covenant.potAmount,
          refundAfterDaaScore: covenant.refundAfterDaaScore,
          refundedAt: new Date().toISOString()
        })
      });

      setMetadata((current) => ({
        ...current,
        covenant: current.covenant
          ? {
              ...current.covenant,
              txId: result.txId,
              status: "Refunded"
            }
          : current.covenant
      }));
      setChainMessage(`Timed-out round refunded: ${result.txId}`);
    } catch (error) {
      setChainError(errorMessage(error, "Unable to refund timed-out round."));
    } finally {
      isRefundingRoundRef.current = false;
      setIsRefundingRound(false);
    }
  }

  async function handleLoadHistory() {
    setHistoryError("");
    setHistoryMessage("");
    setIsLoadingHistory(true);

    try {
      const targetAddress = (historyAddress || registryAddress || metadata.treasuryAddress || "").trim();

      if (!targetAddress) {
        throw new Error("Set a registry address to load history.");
      }

      const rounds = await loadRaffleHistory(historyApiBase, targetAddress);

      setHistoryAddress(targetAddress);
      setHistoryRounds(rounds);
      setSelectedHistoryRoundId(rounds[0]?.roundId ?? "");
      setHistoryMessage(`Loaded ${rounds.length} raffle round${rounds.length === 1 ? "" : "s"}.`);
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
        : historyRound.latestCovenant?.status ?? (historyRound.closeTxId ? "Closed" : "Open");
  }

  function networkFromKaspaAddress(address: string) {
    return networkFromAddress(address) ?? networkId;
  }

  function refundTimeoutSecondsFromHistoryRound(historyRound: RaffleHistoryRound): bigint {
    if (historyRound.refundTimeoutSeconds && /^\d+$/.test(historyRound.refundTimeoutSeconds)) {
      return BigInt(historyRound.refundTimeoutSeconds);
    }

    if (historyRound.refundTimeoutDaa && /^\d+$/.test(historyRound.refundTimeoutDaa)) {
      return BigInt(historyRound.refundTimeoutDaa) / KASPA_DAA_PER_SECOND;
    }

    return DEFAULT_REFUND_TIMEOUT_SECONDS;
  }

  async function handleJoinSelectedHistoryRound() {
    setHistoryError("");
    setHistoryMessage("");
    setChainError("");
    setChainMessage("");

    if (!selectedHistoryRound) {
      setHistoryError("Select a round first.");
      return;
    }

    const covenant = selectedHistoryRound.latestCovenant;

    if (!covenant || (covenant.status !== "Open" && covenant.status !== "Closed")) {
      setHistoryError("Selected round has no active covenant to load.");
      return;
    }

    if (BigInt(covenant.amountSompi) < MIN_COVENANT_CARRIER_SOMPI) {
      setHistoryError(
        `Selected round was created with an old carrier reserve. Recreate it with at least ${formatKas(MIN_COVENANT_CARRIER_SOMPI)}.`
      );
      return;
    }

    if (
      selectedHistoryRound.ticketPrice === undefined ||
      selectedHistoryRound.maxTickets === undefined ||
      selectedHistoryRound.minTickets === undefined ||
      !selectedHistoryRound.oraclePublicKey
    ) {
      setHistoryError("Selected round is missing metadata needed to join.");
      return;
    }

    const loadedNetwork = networkFromKaspaAddress(covenant.address);
    const loadedProfile = requireNetworkProfile(loadedNetwork);
    const restoredOraclePrivateKey = await recoverDevOracleKey(
      selectedHistoryRound.roundId,
      selectedHistoryRound.oraclePublicKey
    );
    const loadedRefundTimeoutSeconds = refundTimeoutSecondsFromHistoryRound(selectedHistoryRound);
    const loadedRegistryAddress = selectedHistoryRound.registryAddress ?? (historyAddress || registryAddress);

    setNetworkId(loadedNetwork);
    setRpcUrl(networkEndpoints[loadedNetwork]);
    setHistoryApiBase(loadedProfile.historyApiBase);
    setCreateRegistryAddress(loadedRegistryAddress);
    setRefundTimeoutParts(refundTimeoutPartsFromSeconds(loadedRefundTimeoutSeconds));
    setMetadata({
      app: "kaspa-raffle-static",
      version: selectedHistoryRound.version ?? emptyMetadata.version,
      network: loadedNetwork,
      roundId: selectedHistoryRound.roundId,
      createTxId: selectedHistoryRound.createTxId ?? "",
      createdAtDaaScore: selectedHistoryRound.createdAtDaaScore,
      refundTimeoutSeconds: loadedRefundTimeoutSeconds.toString(),
      refundTimeoutDaa: selectedHistoryRound.refundTimeoutDaa,
      ticketPrice: selectedHistoryRound.ticketPrice.toString(),
      maxTickets: selectedHistoryRound.maxTickets,
      minTickets: selectedHistoryRound.minTickets,
      creatorAddress: selectedHistoryRound.creator ?? "",
      creatorPubkey: selectedHistoryRound.creatorPubkey ?? covenant.creatorPubkey,
      creatorCommitment: "",
      oraclePublicKey: selectedHistoryRound.oraclePublicKey,
      refundAfterDaaScore: selectedHistoryRound.refundAfterDaaScore ?? covenant.refundAfterDaaScore,
      treasuryAddress: covenant.address,
      registryAddress: loadedRegistryAddress,
      covenant,
      contractVersion: selectedHistoryRound.contractVersion ?? emptyMetadata.contractVersion
    });
    setTickets(
      selectedHistoryRound.tickets.map((ticket) => ({
        appId: "KASPA_RAFFLE_TICKET_V1",
        roundId: selectedHistoryRound.roundId,
        ticketId: ticket.ticketId,
        owner: ticket.buyer,
        ownerPubkey: ticket.buyerPubkey,
        paidAmount: ticket.paidAmount,
        buyerCommitment: ticket.buyerCommitment ?? "",
        ticketTxId: ticket.txId
      }))
    );
    setFinalized(undefined);
    setRoundActionTab("buy");
    setOraclePrivateKey(restoredOraclePrivateKey);
    setOracleSeed("");
    setOracleSignature("");
    setBuyerSecret("");
    setMetadataMessage("Round loaded from history.");
    setHistoryMessage(
      restoredOraclePrivateKey
        ? `Loaded ${selectedHistoryRound.roundId}. Oracle key restored; finalize is ready when the round is eligible.`
        : `Loaded ${selectedHistoryRound.roundId}. You can buy if open, or finalize/refund when eligible.`
    );
  }

  function updateMetadata<K extends keyof RaffleMetadata>(key: K, value: RaffleMetadata[K]) {
    setMetadata((current) => ({
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

  async function replayTicketRoot(
    roundId: string,
    loadedTickets: TicketState[],
    soldTickets: number,
    contractVersion: string
  ): Promise<string> {
    const orderedTickets = [...loadedTickets].sort((left, right) => left.ticketId - right.ticketId);
    let root = "";

    if (contractVersion.startsWith("raffle-v3")) {
      const batches = orderedTickets.filter(
        (ticket, index) => index === 0 || ticket.ticketTxId !== orderedTickets[index - 1]?.ticketTxId
      );

      for (const batch of batches) {
        const ticketCount = orderedTickets.filter((ticket) => ticket.ticketTxId === batch.ticketTxId).length;
        root = await buildNextTicketRootHex(roundId, root, { ...batch, ticketCount });
      }

      return root;
    }

    for (let ticketId = 1; ticketId <= soldTickets; ticketId += 1) {
      const ticket = orderedTickets[ticketId - 1];

      if (!ticket || ticket.ticketId !== ticketId) {
        throw new Error(`Ticket #${ticketId} is missing from the loaded round state.`);
      }

      root = await buildNextTicketRootHex(roundId, root, ticket);
    }

    return root;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="kicker">Kaspa Toccata · {networkLabel(selectedNetwork.id)}</p>
          <h1>{t("app.title")}</h1>
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
          <div className="header-status">
            <span className={nodeStatus.connected ? "status-pill connected" : "status-pill"}>
              {nodeStatus.connected ? <CheckCircle2 size={17} /> : <Plug size={17} />}
              {nodeStatus.connected ? t("node.ready") : t("node.offline")}
            </span>
            <span className="balance-pill">{wallet ? formatKas(wallet.balanceSompi) : t("wallet.notLoaded")}</span>
          </div>
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

      <section className="setup-strip" aria-label={t("connection.aria")}>
        <div className="network-picker">
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
            </span>
            <ChevronDown size={17} />
          </button>

          {isNetworkMenuOpen ? (
            <div className="network-menu" role="menu" aria-label={t("network.switch")}>
              <div className="network-menu-title">{t("network.switch")}</div>
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
                        <small>{networkEndpoints[profile.id]}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="network-settings-button"
                      onClick={() => openNetworkSettings(profile.id)}
                      title={t("network.configure", { network: networkLabel(profile.id) })}
                      aria-label={t("network.configure", { network: networkLabel(profile.id) })}
                    >
                      <Settings size={18} />
                    </button>
                    {editing ? (
                      <div className="network-endpoint-editor">
                        <label className="field">
                          <span>{networkLabel(profile.id)} {t("node")}</span>
                          <input
                            value={networkEndpointDraft}
                            onChange={(event) => setNetworkEndpointDraft(event.target.value)}
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

        <div className="setup-primary">
          <label className="field inline-field">
            <span>{t("node")}</span>
            <input value={rpcUrl} onChange={(event) => handleRpcUrlInput(event.target.value)} />
          </label>
          {nodeStatus.connected ? (
            <button type="button" className="secondary" onClick={handleDisconnect}>{t("disconnect")}</button>
          ) : (
            <button type="button" onClick={handleConnect}>{t("connect")}</button>
          )}
        </div>

        <div className="wallet-summary">
          <div>
            <span className="summary-label">{t("wallet")}</span>
            <strong className="mono">{wallet ? shortValue(wallet.address, 10) : t("notLoaded")}</strong>
          </div>
          <div>
            <span className="summary-label">{t("balance")}</span>
            <strong>{wallet ? formatKas(wallet.balanceSompi) : t("unknown")}</strong>
          </div>
          <button type="button" className="icon-button secondary" onClick={handleRefreshBalance} title={t("refreshBalance")} aria-label={t("refreshBalance")}>
            <RefreshCw size={17} />
          </button>
        </div>

        <div className="wallet-actions">
          {wallet ? (
            <button type="button" className="secondary" onClick={handleDisconnectWallet}>{t("disconnectWallet", { wallet: wallet.providerName })}</button>
          ) : (
            <div className="wallet-picker">
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

        {rpcError ? <p className="error-text strip-message">{rt(rpcError)}</p> : null}
        {walletError ? <p className="error-text strip-message">{rt(walletError)}</p> : null}
      </section>

      <section className="round-overview">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">{t("currentRound")}</p>
            <h2>{metadata.roundId ? shortValue(metadata.roundId, 12) : t("noRound")}</h2>
          </div>
          <div className="heading-actions">
            <span className={`round-status status-${round.status.toLowerCase()}`}>{t(`status.${round.status}`)}</span>
            {metadata.roundId ? (
              <button type="button" className="icon-button secondary" onClick={handleCopyRoundLink} title={t("copyRoundLink")} aria-label={t("copyRoundLink")}>
                <Link2 size={17} />
              </button>
            ) : null}
          </div>
        </div>

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
            <strong>{refundTimeoutDisplay}</strong>
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
                  <strong>#{batch.start}{batch.end > batch.start ? `-${batch.end}` : ""}</strong>
                  <span>{t(batch.count === 1 ? "ticketCount.one" : "ticketCount", { count: batch.count.toLocaleString() })}</span>
                  <span className="mono">{shortValue(batch.owner, 9)}</span>
                  <span>{formatKas(batch.amount)}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <section className="tabbed-workspace source-workspace">
        <div className="workspace-tabs" role="tablist" aria-label={t("roundSourceTabs")}>
          <button
            type="button"
            id="round-create-tab"
            className={`workspace-tab ${roundSourceTab === "create" ? "active" : ""}`}
            role="tab"
            aria-selected={roundSourceTab === "create"}
            aria-controls="round-create-panel"
            onClick={() => setRoundSourceTab("create")}
          >
            {t("createRound")}
          </button>
          <button
            type="button"
            id="round-history-tab"
            className={`workspace-tab ${roundSourceTab === "history" ? "active" : ""}`}
            role="tab"
            aria-selected={roundSourceTab === "history"}
            aria-controls="round-history-panel"
            onClick={() => setRoundSourceTab("history")}
          >
            {t("loadHistory")}
          </button>
        </div>

        {roundSourceTab === "create" ? (
          <section id="round-create-panel" className="workspace-panel" role="tabpanel" aria-labelledby="round-create-tab">
            {canStartNewRound ? (
              <>
<div className="pane-heading">
                <p className="eyebrow">{t("organizer")}</p>
                <h2>{finalized ? t("createNextRound") : t("createARound")}</h2>
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>{t("ticketPriceKas")}</span>
                  <input
                    inputMode="decimal"
                    value={sompiToKasInput(metadata.ticketPrice)}
                    onChange={(event) => updateMetadata("ticketPrice", kasInputToSompi(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>{t("totalTickets")}</span>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={metadata.maxTickets}
                    onChange={(event) => updateMetadata("maxTickets", Number(event.target.value))}
                  />
                </label>
              </div>

              <section className="registry-config" aria-labelledby="registry-config-title">
                <div className="registry-field-row">
                  <label className="field">
                    <span id="registry-config-title">{t("registryAddress")}</span>
                    <input
                      value={createRegistryAddress}
                      onChange={(event) => setCreateRegistryAddress(event.target.value.trim())}
                      placeholder={networkId === "mainnet" ? "kaspa:..." : "kaspatest:..."}
                      aria-describedby="registry-cost-details"
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button secondary"
                    onClick={() => setCreateRegistryAddress(registryAddress)}
                    disabled={!registryAddress || usesDefaultRegistry}
                    title={t("useDefaultRegistry")}
                    aria-label={t("useDefaultRegistry")}
                  >
                    <RefreshCw size={17} />
                  </button>
                </div>
                <dl id="registry-cost-details" className="registry-cost-details">
                  <div>
                    <dt>{t("sentToRegistry")}</dt>
                    <dd>{formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI)}</dd>
                  </div>
                  <div>
                    <dt>{t("registryPaymentFee")}</dt>
                    <dd>{t("registryPaymentFeeDetail")}</dd>
                  </div>
                  <div>
                    <dt>{t("automaticMarkerRefund")}</dt>
                    <dd>
                      {usesAutoRefundRegistry
                        ? t("registryRefundDefault", { refund: formatKas(registryMarkerRefundAmount), fee: formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI) })
                        : t(usesDefaultRegistry ? "registryRefundRetained" : "registryRefundCustom", { amount: formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI) })}
                    </dd>
                  </div>
                </dl>
                <p className="registry-note">
                  {usesDefaultRegistry
                    ? t(usesAutoRefundRegistry ? "registryDefaultNote" : "registryRetainedNote")
                    : t("registryCustomNote")}
                </p>
              </section>

              <details className="disclosure compact-disclosure">
                <summary>{t("drawRefundTimeout", { duration: refundTimeoutDisplay })}</summary>
                <div className="duration-grid disclosure-body">
                  {REFUND_TIMEOUT_FIELDS.map((field) => (
                    <label className="field compact-field" key={field.key}>
                      <span>{t(field.labelKey)}</span>
                      <input
                        inputMode="numeric"
                        min={0}
                        type="number"
                        value={refundTimeoutParts[field.key]}
                        onChange={(event) => updateRefundTimeoutPart(field.key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </details>

              <button
                type="button"
                className="wide kas-cost-button"
                data-cost={createCostTooltip}
                onClick={handleCreateCovenantRound}
                disabled={isCreatingRound || !canStartNewRound}
              >
                {isCreatingRound ? t("creatingRound") : finalized ? t("createNextRound") : t("createRound")}
              </button>
              </>
            ) : (
              <div className="workspace-empty">
                <p className="eyebrow">{t("organizer")}</p>
                <h2>{t("roundInProgress")}</h2>
                <p>{t("roundInProgressDetail")}</p>
              </div>
            )}
          </section>
        ) : (
      <section id="round-history-panel" className="history-section history-tab-panel" role="tabpanel" aria-labelledby="round-history-tab raffle-history-title">
        <div className="section-heading-row">
          <div className="history-title-block">
            <p className="eyebrow">{t("onChainActivity")}</p>
            <h2 id="raffle-history-title">{t("raffleHistory")}</h2>
            <p className="history-summary" aria-live="polite">
              {historyRounds.length
                ? t("historySummary", {
                    rounds: historyRounds.length.toLocaleString(),
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
            <label className="field history-select">
              <span>{t("round")}</span>
              <select
                value={selectedHistoryRound?.roundId ?? ""}
                onChange={(event) => setSelectedHistoryRoundId(event.target.value)}
              >
                {historyRounds.map((historyRound) => (
                  <option key={historyRound.roundId} value={historyRound.roundId}>
                    {historyRound.roundId} - {t(`status.${historyRoundStatus(historyRound)}`)} - {t(historyRound.tickets.length === 1 ? "ticketCount.one" : "ticketCount", { count: historyRound.tickets.length.toLocaleString() })}
                  </option>
                ))}
              </select>
            </label>

            {selectedHistoryRound ? (
              <div className="history-detail">
                <div className="key-metrics history-metrics">
                  <div><span>{t("status")}</span><strong>{t(`status.${historyRoundStatus(selectedHistoryRound)}`)}</strong></div>
                  <div><span>{t("tickets")}</span><strong>{selectedHistoryRound.tickets.length.toLocaleString()}</strong></div>
                  <div><span>{t("pot")}</span><strong>{formatKas(selectedHistoryRound.potAmount)}</strong></div>
                  <div>
                    <span>{t("winner")}</span>
                    <strong>{selectedHistoryRound.payouts[0] ? `#${selectedHistoryRound.payouts[0].winnerTicketId}` : t("pending")}</strong>
                  </div>
                </div>

                {selectedHistoryRound.latestCovenant ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleJoinSelectedHistoryRound}
                    disabled={
                      selectedHistoryRound.latestCovenant.status === "Refunding" ||
                      selectedHistoryRound.latestCovenant.status === "Refunded"
                    }
                  >
                    {t("loadThisRound")}
                  </button>
                ) : null}

                <details className="disclosure compact-disclosure">
                  <summary>{t(selectedHistoryBatches.length === 1 ? "purchaseBatch.one" : "purchaseBatch", { count: selectedHistoryBatches.length.toLocaleString() })}</summary>
                  <div className="batch-list">
                    {selectedHistoryBatches.map((batch) => (
                      <div className="batch-row" key={batch.txId}>
                        <strong>#{batch.start}{batch.end > batch.start ? `-${batch.end}` : ""}</strong>
                        <span>{t(batch.count === 1 ? "ticketCount.one" : "ticketCount", { count: batch.count.toLocaleString() })}</span>
                        <span className="mono">{shortValue(batch.owner, 9)}</span>
                        <span>{formatKas(batch.amount)}</span>
                      </div>
                    ))}
                  </div>
                </details>

                <details className="disclosure compact-disclosure">
                  <summary>{t("transactionsTiming")}</summary>
                  <dl className="stat-list dense disclosure-body">
                    <div><dt>{t("registryTx")}</dt><dd className="mono">{selectedHistoryRound.registryTxId ?? t("unknown")}</dd></div>
                    <div><dt>{t("covenant")}</dt><dd className="mono">{selectedHistoryRound.latestCovenant?.address ?? selectedHistoryRound.treasuryAddress ?? t("unknown")}</dd></div>
                    <div><dt>{t("refundTx")}</dt><dd className="mono">{selectedHistoryRound.refundTxId ?? t("pending")}</dd></div>
                    <div><dt>{t("refundAfterDaa")}</dt><dd className="mono">{selectedHistoryRound.latestCovenant?.refundAfterDaaScore ?? selectedHistoryRound.refundAfterDaaScore ?? t("unknown")}</dd></div>
                    <div><dt>{t("lastSeen")}</dt><dd>{formatDate(selectedHistoryRound.lastBlockTime, language)}</dd></div>
                    {selectedHistoryRound.payouts[0] ? (
                      <div><dt>{t("payoutTx")}</dt><dd className="mono">{selectedHistoryRound.payouts[0].txId}</dd></div>
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
              <span>{t("registryAddress")}</span>
              <input
                value={historyAddress || metadata.registryAddress || registryAddress || metadata.treasuryAddress || ""}
                onChange={(event) => setHistoryAddress(event.target.value)}
                placeholder={networkId === "mainnet" ? "kaspa:..." : "kaspatest:..."}
              />
            </label>
          </div>
        </details>
      </section>
        )}
      </section>

      <section className="tabbed-workspace action-workspace">
        <div className="workspace-tabs" role="tablist" aria-label={t("actionTabs")}>
          <button
            type="button"
            id="round-buy-tab"
            className={`workspace-tab ${roundActionTab === "buy" ? "active" : ""}`}
            role="tab"
            aria-selected={roundActionTab === "buy"}
            aria-controls="round-buy-panel"
            onClick={() => setRoundActionTab("buy")}
          >
            {t("buyTickets")}
          </button>
          <button
            type="button"
            id="round-payout-tab"
            className={`workspace-tab ${roundActionTab === "payout" ? "active" : ""}`}
            role="tab"
            aria-selected={roundActionTab === "payout"}
            aria-controls="round-payout-panel"
            onClick={() => setRoundActionTab("payout")}
          >
            {t("drawPay")}
          </button>
        </div>

        {roundActionTab === "buy" ? (
          <section id="round-buy-panel" className="workspace-panel action-pane" role="tabpanel" aria-labelledby="round-buy-tab">
            {metadata.covenant && !finalized ? (
              <>
<div className="pane-heading">
                <p className="eyebrow">{t("participant")}</p>
                <h2>{t("buyTickets")}</h2>
              </div>
              <div className="purchase-form">
                <label className="field quantity-field">
                  <span>{t("quantity")}</span>
                  <input
                    type="number"
                    min={1}
                    max={remainingTickets}
                    value={ticketQuantity}
                    onChange={(event) => setTicketQuantity(event.target.value)}
                  />
                </label>
                <div className="segmented-control" aria-label={t("quantityPresets")}>
                  {[1, 10].map((quantity) => (
                    <button
                      type="button"
                      className={parsedTicketQuantity === quantity ? "active" : ""}
                      disabled={remainingTickets < quantity}
                      key={quantity}
                      onClick={() => setTicketQuantity(String(quantity))}
                    >
                      {quantity}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={parsedTicketQuantity === remainingTickets ? "active" : ""}
                    disabled={remainingTickets < 1}
                    onClick={() => setTicketQuantity(String(remainingTickets))}
                  >
                    {t("max")}
                  </button>
                </div>
              </div>
              <dl className="purchase-summary">
                <div><dt>{t("total")}</dt><dd>{formatKas(purchaseTotal)}</dd></div>
                <div><dt>{t("remaining")}</dt><dd>{remainingTickets.toLocaleString()}</dd></div>
                <div><dt>{t("purchaseBatches")}</dt><dd>{(metadata.covenant?.soldBatches ?? metadata.covenant?.ticketOwnerPubkeys.length ?? 0)} / 20</dd></div>
              </dl>
              <button
                type="button"
                className="wide kas-cost-button"
                data-cost={buyCostTooltip}
                onClick={handleBuyTicket}
                disabled={isBuying || Boolean(finalized) || remainingTickets <= 0}
              >
                {isBuying
                  ? t("buyingTickets")
                  : t(parsedTicketQuantity === 1 ? "buyTicketButton.one" : "buyTicketButton", {
                      count: Number.isInteger(parsedTicketQuantity) && parsedTicketQuantity > 0 ? parsedTicketQuantity.toLocaleString() : ""
                    })}
              </button>
              </>
            ) : (
              <div className="workspace-empty">
                <p className="eyebrow">{t("participant")}</p>
                <h2>{t("buyTickets")}</h2>
                <p>{t("buyRoundFirst")}</p>
              </div>
            )}
          </section>
        ) : (
<section id="round-payout-panel" className="workspace-panel action-pane" role="tabpanel" aria-labelledby="round-payout-tab">
          <div className="pane-heading">
            <p className="eyebrow">{t("covenantAction")}</p>
            <h2>{t("drawPayout")}</h2>
          </div>

          {finalized ? (
            <div className="winner-block">
              <span>{t("winner")}</span>
              <strong>{t("winnerTicket", { ticket: finalized.winnerTicketId })}</strong>
              <p className="mono">{finalized.winnerAddress}</p>
              <p>{t("paidInTransaction", { tx: shortValue(finalized.payoutTxId, 10) })}</p>
            </div>
          ) : (
            <>
              <p className="pane-copy">
                {!participantFinalizeEnabled && metadata.covenant
                  ? t("legacyDrawUnsupported")
                  : round.soldTickets >= round.maxTickets
                  ? walletIsParticipant ? t("soldOutCanDraw") : t("soldOutConnectParticipant")
                  : round.soldTickets > 0
                    ? refundAvailable
                      ? walletIsParticipant ? t("timeoutCanDrawOrRefund") : t("timeoutConnectOrRefund")
                      : t("ticketsRemain", { count: remainingTickets.toLocaleString() })
                    : t("buyBeforeDraw")}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="kas-cost-button"
                  data-cost={payoutCostTooltip}
                  onClick={handleFinalizeLocal}
                  disabled={
                    !covenantStatus.enabled ||
                    isFinalizing ||
                    !metadata.covenant ||
                    !participantFinalizeEnabled ||
                    !walletIsParticipant ||
                    !drawTimeReached ||
                    (metadata.covenant.status !== "Open" && metadata.covenant.status !== "Closed") ||
                    metadata.covenant.soldTickets <= 0
                  }
                >
                  {isFinalizing ? t("drawingPaying") : t("drawPay")}
                </button>
                <button
                  type="button"
                  className="secondary kas-cost-button"
                  data-cost={refundCostTooltip}
                  onClick={handleRefundTimedOutRound}
                  disabled={
                    !covenantStatus.enabled ||
                    isRefundingRound ||
                    !metadata.covenant ||
                    metadata.covenant.status === "Finalized" ||
                    metadata.covenant.status === "Refunding" ||
                    metadata.covenant.status === "Refunded" ||
                    metadata.covenant.soldTickets <= 0 ||
                    !refundAvailable
                  }
                >
                  {isRefundingRound ? t("refunding") : t("refundAfterTimeout")}
                </button>
              </div>
            </>
          )}

          <details className="disclosure compact-disclosure">
            <summary>{t("oracleAttestation")}</summary>
            <div className="disclosure-body">
              <label className="field">
                <span>{t("devOraclePrivateKey")}</span>
                <input
                  type="password"
                  value={oraclePrivateKey}
                  onChange={(event) => handleOraclePrivateKeyInput(event.target.value)}
                  placeholder={t("oracleKeyPlaceholder")}
                />
              </label>
              <label className="field">
                <span>{t("externalOracleSeed")}</span>
                <input value={oracleSeed} onChange={(event) => setOracleSeed(event.target.value.trim().toLowerCase())} />
              </label>
              <label className="field">
                <span>{t("externalOracleSignature")}</span>
                <input value={oracleSignature} onChange={(event) => setOracleSignature(event.target.value.trim().toLowerCase())} />
              </label>
            </div>
          </details>
        </section>
        )}
      </section>

      {chainError ? <p className="error-text action-message">{rt(chainError)}</p> : null}
      {chainMessage ? <p className="success-text action-message">{rt(chainMessage)}</p> : null}

      <details className="technical-section disclosure">
        <summary>{t("advanced")}</summary>
        <div className="technical-grid disclosure-body">
          <section>
            <h3>{t("roundSettings")}</h3>
            <div className="form-grid">
              <label className="field">
                <span>{t("minimumTickets")}</span>
                <input
                  type="number"
                  min={1}
                  max={metadata.maxTickets}
                  value={metadata.minTickets}
                  onChange={(event) => updateMetadata("minTickets", Number(event.target.value))}
                />
              </label>
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
              <div><dt>{t("covenant")}</dt><dd className="mono">{metadata.treasuryAddress || t("pending")}</dd></div>
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
              <div><dt>{t("contract")}</dt><dd>{covenantStatus.contract}</dd></div>
              <div><dt>{t("artifact")}</dt><dd>{covenantStatus.status}</dd></div>
              <div><dt>{t("ticketRoot")}</dt><dd className="mono">{metadata.covenant?.ticketRoot || t("pending")}</dd></div>
              <div><dt>{t("createTx")}</dt><dd className="mono">{metadata.createTxId || t("pending")}</dd></div>
            </dl>
            {[...verification.errors, ...verification.warnings].length ? (
              <ul className="message-list">
                {[...verification.errors, ...verification.warnings].map((message) => <li key={message}>{rt(message)}</li>)}
              </ul>
            ) : null}
          </section>
        </div>
      </details>
    </main>
  );
}
