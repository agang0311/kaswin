# Kaswin Phase D: Header Certificate UTXO Feasibility Audit Report

**快照日期**：2026-09-06 UTC  
**网络**：Kaspa Testnet-10 / Pinned Rusty-Kaspa  
**节点源码基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  
**KIP 基准**：KIP-0016, KIP-0017, KIP-0020, KIP-0021 (`e4ae2332117b5cb68bd6188e065ef885b6d17939`)  

---

## 1. 结论 (RESULT)

**FAIL**

**一句话结论**：  
依据 pinned `rusty-kaspa v2.0.1` 及 KIP-0020 严格审查证实：Kaspa 当前 Toccata/KIP-0020 的 `covenant_id` 共识机制是一个**基于 Authorizing Outpoint 的单例（Singleton）/ 有向递归血统模型**，**其 genesis 产生必须强绑定特定的前序 Outpoint (`O`)，无法将全局固定的 Validator Covenant 脚本本身注册为对任意未定创世资产通用的血统根**；而在 DRAW 消费端，没有任何原生 opcode 或内置协议规则能允许脚本纯链上证明一个非同源 Outpoint 创建的 Certificate 确实执行过指定 Validator 的校验逻辑（任意普通钱包均可直接向匹配的 SPK 转账而伪造证书）。因此，**现有 Toccata Covenant / KIP-0017 / KIP-0020 原语无法支持无中心化裁判的纯原生链上 Certificate UTXO 血统认证**。

---

## 2. CERTIFICATE UTXO 模型审查 (CERTIFICATE UTXO MODEL)

审查目标模型：
- **P_CERT**：在交易 TX_P 中，执行者出资创建携带 $(P\_hash, P\_daa)$ 的紧凑状态 UTXO；
- **T_CERT**：在交易 TX_T 中，执行者出资创建携带 $(T\_hash, T\_daa, T\_parent0)$ 的紧凑状态 UTXO；
- **FINAL DRAW**：由 ARMED UTXO 作为 Input 0，P_CERT 作为 Input 1，T_CERT 作为 Input 2 共同组装交易结算奖池。

---

## 3. P_CERT 验证能力审查 (P_CERT VALIDATION)

- **在创建交易 TX_P 内部**：
  若仅考虑 TX_P 单输入校验，执行者提供单单一个 $H_P$（即使理论极值 130.7 KB）：
  $|H_P| + 5 + |\text{validator\_redeem}| < 250,000$ 字节，
  的确可以成功执行 `dynamic_daa_parser(H_P)` 并计算 `p_hash = Blake2b(H_P)`。
  但问题在于**如何将此验证结果安全交付给下游交易**。

---

## 4. T_CERT 验证能力审查 (T_CERT VALIDATION)

- **在创建交易 TX_T 内部**：
  单个 $H_T$ 同样可以单独执行 `dynamic_daa_parser`、`direct_parents()[0]` 提取以及 `OpChainblockSeqCommit`。
  单 Header 尺寸在单笔交易内部不会突破 250 KB 硬限制。

---

## 5. FINAL DRAW 如何认证证书血统？(HOW FINAL DRAW AUTHENTICATES CERT LINEAGE)

这是本方案的**核心致命死穴 (Fatal Flaw)**。

### 5.1 尝试方案 1：使用 KIP-0020 `covenant_id`

审查 `consensus/core/src/hashing/covenant_id.rs` 及 `crypto/txscript/src/covenants.rs:152`：
- **Genesis Covenant ID 算法**：
  $$\text{covenant\_id} = \text{CovenantIDHash}(O.\text{tx\_id} \mathbin{\Vert} O.\text{index} \mathbin{\Vert} \text{len(auth\_outputs)} \mathbin{\Vert} \dots)$$
- **矛盾**：
  `covenant_id` 的创世哈希强制将**花费的 Outpoint $O$** 纳入哈希。
  这意味着每个不同的执行者（甚至同一个执行者的不同 UTXO）创世产生的 `covenant_id` 必然**完全不同**！
  FINAL DRAW 脚本必须预先硬编码或通过约束期望的 `covenant_id`。然而在无许可网络中，执行者是谁、使用的是哪个 Outpoint 在抽奖创世阶段是未知的，FINAL DRAW 脚本无法预知未来的 `covenant_id`。
  反之，若由一个固定的“官方工厂 UTXO”递归产生所有证书，则会退化为依赖项目方或中心化 Keeper 持续维护递归链，违背了无许可（Permissionless）原则。

### 5.2 尝试方案 2：使用 P2SH 模板内省 (`OpTxInputSpkSubstr` + `OpTxInputScriptSigSubstr`)

设想使 P_CERT / T_CERT 的 Redeem Script 符合某种带有参数的固定模板：
- **致命伪造攻击（Forgery without Validation）**：
  在 Kaspa（乃至 Bitcoin 类 UTXO 链）中，P2SH 的 `script_public_key` 仅仅是 Redeem Script 的哈希摘要：
  $$\text{SPK} = \text{OpBlake2b} \mathbin{\Vert} \text{Push}(\text{Blake2b}(\text{redeem\_script})) \mathbin{\Vert} \text{OpEqual}$$
  任何攻击者都可以：
  1. 捏造虚假的 $P\_daa', P\_hash'$；
  2. 按照模板直接拼接出 `fake_redeem_script`；
  3. 计算其 Blake2b 并在自己的普通钱包中创建一个普通的 P2SH UTXO；
  4. 在 FINAL DRAW 交易中将该伪造 UTXO 作为 Input 1 / Input 2 引入；
  5. FINAL DRAW 脚本通过 `OpTxInputScriptSigSubstr` 检查该 Redeem Script 时，看到它确实符合模板结构且其哈希匹配 Input 1 的 SPK。
  **然而，该伪造 UTXO 的创建交易从来没有运行过任何区块头验证逻辑！攻击者凭空伪造了满足条件的 Certificate，无需提供任何 PoW 或合法区块！**

---

## 6. 首跨唯一性判定 (FIRST-CROSSING UNIQUENESS)

由于证书真伪无法被纯链上证明，伪造者可以随意构造任意虚假 $P\_daa, T\_daa$ 证书组合，导致**首跨唯一性彻底丧失**。

---

## 7. 错误证书是否可能锁住 ARMED？(WHY BAD CERTS CANNOT LOCK ARMED)

虽然证书创建未消费 ARMED，但因为 FINAL DRAW 无法拒绝假证书，攻击者可以用伪造证书直接盗取或非法结算 ARMED 奖池。

---

## 8. 单区块头开销 (MAX SINGLE-HEADER COST)

- 尺寸：单 Header 原像最坏 $\approx 130.7 \text{ KB}$；
- 加上 3 KB 验证脚本：$\approx 133.7 \text{ KB} < 250 \text{ KB}$（单笔可容纳）；
- Script Units：单 Header 解析约消耗 $5.2 \times 10^6$ units；
- 预算 $B \approx 527$（可容纳）。
**结论：虽然单个 Header 能装入单个交易，但无法向后续交易证明该单 Header 已被验证**。

---

## 9. 涉及的操作码与机制限制 (REQUIRED OPCODES / COVENANT FEATURES)

1. `OpTxInputSpk` / `OpTxInputSpkSubstr`：仅能内省当前交易各输入的 SPK；
2. `OpTxInputScriptSigSubstr`：仅能内省当前交易各输入的签名脚本（即 Redeem Script）；
3. `OpInputCovenantId`：仅能获取基于 Outpoint 派生的 `covenant_id`；
4. **缺失机制**：
   - 无法内省输入 UTXO 的**前序交易源码 / 执行收据（Execution Receipt）**；
   - 无法纯链上检查某个 UTXO 是由哪个 Covenant 脚本**作为输出规则**生成的（没有全局通用的 Script Hash Lineage）。

---

## 10. 最小 VM 证明 (MINIMAL VM EVIDENCE)

测试验证脚本：`/root/kaswin/tests/rust-vm-validation/src/bin/cert_lineage_spike.rs`
- 审查证明了尝试通过 SPK / ScriptSig 内省模板认证证书时，攻击者可以通过构造匹配模板的 P2SH 直接规避前置验证；
- 官方 `covenants.rs:152` 证明了 Genesis `covenant_id` 与特定 Outpoint 强绑定，无法充当非同源开放证书的通用类型标签。

---

## 11. 文件变更清单 (FILES CHANGED)

- `docs/header-certificate-utxo-feasibility-report.md` (本审计报告)
- `tests/rust-vm-validation/src/bin/cert_lineage_spike.rs` (血统与内省可行性分析探针)

---

## 12. 提交记录 (COMMIT)

即将提交至 GitHub 仓库固化。

---

## 13. 下一步动作 (EXACTLY ONE NEXT ACTION)

**按照指令严格判定 RESULT = FAIL。终止基于原生 Covenant Primitives 的多交易 Certificate 方案探索；正式转向 ZK Compact Proof（基于 pinned KIP-0016 `OpZkPrecompile`）可行性审查，探索由链下轻客户端生成双区块头 DAA 首跨有效性证明并在 FINAL DRAW 中单次验证。**
