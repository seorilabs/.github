import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {mergeTestPlans, testPlanProblems} from '../scripts/release/test-plan.mjs';
import {validateDevelopmentEvidence} from '../scripts/release/verify-development-evidence.mjs';
import {DESIGN, context, evidence, inventory, plan, run} from './helpers/test-levels-fixture.mjs';

test('NREL-1 the published development-only example validates', () => {
  const example = JSON.parse(readFileSync(new URL('../docs/agent-governance/templates/test-plan.development-only.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(testPlanProblems(example, inventory()), []);
  assert.equal(example.release, null);
});

test('NREL-1 explicit null permits a development-only plan and keeps release required', () => {
  assert.deepEqual(testPlanProblems(plan({release: null}), inventory()), []);
  for (const release of [{}, false, '', [], {markets: []}]) {
    assert.ok(testPlanProblems(plan({release}), inventory()).length > 0);
  }
  const missing = plan(); delete missing.release;
  assert.ok(testPlanProblems(missing, inventory()).length > 0);
});

test('NREL-2 null dominates release approvals in every merge order', () => {
  const dev = plan({release: null});
  const shipping = plan({release: {markets: ['google-play'], until: 'public', rollout: 0.2}});
  for (const plans of [[dev], [dev, shipping], [shipping, dev], [shipping, dev, shipping]]) {
    const merged = mergeTestPlans(plans);
    assert.equal(merged.releaseAllowed, false);
    assert.deepEqual(merged.markets, []);
    assert.equal(merged.until, null);
    assert.equal(merged.rollout, null);
    assert.deepEqual(merged.changedFeatures, ['settings']);
    assert.deepEqual(merged.environments, ['dev']);
  }
});

test('NREL-2 merging development plans retains test scope and conservative overrides', () => {
  const merged = mergeTestPlans([
    plan({release: null, floorOverrides: [{rule: 'regression', reason: 'dev only'}]}),
    plan({level: 'L3', changedFeatures: ['create'], environments: ['dev', 'ios'], baseline: 'v1.0.1'}),
  ]);
  assert.equal(merged.level, 'L3');
  assert.deepEqual(merged.changedFeatures, ['create', 'settings']);
  assert.deepEqual(merged.environments, ['dev', 'ios']);
  assert.deepEqual(merged.baselines, ['v1.0.0', 'v1.0.1']);
  assert.equal(merged.regressionOverride, false);
  assert.equal(merged.releaseAllowed, false);
});

for (const target of ['google-play', 'app-store', 'apps-in-toss', 'web', 'service']) {
  for (const phase of ['before-build', 'before-deploy', 'before-release']) {
    test(`NREL-3 development-only blocks ${target} ${phase} with valid dev runs`, () => {
      const service = target === 'service';
      const ctx = context({target, phase, requireUi: !service,
        plans: {[DESIGN]: {approved: true, plan: plan({release: null})}}});
      const document = evidence({target, productKind: service ? 'service' : 'ui',
        runs: [run('dev', service ? 'service-runtime' : 'godot-editor', ['settings'])]});
      assert.deepEqual(validateDevelopmentEvidence(document, ctx).errors,
        ['RELEASE_NOT_AUTHORIZED development-only']);
    });
  }
}

test('NREL-3 a shipping design cannot override a bound development-only design', () => {
  const document = evidence();
  document.designs.push({...document.designs[0], id: 'D-2', document: 'docs/design/second/design.md',
    testPlan: 'docs/design/second/test-plan.json'});
  const ctx = context();
  ctx.plans['D-2'] = {approved: true, plan: plan({release: null})};
  assert.deepEqual(validateDevelopmentEvidence(document, ctx).errors,
    ['RELEASE_NOT_AUTHORIZED development-only']);
});

test('NREL-3 development-only does not bypass missing execution or approval', () => {
  const ctx = context({plans: {[DESIGN]: {approved: true, plan: plan({release: null})}}});
  assert.ok(validateDevelopmentEvidence(evidence({runs: []}), ctx).errors.includes('RUN_COVERAGE dev settings'));
  ctx.plans[DESIGN].approved = false;
  assert.ok(validateDevelopmentEvidence(evidence(), ctx).errors.includes('TEST_PLAN_UNAPPROVED D-1'));
});

test('NREL-4 development-only with a market SDK validation gives a plan error rather than throwing', () => {
  const source = inventory(); source.schemaVersion = 2; source.e2e = {workflow: '.github/workflows/e2e.yml'};
  source.features.find(f => f.id === 'ads').platformPaths = ['native/ads/**'];
  const p = plan({release: null, platformValidation: [{featureId: 'ads', target: 'google-play',
    kind: 'native-development', reason: 'real SDK', checks: ['delivery'], configurationFingerprint: 'c'.repeat(64)}]});
  assert.deepEqual(testPlanProblems(p, source), ['platform-validation-market-not-planned google-play']);
});

test('NREL-5 existing shipping plans retain defaults and conservative release merging', () => {
  const merged = mergeTestPlans([plan({release: {markets: ['google-play']}})]);
  assert.equal(merged.releaseAllowed, true);
  assert.equal(merged.until, 'public');
  assert.equal(merged.rollout, 1);
  assert.deepEqual(merged.markets, ['google-play']);
  const both = mergeTestPlans([plan(), plan({release: {markets: ['app-store'], until: 'review-submitted', rollout: 0.1}})]);
  assert.equal(both.releaseAllowed, true);
  assert.deepEqual(both.markets, ['app-store', 'google-play']);
  assert.equal(both.until, 'review-submitted');
  assert.equal(both.rollout, 0.1);
});
