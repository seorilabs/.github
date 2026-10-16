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
const legacyEditorSchema=JSON.parse(readFileSync(new URL('../../contracts/development-evidence-v1.schema.json',import.meta.url)));
// 정적 인수조건·TDD·원래 회차 구조는 재사용하고, 생략한 Editor 실행을 통과로 바꾸지 않는다.
const validSkippedEditor=ajv.compile({...legacyEditorSchema,$id:'https://github.com/seorilabs/.github/contracts/mac-editor-skip-metadata',
  required:[...legacyEditorSchema.required,'status'],properties:{...legacyEditorSchema.properties,status:{const:'skipped_incomplete'},
    e2e:{type:'object',additionalProperties:false,required:['status','environment','reason'],properties:{status:{const:'skipped'},
      environment:{type:'object',additionalProperties:false,required:['kind'],properties:{kind:{const:'godot-editor'}}},reason:{type:'string',minLength:1}}}}});

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
  let macSkip=null;
  if(grant.macEditorSkip){try{macSkip=validateMacEditorSkipHistory(document,grant,context,inventory,now);}catch(error){return {ok:false,errors:[...new Set([...errors,error.message])]};}}
  else if(document.macEditorSkip) errors.push('TESTFLIGHT_MAC_SKIP_REVIEWED_APPROVAL_REQUIRED');
  if(!macSkip){
    const editor = validateDevelopmentEvidence(document.editor,{...context,featureInventory:inventory,requireUi:true});
    if (!editor.ok) errors.push(...editor.errors.map(e=>`TESTFLIGHT_EDITOR ${e}`));
  }
  const approvedUiRounds=grant.approvedUiRounds ?? 4;
  reject(document.editor?.iterations?.length === approvedUiRounds && document.editor?.e2e?.environment?.kind === 'godot-editor','TESTFLIGHT_APPROVED_UI_EDITOR_REQUIRED');
  const last=document.editor?.iterations?.[approvedUiRounds-1];
  const extra=(document.editor?.iterations ?? []).slice(3,approvedUiRounds);
  reject(extra.length===approvedUiRounds-3 && extra.every(round=>(approvedUiRounds===10 && round?.number===9) || Date.parse(round?.completedAt)-Date.parse(round?.startedAt) <= 210*60000),'TESTFLIGHT_APPROVED_UI_BUDGET');
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
          const seventh=approvedUiRounds>=8 ? validateBootstrapHistoricalUi7(grant,context,document.editor.iterations[6])
            : validateBootstrapUi7Approval(grant,context.ui7ApprovalBytes,context.ui7ProposalBytes),ui7At=Date.parse(seventh.approvalRecordedAt);
          reject(approvals.some(a=>a.maxRound===7 && a.approvedAt===utc(seventh.approvalRecordedAt) && a.evidence===grant.ui7ApprovalFile),'TESTFLIGHT_UI7_EDITOR_APPROVAL');
          reject(Number.isFinite(ui7At) && ui6At<=ui7At && ui7At<=now && ui7At<=Date.parse(document.editor.iterations[6]?.plannedAt),'TESTFLIGHT_UI7_APPROVAL_TIME');
          reject(document.editor.iterations[6]?.sourceSha===(approvedUiRounds>=8 ? grant.historicalUi7.sourceSha : grant.sourceSha),'TESTFLIGHT_UI7_SOURCE');
          if(approvedUiRounds>=8){
            const eighth=approvedUiRounds>=9 ? validateBootstrapHistoricalUi8(grant,context,document.editor.iterations[7])
              : validateBootstrapUi8Approval(grant,context.ui8ApprovalBytes,context.ui8ProposalBytes,context.ui8HumanApprovalBytes),ui8At=Date.parse(eighth.approvalRecordedAt);
            reject(approvals.some(a=>a.maxRound===8 && a.approvedAt===utc(eighth.approvalRecordedAt) && a.evidence===grant.ui8ApprovalFile),'TESTFLIGHT_UI8_EDITOR_APPROVAL');
            reject(Number.isFinite(ui8At) && ui7At<=ui8At && Date.parse(seventh.historicalRecordedAt)<=ui8At && ui8At<=now && ui8At<=Date.parse(document.editor.iterations[7]?.plannedAt),'TESTFLIGHT_UI8_APPROVAL_TIME');
            reject(document.editor.iterations[7]?.sourceSha===(approvedUiRounds>=9 ? grant.historicalUi8.sourceSha : grant.sourceSha),'TESTFLIGHT_UI8_SOURCE');
            if(approvedUiRounds>=9){
              const ninth=approvedUiRounds===10 ? validateBootstrapHistoricalUi9(grant,context,document.editor.iterations[8])
                : validateBootstrapUi9Approval(grant,context.ui9ApprovalBytes,context.ui9ProposalBytes,context.ui9HumanApprovalBytes),round9=document.editor.iterations[8];
              reject(approvals.some(a=>a.maxRound===9 && a.approvedAt===utc(ninth.approvalRecordedAt) && a.evidence===grant.ui9ApprovalFile),'TESTFLIGHT_UI9_EDITOR_APPROVAL');
              reject(orderedBootstrapTimes(eighth.approvalRecordedAt,ninth.approvalRecordedAt,at)
                && orderedBootstrapTimes(eighth.historicalRecordedAt,ninth.approvalRecordedAt,round9?.plannedAt),'TESTFLIGHT_UI9_APPROVAL_TIME');
              reject(round9?.sourceSha===(approvedUiRounds===10 ? grant.historicalUi9.sourceSha : grant.sourceSha),'TESTFLIGHT_UI9_SOURCE');
              if(approvedUiRounds===9){
                const handoff=ninth.operatorHandoff;
                reject(orderedBootstrapTimes(ninth.approvalRecordedAt,round9?.startedAt,handoff.directedAt,round9?.completedAt,at) && orderedBootstrapTimes(round9?.completedAt,handoff.absoluteMaximumAt)
                  && utc(handoff.sameStartedAt)===utc(round9?.startedAt) && compareBootstrapTimes(round9?.startedAt,handoff.mainDeadlineAt,180*60)===0 && compareBootstrapTimes(round9?.startedAt,handoff.absoluteMaximumAt,210*60)===0
                  && [handoff.mainDeadlineAt,handoff.absoluteMaximumAt].every(value=>utc(value)?.slice(19)===utc(round9?.startedAt)?.slice(19)),'TESTFLIGHT_UI9_HANDOFF_TIME');
              }else{
                const tenth=validateBootstrapUi10Approval(macSkip ? {...grant,sourceSha:macSkip.skippedSourceSha,configurationFingerprint:macSkip.skippedConfigurationFingerprint} : grant,context.ui10ApprovalBytes,context.ui10ProposalBytes,context.ui10HumanApprovalBytes);
                reject(approvals.some(a=>a.maxRound===10 && a.approvedAt===utc(tenth.approvalRecordedAt) && a.evidence===grant.ui10ApprovalFile),'TESTFLIGHT_UI10_EDITOR_APPROVAL');
                reject(orderedBootstrapTimes(ninth.historicalRecordedAt,tenth.approvalRecordedAt,last?.plannedAt,last?.startedAt,last?.completedAt,at)
                  && compareBootstrapTimes(last?.startedAt,last?.completedAt,210*60)>=0,'TESTFLIGHT_UI10_APPROVAL_TIME');
                reject(last?.sourceSha===(macSkip ? macSkip.skippedSourceSha : grant.sourceSha),'TESTFLIGHT_UI10_SOURCE');
              }
            }
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
  let cloudRecovery=null;
  if(grant.cloud12Recovery){try{cloudRecovery=validateCloud12RecoveryApproval(grant,context.cloud12RecoveryApprovalBytes,context.cloud12RecoveryProposalBytes,at);}catch(error){errors.push(error.message);}}
  reject(equal(grant.provider,PROVIDER) && provider?.verified === true && provider.internalOnly === true && provider.sourceSha === context.sourceSha
    && provider.workflowId === PROVIDER.workflowId && provider.productId === PROVIDER.productId && provider.matchingBuildCount === (grant.cloud12Recovery ? 2 : 1)
    && typeof provider.buildId === 'string' && provider.buildId.length > 0 && Number.isSafeInteger(provider.buildNumber) && provider.buildNumber > 0,'TESTFLIGHT_PROVIDER_INTERNAL_ONLY');
  if(grant.cloud12Recovery) reject(cloudRecovery?.verified===true && provider?.recoveryVerified===true
    && provider.previousFailedRunId===grant.cloud12Recovery.previousRun.id && provider.buildNumber===13,'TESTFLIGHT_CLOUD12_PROVIDER');
  if (context.phase === 'before-deploy') {
    const artifact=context.artifactProof,previous=context.beforeBuildReceipt;
    reject(artifact?.verified === true && artifact.sourceSha === context.sourceSha && artifact.buildId === provider?.buildId
      && artifact.buildNumber === provider?.buildNumber && artifact.bundleId === BUNDLE && artifact.version === '1.1.0'
      && DIGEST.test(artifact.sha256 ?? ''),'TESTFLIGHT_ACTUAL_ARTIFACT_REQUIRED');
    if(grant.cloud12Recovery) reject(previous?.cloudRecoveryApprovalSha256===grant.cloud12Recovery.approvalSha256
      && previous.previousFailedRunId===grant.cloud12Recovery.previousRun.id && previous.cloudAttemptCount===2 && previous.cloudAttemptLimit===2 && previous.uploadLimit===1,'TESTFLIGHT_CLOUD12_RECEIPT');
    reject(previous?.ok === true && previous.phase === 'before-build' && previous.decisionStatus === 'human_exception'
      && previous.productE2eStatus === 'blocked' && previous.nativeQaWaived === false && previous.scope === 'internal_testflight_only' && previous.sourceSha === context.sourceSha && previous.buildId === provider?.buildId
      && previous.buildNumber === provider?.buildNumber && previous.configurationFingerprint === context.configurationFingerprint
      && previous.grantSha256 === context.grantSha256
      && (!macSkip || previous.macEditorSkipApprovalSha256===grant.macEditorSkip.approvalSha256 && previous.editorStatus==='skipped_incomplete' && previous.editorE2eStatus==='skipped' && previous.publicReleaseAllowed===false),'TESTFLIGHT_SAME_BUILD_RECEIPT');
  }
  if (errors.length) return {ok:false,errors:[...new Set(errors)]};
  return {ok:true,errors:[],decisionStatus:'human_exception',productE2eStatus:'blocked',scope:'internal_testflight_only',repository:REPO,
    sourceSha:context.sourceSha,target:'app-store',phase:context.phase,configurationFingerprint:context.configurationFingerprint,
    grantSha256:context.grantSha256,completedAt:macSkip ? android.completedAt : document.editor.e2e.completedAt,verifiedAt:new Date(now).toISOString(),
    buildId:provider.buildId,buildNumber:provider.buildNumber,androidStatus:'passed',iosStatus:'deferred',nativeQaWaived:false,
    ...(grant.cloud12Recovery ? {cloudRecoveryApprovalSha256:cloudRecovery.approvalSha256,previousFailedRunId:provider.previousFailedRunId,cloudAttemptCount:provider.matchingBuildCount,cloudAttemptLimit:2,uploadLimit:1} : {}),
    approvedUiRounds,additionalUiApprovalSha256:approvedUiRounds>=5 ? grant.additionalUiApprovalSha256 : null,
    ...(approvedUiRounds>=6 ? {ui6ApprovalSha256:grant.ui6ApprovalSha256} : {}),
    ...(approvedUiRounds>=7 ? {ui7ApprovalSha256:grant.ui7ApprovalSha256} : {}),
    ...(approvedUiRounds>=8 ? {ui8ApprovalSha256:grant.ui8ApprovalSha256} : {}),
    ...(approvedUiRounds>=9 ? {ui9ApprovalSha256:grant.ui9ApprovalSha256} : {}),
    ...(approvedUiRounds===10 ? {ui10ApprovalSha256:grant.ui10ApprovalSha256} : {}),
    ...(macSkip ? {editorStatus:'skipped_incomplete',editorE2eStatus:'skipped',macEditorSkipApprovalSha256:grant.macEditorSkip.approvalSha256,publicReleaseAllowed:false,completedAtScope:'actual-android-foundation'} : {})};
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
const ui9ProposalPath='docs/design/2026-10-16-spiritgate-ui9/approved-proposal.md';
const ui9HumanApprovalPath='docs/design/2026-10-16-spiritgate-ui9/human-approval.json';
const ui9ImplementationApprovalPath='docs/design/2026-10-16-spiritgate-ui9/implementation-approval.json';
const ui10ProposalPath='docs/design/2026-10-16-spiritgate-ui10/approved-proposal.md';
const ui10HumanApprovalPath='docs/design/2026-10-16-spiritgate-ui10/human-approval.json';
const macSkipProposalPath='docs/design/2026-10-16-spiritgate-mac-editor-skip/approved-proposal.md';
const macSkipHumanApprovalPath='docs/design/2026-10-16-spiritgate-mac-editor-skip/human-approval.json';
const utc=value=>typeof value==='string' ? value.replace(/\+00:00$/u,'Z') : null;
// UI9 이후와 그 실패 이력의 순서만 비교하며 Date.parse에 소수부를 넘기지 않는다.
function bootstrapTime(value){
  const m=typeof value==='string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if(!m) return null;
  const second=Date.parse(m[1]+m[3]),zone=m[3]==='Z' ? 0 : (m[3][0]==='-' ? -1 : 1)*(Number(m[3].slice(1,3))*60+Number(m[3].slice(4,6)))*60000;
  if(!Number.isFinite(second) || new Date(second+zone).toISOString().slice(0,19)!==m[1]) return null;
  return {second,fraction:m[2] ?? ''};
}
function compareBootstrapTimes(left,right,shiftSeconds=0){
  const a=bootstrapTime(left),b=bootstrapTime(right);
  if(!a || !b) return null;
  const shifted=a.second+shiftSeconds*1000;
  if(shifted!==b.second) return shifted<b.second ? -1 : 1;
  const width=Math.max(a.fraction.length,b.fraction.length),x=a.fraction.padEnd(width,'0'),y=b.fraction.padEnd(width,'0');
  return x===y ? 0 : x<y ? -1 : 1;
}
const orderedBootstrapTimes=(...values)=>values.slice(1).every((value,i)=>{const order=compareBootstrapTimes(values[i],value);return order!==null && order<=0;});
const bootstrapPolicy=parse(readFileSync(join(root,policyPath),'utf8'));
const grantPaths=bootstrapPolicy.internalTestflightBootstrap?.grantRegistry ?? [];
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
  // 실패한 UI6 원문이 보존한 분리 창 -> 내장 창 전환만 별도 대조한다.
  // 정상 검수의 설정 일치 조건이나 UI6 실패 판정을 통과로 바꾸지 않는다.
  const displays=configuration.runtimeDisplayHistory;
  const preservedFailedDisplayChange=Boolean(grant.macEditorSkip && round?.functional?.status==='failed' && round?.ux?.status==='failed'
    && Array.isArray(displays) && displays.length===2 && displays.every(v=>v && typeof v==='object' && !Array.isArray(v))
    && DIGEST.test(start.configurationFingerprint ?? '')
    && displays[0].kind==='native-separate-window' && displays[0].configurationFingerprint===start.configurationFingerprint
    && Number.isSafeInteger(displays[0].firstRunPid) && displays[0].firstRunPid>0 && displays[0].gameInputs===0
    && utc(displays[0].startedAt)===utc(start.startedAt)
    && displays[1].kind==='editor-embedded-fixed-size' && displays[1].globalSettingsChanged===false
    && typeof displays[1].recoveryAuthorizedBy==='string' && displays[1].recoveryAuthorizedBy.trim()
    && orderedBootstrapTimes(start.startedAt,displays[0].stoppedAt,displays[1].recoveryAt,end.stopConfirmedByUtc));
  if([source,configuration,start,end,failure].some(v=>v.sourceSha!==h.sourceSha)
    || configuration.fingerprint!==h.configurationFingerprint || (start.configurationFingerprint!==h.configurationFingerprint && !preservedFailedDisplayChange)
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

const ui8HistoricalAssets=[
  ['sourceSnapshotAsset','ui8SourceSnapshotBytes','preparation/source-before.json'],['configurationAsset','ui8ConfigurationBytes','configuration.json'],
  ['frozenManifestAsset','ui8FrozenManifestBytes','preparation/frozen-manifest.json'],['executionStartAsset','ui8ExecutionStartBytes','execution-start.json'],
  ['sourceIntegrityAsset','ui8SourceIntegrityBytes','final-preserved/final-source-and-settings-check.json'],['resultAsset','ui8ResultBytes','ui8-result.json'],
  ['cleanupAsset','ui8CleanupBytes','process-cleanup-receipt.json'],['manifestAsset','ui8ManifestBytes','ui8-evidence-manifest.json'],
];
function validateBootstrapHistoricalUi8(grant,context,round){
  const h=grant.historicalUi8,objects=[];
  for(const [asset,key]of ui8HistoricalAssets){
    const bytes=context[key];
    if(!Buffer.isBuffer(bytes) || bootstrapDigest(bytes)!==h[asset].sha256 || !grant.originalObservationAssets.some(a=>equal(a,h[asset]))) fail('TESTFLIGHT_UI8_SNAPSHOT_CHANGED');
    let value;try{value=JSON.parse(bytes);}catch{fail('TESTFLIGHT_INVALID_UI8_SNAPSHOT');}
    if(!value || typeof value!=='object' || Array.isArray(value)) fail('TESTFLIGHT_INVALID_UI8_SNAPSHOT');
    objects.push(value);
  }
  const [source,cfg,frozen,start,integrity,result,cleanup,manifest]=objects;
  if([source,cfg,frozen,start,integrity,result,manifest].some(v=>v.sourceSha!==h.sourceSha)
    || cfg.fingerprint!==h.configurationFingerprint || cfg.nativeMarketFingerprint!==null || cfg.firstEditorLaunchOccurred!==false
    || frozen.configurationFingerprint!==h.configurationFingerprint || frozen.configurationSha256!==h.configurationAsset.sha256 || frozen.firstEditorLaunchOccurred!==false
    || start.configurationFingerprint!==h.configurationFingerprint || start.configurationSha256!==h.configurationAsset.sha256 || start.planSha256!==frozen.planSha256
    || result.configuration?.frozenFingerprint!==h.configurationFingerprint || result.configuration?.sha256!==h.configurationAsset.sha256 || result.configuration?.nativeMarketFingerprint!==null) fail('TESTFLIGHT_UI8_SNAPSHOT_SCOPE');
  const files=source.files,project=Array.isArray(files) ? files.find(f=>f.path==='project.godot')?.sha256 : undefined;
  const declared=list=>Array.isArray(list) && list.length===1 && list[0]?.path==='project.godot' && typeof project==='string' && DIGEST.test(project)
    && list[0].sourceSha256===project && Array.isArray(cfg.configs) && cfg.configs.some(c=>typeof c.sha256==='string' && DIGEST.test(c.sha256) && c.sha256===list[0].qaSha256);
  if(!Array.isArray(files) || !files.length || !files.every(f=>safePath(f.path) && typeof f.sha256==='string' && DIGEST.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes>=0)
    || new Set(files.map(f=>f.path)).size!==files.length || cfg.trackedSourceCount!==files.length || frozen.sourceTrackedFiles!==files.length || integrity.trackedChecked!==files.length
    || !equal(frozen.trackedMissing,[]) || !equal(integrity.missing,[]) || !declared(frozen.trackedDeclaredQaDifference) || !declared(integrity.trackedDeclaredDifference)
    || !cfg.helperHashes || !Object.keys(cfg.helperHashes).length || !sameIds(Object.keys(cfg.helperHashes),Object.keys(frozen.frozenHelpers ?? {}))
    || !Object.entries(cfg.helperHashes).every(([path,hash])=>typeof hash==='string' && DIGEST.test(hash) && frozen.frozenHelpers[path]===hash && integrity.helperHashes?.[path]?.frozen===hash && integrity.helperHashes[path].actual===hash)
    || !cfg.diagnosticFiles || !Object.keys(cfg.diagnosticFiles).length || !Object.values(cfg.diagnosticFiles).every(hash=>typeof hash==='string' && DIGEST.test(hash)) || !equal(cfg.diagnosticFiles,frozen.frozenDiagnosticFiles)
    || !Array.isArray(integrity.diagnosticHashesAfterEditorRun) || !sameIds(integrity.diagnosticHashesAfterEditorRun.map(f=>f.path),Object.keys(cfg.diagnosticFiles))
    || !integrity.diagnosticHashesAfterEditorRun.every(f=>f.frozenSha256===cfg.diagnosticFiles[f.path] && typeof f.actualSha256==='string' && DIGEST.test(f.actualSha256) && (f.path==='project.godot' || f.actualSha256===f.frozenSha256))
    || typeof cfg.binarySha256!=='string' || !DIGEST.test(cfg.binarySha256) || frozen.engineBinarySha256!==cfg.binarySha256 || integrity.binaryHashUnchanged!==true
    || typeof cfg.globalEditorSettingsAtDiagnosticBaselineSha256!=='string' || !DIGEST.test(cfg.globalEditorSettingsAtDiagnosticBaselineSha256)
    || integrity.globalDiagnosticBaseline!==cfg.globalEditorSettingsAtDiagnosticBaselineSha256 || integrity.globalAfterUi8!==integrity.globalDiagnosticBaseline
    || integrity.globalUnchangedDuringNewUi8Engine!==true || integrity.isolatedProductProfileAbsent!==true) fail('TESTFLIGHT_UI8_SOURCE_HISTORY');
  const diagnostic=result.diagnostic,pids=[diagnostic?.gamePid,diagnostic?.editorPid];
  if(result.round!==8 || result.status!=='blocked' || result.verdict!=='FAIL/BLOCKED/INCOMPLETE' || result.approvalConsumed!==true
    || result.productRunCount!==0 || result.problemRecheckCount!==0 || result.E2E!=='notplanned/notrun' || result.ui9!=='notapproved/notrun'
    || !equal(result.featureCounts,{pass:0,fail:0,blocked:28}) || result.matrix?.expected!==168 || result.matrix.actualProductCellsCaptured!==0 || result.matrix.passed!==0 || result.matrix.status!=='notrun-after-diagnostic-block'
    || diagnostic?.count!==1 || diagnostic.actualProbeButtonClicks!==0 || diagnostic.actualScrollCalls!==0 || diagnostic.actualCounter!==0 || diagnostic.noAlternativeHandleNamePidRouteOrRestart!==true
    || round?.functional?.status!=='blocked' || round?.ux?.status!=='blocked' || !pids.every(pid=>Number.isSafeInteger(pid) && pid>0) || new Set(pids).size!==2
    || !equal(result.processCleanup,cleanup) || !Array.isArray(cleanup.events) || !sameIds(cleanup.events.map(e=>e.pid),pids)
    || !cleanup.events.every(e=>e.signal==='SIGTERM' && e.attempt===1 && orderedBootstrapTimes(start.startedAt,e.at,cleanup.at))
    || !Array.isArray(cleanup.verifiedOwnedBefore) || !sameIds(cleanup.verifiedOwnedBefore.map(e=>e.pid),pids)
    || cleanup.verifiedOwnedBefore.find(e=>e.pid===diagnostic.gamePid)?.kind!=='diagnostic-game' || cleanup.verifiedOwnedBefore.find(e=>e.pid===diagnostic.editorPid)?.kind!=='diagnostic-editor'
    || cleanup.requestedPidsAbsent!==true || !equal(cleanup.remainingRequestedPids,[]) || !equal(cleanup.ownedAppProcessRowsAfter,[])
    || cleanup.noCuaQueryAfterTermination!==true || cleanup.noNewProcessStarted!==true || cleanup.noUiInputSent!==true
    || cleanup.productRunCount!==0 || cleanup.diagnosticCount!==1 || cleanup.counterClicks!==0 || cleanup.scrollCalls!==0) fail('TESTFLIGHT_UI8_FAILURE_HISTORY');
  if(!orderedBootstrapTimes(start.plannedAt,frozen.frozenAt,start.startedAt,cleanup.at,integrity.at,result.completedAt,manifest.at,start.diagnosticDeadline)
    || compareBootstrapTimes(start.startedAt,start.diagnosticDeadline,15*60)!==0 || compareBootstrapTimes(start.startedAt,start.mainDeadline,180*60)!==0 || compareBootstrapTimes(start.startedAt,start.outerDeadlineWithSingleRecheck,210*60)!==0
    || start.round!==8 || start.clockStartsBeforeFirstDiagnosticEditorPopen!==true || start.diagnosticCount!==1 || start.diagnosticRestartAllowed!==false
    || result.completedBeforeDiagnosticDeadline!==true || result.clockNotReset!==true || result.unusedBudgetCarryForward!==false
    || !['plannedAt','startedAt','diagnosticDeadline','mainDeadline'].every(key=>utc(result[key])===utc(start[key])) || utc(result.outerDeadline)!==utc(start.outerDeadlineWithSingleRecheck)
    || utc(result.reportedAt)!==utc(result.completedAt) || round?.plannedAt!==utc(start.plannedAt) || round?.startedAt!==utc(start.startedAt) || round?.completedAt!==utc(result.completedAt)) fail('TESTFLIGHT_UI8_ORIGINAL_TIME');
  if(manifest.round!==8 || manifest.verdict!=='FAIL/BLOCKED' || !Array.isArray(manifest.files) || manifest.fileCount!==manifest.files.length
    || new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length
    || !ui8HistoricalAssets.filter(([asset])=>asset!=='manifestAsset').every(([asset,key,path])=>manifest.files.some(f=>f.path===path && f.sha256===h[asset].sha256 && f.bytes===context[key].length))) fail('TESTFLIGHT_UI8_MANIFEST');
  // UI8 당시의 UI9 미승인·제품 미실행과 실패 원문은 새 수동 승인이 생겨도 바꾸지 않는다.
  return {...validateBootstrapUi8Approval({...grant,sourceSha:h.sourceSha,configurationFingerprint:h.configurationFingerprint},context.ui8ApprovalBytes,context.ui8ProposalBytes,context.ui8HumanApprovalBytes),historicalRecordedAt:manifest.at};
}

function validateBootstrapUi9Approval(grant,approvalBytes,proposalBytes,humanBytes){
  if(!Buffer.isBuffer(approvalBytes) || bootstrapDigest(approvalBytes)!==grant.ui9ApprovalSha256) fail('TESTFLIGHT_UI9_APPROVAL_CHANGED');
  let a;try{a=JSON.parse(approvalBytes);}catch{fail('TESTFLIGHT_INVALID_UI9_APPROVAL');}
  if(!a || typeof a!=='object' || Array.isArray(a)) fail('TESTFLIGHT_INVALID_UI9_APPROVAL');
  validateBootstrapApprovalProposal(approvalBytes,proposalBytes);
  if(!Buffer.isBuffer(humanBytes) || bootstrapDigest(humanBytes)!==a.humanApprovalSha256) fail('TESTFLIGHT_UI9_HUMAN_APPROVAL_CHANGED');
  let human;try{human=JSON.parse(humanBytes);}catch{fail('TESTFLIGHT_INVALID_UI9_HUMAN_APPROVAL');}
  if(!human || typeof human!=='object' || Array.isArray(human) || human.originalApprovalSha256!==a.originalApprovalSha256 || human.originalProposalSha256!==a.originalProposalSha256
    || utc(human.approvedAt)!==utc(a.approvalRecordedAt) || !equal(human.operatorHandoff,a.operatorHandoff)) fail('TESTFLIGHT_UI9_HUMAN_APPROVAL_SCOPE');
  const handoff=a.operatorHandoff;
  if(!handoff || typeof handoff!=='object' || Array.isArray(handoff) || handoff.sameRound!==9 || handoff.inputBefore!=='human' || handoff.inputAfter!=='independent-agent'
    || typeof handoff.originalDirectiveSha256!=='string' || !DIGEST.test(handoff.originalDirectiveSha256)
    || [a.originalApprovalSha256,a.originalProposalSha256,a.proposalSha256,grant.ui8ApprovalSha256].includes(handoff.originalDirectiveSha256)
    || handoff.sourceSha!==grant.sourceSha || handoff.configurationFingerprint!==grant.configurationFingerprint || handoff.clockReset!==false
    || handoff.frozenHelpersModified!==false || handoff.newRun!==false || handoff.authorInputCountsAsIndependentReview!==false) fail('TESTFLIGHT_UI9_HANDOFF_SCOPE');
  if(a.kind!=='human_additional_ui_approval' || a.designId!=='SGD-UI9-TF-110-v1' || a.repository!==REPO || a.version!=='1.1.0'
    || a.objective!=='one_additional_ui_round' || a.approvedUiRounds!==9 || a.sourceSha!==grant.sourceSha || a.configurationFingerprint!==grant.configurationFingerprint
    || a.originalTimingApprovalSha256!==grant.approvalSha256 || a.previousUiApprovalSha256!==grant.ui8ApprovalSha256
    || ![a.originalApprovalSha256,a.originalProposalSha256].every(v=>typeof v==='string' && DIGEST.test(v))
    || !a.previousUiObservationSha256 || !sameIds(Object.keys(a.previousUiObservationSha256),ui8HistoricalAssets.map(([asset])=>asset))
    || !ui8HistoricalAssets.every(([asset])=>typeof a.previousUiObservationSha256[asset]==='string' && DIGEST.test(a.previousUiObservationSha256[asset]) && a.previousUiObservationSha256[asset]===grant.historicalUi8[asset].sha256)
    || typeof a.userApprovalVerbatim!=='string' || !a.userApprovalVerbatim.trim()
    || a.inputMode!=='human-then-agent' || a.independentEvaluationRequired!==true
    || a.executionMinutes!==180 || a.issueRecheckMaximumCount!==1 || a.issueRecheckMinutes!==30 || a.totalMinutes!==210
    || a.inputDiagnosticMaximumCount!==0 || a.inputDiagnosticMinutes!==0 || a.inputDiagnosticIncludedInExecutionMinutes!==true
    || a.extendOriginal168Hours!==false) fail('TESTFLIGHT_UI9_APPROVAL_SCOPE');
  return a;
}

const ui9HistoricalAssets=[
  ['sourceSnapshotAsset','ui9SourceSnapshotBytes','preparation/source-before.json'],['configurationAsset','ui9ConfigurationBytes','configuration.json'],
  ['frozenManifestAsset','ui9FrozenManifestBytes','preparation/frozen-manifest.json'],['planAsset','ui9PlanBytes','plan.json'],
  ['executionStartAsset','ui9ExecutionStartBytes','execution-start.json'],['handoffDirectiveAsset','ui9HandoffDirectiveBytes','inspection/agent-takeover-user-directive.json'],
  ['operatorTransitionAsset','ui9OperatorTransitionBytes','inspection/operator-handoff/agent-transition.json'],['projectNormalizationAsset','ui9ProjectNormalizationBytes','inspection/editor-project-normalization.json'],
  ['sourceIntegrityAsset','ui9SourceIntegrityBytes','final/source-integrity.json'],['resultAsset','ui9ResultBytes','final/result.json'],
  ['cleanupAsset','ui9CleanupBytes','process-cleanup-receipt.json'],['originalManifestAsset','ui9OriginalManifestBytes','final/original-manifest.json'],
  ['deliverableManifestAsset','ui9DeliverableManifestBytes','final/deliverable-manifest.json'],
];
function validateBootstrapHistoricalUi9(grant,context,round){
  const h=grant.historicalUi9,objects=[];
  for(const [asset,key]of ui9HistoricalAssets){
    const bytes=context[key];
    if(!Buffer.isBuffer(bytes) || bootstrapDigest(bytes)!==h[asset].sha256 || !grant.originalObservationAssets.some(a=>equal(a,h[asset]))) fail('TESTFLIGHT_UI9_SNAPSHOT_CHANGED');
    let v;try{v=JSON.parse(bytes);}catch{fail('TESTFLIGHT_INVALID_UI9_SNAPSHOT');}
    if(!v || typeof v!=='object' || Array.isArray(v)) fail('TESTFLIGHT_INVALID_UI9_SNAPSHOT');
    objects.push(v);
  }
  const [source,cfg,frozen,plan,start,directive,transition,normalization,integrity,result,cleanup,original,deliverable]=objects;
  const a=validateBootstrapUi9Approval({...grant,sourceSha:h.sourceSha,configurationFingerprint:h.configurationFingerprint},context.ui9ApprovalBytes,context.ui9ProposalBytes,context.ui9HumanApprovalBytes),handoff=a.operatorHandoff;
  let lateApproval;
  if(!Buffer.isBuffer(context.ui9ImplementationApprovalBytes) || bootstrapDigest(context.ui9ImplementationApprovalBytes)!==a.implementationApprovalSha256) fail('TESTFLIGHT_UI9_IMPLEMENTATION_APPROVAL_CHANGED');
  try{lateApproval=JSON.parse(context.ui9ImplementationApprovalBytes);}catch{fail('TESTFLIGHT_INVALID_UI9_IMPLEMENTATION_APPROVAL');}
  if(!lateApproval || typeof lateApproval!=='object' || Array.isArray(lateApproval)) fail('TESTFLIGHT_INVALID_UI9_IMPLEMENTATION_APPROVAL');
  if([source,cfg,plan,start,integrity,cleanup,original].some(v=>v.sourceSha!==h.sourceSha) || result.candidateSourceSha!==h.sourceSha
    || [plan,start,integrity,result,original].some(v=>v.configurationFingerprint!==h.configurationFingerprint) || cfg.fingerprint!==h.configurationFingerprint
    || cfg.editorLaunched!==false || cfg.runStarted!==false || frozen['configuration.json']!==h.configurationAsset.sha256 || frozen['plan.json']!==h.planAsset.sha256
    || integrity.frozenManifestSha256!==h.frozenManifestAsset.sha256 || integrity.sourceBeforeManifestSha256!==h.sourceSnapshotAsset.sha256) fail('TESTFLIGHT_UI9_SNAPSHOT_SCOPE');
  const files=source.files,entries=files && typeof files==='object' && !Array.isArray(files) ? Object.entries(files) : [];
  if(!entries.length || !entries.every(([path,v])=>safePath(path) && typeof v?.sha256==='string' && DIGEST.test(v.sha256))
    || source.trackedCount!==entries.length || cfg.trackedSourceCount!==entries.length || !equal(source.mismatchesExceptDeclaredProject,[])
    || !Object.hasOwn(files,'project.godot') || files['project.godot']?.sha256!==cfg.actualProjectSha256 || typeof cfg.sourceProjectSha256!=='string' || !DIGEST.test(cfg.sourceProjectSha256) || integrity.productTrackedCheckedExceptDeclaredProject!==entries.length-1 || !equal(integrity.productTrackedMismatchExceptDeclaredProject,[]) || !equal(integrity.frozenManifestMismatch,[])
    || !cfg.helperHashes || !Object.keys(cfg.helperHashes).length || !Object.entries(cfg.helperHashes).every(([p,v])=>typeof v==='string' && DIGEST.test(v) && frozen['qa-project/'+p]===v)
    || normalization.declaredConfigurationFingerprint!==h.configurationFingerprint || normalization.declaredProjectSha256!==cfg.actualProjectSha256 || normalization.actualProjectSha256!==integrity.qaProjectGodotAfterEditorSha256
    || typeof normalization.actualProjectSha256!=='string' || !DIGEST.test(normalization.actualProjectSha256) || !cfg.configs?.some(c=>c.sha256===normalization.declaredProjectSha256)
    || normalization.allDeclaredSettingValuesEqual!==true || normalization.autoloadOrderEqual!==true || normalization.sourceOrHelpersModifiedByReviewer!==false || normalization.frozenConfigurationAndManifestPreserved!==true
    || integrity.newRunInputOrProcessDiagnosis!==false || result.sourceAndHelpers?.productTrackedCheckedExceptDeclaredProject!==entries.length-1
    || result.sourceAndHelpers.productMismatchCount!==0 || result.sourceAndHelpers.frozenManifestMismatchCount!==0 || result.sourceAndHelpers.sdkGameRulesAndHelpersChanged!==false) fail('TESTFLIGHT_UI9_SOURCE_HISTORY');
  const clock=result.clock,execution=result.execution,pids=[execution?.runtimePid,execution?.editorPid];
  if(result.round!==9 || result.result!=='incomplete' || result.overallPassed!==false || result.reusablePassingEvidenceForBuildOrRelease!==false || result.finalizationIsNewExecution!==false
    || !equal(result.featureCoverage && {total:result.featureCoverage.total,passed:result.featureCoverage.passed,partial:result.featureCoverage.partial,notRun:result.featureCoverage.notRun},{total:28,passed:0,partial:16,notRun:12})
    || !equal(result.matrixCoverage && {total:result.matrixCoverage.total,passed:result.matrixCoverage.passed,partial:result.matrixCoverage.partial,notRun:result.matrixCoverage.notRun},{total:168,passed:0,partial:18,notRun:150})
    || result.independentReviewer!==round?.reviewer || result.independentReviewer===result.implementer || round?.functional?.status!=='blocked' || round?.ux?.status!=='blocked'
    || !pids.every(pid=>Number.isSafeInteger(pid) && pid>0) || new Set(pids).size!==2 || execution.runtimeRunCount!==1
    || execution.additionalCuAOrAxCgInputAfterDeadline!==0 || execution.newRunOrRoundOrFinalE2eAfterDeadline!==0 || execution.sigkillOrOtherAppInterference!==false
    || result.priorUi8AndEarlierE2eFailuresUnchanged!==true || result.progressAndOriginalsOverwritten!==false
    || clock?.timeExtensionApproved!==false || clock.lateApprovalDoesNotExtendRound!==true || clock.passivePostDeadlineObserverDataCountsAsExecution!==false) fail('TESTFLIGHT_UI9_INCOMPLETE_HISTORY');
  if(bootstrapDigest(context.ui9HandoffDirectiveBytes)!==handoff.originalDirectiveSha256 || utc(directive.directedAt)!==utc(handoff.directedAt)
    || !['sourceSha','configurationFingerprint','sameStartedAt','mainDeadlineAt','absoluteMaximumAt'].every(k=>utc(directive[k])===utc(handoff[k]))
    || directive.sameRound!==9 || directive.clockReset!==false || directive.frozenHelpersModified!==false || directive.newRun!==false || directive.rootControlCountsAsIndependentReview!==false
    || transition.sameRuntimePid!==execution.runtimePid || transition.sameEditorPid!==execution.editorPid || transition.newRunOrClockReset!==false || transition.frozenRawKindHumanPrefixDoesNotDetermineOperator!==true
    || transition.humanLastConfirmedEvent!==directive.previousHumanInputEndsAtEvent || result.operators?.humanThroughEvent!==directive.previousHumanInputEndsAtEvent
    || !equal(result.operators.rootFirstAgentEvents,directive.firstVerifiedRootKeyboardEvents) || transition.rootFirstAgentEvent!==directive.firstVerifiedRootKeyboardEvents?.[0]
    || result.operators.independentAgentFromEvent!==Math.max(...(directive.firstVerifiedRootKeyboardEvents ?? []))+1) fail('TESTFLIGHT_UI9_OPERATOR_HISTORY');
  if(!Array.isArray(cleanup.actions) || !sameIds(cleanup.actions.map(e=>e.pid),pids)
    || !cleanup.actions.every(e=>e.signal==='SIGTERM' && e.signalSent===true && e.absentAfter===true && orderedBootstrapTimes(cleanup.startedAt,e.sentAt,e.checkedAt,cleanup.finishedAt)
      && typeof cleanup.processes?.[e.pid]?.expectedCommand==='string' && cleanup.processes[e.pid].expectedCommand.length>0 && cleanup.processes[e.pid].observedIdentity?.endsWith(cleanup.processes[e.pid].expectedCommand))
    || cleanup.inputPosted!==0 || cleanup.newRuns!==0 || cleanup.forceKill!==false || cleanup.otherAppsTouched!==false
    || execution.terminationReceiptSha256!==h.cleanupAsset.sha256 || !pids.every((pid,i)=>utc(cleanup.actions.find(e=>e.pid===pid)?.sentAt)===utc(execution[i===0?'runtimeSigtermAt':'editorSigtermAt']))) fail('TESTFLIGHT_UI9_CLEANUP_HISTORY');
  if(plan.round!==9 || start.round!==9 || plan.mainMinutes!==180 || plan.singleProblemRecheckMinutes!==30 || plan.maximumMinutes!==210 || plan.automaticInputDiagnostics!==0 || plan.priorUi8FailurePreserved!==true
    || !sameIds(plan.features?.map(f=>f.id),JSON.parse(context.inventoryBytes).features.map(f=>f.id)) || plan.matrix?.locales?.length!==7 || plan.matrix.developmentDisplaySizes?.length!==3 || plan.matrix.requiredPanels?.length!==8
    || start.operator!=='human' || start.reviewer!==result.independentReviewer || start.singleRecheckMinutes!==30 || start.newAutomatedInputDiagnostics!==0
    || clock.mainMinutes!==180 || clock.singleProblemRecheckMinutes!==30 || clock.maximumMinutes!==210
    || !['startedAt','mainDeadlineAt','absoluteMaximumAt'].every(k=>utc(clock[k])===utc(start[k])) || utc(clock.plannedAt)!==utc(plan.plannedAt)
    || utc(handoff.sameStartedAt)!==utc(start.startedAt) || utc(handoff.mainDeadlineAt)!==utc(start.mainDeadlineAt) || utc(handoff.absoluteMaximumAt)!==utc(start.absoluteMaximumAt)
    || compareBootstrapTimes(start.startedAt,start.mainDeadlineAt,180*60)!==0 || compareBootstrapTimes(start.startedAt,start.absoluteMaximumAt,210*60)!==0
    || !orderedBootstrapTimes(a.approvalRecordedAt,cfg.preparationFrozenAt,plan.plannedAt,start.startedAt,handoff.directedAt,transition.recordedAt,clock.lastProductKeyAt,clock.lastInputResultAt,start.absoluteMaximumAt)
    || !orderedBootstrapTimes(start.startedAt,clock.lastActualCaptureAt,clock.lastReadOnlyProgressAt,start.absoluteMaximumAt)
    || !orderedBootstrapTimes(start.startedAt,normalization.observedAt,start.absoluteMaximumAt)
    || compareBootstrapTimes(start.absoluteMaximumAt,clock.lateInputMethodAndCentralCorrectionApprovalAt)!==-1 || utc(clock.lateInputMethodAndCentralCorrectionApprovalAt)!==utc(lateApproval.approvedAt)
    || !orderedBootstrapTimes(lateApproval.approvedAt,cleanup.startedAt,cleanup.finishedAt,integrity.auditedAt,original.createdAt,result.finalizedAt,deliverable.createdAt)
    || compareBootstrapTimes(start.startedAt,result.finalizedAt,210*60)!==-1
    || round?.plannedAt!==utc(plan.plannedAt) || round?.startedAt!==utc(start.startedAt) || round?.completedAt!==utc(result.finalizedAt)) fail('TESTFLIGHT_UI9_EXPIRED_TIME');
  const validManifest=m=>Array.isArray(m.files) && new Set(m.files.map(f=>f.path)).size===m.files.length && m.files.every(f=>safePath(f.path) && typeof f.sha256==='string' && DIGEST.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes>=0);
  if(!validManifest(original) || !validManifest(deliverable) || original.allStableDuringHash!==true || !original.files.every(f=>f.stableDuringHash===true)
    || !original.files.some(f=>f.path==='preparation/source-project.godot' && f.sha256===cfg.sourceProjectSha256)
    || result.originals?.manifestSha256!==h.originalManifestAsset.sha256 || result.originals.originalFileCount!==original.files.length || result.originals.allStableDuringHash!==true
    || !ui9HistoricalAssets.filter(([asset])=>asset!=='deliverableManifestAsset').every(([asset,key,path])=>{
      const final=path.startsWith('final/'),m=final?deliverable:original,p=final?path.slice(6):path;
      return m.files.some(f=>f.path===p && f.sha256===h[asset].sha256 && f.bytes===context[key].length);
    })) fail('TESTFLIGHT_UI9_MANIFEST');
  // 210분을 넘긴 원본 실패를 받는다. 늦은 정리·보고는 새 검수가 아니며 UI9 PASS/예산 준수가 아니다.
  return {...a,historicalRecordedAt:deliverable.createdAt};
}
function validateBootstrapUi10Approval(grant,approvalBytes,proposalBytes,humanBytes){
  if(!Buffer.isBuffer(approvalBytes) || bootstrapDigest(approvalBytes)!==grant.ui10ApprovalSha256) fail('TESTFLIGHT_UI10_APPROVAL_CHANGED');
  let a;try{a=JSON.parse(approvalBytes);}catch{fail('TESTFLIGHT_INVALID_UI10_APPROVAL');}
  if(!a || typeof a!=='object' || Array.isArray(a)) fail('TESTFLIGHT_INVALID_UI10_APPROVAL');
  validateBootstrapApprovalProposal(approvalBytes,proposalBytes);
  if(!Buffer.isBuffer(humanBytes) || bootstrapDigest(humanBytes)!==a.humanApprovalSha256) fail('TESTFLIGHT_UI10_HUMAN_APPROVAL_CHANGED');
  let human;try{human=JSON.parse(humanBytes);}catch{fail('TESTFLIGHT_INVALID_UI10_HUMAN_APPROVAL');}
  if(!human || typeof human!=='object' || Array.isArray(human) || human.originalUserRecordSha256!==a.originalApprovalSha256 || human.originalProposalSha256!==a.originalProposalSha256 || utc(human.approvedAt)!==utc(a.approvalRecordedAt)) fail('TESTFLIGHT_UI10_HUMAN_APPROVAL_SCOPE');
  if(a.kind!=='human_additional_ui_approval' || a.designId!=='SGD-UI10-TF-110-v1' || a.repository!==REPO || a.version!=='1.1.0'
    || a.objective!=='one_additional_ui_round' || a.approvedUiRounds!==10 || a.sourceSha!==grant.sourceSha || a.configurationFingerprint!==grant.configurationFingerprint
    || a.originalTimingApprovalSha256!==grant.approvalSha256 || a.previousUiApprovalSha256!==grant.ui9ApprovalSha256
    || ![a.originalApprovalSha256,a.originalProposalSha256].every(v=>typeof v==='string' && DIGEST.test(v))
    || !a.previousUiObservationSha256 || !sameIds(Object.keys(a.previousUiObservationSha256),ui9HistoricalAssets.map(([asset])=>asset))
    || !ui9HistoricalAssets.every(([asset])=>typeof a.previousUiObservationSha256[asset]==='string' && DIGEST.test(a.previousUiObservationSha256[asset]) && a.previousUiObservationSha256[asset]===grant.historicalUi9[asset].sha256)
    || typeof a.userApprovalVerbatim!=='string' || !a.userApprovalVerbatim.trim() || a.inputMode!=='independent-agent' || a.independentEvaluationRequired!==true
    || a.executionMinutes!==180 || a.issueRecheckMaximumCount!==1 || a.issueRecheckMinutes!==30 || a.totalMinutes!==210
    || a.inputDiagnosticMaximumCount!==0 || a.inputDiagnosticMinutes!==0 || a.inputDiagnosticIncludedInExecutionMinutes!==true || a.extendOriginal168Hours!==false) fail('TESTFLIGHT_UI10_APPROVAL_SCOPE');
  return a;
}

const macSkipAssets=[
  ['resultAsset','macSkipResultBytes','final/result.json'],['cleanupAsset','macSkipCleanupBytes','process-cleanup-receipt.json'],
  ['sourceIntegrityAsset','macSkipSourceIntegrityBytes','final/source-helper-final-verification.json'],['firstFailureAsset','macSkipFirstFailureBytes','inspection/first-native-observe/execution-receipt.json'],
  ['originalManifestAsset','macSkipOriginalManifestBytes','final/original-artifact-manifest.json'],['deliverableManifestAsset','macSkipDeliverableManifestBytes','final/deliverables-manifest.json'],
];
function validateMacEditorSkipApproval(grant,bytes,proposalBytes,humanBytes){
  if(!Buffer.isBuffer(bytes) || bootstrapDigest(bytes)!==grant.macEditorSkip.approvalSha256) fail('TESTFLIGHT_MAC_SKIP_APPROVAL_CHANGED');
  let a;try{a=JSON.parse(bytes);}catch{fail('TESTFLIGHT_INVALID_MAC_SKIP_APPROVAL');}
  if(!a || typeof a!=='object' || Array.isArray(a)) fail('TESTFLIGHT_INVALID_MAC_SKIP_APPROVAL');
  validateBootstrapApprovalProposal(bytes,proposalBytes);
  if(!Buffer.isBuffer(humanBytes) || bootstrapDigest(humanBytes)!==a.humanApprovalSha256) fail('TESTFLIGHT_MAC_SKIP_HUMAN_APPROVAL_CHANGED');
  let human;try{human=JSON.parse(humanBytes);}catch{fail('TESTFLIGHT_INVALID_MAC_SKIP_HUMAN_APPROVAL');}
  if(!human || typeof human!=='object' || Array.isArray(human) || human.sourceRecordSha256!==a.originalApprovalSha256 || utc(human.approvedAt)!==utc(a.approvalRecordedAt)
    || human.schemaVersion!==1 || human.kind!=='human_mac_editor_skip_public_minimal_receipt' || human.approvedAnswer!=='막힌 Mac Editor 검수만 생략'
    || human.newMacEditorRoundAuthorized!==false || human.previousInputGuardAmendmentProposal!=='withdrawn without approval or execution'
    || human.physicalDeviceQaWaived!==false || human.e2eWaived!==false || human.publicWithoutNativeQaAuthorized!==false) fail('TESTFLIGHT_MAC_SKIP_HUMAN_SCOPE');
  if(grant.approvedUiRounds!==10 || a.kind!=='human_mac_editor_skip_approval' || a.repository!==REPO || a.version!=='1.1.0' || a.objective!=='first_internal_testflight_mac_editor_skip_only'
    || a.sourceSha!==grant.sourceSha || a.configurationFingerprint!==grant.configurationFingerprint || !SHA.test(a.skippedSourceSha ?? '') || !DIGEST.test(a.skippedConfigurationFingerprint ?? '')
    || !DIGEST.test(a.originalApprovalSha256 ?? '') || a.originalTimingApprovalSha256!==grant.approvalSha256 || a.previousUi10ApprovalSha256!==grant.ui10ApprovalSha256
    || a.originalExpiresAt!==grant.expiresAt || a.editorUiSkipped!==true || a.editorE2eSkipped!==true || a.nativeQaWaived!==false || a.e2eWaived!==false || a.publicReleaseAllowed!==false
    || a.candidateLimit!==1 || a.buildUploadLimit!==1 || a.maxAgeHours!==168 || a.newEditorRoundAllowed!==false || a.inputGuardCorrectionAllowed!==false
    || !a.originalObservationSha256 || !sameIds(Object.keys(a.originalObservationSha256),macSkipAssets.map(([asset])=>asset))
    || !macSkipAssets.every(([asset])=>typeof a.originalObservationSha256[asset]==='string' && DIGEST.test(a.originalObservationSha256[asset]) && a.originalObservationSha256[asset]===grant.macEditorSkip[asset].sha256)) fail('TESTFLIGHT_MAC_SKIP_SCOPE');
  return a;
}
function validateMacEditorSkipHistory(document,grant,context,inventory,now){
  const a=validateMacEditorSkipApproval(grant,context.macSkipApprovalBytes,context.macSkipProposalBytes,context.macSkipHumanApprovalBytes),objects=[];
  const editor=document.editor;
  if(!validSkippedEditor(editor)) fail('TESTFLIGHT_MAC_SKIP_EDITOR_SCHEMA');
  if(editor.repository!==grant.repository || editor.target!=='app-store' || editor.sourceSha!==grant.sourceSha || editor.productKind!=='ui'
    || !editor.implementer.trim() || editor.iterations.some(round=>!round.reviewer.trim())) fail('TESTFLIGHT_MAC_SKIP_EDITOR_SCOPE');
  for(const[asset,key]of macSkipAssets){
    const bytes=context[key];if(!Buffer.isBuffer(bytes) || bootstrapDigest(bytes)!==grant.macEditorSkip[asset].sha256 || !grant.originalObservationAssets.some(ref=>equal(ref,grant.macEditorSkip[asset]))) fail('TESTFLIGHT_MAC_SKIP_SNAPSHOT_CHANGED');
    let v;try{v=JSON.parse(bytes);}catch{fail('TESTFLIGHT_INVALID_MAC_SKIP_SNAPSHOT');}
    if(!v || typeof v!=='object' || Array.isArray(v)) fail('TESTFLIGHT_INVALID_MAC_SKIP_SNAPSHOT');objects.push(v);
  }
  const[result,cleanup,integrity,first,original,deliverable]=objects,last=editor.iterations?.[9];
  if([result,cleanup,integrity,original].some(v=>v.sourceSha!==a.skippedSourceSha) || [result,cleanup,original].some(v=>v.configurationFingerprint!==a.skippedConfigurationFingerprint)
    || result.round!==10 || result.status!=='USER_REQUESTED_SKIPPED_INCOMPLETE' || result.passed!==false || result.actualRunCount!==1
    || result.inputCounts?.nativeCgPosts!==0 || result.inputCounts.confirmedProductStartOrButton!==0 || result.inputCounts.fixture!==0 || result.inputCounts.rawRuntimeKeyEvents!==2
    || !equal(result.functionalCoverage,{pass:0,partial:1,notRun:27,fail:0}) || !equal(result.uxAreaCoverage,{pass:0,partial:1,notRun:167,fail:0}) || result.acceptanceConditionsPassCount!==0
    || result.productSourceUnexpectedMismatch!==0 || result.helperMismatch!==0 || result.frozenMismatchCount!==0 || result.rawTailsModified!==false || result.noAdditionalQaAfterFailure!==true || result.originalProgressFilesUnmodified!==true
    || result.firstBinding?.status!=='FAILED' || result.firstBinding.attempts!==1 || result.firstBinding.retries!==0 || result.firstBinding.exitCode!==2 || result.firstBinding.receiptSha256!==grant.macEditorSkip.firstFailureAsset.sha256
    || first.exitCode!==2 || first.observeAttemptNumber!==1 || first.productInputPosted!==0 || first.retryCount!==0) fail('TESTFLIGHT_MAC_SKIP_ORIGINAL_VERDICT');
  if(integrity.productCodeSdkRulesBalanceSaveIdentifiersEdited!==false || !equal(integrity.unexpectedProductMismatches,[]) || !equal(integrity.frozenMismatches,[]) || integrity.projectQaConfigurationMatchesFrozen!==true
    || !Array.isArray(integrity.files) || integrity.files.length!==integrity.trackedFilesChecked || !integrity.files.length || new Set(integrity.files.map(f=>f.path)).size!==integrity.files.length
    || !integrity.files.every(f=>safePath(f.path) && DIGEST.test(f.sha256 ?? '') && DIGEST.test(f.pristineSha256 ?? '') && (f.declaredQaProjectConfiguration===true ? f.path==='qa-project/project.godot' && f.sha256===integrity.projectQaConfigurationSha256 : f.sha256===f.pristineSha256))
    || !Array.isArray(integrity.helpers) || !integrity.helpers.length || !integrity.helpers.every(h=>safePath(h.path) && DIGEST.test(h.sha256 ?? '') && h.sha256===h.frozenSha256 && h.matches===true)) fail('TESTFLIGHT_MAC_SKIP_SOURCE_HISTORY');
  const pids=[result.gamePid,result.editorPid];
  if(!pids.every(pid=>Number.isSafeInteger(pid) && pid>0) || new Set(pids).size!==2 || cleanup.round!==10 || cleanup.newRuns!==0 || cleanup.inputPosted!==0 || cleanup.firstFailurePreserved!==true || cleanup.forceKill!==false || cleanup.otherAppsTouched!==false || cleanup.productQaPassed!==false
    || !Array.isArray(cleanup.actions) || !sameIds(cleanup.actions.map(v=>v?.pid),pids)
    || !cleanup.actions.every(v=>v.action==='SIGTERM' && v.absentAfterWait===true && typeof v.verifiedIdentityRow==='string' && v.verifiedIdentityRow.trim().split(/\s+/u)[0]===String(v.pid) && orderedBootstrapTimes(cleanup.startedAt,v.at,cleanup.finishedAt))
    || cleanup.actions.find(v=>v.pid===result.gamePid)?.role!=='game' || cleanup.actions.find(v=>v.pid===result.editorPid)?.role!=='editor') fail('TESTFLIGHT_MAC_SKIP_CLEANUP');
  if(!orderedBootstrapTimes(result.plannedAt,result.startedAt,first.startedAt,first.finishedAt,cleanup.startedAt,cleanup.finishedAt,result.finalizedAt,a.approvalRecordedAt,document.android.plannedAt,context.now)
    || utc(result.endedAt)!==utc(cleanup.finishedAt) || result.clockResetOrExtension!==false || compareBootstrapTimes(result.startedAt,result.mainDeadlineAt,180*60)!==0 || compareBootstrapTimes(result.startedAt,result.absoluteMaximumAt,210*60)!==0
    || !orderedBootstrapTimes(result.finalizedAt,result.mainDeadlineAt) || !orderedBootstrapTimes(result.startedAt,integrity.checkedAt,result.finalizedAt)
    || !(now<Date.parse(bootstrapPolicy.legacyEvidence.acceptedUntil)) || last?.plannedAt!==utc(result.plannedAt) || last?.startedAt!==utc(result.startedAt) || last?.completedAt!==utc(result.finalizedAt)) fail('TESTFLIGHT_MAC_SKIP_TIME');
  const validManifest=m=>Array.isArray(m.files) && new Set(m.files.map(f=>f.path)).size===m.files.length && m.files.every(f=>safePath(f.path) && DIGEST.test(f.sha256 ?? '') && Number.isSafeInteger(f.bytes) && f.bytes>=0);
  if(!validManifest(original) || original.filesCount!==original.files.length || !equal(original.unstableDuringHash,[]) || !original.files.every(f=>f.stableDuringHash===true)
    || !validManifest(deliverable) || deliverable.fileCount!==deliverable.files.length || result.originalManifestSha256!==grant.macEditorSkip.originalManifestAsset.sha256
    || deliverable.originalsManifestSha256!==grant.macEditorSkip.originalManifestAsset.sha256 || deliverable.resultSha256!==grant.macEditorSkip.resultAsset.sha256
    || !orderedBootstrapTimes(result.finalizedAt,original.createdAt,deliverable.createdAt,a.approvalRecordedAt)
    || !macSkipAssets.filter(([asset])=>asset!=='deliverableManifestAsset').every(([asset,key,path])=>{const final=path.startsWith('final/');return(final?deliverable:original).files.some(f=>f.path===(final?path.slice(6):path) && f.sha256===grant.macEditorSkip[asset].sha256 && f.bytes===context[key].length);})) fail('TESTFLIGHT_MAC_SKIP_MANIFEST');
  const featureIds=inventory.features.map(f=>f.id),coreIds=inventory.features.filter(f=>f.core).map(f=>f.id);
  if(document.macEditorSkip?.approvalSha256!==grant.macEditorSkip.approvalSha256 || editor.status!=='skipped_incomplete' || editor.e2e?.status!=='skipped' || editor.e2e.completedAt!==undefined
    || !sameIds(editor.features.map(f=>`${f.id}:${f.core}`),inventory.features.map(f=>`${f.id}:${f.core}`)) || !sameIds(editor.tdd.map(t=>t.acceptanceId),editor.acceptance.map(c=>c.id))
    || !Array.isArray(editor.iterations) || editor.iterations.length!==10 || !editor.iterations.every((r,i)=>r.number===i+1 && typeof r.reviewer==='string' && r.reviewer.trim().toLowerCase()!==editor.implementer?.trim().toLowerCase()
      && orderedBootstrapTimes(r.plannedAt,r.startedAt,r.completedAt,context.now) && (i===0 || orderedBootstrapTimes(editor.iterations[i-1].completedAt,r.plannedAt))
      && ['functional','ux'].every(k=>['passed','failed','blocked'].includes(r[k]?.status) && coreIds.every(id=>r[k].featureIds.includes(id)) && r[k].featureIds.every(id=>featureIds.includes(id)))) || last.functional.status!=='blocked' || last.ux.status!=='blocked') fail('TESTFLIGHT_MAC_SKIP_EDITOR_HISTORY');
  const firstApproval=editor.additionalIterationApproval;
  if(!firstApproval || firstApproval.approverKind!=='human' || firstApproval.maxRound!==4 || !orderedBootstrapTimes(firstApproval.approvedAt,editor.iterations[3].plannedAt)) fail('TESTFLIGHT_MAC_SKIP_UI4_APPROVAL');
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
    ...(grant.approvedUiRounds>=8 ? [grant.ui8ApprovalFile,ui8ProposalPath,ui8HumanApprovalPath] : []),
    ...(grant.approvedUiRounds>=9 ? [grant.ui9ApprovalFile,ui9ProposalPath,ui9HumanApprovalPath] : []),
    ...(grant.approvedUiRounds===10 ? [grant.ui10ApprovalFile,ui10ProposalPath,ui10HumanApprovalPath,ui9ImplementationApprovalPath] : []),
    ...(grant.macEditorSkip ? [grant.macEditorSkip.approvalFile,macSkipProposalPath,macSkipHumanApprovalPath] : []),
    ...(grant.cloud12Recovery ? [grant.cloud12Recovery.approvalFile,'docs/design/2026-10-16-spiritgate-cloud12-recovery/approved-proposal.md'] : [])];
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
  if(grant.approvedUiRounds>=8){
    const ui8ApprovalBytes=readFileSync(join(root,grant.ui8ApprovalFile)),ui8ProposalBytes=readFileSync(join(root,ui8ProposalPath));
    const ui8HumanApprovalBytes=readFileSync(join(root,ui8HumanApprovalPath));
    if(grant.approvedUiRounds===8) validateBootstrapUi8Approval(grant,ui8ApprovalBytes,ui8ProposalBytes,ui8HumanApprovalBytes);
    const [latestApproval,latestProposal,latestHuman]=await Promise.all([
      readRemote('seorilabs/.github',grant.ui8ApprovalFile,'main',request),readRemote('seorilabs/.github',ui8ProposalPath,'main',request),readRemote('seorilabs/.github',ui8HumanApprovalPath,'main',request)]);
    if(!ui8ApprovalBytes.equals(latestApproval) || !ui8ProposalBytes.equals(latestProposal) || !ui8HumanApprovalBytes.equals(latestHuman)) fail('TESTFLIGHT_UI8_REVOKED_OR_CHANGED');
    Object.assign(additionalUi,{ui8ApprovalBytes,ui8ProposalBytes,ui8HumanApprovalBytes});
  }
  if(grant.approvedUiRounds>=9){
    const ui9ApprovalBytes=readFileSync(join(root,grant.ui9ApprovalFile)),ui9ProposalBytes=readFileSync(join(root,ui9ProposalPath));
    const ui9HumanApprovalBytes=readFileSync(join(root,ui9HumanApprovalPath));
    if(grant.approvedUiRounds===9) validateBootstrapUi9Approval(grant,ui9ApprovalBytes,ui9ProposalBytes,ui9HumanApprovalBytes);
    const [latestApproval,latestProposal,latestHuman]=await Promise.all([
      readRemote('seorilabs/.github',grant.ui9ApprovalFile,'main',request),readRemote('seorilabs/.github',ui9ProposalPath,'main',request),readRemote('seorilabs/.github',ui9HumanApprovalPath,'main',request)]);
    if(!ui9ApprovalBytes.equals(latestApproval) || !ui9ProposalBytes.equals(latestProposal) || !ui9HumanApprovalBytes.equals(latestHuman)) fail('TESTFLIGHT_UI9_REVOKED_OR_CHANGED');
    Object.assign(additionalUi,{ui9ApprovalBytes,ui9ProposalBytes,ui9HumanApprovalBytes});
  }
  if(grant.approvedUiRounds===10){
    const ui10ApprovalBytes=readFileSync(join(root,grant.ui10ApprovalFile)),ui10ProposalBytes=readFileSync(join(root,ui10ProposalPath)),ui10HumanApprovalBytes=readFileSync(join(root,ui10HumanApprovalPath));
    const ui9ImplementationApprovalBytes=readFileSync(join(root,ui9ImplementationApprovalPath));
    if(!grant.macEditorSkip) validateBootstrapUi10Approval(grant,ui10ApprovalBytes,ui10ProposalBytes,ui10HumanApprovalBytes);
    const [latestApproval,latestProposal,latestHuman,latestImplementation]=await Promise.all([
      readRemote('seorilabs/.github',grant.ui10ApprovalFile,'main',request),readRemote('seorilabs/.github',ui10ProposalPath,'main',request),readRemote('seorilabs/.github',ui10HumanApprovalPath,'main',request),readRemote('seorilabs/.github',ui9ImplementationApprovalPath,'main',request)]);
    if(!ui10ApprovalBytes.equals(latestApproval) || !ui10ProposalBytes.equals(latestProposal) || !ui10HumanApprovalBytes.equals(latestHuman) || !ui9ImplementationApprovalBytes.equals(latestImplementation)) fail('TESTFLIGHT_UI10_REVOKED_OR_CHANGED');
    Object.assign(additionalUi,{ui10ApprovalBytes,ui10ProposalBytes,ui10HumanApprovalBytes,ui9ImplementationApprovalBytes});
  }
  if(grant.macEditorSkip){
    const macSkipApprovalBytes=readFileSync(join(root,grant.macEditorSkip.approvalFile)),macSkipProposalBytes=readFileSync(join(root,macSkipProposalPath)),macSkipHumanApprovalBytes=readFileSync(join(root,macSkipHumanApprovalPath));
    validateMacEditorSkipApproval(grant,macSkipApprovalBytes,macSkipProposalBytes,macSkipHumanApprovalBytes);
    const [latestApproval,latestProposal,latestHuman]=await Promise.all([readRemote('seorilabs/.github',grant.macEditorSkip.approvalFile,'main',request),readRemote('seorilabs/.github',macSkipProposalPath,'main',request),readRemote('seorilabs/.github',macSkipHumanApprovalPath,'main',request)]);
    if(!macSkipApprovalBytes.equals(latestApproval) || !macSkipProposalBytes.equals(latestProposal) || !macSkipHumanApprovalBytes.equals(latestHuman)) fail('TESTFLIGHT_MAC_SKIP_REVOKED_OR_CHANGED');
    Object.assign(additionalUi,{macSkipApprovalBytes,macSkipProposalBytes,macSkipHumanApprovalBytes});
  }
  if(grant.cloud12Recovery){
    if(bootstrapPolicy.internalTestflightBootstrap.cloud12FailureRecovery!=='single-reviewed-failed12-to13-total-cloud2-upload1'
      || latestPolicy.internalTestflightBootstrap?.cloud12FailureRecovery!=='single-reviewed-failed12-to13-total-cloud2-upload1') fail('TESTFLIGHT_CLOUD12_POLICY');
    const approvalPath=grant.cloud12Recovery.approvalFile,proposalPath='docs/design/2026-10-16-spiritgate-cloud12-recovery/approved-proposal.md';
    const cloud12RecoveryApprovalBytes=readFileSync(join(root,approvalPath)),cloud12RecoveryProposalBytes=readFileSync(join(root,proposalPath));
    validateCloud12RecoveryApproval(grant,cloud12RecoveryApprovalBytes,cloud12RecoveryProposalBytes);
    const [latestApproval,latestProposal]=await Promise.all([readRemote('seorilabs/.github',approvalPath,'main',request),readRemote('seorilabs/.github',proposalPath,'main',request)]);
    if(!cloud12RecoveryApprovalBytes.equals(latestApproval) || !cloud12RecoveryProposalBytes.equals(latestProposal)) fail('TESTFLIGHT_CLOUD12_REVOKED_OR_CHANGED');
    Object.assign(additionalUi,{cloud12RecoveryApprovalBytes,cloud12RecoveryProposalBytes});
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

export function validateCloud12RecoveryApproval(grant,approvalBytes,proposalBytes,now=new Date().toISOString()){
  const r=grant.cloud12Recovery;
  let a;try{a=JSON.parse(approvalBytes);}catch{fail('TESTFLIGHT_CLOUD12_APPROVAL');}
  if(!r || !Buffer.isBuffer(approvalBytes) || !Buffer.isBuffer(proposalBytes) || bootstrapDigest(approvalBytes)!==r.approvalSha256
    || a.kind!=='human_cloud12_recovery_approval' || a.repository!==REPO || a.version!=='1.1.0'
    || a.sourceSha!==grant.sourceSha || a.configurationFingerprint!==grant.configurationFingerprint
    || a.originalTimingApprovalSha256!==grant.approvalSha256 || a.originalGrantSha256!=='95f0c3f0f1e4b6f059681fc1fe735e8db7dff26658378f348340b48d08be3fa5'
    || a.originalApprovedAt!==grant.approvedAt || a.originalExpiresAt!==grant.expiresAt
    || a.previousRunId!==r.previousRun.id || a.previousBuildNumber!==12 || a.expectedBuildNumber!==13
    || a.additionalCloudAttempts!==1 || a.totalCloudAttemptLimit!==2 || a.totalUploadLimit!==1
    || r.additionalCloudAttempts!==1 || r.totalCloudAttemptLimit!==2 || r.totalUploadLimit!==1 || r.expectedBuildNumber!==13
    || a.originalFailurePreserved!==true || a.nativeQaWaived!==false || a.e2eWaived!==false || a.publicReleaseAllowed!==false || a.newAppleResourcesAllowed!==false
    || a.proposalSha256!==bootstrapDigest(proposalBytes) || typeof a.userApprovalVerbatim!=='string' || !a.userApprovalVerbatim.trim()
    || !orderedBootstrapTimes(grant.approvedAt,r.previousRun.finishedAt,a.approvalRecordedAt,now,grant.expiresAt)) fail('TESTFLIGHT_CLOUD12_APPROVAL');
  return {verified:true,approvalSha256:r.approvalSha256};
}

export function validateCloud12FailedRun({run,builds,actions,artifacts,logBytes},grant){
  const r=grant.cloud12Recovery?.previousRun,a=run?.attributes,g=grant.provider;
  const archive=actions?.find(action=>action.id===r?.archiveActionId);
  if(!r || run?.id!==r.id || a?.number!==12 || a.executionProgress!=='COMPLETE' || a.completionStatus!=='FAILED'
    || a.finishedDate!==r.finishedAt || a.sourceCommit?.commitSha!==grant.sourceSha || a.startReason!=='MANUAL' || a.isPullRequestBuild!==false
    || run.relationships?.workflow?.data?.id!==g.workflowId || run.relationships?.product?.data?.id!==g.productId
    || run.relationships?.sourceBranchOrTag?.data?.id!==r.tagReferenceId
    || !Array.isArray(builds) || builds.length!==0 || actions?.length!==2
    || archive?.attributes?.actionType!=='ARCHIVE' || archive.attributes.executionProgress!=='COMPLETE' || archive.attributes.completionStatus!=='FAILED'
    || actions.filter(action=>action.id!==r.archiveActionId).some(action=>action.attributes?.actionType!=='TEST' || action.attributes.executionProgress!=='COMPLETE' || action.attributes.completionStatus!=='SKIPPED')
    || artifacts?.length!==1 || artifacts[0].id!==r.logArtifactId || artifacts[0].attributes?.fileType!=='LOG_BUNDLE'
    || !Buffer.isBuffer(logBytes) || logBytes.length!==artifacts[0].attributes.fileSize || bootstrapDigest(logBytes)!==r.logZipSha256) fail('TESTFLIGHT_CLOUD12_FAILED_RUN');
  return {verified:true,id:r.id,logZipSha256:r.logZipSha256};
}

async function cloud12FailureProof(grant,token,fetchImpl){
  const r=grant.cloud12Recovery.previousRun;
  const [previous,builds,actions,artifacts]=await Promise.all([
    appleRead(`/v1/ciBuildRuns/${r.id}?include=workflow,product,sourceBranchOrTag`,token,fetchImpl),
    applePages(`/v1/ciBuildRuns/${r.id}/builds?limit=200`,token,fetchImpl),
    applePages(`/v1/ciBuildRuns/${r.id}/actions?limit=200`,token,fetchImpl),
    applePages(`/v1/ciBuildActions/${r.archiveActionId}/artifacts?limit=200`,token,fetchImpl)]);
  let logBytes;
  try{
    if(artifacts.length!==1 || artifacts[0].id!==r.logArtifactId || artifacts[0].attributes?.fileType!=='LOG_BUNDLE'
      || !Number.isSafeInteger(artifacts[0].attributes.fileSize) || artifacts[0].attributes.fileSize<=0 || artifacts[0].attributes.fileSize>32768) fail('TESTFLIGHT_CLOUD12_LOG_DOWNLOAD');
    const url=new URL(artifacts[0].attributes.downloadUrl);
    if(url.origin!=='https://cvws.icloud-content.com' || url.username || url.password || url.hash) fail('TESTFLIGHT_CLOUD12_LOG_DOWNLOAD');
    // Signed Apple artifact URL gets no ASC/GitHub token and may not redirect to another origin.
    const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok) fail('TESTFLIGHT_CLOUD12_LOG_DOWNLOAD');
    logBytes=Buffer.from(await response.arrayBuffer());
  }catch{fail('TESTFLIGHT_CLOUD12_LOG_DOWNLOAD');}
  return validateCloud12FailedRun({run:previous.data,builds,actions,artifacts,logBytes},grant);
}

export function validateBootstrapAppleObservation({app,product,workflow,run,runs,tag,failedRunProof},grant,env){
  const w=workflow?.attributes,action=w?.actions?.[0],g=grant.provider;
  if(app?.id!==g.appId || app.attributes?.bundleId!==grant.packageName || product?.id!==g.productId
    || product.relationships?.app?.data?.id!==g.appId || workflow?.id!==g.workflowId
    || workflow.relationships?.product?.data?.id!==g.productId) fail('TESTFLIGHT_APPLE_PRODUCT');
  if(w.isEnabled!==true || w.actions?.length!==1 || action.actionType!=='ARCHIVE' || action.platform!=='IOS'
    || action.scheme!=='SpiritgateDefenders' || action.isRequiredToPass!==true || action.buildDistributionAudience!=='INTERNAL_ONLY'
    || !w.manualTagStartCondition || ['branchStartCondition','tagStartCondition','pullRequestStartCondition','scheduledStartCondition','manualBranchStartCondition','manualPullRequestStartCondition'].some(k=>w[k]!=null)) fail('TESTFLIGHT_APPLE_WORKFLOW_NOT_INTERNAL');
  const matches=runs.filter(r=>r.attributes?.sourceCommit?.commitSha===grant.sourceSha);
  const recovery=grant.cloud12Recovery,previous=recovery?.previousRun;
  const countOk=recovery ? (matches.length===2 && new Set(matches.map(r=>r.id)).size===2 && matches.some(r=>r.id===run?.id)
    && matches.some(r=>r.id===previous.id && r.attributes?.number===12 && r.attributes.completionStatus==='FAILED')
    && failedRunProof?.verified===true && failedRunProof.id===previous.id && failedRunProof.logZipSha256===previous.logZipSha256
    && run?.attributes?.number===13 && run.relationships?.sourceBranchOrTag?.data?.id===previous.tagReferenceId) : matches.length===1 && matches[0].id===run?.id;
  if(run?.id!==env.CI_BUILD_ID || run.attributes?.sourceCommit?.commitSha!==grant.sourceSha
    || run.relationships?.workflow?.data?.id!==g.workflowId || run.relationships?.product?.data?.id!==g.productId
    || String(run.attributes?.number)!==env.CI_BUILD_NUMBER || run.attributes?.startReason!=='MANUAL'
    || run.attributes?.isPullRequestBuild!==false || !countOk
    || tag?.attributes?.kind!=='TAG' || tag.attributes.name!==grant.releaseTag || tag.id!==run.relationships?.sourceBranchOrTag?.data?.id) fail('TESTFLIGHT_APPLE_FIRST_BUILD');
  return {verified:true,internalOnly:true,sourceSha:grant.sourceSha,workflowId:g.workflowId,productId:g.productId,
    buildId:run.id,buildNumber:run.attributes.number,matchingBuildCount:matches.length,
    ...(recovery ? {recoveryVerified:true,previousFailedRunId:previous.id} : {})};
}

export async function bootstrapProvider(grant,env,fetchImpl){
  if(env.APP_STORE_CONNECT_API_KEY_ID!=='UHVPXA39JA' || env.CI_TEAM_ID!=='69a6de86-a179-47e3-e053-5b8c7c11a4d1' || env.CI_XCODE_CLOUD!=='TRUE' || env.CI_PRODUCT_ID!==PROVIDER.productId || env.CI_WORKFLOW_ID!==PROVIDER.workflowId
    || env.CI_BUNDLE_ID!==BUNDLE || env.CI_XCODE_SCHEME!=='SpiritgateDefenders' || env.CI_TAG!==TAG || env.CI_COMMIT!==grant.sourceSha
    || !/^[A-Za-z0-9-]+$/u.test(env.CI_BUILD_ID ?? '') || !/^[1-9][0-9]*$/u.test(env.CI_BUILD_NUMBER ?? '')) fail('TESTFLIGHT_CI_CONTEXT');
  const token=await appleToken(env),g=grant.provider;
  const [app,product,workflow,run,runs]=await Promise.all([
    appleRead(`/v1/apps/${g.appId}`,token,fetchImpl),appleRead(`/v1/ciProducts/${g.productId}?include=app`,token,fetchImpl),
    appleRead(`/v1/ciWorkflows/${g.workflowId}?include=product`,token,fetchImpl),appleRead(`/v1/ciBuildRuns/${env.CI_BUILD_ID}?include=workflow,product,sourceBranchOrTag`,token,fetchImpl),
    applePages(`/v1/ciWorkflows/${g.workflowId}/buildRuns?limit=200`,token,fetchImpl)]);
  const tagId=run.data?.relationships?.sourceBranchOrTag?.data?.id;
  if(!/^[A-Za-z0-9-]+$/u.test(tagId ?? '')) fail('TESTFLIGHT_PROVIDER_TAG');
  const tag=await appleRead(`/v1/scmGitReferences/${tagId}`,token,fetchImpl);
  const failedRunProof=grant.cloud12Recovery ? await cloud12FailureProof(grant,token,fetchImpl) : null;
  return validateBootstrapAppleObservation({app:app.data,product:product.data,workflow:workflow.data,run:run.data,runs,tag:tag.data,failedRunProof},grant,env);
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
  const historicalUi7=grant.approvedUiRounds>=8 ? Object.fromEntries(ui7HistoricalAssets
    .map(([asset,key])=>[key,originalBytes[grant.originalObservationAssets.findIndex(a=>equal(a,grant.historicalUi7[asset]))]])) : {};
  const historicalUi8=grant.approvedUiRounds>=9 ? Object.fromEntries(ui8HistoricalAssets
    .map(([asset,key])=>[key,originalBytes[grant.originalObservationAssets.findIndex(a=>equal(a,grant.historicalUi8[asset]))]])) : {};
  const inventoryBytes=await readRemote(REPO,'docs/qa/feature-inventory.json',grant.sourceSha,request);
  const tree=verifyBootstrapWorkingTree(options.appRepository,grant,options.phase);
  const providerProof=await bootstrapProvider(grant,env,request.fetchImpl);
  const historicalUi9=grant.approvedUiRounds===10 ? Object.fromEntries(ui9HistoricalAssets
    .map(([asset,key])=>[key,originalBytes[grant.originalObservationAssets.findIndex(a=>equal(a,grant.historicalUi9[asset]))]])) : {};
  const macSkippedOriginals=grant.macEditorSkip ? Object.fromEntries(macSkipAssets.map(([asset,key])=>[key,originalBytes[grant.originalObservationAssets.findIndex(ref=>equal(ref,grant.macEditorSkip[asset]))]])) : {};
  const context={...options,...reviewed,...tree,...historicalUi5,...historicalUi6,...historicalUi7,...historicalUi8,...historicalUi9,...macSkippedOriginals,inventoryBytes,evidenceBytes,originalEvidenceVerified:true,providerProof,now:new Date().toISOString()};
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
