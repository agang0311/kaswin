# Kaswin Atomic Payout Settlement Report (`WINNER_READY -> PAID`)

## Executive Summary
This report documents the design, formalization, and verification of the atomic terminal settlement state (`WINNER_READY -> PAID`) in Kaswin under Kaspa L1 Toccata consensus rules (`rusty-kaspa v2.0.1`, commit `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`).

With this milestone:
1. The **Canonical Payout SPK Byte Format** was analyzed and pinned against consensus implementation: `OpTxOutputSpk(0)` returns the 2-byte big-endian version prefix concatenated with raw script bytes (`version.to_be_bytes() || script`).
2. The **Production Settlement Covenant (`WINNER_READY`)** was implemented and connected directly to `DRAW_READY`'s accepted candidate branch.
3. The **Chained 2-Step UTXO Lifecycle** (`DRAW_READY` $\to$ `WINNER_READY` $\to$ `PAID`) was verified $100\%$ end-to-end in `TxScriptEngine` with real `ComputeBudget` constraints and `TESTNET_PARAMS` mass enforcement.

---

## 1. Canonical Payout SPK Format (`OpTxOutputSpk`)

In `rusty-kaspa v2.0.1`:
- Source: `crypto/txscript/src/opcodes/mod.rs:1332`:
  ```rust
  vm.dstack.push(output.script_public_key.to_bytes().into())
  ```
- Trait Implementation: `crypto/txscript/src/lib.rs:950`:
  ```rust
  impl SpkEncoding for ScriptPublicKey {
      fn to_bytes(&self) -> Vec<u8> {
          self.version.to_be_bytes().into_iter().chain(self.script().iter().copied()).collect()
      }
  }
  ```
- Format:
  $$\text{payout\_spk} = \text{be\_u16}(\text{version})[2] \parallel \text{script\_bytes}[L]$$
  For standard P2SH: `0x00, 0x00, 0xaa, 0x20, <32-byte script hash>, 0x87` (37 bytes).

This byte representation is used uniformly across:
- `ticket_commitment.rs`: `compute_payout_commitment`
- `open_covenant.rs`: `purchase_leaf` assembly
- `winner_ready_settlement.rs`: `OpTxOutputSpk(0)` equality verification

---

## 2. Production Settlement Suffix & Binding Architecture

### 2.1 Prefix Immutability
`WINNER_READY` state prefix (fixed 144 bytes + minimal 8B winner index push):
`OpTxInputIndex(0)` $\parallel$ `round_id[32]` $\parallel$ `ticket_root[32]` $\parallel$ `total_tickets[8]` $\parallel$ `target_hash[32]` $\parallel$ `random_seed[32]` $\parallel$ `winner_index[8]`

### 2.2 Settlement Suffix (`build_winner_ready_settlement_suffix`)
1. **Schema & Witness Widths**:
   - `purchase_index`: 8 bytes (`OpSize == 8`)
   - `start_ticket`: 8 bytes (`OpSize == 8`)
   - `count`: 8 bytes (`OpSize == 8`)
   - 27 `siblings`: each 32 bytes (`OpSize == 32`)
2. **Range Verification**:
   - $\text{winner\_index} < \text{total\_tickets}$
   - $\text{start\_ticket} \le \text{winner\_index}$
   - $\text{winner\_index} < \text{start\_ticket} + \text{count}$
3. **Exact Amount & SPK Binding**:
   - $\text{OpTxOutputAmount}(0) == \text{OpTxInputAmount}(0)$ (exact principal payout, fee paid by auxiliary inputs)
   - $\text{OpTxOutputSpk}(0) == \text{payout\_spk}$ (Output 0 strictly pays the winner SPK committed in Merkle tree)
4. **27-Level Merkle Proof Traversal**:
   - Computes $\text{payout\_commitment}$ and $\text{purchase\_leaf}$.
   - Traverses 27 SMT levels and enforces $\text{computed\_root} == \text{frozen\_ticket\_root}$ via `OpEqualVerify`.

---

## 3. Chained UTXO Execution & Adversarial Verification

All 10 test cases in `payout_settlement_test.rs` pass in `TxScriptEngine`:

| # | Test Scenario | Target Phase | Result |
|---|---|---|---|
| 1 | Canonical Winner Proof + Exact Payout | `WINNER_READY -> PAID` | **PASS** (`Ok(())`) |
| 2 | Attack: Witness `payout_spk` mismatch with Merkle leaf | Verification | **BLOCKED** (`Err(VerifyError)`) |
| 3 | Attack: Valid Merkle proof, but Output 0 SPK pays attacker | SPK Binding | **BLOCKED** (`Err(VerifyError)`) |
| 4 | Attack: Output 0 Amount = Input 0 Amount - 1 (skimming) | Value Equality | **BLOCKED** (`Err(VerifyError)`) |
| 5 | Attack: Output 0 Amount = Input 0 Amount + 1 (mismatch) | Value Equality | **BLOCKED** (`Err(VerifyError)`) |
| 6 | Attack: `winner_index` out of bounds ($W=15 \notin [5, 15)$) | Range Check | **BLOCKED** (`Err(VerifyError)`) |
| 7 | Attack: Tampered sibling path in settlement witness | Merkle Check | **BLOCKED** (`Err(VerifyError)`) |
| 8 | Attack: Non-canonical 1-byte count witness (`0x0a`) | Schema Width | **BLOCKED** (`Err(VerifyError)`) |
| 9 | **Chained UTXO**: `DRAW_READY -> WINNER_READY -> PAID` | End-to-End | **PASS** (`Ok(())`) |
| 10 | Real `ComputeBudget` Enforcement ($B_{\min}$ passes, $B_{\min}-1$ fails) | Consensus Budget | **CONFIRMED** |

---

## 4. Accurate Testnet-10 Resource Audit

Measurements executed using `TESTNET_PARAMS` consensus rules:

| Metric | DRAW_READY $\to$ WINNER_READY | WINNER_READY $\to$ PAID | Testnet-10 Limit |
|---|---|---|---|
| SignatureScript Length | 1,803 bytes | 2,553 bytes | 250,000 bytes |
| RedeemScript Length | 1,800 bytes | 1,594 bytes | 10,000 bytes |
| Actual Serialized Size | 2,004 bytes | 2,754 bytes | Standard Relay |
| Used Script Units | 11,043 units | 14,522 units | Bound by $B_{\min}$ |
| $B_{\min}$ (Covering Budget) | `ComputeBudget(1)` | `ComputeBudget(1)` | Allowed |
| Compute Mass | 2,374 gram | 3,124 gram | 500,000 gram |
| Transient Mass | 8,016 gram | 11,016 gram | 1,000,000 gram |
| Storage Mass | 0 gram | 0 gram | 500,000 gram |
| Overall Normalized Mass | 8,016 gram | 11,016 gram | 500,000 gram |
| Minimum Relay Fee | $\sim 0.008016\text{ KAS}$ | $\sim 0.011016\text{ KAS}$ | Negligible |
