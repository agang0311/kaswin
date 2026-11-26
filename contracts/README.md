# 合约目录

本目录存放 Kaswin Rolling 协议（`rolling-v1`）的五份 SilverScript 合约源码、模板输入、固定编译产物与身份固定文件，Profile 为 `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`；`kusdt-v2` 合约源码与产物位于 `kusdt-v2/` 子目录。

## 文件组成

- `{sales,sealed,win,refund,frozen}.sil`：五份展开后的固定 SilverScript 合约源码。
- `templates/`：模板输入 `{sales,sealed,win,refund,frozen}.sil.in` 与共用片段 `common.sil.inc`。
- `artifacts/{sales,sealed,win,refund,frozen}.json`：由固定 `silverc` 编译出的五份合约产物。
- `artifacts/template-pins.json`：按依赖顺序（`win -> refund -> sealed -> frozen -> sales`）固定的 `templateHash`。
- `pins.json`：候选 Profile ID、编译器版本与五模板源码/产物/模板哈希固定表。
- `toolchain.json`：SilverScript 1.0.1（提交 `a17db2c7c95cf9f12f8e1264b21f32a8552af8df`）工具链身份记录。

## 构建与重编

普通应用构建（`npm run build`）直接通过 `scripts/contract/bundle.mjs` 读取并校验本目录中的固定产物与 `pins.json`，不调用 `silverc`。

如需显式重新展开或重新编译合约，使用 `build/prepare-sources.mjs` 与 `build/compile-contracts.mjs`。说明见[开发说明](../docs/DEVELOPMENT.md)。
