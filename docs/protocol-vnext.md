# Kaspa Raffle vNext frozen protocol

Status: locally integrated candidate. The vNext artifacts, hashes, buy/refund/public-empty-close VM behavior tests, transaction builders, nonce-domain Indexer paths, transaction-shape mass gates and single-file page are checked locally. A successful selected-chain `finalize` VM fixture is not currently available because the local debugger exposes no `SeqCommitAccessor` test fixture; see [development-verification-loop.md](development-verification-loop.md). This is not a Testnet/Mainnet deployment or release authorization: Testnet A–E, Mainnet small-value smoke, wallet/mobile E2E and independent audit remain required. v16 is retained only as a separately documented historical protocol.

Protocol identity: `raffle-vnext-liveness-guard-b1000`; contracts: `RaffleRoundVNext` and `RaffleRefundVNext`; domains: `KASPA_RAFFLE_BATCH_V2` and `KASPA_RAFFLE_DRAW_V2`. The round ABI includes selector 4, `topUp(int top_up_amount)`, which may increase covenant value without changing state.

The single source of versioned constants is `protocol-manifest.json`. Generated or consuming code must not redefine the app version, protocol version, contract names, metadata schema, Merkle depth, random delay, or batch domains.

## Round state and encoding

The canonical state order is: `round_nonce`, `max_tickets`, `min_tickets`, `max_batches`, `ticket_price`, `creator_pubkey`, `sales_deadline_daa`, `sold_tickets`, `sold_batches`, `ticket_root`, `frontier`, `refund_cursor`, `refund_batch_cursor`. Sompi and DAA values are unsigned integers on chain and canonical decimal strings in JSON. Ticket and batch counters are bounded safe integers in the browser.

`max_batches` defaults to 100 and has a covenant-enforced hard limit of 1000. The creator UI recommends `max(1, min(1000, floor(sales_seconds / 6)))` and updates that recommendation whenever the sales duration changes. The recommendation is advisory: a creator may choose a larger value up to 1000 after seeing the stale-state and settlement-volume warning. It is not a claim that one Round UTXO can accept concurrent purchases.

`round_nonce` is a public random 32-byte value used only for domain separation. The Merkle tree has depth 20. A zero-based purchase leaf is:

```text
SHA256("KASPA_RAFFLE_BATCH_V2" || round_nonce || owner_pubkey || uint64_le(first_ticket_id) || uint64_le(ticket_count))
```

The contract, browser, Indexer, and tests must produce identical bytes. A purchase must have positive count, remain within `max_tickets`, add exactly one batch within `max_batches`, occur before `sales_deadline_daa`, and preserve zero refund cursors. The successor covenant value increases by exactly `ticket_price * ticket_count`.

## Deterministic state machine

| Chain state | Buy | Finalize | Start refund | Close empty |
| --- | --- | --- | --- | --- |
| Before deadline, not sold out | yes | no | no | no |
| Sold out | no | yes | no | no |
| Deadline reached, sold >= minimum | no | yes | no | no |
| Deadline reached, 0 < sold < minimum | no | no | yes | no |
| Deadline reached, sold = 0 | no | no | no | public trigger, creator-only output |
| Refund cursor advanced | no | no | continue in Refund covenant | no |

Finalize and refund are mutually exclusive covenant paths. UI state never overrides this table.

## Randomness

For sold-out rounds, `base_daa` is the final purchase covenant UTXO DAA. For a deadline settlement, `base_daa = max(sales_deadline_daa, current_covenant_utxo_daa)`. Thus a covenant successor confirmed in the unavoidable upper-timelock race moves the random beacon back into the future instead of letting a buyer target an already-known deadline block. `target_boundary = base_daa + 30`. The unique valid selected-chain pair satisfies `parent.daa_score < target_boundary`, `target.daa_score >= target_boundary`, and `target.selected_parent == parent.hash`.

Kaspa consensus supplies lower timelocks but no enforceable “current DAA is below deadline” upper timelock. The browser refuses Buy and Top-up before opening a wallet signing request once the node reaches the deadline. At covenant level, Buy and Top-up require the spent covenant UTXO itself to predate the deadline; consequently at most one already-live or adversarial successor can win the deadline race, and that successor cannot repeat the action. This is a documented race boundary, not a claim of an absolute on-chain sales cutoff.

```text
seed = SHA256("KASPA_RAFFLE_DRAW_V2" || round_nonce || ticket_root || target_block_hash || OpChainblockSeqCommit(target_block_hash))
```

Winner selection reads the first seven seed bytes as uint56 little-endian and applies rejection sampling with `limit = floor(2^56 / sold_tickets) * sold_tickets`. Rejected values rehash `seed || uint64_le(counter)` up to four times; if all samples remain outside the unbiased interval, the fourth value is reduced modulo `sold_tickets`. The bounded fallback introduces a calculable but vanishingly small tail bias and guarantees every valid seed can settle. The covenant must rehash both headers, validate the selected parent and DAA crossing, obtain the chain sequencing commitment, recalculate the seed and winner, validate the winning range proof, and enforce exact outputs.

The target miner can theoretically withhold a valid block at the cost of its reward. This economic boundary is not described as bias-free miner behavior. RPC, History, and Indexer data are hints and must be revalidated through wRPC and the covenant.

## Amount conservation and fees

Let `principal = ticket_price * sold_tickets`. The vNext economic policy permits up to 100 purchase batches. Refund network fees are deducted from the selected purchase payments, never charged to the caller wallet.

The minimum ticket price is 100,000,000 sompi (1 KAS). The transition fee cap and each refund-transaction fee cap are both 20,000,000 sompi. At both caps a one-ticket refund still pays 60,000,000 sompi to its owner and remains relay-standard in the compiled-script mass gate. The refund cap is more than twice the current measured 9,969,500-sompi worst case, but prevents a permissionless trigger from burning the former 60,000,000-sompi allowance as an unnecessary miner fee. Every Round and Refund path also enforces `ticket_price * max_tickets <= 4611686018427387904 sompi` (or the equivalent sold-ticket bound), keeping all principal multiplication inside a conservative signed-64-bit envelope. The default/minimum carrier is 57,300,000 sompi (0.573 KAS) for finalize and empty-close relay margin. Because anyone can construct Genesis outside the official UI, both the Round `buy` entrypoint and the browser require `covenant value - sold principal >= 57,300,000` before accepting another purchase; a one-sompi-under state is rejected before wallet signing. No per-batch refund-fee reserve is locked at creation.

`startRefund` records its exact fee as `refund_fee_debt` and, like the later refund settlement, accepts exactly one covenant input. The first `refundNext` charges that debt plus its actual network fee to its selected batches; later calls charge only their own actual fee. The fee is divided equally by selected purchase batch, with the first batch receiving any sompi remainder. Each selected batch must remain positive after its allocation. For an intermediate refund, `successor = current covenant value - refunded principal + refund_fee_debt`, and the successor must retain all remaining principal. The final transaction returns surplus carrier to the creator. Therefore `input - outputs` is exactly the current transaction fee while the transition fee is recovered once from ticket payments.

`refundNext` requires exactly one covenant input. Sponsor inputs are not accepted by this artifact. Grouping can reduce a small batch's allocated fee, but it does not change the caller's wallet cost of 0 KAS.

Fee estimates are based on the full transaction shape and expose computed minimum, configured fee, covenant maximum, refundable carrier, and permanent cost. A node-required fee retry applies only to an identified fee rejection and requires renewed user confirmation whenever wallet inputs are signed.

Create and Registry each select direct wallet inputs and converge static and normalized transient mass before their single wallet request. Buy combines the covenant and all selected P2PK wallet inputs into one transaction, converges before its one wallet request, and stops for fresh review instead of silently re-signing if the node fee floor changes afterward. Top-up retains its wallet-locked two-step recovery envelope. The default Registry policy is identical on Mainnet and Testnet: a relay-safe 20,000,000-sompi marker is followed by a public 19,000,000-sompi return, leaving a 1,000,000-sompi (0.01 KAS) non-refundable Registry cost; wallet network fees are separate. A standalone 0.01 KAS Registry output is not used because its transaction shape exceeds the current standard storage-mass limit. These are local current-policy measurements, not a guarantee against a future relay-policy change.

## Metadata and compatibility

Metadata schema 2 separates `createdByAppVersion`, `protocolVersion`, and `metadataSchema`. Big integers are canonical decimal strings. Artifact hashes are mandatory for deployable metadata. Unknown schemas are rejected rather than guessed. A spend requires the declared protocol, Round/Refund status, immutable script template and every state field to match the exact current compiled artifact. Published archived protocols may point to their matching release; unpublished unsafe vNext candidates are explicitly quarantined and never silently interpreted as current vNext.

The artifact status is compiled only when both manifest hashes equal the SHA-256 of compiled redeem-script bytes. Local integration and compilation are not deployment authorization: vNext network creation and broadcast remain prohibited until the Phase 7 Testnet gate, Mainnet smoke, wallet/device E2E and independent audit are recorded.

## Trust and recovery boundaries

Registry marker return is a separate recoverable state. If Registry publication succeeded but the 0.19 KAS return was interrupted, recovery first finds the unique accepted spender of the exact marker outpoint. It accepts an existing return only when that spender has one 0.19 KAS output to the covenant-committed creator address; it re-submits the fixed public return only while the marker remains unspent, and refuses blind retry when History is unavailable or ambiguous.

The creator cannot change sold-round parameters, withdraw principal, select the target block/winner, force refund after reaching the minimum, or force finalize below it. Buyers cannot underpay, alter owner/range/root or exceed limits; before append, Buy recomputes the padded root from the committed frontier and rejects negative or inconsistent ticket/batch topology, so a permissionless malformed Genesis cannot rewrite old ownership on the next purchase. The input-DAA rule bounds the documented deadline race to one successor. Settlement triggers cannot add inputs or outputs, redirect carrier, skip/repeat refunds, or exceed fee caps. `closeEmpty` is deliberately public so creator absence cannot strand an empty carrier, while the covenant fixes its sole output to the committed creator public key. Top-up is available only before the deadline and while `sold_tickets < min_tickets`; it also revalidates ticket topology and root/frontier before accepting funds. After the minimum is met it would move the draw boundary and is rejected.

Registry, History, Indexer, local cache, and static hosting can affect discovery or availability but not settlement validity. The latest covenant cursor outranks all cached sources. Reorg invalidates cached witnesses and requires rebuilding from the unchanged boundary. A stale buy reloads the cursor and requires the user to review and sign again. Create, Registry and Buy use direct wallet inputs and do not leave preliminary funding transactions; their errors identify the stage and preserve any locally deterministic candidate txid. Generic node rejection remains possible and is classified as parent propagation, stale/double-spent input, changed fee floor, selected-chain/reorg, already-known transaction, or unknown policy failure. Every submission uses `allowOrphan = false`. Registry publication waits for enough wallet inputs with a positive confirmation DAA before opening its one signing request; automatic marker return likewise waits for the marker to be confirmed. If publication is interrupted, the saved round exposes a separate recovery action that first queries read-only Registry history and refuses to sign when duplicate status cannot be checked. A stale Buy performs a read-only history refresh, while any replacement still requires a new preview and wallet approval. Top-up and retained compatibility paths keep temporary funding P2PK-locked to the initiating wallet, never `OP_TRUE`, and recheck the staging outpoint before advising retry. A successful Genesis cursor is cached before Registry publication, marker settlement, delay, or balance refresh, so those secondary failures cannot erase the user's recovery entry. The single Round UTXO serializes buys and is not advertised as high-concurrency or one-million-independent-buyer capacity.
