/** Standalone TN10 Rolling sidecar entrypoint.
 * Read-only on chain: no private keys, no signing, no broadcasting.
 * Importing this module starts nothing; run directly with node to start the server.
 */
import http from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDeploymentProfile} from '../../../experiments/rolling/deployment-profile.mjs';
import {TN10_GENESIS, TN10_NETWORK_ID, TN10_PROFILE_ID} from '../../../web/rolling-tn10/protocol.mjs';
import {configFromArgs, need, safeCode} from './config.mjs';
import {RollingStore} from './store.mjs';
import {RollingScanner} from './scanner.mjs';
import {RollingIndexerService} from './service.mjs';

export async function createRollingSidecar(argv = process.argv.slice(2)) {
  const config = configFromArgs(argv);
  need(config.network === TN10_NETWORK_ID, 'UNSUPPORTED_NETWORK', 400);
  need(config.genesisHash === TN10_GENESIS, 'UNSUPPORTED_GENESIS', 400);
  need(config.profileId === TN10_PROFILE_ID, 'UNSUPPORTED_PROFILE', 400);

  const profile = await loadDeploymentProfile();
  need(profile.id === config.profileId, 'DEPLOYMENT_PROFILE_MISMATCH', 500);

  const store = new RollingStore({
    dataDir: config.dataDir,
    network: config.network,
    genesisHash: config.genesisHash,
    profileId: config.profileId,
  });
  await store.acquireLock();
  try {
    await store.init(config.startHash);
  } catch (e) {
    await store.releaseLock();
    throw e;
  }

  const scanner = new RollingScanner({config, profile, store});
  const service = new RollingIndexerService({config, profile, store, scanner});
  const server = http.createServer((req, res) => {
    void service.handleRequest(req, res);
  });
  server.requestTimeout = config.rpcMs;
  server.headersTimeout = 10_000;

  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    await scanner.stop();
    await new Promise(resolveClose => server.close(() => resolveClose()));
    await store.releaseLock();
  };

  const start = async () => {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(config.port, config.host, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    await scanner.start();
    return {
      host: config.host,
      port: server.address().port,
      basePath: `/tn10/rolling/v1/${config.profileId}`,
    };
  };

  return {config, profile, store, scanner, service, server, start, stop};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let sidecar = null;
  const shutdown = async () => {
    try {await sidecar?.stop();} catch {}
    process.exit(0);
  };
  process.once('SIGINT', () => {void shutdown();});
  process.once('SIGTERM', () => {void shutdown();});

  createRollingSidecar(process.argv.slice(2))
    .then(async s => {
      sidecar = s;
      const info = await s.start();
      console.log(JSON.stringify({
        status: 'LISTENING',
        network: s.config.network,
        profileId: s.config.profileId,
        url: `http://${info.host}:${info.port}${info.basePath}`,
      }));
    })
    .catch(async e => {
      try {await sidecar?.stop();} catch {}
      console.error(safeCode(e));
      process.exitCode = 1;
    });
}
