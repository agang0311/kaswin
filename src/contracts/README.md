# Contract Artifacts

`raffle_round.sil` is the covenant source draft for the V0 raffle round. It is intentionally committed before compiled bytecode so the app can stop pretending that a normal P2PK treasury transfer is a covenant.

Current files:

- `raffle_round.sil`: Silverscript source for the single-UTXO round covenant.
- `compiled/raffle-round.manifest.json`: source-only manifest. The frontend reads this and disables covenant finalize until compiled artifacts are present.

Next required work:

1. Install/build `kaspanet/silverscript`.
2. Compile `raffle_round.sil` for TN12.
3. Replace `compiled/raffle-round.manifest.json` with ABI/script bytes and `status: "compiled"`.
4. Wire transaction v1 covenant creation, buy, close, finalize, and refund spends in the browser.
