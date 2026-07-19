# Development Verification Loop

## Candidate and legacy scope

This worktree validates the local candidate `raffle-vnext-liveness-guard-b1000` (`RaffleRoundVNext`/`RaffleRefundVNext`). The candidate is integrated through its artifact, transaction builders, vNext metadata and nonce-domain Indexer paths. It is **not network-released**: no claim in this document converts a local test into a Testnet/Mainnet deployment approval.

`raffle-v16-dynamic-refund-transition` and v15/v14 remain historical compatibility targets. Their old release records are evidence about those deployed versions, not evidence that vNext has passed a network gate.

## Automated local gate

```powershell
npm run compile:vnext
npm run verify
npm run benchmark:indexer:1m
npm run validation:local
```

`npm run verify` must fail on a wrong artifact hash, version/document drift, a wrong vNext state transition, a malformed Merkle/proof/nonce, an invalid pre-commit header/boundary witness, an incorrect buyer-fee allocation or transition debt, insufficient transition carrier, stale/missing signing-confirmation data, a transaction above the measured mass policy, an Indexer vNext reorg/proof failure, an external startup resource, or a production credential. The run reports local evidence only; it cannot manufacture a wallet signature, node acceptance, browser behavior or on-chain record.

`npm run validation:local` is the reproducible local evidence command. It runs the full local `verify` command, captures its output in `validation/npm-verify.log`, runs a second same-workspace build, and records both HTML hashes plus source fingerprints. `verify-validation-fingerprint` behavior-tests that `compile:vnext` changes only generated artifact/transient files, not the declared build inputs (`src` excluding compiled artifacts, lock, manifest and docs). `verify` may legitimately recompile generated artifacts before its first build; therefore the source comparison is between the first built HTML's completed verification state and the second build, not the pre-verify source tree. It writes the machine-readable manifest, artifact hashes, 10,000-case property report, mass report, human acceptance report and explicit Testnet/Mainnet/browser/audit placeholders. A build match is evidence only when the source fingerprint stayed stable between those two builds; a mismatch or changed worktree remains a release blocker. It performs no live-node, wallet, signing or broadcast operation; its generated `testnetPassed` and `mainnetSmokePassed` values are always `false` and Critical/High counts remain intentionally unassessed (`null`). A clean-environment reproducibility check remains a release gate.

The compiled vNext Refund artifact verifies up to 13 proofs in its ABI, but real compiled-script transaction-shape measurement determines the smaller standard-relay prefix for successor and final transactions. The creation-time minimum ticket price is 100,000,000 sompi; each refund transaction's actual fee, plus the one-time recorded transition debt on the first cursor, is deducted from the selected purchase payments. At the 20,000,000-sompi transition cap and 20,000,000-sompi refund cap, a one-ticket refund retains a 60,000,000-sompi relay-safe owner output. VM regression coverage verifies this allocation, rejects an over-cap public fee, and rejects a successor that loses remaining ticket principal. No test, document or UI may advertise the ABI limit as a relay guarantee.

The current mass gate constructs real maximum-payload P2PK/Genesis/CovenantBinding shapes for Create, Registry, Buy, Top-up and Registry marker settlement on both supported networks. Create, Registry and Buy now use direct wallet inputs and converge before a single wallet request for each transaction; Top-up retains its wallet-owned staging recovery path. The default Registry sends a relay-safe 20,000,000-sompi marker and returns 19,000,000 sompi with a 1,000,000-sompi settlement fee, so the Mainnet and Testnet net Registry cost is the same 0.01 KAS while wallet network fees remain separate. The mass gate also proves that a standalone 0.01 KAS Registry output is not a standard-relay replacement.

### VM fixture limits (not a pass)

The local `cli-debugger` executes the compiled Round and Refund scripts for buys, refund transitions and refund cursors. It currently creates its VM `EngineCtx` without a `SeqCommitAccessor`, and its test JSON schema has no selected-chain commitment fixture. Consequently a witness that passes header and boundary checks cannot complete `OpChainblockSeqCommit`; **a successful vNext `finalize` VM fixture is not verified locally**. Existing finalize-negative cases prove only the checks reached before that opcode and must not be described as selected-chain/finalize success evidence.

`closeEmpty` no longer accepts a creator signature. It is a public liveness trigger whose only output is fixed to the committed creator public key; the debugger executes its positive path and its deadline, non-empty and wrong-output negative paths. A successful `finalize` still needs either a debugger release that supplies a consensus-equivalent `SeqCommitAccessor` or a current-protocol Testnet transaction proof. The project deliberately does not modify the debugger or convert that remaining limitation into a passing test.

## Required Testnet 10 gate (not yet passed for vNext)

The transactions in [testnet-validation-log.md](testnet-validation-log.md) were created with earlier artifact hashes and are compatibility history only. They do not satisfy any A–E scenario for `raffle-vnext-liveness-guard-b1000` and do not change `testnetPassed` from `false`.

Use separate funded Creator, Buyer A/B/C, Outsider and Sponsor test wallets plus Chrome and a second browser profile. Record app/protocol/artifact hashes, all inputs/outputs/fees and transaction ids.

1. **A — sold out:** three buyers with different quantities; reload/load history; draw and verify winner output and selected-chain witness.
2. **B — minimum met:** `minTickets < soldTickets < maxTickets`; after deadline verify finalize succeeds and refund is rejected.
3. **C — below minimum:** multiple batches; start refund; verify the first buyer output deducts transition plus current network fee; reload in another profile/user; complete all refunds and creator carrier return.
4. **D — stale buy:** two users construct from one old UTXO; only one succeeds and the other refreshes/reviews/re-signs rather than silently retrying.
5. **E — service failure:** disable Indexer and change History/RPC endpoints; prove chain state and outcome do not change.

The current candidate defaults to 100 purchase batches and enforces a 1000-batch covenant hard limit. The UI recommendation `max(1, min(1000, floor(salesSeconds / 6)))` is advisory and does not remove the interruption, recovery, stale-concurrency and proof requirements.

## Required Mainnet and release gate (not yet passed for vNext)

Before a public release, use an isolated small-value wallet for one sold-out and one refund round; independently verify release SHA-256 and both artifact hashes before signing. Complete KasWare/Kastle and mobile browser E2E, run the release HTML from a static HTTPS host, preserve validation logs, and obtain an independent security audit. Testnet and Mainnet must never reuse ordinary wallets or embedded credentials.

## Evidence and conclusion rules

The authoritative requirement-to-evidence mapping is [audit-evidence-matrix.md](audit-evidence-matrix.md). A row marked **Pending external** blocks a statement that the system is complete, production-ready, or fully validated. A local green command is evidence only for the scripts it actually executes.
