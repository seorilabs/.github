import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { ALL_FEATURES, DESIGN, context, evidence, plan, rounds, run } from './helpers/test-levels-fixture.mjs';

// Synthetic contract fixtures only, not product execution or actual human approval.
const approval = (maxRound, approvedAt) => ({ approverKind: 'human', approver: 'fixture-owner', maxRound, approvedAt,
  evidence: 'https://example.com/synthetic-prior-approval' });
const original = number => {
  const round = structuredClone(rounds(ALL_FEATURES)[0]);
  const hour = 20 + number;
  Object.assign(round, { number, sourceSha: 'c'.repeat(40), reviewer: 'historical-reviewer',
    plannedAt: `2026-10-13T${hour}:00:00Z`, startedAt: `2026-10-13T${hour}:01:00Z`, completedAt: `2026-10-13T${hour}:10:00Z` });
  return { round, implementer: 'historical-author', originalReportSha256: String(number).repeat(64),
    evidence: [`https://example.com/original-${number}`] };
};
const interrupted = record => {
  record.round.interruption = { reason: 'Actual partial original is retained without current credit.',
    originalReportSha256: record.originalReportSha256,
    actualScope: { completed: ['create'], incomplete: ['settings'], notRun: ['ads'] }, evidence: record.evidence };
  for (const aspect of ['functional', 'ux']) {
    record.round[aspect].status = 'blocked';
    record.round[aspect].resolutionEvidence = 'https://example.com/actual-followup';
  }
  return record;
};
const fixture = () => {
  const second = original(2);second.round.ux.status = 'failed';
  second.round.ux.resolutionEvidence = 'https://example.com/fixed-third';
  return { document: evidence({
    reviewHistoryRecovery: { reason: 'Known initial interrupted, failed and passed records remain exact.', attempts: [],
      interruptedRounds: [interrupted(original(1))], completedRounds: [second, original(3)] },
    reviewRounds: rounds(ALL_FEATURES).map(r => ({ ...r, number: r.number + 3 })),
    additionalIterationApproval: approval(6, '2026-10-14T00:00:00Z'),
    runs: [run('dev-all', 'godot-editor', ALL_FEATURES, { executor: 'independent-agent' })],
  }), ctx: context({ plans: { [DESIGN]: { approved: true, plan: plan({ level: 'L3', redesign: true,
    changedFeatures: ALL_FEATURES, foundationRerun: true }) } } }) };
};
const check = f => validateDevelopmentEvidence(f.document, f.ctx);

test('known initial records need no fabricated metadata gaps and give zero current credit', () => {
  const f = fixture();const before = structuredClone(f.document);
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
  assert.deepEqual(f.document, before);
  assert.equal(f.document.reviewHistoryRecovery.interruptedRounds[0].round.functional.status, 'blocked');
  assert.equal(f.document.reviewHistoryRecovery.completedRounds[0].round.ux.status, 'failed');
});
test('fully known completed history without interruptions is retained', () => {
  const f = fixture();const h = f.document.reviewHistoryRecovery;const first = original(1);
  h.completedRounds.unshift(first);delete h.interruptedRounds;
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
test('fully known interrupted history without complete originals is retained', () => {
  const f = fixture();const h = f.document.reviewHistoryRecovery;
  h.interruptedRounds = [1, 2, 3].map(n => interrupted(original(n)));delete h.completedRounds;
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
test('known first interruption preserves remaining original slots and still needs round4 approval', () => {
  const f = fixture();delete f.document.reviewHistoryRecovery.completedRounds;
  f.document.reviewRounds.forEach((r, i) => { r.number = i + 2; });
  f.document.additionalIterationApproval = approval(4, '2026-10-14T00:00:00Z');
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
  f.document.additionalIterationApproval = null;
  assert.equal(check(f).ok, false);
});

const withOldFourth = () => {
  const f = fixture();const fourth = original(3);
  Object.assign(fourth.round, { number: 4, plannedAt: '2026-10-14T00:05:00Z', startedAt: '2026-10-14T00:06:00Z', completedAt: '2026-10-14T00:10:00Z' });
  f.document.reviewHistoryRecovery.completedRounds.push(fourth);
  f.document.reviewRounds.forEach((r, i) => { r.number = i + 5; });
  f.document.additionalIterationApproval = null;
  f.document.additionalIterationApprovals = [approval(4, '2026-10-13T23:20:00Z'), approval(7, '2026-10-14T00:20:00Z')];
  return f;
};
test('known old round4 retains its own approval before replacement5 through7', () => {
  const f = withOldFourth();assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});
for (const [name, mutate] of [
  ['missing old approval', f => f.document.additionalIterationApprovals.shift()],
  ['old approval before original round3 ended', f => { f.document.additionalIterationApprovals[0].approvedAt = '2026-10-13T22:30:00Z'; }],
  ['old approval after its own plan', f => { f.document.additionalIterationApprovals[0].approvedAt = '2026-10-14T00:06:00Z'; }],
  ['replacement approval before last old completion', f => { f.document.additionalIterationApprovals[1].approvedAt = '2026-10-14T00:09:00Z'; }],
]) test(`known historical extra rejects ${name}`, () => { const f = withOldFourth();mutate(f);assert.equal(check(f).ok, false, JSON.stringify(check(f))); });

for (const [name, mutate] of [
  ['empty history', f => { delete f.document.reviewHistoryRecovery.completedRounds;delete f.document.reviewHistoryRecovery.interruptedRounds; }],
  ['one fabricated gap record', f => { f.document.reviewHistoryRecovery.attempts = [{}]; }],
  ['two fabricated gap records', f => { f.document.reviewHistoryRecovery.attempts = [{}, {}]; }],
  ['no approved redesign', f => { f.ctx.plans[DESIGN].plan.redesign = false; }],
  ['service input with UI history', f => { f.document.productKind = 'service'; }],
  ['empty completed array', f => { f.document.reviewHistoryRecovery.completedRounds = []; }],
  ['missing known SHA', f => { f.document.reviewHistoryRecovery.completedRounds[0].round.sourceSha = null; }],
  ['missing known plan time', f => { f.document.reviewHistoryRecovery.completedRounds[0].round.plannedAt = null; }],
  ['missing original digest', f => { delete f.document.reviewHistoryRecovery.completedRounds[0].originalReportSha256; }],
  ['inconsistent original digest', f => { f.document.reviewHistoryRecovery.interruptedRounds[0].originalReportSha256 = 'f'.repeat(64); }],
  ['missing failed resolution', f => { delete f.document.reviewHistoryRecovery.completedRounds[0].round.ux.resolutionEvidence; }],
  ['missing interrupted resolution', f => { delete f.document.reviewHistoryRecovery.interruptedRounds[0].round.functional.resolutionEvidence; }],
  ['interrupted original passed', f => { f.document.reviewHistoryRecovery.interruptedRounds[0].round.functional.status = 'passed'; }],
  ['missing original round', f => { f.document.reviewHistoryRecovery.completedRounds.shift(); }],
  ['duplicate original round', f => { f.document.reviewHistoryRecovery.completedRounds[0].round.number = 1; }],
  ['reordered originals', f => { f.document.reviewHistoryRecovery.completedRounds.reverse(); }],
  ['original author reviewed itself', f => { f.document.reviewHistoryRecovery.completedRounds[0].round.reviewer = 'historical-author'; }],
  ['original time overlap', f => { f.document.reviewHistoryRecovery.completedRounds[0].round.plannedAt = '2026-10-13T21:05:00Z'; }],
  ['impossible original date', f => { f.document.reviewHistoryRecovery.completedRounds[0].round.completedAt = '2026-02-30T22:10:00Z'; }],
  ['only two current reviews', f => { f.document.reviewRounds.pop(); }],
  ['current numbering hides history', f => { f.document.reviewRounds.forEach((r, i) => { r.number = i + 1; }); }],
  ['current source mismatch', f => { f.document.reviewRounds[0].sourceSha = 'c'.repeat(40); }],
  ['current author as reviewer', f => { f.document.reviewRounds[0].reviewer = f.document.implementer; }],
  ['noncore functional scope omitted', f => { f.document.reviewRounds[0].functional.featureIds = ['create', 'store', 'purchase']; }],
  ['noncore UX scope omitted', f => { f.document.reviewRounds[0].ux.featureIds = ['create', 'store', 'purchase']; }],
  ['no extra approval', f => { f.document.additionalIterationApproval = null; }],
  ['approval before history ended', f => { f.document.additionalIterationApproval.approvedAt = '2026-10-13T22:30:00Z'; }],
  ['approval after new plan', f => { f.document.additionalIterationApproval.approvedAt = '2026-10-14T01:02:00Z'; }],
  ['cap below current round6', f => { f.document.additionalIterationApproval.maxRound = 5; }],
  ['failed final review', f => { f.document.reviewRounds.at(-1).ux.status = 'failed';f.document.reviewRounds.at(-1).ux.resolutionEvidence = 'https://example.com/future'; }],
]) test(`known history rejects ${name}`, () => { const f = fixture();mutate(f);assert.equal(check(f).ok, false, JSON.stringify(check(f))); });

test('fresh runtime cannot refresh expired current reviews with known history', () => {
  const f = fixture();f.ctx.now = '2026-10-22T06:00:00Z';
  f.document.runs.forEach(r => { for (const k of ['plannedAt', 'startedAt', 'completedAt']) r[k] = r[k].replace('2026-10-14', '2026-10-22'); });
  assert.equal(check(f).ok, false);
});
