# Kaspa Toccata Static Raffle

单 HTML 的 Kaspa Toccata covenant 抽奖应用。当前版本只接受 V8：

- Mainnet：`raffle-v8-drand-risc0-mainnet`
- TN12：`raffle-v8-drand-risc0-tn12`

旧 metadata、旧合约和 Oracle 私钥流程均不再支持。

## 随机数安全

`Draw & Pay` 首先广播无需签名的链上 `close` 转换，永久停止售票。目标 drand quicknet 轮次由 close covenant UTXO 的确认 DAA 分数唯一确定，并且位于 close 之后：

```text
drand_round = floor(close_utxo_daa / 30) + network_offset + delay
winner = uint56_le(SHA256(ticket_root || drand_randomness)[0..7]) % sold_tickets
```

Finalize 使用固定 RISC Zero guest image 验证 drand BLS 签名。证明服务只能提供证明，不能替换 image ID、轮次、随机数、票根或中奖号码。伪造或篡改证明会被 covenant 拒绝。

close 与 finalize 分成两个链上阶段是必要的：如果允许在信标公布后继续购票，买家可以改变票根并磨选结果。网页仍把两个阶段合并在同一个 `Draw & Pay` 流程中。

## 票据索引

- `maxTickets <= 1000`：网页从链上历史重建票据和 Merkle proof，不依赖独立索引器。
- `maxTickets > 1000`：使用 `indexer/` 独立应用，网页的 `Raffle index API` 可配置服务地址。
- 单笔购买支持 1、2、4 或 8 张同一钱包票据。
- 参加过的轮次、票据和最新 covenant 游标缓存在浏览器，可重新加载。
- 退款游标在链上；任何人在超时后加载最新状态即可从中断位置继续退款。

## 构建网页

```bash
npm install
npm run verify
```

发布文件是 `dist/index.html`，不需要 Node.js 或网页服务器即可打开。Node.js 只用于开发构建和可选的独立服务。

## 独立索引器

```bash
npm run start:indexer
```

默认地址为 `http://127.0.0.1:8787`。配置和持久化参数见 `indexer/README.md`。

## drand 证明服务

`beacon-prover/` 是独立 Rust 应用。它验证 drand quicknet BLS 签名，在 RISC Zero 中生成 succinct receipt，并按轮次缓存：

```bash
cargo run --release --manifest-path beacon-prover/Cargo.toml \
  -p kaspa-raffle-beacon-prover -- serve 127.0.0.1:8790 beacon-cache
```

网页可配置基础地址，也可使用含 `{round}` 的完整 URL 模板。首次请求尚未缓存的轮次时服务返回 HTTP 202 并后台生成；完成后 `GET /proofs/{round}` 返回证明 JSON。生产环境应使用 GPU、Bonsai 或等效的快速 RISC Zero prover，并启用 HTTPS。

## 验证

```bash
npm run verify:contract:v8
npm run verify:indexer
npm run benchmark:indexer:1m
```

Mainnet 使用真实 KAS。上线前仍需完成第三方 covenant 审计、真实 succinct receipt 质量测量，以及小额多轮链上测试。
