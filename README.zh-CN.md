# Kaswin

**基于 Kaspa L1 的无需许可、无后台服务器的链上抽奖协议与纯静态应用。**

[English](README.md) | 中文 · [在线体验](https://win.kaspay.top) · [历史发布](https://github.com/agang0311/kaswin/releases) · [更新日志](CHANGELOG.md)

Kaswin 是开源的 Kaspa Layer-1 抽奖协议与单页网页应用，基于 [SilverScript](https://github.com/kaspanet/silverscript) Covenant 合约与 TypeScript/JavaScript 客户端构建。全部票款与奖金由链上合约直接托管——没有后台服务器、没有管理员私钥，也没有平台抽成。

## 核心特性

- **100% 链上合约托管**：票款保管、开奖与派奖全部由 Kaspa L1 Covenant 强制执行，**0% 平台手续费**，仅需支付 Kaspa 网络矿工费。
- **双资产插件化协议**：开箱支持两套 L1 Covenant 抽奖协议：
  - **`kUSDT`（KCC-20，`kusdt-v2`）**：主网稳定币奖池，支持最多 8 条活动通道并发购票。
  - **`KAS` / `TKAS`（`rolling-v1`）**：支持主网与 Testnet 10 的原生 KAS 奖池，采用单活动片 + 无限封存片记录购票历史。
- **可独立验证的公平开奖**：封盘后基于未来链上区块承诺通过 `BLAKE2b-256` 确定性计算中奖票号。已开奖轮次详情页内置本地复算，并可一键导出零依赖 Python 3 离线验证脚本。
- **零后端、可任意自托管**：构建产物为自包含静态网页（`dist/index.html` + `dist/kaspire-wc.js`），浏览器直连 Kaspa 节点（wRPC）与可选只读索引器。
- **无需许可的结算与全额退款**：任何人均可推动封盘、开奖、派奖与退款；若封盘时未达最低开奖票数或开奖超时，全部票款与创建押金按合约规则原路退回。
- **多钱包支持**：支持 **KasWare**、**Kastle**、**Kaspire**（WalletConnect）及只读收款地址；主网禁用内存明文私钥，Testnet 10 保留测试内存私钥。

## 工作原理

1. **发起轮次**：选择 `kUSDT` 或 `KAS` 奖池、单张票价与开奖时长，并冻结 4 KAS 创建押金（轮次结束后原路退还创建者）。
2. **购买彩票**：在封盘前任何人均可购票，购买记录写入链上 Covenant 分片。
3. **封盘与开奖**：到达最早可封盘高度后，任何人可触发封盘；若满足最低票数要求，待目标区块达到确认深度后即可根据链上区块哈希确定性开奖。
4. **派奖或退款**：开出中奖者后，任何人均可触发派奖（`rolling-v1` 支持连续批量派奖，`kusdt-v2` 按分片派奖）；未满最低票数或超时未开奖时，任何人均可触发全额原路退票。

## 内置协议与合约 Profile

每套内置协议均通过固定的 64 位十六进制 Contract Profile ID 锚定到构建产物中：

| 协议 | 资产 | 支持网络 | 分片模型 | Contract Profile ID |
|---|---|---|---|---|
| `kusdt-v2` | `kUSDT` (KCC-20) | 主网 | 最多 8 条并发活动分片 | `39a29f4e215a2d264aa1dad63ec61b41633c7ff3822fe8e8c6d888b32d2e5445` |
| `rolling-v1` | `KAS` / `TKAS` | 主网、Testnet 10 | 滚动活动分片 + 封存分片 | `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` |

- **Profile 隔离**：旧版或不同 Profile ID 创建的历史轮次会归入广场底部的「不兼容轮次」（只读），不会与当前轮次混用；如需操作历史 Profile 轮次，可使用 [Releases](https://github.com/agang0311/kaswin/releases) 中对应的历史构建产物。
- **抗节点历史裁剪**：`DRAW` 完成后，即便节点裁剪了早期区块，只要浏览器本地缓存、KCI 索引器、REST 回退或导入/分享快照保有 `redeemScript` 原像，仍可继续完成剩余分片的派奖或退款。

## 本地构建与自托管

需要 **Node.js 22 或更新版本**：

```sh
npm ci
npm run build        # 默认主网产物（可在设置中切换 Testnet 10）
# 或：
npm run build:tn10   # 默认 Testnet 10 产物
```

构建输出至 `dist/`：

```text
dist/
  index.html           # 自包含单页应用（内嵌固定合约产物与 CSP 哈希）
  kaspire-wc.js        # 按需加载的 Kaspire WalletConnect 模块（SRI 校验）
  build-manifest.json  # 可复现的源码哈希、版本号与 compatibleProfiles 清单
  _headers             # 适用于静态托管（如 Cloudflare Pages）的安全响应头
```

将 `dist/` 部署到任意静态托管站点或本地打开即可运行。如需在构建期覆盖默认节点/索引地址，无需修改源码，直接传入 CLI 参数（`--mainnet-indexer`、`--tn10-indexer`、`--mainnet-node`、`--tn10-node`）或对应 `KASWIN_*` 环境变量即可。

## 安全模型与验证边界

- **安全提示**：相关合约尚未经过第三方正式安全审计。参与主网资金交互前请先阅读合约规则并核对交易确认页明细。
- **以节点核验为准**：在 Kaspa L1 上，交易被区块包含不等于被接受（accepted）。索引器与 REST 仅用于只读发现，客户端会对照已连接的 Kaspa 节点与协议规则独立核验 UTXO 状态与交易接受情况。
- **密钥与金额精度**：主网不提供内存明文私钥，签名由钱包扩展或 Kaspire 移动端完成；所有金额均采用 `bigint` 或十进制字符串处理，避免浮点精度误差。

## 仓库结构

```text
contracts/   SilverScript 合约源码、模板与固定产物（rolling-v1 与 kusdt-v2）
scripts/     核心编解码/密码学/mass（TS）、协议插件、链连接、轮次控制器、钱包与索引器
web/         TypeScript 应用编排（app/）与视图、样式、多语言包（ui/）
build/       核心 TS 编译、协议插件打包、单页静态构建与合约工具
tests/       单元测试、合约/VM 审计与浏览器离线回归测试
docs/        架构设计、开发指南与协议规范文档
```

## 进阶文档

- [架构说明](docs/ARCHITECTURE.md)
- [开发指南](docs/DEVELOPMENT.md)
- [合约说明（`rolling-v1`）](contracts/README.md) · [合约说明（`kusdt-v2`）](contracts/kusdt-v2/README.md)
- [运行时与协议脚本](scripts/README.md) · [网页客户端](web/README.md)
- [更新日志与 Profile 兼容策略](CHANGELOG.md)
