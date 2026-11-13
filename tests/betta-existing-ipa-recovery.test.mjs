import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {appleCertificateArguments} from '../scripts/release/betta-internal-apple-artifact.mjs';
import {assertIpaHistory,assertIpaArtifact,reserveIpaUpload,IPA_RECOVERY} from '../scripts/release/betta-existing-ipa-recovery.mjs';

test('codesign prefix is an option value, never another input file',()=>{
 assert.deepEqual(appleCertificateArguments('/tmp/certificate-','/tmp/BettaAtelier.app'),['--display','--extract-certificates=/tmp/certificate-','/tmp/BettaAtelier.app']);
});
const g=JSON.parse(readFileSync(new URL('../contracts/betta-internal-bootstrap/betta-0-1-1-apple-sdk-download-recovery.json',import.meta.url)));
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
