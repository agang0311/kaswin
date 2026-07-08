# Development Verification Loop

This project has two separate gates:

1. Buyer flow: a normal user can open the static page, connect to a browser wRPC endpoint, load a round link, import or generate a funded testnet wallet, and buy tickets.
2. Covenant flow: close/finalize must be a real Kaspa covenant spend. The prize must be paid by the finalize transaction itself, not by a treasury private key or a later manual transfer.

## Local Commands

```bash
npm run verify
```

Runs the TypeScript build and static release checks. This command is allowed to pass while the covenant manifest is still `source-only`; in that state the UI must keep automatic payout disabled.

```bash
npm run verify:covenant
```

Runs the same checks with the release gate enabled. This command must fail until `src/contracts/raffle_round.sil` is compiled and `src/contracts/compiled/raffle-round.manifest.json` contains real ABI/script artifacts.

## Manual TN12 Browser Loop

Use a dedicated testnet wallet only.

1. Start the static app locally.
2. Open the app in Chrome.
3. Connect to `ws://tn12-node.kaspa.com:17210` with network `testnet-12`.
4. Load the shared round URL or paste the round metadata JSON.
5. Import a funded TN12 buyer wallet.
6. Buy one ticket at `20000000` sompi.
7. Increase ticket coverage to two and then three tickets.
8. Confirm the page reconstructs sold ticket count and pot size.
9. Close/finalize only when the covenant manifest is compiled.
10. Confirm the winning output is paid by the covenant finalize transaction itself.

## Current Expected Result

The buyer flow is live on TN12 with the legacy ticket-payment harness. The covenant flow is intentionally blocked because the committed manifest is still `source-only`.

A passing release run requires all of the following:

- `raffle_round.sil` compiles against the current `kaspanet/silverscript` toolchain.
- The compiled manifest has `status: "compiled"`, script bytes, and ABI data.
- Browser transaction builders create the round covenant UTXO, ticket transition spends, close spend, and finalize termination spend.
- Finalize output 0 pays the winning ticket owner directly from the covenant pot.
- No treasury private key or manual `Pay prize` path exists in the UI.
