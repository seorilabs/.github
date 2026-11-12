import { parse } from 'yaml';
import { githubDownload } from '../github-rest.mjs';
import { readBettaFile } from './betta-internal-grant-store.mjs';
import { bettaDigest } from './betta-internal-bootstrap.mjs';
const fail=code=>{throw new Error(code);};

// 요청 시작 뒤의 빈 목록은 미접수 증거가 아니다. 이미 admission을 통과한 실패는
// 실제 provider 원본 로그를 읽고 검토한 정확한 해시의 중앙 기록이 있을 때만 해소한다.
export async function reviewedBettaNoUpload(grant,claim,{request,googleJobs,appleActions,appleArtifacts,fetchImpl=fetch}){
  const policy=parse((await readBettaFile('seorilabs/.github','contracts/development-workflow.yaml','main',request)).toString());
  const registry=policy.bettaInternalBootstrap?.retryRegistry ?? [];
  if(!Array.isArray(registry) || registry.some(p=>!/^contracts\/betta-internal-bootstrap-retries\/[a-z0-9.-]+\.json$/u.test(p))) fail('BETTA_RETRY_REGISTRY');
  const proofs=await Promise.all(registry.map(async path=>JSON.parse(await readBettaFile('seorilabs/.github',path,'main',request))));
  const found=proofs.filter(p=>p.grantId===grant.id && p.producer===claim.producer && p.target===claim.target);
  if(found.length===0)return false;
  if(found.length!==1)fail('BETTA_RETRY_PROOF_AMBIGUOUS');
  const p=found[0];
  const allowed=['schemaVersion','kind','repository','grantId','grantSha256','sourceSha','target','producer','beforeDeployClaimAssetId','logSha256','jobId','actionId','artifactId','finding'];
  if(Object.keys(p).some(k=>!allowed.includes(k)) || p.schemaVersion!==1 || p.kind!=='reviewed-upload-never-started'
    || p.repository!==grant.repository || p.sourceSha!==grant.sourceSha || p.grantSha256!==claim.grantSha256
    || p.beforeDeployClaimAssetId!==claim.assetId || p.finding!=='terminal failure before provider upload request'
    || !/^[a-f0-9]{64}$/u.test(p.logSha256 ?? '')) fail('BETTA_RETRY_PROOF_BINDING');
  let bytes;
  if(claim.target==='google-play'){
    const job=googleJobs?.find(j=>String(j.id)===p.jobId);
    if(!job || !['failure','cancelled','timed_out'].includes(job.conclusion) || p.actionId!==undefined || p.artifactId!==undefined) fail('BETTA_RETRY_JOB');
    bytes=await githubDownload(`/repos/${grant.repository}/actions/jobs/${job.id}/logs`,request);
  }else{
    const action=appleActions?.find(a=>a.id===p.actionId);
    if(!action || action.attributes?.actionType!=='ARCHIVE' || action.attributes.executionProgress!=='COMPLETE'
      || !['FAILED','CANCELED','ERRORED'].includes(action.attributes.completionStatus) || p.jobId!==undefined) fail('BETTA_RETRY_ACTION');
    const artifacts=await appleArtifacts(action.id);
    const artifact=artifacts.find(a=>a.id===p.artifactId);
    if(!artifact || artifact.attributes?.fileType!=='LOG_BUNDLE' || !Number.isSafeInteger(artifact.attributes.fileSize)
      || artifact.attributes.fileSize<=0 || artifact.attributes.fileSize>64*1024*1024) fail('BETTA_RETRY_LOG');
    const url=new URL(artifact.attributes.downloadUrl);
    if(url.protocol!=='https:' || url.username || url.password) fail('BETTA_RETRY_LOG_URL');
    const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)fail('BETTA_RETRY_LOG_DOWNLOAD');
    bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length!==artifact.attributes.fileSize)fail('BETTA_RETRY_LOG_SIZE');
  }
  if(bytes.length>64*1024*1024 || bettaDigest(bytes)!==p.logSha256) fail('BETTA_RETRY_LOG_CHANGED');
  return true;
}
