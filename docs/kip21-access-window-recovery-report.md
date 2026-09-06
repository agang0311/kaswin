# Kaswin KIP-21 Access-Window Recovery & Full-Sale Liveness Protocol Decision Report

## 1. Executive Summary

This report establishes the protocol-level design decision, consensus proof validation, fairness analysis, and isolated VM verification for **KIP-21 Access-Window Recovery and Full-Sale Liveness** under pinned Kaspa Testnet-10 Toccata consensus rules (`rusty-kaspa v2.0.1`, commit `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`).

When a Kaswin round sells out completely (`OPEN -> SEALED`), it targets a future Kaspa PoW block at DAA offset $\Delta$ (`delta_daa`) to extract unbiasable on-chain entropy via KIP-21 sequencing commitments (`OpChainblockSeqCommit`).

However, if nobody triggers the draw transaction (`DRAW_READY`) before the target block falls outside the consensus KIP-21 accessor depth window ($F$), the target becomes permanently unreadable on-chain. Without a liveness/recovery mechanism, the pool's entire balance would be locked forever.

This report demonstrates:
1. **The Access-Window Fact**: `OpChainblockSeqCommit` terminates script execution fatally with `TxScriptError::BlockIsTooDeep` if the target is outside the access window; it cannot return `false` or be trapped by `IF/ELSE`.
2. **Domain Incommensurability**: KIP-21 access window is strictly governed by `blue_score`, whereas Kaspa relative transaction time-locks (`SEQUENCE_LOCK_TIME_MASK`, `OpCheckSequenceVerify`) operate strictly in the `daa_score` domain.
3. **Opcode Exclusivity**: There are no native Kaspa opcodes to introspect selected-parent `blue_score`, catch opcode exceptions, or prove depth expiration.
4. **Isolated Verification**: Verified 6 isolated proof cases (Tests A through F) confirming accessor depth boundaries, `BlockIsTooDeep` fatality, CSV relative DAA enforcement, and disabled-bit bypass defense.
5. **Architectural Protocol Decision**: Selected **OPTION A: Native Timeout Refund Fallback** for V1, formalizing its permissionless claim window, relative DAA grace period, and known-winner cancellation race trade-offs.

---

## 2. Pinned Upstream Sources & Access-Window Proof

All logic is pinned against `kaspanet/rusty-kaspa` (commit `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`) and `kaspanet/kips` (commit `e4ae2332117b5cb68bd6188e065ef885b6d17939`).

### 2.1 Pinned KIP-21 Access Threshold
Under `references/kips/kip-0021/seqcommit-accessor.md` (lines 51–56):
> Let `P` be the selected-parent point of view and let `X` be the requested chain block. The accessor admits `X` only when:
> ```
> X.blue_score + F > P.blue_score
> ```
> where `F` is the deployed finality depth (threshold).

In `rusty-kaspa/consensus/src/model/services/seq_commit_accessor.rs` (lines 39–50):
```rust
fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
    let header = self.headers_store.get_header(block_hash).optional().unwrap()?;
    if !self.toccata_activation.is_active(header.daa_score) {
        return None;
    }
    let sp_blue_score = self.headers_store.get_blue_score(self.selected_parent).unwrap();
    if seq_commit_within_threshold(sp_blue_score, header.blue_score, self.threshold) {
        Some(header.accepted_id_merkle_root)
    } else {
        None
    }
}
```

### 2.2 `OpChainblockSeqCommit` Fatal Exception Semantics
Under `rusty-kaspa/crypto/txscript/src/opcodes/mod.rs` (lines 1581–1596):
```rust
opcode OpChainblockSeqCommit<0xd4, 1>(self, vm) {
    let Some(seq_commit_accessor) = vm.ctx.seq_commit_accessor else {
        return Err(TxScriptError::InvalidOpcode(format!("{self:?}")))
    };
    let [block]: [Hash; 1] = vm.dstack.pop_items()?;
    match seq_commit_accessor.is_chain_ancestor_from_pov(block) {
        None => return Err(TxScriptError::BlockAlreadyPruned(block.to_string())),
        Some(false) => return Err(TxScriptError::BlockNotSelected(block.to_string())),
        Some(true) => {}
    };
    let commitment = seq_commit_accessor.seq_commitment_within_depth(block)
        .ok_or_else(|| TxScriptError::BlockIsTooDeep(block.to_string()))?; // FATAL ERROR!
    vm.dstack.push_item(commitment)?;
    Ok(())
}
```
**Consequence**: `OpChainblockSeqCommit` does **not** push a boolean `0` or `false` to the stack when a block is too deep. It returns `Err(TxScriptError::BlockIsTooDeep)`. Because TxScript has no `TRY/CATCH` constructs, this error immediately terminates the VM and aborts transaction execution. It is fundamentally impossible to write:
```text
TRY OpChainblockSeqCommit IF success DRAW ELSE RECOVER
```
This is a hard consensus limitation of the Kaspa VM.

---

## 3. Domain Distinction: Blue Score vs. DAA Score

A critical protocol distinction exists between the access window and transaction time-locks:
1. **KIP-21 Access Window Expiry**: Evaluated strictly in the **`blue_score` domain** ($X.blue\_score + F > P.blue\_score$). In Kaspa GHOSTDAG, `blue_score` counts the number of blue blocks in the past of a block; it increases only along the selected parent chain and blue merge sets.
2. **Transaction Relative Sequence Lock**: Evaluated strictly in the **`daa_score` domain** via `check_sequence_lock` in `tx_validation_in_utxo_context.rs`:
   $$\text{lock\_daa\_score} = \text{entry.block\_daa\_score} + (\text{sequence} \ \& \ \text{SEQUENCE\_LOCK\_TIME\_MASK}) - 1$$
   $$\text{lock\_daa\_score} < \text{pov\_daa\_score}$$
   DAA score represents the total difficulty-adjusted block index and advances at a nominal 10 BPS on Testnet-10.

Because network delays, DAG branchiness, and difficulty adjustments cause local divergence between `blue_score` and `daa_score`, **it is mathematically invalid to assert that $N$ DAA score steps strictly prove that a target block's blue score distance has exceeded $F$**.

Any relative timeout parameter $G$ measured in DAA score is an **application-level grace period policy**, not a mathematical proof of KIP-21 window closure.

---

## 4. Exhaustive Native Opcode Surface Audit

We audited the entire pinned `txscript` opcode set in `rusty-kaspa/crypto/txscript/src/opcodes/mod.rs`:
- **Current Block / Ancestor Blue Score**: No opcode exists (`OpTxInputDaaScore` provides input UTXO DAA score, but no opcode provides current block DAA score or any blue score).
- **Depth Query / Exception Catching**: No opcode exists to query accessor depth as a boolean.
- **Proof-of-Depth / Pruning Ancestry**: No opcode exists to parse Merkle ancestry across GHOSTDAG blue blocks natively.

**Conclusion**: **PURE NATIVE EXACT-EXPIRY DETECTION IS IMPOSSIBLE** under the pinned Kaspa L1 opcode set.

---

## 5. Relative Sequence Lock Consensus Verification

Under `tx_validation_in_utxo_context.rs` and `opcodes/mod.rs` (`OpCheckSequenceVerify` `0xb1`):
1. An input sequence with `SEQUENCE_LOCK_TIME_DISABLED` (`1 << 63`, `0x8000000000000000`) is treated as relative-lock disabled.
2. In `OpCheckSequenceVerify`:
   ```rust
   if input.sequence & SEQUENCE_LOCK_TIME_DISABLED != 0 {
       return Err(TxScriptError::UnsatisfiedLockTime("sequence locktime disabled bit set"));
   }
   if (stack_sequence & SEQUENCE_LOCK_TIME_MASK) > (input.sequence & SEQUENCE_LOCK_TIME_MASK) {
       return Err(TxScriptError::UnsatisfiedLockTime("locktime is greater than transaction locktime"));
   }
   ```
3. Therefore, an `OpCheckSequenceVerify` branch with parameter $G$ ensures:
   - The spending transaction must set `input.sequence` without the disable bit and with mask $\ge G$.
   - The UTXO context `check_sequence_lock` will reject the transaction until the containing block DAA satisfies:
     $$\text{pov\_daa\_score} \ge \text{entry.block\_daa\_score} + G$$

---

## 6. Native V1 Fallback Architecture

To ensure liveness without oracles, `SEALED` can implement a two-action selector:

```text
SEALED(C)
    |
    +-- ACTION_DRAW (action = 1)
    |      Existing KIP-21 PASS-A SeqCommit opening & DAA boundary verification
    |      -> Transitions to DRAW_READY(0, C)
    |
    +-- ACTION_FULL_REFUND (action = 2)
           Enforces relative sequence lock G via OpCheckSequenceVerify
           Preserves frozen ticket_root and parameters
           -> Transitions to REFUNDING(C, cursor=0, remaining_tickets=total_tickets)
```

### Parameter Propagation Impact
When `ACTION_FULL_REFUND` is executed, the entire pool is refunded to buyers using the **already frozen `REFUNDING` covenant**.
To construct the successor `REFUNDING` redeem script dynamically or verify its SPK, `SEALED` must retain:
- `round_id` (32B)
- `ticket_price` (8B)
- `total_tickets` (8B)
- `ticket_root` (32B)
- `purchase_count` (8B)
- `reserve_payout_spk` (36/37B)
- `delta_daa` (8B)
- `recovery_delay_g` (8B)

**Recursive Impact**:
Adding these fields and the fallback action to `SEALED`:
1. Alters `SEALED` redeem script bytecode.
2. Changes the final-buy transition assertion in `OPEN` (which asserts `Output 0 SPK == P2SH(SEALED)`).
3. Changes the sliced body length of `OPEN`.
4. Changes the initial `OPEN` redeem script bytecode.
5. Changes `Genesis Output 0 SPK`.
6. Changes the canonical KIP-20 `covenant_id` $C$.

This proves why **`V1 CANONICAL CREATE BYTE ARTIFACT` CANNOT BE FROZEN** until this design choice is finalized.

---

## 7. Fairness & Cancellation Risk Analysis

### The Dual-Validity Overlap
If relative delay $G$ elapses while the target block is still within the KIP-21 access window ($F$):
1. A legitimate draw transaction (`ACTION_DRAW`) is valid and spendable.
2. A full refund transaction (`ACTION_FULL_REFUND`) is also valid and spendable.
3. Both transactions spend the exact same `SEALED` UTXO.

### Cancellation Option / Known-Winner Race
Because the target block header is public knowledge before the draw transaction is mined:
- Any participant can compute off-chain whether they won or lost.
- If a participant knows they lost, and the draw has not been triggered before $G$, they have an incentive to broadcast `ACTION_FULL_REFUND` to recover their ticket funds.
- Conversely, the winner has an incentive to broadcast `ACTION_DRAW` to claim the prize.
- This creates an on-chain fee/mempool race.

**Crucial Protocol Finding**:
This race **does not bias the Kaspa PoW random seed derivation**. However, it introduces an **ex-post cancellation option** if the draw grace period expires before anyone triggers the draw.
In a decentralized protocol without keepers, this trade-off is accepted by defining $G$ as a sufficiently long **Permissionless Draw Grace Period** (e.g., 2 to 6 hours on Testnet-10). If nobody claims or triggers the draw during this entire window, the round is deemed abandoned and cancels back to buyers.

---

## 8. Historical / ZK Proving Alternative Analysis

We evaluated whether a historical zero-knowledge proof or Merkle ancestry bridge could prove target block expiration or bridge old SeqCommitments:
- **KIP-21 Proving Spec Status**: The companion document `references/kips/kip-0021/proving-spec.md` is currently marked **"Status: Reserved companion document"** and provides no normative witness formats or verification specs for L1 covenants.
- **ZK Verifier Requirements**: Validating GHOSTDAG selected-parent continuity or STARK/SNARK proofs requires an on-chain verifier (`OpZkPrecompile` / KIP-16), which is not activated on Kaspa L1 mainnet/TN10.
- **Hash-Chain Shortcut Fallacy**: Incrementally hashing `H_seq` across thousands of blocks cannot authenticate historical selected-parent continuity without full header verification inside script, which would far exceed Kaspa transaction mass and script limits.

**Status Verdict**: **NOT CURRENTLY SPECIFIED / IMPRACTICAL FOR V1**.

---

## 9. Recovery Delay Policy ($G$)

$G$ is measured in DAA score units (1 sompi/second at 10 BPS).
Constraints:
1. $G > \text{delta\_daa}$ (recovery cannot unlock before the target block is mined).
2. $G \le \text{SEQUENCE\_LOCK\_TIME\_MASK} = 0x000000000000FFFF$ (65,535 DAA score units $\approx$ 109 minutes at 10 BPS).

*Distinction*:
- **Consensus Safety Bound**: None exists natively to prove KIP-21 window expiry in DAA units.
- **Application Policy Grace Period**: $G$ is strictly an application grace period during which draw execution has exclusive liveness.

---

## 10. Isolated Test Results (6/6 PASS)

The test suite in `tests/rust-vm-validation/src/bin/kip21_access_window_isolated_test.rs` validates all 6 isolated proof cases:

| Test | Description | Result | Details |
| :--- | :--- | :---: | :--- |
| **Test A** | Target within accessor threshold | **PASS** | `OpChainblockSeqCommit` succeeds and returns Merkle root |
| **Test B** | Target exceeds accessor depth | **PASS** | Halts with `TxScriptError::BlockIsTooDeep`, proves non-boolean |
| **Test C** | Relative recovery before maturity ($DAA < D_0 + G$) | **PASS** | Rejected with `SequenceLockConditionsAreNotMet` |
| **Test D** | Relative recovery at maturity ($DAA = D_0 + G$) | **PASS** | UTXO sequence lock & `OpCheckSequenceVerify` both pass |
| **Test E** | Sequence disabled-bit bypass attempt | **PASS** | Blocked with `TxScriptError::UnsatisfiedLockTime` |
| **Test F** | Attempting to catch `BlockIsTooDeep` with `IF/ELSE` | **PASS** | Fatal error cannot be branched; script aborts immediately |

---

## 11. Architectural Decision: OPTION A

We select **OPTION A: NATIVE TIMEOUT REFUND ACCEPTED FOR V1**.

### Specification of Option A
1. `SEALED` includes a permissionless draw grace period enforced via relative DAA delay $G$ using `OpCheckSequenceVerify`.
2. During the grace period ($DAA < D_0 + G$), only `ACTION_DRAW` is valid.
3. After the grace period ($DAA \ge D_0 + G$), `ACTION_FULL_REFUND` unlocks, transitioning to `REFUNDING(cursor=0, rem=N)`.
4. If a round is abandoned, participants recover 100% of their ticket funds and the creator recovers their reserve through the frozen `REFUNDING` pipeline.
5. If the target is still accessible after $G$, any race between draw and refund is accepted as a standard permissionless cancellation semantic.
