# Kaspa Raffle Static V0

Static, testnet-first raffle dApp for Kaspa Toccata.

The app is designed to run without a project-controlled backend. Users provide a browser-compatible Kaspa wRPC endpoint, connect KasWare Wallet, approve funding transaction signatures in the wallet, and reconstruct raffle state from chain data.

## Current Status

This repository starts Milestone 1:

- Single-file React + TypeScript SPA build
- Focused one-page raffle workspace with technical details collapsed by default
- Local UI state and metadata helpers
- Browser-side Kaspa wRPC connection and KasWare Wallet connection
- Funding transactions signed through KasWare `signPskt`; the page never receives the wallet private key
- Browser-side testnet ticket purchase transactions
- Raffle covenant source draft in Silverscript
- REST explorer history grouped by raffle round
- Shareable round links for participant entry
- Development verification gates for buyer flow and covenant payout readiness
- Original product spec in [`docs/kaspa_toccata_static_raffle_spec.md`](docs/kaspa_toccata_static_raffle_spec.md)
- Development backlog in [`docs/backlog.md`](docs/backlog.md)

The current flow builds browser-side Toccata covenant transactions for round creation, batched ticket buys, direct finalize, and timeout refunds. One purchase can cover many sequential ticket numbers, allowing up to 1,000 tickets while keeping at most 20 on-chain purchase batches. New testnet rounds use a round-specific open development oracle key that any browser can reconstruct after loading history, so the creator does not need to return for finalization. This convenience mode is not a production randomness oracle; legacy rounds created with random creator-only oracle keys still require the original browser, an external attestation, or timeout refund. Historical ticket and payout lookup currently uses `https://api-tn10.kaspa.org` full-transaction indexing because the node RPC is UTXO-focused.

## Covenant Direction

The covenant keeps the pot in a `RaffleRound` covenant UTXO. Ticket purchases spend the current round state into the next state. Each purchase stores its ending ticket number and owner public key, so finalize can prove that the payout address owns the winning ticket without storing 1,000 owners. The oracle public key and ticket root remain native `byte[32]` state fields. Finalization is valid only when all tickets have sold or the configured DAA deadline has arrived. It computes the winner, verifies the owner, pays the prize, and refunds the carrier to the creator in the same transaction.

## Testnet Notes

Default local testing targets the public Toccata testnet endpoint:

- wRPC: `ws://tn12-node.kaspa.com:18210`
- network id: use the network reported after connecting; as of 2026-07-09 this endpoint reports `testnet-10`
- initial ticket price: `30000000` sompi, or `0.3 KAS`
- default round size: 10 tickets
- contract limit: 1,000 tickets across at most 20 purchase batches
- round carrier reserve: `5000000000` sompi, or `50 KAS`; this keeps the covenant UTXO above current storage-mass limits and is refunded to the creator at finalize when large enough.
- temporary covenant funding reserve: at least `1000000000` sompi, or `10 KAS`; this is returned during the ticket or registry transaction when possible.

Install KasWare Wallet, select a Kaspa testnet account, then use **Connect wallet** in the page. Wallet connection is requested only after that button is clicked.

As of the manual check on 2026-07-08, `https://faucet-tn12.kaspanet.io/` returned HTTP 403, `https://faucet-tn11.kaspanet.io/` reported maintenance, and the generic faucet redirected to TN10 with 0 TKAS available for the current IP. TN12 funds may need to come from mining or the Kaspa Discord `#testnet` channel until a faucet is available again.

Manual transaction testing on 2026-07-09 and 2026-07-10 showed that low-value covenant outputs can be rejected by current Toccata storage-mass rules. Local end-to-end ticket testing starts at `0.3 KAS`, and round creation uses a configurable carrier reserve that defaults to `50 KAS` for the covenant output.

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

This app is experimental and intended for testnet or dedicated small-value wallets only. Review every wallet signature request before approving it. A static page can still be modified by whoever serves it.
