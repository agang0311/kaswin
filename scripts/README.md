# 运行时脚本

网页调用的协议、网络、钱包和交易处理模块。金额使用bigint或十进制字符串，运行时不依赖WASM SDK。

- `core/src/`：TypeScript协议核心；`core/lib/`由构建生成。
- `contract/`：固定合约加载、布局投影与浏览器Profile检查。
- `chain/`：显式TN10/主网配置、节点连接、RPC/REST、费用与接受读取。
- `round/`：轮次发现、计划、报价、执行、历史解释和PASS-A。
- `store/`：会话记录、IndexedDB CAS与轮次缓存。
- `tracking/`：详情和未决交易追踪、重组恢复、诊断与原字节重发。
- `wallet/`：KasWare、TN10内存测试钱包及地址/签名辅助。
- `release-safety.mjs`：编译模式对应的交易权限与发送权限检查。

网络必须显式传入。交易开关不替代逐笔批准、钱包网络核对或接受验证；Indexer、REST、通知与缓存只提供线索。

模块关系和不变量见[架构说明](../docs/ARCHITECTURE.md)。
