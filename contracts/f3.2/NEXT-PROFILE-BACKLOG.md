# 下一次合约升级待办（随新 Profile 一起改）

当前 Profile `7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8` **不改**。本文件记录下一版需求，不是实现批准、已完成设计或上线证据。模板逻辑、状态布局及合约常量的修改会产生新 Profile；注册费单独调整不必改变模板，但需要客户端和 Indexer 同步。旧回执不能证明新 Profile。实施前必须完成核心架构规范要求的25问 Preflight、14项架构材料与8项 anti-pattern 审查；身份、授权、随机性、资金退出等问题未解时 **DO NOT CODE**，完成后仍须以新编译产物及 VM/TN10 证据验证。下面的收益数字只是估算。

## 用户确认的下版范围（2026-10-10，需求记录）

对应会话中的优化编号，而非本文件原有章节编号：

- **优化项1：收紧 BUY/CLOSE 等路径的 `checkFee` 循环上限**，见第1节。
- **优化项3：精简 Header 的开奖中间字段**，并核对相关临时 phase 处理，见第2、3节。
- **优化项4：清理 CLOSE / TIMEOUT_REFUND 的冗余见证参数**，见第4节。
- **优化项2（参数移入 Header 动态化）暂不做**。本轮只登记第5节的固定参数目标；不允许创建者自选这些参数，也不改变现有轮次的约定。

本次仅更新待办文档，不修改 SIL、核心库、ABI、Profile/pins、Indexer 配置或发布 HTML；下版设计及验证尚未完成。

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

依据 [`REMEDIATION-20261007.md`](../../docs/kaswin-v2/REMEDIATION-20261007.md) 第6条及 `packages/f3.2-core/src/state.ts`：V2 没有可花费的 phase 3/4，但三个阶段共用的 228B Header 在 `[48,196)` 保留了148B开奖中间字段：

| 字段 | 大小 |
|---|---:|
| anchorDaa | 8B |
| anchorTxId / anchorIndex | 32B / 4B |
| seed / counter / winnerPlusOne | 32B / 4B / 4B |
| targetHash / targetSeq | 32B / 32B |

规范 Genesis 的 OPEN、SEALED 及由票数不足直接进入的 REFUNDING 中，这段为零；SEALED 超时转退款时，`sealed.sil` 会把输入锚点 DAA 写入前8B并由后续退款批次保留，其余140B为零。原子开奖时 `drawState` / `acceptedState` 会填充临时 ledger 后付款，不产生保存这些中间结果的后继 UTXO。因此**不能把148B称为始终全零或完全未使用**。

下版目标是减少持久状态中的中间字段，而非删除随机证明或时间约束：必须保留原始封存锚点、开奖边界、随机性与 CID/输入绑定、超时退出语义。当前 SEALED 直接从 `OpTxInputDaaScore(0)` 取锚点；若改变拓扑为 SEALED 中途续接，必须另证原始锚点不会重置。超时后锚点的客户端/Indexer历史用途也须核对。

**新布局尚未冻结**：若整段148B均能安全移出，算术上为 `228 - 148 = 80B`，不是“缩短到148B”；如需保留字段，以审查后的布局为准。本版不增加动态经济参数字段。票价/限额/关闭时间、已售票数/购买数/退款游标、创建者公钥及 Header 后的36B/条购买目录不得作为此项优化删除。需同步 codec、模板状态偏移、Genesis/CID 重建、客户端和 Indexer，并做开奖/超时/跨批退款回归。

## 3. 去除 SIL 中重复的 phase 处理（2026-10-07 延后）

同上来源：`sealed.sil` 开奖路径对中间 phase 多次 set/检查，可与第 2 项一起重构，减少脚本体积和执行单元。

## 4. 未被链上约束的冗余见证参数（2026-10-07 审查记录）

7aaf 已把 `fee` 绑定为真实输入输出差，并把 refunding 末输出绑定到 `actorPk`。按当前源码核对 `actorPk`：BUY 写入购买目录（`open.sil:170`）、DRAW_AND_PAY 作为 1 TKAS 赏金收款人（`sealed.sil:245`）、REFUND 作为执行者收款人（`refunding.sil:170`），均已约束；**CLOSE（open）与 TIMEOUT_REFUND（sealed）只检查长度为 32，不参与任何输出**。这两种动作的找零由 builder 按 `actorKey` 生成，但合约不约束找零收款人，替换见证中的 `actorPk` 仍能被共识接受。当前核心解释器 `accepted.ts` 只在上述三条已约束路径使用 `actorKey`，不会因此判 STALE（F1 在 7aaf 已解决），所以这是清理项而非缺陷：下一版可删除这两条路径对 `actorPk` 的依赖（例如 ABI 拆分或固定占位），减少无意义见证字节。

## 5. 固定经济参数调整（2026-10-10 用户确认，尚未实施）

| 参数 | 当前 Profile | 下版固定值 | sompi |
|---|---:|---:|---:|
| 状态押金 `DEPOSIT` | 0.2 TKAS | **4 TKAS** | `400000000` |
| 注册费 `REGISTRATION_SOMPI` | 0.05 TKAS | **0.2 TKAS** | `20000000` |
| 每笔购买记录退款扣费 `REFUND_FEE` | 0.01 TKAS | **0.02 TKAS** | `2000000` |

- **计费单位是购买记录，不是票数或地址数**：一笔 BUY 买多张票，退款时该记录合计金额扣0.02 TKAS一次；同地址有多笔 BUY 则逐记录扣。一条记录买1张、票价1 TKAS时退0.98 TKAS；买10张则退9.98 TKAS。满32条批次的扣费池是0.64 TKAS，其中支付实际网络费，余额按已验证的执行者规则分配。
- 押金4 TKAS按有效终结路径返还创建者；不能宣传为无条件自动退回或无活性风险。须核对空轮关闭、派奖、最后一批退款的金额守恒及收款人绑定。
- 押金与退款扣费仍作为新版本的合约常量，并同步核心库的金额、CID/Genesis、重放解释及测试断言；不做 Header 动态参数。开奖赏金、时间参数和手续费上限不因本需求自动改变。
- 注册费属于普通登记输出及客户端/Indexer发现政策，不是合约网络手续费，也不是本次新增的共识常量。新 Profile 的构建器、Registry识别/角色显示、Indexer插件配置统一为0.2 TKAS；旧 Profile 仍按原0.05 TKAS规则解释，不全局覆盖旧配置。
- 此参数选择**不保证任意费率下执行者获利或秒级 acceptance**。退款额从0.99改到0.98后必须重新计算 storage mass，不能沿用旧0.99输出的手续费。需验证1/31/32条、跨批和最后一批、32/256目录、不同票价/每记录票数、赞助输入及小额执行者输出，区分扣费池、实际网络费与执行者净收益。费率120等仅作测算情景；不足以承诺打包时间。若报价超过项目上限或无经济可行退出，记录为阻断，不能静默提高扣费或挪用押金。

## 升级时一并处理

- 新 Profile 的 Indexer 插件以新增方式登记，旧 Profile 设为 retired 保留历史轮次。
- `budgetProfileId` 继续保持 `null`，直到新 Profile 的 VM 预算证据评审完成。
- 更新 `docs/kaswin-v2/` 的 Preflight、发布说明和本文件（已完成项移出或标注）。
