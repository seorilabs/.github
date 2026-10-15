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

function sixRoundFixture(){
 const f=fiveRoundFixture(),g=f.context.grant,historySource='8'.repeat(40),historyConfig='9'.repeat(64);
 g.approvedUiRounds=6;
 g.ui6ApprovalFile='docs/design/2026-10-15-spiritgate-ui6/approval.json';
 const prior=JSON.parse(f.context.additionalUiApprovalBytes);
 prior.sourceSha=null;prior.configurationFingerprint=null;
 f.context.additionalUiApprovalBytes=jsonBytes(prior);g.additionalUiApprovalSha256=digest(f.context.additionalUiApprovalBytes);
 f.doc.editor.iterations[4].sourceSha=historySource;
 for(const aspect of ['functional','ux']) Object.assign(f.doc.editor.iterations[4][aspect],{status:'failed',resolutionEvidence:'https://example.com/ui6-resolution'});
 f.context.ui5SourceSnapshotBytes=jsonBytes({sourceSha:historySource,trackedCount:3048,unexpectedDifferences:[]});
 f.context.ui5ConfigurationBytes=jsonBytes({projection:{sourceSha:historySource,sourceAfter:digest(f.context.ui5SourceSnapshotBytes),runtimeKind:'godot-editor',nativeMarketFingerprint:null},fingerprint:historyConfig});
 g.historicalUi5={sourceSha:historySource,configurationFingerprint:historyConfig,sourceSnapshotAsset:{id:125,sha256:digest(f.context.ui5SourceSnapshotBytes)},configurationAsset:{id:126,sha256:digest(f.context.ui5ConfigurationBytes)}};
 g.originalObservationAssets.push(g.historicalUi5.sourceSnapshotAsset,g.historicalUi5.configurationAsset);
 f.doc.originalObservations.push({name:'ui5-source-after.json',sha256:g.historicalUi5.sourceSnapshotAsset.sha256},{name:'ui5-configuration-final.json',sha256:g.historicalUi5.configurationAsset.sha256});
 const sixth=structuredClone(f.doc.editor.iterations[3]);
 Object.assign(sixth,{number:6,sourceSha:SHA,plannedAt:'2026-10-08T05:50:00Z',startedAt:'2026-10-08T05:51:00Z',completedAt:'2026-10-08T06:00:00Z'});
 f.doc.editor.iterations.push(sixth);
 f.doc.editor.additionalIterationApprovals.push({approverKind:'human',approver:'owner',approvedAt:'2026-10-08T05:45:00Z',maxRound:6,evidence:g.ui6ApprovalFile});
 const proposal=Buffer.from('approved one UI6; preserve UI5 source/configuration/failures; 180 plus one 30; no extension');
 f.context.ui6ProposalBytes=proposal;
 f.context.ui6ApprovalBytes=jsonBytes({...prior,designId:'SGD-UI6-TF-110-v1',approvedUiRounds:6,sourceSha:SHA,configurationFingerprint:FP,approvalRecordedAt:'2026-10-08T05:45:00Z',userApprovalVerbatim:'UI6·중앙 최소 보정·제한 Claude 리뷰를 제안한 범위로 승인한다.',proposalSha256:digest(proposal),previousUiApprovalSha256:g.additionalUiApprovalSha256,previousUiSourceSnapshotSha256:g.historicalUi5.sourceSnapshotAsset.sha256,previousUiConfigurationSha256:g.historicalUi5.configurationAsset.sha256});
 g.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
 Object.assign(f.doc.editor.e2e,{plannedAt:'2026-10-08T06:05:00Z',startedAt:'2026-10-08T06:06:00Z',completedAt:'2026-10-08T06:10:00Z'});
 f.context.evidenceBytes=jsonBytes(f.doc);g.evidenceSha256=digest(f.context.evidenceBytes);
 return f;
}
test('UI6 binds its new candidate and preserves the separately approved failed UI5 snapshot',()=>{
 const f=sixRoundFixture(),r=run(f);
 assert.equal(r.ok,true,JSON.stringify(r.errors));assert.equal(r.approvedUiRounds,6);
 assert.equal(r.ui6ApprovalSha256,f.context.grant.ui6ApprovalSha256);
 assert.equal(f.doc.editor.iterations[4].sourceSha,'8'.repeat(40));assert.equal(f.doc.editor.iterations[4].functional.status,'failed');
 assert.equal(f.doc.editor.additionalIterationApproval.maxRound,4);assert.equal(f.doc.editor.additionalIterationApprovals[0].maxRound,5);
 assert.equal(f.context.grant.expiresAt,'2026-10-15T05:00:00Z');assert.equal(r.nativeQaWaived,false);assert.equal(r.productE2eStatus,'blocked');
});
for(const [name,change] of [
 ['missing UI6 approval',f=>{delete f.context.ui6ApprovalBytes;}],
 ['changed UI6 proposal',f=>{f.context.ui6ProposalBytes=Buffer.from('unapproved scope');}],
 ['missing UI5 original approval',f=>{delete f.context.additionalUiApprovalBytes;}],
 ['changed UI5 original proposal',f=>{f.context.additionalUiProposalBytes=Buffer.from('edited history');}],
 ['missing UI5 source bytes',f=>{delete f.context.ui5SourceSnapshotBytes;}],
 ['changed UI5 source bytes',f=>{f.context.ui5SourceSnapshotBytes=jsonBytes({sourceSha:SHA});}],
 ['changed UI5 configuration bytes',f=>{f.context.ui5ConfigurationBytes=jsonBytes({fingerprint:FP});}],
 ['UI5 recast as current candidate',f=>{f.doc.editor.iterations[4].sourceSha=SHA;}],
 ['UI5 snapshot not retained as original',f=>{f.context.grant.originalObservationAssets.pop();f.doc.originalObservations.pop();}],
 ['UI5 failure without resolution',f=>{delete f.doc.editor.iterations[4].functional.resolutionEvidence;}],
 ['missing UI4 history',f=>{f.doc.editor.iterations.splice(3,1);}],
 ['missing UI5 history',f=>{f.doc.editor.iterations.splice(4,1);}],
 ['missing UI4 approval',f=>{f.doc.editor.additionalIterationApproval=null;}],
 ['missing separate UI5 Editor approval',f=>{f.doc.editor.additionalIterationApprovals.shift();}],
 ['missing separate UI6 Editor approval',f=>{f.doc.editor.additionalIterationApprovals.pop();}],
 ['UI6 current source drift',f=>{f.doc.editor.iterations[5].sourceSha='7'.repeat(40);}],
 ['UI6 functional failure',f=>{f.doc.editor.iterations[5].functional.status='failed';}],
 ['UI6 UX failure',f=>{f.doc.editor.iterations[5].ux.status='failed';}],
 ['unapproved UI7',f=>{f.doc.editor.iterations.push({...f.doc.editor.iterations[5],number:7});f.context.grant.approvedUiRounds=7;}],
 ['UI6 public phase',f=>{f.context.phase='before-release';}],
 ['UI6 missing Android foundation',f=>{f.doc.android.features.pop();}],
 ['UI6 original expiry exceeded',f=>{f.context.now='2026-10-15T05:00:01Z';}],
])test(`rejects ${name}`,()=>{
 const f=sixRoundFixture();change(f);f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);assert.equal(run(f).ok,false,name);
});
for(const [name,changes] of [
 ['UI6 approval source drift',{sourceSha:'7'.repeat(40)}],
 ['UI6 approval configuration drift',{configurationFingerprint:'7'.repeat(64)}],
 ['UI6 starts before approval',{approvalRecordedAt:'2026-10-08T05:52:00Z'}],
 ['UI6 original timing approval changed',{originalTimingApprovalSha256:'7'.repeat(64)}],
 ['UI6 previous approval hash replaced',{previousUiApprovalSha256:'7'.repeat(64)}],
 ['UI6 previous source hash replaced',{previousUiSourceSnapshotSha256:'7'.repeat(64)}],
 ['UI6 previous configuration hash replaced',{previousUiConfigurationSha256:'7'.repeat(64)}],
 ['UI6 original deadline extended',{extendOriginal168Hours:true}],
 ['UI6 second recheck authorized',{issueRecheckMaximumCount:2}],
])test(`rejects ${name} even with newly hash-bound bytes`,()=>{
 const f=sixRoundFixture(),approval=JSON.parse(f.context.ui6ApprovalBytes);Object.assign(approval,changes);
 f.context.ui6ApprovalBytes=jsonBytes(approval);f.context.grant.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);assert.equal(run(f).ok,false,name);
});
for(const round of [4,5,6])test(`UI6 cannot waive round ${round}'s existing 210-minute budget`,()=>{
 const f=sixRoundFixture();f.doc.editor.iterations[round-1].completedAt='2026-10-08T10:00:00Z';
 f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);const result=run(f);
 assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_APPROVED_UI_BUDGET'),JSON.stringify(result.errors));
});
function rebindUi5Snapshot(f){
 const g=f.context.grant,h=g.historicalUi5;
 for(const [key,bytes] of [['sourceSnapshotAsset',f.context.ui5SourceSnapshotBytes],['configurationAsset',f.context.ui5ConfigurationBytes]]){
  const old=h[key].sha256;h[key].sha256=digest(bytes);
  f.doc.originalObservations.find(a=>a.sha256===old).sha256=h[key].sha256;
 }
 const approval=JSON.parse(f.context.ui6ApprovalBytes);
 approval.previousUiSourceSnapshotSha256=h.sourceSnapshotAsset.sha256;approval.previousUiConfigurationSha256=h.configurationAsset.sha256;
 f.context.ui6ApprovalBytes=jsonBytes(approval);g.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
 f.context.evidenceBytes=jsonBytes(f.doc);g.evidenceSha256=digest(f.context.evidenceBytes);
}
for(const [name,change] of [
 ['UI5 source snapshot source mismatch',(s,c)=>{s.sourceSha=SHA;}],
 ['UI5 configuration source mismatch',(s,c)=>{c.projection.sourceSha=SHA;}],
 ['UI5 configuration fingerprint mismatch',(s,c)=>{c.fingerprint=FP;}],
 ['UI5 configuration source bytes mismatch',(s,c)=>{c.projection.sourceAfter='1'.repeat(64);}],
 ['UI5 configuration runtime mismatch',(s,c)=>{c.projection.runtimeKind='headless';}],
])test(`rejects ${name} after reviewed hash references are rebound`,()=>{
 const f=sixRoundFixture(),source=JSON.parse(f.context.ui5SourceSnapshotBytes),configuration=JSON.parse(f.context.ui5ConfigurationBytes);change(source,configuration);
 f.context.ui5SourceSnapshotBytes=jsonBytes(source);f.context.ui5ConfigurationBytes=jsonBytes(configuration);rebindUi5Snapshot(f);
 const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_UI5_SNAPSHOT_SCOPE'),JSON.stringify(result.errors));
});
test('a previously candidate-bound UI5 approval must still match its own historical snapshot',()=>{
 for(const [sourceSha,configurationFingerprint,expected] of [['8'.repeat(40),'9'.repeat(64),true],[SHA,'9'.repeat(64),false],['8'.repeat(40),FP,false]]){
  const f=sixRoundFixture(),a=JSON.parse(f.context.additionalUiApprovalBytes);Object.assign(a,{sourceSha,configurationFingerprint});
  f.context.additionalUiApprovalBytes=jsonBytes(a);f.context.grant.additionalUiApprovalSha256=digest(f.context.additionalUiApprovalBytes);
  const sixth=JSON.parse(f.context.ui6ApprovalBytes);sixth.previousUiApprovalSha256=f.context.grant.additionalUiApprovalSha256;
  f.context.ui6ApprovalBytes=jsonBytes(sixth);f.context.grant.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
  assert.equal(run(f).ok,expected);
 }
});
test('UI6 cannot move UI5 approval later than the original UI5 plan',()=>{
 const f=sixRoundFixture(),a=JSON.parse(f.context.additionalUiApprovalBytes);a.approvalRecordedAt='2026-10-08T05:35:00Z';
 f.context.additionalUiApprovalBytes=jsonBytes(a);f.context.grant.additionalUiApprovalSha256=digest(f.context.additionalUiApprovalBytes);
 f.doc.editor.additionalIterationApprovals[0].approvedAt=a.approvalRecordedAt;
 const sixth=JSON.parse(f.context.ui6ApprovalBytes);sixth.previousUiApprovalSha256=f.context.grant.additionalUiApprovalSha256;
 f.context.ui6ApprovalBytes=jsonBytes(sixth);f.context.grant.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
 f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);
 const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_UI5_APPROVAL_TIME'));
});
test('UI6-only fields are rejected by the grant schema even with matching four- or five-round histories',()=>{
 const ui6=sixRoundFixture().context.grant;
 for(const approvedUiRounds of [4,5]){
  const f=approvedUiRounds===4 ? fixture() : fiveRoundFixture();
  f.context.grant.approvedUiRounds=approvedUiRounds;
  assert.equal(f.doc.editor.iterations.length,approvedUiRounds);assert.equal(run(f).ok,true);
  Object.assign(f.context.grant,{ui6ApprovalFile:ui6.ui6ApprovalFile,ui6ApprovalSha256:ui6.ui6ApprovalSha256,historicalUi5:ui6.historicalUi5});
  assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);
 }
});

for(const aspect of ['functional','ux']) for(const status of ['failed','blocked'])test(`final UI6 ${aspect} ${status} cannot pass with resolution evidence`,()=>{
 const f=sixRoundFixture();Object.assign(f.doc.editor.iterations[5][aspect],{status,resolutionEvidence:'https://example.com/claimed-resolution'});
 f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);
 const result=run(f);assert.equal(result.ok,false);
 assert.ok(result.errors.includes(`TESTFLIGHT_EDITOR UNRESOLVED_REVIEW 6-${aspect}`),JSON.stringify(result.errors));
});
test('UI6 approval time is rejected even when both approval records agree on the late time',()=>{
 const f=sixRoundFixture(),a=JSON.parse(f.context.ui6ApprovalBytes);a.approvalRecordedAt='2026-10-08T05:52:00Z';
 f.context.ui6ApprovalBytes=jsonBytes(a);f.context.grant.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
 f.doc.editor.additionalIterationApprovals[1].approvedAt=a.approvalRecordedAt;
 f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);
 const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_UI6_APPROVAL_TIME'),JSON.stringify(result.errors));
 assert.ok(!result.errors.includes('TESTFLIGHT_UI6_EDITOR_APPROVAL'),JSON.stringify(result.errors));
});
test('reviewed original assets reject unexpected keys before any whole-object equality comparison',()=>{
 const f=sixRoundFixture();assert.equal(run(f).ok,true);
 f.context.grant.originalObservationAssets=f.context.grant.originalObservationAssets.map(a=>structuredClone(a));
 assert.equal(run(f).ok,true,'distinct object references remain valid');
 f.context.grant.originalObservationAssets[1].name='extra-key';
 assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);
});
test('reviewed UI1 to UI4 retain their own original candidates and resolved failures',()=>{
 const f=sixRoundFixture();
 for(let i=0;i<4;i++){
  f.doc.editor.iterations[i].sourceSha=String(i+1).repeat(40);
  for(const aspect of ['functional','ux']) Object.assign(f.doc.editor.iterations[i][aspect],{status:'failed',resolutionEvidence:'https://example.com/later-actual-resolution'});
 }
 f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);
 assert.equal(run(f).ok,true);
 f.doc.editor.iterations[0].sourceSha='7'.repeat(40);
 const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_EVIDENCE_CHANGED'));
});
for(const key of ['ui5SourceSnapshotBytes','ui5ConfigurationBytes','additionalUiApprovalBytes'])test(`JSON null ${key} fails closed without escaping the validator`,()=>{
 const f=sixRoundFixture();f.context[key]=Buffer.from('null');
 if(key==='additionalUiApprovalBytes'){
  f.context.grant.additionalUiApprovalSha256=digest(f.context.additionalUiApprovalBytes);
  const approval=JSON.parse(f.context.ui6ApprovalBytes);approval.previousUiApprovalSha256=f.context.grant.additionalUiApprovalSha256;
  f.context.ui6ApprovalBytes=jsonBytes(approval);f.context.grant.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
 }else rebindUi5Snapshot(f);
 let result;assert.doesNotThrow(()=>{result=run(f);});assert.equal(result.ok,false);
});

const canonicalUi5ApprovalBytes=readFileSync(new URL('../docs/design/2026-10-14-spiritgate-ui5/approval.json',import.meta.url));
const canonicalUi5Approval=JSON.parse(canonicalUi5ApprovalBytes);
function ui5UtcReceiptFixture(approvedUiRounds=6){
 const f=approvedUiRounds===5 ? fiveRoundFixture() : sixRoundFixture(),g=f.context.grant;
 const approval=JSON.parse(f.context.additionalUiApprovalBytes);
 approval.approvalRecordedAt=canonicalUi5Approval.approvalRecordedAt;
 f.context.additionalUiApprovalBytes=jsonBytes(approval);g.additionalUiApprovalSha256=digest(f.context.additionalUiApprovalBytes);
 f.doc.editor.additionalIterationApprovals[0].approvedAt=approval.approvalRecordedAt.replace(/\+00:00$/u,'Z');
 Object.assign(f.doc.editor.iterations[4],{plannedAt:'2026-10-14T11:10:00Z',startedAt:'2026-10-14T11:11:00Z',completedAt:'2026-10-14T11:20:00Z'});
 if(approvedUiRounds===6){
  const sixth=JSON.parse(f.context.ui6ApprovalBytes);
  sixth.approvalRecordedAt='2026-10-14T22:39:56Z';sixth.previousUiApprovalSha256=g.additionalUiApprovalSha256;
  f.context.ui6ApprovalBytes=jsonBytes(sixth);g.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
  f.doc.editor.additionalIterationApprovals[1].approvedAt=sixth.approvalRecordedAt;
  Object.assign(f.doc.editor.iterations[5],{plannedAt:'2026-10-14T22:45:00Z',startedAt:'2026-10-14T22:46:00Z',completedAt:'2026-10-14T22:50:00Z'});
 }
 Object.assign(f.doc.editor.e2e,{plannedAt:'2026-10-14T23:00:00Z',startedAt:'2026-10-14T23:01:00Z',completedAt:'2026-10-14T23:10:00Z'});
 f.context.now='2026-10-15T00:00:00Z';f.context.evidenceBytes=jsonBytes(f.doc);g.evidenceSha256=digest(f.context.evidenceBytes);
 return f;
}
for(const approvedUiRounds of [5,6])test(`UI${approvedUiRounds} accepts the real canonical UI5 UTC-offset timestamp as the exact same Z value`,()=>{
 assert.equal(digest(canonicalUi5ApprovalBytes),'7c5029587d363c4d42d1a1444f298292eeadae9bc558bf3bc5473fdb4c69e795');
 assert.equal(canonicalUi5Approval.approvalRecordedAt,'2026-10-14T10:56:24.262911+00:00');
 const f=ui5UtcReceiptFixture(approvedUiRounds),r=run(f);
 assert.equal(r.ok,true,JSON.stringify(r.errors));
 assert.equal(f.context.grant.expiresAt,'2026-10-15T05:00:00Z');
});
for(const [name,approvedAt] of [
 ['different second','2026-10-14T10:56:25.262911Z'],
 ['one microsecond difference','2026-10-14T10:56:24.262912Z'],
 ['fraction truncated to milliseconds','2026-10-14T10:56:24.262Z'],
 ['fraction trailing byte added','2026-10-14T10:56:24.2629110Z'],
])test(`UI5 UTC receipt rejects ${name}`,()=>{
 const f=ui5UtcReceiptFixture();f.doc.editor.additionalIterationApprovals[0].approvedAt=approvedAt;
 f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);
 const r=run(f);assert.equal(r.ok,false);assert.ok(r.errors.includes('TESTFLIGHT_UI5_EDITOR_APPROVAL'),JSON.stringify(r.errors));
});
test('UI5 UTC receipt does not normalize other offsets even when they describe the same instant',()=>{
 const f=ui5UtcReceiptFixture(),a=JSON.parse(f.context.additionalUiApprovalBytes);
 a.approvalRecordedAt='2026-10-14T11:56:24.262911+01:00';
 f.context.additionalUiApprovalBytes=jsonBytes(a);f.context.grant.additionalUiApprovalSha256=digest(f.context.additionalUiApprovalBytes);
 const sixth=JSON.parse(f.context.ui6ApprovalBytes);sixth.previousUiApprovalSha256=f.context.grant.additionalUiApprovalSha256;
 f.context.ui6ApprovalBytes=jsonBytes(sixth);f.context.grant.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
 const r=run(f);assert.equal(r.ok,false);assert.ok(r.errors.includes('TESTFLIGHT_UI5_EDITOR_APPROVAL'),JSON.stringify(r.errors));
});

function sevenRoundFixture(){
 const f=sixRoundFixture(),g=f.context.grant,historicalSource=SHA,historicalConfig=FP,current='7'.repeat(40),currentConfig='6'.repeat(64);
 g.approvedUiRounds=7;g.ui7ApprovalFile='docs/design/2026-10-15-spiritgate-ui7/approval.json';
 const sixth=JSON.parse(f.context.ui6ApprovalBytes);sixth.sourceSha=null;sixth.configurationFingerprint=null;
 f.context.ui6ApprovalBytes=jsonBytes(sixth);g.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);
 for(const aspect of ['functional','ux'])Object.assign(f.doc.editor.iterations[5][aspect],{status:'blocked',resolutionEvidence:'https://example.com/ui7-resolution'});
 f.doc.editor.iterations[5].completedAt='2026-10-08T06:01:00Z';
 f.context.ui6SourceSnapshotBytes=jsonBytes({sourceSha:historicalSource,files:[{path:'project.godot',sha256:'1'.repeat(64),bytes:100}]});
 f.context.ui6ConfigurationBytes=jsonBytes({sourceSha:historicalSource,fingerprint:historicalConfig,runtimeKind:'godot-editor',nativeMarketFingerprint:null,sourceProjectSha256:'1'.repeat(64),configs:[{sha256:'2'.repeat(64)}]});
 f.context.ui6ExecutionStartBytes=jsonBytes({sourceSha:historicalSource,configurationFingerprint:historicalConfig,plannedAt:'2026-10-08T05:50:00+00:00',startedAt:'2026-10-08T05:51:00+00:00',mainDeadlineAt:'2026-10-08T08:51:00+00:00',absoluteDeadlineAt:'2026-10-08T09:21:00+00:00',mainMinutes:180,problemRecheckLimit:1,problemRecheckMaxMinutes:30});
 f.context.ui6FailedSegmentBytes=jsonBytes({sourceSha:historicalSource,phaseResult:'fail and incomplete',wholeUi6Completed:false,originalFirstRun:'2026-10-08T05:51:00Z',mainDeadline:'2026-10-08T08:51:00Z',stopConfirmedByUtc:'2026-10-08T06:00:00Z',recordedAt:'2026-10-08T06:01:00+00:00',problemRecheckUsed:0,newCandidateRun:0,sourceTrackedFiles:1,sourceChanges:[{path:'project.godot',beforeSha256:'1'.repeat(64),afterSha256:'2'.repeat(64)}],errors:[{code:'fixture-error'}],totalErrorCount:1});
 f.context.ui6FailureBytes=jsonBytes({sourceSha:historicalSource,result:'fail',originalStart:'2026-10-08T05:51:00Z',recordedAt:'2026-10-08T05:59:00+00:00',errors:[{code:'fixture-error'}],errorCount:1});
 g.historicalUi6={sourceSha:historicalSource,configurationFingerprint:historicalConfig};
 for(const [key,contextKey,id] of [['sourceSnapshotAsset','ui6SourceSnapshotBytes',127],['configurationAsset','ui6ConfigurationBytes',128],['executionStartAsset','ui6ExecutionStartBytes',129],['failedSegmentAsset','ui6FailedSegmentBytes',130],['failureAsset','ui6FailureBytes',131]]){
  const asset={id,sha256:digest(f.context[contextKey])};g.historicalUi6[key]=asset;g.originalObservationAssets.push(asset);f.doc.originalObservations.push({name:contextKey+'.json',sha256:asset.sha256});
 }
 const seventh=structuredClone(f.doc.editor.iterations[3]);Object.assign(seventh,{number:7,sourceSha:current,plannedAt:'2026-10-08T06:20:00Z',startedAt:'2026-10-08T06:21:00Z',completedAt:'2026-10-08T06:40:00Z'});f.doc.editor.iterations.push(seventh);
 f.doc.editor.additionalIterationApprovals.push({approverKind:'human',approver:'owner',approvedAt:'2026-10-08T06:15:00Z',maxRound:7,evidence:g.ui7ApprovalFile});
 f.context.ui7ProposalBytes=Buffer.from('one UI7; preserve all UI6 originals; no extension or native waiver');
 f.context.ui7ApprovalBytes=jsonBytes({...sixth,designId:'SGD-UI7-TF-110-v1',approvedUiRounds:7,sourceSha:current,configurationFingerprint:currentConfig,approvalRecordedAt:'2026-10-08T06:15:00+00:00',proposalSha256:digest(f.context.ui7ProposalBytes),previousUiApprovalSha256:g.ui6ApprovalSha256,previousUiSourceSnapshotSha256:g.historicalUi6.sourceSnapshotAsset.sha256,previousUiConfigurationSha256:g.historicalUi6.configurationAsset.sha256,previousUiExecutionStartSha256:g.historicalUi6.executionStartAsset.sha256,previousUiFailedSegmentSha256:g.historicalUi6.failedSegmentAsset.sha256,previousUiFailureSha256:g.historicalUi6.failureAsset.sha256});g.ui7ApprovalSha256=digest(f.context.ui7ApprovalBytes);
 for(const object of [g,f.context,f.doc.editor,f.doc.editor.e2e,f.doc.android,f.doc.ios,f.context.providerProof])object.sourceSha=current;
 for(const object of [g,f.context,f.doc.editor.e2e.environment])object.configurationFingerprint=currentConfig;
 Object.assign(f.doc.editor.e2e,{plannedAt:'2026-10-08T06:45:00Z',startedAt:'2026-10-08T06:46:00Z',completedAt:'2026-10-08T06:55:00Z'});
 return refreshSeven(f);
}
function refreshSeven(f){f.context.evidenceBytes=jsonBytes(f.doc);f.context.grant.evidenceSha256=digest(f.context.evidenceBytes);return f;}
function rebindUi7Approval(f,changes){const a=JSON.parse(f.context.ui7ApprovalBytes);Object.assign(a,changes);f.context.ui7ApprovalBytes=jsonBytes(a);f.context.grant.ui7ApprovalSha256=digest(f.context.ui7ApprovalBytes);}
function rebindUi6History(f){
 const h=f.context.grant.historicalUi6,changes={};
 for(const [key,contextKey,approvalKey]of [['sourceSnapshotAsset','ui6SourceSnapshotBytes','previousUiSourceSnapshotSha256'],['configurationAsset','ui6ConfigurationBytes','previousUiConfigurationSha256'],['executionStartAsset','ui6ExecutionStartBytes','previousUiExecutionStartSha256'],['failedSegmentAsset','ui6FailedSegmentBytes','previousUiFailedSegmentSha256'],['failureAsset','ui6FailureBytes','previousUiFailureSha256']]){
  const old=h[key].sha256;h[key].sha256=digest(f.context[contextKey]);f.doc.originalObservations.find(a=>a.sha256===old).sha256=h[key].sha256;changes[approvalKey]=h[key].sha256;
 }
 rebindUi7Approval(f,changes);refreshSeven(f);
}
test('UI7 binds its own candidate and retains the immutable failed and incomplete UI6 observations',()=>{
 const f=sevenRoundFixture(),result=run(f);assert.equal(result.ok,true,JSON.stringify(result.errors));assert.equal(result.approvedUiRounds,7);assert.equal(result.ui7ApprovalSha256,f.context.grant.ui7ApprovalSha256);assert.equal(result.ui6ApprovalSha256,f.context.grant.ui6ApprovalSha256);
 assert.equal(f.doc.editor.iterations[5].sourceSha,SHA);assert.equal(f.doc.editor.iterations[5].functional.status,'blocked');assert.equal(JSON.parse(f.context.ui6ApprovalBytes).sourceSha,null);
 assert.equal(JSON.parse(f.context.ui6FailedSegmentBytes).wholeUi6Completed,false);assert.equal(result.productE2eStatus,'blocked');assert.equal(result.nativeQaWaived,false);assert.equal(f.context.grant.expiresAt,'2026-10-15T05:00:00Z');
});
for(const [name,change]of [
 ['missing UI7 approval',f=>{delete f.context.ui7ApprovalBytes;}],['changed UI7 proposal',f=>{f.context.ui7ProposalBytes=Buffer.from('expanded scope');}],
 ['missing UI6 approval',f=>{delete f.context.ui6ApprovalBytes;}],['changed UI6 proposal',f=>{f.context.ui6ProposalBytes=Buffer.from('edited history');}],
 ['missing historical UI6',f=>{delete f.context.grant.historicalUi6;}],['UI6 recast as current source',f=>{f.doc.editor.iterations[5].sourceSha=f.context.sourceSha;}],
 ['UI6 promoted to functional PASS',f=>{f.doc.editor.iterations[5].functional.status='passed';}],['UI6 promoted to UX PASS',f=>{f.doc.editor.iterations[5].ux.status='passed';}],
 ['UI6 first Run shifted',f=>{f.doc.editor.iterations[5].startedAt='2026-10-08T05:52:00Z';}],['UI6 observation end shifted',f=>{f.doc.editor.iterations[5].completedAt='2026-10-08T06:02:00Z';}],
 ['UI6 missing resolution',f=>{delete f.doc.editor.iterations[5].functional.resolutionEvidence;}],['UI7 wrong source',f=>{f.doc.editor.iterations[6].sourceSha=SHA;}],
 ['missing UI6 history',f=>{f.doc.editor.iterations.splice(5,1);}],['missing UI5 history',f=>{f.doc.editor.iterations.splice(4,1);}],
 ['missing UI7 Editor approval',f=>{f.doc.editor.additionalIterationApprovals.pop();}],['missing UI6 Editor approval',f=>{f.doc.editor.additionalIterationApprovals.splice(1,1);}],
 ['UI7 approval before UI6 approval',f=>{rebindUi7Approval(f,{approvalRecordedAt:'2026-10-08T05:44:00Z'});f.doc.editor.additionalIterationApprovals[2].approvedAt='2026-10-08T05:44:00Z';}],
 ['UI7 plan before previous observation ended',f=>{f.doc.editor.iterations[6].plannedAt='2026-10-08T06:00:30Z';}],
 ['UI7 E2E before UI7 ended',f=>{f.doc.editor.e2e.plannedAt='2026-10-08T06:39:00Z';}],
 ['UI7 native foundation missing',f=>{f.doc.android.features.pop();}],['UI7 public submission',f=>{f.context.phase='before-release';}],
 ['UI7 original expiry exceeded',f=>{f.context.now='2026-10-15T05:00:01Z';}],['UI7 original expiry extended',f=>{f.context.grant.expiresAt='2026-10-16T05:00:00Z';}],
 ['UI8 without approval',f=>{f.context.grant.approvedUiRounds=8;f.doc.editor.iterations.push({...f.doc.editor.iterations[6],number:8});}],
])test(`UI7 rejects ${name}`,()=>{const f=sevenRoundFixture();change(f);refreshSeven(f);assert.equal(run(f).ok,false,name);});
for(const key of ['ui6SourceSnapshotBytes','ui6ConfigurationBytes','ui6ExecutionStartBytes','ui6FailedSegmentBytes','ui6FailureBytes']){
 test(`UI7 rejects missing ${key}`,()=>{const f=sevenRoundFixture();delete f.context[key];assert.equal(run(f).ok,false);});
 for(const invalid of ['null','{'])test(`UI7 fails closed for malformed ${key} ${invalid}`,()=>{const f=sevenRoundFixture();f.context[key]=Buffer.from(invalid);rebindUi6History(f);let result;assert.doesNotThrow(()=>{result=run(f);});assert.equal(result.ok,false);});
 test(`UI7 rejects changed ${key} bytes`,()=>{const f=sevenRoundFixture();f.context[key]=Buffer.from('{}');assert.equal(run(f).ok,false);});
}
for(const [name,changes]of [
 ['wrong current source',{sourceSha:SHA}],['wrong current configuration',{configurationFingerprint:FP}],['wrong previous approval',{previousUiApprovalSha256:'3'.repeat(64)}],
 ['wrong previous source hash',{previousUiSourceSnapshotSha256:'3'.repeat(64)}],['wrong previous configuration hash',{previousUiConfigurationSha256:'3'.repeat(64)}],
 ['wrong previous start hash',{previousUiExecutionStartSha256:'3'.repeat(64)}],['wrong previous segment hash',{previousUiFailedSegmentSha256:'3'.repeat(64)}],['wrong previous failure hash',{previousUiFailureSha256:'3'.repeat(64)}],
 ['wrong timing approval',{originalTimingApprovalSha256:'3'.repeat(64)}],['deadline extension',{extendOriginal168Hours:true}],['second recheck',{issueRecheckMaximumCount:2}],['larger budget',{totalMinutes:211}],
])test(`UI7 rejects ${name} even with rebound approval bytes`,()=>{const f=sevenRoundFixture();rebindUi7Approval(f,changes);assert.equal(run(f).ok,false);});
for(const [key,change]of [
 ['ui6SourceSnapshotBytes',v=>{v.sourceSha='3'.repeat(40);}],['ui6ConfigurationBytes',v=>{v.fingerprint='3'.repeat(64);}],
 ['ui6ConfigurationBytes',v=>{v.runtimeKind='headless';}],['ui6ConfigurationBytes',v=>{v.sourceProjectSha256='3'.repeat(64);}],
 ['ui6ExecutionStartBytes',v=>{v.mainDeadlineAt='2026-10-08T08:52:00+00:00';}],['ui6ExecutionStartBytes',v=>{v.absoluteDeadlineAt='2026-10-08T09:22:00+00:00';}],
 ['ui6FailedSegmentBytes',v=>{v.wholeUi6Completed=true;}],['ui6FailedSegmentBytes',v=>{v.phaseResult='passed';}],
 ['ui6FailedSegmentBytes',v=>{v.sourceChanges[0].beforeSha256='3'.repeat(64);}],['ui6FailedSegmentBytes',v=>{v.sourceChanges[0].afterSha256='3'.repeat(64);}],
 ['ui6FailedSegmentBytes',v=>{v.sourceTrackedFiles=2;}],['ui6FailedSegmentBytes',v=>{v.totalErrorCount=0;}],['ui6FailedSegmentBytes',v=>{v.stopConfirmedByUtc='2026-10-08T05:40:00Z';}],
 ['ui6FailureBytes',v=>{v.result='passed';}],['ui6FailureBytes',v=>{v.originalStart='2026-10-08T05:52:00Z';}],['ui6FailureBytes',v=>{v.errorCount=0;}],
])test(`UI7 rejects rebound historical ${key} semantic drift: ${change}`,()=>{const f=sevenRoundFixture(),v=JSON.parse(f.context[key]);change(v);f.context[key]=jsonBytes(v);rebindUi6History(f);assert.equal(run(f).ok,false);});
for(const round of [4,5,6,7])test(`UI7 retains round ${round} 210-minute cap`,()=>{const f=sevenRoundFixture();f.doc.editor.iterations[round-1].completedAt='2026-10-08T12:00:00Z';refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_APPROVED_UI_BUDGET'));});
for(const aspect of ['functional','ux'])test(`final UI7 ${aspect} failure remains unresolved despite resolution evidence`,()=>{const f=sevenRoundFixture();Object.assign(f.doc.editor.iterations[6][aspect],{status:'failed',resolutionEvidence:'https://example.com/claimed'});refreshSeven(f);assert.ok(run(f).errors.includes(`TESTFLIGHT_EDITOR UNRESOLVED_REVIEW 7-${aspect}`));});
test('UI7-only grant fields cannot be used with an otherwise valid UI6 history',()=>{const f=sixRoundFixture(),g=sevenRoundFixture().context.grant;assert.equal(run(f).ok,true);Object.assign(f.context.grant,{ui7ApprovalFile:g.ui7ApprovalFile,ui7ApprovalSha256:g.ui7ApprovalSha256,historicalUi6:g.historicalUi6});assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);});
test('UI7 cannot move approval after its plan when both approval records agree',()=>{const f=sevenRoundFixture(),at='2026-10-08T06:22:00Z';rebindUi7Approval(f,{approvalRecordedAt:at});f.doc.editor.additionalIterationApprovals[2].approvedAt=at;refreshSeven(f);const r=run(f);assert.ok(r.errors.includes('TESTFLIGHT_UI7_APPROVAL_TIME'));assert.ok(!r.errors.includes('TESTFLIGHT_UI7_EDITOR_APPROVAL'));});
test('UI7 rejects a one-microsecond receipt change without truncating the approval timestamp',()=>{const f=sevenRoundFixture();rebindUi7Approval(f,{approvalRecordedAt:'2026-10-08T06:15:00.123456+00:00'});f.doc.editor.additionalIterationApprovals[2].approvedAt='2026-10-08T06:15:00.123456Z';refreshSeven(f);assert.equal(run(f).ok,true);f.doc.editor.additionalIterationApprovals[2].approvedAt='2026-10-08T06:15:00.123457Z';refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI7_EDITOR_APPROVAL'));});
for(const [sourceSha,configurationFingerprint,expected]of [[SHA,FP,true],['3'.repeat(40),FP,false],[SHA,'3'.repeat(64),false]])test(`UI7 preserves previously bound UI6 approval source/config: ${sourceSha}:${configurationFingerprint}`,()=>{const f=sevenRoundFixture(),a=JSON.parse(f.context.ui6ApprovalBytes);Object.assign(a,{sourceSha,configurationFingerprint});f.context.ui6ApprovalBytes=jsonBytes(a);f.context.grant.ui6ApprovalSha256=digest(f.context.ui6ApprovalBytes);rebindUi7Approval(f,{previousUiApprovalSha256:f.context.grant.ui6ApprovalSha256});assert.equal(run(f).ok,expected);});
test('UI7 historical assets must also be retained in the verified original observation set',()=>{const f=sevenRoundFixture();f.context.grant.originalObservationAssets.pop();f.doc.originalObservations.pop();refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI6_SNAPSHOT_CHANGED'));});
test('UI7 preserves the unchanged v1 retirement cutoff',()=>{const f=sevenRoundFixture();f.context.now='2026-10-22T00:00:00Z';assert.ok(run(f).errors.includes('TESTFLIGHT_EDITOR EVIDENCE_V1_RETIRED'));});
test('UI7 preserves exact original UI5/UI6 approval and proposal bytes',()=>{
 for(const [file,hash]of [['docs/design/2026-10-14-spiritgate-ui5/approval.json','7c5029587d363c4d42d1a1444f298292eeadae9bc558bf3bc5473fdb4c69e795'],['docs/design/2026-10-15-spiritgate-ui6/approval.json','bb53a1c3cc53e8450e0e33b0055422c80c0d51fdb8a596eaa34a82a8ca64574b'],['docs/design/2026-10-15-spiritgate-ui6/approved-proposal.md','08fe7332a1d24758f6800d56c7b6837d5af93165a11a155447202b70b9f5a886'],['docs/design/2026-10-15-spiritgate-ui7/approved-proposal.md','7d912748e44416e4a14d702909509206857d71c781dd2a168aada97a850af0a7'],['docs/design/2026-10-15-spiritgate-ui7/human-approval.json','d864eac9157b66d4718419e282b75399fa7ae15feca3e71f8c48374fe841d070']])assert.equal(digest(readFileSync(new URL('../'+file,import.meta.url))),hash);
});
test('pending current UI7 approval cannot authorize a grant before the real configuration is bound',()=>{
 const f=sevenRoundFixture();assert.equal(run(f).ok,true);
 rebindUi7Approval(f,{configurationFingerprint:null});
 const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_UI7_APPROVAL_SCOPE'),JSON.stringify(result.errors));
});
test('UI7 rejects missing historical project digests even after every bytes hash is rebound',()=>{
 const f=sevenRoundFixture(),h=f.context.grant.historicalUi6;
 f.context.ui6SourceSnapshotBytes=jsonBytes({sourceSha:h.sourceSha,files:[{path:'other.gd'}]});
 f.context.ui6ConfigurationBytes=jsonBytes({sourceSha:h.sourceSha,fingerprint:h.configurationFingerprint,runtimeKind:'godot-editor',nativeMarketFingerprint:null,configs:[{}]});
 const end=JSON.parse(f.context.ui6FailedSegmentBytes);end.sourceChanges=[{path:'project.godot'}];f.context.ui6FailedSegmentBytes=jsonBytes(end);rebindUi6History(f);
 const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_UI6_SNAPSHOT_SCOPE'),JSON.stringify(result.errors));
});
for(const value of [null,'','a'.repeat(63),'g'.repeat(64)])test(`UI7 rejects malformed historical before/after digests ${value}`,()=>{
 const f=sevenRoundFixture(),source=JSON.parse(f.context.ui6SourceSnapshotBytes),configuration=JSON.parse(f.context.ui6ConfigurationBytes),end=JSON.parse(f.context.ui6FailedSegmentBytes);
 source.files[0].sha256=value;configuration.sourceProjectSha256=value;configuration.configs[0].sha256=value;end.sourceChanges[0].beforeSha256=value;end.sourceChanges[0].afterSha256=value;
 f.context.ui6SourceSnapshotBytes=jsonBytes(source);f.context.ui6ConfigurationBytes=jsonBytes(configuration);f.context.ui6FailedSegmentBytes=jsonBytes(end);rebindUi6History(f);
 const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_UI6_SNAPSHOT_SCOPE'),JSON.stringify(result.errors));
});
test('UI7 overlapping historical run attack is rejected by the unchanged v1 ROUND_OVERLAP guard',()=>{
 const f=sevenRoundFixture();rebindUi7Approval(f,{approvalRecordedAt:'2026-10-08T05:50:30+00:00'});f.doc.editor.additionalIterationApprovals[2].approvedAt='2026-10-08T05:50:30Z';
 Object.assign(f.doc.editor.iterations[6],{plannedAt:'2026-10-08T05:51:30Z',startedAt:'2026-10-08T05:52:00Z',completedAt:'2026-10-08T06:30:00Z'});refreshSeven(f);
 const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_EDITOR ROUND_OVERLAP'),JSON.stringify(result.errors));assert.ok(!result.errors.includes('TESTFLIGHT_UI7_APPROVAL_TIME'));
});
test('UI7 missing Editor iterations fails closed under the existing v1 schema without escaping',()=>{
 const f=sevenRoundFixture();delete f.doc.editor.iterations;refreshSeven(f);let result;assert.doesNotThrow(()=>{result=run(f);});assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.startsWith('TESTFLIGHT_EDITOR EVIDENCE_SCHEMA')),JSON.stringify(result.errors));
});

// 합성 validator fixture이며 제품 UI7/UI8 실행 결과가 아니다.
const ui7Assets=[
 ['sourceSnapshotAsset','ui7SourceSnapshotBytes','source-before.json'],['configurationAsset','ui7ConfigurationBytes','configuration.json'],
 ['executionStartAsset','ui7ExecutionStartBytes','execution-start.json'],['mainIntegrityAsset','ui7MainIntegrityBytes','inspection/source-during-after-main-observations.json'],
 ['transitionAsset','ui7TransitionBytes','correction-53bec059-copy-receipt.json'],['recheckConfigurationAsset','ui7RecheckConfigurationBytes','recheck-53bec059/configuration.json'],
 ['recheckExecutionStartAsset','ui7RecheckExecutionStartBytes','recheck-53bec059/execution-start.json'],['recheckClockAsset','ui7RecheckClockBytes','recheck-53bec059/clock-clarification.json'],
 ['recheckIntegrityAsset','ui7RecheckIntegrityBytes','recheck-53bec059/final-snapshot-receipt.json'],['resultAsset','ui7ResultBytes','ui7-result.json'],
 ['cleanupAsset','ui7CleanupBytes','recheck-53bec059/process-cleanup-receipt.json'],['manifestAsset','ui7ManifestBytes','ui7-evidence-manifest.json'],
];
function eightRoundFixture(){
 const f=sevenRoundFixture(),g=f.context.grant,mainSource=g.sourceSha,mainFp=g.configurationFingerprint,recheckSource='5'.repeat(40),recheckFp='4'.repeat(64);
 const original=JSON.parse(f.context.ui7ApprovalBytes);original.configurationFingerprint=null;f.context.ui7ApprovalBytes=jsonBytes(original);g.ui7ApprovalSha256=digest(f.context.ui7ApprovalBytes);
 const helpers={'probe.gd':'a'.repeat(64)},project='1'.repeat(64),qa='2'.repeat(64);
 const files=[{path:'project.godot',bytes:10,sha256:project},{path:'src/example.gd',bytes:20,sha256:'3'.repeat(64)}];
 const values={
  ui7SourceSnapshotBytes:{sourceSha:mainSource,files},
  ui7ConfigurationBytes:{sourceSha:mainSource,fingerprint:mainFp,runtimeKind:'godot-editor',nativeMarketFingerprint:null,sourceProjectSha256:project,configs:[{sha256:qa}],helperHashes:helpers},
  ui7ExecutionStartBytes:{uiRound:7,recheckCount:0,sourceSha:mainSource,configurationFingerprint:mainFp,configurationFileSha256:null,plannedAt:'2026-10-08T06:20:00+00:00',startedAt:'2026-10-08T06:21:00+00:00',mainDeadlineAt:'2026-10-08T09:21:00+00:00',absoluteDeadlineAt:'2026-10-08T09:51:00+00:00',mainMinutes:180,problemRecheckLimit:1,problemRecheckMaxMinutes:30},
  ui7MainIntegrityBytes:{at:'2026-10-08T06:39:00Z',sourceSha:mainSource,filesChecked:2,missing:[],trackedDifferences:[{path:'project.godot',sourceSha256:project,currentSha256:qa}]},
  ui7TransitionBytes:{at:'2026-10-08T06:41:00Z',sourceOriginal:mainSource,sourceCorrected:recheckSource,filesCopied:[{path:'src/example.gd',old:files[1],new:{bytes:21,sha256:'4'.repeat(64)}},{path:'tests/new.gd',old:null,new:{bytes:30,sha256:'5'.repeat(64)}}],trackedFilesChecked:3,missing:[],trackedDifferences:[{path:'project.godot',sourceSha256:project,qaSha256:qa}],declaredQaHelpersUnchanged:true,runStartedByThisScript:false,recheckClockSetByThisScript:false,originalFailureHistoryModified:false},
  ui7RecheckConfigurationBytes:{sourceSha:recheckSource,fingerprint:recheckFp,originalFingerprint:mainFp,runtimeKind:'godot-editor',nativeMarketFingerprint:null,sourceProjectSha256:project,configs:[{sha256:qa}],helperHashes:helpers},
  ui7RecheckExecutionStartBytes:{uiRound:7,recheckCount:1,sourceSha:recheckSource,configurationSha256:null,plannedAt:'2026-10-08T06:40:00+00:00',runClickIntentAt:'2026-10-08T06:42:00+00:00',startedAt:'2026-10-08T06:42:09+00:00',deadline:'2026-10-08T07:12:09+00:00',absoluteOuterDeadline:'2026-10-08T09:51:00Z',restartsAllowed:0},
  ui7RecheckClockBytes:{intentAt:'2026-10-08T06:42:00+00:00',actualMarkerAt:'2026-10-08T06:42:09+00:00',effectiveStart:'2026-10-08T06:42:00+00:00',effectiveDeadline:'2026-10-08T07:12:00+00:00'},
  ui7RecheckIntegrityBytes:{at:'2026-10-08T07:04:30Z',sourceSha:recheckSource,sourceFilesChecked:3,missing:[],declaredTrackedDifference:[{path:'project.godot',source:project,qa}],helperHashes:{'probe.gd':{expected:helpers['probe.gd'],actual:helpers['probe.gd']}},newRun:false,uiInput:false,originalAutomaticRejectionsPreserved:true,actualProcessTerminatedAt:'2026-10-08T07:04:00+00:00',globalEditorSettingsUnchanged:true,profileUnchanged:true},
  ui7CleanupBytes:{at:'2026-10-08T07:04:00+00:00',pid:123,editorPidUntouched:321,signalSent:true,uiInputSent:false,newProcessStarted:false,processAbsentAfter:true},
  ui7ResultBytes:{round:7,verdict:'fail-and-incomplete',approvalConsumed:true,reportedAt:'2026-10-08T07:05:00+00:00',completedAt:'2026-10-08T07:05:00+00:00',main:{sourceSha:mainSource,startedAt:'2026-10-08T06:21:00Z',deadline:'2026-10-08T09:21:00Z',completedAt:'2026-10-08T06:40:00+00:00',counts:{pass:12,fail:3,unknown:13}},recheck:{sourceSha:recheckSource,count:1,effectiveStart:'2026-10-08T06:42:00Z',actualRuntimeMarkerAt:'2026-10-08T06:42:09Z',effectiveDeadline:'2026-10-08T07:12:00Z',completedAt:'2026-10-08T07:05:00+00:00',actualProcessTerminatedAt:'2026-10-08T07:04:00+00:00',complete28NewSource:'notcompleted',complete168NewSource:'notcompleted',smallHeroCardUx:'fail'},cleanup:{status:'completed-with-exact-user-approval',terminatedAt:'2026-10-08T07:04:00+00:00',pid:123,processAbsentAfter:true,uiInput:false,newRun:false,originalStopRejectionAndRootSigtermRejectionPreserved:true}},
 };
 for(const [key,value] of Object.entries(values))f.context[key]=jsonBytes(value);
 g.historicalUi7={sourceSha:mainSource,configurationFingerprint:mainFp,recheckSourceSha:recheckSource,recheckConfigurationFingerprint:recheckFp};
 for(const [i,[asset,key]]of ui7Assets.entries())g.historicalUi7[asset]={id:132+i,sha256:'0'.repeat(64)};
 g.approvedUiRounds=8;g.ui8ApprovalFile='docs/design/2026-10-15-spiritgate-ui8/approval.json';
 f.context.ui8ProposalBytes=Buffer.from('one UI8 with one input diagnostic inside 180+30 minutes; preserve UI7 dual-source failure');
 f.context.ui8ApprovalBytes=jsonBytes({...original,designId:'SGD-UI8-TF-110-v1',approvedUiRounds:8,originalApprovalSha256:'c'.repeat(64),originalProposalSha256:'d'.repeat(64),inputDiagnosticMaximumCount:1,inputDiagnosticMinutes:15,inputDiagnosticIncludedInExecutionMinutes:true,sourceSha:'8'.repeat(40),configurationFingerprint:'9'.repeat(64),approvalRecordedAt:'2026-10-08T07:15:00+00:00',proposalSha256:digest(f.context.ui8ProposalBytes),previousUiApprovalSha256:g.ui7ApprovalSha256,previousUiObservationSha256:{}});
 for(const aspect of ['functional','ux'])Object.assign(f.doc.editor.iterations[6][aspect],{status:'blocked',resolutionEvidence:'https://example.com/ui8-resolution'});
 f.doc.editor.iterations[6].completedAt='2026-10-08T07:05:00Z';
 const eighth=structuredClone(f.doc.editor.iterations[3]);Object.assign(eighth,{number:8,sourceSha:'8'.repeat(40),plannedAt:'2026-10-08T07:20:00Z',startedAt:'2026-10-08T07:21:00Z',completedAt:'2026-10-08T07:40:00Z'});f.doc.editor.iterations.push(eighth);
 f.doc.editor.additionalIterationApprovals.push({approverKind:'human',approver:'owner',approvedAt:'2026-10-08T07:15:00Z',maxRound:8,evidence:g.ui8ApprovalFile});
 for(const o of [g,f.context,f.doc.editor,f.doc.editor.e2e,f.doc.android,f.doc.ios,f.context.providerProof])o.sourceSha='8'.repeat(40);
 for(const o of [g,f.context,f.doc.editor.e2e.environment])o.configurationFingerprint='9'.repeat(64);
 Object.assign(f.doc.editor.e2e,{plannedAt:'2026-10-08T07:45:00Z',startedAt:'2026-10-08T07:46:00Z',completedAt:'2026-10-08T07:55:00Z'});
 return rebindUi7History(f);
}
function rebindUi7History(f){
 const h=f.context.grant.historicalUi7,a=JSON.parse(f.context.ui8ApprovalBytes);
 for(const [asset,key]of ui7Assets){const old=h[asset].sha256;f.context.grant.originalObservationAssets=f.context.grant.originalObservationAssets.filter(x=>x.id!==h[asset].id);f.doc.originalObservations=f.doc.originalObservations.filter(x=>x.sha256!==old);}
 for(const [key,value]of [['ui7ExecutionStartBytes','configurationFileSha256'],['ui7RecheckExecutionStartBytes','configurationSha256']]){const v=JSON.parse(f.context[key]);v[value]=digest(f.context[key==='ui7ExecutionStartBytes'?'ui7ConfigurationBytes':'ui7RecheckConfigurationBytes']);f.context[key]=jsonBytes(v);}
 const files=ui7Assets.filter(([asset])=>asset!=='manifestAsset').map(([,key,path])=>({path,bytes:f.context[key].length,sha256:digest(f.context[key])}));
 for(const path of ['failure-drag-unlock/failure.json','inspection/revive-prompt-pt-small/finding.json','failure-revive-ad-cancel-overlay/failure.json','recheck-53bec059/small-hero-menu-finding.json'])files.push({path,bytes:10,sha256:digest(Buffer.from(path))});
 f.context.ui7ManifestBytes=jsonBytes({at:'2026-10-08T07:06:00Z',result:'FAIL/INCOMPLETE',fileCount:files.length,files});
 for(const [asset,key]of ui7Assets){h[asset].sha256=digest(f.context[key]);f.context.grant.originalObservationAssets.push(h[asset]);f.doc.originalObservations.push({name:key+'.json',sha256:h[asset].sha256});a.previousUiObservationSha256[asset]=h[asset].sha256;}
 a.previousUiApprovalSha256=f.context.grant.ui7ApprovalSha256;f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);return refreshSeven(f);
}
function alterUi7(f,key,change){const v=JSON.parse(f.context[key]);change(v);f.context[key]=jsonBytes(v);return rebindUi7History(f);}
test('UI8 binds a new candidate while retaining failed UI7 main and one corrected recheck with conservative clocks',()=>{const f=eightRoundFixture(),r=run(f);assert.equal(r.ok,true,JSON.stringify(r.errors));assert.equal(r.approvedUiRounds,8);assert.equal(r.ui8ApprovalSha256,f.context.grant.ui8ApprovalSha256);assert.equal(r.productE2eStatus,'blocked');assert.equal(r.nativeQaWaived,false);assert.equal(f.context.grant.expiresAt,'2026-10-15T05:00:00Z');assert.equal(JSON.parse(f.context.ui7ApprovalBytes).configurationFingerprint,null);});
for(const [name,change]of [
 ['missing UI8 approval',f=>{delete f.context.ui8ApprovalBytes;}],['changed UI8 proposal',f=>{f.context.ui8ProposalBytes=Buffer.from('extended');}],
 ['missing UI7 history',f=>{delete f.context.grant.historicalUi7;}],['UI7 promoted to current source',f=>{f.doc.editor.iterations[6].sourceSha=f.context.sourceSha;}],
 ['UI7 functional promoted',f=>{f.doc.editor.iterations[6].functional.status='passed';}],['UI7 UX promoted',f=>{f.doc.editor.iterations[6].ux.status='passed';}],
 ['UI7 original end shifted',f=>{f.doc.editor.iterations[6].completedAt='2026-10-08T07:04:00Z';}],['UI8 starts before history ended',f=>{f.doc.editor.iterations[7].plannedAt='2026-10-08T07:04:00Z';}],
 ['UI8 wrong source',f=>{f.doc.editor.iterations[7].sourceSha=SHA;}],['missing UI8 Editor approval',f=>{f.doc.editor.additionalIterationApprovals.pop();}],
 ['missing UI7 Editor approval',f=>{f.doc.editor.additionalIterationApprovals.splice(2,1);}],['original expiry extended',f=>{f.context.grant.expiresAt='2026-10-16T05:00:00Z';}],
 ['UI8 unresolved failure',f=>{f.doc.editor.iterations[7].ux.status='failed';}],['UI8 E2E before final round',f=>{f.doc.editor.e2e.plannedAt='2026-10-08T07:39:00Z';}],
 ['public submission',f=>{f.context.phase='before-release';}],['Android foundation missing',f=>{f.doc.android.features.pop();}],
])test(`UI8 rejects ${name}`,()=>{const f=eightRoundFixture();change(f);refreshSeven(f);assert.equal(run(f).ok,false,name);});
for(const [asset,key]of ui7Assets){
 test(`UI8 rejects missing historical ${asset}`,()=>{const f=eightRoundFixture();delete f.context[key];assert.equal(run(f).ok,false);});
 test(`UI8 rejects changed historical ${asset}`,()=>{const f=eightRoundFixture();f.context[key]=Buffer.from('{}');assert.equal(run(f).ok,false);});
 for(const invalid of ['null','[]','{'])test(`UI8 fails closed for ${asset} ${invalid}`,()=>{const f=eightRoundFixture();f.context[key]=Buffer.from(invalid);const h=f.context.grant.historicalUi7;h[asset].sha256=digest(f.context[key]);let r;assert.doesNotThrow(()=>{r=run(f);});assert.equal(r.ok,false);});
}
for(const [key,change]of [
 ['ui7ConfigurationBytes',v=>{v.nativeMarketFingerprint=FP;}],['ui7ConfigurationBytes',v=>{v.fingerprint=FP;}],
 ['ui7MainIntegrityBytes',v=>{v.trackedDifferences.push({path:'src/example.gd'});}],['ui7MainIntegrityBytes',v=>{v.filesChecked=3;}],
 ['ui7TransitionBytes',v=>{v.filesCopied[0].old.sha256=FP;}],['ui7TransitionBytes',v=>{v.filesCopied[1].path=v.filesCopied[0].path;}],
 ['ui7TransitionBytes',v=>{v.originalFailureHistoryModified=true;}],['ui7TransitionBytes',v=>{v.trackedFilesChecked=4;}],
 ['ui7RecheckConfigurationBytes',v=>{v.sourceSha=SHA;}],['ui7RecheckConfigurationBytes',v=>{v.originalFingerprint=FP;}],
 ['ui7ExecutionStartBytes',v=>{v.mainDeadlineAt='2026-10-08T09:22:00Z';}],['ui7ExecutionStartBytes',v=>{v.absoluteDeadlineAt='2026-10-08T09:52:00Z';}],
 ['ui7RecheckExecutionStartBytes',v=>{v.recheckCount=2;}],['ui7RecheckExecutionStartBytes',v=>{v.restartsAllowed=1;}],
 ['ui7RecheckClockBytes',v=>{v.effectiveStart=v.actualMarkerAt;}],['ui7RecheckClockBytes',v=>{v.effectiveDeadline='2026-10-08T07:12:01Z';}],
 ['ui7RecheckIntegrityBytes',v=>{v.sourceFilesChecked=4;}],['ui7RecheckIntegrityBytes',v=>{v.helperHashes['probe.gd'].actual=FP;}],
 ['ui7ResultBytes',v=>{v.verdict='passed';}],['ui7ResultBytes',v=>{v.main.counts={pass:28,fail:0,unknown:0};}],
 ['ui7ResultBytes',v=>{v.recheck.count=2;}],['ui7ResultBytes',v=>{v.recheck.complete28NewSource='passed';}],
 ['ui7ResultBytes',v=>{v.recheck.complete168NewSource='passed';}],['ui7ResultBytes',v=>{v.recheck.smallHeroCardUx='pass';}],
 ['ui7ResultBytes',v=>{v.recheck.effectiveStart=v.recheck.actualRuntimeMarkerAt;}],['ui7CleanupBytes',v=>{v.processAbsentAfter=false;}],
 ['ui7CleanupBytes',v=>{v.newProcessStarted=true;}],['ui7CleanupBytes',v=>{v.uiInputSent=true;}],
 ['ui7CleanupBytes',v=>{v.at='2026-10-08T07:13:00Z';}],
])test(`UI8 rejects rebound historical semantic drift ${key}: ${change}`,()=>{const f=eightRoundFixture();alterUi7(f,key,change);assert.equal(run(f).ok,false);});
for(const [name,changes]of [
 ['missing original approval hash',{originalApprovalSha256:null}],['missing original proposal hash',{originalProposalSha256:null}],['second diagnostic',{inputDiagnosticMaximumCount:2}],['longer diagnostic',{inputDiagnosticMinutes:16}],['diagnostic outside main',{inputDiagnosticIncludedInExecutionMinutes:false}],['pending configuration',{configurationFingerprint:null}],['wrong source',{sourceSha:SHA}],['wrong config',{configurationFingerprint:FP}],
 ['wrong preceding approval',{previousUiApprovalSha256:FP}],['missing previous observation hashes',{previousUiObservationSha256:{}}],
 ['second recheck',{issueRecheckMaximumCount:2}],['extended budget',{totalMinutes:211}],['extension',{extendOriginal168Hours:true}],
])test(`UI8 rejects rebound approval ${name}`,()=>{const f=eightRoundFixture(),a=JSON.parse(f.context.ui8ApprovalBytes);Object.assign(a,changes);f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);assert.equal(run(f).ok,false);});
for(const round of [4,5,6,7,8])test(`UI8 preserves round ${round} 210 minute cap`,()=>{const f=eightRoundFixture();f.doc.editor.iterations[round-1].completedAt='2026-10-08T12:00:00Z';refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_APPROVED_UI_BUDGET'));});
test('UI8-only fields remain forbidden in the existing UI7 path',()=>{const f=sevenRoundFixture(),g=eightRoundFixture().context.grant;Object.assign(f.context.grant,{ui8ApprovalFile:g.ui8ApprovalFile,ui8ApprovalSha256:g.ui8ApprovalSha256,historicalUi7:g.historicalUi7});assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);});
function rebindUi7AssetOnly(f,asset,key){
 const h=f.context.grant.historicalUi7,old=h[asset].sha256;
 h[asset].sha256=digest(f.context[key]);
 f.doc.originalObservations.find(a=>a.sha256===old).sha256=h[asset].sha256;
 const a=JSON.parse(f.context.ui8ApprovalBytes);a.previousUiObservationSha256[asset]=h[asset].sha256;f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);return refreshSeven(f);
}
for(const [asset,key]of ui7Assets)for(const invalid of ['null','[]','{'])test(`UI8 rejects fully rebound malformed ${asset} ${invalid} before semantic interpretation`,()=>{const f=eightRoundFixture();f.context[key]=Buffer.from(invalid);rebindUi7AssetOnly(f,asset,key);let r;assert.doesNotThrow(()=>{r=run(f);});assert.equal(r.ok,false);assert.ok(r.errors.includes('TESTFLIGHT_INVALID_UI7_SNAPSHOT'),JSON.stringify(r.errors));});
for(const [name,change]of [
 ['missing failure entry',m=>{m.files=m.files.filter(f=>f.path!=='failure-drag-unlock/failure.json');m.fileCount=m.files.length;}],
 ['wrong source byte count',m=>{m.files.find(f=>f.path==='source-before.json').bytes++;}],
 ['wrong source digest',m=>{m.files.find(f=>f.path==='source-before.json').sha256=FP;}],
 ['wrong file count',m=>{m.fileCount++;}],['duplicate original path',m=>{m.files.push(m.files[0]);m.fileCount++;}],
 ['invalid manifest timestamp',m=>{m.at='not a time';}],['manifest before completion',m=>{m.at='2026-10-08T07:04:59Z';}],
])test(`UI8 rejects rebound manifest ${name}`,()=>{const f=eightRoundFixture(),m=JSON.parse(f.context.ui7ManifestBytes);change(m);f.context.ui7ManifestBytes=jsonBytes(m);rebindUi7AssetOnly(f,'manifestAsset','ui7ManifestBytes');assert.ok(run(f).errors.includes('TESTFLIGHT_UI7_MANIFEST'));});
test('UI8 rejects a missing original observation asset even when its direct history digest matches',()=>{const f=eightRoundFixture();const a=f.context.grant.historicalUi7.resultAsset;f.context.grant.originalObservationAssets=f.context.grant.originalObservationAssets.filter(x=>x.id!==a.id);f.doc.originalObservations=f.doc.originalObservations.filter(x=>x.sha256!==a.sha256);refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI7_SNAPSHOT_CHANGED'));});
test('UI8 requires its exact approval time before planning and preserves microseconds',()=>{const f=eightRoundFixture(),a=JSON.parse(f.context.ui8ApprovalBytes);a.approvalRecordedAt='2026-10-08T07:15:00.123456+00:00';f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);f.doc.editor.additionalIterationApprovals[3].approvedAt='2026-10-08T07:15:00.123456Z';refreshSeven(f);assert.equal(run(f).ok,true);f.doc.editor.additionalIterationApprovals[3].approvedAt='2026-10-08T07:15:00.123457Z';refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_EDITOR_APPROVAL'));a.approvalRecordedAt='2026-10-08T07:22:00Z';f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);f.doc.editor.additionalIterationApprovals[3].approvedAt=a.approvalRecordedAt;refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_APPROVAL_TIME'));});
for(const value of [null,{},[],{id:1,sha256:FP,unexpected:true}])test(`UI8 typed history role rejects ${JSON.stringify(value)}`,()=>{const f=eightRoundFixture();f.context.grant.historicalUi7.resultAsset=value;assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);});
test('UI8 preserves the previous UI7 approval bytes and v1 retirement cutoff',()=>{assert.equal(digest(readFileSync(new URL('../docs/design/2026-10-15-spiritgate-ui7/approval.json',import.meta.url))),'10691fd516b03027d810b25f3cbd3a9bde8bfa9c9b1e9546d1cfb959ac851e2a');const f=eightRoundFixture();f.context.now='2026-10-22T00:00:00Z';assert.ok(run(f).errors.includes('TESTFLIGHT_EDITOR EVIDENCE_V1_RETIRED'));});
test('UI8 support does not authorize a ninth round',()=>{const f=eightRoundFixture();f.context.grant.approvedUiRounds=9;f.doc.editor.iterations.push({...f.doc.editor.iterations[7],number:9});refreshSeven(f);assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);});
