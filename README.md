# Kaswin

English | [中文](README.zh-CN.md)

A lottery protocol and single-page application on Kaspa L1, built with SilverScript contracts and a JavaScript/TypeScript client. The web app supports Testnet 10 and mainnet, the KasWare and Kastle wallets, and covers creating rounds, buying tickets, drawing, refunds, and verifying transaction status.

## Download

[Releases](https://github.com/agang0311/kaswin/releases) provide the prebuilt mainnet trading build `kaswin.html`, together with `build-manifest.json` and `SHA256SUMS`. Live version: https://win.kaspay.top/ .

## Getting started

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
```

The build first compiles the TypeScript core library, then produces a self-contained HTML file. Output:

```text
dist/
  index.html
  build-manifest.json
```

`index.html` can be deployed to any HTTPS static site. The manifest records the build mode, contract identity, toolchain versions, and source and artifact hashes; it contains no test results. The build does not access the network, use a wallet, or deploy the page.

## Build modes

| Command | TN10 | Mainnet |
|---|---|---|
| `npm run build` | read-only | read-only |
| `npm run build:tn10` | trading | read-only |
| `npm run build:mainnet` | trading | trading |

All modes write to the same `dist/`; each build replaces the previous output. The mode can also be passed explicitly, e.g. `npm run build -- --mode=mainnet`; supported modes are `readonly`, `tn10`, and `mainnet`.

Trading capability is fixed at build time; switching networks in the page does not change it. Mainnet uses real KAS, and every signature still requires the user's confirmation. TN10 additionally supports an in-page memory test wallet. A successful build only means the artifact was produced; business tests, real wallet flows, and on-chain verification are separate steps after the build. The project currently has no automated test entry point.

## Project layout

```text
build/       core library compilation and HTML bundling
contracts/   SilverScript sources, ledger layout, and pinned compiled artifacts
scripts/     protocol core, chain access, wallets, rounds, storage, and tracking
web/         app interaction, HTML templates, styles, and i18n
docs/        architecture and development notes
```

Core library sources live in `scripts/core/src/`; generated files are in `scripts/core/lib/`. `npm run build:core` compiles the core library alone; `npm run check:core` independently compares the generated files against the sources and is not a substitute for business tests.

## Contract and transactions

The current contract is V2.0.2, Profile `ed0387c9e77bb4e0a8f1f4654a326c316d83663f455283ec6a046a095c94856d`. The HTML build loads the pinned contract artifacts and checks that the source, templates, and Profile are consistent; it does not recompile SilverScript.

A Kaspa transaction being included in a block does not mean it is accepted. Indexer/REST data is used only for discovery; actual state is verified against the node's acceptance data and the protocol rules. Amounts are handled as bigint or decimal strings.

See the [architecture notes](docs/ARCHITECTURE.md) and [development notes](docs/DEVELOPMENT.md) (currently in Chinese).
