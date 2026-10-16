import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bootstrapDigest, validateBootstrapAppleObservation as validate, validateBootstrapProcessedBuild,
  verifyBootstrapWorkingTree, verifyInternalTestflightBootstrap, validateBootstrapSigningEntitlements, readBootstrapPlist, validateBootstrapProfileSigner, validateBootstrapApprovalProposal } from '../scripts/release/internal-testflight-bootstrap.mjs';
import { runDevelopmentEvidenceCli } from '../scripts/release/verify-development-evidence.mjs';
const SHA='a'.repeat(40), BUNDLE='com.seorilabs.spiritgatedefenders';
const provider={appId:'6792205995',productId:'E5C1A24C-AA05-41B0-B2F6-F1BF0B92D7DB',workflowId:'45B83B98-ABE4-48C1-83FC-09CF3F79651E'};
const grant={provider,packageName:BUNDLE,sourceSha:SHA,releaseTag:'v1.1.0'};
const env={CI_BUILD_ID:'build-1',CI_BUILD_NUMBER:'42'};
function observation(){
 const run={id:'build-1',attributes:{sourceCommit:{commitSha:SHA},number:42,startReason:'MANUAL',isPullRequestBuild:false},relationships:{workflow:{data:{id:provider.workflowId}},product:{data:{id:provider.productId}},sourceBranchOrTag:{data:{id:'tag-1'}}}};
 return {app:{id:provider.appId,attributes:{bundleId:BUNDLE}},product:{id:provider.productId,relationships:{app:{data:{id:provider.appId}}}},
 workflow:{id:provider.workflowId,relationships:{product:{data:{id:provider.productId}}},attributes:{isEnabled:true,manualTagStartCondition:{source:{isAllMatch:true,patterns:[]}},actions:[{actionType:'ARCHIVE',platform:'IOS',scheme:'SpiritgateDefenders',isRequiredToPass:true,buildDistributionAudience:'INTERNAL_ONLY'}]}},run,runs:[structuredClone(run)],tag:{id:'tag-1',attributes:{kind:'TAG',name:'v1.1.0'}}};
}
test('actual Apple product, workflow, exact tag and first CI run bind to the protected consumer',()=>{const p=validate(observation(),grant,env);assert.equal(p.internalOnly,true);assert.equal(p.buildNumber,42);});
for(const [name,change] of [
 ['App Store eligible archive',o=>{o.workflow.attributes.actions[0].buildDistributionAudience='APP_STORE_ELIGIBLE';}],
 ['second required action',o=>{o.workflow.attributes.actions.push(o.workflow.attributes.actions[0]);}],
 ['automatic tag start',o=>{o.workflow.attributes.tagStartCondition={};}],
 ['branch instead of tag',o=>{o.tag.attributes.kind='BRANCH';}],
 ['wrong tag',o=>{o.tag.attributes.name='v1.1.1';}],
 ['wrong CI number',o=>{o.run.attributes.number=43;}],
 ['wrong source',o=>{o.run.attributes.sourceCommit.commitSha='b'.repeat(40);}],
 ['second same-source build',o=>{o.runs.push({...o.run,id:'build-2'});}],
 ['manual rebuild',o=>{o.run.attributes.startReason='MANUAL_REBUILD';}],
 ['another app',o=>{o.product.relationships.app.data.id='other';}],
])test(`reject Apple ${name}`,()=>{const o=observation();change(o);assert.throws(()=>validate(o,grant,env));});
function processed(){
 return {build:{id:'processed-1',attributes:{buildAudienceType:'INTERNAL_ONLY',processingState:'VALID',version:'42'},relationships:{app:{data:{id:provider.appId}},preReleaseVersion:{data:{id:'pre-1'}}}},
 version:{id:'pre-1',attributes:{version:'1.1.0'}},group:{id:'internal-group',attributes:{isInternalGroup:true},relationships:{app:{data:{id:provider.appId}}}},
 receipt:{ok:true,scope:'internal_testflight_only',productE2eStatus:'blocked',repository:'seorilabs/spiritgate-defenders',sourceSha:SHA,target:'app-store',phase:'before-deploy',buildNumber:42,buildId:'build-1'},run:{id:'build-1',attributes:{completionStatus:'SUCCEEDED',sourceCommit:{commitSha:SHA}}},runBuildIds:['processed-1']};
}
const groupCheck=f=>validateBootstrapProcessedBuild(f.build,f.version,f.group,f.receipt,f.run,f.runBuildIds);
test('only processed provider-linked INTERNAL_ONLY build enters an internal group',()=>assert.equal(groupCheck(processed()).scope,'internal_testflight_only'));
for(const [name,change] of [
 ['external group',f=>{f.group.attributes.isInternalGroup=false;}],
 ['App Store eligible build',f=>{f.build.attributes.buildAudienceType='APP_STORE_ELIGIBLE';}],
 ['processing incomplete',f=>{f.build.attributes.processingState='PROCESSING';}],
 ['public version goal',f=>{f.receipt.scope='public_live';}],
 ['different native binary number',f=>{f.build.attributes.version='43';}],
 ['failed Cloud audit',f=>{f.run.attributes.completionStatus='FAILED';}],
 ['unrelated processed binary',f=>{f.runBuildIds=[];}],
 ['different source build',f=>{f.run.attributes.sourceCommit.commitSha='c'.repeat(40);}],
])test(`reject processed ${name}`,()=>{const f=processed();change(f);assert.throws(()=>groupCheck(f));});
test('unregistered ID has no local file, skip or automatic fallback',async()=>{await assert.rejects(verifyInternalTestflightBootstrap({repository:'seorilabs/spiritgate-defenders',target:'app-store',tag:'v1.1.0',phase:'before-build',bootstrapId:'unregistered-spiritgate-bootstrap',verifierSha:SHA}),/REVIEWED_GRANT_REQUIRED/);});
test('bootstrap CLI cannot combine normal file or public exceptions',async()=>{
 await assert.rejects(runDevelopmentEvidenceCli(['--internal-testflight-bootstrap-id','x','--file','fake']),/INVALID_EVIDENCE_ARGUMENT/);
 await assert.rejects(runDevelopmentEvidenceCli(['--internal-testflight-bootstrap-id','x','--release-exception-id','public']),/INVALID_EVIDENCE_ARGUMENT/);
});
test('actual working bytes and untracked export resources cannot drift from the approved tree',()=>{
 const root=mkdtempSync(join(tmpdir(),'testflight-tree-'));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
 try{
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.com');
  writeFileSync(join(root,'project.godot'),'source');git('add','.');git('commit','-qm','fixture');
  const sourceSha=git('rev-parse','HEAD').toString().trim(),productTreeSha256=bootstrapDigest(git('ls-tree','-r','-z',sourceSha));
  const g={sourceSha,productTreeSha256,workingOverrides:{'before-build':{},'before-deploy':{'project.godot':bootstrapDigest(Buffer.from('prepared'))}}};
  assert.equal(verifyBootstrapWorkingTree(root,g,'before-build').executionVerified,true);
  writeFileSync(join(root,'project.godot'),'prepared');assert.throws(()=>verifyBootstrapWorkingTree(root,g,'before-build'));
  assert.equal(verifyBootstrapWorkingTree(root,g,'before-deploy').executionVerified,true);
  mkdirSync(join(root,'src'));writeFileSync(join(root,'.git','info','exclude'),'src/\nextra.tscn\n');writeFileSync(join(root,'src','unapproved.gd'),'extends Node');assert.throws(()=>verifyBootstrapWorkingTree(root,g,'before-deploy'));rmSync(join(root,'src'),{recursive:true});writeFileSync(join(root,'extra.tscn'),'[gd_scene format=3]');assert.throws(()=>verifyBootstrapWorkingTree(root,g,'before-deploy'));rmSync(join(root,'extra.tscn'));
  for(const extra of ['hidden.gd','extra.sh','xcode-cloud/ci_scripts/hidden.sh']){
   mkdirSync(join(root,extra,'..'),{recursive:true});writeFileSync(join(root,extra),'unapproved');assert.throws(()=>verifyBootstrapWorkingTree(root,g,'before-deploy'));rmSync(join(root,extra));
  }
  mkdirSync(join(root,'.godot'),{recursive:true});writeFileSync(join(root,'.godot','cache'),'generated');
  mkdirSync(join(root,'xcode-cloud','SpiritgateDefenders'),{recursive:true});writeFileSync(join(root,'xcode-cloud','SpiritgateDefenders','Info.plist'),'generated');
  assert.throws(()=>verifyBootstrapWorkingTree(root,g,'before-build'));
  assert.equal(verifyBootstrapWorkingTree(root,g,'before-deploy').executionVerified,true);
  writeFileSync(join(root,'project.godot'),'tampered');assert.throws(()=>verifyBootstrapWorkingTree(root,g,'before-deploy'));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('signed app entitlements bind distribution identity to the intended app',()=>{
 const valid={'application-identifier':`HCDUXX4Z3X.${BUNDLE}`,'com.apple.developer.team-identifier':'HCDUXX4Z3X','get-task-allow':false};
 validateBootstrapSigningEntitlements(valid);
 for(const changed of [{...valid,'application-identifier':`HCDUXX4Z3X.other`},{...valid,'com.apple.developer.team-identifier':'OTHERTEAM'}, {...valid,'get-task-allow':true},{}]) assert.throws(()=>validateBootstrapSigningEntitlements(changed));
});

test('Apple profile Data and Date parse, and only its listed signing certificate is accepted',()=>{
 const bytes=execFileSync('python3',['-c','import plistlib,datetime,sys;sys.stdout.buffer.write(plistlib.dumps({"DeveloperCertificates":[b"distribution-certificate"],"ExpirationDate":datetime.datetime(2027,1,1)},fmt=plistlib.FMT_BINARY))']);
 const profile=readBootstrapPlist(bytes);
 assert.equal(profile.ExpirationDate,'2027-01-01T00:00:00');
 validateBootstrapProfileSigner(profile,Buffer.from('distribution-certificate'));
 assert.throws(()=>validateBootstrapProfileSigner(profile,Buffer.from('development-certificate')));
 assert.throws(()=>validateBootstrapProfileSigner({},Buffer.from('certificate')));
 assert.throws(()=>readBootstrapPlist(Buffer.from('invalid profile')));
});

test('human approval binds the exact proposal bytes and rejects later edits',()=>{
 const proposal=Buffer.from('approved bounded proposal'),approval=Buffer.from(JSON.stringify({proposalSha256:bootstrapDigest(proposal)}));
 validateBootstrapApprovalProposal(approval,proposal);
 assert.throws(()=>validateBootstrapApprovalProposal(approval,Buffer.from('expanded scope')));
 assert.throws(()=>validateBootstrapApprovalProposal(Buffer.from('{}'),proposal));
});

import {generateKeyPairSync} from 'node:crypto';
import {bootstrapProvider} from '../scripts/release/internal-testflight-bootstrap.mjs';
// API의 include 없는 실제 links-only 응답을 모사한다. 실제 Cloud/기기 근거가 아니다.
const privateKeyBase64=Buffer.from(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'})).toString('base64');
function providerFetch(omit){
 const o=observation(),requested=[];
 const linksOnly=()=>({links:{related:'https://api.appstoreconnect.apple.com/v1/unexpanded'}});
 const fetchImpl=async input=>{
  const u=new URL(input);assert.equal(u.origin,'https://api.appstoreconnect.apple.com');requested.push(u.pathname+u.search);
  let data;
  if(u.pathname===`/v1/apps/${provider.appId}`)data=o.app;
  else if(u.pathname===`/v1/ciProducts/${provider.productId}`){data=o.product;if(u.searchParams.get('include')!=='app'||omit==='app')data.relationships.app=linksOnly();}
  else if(u.pathname===`/v1/ciWorkflows/${provider.workflowId}`){data=o.workflow;if(u.searchParams.get('include')!=='product'||omit==='product')delete data.relationships.product;}
  else if(u.pathname==='/v1/ciBuildRuns/build-1'){
   data=o.run;const includes=(u.searchParams.get('include')||'').split(',');
   for(const name of ['workflow','product','sourceBranchOrTag'])if(!includes.includes(name)||omit===`run.${name}`)data.relationships[name]=linksOnly();
  }else if(u.pathname===`/v1/ciWorkflows/${provider.workflowId}/buildRuns`)data=[{...structuredClone(o.run),relationships:{workflow:linksOnly(),product:linksOnly(),sourceBranchOrTag:linksOnly()}}];
  else if(u.pathname==='/v1/scmGitReferences/tag-1')data=o.tag;
  else assert.fail('unexpected provider path '+u.pathname);
  return{ok:true,status:200,json:async()=>({data,links:{next:null}})};
 };
 return{fetchImpl,requested};
}
const ciEnv={...env,APP_STORE_CONNECT_API_KEY_ID:'UHVPXA39JA',APP_STORE_CONNECT_ISSUER_ID:'synthetic-test-issuer',APP_STORE_CONNECT_PRIVATE_KEY_BASE64:privateKeyBase64,CI_TEAM_ID:'69a6de86-a179-47e3-e053-5b8c7c11a4d1',CI_XCODE_CLOUD:'TRUE',CI_PRODUCT_ID:provider.productId,CI_WORKFLOW_ID:provider.workflowId,CI_BUNDLE_ID:BUNDLE,CI_XCODE_SCHEME:'SpiritgateDefenders',CI_TAG:'v1.1.0',CI_COMMIT:SHA};
test('provider HTTP flow expands actual links-only Apple relationships before strict validation',async()=>{
 const f=providerFetch();const proof=await bootstrapProvider(grant,ciEnv,f.fetchImpl);assert.equal(proof.verified,true);assert.equal(proof.matchingBuildCount,1);assert.equal(proof.internalOnly,true);
});
for(const [omit,code] of [['app','TESTFLIGHT_APPLE_PRODUCT'],['product','TESTFLIGHT_APPLE_PRODUCT'],['run.workflow','TESTFLIGHT_APPLE_FIRST_BUILD'],['run.product','TESTFLIGHT_APPLE_FIRST_BUILD'],['run.sourceBranchOrTag','TESTFLIGHT_PROVIDER_TAG']])test('expanded provider flow still rejects missing relationship '+omit,async()=>{
 const f=providerFetch(omit);await assert.rejects(bootstrapProvider(grant,ciEnv,f.fetchImpl),{message:code});
});

for(const team of ['HCDUXX4Z3X','00000000-0000-0000-0000-000000000000',undefined])test('CI account namespace rejects '+team,async()=>{const f=providerFetch();await assert.rejects(bootstrapProvider(grant,{...ciEnv,CI_TEAM_ID:team},f.fetchImpl),{message:'TESTFLIGHT_CI_CONTEXT'});assert.equal(f.requested.length,0);});

import {validateCloud12FailedRun} from '../scripts/release/internal-testflight-bootstrap.mjs';
const failedLog=Buffer.from('synthetic prearchive context failure log; no actual observation');
function recoveryObservation(){
 const o=observation();o.run.attributes.number=13;const previous=structuredClone(o.run);previous.id='failed-12';Object.assign(previous.attributes,{number:12,completionStatus:'FAILED',executionProgress:'COMPLETE',finishedDate:'2026-10-14T05:58:00Z'});
 o.runs=[structuredClone(previous),structuredClone(o.run)];
 const recovery={approvalFile:'docs/design/2026-10-16-spiritgate-cloud12-recovery/approval.json',approvalSha256:'c'.repeat(64),additionalCloudAttempts:1,totalCloudAttemptLimit:2,totalUploadLimit:1,expectedBuildNumber:13,previousRun:{id:previous.id,number:12,finishedAt:previous.attributes.finishedDate,tagReferenceId:'tag-1',archiveActionId:'archive-12',logArtifactId:'log-12',logZipSha256:bootstrapDigest(failedLog)}};
 const failed={run:previous,builds:[],actions:[{id:'archive-12',attributes:{actionType:'ARCHIVE',completionStatus:'FAILED',executionProgress:'COMPLETE'}},{id:'test-12',attributes:{actionType:'TEST',completionStatus:'SKIPPED',executionProgress:'COMPLETE'}}],artifacts:[{id:'log-12',attributes:{fileType:'LOG_BUNDLE',fileSize:failedLog.length}}],logBytes:failedLog};
 return{o,failed,g:{...grant,cloud12Recovery:recovery},e:{...env,CI_BUILD_NUMBER:'13'}};
}
test('exact approved failed12 remains counted alongside new13',()=>{const f=recoveryObservation();f.o.failedRunProof=validateCloud12FailedRun(f.failed,f.g);const p=validate(f.o,f.g,f.e);assert.equal(p.matchingBuildCount,2);assert.equal(p.previousFailedRunId,'failed-12');assert.equal(p.recoveryVerified,true);});
for(const [name,change] of [
 ['wrong previous ID',f=>{f.failed.run.id='other';}],['wrong source',f=>{f.failed.run.attributes.sourceCommit.commitSha='b'.repeat(40);}],
 ['wrong workflow',f=>{f.failed.run.relationships.workflow.data.id='other';}],['wrong product',f=>{f.failed.run.relationships.product.data.id='other';}],
 ['running previous',f=>{f.failed.run.attributes.executionProgress='RUNNING';}],['successful previous',f=>{f.failed.run.attributes.completionStatus='SUCCEEDED';}],
 ['changed finish time',f=>{f.failed.run.attributes.finishedDate='2026-10-14T05:59:00Z';}],['existing uploaded build',f=>{f.failed.builds.push({id:'uploaded'});}],
 ['actual archive',f=>{f.failed.artifacts.push({id:'archive',attributes:{fileType:'ARCHIVE'}});}],['wrong log bytes',f=>{f.failed.logBytes=Buffer.from('changed');}],
 ['another log asset',f=>{f.failed.artifacts[0].id='another';}],['archive succeeded',f=>{f.failed.actions[0].attributes.completionStatus='SUCCEEDED';}],
 ['non-skipped post action',f=>{f.failed.actions[1].attributes.completionStatus='SUCCEEDED';}],
 ])test('recovery rejects '+name,()=>{const f=recoveryObservation();change(f);assert.throws(()=>validateCloud12FailedRun(f.failed,f.g),{message:'TESTFLIGHT_CLOUD12_FAILED_RUN'});});
for(const [name,change] of [
 ['unverified failed history',f=>{delete f.o.failedRunProof;}],['third source run',f=>{f.o.runs.push({...structuredClone(f.o.run),id:'third'});}],
 ['wrong new number',f=>{f.o.run.attributes.number=14;f.e.CI_BUILD_NUMBER='14';}],['previous missing from list',f=>{f.o.runs.shift();}],
 ['duplicate current run',f=>{f.o.runs[0]=structuredClone(f.o.run);}],
 ])test('recovery cannot hide '+name,()=>{const f=recoveryObservation();f.o.failedRunProof=validateCloud12FailedRun(f.failed,f.g);change(f);assert.throws(()=>validate(f.o,f.g,f.e),{message:'TESTFLIGHT_APPLE_FIRST_BUILD'});});

function recoveryFetch(change=()=>{}){
 const f=recoveryObservation(),requested=[];change(f);const recovery=f.g.cloud12Recovery;
 const fetchImpl=async(input,options={})=>{
  const u=new URL(input);requested.push({origin:u.origin,path:u.pathname,authorizationPresent:!!options.headers?.Authorization,redirect:options.redirect});
  if(u.origin==='https://cvws.icloud-content.com'){
   assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');
   return{ok:true,arrayBuffer:async()=>Uint8Array.from(f.failed.logBytes).buffer};
  }
  assert.equal(u.origin,'https://api.appstoreconnect.apple.com');assert.match(options.headers.Authorization,/^Bearer /u);
  let data;
  if(u.pathname===`/v1/apps/${provider.appId}`)data=f.o.app;
  else if(u.pathname===`/v1/ciProducts/${provider.productId}`){assert.equal(u.searchParams.get('include'),'app');data=f.o.product;}
  else if(u.pathname===`/v1/ciWorkflows/${provider.workflowId}`){assert.equal(u.searchParams.get('include'),'product');data=f.o.workflow;}
  else if(u.pathname==='/v1/ciBuildRuns/build-1'){assert.equal(u.searchParams.get('include'),'workflow,product,sourceBranchOrTag');data=f.o.run;}
  else if(u.pathname===`/v1/ciWorkflows/${provider.workflowId}/buildRuns`)data=f.o.runs.map(r=>({...r,relationships:{}}));
  else if(u.pathname==='/v1/scmGitReferences/tag-1')data=f.o.tag;
  else if(u.pathname===`/v1/ciBuildRuns/${recovery.previousRun.id}`){assert.equal(u.searchParams.get('include'),'workflow,product,sourceBranchOrTag');data=f.failed.run;}
  else if(u.pathname===`/v1/ciBuildRuns/${recovery.previousRun.id}/builds`)data=f.failed.builds;
  else if(u.pathname===`/v1/ciBuildRuns/${recovery.previousRun.id}/actions`)data=f.failed.actions;
  else if(u.pathname===`/v1/ciBuildActions/${recovery.previousRun.archiveActionId}/artifacts`)data=f.failed.artifacts.map(a=>({...a,attributes:{...a.attributes,downloadUrl:f.logUrl||'https://cvws.icloud-content.com/synthetic-signed-log'}}));
  else assert.fail('unexpected recovery provider path '+u.pathname);
  return{ok:true,status:200,json:async()=>({data,links:{next:null}})};
 };
 return{...f,fetchImpl,requested};
}
test('complete recovery HTTP flow reads exact failed run and log without forwarding credentials',async()=>{const f=recoveryFetch();const p=await bootstrapProvider(f.g,{...ciEnv,...f.e},f.fetchImpl);assert.equal(p.matchingBuildCount,2);assert.equal(p.previousFailedRunId,'failed-12');assert.equal(f.requested.filter(r=>r.origin==='https://cvws.icloud-content.com').length,1);});
for(const url of ['http://cvws.icloud-content.com/log','https://example.com/log','https://user@cvws.icloud-content.com/log','https://cvws.icloud-content.com/log#fragment'])test('recovery refuses unapproved artifact destination '+url,async()=>{const f=recoveryFetch(f=>{f.logUrl=url;});await assert.rejects(bootstrapProvider(f.g,{...ciEnv,...f.e},f.fetchImpl),{message:'TESTFLIGHT_CLOUD12_LOG_DOWNLOAD'});assert.equal(f.requested.some(r=>r.origin!=='https://api.appstoreconnect.apple.com'),false);});
test('recovery HTTP flow cannot skip existing uploaded builds or changed failure logs',async()=>{for(const change of [f=>{f.failed.builds=[{id:'uploaded'}];},f=>{f.failed.logBytes=Buffer.from('changed raw failure');}]){const f=recoveryFetch(change);await assert.rejects(bootstrapProvider(f.g,{...ciEnv,...f.e},f.fetchImpl),{message:'TESTFLIGHT_CLOUD12_FAILED_RUN'});}});
