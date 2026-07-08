# Contract Artifacts

`raffle_round.sil` is the covenant source for the V0 raffle round. It now compiles with the local Silverscript toolchain, but the app keeps covenant finalize disabled until the browser transaction builder is wired to the compiled artifact.

Current files:

- `raffle_round.sil`: Silverscript source for the single-UTXO round covenant.
- `compiled/raffle-round.silverc.json`: generated Silverscript output with script, ABI, state layout, AST, and debug info.
- `compiled/raffle-round.manifest.json`: source-only manifest. The frontend reads this and disables covenant finalize until the transaction builder is ready.

Next required work:

1. Wire transaction v1 covenant creation, buy, close, finalize, and refund spends in the browser.
2. Pass an empty `State[] next_states` value to `finalize`; this is the compiler-supported termination form.
3. Replace `compiled/raffle-round.manifest.json` with ABI/script bytes and `status: "compiled"` only after browser spends are verified on TN12.

Windows TN12 compiler note:

- Rust/Cargo can build `silverc` with the `stable-x86_64-pc-windows-gnu` toolchain plus MSYS2 MinGW.
- `kaspa-txscript` currently pulls RISC0 dependencies on Windows. The compile script injects a no-runtime RISC0 allocation stub so the compiler binary can link.
- `raffle_round.sil` avoids byte-array covenant state fields by storing each 32-byte value as 32 primitive `int` byte slots and rebuilding `byte[32]` values only inside hashing logic.
