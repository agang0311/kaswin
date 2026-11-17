# 协议核心库

统一 TypeScript 协议核心，包含 Rolling v1 账本状态、Profile 校验、交易构造、mass 报价、接受交易解释、收款地址归一化，以及字节、哈希、脚本、CID、交易序列化、PASS-A 与浏览器持久化基础能力。源码位于 `src/`，JavaScript、声明与 source map 生成到 `lib/`。

```sh
npm run build:core
npm run check:core
```

第一条编译生成 `lib/`；第二条独立比较源码和已生成文件。完整 `npm run build` 会先编译核心库。

| 模块 | 职责 |
|---|---|
| `state.ts` | Rolling v1 五模板状态编解码、分片不变量与金额计算 |
| `profile.ts` | 五模板编译产物校验、Profile ID 推导与管理片核验 |
| `transactions.ts` | 确定性状态转换、动作交易构造与开奖抽样 |
| `mass.ts` | 交易 Compute / Transient / Storage Mass 报价与派奖分批收敛 |
| `accepted.ts` | 已接受交易解码、管理片/冻结片后继与收款核验 |
| `receiver.ts` | 公开奖励收款人地址与脚本归一化 |
| `script.ts` | 脚本 push/number 编解码、模板哈希与序列承诺目标辅助 |
| `pass-a.ts` | 链上 PASS-A 承诺与 Merkle 证明组装核验 |
| `covenant-id.ts` / `registry.ts` | P2PK/P2SH、规范 Covenant ID 与注册输出检查 |
| `bytes.ts` / `hashes.ts` / `blake3.ts` / `transaction.ts` | 字节、哈希与 Kaspa 交易序列化 |
| `persistence.ts` | 浏览器 IndexedDB CAS 存储基础能力 |

固定 Profile 不能只凭版本标签通过；模板 tail 与源码/产物哈希也须匹配。网络地址和节点配置由上层注入，核心不选择网络或连接节点。

具体协议边界见[架构说明](../../docs/ARCHITECTURE.md)。
