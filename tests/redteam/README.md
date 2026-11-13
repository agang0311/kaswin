# kaspa-redteam 离线 baseline

`baseline.mjs` 用正式构造器（`scripts/core.mjs`）和固定 Profile（`contracts/`）离线生成 Kaswin V2.0.2 的诚实交易，
写成 [kaspa-redteam](https://github.com/kasperolabs/kaspa-redteam) 的 `kaspa-redteam/baseline/1` 格式，供它做变异攻击。

- 资金币是凭空声明的，用确定性的**一次性密钥**签名（`kaswin-redteam-throwaway-key:<role>`），不读 `tests/web/wallets/`，交易无法广播。
- 证据层级为 V（离线、第三方判定器 rusty-kaspa 2.1.0，主网常量），不是 N 层链上验收，也不是审计。

## 用法

```bash
node tests/redteam/baseline.mjs     # -> tests/output/redteam/<ts>/{open,sealed,sealed-draw,refunding}.baseline.json
cd contracts/artifacts
RT=<kaspa-redteam 检出目录>/target/release/kaspa-redteam
for c in open sealed sealed-draw refunding; do
  $RT ${c%-draw}-linked.sil --baseline <ts目录>/$c.baseline.json -v --no-color --out <ts目录>/findings-$c
done
```

`sealed-draw` 需要本地补丁版 redteam（见下）；上游版本会以 `InvalidOpcode 0xd4` 拒绝整份文件，其余三份不受影响。

`--baseline` 只支持单文件，一份文件里任意一笔原样检查不通过整份就停，所以按合约拆成三份。
`NOTHING TESTED` 时退出码也是 0，要看报告里 `attacks run > 0`。

## 覆盖

| 文件 | 交易 |
|---|---|
| open | 首笔购票、卖满购票、第 33 条记录购票；空轮封盘→EMPTY；卖满立即封盘→SEALED（不等时间锁）；到期封盘→SEALED；到期封盘→REFUNDING |
| sealed | 432,000 DAA 超时转退款 |
| sealed-draw | 卖满封存后开奖派奖、到期封存后开奖派奖（合成 PASS-A 证明） |
| refunding | 单批即最终批（超时路径）；33 条记录的第 1 批（32 条，游标推进）与最终批 |

## 开奖：本地补丁

上游 redteam 判定器不提供 `SeqCommitAccessor`，`OpChainblockSeqCommit` 是 `InvalidOpcode`。
`references/kaspa-redteam` 的本地分支 `kaswin-seqcommit`（补丁存档 `references/redteam-runs/kaswin-seqcommit.patch`）
让 baseline 可声明 `"seqCommitments": {"<区块哈希>": "<承诺>"}`：声明过的区块视为选定链祖先且在深度内，未声明的视为已裁剪；
未声明任何承诺时行为与上游完全一致。

开奖用的 240 字节 PASS-A 证明是合成的（满足首次越界与 blue score 次序，`tseq` 按合约公式计算），承诺值由我们自己声明。
所以它检验的是**承诺之外**的合约逻辑（抽样、派奖输出、执行者赏金、输入输出约束），不检验目标区块真实存在或已被选定。
对照：承诺值改错一位时合约拒绝；不声明承诺时报 `InvalidOpcode`。

## 不覆盖及原因
- **执行者赞助的 REFUND**（页面在执行费池不足或存储质量超限时附加一笔执行者 P2PK 输入）：工具导入时把 P2PK 资金币换成攻击者的币，
  并把付回该地址的输出也改给攻击者，而这正是合约钉死的 `actorPk` 输出，原样检查必然失败。交易本身用 txscript 2.1.0 原样重放是通过的。
- **refunding 不列 `keys`**：工具会把付给已列钥匙的输出改写为攻击者地址，退款输出是合约钉死的买家与执行者，列了就无法导入。
