// 첫 내부 TestFlight의 검수 시점만 옮긴다. 공개 출시·제품 E2E 통과 판정이 아니다.
import { readFileSync, lstatSync, readdirSync, readlinkSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { githubJson, githubPaginate, githubDownload } from '../github-rest.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { validateDevelopmentEvidence } from './verify-development-evidence.mjs';
export const bootstrapDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const sameIds = (a,b) => Array.isArray(a) && Array.isArray(b) && new Set(a).size === a.length && equal([...a].sort(),[...b].sort());
const SHA = /^[a-f0-9]{40}$/u, DIGEST = /^[a-f0-9]{64}$/u;
const REPO = 'seorilabs/spiritgate-defenders', TAG = 'v1.1.0', BUNDLE = 'com.seorilabs.spiritgatedefenders';
const PROVIDER = {appId:'6792205995',productId:'E5C1A24C-AA05-41B0-B2F6-F1BF0B92D7DB',workflowId:'45B83B98-ABE4-48C1-83FC-09CF3F79651E'};
const MAX_AGE = 168 * 3600000;
const ajv = new Ajv2020({allErrors:true});
const validGrant = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/internal-testflight-bootstrap-grant.schema.json',import.meta.url))));
const validDocument = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/internal-testflight-bootstrap.schema.json',import.meta.url))));

export function validateInternalTestflightBootstrapEvidence(document, context) {
  const errors=[];
  const reject = (condition,code) => {if (!condition) errors.push(code);};
  const {grant,providerProof:provider,now:at=new Date().toISOString()}=context;
  const now=Date.parse(at);
  if (!validDocument(document) || !validGrant(grant)) return {ok:false,errors:['TESTFLIGHT_BOOTSTRAP_REQUIRED']};
  reject(Number.isFinite(now),'TESTFLIGHT_TIME');
  reject(document.schemaVersion === 1 && document.scope === 'internal_testflight_only' && document.id === grant.id,'TESTFLIGHT_INTERNAL_SCOPE');
  reject(grant.schemaVersion === 1 && grant.kind === 'first-internal-testflight' && grant.revoked === false,'TESTFLIGHT_GRANT');
  reject(context.repository === REPO && grant.repository === REPO && grant.releaseTag === TAG && context.tag === TAG && grant.packageName === BUNDLE && context.target === 'app-store','TESTFLIGHT_SCOPE');
  reject(['before-build','before-deploy'].includes(context.phase),'TESTFLIGHT_PHASE');
  reject(SHA.test(context.sourceSha ?? '') && context.sourceSha === grant.sourceSha,'TESTFLIGHT_SOURCE');
  reject(DIGEST.test(context.configurationFingerprint ?? '') && context.configurationFingerprint === grant.configurationFingerprint,'TESTFLIGHT_CONFIGURATION');
  const approved=Date.parse(grant.approvedAt),expiry=Date.parse(grant.expiresAt);
  reject(approved <= now && now <= expiry && expiry > approved && expiry-approved <= MAX_AGE,'TESTFLIGHT_EXPIRED');
  for (const [key,bytes] of [['approvalSha256',context.approvalBytes],['inventorySha256',context.inventoryBytes],['evidenceSha256',context.evidenceBytes]]) {
    reject(Buffer.isBuffer(bytes) && DIGEST.test(grant[key] ?? '') && bootstrapDigest(bytes) === grant[key],`TESTFLIGHT_HASH_${key}`);
  }
  let approval,inventory,originalDocument;
  try {approval=JSON.parse(context.approvalBytes);inventory=JSON.parse(context.inventoryBytes);originalDocument=JSON.parse(context.evidenceBytes);} catch {errors.push('TESTFLIGHT_INVALID_JSON');}
  reject(equal(originalDocument,document),'TESTFLIGHT_EVIDENCE_CHANGED');
  reject(approval?.kind === 'human_testflight_timing_approval' && approval.repository === REPO && approval.version === '1.1.0'
    && approval.objective === 'first_internal_testflight_qa' && approval.candidateLimit === 1 && approval.buildUploadLimit === 1
    && approval.maxAgeHours === 168 && approval.approvalRecordedAt === grant.approvedAt && typeof approval.userApprovalVerbatim === 'string' && approval.userApprovalVerbatim.trim().length > 0
    && approval.iphoneQa === 'deferred until internal installation; not waived' && approval.newAppleResourcesAllowed === false
    && approval.publicReleaseRequires === 'normal validator, actual iPhone QA and whole E2E','TESTFLIGHT_HUMAN_APPROVAL_SCOPE');
  reject(inventory?.schemaVersion === 1 && inventory.features?.length === 28,'TESTFLIGHT_INVENTORY');
  reject(context.originalEvidenceVerified === true && sameIds(document.originalObservations?.map(a=>a.sha256),grant.originalObservationAssets?.map(a=>a.sha256)), 'TESTFLIGHT_ORIGINAL_OBSERVATIONS');
  reject(DIGEST.test(context.productTreeSha256 ?? '') && context.productTreeSha256 === grant.productTreeSha256 && context.executionVerified === true,'TESTFLIGHT_PRODUCT_BYTES');
  reject(context.verifierProof?.verified === true && context.verifierProof.reviewedOnCurrentMain === true,'TESTFLIGHT_REVIEWED_VERIFIER');
  const editor = validateDevelopmentEvidence(document.editor,{...context,featureInventory:inventory,requireUi:true});
  if (!editor.ok) errors.push(...editor.errors.map(e=>`TESTFLIGHT_EDITOR ${e}`));
  const approvedUiRounds=grant.approvedUiRounds ?? 4;
  reject(document.editor?.iterations?.length === approvedUiRounds && document.editor?.e2e?.environment?.kind === 'godot-editor','TESTFLIGHT_APPROVED_UI_EDITOR_REQUIRED');
  const last=document.editor?.iterations?.[approvedUiRounds-1];
  const extra=(document.editor?.iterations ?? []).slice(3,approvedUiRounds);
  reject(extra.length===approvedUiRounds-3 && extra.every(round=>Date.parse(round?.completedAt)-Date.parse(round?.startedAt) <= 210*60000),'TESTFLIGHT_APPROVED_UI_BUDGET');
  if(approvedUiRounds>=5){
    try{
      const additional=approvedUiRounds>=6
        ? validateBootstrapHistoricalUi5(grant,context)
        : validateBootstrapAdditionalUiApproval(grant,context.additionalUiApprovalBytes,context.additionalUiProposalBytes);
      const approvals=document.editor?.additionalIterationApprovals ?? [];
      reject(approvals.some(a=>a.maxRound===5 && a.approvedAt===additional.approvalRecordedAt.replace(/\+00:00$/u,'Z') && a.evidence===grant.additionalUiApprovalFile),'TESTFLIGHT_UI5_EDITOR_APPROVAL');
      const recorded=Date.parse(additional.approvalRecordedAt);
      reject(Number.isFinite(recorded) && approved<=recorded && recorded<=now && recorded<=Date.parse(document.editor?.iterations?.[4]?.plannedAt),'TESTFLIGHT_UI5_APPROVAL_TIME');
      if(approvedUiRounds>=6){
        const sixth=approvedUiRounds>=7 ? validateBootstrapHistoricalUi6(grant,context,document.editor.iterations[5])
          : validateBootstrapUi6Approval(grant,context.ui6ApprovalBytes,context.ui6ProposalBytes);
        const ui6At=Date.parse(sixth.approvalRecordedAt);
        reject(approvals.some(a=>a.maxRound===6 && a.approvedAt===sixth.approvalRecordedAt && a.evidence===grant.ui6ApprovalFile),'TESTFLIGHT_UI6_EDITOR_APPROVAL');
        reject(Number.isFinite(ui6At) && recorded<=ui6At && ui6At<=now && ui6At<=Date.parse(document.editor.iterations[5]?.plannedAt),'TESTFLIGHT_UI6_APPROVAL_TIME');
        reject(document.editor?.iterations?.[4]?.sourceSha===grant.historicalUi5.sourceSha && document.editor.iterations[5]?.sourceSha===(approvedUiRounds>=7 ? grant.historicalUi6.sourceSha : grant.sourceSha),'TESTFLIGHT_UI6_HISTORY_SOURCE');
        if(approvedUiRounds>=7){
          const seventh=approvedUiRounds===8 ? validateBootstrapHistoricalUi7(grant,context,document.editor.iterations[6])
            : validateBootstrapUi7Approval(grant,context.ui7ApprovalBytes,context.ui7ProposalBytes),ui7At=Date.parse(seventh.approvalRecordedAt);
          reject(approvals.some(a=>a.maxRound===7 && a.approvedAt===utc(seventh.approvalRecordedAt) && a.evidence===grant.ui7ApprovalFile),'TESTFLIGHT_UI7_EDITOR_APPROVAL');
          reject(Number.isFinite(ui7At) && ui6At<=ui7At && ui7At<=now && ui7At<=Date.parse(document.editor.iterations[6]?.plannedAt),'TESTFLIGHT_UI7_APPROVAL_TIME');
          reject(document.editor.iterations[6]?.sourceSha===(approvedUiRounds===8 ? grant.historicalUi7.sourceSha : grant.sourceSha),'TESTFLIGHT_UI7_SOURCE');
          if(approvedUiRounds===8){
            const eighth=validateBootstrapUi8Approval(grant,context.ui8ApprovalBytes,context.ui8ProposalBytes,context.ui8HumanApprovalBytes),ui8At=Date.parse(eighth.approvalRecordedAt);
            reject(approvals.some(a=>a.maxRound===8 && a.approvedAt===utc(eighth.approvalRecordedAt) && a.evidence===grant.ui8ApprovalFile),'TESTFLIGHT_UI8_EDITOR_APPROVAL');
            reject(Number.isFinite(ui8At) && ui7At<=ui8At && Date.parse(seventh.historicalRecordedAt)<=ui8At && ui8At<=now && ui8At<=Date.parse(last?.plannedAt),'TESTFLIGHT_UI8_APPROVAL_TIME');
            reject(last?.sourceSha===grant.sourceSha,'TESTFLIGHT_UI8_SOURCE');
          }
        }
      }
    }catch(error){errors.push(error.message);}
  }
  const foundation=(inventory?.features ?? []).filter(f=>f.foundation === true).map(f=>f.id);
  const android=document.android,ios=document.ios;
  reject(android?.sourceSha === context.sourceSha && android.target === 'google-play' && android.configurationFingerprint === grant.androidConfigurationFingerprint
    && android.deviceKind === 'physical-android' && DIGEST.test(android.artifactSha256 ?? ''),'TESTFLIGHT_ANDROID_ACTUAL_CANDIDATE');
  reject(sameIds(android?.features?.map(f=>f.id),foundation) && foundation.length > 0 && android.features.every(f=>f.status === 'passed' && Array.isArray(f.evidence) && f.evidence.length > 0 && f.evidence.every(e=>typeof e === 'string' && e.trim())),'TESTFLIGHT_ANDROID_FOUNDATION_REQUIRED');
  reject(Date.parse(android?.plannedAt) <= Date.parse(android?.startedAt) && Date.parse(android.startedAt) <= Date.parse(android.completedAt)
    && Date.parse(android.completedAt) <= now && now-Date.parse(android.completedAt) <= MAX_AGE,'TESTFLIGHT_ANDROID_TIME');
  reject(ios?.sourceSha === context.sourceSha && ios.target === 'app-store' && ios.status === 'deferred' && typeof ios.reason === 'string' && ios.reason.trim()
    && sameIds(ios.featureIds,foundation),'TESTFLIGHT_IOS_ONLY_DEFERRED');
  reject(equal(grant.provider,PROVIDER) && provider?.verified === true && provider.internalOnly === true && provider.sourceSha === context.sourceSha
    && provider.workflowId === PROVIDER.workflowId && provider.productId === PROVIDER.productId && provider.matchingBuildCount === 1
    && typeof provider.buildId === 'string' && provider.buildId.length > 0 && Number.isSafeInteger(provider.buildNumber) && provider.buildNumber > 0,'TESTFLIGHT_PROVIDER_INTERNAL_ONLY');
  if (context.phase === 'before-deploy') {
    const artifact=context.artifactProof,previous=context.beforeBuildReceipt;
    reject(artifact?.verified === true && artifact.sourceSha === context.sourceSha && artifact.buildId === provider?.buildId
      && artifact.buildNumber === provider?.buildNumber && artifact.bundleId === BUNDLE && artifact.version === '1.1.0'
      && DIGEST.test(artifact.sha256 ?? ''),'TESTFLIGHT_ACTUAL_ARTIFACT_REQUIRED');
    reject(previous?.ok === true && previous.phase === 'before-build' && previous.decisionStatus === 'human_exception'
      && previous.productE2eStatus === 'blocked' && previous.nativeQaWaived === false && previous.scope === 'internal_testflight_only' && previous.sourceSha === context.sourceSha && previous.buildId === provider?.buildId
      && previous.buildNumber === provider?.buildNumber && previous.configurationFingerprint === context.configurationFingerprint
      && previous.grantSha256 === context.grantSha256,'TESTFLIGHT_SAME_BUILD_RECEIPT');
  }
  if (errors.length) return {ok:false,errors:[...new Set(errors)]};
  return {ok:true,errors:[],decisionStatus:'human_exception',productE2eStatus:'blocked',scope:'internal_testflight_only',repository:REPO,
    sourceSha:context.sourceSha,target:'app-store',phase:context.phase,configurationFingerprint:context.configurationFingerprint,
    grantSha256:context.grantSha256,completedAt:document.editor.e2e.completedAt,verifiedAt:new Date(now).toISOString(),
    buildId:provider.buildId,buildNumber:provider.buildNumber,androidStatus:'passed',iosStatus:'deferred',nativeQaWaived:false,
    approvedUiRounds,additionalUiApprovalSha256:approvedUiRounds>=5 ? grant.additionalUiApprovalSha256 : null,
    ...(approvedUiRounds>=6 ? {ui6ApprovalSha256:grant.ui6ApprovalSha256} : {}),
    ...(approvedUiRounds>=7 ? {ui7ApprovalSha256:grant.ui7ApprovalSha256} : {}),
    ...(approvedUiRounds===8 ? {ui8ApprovalSha256:grant.ui8ApprovalSha256} : {})};
}

const root=fileURLToPath(new URL('../../',import.meta.url));
const policyPath='contracts/development-workflow.yaml';
const proposalPath='docs/design/2026-10-14-spiritgate-internal-testflight/approved-proposal.md';
const ui5ProposalPath='docs/design/2026-10-14-spiritgate-ui5/approved-proposal.md';
const ui6ProposalPath='docs/design/2026-10-15-spiritgate-ui6/approved-proposal.md';
const ui7ProposalPath='docs/design/2026-10-15-spiritgate-ui7/approved-proposal.md';
const ui7HumanApprovalPath='docs/design/2026-10-15-spiritgate-ui7/human-approval.json';
const ui8ProposalPath='docs/design/2026-10-15-spiritgate-ui8/approved-proposal.md';
const ui8HumanApprovalPath='docs/design/2026-10-15-spiritgate-ui8/human-approval.json';
const utc=value=>typeof value==='string' ? value.replace(/\+00:00$/u,'Z') : null;
const grantPaths=parse(readFileSync(join(root,policyPath),'utf8')).internalTestflightBootstrap?.grantRegistry ?? [];
const fail=code=>{throw new Error(code);};
const safePath=path=>typeof path==='string' && /^[A-Za-z0-9._/-]+$/u.test(path) && !path.split('/').includes('..') && !isAbsolute(path);
const readRemote=async(repository,path,ref,request)=>{
  const file=await githubJson(`/repos/${repository}/contents/${path}?ref=${ref}`,request);
  if(file.type!=='file' || file.encoding!=='base64' || typeof file.content!=='string') fail('TESTFLIGHT_REMOTE_FILE_REQUIRED');
  return Buffer.from(file.content,'base64');
};
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});

export function validateBootstrapApprovalProposal(approvalBytes,proposalBytes){
  let approval;try{approval=JSON.parse(approvalBytes);}catch{fail('TESTFLIGHT_INVALID_APPROVAL');}
  if(!Buffer.isBuffer(proposalBytes) || !DIGEST.test(approval.proposalSha256 ?? '') || bootstrapDigest(proposalBytes)!==approval.proposalSha256) fail('TESTFLIGHT_APPROVED_PROPOSAL_CHANGED');
}

export function validateBootstrapAdditionalUiApproval(grant,approvalBytes,proposalBytes){
  if(!Buffer.isBuffer(approvalBytes) || !DIGEST.test(grant.additionalUiApprovalSha256 ?? '') || bootstrapDigest(approvalBytes)!==grant.additionalUiApprovalSha256) fail('TESTFLIGHT_UI5_APPROVAL_CHANGED');
  let approval;try{approval=JSON.parse(approvalBytes);}catch{fail('TESTFLIGHT_INVALID_UI5_APPROVAL');}
  validateBootstrapApprovalProposal(approvalBytes,proposalBytes);
  if(approval.kind!=='human_additional_ui_approval' || approval.designId!=='SGD-UI5-TF-110-v1' || approval.repository!==REPO || approval.version!=='1.1.0'
    || approval.objective!=='one_additional_ui_round' || approval.approvedUiRounds!==5 || approval.sourceSha!==grant.sourceSha
    || approval.configurationFingerprint!==grant.configurationFingerprint || approval.originalTimingApprovalSha256!==grant.approvalSha256
    || typeof approval.userApprovalVerbatim!=='string' || !approval.userApprovalVerbatim.trim()
    || approval.executionMinutes!==180 || approval.issueRecheckMaximumCount!==1 || approval.issueRecheckMinutes!==30 || approval.totalMinutes!==210
    || approval.extendOriginal168Hours!==false) fail('TESTFLIGHT_UI5_APPROVAL_SCOPE');
  return approval;
}

function validateBootstrapHistoricalUi5(grant,context){
  const history=grant.historicalUi5;
  for(const [bytes,asset] of [[context.ui5SourceSnapshotBytes,history?.sourceSnapshotAsset],[context.ui5ConfigurationBytes,history?.configurationAsset]]){
    if(!Buffer.isBuffer(bytes) || bootstrapDigest(bytes)!==asset?.sha256
      || !grant.originalObservationAssets.some(a=>equal(a,asset))) fail('TESTFLIGHT_UI5_SNAPSHOT_CHANGED');
  }
  let source,configuration,approval;
  try{source=JSON.parse(context.ui5SourceSnapshotBytes);configuration=JSON.parse(context.ui5ConfigurationBytes);approval=JSON.parse(context.additionalUiApprovalBytes);}
  catch{fail('TESTFLIGHT_INVALID_UI5_SNAPSHOT');}
  if(source.sourceSha!==history.sourceSha || configuration.projection?.sourceSha!==history.sourceSha
    || configuration.projection?.sourceAfter!==history.sourceSnapshotAsset.sha256 || configuration.fingerprint!==history.configurationFingerprint
    || configuration.projection?.runtimeKind!=='godot-editor'
    || (approval.sourceSha!==null && approval.sourceSha!==history.sourceSha)
    || (approval.configurationFingerprint!==null && approval.configurationFingerprint!==history.configurationFingerprint)) fail('TESTFLIGHT_UI5_SNAPSHOT_SCOPE');
  // 미등록 UI5 승인 원문의 null 값은 소급 수정하지 않는다. 실제 후보/설정은 위 원본 snapshot bytes로 확인한다.
  return validateBootstrapAdditionalUiApproval({...grant,sourceSha:approval.sourceSha,configurationFingerprint:approval.configurationFingerprint},context.additionalUiApprovalBytes,context.additionalUiProposalBytes);
}

function validateBootstrapUi6Approval(grant,approvalBytes,proposalBytes){
  if(!Buffer.isBuffer(approvalBytes) || bootstrapDigest(approvalBytes)!==grant.ui6ApprovalSha256) fail('TESTFLIGHT_UI6_APPROVAL_CHANGED');
  let approval;try{approval=JSON.parse(approvalBytes);}catch{fail('TESTFLIGHT_INVALID_UI6_APPROVAL');}
  validateBootstrapApprovalProposal(approvalBytes,proposalBytes);
  if(approval.kind!=='human_additional_ui_approval' || approval.designId!=='SGD-UI6-TF-110-v1' || approval.repository!==REPO || approval.version!=='1.1.0'
    || approval.objective!=='one_additional_ui_round' || approval.approvedUiRounds!==6 || approval.sourceSha!==grant.sourceSha
    || approval.configurationFingerprint!==grant.configurationFingerprint || approval.originalTimingApprovalSha256!==grant.approvalSha256
    || approval.previousUiApprovalSha256!==grant.additionalUiApprovalSha256 || approval.previousUiSourceSnapshotSha256!==grant.historicalUi5.sourceSnapshotAsset.sha256
    || approval.previousUiConfigurationSha256!==grant.historicalUi5.configurationAsset.sha256
    || typeof approval.userApprovalVerbatim!=='string' || !approval.userApprovalVerbatim.trim()
    || approval.executionMinutes!==180 || approval.issueRecheckMaximumCount!==1 || approval.issueRecheckMinutes!==30 || approval.totalMinutes!==210
    || approval.extendOriginal168Hours!==false) fail('TESTFLIGHT_UI6_APPROVAL_SCOPE');
  return approval;
}

function validateBootstrapHistoricalUi6(grant,context,round){
  const h=grant.historicalUi6;
  const pairs=[['ui6SourceSnapshotBytes','sourceSnapshotAsset'],['ui6ConfigurationBytes','configurationAsset'],
    ['ui6ExecutionStartBytes','executionStartAsset'],['ui6FailedSegmentBytes','failedSegmentAsset'],['ui6FailureBytes','failureAsset']];
  for(const [key,asset] of pairs){
    if(!Buffer.isBuffer(context[key]) || bootstrapDigest(context[key])!==h[asset].sha256
      || !grant.originalObservationAssets.some(a=>equal(a,h[asset]))) fail('TESTFLIGHT_UI6_SNAPSHOT_CHANGED');
  }
  let source,configuration,start,end,failure,approval;
  try{[source,configuration,start,end,failure]=pairs.map(([key])=>JSON.parse(context[key]));approval=JSON.parse(context.ui6ApprovalBytes);}
  catch{fail('TESTFLIGHT_INVALID_UI6_SNAPSHOT');}
  if([source,configuration,start,end,failure,approval].some(v=>!v || typeof v!=='object' || Array.isArray(v))) fail('TESTFLIGHT_INVALID_UI6_SNAPSHOT');
  if([source,configuration,start,end,failure].some(v=>v.sourceSha!==h.sourceSha)
    || configuration.fingerprint!==h.configurationFingerprint || start.configurationFingerprint!==h.configurationFingerprint
    || configuration.runtimeKind!=='godot-editor' || configuration.nativeMarketFingerprint!==null
    || (approval.sourceSha!==null && approval.sourceSha!==h.sourceSha)
    || (approval.configurationFingerprint!==null && approval.configurationFingerprint!==h.configurationFingerprint)
    || !Array.isArray(source.files) || source.files.length!==end.sourceTrackedFiles
    || typeof configuration.sourceProjectSha256!=='string' || !DIGEST.test(configuration.sourceProjectSha256)
    || source.files.find(f=>f.path==='project.godot')?.sha256!==configuration.sourceProjectSha256
    || !Array.isArray(end.sourceChanges) || end.sourceChanges.length!==1
    || end.sourceChanges[0]?.path!=='project.godot' || end.sourceChanges[0].beforeSha256!==configuration.sourceProjectSha256
    || typeof end.sourceChanges[0].afterSha256!=='string' || !DIGEST.test(end.sourceChanges[0].afterSha256)
    || !Array.isArray(configuration.configs) || !configuration.configs.some(c=>c.sha256===end.sourceChanges[0].afterSha256)) fail('TESTFLIGHT_UI6_SNAPSHOT_SCOPE');
  if(end.wholeUi6Completed!==false || end.phaseResult!=='fail and incomplete' || failure.result!=='fail'
    || !Array.isArray(end.errors) || end.errors.length!==end.totalErrorCount || !Number.isSafeInteger(end.totalErrorCount) || end.totalErrorCount<1
    || !Array.isArray(failure.errors) || failure.errors.length!==failure.errorCount || failure.errorCount!==end.totalErrorCount
    || round?.functional?.status==='passed' || round?.ux?.status==='passed') fail('TESTFLIGHT_UI6_ORIGINAL_FAILURE');
  const began=Date.parse(start.startedAt),stopped=Date.parse(end.stopConfirmedByUtc),recorded=Date.parse(end.recordedAt),found=Date.parse(failure.recordedAt);
  if(![began,stopped,recorded,found].every(Number.isFinite) || !(began<=found && found<=stopped && stopped<=recorded)
    || Date.parse(start.mainDeadlineAt)-began!==180*60000 || Date.parse(start.absoluteDeadlineAt)-began!==210*60000
    || start.mainMinutes!==180 || start.problemRecheckLimit!==1 || start.problemRecheckMaxMinutes!==30
    || end.problemRecheckUsed!==0 || end.newCandidateRun!==0
    || utc(end.originalFirstRun)!==utc(start.startedAt) || utc(failure.originalStart)!==utc(start.startedAt)
    || utc(end.mainDeadline)!==utc(start.mainDeadlineAt) || round?.plannedAt!==utc(start.plannedAt)
    || round?.startedAt!==utc(start.startedAt) || round?.completedAt!==utc(end.recordedAt)) fail('TESTFLIGHT_UI6_ORIGINAL_TIME');
  // 원래 UI6의 미등록 null 승인과 실패 관찰을 보존한다. 새 UI7의 후보/설정으로 소급 변경하지 않는다.
  return validateBootstrapUi6Approval({...grant,sourceSha:approval.sourceSha,configurationFingerprint:approval.configurationFingerprint},context.ui6ApprovalBytes,context.ui6ProposalBytes);
}

function validateBootstrapUi7Approval(grant,approvalBytes,proposalBytes){
  if(!Buffer.isBuffer(approvalBytes) || bootstrapDigest(approvalBytes)!==grant.ui7ApprovalSha256) fail('TESTFLIGHT_UI7_APPROVAL_CHANGED');
  let approval;try{approval=JSON.parse(approvalBytes);}catch{fail('TESTFLIGHT_INVALID_UI7_APPROVAL');}
  validateBootstrapApprovalProposal(approvalBytes,proposalBytes);
  const h=grant.historicalUi6;
  if(approval.kind!=='human_additional_ui_approval' || approval.designId!=='SGD-UI7-TF-110-v1' || approval.repository!==REPO || approval.version!=='1.1.0'
    || approval.objective!=='one_additional_ui_round' || approval.approvedUiRounds!==7 || approval.sourceSha!==grant.sourceSha
    || approval.configurationFingerprint!==grant.configurationFingerprint || approval.originalTimingApprovalSha256!==grant.approvalSha256
    || approval.previousUiApprovalSha256!==grant.ui6ApprovalSha256 || approval.previousUiSourceSnapshotSha256!==h.sourceSnapshotAsset.sha256
    || approval.previousUiConfigurationSha256!==h.configurationAsset.sha256 || approval.previousUiExecutionStartSha256!==h.executionStartAsset.sha256
    || approval.previousUiFailedSegmentSha256!==h.failedSegmentAsset.sha256 || approval.previousUiFailureSha256!==h.failureAsset.sha256
    || typeof approval.userApprovalVerbatim!=='string' || !approval.userApprovalVerbatim.trim()
    || approval.executionMinutes!==180 || approval.issueRecheckMaximumCount!==1 || approval.issueRecheckMinutes!==30 || approval.totalMinutes!==210
    || approval.extendOriginal168Hours!==false) fail('TESTFLIGHT_UI7_APPROVAL_SCOPE');
  return approval;
}

const ui7HistoricalAssets=[
  ['sourceSnapshotAsset','ui7SourceSnapshotBytes','source-before.json'],['configurationAsset','ui7ConfigurationBytes','configuration.json'],
  ['executionStartAsset','ui7ExecutionStartBytes','execution-start.json'],['mainIntegrityAsset','ui7MainIntegrityBytes','inspection/source-during-after-main-observations.json'],
  ['transitionAsset','ui7TransitionBytes','correction-53bec059-copy-receipt.json'],['recheckConfigurationAsset','ui7RecheckConfigurationBytes','recheck-53bec059/configuration.json'],
  ['recheckExecutionStartAsset','ui7RecheckExecutionStartBytes','recheck-53bec059/execution-start.json'],['recheckClockAsset','ui7RecheckClockBytes','recheck-53bec059/clock-clarification.json'],
  ['recheckIntegrityAsset','ui7RecheckIntegrityBytes','recheck-53bec059/final-snapshot-receipt.json'],['resultAsset','ui7ResultBytes','ui7-result.json'],
  ['cleanupAsset','ui7CleanupBytes','recheck-53bec059/process-cleanup-receipt.json'],['manifestAsset','ui7ManifestBytes','ui7-evidence-manifest.json'],
];
function validateBootstrapHistoricalUi7(grant,context,round){
  const h=grant.historicalUi7,objects=[];
  for(const [asset,key] of ui7HistoricalAssets){
    const bytes=context[key];
    if(!Buffer.isBuffer(bytes) || bootstrapDigest(bytes)!==h[asset].sha256 || !grant.originalObservationAssets.some(a=>equal(a,h[asset]))) fail('TESTFLIGHT_UI7_SNAPSHOT_CHANGED');
    let value;try{value=JSON.parse(bytes);}catch{fail('TESTFLIGHT_INVALID_UI7_SNAPSHOT');}
    if(!value || typeof value!=='object' || Array.isArray(value)) fail('TESTFLIGHT_INVALID_UI7_SNAPSHOT');
    objects.push(value);
  }
  const [source,configuration,start,integrity,transition,reconfiguration,restart,clock,finalIntegrity,result,cleanup,manifest]=objects;
  let approval;try{approval=JSON.parse(context.ui7ApprovalBytes);}catch{fail('TESTFLIGHT_INVALID_UI7_APPROVAL');}
  if(!approval || typeof approval!=='object' || Array.isArray(approval)) fail('TESTFLIGHT_INVALID_UI7_APPROVAL');
  if([source,configuration,start,integrity,result.main].some(v=>v?.sourceSha!==h.sourceSha)
    || [reconfiguration,restart,finalIntegrity,result.recheck].some(v=>v?.sourceSha!==h.recheckSourceSha)
    || h.sourceSha===h.recheckSourceSha || configuration.fingerprint!==h.configurationFingerprint
    || start.configurationFingerprint!==h.configurationFingerprint || start.configurationFileSha256!==h.configurationAsset.sha256
    || reconfiguration.fingerprint!==h.recheckConfigurationFingerprint || reconfiguration.originalFingerprint!==h.configurationFingerprint
    || restart.configurationSha256!==h.recheckConfigurationAsset.sha256
    || [configuration,reconfiguration].some(v=>v.runtimeKind!=='godot-editor' || v.nativeMarketFingerprint!==null)
    || (approval.sourceSha!==null && approval.sourceSha!==h.sourceSha)
    || (approval.configurationFingerprint!==null && approval.configurationFingerprint!==h.configurationFingerprint)) fail('TESTFLIGHT_UI7_SNAPSHOT_SCOPE');
  const files=source.files,changes=transition.filesCopied,project=configuration.sourceProjectSha256;
  const declared=(list,sourceKey,qaKey,cfg)=>Array.isArray(list) && list.length===1 && list[0]?.path==='project.godot'
    && typeof project==='string' && DIGEST.test(project) && list[0][sourceKey]===project
    && Array.isArray(cfg.configs) && cfg.configs.some(c=>typeof c.sha256==='string' && DIGEST.test(c.sha256) && c.sha256===list[0][qaKey]);
  if(!Array.isArray(files) || !files.length || !files.every(f=>safePath(f.path) && typeof f.sha256==='string' && DIGEST.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes>=0)
    || new Set(files.map(f=>f.path)).size!==files.length || files.find(f=>f.path==='project.godot')?.sha256!==project
    || integrity.filesChecked!==files.length || !equal(integrity.missing,[]) || !declared(integrity.trackedDifferences,'sourceSha256','currentSha256',configuration)
    || transition.sourceOriginal!==h.sourceSha || transition.sourceCorrected!==h.recheckSourceSha || !Array.isArray(changes) || !changes.length
    || new Set(changes.map(c=>c.path)).size!==changes.length || !changes.every(c=>{
      const old=files.find(f=>f.path===c.path);
      return safePath(c.path) && c.path!=='project.godot' && (old ? c.old?.sha256===old.sha256 && c.old?.bytes===old.bytes : c.old===null)
        && typeof c.new?.sha256==='string' && DIGEST.test(c.new.sha256) && Number.isSafeInteger(c.new?.bytes) && c.new.bytes>=0;
    }) || transition.trackedFilesChecked!==files.length+changes.filter(c=>c.old===null).length
    || !equal(transition.missing,[]) || !declared(transition.trackedDifferences,'sourceSha256','qaSha256',reconfiguration)
    || transition.declaredQaHelpersUnchanged!==true || transition.runStartedByThisScript!==false || transition.recheckClockSetByThisScript!==false || transition.originalFailureHistoryModified!==false
    || reconfiguration.sourceProjectSha256!==project || finalIntegrity.sourceFilesChecked!==transition.trackedFilesChecked || !equal(finalIntegrity.missing,[])
    || !declared(finalIntegrity.declaredTrackedDifference,'source','qa',reconfiguration)
    || !reconfiguration.helperHashes || !Object.keys(reconfiguration.helperHashes).length || !Object.entries(reconfiguration.helperHashes).every(([path,hash])=>typeof hash==='string' && DIGEST.test(hash) && finalIntegrity.helperHashes?.[path]?.expected===hash && finalIntegrity.helperHashes[path].actual===hash)
    || finalIntegrity.globalEditorSettingsUnchanged!==true || finalIntegrity.profileUnchanged!==true
    || finalIntegrity.originalAutomaticRejectionsPreserved!==true || finalIntegrity.newRun!==false || finalIntegrity.uiInput!==false) fail('TESTFLIGHT_UI7_SOURCE_HISTORY');
  const counts=result.main?.counts;
  if(result.round!==7 || result.verdict!=='fail-and-incomplete' || result.approvalConsumed!==true
    || !counts || !['pass','fail','unknown'].every(k=>Number.isSafeInteger(counts[k]) && counts[k]>=0) || counts.pass+counts.fail+counts.unknown!==28 || counts.fail===0 || counts.unknown===0
    || result.recheck?.count!==1 || result.recheck.complete28NewSource!=='notcompleted' || result.recheck.complete168NewSource!=='notcompleted' || result.recheck.smallHeroCardUx!=='fail'
    || round?.functional?.status==='passed' || round?.ux?.status==='passed'
    || result.cleanup?.status!=='completed-with-exact-user-approval' || result.cleanup.processAbsentAfter!==true || result.cleanup.uiInput!==false || result.cleanup.newRun!==false
    || result.cleanup.originalStopRejectionAndRootSigtermRejectionPreserved!==true
    || cleanup.processAbsentAfter!==true || cleanup.signalSent!==true || cleanup.uiInputSent!==false || cleanup.newProcessStarted!==false
    || !Number.isSafeInteger(cleanup.pid) || cleanup.pid<=0 || result.cleanup.pid!==cleanup.pid
    || restart.marker?.pid!==cleanup.pid || restart.marker?.sourceSha!==h.recheckSourceSha) fail('TESTFLIGHT_UI7_FAILURE_HISTORY');
  const began=Date.parse(start.startedAt),mainEnd=Date.parse(result.main.completedAt),intent=Date.parse(restart.runClickIntentAt),marker=Date.parse(restart.startedAt),stopped=Date.parse(cleanup.at),completed=Date.parse(result.completedAt),deadline=Date.parse(clock.effectiveDeadline);
  if(![began,mainEnd,intent,marker,stopped,completed,deadline].every(Number.isFinite)
    || !(began<=Date.parse(integrity.at) && Date.parse(integrity.at)<=mainEnd && mainEnd<=Date.parse(transition.at) && Date.parse(transition.at)<=intent && intent<=marker && marker<=stopped && stopped<=Date.parse(finalIntegrity.at) && Date.parse(finalIntegrity.at)<=completed && completed<=deadline)
    || Date.parse(start.mainDeadlineAt)-began!==180*60000 || Date.parse(start.absoluteDeadlineAt)-began!==210*60000 || mainEnd>Date.parse(start.mainDeadlineAt) || deadline>Date.parse(start.absoluteDeadlineAt)
    || start.uiRound!==7 || start.recheckCount!==0 || start.mainMinutes!==180 || start.problemRecheckLimit!==1 || start.problemRecheckMaxMinutes!==30 || restart.uiRound!==7 || restart.recheckCount!==1 || restart.restartsAllowed!==0
    || utc(restart.plannedAt)!==utc(result.main.completedAt) || utc(restart.absoluteOuterDeadline)!==utc(start.absoluteDeadlineAt)
    || utc(clock.intentAt)!==utc(restart.runClickIntentAt) || utc(clock.effectiveStart)!==utc(restart.runClickIntentAt) || utc(clock.actualMarkerAt)!==utc(restart.startedAt)
    || Date.parse(restart.deadline)-marker!==30*60000 || deadline-intent!==30*60000
    || utc(result.main.startedAt)!==utc(start.startedAt) || utc(result.main.deadline)!==utc(start.mainDeadlineAt)
    || utc(result.recheck.effectiveStart)!==utc(clock.effectiveStart) || utc(result.recheck.actualRuntimeMarkerAt)!==utc(restart.startedAt) || utc(result.recheck.effectiveDeadline)!==utc(clock.effectiveDeadline)
    || utc(result.recheck.actualProcessTerminatedAt)!==utc(cleanup.at) || utc(finalIntegrity.actualProcessTerminatedAt)!==utc(cleanup.at) || utc(result.cleanup.terminatedAt)!==utc(cleanup.at)
    || utc(result.recheck.completedAt)!==utc(result.completedAt) || utc(result.reportedAt)!==utc(result.completedAt)
    || round?.plannedAt!==utc(start.plannedAt) || round?.startedAt!==utc(start.startedAt) || round?.completedAt!==utc(result.completedAt)) fail('TESTFLIGHT_UI7_ORIGINAL_TIME');
  if(manifest.result!=='FAIL/INCOMPLETE' || !Array.isArray(manifest.files) || manifest.fileCount!==manifest.files.length
    || new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length || !Number.isFinite(Date.parse(manifest.at)) || Date.parse(manifest.at)<completed || Date.parse(manifest.at)>deadline
    || !ui7HistoricalAssets.filter(([asset])=>asset!=='manifestAsset').every(([asset,key,path])=>manifest.files.some(f=>f.path===path && f.sha256===h[asset].sha256 && f.bytes===context[key].length))
    || !['failure-drag-unlock/failure.json','inspection/revive-prompt-pt-small/finding.json','failure-revive-ad-cancel-overlay/failure.json','recheck-53bec059/small-hero-menu-finding.json'].every(path=>manifest.files.some(f=>f.path===path && typeof f.sha256==='string' && DIGEST.test(f.sha256) && f.bytes>0))) fail('TESTFLIGHT_UI7_MANIFEST');
  // UI7 승인 원문의 미등록 null과 원래/수정 후보 실패를 보존한다. UI8 통과로 소급 합산하지 않는다.
  return {...validateBootstrapUi7Approval({...grant,sourceSha:approval.sourceSha,configurationFingerprint:approval.configurationFingerprint},context.ui7ApprovalBytes,context.ui7ProposalBytes),historicalRecordedAt:manifest.at};
}

function validateBootstrapUi8Approval(grant,approvalBytes,proposalBytes,humanBytes){
  if(!Buffer.isBuffer(approvalBytes) || bootstrapDigest(approvalBytes)!==grant.ui8ApprovalSha256) fail('TESTFLIGHT_UI8_APPROVAL_CHANGED');
  let a;try{a=JSON.parse(approvalBytes);}catch{fail('TESTFLIGHT_INVALID_UI8_APPROVAL');}
  if(!a || typeof a!=='object' || Array.isArray(a)) fail('TESTFLIGHT_INVALID_UI8_APPROVAL');
  validateBootstrapApprovalProposal(approvalBytes,proposalBytes);
  if(!Buffer.isBuffer(humanBytes) || bootstrapDigest(humanBytes)!==a.humanApprovalSha256) fail('TESTFLIGHT_UI8_HUMAN_APPROVAL_CHANGED');
  let human;try{human=JSON.parse(humanBytes);}catch{fail('TESTFLIGHT_INVALID_UI8_HUMAN_APPROVAL');}
  if(!human || typeof human!=='object' || Array.isArray(human) || human.originalApprovalSha256!==a.originalApprovalSha256 || human.originalProposalSha256!==a.originalProposalSha256) fail('TESTFLIGHT_UI8_HUMAN_APPROVAL_SCOPE');
  if(a.kind!=='human_additional_ui_approval' || a.designId!=='SGD-UI8-TF-110-v1' || a.repository!==REPO || a.version!=='1.1.0'
    || a.objective!=='one_additional_ui_round' || a.approvedUiRounds!==8 || a.sourceSha!==grant.sourceSha || a.configurationFingerprint!==grant.configurationFingerprint
    || a.originalTimingApprovalSha256!==grant.approvalSha256 || a.previousUiApprovalSha256!==grant.ui7ApprovalSha256
    || ![a.originalApprovalSha256,a.originalProposalSha256].every(v=>typeof v==='string' && DIGEST.test(v))
    || !a.previousUiObservationSha256 || !sameIds(Object.keys(a.previousUiObservationSha256),ui7HistoricalAssets.map(([asset])=>asset))
    || !ui7HistoricalAssets.every(([asset])=>typeof a.previousUiObservationSha256[asset]==='string' && DIGEST.test(a.previousUiObservationSha256[asset]) && a.previousUiObservationSha256[asset]===grant.historicalUi7[asset].sha256)
    || typeof a.userApprovalVerbatim!=='string' || !a.userApprovalVerbatim.trim()
    || a.executionMinutes!==180 || a.issueRecheckMaximumCount!==1 || a.issueRecheckMinutes!==30 || a.totalMinutes!==210
    || a.inputDiagnosticMaximumCount!==1 || a.inputDiagnosticMinutes!==15 || a.inputDiagnosticIncludedInExecutionMinutes!==true
    || a.extendOriginal168Hours!==false) fail('TESTFLIGHT_UI8_APPROVAL_SCOPE');
  return a;
}

// 임의 파일 경로를 ID로 바꿔 넘길 수 없다. 중앙 main에서 검토한 등록만 쓴다.
async function reviewedBootstrap(id,verifierSha,request){
  const path=grantPaths.find(p=>p===`contracts/internal-testflight-bootstrap/${id}.json`);
  if(!path || !safePath(path) || !SHA.test(verifierSha ?? '')) fail('TESTFLIGHT_REVIEWED_GRANT_REQUIRED');
  const bytes=readFileSync(join(root,path)),grant=JSON.parse(bytes);
  if(!validGrant(grant) || grant.id!==id || grant.revoked) fail('TESTFLIGHT_GRANT');
  const sources=[policyPath,'contracts/development-workflow.schema.json',path,grant.approvalFile,proposalPath,'package.json','package-lock.json',
    'scripts/github-rest.mjs','scripts/trigger-xcode-cloud.mjs','scripts/release/resolve-github-tag-commit.mjs','scripts/release/internal-testflight-bootstrap.mjs','scripts/release/verify-development-evidence.mjs',
    'scripts/release/tag-version-authority.mjs',
    'contracts/development-evidence.schema.json','contracts/development-evidence-v1.schema.json','contracts/test-plan.schema.json',
    'scripts/release/development-evidence-v1.mjs','scripts/release/test-plan.mjs','scripts/release/carry-forward.mjs',
    'contracts/internal-testflight-bootstrap.schema.json','contracts/internal-testflight-bootstrap-grant.schema.json',
    ...(grant.approvedUiRounds>=5 ? [grant.additionalUiApprovalFile,ui5ProposalPath] : []),
    ...(grant.approvedUiRounds>=6 ? [grant.ui6ApprovalFile,ui6ProposalPath] : []),
    ...(grant.approvedUiRounds>=7 ? [grant.ui7ApprovalFile,ui7ProposalPath,ui7HumanApprovalPath] : []),
    ...(grant.approvedUiRounds===8 ? [grant.ui8ApprovalFile,ui8ProposalPath,ui8HumanApprovalPath] : [])];
  await Promise.all(sources.map(async path=>{
    const remote=await readRemote('seorilabs/.github',path,verifierSha,request);
    if(!readFileSync(join(root,path)).equals(remote)) fail('TESTFLIGHT_VERIFIER_BYTES_CHANGED');
  }));
  const ancestry=await githubJson(`/repos/seorilabs/.github/compare/${verifierSha}...main`,request);
  if(!['ahead','identical'].includes(ancestry.status) || ancestry.base_commit?.sha!==verifierSha) fail('TESTFLIGHT_VERIFIER_NOT_REVIEWED');
  const latestPolicy=parse((await readRemote('seorilabs/.github',policyPath,'main',request)).toString());
  if(!latestPolicy.internalTestflightBootstrap?.grantRegistry?.includes(path)) fail('TESTFLIGHT_GRANT_REVOKED');
  const latest=await readRemote('seorilabs/.github',path,'main',request);
  if(!bytes.equals(latest) || JSON.parse(latest).revoked) fail('TESTFLIGHT_GRANT_REVOKED_OR_CHANGED');
  const approvalBytes=readFileSync(join(root,grant.approvalFile));
  if(bootstrapDigest(approvalBytes)!==grant.approvalSha256) fail('TESTFLIGHT_APPROVAL_CHANGED');
  const proposalBytes=readFileSync(join(root,proposalPath));
  validateBootstrapApprovalProposal(approvalBytes,proposalBytes);
  const [latestApproval,latestProposal]=await Promise.all([
    readRemote('seorilabs/.github',grant.approvalFile,'main',request),readRemote('seorilabs/.github',proposalPath,'main',request)]);
  if(!approvalBytes.equals(latestApproval) || !proposalBytes.equals(latestProposal)) fail('TESTFLIGHT_APPROVED_PROPOSAL_CHANGED');
  let additionalUi={};
  if(grant.approvedUiRounds>=5){
    const additionalUiApprovalBytes=readFileSync(join(root,grant.additionalUiApprovalFile)),additionalUiProposalBytes=readFileSync(join(root,ui5ProposalPath));
    if(grant.approvedUiRounds===5) validateBootstrapAdditionalUiApproval(grant,additionalUiApprovalBytes,additionalUiProposalBytes);
    const [latestAdditionalApproval,latestAdditionalProposal]=await Promise.all([
      readRemote('seorilabs/.github',grant.additionalUiApprovalFile,'main',request),readRemote('seorilabs/.github',ui5ProposalPath,'main',request)]);
    if(!additionalUiApprovalBytes.equals(latestAdditionalApproval) || !additionalUiProposalBytes.equals(latestAdditionalProposal)) fail('TESTFLIGHT_UI5_REVOKED_OR_CHANGED');
    additionalUi={additionalUiApprovalBytes,additionalUiProposalBytes};
  }
  if(grant.approvedUiRounds>=6){
    const ui6ApprovalBytes=readFileSync(join(root,grant.ui6ApprovalFile)),ui6ProposalBytes=readFileSync(join(root,ui6ProposalPath));
    if(grant.approvedUiRounds===6) validateBootstrapUi6Approval(grant,ui6ApprovalBytes,ui6ProposalBytes);
    const [latestApproval,latestProposal]=await Promise.all([
      readRemote('seorilabs/.github',grant.ui6ApprovalFile,'main',request),readRemote('seorilabs/.github',ui6ProposalPath,'main',request)]);
    if(!ui6ApprovalBytes.equals(latestApproval) || !ui6ProposalBytes.equals(latestProposal)) fail('TESTFLIGHT_UI6_REVOKED_OR_CHANGED');
    Object.assign(additionalUi,{ui6ApprovalBytes,ui6ProposalBytes});
  }
  if(grant.approvedUiRounds>=7){
    const ui7ApprovalBytes=readFileSync(join(root,grant.ui7ApprovalFile)),ui7ProposalBytes=readFileSync(join(root,ui7ProposalPath));
    if(grant.approvedUiRounds===7) validateBootstrapUi7Approval(grant,ui7ApprovalBytes,ui7ProposalBytes);
    const [latestApproval,latestProposal,latestHuman]=await Promise.all([
      readRemote('seorilabs/.github',grant.ui7ApprovalFile,'main',request),readRemote('seorilabs/.github',ui7ProposalPath,'main',request),readRemote('seorilabs/.github',ui7HumanApprovalPath,'main',request)]);
    const humanBytes=readFileSync(join(root,ui7HumanApprovalPath));
    if(!ui7ApprovalBytes.equals(latestApproval) || !ui7ProposalBytes.equals(latestProposal) || !humanBytes.equals(latestHuman)
      || bootstrapDigest(humanBytes)!==JSON.parse(ui7ApprovalBytes).humanApprovalSha256) fail('TESTFLIGHT_UI7_REVOKED_OR_CHANGED');
    Object.assign(additionalUi,{ui7ApprovalBytes,ui7ProposalBytes});
  }
  if(grant.approvedUiRounds===8){
    const ui8ApprovalBytes=readFileSync(join(root,grant.ui8ApprovalFile)),ui8ProposalBytes=readFileSync(join(root,ui8ProposalPath));
    const ui8HumanApprovalBytes=readFileSync(join(root,ui8HumanApprovalPath));
    validateBootstrapUi8Approval(grant,ui8ApprovalBytes,ui8ProposalBytes,ui8HumanApprovalBytes);
    const [latestApproval,latestProposal,latestHuman]=await Promise.all([
      readRemote('seorilabs/.github',grant.ui8ApprovalFile,'main',request),readRemote('seorilabs/.github',ui8ProposalPath,'main',request),readRemote('seorilabs/.github',ui8HumanApprovalPath,'main',request)]);
    if(!ui8ApprovalBytes.equals(latestApproval) || !ui8ProposalBytes.equals(latestProposal) || !ui8HumanApprovalBytes.equals(latestHuman)) fail('TESTFLIGHT_UI8_REVOKED_OR_CHANGED');
    Object.assign(additionalUi,{ui8ApprovalBytes,ui8ProposalBytes,ui8HumanApprovalBytes});
  }
  return {grant,approvalBytes,...additionalUi,grantSha256:bootstrapDigest(bytes),verifierProof:{verified:true,revision:verifierSha,reviewedOnCurrentMain:true}};
}

export function verifyBootstrapWorkingTree(repository,grant,phase){
  const dir=realpathSync(repository);
  if(git(dir,'rev-parse','HEAD^{commit}').toString().trim()!==grant.sourceSha) fail('TESTFLIGHT_HEAD_CHANGED');
  const tree=git(dir,'ls-tree','-r','-z',grant.sourceSha);
  if(bootstrapDigest(tree)!==grant.productTreeSha256) fail('TESTFLIGHT_PRODUCT_TREE_CHANGED');
  const overrides=grant.workingOverrides[phase];
  for(const entry of tree.toString().split('\0').filter(Boolean)){
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    if(!match) fail('TESTFLIGHT_UNSUPPORTED_SOURCE_ENTRY');
    const [, ,expected,path]=match,file=join(dir,path),stat=lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink()) fail('TESTFLIGHT_WORKING_FILE_CHANGED');
    const bytes=readFileSync(file);
    const actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(overrides[path] ? bootstrapDigest(bytes)!==overrides[path] : actual!==expected) fail('TESTFLIGHT_WORKING_FILE_CHANGED');
  }
  // .gitignore에 숨긴 코드도 검사한다. 생성 위치만 허용하고 전체 폴더 예외는 두지 않는다.
  const extras=git(dir,'ls-files','--others','-z').toString().split('\0').filter(Boolean);
  const generated=p=>p.startsWith('.godot/') || p.startsWith('build/logs/')
    || /^addons\/seorilabs_platform\/.+\.uid$/u.test(p)
    || (phase==='before-deploy' && (/^xcode-cloud\/(?:MoltenVK\.xcframework|SpiritgateDefenders|SpiritgateDefenders\.xcframework|libgodot_camera\.visionos\.(?:debug|release)\.xcframework)\//u.test(p)
      || ['xcode-cloud/PrivacyInfo.xcprivacy','xcode-cloud/SpiritgateDefenders.pck'].includes(p)));
  if(extras.some(p=>!generated(p))) fail('TESTFLIGHT_UNTRACKED_PRODUCT_FILE');
  return {productTreeSha256:bootstrapDigest(tree),executionVerified:true};
}

async function appleRead(path,token,fetchImpl){
  const url=new URL(path,'https://api.appstoreconnect.apple.com');
  if(url.origin!=='https://api.appstoreconnect.apple.com' || !url.pathname.startsWith('/v1/')) fail('TESTFLIGHT_APPLE_URL');
  const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok) fail(`TESTFLIGHT_APPLE_READ_${response.status}`);
  return response.json();
}
async function applePages(path,token,fetchImpl){
  const items=[],seen=new Set();
  while(path){
    if(seen.has(path) || seen.size>=50) fail('TESTFLIGHT_APPLE_PAGINATION');seen.add(path);
    const document=await appleRead(path,token,fetchImpl);
    if(!Array.isArray(document.data)) fail('TESTFLIGHT_APPLE_LIST');
    items.push(...document.data);path=document.links?.next;
  }
  return items;
}
// The existing shared ASC identity is injected by the protected Xcode Cloud consumer.
async function appleToken(env){
  const {makeAppStoreConnectToken}=await import('../trigger-xcode-cloud.mjs');
  for(const key of ['APP_STORE_CONNECT_API_KEY_ID','APP_STORE_CONNECT_ISSUER_ID','APP_STORE_CONNECT_PRIVATE_KEY_BASE64'])
    if(typeof env[key]!=='string' || !env[key].trim()) fail('TESTFLIGHT_REGISTERED_APPLE_IDENTITY_REQUIRED');
  return makeAppStoreConnectToken({keyId:env.APP_STORE_CONNECT_API_KEY_ID,issuerId:env.APP_STORE_CONNECT_ISSUER_ID,privateKeyBase64:env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64});
}

export function validateBootstrapAppleObservation({app,product,workflow,run,runs,tag},grant,env){
  const w=workflow?.attributes,action=w?.actions?.[0],g=grant.provider;
  if(app?.id!==g.appId || app.attributes?.bundleId!==grant.packageName || product?.id!==g.productId
    || product.relationships?.app?.data?.id!==g.appId || workflow?.id!==g.workflowId
    || workflow.relationships?.product?.data?.id!==g.productId) fail('TESTFLIGHT_APPLE_PRODUCT');
  if(w.isEnabled!==true || w.actions?.length!==1 || action.actionType!=='ARCHIVE' || action.platform!=='IOS'
    || action.scheme!=='SpiritgateDefenders' || action.isRequiredToPass!==true || action.buildDistributionAudience!=='INTERNAL_ONLY'
    || !w.manualTagStartCondition || ['branchStartCondition','tagStartCondition','pullRequestStartCondition','scheduledStartCondition','manualBranchStartCondition','manualPullRequestStartCondition'].some(k=>w[k]!=null)) fail('TESTFLIGHT_APPLE_WORKFLOW_NOT_INTERNAL');
  const matches=runs.filter(r=>r.attributes?.sourceCommit?.commitSha===grant.sourceSha);
  if(run?.id!==env.CI_BUILD_ID || run.attributes?.sourceCommit?.commitSha!==grant.sourceSha
    || run.relationships?.workflow?.data?.id!==g.workflowId || run.relationships?.product?.data?.id!==g.productId
    || String(run.attributes?.number)!==env.CI_BUILD_NUMBER || run.attributes?.startReason!=='MANUAL'
    || run.attributes?.isPullRequestBuild!==false || matches.length!==1 || matches[0].id!==run.id
    || tag?.attributes?.kind!=='TAG' || tag.attributes.name!==grant.releaseTag || tag.id!==run.relationships?.sourceBranchOrTag?.data?.id) fail('TESTFLIGHT_APPLE_FIRST_BUILD');
  return {verified:true,internalOnly:true,sourceSha:grant.sourceSha,workflowId:g.workflowId,productId:g.productId,
    buildId:run.id,buildNumber:run.attributes.number,matchingBuildCount:matches.length};
}

async function bootstrapProvider(grant,env,fetchImpl){
  if(env.APP_STORE_CONNECT_API_KEY_ID!=='UHVPXA39JA' || env.CI_TEAM_ID!=='HCDUXX4Z3X' || env.CI_XCODE_CLOUD!=='TRUE' || env.CI_PRODUCT_ID!==PROVIDER.productId || env.CI_WORKFLOW_ID!==PROVIDER.workflowId
    || env.CI_BUNDLE_ID!==BUNDLE || env.CI_XCODE_SCHEME!=='SpiritgateDefenders' || env.CI_TAG!==TAG || env.CI_COMMIT!==grant.sourceSha
    || !/^[A-Za-z0-9-]+$/u.test(env.CI_BUILD_ID ?? '') || !/^[1-9][0-9]*$/u.test(env.CI_BUILD_NUMBER ?? '')) fail('TESTFLIGHT_CI_CONTEXT');
  const token=await appleToken(env),g=grant.provider;
  const [app,product,workflow,run,runs]=await Promise.all([
    appleRead(`/v1/apps/${g.appId}`,token,fetchImpl),appleRead(`/v1/ciProducts/${g.productId}`,token,fetchImpl),
    appleRead(`/v1/ciWorkflows/${g.workflowId}`,token,fetchImpl),appleRead(`/v1/ciBuildRuns/${env.CI_BUILD_ID}`,token,fetchImpl),
    applePages(`/v1/ciWorkflows/${g.workflowId}/buildRuns?limit=200`,token,fetchImpl)]);
  const tagId=run.data?.relationships?.sourceBranchOrTag?.data?.id;
  if(!/^[A-Za-z0-9-]+$/u.test(tagId ?? '')) fail('TESTFLIGHT_PROVIDER_TAG');
  const tag=await appleRead(`/v1/scmGitReferences/${tagId}`,token,fetchImpl);
  return validateBootstrapAppleObservation({app:app.data,product:product.data,workflow:workflow.data,run:run.data,runs,tag:tag.data},grant,env);
}

export async function verifyInternalTestflightBootstrap(options){
  const env=options.env ?? process.env;
  if(options.repository!==REPO || options.target!=='app-store' || options.tag!==TAG || !['before-build','before-deploy'].includes(options.phase)) fail('TESTFLIGHT_SCOPE');
  const request={env:{...env,GITHUB_API_URL:'https://api.github.com'},token:options.token,fetchImpl:options.fetchImpl ?? globalThis.fetch};
  const reviewed=await reviewedBootstrap(options.bootstrapId,options.verifierSha,request),{grant}=reviewed;
  if(options.repository!==REPO || options.target!=='app-store' || options.tag!==TAG || options.sourceSha!==grant.sourceSha) fail('TESTFLIGHT_SCOPE');
  const releases=await githubPaginate(`/repos/${REPO}/releases?per_page=100`,request);
  const archive=releases.filter(r=>r.tag_name==='development-evidence' && r.draft===true);
  if(archive.length!==1) fail('TESTFLIGHT_DURABLE_ARCHIVE_REQUIRED');
  const assets=await githubPaginate(`/repos/${REPO}/releases/${archive[0].id}/assets?per_page=100`,request);
  const download=async asset=>{
    const actual=assets.filter(a=>a.id===asset.id);
    if(actual.length!==1 || actual[0].size>64*1024*1024) fail('TESTFLIGHT_DURABLE_ASSET_REQUIRED');
    const bytes=await githubDownload(`/repos/${REPO}/releases/assets/${asset.id}`,request);
    if(bytes.length>64*1024*1024 || bootstrapDigest(bytes)!==asset.sha256) fail('TESTFLIGHT_DURABLE_ASSET_CHANGED');
    return bytes;
  };
  const evidenceBytes=await download(grant.evidenceAsset);
  if(evidenceBytes.length>2*1024*1024) fail('TESTFLIGHT_EVIDENCE_TOO_LARGE');
  const document=JSON.parse(evidenceBytes);
  const originalBytes=await Promise.all(grant.originalObservationAssets.map(download));
  const historicalUi5=grant.approvedUiRounds>=6 ? {
    ui5SourceSnapshotBytes:originalBytes[grant.originalObservationAssets.findIndex(a=>equal(a,grant.historicalUi5.sourceSnapshotAsset))],
    ui5ConfigurationBytes:originalBytes[grant.originalObservationAssets.findIndex(a=>equal(a,grant.historicalUi5.configurationAsset))],
  } : {};
  const historicalUi6=grant.approvedUiRounds>=7 ? Object.fromEntries([
    ['ui6SourceSnapshotBytes','sourceSnapshotAsset'],['ui6ConfigurationBytes','configurationAsset'],['ui6ExecutionStartBytes','executionStartAsset'],
    ['ui6FailedSegmentBytes','failedSegmentAsset'],['ui6FailureBytes','failureAsset']]
    .map(([key,asset])=>[key,originalBytes[grant.originalObservationAssets.findIndex(a=>equal(a,grant.historicalUi6[asset]))]])) : {};
  const historicalUi7=grant.approvedUiRounds===8 ? Object.fromEntries(ui7HistoricalAssets
    .map(([asset,key])=>[key,originalBytes[grant.originalObservationAssets.findIndex(a=>equal(a,grant.historicalUi7[asset]))]])) : {};
  const inventoryBytes=await readRemote(REPO,'docs/qa/feature-inventory.json',grant.sourceSha,request);
  const tree=verifyBootstrapWorkingTree(options.appRepository,grant,options.phase);
  const providerProof=await bootstrapProvider(grant,env,request.fetchImpl);
  const context={...options,...reviewed,...tree,...historicalUi5,...historicalUi6,...historicalUi7,inventoryBytes,evidenceBytes,originalEvidenceVerified:true,providerProof,now:new Date().toISOString()};
  // Signed artifact and prior phase receipt are required by the before-deploy validator.
  if(options.phase==='before-deploy'){
    if(!options.artifactFile || !options.artifactReceipt) fail('TESTFLIGHT_ACTUAL_ARTIFACT_REQUIRED');
    context.artifactProof=inspectBootstrapArtifact(options.artifactFile,providerProof,grant,options.appRepository);
    context.beforeBuildReceipt=JSON.parse(readFileSync(options.artifactReceipt,'utf8'));
  }
  const result=validateInternalTestflightBootstrapEvidence(document,context);
  if(!result.ok) fail(result.errors.join('\n'));
  return result;
}

export function readBootstrapPlist(bytes){
  // Apple 프로필의 Data/Date도 보존한다. plutil의 JSON 변환은 Data를 거부한다.
  const parser='import sys,plistlib,json,base64,datetime\ndef encode(v):\n if isinstance(v,bytes): return base64.b64encode(v).decode("ascii")\n if isinstance(v,(datetime.datetime,datetime.date)): return v.isoformat()\n raise TypeError("unsupported plist value")\njson.dump(plistlib.loads(sys.stdin.buffer.read()),sys.stdout,default=encode)';
  try{return JSON.parse(execFileSync('python3',['-c',parser],{input:bytes,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']}));}
  catch{fail('TESTFLIGHT_PLIST_INVALID');}
}
const plistJson=(file,bytes)=>readBootstrapPlist(bytes ?? readFileSync(file));
export function validateBootstrapProfileSigner(profile,certificate){
  if(!Buffer.isBuffer(certificate) || !certificate.length || !Array.isArray(profile?.DeveloperCertificates)
    || !profile.DeveloperCertificates.some(c=>typeof c==='string' && Buffer.from(c,'base64').equals(certificate))) fail('TESTFLIGHT_PROFILE_SIGNER_MISMATCH');
}
export function validateBootstrapSigningEntitlements(entitlements){
  if(entitlements?.['application-identifier']!==`HCDUXX4Z3X.${BUNDLE}`
    || entitlements['com.apple.developer.team-identifier']!=='HCDUXX4Z3X'
    || entitlements['get-task-allow']!==false) fail('TESTFLIGHT_SIGNED_ENTITLEMENTS_INVALID');
}
export function inspectBootstrapArtifact(directory,provider,grant,repository){
  const app=realpathSync(directory),stat=lstatSync(directory);
  if(!stat.isDirectory() || stat.isSymbolicLink() || !app.endsWith('.app')) fail('TESTFLIGHT_SIGNED_APP_DIRECTORY_REQUIRED');
  try{execFileSync('codesign',['--verify','--deep','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "HCDUXX4Z3X"',app],{stdio:'pipe',timeout:30000});}
  catch{fail('TESTFLIGHT_SIGNATURE_INVALID');}
  let signedEntitlements;
  try{signedEntitlements=plistJson(null,execFileSync('codesign',['--display','--entitlements',':-',app],{maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe'],timeout:10000}));}
  catch{fail('TESTFLIGHT_SIGNED_ENTITLEMENTS_INVALID');}
  validateBootstrapSigningEntitlements(signedEntitlements);
  const info=plistJson(join(app,'Info.plist'));
  const profileBytes=readFileSync(join(app,'embedded.mobileprovision'));
  if(bootstrapDigest(profileBytes)!==grant.profileSha256) fail('TESTFLIGHT_EXISTING_PROFILE_REQUIRED');
  let decoded;
  try{decoded=execFileSync('security',['cms','-D','-i',join(app,'embedded.mobileprovision')],{maxBuffer:8*1024*1024,stdio:'pipe',timeout:10000});}
  catch{fail('TESTFLIGHT_PROFILE_INVALID');}
  const profile=plistJson(null,decoded);
  const certificateDir=mkdtempSync(join(tmpdir(),'spiritgate-signature-'));
  try{
    const prefix=join(certificateDir,'certificate-');
    execFileSync('codesign',['--display','--extract-certificates',prefix,app],{stdio:'pipe',timeout:10000});
    validateBootstrapProfileSigner(profile,readFileSync(`${prefix}0`));
  }catch{fail('TESTFLIGHT_PROFILE_SIGNER_MISMATCH');}
  finally{rmSync(certificateDir,{recursive:true,force:true});}
  if(info.CFBundleIdentifier!==BUNDLE || info.CFBundleShortVersionString!=='1.1.0' || String(info.CFBundleVersion)!==String(provider.buildNumber)
    || info.MinimumOSVersion!=='15.0' || !equal(info.UIDeviceFamily,[1]) || info.GADApplicationIdentifier!=='ca-app-pub-9932778305312246~7188570270'
    || !info.NSUserTrackingUsageDescription || !Array.isArray(info.SKAdNetworkItems) || !info.SKAdNetworkItems.length
    || profile.UUID!=='4f3e6181-409d-4651-8187-9700610a0c4e' || !profile.TeamIdentifier?.includes('HCDUXX4Z3X')
    || profile.Entitlements?.['application-identifier']!==`HCDUXX4Z3X.${BUNDLE}` || profile.Entitlements?.['get-task-allow']!==false
    || profile.ProvisionedDevices!==undefined || profile.ProvisionsAllDevices===true) fail('TESTFLIGHT_ARTIFACT_METADATA');
  try{
    execFileSync('python3',[join(repository,'tools/validate_ios_privacy_manifest.py'),'validate-tree',app],{stdio:'pipe',timeout:30000});
    execFileSync('bash',[join(repository,'scripts/validate_admob_artifact.sh')],{env:{...process.env,PROJECT_DIR:repository,ADMOB_TARGET_PLATFORM:'iOS',IOS_APP_PATH:app},stdio:'pipe',timeout:30000});
  }catch{fail('TESTFLIGHT_ARTIFACT_SDK_PRIVACY');}
  const entries=[];
  const walk=path=>{
    for(const name of readdirSync(path).sort()){
      const file=join(path,name),meta=lstatSync(file),local=relative(app,file);
      if(meta.isSymbolicLink()){
        const target=relative(app,realpathSync(file));
        if(target==='..' || target.startsWith('../') || isAbsolute(target)) fail('TESTFLIGHT_ARTIFACT_SYMLINK_ESCAPE');
        entries.push([local,'symlink',readlinkSync(file)]);
      }else if(meta.isDirectory()) walk(file);
      else if(meta.isFile()) entries.push([local,'file',bootstrapDigest(readFileSync(file))]);
      else fail('TESTFLIGHT_ARTIFACT_FILE_TYPE');
    }
  };walk(app);
  return {verified:true,sourceSha:grant.sourceSha,buildId:provider.buildId,buildNumber:provider.buildNumber,
    bundleId:BUNDLE,version:'1.1.0',sha256:bootstrapDigest(Buffer.from(JSON.stringify(entries))),digestScope:'signed-app-tree-files-and-symlinks',profileSha256:grant.profileSha256};
}

// 처리된 내부 전용 빌드만 기존 내부 그룹으로 보낸다. App Review/외부 그룹에는 사용할 수 없다.
export function validateBootstrapProcessedBuild(build,preReleaseVersion,group,receipt,run,runBuildIds){
  if(receipt?.ok!==true || receipt.scope!=='internal_testflight_only' || receipt.productE2eStatus!=='blocked'
    || receipt.repository!==REPO || receipt.target!=='app-store' || receipt.phase!=='before-deploy'
    || build?.attributes?.buildAudienceType!=='INTERNAL_ONLY' || build.attributes.processingState!=='VALID'
    || build.relationships?.app?.data?.id!==PROVIDER.appId || String(build.attributes.version)!==String(receipt.buildNumber)
    || preReleaseVersion?.attributes?.version!=='1.1.0' || preReleaseVersion.id!==build.relationships?.preReleaseVersion?.data?.id
    || run?.id!==receipt.buildId || run.attributes?.completionStatus!=='SUCCEEDED' || run.attributes?.sourceCommit?.commitSha!==receipt.sourceSha
    || !Array.isArray(runBuildIds) || !runBuildIds.includes(build.id)
    || group?.attributes?.isInternalGroup!==true || group.relationships?.app?.data?.id!==PROVIDER.appId)
    fail('TESTFLIGHT_PROCESSED_INTERNAL_BUILD_REQUIRED');
  return {ok:true,scope:'internal_testflight_only',buildId:build.id,groupId:group.id,productE2eStatus:'blocked'};
}
