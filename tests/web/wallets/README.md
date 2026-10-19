# 测试钱包

浏览器实链测试用到的 TN10 钱包。**仅 Testnet 10**，绝不要放主网私钥。

## 文件格式

每个钱包一个 JSON 文件，四个字段：

```json
{
  "network": "testnet-10",
  "purpose": "Kaswin TN10 browser test only",
  "address": "kaspatest:qrg05u38z50weug9f8lcws7p07fzzvfsx9ap82f0akk4gxcs0ew86qd384xyt",
  "privateKey": "<64 位小写十六进制，无 0x 前缀>"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `network` | string | ✅ | 固定 `"testnet-10"`。地址前缀必须是 `kaspatest:` |
| `purpose` | string | ✅ | 用途备注，仅作文档，程序不校验 |
| `address` | string | ✅ | `kaspatest:` 开头的 P2PK 地址。必须与 `privateKey` 对应 |
| `privateKey` | string | ✅ | **64 位小写十六进制**（32 字节 Schnorr 私钥），不带 `0x` |

`privateKey` 长度必须是 64；多余字段会被忽略。

## 角色与文件名

默认三个角色，文件名在 [`../config/network.json`](../config/network.json) 的 `wallets.roles` 指定：

```json
"roles": {
  "creator": "tn10-test-only.json",
  "b1": "tn10-f3-buyer-1.json",
  "b2": "tn10-f3-buyer-2.json"
}
```

| 角色 | 用途 | 最低余额建议 |
|---|---|---|
| `creator` | 创建轮次、封盘、开奖、退款（这些动作 permissionless，但押金由 creator 出） | ≥ 100 TKAS |
| `b1` | 买家 1（并发场景的一方） | ≥ 100 TKAS |
| `b2` | 买家 2（并发场景的另一方） | ≥ 100 TKAS |

场景 5/6/7 需要数百笔交易，三个钱包合计建议 ≥ 1000 TKAS。

想换文件名或增加角色：改 `config/network.json` 的 `wallets.roles`，并把对应文件放进本目录。

## 建立钱包

### 1. 生成私钥

```bash
openssl rand -hex 32
```

### 2. 由私钥推导地址

用本目录的脚本，不要手算：

```bash
# 在工程根目录下执行
node tests/web/wallets/derive-address.mjs <你的64位私钥>
```

输出公钥、地址，以及可直接粘贴的钱包文件 JSON：

```
公钥:   d0fa7227151eecf10549ff8743c17f92213130317a13a92fedad541b107e5c7d
地址:   kaspatest:qrg05u38z50weug9f8lcws7p07fzzvfsx9ap82f0akk4gxcs0ew86qd384xyt
```

### 2.1 校验已有钱包文件

确认 `address` 与 `privateKey` 是否对应（不联网、不打印私钥）：

```bash
node tests/web/wallets/derive-address.mjs --check tests/web/wallets/tn10-test-only.json
```

```
✅ address 与 privateKey 匹配
```

不匹配时退出码为 1。

### 3. 写文件

复制模板并填入：

```bash
cd tests/web/wallets   # 在工程根目录下执行
cp WALLET-TEMPLATE.json tn10-test-only.json
chmod 600 tn10-test-only.json
# 编辑填入 address 与 privateKey
```

### 4. 领取测试币

TN10 水龙头：<https://faucet.kaspanet.io/>（选择 Testnet 10）。
或从已有测试钱包转账：

```bash
# 在工程根目录下执行
node tests/web/../../tools/send-tkas.mjs --help   # 若存在
```

## 安全要求

| 要求 | 说明 |
|---|---|
| 权限 | 文件必须 `chmod 600`，目录 `chmod 700` |
| 网络 | **只能** Testnet 10。主网私钥绝不可放入 |
| 提交 | 本目录已在 `.gitignore` 中；**不要**把真实私钥提交到仓库 |
| 日志 | harness 从不打印私钥，也不写入任何结果文件 |
| 复用 | 这是公开测试钱包，任何人拿到文件都能花掉里面的币；只放测试用零钱 |

## 校验

测试脚本启动时会读这三个文件。若目录或文件缺失，报错会列出尝试过的路径：

```
找不到测试钱包目录，试过: <工程根目录>/tests/web/wallets, ...
```

快速自检（不联网、不打印私钥）：

```bash
# 在工程根目录下执行
node --input-type=module -e "
import {W} from './tests/web/harness.mjs';
for (const [k, v] of Object.entries(W)) {
  console.log(k.padEnd(8), v.network, v.address.slice(0, 22) + '…', 'key=' + v.privateKey.length + '位');
}
"
```

期望输出：

```
creator  testnet-10 kaspatest:qrg05u38z50w… key=64位
b1       testnet-10 kaspatest:qqhgp2pqztuj… key=64位
b2       testnet-10 kaspatest:qzf372g3n7lf… key=64位
```

## 目录查找顺序

`config.mjs` 的 `walletDir()` 按顺序尝试：

1. 环境变量 `KASWIN_WALLETS`（绝对或相对当前工作目录）
2. `config/network.json` 的 `wallets.dir`（相对路径按 `tests/web/` 解析）
3. `tests/web/wallets`
4. `../../wallets`（相对 `tests/web/`）

命中第一个包含 `roles.creator` 指定文件的目录即停止。
