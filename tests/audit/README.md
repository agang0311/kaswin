# 有界审计回归与显式证据门

## 当前入口与前置条件

- `npm run test:audit`：公共本地回归，01–05、07–10、13共10套；不需要原始TN10回执，不执行VM。部分测试需要固定官方SDK2.0.1，安装位置/资产校验见[来源](../../docs/kaswin-v2/SOURCES.md)。
- `npm run test:receipts`：单独执行11，离线核验377笔历史原始回执；缺失/不符硬失败，不SKIP，不当成公共回归通过。见[证据访问](../../docs/kaswin-v2/EVIDENCE-ACCESS.md)。
- 13运行真实发布CLI的临时副本，防止源码漂移、缺文件、路径越界或CSP错误被发布；失败不覆盖已有dist。无需VM或网络。
- 06及12为显式VM工具；历史执行/评审状态见[VM记录](../../docs/kaswin-v2/VM-BUDGET-20261009.md)，不是默认套件的一部分。

本轮实际结果见[修复记录](../../docs/kaswin-v2/RELEASE-REVIEW-FIXES.md)。JS模型≠VM，SCRIPT_VM≠完整交易验证或网络acceptance。默认套件通过不代表历史回执已复核或预算门已批准。

## 命令

```bash
node tests/audit/run-all.mjs          # 默认仅本地JS，无VM或网络
node tests/audit/run-all.mjs --local  # 同上
# 仅明确授权VM且已有独立评审构建清单时：
node tests/audit/run-all.mjs --vm --manifest=/absolute/reviewed-vm.json
```

默认JS套件：01固定Profile/模板/ABI；02fee/退款末输出；03timeout/locktime模型；04genesis/空轮CLOSE/DRAW/缺金额上下文；05复用既有remediation/release-safety用例并补清单/CSP及单字段坏inputs；07 CLI/journal冲突/async验签false/VM结果解析；08将真实plan/execute/wallet/submit入口编译成候选模式，断言在访问节点／钱包之前拒绝；09 256次购票满额极限容量下状态账本、紧凑目录、CLOSE封盘、PASS-A随机抽样二分查找及DRAW_AND_PAY派奖端到端断言。05会注册引入文件的用例，不能再按旧README写4/4。run-all不再宣称整个codebase安全，子进程启动错误、超时和signal均失败，local失败不再启动VM。

## 历史：2026-10-08 VM harness准备说明

以下“未编译/未校准”只描述当时阶段；后续已执行的固定harness及2,549例材料以[2026-10-09记录](../../docs/kaswin-v2/VM-BUDGET-20261009.md)为准，独立评审/pin仍未完成。旧二进制不可因历史通过而任意复用。

`vm/hardened_vm.rs`为最小项目harness源码，针对固定rusty-kaspa `cfafeb4c093fa37a303f1b9f19c58f986b870ce3` API，沿用已存SilverScript3ed973…实验工作区依赖；**本轮未编译，Rust可编译性未验证**。不得执行旧v2_user_flows_vm并声称已测原预算。

后续在被忽略references中的固定Rust工作区安装该文件为integration test，先核对Cargo.lock和patch实际绑定上述共识版本，再显式编译`--no-run`；保存编译命令、依赖与构建日志，独立审查后提供JSON清单：

- schema=`KASWIN_VM_BINARY_REVIEW_1`
- absolute `binary`、真实`binarySha256`
- `harnessSourceSha256`（本目录hardened_vm.rs）
- `profileId`（当前7aaf76fe…）、`compilerCommit`（3ed973335b59269293564805cc2c58a14595ec03）、`consensusCommit`（cfafeb4…）
- `review:{status:'APPROVED',reviewer,at}`，必须有实际构建/审查，不能手填假测量。清单验证是来源记录，不是二进制同源的密码学证明。

06要求`--vm --manifest=...`，核对binary/source/Profile hash；缺清单直接阻断，没有旧路径回退。每次使用独立evidence子目录，保存所有JSON输入及hash、stdout/stderr、结果摘要。执行逐case超时120秒，无测试输入共享/tmp覆盖。

harness按draft原预算执行，每输入记录units；不覆盖成65535。不执行全交易sequence maturity、storage/relay或节点规则；不输出误导的质量“实测”。随机accessor注入历史公开opening对应的承诺，是合成SCRIPT_VM前提，不是网络证明。

结构化结果`KASWIN_VM_RESULT {schema:'KASWIN_SCRIPT_VM_1',scope:'SCRIPT_VM_NOT_FULL_TRANSACTION',name,profileId,budgets,units,status,input,error}`：

- ACCEPT：所有输入脚本通过且预算匹配。
- REJECT：配对正例已通过，且只有Input0、对应units数量和预期错误类别，才计对应负例通过。
- ERROR／非0退出／signal／缺行／错case／错预算：均失败，绝不伪装预期拒绝。

negative TIMEOUT只测sequence下限，不声称真实DAA age边界已运行；relative maturity需另用transaction_validator和POV上下文验证。fee/末输出负例目前要求VerifyError，若未来编译器改变错误类别应先核对源码/字节码，不自动扩大为“任意失败”。预算不足是失败信号，不准抬高预算强行变绿。目录256与中间退款预算仍未完成校准，budgetProfileId保持null。
