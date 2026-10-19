// 가상 입력이며 실제 제품의 SDK 실행 근거가 아니다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { requiresLizardIos191Continuation, verifyLizardIos191Continuation } from '../scripts/release/lizard-ios191-continuation.mjs';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { DESIGN, context, evidence, inventory, plan, run } from './helpers/test-levels-fixture.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ERRORS = ['FEATURE_COVERAGE ux-1', 'FEATURE_COVERAGE functional-4', 'FEATURE_COVERAGE ux-4'];
const CHECKS = ['consent-policy', 'sdk-completion', 'server-delivery', 'relaunch-no-duplicate'];
const KIND = 'lizard-ios191-submission-continuation';
const FP = 'd'.repeat(64);
function fixture() {
  const repository = 'seorilabs/lizard-tycoon', sourceSha = 'b'.repeat(40), baselineSha = 'a'.repeat(40);
  const rounds = [{ number: 6, sourceSha: baselineSha, functional: { status: 'passed' }, ux: { status: 'passed' } }];
  const inv = { ...inventory(), schemaVersion: 2, e2e: { workflow: '.github/workflows/godot-checks.yml' },
    features: inventory().features.map(f => f.id === 'ads' ? { ...f, platformPaths: ['native/ads/**'] } : f) };
  const native = evidence({ repository, sourceSha, target: 'app-store',
    runs: [run('dev', 'godot-headless-e2e', ['create','settings','store','purchase','ads'], { sourceSha, executor: 'dev-reviewer' })] });
  const nativeContext = context({ repository, sourceSha, target: 'app-store', featureInventory: inv,
    baselineInventories: { 'v1.0.0': { ...inv, features: inv.features.filter(f => f.id !== 'ads') } },
    changes: { 'v1.0.0': ['native/ads/bridge.mm'] },
    plans: { [DESIGN]: { approved: true, plan: plan({ level: 'L3', changedFeatures: ['ads'], release: { markets: ['app-store'], until: 'review-submitted' },
      platformValidation: [{ featureId: 'ads', target: 'app-store', kind: 'native-development', reason: '실제 SDK 확인', configurationFingerprint: FP, checks: CHECKS }] }) } } });
  const document = { schemaVersion: 1, kind: KIND, repository, sourceSha, target: 'app-store',
    baselineEvidence: { schemaVersion: 2, repository, sourceSha: baselineSha, target: 'app-store', reviewRounds: structuredClone(rounds) },
    patchEvidence: { schemaVersion: 2, repository, sourceSha, target: 'app-store', reviewRounds: structuredClone(rounds) },
    nativeEvidence: native, visualEvidence: { sourceSha: 'c'.repeat(40), archiveId: 655801246 } };
  const ctx = { repository, sourceSha, target: 'app-store', tag: 'v1.9.1', phase: 'before-build', now: '2026-10-19T12:00:00Z' };
  const grant = { schemaVersion: 2, kind: KIND, id: 'lizard-ios191', repository, sourceSha, target: 'app-store', tag: 'v1.9.1',
    baselineSha, renderedSha: document.visualEvidence.sourceSha, approvedAt: '2026-10-19T11:08:45Z', expiresAt: '2026-10-26T03:59:05Z',
    baselineHash: hash(document.baselineEvidence), patchHash: hash(document.patchEvidence), nativeBaseHash: hash(native),
    treeSha: 'e'.repeat(40), archiveReleaseId: 417105241, archiveId: 655801246, archiveDigest: 'sha256:'+'f'.repeat(64), errors: ERRORS,
    approvalEvidence: 'https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6265815627' };
  const baselineResult = { ok: false, level: 'L3', errors: [...ERRORS], completedAt: '2026-10-19T05:27:14Z' };
  const patchResult = { ok: false, level: 'L3', errors: [...ERRORS], completedAt: '2026-10-19T08:44:00Z' };
  const proof = { candidateTree: grant.treeSha, renderedTree: grant.treeSha, archiveDigest: grant.archiveDigest, archivePublished: true, tagSourceSha: sourceSha };
  const calls = [];
  const dependencies = { validate: async (part, c) => {
    calls.push([part.sourceSha,c.phase]);
    if (part === document.baselineEvidence) return baselineResult;
    if (part === document.patchEvidence) return patchResult;
    return validateDevelopmentEvidence(part, { ...nativeContext, ...c });
  }, readProof: async () => proof };
  return { document, context: ctx, grant, dependencies, calls, baselineResult, patchResult, proof };
}
const verify = f => verifyLizardIos191Continuation(f.document, f.context, f.dependencies, [f.grant]);
function addSdk(f) {
  f.document.nativeEvidence.runs.push(run('ios-sdk', 'native-development', ['ads'], { sourceSha: f.context.sourceSha,
    executor: 'independent-native-reviewer', target: 'app-store', build: 'QA 56', configurationFingerprint: FP,
    nativeSdk: { mode: 'real', runtime: 'ios-simulator', sdkNames: ['Google Mobile Ads'], artifact: { path: 'https://example.com/qa.app.zip', sha256: 'f'.repeat(64) }, limitations: 'Simulator-only SDK check' },
    scenarios: CHECKS.map(id => ({ id, status: 'passed', featureIds: ['ads'], evidence: ['https://example.com/'+id] })) }));
}
for (const phase of ['before-build','before-deploy']) test(`preserves old failures while allowing ${phase} without claiming SDK execution`, async () => {
  const f = fixture(); f.context.phase = phase; const before = structuredClone(f.document), result = await verify(f);
  assert.equal(result.ok,true); assert.equal(result.decisionStatus,'human_exception');
  assert.deepEqual(result.originalVerdict,f.baselineResult); assert.deepEqual(result.patchVerdict,f.patchResult);
  assert.equal(result.nativeVerdict.ok,true); assert.deepEqual(f.document,before); assert.equal(f.calls.length,3);
});
test('submission stays blocked until the same candidate passes the existing real SDK plan', async () => {
  const f = fixture(); f.context.phase = 'before-release';
  await assert.rejects(verify(f),/NATIVE_VALIDATION.*platform-first ads ios/s);
  addSdk(f); const result = await verify(f); assert.equal(result.ok,true); assert.equal(result.nativeVerdict.ok,true);
});
for (const check of CHECKS) test(`submission rejects missing real SDK check ${check}`, async () => {
  const f=fixture(); f.context.phase='before-release'; addSdk(f);
  f.document.nativeEvidence.runs[1].scenarios=f.document.nativeEvidence.runs[1].scenarios.filter(s=>s.id!==check);
  await assert.rejects(verify(f),/NATIVE_VALIDATION/);
});
for (const [name, mutate] of [
  ['another repo',f=>{f.context.repository='seorilabs/other';}],
  ['another candidate',f=>{f.context.sourceSha='f'.repeat(40);}],
  ['Google Play',f=>{f.context.target='google-play';}], ['AppsInToss',f=>{f.context.target='apps-in-toss';}],
  ['another tag',f=>{f.context.tag='v1.9.2';}], ['unknown phase',f=>{f.context.phase='anything';}],
  ['before approval',f=>{f.context.now='2026-10-19T10:00:00Z';}], ['expiry',f=>{f.context.now=f.grant.expiresAt;}],
  ['expiry extension',f=>{f.grant.expiresAt='2026-10-26T12:00:00Z';}],
  ['changed baseline',f=>{f.document.baselineEvidence.sourceSha='f'.repeat(40);}],
  ['changed current evidence',f=>{f.document.patchEvidence.sourceSha='f'.repeat(40);}],
  ['changed SDK plan',f=>{f.document.nativeEvidence.designs[0].approvedCommit='f'.repeat(40);}],
  ['omitted native document',f=>{delete f.document.nativeEvidence;}],
  ['unknown envelope field',f=>{f.document.skipSdk=true;}],
  ['new baseline error',f=>{f.baselineResult.errors.push('RUN_EXPIRED old');}],
  ['new current error',f=>{f.patchResult.errors.push('RUN_EXPIRED current');}],
  ['ordinary current pass',f=>Object.assign(f.patchResult,{ok:true,errors:[]})],
  ['wrong archive',f=>{f.document.visualEvidence.archiveId=1;}],
  ['different tree',f=>{f.proof.renderedTree='f'.repeat(40);}],
  ['different archive bytes',f=>{f.proof.archiveDigest='sha256:'+'a'.repeat(64);}],
  ['unpublished archive',f=>{f.proof.archivePublished=false;}],
  ['moved tag',f=>{f.proof.tagSourceSha='f'.repeat(40);}],
]) test(`rejects ${name}`,async()=>{ const f=fixture(); mutate(f); await assert.rejects(verify(f)); });
for (const [name,mutate] of [
  ['wrong market',r=>{r.target='google-play';}], ['wrong platform',r=>{r.nativeSdk.runtime='android-emulator';}],
  ['wrong source',r=>{r.sourceSha='f'.repeat(40);}], ['wrong config',r=>{r.configurationFingerprint='e'.repeat(64);}],
  ['self execution',r=>{r.executor='author-agent';}], ['fake SDK',r=>{r.nativeSdk.mode='fake';}],
  ['missing artifact',r=>{delete r.nativeSdk.artifact.sha256;}],
]) test(`normal SDK validation rejects ${name}`,async()=>{
  const f=fixture(); f.context.phase='before-release'; addSdk(f); mutate(f.document.nativeEvidence.runs[1]); await assert.rejects(verify(f));
});
test('failure and provider exceptions propagate; no or duplicate grant cannot authorize',async()=>{
  for (const grants of [[],[fixture().grant,fixture().grant]]) { const f=fixture(); await assert.rejects(verifyLizardIos191Continuation(f.document,f.context,f.dependencies,grants)); }
  const f=fixture(); f.dependencies.validate=async()=>{throw Error('CI unavailable');}; await assert.rejects(verify(f),/CI unavailable/);
  const g=fixture(); g.dependencies.readProof=async()=>{throw Error('proof unavailable');}; await assert.rejects(verify(g),/proof unavailable/);
});
test('historical round bytes and last passed original SHA cannot be rewritten with a new digest',async()=>{
  const f=fixture(); f.document.patchEvidence.reviewRounds[0].sourceSha=f.context.sourceSha;
  f.grant.patchHash=hash(f.document.patchEvidence); await assert.rejects(verify(f),/HISTORICAL_REVIEW/);
  const g=fixture(); g.document.baselineEvidence.reviewRounds[0].ux.status='failed'; g.document.patchEvidence.reviewRounds=structuredClone(g.document.baselineEvidence.reviewRounds);
  g.grant.baselineHash=hash(g.document.baselineEvidence); g.grant.patchHash=hash(g.document.patchEvidence); await assert.rejects(verify(g),/LATEST_REVIEW/);
});
test('only the registered App Store candidate requires the envelope, including after expiry',()=>{
  const f=fixture(); assert.equal(requiresLizardIos191Continuation(f.context,[f.grant]),true);
  assert.equal(requiresLizardIos191Continuation({...f.context,now:'2026-11-01T00:00:00Z'},[f.grant]),true);
  for(const target of ['google-play','apps-in-toss','web']) assert.equal(requiresLizardIos191Continuation({...f.context,target},[f.grant]),false);
  assert.equal(requiresLizardIos191Continuation({...f.context,sourceSha:'f'.repeat(40)},[f.grant]),false);
});

test('remote path refuses a plain v2 document for the registered candidate before reading its plans',async()=>{
  const {verifyReleaseDevelopmentEvidence}=await import('../scripts/release/verify-development-evidence.mjs');
  const {readFileSync}=await import('node:fs');
  const g=JSON.parse(readFileSync('contracts/historical-review-coverage/lizard-tycoon-ios-1.9.1.json'));
  const reply=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  const fetchImpl=async url=>{
    if(url.includes('/releases/tags/'))return reply({id:100});
    if(url.includes('/releases/100/assets?'))return reply([{id:101,size:100,name:'development-evidence.app-store.before-build.json'}]);
    if(url.endsWith('/releases/assets/101'))return reply({schemaVersion:2,repository:g.repository,sourceSha:g.sourceSha,target:g.target});
    throw Error('ordinary document reached plan lookup');
  };
  await assert.rejects(verifyReleaseDevelopmentEvidence({repository:g.repository,sourceSha:g.sourceSha,target:g.target,tag:g.tag,phase:'before-build',token:'fixture-token',fetchImpl}),/LIZARD_IOS191_CONTINUATION_REQUIRED/);
});
for(const [name,mutate] of [
  ['draft release',r=>{r.release.draft=true;}], ['wrong release tag',r=>{r.release.tag_name='v1.9.0';}],
  ['missing archive membership',r=>{r.release.assets=[];}], ['moved annotated tag',r=>{r.tag.object.sha='f'.repeat(40);}],
  ['wrong tag receipt',r=>{r.tag.message='seori-release-binding: 1\ntag: v1.9.0\nversion-name: 1.9.0\nsource-sha: '+'b'.repeat(40);}],
]) test(`live proof rejects ${name}`,async()=>{
  const {readLizardIos191Proof}=await import('../scripts/release/verify-development-evidence.mjs');
  const f=fixture(), data={release:{draft:false,tag_name:'v1.9.1',assets:[{id:f.grant.archiveId,digest:f.grant.archiveDigest}]},
    tag:{object:{type:'commit',sha:f.context.sourceSha},message:'seori-release-binding: 1\ntag: v1.9.1\nversion-name: 1.9.1\nsource-sha: '+f.context.sourceSha}};
  const request={token:'fixture-token',fetchImpl:async url=>{
    let value;
    if(url.includes('/git/commits/'))value={tree:{sha:f.grant.treeSha}};
    else if(url.includes('/releases/assets/'))value={digest:f.grant.archiveDigest};
    else if(url.includes('/git/ref/tags/'))value={object:{type:'tag',sha:'e'.repeat(40)}};
    else if(url.includes('/git/tags/'))value=data.tag;
    else value=data.release;
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  }};
  f.dependencies.readProof=()=>readLizardIos191Proof(f.context.repository,f.grant,request);
  assert.equal((await verify(f)).ok,true); mutate(data); await assert.rejects(verify(f),/VISUAL_READBACK/);
});
test('checked-in grant leaves native SDK validation mandatory and retires only this App Store candidate',async()=>{
  const {readFileSync}=await import('node:fs');
  const g=JSON.parse(readFileSync('contracts/historical-review-coverage/lizard-tycoon-ios-1.9.1.json'));
  assert.equal(g.target,'app-store');assert.equal(g.sourceSha,'da203979846fdcf4fb5b591689d776d84fe14911');
  assert.equal(g.baselineSha,'055aae4422610e279417f3f3a7d2b9007cb1754d');assert.equal(g.expiresAt,'2026-10-26T03:59:05Z');
  assert.equal(g.nativeSdkWaived,false);assert.equal(g.removal,'after-exact-app-store-review-submission-or-expiry');
  assert.deepEqual(g.errors,ERRORS);
});
test('read-only CI can read private evidence and its Actions runs without write permissions',async()=>{
  const {readFileSync}=await import('node:fs');
  const {parse}=await import('yaml');
  const workflow=parse(readFileSync('.github/workflows/verify-lizard-ios191.yml','utf8'));
  assert.deepEqual(workflow.permissions,{contents:'read',actions:'read'});
  for(const step of workflow.jobs.verify.steps.filter(step=>step.uses)) assert.match(step.uses,/@[a-f0-9]{40}$/);
});

// 승인 대체 경로의 가상 입력이다. 사용자 확인을 실행 records로 만들지 않는다.
function ownerFixture() {
  const f=fixture(); f.context.phase='before-release'; f.context.now='2026-10-19T15:00:00Z';
  const texts={
    confirmationJson: JSON.stringify({targetVersion:'1.9.1',targetBuild:'56',recordedAt:'2026-10-19T14:11:20Z',notObservedByAgent:true,notAddedToDevelopmentRuns:true,agentDeviceAccess:false,
      reportedRuntimeChecks:{'consent-policy':'user-confirmed','sdk-completion':'user-confirmed actual ad shown','server-delivery':'reward received per user; server record pending','relaunch-no-duplicate':'user-confirmed'}}),
    serverDeliveryJson: JSON.stringify({checkedAt:'2026-10-19T14:11:22Z',project:'seorilabs-platform',claimId:'claim-1',appId:'lizard-tycoon',clientPlatform:'ios',provider:'admob',placement:'rewarded_leaf_bonus',assurance:'server_verified',state:'delivered',createdAt:'2026-10-19T14:04:13Z',confirmedAt:'2026-10-19T14:05:07Z',acknowledgedAt:'2026-10-19T14:05:14Z',rewardKey:'leaf_bonus',rewardUnits:1,recentIosClaimCount:1,noWriteOperations:true,noDeviceOperations:true}),
    versionBuildJson: JSON.stringify({checkedAt:'2026-10-19T14:12:15Z',appId:'6786516830',bundleId:'com.seorilabs.lizardtycoon',candidateVersionBuilds:[{id:'build-56',version:'1.9.1',build:'56',state:'VALID',expired:false}],allRecent50BuildsChecked:50,serverOnlyNoDeviceAccess:true}),
    proposalMarkdown:'one fixed candidate proposal',
  };
  const digest=s=>createHash('sha256').update(s).digest('hex');
  const approval={approvedAt:'2026-10-19T14:20:00Z',status:'approved',userStatement:'근거로 인정하고 심사제출해.',proposalSha256:digest(texts.proposalMarkdown),approvalEvidence:'https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6269467251',repository:f.context.repository,sourceSha:f.context.sourceSha,tag:'v1.9.1',target:'app-store',phase:'before-release',version:'1.9.1',build:'56'};
  texts.approvalJson=JSON.stringify(approval);
  f.document.ownerEvidence={...texts,releaseArtifactSha256:'1'.repeat(64)};
  f.grant.ownerAcceptance={approvedAt:approval.approvedAt,approvalEvidence:approval.approvalEvidence,artifactSha256:'1'.repeat(64),claimId:'claim-1',buildId:'build-56',nativeErrors:['TEST_LEVEL_BELOW_FLOOR platform-first ads ios'],
    ...Object.fromEntries(Object.entries(texts).map(([key,value])=>[key+'Sha256',digest(value)]))};
  return f;
}
test('owner exception retains failed native verdict and never synthesizes a run',async()=>{
  const f=ownerFixture(), before=structuredClone(f.document);const result=await verify(f);
  assert.equal(result.ok,true);assert.equal(result.decisionStatus,'human_exception');
  assert.equal(result.nativeVerdict.ok,false);assert.deepEqual(result.nativeVerdict.errors,f.grant.ownerAcceptance.nativeErrors);
  assert.equal(result.nativeSdkStatus,'owner-and-server-accepted-by-human');assert.deepEqual(f.document,before);
});
for(const key of ['confirmationJson','serverDeliveryJson','versionBuildJson','proposalMarkdown','approvalJson','releaseArtifactSha256']) test(`owner acceptance rejects missing or changed ${key}`,async()=>{
  for(const missing of [true,false]){const f=ownerFixture();if(missing)delete f.document.ownerEvidence[key];else f.document.ownerEvidence[key]+='x';await assert.rejects(verify(f));}
});
for(const [name,key,mutate] of [
  ['wrong app','serverDeliveryJson',p=>{p.appId='other';}],['wrong platform','serverDeliveryJson',p=>{p.clientPlatform='android';}],
  ['wrong placement','serverDeliveryJson',p=>{p.placement='other';}],['wrong provider','serverDeliveryJson',p=>{p.provider='fake';}],
  ['wrong claim','serverDeliveryJson',p=>{p.claimId='other';}],['unverified claim','serverDeliveryJson',p=>{p.assurance='client_confirmed';}],
  ['undelivered claim','serverDeliveryJson',p=>{p.state='confirmed';}],['wrong reward','serverDeliveryJson',p=>{p.rewardUnits=6;}],
  ['multiple claims','serverDeliveryJson',p=>{p.recentIosClaimCount=2;}],['claim after acknowledgement','serverDeliveryJson',p=>{p.confirmedAt='2026-10-19T14:10:00Z';}],
  ['wrong version','versionBuildJson',p=>{p.candidateVersionBuilds[0].version='1.9.2';}],['wrong build','versionBuildJson',p=>{p.candidateVersionBuilds[0].build='57';}],
  ['wrong build ID','versionBuildJson',p=>{p.candidateVersionBuilds[0].id='other';}],['expired build','versionBuildJson',p=>{p.candidateVersionBuilds[0].expired=true;}],
  ['unprocessed build','versionBuildJson',p=>{p.candidateVersionBuilds[0].state='PROCESSING';}],['another app ID','versionBuildJson',p=>{p.appId='other';}],
  ['wrong approval source','approvalJson',p=>{p.sourceSha='f'.repeat(40);}],['wrong proposal','approvalJson',p=>{p.proposalSha256='f'.repeat(64);}],
  ['approval missing','approvalJson',p=>{p.status='pending';}],['no consent observation','confirmationJson',p=>{delete p.reportedRuntimeChecks['consent-policy'];}],
  ['invented agent pass','confirmationJson',p=>{p.notObservedByAgent=false;}],['user reports in runs','confirmationJson',p=>{p.notAddedToDevelopmentRuns=false;}],
])test(`owner semantics reject ${name} even if a new digest is supplied`,async()=>{
  const f=ownerFixture(),p=JSON.parse(f.document.ownerEvidence[key]);mutate(p);f.document.ownerEvidence[key]=JSON.stringify(p);
  f.grant.ownerAcceptance[key+'Sha256']=createHash('sha256').update(f.document.ownerEvidence[key]).digest('hex');await assert.rejects(verify(f));
});
for(const [name,mutate] of [
  ['no reviewed owner grant',f=>{delete f.grant.ownerAcceptance;}],['different phase',f=>{f.context.phase='before-build';}],
  ['not approved yet',f=>{f.context.now='2026-10-19T14:15:00Z';}],['expired original grant',f=>{f.context.now=f.grant.expiresAt;}],
  ['additional native failure',f=>{const validate=f.dependencies.validate;f.dependencies.validate=async(p,c)=>{const r=await validate(p,c);if(p===f.document.nativeEvidence)r.errors.push('RUN_EXPIRED native');return r;};}],
])test(`owner acceptance rejects ${name}`,async()=>{const f=ownerFixture();mutate(f);await assert.rejects(verify(f));});
