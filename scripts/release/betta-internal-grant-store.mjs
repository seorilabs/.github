import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { githubJson, githubDownload, githubPaginate, resolveToken } from '../github-rest.mjs';
import { bettaDigest, validateBettaGrant } from './betta-internal-bootstrap.mjs';

const CENTRAL='seorilabs/.github',REPOSITORY='seorilabs/betta-raising';
const fail=code=>{throw new Error(code);};
const validClaim=new Ajv2020({allErrors:true}).compile(JSON.parse(readFileSync(new URL('../../contracts/betta-internal-bootstrap.schema.json',import.meta.url))));
export async function readBettaFile(repository,path,ref,request){
  if(![CENTRAL,REPOSITORY].includes(repository) || !/^[A-Za-z0-9_./-]+$/u.test(path) || path.split('/').includes('..')) fail('BETTA_REMOTE_PATH');
  const data=await githubJson(`/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,request);
  if(data.type!=='file' || data.encoding!=='base64' || data.size>2*1024*1024) fail('BETTA_REMOTE_FILE');
  return Buffer.from(data.content,'base64');
}

export async function readReviewedBettaGrant(id,request){
  if(!/^betta-[a-z0-9-]+$/u.test(id ?? '')) fail('BETTA_GRANT_ID');
  const policy=parse((await readBettaFile(CENTRAL,'contracts/development-workflow.yaml','main',request)).toString());
  const paths=policy.bettaInternalBootstrap?.grantRegistry;
  if(!Array.isArray(paths) || !paths.length) fail('BETTA_GRANT_NOT_REGISTERED');
  if(paths.some(path=>!/^contracts\/betta-internal-bootstrap\/[a-z0-9.-]+\.json$/u.test(path))) fail('BETTA_GRANT_REGISTRY');
  const documents=await Promise.all(paths.map(async path=>({path,bytes:await readBettaFile(CENTRAL,path,'main',request)})));
  const parsed=documents.map(d=>({...d,grant:JSON.parse(d.bytes)}));
  const matches=parsed.filter(d=>d.grant.id===id);
  if(matches.length!==1 || matches[0].grant.revoked) fail('BETTA_GRANT_NOT_REGISTERED');
  const found=matches[0],g=found.grant;
  validateBettaGrant(g);
  for(const target of g.targets){
    if(parsed.filter(d=>!d.grant.revoked && d.grant.repository===g.repository && d.grant.sourceSha===g.sourceSha && d.grant.releaseTag===g.releaseTag && d.grant.targets?.includes(target)).length!==1) fail('BETTA_OVERLAPPING_GRANT');
  }
  const comparison=await githubJson(`/repos/${CENTRAL}/compare/${g.verifierCommit}...main`,request);
  if(!['ahead','identical'].includes(comparison.status)) fail('BETTA_VERIFIER_NOT_REVIEWED');
  for(const path of ['scripts/release/betta-internal-bootstrap.mjs','scripts/release/betta-internal-grant-store.mjs','scripts/release/betta-internal-provider.mjs','scripts/release/betta-internal-execution.mjs','scripts/release/betta-internal-apple-artifact.mjs','scripts/release/betta-internal-retry-proof.mjs','scripts/release/betta-existing-aab-recovery.mjs','scripts/release/recover-betta-existing-aab.mjs','scripts/release/upload-google-play-aab.py','scripts/release/google_play_client.py','.github/workflows/betta-existing-aab-upload.yml','scripts/release/verify-development-evidence.mjs','scripts/release/tag-version-authority.mjs','scripts/release/read-google-play-version-codes.py','scripts/github-rest.mjs','contracts/release-version-authority.yaml','contracts/betta-internal-bootstrap.schema.json','contracts/betta-internal-bootstrap-grant.schema.json','package.json','package-lock.json','.github/workflows/godot-deploy-google-play.yml']){
    const reviewed=await readBettaFile(CENTRAL,path,g.verifierCommit,request);
    if(!reviewed.equals(readFileSync(new URL(`../../${path}`,import.meta.url)))) fail('BETTA_VERIFIER_CHANGED');
  }
  const [approval,inventory]=await Promise.all([
    readBettaFile(REPOSITORY,g.approvalFile,g.sourceSha,request),
    readBettaFile(REPOSITORY,'docs/qa/feature-inventory.json',g.sourceSha,request)]);
  if(bettaDigest(approval)!==g.approvalSha256 || bettaDigest(inventory)!==g.inventorySha256) fail('BETTA_APPROVAL_OR_INVENTORY_CHANGED');
  const a=JSON.parse(approval),proposal=await readBettaFile(REPOSITORY,g.proposalFile,a.proposalCommit,request);
  if(bettaDigest(proposal)!==g.proposalSha256 || a.proposalSha256!==g.proposalSha256 || a.approverKind!=='human'
    || a.appRegistrationApproved!==true || a.newAppSpecificSigningApproved!==true || a.pipelineAndCentralFirstInternalExceptionPreparationApproved!==true
    || a.objective!=='internal_available' || a.deviceUseByAgent!==false || a.publicRelease!==false || a.existingReviewFailuresMustRemain!==true) fail('BETTA_APPROVAL_SCOPE');
  return {...found,grantSha256:bettaDigest(found.bytes)};
}

export async function readBettaClaims(release,grant,target,request){
  const assets=await githubPaginate(`/repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`,request);
  const prefix=`${grant.id}.${target}.`;
  const claims=[];
  for(const asset of assets.filter(a=>a.name.startsWith(prefix) && a.name.endsWith('.json'))){
    if(asset.size>32768) fail('BETTA_CLAIM_SIZE');
    const bytes=await githubDownload(`/repos/${REPOSITORY}/releases/assets/${asset.id}`,request);
    const claim=JSON.parse(bytes);
    if(!validClaim(claim) || !Number.isFinite(Date.parse(claim.recordedAt)) || claim.id!==grant.id || claim.target!==target || claim.sourceSha!==grant.sourceSha || ![1,2].includes(claim.attempt)
      || !['before-build','before-deploy'].includes(claim.phase) || asset.name!==`${prefix}${claim.attempt}.${claim.phase}.json`) fail('BETTA_CLAIM_BINDING');
    claims.push({...claim,assetId:asset.id});
  }
  return claims;
}

// GitHub Release 자산 이름의 유일성을 원자적 claim으로 사용한다. 충돌 시 교체하지 않는다.
export async function createBettaClaim(release,claim,request){
  if(!validClaim(claim) || !Number.isFinite(Date.parse(claim.recordedAt))) fail('BETTA_INVALID_CLAIM');
  const name=`${claim.id}.${claim.target}.${claim.attempt}.${claim.phase}.json`;
  const url=new URL(release.upload_url.replace(/\{.*$/u,''));
  if(url.origin!=='https://uploads.github.com' || url.pathname!==`/repos/${REPOSITORY}/releases/${release.id}/assets`) fail('BETTA_CLAIM_UPLOAD_URL');
  url.searchParams.set('name',name);
  const response=await (request.fetchImpl ?? fetch)(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${resolveToken(request.token,request.env)}`,'content-type':'application/json','x-github-api-version':'2022-11-28'},body:JSON.stringify(claim)});
  if(response.status===422){
    const prior=(await readBettaClaims(release,{id:claim.id,sourceSha:claim.sourceSha},claim.target,request)).find(c=>c.attempt===claim.attempt && c.phase===claim.phase);
    if(!prior || prior.producer!==claim.producer || prior.grantSha256!==claim.grantSha256 || prior.configurationFingerprint!==claim.configurationFingerprint || prior.artifactSha256!==claim.artifactSha256
      || Date.parse(prior.recordedAt)>Date.parse(claim.recordedAt)) fail('BETTA_CLAIM_ALREADY_CONSUMED');
    return prior;
  }
  if(!response.ok) fail(`BETTA_CLAIM_WRITE_${response.status}`);
  return {...claim,assetId:(await response.json()).id};
}
