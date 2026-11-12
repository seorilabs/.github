import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBettaInternalContext, chooseBettaAttempt } from '../scripts/release/betta-internal-bootstrap.mjs';

const sourceSha='a'.repeat(40), digest='b'.repeat(64);
const grant=()=>({schemaVersion:1,id:'betta-first-internal',kind:'betta-first-internal',repository:'seorilabs/betta-raising',sourceSha,
  releaseTag:'v0.1.0',targets:['google-play'],configurationFingerprint:digest,productTreeSha256:digest,approvedAt:'2026-11-13T00:00:00Z',expiresAt:'2026-11-19T00:00:00Z',
  revoked:false,maxBuildsPerMarket:2,maxAcceptedUploadsPerMarket:1,publicReleaseAllowed:false,
  allowedErrors:['THREE_UI_ROUNDS_REQUIRED'],googlePlay:{packageName:'com.seorilabs.bettaraising',accountId:'7593567020638200144',versionCode:1,certificateSha256:digest,workflowPath:'.github/workflows/deploy-google-play.yml'},
  appStore:{bundleId:'com.seorilabs.bettaraising',appId:'12345',productId:'product',workflowId:'workflow',scheme:'BettaAtelier',teamId:'HCDUXX4Z3X',profileUuid:'uuid',profileSha256:digest,certificateSha256:digest,initialBuildNumber:'1'},
  ciRunId:'1',originalObservationAssets:[{name:'review-history.json',sha256:digest}],evidenceSha256:digest,inventorySha256:digest,approvalFile:'docs/approval.json',approvalSha256:digest,proposalFile:'docs/proposal.md',proposalSha256:digest,verifierCommit:'c'.repeat(40)});
const context=()=>({repository:'seorilabs/betta-raising',sourceSha,tag:'v0.1.0',configurationFingerprint:digest,target:'google-play',phase:'before-build',playTrack:'internal',playOperation:'upload',now:'2026-11-13T01:00:00Z'});
test('explicit internal exception preserves the original failed verdict',()=>{
  const original={ok:false,errors:['THREE_UI_ROUNDS_REQUIRED']};
  const result=validateBettaInternalContext(grant(),context(),original);
  assert.equal(result.decisionStatus,'human_exception');assert.equal(result.productE2eStatus,'blocked');
  assert.equal(result.publicReleaseAllowed,false);assert.deepEqual(result.originalVerdict,original);
});
test('a normal pass is never relabeled as an exception',()=>assert.throws(()=>validateBettaInternalContext(grant(),context(),{ok:true,errors:[]})));
for(const patch of [{phase:'before-release'},{target:'web'},{playTrack:'production'},{playTrack:'beta'},{playOperation:'promote'},{sourceSha:'d'.repeat(40)},{tag:'v0.1.1'},{configurationFingerprint:'e'.repeat(64)},{repository:'seorilabs/other'},{now:'2026-11-19T00:00:00Z'},{now:'2026-11-12T23:59:59Z'}]){
  test(`reject context ${JSON.stringify(patch)}`,()=>assert.throws(()=>validateBettaInternalContext(grant(),{...context(),...patch},{ok:false,errors:['THREE_UI_ROUNDS_REQUIRED']})));
}
for(const patch of [{revoked:true},{publicReleaseAllowed:true},{maxBuildsPerMarket:3},{maxAcceptedUploadsPerMarket:2},{expiresAt:'2026-11-21T00:00:00Z'},{unexpected:true}]){
  test(`reject grant ${JSON.stringify(patch)}`,()=>assert.throws(()=>validateBettaInternalContext({...grant(),...patch},context(),{ok:false,errors:['THREE_UI_ROUNDS_REQUIRED']})));
}
for(const error of ['CANDIDATE_MISMATCH','INVALID_EVIDENCE_JSON','CI_RUN_UNVERIFIED','RELEASE_NOT_AUTHORIZED','EVIDENCE_SCHEMA']){
  test(`cannot waive ${error}`,()=>assert.throws(()=>validateBettaInternalContext({...grant(),allowedErrors:[error]},context(),{ok:false,errors:[error]})));
}
test('new failures are not silently included',()=>assert.throws(()=>validateBettaInternalContext(grant(),context(),{ok:false,errors:['THREE_UI_ROUNDS_REQUIRED','RUN_COVERAGE missing']})));
test('first attempt and same producer phase verification are idempotent',()=>{
  assert.equal(chooseBettaAttempt([], 'run-1'),1);
  assert.equal(chooseBettaAttempt([{attempt:1,producer:'run-1',state:'in_progress'}], 'run-1'),1);
});
test('one bounded retry requires confirmed terminal failure with no accepted upload',()=>{
  assert.equal(chooseBettaAttempt([{attempt:1,producer:'run-1',state:'failed',providerVerified:true,acceptedUpload:false}], 'run-2'),2);
  for(const state of ['in_progress','unknown','processing','succeeded'])assert.throws(()=>chooseBettaAttempt([{attempt:1,producer:'run-1',state,providerVerified:true,acceptedUpload:false}], 'run-2'));
  assert.throws(()=>chooseBettaAttempt([{attempt:1,producer:'run-1',state:'failed',providerVerified:false,acceptedUpload:false}], 'run-2'));
  assert.throws(()=>chooseBettaAttempt([{attempt:1,producer:'run-1',state:'failed',providerVerified:true,acceptedUpload:true}], 'run-2'));
});
test('a third build never receives a claim',()=>assert.throws(()=>chooseBettaAttempt([{attempt:1,producer:'run-1',state:'failed',providerVerified:true,acceptedUpload:false},{attempt:2,producer:'run-2',state:'failed',providerVerified:true,acceptedUpload:false}], 'run-3')));
