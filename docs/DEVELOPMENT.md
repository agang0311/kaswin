# 开发说明

当前开发对象是 Rolling 主实现，支持 **Kaspa 主网（默认）** 与 **Testnet 10** 切换，Profile 保持 **UNVALIDATED**（主网实链资金流转尚未验证）。

## 工具链与主构建

Node.js 要求 ≥22，代码使用 ESM；TypeScript 5.8.3 编译核心和页面，esbuild 0.28.2 打包浏览器程序。依赖按 lock 文件安装。正常 HTML 构建使用固定合约产物，无需运行 SilverScript 编译器。

| 入口 | 用途 |
|---|---|
| `npm run build` | 默认主网主页面构建（页面可切换 TN10） |
| `npm run build:tn10` | 默认 TN10 主页面构建（`--mode=tn10`） |
| `npm run build:core` | 由 `build/core.mjs` 编译统一核心 |
| `npm run check:core` | 独立比较核心源码与生成物，需要明确验证授权 |
| `build/build.mjs` / `buildKaswin` | 主构建文件与导出函数 |
| `build/prepare-sources.mjs` | 显式展开合约模板输入 |
| `build/compile-contracts.mjs` | 显式重新编译固定合约 |

不再使用 `build:rolling`、`build:rolling-core`、`check:rolling-core` 或旧 `build/rolling-tn10.mjs` 作为独立构建流程。

主构建流程为：

1. 编译 `scripts/core/src/`，将 Rolling 协议与通用 primitives 一并生成到 `scripts/core/lib/`。
2. 从 `contracts/` 加载固定五模板产物和身份信息，通过 `scripts/contract/` 提供浏览器数据。
3. 以 `web/app/app.ts` 为入口，合入 `web/ui/` 的模板、样式、视图和词典，并打包 Kaspire WalletConnect 模块。
4. 输出自包含 `dist/index.html`、`dist/kaspire-wc.js` 与 `dist/build-manifest.json`。

manifest 描述构建产物及来源，不包含业务测试通过或部署批准。后续构建会覆盖同名输出，应保留与页面配套的 manifest。本轮没有重新生成现有 `dist/`，不能用现有 HTML 代表迁移后的源码。

## 修改源码

协议代码改在 `scripts/core/src/`；生成的 `scripts/core/lib/` 不手改。运行时统一使用 `scripts/core.mjs`，避免重新引入两套核心。`tests/contracts/` 保留原 MJS 实现用于差分，不应被应用或浏览器打包引用。

轮次控制、准备、预算、同步和开奖位于 `scripts/round/`；多合约插件注册表与具体合约适配器位于 `scripts/protocols/`（新增同类轮次/奖池/分片合约只需在 `build/protocol-bundles.mjs` 与 `scripts/protocols/installed.mjs` 注册，`web/` 无需改动，构建门 `checkGraph` 禁止 `web/` 直接引用具体合约实现）；意图与冲突分类在 `scripts/tracking/`；轮次持久化在 `scripts/store/`；钱包接入与签名在 `scripts/wallet/`。索引服务及归档/节点适配在 `scripts/indexer/`，浏览器索引客户端在 `scripts/round/indexer-client.mjs`。

网页编排使用 `web/app/`；模板、样式和展示使用 `web/ui/`。多语言通过 `web/ui/locales/` 强类型语言包（`schema.ts` 定义 `Locale` 接口，`zh-cn.ts` / `en.ts` 各自实现并通过 `index.ts` 注册）一键切换，不再使用 `MutationObserver` 事后替换 DOM。页面不再位于 `web/rolling-tn10/`。

合约模板输入位于 `contracts/templates/*.sil.in`，共用片段为 `common.sil.inc`；展开的五份 `.sil`、固定 `artifacts/*.json`、`pins.json` 与 `toolchain.json` 集中在 `contracts/`。修改模板、产物字节或 Profile 身份需单独处理重新生成与相应验证，不通过普通 HTML 构建隐式重编合约。原 V2.0.2 的 KW21/`ledger-layout.json` 不再是 Rolling 布局来源。

## 网络和索引配置

应用支持主网与 TN10 双网切换（主网禁用内存明文私钥）。主网与 TN10 默认节点分别来自 `scripts/chain/mainnet.mjs` 与 `scripts/chain/tn10.mjs`，默认 KCI 索引分别为 `https://indexer.kaspay.top/mainnet` 与 `https://indexer.kaspay.top/tn10`。

只读索引器启动文件为 `scripts/indexer/server.mjs`，模块职责见[索引器说明](../scripts/indexer/README.zh-CN.md)。服务端默认回环监听与网页默认公共索引地址是不同配置；源码迁移不会启动服务、修改 systemd/Caddy 或迁移数据库。当前网页使用本地预算，历史 `tn10-service.mjs`/VM 工具留在测试目录，不是网页运行依赖。

## 测试与交接

| 路径 | 保留内容 |
|---|---|
| `tests/contracts/` | 原 `experiments/rolling/` 的合约测试、VM、实验工具和旧 MJS 差分基线 |
| `tests/web/` | 原 `tests/rolling-web/` 网页集成与场景驱动 |
| `tests/unit/` | 原 `web/rolling-tn10/` 单测及索引 sidecar 单测 |
| `tests/helpers/fake-node.mjs` | 共享节点替身 |
| `docs/rolling/` | 原实验说明、验证记录、交接、实链证据与 TSV 账本 |

测试、复测及验收交由 `tester` 在明确授权范围内执行。后续需覆盖统一核心及差分、固定产物加载、浏览器导入与类型、主构建输出、钱包/轮次/存储/索引接线和默认端点兼容性；这些均为待执行事项。TIMEOUT 实链手测仍按用户安排，迁移不扩大网络或钱包授权。

历史通过数字、交易回执和线上哈希保留原日期及产物范围，不附到新源码或新构建上。未来执行记录应标明源码版本、产物哈希、网络、命令范围、实际结果及跳过项。发布与测试分开记录，不能把源码替换写成 `win.kaspay.top` 已切换。

`node_modules/`、生成核心、`dist/`、本地钱包与运行输出不作为源码证据。旧源码归档、迁移映射和被忽略的历史输出路径见[REORGANIZATION.md](REORGANIZATION.md)。
