import { useMemo, useRef, useState } from "react";
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
import { createEmptyMetadata, stringifyMetadata } from "../raffle/metadata";
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : String(error || fallback);
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
  const [creatorSecret, setCreatorSecret] = useState("");
  const [buyerSecret, setBuyerSecret] = useState("");
  const [tickets, setTickets] = useState<TicketState[]>([]);
  const [finalized, setFinalized] = useState<FinalizeState | undefined>();
  const [chainMessage, setChainMessage] = useState("");
  const [chainError, setChainError] = useState("");
  const [isBuying, setIsBuying] = useState(false);
  const isBuyingRef = useRef(false);

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

    if (finalized) {
      setChainMessage(`Winner is ticket #${finalized.winnerTicketId}.`);
      return;
    }

    if (!creatorSecret) {
      setChainError("Creator secret is required to finalize this round.");
      return;
    }

    if (tickets.length < metadata.minTickets) {
      setChainError("Not enough tickets to finalize this round.");
      return;
    }

    const commitment = await creatorCommitment(creatorSecret);

    if (commitment !== metadata.creatorCommitment) {
      setChainError("Creator secret does not match the round commitment.");
      return;
    }

    const randomSeed = await sha256Hex(`${creatorSecret}:${tickets.map((ticket) => ticket.buyerCommitment).join(":")}`);
    const winnerIndex = Number(BigInt(`0x${randomSeed}`) % BigInt(tickets.length));
    const winner = tickets[winnerIndex];

    setFinalized({
      appId: "KASPA_RAFFLE_FINAL_V1",
      roundId: metadata.roundId || "pending-round",
      randomSeed,
      winnerTicketId: winner.ticketId,
      winnerAddress: winner.owner,
      payoutTxId: ""
    });
    setChainMessage(`Winner is ticket #${winner.ticketId}.`);
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
            value={stringifyMetadata(metadata)}
            onChange={(event) => {
              try {
                setMetadata(JSON.parse(event.target.value));
              } catch {
                return;
              }
            }}
          />
          <div className="button-row">
            <button type="button" className="secondary">
              <Upload size={17} />
              Import JSON
            </button>
            <button type="button" className="secondary">
              <Link2 size={17} />
              Copy link
            </button>
          </div>
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

        <Panel title="Finalize / Refund" eyebrow="Anyone can finalize">
          <div className="button-row">
            <button type="button" className="secondary">
              Close round
            </button>
            <button type="button" className="secondary" onClick={handleFinalizeLocal}>
              Finalize
            </button>
            <button type="button" className="secondary">
              Refund
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
            </dl>
          ) : null}
          <button type="button" className="secondary wide">
            <Download size={17} />
            Export backup
          </button>
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
