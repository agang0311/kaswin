/** Entrypoint: parse before any optional SDK, wallet or network module is loaded. */
import {parseArgs} from './cli.mjs';
const options = parseArgs(process.argv.slice(2));
try {
  if (options.mode === 'dry') await (await import('./offline-plan.mjs')).run(options);
  else await (await import('./live.mjs')).run(options);
} catch (e) {
  // Do not print SDK/wallet exceptions, which may contain constructor arguments.
  console.error(`STOPPED: ${e?.safeCode ?? 'RUN_FAILED_CLOSED'}; no automatic retry. Inspect public journal evidence; do not delete unresolved intents.`);
  process.exitCode = 1;
}
