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
const reject = reason => { throw new Error(`LIZARD_IOS191_CONTINUATION_${reason}`); };
const originalFailure = result => result?.ok === false && result.level === 'L3' && !result.decisionStatus
  && result.errors?.length === ERRORS.length && ERRORS.every(error => result.errors.includes(error));

// 실제 SDK 실행만 뒤에 추가할 수 있다. 기존 CI, 승인 계획과 나머지 근거는 해시로 고정한다.
export function nativeEvidenceCore(document) {
  return { ...document, runs: document.runs.filter(run => !(run.kind === 'native-development' && run.nativeSdk?.mode === 'real')) };
}

export const requiresLizardIos191Continuation = (context, grants = registry) => context.target === 'app-store'
  && grants.some(grant => grant?.kind === KIND && grant.repository === context.repository && grant.sourceSha === context.sourceSha);

export async function verifyLizardIos191Continuation(document, context, dependencies, grants = registry) {
  if (document?.schemaVersion !== 1 || document.kind !== KIND || Object.keys(document).length !== KEYS.length
    || Object.keys(document).some(key => !KEYS.includes(key))
    || [document.baselineEvidence,document.patchEvidence,document.nativeEvidence].some(part => part?.schemaVersion !== 2)
    || !Array.isArray(document.nativeEvidence.runs)) reject('SCHEMA');
  const patch = await dependencies.validate(document.patchEvidence, context);
  const baseline = await dependencies.validate(document.baselineEvidence,
    { ...context, sourceSha: document.baselineEvidence.sourceSha, tag: 'v1.9.0' });
  const native = await dependencies.validate(document.nativeEvidence, context);
  if (!originalFailure(patch)) reject('PATCH_VALIDATION');
  if (!originalFailure(baseline)) reject('BASELINE_VALIDATION');
  if (!native.ok || native.level !== 'L3' || native.errors.length !== 0 || native.decisionStatus)
    reject(`NATIVE_VALIDATION ${(native.errors ?? []).join(', ')}`);
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
  const grant = matches[0], latest = document.baselineEvidence.reviewRounds?.at(-1);
  if (!latest || latest.number !== 6 || latest.sourceSha !== grant.baselineSha
    || latest.functional?.status !== 'passed' || latest.ux?.status !== 'passed') reject('LATEST_REVIEW');
  if (hash(document.patchEvidence.reviewRounds) !== hash(document.baselineEvidence.reviewRounds)) reject('HISTORICAL_REVIEW');
  const proof = await dependencies.readProof(grant);
  if (proof.candidateTree !== grant.treeSha || proof.renderedTree !== grant.treeSha
    || proof.archiveDigest !== grant.archiveDigest || proof.archivePublished !== true || proof.tagSourceSha !== grant.sourceSha) reject('VISUAL_READBACK');
  return { ok: true, errors: [], level: 'L3', completedAt: [patch.completedAt,native.completedAt].sort((a,b) => Date.parse(a)-Date.parse(b)).at(-1),
    decisionStatus: 'human_exception', exceptionId: grant.id, waivedErrors: [...baseline.errors],
    originalVerdict: { ...baseline, errors: [...baseline.errors] }, patchVerdict: patch, nativeVerdict: native,
    nativeSdkStatus: context.phase === 'before-release' ? 'verified-by-normal-platform-plan' : 'required-before-release',
    baselineSourceSha: grant.baselineSha, renderedSourceSha: grant.renderedSha };
}
