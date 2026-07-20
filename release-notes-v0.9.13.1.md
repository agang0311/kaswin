# Kaswin v0.9.13.1

## Highlights

- Patch release over v0.9.13: Testnet UI amounts display as TKAS, and the gameplay/onboarding guide panels are shown only once per browser user.
- Buyer-funded refund network fees with a 1 KAS minimum ticket-price liveness floor.
- Public sold-out draw, below-minimum refund, empty-round close, and state-preserving carrier top-up paths.
- Purchase-batch hard limit raised to 1,000 with a sales-duration recommendation and one-million-ticket range support.
- Direct Create, Registry, and Buy wallet transactions with explicit signing previews and action-local feedback.
- Recoverable Registry publication/marker return, including exact-parent confirmation and stale Create-input exclusion.
- Chinese and English README files, kaspa.stream links, validation evidence, and compatibility guidance.

## Network evidence and release status

The exact current artifact completed a Mainnet Create → Registry → Buy → sold-out Draw loop on 2026-07-20. See [the transaction log](https://github.com/agang0311/kaswin/blob/v0.9.13.1/docs/mainnet-validation-log.md). The below-minimum Mainnet refund loop and the other blockers listed below are still pending, so this GitHub Release is intentionally marked as a **pre-release integration candidate**, not an audited production release.

## Applicable covenant version

This Release can create and spend only `raffle-vnext-liveness-guard-b1000` using `RaffleRoundVNext` and `RaffleRefundVNext`.
- Round artifact SHA-256: `215aaae53f9a3d71fef0cf6deb8783582a36c212cd3bb9a67bedb7a850206f3d`
- Refund artifact SHA-256: `bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2`
- Release classification: **pre-release-integration-candidate**.
- Release blockers: Testnet 10 A-E; Mainnet below-minimum refund smoke; wallet and mobile E2E; independent security audit.
- Historical or quarantined covenant versions are never spent with the current artifact.

### Historical protocols
For a historical round, use only the explicitly matching standalone page. Historical releases do not authorize the current vNext artifact.
- `raffle-vnext-liveness-guard`: quarantined; no compatible published Release.
- `raffle-vnext-carrier-topup`: quarantined; no compatible published Release.
- `raffle-vnext-buyer-funded-refund`: quarantined; no compatible published Release.
- `raffle-v16-dynamic-refund-transition`: download [Kaswin v0.9.7](https://github.com/agang0311/kaswin/releases/tag/v0.9.7)
- `raffle-v15-arbitrary-batched-refund`: download [Kaswin v0.9.6](https://github.com/agang0311/kaswin/releases/tag/v0.9.6)
- `raffle-v14-batch-range`: download [Kaswin v0.9.6](https://github.com/agang0311/kaswin/releases/tag/v0.9.6)
