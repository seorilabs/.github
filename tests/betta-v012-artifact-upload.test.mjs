import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as core from '../scripts/release/betta-internal-bootstrap.mjs';
import {assertV012GoogleHistory,assertV012AppleHistory,assertV012ProviderArtifact} from '../scripts/release/betta-v012-artifact-policy.mjs';
import {reserveV012ArtifactUpload,v012UploadSlot} from '../scripts/release/betta-v012-artifact-upload.mjs';
const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url)));
function grant(target='google'){
 const g=read('../contracts/betta-internal-bootstrap/betta-0-1-2-'+target+'-drawer-fit.json');
 delete g.internalUpdate;delete g.workingOverrides;
 return {...g,kind:'betta-existing-artifact-upload',id:'betta-v012-'+target+'-artifact-upload',revoked:false,maxBuildsPerMarket:0,artifactApprovalSha256:'b'.repeat(64),existingArtifactUpload:read('./fixtures/betta-v012-'+target+'-artifact-binding.json')};
}
const context=g=>({repository:g.repository,sourceSha:g.sourceSha,tag:g.releaseTag,configurationFingerprint:g.configurationFingerprint,target:g.targets[0],phase:'before-deploy',playTrack:'internal',playOperation:'upload',now:'2026-11-13T14:00:00Z'});
const blocked={ok:false,errors:['THREE_UI_ROUNDS_REQUIRED']};
test('exact artifact grant allows zero new native builds',()=>assert.equal(core.validateBettaGrant(grant()).maxBuildsPerMarket,0));
test('artifact grant is never admitted into normal build path',()=>assert.throws(()=>core.validateBettaInternalContext(grant(),context(grant()),blocked),/BETTA_UPLOAD_ONLY_REQUIRED/));
for(const target of ['google','apple'])test('artifact-only context preserves failed product QA: '+target,()=>{
 const g=grant(target),d=core.validateBettaArtifactUploadContext(g,context(g),blocked);assert.equal(d.nativeQaWaived,false);assert.equal(d.productE2eStatus,'blocked');assert.deepEqual(d.originalVerdict,blocked);
 assert.throws(()=>core.validateBettaArtifactUploadContext(g,{...context(g),phase:'before-build'},blocked));
});
for(const mutate of [g=>{g.maxBuildsPerMarket=1;},g=>{g.existingArtifactUpload.additionalGameBuilds=1;},g=>{g.existingArtifactUpload.artifactSha256='f'.repeat(64);},g=>{g.sourceSha='e'.repeat(40);},g=>{g.releaseTag='v0.1.3';},g=>{g.existingArtifactUpload.cumulativeNativeLimit++;}])test('artifact recovery cannot widen scope '+mutate.toString(),()=>{const g=grant();mutate(g);assert.throws(()=>core.validateBettaGrant(g));});
function google(){
 const g=grant(),r=g.existingArtifactUpload,log=Buffer.from('BETTA_UNTRACKED_SOURCE "tools/__pycache__/pinned_download.cpython-313.pyc"');r.rawJobLogSha256=core.bettaDigest(log);
 const runs=[43286867642,43292795874,r.sourceRunId].map(id=>({id,status:'completed',conclusion:'failure',run_attempt:1,event:'workflow_dispatch',path:'.github/workflows/deploy-google-play.yml',repository:{full_name:g.repository},head_sha:id===r.sourceRunId?g.sourceSha:'bd78bd996987481d668185da815c6853c4e99a4b'}));
 const jobs=[{id:r.jobId,run_id:r.sourceRunId,status:'completed',conclusion:'failure',steps:[{name:'Export signed Android AAB',conclusion:'success'},{name:'Verify Editor E2E before-deploy',conclusion:'failure'},{name:'Upload to Google Play',conclusion:'skipped'}]}];return {g,data:{runs,jobs,log}};
}
test('exact cumulative Google history and original audit failure are retained',()=>{const {g,data}=google();assertV012GoogleHistory(g,data);});
for(const mutate of [d=>{d.runs.push({...d.runs[2],id:999});},d=>{d.runs[2].run_attempt=2;},d=>{d.runs[2].head_sha='a'.repeat(40);},d=>{d.jobs[0].steps[2].conclusion='success';},d=>{d.jobs[0].steps[2].conclusion=null;},d=>{d.log=Buffer.from('different original log');}])test('Google unknown upload, extra native or altered failure stops recovery '+mutate.toString(),()=>{const {g,data}=google();mutate(data);assert.throws(()=>assertV012GoogleHistory(g,data));});
function apple(){
 const g=grant('apple'),r=g.existingArtifactUpload,ids=['19199616-067d-4497-9289-4b9bb628f0aa','064ecfc0-bcbb-470a-8fe2-0348534a4b5b','845f07b9-5601-4e01-993c-e67285709dec',r.sourceRunId];
 const runs=ids.map((id,i)=>({id,attributes:{number:i+1,sourceCommit:{commitSha:i<2?'bd78bd996987481d668185da815c6853c4e99a4b':i===2?'706e1130de7d123bac68193821bf301ed9ad336e':g.sourceSha},executionProgress:'COMPLETE',completionStatus:'FAILED',startReason:'MANUAL',isPullRequestBuild:false},relationships:{workflow:{data:{id:g.appStore.workflowId}},product:{data:{id:g.appStore.productId}},sourceBranchOrTag:{data:{id:i===3?r.sourceTagId:'old-tag'}}}}));
 return {g,data:{runs,workflow:{id:g.appStore.workflowId,attributes:{isEnabled:false}},actions:[{id:r.archiveActionId,attributes:{actionType:'ARCHIVE',executionProgress:'COMPLETE',completionStatus:'FAILED'}},{id:r.postActionId,attributes:{actionType:'TEST',executionProgress:'COMPLETE',completionStatus:'SKIPPED',startedDate:null}}]}};
}
test('four failed Apple runs and disabled workflow do not become a native QA pass',()=>{const {g,data}=apple();assertV012AppleHistory(g,data);});
for(const mutate of [d=>{d.workflow.attributes.isEnabled=true;},d=>{d.runs.push(d.runs[3]);},d=>{d.runs[3].attributes.number=5;},d=>{d.runs[3].attributes.completionStatus='SUCCEEDED';},d=>{d.actions[1].attributes.startedDate='2026-11-13T13:18:00Z';}])test('Apple extra native, active workflow or ambiguous uploader cannot recover '+mutate.toString(),()=>{const {g,data}=apple();mutate(data);assert.throws(()=>assertV012AppleHistory(g,data));});
test('provider artifact ID, origin and digest cannot drift',()=>{
 const g=grant(),r=g.existingArtifactUpload,a={id:r.sourceArtifactId,name:r.sourceArtifactName,expired:false,digest:'sha256:'+r.archiveSha256,workflow_run:{id:r.sourceRunId,head_sha:g.sourceSha,repository_id:1455493296}};
 assertV012ProviderArtifact(g,a);
 for(const patch of [{expired:true},{id:1},{digest:'sha256:'+'a'.repeat(64)},{workflow_run:{...a.workflow_run,head_sha:'a'.repeat(40)}}])assert.throws(()=>assertV012ProviderArtifact(g,{...a,...patch}));
});
function reservationFixture(lost=false){
 const files=new Map();let next=1;
 const fetchImpl=async(raw,init={})=>{
  const url=new URL(raw);
  if(url.hostname==='uploads.github.com'){
   const name=url.searchParams.get('name');if(files.has(name))return Response.json({}, {status:422});
   const file={id:next++,bytes:Buffer.from(init.body)};files.set(name,file);
   if(lost)throw new Error('lost response after stored reservation');return Response.json({id:file.id},{status:201});
  }
  const f=[...files.values()].find(x=>url.pathname.endsWith('/'+x.id));assert.ok(f);return new Response(f.bytes);
 };
 return {files,request:{token:'fixture',fetchImpl},release:{id:444232019,upload_url:'https://uploads.github.com/repos/seorilabs/betta-raising/releases/444232019/assets{?name,label}'}};
}
test('atomic package/version reservation admits one competitor and fences the old producer',async()=>{
 const f=reservationFixture(),g=grant();const settled=await Promise.allSettled(['first','second'].map(producer=>reserveV012ArtifactUpload(g,f.release,{producer},f.request)));
 assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.files.size,2);assert.ok(f.files.has(v012UploadSlot(g)));
 await assert.rejects(reserveV012ArtifactUpload(g,f.release,{producer:'first'},f.request),/BETTA_UPLOAD_SLOT_CONSUMED/);
});
test('lost reservation response is not retried or treated as an accepted upload',async()=>{
 const f=reservationFixture(true),g=grant();await assert.rejects(reserveV012ArtifactUpload(g,f.release,{producer:'first'},f.request),/lost response/);
 await assert.rejects(reserveV012ArtifactUpload(g,f.release,{producer:'first'},f.request),/BETTA_UPLOAD_SLOT_CONSUMED/);assert.equal(f.files.size,1);
});
test('reviewed upload consumer has no native compilation, export or signing command',()=>{
 const source=readFileSync(new URL('../scripts/release/betta-v012-artifact-upload.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/spawnSync\(['"](?:godot|gradle|xcodebuild)['"]|--export-release|codesign[^\n]+--sign/u);
});
