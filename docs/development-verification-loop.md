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
npm run compile:contract:v4
npm run verify:contract:v4
npm run verify:fees:v4
npm run verify:users:1m
npm run verify:indexer
```

Runs the local `kaspanet/silverscript` compiler from `.tools/silverscript`. On Windows, the script uses Rust GNU plus MSYS2 MinGW and injects a temporary RISC0 allocation stub required by the current `kaspa-txscript` dependency graph.

As of 2026-07-09, the raffle contract compiles locally. The 32-byte oracle public key and ticket-root values are stored as fixed `byte[32]` covenant state fields, and the browser encoder mirrors the compiler state layout.

## Manual Testnet 10 Browser Loop

Use a dedicated testnet wallet only. The public endpoint name contains `tn12`, but currently reports network id `testnet-10`.

1. Start the static app locally.
2. Open the app in Chrome.
3. Select Testnet 10 and connect to `ws://tn12-node.kaspa.com:18210`; the node must report the selected network.
4. Load the shared round URL or paste the round metadata JSON.
5. Connect a funded disposable TN10 wallet; local private-key adapters are development-only.
6. Buy one ticket per transaction and confirm the Merkle cursor advances.
7. Run at least three complete rounds; one must contain 10 tickets and one must exercise timeout refunds.
8. Load at least one round through the index-backed History view before finalize or refund.
9. Run the v4 contract, fee, million-user, and indexer verifiers listed above.
10. Confirm round creation uses the default `0.2 KAS` carrier and rejects values below `0.1 KAS`.
11. Confirm finalize pays the winner, returns the authorization UTXO unchanged, and returns carrier minus the fixed fee.
12. Confirm every refund pays the proven ticket owner, advances `refundCursor`, and returns carrier on the last ticket.

## Current Expected Result

The buyer flow and covenant transaction builders are wired for the currently reachable Toccata testnet endpoint. As of 2026-07-09, the public `ws://tn12-node.kaspa.com:18210` endpoint reports `testnet-10`, so the UI follows the connected node network instead of assuming the label in the URL.

A passing release run requires all of the following:

- `raffle_round.sil` compiles against the current `kaspanet/silverscript` toolchain.
- The compiled runtime artifact has script bytes, ABI data, and the expected primitive state layout.
- Browser transaction builders create the round covenant UTXO, ticket transition spends, direct finalize termination spend, and timeout refund spend.
- The covenant permits finalize only after all tickets sell or the configured DAA deadline arrives.
- The covenant supports 1,000,000 distinct one-ticket users with a depth-20 root/frontier state.
- Finalize verifies independent winner and caller proofs; refund verifies the cursor ticket proof.
- The confirmed-chain indexer serves the latest covenant cursor and proofs without browser-side million-hop address tracing.
- Finalize output 0 pays the winning ticket owner directly from the covenant pot.
- No treasury private key or manual `Pay prize` path exists in the UI.
- `dist/` contains only a self-contained `index.html` with the Kaspa WASM embedded.

## Verified V4 Runs (2026-07-12)

- `round-d8769ebd3aa34421`: 10 separate purchases, loaded from History, winner #2, payout `62e8f9e45f365c79ae814643b662463cd08b0a6a7a48539f3cea28ae434c4095` (`3 KAS`).
- `round-cdacdd9b6a09331e`: 3 separate purchases, winner #3, payout `1de1141ef0ddcbc63cb3546bfd72540d998c4d7f81fc256f2990bcf7cd9527ce` (`0.9 KAS`).
- `round-cb1cc2194edbce86`: 2 separate purchases, 30-second timeout, loaded from History, first refund `902d32c553586369b3a40cb41e9d467186027548de4a28a1c7724aee23e19f91`, final refund `f62c7646d55ad230272b356a0656d56e9a394dffb6aa2eac7e7e0c17153ed7ff`.

The first finalize attempt exposed a real-node unit total of `150587` against a `149999` commitment. V4 now commits budget 18 (`189999` total allowance); transient mass still determines the `0.022 KAS` configured finalize fee.

The root-bound oracle template was then exercised in three additional rounds:

- `round-c9312e27bce5542e`: one ticket, direct payout `e9ab80b00896bada834bd99b70df7557c6ad352b8a318325992cff15c7d3b07e`.
- `round-33f0472457bb53c7`: one ticket, loaded through History, payout `5cb17ffe9ace35decf6c111a88f36b1833e2d439fbf26083d41865c11ddd4b4d`.
- `round-52ef2093c0908a32`: one ticket, loaded through History, timeout refund `4fcc89d2d76c149ff7316344be665c58c1fe54af392487fd0e0d76567c3e05a8`; the reorg-aware index now reports `Refunded` with cursor 1.

## Million-Record Index Benchmark (2026-07-12)

`npm run benchmark:indexer:1m` generated 1,000,000 fixed 64-byte ticket records and verified the first, middle, and last depth-20 proofs plus owner lookup against root `8b5aedb02306c1dedef54f80f1667cbf30494b533e42705dafed16094cced900`.

| Metric | Result |
| --- | ---: |
| cold derived-index rebuild | 298.15 s |
| checkpoint restart | 0.27 s |
| first / middle / last proof | 5.00 / 1.93 / 1.36 ms |
| millionth-owner lookup | 19.60 ms |
| fixture disk bytes | 164,003,779 |
| warm indexer RSS | 79,523,840 |

The deterministic index fixture also simulates a crash after event-log append but before state checkpoint, then removes the third ticket's confirmed block and rebuilds the correct two-ticket root from the migration baseline.

## Verified TN12 Runs (2026-07-11)

- `round-e58e5261eb6c6e1e`: 10 tickets, one batch, payout `9100ff8d511fd101f29a76281baac777ee13a50f6c6f9c2469d0a4711d086cc7`.
- `round-a57468eb2c262611`: 3 tickets, loaded through History before finalize, payout `fec95efa66655439f80ad015835e0baf1ccc936baddcc533dccc9603412d330a`.
- `round-66ce07a8daa5b00b`: 1,000 tickets, one batch, winner #495, payout `f197bdbdd9a08e16a9e9c441a09d524fb75e9e3a885b101495f5d99f9a9cbb17`.

## Verified TN10 Network-Switch Runs (2026-07-12)

- `round-6e6afc21598c8dd6`: 1 ticket, payout `754ae72780f8e0b8e0af2358c96471df297e4ed2693fa5279250cae9101477fd`.
- `round-25447582f3b2087c`: 1 ticket, payout `2b02fd63a94a0ca2eff62e9f30b669c0b9e28dcede6eeed20a545db3876e7a79`.
- `round-8e274e30421325df`: 1 ticket, loaded through History before finalize, payout `73d63c2288b24c7b13d35426eb6ceed54acd7e873ae92befa4d69e9506f2bae0`; a subsequent history refresh reported `Paid`.

The same browser run switched to Mainnet, connected read-only to `ws://127.0.0.1:18110`, then switched back and completed all three Testnet 10 transaction loops. No Mainnet transaction was submitted.

## Verified Configurable Registry Runs (2026-07-12)

- `round-d3cf3feec27c88d3`: default registry, 5 KAS marker, `0.004005 KAS` payment fee, 4.99 KAS marker refund after 0.01 KAS refund fee, payout `2b32422e79f10a5f0f1959565073ca892d496342de95bba7babca4f98bb68b45`.
- `round-7beb4751df9d0adc`: custom registry set to the creator wallet, 5 KAS marker retained at that address, `0.003994 KAS` payment fee, payout `da24e593c90c661c4bcaa9e1590edc32607b036e10246887cd0b1e6cddd48063`.
- `round-642fbddce847b69c`: custom registry set to the creator wallet, loaded through History from that address before finalize, payout `4420b0e60948f6c465ff46022afac173babb8054b523a516ca478f117beb5a6c`; a later index refresh reported `Paid`.

The same run confirmed that an invalid custom Registry address is rejected before any create transaction is submitted.

## Verified 2 KAS Carrier Runs (2026-07-12)

- `round-833bbc8bc79a10e9`: 1 ticket, payout `afe653644b827404dd37f0528250834d1928860760449e88f3186cf88561af68`.
- `round-3c0feb896c7a7904`: 1 ticket, payout `5082b448d6fcaf460b78da41d4b8ee94fb6deaa63a1aeec94498b72f1be16ddf`.
- `round-bab654c0bd673db3`: 1 ticket, loaded through History before finalize, payout `0b7132970a7094bedde9fcbefac8aee31d534e633eb625ea6adcfb1b55d514b2`; a later history refresh reported `Paid`.

All three rounds used the `2 KAS` default carrier and completed create, buy, covenant finalize, direct payout, and creator carrier refund without storage-mass rejection.

## Verified V3.4 Low-Fee Runs (2026-07-12)

- `round-3e068dc0f56bf371`: 0.2 KAS carrier, 0.1 KAS staged marker, 1 ticket, payout `8e20ed5aaa53c7352b036b0b0970f9bb3e71dcb584d7018bdea9523813e4ab06`.
- `round-f0ec30c1c73dae8c`: loaded through History before finalize, payout `9b840b93cdf84f0b0ac4a9fd30e8abdef437a10f1785632981f66554fce5e163`.
- `round-c197a6e80b685156`: 30-second timeout, walletless refund `c3f044fa933eb372a2a623c4c6fe81fc21e21bb042b49261a0915d8fd885a87d`.
- `round-b48d9a5605cb5f6b`: final 0.05 KAS staged marker test; Testnet returned 0.049 KAS after a 0.001 KAS fee, payout `51a0aea9019dee3824d7f4ca4dfa402c1b9558ce4853ad94bbbb5087b85ce74c`.

Accepted transaction masses and fixed-fee margins:

| Path | Compute mass | Fixed fee | Minimum relay fee | Margin |
| --- | ---: | ---: | ---: | ---: |
| create | 1,271 | 0.002 KAS | 0.001271 KAS | 1.57x |
| buy | 12,484 | 0.02 KAS | 0.012484 KAS | 1.60x |
| finalize | 10,872 | 0.02 KAS | 0.010872 KAS | 1.84x |
| refund (one batch) | 9,504 | 0.03 KAS | 0.009504 KAS | 3.16x |

The staged Registry payment used 0.005047 KAS in combined wallet-funding and marker relay fees. The final Testnet marker refund used 0.001 KAS. Mainnet and custom Registry markers remain controlled by the destination address rather than being burned.

## Bilingual UI Verification (2026-07-12)

- Verified the complete create, history, buy, draw, refund, oracle, and advanced-settings surfaces in Chinese and English.
- Verified that the top-right language selector persists across reloads and translates runtime validation messages.
- Verified the Chinese mobile layout at 390 x 844 with no horizontal overflow, then restored the desktop viewport.
- Loaded indexed Testnet 10 history in Chinese and switched the populated history view to English without reloading.
