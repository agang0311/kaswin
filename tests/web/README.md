# Rolling TN10 browser tests

Real Chromium scenarios for Kaswin Rolling. Preparation, signing and submission use the published page UI. An independent read-only RPC verifies selected-chain transaction acceptance, spent inputs, actual fees and mass. Each completed receipt is rechecked at least 100 DAA deep; this is a client policy, not irreversible finality.

[中文说明](README.zh-CN.md) · [Evidence](../../docs/rolling/TN10-EVIDENCE.md) · [Coverage matrix](../../docs/rolling/REMAINING-COVERAGE-20261115.md)

These are real Testnet 10 experiments. Run only within an explicit current authorization, using the existing allowlisted dedicated wallets. No mainnet, new keys or automatic TIMEOUT is included. The candidate Profile remains **UNVALIDATED**.

## Scenarios

| ID | Scenario | Expected terminal |
|---|---|---|
| 1 | Empty round: cap5/min3, no purchases | EMPTY |
| 2 | Two purchases below min3 | REFUNDED |
| 3 | Three purchases, normal close/draw | PAID |
| 4 | Cap3/min3, close before the five-minute deadline after selling out | PAID |
| 5 | 256 purchase records, one frozen shard, empty local tail | PAID; PAY_OLD merges the empty tail |
| 6 | 256 purchase records below min300 | REFUNDED; eighth REFUND_OLD merges the empty tail |

Freezing counts **purchase records**, so one purchase of several tickets does not replace several records. TIMEOUT is reserved for manual testing. Multi-wallet contention is implemented separately in `contention.mjs`.

```bash
node tests/web/scenarios.mjs --scenarios=1,2,3,4,5,6 --role=b2 --budget=14400
node tests/web/scenarios.mjs --scenarios=3 --buys=1 --quantity=3 --role=b2
node tests/web/scenarios.mjs --resume-run=/absolute/path/to/original/run --scenarios=5,6 --role=b2
```

The default node is the local TN10 proxy. `--node=` can select another authorized TN10 node. `--budget` is checked between scenarios, not a hard deadline for every in-flight operation. Resume preserves the original profile/CID and checks scope and quantity. Never replace an unknown signed transaction with a new one.

## Conflict runners

```bash
node tests/web/round-double-spend.mjs --phases=r1,r2
node tests/web/double-spend.mjs --phases=1,2,3 --attempts=2
node tests/web/contention.mjs --cases=three-buy,close,buy-close,cross-node --attempts=4
```

- `round-double-spend`: different buyers compete for the same manager UTXO; verify ROUND_INPUT, discard/import/rebuy, and a stale quote rejected before any submit frame. Real click counts are independent of quote wait windows. Read settings/logs before opening a quote or after it closes.
- `double-spend`: two profiles deliberately use the same creator wallet. Both ticket prices are1TKAS, with capacities5/6. Verify FUNDS_INPUT, recovery, pending-input exclusion and stale quotes. For an exclusion observation, A must still be in the mempool after B's quote is formed; later accepted inputs must be disjoint. Every created round ends EMPTY.
- `contention`: three buyers, CLOSE/CLOSE, BUY/CLOSE and two independent nodes. Real page signing is staged. The first signed RPC frame may be held at most18seconds; the slower remote preparation can take up to180seconds before the first frame. Original frames and node replies are unchanged. Actual submit sockets are probed for p2p identity. A cross-node pass requires both nodes to admit distinct conflicting txids, one local selected-chain winner, complete loser cleanup and final settlement.

Public-node bounded acceptance scans can remain incomplete. Cleanup preserves the signed intent, independently checks the original node's identity/mempool, and may switch the UI to the local TN10 node for its normal negative-search/grace policy. The chosen local-chain observation and the original node's mempool observation are recorded separately.

The runners now return a nonzero exit code for failed criteria, incomplete evidence or cleanup. A failed stage blocks dependent new rounds. `createRobust()` defaults to one creation attempt; unknown creation outcomes retain the original profile. Campaign-specific supervisors are not general-purpose retry tools.

The test-only `submission-barrier.mjs` now starts one deadline of 18 seconds, measured with a monotonic clock, at the first held frame. Socket identity probes, delayed releases and every individual release share that deadline; expiration drops remaining held frames, including when a timer callback runs late. Its 8 targeted offline tests pass and the contention script passes syntax checking. A TN10 rerun of this later scheduling hardening is **NOT_RUN**; the real campaign below is retained under its original source/evidence. Rejected RPC replies normally lack `transactionId`; the tap correlates request ids, and archived error subjects identify the rejected transaction.

## Persistence and wallet ownership

Each run keeps `run.log`, `run.json` or `result.json`, persistent browser profiles, public round exports and `acceptance.json`. Acceptance rows contain txid, accepting block/DAA, depth, spent inputs, actual fee and mass. Transient mass is locally computed. Original unknown signed intents and failed recovery attempts are retained.

`lock.mjs` is shared with the CLI runner. Creator, buyer1 and buyer2 must not be used by overlapping signing jobs. Contention waits for the long CLI/browser jobs to release their wallets. Capacity checks query actual covenant UTXOs for known experiment CIDs and reserve pending genesis slots; they are not a network-wide allocator.

Keys are read only by the allowlisted harness/signers and passed in memory to the local page input. The page clears the key field and does not persist it. Wallet-mode switches disconnect first, then select the appropriate tab; private-key input failures use a sanitized error. Exports contain public signed witnesses, not wallet secrets. Do not print entire exports in logs.

Recovery utilities operate on existing runs only:

- `recover-contention.mjs`: discard an existing losing intent after independent negative evidence, with no signing/submission permitted.
- `recover-contention-round.mjs --execute`: authenticate and re-execute the limited real VM over an existing signed intent, recover those original bytes on the local TN10 node, then settle that same CID.
- `settle.mjs`: inspect/settle supported archived runs. Never use it as an automatic substitute for reviewing an unknown result.

## Recorded results, 2026-11-15

Current page SHA256: `ea23092b09e9d037eb7a596fe73f0d0ed9ce799a031671be5f2d48a53ab3d2f8`.

| Coverage | Recorded outcome |
|---|---|
| Current page scenarios1–6 | 547tx/520tickets, all independently>=100DAA;1216600100sompi |
| One BUY containing3tickets | 5tx/PAID;8540200sompi |
| Manager conflict/rebuy/stale quote | 6tx/REFUNDED;10258300sompi; first import click responded; stale submit frames0 |
| Same-wallet conflict/prevention/stale quote | 7EMPTY rounds/14tx;14062800sompi; two observed exclusions; stale submit frames0 |
| Three buyers / CLOSE / BUY-vs-CLOSE | Real one-winner conflicts, REFUNDED/EMPTY/EMPTY. CLOSE evidence completed by independent reconciliation after a cursor rollback |
| Two-node admission | Both local and vector nodes admitted different txids; one selected-chain winner;4tx/REFUNDED;7216600sompi; loser cleared/imported |
| Browser interaction/storage/settings checks | 11/11, no real keys or chain submission |

The CLI separately completed a17-frozen-shard payout (4359tx, PAY_OLD16+1 then PAY_SELF) and a3-frozen-shard refund (796tx). All5155 transactions were independently replayed through the node adapter/indexer/archive. See the evidence and coverage matrix for exact paths, failed attempts, configuration deviations and boundaries. Historical table totals are dated and must not be blindly added to these records.

No TIMEOUT, extension-wallet integration, mainnet or production approval is claimed. Finite successful runs do not promote the Profile from UNVALIDATED.
