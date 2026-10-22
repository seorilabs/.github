import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { ALL_FEATURES, DESIGN, context, evidence, plan, rounds, run } from './helpers/test-levels-fixture.mjs';
import { validEvidence as legacyEvidence, context as legacyContext } from './helpers/development-evidence-fixture.mjs';

// Synthetic contract fixtures only; not product execution, approval or source evidence.
const partial = () => ({ reason: 'Process ended before remaining combinations were reviewed.',
  originalReportSha256: 'd'.repeat(64), evidence: ['https://example.com/raw-partial'],
  actualScope: { completed: ['small-ko/title'], incomplete: ['small-ko/journey'], notRun: ['large-en/journey'] } });
const approval = (maxRound, approvedAt) => ({ approverKind: 'human', approver: 'owner', approvedAt, maxRound,
  evidence: `https://example.com/approval-${maxRound}` });
const historical = number => {
  const round = structuredClone(rounds(ALL_FEATURES)[0]);
  const at = minute => `2026-10-14T00:${String(minute).padStart(2, '0')}:00Z`;
  const minute = (number - 4) * 4;
  Object.assign(round, { number, sourceSha: 'c'.repeat(40), reviewer: 'historical-reviewer',
    plannedAt: at(minute), startedAt: at(minute + 1), completedAt: at(minute + 3) });
  return { round, implementer: 'historical-author', originalReportSha256: 'c'.repeat(64), evidence: ['https://example.com/original'] };
};
const markInterrupted = record => {
  record.originalReportSha256 = 'd'.repeat(64);record.round.interruption = partial();
  for (const aspect of ['functional', 'ux']) {
    record.round[aspect].status = 'failed';record.round[aspect].featureIds = ['create'];
    record.round[aspect].resolutionEvidence = 'https://example.com/actual-new-candidate-full-review';
  }
  return record;
};
const fixture = () => {
  const complete = [4, 5, 6, 7, 8, 9, 11].map(historical);
  complete.at(-1).round.functional.status = 'failed';
  complete.at(-1).round.functional.resolutionEvidence = 'https://example.com/actual-new-candidate-reinspection';
  return {
    document: evidence({
      reviewHistoryRecovery: { reason: 'Original metadata gaps and every later original retained without current credit.',
        attempts: [1, 2, 3].map(number => ({ number, sourceSha: null, plannedAt: null, startedAt: null,
          completedAt: `2026-10-13T2${number}:00:00Z`, reviewer: 'historical-reviewer',
          functionalStatus: 'passed', uxStatus: number === 1 ? 'failed' : 'passed',
          resolutionEvidence: 'https://example.com/actual-follow-up', evidence: ['https://example.com/raw-gap'], originalReportSha256: String(number).repeat(64) })),
        completedRounds: complete, interruptedRounds: [markInterrupted(historical(10))],
      },
      reviewRounds: rounds(ALL_FEATURES).map(r => ({ ...r, number: r.number + 11 })),
      additionalIterationApproval: null,
      additionalIterationApprovals: [approval(6, '2026-10-13T23:10:00Z'), approval(7, '2026-10-14T00:11:30Z'),
        approval(10, '2026-10-14T00:15:30Z'), approval(11, '2026-10-14T00:27:30Z'), approval(14, '2026-10-14T00:40:00Z')],
      runs: [run('dev-all', 'godot-editor', ALL_FEATURES, { executor: 'independent-agent' })],
    }),
    ctx: context({ plans: { [DESIGN]: { approved: true, plan: plan({ level: 'L3', redesign: true, changedFeatures: ALL_FEATURES, foundationRerun: true }) } } }),
  };
};
const check = f => validateDevelopmentEvidence(f.document, f.ctx);
const oldPartial = f => f.document.reviewHistoryRecovery.interruptedRounds[0];

test('past interrupted10 and complete failed11 preserve originals while current12 through14 provide three complete reviews', () => {
  const f = fixture();const original = structuredClone(f.document);
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));assert.deepEqual(f.document, original);
  assert.equal(oldPartial(f).round.functional.status, 'failed');
  assert.equal(f.document.reviewHistoryRecovery.attempts[0].sourceSha, null);
});
test('multiple separate historical interruptions preserve their true positions with zero current credit', () => {
  const f = fixture();const h = f.document.reviewHistoryRecovery;
  const record = h.completedRounds.splice(2, 1)[0];h.interruptedRounds.unshift(markInterrupted(record));
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
test('blocked past interruption can preserve all units as unrun', () => {
  const f = fixture();const r = oldPartial(f).round;
  r.functional.status = 'blocked';r.ux.status = 'blocked';
  r.interruption.actualScope = { completed: [], incomplete: [], notRun: ['all/journeys'] };
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
test('past interruption does not require any intervening complete history', () => {
  const f = fixture();const h = f.document.reviewHistoryRecovery;
  delete h.completedRounds;h.interruptedRounds = [markInterrupted(historical(4))];
  f.document.reviewRounds.forEach((r, i) => { r.number = i + 5; });
  f.document.additionalIterationApprovals = [approval(4, '2026-10-13T23:10:00Z'), approval(7, '2026-10-14T00:10:00Z')];
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
test('historic feature identities remain their original scope rather than the new inventory', () => {
  const f = fixture();oldPartial(f).round.functional.featureIds = ['retired-original-feature'];
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});

for (const [name, mutate] of [
  ['missing interruption marker', f => delete oldPartial(f).round.interruption],
  ['passed functional disguised as interrupted', f => { oldPartial(f).round.functional.status = 'passed'; }],
  ['passed UX disguised as interrupted', f => { oldPartial(f).round.ux.status = 'passed'; }],
  ['missing original report digest', f => delete oldPartial(f).originalReportSha256],
  ['malformed original report digest', f => { oldPartial(f).originalReportSha256 = 'short'; }],
  ['outer and interrupted original report hashes disagree', f => { oldPartial(f).originalReportSha256 = 'e'.repeat(64); }],
  ['missing interrupted original digest', f => delete oldPartial(f).round.interruption.originalReportSha256],
  ['missing original evidence', f => { oldPartial(f).evidence = []; }],
  ['missing actual scope', f => delete oldPartial(f).round.interruption.actualScope],
  ['completion-only scope', f => { oldPartial(f).round.interruption.actualScope = { completed: ['all'], incomplete: [], notRun: [] }; }],
  ['overlap between completed and unrun units', f => { oldPartial(f).round.interruption.actualScope.notRun = ['small-ko/title']; }],
  ['duplicate incomplete units', f => { oldPartial(f).round.interruption.actualScope.incomplete = ['small-ko/journey', 'small-ko/journey']; }],
  ['blank actual reason', f => { oldPartial(f).round.interruption.reason = ' '; }],
  ['blank actual interruption evidence', f => { oldPartial(f).round.interruption.evidence = [' ']; }],
  ['unknown original source', f => { oldPartial(f).round.sourceSha = null; }],
  ['malformed original source', f => { oldPartial(f).round.sourceSha = 'short'; }],
  ['unknown original plan time', f => { oldPartial(f).round.plannedAt = null; }],
  ['unknown original start time', f => { oldPartial(f).round.startedAt = null; }],
  ['impossible original calendar date', f => { oldPartial(f).round.plannedAt = '2026-02-30T00:24:00Z'; }],
  ['original plan after start', f => { oldPartial(f).round.plannedAt = '2026-10-14T00:26:00Z'; }],
  ['interruption overlaps preceding complete history', f => { oldPartial(f).round.plannedAt = '2026-10-14T00:22:00Z'; }],
  ['interruption overlaps following complete history', f => { oldPartial(f).round.completedAt = '2026-10-14T00:29:00Z'; }],
  ['original completion in future', f => { oldPartial(f).round.completedAt = '2026-10-15T00:27:00Z'; }],
  ['historical implementer reviews own interruption', f => { oldPartial(f).round.reviewer = ' HISTORICAL-AUTHOR '; }],
  ['missing actual functional resolution', f => delete oldPartial(f).round.functional.resolutionEvidence],
  ['missing actual UX resolution', f => delete oldPartial(f).round.ux.resolutionEvidence],
  ['missing full failed11 resolution', f => delete f.document.reviewHistoryRecovery.completedRounds.at(-1).round.functional.resolutionEvidence],
  ['same interruption twice', f => { f.document.reviewHistoryRecovery.interruptedRounds.push(structuredClone(oldPartial(f))); }],
  ['duplicate number across complete and interrupted', f => { oldPartial(f).round.number = 9; }],
  ['partial recorded in complete history', f => { const h = f.document.reviewHistoryRecovery;h.completedRounds.splice(6, 0, h.interruptedRounds.pop());delete h.interruptedRounds; }],
  ['missing interrupted real number', f => { delete f.document.reviewHistoryRecovery.interruptedRounds; }],
  ['completed history reordered', f => { f.document.reviewHistoryRecovery.completedRounds.reverse(); }],
  ['current sequence ignores interrupted cap count', f => { f.document.reviewRounds.forEach(r => r.number--); }],
  ['history substitutes for a third complete current review', f => { f.document.reviewRounds.pop(); }],
  ['current source differs', f => { f.document.reviewRounds[0].sourceSha = 'c'.repeat(40); }],
  ['current reviewer is implementer', f => { f.document.reviewRounds[0].reviewer = f.document.implementer; }],
  ['current full functional review lacks noncore feature', f => { f.document.reviewRounds[0].functional.featureIds = ['create', 'store', 'purchase']; }],
  ['current full UX review lacks noncore feature', f => { f.document.reviewRounds[0].ux.featureIds = ['create', 'store', 'purchase']; }],
  ['last review failed despite future resolution text', f => { const r = f.document.reviewRounds.at(-1);r.ux.status = 'failed';r.ux.resolutionEvidence = 'https://example.com/future'; }],
  ['old maximum10 approval dropped', f => { f.document.additionalIterationApprovals.splice(2, 1); }],
  ['old maximum11 approval dropped', f => { f.document.additionalIterationApprovals.splice(3, 1); }],
  ['new maximum14 approval dropped', f => { f.document.additionalIterationApprovals.pop(); }],
  ['old cap excludes interrupted10', f => { f.document.additionalIterationApprovals[2].maxRound = 9; }],
  ['new cap excludes current14', f => { f.document.additionalIterationApprovals.at(-1).maxRound = 13; }],
  ['replacement approval predates last historical completion', f => { f.document.additionalIterationApprovals.at(-1).approvedAt = '2026-10-14T00:25:00Z'; }],
  ['new approval follows current12 plan', f => { f.document.additionalIterationApprovals.at(-1).approvedAt = '2026-10-14T01:02:00Z'; }],
  ['new plan overlaps final historical failed11', f => { f.document.reviewRounds[0].plannedAt = '2026-10-14T00:30:00Z'; }],
]) test(`past interruption rejects ${name}`, () => { const f = fixture();mutate(f);assert.equal(check(f).ok, false, JSON.stringify(check(f))); });

test('separate interrupted-history entries must retain their own original order', () => {
  const f = fixture();const h = f.document.reviewHistoryRecovery;h.interruptedRounds.push(markInterrupted(h.completedRounds.splice(2, 1)[0]));
  assert.equal(check(f).ok, false, JSON.stringify(check(f)));
});
test('history recovery still requires an approved UI redesign', () => {
  const f = fixture();f.ctx.plans[DESIGN].plan.redesign = false;assert.equal(check(f).ok, false);
});
test('fresh runtime cannot refresh expired current complete reviews', () => {
  const f = fixture();f.ctx.now = '2026-10-22T06:00:00Z';
  f.document.runs.forEach(r => { for (const k of ['plannedAt', 'startedAt', 'completedAt']) r[k] = r[k].replace('2026-10-14', '2026-10-22'); });
  assert.equal(check(f).ok, false);
});
test('past interruption cannot waive release platform floors', () => {
  const f = fixture();f.ctx.phase = 'before-release';f.ctx.changes = { 'v1.0.0': ['export_presets.cfg'] };
  assert.equal(check(f).ok, false);
});
test('existing complete-history reports without interruption keep their behavior', () => {
  const f = fixture();const h = f.document.reviewHistoryRecovery;const r = h.interruptedRounds.pop();delete r.round.interruption;
  h.completedRounds.splice(6, 0, r);delete h.interruptedRounds;
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
test('normal v2 without history keeps its behavior', () => {
  const f = fixture();delete f.document.reviewHistoryRecovery;f.document.reviewRounds = rounds(ALL_FEATURES);f.document.additionalIterationApprovals = undefined;
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
test('legacy input lifetime and rejection of new history are unchanged', () => {
  const ctx = { ...legacyContext, now: '2026-10-14T06:00:00Z' };assert.equal(validateDevelopmentEvidence(legacyEvidence(), ctx).ok, true);
  const d = legacyEvidence();d.reviewHistoryRecovery = fixture().document.reviewHistoryRecovery;assert.equal(validateDevelopmentEvidence(d, ctx).ok, false);
  assert.equal(validateDevelopmentEvidence(legacyEvidence(), { ...ctx, now: '2026-10-22T00:00:00Z' }).ok, false);
});
