# Development Backlog

## Milestone 1: Static App Skeleton

- [x] Create Vite + React + TypeScript project skeleton
- [x] Add one-page operations UI
- [x] Add metadata/type helper modules
- [x] Add placeholder Kaspa RPC and wallet boundaries
- [ ] Install dependencies and verify local dev server
- [ ] Connect to a browser-compatible Kaspa wRPC endpoint
- [ ] Display network, sync status, DAA score, and latency
- [ ] Generate/import a dedicated browser-local test wallet
- [ ] Display test wallet address and balance

## Milestone 2: Round Metadata and Local State

- [ ] Define final metadata schema and validation errors
- [ ] Export and import round metadata JSON
- [ ] Support share-link query parameters
- [ ] Implement local raffle event reducer
- [ ] Add mock scanner events for UI development
- [ ] Add verification panel checks for local state

## Milestone 3: Toccata Contract Templates

- [ ] Implement Round covenant template
- [ ] Implement Ticket covenant template
- [ ] Implement Finalize covenant template
- [ ] Implement Refund covenant template
- [ ] Compile artifacts into `src/contracts/compiled/`
- [ ] Add contract version metadata

## Milestone 4: Create and Buy Flow

- [ ] Build create-round transaction
- [ ] Broadcast create-round transaction
- [ ] Wait for acceptance and export metadata
- [ ] Build buy-ticket transaction
- [ ] Broadcast buy-ticket transaction
- [ ] Reconstruct ticket list from chain data
- [ ] Handle Round UTXO contention with a reload-and-retry flow

## Milestone 5: Close and Finalize Flow

- [ ] Build close-round transaction
- [ ] Verify creator reveal against commitment
- [ ] Compute ticket root
- [ ] Compute seed and winning ticket
- [ ] Build finalize transaction
- [ ] Pay winner directly in finalize transaction
- [ ] Display final verification details

## Milestone 6: Refund Flow

- [ ] Define V0 refund fallback condition
- [ ] Detect refund eligibility
- [ ] Build refund transaction
- [ ] Broadcast refund transaction
- [ ] Mark refunded tickets after acceptance

## Milestone 7: Hardening

- [ ] Reorg handling strategy
- [ ] Better scanner checkpoints
- [ ] Clearer error messages
- [ ] Security warning placement
- [ ] Testnet end-to-end test plan

