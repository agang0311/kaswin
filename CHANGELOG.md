# Changelog

All notable changes to Kaswin are documented here. The repository distinguishes a locally verified candidate from a network-released protocol; a green local build is never a Mainnet authorization.

## [0.9.13] - 2026-07-20

### Added

- Added a covenant-enforced purchase-batch hard limit of 1000 while retaining 100 as the creator default.
- Added a live creator recommendation of `max(1, min(1000, floor(salesSeconds / 6)))`, including an explicit stale-UTXO warning above the recommendation and a one-click “use recommendation” action.
- Added exact Registry marker-return recovery: query the accepted spender of the marker outpoint, verify the single 0.19 KAS creator output, and refuse ambiguous or blind retries.
- Added VM and protocol regression cases that accept batch 1000, reject batch 1001, and construct/verify a complete 1000-leaf Merkle proof.
- Added current-protocol validation evidence, compatibility mapping, local acceptance reports and a machine-readable `validation/` evidence bundle.
- Added separate Chinese and English project READMEs with explicit covenant compatibility, artifact hashes, fee boundaries and network-evidence status.

### Changed

- Changed the candidate protocol identity to `raffle-vnext-liveness-guard-b1000`; the Round artifact SHA-256 is `215aaae53f9a3d71fef0cf6deb8783582a36c212cd3bb9a67bedb7a850206f3d`.
- Kept the Refund artifact SHA-256 at `bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2`.
- Unified the 1000 bound across the SilverScript contract, protocol manifest, state validation, metadata, Merkle helpers, transaction construction and creator UI.
- Cached protocol Merkle empty nodes to avoid rebuilding the same 20 levels for every append/proof operation.
- Made current runtime artifacts reproducible by replacing the wall-clock `generatedAt` field with a deterministic source SHA-256 commitment.
- Made all RPC submissions strict `allowOrphan = false`; Registry publication selects confirmed wallet UTXOs and marker return waits for marker confirmation.
- Registry publication now waits for the exact Create covenant output to confirm and excludes every wallet outpoint consumed by Create, even if a stale RPC UTXO view still reports that input as confirmed.
- Updated page layout and guidance around current-round actions, creation/discovery, network/wallet status, action-local feedback, explorer links and language-consistent signing previews.
- Documented buyer-funded refund network fees, the 0.573 KAS refundable carrier, and the common Mainnet/Testnet 0.01 KAS net Registry policy.

### Fixed

- Fixed the lower-level Merkle API accepting a batch index above the protocol limit even though the state and transaction layers already rejected it.
- Fixed Registry parent-propagation/orphan failures by waiting for confirmed inputs and separating recoverable publication/marker-return states.
- Fixed create/buy signing shapes, deterministic transaction-ID recovery, covenant JSON normalization, stale cursor handling, fee convergence and action feedback placement covered by the 0.9.13 regression suite.
- Fixed next-round form edits mutating the displayed parameters of the completed current round by keeping organizer inputs in an isolated draft state.

### Compatibility and validation

- `raffle-vnext-liveness-guard` (0.9.12) is now quarantined read-only; its accepted Testnet transactions are historical compatibility evidence and must never be spent with the b1000 Round artifact.
- `npm run verify` and `npm run validation:local` pass for the current worktree. The reproducible same-workspace single-file SHA-256 is `2152029c005dd463a233fa04998e7e76d81f1da05efeb4814b919cca5b31b9cf`.
- The exact current artifact completed a Mainnet Create → Registry → Buy → sold-out Draw loop on 2026-07-20; see `docs/mainnet-validation-log.md`.
- Exact-hash Testnet A–E, the Mainnet below-minimum refund loop, KasWare/Kastle and mobile E2E, static HTTPS, clean-environment reproducibility and independent security audit remain release blockers, so v0.9.13 is a pre-release integration candidate.
