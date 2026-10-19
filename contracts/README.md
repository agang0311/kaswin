# 合约

当前合约 V2.0.2，Profile `ed0387c9e77bb4e0a8f1f4654a326c316d83663f455283ec6a046a095c94856d`。

| 文件 | 用途 |
|---|---|
| `open.sil` | 售票、封盘与空轮退出 |
| `sealed.sil` | 开奖付款与超时转退款 |
| `refunding.sil` | 分批退款与最终退出 |
| `ledger-layout.json` | KW21账本布局单一来源 |
| `artifacts/*-linked.sil/json/args.json` | 链接源码、固定编译结果与构造参数 |
| `pins.json`、`profile.json`、`artifacts/build-report.json` | 编译来源、模板哈希和合约身份 |

HTML构建通过 `scripts/contract/bundle.mjs` 加载这些文件，核对布局、模板、源码及Profile的一致性。它不重新编译SilverScript，也不读取测试报告。

固定编译器来源为SilverScript提交 `3ed973335b59269293564805cc2c58a14595ec03`。链接依赖顺序为REFUNDING→SEALED→OPEN。源码、链接产物与编译元数据共同确定身份，不能只修改其中某份文件或注释后继续沿用原Profile。

编译元数据只描述对应编译阶段，不代表后续测试或生产批准。更改合约须完成设计、重新编译与独立验证流程；网页构建只接受当前固定Profile。

状态、资金与授权规则见[架构说明](../docs/ARCHITECTURE.md)。
