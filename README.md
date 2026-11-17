# Kaswin

English | [中文](README.zh-CN.md)

Kaswin is a lottery protocol and single-page application on Kaspa L1, built with SilverScript contracts and a JavaScript/TypeScript client. It uses an active shard and frozen shards for ticket history and targets **Testnet 10** (`UNVALIDATED` Profile `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`).

## Getting started

Requires Node.js 22 or newer:

```sh
npm ci
npm run build
```

`npm run build` (`npm run build:tn10`) builds the Testnet 10 bundle via `build/build.mjs` (`buildKaswin`) and outputs:

```text
dist/
  index.html
  build-manifest.json
```

The build compiles the TypeScript core (`build/core.mjs`), bundles the web app, and embeds the pinned contract artifacts into a self-contained HTML file without recompiling SilverScript.

## Project layout

```text
build/       core compilation, HTML bundling, contract tools
contracts/   five SilverScript sources, templates, pinned artifacts and pins
scripts/     protocol core, chain access, rounds, storage, tracking, indexer and wallets
web/         app orchestration in app/; templates, styles and views in ui/
tests/       contracts/ and VM; web/ integration; unit/; helpers/
docs/        architecture, development and protocol documentation
```

- Runtime entry: `scripts/core.mjs` (compiled from `scripts/core/src/` into `scripts/core/lib/`).
- Indexer & client: `scripts/indexer/` (read-only indexer) and `scripts/round/` (browser client).
- Web entry: `web/app/app.ts`; translations: `web/ui/messages-common-en.mjs` and `web/ui/messages-en.mjs`. See [scripts/README.md](scripts/README.md), [web/README.md](web/README.md), and [contracts/README.md](contracts/README.md).

## Contracts, network and transaction model

- **Contracts**: Uses `sales`, `sealed`, `win`, `refund`, and `frozen` templates under `contracts/` (`contracts/templates/`, `contracts/artifacts/`, `contracts/pins.json`). `build/compile-contracts.mjs` and `build/prepare-sources.mjs` handle explicit contract regeneration separately from HTML bundling.
- **Network & wallets**: Default TN10 nodes are configured in `scripts/chain/tn10.mjs`; default indexer is `https://indexer.kaspay.top/tn10`. Wallet modules support local memory signing and KasWare, Kastle, and Kaspire extensions.
- **Verification**: Block inclusion is not transaction acceptance. Indexer/REST data provides read-only discovery; clients verify accepted transactions and state against their node and protocol rules. Amounts are represented as `bigint` or decimal strings.

See [architecture](docs/ARCHITECTURE.md) and [development guide](docs/DEVELOPMENT.md).
