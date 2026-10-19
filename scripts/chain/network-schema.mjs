// Network data only. No I/O, wallet access, activation decision or implicit network selection.
const fail = code => { throw Object.assign(new Error(code), {safeCode: code}); };
const text = v => typeof v === 'string' && v.length > 0;
export function requireNet(net) {
  if (!net || !['key', 'label', 'unit', 'networkId', 'addressPrefix', 'kaswareNetwork', 'rest', 'explorer'].every(k => text(net[k])) ||
      !/^[0-9a-f]{64}$/.test(net.genesis ?? '') || !Array.isArray(net.nodes) || !net.nodes.length ||
      !text(net.registry?.address) || !text(net.registry?.spk?.script) || typeof net.maxFeePerTx !== 'bigint') fail('NETWORK_CONTEXT_REQUIRED');
  return net;
}
export const linkNet = link => requireNet(link?.net);
export function defineNetwork(net) {
  requireNet(net);
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
  };
  return freeze(net);
}
export function explorerLinks(net) {
  requireNet(net);
  const root = net.explorer.replace(/\/$/, '');
  return Object.freeze({explorerTx: id => `${root}/transactions/${id}`, explorerAddress: address => `${root}/addresses/${address}`, explorerBlock: hash => `${root}/blocks/${hash}`});
}
