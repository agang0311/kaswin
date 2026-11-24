/** Expand one kUSDT v2 contract source stage; intentionally does NOT compile, test, approve or broadcast.
 * Usage: node contracts/kusdt-v2/prepare-sources.mjs s_payout [--out-dir <dir>] [--pins <template-pins.json>] [--kusdt-cid <64hex>] [--max-batch <n>]
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MODULES = ['s_payout', 's_refund', 's_frozen', 's_open', 'm_dispatch', 'm_sealed', 'm_open'];
const DEFAULT_KUSDT_CID = '50b3477e7368d0c5bfbd64483b4607350ec411377972f33e40b2d4b6d1513fd3';
const DEFAULT_MAX_BATCH = 8;

const args = process.argv.slice(2);
const mod = args.shift();
if (!MODULES.includes(mod)) {
  throw new Error('Expected one module: ' + MODULES.join('/'));
}

let pins = {};
let outDir = here;
let kusdtCid = DEFAULT_KUSDT_CID;
let maxBatch = DEFAULT_MAX_BATCH;

while (args.length) {
  const flag = args.shift();
  const val = args.shift();
  if (flag === '--pins' && val) pins = JSON.parse(await readFile(val, 'utf8'));
  else if (flag === '--out-dir' && val) outDir = resolve(val);
  else if (flag === '--kusdt-cid' && val) kusdtCid = val.toLowerCase();
  else if (flag === '--max-batch' && val) maxBatch = Number(val);
  else throw new Error('Supported flags: [--pins <path>] [--out-dir <dir>] [--kusdt-cid <64hex>] [--max-batch <1..16>]');
}

if (!/^[0-9a-f]{64}$/.test(kusdtCid) || /^0+$/.test(kusdtCid)) {
  throw new Error('Invalid --kusdt-cid (expected 64-char nonzero hex)');
}
if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 16) {
  throw new Error('Invalid --max-batch (expected integer 1..16)');
}

let source = await readFile(join(here, 'templates', mod + '.sil.in'), 'utf8');
if (source.includes('{{COMMON}}')) {
  source = source.replace('{{COMMON}}', await readFile(join(here, 'templates', 'common.sil.inc'), 'utf8'));
}

source = source
  .replaceAll('{{KUSDT_CID}}', kusdtCid)
  .replaceAll('{{MAX_BATCH}}', String(maxBatch))
  .replaceAll('{{BATCH_FEE_INPUTS}}', String(maxBatch + 9))
  .replaceAll('{{BATCH_FEE_OUTPUTS}}', String(maxBatch + 2));

const READERS = {U16: 2, U32: 4, U63: 8};
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if ('([{'.includes(text[i])) depth++;
    else if (')]}'.includes(text[i])) depth--;
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

function expandReaders(text) {
  for (;;) {
    const m = /\b(U16|U32|U63)\(/.exec(text);
    if (!m) return text;
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    if (depth !== 0) throw new Error('Unbalanced ' + m[1] + ' macro');
    const [bytes, at, ...extra] = splitArgs(text.slice(from, i - 1));
    if (!bytes || !at || extra.length) throw new Error(m[1] + ' expects (bytes, offset)');
    const n = READERS[m[1]];
    const body = bytes + '.slice(' + at + ', (' + at + ') + ' + n + ')';
    text = text.slice(0, m.index) + 'OpBin2Num(' + body + (n === 8 ? '' : ' + byte[](0x00)') + ')' + text.slice(i);
  }
}

source = expandReaders(source);

const pinMap = pins.templates || pins;
source = source.replace(/\{\{([A-Z0-9_]+)_HASH\}\}/g, (_, name) => {
  const hash = pinMap[name.toLowerCase()]?.templateHash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || /^0+$/.test(hash)) {
    throw new Error('Missing nonzero trusted template hash: ' + name);
  }
  return hash;
});

if (source.includes('{{')) {
  throw new Error('Unresolved source placeholder in ' + mod);
}

await mkdir(outDir, {recursive: true});
await writeFile(join(outDir, mod + '.sil'), source);
console.log('Prepared ' + mod + '.sil; compilation and all validation NOT_RUN');
