# Phase D: Canonical DAA Position Derivation & Monolithic Header Authentication Report

**快照日期**：2026-09-06 UTC  
**环境**：Kaspa Testnet-10  
**节点源码基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
彻底摒弃从变长后缀反向切分的脆弱语法，实现了**自前端自描述结构展开的正向确定性 DAA 定位合约（1,685 字节 Redeem Script）**；Witness 强制要求传入未经切分的单体规范原像（Monolithic `H_P`, `H_T`），由 Script 内部动态计算每一层 Parent Level 的字节跨度，确定性推导出 `daa_offset = parents_end + 116` 并由 `OpSubstr` 原地切出 DAA 数值；实现了 **Accepted Decomposition Count = 1** 与 **Accepted Alternative DAA Positions = 0** 的绝对唯一性；在 Rust VM 中全部 6/6 项测试（现网真实数据、多直接父块拓扑、变长 BlueWork $W=0, 6, 8, 16, 24$、后代块拦截、早于边界块拦截、原像篡改拦截）均获得严格验证。

---

## 2. 规范 DAA 位置推导公式 (CANONICAL DAA POSITION DERIVATION)

依据 `rusty-kaspa v2.0.1` `consensus/core/src/hashing/header.rs` 权威实现，BlockHash 序列化在 DAA 之前的字节排布具备完全的前端自描述性：

1. **版本号 (`version`)**：`u16` 小端序，**固定 2 字节**（偏移 `0..2`）；
2. **父块层级展开数 (`expanded_len`)**：`u64` 小端序，**固定 8 字节**（偏移 `2..10`，数值记为 $L$）；
3. **序列化父块层级 (`parents_by_level`)**：从偏移 10 开始，共包含 $L$ 个层级。对于每个层级 $i \in [0, L-1]$：
   - 层级父块数量 $k_i$：`write_len(k_i)` 为 `u64` 小端序，**固定 8 字节**；
   - 层级哈希数组：$k_i \times 32$ 字节；
   - 第 $i$ 层级总字节跨度：$\text{len}(\text{level}_i) = 8 + 32 \times k_i$ 字节；
   - 遍历所有 $L$ 个层级后的总长度记为 $P_{\mathrm{total}} = \sum_{i=0}^{L-1} (8 + 32 \times k_i)$；
4. **固定中间字段 (`mid_116`)**：
   - `hash_merkle_root` (32B)
   - `accepted_id_merkle_root` (32B)
   - `utxo_commitment` (32B)
   - `timestamp` (8B)
   - `bits` (4B)
   - `nonce` (8B)
   - **合计固定为 116 字节**（$32 + 32 + 32 + 8 + 4 + 8 = 116$）；
5. **DAA 字段位置绝对公式**：
   $$\text{daa\_offset} = 2 + 8 + P_{\mathrm{total}} + 116 = P_{\mathrm{total}} + 126$$
   $$\text{daa\_score} = H[\text{daa\_offset} \;\;..\;\; \text{daa\_offset} + 8] \quad (\text{8 字节 } \texttt{u64} \text{ 小端序})$$

---

## 3. 合约构建逻辑 (COVENANT CONSTRUCTION)

- **单体见证输入 (Monolithic Witness)**：
  调用者不再提供任何分片参数或自报声明，Witness 仅推入未经切开的原始单体原像：
  $$\text{Witness Stack} = [H_P, H_T]$$
- **脚本内认证与原位提取**：
  1. **层级数合规验证**：`H[2..10] == expanded_len`（通过 `OpSubstr` 提取并由 `OpEqualVerify` 锁定网络常量）；
  2. **直接父块锁**：`T_parent0 = OpSubstr(18, 50, H_T)`，共识保证其为 GHOSTDAG selected parent；
  3. **哈希内生性**：`T_hash = OpBlake2bWithKey("BlockHash", H_T)`，并直接交由 `OpChainblockSeqCommit(T_hash)` 强校验；
  4. **正向无循环展开解析器 (Forward Parser)**：
     针对 $L$ 个层级展开 12 个操作码的单步递推单元：
     ```text
     OpOver OpOver OpDup 8 OpAdd OpSubstr OpBin2Num 32 OpMul 8 OpAdd OpAdd
     ```
     每次动态读取该层级的 $k_i$，原地计算 $8 + 32 \times k_i$ 并累加指针，最终执行 `116 OpAdd` 得到精确的 `daa_offset`；
  5. **DAA 原位提取**：`OpSubstr(daa_offset, daa_offset + 8, H)` 提取 8 字节并执行 `OpBin2Num` 得到数值；
  6. **父子链绑定**：`OpEqualVerify(T_parent0, P_hash)`；
  7. **首跨数值断言**：`P_daa < boundary && T_daa >= boundary`。

---

## 4. 绝对唯一性实测结果 (EXACT-BYTES UNIQUENESS RESULT)

针对任意完全固定不变的规范 Header 字节串 $H$：
- **Canonical Position**：由公式 $P_{\mathrm{total}} + 126$ 唯一确定；
- **Accepted Alternative Positions**：**0**（无任何分支或可选择余地）；
- **Accepted Decomposition Count**：**EXACTLY 1**（见证采用单体原像，不存在切分自由度）；
- **与 BlueWork 长度解耦**：`blue_work` 位于 DAA 之后，无论 $W$ 为 0、6、7、8、16 或 24，均完全不影响正向解析器计算得到的 `daa_offset`。此前 $W=16 \leftrightarrow W'=8$ 的双重解析漏洞被彻底消除。

---

## 5. 虚拟机实测证据 (VM EVIDENCE)

测试源码：`/root/kaswin/tests/rust-vm-validation/src/bin/canonical_daa_position_test.rs`

1. **真实 TN10 区块头测试 (`T: 549f4a90...`, `P: 002e28a9...`)**：
   - 结果：**Ok(())** -> **PASS**
2. **多直接父块规范拓扑（Level 0 包含 2 个直接父块）**：
   - 结果：**Ok(())** -> **PASS**（动态解析器正确识别 $k_0=2$ 并精准跨过 72 字节）
3. **变长 BlueWork 鲁棒性测试（$W = 0, 6, 8, 16, 24$ 字节）**：
   - $W=0$：**Ok(())** -> **PASS**
   - $W=6$：**Ok(())** -> **PASS**
   - $W=8$：**Ok(())** -> **PASS**
   - $W=16$（曾导致旧后缀语法双解的攻击场景）：**Ok(())** -> **PASS**
   - $W=24$：**Ok(())** -> **PASS**
4. **对抗测试 1（后代区块 $P_{\mathrm{daa}} \ge \mathrm{boundary}$）**：
   - 结果：**Err(VerifyError)** -> **FAIL (拦截成功)**
5. **对抗测试 2（早于边界区块 $T_{\mathrm{daa}} < \mathrm{boundary}$）**：
   - 结果：**Err(VerifyError)** -> **FAIL (拦截成功)**
6. **对抗测试 3（篡改原像任意 1 位字节）**：
   - 结果：**Err(BlockNotSelected)** -> **FAIL (拦截成功)**

---

## 6. 开销核定 (COST)

- **Redeem Script 尺寸**：**1,685 字节**（双向展开解析 61 层级父块，远低于 1 MB 脚本上限）；
- **Witness 栈尺寸**：$H_P$ (~2.6 KB) + $H_T$ (~2.6 KB) + RedeemScript (1.7 KB) $\approx$ **6.9 KB**；
- **Script Units 消耗**：约 **2,500 units**（远低于 500,000 gram 计算 Mass 上限）；
- **Transaction Mass**：约 **70,000 gram**（低于单块 500,000 gram 上限）；
- **手续费估算**：约 **0.001 ~ 0.002 TKAS**。

---

## 7. 剩余真实风险 (REMAINING RISKS)

1. **网络级层级常量适配**：
   `expanded_len` 在 Testnet-10 上为 61，在 Mainnet 上为 226。若要在 Mainnet 部署，脚本构造参数须传入 `expanded_len = 226`（对应生成约 5.5 KB 脚本，仍完全在主网限制内）。
2. **矿工经济偏置（Miner Withholding Bias）**：
   虽然普通执行者已零选择权且无法伪造 DAA，但算力矿工仍可通过牺牲出块奖励实施主动丢块（单块沉没成本主网现行约为 2.31 KAS）。该风险将在后续 Multi-block 机制评估中进一步量化。
