// Bundle provenance: V2.0.2 source candidate linking; runtime loading still requires an approved core/Profile.
// No compiler, network or wallet side effects in this module.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {parseCompiledFrame, makeProfile, COMPILER_COMMIT} from '../core/lib/artifacts.js';
import {MODULES, CONTRACT_VERSION as VERSION, profileId} from '../core/lib/state.js';
import {layoutProjections, replaceLayoutBlock} from './sync-layout.mjs';

export const ORDER = ['refunding', 'sealed', 'open'];
export const DEPENDENCIES = {refunding: [], sealed: ['refunding'], open: ['sealed', 'refunding']};
export const COMPILER_SHA256 = '81de9aa4157dbde3633ebab629e86c5975770fc13ee2d2093e52d7f725616a00';
export const NETWORK_GENESIS = 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370';
export const sha256 = b => createHash('sha256').update(b).digest('hex');
const HASH = /^[0-9a-f]{64}$/;
/** Source markers every V2.0.2 candidate template must carry; not an approval or equivalence proof. */
export const REQUIRED_MARKERS = {
  open: ['Kaswin OPEN Covenant V2.0.2', 'int constant HEADER_BYTES = 80;', 'int constant RECORD_BYTES = 36;', 'int constant DEPOSIT = 400000000;', 'byte[](0x4b573231)', 'for (fo, 0, tx.outputs.length, 2)', 'tx.outputs.length <= 2);', 'require(totalIn - totalOut == fee);'],
  sealed: ['Kaswin SEALED Covenant V2.0.2', 'int constant HEADER_BYTES = 80;', 'int constant RECORD_BYTES = 36;', 'int constant DEPOSIT = 400000000;', 'byte[](0x4b573231)', 'for (fo, 0, tx.outputs.length, 3)', 'tx.outputs.length <= 3);', 'require(totalIn - totalOut == fee);',
    '+ byte[](0x0000000000000000));'],
  refunding: ['Kaswin REFUNDING Covenant V2.0.2', 'int constant HEADER_BYTES = 80;', 'int constant RECORD_BYTES = 36;', 'int constant DEPOSIT = 400000000;', 'int constant REFUND_FEE = 2000000;', 'byte[](0x4b573231)', 'for (fo, 0, tx.outputs.length, 34)',
    'ordinary(a10Batch + 1, externalValue + a10Pool - fee, actorPk);', 'ordinary(a10Batch, DEPOSIT - REFUND_FEE, ownerKey());', 'require(totalIn - totalOut == fee);'],
};
export function checkTemplate(module, source) {
  for (const m of REQUIRED_MARKERS[module]) assert.ok(source.includes(m), `${module}: V2.0.2 source marker missing: ${m}`);
  assert.ok(!source.includes('0x4b573230'), `${module}: old KW20 magic present`);
}
export function linkSource(module, source, frames) {
  assert.ok(ORDER.includes(module), 'Unknown module');
  const names = [...source.matchAll(/byte\[32\] constant ([A-Z]+)_TEMPLATE_HASH = byte\[32\]\(0x([0-9a-f]{64})\);/g)].map(m => m[1].toLowerCase());
  assert.deepEqual(names, DEPENDENCIES[module], `${module}: unexpected forward dependencies`);
  let linked = source;
  for (const dependency of DEPENDENCIES[module]) {
    const hash = frames[dependency]?.templateHash;
    assert.ok(HASH.test(hash ?? '') && hash !== '00'.repeat(32), `${module}: missing ${dependency} hash`);
    const marker = `byte[32] constant ${dependency.toUpperCase()}_TEMPLATE_HASH = byte[32](0x${'00'.repeat(32)});`;
    assert.equal(linked.split(marker).length, 2, `${module}: missing/duplicate placeholder`);
    linked = linked.replace(marker, `byte[32] constant ${dependency.toUpperCase()}_TEMPLATE_HASH = byte[32](0x${hash});`);
  }
  return linked;
}
/** Structural candidate inspection only: returns frames and computed identity, never a trusted runtime Profile. */
export async function inspectBundle(dir) {
  const pins = JSON.parse(await fs.readFile(path.join(dir, 'pins.json'), 'utf8'));
  assert.equal(pins.contractVersion, 'V2.0.2', 'Not a V2.0.2 source bundle');
  const layout = await fs.readFile(path.join(dir, 'ledger-layout.json'));
  assert.equal(sha256(layout), pins.layoutSha256, 'Layout provenance drift');
  const {sil} = await layoutProjections(dir);
  assert.equal(pins.compilerCommit, COMPILER_COMMIT); assert.equal(pins.compilerBinarySha256, COMPILER_SHA256);
  assert.equal(pins.networkGenesis, NETWORK_GENESIS);
  assert.deepEqual(Object.keys(pins.frames).sort(), [...MODULES].sort());
  const frames = {};
  for (const module of ORDER) {
    const pin = pins.frames[module];
    assert.deepEqual(pin.dependencies, Object.fromEntries(DEPENDENCIES[module].map(m => [m, frames[m].templateHash])), `${module}: dependency drift`);
    const template = await fs.readFile(path.join(dir, `${module}.sil`), 'utf8');
    checkTemplate(module, template);
    assert.equal(template, replaceLayoutBlock(template, sil), `${module}: layout projection drift`);
    const linked = await fs.readFile(path.join(dir, `artifacts/${module}-linked.sil`), 'utf8');
    const artifact = await fs.readFile(path.join(dir, `artifacts/${module}-linked.json`));
    const args = await fs.readFile(path.join(dir, `artifacts/${module}-linked.args.json`));
    assert.equal(sha256(template), pin.templateSourceSha256, `${module}: template drift`);
    assert.equal(linked, linkSource(module, template, frames), `${module}: wrong linked dependency`);
    assert.equal(sha256(linked), pin.sourceSha256, `${module}: linked source drift`);
    assert.equal(sha256(artifact), pin.artifactSha256, `${module}: artifact drift`);
    assert.equal(sha256(args), pin.constructorArgsSha256, `${module}: constructor drift`);
    const frame = parseCompiledFrame(module, JSON.parse(artifact.toString('utf8')), pin.sourceSha256);
    assert.equal(frame.templateHash, pin.templateHash); assert.equal(frame.tail.length, pin.tailBytes);
    frames[module] = frame;
  }
  const computedId = profileId(frames);
  assert.equal(computedId, pins.profileId, 'Profile ID differs from pins');
  const serialized = Object.fromEntries(MODULES.map(m => [m, {...frames[m], tail: Buffer.from(frames[m].tail).toString('hex')}]));
  const metadata = JSON.parse(await fs.readFile(path.join(dir, 'profile.json'), 'utf8'));
  assert.deepEqual(metadata, {id: computedId, contractVersion: pins.contractVersion, compilerCommit: COMPILER_COMMIT, frames: serialized}, 'Profile metadata drift');
  const report = JSON.parse(await fs.readFile(path.join(dir, 'artifacts/build-report.json'), 'utf8'));
  assert.equal(report.profileId, computedId); assert.equal(report.contractVersion, pins.contractVersion);
  assert.equal(report.compilerCommit, COMPILER_COMMIT); assert.equal(report.compilerBinarySha256, COMPILER_SHA256);
  assert.equal(report.layoutSha256, pins.layoutSha256);
  assert.deepEqual(report.compileOrder, ORDER); assert.deepEqual(report.frames, serialized);
  return {pins, frames, computedId};
}
/** Trusted runtime loader: integrity is necessary, but cannot grant approval to a new Profile. */
export async function loadBundle(dir) {
  const pins = JSON.parse(await fs.readFile(path.join(dir, 'pins.json'), 'utf8'));
  assert.notEqual(pins.approvalStatus, 'UNAPPROVED_CANDIDATE', 'Candidate requires explicit Profile review before runtime use');
  assert.equal(pins.contractVersion, VERSION, 'Bundle/core version mismatch');
  const inspected = await inspectBundle(dir);
  assert.deepEqual(inspected.pins, pins, 'Pins changed during load');
  const profile = makeProfile(inspected.frames); // exact approved ID + actual content; no bypass option
  return {pins: inspected.pins, frames: inspected.frames, profile};
}
