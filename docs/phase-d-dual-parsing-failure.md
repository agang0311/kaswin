# Phase D: Exact-Bytes Enumerator & Suffix Grammar Dual-Parsing Audit Report

**快照日期**：2026-09-06 UTC  
**环境**：Kaspa Testnet-10  
**节点源码基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**FAIL**

**一句话结论**：  
通过实现并执行 `exact-bytes-enumerator`，**严格否定了当前 Dynamic Suffix Grammar 的唯一可解构性（Unique Suffix Decomposition 被严格证伪）**；在保持完整 Header 原像字节 100% 逐字节完全不变的前提下，合法构造出了 canonical $W=16$ 的标准区块头，该同一字节序列被当前 Covenant 语法同时解析为 $W=16$ 与 $W'=8$ 两个完全合法的不同切分，导致被认证的 DAA 字段直接错位为 `blue_score`，形成致命的双重解析漏洞。

---

## 2. EXACT-BYTES ENUMERATOR 算法说明

测试源码：`/root/kaswin/tests/rust-vm-validation/src/bin/exact_enumerator.rs`

- **输入**：由 `rusty-kaspa v2.0.1` 官方序列化生成的完整规范 BlockHash 原像字节数组 `header_bytes`；
- **枚举空间**：遍历所有合法显著字节跨度 $W' \in [0, 24]$；
- **切分规则**（从同一字节数组尾部严格反向推导，不修改任何一个字节）：
  1. `pruning' = header_bytes[len - 32 .. len]` (32B)
  2. `work' = header_bytes[len - 32 - W' .. len - 32]` ($W'$B)
  3. `work_len' = header_bytes[len - 32 - W' - 8 .. len - 32 - W']` (8B)
  4. `blue_score' = header_bytes[len - 32 - W' - 16 .. len - 32 - W' - 8]` (8B)
  5. `daa' = header_bytes[len - 32 - W' - 24 .. len - 32 - W' - 16]` (8B)
- **Covenant 局部断言判定**：
  - `len(pruning') == 32`；
  - $0 \le W' \le 24$；
  - 若 $W' > 0$，断言 `work'[0] != 0x00`（无前导零）；
  - `len(work_len') == 8`；
  - `u64::from_le_bytes(work_len') == W'`；
  - `len(blue_score') == 8`；
  - `len(daa') == 8`。
- **输出**：返回所有通过全部上述断言的有效 $W'$ 候选集合。

---

## 3. 真实样本测试结果 (REAL TN10 RESULTS)

对当前 Testnet-10 真实链上采样的 $P$ 与 $T$ 区块头运行该枚举器：
- **真实区块 $P$**：`canonical W = 7`，`valid candidates = [7]`（在此特定真实样本下偶然唯一）
- **真实区块 $T$**：`canonical W = 7`，`valid candidates = [7]`（在此特定真实样本下偶然唯一）

---

## 4. W=16 规范夹具构建 (W16 FIXTURE)

构建合法的 canonical $W=16$ 区块头：
- `BlueWorkType`（大端 24 字节）：
  `[00 ... 00 (8B 前导零) | 08 00 00 00 00 00 00 00 (8B) | 01 11 22 33 44 55 66 77 (8B)]`
- **规范性质确认**：
  - 属于合法的 192 位算力累加数值；
  - 剥离前导零后，显著字节正好为 16 字节；
  - 第 1 个字节为 `0x08 != 0x00`，完全符合 canonical 无前导零规则；
  - `consensus/core/src/hashing/mod.rs` 官方序列化该字段生成：
    `work_len = [16, 0, 0, 0, 0, 0, 0, 0]` (8B LE) 紧随上述 16 字节 `work_bytes`。

---

## 5. 双重解析漏洞确证 (W'=8 RESULT)

将上述完全不变的 $W=16$ 规范原像字节输入枚举器，输出结果为：
$$
\text{valid candidates} = [8, 16]
$$

### 两个合法解的切分语义对照：

| 字段 | Canonical 解释 ($W=16$) | 恶意双重解析 ($W'=8$) | 错位性质与危害 |
|---|---|---|---|
| **`pruning'`** | 真实 `pruning_point` (32B) | 真实 `pruning_point` (32B) | 一致 |
| **`work'`** | 16 字节完整 work 字节 | **真实 work 的后 8 字节** `[01 11 22 ...]` | 长度为 8B，首字节 `0x01 != 0`，合法通过！ |
| **`work_len'`** | `16` (`0x10, 0...`) | **真实 work 的前 8 字节** `[08, 0, 0, 0, 0, 0, 0, 0]` | 数值恰好为 8，与 `len(work')` 严格相等，合法通过！ |
| **`blue_score'`**| 真实 `blue_score` (8B) | **原 `work_len` 字段** (数值 16) | 错位占用 |
| **`daa'`** | **真实 `daa_score` (8B)** | **原 `blue_score` 字段** | **致命错位：脚本读到的 DAA 实际是 blue_score！** |

---

## 6. 唯一性否定证明 (UNIQUENESS REFUTATION)

**证明定理**：
在现行的动态后缀解构语法下，**不存在针对全局任意合法 Header 字节的唯一解析**。  
当网络累计算力满足其显著前 8 字节恰好构成一个小整数 $k \in [1, 24]$ 且后半部分首字节非零时（如 $W=16, k=8$），该原像天然存在 $W$ 与 $W'=k$ 两个均能 100% 满足脚本检查的解。攻击者可以自由选择 $W'=k$，将本应是 `blue_score` 的数据作为 `daa_score` 传入合约进行数值比对，从而以合法的真实区块头彻底绕过首跨边界约束。

---

## 7. 审计判定与下一步动作

- **判定**：**FAIL**（当前动态后缀语法不具备密码学唯一解构性）。
- **后续处理原则**：坚决不通过“概率很小”或“当前链暂未达到”来掩盖漏洞，必须在协议层彻底解决确定性结构定位。
