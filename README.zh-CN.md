# Kaswin

[English](README.md) | 中文

Kaswin 是基于 Kaspa L1 的抽奖协议与单页面应用，使用 SilverScript 合约和 JavaScript/TypeScript 客户端，通过单活动片与冻结片记录购票历史，默认运行于 **Kaspa 主网**（可在页面切换至 **Testnet 10**），Profile `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` 状态仍为 `UNVALIDATED`。

## 开始使用

需要 Node.js 22 或更新版本：

```sh
npm ci
npm run build
```

`npm run build` 通过 `build/build.mjs`（`buildKaswin`）构建默认主网产物（`npm run build:tn10` 以 `--mode=tn10` 构建默认 Testnet 10 产物），输出为：

```text
dist/
  index.html
  kaspire-wc.js
  build-manifest.json
```

构建会编译 TypeScript 核心（`build/core.mjs`）、打包网页应用并内嵌固定合约产物，生成自包含 HTML 文件，不重新编译 SilverScript。

## 项目结构

```text
build/       核心编译、HTML 打包与合约工具
contracts/   五份 SilverScript 源码、模板、固定产物与 pins
scripts/     协议核心、链连接、轮次、存储、追踪、索引器与钱包
web/         app/ 应用编排；ui/ 模板、样式与视图
tests/       contracts/ 合约与 VM；web/ 集成；unit/；helpers/
docs/        架构、开发与协议文档
```

- 运行时入口：`scripts/core.mjs`（由 `scripts/core/src/` 编译生成至 `scripts/core/lib/`）。
- 索引与客户端：`scripts/indexer/` 为只读索引器，`scripts/round/` 为浏览器索引客户端。
- 网页入口：`web/app/app.ts`；词典位于 `web/ui/messages-common-en.mjs` 与 `web/ui/messages-en.mjs`。详见[运行时目录](scripts/README.md)、[网页目录](web/README.md)及[合约目录](contracts/README.md)。

## 合约、网络与交易模型

- **合约**：使用 `sales`、`sealed`、`win`、`refund`、`frozen` 五模板，源码与固定产物位于 `contracts/`（`contracts/templates/`、`contracts/artifacts/`、`contracts/pins.json`）。`build/compile-contracts.mjs` 与 `build/prepare-sources.mjs` 用于显式重新生成合约，与普通 HTML 构建分离。
- **网络与钱包**：主网与 TN10 配置见 `scripts/chain/mainnet.mjs` 与 `scripts/chain/tn10.mjs`，默认索引为 `https://indexer.kaspay.top/mainnet` 与 `https://indexer.kaspay.top/tn10`；钱包层支持 KasWare、Kastle、Kaspire（WalletConnect）与仅收款地址，主网禁用内存明文私钥，TN10 保留测试内存私钥。
- **派奖、退款与节点裁剪**：`PAY_OLD` 单笔最多合并 16 个封存分片，`REFUND_OLD` / `REFUND_SELF` 每批最多处理 32 条购买记录；网页支持「一键连续派奖」与「一键连续退款」。节点历史裁剪后，只要本机缓存、KCI、REST API 回退或导入/分享快照保有 `redeemScript` 原像，仍可继续完成派奖与退款。
- **状态核验**：交易被区块包含不等于被接受。Indexer/REST 仅用于只读发现，客户端须根据自身节点接受数据与协议规则核验交易和状态；金额使用 `bigint` 或十进制字符串表示。

详见[架构说明](docs/ARCHITECTURE.md)与[开发说明](docs/DEVELOPMENT.md)。
