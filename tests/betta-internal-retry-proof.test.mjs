import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedBettaNoUpload} from '../scripts/release/betta-internal-retry-proof.mjs';
import {bettaDigest} from '../scripts/release/betta-internal-bootstrap.mjs';
const grant={id:'betta-first-internal',repository:'seorilabs/betta-raising',sourceSha:'a'.repeat(40)};
const claim={producer:'github:1:1',target:'google-play',grantSha256:'b'.repeat(64),assetId:5};
const log=Buffer.from('Fixture provider terminal log: upload never started.');
const proof={schemaVersion:1,kind:'reviewed-upload-never-started',repository:grant.repository,grantId:grant.id,grantSha256:claim.grantSha256,
  sourceSha:grant.sourceSha,target:claim.target,producer:claim.producer,beforeDeployClaimAssetId:5,logSha256:bettaDigest(log),jobId:'7',finding:'terminal failure before provider upload request'};
const content=bytes=>Response.json({type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64')});
test('a before-deploy intent is recoverable only with reviewed, provider-bound original failure evidence',async()=>{
  for(const tamper of [false,true]){
    const fetchImpl=async raw=>{
      const u=new URL(raw);
      if(u.pathname.endsWith('/contracts/development-workflow.yaml'))return content(Buffer.from('bettaInternalBootstrap:\n  retryRegistry: [contracts/betta-internal-bootstrap-retries/fixture.json]\n'));
      if(u.pathname.endsWith('/fixture.json'))return content(Buffer.from(JSON.stringify(proof)));
      if(u.pathname.endsWith('/actions/jobs/7/logs'))return new Response(tamper?'Changed provider log':log);
      throw new Error('Unexpected fixture endpoint');
    };
    const result=reviewedBettaNoUpload(grant,claim,{request:{token:'fixture',fetchImpl},googleJobs:[{id:7,conclusion:'failure'}],fetchImpl});
    if(tamper)await assert.rejects(result,/BETTA_RETRY_LOG_CHANGED/u);else assert.equal(await result,true);
  }
});
test('a submitted boolean or missing reviewed record cannot establish non-acceptance',async()=>{
  const fetchImpl=async()=>content(Buffer.from('bettaInternalBootstrap:\n  retryRegistry: []\n'));
  assert.equal(await reviewedBettaNoUpload(grant,claim,{request:{token:'fixture',fetchImpl},googleJobs:[{id:7,conclusion:'failure',verified:true,acceptedUpload:false}]}),false);
});
