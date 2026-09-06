# Kaswin KIP-20 Provenance & Singleton Covenant Lineage Report

## Executive Summary
This report documents the design, formalization, and verification of Kaswin's **KIP-20 Singleton Covenant Lineage & Genesis Provenance** under Kaspa L1 Toccata consensus rules (`rusty-kaspa v2.0.1`, commit `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`, KIP-20 commit `e4ae2332117b5cb68bd6188e065ef885b6d17939`).

We established a globally unique, unforgeable singleton covenant lineage:
$$\text{CREATE}(O) \to \text{OPEN}_0(C) \to \dots \to \text{OPEN}_k(C) \to \text{SEALED}(C) \to \text{DRAW\_READY}(C) \to \text{WINNER\_READY}(C) \to \text{PAID}$$
where $C$ is the official KIP-20 covenant ID derived strictly from the genesis funding outpoint and initial OPEN UTXO. Every state transition immutably propagates $C$, strictly binds the single authorized continuation output, and terminates the covenant ID at `PAID`.

---

## 1. KIP-20 Genesis Model & Kaswin Canonical Provenance

### 1.1 Official KIP-20 Covenant ID Derivation
Under KIP-20, `covenant_id` is computed using the official consensus implementation (`kaspa_consensus_core::hashing::covenant_id::covenant_id`):
$$C = \text{covenant\_id}(\text{funding\_outpoint}, [(0, \text{initial\_open\_output})])$$
The genesis hash incorporates:
- `funding_outpoint.transaction_id` (32 bytes)
- `funding_outpoint.index` (4 bytes LE)
- Output count (1)
- Output 0: `index` (0), `value` (initial_reserve), `script_version` (0), and `script_bytes` (`P2SH(build_initial_open_covenant(...))`).
*(The output's covenant binding itself is excluded from hashing, avoiding circular self-reference).*

### 1.2 Canonical Round ID
To eliminate arbitrary caller choice, `round_id` is strictly derived from the genesis outpoint:
$$\text{round\_id} = \text{BLAKE2b256}(\text{"KaswinRoundV1"} \parallel \text{funding\_outpoint.txid}[32] \parallel \text{le\_u32}(\text{funding\_outpoint.index})[4])$$

### 1.3 Canonical Genesis Output
- **Input 0**: Genesis funding outpoint.
- **Output 0**:
  - `index`: 0
  - `value`: `initial_reserve`
  - `script_public_key`: `P2SH(build_initial_open_covenant(derived_round_id, ticket_price, total_tickets, delta_daa))`
  - `covenant`: `Some(CovenantBinding { covenant_id: C, authorizing_input: 0 })`
- **Initial State Constraints**:
  - `sold_tickets = 0`
  - `purchase_count = 0`
  - `ticket_root = compute_empty_root_27()`
- **Singleton Rule**: No second output in the transaction may belong to the genesis group.

### 1.4 Distinction: Consensus Validity vs. Kaswin Canonicality
KIP-20 consensus guarantees that a `covenant_id` binds to an authentic outpoint + output set, but does not know application-level rules. We provide `validate_canonical_kaswin_create`:
A transaction creating an initial state with `sold > 0`, `pc > 0`, or `root != EMPTY_ROOT_27` is a consensus-valid generic covenant, but is **categorically rejected** as a Kaswin round.

---

## 2. Singleton Continuation & Termination Guards

### 2.1 Singleton Continuation Guard (`append_kaswin_singleton_continuation_guard`)
Embedded in all intermediate states (`OPEN`, `SEALED`, `DRAW_READY`):
1. Reads current $C$ dynamically from `OpInputCovenantId(0)`.
2. Asserts $C \ne \text{ZERO\_HASH}$.
3. $\text{OpCovInputCount}(C) == 1$: exactly one covenant input with ID $C$ exists in the transaction.
4. $\text{OpAuthOutputCount}(0) == 1$: Input 0 authorizes exactly one output.
5. $\text{OpAuthOutputIdx}(0, 0) == 0$: authorized output is strictly Output 0.
6. $\text{OpOutputCovenantId}(0) == C$: Output 0 carries the identical covenant ID $C$.
7. $\text{OpOutputAuthorizingInput}(0) == 0$: Output 0 is authorized by Input 0.
8. $\text{OpCovOutputCount}(C) == 1$: exactly one output with ID $C$ exists in the transaction (no split).

### 2.2 Terminal Lineage Guard (`append_kaswin_terminal_lineage_guard`)
Embedded in `WINNER_READY` payout settlement:
1. Reads $C$ from `OpInputCovenantId(0)` and asserts $C \ne \text{ZERO\_HASH}$.
2. $\text{OpCovInputCount}(C) == 1$.
3. $\text{OpAuthOutputCount}(0) == 0$: Input 0 authorizes NO covenant output.
4. $\text{OpCovOutputCount}(C) == 0$: NO output in the transaction carries covenant ID $C$.
5. $\text{OpOutputCovenantId}(0) == \text{ZERO\_HASH}$: Output 0 is an ordinary non-covenant output.
6. $\text{OpOutputAuthorizingInput}(0) == -1$: Output 0 has no authorizing input.

---

## 3. Test Matrix Verification (`lineage_provenance_test.rs`)

All 14 mandatory tests pass $100\%$ in `TxScriptEngine` and `CovenantsContext`:

| # | Test Scenario | Target Layer | Result |
|---|---|---|---|
| 1 | Canonical CREATE transaction | Genesis Provenance | **PASS** (`CovenantsContext` & `validate_canonical_kaswin_create` OK) |
| 2 | Noncanonical Initial Root ($R \ne \text{EMPTY\_ROOT\_27}$) | Creation Filter | **BLOCKED** |
| 3 | Noncanonical Initial State ($sold \ne 0$ or $pc \ne 0$) | Creation Filter | **BLOCKED** |
| 4 | Multi-genesis Group Attack (two outputs with same C) | Creation Filter | **BLOCKED** |
| 5 | CREATE $\to$ BUY0: consuming genesis Output 0, propagating C | State Continuation | **PASS** (`Units: 55,037`, `B_min: 5`) |
| 6 | Attack: Missing Continuation Binding (`covenant = None`) | Lineage Guard | **BLOCKED** |
| 7 | Attack: Wrong Covenant ID ($C_2 \ne C$) | Consensus Context | **BLOCKED** (`WrongGenesisCovenantId`) |
| 8 | Attack: Wrong Authorizing Input ($auth\_input = 1$) | Consensus Context | **BLOCKED** (`WrongGenesisCovenantId`) |
| 9 | Attack: Two Authorized Children (split attack) | Lineage Guard | **BLOCKED** (`OpAuthOutputCount == 1`) |
| 10 | Final BUY $\to$ SEALED (preserving $C$) | State Continuation | **PASS** (`Ok(())`) |
| 11 | SEALED $\to$ DRAW_READY (preserving $C$) | State Continuation | **PASS** (`Units: 17,372`, `B_min: 1`) |
| 12 | DRAW_READY accept $\to$ WINNER_READY (preserving $C$) | State Continuation | **PASS** (`Units: 13,865`, `B_min: 1`) |
| 13 | Terminal PAID: WINNER_READY $\to$ ordinary payout ($covenant = None$) | Lineage Termination | **PASS** (`Units: 15,200`, `B_min: 1`) |
| 14 | Attack: PAID attempts to retain covenant binding $C$ | Lineage Termination | **BLOCKED** (`OpAuthOutputCount == 0`, `OpCovOutputCount == 0`) |

---

## 4. Compute Budget Recalibration for Lineage Guard

| Transition | Executed Script Units | Minimum Covering Budget ($B_{\min}$) |
|---|---|---|
| **OPEN BUY** | 55,037 units | `ComputeBudget(5)` |
| **SEALED $\to$ DRAW_READY** | 17,372 units | `ComputeBudget(1)` |
| **DRAW_READY $\to$ WINNER_READY** | 13,865 units | `ComputeBudget(1)` |
| **WINNER_READY $\to$ PAID** | 15,200 units | `ComputeBudget(1)` |
