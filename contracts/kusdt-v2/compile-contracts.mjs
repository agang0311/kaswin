/** Compile the seven Kaswin kUSDT v2 templates with the pinned SilverScript 1.0.1 compiler, in strict DAG order.
 * Usage: node contracts/kusdt-v2/compile-contracts.mjs [--out-dir <dir>] [--kusdt-cid <64hex>] [--max-batch <1..16>]
 * Offline only: expands sources via prepare-sources.mjs, invokes silverc, and records actual template hashes in
 * artifacts/template-pins.json. Does NOT run tests, a VM, a node, or signing.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, '..');
const kaswinRoot = resolve(contractsDir, '..');

const DEFAULT_KUSDT_CID = '50b3477e7368d0c5bfbd64483b4607350ec411377972f33e40b2d4b6d1513fd3';
const DEFAULT_MAX_BATCH = 8;

const args = process.argv.slice(2);
let outDir = here;
let kusdtCid = DEFAULT_KUSDT_CID;
let maxBatch = DEFAULT_MAX_BATCH;

while (args.length) {
  const flag = args.shift();
  const val = args.shift();
  if (flag === '--out-dir' && val) outDir = resolve(val);
  else if (flag === '--kusdt-cid' && val) kusdtCid = val.toLowerCase();
  else if (flag === '--max-batch' && val) maxBatch = Number(val);
  else throw new Error('Usage: node compile-contracts.mjs [--out-dir <dir>] [--kusdt-cid <64hex>] [--max-batch <1..16>]');
}

const tool = JSON.parse(await readFile(join(contractsDir, 'toolchain.json'), 'utf8'));
const silverc = resolve(kaswinRoot, tool.binaryPath);
if (!existsSync(silverc)) throw new Error('Pinned silverc is not installed: ' + tool.binaryPath);
const binarySha = createHash('sha256').update(await readFile(silverc)).digest('hex');
if (binarySha !== tool.compilerBinarySha256) {
  throw new Error('silverc does not match contracts/toolchain.json');
}

// Strict acyclic dependency order (leaves first, root M_OPEN last).
const ORDER = ['s_payout', 's_refund', 's_frozen', 's_open', 'm_dispatch', 'm_sealed', 'm_open'];
const CTOR_BYTES = {
  s_payout: 110,
  s_refund: 80,
  s_frozen: 112,
  s_open: 112,
  m_dispatch: 124,
  m_sealed: 128,
  m_open: 60,
};

const artifacts = join(outDir, 'artifacts');
const pinsPath = join(artifacts, 'template-pins.json');
await mkdir(artifacts, {recursive: true});
for (const m of ORDER) await rm(join(artifacts, m + '.json'), {force: true});
await rm(pinsPath, {force: true});

const templates = {};
for (const m of ORDER) {
  const ctorPath = join(artifacts, m + '.ctor.json');
  await writeFile(ctorPath, JSON.stringify([{kind: 'bytes', value: new Array(CTOR_BYTES[m]).fill(0)}]));

  const prep = [
    join(here, 'prepare-sources.mjs'),
    m,
    '--out-dir', outDir,
    '--kusdt-cid', kusdtCid,
    '--max-batch', String(maxBatch),
    ...(Object.keys(templates).length ? ['--pins', pinsPath] : []),
  ];
  execFileSync('node', prep, {stdio: ['ignore', 'ignore', 'inherit']});
  execFileSync(
    silverc,
    [join(outDir, m + '.sil'), '--constructor-args', ctorPath, '-o', join(artifacts, m + '.json')],
    {stdio: ['ignore', 'inherit', 'inherit']},
  );
  await rm(ctorPath, {force: true});

  const artifact = JSON.parse(await readFile(join(artifacts, m + '.json'), 'utf8'));
  const [contractName, contractObj] = Object.entries(artifact.contracts)[0];
  const compiled = contractObj.compiled;
  const tailBytes = compiled.bytecode.length - 1 - compiled.state_span.len;
  const templateHash = Buffer.from(compiled.template_hash).toString('hex');

  templates[m] = {
    contract: contractName,
    bytecodeBytes: compiled.bytecode.length,
    stateSpanLen: compiled.state_span.len,
    tailBytes,
    templateHash,
  };

  const payload = {
    schemaVersion: 1,
    protocol: 'kaswin-kusdt-v2',
    compilerPackage: tool.compilerPackage,
    compilerPackageVersion: tool.compilerPackageVersion,
    compilerBinarySha256: tool.compilerBinarySha256,
    kusdtCid,
    maxBatch,
    order: ORDER,
    templates,
  };
  await writeFile(pinsPath, JSON.stringify(payload, null, 2) + '\n');
  console.log(
    m.padEnd(11),
    contractName.padEnd(21),
    'bytecode', String(compiled.bytecode.length).padStart(6),
    'tail', String(tailBytes).padStart(6),
    'template', templateHash,
  );
}
