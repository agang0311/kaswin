# TN10 实验工具

2026-10-08更新：已有5场景377笔历史接受回执；本轮修复恢复边界，仅运行离线回归与网页只读验收，没有读取真实钱包或新广播。固定Profile `7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`。用户此前已取消实验CLI的VM预算前置，但每次execute仍须独立有效授权；正式VM发布门不随实验解除。见[实施记录](../../docs/kaswin-v2/TN10-RELEASE-20261008.md)。

## 模式严格隔离

```bash
# 纯公开fixture合成预演：无SDK、密钥、网络、accepted文件
node tests/tn10/runner.mjs --dry --scenario=empty
node tests/tn10/runner.mjs --dry --scenario=refund
node tests/tn10/runner.mjs --dry --scenario=payout

# 256次购票满额极限容量派奖全流程离线模拟：
node tests/tn10/payout-256.mjs --dry
# 或通过 npm 命令：
npm run test:payout256:dry

# 256次购票满额链上执行（需审批授权，支持分批 --batch=N）：
# node tests/tn10/payout-256.mjs --execute --round=<name> --approval=<path> [--batch=N]

# 仅在单独授权网络读取后：已有journal记录核验，绝不签名/重发
node tests/tn10/runner.mjs --verify --round=example --step=01-GENESIS
# 可选已知接受块，仅作为定位hint，仍由acceptedAt完整校验
# --accepting=<64hex>
```

无参数默认为dry。`--verify --execute`、`--submit`、未知/重复参数、路径穿越及`--allow-timeout-refund`一律拒绝。verify不创建新轮次，不访问钱包，不解除输入占用，不自动继续实验。

dry使用独立内存UTXO池，消费输入并加入找零；无实际接受时间或接受块，输出只标`SIMULATED_OFFLINE_ONLY`。payout预演到SEALED即停止，不伪造真实PASS-A。固定费率1只是合成输入，不是节点费率。

## Execute门槛（需指定实验授权）

只有操作者明确授权特定TN10实验、接受已记录的未验边界，并检查恢复流程后，才可考虑：

```bash
node tests/tn10/runner.mjs --execute --scenario=empty --round=unique-run-id --approval=/absolute/private/approval.json
```

入口会依次检查：

1. 固定Profile与TN10网络，不读取或改变正式发布budget pin。实验执行与公开上线批准分离。
2. 用户提供的0600、当前用户所有、非符号链接授权文件，schema `KASWIN_TN10_APPROVAL_1`：`networkGenesis`、`profileId`、`scenario`、`round`、`authorizationReference`、`expiresAt`、十进制`maxTotalFeeSompi`（基础runner最多300000000；容量runner最多交易数×50000000，每次恢复累计历史fee且不得扩大原审批额度）、`walletKeys:{creator,buyer1,buyer2}`。三个公钥必须不同，且与既有测试钱包相符。此文件仅记录授权范围，**不是密码学签名或能替代操作者许可的审批证据**。不提供伪造APPROVED示例。
3. 固定 `tests/tn10/evidence/` 根目录权限0700、进程用户所有；exclusive运行锁；所有历史run必须完整，无未决/UNKNOWN记录。旧版证据格式一律拒绝自动迁移，需先独立只读核验，不能删除证据“解锁”。
4. 固定SDK2.0.1的JS/WASM指纹后延迟加载。固定`/root/kaswin/wallets/`目录0700，三个既有测试钱包文件0600，owner/非符号链接/硬链接数检查；公钥必须匹配授权文件。绝不在日志输出私钥或SDK构造错误参数。
5. 普通、非coinbase、无CID的精确P2PK资金输入；链上输入上下文不改写；签名前后live检查；await BIP340验证和签后txid核对；每笔≤50000000 sompi且累计fee受授权文件限制。

SDK文件来源：原固定官方v2.0.1资产；本机离线指纹复核日2026-10-08，仅文件hash未加载SDK：`kaspa.js` SHA256 `1e0ad892861bf3e0a63ba8ed51366efc2b812c5a34c6895385ee2f9d026d2fc1`，`kaspa_bg.wasm` `9427733cb0cb1c78cc3f2cc9f77f4153426636925ced0256c5c30e4edc199eaa`。不支持自动安装或升级同名包。

## journal与恢复边界

每个run有不可覆盖的run.json；每笔广播前用exclusive create并fsync保存：

- `*-record.bin`：v8本机恢复格式，保留bigint/Uint8Array（仅可信本地私有文件）。
- `*-intent.json`：network/Profile、draft、signed交易、实际输入、snapshot、**广播前**sink锚、record hash；不含密钥。
- `*-SUBMITTED-*.json` / `*-UNKNOWN-*.json`：追加事件，不覆盖历史。
- `*-accepted.json`：经过V2 Full accepted row完整对账及解释，记录实际fee、computeMass（缺失为null）、storageMass、确认深度、实际输入/输出、观察时间。不是不可逆最终性。
- `complete.json`：仅全部步骤ACCEPTED且终局正确时生成。

任何失败／UNKNOWN立即停止，不构建下一步、不打印COMPLETED。进程崩溃留下锁不自动过期；操作者须先确认旧进程已退出，再独立核验。verify可在保留锁时只读核对并追加观察，**不会释放锁／未决占用，也不自动生成complete.json**。基础runner不能重新execute原round。容量runner可在原授权scope不扩大、所有intent均有匹配accepted、无孤立record、其他轮次完整时显式resume；历史输入继续保留占用，总fee跨进程累计，最新状态须重新经节点Full accepted解释。退款批次从已核验cursor继续。缺回执/UNKNOWN停止，不自动自愈或重发；verify仅追加观察，后续恢复需单独审查，不能修改证据骗过保护。

保护只覆盖同一受保护证据根、同一机器的本runner；不跨仓库副本、设备或其他钱包工具。正常接受也可能重组，后续仍需live检查。`TIMEOUT_REFUND`未提供链上场景或开关；如将来需要必须另行设计/授权。

场景：empty→EMPTY；refund购买2票等待封盘→REFUNDED；payout购买3票等待封盘和100 DAA→PAID。PASS-A材料裁剪/样本拒绝/运行中断仍可能阻止完成，不能把本工具当无条件资金退出保证。
