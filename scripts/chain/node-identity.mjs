// Identity mechanism only: no endpoint table, wallet configuration or I/O at import time.
import {uint} from './json.mjs';
import {failure} from './operation.mjs';
export function checkServerIdentity(s, networkId) {
  if (s?.networkId !== networkId) {
    const e = failure('NODE_NETWORK_MISMATCH');
    e.message = `${networkId} 网络不符`;
    throw e;
  }
  if (s.isSynced !== true) {
    const e = failure('NODE_NETWORK_MISMATCH');
    e.message = '节点尚未同步';
    throw e;
  }
  if (s.hasUtxoIndex !== true) {
    const e = failure('NODE_NETWORK_MISMATCH');
    e.message = '节点未启用 UTXO 索引（kaspad 需加 --utxoindex）';
    throw e;
  }
  return {networkId: s.networkId, serverVersion: String(s.serverVersion ?? ''), virtualDaa: uint(s.virtualDaaScore).toString()};
}
export async function assertNodeNetwork(rpc, net) {
  const id = checkServerIdentity(await rpc.call('getServerInfo'), net.networkId);
  if ((await rpc.call('getBlockDagInfo'))?.network !== net.networkId) {
    const e = failure('NODE_NETWORK_MISMATCH');
    e.message = 'DAG 网络不符';
    throw e;
  }
  return id;
}
