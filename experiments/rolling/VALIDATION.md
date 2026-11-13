# 分片原型验证记录

本文件记录 `experiments/rolling/` 的验证事实，按证据层分开写，不把离线脚本引擎、JS 单测与共识/acceptance 混称“全验证”。落点依据用户2026-11-13的指示：放在本实验目录。候选 Profile 仍为 **`UNVALIDATED`**。

- 候选 Profile ID：`b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`
- 编译器：`silverc` 1.0.1（`silverscript-lang`，提交 `a17db2c7c95cf9f12f8e1264b21f32a8552af8df`），见 [toolchain.json](toolchain.json)
- 脚本引擎：`kaspa-txscript` / `kaspa-consensus-core` 2.1.0（crates.io，版本由 [vm/Cargo.lock](vm/Cargo.lock) 固定）
- 执行日期：2026-11-13；环境：本机离线，无节点、网络、密钥或签名

## 1. 证据层与状态

| 层 | 内容 | 状态 |
|---|---|---|
| 编译 | 五模板由固定 `silverc` 从零编译，产物字节可复现（`compile.mjs`） | 已完成 |
| 体积/mass 报价 | `measure.mjs`，资金输入与全部输入预算按0，仅为下界 | 已完成（下界） |
| JS 离线单测 | `state/transactions/archive.test.mjs` 共23项 | **23/23 通过**（见 §2） |
| 脚本引擎 + 协变上下文 | `vm-run.mjs`：48基线 + 3,268单点变异 | **全部符合预期**（见 §3） |
| 实测预算与受限执行 | `vm-budgets.mjs`：实测预算重建，按提交上限执行，预算−1必须失败 | **通过**（见 §4） |
| 共识规则 | 成熟度/DAA、mass上限的节点强制、双花、入池策略 | **NOT_RUN** |
| 资金输入签名 | P2PK验签从未执行；其预算为推算值 | **NOT_RUN** |
| 节点/acceptance/网络 | 任何节点、Testnet、主网实验 | **NOT_RUN** |
| 归档持久化深度检查 | 冷备份恢复、崩溃重放、多进程竞争、节点裁剪（`archive.test.mjs` 只覆盖 §2 所列4项） | **NOT_RUN** |
| Indexer/HTTP/节点适配器 | `indexer.mjs`、`http.mjs`、`node-adapter.mjs` | **NOT_RUN** |

## 2. JS 离线单测

命令（工作目录 `kaswin/`）：`node --test experiments/rolling/state.test.mjs experiments/rolling/transactions.test.mjs experiments/rolling/archive.test.mjs`

Node v22.23.2；分文件结果：`state` 10/10，`transactions` 9/9，`archive` 4/4，合计23 pass、0 fail、0 skipped。

边界：
- `state.test.mjs` 只验证编解码与金额算术（59/93/63字节头、N=256、r/c、mergeTail、10M票边界等）。
- `transactions.test.mjs` 使用**人为构造的3字节假模板尾**，不含任何编译产物；只验证JS交易策略与解释器（k=1/16、终局合并、34/35/36输出、退休动作拒绝、隐藏后继/少退/截留押金被解释器拒绝）。
- `archive.test.mjs` 在临时目录做存储测试（快照CAS、接受/撤销/重新接受、中断的receipt更新、原文不可覆盖），不模拟交易接受。
- 三者都不是VM测试，也不是acceptance证据。真实脚本由 §3 另行验证。

## 3. 脚本引擎验证（`vm-run.mjs`）

范围：`kaspa-txscript` 2.1.0 引擎 + `CovenantsContext`，对每个协变输入执行脚本，调用方式与共识 `check_scripts` 相同（`from_transaction_input…`）。基线交易由真实JS构建器基于真实编译产物生成；账本、冻结片与DRAW证明为合成数据。

| 项目 | 结果 |
|---|---|
| 基线 | 48/48 通过：全部8个带协变输入的动作（创世交易没有协变输入，不在引擎中执行；BUY、CLOSE、DRAW、TIMEOUT、PAY_OLD、PAY_SELF、REFUND_OLD、REFUND_SELF），含最小/最大账本、N=0/254/255/256、冻结换片、最终合并（0/1/2条尾记录，34/35/36输出）、1–16个目标、1与8个资金输入 |
| 单点变异 | 3,268/3,268 符合预期；其中预期被拒绝3,095个全部被拒（66个被协变上下文在脚本前拒绝，其余被脚本拒绝），预期通过的173个对照全部通过 |
| 变异族 | 输出金额±1/脚本/协变绑定/数量；签名脚本全部参数（action、ownTailBytes、originTxId/Index、nextTail、data、targetSizes、dispatch tag、redeem原文）；资金输入带协变ID、第9个资金输入；target替换/换序/清除或翻转CID/冻结片参数；DRAW sequence 与链访问器；TIMEOUT sequence；CLOSE lockTime；手续费 0/1/上限/上限+1；管理片头规则（role、cap、minTickets、closeEligibleDaa、目录数、尾随字节及两个合法边界对照） |
| 逐字节翻转 | DRAW 的两个基线对240字节证明逐字节翻转、`BUY first` 对36字节data逐字节翻转，其余基线抽样；全部被拒 |

结论与事实：
- 手续费规则与合约一致：`0 < fee ≤ cap`（cap：PAY 为 1 KAS，其余 0.5 KAS）。
- 找零和执行奖励输出（`chosenPayment`）只校验金额、Schnorr P2PK形式与无协变绑定，**不钉收款key**；改付他人key通过、改成P2SH被拒。赢家、买家、创建者与管理片输出均被钉死。因此免签的 PAY_OLD/REFUND_OLD 交易在广播前，任何人都能把执行奖励地址改成自己的，这是赏金式设计的固有性质。
- 预期修订记录：最初把“找零改付他人key”预期为拒绝，核对合约源码后改为通过（见上）；首次全量运行的18个不符项全部是对空 `targetSizes` 做“丢最后一项/截断1字节”的空操作变异，已在生成器中去除。最终运行无不符项。
- 抽样而非穷举：多输出交易只变异首/中/末位输出，字节翻转取代表位置（上一行所列三个基线除外）。预期由合约源码与JS构建器推出，并非独立形式化规格。

## 4. 实测预算与受限执行（`vm-budgets.mjs`）

做法：各基线以实测最小预算重建；覆盖输入按提交预算的允许单位（`预算×10,000 + 9,999`）限额执行；再把每个有预算的覆盖输入各自减1，必须失败。

| 项目 | 结果 |
|---|---|
| 受限执行 | 48/48 通过 |
| 预算−1 | 111/111 以 `ExceededCommittedScriptUnits` 失败（阈值精确） |
| 资金输入预算 | 取11：Schnorr验签推算为10（1 sigop = 1000 gram = 100,000脚本单位，扣除每输入9,999免费单位后），另加1单位余量。**推算，未执行，非实测** |

各动作管理片输入在所测形态中的最大脚本单位与预算（不是理论上界）：

| 动作 | 单位 | 预算 | 冻结片输入单位/预算 |
|---|---:|---:|---|
| BUY | 1,115,417 | 111 | – |
| CLOSE | 1,118,202 | 111 | – |
| DRAW | 1,434,254 | 143 | – |
| TIMEOUT | 1,041,383 | 104 | – |
| PAY_OLD（k=16） | 5,058,761 | 505 | 458,770 / 45 |
| PAY_SELF | 691,455 | 69 | – |
| REFUND_OLD | 2,275,435 | 227 | 466,253 / 46 |
| REFUND_SELF | 2,332,600 | 233 | – |

消耗随账本大小变化很大（BUY：空账本约11万单位，接近满账本约111万），所以每笔交易需在引擎中试跑后再定预算；以上不是最坏情形的证明上界。

按实测预算重算的 mass（`vm-budgets.mjs`，上限 compute 500,000 / transient 1,000,000 / storage 500,000）：

| 项 | 最大值 | 占上限 | 场景 |
|---|---:|---:|---|
| compute mass | 309,423 | 61.9% | PAY_OLD k=16（p=128） |
| transient mass | 743,332 | 74.3% | PAY_OLD k=16（p=0） |
| storage mass | 400,783 | 80.2% | REFUND_OLD 终局合并，36输出 |

48个场景均未超限。与预算为0的旧报价相比，费用mass只有 `REFUND_SELF`（最大场景）由62,776升到68,038（+8%），其余场景由 transient 决定，不变。

## 5. 复现

```
node --test experiments/rolling/*.test.mjs        # §2
cargo build --release --manifest-path experiments/rolling/vm/Cargo.toml   # 建议设置 CARGO_TARGET_DIR
KASWIN_VM_BIN=<runner> node experiments/rolling/vm-run.mjs                # §3，写 artifacts/vm/report.json
KASWIN_VM_BIN=<runner> node experiments/rolling/vm-budgets.mjs            # §4，写 artifacts/vm/budget-report.json
```

`artifacts/` 被 git 忽略；报告可由上述脚本确定性重建。生成器与运行器均不创建、读取密钥，不签名、不广播。

## 6. 尚未完成

共识层与acceptance、资金输入签名与预算实测、DRAW在真实选链上的访问器、持久化恢复深度检查、Indexer与节点集成、新旧Profile分流、任何网络实验，以及把候选Profile升级为非 `UNVALIDATED` 的批准，均未开始。本文件不构成生产可用结论。
