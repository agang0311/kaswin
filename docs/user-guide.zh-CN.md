# Kaspa Raffle 用户指南

Kaspa Raffle 是一个直接在浏览器运行的链上抽奖页面。购票、开奖、派奖和超时退款都通过 Kaspa 交易完成，项目方不保管你的钱包私钥。

## 使用前须知

- 建议先在 **Testnet 10** 试用。
- Mainnet 使用真实 KAS，目前版本未经独立安全审计。
- 只从可信的 GitHub Release 获取 HTML，并核对版本。
- 页面只会请求钱包签名，不应要求你输入助记词或私钥。
- 当前随机数是开发测试方案，不适合高价值或需要公平性保证的正式抽奖。

## 1. 打开页面并选择网络

点击左上连接栏的 **Network**：

- **Mainnet**：真实 KAS，默认连接本机 `ws://127.0.0.1:18110`。
- **Testnet 10**：测试 KAS，默认使用公共测试节点。

每一行右侧的齿轮可以修改节点地址。节点地址必须以 `ws://` 或 `wss://` 开头。

点击 **Connect**。显示 **Node ready** 后才能继续。如果提示节点网络与所选网络不一致，请切换正确网络或更换节点，不要忽略提示。

## 2. 连接钱包

点击 **Connect wallet**，选择 KasWare 或 Kastle。钱包扩展内选择的网络必须和页面一致：

- Mainnet 地址以 `kaspa:` 开头。
- Testnet 地址以 `kaspatest:` 开头。

连接后页面会显示缩短的钱包地址和余额。切换页面网络会自动断开当前钱包，需要重新连接。

## 3. 创建抽奖

在 **Create round** 标签中填写：

- **Ticket price**：每张票价格，单位 KAS。
- **Total tickets**：总票数，最多 1,000。
- **Draw / refund timeout**：超时时间，测试可设 10 分钟。

- **Registry address**：用于发布本轮索引 marker 的地址，必须属于当前网络。

Registry 区域会直接列出成本：

- 固定发送 **5 KAS** 到所填地址。
- Registry payment 另有一笔根据钱包 UTXO 计算的网络费，提交后显示精确值。
- 使用默认 Registry 时自动退回 **4.99 KAS**，退款交易费为 **0.01 KAS**。
- 使用自定义 Registry 时不自动退款，5 KAS 会留在目标地址；若填写自己的钱包地址，资金仍由自己控制。

点击 **Create round** 前，把鼠标放在按钮上可查看完整费用明细。创建会暂时锁定默认 50 KAS carrier。carrier 不是奖池，正常 finalize 或 refund 后会扣除 covenant fee 并退回创建者。

创建成功后保存分享链接。其他人也可从 **Load history** 找到该轮。

## 4. 加入已有抽奖

有两种方式：

1. 打开创建者分享的 round 链接。
2. 进入 **Load history**，点击 **Refresh history**，在下拉列表选择轮次，再点 **Load this round**。

加载后检查票价、剩余票数、奖池和超时时间。History 依赖索引服务，刚发生的交易可能需要等待几秒再刷新。

## 5. 购票

在 **Buy tickets** 标签选择数量，确认：

- **Total** 是票价总额。
- 按钮悬停提示会分开显示票价、covenant fee 和可变的 funding transaction fee。
- 钱包弹窗中的网络、地址和金额正确。

点击 **Buy** 并在钱包确认。成功后页面显示获得的连续票号范围。

如果多人同时购买，可能有人先消费了最新 round UTXO。此时你的交易会失败，资金不会成为有效票款；刷新 History、重新加载最新 round 后再试。

## 6. 开奖与派奖

满足以下任一条件后可以开奖：

- 票已售罄；或
- 已到达设置的 timeout。

只有买过本轮票的钱包可以点击 **Draw & pay**。页面会自动计算中奖票，并在同一笔 covenant 交易中：

1. 把奖池支付到中奖票所属钱包。
2. 把剩余 carrier 退给创建者。
3. 原额返回开奖参与者用于授权的 UTXO。

因此不需要创建者回来，也没有单独的手动 **Pay** 步骤。看到 **Paid in transaction** 才表示页面已获得派奖交易 id；随后刷新 History，状态应变为 **Paid**。

## 7. 超时退款

只有 timeout 到达后，**Refund after timeout** 才会启用。任何人加载完整轮次后都可以发起退款，不需要是创建者或参与者，也不需要钱包签名。

退款交易会按每个购买批次把全部票款退回原买家，并把扣除 refund covenant fee 后的 carrier 退给创建者。History 必须已加载全部票记录，否则页面会拒绝构造退款。

## 8. 为什么余额会暂时减少很多

页面为了满足 Toccata storage-mass 规则，会使用临时 funding UTXO 和较大的 carrier：

- 创建后，约 50 KAS carrier 会锁在 round covenant 中，结束时才退回。
- 默认 registry 会退回 4.99 KAS；自定义 registry 的 5 KAS 留在目标地址。
- buy 的临时 funding 找零通常在购票 covenant 交易中立即返回。
- 钱包或节点的余额索引可能有延迟，可等待确认后点刷新。

悬停所有会消耗 KAS 的按钮都能看到估算。以钱包最终签名页面为准。

## 9. 常见错误

**Node reports a different network**  
页面网络和节点网络不一致。切换网络或修改节点地址。

**Switch wallet to Mainnet/Testnet 10**  
钱包扩展所选网络错误。在扩展中切换后重新连接。

**Storage-mass minimum**  
轮次由旧版本创建、carrier 太小，或临时输出低于当前网络要求。刷新到最新版；旧轮通常需要重新创建。

**Compute budget / script units exceeded**  
旧轮次提交的脚本预算不符合当前构建。使用最新版；若是旧合约轮次，优先尝试兼容加载或超时退款。

**Only a wallet that bought tickets...**  
当前钱包没有参与本轮购票。连接买过票的钱包后再开奖。

**All ticket details must be loaded**  
页面没有完整票记录。刷新 History 并重新加载本轮。

**Round UTXO was already spent / transaction rejected**  
另一笔购票可能抢先更新了 round。重新加载后再购买。

## 10. 安全检查清单

每次签名前确认：

- 页面选择的网络正确。
- 节点地址可信。
- 钱包账户和地址正确。
- 票数、票价和费用符合预期。
- 不是在陌生页面输入私钥或助记词。
- 主网只使用愿意承担风险的小额资金。

遇到无法解释的签名内容时取消交易，保留错误信息、round id 和交易 id，再到 GitHub Issues 报告。
