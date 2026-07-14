# 技术指南

## 当前架构

- 网页：React/Vite 构建后内联为单个 `dist/index.html`，直接连接用户配置的 Kaspa wRPC。
- 合约：`RaffleRoundV11` 负责购票与开奖，`RaffleRefundV2` 负责超时后可续执行退款。
- Indexer：`indexer/raffle-indexer.mjs` 是独立只读应用，只保存公开购买区间并生成 Merkle proof，不持有私钥、不签名、不生成随机数。
- 兼容策略：只接受 `raffle-v14-batch-range`，不解析旧 state layout 或旧 metadata。

## 购买区间树

深度 20 的 Merkle 树最多保存 1,048,576 个购买批次。每个叶子为：

```text
SHA256(owner_pubkey || uint64_le(first_ticket_id_zero_based) || uint64_le(ticket_count))
```

`ticket_count` 只能是 `1 / 10 / 100 / 1,000 / 10,000 / 100,000`。一百万张票可以由 10 个 100,000 张批次组成，也可以由一百万个 1 张批次组成；两者票数相同，但退款交易数量不同。

## 开奖

售罄时，随机边界是最终购票 covenant UTXO 的 DAA 加 30；未售罄时，边界是创建时写入的超时 DAA 加 30。客户端提供首个跨越边界的 selected-chain 区块及父区块，合约重算两个区块哈希并验证：

```text
seed = SHA256(ticket_root || target_block_hash || OpChainblockSeqCommit(target_block_hash))
winner = uint56_le(seed[0..7]) % sold_tickets
```

中奖 proof 同时提交购买批次下标、起始票号、数量和 owner。合约检查中奖票位于该区间，并强制输出 0 把全部奖池支付给 owner；剩余 carrier 扣除实际 mass fee 后退给创建者。开奖无需钱包签名。

## 退款

超时后，任何人都可以把 round covenant 转换为 refund covenant。退款状态同时保存：

- `refund_cursor`：已经覆盖的票数；
- `refund_batch_cursor`：已经完成的原始购买批次数。

每次 `refundNext` 验证一个原始购买区间 proof，只创建一个买家退款输出。调用者可中断；其他人 load 最新 covenant 后按两个链上游标继续。单个 100,000 张购买批次是一笔退款，但 100,000 个不同买家不能压成一笔 100,000 输出交易。

## 数据规模

- Registry 扫描发现的轮次始终显示，indexer 不可用不会隐藏大轮次。
- 本地缓存或链历史包含完整购买批次时，页面直接生成中奖和退款 proof，不受 `maxTickets` 影响。
- 只有完整购买批次不可用时，页面才从用户配置的 indexer URL 获取缺失 proof。
- Indexer 记录固定 80 字节：owner 32、交易 id 32、起始票号 uint64、数量 uint64；票号查询通过区间二分定位到购买批次。

目标区块查找先用创建交易的接纳区块校准 `DAA - blueScore` 偏移，再从现有历史 API 读取目标附近的有界候选集合。所有候选都会通过 wRPC 重新读取并验证 selected parent、DAA 跨越与区块哈希；历史 API 只优化查找速度，不进入随机数信任边界。若候选不可用，则回退到 wRPC selected-chain 查找。

## 验证

```powershell
npm run compile:contract
npm run verify
npm run benchmark:indexer:1m
```

当前 VM 门禁包含 100,000 张单输出退款、load 后从下一购买批次续退、错误 proof 拒绝和 round-to-refund 模板切换。Mainnet 广播还会检查官方 Toccata 激活 DAA。
