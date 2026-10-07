# Storage mass admission：审查与实测记录

基线 `97d42155c5f160435ce52abe2b15a535e2c20472`，rusty-kaspa 固定 `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`。当前状态 **STORAGE MASS ADMISSION BLOCKED**（候选已实测，尚未 production-enforce）。不继承旧 VM 的整笔交易 PASS。

## 本轮 scoped preflight

沿用 [25 问、14 项架构交付、8 项 anti-pattern](production-consensus-gate-preflight.md)，本轮仅经济准入可变，其余身份、状态、授权、拓扑、PASS-A、赢家与退款调度不变：

- 问1–3：canonical outpoint 派生 C；普通输入无 C，非终局 Output0 继承，终局销毁。
- 问4–6：单轮 live UTXO，现有 immutable 参数不变；sold/目录/cursor 仅按既定转换更新。
- 问7–9：BUY/CLOSE/DRAW/PAID/REFUND/EMPTY 原转换不变；permissionless；费用普通输入非共享状态。
- 问10–13：现有 exact SPK/state/lineage 验证不变；准入附加条件只能收紧合法状态。
- 问14–15：押金全额隔离，退款 fee 不超界；新增 storage 容量与费向量可行性证据义务。
- 问16–18：单轮购买及 cursor 消费竞争不变，不新增 global state 或分片。
- 问19–20：有购买退款自付手续费；空轮外部 sponsor；成交后 draw-only。gross/deposit 参数未验证前禁止实施常量。
- 问21–24：无新增 indexer/foreign/multi-contract；来源/发现缺口不在本轮解决。
- 问25：沿用 bounded L1 covenant，不引入 Based App。

14 项交付沿用既有 inventory/schema/lineage/状态图/拓扑/I-O/授权/successor/invariants/exit/indexer/contention/L1边界/anti-pattern；本页对 I-O 金额准入、invariants 和 exit 的 storage 可行性做增量说明，不以研究候选代替生产批准。8 项 anti-pattern 全部沿用；本轮重点第7项退出不遗漏 capacity，以及第8项用真实生产 P2SH/UTXO plurality 而非假造脚本大小。

## 已批准研究范围与开工门槛

允许构造实际 production refund 交易调用 pinned `MassCalculator::calc_contextual_masses`，二维粗扫/边界搜索与手续费分配对比。此为离线资源分析，不是签名/VM或在线网络集成。生产 admission 仅在金额、押金、fee allocation 全部证明后写入；未闭环必须 BLOCKED。

B 的逻辑条件：若最终 failed sale sold<min，则所有此前 BUY 的 new_sold<min（sold 单调且无减少路径），所以链上条件 gross floor 足以覆盖该轮每条退款记录。达到 min 的那笔以及后续 BUY 不再可能进入 failed-sale refund，不需要 refund gross floor。deadline/purchase-cap/ticket-cap 不改变该单调性。

## 共识与政策边界

storage 是区块共识容量，不是 relay fee。增加手续费会缩小 buyer output，可能恶化 storage；多付费不能购买 capacity。解释性 harmonic 分解不作为最终裁决，最终采用真实 MassCalculator。特别注意单个 output contribution 超 500k 不自动等于净 storage 超限，必须扣除 input-side contribution。

## 实测结果与候选（不是全域 admission 证明）

完整可复现 harness：`tests/rust-vm-validation/src/bin/storage_mass_admission_test.rs`；原始二维表/命令退出码：`artifacts/storage-admission/`。使用 production universal refund body，固定编码 fee witness，预算40作为保守资源预算。搜索所有指定 P=1/17/256 的调度 cursor，但不是 CREATE/BUY 连续 lifecycle。

旧 gross=1,510,000、deposit=50,000,000、fee=0：P1 净storage=604,597（buyer harmonic=662,251、creator=20,000、input subtraction=77,654），P17=5,971,831，P256=10,596,553。因此旧最低票价不能单独保证退款活性。

真实 plurality：state input=2、非终局 successor=2、buyer/creator=1。目录在 redeem preimage 中，不直接扩大 P2SH SPK plurality；covenant ID 的存储开销使 state plurality 为2。

旧 P256 gross=6,000,000、deposit=50,000,000，改用恰好覆盖relay的平衡费向量后：非终局 storage=2,763,154，harmonic=2,765,676，state contribution=2,684，16 buyer 各172,687，input subtraction=2,522。终局 storage=2,755,388，harmonic=2,782,784，creator=20,000，buyer各172,674，input subtraction=27,396。与 checkpoint 总数略有差异是费向量不同，不覆盖历史记录。根因主要是小额 buyer output。

### 二维边界

以下为 equal-gross 退款族、平衡费向量、固定预算40的整数二分结果，不是所有可达金额分布的全域 hard minimum：

| deposit | gross 首个可行边界(storage<=500k) | gross 边界(storage<=400k) |
|---:|---:|---:|
|5,000,000|52,715,970|78,961,310|
|10,000,000|39,595,887|52,721,485|
|20,000,000|35,230,114|45,229,460|
|50,000,000|33,068,898|41,704,248|

固定 gross=50,000,000：deposit 二分边界为5,445,467（500k）和11,961,866（400k）。取研究候选 gross=50,000,000 / deposit=20,000,000，不是因为旧 fixture 0.5 KAS 押金而冻结。

|候选路径|storage|500k余量|
|---|---:|---:|
|P1 terminal|13,400|486,600|
|P17 K9 nonterminal|185,539|314,461|
|P17 K8 terminal|201,086|298,914|
|P256 K16 first|321,364|178,636|
|P256 K16 terminal（该族最坏）|366,450|133,550|

所有上述候选 refund cursor 真实 committed VM 执行成功，且assert fee>=relay、storage<=400k、compute/transient容量；K_MAX=16未改变。P256非终局总fee=3,347,000，均分每人209,187或209,188；终局总fee=3,340,000，每人208,750。fee均不超过1,500,000，net payout不低于10,000。集中扣费的对比另见原始日志；平衡分配避免集中缩小一个退款输出。

成功最低经济边界的**仅金额/plurality测量**：gross_pool=250,000,000，winner=100,000,000，reward=100,000,000，fee=50,000,000，deposit=20,000,000，storage=55,186。此行仅P2SH形状 mass 测量，没有 production WINNER_READY VM，不冒称成功终局验证完成。deposit=1,000,000 时storage=1,004,064，deposit=2,000,000 时504,128，说明押金>=1同样不足。

### 策略比较及不能批准的缺口

B优于A的UX：保留最低票面1,510,000，退款风险阶段每笔至少累计到gross floor；若候选0.5 KAS，最低票价购买至少34张，总51,340,000。A若以相同候选金额提高最低票价，连已经跨过min的购买也被限制，非必要。C暂不研究，K16已在合理候选点通过。

**不写入新生产常量的原因**：目前只测equal-gross/min-deposit族，尚未完成 arbitrary higher deposits / 非均匀gross的安全区域论证和边界反例；input subtraction随金额变化，不能假设所有gross恰好floor必然是全域最坏。EMPTY sponsor/change金额也影响storage，尚缺真实production boundary EMPTY验证。CREATE/BUY链上约束、checked arithmetic以及A–F边界测试未实施。因此候选并非production-safe admission，仍为BLOCKED。

## 实际回归

`storage_mass_admission_test` PASS（研究搜索与候选refund committed VM，不是admission PASS）；`v1_production_covenants_test` PASS；golden/reject PASS；examples 21/21、links 0错误、npm 27/27。

`v1_production_e2e_full_lifecycle_test` FAIL：旧 P17 K9 storage=1,041,647；本轮没有通过抬高旧fixture金额绕过它。

`cargo test` FAIL：基线将上游 transaction_validator 直接path引入，cfg(test)连带编译上游内部单测，缺少 crate::params/processes、kaspa_core、itertools、smallvec 等。此为真实回归阻断，不以cargo run成功替代。rustfmt未安装，未安装/升级工具链。

最终：**STORAGE MASS ADMISSION BLOCKED**。最佳已测候选B：gross50,000,000、deposit20,000,000、K16；候选退款族最坏366,450。尚无MIN_REFUNDABLE_PURCHASE_GROSS_V1/MIN_STATE_DEPOSIT_V1生产约束。禁止TN10；下一步先完成本轮安全区域、终局、准入实现及边界验证，不先扩展完整BUY生命周期。
