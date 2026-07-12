# Current Project Status and Backlog

This file reflects the current v4 million-user implementation.

## Implemented

- Self-contained static React/TypeScript SPA and single-file release build.
- Mainnet/Testnet 10 network profiles with strict node and wallet validation.
- KasWare and Kastle wallet adapter registry.
- Compiled `RaffleRoundV4` artifact with legacy v1-v3.5 compatibility.
- Depth-20 append-only ticket tree for 1,000,000 independent one-ticket users.
- Participant-only direct finalize with winner and caller Merkle proofs.
- Walletless sequential refunds after the DAA timeout.
- Confirmed-chain cursor and proof indexer with fixed-size ticket records, disk Merkle levels, crash checkpoints, and deep-reorg rebuild.
- Full one-million-record index benchmark with cold rebuild, warm restart, proof latency, disk, and RSS measurements.
- Three-round v4 real-network regression: 10-ticket History-loaded finalize, 3-ticket finalize, and 2-ticket History-loaded refund.

## Superseded Original Tasks

- Separate Round, Ticket, Finalize, and Refund covenant templates were replaced by one stateful `RaffleRound` covenant with entrypoints.
- Creator reveal and manual Close were replaced by oracle-backed direct finalize after sellout or timeout.
- Browser-local imported private keys were replaced by wallet adapters. Private-key test wallets exist only in the local development server.
- Mock scanner events were replaced by REST-backed on-chain history reconstruction.

## Open Hardening Work

- Replace the recoverable development oracle with an independent verifiable or threshold randomness service.
- Investigate storage-safe multiproof refund batches to reduce one transaction per refunded ticket.
- Improve stale-round contention guidance and optionally offer an explicit reload-and-retry action.
- Arrange independent covenant and transaction-builder security review.
- Add repeatable automated browser transaction tests where a funded disposable test network is available.

See GitHub Issues for ownership and discussion. Completed historical milestones are kept in git history and release notes rather than as permanently open checklists.
