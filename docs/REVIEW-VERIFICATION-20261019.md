# V2.0.2 外部审查意见核实（2026-10-19）

对象为本仓库工作区（`kaswin/`）当前文件。用户附件 `kaswin-v2.0.2-review-20261019.zip` 的审查基线为 `6df7639b174b1399043ce251611818554bc38f9c`。本目录不带 `.git`，不能宣称已确认与该提交逐文件相同；下述定位均重新阅读当前文件所得。

**结论：附件 F1–F6 在当前源码中均成立，保留 1 P1 / 5 P2。预算与批准证据部分需要补充历史背景：存在同一 V2.0.2 Profile 的预算和回放材料，正式预算评审仍未闭合。** 本文是意见核实及架构审查材料，不是修复、执行验收或上线批准。

## 范围与证据口径

已读工作空间 README、sources、兼容矩阵、核心架构规范、25问模板及本项目架构。主助手直接核实，无委派。当前固定 Profile 为 `ed0387c9e77bb4e0a8f1f4654a326c316d83663f455283ec6a046a095c94856d`，SilverScript 为 `3ed973335b59269293564805cc2c58a14595ec03`，共识参考为 `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`。

本轮仅静态读取项目源码、附件 PoC 与随包输出、固定上游源码、既有存档证据。没有执行附件、项目测试、语法/类型/构建、浏览器、VM或网络查询。随包“已复现”及历史 PASS 均标识为原作者/原运行记录，不写成本轮复现。钱包文件未读取，无签名广播。

当前 [manifest](../dist/build-manifest.json) 自记为 `mode=mainnet`、540061 B、SHA256 `07c074b2f1d84d24d4fd9ed03b080282fcd9be77862ac34b604ef7e72126adac`；附件构建为 readonly、540318 B、`58474805…`。这些是读取已有元数据，未重新计算文件摘要或检查 manifest 与现有产物一致性，也未核对线上页面。

核实范围包括三份 SIL、核心状态/动作规则、轮次恢复、RBF/预留、终局追踪、摘要渲染和场景退出；不是全仓库重新安全审计。Indexer 服务端、真实节点与钱包行为、所有模板产物的独立重编均在范围外。附件仅解出至临时目录供阅读；其 Git 固定 runner 不能直接在本目录运行，源码路径的适配也不构成测试授权。

## F1 / P1：历史裁剪阻断当前 live 轮次的重新恢复——成立

当前 [rounds.mjs:222](../scripts/round/rounds.mjs#L222) 的 `verifyCandidate` 依次执行：

1. `S.verifySnapshot` 核对规范空 OPEN 根 CID、固定 Profile、完整账本、P2SH及锁定金额。
2. 当前节点 UTXO 查找并核对 outpoint/value/SPK/DAA/CID。
3. **仍无条件调用 `acceptedPair` 读取创建这笔 UTXO 的完整接受交易。**

第三步经 [chain.mjs:38](../scripts/chain/chain.mjs#L38) 依赖旧接受块头和 `getVirtualChainFromBlockV2(Full)`。实际网页会话恢复也不能绕开它：[rest-rounds.mjs:122](../scripts/round/rest-rounds.mjs#L122) 的 `evidence` 和 `resolve` 先取得 Full、再 replay、再查 live；REST 换接受位置或回退 genesis 不能补回已裁剪的节点历史。[live-snapshot.mjs](../scripts/round/live-snapshot.mjs) 只刷新本会话已持有的已验证证据，不是刷新/重启后的独立恢复入口。

固定 rusty-kaspa `cfafeb4` 的源码对此提供事实支持：

- `consensus/core/src/config/constants.rs:73` 定义 `PRUNING_DURATION=108000`。
- `config/bps.rs:96` 的实际 pruning depth 还取共识下界与按 BPS 缩放值的较大者。
- `pruning_processor/processor.rs:294` 的 archival 分支避免裁剪；`:485` 附近删除旧 `acceptance_data_store` / `block_transactions_store`。
- 同文件 `:616` 的 `retention_period_days` 影响保留根；converter `:639` 起读取实际接受数据。

因此“30小时”只是固定参考参数，不能当当前各节点的精确服务期限；活跃 UTXO 与旧块体/接受历史保留是不同事实。网页仍允许 [app.mjs:1534](../web/app/app.mjs#L1534) 的7天期限，REFUNDING也可长期闲置。

附件 PoC 只实际构造了 OPEN，模拟保留 live UTXO、裁掉 Full；SEALED/REFUNDING 同样依赖上述恢复链路，是本次源码分析的外推，不能称三阶段都已运行复现。持续会话已持有材料时也不必每次操作都立即失败。影响为本客户端的有资金轮次恢复/推进受阻，维持 P1；不是永久丢币或合约盗款结论。[协议帮助](../web/app/app.mjs#L1643) 已承认历史裁剪边界，说明这是既有未闭合限制。

整改方向可采纳，但应单独设计：将当前 live 状态认证与历史交易接受收据区分；恢复入口必须保留规范根身份、固定模板/状态原文、完整金额、节点真实 UTXO/DAA、网络/连接/取消边界。缺少状态原文仍需可验证材料来源。不能只删除 `acceptedPair`，因为当前 `live` 对象、resolver、后续轻量复核还要求 `acceptedTx`；也不能用 REST/Indexer 标签补成节点 acceptance。

## F2 / P2：RBF旧成员残留锁阻止DAA漂移后的新开奖——成立

当前路径与附件一致：

- [engine.mjs:559](../scripts/round/engine.mjs#L559) 将旧成员 A 写成 `REPLACED`、保留 `replacedBy`。
- `#reconcileNode` 在 [同文件:626](../scripts/round/engine.mjs#L626) 将此状态设为 sticky；未发现接受仍保留旧状态。
- [同文件:767](../scripts/round/engine.mjs#L767) 的 `follow` 在非 TRACKED 或有 `replacedBy` 时提前返回。TRACKED只含 SUBMITTED/PENDING/UNKNOWN，故旧成员无法进入漂移诊断。
- 新成员 B 在完整查找未接受、内存池缺席且输入仍 live 的条件下，经 [tracker.mjs](../scripts/tracking/tracker.mjs) 的真实输入 DAA 比较可变为 `DRIFTED`。
- [reservations.mjs:25](../scripts/tracking/reservations.mjs#L25) 释放 DRIFTED，却不释放 REPLACED；[engine.mjs:269](../scripts/round/engine.mjs#L269) 因旧成员预留抛出 `PENDING_LOCAL`，持久化新意图则可报 `INPUT_ALREADY_RESERVED`。
- [同文件:863](../scripts/round/engine.mjs#L863) 的归档要求至少一个输入已不 live，不能处理本例所有输入仍 live 的局面；`settleFamily` 仅在有 ACCEPTED 成员时清理其他成员。

附件使用真实 Engine/SessionStore/预留模块，但交易记录与RPC为模拟；不是已经观察到真实重组。该控制流不依赖伪造钱包签名即可解释故障。正常 RBF 旧成员仍可能获接受，不能无条件放开所有 REPLACED。应将“禁止旧成员重发”与“允许旧成员只读诊断”拆开，在共享输入/证明上下文确证失效时，以并发安全方式撤销整个替换族的相应预留；接受/内存池/未知等反例必须保留。

## F3 / P2：已终局状态忽略主连接明确移链反证——成立

[round-tracker.mjs:71](../scripts/tracking/round-tracker.mjs#L71) 在检查 removed hashes 是否相关之前执行 `if (this.terminal || !removed?.length) return`。`observationCurrent` 仅绑定本会话版本和物理连接，`sameConnectionContext` 明确不比较 chain revision；同连接的相关移链不会自动使这条 observation 失效。`wake` 也被 terminal 阻止。

[round-store.mjs:20](../scripts/store/round-store.mjs#L20) 可根据既有 terminalCheck 恢复历史核验标志。附件明确构造了已完成100 DAA终局复核、同主连接收到接受块移除的场景，这与当前源码相符。维持 P2，描述为忽略已经收到的反证；不能把100 DAA本身称为不可逆最终性。

还需注意：仅移除第一处提前返回不足以完成修复。`invalidate` 在 [round-tracker.mjs:27](../scripts/tracking/round-tracker.mjs#L27) 先记下 `settled`，再以 `terminal: !settled` 调用 store.invalidate，可能刻意保留已终局的磁盘标志。应对相关主节点移除显式撤销内存 observation 与持久化 terminalVerified/terminalCheck，再进入复验。

边界：终局后会 unwatch/release，故不保证一直有连接接收通知；这里确认的是通知**已到达**仍被忽略。重载后 [app.mjs:599](../web/app/app.mjs#L599) 会使用“历史核验记录”语义，不能说刷新后全部页面都宣称实时有效；[手动强制复验](../web/app/app.mjs#L908) 是现存恢复入口。备用节点提示不能直接撤销主节点结论，无关移除不应误伤。

## F4 / P2：坏摘要入缓存并阻断列表与后续刷新——成立

[rounds.mjs:87](../scripts/round/rounds.mjs#L87) 校验 value、CID、phase等字段，但同 Profile 且没有 state 的摘要不会进入 `checkState`，摘要的 ticketPrice/sold/ticketCap/purchaseCount 等显示字段没有相应类型/范围约束。`listRounds` 虽有逐条丢弃坏行机制，漏校验的字段仍会通过。

[app.mjs:297](../web/app/app.mjs#L297) 先把数据交给 `catalog.remember`，后续 [卡片:564](../web/app/app.mjs#L564) 对摘要 `ticketPrice` 与 sold 直接作 BigInt 转换；`ticketPrice="not-an-integer"` 会抛错。RoundStore/缓存读取复用同一 checkRow，重载仍可接纳它。[启动链:1791](../web/app/app.mjs#L1791) 把请求新列表放在缓存渲染之后，渲染 rejected 会阻止随后的 loadRows。

附件 Chromium 输出记录首次金额错误、服务端修复后的同上下文重载仍错误且无 `/v1/rounds` 新请求；与当前源码链路一致，本轮未重跑浏览器。不把此可用性问题升级为已经确认的 XSS/资金绕过。

建议采用三层处理：入库前严格校验所有展示字段；单条卡片失败隔离；缓存读取/渲染失败仍继续请求新数据。清理应限于坏轮次缓存，不能清空交易 journal或输入预留。

## F5 / P2：合法summary误作完整详情使页面卡住——成立

[discovery.mjs:64](../scripts/round/discovery.mjs#L64) 在详情和REST定位失败后允许返回 known，known可以是合法 summary。当前 [app.mjs:598](../web/app/app.mjs#L598) 把它赋给 R.detail 并设置 loading=false，接着 [renderRound:667](../web/app/app.mjs#L667) 无条件解引用 `d.state.config`。

`refreshRound` 的 catch 再次渲染相同对象仍会抛错；[openRound:589](../web/app/app.mjs#L589) 在 await 之后的 trackDetail 因而未启动。其他 Profile 的 checkRow 本就移除 state，也没有在详情渲染前转入摘要专用分支。附件两组 Chromium `config` 异常与当前代码吻合。

F5输入本身合法，不能用F4“丢弃坏摘要”代替修复。应区分summary和完整详情；无state时显示可恢复同步/错误/重试；当前Profile继续节点核验，其他Profile只显示摘要且不提供本版交易操作。

## F6 / P2：场景记录失败但正常退出码仍为0——成立

[harness.mjs:551](../tests/web/harness.mjs#L551) 的 waitTerminal 超时返回最后状态；[scenarios.mjs:120](../tests/web/scenarios.mjs#L120) 可正确产生 pass=false。结尾 [同文件:688](../tests/web/scenarios.mjs#L688) 调用 finishRun 并打印 counts，未根据 counts.fail 设置非零退出码；[run-archive.mjs:87](../tests/web/run-archive.mjs#L87) 只写报告和返回统计。

脚本有禁止场景的exit2和中断exit130，不影响“正常跑完但业务断言失败”的问题。附件通过真实场景/归档源码、内存文件系统和模拟harness表明fail=1而exitCode=0；本轮只读其实现与输出。

建议在保存归档和关闭浏览器后按fail设置 `process.exitCode=1`，保留报告；并在异常路径确保清理/归档。附件另外提醒的 `st/waitTerminal` 依赖Indexer也属实：当前README开头“所有事实来自DOM、不轮询Indexer当状态来源”与实际harness不符。它是验收覆盖和文档边界，未另计第七项功能缺陷。

## 预算、Profile批准与既有证据：部分采纳，补正背景

当前 `pins.json` 确有 APPROVED/budgetProfileId=null，protocol.ts:91 有“继承V2.0.1、未校准V2.0.2”注释，build-report也仍为编译阶段NOT_RUN。因此“独立审查者无法仅从当前发布目录建立完整预算批准链”成立，证据入口不完整、历史注释易误导。

但是读取既有存档可确认存在**同一个ed0387c9 Profile**的材料，而非仅旧Profile日志：

- [V202-COMPILE](../../../kaswin-publish-20261005/docs/V202-COMPILE.md) 及 [equivalence-report](../../../kaswin-publish-20261005/tests/contracts/evidence/compile-v202/equivalence-report.json) 记录两次编译及与旧版完整tail/ABI相同，报告状态是当时的阶段快照。
- [预算summary](../../../kaswin-publish-20261005/tests/contracts/evidence/budget-v202/summary.json) 记录2549/2549、SCRIPT_VM_ONLY及当前Profile；[预算候选](../../../kaswin-publish-20261005/tests/contracts/evidence/budget-v202/budget-evidence.candidate.json) 的 review.status仍为PENDING。
- [回放summary](../../../kaswin-publish-20261005/tests/contracts/evidence/budget-v202/tn10-replay-summary.json) 记录946/946状态输入0回放，明确Profile。
- 当前manifest记载的protocol/builders源摘要与上述budget summary的两个源摘要文字相同。本轮未重新计算哈希，不能据此宣布当前文件/全量证据完整性通过。
- [既有VM说明](../../../kaswin-publish-20261005/docs/VM-BUDGET.md)、[唯一验证记录](../../../kaswin-publish-20261005/docs/VALIDATION.md)、[TN10实验记录](../../../kaswin-publish-20261005/docs/TN10-EXPERIMENT-V202.md) 记有990回执、P256/R256/R225及主网离线33/2549等历史范围。本轮没有重新核验这些原始交易和主网全部机器材料，不能将文档数字转成本轮V/N结论。

`approvalStatus=APPROVED` 是运行时允许精确Profile的批准，与候选预算独立评审、公开生产批准不同；编译报告的旧NOT_RUN也不否定后续执行。因此不能由这两字段直接断言批准造假，或说V2.0.2从未编译/校准/做规模链上实验。

当前构建按用户的构建/测试分离政策，只按mode控制交易能力，[build/build.mjs](../build/build.mjs) 不读取VM/回执，也不因budgetProfileId=null阻止mainnet模式。不能沿用旧版“构建预算门仍会阻断交易”的说法；构建可交易能力与生产批准须另行说明。

合理整改是补回可检查的外部证据引用与明确的批准层次，完成PENDING评审；不得为了消除文字矛盾直接改budgetProfileId、APPROVED或哈希绑定的SIL/编译产物。附件所说“本次未独立做VM/规模实链验收”可以保留，但不能写成项目从未做过。

## 25问：本次静态审查Preflight

以下回答限定为现行设计及本次意见核实，不是重新授予实现/生产批准。未闭合恢复问题列OPEN；本轮不编码。

|#|答案与来源|审查状态|
|---|---|---|
|1|实例身份为网络域内CID；Profile选择固定规则，见state.ts/网络schema|设计明确|
|2|origin outpoint＋规范空OPEN的output0金额/SPK推导，rootScript/rootId|设计明确|
|3|唯一状态后继继承CID，终局无covenant后继|设计明确|
|4|当前状态在live P2SH UTXO；原文为待认证材料，view/receipt为派生或缓存|F1数据可获得性OPEN|
|5|owner、票价/上限/min/close DAA、固定规则与来源身份不可任意更改|设计明确|
|6|phase/sold/purchaseCount/directory/cursor按动作变，接受位置/观察另属派生|F3观察撤销OPEN|
|7|GENESIS/BUY/CLOSE/DRAW_AND_PAY/TIMEOUT_REFUND/REFUND|设计明确|
|8|普通资金输入需签名；推进可permissionless，输出仍受合约约束|设计明确，非全签名审计|
|9|状态1:1续接或1:0终止，普通资金输入/付款单列|设计明确|
|10|状态output0或明确定义普通付款，输出上限2/3/34|设计明确|
|11|固定tail/P2SH/状态编码；跨模板检查目标templateHash|设计明确|
|12|当前cid输入组与auth/cov后继集；规范根认证独立于任意标签|设计明确|
|13|账本规范编码/目录、后继SPK/value/状态逐项约束|设计明确|
|14|票权/目录/冻结/互斥/UNKNOWN不超时放锁；反证必须撤销|F2/F3 OPEN|
|15|真实sum(inputs)=sum(outputs)+fee；押金/票款/退款/赏金分开|设计明确，未运行|
|16|同轮用户竞争同outpoint，跨轮无共享状态；本地预留是防重复辅助|F2本地锁OPEN|
|17|每轮一state，最多256目录；未编造TPS或竞争概率|设计明确|
|18|跨轮可分片；单轮多对象是另一设计，不纳入本次核实|范围外|
|19|EMPTY/PAID/REFUNDED，均无状态后继；历史标签非不可逆终局|F3 OPEN|
|20|空轮退押金、原子派奖、批量退票及超时转退款|链上路径明确，F1客户端退出活性OPEN|
|21|Indexer只发现/显示/定位；实际接受与live由节点核验|F4/F5/F6边界OPEN|
|22|CID/归属/资金/转换须不依赖Indexer裁决；原文可获得性另解|F1 OPEN|
|23|OPEN→SEALED/REFUNDING及SEALED→REFUNDING必须验证foreign模板|设计明确|
|24|同family跨模板＋普通补资；无任意跨family远程读取|设计明确|
|25|有界资产状态适合L1；不新增巨大共享状态/Based App功能|本范围内适用|

## 14项架构材料

1. **UTXO inventory**：每轮一state，普通资金/找零/登记、终局WINNER/CREATOR/EXECUTOR/BUYER_REFUND；无全局Game/Ticket/Prize分片。见三SIL与protocol.ts。
2. **schema**：KW21固定80B＋36N，N≤256；owner/config不可变，phase/累计票权/目录/退款游标按动作变；Consensus为SPK/CID/value/节点UTXO上下文，Derived为解析与接受观察，Cached为RoundStore，External为Indexer/REST提示。
3. **lineage**：origin→规范空OPEN根CID→跨模板状态output0续接；模板hash与源hash由Profile约束；A/B/C RBF只竞争同组inputs，不产生新协议身份。
4. **状态图**：`GENESIS→OPEN↺BUY→CLOSE→SEALED→DRAW→PAID`；CLOSE也可到EMPTY/REFUNDING；`SEALED→TIMEOUT_REFUND→REFUNDING↺REFUND→REFUNDED`。F1阻断客户端恢复边，F3缺终局观察撤销边。
5. **UTXO拓扑**：`fundingA→roundA0→roundA1→ordinary payoutsA` 与roundB独立；同轮替换/竞争消费同一个state，关系标签不表示链上可远程读对象。
6. **逐动作I/O**：GENESIS普通资金→状态0＋登记/找零；BUY状态0＋资金→状态0＋可选找零；CLOSE状态0＋资金→状态0或押金＋可选找零；DRAW仅状态0→赢家/押金/执行者3输出；TIMEOUT状态0＋资金→退款状态0＋可选找零；REFUND状态0＋可选赞助→≤32买家输出、后继或押金、执行者，≤34输出。普通付款与covenant分组分别核对。
7. **授权**：用户逐笔批准；普通输入签名；合约规则限制后继与固定收款；网络/账户/Profile、签后全字段检查及原字节重发保持。F2不能以解锁为名自动签新交易。
8. **后继**：OPEN同tail续接或固定foreign tail；SEALED只到固定REFUNDING；退款同tail推进；auth/cov计数和索引约束state0，终局逐普通输出核对。F1新恢复方案仍需保持全部身份/状态检查。
9. **不变量**：输入输出守恒，票权累计/目录顺序唯一，冻结后不买票，退款cursor严格推进，付款与续接互斥；UNKNOWN保留输入但已确证失效的替换族也必须可退出本地占用。
10. **退出**：三终局普通付款；无人推进不自动转账，32条一批；超时432000DAA需真实成熟，裁剪/缺原文时客户端恢复仍OPEN。退款可能需外部补费。
11. **Indexer**：不授予资金权限；摘要也必须类型/范围安全，缺完整详情要可重试；场景验收不能仅凭终局标签自称节点acceptance。
12. **争用**：同轮一个state是目录追加/冻结顺序的设计选择；跨轮独立，无全局锁。浏览器锁只辅助本地防重复；F2替换族锁不能永久覆盖有效新计划。
13. **L1/Based**：现行有界状态/目录/输出选择L1；扩大单轮或增加多对象需另审，六项意见未提供推倒重写协议的依据。
14. **反模式材料**：下表逐项限定结论；正向设计存在不代表实现全无缺陷，也不构成新V/N或生产批准。

## 8项anti-pattern审查

|#|检查与当前结论|
|---|---|
|1 全局state管全部用户|未采用；每轮独立，见架构/状态机。|
|2 只签名不验后继|三SIL有successor/ordinary/terminal、金额和费用约束；本轮未执行绕过测试。|
|3 仅相同CID即信状态|verifySnapshot重算规范根、模板/SPK/金额；F1整改不能省这些。|
|4 Indexer裁决权益|资金路径独立节点核验；F4/F5显示降级有缺陷，F6及st用例不足以独立证明链上接受。|
|5 Solidity逐字段翻译|状态按UTXO消费/后继建模，无账户式原地storage。|
|6 便利性全局串行|无全局共享state；同轮顺序有目录/封盘依据，F2属于链外预留活性缺陷。|
|7 无终止/付款|三终局存在，但历史裁剪客户端恢复与终局反证撤销未闭合（F1/F3）。|
|8 只验bytes不验模板/谱系|固定模板链、规范根与SPK/value均有源码逻辑；附件未确认直接资金绕过，本轮也不作完整安全证明。|

## 处理顺序与后续验收设计

建议先落地小改动F6以防后续失败误报；资金恢复优先F1，其次F2/F3，再做F4/F5。证据引用/批准层次文档可并行澄清。**本次仅核实，以上均未修复。**

后续取得明确测试指令时，最小验收应覆盖：三阶段裁剪恢复与伪造状态/根/金额/DAA/已花费负例；A→B→C漂移及任一成员接受/内存池/未知；主节点相关移除、无关移除和备用提示、磁盘撤销/重载；坏金额/非整数sold/cap/坏缓存的单条隔离与新请求；合法summary和其他Profile降级；业务失败归档后非零退出。模拟结果只能用于相应控制流层次，真实裁剪/重组与VM/链上接受需另留真实证据。

本报告只新增到当前工作目录；历史存档保持只读，未改已有唯一验证记录或重复建立VALIDATION文件。没有合约/核心/API/版本/产物或批准状态变更。
