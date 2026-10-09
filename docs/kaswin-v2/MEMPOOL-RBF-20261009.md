# 提交后的内存池状态与手续费替换（RBF，2026-10-09）

范围：网页脚本、模拟节点与测试。不改 SIL、Profile、核心库（builders/protocol 原样复用）、预算 pin 或 SDK；本轮没有真实签名或广播。

## 依据（一手源码）

TN10 默认节点 `wss://tn10.kaspay.top/wrpc` 报告 `serverVersion 2.1.0`，对照 `references/rusty-kaspa-v2.1.0`（tag v2.1.0，`01b532e8b553523216471682649693af92f0fd16`）：

- `submitTransaction`：`flow_context.rs` `submit_rpc_transaction` 使用 `RbfPolicy::Forbidden`，与内存池中任何交易双花即拒绝（`output … already spent by transaction … in the mempool`）。
- `submitTransactionReplacement`：`submit_rpc_transaction_replacement` 使用 `RbfPolicy::Mandatory`：内存池中必须恰好有一笔冲突交易（否则 `replace by fee found no double spending transaction in the mempool` / `more than one`），且新交易费率严格高于原交易（`replace_by_fee.rs` `validate_double_spending_transaction`：`transaction_feerate > double_spend_feerate`）。成功返回 `{transactionId, replacedTransaction}`。wRPC 路由（`rpc/wrpc/server/src/router.rs`）包含该方法；已对线上节点用空交易探测，得到上述 RBF 错误，确认可达（没有任何交易被广播）。
- 比较的费率是 fee / max(compute, normalized transient, storage)（`frontier/feerate_key.rs` 与 `calculated_feerate`，v2.1.0 与 cfafeb4 一致）。
- `getMempoolEntry`：交易不在交易池时返回 `Transaction … not found`；返回的 `RpcMempoolEntry` 含 `fee`、`transaction`、`isOrphan`。

## 状态标识

| 状态 | 含义 | 输入占用 |
|---|---|---|
| 已提交 | 节点收到，尚未核对 | 保留 |
| **内存池中**（PENDING） | 节点内存池中有这笔交易，未被接受；显示内存池费用和核对时间 | 保留 |
| 已接受 | 节点选中链接受，且字段与批准内容一致（不变） | — |
| **已被替换**（REPLACED） | 已提交更高费用的替换交易；原交易在替换被接受前仍可能先被接受，继续核对 | 保留 |
| **未生效 · 已被替代**（SUPERSEDED） | 同组另一笔已被节点核验接受；这笔花费相同输入，不可能再生效 | 释放 |
| 结果未知 | 选中链和内存池都没找到；不代表失败，不重发（不变） | 保留 |

提交后的自动核对从 8 次（约 1 分钟）延长到 20 次（约 10 分钟，间隔上限 60 秒），只查询不重发；记录对话框随之更新，卡在内存池里时可直接看到“内存池中”和加速按钮。
节点明确说“already accepted / already in the mempool / already in the orphan pool”时不再误记为“被拒绝”。

## 加速（RBF）

`Engine.planReplacement(txid)`：

1. 仅限本浏览器自己的、尚未确认且未被替换过的记录；必须使用提交时的同一钱包账户。
2. 向节点确认原交易仍在内存池中，且内存池费用等于本机记录的费用；所有输入在 UTXO 集中仍未花费。
3. 用原记录里已保存的输入、见证中的账本原像（`decodeSpend`）重新调用同一个核心构建器，状态变化完全相同；只改费用。费用来源和原来一样：购买/封盘/超时退款从钱包找零扣；退款批从执行者份额扣（不足时用原赞助输入）；开奖派奖从奖金扣（合约绑定费用见证）；创建轮次从找零扣，Covenant ID 不变。
4. 新费用 ≥ 原费用 × 1.1，且排序费率严格高于原交易；仍按节点当前费率报价，0.5 TKAS 上限不变。
5. 签名、二次核对输入、意图持久化、单次提交走原有 `execute()` 路径，提交改用 `submitTransactionReplacement`。
6. 输入占用：替换记录只能花费与原记录完全相同的输出点，在同一个原子写入中检查；同组之外的任何重叠仍拒绝。替换成功后原记录标为“已被替换”，被拒绝的替换不改变原记录。
7. 同组任一笔被节点核验接受后，其余标为“未生效 · 已被替代”并释放占用；替换后若原交易先被打包，替换交易同样被标为已替代。

## 验证（S/L，模拟节点）

模拟节点新增可选内存池模型，按 v2.1.0 规则实现 Forbidden / Mandatory、恰好一笔冲突和严格费率比较。

| 项目 | 结果与限度 |
|---|---|
| 应用单测 | 80 PASS、1 TODO、0 FAIL；新增 `rbf.test.mjs` 5 项：内存池中≠已接受；购买加速（同输入、同账本、只找零减少费用差额、严格更高费率）；替换打包后原交易标为已替代并释放占用；原交易先打包时替换交易被标为已替代；拒绝不在内存池/换钱包/节点拒绝费率不足（原记录不变）；开奖派奖加速（同中奖票，费用差额从奖金扣）；创建轮次加速 Covenant ID 不变 |
| 浏览器 E2E（模拟节点/钱包） | 中英文：第 1 笔购买卡在内存池 → 页面显示“内存池中”而非已接受 → 点加速 → 确认框说明替换 → 模拟节点内存池中原交易被替换 → 打包后显示已接受；“我的”页原交易显示“未生效 · 已被替代”。各 8 次提交、7 笔接受 |
| UI / 公共审计 / 历史回执 | `test:ui` 通过；audit 10 套通过；377 回执通过 |
| 内部测试站 | `check-deployed` 通过（只读） |

未验证：真实 TN10 内存池中的替换（需要真实签名广播）、真实 KasWare。模拟内存池不是节点实现，替换在真实网络中的传播与被其他节点接受的时间未观察。
