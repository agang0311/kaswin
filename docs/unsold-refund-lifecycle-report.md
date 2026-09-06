# Kaswin Unsold Refund Lifecycle & Consensus Context Audit Report

## 1. Executive Summary

This report documents the specification, consensus rule enforcement, smart contract implementation, and 100% rust-vm validation of the **Unsold Refund Lifecycle** for the Kaswin protocol on Kaspa L1.

Kaswin allows permissionless raffle rounds to be created, ticketed, drawn, and paid entirely on-chain without oracles or trusted keepers. In scenarios where a round does not sell out before its declared deadline (`refund_lock_daa`), participants and the round creator must have a guaranteed, permissionless, and tamper-proof path to reclaim their funds.

We implemented and verified the full unsold refund lifecycle:
1. **`OPEN(sold = 0) -> RECOVER_EMPTY`**: Immediate reclamation of the creator reserve if zero tickets are sold by the deadline, terminating covenant lineage.
2. **`OPEN(sold > 0) -> BEGIN_REFUND`**: Transition of an undersold pool into a sequential refund state (`REFUNDING`), freezing the ticket tree root and preserving the KIP-20 covenant singleton lineage.
3. **`REFUNDING(cursor, rem) -> REFUNDING(cursor + 1, rem - count)`**: Deterministic, sequential processing of buyer refunds via SMT range-leaf proofs against the frozen `ticket_root`.
4. **`REFUNDING(cursor = count - 1, rem = count) -> REFUNDED`**: Atomic settlement of the last buyer and terminal return of the remaining creator reserve to `reserve_payout_spk`, extinguishing the covenant lineage.

All 15 test cases in the test matrix (`tests/rust-vm-validation/src/bin/unsold_refund_lifecycle_test.rs`) pass 100% in the real `TxScriptEngine` with exact Kaspa Testnet-10 Toccata consensus parameters.

---

## 2. Pinned Upstream Consensus Rules

All mechanisms are strictly pinned against `kaspanet/rusty-kaspa` (release `v2.0.1`, commit `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`):

### 2.1 Transaction Finality in Header Context (`check_tx_is_finalized`)
Under `rusty-kaspa/consensus/src/processes/transaction_validator/tx_validation_in_header_context.rs`:
- A transaction with `tx.lock_time > 0` is finalized if and only if:
  1. `tx.lock_time < current_block_daa_score` (when `tx.lock_time < LOCK_TIME_THRESHOLD = 500_000_000_000`), OR
  2. Every input has `input.sequence == u64::MAX` (`constants::MaxTxInSequenceNum`).
- Therefore, for `OpCheckLockTimeVerify` (CLTV) to be effective and binding, the spending transaction input **MUST NOT** set sequence to `u64::MAX`. In Kaswin, spending inputs use `sequence = 0`.
- The consensus predicate `reference_check_tx_finalized_in_daa_context` used in test validation is a byte/logic-parity reference against the pinned rusty-kaspa header-context predicate (where `validate_tx_in_header_context` is crate-private).
- If an attacker attempts to mine or broadcast a transaction with `tx.lock_time = refund_lock_daa` when `block_daa <= refund_lock_daa`, the transaction is rejected at the consensus header-context layer before execution.
- Thus, valid refund spending requires:
  $$\text{containing\_block\_daa} > \text{tx.lock\_time} \ge \text{refund\_lock\_daa}$$
  Production clients fix $\text{tx.lock\_time} = \text{refund\_lock\_daa}$ and $\text{sequence} = 0$ for earliest legal confirmation. Contracts do not assert exact equality of lock_time; CLTV asserts $\ge$.

### 2.2 `OpCheckLockTimeVerify` (`0xb0`) Execution Semantics
Under `rusty-kaspa/crypto/txscript/src/opcodes/mod.rs` (lines 1014–1060):
```rust
opcode OpCheckLockTimeVerify<0xb0, 1>(self, vm) {
    match vm.script_source {
        ScriptSource::TxInput {input, tx, ..} => {
            let [mut lock_time_bytes] = vm.dstack.pop_raw()?; // POPS argument!
            ...
            if stack_lock_time > tx.tx().lock_time {
                return Err(TxScriptError::UnsatisfiedLockTime(...));
            }
            if input.sequence == MAX_TX_IN_SEQUENCE_NUM {
                return Err(TxScriptError::UnsatisfiedLockTime("transaction input is finalized".to_string()));
            }
            Ok(())
        }
    }
}
```
**Critical Discovery**: Unlike Bitcoin BIP-65 (where `OP_CHECKLOCKTIMEVERIFY` acts as an `OP_NOP` and leaves the item on stack), **rusty-kaspa's `OpCheckLockTimeVerify` pops the lock_time item directly from the stack** (`vm.dstack.pop_raw()?`). Appending an extra `OpDrop` after CLTV in Kaspa drops the subsequent stack item. Kaswin's contracts correctly account for this opcode behavior.

---

## 3. Protocol State Machine & Architecture

```
                    +------------------------------------+
                    |  Atomic CREATE Genesis Transaction |
                    |  Output 0 carries KIP-20 cov_id C  |
                    +------------------------------------+
                                      |
                                      v
                             +------------------+
          +----------------->|    OPEN (C)      |-------------------+
          |                  +------------------+                   |
          |                      |          |                       |
     BUY (sold < N)              |          |                       |
          |                      |          |                       |
          +----------------------+          |                       |
          |                                 |                       |
          v (sold == N)                     v (sold == 0 & DAA)     v (sold > 0 & DAA)
+-------------------+             +------------------+    +-------------------+
|    SEALED (C)     |             |  RECOVER_EMPTY   |    | BEGIN_REFUND (C)  |
+-------------------+             |  Lineage Ends    |    +-------------------+
          |                       +------------------+              |
          v                                                         v
+-------------------+                                     +-------------------+
|  DRAW_READY (C)   |                                     |   REFUNDING (C)   |
+-------------------+                                     +-------------------+
          |                                                         |
          v                                                 Refund Buyer [i]
+-------------------+                                               |
|  WINNER_READY (C) |                                               v
+-------------------+                                     +-------------------+
          |                                               |     REFUNDED      |
          v                                               |   Lineage Ends    |
+-------------------+                                     +-------------------+
|     PAID          |
|  Lineage Ends     |
+-------------------+
```

### 3.1 Parameter Set Frozen at Genesis
Every Kaswin instance locks its configuration into its canonical redeem script at `CREATE`:
1. `round_id`: `BLAKE2b256(b"KaswinRoundV1" || funding_outpoint.txid || le_u32(funding_outpoint.index))` (32B)
2. `ticket_price`: Cost per ticket in sompi (8B LE)
3. `total_tickets`: Total ticket capacity $N$ (8B LE)
4. `delta_daa`: DAA score delay from round sealing to PoW seed extraction (8B LE)
5. `refund_lock_daa`: Consensus DAA threshold after which refund transitions become valid (spending block DAA > refund_lock_daa) (8B LE)
6. `reserve_payout_spk`: Canonical serialized ScriptPublicKey (`ScriptPublicKey.to_bytes()`, version 0 standard) of the creator reserve recipient (36 or 37B)
7. `covenant_id`: Official KIP-20 covenant ID derived across `funding_outpoint` and `[(0, initial_open_output)]`.

---

## 4. Contract Specifications

### 4.1 Canonical `OPEN` Covenant Dispatch (`contracts/open_covenant.rs`)
The `OPEN` covenant uses an action selector (`action_num` at Depth 8) to dispatch execution:

```rust
// Depth 8: action
//   1 => BUY
//   2 => BEGIN_REFUND
//   3 => RECOVER_EMPTY
```

#### Action 1: BUY
1. Stack depth check: Exactly 38 items.
2. Ingress validation: `buyer_spk` must be a canonical version 0 standard SPK (`append_canonical_payout_spk_check`).
3. Range bounds: $1 \le count \le total\_tickets - sold\_tickets$.
4. Exact payment assertion:
   $$\text{Output 0 Amount} = \text{Input 0 Amount} + ticket\_price \times count$$
5. Singleton Continuation Guard: Enforces 1 covenant input, 1 authorized output at index 0 carrying identical `covenant_id`.
6. Parallel Dual-Root SMT Authentication: Proves slot `purchase_count` was empty in `ticket_root` and computes `new_root`.
7. Successor State Introspection & Reconstruction:
   - If $sold\_after < total\_tickets$: Slices immutable prefix (`64 + reserve_len` bytes) and body (`7586` bytes), inserts updated `(sold_after, purchase_count + 1, new_root)`, and asserts `Output 0 SPK == P2SH(successor_open)`.
   - If $sold\_after == total\_tickets$: Transitions to `SEALED` carrying `app_comm` and `new_root`.

#### Action 2: BEGIN_REFUND
1. Condition: $sold\_tickets > 0$ and $sold\_tickets < total\_tickets$.
2. Time Gate: `refund_lock_daa OpCheckLockTimeVerify` (pops argument in Kaspa).
3. Exact principal preservation: $\text{Output 0 Amount} == \text{Input 0 Amount}$.
4. Successor binding: Reconstructs initial `REFUNDING` covenant:
   - `refund_cursor = 0`
   - `remaining_tickets = sold_tickets`
   - Preserves frozen `ticket_root` and `reserve_payout_spk`.
   - Asserts $\text{Output 0 SPK} == \text{P2SH}(initial\_refunding)$.
5. Lineage Guard: Continues singleton covenant lineage ($C \to C$).
6. CleanStack: Pops remaining 9 stack items before pushing `OpTrue`.

#### Action 3: RECOVER_EMPTY
1. Condition: $sold\_tickets == 0$ and $purchase\_count == 0$.
2. Time Gate: `refund_lock_daa OpCheckLockTimeVerify`.
3. Exact reserve refund: $\text{Output 0 Amount} == \text{Input 0 Amount}$.
4. Destination SPK: $\text{Output 0 SPK} == reserve\_payout\_spk$.
5. Terminal Lineage Guard: Enforces $\text{AuthOutputCount} == 0$ and $\text{Output 0 Covenant} == None$.
6. CleanStack: Pops remaining 9 stack items before pushing `OpTrue`.

### 4.2 Canonical `REFUNDING` Covenant (`contracts/refunding_covenant.rs`)
The `REFUNDING` state processes buyer refunds sequentially in strictly ascending order:

1. **Sequential Cursor Constraint**: Asserts $purchase\_index == refund\_cursor$ (`OpNumEqualVerify`). Out-of-order claims are rejected.
2. **SMT Membership Proof**: Proves that $(round\_id, purchase\_index, start\_ticket, count, payout\_spk)$ was committed in the frozen `ticket_root` using 27 siblings.
3. **Exact Buyer Refund**:
   $$\text{Output 1 Amount} == ticket\_price \times count$$
   $$\text{Output 1 SPK} == payout\_spk$$
   $$\text{Output 1 Covenant} == None$$
4. **Successor Transition**:
   - **Normal Step** ($count < remaining\_tickets$):
     $$\text{Output 0 Amount} == \text{Input 0 Amount} - ticket\_price \times count$$
     $$\text{Output 0 SPK} == \text{P2SH}(REFUNDING(cursor + 1, rem - count))$$
     Lineage continuation guard enforced ($C \to C$).
   - **Final Step** ($count == remaining\_tickets$):
     $$\text{Output 0 Amount} == \text{Input 0 Amount} - ticket\_price \times count \quad (\text{creator reserve})$$
     $$\text{Output 0 SPK} == reserve\_payout\_spk$$
     Terminal lineage guard enforced ($\text{covenant} == None$, lineage terminates).

---

## 5. VM Validation Results (15/15 Matrix)

The test suite in `tests/rust-vm-validation/src/bin/unsold_refund_lifecycle_test.rs` validates all 15 cases (A through O) with full transaction populations and real `TxScriptEngine` execution:

| Test | Description | Result | Script Units | $B_{min}$ |
| :--- | :--- | :---: | :---: | :---: |
| **A** | `OPEN BUY` before deadline ($DAA < lock\_daa$) | **PASS** | 68,591 | ComputeBudget(6) |
| **B** | `OPEN BUY` after deadline ($DAA > lock\_daa$, non-strict window) | **PASS** | 68,591 | ComputeBudget(6) |
| **C** | `BEGIN_REFUND` before deadline ($DAA \le lock\_daa$) | **PASS (Blocked by Header & CLTV)** | - | - |
| **D** | `BEGIN_REFUND` after deadline ($DAA = 1.6M > 1.5M$) | **PASS** | 26,125 | ComputeBudget(2) |
| **E** | Attack: `BEGIN_REFUND` with $sold = 0$ | **PASS (Blocked by sold > 0)** | - | - |
| **F** | `RECOVER_EMPTY`: $sold = 0$ after deadline $\to reserve\_payout\_spk$ | **PASS** | 15,744 | ComputeBudget(1) |
| **G** | Attack: `RECOVER_EMPTY` when $sold > 0$ | **PASS (Blocked by sold == 0)** | - | - |
| **H1** | Step H1: Sequential Refund Purchase 0 ($cursor: 0 \to 1, rem: 15 \to 10$) | **PASS** | 24,206 | ComputeBudget(2) |
| **H2** | Step H2: Final Refund Purchase 1 ($cursor: 1 \to \text{PAID}, rem: 10 \to 0$) | **PASS** | 15,817 | ComputeBudget(1) |
| **I** | Attack: Out-of-sequence refund ($purchase\_index = 1$ when $cursor = 0$) | **PASS (Blocked by cursor check)** | - | - |
| **J** | Attack: Tampered sibling in refund Merkle proof | **PASS (Blocked by root verify)** | - | - |
| **K** | Attack: Buyer refund underpaid by 1 sompi | **PASS (Blocked by Output 1 Amount)** | - | - |
| **L** | Attack: Buyer refund redirected to thief SPK | **PASS (Blocked by Output 1 SPK)** | - | - |
| **M** | Attack: Split attack (normal refund creates 2 covenant outputs) | **PASS (Blocked by OpAuthOutputCount)** | - | - |
| **N** | Attack: Final refund attempts to retain covenant $C$ on Output 0 | **PASS (Blocked by Terminal Guard)** | - | - |
| **O** | Attack: Final refund redirects reserve to altered thief SPK | **PASS (Blocked by reserve SPK check)** | - | - |

---

## 6. Regression & Suite Consistency Verification

All 67 independent contract tests across previously built and verified components were re-verified following the refund parameter integration:
- `unsold_refund_lifecycle_test` (15/15 PASS): Full unsold refund lifecycle, time-lock boundaries, and attack vectors.
- `ticket_ownership_test` (10/10 PASS): Parallel dual-root SMT append, adaptive root replacement defense, and SPK admissibility checks.
- `lineage_provenance_test` (14/14 PASS): KIP-20 genesis validator, singleton continuation guards, split attacks, and terminal settlement.
- `payout_settlement_test` (10/10 PASS): Atomic winner payout settlement, Merkle membership, skimming defense, and chained UTXO flow.
- `winner_selection_test` (10/10 PASS): Deterministic rejection sampling and self-replicating suffix introspection.
- `sealed_to_draw_ready_test` (8/8 PASS): KIP-21 PASS-A SeqCommit opening and input DAA boundary enforcement.

Total independent contract tests: 15 + 10 + 14 + 10 + 10 + 8 = 67.

---

## 7. Resource Audit & Testnet-10 Physical Mass

| Transaction Stage | Witness Size (SigScript) | Script Code (RedeemScript) | Script Units | $B_{min}$ | Mass | Min Relay Fee |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **CREATE** | 0 B *(fixture-only, excluding real funding-input unlocking/signature cost)* | 0 B | 0 | 0 | 1,000 g | 0.001 KAS |
| **OPEN BUY** | 8,679 B | 7,737 B | 68,597 | ComputeBudget(6) | 35,656 g | 0.035656 KAS |
| **BEGIN_REFUND** | 7,748 B | 7,737 B | 26,130 | ComputeBudget(2) | 33,520 g | 0.033520 KAS |
| **RECOVER_EMPTY** | 7,748 B | 7,737 B | 15,746 | ComputeBudget(1) | 31,450 g | 0.031450 KAS |
| **REFUNDING Step** | 1,124 B | 3,126 B | 24,206 | ComputeBudget(2) | 18,340 g | 0.018340 KAS |
| **REFUNDING Final** | 1,124 B | 3,126 B | 15,817 | ComputeBudget(1) | 16,720 g | 0.016720 KAS |
| **FINAL BUY -> SEALED** | 8,679 B | 7,737 B | 46,890 | ComputeBudget(4) | 35,656 g | 0.035656 KAS |
| **SEALED -> DRAW_READY** | 2,807 B | 2,552 B | 17,374 | ComputeBudget(1) | 12,168 g | 0.012168 KAS |
| **DRAW_READY Rejection** | 2,044 B | 2,041 B | 13,869 | ComputeBudget(1) | 9,116 g | 0.009116 KAS |
| **WINNER_READY -> PAID** | 2,728 B | 1,769 B | 15,162 | ComputeBudget(1) | 11,716 g | 0.011716 KAS |

## 8. Lifecycle & Artifact Freeze Status

- **KIP-20 Covenant Lineage**: **PASS / FROZEN** (provenance, 1-in-1-out continuation, split rejection, terminal paid/refunded).
- **Unsold Refund Core Logic**: **PASS / FROZEN** (CLTV gating, sequential SMT cursor refunding, empty reserve reclamation).
- **Unsold Refund Lifecycle**: **PASS / FROZEN** (All 15 matrix cases A-O pass 100% in real VM, verified with bounded compute budgets).
- **V1 Canonical CREATE Byte Artifact**: **NOT FROZEN**
  *Reason*: The `OPEN` Final-BUY transition path embeds the production `SEALED` contract bytecode. In the subsequent protocol stage, if a recovery/liveness branch is added to `SEALED` for the KIP-21 access-window, the `SEALED` script bytes will change, which changes the `OPEN` script bytes, which changes the genesis Output 0 SPK, and consequently modifies the canonical KIP-20 `covenant_id` $C$. Therefore, the final canonical CREATE byte artifact and covenant ID can only be frozen once the full-sale liveness / KIP-21 recovery specification is formally frozen.


