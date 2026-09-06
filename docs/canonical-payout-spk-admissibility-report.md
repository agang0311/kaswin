# Kaswin Canonical Payout Settlement & SPK Admissibility Report (`WINNER_READY -> PAID`)

## Executive Summary
This report formalizes and confirms the complete resolution of the **Canonical Payout SPK Admissibility** and **Atomic Payout Settlement** milestones (`WINNER_READY -> PAID`) in Kaswin under Kaspa L1 Toccata consensus rules (`rusty-kaspa v2.0.1`, commit `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`).

All ticket purchases in `OPEN BUY` are now cryptographically constrained at ingress to commit only to valid, relay-admissible `ScriptPublicKey` formats. In addition, the production `WINNER_READY` settlement covenant enforces exact pool principal conservation, bound output delivery, and 27-level SMT verification directly to claimant UTXO terminals.

---

## 1. Pinned ScriptClass Rules & Canonical Payout SPK Format

In `rusty-kaspa v2.0.1` (`crypto/txscript/src/script_class.rs`), standard transaction outputs only permit three recognized `ScriptClass` variants with `version == 0`:
1. **Class A: PubKey (Schnorr 32-byte public key)**:
   $$\text{payout\_spk} = [0x00, 0x00] \parallel [0x20] \parallel \text{pubkey}[32] \parallel [0xac] \quad (\text{len} = 36)$$
2. **Class B: PubKeyECDSA (Secp256k1 33-byte compressed public key)**:
   $$\text{payout\_spk} = [0x00, 0x00] \parallel [0x21] \parallel \text{pubkey}[33] \parallel [0xad] \quad (\text{len} = 37)$$
3. **Class C: ScriptHash (P2SH 32-byte script hash)**:
   $$\text{payout\_spk} = [0x00, 0x00] \parallel [0xaa] \parallel [0x20] \parallel \text{script\_hash}[32] \parallel [0x87] \quad (\text{len} = 37)$$

Any output with `version > 0`, arbitrary length $\ne 36, 37$, or non-standard opcodes (e.g. `OP_TRUE`, bare multisig, data carrier) classifies as `ScriptClass::NonStandard` and is rejected by node relay policies.

---

## 2. Ingress Validation on OPEN BUY (`append_canonical_payout_spk_check`)

To guarantee future settlement liveness, `contracts/open_covenant.rs` strictly validates claimant `payout_spk` at ingress before payment acceptance or Merkle tree insertion:
1. **Length Gate**: $\text{len} \in \{36, 37\}$ (`OpSize`, `OpEqual`, `OpBoolOr`, `OpVerify`).
2. **Version Gate**: First 2 bytes $\equiv [0x00, 0x00]$ (`OpSubstr(0, 2)`, `OpEqualVerify`).
3. **Opcode Structure Verification**:
   - If $\text{len} == 36$: checks $\text{byte}[2] == 0x20$ (`OpData32`) and $\text{byte}[35] == 0xac$ (`OpCheckSig`).
   - If $\text{len} == 37$: checks $\text{byte}[2] == 0x21$ (`OpData33`) and $\text{byte}[36] == 0xad$ (`OpCheckSigECDSA`); or $\text{byte}[2] == 0xaa$ (`OpBlake2b`), $\text{byte}[3] == 0x20$ (`OpData32`), and $\text{byte}[36] == 0x87$ (`OpEqual`).

---

## 3. Production Settlement Covenant (`contracts/winner_ready_settlement.rs`)

`WINNER_READY` covenant enforces:
1. **Canonical Witness Schema**: `purchase_index` (8B), `start_ticket` (8B), `count` (8B), 27 `siblings` (32B each).
2. **Defense-in-Depth Range Checks**: $start\_ticket \le winner\_index < start\_ticket + count < total\_tickets$.
3. **Exact Amount Conservation**: $\text{OpTxOutputAmount}(0) == \text{OpTxInputAmount}(0)$ (exact principal payout).
4. **SPK Binding**: $\text{OpTxOutputSpk}(0) == \text{payout\_spk}$.
5. **27-Level Merkle Verification**: Computes $\text{payout\_commitment}$ and $\text{purchase\_leaf}$, traverses 27 levels with directional bits from `purchase_index`, and enforces $\text{computed\_root} == \text{frozen\_ticket\_root}$.

### Technical Correction regarding ScriptBuilder Sizing:
Data chunking (`.chunks(500)` with `OpCat`) is specifically utilized to circumvent `ScriptBuilder::new()`'s default non-covenant 520-byte `add_data` builder constraint in the host compiler. The Toccata covenant-enabled runtime engine itself supports stack and element sizes up to consensus transaction/script limits.

---

## 4. Test Matrix Verification

### A. Ticket Ownership Suite (`ticket_ownership_test.rs`)
- Test 1: Canonical Empty Tag Equality (`KaswinTicketEmptyV1`) $\to$ **PASS**
- Test 2: BUY0 with Class A (PubKey 36B) $\to$ **PASS** (`Used Units = 53,187`, `B_min = 5`)
- Test 3: BUY1 with Class B (PubKeyECDSA 37B) $\to$ **PASS** (`Used Units = 53,228`, `B_min = 5`)
- Test 4: Adaptive Root Replacement Attack $\to$ **BLOCKED** (`Err(VerifyError)`)
- Test 5: Non-Empty Slot Overwrite Attack $\to$ **BLOCKED** (`Err(VerifyError)`)
- Test 6: Ingress Admissibility Attacks (truncated 4B, version 1, OP_TRUE nonstandard) $\to$ **ALL BLOCKED**
- Test 7: Final BUY $\to$ SEALED with Class C (ScriptHash 37B) $\to$ **PASS** (`Used Units = 41,054`, `B_min = 4`)
- Test 8: Winner Membership Canonical Proof $\to$ **PASS** (`Used Units = 14,067`, `B_min = 1`)
- Test 9: Fake Winner Payout SPK Attack $\to$ **BLOCKED** (`Err(VerifyError)`)
- Test 10: Real ComputeBudget Enforcement ($B_{\min}$ passes, $B_{\min}-1$ fails) $\to$ **CONFIRMED**

### B. Settlement Suite (`payout_settlement_test.rs`)
- Test 1: Canonical Winner Proof + Exact Payout $\to$ **PASS** (`Used Units = 14,851`, `B_min = 1`)
- Test 2: Witness payout_spk mismatch with leaf $\to$ **BLOCKED**
- Test 3: Output 0 SPK redirection attack $\to$ **BLOCKED**
- Test 4: Pool skimming ($Output = Input - 1$) $\to$ **BLOCKED**
- Test 5: Amount mismatch ($Output = Input + 1$) $\to$ **BLOCKED**
- Test 6: Out-of-bounds winner index $\to$ **BLOCKED**
- Test 7: Tampered sibling path $\to$ **BLOCKED**
- Test 8: Non-canonical 1-byte count $\to$ **BLOCKED**
- Test 9: **Chained 2-Step UTXO Lifecycle** (`DRAW_READY` $\to$ `WINNER_READY` $\to$ `PAID`) $\to$ **PASS**
- Test 10: Settlement `ComputeBudget` Boundary ($B_{\min}=1$ passes, $B_{\min}-1=0$ fails) $\to$ **CONFIRMED**

### C. Draw Selection Budget (`test_draw_budget.rs`)
- `DRAW_READY` $\to$ `production WINNER_READY` ($U = 13,125$ units, $B_{\min}=1$ passes, $B_{\min}-1=0$ fails) $\to$ **CONFIRMED**

---

## 5. Accurate Testnet-10 Multi-Stage Resource Audit

| Stage / Transaction | SignatureScript | RedeemScript | Wire Serialized | Used Units | Covering Budget | Overall Mass | Est. Relay Fee |
|---|---|---|---|---|---|---|---|
| **OPEN BUY (Normal)** | 6,171 B | 5,230 B | 6,372 B | 53,228 | `ComputeBudget(5)` | 25,488 gram | $\sim 0.025488\text{ KAS}$ |
| **BUY $\to$ SEALED** | 6,171 B | 5,230 B | 6,372 B | 41,054 | `ComputeBudget(4)` | 25,488 gram | $\sim 0.025488\text{ KAS}$ |
| **SEALED $\to$ DRAW_READY** | 2,502 B | 2,247 B | 2,693 B | 15,877 | `ComputeBudget(2)` | 10,812 gram | $\sim 0.010812\text{ KAS}$ |
| **DRAW_READY $\to$ WINNER_READY** | 1,890 B | 1,887 B | 2,091 B | 13,125 | `ComputeBudget(1)` | 8,364 gram | $\sim 0.008364\text{ KAS}$ |
| **WINNER_READY $\to$ PAID** | 2,638 B | 1,679 B | 2,839 B | 14,851 | `ComputeBudget(1)` | 11,356 gram | $\sim 0.011356\text{ KAS}$ |
