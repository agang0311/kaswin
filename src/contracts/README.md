# Contract Artifacts

`raffle_round.sil` is the covenant source for the raffle round. It compiles with the local Silverscript toolchain, and the browser transaction builder reads the runtime artifact for round creation, buy, direct finalize, and timeout refund spends.

Current files:

- `raffle_round.sil`: Silverscript source for the single-UTXO round covenant.
- `compiled/raffle-round.silverc.json`: generated Silverscript output with script, ABI, state layout, AST, and debug info.
- `compiled/raffle-round-v1.artifact.json`: preserved runtime artifact for loading rounds created before direct finalize.
- `compiled/raffle-round-v2.artifact.json`: preserved direct-finalize artifact for older rounds.
- `compiled/raffle-round-v3-beta.artifact.json`: preserved first batch artifact so its test round can be refunded safely.
- `compiled/raffle-round.manifest.json`: source metadata. The frontend uses `compiled/raffle-round.artifact.json` for executable covenant data.

Current verification:

1. `raffle_round.sil` compiles with primitive `int` and fixed `byte[32]` state fields.
2. Browser verification covers create, buy, automatic local oracle attestation, direct finalize, winner payout, and history load on the currently reachable public testnet node.
3. Historical lookup is available through the explorer REST API; fuller chain reconstruction after arbitrary page reloads is still future work.

Windows compiler note:

- Rust/Cargo can build `silverc` with the `stable-x86_64-pc-windows-gnu` toolchain plus MSYS2 MinGW.
- `kaspa-txscript` currently pulls RISC0 dependencies on Windows. The compile script injects a no-runtime RISC0 allocation stub so the compiler binary can link.
- `raffle_round.sil` stores the oracle public key and ticket root as fixed `byte[32]` covenant state fields, matching the compiler's encoded state layout directly.
- Finalize is valid only after all tickets sell or the round deadline is reached. The timeout path shares its DAA deadline with the all-buyer refund path.
- The current v3.5 state stores up to 20 purchase-batch end indexes and owner public keys. A batch may contain many tickets, allowing 1,000,000 total tickets without one state field per ticket.
- Finalize derives the winning ticket index, resolves its batch owner inside the covenant, and requires the prize output to use that public key.
- Finalize also requires the caller to own at least one recorded purchase batch. The caller signs an authorization UTXO that is returned unchanged.
- Refund is valid only after the DAA timeout and pays each purchase batch back without requiring a wallet signature.
