# Covenant contracts

- `raffle_round_v10.sil`: shared Mainnet/TN12 chain-random raffle covenant.
- `raffle_refund_v1.sil`: Shared resumable refund covenant.

The current logical contract version is V12. Source filenames retain `v9` only to avoid unnecessary build-path churn.

The round covenant stores a depth-20 Merkle root/frontier for up to one million tickets. `finalize` fixes randomness to the first selected-chain block crossing the final-ticket UTXO DAA plus 30 when sold out, or the fixed sales-timeout DAA plus 30 otherwise. It verifies both block hashes and `OpChainblockSeqCommit`, then validates the winner Merkle proof before paying the prize. Anyone can broadcast this signature-free transition. The client derives the minimum finalize fee from the complete transaction mass; the covenant accepts that fee only up to a 0.2 KAS anti-griefing cap.

There is no close transition, oracle state, drand proof, or external randomness service. Timed-out rounds transition to the resumable refund covenant; any user can continue refunding from the on-chain cursor.
