# Testnet 10 vNext validation log

## Current 0.9.13 b1000 candidate — network evidence pending

The current local candidate is `raffle-vnext-liveness-guard-b1000` with Round
artifact SHA-256
`215aaae53f9a3d71fef0cf6deb8783582a36c212cd3bb9a67bedb7a850206f3d`
and Refund artifact SHA-256
`bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2`.
It raises the covenant purchase-batch hard limit from 100 to 1000 and therefore
has a different Round bytecode identity. No accepted Testnet transaction in
this log uses that exact pair yet. All A–E Testnet gates remain pending for this
candidate; the records below are historical compatibility evidence only.

## Previous 0.9.12 exact-hash candidate — historical Chrome acceptance run (2026-07-19)

This section records transactions created by the previous `v0.9.12`
`raffle-vnext-liveness-guard` candidate. The contract identity used by every
round below is:

| Item | Value |
| --- | --- |
| Round artifact SHA-256 | `3717cec34b4860a03055f237acc501b92414eb48dd7c2bccb70d597d32dbfb86` |
| Refund artifact SHA-256 | `bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2` |
| Refund template BLAKE2b | `bfc24ab1e05e1d4ba43c9bf1db409d293013364b310a13c9bad1de3ee411d790` |
| Network / browser | Testnet 10 / Chrome |
| Trigger wallet | disconnected for public Draw, Refund and Close actions |

Four isolated local Testnet wallets were used: Creator
`kaspatest:qq2czruaz4jzznxjsyr58trc55av7vmedlu67j8vvtd6yasmk656zqqy84q5c`,
Buyer A `kaspatest:qzacuedp4rxre5pfrh78cg2m52t87w0jg0066sxzdvmxu02j6kfg5yupl6t3d`,
Buyer B `kaspatest:qrwyjsj7863zdav92xnjlrsh70d33m969z455kn063zemdr9m7drka2ag57g9`,
and Buyer C `kaspatest:qz0v27qnhssa22wxynvggf06wkmfm5lc6zzxnhszlz6mf20g77fpgrk6pug73`.
Private keys were used only inside the explicit local Testnet development
harness and are not stored in this repository or this log.

### A — sold out, restored and paid

Round `round-a243c88ad5c27b61` used 1 KAS tickets, `minTickets = 5`,
`maxTickets = 10`, `maxBatches = 3`, and a 0.573 KAS carrier.

| Step | Transaction ID | Accepted result |
| --- | --- | --- |
| Create | `e722b27f4785bf6b3c0f41d10672a2c2c74f205a34698cd3e7dd0aa72f93255a` | 10-ticket covenant created |
| Buyer A | `403b640665c26d573b3c53ffdcefa4e72a2d2dc1bdea1c84ef7d1c3b266a70b9` | tickets #1–#2 |
| Buyer B | `c79a6ebfa71ca07ca591229d2f703a5354009e80c28baa0878ca47e014e9b6bc` | tickets #3–#5 |
| Buyer C | `a6b93e682ebe8267a97a2cfa16e5b76e66b61fdd90d8bd5a35de265a06a8fd92` | tickets #6–#10; sold out |
| Draw & Pay | `564d3177937e6a48f0222eae400d0e100e4934c08f54639062e0c92788853266` | winner #4; 10 KAS to Buyer B; 0.535204 KAS carrier remainder to Creator; fee 0.037796 KAS |

The page was refreshed and the local participated-round history was loaded
before settlement. Draw & Pay required no connected wallet and the explorer
reported the final transaction accepted.

### B — minimum reached, not sold out, deadline payout

Round `round-cfcf8e4da681ddc0` used 1 KAS tickets, `minTickets = 3`,
`maxTickets = 10`, `maxBatches = 3`, a ten-minute deadline, and a 0.573 KAS
carrier.

| Step | Transaction ID | Accepted result |
| --- | --- | --- |
| Create | `cf34035e6f03367002fb6787f4136670386be91dcfec4604ab71d09823396cd6` | covenant created at DAA 520760648; deadline DAA 520766648 |
| Buyer A | `769108ab089498d4b334ba131ba7ffe9bf12bdf7c3ecce63cbedc0120ee3734e` | tickets #1–#2 |
| Buyer B | `bd4b5caf6bb6cfbdc43d863b51483825fa027cdea3210a8fc327cb53f56b56c2` | tickets #3–#4 |
| Draw & Pay | `a33fa559829e84999ee8cbeeec31caff65bac92c66a454870239d2bed33e26a7` | winner #3; 4 KAS to Buyer B; 0.534085 KAS carrier remainder to Creator; fee 0.038915 KAS |

At the deadline the page stated that 4 tickets exceeded the minimum but did
not sell out, enabled only Draw & Pay, and kept Refund disabled. With the
wallet disconnected, the public trigger spent the 4.573 KAS covenant input.
Kaspa.stream reported `accepted`, mass 38,915, exactly two outputs, no trigger
payment, and the payload committed winner ticket #3 and the 4 KAS prize.

### C — below minimum, carrier top-up and buyer-funded refunds

Round `round-bed9118add8e2c54` used 1 KAS tickets, `minTickets = 5`,
`maxTickets = 10`, `maxBatches = 3`, and a ten-minute deadline.

| Step | Transaction ID | Accepted result |
| --- | --- | --- |
| Create | `38a8bdf1c219a818f65c23d8525eb0d619f02148ad26383d146d4c72db871f5d` | 0.573 KAS initial carrier |
| Registry marker return | `de4ed1302be239193505e36d8e4b650c4eef248efa37512e6b98011619ee5909` | marker returned |
| Carrier top-up | `62bf8ed8d73b9ac81a4066bb6856e2c4902d388ba40e29161d4e469a3ed1ebd7` | carrier raised from 0.573 KAS to 0.763 KAS without changing round state |
| Buyer A | `1874a3b600fff64fb58565e320438dcd3f64afecd08fadba63af886f77ee0363` | tickets #1–#2 |
| Buyer B | `a62ae0aa6af30235cf129e2c26dd998f2fe7fb425f95745a114003f7c60f3471` | ticket #3 |
| Buyer C | `29416505d9cf7b241d0b508fa26d58f9ecd883331e1ae161e33f10a9d63a15b9` | ticket #4 |
| Start Refund | `c519f6d910f28c065bdf02db5c8f359758fcdc136fc95ae3245f3ea7a3b6ea8a` | public transition accepted; fee 0.054794 KAS |
| Final grouped refund | `a2957deeb73d95024b06d35e86c16ad58ed09cf10ed6fce4da363d4518530f05` | all three purchase batches refunded; fee 0.040474 KAS; no refund successor remained |

The total actual refund network cost was 0.095268 KAS. It was divided equally
over the three purchase batches, so Buyer A received 1.968244 KAS and Buyers B
and C each received 0.968244 KAS. The remaining 0.763 KAS carrier returned to
Creator. The disconnected caller paid and received 0 KAS. The terminal local
state reloaded as `Refunded`, with `refundCursor == soldTickets` and zero
remaining principal.

Before Buyer C's accepted purchase, two Chrome tabs prepared ticket #4 from
the same old covenant UTXO. Buyer C's transaction above advanced the state;
Buyer B's stale attempt was rejected without a broadcast, without temporary
funding, and without changing either wallet or covenant state. The current
client bounds this preflight to 15 seconds and tells the user to reload and
review the new state before signing again.

### Public empty close and service-outage behavior

Round `round-369daa68fd842714` was created in transaction
`85020f5b6b6a40704ce525305cb7f37b1a34ad23a4e0fd3c37dcf799546cecf9`.
After its deadline, a disconnected public trigger closed the empty covenant in
`3260e9fba976c95b897328ecc96cb7c2078fba9ba35180ca3ece28103568b6df`.
The accepted transaction charged 0.01955 KAS and its only value output returned
the carrier to Creator. Reload now shows the terminal status as `Closed/已关闭`
and passes local state verification without offering Draw or Refund.

Chrome also changed both REST History and Indexer URLs to an unreachable local
port. All six locally saved small rounds remained visible and loadable with
their terminal outcomes unchanged. Restoring the configured services allowed
history refresh to continue. The contract outcome never depended on either
service; the automated suite separately rejects stale checkpoint, invalid
proof and reorg-shaped index data.

### D — isolated Registry and participant-first UI fee audit

Round `round-e2c7a503d4a2ece7` used a 1 KAS ticket price, `minTickets = 1`,
`maxTickets = 1`, `maxBatches = 1`, and a 0.573 KAS carrier. This run was made
after replacing the globally shared OP_TRUE Registry with the tagged
`KASWIN_REGISTRY_V1` script address
`kaspatest:ppn3r8nagpk7f60lkafs97ctht33vn58ae593fk7y8gr9y5x3nxd67dfq0kd0`.

| Step | Transaction ID | Accepted result / exact page fee |
| --- | --- | --- |
| Create | `d375d8a87a854e905ec1a75991b1d9881c9f85cb198677b23da340a895d5ff13` | accepted; covenant-create fee 0.06 KAS; wallet funding fee 0.002036 KAS |
| Tagged Registry marker | `4a0549713980ac22fae5e80778a3c48b073f44b58f00a24b94218f9311a19390` | accepted; 0.2 KAS marker paid only to the Kaswin Registry address; combined Registry payment fee 0.007036 KAS |
| Marker return | `b7992bc738ca06248512a639c42f91bdc332236553f1fd897a301a4e368dec7b` | accepted; 0.199 KAS returned to Creator after the exact 0.001 KAS marker-refund fee |
| Buyer A ticket #1 | `c659a98e60d17d9b5b1322680295270b8b6bd1c0573a0b0bc99d8970ddb723df` | accepted; covenant buy fee 0.021 KAS; wallet funding fee 0.002036 KAS; round sold out |
| Public Draw & Pay | `da7db39806caf9c5e6394b87054cf8728fbe9ca6e374022ef985ce97a03920ba` | accepted; winner #1; 1 KAS to Buyer A; 0.535301 KAS carrier remainder to Creator; fee 0.037699 KAS |

Chrome showed the available-rounds tab first, prefixed this fresh round with
`Open to join/可参与`, displayed Buy immediately after loading, and switched
the active action to Draw & Pay automatically at sell-out. The create preview
separately labelled the exact 0.06 KAS covenant fee, exact 0.005 KAS Registry
spend fee, and two UTXO-dependent wallet funding fees. The buy preview labelled
0.021 KAS as a starting estimate, and the accepted result then displayed the
exact covenant and funding fees. Draw required no connected wallet.

Read-only TN10 REST checks reported `is_accepted = true` for all five recorded
transactions. The marker-refund input spent the exact tagged Registry marker
outpoint, and the Draw transaction had exactly two outputs: the 1 KAS prize to
Buyer A and the remaining carrier to Creator.

The transaction IDs above remain valid evidence for their recorded
0.199/0.001 policy. The following direct-input recovery run validates the
current 0.19/0.01 Registry settlement policy and the dependent-parent relay
path separately.

### D2 — current direct Create and dependent Registry recovery

The current page created a covenant in
`89307aa781df741dbbc998daef1f06893b14ff763821b4768f2ca84351303e52`
with one direct wallet transaction, a 0.06 KAS covenant creation fee and no
preliminary funding transaction. The first Registry candidate
`3a1fe86086d1144ac52e1d1e21f0bb5bdbc02a2ed1e9fe2bea438c05a73fc99c`
spent change from that just-submitted parent but reached a Resolver backend
before the parent had propagated. The backend rejected it as an orphan while
orphan storage was disallowed; read-only API checks found no accepted record
for that candidate, while the covenant Create remained accepted and
recoverable.

That candidate temporarily permitted orphan storage only when a Registry input
was proven to reference the exact just-submitted Create transaction. The
recovered current-policy lineage was:

| Step | Transaction ID | Accepted result |
| --- | --- | --- |
| Direct Registry marker | `7126d6650cb7095a7ef4d35d218f21b04aea2c2b0310028c7717546121b8eb68` | accepted; 0.20 KAS marker, direct wallet transaction fee 0.050001 KAS |
| Automatic marker return | `1bfed34aa599456d2726114c688cde86b992db46c783e59b17c49cd1eb583328` | accepted; 0.19 KAS returned after a 0.01 KAS return fee |

This establishes the current net Registry cost of 0.01 KAS and demonstrates
that a Registry publication failure does not erase or strand an already
accepted covenant. It does not turn `testnetPassed` to `true`; the full A–E
release gate and wallet/browser matrix remain separate requirements.

A later browser attempt reproduced the Resolver race: Registry candidate
`81d92b066d9f071d61d3f5a23e93e619ef94c58330281b03c42c4645bc617ef1`
was explicitly rejected as an orphan where orphan storage was disallowed. The
frequency of this failure showed that conditional orphan submission was not a
portable Resolver policy. The current worktree therefore uses
`allowOrphan = false` for every transaction, waits for confirmed wallet inputs
before the Registry signing request, waits for marker confirmation before its
automatic return, and exposes a separately reviewed recovery publication that
checks read-only Registry history before it can sign. The strict confirmed-input
path still needs a fresh accepted Testnet rerun; the rejected candidate above is
regression evidence only.

### Previous 0.9.12 candidate conclusion and remaining release gates

The previous 0.9.12 exact-hash covenant candidate has accepted Testnet evidence for sold-out
payout, deadline payout above the minimum, below-minimum multi-batch refund,
carrier top-up, public empty close, concurrent stale-buy rejection, and an
isolated tagged Registry marker with automatic return, including the current
direct-input 0.19/0.01 policy and dependent-parent recovery. No
accepted transaction exposed a way for the public trigger to redirect prize,
refund or carrier outputs.

This log does **not** turn the locally generated `testnetPassed` or
`mainnetSmokePassed` flags to `true`: the local evidence generator deliberately
does not self-certify external work. A mid-refund interruption followed by a
second browser/user continuation is covered by the deterministic integration
suite but was not repeated as a distinct 0.9.12-hash Testnet transaction
sequence. Mainnet small-value smoke, KasWare/Kastle plus mobile E2E, clean
release reproducibility and an independent security audit also remain release
blockers. These limitations do not invalidate the accepted Testnet paths above.

## Historical compatibility evidence

Status: **historical compatibility evidence only.** Every transaction below predates `raffle-vnext-liveness-guard` and its former Round/Refund artifact hashes. None of these older records passes A–E for the current `raffle-vnext-liveness-guard-b1000` candidate, and `testnetPassed` remains `false`.

## Previous-candidate rejected attempt (2026-07-19)

The first fresh `raffle-vnext-liveness-guard` Create attempt was rejected before covenant acceptance with `RpcTransactionInput.sig_op_count is inconsistent with transaction version 1`. The deterministic, unaccepted candidate transaction id was `3726486d13e0efbbc00fb36d44f3555bbd490fb7a87081f70764111b209ca76a`. A second candidate, `ddc152daec144afbcd8b3950f3a992cd0765c5ea9f6d03663a3b09a40ceb3ac0`, correctly cleared the legacy field but was rejected because a P2PK wallet input committed only the 9,999 free script units while `CHECKSIG` used 100,000. Recovery verification after both attempts showed the temporary funding output was still unspent and locked to the isolated Creator wallet; no covenant funds were stranded. The production transaction builder and mass fixtures now require every manually constructed version-1 wallet input to use `sigOpCount: 0` and the shared `P2PK_WALLET_COMPUTE_BUDGET = 10`. These rejected attempts are regression evidence only and do not count toward A–E.

After Create succeeded, Buyer A candidate `401f8a673def0777614752d4fb5ebdb426337154757e4dd9c50bd840af10169a` was rejected because the former fixed 1,750,000-sompi Buy fee was below the node's 2,062,400-sompi normalized transient-mass minimum. The original covenant stayed unspent and the Buyer A staging output stayed wallet-locked. Buy construction now counts both covenant and P2PK signature scripts, reserves a bounded wallet-owned retry envelope, converges to the node's exact fee, and refuses any requirement above `MAX_COVENANT_BUY_FEE_SOMPI`. This rejected candidate also does not count toward A–E.

The exact protocol/artifact identity was not recorded consistently for these older observations. They must never be relabelled as evidence for the current manifest. Re-run A–E with `protocol-manifest.json` hashes and record them before changing the release status.

## Read-only observed create transaction

| Field | Observed value |
| --- | --- |
| Transaction ID | `42db7c7e4757ed5a6117b0ed1129baa77cc6eae78dd92f640b4d3f28aa69823c` |
| Node/API acceptance | `accepted=true` |
| Transaction mass | `1414` |
| Covenant output | `140000000` sompi to `kaspatest:prdzf2af6v9v85zrg6tzdgd6e6ez3e08pp57qmjv9tutlv4yssx32egzgw9jq` |
| `max_tickets` / `min_tickets` | `1` / `1` |
| `max_batches` | `2` |
| Created DAA | `518955498` |
| Sales deadline DAA | `518955948` |

This was verified through a read-only Testnet API query. No wallet signing, broadcast or state-changing network operation is performed by the local validation generator.

## Chrome-operated Testnet round A — sold out and paid

On 2026-07-17, Chrome operated four dedicated local Testnet wallets funded through the official TN10 faucet. The creator configured `max_batches = 3`; Buyer A, B, and C respectively purchased 2, 3, and 5 tickets. The page was refreshed, the local participated-round history was reloaded, and the signature-free Draw & Pay action broadcast the final covenant transaction.

| Step | Transaction ID | Observed result |
| --- | --- | --- |
| Create | `26b9cc6a1c0569481d405de19ef80e1cf73121336703637f26e01e116cbf3516` | 10 tickets, `max_batches = 3`, carrier 60.2 KAS |
| Buyer A | `0e696df1b0cc56df84bb8f9899d425efa4f0e6249e1b75f46762f294df4a1fce` | tickets #1–#2 |
| Buyer B | `767c108eaf860a28899e4f0bfd7f642d6ebec649faf6a563edb4393a41331d8a` | tickets #3–#5 |
| Buyer C | `500ca34a15b837d43cf67fc26a32cd170a50e6b1946d62dec545c1ddb465313d` | tickets #6–#10; sold out at 3 batches |
| Draw & Pay | `da50d26b0e4effd2838c26e2780f659d35a0c82d4cdc4e01367b28774b1db7c9` | accepted by TN10; winner ticket #8, 3 KAS paid, 0.034537 KAS covenant fee |

The accepted final transaction’s TN10 REST record has `is_accepted: true`, mass `34537`, and spends Buyer C’s successor covenant output. It pays 300,000,000 sompi directly to the ticket-#8 owner and returns the carrier remainder to the creator. No wallet signature was needed for Draw & Pay.

## Chrome-operated Testnet empty-round close recovery

On 2026-07-17, an intentionally empty vNext round exercised the post-deadline creator recovery path. The first close submission exposed two production defects: the version-1 legacy `sig_op_count` had been set to `1`, and the local mass estimator understated the remote node's normalized transient fee by 600 sompi. Both were fixed locally, rebuilt, and the exact same live covenant UTXO was then closed successfully.

| Step | Transaction ID | Observed result |
| --- | --- | --- |
| Create empty round | `ed648cdf2f5cf71179b51f1079aa5d7893eac72bfaf40a01479c869cc1355986` | Round `round-6e22093e59b3d530`, `min_tickets = 5`, `max_tickets = 10`, 60.2 KAS carrier |
| First close attempt | not accepted | Node rejected the incompatible non-zero v1 `sig_op_count`; this triggered the implementation fix. |
| Second close attempt | not accepted | Node reported the exact required normalized transient fee, 1,323,200 sompi; this triggered fee-retry/signing logic. |
| Final close | `72b52a6768ef908104cd98a5cef6f4e81b56e39c5088269c1d616787427b7c39` | accepted close; carrier returned to creator; covenant fee `0.013232 KAS` |

This is positive historical Testnet evidence for the older signed `closeEmpty` branch, but the current public-trigger ABI and current artifact still require a new exact-hash Testnet run.

## 2026-07-17 supplement — Chrome-operated Testnet rounds B and C

The earlier B–E pending statement remains the local evidence generator's
release-safe status and is superseded for the two concrete observations below
only. It must not be read as a completed Testnet gate: C continuation, D and E
remain open.

### Round B — minimum reached, not sold out, then paid

Round `round-a692c3ac217fb65d` used a 0.3 KAS ticket price, `minTickets = 5`,
`maxTickets = 10`, and one buyer purchase batch containing six tickets. After
the deadline, the UI kept refund unavailable and Chrome broadcast the public
Draw & Pay transaction:

| Transaction ID | Result |
| --- | --- |
| `85cd267b02050af72943db6b871af114c685ce9c98360705843456a5896c9368` | accepted TN10 payout; winner ticket #4; covenant fee 0.034953 KAS |

This also exercised the REST-header transport fallback on a public wRPC node
which did not retain the required selected-chain header method. The client
rehashes the supplied headers and the covenant enforces the DAA-boundary and
selected-parent checks.

### Round C — below minimum, multi-batch full-principal refund

Round `round-e0b1bca08c5917be` used the same 0.3 KAS ticket price with three
independent one-ticket buyer batches (A, B and C), below `minTickets = 5`.
After expiry, Chrome initiated the public refund path. The initial relay-fee
rejection was safely rejected by TN10 (no state change), then the client
rebuilt using the exact normalized fee and the following accepted covenant
lineage refunded every buyer principal:

| Step | Transaction ID | Observed outputs |
| --- | --- | --- |
| Start Refund | `558b78dd34622fd3a62505ea18a3aa1ff16f65b94b0cf366784e7784be16fd56` | successor refund covenant |
| Refund batches #1–#2 | `1f2bc3b0fe4f0e4cfc49ffd5cdfc13ff4756d6ccb3af20f19ae9d32a5941acab` | 0.3 KAS to buyer A and 0.3 KAS to buyer B |
| Refund batch #3 / final | `56eac0221271f4c138f8815f8218b590859f3af176d6c0263c2441d7c6f06d9f` | 0.3 KAS to buyer C and carrier remainder to the creator |

All three REST records reported `is_accepted = true`. This establishes the
real multi-batch, full-principal refund path. It does **not** establish the
separate interruption/reload/second-user continuation requirement, nor D or E;
therefore `testnetPassed` remains `false`.

## What this establishes for the historical builds only

- A vNext create transaction with the recorded state/value was accepted by Testnet.
- The observed covenant output and create-time DAA/deadline are concrete external evidence, rather than a local construction-only fixture.
- Round A validates three independent buyer batches, sold-out state, browser refresh/history recovery, deterministic winner selection and an accepted direct payout.
- The empty-round close branch has been broadcast against Testnet, rejected safely for two diagnosed construction defects, fixed, then accepted with the node's exact relay fee.

## What remains unverified for the current candidate

These records do **not** establish any exact-hash Testnet completion scenario for `raffle-vnext-liveness-guard-b1000`. At minimum, run all of the following again:

- **B:** deadline finalization when `min_tickets < sold_tickets < max_tickets`, with refund rejection;
- **C:** below-minimum multi-batch refund, interruption, second user/browser continuation and full-principal completion;
- **D:** concurrent stale buy handling with explicit re-review/re-sign;
- **E:** Indexer/History/RPC failure and switching without outcome change.

It also does not substitute for Mainnet smoke, KasWare/Kastle or mobile E2E, static HTTPS checks, clean-environment reproducibility, or independent security audit. `testnetPassed` remains `false` until all required A–E evidence is recorded.
