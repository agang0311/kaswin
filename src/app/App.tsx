import { useMemo, useState } from "react";
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
import { connectBrowserRpc, type KaspaNodeStatus } from "../kaspa/rpc";
import { createPlaceholderWallet, type BrowserTestWallet } from "../kaspa/wallet";
import { createEmptyMetadata, stringifyMetadata } from "../raffle/metadata";
import { creatorCommitment, randomHex } from "../raffle/randomness";
import { verifyRaffleState } from "../raffle/state";
import type { RaffleMetadata, RoundState, TicketState } from "../raffle/types";
import { Panel } from "../ui/Panel";

const emptyMetadata = createEmptyMetadata();

function formatSompi(value: bigint) {
  return value.toString();
}

export function App() {
  const [rpcUrl, setRpcUrl] = useState("wss://node.example.com:PORT");
  const [nodeStatus, setNodeStatus] = useState<KaspaNodeStatus>({
    connected: false,
    network: "unknown",
    syncStatus: "unknown"
  });
  const [rpcError, setRpcError] = useState("");
  const [wallet, setWallet] = useState<BrowserTestWallet | null>(null);
  const [metadata, setMetadata] = useState<RaffleMetadata>(emptyMetadata);
  const [creatorSecret, setCreatorSecret] = useState("");
  const [buyerSecret, setBuyerSecret] = useState("");

  const round = useMemo<RoundState>(() => {
    const ticketPrice = BigInt(metadata.ticketPrice || "0");
    return {
      appId: "KASPA_RAFFLE_ROUND_V1",
      roundId: metadata.roundId || "pending-round",
      creator: wallet?.address ?? "no-wallet",
      ticketPrice,
      maxTickets: metadata.maxTickets,
      minTickets: metadata.minTickets,
      soldTickets: 0,
      potAmount: 0n,
      feeBps: 0,
      status: "Open",
      randomnessMode: "commit-reveal",
      creatorCommitment: metadata.creatorCommitment,
      ticketRoot: ""
    };
  }, [metadata, wallet]);

  const tickets = useMemo<TicketState[]>(() => [], []);
  const verification = useMemo(() => verifyRaffleState({ round, tickets }), [round, tickets]);

  async function handleConnect() {
    setRpcError("");

    try {
      setNodeStatus(await connectBrowserRpc(rpcUrl));
    } catch (error) {
      setRpcError(error instanceof Error ? error.message : "Unable to connect to node.");
      setNodeStatus((current) => ({ ...current, connected: false }));
    }
  }

  async function handleGenerateCreatorSecret() {
    const secret = randomHex(32);
    const commitment = await creatorCommitment(secret);
    setCreatorSecret(secret);
    setMetadata((current) => ({
      ...current,
      roundId: `round-${randomHex(8)}`,
      creatorCommitment: commitment
    }));
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
          <div className="button-row">
            <button type="button" onClick={handleConnect}>
              <Plug size={17} />
              Connect
            </button>
            <button type="button" className="secondary" onClick={() => setNodeStatus({ connected: false, network: "unknown", syncStatus: "unknown" })}>
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
              <dt>Latency</dt>
              <dd>{nodeStatus.latencyMs ? `${nodeStatus.latencyMs} ms` : "unknown"}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Wallet" eyebrow="Browser local">
          <div className="button-row">
            <button type="button" onClick={() => setWallet(createPlaceholderWallet())}>
              <KeyRound size={17} />
              Generate
            </button>
            <button type="button" className="secondary">
              <Upload size={17} />
              Import
            </button>
          </div>
          <dl className="stat-list">
            <div>
              <dt>Address</dt>
              <dd className="mono">{wallet?.address ?? "not generated"}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd>{wallet ? `${formatSompi(wallet.balanceSompi)} sompi` : "unknown"}</dd>
            </div>
          </dl>
          <button type="button" className="secondary wide">
            <RefreshCw size={17} />
            Refresh balance
          </button>
        </Panel>

        <Panel title="Create Round" eyebrow="Commit reveal">
          <div className="two-column">
            <label className="field">
              <span>Ticket price</span>
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
              <dd>{formatSompi(round.potAmount)} sompi</dd>
            </div>
            <div>
              <dt>Tickets</dt>
              <dd>{tickets.length}</dd>
            </div>
          </dl>
          <div className="empty-state">
            <Ticket size={24} />
            <p>No chain scanner events loaded yet.</p>
          </div>
        </Panel>

        <Panel title="Buy Ticket" eyebrow="Ticket UTXO">
          <button type="button" onClick={() => setBuyerSecret(randomHex(32))}>
            <Ticket size={17} />
            Generate buyer secret
          </button>
          <dl className="stat-list">
            <div>
              <dt>Buyer secret</dt>
              <dd className="mono">{buyerSecret || "pending"}</dd>
            </div>
          </dl>
          <button type="button" className="secondary wide">
            Buy ticket
          </button>
        </Panel>

        <Panel title="Finalize / Refund" eyebrow="Anyone can finalize">
          <div className="button-row">
            <button type="button" className="secondary">
              Close round
            </button>
            <button type="button" className="secondary">
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

