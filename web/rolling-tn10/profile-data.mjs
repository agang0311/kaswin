/** Browser-side fixed Profile. The build inlines authenticated frames; here the page re-derives the Profile id
 * (assertProfile) and refuses any id other than the authorized experimental candidate. No fs/crypto module. */
import {assertProfile,COMPILER_COMMIT} from '../../scripts/rolling/core.mjs';
import {MODULES,check,unhex,hex} from '../../scripts/rolling/core.mjs';
import {TN10_PROFILE_ID} from './protocol.mjs';
export function profileFromData(data) {
  check(data&&data.id===TN10_PROFILE_ID&&data.compilerCommit===COMPILER_COMMIT&&data.status==='UNVALIDATED','PROFILE_DATA');
  const frames={};
  for(const m of MODULES) {
    const f=data.frames?.[m];check(f,'PROFILE_DATA');
    const tail=unhex(f.tail);check(tail.length>0&&hex(tail)===f.tail,'PROFILE_DATA');
    frames[m]={tail,templateHash:f.templateHash,dispatchTag:f.dispatchTag,sourceSha256:f.sourceSha256,artifactSha256:f.artifactSha256};
  }
  const profile={id:data.id,compilerCommit:COMPILER_COMMIT,frames,status:'UNVALIDATED'};
  assertProfile(profile);check(profile.id===TN10_PROFILE_ID,'PROFILE_ID');
  return profile;
}
/** Serialisable form (build time / tests). */
export function profileToData(profile) {
  return {id:profile.id,compilerCommit:profile.compilerCommit,status:profile.status,
    frames:Object.fromEntries(MODULES.map(m=>{const f=profile.frames[m];
      return [m,{tail:hex(f.tail),templateHash:f.templateHash,dispatchTag:f.dispatchTag,sourceSha256:f.sourceSha256,artifactSha256:f.artifactSha256}];}))};
}
