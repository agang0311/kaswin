# kaspa-redteam 离线 baseline

`rolling-baseline.mjs` 为 Kaswin Rolling 分片版（Profile `b56bcd9c…`）生成 44 笔诚实交易的 [kaspa-redteam](https://github.com/kasperolabs/kaspa-redteam) `kaspa-redteam/baseline/1` 格式基线，供变异攻击测试。

- 资金币是凭空声明的，用确定性的**公开一次性密钥**签名（`kaswin-rolling-vm-throwaway-key:funder`），不读 `tests/web/wallets/`，交易无法广播。
- 证据层级为 V（离线、第三方判定器 rusty-kaspa 2.1.0），不是 N 层链上验收，也不是审计。

## 用法

```bash
node tests/redteam/rolling-baseline.mjs     # -> tests/output/redteam/<ts>/rolling/{sales,sealed,win,refund}.baseline.json
RT=<kaspa-redteam 检出目录>/target/release/kaspa-redteam
for m in sales sealed win refund; do
  $RT contracts/$m.sil --baseline <out>/rolling/$m.baseline.json -v --no-color --out <out>/rolling/findings-$m
done
```

`--baseline` 只支持单文件，一份文件里任意一笔原样检查不通过整份就停，因此按合约拆成四份。
`NOTHING TESTED` 时退出码也是 0，需检查报告里 `attacks run > 0`。

## 开奖：本地补丁

上游 redteam 判定器不提供 `SeqCommitAccessor`，`OpChainblockSeqCommit` 是 `InvalidOpcode`。
`references/kaspa-redteam` 的本地分支 `kaswin-seqcommit`（补丁存档 `references/redteam-runs/kaswin-seqcommit.patch`）
让 baseline 可声明 `"seqCommitments": {"<区块哈希>": "<承诺>"}`：声明过的区块视为选定链祖先且在深度内，未声明的视为已裁剪；
未声明任何承诺时行为与上游完全一致。

开奖用的 240 字节 PASS-A 证明是合成的（满足首次越界与 blue score 次序，`tseq` 按合约公式计算），承诺值由 baseline 声明。
它检验的是**承诺之外**的合约逻辑（抽样、派奖输出、执行者赏金、输入输出约束），不检验目标区块真实存在或已被选定。

## 历史记录

结果与判定见 [ROLLING-RESULTS.md](ROLLING-RESULTS.md)；网页与实链测试记录见 [ROLLING-WEB-TEST.md](ROLLING-WEB-TEST.md)。
