import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { ALL_FEATURES, DESIGN, context, evidence, plan, rounds, run } from './helpers/test-levels-fixture.mjs';

function fixture({ redesign = false } = {}) {
  const ctx = context();
  ctx.featureInventory.features.push({ id: 'monitor', core: false, paths: ['scripts/monitor/**'], runtimeKind: 'service' });
  ctx.plans[DESIGN].plan = plan({ level: 'L3', changedFeatures: ['monitor'], redesign });
  ctx.changes['v1.0.0'] = ['scripts/monitor/handler.mjs'];
  const document = evidence({ productKind: 'mixed', runs: [
    run('ui', 'web-browser', [...ALL_FEATURES], { executor: 'ui-reviewer' }),
    run('service', 'service-runtime', ['monitor'], { executor: 'service-reviewer' }),
  ], reviewRounds: redesign ? rounds(ALL_FEATURES) : [] });
  return { document, ctx };
}

const check = ({ document, ctx }) => validateDevelopmentEvidence(document, ctx);

test('mixed L3 requires actual UI and service execution of their own features', () => {
  assert.deepEqual(check(fixture()).errors, []);
});

test('mixed supports a v2 inventory without changing its platform floor rules', () => {
  const f = fixture(); f.ctx.featureInventory.schemaVersion = 2;
  f.ctx.featureInventory.e2e = { workflow: '.github/workflows/e2e.yml' };
  assert.deepEqual(check(f).errors, []);
});

for (const [name, index, feature] of [['service claiming UI', 1, 'settings'], ['UI claiming service', 0, 'monitor']]) {
  test(`mixed rejects ${name}`, () => {
    const f = fixture(); f.document.runs[index].scenarios[0].featureIds.push(feature);
    assert.ok(check(f).errors.includes(`RUN_FEATURE_RUNTIME_MISMATCH ${f.document.runs[index].id} ${feature}`));
  });
}

for (const missing of ['ui', 'service']) {
  test(`mixed cannot omit the ${missing} runtime`, () => {
    const f = fixture(); f.document.runs = f.document.runs.filter(r => r.id !== missing);
    assert.ok(check(f).errors.includes('MIXED_RUN_KINDS_REQUIRED'));
  });
}

test('mixed needs both feature kinds and explicit valid service classification', () => {
  const f = fixture(); delete f.ctx.featureInventory.features.at(-1).runtimeKind;
  assert.ok(check(f).errors.includes('MIXED_FEATURE_KINDS_REQUIRED'));
  f.ctx.featureInventory.features.at(-1).runtimeKind = 'other';
  assert.ok(check(f).errors.includes('SOURCE_FEATURE_INVENTORY_REQUIRED'));
});

for (const [name, mutate, error] of [
  ['different candidate', r => { r.sourceSha = 'f'.repeat(40); }, 'RUN_CANDIDATE_MISMATCH service'],
  ['expired service run', r => { r.plannedAt = '2026-10-01T05:00:00Z'; r.startedAt = '2026-10-01T05:01:00Z'; r.completedAt = '2026-10-01T05:10:00Z'; }, 'RUN_EXPIRED service'],
  ['author service run', r => { r.executor = 'author-agent'; }, 'INDEPENDENT_RUN_REQUIRED service'],
  ['unknown feature', r => { r.scenarios[0].featureIds.push('missing'); }, 'RUN_UNKNOWN_FEATURE service missing'],
]) {
  test(`mixed retains ${name} rejection`, () => {
    const f = fixture(); mutate(f.document.runs[1]); assert.ok(check(f).errors.includes(error));
  });
}

test('mixed redesign needs three independent reviews of every UI feature plus service execution', () => {
  const f = fixture({ redesign: true }); assert.deepEqual(check(f).errors, []);
  f.document.reviewRounds = [];
  assert.ok(check(f).errors.includes('THREE_UI_ROUNDS_REQUIRED'));
});

test('mixed UI reviews cannot replace a UI feature with a service feature', () => {
  const f = fixture({ redesign: true });
  f.document.reviewRounds[0].ux.featureIds = f.document.reviewRounds[0].ux.featureIds.filter(id => id !== 'settings');
  assert.ok(check(f).errors.includes('FEATURE_COVERAGE ux-1'));
  f.document.reviewRounds[0].ux.featureIds.push('settings', 'monitor');
  assert.ok(check(f).errors.includes('FEATURE_COVERAGE ux-1'));
});

test('mixed does not relax release scope or platform floors', () => {
  const f = fixture(); f.ctx.phase = 'before-release';
  f.ctx.plans[DESIGN].plan.release = { markets: ['app-store'], until: 'test-track' };
  f.ctx.changes['v1.0.0'].push('src/purchase/billing.ts');
  const errors = check(f).errors;
  assert.ok(errors.includes('RELEASE_NOT_AUTHORIZED market google-play'));
  assert.ok(errors.includes('RELEASE_NOT_AUTHORIZED until test-track'));
  assert.ok(errors.includes('TEST_LEVEL_BELOW_FLOOR foundation purchase android'));
});
