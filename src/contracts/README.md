# Current Contracts

This directory intentionally contains only the current protocol:

- `raffle_round_v5.sil`: V6 round template (`raffle-v6-aligned-batch-buy`)
- `raffle_refund_v1.sil`: compact timeout-refund template
- `compiled/raffle-round-v5.*`: compiler output and browser runtime artifact
- `compiled/raffle-refund-v1.*`: compiler output and browser runtime artifact

The round source name keeps `v5` because `RaffleRoundV5` is the compiled contract identifier. The application protocol version is V6: its `buy(pubkey, int)` entrypoint atomically appends aligned batches of 1, 2, 4, or 8 identical owner leaves.

Legacy sources and runtime artifacts are deliberately absent. The browser rejects metadata whose `contractVersion` is not `raffle-v6-aligned-batch-buy`.

Run:

```powershell
npm run compile:contract
npm run verify:covenant
```
