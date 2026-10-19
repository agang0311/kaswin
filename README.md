# Kaswin

基于 Kaspa L1 的抽奖协议与单页面应用，使用 SilverScript 合约和 JavaScript/TypeScript 客户端。网页支持 Testnet 10 与主网、KasWare 钱包、轮次创建、购票、开奖、退款及交易状态核验。

## 开始使用

需要 Node.js 22 或更新版本。

```sh
npm ci
npm run build
```

构建先编译 TypeScript 核心库，再生成自包含 HTML。输出位于：

```text
dist/
  index.html
  build-manifest.json
```

`index.html` 可部署到 HTTPS 静态站点；manifest 记录构建模式、合约身份、工具版本及源码和产物哈希，不包含测试结果。构建不访问网络、不使用钱包、不部署页面。

## 构建模式

| 命令 | TN10 | 主网 |
|---|---|---|
| `npm run build` | 只读 | 只读 |
| `npm run build:tn10` | 可交易 | 只读 |
| `npm run build:mainnet` | 可交易 | 可交易 |

所有模式写入同一个 `dist/`，后一次构建替换前一次产物。也可显式传入参数，例如 `npm run build -- --mode=mainnet`；支持的模式为 `readonly`、`tn10`、`mainnet`。

交易模式由构建参数决定，网页切换网络不会改变权限。主网使用真实 KAS，签名仍须用户逐笔确认；TN10 另支持页面内存测试钱包。构建成功表示产物已生成，业务测试、真实钱包流程和链上验证在构建后独立进行。本项目当前未配置自动化测试入口。

## 项目结构

```text
build/       核心库编译与 HTML 打包
contracts/   SilverScript 源码、账本布局与固定编译产物
scripts/     协议核心、链连接、钱包、轮次、存储与追踪
web/         应用交互、HTML 模板、样式与多语言
docs/        架构与开发说明
```

核心库源码位于 `scripts/core/src/`，生成文件位于 `scripts/core/lib/`。`npm run build:core` 单独编译核心库；`npm run check:core` 独立比较生成文件与源码，不能代替业务测试。

## 合约与交易

当前使用合约 V2.0.2，Profile 为 `ed0387c9e77bb4e0a8f1f4654a326c316d83663f455283ec6a046a095c94856d`。HTML 构建加载固定合约产物并检查源码、模板和 Profile 一致性，不重新编译 SilverScript。

Kaspa 交易被区块包含不等于被接受。Indexer/REST 用于发现数据，实际状态由节点接受数据与协议规则核验；金额使用 bigint 或十进制字符串。

详见[架构说明](docs/ARCHITECTURE.md)和[开发说明](docs/DEVELOPMENT.md)。
