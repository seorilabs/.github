import test from 'node:test';
import assert from 'node:assert/strict';
import {observeBettaGoogleBuilds} from '../scripts/release/betta-internal-provider.mjs';
import {chooseBettaAttempt} from '../scripts/release/betta-internal-bootstrap.mjs';
const grant={repository:'seorilabs/betta-raising',sourceSha:'a'.repeat(40),googlePlay:{workflowPath:'.github/workflows/deploy-google-play.yml'}};
const run=(id,patch={})=>({id,head_sha:grant.sourceSha,event:'workflow_dispatch',repository:{full_name:grant.repository},path:grant.googlePlay.workflowPath,run_attempt:1,status:'in_progress',conclusion:null,...patch});
const failed=id=>run(id,{status:'completed',conclusion:'failure'});
function observe(runs,claims=[],steps=[{name:'Upload to Google Play',conclusion:'skipped'}]){
 const calls=[];
 const fetchImpl=async raw=>{
  const u=new URL(raw);calls.push(u.pathname);
  if(u.pathname.endsWith('/actions/runs/200')) return Response.json(run(200));
  if(u.pathname.endsWith('/deploy-google-play.yml/runs'))return Response.json({workflow_runs:runs});
  if(u.pathname.endsWith('/100/attempts/1/jobs'))return Response.json({jobs:[{id:1,steps}]});
  throw new Error(`Unexpected API ${u.pathname}`);
 };
 return {calls,result:observeBettaGoogleBuilds(grant,{id:'200',phase:'before-build'},claims,{token:'fixture',fetchImpl})};
}
test('a revised namespace preserves the first physical failed build and allocates attempt two',async()=>{
 const {result,calls}=observe([run(200),failed(100)]);
 const value=await result;
 assert.equal(chooseBettaAttempt(value.attempts,value.producer),2);
 assert.equal(value.attempts[0].producer,'github:100:1');
 assert.ok(calls.some(p=>p.endsWith('/100/attempts/1/jobs')));
});
test('same second claim is idempotent and cannot be relabeled as attempt one',async()=>{
 const claim={phase:'before-build',producer:'github:200:1',attempt:2};
 const value=await observe([run(200),failed(100)],[claim]).result;
 assert.equal(chooseBettaAttempt(value.attempts,value.producer),2);
 await assert.rejects(observe([run(200),failed(100)],[{...claim,attempt:1}]).result,/BETTA_ATTEMPT_HISTORY_INVALID/u);
});
for(const conclusion of ['success','failure',null])test(`new grant cannot clear prior unknown upload ${conclusion}`,async()=>{
 await assert.rejects(observe([run(200),failed(100)],[],[{name:'Upload to Google Play',conclusion}]).result,/BETTA_PREVIOUS_UPLOAD_ACCEPTANCE_UNKNOWN/u);
});
test('missing or duplicate uploader steps cannot prove no upload',async()=>{
 for(const steps of [[],[{name:'Upload to Google Play',conclusion:'skipped'},{name:'Upload to Google Play',conclusion:'skipped'}]])
  await assert.rejects(observe([run(200),failed(100)],[],steps).result,/BETTA_PREVIOUS_UPLOAD_ACCEPTANCE_UNKNOWN/u);
});
test('physical third run, rerun and unresolved previous run are rejected',async()=>{
 await assert.rejects(observe([run(200),failed(100),failed(50)]).result,/BETTA_GOOGLE_BUILD_LIMIT/u);
 await assert.rejects(observe([run(200),{...failed(100),run_attempt:2}]).result,/BETTA_GOOGLE_BUILD_LIMIT/u);
 await assert.rejects(observe([run(200),run(100)]).result,/BETTA_PREVIOUS_ATTEMPT_UNRESOLVED/u);
 await assert.rejects(observe([run(200),run(300)]).result,/BETTA_PREVIOUS_ATTEMPT_UNRESOLVED/u);
});
test('first physical run still allocates attempt one',async()=>{
 const value=await observe([run(200)]).result;
 assert.equal(chooseBettaAttempt(value.attempts,value.producer),1);
});
