import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { ALL_FEATURES, DESIGN, context, evidence, plan, rounds, run } from './helpers/test-levels-fixture.mjs';

const fixture = () => ({
  document: evidence({
    reviewHistoryRecovery: {
      reason: 'Initial source snapshots and plan times were not recorded; originals retained without credit.',
      attempts: [1, 2, 3].map(number => ({
        number, sourceSha: number === 3 ? 'c'.repeat(40) : null,
        plannedAt: null, startedAt: null, completedAt: `2026-10-13T2${number}:00:00Z`,
        reviewer: 'historical-reviewer', functionalStatus: number === 2 ? 'failed' : 'passed',
        uxStatus: number === 1 ? 'failed' : 'passed',
        evidence: [`https://example.com/original-${number}`], originalReportSha256: String(number).repeat(64),
        resolutionEvidence: 'https://example.com/current-complete-reviews',
      })),
    },
    reviewRounds: rounds(ALL_FEATURES).map(r => ({ ...r, number: r.number + 3 })),
    additionalIterationApproval: { approverKind: 'human', approver: 'owner', approvedAt: '2026-10-14T00:00:00Z', maxRound: 6, evidence: 'https://example.com/explicit-recovery-approval' },
    runs: [run('dev-all', 'godot-editor', ALL_FEATURES, { executor: 'independent-agent' })],
  }),
  ctx: context({ plans: { [DESIGN]: { approved: true, plan: plan({ level: 'L3', redesign: true, changedFeatures: ALL_FEATURES, foundationRerun: true }) } } }),
});
const check = (d, c) => validateDevelopmentEvidence(d, c);
test('three complete new reviews preserve incomplete history without credit or fabricated fields', () => {
  const {document, ctx} = fixture(); assert.equal(check(document, ctx).ok, true, JSON.stringify(check(document, ctx)));
});
for (const [name, mutate] of [
  ['history truncated to one attempt', d => { d.reviewHistoryRecovery.attempts = [d.reviewHistoryRecovery.attempts[0]]; d.reviewRounds.forEach((r,i) => r.number=i+2); }],
  ['noncore feature omitted', d => d.reviewRounds[0].ux.featureIds = ['create','store','purchase']],
  ['normalized impossible calendar date', d => d.reviewHistoryRecovery.attempts[0].completedAt='2026-02-30T21:00:00Z'],
  ['only two complete replacement reviews', d => d.reviewRounds.pop()],
  ['new rounds renamed to 1 through 3', d => d.reviewRounds.forEach((r,i) => r.number = i + 1)],
  ['no human additional approval', d => d.additionalIterationApproval = null],
  ['approval predates the last original attempt', d => d.additionalIterationApproval.approvedAt = '2026-10-13T22:30:00Z'],
  ['approval follows the new plan', d => d.additionalIterationApproval.approvedAt = '2026-10-14T01:02:00Z'],
  ['approval cap ends before round6', d => d.additionalIterationApproval.maxRound = 5],
  ['new source differs from candidate', d => d.reviewRounds[0].sourceSha = 'd'.repeat(40)],
  ['new reviewer is implementer', d => d.reviewRounds[0].reviewer = d.implementer],
  ['new core coverage missing', d => d.reviewRounds[0].ux.featureIds = []],
  ['last review failed', d => d.reviewRounds[2].functional.status = 'failed'],
  ['historical failed verdict has no resolution', d => delete d.reviewHistoryRecovery.attempts[0].resolutionEvidence],
  ['original report digest absent', d => delete d.reviewHistoryRecovery.attempts[0].originalReportSha256],
  ['history sequence skips an attempt', d => d.reviewHistoryRecovery.attempts[1].number = 3],
  ['history completes after current plan', d => d.reviewHistoryRecovery.attempts[2].completedAt = '2026-10-14T02:30:00Z'],
  ['history has invalid date', d => d.reviewHistoryRecovery.attempts[0].completedAt = '2026-99-13T21:00:00Z'],
  ['history includes unauthorized fourth attempt', d => d.reviewHistoryRecovery.attempts.push({...d.reviewHistoryRecovery.attempts[2],number:4})],
  ['history has no actual metadata gap', d => d.reviewHistoryRecovery.attempts.forEach(a => {a.sourceSha='c'.repeat(40);a.plannedAt='2026-10-13T19:00:00Z';a.startedAt='2026-10-13T20:00:00Z';})],
  ['run has wrong candidate SHA', d => d.runs[0].sourceSha = 'd'.repeat(40)],
  ['run is stale', d => d.runs[0].completedAt = '2026-10-01T05:10:00Z'],
]) test(`recovery blocks ${name}`, () => { const {document,ctx}=fixture();mutate(document);assert.equal(check(document,ctx).ok,false); });
test('recovery cannot be used without an approved redesign plan', () => {
  const {document,ctx}=fixture();ctx.plans[DESIGN].plan.redesign=false;assert.equal(check(document,ctx).ok,false);
});

test('fresh run cannot refresh stale recovery reviews', () => {
  const {document,ctx}=fixture();
  document.reviewHistoryRecovery.attempts.forEach(a => { a.completedAt=a.completedAt.replace('2026-10-13','2026-09-13'); });
  document.additionalIterationApproval.approvedAt='2026-09-14T00:00:00Z';
  document.reviewRounds.forEach(r => { for(const k of ['plannedAt','startedAt','completedAt']) r[k]=r[k].replace('2026-10-14','2026-10-01'); });
  assert.ok(check(document,ctx).errors.includes('REVIEW_RECOVERY_EXPIRED'));
});
