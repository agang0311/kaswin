# Kaswin V2 单文件交付（只读候选）

当前 `index.html` 对应新 Profile `7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8`，包含fee绑定、退款末输出约束、432000 DAA超时及前轮客户端安全修复。**仅编译，尚未运行单测／浏览器／VM／链上验证，未部署。**

`releaseMode=READ_ONLY_UNVERIFIED_CANDIDATE`，`tradingEnabled=false`，`budgetProfileId=null`。HTML包含永久双语提示；计划、执行、钱包签名及RPC提交入口均由构建常量禁用，无URL／localStorage／checkbox放行开关。源码开发接口并不等于发布授权。当前不能用于新轮次资金操作，更不是主网版本。

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` | 自包含只读候选；准确字节数与SHA256见同目录 `build-manifest.json` |
| `build-manifest.json` | 新Profile、三帧来源、构建输入SHA256、交易关闭及验证边界 |
| `../../dist/index.html` | 与上述HTML逐字节同步，被Git忽略，可重建 |
| `archive/6509ee1420003380484cc472763e2782a152e796a08874aa7fac5f4a3944e495-index.html` | 前轮206d4ec7…构建，315595字节，**含已知旧问题，仅归档，不作新版推荐入口** |
| `archive/fdd8e5320bd54110ba4621333ce0947bc1be89bb7273a858c5577d423a8e1c14-build-manifest.json` | 前轮HTML对应manifest，未改hash或标签 |
| `deployed-20261005.html` | 历史F3.2部署快照，SHA256 `335fbf0485369c0b924401b7cfb0243c1deb1e2b0e049d288cdb3a89f3168003`，原样保留；不是当前线上回读证据 |

## 离线构建

从仓库根运行（开发依赖须为已固定版本）：

```bash
npm --prefix apps/kaswin-v2 run check:core
npm --prefix apps/kaswin-v2 run check:bundle     # 仅内存编译
npm --prefix apps/kaswin-v2 run build:candidate  # 更新只读HTML、manifest及dist，归档之前文件
```

默认 `npm --prefix apps/kaswin-v2 run build` **仍被新Profile预算证据阻断**，没有改pin冒充测量。真正交易版本还需独立授权的VM、全部资源边界、浏览器、钱包和TN10验证，不应仅凭构建按钮开启。

## 使用边界

- 可以离线打开界面和规则；读取轮次/交易仍需节点和Indexer、CORS/Origin权限。此构建过程未访问任何节点。
- 新Profile不升级旧UTXO；旧轮次和UNKNOWN记录继续保留其原协议／原工具边界，不能在新Profile中重发。
- 远端Indexer仍为旧Profile，没有随文件生成而切换或部署；新页面不保证当前远端已支持新Profile。
- 不要随意更换Origin或清除IndexedDB；保留旧记录不是允许广播旧交易。

[合约Preflight、修复与编译结果](../../docs/kaswin-v2/CONTRACT-HARDENING-20261007.md)。
