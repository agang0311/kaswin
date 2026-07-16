# Development Verification Loop

New rounds use `raffle-v16-dynamic-refund-transition` with `RaffleRoundV16` and `RaffleRefundV16`. The bytecode matches the deployed v16 `RaffleRoundV13`/`RaffleRefundV3` artifacts exactly; v14 and v15 rounds are operated with the archived `v0.9.6` release.

## Automated gate

```powershell
npm run compile:contract
npm run verify
npm run benchmark:indexer:1m
```

`npm run verify` must prove:

- one self-contained `dist/index.html` is produced;
- Mainnet and Testnet 10 derive the compiled covenant script correctly;
- purchases accept any positive whole-number count up to the round remainder;
- one purchase appends one range leaf regardless of ticket count;
- finalize recomputes the selected-chain boundary block and pays the proven winning range owner;
- one refund transaction processes up to 13 consecutive purchase batches and preserves one output per owner range;
- a second client can load `refundCursor` and `refundBatchCursor` and continue;
- all Registry rounds remain visible without an indexer, and any round with complete local batch history can draw or refund locally; only missing batch proofs require the standalone indexer.

## Real-network gate

Use a disposable funded Testnet 10 wallet and Chrome. Run at least three new rounds against the current page build:

1. Create, buy, draw, and confirm the winner output.
2. Create and buy, reload the page, load the round through History, then draw and confirm payout.
3. Create with a short timeout, buy at least two purchase batches, start refund, reload/load from History after at least one batch, then continue until `Refunded`.

For every transaction, refresh History and confirm its indexed status, ticket/batch cursors, output owner, amount, and transaction id. Arbitrary quantity `37`, the 13-batch maximum, and load-after-partial-refund are covered by VM/indexer tests unless a funded test round intentionally exercises them.

### 2026-07-14 Testnet 10 refund gate

The mixed successor-covenant and refund-output RPC path was verified with three fresh rounds:

- `round-c8f6e2645ba522b0`: one 1-ticket purchase, then a complete timeout refund in `96ed6ef5204e8268158ce10e0c0e8286b5b2c55e1a24ca5b1352da355a31cd78`.
- `round-6ed9e5360da774ad`: one 10-ticket purchase; a second purchase after timeout was rejected and its temporary funding was returned, then the valid batch refunded in `1fce834ff2a9d4ca1a1a60d78bcd51eadce824e21c5fab2a0d029a1c2eeb2ab3`.
- `round-605c3976584a972f`: three 10-ticket purchases. The page was reloaded after the first batch reached cursor `10/30` in `ce0064f32af34b16a8d49df60529a728d633aab53f401ab67fb96f04501a7d80`; History loaded the `Refunding` successor with a 6 KAS pot and completed the remaining batches without a wallet in `f124166f414c2f4230dd1ce588864ca012e4aaee3327745b49890842d6686465` and `393a68ab587bef2fde696cea1277cc422e2fa8c071bb91b11050cda909db3ea0`.

An earlier interrupted two-batch round, `round-20660a1cc60f08ff`, was also loaded from History and completed in `b21e498975e32011d0c2a37cfbb6277c4f6ec847a0287e1b27282908bd5754b8`. After the gate, Testnet 10 History reported seven current-contract rounds: two paid and five refunded.

## Randomness boundary

The covenant binds the winner to the first selected-chain block crossing a fixed future DAA boundary and verifies it with `OpChainblockSeqCommit`. The creator, buyer, RPC, indexer, and trigger cannot select another block or winner. As with every block-hash-only construction, the miner entitled to the target block can theoretically withhold it at the cost of its block reward; eliminating that ability requires an independent randomness source, trusted hardware, or a multiparty protocol.
