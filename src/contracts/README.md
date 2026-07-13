# Covenant contracts

- `raffle_round_v8_mainnet.sil`: Mainnet fixed-image drand/RISC Zero raffle.
- `raffle_round_v8_tn12.sil`: TN12 variant with the TN12 DAA-to-drand offset and shorter test delay.
- `raffle_refund_v1.sil`: resumable public refund covenant, eight tickets per batch plus a single-ticket tail.
- `zk_beacon_probe.sil`: isolated Toccata `OpZkPrecompile` integration probe.

The V8 round stores a depth-20 Merkle root/frontier for up to one million tickets. A public `close` transition writes `refund_cursor = -1`, disabling further purchases before the future drand round is selected. Finalize requires that closed state, a fixed RISC Zero guest receipt, winner proof, and participant caller proof.

Compiled runtime artifacts are under `compiled/`. The browser rejects all non-V8 contract versions.
