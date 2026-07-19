# Known limitations and release blockers

- The current b1000 Round artifact has no accepted exact-hash Testnet transaction yet. All Testnet A–E scenarios and Mainnet smoke remain incomplete; earlier Chrome transactions are historical compatibility evidence only.
- A mid-refund interruption followed by continuation from a second browser/user must be repeated as a fresh current-hash live sequence; deterministic integration coverage does not replace that external evidence.
- KasWare/Kastle, desktop/mobile browser E2E and static HTTPS hosting checks are not complete.
- The recorded million-batch Indexer benchmark is offline/local and uses the retained v15 fixture encoding; it is not live-network or vNext settlement evidence.
- Build reproducibility is recorded in `release-sha256.txt`; a clean-environment reproducibility run remains pending, and a mismatch/inconclusive result is a release blocker.
- No independent security audit has been completed; Critical/High issue counts are intentionally unassessed, not zero.
- The round purchase-batch hard limit is 1000 and the default is 100. The UI recommendation is `max(1, min(1000, floor(salesSeconds / 6)))`; it is not a concurrency guarantee. Refund ABI can verify 13 proofs, while current local mass measurement chooses a 2-batch standard-relay prefix per refund transaction.
- The current artifact rejects sponsor inputs; refund fees are deducted from selected ticket payments and the 1 KAS minimum is mass-gated for liveness.
- Target-block miners retain the documented economic withholding ability inherent in block-hash randomness.
- A successful finalize VM fixture remains unavailable because the local debugger lacks a selected-chain commitment fixture. Public closeEmpty has positive and negative VM coverage.
