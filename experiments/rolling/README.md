# Rolling active-shard prototype

Source candidate for the rolling Kaswin design. **The five templates have been compiled with the pinned SilverScript 1.0.1 compiler, quoted offline for size and mass, and executed offline in the real `kaspa-txscript` 2.1.0 script engine with a covenants context (`vm/`, `vm-*.mjs`; see "VM execution" below). That is not consensus: acceptance, maturity checks, funding-input signatures and any network submission remain NOT_RUN. The JavaScript unit tests have been run (23/23). The record is [VALIDATION.md](VALIDATION.md).** It is separate from the current V2.0.2 application and its pinned Profile.

The complete specification is [ROLLING-ACTIVE-SHARD-IMPLEMENTATION.md](../../docs/ROLLING-ACTIVE-SHARD-IMPLEMENTATION.md); business rules remain in the [design](../../docs/ROLLING-ACTIVE-SHARD-DRAFT.md). The source now follows the updated rules: a final shard with an original pool under 3 KAS (including an empty one) settles with the last frozen-shard payout batch or final refund batch. WIN stores only the winner key and cursor. Actions 22/23 are retired; merged terminal batches leave no manager successor. Source synchronization is not execution validation.

## Contents

| File | Responsibility |
|---|---|
| `contracts/*.sil.in`, `common.sil.inc` | Five template sources with explicit heterogeneous input/output validation |
| `toolchain.json` | SilverScript 1.0.1 distribution/source identity, installation path and contract-check status |
| `prepare-sources.mjs` | Expand one template (placeholders, `U16/U32/U63` reader macros) and bind required forward template hashes; does not compile |
| `compile.mjs` | Verify the pinned `silverc`, then rebuild all five templates from scratch in dependency order and record actual template hashes |
| `measure.mjs` | Load the real artifacts as a candidate Profile and quote size and mass for each action's smallest/largest ledger. Compute budget is not measured |
| `fixtures.mjs` | Synthetic ledgers/targets/DRAW proofs built from the real artifacts; shared by `measure.mjs` and the VM cases |
| `vm/` | Standalone Rust crate (`kaspa-txscript` 2.1.0 pinned, Cargo.lock from the SilverScript 1.0.1 checkout): runs covenant inputs through the real engine, unlimited and under the committed budget |
| `vm-cases.mjs`, `vm-run.mjs`, `vm-budgets.mjs` | Case generator (positive bases + single-fault mutations), runner/summary, and the measured-budget pass with mass quotation |
| `state.mjs` | Canonical 59/93/63-byte manager headers, 9217-byte frozen ledger, counts and balances |
| `profile.mjs` | Trusted artifact parsing, canonical frames, candidate Profile derivation and exact Profile routing |
| `transactions.mjs` | Genesis and every action, ABI witnesses, immutable effects, unsigned transaction drafts |
| `accepted.mjs` | Interpret node-accepted transactions against authenticated input context; not a VM |
| `receiver.mjs` | Schnorr reward address normalization and funding-input signature selection |
| `mass.mjs` | Complete transaction mass/fee arithmetic and bounded payout batch selection; budgets must be explicit |
| `archive.mjs` | Durable single-writer preimages, small current snapshots, revision journal and receipt lookup |
| `indexer.mjs`, `http.mjs` | Candidate uploads, accepted transitions, rollback, revision-bound pagination and export |
| `node-adapter.mjs` | Read-only adapter to the existing selected-chain Full acceptance service |
| `state.test.mjs`, `transactions.test.mjs`, `archive.test.mjs` | Codec, off-chain transaction policy (synthetic template tails, not the compiled artifacts) and durable-archive regression cases; run 2026-11-13, 23/23 |
| `VALIDATION.md` | Validation record, by evidence layer |

The JavaScript modules reuse existing binary/hash/transaction helpers from `scripts/core/lib/`. They do not reuse the old ledger codec, Profile approval or action-budget estimates. No packages or guessed compiler names were installed.

## Compiling

Use the official SilverScript **1.0.1** package source, pinned to `a17db2c7c95cf9f12f8e1264b21f32a8552af8df`, with Kaspa 2.1.0 dependencies. [toolchain.json](toolchain.json) records the exact source and local installation identity; paths in that file are relative to the Kaswin repository root.

The distribution version is distinct from its language/ABI metadata: this release still declares `COMPILER_VERSION = "0.1.0"`. Keep `pragma silverscript ^0.1.0` and the current artifact compiler-version check. The production V2.0.2 contract pins retain their original compiler provenance.

```sh
node experiments/rolling/compile.mjs   # win, refund -> sealed, frozen -> sales; rebuilds generated/ and artifacts/ from scratch
node experiments/rolling/measure.mjs   # candidate Profile from the real artifacts + size/mass quotation per action
```

`compile.mjs` refuses to run unless `silverc` matches the SHA256 in `toolchain.json`. A template can only be bound to template hashes of templates compiled before it, so the order is fixed; the actual hashes go to `artifacts/local-pins.json`. Generated sources and artifacts are ignored. Constructor arguments use the portable ABI format with one bytes value; the generated entry tag is never a hand-picked action number.

SilverScript inlines every function and keeps the parameters and locals of each inlined call on the stack until the enclosing block ends; the consensus stack limit is 244 items. The templates therefore decode the ledger header once per entry, pass values explicitly, and call helpers inside `{ }` blocks. Do not reintroduce small getter functions (`count()`, `localTickets()`, ...): they compile to a stack overflow. Every loop is unrolled to its constant bound, so keep bounds tight: `FEE_INPUTS`, `FEE_OUTPUTS` and `TARGET_INPUTS` are per-template constants, `checkSolo`/`checkTargets` replace a general input check, and a 32-byte constant such as `ZERO` is referenced through a local inside loops. The code tail is paid by every spend, so each byte costs fee on every purchase and refund. `U16/U32/U63` are stack-neutral expression macros expanded by `prepare-sources.mjs`. `U63` is signed, so callers must require a non-negative value.

The codec, transaction and storage tests can later be invoked with `node --test experiments/rolling/state.test.mjs experiments/rolling/transactions.test.mjs experiments/rolling/archive.test.mjs`. This is not authorization to run them now. Transaction tests use explicitly synthetic short script frames to exercise JS payout/refund arithmetic, layout and rejection paths; they do not establish compilation, SilverScript execution, budget sufficiency or node acceptance.

## Building a candidate

`loadCandidateProfile(artifactTexts, trustedPins)` requires actual artifact texts and trusted SHA256 pins. `buildGenesis` and `buildAction` return unsigned candidate DTOs. Every input requires an explicit compute budget; there is no production fallback. `massOf` counts wallet inputs at their final 66-byte Schnorr signature size. Mass arithmetic with an unmeasured budget is not proof that the script fits that budget.

Snapshots bind `origin`, `cid`, `outpoint`, `redeemScript`, `spk`, `value`, `utxoDaa` and `currentDaa`. Targets carry their own actual outpoints and authenticated frozen preimages. Funding inputs contain no covenant ID. Amounts and DAA are bigint in memory, decimal strings on the Indexer wire. The standard builder funds and buys with the same public key; the accepted interpreter preserves the protocol's separately authorized payer/holder distinction.

## Indexer integration

Construct `FileArchive` with a dedicated writable directory and run exactly one writer process. Construct `RollingNodeAdapter` with the host's existing identity-checked network link, candidate Profile and archive; then construct `RollingIndexer`. No module opens a listener or makes RPC calls on import. `createRequestHandler` is a host adapter; uploads default to denied unless the host supplies explicit authentication.

Node acceptance uses the existing `getVirtualChainFromBlockV2` **Full** path. Inclusion, a REST response or an uploaded preimage cannot advance state. Missing full input context, a missing origin or unavailable DRAW proof context stops ingestion. Reversals require node evidence that the accepting block is no longer selected; a missing block is not treated as removal. Revert descendants before parents. These paths have not been exercised against a node.

Preimages are immutable. A revision journal entry and its derived receipt index are persisted before the small current snapshot is atomically replaced. Readers ignore unpublished revisions; a stale receipt index falls back to the journal. Each undo record stores only affected frozen outputs and the prior manager, not a complete copy of every shard. The scan scheduler must advance its own cursor only after `ingest`/`revert` succeeds; replay uses instance identity and revision checks. No scanner is started by this package.

The HTTP export streams NDJSON at a fixed revision; an `end` record carries the event/preimage counts, so an interrupted stream cannot masquerade as a complete export. The convenience `export()` method materializes its result and is intended only for small datasets. Persistent storage, reorg races, backup restoration and host behavior remain **NOT_RUN**; this adapter is a prototype, not a deployed archival service.

## VM execution

Build and run (nothing here needs a node, network, key or signature):

```
cargo build --release --manifest-path experiments/rolling/vm/Cargo.toml   # set CARGO_TARGET_DIR to keep the build out of the tree
KASWIN_VM_BIN=<path to kaswin-rolling-vm> node experiments/rolling/vm-run.mjs       # bases + mutations, unlimited budget; writes artifacts/vm/report.json
KASWIN_VM_BIN=<path to kaswin-rolling-vm> node experiments/rolling/vm-budgets.mjs   # rebuild with measured budgets, run under the committed limit, quote mass
```

Run on 2026-11-13 against candidate Profile `b56bcd9c…c4e5`: all 48 base transactions (every action, smallest/largest ledgers, final-merge variants) pass; 3,268 single-fault mutations (output values/scripts/covenant bindings/counts, every signature-script argument, target substitution, timing, fee boundaries, DRAW proof bytes and chain accessor, manager header rules) match their expectations; under the measured budgets all bases pass and every `budget-1` variant fails with `ExceededCommittedScriptUnits`. No quoted transaction exceeds the compute, transient or storage mass limits.

What this does and does not establish:

- It is the script engine plus `CovenantsContext`, the same engine call consensus makes per input. It does not check lock/sequence maturity against a DAA score, mass limits, double spends or acceptance; mass is quoted offline by `mass.mjs`.
- The DRAW chain accessor is a map built by the harness, not a node's selected chain. Funding (P2PK) inputs are never executed, so no signature is checked; their budget (11) is the analytic Schnorr cost plus one unit of margin, not a measurement.
- Measured consumption depends strongly on ledger size (for example BUY: 0.11 M units with an empty ledger, 1.1 M near full). A builder must dry-run each transaction in the engine to choose budgets; the per-case figures are not worst-case bounds.
- Executor and change outputs are checked for value, Schnorr P2PK form and no covenant binding, never for the key: the key is the executor's or funder's own choice. Winner, buyer, creator and manager outputs are pinned.
- Mutation coverage is sampled (first/middle/last outputs, selected bytes), not exhaustive, and the expectations were written from the contract source; one expectation (change key) was corrected before the final run.

## Remaining execution work

Persistence recovery checks beyond the four archive unit cases, node integration and any network experiment are still required. The compiled artifacts, hashes, tags and Profile ID are real, but the Profile stays `UNVALIDATED`. `measure.mjs` still uses a budget of 0 for every input (a size lower bound); `vm-budgets.mjs` is the budgeted quotation. Its draws use synthetic proofs. The live application, wallets, public Indexer and current Profile have not been switched. There is no private-key, signing, broadcast, automatic deployment or approval entry point here.
