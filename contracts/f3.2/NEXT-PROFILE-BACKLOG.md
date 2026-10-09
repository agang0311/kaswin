# 下一次合约升级待办（随新 Profile 一起改）

当前 Profile `7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8` **不改**。以下事项单独做都会改变模板哈希，产生新 Profile，需要同步更新 Indexer 插件、发布 HTML、预算证据，旧回执也不能证明新 Profile；因此只在下一次因其它原因升级合约时合并实施。每项实施前仍须按核心架构规范完成 Preflight，并以新编译产物和 VM/TN10 证据重新确认，下面的数字只是估算。

## 1. 收紧 `checkFee` 的输出循环展开上限（2026-10-09 记录）

**现状**：三个合约的 `checkFee` 都用 `for (fi, 0, tx.inputs.length, 9)` 与 `for (fo, 0, tx.outputs.length, 34)`，入口另有 `require(tx.outputs.length >= 1 && tx.outputs.length <= 34)`。SilverScript v1.0.0 按上限完整展开循环（`docs/TUTORIAL.md` For Loops），与实际输入输出数无关。`206d4ec7 → 7aaf76fe` 每个合约约增大 2.5 KB（open 3224→5764、sealed 3937→6479、refunding 7229→9880 字节），对应 `OpTxInputAmount` +9、`OpTxOutputAmount` +34 份展开。

**各合约实际最多输出**（`packages/f3.2-core/src/protocol.ts` 与 SIL 支付布局）：

| 合约 | 动作与输出 | 最多 |
|---|---|---|
| open | BUY：状态 + 找零；CLOSE：状态或押金 + 找零 | 2 |
| sealed | DRAW_AND_PAY：奖金/押金/赏金固定 3；TIMEOUT_REFUND：状态 + 找零 | 3 |
| refunding | 32 买家 + 押金或后继 + 执行者 | 34（保持） |

**建议**：open 与 sealed 的输出上限从 34 改为 3（入口 `require` 同步），refunding 不变。输入上限 9（状态 + builder 允许的最多 8 个资金输入）可一并评估是否减少，并与 `builders.ts` 的 `integer(funds.length,0,8)` 保持一致。

**预期收益（估算，未编译）**：open、sealed 各减少约 1.7–1.8 KB（31 份 × 约 59 字节）。花费合约时整段脚本进入输入 0 的签名脚本；BUY/CLOSE 的手续费由 transient mass（每交易字节 2 gram）决定。以 100 sompi/gram 计，每笔约少 0.0035 TKAS。按现有 367 笔 open/sealed TN10 回执按原费率重算：BUY 平均省 17%，全部合计约省 1.27/7.63 TKAS（约 17%）；满 256 笔购买的轮次约省 0.9 TKAS。refunding 不受益。

**须验证**：重新编译确认实际字节数；VM 正负例覆盖输出数 = 上限、上限 + 1，以及 DRAW 恰好 3 个输出；mass/fee 报价与 `actionBudget` 重新校准。

## 2. 精简 228B Header 中的开奖中间字段（2026-10-07 延后）

`REMEDIATION-20261007.md` 第 6 条：V2 已不存在可花费的 phase 3/4，但 Header 48..196 仍保留 148 字节中间结算字段，live 状态下大多为零，只在原子开奖时用于构造临时 ledger。可评估缩短 Header（影响 ledger 编码、Indexer 解码与全部模板）。

## 3. 去除 SIL 中重复的 phase 处理（2026-10-07 延后）

同上来源：`sealed.sil` 开奖路径对中间 phase 多次 set/检查，可与第 2 项一起重构，减少脚本体积和执行单元。

## 4. 未被链上约束的冗余见证参数（2026-10-07 审查记录）

7aaf 已把 `fee` 绑定为真实输入输出差，并把 refunding 末输出绑定到 `actorPk`。按当前源码核对 `actorPk`：BUY 写入购买目录（`open.sil:170`）、DRAW_AND_PAY 作为 1 TKAS 赏金收款人（`sealed.sil:245`）、REFUND 作为执行者收款人（`refunding.sil:170`），均已约束；**CLOSE（open）与 TIMEOUT_REFUND（sealed）只检查长度为 32，不参与任何输出**。这两种动作的找零由 builder 按 `actorKey` 生成，但合约不约束找零收款人，替换见证中的 `actorPk` 仍能被共识接受。当前核心解释器 `accepted.ts` 只在上述三条已约束路径使用 `actorKey`，不会因此判 STALE（F1 在 7aaf 已解决），所以这是清理项而非缺陷：下一版可删除这两条路径对 `actorPk` 的依赖（例如 ABI 拆分或固定占位），减少无意义见证字节。

## 升级时一并处理

- 新 Profile 的 Indexer 插件以新增方式登记，旧 Profile 设为 retired 保留历史轮次。
- `budgetProfileId` 继续保持 `null`，直到新 Profile 的 VM 预算证据评审完成。
- 更新 `docs/kaswin-v2/` 的 Preflight、发布说明和本文件（已完成项移出或标注）。
