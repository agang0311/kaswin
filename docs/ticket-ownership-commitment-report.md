# Kaswin Canonical Ticket Ownership Commitment & Verification Report

## Executive Summary
This report formalizes, specifies, and verifies Kaswin's **Canonical Ticket Ownership Commitment** (Type-A) under Kaspa L1 Toccata consensus (`rusty-kaspa v2.0.1`, `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`).

We designed and verified an on-chain, zero-gap Range-Leaf Sparse Merkle Tree (SMT) with depth $D = 27$ (supporting up to $2^{27} = 134,217,728$ purchases, exceeding the protocol capacity $\text{MAX\_TOTAL\_TICKETS} = 100,000,000$). Each `BUY` operation commits to a contiguous interval $[start\_ticket, start\_ticket + count)$ in a single leaf, eliminating leaf ballooning while maintaining exact mathematical verification of atomic payouts and state transitions.

---

## 1. Mathematical Architecture & Byte Specification

### 1.1 Sparse Merkle Tree Parameters
- **Tree Depth**: $D = 27$ levels ($2^{27} = 134,217,728 > 100,000,000$).
- **Bit Order**: For purchase index $k$, level $i \in [0, 26]$ evaluates bit $b_i = \lfloor k / 2^i \rfloor \pmod 2$.
  - $b_i = 0$: current node is **left child**, sibling is **right child**.
  - $b_i = 1$: sibling is **left child**, current node is **right child**.
- **Preimage Separation Tags**:
  - Payout SPK Commitment: `b"KaswinPayoutSpkV1"`
  - Ticket Range Leaf: `b"KaswinTicketRangeV1"`
  - SMT Internal Node: `b"KaswinTicketNodeV1"`
  - Empty Leaf: `b"KaswinEmptyTicketLeafV1"`

### 1.2 Binary Serializations
1. **Payout SPK Commitment** (32 bytes):
   $$\text{payout\_commitment} = \text{BLAKE2b256}(\text{"KaswinPayoutSpkV1"} \parallel \text{le\_u32}(\text{len}(\text{payout\_spk})) \parallel \text{payout\_spk})$$
2. **Purchase Range Leaf** (32 bytes):
   $$\text{leaf} = \text{BLAKE2b256}(\text{"KaswinTicketRangeV1"} \parallel \text{round\_id}[32] \parallel \text{le\_u64}(\text{purchase\_index})[8] \parallel \text{le\_u64}(\text{start\_ticket})[8] \parallel \text{le\_u64}(\text{count})[8] \parallel \text{payout\_commitment}[32])$$
3. **Internal Node Hash** (32 bytes):
   $$\text{node} = \text{BLAKE2b256}(\text{"KaswinTicketNodeV1"} \parallel \text{left}[32] \parallel \text{right}[32])$$
4. **Empty Leaf & Empty Levels**:
   $$\text{empty\_leaf} = \text{BLAKE2b256}(\text{"KaswinEmptyTicketLeafV1"})$$
   $$\text{empty\_level}[0] = \text{empty\_leaf}, \quad \text{empty\_level}[i+1] = \text{hash\_internal\_node}(\text{empty\_level}[i], \text{empty\_level}[i])$$
   $$\text{EMPTY\_ROOT\_27} = \text{compute\_empty\_root\_27}()$$

---

## 2. On-Chain Contracts Implemented

### 2.1 `OPEN` Covenant State Machine (`contracts/open_covenant.rs`)
- **Prefix Layout (Fixed 105 bytes)**:
  `OpTxInputIndex(0)` $\parallel$ `round_id[32]` $\parallel$ `ticket_price[8]` $\parallel$ `total_tickets[8]` $\parallel$ `sold_tickets[8]` $\parallel$ `purchase_count[8]` $\parallel$ `ticket_root[32]`
- **Consensus Validations**:
  1. Stack Schema Depth Check: $\text{OpDepth} == 35$.
  2. Purchase Count Bound: $\text{count} \ge 1$ and $\text{sold\_after} = \text{sold\_tickets} + \text{count} \le \text{total\_tickets}$.
  3. Conservation of Principal & Atomic Payment:
     $$\text{expected\_min} = \text{OpTxInputAmount}(0) + \text{ticket\_price} \times \text{count}$$
     $$\text{expected\_min} \le \text{OpTxOutputAmount}(0) \implies \text{OpLessThanOrEqual}$$
  4. 27-Level SMT Reconstruction: computes `new_root` on-chain via bit-shifting and conditional pairing.
  5. Deterministic Successor Transition:
     - **Branch A ($\text{sold\_after} < \text{total\_tickets}$)**: Self-Replicating Suffix Introspection extracts the immutable covenant body, prepends the next prefix, and enforces $\text{OpTxOutputSpk}(0) == \text{P2SH}(\text{OPEN}(sold\_after, purchase\_count+1, new\_root))$.
     - **Branch B ($\text{sold\_after} == \text{total\_tickets}$)**: Derives $\text{application\_commitment}$ on-the-fly, assembles production $\text{SEALED}$ covenant, and enforces $\text{OpTxOutputSpk}(0) == \text{P2SH}(\text{SEALED}(new\_root))$.

### 2.2 Standalone Winner Membership Verifier (`contracts/winner_membership.rs`)
- Verifies membership proof for winner index $W \in [0, N)$:
  1. Asserts $start\_ticket \le W < start\_ticket + count$.
  2. Hashes claimant's `payout_spk` into `payout_commitment`.
  3. Reconstructs `purchase_leaf` and computes Merkle root through 27 sibling levels.
  4. Asserts $\text{computed\_root} == \text{ticket\_root}$.

---

## 3. Comprehensive Verification & Attack Test Suite

All 12 validation and adversarial attack scenarios pass $100\%$ in `TxScriptEngine` (`ticket_ownership_test.rs`):

| # | Test Scenario | Expected Outcome | Result |
|---|---|---|---|
| 1 | `OPEN(0,0)` $\to$ BUY 5 Tickets $\to$ `OPEN(5,1)` | `Ok(())` | **PASS** |
| 2 | Consecutive BUY 10 Tickets $\to$ `OPEN(15,2)` | `Ok(())` | **PASS** |
| 3 | Sold-out BUY 85 Tickets $\to$ `SEALED` | `Ok(())` | **PASS** |
| 4 | On-chain Winner Membership Verifier ($W=12 \in [5,15)$) | `Ok(())` | **PASS** |
| 5 | Underpayment Attack ($0.4\text{ KAS}$ paid for $0.5\text{ KAS}$) | `Err(VerifyError)` | **BLOCKED** |
| 6 | Oversell Attack ($86$ tickets attempted when $85$ remain) | `Err(VerifyError)` | **BLOCKED** |
| 7 | Zero Ticket Purchase ($count = 0$) | `Err(VerifyError)` | **BLOCKED** |
| 8 | Counterfeit Successor SPK Redirection Attack | `Err(VerifyError)` | **BLOCKED** |
| 9 | Merkle Fraud Path (tampered sibling hash) | `Err(VerifyError)` | **BLOCKED** |
| 10 | Winner Membership Out-of-Bounds ($W=15 \notin [5,15)$) | `Err(VerifyError)` | **BLOCKED** |
| 11 | Fake Winner Payout SPK Substitution Attack | `Err(VerifyError)` | **BLOCKED** |
| 12 | Complete Resource & Mass Measurements | Within Limits | **VERIFIED** |

---

## 4. Resource & Wire Mass Audit

| Parameter | Measured Size | Consensus Constant / Limit | Status |
|---|---|---|---|
| `OPEN` Prefix Length | 105 bytes | Constant | Fixed |
| `OPEN` Body Length | 2,129 bytes | Constant | Fixed |
| Total `OPEN` Redeem Script | 2,234 bytes | $\le 10,000$ bytes | Safe ($22.3\%$) |
| Winner Membership Script | 1,241 bytes | $\le 10,000$ bytes | Safe ($12.4\%$) |
| Witness Signature Script (31 items) | 2,167 bytes | $\le 250,000$ bytes | Safe ($0.87\%$) |
| Non-Contextual Compute Mass | 3,380 gram | $\le 500,000$ gram | Well within budget |
| Non-Contextual Transient Mass | 13,372 gram | $\le 500,000$ gram | Well within budget |
| Non-Contextual Fee Mass | 13,372 gram | Standard Relay | $\sim 0.013372\text{ KAS}$ |
