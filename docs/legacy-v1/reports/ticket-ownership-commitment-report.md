# Kaswin Canonical Ticket Ownership Commitment & Verification Report (V2)

## Executive Summary
This report documents the resolution of the critical blocker: **Old Root & Prior History Authentication** in Kaswin's Type-A Ticket Ownership Commitment under Kaspa L1 Toccata consensus (`rusty-kaspa v2.0.1`, `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`).

Prior to this fix, the covenant accepted caller-supplied siblings to compute a `new_root` without proving that the target purchase slot $k$ was currently empty in `ticket_root`. This created a vulnerability where an attacker could rewrite historical ticket leaves by supplying an arbitrary subtree.

In this release, we implemented the **Parallel Dual-Root SMT Verification Scheme**:
Using the exact same 27 Merkle siblings provided in the witness, the script simultaneously computes:
1. $\text{old\_root\_candidate} = \text{Root}(\text{EMPTY\_LEAF}, k, \text{siblings})$
2. $\text{new\_root\_candidate} = \text{Root}(\text{purchase\_leaf}, k, \text{siblings})$

The covenant enforces $\text{old\_root\_candidate} == \text{current\_ticket\_root}$ via `OpEqualVerify` before enabling any transition to successor `OPEN` or `SEALED` states. This mathematically guarantees that:
- The target slot $k$ was empty.
- All historical leaves $[0, k)$ are immutably preserved and authenticated by the consensus UTXO lineage.
- The new leaf replaces exactly slot $k$.

---

## 1. Mathematical Architecture & Byte Specification

### 1.1 Sparse Merkle Tree Parameters
- **Tree Depth**: $D = 27$ levels ($2^{27} = 134,217,728 > 100,000,000$).
- **Bit Order**: For purchase index $k$, level $i \in [0, 26]$ evaluates bit $b_i = \lfloor k / 2^i \rfloor \pmod 2$.
  - $b_i = 0$: current node is **left child**, sibling is **right child**.
  - $b_i = 1$: sibling is **left child**, current node is **right child**.
- **Canonical Hash Tags**:
  - Empty Leaf: `b"KaswinTicketEmptyV1"`
  - Payout SPK Commitment: `b"KaswinPayoutSpkV1"`
  - Ticket Range Leaf: `b"KaswinTicketRangeV1"`
  - SMT Internal Node: `b"KaswinTicketNodeV1"`

### 1.2 Binary Serializations
1. **Empty Leaf** (32 bytes):
   $$\text{empty\_leaf} = \text{BLAKE2b256}(\text{"KaswinTicketEmptyV1"})$$
   $$\text{EMPTY\_ROOT\_27} = \text{compute\_empty\_root\_27}()$$
2. **Payout SPK Commitment** (32 bytes):
   $$\text{payout\_commitment} = \text{BLAKE2b256}(\text{"KaswinPayoutSpkV1"} \parallel \text{le\_u32}(\text{len}(\text{payout\_spk})) \parallel \text{payout\_spk})$$
3. **Purchase Range Leaf** (32 bytes):
   $$\text{leaf} = \text{BLAKE2b256}(\text{"KaswinTicketRangeV1"} \parallel \text{round\_id}[32] \parallel \text{le\_u64}(k)[8] \parallel \text{le\_u64}(start)[8] \parallel \text{le\_u64}(count)[8] \parallel \text{payout\_comm}[32])$$
4. **Internal Node Hash** (32 bytes):
   $$\text{node} = \text{BLAKE2b256}(\text{"KaswinTicketNodeV1"} \parallel \text{left}[32] \parallel \text{right}[32])$$

---

## 2. On-Chain Contracts Implemented

### 2.1 `OPEN` Covenant State Machine (`contracts/open_covenant.rs`)
- **Prefix Layout (Fixed 105 bytes)**:
  `OpTxInputIndex(0)` $\parallel$ `round_id[32]` $\parallel$ `ticket_price[8]` $\parallel$ `total_tickets[8]` $\parallel$ `sold_tickets[8]` $\parallel$ `purchase_count[8]` $\parallel$ `ticket_root[32]`
- **Consensus Validations**:
  1. Stack Schema Depth Check: $\text{OpDepth} == 35$.
  2. Canonical Witness Width Checks:
     - `count`: exactly 8 bytes (`OpSize == 8`).
     - `siblings[0..26]`: each exactly 32 bytes (`OpSize == 32`).
  3. Purchase Count Bound: $\text{count} \ge 1$ and $\text{sold\_after} = \text{sold\_tickets} + \text{count} \le \text{total\_tickets}$.
  4. Exact Atomic Payment Verification:
     $$\text{expected\_exact} = \text{OpTxInputAmount}(0) + \text{ticket\_price} \times \text{count}$$
     $$\text{expected\_exact} == \text{OpTxOutputAmount}(0) \implies \text{OpEqualVerify}$$
  5. **Parallel Dual-Root SMT Verification**:
     Simultaneously evaluates 27 Merkle levels for both empty leaf and purchase leaf with sibling sharing.
     Asserts $\text{old\_root\_candidate} == \text{current\_ticket\_root}$.
  6. Successor Transition:
     - Branch A ($\text{sold\_after} < \text{total\_tickets}$): Self-Replicating Suffix Introspection extracts immutable body and advances to $\text{OPEN}(sold\_after, purchase\_count+1, new\_root)$.
     - Branch B ($\text{sold\_after} == \text{total\_tickets}$): On-the-fly $\text{application\_commitment}$ derivation and 3-part SEALED assembly advances to $\text{SEALED}(new\_root)$.

### 2.2 Standalone Winner Membership Verifier (`contracts/winner_membership.rs`)
- Verifies membership proof for winner index $W \in [0, N)$:
  1. Asserts $start\_ticket \le W < start\_ticket + count$.
  2. Canonical witness width checks: `purchase_index` (8B), `start_ticket` (8B), `count` (8B), 27 siblings (32B each).
  3. Hashes claimant's `payout_spk` into `payout_commitment`.
  4. Reconstructs `purchase_leaf` and computes Merkle root through 27 sibling levels.
  5. Asserts $\text{computed\_root} == \text{ticket\_root}$.

---

## 3. Comprehensive Verification & Attack Test Suite

All 10 mandatory test scenarios pass $100\%$ in `TxScriptEngine` (`ticket_ownership_test.rs`):

| # | Test Scenario | Expected Outcome | Result |
|---|---|---|---|
| 1 | Canonical Empty Tag Equality & Reference Oracle | `Ok(())` | **PASS** |
| 2 | BUY0: Old empty root verified, new R1 produced (`OPEN(0,0)` $\to$ `OPEN(5,1)`) | `Ok(())` | **PASS** |
| 3 | BUY1: Old R1 verified from EMPTY slot 1 + same siblings $\to$ new R2 produced | `Ok(())` | **PASS** |
| 4 | **ADAPTIVE ROOT REPLACEMENT ATTACK** (tampered siblings + matching tampered successor root) | `Err(VerifyError)` | **BLOCKED** |
| 5 | **NON-EMPTY SLOT OVERWRITE ATTACK** (attempting to overwrite occupied slot 0 in pc=1) | `Err(VerifyError)` | **BLOCKED** |
| 6 | **CANONICAL WITNESS WIDTH ATTACK** (1-byte count `0x05` instead of 8B LE) | `Err(VerifyError)` | **BLOCKED** |
| 7 | Final BUY $\to$ SEALED: old root verified, final new root inherited exactly | `Ok(())` | **PASS** |
| 8 | Winner Membership Canonical Proof ($W=12 \in [5,15)$) | `Ok(())` | **PASS** |
| 9 | Fake Winner Payout SPK Substitution Attack | `Err(VerifyError)` | **BLOCKED** |
| 10 | Real ComputeBudget Enforcement ($B_{\min}$ passes, $B_{\min} - 1$ fails with `ExceededCommittedScriptUnits`) | Both Confirmed | **VERIFIED** |

---

## 4. Testnet-10 Resource & Mass Audit

Measurements executed with consensus parameter settings (`TESTNET_PARAMS`):

| Metric | Normal BUY (BUY1) | Final BUY $\to$ SEALED | Winner Membership | Testnet-10 Limit |
|---|---|---|---|---|
| SignatureScript Length | 4,507 bytes | 4,507 bytes | 2,388 bytes | 250,000 bytes |
| RedeemScript Length | 3,599 bytes | 3,599 bytes | 1,462 bytes | 10,000 bytes |
| Actual Serialized Wire Bytes | 4,708 bytes | 4,708 bytes | 2,589 bytes | Standard Relay |
| Used Script Units | 43,151 units | 32,826 units | 13,935 units | Bound by $B_{\min}$ |
| $B_{\min}$ (Covering Budget) | `ComputeBudget(4)` | `ComputeBudget(3)` | `ComputeBudget(1)` | Allowed |
| Compute Mass | 5,078 gram | 5,078 gram | 2,959 gram | 500,000 gram |
| Transient Mass | 18,832 gram | 18,832 gram | 10,356 gram | 1,000,000 gram |
| Storage Mass | 0 gram | 0 gram | 0 gram | 500,000 gram |
| Overall Normalized Mass | 18,832 gram | 18,832 gram | 10,356 gram | 500,000 gram |
| Minimum Relay Fee | $\sim 0.018832\text{ KAS}$ | $\sim 0.018832\text{ KAS}$ | $\sim 0.010356\text{ KAS}$ | Negligible |
