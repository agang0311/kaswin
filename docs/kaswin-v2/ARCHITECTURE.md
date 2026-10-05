# Kaswin V2 应用增量 Preflight

日期：2026-10-04；范围：独立单文件 UI、信息呈现、只读对账游标修复。用户要求：操作简便、功能明确、信息透明。状态：本应用增量可实施；生产合约发布、协议变更、历史裁剪后的降级交易路径仍 BLOCKED。本文件不解除旧 DRAFT/BLOCKED 协议材料。

已阅读核心架构规范、25问模板、README、sources、兼容矩阵。沿用 F3.2 Profile `7ca61d81be1a2448d16b18cb2bdce845c91ed4993a6da0fd26b14d211fbce863`；SilverScript `3ed973335b59269293564805cc2c58a14595ec03`；源码核对 rusty-kaspa `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`；Node22/esbuild0.28.2/Playwright1.63.0。不升级协议、SDK或节点。

## 25 问（本增量沿用，非新合约审计）

| # | 答案、证据与状态 |
|---|---|
|1|Identity 为固定网络/Profile 下的 CID；core/state.verifySnapshot；沿用。|
|2|GENESIS input0 outpoint 和规范组输出承诺派生 CID；buildOpenGenesis；沿用。|
|3|本轮 OPEN/SEALED/REFUNDING 后继 output0 继承；终局无 covenant 后继；沿用。|
|4|当前状态在 live P2SH covenant UTXO；账本原文来自索引/本机，仅候选；沿用。|
|5|ownerKey/networkGenesis/routes/config；固定 state/protocol；沿用。|
|6|phase/sold/purchaseCount/directory/cursor/anchor/随机字段；沿用。|
|7|GENESIS/BUY/CLOSE/DRAW_AND_PAY/TIMEOUT_REFUND/REFUND；不新增边。|
|8|普通资金仅钱包本人签；推进 permissionless，受固定脚本约束；沿用。|
|9|创建普通输入→初始状态，更新1→1，结束1→0；无新 split/merge。|
|10|续接唯一状态 output0，付款/找零普通输出独立核对；builder/assertDraft。|
|11|固定三模板与完整账本编码生成 P2SH；S.verifySnapshot。|
|12|CID 与 authorizing input 均由 builder 生成并签后/接受后比对；沿用。|
|13|固定 transition 重算，UI 不决定后继；沿用。|
|14|票号不重叠、总票≤cap、记录≤256、不可变域保持、支付/退款互斥；沿用。|
|15|bigint，输入和=输出和+网络费，费用≤0.5TKAS；沿用。|
|16|同一轮购买/封盘/结算争用状态 outpoint；不同轮独立。|
|17|每轮最多256购买记录，同轮竞争；不宣称吞吐。|
|18|跨轮已分片；拆单轮需新协议，本次不做。|
|19|EMPTY/PAID/REFUNDED 三终局；沿用。|
|20|普通赢家/创建者/买家/执行者输出；缺见证/裁剪时本页可能不能构建，不能承诺永不锁定。|
|21|Indexer 负责发现、候选账本、历史显示；不决定余额或接受。|
|22|合法状态和资金流由链定义；但见证可获得性仍依赖数据保存，不混为可构建性。|
|23|固定 OPEN/SEALED/REFUNDING routes 均须核对；无新增 foreign。|
|24|三阶段模板同一 lineage；没有新增跨 family flow。|
|25|本轮有界顺序状态沿用 L1；高频/1024目录/Based App 不在范围。|

## 14 项架构材料

1. **Inventory**：普通钱包资金、每轮状态 UTXO、普通付款/找零、可选 Registry 输出；无全局合约锁。
2. **Schema**：共识账本采用固定 `package/dist/state.js` 编码、范围与 immutable/mutable 区分；金额/DAA bigint。Indexer 为 Derived；本机记录/收藏为 Cached；端点为 External。不把缓存读到的 winner 当节点复验结果。
3. **Lineage**：固定 genesis CID 派生；continuation 状态脚本随状态变化而 CID 不变；无新根、迁移或跨 family。
4. **状态图**：`GENESIS→OPEN→BUY→OPEN`；`CLOSE→SEALED/REFUNDING/EMPTY`；`SEALED→PAID/REFUNDING`；`REFUNDING→REFUNDING/REFUNDED`。到时仅允许动作，不自动执行、不自动禁 BUY。
5. **Topology**：`wallet→Round A` 与 `wallet→Round B` 独立；单轮 `state + funding→state' + change`，终局 `state (+ sponsor)→ordinary payments`。
6. **I/O**：GENESIS押金0.2+可选登记0.05+找零；BUY状态+票款资金→后继+找零；CLOSE/TIMEOUT状态+付费输入→后继或押金+找零；DRAW状态→赢家/创建者/执行者；REFUND状态(+赞助)→最多32条退款/执行者/可选后继或押金。精确顺序/金额仍由固定 builder，不由UI生成。
7. **Auth**：KasWare signPskt 只签 authorizedInputIndices，页面校验字段与BIP340，提交自己的 transaction；沿用90秒报价、IDB持久化意图、同源提交锁。
8. **Successor**：沿用完整模板/账本/CID/live UTXO/accepted transaction核验，不在本增量引入仅UTXO降级交易；不伪造 acceptedTx。
9. **Invariants**：沿用金额守恒/限额/固定Profile/一次提交。UNKNOWN 不因时间、mempool absent或无钱包输入释放。曾核验的旧记录不按DAA差自动升级不可逆接受。
10. **退出**：沿用三终局。裁剪、缺历史、缺PASS-A须明确失败。`archive()` 仅既有明确拒绝/输入失效门槛，保留“归档不证明原交易失败”的说明；不自动重报价/重发。
11. **Indexer**：摘要不能替代详情；缺金额显示未读取而非0，终局value=0不当奖金。卡片显示来源；实时接口失败时旧数据降为缓存。有界分页/详情拉取，不触碰后台。
12. **Contention**：同源沿用 `kaswin-opus-f32` journal及`kaswin-opus-submit`锁；V2偏好和catalog独立。Astra/其它origin无法共享锁，需用户避免并行提交。锁是浏览器副作用保护，不是链上共识。
13. **L1/Based**：不重设计协议。取舍以现有固定规则为边界，UI简化不削弱批准/接受证明。
14. **Anti-pattern**：见下表。

## 八项 anti-pattern

|项|检查结果/边界|
|---|---|
|全局state|无新增全局状态；单轮竞争公开说明。|
|只签名不验后继|沿用builder/assertDraft/签后核验/accepted字段比对。|
|同CID即合法|仍需模板/账本/SPK/资金/接受证明，未启用仅CID信任。|
|Indexer裁决|每次操作节点复验；展示须标来源/未核验。|
|EVM式翻译|无账户合约/可变全局存储；操作为spend。|
|便利性强制共享|沿用单轮顺序票号业务约束；跨轮独立。|
|无终局|三终局及裁剪活性限制均明确，不说资金永远不锁。|
|只验bytes|固定模板和lineage仍必须成立。|

## 2026-10-04 REST 历史备用核对增量（实现前审查）

用户授权：节点查不到的旧本机记录，使用 `https://api-tn10.kaspa.org` 备查；只读，不改合约/签名/提交/归档规则。固定 REST 源码 `kaspa-ng/kaspa-rest-server@c638eb5cceff30591cd9b35b241752878a2cfad0` 的 `endpoints/get_transactions.py`，当日抓取目标 OpenAPI v2.3.0 和真实历史 GET。GET 的 `is_accepted` 来自 transaction_acceptances 表，不是 block_hash 非空推导。API是外部索引证词，不是共识证明；缺 sequence/lockTime/SPK version/storageMass，禁止称完整逐字段复验。

25问逐项复核：1–20、22–25沿用上表答案与固定证据，无身份/授权/资金/随机/退出/foreign变化；21增加第三方历史证词，仅用于记录显示，不成为live state或资产判断。14项材料逐项：1无新增UTXO；2新增External `restCheck`（结果/来源/时间/接受块/已比对字段），与Consensus/Cached分开；3谱系不变；4链上图不变、本机显示增加“已接受·REST”；5–8输入输出拓扑/授权/后继规则不变；9–10输入保留/退出/归档门槛不变；11固定TN10只读GET，1MiB/15s上限，不重试/不上传签名交易；12每条CAS防并发旧响应覆盖；13边界不变；14下述8项复审。

8项anti-pattern逐项复审：1无global state；2不改successor验证；3不以CID认定合法；4REST不决定余额/操作，只有来源明确的历史显示；5无EVM翻译；6无新增共享UTXO；7退出/裁剪阻断不变；8模板/SPK/lineage检查不被REST绕过。全部应用增量可实施，生产与协议发布仍非本范围。

实现契约（最终实现，替代初稿）：
- 触发：节点对账结果仍 UNKNOWN 且记录已超过10分钟（新提交由节点自行查找，不把每个新txid都发给第三方或轮询）。只读 GET `/transactions/{txid}?inputs=true&outputs=true`，固定TN10地址、`credentials:'omit'`、无请求体、1MiB/15s上限、不重试；金额lossless解析为bigint。
- REST只提供**位置**：严格 txid 绑定、`is_accepted===true`、`accepting_block_hash` 后，交给节点在该块运行与普通对账相同的 `acceptedAt`（选中链+接受集合）和 `matchesDraft` 全字段比对。通过才写真正的 ACCEPTED（`locatedBy:'REST'`），可作本机后继。
- 节点矛盾（块离链、该块接受集合无此交易、字段不符、区块头仍在但 blue score 不符、或声称的接受块不早于节点裁剪点却无区块头）→ 以节点为准，删除REST证据，保持UNKNOWN。缺区块头仅当REST blue score低于节点裁剪点 blue score 才算正常裁剪。
- 节点已裁剪/不可用、且REST可取得字段（version/subnetwork/payload，输入outpoint/computeBudget/见证，输出数量/金额/脚本/covenant绑定）全部与本机批准记录一致 → 仅显示层「已接受 · REST」。共享journal仍为UNKNOWN：输入保持占用、无localTip、归档门槛不变、不重发。
- 证据生命周期：`restWitness` 保存首次观察时间；之后REST 404/5xx/超时（REST自身保留期、限流）不是新信息，保留证据；REST报告未接受、字段不符或节点矛盾即删除。每次显示需绑定最新节点核对（`nodeCheckedAt===checkedAt`），CAS防止慢响应覆盖其他标签页结果。
- 透明度：详情显示节点自行查找失败原因、REST来源/查询时间/接受块/比对字段/REST未提供字段、节点对该块的核对结论（含裁剪点 blue score）。页面说明txid会发送给第三方公开索引。

## 默认端点配置增量审查

默认节点 `wss://tn10.kaspay.top/wrpc`，默认 Indexer `https://tn10.kaspay.top/indexer`。本次仅改变 External 配置与默认端点；不修改共识、合约、签名、提交或服务配置。25问逐项复核：1–20、22–25答案及证据沿用；21仍是发现/候选账本。状态：本应用配置增量可实施，不解除生产 BLOCKED。

14项材料逐项：1无新增UTXO；2配置版本升至3、只迁移原默认host，保留自定义端点/交易库，游标仍属Cached位置提示；3谱系不变；4链上转换图不变；5拓扑不变；6输入输出不变；7批准/签名/提交权限不变；8模板/lineage检查不变；9旧游标必须经当前节点检查，不能作为接受或释放依据；10退出及裁剪限制不变；11其他Profile单独标注、不混入本Profile资金/派奖统计；12保持CAS与原锁；13仍是既有L1应用；14以下复审。

8项anti-pattern复审：1无global state；2不减少successor核验；3不以CID认定合法；4新Indexer不决定余额/资金/接受；5无账户式转换；6无新增共享UTXO；7终局/裁剪边界不变；8不绕过固定模板/脚本/lineage。身份、授权、资金、随机、退出、foreign无新增未决项。

迁移边界：仅当新节点URL尚无游标时，从退休URL复制旧hash；保留原键与交易记录，以原始selected-chain搜索、完整接受交易及批准字段比对作最终判定。离链/缺头/裁剪/字段不符仍UNKNOWN；CAS冲突停止，不覆盖并发更新，不重发。配置版本≥3后用户主动填写的自定义设置不再自动覆盖。构建只改写被打包的Opus默认常量，磁盘共享源码不改；迁移匹配器仍保留识别旧地址的能力，但旧地址不再是连接目标。浏览器测试同时检查网络请求，而不只依赖HTML字符串扫描。

## 2026-10-04 本地明文端点使用增量

范围：明确既有 `ws/wss` 节点与 `http/https` Indexer支持，添加协议/本机地址/混合内容提示与真实浏览器明文端口保存测试；不增加代理服务、不自动升级或降级协议、不清除设置/交易库、不修改连接、签名或合约规则。25问1–25与14项材料1–14答案沿用，变动仅External配置使用提示；8项anti-pattern结论不变。此UI增量可实施；共识、资金、授权、退出、随机与foreign无新增问题，不解除生产BLOCKED。

页面允许保存明文端点，不因HTTPS页面或公网明文而禁用保存；浏览器混合内容/CORS/本地网络权限是独立限制，页面不可绕过。推荐可信设备上以本地HTTP提供单HTML，无证书要求；HTTP局域网页面本身可被篡改，不宣称仅靠合约检查即可消除所有风险。钱包扩展是否在相应origin注入仍须实际验收，浏览器模拟不替代真实钱包。变更网页origin后本机数据不自动迁移，禁止建议清库或重发未知交易。

## 2026-10-04 图标 / 中英文 / 本地时区增量（实现前）

范围仅V2呈现层：设置用齿轮，主题用目标模式太阳/月亮并提供可访问名称；中英文偏好独立保存；浏览器本地时区显示时间戳，DAA/期限判断/ISO导出不变。25问1–25逐项沿用本页答案和固定证据，无新的identity/state/transition/successor/invariant/concurrency/termination/infrastructure决策。14项材料1–14均沿用，仅第2项增加Cached语言偏好和Derived本地时间字符串；第11项保留所有索引/缓存/REST/节点证据边界的双语解释。八项anti-pattern 1–8结论均不变：不新增全局UTXO、不弱化后继/模板/lineage验证、不以CID或Indexer认定资金、不增加账户式语义或共享竞争、不改变退出。

实现门槛：翻译只改变DOM文字和可访问提示，不改输入值、数据属性、链接、共识对象、金额、交易记录、动作枚举或错误分支；切换语言不签名/提交/释放输入。动态插值作为文字，不把翻译/外部错误重新解释成HTML。时间用Intl，不猜用户IP位置；不把DAA当Unix时间。原始诊断保留，不能把未覆盖的节点错误伪造为成功。此UI增量可实施，生产、真实钱包和新链上操作仍不在本次授权范围。

## 明确排除的未验证草稿

前轮 `engine2.mjs` 草稿中的24h失效、无钱包输入可放弃、DAA差恢复最终接受、合成acceptedTx/裁剪降级均撤回，不进入交付。RPC高优先级提交不能由低优先级24h过期配置证明失效；mempool absent不是永久不传播证明。前轮sink样本69/230离链仅短时观测，不能外推为用户UNKNOWN主因。

引擎增量：有界寻找离链游标的选中链祖先，再交给原始接受查询和逐字段核验；祖先不存在/查询失败则保持原安全失败路径。归档进一步收紧为实际outpoint不再live，而非将金额/SPK不符的泛化STALE_INPUT当已花费；网络失败也不能释放。测试必须覆盖离链、查询中再次重组、裁剪、不明保留、过期不释放及不重发。所有新验证按S/L/N分别写README与维护记录；本次不签真实钱包、不广播。
