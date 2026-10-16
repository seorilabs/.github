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
  ui7RecheckExecutionStartBytes:{uiRound:7,recheckCount:1,sourceSha:recheckSource,marker:{pid:123,sourceSha:recheckSource},configurationSha256:null,plannedAt:'2026-10-08T06:40:00+00:00',runClickIntentAt:'2026-10-08T06:42:00+00:00',startedAt:'2026-10-08T06:42:09+00:00',deadline:'2026-10-08T07:12:09+00:00',absoluteOuterDeadline:'2026-10-08T09:51:00Z',restartsAllowed:0},
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
 f.context.ui8HumanApprovalBytes=jsonBytes({originalApprovalSha256:'c'.repeat(64),originalProposalSha256:'d'.repeat(64)});
 f.context.ui8ApprovalBytes=jsonBytes({...original,designId:'SGD-UI8-TF-110-v1',approvedUiRounds:8,humanApprovalSha256:digest(f.context.ui8HumanApprovalBytes),originalApprovalSha256:'c'.repeat(64),originalProposalSha256:'d'.repeat(64),inputDiagnosticMaximumCount:1,inputDiagnosticMinutes:15,inputDiagnosticIncludedInExecutionMinutes:true,sourceSha:'8'.repeat(40),configurationFingerprint:'9'.repeat(64),approvalRecordedAt:'2026-10-08T07:15:00+00:00',proposalSha256:digest(f.context.ui8ProposalBytes),previousUiApprovalSha256:g.ui7ApprovalSha256,previousUiObservationSha256:{}});
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
test('UI8 rejects an arbitrary valid origin digest that disagrees with its reviewed public human receipt',()=>{const f=eightRoundFixture(),a=JSON.parse(f.context.ui8ApprovalBytes);a.originalApprovalSha256=FP;f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);const r=run(f);assert.equal(r.ok,false);assert.ok(r.errors.includes('TESTFLIGHT_UI8_HUMAN_APPROVAL_SCOPE'));});
test('UI8 approval cannot predate the UI7 manifest whose hashes it binds even when Editor approval agrees',()=>{const f=eightRoundFixture(),a=JSON.parse(f.context.ui8ApprovalBytes);a.approvalRecordedAt='2026-10-08T06:30:00Z';f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);f.doc.editor.additionalIterationApprovals[3].approvedAt=a.approvalRecordedAt;refreshSeven(f);const r=run(f);assert.equal(r.ok,false);assert.ok(r.errors.includes('TESTFLIGHT_UI8_APPROVAL_TIME'));});
test('UI7 final manifest hashing remains inside its original recheck budget even before a later UI8 approval',()=>{const f=eightRoundFixture(),m=JSON.parse(f.context.ui7ManifestBytes);m.at='2026-10-08T07:13:00Z';f.context.ui7ManifestBytes=jsonBytes(m);rebindUi7AssetOnly(f,'manifestAsset','ui7ManifestBytes');const r=run(f);assert.equal(r.ok,false);assert.ok(r.errors.includes('TESTFLIGHT_UI7_MANIFEST'));});
for(const [name,change]of [
 ['original proposal claimed as public proposal',a=>{a.originalProposalSha256=a.proposalSha256;}],
 ['original approval claimed as original proposal',a=>{a.originalApprovalSha256=a.originalProposalSha256;}],
 ['original approval claimed as public receipt',a=>{a.originalApprovalSha256=a.humanApprovalSha256;}],
])test(`UI8 origin/public alias is rejected by the immutable receipt pair: ${name}`,()=>{const f=eightRoundFixture(),a=JSON.parse(f.context.ui8ApprovalBytes);change(a);f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_HUMAN_APPROVAL_SCOPE'));});
for(const invalid of ['null','[]','{'])test(`UI8 rejects rebound malformed public human receipt ${invalid}`,()=>{const f=eightRoundFixture(),a=JSON.parse(f.context.ui8ApprovalBytes);f.context.ui8HumanApprovalBytes=Buffer.from(invalid);a.humanApprovalSha256=digest(f.context.ui8HumanApprovalBytes);f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);let r;assert.doesNotThrow(()=>{r=run(f);});assert.equal(r.ok,false);assert.ok(r.errors.some(e=>e==='TESTFLIGHT_INVALID_UI8_HUMAN_APPROVAL' || e==='TESTFLIGHT_UI8_HUMAN_APPROVAL_SCOPE'));});
for(const change of [f=>{delete f.context.ui8HumanApprovalBytes;},f=>{f.context.ui8HumanApprovalBytes=Buffer.from('{}');}])test(`UI8 rejects missing or changed public human bytes: ${change}`,()=>{const f=eightRoundFixture();change(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_HUMAN_APPROVAL_CHANGED'));});
test('UI8 approval may follow the exact original manifest boundary',()=>{const f=eightRoundFixture(),a=JSON.parse(f.context.ui8ApprovalBytes);a.approvalRecordedAt='2026-10-08T07:06:00Z';f.context.ui8ApprovalBytes=jsonBytes(a);f.context.grant.ui8ApprovalSha256=digest(f.context.ui8ApprovalBytes);f.doc.editor.additionalIterationApprovals[3].approvedAt=a.approvalRecordedAt;refreshSeven(f);assert.equal(run(f).ok,true);});
test('UI7 final hashing may finish exactly at the original recheck cap',()=>{const f=eightRoundFixture(),m=JSON.parse(f.context.ui7ManifestBytes);m.at='2026-10-08T07:12:00Z';f.context.ui7ManifestBytes=jsonBytes(m);rebindUi7AssetOnly(f,'manifestAsset','ui7ManifestBytes');assert.equal(run(f).ok,true);});
test('historical file role names do not authenticate a commit prefix; all JSON source claims must match',()=>{const f=eightRoundFixture();assert.equal(f.context.grant.historicalUi7.recheckSourceSha,'5'.repeat(40));assert.equal(run(f).ok,true);alterUi7(f,'ui7RecheckIntegrityBytes',v=>{v.sourceSha='6'.repeat(40);});assert.ok(run(f).errors.includes('TESTFLIGHT_UI7_SNAPSHOT_SCOPE'));});
test('UI7 cleanup must terminate the exact process from the corrected Run marker',()=>{const f=eightRoundFixture(),c=JSON.parse(f.context.ui7CleanupBytes),r=JSON.parse(f.context.ui7ResultBytes);c.pid=456;r.cleanup.pid=456;f.context.ui7CleanupBytes=jsonBytes(c);f.context.ui7ResultBytes=jsonBytes(r);rebindUi7History(f);const result=run(f);assert.equal(result.ok,false);assert.ok(result.errors.includes('TESTFLIGHT_UI7_FAILURE_HISTORY'));});

// 수동 UI9 지원의 합성 검증기 입력이다. 실제 사람 조작·제품 검수 결과가 아니다.
const ui8Assets=[
 ['sourceSnapshotAsset','ui8SourceSnapshotBytes','preparation/source-before.json'],['configurationAsset','ui8ConfigurationBytes','configuration.json'],
 ['frozenManifestAsset','ui8FrozenManifestBytes','preparation/frozen-manifest.json'],['executionStartAsset','ui8ExecutionStartBytes','execution-start.json'],
 ['sourceIntegrityAsset','ui8SourceIntegrityBytes','final-preserved/final-source-and-settings-check.json'],['resultAsset','ui8ResultBytes','ui8-result.json'],
 ['cleanupAsset','ui8CleanupBytes','process-cleanup-receipt.json'],['manifestAsset','ui8ManifestBytes','ui8-evidence-manifest.json'],
];
function nineRoundFixture(){
 const f=eightRoundFixture(),g=f.context.grant,source=g.sourceSha,fp=g.configurationFingerprint;
 const project='1'.repeat(64),qa='2'.repeat(64),helper='3'.repeat(64),binary='4'.repeat(64),settings='5'.repeat(64),plan='6'.repeat(64);
 const files=[{path:'project.godot',bytes:10,sha256:project},{path:'src/example.gd',bytes:20,sha256:'7'.repeat(64)}];
 const declared=[{path:'project.godot',sourceSha256:project,qaSha256:qa}];
 const cleanup={at:'2026-10-08T07:25:00Z',events:[{pid:123,signal:'SIGTERM',at:'2026-10-08T07:24:59Z',attempt:1},{pid:321,signal:'SIGTERM',at:'2026-10-08T07:24:59Z',attempt:1}],verifiedOwnedBefore:[{pid:123,kind:'diagnostic-game'},{pid:321,kind:'diagnostic-editor'}],requestedPidsAbsent:true,remainingRequestedPids:[],ownedAppProcessRowsAfter:[],noCuaQueryAfterTermination:true,noNewProcessStarted:true,noUiInputSent:true,productRunCount:0,diagnosticCount:1,counterClicks:0,scrollCalls:0};
 const values={
  ui8SourceSnapshotBytes:{sourceSha:source,files},
  ui8ConfigurationBytes:{sourceSha:source,fingerprint:fp,nativeMarketFingerprint:null,trackedSourceCount:2,configs:[{sha256:qa}],helperHashes:{'probe.gd':helper},diagnosticFiles:{'probe.gd':helper,'project.godot':qa},binarySha256:binary,globalEditorSettingsAtDiagnosticBaselineSha256:settings,firstEditorLaunchOccurred:false},
  ui8FrozenManifestBytes:{frozenAt:'2026-10-08T07:20:30Z',sourceSha:source,sourceTrackedFiles:2,trackedMissing:[],trackedDeclaredQaDifference:declared,configurationFingerprint:fp,configurationSha256:null,planSha256:plan,engineBinarySha256:binary,firstEditorLaunchOccurred:false,frozenHelpers:{'probe.gd':helper},frozenDiagnosticFiles:{'probe.gd':helper,'project.godot':qa}},
  ui8ExecutionStartBytes:{round:8,sourceSha:source,plannedAt:'2026-10-08T07:20:00Z',startedAt:'2026-10-08T07:21:00Z',diagnosticDeadline:'2026-10-08T07:36:00Z',mainDeadline:'2026-10-08T10:21:00Z',outerDeadlineWithSingleRecheck:'2026-10-08T10:51:00Z',configurationSha256:null,configurationFingerprint:fp,planSha256:plan,clockStartsBeforeFirstDiagnosticEditorPopen:true,diagnosticCount:1,diagnosticRestartAllowed:false},
  ui8SourceIntegrityBytes:{at:'2026-10-08T07:27:00Z',sourceSha:source,trackedChecked:2,missing:[],trackedDeclaredDifference:declared,helperHashes:{'probe.gd':{frozen:helper,actual:helper}},diagnosticHashesAfterEditorRun:[{path:'probe.gd',frozenSha256:helper,actualSha256:helper},{path:'project.godot',frozenSha256:qa,actualSha256:'a'.repeat(64)}],globalDiagnosticBaseline:settings,globalAfterUi8:settings,globalUnchangedDuringNewUi8Engine:true,binaryHashUnchanged:true,isolatedProductProfileAbsent:true},
  ui8CleanupBytes:cleanup,
  ui8ResultBytes:{round:8,sourceSha:source,status:'blocked',verdict:'FAIL/BLOCKED/INCOMPLETE',approvalConsumed:true,plannedAt:'2026-10-08T07:20:00Z',startedAt:'2026-10-08T07:21:00Z',diagnosticDeadline:'2026-10-08T07:36:00Z',mainDeadline:'2026-10-08T10:21:00Z',outerDeadline:'2026-10-08T10:51:00Z',reportedAt:'2026-10-08T07:30:00Z',completedAt:'2026-10-08T07:30:00Z',completedBeforeDiagnosticDeadline:true,clockNotReset:true,unusedBudgetCarryForward:false,diagnostic:{count:1,editorPid:321,gamePid:123,actualProbeButtonClicks:0,actualScrollCalls:0,actualCounter:0,noAlternativeHandleNamePidRouteOrRestart:true},productRunCount:0,featureCounts:{pass:0,fail:0,blocked:28},matrix:{expected:168,actualProductCellsCaptured:0,passed:0,status:'notrun-after-diagnostic-block'},problemRecheckCount:0,E2E:'notplanned/notrun',ui9:'notapproved/notrun',configuration:{frozenFingerprint:fp,sha256:null,nativeMarketFingerprint:null},processCleanup:cleanup},
 };
 for(const [key,value]of Object.entries(values))f.context[key]=jsonBytes(value);
 g.historicalUi8={sourceSha:source,configurationFingerprint:fp};
 for(const [i,[asset]]of ui8Assets.entries())g.historicalUi8[asset]={id:150+i,sha256:'0'.repeat(64)};
 g.approvedUiRounds=9;g.ui9ApprovalFile='docs/design/2026-10-16-spiritgate-ui9/approval.json';
 f.context.ui9ProposalBytes=Buffer.from('one human manual UI9 and independent agent evaluation; no diagnostic restart; unchanged signing and 180+30 minute limits');
 const handoff={directedAt:'2026-10-08T07:45:00.123456Z',originalDirectiveSha256:'0'.repeat(64),sameRound:9,inputBefore:'human',inputAfter:'independent-agent',sourceSha:'9'.repeat(40),configurationFingerprint:'8'.repeat(64),sameStartedAt:'2026-10-08T07:41:00Z',mainDeadlineAt:'2026-10-08T10:41:00Z',absoluteMaximumAt:'2026-10-08T11:11:00Z',clockReset:false,frozenHelpersModified:false,newRun:false,authorInputCountsAsIndependentReview:false};
 f.context.ui9HumanApprovalBytes=jsonBytes({approvedAt:'2026-10-08T07:35:00Z',originalApprovalSha256:'e'.repeat(64),originalProposalSha256:'f'.repeat(64),operatorHandoff:handoff});
 const old=JSON.parse(f.context.ui8ApprovalBytes);
 f.context.ui9ApprovalBytes=jsonBytes({...old,designId:'SGD-UI9-TF-110-v1',approvedUiRounds:9,sourceSha:'9'.repeat(40),configurationFingerprint:'8'.repeat(64),approvalRecordedAt:'2026-10-08T07:35:00+00:00',userApprovalVerbatim:'human manual UI9 followed by separately directed agent input; keep independent evaluation and all tests',humanApprovalSha256:digest(f.context.ui9HumanApprovalBytes),originalApprovalSha256:'e'.repeat(64),originalProposalSha256:'f'.repeat(64),proposalSha256:digest(f.context.ui9ProposalBytes),previousUiApprovalSha256:g.ui8ApprovalSha256,previousUiObservationSha256:{},inputMode:'human-then-agent',operatorHandoff:handoff,independentEvaluationRequired:true,inputDiagnosticMaximumCount:0,inputDiagnosticMinutes:0,inputDiagnosticIncludedInExecutionMinutes:true});
 for(const aspect of ['functional','ux'])Object.assign(f.doc.editor.iterations[7][aspect],{status:'blocked',resolutionEvidence:'https://example.com/manual-nine-resolution'});
 f.doc.editor.iterations[7].completedAt='2026-10-08T07:30:00Z';
 const ninth=structuredClone(f.doc.editor.iterations[3]);Object.assign(ninth,{number:9,sourceSha:'9'.repeat(40),plannedAt:'2026-10-08T07:40:00Z',startedAt:'2026-10-08T07:41:00Z',completedAt:'2026-10-08T08:00:00Z',reviewer:'independent-observer'});f.doc.editor.iterations.push(ninth);
 f.doc.editor.additionalIterationApprovals.push({approverKind:'human',approver:'owner',approvedAt:'2026-10-08T07:35:00Z',maxRound:9,evidence:g.ui9ApprovalFile});
 for(const o of [g,f.context,f.doc.editor,f.doc.editor.e2e,f.doc.android,f.doc.ios,f.context.providerProof])o.sourceSha='9'.repeat(40);
 for(const o of [g,f.context,f.doc.editor.e2e.environment])o.configurationFingerprint='8'.repeat(64);
 Object.assign(f.doc.editor.e2e,{plannedAt:'2026-10-08T08:05:00Z',startedAt:'2026-10-08T08:06:00Z',completedAt:'2026-10-08T08:15:00Z'});
 return rebindUi8History(f);
}
function rebindUi8History(f){
 const h=f.context.grant.historicalUi8,a=JSON.parse(f.context.ui9ApprovalBytes);
 for(const [asset]of ui8Assets){const old=h[asset].sha256;f.context.grant.originalObservationAssets=f.context.grant.originalObservationAssets.filter(x=>x.id!==h[asset].id);f.doc.originalObservations=f.doc.originalObservations.filter(x=>x.sha256!==old);}
 const cfg=digest(f.context.ui8ConfigurationBytes);
 for(const key of ['ui8FrozenManifestBytes','ui8ExecutionStartBytes']){const v=JSON.parse(f.context[key]);v.configurationSha256=cfg;f.context[key]=jsonBytes(v);}
 const r=JSON.parse(f.context.ui8ResultBytes);r.configuration.sha256=cfg;f.context.ui8ResultBytes=jsonBytes(r);
 const files=ui8Assets.filter(([asset])=>asset!=='manifestAsset').map(([,key,path])=>({path,bytes:f.context[key].length,sha256:digest(f.context[key])}));
 f.context.ui8ManifestBytes=jsonBytes({at:'2026-10-08T07:31:00Z',sourceSha:h.sourceSha,round:8,verdict:'FAIL/BLOCKED',fileCount:files.length,files});
 for(const [asset,key]of ui8Assets){h[asset].sha256=digest(f.context[key]);f.context.grant.originalObservationAssets.push(h[asset]);f.doc.originalObservations.push({name:key+'.json',sha256:h[asset].sha256});a.previousUiObservationSha256[asset]=h[asset].sha256;}
 a.previousUiApprovalSha256=f.context.grant.ui8ApprovalSha256;f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);return refreshSeven(f);
}
test('UI9 draft binds initial human input and separately directed agent takeover while retaining blocked UI8',()=>{const f=nineRoundFixture(),r=run(f);assert.equal(r.ok,true,JSON.stringify(r.errors));assert.equal(r.approvedUiRounds,9);assert.equal(r.ui9ApprovalSha256,f.context.grant.ui9ApprovalSha256);assert.equal(r.nativeQaWaived,false);assert.equal(r.productE2eStatus,'blocked');assert.equal(JSON.parse(f.context.ui8ResultBytes).ui9,'notapproved/notrun');assert.equal(JSON.parse(f.context.ui9ApprovalBytes).approvalRecordedAt,'2026-10-08T07:35:00+00:00');assert.equal(JSON.parse(f.context.ui9ApprovalBytes).operatorHandoff.directedAt,'2026-10-08T07:45:00.123456Z');});
function rebindUi8AssetOnly(f,asset,key){
 const h=f.context.grant.historicalUi8,old=h[asset].sha256;
 h[asset].sha256=digest(f.context[key]);f.doc.originalObservations.find(a=>a.sha256===old).sha256=h[asset].sha256;
 const a=JSON.parse(f.context.ui9ApprovalBytes);a.previousUiObservationSha256[asset]=h[asset].sha256;f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);return refreshSeven(f);
}
function alterUi8(f,key,change){const v=JSON.parse(f.context[key]);change(v);f.context[key]=jsonBytes(v);return rebindUi8History(f);}
for(const [asset,key]of ui8Assets){
 test(`UI9 rejects missing historical ${asset}`,()=>{const f=nineRoundFixture();delete f.context[key];assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_SNAPSHOT_CHANGED'));});
 test(`UI9 rejects changed historical ${asset}`,()=>{const f=nineRoundFixture();f.context[key]=Buffer.from('{}');assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_SNAPSHOT_CHANGED'));});
 for(const invalid of ['null','[]','{'])test(`UI9 rejects fully rebound malformed ${asset} ${invalid}`,()=>{const f=nineRoundFixture();f.context[key]=Buffer.from(invalid);rebindUi8AssetOnly(f,asset,key);let r;assert.doesNotThrow(()=>{r=run(f);});assert.ok(r.errors.includes('TESTFLIGHT_INVALID_UI8_SNAPSHOT'),JSON.stringify(r.errors));});
}
for(const [key,change,code]of [
 ['ui8ConfigurationBytes',v=>{v.nativeMarketFingerprint=FP;},'SNAPSHOT_SCOPE'],['ui8ConfigurationBytes',v=>{v.fingerprint=FP;},'SNAPSHOT_SCOPE'],
 ['ui8ConfigurationBytes',v=>{v.firstEditorLaunchOccurred=true;},'SNAPSHOT_SCOPE'],['ui8FrozenManifestBytes',v=>{v.firstEditorLaunchOccurred=true;},'SNAPSHOT_SCOPE'],
 ['ui8SourceSnapshotBytes',v=>{v.sourceSha=SHA;},'SNAPSHOT_SCOPE'],['ui8SourceIntegrityBytes',v=>{v.sourceSha=SHA;},'SNAPSHOT_SCOPE'],
 ['ui8FrozenManifestBytes',v=>{v.planSha256=FP;},'SNAPSHOT_SCOPE'],['ui8ExecutionStartBytes',v=>{v.planSha256=FP;},'SNAPSHOT_SCOPE'],
 ['ui8SourceIntegrityBytes',v=>{v.trackedChecked=3;},'SOURCE_HISTORY'],['ui8SourceIntegrityBytes',v=>{v.missing=['src/example.gd'];},'SOURCE_HISTORY'],
 ['ui8SourceIntegrityBytes',v=>{v.trackedDeclaredDifference.push({path:'src/example.gd'});},'SOURCE_HISTORY'],
 ['ui8SourceIntegrityBytes',v=>{v.helperHashes['probe.gd'].actual=FP;},'SOURCE_HISTORY'],['ui8FrozenManifestBytes',v=>{v.frozenHelpers['probe.gd']=FP;},'SOURCE_HISTORY'],
 ['ui8SourceIntegrityBytes',v=>{v.diagnosticHashesAfterEditorRun[0].actualSha256=FP;},'SOURCE_HISTORY'],
 ['ui8SourceIntegrityBytes',v=>{v.globalAfterUi8=FP;},'SOURCE_HISTORY'],['ui8SourceIntegrityBytes',v=>{v.binaryHashUnchanged=false;},'SOURCE_HISTORY'],
 ['ui8ResultBytes',v=>{v.verdict='passed';},'FAILURE_HISTORY'],['ui8ResultBytes',v=>{v.productRunCount=1;},'FAILURE_HISTORY'],
 ['ui8ResultBytes',v=>{v.featureCounts={pass:28,fail:0,blocked:0};},'FAILURE_HISTORY'],['ui8ResultBytes',v=>{v.matrix.passed=168;},'FAILURE_HISTORY'],
 ['ui8ResultBytes',v=>{v.problemRecheckCount=1;},'FAILURE_HISTORY'],['ui8ResultBytes',v=>{v.ui9='approved';},'FAILURE_HISTORY'],
 ['ui8ResultBytes',v=>{v.E2E='passed';},'FAILURE_HISTORY'],['ui8ResultBytes',v=>{v.diagnostic.count=2;},'FAILURE_HISTORY'],
 ['ui8ResultBytes',v=>{v.diagnostic.actualProbeButtonClicks=10;},'FAILURE_HISTORY'],['ui8ResultBytes',v=>{v.diagnostic.gamePid=456;},'FAILURE_HISTORY'],
 ['ui8CleanupBytes',v=>{v.noNewProcessStarted=false;},'FAILURE_HISTORY'],['ui8CleanupBytes',v=>{v.requestedPidsAbsent=false;},'FAILURE_HISTORY'],
 ['ui8CleanupBytes',v=>{v.events[0].pid=456;},'FAILURE_HISTORY'],['ui8CleanupBytes',v=>{v.events[0].attempt=2;},'FAILURE_HISTORY'],
 ['ui8ExecutionStartBytes',v=>{v.diagnosticDeadline='2026-10-08T07:37:00Z';},'ORIGINAL_TIME'],
 ['ui8ExecutionStartBytes',v=>{v.mainDeadline='2026-10-08T10:22:00Z';},'ORIGINAL_TIME'],
 ['ui8ExecutionStartBytes',v=>{v.outerDeadlineWithSingleRecheck='2026-10-08T10:52:00Z';},'ORIGINAL_TIME'],
 ['ui8ExecutionStartBytes',v=>{v.diagnosticRestartAllowed=true;},'ORIGINAL_TIME'],['ui8ExecutionStartBytes',v=>{v.clockStartsBeforeFirstDiagnosticEditorPopen=false;},'ORIGINAL_TIME'],
 ['ui8ResultBytes',v=>{v.clockNotReset=false;},'ORIGINAL_TIME'],['ui8ResultBytes',v=>{v.unusedBudgetCarryForward=true;},'ORIGINAL_TIME'],
 ['ui8FrozenManifestBytes',v=>{v.frozenAt='2026-10-08T07:22:00Z';},'ORIGINAL_TIME'],
])test(`UI9 rejects rebound UI8 semantic drift ${key}: ${change}`,()=>{const f=nineRoundFixture();alterUi8(f,key,change);const r=run(f);assert.equal(r.ok,false);assert.ok(r.errors.includes('TESTFLIGHT_UI8_'+code),JSON.stringify(r.errors));});
for(const [name,change]of [
 ['missing file',m=>{m.files.pop();m.fileCount=m.files.length;}],['wrong bytes',m=>{m.files[0].bytes++;}],
 ['wrong digest',m=>{m.files[0].sha256=FP;}],['duplicate path',m=>{m.files.push(m.files[0]);m.fileCount++;}],
 ['wrong file count',m=>{m.fileCount++;}],['promoted verdict',m=>{m.verdict='passed';}],
])test(`UI9 rejects rebound historical manifest ${name}`,()=>{const f=nineRoundFixture(),m=JSON.parse(f.context.ui8ManifestBytes);change(m);f.context.ui8ManifestBytes=jsonBytes(m);rebindUi8AssetOnly(f,'manifestAsset','ui8ManifestBytes');assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_MANIFEST'));});
test('UI9 rejects final UI8 hashing outside the original diagnostic cap even before manual approval',()=>{const f=nineRoundFixture(),m=JSON.parse(f.context.ui8ManifestBytes);m.at='2026-10-08T07:36:00.001Z';f.context.ui8ManifestBytes=jsonBytes(m);rebindUi8AssetOnly(f,'manifestAsset','ui8ManifestBytes');assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_ORIGINAL_TIME'));});
test('UI9 requires original asset membership beyond matching direct digest',()=>{const f=nineRoundFixture(),a=f.context.grant.historicalUi8.cleanupAsset;f.context.grant.originalObservationAssets=f.context.grant.originalObservationAssets.filter(x=>x.id!==a.id);f.doc.originalObservations=f.doc.originalObservations.filter(x=>x.sha256!==a.sha256);refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_SNAPSHOT_CHANGED'));});
for(const [name,change]of [
 ['wrong current source',f=>{f.doc.editor.iterations[8].sourceSha=SHA;}],['old UI8 source promoted',f=>{f.doc.editor.iterations[7].sourceSha=f.context.sourceSha;}],
 ['old UI8 failure promoted',f=>{f.doc.editor.iterations[7].functional.status='passed';}],['old UI8 resolution omitted',f=>{delete f.doc.editor.iterations[7].ux.resolutionEvidence;}],
 ['old UI8 block changed to functional failure',f=>{f.doc.editor.iterations[7].functional.status='failed';}],
 ['old UI8 completion shifted',f=>{f.doc.editor.iterations[7].completedAt='2026-10-08T07:29:00Z';}],['last UI9 UX failed',f=>{f.doc.editor.iterations[8].ux.status='failed';}],
 ['E2E before round9',f=>{f.doc.editor.e2e.plannedAt='2026-10-08T07:59:00Z';}],['missing UI9 editor approval',f=>{f.doc.editor.additionalIterationApprovals.pop();}],
 ['missing historical UI8',f=>{delete f.context.grant.historicalUi8;}],['missing UI9 approval bytes',f=>{delete f.context.ui9ApprovalBytes;}],
 ['changed UI9 proposal',f=>{f.context.ui9ProposalBytes=Buffer.from('extended');}],['missing UI9 public human bytes',f=>{delete f.context.ui9HumanApprovalBytes;}],
 ['later expiry',f=>{f.context.grant.expiresAt='2026-10-16T05:00:00Z';}],['public release',f=>{f.context.phase='before-release';}],
 ['Android foundation missing',f=>{f.doc.android.features.pop();}],['unapproved tenth',f=>{f.context.grant.approvedUiRounds=10;}],
])test(`UI9 preserves existing gates: ${name}`,()=>{const f=nineRoundFixture();change(f);refreshSeven(f);assert.equal(run(f).ok,false,name);});
for(const [name,change,code]of [
 ['pending configuration',{configurationFingerprint:null},'APPROVAL_SCOPE'],['wrong source',{sourceSha:SHA},'APPROVAL_SCOPE'],['wrong config',{configurationFingerprint:FP},'APPROVAL_SCOPE'],
 ['agent input claimed',{inputMode:'agent'},'APPROVAL_SCOPE'],['evaluation waived',{independentEvaluationRequired:false},'APPROVAL_SCOPE'],
 ['automatic diagnostic added',{inputDiagnosticMaximumCount:1},'APPROVAL_SCOPE'],['second recheck',{issueRecheckMaximumCount:2},'APPROVAL_SCOPE'],
 ['longer total',{totalMinutes:211},'APPROVAL_SCOPE'],['extended freshness',{extendOriginal168Hours:true},'APPROVAL_SCOPE'],
 ['wrong previous approval',{previousUiApprovalSha256:FP},'APPROVAL_SCOPE'],['missing old observation hashes',{previousUiObservationSha256:{}},'APPROVAL_SCOPE'],
 ['arbitrary valid origin',{originalApprovalSha256:FP},'HUMAN_APPROVAL_SCOPE'],
])test(`UI9 rejects rebound approval ${name}`,()=>{const f=nineRoundFixture(),a=JSON.parse(f.context.ui9ApprovalBytes);Object.assign(a,change);f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_'+code));});
for(const at of ['2026-10-08T07:30:59Z','2026-10-08T07:40:01Z'])test(`UI9 exact approval precedes planning and follows historical hashing: ${at}`,()=>{const f=nineRoundFixture();changeUi9ApprovalTime(f,at);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_APPROVAL_TIME'));});
test('UI9 preserves microseconds and only normalizes the UTC suffix',()=>{const f=nineRoundFixture();changeUi9ApprovalTime(f,'2026-10-08T07:35:00.123456+00:00');assert.equal(run(f).ok,true,JSON.stringify(run(f).errors));f.doc.editor.additionalIterationApprovals[4].approvedAt='2026-10-08T07:35:00.123457Z';refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_EDITOR_APPROVAL'));});
test('UI9 fields do not widen the approved UI8 path',()=>{const f=eightRoundFixture(),n=nineRoundFixture().context.grant;Object.assign(f.context.grant,{ui9ApprovalFile:n.ui9ApprovalFile,ui9ApprovalSha256:n.ui9ApprovalSha256,historicalUi8:n.historicalUi8});assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);});
for(const value of [null,{},[],{id:1,sha256:FP,extra:true}])test(`UI9 typed UI8 role rejects ${JSON.stringify(value)}`,()=>{const f=nineRoundFixture();f.context.grant.historicalUi8.resultAsset=value;assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);});
test('UI9 draft preserves the prior immutable UI8 approval bytes',()=>{assert.equal(digest(readFileSync(new URL('../docs/design/2026-10-15-spiritgate-ui8/approval.json',import.meta.url))),'ff44dc33d1e6fcf23494b76722ea82cb79e91051cbc1b7699e110ccd2714ed10');});
test('UI9 may keep the same product SHA as blocked UI8 while binding a separate manual QA configuration',()=>{const f=nineRoundFixture(),source=f.context.grant.historicalUi8.sourceSha;for(const o of [f.context.grant,f.context,f.doc.editor,f.doc.editor.e2e,f.doc.android,f.doc.ios,f.context.providerProof,f.doc.editor.iterations[8]])o.sourceSha=source;const a=JSON.parse(f.context.ui9ApprovalBytes),human=JSON.parse(f.context.ui9HumanApprovalBytes);a.sourceSha=source;a.operatorHandoff.sourceSha=source;human.operatorHandoff=a.operatorHandoff;f.context.ui9HumanApprovalBytes=jsonBytes(human);a.humanApprovalSha256=digest(f.context.ui9HumanApprovalBytes);f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);refreshSeven(f);assert.notEqual(f.context.configurationFingerprint,f.context.grant.historicalUi8.configurationFingerprint);assert.equal(run(f).ok,true,JSON.stringify(run(f).errors));});
function changeUi9ApprovalTime(f,at){const a=JSON.parse(f.context.ui9ApprovalBytes),h=JSON.parse(f.context.ui9HumanApprovalBytes);a.approvalRecordedAt=at;h.approvedAt=at.replace(/\+00:00$/u,'Z');f.context.ui9HumanApprovalBytes=jsonBytes(h);a.humanApprovalSha256=digest(f.context.ui9HumanApprovalBytes);f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);f.doc.editor.additionalIterationApprovals[4].approvedAt=h.approvedAt;return refreshSeven(f);}
function alterUi9Handoff(f,change){const a=JSON.parse(f.context.ui9ApprovalBytes),h=JSON.parse(f.context.ui9HumanApprovalBytes);change(a.operatorHandoff);h.operatorHandoff=a.operatorHandoff;f.context.ui9HumanApprovalBytes=jsonBytes(h);a.humanApprovalSha256=digest(f.context.ui9HumanApprovalBytes);f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);return refreshSeven(f);}
for(const [name,change]of [
 ['different round',h=>{h.sameRound=10;}],['agent-only past input',h=>{h.inputBefore='agent';}],['human-only after takeover',h=>{h.inputAfter='human';}],
 ['missing takeover origin',h=>{delete h.originalDirectiveSha256;}],['first directive reused as takeover',h=>{h.originalDirectiveSha256='e'.repeat(64);}],
 ['different source',h=>{h.sourceSha=SHA;}],['different configuration',h=>{h.configurationFingerprint=FP;}],
 ['clock reset',h=>{h.clockReset=true;}],['helpers altered',h=>{h.frozenHelpersModified=true;}],['new run',h=>{h.newRun=true;}],
 ['author input counted as independent',h=>{h.authorInputCountsAsIndependentReview=true;}],
])test(`UI9 handoff rejects fully rebound ${name}`,()=>{const f=nineRoundFixture();alterUi9Handoff(f,change);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HANDOFF_SCOPE'));});
for(const [name,change]of [
 ['before original start',h=>{h.directedAt='2026-10-08T07:40:59Z';}],['after final completion',h=>{h.directedAt='2026-10-08T08:00:00.001Z';}],
 ['invalid directive time',h=>{h.directedAt='unknown';}],['new start',h=>{h.sameStartedAt='2026-10-08T07:41:00.000001Z';}],
 ['extended main',h=>{h.mainDeadlineAt='2026-10-08T10:42:00Z';}],['extended outer',h=>{h.absoluteMaximumAt='2026-10-08T11:12:00Z';}],
 ['microsecond main extension',h=>{h.mainDeadlineAt='2026-10-08T10:41:00.000001Z';}],['microsecond outer extension',h=>{h.absoluteMaximumAt='2026-10-08T11:11:00.000001Z';}],
])test(`UI9 handoff preserves the exact existing clock: ${name}`,()=>{const f=nineRoundFixture();alterUi9Handoff(f,change);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HANDOFF_TIME'));});
test('UI9 handoff cannot replace the initial pre-planning approval with the later directive time',()=>{const f=nineRoundFixture();changeUi9ApprovalTime(f,'2026-10-08T07:45:00.123456Z');assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_APPROVAL_TIME'));});
for(const value of [undefined,null,[],{}])test(`UI9 rejects missing or malformed separate handoff ${JSON.stringify(value)}`,()=>{const f=nineRoundFixture(),a=JSON.parse(f.context.ui9ApprovalBytes),h=JSON.parse(f.context.ui9HumanApprovalBytes);a.operatorHandoff=value;h.operatorHandoff=value;f.context.ui9HumanApprovalBytes=jsonBytes(h);a.humanApprovalSha256=digest(f.context.ui9HumanApprovalBytes);f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HANDOFF_SCOPE'));});
test('UI9 requires the separate handoff receipt to match the canonical scope exactly',()=>{const f=nineRoundFixture(),a=JSON.parse(f.context.ui9ApprovalBytes);a.operatorHandoff.originalDirectiveSha256=FP;f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HUMAN_APPROVAL_SCOPE'));});
test('UI9 requires the initial receipt timestamp without losing microseconds',()=>{const f=nineRoundFixture(),h=JSON.parse(f.context.ui9HumanApprovalBytes),a=JSON.parse(f.context.ui9ApprovalBytes);h.approvedAt='2026-10-08T07:35:00.000001Z';f.context.ui9HumanApprovalBytes=jsonBytes(h);a.humanApprovalSha256=digest(f.context.ui9HumanApprovalBytes);f.context.ui9ApprovalBytes=jsonBytes(a);f.context.grant.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HUMAN_APPROVAL_SCOPE'));});
for(const digits of ['000001','000999','000000001'])test(`UI9 rejects approval past planning by fractional second ${digits}`,()=>{const f=nineRoundFixture();changeUi9ApprovalTime(f,'2026-10-08T07:40:00.'+digits+'Z');assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_APPROVAL_TIME'));});
test('UI9 rejects handoff one microsecond after completion',()=>{const f=nineRoundFixture();alterUi9Handoff(f,h=>{h.directedAt='2026-10-08T08:00:00.000001Z';});assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HANDOFF_TIME'));});
test('UI9 rejects handoff before its start within the same millisecond',()=>{const f=nineRoundFixture();f.doc.editor.iterations[8].startedAt='2026-10-08T07:41:00.000900Z';alterUi9Handoff(f,h=>{h.sameStartedAt='2026-10-08T07:41:00.000900Z';h.mainDeadlineAt='2026-10-08T10:41:00.000900Z';h.absoluteMaximumAt='2026-10-08T11:11:00.000900Z';h.directedAt='2026-10-08T07:41:00.000100Z';});assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HANDOFF_TIME'));});
test('UI9 rejects UI8 manifest hashing one microsecond past the original cap',()=>{const f=nineRoundFixture(),m=JSON.parse(f.context.ui8ManifestBytes);m.at='2026-10-08T07:36:00.000001Z';f.context.ui8ManifestBytes=jsonBytes(m);rebindUi8AssetOnly(f,'manifestAsset','ui8ManifestBytes');changeUi9ApprovalTime(f,'2026-10-08T07:36:01Z');assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_ORIGINAL_TIME'));});
for(const [name,select]of [['original proposal',a=>a.originalProposalSha256],['approved proposal',a=>a.proposalSha256],['preceding UI8 approval',(_a,f)=>f.context.grant.ui8ApprovalSha256]])test(`UI9 handoff cannot relabel known ${name} bytes as a distinct user directive`,()=>{const f=nineRoundFixture(),a=JSON.parse(f.context.ui9ApprovalBytes);alterUi9Handoff(f,h=>{h.originalDirectiveSha256=select(a,f);});assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HANDOFF_SCOPE'));});
for(const key of ['ui9ApprovalBytes','ui9HumanApprovalBytes'])test(`UI9 post-compiled receipt cannot mutate trusted ${key} without changing its reviewed digest`,()=>{const f=nineRoundFixture(),v=JSON.parse(f.context[key]);if(key==='ui9ApprovalBytes')v.userApprovalVerbatim='retroactive replacement';else v.originalApprovalSha256=FP;f.context[key]=jsonBytes(v);assert.ok(run(f).errors.includes(key==='ui9ApprovalBytes'?'TESTFLIGHT_UI9_APPROVAL_CHANGED':'TESTFLIGHT_UI9_HUMAN_APPROVAL_CHANGED'));});
test('typed UI8 rejects a signal timestamp one microsecond after its cleanup receipt',()=>{const f=nineRoundFixture(),c=JSON.parse(f.context.ui8CleanupBytes),r=JSON.parse(f.context.ui8ResultBytes);c.events[0].at='2026-10-08T07:25:00.000001Z';r.processCleanup=c;f.context.ui8CleanupBytes=jsonBytes(c);f.context.ui8ResultBytes=jsonBytes(r);rebindUi8History(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI8_FAILURE_HISTORY'));});
test('UI9 ordering preserves arbitrary supported fractional precision and equivalent UTC offset',()=>{const f=nineRoundFixture();changeUi9ApprovalTime(f,'2026-10-08T07:35:00.123456789Z');alterUi9Handoff(f,h=>{h.directedAt='2026-10-08T08:45:00.123456789+01:00';});assert.equal(run(f).ok,true,JSON.stringify(run(f).errors));});
test('UI9 final observation cannot exceed its unchanged total cap by one microsecond',()=>{const f=nineRoundFixture();f.doc.editor.iterations[8].completedAt='2026-10-08T11:11:00.000001Z';Object.assign(f.doc.editor.e2e,{plannedAt:'2026-10-08T11:12:00Z',startedAt:'2026-10-08T11:13:00Z',completedAt:'2026-10-08T11:20:00Z'});refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_HANDOFF_TIME'));});

// UI10 아래 자료는 실패 이력 검증용 합성 입력이며 실제 제품 관찰·통과 증거가 아니다.
const ui9Assets=[
 ['sourceSnapshotAsset','ui9SourceSnapshotBytes','preparation/source-before.json'],['configurationAsset','ui9ConfigurationBytes','configuration.json'],
 ['frozenManifestAsset','ui9FrozenManifestBytes','preparation/frozen-manifest.json'],['planAsset','ui9PlanBytes','plan.json'],
 ['executionStartAsset','ui9ExecutionStartBytes','execution-start.json'],['handoffDirectiveAsset','ui9HandoffDirectiveBytes','inspection/agent-takeover-user-directive.json'],
 ['operatorTransitionAsset','ui9OperatorTransitionBytes','inspection/operator-handoff/agent-transition.json'],['projectNormalizationAsset','ui9ProjectNormalizationBytes','inspection/editor-project-normalization.json'],
 ['sourceIntegrityAsset','ui9SourceIntegrityBytes','final/source-integrity.json'],['resultAsset','ui9ResultBytes','final/result.json'],
 ['cleanupAsset','ui9CleanupBytes','process-cleanup-receipt.json'],['originalManifestAsset','ui9OriginalManifestBytes','final/original-manifest.json'],
 ['deliverableManifestAsset','ui9DeliverableManifestBytes','final/deliverable-manifest.json'],
];
function tenRoundFixture(){
 const f=nineRoundFixture(),g=f.context.grant,a9=JSON.parse(f.context.ui9ApprovalBytes),h=a9.operatorHandoff,source=g.sourceSha,fp=g.configurationFingerprint;
 const helper='1'.repeat(64),project='2'.repeat(64),qa='3'.repeat(64),normalized='4'.repeat(64);
 const values={
  ui9SourceSnapshotBytes:{sourceSha:source,trackedCount:2,mismatchesExceptDeclaredProject:[],files:{'project.godot':{sha256:qa},'src/sample.gd':{sha256:'5'.repeat(64)}}},
  ui9ConfigurationBytes:{sourceSha:source,fingerprint:fp,preparationFrozenAt:'2026-10-08T07:39:00Z',trackedSourceCount:2,sourceProjectSha256:project,actualProjectSha256:qa,helperHashes:{'probe.gd':helper},configs:[{path:'/owned/configs/project.godot',sha256:qa}],mainMinutes:180,singleProblemRecheckMinutes:30,maximumMinutes:210,editorLaunched:false,runStarted:false},
  ui9PlanBytes:{round:9,sourceSha:source,configurationFingerprint:fp,plannedAt:'2026-10-08T07:40:00Z',mainMinutes:180,singleProblemRecheckMinutes:30,maximumMinutes:210,automaticInputDiagnostics:0,priorUi8FailurePreserved:true,features:ids.map(id=>({id})),matrix:{locales:['ko','en','ja','de','fr','es','pt-BR'],developmentDisplaySizes:[{width:1,height:2},{width:2,height:3},{width:3,height:4}],requiredPanels:['a','b','c','d','e','f','g','h']}},
  ui9ExecutionStartBytes:{round:9,sourceSha:source,configurationFingerprint:fp,operator:'human',reviewer:'independent-observer',startedAt:h.sameStartedAt,mainDeadlineAt:h.mainDeadlineAt,absoluteMaximumAt:h.absoluteMaximumAt,singleRecheckMinutes:30,newAutomatedInputDiagnostics:0},
  ui9HandoffDirectiveBytes:{directedAt:h.directedAt,sourceSha:source,configurationFingerprint:fp,sameRound:9,clockReset:false,sameStartedAt:h.sameStartedAt,mainDeadlineAt:h.mainDeadlineAt,absoluteMaximumAt:h.absoluteMaximumAt,previousHumanInputEndsAtEvent:442,firstVerifiedRootKeyboardEvents:[443,444],rootControlCountsAsIndependentReview:false,frozenHelpersModified:false,newRun:false},
  ui9OperatorTransitionBytes:{recordedAt:'2026-10-08T07:46:00Z',humanLastConfirmedEvent:442,rootFirstAgentEvent:443,sameRuntimePid:123,sameEditorPid:321,newRunOrClockReset:false,frozenRawKindHumanPrefixDoesNotDetermineOperator:true},
  ui9ProjectNormalizationBytes:{observedAt:'2026-10-08T07:42:00Z',declaredConfigurationFingerprint:fp,declaredProjectSha256:qa,actualProjectSha256:normalized,allDeclaredSettingValuesEqual:true,autoloadOrderEqual:true,sourceOrHelpersModifiedByReviewer:false,frozenConfigurationAndManifestPreserved:true},
  ui9SourceIntegrityBytes:{auditedAt:'2026-10-08T11:15:30Z',sourceSha:source,configurationFingerprint:fp,frozenManifestSha256:null,frozenManifestMismatch:[],productTrackedCheckedExceptDeclaredProject:1,productTrackedMismatchExceptDeclaredProject:[],sourceBeforeManifestSha256:null,qaProjectGodotAfterEditorSha256:normalized,newRunInputOrProcessDiagnosis:false},
  ui9CleanupBytes:{startedAt:'2026-10-08T11:15:00Z',finishedAt:'2026-10-08T11:15:02Z',sourceSha:source,actions:[{pid:123,signal:'SIGTERM',sentAt:'2026-10-08T11:15:00.1Z',signalSent:true,absentAfter:true,checkedAt:'2026-10-08T11:15:00.2Z'},{pid:321,signal:'SIGTERM',sentAt:'2026-10-08T11:15:00.3Z',signalSent:true,absentAfter:true,checkedAt:'2026-10-08T11:15:00.4Z'}],inputPosted:0,newRuns:0,forceKill:false,otherAppsTouched:false,processes:{123:{observedIdentity:'owned game command',expectedCommand:'game command'},321:{observedIdentity:'owned editor command',expectedCommand:'editor command'}}},
  ui9ResultBytes:{schemaVersion:1,round:9,candidateSourceSha:source,configurationFingerprint:fp,independentReviewer:'independent-observer',implementer:'author',result:'incomplete',overallPassed:false,reusablePassingEvidenceForBuildOrRelease:false,finalizedAt:'2026-10-08T11:20:00Z',finalizationIsNewExecution:false,featureCoverage:{total:28,passed:0,partial:16,notRun:12},matrixCoverage:{total:168,passed:0,partial:18,notRun:150},clock:{plannedAt:'2026-10-08T07:40:00Z',startedAt:h.sameStartedAt,mainDeadlineAt:h.mainDeadlineAt,absoluteMaximumAt:h.absoluteMaximumAt,mainMinutes:180,singleProblemRecheckMinutes:30,maximumMinutes:210,timeExtensionApproved:false,lastProductKeyAt:'2026-10-08T08:00:00.123456Z',lastInputResultAt:'2026-10-08T08:00:00.123457Z',lastActualCaptureAt:'2026-10-08T08:00:00Z',lastReadOnlyProgressAt:'2026-10-08T08:10:00Z',lateInputMethodAndCentralCorrectionApprovalAt:'2026-10-08T11:14:00.123456Z',lateApprovalDoesNotExtendRound:true,passivePostDeadlineObserverDataCountsAsExecution:false},execution:{editorPid:321,runtimePid:123,runtimeRunCount:1,additionalCuAOrAxCgInputAfterDeadline:0,newRunOrRoundOrFinalE2eAfterDeadline:0,terminationReceiptSha256:null,runtimeSigtermAt:'2026-10-08T11:15:00.1Z',editorSigtermAt:'2026-10-08T11:15:00.3Z',sigkillOrOtherAppInterference:false},operators:{humanThroughEvent:442,rootFirstAgentEvents:[443,444],independentAgentFromEvent:445},originals:{manifestSha256:null,originalFileCount:0,allStableDuringHash:true},sourceAndHelpers:{productTrackedCheckedExceptDeclaredProject:1,productMismatchCount:0,frozenManifestMismatchCount:0,sdkGameRulesAndHelpersChanged:false},priorUi8AndEarlierE2eFailuresUnchanged:true,progressAndOriginalsOverwritten:false},
 };
 for(const [key,value]of Object.entries(values))f.context[key]=jsonBytes(value);
 f.context.ui9ImplementationApprovalBytes=jsonBytes({approvedAt:'2026-10-08T11:14:00.123456Z',approvedAnswer:'two bounded scopes approved'});
 g.historicalUi9={sourceSha:source,configurationFingerprint:fp,capExpired:true,budgetExceeded:true,incomplete:true,passingFeatures:0};
 for(const [i,[asset]]of ui9Assets.entries())g.historicalUi9[asset]={id:200+i,sha256:'0'.repeat(64)};
 g.approvedUiRounds=10;g.ui10ApprovalFile='docs/design/2026-10-16-spiritgate-ui10/approval.json';
 f.context.ui10ProposalBytes=Buffer.from('one UI10 180+30 min; preserve failed expired UI9 late report; no signing or device waiver');
 f.context.ui10HumanApprovalBytes=jsonBytes({approvedAt:'2026-10-08T11:25:00.123456Z',originalUserRecordSha256:'6'.repeat(64),originalProposalSha256:'7'.repeat(64)});
 f.context.ui10ApprovalBytes=jsonBytes({...a9,designId:'SGD-UI10-TF-110-v1',approvedUiRounds:10,sourceSha:'a'.repeat(40),configurationFingerprint:'c'.repeat(64),approvalRecordedAt:'2026-10-08T11:25:00.123456+00:00',humanApprovalSha256:digest(f.context.ui10HumanApprovalBytes),originalApprovalSha256:'6'.repeat(64),originalProposalSha256:'7'.repeat(64),proposalSha256:digest(f.context.ui10ProposalBytes),previousUiApprovalSha256:null,previousUiObservationSha256:{},inputMode:'independent-agent',operatorHandoff:undefined});
 for(const aspect of ['functional','ux'])Object.assign(f.doc.editor.iterations[8][aspect],{status:'blocked',resolutionEvidence:'https://example.com/new-independent-ui10-not-a-retroactive-ui9-pass'});
 f.doc.editor.iterations[8].completedAt='2026-10-08T11:20:00Z';
 const tenth=structuredClone(f.doc.editor.iterations[3]);Object.assign(tenth,{number:10,sourceSha:'a'.repeat(40),plannedAt:'2026-10-08T11:30:00Z',startedAt:'2026-10-08T11:31:00Z',completedAt:'2026-10-08T11:50:00Z'});f.doc.editor.iterations.push(tenth);
 f.doc.editor.additionalIterationApprovals.push({approverKind:'human',approver:'owner',approvedAt:'2026-10-08T11:25:00.123456Z',maxRound:10,evidence:g.ui10ApprovalFile});
 for(const o of [g,f.context,f.doc.editor,f.doc.editor.e2e,f.doc.android,f.doc.ios,f.context.providerProof])o.sourceSha='a'.repeat(40);
 for(const o of [g,f.context,f.doc.editor.e2e.environment])o.configurationFingerprint='c'.repeat(64);
 Object.assign(f.doc.editor.e2e,{plannedAt:'2026-10-08T11:55:00Z',startedAt:'2026-10-08T11:56:00Z',completedAt:'2026-10-08T12:10:00Z'});
 return rebindUi9History(f);
}
function rebindUi9History(f){
 const g=f.context.grant,h=g.historicalUi9;
 for(const [asset]of ui9Assets){const old=h[asset].sha256;g.originalObservationAssets=g.originalObservationAssets.filter(x=>x.id!==h[asset].id);f.doc.originalObservations=f.doc.originalObservations.filter(x=>x.sha256!==old);}
 const cfg=JSON.parse(f.context.ui9ConfigurationBytes),frozen={'configuration.json':digest(f.context.ui9ConfigurationBytes),'plan.json':digest(f.context.ui9PlanBytes),...Object.fromEntries(Object.entries(cfg.helperHashes).map(([p,v])=>['qa-project/'+p,v]))};
 f.context.ui9FrozenManifestBytes=jsonBytes(frozen);
 const integrity=JSON.parse(f.context.ui9SourceIntegrityBytes);integrity.frozenManifestSha256=digest(f.context.ui9FrozenManifestBytes);integrity.sourceBeforeManifestSha256=digest(f.context.ui9SourceSnapshotBytes);f.context.ui9SourceIntegrityBytes=jsonBytes(integrity);
 const originalRoles=ui9Assets.filter(([, ,p])=>!p.startsWith('final/'));
 const originalFiles=originalRoles.map(([,key,path])=>({path,bytes:f.context[key].length,sha256:digest(f.context[key]),stableDuringHash:true}));originalFiles.push({path:'preparation/source-project.godot',bytes:10,sha256:cfg.sourceProjectSha256,stableDuringHash:true});
 f.context.ui9OriginalManifestBytes=jsonBytes({createdAt:'2026-10-08T11:17:00Z',sourceSha:h.sourceSha,configurationFingerprint:h.configurationFingerprint,files:originalFiles,allStableDuringHash:true});
 const result=JSON.parse(f.context.ui9ResultBytes);result.originals.manifestSha256=digest(f.context.ui9OriginalManifestBytes);result.originals.originalFileCount=originalFiles.length;result.execution.terminationReceiptSha256=digest(f.context.ui9CleanupBytes);f.context.ui9ResultBytes=jsonBytes(result);
 const deliverFiles=ui9Assets.filter(([asset,,path])=>path.startsWith('final/') && asset!=='deliverableManifestAsset').map(([,key,path])=>({path:path.slice(6),bytes:f.context[key].length,sha256:digest(f.context[key])}));
 f.context.ui9DeliverableManifestBytes=jsonBytes({createdAt:'2026-10-08T11:21:00Z',files:deliverFiles});
 const a9=JSON.parse(f.context.ui9ApprovalBytes),human9=JSON.parse(f.context.ui9HumanApprovalBytes);
 a9.operatorHandoff.originalDirectiveSha256=digest(f.context.ui9HandoffDirectiveBytes);human9.operatorHandoff=a9.operatorHandoff;f.context.ui9HumanApprovalBytes=jsonBytes(human9);a9.humanApprovalSha256=digest(f.context.ui9HumanApprovalBytes);a9.implementationApprovalSha256=digest(f.context.ui9ImplementationApprovalBytes);f.context.ui9ApprovalBytes=jsonBytes(a9);g.ui9ApprovalSha256=digest(f.context.ui9ApprovalBytes);
 const a10=JSON.parse(f.context.ui10ApprovalBytes);a10.previousUiApprovalSha256=g.ui9ApprovalSha256;
 for(const [asset,key]of ui9Assets){h[asset].sha256=digest(f.context[key]);g.originalObservationAssets.push(h[asset]);f.doc.originalObservations.push({name:key+'.json',sha256:h[asset].sha256});a10.previousUiObservationSha256[asset]=h[asset].sha256;}
 f.context.ui10ApprovalBytes=jsonBytes(a10);g.ui10ApprovalSha256=digest(f.context.ui10ApprovalBytes);return refreshSeven(f);
}
function alterUi9History(f,key,change){const v=JSON.parse(f.context[key]);change(v);f.context[key]=jsonBytes(v);return rebindUi9History(f);}
test('UI10 accepts only typed expired incomplete UI9 with original over-budget finalization and separate later passing round',()=>{const f=tenRoundFixture(),r=run(f);assert.equal(r.ok,true,JSON.stringify(r.errors));assert.equal(r.approvedUiRounds,10);assert.equal(r.ui10ApprovalSha256,f.context.grant.ui10ApprovalSha256);assert.equal(r.nativeQaWaived,false);const old=JSON.parse(f.context.ui9ResultBytes);assert.equal(old.overallPassed,false);assert.ok(Date.parse(old.finalizedAt)-Date.parse(old.clock.startedAt)>210*60000);assert.equal(old.featureCoverage.passed,0);});
function rebindUi9AssetOnly(f,asset,key){const h=f.context.grant.historicalUi9,old=h[asset].sha256;h[asset].sha256=digest(f.context[key]);f.context.grant.originalObservationAssets=f.context.grant.originalObservationAssets.filter(x=>x.id!==h[asset].id);f.context.grant.originalObservationAssets.push(h[asset]);f.doc.originalObservations=f.doc.originalObservations.filter(x=>x.sha256!==old);f.doc.originalObservations.push({name:key+'.json',sha256:h[asset].sha256});const a=JSON.parse(f.context.ui10ApprovalBytes);a.previousUiObservationSha256[asset]=h[asset].sha256;f.context.ui10ApprovalBytes=jsonBytes(a);f.context.grant.ui10ApprovalSha256=digest(f.context.ui10ApprovalBytes);return refreshSeven(f);}
for(const [asset,key]of ui9Assets){
 test(`UI10 requires original ${asset}`,()=>{const f=tenRoundFixture();delete f.context[key];assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_SNAPSHOT_CHANGED'));});
 test(`UI10 rejects changed ${asset} bytes`,()=>{const f=tenRoundFixture();f.context[key]=Buffer.from('{}');assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_SNAPSHOT_CHANGED'));});
 for(const invalid of ['null','[]','{'])test(`UI10 fails closed for fully rebound malformed ${asset} ${invalid}`,()=>{const f=tenRoundFixture();f.context[key]=Buffer.from(invalid);rebindUi9AssetOnly(f,asset,key);let r;assert.doesNotThrow(()=>{r=run(f);});assert.ok(r.errors.includes('TESTFLIGHT_INVALID_UI9_SNAPSHOT'),JSON.stringify(r.errors));});
}
for(const [key,change,code]of [
 ['ui9ConfigurationBytes',v=>{v.sourceSha=SHA;},'SNAPSHOT_SCOPE'],['ui9ConfigurationBytes',v=>{v.fingerprint=FP;},'SNAPSHOT_SCOPE'],
 ['ui9SourceSnapshotBytes',v=>{v.mismatchesExceptDeclaredProject=['src/sample.gd'];},'SOURCE_HISTORY'],['ui9SourceIntegrityBytes',v=>{v.productTrackedMismatchExceptDeclaredProject=['src/sample.gd'];},'SOURCE_HISTORY'],
 ['ui9ProjectNormalizationBytes',v=>{v.allDeclaredSettingValuesEqual=false;},'SOURCE_HISTORY'],['ui9ProjectNormalizationBytes',v=>{v.actualProjectSha256=FP;},'SOURCE_HISTORY'],
 ['ui9ResultBytes',v=>{v.result='passed';v.overallPassed=true;},'INCOMPLETE_HISTORY'],['ui9ResultBytes',v=>{v.featureCoverage.passed=1;v.featureCoverage.partial=15;},'INCOMPLETE_HISTORY'],
 ['ui9ResultBytes',v=>{v.matrixCoverage.passed=1;v.matrixCoverage.partial=17;},'INCOMPLETE_HISTORY'],['ui9ResultBytes',v=>{v.reusablePassingEvidenceForBuildOrRelease=true;},'INCOMPLETE_HISTORY'],
 ['ui9ResultBytes',v=>{v.clock.timeExtensionApproved=true;},'INCOMPLETE_HISTORY'],['ui9ResultBytes',v=>{v.clock.passivePostDeadlineObserverDataCountsAsExecution=true;},'INCOMPLETE_HISTORY'],
 ['ui9ResultBytes',v=>{v.execution.additionalCuAOrAxCgInputAfterDeadline=1;},'INCOMPLETE_HISTORY'],['ui9ResultBytes',v=>{v.execution.newRunOrRoundOrFinalE2eAfterDeadline=1;},'INCOMPLETE_HISTORY'],
 ['ui9ResultBytes',v=>{v.priorUi8AndEarlierE2eFailuresUnchanged=false;},'INCOMPLETE_HISTORY'],
 ['ui9HandoffDirectiveBytes',v=>{v.rootControlCountsAsIndependentReview=true;},'OPERATOR_HISTORY'],['ui9HandoffDirectiveBytes',v=>{v.clockReset=true;},'OPERATOR_HISTORY'],
 ['ui9OperatorTransitionBytes',v=>{v.sameRuntimePid=999;},'OPERATOR_HISTORY'],['ui9OperatorTransitionBytes',v=>{v.humanLastConfirmedEvent=441;},'OPERATOR_HISTORY'],
 ['ui9CleanupBytes',v=>{v.actions[0].pid=999;},'CLEANUP_HISTORY'],['ui9CleanupBytes',v=>{v.actions[0].signal='SIGKILL';},'CLEANUP_HISTORY'],
 ['ui9CleanupBytes',v=>{v.actions[0].absentAfter=false;},'CLEANUP_HISTORY'],['ui9CleanupBytes',v=>{v.actions[0].sentAt='2026-10-08T11:15:02.000001Z';},'CLEANUP_HISTORY'],
 ['ui9ResultBytes',v=>{v.finalizedAt='2026-10-08T10:00:00Z';},'EXPIRED_TIME'],
 ['ui9ResultBytes',v=>{v.clock.lastProductKeyAt='2026-10-08T11:11:00.000001Z';},'EXPIRED_TIME'],
 ['ui9ResultBytes',v=>{v.clock.lastInputResultAt='2026-10-08T11:11:00.000001Z';},'EXPIRED_TIME'],
 ['ui9ResultBytes',v=>{v.clock.lastReadOnlyProgressAt='2026-10-08T11:11:00.000001Z';},'EXPIRED_TIME'],
 ['ui9ResultBytes',v=>{v.clock.lateInputMethodAndCentralCorrectionApprovalAt='2026-10-08T11:10:00Z';},'EXPIRED_TIME'],
 ['ui9ExecutionStartBytes',v=>{v.absoluteMaximumAt='2026-10-08T11:12:00Z';},'EXPIRED_TIME'],['ui9PlanBytes',v=>{v.features.pop();},'EXPIRED_TIME'],
])test(`UI10 preserves expired UI9 semantics ${key}: ${change}`,()=>{const f=tenRoundFixture();alterUi9History(f,key,change);const r=run(f);assert.ok(r.errors.includes('TESTFLIGHT_UI9_'+code),JSON.stringify(r.errors));});
for(const [name,change]of [
 ['duplicate original path',m=>{m.files.push({...m.files[0]});}],['selected original bytes',m=>{m.files[0].bytes++;}],['selected original digest',m=>{m.files[0].sha256=FP;}],
])test(`UI10 rejects hash-rebound historical manifest ${name}`,()=>{const f=tenRoundFixture(),m=JSON.parse(f.context.ui9OriginalManifestBytes);change(m);f.context.ui9OriginalManifestBytes=jsonBytes(m);rebindUi9AssetOnly(f,'originalManifestAsset','ui9OriginalManifestBytes');assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_MANIFEST'));});
for(const [name,change]of [
 ['UI9 falsely marked passed',f=>{f.doc.editor.iterations[8].functional.status='passed';}],
 ['late finalization hidden',f=>{f.doc.editor.iterations[8].completedAt='2026-10-08T08:00:00Z';}],
 ['missing prior resolution',f=>{delete f.doc.editor.iterations[8].ux.resolutionEvidence;}],
 ['UI10 failed',f=>{f.doc.editor.iterations[9].functional.status='failed';}],
 ['UI10 over210minutes',f=>{f.doc.editor.iterations[9].completedAt='2026-10-08T15:01:00.000001Z';}],
 ['missing UI10 approval',f=>{f.doc.editor.additionalIterationApprovals.pop();}],['UI10 current source mismatch',f=>{f.doc.editor.iterations[9].sourceSha='b'.repeat(40);}],
 ['E2E before new review',f=>{f.doc.editor.e2e.plannedAt='2026-10-08T11:20:00Z';}],['missing actual Android',f=>{f.doc.android.features[0].status='blocked';}],
 ['expiry extension',f=>{f.context.grant.expiresAt='2026-10-16T05:00:00Z';}],['UI11 unapproved',f=>{f.context.grant.approvedUiRounds=11;}],
 ['UI9 history asset absent from originals',f=>{const a=f.context.grant.historicalUi9.cleanupAsset;f.context.grant.originalObservationAssets=f.context.grant.originalObservationAssets.filter(x=>x.id!==a.id);f.doc.originalObservations=f.doc.originalObservations.filter(x=>x.sha256!==a.sha256);}],
 ['UI9 late approval missing',f=>{delete f.context.ui9ImplementationApprovalBytes;}],
])test(`UI10 keeps existing final requirements: ${name}`,()=>{const f=tenRoundFixture();change(f);refreshSeven(f);assert.equal(run(f).ok,false,name);});
for(const [name,change]of [
 ['proposal',f=>{f.context.ui10ProposalBytes=Buffer.from('extended');}],['human',f=>{f.context.ui10HumanApprovalBytes=Buffer.from('{}');}],['approval',f=>{f.context.ui10ApprovalBytes=Buffer.from('{}');}],
 ['new configuration',f=>{const a=JSON.parse(f.context.ui10ApprovalBytes);a.configurationFingerprint=FP;f.context.ui10ApprovalBytes=jsonBytes(a);f.context.grant.ui10ApprovalSha256=digest(f.context.ui10ApprovalBytes);}],
 ['new helper scope',f=>{const a=JSON.parse(f.context.ui10ApprovalBytes);a.inputMode='human-manual';f.context.ui10ApprovalBytes=jsonBytes(a);f.context.grant.ui10ApprovalSha256=digest(f.context.ui10ApprovalBytes);}],
 ['pre-planning microsecond',f=>{const a=JSON.parse(f.context.ui10ApprovalBytes),h=JSON.parse(f.context.ui10HumanApprovalBytes);a.approvalRecordedAt='2026-10-08T11:30:00.000001Z';h.approvedAt=a.approvalRecordedAt;f.context.ui10HumanApprovalBytes=jsonBytes(h);a.humanApprovalSha256=digest(f.context.ui10HumanApprovalBytes);f.context.ui10ApprovalBytes=jsonBytes(a);f.context.grant.ui10ApprovalSha256=digest(f.context.ui10ApprovalBytes);f.doc.editor.additionalIterationApprovals[5].approvedAt=h.approvedAt;}],
])test(`UI10 rejects changed or late ${name}`,()=>{const f=tenRoundFixture();change(f);refreshSeven(f);assert.equal(run(f).ok,false);});
for(const key of ['capExpired','budgetExceeded','incomplete','passingFeatures','sourceSha','configurationFingerprint','resultAsset'])test(`UI10 requires typed history ${key}`,()=>{const f=tenRoundFixture();delete f.context.grant.historicalUi9[key];assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);});
test('UI10-specific fields cannot be introduced under an earlier9-round grant',()=>{const f=tenRoundFixture();f.context.grant.approvedUiRounds=9;f.doc.editor.iterations.pop();refreshSeven(f);assert.deepEqual(run(f).errors,['TESTFLIGHT_BOOTSTRAP_REQUIRED']);});
test('UI10 rejects missing previous observation digest even when both sides are rebound undefined',()=>{const f=tenRoundFixture(),a=JSON.parse(f.context.ui10ApprovalBytes);delete a.previousUiObservationSha256.resultAsset;f.context.ui10ApprovalBytes=jsonBytes(a);f.context.grant.ui10ApprovalSha256=digest(f.context.ui10ApprovalBytes);assert.ok(run(f).errors.includes('TESTFLIGHT_UI10_APPROVAL_SCOPE'));});
test('UI10 support leaves immutable UI9 approval and implementation authorization unchanged',()=>{for(const [name,hash]of [['approval.json','e374935819967ceaca95405874588ad3d2cf5438c5156352f5659b695470b999'],['implementation-approval.json','5fc8a719018d90ec8a446ee50fdb999023cac43cf54bd563699e8b30195fe2d8']])assert.equal(digest(readFileSync(new URL('../docs/design/2026-10-16-spiritgate-ui9/'+name,import.meta.url))),hash);});
function tenDeploymentFixture(){const f=tenRoundFixture(),p=f.context.providerProof;f.context.phase='before-deploy';f.context.grantSha256='d'.repeat(64);f.context.artifactProof={verified:true,sourceSha:f.context.sourceSha,buildId:p.buildId,buildNumber:p.buildNumber,bundleId:f.context.grant.packageName,version:'1.1.0',sha256:'e'.repeat(64)};f.context.beforeBuildReceipt={...run({...f,context:{...f.context,phase:'before-build'}}),phase:'before-build'};return f;}
test('UI10 before-deploy still requires the same verified signed artifact and before-build receipt',()=>{const f=tenDeploymentFixture();assert.equal(run(f).ok,true,JSON.stringify(run(f).errors));for(const change of [x=>{delete x.context.artifactProof;},x=>{x.context.artifactProof.buildId='second-build';},x=>{x.context.beforeBuildReceipt.grantSha256=FP;},x=>{x.context.providerProof.matchingBuildCount=2;}]){const negative=tenDeploymentFixture();change(negative);assert.equal(run(negative).ok,false);}});
test('UI10 may reuse an unchanged product source while binding a separately approved QA configuration',()=>{const f=tenRoundFixture(),source=f.context.grant.historicalUi9.sourceSha;for(const o of [f.context.grant,f.context,f.doc.editor,f.doc.editor.e2e,f.doc.android,f.doc.ios,f.context.providerProof,f.doc.editor.iterations[9]])o.sourceSha=source;const a=JSON.parse(f.context.ui10ApprovalBytes);a.sourceSha=source;f.context.ui10ApprovalBytes=jsonBytes(a);f.context.grant.ui10ApprovalSha256=digest(f.context.ui10ApprovalBytes);refreshSeven(f);assert.notEqual(f.context.configurationFingerprint,f.context.grant.historicalUi9.configurationFingerprint);assert.equal(run(f).ok,true,JSON.stringify(run(f).errors));});
test('UI10 historical snapshot binds the initially declared QA project and its separately preserved product original',()=>{const f=tenRoundFixture(),s=JSON.parse(f.context.ui9SourceSnapshotBytes),c=JSON.parse(f.context.ui9ConfigurationBytes);assert.notEqual(c.sourceProjectSha256,c.actualProjectSha256);assert.equal(s.files['project.godot'].sha256,c.actualProjectSha256);assert.equal(run(f).ok,true,JSON.stringify(run(f).errors));alterUi9History(f,'ui9SourceSnapshotBytes',v=>{v.files['project.godot'].sha256=c.sourceProjectSha256;});assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_SOURCE_HISTORY'));});
test('UI10 requires the separately preserved original project record even after rebinding both manifests and result',()=>{
 const f=tenRoundFixture(),m=JSON.parse(f.context.ui9OriginalManifestBytes);m.files.find(x=>x.path==='preparation/source-project.godot').sha256=FP;f.context.ui9OriginalManifestBytes=jsonBytes(m);rebindUi9AssetOnly(f,'originalManifestAsset','ui9OriginalManifestBytes');
 const result=JSON.parse(f.context.ui9ResultBytes);result.originals.manifestSha256=digest(f.context.ui9OriginalManifestBytes);f.context.ui9ResultBytes=jsonBytes(result);rebindUi9AssetOnly(f,'resultAsset','ui9ResultBytes');
 const deliver=JSON.parse(f.context.ui9DeliverableManifestBytes);for(const [key,path]of [['ui9OriginalManifestBytes','original-manifest.json'],['ui9ResultBytes','result.json']]){const entry=deliver.files.find(x=>x.path===path);entry.sha256=digest(f.context[key]);entry.bytes=f.context[key].length;}f.context.ui9DeliverableManifestBytes=jsonBytes(deliver);rebindUi9AssetOnly(f,'deliverableManifestAsset','ui9DeliverableManifestBytes');assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_MANIFEST'));
});
for(const invalid of [null,[],{}])test(`UI10 rejects malformed hash-rebound late implementation receipt ${JSON.stringify(invalid)}`,()=>{const f=tenRoundFixture();f.context.ui9ImplementationApprovalBytes=jsonBytes(invalid);rebindUi9History(f);let result;assert.doesNotThrow(()=>{result=run(f);});assert.equal(result.ok,false);assert.ok(result.errors.includes(invalid && !Array.isArray(invalid)?'TESTFLIGHT_UI9_EXPIRED_TIME':'TESTFLIGHT_INVALID_UI9_IMPLEMENTATION_APPROVAL'),JSON.stringify(result.errors));});
test('UI10 rejects missing declared project even when all optional initial QA project fields are jointly absent',()=>{const f=tenRoundFixture();alterUi9History(f,'ui9SourceSnapshotBytes',v=>{v.files={'src/other.gd':{sha256:'8'.repeat(64)},'src/sample.gd':{sha256:'5'.repeat(64)}};});alterUi9History(f,'ui9ConfigurationBytes',v=>{delete v.actualProjectSha256;v.configs=[{}];});alterUi9History(f,'ui9ProjectNormalizationBytes',v=>{delete v.declaredProjectSha256;});const r=run(f);assert.ok(r.errors.includes('TESTFLIGHT_UI9_SOURCE_HISTORY'),JSON.stringify(r));});
test('UI10 rejects Claude P3 removal of both declared project and original project hash after full rebinding',()=>{const f=tenRoundFixture();alterUi9History(f,'ui9SourceSnapshotBytes',v=>{v.files={'src/other.gd':{sha256:'8'.repeat(64)},'src/sample.gd':{sha256:'5'.repeat(64)}};});alterUi9History(f,'ui9ConfigurationBytes',v=>{delete v.sourceProjectSha256;});assert.ok(run(f).errors.includes('TESTFLIGHT_UI9_SOURCE_HISTORY'));});

// Mac Editor 생략의 합성 validator 입력. 실제 제품 QA·기기 실행 근거가 아니다.
const macSkipAssets=[['resultAsset','macSkipResultBytes','final/result.json'],['cleanupAsset','macSkipCleanupBytes','process-cleanup-receipt.json'],['sourceIntegrityAsset','macSkipSourceIntegrityBytes','final/source-helper-final-verification.json'],['firstFailureAsset','macSkipFirstFailureBytes','inspection/first-native-observe/execution-receipt.json'],['originalManifestAsset','macSkipOriginalManifestBytes','final/original-artifact-manifest.json'],['deliverableManifestAsset','macSkipDeliverableManifestBytes','final/deliverables-manifest.json']];
function macSkipFixture(){
 const f=tenRoundFixture(),g=f.context.grant,base=JSON.parse(f.context.ui10ApprovalBytes),historySource=base.sourceSha,fp=base.configurationFingerprint;
 const result={round:10,status:'USER_REQUESTED_SKIPPED_INCOMPLETE',passed:false,sourceSha:historySource,configurationFingerprint:fp,plannedAt:'2026-10-08T11:30:00Z',startedAt:'2026-10-08T11:31:00Z',mainDeadlineAt:'2026-10-08T14:31:00Z',absoluteMaximumAt:'2026-10-08T15:01:00Z',clockResetOrExtension:false,endedAt:'2026-10-08T11:40:02Z',finalizedAt:'2026-10-08T11:43:00Z',editorPid:321,gamePid:123,actualRunCount:1,firstBinding:{status:'FAILED',attempts:1,retries:0,exitCode:2,receiptSha256:null},inputCounts:{nativeCgPosts:0,rawRuntimeKeyEvents:2,confirmedProductStartOrButton:0,fixture:0},functionalCoverage:{pass:0,partial:1,notRun:27,fail:0},uxAreaCoverage:{pass:0,partial:1,notRun:167,fail:0},acceptanceConditionsPassCount:0,productSourceUnexpectedMismatch:0,helperMismatch:0,frozenMismatchCount:0,strictWholeExecutionErrorZeroCertified:false,rawTailsModified:false,noAdditionalQaAfterFailure:true,originalProgressFilesUnmodified:true,originalManifestSha256:null};
 const values={macSkipResultBytes:result,macSkipCleanupBytes:{round:10,sourceSha:historySource,configurationFingerprint:fp,startedAt:'2026-10-08T11:40:00Z',finishedAt:'2026-10-08T11:40:02Z',newRuns:0,inputPosted:0,firstFailurePreserved:true,forceKill:false,otherAppsTouched:false,productQaPassed:false,actions:[{role:'game',pid:123,verifiedIdentityRow:'123 owned game',action:'SIGTERM',at:'2026-10-08T11:40:00.1Z',absentAfterWait:true},{role:'editor',pid:321,verifiedIdentityRow:'321 owned editor',action:'SIGTERM',at:'2026-10-08T11:40:00.2Z',absentAfterWait:true}]},macSkipSourceIntegrityBytes:{checkedAt:'2026-10-08T11:43:00Z',sourceSha:historySource,trackedFilesChecked:2,unexpectedProductMismatches:[],projectQaConfigurationSha256:'4'.repeat(64),projectQaConfigurationMatchesFrozen:true,helpers:[{path:'qa-project/probe.gd',sha256:'5'.repeat(64),frozenSha256:'5'.repeat(64),matches:true}],frozenMismatches:[],productCodeSdkRulesBalanceSaveIdentifiersEdited:false,files:[{path:'qa-project/project.godot',bytes:10,sha256:'4'.repeat(64),pristineSha256:'6'.repeat(64),declaredQaProjectConfiguration:true},{path:'qa-project/src/example.gd',bytes:10,sha256:'7'.repeat(64),pristineSha256:'7'.repeat(64),declaredQaProjectConfiguration:false}]},macSkipFirstFailureBytes:{startedAt:'2026-10-08T11:35:00Z',finishedAt:'2026-10-08T11:35:01Z',exitCode:2,observeAttemptNumber:1,productInputPosted:0,retryCount:0,binarySha256:'8'.repeat(64)}};
 for(const[k,v]of Object.entries(values))f.context[k]=jsonBytes(v);
 g.macEditorSkip={approvalFile:'docs/design/2026-10-16-spiritgate-mac-editor-skip/approval.json',approvalSha256:'0'.repeat(64)};for(const[i,[asset]]of macSkipAssets.entries())g.macEditorSkip[asset]={id:300+i,sha256:'0'.repeat(64)};
 f.context.macSkipProposalBytes=Buffer.from('skip only blocked Mac Editor UI and Editor E2E; retain Android4, native L3/E2E and public verification, original deadline and one Cloud build');
 f.context.macSkipHumanApprovalBytes=jsonBytes({schemaVersion:1,kind:'human_mac_editor_skip_public_minimal_receipt',approvedAnswer:'막힌 Mac Editor 검수만 생략',newMacEditorRoundAuthorized:false,previousInputGuardAmendmentProposal:'withdrawn without approval or execution',approvedAt:'2026-10-08T12:00:00.123456Z',sourceRecordSha256:'9'.repeat(64),physicalDeviceQaWaived:false,e2eWaived:false,publicWithoutNativeQaAuthorized:false});
 f.context.macSkipApprovalBytes=jsonBytes({kind:'human_mac_editor_skip_approval',repository:g.repository,version:'1.1.0',objective:'first_internal_testflight_mac_editor_skip_only',approvalRecordedAt:'2026-10-08T12:00:00.123456Z',originalApprovalSha256:'9'.repeat(64),humanApprovalSha256:digest(f.context.macSkipHumanApprovalBytes),proposalSha256:digest(f.context.macSkipProposalBytes),originalTimingApprovalSha256:g.approvalSha256,previousUi10ApprovalSha256:g.ui10ApprovalSha256,sourceSha:'f'.repeat(40),configurationFingerprint:fp,skippedSourceSha:historySource,skippedConfigurationFingerprint:fp,originalExpiresAt:g.expiresAt,editorUiSkipped:true,editorE2eSkipped:true,nativeQaWaived:false,e2eWaived:false,publicReleaseAllowed:false,candidateLimit:1,buildUploadLimit:1,maxAgeHours:168,newEditorRoundAllowed:false,inputGuardCorrectionAllowed:false,originalObservationSha256:{}});
 for(const o of[g,f.context,f.doc.android,f.doc.ios,f.context.providerProof])o.sourceSha='f'.repeat(40);
 Object.assign(f.doc.android,{plannedAt:'2026-10-08T12:10:00Z',startedAt:'2026-10-08T12:11:00Z',completedAt:'2026-10-08T12:35:00Z'});
 f.doc.editor.sourceSha=g.sourceSha;f.doc.editor.status='skipped_incomplete';f.doc.editor.e2e={status:'skipped',environment:{kind:'godot-editor'},reason:'explicit Mac-only skip; native E2E remains required'};f.doc.editor.iterations[9].completedAt=result.finalizedAt;
 for(const aspect of['functional','ux'])f.doc.editor.iterations[9][aspect].status='blocked';
 f.doc.macEditorSkip={status:'skipped_incomplete',editorE2eStatus:'skipped',approvalSha256:'0'.repeat(64),nativeQaWaived:false,publicReleaseAllowed:false};
 return rebindMacSkip(f);
}
function rebindMacSkip(f,rebuildManifests=true){const g=f.context.grant,h=g.macEditorSkip;for(const[asset]of macSkipAssets){const old=h[asset].sha256;g.originalObservationAssets=g.originalObservationAssets.filter(x=>x.id!==h[asset].id);f.doc.originalObservations=f.doc.originalObservations.filter(x=>x.sha256!==old);}
 if(rebuildManifests){const result=JSON.parse(f.context.macSkipResultBytes);result.firstBinding.receiptSha256=digest(f.context.macSkipFirstFailureBytes);
 const originalFiles=macSkipAssets.filter(([, ,p])=>!p.startsWith('final/')).map(([,key,path])=>({path,bytes:f.context[key].length,sha256:digest(f.context[key]),stableDuringHash:true}));f.context.macSkipOriginalManifestBytes=jsonBytes({createdAt:'2026-10-08T11:43:00Z',sourceSha:result.sourceSha,configurationFingerprint:result.configurationFingerprint,files:originalFiles,filesCount:originalFiles.length,unstableDuringHash:[]});result.originalManifestSha256=digest(f.context.macSkipOriginalManifestBytes);f.context.macSkipResultBytes=jsonBytes(result);
 const files=macSkipAssets.filter(([asset,,p])=>p.startsWith('final/')&&asset!=='deliverableManifestAsset').map(([,key,path])=>({path:path.slice(6),bytes:f.context[key].length,sha256:digest(f.context[key])}));f.context.macSkipDeliverableManifestBytes=jsonBytes({createdAt:'2026-10-08T11:44:00Z',files,fileCount:files.length,originalsManifestSha256:digest(f.context.macSkipOriginalManifestBytes),resultSha256:digest(f.context.macSkipResultBytes)});}
 const a=JSON.parse(f.context.macSkipApprovalBytes);for(const[asset,key]of macSkipAssets){h[asset].sha256=digest(f.context[key]);g.originalObservationAssets.push(h[asset]);f.doc.originalObservations.push({name:key+'.json',sha256:h[asset].sha256});a.originalObservationSha256[asset]=h[asset].sha256;}f.context.macSkipApprovalBytes=jsonBytes(a);h.approvalSha256=digest(f.context.macSkipApprovalBytes);f.doc.macEditorSkip.approvalSha256=h.approvalSha256;return refreshSeven(f);}
test('Mac-only skip preserves incomplete Editor originals and uses the actual Android4 completion for first internal bootstrap',()=>{const f=macSkipFixture(),r=run(f);assert.equal(r.ok,true,JSON.stringify(r.errors));assert.equal(r.completedAt,f.doc.android.completedAt);assert.equal(r.editorStatus,'skipped_incomplete');assert.equal(r.editorE2eStatus,'skipped');assert.equal(r.nativeQaWaived,false);assert.equal(r.publicReleaseAllowed,false);assert.equal(r.productE2eStatus,'blocked');assert.equal(f.doc.editor.iterations[9].functional.status,'blocked');assert.equal(JSON.parse(f.context.macSkipResultBytes).passed,false);});
function alterMacSkip(f,key,change,rebuildManifests=true){const v=JSON.parse(f.context[key]);change(v);f.context[key]=jsonBytes(v);if(key==='macSkipApprovalBytes'){f.context.grant.macEditorSkip.approvalSha256=digest(f.context[key]);f.doc.macEditorSkip.approvalSha256=digest(f.context[key]);return refreshSeven(f);}return rebindMacSkip(f,rebuildManifests);}
for(const[asset,key]of macSkipAssets) for(const[name,value]of [['missing',undefined],['modified',Buffer.from('{}')],['null',jsonBytes(null)],['array',jsonBytes([])]])test(`Mac-only skip rejects ${name} ${asset}`,()=>{const f=macSkipFixture();f.context[key]=value;if(name==='null'||name==='array')rebindMacSkip(f,false);assert.ok(run(f).errors.includes(name==='null'||name==='array'?'TESTFLIGHT_INVALID_MAC_SKIP_SNAPSHOT':'TESTFLIGHT_MAC_SKIP_SNAPSHOT_CHANGED'));});
for(const[name,change]of[
 ['another source',a=>{a.sourceSha='1'.repeat(40);}],['another QA reference',a=>{a.configurationFingerprint='2'.repeat(64);}],['original timing rewritten',a=>{a.originalTimingApprovalSha256='3'.repeat(64);}],['UI10 approval rewritten',a=>{a.previousUi10ApprovalSha256='4'.repeat(64);}],['expiry extended',a=>{a.originalExpiresAt='2026-10-22T00:00:00Z';}],['native QA waived',a=>{a.nativeQaWaived=true;}],['native E2E waived',a=>{a.e2eWaived=true;}],['public permitted',a=>{a.publicReleaseAllowed=true;}],['new Editor round',a=>{a.newEditorRoundAllowed=true;}],['guard correction',a=>{a.inputGuardCorrectionAllowed=true;}],['another Cloud upload',a=>{a.buildUploadLimit=2;}],['another candidate',a=>{a.candidateLimit=2;}],['longer evidence age',a=>{a.maxAgeHours=169;}],['missing observation role',a=>{delete a.originalObservationSha256.cleanupAsset;}],['extra observation role',a=>{a.originalObservationSha256.extra='5'.repeat(64);}]
])test(`Mac-only skip approval rejects ${name}`,()=>{const f=macSkipFixture();alterMacSkip(f,'macSkipApprovalBytes',change,false);assert.ok(run(f).errors.includes('TESTFLIGHT_MAC_SKIP_SCOPE'));});
for(const[name,change]of[
 ['native waiver',h=>{h.physicalDeviceQaWaived=true;}],['E2E waiver',h=>{h.e2eWaived=true;}],['public waiver',h=>{h.publicWithoutNativeQaAuthorized=true;}],['different raw approval digest',h=>{h.sourceRecordSha256='2'.repeat(64);}],['different microsecond',h=>{h.approvedAt='2026-10-08T12:00:00.123457Z';}]
])test(`Mac-only skip rejects human receipt ${name}`,()=>{const f=macSkipFixture();const h=JSON.parse(f.context.macSkipHumanApprovalBytes);change(h);f.context.macSkipHumanApprovalBytes=jsonBytes(h);alterMacSkip(f,'macSkipApprovalBytes',a=>{a.humanApprovalSha256=digest(f.context.macSkipHumanApprovalBytes);},false);assert.ok(run(f).errors.includes('TESTFLIGHT_MAC_SKIP_HUMAN_SCOPE'));});
for(const[name,change]of[
 ['PASS rewrite',r=>{r.passed=true;}],['status rewrite',r=>{r.status='PASSED';}],['old source rewrite',r=>{r.sourceSha='f'.repeat(40);}],['old QA rewrite',r=>{r.configurationFingerprint='6'.repeat(64);}],['functional PASS',r=>{r.functionalCoverage.pass=1;}],['matrix PASS',r=>{r.uxAreaCoverage.pass=1;}],['acceptance PASS',r=>{r.acceptanceConditionsPassCount=1;}],['new run',r=>{r.actualRunCount=2;}],['native input',r=>{r.inputCounts.nativeCgPosts=1;}],['raw keys erased',r=>{r.inputCounts.rawRuntimeKeyEvents=0;}],['fixture input',r=>{r.inputCounts.fixture=1;}],['failure erased',r=>{r.firstBinding.status='PASSED';}],['retry',r=>{r.firstBinding.retries=1;}],['unpreserved original',r=>{r.originalProgressFilesUnmodified=false;}],['new QA after stop',r=>{r.noAdditionalQaAfterFailure=false;}],['new clock',r=>{r.clockResetOrExtension=true;}],['longer main budget',r=>{r.mainDeadlineAt='2026-10-08T14:32:00Z';}],['longer total budget',r=>{r.absoluteMaximumAt='2026-10-08T15:02:00Z';}],['cleanup time rewritten',r=>{r.endedAt='2026-10-08T11:41:00Z';}]
])test(`Mac-only skip preserves original ${name}`,()=>{const f=macSkipFixture();alterMacSkip(f,'macSkipResultBytes',change);assert.ok(run(f).errors.includes(['new clock','longer main budget','longer total budget','cleanup time rewritten'].includes(name)?'TESTFLIGHT_MAC_SKIP_TIME':'TESTFLIGHT_MAC_SKIP_ORIGINAL_VERDICT'));});
for(const[name,change]of[
 ['changed product',v=>{v.files[1].sha256='9'.repeat(64);}],['helper change',v=>{v.helpers[0].sha256='9'.repeat(64);}],['missing files',v=>{v.files=[];}],['missing helper',v=>{v.helpers=[];}],['another QA file',v=>{v.files[0].path='qa-project/src/other.gd';}],['mismatch inventory',v=>{v.unexpectedProductMismatches=['src/sample.gd'];}],['frozen mismatch',v=>{v.frozenMismatches=['qa-project/probe.gd'];}],['duplicate path',v=>{v.files[1].path=v.files[0].path;}],['product edit declaration',v=>{v.productCodeSdkRulesBalanceSaveIdentifiersEdited=true;}]
])test(`Mac-only skip rejects source/helper history ${name}`,()=>{const f=macSkipFixture();alterMacSkip(f,'macSkipSourceIntegrityBytes',change);assert.ok(run(f).errors.includes('TESTFLIGHT_MAC_SKIP_SOURCE_HISTORY'));});
for(const[name,change]of[
 ['different PID',v=>{v.actions[0].pid=999;}],['different owner row',v=>{v.actions[0].verifiedIdentityRow='999 other game';}],['missing cleanup',v=>{v.actions.pop();}],['alive game',v=>{v.actions[0].absentAfterWait=false;}],['another app',v=>{v.otherAppsTouched=true;}],['force kill',v=>{v.forceKill=true;}],['new run',v=>{v.newRuns=1;}],['new input',v=>{v.inputPosted=1;}],['wrong role',v=>{v.actions[0].role='editor';}],['cleanup QA PASS',v=>{v.productQaPassed=true;}]
])test(`Mac-only skip rejects cleanup ${name}`,()=>{const f=macSkipFixture();alterMacSkip(f,'macSkipCleanupBytes',change);assert.ok(run(f).errors.includes('TESTFLIGHT_MAC_SKIP_CLEANUP'));});
for(const[name,change]of[
 ['retry',v=>{v.retryCount=1;}],['input',v=>{v.productInputPosted=1;}],['PASS',v=>{v.exitCode=0;}],['extra observe',v=>{v.observeAttemptNumber=2;}],['after cleanup',v=>{v.finishedAt='2026-10-08T11:41:00Z';}]
])test(`Mac-only skip rejects first failure ${name}`,()=>{const f=macSkipFixture();alterMacSkip(f,'macSkipFirstFailureBytes',change);assert.ok(run(f).errors.includes(name==='after cleanup'?'TESTFLIGHT_MAC_SKIP_TIME':'TESTFLIGHT_MAC_SKIP_ORIGINAL_VERDICT'));});
for(const[key,change]of[
 ['macSkipOriginalManifestBytes',m=>{m.filesCount++;}],['macSkipOriginalManifestBytes',m=>{m.files[0].stableDuringHash=false;}],['macSkipOriginalManifestBytes',m=>{m.files[0].sha256='0'.repeat(64);}],['macSkipOriginalManifestBytes',m=>{m.files[0].path='../outside';}],['macSkipDeliverableManifestBytes',m=>{m.resultSha256='0'.repeat(64);}],['macSkipDeliverableManifestBytes',m=>{m.files[0].bytes++;}],['macSkipDeliverableManifestBytes',m=>{m.createdAt='2026-10-08T12:01:00Z';}]
])test(`Mac-only skip rejects rebound manifest ${key} ${String(change)}`,()=>{const f=macSkipFixture();alterMacSkip(f,key,change,false);assert.ok(run(f).errors.includes('TESTFLIGHT_MAC_SKIP_MANIFEST'));});
for(const[name,change]of[
 ['unreviewed document flag',f=>{delete f.context.grant.macEditorSkip;}],['unreviewed approval',f=>{delete f.context.macSkipApprovalBytes;}],['changed proposal',f=>{f.context.macSkipProposalBytes=Buffer.from('waive all tests');}],['older UI branch',f=>{f.context.grant.approvedUiRounds=9;}],['missing prior UI5 original',f=>{delete f.context.ui5SourceSnapshotBytes;}],['new UI round',f=>{f.doc.editor.iterations.push({...f.doc.editor.iterations[9],number:11});}],['passed UI10',f=>{f.doc.editor.iterations[9].functional.status='passed';}],['new source for old UI10',f=>{f.doc.editor.iterations[9].sourceSha=f.context.sourceSha;}],['fake E2E completion',f=>{f.doc.editor.e2e.completedAt='2026-10-08T11:43:00Z';}],['missing original feature',f=>{f.doc.editor.features.pop();}],['self-review',f=>{f.doc.editor.iterations[9].reviewer=f.doc.editor.implementer;}],['old UI4 expanded',f=>{f.doc.editor.additionalIterationApproval.maxRound=10;}],['old UI4 approval late',f=>{f.doc.editor.additionalIterationApproval.approvedAt='2026-10-08T04:01:00Z';}],['Android incomplete',f=>{f.doc.android.features[0].status='blocked';}],['Android missing foundation',f=>{f.doc.android.features.pop();}],['Android old source',f=>{f.doc.android.sourceSha=JSON.parse(f.context.macSkipApprovalBytes).skippedSourceSha;}],['Android changed native config',f=>{f.doc.android.configurationFingerprint='0'.repeat(64);}],['public phase',f=>{f.context.phase='before-release';}],['public distribution',f=>{f.context.providerProof.internalOnly=false;}],['second Cloud build',f=>{f.context.providerProof.matchingBuildCount=2;}],['wrong bundle target',f=>{f.context.target='google-play';}],['expired',f=>{f.context.now='2026-10-22T00:00:00Z';}]
])test(`Mac-only skip does not waive ${name}`,()=>{const f=macSkipFixture();change(f);refreshSeven(f);const expected={'unreviewed document flag':'MAC_SKIP_REVIEWED_APPROVAL_REQUIRED','unreviewed approval':'MAC_SKIP_APPROVAL_CHANGED','changed proposal':'APPROVED_PROPOSAL_CHANGED','older UI branch':'BOOTSTRAP_REQUIRED','missing prior UI5 original':'UI5_SNAPSHOT_CHANGED','new UI round':'MAC_SKIP_EDITOR_HISTORY','passed UI10':'MAC_SKIP_EDITOR_HISTORY','new source for old UI10':'UI10_SOURCE','fake E2E completion':'MAC_SKIP_EDITOR_SCHEMA','missing original feature':'MAC_SKIP_EDITOR_HISTORY','self-review':'MAC_SKIP_EDITOR_HISTORY','old UI4 expanded':'MAC_SKIP_UI4_APPROVAL','old UI4 approval late':'MAC_SKIP_UI4_APPROVAL','Android incomplete':'BOOTSTRAP_REQUIRED','Android missing foundation':'ANDROID_FOUNDATION_REQUIRED','Android old source':'ANDROID_ACTUAL_CANDIDATE','Android changed native config':'ANDROID_ACTUAL_CANDIDATE','public phase':'PHASE','public distribution':'PROVIDER_INTERNAL_ONLY','second Cloud build':'PROVIDER_INTERNAL_ONLY','wrong bundle target':'SCOPE','expired':'EXPIRED'}[name];assert.ok(run(f).errors.includes('TESTFLIGHT_'+expected),JSON.stringify(run(f).errors));});
function macSkipDeploymentFixture(){const f=macSkipFixture(),p=f.context.providerProof;f.context.grantSha256='d'.repeat(64);f.context.beforeBuildReceipt=run(f);f.context.phase='before-deploy';f.context.artifactProof={verified:true,sourceSha:f.context.sourceSha,buildId:p.buildId,buildNumber:p.buildNumber,bundleId:f.context.grant.packageName,version:'1.1.0',sha256:'e'.repeat(64)};return f;}
test('Mac-only skip upload keeps exact signed artifact and same build approval receipt',()=>{const f=macSkipDeploymentFixture();assert.equal(run(f).ok,true,JSON.stringify(run(f).errors));});
for(const[name,change]of[
 ['missing signed artifact',f=>{delete f.context.artifactProof;}],['different artifact source',f=>{f.context.artifactProof.sourceSha=SHA;}],['different signed build',f=>{f.context.artifactProof.buildId='another';}],['different number',f=>{f.context.artifactProof.buildNumber++;}],['different bundle',f=>{f.context.artifactProof.bundleId='other.bundle';}],['different version',f=>{f.context.artifactProof.version='1.1.1';}],['different grant',f=>{f.context.beforeBuildReceipt.grantSha256='0'.repeat(64);}],['different skip approval',f=>{f.context.beforeBuildReceipt.macEditorSkipApprovalSha256='0'.repeat(64);}],['falsified Editor PASS',f=>{f.context.beforeBuildReceipt.editorStatus='passed';}],['falsified E2E PASS',f=>{f.context.beforeBuildReceipt.editorE2eStatus='passed';}],['public receipt',f=>{f.context.beforeBuildReceipt.publicReleaseAllowed=true;}]
])test(`Mac-only skip upload rejects ${name}`,()=>{const f=macSkipDeploymentFixture();change(f);assert.ok(run(f).errors.includes(['different grant','different skip approval','falsified Editor PASS','falsified E2E PASS','public receipt'].includes(name)?'TESTFLIGHT_SAME_BUILD_RECEIPT':'TESTFLIGHT_ACTUAL_ARTIFACT_REQUIRED'));});
for(const[name,change]of[
 ['schema version',e=>{e.schemaVersion=999;}],['repository',e=>{e.repository='seorilabs/other';}],['target',e=>{e.target='google-play';}],['product kind',e=>{e.productKind='service';}],['missing design',e=>{delete e.design;}],['missing implementer',e=>{delete e.implementer;}],['blank implementer',e=>{e.implementer=' ';}],['blank reviewer',e=>{e.iterations[0].reviewer=' ';}],['missing acceptance evidence',e=>{delete e.acceptance[0].evidence;}],['missing red evidence',e=>{delete e.tdd[0].redEvidence;}],['missing persona',e=>{delete e.iterations[0].personas;}],['missing iteration plan',e=>{delete e.iterations[0].plan;}],['invalid core flag',e=>{e.features[0].core=!e.features[0].core;}],['missing iteration feature',e=>{e.iterations[0].functional.featureIds=[];}]
])test(`Mac-only skip preserves static metadata validation: ${name}`,()=>{const f=macSkipFixture();change(f.doc.editor);refreshSeven(f);const code=['repository','target','product kind','blank implementer','blank reviewer'].includes(name)?'TESTFLIGHT_MAC_SKIP_EDITOR_SCOPE':name==='invalid core flag'?'TESTFLIGHT_MAC_SKIP_EDITOR_HISTORY':'TESTFLIGHT_MAC_SKIP_EDITOR_SCHEMA';assert.ok(run(f).errors.includes(code),JSON.stringify(run(f).errors));});
for(const[name,change]of[
 ['wrong kind',h=>{h.kind='unrelated';}],['wrong answer',h=>{h.approvedAnswer='skip all tests';}],['new round',h=>{h.newMacEditorRoundAuthorized=true;}],['guard change',h=>{h.previousInputGuardAmendmentProposal='approved';}]
])test(`Mac-only skip rejects receipt directive ${name}`,()=>{const f=macSkipFixture();const h=JSON.parse(f.context.macSkipHumanApprovalBytes);change(h);f.context.macSkipHumanApprovalBytes=jsonBytes(h);alterMacSkip(f,'macSkipApprovalBytes',a=>{a.humanApprovalSha256=digest(f.context.macSkipHumanApprovalBytes);},false);assert.ok(run(f).errors.includes('TESTFLIGHT_MAC_SKIP_HUMAN_SCOPE'));});
test('Mac-only skip keeps current static metadata distinct from unchanged prior UI10 bytes',()=>{const f=macSkipFixture(),raw=JSON.parse(f.context.macSkipResultBytes);assert.equal(f.doc.editor.sourceSha,f.context.sourceSha);assert.equal(f.doc.editor.iterations[9].sourceSha,raw.sourceSha);assert.notEqual(raw.sourceSha,f.doc.editor.sourceSha);assert.equal(run(f).ok,true);f.doc.editor.sourceSha=raw.sourceSha;refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_MAC_SKIP_EDITOR_SCOPE'));});
test('Mac-only skip cannot replay the historical candidate with immutable reviewed approval',()=>{const f=macSkipFixture(),approval=Buffer.from(f.context.macSkipApprovalBytes),old=JSON.parse(approval).skippedSourceSha;for(const v of[f.context,f.context.grant,f.doc.editor,f.doc.android,f.doc.ios,f.context.providerProof])v.sourceSha=old;refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_MAC_SKIP_SCOPE'));assert.deepEqual(f.context.macSkipApprovalBytes,approval);});
for(const freshAndroid of[true,false])test(`original expiry rejects skip approval plus169h; freshAndroid=${freshAndroid}`,()=>{const f=macSkipFixture();f.context.now='2026-10-15T13:00:00.123456Z';if(freshAndroid)Object.assign(f.doc.android,{plannedAt:'2026-10-15T12:00:00Z',startedAt:'2026-10-15T12:01:00Z',completedAt:'2026-10-15T12:30:00Z'});refreshSeven(f);const errors=run(f).errors;assert.ok(errors.includes('TESTFLIGHT_EXPIRED'));assert.equal(errors.includes('TESTFLIGHT_ANDROID_TIME'),!freshAndroid);});
test('extending the original expiry cannot authorize skip approval plus169h',()=>{const f=macSkipFixture();f.context.now='2026-10-15T13:00:00.123456Z';f.context.grant.expiresAt='2026-10-15T14:00:00Z';Object.assign(f.doc.android,{plannedAt:'2026-10-15T12:00:00Z',startedAt:'2026-10-15T12:01:00Z',completedAt:'2026-10-15T12:30:00Z'});alterMacSkip(f,'macSkipApprovalBytes',a=>{a.originalExpiresAt=f.context.grant.expiresAt;},false);assert.ok(run(f).errors.includes('TESTFLIGHT_EXPIRED'));});
for(const value of[undefined,null])test(`malformed skip editor ${String(value)} fails at the outer schema`,()=>{const f=macSkipFixture();f.doc.editor=value;refreshSeven(f);assert.deepEqual(run(f),{ok:false,errors:['TESTFLIGHT_BOOTSTRAP_REQUIRED']});});
test('a null cleanup action fails with the specific cleanup code after full digest rebinding',()=>{const f=macSkipFixture();alterMacSkip(f,'macSkipCleanupBytes',c=>{c.actions[0]=null;});assert.deepEqual(run(f),{ok:false,errors:['TESTFLIGHT_MAC_SKIP_CLEANUP']});});


// 합성 이력 입력. 실제 UI/기기 실행 근거가 아니다.
function rebindMacDisplayHistory(f){
 rebindUi6History(f);rebindUi7History(f);rebindUi8History(f);rebindUi9History(f);
 const a=JSON.parse(f.context.macSkipApprovalBytes);a.previousUi10ApprovalSha256=f.context.grant.ui10ApprovalSha256;
 f.context.macSkipApprovalBytes=jsonBytes(a);return rebindMacSkip(f);
}
function macFailedDisplayFixture(){
 const f=macSkipFixture(),start=JSON.parse(f.context.ui6ExecutionStartBytes),cfg=JSON.parse(f.context.ui6ConfigurationBytes);
 start.configurationFingerprint='e'.repeat(64);
 cfg.runtimeDisplayHistory=[{kind:'native-separate-window',configurationFingerprint:start.configurationFingerprint,firstRunPid:999,startedAt:start.startedAt,stoppedAt:'2026-10-08T05:52:00Z',gameInputs:0},{kind:'editor-embedded-fixed-size',recoveryAuthorizedBy:'approved isolated QA coordination',recoveryAt:'2026-10-08T05:53:00Z',globalSettingsChanged:false}];
 f.context.ui6ExecutionStartBytes=jsonBytes(start);f.context.ui6ConfigurationBytes=jsonBytes(cfg);
 for(const aspect of ['functional','ux'])f.doc.editor.iterations[5][aspect].status='failed';
 return rebindMacDisplayHistory(f);
}
test('Mac failed UI6 display transition preserves original failure and no product E2E pass',()=>{
 const f=macFailedDisplayFixture(),result=run(f);assert.equal(result.ok,true,JSON.stringify(result.errors));
 assert.equal(result.productE2eStatus,'blocked');assert.equal(result.nativeQaWaived,false);assert.equal(result.publicReleaseAllowed,false);
 assert.equal(f.doc.editor.iterations[5].functional.status,'failed');assert.equal(JSON.parse(f.context.ui6FailedSegmentBytes).wholeUi6Completed,false);
});
for(const[name,change]of[
 ['missing transition',v=>{delete v.runtimeDisplayHistory;}],['only one display',v=>{v.runtimeDisplayHistory.pop();}],['null initial display',v=>{v.runtimeDisplayHistory[0]=null;}],['null final display',v=>{v.runtimeDisplayHistory[1]=null;}],
 ['extra display',v=>{v.runtimeDisplayHistory.push(v.runtimeDisplayHistory[1]);}],['wrong initial fingerprint',v=>{v.runtimeDisplayHistory[0].configurationFingerprint='0'.repeat(64);}],
 ['initial product input',v=>{v.runtimeDisplayHistory[0].gameInputs=1;}],['invalid PID',v=>{v.runtimeDisplayHistory[0].firstRunPid=0;}],
 ['different initial clock',v=>{v.runtimeDisplayHistory[0].startedAt='2026-10-08T05:51:01Z';}],['global settings changed',v=>{v.runtimeDisplayHistory[1].globalSettingsChanged=true;}],
 ['missing recovery authority',v=>{v.runtimeDisplayHistory[1].recoveryAuthorizedBy='';}],['recovery before first stop',v=>{v.runtimeDisplayHistory[1].recoveryAt='2026-10-08T05:51:30Z';}],
 ['recovery after failed segment',v=>{v.runtimeDisplayHistory[1].recoveryAt='2026-10-08T06:01:00Z';}],
])test('Mac failed UI6 display transition rejects '+name,()=>{
 const f=macFailedDisplayFixture(),v=JSON.parse(f.context.ui6ConfigurationBytes);change(v);f.context.ui6ConfigurationBytes=jsonBytes(v);rebindMacDisplayHistory(f);
 assert.ok(run(f).errors.includes('TESTFLIGHT_UI6_SNAPSHOT_SCOPE'),JSON.stringify(run(f).errors));
});
for(const aspect of ['functional','ux'])test('Mac failed UI6 display transition rejects '+aspect+' PASS promotion',()=>{
 const f=macFailedDisplayFixture();f.doc.editor.iterations[5][aspect].status='passed';refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI6_SNAPSHOT_SCOPE'));
});
test('Mac failed UI6 display transition does not alter the normal historical path',()=>{
 const f=macFailedDisplayFixture();delete f.context.grant.macEditorSkip;refreshSeven(f);assert.ok(run(f).errors.includes('TESTFLIGHT_UI6_SNAPSHOT_SCOPE'));
});

import {validateCloud12RecoveryApproval} from '../scripts/release/internal-testflight-bootstrap.mjs';
function cloudRecoveryFixture(){
 const f=fixture(),g=f.context.grant;const proposal=Buffer.from('approved exact failed12 and one extra Cloud13; total2 upload1; original expiry');
 const recovery={approvalFile:'docs/design/2026-10-16-spiritgate-cloud12-recovery/approval.json',approvalSha256:'c'.repeat(64),additionalCloudAttempts:1,totalCloudAttemptLimit:2,totalUploadLimit:1,expectedBuildNumber:13,previousRun:{id:'failed-12',number:12,finishedAt:'2026-10-14T05:58:00Z',tagReferenceId:'tag-1',archiveActionId:'archive-12',logArtifactId:'log-12',logZipSha256:'d'.repeat(64)}};
 const a={kind:'human_cloud12_recovery_approval',repository:g.repository,version:'1.1.0',sourceSha:g.sourceSha,configurationFingerprint:g.configurationFingerprint,originalTimingApprovalSha256:g.approvalSha256,originalGrantSha256:'95f0c3f0f1e4b6f059681fc1fe735e8db7dff26658378f348340b48d08be3fa5',originalApprovedAt:g.approvedAt,originalExpiresAt:g.expiresAt,workingOverrides:structuredClone(g.workingOverrides),productionProfileSha256:g.profileSha256,appleSigningTeam:'HCDUXX4Z3X',previousRunId:'failed-12',previousBuildNumber:12,expectedBuildNumber:13,additionalCloudAttempts:1,totalCloudAttemptLimit:2,totalUploadLimit:1,originalFailurePreserved:true,nativeQaWaived:false,e2eWaived:false,publicReleaseAllowed:false,newAppleResourcesAllowed:false,proposalSha256:digest(proposal),approvalRecordedAt:'2026-10-14T05:59:00Z',userApprovalVerbatim:'synthetic explicit additional Cloud approval'};
 f.context.cloud12RecoveryApprovalBytes=jsonBytes(a);f.context.cloud12RecoveryProposalBytes=proposal;recovery.approvalSha256=digest(f.context.cloud12RecoveryApprovalBytes);g.cloud12Recovery=recovery;
 Object.assign(f.context.providerProof,{matchingBuildCount:2,buildNumber:13,previousFailedRunId:'failed-12',recoveryVerified:true});return f;
}
test('separate Cloud recovery preserves the failed count and original expiry without public or native waiver',()=>{const f=cloudRecoveryFixture(),p=run(f);assert.equal(p.ok,true,JSON.stringify(p.errors));assert.equal(p.cloudAttemptCount,2);assert.equal(p.cloudAttemptLimit,2);assert.equal(p.uploadLimit,1);assert.equal(p.previousFailedRunId,'failed-12');assert.equal(p.nativeQaWaived,false);assert.equal(p.productE2eStatus,'blocked');});
for(const [name,change] of [
 ['missing approval',a=>{a.userApprovalVerbatim='';}],['another source',a=>{a.sourceSha='1'.repeat(40);}],['original grant changed',a=>{a.originalGrantSha256='2'.repeat(64);}],
 ['changed generated file approval',a=>{a.workingOverrides['before-deploy']['project.godot']='4'.repeat(64);}],['changed profile approval',a=>{a.productionProfileSha256='5'.repeat(63)+'6';}],['changed signing team approval',a=>{a.appleSigningTeam='OTHERTEAM';}],
 ['original timing approval changed',a=>{a.originalTimingApprovalSha256='3'.repeat(64);}],['expiry extended',a=>{a.originalExpiresAt='2026-10-16T05:00:00Z';}],
 ['more than one additional attempt',a=>{a.additionalCloudAttempts=2;}],['third Cloud allowed',a=>{a.totalCloudAttemptLimit=3;}],['second upload allowed',a=>{a.totalUploadLimit=2;}],
 ['another previous run',a=>{a.previousRunId='other';}],['another new build',a=>{a.expectedBuildNumber=14;}],['failed status hidden',a=>{a.originalFailurePreserved=false;}],
 ['native QA waived',a=>{a.nativeQaWaived=true;}],['E2E waived',a=>{a.e2eWaived=true;}],['public allowed',a=>{a.publicReleaseAllowed=true;}],['new signing resource',a=>{a.newAppleResourcesAllowed=true;}],
 ['future approval',a=>{a.approvalRecordedAt='2026-10-14T06:01:00Z';}],['before failure approval',a=>{a.approvalRecordedAt='2026-10-14T05:57:00Z';}],
 ])test('hash-bound cloud recovery approval rejects '+name,()=>{const f=cloudRecoveryFixture(),a=JSON.parse(f.context.cloud12RecoveryApprovalBytes);change(a);f.context.cloud12RecoveryApprovalBytes=jsonBytes(a);f.context.grant.cloud12Recovery.approvalSha256=digest(f.context.cloud12RecoveryApprovalBytes);assert.throws(()=>validateCloud12RecoveryApproval(f.context.grant,f.context.cloud12RecoveryApprovalBytes,f.context.cloud12RecoveryProposalBytes,NOW));assert.equal(run(f).ok,false);});
test('recovery before-deploy receipt must bind the same approval and failed history',()=>{const f=cloudRecoveryFixture(),p=f.context.providerProof;f.context.phase='before-deploy';f.context.grantSha256='6'.repeat(64);f.context.artifactProof={verified:true,sourceSha:SHA,buildId:p.buildId,buildNumber:13,bundleId:f.context.grant.packageName,version:'1.1.0',sha256:'7'.repeat(64)};const before=validate(f.doc,{...f.context,phase:'before-build'});f.context.beforeBuildReceipt=before;assert.equal(run(f).ok,true,JSON.stringify(run(f).errors));for(const changes of [{cloudRecoveryApprovalSha256:'0'.repeat(64)},{previousFailedRunId:'other'},{cloudAttemptCount:1},{cloudAttemptLimit:3},{uploadLimit:2}]){f.context.beforeBuildReceipt={...before,...changes};assert.equal(run(f).ok,false,JSON.stringify(changes));}});
test('missing or changed recovery proposal and uncounted failure are rejected',()=>{for(const change of [f=>{delete f.context.cloud12RecoveryApprovalBytes;},f=>{f.context.cloud12RecoveryProposalBytes=Buffer.from('replacement');},f=>{f.context.providerProof.matchingBuildCount=1;},f=>{f.context.providerProof.recoveryVerified=false;}]){const f=cloudRecoveryFixture();change(f);assert.equal(run(f).ok,false);}});

test('changing approved before-deploy bytes in the grant cannot reuse the same human recovery approval',()=>{const f=cloudRecoveryFixture();f.context.grant.workingOverrides['before-deploy']['project.godot']='8'.repeat(64);assert.equal(run(f).ok,false);});
