# Bounded Directory BUY Append & SEALED Preservation Spike Report

- **状态**: DIRECTORY BUY APPEND PASS & DIRECTORY SEALED + WINNER OWNER PASS
- **候选基准**: `MAX_TOTAL_TICKETS = 100,000`, `MAX_PURCHASE_COUNT = 256`
- **记录规格**: 36 字节紧凑记录 (`u32 LE cumulative_end` + `[u8; 32] xonly_pubkey`)
- **满售目录尺寸**: $256 \times 36 = 9,216$ 字节

---

## 验证结论概览

1. **动态前缀 + 静态 Body 结构 (Dynamic State Prefix + Invariant Static Body)**:
   - 证明了无需在契约 Body 中硬编码任何由当前购买次数或目录长度衍生的可变偏移；
   - 唯一自引用参数 `STATIC_BODY_LEN` 通过确定性不动点收敛完成；
   - 在所有中间购买变迁中，`old_body_bytes == successor_body_bytes` 100% 成立。

2. **动态目录推送编码 (Canonical Directory-Push Encoding)**:
   - 实现了对 $0 \dots 18,432$ 字节任意目录长度的动态 TxScript push 编码（单字节直接推送、OP_PUSHDATA1、OP_PUSHDATA2）；
   - 成功解决了有符号 magnitude 编码跨越 128..255 字节时的位溢出问题。

3. **Tiny 推进全序列**:
   - $0 \to 1 \to 2 \to 3 \to 4$ 全部在 TxScriptEngine 中真实执行并通过。

4. **候选规模合法购买推进 ($N=128, 256, 512$)**:
   - 全部在 TxScriptEngine 中返回 `Ok(())`；
   - 经官方 `ComputeBudget::checked_covering_script_units` 计量并经 $B_{\min}-1$ 严格断言通过。

5. **Phase B: 最终购买 (Final BUY OPEN -> SEALED)**:
   - 购买达到 100,000 票后，契约强制转入 `SEALED` 状态；
   - `SEALED` 状态完整继承 9,216 字节最终目录和最终 `ticket_root`；
   - 消耗 85,986 SU，对应 $B_{\min} = \text{ComputeBudget}(8)$，并通过 9 项负例攻击拦截测试。

6. **Phase C: 无索引器全新浏览器数据恢复 (Fresh Browser Recovery)**:
   - 单凭链上确认的单一 `SEALED` UTXO 即可 100% 恢复全部 256 笔购买记录；
   - 客户端单机重算 27 层 SMT 根哈希，与链上承诺的 `ticket_root` 完全一致。

7. **Phase D: 中奖者归属直接索引 ($O(1)$ Winner Owner Lookup)**:
   - 无需 $O(P)$ 循环遍历，通过 TxScript `OpSubstr` 直接计算偏移 $offset_i = i \times 36$；
   - 首笔 ($i=0$)、中间笔 ($i=128$)、末笔 ($i=255$) 全部通过真实 VM 验证；
   - 执行消耗仅约 37k ~ 47k SU ($B_{\min} = \text{ComputeBudget}(4)$)，并通过 11 项负例攻击拦截测试。

8. **Phase E: 目录与随机数生命周期**:
   - 目录必须保留在 `SEALED` 与 `DRAW_READY(counter)` 中；
   - 仅当 `DRAW_READY` 成功 ACCEPT 某一计数器并直接锁定中奖者 P2PK 地址时，目录方可被安全丢弃。

---

## 最终裁决

```text
DIRECTORY SEALED + WINNER OWNER PASS

recommended V1 candidate:
    MAX_TOTAL_TICKETS = 100,000
    MAX_PURCHASE_COUNT = 256

NEXT:
    integrate frozen PASS-A randomness with directory-preserving SEALED/DRAW state
```
