# F3.2 链上合约（Testnet 10 固定快照）

这里是链上 SilverScript 源码，不是网页脚本。三份源码与既有 V2 构建输入逐字节相同；本次未变更协议、编译器或经济参数。

| 文件 | 责任 |
|---|---|
| [src/open.sil](src/open.sil) | 售票期 BUY、CLOSE 及后继/空轮终止约束 |
| [src/sealed.sil](src/sealed.sil) | 封存后 PASS-A 开奖派奖、超时转退款 |
| [src/refunding.sil](src/refunding.sil) | 分批退款、后继游标和最终退出 |
| [profile.json](profile.json) | 网络/Profile、三模板哈希及dispatch tag |
| [pins.json](pins.json) | 源码与linked artifact完整SHA256，供网页构建拒绝漂移 |
| `artifacts/*-linked.json` | 原始编译器输出（ABI、bytecode、state span、template hash） |
| `artifacts/*-linked.args.json` | 生成该编译样例使用的公开构造参数，不是真实钱包 |
| `artifacts/build-report.json` | 原始编译阶段报告，不是本次VM或链上通过证明 |

固定 Profile：`7ca61d81be1a2448d16b18cb2bdce845c91ed4993a6da0fd26b14d211fbce863`。
固定 SilverScript v1.0.0：`3ed973335b59269293564805cc2c58a14595ec03`。

网页构建从源文件哈希及linked artifacts重新加载三帧，重算Profile；不从上一份HTML拷贝帧。目录旁旧的 `contracts/*.rs` 等属于V1，不能与本目录拼装。

## 可选离线编译复核

先按[固定来源](../../docs/kaswin-v2/SOURCES.md)自行取得固定编译器，二进制必须与原编译报告SHA一致。以下只运行编译器，不签名、不连接网络；输出保留到指定的新目录，拒绝覆盖原文件：

```bash
node contracts/f3.2/tools/check-compile.mjs /absolute/path/to/silverc /absolute/path/to/new-output-directory
```

编译器构建受Rust/系统工具链影响；二进制SHA不一致时必须先复核差异，不自动放宽pin。即使重新编译成功，也不代表通过TxScript VM、真实节点acceptance或安全审计。此次GitHub整理只核对既有编译产物并重建网页，未重跑合约编译/VM。

完整业务拓扑、25问、14材料、8项审查沿用[架构材料](../../docs/kaswin-v2/ARCHITECTURE.md)，生产安全与历史裁剪限制保持不变。
