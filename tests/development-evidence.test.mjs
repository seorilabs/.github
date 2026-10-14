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

test('a separate UI5 approval keeps the original UI4 approval and checks each round time', () => {
  const d = validEvidence();
  d.iterations.push({ ...structuredClone(d.iterations[2]), number: 4, plannedAt: '2026-10-08T04:00:00Z', startedAt: '2026-10-08T04:01:00Z', completedAt: '2026-10-08T04:10:00Z' });
  d.iterations.push({ ...structuredClone(d.iterations[2]), number: 5, plannedAt: '2026-10-08T05:00:00Z', startedAt: '2026-10-08T05:01:00Z', completedAt: '2026-10-08T05:10:00Z' });
  d.additionalIterationApproval = { approverKind: 'human', approver: 'owner', approvedAt: '2026-10-08T03:50:00Z', maxRound: 4, evidence: 'https://example.com/ui4' };
  d.additionalIterationApprovals = [{ approverKind: 'human', approver: 'owner', approvedAt: '2026-10-08T04:20:00Z', maxRound: 5, evidence: 'https://example.com/ui5' }];
  assert.equal(validateDevelopmentEvidence(d, context).ok, true);
  d.additionalIterationApprovals[0].approvedAt = '2026-10-08T05:02:00Z';
  assert.equal(validateDevelopmentEvidence(d, context).ok, false);
  d.additionalIterationApprovals[0].approvedAt = '2026-10-08T04:20:00Z';
  d.additionalIterationApproval = null;
  assert.equal(validateDevelopmentEvidence(d, context).ok, false);
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

// 같은 후보(SHA·마켓·설정 지문·기능 목록)의 통과한 E2E는 빌드 직전·배포 직전·승격에 다시 쓴다(7일 안).
test('before-deploy reuses the passing before-build run of the same candidate', () => {
  assert.deepEqual(validateDevelopmentEvidence(validEvidence(), { ...context, phase: 'before-deploy' }), { ok: true, errors: [] });
});
test('a deploy-phase run cannot stand in for the build gate', () => {
  const d = validEvidence(); d.e2e.phase = 'before-deploy';
  assert.equal(validateDevelopmentEvidence(d, context).ok, false);
});
test('the same candidate E2E stays valid for seven days', () => {
  assert.equal(validateDevelopmentEvidence(validEvidence(), { ...context, phase: 'before-deploy', now: '2026-10-15T05:49:00Z' }).ok, true);
});
test('E2E older than seven days must run again', () => {
  const result = validateDevelopmentEvidence(validEvidence(), { ...context, phase: 'before-deploy', now: '2026-10-15T05:51:00Z' });
  assert.equal(result.ok, false); assert.ok(result.errors.includes('E2E_EXPIRED'));
});
test('a reused run still requires the same configuration fingerprint', () => {
  assert.equal(validateDevelopmentEvidence(validEvidence(), { ...context, phase: 'before-deploy', configurationFingerprint: 'd'.repeat(64) }).ok, false);
});

// 영향 없는 기반 기능은 실제로 통과한 기준 SHA의 근거를 이어받는다(30일, 경로 자동 판정).
const BASE = 'e'.repeat(40);
function carryForwardCase() {
  const featureInventory = { schemaVersion: 1, features: [
    { id: 'create', core: true }, { id: 'settings', core: false },
    { id: 'purchase', core: true, foundation: true, paths: ['src/purchase/**', 'android/app/build.gradle'] },
  ] };
  const d = validEvidence();
  d.features.push({ id: 'purchase', core: true });
  d.carriedForward = [{ featureId: 'purchase', baselineSha: BASE, verifiedAt: '2026-10-01T00:00:00Z', evidence: ['https://example.com/device-purchase'] }];
  const ctx = { ...context, featureInventory, baselines: { [BASE]: { changedFiles: ['src/create/form.ts', 'docs/qa/feature-inventory.json'], inventory: structuredClone(featureInventory) } } };
  return { d, ctx };
}
const carryErrors = (d, ctx) => validateDevelopmentEvidence(d, ctx).errors;

test('an unaffected foundation feature is carried forward instead of rerun in rounds and E2E', () => {
  const { d, ctx } = carryForwardCase();
  assert.deepEqual(validateDevelopmentEvidence(d, ctx), { ok: true, errors: [] });
});
test('a foundation feature without a carried-forward record still needs every round and E2E', () => {
  const { d, ctx } = carryForwardCase(); delete d.carriedForward;
  const errors = carryErrors(d, ctx);
  assert.ok(errors.includes('FEATURE_COVERAGE functional-1')); assert.ok(errors.includes('FEATURE_COVERAGE e2e-all-implemented-features'));
});
for (const file of ['src/purchase/billing.ts', 'src/purchase/.env', 'android/app/build.gradle']) {
  test(`a change to ${file} makes the foundation feature run again`, () => {
    const { d, ctx } = carryForwardCase(); ctx.baselines[BASE].changedFiles.push(file);
    assert.ok(carryErrors(d, ctx).includes('CARRY_FORWARD_AFFECTED purchase'));
  });
}
test('a product feature cannot be carried forward', () => {
  const { d, ctx } = carryForwardCase(); d.carriedForward[0].featureId = 'settings';
  assert.ok(carryErrors(d, ctx).includes('CARRY_FORWARD_NOT_FOUNDATION settings'));
});
test('a foundation feature must declare the paths that decide its impact', () => {
  const { d, ctx } = carryForwardCase(); delete ctx.featureInventory.features[2].paths;
  assert.ok(carryErrors(d, ctx).includes('SOURCE_FEATURE_INVENTORY_REQUIRED'));
});
test('carried-forward evidence stays valid for thirty days from the actual run', () => {
  const { d, ctx } = carryForwardCase();
  assert.equal(validateDevelopmentEvidence(d, { ...ctx, now: '2026-10-30T23:59:00Z', phase: 'before-deploy' }).errors.includes('CARRY_FORWARD_EXPIRED purchase'), false);
  d.carriedForward[0].verifiedAt = '2026-09-07T05:59:00Z';
  assert.ok(carryErrors(d, ctx).includes('CARRY_FORWARD_EXPIRED purchase'));
  d.carriedForward[0].verifiedAt = '2026-10-09T00:00:00Z';
  assert.ok(carryErrors(d, ctx).includes('CARRY_FORWARD_EXPIRED purchase'));
});
for (const [name, change] of [['missing comparison', ctx => { delete ctx.baselines[BASE]; }], ['unknown comparison', ctx => { ctx.baselines[BASE].changedFiles = null; }]]) {
  test(`${name} makes the foundation feature run again`, () => {
    const { d, ctx } = carryForwardCase(); change(ctx);
    assert.ok(carryErrors(d, ctx).includes('CARRY_FORWARD_DIFF_UNAVAILABLE purchase'));
  });
}
for (const [name, change] of [['narrowed paths', f => { f.paths = ['src/purchase/**', 'src/legacy/**']; }], ['no foundation flag', f => { delete f.foundation; }], ['malformed paths', f => { delete f.paths; }]]) {
  test(`baseline inventory with ${name} makes the feature run again`, () => {
    const { d, ctx } = carryForwardCase(); change(ctx.baselines[BASE].inventory.features[2]);
    assert.ok(carryErrors(d, ctx).includes('CARRY_FORWARD_INVENTORY_CHANGED purchase'));
  });
}
test('reordered paths are the same feature definition', () => {
  const { d, ctx } = carryForwardCase(); ctx.baselines[BASE].inventory.features[2].paths.reverse();
  assert.equal(validateDevelopmentEvidence(d, ctx).ok, true);
});
test('a report may copy the source inventory with foundation fields as its feature list', () => {
  const { d, ctx } = carryForwardCase(); d.features = structuredClone(ctx.featureInventory.features);
  assert.deepEqual(validateDevelopmentEvidence(d, ctx), { ok: true, errors: [] });
});
test('the same feature cannot be carried forward twice', () => {
  const { d, ctx } = carryForwardCase(); d.carriedForward.push({ ...d.carriedForward[0] });
  assert.ok(carryErrors(d, ctx).includes('DUPLICATE carried-forward'));
});
