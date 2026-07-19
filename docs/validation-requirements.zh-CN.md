# Kaswin 抽奖系统验证要求与方法

本文是 Kaswin 的统一验收入口，用于回答三个问题：改动后必须验证什么、怎样验证、什么证据才算通过。

适用对象是当前工作树中的 vNext 协议以及后续版本。历史轮次必须按其 `contractVersion` 使用对应 release 验证，不能用新页面能读取旧 metadata 代替合约兼容性证明。

当前 `raffle-vnext-liveness-guard-b1000` 的 `max_batches` 默认值为 100、链上硬上限为 1000。合约、artifact、metadata、交易构造和页面必须统一接受 1000、拒绝 1001。创建页面按 `max(1, min(1000, floor(售票秒数 / 6)))` 实时给出保守建议；超过建议值可以创建，但必须提示单 Round UTXO 串行处理导致的 stale 冲突和后续结算次数风险。

## 1. 结论分级

验证结论必须使用以下三个等级，不能混用：

1. **本地通过**：编译、静态检查、VM 正反例、交易构造、质量测量和单文件构建通过。它不证明节点会接收交易。
2. **Testnet 通过**：真实 Testnet 10 节点、真实钱包和浏览器完成链上 Create、Buy、Draw & Pay 或 Refund，且交易已被接受、输出正确。
3. **可发布**：本地门禁、完整 Testnet 场景、Mainnet 小额冒烟、钱包与浏览器矩阵、静态 HTTPS、可复现构建和独立安全审计全部通过。

页面出现“成功”、钱包余额变化、RPC 返回交易 ID 或本地状态更新，都不能单独作为链上成功结论。状态改变必须由已接受交易和最新 covenant UTXO 共同证明。

## 2. 每次改动后的最低回归要求

凡是改动合约、artifact、状态编码、交易构造、质量/手续费、随机性、历史恢复、Indexer、钱包适配器或操作按钮状态，必须至少跑 **3 个全新轮次**。旧轮次只能用于兼容性回归，不能代替新协议回归。

最低三轮为：

| 轮次 | 场景 | 必须覆盖 |
| --- | --- | --- |
| A | 售罄开奖 | Creator 创建；Buyer A/B/C 以不同数量购票；刷新页面；通过历史记录 Load；公开触发 Draw & Pay；验证中奖和派奖输出 |
| B | 达到最低票数但未售罄 | `minTickets < soldTickets < maxTickets`；等待销售截止；Draw & Pay 成功；Refund 被拒绝 |
| C | 未达到最低票数 | 多个购买批次；超时前 Refund 被拒绝；超时后启动退款；中断页面；由另一个浏览器配置或用户 Load 后续跑；全部买家退款并返回剩余 carrier |

三轮之外还必须覆盖：

- 空轮次到期后没有购票款可退，页面不得把普通退款作为可用操作；任何人都可触发 `closeEmpty`，链上唯一输出必须固定为 `carrier - 实际关闭网络费` 并支付给 Creator，触发者不能改变收款人或取得 carrier。
- 两个买家基于同一旧 covenant UTXO 构造购买，只有一个成功；失败方必须在 15 秒状态查询窗口后得到“轮次可能已推进、请加载最新状态”的明确提示，不能打开钱包签名请求、不能改变链上状态，也不能把已花费旧状态长期误报为“等待索引”；重新购买前必须刷新、重新核对并重新签名。
- 停用或切换 Indexer、History API、Resolver/RPC 后，页面不能改变链上结果，服务恢复后可以继续。
- 修改随机性或区块查询逻辑时，至少验证一个“售罄立即开奖”和一个“超时后开奖”轮次。
- 修改退款逻辑时，至少验证一次中途关闭/刷新、另一个用户 Load 后从链上 cursor 续跑。

## 3. 验证环境和角色

### 3.1 钱包角色

真实网络验收使用隔离钱包：

- Creator：创建轮次并接收空轮次剩余 carrier；空轮次关闭不要求 Creator 在线或签名。
- Buyer A、Buyer B、Buyer C：独立地址，使用不同票数和购买批次。
- Outsider/Trigger：未购票地址，用于验证公开触发开奖和退款。
- Mainnet Smoke：只存放小额主网资金，不与 Testnet 或日常钱包复用。

Testnet 与 Mainnet 严格分离。真实验收通过 KasWare、Kastle 或注册的钱包 Adapter 签名；导入私钥只允许在明确标记的本地开发构建和一次性测试钱包中使用，不能作为发布流程。

### 3.2 节点和服务

- 网络仅允许 `mainnet` 或 `testnet-10`，不再使用 Testnet 12。
- 默认连接 Kaspa Resolver；自定义节点必须填写完整的 `ws://` 或 `wss://` wRPC 地址，不能只填 `127.0.0.1`。
- 连接后验证网络、同步状态、当前 DAA 和 Toccata 激活条件。
- Indexer 只提供公开历史、批次和 proof 数据，不能决定中奖者或改变 covenant 状态。
- 当本地购票历史不完整或大轮次需要 proof 时，页面必须明确要求配置可用 Indexer，并在资金操作前完成健康检查。

### 3.3 每次运行前记录

记录以下信息，便于复现：

- Git commit 和工作树是否干净。
- App 版本、协议版本、Round/Refund 合约名。
- Round/Refund artifact SHA-256、单文件 HTML SHA-256。
- 网络、Resolver/RPC、History API、Indexer 地址。
- 浏览器、钱包 Adapter、各角色地址。
- Round ID、创建 DAA、销售截止 DAA、随机边界 DAA。

严禁在日志、截图、metadata、HTML、release 或仓库中记录私钥、助记词、钱包解锁密码或生产凭据。

## 4. 本地自动验证

在项目根目录执行：

```powershell
npm run compile:vnext
npm run verify
npm run benchmark:indexer:1m
npm run validation:local
```

最低通过条件：

- Silverscript 从源文件重新编译，artifact 中合约名、ABI、状态布局、脚本长度和哈希一致。
- Round 内嵌的 Refund template 必须等于本次重新编译 Refund artifact 的 `BLAKE2b-256(immutable prefix || suffix)`；`startRefund` 跨合约正例必须真实通过，不能只跑错误反例。
- 默认 VM 命令必须在 Windows/Linux 都实际执行 Round、Transition、Refund、Close 全套；任何子套件失败、崩溃、超时或输出 `some tests failed` 时顶层命令必须非零退出，不能打印总 PASS。
- `protocol-manifest.json`、页面版本、metadata、artifact 和兼容性文档指向同一协议。
- Buy、Finalize、Refund、Top-up、Close Empty 的 VM 正例和篡改反例符合状态机。
- nonce 域、Merkle root/proof、票号范围和中奖抽样可重复验证；有限次 rejection 后必须有确定性兜底，不能因极小概率随机值让达到最低票数的轮次永久无法开奖。
- 达到最低票数后，轮次的 DAA 已参与开奖边界，后续 `topUp` 不得再移动它；合约必须拒绝“已达最低票数”和“已售罄”两种补充，VM 要覆盖反例。允许的早期补充不得改变 ticket root、计数、deadline 或任何票权，而且必须在接受补充资金前重算 root/frontier 并拒绝畸形输入状态。
- Kaspa 共识没有“当前 DAA 小于截止”的 upper timelock。应用必须在打开钱包签名请求前按节点当前 DAA 拒绝到期 Buy/Top-up；合约必须用输入 UTXO DAA 把恶意/在途截止竞争限制为最多一个 successor。若该 successor 在截止时或之后确认，开奖随机基准必须改为该 successor DAA（否则攻击者可针对已知截止区块选择性购票）。不得把销售截止描述为不存在链上竞争窗口的绝对上限。
- 交易在签名前完成 output、compute budget、storage mass、transient mass 和手续费计算。每个合约正例都必须记录 debugger 的实际 `SCRIPT_UNITS`，并按当前节点规则验证 `used <= computeBudget × 10,000 + 9,999`；交易构造器、mass fixture 和执行测试必须读取同一组预算常量。
- 所有手工构造的 Toccata/version 1 输入必须把旧版 `sig_op_count` 置零，并只使用 `compute_budget` 承诺脚本预算；Create、Registry、Buy、Top-up 和任何 sponsor 钱包输入都要有源码门禁。当前 P2PK `CHECKSIG` 实测/节点要求为 100,000 script units，因此钱包输入必须提交至少 10 个 compute-budget units（允许 109,999 units，含每输入 9,999 免费额度），不能误用零预算。真实 Testnet 若返回 `sig_op_count is inconsistent with transaction version 1` 或 `compute budget 不足`，本轮立即判失败；直接交易须证明没有候选交易被接受，仍使用两步流程的 Top-up/兼容路径还须证明临时资金仍由原钱包控制。
- 奖池本金必须由链上 `ticket_price × (sold_tickets - refund_cursor)` 推导，不能信任 Registry/History/Indexer/URL 提供的 `potAmount`。构造交易前，加载 cursor 的金额必须与节点返回的同一 outpoint UTXO 金额精确一致。
- 过小 covenant、临时资金或 change output 不会被提交；微小找零按规则折入手续费。
- Create 与 Registry 各使用一笔钱包直接签名交易，Buy 把票款输入和 covenant successor 合并为一笔交易；这三条路径不得预先广播 funding 交易。仍采用两步流程的 Top-up/兼容路径，其临时资金必须锁定到发起钱包，第二步只允许该钱包输入签名；不得使用 `OP_TRUE`、共享密钥或任何第三方可抢花的临时输出。
- 手续费按节点要求的质量费率收敛，节点返回更高最低费时能够安全重建，不能依赖固定 `0.05 KAS` 等常量保证未来可用。
- 当前“购票款承担退款费用”协议必须证明最小合法单票购买满足 `ticketPrice - refundTransitionFeeCap - refundFeeCap >= relaySafeOwnerOutput`，并用真实 compiled script 验证该 owner 输出、Creator 输出和完整退款交易仍低于标准 mass；仅证明结果大于 0 不算通过。公开触发者可选择链上声明费，因此 refund fee cap 必须不高于当前实测最坏 relay fee 的合理倍数，并有 `cap + 1 sompi` 拒绝反例，不能用过大的“未来余量”允许无成本烧毁买家退款。
- Genesis covenant 可以由第三方直接构造，不能信任官方创建页面已经预留 carrier。每次 Buy 必须由 Round 合约和网页交易构造器共同证明 `covenantAmount - ticketPrice × soldTickets >= 57,300,000 sompi`；精确边界应通过，少 1 sompi 必须在钱包请求前拒绝。页面必须禁用购票并引导在截止且未达到最低票数前补充 carrier，防止达到最低票数后因补充被冻结而永久无法开奖。
- Buy 还必须在链上和网页侧验证输入状态拓扑：`soldTickets/soldBatches` 非负，零值成对出现，`soldBatches <= soldTickets`，并由当前 `frontier + soldBatches` 重算的 padded Merkle root 精确等于 `ticketRoot`。网页还须用 `roundNonce + owner pubkeys + batch ends` 重建完整 root，拒绝缺失、重叠、断裂或总数不等于 `soldTickets` 的历史。必须有一个交易形状除“输入 root 与 frontier 不一致”外全部正确的 VM 反例，防止测试因缺少输出或金额错误而假通过；网页须在钱包签名前拒绝同一状态。
- Finalize、Start Refund、Refund Next 和 Close Empty 必须只消费一个 covenant 输入；不得通过额外 sponsor 输入隐藏价值损失或改变结算形状。VM 必须分别覆盖至少 Finalize、Start Refund 和 Refund Next 的额外输入拒绝。
- 必须由 Round 合约、Refund 合约、metadata 解析器和创建交易构造器共同限制 `ticketPrice * maxTickets <= 4611686018427387904 sompi`；验证需覆盖边界值与超限拒绝，防止 64 位脚本整数乘法溢出造成永久不可结算状态。
- 创建、Registry 的起始手续费，以及购票和补充 carrier 的动态手续费上限，必须分别使用真实 P2PK 钱包签名、compiled covenant、covenant binding/Genesis binding 以及各自允许的最大 payload 测量完整交易 mass；签名前须收敛到静态与 transient mass 的较高值，动态路径须保持在硬上限内。payload 超出已测量上限必须在钱包签名前拒绝。
- Buy 含 covenant 与一个或多个 P2PK 钱包输入，必须把全部 signature script 计入 normalized transient mass。页面可显示起始估算，但签名前必须选择足够的直接钱包 UTXO，并在最大手续费之外保留当前 storage-mass 安全的 2 KAS 钱包找零；不得把仅适用于退款 owner output 的 0.05 KAS relay floor 当成大额 successor 旁的安全找零。费用必须在唯一一次钱包请求前完成收敛；签名后若节点报告更高最低费，必须停止并要求用户重新审阅、主动重试，不能后台发起第二次签名。超过 `MAX_COVENANT_BUY_FEE_SOMPI` 必须停止，不能由异常节点无限抬费。
- 同时包含 bound covenant successor 和普通钱包找零的交易必须在钱包签名、签名结果反序列化、`finalize()` 与 RPC 提交四个阶段统一省略“无绑定输出”的空 `covenant` 字段，同时完整保留 successor 的 `authorizingInput/covenantId`。必须有合成 mixed-output 门禁，且 Testnet Buy/Top-up 至少各通过一次真实广播；不得通过删除找零输出规避 WASM 转换错误。
- 浏览器 WASM 的 mass/fee helper 若不能转换大型 mixed bound wrapper，Buy 和 Top-up 必须用金额、脚本、输入、payload 完全相同但暂不绑定输出的 twin 测量 storage/static mass，并在签名之前按同一手续费重建带精确 `covenantId` 的最终交易；无绑定 twin 绝不允许进入钱包签名或 RPC。
- Top-up 必须计入 covenant 与 P2PK 两份 signature script、预留有上限的手续费重试额度和额外 2 KAS 安全钱包找零；节点提高最低费时只能重建同一钱包锁定 staging 的最终交易。任何失败都须报告所处阶段和 temporary-funding 是否仍未花费，不能用固定手续费或小额无找零形状掩盖真实网络质量费。
- mixed-output 的规范化、反序列化、签名、finalize 和 RPC shape 构造必须分别报告失败阶段；页面不得只显示无法定位的 WASM `covenant` 转换错误，否则恢复人员无法判断签名、提交与链上状态边界。
- Buy 在 successor 构造、手续费收敛、唯一一次钱包签名和 RPC 提交中的任意失败都必须显示明确阶段，并说明未广播前置 funding 交易；RPC 返回不确定时须显示本地候选 txid 或要求刷新 cursor/UTXO，不能暗示可以无审阅地重复提交。
- 交易构造前必须同时验证 metadata 声明的协议版本、轮次状态、redeem script 非状态模板和全部状态字段；禁止“旧 artifact + 当前协议名”或“Round artifact + Refunding 状态”通过任意 artifact 自动识别路径。
- 两步钱包交易（当前 Top-up/兼容路径）第二步提交报错时，页面必须重新查询 temporary funding outpoint：仍未花费才可声称资金由钱包回收；若已花费则必须提示“提交状态不确定、先刷新历史/UTXO 再重试”，不得误导用户重复提交。
- Genesis covenant 一旦提交成功，必须在 Registry marker、marker 退款、等待索引或余额刷新之前立即缓存 Round ID、create txid、covenant id/address 和完整 cursor。RPC 响应丢失时必须保留本地确定性 transaction id，并按该 id 查询 covenant 输出；查询到精确输出应恢复为成功，未查询到则显示 candidate txid 并说明没有前置 funding 交易，不能让次要步骤失败抹掉资金入口。
- 百万票范围、购买批次数上限、退款动态缩批和 Indexer proof/reorg 测试通过。
- `dist/index.html` 是自包含单文件，不依赖启动时的外部脚本、WASM、字体或样式资源。
- 两次稳定构建的 HTML SHA-256 相同；源码指纹变化或脏工作树必须记录为发布阻断项。

`npm run validation:local` 不连接钱包、不广播交易。它生成的 `testnetPassed: false` 和 `mainnetSmokePassed: false` 是正确结果，不能手工改为通过。

## 5. Chrome 真实网络验证循环

### 5.1 构建和打开

```powershell
npm run build
npm run preview -- --host 127.0.0.1 --port 4180
```

使用 Chrome 打开 `http://127.0.0.1:4180/`。每次重新构建后刷新页面；若版本未更新，清除该站点缓存并注销 Service Worker。页面标题区显示的版本、协议清单和 artifact 必须与本次记录一致。

### 5.2 Create

1. 连接正确网络、节点和 Creator 钱包。
2. 设置票价、最大票数、最低成团票数、最大购买批次、超时时间、carrier 和 Registry；前四个数字字段必须在创建主面板中紧凑对齐，最低开奖票数不能藏在高级设置。
   当前协议票价不得低于 manifest 的 `minimumTicketPriceSompi`；页面要用 KAS 解释该门槛是单购买批次退款活性条件，而不是平台收费。
3. 在页面固定费用说明和签名前预览中核对以 KAS 显示的金额、手续费及 Registry 净费用；按钮悬停不得重复弹出同一费用提示，用户界面不得显示 sompi。
4. 在钱包签名前核对所有输入、输出、change、网络费和 covenant 地址。
5. 广播后记录交易 ID，并通过节点/History API 确认 `accepted=true`、covenant 输出金额和状态字段。
6. Create 与 Registry 各预期 1 次钱包请求（合计 2 次）；确认直接交易找零回到钱包，且没有前置 funding 交易，不能只看页面估算余额。

### 5.3 Buy

1. 分别用 Buyer A/B/C Load 同一轮次并购买不同数量。
2. 验证实际支出由 `票价 × 数量 + 单笔交易网络费` 构成，票款与 successor 必须在同一笔交易中，整个 Buy 只出现 1 次钱包请求。
3. 每次购票后确认 successor covenant 的 `soldTickets`、`soldBatches`、pot、ticket root/frontier 和 cursor。
4. 批量边界至少覆盖 1、10、100；涉及百万票或批次算法时再覆盖 1,000、10,000、100,000 和协议最大值。
5. 验证超出剩余票数、超过 `maxBatches`、超时后的购买和 stale UTXO 均被拒绝且不改变链上状态。

### 5.4 Load 和历史恢复

至少一轮必须走完整恢复路径：

1. 购票后刷新或关闭页面。
2. 从浏览器本地“参加过的抽奖”缓存加载；清空当前内存状态后仍能找回 Round ID。
3. 从历史下拉列表选中轮次，核对状态、票数、买家、中奖者和 payout/refund 交易。
4. 使用另一个浏览器配置或地址 Load，同链上 covenant UTXO 恢复当前 cursor。
5. 本地缓存缺失时，显式配置 Registry/Indexer；服务不可用时显示可操作的配置提示，不能把轮次错误标成 Open。
6. 加载不兼容旧轮次时显示其合约版本和兼容 release 下载指引；未知版本只读展示。
7. History/Indexer 返回的票批次或 covenant cursor 少于本地已观察状态时，合并必须保持票数、批次数、`soldTickets`、`refundCursor` 和 `refundBatchCursor` 单调不回退；只有包含现有连续批次作为相同前缀的更完整历史才能扩展本地缓存。
8. vNext 的可读 `roundId/roundNonce` 在 covenant、购票树、赢家证明、退款证明和 History 重放中必须统一通过 `roundIdToBytes32` 规范化；Registry 至少记录 `roundNonce`、`maxBatches` 和 `salesDeadlineDaa`，纯网络恢复不得把 `round-...` 文本直接当作十六进制数据。
9. Mainnet 与 Testnet 默认 Registry 都必须使用各自网络的 Kaswin 专属、带域标签且可自动结算的脚本地址，不能复用全网通用 `OP_TRUE` 地址。两网默认规则均为临时发送 0.20 KAS、公开返回 0.19 KAS，最终不退回的 Registry 净费用为 0.01 KAS；钱包网络费另计。不得直接创建 0.01 KAS Registry UTXO，因为该形状超过当前标准 storage mass。旧 Registry marker 仅保留显式兼容退款路径，任意自定义地址不得套用自动退款 witness。
10. 页面默认入口和首屏行动顺序必须面向参与者：“Kaswin 玩法”紧接网络风险提示显示，然后才是网络/钱包配置；无论是否已加载轮次，“当前抽奖”和购票/开奖结算区域都必须常驻显示，未选择时展示清晰空状态。“可参与抽奖”和“创建抽奖”合并为默认收起的次级轮次管理区，入口放在“当前抽奖”右上角，展开内容插入当前抽奖与购票/开奖区域之间，只在用户主动展开时占用空间；其激活状态使用一致的 Kaspa 绿色并与对应内容面板连成整体。创建、购票、补充 carrier、开奖、退款和关闭空轮次的错误、进度、成功或警告反馈必须紧跟各自触发按钮显示，不能统一堆在操作区底部或隔着其他区域显示。退款作为资金安全出口，仅在已售票、未达最低票数且超时可用时展开；零售票超时必须自动切到结算页并只展示“关闭空轮次”。
11. 页面费用必须区分起始估算、节点收敛后的实际费、每笔硬上限、钱包网络费和 Registry 净费用；Create、Buy、Top-up、Draw、Refund 的成功结果应显示本次可观测的精确链上费用。History 已观察到 `Refunded`、`Finalized` 或 payout/refund txid 时，终态必须覆盖旧浏览器中的 Open cursor，奖池归零或显示已派奖结果，并在渲染阶段关闭所有不可能的花费动作。

### 5.5 Draw & Pay

当前 vNext 的正常结算是公开触发：创建者不需要再次介入，触发者也不应成为资金托管方。历史协议若要求参与者授权，必须用对应 release 验证，不能套用 vNext 预期。

通过条件：

- 售罄后可立即开奖；未售罄但达到最低票数时，只能在销售截止后开奖。
- 随机性来自固定 DAA 边界的 Kaspa selected-chain header、parent 和 `seqcommit`，不依赖 Oracle、服务器密钥或页面生成的秘密。
- RPC/History/Indexer 返回的数据只作候选提示；页面重新哈希，covenant 再验证边界、selected parent、ticket root、winner proof 和输出。
- 遇到 reorg、`block ... not selected`、header lookup timeout 或旧 witness 时，不广播旧交易，重新查询并重建。
- 节点接受 Finalize 交易，原 covenant UTXO 被花费，不再存在可重复结算的 successor。
- 中奖票号与记录的随机种子一致，奖池直接输出到该票 owner 地址。
- 实际 payout 金额、网络费、carrier 返回和所有输出与 covenant 规则一致。
- 页面历史显示 `Paid/已派奖`、中奖者和 payout txid；仅显示 winner 但没有 payout txid 不算成功。

### 5.6 Refund 和续跑

通过条件：

- 超时前所有地址都不能退款。
- 达到 `minTickets` 的轮次不能退款，只能 Draw & Pay。
- 未达到 `minTickets` 且超时后，任何人都可以启动和继续退款。
- 退款按链上 purchase-batch cursor 续跑；单笔批次由实际 compute/storage/transient mass 动态缩小，不能把 ABI 上限当作 relay 保证。
- 故意在中途关闭页面或断开节点后，另一个用户 Load 轮次可以从最新 cursor 继续，不能从头重复退款。
- 每个购买批次只退款一次；错误 nonce、proof、owner、数量、cursor、输出或 successor 状态必须被 covenant 拒绝。
- 所有买家应收到协议规定的本金减实际分摊网络费；首次选中批次还承担已记录的退款转换费债务。
- 至少用一个单票购买批次同时代入 transition fee cap 和 refund fee cap，证明买家输出仍达到 relay-safe 质量下限；低于门槛的 genesis/state 必须被 Buy 和 Refund covenant 拒绝。
- 最后一笔不创建多余 successor，剩余 carrier 按协议返回 Creator。
- 零售票轮次超时后必须允许任何人公开触发 Close Empty，且唯一输出只能是合约状态中 Creator 公钥对应的 P2PK；不得依赖 Creator 钱包仍在线。
- 任一失败交易不得推进 cursor；页面恢复后以链上 UTXO 为准。
- 本地终态校验必须按 `soldTickets - refundCursor` 计算剩余奖池：`Refunding` 状态逐批递减，`Refunded` 必须满足 `refundCursor == soldTickets` 且剩余奖池为 0；不能把正确的零奖池终态误报为 `soldTickets × ticketPrice` 不一致。
- 空轮公开关闭后的 `Closed` 必须作为零票、零奖池的合法终态通过本地校验，页面不得继续提示“应允许退款”，状态文案应明确为“已关闭”。

## 6. 费用、质量和储存下限专项验证

每种资金操作都要分别记录估算值和节点接受值：Create、Buy、Carrier Top-up、Draw & Pay、Start Refund、Refund Next、Close Empty。

必须验证：

- 输出金额满足当前 Toccata storage-mass 下限。
- compute budget 来自实际脚本路径测量，并留有协议允许的边界；不能固定为默认 `9999`。
- 手续费基于交易版本、序列化字节、sig-op、compute mass、storage mass、normalized transient mass 和节点最低 relay fee 计算。
- 当节点返回明确 required fee 时，应用只在交易状态未改变的前提下重新构造；需要钱包签名的操作必须再次展示并重新签名。
- 小 change 不生成高 storage-mass UTXO；直接 Create/Registry/Buy 不留下 temporary funding，仍使用两步流程的临时资金在操作完成或失败恢复后必须可在链上追踪。
- 页面所有用户可见数值统一换算为 KAS；机器证据可同时保留 sompi 原始值。
- Testnet/Mainnet 证据只有在记录的 protocol version、Round/Refund artifact SHA-256 与本次 manifest 完全一致时才有效；旧字节码交易不能替代当前协议验收。

## 7. 大规模与 Indexer 验证

协议最大票数为 1,000,000 时，验证重点不是在浏览器逐张循环，而是 range purchase、购买批次上限、Merkle proof、Indexer 查询和退款 cursor 的复杂度。

最低要求：

- 1、10、100、1,000、10,000、100,000 和 1,000,000 票边界的整数、金额和票号范围无溢出。
- 不同数量分布产生相同总票数时，root、range owner 和 winner lookup 可验证。
- Indexer 的百万票基准完成，并记录耗时、内存、数据库大小、proof 延迟和重启恢复。
- Indexer 返回错误 proof、旧 checkpoint 或发生 reorg 时，客户端拒绝使用并重建。
- 退款以购买批次为单位，不以一百万个单独用户对象全部装入一笔交易；每笔按质量上限动态选择可处理前缀。

离线百万票基准只证明算法和服务形状，不证明公共节点会接收真实大交易。至少保留一个 Testnet 大批次轮次作为外部证据。

## 8. 钱包、浏览器和发布验证

发布前至少完成：

- Chrome 与 Edge；桌面和 390×844 移动视口。
- KasWare 与 Kastle；连接、拒签、锁定、切换账户、切换网络、刷新后恢复。
- 钱包选择通过 Adapter Registry；新增钱包只注册 Adapter，不修改核心状态机。
- 所有消耗 KAS 的操作都在其主区域持续显示 `业务金额 + 预计网络费`，签名前显示完整不可变预览；按钮悬停/聚焦不再重复弹出同一费用说明。
- 首屏必须用与页面语言一致的简短内容说明三步玩法（购票、等待售罄/截止、达标开奖或未达标退款），并明确展示“奖池不能改收款人、任何人可续跑结算、Kaspa selected-chain 随机性、地址/交易可查”；不得用无关号码球暗示传统中心化彩票开奖。
- 弹窗、历史加载/恢复结果、链上操作结果和错误提示必须跟随当前页面语言；不得在中文页面持续显示英文状态句，或在英文页面显示中文状态句。
- 按钮忙碌时防止重复提交；失败后恢复可操作状态；Finalize 后 Create 重新可用。
- 静态 HTTPS 和子路径部署；页面启动时不请求外部可执行资源。
- Release 附带构建好的 `index.html`、SHA-256、协议与合约兼容说明。每个 release 明确列出可操作的合约版本；极老轮次指向对应历史 release。

Mainnet 冒烟只使用隔离小额钱包，至少完成一个售罄派奖轮次和一个未成团退款轮次。任何主网失败先保存交易形状、节点原始错误和 UTXO 状态，不用不断点击重试。

## 9. 失败处理规则

遇到错误时按以下顺序处理：

1. 保存 Round ID、动作、网络、节点、当前 DAA、covenant UTXO、交易 ID（如有）和完整 RPC 错误。
2. 查询交易是否 accepted，以及输入 UTXO 是否仍未花费。
3. 对直接 Create/Registry/Buy 查询本地候选 txid、钱包输入和目标输出；对 Top-up/兼容两步交易再查询 temporary funding/refund 交易，确认资金当前归属。
4. 判断错误属于 storage mass、compute budget、relay fee、签名脚本、stale UTXO、selected-chain/reorg、历史数据或 Indexer proof。
5. RPC 返回通用 `Rejected transaction` 时，页面必须保留节点原始原因和本地计算交易 ID，并区分父交易未传播、输入已花费/并发冲突、手续费下限、selected-chain/reorg 与未知策略拒绝。输入已失效时只能进行只读历史刷新；任何替代交易都必须重新展示预览并由用户重新签名，禁止静默重签。
6. 对任何拒绝或提交结果不确定状态，先按本地计算交易 ID 查询历史或浏览器，再允许重试；不得因盲目重试造成重复签名、重复支付或把已成功交易误报为失败。
5. 修改后重新编译，先跑本地门禁，再创建至少三轮新轮次做浏览器回归，其中必须包含 Load 和退款续跑。

以下情况不得宣称成功：

- 只有本地脚本或模拟器通过。
- 只有钱包签名或提交返回，没有节点 accepted 证据。
- 开奖页面计算出中奖者，但没有 payout 交易。
- 退款页面 cursor 前进，但链上 successor 未确认。
- 使用了错误协议版本、旧缓存页面或不兼容 release。
- 临时 funding 去向不明。

## 10. 每轮证据记录模板

```markdown
### Round <round-id>

- 日期/浏览器：
- App / protocol / artifact hash：
- 网络 / RPC / History / Indexer：
- Creator / Buyers / Trigger 地址：
- 参数：ticket price、min/max tickets、max batches、timeout、carrier
- Create：txid、accepted、mass、fee、covenant value
- Buy：每批 buyer、ticket range、txid、accepted、fee
- Load：缓存/历史/另一浏览器恢复结果
- Draw：boundary DAA、target/parent hash、winner、payout txid、accepted、outputs、fee
- Refund：开始 txid、每次 cursor、owner outputs、最终 carrier、accepted、fee
- 失败与恢复：原始错误、失败交易是否改变状态、修复后 txid
- 结论：Local / Testnet / Mainnet；通过项和未通过项
```

## 11. 相关文档

- [开发验证循环](development-verification-loop.md)
- [验证证据矩阵](audit-evidence-matrix.md)
- [Testnet 验证记录](testnet-validation-log.md)
- [合约兼容性](contract-compatibility.md)
- [中文技术指南](technical-guide.zh-CN.md)
- [本地验证证据包](../validation/README.md)

任何标为 `Pending external`、`Not yet evidenced`、Critical 或 High 的项目，都阻止“完整、生产可用、已全面验证”的结论。
