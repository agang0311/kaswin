# 2026-10-07 静态审查整改：Preflight 与交付边界

> 历史记录：本页对应旧Profile `206d4ec7…` 的客户端整改。随后用户明确授权修改合约与发布文件，新规则/产物/边界以 [CONTRACT-HARDENING-20261007.md](CONTRACT-HARDENING-20261007.md) 为准。本页的fee豁免、辅助退款输出和旧HTML保留原位说明不再描述当前源码。

状态：**APPROVED FOR SOURCE IMPLEMENTATION / BLOCKED FOR RELEASE**。用户授权“按建议处理”；延续只做源码与必要编译、不运行VM或链上测试的限制，本轮也不运行单元/浏览器测试。主助手单写入者，不委托、不访问钱包、不部署、不提交交易。基础快照 `dc9e8048a3fcd5f8b1d6bec2822cf905c2f9c2b7`。

固定 Profile `206d4ec7072727ae3291726f19c82293b38340a5a7de05d306cf105c4206a9c3`、SilverScript `3ed973335b59269293564805cc2c58a14595ec03`、共识源码 `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`，不升级。已阅读知识工作区核心架构规范、25问模板、README、sources与兼容矩阵；前次完整审查在 `/root/kaspa/docs/kaswin/v2-code-review-2026-10-07.zh.md`。

## 先决决策

1. **不修改已存在合约的规则或模板。** H2采用“链上状态检查和自家builder布局策略分离”：只在已由可信节点建立selected-chain acceptance之后解释实际交易；前端普通构建/钱包批准仍维持严格布局、费用上限和签后字段检查。
2. 新纯核心解释器核验规范OPEN根、当前模板、完整ledger、后继SPK/value/CID/authorizingInput、固定位付款、真实时间下限、开奖证明和赢家；不把未被脚本绑定的fee/末输出冒称共识字段。其调用本身不能证明acceptance。
3. 真实手续费只能由实际全部输入金额减实际输出取得。Indexing已接受转换可在缺额外输入金额时报告fee未知，但不得由见证fee推算资金或伪造input context；当前状态input材料仍必须完整。前端显示/本机批准核对需要完整输入上下文。
4. 自家意图对账仅容忍**已接受交易**中脚本完全忽略的fee见证项不同，其他见证项、输出、sequence、预算、storageMass等继续逐项一致。不能放宽任意见证、重写收款人或把txid相同视为全字段一致。
5. M1采用单个IDB readwrite事务内扫描同网络所有Profile意图、验证占用、插入新意图。租约续期和归属检查是第二道防护；无原子API的Store禁止提交，不降级为list+CAS。UNKNOWN无TTL释放。
6. M2恢复 `budgetProfileId:null`，增加绑定协议源码和完整动作/目录范围的预算证据门槛；没有新VM数据，不编造通过。不覆盖旧HTML；发布仍阻断。Header精简、SIL重复phase优化留给新Profile。
7. 外部txid严格校验；缓存亦按不可信数据处理；购买链接统一转义，不通过数组顺序猜交易归属。核心普通资金预算统一10；不支持coinbase则在选币阶段统一排除；费用采用有界单调上调并验证最终费率/质量/上限，不放行未收敛候选。
8. 独立Indexer只同步本机V2 adapter源码使用同一核心解释器，原配置、服务、旧插件、数据库和部署产物不变；未部署端仍有旧问题，不能声称线上已修。

## 25问

|#|答案、证据与状态（仅此增量的设计结论）|
|---|---|
|1|规范OPEN genesis的CID；保持state.rootId/checkRoot，PASS。|
|2|origin outpoint和规范output0按KIP20派生；不改genesis，PASS。|
|3|OPEN/SEALED/REFUNDING唯一output0续接，终局0，PASS。|
|4|链上live P2SH UTXO；原文preimage候选需认证，PASS。|
|5|owner/config及三模板hash不变，PASS。|
|6|目录/sold/游标/anchor不变，内部随机字段不删除，PASS。|
|7|原五动作与三终局，不新增转移，PASS。|
|8|普通输入钱包授权，推进permissionless；修外部数据执行风险，PASS设计。|
|9|1→1/1→0及普通资金输入，拓扑不变，PASS。|
|10|同CID唯一output0；其它输出按实际SIL约束而不是builder约定，PASS决策。|
|11|精确固定模板、完整ledger和P2SH，不能仅ID，PASS。|
|12|output0 binding authorizingInput=0；同CID不得额外后继，PASS。|
|13|纯解释器按固定SIL派生状态并比较实际输出；不以忽略fee决定状态，PASS设计。|
|14|本金/押金/目录/互斥不变；本机意图原子占用与数据仅作文字，PASS设计。|
|15|实际input-output计算费用；未绑定输出明确AUXILIARY，不冒充EXECUTOR，PASS。|
|16|同轮争用同outpoint；跨轮独立，PASS。|
|17|256上限未获完整预算证据；恢复发布BLOCKED，修同源原子占用，PASS设计。|
|18|不新增全局链上共享；数据库扫描只保护链外副作用，PASS。|
|19|EMPTY/PAID/REFUNDED不变，PASS。|
|20|收款规则不变；资源/材料/无人推进风险保留，发布BLOCKED。|
|21|Indexer只解释已接受交易；普通元数据不能执行；统一解释器，PASS设计。|
|22|失去Indexer不改变共识权益；历史材料缺失仍可能不能构建，PASS边界。|
|23|三阶段foreign哈希DAG不变，PASS。|
|24|同family三模板不变；其它family附加流由节点共识验证、不冒认本轮资产，PASS。|
|25|有界L1模型不变；不引入Based App或大规模重构，PASS。|

## 14项材料

1. Inventory：每轮状态、owner/buyer/keeper普通资金、普通payout、Registry均不变；新增的意图原子事务只是Cached数据。
2. Schema：KW20/228B/36N不变；新增解释结果区分constrained与auxiliary输出、真实fee与witnessFee；Cached租约带owner/expiry，不构成链上锁。
3. Lineage：规范OPEN根认证每个被解释live阶段，input0对应snapshot.tip，不补零origin。
4. 状态图：`GENESIS→OPEN↻BUY→SEALED→PAID`；`OPEN→EMPTY/REFUNDING`；`SEALED→REFUNDING↻REFUND→REFUNDED`，无新边。
5. 拓扑图：`Round A(state+funds→state'+payout)` 与Round B独立；本机journal仅按输入冲突。
6. I/O：BUY/CLOSE/TIMEOUT核对唯一状态或押金；DRAW固定三支付；REFUND固定买家/押金/后继，末输出不虚构actor约束；自家builder继续规范支付布局。
7. Auth：SIGHASH_ALL输出承诺保留；签后不采用钱包的预算/质量；对账仅在已接受后识别未绑定fee变化。
8. Successor：模板、SPK、ledger、金额、CID、authorizingInput和同CID数量全部核对；普通附加流标签如实。
9. Invariants：本金和押金不变；实际费用不由见证推导；同库同网络不可原子插入两笔冲突意图；UNKNOWN不自动释放。
10. Exit：终局不变，裁剪/资源/材料风险未解决；不通过放宽acceptance弥补。
11. Indexer：共享纯解释器，调用者负责selected-chain acceptance、reorg和可信input0材料；修本机源码，不重启服务。
12. Contention：IDB事务串行检查占用并写journal；lease定时续期及边界检查；旧页面/其它origin/设备不获得保护。
13. L1/Based：保持当前设计，不因修复改变业务/随机/退出政策。
14. Anti-pattern：以下8项；执行验证与发布继续独立阻断。

## 8项anti-pattern

|项|本增量结论|
|---|---|
|全局链上state|不新增；IDB不是共识锁。|
|仅验签名|完整后继/支付验证保留。|
|仅信CID|必须模板/根/ledger/SPK/value一起认证。|
|Indexer裁判|只解释节点已接受事实，不能自行创造acceptance。|
|EVM式翻译|无mapping/account状态扩展。|
|为方便共享UTXO|没有新增跨轮争用。|
|无termination|保留三终局与活性边界。|
|仅验bytes|固定模板/lineage/auth binding完整保留。|

## 必要验证计划（本轮仅写源码与编译，不执行测试）

- 外部恶意txid和缓存旧数据：HTML不得解释，安全链接共享；最低浏览器/L层，未执行。
- 见证fee变体/辅助输出/时间下限/错SPK/CID/缺context：纯解释器L负例与独立VM后续交叉，未执行。
- 双标签页/过期租约/同网络跨Profile/坏意图：原生IDB竞争是最低足够证据，单MemoryStore不替代；未执行。
- 费用单调收敛/最终费率和coinbase排除/资金预算：L层，未执行。
- 256及多批退款预算门槛：必须另授权真实V层，当前BLOCKED，无新测量。

## 本轮结果

### 已实施（源码层）

- H1：Indexer记录与缓存目录校验可选txid；购买链接统一安全渲染，删除按本机记录顺序猜txid；正式构建插入script hash CSP，不允许unsafe-inline脚本。CSP浏览器兼容性未执行验证。
- H2：新增`packages/f3.2-core/src/accepted.ts`，只解释已接受且属于规范OPEN lineage的交易；完整后继/固定支付不放宽，辅助输出如实标注，不由忽略的见证fee决定金额。网页重放和本机Indexer源码复用；本机意图对账只容忍一个忽略fee参数变化，其余字段与输入上下文仍严格一致。该解释器不执行其他输入脚本、不证明acceptance/原生随机accessor，调用者不得跳过可信节点验收。
- M1：新增`IndexedStore.insertIfAbsentWithCheck()`，同readwrite事务读取意图、校验跨Profile输入冲突并插入。HTTP租约续期、失效检查及原子插入时owner检查；Store无此API禁止提交。旧页面、其它origin和设备不获得反向保护。
- M2：`budgetProfileId`恢复null；新增budget-gate绑定源码/编译器/Profile/log hash并核对9路径、目录0..256、可达退款cursor和默认预算覆盖。**没有生成budget-evidence.json或任何测量，不批准发布。** 日后收据仍需人工审查，格式校验不证明测量真实性。
- M3：核心builder直接设置普通资金computeBudget=10，assertDraft拒绝不足的普通预算；网页删除事后修补预算，金额与mass仍需最终化。
- M4：费用有界单调上调，最终候选同时满足节点费率、转发下限、全部质量和手续费上限；24轮未收敛直接拒绝，无unchecked回退。
- L1：选币排除全部coinbase，与执行期限制一致，不伪造coinbase上下文。
- 精简：删除无闭包调用的blake3KeyedNode重复实现、STAGES和部分未用import；统一购买链接和PASS-A历史fixture。可能被外部消费者使用的轻量alias暂留；重复三流程测试只共享fixture，不在未运行测试时大范围删断言。SIL重复phase和148B header压缩明确不做，避免改变现存Profile。

### 验证与交付

只运行固定TypeScript编译／生成文件一致性、esbuild `check:bundle`内存编译、`node --check`语法解析和git diff空白核对。最新编译回执：14源→42文件一致，40个打包输入、内存HTML 322152字节，退出0；日志 `/root/kaspa/references/kaswin-v2-remediation-20261007-nRZRjg/compile-static.log`。没有写出该HTML，不把内存大小当已发布产物。单测、浏览器、SDK、VM、RPC/REST网络验证均未运行。`test/remediation.test.mjs`新增8个回归场景（含正负例）但仅保存源码；MemoryStore用例不是原生IDB跨标签页证明。

保留旧HTML/manifest不覆盖，release/dist SHA256均为`6509ee1420003380484cc472763e2782a152e796a08874aa7fac5f4a3944e495`；它们仍含整改前代码，不可声称线上已修。`npm run build`正式路径依预算gate源码会在写发布文件前阻断；本轮只运行`check:bundle`，未执行正式build放行。三份SIL、linked artifacts和profile.json不变，未进行任何合约迁移。

另一工作区本机源码同步：`/root/kaspa/workers/kaswin-event-indexer/contracts/{kaswin-v2,v2-rounds}.mjs`、`/root/kaspa/examples/test/kaswin-v2-plugin.test.mjs`。没有改运行配置、数据、服务或部署产物，远端Indexer仍需独立发布与验证。

### 残余门槛

1. 原生IDB双标签页竞态、租约悬挂/恢复，浏览器CSP与XSS负例尚待运行。
2. 新解释器的所有边界与固定VM对照、最大目录/多批退款预算仍未验证；历史57 pass/1 TODO不覆盖整改代码。
3. 随机性/超时竞态、数据可用性、极端资源退出风险没有改变；没有解除生产或主网门槛。
4. 本轮为源码整改交付，不是可上线HTML版本；禁止把null改成Profile字符串绕过预算证据。
