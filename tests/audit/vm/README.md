# SCRIPT_VM harness 来源与构建边界

`hardened_vm.rs`是本项目最小测试harness，参考本地先前实验 `v2_user_flows_vm.rs` 的固定Kaspa构造API重新编写；没有复制上游工程，也没有分发二进制。语义依据：rusty-kaspa `cfafeb4c093fa37a303f1b9f19c58f986b870ce3` 的`crypto/txscript`、consensus/core transaction/covenants/sighash；SilverScript固定`3ed973335b59269293564805cc2c58a14595ec03`。来源复核日2026-10-08。**源码未编译／未运行，不能声称与任何已有本机二进制同源。**

后续独立授权后，在被忽略的固定依赖工作区复制为 `silverscript-lang/tests/hardened_vm.rs`，检查Cargo实际使用cfafeb4（上游SilverScript原Cargo依赖不是此节点commit，必须记录既有本机patch的来源），以锁文件和离线依赖编译integration test，仅`--no-run`。编译成功后记录binary完整路径、SHA256、本文源码SHA256、依赖固定信息和构建命令，并独立审查后产生README要求的manifest；本轮未产生这个manifest。

测试输入用公开标量1，外部资金签名只为合成输入；不读取钱包。逐输入使用原computeBudget，遇错误返回Input编号和具体错误类别，panic/解析失败不会变成负例成功。注入的SeqCommit accessor是mock前提；全交易sequence-lock maturity、storage mass、relay、节点接受以及256全覆盖仍需其他验证。任何用例预算不足都应保留为失败，不可恢复旧65535覆盖隐藏问题。
