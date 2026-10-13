import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { createPromotionEvidence, verifyPromotionEvidence } from '../scripts/release/release-promotion-evidence.mjs';
import { createReleaseBinding, renderArtifactReceipt } from '../scripts/release/tag-version-authority.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = 'a'.repeat(40), pin = 'b'.repeat(40), workflowSha = 'c'.repeat(40);
const grant = JSON.parse(readFileSync('contracts/release-exceptions/reascend-1.1.0.json'));
const common = { ok: true, decisionStatus: 'human_exception', productE2eStatus: 'blocked', repository: grant.repository,
  sourceSha: source, target: 'google-play', releaseTag: 'v1.1.0', verifierSha: pin, exceptionId: grant.id,
  configurationFingerprint: grant.configurationFingerprints['google-play'], features: [{ id: 'fixture', status: 'blocked' }],
  verifierProof: { verified: true, revision: pin, files: [{ path: 'static-verifier-fixture', sha256: '7'.repeat(64) }] },
  approvalSha256: grant.approvalSha256, observationsSha256: grant.observationsSha256, productTreeSha256: 'd'.repeat(64),
  approvedAt: grant.approvedAt, expiresAt: new Date(Date.parse(grant.approvedAt) + 168 * 3600000).toISOString(),
  releaseBinding: { tagObjectSha: 'e'.repeat(40), tagReceiptSha256: 'f'.repeat(64) } };
const expected = grant.executionConfiguration['google-play'];
const execution = { inputs: expected.expectedInputs, registeredClientConfigurationSha256: expected.registeredClientConfigurationSha256,
  runtimeConfigurationSha256: expected.runtimeConfigurationSha256, generatorSha256: expected.generatorSha256,
  buildEnvironmentSha256: expected.buildEnvironmentSha256, admobInputSha256: expected.admobInputSha256,
  injectedConfiguration: { projectSha256: expected.injectedProjectSha256, adUnitsSha256: expected.injectedAdUnitsSha256 } };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-static-fixture-'));
  const aab = Buffer.from('synthetic AAB bytes: no build or real purchase');
  const binding = createReleaseBinding({ tag: 'v1.1.0', sourceSha: source, androidVersionCode: 21,
    configRevision: '8'.repeat(64), authorityRevision: '9'.repeat(64), androidVersionCodeSource: 'github-ledger' });
  const receipt = { authority: 'release-version-authority-v1', authorityRevision: binding.authorityRevision, tag: binding.tag,
    sourceSha: source, versionName: binding.versionName, androidVersionCode: '21', androidVersionCodeSource: 'github-ledger', appleBuildNumber: '1001000' };
  const files = { 'app.aab': aab, 'release-binding.json': Buffer.from(JSON.stringify(binding)),
    'release-artifact-receipt.txt': Buffer.from(renderArtifactReceipt({ binding, kind: 'android-app-bundle', artifactDigest: hash(aab) })),
    'before-build.json': Buffer.from(JSON.stringify({ ...common, phase: 'before-build', scope: 'actual-ci-phase', actualCiVerification: 'verified',
      verifiedAt: '2026-10-13T00:10:00Z', executionConfiguration: { ...execution, kind: 'generated-from-ci-input', injectedConfiguration: null }, artifact: null })),
    'before-deploy.json': Buffer.from(JSON.stringify({ ...common, phase: 'before-deploy', scope: 'actual-ci-phase', actualCiVerification: 'verified',
      verifiedAt: '2026-10-13T00:11:00Z', executionConfiguration: { ...execution, kind: 'actual-runtime-file' },
      artifact: { kind: 'android-app-bundle', sha256: hash(aab), versionName: '1.1.0', androidVersionCode: 21 } })) };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  const options = { env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: grant.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' },
    directory: dir, outputFile: join(dir, 'promotion-evidence.zip') };
  const bundle = createPromotionEvidence(options);
  const run = { id: 123, run_attempt: 2, status: 'completed', conclusion: 'success', head_sha: source,
    event: 'workflow_dispatch', path: '.github/workflows/deploy-google-play.yml', repository: { full_name: grant.repository },
    head_repository: { full_name: grant.repository }, run_started_at: '2026-10-13T00:09:00Z', updated_at: '2026-10-13T00:14:00Z',
    referenced_workflows: [{ path: 'seorilabs/.github/.github/workflows/godot-deploy-google-play.yml@refs/heads/main', sha: workflowSha }] };
  const job = { id: 456, run_id: 123, run_attempt: 2, head_sha: source, status: 'completed', conclusion: 'success',
    steps: ['Verify Editor E2E before-build', 'Verify Editor E2E before-deploy', 'Upload to Google Play', 'Package promotion evidence', 'Preserve promotion evidence bundle'].map(name => ({ name, conclusion: 'success' })) };
  const workflowBytes = readFileSync('.github/workflows/godot-deploy-google-play.yml');
  const calls = [];
  const state = { run, job, log: `2026-10-13T00:12:00.000Z ${bundle.logLine}\n`, track: { track: 'internal', releases: [{ status: 'completed', versionCodes: ['21'] }] }, workflowBytes };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, authorization: init.headers.authorization });
    const reply = payload => new Response(JSON.stringify(payload));
    if (url.endsWith('/actions/runs/123/attempts/2')) return reply(state.run);
    if (url.includes('/attempts/2/jobs?')) return reply({ jobs: [state.job] });
    if (url.endsWith('/actions/jobs/456/logs')) return new Response(state.log);
    if (url.includes(`/compare/${workflowSha}...main`)) return reply({ status: 'ahead', base_commit: { sha: workflowSha } });
    if (url.includes('/contents/.github/workflows/godot-deploy-google-play.yml?ref=')) return reply({ type: 'file', encoding: 'base64', content: state.workflowBytes.toString('base64') });
    if (url.endsWith('/edits/read-edit/tracks/internal')) return reply(state.track);
    throw new Error('Unexpected fixture request');
  };
  const verify = changes => verifyPromotionEvidence({ ...common, now: '2026-10-13T00:15:00Z', env: { GOOGLE_PLAY_ACCESS_TOKEN: 'fixture-secret', GOOGLE_PLAY_READ_EDIT_ID: 'read-edit' },
    token: 'github-fixture', ciRunId: '123', ciRunAttempt: '2', evidenceBundleFile: options.outputFile,
    fetchImpl, ...changes }, grant, common, receipt);
  return { dir, files, bundle, state, calls, verify, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('pin merged ancestry is checked inline before any pinned checkout or code runs', () => {
  const text = readFileSync('.github/workflows/godot-deploy-google-play.yml', 'utf8');
  const precheck = text.slice(text.indexOf('- name: Validate release exception verifier pin'), text.indexOf('- name: Checkout release version authority'));
  assert.match(precheck, /api\.github\.com\/repos\/seorilabs\/\.github\/compare/u);
  assert.match(precheck, /base_commit\?\.sha/u);
  assert.match(precheck, /ahead.*identical/u);
  assert.doesNotMatch(precheck, /\.seorilabs-release-authority\/scripts/u);
});
for (const [label, status, base, http, accepted] of [
  ['merged ancestor', 'ahead', pin, 200, true], ['same main', 'identical', pin, 200, true],
  ['unmerged pin', 'behind', pin, 200, false], ['diverged pin', 'diverged', pin, 200, false],
  ['wrong base SHA', 'ahead', source, 200, false], ['failed API', 'ahead', pin, 403, false],
]) test(`inline pin precheck executes and ${accepted ? 'accepts' : 'rejects'} ${label}`, () => {
  const workflow = parse(readFileSync('.github/workflows/godot-deploy-google-play.yml', 'utf8'));
  const job = Object.values(workflow.jobs).find(item => item.steps?.some(step => step.name === 'Validate release exception verifier pin'));
  const code = /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/u.exec(job.steps.find(step => step.name === 'Validate release exception verifier pin').run)[1];
  const mock = `globalThis.fetch=async(url,options)=>{if(url!==${JSON.stringify(`https://api.github.com/repos/seorilabs/.github/compare/${pin}...main`)}||options.headers.authorization!=='Bearer fixture-token')throw Error('fixture wrong request');return new Response(JSON.stringify(${JSON.stringify({ status, base_commit: { sha: base } })}),{status:${http}})};\n`;
  const execute = () => execFileSync('node', ['--input-type=module'], { input: mock + code, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, RELEASE_VERIFIER_SHA: pin, GH_TOKEN: 'fixture-token' } });
  if (accepted) assert.doesNotThrow(execute);
  else assert.throws(execute, error => error.stderr.toString().includes('RELEASE_EXCEPTION_VERIFIER_NOT_REVIEWED_ON_MAIN'));
});
test('promotion reuses exact successful CI bytes after artifact expiry and separates workflow SHA from verifier pin', async () => {
  const f = fixture(); try {
    const result = await f.verify();
    assert.equal(result.scope, 'promotion-recheck'); assert.equal(result.actualCiVerification, 'reused-successful-ci');
    assert.equal(result.ciProof.workflowSha, workflowSha); assert.equal(result.ciProof.verifierSha, pin);
    assert.equal(result.playTrack.track, 'internal'); assert.equal(result.artifact.sha256, hash(f.files['app.aab']));
    assert.ok(f.calls.every(call => call.method === 'GET'));
    assert.equal(f.calls.filter(call => call.url.includes('androidpublisher'))[0].authorization, 'Bearer fixture-secret');
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|read-edit/u);
  } finally { f.cleanup(); }
});
for (const [label, mutate, code] of [
  ['failed run', f => { f.state.run.conclusion = 'failure'; }, 'RELEASE_PROMOTION_CI_RUN_UNVERIFIED'],
  ['different candidate', f => { f.state.run.head_sha = '9'.repeat(40); }, 'RELEASE_PROMOTION_CI_RUN_UNVERIFIED'],
  ['different attempt', f => { f.state.run.run_attempt = 1; }, 'RELEASE_PROMOTION_CI_RUN_UNVERIFIED'],
  ['changed workflow code', f => { f.state.workflowBytes = Buffer.from('unreviewed workflow'); }, 'RELEASE_PROMOTION_WORKFLOW_CHANGED'],
  ['missing upload', f => { f.state.job.steps[2].conclusion = 'skipped'; }, 'RELEASE_PROMOTION_CI_JOB_UNVERIFIED'],
  ['missing independent log', f => { f.state.log = ''; }, 'RELEASE_PROMOTION_LOG_PROOF_MISSING'],
  ['duplicate log proof', f => { f.state.log += f.state.log; }, 'RELEASE_PROMOTION_LOG_PROOF_MISSING'],
  ['different ZIP', f => { writeFileSync(join(f.dir, 'promotion-evidence.zip'), 'modified zip'); }, 'RELEASE_PROMOTION_BUNDLE_CHANGED'],
  ['missing internal version', f => { f.state.track.releases[0].versionCodes = ['20']; }, 'RELEASE_PROMOTION_PLAY_INTERNAL_UNVERIFIED'],
]) test(`promotion rejects ${label} without performing writes`, async () => {
  const f = fixture(); try { mutate(f); await assert.rejects(f.verify(), { message: code }); assert.ok(f.calls.every(call => call.method === 'GET')); }
  finally { f.cleanup(); }
});
test('promotion requires env-only existing read identity and forbids claiming actual CI locally', async () => {
  const f = fixture(); try {
    await assert.rejects(f.verify({ env: { GITHUB_ACTIONS: 'true' } }), { message: 'RELEASE_PROMOTION_FORBIDDEN_IN_CI' });
    await assert.rejects(f.verify({ env: {} }), { message: 'RELEASE_PROMOTION_PLAY_READ_IDENTITY_REQUIRED' });
  } finally { f.cleanup(); }
});
test('anchored provider bytes still cannot hide changed CI configuration or original feature verdicts', async () => {
  for (const [field, code] of [['configuration', 'RELEASE_PROMOTION_CI_CONFIGURATION_CHANGED'], ['features', 'RELEASE_PROMOTION_CI_REPORT_UNVERIFIED'],
    ['verifierProof', 'RELEASE_PROMOTION_CI_REPORT_UNVERIFIED']]) {
    const f = fixture(); try {
      const report = JSON.parse(f.files['before-deploy.json']);
      if (field === 'features') report.features[0].status = 'passed';
      else if (field === 'verifierProof') report.verifierProof.files[0].sha256 = '0'.repeat(64);
      else report.executionConfiguration.injectedConfiguration.projectSha256 = '0'.repeat(64);
      writeFileSync(join(f.dir, 'before-deploy.json'), JSON.stringify(report));
      const next = createPromotionEvidence({ directory: f.dir, outputFile: join(f.dir, 'promotion-evidence.zip'),
        env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: grant.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' } });
      f.state.log = next.logLine;
      await assert.rejects(f.verify(), { message: code });
    } finally { f.cleanup(); }
  }
});
