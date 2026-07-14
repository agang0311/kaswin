# Kaspa Raffle Static

单 HTML 的 Kaspa Toccata covenant 抽奖应用。网页直接连接用户配置的 Kaspa wRPC 节点；随机数、开奖条件和派奖金额均由链上 covenant 验证，不依赖 oracle、随机数服务或证明服务器。

当前 Mainnet/TN12 共用合约版本：`raffle-v13-chain-pow`。

旧 metadata 和旧合约不再兼容。

Mainnet Toccata 激活 DAA 为 `474165565`。页面连接节点后会读取实时 virtual DAA，只有达到对应网络的激活点才允许广播 covenant 交易。TN12 已完成四轮真实流程验证；当前合约也已在 Mainnet 连续完成三轮 create、buy、draw/pay，其中一轮覆盖刷新后从历史 load。三轮实际开奖费分别为 `0.040733`、`0.04319`、`0.040733 KAS`。

## 抽奖机制

每次购票都会更新同一个奖池 covenant UTXO 和深度 20 的票据 Merkle 树。售罄后，或达到可配置的超时时间后，任何人都可以直接执行一笔无需钱包签名的 `Draw & Pay`：

```text
boundary_daa = sold_out ? current_covenant_utxo_daa + 30 : refund_after_daa + 30
random_block = selected chain 中首个 daa_score >= boundary_daa 的区块
seed = SHA256(ticket_root || random_block_hash || chain_seqcommit)
winner = uint56_le(seed[0..7]) % sold_tickets
```

Covenant 在交易中重新计算目标区块及其选中父区块的 keyed BLAKE2b 哈希，验证 DAA 跨越关系，并通过 `OpChainblockSeqCommit` 确认目标区块属于当前选中链。售罄轮在最后一张票确认后才取未来区块；未售罄轮固定取销售截止后的未来区块，因此参与者无法在看到随机区块后追加购票重抽。

超时后购票入口会拒绝继续延长票链。触发者只提交链上区块 witness 和中奖票 Merkle proof；合约自行重算并强制唯一的中奖地址与金额。

### 安全边界

目标区块由售罄交易的 covenant UTXO DAA，或预先写入合约的销售截止 DAA 唯一确定。执行 `Draw & Pay` 不需要连接钱包，触发者只能广播公开 witness；合约会重新计算区块哈希、验证选中父区块和 DAA 跨越、读取链上 sequencing commitment、重算中奖票，并强制奖池输出地址和金额。因此创建者、买家、indexer、RPC 节点和开奖触发者都不能选择随机种子、替换中奖票或重抽；恶意服务最多拒绝提供数据，任何人都可以换节点或 indexer 后继续。

与所有仅使用 PoW 区块哈希的随机方案一样，拥有目标区块出块权的矿工理论上可以放弃发布自己挖到的区块，并承担丢失区块奖励和重新挖矿的成本。没有独立随机源、可信硬件或多方提交揭示时，无法从确定性区块链中数学消除这种 withholding 能力。当前模式选择“不增加服务器”，安全性因此建立在 Kaspa PoW 共识和目标区块不被单一攻击者经济性控制的假设上。

## 数据模式

- 最多 1000 张票：浏览器从 Registry 和 covenant 地址读取交易并在本地重建票据树，不需要 indexer。
- 超过 1000 张票：配置独立 `indexer/raffle-indexer.mjs`，由它保存票据树并返回中奖票 proof。
- 浏览器会在本地缓存参与过的轮次，刷新后可以从“加载历史”恢复。

Indexer 只索引公开交易和生成 Merkle proof，不参与随机数选择。

## 费用

- 创建 covenant：`0.003 KAS`
- 买票 covenant：`0.0175 KAS`
- 开奖并派奖 covenant：按完整链上区块头见证的实际 mass 计算（通常约 `0.05-0.06 KAS`，合约上限 `0.2 KAS`）
- Registry marker：默认 `0.05 KAS`，公开 Registry 会扣除 `0.001 KAS` 后自动退回
- Carrier 是可退还预留，不是手续费；派奖或完整退款时返还剩余部分

## 开发

```powershell
npm install
npm run compile:contract
npm run verify
npm run dev
```

`npm run build` 生成可直接发布的单文件 `dist/index.html`。Kaspa WASM 会以 gzip 形式内嵌并由现代浏览器原生解压，发布文件约 6.5 MB。

启动大规模轮次 indexer：

```powershell
$env:KASPA_RPC_URL="ws://127.0.0.1:18110"
$env:KASPA_NETWORK="mainnet"
npm run start:indexer
```

`indexer/` 也是一个可独立安装和容器部署的应用，详见 [`indexer/README.md`](indexer/README.md)。网页和 indexer 的节点、Registry、历史 API 及 indexer 地址均可独立配置。
