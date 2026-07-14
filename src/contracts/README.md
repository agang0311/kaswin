# Covenant contracts

- `raffle_round_v11.sil`: shared Mainnet/TN12 chain-random raffle covenant.
- `raffle_refund_v2.sil`: shared resumable purchase-batch refund covenant.

The current logical contract version is `raffle-v14-batch-range`; older state layouts are intentionally unsupported.

The round covenant stores a depth-20 Merkle root/frontier for up to one million purchase batches. Each leaf commits the owner, first zero-based ticket id, and one of the supported decimal counts: 1, 10, 100, 1,000, 10,000, or 100,000. `finalize` fixes randomness to the first selected-chain block crossing the final-ticket UTXO DAA plus 30 when sold out, or the fixed sales-timeout DAA plus 30 otherwise. It verifies both block hashes and `OpChainblockSeqCommit`, then validates that the winner belongs to the proven purchase range before paying the prize.

There is no close transition, oracle state, drand proof, or external randomness service. Timed-out rounds transition to the resumable refund covenant; any user can continue from the on-chain ticket and batch cursors. One refund transaction repays one original purchase batch, so a 100,000-ticket purchase still creates one output.
