import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  KeyRound,
  Link2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Ticket,
  Upload
} from "lucide-react";
import { assertRaffleCovenantReady, getRaffleCovenantStatus } from "../kaspa/covenant";
import { loadRaffleHistory, type RaffleHistoryRound } from "../kaspa/history";
import {
  connectBrowserRpc,
  disconnectBrowserRpc,
  getAddressBalanceSompi,
  type KaspaNodeStatus,
  type KaspaRpcConnection
} from "../kaspa/rpc";
import { sendKaspaPayment } from "../kaspa/transactions";
import {
  createBrowserTestWallet,
  importBrowserTestWallet,
  withWalletBalance,
  type BrowserTestWallet
} from "../kaspa/wallet";
import { createEmptyMetadata, parseMetadata, stringifyMetadata } from "../raffle/metadata";
import { creatorCommitment, randomHex, sha256Hex } from "../raffle/randomness";
import { verifyRaffleState } from "../raffle/state";
import type { FinalizeState, RaffleMetadata, RoundState, TicketState } from "../raffle/types";
import { Panel } from "../ui/Panel";

const emptyMetadata = createEmptyMetadata();

function formatSompi(value: bigint) {
  const kas = Number(value) / 100_000_000;
  return `${kas.toLocaleString(undefined, { maximumFractionDigits: 8 })} KAS (${value.toString()} sompi)`;
}

function encodePayload(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value));
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

function formatDate(value: number | undefined) {
  return value ? new Date(value).toLocaleString() : "unknown";
}

export function App() {
  const rpcConnectionRef = useRef<KaspaRpcConnection | null>(null);
  const [rpcUrl, setRpcUrl] = useState("ws://tn12-node.kaspa.com:17210");
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
  const [creatorSecret, setCreatorSecret] = useState("");
  const [buyerSecret, setBuyerSecret] = useState("");
  const [tickets, setTickets] = useState<TicketState[]>([]);
  const [finalized, setFinalized] = useState<FinalizeState | undefined>();
  const [chainMessage, setChainMessage] = useState("");
  const [chainError, setChainError] = useState("");
  const [isBuying, setIsBuying] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [historyApiBase, setHistoryApiBase] = useState("https://api-tn10.kaspa.org");
  const [historyAddress, setHistoryAddress] = useState("");
  const [historyRounds, setHistoryRounds] = useState<RaffleHistoryRound[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyMessage, setHistoryMessage] = useState("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const isBuyingRef = useRef(false);
  const isFinalizingRef = useRef(false);
  const covenantStatus = useMemo(() => getRaffleCovenantStatus(), []);

  useEffect(() => {
    setMetadataText(stringifyMetadata(metadata));
  }, [metadata]);

  useEffect(() => {
    loadSharedRoundFromUrl();
  }, []);

  const round = useMemo<RoundState>(() => {
    const ticketPrice = BigInt(metadata.ticketPrice || "0");
    const status: RoundState["status"] = finalized ? "Finalized" : tickets.length >= metadata.maxTickets ? "Closed" : "Open";

    return {
      appId: "KASPA_RAFFLE_ROUND_V1",
      roundId: metadata.roundId || "pending-round",
      creator: wallet?.address ?? "no-wallet",
      ticketPrice,
      maxTickets: metadata.maxTickets,
      minTickets: metadata.minTickets,
      soldTickets: tickets.length,
      potAmount: BigInt(tickets.length) * ticketPrice,
      feeBps: 0,
      status,
      randomnessMode: "commit-reveal",
      creatorCommitment: metadata.creatorCommitment,
      ticketRoot: ""
    };
  }, [finalized, metadata, tickets.length, wallet]);

  const verification = useMemo(() => verifyRaffleState({ round, tickets, finalized }), [finalized, round, tickets]);

  async function handleConnect() {
    setRpcError("");

    try {
      await disconnectBrowserRpc(rpcConnectionRef.current);
      const connection = await connectBrowserRpc(rpcUrl, networkId);
      rpcConnectionRef.current = connection;
      setNodeStatus(connection.status);
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

  async function handleGenerateCreatorSecret() {
    const secret = randomHex(32);
    const commitment = await creatorCommitment(secret);
    setCreatorSecret(secret);
    setTickets([]);
    setFinalized(undefined);
    setChainMessage("");
    setChainError("");
    setMetadata((current) => ({
      ...current,
      roundId: `round-${randomHex(8)}`,
      creatorCommitment: commitment
    }));
  }

  function applyMetadata(nextMetadata: RaffleMetadata, message: string) {
    setMetadata(nextMetadata);
    setNetworkId(nextMetadata.network);
    setTickets([]);
    setFinalized(undefined);
    setCreatorSecret("");
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

      if (!metadata.roundId || !metadata.creatorCommitment) {
        throw new Error("Generate the creator secret before buying tickets.");
      }

      if (finalized) {
        throw new Error("This round is already finalized.");
      }

      const treasuryAddress = metadata.treasuryAddress?.trim();

      if (!treasuryAddress) {
        throw new Error("Set a ticket treasury address for this round.");
      }

      if (tickets.length >= metadata.maxTickets) {
        throw new Error("This round has reached its max ticket count.");
      }

      const paidAmount = BigInt(metadata.ticketPrice || "0");

      if (paidAmount <= 0n) {
        throw new Error("Ticket price must be greater than zero.");
      }

      const ticketId = tickets.length + 1;
      const secret = buyerSecret || randomHex(32);
      const buyerCommitment = await sha256Hex(secret);
      const payload = {
        app: "kaspa-raffle-static",
        type: "ticket",
        version: metadata.version,
        roundId: metadata.roundId,
        ticketId,
        buyer: wallet.address,
        buyerCommitment,
        paidAmount: paidAmount.toString(),
        createdAt: new Date().toISOString()
      };
      const payment = await sendKaspaPayment({
        connection: rpcConnectionRef.current,
        wallet,
        toAddress: treasuryAddress,
        amountSompi: paidAmount,
        payload: encodePayload(payload)
      });
      const txId = payment.txIds[payment.txIds.length - 1] ?? "";
      await new Promise((resolve) => window.setTimeout(resolve, 4_000));
      const balanceSompi = await getAddressBalanceSompi(rpcConnectionRef.current, wallet.address);

      setBuyerSecret(secret);
      setWallet(withWalletBalance(wallet, balanceSompi));
      setTickets((current) => [
        ...current,
        {
          appId: "KASPA_RAFFLE_TICKET_V1",
          roundId: metadata.roundId,
          ticketId,
          owner: wallet.address,
          paidAmount,
          buyerCommitment,
          ticketTxId: txId
        }
      ]);
      setChainMessage(`Ticket #${ticketId} submitted: ${txId}`);
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

      if (!creatorSecret) {
        throw new Error("Creator secret is required to finalize this round.");
      }

      if (tickets.length < metadata.minTickets) {
        throw new Error("Not enough tickets to finalize this round.");
      }

      const commitment = await creatorCommitment(creatorSecret);

      if (commitment !== metadata.creatorCommitment) {
        throw new Error("Creator secret does not match the round commitment.");
      }

      if (round.potAmount <= 0n) {
        throw new Error("Prize amount must be greater than zero.");
      }

      if (!rpcConnectionRef.current) {
        throw new Error("Connect to a Kaspa wRPC node first.");
      }

      const randomSeed = await sha256Hex(`${creatorSecret}:${tickets.map((ticket) => ticket.buyerCommitment).join(":")}`);
      const winnerIndex = Number(BigInt(`0x${randomSeed}`) % BigInt(tickets.length));
      const winner = tickets[winnerIndex];
      const nextFinalized: FinalizeState = finalized ?? {
        appId: "KASPA_RAFFLE_FINAL_V1",
        roundId: metadata.roundId || "pending-round",
        randomSeed,
        winnerTicketId: winner.ticketId,
        winnerAddress: winner.owner,
        payoutTxId: ""
      };

      if (nextFinalized.payoutTxId) {
        setChainMessage(`Winner #${nextFinalized.winnerTicketId} was paid: ${nextFinalized.payoutTxId}`);
        return;
      }

      const treasuryAddress = metadata.treasuryAddress?.trim();

      if (!treasuryAddress) {
        throw new Error("Set a ticket treasury address for this round.");
      }

      void treasuryAddress;
      void nextFinalized;
      throw new Error("Covenant finalize transaction builder is not wired yet.");
    } catch (error) {
      setChainError(errorMessage(error, "Unable to finalize covenant round."));
    } finally {
      isFinalizingRef.current = false;
      setIsFinalizing(false);
    }
  }

  async function handleLoadHistory() {
    setHistoryError("");
    setHistoryMessage("");
    setIsLoadingHistory(true);

    try {
      const targetAddress = (historyAddress || metadata.treasuryAddress || "").trim();

      if (!targetAddress) {
        throw new Error("Set a treasury address to load history.");
      }

      const rounds = await loadRaffleHistory(historyApiBase, targetAddress);

      setHistoryAddress(targetAddress);
      setHistoryRounds(rounds);
      setHistoryMessage(`Loaded ${rounds.length} raffle round${rounds.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setHistoryError(errorMessage(error, "Unable to load raffle history."));
    } finally {
      setIsLoadingHistory(false);
    }
  }

  function updateMetadata<K extends keyof RaffleMetadata>(key: K, value: RaffleMetadata[K]) {
    setMetadata((current) => ({
      ...current,
      [key]: value
    }));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="kicker">Kaspa Toccata</p>
          <h1>Raffle Static V0</h1>
        </div>
        <div className={nodeStatus.connected ? "status-pill connected" : "status-pill"}>
          {nodeStatus.connected ? <CheckCircle2 size={18} /> : <Plug size={18} />}
          <span>{nodeStatus.connected ? "Connected" : "Disconnected"}</span>
        </div>
      </header>

      <section className="warning-band">
        <AlertTriangle size={20} />
        <p>
          Experimental testnet app. Do not import a main wallet seed. A malicious or modified static page can steal
          browser-local keys.
        </p>
      </section>

      <div className="workspace-grid">
        <Panel title="Node" eyebrow="Connection">
          <label className="field">
            <span>Kaspa wRPC URL</span>
            <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} />
          </label>
          <label className="field">
            <span>Requested network</span>
            <input value={networkId} onChange={(event) => setNetworkId(event.target.value)} />
          </label>
          <div className="button-row">
            <button type="button" onClick={handleConnect}>
              <Plug size={17} />
              Connect
            </button>
            <button type="button" className="secondary" onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>
          {rpcError ? <p className="error-text">{rpcError}</p> : null}
          <dl className="stat-list">
            <div>
              <dt>Network</dt>
              <dd>{nodeStatus.network}</dd>
            </div>
            <div>
              <dt>Sync</dt>
              <dd>{nodeStatus.syncStatus}</dd>
            </div>
            <div>
              <dt>UTXO index</dt>
              <dd>{nodeStatus.hasUtxoIndex === undefined ? "unknown" : nodeStatus.hasUtxoIndex ? "enabled" : "disabled"}</dd>
            </div>
            <div>
              <dt>Latency</dt>
              <dd>{nodeStatus.latencyMs ? `${nodeStatus.latencyMs} ms` : "unknown"}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{nodeStatus.serverVersion ?? "unknown"}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Wallet" eyebrow="Browser local">
          <div className="button-row">
            <button type="button" onClick={handleGenerateWallet}>
              <KeyRound size={17} />
              Generate
            </button>
            <button type="button" className="secondary" onClick={handleImportWallet}>
              <Upload size={17} />
              Import
            </button>
          </div>
          <label className="field">
            <span>Private key import</span>
            <input
              value={privateKeyInput}
              onChange={(event) => setPrivateKeyInput(event.target.value)}
              placeholder="64-char hex private key"
              type="password"
            />
          </label>
          {walletError ? <p className="error-text">{walletError}</p> : null}
          <dl className="stat-list">
            <div>
              <dt>Address</dt>
              <dd className="mono">{wallet?.address ?? "not generated"}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{wallet?.network ?? networkId}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd>{wallet ? formatSompi(wallet.balanceSompi) : "unknown"}</dd>
            </div>
          </dl>
          <button type="button" className="secondary wide" onClick={handleRefreshBalance}>
            <RefreshCw size={17} />
            Refresh balance
          </button>
        </Panel>

        <Panel title="Create Round" eyebrow="Commit reveal">
          <div className="two-column">
            <label className="field">
              <span>Ticket price (sompi)</span>
              <input value={metadata.ticketPrice} onChange={(event) => updateMetadata("ticketPrice", event.target.value)} />
            </label>
            <label className="field">
              <span>Max tickets</span>
              <input
                type="number"
                min={1}
                value={metadata.maxTickets}
                onChange={(event) => updateMetadata("maxTickets", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Min tickets</span>
              <input
                type="number"
                min={1}
                value={metadata.minTickets}
                onChange={(event) => updateMetadata("minTickets", Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Network</span>
              <input value={metadata.network} onChange={(event) => updateMetadata("network", event.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>Ticket treasury address</span>
            <input
              value={metadata.treasuryAddress ?? ""}
              onChange={(event) => updateMetadata("treasuryAddress", event.target.value)}
              placeholder="kaspatest:..."
            />
          </label>
          <button type="button" onClick={handleGenerateCreatorSecret}>
            <ShieldCheck size={17} />
            Generate creator secret
          </button>
          <dl className="stat-list">
            <div>
              <dt>Round ID</dt>
              <dd className="mono">{metadata.roundId || "pending"}</dd>
            </div>
            <div>
              <dt>Commitment</dt>
              <dd className="mono">{metadata.creatorCommitment || "pending"}</dd>
            </div>
            <div>
              <dt>Treasury</dt>
              <dd className="mono">{metadata.treasuryAddress || "pending"}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Load Round" eyebrow="Metadata">
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
        </Panel>

        <Panel title="Round Status" eyebrow="Chain reconstruction">
          <dl className="stat-list dense">
            <div>
              <dt>Status</dt>
              <dd>{round.status}</dd>
            </div>
            <div>
              <dt>Sold</dt>
              <dd>
                {round.soldTickets} / {round.maxTickets}
              </dd>
            </div>
            <div>
              <dt>Pot</dt>
              <dd>{formatSompi(round.potAmount)}</dd>
            </div>
            <div>
              <dt>Tickets</dt>
              <dd>{tickets.length}</dd>
            </div>
          </dl>
          {tickets.length ? (
            <ul className="message-list compact">
              {tickets.map((ticket) => (
                <li key={ticket.ticketTxId}>
                  #{ticket.ticketId} <span className="mono">{ticket.ticketTxId}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state">
              <Ticket size={24} />
              <p>No ticket transactions submitted yet.</p>
            </div>
          )}
        </Panel>

        <Panel title="Buy Ticket" eyebrow="Ticket UTXO">
          <button type="button" onClick={() => setBuyerSecret(randomHex(32))}>
            <Ticket size={17} />
            Generate buyer secret
          </button>
          <dl className="stat-list">
            <div>
              <dt>Next ticket</dt>
              <dd>{finalized || tickets.length >= metadata.maxTickets ? "closed" : `#${tickets.length + 1}`}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>{formatSompi(BigInt(metadata.ticketPrice || "0"))}</dd>
            </div>
            <div>
              <dt>Buyer secret</dt>
              <dd className="mono">{buyerSecret || "pending"}</dd>
            </div>
          </dl>
          {chainError ? <p className="error-text">{chainError}</p> : null}
          {chainMessage ? <p className="success-text">{chainMessage}</p> : null}
          <button
            type="button"
            className="secondary wide"
            onClick={handleBuyTicket}
            disabled={isBuying || Boolean(finalized) || tickets.length >= metadata.maxTickets}
          >
            {isBuying ? "Buying..." : "Buy ticket"}
          </button>
        </Panel>

        <Panel title="Finalize / Refund" eyebrow="Covenant enforced">
          <div className={covenantStatus.enabled ? "verify-box ok" : "verify-box"}>
            <ShieldCheck size={20} />
            <span>{covenantStatus.enabled ? "Covenant artifacts loaded" : "Covenant artifacts pending"}</span>
          </div>
          <p className="muted">{covenantStatus.message}</p>
          <dl className="stat-list dense">
            <div>
              <dt>Contract</dt>
              <dd>{covenantStatus.contract}</dd>
            </div>
            <div>
              <dt>Artifact</dt>
              <dd>{covenantStatus.status}</dd>
            </div>
          </dl>
          <div className="button-row">
            <button type="button" className="secondary">
              Close round
            </button>
            <button
              type="button"
              className="secondary"
              onClick={handleFinalizeLocal}
              disabled={!covenantStatus.enabled || Boolean(finalized?.payoutTxId) || isFinalizing}
            >
              {isFinalizing ? "Finalizing..." : "Finalize"}
            </button>
          </div>
          <label className="field">
            <span>Creator secret backup</span>
            <input readOnly value={creatorSecret} placeholder="Generate a creator secret first" />
          </label>
          {finalized ? (
            <dl className="stat-list">
              <div>
                <dt>Winner</dt>
                <dd>#{finalized.winnerTicketId}</dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd className="mono">{finalized.winnerAddress}</dd>
              </div>
              <div>
                <dt>Seed</dt>
                <dd className="mono">{finalized.randomSeed}</dd>
              </div>
              <div>
                <dt>Payout tx</dt>
                <dd className="mono">{finalized.payoutTxId || "pending"}</dd>
              </div>
            </dl>
          ) : null}
          <button type="button" className="secondary wide">
            <Download size={17} />
            Export backup
          </button>
        </Panel>

        <Panel title="History" eyebrow="Explorer index">
          <label className="field">
            <span>REST API</span>
            <input value={historyApiBase} onChange={(event) => setHistoryApiBase(event.target.value)} />
          </label>
          <label className="field">
            <span>Treasury address</span>
            <input
              value={historyAddress || metadata.treasuryAddress || ""}
              onChange={(event) => setHistoryAddress(event.target.value)}
              placeholder="kaspatest:..."
            />
          </label>
          <button type="button" className="secondary wide" onClick={handleLoadHistory} disabled={isLoadingHistory}>
            <RefreshCw size={17} />
            {isLoadingHistory ? "Loading..." : "Load history"}
          </button>
          {historyError ? <p className="error-text">{historyError}</p> : null}
          {historyMessage ? <p className="success-text">{historyMessage}</p> : null}
          {historyRounds.length ? (
            <div className="history-list">
              {historyRounds.map((historyRound) => {
                const latestPayout = historyRound.payouts[0];

                return (
                  <article className="history-item" key={historyRound.roundId}>
                    <h3 className="compact-title">{historyRound.roundId}</h3>
                    <dl className="stat-list dense">
                      <div>
                        <dt>Status</dt>
                        <dd>{latestPayout ? "Paid" : "Open"}</dd>
                      </div>
                      <div>
                        <dt>Tickets</dt>
                        <dd>{historyRound.tickets.length}</dd>
                      </div>
                      <div>
                        <dt>Pot</dt>
                        <dd>{formatSompi(historyRound.potAmount)}</dd>
                      </div>
                      <div>
                        <dt>Last seen</dt>
                        <dd>{formatDate(historyRound.lastBlockTime)}</dd>
                      </div>
                    </dl>
                    <ul className="message-list compact">
                      {historyRound.tickets.map((ticket) => (
                        <li key={ticket.txId}>
                          Ticket #{ticket.ticketId} {formatSompi(ticket.paidAmount)}{" "}
                          <span className="mono">{ticket.txId}</span>
                        </li>
                      ))}
                      {historyRound.payouts.map((payout) => (
                        <li key={payout.txId}>
                          Paid #{payout.winnerTicketId} {formatSompi(payout.amount)}{" "}
                          <span className="mono">{payout.txId}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="muted">No indexed raffle history loaded.</p>
          )}
        </Panel>

        <Panel title="Verify" eyebrow="Local checks">
          <div className={verification.ok ? "verify-box ok" : "verify-box"}>
            <ShieldCheck size={20} />
            <span>{verification.ok ? "Local state checks passed" : "Local state has issues"}</span>
          </div>
          {[...verification.errors, ...verification.warnings].length ? (
            <ul className="message-list">
              {[...verification.errors, ...verification.warnings].map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Scanner and transaction verification will appear here as implementation lands.</p>
          )}
        </Panel>
      </div>
    </main>
  );
}
