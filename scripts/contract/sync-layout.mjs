// Source projection only. No compiler, SDK, network, signing or artifact/pin writes.
// --check compares projections; --write updates source projections. Neither mode approves a Profile.
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const begin = '    // BEGIN GENERATED LEDGER LAYOUT (contracts/ledger-layout.json)';
const end = '    // END GENERATED LEDGER LAYOUT';
export async function layoutProjections(contractsDir = path.join(root, 'contracts')) {
  const layout = JSON.parse(await fs.readFile(path.join(contractsDir, 'ledger-layout.json'), 'utf8'));
  assert.equal(layout.schema, 'KASWIN_LEDGER_LAYOUT_1');
  assert.equal(layout.sourceVersion, 'V2.0.2');
  assert.equal(layout.magic, 'KW21');
  const c = layout.constants;
  assert(c && typeof c === 'object' && !Array.isArray(c), 'Layout constants required');
  // Semantic schema is fixed by KW21; offsets themselves have one source in the JSON.
  const header = [
    ['magic', 'OFFSET_MAGIC', 'U32_BYTES', 'ascii'],
    ['phase', 'OFFSET_PHASE', 'U32_BYTES', 'signed-domain-u32-le'],
    ['ticketPrice', 'OFFSET_TICKET_PRICE', 'U63_BYTES', 'u63-le'],
    ['ticketCap', 'OFFSET_TICKET_CAP', 'U32_BYTES', 'signed-domain-u32-le'],
    ['purchaseCap', 'OFFSET_PURCHASE_CAP', 'U32_BYTES', 'signed-domain-u32-le'],
    ['minTickets', 'OFFSET_MIN_TICKETS', 'U32_BYTES', 'signed-domain-u32-le'],
    ['closeEligibleDaa', 'OFFSET_CLOSE_ELIGIBLE_DAA', 'U63_BYTES', 'u63-le'],
    ['sold', 'OFFSET_SOLD', 'U32_BYTES', 'signed-domain-u32-le'],
    ['purchaseCount', 'OFFSET_PURCHASE_COUNT', 'U32_BYTES', 'signed-domain-u32-le'],
    ['cursor', 'OFFSET_REFUND_CURSOR', 'U32_BYTES', 'signed-domain-u32-le'],
    ['ownerKey', 'OFFSET_OWNER_KEY', 'KEY_BYTES', 'bytes'],
  ];
  const record = [
    ['cumulativeEnd', 'RECORD_OFFSET_END', 'U32_BYTES', 'signed-domain-u32-le'],
    ['buyerKey', 'RECORD_OFFSET_BUYER_KEY', 'KEY_BYTES', 'bytes'],
  ];
  const fields = rows => rows.map(([name, offset, width, encoding]) => ({name, offset, width, encoding}));
  assert.deepEqual(layout.header, fields(header), 'KW21 header schema');
  assert.deepEqual(layout.record, fields(record), 'KW21 directory schema');
  assert.deepEqual(Object.keys(c).sort(), [...header, ...record].map(f => f[1])
    .concat(['HEADER_BYTES', 'RECORD_BYTES', 'U32_BYTES', 'U63_BYTES', 'KEY_BYTES']).sort());
  assert.equal(c.U32_BYTES, 4); assert.equal(c.U63_BYTES, 8); assert.equal(c.KEY_BYTES, 32);
  for (const [name, value] of Object.entries(c)) {
    assert.match(name, /^[A-Z][A-Z_0-9]*$/);
    assert(Number.isSafeInteger(value) && value >= 0);
  }
  const checkFields = (fields, length) => {
    let at = 0;
    for (const f of fields) {
      assert.equal(c[f.offset], at, f.name);
      assert(c[f.width] > 0, f.name);
      at += c[f.width];
    }
    assert.equal(at, length);
  };
  assert.equal(c.HEADER_BYTES, 80); assert.equal(c.RECORD_BYTES, 36);
  checkFields(layout.header, c.HEADER_BYTES); checkFields(layout.record, c.RECORD_BYTES);
  const sil = [begin, ...Object.entries(c).map(([k, v]) => `    int constant ${k} = ${v};`), end].join('\n');
  const ts = '// Generated source projection of contracts/ledger-layout.json. Do not edit independently.\n'
    + '// Run scripts/contract/sync-layout.mjs --write only when generation is authorized.\n'
    + `export const MAGIC = '${layout.magic}';\n`
    + Object.entries(c).map(([k, v]) => `export const ${k} = ${v};\n`).join('');
  return {sil, ts};
}
export function replaceLayoutBlock(source, sil) {
  assert.equal(source.split(begin).length, 2, 'Missing/duplicate layout start');
  assert.equal(source.split(end).length, 2, 'Missing/duplicate layout end');
  const a = source.indexOf(begin), b = source.indexOf(end);
  assert(b > a, 'Reversed layout markers');
  return source.slice(0, a) + sil + source.slice(b + end.length);
}
export async function syncLayout({write = false} = {}) {
  const {sil, ts} = await layoutProjections();
  const updates = [];
  for (const name of ['open', 'sealed', 'refunding']) {
    const file = path.join(root, `contracts/${name}.sil`), source = await fs.readFile(file, 'utf8');
    updates.push([file, source, replaceLayoutBlock(source, sil)]);
  }
  const file = path.join(root, 'scripts/core/src/ledger-layout.ts');
  updates.push([file, await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; }), ts]);
  // All marker/schema checks precede writes; a write error can still leave partial source updates.
  // Re-run --check before compilation. Never touch lib/ or historical build evidence.
  for (const [file, old, next] of updates) {
    if (write) { if (old !== next) await fs.writeFile(file, next); }
    else assert.equal(old, next, `Layout projection drift: ${path.relative(root, file)}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  assert(process.argv.length === 3 && ['--check', '--write'].includes(mode), 'Usage: node scripts/contract/sync-layout.mjs --check|--write');
  await syncLayout({write: mode === '--write'});
  console.log(`KW21 source layout ${mode === '--write' ? 'projected' : 'matches'}; bytecode/VM/Profile approval NOT established.`);
}
