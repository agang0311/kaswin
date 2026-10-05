# F3.2 链外核心库

这是 V2 **实际使用的13个模块的依赖闭包**，不是链上合约、完整通用SDK或钱包。`src/*.ts` 为源码，`lib/*.js`（及类型/映射）为 TypeScript 5.8.3 生成文件。

- `state`：账本、不可变域/状态、模板和快照检查。
- `protocol`：链外状态转换镜像、采样、业务金额与预算。
- `builders` / `transaction`：交易构建、完整性检查、txid。
- `pass-a`：接受上下文与排序承诺证明组装/核验。
- `artifacts`：编译artifact加载与Profile派生。
- `registry` / `genesis-discovery`：可选登记与创世候选识别。
- `bytes` / `hashes` / `blake3` / `covenant-id`：精确编码、哈希、谱系。
- `persistence`：浏览器记录CAS接口。

链上唯一强制规则来自[三合约](../../contracts/f3.2/README.md)及固定节点共识，不由此JS库或Indexer裁定。加密函数的离线差分测试不等于独立密码学审计。

```bash
npm --prefix apps/kaswin-v2 ci --ignore-scripts
npm --prefix apps/kaswin-v2 run check:core
```

检查器在内存中用固定TypeScript编译并逐字节核对提交的JS，拒绝源码/产物漂移。新增核心逻辑须重新审查合约/客户端一致性，不直接编辑`lib`。本次没有升级协议或修改这些源码的行为。
