import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { ALL_FEATURES, DESIGN, context, evidence, plan, rounds, run } from './helpers/test-levels-fixture.mjs';

function fixture() {
  const originals = structuredClone(rounds([...ALL_FEATURES]));
  const history = { reason: '전체 시각 검토 전에 다음 회차를 시작했다', rounds: originals.map(round => ({
    round, implementer: 'author-agent', originalReportSha256: String(round.number).repeat(64), evidence: ['https://example.com/original'],
    resolutionEvidence: 'https://example.com/fresh-rounds4-6',
    correction: {
      number: round.number, sourceSha: round.sourceSha, originalReportSha256: String(round.number).repeat(64),
      recordedAt: '2026-10-14T03:40:00Z', visualReviewCompletedAt: `2026-10-14T03:${round.number === 3 ? '10' : '25'}:00Z`,
      functionalStatus: 'passed', uxStatus: round.number < 3 ? 'blocked' : 'passed',
      reportSha256: 'c'.repeat(64), reason: '원래 판정과 실제 전체 화면 열람 시각을 보존한다', evidence: ['https://example.com/correction'],
    },
  })) };
  const current = structuredClone(rounds([...ALL_FEATURES])).map(round => ({ ...round, number: round.number + 3,
    plannedAt: `2026-10-14T0${round.number + 3}:00:00Z`, startedAt: `2026-10-14T0${round.number + 3}:01:00Z`, completedAt: `2026-10-14T0${round.number + 3}:10:00Z`,
  }));
  const document = evidence({ invalidInitialReviewHistory: history, reviewRounds: current,
    runs: [run('full', 'web-browser', [...ALL_FEATURES], { executor: 'independent-agent' })],
    additionalIterationApproval: { approverKind: 'human', approver: 'owner', approvedAt: '2026-10-14T03:50:00Z', maxRound: 6, evidence: 'https://example.com/extra' },
  });
  const ctx = context({ now: '2026-10-14T07:00:00Z', plans: { [DESIGN]: { approved: true, plan: plan({ level: 'L3', redesign: true }) } } });
  return { document, ctx };
}
const check = f => validateDevelopmentEvidence(f.document, f.ctx);
const has = (f, error) => assert.ok(check(f).errors.includes(error), JSON.stringify(check(f).errors));
const schemaFails = f => assert.ok(check(f).errors.some(e => e.startsWith('EVIDENCE_SCHEMA')), JSON.stringify(check(f).errors));

test('known invalid originals stay immutable and count zero before approved full rounds4/5/6', () => {
  const f = fixture(); const before = JSON.stringify(f.document.invalidInitialReviewHistory);
  assert.deepEqual(check(f).errors, []);
  assert.equal(JSON.stringify(f.document.invalidInitialReviewHistory), before);
});

for (const count of [2, 4]) test(`invalid history requires exactly3 originals, rejects ${count}`, () => {
  const f = fixture(); const entries = f.document.invalidInitialReviewHistory.rounds;
  if (count === 2) entries.pop(); else entries.push(structuredClone(entries[2]));
  schemaFails(f);
});

for (const key of ['sourceSha', 'plannedAt', 'startedAt']) test(`known original ${key} cannot be replaced with null`, () => {
  const f = fixture(); f.document.invalidInitialReviewHistory.rounds[0].round[key] = null; schemaFails(f);
});

for (const key of ['number', 'sourceSha', 'originalReportSha256']) test(`correction must match original ${key}`, () => {
  const f = fixture(); const entry = f.document.invalidInitialReviewHistory.rounds[0];
  entry.correction[key] = key === 'number' ? 2 : 'd'.repeat(key === 'sourceSha' ? 40 : 64);
  has(f, 'INVALID_INITIAL_REVIEW_CORRECTION_MISMATCH');
});

test('original numbers cannot be duplicated or reordered', () => {
  const f = fixture(); f.document.invalidInitialReviewHistory.rounds.reverse(); has(f, 'INVALID_INITIAL_REVIEW_SEQUENCE');
});

test('unresolved correction cannot be hidden by three new passes', () => {
  const f = fixture(); delete f.document.invalidInitialReviewHistory.rounds[0].resolutionEvidence;
  has(f, 'INVALID_INITIAL_REVIEW_UNRESOLVED_CORRECTION');
});

test('valid originals with no corrected failure or timing defect cannot use the recovery path', () => {
  const f = fixture();
  for (const entry of f.document.invalidInitialReviewHistory.rounds) {
    entry.correction.uxStatus = 'passed'; entry.correction.visualReviewCompletedAt = entry.round.completedAt;
  }
  has(f, 'INVALID_INITIAL_REVIEW_NO_FAILURE');
});

test('known original overlap is preserved even when the corrected observations passed', () => {
  const f = fixture(); const entries = f.document.invalidInitialReviewHistory.rounds;
  entries[0].round.completedAt = '2026-10-14T02:00:00.003Z';
  for (const entry of entries) {
    entry.correction.uxStatus = 'passed'; entry.correction.visualReviewCompletedAt = entry.round.completedAt;
  }
  assert.deepEqual(check(f).errors, []);
  assert.equal(entries[0].round.completedAt, '2026-10-14T02:00:00.003Z');
});

test('original and correction times must be real and correction follows the actual review', () => {
  const f = fixture(); f.document.invalidInitialReviewHistory.rounds[0].correction.recordedAt = '2026-10-14T03:20:00Z';
  has(f, 'INVALID_INITIAL_REVIEW_TIME');
});

test('future original evidence is rejected', () => {
  const f = fixture(); f.document.invalidInitialReviewHistory.rounds[0].round.startedAt = '2026-10-15T01:01:00Z';
  has(f, 'INVALID_INITIAL_REVIEW_TIME');
});

test('an original implementer cannot be recorded as an independent reviewer', () => {
  const f = fixture(); f.document.invalidInitialReviewHistory.rounds[0].round.reviewer = ' Author-Agent ';
  has(f, 'INVALID_INITIAL_REVIEW_INDEPENDENCE');
});

for (const when of [null, '2026-10-14T03:30:00Z', '2026-10-14T04:05:00Z']) test(`extra approval must follow correction and precede the new plan (${when})`, () => {
  const f = fixture(); if (when === null) f.document.additionalIterationApproval = null; else f.document.additionalIterationApproval.approvedAt = when;
  has(f, 'EXTRA_ROUND_APPROVAL_REQUIRED');
});

test('approval cap5 does not authorize round6', () => {
  const f = fixture(); f.document.additionalIterationApproval.maxRound = 5; has(f, 'EXTRA_ROUND_APPROVAL_REQUIRED');
});

test('the originals cannot count as one of three fresh complete reviews', () => {
  const f = fixture(); f.document.reviewRounds.pop(); has(f, 'THREE_UI_ROUNDS_REQUIRED');
});

test('new round numbers cannot restart at1', () => {
  const f = fixture(); f.document.reviewRounds.forEach(r => { r.number -= 3; }); has(f, 'ROUND_SEQUENCE');
});

test('new round plans cannot overlap a previous round', () => {
  const f = fixture(); f.document.reviewRounds[1].plannedAt = '2026-10-14T04:05:00Z'; has(f, 'ROUND_OVERLAP');
});

test('new round plan cannot precede the completed historical correction', () => {
  const f = fixture(); f.document.reviewRounds[0].plannedAt = '2026-10-14T03:35:00Z'; has(f, 'ROUND_OVERLAP');
});

test('new current candidate cannot differ from the exact product candidate', () => {
  const f = fixture(); f.document.reviewRounds[0].sourceSha = 'e'.repeat(40); has(f, 'REVIEW_RECOVERY_SOURCE_MISMATCH');
});

test('every fresh round covers all UI features, including noncore features', () => {
  const f = fixture(); f.document.reviewRounds[0].ux.featureIds = ['create', 'store', 'purchase']; has(f, 'REVIEW_RECOVERY_FULL_COVERAGE');
});

test('fresh self-review remains forbidden', () => {
  const f = fixture(); f.document.reviewRounds[0].reviewer = 'author-agent'; has(f, 'INDEPENDENT_REVIEW_REQUIRED');
});

test('expired fresh rounds remain forbidden', () => {
  const f = fixture(); f.ctx.now = '2026-10-22T07:00:00Z'; has(f, 'REVIEW_RECOVERY_EXPIRED');
});

test('fresh failed UX cannot count as one of three passes through resolution text', () => {
  const f = fixture(); f.document.reviewRounds[0].ux.status = 'blocked'; f.document.reviewRounds[0].ux.resolutionEvidence = 'https://example.com/later';
  has(f, 'THREE_UI_ROUNDS_REQUIRED');
});

test('invalid known history cannot be combined with missing-metadata history', () => {
  const f = fixture(); f.document.reviewHistoryRecovery = { reason: 'missing', attempts: [1, 2, 3].map(number => ({
    number, sourceSha: null, plannedAt: null, startedAt: null, completedAt: `2026-10-14T0${number}:10:00Z`,
    reviewer: 'review-agent', functionalStatus: 'blocked', uxStatus: 'blocked', evidence: ['https://example.com/original'],
    originalReportSha256: 'f'.repeat(64), resolutionEvidence: 'https://example.com/new',
  })) }; schemaFails(f);
});

test('service-only documents cannot use UI review recovery', () => {
  const f = fixture(); f.document.productKind = 'service'; f.ctx.requireUi = false;
  has(f, 'INVALID_INITIAL_REVIEW_REQUIRES_REDESIGN');
});

test('known invalid history does not waive platform or release checks', () => {
  const f = fixture(); f.ctx.phase = 'before-release'; f.ctx.changes['v1.0.0'].push('src/purchase/billing.ts');
  f.ctx.plans[DESIGN].plan.release = { markets: ['app-store'], until: 'test-track' };
  has(f, 'TEST_LEVEL_BELOW_FLOOR foundation purchase android'); has(f, 'RELEASE_NOT_AUTHORIZED market google-play');
  has(f, 'RELEASE_NOT_AUTHORIZED until test-track');
});

// Synthetic inputs: an additional round was interrupted after the original
// rounds, but before their later correction was recorded.
function preCorrectionInterruptionFixture() {
  const f = fixture();
  const prior = structuredClone(f.document.reviewRounds[0]);
  Object.assign(prior, {number: 4, plannedAt: '2026-10-14T03:27:00Z', startedAt: '2026-10-14T03:28:00Z', completedAt: '2026-10-14T03:29:00Z',
    interruption: {reason: 'stopped while reviewing the original history', originalReportSha256: 'd'.repeat(64), evidence: ['https://example.com/raw'], actualScope: {completed: ['headless'], incomplete: ['rendered'], notRun: ['visual']}}});
  for (const aspect of ['functional','ux']) { prior[aspect].status = 'blocked'; prior[aspect].resolutionEvidence = 'https://example.com/reinspection'; }
  f.document.invalidInitialReviewHistory.interruptedBeforeCorrection = [{round: prior, implementer: 'author-agent', originalReportSha256: 'd'.repeat(64), evidence: ['https://example.com/raw']}];
  f.document.reviewRounds.forEach(r => { r.number += 1; });
  f.document.additionalIterationApproval = null;
  f.document.additionalIterationApprovals = [
    {approverKind:'human',approver:'owner',approvedAt:'2026-10-14T03:26:00Z',maxRound:4,evidence:'https://example.com/old-approval'},
    {approverKind:'human',approver:'owner',approvedAt:'2026-10-14T03:50:00Z',maxRound:7,evidence:'https://example.com/new-approval'},
  ];
  return f;
}
test('retains a prior authorized interruption before correction and requires three later passes', () => {
  const f = preCorrectionInterruptionFixture();
  assert.deepEqual(check(f).errors, []);
});
for (const [name, mutate] of [
  ['missing prior approval', f => f.document.additionalIterationApprovals.shift()],
  ['approval after prior plan', f => f.document.additionalIterationApprovals[0].approvedAt='2026-10-14T03:28:00Z'],
  ['prior approval below round number', f => f.document.additionalIterationApprovals[0].maxRound=3],
  ['duplicated round number', f => f.document.invalidInitialReviewHistory.interruptedBeforeCorrection[0].round.number=3],
  ['missing interruption', f => delete f.document.invalidInitialReviewHistory.interruptedBeforeCorrection[0].round.interruption],
  ['inconsistent report hash', f => f.document.invalidInitialReviewHistory.interruptedBeforeCorrection[0].originalReportSha256='e'.repeat(64)],
  ['reviewer equals implementer', f => f.document.invalidInitialReviewHistory.interruptedBeforeCorrection[0].round.reviewer='author-agent'],
  ['unresolved interruption', f => delete f.document.invalidInitialReviewHistory.interruptedBeforeCorrection[0].round.ux.resolutionEvidence],
  ['interruption after correction', f => f.document.invalidInitialReviewHistory.interruptedBeforeCorrection[0].round.completedAt='2026-10-14T03:41:00Z'],
  ['missing later round', f => f.document.reviewRounds.pop()],
  ['later approval before correction', f => f.document.additionalIterationApprovals[1].approvedAt='2026-10-14T03:30:00Z'],
]) test(`prior interruption rejects ${name}`, () => {
  const f=preCorrectionInterruptionFixture();mutate(f);assert.equal(check(f).ok,false,JSON.stringify(check(f)));
});

test('prior approval cannot precede the last actual original visual check', () => {
  const f=preCorrectionInterruptionFixture();
  f.document.invalidInitialReviewHistory.rounds[1].correction.visualReviewCompletedAt='2026-10-14T03:35:00Z';
  const errors=check(f).errors;
  assert.ok(errors.includes('PRE_CORRECTION_INTERRUPTED_TIME'),JSON.stringify(errors));
  assert.ok(errors.includes('EXTRA_ROUND_APPROVAL_REQUIRED'),JSON.stringify(errors));
});
test('same-candidate interrupted review cannot name the current implementer as reviewer', () => {
  const f=preCorrectionInterruptionFixture();
  const previous=f.document.invalidInitialReviewHistory.interruptedBeforeCorrection[0];
  previous.implementer='other-agent';previous.round.reviewer=f.document.implementer;
  assert.ok(check(f).errors.includes('PRE_CORRECTION_INTERRUPTED_INDEPENDENCE'),JSON.stringify(check(f)));
});

// Retain the failed complete review rather than overwriting its verdict.
function resolvedFailedCurrentFixture() {
  const f=preCorrectionInterruptionFixture();
  const failed=f.document.reviewRounds[1];
  for (const aspect of ['functional','ux']) {
    failed[aspect].status='failed';
    failed[aspect].resolutionEvidence='https://example.com/full-round7-reinspection';
  }
  const last=structuredClone(f.document.reviewRounds[2]);
  Object.assign(last,{number:8,plannedAt:'2026-10-14T06:20:00Z',startedAt:'2026-10-14T06:21:00Z',completedAt:'2026-10-14T06:30:00Z'});
  f.document.reviewRounds.push(last);
  f.document.additionalIterationApprovals.push({approverKind:'human',approver:'owner',approvedAt:'2026-10-14T05:20:00Z',maxRound:8,evidence:'https://example.com/round8-approval'});
  return f;
}
test('resolved failed current review remains immutable while three later-qualified passes are required',()=>{
  const f=resolvedFailedCurrentFixture();const before=JSON.stringify(f.document.reviewRounds[1]);
  assert.deepEqual(check(f).errors,[]);assert.equal(JSON.stringify(f.document.reviewRounds[1]),before);
});
for(const [name,mutate] of [
 ['two passes only',f=>f.document.reviewRounds.pop()],
 ['last review failed',f=>{for(const a of ['functional','ux'])f.document.reviewRounds.at(-1)[a].status='failed';}],
 ['missing functional resolution',f=>delete f.document.reviewRounds[1].functional.resolutionEvidence],
 ['missing UX resolution',f=>delete f.document.reviewRounds[1].ux.resolutionEvidence],
 ['extra approval missing',f=>f.document.additionalIterationApprovals.pop()],
 ['extra approval late',f=>f.document.additionalIterationApprovals.at(-1).approvedAt='2026-10-14T06:22:00Z'],
 ['source mismatch',f=>f.document.reviewRounds[2].sourceSha='f'.repeat(40)],
 ['self review',f=>f.document.reviewRounds[2].reviewer=f.document.implementer],
 ['partial passed review',f=>f.document.reviewRounds[2].ux.featureIds.pop()],
 ['overlap',f=>f.document.reviewRounds[3].plannedAt='2026-10-14T06:05:00Z'],
])test(`resolved failed review still rejects ${name}`,()=>{const f=resolvedFailedCurrentFixture();mutate(f);assert.equal(check(f).ok,false,JSON.stringify(check(f)));});

test('three passes do not permit a failed final round even with resolution text',()=>{
  const f=resolvedFailedCurrentFixture();const last=structuredClone(f.document.reviewRounds.at(-1));
  Object.assign(last,{number:9,plannedAt:'2026-10-14T06:40:00Z',startedAt:'2026-10-14T06:41:00Z',completedAt:'2026-10-14T06:50:00Z'});
  for(const a of ['functional','ux']){last[a].status='failed';last[a].resolutionEvidence='https://example.com/claimed-future';}
  f.document.reviewRounds.push(last);f.document.additionalIterationApprovals.at(-1).maxRound=9;
  const errors=check(f).errors;assert.ok(errors.includes('UNRESOLVED_REVIEW 9-functional'));assert.ok(errors.includes('UNRESOLVED_REVIEW 9-ux'));
});
test('resolved blocked complete round is retained without pass credit',()=>{
  const f=resolvedFailedCurrentFixture();for(const a of ['functional','ux'])f.document.reviewRounds[1][a].status='blocked';
  assert.deepEqual(check(f).errors,[]);
});
