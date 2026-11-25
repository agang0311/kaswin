# Kaswin

**Permissionless, serverless on-chain raffles on Kaspa L1.**

English | [中文](README.zh-CN.md) · [Live App](https://win.kaspay.top) · [Releases](https://github.com/agang0311/kaswin/releases) · [Changelog](CHANGELOG.md)

Kaswin is an open-source Kaspa Layer-1 raffle protocol and static single-page web application built with [SilverScript](https://github.com/kaspanet/silverscript) covenants and a TypeScript/JavaScript client. Funds are held exclusively by L1 covenant scripts—there is no backend operator, no admin key, and no platform fee.

## Highlights

- **100% On-Chain Covenant Custody** — Ticket funds and prize payouts are enforced directly by Kaspa L1 covenants. **0% platform fee**; participants only pay Kaspa network fees.
- **Multi-Asset Protocol Plugins** — Ships with two L1 covenant protocols out of the box:
  - **`kUSDT` (KCC-20, `kusdt-v2`)** — Mainnet stablecoin raffles with up to 8 parallel open ticket channels for concurrent buying.
  - **`KAS` / `TKAS` (`rolling-v1`)** — Native Kaspa raffles on Mainnet and Testnet 10 using a rolling active shard and unbounded frozen shards.
- **Independently Verifiable Fairness** — After close, the winning ticket is derived from a future on-chain block commitment via `BLAKE2b-256`. Every drawn round includes built-in local recomputation and a one-click, zero-dependency Python 3 verification script.
- **Serverless & Self-Hostable** — Compiles into a self-contained static web bundle (`dist/index.html` + `dist/kaspire-wc.js`) that connects directly to Kaspa nodes over wRPC and an optional read-only indexer.
- **Permissionless Settlement & Refunds** — Anyone can advance closing, drawing, payouts, or refunds. If a round closes below the minimum ticket threshold (or hits the draw timeout), all ticket funds and the creator deposit are refunded to their original senders.
- **Wallet Support** — Works with **KasWare**, **Kastle**, **Kaspire** (WalletConnect), and watch-only recipient addresses. Mainnet disables in-memory plaintext private keys; Testnet 10 retains them for testing.

## How It Works

1. **Create** — Choose `kUSDT` or `KAS`, ticket price, and draw duration, then lock a refundable creator deposit (4 KAS, returned on settlement).
2. **Buy** — Anyone buys tickets before the round closes. Ticket records are committed on-chain inside covenant shards.
3. **Close & Draw** — Once the closing DAA is reached, anyone can seal the round. If the minimum ticket count is met, the draw waits for the target block confirmation depth and selects the winning ticket deterministically from the on-chain block commitment.
4. **Payout or Refund** — If a winner is drawn, anyone can trigger prize payout (batchable across frozen shards on `rolling-v1`, or per-shard on `kusdt-v2`). If the minimum ticket count is not reached or the draw window times out, anyone can trigger full ticket refunds.

## Built-in Protocols & Contract Profiles

Each protocol is pinned by a deterministic 64-hex Contract Profile ID compiled into the bundle:

| Protocol | Asset | Networks | Sharding Model | Contract Profile ID |
|---|---|---|---|---|
| `kusdt-v2` | `kUSDT` (KCC-20) | Mainnet | Up to 8 parallel open shards | `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445` |
| `rolling-v1` | `KAS` / `TKAS` | Mainnet, Testnet 10 | Rolling active shard + frozen shards | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` |

- **Profile Isolation**: Rounds created under an older or different Profile ID are isolated under **Incompatible rounds** (read-only) so protocol upgrades never silently mix states. Historical rounds can always be operated using the matching historical build from [Releases](https://github.com/agang0311/kaswin/releases).
- **Pruning Resilience**: After `DRAW`, remaining shards can still be settled even if a node prunes older blocks, as long as `redeemScript` preimages are available from local browser storage, a KCI indexer, REST fallback, or an exported/shared round snapshot.

## Build & Self-Host

Requires **Node.js 22+**:

```sh
npm ci
npm run build        # Mainnet-default bundle (switchable to Testnet 10 in Settings)
# or:
npm run build:tn10   # Testnet 10-default bundle
```

Outputs in `dist/`:

```text
dist/
  index.html           # Self-contained SPA with pinned contract artifacts & CSP hash
  kaspire-wc.js        # Lazy-loaded WalletConnect bundle for Kaspire (SRI-pinned)
  build-manifest.json  # Reproducible input hashes, version, and compatibleProfiles
  _headers             # Security headers for static hosts (e.g. Cloudflare Pages)
```

Serve `dist/` on any static host or open locally. To override default endpoints at build time without editing source files, pass CLI flags (`--mainnet-indexer`, `--tn10-indexer`, `--mainnet-node`, `--tn10-node`) or the corresponding `KASWIN_*` environment variables.

## Security & Verification Boundaries

- **Experimental Software**: Contract profiles are currently marked `UNVALIDATED` and have not undergone a formal third-party security audit. Review contract rules and transaction previews before committing mainnet funds.
- **Node-Verified State**: On Kaspa L1, block inclusion does not equal transaction acceptance. Indexers and REST endpoints are used only for read-only discovery; the client verifies UTXO state and transaction acceptance directly against the connected Kaspa node and protocol rules.
- **Key Hygiene & Precision**: Private keys never leave browser extension wallets or mobile WalletConnect signers on Mainnet (in-memory plaintext keys are disabled on Mainnet). All monetary amounts are handled as `bigint` or decimal strings.

## Repository Layout

```text
contracts/   SilverScript sources, templates, and pinned artifacts (rolling-v1 & kusdt-v2)
scripts/     Core codec/crypto/mass (TS), protocol plugins, chain RPC, round controller, wallets & indexer
web/         TypeScript SPA orchestration (app/) and views, styles, locales (ui/)
build/       Core TS compiler, protocol bundle loader, static HTML builder & contract tools
tests/       Unit, contract/VM, and browser regression suites
docs/        Architecture, development guide, and protocol specifications
```

## Documentation

- [Architecture Overview](docs/ARCHITECTURE.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Contracts (`rolling-v1`)](contracts/README.md) · [Contracts (`kusdt-v2`)](contracts/kusdt-v2/README.md)
- [Runtime & Protocol Scripts](scripts/README.md) · [Web Client](web/README.md)
- [Changelog & Profile Compatibility Policy](CHANGELOG.md)
