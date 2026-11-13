# 独立C协调顺序分片（历史候选）

当前设计见[单活动片滚动分片设计](ROLLING-ACTIVE-SHARD-DRAFT.md)：不单独设置C，由唯一活动片S_i保存全部旧片索引，满256笔时封存并创建S_{i+1}。本页保留早期独立C方案供历史参考，不代表当前设计。

旧候选状态：**DRAFT / BLOCKED — DO NOT CODE**，不是V2.0.2现行能力或实现批准。工作目录为仓库 `kaswin/`；历史存档只读。

早期流程：先获取C，根据C定位活动片Sa；Sa能继续售票就更新Sa，达到分片容量后创建Sb并在Sb购买；C记录全部已创建Sn的UTXO定位、购买次数和票数；Sn保存本片完整购买记录。以下内容仅对应该旧方案。

下文“同交易相对定位”、换片不消费旧满片、结算也同步C是为满足该流程提出的技术候选，尚未编译或证明；分片数量/容量、押金与费用、初始化身份、最坏资源及异常退出未冻结。证据仅S源码阅读与设计推导；测试、构建、VM、网络检查均 **NOT_RUN**。不签名、广播、提交或推送。

## 1. 来源与实现边界

遵循[核心架构规范](../../knowledge/contracts/core-architecture-spec.md)、[25问/14材料/8项模板](../../knowledge/contracts/architecture-preflight-template.md)、[来源](../../sources.md)和[兼容矩阵](../../knowledge/contracts/compatibility.md)。本候选不自动升级当前Profile或工具链。

- rusty-kaspa v2.1.0 `01b532e8b553523216471682649693af92f0fd16`：[tx hashing](https://github.com/kaspanet/rusty-kaspa/blob/01b532e8b553523216471682649693af92f0fd16/consensus/core/src/hashing/tx.rs)。`id_v1 -> write_rest_preimage -> write_transaction -> write_output`承诺输出SPK；在C的状态前像内写入同交易新Sn的txid会形成哈希自引用，不能靠先算txid再回填解决。
- 同版本[opcodes](https://github.com/kaspanet/rusty-kaspa/blob/01b532e8b553523216471682649693af92f0fd16/crypto/txscript/src/opcodes/mod.rs)：`OpOutpointTxId`、`OpOutpointIndex`可读真实输入的前序outpoint，不是读取本交易尚未生成的txid。
- SilverScript v1.0.0 `3ed973335b59269293564805cc2c58a14595ec03`：[expression lowering](https://github.com/kaspanet/silverscript/blob/3ed973335b59269293564805cc2c58a14595ec03/silverscript-lang/src/compiler/compile/expression.rs)将输入outpoint内省映射到上述opcode。仅核对接口源码，不证明本文多角色合约已可执行。
- rusty同版本[covenants context](https://github.com/kaspanet/rusty-kaspa/blob/01b532e8b553523216471682649693af92f0fd16/crypto/txscript/src/covenants.rs)及[CID hashing](https://github.com/kaspanet/rusty-kaspa/blob/01b532e8b553523216471682649693af92f0fd16/consensus/core/src/hashing/covenant_id.rs)：身份、auth-local、family-wide、genesis和ordinary集合仍须分别检查，不能把同CID当合法角色证明。
- [storage mass](https://github.com/kaspanet/rusty-kaspa/blob/01b532e8b553523216471682649693af92f0fd16/consensus/core/src/mass/mod.rs)：输出项按金额与plurality计算，完整storage mass还须扣相应输入项。4 KAS不是共识规定的每UTXO押金；单个输出项不能直接当整笔质量或手续费。

## 2. 对象、身份与字段

| 对象 | 职责与资金 | 创建/消费/终止 |
|---|---|---|
| C | 全轮规则、全部已创建片摘要与定位、总票数/记录数、活动片、唯一决策、协调押金/储备 | 创建轮次；每次售票及候选结算更新；所有资金责任结束后终止 |
| S_i | 本片完整目录和票款；不能绕过C变更 | 首笔本片购买时创建；本片购买、派奖或退款时消费；票款退出后终止 |
| 普通资金输入 | 买家票款、手续费/明确赞助 | 出资者签名，明确找零 |
| 普通付款输出 | 赢家、退款买家、创建者、执行者的规定款项 | 不假定仍在covenant后继枚举内，逐项校验 |

身份候选沿用“合法初始C发起谱系、受约束发行S角色”：外部R域隔离到网络/Profile/初始C身份；片身份 `(R, role=S, i)`。研究同family多role模板以避免两个独立模板互相嵌入动态哈希；唯一初始C、角色不可伪造、每个i只发行一次及完整模板互验仍BLOCKED。S不得嵌入动态C后继的txid/SPK作为自引用，也不得仅信外部传入R。

逻辑schema（**不是最终ABI**）：

| 位置 | 字段 | 分类/约束 |
|---|---|---|
| C固定规则 | 网络/Profile域、创建者、票价、全轮票数/记录数上限、maxShards、每片记录上限、最低开奖票数、阶段成熟规则、费用政策 | Consensus、immutable；金额用sompi有界整数/bigint或十进制字符串；确切字节宽度与边界待冻结 |
| C全局进度 | phase、shardCount、activeShard或NONE、totalPurchases、totalTickets、决策/结算进度 | Consensus、mutable；编号连续不留洞；票数与购买次数严格区分 |
| C每片条目 | i、purchaseCount、ticketCount、全局起始票号、目录承诺/预期状态承诺、当前票款金额、locator、结算状态/游标 | Consensus；售票结束后原始票权摘要固定，退款游标与剩余金额另记，不改原始票权 |
| S固定字段 | role/i、规则域、固定全局票号起点、合法C验证规则 | Consensus、immutable；从C合法发行取得 |
| S动态字段 | 本片count/sold、完整directory、退款阶段/cursor | Consensus；每条记录包含买家公钥及确定票权的数量/累计终点；编码与上限待冻结 |
| 查询视图 | 已解析outpoint、历史、我的票、展示进度 | Derived；来源须匹配具体C outpoint/接受上下文，不能跨版本拼装 |
| 本地与服务配置 | 报价、未决占用、缓存；RPC/Indexer地址 | Cached/External；不能改变资金或授权 |

C的“全部Sn”只指**已合法创建**的片，不预先生成全部空片。首片由第一次购买创建；规则预先限定最大容量，按需发行并不允许无限扩容或随意修改容量。

## 3. UTXO定位：同交易相对引用与固定引用

完整outpoint是 `txid:outputIndex`。新C与新S在同交易生成时，C不能把该交易txid写进自身哈希前像。候选locator采用规范枚举：

- `WITH_C(outputIndex)`：该S与当前这个C outpoint来自同一笔交易。解析为 `C.outpoint.txid : outputIndex`；不在C字节中写该txid。
- `ABSOLUTE(txid, outputIndex)`：该S是之前已经确定的输出；C账本可以保存其完整outpoint。
- `TERMINAL`：该片没有活动后继；保留原始票权和结算摘要，不把已花费位置当live。

固定布局示例（仅候选）：输出0是C，输出1是本次创建/更新的S，之后是规定普通输出。

```text
交易X：C=X:0，Sa=X:1
C账本记录Sa.locator=WITH_C(1)

继续买Sa，交易Y：消费X:0和X:1 -> C'=Y:0，Sa'=Y:1
C'仍记录Sa.locator=WITH_C(1)

Sa满了，下一笔交易Z创建Sb：消费Y:0和买家资金 -> C''=Z:0，Sb=Z:1
Sa不变，仍是Y:1
C''记录Sa.locator=ABSOLUTE(Y,1)，Sb.locator=WITH_C(1)
```

把旧Sa转成固定引用时，Y来自实际C输入的previous outpoint txid，可由脚本核验，不由Indexer随意指定。读取S时还必须核对其模板、谱系/role/i、金额、目录与C中承诺，不能只匹配位置。

**每次C变化都要处理相对引用**：某条WITH_C指向的S若未共同更新，必须先按旧C输入outpoint解析并转成ABSOLUTE，再构造C后继。CLOSE只更新C时尤其如此；否则会把S错误定位到CLOSE交易中。初版每步至多更新/创建一个S，只有它可改为相对新C的WITH_C；终止的S改TERMINAL。多片批处理须另定义多个相对输出及全集约束。

此结构是定位候选，不表示已经解决初始C真实性、模板互验或可执行性。

## 4. 售票、换片与封盘

```text
创建轮次：资金 -> C_SALES（shardCount=0，无空S）
首次购买：C_SALES + 买家资金 -> C_SALES' + S0（含首笔记录）+ 找零
继续购买：C_SALES + S_active + 买家资金 -> C_SALES' + S_active' + 找零
满片换片：C_SALES + 买家资金 -> C_SALES' + S_next（含首笔记录）+ 找零
封盘：    C_SALES -> C_SEALED
空轮退出：C_SALES（0票/0片）-> 创建者等规定普通付款
```

“满片换片”候选可以不消费旧满片：前一笔购买已经让C与旧片原子记录相同的最终count/sold/目录承诺。旧片的一切后续消费必须经真实C授权，BUY要求自己仍是activeShard；C切到下一片后旧片不能再购买。C仅凭摘要作换片校验的正确性，依赖上述归纳不变量与完整输出约束，尚待证明。不能只靠UI把旧片标为只读。

用户所谓“Sa不能买”须具体化：仅当合约规定的本片容量已满且全轮仍允许售票，才开下一片。C已封盘、全轮票数/记录数/片数达到上限、金额不够、网络错误、旧报价、找不到Sa或账本前像缺失，都不能当成开新片的理由。新片编号必须等于当前shardCount，不能跳号或替换历史片。

继续买时C和S共同检查：新增一条合法记录；票权增量q相同；票款增量为q×price；总票数/次数、片内票数/次数同步；其他片经济摘要不变（只有必要的locator规范化可变化）；C规则/押金与旧目录前缀保持。按序填片使全局票号可在购买接受时确定，片起始票号固定，C不需要预分配每片独立票额。

CLOSE与BUY争用同一C。全部BUY都验证实际C_SALES时，封C即可阻断所有片的新购买，且C已有最终全轮汇总，无需并行候选中的逐片收集冻结。按哪个接受分支生效仍需节点确认；到期时间不会自动替用户执行CLOSE，成熟下限也不等于绝对停售上限。

## 5. 开奖、结算与全程定位一致性

C_SEALED固定总票数、片顺序/区间、每片原始目录承诺及随机锚点。候选DRAW验证随机证据和全局票号，提供命中片的目录前像并核对承诺，得到唯一赢家；不需要仅为读取票权而消费全部Sn。PASS-A上下文、随机偏置/超时竞争和资源仍需重新证明。

```text
C_SEALED -> C_WIN（唯一赢家，不可改为REFUND）
合法超时/不足开奖条件：C相应阶段 -> C_REFUND（不可改为WIN）
C_WIN + S_i -> C_WIN' + 给同一赢家的片奖金及规定费用输出
C_REFUND + S_i -> C_REFUND' + S_i' + 本批买家退款
最后一批退款：C_REFUND + S_i -> C_REFUND' + 本批买家退款
全部片终止后：C -> 剩余押金/储备的规定普通付款
```

**全程表一致性候选**：若C的locator必须在结算期也始终指向各Sn最新状态，则每次S退款更新也共同消费C，按第3节规范化locator。这样退款也串行；不能同时沿用旧并行候选“Sn自行退款而C不更新”并声称C表始终最新。若以后允许独立退款，C表语义须改成冻结检查点，另设计当前tip定位。

原始票权摘要不因退款而重排；剩余金额/cursor与当前状态承诺分别更新。派奖的S终止，逐片支付记录不可重复，C的全局WIN/REFUND决定不可互转。无数据、无人推进、最后片费用不足、C储备耗尽时的资金退出仍BLOCKED，不以“已找到outpoint”冒充可以完成花费。

## 6. 资金、资源和客户端

押金只放C、S由首笔票款开片是当前经济候选，不是沿用现行合约即可实现。售票期候选约束：C金额为约定押金/协调储备，S_i金额为本片票款；网络费由明确出资方承担，不能暗减本金。退款须定义本金扣费、执行者补贴和尾批资金，全部交易满足输入=输出+fee；现行最后一批从每个状态押金扣费的规则不能照搬到无押金Sn。

上一轮讨论中的 `4×10^12/value` 只是p=2合约输出的storage mass输出侧项。输入抵扣、找零、计算/瞬时质量、费率与节点政策均影响完整交易，不能断言每次净增加固定费用或输入抵扣恒小。新开片费用是否更高也需完整交易测量，不预先保证数值。

C存片摘要而不复制购买记录，S仅保留本片目录。但C数组随已创建片数增长，每笔BUY都要携带/校验C；完整位置、承诺、计数、金额与状态字段可能令数百片的C目录达到数十KB。最大M、B、字节布局、脚本大小、质量及预算必须先限定后测，不把256×256自动视为已支持。

客户端顺序：定位并核验当前C及其完整前像 -> 从C解析活动片或合法首次开片条件 -> 取得必要S目录并核对真实输入 -> 构造/报价/批准/签名 -> 提交并按acceptance跟踪。换片不需要提前单独发空片交易。签名前竞争可重新报价；签名后不能静默换outpoint或费用；UNKNOWN不释放输入或另买一笔。网络/Profile/轮次、节点视图、C outpoint与S状态必须绑定同一观察上下文。

Indexer负责C谱系发现、C/S前像、历史、用户票据查询及重组撤销；C提供可核验的片清单和全轮统计，不依赖Indexer挑选哪些片计入。定位不等于数据可用，必须保存C历史、完整Sn目录及重放/备份材料，普通裁剪节点不保证恢复全部历史。关闭主要Indexer后的恢复与退出是未来需明确授权才执行的验证目标，本次NOT_RUN。

## 7. 逐动作审查卡摘要

候选固定输入C为0，继续BUY/结算时S为1；只在这些动作出现规定S输入。C输出0，存在S后继时输出1；普通费用与找零后续排列，精确数量上限待冻结。下表不把现行单状态input0检查直接移植为多角色正确性。

| 动作 | Covenant输入→后继 | 核心校验与拒绝情况 | 未闭合项 |
|---|---|---|---|
| INIT | 0→C | 真实普通出资、唯一C genesis、空表/0票/规则固定、完整找零 | CID生成/模板/初始化失败退出 |
| FIRST_BUY | C→C'+S0 | SALES/空表、首次记录与票款、同交易locator、精确新增角色 | 1:2发行与全部genesis/ordinary输出 |
| BUY | C+S→C'+S' | 输入定位/承诺匹配、active匹配、目录仅追加、计数/本金一致 | 多输入相互校验、最大C/S资源 |
| ROLL_BUY | C→C'+S_next | 旧片确满、全轮未满、固定旧片位置、只发行下一编号 | 不消费旧片的归纳证明、角色唯一 |
| CLOSE/ABORT | C→C' | 规范化全部相对定位、固定票权/名册、合法阶段与成熟条件 | 时钟/空轮/不足票数/超时条件 |
| DRAW | C→C_WIN | 固定锚点/全轮抽样、命中片前像与区间、公钥唯一 | 随机证明、预算、延迟/超时竞争 |
| PAY_i | C+S_i→C' | 同轮/模板/原始摘要、WIN且赢家不变、足额付款、无S隐藏后继 | 费用来源、末片推进、统一赏金分摊 |
| REFUND_BATCH | C+S_i→C'+可选S_i' | REFUND、cursor/收款人/金额、无重复退款、locator/余额更新 | 无押金尾批、完整费用上限 |
| END/EMPTY | C→0 | 全部资金责任完成或真正空轮、剩余储备按规则普通付款 | C最终释放与无人推进经济闭环 |

共通要求：每个covenant输出只有一个authorizing input，需逐动作冻结其分配；同family不代表两个输入都授权了同一输出。验证完整family/role集合，显式处理genesis和普通输出，禁止额外C、旧片伪后继、重复片或跨轮混入。普通出资人签名须覆盖被批准的网络、输入/输出、金额及费用；permissionless执行不允许任意选择奖金/退款收款人。以上约束待落实到脚本与反例，非实现通过。

## 8. 25问Preflight

以下“已明确”仅指用户方向/设计要求；实现相关项均BLOCKED，不以文字答案充当证明。

| # | 答案、证据与状态 |
|---|---|
|1|R为域隔离的初始C身份，片为(R,role,i)，第2节；身份认证BLOCKED。|
|2|先创建合法C，再由C受约束发行Sn；固定CID源码第1节，genesis/模板BLOCKED。|
|3|C唯一延续，S按编号延续至结算终止，普通付款不继承；第7节，BLOCKED。|
|4|C存全部片摘要/定位与全轮状态，S存本片完整目录/票款；用户已明确，第2节。|
|5|规则/模板/域/编号/票价固定；片全局起点固定、封盘后原始票权固定；第2–5节，编码BLOCKED。|
|6|C计数、locator、活动片/阶段/结算进度，S目录追加及退款cursor；第2–5节，BLOCKED。|
|7|INIT/FIRST_BUY/BUY/ROLL_BUY/CLOSE/DRAW/REFUND决定/PAY/REFUND_BATCH/END；异常退出BLOCKED。|
|8|合法动作permissionless、普通出资者签名，购买明确批准；第6–7节，签名域BLOCKED。|
|9|C首发/开片1:2，正常购买2:2，封盘1:1，付款2:1，尾批2:1，C退出1:0；第7节，完整布局BLOCKED。|
|10|只能出现规定C/S后继及普通付款/找零；需分别验genesis/continuation/ordinary，第7节，BLOCKED。|
|11|核完整模板、ledger、SPK、role、身份和金额；第2/7节，foreign/自模板方案BLOCKED。|
|12|按每输出单authorizer与family集合验证，不直接复用单状态计数；第1/7节，BLOCKED。|
|13|输入locator复验，记录追加/旧片摘要保持，WITH_C规范化；第3–4节，正负例BLOCKED。|
|14|一轮唯一C、连续唯一片、单活动片、总票数/次数等于片和、无超售漏票、WIN/REFUND互斥；第2–5节，证明BLOCKED。|
|15|输入=输出+fee，本金/押金/储备分别约束、片无押金尾批另设计；第6节，BLOCKED。|
|16|同轮所有BUY/封盘争抢C；正常BUY还争抢活动S，钱包资金可能跨轮争用；第4/6节，方向已明确。|
|17|每轮一个售票竞争域，跨轮独立；候选结算也串行，不宣称吞吐提升，资源/性能BLOCKED。|
|18|目录/资金已分片，第一版用户接受同步全轮计数/票序与封盘；BUY无C方案后续研究。|
|19|WIN全片向统一赢家支付或REFUND逐片退完，最后退出C；第5节，无数据/无费用等BLOCKED。|
|20|普通输出到赢家/买家/创建者/规定执行者；第5–7节，尾批与C储备释放BLOCKED。|
|21|Indexer负责发现、前像、历史/用户查询、接受/重组视图；第6节，不裁决片清单/票权。|
|22|合法片集合、票权、资金规则仍由链上定义；C/S原文与最新C恢复须独立保障，第6节，BLOCKED。|
|23|需要C/S完整模板角色互验；相同CID不能替代，第2/7节，循环依赖与伪角色BLOCKED。|
|24|需要多状态输入/输出协作、唯一角色与完整输出路由；第7节，BLOCKED。|
|25|有界片表/局部目录、首版串行的L1候选；上限未测，超限另评估数据承诺/Based App，BLOCKED。|

## 9. 14项材料索引

1. UTXO inventory：第2节，C/S/普通资金与付款，无单笔Ticket UTXO。
2. Schemas：第2–3节，分类/变更边界与locator；具体字节布局和范围仍BLOCKED。
3. Lineage：第1–3节，初始C→顺序发行片，禁止同交易txid自引用；身份模板证明BLOCKED。
4. 状态图：第4–5节，售票/换片/封盘/唯一决策/退出；异常出口BLOCKED。
5. UTXO topology：第3–5节，所有BUY共用C，旧片不参与其他片购买。
6. Transition I/O：第7节，输入/输出角色与候选数量；精确上限及authorizer分配BLOCKED。
7. Authorization：第6–7节，签名批准、permissionless、UNKNOWN与网络隔离。
8. Successor validation：第3–4/7节，定位、模板、role、资金、目录、完整集合，无隐藏后继。
9. Invariants：第4–5节及第8节14–15问，完整票权/唯一活跃/名册/资金与模式互斥。
10. Terminal/payout：第5–7节，统一赢家/退款/尾批/C退出，费用与数据异常BLOCKED。
11. Indexer：第6节，全部片定位从C导出、原文保存与重组恢复，不能拿位置代替数据。
12. Contention：第4/6节及第8节16–18问，串行是首版接受的全轮一致性取舍，非全应用共享锁。
13. L1/Based：第6节及第8节25问，完整C表和局部S的资源边界未测，不承诺无界规模。
14. Anti-pattern：第10节，无代码，未将设计要求写成实现已通过。

## 10. 8项Anti-pattern

| # | 设计审查结论 |
|---|---|
|1 全局状态管所有用户|一轮一个C，跨轮独立；为同步总票数/连续票序/原子停售而共享，用户接受首版串行，仍需规模证据。|
|2 只签名不验后继|第7节要求完整集合/金额/模板/状态；尚无实现，BLOCKED。|
|3 同CID即合法|第2/7节明确真实genesis与角色谱系约束，不能信任自报R，BLOCKED。|
|4 Indexer决定余额/票权|C承诺完整片表与统计，S受约束更新；Indexer仅提供可核验材料，缺数据不得补零或跳片。|
|5 逐字段远程读取|脚本只核实际输入与承诺/前像；换片不消费旧S依赖已证明的状态不变量，不假装远程查询其当前值。|
|6 方便而共享一切|购票共享C有明确票序/计数/关闭依赖；若全程最新locator则结算也共享，未来独立退款需改变表语义。|
|7 没有退出|第5–7节列普通资金出口；无数据、尾批、无人推进、资源超限依旧BLOCKED。|
|8 只验bytes|第2/7节要求完整SPK/模板/身份/role/value/binding，不以账本哈希独自授权。|

## 11. 下一步证明范围

先冻结maxShards/每片容量和字段编码，完成C与S角色身份、发行与换片归纳证明；单独证明所有C转换下locator不会失效，所有Sn变动都遵循选定的表一致性政策。之后闭合开奖/退款互斥、尾批费用与C最终退出、前像独立恢复，并测最大C表+最大S目录资源。若获明确测试授权，再做相对/固定引用、伪满片、跳号、旧C/旧S、换片竞态、封盘只花C、退款跨片定位、额外同CID输出、重组及缺数据等必要正负例。本次只交付文档，所有执行验证NOT_RUN。
