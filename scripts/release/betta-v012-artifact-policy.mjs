import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const ARTIFACT_APPROVAL='docs/design/2026-11-13-betta-v012-upload-recovery/approval.json';
const schema=JSON.parse(readFileSync(new URL('../../contracts/betta-internal-bootstrap-grant.schema.json',import.meta.url)));
export const V012_ARTIFACTS=Object.fromEntries(schema.properties.existingArtifactUpload.oneOf.map(x=>[x.const.target,x.const]));
const fail=code=>{throw new Error(code);};
const digest=b=>createHash('sha256').update(b).digest('hex');
export function assertV012Approval(a,proposal){
 if(a.approverKind!=='human' || a.userApprovalVerbatim!=='기존 산출물로 업로드 전용 복구 승인'
  || a.proposalCommit!=='653f2c08f2f55a17114a3dcc900cd31852502383'
  || a.proposalFile!=='docs/design/2026-11-13-betta-v012-upload-recovery/design.md' || digest(proposal)!==a.proposalSha256
  || a.sourceSha!=='a65470d2a67308d808a8a8f63583aa1e14cc435e' || a.tag!=='v0.1.2' || a.additionalNativeBuilds!==0
  || a.acceptedUploadLimitPerMarket!==1 || a.cumulativeAcceptedUploadLimitPerMarket!==2
  || a.cumulativeNativeBuilds?.['google-play']!==3 || a.cumulativeNativeBuilds?.['app-store']!==4
  || a.expiresAt!=='2026-11-19T15:35:59.411730+00:00' || a.originalWorkingTreeAndPostHookFailuresRemain!==true
  || a.deviceUseByAgent!==false || a.gameMainMerge!==false || a.publicRelease!==false || a.newCredentialsOrPaidPlans!==false
  || a.uploaderRuntime!=='reviewed-local-cli-no-native-build') fail('BETTA_V012_APPROVAL_SCOPE');
}
export function assertV012GoogleHistory(g,{runs,jobs,log}){
 const r=g.existingArtifactUpload,ids=[43286867642,43292795874,43431697154];
 if(runs.length!==3 || new Set(runs.map(x=>x.id)).size!==3 || ids.some(id=>!runs.some(x=>x.id===id))
  || runs.some(x=>x.status!=='completed' || x.conclusion!=='failure' || x.run_attempt!==1 || x.event!=='workflow_dispatch'
    || x.path?.split('@')[0]!=='.github/workflows/deploy-google-play.yml' || x.repository?.full_name!==g.repository
    || x.head_sha!==(x.id===r.sourceRunId?g.sourceSha:'bd78bd996987481d668185da815c6853c4e99a4b'))
  || jobs.length!==1 || jobs[0].id!==r.jobId || jobs[0].run_id!==r.sourceRunId || jobs[0].status!=='completed' || jobs[0].conclusion!=='failure') fail('BETTA_V012_GOOGLE_HISTORY');
 const steps=jobs[0].steps??[],is=(name,conclusion)=>steps.filter(s=>s.name===name && s.conclusion===conclusion).length===1;
 if(!is('Export signed Android AAB','success') || !is('Verify Editor E2E before-deploy','failure') || !is('Upload to Google Play','skipped')
  || digest(log)!==r.rawJobLogSha256 || !log.toString().includes('BETTA_UNTRACKED_SOURCE "tools/__pycache__/pinned_download.cpython-313.pyc"')) fail('BETTA_V012_GOOGLE_FAILURE_PROOF');
}
export function assertV012AppleHistory(g,{runs,actions,workflow}){
 const r=g.existingArtifactUpload,ids=['19199616-067d-4497-9289-4b9bb628f0aa','064ecfc0-bcbb-470a-8fe2-0348534a4b5b','845f07b9-5601-4e01-993c-e67285709dec',r.sourceRunId];
 if(workflow.id!==g.appStore.workflowId || workflow.attributes?.isEnabled!==false || runs.length!==4
  || new Set(runs.map(x=>x.id)).size!==4 || ids.some((id,i)=>!runs.some(x=>x.id===id && x.attributes?.number===i+1
   && x.attributes.sourceCommit?.commitSha===(i<2?'bd78bd996987481d668185da815c6853c4e99a4b':i===2?'706e1130de7d123bac68193821bf301ed9ad336e':g.sourceSha)
   && x.attributes.executionProgress==='COMPLETE' && x.attributes.completionStatus==='FAILED' && x.attributes.startReason==='MANUAL' && x.attributes.isPullRequestBuild===false
   && x.relationships?.workflow?.data?.id===g.appStore.workflowId && x.relationships?.product?.data?.id===g.appStore.productId
   && (i!==3 || x.relationships?.sourceBranchOrTag?.data?.id===r.sourceTagId)))
  || actions.length!==2 || !actions.some(x=>x.id===r.archiveActionId && x.attributes?.actionType==='ARCHIVE' && x.attributes.executionProgress==='COMPLETE' && x.attributes.completionStatus==='FAILED')
  || !actions.some(x=>x.id===r.postActionId && x.attributes?.actionType==='TEST' && x.attributes.executionProgress==='COMPLETE' && x.attributes.completionStatus==='SKIPPED' && x.attributes.startedDate===null)) fail('BETTA_V012_APPLE_HISTORY');
}
export function assertV012ProviderArtifact(g,a){
 const r=g.existingArtifactUpload;
 if(r.target==='google-play'){
  if(a.id!==r.sourceArtifactId || a.name!==r.sourceArtifactName || a.expired!==false || a.digest!==`sha256:${r.archiveSha256}`
   || a.workflow_run?.id!==r.sourceRunId || a.workflow_run.head_sha!==g.sourceSha || a.workflow_run.repository_id!==1455493296) fail('BETTA_V012_PROVIDER_ARTIFACT');
 }else if(a.id!==r.sourceArtifactId || a.attributes?.fileName!==r.sourceArtifactName || a.attributes.fileType!=='ARCHIVE_EXPORT' || a.attributes.fileSize!==r.archiveSize) fail('BETTA_V012_PROVIDER_ARTIFACT');
}
