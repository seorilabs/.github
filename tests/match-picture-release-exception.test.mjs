import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { applyGodotExportVersion, applyGodotProjectVersion, createReleaseBinding, parseTagReceipt, renderTagReceipt, renderArtifactReceipt } from '../scripts/release/tag-version-authority.mjs';
import { validateHostedConfiguration, validateHostedEditorEvidence, verifyHostedExecution, bindHostedArtifact } from '../scripts/release/hosted-godot-ios-exception.mjs';

// 합성 승인과 실행 원본을 격리한 중앙 사본에만 등록한다. 제품 검수 근거가 아니다.
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'match-picture-exception-fixture-'));
for (const name of ['scripts', 'contracts']) cpSync(join(root, name), join(dir, name), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const SOURCE = 'a'.repeat(40), VERIFIER = 'b'.repeat(40), BASE = 'c'.repeat(40), FP = 'd'.repeat(64);
const ids = ['title', 'first-run-tutorial', 'matching-game', 'wrong-answer-and-hint', 'timing-and-splits',
  'record-persistence', 'language-and-sound-settings', 'back-and-exit', 'safe-area-and-awake',
  'native-leaderboards', 'interstitial-and-privacy', 'ait-share', 'analytics'];
const inventory = { schemaVersion: 1, features: ids.map((id, index) => ({ id, core: index < 9,
  ...(index === 10 ? { foundation: true, paths: ['godot/src/platform/*ads*'] } : {}) })) };
const inventoryBytes = Buffer.from(JSON.stringify(inventory));
const features = inventory.features.map(({ id, core }) => ({ id, core, originalVerdict: 'scoped Editor pass; native unverified', wholeFeatureStatus: 'partial' }));
const approvalReceipt = { kind: 'human_release_approval', objective: 'public_live', repository: 'seorilabs/match-picture-app', releaseTag: 'v1.1.7', packageName: 'com.github.magicsih.MatchSymbol', proposalSha256: 'e'.repeat(64), approvalRecordedAt: '2026-10-13T12:00:00Z', markets: ['app-store'], approvedUnverifiedRisks: ['native physical-device QA unverified'] };
const approvalBytes = Buffer.from(JSON.stringify(approvalReceipt));
const e2e = { schemaVersion: 1, sourceSha: SOURCE, target: 'app-store', configurationFingerprint: FP,
  inventorySha256: hash(inventoryBytes), startedAt: '2026-10-13T13:00:00Z', completedAt: '2026-10-13T13:10:00Z',
  editorVerdict: 'pass', productE2eStatus: 'blocked', physicalDeviceExecution: 'waived',
  features: ids.map(id => ({ id, editorStatus: id === 'ait-share' ? 'out_of_scope' : id === 'analytics' ? 'expected_disabled' : 'pass_scoped' })) };
const e2eBytes = Buffer.from(JSON.stringify(e2e));
const asset = 'release-exception.original-final-editor-e2e.json';
const observations = { baselineSourceSha: BASE, productE2eStatus: 'blocked', features,
  observations: [{ asset, sha256: hash(e2eBytes) }], finalEditorEvidenceAsset: asset };
const observationsBytes = Buffer.from(JSON.stringify(observations));
const inputs = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'seorilabs/match-picture-app',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', RUNNER_OS: 'macOS', RUNNER_ENVIRONMENT: 'github-hosted',
  GODOT_VERSION: '4.7.2', GODOT_STATUS: 'stable', PROJECT_DIR: 'godot', IOS_EXPORT_PRESET: 'iOS',
  XCODE_PROJECT_PATH: 'release-artifacts/ios/xcode/match-picture-app.xcodeproj', EXPORT_OPTIONS_PLIST: 'app-store/exportOptions.plist',
  SCRIPTS_DIR: 'tools', PREPARE_PROJECT_SCRIPT: 'tools/prepare_ios_privacy.sh', POST_IMPORT_SCRIPT: '',
  POST_EXPORT_PROJECT_SCRIPT: 'tools/finish_ios_privacy.sh', POST_EXPORT_VALIDATION_SCRIPT: 'tools/validate_ios_privacy.sh',
  SHOULD_UPLOAD: 'true', SEORI_EXCEPTION_BUNDLE_ID: 'com.github.magicsih.MatchSymbol', SEORI_EXCEPTION_SCHEME: '' };
const grant = { schemaVersion: 2, provider: 'github-actions-godot-ios', id: 'match-picture-1.1.7',
  repository: 'seorilabs/match-picture-app', releaseTag: 'v1.1.7', packageName: 'com.github.magicsih.MatchSymbol',
  approvalFile: 'match-picture-1.1.7.approval.json', observationsFile: 'match-picture-1.1.7.observations.json',
  approvedAt: '2026-10-13T12:00:00Z', approvalSha256: hash(approvalBytes), proposalSha256: 'e'.repeat(64),
  observationsSha256: hash(observationsBytes), inventorySha256: hash(inventoryBytes), configurationObservationSha256: 'f'.repeat(64),
  callerSha256: '7'.repeat(64), baselineSourceSha: BASE, targets: ['app-store'], allowedAppFiles: ['.github/workflows/deploy-app-store.yml'],
  maxAgeHours: 168, approvedRisks: ['native physical-device QA unverified'], revoked: false,
  configurationFingerprints: { 'app-store': FP },
  iosBuildProvenance: { provider: 'github-actions', workflowPath: '.github/workflows/godot-deploy-app-store.yml', buildNumberAuthority: 'release-tag' },
  executionConfiguration: { 'app-store': { expectedInputs: inputs, analyticsMode: 'disabled',
    analyticsConfigurationSha256: '1'.repeat(64), sourceFiles: {"godot/project.godot": "2222222222222222222222222222222222222222222222222222222222222222", "godot/export_presets.cfg": "2222222222222222222222222222222222222222222222222222222222222222", "godot/analytics.config.json": "2222222222222222222222222222222222222222222222222222222222222222", "platform/ios/ad_privacy/ad_privacy.mm": "2222222222222222222222222222222222222222222222222222222222222222", "tools/prepare_ios_privacy.py": "2222222222222222222222222222222222222222222222222222222222222222", "tools/prepare_ios_privacy.sh": "2222222222222222222222222222222222222222222222222222222222222222", "tools/finish_ios_privacy.py": "2222222222222222222222222222222222222222222222222222222222222222", "tools/finish_ios_privacy.sh": "2222222222222222222222222222222222222222222222222222222222222222", "tools/validate_ios_privacy.sh": "2222222222222222222222222222222222222222222222222222222222222222", "app-store/releases/1.1.7/sdk-privacy-manifests.json": "2222222222222222222222222222222222222222222222222222222222222222", "app-store/exportOptions.plist": "2222222222222222222222222222222222222222222222222222222222222222"}, consumedSettings: { 'godot/project.godot': { 'application::config/version': '"1.1.7"' }, 'godot/export_presets.cfg': { 'preset.2.options::application/version': '"1001007"' } } } } };
for (const [name, bytes] of [[grant.approvalFile, approvalBytes], [grant.observationsFile, observationsBytes],
  ['match-picture-1.1.7.json', Buffer.from(JSON.stringify(grant))]]) writeFileSync(join(dir, 'contracts/release-exceptions', name), bytes);
const contract = parse(readFileSync(join(dir, 'contracts/development-workflow.yaml'), 'utf8'));
contract.releaseExceptions.grantRegistry.push('contracts/release-exceptions/match-picture-1.1.7.json');
writeFileSync(join(dir, 'contracts/development-workflow.yaml'), stringify(contract));
after(() => rmSync(dir, { recursive: true, force: true }));
const { validateReleaseException } = await import(pathToFileURL(join(dir, 'scripts/release/verify-release-exception.mjs')));
const risks = Buffer.from('human_exception: native physical-device QA unverified');
const document = { schemaVersion: 1, kind: 'human_release_exception', state: 'active', decisionStatus: 'human_exception', productE2eStatus: 'blocked',
  id: grant.id, repository: grant.repository, releaseTag: grant.releaseTag, sourceSha: SOURCE, baselineSourceSha: BASE,
  verifierSha: VERIFIER, configurationFingerprint: FP, inventorySha256: grant.inventorySha256, productTreeSha256: '3'.repeat(64),
  approvalSha256: grant.approvalSha256, proposalSha256: grant.proposalSha256, observationsSha256: grant.observationsSha256,
  riskNotesSha256: hash(risks), approvedAt: grant.approvedAt, expiresAt: '2026-10-20T12:00:00Z', target: 'app-store',
  approvedRisks: grant.approvedRisks, features, releaseBinding: null };
const context = { exceptionId: grant.id, repository: grant.repository, tag: grant.releaseTag, sourceSha: SOURCE,
  target: 'app-store', phase: 'before-build', configurationFingerprint: FP, verifierSha: VERIFIER, now: '2026-10-13T14:00:00Z',
  verifierProof: { verified: true, revision: VERIFIER }, originalEvidence: { [asset]: e2eBytes },
  approvalBytes, inventoryBytes, riskNotesBytes: risks, productTreeVerified: true, productTreeSha256: document.productTreeSha256, preflightOnly: true };

test('reviewed one-release public Godot grant accepts all 13 original features without claiming native PASS', () => {
  const result = validateReleaseException(document, context);
  assert.equal(result.ok, true); assert.equal(result.decisionStatus, 'preflight_ready');
  assert.equal(result.productE2eStatus, 'blocked'); assert.equal(result.featureCount, 13);
  assert.deepEqual(result.features, features);
});
test('changing foundation paths cannot reuse the reviewed inventory bytes', () => {
  const changed = structuredClone(inventory); changed.features[10].paths = [];
  assert.throws(() => validateReleaseException(document, { ...context, inventoryBytes: Buffer.from(JSON.stringify(changed)) }), /RELEASE_EXCEPTION_INVENTORY_CHANGED/u);
});

test('one-release grant schema rejects another release, market, provider and unknown fields', () => {
  for (const changes of [{ releaseTag: 'v1.1.8' }, { targets: ['google-play'] }, { provider: 'local-mac' }, { waived: true }]) {
    writeFileSync(join(dir, 'contracts/release-exceptions/match-picture-1.1.7.json'), JSON.stringify({ ...grant, ...changes }));
    assert.throws(() => validateReleaseException(document, context), /RELEASE_EXCEPTION_GRANT_SCHEMA/u);
  }
  writeFileSync(join(dir, 'contracts/release-exceptions/match-picture-1.1.7.json'), JSON.stringify(grant));
});
test('Editor evidence binds the final candidate, configuration, original inventory and actual completed time', () => {
  for (const [changes, error] of [[{ sourceSha: BASE }, 'CHANGED'], [{ configurationFingerprint: '9'.repeat(64) }, 'CHANGED'],
    [{ editorVerdict: 'failed' }, 'CHANGED'], [{ physicalDeviceExecution: 'pass' }, 'CHANGED'],
    [{ completedAt: '2026-10-14T00:00:00Z' }, 'EXPIRED']]) {
    assert.throws(() => validateHostedEditorEvidence(observations, { ...context,
      originalEvidence: { [asset]: Buffer.from(JSON.stringify({ ...e2e, ...changes })) } }, grant), new RegExp(`RELEASE_EXCEPTION_EDITOR_EVIDENCE_${error}`, 'u'));
  }
  const incomplete = structuredClone(e2e); incomplete.features[2].editorStatus = 'not_run';
  assert.throws(() => validateHostedEditorEvidence(observations, { ...context,
    originalEvidence: { [asset]: Buffer.from(JSON.stringify(incomplete)) } }, grant), /RELEASE_EXCEPTION_EDITOR_FEATURE_NOT_VERIFIED/u);
});

const app = mkdtempSync(join(tmpdir(), 'match-picture-ci-input-fixture-'));
after(() => rmSync(app, { recursive: true, force: true }));
const configGrant = structuredClone(grant);
for (const path of Object.keys(configGrant.executionConfiguration['app-store'].sourceFiles)) {
  mkdirSync(join(app, path, '..'), { recursive: true });
  writeFileSync(join(app, path), path === 'godot/analytics.config.json' ? '{"measurement_id":"","api_secret":""}\n'
    : path === 'godot/project.godot' ? '[application]\nconfig/version="2.0.0"\n'
      : path === 'godot/export_presets.cfg' ? '[preset.2]\nname="iOS"\nplatform="iOS"\n\n[preset.2.options]\napplication/short_version=""\napplication/version=""\n# SDK declaration\n# SDK manifest\nprivacy/tracking_enabled=true\n' : `synthetic ${path}\n`);
  configGrant.executionConfiguration['app-store'].sourceFiles[path] = hash(readFileSync(join(app, path)));
}
configGrant.executionConfiguration['app-store'].analyticsConfigurationSha256 = hash(readFileSync(join(app, 'godot/analytics.config.json')));
mkdirSync(join(app, '.github/workflows'), { recursive: true });
writeFileSync(join(app, '.github/workflows/deploy-app-store.yml'), 'synthetic fixed caller');
configGrant.callerSha256 = hash(readFileSync(join(app, '.github/workflows/deploy-app-store.yml')));
const git = args => execFileSync('git', ['-C', app, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
git(['init']); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
const realSha = git(['rev-parse', 'HEAD']).toString().trim();
const ciBinding = createReleaseBinding({ tag: grant.releaseTag, sourceSha: realSha, configRevision: '4'.repeat(64), authorityRevision: '5'.repeat(64), androidVersionCode: 22, androidVersionCodeSource: 'github-ledger' });
const ciBindingPath = join(dir, 'ci-binding.json'); writeFileSync(ciBindingPath, JSON.stringify(ciBinding));
const ciEnv = { ...inputs, SEORI_ANALYTICS_SECRET_PRESENT: 'false', GITHUB_SHA: realSha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const ciOptions = { ...context, sourceSha: realSha, appRepository: app, env: ciEnv, preflightOnly: false };
test('before-build binds the disabled analytics file and real clean candidate without requiring an artifact', () => {
  const result = validateHostedConfiguration(ciOptions, configGrant);
  assert.equal(result.analyticsMode, 'disabled'); assert.equal(result.consumedSettings, null);
  assert.equal(result.analyticsConfigurationSha256, configGrant.executionConfiguration['app-store'].analyticsConfigurationSha256);
});
test('actual input, candidate, registered analytics and native source changes fail before build', () => {
  for (const env of [{ ...ciEnv, SHOULD_UPLOAD: 'false' }, { ...ciEnv, GITHUB_SHA: SOURCE },
    { ...ciEnv, SEORI_ANALYTICS_SECRET_PRESENT: 'true' }]) {
    assert.throws(() => validateHostedConfiguration({ ...ciOptions, env }, configGrant), /RELEASE_EXCEPTION_(EXECUTION_INPUTS|REGISTERED_CONFIG)_CHANGED/u);
  }
  const path = join(app, 'platform/ios/ad_privacy/ad_privacy.mm'), original = readFileSync(path);
  writeFileSync(path, 'changed native bridge');
  assert.throws(() => validateHostedConfiguration(ciOptions, configGrant), /RELEASE_EXCEPTION_EXECUTION_SOURCE_CHANGED/u);
  writeFileSync(path, original);
});
test('actual hosted run, reusable bytes and macOS job are fetched without new Actions token permission', async () => {
  const workflowSha = '9'.repeat(40), workflowPath = '.github/workflows/godot-deploy-app-store.yml';
  const workflow = readFileSync(join(root, workflowPath));
  const run = { id: 123, run_attempt: 1, head_sha: realSha, head_repository: { full_name: grant.repository },
    event: 'workflow_dispatch', path: '.github/workflows/deploy-app-store.yml@main', head_branch: 'main', status: 'in_progress',
    referenced_workflows: [{ path: `seorilabs/.github/${workflowPath}@main`, sha: workflowSha }] };
  const job = { id: 456, name: 'app-store / Godot signed iOS archive', status: 'in_progress', runner_group_name: 'GitHub Actions', labels: ['macos-26'] };
  const request = (runChanges = {}, jobChanges = {}, remoteBytes = workflow) => ({ token: 'fixture-token', fetchImpl: async (url, options) => {
    let value;
    if (String(url).includes('/actions/')) {
      assert.equal(options.headers.authorization, undefined);
      value = String(url).includes('/jobs?') ? { jobs: [{ ...job, ...jobChanges }], total_count: 1 } : { ...run, ...runChanges };
    } else if (String(url).includes('/compare/')) value = { status: 'ahead', base_commit: { sha: workflowSha } };
    else value = { type: 'file', encoding: 'base64', content: remoteBytes.toString('base64') };
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  } });
  const result = await verifyHostedExecution(ciOptions, configGrant, request());
  assert.equal(result.hostedExecution.jobId, 456);
  assert.equal(result.hostedExecution.actualReusableWorkflowBytesVerified, true);
  await assert.rejects(verifyHostedExecution(ciOptions, configGrant, request({ head_sha: SOURCE })), /RELEASE_EXCEPTION_HOSTED_RUN_CHANGED/u);
  await assert.rejects(verifyHostedExecution(ciOptions, configGrant, request({}, { labels: ['self-hosted', 'macos-26'] })), /RELEASE_EXCEPTION_HOSTED_JOB_CHANGED/u);
  await assert.rejects(verifyHostedExecution(ciOptions, configGrant, request({ referenced_workflows: [{ path: `seorilabs/.github/${workflowPath}@unreviewed`, sha: workflowSha }] })), /RELEASE_EXCEPTION_HOSTED_WORKFLOW_CHANGED/u);
  await assert.rejects(verifyHostedExecution(ciOptions, configGrant, request({}, {}, Buffer.from('changed workflow'))), /RELEASE_EXCEPTION_HOSTED_WORKFLOW_CHANGED/u);
});
test('anonymous API failure remains closed and identifies rate limiting without exposing a token', async () => {
  const request = { token: 'fixture-token', fetchImpl: async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) };
  await assert.rejects(verifyHostedExecution(ciOptions, configGrant, request), /RELEASE_EXCEPTION_HOSTED_API_RATE_LIMITED HTTP_403/u);
});
test('rate-limit failure preserves the recovery headers and performs no retry or authenticated fallback', async () => {
  let calls = 0;
  const request = { token: 'private-fixture-token', fetchImpl: async (_, options) => {
    calls += 1;
    assert.equal(options.headers.authorization, undefined);
    return new Response('private-response-body', { status: 403, headers: {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791908400', 'retry-after': '120',
    } });
  } };
  await assert.rejects(verifyHostedExecution(ciOptions, configGrant, request), error => {
    assert.match(error.message, /HTTP_403 remaining=0 resetEpoch=1791908400 retryAfterSeconds=120/u);
    assert.doesNotMatch(error.message, /private-fixture-token|private-response-body/u);
    return true;
  });
  assert.equal(calls, 1);
});
test('rate-limit diagnostics redact nonnumeric and excessive header values', async () => {
  const request = { token: 'private-fixture-token', fetchImpl: async () => new Response('', { status: 429, headers: {
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '999999999999999', 'retry-after': 'private-fixture-token',
  } }) };
  await assert.rejects(verifyHostedExecution(ciOptions, configGrant, request), error => {
    assert.match(error.message, /HTTP_429 remaining=0 resetEpoch=unknown retryAfterSeconds=unknown/u);
    assert.doesNotMatch(error.message, /999999999999999|private-fixture-token/u);
    return true;
  });
});
test('before-deploy checks actually consumed version settings and does not permit another source edit', () => {
  const project = join(app, 'godot/project.godot'), presets = join(app, 'godot/export_presets.cfg');
  const originalProject = readFileSync(project), originalPresets = readFileSync(presets);
  try {
    writeFileSync(project, applyGodotProjectVersion(originalProject.toString(), { binding: ciBinding }));
    writeFileSync(presets, applyGodotExportVersion(originalPresets.toString(), { platform: 'iOS', preset: 'iOS', binding: ciBinding, canonicalizeComments: true }));
    assert.ok(validateHostedConfiguration({ ...ciOptions, phase: 'before-deploy', releaseBindingFile: ciBindingPath }, configGrant).consumedSettings);
    writeFileSync(project, readFileSync(project, 'utf8') + '\n[admob]\nunauthorized=true\n');
    assert.throws(() => validateHostedConfiguration({ ...ciOptions, phase: 'before-deploy', releaseBindingFile: ciBindingPath }, configGrant), /RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED/u);
    writeFileSync(project, applyGodotProjectVersion(originalProject.toString(), { binding: ciBinding }));
    writeFileSync(presets, '[preset.2.options]\napplication/version="1001006"\n');
    assert.throws(() => validateHostedConfiguration({ ...ciOptions, phase: 'before-deploy', releaseBindingFile: ciBindingPath }, configGrant), /RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED/u);
  } finally { writeFileSync(project, originalProject); writeFileSync(presets, originalPresets); }
});
test('before-deploy accepts only exact comment-canonicalized bytes and rejects original broken syntax or changed settings', () => {
  const project = join(app, 'godot/project.godot'), presets = join(app, 'godot/export_presets.cfg');
  const originalProject = readFileSync(project), originalPresets = readFileSync(presets);
  const options = { ...ciOptions, phase: 'before-deploy', releaseBindingFile: ciBindingPath };
  try {
    writeFileSync(project, applyGodotProjectVersion(originalProject.toString(), { binding: ciBinding }));
    const versioned = applyGodotExportVersion(originalPresets.toString(), { platform: 'iOS', preset: 'iOS', binding: ciBinding });
    const normalized = versioned.replace(/^([ \t]*)#/gmu, '$1;');
    writeFileSync(presets, normalized);
    assert.ok(validateHostedConfiguration(options, configGrant).consumedSettings);
    for (const changed of [versioned, normalized.replace('privacy/tracking_enabled=true', 'privacy/tracking_enabled=false'), normalized + '; extra line\n']) {
      writeFileSync(presets, changed);
      assert.throws(() => validateHostedConfiguration(options, configGrant), /RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED/u);
    }
  } finally { writeFileSync(project, originalProject); writeFileSync(presets, originalPresets); }
});
test('modified caller and untracked project override cannot reuse the exception', () => {
  const caller = join(app, '.github/workflows/deploy-app-store.yml'), original = readFileSync(caller);
  try {
    writeFileSync(caller, 'changed reusable ref');
    assert.throws(() => validateHostedConfiguration(ciOptions, configGrant), /RELEASE_EXCEPTION_APP_CALLER_CHANGED/u);
  } finally { writeFileSync(caller, original); }
  const override = join(app, 'godot/override.cfg');
  try {
    writeFileSync(override, '[admob]\nunauthorized=true\n');
    assert.throws(() => validateHostedConfiguration(ciOptions, configGrant), /RELEASE_EXCEPTION_EXECUTION_SOURCE_CHANGED/u);
  } finally { rmSync(override); }
});
test('before-deploy requires the actual artifact, official binding and archive receipt', () => {
  assert.throws(() => bindHostedArtifact(ciOptions, configGrant, {}), /RELEASE_EXCEPTION_ARTIFACT_REQUIRED/u);
});
test('signed-app version and actual JSON digest must match the official archive receipt', () => {
  const archive = join(app, 'fixture.xcarchive'), plist = join(archive, 'Products/Applications/fixture.app/Info.plist');
  mkdirSync(join(plist, '..'), { recursive: true }); writeFileSync(plist, 'synthetic signed plist');
  const binding = createReleaseBinding({ tag: grant.releaseTag, sourceSha: realSha, configRevision: '4'.repeat(64),
    authorityRevision: '5'.repeat(64), androidVersionCode: 22, androidVersionCodeSource: 'github-ledger' });
  const receipt = parseTagReceipt(renderTagReceipt(binding));
  const bindingPath = join(app, 'binding.json'), artifactReceipt = join(app, 'artifact.txt');
  writeFileSync(bindingPath, JSON.stringify(binding));
  let metadata = Buffer.from(JSON.stringify({ CFBundleIdentifier: grant.packageName, CFBundleShortVersionString: '1.1.7', CFBundleVersion: '1001007' })+'\n');
  writeFileSync(artifactReceipt, renderArtifactReceipt({ binding, kind: 'xcode-archive', artifactDigest: hash(metadata) }));
  const original = childProcess.execFileSync, commands = [];
  childProcess.execFileSync = (file, args) => { commands.push(file); if (file === '/usr/bin/codesign') return Buffer.alloc(0); if (file === '/usr/bin/plutil') return metadata; throw new Error('Unexpected external tool'); };
  syncBuiltinESMExports();
  try {
    const options = { ...ciOptions, artifactFile: plist, releaseBindingFile: bindingPath, artifactReceiptFile: artifactReceipt, env: { ...ciEnv, ARCHIVE_PATH: archive } };
    assert.equal(bindHostedArtifact(options, configGrant, receipt).signatureIntegrityVerified, true);
    assert.deepEqual(commands, ['/usr/bin/codesign', '/usr/bin/plutil']);
    metadata = Buffer.from(JSON.stringify({ CFBundleIdentifier: grant.packageName, CFBundleShortVersionString: '1.1.7', CFBundleVersion: '1001006' }));
    assert.throws(() => bindHostedArtifact(options, configGrant, receipt), /RELEASE_EXCEPTION_ARTIFACT_VERSION_CHANGED/u);
    metadata = Buffer.from(JSON.stringify({ CFBundleIdentifier: grant.packageName, CFBundleShortVersionString: '1.1.7', CFBundleVersion: '1001007', Changed: true }));
    assert.throws(() => bindHostedArtifact(options, configGrant, receipt), /artifact receipt/u);
  } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
});

test('approval receipt content must match the grant even when the new bytes hash is declared', () => {
  const path = join(dir, 'contracts/release-exceptions', grant.approvalFile);
  const grantPath = join(dir, 'contracts/release-exceptions/match-picture-1.1.7.json');
  try {
    const changed = Buffer.from(JSON.stringify({ ...approvalReceipt, releaseTag: 'v1.1.8' }));
    writeFileSync(path, changed); writeFileSync(grantPath, JSON.stringify({ ...grant, approvalSha256: hash(changed) }));
    assert.throws(() => validateReleaseException(document, context), /RELEASE_EXCEPTION_APPROVAL_SCOPE_CHANGED/u);
  } finally { writeFileSync(path, approvalBytes); writeFileSync(grantPath, JSON.stringify(grant)); }
});
