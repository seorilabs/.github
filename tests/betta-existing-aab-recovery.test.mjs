import test from 'node:test';
import assert from 'node:assert/strict';
import {createBettaClaim} from '../scripts/release/betta-internal-grant-store.mjs';
import {recoverySlots,assertRecoveryHistory,assertRecoveryArtifact,assertRecoveryProducer,assertRecoveryPreflight,reserveRecoveryUpload} from '../scripts/release/betta-existing-aab-recovery.mjs';
const sha='bd78bd996987481d668185da815c6853c4e99a4b';
const grant={sourceSha:sha,repository:'seorilabs/betta-raising',googlePlay:{packageName:'com.seorilabs.bettaraising',versionCode:1},existingAabRecovery:{sourceRunIds:[43286867642,43292795874],uploaderCodeSha:'a'.repeat(40),workflowPath:'.github/workflows/recover-betta-google-play.yml',uploadExecutionTag:'betta-existing-aab-upload-0.1.0',sourceArtifactId:13975726650,sourceArtifactName:'godot-google-play-aab-0.1.0-1',sourceArtifactArchiveSha256:'b'.repeat(64)}};
const run=id=>({id,head_sha:sha,status:'completed',conclusion:'failure',event:'workflow_dispatch',run_attempt:1,path:'.github/workflows/deploy-google-play.yml'});
const job=steps=>({status:'completed',conclusion:'failure',steps});
const history=()=>({runs:grant.existingAabRecovery.sourceRunIds.map(run),firstJobs:[job([{name:'Upload to Google Play',conclusion:'skipped'}])],secondJobs:[job([{name:'Export signed Android AAB',status:'in_progress',conclusion:null,started_at:'2026-11-12T19:45:16Z'},{name:'Verify Editor E2E before-deploy',status:'pending',conclusion:null,started_at:null},{name:'Upload to Google Play',status:'pending',conclusion:null,started_at:null}])],annotations:[{message:'The self-hosted runner lost communication with the server.'}]});
test('recovery preserves runner-lost pending steps without calling them skipped',()=>{assertRecoveryHistory(grant,history());});
test('unknown or started uploader, third build, rerun and nonterminal source are rejected',()=>{
 for(const change of [h=>h.runs.push(run(3)),h=>h.runs[0].run_attempt=2,h=>h.runs[1].status='in_progress',h=>h.secondJobs[0].steps[2].started_at='2026-11-12T20:00:00Z',h=>h.secondJobs[0].steps[2].conclusion='success',h=>h.firstJobs[0].steps[0].conclusion='failure',h=>h.annotations=[]]){const h=history();change(h);assert.throws(()=>assertRecoveryHistory(grant,h));}
});
test('artifact identity is immutable by provider id, archive digest and original source run',()=>{
 const artifact={id:13975726650,name:grant.existingAabRecovery.sourceArtifactName,expired:false,digest:'sha256:'+'b'.repeat(64),workflow_run:{id:43286867642,head_sha:sha,repository_id:1455493296}};
 assertRecoveryArtifact(grant,artifact);
 for(const patch of [{id:1},{expired:true},{digest:'sha256:'+'c'.repeat(64)},{workflow_run:{id:2,head_sha:sha,repository_id:1455493296}}])assert.throws(()=>assertRecoveryArtifact(grant,{...artifact,...patch}));
});
test('upload producer code is separate from artifact source and cannot be a game-build rerun',()=>{
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:grant.repository,GITHUB_RUN_ID:'999',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),GITHUB_REF:'refs/tags/betta-existing-aab-upload-0.1.0'};
 const r={id:999,workflow_id:301,event:'push',repository:{full_name:grant.repository,private:true},head_sha:'a'.repeat(40),run_attempt:1,status:'in_progress',path:grant.existingAabRecovery.workflowPath};
 assertRecoveryProducer(grant,r,env);
 for(const patch of [{workflow_id:undefined},{workflow_id:0},{head_sha:sha},{run_attempt:2},{path:'.github/workflows/deploy-google-play.yml'},{status:'completed'}])assert.throws(()=>assertRecoveryProducer(grant,{...r,...patch},env));
 assert.throws(()=>assertRecoveryProducer(grant,r,{...env,GITHUB_ACTIONS:'false'}));
 assert.throws(()=>assertRecoveryProducer(grant,r,{...env,GITHUB_REF:'refs/tags/v0.1.0'}));
});
test('one global slot fences both old upload admissions, including a late old producer',async()=>{
 const assets=new Map();let next=1;
 const fetchImpl=async(raw,init={})=>{
  const u=new URL(raw);if(u.hostname==='uploads.github.com'){
   const name=u.searchParams.get('name');if(assets.has(name))return Response.json({}, {status:422});
   const a={id:next++,name,bytes:Buffer.from(init.body)};assets.set(name,a);return Response.json({id:a.id},{status:201});
  }
  if(u.pathname.endsWith('/assets'))return Response.json([...assets.values()].map(a=>({id:a.id,name:a.name,size:a.bytes.length})));
  const a=[...assets.values()].find(a=>u.pathname.endsWith('/assets/'+a.id));if(a)return new Response(a.bytes);
  throw new Error('unexpected request '+u.pathname);
 };
 const release={id:1,upload_url:'https://uploads.github.com/repos/seorilabs/betta-raising/releases/1/assets{?name,label}'};
 const result=await reserveRecoveryUpload(grant,release,{producer:'github:999:1',grantSha256:'d'.repeat(64)},{token:'fixture',fetchImpl});
 assert.equal(result.fences.length,2);assert.equal(assets.size,3);
 for(const name of recoverySlots(grant).fences){assert.equal(JSON.parse(assets.get(name).bytes).kind,'betta-recovery-upload-fence');}
 await assert.rejects(reserveRecoveryUpload({...grant,id:'another-id'},release,{producer:'github:1000:1',grantSha256:'e'.repeat(64)},{token:'fixture',fetchImpl}),/BETTA_UPLOAD_SLOT_CONSUMED/u);
 assert.equal(assets.size,3);
 const old={schemaVersion:1,kind:'betta-internal-claim',id:'betta-0-1-0-google-first-internal',target:'google-play',phase:'before-deploy',attempt:1,producer:'github:43286867642:1',sourceSha:sha,grantSha256:'a'.repeat(64),configurationFingerprint:'b'.repeat(64),artifactSha256:'c'.repeat(64),recordedAt:'2026-11-13T00:00:00Z'};
 await assert.rejects(createBettaClaim(release,old,{token:'fixture',fetchImpl}),/BETTA_CLAIM_BINDING/u);
 await assert.rejects(reserveRecoveryUpload(grant,release,{producer:'github:999:1',grantSha256:'d'.repeat(64)},{token:'fixture',fetchImpl}),/BETTA_UPLOAD_SLOT_CONSUMED/u);
});
test('an old intent winning the atomic fence race prevents recovery admission',async()=>{
 const globalName=recoverySlots(grant).global;
 let globalReserved=false,globalBytes;
 const fetchImpl=async(raw,init={})=>{
  const u=new URL(raw);
  if(u.hostname==='uploads.github.com'){
   if(u.searchParams.get('name')===globalName){globalReserved=true;globalBytes=Buffer.from(init.body);return Response.json({id:1},{status:201});}
   return Response.json({},{status:422});
  }
  if(u.pathname.endsWith('/assets/1'))return new Response(globalBytes);
  throw new Error('unexpected fixture');
 };
 await assert.rejects(reserveRecoveryUpload(grant,{id:1,upload_url:'https://uploads.github.com/repos/seorilabs/betta-raising/releases/1/assets'}, {producer:'github:999:1',grantSha256:'d'.repeat(64)}, {token:'fixture',fetchImpl}),/BETTA_UPLOAD_SLOT_CONSUMED/u);
 assert.equal(globalReserved,true);
});

test('partial fences and a stored POST with a lost response never retry or admit upload',async()=>{
 for(const failAt of [1,2,3]){
  const assets=new Map();let requests=0;
  const fetchImpl=async(raw,init={})=>{
   const u=new URL(raw);
   if(u.hostname==='uploads.github.com'){
    requests++;const id=requests,name=u.searchParams.get('name'),bytes=Buffer.from(init.body);assets.set(id,{name,bytes});
    if(requests===failAt)throw new Error('connection lost after storage');
    return Response.json({id},{status:201});
   }
   const a=assets.get(Number(u.pathname.split('/').at(-1)));return new Response(a.bytes);
  };
  await assert.rejects(reserveRecoveryUpload(grant,{id:1,upload_url:'https://uploads.github.com/repos/seorilabs/betta-raising/releases/1/assets'},{producer:'github:999:1',grantSha256:'d'.repeat(64)},{token:'fixture',fetchImpl}),/connection lost/u);
  assert.equal(requests,failAt);assert.equal(assets.size,failAt);
 }
});

test('upload-only workflow has no engine, Gradle, export or signing execution',async()=>{
 const {readFileSync}=await import('node:fs');const {parse}=await import('yaml');
 const w=parse(readFileSync(new URL('../.github/workflows/betta-existing-aab-upload.yml',import.meta.url),'utf8'));
 assert.equal(w.jobs['upload-existing']['runs-on'],'seorilabs-x64');
 assert.equal(w.jobs['upload-existing'].environment,'google-play');
 assert.match(w.jobs['upload-existing'].if,/github.run_id == '43309802883' && github.run_attempt == '2'/u);
 assert.equal(w.jobs['upload-existing'].steps.find(s=>s.name==='Verify and upload exact existing AAB').env.BETTA_EXISTING_AAB_ID,'betta-0-1-0-existing-aab-upload-only-preflight-r1');
 const steps=w.jobs['upload-existing'].steps;
 const commands=steps.filter(s=>s.run).map(s=>s.run).join('\n');
 assert.doesNotMatch(commands,/\bgodot\b|\bgradle[w]?\b|--export|genkey|prepare_android|keystore/iu);
 assert.match(commands,/node \.\.\/authority\/scripts\/release\/recover-betta-existing-aab\.mjs/u);
 assert.equal(steps[0].with.ref,'v0.1.0');assert.equal(steps[0].with.path,'candidate');
});

test('readonly preflight retry accepts only the fixed run attempt 2',()=>{
 const retry={runId:43309802883,failedAttempt:1,allowedAttempt:2,jobId:131502589080,workflowId:301,originalReusableCommit:'6'.repeat(40),rawJobLogSha256:'7b1c02bf73195e25ed1343f8e0cfabafdc0ce356106fd0511c16169cb215f1be'};
 const g={...grant,existingAabRecovery:{...grant.existingAabRecovery,preflightRetry:retry}};
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:g.repository,GITHUB_RUN_ID:String(retry.runId),GITHUB_RUN_ATTEMPT:'2',GITHUB_SHA:'a'.repeat(40),GITHUB_REF:'refs/tags/betta-existing-aab-upload-0.1.0'};
 const run={id:retry.runId,workflow_id:301,referenced_workflows:[{path:'seorilabs/.github/.github/workflows/betta-existing-aab-upload.yml@main',sha:'6'.repeat(40)}],event:'push',repository:{full_name:g.repository,private:true},head_sha:'a'.repeat(40),run_attempt:2,status:'in_progress',path:g.existingAabRecovery.workflowPath};
 assertRecoveryProducer(g,run,env);
 for(const patch of [{id:retry.runId+1},{run_attempt:1},{run_attempt:3}])assert.throws(()=>assertRecoveryProducer(g,{...run,...patch},env));
 assert.throws(()=>assertRecoveryProducer(g,run,{...env,GITHUB_RUN_ATTEMPT:'1'}));
});

test('preflight proof requires exact failed job and unmodified provider log bytes',async()=>{
 const {createHash}=await import('node:crypto');
 const log=Buffer.from('HTTP 415 Must accept application/json /actions/artifacts/13975726650/zip');
 const retry={runId:43309802883,failedAttempt:1,allowedAttempt:2,jobId:131502589080,workflowId:301,originalReusableCommit:'6'.repeat(40),rawJobLogSha256:createHash('sha256').update(log).digest('hex')};
 const g={...grant,existingAabRecovery:{...grant.existingAabRecovery,preflightRetry:retry}};
 const run={id:retry.runId,workflow_id:301,referenced_workflows:[{path:'seorilabs/.github/.github/workflows/betta-existing-aab-upload.yml@main',sha:'6'.repeat(40)}],event:'push',repository:{full_name:g.repository,private:true},head_sha:'a'.repeat(40),run_attempt:1,status:'completed',conclusion:'failure',path:g.existingAabRecovery.workflowPath};
 const jobs=[{id:retry.jobId,status:'completed',conclusion:'failure',steps:[{name:'Verify and upload exact existing AAB',status:'completed',conclusion:'failure'}]}];
 assertRecoveryPreflight(g,{run,jobs,log});
 for(const patch of [{run:{...run,conclusion:'success'}},{run:{...run,run_attempt:2}},{jobs:[{...jobs[0],id:1}]},{jobs:[{...jobs[0],steps:[{...jobs[0].steps[0],conclusion:'success'}]}]},{log:Buffer.concat([log,Buffer.from('changed')])}])assert.throws(()=>assertRecoveryPreflight(g,{run,jobs,log,...patch}));
});
