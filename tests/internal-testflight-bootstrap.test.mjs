import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validEvidence } from './helpers/development-evidence-fixture.mjs';
import { validateInternalTestflightBootstrapEvidence as validate } from '../scripts/release/internal-testflight-bootstrap.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = v => Buffer.from(JSON.stringify(v));
const inventoryBytes = readFileSync(new URL('./fixtures/spiritgate-feature-inventory.json', import.meta.url));
const inventory = JSON.parse(inventoryBytes);
const ids = inventory.features.map(f => f.id), foundation = inventory.features.filter(f => f.foundation).map(f => f.id);
const SHA = 'a'.repeat(40), FP = 'b'.repeat(64), NOW = '2026-10-14T06:00:00Z';
function fixture() {
  const editor = validEvidence();
  editor.repository = 'seorilabs/spiritgate-defenders'; editor.target = 'app-store';
  editor.features = inventory.features.map(({id,core})=>({id,core}));
  for (const r of editor.iterations) for (const kind of ['functional','ux']) r[kind].featureIds = inventory.features.filter(f=>f.core).map(f=>f.id);
  editor.e2e.environment = {kind:'godot-editor', configurationFingerprint:FP, isolatedData:'owned-test-fixture'};
  editor.e2e.scenarios[0].featureIds = [...ids];
  const fourth = structuredClone(editor.iterations[2]);
  Object.assign(fourth,{number:4,plannedAt:'2026-10-08T04:00:00Z',startedAt:'2026-10-08T04:01:00Z',completedAt:'2026-10-08T04:10:00Z'});
  editor.iterations.push(fourth);
  editor.additionalIterationApproval = {approverKind:'human',approver:'owner',approvedAt:'2026-10-08T03:50:00Z',maxRound:4,evidence:'https://example.com/approval'};
  const doc = {schemaVersion:1,id:'spiritgate-1.1.0-first-internal',scope:'internal_testflight_only',editor,
    android:{sourceSha:SHA,target:'google-play',configurationFingerprint:'c'.repeat(64),deviceKind:'physical-android',artifactSha256:'d'.repeat(64),plannedAt:'2026-10-08T05:00:00Z',startedAt:'2026-10-08T05:05:00Z',completedAt:'2026-10-08T05:20:00Z',features:foundation.map(id=>({id,status:'passed',evidence:['https://example.com/device']}))},
    ios:{sourceSha:SHA,target:'app-store',status:'deferred',reason:'existing App Store profile requires internal TestFlight installation',featureIds:[...foundation]},
    originalObservations:[{name:'prior-ui-and-native-observations.json',sha256:'e'.repeat(64)}]};
  const approvalBytes=jsonBytes({kind:'human_testflight_timing_approval',repository:editor.repository,version:'1.1.0',objective:'first_internal_testflight_qa',candidateLimit:1,buildUploadLimit:1,maxAgeHours:168,approvalRecordedAt:'2026-10-08T05:00:00Z',userApprovalVerbatim:'first internal TestFlight timing approval',iphoneQa:'deferred until internal installation; not waived',newAppleResourcesAllowed:false,publicReleaseRequires:'normal validator, actual iPhone QA and whole E2E'});
  const grant={schemaVersion:1,kind:'first-internal-testflight',id:doc.id,repository:editor.repository,releaseTag:'v1.1.0',packageName:'com.seorilabs.spiritgatedefenders',sourceSha:SHA,profileSha256:'5'.repeat(64),approvalFile:'docs/design/2026-10-14-spiritgate-internal-testflight/approval.json',evidenceAsset:{id:123,sha256:digest(jsonBytes(doc))},originalObservationAssets:[{id:124,sha256:'e'.repeat(64)}],workingOverrides:{'before-build':{},'before-deploy':{}},configurationFingerprint:FP,androidConfigurationFingerprint:doc.android.configurationFingerprint,productTreeSha256:'f'.repeat(64),evidenceSha256:digest(jsonBytes(doc)),approvalSha256:digest(approvalBytes),inventorySha256:digest(inventoryBytes),approvedAt:'2026-10-08T05:00:00Z',expiresAt:'2026-10-15T05:00:00Z',revoked:false,provider:{appId:'6792205995',productId:'E5C1A24C-AA05-41B0-B2F6-F1BF0B92D7DB',workflowId:'45B83B98-ABE4-48C1-83FC-09CF3F79651E'}};
  const context={repository:grant.repository,sourceSha:SHA,target:'app-store',phase:'before-build',tag:grant.releaseTag,configurationFingerprint:FP,now:NOW,grant,approvalBytes,inventoryBytes,evidenceBytes:jsonBytes(doc),originalEvidenceVerified:true,productTreeSha256:grant.productTreeSha256,executionVerified:true,verifierProof:{verified:true,reviewedOnCurrentMain:true},providerProof:{verified:true,internalOnly:true,sourceSha:SHA,workflowId:grant.provider.workflowId,productId:grant.provider.productId,buildId:'TEST-BUILD-ID',buildNumber:42,matchingBuildCount:1}};
  return {doc,context};
}
const run = f => validate(f.doc,f.context);
function fiveRoundFixture() {
 const f=fixture(),g=f.context.grant;
 g.approvedUiRounds=5;
 g.additionalUiApprovalFile='docs/design/2026-10-14-spiritgate-ui5/approval.json';
 const fifth=structuredClone(f.doc.editor.iterations[3]);
 Object.assign(fifth,{number:5,plannedAt:'2026-10-08T05:30:00Z',startedAt:'2026-10-08T05:31:00Z',completedAt:'2026-10-08T05:40:00Z'});
 f.doc.editor.iterations.push(fifth);
 // UI4의 승인 시각과 maxRound를 고치지 않고 UI5 승인을 별도로 보존한다.
 f.doc.editor.additionalIterationApprovals=[{approverKind:'human',approver:'owner',approvedAt:'2026-10-08T05:20:00Z',maxRound:5,evidence:g.additionalUiApprovalFile}];
 const proposalBytes=Buffer.from('approved one UI5; 180 minutes plus one 30-minute recheck; no deadline extension');
 const additional={kind:'human_additional_ui_approval',designId:'SGD-UI5-TF-110-v1',repository:g.repository,version:'1.1.0',objective:'one_additional_ui_round',approvedUiRounds:5,sourceSha:SHA,configurationFingerprint:FP,approvalRecordedAt:'2026-10-08T05:20:00Z',userApprovalVerbatim:'UI5·중앙 최소 보정·제한 리뷰 승인',proposalSha256:digest(proposalBytes),originalTimingApprovalSha256:g.approvalSha256,executionMinutes:180,issueRecheckMaximumCount:1,issueRecheckMinutes:30,totalMinutes:210,extendOriginal168Hours:false};
 f.context.additionalUiApprovalBytes=jsonBytes(additional);
 f.context.additionalUiProposalBytes=proposalBytes;
 g.additionalUiApprovalSha256=digest(f.context.additionalUiApprovalBytes);
 f.context.evidenceBytes=jsonBytes(f.doc);g.evidenceSha256=digest(f.context.evidenceBytes);
 return f;
}
test('separately reviewed UI5 preserves UI4 approval and original expiry',()=>{
 const f=fiveRoundFixture(),r=run(f);
 assert.equal(r.ok,true,JSON.stringify(r.errors));
 assert.equal(r.approvedUiRounds,5);
 assert.equal(f.doc.editor.additionalIterationApproval.maxRound,4);
 assert.equal(f.context.grant.expiresAt,'2026-10-15T05:00:00Z');
});
test('a separate UI5 approval cannot waive the original UI4 210-minute budget',()=>{
 const f=fiveRoundFixture();
 f.doc.editor.iterations[3].completedAt='2026-10-08T09:00:00Z';
 Object.assign(f.doc.editor.iterations[4],{plannedAt:'2026-10-08T09:05:00Z',startedAt:'2026-10-08T09:06:00Z',completedAt:'2026-10-08T09:15:00Z'});
 Object.assign(f.doc.editor.e2e,{plannedAt:'2026-10-08T09:20:00Z',startedAt:'2026-10-08T09:21:00Z',completedAt:'2026-10-08T09:25:00Z'});
 f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);
 assert.equal(run(f).ok,false);
});
for(const [name,change] of [
 ['unreviewed UI5 approval',f=>{delete f.context.additionalUiApprovalBytes;}],
 ['changed UI5 original approval bytes',f=>{f.context.additionalUiApprovalBytes=Buffer.from('{}');}],
 ['changed UI5 approved proposal',f=>{f.context.additionalUiProposalBytes=Buffer.from('replacement');}],
 ['unapproved sixth round',f=>{f.doc.editor.iterations.push({...structuredClone(f.doc.editor.iterations[4]),number:6});}],
 ['UI5 under a four-round grant',f=>{f.context.grant.approvedUiRounds=4;}],
 ['UI4 omitted from five-round history',f=>{f.doc.editor.iterations.splice(3,1);}],
 ['missing separate Editor UI5 approval',f=>{delete f.doc.editor.additionalIterationApprovals;}],
 ['UI5 functional failure',f=>{f.doc.editor.iterations[4].functional.status='failed';}],
 ['UI5 over 210 minutes',f=>{f.doc.editor.iterations[4].completedAt='2026-10-08T09:02:00Z';f.doc.editor.e2e.plannedAt='2026-10-08T09:05:00Z';f.doc.editor.e2e.startedAt='2026-10-08T09:06:00Z';f.doc.editor.e2e.completedAt='2026-10-08T09:10:00Z';}],
])test(`rejects ${name}`,()=>{
 const f=fiveRoundFixture();change(f);f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);assert.equal(run(f).ok,false,name);
});
for(const [name,changes] of [
 ['UI5 source drift',{sourceSha:'1'.repeat(40)}],
 ['UI5 configuration drift',{configurationFingerprint:'2'.repeat(64)}],
 ['UI5 starts before approval',{approvalRecordedAt:'2026-10-08T05:32:00Z'}],
 ['UI5 original timing approval replaced',{originalTimingApprovalSha256:'3'.repeat(64)}],
 ['UI5 deadline extended',{extendOriginal168Hours:true}],
 ['UI5 recheck count increased',{issueRecheckMaximumCount:2}],
])test(`rejects ${name} even when new bytes are hash-bound`,()=>{
 const f=fiveRoundFixture(),approval=JSON.parse(f.context.additionalUiApprovalBytes);Object.assign(approval,changes);
 f.context.additionalUiApprovalBytes=jsonBytes(approval);f.context.grant.additionalUiApprovalSha256=digest(f.context.additionalUiApprovalBytes);assert.equal(run(f).ok,false,name);
});
test('internal-only timing approval preserves iPhone blocked status and permits only the first internal build',()=>{
 const f=fixture(),r=run(f);assert.equal(r.ok,true,JSON.stringify(r.errors));assert.equal(r.decisionStatus,'human_exception');assert.equal(r.productE2eStatus,'blocked');assert.equal(r.scope,'internal_testflight_only');assert.equal(r.buildNumber,42);
});
const cases=[
 ['unknown public permission',f=>{f.doc.publicReleaseAllowed=true;}],
 ['public objective',f=>{f.doc.scope='public_live';}],
 ['external beta target',f=>{f.context.target='external-testflight';}],
 ['wrong repository',f=>{f.context.repository='seorilabs/other';}],
 ['different source',f=>{f.context.sourceSha='1'.repeat(40);}],
 ['different configuration',f=>{f.context.configurationFingerprint='2'.repeat(64);}],
 ['unreviewed verifier',f=>{f.context.verifierProof.reviewedOnCurrentMain=false;}],
 ['revoked grant',f=>{f.context.grant.revoked=true;}],
 ['expired grant',f=>{f.context.now='2026-10-15T05:00:01Z';}],
 ['future approval',f=>{f.context.grant.approvedAt='2026-10-16T00:00:00Z';}],
 ['more than 168 hours',f=>{f.context.grant.expiresAt='2026-10-16T05:00:00Z';}],
 ['changed approval',f=>{f.context.approvalBytes=Buffer.from('{}');}],
 ['changed inventory',f=>{f.context.inventoryBytes=Buffer.from('{}');}],
 ['unpreserved original observations',f=>{f.context.originalEvidenceVerified=false;}],
 ['changed working product bytes',f=>{f.context.executionVerified=false;}],
 ['changed product tree',f=>{f.context.productTreeSha256='0'.repeat(64);}],
 ['missing Android actual feature',f=>{f.doc.android.features.pop();}],
 ['Android failure',f=>{f.doc.android.features[0].status='failed';}],
 ['Android headless fixture',f=>{f.doc.android.deviceKind='headless';}],
 ['Android source drift',f=>{f.doc.android.sourceSha='3'.repeat(40);}],
 ['iPhone falsely passed',f=>{f.doc.ios.status='passed';}],
 ['non-native feature deferred',f=>{f.doc.ios.featureIds.push('hero-five-skills');}],
 ['incomplete Editor E2E',f=>{f.doc.editor.e2e.scenarios[0].featureIds.pop();}],
 ['UI4 not approved',f=>{f.doc.editor.additionalIterationApproval=null;}],
 ['UI4 functional failure',f=>{f.doc.editor.iterations[3].functional.status='failed';}],
 ['eligible for App Store',f=>{f.context.providerProof.internalOnly=false;}],
 ['provider proof self-asserted',f=>{f.context.providerProof.verified=false;}],
 ['wrong provider workflow',f=>{f.context.providerProof.workflowId='other';}],
 ['another build source',f=>{f.context.providerProof.sourceSha='4'.repeat(40);}],
 ['second archive attempt',f=>{f.context.providerProof.matchingBuildCount=2;}],
 ['missing before-deploy artifact',f=>{f.context.phase='before-deploy';}],
];
for(const [name,change] of cases) test(`rejects ${name}`,()=>{const f=fixture();change(f);f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);assert.equal(run(f).ok,false,name);});
test('a caller cannot edit the approved evidence after the central grant was reviewed',()=>{const f=fixture();f.doc.android.features[0].evidence.push('https://example.com/replacement');assert.equal(run(f).ok,false);});

test('malformed nested Editor evidence returns rejection instead of throwing',()=>{
 const f=fixture();f.doc.editor={iterations:[{},{},{},{}]};f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);
 assert.equal(run(f).ok,false);
});
function deploymentFixture(){
 const f=fixture(),p=f.context.providerProof;f.context.phase='before-deploy';f.context.grantSha256='6'.repeat(64);
 f.context.artifactProof={verified:true,sourceSha:SHA,buildId:p.buildId,buildNumber:p.buildNumber,bundleId:f.context.grant.packageName,version:'1.1.0',sha256:'7'.repeat(64)};
 f.context.beforeBuildReceipt={ok:true,phase:'before-build',decisionStatus:'human_exception',productE2eStatus:'blocked',nativeQaWaived:false,scope:'internal_testflight_only',sourceSha:SHA,buildId:p.buildId,buildNumber:p.buildNumber,configurationFingerprint:FP,grantSha256:f.context.grantSha256};
 return f;
}
test('actual deployment requires a successful internal before-build receipt',()=>{
 const positive=run(deploymentFixture());assert.equal(positive.ok,true,JSON.stringify(positive.errors));
 for(const changes of [{ok:false},{phase:'before-deploy'},{decisionStatus:'passed'},{productE2eStatus:'passed'},{nativeQaWaived:true}]){
  const f=deploymentFixture();Object.assign(f.context.beforeBuildReceipt,changes);assert.equal(run(f).ok,false);
 }
});
