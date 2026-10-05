// Verify that the committed lib/ really is the pinned TypeScript output of src/ (driven by tsconfig.json).
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

assert.equal(ts.version, '5.8.3', 'TypeScript is pinned to 5.8.3');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'packages/f3.2-core'), lib = path.join(base, 'lib');
const host = {getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n'};
const fail = list => { if (list.length) throw Error(ts.formatDiagnostics(list, host)); };
const {config, error} = ts.readConfigFile(path.join(base, 'tsconfig.json'), ts.sys.readFile);
fail(error ? [error] : []);
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, base);
fail(parsed.errors);
const program = ts.createProgram(parsed.fileNames, parsed.options);
fail(ts.getPreEmitDiagnostics(program));
const emitted = new Map();
const result = program.emit(undefined, (file, text) => emitted.set(path.resolve(file), text));
assert.equal(result.emitSkipped, false); fail(result.diagnostics);

const drift = [];
for (const [file, text] of emitted) {
  const actual = await fs.readFile(file, 'utf8').catch(() => null);
  if (actual !== text) drift.push((actual === null ? 'missing: ' : 'differs: ') + path.relative(root, file));
}
for (const name of await fs.readdir(lib)) if (!emitted.has(path.join(lib, name))) drift.push('stale: ' + path.relative(root, path.join(lib, name)));
assert.deepEqual(drift, [], 'lib/ is not the pinned TypeScript output of src/');
console.log(`TypeScript ${ts.version}: ${parsed.fileNames.length} sources -> ${emitted.size} files (.js/.d.ts/.js.map) byte-identical in lib/; nothing stale. No runtime SDK dependency.`);
