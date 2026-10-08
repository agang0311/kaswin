# 2026-10-07 合约收紧与新 Profile：实施前 Preflight

状态：**APPROVED FOR SOURCE / COMPILATION / READ-ONLY ARTIFACT；交易发布 BLOCKED**。

用户明确要求“把合约的三个问题修一下，超时daa改成432000，更新profile，更新编译产物，更新发布文件”。此次授权替代前轮不改字节码／不覆盖HTML的限制，不扩大测试、VM、网络、签名或部署权限。主助手单写入者，不委托。基线 `e07703c3dcece5cd1c90481fa349382bbd986950`，旧 Profile `206d4ec7072727ae3291726f19c82293b38340a5a7de05d306cf105c4206a9c3`。

已重新阅读 `/root/kaspa/knowledge/contracts/core-architecture-spec.md`、25问模板、README、sources及兼容矩阵。固定 SilverScript `3ed973335b59269293564805cc2c58a14595ec03`、binary SHA256 `81de9aa4157dbde3633ebab629e86c5975770fc13ee2d2093e52d7f725616a00`；rusty-kaspa `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`，不升级。2026-10-07本地源码复核：SilverScript `compile/expression.rs:573–593` 将 indexed input/output value 降为 OpTxInputAmount/OpTxOutputAmount；rusty `crypto/txscript/src/opcodes/mod.rs:1258–1266,1313–1320` 读取真实UTXO和交易输出，不读取用户金额见证。循环沿固定编译器有界for语法；需要编译确认，不将源码核对当VM证据。

## 设计决策（先于代码）

1. 所有五种动作均绑定 `fee == sum(actual inputs) - sum(actual outputs)`，且 `0 < fee <= 50000000` sompi。上限沿用应用0.5 TKAS政策，明确升级成新Profile链上规则；不冒充Kaspa共识上限。每个金额 `0 < value <= VALUE_LIMIT`，最多9输入/34输出，和小于 signed i64 边界。OPEN BUY/CLOSE仍由外部资金支付费，TIMEOUT保持本金，DRAW从奖池扣费。
2. REFUND末输出 `index = batch+1` 必须是无covenant的 actorPk P2PK，金额 `externalInputs + batch*REFUND_FEE - fee > 0`。买家、押金、后继约束保留；外部赞助输入由自身脚本授权。Permissionless actorPk是本笔指定领取者，不新增签名身份或独占执行权，仍可能被更换actor并竞争消费；这是既有无特权推进模型，不承诺防抢执行赏金。
3. OPEN配置边界与SEALED锚点边界的 TIMEOUT_DELAY 均改432000；DRAW_DELAY仍100。约12小时仅按TN10目标10 DAA/s估算，不是时钟保证。延长窗口**不消除窗口结束后的开奖／退款竞争**。选中链承诺深度以blue score计，不能将432000 DAA当作同等承诺存活保证；材料裁剪/无人推进仍是风险，最终走退款。
4. Header228B、ABI8/6、动作、拓扑和随机算法不改；REFUNDING→SEALED→OPEN逆拓扑重编生成全新模板/Profile，旧UTXO不能升级。旧资料和前轮提交保留；新核心只解释新Profile，不能把旧轮次贴新标签。远端Indexer/旧插件不自动切换、不重启、不部署。
5. 新解释器要求多输入金额上下文完整后核对真实fee，REFUND末输出标EXECUTOR；移除旧“忽略fee变体”对账豁免。缺上下文是UNKNOWN，不是非法交易结论。
6. `budgetProfileId:null`，既有预算公式仅候选。默认正式build仍要求新Profile真实VM预算证据；新增**只读候选**构建模式以更新单文件交付，常量关闭plan/execute/签名/submit并展示永久双语提示，无URL/localStorage开关。不能由浏览器checkbox批准交易。此次不是主网就绪、不是可交易发布。

## 25问

|#|答案／设计证据／状态（仅实施范围）|
|---|---|
|1|每轮规范OPEN genesis CID；不是Profile或业务字符串，PASS。|
|2|origin outpoint＋DEPOSIT输出0完整SPK/value经固定KIP20哈希；新OPEN模板产生新谱系，PASS。|
|3|同CID唯一output0续接，终局0后继；普通款项不继承，PASS。|
|4|live P2SH state UTXO，228B ledger＋36N目录，PASS。|
|5|owner/config、随机domain和新Profile固定模板；timeout属代码常量，PASS。|
|6|phase/sold/purchaseCount/cursor及anchor字段按既有转换；不增状态字段，PASS。|
|7|BUY/CLOSE/DRAW_AND_PAY/TIMEOUT_REFUND/REFUND五动作，PASS。|
|8|推进permissionless，资金输入由自身脚本签名；actor为本笔领取地址，PASS。|
|9|1→1或1→0，附0..8资金输入；无新split/merge，PASS。|
|10|唯一output0后继；退款末输出从辅助转严格普通EXECUTOR；所有输出计入fee，PASS。|
|11|完整scriptFor ledger/tail与P2SH匹配，foreign链式hash固定，PASS。|
|12|input0 auth count/index＋family count/index＋CID；普通退款/执行款CID=0，PASS。|
|13|原状态派生唯一允许后继，不改目录累计和游标规则，PASS。|
|14|本金/押金/票权/冻结保持；新fee守恒与执行款收款绑定，PASS设计。|
|15|最多9输入/34输出有界求和，每值至9e15；总和低于i64，fee正且至50m，PASS设计。|
|16|同轮买家/推进者竞争同outpoint；各轮独立，PASS。|
|17|单轮最多256目录；执行成本新增长需重校准，交易发布BLOCKED。|
|18|本增量不增加全局状态；不在安全补丁中重做票权分片，PASS范围。|
|19|EMPTY/PAID/REFUNDED终局，超时432000后可转REFUNDING，PASS设计。|
|20|买家每记录原票款减REFUND_FEE，owner获DEPOSIT，actor获残额；最坏执行性仍须VM，发布BLOCKED。|
|21|Indexer发现/已接受历史/reorg投影，不决定钱；新旧Profile必须隔离，PASS。|
|22|无Indexer时权益仍由UTXO定义；构建需ledger preimage、历史或自存材料，PASS边界。|
|23|SEALED/REFUNDING链式foreign模板必须重链接，PASS。|
|24|同family三阶段，非跨轮合并；不接入不可信foreign协议，PASS。|
|25|保持有界L1小状态机；本次无Based App或全球状态扩展，PASS。|

## 14项架构材料

1. **Inventory**：每轮一live状态；owner/buyer/keeper普通资金UTXO；普通payout；Registry仅发现。没有新增对象。
2. **Schema**：Consensus=原KW20/228B＋36N、owner/config/目录/phase/cursor/anchor；Derived=fee、timeout deadline、赢家解释；Cached=页面/意图；External=Indexer候选和证明材料，经核对后使用。金额bigint/十进制字符串，脚本中signed int有界。
3. **Lineage**：`origin → canonical new OPEN → same CID successors`。模板变化产生不同root，不迁移旧UTXO；Profile不冒充CID。
4. **状态图**：`OPEN↻BUY → CLOSE → SEALED → DRAW_AND_PAY → PAID`；`OPEN → EMPTY / REFUNDING`；`SEALED --age>=432000--> REFUNDING↻REFUND → REFUNDED`。DRAW/timeout同时可用后仍互斥花同UTXO。
5. **拓扑图**：`Round A: state + ordinary funds → state' + ordinary payments`，Round B独立；终局无state'。无global lock。
6. **逐转移I/O**：BUY/CLOSE输入2..9、输出1..34，状态或押金位置不变，其余普通策略由builder约束；DRAW输入1/输出3；TIMEOUT输入1..9、output0完整余额后继；REFUND输入1..9，输出batch+2，中间为state＋buyers＋executor，末批为buyers＋deposit＋executor。所有金额计入fee。
7. **授权**：资金签名SIGHASH_ALL不变，actorPk为本笔赏金领取地址；无管理员/私钥新增，无网络签名操作。
8. **Successor**：同CID和auth唯一output0，完整模板/state/value验证；终局auth/cov为0；退款所有普通输出CID=0且P2PK收款固定。
9. **Invariants**：总入=总出+fee；fee正且<=50m；state=押金+未退票款；买家扣固定每记录退款费；actor残额必须正；immutable不变；支付/退款互斥。
10. **Exit**：EMPTY押金归owner；PAID奖池扣1 TKAS bounty和fee、owner押金；REFUNDED买家分批退出、押金退owner。超时退款开放门槛增至432000 DAA，并非保证届时已退出；数据/资源/无人推进风险不隐藏，以只读交付阻断资金操作。
11. **Indexer**：仅新Profile解释器核验真实fee上下文和退款输出；远端仍旧pin，必须独立评审发布，新版不能假装旧轮次可操作。
12. **Contention**：每轮共享state是冻结有序票号与奖池的依赖；新fee loop不引入新UTXO竞争；失败交易需重新报价，UNKNOWN不释放。
13. **L1/Based**：维持原有界L1模式；资源边界未证不等于迁往Based或提高上限，无吞吐承诺。
14. **Anti-pattern**：以下8项；本设计通过不替代编译/VM/acceptance。

## 8项anti-pattern

|项|审查|
|---|---|
|全局state|无，按轮隔离。|
|仅签名|仍验证所有授权后继和固定支付，新fee与末输出补强。|
|仅信CID|checkRoot/固定模板/P2SH/value/state保持。|
|Indexer裁判|真实输入输出来自节点；未知材料fail closed，不采见证作金额证明。|
|EVM翻译|无account mapping；状态仍UTXO替换。|
|方便而共享|不新增共享；单轮票序/冻结保持原模型。|
|无退出|三终局保留；增加等待窗口不称完全解决竞态/活性。|
|仅验bytes|完整foreign hash、SPK和binding联合验证不删。|

## 最小验证计划与边界

本轮仅固定TS／SilverScript编译、逆拓扑链接、ABI/模板/构建输入一致性、node --check与静态diff。修改必要回归源码但不执行：fee错值/负数/上限、额外赞助、退款末输出错key/value/CID、中间和末批、432000前一/等值边界、只读签名/提交关闭。真实VM预算（全部目录/游标）、新Profile acceptance、浏览器均NOT_RUN；不沿用旧Profile PASS-A或历史VM作为新Profile成功证据。

## 实施与编译结果

- 三份SIL完成真实金额fee绑定；退款末输出执行者约束；OPEN/SEALED超时432000。纯核心同步fee/金额上界、超时、执行者支付解释，移除旧fee变体豁免。金额求和最坏34×9e15=3.06e17，低于i64正数上限；这只是源码算术边界，不是VM证明。
- 固定TS5.8.3：14源→42生成文件逐字节一致。固定silverc二进制SHA验证后逆拓扑编译，再两次隔离重编比对源码／constructor／ABI／artifact／template一致，无VM调用。
- 新Profile：`7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`。

| 模板 | templateHash | tailBytes |
|---|---|---|
| REFUNDING | `7c5666912cbb968399cf47fedbcc8a4fb05406c81ae45aa8c25b9723793e784f` | 9880 |
| SEALED | `6932bc280ccda1c5117caa7308bacc0d71c9fa03e636b4aa5ee90b06045c8762` | 6479 |
| OPEN | `dc08d1ce4f7818d02c44cf828c677f4ae33a3304341e33256fd0c1fb80c31832` | 5764 |

- `npm --prefix apps/kaswin-v2 run build:candidate`退出0：41个esbuild模块输入，manifest记录48个去重文件路径；HTML **337385字节**，SHA256 `1acb946bac78c4d328c1e7d9eeb8e7cef42339909052e2f2b582b8f434f7b480`。release和dist逐字节一致；manifest文件hash/Profile/CSP脚本hash已静态核对，内联JS仅node --check解析，未执行。
- `releaseMode=READ_ONLY_UNVERIFIED_CANDIDATE`、`tradingEnabled=false`、`budgetProfileId=null`；构建常量在plan/execute/signWithWallet/submitTransaction入口禁用操作；默认交易构建继续依赖budget gate，未运行正式交易build或伪造budget evidence。raw Node源码是开发接口，不能据此声称已批准新Profile交易。
- 旧HTML `6509ee14…` 与manifest已按完整SHA归档，迭代候选亦保留；`deployed-20261005.html` hash `335fbf04…`原样。dist被Git忽略，仅本机同步可重建。
- 回归源码更新fee错值／缺上下文、赞助退款中间／末批、错误执行者key/CID/金额、432000边界及只读构建常量；**全部未运行**。最终49个MJS及打包JS仅node --check解析，git diff --check通过。最终内存编译退出0，48文件清单／全部SIL与args/artifacts hash／pins-profile-report-manifest／CSP／旧HEAD归档／dist一致性再次静态核对；回执 `references/kaswin-v2-contract-hardening-20261007-zsuQYa/final-static-receipt.json`，编译日志 `final-check-bundle.log`（路径相对 `/root/kaspa`）。
- 编译原始日志与两次复现bundle：`/root/kaspa/references/kaswin-v2-contract-hardening-20261007-zsuQYa/{compile.log,recompile.log,recompile-final.log,check-core.log,bundle-final.log}`，不含钱包或凭证。
- 本轮没有运行Node单测、examples测试、链接测试、SDK、浏览器、VM、节点或网络验证，没有读取私钥／签名／广播、迁移旧轮次或部署。无新txid/accepted/mass/fee测量，旧Profile11笔TN10记录不继承。
- 远端Indexer默认Profile仍旧206d4ec7…；本地`/root/kaspa/references/kaswin-v2`旧bundle及服务配置未改。新HTML不能将旧轮次重新贴新标签，未来上线须独立隔离新插件/Profile并保留旧轮次工具。新Profile脚本更大、成本改变，旧预算公式仅暂定。12小时为估算，超时竞态/数据裁剪/无人推进/主网兼容仍不因本补丁消失。
