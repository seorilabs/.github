import { bettaDigest } from './betta-internal-bootstrap.mjs';
const fail=code=>{throw new Error(code);};
export const BETTA_UPDATE_PROPOSAL={repository:'seorilabs/.github',commit:'aa29c3a48e82c1c59f44f8608484cb7b0f321d6e',file:'docs/design/2026-11-13-betta-repeat-internal/design.md'};

function codes(values){
  if(!Array.isArray(values) || values.some(v=>!Number.isSafeInteger(v) || v<1) || new Set(values).size!==values.length) fail('BETTA_UPDATE_PLAY_BASELINE');
  return [...values].sort((a,b)=>a-b);
}
function playBaseline(value){
  if(!Array.isArray(value?.tracks)) fail('BETTA_UPDATE_PLAY_BASELINE');
  const tracks=value.tracks.map(t=>{
    if(typeof t.track!=='string' || !t.track) fail('BETTA_UPDATE_PLAY_BASELINE');
    return {track:t.track,versionCodes:codes(t.versionCodes)};
  });
  if(new Set(tracks.map(t=>t.track)).size!==tracks.length) fail('BETTA_UPDATE_PLAY_BASELINE');
  return {bundleVersionCodes:codes(value.bundleVersionCodes),apkVersionCodes:codes(value.apkVersionCodes),tracks:tracks.filter(t=>t.versionCodes.length).sort((a,b)=>a.track.localeCompare(b.track))};
}
export function validateBettaUpdatePlayMarket(grant,market){
  const expected=playBaseline(grant.internalUpdate.googlePlayBaseline),observed=playBaseline(market);
  const oldCodes=[...expected.bundleVersionCodes,...expected.apkVersionCodes,...expected.tracks.flatMap(t=>t.versionCodes)];
  if(market.kind!=='google-play-version-code-readback' || market.status!=='READY' || market.packageName!==grant.googlePlay.packageName
    || !oldCodes.length || grant.googlePlay.versionCode<=Math.max(...oldCodes)
    || market.maxVersionCode!==Math.max(...observed.bundleVersionCodes,...observed.apkVersionCodes)
    || JSON.stringify(expected)!==JSON.stringify(observed)) fail('BETTA_UPDATE_PLAY_BASELINE');
}
export function validateBettaUpdateAppleMarket(grant,builds,uploads){
  const observed={builds:builds.map(b=>({id:b.id,version:b.attributes?.version,processingState:b.attributes?.processingState,preReleaseVersionId:b.relationships?.preReleaseVersion?.data?.id})).sort((a,b)=>a.id.localeCompare(b.id)),uploadIds:uploads.map(u=>u.id).sort()};
  const baseline=grant.internalUpdate.appleBaseline;
  const expected={builds:baseline.builds.map(b=>({id:b.id,version:b.version,processingState:b.processingState,preReleaseVersionId:b.preReleaseVersionId})).sort((a,b)=>a.id.localeCompare(b.id)),uploadIds:[...baseline.uploadIds].sort()};
  if(new Set(observed.builds.map(b=>b.id)).size!==builds.length || new Set(observed.uploadIds).size!==uploads.length
    || expected.builds.some(b=>b.processingState!=='VALID' || Number(b.version)>=Number(grant.appStore.initialBuildNumber))
    || JSON.stringify(expected)!==JSON.stringify(observed)) fail('BETTA_UPDATE_APPLE_BASELINE');
}
export function validateBettaUpdateApproval(grant,approval,proposal,comparison){
  const p=approval.centralProposal;
  if(approval.approverKind!=='human' || approval.centralChangeApprovalVerbatim!=='중앙 변경까지 승인하고 반영'
    || approval.approvedProductSource!==grant.internalUpdate.approvedProductSource || approval.plannedTag!==grant.releaseTag
    || approval.objective!=='internal_available' || !grant.targets.every(t=>approval.markets?.includes(t))
    || approval.operationalBuildLimitPerMarket!==1 || approval.acceptedUploadLimitPerMarket!==1
    || approval.deviceUseByAgent!==false || approval.publicRelease!==false || approval.gameMainMerge!==false
    || approval.newCredentialsOrPaidPlans!==false || approval.existingReviewFailuresMustRemain!==true
    || Date.parse(approval.originalApprovalExpiresAtUnchanged)!==Date.parse(grant.expiresAt)
    || p?.repository!==BETTA_UPDATE_PROPOSAL.repository || p?.commit!==BETTA_UPDATE_PROPOSAL.commit || p?.file!==BETTA_UPDATE_PROPOSAL.file
    || p?.sha256!==bettaDigest(proposal)) fail('BETTA_UPDATE_APPROVAL_SCOPE');
  if(!['ahead','identical'].includes(comparison.status) || !Array.isArray(comparison.files) || comparison.files.length>=300
    || comparison.files.some(f=>![f.filename,f.previous_filename].filter(Boolean).every(path=>/^docs\/design\/2026-11-13-drawer-fit\/[A-Za-z0-9_./-]+$/u.test(path)
      || /^xcode-cloud\/ci_scripts\/[A-Za-z0-9_.-]+$/u.test(path) || path==='app-store/app-store.config.json'))) fail('BETTA_UPDATE_PRODUCT_CHANGED');
}
