# Kaspa Raffle Static V0

Static, testnet-first raffle dApp for Kaspa Toccata.

The app is designed to run without a project-controlled backend. Users provide a browser-compatible Kaspa wRPC endpoint, manage a local test wallet, build covenant transactions in the browser, and reconstruct raffle state from chain data.

## Current Status

This repository starts Milestone 1:

- Static Vite + React + TypeScript app shell
- One-page raffle operations console
- Local UI state and metadata helpers
- Browser-side Kaspa wRPC connection and test wallet import/generation
- Browser-side testnet ticket purchase transactions
- Raffle covenant source draft in Silverscript
- REST explorer history grouped by raffle round
- Shareable round links for participant entry
- Development verification gates for buyer flow and covenant payout readiness
- Original product spec in [`docs/kaspa_toccata_static_raffle_spec.md`](docs/kaspa_toccata_static_raffle_spec.md)
- Development backlog in [`docs/backlog.md`](docs/backlog.md)

The current payment flow is a legacy test harness, not the final covenant design. The app now refuses to present signer-key payout as a contract. Real automatic payout requires compiling `src/contracts/raffle_round.sil`, committing the compiled artifact under `src/contracts/compiled/`, and wiring browser-side transaction v1 covenant spends. Historical ticket and payout lookup currently uses `https://api-tn10.kaspa.org` full-transaction indexing because the node RPC is UTXO-focused.

## Covenant Direction

The intended V0 covenant keeps the pot in a `RaffleRound` covenant UTXO. Ticket purchases spend the current round state into the next state. Finalization reveals the creator secret, computes the winner from `roundId`, `ticketRoot`, and the reveal, terminates the covenant, and requires output 0 to pay the winner. No treasury private key should be needed after the round UTXO is created.

## Testnet Notes

Default local testing targets TN12/Toccata:

- wRPC: `ws://tn12-node.kaspa.com:17210`
- network id: `testnet-12`
- initial ticket price: `20000000` sompi, or `0.2 KAS`
- initial ticket bounds: 1 to 3 tickets

Create a local experiment wallet:

```bash
node scripts/create-experiment-wallet.mjs testnet-12
```

Wallet files are written under `wallets/`, which is intentionally ignored by Git.

As of the manual check on 2026-07-08, `https://faucet-tn12.kaspanet.io/` returned HTTP 403, `https://faucet-tn11.kaspanet.io/` reported maintenance, and the generic faucet redirected to TN10 with 0 TKAS available for the current IP. TN12 funds may need to come from mining or the Kaspa Discord `#testnet` channel until a faucet is available again.

Manual transaction testing on 2026-07-08 showed that `0.1 KAS` ticket outputs are rejected by current Toccata storage-mass rules with `Storage mass exceeds maximum`. `0.2 KAS` ticket outputs are accepted, so local end-to-end testing starts there.

## Development

```bash
npm install
npm run dev
```

Build static assets:

```bash
npm run build
```

The build output is `dist/` and should be deployable to GitHub Pages, IPFS, Arweave, Nginx, or any static file host.

Run the current development gate:

```bash
npm run verify
```

Run the covenant release gate:

```bash
npm run verify:covenant
```

The covenant release gate is expected to fail until `raffle_round.sil` is compiled and browser-side covenant transaction builders are wired. See [`docs/development-verification-loop.md`](docs/development-verification-loop.md).

Compile the covenant source with the local Silverscript checkout:

```bash
npm run compile:contract
```

The compiler toolchain runs locally now. The raffle source is still blocked by current Silverscript byte-array state support, so the app keeps covenant payout disabled.

## Safety

This app is experimental and intended for testnet or dedicated small-value wallets only. Do not import a main wallet seed. A static page can still be modified by whoever serves it, and a malicious page can steal browser-local secrets.
