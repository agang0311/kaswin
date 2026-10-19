// Fixed rusty-kaspa cfafeb4 genesis/address facts; endpoint observations 2026-10-12.
// Wallet/REST/explorer: KasWare 78bb3004 shared/constant/index.ts + shared/utils/chain.ts;
// REST server c638eb5 README. Source read 2026-10-16, no new live availability claim.
import {defineNetwork} from './network-schema.mjs';
const nodes = [
  'wss://tn10.kaspay.top/wrpc',
  'wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json',
  'wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/json',
  'wss://quark-10.kaspa.red/kaspa/testnet-10/wrpc/json',
  'wss://electron-10.kaspa.stream/kaspa/testnet-10/wrpc/json',
];
export const TN10 = defineNetwork({
  key: 'tn10', label: 'Testnet 10', unit: 'TKAS', networkId: 'testnet-10',
  genesis: 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370',
  addressPrefix: 'kaspatest', kaswareNetwork: 'kaspa_testnet_10',
  rest: 'https://api-tn10.kaspa.org', explorer: 'https://tn10.kaspa.stream',
  // CLI and Web retain their existing endpoint policy, defined here in one place.
  nodes: [nodes[1], nodes[2], nodes[0], nodes[3]], indexer: 'https://indexer.kaspay.top/tn10',
  web: {nodes, indexer: 'https://indexer.kaspay.top/tn10', legacyConfig: true},
  registry: {address: 'kaspatest:qztrjpfpuf6g9jw76e6ay909z43hndpv5maqkker6ur4enz7llarsh82ezggl',
    spk: {version: 0, script: '2096390521e27482c9ded675d215e5156379b42ca6fa0b5b23d7075ccc5efffa38ac'}},
  maxFeePerTx: 50_000_000n,
  journalSchemas: {run: 'KASWIN_TN10_RUN_2', intent: 'KASWIN_TN10_INTENT_2', accepted: 'KASWIN_TN10_ACCEPTED_2'},
});
