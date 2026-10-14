import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verifyReleaseDevelopmentEvidence } from '../scripts/release/verify-development-evidence.mjs';
import { APPROVED, NOW, SHA, context, evidence, inventory, plan, run } from './helpers/test-levels-fixture.mjs';

const PLAN_PATH = 'docs/design/2026-10-14-example/test-plan.json';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const encoded = value => { const text = JSON.stringify(value); return { encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') }; };

function fakeGitHub({ document = evidence(), testPlan = plan(), assets = ['before-build'], approval = { status: 'ahead' }, planStatus = 200,
  baseline = { status: 'ahead', files: [{ filename: 'src/settings/screen.ts' }] }, baselineStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/releases/tags/')) return reply({ id: 10 });
    if (url.includes('/releases/10/assets?')) return reply(assets.map((phase, index) => ({ id: 20 + index, name: `development-evidence.google-play.${phase}.json`, size: 10000 })));
    if (/\/releases\/assets\/2\d$/u.test(url)) return reply({ ...document, assetPhase: undefined });
    if (url.includes(`/contents/docs/qa/feature-inventory.json?ref=${SHA}`)) return reply(encoded(inventory()));
    if (url.endsWith(`/compare/${APPROVED}...${SHA}`)) return reply(approval);
    if (url.endsWith(`/contents/${PLAN_PATH}?ref=${APPROVED}`)) return planStatus === 200 ? reply(encoded(testPlan)) : reply({ message: 'Not Found' }, planStatus);
    if (url.endsWith(`/compare/v1.0.0...${SHA}`)) return baselineStatus === 200 ? reply(baseline) : reply({ message: 'failure' }, baselineStatus);
    throw new Error(`Unexpected URL ${url}`);
  };
  return { calls, fetchImpl };
}
const verify = (api, changes = {}) => verifyReleaseDevelopmentEvidence({ ...context(), tag: 'v1.0.0', token: 'fixture-token', fetchImpl: api.fetchImpl, ...changes });

test('Release verifier reads the plan at the approved commit and the files changed since its baseline', async () => {
  const api = fakeGitHub();
  const result = await verify(api);
  assert.equal(result.ok, true); assert.equal(result.level, 'L1'); assert.equal(result.completedAt, '2026-10-14T05:10:00Z');
  assert.ok(api.calls.some(url => url.endsWith(`/contents/${PLAN_PATH}?ref=${APPROVED}`)));
  assert.ok(api.calls.some(url => url.endsWith(`/compare/v1.0.0...${SHA}`)));
});
for (const [name, options] of [
  ['an approval commit outside the candidate history', { approval: { status: 'diverged' } }],
  ['a plan missing at the approval commit', { planStatus: 404 }],
  ['an oversized plan', { testPlan: { ...plan(), padding: 'x'.repeat(2 * 1024 * 1024) } }],
]) {
  test(`Release verifier rejects ${name}`, async () => {
    await assert.rejects(verify(fakeGitHub(options)), /TEST_PLAN_UNAPPROVED D-1/u);
  });
}
test('Release verifier treats an unknown baseline as a full regression floor', async () => {
  await assert.rejects(verify(fakeGitHub({ baselineStatus: 404 })), /TEST_LEVEL_BELOW_FLOOR regression create dev/u);
  await assert.rejects(verify(fakeGitHub({ baseline: { status: 'diverged', files: [] } })), /TEST_LEVEL_BELOW_FLOOR regression/u);
});
test('Release verifier stops on an unreadable comparison instead of guessing', async () => {
  await assert.rejects(verify(fakeGitHub({ baselineStatus: 500 })), /HTTP 500/u);
});
test('before-release prefers its own report and falls back to the earlier phases', async () => {
  const both = await verify(fakeGitHub({ assets: ['before-build', 'before-release'] }), { phase: 'before-release' });
  assert.equal(both.assetId, 21);
  for (const assets of [['before-build'], ['before-build', 'before-deploy']]) {
    const result = await verify(fakeGitHub({ assets }), { phase: 'before-release' });
    assert.equal(result.assetId, 20 + assets.length - 1);
  }
  await assert.rejects(verify(fakeGitHub({ assets: ['before-release'] }), { phase: 'before-build' }), /REQUIRED_DEVELOPMENT_EVIDENCE_MISSING/u);
});
test('before-release fails when a build report lacks the planned device run', async () => {
  const api = fakeGitHub({ testPlan: plan({ level: 'L2', environments: ['android'] }), document: evidence({ runs: [] }) });
  assert.equal((await verify(api, { phase: 'before-build' })).ok, true);
  await assert.rejects(verify(api, { phase: 'before-release' }), /RUN_COVERAGE android settings/u);
});
test('the release phase is accepted only by the verifier phases in the contract', async () => {
  await assert.rejects(verify(fakeGitHub(), { phase: 'after-release' }), /INVALID_EVIDENCE_CONTEXT/u);
});

test('local CLI reads the approved plan and the baseline diff from the product repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-levels-cli-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const write = (path, body) => { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), body); };
  const commit = (message, files) => { for (const [path, body] of Object.entries(files)) write(path, body); git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q');
    commit('base', { 'docs/qa/feature-inventory.json': JSON.stringify(inventory()), 'src/settings/screen.ts': 'v1', 'godot/export_presets.cfg': 'a' });
    git('tag', 'v1.0.0');
    const approved = commit('design', { [PLAN_PATH]: JSON.stringify(plan()), 'docs/design/2026-10-14-example/design.md': '# d' });
    const candidate = commit('change', { 'src/settings/screen.ts': 'v2' });
    git('checkout', '-q', '-b', 'side', 'v1.0.0');
    const unapproved = commit('side design', { [PLAN_PATH]: JSON.stringify(plan()) });
    git('checkout', '-q', '-');
    const regression = commit('export', { 'godot/export_presets.cfg': 'b' });
    const cli = (sha, approvedCommit = approved, phase = 'before-release') => {
      const now = Date.now();
      const document = evidence({ sourceSha: sha, runs: [run('dev-1', 'godot-editor', ['settings'], { sourceSha: sha,
        plannedAt: new Date(now - 60000).toISOString(), startedAt: new Date(now - 40000).toISOString(), completedAt: new Date(now - 20000).toISOString() })] });
      document.designs[0].approvedCommit = approvedCommit;
      const path = join(dir, '..', `${sha}.test-levels.json`); writeFileSync(path, JSON.stringify(document));
      try {
        return spawnSync(process.execPath, [join(process.cwd(), 'scripts/release/verify-development-evidence.mjs'), '--file', path,
          '--repo', 'seorilabs/example', '--sha', sha, '--target', 'google-play', '--phase', phase],
        { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ENV: '', GITHUB_OUTPUT: '' } });
      } finally { rmSync(path, { force: true }); }
    };
    const good = cli(candidate);
    assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /\(L1\)/u);
    const side = cli(candidate, unapproved);
    assert.equal(side.status, 1); assert.match(side.stderr, /TEST_PLAN_UNAPPROVED D-1/u);
    const full = cli(regression);
    assert.equal(full.status, 1); assert.match(full.stderr, /TEST_LEVEL_BELOW_FLOOR regression create dev/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(NOW.length > 0, true);
});
