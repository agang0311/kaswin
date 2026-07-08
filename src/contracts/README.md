# Contract Artifacts

`raffle_round.sil` is the covenant source draft for the V0 raffle round. It is intentionally committed before compiled bytecode so the app can stop pretending that a normal P2PK treasury transfer is a covenant.

Current files:

- `raffle_round.sil`: Silverscript source for the single-UTXO round covenant.
- `compiled/raffle-round.manifest.json`: source-only manifest. The frontend reads this and disables covenant finalize until compiled artifacts are present.

Next required work:

1. Install/build `kaspanet/silverscript`.
2. Run `npm run compile:contract`.
3. Resolve the current compiler limitation: `validateOutputState` rejects byte-array state fields used by `round_id`, `creator_commitment`, and `ticket_root`.
4. Replace `compiled/raffle-round.manifest.json` with ABI/script bytes and `status: "compiled"` only after the raffle covenant source compiles.
5. Wire transaction v1 covenant creation, buy, close, finalize, and refund spends in the browser.

Windows TN12 compiler note:

- Rust/Cargo can build `silverc` with the `stable-x86_64-pc-windows-gnu` toolchain plus MSYS2 MinGW.
- `kaspa-txscript` currently pulls RISC0 dependencies on Windows. The compile script injects a no-runtime RISC0 allocation stub so the compiler binary can link.
- The compiler now runs locally, but the raffle source is still blocked by byte-array covenant state support.
