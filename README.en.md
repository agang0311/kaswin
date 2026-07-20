# Kaswin

[中文](README.md) · [English](README.en.md)

Kaswin is a browser-native raffle system built on Kaspa Toccata covenants. Ticket payments go directly into a contract-constrained Round UTXO rather than a custodial platform account. The browser connects to Kaspa wRPC and every create, buy, draw, or refund transition can be independently inspected on chain.

The current repository version is **Kaswin 0.9.13.1**. It creates and spends only the following current covenant version:

| Item | Current value |
| --- | --- |
| Protocol version | `raffle-vnext-liveness-guard-b1000` |
| Round contract | `RaffleRoundVNext` |
| Refund contract | `RaffleRefundVNext` |
| Round artifact SHA-256 | `215aaae53f9a3d71fef0cf6deb8783582a36c212cd3bb9a67bedb7a850206f3d` |
| Refund artifact SHA-256 | `bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2` |
| Supported networks | Kaspa Mainnet and Testnet 10 |

> v0.9.13.1 is a display-only patch over v0.9.13 and keeps the same covenant protocol and artifact hashes. It is distributed as a pre-release integration candidate. The exact current artifact has passed the local automated gates and one Mainnet create/Registry/buy/sold-out-draw loop. The complete Testnet A–E matrix, a Mainnet refund loop, KasWare/Kastle and mobile E2E, static HTTPS deployment, clean-environment reproduction, and an independent security audit are not all complete. Do not treat this pre-release as an audited production system.

## How it works

- **Non-custodial prize pool:** ticket payments increase the covenant UTXO; there is no platform key that can redirect the pool.
- **Two safe outcomes:** once the minimum is met the round can only draw; after the deadline a below-minimum round can only refund. Anyone may close an empty expired round, but the carrier output is committed to the creator.
- **Buyer-funded refund fees:** refund-transition and refund-transaction fees are deducted from the purchase batches being refunded. The public caller does not need to fund the refund.
- **Selected-chain randomness:** the winner is derived from a precommitted Kaspa selected-chain target block together with the ticket root, round nonce, and chain sequence commitment.
- **Recoverable Registry:** the default Mainnet and Testnet Registry net cost is 0.01 KAS. A relay-safe temporary 0.20 KAS marker is published and 0.19 KAS is automatically returned after confirmation; the wallet network fee is separate.
- **Explicit wallet approvals:** Create and Registry are one wallet transaction each. Buy combines payment and the covenant successor in one transaction. Every approval preview shows the network, amounts, addresses, carrier, and fee estimate.
- **Public settlement:** draw, refund, and empty-round close do not depend on the creator remaining online. A low-ticket live round can receive a state-preserving carrier top-up.

## Capacity and fee boundaries

A single Round UTXO serializes all purchases. A limit of one million tickets does not mean one million wallets can buy concurrently.

- Up to `1,000,000` tickets per round.
- `100` purchase batches by default; covenant hard limit `1,000`.
- UI recommendation: `max(1, min(1000, floor(salesSeconds / 6)))`.
- Minimum ticket price: `1 KAS`, preserving a relay-safe owner output at the refund fee caps.
- Default refundable carrier: `0.573 KAS`; settlement network fees are deducted from it.
- Default Registry net cost: `0.01 KAS`; the exact Registry wallet fee is shown after submission.

Higher batch counts increase stale-UTXO contention, queue time, and the number of refund transactions. Large deployments should use a sufficiently long sales window, batch ticket purchases, and run the optional proof-producing Indexer.

## Covenant compatibility

The covenant version is part of on-chain state. A new artifact must never guess or spend an older covenant:

- `raffle-vnext-liveness-guard-b1000`: current v0.9.13.1 protocol package; same covenant artifact as v0.9.13; create and spend are enabled.
- `raffle-vnext-liveness-guard`: historical 0.9.12 candidate; quarantined read-only in the current page.
- `raffle-v16-dynamic-refund-transition`: use the matching v0.9.7 historical Release.
- `raffle-v15-arbitrary-batched-refund` and `raffle-v14-batch-range`: use the matching v0.9.6 historical Release.

See [contract compatibility](docs/contract-compatibility.md). Every GitHub Release and downloadable page must state its applicable protocol, Round/Refund contract names, and artifact SHA-256 hashes.

## Current network evidence

On 2026-07-20, the exact v0.9.13/v0.9.13.1 Round artifact completed a small-value sold-out loop on Mainnet:

- Round: `round-66b8de553189543b`
- [Create](https://kaspa.stream/transactions/2f60ad3a3e7365b6f05ef574f06fe7a96c77501358a74260ac27dcd90e10c208)
- [Registry](https://kaspa.stream/transactions/941f12832684ab0474587e0a2c1ece4a9afe55af3764cef49d503c50ae94a617)
- [0.19 KAS marker return](https://kaspa.stream/transactions/f96d71580ee6b9fe84e0e6943564367996f01ebfef921aad056a73580d9cb578)
- [Ticket #1 purchase](https://kaspa.stream/transactions/e3fd0d3b23c78ceba685f80dac6ed30e1b3a4a9d9df3cb7f25ea39030049a762)
- [Draw and payout](https://kaspa.stream/transactions/605df135a7adf9095ffabeafa8717c3768b44702b36e89bac4544b0118be39f9)

This proves network acceptance for the current create, Registry, buy, and draw path. It does not replace the pending Mainnet refund round, full Testnet matrix, or independent audit. See the [Mainnet validation log](docs/mainnet-validation-log.md) and [validation evidence matrix](docs/audit-evidence-matrix.md).

## Local development

Node.js 20+ is required. Use the lockfile when installing dependencies:

```powershell
npm ci
npm run compile:vnext
npm run verify
npm run validation:local
npm run dev
```

Build the self-contained release page with:

```powershell
npm run build
```

The output is `dist/index.html`, including the Kaspa WASM runtime. Local validation keys are read only from the Git-ignored `wallets/` directory or a development-machine environment variable and are not embedded in the release HTML. Never expose the local Vite development server publicly.

Optional Indexer:

```powershell
$env:KASPA_RPC_URL="ws://127.0.0.1:18110"
$env:KASPA_NETWORK="testnet-10"
npm run start:indexer
```

The Indexer observes public transactions and returns independently verifiable proofs. It does not choose the winner or control funds. Registry, History API, Indexer, browser cache, and static hosting are outside the settlement trust boundary.

## Documentation

- [Chinese user guide](docs/user-guide.zh-CN.md)
- [Chinese technical guide](docs/technical-guide.zh-CN.md)
- [vNext protocol](docs/protocol-vnext.md)
- [Validation evidence matrix](docs/audit-evidence-matrix.md)
- [Mainnet validation log](docs/mainnet-validation-log.md)
- [Testnet validation log](docs/testnet-validation-log.md)
- [Changelog](CHANGELOG.md)
- [GitHub submission checklist](docs/github-submission-checklist.md)

## Security notice

This covenant software can handle real assets. Before using it, independently verify the Release protocol version, artifact hashes, and HTML SHA-256. Use a dedicated wallet and small amounts. Do not disclose exploitable security issues publicly before coordinating a fix with the maintainer.
