# Contract compatibility

Protocol version in metadata controls decoding and operation. A current state layout must never be guessed for another protocol.

| Protocol | Contracts | Status in this worktree | Operation guidance |
| --- | --- | --- | --- |
| `raffle-vnext-liveness-guard-b1000` | `RaffleRoundVNext` / `RaffleRefundVNext` | Current 0.9.13.2 local-integrated candidate; same covenant artifact hashes as 0.9.13 are committed | Only version the current worktree may create or spend; no public release until the external gates pass |
| `raffle-vnext-liveness-guard` | `RaffleRoundVNext` / `RaffleRefundVNext` | Quarantined 0.9.12 exact-hash Testnet candidate with a 100-batch covenant limit | Read-only in this worktree; never spend it with the b1000 Round artifact |
| `raffle-vnext-carrier-topup` | `RaffleRoundVNext` / `RaffleRefundVNext` | Quarantined unpublished candidate; its Round bytecode commits a stale Refund template hash | Do not create or spend it with the current worktree. Below-minimum rounds cannot start refund with that immutable bytecode; no repository release exists and recoverability must not be claimed |
| `raffle-vnext-buyer-funded-refund` | `RaffleRoundVNext` / `RaffleRefundVNext` | Quarantined unpublished candidate bytecode retained for identification | Read-only in the current worktree; no repository release exists; never map it to the current Refund artifact or ABI |
| `raffle-vnext-deterministic-settlement` | `RaffleRoundVNext` / `RaffleRefundVNext` | Superseded local candidate | Do not decode or spend it with the buyer-funded artifact |
| `raffle-v16-dynamic-refund-transition` | `RaffleRoundV16` / `RaffleRefundV16` | Deployed legacy protocol | Use the matching historical `v0.9.7`+ standalone release; it is not the new-round protocol here |
| `raffle-v15-arbitrary-batched-refund` | `RaffleRoundV12` / `RaffleRefundV3` | Archived | Use historical `v0.9.6` |
| `raffle-v14-batch-range` | `RaffleRoundV11` / `RaffleRefundV2` | Archived | Use historical `v0.9.6` |

`RaffleRoundV16`/`RaffleRefundV16` preserve the bytecode that was originally deployed under the names `RaffleRoundV13`/`RaffleRefundV3`; the historical rename does not change their P2SH derivation. That fact is not a vNext artifact or deployment claim.

Unknown metadata schemas and protocols are read-only. They must show an explicit unsupported/compatibility message and must not construct, sign or broadcast a transaction.
