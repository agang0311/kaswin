# GitHub submission checklist for 0.9.13

This checklist prepares the current worktree for review and commit. It does not authorize a network release.

## Identity to review

- App version: `0.9.13`
- Protocol: `raffle-vnext-liveness-guard-b1000`
- Round artifact SHA-256: `215aaae53f9a3d71fef0cf6deb8783582a36c212cd3bb9a67bedb7a850206f3d`
- Refund artifact SHA-256: `bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2`
- Single-file SHA-256: `8504bf9798112d82b0c1514a1cf0e193ad079d3dfa891508ed8b1aa12f23f38d`

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
5. If v0.9.13 is published before every external blocker is closed, mark it as a GitHub **pre-release integration candidate** and keep every blocker visible in the Release notes. Do not describe it as production-ready.

Suggested commit title:

```text
Raise vNext purchase-batch cap to 1000 with duration guidance
```
