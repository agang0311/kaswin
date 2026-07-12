# Kaspa Raffle Static V0

Static raffle dApp for Kaspa Toccata with Mainnet and Testnet 10 profiles.

The release UI is a self-contained static HTML file. Users provide a browser-compatible Kaspa wRPC endpoint and connect a supported browser wallet. Small rounds can still be reconstructed directly from explorer data; million-user rounds use the included optional indexer for current covenant cursors and Merkle witnesses.

## Documentation

- [中文用户指南](docs/user-guide.zh-CN.md)
- [中文技术指南](docs/technical-guide.zh-CN.md)
- [Development verification loop](docs/development-verification-loop.md)
- [Current project status and backlog](docs/backlog.md)
- [Original design specification](docs/kaspa_toccata_static_raffle_spec.md) - historical design input; some flows have since been superseded.

## Current Status

The current v0.3.0 implementation includes:

- Single-file React + TypeScript SPA build
- English and Chinese interfaces with a persistent language selector in the top-right corner
- Focused one-page raffle workspace with technical details collapsed by default
- Local UI state and metadata helpers
- Browser-side Kaspa wRPC connection and an extensible wallet adapter registry
- KasWare-style network menu with independent Mainnet and Testnet 10 node settings
- KasWare `signPskt` and Kastle `signTx` / `kas:sign_tx` adapters
- Funding transactions signed by the selected wallet; the page never receives the wallet private key
- Creator-selected Registry address with explicit marker amount, payment fee, and refund behavior
- Network-specific default Registry addresses; Mainnet uses `kaspa:qzrhkehvwlzpzh8dv9ecl8eadayyzhrqlkcldzfzu32mrgv2m9npqpc4a6ugh`
- One-ticket-per-purchase V5 rounds backed by a depth-20 append-only Merkle tree
- A compact 787-byte covenant state supporting 1,000,000 distinct ticket owners
- Participant-only finalize with winner and caller Merkle proofs
- Walletless timeout refunds that route once into a compact refund contract, repay 8 proven owners per transaction, and use single-ticket proofs only for a final 1-7 ticket tail
- A confirmed-chain, reorg-aware disk indexer that serves the latest covenant cursor, 640-byte ticket proofs, and 544-byte aligned 8-ticket range proofs
- Raffle covenant source draft in Silverscript
- REST explorer history grouped by raffle round
- Shareable round links for participant entry
- Development verification gates for buyer flow and covenant payout readiness
- Original product spec in [`docs/kaspa_toccata_static_raffle_spec.md`](docs/kaspa_toccata_static_raffle_spec.md)
- Development backlog in [`docs/backlog.md`](docs/backlog.md)

The current flow builds browser-side Toccata v1 transactions for round creation, single-ticket buys, direct finalize, and cursor-based timeout refunds. New testnet rounds still use a round-specific open development oracle key so the creator does not need to return. This key is intentionally recoverable and is not a production randomness source: a production release must use an independent verifiable or threshold oracle before real-value deployment.

Mainnet creation now disables the development-oracle mode and requires an external 32-byte x-only Schnorr public key plus an HTTPS endpoint. Any participant can fetch `GET /attestations/{roundId}?ticketRoot={hex}` during Draw & pay. The response accepts `{ "seed", "signature", "publicKey" }` (or `oracleSeed` / `oracleSignature` aliases); the browser verifies `signature` over `sha256(ticketRoot || seed)`, and the covenant verifies the same attestation again on chain. This repository defines and consumes that interface but does not operate or endorse an independent oracle service.

## Covenant Direction

The V5 normal path keeps the pot in one `RaffleRoundV5` UTXO. Every purchase appends `sha256(owner_pubkey)` to a depth-20 tree and stores only the root plus a 640-byte frontier. Finalize verifies both the winning ticket and the caller's participant proof, pays the prize, returns the caller authorization UTXO unchanged, and refunds the carrier atomically.

After timeout, anyone can broadcast `startRefund` to move the reduced five-field state into `RaffleRefundV1`; `RaffleRoundV5` verifies the destination template hash and state on chain. The refund contract then accepts an aligned 8-ticket range proof and forces eight P2PK outputs to those owners. At 1,000,000 tickets this reduces the worst case from 1,000,000 refund transactions to 125,000. V4 rounds remain loadable and retain their sequential `refundNext` path.

## Network Setup

Use the network menu at the left of the connection bar. Switching networks disconnects the current node and wallet and clears the local round view so transactions cannot cross networks.

- Mainnet default wRPC: `ws://127.0.0.1:18110`
- Mainnet history REST API: `https://api.kaspa.org`
- Testnet 10 default wRPC: `ws://tn12-node.kaspa.com:18210`
- Testnet 10 history REST API: `https://api-tn10.kaspa.org`

The local Mainnet endpoint assumes `kaspad` was started with JSON wRPC on port `18110` and UTXO indexing enabled. `127.0.0.1` works when the page and node run on the same computer. Use the gear button beside a network to change its wRPC endpoint; each endpoint is stored separately in the browser.

## Testnet Notes

Default local testing targets the public Toccata testnet endpoint:

- wRPC: `ws://tn12-node.kaspa.com:18210`
- network id: use the network reported after connecting; as of 2026-07-09 this endpoint reports `testnet-10`
- initial ticket price: `30000000` sompi, or `0.3 KAS`
- default round size: 10 tickets
- contract limit: 1,000,000 independent users, exactly one ticket per purchase
- round carrier reserve: `0.2 KAS` by default with a `0.1 KAS` storage-safe minimum. V5 finalize uses `0.022 KAS`. Starting timeout refunds uses `0.022 KAS`; each 8-ticket batch deducts `0.012 KAS` total (`0.0015 KAS` per ticket). Only a final 1-7 ticket tail uses the `0.019 KAS` single-ticket path.
- registry marker: `0.05 KAS` is sent through a storage-safe staging transaction. The Testnet default registry returns `0.049 KAS` after a `0.001 KAS` refund fee. The Mainnet default and custom registries retain the marker under the destination address owner's control.
- temporary covenant funding is sized from the payment plus the action fee, with a `0.2 KAS` minimum for small payments; eligible change is returned in the same covenant transaction.

Install KasWare or Kastle, select a Kaspa testnet account, then choose the detected provider from **Connect wallet**. Wallet connection is requested only after a wallet is selected.

As of the manual check on 2026-07-08, `https://faucet-tn12.kaspanet.io/` returned HTTP 403, `https://faucet-tn11.kaspanet.io/` reported maintenance, and the generic faucet redirected to TN10 with 0 TKAS available for the current IP. TN12 funds may need to come from mining or the Kaspa Discord `#testnet` channel until a faucet is available again.

The verification gate replays 1,000,000 distinct Merkle appends, validates first/middle/last single and range proofs, runs both the V4 compatibility and V5 SilverScript suites, checks exact Toccata mass, and starts a persistent index API fixture. V5 exact minimum relay fees are `0.013106 KAS` buy, `0.016226 KAS` finalize, `0.020318 KAS` refund transition, and `0.010776 KAS` per 8-ticket batch. Configured fees include a small margin. The batch transaction's measured storage mass is `316,267`, below the `500,000` standard limit.

The 2026-07-12 TN12 browser loop completed three V5 rounds: direct create/buy/finalize, History load followed by finalize, and an 8-ticket 10-second-timeout round followed by `startRefund` and one `refundBatch8`. The confirmed-chain index reported the final states as two `Finalized` rounds and one `Refunded` round with cursor 8.

`npm run benchmark:indexer:1m` builds a real one-million-record disk fixture. The 2026-07-12 run used `164,003,779` bytes, rebuilt a missing derived tree in `298.15s`, restarted from its checkpoint in `0.27s`, served first/middle/last proofs in `5.00/1.93/1.36ms`, and used `79,523,840` bytes RSS. The append-only event log, migration baseline, and fixed confirmation queue allow the indexer to rebuild after a selected-chain reorganization without retaining all ticket nodes in memory.

## Development

```bash
npm install
npm run dev
```

Build static assets:

```bash
npm run build
```

The build output is a self-contained `dist/index.html` with JavaScript, CSS, and Kaspa WASM embedded. It can be deployed as one file to GitHub Pages, IPFS, Arweave, Nginx, or any static file host.

Pushing a `v*` tag runs the release workflow, repeats `npm run verify`, and attaches the versioned single HTML plus its SHA-256 file to a GitHub prerelease.

Run the current development gate:

```bash
npm run verify
```

Run the confirmed-chain raffle indexer (required for practical million-user History, finalize, and refund witnesses):

```bash
npm run start:indexer
```

It listens on `http://127.0.0.1:8787` by default. Configure `KASPA_RPC_URL`, `KASPA_NETWORK`, `RAFFLE_INDEX_PORT`, `RAFFLE_INDEX_DATA`, and `RAFFLE_INDEX_CONFIRMATIONS` as needed. `RAFFLE_INDEX_REMOVE_BLOCKS` is a repair/testing hook for explicitly removing comma-separated event block hashes; `RAFFLE_INDEX_OFFLINE=1` is reserved for deterministic fixtures.

Witness endpoints include `GET /rounds/{roundId}/tickets/{ticketId}`, `GET /rounds/{roundId}/owners/{pubkey}/proof`, and `GET /rounds/{roundId}/ranges/{firstTicketId}/8`. Ticket ids are one-based; range starts must be aligned to 8 in zero-based contract space (`1`, `9`, `17`, ... in the API).

Run the covenant release gate:

```bash
npm run verify:covenant
```

The covenant release gate requires the compiled Silverscript artifact and wired browser-side covenant transaction builders. See [`docs/development-verification-loop.md`](docs/development-verification-loop.md).

Compile the legacy/default contract or the V5 round/refund pair with the local Silverscript checkout:

```bash
npm run compile:contract
npm run compile:contract:v5
```

The compiler toolchain runs locally now. The raffle source stores oracle public key and ticket root as fixed `byte[32]` covenant state fields and the browser encoder writes the same state layout produced by the compiler.

## Safety

This app is experimental. Mainnet transactions use real KAS; review the selected network, node, wallet, and every signature request before approving it. A static page can still be modified by whoever serves it.
