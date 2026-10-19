import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { policy } from './test-plan.mjs';

const KIND = 'lizard-ios191-submission-continuation';
const registry = (policy.historicalReviewCoverage?.grantRegistry ?? [])
  .map(path => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')))
  .filter(grant => grant.schemaVersion === 2 && grant.kind === KIND);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SHA = /^[a-f0-9]{40}$/u;
const ERRORS = ['FEATURE_COVERAGE ux-1', 'FEATURE_COVERAGE functional-4', 'FEATURE_COVERAGE ux-4'];
const KEYS = ['schemaVersion','kind','repository','sourceSha','target','baselineEvidence','patchEvidence','nativeEvidence','visualEvidence'];
const OWNER_KEYS = ['confirmationJson','serverDeliveryJson','versionBuildJson','proposalMarkdown','approvalJson','releaseArtifactSha256'];
const textHash = value => createHash('sha256').update(value).digest('hex');
const reject = reason => { throw new Error(`LIZARD_IOS191_CONTINUATION_${reason}`); };
const originalFailure = result => result?.ok === false && result.level === 'L3' && !result.decisionStatus
  && result.errors?.length === ERRORS.length && ERRORS.every(error => result.errors.includes(error));

// 사용자 기록은 일반 runs에 넣지 않는다. 중앙에서 검토한 원본 bytes와 한 후보 승인만 인정한다.
function verifyOwnerAcceptance(document, context, grant, native) {
  const evidence = document.ownerEvidence, accepted = grant.ownerAcceptance;
  if (context.phase !== 'before-release' || !evidence || !accepted
    || Object.keys(evidence).length !== OWNER_KEYS.length || Object.keys(evidence).some(key => !OWNER_KEYS.includes(key))
    || OWNER_KEYS.some(key => typeof evidence[key] !== 'string')
    || evidence.releaseArtifactSha256 !== accepted.artifactSha256 || !/^[a-f0-9]{64}$/u.test(accepted.artifactSha256 ?? '')
    || OWNER_KEYS.filter(key => key !== 'releaseArtifactSha256').some(key => textHash(evidence[key]) !== accepted[key+'Sha256'])) reject('OWNER_BYTES');
  let confirmation, server, builds, approval;
  try {
    confirmation=JSON.parse(evidence.confirmationJson); server=JSON.parse(evidence.serverDeliveryJson);
    builds=JSON.parse(evidence.versionBuildJson); approval=JSON.parse(evidence.approvalJson);
  } catch { reject('OWNER_JSON'); }
  const approvedAt=Date.parse(accepted.approvedAt), now=Date.parse(context.now ?? new Date().toISOString());
  if (!Number.isFinite(approvedAt) || approvedAt > now || approvedAt < Date.parse(grant.approvedAt)
    || approval.approvedAt !== accepted.approvedAt || approval.status !== 'approved'
    || approval.userStatement !== '근거로 인정하고 심사제출해.'
    || approval.approvalEvidence !== accepted.approvalEvidence
    || accepted.approvalEvidence !== 'https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6269467251'
    || approval.proposalSha256 !== accepted.proposalMarkdownSha256
    || approval.repository !== context.repository || approval.sourceSha !== context.sourceSha
    || approval.tag !== context.tag || approval.target !== context.target || approval.phase !== context.phase
    || approval.version !== '1.9.1' || approval.build !== '56') reject('OWNER_APPROVAL');
  if (confirmation.targetVersion !== '1.9.1' || confirmation.targetBuild !== '56'
    || confirmation.notObservedByAgent !== true || confirmation.notAddedToDevelopmentRuns !== true || confirmation.agentDeviceAccess !== false
    || confirmation.reportedRuntimeChecks?.['consent-policy'] !== 'user-confirmed'
    || confirmation.reportedRuntimeChecks?.['sdk-completion'] !== 'user-confirmed actual ad shown'
    || confirmation.reportedRuntimeChecks?.['server-delivery'] !== 'reward received per user; server record pending'
    || confirmation.reportedRuntimeChecks?.['relaunch-no-duplicate'] !== 'user-confirmed') reject('OWNER_CONFIRMATION');
  if (server.project !== 'seorilabs-platform' || server.appId !== 'lizard-tycoon' || server.clientPlatform !== 'ios'
    || server.claimId !== accepted.claimId || server.provider !== 'admob' || server.placement !== 'rewarded_leaf_bonus'
    || server.assurance !== 'server_verified' || server.state !== 'delivered' || server.rewardKey !== 'leaf_bonus'
    || server.rewardUnits !== 1 || server.recentIosClaimCount !== 1 || server.noWriteOperations !== true || server.noDeviceOperations !== true) reject('OWNER_SERVER');
  const candidates=builds.candidateVersionBuilds;
  if (builds.appId !== '6786516830' || builds.bundleId !== 'com.seorilabs.lizardtycoon'
    || builds.allRecent50BuildsChecked !== 50 || builds.serverOnlyNoDeviceAccess !== true || !Array.isArray(candidates) || candidates.length !== 1
    || candidates[0].id !== accepted.buildId || candidates[0].version !== '1.9.1' || candidates[0].build !== '56'
    || candidates[0].state !== 'VALID' || candidates[0].expired !== false) reject('OWNER_BUILD');
  const claimTimes=[server.createdAt,server.confirmedAt,server.acknowledgedAt,server.checkedAt].map(Date.parse);
  const times=[...claimTimes,Date.parse(confirmation.recordedAt),Date.parse(builds.checkedAt)];
  if (times.some(time => !Number.isFinite(time) || time > approvedAt || time < Date.parse(grant.approvedAt))
    || claimTimes.some((time,index) => index > 0 && time < claimTimes[index-1])) reject('OWNER_TIME');
  if (native.ok !== false || native.level !== 'L3' || native.decisionStatus
    || accepted.nativeErrors?.length !== 1 || !/^TEST_LEVEL_BELOW_FLOOR platform-first [a-z-]+ ios$/u.test(accepted.nativeErrors[0])
    || native.errors?.length !== 1 || native.errors[0] !== accepted.nativeErrors[0]
    || hash(document.nativeEvidence) !== grant.nativeBaseHash) reject('OWNER_NATIVE_VERDICT');
  return { approvedAt: accepted.approvedAt, approvalEvidence: accepted.approvalEvidence,
    artifactSha256: accepted.artifactSha256, build: '56', claimId: accepted.claimId,
    userAssociation: 'time-correlated; no user identity comparison', installedBuildVerifiedByAgent: false };
}

// 실제 SDK 실행만 뒤에 추가할 수 있다. 기존 CI, 승인 계획과 나머지 근거는 해시로 고정한다.
export function nativeEvidenceCore(document) {
  return { ...document, runs: document.runs.filter(run => !(run.kind === 'native-development' && run.nativeSdk?.mode === 'real')) };
}

export const requiresLizardIos191Continuation = (context, grants = registry) => context.target === 'app-store'
  && grants.some(grant => grant?.kind === KIND && grant.repository === context.repository && grant.sourceSha === context.sourceSha);

export async function verifyLizardIos191Continuation(document, context, dependencies, grants = registry) {
  if (document?.schemaVersion !== 1 || document.kind !== KIND || Object.keys(document).length !== KEYS.length + (Object.hasOwn(document,'ownerEvidence') ? 1 : 0)
    || Object.keys(document).some(key => !KEYS.includes(key) && key !== 'ownerEvidence')
    || [document.baselineEvidence,document.patchEvidence,document.nativeEvidence].some(part => part?.schemaVersion !== 2)
    || !Array.isArray(document.nativeEvidence.runs)) reject('SCHEMA');
  const patch = await dependencies.validate(document.patchEvidence, context);
  const baseline = await dependencies.validate(document.baselineEvidence,
    { ...context, sourceSha: document.baselineEvidence.sourceSha, tag: 'v1.9.0' });
  const native = await dependencies.validate(document.nativeEvidence, context);
  if (!originalFailure(patch)) reject(`PATCH_VALIDATION ${(patch.errors ?? []).join(', ')}`);
  if (!originalFailure(baseline)) reject(`BASELINE_VALIDATION ${(baseline.errors ?? []).join(', ')}`);
  if (context.repository !== 'seorilabs/lizard-tycoon' || context.target !== 'app-store' || context.tag !== 'v1.9.1'
    || !['before-build','before-deploy','before-release'].includes(context.phase)
    || document.repository !== context.repository || document.sourceSha !== context.sourceSha || document.target !== context.target) reject('SCOPE');
  const now = Date.parse(context.now ?? new Date().toISOString());
  const matches = grants.filter(grant => {
    const start = Date.parse(grant?.approvedAt), end = Date.parse(grant?.expiresAt);
    return grant?.schemaVersion === 2 && grant.kind === KIND && typeof grant.id === 'string' && grant.id.trim()
      && grant.repository === context.repository && grant.sourceSha === context.sourceSha && grant.target === context.target && grant.tag === context.tag
      && [grant.sourceSha,grant.baselineSha,grant.renderedSha,grant.treeSha].every(sha => SHA.test(sha ?? ''))
      && [now,start,end].every(Number.isFinite) && start <= now && now < end && end > start
      && end-start <= policy.runs.maxAgeHours*3600000 && end <= Date.parse('2026-10-26T03:59:05Z')
      && grant.baselineHash === hash(document.baselineEvidence) && grant.patchHash === hash(document.patchEvidence)
      && grant.nativeBaseHash === hash(nativeEvidenceCore(document.nativeEvidence))
      && grant.baselineSha === document.baselineEvidence.sourceSha && document.patchEvidence.sourceSha === grant.sourceSha
      && document.nativeEvidence.sourceSha === grant.sourceSha && grant.renderedSha === document.visualEvidence?.sourceSha
      && Number.isSafeInteger(grant.archiveId) && grant.archiveId > 0 && grant.archiveId === document.visualEvidence.archiveId
      && Number.isSafeInteger(grant.archiveReleaseId) && grant.archiveReleaseId > 0 && /^sha256:[a-f0-9]{64}$/u.test(grant.archiveDigest ?? '')
      && Array.isArray(grant.errors) && grant.errors.length === ERRORS.length && ERRORS.every(error => grant.errors.includes(error))
      && grant.approvalEvidence === 'https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6265815627';
  });
  if (matches.length !== 1) reject('GRANT');
  const grant = matches[0];
  const ownerAcceptance = Object.hasOwn(document,'ownerEvidence') ? verifyOwnerAcceptance(document,context,grant,native) : null;
  if (!ownerAcceptance && (!native.ok || native.level !== 'L3' || native.errors.length !== 0 || native.decisionStatus))
    reject(`NATIVE_VALIDATION ${(native.errors ?? []).join(', ')}`);
  const latest = document.baselineEvidence.reviewRounds?.at(-1);
  if (!latest || latest.number !== 6 || latest.sourceSha !== grant.baselineSha
    || latest.functional?.status !== 'passed' || latest.ux?.status !== 'passed') reject('LATEST_REVIEW');
  if (hash(document.patchEvidence.reviewRounds) !== hash(document.baselineEvidence.reviewRounds)) reject('HISTORICAL_REVIEW');
  const proof = await dependencies.readProof(grant);
  if (proof.candidateTree !== grant.treeSha || proof.renderedTree !== grant.treeSha
    || proof.archiveDigest !== grant.archiveDigest || proof.archivePublished !== true || proof.tagSourceSha !== grant.sourceSha) reject('VISUAL_READBACK');
  return { ok: true, errors: [], level: 'L3', completedAt: [patch.completedAt,native.completedAt].sort((a,b) => Date.parse(a)-Date.parse(b)).at(-1),
    decisionStatus: 'human_exception', exceptionId: grant.id, waivedErrors: [...baseline.errors],
    originalVerdict: { ...baseline, errors: [...baseline.errors] }, patchVerdict: patch, nativeVerdict: native,
    nativeSdkStatus: ownerAcceptance ? 'owner-and-server-accepted-by-human' : context.phase === 'before-release' ? 'verified-by-normal-platform-plan' : 'required-before-release',
    ...(ownerAcceptance ? { ownerAcceptance } : {}),
    baselineSourceSha: grant.baselineSha, renderedSourceSha: grant.renderedSha };
}
