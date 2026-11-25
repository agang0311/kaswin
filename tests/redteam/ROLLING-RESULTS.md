# Rolling（256×256 分片）kaspa-redteam 离线结果

- 生成时间：见同目录 `manifest.json` 的 `generatedAt`
- 目标：`https://<staging-host>/tn10/` 对应的 `experiments/rolling` 原型，候选 Profile `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`（页面标记 `UNVALIDATED`）
- 交易来源：`experiments/rolling/fixtures.mjs` + `transactions.mjs`，即真实 JS 构造器对**真实编译产物**（silverc 1.0.1）生成的诚实交易；资金输入用公开的一次性密钥签名（`sha256("kaswin-rolling-vm-throwaway-key:funder")`，与 `vm-cases.mjs` 相同，从未充值）
- 判定器：kaspa-redteam v0.14.2（rusty-kaspa `TransactionValidator` 2.1.0，主网常量，进程内离线），**未连节点、未签名广播、未使用任何钱包**
- 证据层级：**V（离线脚本/共识判定器）**。不是 N 层链上验收，不是审计，也不是页面行为验证

## 覆盖

44 笔诚实交易，按模板分文件（`--baseline` 单文件，任一笔原样检查失败即整份中止）：

| 模板 | 笔数 | 覆盖的边界 |
|---|---:|---|
| sales | 14 | 首笔、第 255 条本地记录、第 1 个分片冻结、第 255 个分片冻结、**创建第 256 个分片**、1000 票单笔、8 个资金输入；空轮→EMPTY、→SEALED（含最大 255 分片）、→REFUND（含最大）、票满免时间锁、**256 分片满载（65,536 条记录）**封盘 |
| sealed | 5 | 中奖票落在旧分片 / 本地尾巴 / **256 分片满载**；超时转退款（含满载） |
| win | 12 | PAY_OLD k=1/k=16（非终局、p=128、**满载 256 分片**）、k=1/k=16 最终合并、空尾巴合并、尾巴过大不合并、PAY_SELF 最大/最小 |
| refund | 13 | REFUND_OLD 非终局 r=0/c=0 与 c=32、单分片最后一批、最后分片不合并、最终合并 36 输出、空尾巴合并、**满载 256 分片最后分片**；REFUND_SELF 非终局/最后一批/单条/无资金输入/8 资金输入 |

全部 44 笔都通过了判定器的「原样」共识检查后才进入攻击。

## 结果

| 模板 | 跑的攻击 | 通过 | 发现 | 未覆盖路径 |
|---|---:|---:|---:|---|
| sales | 7 | 7 | 0 | `spend`（自动搜索无法构造，符合预期） |
| sealed | 6 | 6 | 0 | 同上 |
| win | 7 | 6 | **2** | — |
| refund | 7 | 6 | **4** | — |

实际执行的攻击：FEE-01、IN-01、IN-02、OUT-01、OUT-02、OUT-03、OUT-04。
跳过的 22–23 项：BOR-01…07、FAM-01…10（本项目不是 KCC-20 家族，也不持有外部代币）、ORC-04、SEC-01、SIG-01、SIG-02、ST-01（无签名路径、无状态 owner 字段、无签名读数）。

## 6 项发现的判定

全部是 **OUT-01「金额正确、收款脚本被改」**，且全部落在**执行者奖励输出**（win 的 output 2、refund 的末位输出，金额 1 TKAS/分片 或执行费池）。赢家奖金、创建者押金、买家退款、管理片输出**均未被改动**（`repro.outputs` 显示只有执行者那一位变成 `attacker`），每个 repro 都能 `replay` 复现。

根因在合约源码：`experiments/rolling/contracts/common.sil.inc:127-132`

```
function chosenPayment(int i, int value) {
    require(value > 0 && value <= VALUE_LIMIT && tx.outputs[i].value == value);
    byte[] spk = tx.outputs[i].scriptPubKey;
    require(length(spk) == 36 && spk.slice(0, 3) == byte[](0x000020) && spk.slice(35, 36) == byte[](0xac));
    require(OpOutputCovenantId(i) == ZERO);
}
```

只校验金额、P2PK 形状（36 字节 `0x000020‖key‖0xac`）和无协变绑定，**不校验收款公钥**。

**性质判定**：派奖/退款是免签名、任何人可推进的，执行者奖励本来就归「谁执行」，所以「执行者把奖励付给自己」是合法行为，不构成用户资金损失。`experiments/rolling/VALIDATION.md` §3 也已把该性质记为预期通过。

**但确实有一处弱点，值得修**：`op.actorKey` 作为 witness 参数被合约接收，却从不与任何输出比对。后果不是被盗，而是**链上无法从 witness 验证「谁拿到了执行奖励」**——witness 说 A，输出可以付给 B，审计/索引器若按 witness 推断收款方会得到错误答案。对比现行 Kaswin V2.0.2 的 `ordinary(index, amount, actorPk)` 会把输出钉到 witness 声明的 `actorPk`，滚动版这一步被放宽了。

建议（与 redteam 给的 fix pattern 一致）：`chosenPayment(i, value, pubkey actor)` 内加
`require(tx.outputs[i].scriptPubKey == byte[](new ScriptPubKeyP2PK(actor)));`
这不改变权限模型（执行者仍自选 key），只是让 witness 与效果一致。

## 未覆盖（不得当作已验证）

- 状态/算术/锁定边界/mass/资金卡死这几类攻击 redteam 尚未实现（其 ROADMAP 的 ST-02/03、AR、TL、MS、LIV 包），因此 0 发现不代表这些方面安全。
- 只给了 `.sil` 源码与 baseline，自动花费搜索仍为 `unexplored`（滚动合约需要真实 covenant id 与分片 preimage），没有新增路径。
- 共识层边界（成熟度、双花、入池策略）、节点 acceptance、索引器、浏览器页面行为：**NOT_RUN**。
- 页面新界面（TS 重写）从未跑过测试，本轮也没有跑。

## 复现

```bash
node tests/redteam/rolling-baseline.mjs                    # 生成 4 份 baseline + manifest
cd experiments/rolling
RT=<path-to-kaspa-redteam>
for m in sales sealed win refund; do
  $RT generated/$m.sil --baseline <out>/rolling/$m.baseline.json -v --no-color --out <out>/rolling/findings-$m
done
```
