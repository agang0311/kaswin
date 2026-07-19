# vNext validation evidence matrix

This is the release-facing evidence matrix for `raffle-vnext-liveness-guard-b1000`, mapped to `docs/validation-requirements.zh-CN.md` and the original system validation specification. It distinguishes checked local evidence from evidence that can only be obtained on a real network. **Local pass is not a release approval.**

Status meanings:

- **Local pass** — a deterministic repository command checks the cited invariant in the current worktree.
- **Pending external** — requires a funded wallet, live node, browser/device, static host, or independent auditor; blocks release completion.
- **Not yet evidenced** — the specification requires it, but the current local suite does not establish it; also blocks a completion claim when P0/P1.

| Validation spec | Requirement / invariant | Status | Current evidence or next evidence |
| --- | --- | --- | --- |
| 6.1–6.2 | One manifest; app/protocol/contract names and redeem-script hashes agree | Local pass | `protocol-manifest.json`; `npm run verify:phase1`; `scripts/verify-protocol-release.mjs`; `scripts/verify-vnext-artifacts.mjs` |
| 6.3 | Known historical protocol guidance; unknown protocol is not mis-decoded | Local pass (local scope) | `docs/contract-compatibility.md`; metadata/Web requirement checks. Historical network operation is not vNext release evidence. |
| 7.1–7.6 | On-chain state machine: buy/finalize/refund/close exclusivity; `min_tickets` and `max_batches` are state fields | Local pass | `scripts/verify-vnext-contract.mjs` runs compiled-artifact VM behavior cases; `scripts/verify-vnext-integration.mjs` checks builder/state agreement. |
| 7.1–7.6 / 19 | Purchase-batch capacity policy: default 100, hard limit 1000, duration recommendation and batch 1001 rejection | Local pass / Pending external load evidence | Round VM accepts the 1000 bound and rejects 1001; protocol/Merkle/metadata/transaction/browser checks share the manifest limit; the UI recommendation is `max(1, min(1000, floor(seconds / 6)))`. Live concurrent stale-rate behavior at larger settings remains Testnet evidence. |
| 8.1–8.8 | Range buy accounting, bounds, Merkle successor, malformed-Genesis rejection and stale-buy recovery behavior | Local pass / Pending external | VM proves exact carrier floor/floor-minus-one, input root/frontier consistency and Top-up rejection of malformed state; the browser rebuilds the full owner/range history before opening the one Buy signing request. Simultaneous signed stale buy and browser recovery require fresh Testnet evidence. |
| 9.1–9.5 | Nonce-domain leaf encoding, incremental tree, proofs and cross-round replay rejection | Local pass | `scripts/verify-protocol-vnext.mjs`, `scripts/verify-vnext-contract.mjs`, `scripts/verify-indexer-vnext.mjs`. |
| 10.1–10.10 | Fixed selected-chain boundary, header/parent/seqcommit, winner proof/output and fee constraints | Local pass (VM/vector scope) | `scripts/verify-vnext-contract.mjs`, `scripts/verify-chain-randomness.mjs`, `scripts/verify-vnext-integration.mjs`. Live selected-chain data is still pending Testnet A/B. |
| 10.11 | Reorg witness discard and rebuild in the browser | Not yet evidenced | Indexer reorg rebuild is local; a live/browser target-witness reorg exercise is required. |
| 10.12 | Winner selection is bounded and cannot permanently fail | Local pass | `src/protocol/randomness.ts`; `scripts/verify-protocol-vnext.mjs`. Four bounded rejection attempts are followed by a documented deterministic modulo fallback; the tail-bias/liveness tradeoff is explicit. |
| 11.1–11.12 | Refund eligibility, state carry-over, fee deduction, cursor/proof rejection, minimum-ticket liveness, one-input transition shape and dynamic mass shrink | Local pass (artifact/transaction scope) | `scripts/verify-vnext-contract.mjs`, `scripts/verify-vnext-mass.mjs`, `scripts/verify-vnext-integration.mjs`. Start Refund and Refund Next reject extra inputs; relay-safe batch counts are measured from the current compiled script rather than equated with the ABI limit. |
| 11.13 | Sponsor input/signature/change mode | Not applicable to current artifact; Pending design if added | vNext deliberately rejects sponsor inputs. The current policy deducts transition/refund fees from selected ticket payments and proves a relay-safe minimum owner output; a future sponsor ABI requires new tests and wallet E2E. |
| 12.1–12.5 | Creation/buy/finalize/refund conservation, including randomized properties, integer bounds and committed execution budgets | Local pass (deterministic property scope) | `scripts/verify-protocol-vnext.mjs` executes 10,000 distinct deterministic refund-conservation shapes; Round/Refund VM and metadata/builder gates reject principal above `4611686018427387904` sompi. VM positive paths compare measured `SCRIPT_UNITS` with the same exported compute-budget constants used by transaction construction and mass fixtures. It is not live signed-transaction evidence. |
| 13.1–13.7 | Resolver, custom RPC, URL/network/sync/Toccata gates | Local pass (offline/simulated) / Pending external | `scripts/verify-mainnet-readiness.mjs`; real Resolver and node acceptance are Testnet/Mainnet work. |
| 14–15 | Wallet adapter, exact signing/output review, direct-signing counts, cache/history/stale recovery | Local pass (immutable/static transaction scope) / Pending external | `scripts/verify-signing-confirmation.mjs` checks previews and stale snapshots; `verify-web-requirements` proves Create/Registry use one direct request each, Buy uses one combined request, Top-up staging remains wallet P2PK, submission uncertainty preserves the deterministic txid, and a successful Genesis cursor is cached before Registry/balance side effects. Registry publication and the separate 0.19 KAS marker-return recovery both query accepted exact outpoint spends before retrying. KasWare/Kastle reloads and the revised direct transactions still require fresh Testnet evidence. |
| 16.1–16.7 | Indexer public-only behavior, proof verification, checkpoint/reorg and failure modes | Local pass (service simulation) / Pending external | `scripts/verify-indexer*.mjs`; real service-failure switch is Testnet E. |
| 17.1–17.9 | Browser create/buy/draw/refund, language, node/account switching and 390×844 mobile E2E | Local pass (layout/language only) / Pending external | Chrome local preview checked desktop, 390×844, Chinese/English, no horizontal overflow or console errors; screenshot: `validation/ui-kaswin-desktop.png`. Signed create/buy/draw/refund and second profile/device remain Testnet A–E. |
| 18.1–18.3 | One self-contained HTML, no external startup assets or embedded private credential | Local pass | `npm run build`, `scripts/verify-single-file.mjs`, `scripts/verify-protocol-release.mjs`. |
| 18.4–18.6 | HTTPS/subpath deployment, offline WASM initialization and browser compatibility | Pending external | Deploy candidate to a static HTTPS host and test supported browsers. |
| 18.5 | Reproducible release SHA-256 | Not yet evidenced / release blocker | `npm run validation:local` records two HTML hashes and source fingerprints in `validation/release-sha256.txt`. It only records a local match when the worktree stayed stable and hashes match; a mismatch or changed worktree is not a pass. A clean-environment/locked-dependency comparison remains required before release. |
| 19.1–19.4 | One-million range behavior, max-batch replay, indexer benchmark and bounded block lookup | Local pass / Pending external | `scripts/verify-million-users.mjs`, `npm run benchmark:indexer:1m`, and the recorded [offline benchmark](offline-indexer-benchmark.md). The benchmark is local/legacy-fixture throughput only; retain live-node measurements separately. |
| 20.1–20.5 | Creator/buyer/trigger/malicious-front-end attacks fail on covenant | Local pass (reviewed VM mutations) | `scripts/verify-vnext-contract.mjs` uses behavior cases; an independent audit remains pending. |
| 22 | Testnet A–E complete evidence for exact current hashes | Pending external — release blocker | The current b1000 Round hash has no accepted Testnet transaction. The [Testnet log](testnet-validation-log.md) preserves 0.9.12 sold-out/deadline payouts, buyer-funded grouped refund, top-up, public empty close, stale-buy rejection and Registry settlement as historical compatibility evidence only. Re-run confirmed-input, strict-no-orphan Create/Registry/marker-return and complete A–E against the exact 0.9.13 manifest hashes. |
| 23 | Mainnet small-value sold-out and refund smoke | Partial external pass — refund path remains a release blocker | The exact 0.9.13 artifact completed Create, Registry publication and marker return, one-ticket Buy, sold-out Draw and payout on 2026-07-20. Transaction ids and exact fees are recorded in [Mainnet validation log](mainnet-validation-log.md). A separate below-minimum Start Refund + Refund completion round is still required before `mainnetSmokePassed` may become true. |
| 24–27 | No Critical/High defects; complete evidence bundle; final “完善” conclusion | Pending external — release blocker | Create `validation/` bundle, review all matrix rows, and obtain independent audit. |

## Required release evidence bundle

Before changing any status from candidate to released, create the validation-spec bundle under `validation/`:

```text
validation/
├─ manifest.json
├─ npm-verify.log
├─ contract-test.log
├─ mass-report.json
├─ artifact-hashes.txt
├─ browser-e2e-report/
├─ testnet-rounds.md
├─ mainnet-smoke.md
├─ known-limitations.md
└─ release-sha256.txt
```

For local evidence generation, run `npm run validation:local`. It first runs `npm run verify` and creates the listed local artifacts plus `human-acceptance-report.md`; it deliberately makes no network call and writes `testnetPassed: false`, `mainnetSmokePassed: false`, `criticalOpen: null`, and `highOpen: null`. Those values document missing evidence, not a passing network/security assessment.

`manifest.json` must record the app/protocol/artifact hashes, HTML SHA-256, Testnet and Mainnet booleans, and open Critical/High counts. A green local command must not populate those network booleans.

## Current conclusion

**Conditional local pass / release blocked.** The local vNext integration has repeatable automated evidence, but it does not meet the validation specification's Testnet, Mainnet, wallet/device, static-host or independent-audit requirements. It must therefore not be described as a complete, production-ready or fully validated Mainnet raffle system.
