# Kaswin F3.2 / V2 验证记录与边界

## 2026-10-08 Profile 7aaf76fe... TN10 真实链上三流程全生命周期验证（Level N，全部 12 笔交易 Selected-Chain 接受）

- **用户明确授权**：“取消不必要的vm测试要求，授权进行 TN10 链上广播测试”。
- **目标 Profile**：`7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`（绑定新 432,000 DAA 超时、手续费真实输入输出守恒、退款执行款强制锁定）。
- **网络与节点**：Kaspa Testnet 10，连接 `wss://tn10.kaspay.top/wrpc`。
- **钱包隔离与安全**：专用测试钱包（创建者 `qrg05u...`、买家一 `qqhgp2...`、买家二 `qzf372...`），私钥存储于 `0600` 文件，未泄露。单笔费用严格 $\le 0.5\text{ TKAS}$（实测单笔仅 $0.00236 \sim 0.032884\text{ TKAS}$）。
- **排除项**：按既定授权，Action 9（`TIMEOUT_REFUND`）排除链上广播测试。

### 1. 实验一：零买退款全生命周期（`empty-r1`，终局 `EMPTY`）
- `01-GENESIS`: txid `a081e42cd884c36f57bb298aebb5c10b3a90ea1baf594b616ec3e9a228af9668`，接受块 `d18ef2d1...`，DAA `591123861`，费用 0.00236 TKAS (236,000 sompi)。
- `02-CLOSE_EMPTY`: txid `77ba15ab222dcd778ba1abfafc780fd97e8bd4ac828fe3277b5049724c515d5b`，接受块 `b5ac67a8...`，DAA `591124221`，费用 0.012904 TKAS，终局 `EMPTY`，0.2 TKAS 押金原路全额退还。

### 2. 实验二：不足最低票数退款全生命周期（`refund-r1`，终局 `REFUNDED`）
- `01-GENESIS`: txid `76a7db3504f2eb3651e55b7cba3a6ac1944fab236e4a1fe13635038912c5d8a8`，接受块 `b783472a...`，DAA `591128399`，费用 0.00236 TKAS。
- `02-BUY1`: txid `827bf4c1ba14e51a95b4a9e6c5abff24c9f1afb3b0d5817c8d1415a8230b6b86`，接受块 `0d45a901...`，DAA `591128522`，费用 0.012982 TKAS。
- `03-BUY2`: txid `7ed89349ae4ad685f38be4be3d9155e223ee769d2d88a9900088a5b6e3125676`，接受块 `f19f2a24...`，DAA `591128639`，费用 0.013056 TKAS。
- `04-CLOSE`: txid `6d745a882855c4ffba79fbee73a226c90e07925a6d46fd9b67176aac1be6bfa1`，接受块 `bc02fe38...`，DAA `591128956`，费用 0.032884 TKAS。
- `05-REFUND`: txid `58cf3b08e0a8c4c09c5f832bc8be770059a1e0998e05c3ed3455f25f334af50c`，接受块 `52615db6...`，DAA `591129109`，费用 0.021422 TKAS，终局 `REFUNDED`，买家每条退款 0.99 TKAS，退押金 0.2 TKAS，赞助输入本金与执行款余额返还创建者。

### 3. 实验三：正常开奖派奖全生命周期（`payout-r1`，终局 `PAID`）
- `01-GENESIS`: txid `2d57c605e8a888bb66101ae09b2acaef0229ca703b47ad74d642a4eb42b082cb`，接受块 `2ebae0c6...`，DAA `591130635`，费用 0.00236 TKAS。
- `02-BUY1`: txid `21f7ef4d30a098f7dd893512fcc3e13734341e33fa8d87bb30607ba4d780f2a4`，接受块 `f1ae759b...`，DAA `591130756`，费用 0.012982 TKAS。
- `03-BUY2`: txid `2d4cb634c3dae5e67e5ce50f946ba4970bbdfa599271b71f2d6576ec49de3a1b`，接受块 `a2123d24...`，DAA `591130873`，费用 0.013056 TKAS。
- `04-CLOSE`: txid `b7103ce247f8523aa280042d0685e756af6c1c8ad929144ad72cdc492d52cf35`，接受块 `3890f844...`，DAA `591131174`，费用 0.026082 TKAS。
- `05-DRAW_AND_PAY`: txid `872cb8146298db489a7fe9c02bf70ea23be849fa21e68b38ca8636efa4e8e78e`，接受块 `c051b22f...`，DAA `591131699`，费用 0.014766 TKAS，终局 `PAID`，中奖者 Buyer1 获得 1.985234 TKAS，退还押金 0.2 TKAS，执行者赏金 1.0 TKAS。

**全部 12 笔交易在 Kaspa TN10 选中链 100% 确认通过，证据已完整落盘于 `tests/tn10/evidence/`。**

## 2026-10-07 合约收紧／新Profile（仅编译与只读候选）

[完整记录](CONTRACT-HARDENING-20261007.md)：所有动作fee等于真实输入输出差且为正、≤0.5 TKAS；REFUND末输出绑定actor；超时432000 DAA。固定silverc已编译并逆拓扑重编复现，Profile `7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`。TS14源→42文件一致。`budgetProfileId:null`，默认交易build继续阻断；`build:candidate`仅生成明确禁用计划/签名/提交的单文件与manifest，dist同步；旧HTML/manifest保存在archive。不运行单测、浏览器、SDK、VM或链上测试；无新txid/accepted/mass/fee记录，不继承下方旧Profile测试结果。

## 历史：2026-10-07 前轮静态审查整改（仅源码与编译，未测试／未发布）

[整改Preflight及实施结果](REMEDIATION-20261007.md)。H1/H2/M1/M3/M4/L1以源码修复；M2恢复预算发布阻断，没有生成VM证据或改预算公式伪装校准完成。三份SIL、linked artifact、Profile与旧HTML均未变；pins仅撤回budgetProfileId。

执行范围：固定TypeScript 5.8.3编译，14源→42生成文件一致；esbuild0.28.2只内存编译单HTML，未写发布产物；`node --check`静态语法检查及diff空白核对。**没有运行Node单测、浏览器、SDK、VM、链上或网络查询**。新增`remediation.test.mjs`八个本地回归场景只是测试源码，未执行；原生IDB跨标签页仍需后续验证。前次审查中57 pass/1 TODO发生在修改前，不能用于本次。

本机Indexer adapter同步使用同一纯解释器，未重启/部署；线上修复未成立。现有release/dist SHA `6509ee1420003380484cc472763e2782a152e796a08874aa7fac5f4a3944e495`保持原样，包含整改前代码。编译不能替代安全运行验证。

## 2026-10-06 V2 三流程执行测试（正常开奖派奖、零买退款、不达最低票数退款；超时退款未测）

- 用户明确授权执行测试，同时明确指令：“派奖超时退款不要测”。
- 真实构建产生：
  - TypeScript 5.8.3 编译核心库，`check-core.mjs` 验证通过。
  - silverc 固定二进制逆拓扑编译生成 V2 Profile：`206d4ec7072727ae3291726f19c82293b38340a5a7de05d306cf105c4206a9c3`。
  - `check-compile.mjs` 离线重编逐字节一致。
- **Level L（本地模拟链与重放）**：
  - `apps/kaswin-v2/test/user-flows.test.mjs`：3 项流程全部 PASS。
  - 1. 正常开奖派奖：GENESIS -> BUY 3 -> CLOSE (SEALED) -> DRAW_AND_PAY (PAID 终局)，赢家/押金/赏金三输出校验无误，reconcile ACCEPTED，`replayAccepted` 独立重放通过。
  - 2. 零买退款：GENESIS -> 0 票 -> 截盘 CLOSE (EMPTY 终局)，押金 0.2 TKAS 原路退回创建者，reconcile ACCEPTED，`replayAccepted` 独立重放通过。
  - 3. 不达最低票数退款：GENESIS (min 5) -> BUY 2 -> 截盘 CLOSE (进入 REFUNDING) -> REFUND (REFUNDED 终局)，买家退款、押金返还及执行者补贴校验无误，reconcile ACCEPTED，`replayAccepted` 独立重放通过。
  - 4. 派奖超时退款：严格遵守指令，未运行任何测试。
- **Level V（真实 Kaspa TxScriptEngine 虚拟机）**：
  - 运行 `silverscript-lang/tests/v2_user_flows_vm.rs`：
    - `DRAW_AND_PAY_NORMAL_WINNER`：`true` (115,829 units)
    - `CLOSE_EMPTY_DEPOSIT_RETURN`：`true` (90,733 units)
    - `CLOSE_SUB_MINIMUM_TO_REFUNDING`：`true` (211,018 units)
    - `REFUND_SUB_MINIMUM_TERMINAL`：`true` (107,321 units)
    - 派奖超时退款：未运行。
- **Level N（真实 Testnet 10 链上实验，11/11 交易全部 selected chain accepted）**：
  - 用户指令：“链上测试”。专用测试钱包，单笔费用均 ≤ 0.023 TKAS（远低于 0.5 TKAS 上限）。
  - 连接节点：`wss://tn10.kaspay.top/wrpc`。
  - 1. **零买退款全流程**：GENESIS (`15237815...`) -> 等待截盘 -> CLOSE_EMPTY (`6b1d0799...`) -> 终局 EMPTY，0.2 TKAS 押金原路全额退还。
  - 2. **不达最低票数退款全流程**：GENESIS (`9e1f94a0...`) -> BUY 1 (`90929ef0...`) -> 等待截盘 -> CLOSE_TO_REFUNDING (`0da1d715...`) -> REFUND_TERMINAL (`f6dc65dd...`) -> 终局 REFUNDED，买家退款 0.99 TKAS，创建者退押金 0.2 TKAS。
  - 3. **正常开奖派奖全流程**：GENESIS (`72dc6763...`) -> BUY 2 (`a419cb29...`) -> BUY 1 (`d192d959...`) -> 满票 CLOSE_TO_SEALED (`68d73f24...`) -> 封存等待 100 DAA -> 节点采集真实 PASS-A 证明 -> DRAW_AND_PAY (`dd850362...`) -> 终局 PAID，发放赢家奖金 1.990318 TKAS、退创建者押金 0.2 TKAS、发放执行者赏金 1.0 TKAS。
  - 4. **派奖超时退款（TIMEOUT_REFUND）**：严格排除，**未在链上运行**。
  - 证据落盘：`/root/kaswin/research/tn10/v2-live-experiment-evidence.json`。
- **Level N 边界**：仅限 Testnet 10 专用测试钱包，禁止主网。

## 2026-10-06 V2源码修复：仅S，未执行

当前修复见 [V2-SOURCE-STATUS](V2-SOURCE-STATUS.md)。只完成源码编辑与人工阅读：228B/8与6参数、逆拓扑链接、origin认证、跨Profile输入占用、独立Indexer、测试与工具入口修订。未编译、未运行单测/VM/浏览器/SDK/check-links，未访问网络、签名广播、提交或发布。旧3446例预算与f256开奖不能转作新Profile证据。

本轮等级采用S=源码、L=本地编译/模拟、V=VM、N=网络；只有S。下方旧报告的R与N是历史自定义分类，特别是旧N表示未验证项，**不是本轮网络证据**。下方通过数、产物哈希和旧复现命令均属于当时快照；当前 `verify:deployed` 已移除，不能据此声称V2同源或通过。

日期：2026-10-05。记录分层重构后的实际验证范围、执行命令、输出哈希与不可逾越的边界。本记录遵循最小必要测试原则，严格区分离线模拟、只读公网复验、已部署产物回读与未验证项，不将模拟通过伪称为真实链上或安全审计通过。

---

## 证据等级与分类

| 等级 | 含义 | 本次覆盖范围 |
|---|---|---|
| **S (Source / Spec)** | 固定规范与源码核对 | SilverScript v1.0.0 (`3ed97333`)、rusty-kaspa (`cfafeb4c`)、固定 Profile (`7ca61d81`)、三帧 pins 与构造参数 |
| **L (Local Build & Harness)** | 本地编译、离线模拟与单机回归 | TypeScript 5.8.3 源码一致性核对、esbuild 0.28.2 单文件构建、50 项离线单测、4 项 UI 浏览器测试、E2E 双语与 LAN 模拟、REST 备用生命周期模拟、编译重放工具 |
| **R (Read-Only Public Services)** | 外部公网服务只读复核 | 公共节点 (`wss://tn10.kaspay.top/wrpc`) 与 Indexer (`https://tn10.kaspay.top/indexer`) 真实数据读取，公网已部署 HTML 逐字节回读 |
| **N (Negative / Non-Scope)** | 明确未验证 / 禁止项 | 无真实私钥、无主网/真实资金广播、无未经授权的测试网签名交易、无未核验的第三方 npm 包 |

---

## 交付构建物与哈希对照

| 构建物 | 路径 | 字节数 | SHA256 | 角色与依据 |
|---|---|---|---|---|
| **已部署快照** | `releases/kaswin-v2/deployed-20261005.html` | 310,601 | `ab90da23a4df6dc966fb45902ce402259efeb4906e014d960aa8712da354bad9` | 2026-10-05 线上交付文件逐字节副本；公网回读（R 级）证据所属对象 |
| **分层重建产物** | `releases/kaswin-v2/index.html` | 310,605 | `29a49a621e85215a0f1101b07ce2283a85320de9d281d30f6eb2f0e3062450f0` | 由分层目录（`contracts/f3.2`、`packages/f3.2-core`、`apps/kaswin-v2`）完全脱机构建产物；本地全量测试（L 级）所属对象 |
| **构建清单** | `releases/kaswin-v2/build-manifest.json` | — | — | 包含 40 项构建输入 SHA256、Profile ID、帧来源、端点变换及部署快照关联信息 |

### 构建复现证明（`npm run verify:deployed`）
分层重建产物 `29a49a62...` 与部署快照 `ab90da23...` 的 4 字节差异源自 `visual/icons.mjs` 物理抽出为独立 ES 模块所产生的打包边界。运行：
```bash
npm --prefix apps/kaswin-v2 run verify:deployed
```
该命令在内存中将 `visual/icons.mjs` 原样并回控制器打包，逐字节产出 `ab90da23...`（310,601 字节，SHA256 完全一致），证明分层源码与已上线版本逻辑与数据 100% 同源。

---

## 本地执行结果（Level L）

所有测试在干净导出环境（仅含 git tracked/staged 文件，无未跟踪文件）中执行通过：

### 1. 核心库源码一致性（`npm run check:core`）
- **工具**：TypeScript 5.8.3（内存编译 `packages/f3.2-core/tsconfig.json`）。
- **结果**：`src/` 下 13 个 TypeScript 模块编译生成的 39 个文件（`.js`、`.d.ts`、`.js.map`）与提交的 `lib/` 逐字节一致，无任何过时或游离文件。
- **无运行时依赖**：核心库不引入任何第三方运行时 npm 包或 WASM SDK。

### 2. 视觉层依赖隔离守卫（`npm run build` 内置）
- **检查**：`tools/build.mjs` 遍历 esbuild metafile 中 `apps/kaswin-v2/visual/` 的所有依赖输入。
- **规则**：视觉层仅允许引用 `visual/*` 内文件以及两处纯数据/格式化辅助（`shared/core.mjs` 的数值/时间格式化器与常量、`rest.mjs` 的 `recordStatus` 状态映射），严禁依赖 `engine`、`wallet`、`nodes`、`chain` 或提交锁。
- **负例验证**：在临时副本中向 `view.mjs` 注入 `import {Engine} from '../scripts/shared/engine.mjs'`，构建立即拒绝并退出。

### 3. 单元测试（`npm test`）
- **命令**：`node --test test/*.test.mjs`（50 项测试，全部 PASS，0 失败）：
  - `endpoints.test.mjs`（9 项）：LA 默认端点、明文连接提示、多版本配置迁移、退休端点游标迁移。
  - `engine.test.mjs`（18 项）：离链游标修复、reorg 处理、24h UNKNOWN 资产保护、有界祖先查找、完整无奖金路径对账、钱包字段防篡改。
  - `i18n.test.mjs`（4 项）：语言偏好回退、词条占位符与安全状态翻译完整性、动态金额保留、时区与语言解耦。
  - `protocol.test.mjs`（2 项）：VM 校准预算覆盖度、创世预算与未校准动作拦截。
  - `rest.test.mjs`（12 项）：无凭据 GET 规范、字段全等比对、404/false 证词生命周期、节点与 REST 冲突裁决。
  - `view.test.mjs`（5 项）：状态说明、时间/DAA 换算、钱包流水拆分。

### 4. 浏览器 UI 与本地传输测试（`npm run test:ui`）
- **环境**：Playwright 1.63.0 / Chromium 153.0.8010.12。
- **子项与报告**：
  - `browser-check.mjs`：测试 1360/390/320 宽度下离线骨架、表单约束、无外部网络请求泄漏；报告输出于 `test-results/browser-smoke-report.json`（errors: 0）。
  - `browser-i18n.mjs`：测试上海（`Asia/Shanghai`）、洛杉矶（`America/Los_Angeles`）、柏林（`Europe/Berlin`）三时区及明暗主题切换；双语往返词条 0 缺失；报告输出于 `test-results/i18n-browser-report.json`（errors: 0, untranslated: []）。
  - `browser-plaintext.mjs`：测试本机 `127.0.0.1` 与局域网 `192.168.1.201` 真实 HTTP/WS 传输、设置保存与无证书提示；报告输出于 `test-results/plaintext-browser-report.json`（errors: 0, httpsAdvisorySave: true）。
  - `browser-endpoints.mjs`：测试配置版本升级与旧端点过滤；报告输出于 `test-results/endpoints-migration-report.json`（errors: 0, retiredRequests: []）。

### 5. 端到端模拟与 REST 恢复（`npm run test:e2e`）
- **`browser-e2e.mjs`（中文与英文 `--en`）**：
  - 启动本地真实 WebSocket 服务（模拟 TN10 节点 wRPC）与模拟 Indexer。
  - 模拟 KasWare（采用公开测试标量 1，不使用真实密钥）。
  - 完整跑通生命周期：GENESIS → BUY x3 → CLOSE (SEALED) → 提早超时拦截校验 → TIMEOUT_REFUND → REFUND。
  - 7 次提交全部由模拟节点验证 selected-chain 接受，各笔交易输出数分别为 `[3, 2, 2, 2, 2, 2, 5]`。
  - 英文模式下验证切换语言不重置表单与报价，无漏译；报告输出于 `test-results/e2e-report.json` 与 `test-results/e2e-en-report.json`（errors: 0）。
- **`browser-e2e.mjs --lan`**：
  - 绑定真实局域网 IP `http://192.168.1.201:46833`，验证非安全上下文（`isSecureContext: false`）下的离线加密回退与流程完整性；报告输出于 `test-results/e2e-lan-report.json`（errors: 0）。
- **`browser-rest.mjs`（中文与英文 `--en`）**：
  - 模拟真实 IndexedDB 与第三方 REST 裁剪历史查询：
    1. 批量覆盖：REST 证据仅消除展示层 pending，不合规者维持 UNKNOWN。
    2. 持久性：页面刷新后外部证据展示状态保持。
    3. 404 处理：REST 404 绝不重发交易或释放已占用 UTXO。
    4. 证词撤回：REST 返回 `is_accepted: false` 时平滑退回 UNKNOWN，绝不误判为 REJECTED。
  - 报告输出于 `test-results/rest-browser-report.json` 与 `test-results/rest-browser-en-report.json`（checks: 4, errors: 0）。

### 6. 合约可选编译重放（`check-compile.mjs`）
- **工具**：`contracts/f3.2/tools/check-compile.mjs`。
- **环境**：指定 SilverScript v1.0.0 编译器二进制（SHA256: `81de9aa4157dbde3633ebab629e86c5975770fc13ee2d2093e52d7f725616a00`，与历史 `build-report.json` 一致）。
- **验证**：对 `src/{open,sealed,refunding}.sil` 携带公开构造参数编译，输出 linked JSON 与仓库内 `contracts/f3.2/artifacts/` 逐字节一致，重算帧哈希与报告完全匹配。工具拒绝覆盖已有文件。

---

## 外部服务与公网回读（Level R）

### 1. 真实默认端点只读复核（`npm run test:live`）
- **命令**：`node test/browser-i18n.mjs --live`。
- **目标**：默认节点 (`wss://tn10.kaspay.top/wrpc`)、Indexer (`https://tn10.kaspay.top/indexer`)。
- **结果**：三时区读取真实轮次广场数据，0 页面错误，0 漏译；报告输出于 `test-results/i18n-live-report.json`。

### 2. 线上交付物回读
- **验证方式**：对线上交付 HTML 进行只读回读与 SHA256 完整性核验。
- **状态**：HTTP 200，大小与 SHA256 逐字节一致。
- **多端点只读响应**：zh-CN 与 en-US 下 1360/390 宽度各加载 12 张卡片，0 退休端点请求，0 控制台错误。

---

## 明确未验证边界与安全限制（Level N）

1. **真实钱包生命周期未在当前环境广播**：
   - 本次发布及测试中严禁网络广播；未使用任何真实私钥或助记词。
   - KasWare 插件在真实浏览器扩展环境下的交互未在本发布动作中发起真实签名上链。
2. **节点历史裁剪不可逆**：
   - Testnet 10 节点的 UTXO 验证与区块体保留受剪枝窗口限制（约 30 小时 / 108,000 DAA）。更早轮次的 PASS-A 随机证明或历史交易若无法取得有效区块头，节点将报 `the queried hash does not have retention root on its chain`。无论前端如何迁移，均无法绕过此共识限制。
3. **REST 证据绝非链上共识**：
   - REST 索引（`api-tn10.kaspa.org`）仅作为历史定位线索；其证据仅供前端展示，绝不能作为释放资金、覆盖底层 UNKNOWN 或推进后继交易的依据。
4. **网络安全与浏览器限制**：
   - 网页提供明文 `ws://` 与 `http://` 连接配置，但受现代浏览器混合内容（Mixed Content）、CORS 及私网访问策略（Private Network Access）制约。静态单 HTML 本身无法强行解除浏览器的同源限制。
5. **历史 V1 资产界限**：
   - 根目录下保留的 V1 文档、测试与工具（归档于 `docs/legacy-v1/`）为历史审计记录，不属于 F3.2 / V2 运行闭包，严禁交叉混用。
