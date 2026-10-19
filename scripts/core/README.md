# 协议核心库

纯TypeScript实现，负责状态编码、交易构造、接受解释、模板/CID身份与PASS-A核验。源码位于 `src/`，JavaScript、声明与source map生成到 `lib/`。

```sh
npm run build:core
npm run check:core
```

第一条生成核心库；第二条独立比较源码和生成文件。完整 `npm run build` 会先生成核心库，不要求手工维护生成文件。

| 模块 | 职责 |
|---|---|
| state / ledger-layout | KW21账本、字段范围、Profile与脚本重建 |
| protocol / builders | 状态转换、交易输入输出、见证、预算与费用 |
| accepted | 接受交易的状态、后继和普通付款解释 |
| artifacts / covenant-id | 模板来源与规范CID |
| genesis-discovery / registry | 初始公告、登记与起源核验 |
| pass-a | 头/commitment/上下文与first-crossing核验 |
| bytes / hashes / blake3 / transaction | 字节、哈希与交易序列化 |
| persistence | 浏览器存储基础能力 |

固定Profile不能只凭版本标签通过；模板tail与编译器来源也须匹配。网络地址和节点配置由上层注入，核心不选择网络或连接节点。布局投影来自 `contracts/ledger-layout.json`。

具体协议边界见[架构说明](../../docs/ARCHITECTURE.md)。
