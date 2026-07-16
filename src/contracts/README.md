# Covenant contracts

- `raffle_round_v16.sil`: current `raffle-v16-dynamic-refund-transition` chain-random raffle covenant.
- `raffle_refund_v16.sil`: current v16 resumable grouped-refund covenant.
- `raffle_round_v13.sil` and `raffle_refund_v3.sil`: bytecode-identical deployed v16 artifacts retained for verification.
- `raffle_round_v12.sil`, `raffle_round_v11.sil`, and `raffle_refund_v2.sil`: archived historical sources.

The current protocol and compiled implementation are both v16: `raffle-v16-dynamic-refund-transition`, `RaffleRoundV16`, and `RaffleRefundV16`. v15 and v14 rounds are operated with the archived `v0.9.6` release. v16 measures and commits the refund-transition fee instead of fixing it at 2,400,000 sompi.

The round covenant stores a depth-20 Merkle root/frontier for up to one million purchase batches. Each leaf commits the owner, first zero-based ticket id, and any positive whole-number count that fits the round remainder. `finalize` fixes randomness to the first selected-chain block crossing the final-ticket UTXO DAA plus 30 when sold out, or the fixed sales-timeout DAA plus 30 otherwise. It verifies both block hashes and `OpChainblockSeqCommit`, then validates that the winner belongs to the proven purchase range before paying the prize.

There is no close transition, oracle state, drand proof, or external randomness service. Timed-out rounds transition to the resumable refund covenant; any user can continue from the on-chain ticket and batch cursors. One v15 refund transaction repays up to 13 consecutive original purchase batches. VM measurements are 454,618 script units for 13 and 498,904 for 14, so 13 is the largest count that leaves room below Kaspa's 500,000 compute-mass ceiling.
