# 1 KAS storage admission closure

基线 `14e1c0f8356b325662da10af56d35ae89d529952`；pinned rusty-kaspa `cfafeb4c093fa37a303f1b9f19c58f986b870ce3`。用户已批准策略A：最低票价1KAS，停止conditional gross研究。沿用上一轮25问/14项/8项preflight，只收紧CREATE经济准入，不改变身份、授权、状态、拓扑、随机性、赢家或scheduler。

**STORAGE MASS ADMISSION PASS（本地资源准入层，不是全生命周期共识门禁）。**

## 生产约束

- `contracts/v1_constants.rs`：MIN_TICKET_PRICE_V1=100,000,000；MIN_STATE_DEPOSIT_V1=5,000,000（0.05 KAS）。K_MAX=16、MAX_REFUND_FEE=1,500,000不变，无新增refundable-gross规则。
- `contracts/genesis.rs::validate_directory_create_parameters`：价格、押金低于floor均拒绝；生产genesis builder/CREATE validator调用该函数，保留checked金额上界。历史兼容genesis不冒称现行directory准入。
- 测试断言price=floor-1拒绝、deposit=floor-1拒绝、两个floor通过。

## 押金选择

真实production MassCalculator在ticket_price=100M,count=1、P1/17/256、平衡relay费向量下搜索：退款族500k边界deposit=2,922,482；400k边界4,129,280。选择5,000,000是超过400k目标边界的简单金额，不沿用旧50M fixture。

## 安全区域解释（最终测量仍为真实MassCalculator）

每笔gross>=100M，fee_i<=1.5M，所以buyer净额>=98.5M。普通buyer/creator plurality=1，带covenant P2SH state plurality=2，目录大小不直接改变SPK plurality。

即使不计input subtraction，终局output harmonic上界为16*floor(1e12/98.5M)+floor(1e12/5M)=362,432，小于400k。较大gross或较大deposit只降低此保守上界，不依赖equal-gross是净storage全域最坏的假设。

非终局scheduler至少剩1笔gross>=100M，successor贡献最多floor(4e12/(100M+5M))=38,095；16个buyer加successor harmonic<=200,527。因此非均匀gross、更大deposit也不会突破400k。此解析界只解释区域；下面所有实测净值由pinned calc_contextual_masses返回。

正常成功gross最小可达值为3张*1KAS=300M（2张不足250M准入门槛），fee=50M时winner=150M、reward=100M、deposit=5M；普通输出harmonic<=216,666。空轮fee sponsor不是任意找零都安全：本测试普通100M输入/90M找零，builder须保持足够找零并检查实际mass，不能承诺任意dust sponsor/change都可用。

## 实际结果

`storage_mass_admission_test`直接构造production refund脚本，所有P1/P17/P256批次均实际使用ComputeBudget(40)的allowed_script_units执行VM，断言fee>=真实relay floor、storage<=400k、compute/transient<=容量；未串联完整BUY历史。终局EMPTY与PAID实际production脚本执行；EMPTY普通输入为真实内存Schnorr签名并验证所有输入。

|路径|storage|500k余量|
|---|---:|---:|
|P1 terminal|172,038|327,962|
|P17 K9 nonterminal|92,775|407,225|
|P17 K8 terminal|275,184|224,816|
|P256 worst（K16 terminal）|357,828|142,172|
|PAID minimum economic boundary|203,552|296,448|
|EMPTY terminal|125,398|374,602|

P256终局relay=3,340,000、均分fee=208,750；所有fee低于上限。EMPTY fee=10M>=relay2,328,800，creator收回exact5M；PAID 1input/3output，fee50M>=relay302,400，creator exact5M，所有输出covenant=None。押金没有承担费用。

最小实测余量142,172；更保守全域退款harmonic上界362,432，余量137,568。

## 回归与限度

结果保留于 `artifacts/storage-1kas/`。storage检查PASS；production core PASS；golden PASS；reject PASS；examples21/21；links0错误；npm27/27。

旧完整E2E退出101：其CREATE票价3M不再满足1KAS准入。这是下一轮要更新的旧经济fixture，不以抬高它替代本轮production boundary测试。此前cargo test的直接引入上游内部cfg(test)编译问题尚未关闭；本轮不声称完整回归或全交易共识门禁PASS。未广播、未启动节点、未合并main。

历史storage报告与BLOCKED证据保留；其gross候选已被用户1KAS产品规则取代。NEXT：下一轮完成最终consensus-valid connected E2E、全回归与GitHub最终审查，之后才另行允许TN10。
