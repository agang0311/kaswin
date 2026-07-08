# Kaspa Raffle Static V0

Static, testnet-first raffle dApp for Kaspa Toccata.

The app is designed to run without a project-controlled backend. Users provide a browser-compatible Kaspa wRPC endpoint, manage a local test wallet, build covenant transactions in the browser, and reconstruct raffle state from chain data.

## Current Status

This repository starts Milestone 1:

- Static Vite + React + TypeScript app shell
- One-page raffle operations console
- Local UI state and metadata helpers
- Placeholder Kaspa RPC, wallet, scanner, and contract boundaries
- Original product spec in [`docs/kaspa_toccata_static_raffle_spec.md`](docs/kaspa_toccata_static_raffle_spec.md)
- Development backlog in [`docs/backlog.md`](docs/backlog.md)

Real Kaspa wRPC, Toccata covenant compilation, transaction building, and browser-side scanning are not implemented yet.

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

## Safety

This app is experimental and intended for testnet or dedicated small-value wallets only. Do not import a main wallet seed. A static page can still be modified by whoever serves it, and a malicious page can steal browser-local secrets.

