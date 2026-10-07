# V2 源码与验证状态

## 2026-10-07 当前状态：安全整改、编译核对、发布BLOCKED

[完整整改Preflight与结果](REMEDIATION-20261007.md)。Profile `206d4ec7…`、228B和8/6 ABI不变；三份SIL及固定artifact未改。TypeScript核心新增accepted解释器，14源文件生成42个lib文件；前端和本机Indexer源码已接入。输入占用改为同一IDB事务扫描/验证/插入，HTTP租约续期，普通资金预算和费用策略修复。HTML注入入口及渲染已加固，正式构建采用脚本hash CSP。

本轮只做静态审查、TypeScript编译与内存打包，没有单元／浏览器／VM／链上测试，没有部署服务。`budgetProfileId:null`：完整V2预算证据未闭合；正式build会在写发布文件前拒绝。`releases/kaswin-v2/index.html`及dist仍为整改前SHA `6509ee14…`，不含本轮修复，不能继续当作安全整改交付。历史执行结果不自动覆盖改后代码。

## 历史：2026-10-06三流程记录

以下为当时记录：L、V、N三流程执行，超时退款排除，11笔TN10交易reported selected-chain accepted。2026-10-07没有重新查询或执行，不用此记录证明完整默认预算、256目录或本轮客户端修复。

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
- 动作仅 BUY=1、CLOSE=2、DRAW_AND_PAY=4、TIMEOUT_REFUND=9、REFUND=10。phase3/4只在原子开奖内部使用，不是可花费的 live 状态。源码无调用者的旧beacon构建/回收/公告函数与Operation中的旧配置字段已删除，不新建V2兼容信标协议。这些API删除已进入当前lib；2026-10-07进一步重建lib加入安全整改。
- 域：`KASWIN_V2_DRAW`、`KASWIN_V2_SAMPLE`、`KASWIN_GENESIS_V2`、`KASWIN_PROFILE_V2`。源码已对照 seed 前像及56-bit抽样，不是确定性向量执行或VM结果。
- 网络配置仍固定 TN10。去掉共识账本内 networkGenesis 不等于去掉客户端网络隔离或节点网络检查。

## 消费者与安全修复

### 本地 journal

`records()`、localTip、reconcile、archive 只处理当前 Profile；`reservations.mjs` 只读取同库、同网络所有 Profile 的 `tx` 记录中 status/inputs。除 REJECTED/ARCHIVED 外均保留占用，损坏的未解决记录阻止花费，不猜测释放。资金选取和 execute 都调用此保护。

不清库、不迁移、不载入旧 ABI，不在V2页面对账旧Profile。原记录需用其对应版本处理。保护只覆盖此新版代码在同源、同记录库的执行；未升级旧页面、其他数据库/origin/设备不获得反向保护，不能并行提交同一资金。

### Indexer（2026-10-06历史消费者说明；本轮仅修改本机源码）

`/root/kaspa/workers/kaswin-event-indexer/contracts/kaswin-v2.mjs` 和 `v2-rounds.mjs` 是独立V2实现，不委托F3 adapter。使用显式本地仓库路径和完整Profile pin，调用本地 `loadV2Bundle`；缺pin或旧artifact直接拒绝。只读索引不因预算未校准而伪称可提交。

保留旧插件和轮次 contract key，不改 `contracts/default.json`，不重启服务。V2每条轮次保存origin/CID；逐次重新认证snapshot、8/6 ABI、见证、时间字段、输出金额/SPK/CID。API与SQL分页同时识别V2，phase3/4按unknown处理。

Registry仍只认output1的5,000,000 sompi普通付款、2/3个规范输出及owner找零；付款不代替Genesis/profile认证。V2按builder支持1..8个owner普通资金输入，逐项检查UTXO上下文和标准签名形状；缺完整上下文抛UNKNOWN，不悄悄跳过。签名密码学和selected-chain acceptance由节点/索引引擎建立，adapter不声称自行执行共识。

## 产物与工具

- `artifacts/`与`profile.json`是已固定的V2 `206d4ec7…`；lib于2026-10-07重新生成，pins只撤回预算批准标记。release HTML/manifest仍对应整改前源码，不手工改hash或标签冒充更新。
- `build-v2.mjs`只在**明确获准编译后**运行，目标必须为新绝对路径目录。绑定compiler binary SHA、模板源/链接源/constructor/artifact SHA、模板依赖和Profile。
- `check-compile.mjs`已改为复用上述链接器，再与本地V2 pins比对；不再直接编译带零占位模板。
- 发布仓库当前没有 `compile_three.py`；外部references中的旧脚本是历史工具，不是V2入口。
- `budgetProfileId:null` 必须保持到新Profile VM预算测量与评审完成。网页构建同时拦截陈旧lib、旧pins、未校准预算。
- 删除当前npm `verify:deployed`入口；`--reproduce-deployed`明确拒绝。旧快照留存，需在其历史源码版本复现，不能要求V2源码产生旧协议字节。
- `source-map.json`保存历史整理映射及当时哈希，不是当前源码完整性证明；本次只加范围标记，不伪造新生成物哈希。

## 验证计划（历史源码计划；本轮整改测试未运行）

| 测试/门槛 | 保护价值、具体失败与遗漏后果 | 最低验证层及非重复性 |
|---|---|---|
| 228B push / ABI / linked bundle | 初态push不一致会改SPK/CID；错依赖会导向错误脚本 | L编译+确定性向量；独立于TS内部往返 |
| seed/sample合成JS向量与origin负例 | 标签/字段顺序错导致奖项错；非OPEN候选origin不认证会信错轮 | L仅接口回归；另需V层同前像差分，JS不能证明SIL |
| 本地跨Profile占用、execute入口和损坏记录 | UNKNOWN旧记录被忽略后可能重复花费 | L，纯记录函数测网络/状态范围；引擎测试证明入口实际接线，不是同一覆盖 |
| V2插件action/SQL分类/注册/见证负例 | 旧动作、分页过滤不一致、marker冒充、origin错误可能污染缓存 | L，真实本地bundle测试显式需要 `KASWIN_V2_REPO`；不使用旧fixture改标签 |
| VM转移与最大目录预算 | JS模拟无法验证opcode、栈、时间锁、费用/质量及256目录可执行性 | V，必须绑定新Profile；旧3446例没有替代价值 |
| 单HTML与最小浏览器回归 | 生成物漂移、依赖越层、钱包/持久化接线可能破坏保护 | L；不能代替真实钱包或网络acceptance |
| TN10真实accepted/mass/fee | VM不证明relay与selected-chain acceptance | N，须另行明确授权，逐笔真实txid记录 |

`protocol.test.mjs`保留unsupported-action负例，旧预算断言改成明确TODO；旧f256数据保留但不再作为V2中奖票号oracle。Profile已由实际pins确定；2026-10-07固定TypeScript/esbuild内存编译链可完成，但不构成运行验证。预算校准、整改后测试与发布仍待授权和证据闭合。
