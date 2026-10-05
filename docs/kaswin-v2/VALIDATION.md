# Kaswin F3.2 / V2 验证记录与边界

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
- **URL**：`https://cd311.cn:888/www/kaswin-v2.html`
- **采样时间**：2026-10-05T00:05:26Z（部署后立即核验）及 2026-10-05T02:26:13Z（发布前再次核验）。
- **状态**：HTTP 200，大小 310,601 字节，SHA256 为 `ab90da23a4df6dc966fb45902ce402259efeb4906e014d960aa8712da354bad9`，与 `deployed-20261005.html` 完全相同。
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
