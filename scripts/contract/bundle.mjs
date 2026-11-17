/** Local candidate loader with an explicit Profile pin. Never trusts a fixture's synthetic state. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadCandidateProfile,MODULES,check} from '../core.mjs';
export const TN10_PROFILE_ID='b56bcd9cb654610b238a32bae25c41128ebd2837cc7a91b3ea835f8a102fc4e5';
export async function loadDeploymentProfile() {
  const pinned=JSON.parse(await readFile(new URL('../../contracts/pins.json',import.meta.url),'utf8'));
  check(pinned?.profileId===TN10_PROFILE_ID&&pinned?.status==='UNVALIDATED','DEPLOYMENT_PIN_METADATA');
  const texts={},pins={},sha=s=>createHash('sha256').update(s).digest('hex');
  for(const m of MODULES) {
    const spec=pinned.modules?.[m];check(spec,'DEPLOYMENT_MODULE_PIN');
    texts[m]=await readFile(new URL(`../../contracts/artifacts/${m}.json`,import.meta.url),'utf8');
    const source=await readFile(new URL(`../../contracts/${m}.sil`,import.meta.url),'utf8');
    const artifactSha256=sha(texts[m]),sourceSha256=sha(source);
    check(artifactSha256===spec.artifactSha256&&sourceSha256===spec.sourceSha256,'DEPLOYMENT_ARTIFACT_PIN');
    pins[m]={artifactSha256,sourceSha256};
  }
  const profile=loadCandidateProfile(texts,pins);
  check(profile.id===TN10_PROFILE_ID&&MODULES.every(m=>profile.frames[m].templateHash===pinned.modules[m].templateHash),'DEPLOYMENT_PROFILE_MISMATCH');
  return profile;
}
