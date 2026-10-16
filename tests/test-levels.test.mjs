import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { mergeTestPlans } from '../scripts/release/test-plan.mjs';
import { ALL_FEATURES, DESIGN, SHA, context, evidence, plan, rounds, run } from './helpers/test-levels-fixture.mjs';
import { validEvidence as validV1Evidence, context as v1Context } from './helpers/development-evidence-fixture.mjs';

const check = (document, ctx) => validateDevelopmentEvidence(document, ctx);
const errorsOf = (document, ctx) => check(document, ctx).errors;
const withPlan = (changes, ctxChanges = {}) => context({ plans: { [DESIGN]: { approved: true, plan: plan(changes) } }, ...ctxChanges });
const PHASES = ['before-build', 'before-deploy', 'before-release'];

// AC-1: L1 계획 + 바뀐 기능의 개발 환경 실행 + 작성자 실행이면 통과한다.
for (const phase of PHASES) {
  test(`AC-1 L1 plan passes ${phase} with the author's dev run of the changed feature`, () => {
    assert.deepEqual(check(evidence(), context({ phase })), { ok: true, errors: [], level: 'L1', completedAt: '2026-10-14T05:10:00Z' });
  });
}
test('AC-1 L1 plan without a dev run of the changed feature fails', () => {
  assert.ok(errorsOf(evidence({ runs: [run('dev-1', 'godot-editor', ['create'])] }), context()).includes('RUN_COVERAGE dev settings'));
});
test('AC-1 a feature whose paths changed joins the planned environments without a new approval', () => {
  const ctx = context({ changes: { 'v1.0.0': ['src/settings/screen.ts', 'src/create/form.ts'] } });
  assert.ok(errorsOf(evidence(), ctx).includes('RUN_COVERAGE dev create'));
  assert.equal(check(evidence({ runs: [run('dev-1', 'godot-editor', ['settings', 'create'])] }), ctx).ok, true);
});
test('AC-1 L1 needs no run of features outside the change', () => {
  assert.equal(check(evidence(), context()).errors.some(error => /store|purchase|ads/u.test(error)), false);
});

// AC-2·AC-3: 기반 기능 경로가 바뀌면 대상 마켓 플랫폼 실기기가 하한이다. 승인된 계획의 사유로만 낮춘다.
const foundationChange = (changes = {}, phase = 'before-release') => withPlan(changes, { phase, changes: { 'v1.0.0': ['src/settings/screen.ts', 'src/purchase/billing.ts'] } });
const devBoth = () => run('dev-1', 'godot-editor', ['settings', 'purchase']);
test('AC-2 a foundation path change without a device run or approved override is below the floor', () => {
  const errors = errorsOf(evidence({ runs: [devBoth()] }), foundationChange());
  assert.ok(errors.includes('TEST_LEVEL_BELOW_FLOOR foundation purchase android'), errors.join('\n'));
});
test('AC-2 the build gate does not wait for a device run but still runs the touched feature in dev', () => {
  assert.equal(check(evidence({ runs: [devBoth()] }), foundationChange({}, 'before-build')).ok, true);
  assert.ok(errorsOf(evidence(), foundationChange({}, 'before-build')).includes('RUN_COVERAGE dev purchase'));
});
test('AC-2 raising the floor with an independent device run passes without a new approval', () => {
  const document = evidence({ runs: [devBoth(), run('android-1', 'android-device', ['purchase'], { executor: 'device-agent' })] });
  assert.deepEqual(check(document, foundationChange()).errors, []);
  assert.equal(check(document, foundationChange()).level, 'L2');
});
test('AC-2 the floor follows the verified market platform', () => {
  const ctx = foundationChange({ release: { markets: ['google-play', 'app-store'], until: 'public' } });
  ctx.target = 'app-store';
  const document = evidence({ target: 'app-store', runs: [devBoth(), run('android-1', 'android-device', ['purchase'], { executor: 'device-agent' })] });
  assert.ok(errorsOf(document, ctx).includes('TEST_LEVEL_BELOW_FLOOR foundation purchase ios'));
  document.runs.push(run('ios-1', 'ios-device', ['purchase'], { executor: 'device-agent' }));
  assert.equal(check(document, ctx).ok, true);
});
test('AC-2 Apps in Toss accepts either device platform for the foundation floor', () => {
  const ctx = foundationChange({ release: { markets: ['apps-in-toss'], until: 'public' } });
  ctx.target = 'apps-in-toss';
  for (const kind of ['android-device', 'ios-device']) {
    const document = evidence({ target: 'apps-in-toss', runs: [devBoth(), run('device-1', kind, ['purchase'], { executor: 'device-agent', target: 'apps-in-toss' })] });
    assert.equal(check(document, ctx).ok, true, kind);
  }
  assert.ok(errorsOf(evidence({ target: 'apps-in-toss', runs: [devBoth()] }), ctx).includes('TEST_LEVEL_BELOW_FLOOR foundation purchase android|ios'));
});
test('AC-3 an override in the approved plan lowers the foundation floor', () => {
  const ctx = foundationChange({ floorOverrides: [{ rule: 'foundation', featureId: 'purchase', reason: '표시 분기만 바뀜' }] });
  assert.deepEqual(check(evidence({ runs: [devBoth()] }), ctx).errors, []);
});
test('AC-3 a plan outside the approved commit is not trusted', () => {
  for (const entry of [{ approved: false, plan: plan() }, { approved: true, plan: null }, undefined]) {
    const ctx = context({ plans: entry ? { [DESIGN]: entry } : {} });
    assert.ok(errorsOf(evidence(), ctx).includes(`TEST_PLAN_UNAPPROVED ${DESIGN}`));
  }
});
test('AC-3 the evidence cannot carry its own overrides or plan', () => {
  const document = evidence(); document.floorOverrides = [{ rule: 'regression', reason: 'later' }];
  assert.ok(errorsOf(document, context()).some(error => error.startsWith('EVIDENCE_SCHEMA')));
});

// AC-4: 회귀 경로·비교 불가·첫 출시는 전체 회귀다.
const fullDev = (executor = 'review-agent') => run('dev-full', 'godot-editor', ALL_FEATURES, { executor });
for (const [name, ctxChanges] of [
  ['an export setting change', { changes: { 'v1.0.0': ['godot/export_presets.cfg'] } }],
  ['a lock file change', { changes: { 'v1.0.0': ['package-lock.json'] } }],
  ['an unknown comparison', { changes: { 'v1.0.0': null } }],
  ['a missing comparison', { changes: {} }],
]) {
  test(`AC-4 ${name} requires a full regression in the planned environments`, () => {
    const ctx = context(ctxChanges);
    const errors = errorsOf(evidence(), ctx);
    assert.ok(errors.includes('TEST_LEVEL_BELOW_FLOOR regression create dev'), errors.join('\n'));
    assert.ok(errors.includes('INDEPENDENT_RUN_REQUIRED dev-1'));
    assert.deepEqual(check(evidence({ runs: [fullDev()] }), ctx).errors, []);
  });
}
test('AC-4 an approved regression override keeps the changed-feature scope', () => {
  const ctx = withPlan({ floorOverrides: [{ rule: 'regression', reason: '설정 주석만 바뀜' }] }, { changes: { 'v1.0.0': ['godot/export_presets.cfg', 'src/settings/a.ts'] } });
  assert.deepEqual(check(evidence(), ctx).errors, []);
});
test('AC-4 the inventory regressionPaths replace the central defaults', () => {
  const ctx = context({ changes: { 'v1.0.0': ['godot/export_presets.cfg'] } });
  ctx.featureInventory.regressionPaths = ['native/**'];
  assert.deepEqual(check(evidence(), ctx).errors, []);
  ctx.changes['v1.0.0'].push('native/plugin.mm');
  assert.ok(errorsOf(evidence(), ctx).includes('TEST_LEVEL_BELOW_FLOOR regression create dev'));
});
test('AC-4 a first release must be L3 and cannot lower the regression floor', () => {
  assert.ok(errorsOf(evidence(), withPlan({ baseline: null })).some(error => error.startsWith(`TEST_PLAN_INVALID ${DESIGN}`)));
  const first = withPlan({ baseline: null, level: 'L3', floorOverrides: [{ rule: 'regression', reason: 'x' }] });
  assert.ok(errorsOf(evidence({ runs: [fullDev()] }), first).some(error => error.startsWith(`TEST_PLAN_INVALID ${DESIGN}`)));
  assert.deepEqual(check(evidence({ runs: [fullDev()] }), withPlan({ baseline: null, level: 'L3' })).errors, []);
});
test('AC-4 L3 carries forward an unaffected foundation feature and foundationRerun forbids it', () => {
  const BASE = 'e'.repeat(40);
  const ctx = withPlan({ level: 'L3' }, { baselines: { [BASE]: { changedFiles: ['src/settings/a.ts'], inventory: context().featureInventory } } });
  const document = evidence({ runs: [run('dev-full', 'godot-editor', ['create', 'settings', 'store', 'ads'], { executor: 'review-agent' })],
    carriedForward: [{ featureId: 'purchase', baselineSha: BASE, verifiedAt: '2026-10-01T00:00:00Z', evidence: ['https://example.com/device'] }] });
  assert.deepEqual(check(document, ctx).errors, []);
  ctx.plans[DESIGN].plan.foundationRerun = true;
  const errors = errorsOf(document, ctx);
  assert.ok(errors.includes('CARRY_FORWARD_FORBIDDEN purchase')); assert.ok(errors.includes('RUN_COVERAGE dev purchase'));
});
test('AC-4 a changed feature cannot be carried forward', () => {
  const BASE = 'e'.repeat(40);
  const ctx = withPlan({ changedFeatures: ['purchase'], floorOverrides: [{ rule: 'foundation', featureId: 'purchase', reason: 'x' }] },
    { baselines: { [BASE]: { changedFiles: [], inventory: context().featureInventory } } });
  const document = evidence({ runs: [run('dev-1', 'godot-editor', ['settings'])],
    carriedForward: [{ featureId: 'purchase', baselineSha: BASE, verifiedAt: '2026-10-01T00:00:00Z', evidence: ['https://example.com/device'] }] });
  assert.ok(errorsOf(document, ctx).includes('CARRY_FORWARD_AFFECTED purchase'));
});

// AC-5: L2 이상은 다른 에이전트가 실행한다.
test('AC-5 an L2 device run by the implementer is not independent', () => {
  const ctx = withPlan({ level: 'L2', environments: ['android'] }, { phase: 'before-release' });
  assert.ok(errorsOf(evidence({ runs: [run('android-1', 'android-device', ['settings'])] }), ctx).includes('INDEPENDENT_RUN_REQUIRED android-1'));
  assert.deepEqual(check(evidence({ runs: [run('android-1', 'android-device', ['settings'], { executor: 'device-agent' })] }), ctx).errors, []);
});
test('AC-5 an L2 plan still lets the author record an optional dev run', () => {
  const ctx = withPlan({ level: 'L2', environments: ['dev', 'android'] }, { phase: 'before-release' });
  const document = evidence({ runs: [run('dev-1', 'godot-editor', ['settings']), run('android-1', 'android-device', ['settings'], { executor: ' Device-Agent ' })] });
  assert.deepEqual(check(document, ctx).errors, []);
});
test('AC-5 every L3 run needs a different executor, ignoring case and spaces', () => {
  const ctx = withPlan({ level: 'L3' });
  assert.ok(errorsOf(evidence({ runs: [fullDev(' AUTHOR-agent ')] }), ctx).includes('INDEPENDENT_RUN_REQUIRED dev-full'));
  assert.deepEqual(check(evidence({ runs: [fullDev()] }), ctx).errors, []);
});

// AC-6: 새 화면·UI 개편은 L3와 3회 검수다.
test('AC-6 redesign below L3 is an invalid plan', () => {
  assert.ok(errorsOf(evidence(), withPlan({ redesign: true, level: 'L2', environments: ['android'] })).some(error => error.startsWith(`TEST_PLAN_INVALID ${DESIGN}`)));
});
test('AC-6 redesign requires three independent rounds', () => {
  const ctx = withPlan({ redesign: true, level: 'L3' });
  assert.ok(errorsOf(evidence({ runs: [fullDev()] }), ctx).includes('THREE_UI_ROUNDS_REQUIRED'));
  const document = evidence({ runs: [fullDev()], reviewRounds: rounds() });
  assert.deepEqual(check(document, ctx).errors, []);
  document.reviewRounds[1].reviewer = 'author-agent';
  assert.ok(errorsOf(document, ctx).includes('INDEPENDENT_REVIEW_REQUIRED'));
});
test('AC-6 a fourth redesign round needs prior human approval', () => {
  const ctx = withPlan({ redesign: true, level: 'L3' });
  const document = evidence({ runs: [fullDev()], reviewRounds: rounds() });
  document.reviewRounds.push({ ...document.reviewRounds[2], number: 4, plannedAt: '2026-10-14T04:00:00Z', startedAt: '2026-10-14T04:01:00Z', completedAt: '2026-10-14T04:10:00Z' });
  assert.ok(errorsOf(document, ctx).includes('EXTRA_ROUND_APPROVAL_REQUIRED'));
  document.additionalIterationApproval = { approverKind: 'human', approver: 'owner', approvedAt: '2026-10-14T03:50:00Z', maxRound: 4, evidence: 'https://example.com/extra' };
  assert.deepEqual(check(document, ctx).errors, []);
});
test('AC-6 a redesign round may miss a carried-forward foundation feature', () => {
  const BASE = 'e'.repeat(40);
  const ctx = withPlan({ redesign: true, level: 'L3' }, { baselines: { [BASE]: { changedFiles: [], inventory: context().featureInventory } } });
  const document = evidence({ runs: [run('dev-full', 'godot-editor', ['create', 'settings', 'store', 'ads'], { executor: 'review-agent' })], reviewRounds: rounds(['create', 'store']),
    carriedForward: [{ featureId: 'purchase', baselineSha: BASE, verifiedAt: '2026-10-01T00:00:00Z', evidence: ['https://example.com/device'] }] });
  assert.deepEqual(check(document, ctx).errors, []);
});

// AC-7: 빌드 전은 실기기 없이, 제출·승격 직전은 실기기 실행이 있어야 한다.
test('AC-7 an L2 device plan passes the build gate before the device run exists', () => {
  const ctx = withPlan({ level: 'L2', environments: ['android'] });
  for (const phase of ['before-build', 'before-deploy']) assert.deepEqual(check(evidence({ runs: [] }), { ...ctx, phase }).errors, []);
  const errors = errorsOf(evidence({ runs: [] }), { ...ctx, phase: 'before-release' });
  assert.ok(errors.includes('RUN_COVERAGE android settings'));
});
test('AC-7 web and service deploys need every planned run before the deploy', () => {
  const ctx = withPlan({ level: 'L2', environments: ['dev', 'android'], release: { markets: ['web'], until: 'public' } }, { target: 'web', phase: 'before-deploy' });
  const document = evidence({ target: 'web' });
  assert.ok(errorsOf(document, ctx).includes('RUN_COVERAGE android settings'));
  assert.deepEqual(check(document, { ...ctx, phase: 'before-build' }).errors, []);
});

// AC-8: 계획에 없는 마켓이나 test-track 끝 지점은 출시 단계로 넘어가지 않는다.
test('AC-8 a market outside the approved plan is not released', () => {
  const ctx = withPlan({ release: { markets: ['google-play'], until: 'public' } }, { target: 'app-store', phase: 'before-release' });
  assert.ok(errorsOf(evidence({ target: 'app-store' }), ctx).includes('RELEASE_NOT_AUTHORIZED market app-store'));
});
test('AC-8 a test-track end point stops before submission but allows the test upload', () => {
  const ctx = withPlan({ release: { markets: ['google-play'], until: 'test-track' } });
  assert.deepEqual(check(evidence(), { ...ctx, phase: 'before-deploy' }).errors, []);
  assert.ok(errorsOf(evidence(), { ...ctx, phase: 'before-release' }).includes('RELEASE_NOT_AUTHORIZED until test-track'));
});
test('AC-8 the release end point defaults to public', () => {
  const ctx = withPlan({ release: { markets: ['google-play'] } }, { phase: 'before-release' });
  assert.deepEqual(check(evidence(), ctx).errors, []);
});
test('AC-8 a web deploy is the release itself', () => {
  const ctx = withPlan({ release: { markets: ['google-play'], until: 'public' } }, { target: 'web', phase: 'before-deploy' });
  assert.ok(errorsOf(evidence({ target: 'web' }), ctx).includes('RELEASE_NOT_AUTHORIZED market web'));
});

// AC-9: 여러 설계는 가장 높은 등급, 합집합, 가장 이른 끝 지점으로 합친다.
test('AC-9 several approved plans merge to the strictest scope', () => {
  const merged = mergeTestPlans([
    plan({ level: 'L1', changedFeatures: ['settings'], release: { markets: ['google-play'], until: 'public' } }),
    plan({ level: 'L2', changedFeatures: ['create'], environments: ['dev', 'android'], baseline: 'v1.0.1',
      floorOverrides: [{ rule: 'foundation', featureId: 'ads', reason: 'x' }], release: { markets: ['app-store'], until: 'review-submitted' } }),
  ]);
  assert.equal(merged.level, 'L2');
  assert.deepEqual(merged.changedFeatures, ['create', 'settings']);
  assert.deepEqual(merged.environments, ['android', 'dev']);
  assert.deepEqual(merged.markets, ['app-store', 'google-play']);
  assert.equal(merged.until, 'review-submitted');
  assert.deepEqual(merged.baselines, ['v1.0.0', 'v1.0.1']);
  // 한 설계의 낮춤 사유가 다른 설계의 변경을 덮지 않는다.
  assert.deepEqual(merged.foundationOverrides, []);
  assert.equal(merged.regressionOverride, false);
  const both = mergeTestPlans([0, 1].map(() => plan({ floorOverrides: [{ rule: 'foundation', featureId: 'ads', reason: 'x' }, { rule: 'regression', reason: 'y' }] })));
  assert.deepEqual(both.foundationOverrides, ['ads']); assert.equal(both.regressionOverride, true);
  assert.equal(mergeTestPlans([plan({ release: { markets: ['web'] } })]).until, 'public');
});
test('AC-9 the merged plan drives the verification of every design', () => {
  const second = { ...evidence().designs[0], id: 'D-2', document: 'docs/design/2026-10-14-second/design.md', testPlan: 'docs/design/2026-10-14-second/test-plan.json' };
  const ctx = context({ phase: 'before-release', changes: { 'v1.0.0': ['src/settings/a.ts'], 'v1.0.1': [] }, plans: {
    [DESIGN]: { approved: true, plan: plan() },
    'D-2': { approved: true, plan: plan({ level: 'L2', changedFeatures: ['create'], environments: ['android'], baseline: 'v1.0.1', release: { markets: ['google-play'], until: 'review-submitted' } }) },
  } });
  const document = evidence({ designs: [evidence().designs[0], second] });
  const errors = errorsOf(document, ctx);
  assert.ok(errors.includes('RUN_COVERAGE android settings')); assert.ok(errors.includes('RUN_COVERAGE android create')); assert.ok(errors.includes('RUN_COVERAGE dev create'));
  document.runs = [run('dev-1', 'godot-editor', ['settings', 'create']), run('android-1', 'android-device', ['settings', 'create'], { executor: 'device-agent' })];
  assert.deepEqual(check(document, ctx).errors, []);
});

// AC-10: v1 근거는 과도기 동안 기존 규칙으로 검증하고 그 뒤 거절한다.
test('AC-10 v1 evidence keeps the previous rules during the transition', () => {
  assert.deepEqual(validateDevelopmentEvidence(validV1Evidence(), v1Context), { ok: true, errors: [] });
  assert.equal(validateDevelopmentEvidence(validV1Evidence(), { ...v1Context, phase: 'before-release' }).ok, true);
});
test('AC-10 v1 evidence is rejected after the transition', () => {
  const errors = validateDevelopmentEvidence(validV1Evidence(), { ...v1Context, now: '2026-10-22T00:00:00Z' }).errors;
  assert.ok(errors.includes('EVIDENCE_V1_RETIRED'));
});

// 계획 형식과 실행 기록의 나머지 규칙
for (const [name, changes] of [
  ['L1 with a device environment', { environments: ['dev', 'android'] }],
  ['L2 without a device environment', { level: 'L2', environments: ['dev'] }],
  ['foundationRerun below L3', { level: 'L2', environments: ['android'], foundationRerun: true }],
  ['an unknown changed feature', { changedFeatures: ['missing'] }],
  ['an override of a product feature', { floorOverrides: [{ rule: 'foundation', featureId: 'settings', reason: 'x' }] }],
  ['a duplicated override', { floorOverrides: [{ rule: 'regression', reason: 'x' }, { rule: 'regression', reason: 'y' }] }],
  ['an unknown field', { skipFloor: true }],
]) {
  test(`plan with ${name} is invalid`, () => {
    assert.ok(errorsOf(evidence(), withPlan(changes)).some(error => error.startsWith(`TEST_PLAN_INVALID ${DESIGN}`)), name);
  });
}
for (const [name, change, expected] of [
  ['a run of another candidate', d => { d.runs[0].sourceSha = 'd'.repeat(40); }, 'RUN_CANDIDATE_MISMATCH dev-1'],
  ['an expired run', d => { d.runs[0].completedAt = '2026-10-07T05:59:00Z'; d.runs[0].startedAt = '2026-10-07T05:00:00Z'; d.runs[0].plannedAt = '2026-10-07T04:00:00Z'; }, 'RUN_EXPIRED dev-1'],
  ['a run planned after it started', d => { d.runs[0].plannedAt = '2026-10-14T05:05:00Z'; }, 'EXECUTION_ORDER run-dev-1'],
  ['a future run', d => { d.runs[0].completedAt = '2026-10-14T07:00:00Z'; }, 'EXECUTION_ORDER run-dev-1'],
  ['a duplicated run id', d => { d.runs.push(structuredClone(d.runs[0])); }, 'DUPLICATE run'],
  ['an unknown feature in a run', d => { d.runs[0].scenarios[0].featureIds.push('missing'); }, 'RUN_UNKNOWN_FEATURE dev-1 missing'],
  ['a service runtime for a UI product', d => { d.runs[0].kind = 'service-runtime'; }, 'UI_RUNTIME_REQUIRED dev-1'],
  ['another repository', d => { d.repository = 'seorilabs/other'; }, 'CANDIDATE_MISMATCH repository'],
  ['another candidate', d => { d.sourceSha = 'd'.repeat(40); }, 'CANDIDATE_MISMATCH sourceSha'],
  ['a missing TDD record', d => { d.tdd = [{ ...d.tdd[0], acceptanceId: 'AC-2' }]; }, 'TDD_ACCEPTANCE_COVERAGE'],
  ['a duplicated design', d => { d.designs.push(structuredClone(d.designs[0])); }, 'DUPLICATE design'],
]) {
  test(`blocks ${name}`, () => {
    const d = evidence(); change(d);
    assert.ok(errorsOf(d, context()).includes(expected), errorsOf(d, context()).join('\n'));
  });
}
test('a blocked scenario is never a pass', () => {
  const d = evidence(); d.runs[0].scenarios[0].status = 'blocked';
  assert.ok(errorsOf(d, context()).some(error => error.startsWith('EVIDENCE_SCHEMA')));
});
test('a device run must name its market build and a dev run must not', () => {
  const device = evidence({ runs: [run('android-1', 'android-device', ['settings'])] }); delete device.runs[0].build;
  assert.ok(errorsOf(device, context()).some(error => error.startsWith('EVIDENCE_SCHEMA')));
  const dev = evidence(); dev.runs[0].target = 'google-play';
  assert.ok(errorsOf(dev, context()).some(error => error.startsWith('EVIDENCE_SCHEMA')));
});
test('a device run of the verified market must match the configuration fingerprint when one is given', () => {
  const ctx = withPlan({ level: 'L2', environments: ['android'] }, { phase: 'before-release', configurationFingerprint: 'c'.repeat(64) });
  const document = evidence({ runs: [run('android-1', 'android-device', ['settings'], { executor: 'device-agent', configurationFingerprint: 'c'.repeat(64) })] });
  assert.deepEqual(check(document, ctx).errors, []);
  document.runs[0].configurationFingerprint = 'd'.repeat(64);
  assert.ok(errorsOf(document, ctx).includes('CONFIGURATION_CHANGED android-1'));
  delete document.runs[0].configurationFingerprint;
  assert.ok(errorsOf(document, ctx).includes('CONFIGURATION_CHANGED android-1'));
  document.runs[0].target = 'apps-in-toss';
  assert.deepEqual(check(document, ctx).errors, []);
});
test('dev runs are not compared with the market fingerprint', () => {
  assert.deepEqual(check(evidence(), context({ configurationFingerprint: 'd'.repeat(64) })).errors, []);
});
test('a service product needs service runtime runs and no UI rounds', () => {
  const ctx = context({ target: 'service', requireUi: false, plans: { [DESIGN]: { approved: true, plan: plan({ release: { markets: ['service'] } }) } } });
  const document = evidence({ target: 'service', productKind: 'service', runs: [run('svc-1', 'service-runtime', ['settings'])] });
  assert.deepEqual(check(document, ctx).errors, []);
  document.runs[0].kind = 'web-browser';
  assert.ok(errorsOf(document, ctx).includes('SERVICE_RUNTIME_REQUIRED svc-1'));
  assert.ok(errorsOf(evidence({ target: 'service', productKind: 'service' }), { ...ctx, requireUi: true }).includes('UI_REQUIRED'));
});
test('the source inventory is required', () => {
  assert.ok(errorsOf(evidence(), context({ featureInventory: undefined })).includes('SOURCE_FEATURE_INVENTORY_REQUIRED'));
  const ctx = context(); ctx.featureInventory.regressionPaths = 'src/**';
  assert.ok(errorsOf(evidence(), ctx).includes('SOURCE_FEATURE_INVENTORY_REQUIRED'));
});
test('the result reports the latest run completion for the build bound', () => {
  const document = evidence({ runs: [run('dev-1', 'godot-editor', ['settings']), run('dev-2', 'godot-editor', ['settings'], { completedAt: '2026-10-14T05:20:00Z' })] });
  assert.equal(check(document, context()).completedAt, '2026-10-14T05:20:00Z');
  assert.equal(check(evidence({ runs: [] }), withPlan({ level: 'L2', environments: ['android'] })).completedAt, null);
  assert.equal(SHA.length, 40);
});

// 리뷰 반영: 승인된 단계적 출시 비율과 설계·계획 폴더 결속
test('a production promotion cannot exceed the approved staged rollout', () => {
  const ctx = withPlan({ release: { markets: ['google-play'], until: 'public', rollout: 0.1 } }, { phase: 'before-release' });
  assert.deepEqual(check(evidence(), { ...ctx, rollout: 0.1 }).errors, []);
  assert.deepEqual(check(evidence(), { ...ctx, rollout: 0.05 }).errors, []);
  assert.ok(errorsOf(evidence(), { ...ctx, rollout: 0.5 }).includes('RELEASE_NOT_AUTHORIZED rollout 0.5 > 0.1'));
  assert.ok(errorsOf(evidence(), ctx).includes('RELEASE_NOT_AUTHORIZED rollout 1 > 0.1'));
  assert.deepEqual(check(evidence(), { ...ctx, phase: 'before-deploy' }).errors, []);
  assert.deepEqual(check(evidence(), withPlan({}, { phase: 'before-release' })).errors, []);
});
test('merged plans keep the most conservative rollout', () => {
  assert.equal(mergeTestPlans([plan({ release: { markets: ['google-play'], rollout: 0.2 } }), plan()]).rollout, 0.2);
  assert.equal(mergeTestPlans([plan()]).rollout, 1);
});
test('a design must use the test plan in its own folder', () => {
  const document = evidence(); document.designs[0].testPlan = 'docs/design/2026-10-01-other/test-plan.json';
  assert.ok(errorsOf(document, context()).includes(`TEST_PLAN_DESIGN_MISMATCH ${DESIGN}`));
});

// 순수 validator fixture다. 제품 UI/기기 실행·사람 승인 원본을 대신하지 않는다.
function separateUiApprovalsFixture(){
 const ctx=withPlan({redesign:true,level:'L3'}),document=evidence({runs:[fullDev()],reviewRounds:rounds()});
 document.additionalIterationApproval=null;document.additionalIterationApprovals=[];
 for(const [number,minute,approvedMinute]of [[4,'00','03:50'],[5,'20','04:15'],[6,'30','04:28'],[7,'40','04:38']]){
  const round=structuredClone(document.reviewRounds[2]);
  Object.assign(round,{number,plannedAt:`2026-10-14T04:${minute}:00Z`,startedAt:`2026-10-14T04:${String(Number(minute)+1).padStart(2,'0')}:00Z`,completedAt:`2026-10-14T04:${String(Number(minute)+10).padStart(2,'0')}:00Z`});
  if(number<7)for(const aspect of ['functional','ux'])Object.assign(round[aspect],{status:'failed',resolutionEvidence:'https://example.com/later-synthetic-resolution'});
  document.reviewRounds.push(round);
  document.additionalIterationApprovals.push({approverKind:'human',approver:'owner',approvedAt:`2026-10-14T${approvedMinute}:00Z`,maxRound:number,evidence:`https://example.com/ui${number}-approval`});
 }
 return {document,ctx};
}
test('v2 separate approvals preserve each round original time and cap',()=>{
 const {document,ctx}=separateUiApprovalsFixture();const before=structuredClone(document.additionalIterationApprovals);
 assert.deepEqual(check(document,ctx).errors,[]);assert.equal(check(document,ctx).level,'L3');assert.deepEqual(document.additionalIterationApprovals,before);
 assert.equal(document.reviewRounds[3].functional.status,'failed');assert.equal(document.reviewRounds[5].ux.status,'failed');
});
test('v2 separate approvals are independent of array order',()=>{const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals.reverse();assert.deepEqual(check(document,ctx).errors,[]);});
for(const number of [4,5,6,7]){
 test(`v2 separate approvals reject missing round ${number} authorization`,()=>{const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals.splice(number-4,1);assert.ok(errorsOf(document,ctx).includes('EXTRA_ROUND_APPROVAL_REQUIRED'));});
 test(`v2 separate approvals reject round ${number} authorization after its plan`,()=>{const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals[number-4].approvedAt=document.reviewRounds[number-1].startedAt;assert.ok(errorsOf(document,ctx).includes('EXTRA_ROUND_APPROVAL_REQUIRED'));});
}
test('v2 latest approval alone cannot retroactively authorize earlier rounds',()=>{const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals=[document.additionalIterationApprovals[3]];assert.deepEqual(errorsOf(document,ctx),['EXTRA_ROUND_APPROVAL_REQUIRED']);});
test('v2 earliest truthful approval cannot authorize later rounds outside its cap',()=>{const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals=[document.additionalIterationApprovals[0]];assert.deepEqual(errorsOf(document,ctx),['EXTRA_ROUND_APPROVAL_REQUIRED']);});
test('v2 maxRound remains an upper bound for a genuine prior approval',()=>{
 for(const plural of [false,true]){
  const {document,ctx}=separateUiApprovalsFixture(),approval={...document.additionalIterationApprovals[0],maxRound:7};
  if(plural)document.additionalIterationApprovals=[approval];else{delete document.additionalIterationApprovals;document.additionalIterationApproval=approval;}
  assert.deepEqual(check(document,ctx).errors,[]);
 }
});
for(const [name,change]of [
 ['non-null single plus plural',d=>{d.additionalIterationApproval={...d.additionalIterationApprovals[0]};}],
 ['empty array',d=>{d.additionalIterationApprovals=[];}],['null array',d=>{d.additionalIterationApprovals=null;}],['object instead of array',d=>{d.additionalIterationApprovals={};}],
 ['null item',d=>{d.additionalIterationApprovals[0]=null;}],['array item',d=>{d.additionalIterationApprovals[0]=[];}],['string item',d=>{d.additionalIterationApprovals[0]='approved';}],
 ['missing single nullable field',d=>{delete d.additionalIterationApproval;}],['missing approval time',d=>{delete d.additionalIterationApprovals[0].approvedAt;}],
 ['non-human approval',d=>{d.additionalIterationApprovals[0].approverKind='agent';}],['unknown approval field',d=>{d.additionalIterationApprovals[0].scope='all';}],
 ['string cap',d=>{d.additionalIterationApprovals[0].maxRound='4';}],['cap below four',d=>{d.additionalIterationApprovals[0].maxRound=3;}],['non-UTC receipt format',d=>{d.additionalIterationApprovals[0].approvedAt='2026-10-14T03:50:00+00:00';}],
])test(`v2 separate approval schema rejects ${name}`,()=>{const {document,ctx}=separateUiApprovalsFixture();change(document);const errors=errorsOf(document,ctx);assert.ok(errors.some(e=>e.startsWith('EVIDENCE_SCHEMA')),JSON.stringify(errors));});
for(const [name,change]of [
 ['identical entry',a=>({...a})],['conflicting time',a=>({...a,approvedAt:'2026-10-14T04:39:00Z'})],['conflicting evidence',a=>({...a,evidence:'https://example.com/other-approval'})],
])test(`v2 separate approvals reject a duplicate cap with ${name}`,()=>{const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals.push(change(document.additionalIterationApprovals[3]));assert.ok(errorsOf(document,ctx).includes('DUPLICATE additional-iteration-approval-maxRound'));});
test('v2 separate approvals reject an invalid unused timestamp instead of silently ignoring it',()=>{const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals.push({...document.additionalIterationApprovals[3],maxRound:8,approvedAt:'2026-99-14T04:38:00Z'});assert.ok(errorsOf(document,ctx).includes('INVALID_ADDITIONAL_ITERATION_APPROVAL_TIME'));});
for(const aspect of ['functional','ux'])test(`v2 separate approvals retain unresolved historical ${aspect} rejection`,()=>{const {document,ctx}=separateUiApprovalsFixture();delete document.reviewRounds[4][aspect].resolutionEvidence;assert.ok(errorsOf(document,ctx).includes(`UNRESOLVED_REVIEW 5-${aspect}`));});
for(const aspect of ['functional','ux'])test(`v2 separate approvals cannot waive final ${aspect} failure with a resolution link`,()=>{const {document,ctx}=separateUiApprovalsFixture();Object.assign(document.reviewRounds[6][aspect],{status:'failed',resolutionEvidence:'https://example.com/claimed'});assert.ok(errorsOf(document,ctx).includes(`UNRESOLVED_REVIEW 7-${aspect}`));});
test('v2 separate approvals retain non-overlap and independent reviewer requirements',()=>{
 for(const [change,expected]of [[d=>{d.reviewRounds[6].plannedAt='2026-10-14T04:30:00Z';},'ROUND_OVERLAP'],[d=>{d.reviewRounds[6].reviewer='author-agent';},'INDEPENDENT_REVIEW_REQUIRED']]){
  const {document,ctx}=separateUiApprovalsFixture();change(document);assert.ok(errorsOf(document,ctx).includes(expected));
 }
});
test('v2 separate approvals retain the 168-hour run age and public release scope',()=>{
 const {document,ctx}=separateUiApprovalsFixture();assert.ok(errorsOf(document,{...ctx,now:'2026-10-22T06:00:00Z'}).includes('RUN_EXPIRED dev-full'));
 ctx.phase='before-release';ctx.plans[DESIGN].plan.release.until='test-track';assert.ok(errorsOf(document,ctx).includes('RELEASE_NOT_AUTHORIZED until test-track'));
});
for(const approvedAt of ['2026-02-30T04:38:00Z','2026-02-29T04:38:00Z','2026-04-31T04:38:00Z','2026-10-13T24:00:00Z'])test(`v2 separate approvals reject malformed calendar ${approvedAt}`,()=>{
 const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals[3].approvedAt=approvedAt;
 assert.ok(errorsOf(document,ctx).includes('INVALID_ADDITIONAL_ITERATION_APPROVAL_TIME'));
});
for(const approvedAt of ['2024-02-29T04:38:00Z','2026-10-14T04:38:00Z','2026-10-14T04:38:00.123456Z','2026-10-14T04:38:00.123456789Z'])test(`v2 separate approvals preserve valid calendar and fractional format ${approvedAt}`,()=>{
 const {document,ctx}=separateUiApprovalsFixture();document.additionalIterationApprovals[3].approvedAt=approvedAt;
 assert.deepEqual(check(document,ctx).errors,[]);assert.equal(document.additionalIterationApprovals[3].approvedAt,approvedAt);
});

// native-only L3의 기기 실행과 UI 검수는 테스트 빌드 뒤, 공개 직전에 필수다.
for(const phase of ['before-build','before-deploy'])test(`native-only redesign defers required UI rounds until physical release: ${phase}`,()=>{const document=evidence({runs:[],reviewRounds:[]}),ctx=withPlan({level:'L3',environments:['android','ios'],redesign:true},{phase});const result=check(document,ctx);assert.equal(result.ok,true,result.errors.join('\n'));assert.equal(result.level,'L3');assert.equal(result.completedAt,null);});
for(const phase of ['before-build','before-deploy','before-release'])test(`dev-including redesign retains required UI rounds: ${phase}`,()=>{const document=evidence({runs:[],reviewRounds:[]}),ctx=withPlan({level:'L3',environments:['dev','android','ios'],redesign:true},{phase});assert.ok(errorsOf(document,ctx).includes('THREE_UI_ROUNDS_REQUIRED'));});
test('native-only redesign still requires UI rounds and both physical full regressions before-release',()=>{const errors=errorsOf(evidence({runs:[],reviewRounds:[]}),withPlan({level:'L3',environments:['android','ios'],redesign:true},{phase:'before-release'}));assert.ok(errors.includes('THREE_UI_ROUNDS_REQUIRED'));assert.ok(errors.includes('RUN_COVERAGE android create'));assert.ok(errors.includes('RUN_COVERAGE ios create'));});
test('native-only early phase still validates the independent completed rounds it records',()=>{const reviewRounds=rounds();reviewRounds[2].functional.status='blocked';assert.ok(errorsOf(evidence({runs:[],reviewRounds}),withPlan({level:'L3',environments:['android','ios'],redesign:true})).includes('UNRESOLVED_REVIEW 3-functional'));});
test('a merged plan that still contains dev cannot defer redesign review',()=>{const ctx=withPlan({level:'L3',environments:['android','ios'],redesign:true});ctx.plans['D-2']={approved:true,plan:plan({level:'L3',environments:['dev']})};const document=evidence({runs:[],reviewRounds:[]});document.designs.push({...document.designs[0],id:'D-2'});assert.ok(errorsOf(document,ctx).includes('THREE_UI_ROUNDS_REQUIRED'));});
for(const phase of[undefined,null,'','unknown-phase'])test(`native-only early review never authorizes invalid phase ${String(phase)}`,()=>{const ctx=withPlan({level:'L3',environments:['android'],redesign:true},{phase});assert.deepEqual(errorsOf(evidence({runs:[],reviewRounds:[]}),ctx),['INVALID_PHASE']);});
test('native-only timing does not admit an environment outside dev/android/ios',()=>{const ctx=withPlan({level:'L3',environments:['watch'],redesign:true});assert.ok(errorsOf(evidence({runs:[],reviewRounds:[]}),ctx).some(code=>code.startsWith('TEST_PLAN_INVALID D-1')));});
