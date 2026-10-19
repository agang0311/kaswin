// Public facts only; does not enable a mainnet Web release or authorize signing/broadcast.
// Node list: one hostname per distinct backend observed 2026-10-16 through the public resolver discovery route
// (aspectron/kaspa-resolver 91d811b /v2/kaspa/mainnet/tls/wrpc/{json,borsh}); 14 responding hostnames collapsed to
// 8 backends by getInfo p2pId. All entries answered getServerInfo as mainnet/synced/hasUtxoIndex on JSON wRPC.
// The resolver's own bundled node table is encrypted, so this is a sampled lower bound, not an authoritative inventory.
// Endpoint availability is an observation, not a commitment; the client still verifies networkId and sync on connect.
// REST/explorer: mainnet REST is the same kaspa-rest-server software as TN10 (fixed c638eb5) at https://api.kaspa.org
// (kaspa-rest-server README; also KasWare 78bb3004 shared/constant/index.ts OPENAPI_URL_MAINNET).
// Explorer is the bare domain https://kaspa.stream: KasWare maps testnet-10 -> https://tn10.kaspa.stream and mainnet ->
// explorer.kaspa.org (shared/utils/chain.ts), but this project uses kaspa.stream for both. It is a client-side SPA, so
// HTTP status cannot confirm a route; the /transactions/, /addresses/ and /blocks/ shapes below follow the same
// templates KasWare uses for its blockstream links and that this project already uses for tn10.kaspa.stream.
import {defineNetwork} from './network-schema.mjs';
const nodes = [
  'wss://kate.kaspa.red/kaspa/mainnet/wrpc/json',
  'wss://isla.kaspa.red/kaspa/mainnet/wrpc/json',
  'wss://tess.kaspa.red/kaspa/mainnet/wrpc/json',
  'wss://ivy.kaspa.green/kaspa/mainnet/wrpc/json',
  'wss://dina.kaspa.green/kaspa/mainnet/wrpc/json',
  'wss://eva.kaspa.green/kaspa/mainnet/wrpc/json',
  'wss://lena.kaspa.blue/kaspa/mainnet/wrpc/json',
  'wss://vivi.kaspa.blue/kaspa/mainnet/wrpc/json',
];
export const MAINNET = defineNetwork({
  key: 'mainnet', label: 'Kaspa mainnet', unit: 'KAS', networkId: 'mainnet',
  genesis: '58c2d4199e21f910d1571d114969cecef48f09f934d42ccb6a281a15868f2999',
  addressPrefix: 'kaspa', kaswareNetwork: 'kaspa_mainnet',
  rest: 'https://api.kaspa.org', explorer: 'https://kaspa.stream',
  nodes, indexer: 'https://indexer.kaspay.top/mainnet', web: {nodes, indexer: 'https://indexer.kaspay.top/mainnet', legacyConfig: false},
  registry: {address: 'kaspa:qzccgw790r0mnfe9uvy7nwd7a8990029ycg8e0manehhgruqm2r9v528nz0qr',
    spk: {version: 0, script: '20b1843bc578dfb9a725e309e9b9bee9ca57bd4526107cbf7d9e6f740f80da8656ac'}},
  maxFeePerTx: 50_000_000n,
  journalSchemas: {run: 'KASWIN_MAINNET_RUN_1', intent: 'KASWIN_MAINNET_INTENT_1', accepted: 'KASWIN_MAINNET_ACCEPTED_1'},
});
