// Betta 0.1.0의 이미 생성된 AAB 한 개만 업로드한다. 빌드·서명 실행은 없다.
import {readFileSync,writeFileSync,realpathSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {githubJson,githubPaginate,githubDownload,resolveToken} from '../github-rest.mjs';
import {readReviewedBettaGrant,readBettaFile} from './betta-internal-grant-store.mjs';
import {bettaDigest,validateBettaAabRecoveryContext,verifyBettaSource,inspectBettaAab} from './betta-internal-bootstrap.mjs';
import {bettaConfigurationFingerprint} from './betta-internal-execution.mjs';
import {parseTagReceipt,computeAuthorityRevision} from './tag-version-authority.mjs';
const fail=code=>{throw new Error(code);};
const FIRST='betta-0-1-0-google-first-internal',SECOND=FIRST+'-r1';
export const recoverySlots=g=>({global:`${g.googlePlay.packageName}.${g.googlePlay.versionCode}.upload-intent.json`,fences:[`${FIRST}.google-play.1.before-deploy.json`,`${SECOND}.google-play.2.before-deploy.json`]});
export function assertRecoveryHistory(g,{runs,firstJobs,secondJobs,annotations}){
 const ids=g.existingAabRecovery.sourceRunIds;
 if(runs.length!==2 || !ids.every(id=>runs.some(r=>r.id===id)) || runs.some(r=>r.head_sha!==g.sourceSha || r.status!=='completed' || r.conclusion!=='failure' || r.run_attempt!==1 || r.event!=='workflow_dispatch' || r.path?.split('@')[0]!=='.github/workflows/deploy-google-play.yml'))fail('BETTA_RECOVERY_BUILD_HISTORY');
 const uploads=firstJobs.flatMap(j=>j.steps??[]).filter(s=>s.name==='Upload to Google Play');
 if(firstJobs.length!==1 || firstJobs[0].status!=='completed' || firstJobs[0].conclusion!=='failure' || uploads.length!==1 || uploads[0].conclusion!=='skipped')fail('BETTA_RECOVERY_FIRST_UPLOAD_UNKNOWN');
 const steps=secondJobs.flatMap(j=>j.steps??[]),named=name=>steps.filter(s=>s.name===name);
 if(secondJobs.length!==1 || secondJobs[0].status!=='completed' || secondJobs[0].conclusion!=='failure'
  || !annotations.some(a=>a.message?.startsWith('The self-hosted runner lost communication with the server.'))
  || named('Export signed Android AAB').length!==1 || !named('Export signed Android AAB')[0].started_at
  || ['Verify Editor E2E before-deploy','Upload to Google Play'].some(name=>named(name).length!==1 || named(name)[0].started_at!==null || named(name)[0].status!=='pending' || named(name)[0].conclusion!==null))fail('BETTA_RECOVERY_SECOND_UPLOAD_UNKNOWN');
}
export function assertRecoveryArtifact(g,a){
 const r=g.existingAabRecovery;
 if(a?.id!==r.sourceArtifactId || a.name!==r.sourceArtifactName || a.expired!==false || a.digest!==`sha256:${r.sourceArtifactArchiveSha256}`
  || a.workflow_run?.id!==r.sourceRunIds[0] || a.workflow_run.head_sha!==g.sourceSha || a.workflow_run.repository_id!==1455493296)fail('BETTA_RECOVERY_ARTIFACT_PROVIDER');
}
export function assertRecoveryProducer(g,run,env){
 const r=g.existingAabRecovery,retry=r.preflightRetry,attempt=retry?.allowedAttempt??1;
 if((retry && (run?.id!==retry.runId || run.workflow_id!==retry.workflowId)) || !Number.isSafeInteger(run?.workflow_id) || run.workflow_id<=0 || env.GITHUB_ACTIONS!=='true' || env.GITHUB_REPOSITORY!==g.repository || env.GITHUB_RUN_ATTEMPT!==String(attempt) || env.GITHUB_SHA!==r.uploaderCodeSha || env.GITHUB_REF!==`refs/tags/${r.uploadExecutionTag}`
  || String(run?.id)!==env.GITHUB_RUN_ID || run.head_sha!==r.uploaderCodeSha || run.event!=='push' || run.run_attempt!==attempt || run.status!=='in_progress'
  || run.repository?.full_name!==g.repository || run.repository.private!==true || run.path?.split('@')[0]!==r.workflowPath)fail('BETTA_RECOVERY_PRODUCER');
}
export function assertRecoveryPreflight(g,{run,jobs,log}){
 const r=g.existingAabRecovery,p=r.preflightRetry;
 if(!p || run?.id!==p.runId || run.workflow_id!==p.workflowId || run.run_attempt!==p.failedAttempt || run.status!=='completed' || run.conclusion!=='failure'
  || !run.referenced_workflows?.some(w=>w.path==='seorilabs/.github/.github/workflows/betta-existing-aab-upload.yml@main' && w.sha===p.originalReusableCommit)
  || run.head_sha!==r.uploaderCodeSha || run.event!=='push' || run.path?.split('@')[0]!==r.workflowPath
  || run.repository?.full_name!==g.repository || run.repository.private!==true || jobs.length!==1
  || jobs[0].id!==p.jobId || jobs[0].status!=='completed' || jobs[0].conclusion!=='failure'
  || jobs[0].steps?.filter(s=>s.name==='Verify and upload exact existing AAB' && s.status==='completed' && s.conclusion==='failure').length!==1
  || bettaDigest(log)!==p.rawJobLogSha256)fail('BETTA_RECOVERY_PREFLIGHT_PROOF');
}
export async function postUnique(release,name,document,request){
 const url=new URL(release.upload_url.replace(/\{.*$/u,''));
 if(url.origin!=='https://uploads.github.com' || url.pathname!==`/repos/seorilabs/betta-raising/releases/${release.id}/assets`)fail('BETTA_RECOVERY_UPLOAD_URL');
 url.searchParams.set('name',name);const bytes=Buffer.from(JSON.stringify(document));
 const response=await (request.fetchImpl??fetch)(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${resolveToken(request.token,request.env)}`,'content-type':'application/json','x-github-api-version':'2022-11-28'},body:bytes});
 if(response.status===422)fail('BETTA_UPLOAD_SLOT_CONSUMED');
 if(!response.ok)fail(`BETTA_UPLOAD_SLOT_WRITE_${response.status}`);
 const asset=await response.json();
 const observed=await githubDownload(`/repos/seorilabs/betta-raising/releases/assets/${asset.id}`,request);
 if(!observed.equals(bytes))fail('BETTA_UPLOAD_SLOT_READBACK');
 return {name,assetId:asset.id,sha256:bettaDigest(bytes)};
}
export async function reserveRecoveryUpload(g,release,identity,request){
 const slots=recoverySlots(g),binding={...identity,sourceSha:g.sourceSha,packageName:g.googlePlay.packageName,versionCode:g.googlePlay.versionCode,artifactSha256:g.existingAabRecovery.artifactSha256,recordedAt:new Date().toISOString()};
 const global=await postUnique(release,slots.global,{schemaVersion:1,kind:'betta-existing-aab-upload-intent',...binding},request),fences=[];
 // 이름 유일성이 늦은 old producer와 경쟁한다. 하나라도 충돌하면 실제 업로드하지 않는다.
 for(const name of slots.fences)fences.push(await postUnique(release,name,{schemaVersion:1,kind:'betta-recovery-upload-fence',...binding,globalUploadIntentAssetId:global.assetId},request));
 return {global,fences};
}
function emptyPlay(g,env){
 const doc=JSON.parse(execFileSync('python3',[fileURLToPath(new URL('./read-google-play-version-codes.py',import.meta.url)),'--package-name',g.googlePlay.packageName,'--api-timeout-seconds','30','--api-retries','0'],{env,stdio:['ignore','pipe','pipe'],timeout:60000}));
 if(doc.status!=='READY' || doc.packageName!==g.googlePlay.packageName || doc.maxVersionCode!==null || doc.bundleVersionCodes?.length!==0 || doc.apkVersionCodes?.length!==0 || !Array.isArray(doc.tracks) || doc.tracks.some(t=>t.versionCodes?.length!==0))fail('BETTA_RECOVERY_PLAY_NOT_EMPTY');
 return doc;
}
export async function recoverBettaExistingAab({id,env=process.env,fetchImpl=globalThis.fetch,report}){
 const request={env,fetchImpl},reviewed=await readReviewedBettaGrant(id,request),g=reviewed.grant,r=g.existingAabRecovery;
 if(!r)fail('BETTA_RECOVERY_REQUIRED');
 const retry=r.preflightRetry;
 if(g.originalObservationAssets.length!==(retry?10:9) || (retry && !g.originalObservationAssets.some(o=>o.name===retry.observationName)) || !g.originalObservationAssets.some(o=>o.name==='historical-first-native-build-failure.bd78bd9.json') || !g.originalObservationAssets.some(o=>o.name==='historical-second-runner-loss.bd78bd9.json'))fail('BETTA_RECOVERY_FAILURE_HISTORY_REQUIRED');
 const root=realpathSync(process.cwd());if(root!==realpathSync(join(env.GITHUB_WORKSPACE,'candidate')))fail('BETTA_RECOVERY_WORKSPACE');
 const current=await githubJson(`/repos/${g.repository}/actions/runs/${env.GITHUB_RUN_ID}`,request);assertRecoveryProducer(g,current,env);
 const producerRuns=await githubPaginate(`/repos/${g.repository}/actions/workflows/${current.workflow_id}/runs?head_sha=${r.uploaderCodeSha}&event=push&per_page=100`,{...request,select:d=>d.workflow_runs});
 if(!producerRuns.some(run=>run.id===current.id && run.run_attempt===current.run_attempt) || producerRuns.some(run=>run.id!==current.id && (run.run_attempt!==1 || run.status!=='completed' || !['failure','cancelled','timed_out'].includes(run.conclusion))))fail('BETTA_RECOVERY_PRODUCER_HISTORY');
 if(retry){
  const priorRun=await githubJson(`/repos/${g.repository}/actions/runs/${retry.runId}/attempts/${retry.failedAttempt}`,request);
  const priorJobs=await githubPaginate(`/repos/${g.repository}/actions/runs/${retry.runId}/attempts/${retry.failedAttempt}/jobs?per_page=100`,{...request,select:d=>d.jobs});
  const log=await githubDownload(`/repos/${g.repository}/actions/jobs/${retry.jobId}/logs`,{...request,accept:'application/vnd.github+json'});
  assertRecoveryPreflight(g,{run:priorRun,jobs:priorJobs,log});
  const bytes=await readBettaFile('seorilabs/.github',`contracts/betta-internal-bootstrap/${retry.originalGrantId}.json`,retry.originalGrantCommit,request);
  if(bettaDigest(bytes)!==retry.originalGrantSha256)fail('BETTA_RECOVERY_PREFLIGHT_GRANT');
  const previous=JSON.parse(bytes),currentBase={...g,existingAabRecovery:{...r}};
  delete currentBase.existingAabRecovery.preflightRetry;
  if(previous.verifierCommit!==retry.originalVerifierCommit)fail('BETTA_RECOVERY_PREFLIGHT_VERIFIER');
  for(const key of Object.keys(previous).filter(k=>!['id','verifierCommit','originalObservationAssets','revoked'].includes(k)))if(!isDeepStrictEqual(previous[key],currentBase[key]))fail('BETTA_RECOVERY_PREFLIGHT_SCOPE_CHANGED');
  for(const o of previous.originalObservationAssets)if(!g.originalObservationAssets.some(a=>a.name===o.name && a.sha256===o.sha256))fail('BETTA_RECOVERY_HISTORY_REMOVED');
  const old=JSON.parse(await readBettaFile('seorilabs/.github',`contracts/betta-internal-bootstrap/${retry.originalGrantId}.json`,'main',request));
  if(old.revoked!==true || old.sourceSha!==g.sourceSha)fail('BETTA_RECOVERY_OLD_ADMISSION_ACTIVE');
 }
 const uploaderRef=await githubJson(`/repos/${g.repository}/git/ref/tags/${r.uploadExecutionTag}`,request);
 if(uploaderRef.object?.type!=='tag')fail('BETTA_RECOVERY_ANNOTATED_EXECUTION_TAG');
 const uploaderTag=await githubJson(`/repos/${g.repository}/git/tags/${uploaderRef.object.sha}`,request);
 if(uploaderTag.tag!==r.uploadExecutionTag || uploaderTag.object?.type!=='commit' || uploaderTag.object.sha!==r.uploaderCodeSha)fail('BETTA_RECOVERY_EXECUTION_TAG_BINDING');
 const caller=await readBettaFile(g.repository,r.workflowPath,r.uploaderCodeSha,request);if(bettaDigest(caller)!==r.callerWorkflowSha256)fail('BETTA_RECOVERY_CALLER_CHANGED');
 const originalBytes=await readBettaFile('seorilabs/.github',`contracts/betta-internal-bootstrap/${FIRST}.json`,r.sourceGrantCommit,request);
 if(bettaDigest(originalBytes)!==r.sourceGrantSha256)fail('BETTA_RECOVERY_ORIGINAL_GRANT');
 const original=JSON.parse(originalBytes);
 for(const key of Object.keys(original).filter(k=>!['id','verifierCommit','originalObservationAssets','revoked'].includes(k)))if(!isDeepStrictEqual(original[key],g[key]))fail('BETTA_RECOVERY_SCOPE_CHANGED');
 for(const name of [FIRST,SECOND]){
  const old=JSON.parse(await readBettaFile('seorilabs/.github',`contracts/betta-internal-bootstrap/${name}.json`,'main',request));
  if(old.revoked!==true || old.sourceSha!==g.sourceSha)fail('BETTA_RECOVERY_OLD_ADMISSION_ACTIVE');
 }
 const fingerprint=bettaConfigurationFingerprint(root,g,'google-play');
 if(fingerprint!==g.configurationFingerprint)fail('BETTA_CONFIGURATION_CHANGED');
 verifyBettaSource(root,g,{phase:'before-build'}); // 새 원본 checkout 감사. 과거 빌드 작업트리 감사가 아니다.
 const ref=await githubJson(`/repos/${g.repository}/git/ref/tags/${g.releaseTag}`,request);if(ref.object.type!=='tag')fail('BETTA_RECOVERY_TAG');
 const tag=await githubJson(`/repos/${g.repository}/git/tags/${ref.object.sha}`,request),binding=parseTagReceipt(tag.message);
 const ledger=JSON.parse(await readBettaFile(g.repository,'release-version-ledger.json','release-version-ledger',request));
 const authority=computeAuthorityRevision(readFileSync(new URL('../../contracts/release-version-authority.yaml',import.meta.url),'utf8'));
 if(tag.object.type!=='commit' || tag.object.sha!==g.sourceSha || binding.authority!=='release-version-authority-v1' || binding.versionName!==g.releaseTag.slice(1) || binding.sourceSha!==g.sourceSha || binding.tag!==g.releaseTag || binding.authorityRevision!==authority || binding.androidVersionCodeSource!=='github-ledger' || Number(binding.androidVersionCode)!==g.googlePlay.versionCode
  || ledger.android.lastVersionCode!==g.googlePlay.versionCode || ledger.release.lastTag!==g.releaseTag || ledger.release.lastSourceSha!==g.sourceSha)fail('BETTA_RECOVERY_RELEASE_BINDING');
 const ci=await githubJson(`/repos/${g.repository}/actions/runs/${g.ciRunId}`,request);
 const ciAt=Date.parse(ci.updated_at);
 if(String(ci.id)!==g.ciRunId || ci.repository?.full_name!==g.repository || ci.head_sha!==g.sourceSha || ci.status!=='completed' || ci.conclusion!=='success' || ci.path?.split('@')[0]!=='.github/workflows/godot-checks.yml' || !Number.isFinite(ciAt) || ciAt>Date.now() || Date.now()-ciAt>168*3600000)fail('BETTA_CURRENT_CI_REQUIRED');
 const release=await githubJson(`/repos/${g.repository}/releases/tags/${g.releaseTag}`,request);
 if(release.id!==443379082)fail('BETTA_RECOVERY_RELEASE_ID');
 const assets=await githubPaginate(`/repos/${g.repository}/releases/${release.id}/assets?per_page=100`,request);
 const readAsset=async(name,sha)=>{
  const matches=assets.filter(a=>a.name===name);if(matches.length!==1 || matches[0].size>2*1024*1024)fail('BETTA_RECOVERY_ASSET');
  const bytes=await githubDownload(`/repos/${g.repository}/releases/assets/${matches[0].id}`,request);if(bettaDigest(bytes)!==sha)fail('BETTA_RECOVERY_ASSET_CHANGED');return bytes;
 };
 if(assets.some(a=>a.name===recoverySlots(g).global || /\.google-play\.[12]\.before-deploy\.json$/u.test(a.name)))fail('BETTA_RECOVERY_PRIOR_UPLOAD_INTENT');
 await readAsset('development-evidence.google-play.before-build.json',g.evidenceSha256);
 for(const o of g.originalObservationAssets)await readAsset(o.name,o.sha256);
 for(const o of original.originalObservationAssets)if(!g.originalObservationAssets.some(a=>a.name===o.name && a.sha256===o.sha256))fail('BETTA_RECOVERY_HISTORY_REMOVED');
 const claims=[JSON.parse(await readAsset(`${FIRST}.google-play.1.before-build.json`,r.firstBuildClaimSha256)),JSON.parse(await readAsset(`${SECOND}.google-play.2.before-build.json`,r.secondBuildClaimSha256))];
 for(const [i,c] of claims.entries())if(c.sourceSha!==g.sourceSha || c.attempt!==i+1 || c.producer!==`github:${r.sourceRunIds[i]}:1` || c.phase!=='before-build' || c.configurationFingerprint!==fingerprint)fail('BETTA_RECOVERY_BUILD_CLAIM');
 const runs=await githubPaginate(`/repos/${g.repository}/actions/workflows/deploy-google-play.yml/runs?head_sha=${g.sourceSha}&event=workflow_dispatch&per_page=100`,{...request,select:d=>d.workflow_runs});
 const firstJobs=await githubPaginate(`/repos/${g.repository}/actions/runs/${r.sourceRunIds[0]}/attempts/1/jobs?per_page=100`,{...request,select:d=>d.jobs});
 const secondJobs=await githubPaginate(`/repos/${g.repository}/actions/runs/${r.sourceRunIds[1]}/attempts/1/jobs?per_page=100`,{...request,select:d=>d.jobs});
 const annotations=await githubPaginate(`/repos/${g.repository}/check-runs/${secondJobs[0]?.id}/annotations?per_page=100`,request);
 assertRecoveryHistory(g,{runs,firstJobs,secondJobs,annotations});
 const {verifyReleaseDevelopmentEvidence}=await import('./verify-development-evidence.mjs');let originalVerdict;
 try{await verifyReleaseDevelopmentEvidence({repository:g.repository,tag:g.releaseTag,sourceSha:g.sourceSha,target:'google-play',phase:'before-deploy',env,fetchImpl,playTrack:'internal',playOperation:'upload'});originalVerdict={ok:true,errors:[]};}
 catch(error){originalVerdict={ok:false,errors:error.message.split('\n')};}
 const decision=validateBettaAabRecoveryContext(g,{repository:g.repository,sourceSha:g.sourceSha,tag:g.releaseTag,configurationFingerprint:fingerprint,target:'google-play',phase:'before-deploy',playTrack:'internal',playOperation:'upload'},originalVerdict);
 const artifact=await githubJson(`/repos/${g.repository}/actions/artifacts/${r.sourceArtifactId}`,request);assertRecoveryArtifact(g,artifact);
 const zip=await githubDownload(`/repos/${g.repository}/actions/artifacts/${r.sourceArtifactId}/zip`,{...request,accept:'application/vnd.github+json'});if(bettaDigest(zip)!==r.sourceArtifactArchiveSha256)fail('BETTA_RECOVERY_ARCHIVE_DIGEST');
 const temp=mkdtempSync(join(env.RUNNER_TEMP??tmpdir(),'betta-existing-aab-')),archive=join(temp,'artifact.zip'),aab=join(temp,'betta-raising.aab');writeFileSync(archive,zip,{flag:'wx'});
 execFileSync('python3',['-c',"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n n=z.namelist();assert n==['betta-raising.aab'];i=z.getinfo(n[0]);assert i.file_size==114386125;open(sys.argv[2],'xb').write(z.read(n[0]))",archive,aab]);
 const inspected=inspectBettaAab(aab,g);if(inspected.sha256!==r.artifactSha256 || readFileSync(aab).length!==r.artifactSize)fail('BETTA_RECOVERY_AAB_DIGEST');
 const notes=await readAsset('release-notes.json',r.releaseNotesSha256),notesPath=join(temp,'release-notes.json');writeFileSync(notesPath,notes,{flag:'wx'});
 emptyPlay(g,env);
 const live=await readReviewedBettaGrant(id,request);if(live.grantSha256!==reviewed.grantSha256)fail('BETTA_RECOVERY_GRANT_CHANGED');
 const producer=`github:${current.id}:${current.run_attempt}`;
 const reservation=await reserveRecoveryUpload(g,release,{producer,grantSha256:reviewed.grantSha256},request);
 // 두 이전 admission을 원자적으로 막았다. 예약 뒤 요청은 자동 재시도하지 않는다.
 const market=emptyPlay(g,env);
 const receipt={...decision,scope:'betta_existing_aab_upload_only',producer,runAttempt:current.run_attempt,artifactSourceSha:g.sourceSha,uploaderCodeSha:r.uploaderCodeSha,artifactSourceRunId:r.sourceRunIds[0],priorPhysicalBuildRunIds:r.sourceRunIds,additionalGameBuilds:0,fullWorkingTreeAuditPassed:false,originalSourceAuditStatus:r.sourceAuditStatus,sourceVerificationMode:'fresh-original-checkout-and-immutable-provider-artifact',artifact:inspected,reservation,marketBeforeUpload:market};
 writeFileSync(report,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 const result=spawnSync('python3',[fileURLToPath(new URL('./upload-google-play-aab.py',import.meta.url)),'--package-name',g.googlePlay.packageName,'--aab-path',aab,'--expected-aab-sha256',r.artifactSha256,'--expected-version-code',String(g.googlePlay.versionCode),'--track','internal','--release-status','completed','--release-name','Betta Atelier 0.1.0 (1)','--release-notes-json',notesPath,'--api-timeout-seconds','120','--api-retries','0'],{env,stdio:'inherit',timeout:600000});
 if(result.status!==0)fail('BETTA_RECOVERY_UPLOAD_FAILED_OR_UNKNOWN');
 return {...receipt,uploadCommand:'succeeded; provider availability still requires readback'};
}
