# V2 源码与三流程验证状态（2026-10-06）

**L、V 与 N 级三流程验证已执行，派奖超时退款明确排除未测试；11 笔 Testnet 10 交易全部 selected chain accepted。**

## 真实构建与产物

- 固定 SilverScript v1.0.0 `3ed973335b59269293564805cc2c58a14595ec03`，编译器二进制 SHA256: `81de9aa4157dbde3633ebab629e86c5975770fc13ee2d2093e52d7f725616a00`。
- 逆拓扑编译顺序：REFUNDING → SEALED → OPEN。
- 产生的真实 V2 Profile ID：`206d4ec7072727ae3291726f19c82293b38340a5a7de05d306cf105c4206a9c3`。
- 模板哈希：
  - REFUNDING: `8547e6b11115a8d7f81e6062719194d467bc1135d9bcf0c91fc87256a84150d6` (tailBytes: 7229)
  - SEALED: `ba2f1118738c0c9b0a0d9c4adcfedffacace8f075984912fe7df1bd15aedc546` (tailBytes: 3937)
  - OPEN: `09e1a6aea947b3cf5cda353ef822f45180df5fa2cf0f4b5fdafd4f759c67547e` (tailBytes: 3224)
- 产物已安装至 `contracts/f3.2/`（`pins.json`, `profile.json`, `artifacts/`），并通过 `check-compile.mjs` 离线比对。
- TypeScript 5.8.3 编译通过，`packages/f3.2-core/lib/` 经 `check-core.mjs` 核对无漂移。

## 用户指定三流程测试结果

1. **正常开奖派奖（DRAW_AND_PAY）**：
   - Level L：`apps/kaswin-v2/test/user-flows.test.mjs` 与 `engine.test.mjs` PASS。
     - GENESIS -> BUY x3 -> CLOSE (SEALED) -> DRAW_AND_PAY (终局 PAID)。
     - 赢家奖金（3 TKAS − 1 TKAS 赏金 − 网络费）、创建者押金（0.2 TKAS）、执行者赏金（1 TKAS）。
     - reconcile 对账 ACCEPTED，`replayAccepted` 独立无信任重算完全一致。
   - Level V：`silverscript-lang/tests/v2_user_flows_vm.rs` PASS。
     - Kaspa TxScriptEngine 虚拟机执行成功，消耗 115,829 script units。
2. **零买退款（CLOSE EMPTY）**：
   - Level L：GENESIS -> 0 买 -> 截盘 CLOSE -> 终局 EMPTY。
     - 创建者押金 0.2 TKAS 原路全额退还。
     - reconcile 对账 ACCEPTED，`replayAccepted` 重放复验一致。
   - Level V：Kaspa TxScriptEngine 虚拟机执行成功，消耗 90,733 script units。
3. **不达最低票数退款（CLOSE REFUNDING -> REFUND）**：
   - Level L：GENESIS (min 5) -> BUY 2 -> 截盘 CLOSE (进入 REFUNDING) -> REFUND (终局 REFUNDED)。
     - 买家退款（扣 0.01 TKAS 退款执行费）、创建者押金（0.2 TKAS 原路退回）、执行者费用补贴。
     - reconcile 对账 ACCEPTED，`replayAccepted` 重放复验一致。
   - Level V：
     - CLOSE (to REFUNDING)：执行成功，消耗 211,018 script units。
     - REFUND (terminal)：执行成功，消耗 107,321 script units。
4. **派奖超时退款（TIMEOUT_REFUND）**：
   - 严格遵循指令：**完全排除，未运行任何测试**。

## 当前设计与边界

- 固定 SilverScript v1.0.0 `3ed973335b59269293564805cc2c58a14595ec03`；共识源码基线 `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`，不自动升级。
- REFUNDING → SEALED → OPEN 逆拓扑编译；SEALED 内嵌 REFUNDING hash，OPEN 内嵌 SEALED/REFUNDING hash。源模板的零值只是链接占位，不能发布。
- 链上只有 OPEN 的 BUY/CLOSE 重算规范初态 CID；后继仍检查完整 template/SPK/value/CID，不把客户端检查当作链上约束。
- Ledger：`KW20`，Header **228B**，目录从228开始，每条36B，最多256条；256上限的可执行性仍待新 VM/mass 校准。
- ABI：OPEN **8参数 / 10见证栈项**，SEALED/REFUNDING **6参数 / 8见证栈项**。没有 `genesisTail`、状态 routes 或 networkGenesis。
- 客户端始终需要 origin：非 OPEN 轮次资料仅提供候选值，须通过规范 OPEN CID 重算。不会补零或绕过认证。
- 动作仅 BUY=1、CLOSE=2、DRAW_AND_PAY=4、TIMEOUT_REFUND=9、REFUND=10。phase3/4只在原子开奖内部使用，不是可花费的 live 状态。源码无调用者的旧beacon构建/回收/公告函数与Operation中的旧配置字段已删除，不新建V2兼容信标协议。旧生成lib保持原样，须获准后重建才能反映这些API删除。
- 域：`KASWIN_V2_DRAW`、`KASWIN_V2_SAMPLE`、`KASWIN_GENESIS_V2`、`KASWIN_PROFILE_V2`。源码已对照 seed 前像及56-bit抽样，不是确定性向量执行或VM结果。
- 网络配置仍固定 TN10。去掉共识账本内 networkGenesis 不等于去掉客户端网络隔离或节点网络检查。

## 消费者与安全修复

### 本地 journal

`records()`、localTip、reconcile、archive 只处理当前 Profile；`reservations.mjs` 只读取同库、同网络所有 Profile 的 `tx` 记录中 status/inputs。除 REJECTED/ARCHIVED 外均保留占用，损坏的未解决记录阻止花费，不猜测释放。资金选取和 execute 都调用此保护。

不清库、不迁移、不载入旧 ABI，不在V2页面对账旧Profile。原记录需用其对应版本处理。保护只覆盖此新版代码在同源、同记录库的执行；未升级旧页面、其他数据库/origin/设备不获得反向保护，不能并行提交同一资金。

### Indexer（另一工作空间中的源码候选）

`/root/kaspa/workers/kaswin-event-indexer/contracts/kaswin-v2.mjs` 和 `v2-rounds.mjs` 是独立V2实现，不委托F3 adapter。使用显式本地仓库路径和完整Profile pin，调用本地 `loadV2Bundle`；缺pin或旧artifact直接拒绝。只读索引不因预算未校准而伪称可提交。

保留旧插件和轮次 contract key，不改 `contracts/default.json`，不重启服务。V2每条轮次保存origin/CID；逐次重新认证snapshot、8/6 ABI、见证、时间字段、输出金额/SPK/CID。API与SQL分页同时识别V2，phase3/4按unknown处理。

Registry仍只认output1的5,000,000 sompi普通付款、2/3个规范输出及owner找零；付款不代替Genesis/profile认证。V2按builder支持1..8个owner普通资金输入，逐项检查UTXO上下文和标准签名形状；缺完整上下文抛UNKNOWN，不悄悄跳过。签名密码学和selected-chain acceptance由节点/索引引擎建立，adapter不声称自行执行共识。

## 产物与工具

- `lib/`、`artifacts/`、`pins.json`、`profile.json`、release HTML和manifest仍为旧构建。不能改标签冒充V2；本轮不手改生成物。
- `build-v2.mjs`只在**明确获准编译后**运行，目标必须为新绝对路径目录。绑定compiler binary SHA、模板源/链接源/constructor/artifact SHA、模板依赖和Profile。
- `check-compile.mjs`已改为复用上述链接器，再与本地V2 pins比对；不再直接编译带零占位模板。
- 发布仓库当前没有 `compile_three.py`；外部references中的旧脚本是历史工具，不是V2入口。
- `budgetProfileId:null` 必须保持到新Profile VM预算测量与评审完成。网页构建同时拦截陈旧lib、旧pins、未校准预算。
- 删除当前npm `verify:deployed`入口；`--reproduce-deployed`明确拒绝。旧快照留存，需在其历史源码版本复现，不能要求V2源码产生旧协议字节。
- `source-map.json`保存历史整理映射及当时哈希，不是当前源码完整性证明；本次只加范围标记，不伪造新生成物哈希。

## 最小必要验证计划（全部待授权，未运行）

| 测试/门槛 | 保护价值、具体失败与遗漏后果 | 最低验证层及非重复性 |
|---|---|---|
| 228B push / ABI / linked bundle | 初态push不一致会改SPK/CID；错依赖会导向错误脚本 | L编译+确定性向量；独立于TS内部往返 |
| seed/sample合成JS向量与origin负例 | 标签/字段顺序错导致奖项错；非OPEN候选origin不认证会信错轮 | L仅接口回归；另需V层同前像差分，JS不能证明SIL |
| 本地跨Profile占用、execute入口和损坏记录 | UNKNOWN旧记录被忽略后可能重复花费 | L，纯记录函数测网络/状态范围；引擎测试证明入口实际接线，不是同一覆盖 |
| V2插件action/SQL分类/注册/见证负例 | 旧动作、分页过滤不一致、marker冒充、origin错误可能污染缓存 | L，真实本地bundle测试显式需要 `KASWIN_V2_REPO`；不使用旧fixture改标签 |
| VM转移与最大目录预算 | JS模拟无法验证opcode、栈、时间锁、费用/质量及256目录可执行性 | V，必须绑定新Profile；旧3446例没有替代价值 |
| 单HTML与最小浏览器回归 | 生成物漂移、依赖越层、钱包/持久化接线可能破坏保护 | L；不能代替真实钱包或网络acceptance |
| TN10真实accepted/mass/fee | VM不证明relay与selected-chain acceptance | N，须另行明确授权，逐笔真实txid记录 |

`protocol.test.mjs`保留unsupported-action负例，旧预算断言改成明确TODO；旧f256数据保留但不再作为V2中奖票号oracle。现在不能给出新Profile、预算、通过数或上线状态。Node22.23.2/esbuild0.28.2对JSON import attributes的完整构建链也未执行验证，须在获准后的core/网页构建中确认。
