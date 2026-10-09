# V2 链外核心源码（目录暂保留 f3.2-core）

**当前核心与lib已对齐；验证范围见[当前发布入口](../../README.md)与[VM预算记录](../../docs/kaswin-v2/VM-BUDGET-20261009.md)。** 新Profile `7aaf76fe…`：fee绑定真实金额差，REFUND末输出绑定actor，TIMEOUT=432000 DAA。多输入解释缺金额上下文拒绝推进；移除忽略fee见证差异的旧导出。支持显式只读构建与TN10可交易验收候选；默认VM发布门仍BLOCKED，publicLaunchApproved=false。[新设计与结果](../../docs/kaswin-v2/CONTRACT-HARDENING-20261007.md)优先，旧Profile与历史执行结果不兼容／不继承。

这是 V2 **实际使用的14个模块的依赖闭包**，不是链上合约、完整通用SDK或钱包。`src/*.ts` 为源码，`lib/*.js`（及类型/映射）为 TypeScript 5.8.3 生成文件。

- `state`：账本、不可变域/状态、模板和快照检查。
- `protocol`：自家builder布局策略、采样、业务金额与暂定预算（不是所有合法链上交易的唯一形式）。
- `accepted`：**仅在调用者已建立selected-chain acceptance后**解释固定SIL状态转移；检查模板/根/SPK/金额/付款并区分辅助输出。不执行VM，不单独证明acceptance。
- `builders` / `transaction`：交易构建、完整性检查、txid。
- `pass-a`：接受上下文与排序承诺证明组装/核验。
- `artifacts`：编译artifact加载与Profile派生。
- `registry` / `genesis-discovery`：可选登记与创世候选识别。
- `bytes` / `hashes` / `blake3` / `covenant-id`：精确编码、哈希、谱系。
- `persistence`：浏览器CAS与同一readwrite事务内检查并插入意图；缺原子API禁止交易提交。

链上唯一强制规则来自[三合约](../../contracts/f3.2/README.md)及固定节点共识，不由此JS库或Indexer裁定。加密函数的离线差分测试不等于独立密码学审计。

```bash
npm --prefix apps/kaswin-v2 ci --ignore-scripts
npm --prefix apps/kaswin-v2 run check:core
```

检查器在内存中用固定TypeScript编译并逐字节核对提交的JS，拒绝源码/产物漂移。新增核心逻辑须重新审查合约/客户端一致性，不直接编辑`lib`。本轮改变Profile与三模板身份，ABI不变，Header228B。普通输入默认computeBudget=10，但核心Draft仍需计算最终mass/storageMass/fee与签名，不能把assertDraft当成relay或acceptance证明。删除当前闭包无调用的blake3KeyedNode重复实现；其它可能被外部使用的轻量导出暂保留。
