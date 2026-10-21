import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { ALL_FEATURES, DESIGN, context, evidence, plan, rounds, run } from './helpers/test-levels-fixture.mjs';
import { validEvidence as legacyEvidence, context as legacyContext } from './helpers/development-evidence-fixture.mjs';

// Synthetic contract inputs only; not product execution or fabricated product approval.
const interruption = () => ({
  reason: 'The process timed out; unexecuted combinations remain unreviewed.',
  originalReportSha256: 'd'.repeat(64),
  evidence: ['https://example.com/raw-failed-round'],
  actualScope: { completed: ['small-ko/title'], incomplete: ['small-ko/journey'], notRun: ['large-en/journey'] },
});
const fixture = () => {
  const current = rounds(ALL_FEATURES);
  const final = structuredClone(current[2]);
  Object.assign(final, { number: 4, plannedAt: '2026-10-14T04:00:00Z', startedAt: '2026-10-14T04:01:00Z', completedAt: '2026-10-14T04:10:00Z' });
  current[2].interruption = interruption();
  for (const aspect of ['functional', 'ux']) {
    current[2][aspect].status = 'failed';
    current[2][aspect].featureIds = ['create'];
    current[2][aspect].resolutionEvidence = 'https://example.com/actual-complete-round4-reinspection';
  }
  current.push(final);
  return {
    document: evidence({ reviewRounds: current,
      additionalIterationApproval: { approverKind: 'human', approver: 'owner', approvedAt: '2026-10-14T03:20:00Z', maxRound: 4, evidence: 'https://example.com/prior-extra-approval' },
      runs: [run('dev-all', 'godot-editor', ALL_FEATURES, { executor: 'independent-agent' })],
    }),
    ctx: context({ plans: { [DESIGN]: { approved: true, plan: plan({ level: 'L3', redesign: true, changedFeatures: ALL_FEATURES, foundationRerun: true }) } } }),
  };
};
const check = f => validateDevelopmentEvidence(f.document, f.ctx);

test('an explicit interrupted failed round preserves actual partial scope with zero complete-review credit', () => {
  const f = fixture(); const raw = structuredClone(f.document.reviewRounds[2]);
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
  assert.deepEqual(f.document.reviewRounds[2], raw);
  assert.equal(raw.functional.status, 'failed');
});
test('blocked interruptions preserve no-execution scope without inventing a completed unit', () => {
  const f = fixture(); const r = f.document.reviewRounds[2];
  r.functional.status = 'blocked'; r.ux.status = 'blocked';
  r.interruption.actualScope = { completed: [], incomplete: [], notRun: ['all/journeys'] };
  assert.equal(check(f).ok, true, JSON.stringify(check(f)));
});

for (const [name, mutate] of [
  ['interruption counted as third complete review', d => d.reviewRounds.pop()],
  ['multiple interruptions substituted for a complete review', d => { const r = d.reviewRounds[1];r.interruption=interruption();for(const a of ['functional','ux']){r[a].status='blocked';r[a].resolutionEvidence='https://example.com/later';} }],
  ['last round is interrupted despite future resolution text', d => { d.reviewRounds[3].interruption=interruption();for(const a of ['functional','ux']){d.reviewRounds[3][a].status='failed';d.reviewRounds[3][a].resolutionEvidence='https://example.com/future';} }],
  ['passed functional verdict disguised as interrupted', d => d.reviewRounds[2].functional.status = 'passed'],
  ['passed UX verdict disguised as interrupted', d => d.reviewRounds[2].ux.status = 'passed'],
  ['original digest missing', d => delete d.reviewRounds[2].interruption.originalReportSha256],
  ['original digest malformed', d => d.reviewRounds[2].interruption.originalReportSha256 = 'short'],
  ['original evidence missing', d => d.reviewRounds[2].interruption.evidence = []],
  ['actual scope absent', d => delete d.reviewRounds[2].interruption.actualScope],
  ['scope incorrectly declares completion only', d => d.reviewRounds[2].interruption.actualScope = { completed:['all'],incomplete:[],notRun:[] }],
  ['same unit appears completed and unrun', d => d.reviewRounds[2].interruption.actualScope.notRun = ['small-ko/title']],
  ['duplicate scope units', d => d.reviewRounds[2].interruption.actualScope.notRun = ['large-en/journey','large-en/journey']],
  ['partial functional scope without interruption marker', d => delete d.reviewRounds[2].interruption],
  ['complete round lacks a noncore feature', d => d.reviewRounds[0].functional.featureIds = ['create','store','purchase']],
  ['complete round lacks UX feature', d => d.reviewRounds[0].ux.featureIds = ['create','store','purchase']],
  ['interrupted declared feature is unknown', d => d.reviewRounds[2].functional.featureIds = ['unknown']],
  ['interrupted source differs', d => d.reviewRounds[2].sourceSha = 'c'.repeat(40)],
  ['complete source differs', d => d.reviewRounds[0].sourceSha = 'c'.repeat(40)],
  ['interrupted reviewer is implementer', d => d.reviewRounds[2].reviewer = d.implementer],
  ['complete reviewer is implementer', d => d.reviewRounds[0].reviewer = d.implementer],
  ['interruption lacks functional resolution', d => delete d.reviewRounds[2].functional.resolutionEvidence],
  ['interruption lacks UX resolution', d => delete d.reviewRounds[2].ux.resolutionEvidence],
  ['interruption overlaps prior completion', d => d.reviewRounds[2].plannedAt = '2026-10-14T02:05:00Z'],
  ['interruption plan follows its start', d => d.reviewRounds[2].plannedAt = '2026-10-14T03:05:00Z'],
  ['interruption number skipped', d => d.reviewRounds[2].number = 5],
  ['final round reuses interrupted number', d => d.reviewRounds[3].number = 3],
  ['approval cap ignores the interrupted round', d => d.additionalIterationApproval.maxRound = 3],
  ['approval follows the extra plan', d => d.additionalIterationApproval.approvedAt = '2026-10-14T04:02:00Z'],
  ['approval missing', d => d.additionalIterationApproval = null],
]) test(`interrupted records reject ${name}`, () => { const f=fixture();mutate(f.document);assert.equal(check(f).ok,false,JSON.stringify(check(f))); });

test('interruption requires an approved redesign plan', () => {
  const f=fixture();f.ctx.plans[DESIGN].plan.redesign=false;assert.equal(check(f).ok,false);
});
test('fresh runs cannot refresh expired current reviews with interruption', () => {
  const f=fixture();f.ctx.now='2026-10-22T06:00:00Z';f.document.runs.forEach(r=>{for(const k of ['plannedAt','startedAt','completedAt'])r[k]=r[k].replace('2026-10-14','2026-10-22');});
  assert.equal(check(f).ok,false);assert.ok(check(f).errors.some(e=>e.includes('EXPIRED')));
});
test('interruption does not waive platform release floors', () => {
  const f=fixture();f.ctx.phase='before-release';f.ctx.changes={'v1.0.0':['export_presets.cfg']};assert.ok(check(f).errors.some(e=>e.startsWith('TEST_LEVEL_BELOW_FLOOR')));
});
test('normal v2 reports without interruption retain their existing behavior', () => {
  const f=fixture();f.document.reviewRounds=rounds(ALL_FEATURES);f.document.additionalIterationApproval=null;
  assert.equal(check(f).ok,true,JSON.stringify(check(f)));
});
test('v1 cannot consume the interruption extension', () => {
  const ctx={...legacyContext,now:'2026-10-14T06:00:00Z'};
  assert.equal(validateDevelopmentEvidence(legacyEvidence(),ctx).ok,true);
  const d=legacyEvidence();d.iterations[0].interruption=interruption();
  assert.equal(validateDevelopmentEvidence(d,ctx).ok,false);
});

const historyFixture = () => {
  const f=fixture();
  f.document.reviewRounds.forEach(r=>r.number+=7);
  f.document.reviewHistoryRecovery={reason:'Original metadata gaps retained without credit.',
    attempts:[1,2,3].map(number=>({number,sourceSha:null,plannedAt:null,startedAt:null,completedAt:`2026-10-13T2${number}:00:00Z`,reviewer:'historical-reviewer',functionalStatus:'passed',uxStatus:'passed',evidence:['https://example.com/original'],originalReportSha256:String(number).repeat(64)})),
    completedRounds:[4,5,6,7].map((number,index)=>{
      const r=structuredClone(rounds(ALL_FEATURES)[0]);
      const stamp=minute=>`2026-10-14T00:${String(minute).padStart(2,'0')}:00Z`;
      Object.assign(r,{number,sourceSha:'c'.repeat(40),plannedAt:stamp(index*4),startedAt:stamp(index*4+1),completedAt:stamp(index*4+3),reviewer:'historical-reviewer'});
      return {round:r,implementer:'historical-author',originalReportSha256:'c'.repeat(64),evidence:['https://example.com/complete-original']};
    })};
  f.document.additionalIterationApproval=null;
  const approval=(maxRound,approvedAt)=>({approverKind:'human',approver:'owner',approvedAt,maxRound,evidence:`https://example.com/approval-${maxRound}`});
  f.document.additionalIterationApprovals=[approval(6,'2026-10-13T23:10:00Z'),approval(7,'2026-10-14T00:11:30Z'),approval(10,'2026-10-14T00:20:00Z'),approval(11,'2026-10-14T03:20:00Z')];
  return f;
};
test('complete current rounds8,9,11 retain actual interrupted10 and old1 through7 with zero credit',()=>{
  const f=historyFixture();const original=structuredClone(f.document.reviewHistoryRecovery);
  assert.equal(check(f).ok,true,JSON.stringify(check(f)));assert.deepEqual(f.document.reviewHistoryRecovery,original);
});
test('historical rounds and interrupted10 cannot substitute for a third complete current round',()=>{
  const f=historyFixture();f.document.reviewRounds.pop();assert.ok(check(f).errors.includes('THREE_UI_ROUNDS_REQUIRED'));
});
test('new maximum11 approval cannot be omitted while preserving old caps',()=>{
  const f=historyFixture();f.document.additionalIterationApprovals.pop();assert.ok(check(f).errors.includes('EXTRA_ROUND_APPROVAL_REQUIRED'));
});
test('a complete historical record cannot contain an interrupted review',()=>{
  const f=historyFixture();f.document.reviewHistoryRecovery.completedRounds[0].round.interruption=interruption();
  assert.ok(check(f).errors.includes('REVIEW_RECOVERY_INTERRUPTED_HISTORY'));
});
