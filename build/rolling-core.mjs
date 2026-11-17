/** Compile the rolling TypeScript core: scripts/rolling/core/src -> scripts/rolling/core/lib (generated, ignored).
 *   node build/rolling-core.mjs [--check]
 * Mirrors build/core.mjs: same pinned TypeScript, same drift check. It type-checks against the V2.0.2 core's generated
 * declarations (scripts/core/lib/*.d.ts), so run `npm run build:core` first. Never writes scripts/core or dist/.
 * NOT_RUN: written 2026-11-14 without executing it. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = path.join(root, 'scripts/rolling/core');
const lib = path.join(base, 'lib');
const host = {getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n'};
function diagnostics(list) {
  if (list.length) throw Error(ts.formatDiagnostics(list, host));
}

export async function buildRollingCore({check = false} = {}) {
  if (ts.version !== '5.8.3') throw Error('TypeScript 5.8.3 is required');
  await fs.access(path.join(root, 'scripts/core/lib/bytes.d.ts')).catch(() => { throw Error('scripts/core/lib is missing; run npm run build:core first'); });
  const {config, error} = ts.readConfigFile(path.join(base, 'tsconfig.json'), ts.sys.readFile);
  diagnostics(error ? [error] : []);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, base);
  diagnostics(parsed.errors);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  diagnostics(ts.getPreEmitDiagnostics(program));
  const emitted = new Map();
  const result = program.emit(undefined, (file, text) => emitted.set(path.resolve(file), text));
  diagnostics(result.diagnostics);
  if (result.emitSkipped) throw Error('Rolling core compilation emitted no output');

  if (check) {
    const drift = [];
    for (const [file, text] of emitted) {
      const actual = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (actual !== text) drift.push(path.relative(root, file));
    }
    const names = await fs.readdir(lib).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const name of names) if (!emitted.has(path.join(lib, name))) drift.push(path.relative(root, path.join(lib, name)));
    if (drift.length) throw Error('Rolling core output differs; run npm run build:rolling-core:\n' + drift.join('\n'));
  } else {
    await fs.mkdir(lib, {recursive: true});
    for (const [file, text] of emitted) await fs.writeFile(file, text);
    for (const name of await fs.readdir(lib)) {
      if (!emitted.has(path.join(lib, name))) await fs.rm(path.join(lib, name), {recursive: true});
    }
  }
  console.log(`Rolling core ${check ? 'checked' : 'built'}: ${parsed.fileNames.length} sources, ${emitted.size} outputs`);
  return parsed.fileNames.map(file => path.relative(root, file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw Error('Usage: node build/rolling-core.mjs [--check]');
  await buildRollingCore({check: args[0] === '--check'});
}
