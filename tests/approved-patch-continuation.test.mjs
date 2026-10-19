import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyApprovedPatchContinuation, requiresApprovedPatchContinuation } from '../scripts/release/approved-patch-continuation.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errors = ['FEATURE_COVERAGE ux-1', 'FEATURE_COVERAGE functional-4', 'FEATURE_COVERAGE ux-4'];
function fixture() {
  const baselineSha = 'a'.repeat(40), sourceSha = 'b'.repeat(40), renderedSha = 'c'.repeat(40);
  const document = { schemaVersion: 1, kind: 'lizard-191-public-continuation', repository: 'seorilabs/lizard-tycoon', sourceSha, target: 'google-play',
    baselineEvidence: { schemaVersion: 2, repository: 'seorilabs/lizard-tycoon', sourceSha: baselineSha, target: 'google-play', reviewRounds: [{ number: 6, sourceSha: baselineSha, functional: { status: 'passed' }, ux: { status: 'passed' } }] },
    patchEvidence: { schemaVersion: 2, repository: 'seorilabs/lizard-tycoon', sourceSha, target: 'google-play', reviewRounds: [] },
    visualEvidence: { sourceSha: renderedSha, archiveId: 655706292 } };
  const context = { repository: document.repository, sourceSha, target: 'google-play', tag: 'v1.9.1', phase: 'before-build', now: '2026-10-19T10:00:00Z' };
  const grant = { schemaVersion: 2, kind: document.kind, id: 'lizard-191-public', repository: document.repository, sourceSha, baselineSha, renderedSha,
    approvedAt: '2026-10-19T09:02:41Z', expiresAt: '2026-10-26T03:59:05Z', envelopeHash: hash(document), baselineHash: hash(document.baselineEvidence), patchHash: hash(document.patchEvidence),
    treeSha: 'd'.repeat(40), archiveReleaseId: 417105241, archiveId: 655706292, archiveDigest: 'sha256:'+'e'.repeat(64), errors: [...errors], approvalEvidence: 'https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6263609549' };
  const baselineResult = { ok: false, level: 'L3', errors: [...errors], completedAt: '2026-10-19T05:27:14Z' };
  const patchResult = { ok: true, level: 'L1', errors: [], completedAt: '2026-10-19T08:44:00Z' };
  const proof = { candidateTree: grant.treeSha, renderedTree: grant.treeSha, archiveDigest: grant.archiveDigest, archivePublished: true };
  const calls = [];
  const dependencies = { validate: async (part, ctx) => { calls.push(ctx.sourceSha); return part === document.baselineEvidence ? baselineResult : patchResult; }, readProof: async () => proof };
  return { document, context, grant, baselineResult, patchResult, proof, dependencies, calls };
}
const run = f => verifyApprovedPatchContinuation(f.document, f.context, f.dependencies, [f.grant]);
for (const [phase, track, operation] of [['before-build', undefined, undefined], ['before-deploy','internal','upload'], ['before-release','production','promote']]) {
  test(`approved continuation passes ${phase} and preserves both original sources`, async () => {
    const f = fixture(); Object.assign(f.context,{phase,playTrack:track,playOperation:operation});
    const before = structuredClone(f.document), result = await run(f);
    assert.equal(result.ok,true); assert.equal(result.decisionStatus,'human_exception');
    assert.deepEqual(result.originalVerdict,f.baselineResult); assert.equal(result.originalVerdict.ok,false);
    assert.deepEqual(f.document,before); assert.deepEqual(f.calls,[f.document.patchEvidence.sourceSha,f.document.baselineEvidence.sourceSha]);
  });
}
for (const [name, mutate] of [
  ['wrong repository',f=>{f.context.repository='seorilabs/other';}], ['wrong candidate',f=>{f.context.sourceSha='f'.repeat(40);}],
  ['wrong tag',f=>{f.context.tag='v1.9.2';}], ['wrong market',f=>{f.context.target='app-store';}],
  ['production upload',f=>Object.assign(f.context,{phase:'before-deploy',playTrack:'production',playOperation:'upload'})],
  ['internal promotion',f=>Object.assign(f.context,{phase:'before-release',playTrack:'internal',playOperation:'promote'})],
  ['missing operation',f=>Object.assign(f.context,{phase:'before-release',playTrack:'production'})],
  ['missing track',f=>Object.assign(f.context,{phase:'before-deploy',playOperation:'upload'})],
  ['before approval',f=>{f.context.now='2026-10-19T09:00:00Z';}], ['expired',f=>{f.context.now=f.grant.expiresAt;}],
  ['extended expiry',f=>{f.grant.expiresAt='2026-10-26T06:00:00Z';}], ['invalid time',f=>{f.context.now='bad';}],
  ['changed envelope',f=>{f.document.visualEvidence.archiveId=4;}], ['changed baseline',f=>{f.document.baselineEvidence.sourceSha='f'.repeat(40);}],
  ['changed patch',f=>{f.document.patchEvidence.sourceSha='f'.repeat(40);}],
  ['new patch failure',f=>Object.assign(f.patchResult,{ok:false,errors:['RUN_EXPIRED current']})],
  ['extra baseline failure',f=>{f.baselineResult.errors.push('RUN_EXPIRED old');}],
  ['baseline ordinary pass',f=>Object.assign(f.baselineResult,{ok:true,errors:[]})],
  ['baseline not L3',f=>{f.baselineResult.level='L1';}],
  ['tree mismatch',f=>{f.proof.renderedTree='f'.repeat(40);}], ['archive mismatch',f=>{f.proof.archiveDigest='sha256:'+'f'.repeat(64);}], ['draft archive',f=>{f.proof.archivePublished=false;}],
  ['rollout outside approval',f=>{f.context.rollout=2;}], ['staged rollout',f=>{f.context.rollout=0.5;}],
]) test(`continuation denies ${name}`, async () => {const f=fixture();mutate(f);await assert.rejects(run(f));});
test('no registered grant and duplicate grants deny the envelope', async()=>{
  const f=fixture();await assert.rejects(verifyApprovedPatchContinuation(f.document,f.context,f.dependencies,[]));
  await assert.rejects(verifyApprovedPatchContinuation(f.document,f.context,f.dependencies,[f.grant,f.grant]));
});
test('normal validator and readback errors are not converted into exceptions',async()=>{
  const f=fixture();f.dependencies.validate=async()=>{throw new Error('CI readback failed');};await assert.rejects(run(f),/CI readback failed/);
  const g=fixture();g.dependencies.readProof=async()=>{throw new Error('provider denied');};await assert.rejects(run(g),/provider denied/);
});
test('latest baseline review must actually be passed even with rebound envelope hash',async()=>{
  const f=fixture();f.document.baselineEvidence.reviewRounds[0].ux.status='failed';
  f.grant.baselineHash=hash(f.document.baselineEvidence);f.grant.envelopeHash=hash(f.document);
  await assert.rejects(run(f),/LATEST_REVIEW/);
});
test('checked-in continuation grant freezes this Android candidate and original expiry',async()=>{
  const {readFileSync}=await import('node:fs');
  const g=JSON.parse(readFileSync('contracts/historical-review-coverage/lizard-tycoon-1.9.1.json'));
  assert.equal(g.sourceSha,'da203979846fdcf4fb5b591689d776d84fe14911');
  assert.equal(g.baselineSha,'055aae4422610e279417f3f3a7d2b9007cb1754d');
  assert.equal(g.renderedSha,'001a8d9bec627c3d73ac8d258e0fb733202a38db');
  assert.equal(g.expiresAt,'2026-10-26T03:59:05Z');
  for (const key of ['envelopeHash','baselineHash','patchHash']) assert.match(g[key],/^[a-f0-9]{64}$/);
  assert.equal(g.archiveId,655801246); assert.equal(g.archiveReleaseId,417105241);
});

test('registered Android candidate requires its envelope after expiry without changing other markets',()=>{
  const f=fixture();assert.equal(requiresApprovedPatchContinuation(f.context,[f.grant]),true);
  assert.equal(requiresApprovedPatchContinuation({...f.context,now:'2026-11-01T00:00:00Z'},[f.grant]),true);
  assert.equal(requiresApprovedPatchContinuation({...f.context,target:'app-store'},[f.grant]),false);
  assert.equal(requiresApprovedPatchContinuation({...f.context,target:'web'},[f.grant]),false);
  assert.equal(requiresApprovedPatchContinuation({...f.context,sourceSha:'f'.repeat(40)},[f.grant]),false);
  assert.equal(requiresApprovedPatchContinuation(f.context,[]),false);
});

for (const [name, mutate] of [
  ['draft',release=>{release.draft=true;}],
  ['missing draft field',release=>{delete release.draft;}],
  ['wrong tag',release=>{release.tag_name='v1.9.0';}],
  ['missing archive',release=>{release.assets=[];}],
]) test(`live proof denies ${name} API response`,async()=>{
  const {readContinuationProof}=await import('../scripts/release/verify-development-evidence.mjs');
  const f=fixture(), release={draft:false,tag_name:'v1.9.1',assets:[{id:f.grant.archiveId,digest:f.grant.archiveDigest}]};
  const request={token:'fixture-token',fetchImpl:async url=>{
    const value=url.includes('/git/commits/')?{tree:{sha:f.grant.treeSha}}
      :url.includes('/releases/assets/')?{digest:f.grant.archiveDigest}:release;
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  }};
  f.dependencies.readProof=()=>readContinuationProof(f.context.repository,f.grant,request);
  assert.equal((await run(f)).ok,true);
  mutate(release);
  await assert.rejects(run(f),/VISUAL_READBACK/);
});
test('remote release path rejects an ordinary L1 document for the registered candidate',async()=>{
  const {verifyReleaseDevelopmentEvidence}=await import('../scripts/release/verify-development-evidence.mjs');
  const {readFileSync}=await import('node:fs');
  const g=JSON.parse(readFileSync('contracts/historical-review-coverage/lizard-tycoon-1.9.1.json'));
  const reply=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
  const fetchImpl=async url=>{
    if(url.includes('/releases/tags/'))return reply({id:123});
    if(url.includes('/releases/123/assets?'))return reply([{id:124,size:100,name:'development-evidence.google-play.before-build.json'}]);
    if(url.endsWith('/releases/assets/124'))return reply({schemaVersion:2,sourceSha:g.sourceSha,target:'google-play'});
    throw Error('Unexpected read before envelope guard');
  };
  await assert.rejects(verifyReleaseDevelopmentEvidence({repository:g.repository,sourceSha:g.sourceSha,target:'google-play',phase:'before-build',tag:'v1.9.1',token:'fixture-token',fetchImpl}),/APPROVED_PATCH_CONTINUATION_REQUIRED/);
});
