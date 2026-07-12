# Development Verification Loop

This project has two separate gates:

1. Buyer flow: a normal user can open the static page, connect to a browser wRPC endpoint, load a round link, import or generate a funded testnet wallet, and buy tickets.
2. Covenant flow: finalize must be a real Kaspa covenant spend after sellout or timeout. The prize must be paid by the finalize transaction itself, not by a treasury private key or a later manual transfer.

## Local Commands

```bash
npm run verify
```

Runs the TypeScript build and static release checks. This command is allowed to pass while the covenant manifest is still `source-only`; in that state the UI must keep automatic payout disabled.

```bash
npm run verify:covenant
```

Runs the same checks with the release gate enabled. This command must fail if the compiled runtime artifact is missing or the browser covenant transaction builders are not wired.

```bash
npm run compile:contract
```

Runs the local `kaspanet/silverscript` compiler from `.tools/silverscript`. On Windows, the script uses Rust GNU plus MSYS2 MinGW and injects a temporary RISC0 allocation stub required by the current `kaspa-txscript` dependency graph.

As of 2026-07-09, the raffle contract compiles locally. The 32-byte oracle public key and ticket-root values are stored as fixed `byte[32]` covenant state fields, and the browser encoder mirrors the compiler state layout.

## Manual Testnet 10 Browser Loop

Use a dedicated testnet wallet only. The public endpoint name contains `tn12`, but currently reports network id `testnet-10`.

1. Start the static app locally.
2. Open the app in Chrome.
3. Select Testnet 10 and connect to `ws://tn12-node.kaspa.com:18210`; the node must report the selected network.
4. Load the shared round URL or paste the round metadata JSON.
5. Import a funded TN12 buyer wallet.
6. Buy a ticket batch and confirm the page displays one ticket-number range instead of one row per ticket.
7. Run at least three complete create/buy/finalize rounds; one round must contain 10 tickets.
8. Run a final 1,000-ticket round and confirm it can be bought in one batch, reconstructed from history, and paid out.
9. Confirm round creation uses the default `5000000000` sompi carrier reserve and stores the creator address for refund.
10. Finalize after the round sells out; the page should create the development oracle attestation automatically.
11. Load at least one sold-out round through History before finalizing it.
12. Confirm the winning output is paid by the covenant finalize transaction itself and any large carrier remainder is refunded to the creator.

## Current Expected Result

The buyer flow and covenant transaction builders are wired for the currently reachable Toccata testnet endpoint. As of 2026-07-09, the public `ws://tn12-node.kaspa.com:18210` endpoint reports `testnet-10`, so the UI follows the connected node network instead of assuming the label in the URL.

A passing release run requires all of the following:

- `raffle_round.sil` compiles against the current `kaspanet/silverscript` toolchain.
- The compiled runtime artifact has script bytes, ABI data, and the expected primitive state layout.
- Browser transaction builders create the round covenant UTXO, ticket transition spends, direct finalize termination spend, and timeout refund spend.
- The covenant permits finalize only after all tickets sell or the configured DAA deadline arrives.
- The covenant supports up to 1,000 tickets through at most 20 purchase batches and verifies the winning batch owner on chain.
- Finalize output 0 pays the winning ticket owner directly from the covenant pot.
- No treasury private key or manual `Pay prize` path exists in the UI.
- `dist/` contains only a self-contained `index.html` with the Kaspa WASM embedded.

## Verified TN12 Runs (2026-07-11)

- `round-e58e5261eb6c6e1e`: 10 tickets, one batch, payout `9100ff8d511fd101f29a76281baac777ee13a50f6c6f9c2469d0a4711d086cc7`.
- `round-a57468eb2c262611`: 3 tickets, loaded through History before finalize, payout `fec95efa66655439f80ad015835e0baf1ccc936baddcc533dccc9603412d330a`.
- `round-66ce07a8daa5b00b`: 1,000 tickets, one batch, winner #495, payout `f197bdbdd9a08e16a9e9c441a09d524fb75e9e3a885b101495f5d99f9a9cbb17`.

## Verified TN10 Network-Switch Runs (2026-07-12)

- `round-6e6afc21598c8dd6`: 1 ticket, payout `754ae72780f8e0b8e0af2358c96471df297e4ed2693fa5279250cae9101477fd`.
- `round-25447582f3b2087c`: 1 ticket, payout `2b02fd63a94a0ca2eff62e9f30b669c0b9e28dcede6eeed20a545db3876e7a79`.
- `round-8e274e30421325df`: 1 ticket, loaded through History before finalize, payout `73d63c2288b24c7b13d35426eb6ceed54acd7e873ae92befa4d69e9506f2bae0`; a subsequent history refresh reported `Paid`.

The same browser run switched to Mainnet, connected read-only to `ws://127.0.0.1:18110`, then switched back and completed all three Testnet 10 transaction loops. No Mainnet transaction was submitted.
