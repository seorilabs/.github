import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { policy } from './test-plan.mjs';

const registry = (policy.historicalReviewCoverage?.grantRegistry ?? [])
  .map(path => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')))
  .filter(grant => grant.schemaVersion === 2 && grant.kind === 'lizard-191-public-continuation');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SHA = /^[a-f0-9]{40}$/u;
const errors = ['FEATURE_COVERAGE ux-1', 'FEATURE_COVERAGE functional-4', 'FEATURE_COVERAGE ux-4'];
const reject = reason => { throw new Error(`APPROVED_PATCH_CONTINUATION_${reason}`); };

// 두 실행 기록을 각각 정상 검증한다. 과거 실행의 SHA나 실패를 현재 후보로 바꾸지 않는다.
export async function verifyApprovedPatchContinuation(document, context, dependencies, grants = registry) {
  if (document?.schemaVersion !== 1 || document.kind !== 'lizard-191-public-continuation'
    || document.baselineEvidence?.schemaVersion !== 2 || document.patchEvidence?.schemaVersion !== 2) reject('SCHEMA');
  const patch = await dependencies.validate(document.patchEvidence, context);
  const baseline = await dependencies.validate(document.baselineEvidence,
    { ...context, sourceSha: document.baselineEvidence.sourceSha, tag: 'v1.9.0' });
  if (!patch.ok || patch.level !== 'L1' || patch.errors.length !== 0 || patch.decisionStatus) reject('PATCH_VALIDATION');
  if (baseline.ok || baseline.level !== 'L3' || baseline.errors.length !== errors.length
    || !errors.every(error => baseline.errors.includes(error))) reject('BASELINE_VALIDATION');
  if (context.repository !== 'seorilabs/lizard-tycoon' || context.target !== 'google-play'
    || document.repository !== context.repository || document.sourceSha !== context.sourceSha
    || document.target !== context.target || !['v1.9.1','development-evidence'].includes(context.tag)
    || (context.tag === 'development-evidence' && context.phase !== 'before-build')) reject('SCOPE');
  const operationAllowed = context.phase === 'before-build'
    || (context.phase === 'before-deploy' && context.playTrack === 'internal' && context.playOperation === 'upload')
    || (context.phase === 'before-release' && context.playTrack === 'production' && context.playOperation === 'promote');
  const rollout = context.rollout ?? 1;
  if (!operationAllowed || !Number.isFinite(rollout) || !(rollout > 0 && rollout <= 1)) reject('OPERATION');
  const now = Date.parse(context.now ?? new Date().toISOString());
  const matches = grants.filter(grant => {
    const start = Date.parse(grant?.approvedAt), end = Date.parse(grant?.expiresAt);
    return grant?.schemaVersion === 2 && grant.kind === document.kind && typeof grant.id === 'string' && grant.id.trim()
      && grant.repository === context.repository && grant.sourceSha === context.sourceSha
      && SHA.test(grant.sourceSha) && SHA.test(grant.baselineSha) && SHA.test(grant.renderedSha) && SHA.test(grant.treeSha)
      && [now,start,end].every(Number.isFinite) && start <= now && now < end && end > start
      && end-start <= policy.runs.maxAgeHours*3600000 && end <= Date.parse('2026-10-26T03:59:05Z')
      && grant.envelopeHash === hash(document) && grant.baselineHash === hash(document.baselineEvidence)
      && grant.patchHash === hash(document.patchEvidence) && grant.baselineSha === document.baselineEvidence.sourceSha
      && document.patchEvidence.sourceSha === grant.sourceSha && grant.renderedSha === document.visualEvidence?.sourceSha
      && Number.isSafeInteger(grant.archiveId) && grant.archiveId > 0 && grant.archiveId === document.visualEvidence.archiveId
      && /^sha256:[a-f0-9]{64}$/u.test(grant.archiveDigest ?? '')
      && grant.approvalEvidence === 'https://github.com/seorilabs/lizard-tycoon/issues/805#issuecomment-6263609549';
  });
  if (matches.length !== 1) reject('GRANT');
  const grant = matches[0], latest = document.baselineEvidence.reviewRounds?.at(-1);
  if (!latest || latest.number !== 6 || latest.sourceSha !== grant.baselineSha
    || latest.functional?.status !== 'passed' || latest.ux?.status !== 'passed') reject('LATEST_REVIEW');
  const proof = await dependencies.readProof(grant);
  if (proof.candidateTree !== grant.treeSha || proof.renderedTree !== grant.treeSha
    || proof.archiveDigest !== grant.archiveDigest) reject('VISUAL_READBACK');
  return { ok: true, errors: [], level: 'L3', completedAt: patch.completedAt,
    decisionStatus: 'human_exception', exceptionId: grant.id, waivedErrors: [...baseline.errors],
    originalVerdict: { ...baseline, errors: [...baseline.errors] }, patchVerdict: patch,
    baselineSourceSha: grant.baselineSha, renderedSourceSha: grant.renderedSha };
}
