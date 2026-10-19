// Public network/UTXO context: no files, SDK loader, wallet keys or connection side effects at import time.
import {commonUtxos, inputsState, verifyInputsLive} from './chain.mjs';
import {encodeAddress} from '../wallet/address.mjs';
import {requireNet, explorerLinks} from './network-schema.mjs';
import {NetworkLink} from './nodes.mjs';
import {DualNodeLink} from './dual-node.mjs';
const unhex = h => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));

export function createPublicNetworkContext(net) {
  requireNet(net);
  const address = xonly => encodeAddress(0, unhex(xonly), net.addressPrefix);
  /** Address of a P2PK (wallet) or P2SH (covenant state) spk on this network; other scripts: null. */
  const spkAddress = spk => {
    if (spk?.version !== 0 || typeof spk.script !== 'string') return null;
    if (/^20[0-9a-f]{64}ac$/.test(spk.script)) return address(spk.script.slice(2, 66));
    if (/^aa20[0-9a-f]{64}87$/.test(spk.script)) return encodeAddress(8, unhex(spk.script.slice(4, 68)), net.addressPrefix);
    return null;
  };
  return Object.freeze({
    net, key: net.key, genesis: net.genesis, maxFee: net.maxFeePerTx,
    registry: net.registry, address, spkAddress, ...explorerLinks(net),
    openLink: ({dual = false} = {}) => dual ? new DualNodeLink(net.nodes, {net, verifyDag: true}) : new NetworkLink(net),
    /** UTXOs of one address using the shared chain reader and this context's address prefix. */
    utxos: commonUtxos,
    /** Every input must still be live and identical (value/script/covenant, and DAA unless allowDaaDrift) on this
     * network's node. Returns the live UTXOs in input order. A DAA difference only means the creating transaction was
     * re-accepted in another chain block after a reorg (signatures do not commit to it); callers that allow drift must
     * adopt the live DAA. */
    verifyInputsLive(link, list, {allowDaaDrift = false} = {}) {
      return verifyInputsLive(link, list, {allowDaaDrift, addressOf: spkAddress, readUtxos: this.utxos});
    },
    inputsState(link, list) { return inputsState(link, list, {addressOf: spkAddress, readUtxos: this.utxos}); },
    /** Liveness of each input by outpoint (true/false), or null when the node could not be asked. Never throws. */
    async inputsLive(link, list) {
      try { return (await this.inputsState(link, list)).map(x => x.live); } catch { return null; }
    },
  });
}
