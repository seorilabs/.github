import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateIosArtifact } from '../scripts/release/verify-release-exception.mjs';
import { createReleaseBinding, deriveTagEncodedVersionCode, parseTagReceipt, renderArtifactReceipt } from '../scripts/release/tag-version-authority.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const grant = JSON.parse(read('contracts/release-exceptions/reascend-1.1.0.json'));
const approval = read(`contracts/release-exceptions/${grant.approvalFile}`);
const observations = JSON.parse(read(`contracts/release-exceptions/${grant.observationsFile}`));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const MARKET_FINGERPRINTS = { 'google-play': '1c49738b0436c1eb5228b45a4c4454b812dac20c865df739d92a779498e8f64e',
  'app-store': '72db3911a1f8fae95ce9339908900741e2fd63ff9f17e4889eaac5d00f249cbe' };
const appRepository = mkdtempSync(join(tmpdir(), 'release-config-input-fixture-'));
mkdirSync(join(appRepository, 'scripts/release'), { recursive: true }); mkdirSync(join(appRepository, 'config')); mkdirSync(join(appRepository, 'data'));
const registeredConfig = Buffer.from('{"fixture":"registered-config"}\n');
const injectedProject = Buffer.from('fixture injected project'), injectedUnits = Buffer.from('fixture injected ad units');
writeFileSync(join(appRepository, 'project.godot'), injectedProject); writeFileSync(join(appRepository, 'data/ad_units.json'), injectedUnits);
const runtimeBytes = Buffer.from('{"appVersion":"1.1.0","fixture":"runtime"}\n');
const generatorBytes = Buffer.from(`import argparse,pathlib\np=argparse.ArgumentParser()\np.add_argument('--platform');p.add_argument('--firebase-config');p.add_argument('--out');p.add_argument('--app-version');p.add_argument('--analytics-enabled',action='store_true')\na=p.parse_args();pathlib.Path(a.out).write_bytes(b'{"appVersion":"1.1.0","fixture":"runtime"}\\n')\n`);
const buildEnvironment = Buffer.from('GODOT_VERSION=4.7.2\nGODOT_STATUS=stable\n');
writeFileSync(join(appRepository, 'scripts/release/generate_runtime_config.py'), generatorBytes);
writeFileSync(join(appRepository, 'build.env'), buildEnvironment);
writeFileSync(join(appRepository, 'config/android_runtime.json'), runtimeBytes);
writeFileSync(join(appRepository, 'google-services.json'), registeredConfig);
const executionEnv = { GITHUB_ACTIONS: 'true', GODOT_VERSION: '4.7.2', GODOT_STATUS: 'stable', PROJECT_DIR: '.', ANDROID_EXPORT_PRESET: 'Android',
  SCRIPTS_DIR: 'tools', BUILD_SCRIPT: '', PREPARE_PROJECT_SCRIPT: 'scripts/release/prepare_android_release.sh',
  POST_EXPORT_VALIDATION_SCRIPT: 'scripts/release/audit_android_aab.sh', SHOULD_UPLOAD: 'true',
  SEORI_EXCEPTION_PACKAGE_NAME: 'com.seorilabs.reascend', SEORI_EXCEPTION_TRACK: 'internal', SEORI_EXCEPTION_RELEASE_STATUS: 'completed',
  FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64: registeredConfig.toString('base64'), PROJECT_R_ANALYTICS_ENABLED: 'true', ADMOB_REQUIRE_PRODUCTION: '1', ADMOB_APP_ID: 'fixture-app',
  ADMOB_ANDROID_OFFLINE_REWARD_BOOST_REWARDED_AD_UNIT_ID: 'fixture-offline', ADMOB_ANDROID_MATERIAL_BOX_FREE_REWARDED_AD_UNIT_ID: 'fixture-material',
  ADMOB_ANDROID_DAILY_SUPPLY_EXTRA_REWARDED_AD_UNIT_ID: 'fixture-supply' };
const iosExecutionEnv = { CI_XCODE_CLOUD: 'TRUE', CI_TAG: 'v1.1.0', CI_XCODE_SCHEME: 'reascend-ios-project',
  CI_PROJECT_FILE_PATH: join(appRepository, 'xcode-cloud/reascend-ios-project.xcodeproj'), CI_BUNDLE_ID: grant.packageName,
  FIREBASE_IOS_GOOGLE_SERVICE_INFO_PLIST_BASE64: registeredConfig.toString('base64'), ADMOB_REQUIRE_PRODUCTION: '1',
  ADMOB_IOS_APP_ID: 'fixture-ios-app', ADMOB_IOS_OFFLINE_REWARD_BOOST_REWARDED_AD_UNIT_ID: 'fixture-ios-offline',
  ADMOB_IOS_MATERIAL_BOX_FREE_REWARDED_AD_UNIT_ID: 'fixture-ios-material', ADMOB_IOS_DAILY_SUPPLY_EXTRA_REWARDED_AD_UNIT_ID: 'fixture-ios-supply' };
writeFileSync(join(appRepository, 'GoogleService-Info.plist'), registeredConfig);
writeFileSync(join(appRepository, 'config/ios_runtime.json'), runtimeBytes);
for (const [market, env, keys] of [
  ['google-play', executionEnv, ['ADMOB_REQUIRE_PRODUCTION', 'ADMOB_APP_ID', 'ADMOB_ANDROID_OFFLINE_REWARD_BOOST_REWARDED_AD_UNIT_ID', 'ADMOB_ANDROID_MATERIAL_BOX_FREE_REWARDED_AD_UNIT_ID', 'ADMOB_ANDROID_DAILY_SUPPLY_EXTRA_REWARDED_AD_UNIT_ID']],
  ['app-store', iosExecutionEnv, ['ADMOB_REQUIRE_PRODUCTION', 'ADMOB_IOS_APP_ID', 'ADMOB_IOS_OFFLINE_REWARD_BOOST_REWARDED_AD_UNIT_ID', 'ADMOB_IOS_MATERIAL_BOX_FREE_REWARDED_AD_UNIT_ID', 'ADMOB_IOS_DAILY_SUPPLY_EXTRA_REWARDED_AD_UNIT_ID']],
]) {
  const expected = grant.executionConfiguration[market]; expected.registeredClientConfigurationSha256 = digest(registeredConfig);
  expected.runtimeConfigurationSha256 = digest(runtimeBytes); expected.generatorSha256 = digest(generatorBytes);
  expected.buildEnvironmentSha256 = digest(buildEnvironment);
  expected.admobInputSha256 = digest(JSON.stringify(Object.fromEntries(keys.sort().map(key => [key, env[key]]))));
  expected.injectedProjectSha256 = digest(injectedProject); expected.injectedAdUnitsSha256 = digest(injectedUnits);
}
// 실제 비공개 검수 보고서에는 사용자 경로가 있다. 공개 테스트는 격리한 검증기 사본에
// 합성 원본의 검토된 해시를 고정한다. 제품 근거를 만들거나 runtime 우회 입력을 추가하지 않는다.
const originals = {
  'release-exception.original-ui-review-8.md': Buffer.from('original UI review fixture: partial/unknown/blocked\n'),
  'release-exception.original-final-e2e-result.json': Buffer.from('{"productE2eStatus":"blocked","fixture":true}\n'),
};
for (const item of observations.observations) item.sha256 = digest(originals[item.asset]);
const observationsBytes = Buffer.from(`${JSON.stringify(observations, null, 2)}\n`);
grant.observationsSha256 = digest(observationsBytes);
const sandbox = mkdtempSync(join(tmpdir(), 'release-exception-reviewed-fixture-'));
const repo = fileURLToPath(new URL('../', import.meta.url));
for (const dir of ['scripts', 'contracts']) cpSync(join(repo, dir), join(sandbox, dir), { recursive: true });
mkdirSync(join(sandbox, '.github/workflows'), { recursive: true });
cpSync(join(repo, '.github/workflows/godot-deploy-google-play.yml'), join(sandbox, '.github/workflows/godot-deploy-google-play.yml'));
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}\n');
cpSync(join(repo, 'package.json'), join(sandbox, 'package.json'));
cpSync(join(repo, 'package-lock.json'), join(sandbox, 'package-lock.json'));
symlinkSync(join(repo, 'node_modules'), join(sandbox, 'node_modules'), 'dir');
writeFileSync(join(sandbox, `contracts/release-exceptions/${grant.observationsFile}`), observationsBytes);
writeFileSync(join(sandbox, 'contracts/release-exceptions/reascend-1.1.0.json'), JSON.stringify(grant));
after(() => { rmSync(sandbox, { recursive: true, force: true }); rmSync(appRepository, { recursive: true, force: true }); });
const { verifyXcodeLaunchRequest, verifyGooglePlayPromotion } = await import(pathToFileURL(join(sandbox, 'scripts/release/verify-release-exception.mjs')));
const { createPromotionEvidence } = await import(pathToFileURL(join(sandbox, 'scripts/release/release-promotion-evidence.mjs')));
const { verifyReleaseDevelopmentEvidence } = await import(pathToFileURL(join(sandbox, 'scripts/release/verify-development-evidence.mjs')));
const SOURCE = 'a'.repeat(40), VERIFIER = 'b'.repeat(40), TAG_OBJECT = 'c'.repeat(40), TREE = 'd'.repeat(40);
const inventoryBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, features: observations.features.map(({ id, core }) => ({ id, core })) }, null, 2)}\n`);
const receipt = `seori-release-binding: 1\nauthority: release-version-authority-v1\nauthority-revision: ${digest(read('contracts/release-version-authority.yaml'))}\ntag: v1.1.0\nsource-sha: ${SOURCE}\nversion-name: 1.1.0\nandroid-version-code: 21\nandroid-version-code-source: github-ledger\napple-build-number: 1001000\n`;
const productTree = [{ path: 'project.godot', type: 'blob', mode: '100644', sha: 'e'.repeat(40) }, { path: 'docs/qa/feature-inventory.json', type: 'blob', mode: '100644', sha: 'f'.repeat(40) }];
const productTreeHash = digest(JSON.stringify([...productTree].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
const riskNotes = Buffer.from('human_exception\nE2E blocked\n' + grant.approvedRisks.join('\n'));
function fixture() {
  return { schemaVersion: 1, kind: 'human_release_exception', state: 'active', id: grant.id, repository: grant.repository,
    sourceSha: SOURCE, baselineSourceSha: grant.baselineSourceSha, target: 'google-play', releaseTag: grant.releaseTag,
    verifierSha: VERIFIER, configurationFingerprint: MARKET_FINGERPRINTS['google-play'], inventorySha256: digest(inventoryBytes), productTreeSha256: productTreeHash,
    approvedAt: grant.approvedAt, expiresAt: new Date(Date.parse(grant.approvedAt) + 168 * 3600000).toISOString(),
    approvalSha256: grant.approvalSha256, proposalSha256: grant.proposalSha256, observationsSha256: grant.observationsSha256,
    approvedRisks: grant.approvedRisks, features: observations.features, riskNotesSha256: digest(riskNotes),
    releaseBinding: { tagObjectSha: TAG_OBJECT, tagReceiptSha256: digest(receipt) },
    decisionStatus: 'human_exception', productE2eStatus: 'blocked' };
}
function github({ manifest = fixture(), changedProduct = false, approvalBytes = approval, duplicate = false,
  originalBytes = originals, missingOriginal = false, remoteVerifierExists = true, changedVerifierSource = false, assetTarget = 'google-play', mainAncestor = true,
  verifierSha = VERIFIER, treeTruncated = false, tagMessage = receipt, tagSource = SOURCE, riskBytes = riskNotes, remoteGrant = grant } = {}) {
  const calls = [];
  const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/repos/seorilabs/.github/compare/')) return reply({ status: mainAncestor ? 'ahead' : 'diverged', base_commit: { sha: url.split('/compare/')[1].split('...')[0] } });
    if (url.includes('/repos/seorilabs/.github/git/commits/')) return remoteVerifierExists ? reply({ sha: verifierSha }) : new Response('{}', { status: 404 });
    if (url.includes('/repos/seorilabs/.github/contents/') && url.includes(`?ref=${verifierSha}`)) {
      const path = decodeURIComponent(url.split('/contents/')[1].split('?ref=')[0]);
      const bytes = changedVerifierSource && path === 'scripts/github-rest.mjs' ? Buffer.from('modified source') : readFileSync(join(sandbox, path));
      return reply({ type: 'file', encoding: 'base64', content: bytes.toString('base64') });
    }
    if (url.includes('/repos/seorilabs/.github/contents/contracts/release-exceptions/')) return remoteGrant === null
      ? new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
      : reply({ encoding: 'base64', content: Buffer.from(JSON.stringify(remoteGrant)).toString('base64') });
    if (url.includes('/releases/tags/')) return reply({ id: 1, tag_name: grant.releaseTag });
    if (url.includes('/releases/1/assets?')) return reply([
      { id: 10, name: `release-exception.${assetTarget}.json`, size: 10000 },
      ...(duplicate ? [{ id: 11, name: 'release-exception.google-play.json', size: 10000 }] : []),
      { id: 20, name: 'release-exception.approval.json', size: approvalBytes.length },
      { id: 30, name: 'release-risk-notes.md', size: riskNotes.length },
      ...observations.observations.filter((_, i) => !missingOriginal || i !== 0).map((item, i) => ({ id: 40 + i, name: item.asset, size: 10000 }))]);
    if (url.endsWith('/releases/assets/10')) return reply(manifest);
    if (url.endsWith('/releases/assets/20')) return new Response(approvalBytes);
    if (url.endsWith('/releases/assets/30')) return new Response(riskBytes);
    for (const [i, item] of observations.observations.entries()) if (url.endsWith(`/releases/assets/${40 + i}`)) return new Response(originalBytes[item.asset]);
    if (url.includes('/contents/docs/qa/feature-inventory.json?ref=')) return reply({ encoding: 'base64', content: inventoryBytes.toString('base64') });
    if (url.includes('/git/commits/')) return reply({ tree: { sha: url.endsWith(SOURCE) ? TREE : '2'.repeat(40) } });
    if (url.includes('/git/trees/')) return reply({ truncated: treeTruncated, tree: [
      ...productTree.map((entry, i) => changedProduct && i === 0 && url.includes(TREE) ? { ...entry, sha: '3'.repeat(40) } : entry),
      ...grant.allowedAppFiles.map(path => ({ path, type: 'blob', mode: '100644', sha: '8'.repeat(40) }))] });
    if (url.includes('/git/ref/tags/')) return reply({ ref: 'refs/tags/v1.1.0', object: { type: 'tag', sha: TAG_OBJECT } });
    if (url.includes('/git/tags/')) return reply({ sha: TAG_OBJECT, tag: 'v1.1.0', object: { type: 'commit', sha: tagSource }, message: tagMessage });
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetchImpl, calls };
}
const context = { repository: grant.repository, sourceSha: SOURCE, tag: grant.releaseTag, target: 'google-play', phase: 'before-build',
  configurationFingerprint: MARKET_FINGERPRINTS['google-play'], verifierSha: VERIFIER, exceptionId: grant.id, token: 'fixture-token',
  appRepository, env: executionEnv, now: new Date(Date.parse(grant.approvedAt) + 60000).toISOString() };

test('explicit reviewed release exception preserves all 26 original verdicts and blocked E2E', async () => {
  const api = github();
  const result = await verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: api.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.decisionStatus, 'human_exception');
  assert.equal(result.productE2eStatus, 'blocked');
  assert.equal(result.featureCount, 26);
  assert.deepEqual(result.features, observations.features);
  assert.equal(result.artifact, null);
  assert.equal(result.verifierProof.kind, 'github-archive'); assert.equal(result.verifierProof.revision, VERIFIER);
  assert.ok(result.verifierProof.files.some(file => file.path === 'scripts/github-rest.mjs'));
  assert.equal(result.executionConfiguration.kind, 'generated-from-ci-input');
});
test('promotion boundary retains fresh common expiry, grant revocation, source and original status rejection', async () => {
  for (const [changes, options, message] of [
    [{ remoteGrant: { ...grant, revoked: true } }, {}, 'RELEASE_EXCEPTION_REVOKED'],
    [{ changedProduct: true }, {}, 'RELEASE_EXCEPTION_PRODUCT_TREE_CHANGED'],
    [{ tagSource: '9'.repeat(40) }, {}, 'RELEASE_EXCEPTION_TAG_SOURCE_CHANGED'],
    [{}, { now: new Date(Date.parse(grant.approvedAt) + 169 * 3600000).toISOString() }, 'RELEASE_EXCEPTION_EXPIRED'],
  ]) await assert.rejects(verifyGooglePlayPromotion({ ...context, ...options, phase: 'before-deploy', env: {},
    ciRunId: '123', ciRunAttempt: '1', evidenceBundleFile: '/unused-fixture', fetchImpl: github(changes).fetchImpl }), { message });
});

test('matching arbitrary caller and manifest fingerprint claims cannot replace reviewed market settings', async () => {
  const manifest = fixture(); manifest.configurationFingerprint = '9'.repeat(64);
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, configurationFingerprint: manifest.configurationFingerprint,
    fetchImpl: github({ manifest }).fetchImpl }), /RELEASE_EXCEPTION_CONFIGURATION_UNREVIEWED/u);
});
test('archive verifier rejects unknown revision and modified runtime source bytes', async () => {
  for (const [changes, message] of [[{ remoteVerifierExists: false }, 'RELEASE_EXCEPTION_VERIFIER_REVISION_UNVERIFIED'],
    [{ changedVerifierSource: true }, 'RELEASE_EXCEPTION_VERIFIER_SOURCE_CHANGED']]) {
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github(changes).fetchImpl }), { message });
  }
});
test('approved fingerprint cannot hide changed actual workflow inputs or registered Firebase bytes', async () => {
  for (const [key, value] of [['SEORI_EXCEPTION_TRACK', 'production'], ['GODOT_VERSION', '0.0.0'],
    ['FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64', Buffer.from('modified config').toString('base64')]]) {
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, env: { ...executionEnv, [key]: value }, fetchImpl: github().fetchImpl }),
      key === 'FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64' ? /^Error: RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED$/u : /^Error: RELEASE_EXCEPTION_EXECUTION_INPUTS_CHANGED$/u);
  }
});
test('before-deploy rejects changed actual generated runtime bytes', async () => {
  const path = join(appRepository, 'config/android_runtime.json');
  try {
    writeFileSync(path, 'modified runtime');
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, phase: 'before-deploy', fetchImpl: github().fetchImpl }), /^Error: RELEASE_EXCEPTION_RUNTIME_CONFIG_CHANGED$/u);
  } finally { writeFileSync(path, runtimeBytes); }
});
test('reviewed fingerprint cannot hide changed actual AdMob input or injected files', async () => {
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, env: { ...executionEnv, ADMOB_APP_ID: 'changed' }, fetchImpl: github().fetchImpl }),
    { message: 'RELEASE_EXCEPTION_ADMOB_INPUT_CHANGED' });
  for (const filename of ['project.godot', 'data/ad_units.json']) {
    const path = join(appRepository, filename), bytes = readFileSync(path);
    try {
      writeFileSync(path, 'changed injected ads configuration');
      await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, phase: 'before-deploy', fetchImpl: github().fetchImpl }),
        { message: 'RELEASE_EXCEPTION_INJECTED_ADS_CONFIGURATION_CHANGED' });
    } finally { writeFileSync(path, bytes); }
  }
});
test('reviewed grant cannot extend the fixed 168-hour ceiling', async () => {
  const path = join(sandbox, 'contracts/release-exceptions/reascend-1.1.0.json'), bytes = readFileSync(path);
  try {
    writeFileSync(path, JSON.stringify({ ...grant, maxAgeHours: 720 }));
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github().fetchImpl }), /^Error: RELEASE_EXCEPTION_GRANT_SCHEMA$/u);
  } finally { writeFileSync(path, bytes); }
});

test('reviewed verifier must remain an ancestor of current central main', async () => {
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github({ mainAncestor: false }).fetchImpl }),
    { message: 'RELEASE_EXCEPTION_VERIFIER_NOT_REVIEWED_ON_MAIN' });
});
test('manifest preflight cannot run in CI', async () => {
  for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { CI_XCODE_CLOUD: 'TRUE' }]) {
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, preflightOnly: true, exceptionFile: 'manifest.json',
      env, fetchImpl: github().fetchImpl }), { message: 'RELEASE_EXCEPTION_PREFLIGHT_FORBIDDEN_IN_CI' });
  }
});
test('Xcode launch request validates real selected provider IDs and leaves actual CI verification pending', async () => {
  const manifest = fixture(); manifest.target = 'app-store'; manifest.configurationFingerprint = MARKET_FINGERPRINTS['app-store'];
  const selected = { provider: 'app-store-connect', workflowId: '3A3999C4-DDF0-4476-8B80-548F5D3710E5',
    productId: 'product-fixture', repositoryId: 'repository-fixture', referenceId: 'reference-fixture', bundleId: grant.packageName,
    referenceKind: 'TAG', referenceName: grant.releaseTag };
  const options = { ...context, target: 'app-store', configurationFingerprint: MARKET_FINGERPRINTS['app-store'], env: {},
    launchRequest: selected, fetchImpl: github({ manifest, assetTarget: 'app-store' }).fetchImpl };
  const result = await verifyXcodeLaunchRequest(options);
  assert.equal(result.scope, 'xcode-launch-request'); assert.equal(result.actualCiVerification, 'pending-ci-hook');
  assert.equal(result.executionConfiguration, null); assert.equal(result.productE2eStatus, 'blocked');
  assert.deepEqual(result.launchRequest, selected);
  await assert.rejects(verifyXcodeLaunchRequest({ ...options, launchRequest: { ...selected, workflowId: 'other-workflow' } }),
    { message: 'RELEASE_EXCEPTION_XCODE_LAUNCH_REQUEST_CHANGED' });
  await assert.rejects(verifyXcodeLaunchRequest({ ...options, env: { CI_XCODE_CLOUD: 'TRUE' } }),
    { message: 'RELEASE_EXCEPTION_XCODE_LAUNCH_REQUEST_FORBIDDEN_IN_CI_HOOK' });
  await assert.rejects(verifyReleaseDevelopmentEvidence(options), { message: 'RELEASE_EXCEPTION_EXECUTION_INPUTS_CHANGED' });
});

test('actual Xcode CI checks protected toolchain and real CI input/runtime copies without claiming physical purchase proof', async () => {
  const manifest = fixture(); manifest.target = 'app-store'; manifest.configurationFingerprint = MARKET_FINGERPRINTS['app-store'];
  const options = { ...context, target: 'app-store', configurationFingerprint: MARKET_FINGERPRINTS['app-store'], env: iosExecutionEnv,
    fetchImpl: github({ manifest, assetTarget: 'app-store' }).fetchImpl };
  const result = await verifyReleaseDevelopmentEvidence(options);
  assert.equal(result.scope, 'actual-ci-phase'); assert.equal(result.actualCiVerification, 'verified');
  assert.equal(result.executionConfiguration.kind, 'generated-from-ci-input'); assert.equal(result.productE2eStatus, 'blocked');
  assert.equal(result.iosBuildProvenance.actualHelperBytesThisPhaseVerified, false);
  assert.equal(result.executionConfiguration.inputs.CI_PROJECT_FILE_PATH, 'xcode-cloud/reascend-ios-project.xcodeproj');
  for (const [key, value] of [['CI_XCODE_CLOUD', 'FALSE'], ['CI_XCODE_SCHEME', 'wrong-scheme'], ['CI_TAG', 'v1.1.1'], ['CI_PROJECT_FILE_PATH', '/tmp/wrong.xcodeproj'], ['CI_BUNDLE_ID', 'other.app']]) {
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...options, env: { ...iosExecutionEnv, [key]: value } }), { message: 'RELEASE_EXCEPTION_EXECUTION_INPUTS_CHANGED' });
  }
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...options, phase: 'before-deploy' }), { message: 'RELEASE_EXCEPTION_ARTIFACT_REQUIRED' });
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...options, phase: 'before-deploy', artifactFile: '/unused-fixture-plist',
    releaseBindingFile: '/unused-fixture-binding', xcodeBuildNumber: '43', env: { ...iosExecutionEnv, CI_BUILD_NUMBER: '42' } }),
    { message: 'RELEASE_EXCEPTION_IOS_BUILD_AUTHORITY_MISMATCH' });
  const path = join(appRepository, 'config/ios_runtime.json');
  try {
    writeFileSync(path, 'changed iOS runtime');
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...options, phase: 'before-deploy' }), { message: 'RELEASE_EXCEPTION_RUNTIME_CONFIG_CHANGED' });
  } finally { writeFileSync(path, runtimeBytes); }
});
test('actual phase refuses modified local generator and protected build environment', async () => {
  for (const [name, message] of [['scripts/release/generate_runtime_config.py', 'RELEASE_EXCEPTION_RUNTIME_GENERATOR_CHANGED'], ['build.env', 'RELEASE_EXCEPTION_BUILD_ENVIRONMENT_CHANGED']]) {
    const path = join(appRepository, name), bytes = readFileSync(path);
    try {
      writeFileSync(path, 'modified protected source');
      await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github().fetchImpl }), { message });
    } finally { writeFileSync(path, bytes); }
  }
});

const rejectionCodes = {
  'source reuse': 'RELEASE_EXCEPTION_BINDING_MISMATCH sourceSha', 'market reuse': 'RELEASE_EXCEPTION_BINDING_MISMATCH target',
  'tag reuse': 'RELEASE_EXCEPTION_BINDING_MISMATCH releaseTag', 'configuration mismatch': 'RELEASE_EXCEPTION_BINDING_MISMATCH configurationFingerprint',
  'verifier mismatch': 'RELEASE_EXCEPTION_BINDING_MISMATCH verifierSha', 'invented human approval': 'RELEASE_EXCEPTION_APPROVAL_MISMATCH approvalSha256',
  'proposal mismatch': 'RELEASE_EXCEPTION_APPROVAL_MISMATCH proposalSha256', 'inventory mismatch': 'RELEASE_EXCEPTION_APPROVAL_MISMATCH inventorySha256',
  'removed core feature': 'RELEASE_EXCEPTION_ORIGINAL_STATUS_CHANGED', 'changed partial observation': 'RELEASE_EXCEPTION_ORIGINAL_STATUS_CHANGED',
  'blocked changed to passed': 'RELEASE_EXCEPTION_SCHEMA', 'risk removed': 'RELEASE_EXCEPTION_ORIGINAL_STATUS_CHANGED',
  'more than 168 hours': 'RELEASE_EXCEPTION_EXPIRED', 'self declared later approval': 'RELEASE_EXCEPTION_APPROVAL_MISMATCH approvedAt',
  'closed grant': 'RELEASE_EXCEPTION_SCHEMA', 'unknown bypass field': 'RELEASE_EXCEPTION_SCHEMA', 'unbound tag': 'RELEASE_EXCEPTION_TAG_RECEIPT_MISMATCH',
  'changed product code': 'RELEASE_EXCEPTION_PRODUCT_TREE_CHANGED', 'incomplete tree readback': 'RELEASE_EXCEPTION_TREE_TRUNCATED',
  'duplicate manifest': 'RELEASE_EXCEPTION_ASSET_MISSING_OR_AMBIGUOUS release-exception.google-play.json',
  'modified approval bytes': 'RELEASE_EXCEPTION_HUMAN_APPROVAL_UNVERIFIED', 'missing official receipt': 'RELEASE_EXCEPTION_OFFICIAL_RECEIPT_REQUIRED',
  'moved tag source': 'RELEASE_EXCEPTION_TAG_SOURCE_CHANGED', 'risk notes removed': 'RELEASE_EXCEPTION_RISK_NOTES_CHANGED',
  'missing original report': 'RELEASE_EXCEPTION_ASSET_MISSING_OR_AMBIGUOUS release-exception.original-ui-review-8.md',
  'modified original report': 'RELEASE_EXCEPTION_ORIGINAL_EVIDENCE_MISSING_OR_CHANGED',
};
for (const [name, mutate] of [
  ['source reuse', d => { d.sourceSha = '9'.repeat(40); }],
  ['market reuse', d => { d.target = 'app-store'; }],
  ['tag reuse', d => { d.releaseTag = 'v1.1.1'; }],
  ['configuration mismatch', d => { d.configurationFingerprint = '9'.repeat(64); }],
  ['verifier mismatch', d => { d.verifierSha = '9'.repeat(40); }],
  ['invented human approval', d => { d.approvalSha256 = '9'.repeat(64); }],
  ['proposal mismatch', d => { d.proposalSha256 = '9'.repeat(64); }],
  ['inventory mismatch', d => { d.inventorySha256 = '9'.repeat(64); }],
  ['removed core feature', d => { d.features.pop(); }],
  ['changed partial observation', d => { d.features[0].originalVerdict = 'passed'; }],
  ['blocked changed to passed', d => { d.productE2eStatus = 'passed'; }],
  ['risk removed', d => { d.approvedRisks.pop(); }],
  ['more than 168 hours', d => { d.expiresAt = new Date(Date.parse(grant.approvedAt) + 169 * 3600000).toISOString(); }],
  ['self declared later approval', d => { d.approvedAt = new Date(Date.parse(grant.approvedAt) + 1000).toISOString(); }],
  ['closed grant', d => { d.state = 'closed'; }],
  ['unknown bypass field', d => { d.skipE2e = true; }],
  ['unbound tag', d => { d.releaseBinding = null; }],
]) {
  test(`exception rejects ${name}`, async () => {
    const manifest = structuredClone(fixture()); mutate(manifest);
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github({ manifest }).fetchImpl }), { message: rejectionCodes[name] });
  });
}
for (const [name, changes] of [
  ['changed product code', { changedProduct: true }], ['incomplete tree readback', { treeTruncated: true }],
  ['duplicate manifest', { duplicate: true }], ['modified approval bytes', { approvalBytes: Buffer.from('{}') }],
  ['missing official receipt', { tagMessage: 'normal tag' }], ['moved tag source', { tagSource: '9'.repeat(40) }],
  ['risk notes removed', { riskBytes: Buffer.from('release') }],
  ['missing original report', { missingOriginal: true }],
  ['modified original report', { originalBytes: { ...originals, 'release-exception.original-ui-review-8.md': Buffer.from('modified') } }],
]) test(`exception rejects ${name}`, async () => {
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github(changes).fetchImpl }), { message: rejectionCodes[name] });
});
test('expired exception and missing runtime fingerprint fail without fallback', async () => {
  for (const [changes, message] of [[{ now: new Date(Date.parse(grant.approvedAt) + 169 * 3600000).toISOString() }, 'RELEASE_EXCEPTION_EXPIRED'],
    [{ configurationFingerprint: undefined }, 'RELEASE_EXCEPTION_CONTEXT_REQUIRED'], [{ exceptionId: 'unreviewed' }, 'RELEASE_EXCEPTION_NOT_REVIEWED']]) {
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, ...changes, fetchImpl: github().fetchImpl }), { message });
  }
});
test('normal mode never treats the exception asset as passed E2E', async () => {
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, exceptionId: undefined, fetchImpl: github().fetchImpl }), /REQUIRED_DEVELOPMENT_EVIDENCE_MISSING/u);
});
test('before-deploy requires an actual artifact while before-build does not', async () => {
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, phase: 'before-deploy', fetchImpl: github().fetchImpl }), /RELEASE_EXCEPTION_ARTIFACT_REQUIRED/u);
});
test('before-deploy binds the actual Android bytes to the existing official artifact receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-exception-artifact-'));
  try {
    const artifactFile = join(dir, 'app.aab'), releaseBindingFile = join(dir, 'binding.json'), artifactReceiptFile = join(dir, 'receipt.txt');
    const bytes = Buffer.from('verified-aab-fixture'); writeFileSync(artifactFile, bytes);
    const binding = createReleaseBinding({ tag: 'v1.1.0', sourceSha: SOURCE, calledWorkflowSha: VERIFIER,
      authorityRevision: digest(read('contracts/release-version-authority.yaml')), configRevision: '7'.repeat(64), androidVersionCode: 21, androidVersionCodeSource: 'github-ledger' });
    writeFileSync(releaseBindingFile, JSON.stringify(binding));
    writeFileSync(artifactReceiptFile, renderArtifactReceipt({ binding, kind: 'android-app-bundle', artifactDigest: digest(bytes) }));
    const options = { ...context, phase: 'before-deploy', artifactFile, releaseBindingFile, artifactReceiptFile };
    const result = await verifyReleaseDevelopmentEvidence({ ...options, fetchImpl: github().fetchImpl });
    assert.equal(result.decisionStatus, 'human_exception'); assert.equal(result.artifact.sha256, digest(bytes));
    writeFileSync(artifactFile, 'different-artifact');
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...options, fetchImpl: github().fetchImpl }), /artifact-digest-mismatch/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('promotion whole boundary preserves 26 verdicts and reuses successful CI without recreating CI env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'promotion-whole-boundary-'));
  try {
    const artifactFile = join(dir, 'app.aab'), releaseBindingFile = join(dir, 'release-binding.json'), artifactReceiptFile = join(dir, 'release-artifact-receipt.txt');
    const bytes = Buffer.from('static synthetic AAB'); writeFileSync(artifactFile, bytes);
    const binding = createReleaseBinding({ tag: context.tag, sourceSha: SOURCE, authorityRevision: digest(read('contracts/release-version-authority.yaml')),
      configRevision: '7'.repeat(64), androidVersionCode: 21, androidVersionCodeSource: 'github-ledger' });
    writeFileSync(releaseBindingFile, JSON.stringify(binding));
    writeFileSync(artifactReceiptFile, renderArtifactReceipt({ binding, kind: 'android-app-bundle', artifactDigest: digest(bytes) }));
    const before = await verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github().fetchImpl });
    const after = await verifyReleaseDevelopmentEvidence({ ...context, phase: 'before-deploy', artifactFile, releaseBindingFile, artifactReceiptFile, fetchImpl: github().fetchImpl });
    writeFileSync(join(dir, 'before-build.json'), JSON.stringify(before)); writeFileSync(join(dir, 'before-deploy.json'), JSON.stringify(after));
    const outputFile = join(dir, 'promotion-evidence.zip');
    const evidence = createPromotionEvidence({ directory: dir, outputFile, env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: grant.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' } });
    const api = github(), workflowSha = '9'.repeat(40), reply = value => new Response(JSON.stringify(value));
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/actions/runs/123/attempts/1')) return reply({ id: 123, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
        head_sha: SOURCE, path: '.github/workflows/deploy-google-play.yml', repository: { full_name: grant.repository }, head_repository: { full_name: grant.repository },
        run_started_at: new Date(Date.parse(context.now) - 60000).toISOString(), updated_at: new Date(Date.parse(context.now) + 60000).toISOString(),
        referenced_workflows: [{ path: 'seorilabs/.github/.github/workflows/godot-deploy-google-play.yml@main', sha: workflowSha }] });
      if (url.includes('/attempts/1/jobs?')) return reply({ jobs: [{ id: 456, run_id: 123, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: SOURCE,
        steps: ['Verify Editor E2E before-build', 'Verify Editor E2E before-deploy', 'Upload to Google Play', 'Package promotion evidence', 'Preserve promotion evidence bundle'].map(name => ({ name, conclusion: 'success' })) }] });
      if (url.endsWith('/actions/jobs/456/logs')) return new Response(evidence.logLine);
      if (url.includes('/contents/.github/workflows/godot-deploy-google-play.yml?')) return reply({ type: 'file', encoding: 'base64', content: read('.github/workflows/godot-deploy-google-play.yml').toString('base64') });
      if (url.includes('/tracks/internal')) { assert.equal(init.method, 'GET'); return reply({ track: 'internal', releases: [{ status: 'completed', versionCodes: ['21'] }] }); }
      return api.fetchImpl(url, init);
    };
    const result = await verifyGooglePlayPromotion({ ...context, phase: 'before-deploy', env: { GOOGLE_PLAY_ACCESS_TOKEN: 'static-fixture', GOOGLE_PLAY_READ_EDIT_ID: 'existing-read-edit' },
      ciRunId: '123', ciRunAttempt: '1', evidenceBundleFile: outputFile, fetchImpl });
    assert.equal(result.productE2eStatus, 'blocked'); assert.equal(result.decisionStatus, 'human_exception');
    assert.equal(result.scope, 'promotion-recheck'); assert.equal(result.actualCiVerification, 'reused-successful-ci');
    assert.equal(result.featureCount, 26); assert.deepEqual(result.features, observations.features);
    assert.equal(result.artifact.sha256, digest(bytes)); assert.equal(result.ciProof.workflowSha, workflowSha);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('local preflight cannot manufacture an executed E2E or build authorization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-exception-preflight-'));
  try {
    const exceptionFile = join(dir, 'exception.json'), riskNotesFile = join(dir, 'risk.md');
    const manifest = fixture(); manifest.releaseBinding = null;
    writeFileSync(exceptionFile, JSON.stringify(manifest)); writeFileSync(riskNotesFile, riskNotes);
    const originalEvidenceDir = join(dir, 'originals'); mkdirSync(originalEvidenceDir);
    for (const [asset, bytes] of Object.entries(originals)) writeFileSync(join(originalEvidenceDir, asset), bytes);
    const api = github();
    const result = await verifyReleaseDevelopmentEvidence({ ...context, env: {}, preflightOnly: true, exceptionFile, riskNotesFile, originalEvidenceDir, fetchImpl: api.fetchImpl });
    assert.equal(result.decisionStatus, 'preflight_ready'); assert.equal(result.productE2eStatus, 'blocked');
    assert.ok(!api.calls.some(url => url.includes('/releases') || url.includes('/git/ref/tags/')));
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, env: {}, preflightOnly: true, exceptionFile, riskNotesFile, fetchImpl: github().fetchImpl }), /ORIGINAL_EVIDENCE_REQUIRED/u);
    writeFileSync(join(originalEvidenceDir, observations.observations[0].asset), 'modified original');
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, env: {}, preflightOnly: true, exceptionFile, riskNotesFile, originalEvidenceDir, fetchImpl: github().fetchImpl }), /ORIGINAL_EVIDENCE_MISSING_OR_CHANGED/u);
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, env: {}, exceptionFile, riskNotesFile, fetchImpl: github().fetchImpl }), /LOCAL_FILE_NOT_RELEASE_AUTHORITY/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('actual pinned53 Apple build number remains distinct from encoded tag receipt number', () => {
  const binding = { tag: 'v1.1.0', sourceSha: SOURCE, runtimeVersionCode: deriveTagEncodedVersionCode('v1.1.0'),
    appleMarketingVersion: '1.1.0', appleBuildNumber: 42, buildNumberAuthority: 'xcode-cloud-ci-build-number', applied: true };
  const input = { binding, tagReceipt: parseTagReceipt(receipt), metadata: { versionName: '1.1.0', versionCode: 42 },
    bundleId: grant.packageName, xcodeBuildNumber: '42', exceptionId: grant.id, tag: 'v1.1.0', sourceSha: SOURCE };
  assert.doesNotThrow(() => validateIosArtifact(input));
  assert.throws(() => validateIosArtifact({ ...input, metadata: { versionName: '1.1.0', versionCode: 1001000 } }), /IOS_ARTIFACT_VERSION_CHANGED/u);
  assert.throws(() => validateIosArtifact({ ...input, xcodeBuildNumber: '43' }), /IOS_BUILD_AUTHORITY_MISMATCH/u);
  assert.throws(() => validateIosArtifact({ ...input, bundleId: 'other.bundle' }), /ARTIFACT_PACKAGE_CHANGED/u);
});
for (const [name, remoteGrant] of [['missing current grant', null], ['revoked current grant', { ...grant, revoked: true }],
  ['changed current approval', { ...grant, approvalSha256: '9'.repeat(64) }], ['changed current allowed files', { ...grant, allowedAppFiles: ['project.godot'] }]]) {
  test(`pinned verifier rejects ${name} at both phases`, async () => {
    for (const phase of ['before-build', 'before-deploy']) await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, phase, fetchImpl: github({ remoteGrant }).fetchImpl }), { message: name === 'missing current grant' ? 'RELEASE_EXCEPTION_CURRENT_GRANT_UNREADABLE' : name === 'revoked current grant' ? 'RELEASE_EXCEPTION_REVOKED' : 'RELEASE_EXCEPTION_CURRENT_GRANT_CHANGED' });
  });
}

test('git checkout verifier derives HEAD and rejects caller SHA mismatch or dirty direct source bytes', async () => {
  const git = args => execFileSync('git', ['-C', sandbox, ...args], { stdio: 'pipe' }).toString().trim();
  const path = join(sandbox, 'scripts/github-rest.mjs'), bytes = readFileSync(path);
  try {
    git(['init', '--quiet']); git(['add', '--', 'scripts', 'contracts', '.github', 'package.json', 'package-lock.json']);
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'verifier fixture']);
    const revision = git(['rev-parse', 'HEAD']), manifest = fixture(); manifest.verifierSha = revision;
    const options = { ...context, verifierSha: revision, fetchImpl: github({ manifest, verifierSha: revision }).fetchImpl };
    const result = await verifyReleaseDevelopmentEvidence(options);
    assert.equal(result.verifierProof.kind, 'git-checkout'); assert.equal(result.verifierProof.revision, revision);
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...options, verifierSha: VERIFIER }), { message: 'RELEASE_EXCEPTION_VERIFIER_REVISION_CHANGED' });
    writeFileSync(path, 'modified tracked source');
    await assert.rejects(verifyReleaseDevelopmentEvidence(options), { message: 'RELEASE_EXCEPTION_VERIFIER_SOURCE_CHANGED' });
  } finally { writeFileSync(path, bytes); rmSync(join(sandbox, '.git'), { recursive: true, force: true }); }
});
