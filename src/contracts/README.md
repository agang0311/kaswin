# Contract Artifacts

`raffle_round_v4.sil` is the current million-user covenant. `raffle_round.sil` and its artifacts remain for v3.5 round compatibility.

Current files:

- `raffle_round.sil`: Silverscript source for the single-UTXO round covenant.
- `raffle_round_v4.sil`: current depth-20 Merkle covenant source.
- `compiled/raffle-round-v4.artifact.json`: current runtime ABI, template, and 787-byte state layout.
- `compiled/raffle-round.silverc.json`: generated Silverscript output with script, ABI, state layout, AST, and debug info.
- `compiled/raffle-round-v1.artifact.json`: preserved runtime artifact for loading rounds created before direct finalize.
- `compiled/raffle-round-v2.artifact.json`: preserved direct-finalize artifact for older rounds.
- `compiled/raffle-round-v3-beta.artifact.json`: preserved first batch artifact so its test round can be refunded safely.
- `compiled/raffle-round.manifest.json`: source metadata. The frontend uses `compiled/raffle-round.artifact.json` for executable covenant data.

Current verification:

1. `raffle_round_v4.sil` compiles with primitive `int`, `byte[32]`, and `byte[640]` fields.
2. SilverScript tests cover valid and invalid buy roots, participant/winner proofs, refund proofs, and cursor advancement.
3. Browser verification covers three real TN10 rounds, including History-loaded finalize and History-loaded sequential refund.
4. `npm run verify:users:1m` replays 1,000,000 distinct appends and proofs; `npm run verify:indexer` checks crash recovery, deep-reorg rollback, and persistent proof serving.
5. `npm run benchmark:indexer:1m` builds a full million-record disk index, verifies random proofs and owner lookup, and measures cold/warm startup.

Windows compiler note:

- Rust/Cargo can build `silverc` with the `stable-x86_64-pc-windows-gnu` toolchain plus MSYS2 MinGW.
- `kaspa-txscript` currently pulls RISC0 dependencies on Windows. The compile script injects a no-runtime RISC0 allocation stub so the compiler binary can link.
- `raffle_round.sil` stores the oracle public key and ticket root as fixed `byte[32]` covenant state fields, matching the compiler's encoded state layout directly.
- Finalize is valid only after all tickets sell or the round deadline is reached. The timeout path shares its DAA deadline with the all-buyer refund path.
- V4 stores only `ticket_root`, a 640-byte append frontier, and `refund_cursor`; owner records stay in the confirmed-chain index.
- Finalize verifies separate 640-byte proofs for the winner and caller, then forces the prize and authorization-return outputs.
- Refund is valid only after the DAA timeout, verifies the current cursor ticket, forces its owner payment, and advances one state step.
- The recoverable development oracle remains test-only. Production deployment requires independent verifiable randomness.
