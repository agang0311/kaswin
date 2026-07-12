# Kaspa Raffle Static V0

Static raffle dApp for Kaspa Toccata with Mainnet and Testnet 10 profiles.

The app is designed to run without a project-controlled backend. Users provide a browser-compatible Kaspa wRPC endpoint, connect a supported browser wallet, approve funding transaction signatures in the wallet, and reconstruct raffle state from chain data.

## Documentation

- [中文用户指南](docs/user-guide.zh-CN.md)
- [中文技术指南](docs/technical-guide.zh-CN.md)
- [Development verification loop](docs/development-verification-loop.md)
- [Current project status and backlog](docs/backlog.md)
- [Original design specification](docs/kaspa_toccata_static_raffle_spec.md) - historical design input; some flows have since been superseded.

## Current Status

The current v0.1.14 implementation includes:

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
- Browser-side testnet ticket purchase transactions
- Raffle covenant source draft in Silverscript
- REST explorer history grouped by raffle round
- Shareable round links for participant entry
- Development verification gates for buyer flow and covenant payout readiness
- Original product spec in [`docs/kaspa_toccata_static_raffle_spec.md`](docs/kaspa_toccata_static_raffle_spec.md)
- Development backlog in [`docs/backlog.md`](docs/backlog.md)

The current flow builds browser-side Toccata covenant transactions for round creation, batched ticket buys, direct finalize, and timeout refunds. One purchase can cover many sequential ticket numbers, allowing up to 1,000,000 tickets while keeping at most 20 on-chain purchase batches. New testnet rounds use a round-specific open development oracle key that any browser can reconstruct after loading history, so the creator does not need to return for finalization. This convenience mode is not a production randomness oracle; legacy rounds created with random creator-only oracle keys still require the original browser, an external attestation, or timeout refund. Historical ticket and payout lookup currently uses `https://api-tn10.kaspa.org` full-transaction indexing because the node RPC is UTXO-focused.

## Covenant Direction

The covenant keeps the pot in a `RaffleRound` covenant UTXO. Ticket purchases spend the current round state into the next state. Each purchase stores its ending ticket number and owner public key, so finalize can prove that the payout address owns the winning ticket without storing one owner per ticket. The oracle public key and ticket root remain native `byte[32]` state fields. Finalization is valid only when all tickets have sold or the configured DAA deadline has arrived. It computes the winner, verifies the owner, pays the prize, and refunds the carrier to the creator in the same transaction.

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
- contract limit: 1,000,000 tickets across at most 20 purchase batches
- round carrier reserve: `0.2 KAS` by default with a `0.1 KAS` storage-safe minimum. New v3.5 rounds deduct `0.02 KAS` at finalize and return the remainder to the creator.
- registry marker: `0.05 KAS` is sent through a storage-safe staging transaction. The Testnet default registry returns `0.049 KAS` after a `0.001 KAS` refund fee. The Mainnet default and custom registries retain the marker under the destination address owner's control.
- temporary covenant funding is sized from the payment plus the action fee, with a `0.2 KAS` minimum for small payments; eligible change is returned in the same covenant transaction.

Install KasWare or Kastle, select a Kaspa testnet account, then choose the detected provider from **Connect wallet**. Wallet connection is requested only after a wallet is selected.

As of the manual check on 2026-07-08, `https://faucet-tn12.kaspanet.io/` returned HTTP 403, `https://faucet-tn11.kaspanet.io/` reported maintenance, and the generic faucet redirected to TN10 with 0 TKAS available for the current IP. TN12 funds may need to come from mining or the Kaspa Discord `#testnet` channel until a faucet is available again.

Manual transaction testing on 2026-07-12 confirmed the v3.4 low-fee create, marker, buy, finalize, History-load, and timeout-refund paths. The v3.5 build additionally runs `npm run verify:fees:1m`, which constructs 1,000,000-ticket Toccata v1 fixtures for create, one-batch buy, the twentieth buy, finalize, and timeout refund. The fixed fees remain `0.002`, `0.02`, `0.02`, and `0.03 KAS`; v3.4 and v3.3 artifacts remain available for historical rounds. A maximally skewed 20-batch refund is also tested and correctly reported as non-standard because its small outputs exceed storage mass; increasing its fee would not fix that transaction shape.

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

Run the current development gate:

```bash
npm run verify
```

Run the covenant release gate:

```bash
npm run verify:covenant
```

The covenant release gate requires the compiled Silverscript artifact and wired browser-side covenant transaction builders. See [`docs/development-verification-loop.md`](docs/development-verification-loop.md).

Compile the covenant source with the local Silverscript checkout:

```bash
npm run compile:contract
```

The compiler toolchain runs locally now. The raffle source stores oracle public key and ticket root as fixed `byte[32]` covenant state fields and the browser encoder writes the same state layout produced by the compiler.

## Safety

This app is experimental. Mainnet transactions use real KAS; review the selected network, node, wallet, and every signature request before approving it. A static page can still be modified by whoever serves it.
