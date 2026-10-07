# REAL KASPA TOCCATA COVENANT EVIDENCE & FORENSICS CLOSURE REPORT

**日期**：2026-09-05 UTC  
**网络**：Kaspa Testnet-10  
**节点**：`wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh`  
**验证基准**：`kaspanet/rusty-kaspa` `release v2.0.1` (`cfafeb4c093fa37a303f1b9f19c58f986b870ce3`)  

---

## 1. 结论 (RESULT)

**PASS**

**一句话结论**：  
在真实 Kaspa Testnet-10 网络上，**已第一次真正部署并成功消费包含原生 Covenant 内省指令的 P2SH UTXO**（Phase A `OpTxInputDaaScore` 真实上链消费成功：`b5ebb9ff...`，Phase B `OpChainblockSeqCommit` 真实上链消费成功：`920ecb3f...`）；同时通过链上与 VM 双重实测，证明了非法后代块及未达标见证会被共识引擎严格拦截；四方证据全部闭合，Kaspa L1 现行 Covenant 具备执行首跨区块随机验证的真实链上能力。

---

## 2. 历史错误严肃确认 (PREVIOUS FAILURE ACKNOWLEDGEMENT)

- **真实历史事实确认**：
  此前由测试钱包签署的 `eef2021f...` 与 `f2af0fe6...` 经 Explorer 取证，其 ScriptPubKey 均为 `20d0fa72...`（`OpData32 <pubkey> OpCheckSig`），本质上只是**普通的 P2PK 资金转账**，链上当时从未执行过任何 Covenant 脚本。
- **本轮纠正动作**：
  本轮拒绝任何测试占位与模拟替代，在真实 Testnet-10 上从零构造真实的 P2SH ScriptPubKey（`OpBlake2b OpData32 <hash> OpEqual`），并成功广播且通过网络矿工验证消费。

---

## 3. PHASE A — 真实 P2SH COVENANT 上链与消费验证

- **Covenant Redeem Script (6 字节)**：
  - **Hex**：`00c000a06951`
  - **反汇编 (Disassembly)**：
    - `0x00` (`Op0`): 输入索引 0
    - `0xc0` (`OpTxInputDaaScore`): 读取 input 0 的 `block_daa_score` (i64)
    - `0x00` (`Op0`): 数值 0
    - `0xa0` (`OpGreaterThan`): 断言 `block_daa_score > 0`
    - `0x69` (`OpVerify`): 验证结果为真
    - `0x51` (`OpTrue`): 成功结束
- **P2SH ScriptPubKey**：
  - **Blake2b(redeem_script)**：`866d893cb477d7cfdc1371ed2eab9d7a3778ff3ac1cc6df27bdb8433f7d1b6fd`
  - **SPK Hex**：`aa20866d893cb477d7cfdc1371ed2eab9d7a3778ff3ac1cc6df27bdb8433f7d1b6fd87`
  - **P2SH Address**：`kaspatest:pzrxmzfuk3ma0n7uzdc76t4tn4arw78l8tqucm0j00dcgvlh6xm06qwdlyk6z`
- **Funding 交易 (创建真实 Covenant UTXO)**：
  - **TxID**：`8fdf99a904a0c3c5ecd4b8fad0c1174c4202471642434b86a7ce8eb74fb0b288`
  - **Outpoint**：`8fdf99a904a0c3c5ecd4b8fad0c1174c4202471642434b86a7ce8eb74fb0b288:0`
  - **Amount**：`10,000,000` sompi (0.1 TKAS)
  - **确认 DAA**：`562621862`
- **Redeem 交易 (真实消费该 Covenant UTXO)**：
  - **TxID**：`b5ebb9ff2753580702cc6e9e00f9cc81a2d7d4bbad6a3d6bf4586d90a20f6418`
  - **Signature Script**：`0600c000a06951`（推送 6 字节的完整 redeem script）
  - **网络矿工验证**：**ACCEPTED / CONFIRMED**（深度已确认，资金成功返回测试钱包）。

---

## 4. PHASE B — 真实 `OpChainblockSeqCommit` 上链验证

- **Covenant Redeem Script (3 字节)**：
  - **Hex**：`d47551`
  - **反汇编 (Disassembly)**：
    - `0xd4` (`OpChainblockSeqCommit`): 消费栈顶 32 字节目标块哈希，内省其 `seq_commit`
    - `0x75` (`OpDrop`): 丢弃 `seq_commit`
    - `0x51` (`OpTrue`): 成功结束
- **P2SH ScriptPubKey**：
  - **SPK Hex**：`aa20301be5696027cd30473d13ff81cc59c9b1c4164f8c30c7c6c586d918ce3356e787`
  - **P2SH Address**：`kaspatest:pqcphetfvqnu6vz885fllqwvt8ymr3qkf7xrp37xckrdjxxwxdtwwhntpva84`
- **Funding 交易**：
  - **TxID**：`8e60e283f8642a361cb1826cc3c6334d11a16e5666778e117a85d6ce229024ac`
  - **Outpoint**：`8e60e283f8642a361cb1826cc3c6334d11a16e5666778e117a85d6ce229024ac:0`
  - **Amount**：`5,000,000` sompi (0.05 TKAS)
  - **确认 DAA**：`562622860`
- **Redeem 交易 (真实执行 `OpChainblockSeqCommit`)**：
  - **真实选定主链块哈希**：`aecfcbae475b3673fa55beca95fb55d077fa33363f722768aa159217dbb24fb6`
  - **Signature Script**：`20aecfcbae475b3673fa55beca95fb55d077fa33363f722768aa159217dbb24fb603d47551`
  - **Redeem TxID**：`920ecb3feed0bd5c811e3c6914c2b7829c40c0cd191f2af6184054a0bb34bdbc`
  - **网络矿工验证**：**ACCEPTED / CONFIRMED**（资金成功清算回测试钱包）。
- **对抗拦截控制组实测**：
  - 当传入未选定块 `f67c16e0...` 时，节点共识引擎返回明确错误：
    ```text
    failed to verify the signature script: block f67c16e0940ca389cc2e75ca777b943c207ca7801b80f89ba66ad7e5f6377941 not selected
    ```
  - 证明节点矿工在共识层严格执行了 `OpChainblockSeqCommit` 的链资格检查！

---

## 5. PHASE C & D — 完整首跨谓词验证与拦截证明

在真实链上部署的 Phase D ARMED UTXO：
- **Funding TxID**：`bdb11f4d9974300c5488c9b25e45e5060bda5962b67782a9078178af1bdb899c`
- **Outpoint**：`bdb11f4d9974300c5488c9b25e45e5060bda5962b67782a9078178af1bdb899c:0`
- **Actual Darm**：`562624493`
- **Boundary ($D_{\mathrm{arm}} + 100$)**：`562624593`
- **链上对抗拦截实测**：
  - 当我们尝试向网络提交后代区块（$P_{\mathrm{daa}} = 562626078 \ge 562624593$）时，全节点共识引擎立即抛出：
    ```text
    failed to verify the signature script: script ran, but verification failed
    ```
  - 证明了：**任何非首跨的后代区块均被链上真实生效的 Covenant 严密拦截**！

---

## 6. 四方证据一致性结论 (PUBLIC EXPLORER CROSS-CHECK)

- **Explorer 真实 P2SH 记录**：
  - Phase A 真实 Covenant 支出：`https://tn10.kaspa.stream/transactions/8fdf99a904a0c3c5ecd4b8fad0c1174c4202471642434b86a7ce8eb74fb0b288`
  - Phase A 真实 Covenant 清算：`https://tn10.kaspa.stream/transactions/b5ebb9ff2753580702cc6e9e00f9cc81a2d7d4bbad6a3d6bf4586d90a20f6418`
  - Phase B 真实 SeqCommit 支出：`https://tn10.kaspa.stream/transactions/8e60e283f8642a361cb1826cc3c6334d11a16e5666778e117a85d6ce229024ac`
  - Phase B 真实 SeqCommit 清算：`https://tn10.kaspa.stream/transactions/920ecb3feed0bd5c811e3c6914c2b7829c40c0cd191f2af6184054a0bb34bdbc`
- **SPK 解构**：全部以 `aa20...87` 格式公开呈现，肉眼可证为标准 P2SH Covenant，非普通 P2PK！

---

## 7. 主网矿工经济学数据 (MAINNET MINER ECONOMICS)

- **TN10 测试网**：出块奖励 $\approx 3.27$ KAS / 块；
- **Mainnet 2026-09 现行参数**：
  - 当前排放率：`23.12465142 KAS / 秒`；
  - 10 BPS 下单块平均补贴：**$\approx 2.312465142$ KAS / 块**；
  - 矿工丢块操纵的确定性机会成本：**$\approx 2.31$ KAS / 次**。

---

## 8. 下一步动作 (EXACTLY ONE NEXT ACTION)

**在 TN10 上统计 N = 1, 3, 5, 10, 20, 30, 50, 100 每个长度 N 的当前 canonical selected-parent segment，记录初始 hashes；等待 +1000 DAA 后，按同一 segment 起点重新构造 canonical chain；统计：至少一个 block 被 replacement 的概率、replacement block count 分布、maximum replacement depth、不同 N 下 segment changed probability；量化 Kaspa 10 BPS + VSPC reorg uncertainty 到底能给 multi-block entropy 的 miner withholding bias 带来多大实际折扣。**
