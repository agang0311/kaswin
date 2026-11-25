# Kaswin

English | [中文](README.zh-CN.md) | Live App: [https://win.kaspay.top](https://win.kaspay.top)

Kaswin is a lottery protocol and single-page application on Kaspa L1, built with SilverScript contracts and a JavaScript/TypeScript client. It uses an active shard and frozen shards for ticket history, defaults to **Kaspa Mainnet** (switchable to **Testnet 10**), and uses the `UNVALIDATED` Profile `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`.

## Getting started

Requires Node.js 22 or newer:

```sh
npm ci
npm run build
```

`npm run build` builds the Mainnet-default bundle (`npm run build:tn10` passes `--mode=tn10` for the Testnet 10-default bundle) via `build/build.mjs` (`buildKaswin`) and outputs:

```text
dist/
  index.html
  kaspire-wc.js
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

- Runtime entry: `scripts/core.mjs` (compiled from `scripts/core/src/` into `scripts/core/lib/`); covenant plugins: `scripts/protocols/` (`registry.mjs`, `installed.mjs`, `rolling-v1.mjs`, `kusdt-v2.mjs`) and `build/protocol-bundles.mjs`.
- Indexer & client: `scripts/indexer/` (read-only indexer) and `scripts/round/` (browser client).
- Web entry: `web/app/app.ts`; typed locale packs: `web/ui/locales/` (`schema.ts`, `zh-cn.ts`, `en.ts`, `index.ts`). See [scripts/README.md](scripts/README.md), [web/README.md](web/README.md), and [contracts/README.md](contracts/README.md).

## Contracts, network and transaction model

- **Contracts**: Uses `sales`, `sealed`, `win`, `refund`, and `frozen` templates under `contracts/` (`contracts/templates/`, `contracts/artifacts/`, `contracts/pins.json`). `build/compile-contracts.mjs` and `build/prepare-sources.mjs` handle explicit contract regeneration separately from HTML bundling.
- **Network & wallets**: Mainnet and Testnet 10 configurations live in `scripts/chain/mainnet.mjs` and `scripts/chain/tn10.mjs`; default KCI indexers are `https://indexer.kaspay.top/mainnet` and `https://indexer.kaspay.top/tn10`. Wallet modules support KasWare, Kastle, Kaspire (WalletConnect), and receive-only addresses; in-memory plaintext private keys are disabled on Mainnet and retained for testing on TN10.
- **Payouts, refunds & pruning**: `PAY_OLD` settles up to 16 sealed shards per transaction, and `REFUND_OLD` / `REFUND_SELF` process up to 32 records per batch; the web UI offers sequential batch payout and batch refund. Once past `DRAW`, remaining sealed shards can still be settled after node pruning as long as `redeemScript` preimages are available from local storage, KCI, REST API fallback, or exported/shared snapshots.
- **Verification**: Block inclusion is not transaction acceptance. Indexer/REST data provides read-only discovery; clients verify accepted transactions and state against their node and protocol rules. Amounts are represented as `bigint` or decimal strings.

See [architecture](docs/ARCHITECTURE.md) and [development guide](docs/DEVELOPMENT.md).
