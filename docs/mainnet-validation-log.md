# Mainnet validation log — Kaswin 0.9.13

This log records live Mainnet evidence for the exact `raffle-vnext-liveness-guard-b1000` candidate. It is evidence, not a production-readiness claim.

## Artifact identity

- App: `0.9.13`
- Protocol: `raffle-vnext-liveness-guard-b1000`
- Round contract: `RaffleRoundVNext`
- Refund contract: `RaffleRefundVNext`
- Round artifact SHA-256: `215aaae53f9a3d71fef0cf6deb8783582a36c212cd3bb9a67bedb7a850206f3d`
- Refund artifact SHA-256: `bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2`
- Network: Kaspa Mainnet
- Date: 2026-07-20 (Asia/Shanghai)

## Sold-out round

Round `round-66b8de553189543b` used a dedicated local participant wallet, a 1 KAS ticket price, one total ticket, one minimum ticket and one allowed purchase batch. The signing previews were manually checked before every wallet operation.

| Step | Accepted transaction | Exact observed fee / result |
| --- | --- | --- |
| Create covenant | [`2f60ad3a3e7365b6f05ef574f06fe7a96c77501358a74260ac27dcd90e10c208`](https://kaspa.stream/transactions/2f60ad3a3e7365b6f05ef574f06fe7a96c77501358a74260ac27dcd90e10c208) | 0.06 KAS network fee; 0.573 KAS carrier |
| Publish Registry | [`941f12832684ab0474587e0a2c1ece4a9afe55af3764cef49d503c50ae94a617`](https://kaspa.stream/transactions/941f12832684ab0474587e0a2c1ece4a9afe55af3764cef49d503c50ae94a617) | 0.050006 KAS wallet network fee |
| Return Registry marker | [`f96d71580ee6b9fe84e0e6943564367996f01ebfef921aad056a73580d9cb578`](https://kaspa.stream/transactions/f96d71580ee6b9fe84e0e6943564367996f01ebfef921aad056a73580d9cb578) | 0.19 KAS returned; 0.01 KAS Registry net cost |
| Buy ticket #1 | [`e3fd0d3b23c78ceba685f80dac6ed30e1b3a4a9d9df3cb7f25ea39030049a762`](https://kaspa.stream/transactions/e3fd0d3b23c78ceba685f80dac6ed30e1b3a4a9d9df3cb7f25ea39030049a762) | 0.021 KAS network fee; one wallet approval |
| Draw and pay | [`605df135a7adf9095ffabeafa8717c3768b44702b36e89bac4544b0118be39f9`](https://kaspa.stream/transactions/605df135a7adf9095ffabeafa8717c3768b44702b36e89bac4544b0118be39f9) | 0.055322 KAS covenant fee; ticket #1 received the 1 KAS prize |

Result: **sold-out Mainnet path passed** for the exact artifact identity above.

## Registry race found and corrected

The first Registry attempt produced local candidate `689e175bb8a46659cfec218ff53d2b5c0deb4539db1a937dcc0670dbce776217`, which the node rejected because a previously confirmed wallet UTXO was already spent by the Create transaction in the mempool. No marker was accepted for that candidate.

The transaction builder now applies two independent guards before requesting the Registry signature:

1. wait for the exact Create covenant output to have a non-zero confirmation DAA;
2. exclude every wallet outpoint consumed by Create even if the RPC backend temporarily returns it as a confirmed UTXO.

The regression suite supplies a stale confirmed UTXO view and proves that the spent Create input is excluded. The later Registry transaction and automatic marker return in the table above were accepted.

## Remaining Mainnet requirement

The separate below-minimum path still needs a fresh round that completes Start Refund and the final buyer refund while recording the exact buyer deduction and returned carrier. Until then:

- `mainnetSmokePassed` remains `false`;
- v0.9.13 remains a pre-release integration candidate;
- the successful sold-out path must not be presented as full Mainnet acceptance.
