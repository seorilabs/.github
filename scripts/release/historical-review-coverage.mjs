import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { policy, RELEASE_ONLY_TARGETS } from './test-plan.mjs';

const grants = (policy.historicalReviewCoverage?.grantRegistry ?? [])
  .map(path => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')));
const maxAge = policy.runs.maxAgeHours * 60 * 60 * 1000;
const digest = document => createHash('sha256').update(JSON.stringify(document)).digest('hex');

// 중앙에서 검토한 원본에만 적용한다. 런타임 CLI/환경변수로 grant를 추가하지 않는다.
export function applyHistoricalReviewCoverage(document, context, original, registry = grants) {
  if (context.phase === 'before-release'
    || (context.phase === 'before-deploy' && RELEASE_ONLY_TARGETS.includes(context.target))
    || original?.ok || document?.schemaVersion !== 2 || original?.level !== 'L3'
    || !Array.isArray(original?.errors) || original.errors.length === 0) return original;
  const now = Date.parse(context.now ?? new Date().toISOString());
  const latest = document.reviewRounds?.at(-1);
  if (!latest || latest.sourceSha !== document.sourceSha || latest.functional?.status !== 'passed'
    || latest.ux?.status !== 'passed') return original;
  const matches = registry.filter(grant => {
    if (!grant || grant.schemaVersion !== 1 || typeof grant.id !== 'string' || !grant.id.trim() || grant.repository !== document.repository
      || grant.repository !== context.repository || grant.sourceSha !== document.sourceSha
      || grant.sourceSha !== context.sourceSha || document.target !== context.target
      || !Array.isArray(grant.phases) || !grant.phases.includes(context.phase)
      || !Array.isArray(grant.tags) || (context.tag !== undefined && !grant.tags.includes(context.tag))
      || grant.latestRound !== latest.number) return false;
    const start = Date.parse(grant.approvedAt), end = Date.parse(grant.expiresAt);
    if (![now, start, end].every(Number.isFinite) || !(start <= now && now < end)
      || !(end > start && end - start <= maxAge)) return false;
    if (!Array.isArray(grant.errors) || new Set(grant.errors).size !== grant.errors.length
      || grant.errors.length !== original.errors.length || !original.errors.every(error => grant.errors.includes(error))) return false;
    const historical = grant.errors.every(error => {
      const match = /^FEATURE_COVERAGE (functional|ux)-([1-9][0-9]*)$/u.exec(error);
      if (!match || Number(match[2]) >= latest.number) return false;
      const round = document.reviewRounds.find(round => round.number === Number(match[2]));
      const aspect = round?.[match[1]];
      return aspect && aspect.status !== 'passed' && typeof aspect.resolutionEvidence === 'string'
        && aspect.resolutionEvidence.trim().length > 0;
    });
    return historical && /^[a-f0-9]{64}$/u.test(grant.evidenceHashes?.[context.target] ?? '')
      && digest(document) === grant.evidenceHashes[context.target];
  });
  if (matches.length !== 1) return original;
  return { ...original, ok: true, errors: [], decisionStatus: 'human_exception', exceptionId: matches[0].id,
    waivedErrors: [...original.errors], originalVerdict: { ...original, errors: [...original.errors] } };
}
