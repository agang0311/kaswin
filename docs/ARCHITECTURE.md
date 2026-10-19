# 架构说明

Kaswin 由链上轮次状态、链下协议核心与浏览器应用组成。构建工具只生成网页产物；业务测试和部署是独立步骤。

## 模块

| 目录 | 责任 |
|---|---|
| `contracts/` | OPEN、SEALED、REFUNDING 三种固定模板、KW21布局与Profile |
| `scripts/core/` | 状态编码、交易构造、模板与CID身份、接受解释、PASS-A与密码学基础 |
| `scripts/chain/` | 显式网络上下文、节点池、RPC/REST、费用与接受证据读取 |
| `scripts/round/` | 计划、报价、批准、执行、轮次发现、历史解释与开奖确认 |
| `scripts/store/` | 会话记录、IndexedDB CAS与轮次缓存 |
| `scripts/tracking/` | 详情与未决交易追踪、重组恢复和诊断 |
| `scripts/wallet/` | KasWare、TN10内存钱包、签名与地址辅助 |
| `web/app/` | 页面交互与操作编排 |
| `web/ui/` | 模板、样式、翻译与展示辅助 |
| `build/` | 编译核心库、校验固定产物、生成HTML与来源清单 |

运行时脚本不反向依赖网页或测试工具。视觉层不能调用钱包、节点连接或交易执行模块。

## 状态与资金

```text
普通资金 → GENESIS → OPEN
OPEN → BUY → OPEN
OPEN → CLOSE → SEALED / REFUNDING / EMPTY
SEALED → DRAW_AND_PAY → PAID
SEALED → TIMEOUT_REFUND → REFUNDING
REFUNDING → REFUND → REFUNDING / REFUNDED
```

每轮共享一个顺序状态 UTXO，跨轮独立。CID标识轮次谱系，P2SH承诺当前状态与脚本；相同CID不代表状态合法，仍需完整核对模板、账本、金额、绑定与后继。

KW21账本为80字节头加每条36字节购买记录，上限256条。持久阶段仅OPEN、SEALED、REFUNDING；退款推进cursor，开奖中间值在交易内计算。终局生成普通付款，不产生状态后继。

金额以sompi整数处理。押金、票款、退款、执行者款与网络费分别计算，满足输入等于输出加手续费。客户端登记政策与合约约束分开。具体规则以固定合约和协议核心为准。

## 网络、授权与核验

TN10与主网显式配置并隔离钱包、连接、缓存、交易记录和输入占用。Indexer/REST/通知用于发现和唤醒，不能裁定接受或资金归属；节点接受数据仍须由客户端复算核验。区块包含不等于交易接受。

构建模式控制页面交易能力：readonly两网只读，tn10仅测试网可交易，mainnet两网可交易。主网仅KasWare；TN10内存钱包只保存当前页面会话。每笔交易仍需批准、网络/账户核对、签名核对和实际接受跟踪，构建参数不代替这些检查。

未知提交不按超时释放输入，自动重发仅使用原签名字节。重组、切网、连接失效与异步任务取消分别处理；本地缓存不是当前链上状态的证明。

开奖中的100 DAA合约等待、PASS-A目标100 blue-score客户端确认、交易接受后100 DAA复核是不同条件，不能互相替代。

封存输入的实际节点DAA达到 `utxoDaa + 432000`，或开奖进度报 `PROOF_CONTEXT_INVALID` 时，本页禁用开奖并显示“开奖已超时”，引导使用“超时转退款”。这是前端入口策略；该错误也可能来自目标块离开选中链，不能据此证明退款已成熟或不可逆最终性。退款仍独立核验真实DAA和原合约条件，提示本身不转账、不修改链上阶段。

## 构建与测试边界

HTML构建编译核心库、核对固定模板/布局/Profile、生成CSP与来源哈希，不需要链上回执、VM预算报告或历史发布产物。`dist/build-manifest.json`描述本次构建，不声称合约/浏览器/网络测试通过。

当前Profile：`ed0387c9e77bb4e0a8f1f4654a326c316d83663f455283ec6a046a095c94856d`。SilverScript来源固定为 `kaspanet/silverscript` 提交 `3ed973335b59269293564805cc2c58a14595ec03`；共识参考为 `kaspanet/rusty-kaspa` 提交 `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`。这些固定来源不表示当前任意节点都已通过兼容验证。

合约产物和已有Profile身份保持固定；新合约设计仍须分别解决身份、授权、资金守恒、随机性、退出与foreign模板验证，再执行对应验证。构建成功不构成生产批准。
