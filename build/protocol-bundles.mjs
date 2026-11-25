/** Build-time loader for installed covenant protocol artifacts.
 * Adding a new covenant protocol only requires registering its artifact loader here
 * and its runtime factory in scripts/protocols/installed.mjs — build.mjs and web/ stay untouched. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function loadInstalledProtocolBundles(root, defaultNet) {
  const {loadDeploymentProfile, TN10_PROFILE_ID} = await import('../scripts/contract/bundle.mjs');
  const {profileToData} = await import('../scripts/contract/profile-data.mjs');
  const {TN10_PROFILE_ID: CLIENT_PROFILE_ID} = await import('../scripts/contract/protocol.mjs');
  const {verifyKcc20Suffix} = await import('../scripts/protocols/kusdt-v2/codec.mjs');
  const {loadKusdtV2Profile} = await import('../scripts/protocols/kusdt-v2/profile.mjs');
  const {unhex} = await import('../scripts/core.mjs');

  assert.equal(CLIENT_PROFILE_ID, TN10_PROFILE_ID, 'client/deployment Profile constants differ');

  // 1) Rolling v1 (KAS)
  const rollingProfile = await loadDeploymentProfile();
  const rollingData = profileToData(rollingProfile);
  assert.equal(rollingData.id, TN10_PROFILE_ID);
  assert.equal(rollingData.status, 'UNVALIDATED');

  // 2) kUSDT v2 (256 parallel shards, KCC-20)
  const kusdtPinsRaw = JSON.parse(await fs.readFile(path.join(root, 'contracts/kusdt-v2/artifacts/template-pins.json'), 'utf8'));
  const kusdtKcc20SuffixRaw = JSON.parse(await fs.readFile(path.join(root, 'contracts/kusdt-v2/artifacts/kcc20-suffix.json'), 'utf8'));
  verifyKcc20Suffix(unhex(kusdtKcc20SuffixRaw.suffixHex));
  const kusdtArtifacts = {};
  const kusdtExpectedHashes = {};
  for (const name of kusdtPinsRaw.order) {
    kusdtArtifacts[name] = JSON.parse(await fs.readFile(path.join(root, `contracts/kusdt-v2/artifacts/${name}.json`), 'utf8'));
    kusdtExpectedHashes[name] = kusdtPinsRaw.templates[name].templateHash;
  }
  const kusdtProfile = loadKusdtV2Profile(kusdtArtifacts, {
    kusdtCid: kusdtPinsRaw.kusdtCid,
    expectedHashes: kusdtExpectedHashes,
  });

  const protocolBundles = [
    {
      id: 'rolling-v1',
      expectedProfileId: TN10_PROFILE_ID,
      profileData: rollingData,
    },
    {
      id: 'kusdt-v2',
      expectedProfileId: kusdtProfile.id,
      artifacts: kusdtArtifacts,
      pins: {kusdtCid: kusdtPinsRaw.kusdtCid, templates: kusdtExpectedHashes},
      kcc20SuffixHex: kusdtKcc20SuffixRaw.suffixHex,
    },
  ];

  const contractInputPaths = [
    'build/protocol-bundles.mjs',
    'contracts/pins.json',
    'contracts/toolchain.json',
    'contracts/kusdt-v2/artifacts/template-pins.json',
    'contracts/kusdt-v2/artifacts/kcc20-suffix.json',
    ...kusdtPinsRaw.order.flatMap(n => [`contracts/kusdt-v2/artifacts/${n}.json`, `contracts/kusdt-v2/${n}.sil`]),
    ...Object.keys(rollingProfile.frames).flatMap(m => [`contracts/artifacts/${m}.json`, `contracts/${m}.sil`]),
  ];

  const compatibleProfiles = [
    {protocolId: 'rolling-v1', name: `${defaultNet.unit} (Rolling v1)`, asset: defaultNet.unit, profileId: TN10_PROFILE_ID},
    {protocolId: 'kusdt-v2', name: 'kUSDT v2 (KCC-20)', asset: 'kUSDT', profileId: kusdtProfile.id, tokenCovenantId: kusdtPinsRaw.kusdtCid},
  ];

  return {
    protocolBundles,
    defaultCreateProfileId: TN10_PROFILE_ID,
    defaultUiCreateId: 'kusdt-v2',
    primaryProfileId: TN10_PROFILE_ID,
    primaryVersion: 'Rolling v1',
    evidence: rollingData.status,
    compatibleProfiles,
    contractInputPaths,
  };
}
