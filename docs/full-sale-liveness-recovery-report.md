# Kaswin Protocol V1: Production SEALED Dual-Action State Machine & Full-Sale Liveness Recovery Report

**Status**: FROZEN / PRODUCTION READY  
**Protocol Version**: Kaswin V1 (Toccata Consensus Rules)  
**Verification Level**: 100% On-Chain Native Execution (`rusty-kaspa` TxScript VM)  
**Pinned Dependencies**:
- `kaspanet/rusty-kaspa`: Release `v2.0.1`, commit `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`
- `kaspanet/kips`: Commit `e4ae2332117b5cb68bd6188e065ef885b6d17939` (KIP-16, 17, 20, 21)

---

## 1. Architectural Overview

When an active Kaswin lottery round sells out its total ticket supply ($sold = total\_tickets$), the singleton covenant transitions from `OPEN` into `SEALED`. In Kaswin Protocol V1, the `SEALED` covenant is governed by a **Dual-Action Branching Engine**:

1. **`ACTION_DRAW` (Selector = 1)**:
   - Evaluates on-chain randomness via KIP-21 PASS-A 240-byte Opening.
   - Enforces DAA inclusion window: $TargetDAA \ge D_0 + \Delta_{DAA}$.
   - Authenticates target block sequencing commitment via `OpChainblockSeqCommit`.
   - Derives dynamic application commitment:
     $$Comm_{app} = \text{BLAKE2b256}(\text{"KaswinAppV1"} \parallel round\_id[32] \parallel ticket\_root[32] \parallel \text{le\_u64}(total\_tickets))$$
   - Computes deterministic random seed:
     $$Seed_{random} = \text{BLAKE2b256}(\text{"KaspaPoWRandomnessV1"} \parallel target\_hash[32] \parallel Comm_{app}[32])$$
   - Transitions singleton into `DRAW_READY(counter = 0)`.

2. **`ACTION_FULL_REFUND` (Selector = 2)**:
   - Enforces consensus relative lock delay $\Delta_{refund} = 432,000$ DAA score units (~12 hours at 10 BPS) via `OpCheckSequenceVerify`.
   - Guarantees 100% fund safety in the event that the designated target block becomes inaccessible (`TxScriptError::BlockIsTooDeep`).
   - Dynamically reconstructs the canonical initial `REFUNDING` covenant:
     - `cursor = 0`
     - `remaining_tickets = total_tickets`
     - `purchase_count = final_purchase_count`
     - `ticket_root = final_ticket_root`
   - Transitions singleton into `REFUNDING`, enabling buyers to claim full ticket principal and allowing round creators to recover the initial reserve.

---

## 2. Frozen Protocol V1 Parameters

The following parameters are immutably frozen for Kaswin V1 (`contracts/v1_constants.rs`):

| Parameter | Identifier | Value | Units | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Randomness Target Delta** | `DELTA_DAA_V1` | `100` | DAA score | Inclusion boundary requirement: Target block DAA must be $\ge D_0 + 100$. |
| **Full-Sale Recovery Delay** | `FULL_SALE_RECOVERY_DELAY_DAA_V1` | `432_000` | DAA score | Sequence lock grace period: ~12 hours at 10 BPS before `ACTION_FULL_REFUND` unlocks. |
| **SMT Tree Depth** | `TREE_DEPTH` | `27` | Levels | Type-A Range-Leaf Sparse Merkle Tree depth, capacity up to $134,217,728$ purchases. |
| **Max Ticket Capacity** | `MAX_TOTAL_TICKETS` | `100_000_000` | Tickets | Consensus limit for total tickets per round ($1 \le N \le 100,000,000$). |
| **Sequence Lock Mask** | `SEQUENCE_LOCK_TIME_MASK` | `0x00000000ffffffff` | 32-bit | Pinned Kaspa consensus mask for relative DAA sequence verification. |

---

## 3. Bytecode Structure & Script Layout

### 3.1 Prefix Schema (Immutable & Dynamic State)

The `SEALED` covenant redeem script begins with an AltStack-stashed prefix structure:

```text
[0..3]    OpTxInputIndex, Op0, OpEqualVerify
[3..36]   round_id (Hash, 32 bytes)
[36..45]  ticket_price (u64, 8 bytes)
[45..54]  total_tickets (u64, 8 bytes)
[54..87]  ticket_root (Hash, 32 bytes)
[87..96]  purchase_count (u64, 8 bytes)
[96..N]   reserve_payout_spk (Vec<u8>, 34..37 bytes)
```

During script execution, these 6 prefix items are parsed and stashed into `AltStack` in exact order:
1. `push_reserve_spk`
2. `push_pc`
3. `push_root`
4. `push_total`
5. `push_price`
6. `push_round_id`

### 3.2 Action Selector & Dispatch

The script pops the action selector from the execution stack:
```text
OpDup, Op1, OpEqual, OpIf -> ACTION_DRAW
OpElse, OpDup, Op2, OpEqual, OpIf -> ACTION_FULL_REFUND
OpElse -> FAIL (Unknown Action Selector)
```

---

## 4. State Machine Transition Details

### 4.1 Transition: `OPEN (Final BUY) -> SEALED`

When the final ticket purchase causes $sold\_after == total\_tickets$:
1. Slices Segment 1 from current OPEN input's scriptSig: `[redeem_start .. redeem_start + 54]` (containing `OpTxInputIndex` guard, `round_id`, `ticket_price`, `total_tickets`).
2. Appends `push_new_root` and `push_next_pc` formatted as push-data chunks.
3. Slices Segment 2: `reserve_payout_spk` at `[redeem_start + 63 .. redeem_start + 63 + 1 + len]`.
4. Appends the static canonical production `SEALED V1` body.
5. Hashes the assembled redeem script using `OpBlake2bWithKey(b"")` and wraps in P2SH template `0000aa20 <hash> 87`.
6. Enforces that Output 0 SPK matches the assembled `SEALED` P2SH SPK.

### 4.2 Transition: `SEALED -> DRAW_READY` (`ACTION_DRAW = 1`)

1. Validates witness depth: `OpDepth == 12` (verifying exact 12 PASS-A opening items).
2. Introspects input D0 DAA score: `Op0, OpTxInputDaaScore`.
3. Verifies DAA boundary: $TargetDAA \ge D_0 + 100$.
4. Reconstructs Merkle root $C_T$ of the 2-leaf PASS-A SeqCommit tree using `blake3::keyed_hash`.
5. Authenticates target block sequence commitment via `OpChainblockSeqCommit`.
6. Derives $Seed_{random}$ and dynamic application commitment.
7. Reconstructs and asserts Output 0 SPK matches `DRAW_READY(counter = 0)`.
8. Enforces Singleton Continuation Guard:
   - Output 0 amount == Input 0 amount.
   - Output 0 inherits Covenant ID $C$.
   - Transaction creates exactly 1 covenant-bound output (`OpAuthOutputCount == 1`).

### 4.3 Transition: `SEALED -> REFUNDING` (`ACTION_FULL_REFUND = 2`)

1. Verifies relative lock time: `432_000 OpCheckSequenceVerify`.
2. Assembles canonical initial `REFUNDING` prefix:
   - Pop `push_round_id`, `push_price`, `push_total`, `push_root`, `push_reserve_spk`, `push_pc`.
   - Format `cursor = 0` push-data.
   - Format `remaining = total_tickets` push-data.
   - Concatenate into complete 151-byte (or 152-byte) `REFUNDING` prefix.
3. Appends canonical `REFUNDING` body.
4. Computes P2SH hash and asserts Output 0 SPK matches `REFUNDING(cursor=0, rem=total_tickets)`.
5. Enforces Singleton Continuation Guard (`value`, `covenant_id`, `auth_count == 1`).

---

## 5. Security & Invariant Analysis

### 5.1 Permitted UTXO Race & Cancellation Semantics
Between DAA score $D_0 + 432,000$ and target block accessor expiration, both `ACTION_DRAW` and `ACTION_FULL_REFUND` are simultaneously valid in consensus:
- Both actions spend the exact same UTXO (Output 0 of the Final BUY transaction).
- Kaspa's double-spend prevention ensures only one transaction can be accepted into the DAG.
- If community participants or keepers broadcast the draw transaction, the draw takes precedence.
- If miners or keepers fail to draw within ~12 hours, any participant can trigger `ACTION_FULL_REFUND`.

### 5.2 Eventual Native Recovery Spend Path Analysis
If the target block depth exceeds the consensus accessor depth, `OpChainblockSeqCommit` halts execution with `TxScriptError::BlockIsTooDeep`.
Kaswin V1 provides an eventual native protocol-level recovery spend path after $G = 432,000$ DAA maturity (`ACTION_FULL_REFUND`):
- `ACTION_FULL_REFUND` does not invoke `OpChainblockSeqCommit` and operates purely on relative DAA delay (`OpCheckSequenceVerify`).
- Once PoV DAA reaches $D_0 + 432,000$, `ACTION_FULL_REFUND` becomes consensus-valid, transitioning the singleton into `REFUNDING`.
- **Operational Boundaries**:
  1. *Blue-Score / DAA Gap*: There may exist a temporary latency gap between target block blue-score accessor expiration and DAA sequence maturity ($D_0 + 432,000$).
  2. *Data Availability*: Execution of sequential `REFUNDING` steps relies on off-chain/on-chain availability of ticket purchase ranges and Merkle siblings.
  3. *Transaction Construction & Broadcast*: Transactions must be assembled and submitted by an active participant or wallet.
  4. *Fees*: Transaction gas fees must be covered by additional standard UTXO inputs.

---

## 6. Test Suite & Validation Matrix (Tests A – M)

All 13 test scenarios have been validated and passed 100% in the native `rusty-kaspa` TxScript engine:

| Test | ID | Description | Result | Execution Units | Min Budget ($B_{min}$) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A** | `FINAL_BUY_TO_SEALED` | Final ticket purchase transitions OPEN into production SEALED | **PASS** | 74,564 | 7 units (70,000 SU) |
| **B** | `ACTION_DRAW_VALID` | Valid 12-item PASS-A opening transitions SEALED to DRAW_READY | **PASS** | 22,486 | 2 units (20,000 SU) |
| **C** | `DRAW_MALFORMED_DEPTH` | 11-item witness or unknown action selector blocked | **PASS** | N/A (Blocked) | N/A |
| **D** | `REFUND_BEFORE_MATURITY` | Full refund rejected when PoV DAA < $D_0 + 432,000$ | **PASS** | N/A (Consensus reject)| N/A |
| **E** | `REFUND_FIRST_MATURITY` | Full refund accepted at exact DAA $D_0 + 432,000$ -> REFUNDING(0, 100) | **PASS** | 20,397 | 2 units (20,000 SU) |
| **F** | `SEQUENCE_DISABLED_BIT` | Bypass attempt with `SEQUENCE_LOCK_TIME_DISABLED` blocked | **PASS** | N/A (CSV reject) | N/A |
| **G** | `TAMPERED_REFUND_SPK` | Tampered REFUNDING successor SPK blocked by assertion | **PASS** | N/A (Blocked) | N/A |
| **H** | `AMOUNT_DEVIATION` | Output 0 amount deviation (+/- 1 sompi) blocked | **PASS** | N/A (Blocked) | N/A |
| **I** | `MISSING_COVENANT` | Output 0 omitting covenant ID $C$ blocked | **PASS** | N/A (Blocked) | N/A |
| **J** | `SPLIT_COVENANT_ATTACK` | Creating second covenant output blocked (`OpAuthOutputCount == 1`) | **PASS** | N/A (Blocked) | N/A |
| **K** | `INTENDED_RACE_PROOF` | Simultaneous validity of DRAW and FULL_REFUND on identical UTXO | **PASS** | Validated | Verified Race |
| **L** | `TOO_DEEP_LIVENESS` | Target block expired -> DRAW aborts with BlockIsTooDeep, REFUND succeeds | **PASS** | Verified | Zero Deadlock |
| **M** | `REFUND_E2E_PIPELINE` | Full pipeline: SEALED -> REFUNDING(0) -> REFUNDING(1) -> Reserve Return | **PASS** | Verified | 100% Extinguished |

---

## 7. Compute Mass & Budget Proofs

Using Kaspa's `TxScriptEngine::from_transaction_input_with_script_units_limit`:
- **Final BUY**: Used script units: 74,564 SU; minimum covering budget $B_{min} = 7$. Passes with bounded $B_{min}$; strictly rejected with `ExceededCommittedScriptUnits` at $B_{min} - 1 = 6$.
- **SEALED DRAW**: Used script units: 22,486 SU; minimum covering budget $B_{min} = 2$. Passes with bounded $B_{min}$; strictly rejected at $B_{min} - 1 = 1$.
- **SEALED FULL_REFUND**: Used script units: 20,397 SU; minimum covering budget $B_{min} = 2$. Passes with bounded $B_{min}$; strictly rejected at $B_{min} - 1 = 1$.

*(Note: In Kaspa consensus mass calculations, each input provides a standard allowance before compute budget units apply; $B_{min}$ denotes the minimum explicit compute budget commitment covering the used script units).*
