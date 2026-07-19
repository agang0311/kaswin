# Covenant contracts

## vNext local candidate

Protocol: `raffle-vnext-liveness-guard-b1000` (Kaswin 0.9.13).

- `raffle_round_vnext.sil`: `RaffleRoundVNext`，含 `round_nonce`、`min_tickets`、`max_batches` 与互斥 finalize/refund 状态机。
- `raffle_refund_vnext.sil`: `RaffleRefundVNext`，从选中的购票款中扣除实际退款网络费。
- `raffle_round_vnext.sil` 的 `topUp` 入口允许任何资金输入增加 carrier，但强制 successor covenant 的全部状态保持不变。
- `compiled/raffle-*-vnext.*.json`: 由 `npm run compile:vnext` 生成；redeem-script SHA-256 必须与 `protocol-manifest.json` 匹配。

这些 artifact 已经本地编译和集成，但不是已部署或获准广播的合约。它们仍需通过真实 Testnet、Mainnet 小额、钱包 E2E 与独立审计门禁，详见 [../../docs/audit-evidence-matrix.md](../../docs/audit-evidence-matrix.md)。

vNext Refund 的 ABI proof 上限为 13，但实测标准中继最大前缀为 2；创建者不得把 13 当作 vNext 的可执行购买批次数。

## Historical contracts

- `raffle_round_v16.sil` 与 `raffle_refund_v16.sil`: 已部署的 `raffle-v16-dynamic-refund-transition` 历史协议。
- `raffle_round_v13.sil` 与 `raffle_refund_v3.sil`: 与已部署 v16 bytecode 相同的历史命名 artifact。
- `raffle_round_v12.sil`、`raffle_round_v11.sil`、`raffle_refund_v2.sil`: 更早的归档来源。

历史合约只用于识别、验证和指向匹配 release；禁止用 vNext state layout 或金额规则解释它们。
