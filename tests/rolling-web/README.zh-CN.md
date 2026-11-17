# Rolling TN10 网页测试

[English](README.md) · [实链证据](../../experiments/rolling/TN10-EVIDENCE.md) · [覆盖矩阵](../../experiments/rolling/REMAINING-COVERAGE-20261115.md)

交易通过真实页面准备、签名和提交；独立只读 RPC 核对所选链接受、输入、实际费用与 mass，每笔最终至少100 DAA。这个深度是客户端策略，不是不可逆终局。候选 Profile 保持 **UNVALIDATED**。

执行须有当前明确授权，只用现有专用 TN10 钱包；不包含主网、新密钥或自动 TIMEOUT。

## 入口与证据

| 入口 | 内容 |
|---|---|
| `scenarios.mjs` | 空轮、退款、正常开奖、卖满提前封盘、256条记录冻结派奖/退款 |
| `round-double-spend.mjs` | 两个不同买家争管理UTXO；ROUND_INPUT、放弃/导入/重买、旧报价发前拦截 |
| `double-spend.mjs` | 同钱包资金输入竞争；FUNDS_INPUT、池内占用排除、旧报价拦截 |
| `contention.mjs` | 三买家、并发CLOSE、BUY对CLOSE、两个独立节点接收冲突交易 |

```bash
node tests/rolling-web/scenarios.mjs --scenarios=1,2,3,4,5,6 --role=b2 --budget=14400
node tests/rolling-web/scenarios.mjs --scenarios=3 --buys=1 --quantity=3 --role=b2
node tests/rolling-web/round-double-spend.mjs --phases=r1,r2
node tests/rolling-web/double-spend.mjs --phases=1,2,3 --attempts=2
node tests/rolling-web/contention.mjs --cases=three-buy,close,buy-close,cross-node --attempts=4
```

默认本机TN10代理；`--node=` 可指定授权内的其他TN10节点。`--budget` 在场景之间检查，不是对所有在途操作的硬超时。`--resume-run=` 续用原目录/profile/CID，并检查网络、角色、数量等范围；未知交易只能对账或恢复原签名字节。

冻结按购买记录数计算，单次多票仍只有一条记录。场景5/6恰256条、无本地尾单，最后PAY_OLD或REFUND_OLD直接合并收口，不另发SELF。TIMEOUT由用户手测；顺序场景中的7/8入口不运行，并发由独立脚本实现。

## 运行与恢复边界

- CLI与网页共享钱包锁，禁止重叠使用同一钱包签名。阶段启动前按已知CID的真实covenant UTXO检查容量；这不是网络级全局分配器。
- 保留浏览器profile、公开checkpoint、接受文件与原签名意图。失败后先恢复原状态、结清已有轮次，再开新任务。
- `createRobust()` 默认只创建一次；未决创世不自动换输入重建。失败条件、证据不全或清理失败都返回非零退出码，停止后续新轮次。
- 签名在各真实页面分阶段完成。跨节点首帧前准备可等180秒；首帧到达后最多扣18秒。原RPC帧与节点回复不改写；实际提交socket分别核对p2pId。
- 双节点通过要求两边真实接收不同txid、所选本机链唯一赢家、败者负接受/原节点池空与正常页面清理、整轮终局≥100DAA。高延迟公共节点的有界负搜索可能不完整；可保留原节点池空证据，改本机查询节点完成页面原有放弃规则。
- 公开地址与私钥模式切换先断开钱包，再选对应tab。密钥只由allowlist harness/signer读入内存；输入失败使用不含密钥的错误。导出含公开签名脚本，日志不整体打印。

`recover-contention.mjs` 仅清除既有败者意图，禁止签名或广播；`recover-contention-round.mjs --execute` 认证/真实limited VM复核原签名，再恢复相同txid并结算同CID。专用campaign调度记录完成阶段，失败阶段须核对原profile后才能显式继续。

后续补强：`submission-barrier.mjs`由首帧启动单调时钟18秒期限，实际socket探测、跨节点延迟和每次放行共用同一期限；到期丢弃仍扣留的帧，timer回调拖延也不能放行过期请求。8项离线定向测试与脚本语法通过；新版调度TN10复跑为**NOT_RUN**，旧实链证据保持原时点。节点拒绝回复的transactionId可为空，tap按RPC id关联请求，归档错误的主语用于核对被拒交易。

## 2026-11-15 已完成记录

当前页面 `ea23092b…3ab3d2f8`：六场景547笔/520票、12.16600100TKAS；另单次BUY买3票，5笔PAID。管理UTXO竞争6笔REFUNDED/0.10258300TKAS，导入后第一次真实点击收到准备响应，旧报价submit帧0。同钱包测试7个空轮/14笔、0.14062800TKAS；两次都在B报价时确认A仍在池中，且最终实际输入不相交。

三买家、并发CLOSE、BUY对CLOSE及真正双节点接收竞争已有实链证据。CLOSE的一次游标回滚通过原交易独立补查，原失败记录保留；两次跨节点准备失败都只恢复选定原签名字节并结清。最终本机与vector各接收一笔不同交易，所选链唯一赢家，4笔REFUNDED、0.07216600TKAS，败者清除并导入终态。

CLI另完成17片PAY_OLD16+1/PAY_SELF的4359笔与三片退款796笔，两轮5155笔均经过独立节点适配器/索引器/归档回放。模型、真实VM、实链证据在矩阵中分层；不把历史累计、模拟接受或重复恢复文件盲目相加。

未包含TIMEOUT实链、Rolling扩展钱包接入、主网或生产批准；有限实测结果不提升UNVALIDATED状态。
