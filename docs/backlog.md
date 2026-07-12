# Current Project Status and Backlog

This file reflects the current V5 million-user implementation.

## Implemented

- Self-contained static React/TypeScript SPA and single-file release build.
- Mainnet/Testnet 10 network profiles with strict node and wallet validation.
- KasWare and Kastle wallet adapter registry.
- Compiled `RaffleRoundV5` and `RaffleRefundV1` artifacts with legacy v1-v4 compatibility.
- Depth-20 append-only ticket tree for 1,000,000 independent one-ticket users.
- Participant-only direct finalize with winner and caller Merkle proofs.
- Walletless timeout transition plus storage-safe 8-ticket range-proof refunds; at 1,000,000 tickets the cursor completes in 125,000 batch transactions.
- External root-bound oracle client flow; Mainnet creation requires a public key and HTTPS attestation endpoint.
- Confirmed-chain cursor and proof indexer with fixed-size ticket records, disk Merkle levels, crash checkpoints, and deep-reorg rebuild.
- Full one-million-record index benchmark with cold rebuild, warm restart, proof latency, disk, and RSS measurements.
- Three-round V5 real-network regression: direct finalize, History-loaded finalize, and 8-ticket `startRefund` + `refundBatch8`.

## Superseded Original Tasks

- Separate Round, Ticket, Finalize, and Refund covenant templates were replaced by one stateful `RaffleRound` covenant with entrypoints.
- Creator reveal and manual Close were replaced by oracle-backed direct finalize after sellout or timeout.
- Browser-local imported private keys were replaced by wallet adapters. Private-key test wallets exist only in the local development server.
- Mock scanner events were replaced by REST-backed on-chain history reconstruction.

## Open Hardening Work

- Deploy and independently audit a verifiable or threshold randomness service that implements the external attestation API.
- Evaluate a future consensus-safe batch larger than 8 only if exact storage mass remains below 500,000; the rejected 32-ticket prototype measured 1,073,774.
- Improve stale-round contention guidance and optionally offer an explicit reload-and-retry action.
- Arrange independent covenant and transaction-builder security review.
- Convert the funded TN12 browser loop into a CI-capable test harness when disposable test funds and a stable node are available.

See GitHub Issues for ownership and discussion. Completed historical milestones are kept in git history and release notes rather than as permanently open checklists.
