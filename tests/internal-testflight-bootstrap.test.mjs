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
  editor.e2e.scenarios[0].featureIds = ids;
  const fourth = structuredClone(editor.iterations[2]);
  Object.assign(fourth,{number:4,plannedAt:'2026-10-08T04:00:00Z',startedAt:'2026-10-08T04:01:00Z',completedAt:'2026-10-08T04:10:00Z'});
  editor.iterations.push(fourth);
  editor.additionalIterationApproval = {approverKind:'human',approver:'owner',approvedAt:'2026-10-08T03:50:00Z',maxRound:4,evidence:'https://example.com/approval'};
  const doc = {schemaVersion:1,id:'spiritgate-1.1.0-first-internal',scope:'internal_testflight_only',editor,
    android:{sourceSha:SHA,target:'google-play',configurationFingerprint:'c'.repeat(64),deviceKind:'physical-android',artifactSha256:'d'.repeat(64),plannedAt:'2026-10-08T05:00:00Z',startedAt:'2026-10-08T05:05:00Z',completedAt:'2026-10-08T05:20:00Z',features:foundation.map(id=>({id,status:'passed',evidence:['https://example.com/device']}))},
    ios:{sourceSha:SHA,target:'app-store',status:'deferred',reason:'existing App Store profile requires internal TestFlight installation',featureIds:foundation},
    originalObservations:[{name:'prior-ui-and-native-observations.json',sha256:'e'.repeat(64)}]};
  const approvalBytes=jsonBytes({kind:'human_testflight_timing_approval',repository:editor.repository,version:'1.1.0',objective:'first_internal_testflight_qa',candidateLimit:1,buildUploadLimit:1,maxAgeHours:168,approvalRecordedAt:'2026-10-08T05:00:00Z',userApprovalVerbatim:'first internal TestFlight timing approval',iphoneQa:'deferred until internal installation; not waived',newAppleResourcesAllowed:false,publicReleaseRequires:'normal validator, actual iPhone QA and whole E2E'});
  const grant={schemaVersion:1,kind:'first-internal-testflight',id:doc.id,repository:editor.repository,releaseTag:'v1.1.0',packageName:'com.seorilabs.spiritgatedefenders',sourceSha:SHA,profileSha256:'5'.repeat(64),approvalFile:'docs/design/2026-10-14-spiritgate-internal-testflight/approval.json',evidenceAsset:{id:123,sha256:digest(jsonBytes(doc))},originalObservationAssets:[{id:124,sha256:'e'.repeat(64)}],workingOverrides:{'before-build':{},'before-deploy':{}},configurationFingerprint:FP,androidConfigurationFingerprint:doc.android.configurationFingerprint,productTreeSha256:'f'.repeat(64),evidenceSha256:digest(jsonBytes(doc)),approvalSha256:digest(approvalBytes),inventorySha256:digest(inventoryBytes),approvedAt:'2026-10-08T05:00:00Z',expiresAt:'2026-10-15T05:00:00Z',revoked:false,provider:{appId:'6792205995',productId:'E5C1A24C-AA05-41B0-B2F6-F1BF0B92D7DB',workflowId:'45B83B98-ABE4-48C1-83FC-09CF3F79651E'}};
  const context={repository:grant.repository,sourceSha:SHA,target:'app-store',phase:'before-build',tag:grant.releaseTag,configurationFingerprint:FP,now:NOW,grant,approvalBytes,inventoryBytes,evidenceBytes:jsonBytes(doc),originalEvidenceVerified:true,productTreeSha256:grant.productTreeSha256,executionVerified:true,verifierProof:{verified:true,reviewedOnCurrentMain:true},providerProof:{verified:true,internalOnly:true,sourceSha:SHA,workflowId:grant.provider.workflowId,productId:grant.provider.productId,buildId:'TEST-BUILD-ID',buildNumber:42,matchingBuildCount:1}};
  return {doc,context};
}
const run = f => validate(f.doc,f.context);
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
