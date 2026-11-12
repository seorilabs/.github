import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import { validateBettaGoogleRun,validateBettaCloudRun,observeBettaProvider } from '../scripts/release/betta-internal-provider.mjs';
import { createBettaClaim,readReviewedBettaGrant } from '../scripts/release/betta-internal-grant-store.mjs';
import { bettaDigest,verifyBettaSource } from '../scripts/release/betta-internal-bootstrap.mjs';

const grant={repository:'seorilabs/betta-raising',sourceSha:'a'.repeat(40),releaseTag:'v0.1.0',googlePlay:{workflowPath:'.github/workflows/deploy-google-play.yml'},
  appStore:{appId:'123',bundleId:'com.seorilabs.bettaraising',productId:'product',workflowId:'workflow',scheme:'BettaAtelier',initialBuildNumber:'1'}};
const run=()=>({id:123,head_sha:grant.sourceSha,event:'workflow_dispatch',repository:{full_name:grant.repository},path:grant.googlePlay.workflowPath,run_attempt:1,status:'in_progress',conclusion:null});
test('actual Google producer binds source, repo, workflow and first run attempt',()=>{
  assert.equal(validateBettaGoogleRun(run(),grant,{phase:'before-build',producerRunId:'123'}).producer,'github:123:1');
  for(const patch of [{head_sha:'b'.repeat(40)},{event:'push'},{repository:{full_name:'seorilabs/other'}},{path:'.github/workflows/other.yml'},{run_attempt:2},{status:'completed',conclusion:'failure'}])
    assert.throws(()=>validateBettaGoogleRun({...run(),...patch},grant,{phase:'before-build',producerRunId:'123'}));
});
const cloud=()=>({run:{id:'run',attributes:{number:1,sourceCommit:{commitSha:grant.sourceSha},startReason:'MANUAL',isPullRequestBuild:false,executionProgress:'RUNNING'},relationships:{workflow:{data:{id:'workflow'}},product:{data:{id:'product'}},sourceBranchOrTag:{data:{id:'tag'}}}},
  workflow:{id:'workflow',relationships:{product:{data:{id:'product'}}},attributes:{isEnabled:true,manualTagStartCondition:{},actions:[{actionType:'ARCHIVE',platform:'IOS',scheme:'BettaAtelier',isRequiredToPass:true,buildDistributionAudience:'INTERNAL_ONLY'}]}},
  product:{id:'product',relationships:{app:{data:{id:'123'}}}},app:{id:'123',attributes:{bundleId:'com.seorilabs.bettaraising'}},tag:{id:'tag',attributes:{kind:'TAG',name:'v0.1.0'}}});
const cloudEnv=()=>({CI_XCODE_CLOUD:'TRUE',CI_TAG:'v0.1.0',CI_COMMIT:grant.sourceSha,CI_WORKFLOW_ID:'workflow',CI_PRODUCT_ID:'product',CI_XCODE_SCHEME:'BettaAtelier',CI_BUILD_ID:'run',CI_BUILD_NUMBER:'1'});
test('Apple requires internal-only manual-tag archive and real Cloud source',()=>{
  assert.equal(validateBettaCloudRun(cloud(),grant,cloudEnv()).producer,'xcode-cloud:run');
  for(const change of [d=>{d.workflow.attributes.actions[0].buildDistributionAudience='APP_STORE_ELIGIBLE';},d=>{d.workflow.attributes.branchStartCondition={};},d=>{d.run.attributes.sourceCommit.commitSha='b'.repeat(40);},d=>{d.run.attributes.number=3;}]){
    const value=cloud();change(value);assert.throws(()=>validateBettaCloudRun(value,grant,cloudEnv()));
  }
});
test('actual Apple API adapter reads sparse relationships and paginated buildUploads',async()=>{
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1',privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}}).privateKey;
  const env={...cloudEnv(),APP_STORE_CONNECT_API_KEY_ID:'fixture',APP_STORE_CONNECT_ISSUER_ID:'fixture',APP_STORE_CONNECT_PRIVATE_KEY_BASE64:Buffer.from(key).toString('base64')};
  for(const pending of [false,true]){
    const calls=[],value=cloud();
    const fetchImpl=async raw=>{
      const u=new URL(raw);calls.push(u.pathname+u.search);let data=[],included,links;
      if(u.pathname==='/v1/builds')data=[];
      else if(u.pathname==='/v1/apps/123/buildUploads'){
        if(!u.searchParams.has('cursor'))links={next:'https://api.appstoreconnect.apple.com/v1/apps/123/buildUploads?cursor=next'};
        else if(pending)data=[{id:'upload',type:'buildUploads',attributes:{state:'PROCESSING',cfBundleShortVersionString:'0.1.0',cfBundleVersion:'1'}}];
      }else if(u.pathname==='/v1/ciBuildRuns/run'){assert.equal(u.searchParams.get('include'),'workflow,product,sourceBranchOrTag');data=value.run;included=[value.tag];}
      else if(u.pathname==='/v1/ciWorkflows/workflow'){assert.equal(u.searchParams.get('include'),'product');data=value.workflow;}
      else if(u.pathname==='/v1/ciProducts/product'){assert.equal(u.searchParams.get('include'),'app');data=value.product;}
      else if(u.pathname==='/v1/apps/123')data=value.app;
      else if(u.pathname==='/v1/ciWorkflows/workflow/buildRuns')data=[value.run];
      else throw new Error('Unexpected fixture API '+u.pathname);
      return Response.json({data,...(included?{included}:{}),...(links?{links}:{})});
    };
    const result=observeBettaProvider(grant,{target:'app-store',phase:'before-build',env,fetchImpl},[],{token:'fixture',fetchImpl});
    if(pending)await assert.rejects(result,/BETTA_MARKET_ALREADY_HAS_UPLOAD/u);
    else assert.equal((await result).producer,'xcode-cloud:run');
    assert.ok(calls.includes('/v1/apps/123/buildUploads?cursor=next'));
  }
});
test('unregistered opt-in is rejected before any product build',async()=>{
  await assert.rejects(readReviewedBettaGrant('betta-first-internal',{token:'fixture-token',fetchImpl:async()=>new Response(JSON.stringify({type:'file',encoding:'base64',size:50,content:Buffer.from('bettaInternalBootstrap:\n  grantRegistry: []\n').toString('base64')}),{headers:{'content-type':'application/json'}})}),/BETTA_GRANT_NOT_REGISTERED/u);
});
test('atomic upload rejects competing producer and permits the same claim readback',async()=>{
  const assets=new Map();let next=1;
  const fetchImpl=async(raw,init={})=>{
    const url=new URL(raw);
    if(url.hostname==='uploads.github.com'){
      const name=url.searchParams.get('name');if(assets.has(name))return new Response('{}',{status:422});
      assets.set(name,{id:next++,name,bytes:Buffer.from(init.body)});return Response.json({id:next-1},{status:201});
    }
    if(url.pathname.endsWith('/assets')) return Response.json([...assets.values()].map(a=>({id:a.id,name:a.name,size:a.bytes.length})));
    const item=[...assets.values()].find(a=>url.pathname.endsWith(`/assets/${a.id}`));
    if(item)return new Response(item.bytes,{headers:{'content-type':'application/octet-stream'}});
    throw new Error(`unexpected fixture request ${url.pathname}`);
  };
  const release={id:1,upload_url:'https://uploads.github.com/repos/seorilabs/betta-raising/releases/1/assets{?name,label}'};
  const claim={schemaVersion:1,kind:'betta-internal-claim',configurationFingerprint:'c'.repeat(64),id:'betta-first-internal',target:'google-play',phase:'before-build',attempt:1,producer:'github:1:1',sourceSha:grant.sourceSha,grantSha256:'b'.repeat(64),recordedAt:'2026-11-13T00:00:00Z'};
  const request={token:'fixture-token',fetchImpl};
  const result=await Promise.allSettled([createBettaClaim(release,claim,request),createBettaClaim(release,{...claim,producer:'github:2:1'},request)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(assets.size,1);
  assert.equal((await createBettaClaim(release,claim,request)).producer,'github:1:1');
});
test('real checkout audit detects changed tracked bytes and ignored source injection',()=>{
  const root=mkdtempSync(join(tmpdir(),'betta-source-test-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:['ignore','pipe','pipe']});
  try{
    git('init');writeFileSync(join(root,'.gitignore'),'hidden/\n');writeFileSync(join(root,'source.gd'),'original\n');git('add','.');
    git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture');
    const g={sourceSha:git('rev-parse','HEAD').toString().trim()};g.productTreeSha256=bettaDigest(git('ls-tree','-r','-z',g.sourceSha));
    verifyBettaSource(root,g,{phase:'before-build'});
    writeFileSync(join(root,'source.gd'),'changed\n');assert.throws(()=>verifyBettaSource(root,g,{phase:'before-build'}),/BETTA_SOURCE_CHANGED/u);
    writeFileSync(join(root,'source.gd'),'original\n');mkdirSync(join(root,'hidden'));writeFileSync(join(root,'hidden','injected.gd'),'extends Node\n');
    assert.throws(()=>verifyBettaSource(root,g,{phase:'before-build'}),/BETTA_UNTRACKED_SOURCE/u);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Godot import metadata is generated only for the exact tracked input',()=>{
  const root=mkdtempSync(join(tmpdir(),'betta-import-test-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:['ignore','pipe','pipe']});
  try{
    git('init');mkdirSync(join(root,'godot'));writeFileSync(join(root,'godot','fish.png'),'tracked image fixture');writeFileSync(join(root,'godot','locale.csv'),'keys,en\nHELLO,Hello\n');git('add','.');
    git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture');
    const g={sourceSha:git('rev-parse','HEAD').toString().trim()};g.productTreeSha256=bettaDigest(git('ls-tree','-r','-z',g.sourceSha));
    const path=join(root,'godot','fish.png.import');
    writeFileSync(path,'[remap]\nimporter="texture"\npath="res://.godot/imported/fish.ctex"\n[deps]\nsource_file="res://fish.png"\n[params]\ncompress/mode=0\n');
    writeFileSync(join(root,'godot','locale.csv.import'),'[remap]\nimporter="csv_translation"\npath="res://locale.en.translation"\n[deps]\nsource_file="res://locale.csv"\n');
    writeFileSync(join(root,'godot','locale.en.translation'),'generated translation fixture');
    verifyBettaSource(root,g,{phase:'before-deploy'});
    writeFileSync(path,'[remap]\npath="res://hidden.gd"\n[deps]\nsource_file="res://fish.png"\n');
    assert.throws(()=>verifyBettaSource(root,g,{phase:'before-deploy'}),/BETTA_IMPORT_METADATA/u);
  }finally{rmSync(root,{recursive:true,force:true});}
});
