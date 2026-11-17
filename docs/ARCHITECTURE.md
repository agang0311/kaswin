# 架构说明

Kaswin 当前源码以 Rolling 为主实现，保留 `contracts/`、`scripts/`、`web/`、`build/`、`tests/`、`docs/` 的顶层分层。网络仅为 Testnet 10，候选 Profile `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5` 仍为 **UNVALIDATED**。重组后统一核心、隔离候选页面构建与离线/真实 VM 测试套件已由 `tester` 验证通过；现有 `dist/` 页面与线上部署未改。

## 模块

| 目录 / 入口 | 责任 |
|---|---|
| `contracts/` | `sales`、`sealed`、`win`、`refund`、`frozen` 五份固定源码与产物；`templates/` 保存输入，`pins.json` 固定身份 |
| `scripts/core/src/` | Rolling 状态、Profile、交易、mass、接受解释、收款规则，以及字节、哈希、交易序列化、CID、PASS-A 等通用基础能力 |
| `scripts/core.mjs` | 统一协议入口，连接生成核心与所需密码学/地址能力 |
| `scripts/contract/` | `protocol.mjs` 协议常量与数据格式；`profile-data.mjs` 浏览器 Profile 数据；`bundle.mjs` 固定产物加载 |
| `scripts/chain/` | 网络上下文、节点连接、RPC/REST、费用和接受证据读取；应用只接 TN10 |
| `scripts/round/` | controller、轮次状态、准备与预算、追赶同步、索引客户端、开奖证明及确认 |
| `scripts/store/` | `codec.mjs` 持久化编码；`round-store.mjs` 轮次与意图存储 |
| `scripts/tracking/` | `intent.mjs` 提交意图与恢复；`conflict.mjs` 拒绝和冲突分类 |
| `scripts/wallet/` | 内存钱包、扩展钱包、Kaspire 接入及通用地址/签名能力 |
| `scripts/indexer/` | 只读索引服务及原实验归档、索引、HTTP 和节点接受适配模块 |
| `web/app/` | `app.ts` 入口、`bridge.ts` 运行时接线、类型、设置、分享与环境声明 |
| `web/ui/` | 模板、样式、视图、UI、交互、格式化和词典 |
| `build/` | 统一核心编译与主页面构建；合约重编译为显式工具 |
| `tests/` | 合约/VM/旧 MJS 差分基线、网页集成、单测与节点替身 |

核心不选择端点、不连接节点、不接触 DOM 或钱包。网页通过运行时操作轮次；索引服务与浏览器共享协议核心，但服务端归档和节点扫描器不进入网页运行时。旧 MJS 协议实现留在 `tests/contracts/` 作为差分基线，不构成第二套应用核心。

## 状态与资金

每轮由一个活动管理 UTXO 与若干冻结片 UTXO 组成。管理片保存轮次参数、冻结片索引和当前购票记录；活动记录达到分片边界后，购票历史冻结为独立片，管理片继续接受新购买。

```text
普通资金 → GENESIS → sales
sales → BUY → sales（按边界产生 frozen）
sales → CLOSE → sealed / refund / EMPTY
sealed → DRAW → win
sealed → TIMEOUT → refund
win + frozen → 分批派奖 → PAID
refund + frozen → 分批退款 → REFUNDED
```

这是阶段示意，具体输入输出、尾片合并及动作约束由五模板和核心解释器决定。冻结片不是独立可随意花费的资金：必须与对应管理片、模板、CID、原像、金额及授权上下文一起核验。相同 CID 不足以证明状态合法。

金额在内存中使用 sompi 整数 bigint，对外数据使用十进制字符串。押金、票款、收款、执行者款和网络费分别计算；页面预算来自本地 `scripts/round/budget.mjs`，普通应用不依赖历史预算引擎 HTTP 服务。合约约束、客户端政策、离线 VM 结果和节点接受事实分别记录。

## 网络、钱包与核验

默认节点参照原 V2.0.2 的 `TN10.web.nodes`，配置来源为 `scripts/chain/tn10.mjs`；默认索引为 `https://indexer.kaspay.top/tn10`。端点的配置不表示本轮已验证服务可用、Profile 路由或兼容性。通用链工具中保留的网络定义不扩大 Rolling 的 TN10 范围。

Indexer/REST、订阅通知与本地缓存提供发现和同步线索。轮次必须经自身节点的 accepted 数据、真实输入上下文及协议解释器复算；DRAW 还需核验相应链上证明。区块包含不等于接受，索引终态标签也不能独立证明资金已结算。

钱包层负责内存签名与扩展接入，交易编排仍需逐笔批准、网络和账户核对、授权输入及返回签名检查。未决提交保留意图，通过接受证据恢复；不能把超时直接视为失败并重复创建交易。节点连接、账户变化、重组与本地存储冲突需要各自处理。

## 构建与证据边界

`build/core.mjs` 统一编译 `scripts/core/src/` 到 `scripts/core/lib/`；`build/build.mjs` 导出 `buildKaswin`，以 `web/app/app.ts` 为入口，生成 `dist/index.html` 与 `dist/build-manifest.json`。默认及 `build:tn10` 均为 TN10，不支持 mainnet。普通构建使用固定合约产物；`build/compile-contracts.mjs` 与 `build/prepare-sources.mjs` 只在明确重编合约时使用。

重组后上述统一核心编译、隔离候选构建及离线/VM 测试已由 `tester` 验证（详见[重组记录](REORGANIZATION.md)）。历史实链证据位于 [rolling/](rolling/README.md) 与[此前集成交接](ROLLING-INTEGRATION-HANDOFF.md)，仅适用于各自记录的源码、产物和执行范围。源码布局替换不迁移 V2.0.2 链上轮次、不修改历史证据，也不代表现有站点已切换。
