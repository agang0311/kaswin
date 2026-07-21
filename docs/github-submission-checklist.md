# GitHub submission checklist for 0.9.13.2

This checklist prepares the current worktree for review and commit. It does not authorize a network release.

## Identity to review

- App version: `0.9.13.2`
- Protocol: `raffle-vnext-liveness-guard-b1000`
- Round artifact SHA-256: `215aaae53f9a3d71fef0cf6deb8783582a36c212cd3bb9a67bedb7a850206f3d`
- Refund artifact SHA-256: `bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2`
- Single-file SHA-256: `ee77f7ef696b6e1d5451c7d998451acd83458882aa276abe04b357469a00d1b2`

## Completed locally

- [x] `npm run verify`
- [x] `npm run validation:local`
- [x] Same-workspace double build and stable source fingerprint
- [x] Recompiling current runtime artifacts twice produces byte-identical artifact JSON (no wall-clock metadata)
- [x] Contract VM accepts `max_batches = 1000` and rejects 1001
- [x] Browser-visible 10-minute/60-minute/2-hour recommendation checks
- [x] Old 0.9.12 protocol quarantined from current spending
- [x] No embedded private key or mnemonic in source or release HTML
- [x] Current protocol, artifact hashes, compatibility docs and changelog synchronized
- [x] Exact-artifact Mainnet Create → Registry → Buy → sold-out Draw smoke recorded
- [x] Registry stale-UTXO regression excludes Create inputs and waits for exact parent confirmation
- [x] Chinese and English README files state the exact applicable covenant version and artifact hashes
- [x] Deadline rescue buy is integrated as a guarded one-ticket settlement path, with covenant-input DAA checked before any wallet signature
- [x] Wallet connections and account refreshes are pinned to the currently connected node network

## Must remain blocked before a public release

- [ ] Exact-hash Testnet 10 A–E evidence for the b1000 artifact
- [ ] Mainnet below-minimum refund smoke (sold-out path completed)
- [ ] KasWare, Kastle, mobile and second-profile recovery E2E
- [ ] Static HTTPS/subpath verification
- [ ] Clean-environment locked-dependency reproducibility
- [ ] Independent security audit with assessed Critical/High findings

## Suggested review and commit sequence

1. Review `git diff --check`, the full diff and generated artifact changes.
2. Confirm `validation/manifest.json` still reports `sourceChangedDuringVerify: false`, `testnetPassed: false` and `mainnetSmokePassed: false`.
3. Commit source, contract, UI and tests together because they share one protocol identity.
4. Commit documentation, compatibility mapping, changelog and validation evidence either in the same atomic protocol commit or an immediately following evidence commit.
5. If v0.9.13.2 is published before every external blocker is closed, mark it as a GitHub **pre-release integration candidate** and keep every blocker visible in the Release notes. Do not describe it as production-ready.

Suggested commit title:

```text
Integrate guarded deadline rescue settlement and wallet network checks
```
