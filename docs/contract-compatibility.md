# Contract compatibility

Each Kaswin release bundles one current raffle protocol and its matching compiled implementations. The protocol version is recorded in each round's metadata and is the identifier users should use when selecting a historical release.

| Round protocol | Compiled round | Compiled refund | Browser release |
| --- | --- | --- | --- |
| `raffle-v16-dynamic-refund-transition` | `RaffleRoundV16` | `RaffleRefundV16` | `v0.9.7` and later |
| `raffle-v15-arbitrary-batched-refund` | `RaffleRoundV12` | `RaffleRefundV3` | `v0.9.6` |
| `raffle-v14-batch-range` | `RaffleRoundV11` | `RaffleRefundV2` | `v0.9.6` |

`RaffleRoundV16` and `RaffleRefundV16` have bytecode identical to the originally deployed v16 artifacts named `RaffleRoundV13` and `RaffleRefundV3`. The names were aligned without changing the covenant script or P2SH address derivation.

Current browser releases list old rounds but do not construct transactions for archived protocols. Download the listed historical single-file HTML release to buy, draw, or refund an archived round.
