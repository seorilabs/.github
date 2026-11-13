import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appleCertificateArguments} from '../scripts/release/betta-internal-apple-artifact.mjs';
import {assertIpaHistory,assertIpaArtifact,reserveIpaUpload,IPA_RECOVERY,assertIpaUploadCredentials} from '../scripts/release/betta-existing-ipa-recovery.mjs';
import {validateBettaInternalContext,validateBettaIpaRecoveryContext} from '../scripts/release/betta-internal-bootstrap.mjs';

test('codesign prefix is an option value, never another input file',()=>{
 assert.deepEqual(appleCertificateArguments('/tmp/certificate-','/tmp/BettaAtelier.app'),['--display','--extract-certificates=/tmp/certificate-','/tmp/BettaAtelier.app']);
});
const g=JSON.parse(readFileSync(new URL('../contracts/betta-internal-bootstrap/betta-0-1-1-apple-sdk-download-recovery.json',import.meta.url)));
test('upload-only recovery cannot grant a new Cloud build or waive new failures',()=>{
 const grant={...g,revoked:false,existingIpaRecovery:IPA_RECOVERY},context={repository:g.repository,sourceSha:g.sourceSha,tag:g.releaseTag,configurationFingerprint:g.configurationFingerprint,target:'app-store',phase:'before-deploy',now:'2026-11-13T05:00:00Z'},verdict={ok:false,errors:['THREE_UI_ROUNDS_REQUIRED']};
 assert.equal(validateBettaIpaRecoveryContext(grant,context,verdict).nativeQaWaived,false);
 assert.throws(()=>validateBettaInternalContext(grant,context,verdict),/BETTA_UPLOAD_ONLY_REQUIRED/);
 assert.throws(()=>validateBettaIpaRecoveryContext(grant,{...context,phase:'before-build'},verdict),/BETTA_UPLOAD_ONLY_REQUIRED/);
 assert.throws(()=>validateBettaIpaRecoveryContext(grant,context,{ok:false,errors:['CI_RUN_UNVERIFIED']}),/BETTA_ORIGINAL_VERDICT_MISMATCH/);
 assert.throws(()=>validateBettaIpaRecoveryContext(grant,{...context,now:g.expiresAt},verdict),/BETTA_EXPIRED/);
});
test('altool key must exist in its supported custom directory and match the API reader',()=>{
 const temp=mkdtempSync(join(tmpdir(),'betta-ipa-key-test-'));
 try{
  const env={APP_STORE_CONNECT_API_KEY_ID:'UHVPXA39JA',APP_STORE_CONNECT_ISSUER_ID:'fixture',API_PRIVATE_KEYS_DIR:temp,APP_STORE_CONNECT_PRIVATE_KEY_BASE64:Buffer.from('fixture-key').toString('base64')};
  assert.throws(()=>assertIpaUploadCredentials(env));
  const file=join(temp,'AuthKey_UHVPXA39JA.p8');writeFileSync(file,'fixture-key');assert.doesNotThrow(()=>assertIpaUploadCredentials(env));
  writeFileSync(file,'other-key');assert.throws(()=>assertIpaUploadCredentials(env),/BETTA_APPLE_UPLOAD_KEY_MISMATCH/);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
const run=(id,n,sha)=>({id,attributes:{number:n,sourceCommit:{commitSha:sha},executionProgress:'COMPLETE',completionStatus:'FAILED',startReason:'MANUAL',isPullRequestBuild:false},relationships:{workflow:{data:{id:g.appStore.workflowId}},product:{data:{id:g.appStore.productId}},sourceBranchOrTag:{data:{id:IPA_RECOVERY.sourceTagId}}}});
const fixture=()=>({runs:IPA_RECOVERY.runs.map((id,i)=>run(id,i+1,i===2?g.sourceSha:IPA_RECOVERY.previousSourceSha)),actions:[{id:IPA_RECOVERY.archiveActionId,attributes:{actionType:'ARCHIVE',executionProgress:'COMPLETE',completionStatus:'FAILED'}},{id:IPA_RECOVERY.postActionId,attributes:{actionType:'TEST',executionProgress:'COMPLETE',completionStatus:'SKIPPED',startedDate:null}}],builds:[],uploads:[],workflow:{id:g.appStore.workflowId,attributes:{isEnabled:false}}});
test('only the three completed failed runs, disabled workflow and absent uploads allow recovery',()=>{
 assert.doesNotThrow(()=>assertIpaHistory(g,fixture()));
 for(const mutate of [d=>d.runs.pop(),d=>d.runs.push(run('new',4,g.sourceSha)),d=>d.runs[2].attributes.sourceCommit.commitSha='a'.repeat(40),d=>d.runs[2].attributes.executionProgress='RUNNING',d=>d.actions[1].attributes.startedDate='2026-11-13T05:00Z',d=>d.workflow.attributes.isEnabled=true,d=>d.uploads.push({id:'pending'}),d=>d.builds.push({id:'valid'})]){
  const d=fixture();mutate(d);assert.throws(()=>assertIpaHistory(g,d));
 }
});
test('App Store export is distinct from xcarchive and development export',()=>{
 const a={id:IPA_RECOVERY.artifactId,attributes:{fileType:'ARCHIVE_EXPORT',fileName:'BettaAtelier 0.1.1 app-store.zip',fileSize:IPA_RECOVERY.archiveSize}};
 assert.doesNotThrow(()=>assertIpaArtifact(a));
 for(const change of [{id:'other'},{attributes:{...a.attributes,fileType:'ARCHIVE'}},{attributes:{...a.attributes,fileName:'BettaAtelier 0.1.1 development.zip'}},{attributes:{...a.attributes,fileSize:1}}])assert.throws(()=>assertIpaArtifact({...a,...change}));
});
test('an atomic immutable slot permits exactly one competing uploader and fences old consumers',async()=>{
 const assets=new Map();let n=1;
 const request={token:'fixture',fetchImpl:async(raw,init={})=>{
  const u=new URL(raw);
  if(u.hostname==='uploads.github.com'){
   const name=u.searchParams.get('name');if(assets.has(name))return new Response('{}',{status:422});
   const a={id:n++,bytes:Buffer.from(init.body)};assets.set(name,a);return Response.json({id:a.id},{status:201});
  }
  const a=[...assets.values()].find(a=>u.pathname.endsWith('/'+a.id));assert.ok(a);return new Response(a.bytes);
 }};
 const release={id:443800221,upload_url:'https://uploads.github.com/repos/seorilabs/betta-raising/releases/443800221/assets{?name,label}'};
 const results=await Promise.allSettled([reserveIpaUpload(g,release,{producer:'local:a'},request),reserveIpaUpload(g,release,{producer:'local:b'},request)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(assets.size,3);
 assert.equal([...assets.keys()][0],'com.seorilabs.bettaraising.0.1.1.3.upload-intent.json');
});
