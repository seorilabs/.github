import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';

import { SHA, NOW, context, validEvidence } from './helpers/development-evidence-fixture.mjs';

test('complete independent review and E2E evidence permits the matching phase', () => {
  assert.deepEqual(validateDevelopmentEvidence(validEvidence(), context), { ok: true, errors: [] });
});

const cases = [
  ['missing evidence', () => null],
  ['wrong SHA', d => { d.sourceSha = 'd'.repeat(40); }],
  ['wrong repository', d => { d.repository = 'seorilabs/other'; }],
  ['wrong market', d => { d.target = 'google-play'; }],
  ['approval by agent', d => { d.design.approverKind = 'agent'; }],
  ['same author reviews', d => { d.iterations[1].reviewer = d.implementer; }],
  ['only two rounds', d => { d.iterations.pop(); }],
  ['duplicate rounds', d => { d.iterations[2].number = 2; }],
  ['plan written after execution', d => { d.iterations[0].plannedAt = d.iterations[0].completedAt; }],
  ['missed UX core feature', d => { d.iterations[1].ux.featureIds = []; }],
  ['failed functional review', d => { d.iterations[0].functional.status = 'failed'; }],
  ['failed acceptance', d => { d.acceptance[0].status = 'blocked'; }],
  ['test-first without a red run', d => { d.tdd[0].redEvidence = ''; }],
  ['TDD exception without replacement', d => { d.tdd[0] = { acceptanceId: 'AC-1', mode: 'alternative', reason: 'platform SDK' }; }],
  ['fourth round without human approval', d => { d.iterations.push({ ...d.iterations[2], number: 4 }); }],
  ['wrong E2E phase', d => { d.e2e.phase = 'before-deploy'; }],
  ['wrong E2E SHA', d => { d.e2e.sourceSha = 'd'.repeat(40); }],
  ['previously implemented feature omitted', d => { d.e2e.scenarios[0].featureIds = ['create']; }],
  ['blocked E2E', d => { d.e2e.scenarios[0].status = 'blocked'; }],
  ['future completion', d => { d.e2e.completedAt = '2026-10-09T05:50:00Z'; }],
  ['expired E2E', d => { d.e2e.completedAt = '2026-10-08T04:50:00Z'; d.e2e.startedAt = '2026-10-08T04:45:00Z'; d.e2e.plannedAt = '2026-10-08T04:40:00Z'; }],
  ['headless test reported as Editor E2E', d => { d.e2e.environment.kind = 'headless-unit-test'; }],
  ['unknown properties', d => { d.skipVerification = true; }],
];
for (const [name, change] of cases) {
  test(`blocks ${name}`, () => {
    const d = validEvidence();
    const changed = change(d);
    const result = validateDevelopmentEvidence(changed === null ? null : d, context);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });
}

test('a fourth round needs approval before that round starts', () => {
  const d = validEvidence();
  d.iterations.push({ ...d.iterations[2], number: 4, plannedAt: '2026-10-08T04:00:00Z', startedAt: '2026-10-08T04:01:00Z', completedAt: '2026-10-08T04:10:00Z' });
  d.additionalIterationApproval = { approverKind: 'human', approver: 'owner', approvedAt: '2026-10-08T03:50:00Z', maxRound: 4, evidence: 'https://example.com/extra-approval' };
  assert.equal(validateDevelopmentEvidence(d, context).ok, true);
  d.additionalIterationApproval.approvedAt = '2026-10-08T04:05:00Z';
  assert.equal(validateDevelopmentEvidence(d, context).ok, false);
});

test('service E2E does not require fabricated UI rounds', () => {
  const d = validEvidence();
  d.productKind = 'service'; d.iterations = []; d.e2e.environment.kind = 'service-runtime';
  assert.equal(validateDevelopmentEvidence(d, { ...context, requireUi: false }).ok, true);
  assert.equal(validateDevelopmentEvidence(d, { ...context, requireUi: true }).ok, false);
});

test('a failed earlier review retains its finding and subsequent resolution evidence', () => {
  const d = validEvidence();
  d.iterations[0].functional.status = 'failed';
  d.iterations[0].functional.resolutionEvidence = 'https://example.com/issue-fixed-and-retested';
  assert.equal(validateDevelopmentEvidence(d, context).ok, true);
  d.iterations[2].functional.status = 'failed';
  d.iterations[2].functional.resolutionEvidence = 'https://example.com/future-fix';
  assert.equal(validateDevelopmentEvidence(d, context).ok, false);
});

test('report cannot omit an existing feature by shortening its own claimed inventory', () => {
  const d = validEvidence(); d.features.pop(); d.e2e.scenarios[0].featureIds = ['create'];
  assert.equal(validateDevelopmentEvidence(d, context).ok, false);
});

test('source inventory is required even if the report claims all features passed', () => {
  assert.equal(validateDevelopmentEvidence(validEvidence(), { ...context, featureInventory: undefined }).ok, false);
});
