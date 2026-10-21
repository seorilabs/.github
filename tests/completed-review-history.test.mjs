import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { ALL_FEATURES, DESIGN, context, evidence, plan, rounds, run } from './helpers/test-levels-fixture.mjs';

// Synthetic contract inputs; these are not product UI execution records.
const fixture = () => ({
  document: evidence({
    reviewHistoryRecovery: {
      reason: 'Incomplete initial history and one complete superseded candidate review remain without pass credit.',
      attempts: [1, 2, 3].map(number => ({
        number, sourceSha: number === 3 ? 'c'.repeat(40) : null,
        plannedAt: null, startedAt: null, completedAt: `2026-10-13T2${number}:00:00Z`,
        reviewer: 'historical-reviewer', functionalStatus: 'passed', uxStatus: number === 1 ? 'failed' : 'passed',
        evidence: [`https://example.com/original-${number}`], originalReportSha256: String(number).repeat(64),
        resolutionEvidence: 'https://example.com/actual-resolution',
      })),
      completedRounds: [{
        round: { ...rounds()[0], number: 4, sourceSha: 'c'.repeat(40),
          plannedAt: '2026-10-14T00:00:00Z', startedAt: '2026-10-14T00:01:00Z', completedAt: '2026-10-14T00:10:00Z',
          reviewer: 'historical-reviewer' },
        implementer: 'historical-author', originalReportSha256: 'd'.repeat(64),
        evidence: ['https://example.com/original-complete-round4'],
      }],
    },
    reviewRounds: rounds(ALL_FEATURES).map(r => ({ ...r, number: r.number + 4 })),
    additionalIterationApproval: null,
    additionalIterationApprovals: [
      { approverKind: 'human', approver: 'owner', approvedAt: '2026-10-13T23:10:00Z', maxRound: 6, evidence: 'https://example.com/original-max6' },
      { approverKind: 'human', approver: 'owner', approvedAt: '2026-10-14T00:20:00Z', maxRound: 7, evidence: 'https://example.com/new-max7' },
    ],
    runs: [run('dev-all', 'godot-editor', ALL_FEATURES, { executor: 'independent-agent' })],
  }),
  ctx: context({ plans: { [DESIGN]: { approved: true, plan: plan({ level: 'L3', redesign: true, changedFeatures: ALL_FEATURES, foundationRerun: true }) } } }),
});

const check = ({ document, ctx }) => validateDevelopmentEvidence(document, ctx);
test('complete old round4 keeps its original approval and gives no credit to new candidate rounds5 through7', () => {
  const f = fixture();
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});

test('historical completeness does not retroactively require features added to the new candidate', () => {
  const f = fixture();
  f.document.reviewHistoryRecovery.completedRounds[0].round.functional.featureIds.push('retired-feature');
  f.document.reviewHistoryRecovery.completedRounds[0].round.ux.featureIds.push('retired-feature');
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});

test('historical independence is checked against its actual implementer', () => {
  const f = fixture();
  f.document.reviewHistoryRecovery.completedRounds[0].round.reviewer = f.document.implementer;
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});

for (const [name, mutate] of [
  ['old round counted as one of only two new complete reviews', d => d.reviewRounds.pop()],
  ['new rounds renamed4 through6', d => d.reviewRounds.forEach((r, i) => r.number = i + 4)],
  ['historical number skipped', d => d.reviewHistoryRecovery.completedRounds[0].round.number = 5],
  ['historical source SHA null', d => d.reviewHistoryRecovery.completedRounds[0].round.sourceSha = null],
  ['historical source SHA malformed', d => d.reviewHistoryRecovery.completedRounds[0].round.sourceSha = 'short'],
  ['historical plan time null', d => d.reviewHistoryRecovery.completedRounds[0].round.plannedAt = null],
  ['historical start time absent', d => delete d.reviewHistoryRecovery.completedRounds[0].round.startedAt],
  ['historical impossible date', d => d.reviewHistoryRecovery.completedRounds[0].round.plannedAt = '2026-02-30T00:00:00Z'],
  ['historical plan after start', d => d.reviewHistoryRecovery.completedRounds[0].round.plannedAt = '2026-10-14T00:05:00Z'],
  ['historical overlaps original history', d => d.reviewHistoryRecovery.completedRounds[0].round.plannedAt = '2026-10-13T22:59:00Z'],
  ['historical completion in future', d => d.reviewHistoryRecovery.completedRounds[0].round.completedAt = '2026-10-15T00:10:00Z'],
  ['historical original digest missing', d => delete d.reviewHistoryRecovery.completedRounds[0].originalReportSha256],
  ['historical original digest malformed', d => d.reviewHistoryRecovery.completedRounds[0].originalReportSha256 = 'short'],
  ['historical original evidence missing', d => d.reviewHistoryRecovery.completedRounds[0].evidence = []],
  ['historical actual implementer missing', d => delete d.reviewHistoryRecovery.completedRounds[0].implementer],
  ['historical reviewer is its implementer', d => d.reviewHistoryRecovery.completedRounds[0].round.reviewer = 'historical-author'],
  ['historical functional failure lacks resolution', d => d.reviewHistoryRecovery.completedRounds[0].round.functional.status = 'failed'],
  ['only later max7 approval retained', d => d.additionalIterationApprovals.shift()],
  ['historical approval follows original plan', d => d.additionalIterationApprovals[0].approvedAt = '2026-10-14T00:05:00Z'],
  ['historical approval predates initial history completion', d => d.additionalIterationApprovals[0].approvedAt = '2026-10-13T22:59:00Z'],
  ['new approval predates last historical completion', d => d.additionalIterationApprovals[1].approvedAt = '2026-10-14T00:05:00Z'],
  ['new approval follows first new plan', d => d.additionalIterationApprovals[1].approvedAt = '2026-10-14T01:05:00Z'],
  ['new approval cap ends at6', d => d.additionalIterationApprovals[1].maxRound = 6],
  ['new candidate source differs', d => d.reviewRounds[0].sourceSha = 'c'.repeat(40)],
  ['new functional feature missing', d => d.reviewRounds[0].functional.featureIds = ['create', 'store', 'purchase']],
  ['new UX feature missing', d => d.reviewRounds[0].ux.featureIds = ['create', 'store', 'purchase']],
  ['new reviewer is implementer', d => d.reviewRounds[0].reviewer = d.implementer],
  ['new plan overlaps historical round', d => d.reviewRounds[0].plannedAt = '2026-10-14T00:09:00Z'],
  ['new plan overlaps previous new round', d => d.reviewRounds[1].plannedAt = '2026-10-14T01:05:00Z'],
  ['last new review blocked', d => d.reviewRounds[2].ux.status = 'blocked'],
  ['empty complete history field', d => d.reviewHistoryRecovery.completedRounds = []],
  ['original incomplete history truncated', d => d.reviewHistoryRecovery.attempts.pop()],
]) test(`complete history blocks ${name}`, () => {
  const f = fixture(); mutate(f.document); assert.equal(check(f).ok, false, JSON.stringify(check(f)));
});

test('failed historical verdict is retained with its actual resolution', () => {
  const f = fixture();
  const result = f.document.reviewHistoryRecovery.completedRounds[0].round.functional;
  result.status = 'failed'; result.resolutionEvidence = 'https://example.com/actual-fix';
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
  assert.equal(result.status, 'failed');
});

test('fresh run cannot refresh stale new reviews after a complete historical round', () => {
  const f = fixture();
  f.ctx.now = '2026-10-22T06:00:00Z';
  f.document.runs.forEach(r => { for (const k of ['plannedAt', 'startedAt', 'completedAt']) r[k] = r[k].replace('2026-10-14', '2026-10-22'); });
  assert.ok(check(f).errors.includes('REVIEW_RECOVERY_EXPIRED'));
});

test('complete history does not waive before-release platform floors', () => {
  const f = fixture(); f.ctx.phase = 'before-release'; f.ctx.changes = { 'v1.0.0': ['export_presets.cfg'] };
  assert.ok(check(f).errors.some(e => e.startsWith('TEST_LEVEL_BELOW_FLOOR')));
});

const twoHistoricalRounds = () => {
  const f = fixture();
  const second = structuredClone(f.document.reviewHistoryRecovery.completedRounds[0]);
  Object.assign(second.round, { number: 5, plannedAt: '2026-10-14T00:11:00Z', startedAt: '2026-10-14T00:12:00Z', completedAt: '2026-10-14T00:15:00Z' });
  f.document.reviewHistoryRecovery.completedRounds.push(second);
  f.document.reviewRounds.forEach(r => r.number++);
  f.document.additionalIterationApprovals[1].maxRound = 8;
  return f;
};
test('multiple complete historical rounds retain one original approval for its original scope', () => {
  const f = twoHistoricalRounds(); assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
test('each historical round must remain inside its actual earlier approval cap', () => {
  const f = twoHistoricalRounds(); f.document.additionalIterationApprovals[0].maxRound = 4;
  assert.ok(check(f).errors.includes('EXTRA_ROUND_APPROVAL_REQUIRED'));
});
test('complete historical rounds cannot overlap each other', () => {
  const f = twoHistoricalRounds(); f.document.reviewHistoryRecovery.completedRounds[1].round.plannedAt = '2026-10-14T00:09:00Z';
  assert.ok(check(f).errors.includes('REVIEW_RECOVERY_COMPLETED_TIME'));
});
