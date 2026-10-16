// 설계 2026-10-16-godot-headless-e2e: 기능 목록 v2의 플랫폼 경로 실기기 하한과 CI 실행 인정.
// 가상 데이터이며 실제 제품 검수 결과가 아니다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { validateDevelopmentEvidence, verifyReleaseDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { APPROVED, DESIGN, SHA, context, evidence, inventory, plan, run } from './helpers/test-levels-fixture.mjs';

const WORKFLOW = '.github/workflows/godot-checks.yml';
const CI_URL = 'https://github.com/seorilabs/example/actions/runs/123456789';
const ALL = ['create', 'settings', 'store', 'purchase', 'ads'];

const inventoryV2 = (changes = {}) => ({
  schemaVersion: 2,
  e2e: { workflow: WORKFLOW, command: 'npm run test:e2e' },
  features: [
    { id: 'create', core: true, paths: ['src/create/**'] },
    { id: 'settings', core: false, paths: ['src/settings/**'] },
    { id: 'store', core: true },
    { id: 'purchase', core: true, foundation: true, paths: ['src/purchase/**'], platformPaths: ['src/purchase/native/**'] },
    { id: 'ads', core: false, foundation: true, paths: ['src/ads/**'], platformPaths: ['src/ads/native/**'] },
  ],
  ...changes,
});
const ciRun = (changes = {}) => ({
  repository: { full_name: 'seorilabs/example' }, head_sha: SHA, status: 'completed', conclusion: 'success',
  path: WORKFLOW, updated_at: '2026-10-14T05:10:00Z', ...changes,
});
const v2 = (planChanges = {}, ctxChanges = {}) => context({
  featureInventory: inventoryV2(), baselineInventories: { 'v1.0.0': inventoryV2() },
  plans: { [DESIGN]: { approved: true, plan: plan(planChanges) } }, ...ctxChanges,
});
const check = (document, ctx) => validateDevelopmentEvidence(document, ctx);
const errorsOf = (document, ctx) => check(document, ctx).errors;
const devRun = (featureIds, changes = {}) => run('dev-1', 'godot-headless-e2e', featureIds, changes);
const ciE2e = (featureIds = ALL, changes = {}) => run('e2e-ci', 'godot-headless-e2e', featureIds, { executor: 'ci', ciRun: { url: CI_URL }, ...changes });
const device = (featureIds, kind = 'android-device') => run(`${kind}-1`, kind, featureIds, { executor: 'device-agent' });

// AC-1: v2에서는 기반 기능의 paths만 바뀌면 실기기 하한이 없다.
test('AC-1 a v2 foundation path change outside platformPaths needs only the dev run', () => {
  const ctx = v2({}, { phase: 'before-release', changes: { 'v1.0.0': ['src/settings/screen.ts', 'src/purchase/shop_screen.gd'] } });
  const result = check(evidence({ runs: [devRun(['settings', 'purchase'])] }), ctx);
  assert.deepEqual(result.errors, []);
  assert.equal(result.level, 'L1');
  assert.ok(errorsOf(evidence({ runs: [devRun(['settings'])] }), ctx).includes('RUN_COVERAGE dev purchase'));
});
test('AC-1 the same change under a v1 inventory keeps the foundation device floor', () => {
  const ctx = context({ phase: 'before-release', changes: { 'v1.0.0': ['src/settings/screen.ts', 'src/purchase/shop_screen.gd'] } });
  assert.ok(errorsOf(evidence({ runs: [devRun(['settings', 'purchase'])] }), ctx).includes('TEST_LEVEL_BELOW_FLOOR foundation purchase android'));
});

// AC-2·AC-3: 기능의 platformPaths가 바뀌면 그 기능을 대상 마켓 실기기에서 실행한다. 승인된 계획의 사유로만 낮춘다.
const platformChange = (planChanges = {}, phase = 'before-release') => v2(planChanges, { phase, changes: { 'v1.0.0': ['src/settings/screen.ts', 'src/purchase/native/billing.gd'] } });
test('AC-2 a platformPaths change without a device run is below the floor at release', () => {
  const errors = errorsOf(evidence({ runs: [devRun(['settings', 'purchase'])] }), platformChange());
  assert.deepEqual(errors, ['TEST_LEVEL_BELOW_FLOOR platform purchase android']);
});
test('AC-2 the build gate runs the platform feature in dev without waiting for the device', () => {
  assert.deepEqual(errorsOf(evidence({ runs: [devRun(['settings', 'purchase'])] }), platformChange({}, 'before-build')), []);
  assert.ok(errorsOf(evidence(), platformChange({}, 'before-build')).includes('RUN_COVERAGE dev purchase'));
});
test('AC-2 an independent device run of the platform feature satisfies the floor as L2', () => {
  const result = check(evidence({ runs: [devRun(['settings', 'purchase']), device(['purchase'])] }), platformChange());
  assert.deepEqual(result.errors, []);
  assert.equal(result.level, 'L2');
});
test('AC-2 a platformPaths file outside the feature paths still joins the dev scope', () => {
  const ctx = v2({}, { featureInventory: inventoryV2({ features: [...inventoryV2().features.slice(0, 4), { id: 'ads', core: false, platformPaths: ['native/ads/**'] }] }),
    phase: 'before-build', changes: { 'v1.0.0': ['src/settings/screen.ts', 'native/ads/AdsPlugin.kt'] } });
  assert.ok(errorsOf(evidence(), ctx).includes('RUN_COVERAGE dev ads'));
});
test('AC-3 an approved platform override lowers the floor', () => {
  const ctx = platformChange({ floorOverrides: [{ rule: 'platform', featureId: 'purchase', reason: '로그 문구만 바뀜' }] });
  assert.deepEqual(errorsOf(evidence({ runs: [devRun(['settings', 'purchase'])] }), ctx), []);
});

// AC-4: 공통 플랫폼 경로는 플랫폼 기능 전체, 플랫폼 기능이 없으면 핵심 기능을 실기기에서 실행한다.
const commonChange = (inventoryChanges = {}, planChanges = {}) => v2(planChanges, {
  featureInventory: inventoryV2({ regressionPaths: ['native/regression/**'], ...inventoryChanges }),
  phase: 'before-release', changes: { 'v1.0.0': ['src/settings/screen.ts', 'godot/export_presets.cfg'] },
});
test('AC-4 a central default platform path raises every platform feature to the device floor', () => {
  const errors = errorsOf(evidence({ runs: [devRun(['settings'])] }), commonChange());
  assert.deepEqual(errors, ['TEST_LEVEL_BELOW_FLOOR platform ads android', 'TEST_LEVEL_BELOW_FLOOR platform purchase android']);
  assert.deepEqual(errorsOf(evidence({ runs: [devRun(['settings']), device(['purchase', 'ads'])] }), commonChange()), []);
});
test('AC-4 without platform features the core features take the device floor', () => {
  const features = inventoryV2().features.map(({ platformPaths, ...feature }) => feature);
  const ctx = commonChange({ features });
  ctx.baselineInventories = { 'v1.0.0': inventoryV2({ features }) };
  const errors = errorsOf(evidence({ runs: [devRun(['settings'])] }), ctx);
  assert.deepEqual(errors, ['TEST_LEVEL_BELOW_FLOOR platform create android', 'TEST_LEVEL_BELOW_FLOOR platform purchase android', 'TEST_LEVEL_BELOW_FLOOR platform store android']);
});
test('AC-4 the inventory platformPaths replace the central defaults once the baseline has them too', () => {
  const ctx = commonChange({ platformPaths: ['native/**'] });
  ctx.baselineInventories = { 'v1.0.0': inventoryV2({ platformPaths: ['native/**'] }) };
  assert.deepEqual(errorsOf(evidence({ runs: [devRun(['settings'])] }), ctx), []);
});
// 리뷰 반영: 후보에서 플랫폼 경로를 지우거나 좁혀도 기준 태그의 경로로 바뀐 파일을 판정한다.
test('AC-4 removing a feature platformPaths in the candidate keeps the baseline mapping', () => {
  const features = inventoryV2().features.map(f => f.id === 'purchase' ? { ...f, platformPaths: undefined } : f).map(f => JSON.parse(JSON.stringify(f)));
  const ctx = v2({}, { featureInventory: inventoryV2({ features }), phase: 'before-release',
    changes: { 'v1.0.0': ['src/settings/screen.ts', 'src/purchase/native/billing.gd'] } });
  assert.deepEqual(errorsOf(evidence({ runs: [devRun(['settings', 'purchase'])] }), ctx), ['TEST_LEVEL_BELOW_FLOOR platform purchase android']);
});
test('AC-4 narrowing the common platformPaths in the candidate keeps the baseline paths', () => {
  const errors = errorsOf(evidence({ runs: [devRun(['settings'])] }), commonChange({ platformPaths: ['native/**'] }));
  assert.deepEqual(errors, ['TEST_LEVEL_BELOW_FLOOR platform ads android', 'TEST_LEVEL_BELOW_FLOOR platform purchase android']);
});
test('AC-4 each common platform feature can be lowered by its own override', () => {
  const ctx = commonChange({}, { floorOverrides: [{ rule: 'platform', featureId: 'ads', reason: '광고 미변경' }] });
  assert.deepEqual(errorsOf(evidence({ runs: [devRun(['settings'])] }), ctx), ['TEST_LEVEL_BELOW_FLOOR platform purchase android']);
});

// AC-5: 첫 출시와 기준 태그에 없던 플랫폼 기능은 낮출 수 없다.
const lowerAll = [{ rule: 'platform', featureId: 'purchase', reason: 'x' }, { rule: 'platform', featureId: 'ads', reason: 'x' }];
test('AC-5 a first release needs every platform feature on the device even with overrides', () => {
  const ctx = v2({ baseline: null, level: 'L3', floorOverrides: lowerAll }, { phase: 'before-release' });
  const errors = errorsOf(evidence({ runs: [ciE2e()] }), { ...ctx, ciRuns: { [CI_URL]: ciRun() } });
  assert.deepEqual(errors, ['TEST_LEVEL_BELOW_FLOOR platform-first ads android', 'TEST_LEVEL_BELOW_FLOOR platform-first purchase android']);
});
test('AC-5 a platform feature missing from the baseline inventory cannot be lowered', () => {
  const baseline = inventoryV2({ features: inventoryV2().features.filter(f => f.id !== 'ads') });
  const ctx = v2({ floorOverrides: lowerAll }, { phase: 'before-release', baselineInventories: { 'v1.0.0': baseline } });
  assert.deepEqual(errorsOf(evidence(), ctx), ['TEST_LEVEL_BELOW_FLOOR platform-first ads android']);
});
test('AC-5 an unreadable baseline inventory treats every platform feature as new', () => {
  const ctx = v2({}, { phase: 'before-release', baselineInventories: { 'v1.0.0': null } });
  assert.deepEqual(errorsOf(evidence(), ctx), ['TEST_LEVEL_BELOW_FLOOR platform-first ads android', 'TEST_LEVEL_BELOW_FLOOR platform-first purchase android']);
  assert.deepEqual(errorsOf(evidence({ runs: [devRun(['settings']), device(['purchase', 'ads'])] }), ctx), []);
});
test('AC-5 a malformed baseline inventory is treated as unreadable', () => {
  const ctx = v2({ floorOverrides: lowerAll }, { phase: 'before-release', baselineInventories: { 'v1.0.0': { schemaVersion: 999, features: [{ id: 'purchase' }, { id: 'ads' }] } } });
  assert.deepEqual(errorsOf(evidence(), ctx), ['TEST_LEVEL_BELOW_FLOOR platform-first ads android', 'TEST_LEVEL_BELOW_FLOOR platform-first purchase android']);
});
test('AC-5 an existing platform feature from a v1 baseline inventory is not new', () => {
  const ctx = v2({}, { phase: 'before-release', baselineInventories: { 'v1.0.0': inventory() } });
  assert.deepEqual(errorsOf(evidence(), ctx), []);
});

// AC-6: API로 확인한 CI 실행은 L3 독립 실행이다.
const l3 = (ciRuns = { [CI_URL]: ciRun() }, ctxChanges = {}) => ({ ...v2({ level: 'L3' }, ctxChanges), ciRuns });
test('AC-6 a verified CI headless E2E run is an independent L3 run', () => {
  const result = check(evidence({ runs: [ciE2e()] }), l3());
  assert.deepEqual(result.errors, []);
  assert.equal(result.level, 'L3');
});
test('AC-6 an L3 headless run by the implementer is still not independent', () => {
  assert.ok(errorsOf(evidence({ runs: [devRun(ALL)] }), l3()).includes('INDEPENDENT_RUN_REQUIRED dev-1'));
});
for (const [name, changes, url, code] of [
  ['another candidate', { head_sha: 'f'.repeat(40) }, CI_URL, 'CI_RUN_MISMATCH e2e-ci'],
  ['another repository in the URL', {}, 'https://github.com/seorilabs/other/actions/runs/123456789', 'CI_RUN_MISMATCH e2e-ci'],
  ['another repository in the API', { repository: { full_name: 'seorilabs/other' } }, CI_URL, 'CI_RUN_MISMATCH e2e-ci'],
  ['a failed run', { conclusion: 'failure' }, CI_URL, 'CI_RUN_NOT_SUCCESSFUL e2e-ci'],
  ['a running run', { status: 'in_progress', conclusion: null }, CI_URL, 'CI_RUN_NOT_SUCCESSFUL e2e-ci'],
  ['another workflow', { path: '.github/workflows/deploy.yml' }, CI_URL, 'CI_RUN_WORKFLOW e2e-ci'],
  ['an expired run', { updated_at: '2026-10-01T00:00:00Z' }, CI_URL, 'RUN_EXPIRED e2e-ci'],
]) {
  test(`AC-6 a CI run from ${name} is rejected`, () => {
    const errors = errorsOf(evidence({ runs: [ciE2e(ALL, { ciRun: { url } })] }), l3({ [url]: ciRun(changes) }));
    assert.ok(errors.includes(code), errors.join('\n'));
    assert.ok(errors.includes('RUN_COVERAGE dev create'), errors.join('\n'));
  });
}
test('AC-6 a CI run cannot be used with a v1 inventory that names no E2E workflow', () => {
  const ctx = { ...context({ plans: { [DESIGN]: { approved: true, plan: plan({ level: 'L3' }) } } }), ciRuns: { [CI_URL]: ciRun() } };
  assert.ok(errorsOf(evidence({ runs: [ciE2e()] }), ctx).includes('CI_RUN_WORKFLOW e2e-ci'));
});
test('AC-6 a run attempt URL is accepted', () => {
  const url = `${CI_URL}/attempts/2`;
  assert.deepEqual(errorsOf(evidence({ runs: [ciE2e(ALL, { ciRun: { url } })] }), l3({ [url]: ciRun() })), []);
});

// AC-7: CI 실행 형식.
for (const [name, changes] of [
  ['a CI executor without a run link', { ciRun: undefined }],
  ['a run link without the CI executor', { executor: 'author-agent' }],
  ['a run link outside GitHub Actions', { ciRun: { url: 'https://ci.example.com/runs/1' } }],
]) {
  test(`AC-7 ${name} fails the evidence schema`, () => {
    const document = evidence({ runs: [ciE2e(ALL, changes)] });
    if (changes.ciRun === undefined && 'ciRun' in changes) delete document.runs[0].ciRun;
    assert.ok(errorsOf(document, l3()).some(error => error.startsWith('EVIDENCE_SCHEMA')));
  });
}
test('AC-7 a device run cannot be a CI run', () => {
  const document = evidence({ runs: [devRun(ALL, { executor: 'review-agent' }), run('android-1', 'android-device', ['settings'], { executor: 'ci', ciRun: { url: CI_URL } })] });
  const ctx = { ...v2({ level: 'L3', environments: ['dev', 'android'] }, { phase: 'before-release' }), ciRuns: { [CI_URL]: ciRun() } };
  assert.ok(errorsOf(document, ctx).includes('CI_RUN_KIND android-1'));
});

// AC-8: 확인하지 못한 CI 실행은 통과가 아니다.
test('AC-8 a CI run without an API readback is unverified', () => {
  const errors = errorsOf(evidence({ runs: [ciE2e()] }), l3({}));
  assert.ok(errors.includes('CI_RUN_UNVERIFIED e2e-ci'));
  assert.ok(errors.includes('RUN_COVERAGE dev create'));
});

// AC-9: 기능 목록과 낮춤 규칙의 버전이 맞아야 한다.
test('AC-9 a platform override is invalid with a v1 inventory and a foundation override with v2', () => {
  const v1 = context({ plans: { [DESIGN]: { approved: true, plan: plan({ floorOverrides: [{ rule: 'platform', featureId: 'purchase', reason: 'x' }] }) } } });
  assert.ok(errorsOf(evidence(), v1).includes(`TEST_PLAN_INVALID ${DESIGN} platform-override-needs-inventory-v2`));
  const ctx = v2({ floorOverrides: [{ rule: 'foundation', featureId: 'purchase', reason: 'x' }] });
  assert.ok(errorsOf(evidence(), ctx).includes(`TEST_PLAN_INVALID ${DESIGN} foundation-override-needs-inventory-v1`));
  const unknown = v2({ floorOverrides: [{ rule: 'platform', featureId: 'missing', reason: 'x' }] });
  assert.ok(errorsOf(evidence(), unknown).includes(`TEST_PLAN_INVALID ${DESIGN} override-unknown-feature missing`));
});
for (const [name, featureInventory] of [
  ['a v2 inventory without the E2E workflow', (() => { const value = inventoryV2(); delete value.e2e; return value; })()],
  ['a v2 inventory with a workflow outside .github/workflows', inventoryV2({ e2e: { workflow: 'ci/e2e.yml' } })],
  ['a v1 inventory with platformPaths', { ...inventory(), platformPaths: ['android/**'] }],
  ['a v1 inventory with a feature platformPaths', { ...inventory(), features: [...inventory().features, { id: 'x', core: false, platformPaths: ['a/**'] }] }],
  ['a v2 feature with empty platformPaths', inventoryV2({ features: [{ id: 'x', core: true, platformPaths: [] }] })],
]) {
  test(`AC-9 ${name} is not a valid source inventory`, () => {
    assert.ok(errorsOf(evidence(), v2({}, { featureInventory })).includes('SOURCE_FEATURE_INVENTORY_REQUIRED'));
  });
}

// 원격·로컬 검증기가 기준 태그의 기능 목록과 CI 실행을 실제로 읽는다.
const PLAN_PATH = 'docs/design/2026-10-14-example/test-plan.json';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const encoded = value => { const text = JSON.stringify(value); return { encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') }; };
function fakeGitHub({ document, testPlan = plan({ level: 'L3' }), baselineInventory = inventoryV2(), run: runBody = ciRun(), runStatus = 200,
  changed = ['src/settings/screen.ts'] } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/releases/tags/')) return reply({ id: 10 });
    if (url.includes('/releases/10/assets?')) return reply([{ id: 20, name: 'development-evidence.google-play.before-release.json', size: 10000 }]);
    if (url.endsWith('/releases/assets/20')) return reply(document);
    if (url.includes(`/contents/docs/qa/feature-inventory.json?ref=${SHA}`)) return reply(encoded(inventoryV2()));
    if (url.includes('/contents/docs/qa/feature-inventory.json?ref=v1.0.0')) return baselineInventory ? reply(encoded(baselineInventory)) : reply({ message: 'Not Found' }, 404);
    if (url.endsWith(`/compare/${APPROVED}...${SHA}`)) return reply({ status: 'ahead' });
    if (url.endsWith(`/contents/${PLAN_PATH}?ref=${APPROVED}`)) return reply(encoded(testPlan));
    if (url.endsWith(`/compare/v1.0.0...${SHA}`)) return reply({ status: 'ahead', files: changed.map(filename => ({ filename })) });
    if (url.endsWith('/actions/runs/123456789')) return runStatus === 200 ? reply(runBody) : reply({ message: 'Not Found' }, runStatus);
    throw new Error(`Unexpected URL ${url}`);
  };
  return { calls, fetchImpl };
}
const verify = api => verifyReleaseDevelopmentEvidence({ ...context(), phase: 'before-release', now: '2026-10-14T06:00:00Z', tag: 'v1.0.0', token: 'fixture-token', fetchImpl: api.fetchImpl });

test('Release verifier reads the CI run and the baseline inventory for a v2 inventory', async () => {
  const api = fakeGitHub({ document: evidence({ runs: [ciE2e()] }) });
  const result = await verify(api);
  assert.equal(result.ok, true); assert.equal(result.level, 'L3');
  assert.ok(api.calls.some(url => url.endsWith('/repos/seorilabs/example/actions/runs/123456789')));
  assert.ok(api.calls.some(url => url.includes('/contents/docs/qa/feature-inventory.json?ref=v1.0.0')));
});
for (const runStatus of [404, 403, 500]) {
  test(`Release verifier reports a CI run readback ${runStatus} as unverified`, async () => {
    await assert.rejects(verify(fakeGitHub({ document: evidence({ runs: [ciE2e()] }), runStatus })), /CI_RUN_UNVERIFIED e2e-ci/u);
  });
}
test('Release verifier treats a missing baseline inventory as new platform features', async () => {
  const document = evidence({ runs: [ciE2e()] });
  await assert.rejects(verify(fakeGitHub({ document, baselineInventory: null })), /TEST_LEVEL_BELOW_FLOOR platform-first purchase android/u);
});

test('local CLI reads the baseline inventory from git and fails a CI run without a token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'godot-headless-e2e-cli-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const write = (path, body) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), body); };
  const commit = (message, files) => { for (const [path, body] of Object.entries(files)) write(path, body); git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  const cli = (sha, runs, env = {}) => {
    const document = evidence({ sourceSha: sha, runs });
    document.designs[0].approvedCommit = approved;
    const path = join(dir, '..', `${sha}.godot-e2e.json`); writeFileSync(path, JSON.stringify(document));
    try {
      return spawnSync(process.execPath, [join(process.cwd(), 'scripts/release/verify-development-evidence.mjs'), '--file', path,
        '--repo', 'seorilabs/example', '--sha', sha, '--target', 'google-play', '--phase', 'before-release'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ENV: '', GITHUB_OUTPUT: '', GH_TOKEN: '', GITHUB_TOKEN: '', ...env } });
    } finally { rmSync(path, { force: true }); }
  };
  const times = sha => { const now = Date.now(); return { sourceSha: sha, plannedAt: new Date(now - 60000).toISOString(), startedAt: new Date(now - 40000).toISOString(), completedAt: new Date(now - 20000).toISOString() }; };
  let approved;
  try {
    git('init', '-q');
    const base = inventoryV2({ features: inventoryV2().features.filter(f => f.id !== 'ads') });
    commit('base', { 'docs/qa/feature-inventory.json': JSON.stringify(base), 'src/settings/screen.ts': 'v1' });
    git('tag', 'v1.0.0');
    approved = commit('design', { [PLAN_PATH]: JSON.stringify(plan({ floorOverrides: lowerAll })), 'docs/design/2026-10-14-example/design.md': '# d' });
    const candidate = commit('add ads', { 'docs/qa/feature-inventory.json': JSON.stringify(inventoryV2()), 'src/settings/screen.ts': 'v2' });
    const newFeature = cli(candidate, [devRun(['settings'], times(candidate))]);
    assert.equal(newFeature.status, 1); assert.match(newFeature.stderr, /TEST_LEVEL_BELOW_FLOOR platform-first ads android/u);
    const withCi = cli(candidate, [devRun(['settings'], times(candidate)), ciE2e(['settings'], { ...times(candidate), id: 'e2e-ci' })]);
    assert.equal(withCi.status, 1); assert.match(withCi.stderr, /CI_RUN_UNVERIFIED e2e-ci/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// AC-10: godot-checks.yml은 요청받을 때만 E2E 결과를 보관한다. 보존 기간은 조직 정책(workflow-artifact-retention 테스트)을 따른다.
test('AC-10 godot-checks keeps the headless E2E report only when the caller names it', () => {
  const workflow = parse(readFileSync('.github/workflows/godot-checks.yml', 'utf8'));
  const input = workflow.on.workflow_call.inputs.e2e_report_path;
  assert.deepEqual({ required: input.required, default: input.default, type: input.type }, { required: false, default: '', type: 'string' });
  const upload = workflow.jobs.compile.steps.find(step => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, "${{ always() && inputs.e2e_report_path != '' }}");
  assert.equal(upload.with.path, '${{ inputs.e2e_report_path }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
});

test('the v2 inventory template is a valid source inventory', async () => {
  const { validInventory } = await import('../scripts/release/test-plan.mjs');
  assert.equal(validInventory(JSON.parse(readFileSync('docs/agent-governance/templates/feature-inventory-v2.example.json', 'utf8'))), true);
});
