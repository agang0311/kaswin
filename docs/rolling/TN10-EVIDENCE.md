# Testnet-10 实链证据（已终结轮次，含 256 笔分片边界与多分片）

范围：Candidate Profile `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`（仍为 `UNVALIDATED`），网络 `testnet-10`，节点为本机 `ws://127.0.0.1:18210`（2.1.0，synced，UTXO index）。部署范围与上限见 [TN10-DEPLOYMENT.md](TN10-DEPLOYMENT.md)。

- **accepted 的含义**：交易须出现在 selected chain 的接受集合中，并经 ≥100 DAA 深度复核；仅进块或 REST 回执不算。CLI 路径见 `tn10-run.mjs`，网页路径见 `web/rolling-tn10/controller.mjs`（先标“已出现在选中链”，深度 ≥100 后再次复核）。
- **mass/fee**：computeMass 取节点值；fee 为实际手续费，单位 sompi（1 TKAS = 100,000,000 sompi）。
- **来源与核对**：§1–§4 由 Gemini 3.8 Flash 子代理从各 run 目录的 `state.json` 整理，主会话已逐项对照原始 `state.json` 与运行日志：19 笔 txid 与 acceptingBlock 全部一致，acceptingDaa、feeSompi、computeMass、storageMass、transientMass 无差异；这四节的步骤序号从 0 起。§5–§6 与 TSV 流水由主会话脚本直接从 `state.json` 的 receipts 生成，步骤序号从 1 起（即 receipts 顺序；第 1 笔为 GENESIS）。
- **网页轮次差异**：`tn10-browser/payout-…` 由真实 Chromium 经 `https://<staging-host>/tn10/` 驱动，仅使用已授权的 creator 测试钱包；该目录没有 `*-receipt.json`，故无 quotedMass 对照，各步 `*-intent.json` 的预估值与节点 computeMass 一致。
- **不构成的结论**：这些是 TN10 上的实链终局：4 个小规模轮次（空轮、不足额退款、3 票开奖派奖、网页同流程）、2 个 256 笔分片边界轮次（`shard-payout`、`shard-refund`）和 2 个两分片轮次（`multi-payout`、`multi-refund`，515 票）；它们是有限场景的实链证据，不覆盖主网、外部钱包、TIMEOUT、共识边界专项实验（成熟度、双花、入池策略）、多买家/多执行者并发竞争、超过 2 个分片的 PAY_OLD 批次，也不把候选 Profile 升级为非 `UNVALIDATED`。本文件不构成生产可用结论。

## 1. empty-1794576685264（终局 EMPTY）

- **目录**：`./experiments/rolling/artifacts/tn10/empty-1794576685264`

| 步骤序号 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | computeMass（节点值） | storageMass | transientMass |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 0 | GENESIS | `0ef7df236e68a118a6aa7fb15a8f35e9045c0f521d0e7d38585abeb979dca73c` | `5d706f04fafdfe329e7f786857b6e41f4371fded19b2cb2f37a81c625ede695e` | 622405545 | 1000000 | 2199 | 10000 | 1876 |
| 1 | CLOSE | `8c3e25f5085dff11b47d8614861e5e395ba4e1afa6165c9ca81125ceb96a11ef` | `cd56c120ff87cbf2102928064a473edda496198126641d75232819db8036342d` | 622406682 | 1000000 | 6237 | 2489 | 14868 |

### 轮次总结
- **交易数**：2
- **累计 feeSompi**：2000000 sompi（0.02 TKAS）
- **BUY 数**：0
- **票数**：0
- **终局**：EMPTY
- **quotedMass 与节点 computeMass 对比**：一致（所有 receipt 文件中的 quotedMass.computeMass 与 nodeComputeMass 完全一致）

## 2. refund-1794576894993（终局 REFUNDED）

- **目录**：`./experiments/rolling/artifacts/tn10/refund-1794576894993`

| 步骤序号 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | computeMass（节点值） | storageMass | transientMass |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 0 | GENESIS | `4d5ba673ed589727dfa89bc9931fea05c684dd0d74386081f5aa4e7ff542cabf` | `139e648aba4fea403409404a6fcc58c2f264360951ed072b7fec69508ff2fd80` | 622407681 | 1000000 | 2199 | 10000 | 1876 |
| 1 | BUY | `356ddea83ef4bb769ff300b19bde6cdd6b6aedae7adfa7d3fedf3052293254e6` | `993e30b611cf881fd64e2e779a4ca843bc2358a05e56f88ad33a6000c23fc1f7` | 622419220 | 1000000 | 6718 | 7981 | 15152 |
| 2 | BUY | `b648c66562d188c66d491878cc158274960b9d2b8a63f39c6fe2be45634cffc9` | `da316bbbf81ffc5a9a67dc94335f03a4e1a7fdb4135b72ac005dde65493e017c` | 622839659 | 1000000 | 6755 | 5911 | 15300 |
| 3 | CLOSE | `5986141aec27166448ceb36b191bdcad99ed5f680c5d2040b9204ac298c97474` | `00c967299423f321fb10f56fa0ed489479d585b274c1df0b03c6ae6643d4cceb` | 622839788 | 2940600 | 19033 | 6655 | 58812 |
| 4 | REFUND_SELF | `01f84c24b0165353fa8f4982c14b99cce485fce06d12b92fda16e1f193ca17a1` | `fc9ed97531ff68137629bc4de6b6298f209d8981fd4b81d8746877a89158e14a` | 622839918 | 2300800 | 15444 | 22909 | 46016 |

### 轮次总结
- **交易数**：5
- **累计 feeSompi**：8241400 sompi（0.082414 TKAS）
- **BUY 数**：2
- **票数**：2
- **终局**：REFUNDED
- **quotedMass 与节点 computeMass 对比**：一致（所有 receipt 文件中的 quotedMass.computeMass 与 nodeComputeMass 完全一致）

## 3. payout-1794620372263（终局 PAID）

- **目录**：`./experiments/rolling/artifacts/tn10/payout-1794620372263`

| 步骤序号 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | computeMass（节点值） | storageMass | transientMass |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 0 | GENESIS | `9479e26ffe1e360b9c2fec1c4c5b369a09561cf957668eee4fe457a1b440798a` | `7a618238b9b32a87ff8eb415786536af915db599104ad3d4ff033032af4ac93d` | 622841976 | 1000000 | 2199 | 10000 | 1876 |
| 1 | BUY | `0b64db9c1dc6ebd23e0bcb4644bebc3f98a22d5e6a6f3ec1305631bd6ba1cc93` | `d7e22bf6e57f6ff29f4d42e689f02c07e980db14e6a6ca051c9dd8389bd0e771` | 622842105 | 1000000 | 6718 | 7981 | 15152 |
| 2 | BUY | `9609a517acd6055f00ba09734891e2bd597433158e852013ab399a8048ea3d1c` | `9b5d76087513691e0aa9e72052ef5e3b008673696c1b7b8492adbd1ab28632e4` | 622842233 | 1000000 | 6755 | 5909 | 15300 |
| 3 | BUY | `c1ad479132fc2b63322a342561199d54e1a2b3e898e4bf439f57d48506fcf7a7` | `e0f4727fca737348d1e17f435503fc70ad55560420beb98a3351b2f8c4c5fca2` | 622842353 | 1000000 | 6791 | 5695 | 15444 |
| 4 | CLOSE | `2dfcaa95bf763b746784b480da6ee4d7fa92fbc032131e546accc5114437a501` | `b8ee690e924180b02d14f11cf04c04bf5762a13ac5b63a0c2531dfce64e5a3e9` | 622842477 | 1449000 | 10375 | 5703 | 28980 |
| 5 | DRAW | `5542822cd8a465b8a58cddb394a1fff7251df8615ee468bc198630ddfae15927` | `c05a811aa6f845871f21de419812ba9851a724b248bfe3178e64059693a5e6ed` | 622842733 | 2937400 | 18717 | 5703 | 58748 |
| 6 | PAY_SELF | `b70a009d5331f4d89e0d31ef75a8a65ccc52437e83813437bfd34b379a5f0cca` | `2fea387a21502fabfa23a8113bb483d45cdfe728408ea3501f2d898a6b97f232` | 622842867 | 2197000 | 13565 | 11841 | 43940 |

### 轮次总结
- **交易数**：7
- **累计 feeSompi**：10583400 sompi（0.105834 TKAS）
- **BUY 数**：3
- **票数**：3
- **终局**：PAID
- **quotedMass 与节点 computeMass 对比**：一致（所有 receipt 文件中的 quotedMass.computeMass 与 nodeComputeMass 完全一致）

## 4. tn10-browser/payout-1794621168788（终局 PAID，网页 Chromium 全流程）

- **目录**：`./experiments/rolling/artifacts/tn10-browser/payout-1794621168788`

| 步骤序号 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | computeMass（节点值） | storageMass | transientMass |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 0 | GENESIS | `b6c4c8f666e79f3bad813836c2cc979e38c38ee0349479968e62ebb4bb3551d5` | `b97e547004ba2a8fa23fc525dd847a633750ae4f69baab0d402d650322361b96` | 622849307 | 1000000 | 2199 | 10000 | 1876 |
| 1 | BUY | `309f9625b4bfe3bc985a514c12ee388325feff54af3711086affd4e3adece553` | `419c7c68d07e8b24de3c20a6759c8c15da28d354d3fe90eaa1cd482113331d32` | 622849436 | 1000000 | 6718 | 5700 | 15152 |
| 2 | CLOSE | `4abf6cd81248cad25a0410b288f67d090be69fcd6f5b09255fd8deb808621246` | `12e35144878c8646eb8671942d0c6e31d69bf221646ec63398ab32e86fffd78f` | 622849602 | 1434600 | 10303 | 5700 | 28692 |
| 3 | DRAW | `a2435057ed374133447722f51d91e9d957adc6c8272dd9096255da06f08cb4b9` | `3c1d0722940edc4682fa5b8933888d127968e3dda91e898a505dcaf0ed0b97be` | 622850026 | 2923000 | 18645 | 5700 | 58460 |
| 4 | PAY_SELF | `fd6d8be4447b688430442c5539c67aabe8e1f98103d05571724cbcad3770291f` | `cd586d82c9372c762a9e048841b81b5866d686d36a362f5b3938e4d5b3c9e989` | 622850185 | 2182600 | 13493 | 11841 | 43652 |

### 轮次总结
- **交易数**：5
- **累计 feeSompi**：8540200 sompi（0.085402 TKAS）
- **BUY 数**：1
- **票数**：3
- **终局**：PAID
- **quotedMass 与节点 computeMass 对比**：MISSING（该轮为网页 Chromium 全流程执行，目录未持久化 `*-receipt.json` 单独文件，`state.json` 的 receipt 结构中亦缺 `quotedMass` 字段；补充说明：目录下各步 `*-intent.json` 中的 `mass.computeMass` 与节点值完全一致（均为 ['2199', '6718', '10303', '18645', '13493']））

## 4 轮合计汇总

- **交易数**：19
- **累计手续费**：29365000 sompi（0.29365 TKAS）
- **票数**：8

## 5. shard-payout-1794620571374（终局 PAID，256 笔分片边界）

- **目录**：`artifacts/tn10/shard-payout-1794620571374`；**CID**：`abbb49feae28ef356bbef3531a12139007218649ff477ba650438fe3fb44a20d`
- **流程**：256 笔 BUY → CLOSE → DRAW → PAY_OLD（第 256 笔购买冻结满片后依次收口、开奖、支付）。全程由 `tn10-run.mjs --execute --scenario=shard-payout` 一次跑完，没有 resume，日志中无 RPC_TIMEOUT / CURSOR_REORG / UNKNOWN / REJECTED / UNSENT。
- **交易数**：260（GENESIS 1, BUY 256, CLOSE 1, DRAW 1, PAY_OLD 1），全部 accepted；**累计 feeSompi**：451305516 sompi（4.51305516 TKAS）；**票数**：256。
- 逐笔流水（全部 260 笔）见 [TN10-SHARD-LEDGER.tsv](TN10-SHARD-LEDGER.tsv)。

分动作汇总：

| 动作 | 笔数 | fee 范围（sompi） | computeMass 范围 | storageMass 范围 | transientMass 范围 |
| :--- | ---: | :--- | :--- | :--- | :--- |
| GENESIS | 1 | 1000000 | 2199 | 10000 | 1876 |
| BUY | 256 | 1000000–3880692 | 6718–22251 | 0–10051 | 15152–54204 |
| CLOSE | 1 | 1434600 | 10303 | 9986 | 28692 |
| DRAW | 1 | 4865800 | 31159 | 9986 | 97316 |
| PAY_OLD | 1 | 4139600 | 27578 | 11927 | 82792 |

关键交易：

| 步骤 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | compute | storage | transient |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| 256 | BUY #255 | `6410912549bf8cc3b01c054df9e4ff2319a0f215509b96ee17253bc553c7a74c` | `2868600f88a52f1c70289baad1c8918c675696b77c26cee3a497bc63e7c206cf` | 622876988 | 2586800 | 19664 | 135 | 51736 |
| 257 | BUY #256（冻结） | `542517fdaeb08c300bac8849ab9c759c232409089b19dc62a0feb121b0898726` | `c5302decfb48ae0bbf7e1be0bb61b8c1d2cb1bddc4c7df5449734cb008158d41` | 622877118 | 2710200 | 22251 | 10051 | 54204 |
| 258 | CLOSE | `bd271c0023346575cb0c867fe006313ffec2a8a722b8c65b564168e0bd83118d` | `3f0db99f765f288d4817689ef7e7fe7b066c442e3703e340eef397e43ff653fe` | 622877236 | 1434600 | 10303 | 9986 | 28692 |
| 259 | DRAW | `4ab1ec07b0e4f6442506195e82f2fad2581548078d27fabbcff9f54abbbbb863` | `4b56031ee4012ce893e6c1fbc8f33c47926888a425f01989322770dc26fb3090` | 622877496 | 4865800 | 31159 | 9986 | 97316 |
| 260 | PAY_OLD | `f173ab95325818ae7500b61c1761b87ffa8544b780b67aee6da13797dc581851` | `2b8fb73cbabe41dffd6866fca3445ac2fdcc7d43fad913c0e3ae40d6989d4734` | 622877627 | 4139600 | 27578 | 11927 | 82792 |

## 6. shard-refund-1794623984454（终局 REFUNDED，256 笔分片边界）

- **目录**：`artifacts/tn10/shard-refund-1794623984454`；**CID**：`96479cdcaf28e73b0d81f650a7ae63abeefe216bcc6b77bbb0437d1f8c0e5d09`
- **流程**：256 笔 BUY → CLOSE → 8 批 REFUND_OLD（旧片分批退款）。全程由 `tn10-run.mjs --execute --scenario=shard-refund` 一次跑完，没有 resume，日志中无 RPC_TIMEOUT / CURSOR_REORG / UNKNOWN / REJECTED / UNSENT。
- **交易数**：266（GENESIS 1, BUY 256, CLOSE 1, REFUND_OLD 8），全部 accepted；**累计 feeSompi**：734642600 sompi（7.346426 TKAS）；**票数**：256。
- 逐笔流水（全部 266 笔）见 [TN10-SHARD-LEDGER.tsv](TN10-SHARD-LEDGER.tsv)。

分动作汇总：

| 动作 | 笔数 | fee 范围（sompi） | computeMass 范围 | storageMass 范围 | transientMass 范围 |
| :--- | ---: | :--- | :--- | :--- | :--- |
| GENESIS | 1 | 1000000 | 2199 | 10000 | 1876 |
| BUY | 256 | 1000000–2710200 | 6718–22251 | 0–10005 | 15152–54204 |
| CLOSE | 1 | 2933400 | 18997 | 9986 | 58668 |
| REFUND_OLD | 8 | 36034100–37363600 | 46933–48435 | 360341–373636 | 90772–91260 |

关键交易：

| 步骤 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | compute | storage | transient |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| 256 | BUY #255 | `047a05d7f730a37908bd37aea5e3f7b1a2ebee9a4051786142aa112c56b5b8b0` | `556229a33adfc3091bc07bd7351057cd958307a83834c5594c328341e9a34654` | 622911269 | 2586800 | 19664 | 135 | 51736 |
| 257 | BUY #256（冻结） | `d93536598886d898f379c1a3c09e25c7a78743ef031f83f7d7850d1da61d34f4` | `862bbce859dd22e57935eb71bcb18ca9034812fab058941aaa0ebbdb80a3e2e5` | 622911411 | 2710200 | 22251 | 10005 | 54204 |
| 258 | CLOSE | `5e02b064be17db6ec43e6325818d4713b67f117e38183100118472ab126df31f` | `6eb425ca5994ea04ce45b018c761e0d32530040dfe6ad7f80d3f596bb7821d24` | 622911549 | 2933400 | 18997 | 9986 | 58668 |
| 259 | REFUND_OLD | `cb5e0a3c9554cdb5a95dad32b55390fb3d9cc84699b3e6bdd2fa08c598e5bf56` | `c90c725fc47c509b47a1dfb5b07286f819f991bccb3a28624979d724b852d166` | 622911694 | 37363600 | 48335 | 373636 | 91260 |
| 260 | REFUND_OLD | `ace02dfaed70a43d108fc8f79f5d8e5b45324d874002a21af7ebe69c469a0d58` | `d47a77724f305d4cfc0116f5012d9bca7d9ab57ee71c5a5c8f430233d9b34f4f` | 622911833 | 37356900 | 48435 | 373569 | 91260 |
| 261 | REFUND_OLD | `546b3178fcdc36b6ec085937d0b228f38ef3557b01e50a326cb808390cd5c639` | `e71747ef944d6c232ea06eac7ba53bdd0c33c6a440a6f42d50765c2b2c5d94f7` | 622911967 | 37348200 | 48435 | 373482 | 91260 |
| 262 | REFUND_OLD | `73601d1bbd2e4d08379c2e4fef7c835f07dbe8724c68bfb2723755f11ca9cc80` | `1c8d6c30962b81a63f8dc2ef7e0d52659e7667fc5a655d1bfd7c8591dcddf4ed` | 622912104 | 37337300 | 48435 | 373373 | 91260 |
| 263 | REFUND_OLD | `7b5c66b3d145b5cbda600363f1cca8abd9af2c34788dabdbb499404e319f837d` | `7306b99e61cdc9d08d14c15d1be565813995b257935b43b1f2b4900513888e94` | 622912249 | 37321500 | 48435 | 373215 | 91260 |
| 264 | REFUND_OLD | `1a0db7b6dc1d9a77f3c056650143390041039e0288f3aa2073bb320d64741a93` | `03544c6af2d497c438feb4d85d31934dca33a2eb907a99088469affb34fed99b` | 622912392 | 37300700 | 48435 | 373007 | 91260 |
| 265 | REFUND_OLD | `be6c95fd9e4db65f946e37c3d4591a651343a7699125070a80409ae2e7a38b1b` | `41d7078580b5e7086cc4aedf1be549afa0aa64dce182f64abcb4160612312d18` | 622912524 | 37285900 | 48435 | 372859 | 91260 |
| 266 | REFUND_OLD | `eff2c35ffe4d2ab2568e5494290c92c1d62aa363e0ca8cd2c4770f82758e5a8a` | `c61491ab8fc9284535d768b080d4434b24354013ffe833e2978cd1c1fdc554cf` | 622912661 | 36034100 | 46933 | 360341 | 90772 |

## 7. multi-payout-1794631199294（终局 PAID，多分片，lane A）

- **目录**：`artifacts/tn10/multi-payout-1794631199294`；**CID**：`7b8ce7de69d86ed5cbb0bc188191770ced65645d02dc1b9adf51414c98ba0465`；**流程**：512 笔 1 票 BUY 冻结 2 个分片 + 1 笔 3 票尾单 → CLOSE → DRAW → PAY_OLD（k=2）→ PAY_SELF。
- **交易数**：518（GENESIS 1, BUY 513, CLOSE 1, DRAW 1, PAY_OLD 1, PAY_SELF 1），全部 ACCEPTED（含 ≥100 DAA 复核）；**累计 feeSompi**：884967400 sompi（8.849674 TKAS）；**票数**：515。
- **节奏**：前 46 笔在补丁前按“每步等 100 DAA”（deep-wait）完成，其余按 V2.0.2 候选衔接（candidate-chaining）完成；**重新接受**：26 笔 BUY 的接受块被浅层重组顶掉后在别的块被重新接受，接受 DAA 漂移 -4 到 +5，每笔最多 1 次，没有候选丢失。
- **钱包**：lane A = creator + buyer1（buyer2 的购买改由 buyer1 签；最初 22 笔交替签名发生在 lane 机制之前）。第 512 笔 BUY 冻结第二个分片，第 513 笔 BUY 买 3 张形成刚好 3 TKAS 的尾池，所以终局前走 PAY_SELF，不是尾池并入。PAY_OLD 一笔处理两个冻结分片。
- 逐笔流水（全部 518 笔，含节奏、重新接受次数、复核深度）见 [TN10-MULTISHARD-LEDGER.tsv](TN10-MULTISHARD-LEDGER.tsv)。

分动作汇总：

| 动作 | 笔数 | fee 范围（sompi） | computeMass 范围 | storageMass 范围 | transientMass 范围 |
| :--- | ---: | :--- | :--- | :--- | :--- |
| GENESIS | 1 | 1000000 | 2199 | 10000 | 1876 |
| BUY | 513 | 1000000–2717400 | 6718–22387 | 130–10135 | 15152–54348 |
| CLOSE | 1 | 1449000 | 10375 | 5700 | 28980 |
| DRAW | 1 | 4880200 | 31331 | 5700 | 97604 |
| PAY_OLD | 1 | 6118000 | 42780 | 10043 | 122360 |
| PAY_SELF | 1 | 2197000 | 13565 | 11841 | 43940 |

关键交易（所有非 BUY 交易，加两个冻结 BUY 与尾单 BUY）：

| 步骤 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | compute | storage | transient |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| 257 | BUY #256（冻结分片1） | `d02793365d9ebdc69756014d86878257e5cdce1530a6cc57ebbd83971235027d` | `747be00d4d6725b2734ba3d6b2f178685c9c1f0650725c42f60f66ea6acbed4c` | 622967147 | 2710200 | 22251 | 10135 | 54204 |
| 513 | BUY #512（冻结分片2） | `b0add4b150e5388f34477710c85711bbdc7cd4c20013982b98f1645bcf613145` | `3c0dd2c39c04117a4c1c23c569344a906d5d36d660a98ba2b6477a6aea794e74` | 622977298 | 2717400 | 22387 | 10132 | 54348 |
| 514 | BUY #513（3张票尾单） | `695b87517ed4bba2f1c77262f038984f7b8d0202f0f0ce493d7a249b0f4d0b82` | `cc2a5d379b2811cff4f860ce4ef7185c585848de1c1d710314de5cc835e4ce29` | 622977335 | 1000000 | 6791 | 5687 | 15444 |
| 515 | CLOSE | `531d9a9893bd6480690f3fefb306a91600adb93fa113f5daaf65d26d15dcb94d` | `01915da8b7bf0dbb2b4caf267c85aface4b6384ac97e1dbcec054d2e7f426697` | 622977363 | 1449000 | 10375 | 5700 | 28980 |
| 516 | DRAW | `3eec9aed3c00861c5362dd96bfb627cb777e971defcf30f8c341196f5d307c60` | `1f06e2e66072661f40712ce205d688f59e7a522dea0a29fefff345b920893d69` | 622977621 | 4880200 | 31331 | 5700 | 97604 |
| 517 | PAY_OLD | `cf56fe0ad12cfccc6edc5e998b00322a3f2107400f918b0e5a4f8af00b2b8dd6` | `a78fa443e779497fd374f0819850787c5a65718acd7ce27cbcdaece9be304a2e` | 622977672 | 6118000 | 42780 | 10043 | 122360 |
| 518 | PAY_SELF | `adb98be8b341e6c8816d8c5397b967af1bb0c8ec88fedc13977e5ac407dc6013` | `04c83fff72e769c0088ff3da683d87697b0e1b257fda310e0b9696ef833ef3a0` | 622977729 | 2197000 | 13565 | 11841 | 43940 |

## 8. multi-refund-1794631545757（终局 REFUNDED，多分片，lane B）

- **目录**：`artifacts/tn10/multi-refund-1794631545757`；**CID**：`345aac96681067d6be61ce4cd1e98e70aa34eba0bf0a40558961525666b1abee`；**流程**：512 笔 1 票 BUY 冻结 2 个分片 + 1 笔 3 票尾单，未达最低成团票数 → CLOSE → 16 批 REFUND_OLD → REFUND_SELF。
- **交易数**：532（GENESIS 1, BUY 513, CLOSE 1, REFUND_OLD 16, REFUND_SELF 1），全部 ACCEPTED（含 ≥100 DAA 复核）；**累计 feeSompi**：1464171800 sompi（14.641718 TKAS）；**票数**：515。
- **节奏**：前 19 笔在补丁前按“每步等 100 DAA”（deep-wait）完成，其余按 V2.0.2 候选衔接（candidate-chaining）完成；**重新接受**：27 笔 BUY 的接受块被浅层重组顶掉后在别的块被重新接受，接受 DAA 漂移 -3 到 +5，每笔最多 1 次，没有候选丢失。
- **钱包**：lane B = 全部角色都用 buyer2（创建者与所有买家为同一钱包），因此两个冻结分片的账本完全相同、脚本哈希也相同；这触发了下文的 `TARGET_VALUE` 缺陷（已修复），修复后 16 批 REFUND_OLD（每片 8 批，两片的 mass 序列完全一致）与 REFUND_SELF 全部通过。
- 逐笔流水（全部 532 笔，含节奏、重新接受次数、复核深度）见 [TN10-MULTISHARD-LEDGER.tsv](TN10-MULTISHARD-LEDGER.tsv)。

分动作汇总：

| 动作 | 笔数 | fee 范围（sompi） | computeMass 范围 | storageMass 范围 | transientMass 范围 |
| :--- | ---: | :--- | :--- | :--- | :--- |
| GENESIS | 1 | 1000400 | 2199 | 10004 | 1876 |
| BUY | 513 | 1000000–2717400 | 6718–22387 | 0–10538 | 15152–54348 |
| CLOSE | 1 | 2947800 | 19169 | 2308 | 58956 |
| REFUND_OLD | 16 | 36443000–36866600 | 48150–48507 | 364430–368666 | 91200–91548 |
| REFUND_SELF | 1 | 2297600 | 15068 | 2457 | 45952 |

关键交易（所有非 BUY 交易，加两个冻结 BUY 与尾单 BUY）：

| 步骤 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | compute | storage | transient |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| 257 | BUY #256（冻结分片1） | `39bca05382cff8804f40d43431c5380160336276aa2f39ff4ba03243286d07bd` | `9ffd23ec5857cc6748a10fe1a7cfedc28d0d499cfbd9d4d908d3f60f6703b897` | 622967552 | 2710200 | 22251 | 10224 | 54204 |
| 513 | BUY #512（冻结分片2） | `9f587572be4052c1315c8e396f84a769ffdbc3ba0c33bab4442d75d86723ea2d` | `67fbad6533bc4bbbc3253b5de5bf5deb51b4d4b3e5edd9fa2456f77ed676358a` | 622977586 | 2717400 | 22387 | 10538 | 54348 |
| 514 | BUY #513（3张票尾单） | `259caa74bb3cf0d5e6e2a9cb44d25eb68778c04ffbf3d6ba7f53d9870b93bfa8` | `0b377b48eb7a017989c5187be322a410c8278f89005940b372f885f31389d4ee` | 622977643 | 1000000 | 6791 | 1832 | 15444 |
| 515 | CLOSE | `f79ec16d6d14a722535622b9e0301aed8b0032dbb5e23511514398c4c3f26aab` | `c5afb874e807407719a0fcaa06f1f6cd164c384e9ba74835badff9d3b84b513d` | 622977675 | 2947800 | 19169 | 2308 | 58956 |
| 516 | REFUND_OLD | `a4e136959e13276ff743e709e67abe07ad93f2aa6317d193e58812d8c34cd8bc` | `04c83fff72e769c0088ff3da683d87697b0e1b257fda310e0b9696ef833ef3a0` | 622977729 | 36866600 | 48507 | 368666 | 91548 |
| 517 | REFUND_OLD | `9336077cd5e26891e7ed66cd7936102b8680fadaf8cee62bd87fc3ca612ea1c4` | `f929711a6c487e4991d07a26de279284771a66fa1235d432fac7ca4289179d80` | 622979188 | 36860400 | 48507 | 368604 | 91548 |
| 518 | REFUND_OLD | `d4a594a74fa8bbca04c0d4c2fbe4d650af19ce5efce3f23fda0a9bfb5657928c` | `604ad8ba6419ea30b33d20e1a6785af868920dd8ca1b4a23fca97067df760642` | 622979239 | 36852300 | 48507 | 368523 | 91548 |
| 519 | REFUND_OLD | `bc65663b248982aa9af2e73e440304c1e64607dbc2618e51a60a109657b5bdb1` | `d5222d6cbcc5621fdbc20aaa3b19b24ae39b2dcdb316d683c06b5a8cbf8249fc` | 622979307 | 36841900 | 48507 | 368419 | 91548 |
| 520 | REFUND_OLD | `5f21efccaaefa3324c704f8b071ba2d4c9cd345b0765380ad466e57d92458643` | `dc80534f40fddff50b102e5844bef961d2c36c7adff5f85f89754420f4ac4829` | 622979345 | 36827500 | 48507 | 368275 | 91548 |
| 521 | REFUND_OLD | `8e5f3bccdcb11547dfa1bdcfb5148f4b8da99956f804b35f2b2ffae60ebcc77c` | `ca7209cd84d3c42e882e5cdff1623796c77ebfed534fed437d227648aea917f9` | 622979391 | 36809200 | 48507 | 368092 | 91548 |
| 522 | REFUND_OLD | `bc88c7e7164c2a794f868d88b33c309d2590feecbc96c9e76c0d39072b726115` | `f05650112f9f8d358703cc2872f4787f275467faa4a46e266ae5650ce57d8df6` | 622979439 | 36800500 | 48507 | 368005 | 91548 |
| 523 | REFUND_OLD | `d35311e2c3f5488bcc7727eeca9cca29da24edee3ae951285750eb2bda9200ab` | `083bd6d4cae4585d034fc8655b951141b75edd018db9cfd5d02853451fed2ba3` | 622979499 | 36443000 | 48150 | 364430 | 91200 |
| 524 | REFUND_OLD | `001c5325ea3fe81fe68bfc461676d37b606365706dc0ba49a8c5e39a73ed63f7` | `417cab9bd9aac4ff87553740d9f6b4f3c9e4372772e68f3c058aec9331a89815` | 622979548 | 36866600 | 48507 | 368666 | 91548 |
| 525 | REFUND_OLD | `868a4f21fe71e5432e180b3f797dc04cb0ec3d03b9c3dc8d9dede938aa8b9cb8` | `dafff0fa930b60b8e924f037437b6299b27c98d05d0a03be9d2e8182b458e4ba` | 622979597 | 36860400 | 48507 | 368604 | 91548 |
| 526 | REFUND_OLD | `e95c558566a1c25271016076d14f3941b24ef2ad18d22c423bcbe8d7f1278736` | `f44f28e218d4773b078eccd72b5b3c7957e2e748dbaca322f9ab188052d66215` | 622979642 | 36852300 | 48507 | 368523 | 91548 |
| 527 | REFUND_OLD | `8a4b9eeea3d5e48eb096ef8523ab5746f173089c658eb60e572e8c97dd51cea4` | `2f2bc7fe0e5fe5e84172e242fa1eb74a3df6d074161e8c1cee482653cbc95c96` | 622979683 | 36841900 | 48507 | 368419 | 91548 |
| 528 | REFUND_OLD | `84d5de91897328be3ec6262c25bc9a69b0cd390fe7da5579ed92c95a03856436` | `e801493d63a8dd885c307e342b17e22198e73b0678f124c5d07ac3bd82c8658d` | 622979738 | 36827500 | 48507 | 368275 | 91548 |
| 529 | REFUND_OLD | `98949a8ac7acad7a54bb83c66caa6889a15b0be71b43584d4b91105c6e3d4e22` | `faf41f904d598ef96ea8d710c8b5d090f9a9d9160c2b669f46fa803e32235f6d` | 622979794 | 36809200 | 48507 | 368092 | 91548 |
| 530 | REFUND_OLD | `2a2cf24f22de8bcf922afe400846625cb6f4f736e6853f0a99b8d4cc97fd7465` | `2ef1e542a9530aeed2bb3fb3afbff225772a5b246de41fc25e80df23a29ff666` | 622979838 | 36800500 | 48507 | 368005 | 91548 |
| 531 | REFUND_OLD | `2f041ec4eafda622e12882a71d35f2fd00d1e5e07435e06c22d5c9c763d76bbc` | `afcac860a2a3b6913a4cf54dbab05e67c003706e7d0424916314b5588adf4c82` | 622979885 | 36443000 | 48150 | 364430 | 91200 |
| 532 | REFUND_SELF | `a4c0fe5f6982091b72552376cd010cbdb5832284f1fe893ef8334ff82b56916d` | `c2b86d046b77ee44dba4ba2bcb482f9a924c803a46ad21eabc27166333578260` | 622979925 | 2297600 | 15068 | 2457 | 45952 |

## 9. 零深度衔接与问题记录（multi-payout / multi-refund）

用户指出 V2.0.2 的流程不需要每步等 100 DAA。此后执行器改为：第一次选中链接受即为候选并立即发下一笔；候选在满 100 DAA 后重新核验才标 ACCEPTED。两轮的实链观测：

- **重新接受频率**：1050 笔中 53 笔（约 5.0%）的接受块被选中链尖端的浅层重组顶掉，同一份签名字节在别的块被重新接受，接受 DAA 漂移 −4 到 +5；全部是 BUY，没有 DAA 之外的内容变化，没有任何候选丢失。这是 V2.0.2 零深度衔接在 TN10 上的常态现象，不是偶发。
- **缺陷 1（执行器，已修复）**：第一版复核把“接受块不在链上”当致命错误（`FINALIZATION_FAILED`），且输入检查在重组窗口内抛出 `STALE_INPUT`（上一笔产出的 UTXO 暂时不存在，或其 DAA 与记录不符；具体是哪一种我没有逐次区分）。两个 lane 在同一次尖端重组前后各因此退出两次（先是 `STALE_INPUT`，续跑后是 `FINALIZATION_FAILED`），均发生在创建 intent 之前，没有在途交易，原签名交易用同一 txid 对账后被接受。修复：接受块不在链上时从 intent 游标重新搜索并校验新位置（旧位置保留在 `reaccepted`），刷新该交易产出 UTXO 的 DAA，输入检查允许 DAA 漂移（金额、脚本、covenant id 仍比较），准备阶段对 `STALE_INPUT` 有限重试；只有“既未被接受、又不在内存池满 3 分钟”才停止（`CANDIDATE_DROPPED`，本次未触发）。
- **缺陷 2（执行器与网页，已修复）**：目标分片只按脚本哈希匹配。当两个冻结分片账本完全相同（例如单一地址买满 512 笔 1 票）时，第一批 REFUND_OLD 后分片 0 的余额变小，旧逻辑会选到另一个余额更大的同哈希 UTXO，在交易构造器的 `TARGET_VALUE` 检查处被拦下（没有构造或发送任何交易）。修复：同时匹配脚本哈希与期望余额（`S.frozenValue`）。执行器的修复已经被 multi-refund 的 16 批实链退款验证；`web/rolling-tn10/prepare.mjs` 的同类修复（`pickTargets` 同时匹配哈希与期望余额）已由离线回归测试覆盖（两个共用脚本的分片，退款与派奖各一例），页面已重新构建；新版页面的实链走查见 §10。
- **网页同步改为 V2.0.2 节奏**：`web/rolling-tn10` 现在同样把首次被选中链接受的交易作为“候选”推进轮次（下一步可立即准备），满 100 DAA 后重新核对才标为已接受；接受块被浅层重组顶掉时重新搜索并记录，既未被接受又不在内存池（3 分钟宽限）则停止该轮次（`halted`）；准备下一步时排除候选已花掉的输入，并在存在候选时对 `STALE_INPUT` 有限重试。离线测试覆盖了这些路径（见 `VALIDATION.md`）；页面的实链走查见 §10。
- **未覆盖**：PAY_OLD 超过 2 个分片的批次、超过 16 个分片的多批 PAY_OLD（需要 ≥4352 笔购买以冻结至少 17 个分片）、多买家并发抢同一管理片、TIMEOUT（按用户决定不测）。

## 10. 新版页面（V2.0.2 节奏）的 Chromium 实链走查（`tn10-browser/candidate-1794635908003`，终局 PAID）

- **做法**：全新 Chromium 配置（空 IndexedDB），经 `https://<staging-host>/tn10/` 加载重新构建的 `dist/rolling-tn10.html`（sha256 `a90b892ac647ad6b9d3871137210448adfd7b60d2a5799f63a73a637b62f84f6`），连接本机 TN10 节点代理与预算服务，仅用 creator 专用测试钱包（内存钱包，读取后立即清空输入框）：GENESIS → 1 笔 3 票 BUY → CLOSE → DRAW（真实 PASS-A）→ PAY_SELF。
- **结果**：5 笔，全部 ACCEPTED（候选在满 100 DAA 后被页面复核提升，复核深度 ≥100，轮次结束时 `pending` 为空、无 `halted`），累计 feeSompi 8540200（0.085402 TKAS），票数 3。驱动脚本核对：私钥未出现在网络请求或落盘状态，无控制台异常。
- **节奏**：各步从点击发送到轮次推进的用时：起步 1.7 s, GENESIS 6.6 s, BUY 8.1 s, CLOSE 8.1 s, DRAW 40.2 s, PAY_SELF 7.7 s。DRAW 步骤包含协议要求的收口后等待（CLOSE 后 ≥100 DAA）与驱动脚本的 30 s 停顿；上一版页面同一流程总计约 2.3 分钟。
- **重新接受**：本次走查没有遇到重组（`reacceptedTransactions` 0）；页面的重组跟随、候选丢失停止等路径只有离线测试覆盖（见 `VALIDATION.md`），没有在页面上实链触发过。

| 步骤 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | compute | storage | transient | 复核深度 |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | GENESIS | `ebb346e3cb3c968e8a0770c04a3f67f71c62c40808bdb7a61ca2f1772c51dd57` | `71ff693c3bf02c1461e9c3c9018c86f948e4f070f6361a2bbc4fe7bea695cb66` | 622997252 | 1000000 | 2199 | 10000 | 1876 | 122 |
| 2 | BUY | `3314dbde57a002f5f9b523988661f4166c5ec00862c442c11ef0c8f43c2ba319` | `7293fb17fda724bd7ec234727b241dc3053f743c76830f4ca58b86ed36dfc3e2` | 622997328 | 1000000 | 6718 | 5700 | 15152 | 129 |
| 3 | CLOSE | `bd943f92fdf2d8d3b16b57f268e58a0874884a2e140e6998e3b1208594fc6969` | `cdcf8bbaa617d098a7fb51053b94c1be4abc3103254d5ee2c0b423b9004e4129` | 622997416 | 1434600 | 10303 | 5700 | 28692 | 113 |
| 4 | DRAW | `241d638f41eb043df5d6dce3612b8e94d2c651a58e76ef5ff7e618be80220e7c` | `95a04eda2dfccc9a10b6fb1045eb8b9a9143ba30b2c7e307f34db1bef26c3023` | 622997821 | 2923000 | 18645 | 5700 | 58460 | 121 |
| 5 | PAY_SELF | `80b5dffa32f63e468f5528c064efec3580536f81d17d4d0c0cf676d7332acc10` | `272877b2e3ed709b6e5609be3eead0f9265ba7f8899a480e0270dc7db4bd9eff` | 622997908 | 2182600 | 13493 | 11841 | 43652 | 113 |

## 11. 独立节点回放（`tn10-replay.mjs`）

对 `artifacts/tn10` 下的 7 个 CLI run（empty、refund、payout、shard-payout、shard-refund、multi-payout、multi-refund）逐笔向本机节点重新验证并重建归档索引：1590 笔全部 `revalidated: true`（2 + 5 + 7 + 260 + 266 + 518 + 532），无非 JSON 或错误输出，7 个轮次的快照写入 `artifacts/tn10-index/summary.json`，状态为 `NODE_REVALIDATED_SNAPSHOT_NOT_FINALITY`（节点重新验证的快照，不是终局性证明）。回放使用 state 中最新的接受位置作为提示，不以回执文件作为权威；被重新接受的交易按新位置验证通过。网页轮次（`tn10-browser/*`）不在回放范围内。

## 12. 两个买家同时抢购同一个管理片（真实页面，三个隔离的 Chromium）

2026-11-14，用户指示“预算就是钱包里有多少用多少”，要求实测双用户同时抢单（授权记录见 `TN10-DEPLOYMENT.md`）。做法：三个全新的 Chromium 配置（各有独立 IndexedDB），分别是 creator、buyer1、buyer2，均通过 `https://<staging-host>/tn10/` 使用页面、内存钱包（私钥读取后立即清空输入框）。creator 在页面里创建轮次（票数上限 10，最少 3 张，约 1 分钟后可关闭），用页面的“导出 round state”导出；buyer1、buyer2 用页面的“导入”导入同一份状态，各自准备 1 张票的 BUY，然后在同一个挂钟时刻点击“签名并发送”（两边相差 1–2 ms）。驱动脚本核对：私钥未出现在任何网络请求或 WebSocket 帧里，无控制台异常。

| 运行 | 页面构建 | 节点 | 结果 |
| :--- | :--- | :--- | :--- |
| `race-1794644751987`（cid `95da61ed…`） | `a90b892a…`（修复前）→ 中途换 `fbb28f3a…` | 三页同一本机节点 | buyer1 的 BUY `ebed2e15b10d919d7713de004b3c9e3cfb13327458158763bb99b5d64af56e5e` 被接受；buyer2 的 BUY `6c0176fa07ead7a06ad4c1f5d3f20f0d2d6102c602f2ac814508bd51b7b0c01f` 被节点拒绝：`submitTransaction: Rejected transaction 6c0176fa07ead7a06ad4c1f5d3f20f0d2d6102c602f2ac814508bd51b7b0c01f: output (9f8b828cad7b863e6347e98a5e45f88f12e791694a8e98c47db0436e9c32d197, 0) already spent by …`。败者页面**卡死**（见下）；修复后败者走完恢复，三张票两个买家，creator 导入最新状态后 CLOSE → DRAW → PAY_SELF，终局 `PAID` |
| `race-diffnode-1794645315173`（cid `10125025…`） | `fbb28f3a…` | buyer2 连公共节点 `quark-10`，其余本机 | buyer1 先被接受；buyer2 的页面流水线（签名、校验、读 3000 个 UTXO）在广域网上约 40 秒，发送前输入已被花掉，意图在**未发出**时因 `STALE_INPUT` 转 `UNSENT` 并被页面自动清除。**没有形成两个节点内存池各收一笔的真竞争**。该轮次停在 2 笔（GENESIS + 1 BUY），未收尾 |
| `race-1794645526814`（cid `71c28b54…`） | `872261a6…` | 本机 | 同 race-1：胜者 `1e4ab99b84db1a040e07bdd019a31a80538088839e4206de284ffaf1d78e2098`，败者被拒 `7af0950fb83d730fdeb46f86412f4b81113e8459756a1c107adb5785b76687b6`；败者放弃、导入、购买，赢家页面被提示状态过期后导入再买，共 3 张票；该轮次停在 4 笔，因创建者页面的“CLOSE 一直显示还差 N 秒”缺陷（见下）而未收尾 |
| `race-1794645737207`（cid `d015bb2a…`） | `db05501f…`（最终构建） | 本机 | 同上流程，败者被拒 `0bf78162ffbdaabf10a39f57b2320c8911338dcbc4abf3d6c3422767d1d90f44`，恢复后购买，creator 页面靠自动刷新等到 CLOSE 可用，CLOSE → DRAW → PAY_SELF，终局 `PAID`，7 笔全部 ACCEPTED |

**发现并修复的缺陷**（均为真实链上或真实浏览器里观察到的，修复后用最终构建重跑通过）：

1. **败者页面卡死**：节点拒绝后意图为 `REJECTED`，页面的“放弃”要求所有输入仍是未花费 UTXO，但管理片已被赢家花掉，必报 `STALE_INPUT`；而导入赢家状态又被 `IMPORT_WOULD_REPLACE_LOCAL_INTENT` 拦住，两条路都堵死。修复：先读输入、再做完整的接受搜索、再查内存池；输入“仍在且一致”或“已不存在”都允许放弃，“仍在但内容不同”仍然拒绝；放弃时提示本地状态已过期，需导入最新状态。
2. **动作可用性不刷新**：页面只在有待确认交易时每 8 秒刷新，候选被复核完之后不再刷新，按时间解锁的动作（CLOSE/DRAW/TIMEOUT）会一直显示“还差 N 秒”，直到用户点别的按钮。修复：空闲时每 8 秒刷新当前打开的轮次，输入框有焦点时不刷新（避免打断输入私钥）。最终重跑中 creator 页面没有任何人工触发就等到了 CLOSE 可用。
3. **SUBMITTED/UNKNOWN 的败者同样会卡死（仅离线复现）**：若败者的交易进了自己节点的内存池、竞争者的冲突交易却经别的节点赢了，败者停在 `SUBMITTED`，旧代码的“放弃”只接受 `REJECTED/UNSENT`。修复：此类意图在“有输入已被他人花费、不在内存池、从游标起的完整搜索未被接受、距创建满 3 分钟”时才可放弃。**这一路径只有离线测试覆盖，没有在真实链上触发过**（两次尝试都没能形成真竞争，见上表第 2 行）。
4. **陈旧状态的提示**：赢家页面在别人买过之后再准备购买会 `STALE_INPUT`，页面现在明确提示“本地 round state 可能已过期，请导入最新的 round state”。

**结论与限制**：同一节点上的同时抢购表现正确（一边被接受，另一边被明确拒绝，没有未知状态，没有重复扣款）。多用户共享一个轮次目前靠“导出/导入 round state”传递，败者和落后的页面必须重新导入才能继续，页面没有自己从链上追上最新状态的能力（需要 Indexer）。未覆盖：两个节点各收一笔冲突交易的真竞争、三个以上买家同时抢、公共节点上的快速流水线。

### 最终构建的完整轮次（`race-1794645737207`，终局 PAID）

页面构建 sha256 `db05501f07a3380f8fd15ad4657b71b09ef87e985976cb5cdf10d7c7b412e445`。buyer1 买 2 张（先抢到的一张和最后一张），buyer2 买 1 张（输掉竞争后重新导入再买），creator 收尾。累计 feeSompi 10583400（0.105834 TKAS）。

| 步骤 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | compute | storage | transient | 复核深度 |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | GENESIS | `986a12d214fc0bd123c78b0095f0f88de20ea7f4a78fc7408e567f0f2a2712fb` | `da497feb6b0a98474f901e5b4dfb12a0ec5d989542bf4eced4b22e219d38c25d` | 623095647 | 1000000 | 2199 | 10000 | 1876 | 125 |
| 2 | BUY | `10f0896726bac260708ecb247cfcaea2d2870a056bc1468420944670b4f317d9` | `c2db809b0304ab63628b8ff291c7e91a392916809e2351c206d3ba6ec4d5e0ec` | 623095757 | 1000000 | 6718 | 7973 | 15152 | 315 |
| 3 | BUY | `5346a92a4d5c76e61cb6770082301576e72a1cc1db5d2de363b08eecc6985d15` | `77fc49eae904cb686eeb51ba4641a6e699096caf0dc80f531dd0e751ba3666d6` | 623095876 | 1000000 | 6755 | 2866 | 15300 | 196 |
| 4 | BUY | `abb9a091a24bf0e890d67be17e63a1198a592d8c5a9a69e81dea9570cfe20972` | `f07ffddac9be38639f3b07be45d31a6007e305e1057e5cae7826b58da020a8c3` | 623095948 | 1000000 | 6791 | 5687 | 15444 | 124 |
| 5 | CLOSE | `303d1df6281f6fc2cf2d41bbd8bfd28718aee92c106530e1031d3f4d21ba4686` | `32183901a3658295ac24f0a2cef9643c16fc4c4d7a1eeaaa651dfdcbe1d0369c` | 623096260 | 1449000 | 10375 | 5700 | 28980 | 138 |
| 6 | DRAW | `9ca70a6f99907b39f1707d3d90858d470f240d51d2f254e3e983d5f879209295` | `25bc7f5a9a01f4235a9a53c11fabb1bde95e6d2f99a8b7db2a6b37db5aec41e0` | 623096988 | 2937400 | 18717 | 5700 | 58748 | 118 |
| 7 | PAY_SELF | `62faf7941ace6650505691ccc115ba0776960c4e444e5f823a64e3166fe3bc00` | `fa4d41bfe570c9b9d7b142ac0753092833caa7b4b32a603e5cd7428946fb0af6` | 623097070 | 2197000 | 13565 | 11841 | 43940 | 108 |

### 修复前的轮次（`race-1794644751987`，终局 PAID）

同一流程；败者恢复和收尾发生在第一次修复之后的构建上。累计 feeSompi 10583400（0.105834 TKAS）。

| 步骤 | 动作 | 完整 txid | acceptingBlock | acceptingDaa | feeSompi | compute | storage | transient | 复核深度 |
| ---: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | GENESIS | `9f8b828cad7b863e6347e98a5e45f88f12e791694a8e98c47db0436e9c32d197` | `b012e74ca4bf630dd14bfa158c525f20b4a4f38ebc6321e74a3fa65232ba537e` | 623085806 | 1000000 | 2199 | 10000 | 1876 | 186 |
| 2 | BUY | `ebed2e15b10d919d7713de004b3c9e3cfb13327458158763bb99b5d64af56e5e` | `dcf091795edfdb38b42c5e39b77a4a9c470c059c9adbbaf00ab9f666a4815bd2` | 623085897 | 1000000 | 6718 | 7973 | 15152 | 170 |
| 3 | BUY | `d6b159c7b31aec5186ff82b05eb96748cc4fe7cf1b08d500804bd42d22acc8cc` | `824b70cb17ee8db6b1360bb5443ea06a1532fcece930ed53bc563c492352602e` | 623087516 | 1000000 | 6755 | 2901 | 15300 | 666 |
| 4 | BUY | `713507cefb96b267fd3eb3afa9a16c351c1894f89348261f0c69ad22a164246e` | `78a10d9179d639876c244cdc11030bcd79b25d35455248d90ff36769cddf33de` | 623087589 | 1000000 | 6791 | 5687 | 15444 | 594 |
| 5 | CLOSE | `873d826cbbdd017512b2c2626cfca8eb771779a6b1c80708f0b2d4a4b657b400` | `2098a7aa2f0f87514e03b3e1510feb937020c2f9068e630e8b2b83e8ad902259` | 623088147 | 1449000 | 10375 | 5700 | 28980 | 174 |
| 6 | DRAW | `bac49fe769fba20599e122117ac939bb834b2e3f89b531adfa579cf5d3b72513` | `d0a454331c3449c11d9e5f6430ce432adc4c8f8510fd9955678066d2e6e22298` | 623088908 | 2937400 | 18717 | 5700 | 58748 | 134 |
| 7 | PAY_SELF | `6239ced027e086afdb433940fbe1203a539c72cd890992059ff666bb3317e084` | `708c38ef910309ed412337aabed3b54aba5bd7e5454e1d70afaba0140f00c041` | 623090624 | 2197000 | 13565 | 11841 | 43940 | 189 |

## 13. 浏览器套件场景 1（空轮）经本机节点（2026-11-15）

- **授权与范围**：用户 2026-11-15 明确同意“用真实交易验证本地节点”（只跑场景 1 空轮，约 0.02 TKAS）。仅使用 creator 专用测试钱包（`tests/web/wallets/tn10-test-only.json`，运行前余额 6,792.81184635 TKAS）；仅 Testnet 10。
- **运行**：`node tests/rolling-web/scenarios.mjs --scenarios=1 --node=wss://<staging-host>/tn10/node`，2026-11-15T02:42:28Z–02:44:01Z（92 秒）；页面构建 `8d002cd3c943c21899d46cd7eae081f39c462bc3edde9ca205dc8a308ee55bef`；节点为本机 `kaspad-tn10`（经 Caddy 反代）。归档：`tests/output/rolling-runs/2026-11-15T02-42-28Z-scenarios-1/`（`run.log`、`s1-final.png`、`profile-s1/`；`run.json` 不含 txid）。
- **结果**：页面终局 `EMPTY`，押金退回创建者；cid `193087e644d2a25ec042f90d60755b94bedb581f4adbe09a32745681e4be8639`。本机节点日志在 10:42:47 与 10:43:57（CST）各记一次 `in: 1 via RPC`，与下面两笔对应。

| # | 动作 | txid | 接受块（前缀） | 接受块 DAA | feeSompi | computeMass | storageMass | 核对时深度 |
| -: | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| 1 | GENESIS | `ba7113d623d35a6ca3acb71c19c99a534922f673060c44e7b6951178991b3648` | `c1b30bcb92…` | 623743609 | 1000000 | 2199 | 10000 | 1528 |
| 2 | CLOSE | `4df72000278e87b3412d114d19dc5f17b7d4a462d16f1301874018c2cf848492` | `c78770ffab…` | 623744287 | 1000000 | 6237 | 2486 | 851 |

- **接受状态怎么核对的**：运行结束后，用 `chain.mjs` 的 `acceptedAt` 对**同一个本机节点**做只读核对（无密钥、无交易）：两笔都在选中链的接受块里，深度均 ≥ 100 DAA。**不是独立节点的核对**，也不是终局性证明。页面在结束截图时 CLOSE 仍显示“确认中”（候选，深度未满 100 DAA）；`PASSED` 只代表页面走到了 EMPTY，不等于 CLOSE 已深度接受，上表是事后核对的结果。
- **未观察到的**：这次是首次使用 `8d002cd3…`（含双花冲突识别）的真实运行，但场景 1 没有并发，不会走到冲突分支；`selectFunds` 里 `getMempoolEntriesByAddresses` 的调用是否成功也没有被观察到（失败时按设计静默回退）。
- **一个细节**：该 profile 里保存的哈希中有一个已不在选中链上的区块（`45a59a85…`，DAA 623743584），时间上紧邻 GENESIS 的接受块，可能是一次浅层重组前的接受块；没有进一步追查。
- 这次运行**没有计入下面的“全实验合计”**（该表只含此前已登记的轮次，也不含 `tests/rolling-web` 更早的两次通过：场景 1 与场景 2）。

## 14. 同一钱包、两个页面的双花冲突（真实页面、本机节点，2026-11-15）

- **授权与范围**：用户 2026-11-15 明确要求“对双花交易这种情况进行测试”。仅用 creator 专用测试钱包（`tn10-test-only`，两个页面用同一把私钥，各自独立的 Chromium profile），仅 Testnet 10，经本机节点 `wss://<staging-host>/tn10/node`。页面构建 `75c0ca4c80696af29006498f29bd470ff17ac2568d5c82dda48463fd9af885fc`。脚本 `tests/rolling-web/double-spend.mjs`；归档目录见下。花费：**18 笔链上交易、0.18 TKAS 网络费**（每笔 0.01），1 笔被节点拒绝（未上链）；所有轮次都用 CLOSE 走到 `EMPTY`，保证金退回，结束时内存池里没有 creator 的交易、没有被合约锁定的 UTXO。
- **测试手段**：脚本只通过页面 UI 操作；阶段 2 在页面与节点之间放了一个只观察、不改写的 WebSocket 旁路（`routeWebSocket`，帧原样双向转发），用来取得 `submitTransaction` 的发出与应答时刻。节点侧的核对用只读 RPC（无密钥、无签名、无提交）。

### 阶段 1：两个页面同时发送（真实冲突）——`2026-11-15T02-55-44Z-double-spend`

两页各自先备好 GENESIS 报价（此时都选中同一个资金 UTXO `4df72000…848492:1`），再在同一时刻（点击时间差 0 ms）点“发送”。

| 项 | 结果 |
| :--- | :--- |
| 赢家 B 的 GENESIS | `4ebc9f9c75332e7dcf5ac75b6d409bbe90414f3db4ac0bc2779b6835166c9557`，被接受，不在内存池 |
| 输家 A 的 GENESIS | `154f394d8857c917892415bd59086d8edb4656473ab0b8bcf3f4c45bb7a79376`，状态 `REJECTED`，**节点只读核对：未被接受、不在内存池** |
| 节点原文 | `submitTransaction: Rejected transaction 154f394d…: output (4df72000278e87b3412d114d19dc5f17b7d4a462d16f1301874018c2cf848492, 1) already spent by transaction 4ebc9f9c75332e7dcf5ac75b6d409bbe90414f3db4ac0bc2779b6835166c9557 in the mempool`（与 `conflict.mjs` 假定的格式一致） |
| 页面识别 | 分类 `FUNDS_INPUT`；面板写“你钱包里的一笔资金已被另一笔还没确认的交易 `4ebc9f9c…6c9557` 占用…节点没有收下这笔，不会扣款”；**占用方交易 = 赢家的 txid**（面板、分类结果、赢家日志三处一致）；运行日志同样写出原因 |
| 恢复 | A 点“放弃这笔”，提示“等几秒、让前一笔确认后，重新操作即可”；约 5 秒后重新创建，第 1 次就拿到报价并发送成功，轮次可操作 |
| 收尾 | 两个轮次都走到 `EMPTY` |

### 阶段 2：A 发送后，B 在节点应答的瞬间去准备（预防）——`…02-55-44Z`（第 1 次）与 `2026-11-15T03-00-17Z-double-spend`（第 1、2 次）

A 的交易在内存池停留约 **1.8–2.3 秒**（应答后到该钱包的 `sending` 清空：2299、2025、1780 ms；`submitTransaction` 往返约 2 ms）；B 在 A 应答后 0 ms 点“创建”。三次 B 都拿到了正常报价、发送成功，没有冲突。**但没有出现“资金被占用”的提示**：该钱包有 522 个 UTXO（一个约 5815 TKAS 的大额加上很多约 4 TKAS 的小额），排除了 A 占用的大额之后，B 凑了别的小额。要确认这是“排除生效”而不是“碰巧”，对后两次从节点读了四笔 GENESIS 的真实输入（修正后的分析在 `03-00-17Z` 的 `result.json` 的 `genesisAnalysis`）：

| 次 | A 的 GENESIS 花了 | B 的 GENESIS 花了 | 旧算法（最大的先选）此刻会选 |
| -: | :--- | :--- | :--- |
| 1 | `ea5cba91…:1` = 5815.6352 | `b22cd69f…:1` 4.1576 + `5277e438…:1` 4.0000 | `ea5cba91…:1`（= A 花的那个） |
| 2 | `8a52f805…:1` = 5811.6052 | `9ae8869d…:1` 4.1476 + `f173ab95…:1` 4.0000 | `8a52f805…:1`（= A 花的那个） |

两次里 A 花的都是旧算法的首选，B 都**没有**用它，两笔交易的输入完全不相交。这与“B 选资金时看到了内存池里 A 的占用并避开”一致；旧算法在同样的时刻会选中同一个大额，也就是阶段 1 的冲突。没有做“用旧版页面重放同一时序”的对照实验，所以这是由选择结果推出的，不是直接对照。

### 阶段 3：B 用早先备好的报价，在 A 已被确认之后才发送——`2026-11-15T03-06-55Z-double-spend`

A 的 GENESIS `94254d37257bc384ad8bbd6be2afd0dcb88da1a1ba1d5b27aa93f17859c17df7` 被接受并离开内存池后，B 用旧报价点发送。**页面在发送前的“输入仍有效”检查里就拦下了**：日志 `提交未发出：STALE_INPUT（状态 UNSENT）`，没有任何东西到达节点；界面只弹出“交易没有发出，请重试。”。B 的本机没有留下这个失败的轮次记录（“已知轮次 0”），没有可放弃的悬空意图。

### 没有覆盖到的

- **“资金被占用”（`WALLET_FUNDS_PENDING`）的提示没有在真实节点上出现过**：需要钱包里除被占用的以外再没有够用的资金，而测试钱包有大量小额。该分支只有离线测试（`controller.test.mjs`）覆盖。
- **`ORPHAN` 分类没有在真实节点上被触发**：阶段 3 说明，输入已被已确认交易花掉时页面会在发送前自己拦下（`STALE_INPUT`），不会走到节点的孤儿拒绝；§16 里“孤儿来自公共节点前端的负载均衡”的说法仍是未证实的推测。
- 阶段 2 的“内存池停留时间”只有 3 个样本，且都发生在这一个节点上。
- 只测了 GENESIS（创建）这一种动作的**钱包资金**冲突；**轮次的管理 UTXO（`ROUND_INPUT`）冲突见下一节（§15）**。
- 脚本本身的两个错误已修：阶段 2 早期版本取的是 CLOSE 的 txid 而非 GENESIS（已在 `03-00-17Z` 的 `result.json` 里更正），事后核对的起点区块选成了链尖而被重组掉（现在沿选中链回退 300 个块）。第一次运行的阶段 2 第 2 次在开浏览器阶段被我中止（尚未发送任何交易）。

## 15. 轮次自己的 UTXO（管理 UTXO）被双花：两个买家同时对同一轮操作（真实页面、本机节点，2026-11-15）

- **范围**：用户指出前一节（§14）测的是钱包资金输入，不是“轮次的 UTXO 被双花”，要求测后者。这里两个买家用**不同的钱包**（`tn10-f3-buyer-1`、`tn10-f3-buyer-2`；创建者 `tn10-test-only`），资金输入不会冲突，冲突只可能出在轮次的管理 UTXO 上。三个专用测试钱包、仅 Testnet 10、经本机节点；页面构建 `75c0ca4c80696af29006498f29bd470ff17ac2568d5c82dda48463fd9af885fc`。脚本 `tests/rolling-web/round-double-spend.mjs`（只通过页面 UI 操作；节点侧核对用只读 RPC）。
- **花费**：5 次运行合计 **0.3595 TKAS 网络费**（三个钱包的余额差之和，与各轮次累计网络费之和 0.3596 一致）；票款与保证金都已退回；5 个轮次都走到终局（4 个 `REFUNDED`、1 个 `EMPTY`）；结束时三个钱包的内存池里都没有待确认交易。
- **做法**：创建者开一轮（cap 5、最低 5 张）并导出状态，买家 A/B 各自“加入轮次”；两人各自备好“买 1 张”的报价（此时都基于同一个管理 UTXO），同一时刻（点击时间差 0–3 ms）点“发送”。

### R1：同时发送（真实冲突）

**4 次运行里的 4 次**，节点都是收一笔、拒一笔，页面都识别为 `ROUND_INPUT`；四次的检查项全部成立：分类 `ROUND_INPUT`；占用方交易 = 赢家的 txid；被争输出是赢家那笔交易的**第 0 个输入**（管理 UTXO；由节点返回的已接受交易核对）；被争输入带合约标记；面板与运行日志都写出原因；被拒的那笔没有被接受也不在内存池（做了该核对的 3 次）。

最后一次（`2026-11-15T03-48-21Z-round-double-spend`，完整通过）：

| 项 | 内容 |
| :--- | :--- |
| 赢家的 BUY（B） | `c342d3e3c57624a1eb56ec4c8f203ff4b1737e779be2aaca6d81026478e9c8f3`，被接受 |
| 输家的 BUY（A） | `fe97628c35784899e8a9905fd74649205fdb2285c3dc6e68596dbfab607513dc`，状态 `REJECTED`，节点只读核对：未被接受、不在内存池 |
| 节点原文 | `submitTransaction: Rejected transaction fe97628c35784899e8a9905fd74649205fdb2285c3dc6e68596dbfab607513dc: output (e8f2d3396f33cff440630d7fcb51755c0df39a43677b5fc7140b956d3d59635b, 0) already spent by transaction c342d3e3c57624a1eb56ec4c8f203ff4b1737e779be2aaca6d81026478e9c8f3 in the mempool` |
| 被争输出 | `e8f2d3396f33cff440630d7fcb51755c0df39a43677b5fc7140b956d3d59635b:0`，即赢家 BUY 的第 0 个输入（管理 UTXO） |
| 输家页面显示 | “这笔交易被节点拒绝：购买票。这一轮的合约输出已被另一笔还没确认的交易 `c342d3e3…e9c8f3` 占用，说明别人抢先操作了同一轮。节点没有收下这笔，不会扣款。请放弃这笔，再用「加入轮次」导入对方发来的最新分享链接。” |
| 恢复 | 放弃（提示“已放弃这笔交易。请导入最新的分享链接后继续。”）→ 导入赢家导出的最新状态 → 重新买 → 发送成功，交易 `2be9899b90d0952d793a827618943876c1dc6b132000003500d23964c56db93a`，其第 0 个输入正是**赢家那笔 BUY 的输出**（链上核对） |

### R2：旧报价在对方被确认之后发送

两页都同步到最新状态并备好报价；一方先发，`0e69bf33a4117135b0ad406235e382d24f08b1bbc1f4f7a28fc02a69b05f9f20` 被接受，其第 0 个输入是上面“输家重新买”那笔的输出；另一方随后用旧报价发送：**页面在发送前的核对里就拦下了**（日志 `核对链上状态失败：STALE_INPUT`、`提交未发出：STALE_INPUT（状态 UNSENT）`），没有任何东西到达节点；那笔未发出的交易 `71643a7f42fee67dc2cdd648436444557c08b52e2884306d5207cec25fd4ce7c` 经节点核对既未被接受也不在内存池。用户看到的是提示“交易没有发出，请重试。”以及轮次页上的“与链上状态不一致：这一轮的状态已被别人推进，本机记录已过期。请让对方发给你最新的分享链接，再用「加入轮次」更新。”——**这条说明对轮次冲突是准确的**。页面没有留下悬空的意图。

### 发现的问题与脚本缺陷

- **页面（未改）：忙的时候点击被静默忽略。** `onAction` 开头是 `if(ctl.state.busy||modalOpen())return;`，没有任何提示；而按钮在下一次渲染前仍显示可用。导入别人的最新状态之后，页面会在后台复核对方那笔交易（日志里“已接受并复核（深度 116≥100）”），这时点“购买”没有反应。在 3 次带点击计数的运行里，**导入之后的第一次点击都没有弹出报价，第二次才弹出**（其余各处的首次点击都立即弹出）；第 1 次运行没有重试，等满 150 秒也没有报价。这只是几秒的窗口、重点一次就好，但没有反馈。
- **脚本缺陷（已修）**：①`waitSendOutcome` 用“BUY 按钮可用”判断发送成功，对买票不可靠（弹窗后面的 BUY 仍可点），第 2 次运行因此误判两边都成功、在发送进行中关了浏览器——核对发现三页都是 0/5 张且与链上一致，没有任何交易受影响，保证金 4 TKAS 随后用创建者页面封盘收回（`EMPTY`）；现在改用 `sendResult()`（以弹窗关闭和页面自己的结果提示为准）。②导入之后第一次点击被吞（见上），改为点击未出弹窗就重点（`buyQuote()`，并记录点击次数）。③诊断代码在报价弹窗开着时去点“高级设置”导致一次异常，那一轮用赢家页面收尾（`REFUNDED`）；已修。
- **没有覆盖**：只测了 BUY（`ROUND_INPUT` 的其他动作如 CLOSE 同时发送没测）；同时发送的赢家是谁取决于节点先收到哪一笔，脚本不控制；跨节点（两个页面连不同节点）的真竞争没测；超过 2 个冻结分片等大规模路径与本节无关。

## 16. 2026-11-15 其余场景补测（TIMEOUT 留给用户）

用户指令：“timeout这个后面我来测试。你把其他测了”。本节与[本次活动记录](REMAINING-COVERAGE-20261115.md)分开记录已完成和运行中项目；Profile 仍为 `b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5`，状态 **UNVALIDATED**。只使用原三个 TN10 专用钱包；不涉及主网。

### 16.1 网页场景 1–6 全流程

页面构建 `b51c989593fa460a95b6482421c58e8b184d978e43383c459f534c2c0d1636da`，买家/执行者为 buyer2，节点为本机。交易全部通过页面准备、签名和发送，独立只读 RPC 对每笔重新查询选中链 Full acceptance、花费输入与实际手续费；每笔复核深度至少 100 DAA。

| 场景 | GENESIS txid | 终局 | 交易数 | feeSompi |
|---|---|---|---:|---:|
| 1 空轮 | `9a8543d196627e7477eaf0351d1b7a32549af2ea21367e365e5efff84fca9255` | EMPTY | 2 | 2025400 |
| 2 不足额退款 | `1d499e8ea367def231ab0bc04ddefc507f661205e65613f7e084703440d46a1e` | REFUNDED | 5 | 8267100 |
| 3 标准开奖派奖 | `d4f1791a9a173158d9d61725ccc6110a8745289156dbc66d0530ff1e9cfad1d6` | PAID | 7 | 10608900 |
| 4 卖满提前封盘 | `ef7b894fbd71b3c7eef6fa8fbe22890de3405dc0964042de179214eea982287d` | PAID | 7 | 10610000 |
| 5 网页 256 笔冻结后派奖 | `c4f8098cd0b8ff9c925bc28d17d0f018c20dee73bb817ede174dd5061c599c38` | PAID | 260 | 444829200 |
| 6 网页 256 笔冻结后退款 | `ebe29b50ae503885b559cbce5f9b823bd7b2cab4da66a12aeedc57ad2cec02bf` | REFUNDED | 266 | 734776720 |

合计 **547 笔、520 张票、1211117320 sompi（12.11117320 TKAS）**。场景 4 的封盘发生在五分钟截止时间之前。场景 5 的第 256 笔购买产生一个冻结分片，PAY_OLD 合并空尾后直接 PAID；场景 6 用 8 批 REFUND_OLD 合并空尾后直接 REFUNDED。

归档：`tests/output/rolling-runs/2026-11-15T06-30-57Z-scenarios-1-2-3-4-5-6/`。各 `sN/acceptance.json` 包含全部真实 txid、accepting block、深度、实际 fee、节点 compute/storage mass，以及页面按已签名交易计算的 transient mass；三个 mass 字段均有值。`tests/output/rolling-campaign/browser-summary.json` 记录各证据文件的 SHA256。场景 5 第一次运行在第 6 笔购买后点击导出失败，修正驱动后从原 CID/原 profile 继续，未新建轮次；失败尝试保留在 `run.json.previousAttempts`。

### 16.2 点击刷新修复与新页面复测

真实 Chromium 复现了按下 BUY 后替换整个 view 导致 click 丢失的窗口。新增 `interaction.ts`，按下至 click 完成期间保留 view 节点，之后显示最新数据；恢复焦点使用 preventScroll。3 项真实 DOM/鼠标事件回归、3 项浏览器存储故障/设置/跨标签回归，以及 5 项页面检查，共 **11/11 通过**。其中 IndexedDB 读取故障采用明确的浏览器故障注入；没有钱包、签名或广播，不作为 acceptance 证据。此前扩展离线套件 **122/122 通过**（固定真实引擎，TIMEOUT 命名用例排除）；资金选择修改后 runner 单测再次 **5/5 通过**。

2026-11-15 07:43 UTC 发布 `ea23092b09e9d037eb7a596fe73f0d0ed9ce799a031671be5f2d48a53ab3d2f8`（298048 字节，59 模块）；旧 `b51c9895` 页面与清单先存档，HTTP 回读和只读服务范围复核通过。新页面场景 3/4 已再次完成：14 笔、两个 PAID，逐笔节点复核 ≥100 DAA，归档 `tests/output/rolling-runs/2026-11-15T07-43-49Z-scenarios-3-4/`。主网 `dist/index.html` 未改。

旧双买家 helper 将多个八秒等待窗口记成多次点击、诊断 modal 字段还是占位值，所以旧的“第二次才出报价”计数无法单独证明那次真实点击丢失。现改为先填数量、正常点击、已有 preparing 弹窗时继续等待，并在重试前保存实际弹窗与日志；最终双买家恢复复跑仍待长任务结束。

### 16.3 原字节恢复与多资金输入

17 分片 CLI 在 step 103 做一次受控中断；恢复前后重新计算的签名 wire digest 一致，原交易 `f02d76f19ac06cd5ad6b6e70e0d820933584d7574a5ec1216796e975ed6dc0d3` 由节点重新核对到 6346 DAA 深度。完整 mass/fee/接受证据在 `tests/output/rolling-campaign/controlled-recovery.json`；没有新建替代交易。

三分片退款首次在签名/广播前因 `TEST_WALLET_NEEDS_SINGLE_FUNDING_UTXO` 停止：余额充足，但资金分散为小额输出。CLI 现按 bigint 累加最多 8 个普通资金输入，与构造器上限一致；排除 coinbase、covenant 和已占用输入，全部输入仍经真实引擎与节点检查。从原 `three-shard-refund-1794728861633` 目录恢复，双普通输入 GENESIS `7007bf3f0237a3f773f61d1d721816fba19d97dc0d441d7a30f133e6f7e6f301` 已被接受，独立复核深度 1355，fee 为 1000000 sompi；证据 `tests/output/rolling-campaign/funding-fix-evidence.json`。整个退款大轮最终完成 796 笔、REFUNDED，见 §16.6。

### 16.4 历史轮次收尾与活动上限偏差

本机 covenant 索引确认历史表中的两个旧轮确实仍有管理 UTXO。使用节点 Full acceptance 恢复原公开状态，再由当前页面执行 CLOSE/退款或开奖；未走 TIMEOUT。08:09 UTC 前两轮均已终局，索引中无剩余 covenant 输出。

| 原轮次 | 终局 | 本次新增交易 | 新增 feeSompi | 最后一笔 txid |
|---|---|---:|---:|---|
| race-diffnode-1794645315173 | REFUNDED | 2 | 5216600 | `3a90f07ae07142d88d71a2d8f971364a6e3511cbe58ee96327f06d8b0ad7cb1c` |
| race-1794645526814 | PAID | 3 | 6583400 | `db95c8dacdc8020340228684d9369c467bea13d86d76dda36db9bc6ef2a9d3ea` |

新增共 **5 笔、11800000 sompi（0.118 TKAS）**；原来已统计的 6 笔历史交易未重复计数。归档 `tests/output/rolling-runs/2026-11-15T08-07-12-746Z-settle-legacy/`，包含旧交易重新验证和所有新增交易的接受、mass、fee 证据。

**实验边界偏差：**此前只清点当前 CLI/网页任务，遗漏这两个历史 sales 轮，使最初并行阶段实际有 **4 个活动轮次，超过授权文件的 3 个上限**。这是统计遗漏，不改变交易的真实接受记录。已结清两轮；后续调度从已知公开轮次记录收集 CID，向本机索引查询真实 UTXO，并保守计入记录中的未决创世名额，按依赖串行启动后续阶段。此检查覆盖已知实验记录，不是网络级或通用多进程创建分配器。修正后每个阶段仅保留大派奖及一个 buyer2 任务并行。

另在最终复跑前发现旧资金冲突脚本的 B 页曾配置 2 TKAS 票价，偏离本轮 1 TKAS 约束。独立回读已接受的 GENESIS `4ebc9f9c75332e7dcf5ac75b6d409bbe90414f3db4ac0bc2779b6835166c9557`，从原 payload 解出 `ticketPrice=200000000` sompi；该诊断脚本仅执行 GENESIS/CLOSE，没有 BUY。`legacy-double-spend-price.json` 保存该历史接受位置、真实 fee/mass 与重新核对结果。原始记录保留；当前复跑已统一 1 TKAS，用容量 5/6 区分两笔 GENESIS。

### 16.5 本轮完成与未执行范围

两大分片轮次及各自独立节点回放、当前ea23092b页面六场景均完成，见§16.6–16.8。三买家、并发CLOSE、BUY对CLOSE已有真实竞争及收尾；CLOSE游标回滚用原交易补证。最终真实双节点各接收一笔冲突交易、管理UTXO/资金冲突与恢复复跑均通过，见§16.9–16.10；前两次跨节点准备失败及原签名恢复记录保留。最终已知40CID活跃/预留0，三钱包发送/接收池条目0。外部钱包未接入Rolling，主网不在本轮范围，TIMEOUT交由用户手测。

网络来源边界：`tests/output/rolling-campaign/node-genesis-observation.json`记录节点报告testnet-10/2.1.0/synced，但对预期f896...历史genesis header的RPC请求未取得该header。上游v2.1.0源码中suffix10配置使用匹配的TESTNET_GENESIS，这是预设/源码来源核对，不能称为当前RPC直接读回header匹配。

### 16.6 三分片退款、单次三票与控制器扩展

**真实 TN10 三冻结片退款已完成。** 原目录 `experiments/rolling/artifacts/tn10/three-shard-refund-1794728861633/`：768 笔单票购买、最后一笔三票购买，共 769 BUY / 771 票，低于最低 800 票；CLOSE 后 24 批 REFUND_OLD，再 REFUND_SELF。共 **796 笔、2217109236 sompi（22.17109236 TKAS）、REFUNDED**，全部收据已达到 ≥100 DAA。第一笔 GENESIS 为上文的双资金输入交易；最后一笔为 `ee6abf0ff7e315e8c0af7afeb45e4b4ec5307ded8176385b77d6f1d5e0107c9c`。逐笔 txid、接受位置、mass/fee 在 state、intent、receipt 记录中。

对该轮另外运行独立只读节点回放，**796/796 通过**，重建终局同为 REFUNDED。输出独立于历史索引：`experiments/rolling/artifacts/tn10-index/campaign-refund-20261115/summary.json`，2026-11-15 09:32:32 UTC，状态 `NODE_REVALIDATED_SNAPSHOT_NOT_FINALITY`。回放器新增按单个既有 run 和独立索引子目录筛选，未签名或广播。

**当前页面单次购买三票已完成。** 归档 `tests/output/rolling-runs/2026-11-15T09-13-35Z-scenarios-3/`，CID `0a7b270615a6f79e044242c183acca7a32ec9e9ed795a981582deae879a07e1f`；GENESIS → BUY(quantity=3，只一笔) → CLOSE → DRAW → PAY_SELF，5 笔、PAID、8540200 sompi（0.08540200 TKAS），逐笔独立节点复核 ≥100 DAA。

**控制器多片测试分层记录。** `controller.test.mjs` 新增 4 项模拟用例：17 片按 16+1、40 片按 16+16+8 支付，目标输入不重复、收款人与每笔费用守恒；退款从第 0 片 cursor224 跨至第 1/2 片，每条两票，17 批旧片再本地 32+3 条收口，核对每个买家、替换 frozen outpoint 与未触及分片。4 项针对性执行均通过（最初对 33 条公共尾批的错误假设失败，保留原日志，现拆成明确的资源拒绝/资金辅助用例）。这组 FakeNode / advisory 预算结果只证明模型与控制器推进。

相同 17/40 片派奖和跨片退款另经固定真实脚本引擎运行，**3/3 通过**（`multishard-real-engine.log`）；RPC 接受仍由 FakeNode 模拟。独立 CLI PAY_OLD(k=16) 在 17 片合成输入上下文中，通过全部 17 个输入的真实 limited VM，computeMass242983、transientMass672772、报价33638600 sompi；`cli-sixteen-shard-engine.json` 明确标记非链上接受、非实际网络费用。

**发现的离线资源边界：**本地账本 33 条、cursor32、每条两票的最后一条，公共地址模式在本地报价触发 `STORAGE_MASS_LIMIT`，未产生提交；显式带资金输入的测试钱包模式可正确收口。真实引擎跨片测试也覆盖了带资金的本地退款。该 33 条公共地址形态未在 TN10 实链执行；正常公共地址正例改用 35 条、本地 32+3 条，原普通资金 UTXO 全程未消耗。不能据此宣称所有退款形态都保证无需普通资金辅助。

### 16.7 当前 ea23092b 页面六场景

产物 `ea23092b09e9d037eb7a596fe73f0d0ed9ce799a031671be5f2d48a53ab3d2f8` 全部六场景已通过。3/4 来自 `2026-11-15T07-43-49Z-scenarios-3-4/`，1/2/5/6 来自 `2026-11-15T09-17-48Z-scenarios-1-2-5-6/`。

| 场景 | 终局 | 真实交易数 | 实际 feeSompi |
|---|---|---:|---:|
| 空轮 | EMPTY | 2 | 2000000 |
| 未达到最低票数 | REFUNDED | 5 | 8241400 |
| 标准开奖 | PAID | 7 | 10583600 |
| 卖满后提前封盘 | PAID | 7 | 10583400 |
| 256 笔形成一片后派奖 | PAID | 260 | 450381100 |
| 256 笔形成一片后退款 | REFUNDED | 266 | 734810600 |

共 **547 笔、520 票、1216600100 sompi（12.16600100 TKAS）**。每笔独立节点记录均 accepted 且 ≥100 DAA，fee 与页面收据一致，compute/storage mass 和本地计算的 transient mass 均保存；场景4确认在截止前封盘。聚合 `tests/output/rolling-campaign/browser-current-summary.json` 含每个原接受文件的 SHA256，明确是已有独立节点记录的汇总。§16.1 的 b51 六场景是另一组真实轮次；§16.6 单次买3票的5笔为额外变体。

### 16.8 17 冻结片真实分批派奖与独立索引

`experiments/rolling/artifacts/tn10/batch-payout-1794724070138/` 同一轮已完成，CID `3c1e593ba747d0d799ef5bf100226578d93094304ee26b69a1010358dfec4d4c`。4352 笔单票 BUY 形成17冻结片，最后一笔买3票；共4353 BUY /4355票，GENESIS、CLOSE、DRAW、PAY_OLD16、PAY_OLD1、PAY_SELF 合计 **4359 笔、PAID、7647321264 sompi（76.47321264 TKAS）**，全部 finalized ≥100 DAA。

| 动作 | 冻结片目标 / 输入数 | txid | 实际feeSompi | compute / storage / transient mass |
|---|---|---|---:|---|
| PAY_OLD | 16 /17 | `b1f050786b3736eb7cdfcf0646e8ea7ea2fac120272f94b9f9fb26e3ae47289b` | 33624200 | 242811 /3553 /672484 |
| PAY_OLD | 1 /2 | `5039127467b72e4e2b8d261d681c4cb28ad6f6a393fa2be420bf745beb5d5556` | 4269200 | 29636 /15145 /85384 |
| PAY_SELF | 本地尾单 | `c562ca9948a1fe9b87dbba9284856ff033ff5fb066bcc8a371ac7bed3e8e40ba` | 2305200 | 14306 /11844 /46104 |

两个 PAY_OLD 全部输入都是该 CID 的 covenant UTXO，普通签名数0，输入数量分别17、2。尾单恰3票，未提前合并。逐笔真实引擎、活输入、费用门均保留；记录中的普通/派奖单笔费用分别未超过0.5/1 TKAS。`large-rounds-summary.json` 汇总两大轮及逐批公开输入与实际mass/fee；transient为本地计算。

另外通过实际 `RollingNodeAdapter → RollingIndexer → FileArchive` 独立只读回放 **4359/4359**，12:01:36 UTC完成，重建PAID。输出 `experiments/rolling/artifacts/tn10-index/campaign-payout-20261115/summary.json`，状态 `NODE_REVALIDATED_SNAPSHOT_NOT_FINALITY`。与三分片退款合计5155笔独立回放；这是固定候选Profile、当前所选节点链的实验索引证据，仍不是生产索引器批准或不可逆终局。

### 16.9 多参与者竞争、查询故障与原意图恢复

首组 `tests/output/rolling-runs/2026-11-15T11-02-31-756Z-contention/`：

- 三买家分别使用creator/b1/b2，同一管理输出提交三笔已签名BUY；真实节点一收二拒，两笔拒绝均为ROUND_INPUT，spender与赢家一致。4笔到REFUNDED，7216600sompi，每笔≥100DAA。
- 两方同时CLOSE：真实节点一收一拒，拒绝为ROUND_INPUT；2笔EMPTY/2000000sompi。主流程查证遇CURSOR_REORG，保留pass:false/error。随后对原交易独立重查，确认唯一接受、被争输出为赢家input0、输家完整负搜索/池空及已记录UI清理，`close-1/reconciliation.json`补齐证据，未新开轮或改写原失败。
- BUY对CLOSE：CLOSE胜出，BUY被拒并正确分类，2笔EMPTY/2000000sompi，全部≥100DAA。

跨节点第一次没有在18秒扣帧窗口内收齐提交帧，没有放行竞争。只恢复选定原签名BUY `2ba2d8c8d41a97ba7aa26fa09b28d7385cad9647756cef6783cc61eb65865a24` 并收尾，4笔REFUNDED/7216600sompi。迟到的b2原签名 `e371f44fcd13ed0864661e6a1abd2816bf70d2f07fa31b9b56fc2a416f746e7b` 被测试门丢弃；vector上放弃多次返回INTENT_ACCEPTANCE_UNRESOLVED，切本机查询节点后按页面原规则清除，再导入已退款状态。`discard-recovery-b2.json`记录本机完整负接受、原p2pId711d...节点独立连接的池空、原wireDigest、仅地址模式、0次签名/广播与旧尝试备份。

第二次（`2026-11-15T12-05-49-962Z-contention/`）公共节点发送前核对超过60秒准备门，未形成提交barrier。选定原签名BUY `f9c24402eda09f5671533cc047fc5bc411d417dd2e8273a6ec17d470f0af07b4` 改用本机恢复，恢复前重新认证wireDigest并执行真实limited VM；随后同CID四笔REFUNDED/7216600sompi，均≥100DAA。`cross-node-1/local-original-recovery/`保留原签名、引擎结果、各次恢复和最终接受证明。harness修正了已连接仅地址钱包切回密钥时须先断开、再选择私钥tab的步骤，错误信息不带私钥输入。

跨节点最终通过：`tests/output/rolling-runs/2026-11-15T12-47-25-884Z-contention/`，12:55:43 UTC整组结束。签名准备先在公共节点侧完成，首帧前允许180秒，首帧到达后仍最多扣18秒；实际提交socket分别查询p2pId，原帧和真实回复未改写。测得公共getInfo往返356ms，本机释放延后178ms。

| 实际提交节点 | p2pId | 冲突txid | 节点接收 | 所选本机链接受 |
|---|---|---|---|---|
| 本机 / b1 | `c34ba5fb-ac7f-4323-975e-ba932ecc1e05` | `c79d2f6e8a30e46a3a96c227c066fa1fb4c5de04b04abdd1f9903417c2ba703f` | 真实成功应答 | 否，完整负搜索且池空 |
| vector / b2 | `711d09dd-898f-471b-b679-111d2416250f` | `df789f40ed8ec4f1cc4a046b594fdff57902058ef4e10344b4252a421aae31d6` | 真实成功应答 | 是，赢家input0为共同管理输出 |

两笔都真实进入各自节点，最终所选链仅b2接受。后续结算改用本机节点，4笔REFUNDED/7216600sompi，每笔独立≥100DAA。b1原SUBMITTED意图在实际原节点池空、本机完整负接受、输入已被花掉及页面180秒宽限规则满足后清除，再导入终态；原签名快照保留。`pass/dualNodeAdmission/allParticipated/allLosersAbsent`均true。前两次未构成竞争的尝试及恢复记录仍保留，未改作成功。

只读证据的CURSOR_REORG仅从同一原起点重试三次，持续回滚保持unknown；新增2项替身回归通过，不计作实链接受。

### 16.10 当前页面双花复跑及收尾检查

管理UTXO回归 `tests/output/rolling-runs/2026-11-15T12-32-40Z-round-double-spend/`：真实一收一拒、ROUND_INPUT/spender/管理input0均核对正确；败者按页面规则放弃、导入赢家状态、重新购买，链上输入接在赢家后。第一次真实点击即出现准备弹窗，最终报价使用一个真实点击；旧版等待窗口计数仍不作为历史丢点击证明。旧报价在对方所选链接受后返回UNSENT，新增日志为STALE_INPUT，原报价txid完整负搜索/池空，实际submit帧0。共 **6笔、REFUNDED、10258300sompi（0.10258300TKAS）**，每笔≥100DAA。

同钱包资金回归 `tests/output/rolling-runs/2026-11-15T12-37-52Z-double-spend/`：两页GENESIS使用1TKAS票价、cap5/6，真实一收一拒，FUNDS_INPUT面板/日志/占用方与赢家一致，放弃后重建成功。两次A应答后B准备，均在B报价形成时仍观察到A在池里；后来实际被接受的输入集合不相交，B避开了A使用的旧首选资金。最后旧报价STALE_INPUT发前拦下，submit帧0。**7个EMPTY轮次、14笔、14062800sompi（0.14062800TKAS）**，全部≥100DAA。未由此宣称实链出现过“全部可用资金被占用”的提示或ORPHAN分支。

最终只读检查 `tests/output/rolling-campaign/final-census.json`：已知实验 **40个CID、活跃/预留名额0**；三只专用钱包在所选本机节点的sending/receiving内存池条目均0。这是已知实验记录范围的当前节点检查。最终HTTP回读仍为ea23092b，服务明确testnet-10/readOnly，holdsKeys/signs/broadcasts均false；主网页hash仍为 `0ee7ec5d416820a7e8bb5d1d29b473dc2da16383c73ea396c790840e058e8c2b`。`completion.json`汇总完成条件与边界。

本轮计划的非TIMEOUT场景已执行并完成收尾；Profile仍UNVALIDATED。TIMEOUT留给用户，Rolling扩展钱包、TS独立核心行为等价性、主网和生产批准未纳入本轮完成项。100DAA和有限形态实测不构成不可逆终局、全并发或全参数证明。

### 16.11 延迟竞争审计报告与18秒截止补强

延迟返回的旧版7项问题已逐条对照当前脚本：全部actor到齐/实际发送与节点应答纳入通过条件，pass在终局证据、败者清理及导入后赋值，异常明确false；独立settleOwner检查各profile和实际live manager/已接受receipt；报价allSettled并先取消可关闭弹窗；原提交节点p2pId/池空与本机负接受分别核对；finally丢弃扣留帧，只有经原意图对账的恢复/收尾角色可继续提交。静态复核未发现这些旧项的其他高置信度缺口。

额外发现实际socket身份探测及跨节点释放延迟尚未严格共用最早帧期限。新增测试专用 `tests/rolling-web/submission-barrier.mjs`：首帧使用单调时钟建立18秒deadline，独立timer到期丢弃全部仍扣留闭包，探测和延迟均在该期限内等待；每次release再次检查时间，即便timer回调被拖延也不发过期帧。重复角色帧会中止，不替换原签名字节。异常后的独立原签名恢复规则保持。

定向 `submission-barrier.test.mjs` **8/8通过**，包括正常释放、后来actor不能延长期限、身份探测不返回、先发一方后延迟超限、timer回调延迟、异常/迟到帧、探测错误和重复角色；contention脚本语法通过。该补强仅为运行器调度，不改变合约或发布页。本次未新建轮次/签名/广播；**新版barrier调度的TN10复跑NOT_RUN**，不把旧实链结果标为新版调度已运行。

归档四个有完整actors的竞争场景另作只读回复归属核对，全部forwarded且每人回复指向对应txid。节点拒绝应答的transactionId本来可为空，页面tap按RPC id关联请求；归档核对从成功transactionId或`Rejected transaction ...`主语取对应交易，不能把空字段误当未参与，也不能把占用方hash当被拒交易。CLOSE原passfalse保留。结果见 `barrier-hardening-review.json`、`submission-barrier-tests.log`；completion.json单列此后续补强与NOT_RUN边界。

## 历史累计（截至2026-11-14）

以下保留该时点的累计，未并入 §13–16；两轮当时未收尾的记录随后由 §16.4 结算。后续活动状态以各节的真实证据为准。


| 轮次 | 终局 | 交易数 | feeSompi | 票数 |
| :--- | :--- | ---: | ---: | ---: |
| empty-1794576685264 | EMPTY | 2 | 2000000 | 0 |
| refund-1794576894993 | REFUNDED | 5 | 8241400 | 2 |
| payout-1794620372263 | PAID | 7 | 10583400 | 3 |
| tn10-browser/payout-1794621168788 | PAID | 5 | 8540200 | 3 |
| shard-payout-1794620571374 | PAID | 260 | 451305516 | 256 |
| shard-refund-1794623984454 | REFUNDED | 266 | 734642600 | 256 |
| multi-payout-1794631199294 | PAID | 518 | 884967400 | 515 |
| multi-refund-1794631545757 | REFUNDED | 532 | 1464171800 | 515 |
| tn10-browser/candidate-1794635908003（新版页面） | PAID | 5 | 8540200 | 3 |
| tn10-browser/race-1794644751987（双买家，修复前→修复后） | PAID | 7 | 10583400 | 3 |
| tn10-browser/race-diffnode-1794645315173（双买家，买家2连公共节点；未收尾） | 进行中（sales） | 2 | 2000000 | 1 |
| tn10-browser/race-1794645526814（双买家；未收尾） | 进行中（sales） | 4 | 4000000 | 3 |
| tn10-browser/race-1794645737207（双买家，最终构建） | PAID | 7 | 10583400 | 3 |
| **合计** | | **1620** | **3600159316**（36.00159316 TKAS） | **1563** |

- 预算：2026-11-14 用户指示“预算就是钱包里有多少用多少”，票数与累计手续费上限撤销，仅保留三个专用测试钱包、单笔手续费上限（0.5 TKAS；派奖 1 TKAS）与逐笔引擎测量等保护（见 `TN10-DEPLOYMENT.md`）。累计手续费 36.00159316 TKAS；单笔最大 fee 仍是 shard-refund 第 1 批 REFUND_OLD 的 37363600 sompi（0.373636 TKAS）。
- 前 6 个轮次每步都等 100 DAA 后才发下一笔；多分片两轮的前 46 / 19 笔同样如此，其余、新版页面走查与双买家轮次为 V2.0.2 候选衔接（见 §9、§10、§12）。
- 截至该历史时点，有 2 个双买家轮次（`race-diffnode-…`、`race-1794645526814`）停在 sales；它们已于 2026-11-15 按 §16.4 结算为 REFUNDED/PAID。表内 1620 笔与手续费仍保留当时口径，新增 5 笔另列，避免重复统计。
