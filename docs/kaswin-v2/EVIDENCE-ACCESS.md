# 历史回执访问与干净仓库验证

## 三种不同能力

| 任务 | 所需材料 | 缺材料行为 |
|---|---|---|
| `npm run test:audit` / `npm test` | Git源码、锁定开发依赖；涉及签名模拟时另需官方SDK2.0.1 | 前置缺失失败；不联网补装、不冒充已测 |
| `npm run build:pages` | Git提交的HTML、manifest及记录的构建输入 | 任一hash/文件/CSP错误即阻断；不重建、不核验原始回执 |
| `npm run test:receipts` / `build:tn10-candidate` | 以上材料及受控原始历史回执 | 缺失/不符硬失败；不自动SKIP、不解除门槛 |

VM使用独立入口和固定二进制清单，见[VM记录](VM-BUDGET-20261009.md)。网络广播仍需单独授权，本页流程只读本地文件。

## 原始回执不是Git交付的一部分

`tests/tn10/evidence/`被忽略，**公共仓库克隆没有这批原始材料**。因此可以核对已提交产物并运行公共回归，但不能独立重建可交易候选或宣称通过原始回执门。

公开摘要：
- [`contracts/f3.2/tn10-release-evidence.json`](../../contracts/f3.2/tn10-release-evidence.json)：固定Profile、源码hash、377条记录和逐文件SHA256。
- [TN10-RECEIPTS.md](TN10-RECEIPTS.md)：txid、观察时间、接受块、mass、fee的可读表。

摘要不是原始节点证明，也不是今天的网络重查结果。没有发布额外公开证据下载包，本次不自动导出本机实验目录。

## 受控复核的获取方式

如需原始复核，由操作者向实验材料持有人申请仅包含下列五个已完成run的副本：

- `empty-r1`（2笔）、`refund-r1`（5笔）、`payout-r1`（5笔）；
- `payout256-r1`（259笔）、`refund100-r1`（106笔）。

持有人必须在传输前做脱敏/凭证排查，只提供核验所需的 `*-accepted.json`、`*-intent.json`、`*-record.bin`、`complete.json`。**不得夹带wallets、授权凭证、节点配置、token、未知或未完成run。** 交易中的公钥/签名是历史公开交易数据；仍须人工确认文件不含秘密。`record.bin`只按字节计算hash，不反序列化不可信副本、不用于恢复或广播。

在独立验证副本的 `tests/tn10/evidence/<run>/` 中放置材料，保持目录0700/文件0600，不覆盖既有journal。先核对公开摘要里的 `receiptSha256`、`intentSha256`、`recordSha256`；然后运行：

```bash
npm run test:receipts
```

该命令比较原始文件与已提交摘要，并核对数量、顺序、Profile、资金差、后继关系及终局。通过仅表示**历史材料内部一致**，不代表独立确认节点真实性或不可逆最终性。缺少complete文件或任一hash不符即失败；不要重写摘要让材料“匹配”。

只有原始回执门完整通过后，才运行：

```bash
npm --prefix apps/kaswin-v2 run build:tn10-candidate
```

保持相同Profile和证据边界，不改预算pin。没有材料时使用已提交产物核验或显式只读构建，不制造回执，不拿mock替代。
