# Kaswin

English | [中文](README.zh-CN.md)

Kaswin is a lottery protocol and single-page application on Kaspa L1, built with SilverScript contracts and a JavaScript/TypeScript client. Rolling is now the main source implementation, using one active shard and frozen shards for ticket history. The application is scoped to **Testnet 10 only**; mainnet is not supported.

The candidate Profile is `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`, with status **UNVALIDATED**. Post-reorganization unified core compilation/check (`16` sources / `48` outputs), isolated candidate HTML build, contract/VM/differential tests (`58/58`), unit tests (`105/105`), and offline Playwright/evidence tests (`14/14`) have been verified by `tester`; existing `dist/` pages and live deployment remain untouched (`NOT_RUN` for new live chain runs or deployment switches).

## Getting started

Requires Node.js 22 or newer. For a subsequent, explicitly authorized build, run from the repository root:

```sh
npm ci
npm run build
```

`npm run build` defaults to TN10; `npm run build:tn10` is an alias for the same target. There is no supported mainnet build mode. The main entry, `build/build.mjs`, exports `buildKaswin` and produces:

```text
dist/
  index.html
  build-manifest.json
```

The build compiles the unified TypeScript core, bundles the app and embeds the pinned contract artifacts into a self-contained HTML file. It does not recompile SilverScript. The manifest describes the resulting artifact and its inputs; it does not certify tests, node compatibility or production approval. A future build replaces these output files; the files already present are not evidence that the reorganized source has been built.

## Project layout

```text
build/       unified core compilation, HTML bundling, explicit contract tools
contracts/   five SilverScript sources, templates, pinned artifacts and pins
scripts/     protocol core, chain access, rounds, storage, tracking and wallets
web/         app orchestration in app/; templates, styles and views in ui/
tests/       contracts/ and VM; web/ integration; unit/; helpers/
docs/        architecture, development, reorganization and Rolling history
```

The main runtime entry is `scripts/core.mjs`. Rolling protocol code and shared primitives live together in `scripts/core/src/`; `build/core.mjs` generates `scripts/core/lib/`. There is no second Rolling core build. The read-only indexer lives in `scripts/indexer/`, while the browser's index client lives in `scripts/round/`.

The web entry is `web/app/app.ts`. Shared translations are in `web/ui/messages-common-en.mjs`; Rolling translations are in `web/ui/messages-en.mjs`. See the [runtime directory](scripts/README.md), [web directory](web/README.md) and [contracts](contracts/README.md).

## Contracts, network and transaction status

Rolling uses the `sales`, `sealed`, `win`, `refund` and `frozen` templates. Fixed `.sil` sources and `artifacts/*.json` are under `contracts/`, template inputs under `contracts/templates/`, and identity pins in `contracts/pins.json`. `build/compile-contracts.mjs` and `build/prepare-sources.mjs` are explicit contract regeneration tools, separate from normal HTML bundling.

Default nodes follow the former V2.0.2 `TN10.web.nodes` configuration in `scripts/chain/tn10.mjs`; the default indexer is `https://indexer.kaspay.top/tn10`. These are configuration defaults, with no availability or Rolling API compatibility check performed in this migration. Wallet modules cover memory signing and extension integrations, including KasWare, Kastle and Kaspire; migrated integrations have not been retested.

Block inclusion is not transaction acceptance. Indexer/REST data supports discovery; clients must verify accepted transactions and state against their node and protocol rules. Amounts are handled as bigint or decimal strings. Source migration does not convert V2.0.2 rounds or approve the Rolling Profile.

See the [architecture](docs/ARCHITECTURE.md), [development guide](docs/DEVELOPMENT.md) and [reorganization record](docs/REORGANIZATION.md). [Rolling historical records](docs/rolling/README.md) and the [earlier integration handoff](docs/ROLLING-INTEGRATION-HANDOFF.md) retain their original evidence boundaries; their results do not apply automatically to this layout.
