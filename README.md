# Kaswin

[中文](README.md) · [English](README.en.md)

Kaswin 是一个直接运行在浏览器中的 Kaspa Toccata covenant 抽奖系统。票款进入由合约约束的 Round UTXO，不经过平台托管账户；浏览器直接连接 Kaspa wRPC，创建、购票、开奖和退款均可在链上核验。

当前仓库版本为 **Kaswin 0.9.13**，适用且只允许新建/操作以下当前合约版本：

| 项目 | 当前值 |
| --- | --- |
| 协议版本 | `raffle-vnext-liveness-guard-b1000` |
| Round 合约 | `RaffleRoundVNext` |
| Refund 合约 | `RaffleRefundVNext` |
| Round artifact SHA-256 | `215aaae53f9a3d71fef0cf6deb8783582a36c212cd3bb9a67bedb7a850206f3d` |
| Refund artifact SHA-256 | `bd1a8f4c0be89a909a8565e06ab4379f85b8ad72e1a7620b2280404022c137e2` |
| 支持网络 | Kaspa Mainnet、Testnet 10 |

> v0.9.13 以预发布集成候选提供。当前 artifact 已完成本地自动门禁和一轮 Mainnet 创建、Registry、购票、售罄开奖闭环，但完整 Testnet A–E、Mainnet 退款闭环、KasWare/Kastle 与移动端 E2E、静态 HTTPS、干净环境复现和独立安全审计仍未全部完成。不要把预发布版本视为已审计的生产系统。

## 核心机制

- **非托管奖池**：票款直接增加 covenant UTXO，平台没有可以转走奖池的私钥。
- **两种安全结局**：达到最低票数后只能开奖；截止时未达到最低票数只能退款。零售票轮次可由任何人关闭，但 carrier 只能退回创建者。
- **买家承担退款网络费**：退款启动费和退款交易费从本次退款的购票款中扣除，触发者无需垫付 KAS。
- **链上随机性**：中奖票由预先确定的 Kaspa selected-chain 目标区块、ticket root、round nonce 和 chain sequence commitment 共同决定。
- **可恢复 Registry**：默认 Mainnet/Testnet Registry 净费用均为 0.01 KAS。页面发送中继安全的临时 0.20 KAS marker，确认后自动返回 0.19 KAS；钱包网络费另计。
- **单次签名清晰**：Create 与 Registry 各一笔钱包交易；Buy 将票款和 covenant successor 合并为一笔交易。每次签名前均展示网络、金额、地址、carrier 和预计费用。
- **公开可继续结算**：开奖、退款和空轮关闭不依赖创建者在线；进行中的低票数轮次可补充 carrier，但不能改变票数、截止时间或收款人。

## 容量与费用边界

一个 Round UTXO 会串行处理全部购买，因此“最多 1,000,000 张票”并不等于一百万个钱包可以同时下单。

- 每轮最多 `1,000,000` 张票。
- 每轮购买批次默认 `100`，covenant 硬上限 `1,000`。
- 页面建议值为 `max(1, min(1000, floor(售票秒数 / 6)))`。
- 当前最低票价为 `1 KAS`，确保单张票在退款费用上限下仍能形成可中继输出。
- 默认可退 carrier 为 `0.573 KAS`；开奖和合约执行网络费从 carrier 扣除。
- 默认 Registry 净费用为 `0.01 KAS`，Registry 钱包交易网络费另计并在提交后显示精确值。

购买批次越高，stale UTXO 冲突、排队时间和退款交易数量越大。大规模场景应使用足够长的售票窗口、合并购票，并部署可验证 proof 的 Indexer。

## 协议兼容性

合约版本是链上状态的一部分，不能用新的 artifact 猜测或花费旧 covenant：

- `raffle-vnext-liveness-guard-b1000`：v0.9.13 当前版本，可创建和操作。
- `raffle-vnext-liveness-guard`：0.9.12 历史候选，当前页面只读隔离。
- `raffle-v16-dynamic-refund-transition`：使用相匹配的 v0.9.7 历史 Release。
- `raffle-v15-arbitrary-batched-refund`、`raffle-v14-batch-range`：使用相匹配的 v0.9.6 历史 Release。

完整映射见 [合约兼容性](docs/contract-compatibility.md)。GitHub Release 说明和附件必须同时写明适用协议、Round/Refund 合约名及 artifact SHA-256。

## 当前网络证据

2026-07-20，当前 v0.9.13 Round artifact 在 Mainnet 完成了小额售罄闭环：

- Round：`round-66b8de553189543b`
- [Create](https://kaspa.stream/transactions/2f60ad3a3e7365b6f05ef574f06fe7a96c77501358a74260ac27dcd90e10c208)
- [Registry](https://kaspa.stream/transactions/941f12832684ab0474587e0a2c1ece4a9afe55af3764cef49d503c50ae94a617)
- [0.19 KAS marker 返回](https://kaspa.stream/transactions/f96d71580ee6b9fe84e0e6943564367996f01ebfef921aad056a73580d9cb578)
- [购买票 #1](https://kaspa.stream/transactions/e3fd0d3b23c78ceba685f80dac6ed30e1b3a4a9d9df3cb7f25ea39030049a762)
- [开奖并派奖](https://kaspa.stream/transactions/605df135a7adf9095ffabeafa8717c3768b44702b36e89bac4544b0118be39f9)

这证明当前 artifact 的 Mainnet 创建、索引、购买和开奖路径可以被网络接受，但不能替代尚未完成的 Mainnet 退款轮次、完整 Testnet 矩阵和独立审计。详见 [Mainnet 验证记录](docs/mainnet-validation-log.md) 与 [验证证据矩阵](docs/audit-evidence-matrix.md)。

## 本地运行

要求 Node.js 20+。建议使用锁定依赖：

```powershell
npm ci
npm run compile:vnext
npm run verify
npm run validation:local
npm run dev
```

生产构建：

```powershell
npm run build
```

输出的 `dist/index.html` 是包含 Kaspa WASM 的单文件页面。本地测试钱包私钥只从被 Git 忽略的 `wallets/` 或开发机环境变量读取，不会写入生产 HTML；不要将本地 Vite 开发服务暴露到公网。

可选 Indexer：

```powershell
$env:KASPA_RPC_URL="ws://127.0.0.1:18110"
$env:KASPA_NETWORK="testnet-10"
npm run start:indexer
```

Indexer 只索引公开交易并提供可验证 proof，不决定中奖者或资金去向。Registry、History API、Indexer、本地缓存和静态托管都不在结算信任边界内。

## 文档

- [用户指南](docs/user-guide.zh-CN.md)
- [技术指南](docs/technical-guide.zh-CN.md)
- [vNext 协议](docs/protocol-vnext.md)
- [验证要求](docs/validation-requirements.zh-CN.md)
- [验证证据矩阵](docs/audit-evidence-matrix.md)
- [Mainnet 验证记录](docs/mainnet-validation-log.md)
- [Testnet 验证记录](docs/testnet-validation-log.md)
- [Changelog](CHANGELOG.md)
- [GitHub 提交检查表](docs/github-submission-checklist.md)

## 安全提示

这是处理真实资产的 covenant 软件。正式使用前请自行核对 Release 的协议版本、artifact 哈希和 HTML SHA-256，并使用专用钱包和小额资金。发现安全问题时不要公开披露可利用细节，应先私下联系维护者。
