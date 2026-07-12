# Kaspa Raffle Static

Kaspa Toccata 静态抽奖应用。生产构建是一个自包含的 `dist/index.html`；用户配置 Kaspa wRPC 节点并连接钱包后即可使用。

## V7 状态

- 只支持 `raffle-v7-three-commitment-oracles`，不加载旧合约或旧 metadata。
- 使用深度 20 的 append-only Merkle tree，每轮最多 1,048,576 张票；页面限制为 1,000,000 张。
- 同一个钱包可在一笔 covenant 交易中购买 1、2、4 或 8 张票，批量购买必须从对应的对齐边界开始。
- 创建 covenant fee 为 `0.003 KAS`，Registry marker fee 为 `0.0035 KAS`；1/2/4/8 张购票的应用 covenant fee 为 `0.0157 KAS`。发送前仍会按完整 Toccata mass 校验。
- 只有持票钱包可以 Draw & pay；中奖者和调用者身份都由链上 Merkle proof 验证。
- 超时后任何人都能启动或继续退款，不需要钱包签名。退款进度 `refund_cursor` 位于链上 successor covenant 中；换一台浏览器 Load 后也能从下一张继续。
- `maxTickets <= 1000` 时，页面从 explorer 历史和本地缓存重建票集与 proof，不访问 raffle indexer。
- `maxTickets > 1000` 时，页面使用可配置的独立 Indexer，并在本地重新验证 Indexer 返回的 Merkle proof；Indexer 不控制资金。
- Indexer URL 按 Mainnet/Testnet 10 分别保存在浏览器中。
- 创建、购买、加载、开奖和退款后的参与轮次会缓存在浏览器本地，刷新后可从 History 加载。
- 单 HTML 只内联一份 Kaspa WASM；当前构建约 15.8 MB，早期双 WASM 构建约 31.3 MB。

## 随机数安全边界

V7 在售票前把三个 Oracle 的公钥和 `SHA-256(seed)` commitment 写入 covenant。Finalize 必须同时提供三个固定 seed 及针对最终 `ticketRoot` 的 Schnorr 签名，中奖种子为：

```text
SHA-256(ticketRoot || seed1 || seed2 || seed3)
```

因此，任意一个或两个 Oracle 都不能在创建后替换 seed 或预知最终结果；只要至少一个独立 Oracle 在售票固定前保密且不串通，创建者、买家、开奖调用者和其余 Oracle 都无法选择中奖号码。Oracle 拒绝服务时，资金仍可在超时后由任何人退款。

这不是“零信任且无任何假设”的随机信标：三个 Oracle 若全部串通，仍可能提前泄露全部 seed 或集体拒签。生产部署必须由三个真正独立的运营者、域名、私钥和 master secret 提供服务。要消除该诚实方假设，需要链上可验证的 threshold VRF/drand 证明；当前 SilverScript/SDK 尚未提供本项目可用的该验证路径。

## 网络

- Mainnet Toccata 激活 DAA：`474165565`；默认 wRPC：`ws://127.0.0.1:18110`
- Testnet 10/TN12 Toccata 激活 DAA：`467579632`；默认 wRPC：`ws://tn12-node.kaspa.com:18210`
- Mainnet explorer：`https://api.kaspa.org`
- Testnet explorer：`https://api-tn10.kaspa.org`

页面在每次资金操作前读取节点当前 virtual DAA，并拒绝在激活高度之前构造 covenant 交易。`127.0.0.1` 仅在网页与节点位于同一台电脑时可用；HTTPS 页面连接本地节点还可能受浏览器 mixed-content 策略限制，公开部署通常需要 `wss://` 反向代理。

Mainnet 使用真实 KAS。主网部署还必须配置三个独立 Oracle，且应先完成第三方合约审计和小额分阶段测试。

## 网页开发

```powershell
npm install
npm run compile:contract
npm run verify
npm run dev
```

`npm run verify` 包括：

- 三方 Oracle commitment、seed reveal 与 root-bound Schnorr attestation
- SilverScript VM 的 1/2/4/8 张购票、未对齐拒绝、三 Oracle finalize 和篡改 seed 拒绝
- refund transition、8 张批量退款和 1-7 张尾部退款
- 精确 Toccata compute/transient/storage mass 与 relay fee
- 1,000,000 个不同 owner 的 Merkle replay、单票 proof 和 8 票 range proof
- Indexer 持久化、回滚、退款中断后 Load 续接及 proof API
- TypeScript、生产构建和单 HTML 内联

## 独立 Indexer

Indexer 是 `indexer/` 下的单独 Node 应用：

```powershell
cd indexer
npm install
$env:KASPA_NETWORK="testnet-10"
$env:KASPA_RPC_URL="ws://tn12-node.kaspa.com:18210"
$env:RAFFLE_INDEX_PORT="8787"
$env:RAFFLE_INDEX_DATA="C:\kaspa-raffle-index"
npm start
```

公开部署时应放在 HTTPS 反向代理后，并在网页的 Indexer 设置中填写地址。接口包括：

- `GET /rounds`
- `GET /rounds/{roundId}/tickets/{ticketId}`
- `GET /rounds/{roundId}/owners/{pubkey}/proof`
- `GET /rounds/{roundId}/ranges/{firstTicketId}/8`

## 三方 Oracle

分别在三个独立环境中启动 `oracle/` 应用，每个实例使用不同的私钥和 master secret。部署和接口见 `oracle/README.md`。

## 构建产物

```powershell
npm run build
```

发布文件位于 `dist/index.html`，可部署到 GitHub Pages、IPFS、Arweave、Nginx 或其他静态文件服务。GitHub Release 也应只附带该已验证 HTML 和独立服务的源码包。
