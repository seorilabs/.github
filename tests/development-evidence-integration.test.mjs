import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
