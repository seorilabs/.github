import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { verifyReleaseDevelopmentEvidence, validateDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { SHA, NOW, context, validEvidence } from './helpers/development-evidence-fixture.mjs';

const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fakeGitHub({ evidence = validEvidence(), missing = false, status = 200, duplicate = false, paginated = false, tag = 'v1.0.0', phase = 'before-build', extra = [], archives } = {}) {
  const calls = [];
  const name = tag === 'development-evidence' ? `development-evidence.${SHA}.apps-in-toss.${phase}.json` : `development-evidence.apps-in-toss.${phase}.json`;
  const asset = { id: 20, name, size: 10000 };
  const fetchImpl = async url => {
    calls.push(url);
    if (status !== 200) return reply({ message: 'unavailable' }, status);
    // 실제 API 처럼 draft 보관함은 태그 조회가 404 이고 목록에서만 보인다.
    if (url.includes('/releases/tags/')) return tag === 'development-evidence' ? reply({ message: 'Not Found' }, 404) : reply({ id: 10 });
    if (url.includes('/releases?per_page=')) return reply(archives ?? [{ id: 9, tag_name: 'v0.9.0', draft: false }, { id: 10, tag_name: 'development-evidence', draft: true }]);
    if (url.includes('/releases/10/assets?') && paginated && !url.includes('page=2')) return reply([], 200, { link: '<https://api.github.com/repos/seorilabs/example/releases/10/assets?page=2>; rel="next"' });
    if (url.includes('/releases/10/assets?')) return reply(missing ? [] : duplicate ? [asset, asset] : [asset, ...extra]);
    if (url.endsWith('/releases/assets/20')) return reply(evidence);
    if (url.includes('/contents/docs/qa/feature-inventory.json?ref=')) return reply({ encoding: 'base64', content: Buffer.from(JSON.stringify(context.featureInventory)).toString('base64') });
    throw new Error('Unexpected URL');
  };
  return { calls, fetchImpl };
}
test('Release verifier reads paginated assets and the exact candidate report', async () => {
  const api = fakeGitHub({ paginated: true });
  const result = await verifyReleaseDevelopmentEvidence({ ...context, tag: 'v1.0.0', token: 'fixture-token', fetchImpl: api.fetchImpl });
  assert.equal(result.ok, true); assert.equal(result.assetId, 20); assert.equal(api.calls.length, 5);
});
test('SHA-keyed draft evidence supports untagged development builds', async () => {
  const api = fakeGitHub({ tag: 'development-evidence' });
  assert.equal((await verifyReleaseDevelopmentEvidence({ ...context, tag: 'development-evidence', token: 'fixture-token', fetchImpl: api.fetchImpl })).ok, true);
});
test('draft evidence archive is found from the release list because tag lookup never returns drafts', async () => {
  const api = fakeGitHub({ tag: 'development-evidence' });
  const result = await verifyReleaseDevelopmentEvidence({ ...context, tag: 'development-evidence', token: 'fixture-token', fetchImpl: api.fetchImpl });
  assert.equal(result.assetId, 20);
  assert.ok(api.calls.some(url => url.includes('/releases?per_page=')));
  assert.ok(!api.calls.some(url => url.includes('/releases/tags/development-evidence')));
});
for (const [name, archives] of [['no draft archive', [{ id: 9, tag_name: 'v0.9.0', draft: false }]], ['a published archive', [{ id: 10, tag_name: 'development-evidence', draft: false }]], ['two draft archives', [{ id: 10, tag_name: 'development-evidence', draft: true }, { id: 11, tag_name: 'development-evidence', draft: true }]]]) {
  test(`draft evidence lookup stops on ${name}`, async () => {
    const api = fakeGitHub({ tag: 'development-evidence', archives });
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, tag: 'development-evidence', token: 'fixture-token', fetchImpl: api.fetchImpl }), /DEVELOPMENT_EVIDENCE_ARCHIVE/);
  });
}
for (const [name, options] of [['missing report', { missing: true }], ['duplicate report', { duplicate: true }], ['denied readback', { status: 403 }], ['missing release', { status: 404 }], ['invalid JSON document', { evidence: {} }]]) {
  test(`Release verifier stops on ${name}`, async () => {
    const api = fakeGitHub(options);
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, tag: 'v1.0.0', token: 'fixture-token', fetchImpl: api.fetchImpl }));
  });
}
test('changed configuration stops verification', () => {
  assert.equal(validateDevelopmentEvidence(validEvidence(), { ...context, configurationFingerprint: 'd'.repeat(64) }).ok, false);
});
test('before-deploy reads the build report when no separate deploy report exists', async () => {
  for (const tag of ['v1.0.0', 'development-evidence']) {
    const api = fakeGitHub({ tag });
    const result = await verifyReleaseDevelopmentEvidence({ ...context, phase: 'before-deploy', tag, token: 'fixture-token', fetchImpl: api.fetchImpl });
    assert.equal(result.ok, true); assert.equal(result.assetId, 20);
  }
});
test('a separate deploy report takes precedence over the build report', async () => {
  const deploy = validEvidence(); deploy.e2e.phase = 'before-deploy';
  const api = fakeGitHub({ phase: 'before-deploy', evidence: deploy, extra: [{ id: 21, name: 'development-evidence.apps-in-toss.before-build.json', size: 10000 }] });
  const result = await verifyReleaseDevelopmentEvidence({ ...context, phase: 'before-deploy', tag: 'v1.0.0', token: 'fixture-token', fetchImpl: api.fetchImpl });
  assert.equal(result.assetId, 20);
});
test('the build gate never falls back to a deploy report', async () => {
  const api = fakeGitHub({ phase: 'before-deploy' });
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, phase: 'before-build', tag: 'v1.0.0', token: 'fixture-token', fetchImpl: api.fetchImpl }), /REQUIRED_DEVELOPMENT_EVIDENCE_MISSING/u);
});
test('development policy and example compile under strict JSON Schema', () => {
  const validator = new Ajv2020().compile(JSON.parse(readFileSync('contracts/development-workflow.schema.json', 'utf8')));
  const policy = parse(readFileSync('contracts/development-workflow.yaml', 'utf8'));
  assert.equal(validator(policy), true);
  const changed = structuredClone(policy); changed.design.humanApprovalRequiredBeforeImplementation = false;
  assert.equal(validator(changed), false);
  assert.equal(validateDevelopmentEvidence(JSON.parse(readFileSync('docs/agent-governance/templates/development-evidence.example.json', 'utf8')), context).ok, true);
});
test('actual CLI exits nonzero for a mismatched final candidate without printing payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'development-evidence-cli-'));
  try {
    const path = join(dir, 'evidence.json'), d = validEvidence(), now = Date.now();
    d.e2e.plannedAt = new Date(now - 60000).toISOString(); d.e2e.startedAt = new Date(now - 40000).toISOString(); d.e2e.completedAt = new Date(now - 20000).toISOString();
    d.iterations.forEach((r, i) => {
      r.plannedAt = new Date(now - (6-i) * 3600000).toISOString();
      r.startedAt = new Date(now - (6-i) * 3600000 + 1000).toISOString();
      r.completedAt = new Date(now - (6-i) * 3600000 + 2000).toISOString();
    });
    writeFileSync(path, JSON.stringify(d));
    const inventoryPath = join(dir, 'feature-inventory.json'); writeFileSync(inventoryPath, JSON.stringify(context.featureInventory));
    const args = ['scripts/release/verify-development-evidence.mjs', '--file', path, '--feature-inventory', inventoryPath, '--repo', context.repository, '--sha', SHA, '--target', context.target, '--phase', context.phase];
    const env = { ...process.env, GITHUB_ENV: '', GITHUB_OUTPUT: '' };
    const good = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(good.status, 0, good.stderr);
    args[args.indexOf('--sha')+1] = 'd'.repeat(40);
    const bad = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /CANDIDATE_MISMATCH/u); assert.doesNotMatch(bad.stderr, /fixture-token|approvalEvidence/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 이어받기 기준 SHA부터 후보까지의 변경 파일과 그 시점 기능 목록을 Release 검증과 로컬 CLI가 같은 기준으로 읽는다.
const BASE = 'e'.repeat(40);
const foundationInventory = { schemaVersion: 1, features: [
  { id: 'create', core: true }, { id: 'settings', core: false },
  { id: 'purchase', core: true, foundation: true, paths: ['src/purchase/**'] },
] };
function carriedEvidence(sourceSha = SHA, baselineSha = BASE) {
  const d = validEvidence(); d.sourceSha = sourceSha; d.e2e.sourceSha = sourceSha;
  d.iterations.forEach(round => { round.sourceSha = sourceSha; });
  d.features.push({ id: 'purchase', core: true });
  d.carriedForward = [{ featureId: 'purchase', baselineSha, verifiedAt: '2026-10-01T00:00:00Z', evidence: ['https://example.com/device-purchase'] }];
  return d;
}
function fakeCompareGitHub({ compare = { status: 'ahead', files: [{ filename: 'src/create/form.ts' }] }, baselineKnown = true } = {}) {
  const base = fakeGitHub({ evidence: carriedEvidence() });
  const fetchImpl = async url => {
    if (url.includes(`/compare/${BASE}...${SHA}`)) { base.calls.push(url); return baselineKnown ? reply(compare) : reply({ message: 'Not Found' }, 404); }
    if (url.endsWith(`feature-inventory.json?ref=${BASE}`) && !baselineKnown) { base.calls.push(url); return reply({ message: 'Not Found' }, 404); }
    if (url.includes('/contents/docs/qa/feature-inventory.json?ref=')) { base.calls.push(url); return reply({ encoding: 'base64', content: Buffer.from(JSON.stringify(foundationInventory)).toString('base64') }); }
    return base.fetchImpl(url);
  };
  return { calls: base.calls, fetchImpl };
}
const verifyCarried = api => verifyReleaseDevelopmentEvidence({ ...context, tag: 'v1.0.0', token: 'fixture-token', fetchImpl: api.fetchImpl });
test('Release verifier carries an unaffected foundation feature forward from the compared baseline', async () => {
  const api = fakeCompareGitHub();
  assert.equal((await verifyCarried(api)).ok, true);
  assert.ok(api.calls.some(url => url.includes(`/compare/${BASE}...${SHA}`)));
  assert.ok(api.calls.some(url => url.endsWith(`feature-inventory.json?ref=${BASE}`)));
  assert.ok(api.calls.some(url => url.endsWith(`/compare/${BASE}...${SHA}`)));
});
for (const [name, compare, error] of [
  ['a renamed purchase file', { status: 'ahead', files: [{ filename: 'src/billing/a.ts', previous_filename: 'src/purchase/a.ts' }] }, /CARRY_FORWARD_AFFECTED purchase/u],
  ['a baseline that is not an ancestor', { status: 'diverged', files: [] }, /CARRY_FORWARD_DIFF_UNAVAILABLE purchase/u],
  ['a truncated comparison', { status: 'ahead', files: Array.from({ length: 300 }, (_, i) => ({ filename: `src/create/${i}.ts` })) }, /CARRY_FORWARD_DIFF_UNAVAILABLE purchase/u],
]) {
  test(`Release verifier reruns the foundation feature for ${name}`, async () => {
    await assert.rejects(verifyCarried(fakeCompareGitHub({ compare })), error);
  });
}
test('Release verifier reruns the foundation feature when the baseline commit is unknown', async () => {
  await assert.rejects(verifyCarried(fakeCompareGitHub({ baselineKnown: false })), /CARRY_FORWARD_DIFF_UNAVAILABLE purchase/u);
});
test('local CLI compares the baseline with git in the product repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'development-evidence-carry-'));
  const git = (...args) => {
    const run = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); return run.stdout.trim();
  };
  const commit = (path, body) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), body); git('add', '-A'); git('commit', '-qm', path); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q');
    mkdirSync(join(dir, 'docs/qa'), { recursive: true });
    writeFileSync(join(dir, 'docs/qa/feature-inventory.json'), JSON.stringify(foundationInventory));
    const baseline = commit('src/purchase/a.ts', 'v1');
    const unaffected = commit('src/create/form.ts', 'v1');
    const affected = commit('src/purchase/a.ts', 'v2');
    git('reset', '-q', '--hard', unaffected);
    const nonAscii = commit('src/purchase/결제.ts', 'v1');
    git('reset', '-q', '--hard', unaffected);
    for (let i = 0; i < 300; i += 1) writeFileSync(join(dir, `src/create/${i}.ts`), 'v1');
    const large = commit('src/create/last.ts', 'v1');
    const run = sha => {
      const d = carriedEvidence(sha, baseline), now = Date.now();
      d.carriedForward[0].verifiedAt = new Date(now - 7200000).toISOString();
      d.e2e.plannedAt = new Date(now - 60000).toISOString(); d.e2e.startedAt = new Date(now - 40000).toISOString(); d.e2e.completedAt = new Date(now - 20000).toISOString();
      d.iterations.forEach((r, i) => {
        r.plannedAt = new Date(now - (6-i) * 3600000).toISOString();
        r.startedAt = new Date(now - (6-i) * 3600000 + 1000).toISOString();
        r.completedAt = new Date(now - (6-i) * 3600000 + 2000).toISOString();
      });
      const path = join(dir, '..', `${sha}.evidence.json`); writeFileSync(path, JSON.stringify(d));
      try {
        return spawnSync(process.execPath, [join(process.cwd(), 'scripts/release/verify-development-evidence.mjs'), '--file', path, '--repo', context.repository, '--sha', sha, '--target', context.target, '--phase', context.phase], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ENV: '', GITHUB_OUTPUT: '' } });
      } finally { rmSync(path, { force: true }); }
    };
    const good = run(unaffected);
    assert.equal(good.status, 0, good.stderr);
    for (const sha of [affected, nonAscii]) {
      const bad = run(sha);
      assert.equal(bad.status, 1); assert.match(bad.stderr, /CARRY_FORWARD_AFFECTED purchase/u);
    }
    const truncated = run(large);
    assert.equal(truncated.status, 1); assert.match(truncated.stderr, /CARRY_FORWARD_DIFF_UNAVAILABLE purchase/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
