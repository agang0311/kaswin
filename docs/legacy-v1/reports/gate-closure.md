# V1 final consensus gate closure

## Scope / architecture approval

Baseline `e4825c3a823d9f473833a1a799fca898477f3e32`, branch `audit/state-deposit-v1`.
User approved the sole economics change: minimum creator deposit **20,000,000 sompi (0.2 KAS)**; no minimum search. Ticket minimum 100,000,000, refund K_MAX 16, maximum per-buyer fee 1,500,000 unchanged.

The [existing preflight](production-consensus-gate-preflight.md) supplies all 25 answers, 14 architecture deliverables and 8 anti-pattern reviews. This amendment adopts its concrete schemas, lineage, I/O and exit rules, not its unproven performance/liveness claims. Review disposition for questions 1–13, 16–25: architecture unchanged; questions 14–15: deposit floor changed, exact segregated return unchanged. Deliverables 1–14 retained; economics/admission and evidence boundaries updated here. Anti-patterns 1–8 remain addressed by per-round identity, actual successor reconstruction, lineage guards, non-authoritative discovery, UTXO-native execution, necessary per-round ordering and three terminal paths. This is a limited implementation approval, not an audit PASS.

Corrections to historical preflight claims: block inclusion is not acceptance; no measured 256-purchase network throughput claim; discovery/preimages require infrastructure; permissionless execution is not guaranteed execution; randomness remains subject to the established PoW/reorg and PASS-A assumptions. No new identity, authority, randomness, foreign-contract or exit policy is introduced.

## Implementation

- `contracts/v1_constants.rs`: frozen 0.2 KAS floor, tested at floor and floor-minus-one.
- `contracts/genesis.rs::validate_final_create_storage`: real pinned MassCalculator admission on final populated funding/change topology, rejects mass >500,000 or incomputable mass. Output0-only builder explicitly does not promise transaction admission. Both final connected CREATE builders invoke this through the shared verifier. Dust-change negative case keeps Output0 deposit intact but is rejected.
- `contracts/open_covenant.rs`: capacity CLOSE uses **OpBoolOr**, not bitwise OpOr. P=256, sold<cap produces false(empty)/true([1]); bitwise OR rejects unequal lengths. Logical OR restores the intended existing capacity policy, without redesign. First failure is retained in `artifacts/gate-closure/first-close-failure.log`; connected P=256 is the minimal real boundary regression, existing premature-close negatives remain.
- Connected refund chains start at signed canonical CREATE, with 0/1/17/256 actual BUY transitions and production CLOSE. P17=[9,8], P256=[16;16]. Ordinary offline P2PK inputs actually sign and execute; no real wallet is used.
- SUCCESS at the minimum deposit uses CREATE → BUY×3 → CLOSE → SEALED → DRAW_READY → ACCEPT → WINNER_READY → PAID; actual tickets 95 != cap 100. Explicit predecessor outpoint/amount/SPK/covenant assertions and exact ordinary terminal deposit checks added.
- Historical synthetic component cases remain regressions only, explicitly labelled; they are not connected lifecycle evidence.

## Header context: fixed-source parity

Pinned upstream `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`, rechecked locally for this closure; no upstream edits or upgrades. Source: `consensus/src/processes/transaction_validator/tx_validation_in_header_context.rs`, constants and `Params::max_signature_script_len()`.

`header_source_parity.rs.inc` mirrors finality (zero lock, DAA/time threshold, strict less-than, all-final sequences), pre/post-Toccata version rules, and contextual signature-script length. Positive/negative boundaries execute before connected E2E; every measured transition runs the parity check. These tests protect admission semantics not covered by the public isolation/UTXO interface. No private-source inclusion or new node architecture.

- **DIRECT PUB(crate) CALL NOT EXPOSED**
- **SOURCE-PARITY LOCAL PASS**
- **REAL NODE HEADER ACCEPTANCE -> TN10 验证**

## Evidence and gate meaning

Raw final commands/results: `artifacts/gate-closure/commands.json`; logs in the same directory. Every measured transaction logs its txid, fee/floor, compute/transient/storage and all-input committed VM result. Shared verifier also executes B_min and B_min-1 probes, conservation, public isolation and UTXO-context rules; storage commitment uses real MassCalculator. UTXO validator SkipScriptChecks is paired with separate actual committed VM execution of every input. PASS-A chain accessor remains fixture-backed, not live-node acceptance evidence.

**V1 PRODUCTION CONSENSUS GATE PASS** means the requested local gate including explicitly scoped source parity. It is not audit approval, real-node header acceptance, live relay, transaction acceptance or TN10 lifecycle proof.

NEXT: GitHub final code-level audit; only after audit PASS, TN10 lifecycle validation under its separate authorization. No TN10 broadcast, node start, main merge, force push, V2 or protocol redesign in this task.
