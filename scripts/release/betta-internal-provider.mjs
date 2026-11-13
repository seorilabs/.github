import { githubJson, githubPaginate } from '../github-rest.mjs';
import { makeAppStoreConnectToken } from '../trigger-xcode-cloud.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reviewedBettaNoUpload } from './betta-internal-retry-proof.mjs';
const fail=code=>{throw new Error(code);};

export function validateBettaGoogleRun(run,grant,{phase,producerRunId}){
  if(String(run?.id)!==String(producerRunId) || run.head_sha!==grant.sourceSha || run.event!=='workflow_dispatch'
    || run.repository?.full_name!==grant.repository || run.path?.split('@')[0]!==grant.googlePlay.workflowPath
    || run.run_attempt!==1 || !(run.status==='in_progress' || (phase==='before-deploy' && run.status==='completed' && run.conclusion==='success'))) fail('BETTA_GOOGLE_PRODUCER');
  return {producer:`github:${run.id}:1`,id:String(run.id),state:run.status==='completed' ? 'succeeded':'in_progress',runAttempt:1};
}

export async function appleGet(path,env,fetchImpl){
  if(!/^\/v1\//u.test(path) || !env.APP_STORE_CONNECT_API_KEY_ID || !env.APP_STORE_CONNECT_ISSUER_ID || !env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64) fail('BETTA_APPLE_CREDENTIAL_REQUIRED');
  const token=makeAppStoreConnectToken({keyId:env.APP_STORE_CONNECT_API_KEY_ID,issuerId:env.APP_STORE_CONNECT_ISSUER_ID,privateKeyBase64:env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64});
  const response=await fetchImpl(`https://api.appstoreconnect.apple.com${path}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok) fail(`BETTA_APPLE_READ_${response.status}`);
  return response.json();
}
export async function appleList(path,env,fetchImpl){
  const data=[],seen=new Set();
  while(path){
    if(seen.has(path) || seen.size>=50) fail('BETTA_APPLE_PAGINATION');seen.add(path);
    const document=await appleGet(path,env,fetchImpl);
    if(!Array.isArray(document.data)) fail('BETTA_APPLE_LIST');
    data.push(...document.data);path=null;
    if(document.links?.next){
      const url=new URL(document.links.next,'https://api.appstoreconnect.apple.com');
      if(url.origin!=='https://api.appstoreconnect.apple.com') fail('BETTA_APPLE_PAGINATION_ORIGIN');
      path=url.pathname+url.search;
    }
  }
  return data;
}

export function validateBettaCloudRun({run,workflow,product,app,tag},grant,env){
  const g=grant.appStore,w=workflow?.attributes,action=w?.actions?.[0],r=run?.attributes;
  if(app?.id!==g.appId || app.attributes?.bundleId!==g.bundleId || product?.id!==g.productId || product.relationships?.app?.data?.id!==g.appId
    || workflow?.id!==g.workflowId || workflow.relationships?.product?.data?.id!==g.productId) fail('BETTA_APPLE_PRODUCT');
  if(w.isEnabled!==true || w.actions?.length!==1 || action.actionType!=='ARCHIVE' || action.platform!=='IOS'
    || action.scheme!==g.scheme || action.isRequiredToPass!==true || action.buildDistributionAudience!=='INTERNAL_ONLY'
    || !w.manualTagStartCondition || ['branchStartCondition','tagStartCondition','pullRequestStartCondition','scheduledStartCondition','manualBranchStartCondition','manualPullRequestStartCondition'].some(k=>w[k]!=null)) fail('BETTA_APPLE_INTERNAL_WORKFLOW');
  if(env.CI_XCODE_CLOUD!=='TRUE' || env.CI_TAG!==grant.releaseTag || env.CI_COMMIT!==grant.sourceSha || env.CI_WORKFLOW_ID!==g.workflowId
    || env.CI_PRODUCT_ID!==g.productId || env.CI_XCODE_SCHEME!==g.scheme || run?.id!==env.CI_BUILD_ID || String(r?.number)!==env.CI_BUILD_NUMBER
    || r.sourceCommit?.commitSha!==grant.sourceSha || r.startReason!=='MANUAL' || r.isPullRequestBuild!==false
    || run.relationships?.workflow?.data?.id!==g.workflowId || run.relationships?.product?.data?.id!==g.productId
    || !Number.isSafeInteger(r.number) || r.number<Number(g.initialBuildNumber) || r.number>=Number(g.initialBuildNumber)+2
    || tag?.attributes?.kind!=='TAG' || tag.attributes.name!==grant.releaseTag || tag.id!==run.relationships?.sourceBranchOrTag?.data?.id) fail('BETTA_APPLE_PRODUCER');
  return {producer:`xcode-cloud:${run.id}`,id:run.id,number:r.number,state:r.executionProgress==='COMPLETE' ? (r.completionStatus==='SUCCEEDED'?'succeeded':'failed'):'in_progress'};
}

export async function observeBettaGoogleBuilds(grant,{id,phase,fetchImpl=globalThis.fetch},claims,request){
    const run=await githubJson(`/repos/${grant.repository}/actions/runs/${id}`,request);
    const current=validateBettaGoogleRun(run,grant,{phase,producerRunId:id});
    const runs=await githubPaginate(`/repos/${grant.repository}/actions/workflows/deploy-google-play.yml/runs?head_sha=${grant.sourceSha}&event=workflow_dispatch&per_page=100`,{...request,select:d=>d.workflow_runs});
    const matching=runs.filter(r=>r.head_sha===grant.sourceSha && r.path?.split('@')[0]===grant.googlePlay.workflowPath);
    if(!matching.some(r=>String(r.id)===id) || matching.length>2 || matching.some(r=>r.run_attempt!==1)) fail('BETTA_GOOGLE_BUILD_LIMIT');
    const ordered=[...matching].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    if(new Set(ordered.map(r=>String(r.id))).size!==ordered.length || String(ordered.at(-1).id)!==id) fail('BETTA_PREVIOUS_ATTEMPT_UNRESOLVED');
    const ordinal=ordered.findIndex(r=>String(r.id)===id)+1;
    const buildClaims=claims.filter(c=>c.phase==='before-build');
    if(buildClaims.some(c=>!ordered.some((r,i)=>c.producer===`github:${r.id}:1` && c.attempt===i+1))) fail('BETTA_ATTEMPT_HISTORY_INVALID');
    const previous=[];
    // Source-wide provider history survives a reviewed grant-ID revision.
    for(const [i,prior] of ordered.slice(0,-1).entries()){
      if(prior.status!=='completed' || !['failure','cancelled','timed_out'].includes(prior.conclusion)) fail('BETTA_PREVIOUS_ATTEMPT_UNRESOLVED');
      const jobs=await githubPaginate(`/repos/${grant.repository}/actions/runs/${prior.id}/attempts/1/jobs?per_page=100`,{...request,select:d=>d.jobs});
      const uploadSteps=jobs.flatMap(j=>j.steps ?? []).filter(s=>s.name==='Upload to Google Play');
      const skipped=uploadSteps.length===1 && uploadSteps[0].conclusion==='skipped';
      const producer=`github:${prior.id}:1`;
      const intent=claims.find(c=>c.producer===producer && c.phase==='before-deploy');
      if(!skipped && (!intent || !await reviewedBettaNoUpload(grant,intent,{request,googleJobs:jobs,fetchImpl}))) fail('BETTA_PREVIOUS_UPLOAD_ACCEPTANCE_UNKNOWN');
      previous.push({attempt:i+1,producer,state:'failed',providerVerified:true,acceptedUpload:false});
    }
    const own=buildClaims.find(c=>c.producer===current.producer);
    if(own){
      if(own.attempt!==ordinal) fail('BETTA_ATTEMPT_HISTORY_INVALID');
      previous.push({attempt:own.attempt,producer:current.producer,state:current.state});
    }
    return {...current,attempts:previous.sort((a,b)=>a.attempt-b.attempt)};
}

export async function observeBettaProvider(grant,options,claims,request){
  const {target,phase,env=process.env,fetchImpl=globalThis.fetch}=options;
  if(target==='google-play'){
    let market;
    try{
      market=JSON.parse(execFileSync('python3',[fileURLToPath(new URL('./read-google-play-version-codes.py',import.meta.url)),
        '--package-name',grant.googlePlay.packageName,'--api-timeout-seconds','30','--api-retries','0'],{env,stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:1024*1024}));
    }catch{fail('BETTA_LIVE_PLAY_READBACK_REQUIRED');}
    if(market.kind!=='google-play-version-code-readback' || market.packageName!==grant.googlePlay.packageName || market.status!=='READY'
      || market.maxVersionCode!==null || market.bundleVersionCodes?.length!==0 || market.apkVersionCodes?.length!==0
      || !Array.isArray(market.tracks) || market.tracks.some(t=>t.versionCodes?.length!==0)) fail('BETTA_MARKET_ALREADY_HAS_BUILD');
    const id=options.producerRunId ?? env.GITHUB_RUN_ID;
    if(!/^[1-9][0-9]*$/u.test(id ?? '') || (phase==='before-build' && (env.GITHUB_ACTIONS!=='true' || env.GITHUB_RUN_ID!==id || env.GITHUB_RUN_ATTEMPT!=='1'))) fail('BETTA_GOOGLE_CI_REQUIRED');
    return observeBettaGoogleBuilds(grant,{id,phase,fetchImpl},claims,request);
  }
  if(target!=='app-store') fail('BETTA_PROVIDER_TARGET');
  const g=grant.appStore,id=env.CI_BUILD_ID;
  if(!/^[A-Za-z0-9-]+$/u.test(id ?? '')) fail('BETTA_CLOUD_CI_REQUIRED');
  const [accepted,uploads]=await Promise.all([
    appleList(`/v1/builds?filter[app]=${g.appId}&limit=200`,env,fetchImpl),appleList(`/v1/apps/${g.appId}/buildUploads?limit=200`,env,fetchImpl)]);
  if(accepted.length || uploads.length) fail('BETTA_MARKET_ALREADY_HAS_UPLOAD');
  const [runDoc,workflowDoc,productDoc,appDoc]=await Promise.all([
    appleGet(`/v1/ciBuildRuns/${id}?include=workflow,product,sourceBranchOrTag`,env,fetchImpl),appleGet(`/v1/ciWorkflows/${g.workflowId}?include=product`,env,fetchImpl),
    appleGet(`/v1/ciProducts/${g.productId}?include=app`,env,fetchImpl),appleGet(`/v1/apps/${g.appId}`,env,fetchImpl)]);
  const tag=runDoc.included?.find(x=>x.id===runDoc.data.relationships?.sourceBranchOrTag?.data?.id);
  const current=validateBettaCloudRun({run:runDoc.data,workflow:workflowDoc.data,product:productDoc.data,app:appDoc.data,tag},grant,env);
  if(current.state!=='in_progress' && !(phase==='before-deploy' && current.state==='succeeded')) fail('BETTA_APPLE_RUN_NOT_ACTIVE');
  const list=await appleGet(`/v1/ciWorkflows/${g.workflowId}/buildRuns?limit=200`,env,fetchImpl);
  if(list.links?.next) fail('BETTA_CLOUD_PAGINATION_REQUIRES_INSPECTION');
  const matching=list.data.filter(r=>r.attributes?.sourceCommit?.commitSha===grant.sourceSha);
  if(!matching.some(r=>r.id===id) || matching.length>2) fail('BETTA_CLOUD_BUILD_LIMIT');
  const previous=[];
  for(const claim of claims.filter(c=>c.phase==='before-build' && c.producer!==current.producer)){
    const prior=matching.find(r=>`xcode-cloud:${r.id}`===claim.producer);
    if(!prior || prior.attributes.executionProgress!=='COMPLETE' || !['FAILED','CANCELED','ERRORED'].includes(prior.attributes.completionStatus)) fail('BETTA_PREVIOUS_ATTEMPT_UNRESOLVED');
    const builds=await appleGet(`/v1/ciBuildRuns/${prior.id}/builds?limit=200`,env,fetchImpl);
    if(builds.data.length || builds.links?.next) fail('BETTA_PREVIOUS_UPLOAD_ACCEPTED_OR_UNKNOWN');
    const intent=claims.find(c=>c.producer===claim.producer && c.phase==='before-deploy');
    if(intent){
      const actions=await appleList(`/v1/ciBuildRuns/${prior.id}/actions?limit=200`,env,fetchImpl);
      if(!await reviewedBettaNoUpload(grant,intent,{request,appleActions:actions,
        appleArtifacts:actionId=>appleList(`/v1/ciBuildActions/${actionId}/artifacts?limit=200`,env,fetchImpl),fetchImpl})) fail('BETTA_PREVIOUS_UPLOAD_ACCEPTANCE_UNKNOWN');
    }
    previous.push({attempt:claim.attempt,producer:claim.producer,state:'failed',providerVerified:true,acceptedUpload:false});
  }
  const own=claims.find(c=>c.producer===current.producer && c.phase==='before-build');
  if(own) previous.push({attempt:own.attempt,producer:current.producer,state:current.state});
  return {...current,attempts:previous.sort((a,b)=>a.attempt-b.attempt)};
}
