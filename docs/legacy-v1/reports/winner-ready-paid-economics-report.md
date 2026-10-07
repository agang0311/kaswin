# Kaswin V1 — WINNER_READY -> PAID Terminal Settlement Economics Report

## 1. Executive Summary & Verdict

- **VERDICT**: `WINNER_READY -> PAID ECONOMICS PASS`
- **STATUS**: Isolated Validation Harness Verified in `tests/rust-vm-validation/src/bin/winner_ready_paid_economics_spike.rs`
- **PRODUCTION CONTRACT STATUS**: Frozen & Unmodified (`contracts/*.rs` remain completely untouched on branch `audit/state-deposit-v1`)

The WINNER_READY terminal settlement covenant atomically distributes round funds into three standard P2PK outputs, strictly terminates the KIP-20 covenant lineage, derives creator `state_deposit` without redundant on-chain storage, enforces that deductions come exclusively from `gross_pool`, and bounds the implicit miner fee to `0 <= F <= MAX_FINALIZE_FEE`.

---

## 2. Canonical Economic Model & Parameter Bounds

### 2.1 Currency Units & Fixed Consensus Constants
- **SOMPI_PER_KASPA**: `100,000,000 = 10^8`
- **MAX_SOMPI**: `29,000,000,000 * 100,000,000 = 2,900,000,000,000,000,000 sompi = 2.9 * 10^18 sompi` (29 billion KAS)
- **Signed 64-bit Integer Domain**: `i64::MAX = 9,223,372,036,854,775,807 = ~9.223 * 10^18`
- **MAX_TICKET_CAP**: `100,000 = 10^5`
- **Maximum Candidate Ticket Price**: `10,000 KAS = 10,000 * 10^8 = 10^12 sompi` (NOT `10^13 sompi`)
- **Maximum Candidate Gross Pool**:
  $$G_{\max} = 100,000 \times 10^{12} = 10^{17} \text{ sompi} = 1,000,000,000 \text{ KAS}$$
- **Integer Domain Comparison**:
  $$G_{\max} (10^{17}) < \text{MAX\_SOMPI } (2.9 \times 10^{18}) < i64\text{::MAX } (9.22 \times 10^{18})$$
  Every legal combination of ticket price and ticket count is guaranteed to operate strictly within the signed 64-bit integer domain without overflow.

### 2.2 Symbolic Protocol Constants (Candidate Values)
- `FINALIZER_REWARD`: `100,000,000 sompi` (1.0 KAS)
- `MAX_FINALIZE_FEE`: `50,000,000 sompi` (0.5 KAS)
- `MIN_WINNER_PAYOUT`: `100,000,000 sompi` (1.0 KAS)

### 2.3 CREATE-Time Economic Invariant
A lottery round is economically valid at creation time if and only if:
$$\text{ticket\_price} \times \text{min\_tickets} \ge \text{FINALIZER\_REWARD} + \text{MAX\_FINALIZE\_FEE} + \text{MIN\_WINNER\_PAYOUT}$$
For candidate values:
$$\text{ticket\_price} \times \text{min\_tickets} \ge 1.0 + 0.5 + 1.0 = 2.5 \text{ KAS } (250,000,000 \text{ sompi})$$
Any creation parameter failing this condition must be rejected during contract instantiation to prevent terminal deadlock.

---

## 3. Terminal Transaction Topology & Settlement Accounting

### 3.1 Input / Output Topology
- **Inputs**: Exactly 1 state input (`OpTxInputCount == 1`):
  - Input 0: `WINNER_READY` covenant UTXO with total amount $S = \text{Input0Amount}$
- **Outputs**: Exactly 3 outputs (`OpTxOutputCount == 3`):
  - Output 0: Winner Net Prize Payout
  - Output 1: Creator State Deposit Return
  - Output 2: Fixed Finalizer Reward

### 3.2 Accounting Invariants
Let:
- $S = \text{Input0Amount}$
- $N = \text{draw\_ticket\_count}$ (actual sold tickets in partial or full sale)
- $G = \text{ticket\_price} \times N$ (actual gross pool, NOT based on ticket_cap)
- $D = S - G$ (derived creator state deposit)
- $R = \text{FINALIZER\_REWARD}$
- $W = \text{Output0Amount}$
- $C = \text{Output1Amount}$
- $R_{\text{act}} = \text{Output2Amount}$
- $F = S - (W + C + R_{\text{act}})$ (implicit miner fee)

The on-chain covenant strictly enforces:
1. **Creator Deposit Non-Funding**:
   $$C = D = S - G$$
   The creator state deposit $D$ is returned 100% intact to `creator_refund_spk`. It is strictly forbidden from funding miner fees, finalizer rewards, or winner prize money.
2. **Fixed Finalizer Reward**:
   $$R_{\text{act}} = R = \text{FINALIZER\_REWARD}$$
3. **Winner Net Payout**:
   $$W = G - R - F \ge \text{MIN\_WINNER\_PAYOUT}$$
4. **Fee Bounds**:
   $$0 \le F \le \text{MAX\_FINALIZE\_FEE}$$
5. **Exact Balance Conservation**:
   $$W + C + R + F = S$$

---

## 4. Consensus Validity vs. Mempool Relayability

The on-chain script consensus rule is intentionally permissive:
$$0 \le F \le \text{MAX\_FINALIZE\_FEE}$$
However, the standard Rusty-Kaspa mining mempool enforces a minimum relay fee floor based on physical transaction fee mass:
$$\text{fee\_mass} = \max(\text{compute\_mass}, \text{norm\_transient\_mass}) = 2,466 \text{ grams}$$
$$\text{relay\_floor} = \frac{2,466 \times 100,000 \text{ sompi/kg}}{1,000 \text{ g/kg}} = 246,600 \text{ sompi } (\approx 0.00247 \text{ KAS})$$

### Relay Fee Matrix
Fee $F$ (sompi) | Consensus Validity | Mempool Relay Policy | Status
----------------|--------------------|----------------------|---------------------------
$F = 0$         | VALID (PASS)       | BELOW RELAY FLOOR    | Miner-only / zero-fee block
$F = 20,000$    | VALID (PASS)       | BELOW RELAY FLOOR    | Mempool rejected (fee too low)
$F = 246,599$   | VALID (PASS)       | BELOW RELAY FLOOR    | Mempool rejected (floor - 1)
$F = 246,600$   | VALID (PASS)       | RELAYABLE (PASS)     | Standard relay floor met
$F = 50,000,000$| VALID (PASS)       | RELAYABLE (PASS)     | Maximum allowed bounty fee

**Crucial Invariant Verified**: $\text{MAX\_FINALIZE\_FEE } (50,000,000 \text{ sompi}) \ge \text{relay\_floor } (246,600 \text{ sompi})$. The allowed fee ceiling comfortably covers more than 200× the standard relay floor.

---

## 5. Terminal Covenant=None Proof & Lineage Destruction

The WINNER_READY settlement script enforces complete KIP-20 covenant lineage termination across all outputs:
1. `OpAuthOutputCount(0) == 0`: Input 0 authorizes zero covenant outputs.
2. `OpCovOutputCount(C) == 0`: Zero outputs carry covenant ID $C$ in the transaction.
3. `OpOutputCovenantId(0) == ZERO_HASH` & `OpOutputAuthorizingInput(0) == -1`
4. `OpOutputCovenantId(1) == ZERO_HASH` & `OpOutputAuthorizingInput(1) == -1`
5. `OpOutputCovenantId(2) == ZERO_HASH` & `OpOutputAuthorizingInput(2) == -1`

Any transaction attempting to attach a covenant binding (whether same ID $C$ or a foreign covenant ID) to Output 0, Output 1, or Output 2 is rejected by consensus and VM execution.

---

## 6. Resource Measurements (Testnet 10)

Scenario                         | Redeem  | Sig     | Tx      | ScriptUnits | Budget           | Compute | Transient | Norm  | Storage | Relay Floor   | Actual Fee  | VM Time
---------------------------------+---------+---------+---------+-------------+------------------+---------+-----------+-------+---------+---------------+-------------+--------
1. Main Settlement (F=0)         |   544 B |   582 B |   886 B |   1,759 SU  | Budget(0) (PASS) | comp=2466 | trans=3544  | norm=1772 | stor=11285 | 246,600 sompi |       0 sompi | 2.14ms
2. Main Settlement (F=20,000)    |   544 B |   582 B |   886 B |   1,763 SU  | Budget(0) (PASS) | comp=2466 | trans=3544  | norm=1772 | stor=11285 | 246,600 sompi |  20,000 sompi | 2.14ms
3. Main Settlement (F=0.5 KAS)   |   544 B |   582 B |   886 B |   1,767 SU  | Budget(0) (PASS) | comp=2466 | trans=3544  | norm=1772 | stor=11417 | 246,600 sompi | 50,000,000 sompi | 2.14ms
4. Min Draw Settlement (N=2,500) |   544 B |   582 B |   886 B |   1,760 SU  | Budget(0) (PASS) | comp=2466 | trans=3544  | norm=1772 | stor=39628 | 246,600 sompi | 50,000,000 sompi | 2.14ms
5. Full Cap Settlement (N=100k)  |   544 B |   582 B |   886 B |   1,762 SU  | Budget(0) (PASS) | comp=2466 | trans=3544  | norm=1772 | stor=11729 | 246,600 sompi |  25,000 sompi | 2.14ms

---

## 7. Negative Adversarial Matrix (20 Verified Cases)

  #01: wrong winner payout SPK                       -> FAIL (OpEqualVerify Mismatch)
  #02: winner amount +1 (exceeds pool, F < 0)        -> FAIL (OpVerify Failure on F >= 0)
  #03: winner amount -1 (F > MAX_FINALIZE_FEE)       -> FAIL (OpVerify Failure on F <= MAX_FINALIZE_FEE)
  #04: wrong creator refund SPK                      -> FAIL (OpEqualVerify Mismatch)
  #05: creator deposit -1 sompi                      -> FAIL (OpEqualVerify Mismatch on Output1Amount == D)
  #06: creator deposit +1 sompi                      -> FAIL (OpEqualVerify Mismatch on Output1Amount == D)
  #07: wrong finalizer SPK binding                   -> FAIL (OpEqualVerify Mismatch on Output2 SPK)
  #08: finalizer reward -1 sompi                     -> FAIL (OpNumEqualVerify Mismatch on Output2Amount == R)
  #09: finalizer reward +1 sompi                     -> FAIL (OpNumEqualVerify Mismatch on Output2Amount == R)
  #10: F = MAX_FINALIZE_FEE + 1 sompi                -> FAIL (OpVerify Failure on F <= MAX_FINALIZE_FEE)
  #11: negative fee / total outputs exceed input     -> FAIL (OpVerify Failure on F >= 0)
  #12: hidden fourth output added                    -> FAIL (OpNumEqualVerify Mismatch on OpTxOutputCount == 3)
  #13: extra state continuation on Output 0          -> FAIL (Consensus CovenantsContext Rejection)
  #14: duplicate Kaswin covenant outputs             -> FAIL (Consensus CovenantsContext Rejection)
  #15: foreign covenant output on Output 0           -> FAIL (Consensus CovenantsContext Rejection)
  #15b: foreign covenant output on Output 1          -> FAIL (OpEqualVerify on OutputCovenantId(1) == ZERO_HASH)
  #15c: foreign covenant output on Output 2          -> FAIL (OpEqualVerify on OutputCovenantId(2) == ZERO_HASH)
  #16: wrong draw_ticket_count in state              -> FAIL (OpEqualVerify Mismatch on Output1Amount == D)
  #17: wrong ticket_price in state                   -> FAIL (OpEqualVerify Mismatch on Output1Amount == D)
  #18: input0 amount inconsistent with D + G         -> FAIL (OpEqualVerify Mismatch on Output1Amount == D)
  #19: winner output below MIN_WINNER_PAYOUT         -> FAIL (OpVerify Failure on Output0Amount >= MIN)
  #20: malformed finalizer SPK (33B instead of 34B)  -> FAIL (OpNumEqualVerify Mismatch on len == 34)
