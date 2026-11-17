# Rolling runtime

[中文](README.zh-CN.md)

The Rolling protocol has its own TypeScript core and runtime entry point, separate from the V2.0.2 contract. The fixed Rolling Profile is `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`; its candidate status remains `UNVALIDATED`.

## Layout

| Path | Purpose |
|---|---|
| `core/src/` | State encoding, Profile authentication, transaction construction, mass, accepted-transaction interpretation and recipient rules |
| `core/lib/` | Generated JavaScript and declarations; ignored by Git |
| `core.mjs` | Runtime entry point with the legacy call signatures and injected SHA-256/address codec |
| `indexer/` | Independent persistent TN10 read-only index service, maintained by the KCI implementation session |
| `../../web/rolling-tn10/` | Controller, durable intent/store, extension and memory wallets, index client and UI |
| `../../experiments/rolling/` | Contract artifacts, engine service, node/archive adapters and experiment tools |

The six original `experiments/rolling/{state,profile,transactions,mass,accepted,receiver}.mjs` modules remain as a differential reference. The Rolling page and the index/node/archive runtime use `scripts/rolling/core.mjs`. Build graph checks require the generated TS core and exclude the legacy core implementation from the browser bundle.

The main V2.0.2 page and its Profile are unchanged. Rolling remains explicitly scoped to Testnet 10.

## Build

```sh
npm run build:core
npm run build:rolling-core
npm run build:rolling
```

`build:rolling` generates the Rolling core before type-checking and bundling the page; if shared core declarations are missing it bootstraps the shared core first. Output is `dist/rolling-tn10.html` and `dist/rolling-tn10.manifest.json`. It does not replace the main page's `dist/index.html`. The manifest includes generated runtime files and TS source hashes.

Importing `core.mjs` never invokes a build. Node tools and the sidecar require the generated core to exist before startup.

```js
import {encode, decode, loadCandidateProfile, buildAction, quoteMass} from './core.mjs';
```

The runtime facade preserves `parseFrame(module,text,trust)`, `loadCandidateProfile(texts,pins)` and `rewardReceiver(address,context)`. Direct generated-module consumers still supply the hash/address dependencies explicitly. Use the runtime's `ResourceLimit` together with its `quoteMass`; a reference implementation's class has a different JavaScript identity.

## Wallets

The page offers KasWare, Kastle, the existing dedicated TN10 memory-key mode and a public reward address. Extensions must already be on Testnet 10; the page does not switch them automatically.

Only ordinary P2PK inputs selected by the page may be signed, with SIGHASH_ALL. The page compares the returned transaction's committed fields, verifies signatures locally, and copies only the authorized signature scripts into its own transaction. It then runs the existing signed-engine, persistence and node submission gates. The extension is not asked to broadcast. Account/network changes invalidate the connection and unsent quote; an unresolved persisted intent retains the original bytes.

## Index discovery

The index service is independent of the existing V2.0.2 KCI database. Its default private listener is `127.0.0.1:18212`; see [its configuration and API](indexer/README.md). An HTTPS page needs an accessible index API URL configured in Advanced Settings; a remote user's loopback address is not the server's loopback address.

With an index configured, users can discover rounds, join by CID/transaction ID and synchronize another participant's progress. REST is candidate data. The page obtains the head's selected-chain Full data from its own node, reconstructs spent contexts from the node's witnesses/amounts, interprets the transaction and verifies active manager/frozen UTXOs. Terminal states require the node-served transaction to establish the terminal effect. Local pending intents/candidates are not overwritten. Slow index requests run outside the record writer queue; final publication rechecks connection and local revision.

Without an index, share links and explicit imports remain available.

## Validation ownership and current status

Implementation of the wallet/index/TS integration is separate from its execution evidence. Testing, differential comparison, build checks, VM checks and browser regression are assigned to the **tester** session. Implementation sessions do not run those checks themselves.

Previous Rolling TN10 runs validate the recorded contract/page behavior under their original code and artifact hashes. They do not automatically validate this later runtime migration, injected extension API or new index service. The integration's current test record is maintained in [the implementation handoff](../../docs/ROLLING-INTEGRATION-HANDOFF.md); do not infer a pass from source availability or a successful build. No mainnet or TIMEOUT execution is included.
