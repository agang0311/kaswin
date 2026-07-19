# Offline indexer million-batch benchmark

This is recorded local performance evidence, not a network result.

Command:

```powershell
npm run benchmark:indexer:1m
```

Recorded local result (2026-07-19):

| Metric | Result |
| --- | ---: |
| Generated 1,000,000 one-ticket purchase-batch records | 9.30 s |
| Cold disk-index rebuild | 507.02 s |
| Warm checkpoint restart | 0.27 s |
| Proof latency, first / middle / last | 11.71 / 2.70 / 3.25 ms |
| Owner lookup | 21.49 ms |
| Warm indexer RSS | 83,603,456 bytes |

The benchmark uses `RAFFLE_INDEX_OFFLINE=1`, a generated local disk fixture and loopback HTTP only; it does not connect to a Kaspa node, wallet, public Indexer, Testnet or Mainnet. The fixture currently uses the retained v15 batch encoding in `scripts/verify-indexer-million.mjs`, so it demonstrates range-index storage/recovery throughput rather than proving a live vNext network workflow. vNext nonce-domain proof and reorg behavior are covered separately by `scripts/verify-indexer-vnext.mjs`.

Re-run the command on the target release environment before making a performance claim; hardware, Node version and disk state materially affect these values.
