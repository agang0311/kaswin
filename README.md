# Kaspa Raffle Static

Kaspa Toccata 静态抽奖应用。网页构建产物是一个自包含的 `dist/index.html`，用户配置 Kaspa wRPC 节点并连接钱包后即可使用。

## V6 状态

- 只支持 `raffle-v6-aligned-batch-buy`，旧契约与旧 artifact 已移除。
- 深度 20 的 append-only Merkle tree，容量 1,048,576 张票。
- 同一个钱包可在一笔 covenant 交易中购买 1、2、4 或 8 张票；批量必须从对应的对齐边界开始。
- 1/2/4/8 张购票 required relay fee 均实测为 `0.014434 KAS`，应用提交 `0.015 KAS` covenant fee。
- 只有参与者可 Draw & pay；中奖者和调用者身份都由链上 Merkle proof 验证。
- 超时后任何人都能继续退款；退款先转入紧凑的 `RaffleRefundV1`，每笔退 8 张，最后 1-7 张逐张处理。
- `maxTickets <= 1000` 时，网页从 explorer 历史和浏览器缓存重建完整票集及 proof，不访问 raffle indexer。
- `maxTickets > 1000` 时使用可替换的独立 indexer；网页会再次验证 indexer 返回的 Merkle proof，indexer 不控制资金。
- Indexer URL 按 Mainnet / Testnet 10 分别保存在浏览器中。
- 创建、购票、加载、开奖和退款后的参与轮次保存在浏览器本地；刷新后可从 History 重新加载。
- 生产单 HTML 为 15,827,199 字节，只内联一份 Kaspa WASM；V5 构建曾为 31,293,467 字节。

## 安全边界

当前 Mainnet 随机数接口仍是 Schnorr Oracle 对 `sha256(ticketRoot || seed)` 签名。它能阻止普通调用者伪造结果，但 Oracle 可以在看到最终 `ticketRoot` 后尝试不同 seed，因此还不满足“任何单方都不能操控中奖号码”。

`OpChainblockSeqCommit` 只能证明调用者给出的 block hash 位于 selected chain，并读取该块的 sequencing commitment；它不能在 covenant 中证明该块就是创建时指定 DAA 的未来块。允许调用者任选 chain block 同样可以挑选结果，所以项目不会把这种方案标成安全随机数。

真实资金 Mainnet 发布需要唯一输出、可链上验证的随机信标，例如固定轮次的 threshold VRF / drand，并通过 Toccata ZK verifier 验证其 BLS/VRF 证明。完成该项和独立审计前，本项目仍是测试版。

## 网页开发

```powershell
npm install
npm run compile:contract
npm run verify
npm run dev
```

当前验证包括：

- SilverScript VM 的 1/2/4/8 张购票与未对齐拒绝用例
- finalize、refund transition、8 张批量退款与尾部退款
- 精确 Toccata compute / transient / storage mass
- 1,000,000 个不同 owner 的 Merkle replay、单票 proof 和 8 票 range proof
- Indexer crash recovery、确认队列和 selected-chain rollback fixture
- TypeScript、生产构建和单 HTML 内联

## 独立 Indexer

Indexer 是 `indexer/` 下的独立 Node 应用：

```powershell
cd indexer
npm install
$env:KASPA_NETWORK="testnet-10"
$env:KASPA_RPC_URL="ws://tn12-node.kaspa.com:18210"
$env:RAFFLE_INDEX_PORT="8787"
$env:RAFFLE_INDEX_DATA="C:\kaspa-raffle-index"
npm start
```

公开部署时应放在 HTTPS 反向代理后，并在网页的“抽奖索引 API”中填写其地址。接口包括：

- `GET /rounds`
- `GET /rounds/{roundId}/tickets/{ticketId}`
- `GET /rounds/{roundId}/owners/{pubkey}/proof`
- `GET /rounds/{roundId}/ranges/{firstTicketId}/8`

## 网络

- Mainnet wRPC 默认值：`ws://127.0.0.1:18110`
- Mainnet explorer：`https://api.kaspa.org`
- Testnet 10/TN12 wRPC：`ws://tn12-node.kaspa.com:18210`
- Testnet explorer：`https://api-tn10.kaspa.org`

`127.0.0.1` 仅在网页和节点位于同一台电脑时可用。HTTPS 页面连接本地节点还会受到浏览器 mixed-content 策略影响，实际部署通常需要 `wss://` 反向代理。

## 构建产物

```powershell
npm run build
```

发布文件位于 `dist/index.html`，可直接部署到 GitHub Pages、IPFS、Arweave、Nginx 或其他静态文件服务。

项目仍处于实验阶段。Mainnet 操作会花费真实 KAS；在随机信标和第三方审计完成前，不应将当前构建用于真实资金抽奖。
