/** Local candidate loader with an explicit Profile pin. Never trusts a fixture's synthetic state. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadCandidateProfile} from '../../scripts/rolling/core.mjs';
import {MODULES,check} from '../../scripts/rolling/core.mjs';
export const TN10_PROFILE_ID='b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5';
export async function loadDeploymentProfile() {
  const texts={},pins={},sha=s=>createHash('sha256').update(s).digest('hex');
  for(const m of MODULES) {
    texts[m]=await readFile(new URL(`artifacts/${m}.json`,import.meta.url),'utf8');
    const source=await readFile(new URL(`generated/${m}.sil`,import.meta.url),'utf8');
    pins[m]={artifactSha256:sha(texts[m]),sourceSha256:sha(source)};
  }
  const profile=loadCandidateProfile(texts,pins);check(profile.id===TN10_PROFILE_ID,'DEPLOYMENT_PROFILE_MISMATCH');return profile;
}
