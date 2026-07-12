# Current Project Status and Backlog

This file reflects the current v3.3 implementation. The original milestone checklists in GitHub Issues were created before the covenant design stabilized and are being closed or rewritten where the implemented architecture superseded them.

## Implemented

- Self-contained static React/TypeScript SPA and single-file release build.
- Mainnet/Testnet 10 network profiles with strict node and wallet validation.
- KasWare and Kastle wallet adapter registry.
- Compiled Silverscript `RaffleRound` artifact and legacy artifact compatibility.
- Stateful covenant create and batched buy flow.
- Up to 1,000 tickets in at most 20 purchase batches.
- Participant-only direct finalize with winner payment in the covenant transaction.
- Walletless all-buyer refund after the DAA timeout.
- Registry-based browser history and shared round links.
- Three-round real-network regression loop, including History load before finalize.

## Superseded Original Tasks

- Separate Round, Ticket, Finalize, and Refund covenant templates were replaced by one stateful `RaffleRound` covenant with entrypoints.
- Creator reveal and manual Close were replaced by oracle-backed direct finalize after sellout or timeout.
- Browser-local imported private keys were replaced by wallet adapters. Private-key test wallets exist only in the local development server.
- Mock scanner events were replaced by REST-backed on-chain history reconstruction.

## Open Hardening Work

- Define and test a chain reorganization rollback strategy.
- Persist scanner checkpoints and resume long histories incrementally.
- Improve stale-round contention guidance and optionally offer an explicit reload-and-retry action.
- Replace the deterministic development oracle with a production-grade randomness source.
- Arrange independent covenant and transaction-builder security review.
- Add repeatable automated browser transaction tests where a funded disposable test network is available.

See GitHub Issues for ownership and discussion. Completed historical milestones are kept in git history and release notes rather than as permanently open checklists.
