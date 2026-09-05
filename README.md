# Kaswin

任何人可创建、规则与资金变化可由链上证据验证的 Kaspa 抽奖协议，以单网页提供操作入口。

**状态：现场审计快照阶段。**

- **Real TN10 P2SH Covenant**: **PASS**
- **Real OpTxInputDaaScore**: **PASS**
- **Real OpChainblockSeqCommit**: **PASS**
- **Header-bound first-crossing**: **UNDER INDEPENDENT AUDIT**

## 固定目标

- 无许可创建与推进，没有管理员改规则、指定赢家或提取本金的权限。
- 公平开奖：不能依靠创建者诚实，也不能用公开开发 oracle 替代不可操纵性论证。
- 所有生效业务操作有链上已接受交易及可验证状态证据。
- 单网页静态分发，读取节点与历史服务不是业务裁判。
- 首版 A 型：固定总票数，满额原子封盘后开奖；未满满足退出条件后退款。
- 后续类型独立增加，不在首版建设通用玩法引擎。

## 设计入口

- [A 型最小协议草案](docs/type-a.md)
- [决策与实施门槛](docs/decisions.md)
- [最小必要验证计划](docs/validation.md)
- [固定来源与兼容边界](docs/sources.md)
- [可行性 01：时间与链锚有效窗口](docs/feasibility-01.md)
- [随机证据恢复：旧目标与近期验证锚](docs/randomness-recovery.md)

最终交付为单个自包含 `index.html`，保留全部源码、设计与中间产物。主助手持续负责设计和重大决策；实现可委派指定模型，不以页面完成代替协议成立。

本仓库是全新实现起点，不继承 [kaswin-archived](https://github.com/agang0311/kaswin-archived) 的 artifact、协议身份或部署结论。暂不选择前端框架与编译器组合，不复制旧工程，也不承诺已解决链上随机性和资金退出。
