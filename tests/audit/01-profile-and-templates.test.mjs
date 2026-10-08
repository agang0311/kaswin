// 01-profile-and-templates.test.mjs: Verify contract Profile, linking chain, dispatch tags and template hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadV2Bundle} from '../../contracts/f3.2/tools/linking.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CONTRACTS = path.join(ROOT, 'contracts/f3.2');

test('01.1 Profile and pins load consistently with new 432000 DAA profile', async () => {
  const {pins, profile} = await loadV2Bundle(CONTRACTS);
  const EXPECTED_PROFILE = '7aaf76fe5e2180070290ff984bebaef54e41093e6a77eef24f2b48fb64c159c8';
  assert.equal(profile.id, EXPECTED_PROFILE, 'Profile ID must match 7aaf76fe...');
  assert.equal(pins.profileId, EXPECTED_PROFILE, 'pins.json profileId must match');
  assert.equal(pins.protocolVersion, 2);
  assert.equal(pins.networkGenesis, 'f896a3034873be1739fc4359236899fd3d65d2bc94f9780df0d0da3eb1cc4370');
  assert.equal(pins.budgetProfileId, null, 'budgetProfileId must remain null pending calibration');
});

test('01.2 Chained template hashes match exact bytecode dependencies', async () => {
  const {profile} = await loadV2Bundle(CONTRACTS);
  const REFUNDING_HASH = '7c5666912cbb968399cf47fedbcc8a4fb05406c81ae45aa8c25b9723793e784f';
  const SEALED_HASH    = '6932bc280ccda1c5117caa7308bacc0d71c9fa03e636b4aa5ee90b06045c8762';
  const OPEN_HASH      = 'dc08d1ce4f7818d02c44cf828c677f4ae33a3304341e33256fd0c1fb80c31832';

  assert.equal(profile.frames.refunding.templateHash, REFUNDING_HASH);
  assert.equal(profile.frames.sealed.templateHash, SEALED_HASH);
  assert.equal(profile.frames.open.templateHash, OPEN_HASH);

  // Check tail lengths (bytes)
  assert.equal(profile.frames.open.tail.length, 5764);
  assert.equal(profile.frames.sealed.tail.length, 6479);
  assert.equal(profile.frames.refunding.tail.length, 9880);

  // Check dispatch tags
  assert.equal(profile.frames.open.dispatchTag, '1c49a445');
  assert.equal(profile.frames.sealed.dispatchTag, 'f0c4e51b');
  assert.equal(profile.frames.refunding.dispatchTag, 'f0c4e51b');
});

test('01.3 Linking dependencies: open embeds sealed & refunding; sealed embeds refunding', async () => {
  const pinsRaw = JSON.parse(await fs.readFile(path.join(CONTRACTS, 'pins.json'), 'utf8'));
  const frames = pinsRaw.frames;

  assert.deepEqual(frames.refunding.dependencies, {}, 'Refunding has no foreign dependencies');
  assert.equal(frames.sealed.dependencies.refunding, frames.refunding.templateHash);
  assert.equal(frames.open.dependencies.sealed, frames.sealed.templateHash);
  assert.equal(frames.open.dependencies.refunding, frames.refunding.templateHash);
});
