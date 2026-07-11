import { useEffect, useMemo, useRef, useState } from "react";
import * as secp from "@noble/secp256k1";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Link2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Ticket,
  Upload
} from "lucide-react";
import {
  assertRaffleCovenantReady,
  buildFinalizeSeedHex,
  buildNextTicketRootHex,
  bytesToHex,
  getRaffleCovenantStatus,
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
  buyRaffleCovenantTicket,
  createRaffleCovenantRound,
  DEFAULT_COVENANT_CARRIER_SOMPI,
  DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI,
  finalizeRaffleCovenantRound,
  getRaffleRegistryAddress,
  MIN_COVENANT_CARRIER_SOMPI,
  refundRaffleCovenantRound,
  refundRaffleRegistryMarker,
  sendKaspaPayment
} from "../kaspa/transactions";
import {
  createBrowserTestWallet,
  importBrowserTestWallet,
  withWalletBalance,
  type BrowserTestWallet
} from "../kaspa/wallet";
import { createEmptyMetadata, parseMetadata, stringifyMetadata } from "../raffle/metadata";
import { hexToBytes, randomHex, sha256Hex } from "../raffle/randomness";
import { verifyRaffleState } from "../raffle/state";
import type { FinalizeState, RaffleMetadata, RoundState, TicketState } from "../raffle/types";

const emptyMetadata = createEmptyMetadata();
const KASPA_DAA_PER_SECOND = 10n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 60n * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24n * SECONDS_PER_HOUR;
const SECONDS_PER_MONTH = 30n * SECONDS_PER_DAY;
const DEFAULT_REFUND_TIMEOUT_SECONDS = 10n * SECONDS_PER_MINUTE;

type RefundTimeoutPart = "months" | "days" | "hours" | "minutes" | "seconds";
type RefundTimeoutParts = Record<RefundTimeoutPart, string>;

const DEFAULT_REFUND_TIMEOUT_PARTS: RefundTimeoutParts = {
  months: "0",
  days: "0",
  hours: "0",
  minutes: "10",
  seconds: "0"
};

const REFUND_TIMEOUT_FIELDS: Array<{ key: RefundTimeoutPart; label: string }> = [
  { key: "months", label: "月" },
  { key: "days", label: "天" },
  { key: "hours", label: "时" },
  { key: "minutes", label: "分" },
  { key: "seconds", label: "秒" }
];

function formatSompi(value: bigint) {
  const kas = Number(value) / 100_000_000;
  return `${kas.toLocaleString(undefined, { maximumFractionDigits: 8 })} KAS (${value.toString()} sompi)`;
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

    throw new Error(`${fieldName} must be a whole number of sompi.`);
  }
}

function parseMinimumSompi(value: string, fieldName: string, minimum: bigint) {
  const parsed = parsePositiveSompi(value, fieldName);

  if (parsed < minimum) {
    throw new Error(`${fieldName} must be at least ${minimum.toString()} sompi for the current Toccata storage-mass floor.`);
  }

  return parsed;
}

function formatSompiInput(value: string) {
  try {
    return formatSompi(BigInt(value || "0"));
  } catch {
    return "invalid";
  }
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

function formatDurationSeconds(totalSeconds: bigint): string {
  const parts = refundTimeoutPartsFromSeconds(totalSeconds);
  return `${parts.months}月 ${parts.days}天 ${parts.hours}时 ${parts.minutes}分 ${parts.seconds}秒`;
}

function formatRefundTimeoutParts(parts: RefundTimeoutParts): string {
  try {
    return formatDurationSeconds(refundTimeoutSecondsFromParts(parts));
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

function formatDate(value: number | undefined) {
  return value ? new Date(value).toLocaleString() : "unknown";
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
  const [rpcUrl, setRpcUrl] = useState("ws://tn12-node.kaspa.com:18210");
  const [networkId, setNetworkId] = useState("testnet-12");
  const [nodeStatus, setNodeStatus] = useState<KaspaNodeStatus>({
    connected: false,
    network: "unknown",
    syncStatus: "unknown"
  });
  const [rpcError, setRpcError] = useState("");
  const [wallet, setWallet] = useState<BrowserTestWallet | null>(null);
  const [walletError, setWalletError] = useState("");
  const [privateKeyInput, setPrivateKeyInput] = useState("");
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
  const [historyApiBase, setHistoryApiBase] = useState("https://api-tn10.kaspa.org");
  const [historyAddress, setHistoryAddress] = useState("");
  const [registryAddress, setRegistryAddress] = useState("");
  const [historyRounds, setHistoryRounds] = useState<RaffleHistoryRound[]>([]);
  const [selectedHistoryRoundId, setSelectedHistoryRoundId] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyMessage, setHistoryMessage] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
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
  const refundTimeoutDisplay = useMemo(() => formatRefundTimeoutParts(refundTimeoutParts), [refundTimeoutParts]);

  useEffect(() => {
    setMetadataText(stringifyMetadata(metadata));
  }, [metadata]);

  useEffect(() => {
    loadSharedRoundFromUrl();
  }, []);

  useEffect(() => {
    let cancelled = false;

    void getRaffleRegistryAddress(networkId)
      .then((address) => {
        if (!cancelled) {
          setRegistryAddress(address);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRegistryAddress("");
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

  async function handleConnect() {
    setRpcError("");

    try {
      await disconnectBrowserRpc(rpcConnectionRef.current);
      const connection = await connectBrowserRpc(rpcUrl, networkId);
      rpcConnectionRef.current = connection;
      setNodeStatus(connection.status);

      const connectedNetwork = connection.status.network;

      if (connectedNetwork && connectedNetwork !== "unknown") {
        setNetworkId(connectedNetwork);
        setMetadata((current) => (
          current.createTxId || current.covenant
            ? current
            : { ...current, network: connectedNetwork }
        ));

        if (wallet && wallet.network !== connectedNetwork) {
          setWallet(await importBrowserTestWallet(wallet.privateKey, connectedNetwork));
        }
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

  async function handleGenerateWallet() {
    setWalletError("");

    try {
      setWallet(await createBrowserTestWallet(networkId));
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Unable to generate wallet.");
    }
  }

  async function handleImportWallet() {
    setWalletError("");

    try {
      setWallet(await importBrowserTestWallet(privateKeyInput, networkId));
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Unable to import private key.");
    }
  }

  async function handleRefreshBalance() {
    setWalletError("");

    if (!wallet) {
      setWalletError("Generate or import a wallet first.");
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

  function prepareOracleForCreate(forceNew = false) {
    const canReuseKey =
      !forceNew &&
      /^[0-9a-f]{64}$/.test(oraclePrivateKey) &&
      (!metadata.oraclePublicKey || oraclePublicKeyFromPrivateKey(oraclePrivateKey) === metadata.oraclePublicKey);
    const privateKey = canReuseKey ? oraclePrivateKey : randomHex(32);
    const publicKey = oraclePublicKeyFromPrivateKey(privateKey);
    const roundId = forceNew || !metadata.roundId ? `round-${randomHex(8)}` : metadata.roundId;

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
    const restoredOraclePrivateKey = restoreDevOracleKey(nextMetadata.roundId, nextMetadata.oraclePublicKey);
    const loadedRefundTimeoutSeconds = refundTimeoutSecondsFromMetadata(nextMetadata);

    setMetadata(nextMetadata);
    setRefundTimeoutParts(refundTimeoutPartsFromSeconds(loadedRefundTimeoutSeconds));
    setNetworkId(nextMetadata.network);
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
        throw new Error("Import the funded creator wallet first.");
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
      const refundDelaySeconds = refundTimeoutSecondsFromParts(refundTimeoutParts);
      const refundDelayDaa = refundDelaySeconds * KASPA_DAA_PER_SECOND;

      if (refundDelayDaa <= 0n) {
        throw new Error("Refund timeout must be greater than zero seconds.");
      }

      const createdAtDaaScore = await currentVirtualDaaScore(rpcConnectionRef.current);
      const refundAfterDaaScore = createdAtDaaScore + refundDelayDaa;
      const creatorPubkey = pubkeyHexFromAddress(wallet.address);
      const prepared = prepareOracleForCreate(Boolean(metadata.covenant));
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
      let registryWarning = "";
      const targetRegistryAddress = registryAddress || await getRaffleRegistryAddress(wallet.network);

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
            contractVersion: metadata.contractVersion,
            registeredAt: new Date().toISOString()
          })
        });
        registryTxIds = registryResult.txIds;

        const markerTxId = registryTxIds[registryTxIds.length - 1];

        if (markerTxId) {
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
        covenant: result.covenant
      }));
      setTickets([]);
      setFinalized(undefined);
      setHistoryAddress((current) => current || targetRegistryAddress);
      setChainMessage(
        registryTxIds.length
          ? `Covenant round created: ${result.txId}. Registry tx: ${registryTxIds.join(", ")}${registryRefundTxId ? `. Registry marker refunded: ${registryRefundTxId}` : ""}`
          : `Covenant round created: ${result.txId}.`
      );
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
        throw new Error("Import the funded buyer wallet first.");
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
            `Round can finalize when sold out or in about ${formatDurationSeconds(remainingSeconds)}.`
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
      const hasMatchingLocalOracleKey =
        /^[0-9a-f]{64}$/.test(oraclePrivateKey) &&
        oraclePublicKeyFromPrivateKey(oraclePrivateKey) === metadata.oraclePublicKey;

      if (hasMatchingLocalOracleKey) {
        finalizeOracleSeed = randomHex(32);
        finalizeOracleSignature = await signOracleSeed(oraclePrivateKey, finalizeOracleSeed);
        setOracleSeed(finalizeOracleSeed);
        setOracleSignature(finalizeOracleSignature);
      } else if (!finalizeOracleSeed || !finalizeOracleSignature) {
        if (!/^[0-9a-f]{64}$/.test(oraclePrivateKey)) {
          throw new Error("This browser has no oracle key for the round. Load an external oracle attestation in Advanced oracle.");
        }

        throw new Error("The saved oracle key does not match this round. Load an external oracle attestation in Advanced oracle.");
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
          `Refund opens in about ${formatDurationSeconds(remainingSeconds)} at DAA ${refundAfterDaaScore.toString()}. Current DAA is ${currentDaaScore.toString()}.`
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
    return address.startsWith("kaspatest:") ? "testnet-12" : networkId;
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

  function handleJoinSelectedHistoryRound() {
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
        `Selected round was created with an old carrier reserve. Recreate it with at least ${MIN_COVENANT_CARRIER_SOMPI.toString()} sompi.`
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
    const restoredOraclePrivateKey = restoreDevOracleKey(selectedHistoryRound.roundId, selectedHistoryRound.oraclePublicKey);
    const loadedRefundTimeoutSeconds = refundTimeoutSecondsFromHistoryRound(selectedHistoryRound);

    setNetworkId(loadedNetwork);
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
          <p className="kicker">Kaspa Toccata testnet</p>
          <h1>Kaspa Raffle</h1>
        </div>
        <div className="header-status">
          <span className={nodeStatus.connected ? "status-pill connected" : "status-pill"}>
            {nodeStatus.connected ? <CheckCircle2 size={17} /> : <Plug size={17} />}
            {nodeStatus.connected ? "Node ready" : "Node offline"}
          </span>
          <span className="balance-pill">{wallet ? formatSompi(wallet.balanceSompi) : "Wallet not loaded"}</span>
        </div>
      </header>

      <section className="notice-band">
        <AlertTriangle size={18} />
        <p>Testnet only. Use a dedicated wallet with small amounts.</p>
      </section>

      <section className="setup-strip" aria-label="Connection and wallet">
        <div className="setup-primary">
          <label className="field inline-field">
            <span>Kaspa node</span>
            <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} />
          </label>
          {nodeStatus.connected ? (
            <button type="button" className="secondary" onClick={handleDisconnect}>Disconnect</button>
          ) : (
            <button type="button" onClick={handleConnect}>Connect</button>
          )}
        </div>

        <div className="wallet-summary">
          <div>
            <span className="summary-label">Wallet</span>
            <strong className="mono">{wallet ? shortValue(wallet.address, 10) : "Not loaded"}</strong>
          </div>
          <div>
            <span className="summary-label">Balance</span>
            <strong>{wallet ? formatSompi(wallet.balanceSompi) : "Unknown"}</strong>
          </div>
          <button type="button" className="icon-button secondary" onClick={handleRefreshBalance} title="Refresh balance" aria-label="Refresh balance">
            <RefreshCw size={17} />
          </button>
        </div>

        <details className="disclosure setup-wallet-details">
          <summary>Wallet setup</summary>
          <div className="disclosure-body wallet-setup-row">
            <button type="button" className="secondary" onClick={handleGenerateWallet}>
              <KeyRound size={17} />
              Generate test wallet
            </button>
            <label className="wallet-key-field">
              <span className="visually-hidden">Private key</span>
              <input
                value={privateKeyInput}
                onChange={(event) => setPrivateKeyInput(event.target.value.trim())}
                placeholder="64-character testnet private key"
                type="password"
              />
            </label>
            <button type="button" className="secondary" onClick={handleImportWallet}>Import wallet</button>
          </div>
        </details>

        {rpcError ? <p className="error-text strip-message">{rpcError}</p> : null}
        {walletError ? <p className="error-text strip-message">{walletError}</p> : null}
      </section>

      <section className="round-overview">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Current round</p>
            <h2>{metadata.roundId ? shortValue(metadata.roundId, 12) : "No round created"}</h2>
          </div>
          <div className="heading-actions">
            <span className={`round-status status-${round.status.toLowerCase()}`}>{round.status}</span>
            {metadata.roundId ? (
              <button type="button" className="icon-button secondary" onClick={handleCopyRoundLink} title="Copy round link" aria-label="Copy round link">
                <Link2 size={17} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="key-metrics">
          <div>
            <span>Tickets sold</span>
            <strong>{round.soldTickets.toLocaleString()} / {round.maxTickets.toLocaleString()}</strong>
          </div>
          <div>
            <span>Prize pot</span>
            <strong>{formatSompi(round.potAmount)}</strong>
          </div>
          <div>
            <span>Ticket price</span>
            <strong>{formatSompi(round.ticketPrice)}</strong>
          </div>
          <div>
            <span>Draw / refund</span>
            <strong>{refundTimeoutDisplay}</strong>
          </div>
        </div>

        <div className="progress-track" aria-label="Ticket sales progress">
          <span style={{ width: `${soldPercent}%` }} />
        </div>

        {ticketBatches.length ? (
          <details className="disclosure compact-disclosure">
            <summary>{ticketBatches.length} purchase batch{ticketBatches.length === 1 ? "" : "es"}</summary>
            <div className="batch-list">
              {ticketBatches.map((batch) => (
                <div className="batch-row" key={batch.txId || `${batch.start}-${batch.end}`}>
                  <strong>#{batch.start}{batch.end > batch.start ? `-${batch.end}` : ""}</strong>
                  <span>{batch.count.toLocaleString()} ticket{batch.count === 1 ? "" : "s"}</span>
                  <span className="mono">{shortValue(batch.owner, 9)}</span>
                  <span>{formatSompi(batch.amount)}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <section className="action-layout">
        <section className="action-pane">
          {canStartNewRound ? (
            <>
              <div className="pane-heading">
                <p className="eyebrow">Organizer</p>
                <h2>{finalized ? "Create next round" : "Create a round"}</h2>
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>Ticket price (KAS)</span>
                  <input
                    inputMode="decimal"
                    value={sompiToKasInput(metadata.ticketPrice)}
                    onChange={(event) => updateMetadata("ticketPrice", kasInputToSompi(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Total tickets</span>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={metadata.maxTickets}
                    onChange={(event) => updateMetadata("maxTickets", Number(event.target.value))}
                  />
                </label>
              </div>

              <details className="disclosure compact-disclosure">
                <summary>Draw / refund timeout: {refundTimeoutDisplay}</summary>
                <div className="duration-grid disclosure-body">
                  {REFUND_TIMEOUT_FIELDS.map((field) => (
                    <label className="field compact-field" key={field.key}>
                      <span>{field.label}</span>
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
                className="wide"
                onClick={handleCreateCovenantRound}
                disabled={isCreatingRound || !canStartNewRound}
              >
                {isCreatingRound ? "Creating round..." : finalized ? "Create next round" : "Create round"}
              </button>
            </>
          ) : (
            <>
              <div className="pane-heading">
                <p className="eyebrow">Participant</p>
                <h2>Buy tickets</h2>
              </div>
              <div className="purchase-form">
                <label className="field quantity-field">
                  <span>Quantity</span>
                  <input
                    type="number"
                    min={1}
                    max={remainingTickets}
                    value={ticketQuantity}
                    onChange={(event) => setTicketQuantity(event.target.value)}
                  />
                </label>
                <div className="segmented-control" aria-label="Ticket quantity presets">
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
                    Max
                  </button>
                </div>
              </div>
              <dl className="purchase-summary">
                <div><dt>Total</dt><dd>{formatSompi(purchaseTotal)}</dd></div>
                <div><dt>Remaining</dt><dd>{remainingTickets.toLocaleString()}</dd></div>
                <div><dt>Purchase batches</dt><dd>{(metadata.covenant?.soldBatches ?? metadata.covenant?.ticketOwnerPubkeys.length ?? 0)} / 20</dd></div>
              </dl>
              <button
                type="button"
                className="wide"
                onClick={handleBuyTicket}
                disabled={isBuying || Boolean(finalized) || remainingTickets <= 0}
              >
                {isBuying ? "Buying tickets..." : `Buy ${Number.isInteger(parsedTicketQuantity) && parsedTicketQuantity > 0 ? parsedTicketQuantity.toLocaleString() : ""} ticket${parsedTicketQuantity === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </section>

        <section className="action-pane">
          <div className="pane-heading">
            <p className="eyebrow">Covenant action</p>
            <h2>Draw and payout</h2>
          </div>

          {finalized ? (
            <div className="winner-block">
              <span>Winner</span>
              <strong>Ticket #{finalized.winnerTicketId}</strong>
              <p className="mono">{finalized.winnerAddress}</p>
              <p>Paid in transaction <span className="mono">{shortValue(finalized.payoutTxId, 10)}</span></p>
            </div>
          ) : (
            <>
              <p className="pane-copy">
                {round.soldTickets >= round.maxTickets
                  ? "All tickets are sold. The round can be drawn now."
                  : round.soldTickets > 0
                    ? `${remainingTickets.toLocaleString()} tickets remain, or draw after the timeout.`
                    : "Buy at least one ticket before drawing."}
              </p>
              <div className="button-row">
                <button
                  type="button"
                  onClick={handleFinalizeLocal}
                  disabled={
                    !covenantStatus.enabled ||
                    isFinalizing ||
                    !metadata.covenant ||
                    (metadata.covenant.status !== "Open" && metadata.covenant.status !== "Closed") ||
                    metadata.covenant.soldTickets <= 0
                  }
                >
                  {isFinalizing ? "Drawing and paying..." : "Draw & pay"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleRefundTimedOutRound}
                  disabled={
                    !covenantStatus.enabled ||
                    isRefundingRound ||
                    !metadata.covenant ||
                    metadata.covenant.status === "Finalized" ||
                    metadata.covenant.status === "Refunding" ||
                    metadata.covenant.status === "Refunded" ||
                    metadata.covenant.soldTickets <= 0
                  }
                >
                  {isRefundingRound ? "Refunding..." : "Refund after timeout"}
                </button>
              </div>
            </>
          )}

          <details className="disclosure compact-disclosure">
            <summary>Oracle attestation</summary>
            <div className="disclosure-body">
              <label className="field">
                <span>Development oracle private key</span>
                <input
                  type="password"
                  value={oraclePrivateKey}
                  onChange={(event) => handleOraclePrivateKeyInput(event.target.value)}
                  placeholder="Restored automatically for locally created rounds"
                />
              </label>
              <label className="field">
                <span>External oracle seed</span>
                <input value={oracleSeed} onChange={(event) => setOracleSeed(event.target.value.trim().toLowerCase())} />
              </label>
              <label className="field">
                <span>External oracle signature</span>
                <input value={oracleSignature} onChange={(event) => setOracleSignature(event.target.value.trim().toLowerCase())} />
              </label>
            </div>
          </details>
        </section>
      </section>

      {chainError ? <p className="error-text action-message">{chainError}</p> : null}
      {chainMessage ? <p className="success-text action-message">{chainMessage}</p> : null}

      <section className="history-section" aria-labelledby="raffle-history-title">
        <div className="section-heading-row">
          <div className="history-title-block">
            <p className="eyebrow">On-chain activity</p>
            <h2 id="raffle-history-title">Raffle history</h2>
            <p className="history-summary" aria-live="polite">
              {historyRounds.length
                ? `${historyRounds.length.toLocaleString()} rounds indexed · ${historyRounds.filter((historyRound) => historyRoundStatus(historyRound) === "Paid").length.toLocaleString()} paid · ${historyRounds.filter((historyRound) => historyRoundStatus(historyRound) === "Refunded").length.toLocaleString()} refunded`
                : isLoadingHistory
                  ? "Reading round results from the network..."
                  : "Round results from the network"}
            </p>
          </div>
          <button type="button" className="history-refresh" onClick={handleLoadHistory} disabled={isLoadingHistory}>
            <RefreshCw size={17} />
            {isLoadingHistory ? "Loading history..." : "Refresh history"}
          </button>
        </div>

        {historyError ? <p className="error-text">{historyError}</p> : null}
        {historyMessage ? <p className="success-text">{historyMessage}</p> : null}

        {historyRounds.length ? (
          <>
            <label className="field history-select">
              <span>Round</span>
              <select
                value={selectedHistoryRound?.roundId ?? ""}
                onChange={(event) => setSelectedHistoryRoundId(event.target.value)}
              >
                {historyRounds.map((historyRound) => (
                  <option key={historyRound.roundId} value={historyRound.roundId}>
                    {historyRound.roundId} - {historyRoundStatus(historyRound)} - {historyRound.tickets.length.toLocaleString()} tickets
                  </option>
                ))}
              </select>
            </label>

            {selectedHistoryRound ? (
              <div className="history-detail">
                <div className="key-metrics history-metrics">
                  <div><span>Status</span><strong>{historyRoundStatus(selectedHistoryRound)}</strong></div>
                  <div><span>Tickets</span><strong>{selectedHistoryRound.tickets.length.toLocaleString()}</strong></div>
                  <div><span>Pot</span><strong>{formatSompi(selectedHistoryRound.potAmount)}</strong></div>
                  <div>
                    <span>Winner</span>
                    <strong>{selectedHistoryRound.payouts[0] ? `#${selectedHistoryRound.payouts[0].winnerTicketId}` : "Pending"}</strong>
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
                    Load this round
                  </button>
                ) : null}

                <details className="disclosure compact-disclosure">
                  <summary>{selectedHistoryBatches.length} purchase batch{selectedHistoryBatches.length === 1 ? "" : "es"}</summary>
                  <div className="batch-list">
                    {selectedHistoryBatches.map((batch) => (
                      <div className="batch-row" key={batch.txId}>
                        <strong>#{batch.start}{batch.end > batch.start ? `-${batch.end}` : ""}</strong>
                        <span>{batch.count.toLocaleString()} tickets</span>
                        <span className="mono">{shortValue(batch.owner, 9)}</span>
                        <span>{formatSompi(batch.amount)}</span>
                      </div>
                    ))}
                  </div>
                </details>

                <details className="disclosure compact-disclosure">
                  <summary>Transactions and timing</summary>
                  <dl className="stat-list dense disclosure-body">
                    <div><dt>Registry tx</dt><dd className="mono">{selectedHistoryRound.registryTxId ?? "unknown"}</dd></div>
                    <div><dt>Covenant</dt><dd className="mono">{selectedHistoryRound.latestCovenant?.address ?? selectedHistoryRound.treasuryAddress ?? "unknown"}</dd></div>
                    <div><dt>Refund tx</dt><dd className="mono">{selectedHistoryRound.refundTxId ?? "pending"}</dd></div>
                    <div><dt>Refund after DAA</dt><dd className="mono">{selectedHistoryRound.latestCovenant?.refundAfterDaaScore ?? selectedHistoryRound.refundAfterDaaScore ?? "unknown"}</dd></div>
                    <div><dt>Last seen</dt><dd>{formatDate(selectedHistoryRound.lastBlockTime)}</dd></div>
                    {selectedHistoryRound.payouts[0] ? (
                      <div><dt>Payout tx</dt><dd className="mono">{selectedHistoryRound.payouts[0].txId}</dd></div>
                    ) : null}
                  </dl>
                </details>
              </div>
            ) : null}
          </>
        ) : (
          <p className="history-empty">No indexed rounds loaded yet.</p>
        )}

        <details className="disclosure compact-disclosure">
          <summary>History source</summary>
          <div className="form-grid disclosure-body">
            <label className="field">
              <span>REST API</span>
              <input value={historyApiBase} onChange={(event) => setHistoryApiBase(event.target.value)} />
            </label>
            <label className="field">
              <span>Registry address</span>
              <input
                value={historyAddress || registryAddress || metadata.treasuryAddress || ""}
                onChange={(event) => setHistoryAddress(event.target.value)}
                placeholder="kaspatest:..."
              />
            </label>
          </div>
        </details>
      </section>

      <details className="technical-section disclosure">
        <summary>Advanced settings and technical details</summary>
        <div className="technical-grid disclosure-body">
          <section>
            <h3>Round settings</h3>
            <div className="form-grid">
              <label className="field">
                <span>Minimum tickets</span>
                <input
                  type="number"
                  min={1}
                  max={metadata.maxTickets}
                  value={metadata.minTickets}
                  onChange={(event) => updateMetadata("minTickets", Number(event.target.value))}
                />
              </label>
              <label className="field">
                <span>Carrier reserve (sompi)</span>
                <input value={covenantCarrierSompi} onChange={(event) => setCovenantCarrierSompi(event.target.value)} />
              </label>
            </div>
            <dl className="stat-list dense">
              <div><dt>Network</dt><dd>{networkId}</dd></div>
              <div><dt>Round ID</dt><dd className="mono">{metadata.roundId || "pending"}</dd></div>
              <div><dt>Covenant</dt><dd className="mono">{metadata.treasuryAddress || "pending"}</dd></div>
              <div><dt>Refund after DAA</dt><dd className="mono">{metadata.covenant?.refundAfterDaaScore ?? metadata.refundAfterDaaScore ?? "pending"}</dd></div>
              <div><dt>Contract version</dt><dd>{metadata.contractVersion}</dd></div>
            </dl>
          </section>

          <section>
            <h3>Node diagnostics</h3>
            <dl className="stat-list dense">
              <div><dt>Network</dt><dd>{nodeStatus.network}</dd></div>
              <div><dt>Sync</dt><dd>{nodeStatus.syncStatus}</dd></div>
              <div><dt>UTXO index</dt><dd>{nodeStatus.hasUtxoIndex === undefined ? "unknown" : nodeStatus.hasUtxoIndex ? "enabled" : "disabled"}</dd></div>
              <div><dt>Latency</dt><dd>{nodeStatus.latencyMs ? `${nodeStatus.latencyMs} ms` : "unknown"}</dd></div>
              <div><dt>Version</dt><dd>{nodeStatus.serverVersion}</dd></div>
            </dl>
          </section>

          <section className="technical-wide">
            <h3>Round metadata</h3>
            <textarea
              spellCheck={false}
              value={metadataText}
              onChange={(event) => setMetadataText(event.target.value)}
            />
            <div className="button-row">
              <button type="button" className="secondary" onClick={handleImportMetadata}>
                <Upload size={17} />
                Import JSON
              </button>
              <button type="button" className="secondary" onClick={handleCopyRoundLink}>
                <Link2 size={17} />
                Copy link
              </button>
            </div>
            {metadataError ? <p className="error-text">{metadataError}</p> : null}
            {metadataMessage ? <p className="success-text">{metadataMessage}</p> : null}
          </section>

          <section className="technical-wide">
            <h3>Contract verification</h3>
            <div className={verification.ok ? "verify-box ok" : "verify-box"}>
              <ShieldCheck size={20} />
              <span>{verification.ok ? "Local state checks passed" : "Local state has issues"}</span>
            </div>
            <dl className="stat-list dense">
              <div><dt>Contract</dt><dd>{covenantStatus.contract}</dd></div>
              <div><dt>Artifact</dt><dd>{covenantStatus.status}</dd></div>
              <div><dt>Ticket root</dt><dd className="mono">{metadata.covenant?.ticketRoot || "pending"}</dd></div>
              <div><dt>Create tx</dt><dd className="mono">{metadata.createTxId || "pending"}</dd></div>
            </dl>
            {[...verification.errors, ...verification.warnings].length ? (
              <ul className="message-list">
                {[...verification.errors, ...verification.warnings].map((message) => <li key={message}>{message}</li>)}
              </ul>
            ) : null}
          </section>
        </div>
      </details>
    </main>
  );
}
