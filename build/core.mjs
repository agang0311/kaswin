import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';
import {syncLayout} from '../scripts/contract/sync-layout.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = path.join(root, 'scripts/core');
const lib = path.join(base, 'lib');
const host = {getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n'};
function diagnostics(list) {
  if (list.length) throw Error(ts.formatDiagnostics(list, host));
}

export async function buildCore({check = false} = {}) {
  if (ts.version !== '5.8.3') throw Error('TypeScript 5.8.3 is required');
  await syncLayout();
  const {config, error} = ts.readConfigFile(path.join(base, 'tsconfig.json'), ts.sys.readFile);
  diagnostics(error ? [error] : []);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, base);
  diagnostics(parsed.errors);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  diagnostics(ts.getPreEmitDiagnostics(program));
  const emitted = new Map();
  const result = program.emit(undefined, (file, text) => emitted.set(path.resolve(file), text));
  diagnostics(result.diagnostics);
  if (result.emitSkipped) throw Error('Core compilation emitted no output');

  if (check) {
    const drift = [];
    for (const [file, text] of emitted) {
      const actual = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (actual !== text) drift.push(path.relative(root, file));
    }
    const names = await fs.readdir(lib).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const name of names) if (!emitted.has(path.join(lib, name))) drift.push(path.relative(root, path.join(lib, name)));
    if (drift.length) throw Error('Core output differs; run npm run build:core:\n' + drift.join('\n'));
  } else {
    await fs.mkdir(lib, {recursive: true});
    for (const [file, text] of emitted) await fs.writeFile(file, text);
    for (const name of await fs.readdir(lib)) {
      if (!emitted.has(path.join(lib, name))) await fs.rm(path.join(lib, name), {recursive: true});
    }
  }
  console.log(`Core ${check ? 'checked' : 'built'}: ${parsed.fileNames.length} sources, ${emitted.size} outputs`);
  return parsed.fileNames.map(file => path.relative(root, file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw Error('Usage: node build/core.mjs [--check]');
  await buildCore({check: args[0] === '--check'});
}
