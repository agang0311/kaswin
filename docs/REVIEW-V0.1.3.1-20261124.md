# Kaswin `v0.1.3.1`（`75789c6`）与线上单页 `win.kaspay.top` 全面审查报告（2026-11-24）

## 1. 审查对象、证据层级与线上一致性核验

- **源码仓库**：`https://github.com/agang0311/kaswin`（分支 `main`，HEAD 提交 `75789c6dabca9b7d2bc6f3f2cf8a3d5b490cfa8d`，对应 GitHub Release `v0.1.3.1`，发布时间 `2026-11-24T02:44:40Z`）。
- **线上站点**：`https://win.kaspay.top/`（含按需脚本 `https://win.kaspay.top/kaspire-wc.js` 与构建清单 `https://win.kaspay.top/build-manifest.json`）。
- **参考共识与编译器源码**：本机固定 `rusty-kaspa v2.1.0`（`references/rusty-kaspa-v2.1.0`）与 `silverscript v1.0.1`（`references/silverscript-v1.0.1`）。
- **验证边界（遵守用户约定）**：本次为**静态源码审计 + 发布产物与线上 HTTP 响应比对**。未运行项目单测、重构建、TypeScript/语法检查、离线 VM、浏览器自动化或任何真实链上交易/广播（全部运行项记为 `NOT_RUN`）；未读取任何私钥/钱包文件，未改动任何业务源码或历史存档 `/root/kaswin-publish-20261005`。

### 线上产物与 GitHub Release `v0.1.3.1` 逐字节核对结果

| 资产 | 线上 URL | 字节数 | SHA-256 | 与 GitHub Release `v0.1.3.1` 比对 |
|---|---|---:|---|---|
| 主页面 HTML | `https://win.kaspay.top/` | `899,237` | `4951d1a811878a0d982779c19d2cadb433a0c9261a6e07390d2ada8ddbaabdb6` | **100% 逐字节一致**（同 `kaswin.html` 及 `build-manifest.json.artifact.sha256`） |
| Kaspire WC 模块 | `https://win.kaspay.top/kaspire-wc.js` | `475,857` | `c9f687ad6fe90f1e5954f8d771de859bc734bd325901c2618ec98d20873212e9` | **100% 逐字节一致**（同 Release `kaspire-wc.js`） |
| 构建清单 | `https://win.kaspay.top/build-manifest.json` | `108,741` | `78bd045f3afb1d845e384dea7b2084c2e63a4268995949b495dc88901226c72b` | **100% 逐字节一致**（`mode="mainnet"`, `mainnetTrading=true`, `evidence="UNVALIDATED"`） |

---

## 2. 总体结论（**不建议当前主网承载真实资金，存在 P0 阻断项**）

`v0.1.3.1` 在一个默认主网可交易的前端中同时开放了两套协议：**kUSDT v2（7 模板 256 并行分片，页面默认选中）**与 **Rolling v1（5 模板滚动分片）**。经合约层、协议运行时、前端/钱包层与部署层交叉审查，共确认 **2 项 Critical（P0）、7 项 High（P1）、4 项 Medium（P2）、4 项 Low（P3）**：

1. **合约层存在可直接盗取奖池或永久锁死诚实买家资金的 P0 漏洞（C-01）**：`contracts/kusdt-v2/m_open.sil` 缺失规范空创世根校验（对比 `contracts/sales.sil` 的 `checkRoot`），链下也未校验规范空创世推导。攻击者可在创世 `M_OPEN` 预埋受控 `evilShardCid`，实现 **0 kUSDT 成本虚增选票抽走 >99.999% 诚实奖池**，或预埋不可冻结脚本将后续所有诚实买家的 kUSDT 与 KAS 分片押金**永久锁死在链上**。
2. **运行时提交层破坏了 Kaswin 核心的“未决意图持久化不重发”安全不变量（C-02）**：`controller.mjs` 对 `kusdt-v2` 直接调用 `c.rpc.call('submitTransaction')`，漏设 `e.submissionAttempted=true`，导致任何网络超时、断连或节点拒单均被 `statusAfterFailure(e)` 恒定误判为 `'UNSENT'` 并**立即删除本地意图（`GENESIS` 甚至直接删库）**，提示用户“交易没有发出，请重试”，极易引发主网重复购票或重复锁押金。
3. **KCI 信任边界失守、PASS-A 确认门缺失与多协议接线断裂（H-01..H-07）**：包括页面可输入的票价区间可触发 `s_refund.sil` 永久锁死、未验证的 KCI `terminal` 直接跳过 100% 节点核验并展示绿色 `✓ 已向节点核对`、`kusdt-v2` 开奖在签名后与广播前未复核 PASS-A 100 blueScore 确认、`#join=` 分享导入对 `kusdt-v2` 100% 失败、以及主网直接开放文档标注 `UNVALIDATED`（仅面向 TN10）的合约 Profile。

---

## 3. 分级缺陷清单与源码定位

### P0 / Critical（阻断上线：主网资金被盗、永久锁死或双花扣款）

#### [C-01] `kusdt-v2` `m_open.sil` 缺失规范空创世根校验（`checkRoot`），可 0 成本盗取诚实奖池或永久锁死全部诚实分片
- **定位**：
  - 合约：[contracts/kusdt-v2/m_open.sil](../contracts/kusdt-v2/m_open.sil#L110-L130)（对比 Rolling v1 [contracts/sales.sil](../contracts/sales.sil#L165-L173) 的 `checkRoot`）
  - 链下校验与同步：[scripts/protocols/kusdt-v2/round.mjs](../scripts/protocols/kusdt-v2/round.mjs#L59-L83)（`validateKusdtV2Round`）、[scripts/protocols/kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L1360-L1376)（`syncRound`）
- **根因**：
  - Kaspa 创世交易不执行输出脚本。攻击者可以任意初始字节创建 `M_OPEN` UTXO 并获得合法 `managerCid`。
  - `m_open.sil` 仅校验 `state` 格式与 `length(state) == 60 + 68 * openedCount`（`OPEN_SHARD` 仅要求 `cursor == 0 && totalTickets == 0 && openedCount < MAX_SHARDS`，而在 `COLLECT_BATCH` 前 `totalTickets` 恒为 `0`），**从未验证 `managerCid` 必须由 `openedCount == 0` 的规范空 `M_OPEN` 创世输出推导**；链下 `validateKusdtV2Round` 与 `syncRound` 同样不核验规范创世根，只要节点上存在该 `M_OPEN` UTXO 即标为 `nodeVerified = true`。
- **攻击路径 A（0 kUSDT 质押虚增票权，接近 100% 概率抽走全部诚实买家的 kUSDT）**：
  1. `T1`：攻击者花费 2 KAS 创建创世 covenant UTXO `evilShardCid`，锁定在受控脚本（如 `P2SH(<attackerPk> OP_CHECKSIG)` 或 `P2SH(OP_TRUE)`）。
  2. `T2`：攻击者花费 4 KAS 创建创世 `M_OPEN`（`managerCid`），预填 `openedCount = 1, cursor = 0, totalTickets = 0, entries[0] = (evilShardCid, ZERO, 0)`。
  3. `T3`（可在开售时预填如 `60,000` 票且 `recordCount = 256` 满载避免诚实买家误选该分片，也可等 `closeDaa` 到期、诚实买家全部买完后再执行）：攻击者花费 `evilShardCid` 延续同一 `covenant_id = evilShardCid`，锁定到真实 `S_OPEN_HASH` 脚本，填入 `managerCid`、`recordCount = 256` 及 `cumTickets = 2,000,000,000`（全部指向 `attackerPk`），**全程不创建、不注入任何 KCC-20 金库**。
  4. 结算：`COLLECT_BATCH`、`DRAW`、`DISPATCH_BATCH` 全程不读取 KCC-20 金库。`evilShardCid` 合法冻结为 `S_FROZEN`；`DRAW` 以 $\frac{2\times 10^9}{2\times 10^9 + T_{\text{honest}}} > 99.999\%$ 概率抽中 `attackerPk`；`DISPATCH_BATCH` 将所有诚实分片 `1..N` 转为 `S_PAYOUT(winnerPk = attackerPk)` 并退回攻击者 4 KAS 管理押金；攻击者对每个诚实分片 `1..N` 调用 `PAYOUT_SELF` 提走 100% 诚实买家的 kUSDT。
- **攻击路径 B（Rug-Freeze 永久锁死全部诚实买家资金）**：
  - 同上预填 `entries[0] = evilShardCid`，但将其锁在 `P2SH(OP_FALSE)`。诚实买家在分片 `1..N` 正常执行 `OPEN_SHARD` / `BUY` 锁入真实 kUSDT 与每片 4 KAS 押金。到期后 `COLLECT_BATCH` 必须从 `cursor = 0`（`entries[0]`）开始且强制校验 `S_OPEN_HASH`（`m_open.sil:253`），永远失败；而 `s_open.sil` 无独立超时退款出口，导致**分片 `1..N` 内所有诚实 kUSDT 与 KAS 押金永久锁死**。
- **修复建议**：
  1. 合约层（需升级 `m_open.sil` 并重冻结模板哈希）：参照 `sales.sil` 增加 `checkRoot(originTxId, originIndex, tail)`，强制证明 `managerCid` 由 `openedCount=0, cursor=0, totalTickets=0, decision=0, reserved=0` 的规范空 `M_OPEN` 创世输出推导。
  2. 链下与索引层（可立即止血拦截伪造轮次展示与交互）：在 `validateKusdtV2Round`、`syncRound` 及 KCI 中强制获取创世 `origin` 并校验规范空 `M_OPEN` 派生的 `covenantId === round.cid`，不满足者一律拒绝认证并禁止购买。

#### [C-02] `kusdt-v2` 的 `signAndSend()` 漏设 `submissionAttempted`，将所有超时/断连/拒单恒定当作 `'UNSENT'` 并抹除待决意图
- **定位**：
  - [scripts/round/controller.mjs](../scripts/round/controller.mjs#L666-L675)、[controller.mjs](../scripts/round/controller.mjs#L263-L266)、[controller.mjs](../scripts/round/controller.mjs#L852-L865)
  - 对比：[scripts/tracking/intent.mjs](../scripts/tracking/intent.mjs#L60-L80)、[scripts/chain/nodes.mjs](../scripts/chain/nodes.mjs#L173-L201)、[web/app/app.ts](../web/app/app.ts#L608-L619)
- **根因与后果**：
  1. `rolling-v1` 通过 `submitIntent()` 在 `beforeSend` 同步栅栏内置 `sent = true`，并在 `catch` 中写入 `e.submissionAttempted = sent`。
  2. `kusdt-v2` 在 `controller.mjs:668` 直接调用 `await c.rpc.call('submitTransaction', ...)`，`JsonRpc.call()` 从不设置 `e.submissionAttempted`。一旦抛出任何异常（包括 `this.ws.send(text)` 已经把签名交易发往节点后的 `RPC_TIMEOUT` / `NODE_DISCONNECTED`，或节点返回的 `RpcError`），`statusAfterFailure(e)`（`!e.submissionAttempted ? 'UNSENT' : ...`）**100% 返回 `'UNSENT'`**。
  3. `setIntentStatus(p.cid, intent, 'UNSENT')` 立即清空 `r.intent = null`（若为 `GENESIS` 则直接从 `RoundStore` 删除整轮记录），前端弹出 `"交易没有发出，请重试。"`。用户点击重试即造成**二次购票扣款或二次创建轮次锁押金+烧 0.2 KAS**；同时 `status === 'REJECTED'` 的冲突诊断分支对 `kusdt-v2` 成为不可达死代码。
  4. 此外 `controller.submitProtocolTx()`（`controller.mjs:852-865`）完全绕过 `roundStore.persistent` 检查与发前意图持久化。

---

### P1 / High（资金锁死风险、信任边界失守、核心流程损坏）

#### [H-01] 创世票价与 `closeDaa` 缺少合约上限校验，前端合法输入可触发 `s_refund.sil` 链上永久锁死
- **定位**：[web/ui/views.ts](../web/ui/views.ts#L223-L224)（`parseCreate`）、[scripts/protocols/kusdt-v2/codec.mjs](../scripts/protocols/kusdt-v2/codec.mjs#L27-L31)、[scripts/protocols/kusdt-v2/tx.mjs](../scripts/protocols/kusdt-v2/tx.mjs#L225-L241)，对比 [contracts/kusdt-v2/s_refund.sil](../contracts/kusdt-v2/s_refund.sil#L113) 与 [m_open.sil](../contracts/kusdt-v2/m_open.sil#L120-L121)
- **根因**：
  1. 前端 `parseCreate()` 允许最高 12 位整数 kUSDT 票价（`<= 999,999,999,999 kUSDT`，即 `9.999... * 10^17` 最小单位）。若票价设在 `(5 * 10^17, 9.999... * 10^17]` 区间，`CREATE_ROUND`、`OPEN_SHARD(qty=1)`、`COLLECT_BATCH`（总票数 1~2 张转退款）与 `DISPATCH_BATCH(REFUND)` 全部链上通过；但一旦进入 `S_REFUND`，`s_refund.sil:113` 强制 `require(price <= TOKEN_AMOUNT_LIMIT / 2)`（`<= 5 * 10^17`），导致 **4 KAS 分片押金与 KCC-20 金库永久锁死**。
  2. 构造器 `buildCreateRoundTx()` / `encodeMHeader()` 仅检查 `u63`，未校验 `m_open.sil:120-121` 要求的 `price <= 10^18` 与 `closeDaa < DAA_LIMIT - 432_000`（`499_999_568_000`）；超界创世一旦上链，管理片 4 KAS 押金永久无法花费。

#### [H-02] `kusdt-v2` 的 `discard()` 跳过全部安全门禁；`trackRoundIntent({recover: true})` 顺序颠倒把已确认交易误标为 `'REJECTED'`
- **定位**：[scripts/round/controller.mjs](../scripts/round/controller.mjs#L745-L750)、[scripts/protocols/kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L2341-L2386)
- **根因**：
  1. `controller.discard()` 对非 `rolling-v1` 协议跳过内存池检查、输入存活检查、接受历史搜索及 `LOST_GRACE_MS`（3 分钟冷却），直接清空 `intent: null`（或删除未核验的 `GENESIS` 轮次），允许用户在原交易仍在内存池或已上链时立即发起重复交易。
  2. `trackRoundIntent({recover: true})` 先检查 `intent.draft.inputUtxos` 是否仍未花费（`2341-2358`），后检查 `intent.txid` 输出是否已在链上生成（`2360-2386`）。若用户的交易实际上已被打包确认（自然花掉了自己的输入），点击“重新发送（原签名）”会因 `spent.length > 0` 将已成交意图误判为 `status: 'REJECTED'`（`UTXO ... already spent`）。

#### [H-03] KCI 索引信任边界失守：未验证的 `det.terminal` 跳过 100% 节点探测、伪造“✓ 已向节点核对”并封锁结算/退款入口
- **定位**：[scripts/protocols/kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L1385-L1401)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L1485-L1525)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L1640-L1804)、[controller.mjs](../scripts/round/controller.mjs#L450)、[web/app/app.ts](../web/app/app.ts#L360)、[app.ts](../web/app/app.ts#L456)
- **根因**：
  1. 从广场首次打开一轮 `kusdt-v2` 时（本地尚无 `localMgrLive`），若 KCI 返回任意非空 `det.terminal`（如 `'PAID'`，甚至未校验枚举值），`syncRound()` 直接令 `terminal = detTerminal` 并**跳过全部管理片与分片的节点 wRPC 探测**（0 次节点查询）；随后 `app.ts:456` 的 `isNodeVerified(r) => !!r.terminal` 返回 `true`，显示绿色 **`✓ 已向节点核对`** 徽章，同时隐藏所有 `PAYOUT_*` / `CLAIM_REFUND` / `CLOSE` / `DRAW` 按钮，导致用户无法通过界面取回奖金、退款或押金。
  2. `M_OPEN` 阶段只要管理片在节点存活即设 `nodeVerified = true`（即使分片缺少 `redeemHex` 或分片节点探测失败），从不在 `syncRound` 中探测 KCC-20 金库 UTXO，且取 `Math.max(..., detTicketsSold)`（KCI 报 `65536` 即可锁死前端购买按钮），并将未验真的 `det.draw` 直接写入 `round.draw`，短路了 `app.ts:360` 的 `verifyKusdtDrawReceipt()` 链上开奖核验。
  3. `kusdt-v2` 适配器中的 `authenticateIntent`、`submitIntent`、`verifyIndexedSnapshot`（`kusdt-v2.mjs:1278-1291`）均为空操作桩函数。

#### [H-04] `kusdt-v2` 开奖未在签名后、广播前及恢复重发时强制执行 PASS-A `>= 100` Blue-Score 确认门，且所有交易 0-DAA 即终局化
- **定位**：[scripts/protocols/kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L2117-L2167)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L2356-L2400)、[controller.mjs](../scripts/round/controller.mjs#L668)（对比 `rolling-v1` [intent.mjs](../scripts/tracking/intent.mjs#L69-L77)）
- **根因**：
  1. `prepareForController('DRAW')` 仅在构造草稿时调用一次 `acquirePassAProof()`，生成的 `prepared.drawConfirmation` 从未被后续读取；直接调用 `prepareOperation('DRAW')` 则完全跳过确认检查。
  2. 用户在钱包（尤其移动端 Kaspire 最长等待 120s）签名期间若发生选中链重组导致目标块 `T` 跌出主链或不足 100 blueScore，`signAndSend()` 与 `trackRoundIntent({recover: true})` 均不会像 `rolling-v1` 那样执行 `confirmDrawTargetWithRetry` + `beforeSend` 同步 `assertFreshDrawConfirmation` 复核，而是直接广播失效证明交易。
  3. `trackRoundIntent()` 一旦在节点 UTXO 集见到输出（0 DAA 深度）即标记 `finalized: true` 并清空 `intent = null`，缺少 `rolling-v1` 的 `round.pending` + `REORG_RECHECK_DAA = 100n` 候选复核机制。

#### [H-05] 多协议分发与内部 Schema 分裂：`kusdt-v2` 分享链接/文件导入 100% 失败，`round.mjs` 与 `kusdt-v2.mjs` 字段互不兼容
- **定位**：[scripts/round/controller.mjs](../scripts/round/controller.mjs#L390)、[controller.mjs](../scripts/round/controller.mjs#L871-L879)、[scripts/protocols/kusdt-v2/round.mjs](../scripts/protocols/kusdt-v2/round.mjs#L46-L245)
- **根因**：
  1. `controller.cachedPreview()` 与 `controller.importText()` 硬编码调用 `defaultAdapter`（`rolling-v1`），任何 `#join=` 分享码或导出的 `kusdt-v2` JSON 导入均因按 `rolling-v1` 解析而报错失败。
  2. `kusdt-v2.mjs` 运行时将管理脚本存于 `round.manager.redeemScript`、分片数组存于 `round.kusdt.shards`；而子模块 `kusdt-v2/round.mjs` 的 `decodeManagerFromRound`、`availableKusdtV2Actions`、`kusdtV2Summary`（即 `ctl.summaryOf`）和 `kusdtV2RoundFromText` 全部读取 `round.manager.redeem` 与对象字典 `round.shards`，导致对真实轮次调用 `ctl.summaryOf(r)` 恒返回 `0 票 / 0 分片`、`adapter.availableActions(r)` 恒返回 `[]`。

#### [H-06] 忽略跨轮 `roundStore.reserved()` 输入预留、批处理漏验分片存活且错位游标、KCC-20 钱包冲突误判
- **定位**：[controller.mjs](../scripts/round/controller.mjs#L604-L614)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L981-L1085)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L2082-L2098)、[scripts/tracking/conflict.mjs](../scripts/tracking/conflict.mjs#L16-L24)
- **根因**：
  1. `controller.prepare()` 分派给 `prepareForController` 时未传入 `await roundStore.reserved()`，会选中其他轮次未决意图已锁定的 KAS 或 KCC-20 UTXO，待用户完成钱包签名后才在 `roundStore.replace()` 抛 `INPUT_RESERVED_BY_PENDING_INTENT`。
  2. `COLLECT_BATCH` / `DISPATCH_BATCH` 未向节点核对分片 UTXO 是否刚被并发 `BUY` 花掉，且使用 `.filter(s => s.outpoint && s.redeem)`——若 `shards[cursor]` 缺失 `redeem`，后续 `shards[cursor+1]` 会被前移到 `input[1]`，构造出必定链上失败的错位批次交易。
  3. `conflict.mjs` 以 `hit.covenantId ? 'ROUND_INPUT' : 'FUNDS_INPUT'` 判断内存池双花冲突；买家自己的 KCC-20 代币 UTXO 带有 `covenantId = MAINNET_KUSDT_CID`，导致用户自身钱包多端并发花费代币被误报为“别人先操作了这一轮（ROUND_INPUT）”。

#### [H-07] 主网发版门禁与仓库内置 Indexer 脱节：`UNVALIDATED` 合约在主网开放真实资金交易，且内置 Indexer 不支持主网与 `kusdt-v2`
- **定位**：[contracts/README.md](../contracts/README.md#L3)、[contracts/pins.json](../contracts/pins.json#L4)、[contracts/toolchain.json](../contracts/toolchain.json#L21-L23)、[contracts/kusdt-v2/README.md](../contracts/kusdt-v2/README.md#L4)、[build/build.mjs](../build/build.mjs#L51-L125)、[scripts/indexer/config.mjs](../scripts/indexer/config.mjs#L36-L37)、[scripts/indexer/service.mjs](../scripts/indexer/service.mjs#L232-L398)
- **根因**：
  1. `contracts/README.md` 明确声明 Rolling v1 Profile `b56bcd9c...` 为 **`UNVALIDATED`、仅面向 Testnet 10**，`toolchain.json` 记录 `rollingTests: NOT_RUN`、`rollingVm: NOT_RUN`；`kusdt-v2/README.md` 亦声明 TN10/主网实链与 acceptance 为 `NOT_RUN`。但 `v0.1.2.5`（`e319ca4`）移除了界面 `UNVALIDATED` 警示标签，线上 `win.kaspay.top` 默认开启 `mode="mainnet"` 与 `mainnetTrading=true`。
  2. 仓库内 `scripts/indexer/` 硬编码仅允许 `testnet-10` + `rolling-v1`，不扫描 `KASWIN_KUSDT_V2_GENESIS`，缺失 `/covenants/:cid` 与 `/wallets/:pk/activity`（404），且对 `kusdt-v2` 请求的 `roundHistory(limit=200)` 返回 HTTP 400（上限 100）。线上 `kusdt-v2` 完全依赖仓库外未开源/独立演进的 `indexer.kaspay.top` 及外部 KCC-20 索引服务（`kascov.io` / `kasvio.network`）。

---

### P2 / Medium（链上边界行为、Mass/输入上限、裁剪降级与 Web 部署安全）

#### [M-01] `OPEN_SHARD` 未钉死创世 `authorizing_input` 可致 REST 同步中断；`closeDaa` 后及封盘中途仍允许链上 `BUY`；`lockTime` 存在 1-DAA 边界偏差
- **定位**：[m_open.sil](../contracts/kusdt-v2/m_open.sil#L134-L205)、[s_open.sil](../contracts/kusdt-v2/s_open.sil#L122-L165)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L449-L476)、[kusdt-v2/round.mjs](../scripts/protocols/kusdt-v2/round.mjs#L139)
- **详情**：
  1. `rusty-kaspa v2.1.0` 的 `CovenantsContext::from_tx` 允许创世输出 `1`（`shardCid`）将 `authorizing_input` 指向任意不含 `shardCid` 的输入（如 `0` 或 `2..7`）并通过共识与合约检查；但 `catchupKusdtManagerViaRest()` 硬编码用 `inAt(1)` 重算 `expectedShardCid`，一旦遇到此类合法交易即校验失败并 `break`，永久卡住该轮的 REST 管理片追赶。
  2. `OPEN_SHARD` 在 `cursor == 0` 时不检查 `closeDaa`；独立分片 `s_open.sil` 的 `BUY` 不含 `closeDaa` 且不关联管理片，因此在 **`closeDaa` 之后乃至 `COLLECT_BATCH` 分批封存中途**，任何尚未归集的分片 `j ∈ [cursor, openedCount-1]` 链上仍可继续 `BUY`（晚间买家可观察前序分片精确票数后再大额下单，或用 1 票交易反复抢跑干扰 `COLLECT_BATCH`，上限每片 255 次）。
  3. 共识要求 `tx.lock_time < ctx_daa_score` 才终局化，故 `m_open.sil` 的 `lockTime = closeDaa` 实际需 `currentDaa >= closeDaa + 1` 才能进块，比 `round.mjs` 的 `daa >= closeDaa` 晚 1 DAA。

#### [M-02] `addKasFundingAndChange` 默认 `maxInputs = 16` 超出多个合约输入上限，且未吸收粉尘找零易触发 `STORAGE_MASS_LIMIT`
- **定位**：[scripts/protocols/kusdt-v2/tx.mjs](../scripts/protocols/kusdt-v2/tx.mjs#L171-L198)、[tx.mjs](../scripts/protocols/kusdt-v2/tx.mjs#L391)、[tx.mjs](../scripts/protocols/kusdt-v2/tx.mjs#L547-L982)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L1239-L1253)
- **详情**：
  1. 仅 `buildBuyTx` 传了 `maxInputs: 8`；`buildPayoutTx` / `buildClaimRefundTx` 允许最多 16 输入（违反 `s_payout.sil` / `s_refund.sil` 的 `<= 8`），`buildEmptyCloseTx` / `buildDrawTx` / `buildRerollTx` 允许 16 输入（违反 `<= 9`），`COLLECT_BATCH` / `DISPATCH_BATCH` 在 `k < 7` 时允许超过 8 个普通资金输入（违反 `for(..., 8)` 展开上限）。碎 UTXO 钱包构造出的交易通过本地检查与签名后会在链上被拒。
  2. 只要 `change > 0n` 即立即停止选币并生成找零输出；当找零落入 `(0, ~0.02 KAS)` 时 KIP-0009 存储质量 `10^12 / change > 500,000` 直接抛 `STORAGE_MASS_LIMIT`（即便钱包还有更多 UTXO 可合并，或本可将该粉尘并入手续费）。此外显式传入 `fee` 时 `prepareOperation` 未经 `quoteMass()` 校验上限。

#### [M-03] KCI 宕机/节点裁剪降级缺口、TN10 默认误创 `kusdt-v2` 死轮陷阱，以及 Kaspire 取消签名锁死弹窗 120 秒
- **定位**：[controller.mjs](../scripts/round/controller.mjs#L350-L366)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L376-L890)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L2006)、[kusdt-v2.mjs](../scripts/protocols/kusdt-v2.mjs#L2093-L2153)、[web/app/app.ts](../web/app/app.ts#L95)、[app.ts](../web/app/app.ts#L554-L561)、[scripts/wallet/kaspire-wallet.mjs](../scripts/wallet/kaspire-wallet.mjs#L295)
- **详情**：
  1. `kusdt-v2` 创建轮次向登记地址支付不可退 `0.2 KAS`，但 `refreshIndex()` 的 REST 备选仅识别 `rolling-v1`；KCI 不可用且本机未缓存 `frozenRedeem` 时，缺少从 `COLLECT_BATCH` 交易重建 `S_FROZEN` 原像的 REST 回退，导致 `DRAW` 与 `DISPATCH_BATCH` 无法构造；REST 追赶还硬编码了 `maxHops = 16` 与 `?limit=20` 上限。
  2. 切换到 `tn10` 后创建页仍默认选中 `kusdt-v2`（合约硬编码主网 `KUSDT_CID`）；在 TN10 创建 `kusdt-v2` 会真实上链锁住 `4 TKAS` 并烧掉 `0.2 TKAS`，但永远无法购买（只能等 `closeDaa` 后 `EMPTY_CLOSE`）。
  3. Kaspire 的 `sign(draft)` 忽略第二参数 `{signal}`，用户在签名弹窗点击“取消等待”后模态框仍保持 `lockModal(true)` 锁死长达 120 秒，且若手机端随后确认签名仍会继续广播已取消的交易。

#### [M-04] 线上 `win.kaspay.top` 外部脚本缺少 SRI 完整性校验，且 HTTP 响应头缺少防点击劫持（`frame-ancestors` / `X-Frame-Options`）与 HSTS
- **定位**：[web/ui/index.template.html](../web/ui/index.template.html#L13)、[scripts/wallet/kaspire-wallet.mjs](../scripts/wallet/kaspire-wallet.mjs#L44-L56)、[build/build.mjs](../build/build.mjs#L118-L127)、线上 `win.kaspay.top` 响应头
- **详情**：
  1. 为拆出 `kaspire-wc.js`（475 KB），CSP 的 `script-src` 从仅允许内联脚本 SHA-256 放宽为 `'sha256-...' 'self'`，且动态注入 `<script src="./kaspire-wc.js">` **未设置 `script.integrity`（SRI）**，`build-manifest.json` 的 `artifact` 字段也未记录 `kaspire-wc.js` 的哈希（同时使 Release 说明中“整个应用就是一个自包含 HTML 文件”不再完全成立：单存 `kaswin.html` 时点击 Kaspire 会加载失败）。
  2. 线上 `https://win.kaspay.top/` 仅靠 HTML `<meta http-equiv="Content-Security-Policy">`，未下发 HTTP 层 `Content-Security-Policy: frame-ancestors 'none'` 或 `X-Frame-Options: DENY`（W3C 规范下 `<meta>` CSP 无法生效 `frame-ancestors`，页面可被第三方恶意站点 `<iframe>` 嵌套实施点击劫持），亦未下发 `Strict-Transport-Security`（HSTS），且 `<meta>` CSP 的 `connect-src` 同时放行了明文 `http: ws:`，响应头还带有宽泛的 `access-control-allow-origin: *`。

---

### P3 / Low（纵深防御、参数一致性与体验细节）

- **[L-01] `s_refund.sil` 免签退款未设最小 KAS 载体下限 & KCC-20 找零载体提示偏差**：`s_refund.sil:183-195` 调用 `checkKcc20Output(..., minValue = 1)`（未像 `s_payout.sil` 那样要求 `1.5 KAS`），第三方可抢先将买家退款推入仅含约 `0.08~0.09 KAS` 载体的细胞；此外客户端生成的用户 KCC-20 输出全部硬编码 `borrowScheme = 0`，合并 2~3 个代币细胞时会锁入 2~3 KAS 载体，而确认框文案硬编码为“含 1 KAS 代币载体”。
- **[L-02] `findLiveVaultUtxo` 漏检 `u.value === 200_000_000n`**：`kusdt-v2.mjs:1114-1124` 查找活跃分片金库时未过滤 `value === SHARD_VAULT_DEPOSIT`（2 KAS），在小额分片上攻击者可向同一金库 SPK 转入同额代币但 `< 2 KAS` 的诱饵 UTXO，干扰客户端选错金库输入导致上链失败。
- **[L-03] Rolling v1 执行者奖励输出未绑定 witness `actorKey`**：`contracts/templates/common.sil.inc:127-132` 的 `chosenPayment` 只验金额与 P2PK 形状（已在 `tests/redteam/ROLLING-RESULTS.md` 记录），免签结算交易可被内存池观察者零成本替换执行者收款地址（不影响赢家、创建者与买家资金）。
- **[L-04] 构建溯源固定项遗漏**：`contracts/kusdt-v2/artifacts/template-pins.json` 未记录源码/产物 SHA-256；`build/build.mjs` 打包时未调用 `verifyKcc20Suffix()` 自检，且 `build-manifest.json.inputs` 漏列 `contracts/kusdt-v2/*.sil` 与 `kcc20-suffix.json`。

---

## 4. 已核验成立的正向安全性质（排除误报）

1. **DOM XSS 防护稳固**：`web/ui/ui.ts` 的 `html` 模板默认转义全部插值；全仓仅 5 处 `raw()`，入参均为静态字面量或受控 SVG 图标表，`i18n.mjs` 仅改写文本节点与安全属性，未发现基于远端轮次/地址/错误信息的 DOM XSS。
2. **钱包私钥与本地验签隔离良好**：主网构建硬禁用内存私钥输入；`extension-wallet.mjs` 与 `kaspire-wallet.mjs` 均坚持不让钱包广播，返回签名后强制校验交易主体未篡改（`committed`）并逐输入执行本地 Schnorr `SIGHASH_ALL` 验签（含 KCC-20 脚本见证偏移量外字节零篡改校验 `verifyScriptSignatures`）。
3. **kUSDT v2 诚实轮次（`openedCount == 0` 创世）的核心守恒与活性成立**：7 份模板的编译字节码、Tail 长度、`templateHash` 与 `constants.mjs` 100% 吻合；KCC-20 后缀哈希固定绑定真实主网 `KUSDT_CID` 且禁止 `PATH_BORROW` 伪造金库；`DRAW` 56 位取模无拒绝死锁，且 GhostDAG 保证 `Δdaa_score >= Δblue_score`，故 `OpChainblockSeqCommit` 不会早于 432,000 DAA 的 `REROLL` 过期。

---

## 5. 架构审查必答：25 问 Preflight 核对

| # | 现行设计与源码核对 | 审查状态 |
|---:|---|---|
| 1 | 实例身份为网络域内 `managerCid`；多协议通过 `ProtocolRegistry` 按 `profileId` 分发 | **H-05 OPEN**（导入/预览未按协议分发） |
| 2 | Rolling v1 强制 `checkRoot` 空创世根推导；**kUSDT v2 `m_open.sil` 缺失创世根推导证明** | **C-01 BLOCKED** |
| 3 | 管理片 `1:1` 续接或终局销毁；kUSDT v2 分片为创世派生的独立 `shardCid` | 诚实路径成立，创世预埋受 C-01 影响 |
| 4 | 链上权威状态在活跃 P2SH UTXO 与 KCC-20 金库；`S_FROZEN` 原像仅哈希上链 | **H-03 / M-03 OPEN**（KCI 终态盲信、缺原像回退） |
| 5 | `creatorPk`、`price`、`closeDaa`、固定模板哈希创建后不可改 | **H-01 OPEN**（创世超界参数可锁死） |
| 6 | 阶段、分片目录、游标、累计票数与退款掩码按合约动作单调推进 | 设计明确 |
| 7 | Rolling 7 动作；kUSDT v2 含 `OPEN_SHARD/BUY/EMPTY_CLOSE/COLLECT_BATCH/DRAW/REROLL/DISPATCH_BATCH/PAYOUT_*/CLAIM_REFUND` | 设计明确 |
| 8 | 购票由买家签普通 KAS 与 KCC-20 输入；封盘/开奖/下发/自领奖/退款对合约免签，输出受合约钉死 | 设计明确（L-01/L-03 细节可加固） |
| 9 | 单轮单管理片串行续接；kUSDT v2 购票分散在最多 256 个独立分片并行续接 | 设计明确 |
| 10 | 输出索引、金额上限、P2PK/P2SH 脚本与 KCC-20 账本逐位校验 | **M-02 OPEN**（构造器输入上限未对齐合约） |
| 11 | 固定 `0x6b + pushState + tail` 与 `templateHash` 跨模板校验 | 7+5 模板哈希核对一致 |
| 12 | `OpCovInputCount` / `OpAuthOutputCount` / `OpCovOutputCount` 约束组内唯一性 | **M-01 OPEN**（`OPEN_SHARD` 未钉 `authInput==1`） |
| 13 | 状态字节长度、版本号、游标边界与前缀和严格递增均在合约内校验 | 设计明确 |
| 14 | 发前持久化意图、未知结果只对账不替换、跨轮输入预留 | **C-02 / H-02 / H-06 BLOCKED** |
| 15 | 真实 `sum(inputs) - sum(outputs) <= FEE_CAP`；KAS 押金与 KCC-20 票款分账守恒 | 诚实轮次成立；C-01 伪造轮次可绕过金库背书 |
| 16 | kUSDT v2 通过多活动分片降低同轮购票争用；跨轮无共享链上状态 | **M-01 / H-06 OPEN**（封盘期争用与本地预留缺失） |
| 17 | 单轮上限 256 分片 × 256 笔记录；VM 预算已在离线校准覆盖极值 | kUSDT v2 有离线 VM 表；Rolling v1 仍标 `UNVALIDATED` |
| 18 | 跨分片采用目录 + 批量游标归集/下发（`MAX_BATCH=8`） | 设计明确 |
| 19 | `EMPTY` / `PAID` / `REFUNDED` 终局销毁状态 UTXO；历史标签不等于节点确认 | **H-03 / H-04 OPEN** |
| 20 | 空轮退押、中奖派发、1~2 票退款及 `432,000 DAA` 超时/重掷均有链上出口 | **C-01 / H-01 / M-03 OPEN** |
| 21 | Indexer 仅作只读发现与原像辅助，节点核验才可授信 | **H-03 / H-07 OPEN** |
| 22 | 缺少 KCI 时需能靠节点 + REST / 本地快照恢复与推进 | **M-03 / H-05 OPEN** |
| 23 | 跨阶段转换全部校验下一阶段固定 `templateHash` 与 KCC-20 扩展模板哈希 | 设计明确 |
| 24 | kUSDT v2 与外部 KCC-20 同笔原子组合；无跨合约任意无界读取 | 设计明确 |
| 25 | 有界分片抽奖适合 Kaspa L1 Covenants++，未引入全局共享状态 | 架构适合 L1，需先修复实现与创世根漏洞 |

---

## 6. 14 项架构材料与 8 项反模式核查摘要

### 14 项架构材料核对
1. **UTXO 清单**：Rolling v1（`manager` + `frozen[]` + 普通收款）；kUSDT v2（`M_*` 管理片 4 KAS + `S_*` 分片账本 2 KAS + `KCC-20` 分片金库 2 KAS + 用户 KCC-20 细胞 + 普通 KAS/登记输出）。
2. **状态编码**：Rolling `KW` 账本；kUSDT v2 管理片 `60 + 68N` / `92 + 32N` B，分片 `76 + 36rc` / `110` / `44 + 36rc` B，KCC-20 `112` B。
3. **谱系与根身份**：Rolling 有 `checkRoot`；**kUSDT v2 缺失 `checkRoot`（C-01）**。
4. **状态转换图**：kUSDT v2 `M_OPEN ⇄ OPEN_SHARD / S_OPEN ↺ BUY → COLLECT_BATCH → M_SEALED(↺REROLL) → DRAW → M_DISPATCH → S_PAYOUT/S_REFUND → PAID/REFUNDED`。
5. **UTXO 拓扑**：跨轮完全隔离；同轮多并行分片购票互不阻塞，归集与下发按 `MAX_BATCH=8` 聚合。
6. **逐动作 I/O 与守恒**：合约内校验 `checkFee(50_000_000)` 与精确存款额，但构造器输入数上限与粉尘找零需对齐（M-02）。
7. **签名与授权**：买家签自身 KAS/KCC-20 输入，推进动作免签；钱包返回签名经本地二次验签。
8. **后继约束**：延续与销毁均由 `OpCovInputCount` / `OpAuthOutputCount` / `OpCovOutputCount` 闭合。
9. **核心不变量**：诚实创世下票款守恒；**非诚实创世（C-01）与发后异常抹意图（C-02）破坏核心不变量**。
10. **活性与退出**：`REROLL` 解决 `seqCommit` 窗口过期；但 C-01 恶组分片、H-01 超界票价、M-03 缺 `frozenRedeem` 均构成退出阻断。
11. **Indexer 边界**：设计要求只读不可信，当前 `kusdt-v2` 对 `det.terminal` / `ticketsSold` / `det.draw` 越界授信（H-03）且内置 Indexer 未支持（H-07）。
12. **并发与争用**：并行分片缓解购票争用；需补齐 `closeDaa` 后购买窗口说明/防护与本地跨轮预留（M-01 / H-06）。
13. **L1 适配性**：`MAX_BATCH=8` 在 500k 计算质量与 1M 瞬态质量内留有充足余量。
14. **发布与供应链边界**：线上产物与 GitHub Release `v0.1.3.1` 哈希一致，但需补齐 `kaspire-wc.js` SRI、HTTP 安全头及正式实链/治理准入（H-07 / M-04）。

### 8 项反模式审查

| # | 反模式 | 当前审查结论 |
|---:|---|---|
| 1 | 全局共享状态管理所有用户 | **未触犯**：每轮独立 CID，轮内进一步做 256 并行分片 |
| 2 | 只验签名不验后继状态 | **未触犯**：合约逐输出校验 P2SH/P2PK、金额与 KCC-20 状态 |
| 3 | **仅凭相同 CID 即信任状态合法** | **触犯（C-01）**：`m_open.sil` 与链下校验未证明 `managerCid` 源自规范空创世根 |
| 4 | **让 Indexer 裁决资金或可操作状态** | **部分触犯（H-03）**：未向节点核验即采信 KCI `terminal` 并伪造“已向节点核对”且封锁结算按钮 |
| 5 | Solidity 账户模型生搬硬套 | **未触犯**：原生 UTXO + Covenants++ 分片归集/下发模型 |
| 6 | 为图省事做无必要的全局串行锁 | **未触犯**：kUSDT v2 专门用独立分片消除了单 UTXO 购票串行瓶颈 |
| 7 | 缺少终止出口或异常锁死路径 | **触犯（C-01 / H-01 / M-03）**：预埋坏分片、高票价退款越界、无 KCI 时缺 `frozenRedeem` 可致锁死 |
| 8 | 只验字节片段不验模板与谱系 | **局部缺口（C-01 / M-01）**：跨阶段 `templateHash` 完整，但创世根谱系与 `OPEN_SHARD` `authInput` 未闭合 |

---

## 7. 修复优先级建议

1. **立即止血（主网安全阻断）**：
   - 在修复 **C-01** 与 **C-02** 前，建议暂停 `win.kaspay.top` 主网新建/参与 `kusdt-v2` 轮次（或先切回只读/TN10 模式）。
   - **C-01 修复**：在 `m_open.sil` 增加 `checkRoot` 重编译冻结新 Profile，并在客户端 `validateKusdtV2Round` / `syncRound` 与 KCI 立即强制核验创世交易 `origin -> 空 M_OPEN -> cid`。
   - **C-02 + H-02 修复**：让 `kusdt-v2` 复用 `submitIntent` 的 `beforeSend` `submissionAttempted` 语义、`discard()` 四重安全门禁，并将 `trackRoundIntent({recover: true})` 改为**先查交易是否已被接受、再查输入是否存活**。
2. **第二批（协议正确性与信任边界）**：
   - 修复 **H-01**（收紧票价 `<= 5 * 10^17` 即 `<= 500,000,000,000` kUSDT 与 `closeDaa` 上界）、**H-03**（禁止未向节点求证的 `det.terminal` 置 `isNodeVerified` 或隐藏结算按钮，强制调用 `verifyKusdtDrawReceipt`）、**H-04**（签名后与广播前复核 PASS-A 100 blueScore 确认，补齐 100 DAA 候选深度复核）、**H-05**（打通多协议 `importText`/`cachedPreview` 并统一 `round.mjs` 与 `kusdt-v2.mjs` 数据结构）、**H-06**（接入 `roundStore.reserved()`、批处理前核验分片存活且禁止 `.filter` 错位、修正 KCC-20 冲突分类）。
3. **第三批（工程健壮性与站点加固）**：
   - 修复 **M-01..M-04**（REST 追赶直接读 `out1.covenant_id` 并补齐 `COLLECT_BATCH` 交易重建 `frozenRedeem` 回退、按合约动作收紧 `maxInputs` 并吸收粉尘找零、在 TN10 禁用创建主网 `KUSDT_CID` 的 `kusdt-v2` 轮次、为 `kaspire-wallet.mjs` `sign()` 接入 `AbortSignal`、为 `kaspire-wc.js` 增加编译期 SRI 哈希并在 Cloudflare/源站补齐 `Content-Security-Policy: frame-ancestors 'none'`、`X-Frame-Options: DENY` 与 HSTS）。
