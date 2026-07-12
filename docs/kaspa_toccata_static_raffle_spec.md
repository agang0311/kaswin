# Kaspa Toccata Static Raffle dApp Spec

> **Historical design document.** This file is the original product specification and includes flows that were later replaced, including separate Ticket covenants, creator reveal, and manual Close. For the current v3.4 implementation, use [technical-guide.zh-CN.md](technical-guide.zh-CN.md). For end-user instructions, use [user-guide.zh-CN.md](user-guide.zh-CN.md).

## 1. Project Goal

Build a single-page static web app for a Kaspa Toccata raffle game.

The app must not require any backend server controlled by the project. Users should be able to open the static webpage, configure a Kaspa node RPC address, connect directly to that node from the browser, and perform all raffle actions locally.

Working name: **Kaspa Raffle Static V0**

Core idea:

> A static webpage connects to a user-provided Kaspa wRPC node, locally constructs and broadcasts Toccata covenant transactions, and reconstructs all raffle state from on-chain data.

---

## 2. Non-Goals for V0

Do not implement the following in V0:

- Backend API server
- Centralized indexer
- Admin server
- Database
- Account system
- Multi-prize raffle
- Referral system
- Leaderboard
- NFT ticket trading
- Production mainnet support
- Complex ZK randomness verification
- High-concurrency large-scale lottery
- Custodial wallet

V0 should prioritize correctness, simplicity, and testnet usability.

---

## 3. Target Environment

### Frontend

- Static single-page app
- Can be built with React, Vite, Next static export, or plain TypeScript
- Final output should be static files only

Example deployment targets:

- GitHub Pages
- IPFS
- Arweave
- Static Nginx directory
- Local static file server

### Kaspa Connection

The user must be able to enter a Kaspa node address manually.

Example input:

```text
wss://node.example.com:PORT
ws://127.0.0.1:PORT
```

Important browser limitation:

- The browser cannot connect to arbitrary raw TCP RPC.
- The node must expose browser-compatible wRPC over WebSocket.
- HTTPS-hosted pages should normally connect to `wss://` endpoints.
- Local development may use `ws://127.0.0.1:PORT`.

---

## 4. Recommended V0 Scope

V0 should support:

- Testnet only
- Static webpage
- User-configured Kaspa wRPC node
- Browser-side wallet for testnet/small funds
- Create raffle round
- Load existing raffle round by round metadata
- Buy ticket
- Scan/reconstruct round state from chain
- Commit-reveal randomness
- Close round
- Finalize raffle
- Pay winner directly in finalize transaction
- Refund if round fails or creator does not reveal
- Export/import round metadata JSON

V0 should clearly warn users not to import their main wallet seed into the app.

---

## 5. Product UX

The app should be one page with these sections.

### 5.1 Node Panel

Fields/actions:

- RPC URL input
- Connect button
- Disconnect button
- Network display
- Sync status display
- DAA score display if available
- RPC latency display if easy to implement

Example status:

```text
Connected: yes
Network: testnet-XX
Node: wss://...
Sync status: synced / syncing / unknown
```

### 5.2 Wallet Panel

For V0, implement a browser-local test wallet.

Actions:

- Generate new wallet
- Import mnemonic/private key for testnet only
- Show receiving address
- Show balance
- Refresh balance

Security warning:

```text
Do not import your main wallet seed. This page is intended for testnet or small dedicated wallets only. Private keys remain in this browser, but a malicious or modified webpage can still steal them.
```

Future version can add external wallet signing.

### 5.3 Create Round Panel

Inputs:

- Ticket price
- Max tickets
- Min tickets
- Optional fee basis points
- Randomness mode: `commit-reveal`
- Creator secret generation button

Outputs:

- Round ID
- Creator commit hash
- Create transaction ID
- Round metadata JSON
- Shareable link or JSON blob

### 5.4 Load Round Panel

Inputs:

- Round metadata JSON
- Or query params from share link

Required metadata:

```json
{
  "app": "kaspa-raffle-static",
  "version": "0.1.0",
  "network": "testnet",
  "roundId": "...",
  "createTxId": "...",
  "startBlockHash": "...",
  "ticketPrice": "...",
  "maxTickets": 100,
  "minTickets": 10,
  "creatorCommitment": "...",
  "contractVersion": "raffle-v0"
}
```

### 5.5 Round Status Panel

Display:

- Round ID
- Round status: Open / Closed / Finalized / Refunding
- Ticket price
- Sold tickets
- Max tickets
- Min tickets
- Pot amount
- Creator commitment
- Ticket list
- User's tickets
- Finalized winner if available
- Verification details

### 5.6 Buy Ticket Panel

Actions:

- Generate buyer secret
- Show buyer commitment
- Buy ticket
- Save buyer secret locally
- Export buyer secret backup

On success display:

- Ticket ID
- Ticket transaction ID
- Ticket owner address
- Buyer commitment

### 5.7 Finalize / Refund Panel

Actions:

- Close round if conditions are met
- Reveal creator secret
- Reveal buyer secrets if needed
- Compute random seed
- Compute winning ticket ID
- Build finalize transaction
- Broadcast finalize transaction
- Refund ticket if round failed

The app should make it clear that finalization should be callable by anyone, not only the creator.

---

## 6. Chain State Model

The exact Toccata/Silverscript syntax can be adjusted during implementation. The following is the intended logical model.

### 6.1 Round State

```ts
interface RoundState {
  appId: "KASPA_RAFFLE_ROUND_V1";
  roundId: string;
  creator: string;
  ticketPrice: bigint;
  maxTickets: number;
  minTickets: number;
  soldTickets: number;
  potAmount: bigint;
  feeBps: number;
  status: "Open" | "Closed" | "Finalized" | "Refunding";
  randomnessMode: "commit-reveal";
  creatorCommitment: string;
  ticketRoot: string;
}
```

### 6.2 Ticket State

```ts
interface TicketState {
  appId: "KASPA_RAFFLE_TICKET_V1";
  roundId: string;
  ticketId: number;
  owner: string;
  paidAmount: bigint;
  buyerCommitment: string;
  ticketTxId: string;
}
```

### 6.3 Finalize State

```ts
interface FinalizeState {
  appId: "KASPA_RAFFLE_FINAL_V1";
  roundId: string;
  randomSeed: string;
  winnerTicketId: number;
  winnerAddress: string;
  payoutTxId: string;
}
```

---

## 7. Covenant Components

Implement these covenant templates or logical contract modules.

### 7.1 Round Factory / Create Round

Responsibilities:

- Create a new raffle round.
- Validate static parameters.
- Store immutable round settings.

Validation rules:

```text
ticketPrice > 0
maxTickets >= minTickets
minTickets > 0
feeBps <= allowed maximum
creatorCommitment != 0
status == Open
```

### 7.2 Buy Ticket

Responsibilities:

- Allow a user to buy one ticket.
- Update round state or ticket batch state.
- Create a Ticket UTXO.

V0 can use a simple single-round UTXO design, even though this limits concurrency.

Validation rules:

```text
round.status == Open
round.soldTickets < round.maxTickets
paidAmount == round.ticketPrice
newTicket.ticketId == oldRound.soldTickets
newTicket.owner == buyer address
newTicket.roundId == round.roundId
newTicket.paidAmount == round.ticketPrice
newRound.soldTickets == oldRound.soldTickets + 1
newRound.potAmount == oldRound.potAmount + round.ticketPrice
```

Concurrency note:

- A single Round UTXO may cause contention if many users buy tickets at the same time.
- This is acceptable for V0 testnet.
- V1 should introduce TicketBatch UTXOs.

### 7.3 Close Round

Responsibilities:

- Move round from Open to Closed.

Allowed close conditions for V0:

```text
soldTickets == maxTickets
OR creator manually closes after soldTickets >= minTickets
```

If time-based closing is hard with the current covenant tooling, omit it from V0.

### 7.4 Finalize Round

Responsibilities:

- Verify randomness input.
- Compute winning ticket.
- Pay winner.
- Mark round finalized.

Commit-reveal algorithm:

```text
seed = HASH(roundId || ticketRoot || creatorSecret || optionalBuyerSecrets)
winnerTicketId = seed_as_uint % soldTickets
```

Validation rules:

```text
round.status == Closed
soldTickets >= minTickets
HASH(creatorSecret) == creatorCommitment
winnerTicketId == HASH(...) % soldTickets
winnerAddress == ticket[winnerTicketId].owner
payout output goes to winnerAddress
finalized marker is created
round cannot be finalized twice
```

For V0, if buyer secrets are difficult to collect reliably, use creator secret only and rely on refund fallback if creator refuses to reveal.

### 7.5 Refund

Responsibilities:

- Allow ticket owner to recover funds if raffle fails.

Refund conditions:

```text
round.status == Refunding
OR soldTickets < minTickets after close
OR creator failed to reveal by defined fallback condition
```

Validation rules:

```text
only ticket owner can refund
refund amount == ticket paidAmount
each ticket can be refunded only once
finalized rounds cannot be refunded
```

---

## 8. Randomness Design for V0

Use commit-reveal.

### 8.1 Round Creation

Browser generates:

```ts
creatorSecret = randomBytes(32)
creatorCommitment = HASH(creatorSecret)
```

Store `creatorCommitment` on chain.

The creator must save `creatorSecret` locally and export it in round metadata backup.

### 8.2 Optional Buyer Commitments

When buying a ticket:

```ts
buyerSecret = randomBytes(32)
buyerCommitment = HASH(buyerSecret)
```

Store `buyerCommitment` in the Ticket UTXO.

For V0, buyer reveals can be optional. The simplest version can use creator reveal only.

### 8.3 Final Seed

Minimum V0:

```text
seed = HASH(roundId || ticketRoot || creatorSecret)
winnerTicketId = seed % soldTickets
```

Better V0.1:

```text
seed = HASH(roundId || ticketRoot || creatorSecret || sortedRevealedBuyerSecrets)
winnerTicketId = seed % soldTickets
```

### 8.4 Known Weakness

Commit-reveal has a selective abort risk. The creator may refuse to reveal if they dislike the result.

Mitigation for V0:

- If creator does not reveal, the round enters refund mode.
- No one should lose funds due to missing reveal.
- Display this trust model clearly in the UI.

---

## 9. Browser-Side Chain Scanner

Without backend indexer, the browser must reconstruct state from chain data.

### 9.1 Inputs

The scanner needs:

- RPC connection
- Round metadata
- `roundId`
- `createTxId`
- `startBlockHash` or equivalent checkpoint if available

### 9.2 Responsibilities

- Find accepted transactions related to the round.
- Filter by app ID and round ID.
- Rebuild round state.
- Rebuild ticket list.
- Detect finalized marker.
- Detect refunds.
- Subscribe to live chain changes while page is open.
- Handle reorgs as safely as practical.

### 9.3 State Reconstruction

Pseudo-flow:

```ts
async function loadRound(metadata) {
  connectRpc(metadata.nodeUrl);
  const checkpoint = metadata.startBlockHash || metadata.createTxId;
  const events = await scanAcceptedTransactions(checkpoint, metadata.roundId);
  const state = reduceRaffleEvents(events);
  subscribeLiveUpdates(metadata.roundId, state);
  return state;
}
```

### 9.4 Performance Constraint

Do not require scanning the whole chain.

The share metadata should include a useful starting point, such as:

```json
{
  "createTxId": "...",
  "startBlockHash": "...",
  "createdAtDaaScore": "..."
}
```

If no checkpoint exists, warn the user that scanning may be slow or unsupported.

---

## 10. Suggested Frontend Code Structure

```text
src/
  app/
    App.tsx
    routes.ts
  kaspa/
    rpc.ts
    wallet.ts
    tx-builder.ts
    scanner.ts
    network.ts
  contracts/
    round.ts
    ticket.ts
    finalize.ts
    refund.ts
    compiled/
      round.json
      ticket.json
      finalize.json
      refund.json
  raffle/
    types.ts
    state.ts
    randomness.ts
    verify.ts
    metadata.ts
  ui/
    NodePanel.tsx
    WalletPanel.tsx
    CreateRoundPanel.tsx
    LoadRoundPanel.tsx
    RoundStatusPanel.tsx
    BuyTicketPanel.tsx
    FinalizePanel.tsx
    VerifyPanel.tsx
```

---

## 11. Main Types

```ts
export type RoundStatus = "Open" | "Closed" | "Finalized" | "Refunding";

export interface RaffleMetadata {
  app: "kaspa-raffle-static";
  version: string;
  network: string;
  roundId: string;
  createTxId: string;
  startBlockHash?: string;
  createdAtDaaScore?: string;
  ticketPrice: string;
  maxTickets: number;
  minTickets: number;
  creatorCommitment: string;
  contractVersion: string;
}

export interface RaffleState {
  round: RoundState;
  tickets: TicketState[];
  finalized?: FinalizeState;
  myTickets: TicketState[];
  verification: VerificationResult;
}

export interface VerificationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
```

---

## 12. Transaction Flow Details

### 12.1 Create Round

```text
User inputs raffle parameters
Browser generates creator secret and commitment
Browser builds create-round transaction
User signs locally
Browser broadcasts transaction to configured node
Browser waits for acceptance
Browser outputs round metadata JSON
```

### 12.2 Buy Ticket

```text
Browser loads latest round state
Browser checks status == Open
Browser generates optional buyer secret and commitment
Browser builds buy-ticket transaction
User signs locally
Browser broadcasts transaction
Browser waits for acceptance
Browser updates ticket list
```

### 12.3 Close Round

```text
Browser checks close condition
Browser builds close-round transaction
User signs locally
Browser broadcasts transaction
Browser waits for acceptance
Browser updates round status to Closed
```

### 12.4 Finalize Round

```text
Browser loads Closed round
User provides creatorSecret
Browser verifies HASH(creatorSecret) == creatorCommitment
Browser computes ticketRoot
Browser computes random seed
Browser computes winnerTicketId
Browser finds winning Ticket UTXO
Browser builds finalize transaction
Transaction pays winner directly
Browser broadcasts finalize transaction
Browser displays final result
```

### 12.5 Refund

```text
Browser detects refund condition
Ticket owner selects ticket
Browser builds refund transaction
User signs locally
Browser broadcasts transaction
Browser marks ticket as refunded after acceptance
```

---

## 13. Local Verification Rules

The UI should provide a verification panel that checks:

```text
round parameters are immutable
ticket IDs are continuous from 0 to soldTickets - 1
all tickets have matching roundId
all tickets paid exact ticketPrice
potAmount == soldTickets * ticketPrice
creatorSecret matches creatorCommitment when revealed
ticketRoot matches reconstructed ticket list
winnerTicketId == seed % soldTickets
winner payout address == winning ticket owner
finalize transaction pays correct amount
round is not finalized more than once
```

---

## 14. Safety Invariants

### Ticket Invariants

```text
No free tickets
No underpriced tickets
No duplicate ticket IDs
No ticket ID above maxTickets - 1
No ticket purchase after round closes
Ticket owner must be the buyer-selected address
```

### Pot Invariants

```text
potAmount == soldTickets * ticketPrice
payout + fee + remaining amount == potAmount
creator cannot withdraw pot before finalization
refund only returns original ticket price
```

### Finalization Invariants

```text
Only closed rounds can finalize
Only one finalization per round
Winner must be derived from committed randomness
Winner address must come from the winning ticket
Finalization must directly pay winner
```

### Refund Invariants

```text
Finalized rounds cannot refund
Only ticket owner can refund their ticket
Each ticket can refund once
Refund amount equals paidAmount
```

---

## 15. Error Handling

Handle these cases clearly:

- Cannot connect to node
- Node is not synced
- Wrong network
- RPC endpoint is not browser-compatible
- Wallet has insufficient balance
- Round metadata invalid
- Round not found
- Scanner cannot find start point
- Buy ticket transaction rejected
- Round UTXO already spent by another buyer
- Finalize transaction rejected
- Creator secret does not match commitment
- Not enough tickets sold
- Round already finalized
- Ticket already refunded

For UTXO contention during ticket purchase, show:

```text
The round state changed before your transaction was accepted. Reload the round state and try again.
```

---

## 16. Security Warnings in UI

The app should show these warnings in appropriate places:

```text
This is an experimental testnet raffle dApp.
Do not import your main wallet seed.
The app has no backend; all state is reconstructed from your configured node.
If your node is malicious or out of sync, displayed state may be wrong.
Always verify round parameters and finalization details.
Commit-reveal randomness can fail if the creator refuses to reveal. In that case, users should refund.
This app may be considered gambling or lottery software in some jurisdictions. Do not use it with real money without legal review.
```

---

## 17. Build Output

The app should build into static assets:

```text
dist/
  index.html
  assets/*.js
  assets/*.wasm
  contracts/*.json
```

No server-side runtime should be required.

---

## 18. Development Milestones

### Milestone 1: Static App Skeleton

- Build static frontend
- Node URL input
- Connect/disconnect RPC
- Show network/status
- Basic wallet generation/import
- Balance display

### Milestone 2: Round Metadata and Local State

- Define metadata format
- Create/load/export round metadata JSON
- Build local state reducer
- Mock scanner events for development

### Milestone 3: Toccata Contract Templates

- Implement Round covenant
- Implement Ticket covenant
- Implement Finalize covenant
- Implement Refund covenant
- Compile templates and include artifacts in frontend

### Milestone 4: Create and Buy Flow

- Build create round transaction
- Broadcast create round transaction
- Build buy ticket transaction
- Broadcast buy ticket transaction
- Reconstruct ticket list from chain

### Milestone 5: Close and Finalize Flow

- Close round
- Reveal creator secret
- Compute seed and winner
- Build finalize transaction
- Broadcast finalize transaction
- Display result and verification details

### Milestone 6: Refund Flow

- Detect refund condition
- Build refund transaction
- Broadcast refund transaction
- Update UI after refund

### Milestone 7: Hardening

- Reorg handling
- Better error messages
- UTXO contention retry flow
- Security warnings
- Testnet end-to-end tests

---

## 19. Acceptance Criteria

V0 is acceptable when the following testnet flow works end to end:

1. User opens static page.
2. User enters a browser-compatible Kaspa wRPC node URL.
3. Page connects successfully and shows network status.
4. User creates a local test wallet.
5. User creates a raffle round.
6. Page exports round metadata JSON.
7. Another browser session imports the round metadata.
8. User buys a ticket.
9. Page reconstructs the ticket from chain data.
10. Round creator closes the round.
11. Creator reveals secret.
12. Page computes the winner.
13. Any user can submit finalize transaction.
14. Winner receives payout directly.
15. Page displays final verification details.
16. If creator refuses to reveal, ticket owner can refund instead.

---

## 20. Future V1 Enhancements

After V0 works, consider:

- Mainnet small-value mode
- External wallet connector
- TicketBatch UTXOs for better concurrency
- drand randomness
- drand proof or oracle attestation verification
- Better checkpoint scanning
- IPFS deployment
- Ticket transfer
- Multi-prize rounds
- Jackpot rollover
- Independent audit

---

## 21. Key Design Decision

Do not build this like an EVM dApp with a backend indexer and centralized keeper.

Build it as:

```text
Static webpage
+ user-provided Kaspa wRPC node
+ browser-local transaction builder
+ Toccata covenant state
+ browser-side chain scanner
+ anyone-can-finalize design
+ refund fallback
```

The first version should be simple, testnet-first, and honest about its trust model.
