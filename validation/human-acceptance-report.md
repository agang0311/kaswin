# Human acceptance report — local candidate

Protocol: raffle-vnext-liveness-guard-b1000
App version: 0.9.13

## Overall conclusion

CONDITIONAL LOCAL PASS / RELEASE BLOCKED. The automated local suite passed for this evidence run, but this is not a statement that the system is complete or safe for public funds.

## P0/P1 local evidence

- Artifact hashes, version/document consistency, vNext state/negative VM cases, buyer-funded exact refund-fee allocation and carrier checks, transaction-shape mass, immutable signing-preview and rejection-recovery checks, Indexer proof/reorg simulation and single-file build were executed through `npm run verify`.
- 10,000 deterministic refund-conservation property cases passed. The two-build SHA-256 result is recorded verbatim in `release-sha256.txt` and must not be treated as a pass unless its status says `same-workspace-match`.
- The recorded offline one-million-range Indexer benchmark is included in `indexer-benchmark.json`; it is not a Testnet/Mainnet or vNext network-flow result.
- Historical Testnet vNext transactions are recorded for compatibility only. The current b1000 artifact has no accepted exact-hash Testnet transaction; A–E remain incomplete and `testnetPassed` remains false.
- A successful finalize VM fixture is explicitly unavailable in the local debugger; public closeEmpty is covered. Inspect `known-limitations.md` and `npm-verify.log`.

## Release blockers

- Testnet 10 A–E, including full draw/refund/recovery/stale/service-failure records.
- Mainnet small-value draw and refund smoke with isolated wallets.
- KasWare/Kastle and desktop/mobile E2E plus static HTTPS-host verification.
- Independent security audit and an assessed Critical/High defect register.
- A same-workspace mismatch/inconclusive result, if recorded in `release-sha256.txt`, plus a clean-environment build hash comparison for release reproducibility.

Do not change `testnetPassed`, `mainnetSmokePassed`, `criticalOpen`, or `highOpen` from this local generator without the corresponding external evidence.
