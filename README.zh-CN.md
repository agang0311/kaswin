# Kaswin

[English](README.md) | 中文

Kaswin 是基于 Kaspa L1 的抽奖协议与单页面应用，使用 SilverScript 合约和 JavaScript/TypeScript 客户端。当前主实现已改为 Rolling，通过单活动片与冻结片记录购票历史。应用**仅支持 Testnet 10，不支持主网**。

候选 Profile 为 `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`，状态仍为 **UNVALIDATED**。重组后的统一核心编译与一致性校验（`16` 源文件 / `48` 产物）、隔离候选页面构建、合约/真实 VM/差分测试（`58/58`）、单元测试（`105/105`）及离线 Playwright/证据测试（`14/14`）已由 `tester` 验证通过；现有 `dist/` 页面与线上部署保持未改（新的实链运行与发布切换为 **NOT_RUN**）。

## 开始使用

需要 Node.js 22 或更新版本。后续获得明确构建授权后，可在项目根目录执行：

```sh
npm ci
npm run build
```

`npm run build` 默认构建 TN10；`npm run build:tn10` 是同一目标的别名。不支持主网构建模式。主入口 `build/build.mjs` 导出 `buildKaswin`，输出为：

```text
dist/
  index.html
  build-manifest.json
```

构建编译统一 TypeScript 核心，打包应用并内嵌固定合约产物，生成自包含 HTML；不重新编译 SilverScript。manifest 描述产物及输入来源，不代表测试通过、节点兼容或生产批准。后续构建会覆盖这些输出文件；目录中已有文件不代表重组后的源码已完成构建。

## 项目结构

```text
build/       统一核心编译、HTML 打包与显式合约工具
contracts/   五份 SilverScript 源码、模板、固定产物与 pins
scripts/     协议核心、链连接、轮次、存储、追踪与钱包
web/         app/ 应用编排；ui/ 模板、样式与视图
tests/       contracts/ 合约与 VM；web/ 集成；unit/；helpers/
docs/        架构、开发、重组记录与 Rolling 历史资料
```

主运行时入口为 `scripts/core.mjs`。Rolling 协议与通用基础能力合并在 `scripts/core/src/`，由 `build/core.mjs` 统一生成 `scripts/core/lib/`，不再维护第二套 Rolling 核心构建。只读索引器位于 `scripts/indexer/`，浏览器索引客户端位于 `scripts/round/`。

网页入口为 `web/app/app.ts`。共享英文基础词典为 `web/ui/messages-common-en.mjs`，Rolling 词典为 `web/ui/messages-en.mjs`。见[运行时目录](scripts/README.md)、[网页目录](web/README.md)及[合约目录](contracts/README.md)。

## 合约、网络与交易状态

Rolling 使用 `sales`、`sealed`、`win`、`refund`、`frozen` 五模板。固定 `.sil` 源码和 `artifacts/*.json` 位于 `contracts/`，模板输入位于 `contracts/templates/`，身份固定信息位于 `contracts/pins.json`。`build/compile-contracts.mjs` 与 `build/prepare-sources.mjs` 仅用于显式合约重新生成，与普通 HTML 构建分开。

默认节点沿用 `scripts/chain/tn10.mjs` 中原 V2.0.2 的 `TN10.web.nodes` 配置；默认索引为 `https://indexer.kaspay.top/tn10`。这是配置约定，本轮未检查端点可用性或 Rolling API 兼容性。钱包层包含内存签名与 KasWare、Kastle、Kaspire 等扩展接入；迁移后未复测这些集成。

交易被区块包含不等于被接受。Indexer/REST 用于发现，客户端仍须根据自身节点接受数据与协议规则核验交易和状态；金额使用 bigint 或十进制字符串。源码迁移不转换 V2.0.2 轮次，也不批准 Rolling Profile。

详见[架构说明](docs/ARCHITECTURE.md)、[开发说明](docs/DEVELOPMENT.md)及[重组记录](docs/REORGANIZATION.md)。[Rolling 历史资料](docs/rolling/README.md)与[此前集成交接](docs/ROLLING-INTEGRATION-HANDOFF.md)保留原证据边界，历史通过结果不自动覆盖本轮布局。
