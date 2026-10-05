// Optional offline compiler replay for the three F3.2 contracts. Never touches tracked files; no VM or network.
//   node contracts/f3.2/tools/check-compile.mjs /absolute/path/to/silverc /absolute/path/to/new-output-directory
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {parseCompiledFrame} from '../../../packages/f3.2-core/lib/artifacts.js';

const [exe, dest] = process.argv.slice(2);
if (!exe || !dest || !path.isAbsolute(exe) || !path.isAbsolute(dest)) throw Error('Usage: node check-compile.mjs /absolute/silverc /absolute/new-output-directory');
const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await fs.readFile(path.join(root, 'pins.json'), 'utf8'));
const report = JSON.parse(await fs.readFile(path.join(root, 'artifacts/build-report.json'), 'utf8'));
const sha = b => createHash('sha256').update(b).digest('hex');
const exeSha = sha(await fs.readFile(exe));
console.log(exeSha === report.compilerBinarySha256 ? `Compiler binary sha256 ${exeSha} equals the historical build.`
  : `Note: compiler binary sha256 ${exeSha} differs from the historical ${report.compilerBinarySha256}; outputs must still be byte-identical.`);
await fs.mkdir(dest); // Intentionally fails if the target already exists: never overwrite.
for (const m of ['open', 'sealed', 'refunding']) {
  const source = path.join(root, `src/${m}.sil`), output = path.join(dest, `${m}-linked.json`);
  const log = execFileSync(exe, [source, '--constructor-args', path.join(root, `artifacts/${m}-linked.args.json`), '-o', output], {encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024});
  await fs.writeFile(path.join(dest, `${m}.log`), log);
  const json = await fs.readFile(output);
  assert.equal(sha(json), pins.frames[m].artifactSha256, `${m}: compiled artifact differs from the pinned linked artifact`);
  const f = parseCompiledFrame(m, JSON.parse(json.toString('utf8')), sha(await fs.readFile(source)));
  assert.deepEqual({...f, tail: Buffer.from(f.tail).toString('hex')}, report.frames[m], `${m}: compiled frame differs from the historical report`);
}
console.log('PASS: three linked artifacts are byte-identical to the pinned files. Compilation only; no VM, network or audit claim.');
