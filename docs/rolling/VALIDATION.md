# 分片原型验证记录

本文件记录 `experiments/rolling/` 的验证事实，按证据层分开写，不把离线脚本引擎、JS 单测与共识/acceptance 混称“全验证”。落点依据用户2026-11-13的指示：放在本实验目录。候选 Profile 仍为 **`UNVALIDATED`**。

- 候选 Profile ID：`b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`
- 编译器：`silverc` 1.0.1（`silverscript-lang`，提交 `a17db2c7c95cf9f12f8e1264b21f32a8552af8df`），见 [toolchain.json](../../contracts/toolchain.json)
- 脚本引擎：`kaspa-txscript` / `kaspa-consensus-core` 2.1.0（crates.io，版本由 [vm/Cargo.lock](../../tests/contracts/vm/Cargo.lock) 固定）
- 执行日期：2026-11-13；环境：本机离线，无节点、网络或真实密钥；资金输入仅用公开的一次性测试key签名（见 §4）

## 1. 证据层与状态

| 层 | 内容 | 状态 |
|---|---|---|
| 编译 | 五模板由固定 `silverc` 从零编译，产物字节可复现（`compile.mjs`） | 已完成 |
| 体积/mass 报价 | `measure.mjs`，资金输入与全部输入预算按0，仅为下界 | 已完成（下界） |
| JS 离线单测 | `state/transactions/archive.test.mjs` 共23项 | **23/23 通过**（见 §2） |
| 脚本引擎 + 协变上下文 | `vm-run.mjs`：48基线 + 3,268单点变异 | **全部符合预期**（见 §3） |
| 实测预算与受限执行 | `vm-budgets.mjs`：实测预算重建，按提交上限执行，预算−1必须失败 | **通过**（见 §4） |
| 资金输入P2PK签名 | 页面JS Schnorr签名器 + sighash，公开一次性key签名，引擎验签；签名字节翻转/签后篡改必须失败 | **通过**（见 §4） |
| 形态扫描与预算上界 | `vm-sweep.mjs` + `vm-model.mjs`：2,073个网格形态 + 684个随机留出形态，拟合并检验各动作预算上界 | 引擎**0失败**；经验上界覆盖全部形态（见 §5，**经验值，非证明**） |
| 共识规则 | 成熟度/DAA、mass上限的节点强制、双花、入池策略；钱包资金及管理 UTXO 的真实冲突拒绝见 TN10-EVIDENCE §14–16 | 双花拒绝**已实测**；成熟度/mass 违规拒绝未系统覆盖 |
| 真实钱包签名 | 任何外部真实钱包（含Kastle）对这些交易的签名与广播；TN10 专用测试钱包的内存闭包签名见 §7 | 外部钱包 **NOT_RUN** |
| 节点/acceptance/网络 | 历史2026-11-14为13run/1620笔、1590笔CLI回放；2026-11-15当前页六场景547笔、17片派奖4359笔/三片退款796笔及各自独立回放、管理/资金/真实双节点竞争均完成，逐笔≥100DAA。旧轮新增5笔单列，见[TN10-EVIDENCE§16](TN10-EVIDENCE.md) | TN10 **部分场景已实测**；主网 **NOT_RUN** |
| 归档持久化深度检查 | 冷备份恢复、崩溃重放、多进程竞争、节点裁剪（`archive.test.mjs` 只覆盖 §2 所列4项） | **NOT_RUN** |
| Indexer/HTTP/节点适配器 | `indexer.mjs`、`node-adapter.mjs`：离线测试通过，并由 `tn10-replay.mjs` 对真实 TN10 节点重新验证了 7 个 CLI run 共 1590 笔（见 §7）；`http.mjs`：仅离线测试（3 项），未对真实节点长期运行、未部署为服务 | Indexer/节点适配器 **已对真实节点回放**；HTTP 服务 **NOT_RUN**（实链） |

## 2. JS 离线单测

命令（工作目录 `kaswin/`）：`node --test experiments/rolling/state.test.mjs experiments/rolling/transactions.test.mjs experiments/rolling/archive.test.mjs`

Node v22.23.2；分文件结果：`state` 10/10，`transactions` 9/9，`archive` 4/4，合计23 pass、0 fail、0 skipped。

边界：
- `state.test.mjs` 只验证编解码与金额算术（59/93/63字节头、N=256、r/c、mergeTail、10M票边界等）。
- `transactions.test.mjs` 使用**人为构造的3字节假模板尾**，不含任何编译产物；只验证JS交易策略与解释器（k=1/16、终局合并、34/35/36输出、退休动作拒绝、隐藏后继/少退/截留押金被解释器拒绝）。
- `archive.test.mjs` 在临时目录做存储测试（快照CAS、接受/撤销/重新接受、中断的receipt更新、原文不可覆盖），不模拟交易接受。
- 三者都不是VM测试，也不是acceptance证据。真实脚本由 §3 另行验证。

## 3. 脚本引擎验证（`vm-run.mjs`）

范围：`kaspa-txscript` 2.1.0 引擎 + `CovenantsContext`，对每个协变输入执行脚本，调用方式与共识 `check_scripts` 相同（`from_transaction_input…`）。基线交易由真实JS构建器基于真实编译产物生成；账本、冻结片与DRAW证明为合成数据。资金输入由公开一次性key签名并同样被引擎执行（§4）。

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

做法：各基线以实测最小预算重建（每个输入，含资金输入）；每个输入按提交预算的允许单位（`预算×10,000 + 9,999`）限额执行；再把每个有预算的输入各自减1，必须失败。资金输入由确定性的公开一次性key（`kaswin-rolling-vm-throwaway-key:funder` 的SHA-256，从未充值，不是钱包）经页面JS的BIP-340签名器和sighash签名，由引擎验签。

| 项目 | 结果 |
|---|---|
| 受限执行 | 48/48 通过 |
| 预算−1 | 152/152 以 `ExceededCommittedScriptUnits` 失败（阈值精确；含111个管理片/冻结片输入和41个资金输入） |
| 资金输入 | 41个资金输入各恰好消耗100,001脚本单位，最小预算**10**（10×10,000+9,999=109,999 ≥ 100,001；9×10,000+9,999=99,999 < 100,001）。实测，取代此前文稿中“取11”的推算 |
| 签名对照 | 27个含资金输入的基线 × 3 = 81个，全部符合预期：签名字节翻转必须失败、签后篡改out0金额必须失败、仅执行资金输入必须通过 |

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

## 5. 形态扫描与预算上界（`vm-sweep.mjs`、`vm-model.mjs`）

目的：§4 只测了48个手选形态，而消耗随账本大小变化很大（BUY 从约11万到约111万单位），所以需要知道每个动作在整个形态域内要多少预算。

**做法**
- `vm-shapes.mjs` 按参数构造交易，全部由真实JS构建器基于真实产物生成；管理片与冻结片输入在引擎中**不设预算上限**执行并记录实际脚本单位；资金输入不在此执行（其耗费为常数，见 §4）。
- 网格 2,073 个形态（另有25个被构建器判为无效形态而跳过，例如末片仅剩1条记录时没有资金支付执行者手续费）：旧片数 0–255、本地记录 0–255、k=1–16 及其位置、退款游标 c、REFUND_SELF 批次、1–8个资金输入、DRAW 赢家位置极值；并在最大账本上加三种数值体制（宽票数：累计票数约990万；最大单价：ticketCap 刚高于总票数；两者叠加）。
- 随机留出 684 个形态（700个中16个被构建器判为无效），种子 20261113，随机动作、账本形态、数值体制、数量与资金输入个数，**不参与拟合**。
- 模型：按实际执行的合约分支分15类（如BUY是否冻结换片、PAY_OLD/REFUND_OLD/REFUND_SELF 是否为终局批、DRAW 赢家在旧片还是本地片），每类对 `cnt/local/k/批大小/资金输入数` 做最小二乘；**上界 = 拟合值 + 网格最大正残差 + 该类最大值的1%**，所以对全部网格点按构造成立，留出集才是真正的检验。冻结片输入单独建模为 `a + b×管理片账本字节数`。

**结果**

| 项目 | 结果 |
|---|---|
| 引擎 | 2,073 + 684 个形态全部按预期通过，0失败 |
| 留出检验 | 684个形态对15类上界和2个冻结片上界**0越界**；各类留出集实测/上界的最大比值为0.9901（<1），即在最坏点上界只比实测多约1% |
| 数值大小 | 本次宽票数/最大单价样本的残差与窄值域接近（PAY_OLD 的正残差多385单位、DRAW old 多21单位）。这仅说明所测样本未显示明显额外开销，不能证明耗费与金额编码、买家公钥或记录分布无关。 |

各动作在选定角点（cnt≤255、local≤255、k≤16、资金输入≤8）的模型估计（每个动作取其选定角点的最大者；不是整个协议域的上界，未证明函数在该角点达到最大，且不覆盖合法的 N=256 状态）：

| 动作 | 实测最大单位 | 上界单位 | 上界预算 | 冻结片输入上界单位/预算 |
|---|---:|---:|---:|---|
| BUY | 1,116,159 | 1,130,094 | 113 | – |
| CLOSE | 1,118,246 | 1,130,121 | 113 | – |
| TIMEOUT | 1,041,419 | 1,052,534 | 105 | – |
| DRAW | 1,434,322 | 1,452,097 | 145 | – |
| PAY_OLD（k=16） | 5,059,147 | 5,109,739 | 510 | 463,358 / 46 |
| PAY_SELF | 691,498 | 700,712 | 70 | – |
| REFUND_OLD | 2,275,975 | 2,305,006 | 230 | 470,918 / 47 |
| REFUND_SELF | 2,351,811 | 2,375,633 | 237 | – |

预算为 `ceil((单位−9,999)/10,000)`，资金输入固定10。若每个输入都取上表的上界预算（而不是各自实测的最小预算），按48个场景换算的 compute mass 最大为 **311,523**（PAY_OLD k=16，上限500,000的62.3%；实测预算下最大为309,423），其余动作最大为 81,460（REFUND_OLD）；transient 与 storage mass 不依赖预算，沿用 §4。`computeMass = size + 10×SPK字节 + 100×Σ预算`，每多1个预算单位多100 mass。

**边界（必读）**
- 这是**有限样本上的经验包络**，不是证明。留出集通过只覆盖所测形态，不能保证同一盒域内的所有插值点，更不能覆盖域外或合法的 N=256 状态。模型有可能出现负系数，选定角点也未被证明为全域最大点。新增分支或改动模板（任何会改变Profile ID的变化）后必须重新评估。TN10 执行器因此不采用该回归模型分配预算，而对每笔实际交易单独测量并在签名后限额执行全部输入。
- 管理片消耗中，资金输入数 nF 的影响很小（约每个100–300单位），已计入。
- 构建器若在页面里用这个上界，等于固定了“按分支的公式+偏移”；另一种保守做法仍是签名前在引擎中试跑。本记录不改变页面或构建器的任何行为。
- 夹具缺陷记录：首轮扫描里 `maxprice` 体制下 CLOSE 的 ticketCap 恰等于总票数，使“refund”变体实际走了 sealed 分支（耗费与 sealed 相同）。已修正为 cap=总票数+1，并重跑全部网格与留出集；以上数字均为修正后的结果。此外 `CLOSE empty`（空轮，79,547单位）不参与拟合，只检查其不超过 CLOSE refund 上界。
- 夹具重构回归：为加速DRAW的nonce搜索，把 `transactions.mjs` 的 `draw` 拆出 `drawSample`，并改了 `fixtures.mjs` 的搜索。重构后重跑 `vm-run.mjs` 与 `vm-budgets.mjs`，`report.json`（基线/变异/失败原因/预算统计）与 `budget-report.json`（含48个场景的体积与mass）的内容与重构前逐项相同；JS单测仍23/23。

## 6. 复现

```
node --test experiments/rolling/*.test.mjs        # §2
cargo build --release --manifest-path experiments/rolling/vm/Cargo.toml   # 建议设置 CARGO_TARGET_DIR
KASWIN_VM_BIN=<runner> node experiments/rolling/vm-run.mjs                # §3，写 artifacts/vm/report.json
KASWIN_VM_BIN=<runner> node experiments/rolling/vm-budgets.mjs            # §4，写 artifacts/vm/budget-report.json
KASWIN_VM_BIN=<runner> node experiments/rolling/vm-sweep.mjs              # §5 网格，约17分钟，写 artifacts/vm/sweep-report.json
KASWIN_VM_BIN=<runner> node experiments/rolling/vm-sweep.mjs --random=700 --seed=20261113   # §5 留出集，写 artifacts/vm/sweep-random-report.json
node experiments/rolling/vm-model.mjs                                      # §5 拟合与检验，写 artifacts/vm/budget-model.json
```

`artifacts/` 被 git 忽略；报告可由上述脚本确定性重建。生成器与运行器不读取任何真实密钥、不广播；唯一的签名用的是上文所述的公开一次性测试key（从未充值）。

## 7. TN10 部署接入与后续实测（按日期记录）

本节保留各次检查时点；当前完成状态以末尾更新与§8为准。

用户已要求持续推进到 Testnet 10 上线，执行范围见 [TN10-DEPLOYMENT.md](TN10-DEPLOYMENT.md)。新增 `tn10-run.mjs`、`tn10-proof.mjs`、`engine-gate.mjs`、`deployment-profile.mjs` 和闭包签名器；未沿用经验回归模型定预算。每笔实际交易先测管理片/冻结片单位、回填预算和 storage mass、收敛费用，签名后再限额执行全部输入。

- 只读预检：`vector-10.kaspa.green` 返回 `testnet-10`、2.1.0、synced、UTXO index；已按预设网络配置来源核对genesis；当前历史header不能由RPC直接回读，证据边界见TN10-EVIDENCE§16.5。三个既有专用测试地址有足够普通 UTXO。旧 `tn10.kaspay.top` 本次连接失败。
- 原有23项 + 引擎门4项曾完整通过；随后新增 N=256 终局的 PAY_OLD k=16 / REFUND_OLD 验证，5项引擎门全部通过。执行器2项离线测试通过（真实引擎执行，网络输入为合成数据）：GENESIS mass/预算/验签，BUY第256笔冻结与接受后状态推进。合计30项不同测试已通过；不是30个实网测试。
- **TN10 实链小轮（本机节点 `ws://127.0.0.1:18210`，2.1.0，synced）**：4个小轮次均到达终局，19笔交易全部在 selected chain 接受集合内并经 ≥100 DAA 深度复核；完整 txid、acceptingBlock、DAA、fee 与 compute/storage/transient mass 见 [TN10-EVIDENCE.md](TN10-EVIDENCE.md)。
  - 空轮退盘 `EMPTY`：2笔，手续费 0.02 TKAS。
  - 不足额退款 `REFUNDED`：GENESIS→2×BUY→CLOSE→REFUND_SELF，5笔，0.082414 TKAS。
  - 3票开奖派奖 `PAID`：GENESIS→3×BUY→CLOSE→DRAW（真实 PASS-A）→PAY_SELF，7笔，0.105834 TKAS。
  - 网页同流程 `PAID`：真实 Chromium 经 `https://<staging-host>/tn10/` 驱动，creator 测试钱包内存签名，GENESIS→BUY→CLOSE→DRAW→PAY_SELF，5笔，0.085402 TKAS；驱动脚本未在网络请求与落盘状态中检测到私钥。
  - 合计19笔、8票、0.29365 TKAS，远低于 30 TKAS 上限。逐笔 quotedMass 与节点 computeMass 在前三轮一致；网页轮无 receipt 文件，仅有 intent 预估值，与节点值一致。
- **TN10 256 笔分片边界（本机节点，各一次跑完，无 resume，日志无 RPC_TIMEOUT/CURSOR_REORG/UNKNOWN）**：
  - `shard-payout`：260笔（GENESIS、256×BUY、CLOSE、DRAW、PAY_OLD），终局 `PAID`，451,305,516 sompi（4.513 TKAS）；第256笔 BUY 冻结第一个满片（步骤257，storageMass 10,051），随后 CLOSE→DRAW→PAY_OLD 在链上被接受，终局 PAID。
  - `shard-refund`：266笔（GENESIS、256×BUY、CLOSE、8×REFUND_OLD），终局 `REFUNDED`，734,642,600 sompi（7.346 TKAS）。REFUND_OLD 的 storageMass 为 360,341–373,636，远高于其 compute（≈47–48k）与 transient（≈91k），单笔 fee 约 0.36–0.37 TKAS，仍低于 0.5 TKAS 上限；这是后续费用估算的主导项。
  - `multi-payout`（lane A）：518笔（GENESIS、513×BUY、CLOSE、DRAW、PAY_OLD k=2、PAY_SELF），终局 `PAID`，8.849674 TKAS，515票；两个冻结分片 + 3 TKAS 尾池，PAY_OLD 一笔处理两个冻结分片。
  - `multi-refund`（lane B）：532笔（GENESIS、513×BUY、CLOSE、16×REFUND_OLD、REFUND_SELF），终局 `REFUNDED`，14.641718 TKAS，515票；REFUND_OLD 单笔 fee 0.364–0.369 TKAS，storageMass 364,430–368,666。
  - **两轮并发运行**（两个 lane 使用互不重叠的专用钱包），并改按 V2.0.2 节奏：上一笔第一次被选中链接受后即发下一笔，候选满 100 DAA 后才标 ACCEPTED。1050笔中 53 笔（约5%）的接受块被浅层重组顶掉后用同一份签名字节在别的块被重新接受（DAA 漂移 −4 到 +5），没有候选丢失。运行中发现并修复两个执行器缺陷（重组期间复核过严；两个脚本哈希相同的冻结分片被混淆，`TARGET_VALUE`），网页 `prepare.mjs` 有同类缺陷，已修复并由离线测试覆盖。详见 [TN10-EVIDENCE.md](TN10-EVIDENCE.md) §9。
  - 全实验：13个 run、1620笔、1563票、3,600,159,316 sompi（36.002 TKAS）。2026-11-14 用户指示“预算就是钱包里有多少用多少”，票数与累计手续费上限已撤销（仅保留三个专用钱包、单笔手续费上限、逐笔引擎测量等保护，见 `TN10-DEPLOYMENT.md`）。逐笔数据见 [TN10-EVIDENCE.md](TN10-EVIDENCE.md)、[TN10-SHARD-LEDGER.tsv](TN10-SHARD-LEDGER.tsv)、[TN10-MULTISHARD-LEDGER.tsv](TN10-MULTISHARD-LEDGER.tsv)。
  - 这是有限场景的实链证据：未覆盖多执行者竞争、超过2个冻结分片或多批 PAY_OLD（需≥4097笔购买）、TIMEOUT（按用户决定不测）、链重组下超出本次观测深度的恢复；双买家同时抢购见下一条。
- **双买家同时抢购（2026-11-14，真实页面）**：三个隔离的 Chromium（creator、buyer1、buyer2，各有独立 IndexedDB，内存钱包），creator 创建轮次并导出状态，两个买家导入同一份状态，各自准备 1 张票的 BUY 后在同一挂钟时刻（相差 1–2 ms）点击发送。同一节点上：一笔被接受，另一笔被节点明确拒绝（`output … already spent by transaction … in the mempool`），无未知状态、无重复扣款。4 次运行（含 1 次败者连公共节点 `quark-10`），详见 [TN10-EVIDENCE.md](TN10-EVIDENCE.md) §12。发现并修复 3 个页面缺陷：①败者页面卡死（“放弃”要求输入仍活跃，而赢家已花掉管理片，导入又被未决意图拦住）；②按时间解锁的动作（CLOSE/DRAW/TIMEOUT）不刷新，一直显示“还差 N 秒”；③SUBMITTED/UNKNOWN 的败者同样无法放弃（**仅离线复现，真实链上两次尝试都没形成两个节点各收一笔的真竞争**）。最终构建（sha256 `db05501f…b412e445`）重跑：败者放弃→导入→购买，赢家页面被提示状态过期后导入再买，creator 靠自动刷新等到 CLOSE，DRAW、PAY_SELF，`PAID`，7笔全部 ACCEPTED。页面和服务离线测试现为 **63 项全部通过**（新增 2 个双买家流程、1 个严格放弃、1 个已接受不可放弃）。
- **2026-11-14当时未覆盖**：两个节点各收一笔冲突交易、三买家、公共节点快速流水线。2026-11-15后续已完成前两项，两个旧sales也已按原状态结清（新增5笔另列）；公共节点高速流水线与任意多用户自动追踪仍未覆盖。共享轮次仍靠公开状态导出/导入，生产Indexer接入未完成。
- **独立页面改为 V2.0.2 节奏（2026-11-14）**：`web/rolling-tn10` 的 `intent.mjs`、`round.mjs`、`controller.mjs`、`store.mjs`、`prepare.mjs`、`app.mjs` 改为“首次被选中链接受即为候选并推进，满 100 DAA 复核后才标已接受”，并处理重组（重新搜索并记录）、候选丢失（`halted`）、候选已花输入不被复用、`STALE_INPUT` 有限重试；同时修复 `pickTargets` 在两个分片共用脚本时的选择。`web/rolling-tn10/*.test.mjs` 与 `experiments/rolling/tn10-service.test.mjs` 共 **59 项离线测试全部通过**（含真实引擎 4 组；新增候选衔接、重组跟随、候选丢失停止、内存池宽限、同哈希目标选择 5 项，假节点新增 `reorgTip`/`dropTip`）。重新构建 `dist/rolling-tn10.html`（sha256 `a90b892a…62f84f6`），本机测试服务回读哈希一致；`dist/index.html`（主网 V2.0.2）未改动。
- **新版页面实链走查（2026-11-14）**：全新 Chromium + 重新构建的页面（sha256 `a90b892a…62f84f6`），creator 测试钱包，GENESIS → BUY（3票）→ CLOSE → DRAW → PAY_SELF，5笔 `PAID`，全部 ACCEPTED（复核深度≥100，`pending` 为空），0.085402 TKAS；无私钥外泄、无控制台异常；除 DRAW（协议等待）外每步 7–8 秒（旧版同流程约 2.3 分钟）。本次没有遇到重组，页面的重组跟随与候选丢失停止只有离线测试覆盖。
- **独立节点回放**：`tn10-replay.mjs` 对 7 个 CLI run 共 1590 笔逐笔重新验证全部通过，快照状态 `NODE_REVALIDATED_SNAPSHOT_NOT_FINALITY`（不是终局性证明）；网页轮次不在回放范围内。
- **TypeScript 核心移植（2026-11-14，NOT_RUN）**：`scripts/rolling/core/src/` 把 `state`、`profile`、`transactions`、`mass`、`accepted`、`receiver` 六个 `.mjs` 按 1:1 移植为 TS（659 行），另有 `index.ts`、`tsconfig.json`、`build/rolling-core.mjs`（仿 `build/core.mjs`）。**没有编译、没有类型检查、没有单测、没有与 `.mjs` 做逐字节对照**；唯一做过的是静态核对 `.mjs` 的导出在 TS 里都有对应（只有 `state.mjs` 转发的字节工具有意不转发）。没有任何模块导入它，`web/rolling-tn10` 与 `experiments/rolling` 仍用 `.mjs`。说明见 [scripts/core/README.md](../../scripts/core/README.md)。后续2026-11-15已做独立类型构建；运行时未接入页面，行为/字节等价性仍NOT_RUN。
- **交付交接（2026-11-14）**：新增 [TN10-HANDOFF.md](TN10-HANDOFF.md)（部署方：交付物哈希 `db05501f…b412e445`、三部分依赖、地址布局、暴露面与限流建议、发布口径、上线前清单、回滚）与 [TN10-USER-GUIDE.md](TN10-USER-GUIDE.md)（终端用户）。核对了页面哈希 = 清单 = 本机线上字节，以及 `--rpcmaxclients`（默认 128）、`--unsaferpc` 确为节点参数；**没有改动本机 Caddy/systemd，没有在另一台主机演练部署（NOT_RUN），没有重新构建页面，没有重跑测试**。上线前清单里“边缘按 IP 限流”“公开声明与支持渠道”“用户获取测试币途径”三项未做，需要你决定。
- **执行器离线测试**：`experiments/rolling/*.test.mjs` 共 **53 项全部通过**（2026-11-14，执行器已含候选衔接、重新接受、`TARGET_VALUE` 修复之后；含真实引擎）。离线测试、回放与回读都不等于共识验证。
- **页面界面改版并发布（2026-11-14）**：`web/rolling-tn10/` 的展示层按主 Kaswin 页面的风格重写为面向用户的产品界面（轮次 / 创建 / 我的 / 规则四个入口、轮次卡片与进度条、“下一步怎么做”动作卡、发送前的“你将支付 / 资金去向”确认窗口、分享链接加入、高级设置）。协议层未动：`controller.mjs`、`round.mjs`、`prepare.mjs`、`intent.mjs`、`wallet.mjs`、`store.mjs` 与签名/发送/复核/放弃规则原样沿用。
  - **界面层是 TypeScript**：`app.ts`、`views.ts`、`ui.ts`、`messages.ts`、`share.ts`、`bridge.ts`（给 `.mjs` 协议模块入口加类型签名，不重写任何逻辑）、`types.ts`、`globals.d.ts`。`build/rolling-tn10.mjs` 在打包前先跑 TypeScript 5.8.3 `strict` 类型检查，有任何诊断即构建失败；浏览器依赖图白名单增加了 `.ts` 与纯数据的 `web/ui/icons.mjs`。协议模块仍是 `.mjs`，因为实链证据与 53 项离线测试对应的就是这些文件。
  - **票数上限放开到 65,536**（256 个封存分片 × 256 笔购买，协议 `MAX_TICKETS` 为 10,000,000，分片数才是约束）。实链只完整测到 515 张、2 个封存分片，所以超过 515 张时创建页显示“超出已验证范围”警示，不拦截；多批 PAY_OLD / REFUND_OLD 路径对大轮次仍是未验证的。
  - **构建与发布**：`node build/rolling-tn10.mjs`（含类型检查与依赖图闸门）通过，产物 `dist/rolling-tn10.html` sha256 `944cf22b…f9d81e00`（283,913 字节）；服务每次请求从磁盘读取页面，`curl https://<staging-host>/tn10/` 回读的哈希与本地一致。`dist/index.html`（主网）未改动。改版前的旧页面已存档到 `dist/archive/`。
  - **仍是 NOT_RUN**：新界面没有跑过任何测试（`views.test.mjs`、`page.test.mjs` 已按新结构写好但未执行），也没在真实浏览器里走过，更没有新界面的实链操作；构建只保证类型检查、打包和依赖图通过，不保证运行时行为。上文 63/63 的页面与服务测试结果只对应改版前的页面。
- **红队实测与修复（2026-11-14）**：[tests/redteam/ROLLING-WEB-TEST.md](../../tests/redteam/ROLLING-WEB-TEST.md) 记录了对线上页面的真实浏览器实测（3 轮实链流程全部终局）和 5 份审查报告，共 17 项确认的问题。其 §15 逐项列出修复：核对绿标绑定节点与状态指纹、弹窗内错误提示、设置先校验再连接成功才保存且只存改动字段、导入侧校验收据与候选交易、`PREPARED` 意图可放弃、`SEARCH_RANGE` 时按“有未花输入即证明未被接受”继续并提供强制放弃、刷新竞态、创建页与确认弹窗细节、键盘/触摸/对比度/页脚。改动触及 `round.mjs`（导入校验）、`controller.mjs`（`discard`、`importText`）、`intent.mjs`（`checkAcceptance` 的 SEARCH_RANGE 分支）和展示层。构建通过（TypeScript `strict` 类型检查 + 依赖图），产物 sha256 `97b3d8b3…42da3fe`（293,085 字节），线上回读一致；旧版存档在 `dist/archive/`。**这些修复没有运行任何单测、没有在浏览器复测**（NOT_RUN）；新增断言已写进 `views.test.mjs` 与 `round.test.mjs` 但未执行。上文 53/53、63/63 的结果不覆盖这次改动。
- **TypeScript 核心（`scripts/rolling/core`）编译（2026-11-14）**：`node build/rolling-core.mjs` 在 `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` 下 0 诊断，生成 7 个源文件的 21 个输出（`lib/` 被忽略）。**只证明能通过类型检查，没有任何行为测试**；页面不使用它，仍走 `experiments/rolling/*.mjs`。把页面切到 TS 核心之前，需要在同一批向量和 53 项测试上证明两者等价。
- **双花冲突识别（2026-11-15，已构建发布；单测与一次真实运行见末尾）**：起因是两次 `tests/rolling-web` 套件运行共用一个创建者钱包，各自的页面 profile 只记得自己占用的输入，选中同一个最大 UTXO，节点回 `output (txid, i) already spent by transaction … in the mempool`；页面既没有避开该输入，也没有识别这类拒绝（见 [ROLLING-WEB-TEST.md §16](../../tests/redteam/ROLLING-WEB-TEST.md)）。改动：① `prepare.mjs` 新增 `mempoolSpentOutpoints`，用 `getMempoolEntriesByAddresses` 的 `sending` 取出内存池已花费的输出，`selectFunds` 排除它们；排除后不够、不排除够用时抛 `WALLET_FUNDS_PENDING`（不再误报“余额不足”）；节点查不出来时按旧行为继续，以节点拒绝为兜底。② 新增 `conflict.mjs`（无依赖纯函数 `classifyRejection`），按节点原文区分“钱包资金输入被占用 / 轮次合约输出被占用 / 上一笔交易未知（孤儿）/ 其他”，轮次页的“被拒绝”提示和运行日志据此给出具体说明（含占用方交易）。③ `controller.mjs` 的 `nodeError` 截断由 300 放宽到 600（完整冲突信息约 292 字符，原值余量只有 8）。④ `fake-node.mjs` 增加 `getMempoolEntriesByAddresses`，冲突报错改为真实节点原文格式。新增测试（`controller.test.mjs` 4 项、`views.test.mjs` 1 项）**均未运行**；页面未重新构建，线上仍是上一版。接口形状取自对本机节点的只读查询（返回 `entries[{address,sending,receiving}]`，条目字段为 `is_orphan`）。已知的遗留问题：共享的 `scripts/chain/chain.mjs` `mempoolEntry` 读的是 `isOrphan`，真实节点返回 `is_orphan`，因此其 `isOrphan` 恒为 `false`；目前没有调用方使用该值，未改动。
  - **2026-11-15 已执行**：`node --test web/rolling-tn10/views.test.mjs web/rolling-tn10/controller.test.mjs` 共 41 项，**37 通过、0 失败、4 跳过**（4 项是真实引擎用例，需要 `KASWIN_VM_BIN`，没有运行）；新增的 5 项（同钱包两页的 `WALLET_FUNDS_PENDING`、查询失败时的回退与拒绝分类、`mempoolSpentOutpoints`、`classifyRejection`、被拒面板文案）均通过。这些是与测试替身节点对照的离线测试，没有对新增断言做过“去掉修复后应失败”的反向验证（其中第二项靠 `noMempoolQuery` 回退路径间接说明不修复时会被拒绝）。`round.test.mjs`、`page.test.mjs` 仍未运行。
  - **已构建并发布**：`node build/rolling-tn10.mjs` 通过（TypeScript strict + 依赖图闸门），产物 sha256 `8d002cd3…ee55bef`（296,010 字节，58 个源文件）；线上回读哈希一致，`/api/info` 仍为 `readOnly:true, holdsKeys:false, signs:false, broadcasts:false`；旧版存档为 `dist/archive/rolling-tn10-97b3d8b3.*`；`dist/index.html`（主网）未改动。
  - **真实运行**：场景 1（空轮）经本机节点跑通，见 [TN10-EVIDENCE.md §13](TN10-EVIDENCE.md)。该运行不覆盖冲突分支。
  - **双花冲突在真实节点上的测试（2026-11-15，见 [TN10-EVIDENCE.md §14](TN10-EVIDENCE.md)）**：同一钱包、两个独立页面、本机节点，18 笔链上交易、0.18 TKAS。① 两页同时发送：节点收一笔、拒一笔；输家页面按节点原文识别为“钱包资金输入被占用”，占用方交易与赢家 txid 一致，放弃后第 1 次重新创建成功；节点只读核对赢家被接受、被拒的那笔既未被接受也不在内存池。② 赢家在内存池时另一页准备交易（3 次）：都没有冲突；其中 2 次读了链上输入，另一页都避开了赢家已花的大额输入（旧算法会选它），第 1 次没有读输入；**没有对旧版页面重放同一时序的对照**。③ 旧报价在对方被确认后发送：页面发送前就以 `STALE_INPUT` 拦下，未发出任何交易。**未覆盖**：`WALLET_FUNDS_PENDING` 提示与 `ORPHAN` 分类没有在真实节点上出现过，只测了 GENESIS 一种动作。
  - **轮次 UTXO（管理 UTXO）被双花，真实节点测试（2026-11-15，见 [TN10-EVIDENCE.md §15](TN10-EVIDENCE.md)）**：两个买家（不同钱包）、两个独立页面、本机节点，5 次运行共 0.3595 TKAS。① 同时对同一轮发送买票：4 次都是节点收一笔、拒一笔，页面都识别为 `ROUND_INPUT`，占用方 = 赢家的 txid，被争输出 = 赢家那笔交易的第 0 个输入（管理 UTXO，由节点返回的已接受交易核对），被拒的那笔未被接受也不在内存池；输家放弃、导入赢家的最新状态后重新购买成功，且接在赢家之后（链上核对）。② 旧报价在对方被确认之后发送：页面发送前以 `STALE_INPUT` 拦下，未发出任何交易，提示对轮次冲突是准确的。**发现但未改**：页面在忙的时候静默忽略点击（`onAction`），导入别人的状态后第一次点“购买”没有反应、第二次才弹出报价。**未覆盖**：只测了 BUY；跨节点真竞争；其它动作同时发送。
  - **“创建交易”标签（2026-11-15，已修）**：轮次页的“创建交易”原先显示 `r.origin.transactionId`（GENESIS 所花的创世输出所在的上一笔交易），现在取 GENESIS 收据的 txid，创世输出另在“技术信息”里单独标注；`views.test.mjs` 新增 1 项（通过，共 14 项）。同批还把“放弃这笔”之后的提示按冲突类型区分（钱包资金/孤儿提示“等几秒重新操作”，其余仍提示导入最新分享链接）。构建 `75c0ca4c…af885fc`（296,445 字节），线上回读一致，旧版存档 `dist/archive/rolling-tn10-8d002cd3.*`、`rolling-tn10-e29757fe.*`。
- **后台核对与按钮状态修复（2026-11-15，已发布）**：用户指出操作应后台执行、不能让可点的按钮静默失效。根因为 `track`、`verifyLive` 与交易准备/发送共用全局 `busy`，`onChange` 又要等异步读取存储后才渲染。现在后台核对不占用前台 `busy`；控制器保留一个串行任务队列（记录仍单写入者），相同后台任务复用，用户操作立即占位、优先于尚未开始的后台任务，已开始的后台任务结束后执行；前台 `busy` 切换同步渲染，交易按钮禁用并显示“处理中…”及原因，核对中的按钮显示“核对中…”，背景核对不禁用购买按钮。轮询增加防重入并捕获后台异常，记录后在后续周期重试。42 项 controller/views 离线测试通过、0 失败、4 项真实引擎用例因缺少 `KASWIN_VM_BIN` 跳过；新增 3 项延迟 RPC 的队列/失败恢复/优先级回归和 1 项按钮视图回归均通过。TypeScript strict 与依赖图构建通过，58 个源文件，产物 297,659 字节、sha256 `b51c989593fa460a95b6482421c58e8b184d978e43383c459f534c2c0d1636da`；公开 HTTP 回读与清单一致。旧版及清单存档 `dist/archive/rolling-tn10-75c0ca4c.*`，主网 `dist/index.html` 哈希与修改时间保持。新版本浏览器回归与实链行为均 **NOT_RUN**，没有读取钱包、签名、广播或重启节点。本条不扩大此前双花测试的实链证据范围。
- **其余场景补测（2026-11-15，用户保留 TIMEOUT 手测）**：b51 构建网页 1–6 完整完成，547 笔、520 张票、12.11117320 TKAS；其中 256 笔冻结派奖 260 笔交易到 PAID，256 笔冻结退款 266 笔到 REFUNDED。每笔保存真实 txid、选中链接受、≥100 DAA、mass 与实际 fee。离线扩展套件 122/122 通过；当前界面/真实 Chromium 故障注入回归 11/11 通过。按下按钮期间的 DOM 刷新保护已发布为 `ea23092b…3ab3d2f8`（298048 字节），先归档 `b51c9895`，HTTP 回读与只读服务范围一致，当前构建再跑场景 3/4：14 笔、两轮 PAID。
  - **恢复与资金选择**：受控中断恢复仍用原签名交易，节点重新核对通过；CLI 修正“必须单个 UTXO 足额”的假设，最多合并 8 个普通输入，真实双输入创世交易已接受；原失败目录继续运行，runner 5/5 再次通过。详见 TN10-EVIDENCE §16.3。
  - **历史收尾及边界偏差**：两轮历史 sales 真实收尾，新增 5 笔、0.118 TKAS，分别 REFUNDED/PAID。此前漏算它们，最初并行时实际 4 活动轮，超过文件约定的 3；已记录偏差并结清。当前调度按已知公开记录的 CID/实际 UTXO 加容量检查，长轮仅两组并行。另发现旧同钱包诊断B页2TKAS配置，未执行BUY；实际GENESIS独立解码证据保留，当前复跑已统一1TKAS/cap5与6。详见§16.4，不将容量检查称为通用全局分配器。
  - **当前构建与多片补测**：ea23092b 页面六场景亦已完成，547 笔、520 票、1216600100 sompi，逐笔 ≥100 DAA/fee/mass（汇总 `browser-current-summary.json`）。另一次单笔 BUY(quantity3) 到 PAID，5 笔/8540200 sompi。三冻结片退款完整796笔/771票，24批REFUND_OLD+REFUND_SELF，REFUNDED/2217109236sompi；独立节点索引回放796/796，状态 NODE_REVALIDATED_SNAPSHOT_NOT_FINALITY。控制器17/40片派奖、跨3片退款/资金辅助尾批4项模拟用例通过，另3项固定真实VM版本通过（节点数据模拟）；CLI k16合成场景真实limited VM17输入通过，不能计为链上接受。见 TN10-EVIDENCE §16.6–16.7。
  - **本轮补测已完成**：17片派奖4359笔PAID/7647321264sompi，独立节点索引回放4359/4359；与三片退款合计5155笔回放。三买家、并发CLOSE、BUY对CLOSE已有真实冲突；CLOSE查询回滚用原交易补证。两个不同p2pId的实际提交socket各接收不同txid，所选本机链仅一笔接受，4笔REFUNDED。当前管理UTXO竞争/恢复/旧报价6笔、同钱包资金竞争/两次排除/旧报价14笔均逐笔≥100DAA并结清。最终已知40CID活跃/预留0，三钱包池条目0；HTTP仍ea23092b，主网页hash保持。TIMEOUT交由用户手测，外部钱包、主网及生产批准不在本轮范围。详见[滚动记录](REMAINING-COVERAGE-20261115.md)、TN10-EVIDENCE§16.8–16.10。
  - **后续测试运行器补强**：首帧18秒单调时钟硬截止覆盖实际socket身份探测、跨节点延迟及每次release，8项离线定向测试与脚本语法通过；新版调度TN10复跑NOT_RUN，旧实链证据不改为新调度已运行。见TN10-EVIDENCE§16.11。
- 本机的页面、节点代理与预算服务仅用于测试；最终交付为网页，所用服务另行部署。

## 8. 尚未完成

本轮约定的非TIMEOUT补测与已有轮次收尾已完成，以[滚动记录](REMAINING-COVERAGE-20261115.md)为准。TIMEOUT由用户手测；Kastle等Rolling外部钱包接入、独立TS核心行为等价性、生产级Indexer集成、新旧Profile分流、任何主网实验与候选Profile的非UNVALIDATED批准仍未完成。所测17片实链/40片真实VM形态、当前页面与有限并发不能代替全参数、全部节点条件、超出观测深度重组或更高负载证明。本文件不构成生产可用结论。

## 9. Rolling 第3项后续实现：钱包、索引与 TS 核心

用户要求完成此前第3项，后续所有测试交tester，实现会话只负责实现/修复。三项源码已接线：

- `scripts/rolling/core.mjs`统一入口接生成的独立TS核心；原六份MJS保持差分基线；页面及索引/节点/归档/CLI运行时导入已切换，构建门要求TS核心真正进入浏览器图，并记录源文件哈希。
- `extension-wallet.mjs`加入KasWare/Kastle TN10适配，仅取授权普通输入SIGHASH_ALL签名，核对返回交易与本地签名，扩展不广播；账户/网络变化及walletEpoch撤销未发送报价，保存及真正发送前重新核对。
- kci实现独立持久Rolling sidecar及只读命名空间，不共写V2.0.2数据库。页面支持列表/CID/交易ID加入和状态同步，从自己的节点Full/witness重算最新交易并核对live/终态；不覆盖本地意图、候选或当前报价，慢索引读取不占用记录写队列。

实现交接与测试范围见 [ROLLING-INTEGRATION-HANDOFF.md](../../docs/ROLLING-INTEGRATION-HANDOFF.md)。本次没有由实现会话运行任何测试、构建、VM、浏览器或网络检查，所有新集成执行结果待tester回报；此前TN10交易仍保留其原产物时点，不自动升级为本次TS/扩展/新索引的通过证据。未修改主网HTML、未启动/部署新sidecar、未改unit，TIMEOUT仍由用户手测，候选状态不变。

## 10. 顶栏 GitHub 与中英文切换（显示层交付）

参照 V2.0.2，在 Rolling 顶栏加入 GitHub 仓库链接与 `EN` / `中文` 切换。复用共享显示层本地化，补充 Rolling 专用英文词典，并允许页面提供自身标题和描述。浏览器保存语言偏好，切换只更新文本与显示属性，保留表单和弹窗；弹窗识别改用原始标题数据，避免英文显示影响钱包与设置流程。现有页面结构断言已跟随新按钮调整，但未执行。

构建内置门首次指出浏览器语言列表为只读数组，与共享 JS 推导的可变数组类型不匹配；调用改为传数组副本后构建完成。交付物 1,053,512 字节、813 个图输入，sha256 `d49cdf8cb634629dd159b62896f164516ae10c7057a57cf79a3f90c54ef0bddf`，公开 HTTPS 页面回读一致；旧版与清单存于 `dist/archive/rolling-tn10-5cdaf8ef.*`。本次附带只读 `/<staging-path>/api/info` 回读为 HTTP 404，不作为旧预算服务就绪证明。

按用户此前“改页面显示不要再测试了”的要求，单元测试、浏览器、VM 与链上测试均 **NOT_RUN**。主网页 `dist/index.html` 哈希仍为 `0ee7ec5d416820a7e8bb5d1d29b473dc2da16383c73ea396c790840e058e8c2b`。本次显示层构建和 HTTP 交付不扩大协议验证范围，Profile 继续 `UNVALIDATED`。

## 11. 详情工具栏精简（显示层交付）

用户指出详情页核对、同步、分享、导出入口过多。源码核对确认“向节点核对”和“同步最新状态”均调用 `doVerify(cid,{quiet:false})`，现合并为“刷新状态”；“复制分享链接”和“导出轮次文件”收进“更多”。菜单支持点击外部、选择动作或按 Escape 收起；页面刷新在同一轮次保留菜单展开状态。过期状态提示、英文文案与使用说明同步调整，现有视图断言随标签更新但未执行。

构建内置门通过，产物 1,054,678 字节、813 个图输入，sha256 `2f4f1fb8a3b1e370d538fc7ebf63b77e7c387ed257fa10da2557ecc837aa2b4a`，公开 HTTPS 页面回读一致；旧版与清单归档为 `dist/archive/rolling-tn10-d49cdf8c.*`。按用户已有要求未运行任何测试套件、浏览器、VM 或链上测试，均 **NOT_RUN**。本次只执行构建与页面 HTTP 交付回读，协议/Profile 状态不变。

## 12. 安卓“更多”显示修复（构建与页面交付）

用户报告 §11 的“更多”在桌面模式正常、安卓浏览器不能正常显示。源码使用原生 `details/summary` 与绝对定位菜单，本次未做实机复现，不能断言具体浏览器根因。现改为普通按钮打开页面已有的操作弹窗，分享与导出按钮使用至少 48px 的触摸高度；移除折叠菜单的定位、外部点击及展开状态恢复逻辑。操作按钮绑定打开时的 CID，避免异步页面更新导致目标轮次变化；选择操作后关闭弹窗，并保留原有分享/导出流程。现有结构断言随界面调整但未运行。

构建（含内置类型与图门）通过，产物 1,054,160 字节、813 个图输入，sha256 `3f2dda834ce509d010f33f557911370ee886fa63cd2d27dc88a9ac17b72d87e0`，公开 HTTPS 页面回读一致。旧页面与清单归档 `dist/archive/rolling-tn10-2f4f1fb8.*`。按用户已有要求未运行单元、浏览器、VM 或链上测试，安卓实机复测 **NOT_RUN**；本次交付不视为安卓问题已通过运行验收。

