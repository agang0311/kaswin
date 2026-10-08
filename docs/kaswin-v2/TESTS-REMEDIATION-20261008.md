# 2026-10-08 tests/ 修复：实施前决策与边界

状态：APPROVED FOR SOURCE；运行测试／VM／真实钱包与网络实验仍未获本轮授权。用户“修复一下”指前轮静态审查发现的问题，主助手单写入者，无委托。基线fb8a27d58c3ae31ed72eda4f0c17b05f0c4456ab，tests及package/.gitignore为已有未提交用户输入，修复后纳入独立提交，不覆盖无关文件。

固定Profile7aaf76fe…／SilverScript3ed973…／rusty cfafeb4…／SDK2.0.1不升级；不改合约、核心、发布HTML或budget pin。已读核心架构规范及既有CONTRACT-HARDENING-20261007.md，审查依据 `/root/kaspa/docs/kaswin/v2-tests-review-2026-10-08.zh.md`。这是链外测试工具修复，不是新合约设计或预算批准。

## 实施决策

- dry改为纯公开fixture离线模型，零SDK／钱包／网络；保留虚拟UTXO消费与找零，明确SIMULATED，绝不产生accepted回执。verify与execute严格互斥，未知参数拒绝；verify只读取已存在journal并查询接受，不签名／重发／创建新轮次。
- execute独立延迟import，先检查本Profile真实预算评审，缺证据在密钥／网络前拒绝；额外要求显式实验授权文件（无密钥），固定network/profile/scenario/round/钱包公钥、到期和累计fee上限。该文件是操作清单而非密码学审批，不能替代操作者授权。Action9完全不提供绕过开关。
- 单机runner使用固定evidence根目录与exclusive运行锁（无TTL夺锁），持久不可覆盖intent，每次执行新round目录必须不存在；启动扫描所有round意图，未决即阻断任何execute。崩溃留下锁需操作方确认进程退出后人工恢复，verify不依赖写锁。此保护不跨设备／不同副本钱包工具，不虚构全局锁。
- 每笔签名后、广播前落盘签名交易／draft／输入／snapshot／预广播sink，fsync；UNKNOWN与SUBMITTING保留占用。每一步必须经selected-chain接受完整交易／输入对账＋解释后推进。接受块body不能作内容来源，mass缺失保留null。
- 复用commonUtxos、verifyInputsLive、acceptedAt、searchAccepted、matchesDraft、acquireDrawProof与费率API；UTXO原样保留，排除coinbase和covenant。所有签名await BIP340验证，签后txid及费用保持；预算与累计金额均bigint。
- VM分离显式--vm；新harness源码输出结构化ACCEPT/REJECT/ERROR，按原input预算执行且记录每输入units；只有指定Input0错误类别计预期拒绝，启动失败／panic／缺行是ERROR。需要外部已审核构建清单绑定binary/source/consensus/profile哈希，否则BLOCKED；本轮不编译或运行Rust。仅SCRIPT_VM，不声称全交易relative maturity、storage/relay或真实随机accessor验证。
- 安全测试复用既有针对购买txid/候选构建门的回归，坏intent只变异一个字段；补CLI、journal冲突、异步验签及VM响应解析最小回归源码，不执行。

## 25问（增量逐项，设计通过不等于运行通过）

|#|答案／依据／状态|
|---|---|
|1|每轮规范OPEN CID，测试runId不是链上identity；沿用。|
|2|core buildOpenGenesis创建；dry合成，execute需完整accepted核验。|
|3|唯一output0延续，PASS-A用实际accepted output0。|
|4|live UTXO链上状态；本地journal仅恢复上下文。|
|5|owner/config/Profile固定，不改任何SIL。|
|6|phase/目录/游标沿用；仅已核验后继推进。|
|7|协议五动作不变；TN10只empty/refund/payout三场景，Action9排除。|
|8|资金由既有测试钱包签名，延迟加载与显式公钥绑定；本轮不签。|
|9|原1→1/1→0含普通资金，dry使用独立虚拟UTXO集。|
|10|按core interpreter检查state/payment，不自行拼liveMock。|
|11|loadV2Bundle与完整SPK验证沿用。|
|12|保留CID与authorizingInput，资金CID不得改null。|
|13|snapshot先验与accepted后验联合，不信本地猜测。|
|14|fee守恒/上限、固定付款、UNKNOWN停止、intent不覆盖。|
|15|bigint金额；actualFee来自完整节点输入输出，mass未知为null。|
|16|同轮outpoint及钱包funding竞争；固定根单进程锁＋持久未决阻断。|
|17|本地锁不代表链上并发改善；256预算仍BLOCKED。|
|18|不新增链上全局状态；每轮日志隔离且跨round检查未决。|
|19|三终局沿用；未终局／UNKNOWN不报成功。|
|20|退出路径不变；中断verify只读恢复证据，不自动重发，进一步操作需单独评审。|
|21|不依赖Indexer，节点selected-chain接受集负责事实。|
|22|无Indexer可用保存材料＋节点核验；裁剪/reorg不可假通过。|
|23|三模板链接不变；禁止旧Profile材料混入。|
|24|仅同family阶段，资金foreign CID排除。|
|25|L1原模型不变；tests不是新Based层。|

## 14项材料

1. Inventory：原state/funding/payout；新增journal、锁、授权文件均链外。
2. Schema：Consensus账本不变；journal的draft/snapshot/signed/anchor为待核验记录；dry schema单独；VM结果标SCRIPT_VM。
3. Lineage：固定Profile→规范OPEN根；校验origin/CID，run/step标签不作身份。
4. 状态图：链上沿用；journal `INTENT→SUBMITTED→ACCEPTED` 或任何不确定→UNKNOWN；无UNKNOWN→重发。
5. 拓扑：Round A与B链上独立；同机工具运行锁保护钱包副作用，不是共识锁。
6. I/O：沿用三流程builder；真实snapshot取已接受输出0；虚拟输入消费不能复用。
7. Auth：模式解析先于副作用；预算证据＋实验清单＋钱包public key/权限；await验签。
8. Successor：完整节点交易与approved draft对账＋interpretAccepted；actual outputs不由draft伪装。
9. Invariants：金额守恒，fee≤50m且累计限额，journal不覆盖、未决不再花。
10. Exit：最终结果要求terminal正确；故障保留材料并停止，verify不广播；崩溃锁人工确认后恢复。
11. Indexer：无新职责；节点Full accepted rows/selected chain/reorg检查复用。
12. Contention：单机固定证据根锁，无TTL抢占；所有未决阻断跨roundexecute，未解决外部设备竞争。
13. L1/Based：不改变协议，预算与网络批准仍独立。
14. Anti-pattern：逐项如下。

## 8项反模式

1. 不新增global state；2. 不仅验签，验证所有后继与支付；3. CID与模板/SPK/value一起验；4. 本机draft/Indexer不裁决接受；5. 无EVM账户翻译；6. 链上竞争保持原边界；7. 明确终局与失败恢复、不自动重发；8. full template/lineage/binding不退化。未解决的资源预算问题以execute门槛阻断，不凭脚本新增解除。

## 验证计划／尚未执行

本轮仅node --check、静态import/path与diff核对；若必要只做既有编译一致性检查。最小回归覆盖CLI互斥/零副作用、持久冲突与UNKNOWN、异步签名false、VM ERROR不计PASS、安全测试单字段变异。没有本轮单测／VM／链上通过数；新Rust harness可编译性和默认预算需后续另行授权确认。

## 源码交付结果（非运行验收）

- TN10入口拆分为`runner/cli/offline-plan/live/journal/signing.mjs`。默认dry不加载SDK或钱包、不连接网络、不写live意图；使用独立虚拟UTXO消费/找零。verify只核验已存意图并追加观察，不签名、不重发、不自动解除锁或继续原实验。
- execute先验证本Profile预算证据再加载授权范围文件；缺证据时拒绝。固定SDK指纹、钱包公钥／权限检查，资金输入不抹CID或coinbase；手续费全程bigint。签名await验证并确认签后txid。
- 独占运行锁、O_EXCL/O_NOFOLLOW写入与fsync，意图包含签名交易、原始输入和广播前锚。新round不复用目录，任何未完成run阻断后续execute；已接受历史输入也不会自动重复选择。UNKNOWN立即停止，不生成complete回执；崩溃恢复需人工确认，保护不跨设备/副本。
- 复用Full accepted row＋matchesDraft＋interpretAccepted，actual fee由真实输入输出差得到；computeMass缺失为null。PASS-A直接使用验收的output0。payout等待真正closeEligibleDaa而不是将最低票数当售罄。
- audit默认只跑local；VM需要`--vm --manifest`并固定binary/source/Profile等来源，独立证据目录，timeout/error/signal均失败。负例要求配对正例先通过、指定Input0/错误类别及结构化结果，不接受任意异常。新Rust源码保持原预算，明确仅SCRIPT_VM；**未编译、未生成已评审VM清单、未执行**。
- 客户端安全复用既有购买txid／候选gate回归，损坏inputs只变异一个字段；新增CLI互斥、journal冲突/不覆盖/未决重启、async验签false、VM错误分类以及真实候选plan/execute/wallet/submit入口回归源码，未运行。
- 静态检查：16个MJS仅node --check解析，顶层相对import路径核对；合约／核心／应用／release的144个已跟踪文件与基线逐字节一致，dist与release一致；git diff --check。原始回执 `/root/kaspa/references/kaswin-v2-tests-remediation-20261008/static-receipt.json`。本轮不运行examples/应用单测、链接工具、SDK、Rust编译、VM、网络，不访问真实钱包、签名或广播。
- 当前Profile仍7aaf76fe…，budgetProfileId=null；HTML仍只读候选，未改产物、未部署。测试工具修复不构成运行安全批准。旧runner证据不自动迁移，不允许删除未决资料绕过阻断。
