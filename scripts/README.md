# 运行时脚本

网页与索引器调用的 Rolling 协议、网络、钱包和交易处理模块。金额使用 bigint 或十进制字符串，运行时不依赖 WASM SDK。

- `core/src/`：统一 TypeScript 协议核心与通用基础模块；`core/lib/` 由 `npm run build:core` 生成。
- `core.mjs` / `errors.mjs`：协议运行时门面与公共错误辅助。
- `contract/`：固定合约加载（`bundle.mjs`）、协议常量（`protocol.mjs`）与浏览器 Profile 数据转换（`profile-data.mjs`）。
- `chain/`：显式网络配置、节点连接、RPC/REST、费用与接受证据读取（当前应用仅面向 TN10）。
- `round/`：轮次控制器、状态机、准备与预算、追赶同步、索引客户端、PASS-A 证明与确认检查。
- `store/`：轮次与意图持久化编码（`codec.mjs`）及 IndexedDB 存储（`round-store.mjs`）。
- `tracking/`：待决交易意图恢复（`intent.mjs`）与节点拒绝/冲突分类（`conflict.mjs`）。
- `wallet/`：内存钱包、KasWare/Kastle 扩展接入、Kaspire 接入及地址/Schnorr 签名辅助。
- `indexer/`：只读 TN10 索引服务、区块扫描、归档与节点接受适配器。
- `release-safety.mjs`：编译模式对应的交易权限与发送权限检查。

网络必须显式传入。交易开关不替代逐笔批准、钱包网络核对或接受验证；Indexer、REST、通知与缓存只提供线索。

模块关系和不变量见[架构说明](../docs/ARCHITECTURE.md)。
