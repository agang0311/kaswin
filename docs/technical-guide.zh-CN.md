# 技术指南（vNext 本地候选）

## 状态边界

当前清单 `protocol-manifest.json` 的协议为 `raffle-vnext-liveness-guard-b1000`，合约为 `RaffleRoundVNext` 和 `RaffleRefundVNext`。合约、artifact、交易层、页面与 Indexer 已在本地接通；vNext 尚未完成 Testnet/Mainnet 网络门禁，不能作为已发布网络协议描述。完整状态与证据见 [验证证据矩阵](audit-evidence-matrix.md)。

v16/v15/v14 是历史协议：页面识别其 metadata 并给出对应历史 release，不允许把它们的状态编码或费用规则当作 vNext 使用。兼容映射见 [合约兼容性](contract-compatibility.md)。

## Round、Merkle 与状态机

当前 `max_batches` 默认值为 100、covenant 硬上限为 1000。页面根据售票时长实时计算 `max(1, min(1000, floor(售票秒数 / 6)))` 作为保守建议；超过建议值但不超过 1000 时仍允许创建，同时必须提示单 Round UTXO 串行购票造成的 stale 竞争和退款交易数量风险。合约、metadata、交易层、Indexer 与 UI 必须统一接受 1000、拒绝 1001。

vNext Round 状态的规范顺序为 `round_nonce`、`max_tickets`、`min_tickets`、`max_batches`、`ticket_price`、`creator_pubkey`、`sales_deadline_daa`、`sold_tickets`、`sold_batches`、`ticket_root`、`frontier`、`refund_cursor`、`refund_batch_cursor`。`min_tickets` 和 `max_batches` 是 covenant 字段，不是仅由 UI/metadata 约束。

深度 20 的购买叶子为：

```text
SHA256("KASPA_RAFFLE_BATCH_V2" || round_nonce || owner_pubkey || uint64_le(first_ticket_id) || uint64_le(ticket_count))
```

一次购买只能追加一个正数量区间，金额精确增加 `ticket_price * ticket_count`。合约在截止、剩余票数和 `max_batches` 上拒绝无效 successor。状态转换互斥：售罄或截止且达到最低票数只能 finalize；截止且 `0 < sold_tickets < min_tickets` 只能 startRefund；到期零售出没有购票款可退，只能由任何人触发 `closeEmpty`，其唯一输出为 `carrier - close_fee` 并严格支付到状态承诺的 creator 公钥。页面状态机在到期后必须禁用 Buy，并把零售票轮次自动切到该关闭入口。

## 随机数与结算

售罄使用最终购买 covenant UTXO DAA；未售罄但达到最低票数时使用 `max(销售截止 DAA, 当前 covenant UTXO DAA)`，然后加 30。后一规则覆盖截止时最多一笔在途 successor：若它在截止后确认，随机区块也随之移到未来，攻击者不能针对已经公开的截止区块选择性购票。Round covenant 验证 target/parent 哈希、selected parent、DAA 跨越及 `OpChainblockSeqCommit`，之后计算：

```text
seed = SHA256("KASPA_RAFFLE_DRAW_V2" || round_nonce || ticket_root || target_block_hash || chain_seqcommit)
winner = bounded_rejection_then_modulo(seed, sold_tickets)
```

中奖 range proof、赢家地址、奖池金额、creator carrier 返回和费用上限都由 covenant 约束。抽样最多重哈希四次，仍未落入无偏区间时使用确定性取模兜底；这会带来可计算但极小的末端偏差，换取任何合法种子都能完成开奖。RPC/History/Indexer 给出的区块仅是候选提示，不能替换最终结果。

## 退款与费用

vNext 退款按连续购买批次执行，实际启动费和退款交易费从本次选中批次的购票款中分摊扣除。carrier 不再按潜在买家数量预留退款费。当前合约要求票价至少 1 KAS；在 0.20 KAS 启动费上限与 0.20 KAS 单笔退款费上限同时出现的最坏单票场景，owner 仍得到 0.60 KAS，且真实 compiled script 质量低于标准上限。退款费上限仍超过当前 0.099695 KAS 最坏实测值的两倍，但显著压低公开触发者恶意过付矿工费的损失边界。

Refund ABI 每笔最多接收 13 个 proof；构造器会根据实际 compute/storage mass 自动缩小批次，直到交易满足标准中继限制。`max_batches` 是整轮购买批次数上限，不是单笔退款承诺。

Create 与 Registry 各自直接选择钱包 UTXO，并在各自唯一一次钱包请求前收敛手续费；因此创建轮次合计预计 2 次钱包请求。Buy 把 covenant 输入、票款输入、successor 与安全找零合并为一笔交易，费用在唯一一次钱包请求前收敛；签名后节点若报告更高最低费，构造器停止并要求重新审阅，不会后台触发第二次签名。Mainnet 与 Testnet 默认 Registry 使用各自网络的同一域标签脚本，临时 marker 为 0.20 KAS，公开返回 0.19 KAS，Registry 净费用固定为 0.01 KAS，钱包网络费另计。质量门禁同时证明直接 0.01 KAS Registry 输出不是标准中继交易形状。

所有提交都严格使用 `allowOrphan = false`。Registry 在唯一一次钱包签名前只选择 `blockDaaScore > 0` 的已确认钱包 UTXO；自动 marker 返回也等待 marker 确认，从源头避免 Resolver 后端的父子传播竞态。若 Registry 发布中断，当前轮次会常驻显示单独的恢复按钮；恢复动作先只读查询 Registry 历史，无法确认是否重复时不会签名。错误归一化继续区分 orphan、stale/double-spend、节点费用下限、selected-chain/reorg、重复/已知交易与未知策略拒绝，并保留本地确定性交易 ID。stale Buy 只触发只读 History 刷新，替代交易必须重新审阅和签名。

## 本地验证与网络门禁

默认 Registry marker 返回也是独立恢复状态。若 Registry marker 已接受但 0.19 KAS 返回中断，页面必须先只读查询 marker 精确 outpoint 的唯一已接受 spender；只有该交易恰有一个 0.19 KAS 输出且收款地址由 Round covenant 承诺的 creator 公钥导出时，才能恢复为已完成。marker 仍未花费时才可重新触发固定收款人的公开返回；History 不可用、重复或输出不符时一律阻断，不能盲目重试。

```powershell
npm run compile:vnext
npm run verify
npm run benchmark:indexer:1m
```

当前协议为 `raffle-vnext-liveness-guard-b1000`：退款网络费从选中的购票款中扣除；`buy` 同时强制 `covenant value - sold principal >= 57,300,000 sompi`，不能因第三方绕过官方 Genesis 页面而让买家进入低 carrier 轮次。由于 Genesis 可由任意工具构造，Buy 还会从 `frontier + sold_batches` 重算 padded root，并拒绝负数、零值不成对、批次数大于票数或 root/frontier 不一致的输入状态，避免下一次真实购票改写已有票权承诺。`topUp(int top_up_amount)` 只在未到期且未达到最低票数时允许 successor covenant 增加声明的金额，强制所有状态字段不变，并在接受补充资金前再次验证 root/frontier 与票数拓扑。达到最低票数后补充会移动开奖 DAA，合约必须拒绝。只有清单中精确匹配的新 artifact 能构造支出；旧 vNext 候选不会被新退款模板或新 ABI 静默解释。该版本尚未网络发布。

本地门禁涵盖 artifact hash、实际 VM 正反例、金额/质量、nonce 域 Merkle、Indexer persistence/reorg、单文件和生产凭据扫描。它不替代 Testnet A–E、Mainnet 小额、钱包与移动端 E2E或独立审计；这些项仍是发布阻断项。
