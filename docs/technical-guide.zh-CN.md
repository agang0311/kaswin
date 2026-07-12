# Kaspa Raffle 技术指南

本文面向维护者、审计人员和钱包/节点集成人员，描述当前 `main` 分支的实际实现。原始产品规格 `kaspa_toccata_static_raffle_spec.md` 记录早期设计，不再是实现依据。

## 1. 当前能力与边界

- 单文件静态 React 应用，无项目方后端，构建产物为 `dist/index.html`。
- 支持 Mainnet 和 Testnet 10，网络、节点、钱包地址前缀会交叉校验。
- 支持 KasWare、Kastle；钱包私钥不会交给页面。
- 使用一个持续演进的 `RaffleRound` covenant UTXO 保存奖池和轮次状态。
- 支持每轮最多 1,000 张票、最多 20 个购买批次。
- 满票或超时后，任意购票参与者可以发起开奖；奖金由 finalize 交易直接支付。
- 超时后任何人都可以广播无钱包签名的全额退款交易。
- 历史记录由浏览器通过 Kaspa REST 索引器重建。

当前随机数方案是可公开推导密钥的开发 oracle，适合功能验证，不适合承载需要抗操纵保证的生产抽奖。主网入口存在是为了协议兼容和联调，不代表已经完成安全审计。

## 2. 系统结构

```text
Browser SPA
  |-- wallet adapter registry
  |     |-- KasWare (signPskt)
  |     `-- Kastle (kas:connect / kas:sign_tx)
  |-- Kaspa wRPC
  |     |-- UTXO 查询
  |     |-- DAA / node 状态
  |     `-- 交易广播
  |-- REST history indexer
  |     `-- registry + covenant 交易追踪
  `-- embedded covenant runtime
        |-- compiled Silverscript artifact
        `-- browser transaction builders
```

主要模块：

| 路径 | 职责 |
| --- | --- |
| `src/app/App.tsx` | 页面状态、操作编排、元数据和历史加载 |
| `src/app/i18n.ts` | 中英文文案、变量插值和运行时交易消息翻译 |
| `src/kaspa/networks.ts` | 网络注册表、默认节点、地址前缀 |
| `src/kaspa/rpc.ts` | 浏览器 wRPC 连接和节点状态 |
| `src/kaspa/wallet.ts` | 钱包 Adapter Registry |
| `src/kaspa/wallet-*.ts` | KasWare、Kastle 和仅开发环境测试钱包适配器 |
| `src/kaspa/transactions.ts` | create、buy、finalize、refund 交易构造与广播 |
| `src/kaspa/covenant.ts` | artifact、状态编码、redeem script 和签名脚本 |
| `src/kaspa/history.ts` | REST payload 扫描和 covenant lineage 追踪 |
| `src/contracts/raffle_round.sil` | 当前 Silverscript 合约源码 |
| `src/contracts/compiled/` | 当前及兼容旧轮次的编译产物 |

## 3. 网络与节点

默认配置：

| 网络 | wRPC | History REST | 地址前缀 |
| --- | --- | --- | --- |
| Mainnet | `ws://127.0.0.1:18110` | `https://api.kaspa.org` | `kaspa:` |
| Testnet 10 | `ws://tn12-node.kaspa.com:18210` | `https://api-tn10.kaspa.org` | `kaspatest:` |

测试节点 URL 沿用历史域名 `tn12-node`，但节点报告的 network id 是 `testnet-10`。兼容层会把旧元数据中的 `testnet-12` 归一化为 `testnet-10`。

连接时页面执行以下检查：

1. URL 必须以 `ws://` 或 `wss://` 开头。
2. 读取节点报告的 network id。
3. 节点网络必须与页面选择一致。
4. 钱包地址前缀必须与当前网络一致。
5. 钱包返回的 public key 必须能推导出所选地址。

本机主网节点需开放浏览器可访问的 JSON wRPC，默认端口为 `18110`，并启用 UTXO index。若页面与节点不在同一台机器，`127.0.0.1` 指向的是浏览器所在设备，需要在齿轮设置中填写节点实际地址，并正确处理防火墙与 TLS。

## 4. 钱包适配器

`KaspaWalletAdapter` 统一暴露：

- `isInstalled()`：检测钱包。
- `connect(network)`：请求账户并返回地址、公钥、签名函数。
- `readConnected(network)`：重新读取当前账户。
- `disconnect()`：断开应用状态。
- `subscribe(listener)`：监听账户或网络变化。

新钱包只需实现该接口并注册到 `src/kaspa/wallet.ts`，页面无需增加新的业务分支。生产构建只包含浏览器扩展钱包；本地私钥测试适配器仅在 Vite `DEV` 模式动态加载，不会进入 release HTML。

## 5. Covenant 状态模型

当前合约版本：`raffle-v3.3-participant-finalize-fee40`。

核心状态字段：

- `max_tickets`、`ticket_price`：轮次参数。
- `creator_pubkey`：carrier 退款接收者。
- `oracle_pubkey`：验证 oracle attestation。
- `refund_after_daa`：允许超时 finalize/refund 的 DAA score。
- `sold_tickets`、`sold_batches`：售票数量和批次数。
- `ticket_root`：按顺序累积的购票承诺。
- `batch_end_01..20`：每个购买批次的结束票号。
- `owner_01..20`：每个购买批次的 x-only public key。

使用批次而非每张票一个 covenant 输出，可以避免 UTXO 膨胀和 1,000 个 owner 状态字段。一笔 buy 可以购买多张连续票，但一轮最多有 20 笔 buy。

### Entrypoints

`buy(next_ticket_root, owner_pubkey, ticket_count)`：

- successor covenant 金额必须增加 `ticket_price * ticket_count`。
- 票数不能超过 `max_tickets`，批次不能超过 20。
- 更新 ticket root、batch end 和 owner。
- 通过 covenant binding 保持同一 lineage。

`finalize(oracle_sig, oracle_seed, winner_ticket_id, winner_pubkey, caller_pubkey)`：

- 必须满票，或交易 locktime 已达到 `refund_after_daa`。
- caller 必须出现在已记录的购买批次 owner 中。
- oracle signature 必须验证通过。
- 合约计算中奖索引，并验证 `winner_pubkey` 是该票所属批次 owner。
- 输出 0 支付完整奖池；输出 1 退还 creator carrier；输出 2 原额返还参与者授权 UTXO。

`refund_all()`：

- 只在 `refund_after_daa` 后有效。
- 按购买批次退还全部票款。
- 最后一个输出退还扣除 covenant fee 后的 carrier。
- 不需要钱包签名，因此任何加载了完整轮次状态的人都可广播。

`close()` 仍保留在 ABI 中用于旧版本兼容，但当前 UI 不调用。满票状态由 `sold_tickets == max_tickets` 判断，未满票轮次可在超时后直接 finalize 或 refund。

## 6. 交易生命周期

### Create

1. 页面生成 round id 和开发 oracle key。
2. 读取当前 DAA score，计算 `refund_after_daa`。
3. 钱包先创建临时 funding UTXO。
4. funding UTXO 创建 v1 genesis covenant output。
5. 另发一笔 registry marker 交易供历史扫描。
6. 默认 registry 是公开可花费的索引脚本，marker 扣除 0.01 KAS 后立即退回 creator；自定义 registry 不自动退款，5 KAS 留在目标地址。

### Buy

1. 读取当前 covenant UTXO，验证 redeem script 与本地 round 状态一致。
2. 钱包为票款与 covenant fee 创建临时 funding UTXO。
3. 同一交易消费当前 covenant 和 funding，产生 successor covenant。
4. 足够大的临时 funding 余额在该交易内直接退回钱包。
5. payload 记录票号范围、buyer、金额和新状态定位信息。

同一 covenant UTXO 不能被并发消费。如果两位用户基于同一旧 outpoint 同时买票，只会有一笔成功；失败方需从 History 重新加载最新 successor 后重试。目前没有自动重试，因为自动重放会重新触发钱包签名并可能掩盖用户看到的票号变化。

### Draw & Pay

1. 页面确认钱包属于购票参与者。
2. 重放全部票记录并校验 ticket root。
3. 生成或载入 oracle attestation。
4. 计算 winner 并构造 finalize 交易。
5. 钱包只签参与者授权 input；奖池 input 由 covenant 规则授权。
6. 单笔交易直接支付 winner、退 carrier、返还授权 UTXO。

### Refund

1. 页面比较实时 virtual DAA score 与 deadline。
2. History 必须已加载全部票和批次 owner。
3. 构造无钱包 input 的 `refund_all` spend。
4. covenant 在链上再次验证 locktime、每个 owner 和退款金额。

## 7. 金额、费用与 funding

页面统一显示 KAS；代码内部使用 sompi，`1 KAS = 100,000,000 sompi`。

| 项目 | 当前值 | 说明 |
| --- | ---: | --- |
| 默认/min carrier | 50 KAS | 满足当前 storage-mass 下限；结束时扣费后退 creator |
| registry marker transfer | 5 KAS | 发送到创建时指定的 Registry address |
| registry marker refund fee | 0.01 KAS | 仅默认 registry 自动退款时收取，预计退回 4.99 KAS |
| create covenant fee | 0.01 KAS | 从临时 funding 支付 |
| buy covenant fee | 0.06 KAS | 票价之外支付 |
| finalize covenant fee | 0.4 KAS | 从 carrier 扣除 |
| refund covenant fee | 0.2 KAS | 从 carrier 扣除 |
| 临时 funding 最小 reserve | 10 KAS | 降低 storage-mass 失败概率 |
| finalize 授权 UTXO | 至少 1 KAS | 原额返回参与者 |

钱包余额短时减少可能来自未确认交易、carrier 锁定、UTXO index 延迟或临时 funding。buy 的可退款余额若达到 1 KAS，会在 covenant spend 内立即作为输出返回；过小余额会并入费用以避免产生不可接受的小 UTXO。

Registry payment 本身还会产生由钱包输入数量和交易 mass 决定的网络费，该费用在构造交易后才能精确得到。页面在创建前明确标为额外可变费用，提交后在成功消息中显示实际值。自定义 Registry address 可以是当前网络的任意有效地址：若是创建者自己的钱包地址，5 KAS 仍由该钱包控制；若是第三方地址，则构成真实转账。

Compute budget 当前为 buy 400、finalize 2,500、参与者授权 400、refund 1,600。它们是 Toccata v1 交易 input 的预算单位，不等于交易费；实际 compute mass 由节点执行脚本后验证。

## 8. 随机数与信任假设

当前新轮次的 oracle private key 由固定域分隔字符串和 round id 确定性派生。任何加载该 round 的浏览器都可恢复该 key，因此 creator 不需要回来，参与者可自行 finalize。

这解决了“creator 消失导致资金锁死”的可用性问题，但不提供强随机性：知道派生规则的人可以预先计算 oracle seed 对结果的影响。生产方案必须替换为不可由单方操纵的来源，例如可信外部 oracle、阈值签名或可验证链上随机源。合约已经把 `oracle_pubkey` 固定在创建状态中，可在不改变 payout 约束的情况下替换 attestation 产生方式。

## 9. 历史重建

创建时向网络级 registry 地址写入 `round-register` payload。History scanner：

1. 查询该 round 创建时指定的 registry 地址的 full transactions。
2. 解析 `kaspa-raffle-static` JSON payload。
3. 获取 round 的初始 covenant 地址和 covenant id。
4. 沿 covenant output 的 spend 链追踪 ticket/finalize/refund。
5. 重放票批次和 ticket root，构造最新 cursor。

wRPC 主要提供 UTXO 和广播能力；完整历史依赖 REST indexer。REST 尚未索引最新交易时，页面可能短暂显示旧状态，刷新后恢复。当前 scanner 没有持久化 checkpoint，也没有显式 reorg 回滚策略，这是仍开放的 hardening 工作。

## 10. 编译与发布

安装依赖并构建：

```bash
npm install
npm run build
```

编译 Silverscript：

```bash
npm run compile:contract
```

验证：

```bash
npm run verify
npm run verify:covenant
```

`verify` 会执行 TypeScript、Vite、单文件内联、静态架构断言和 artifact 检查。`dist/` 最终只允许存在一个自包含 `index.html`，其中嵌入 JavaScript、CSS 和 WASM。

人工发布门槛见 `development-verification-loop.md`。真实网络回归至少跑三轮 create/buy/finalize，其中一轮必须从 History load 后再 finalize；主网验证默认只连接节点，不广播交易。

## 11. 已知风险与后续工作

- 开发 oracle 不具备生产随机性安全。
- 合约和交易构造器尚未经过独立安全审计。
- scanner 依赖中心化 REST 索引服务，缺少 checkpoint/reorg 恢复。
- covenant UTXO 天然串行，热门轮次会出现购买竞争。
- 最多 20 个购买批次；每批可含多张票。
- storage mass 和 relay 规则可能随网络升级改变，50 KAS carrier 不是永久协议常量。
- release HTML 虽可离线分发，但使用者仍应核对来源、版本和哈希。

## 12. 兼容性

`src/contracts/compiled/` 保留 v1、v2、v3 beta、v3.1、v3.2 artifact，用于加载或退款旧轮次。新代码不得用当前 state layout 强行解释旧 redeem script；`contractVersion` 决定选择哪个 artifact。旧的 creator-only oracle 轮次不能自动恢复 key，只能由原浏览器、外部 attestation 或超时 refund 处理。
