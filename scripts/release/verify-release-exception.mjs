// 별도 사람 승인 예외는 제품 E2E 통과를 뜻하지 않는다. 검토된 중앙 grant가 신뢰 기준이다.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { githubDownload, githubJson, githubPaginate } from '../github-rest.mjs';
import { verifyPromotionEvidence } from './release-promotion-evidence.mjs';
import { assertArtifactReceipt, assertTagReceipt, deriveEncodedVersion, deriveTagEncodedVersionCode,
  parseArtifactReceipt, parseInfoPlistJson, parseReleaseBinding, parseTagReceipt } from './tag-version-authority.mjs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url));
const schema = JSON.parse(read('contracts/release-exception.schema.json'));
const check = new Ajv2020({ allErrors: true }).compile(schema);
const checkGrant = new Ajv2020({ allErrors: true }).compile(JSON.parse(read('contracts/release-exception-grant.schema.json')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{40}$/u, DIGEST = /^[a-f0-9]{64}$/u;
const grants = new Map((parse(read('contracts/development-workflow.yaml').toString()).releaseExceptions?.grantRegistry ?? []).map(path => {
  const match = /^contracts\/release-exceptions\/([a-z0-9][a-z0-9.-]+)\.json$/u.exec(path);
  if (!match) throw new Error('RELEASE_EXCEPTION_REGISTRY_INVALID');
  return [match[1], path];
}));
const fail = code => { throw new Error(code); };
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const equal = (a, b) => canonical(a) === canonical(b);

function reviewedGrant(id) {
  const path = grants.get(id);
  if (!path) fail('RELEASE_EXCEPTION_NOT_REVIEWED');
  const grant = JSON.parse(read(path));
  if (!checkGrant(grant)) fail('RELEASE_EXCEPTION_GRANT_SCHEMA');
  if (grant.revoked || grant.id !== id) fail('RELEASE_EXCEPTION_REVOKED');
  const prefix = 'contracts/release-exceptions/';
  const approval = read(`${prefix}${grant.approvalFile}`), observations = read(`${prefix}${grant.observationsFile}`);
  if (sha256(approval) !== grant.approvalSha256 || sha256(observations) !== grant.observationsSha256) fail('RELEASE_EXCEPTION_TRUST_ANCHOR_CHANGED');
  return { grant, approval, observations: JSON.parse(observations) };
}

// CLI의 40hex 주장을 신뢰하지 않는다. checkout은 HEAD와 tracked bytes, codeload archive는
// 실제 GitHub commit의 직접 사용 소스 bytes를 대조한다. 각 phase에서 다시 확인한다.
async function runtimeRevision(grant, claimedSha, request) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const paths = ['scripts/release/verify-development-evidence.mjs', 'scripts/release/verify-release-exception.mjs',
    'scripts/release/human-release-exception.mjs', 'contracts/release-verification-exceptions.json',
    'scripts/release/release-promotion-evidence.mjs', 'scripts/release/create-promotion-evidence.mjs',
    'scripts/release/verify-google-play-promotion.mjs', '.github/workflows/godot-deploy-google-play.yml',
    'scripts/release/tag-version-authority.mjs', 'scripts/github-rest.mjs', 'scripts/trigger-xcode-cloud.mjs',
    'scripts/release/resolve-github-tag-commit.mjs', 'contracts/development-evidence.schema.json',
    'contracts/development-workflow.schema.json', 'contracts/development-workflow.yaml', 'contracts/release-exception.schema.json',
    'contracts/release-exception-grant.schema.json',
    'contracts/release-version-authority.yaml', grants.get(grant.id), `contracts/release-exceptions/${grant.approvalFile}`,
    `contracts/release-exceptions/${grant.observationsFile}`, 'package.json', 'package-lock.json'];
  const files = paths.map(path => {
    try {
      const location = join(root, path), stat = lstatSync(location);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('RELEASE_EXCEPTION_VERIFIER_SOURCE_NOT_REGULAR');
      return { path, bytes: readFileSync(location) };
    } catch { fail('RELEASE_EXCEPTION_VERIFIER_SOURCE_UNREADABLE'); }
  });
  let kind, revision;
  if (existsSync(join(root, '.git'))) {
    const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
    try {
      if (realpathSync(git(['rev-parse', '--show-toplevel']).toString().trim()) !== realpathSync(root)) fail('RELEASE_EXCEPTION_VERIFIER_CHECKOUT_ROOT');
      revision = git(['rev-parse', 'HEAD']).toString().trim();
      if (!SHA.test(revision) || claimedSha !== revision) fail('RELEASE_EXCEPTION_VERIFIER_REVISION_CHANGED');
      if (files.some(file => !file.bytes.equals(git(['show', `${revision}:${file.path}`])))) fail('RELEASE_EXCEPTION_VERIFIER_SOURCE_CHANGED');
    } catch (error) {
      if (error.message.startsWith('RELEASE_EXCEPTION_')) throw error;
      fail('RELEASE_EXCEPTION_VERIFIER_CHECKOUT_UNREADABLE');
    }
    kind = 'git-checkout';
  } else {
    try {
      const commit = await githubJson(`/repos/seorilabs/.github/git/commits/${claimedSha}`, request);
      if (commit.sha !== claimedSha) fail('RELEASE_EXCEPTION_VERIFIER_REVISION_UNVERIFIED');
    } catch { fail('RELEASE_EXCEPTION_VERIFIER_REVISION_UNVERIFIED'); }
    await Promise.all(files.map(async file => {
      let remote;
      try { remote = await githubJson(`/repos/seorilabs/.github/contents/${file.path}?ref=${claimedSha}`, request); }
      catch { fail('RELEASE_EXCEPTION_VERIFIER_SOURCE_UNREADABLE'); }
      if (remote.type !== 'file' || remote.encoding !== 'base64' || typeof remote.content !== 'string'
        || !file.bytes.equals(Buffer.from(remote.content, 'base64'))) fail('RELEASE_EXCEPTION_VERIFIER_SOURCE_CHANGED');
    }));
    kind = 'github-archive'; revision = claimedSha;
  }
  let ancestry;
  try { ancestry = await githubJson(`/repos/seorilabs/.github/compare/${revision}...main`, request); }
  catch { fail('RELEASE_EXCEPTION_VERIFIER_NOT_REVIEWED_ON_MAIN'); }
  if (!['ahead', 'identical'].includes(ancestry.status) || ancestry.base_commit?.sha !== revision) fail('RELEASE_EXCEPTION_VERIFIER_NOT_REVIEWED_ON_MAIN');
  return { verified: true, kind, revision, reviewedOnCurrentMain: true,
    files: files.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) })) };
}

function regularBytes(path, code) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(code);
    return readFileSync(path);
  } catch { fail(code); }
}

// build 직전에는 준비 스크립트가 아직 실행되지 않았다. 같은 보호된 generator와 실제 CI
// Firebase bytes로 격리 생성한 결과를 검사한다. deploy 직전에는 실제 소비 파일을 검사한다.
function executionConfiguration(options, grant) {
  const env = options.env ?? process.env, expected = grant.executionConfiguration[options.target];
  if (options.target === 'app-store' && env.CI_XCODE_CLOUD !== 'TRUE') fail('RELEASE_EXCEPTION_EXECUTION_INPUTS_CHANGED');
  if (!options.appRepository) fail('RELEASE_EXCEPTION_APP_REPOSITORY_REQUIRED');
  const root = resolve(options.appRepository);
  const buildBytes = regularBytes(join(root, 'build.env'), 'RELEASE_EXCEPTION_BUILD_ENVIRONMENT_CHANGED');
  if (sha256(buildBytes) !== expected.buildEnvironmentSha256) fail('RELEASE_EXCEPTION_BUILD_ENVIRONMENT_CHANGED');
  const projection = Object.fromEntries(Object.keys(expected.expectedInputs).map(key => [key, String(env[key] ?? '')]));
  projection.PROJECT_R_ANALYTICS_ENABLED = env.PROJECT_R_ANALYTICS_ENABLED ?? 'true';
  if (options.target === 'app-store') {
    projection.CI_PROJECT_FILE_PATH = env.CI_PROJECT_FILE_PATH ? relative(root, resolve(env.CI_PROJECT_FILE_PATH)) : '';
    for (const key of ['GODOT_VERSION', 'GODOT_STATUS']) {
      const match = new RegExp(`^${key}=["']?([^"'\\s]+)["']?$`, 'mu').exec(buildBytes.toString());
      projection[key] = match?.[1] ?? '';
    }
    if (env.CI_BUNDLE_ID && env.CI_BUNDLE_ID !== grant.packageName) fail('RELEASE_EXCEPTION_EXECUTION_INPUTS_CHANGED');
  }
  if (!equal(projection, expected.expectedInputs)) fail('RELEASE_EXCEPTION_EXECUTION_INPUTS_CHANGED');
  const adsKeys = options.target === 'google-play'
    ? ['ADMOB_APP_ID', 'ADMOB_ANDROID_OFFLINE_REWARD_BOOST_REWARDED_AD_UNIT_ID', 'ADMOB_ANDROID_MATERIAL_BOX_FREE_REWARDED_AD_UNIT_ID', 'ADMOB_ANDROID_DAILY_SUPPLY_EXTRA_REWARDED_AD_UNIT_ID']
    : ['ADMOB_IOS_APP_ID', 'ADMOB_IOS_OFFLINE_REWARD_BOOST_REWARDED_AD_UNIT_ID', 'ADMOB_IOS_MATERIAL_BOX_FREE_REWARDED_AD_UNIT_ID', 'ADMOB_IOS_DAILY_SUPPLY_EXTRA_REWARDED_AD_UNIT_ID'];
  // iOS 소비자가 prepare 호출에 1을 고정한다. Android job env도 1로 고정한다.
  const adsProjection = { ADMOB_REQUIRE_PRODUCTION: env.ADMOB_REQUIRE_PRODUCTION ?? '1',
    ...Object.fromEntries(adsKeys.map(key => [key, String(env[key] ?? '').trim()])) };
  const admobInputSha256 = sha256(canonical(adsProjection));
  if (admobInputSha256 !== expected.admobInputSha256) fail('RELEASE_EXCEPTION_ADMOB_INPUT_CHANGED');
  const encoded = env[options.target === 'google-play' ? 'FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64' : 'FIREBASE_IOS_GOOGLE_SERVICE_INFO_PLIST_BASE64'];
  if (typeof encoded !== 'string' || !encoded.trim() || !/^[A-Za-z0-9+/=\s]+$/u.test(encoded)) fail('RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED');
  const registeredBytes = Buffer.from(encoded, 'base64');
  if (sha256(registeredBytes) !== expected.registeredClientConfigurationSha256) fail('RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED');
  const generator = join(root, 'scripts/release/generate_runtime_config.py');
  if (sha256(regularBytes(generator, 'RELEASE_EXCEPTION_RUNTIME_GENERATOR_CHANGED')) !== expected.generatorSha256) fail('RELEASE_EXCEPTION_RUNTIME_GENERATOR_CHANGED');
  let runtimeBytes, kind;
  if (options.phase === 'before-build') {
    const dir = mkdtempSync(join(tmpdir(), 'seori-release-configuration-'));
    try {
      const firebaseFile = join(dir, 'firebase-client'), out = join(dir, 'runtime.json');
      writeFileSync(firebaseFile, registeredBytes, { mode: 0o600 });
      const args = [generator, '--platform', options.target === 'google-play' ? 'android' : 'ios', '--firebase-config', firebaseFile,
        '--out', out, '--app-version', options.tag.slice(1), ...(projection.PROJECT_R_ANALYTICS_ENABLED === 'true' ? ['--analytics-enabled'] : [])];
      try { execFileSync('python3', args, { stdio: 'ignore', timeout: 10000, env: { PATH: process.env.PATH } }); }
      catch { fail('RELEASE_EXCEPTION_RUNTIME_GENERATION_FAILED'); }
      runtimeBytes = regularBytes(out, 'RELEASE_EXCEPTION_RUNTIME_CONFIG_CHANGED'); kind = 'generated-from-ci-input';
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } else {
    runtimeBytes = regularBytes(join(root, 'config', options.target === 'google-play' ? 'android_runtime.json' : 'ios_runtime.json'), 'RELEASE_EXCEPTION_RUNTIME_CONFIG_CHANGED');
    const registeredFile = join(root, options.target === 'google-play' ? 'google-services.json' : 'GoogleService-Info.plist');
    if (sha256(regularBytes(registeredFile, 'RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED')) !== expected.registeredClientConfigurationSha256) fail('RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED');
    kind = 'actual-runtime-file';
  }
  if (sha256(runtimeBytes) !== expected.runtimeConfigurationSha256) fail('RELEASE_EXCEPTION_RUNTIME_CONFIG_CHANGED');
  let injectedConfiguration = null;
  if (options.phase === 'before-deploy') {
    const projectDigest = sha256(regularBytes(join(root, 'project.godot'), 'RELEASE_EXCEPTION_INJECTED_ADS_CONFIGURATION_CHANGED'));
    const unitsDigest = sha256(regularBytes(join(root, 'data/ad_units.json'), 'RELEASE_EXCEPTION_INJECTED_ADS_CONFIGURATION_CHANGED'));
    if (projectDigest !== expected.injectedProjectSha256 || unitsDigest !== expected.injectedAdUnitsSha256) fail('RELEASE_EXCEPTION_INJECTED_ADS_CONFIGURATION_CHANGED');
    injectedConfiguration = { projectSha256: projectDigest, adUnitsSha256: unitsDigest };
  }
  return { kind, inputs: projection, registeredClientConfigurationSha256: sha256(registeredBytes), runtimeConfigurationSha256: sha256(runtimeBytes),
    generatorSha256: expected.generatorSha256, buildEnvironmentSha256: sha256(buildBytes),
    admobInputSha256, injectedConfiguration,
    remoteOperationalConfiguration: 'reviewed-snapshot-operator-fresh-readback-required' };
}

// 원래 관측 판정은 정규화하지 않는다. 전체 기능의 blocked/partial/unknown을 보존한다.
export function validateReleaseException(document, context) {
  if (!check(document)) fail('RELEASE_EXCEPTION_SCHEMA');
  const { grant, observations } = reviewedGrant(context.exceptionId);
  const now = Date.parse(context.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) fail('RELEASE_EXCEPTION_INVALID_TIME');
  for (const [key, expected] of Object.entries({ id: grant.id, repository: context.repository,
    sourceSha: context.sourceSha, target: context.target, releaseTag: context.tag,
    configurationFingerprint: context.configurationFingerprint, verifierSha: context.verifierSha })) {
    if (!expected || document[key] !== expected) fail(`RELEASE_EXCEPTION_BINDING_MISMATCH ${key}`);
  }
  if (document.repository !== grant.repository || document.releaseTag !== grant.releaseTag || !grant.targets.includes(document.target)
    || document.baselineSourceSha !== grant.baselineSourceSha || document.sourceSha === grant.baselineSourceSha) fail('RELEASE_EXCEPTION_SCOPE');
  if (!['before-build', 'before-deploy'].includes(context.phase) || !DIGEST.test(context.configurationFingerprint ?? '') || !SHA.test(context.verifierSha ?? '')) fail('RELEASE_EXCEPTION_CONTEXT_REQUIRED');
  if (context.configurationFingerprint !== grant.configurationFingerprints?.[context.target]) fail('RELEASE_EXCEPTION_CONFIGURATION_UNREVIEWED');
  if (context.verifierProof?.verified !== true || context.verifierProof.revision !== context.verifierSha) fail('RELEASE_EXCEPTION_VERIFIER_REVISION_UNVERIFIED');
  for (const key of ['approvedAt', 'approvalSha256', 'proposalSha256', 'observationsSha256', 'inventorySha256']) {
    if (document[key] !== grant[key]) fail(`RELEASE_EXCEPTION_APPROVAL_MISMATCH ${key}`);
  }
  const approvedAt = Date.parse(document.approvedAt), expiresAt = Date.parse(document.expiresAt);
  if (!(approvedAt <= now && now <= expiresAt && expiresAt > approvedAt && expiresAt - approvedAt <= grant.maxAgeHours * 3600000)) fail('RELEASE_EXCEPTION_EXPIRED');
  if (!equal(document.approvedRisks, grant.approvedRisks) || !equal(document.features, observations.features)) fail('RELEASE_EXCEPTION_ORIGINAL_STATUS_CHANGED');
  if (!observations.observations.every(item => Buffer.isBuffer(context.originalEvidence?.[item.asset])
    && sha256(context.originalEvidence[item.asset]) === item.sha256)) fail('RELEASE_EXCEPTION_ORIGINAL_EVIDENCE_MISSING_OR_CHANGED');
  if (!Buffer.isBuffer(context.approvalBytes) || sha256(context.approvalBytes) !== grant.approvalSha256) fail('RELEASE_EXCEPTION_HUMAN_APPROVAL_UNVERIFIED');
  if (!Buffer.isBuffer(context.inventoryBytes) || sha256(context.inventoryBytes) !== grant.inventorySha256) fail('RELEASE_EXCEPTION_INVENTORY_CHANGED');
  let inventory;
  try { inventory = JSON.parse(context.inventoryBytes); } catch { fail('RELEASE_EXCEPTION_INVENTORY_INVALID'); }
  if (inventory.schemaVersion !== 1 || !equal(inventory.features, document.features.map(({ id, core }) => ({ id, core }))) || inventory.features.length !== 26) fail('RELEASE_EXCEPTION_INVENTORY_CHANGED');
  if (!context.productTreeVerified || document.productTreeSha256 !== context.productTreeSha256) fail('RELEASE_EXCEPTION_PRODUCT_TREE_CHANGED');
  if (!Buffer.isBuffer(context.riskNotesBytes) || sha256(context.riskNotesBytes) !== document.riskNotesSha256) fail('RELEASE_EXCEPTION_RISK_NOTES_CHANGED');
  const notes = context.riskNotesBytes.toString('utf8');
  if (!notes.includes('human_exception') || !grant.approvedRisks.every(risk => notes.includes(risk))) fail('RELEASE_EXCEPTION_RISKS_NOT_RECORDED');
  if (!context.preflightOnly && (!document.releaseBinding || !equal(document.releaseBinding, context.releaseBinding))) fail('RELEASE_EXCEPTION_TAG_RECEIPT_MISMATCH');
  if (context.preflightOnly && document.releaseBinding !== null) fail('RELEASE_EXCEPTION_PREFLIGHT_ONLY');
  return { ok: true, decisionStatus: context.preflightOnly ? 'preflight_ready' : 'human_exception', productE2eStatus: 'blocked',
    verifiedAt: new Date(now).toISOString(),
    repository: document.repository, sourceSha: document.sourceSha, target: document.target, releaseTag: document.releaseTag,
    phase: context.phase, configurationFingerprint: document.configurationFingerprint, verifierSha: document.verifierSha,
    configurationObservationSha256: grant.configurationObservationSha256, verifierProof: context.verifierProof,
    exceptionId: grant.id, approvedAt: document.approvedAt, expiresAt: document.expiresAt,
    featureCount: document.features.length, features: document.features, approvedRisks: document.approvedRisks,
    approvalSha256: document.approvalSha256, observationsSha256: document.observationsSha256,
    originalEvidence: observations.observations,
    productTreeSha256: document.productTreeSha256, releaseBinding: document.releaseBinding,
    iosBuildProvenance: document.target === 'app-store' ? { ...grant.iosBuildProvenance,
      verificationScope: 'declared-protected-consumer-pin', actualHelperBytesThisPhaseVerified: false } : null, artifact: null };
}

async function releaseAssets(repository, tag, request) {
  let release;
  try { release = await githubJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, request); }
  catch (error) {
    if (error.status !== 404) throw error;
    const candidates = (await githubPaginate(`/repos/${repository}/releases?per_page=100`, request)).filter(item => item.tag_name === tag);
    if (candidates.length !== 1) fail('RELEASE_EXCEPTION_RELEASE_MISSING_OR_AMBIGUOUS');
    [release] = candidates;
  }
  if (release.tag_name !== tag || !Number.isSafeInteger(release.id)) fail('RELEASE_EXCEPTION_RELEASE_MISMATCH');
  const assets = await githubPaginate(`/repos/${repository}/releases/${release.id}/assets?per_page=100`, request);
  return async name => {
    const matches = assets.filter(asset => asset.name === name);
    if (matches.length !== 1) fail(`RELEASE_EXCEPTION_ASSET_MISSING_OR_AMBIGUOUS ${name}`);
    const asset = matches[0];
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 2 * 1024 * 1024) fail('RELEASE_EXCEPTION_ASSET_INVALID');
    const bytes = await githubDownload(`/repos/${repository}/releases/assets/${asset.id}`, request);
    if (bytes.length < 1 || bytes.length > 2 * 1024 * 1024) fail('RELEASE_EXCEPTION_ASSET_INVALID');
    return bytes;
  };
}

async function productTree(repository, sourceSha, allowed, request) {
  const commit = await githubJson(`/repos/${repository}/git/commits/${sourceSha}`, request);
  if (!SHA.test(commit.tree?.sha ?? '')) fail('RELEASE_EXCEPTION_TREE_UNREADABLE');
  const result = await githubJson(`/repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`, request);
  if (result.truncated !== false || !Array.isArray(result.tree) || result.tree.length === 0) fail('RELEASE_EXCEPTION_TREE_TRUNCATED');
  const entries = result.tree.filter(entry => entry.type !== 'tree');
  if (entries.some(entry => !entry.path || !['blob', 'commit'].includes(entry.type) || !SHA.test(entry.sha ?? '') || !/^[0-9]{6}$/u.test(entry.mode ?? ''))
    || new Set(entries.map(entry => entry.path)).size !== entries.length) fail('RELEASE_EXCEPTION_TREE_INVALID');
  if (allowed.some(path => !entries.some(entry => entry.path === path && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)))) fail('RELEASE_EXCEPTION_PIPELINE_FILE_MISSING');
  return entries.filter(entry => !allowed.includes(entry.path)).map(({ path, type, mode, sha }) => ({ path, type, mode, sha }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function tagBinding(repository, tag, sourceSha, request) {
  const ref = await githubJson(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, request);
  if (ref.ref !== `refs/tags/${tag}` || ref.object?.type !== 'tag' || !SHA.test(ref.object.sha ?? '')) fail('RELEASE_EXCEPTION_ANNOTATED_TAG_REQUIRED');
  const object = await githubJson(`/repos/${repository}/git/tags/${ref.object.sha}`, request);
  if (object.sha !== ref.object.sha || object.tag !== tag || object.object?.type !== 'commit' || object.object.sha !== sourceSha) fail('RELEASE_EXCEPTION_TAG_SOURCE_CHANGED');
  const receipt = parseTagReceipt(object.message);
  if (!receipt || receipt.tag !== tag || receipt.sourceSha !== sourceSha || receipt.versionName !== tag.slice(1)
    || receipt.authority !== 'release-version-authority-v1' || receipt.authorityRevision !== sha256(read('contracts/release-version-authority.yaml'))
    || receipt.androidVersionCodeSource !== 'github-ledger' || !/^[1-9][0-9]*$/u.test(receipt.androidVersionCode)
    || receipt.appleBuildNumber !== String(deriveEncodedVersion(tag))) fail('RELEASE_EXCEPTION_OFFICIAL_RECEIPT_REQUIRED');
  return { releaseBinding: { tagObjectSha: object.sha, tagReceiptSha256: sha256(object.message) }, tagReceipt: receipt };
}

export function validateIosArtifact({ binding, tagReceipt, metadata, bundleId, xcodeBuildNumber, exceptionId, tag, sourceSha }) {
  const { grant } = reviewedGrant(exceptionId), provenance = grant.iosBuildProvenance;
  if (!equal(Object.keys(binding).sort(), ['tag', 'sourceSha', 'runtimeVersionCode', 'appleMarketingVersion', 'appleBuildNumber', 'buildNumberAuthority', 'applied'].sort())
    || binding.tag !== tag || binding.sourceSha !== sourceSha || binding.buildNumberAuthority !== provenance.buildNumberAuthority || binding.applied !== true
    || binding.appleMarketingVersion !== tagReceipt.versionName || binding.runtimeVersionCode !== deriveTagEncodedVersionCode(tag)
    || !/^[1-9][0-9]*$/u.test(String(xcodeBuildNumber ?? '')) || !Number.isSafeInteger(binding.appleBuildNumber)
    || binding.appleBuildNumber > 2100000000 || Number(xcodeBuildNumber) !== binding.appleBuildNumber) fail('RELEASE_EXCEPTION_IOS_BUILD_AUTHORITY_MISMATCH');
  if (metadata.versionName !== binding.appleMarketingVersion || metadata.versionCode !== binding.appleBuildNumber) fail('RELEASE_EXCEPTION_IOS_ARTIFACT_VERSION_CHANGED');
  if (bundleId !== grant.packageName) fail('RELEASE_EXCEPTION_ARTIFACT_PACKAGE_CHANGED');
}

function artifactBinding(options, tagReceipt) {
  if (!options.artifactFile || !options.releaseBindingFile) fail('RELEASE_EXCEPTION_ARTIFACT_REQUIRED');
  if (options.target === 'app-store' && String((options.env ?? process.env).CI_BUILD_NUMBER ?? '') !== String(options.xcodeBuildNumber ?? '')) fail('RELEASE_EXCEPTION_IOS_BUILD_AUTHORITY_MISMATCH');
  const text = readFileSync(options.releaseBindingFile, 'utf8');
  const binding = options.target === 'google-play' ? parseReleaseBinding(text) : JSON.parse(text);
  if (binding.tag !== options.tag || binding.sourceSha !== options.sourceSha) fail('RELEASE_EXCEPTION_ARTIFACT_BINDING_CHANGED');
  const stat = lstatSync(options.artifactFile);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('RELEASE_EXCEPTION_ARTIFACT_NOT_REGULAR_FILE');
  const bytes = readFileSync(options.artifactFile), artifactDigest = sha256(bytes);
  if (options.target === 'google-play') {
    assertTagReceipt(binding, tagReceipt);
    if (!options.artifactReceiptFile) fail('RELEASE_EXCEPTION_ARTIFACT_RECEIPT_REQUIRED');
    const receipt = parseArtifactReceipt(readFileSync(options.artifactReceiptFile, 'utf8'));
    assertArtifactReceipt({ binding, kind: 'android-app-bundle', artifactDigest, receipt });
  } else {
    const plistJson = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', options.artifactFile], { encoding: 'utf8' });
    const metadata = parseInfoPlistJson(plistJson), plist = JSON.parse(plistJson);
    validateIosArtifact({ ...options, binding, tagReceipt, metadata, bundleId: plist.CFBundleIdentifier });
  }
  return { kind: options.target === 'google-play' ? 'android-app-bundle' : 'xcode-app-info-plist', sha256: artifactDigest,
    digestSource: options.target === 'google-play' ? 'artifact-file' : 'app-info-plist', versionName: tagReceipt.versionName,
    androidVersionCode: Number(tagReceipt.androidVersionCode), appleBuildNumber: binding.appleBuildNumber,
    tagReceiptAppleBuildNumber: Number(tagReceipt.appleBuildNumber), buildNumberAuthority: options.target === 'google-play' ? 'release-tag' : binding.buildNumberAuthority };
}

async function verifyException(options, launchRequestOnly = false, promotionOnly = false) {
  const { grant, approval, observations } = reviewedGrant(options.exceptionId);
  if (options.repository !== grant.repository || options.tag !== grant.releaseTag || !SHA.test(options.sourceSha ?? '')
    || !grant.targets.includes(options.target) || !DIGEST.test(options.configurationFingerprint ?? '') || !SHA.test(options.verifierSha ?? '')) fail('RELEASE_EXCEPTION_CONTEXT_REQUIRED');
  const env = options.env ?? process.env;
  if (promotionOnly && (launchRequestOnly || options.target !== 'google-play' || options.phase !== 'before-deploy' || options.preflightOnly
    || ['GITHUB_ACTIONS', 'CI_XCODE_CLOUD'].some(key => ['true', 'TRUE'].includes(env[key])))) fail('RELEASE_PROMOTION_FORBIDDEN_IN_CI');
  if (options.preflightOnly && ['CI', 'GITHUB_ACTIONS', 'CI_XCODE_CLOUD'].some(key => ['true', 'TRUE', '1'].includes(env[key]))) fail('RELEASE_EXCEPTION_PREFLIGHT_FORBIDDEN_IN_CI');
  if (options.preflightOnly && (!options.exceptionFile || options.phase !== 'before-build')) fail('RELEASE_EXCEPTION_PREFLIGHT_ONLY');
  if (launchRequestOnly) {
    if (env.CI_XCODE_CLOUD === 'TRUE') fail('RELEASE_EXCEPTION_XCODE_LAUNCH_REQUEST_FORBIDDEN_IN_CI_HOOK');
    const launch = options.launchRequest;
    if (options.preflightOnly || options.target !== 'app-store' || options.phase !== 'before-build'
      || !launch || !equal(Object.keys(launch).sort(), ['provider', 'workflowId', 'productId', 'repositoryId', 'referenceId', 'bundleId', 'referenceKind', 'referenceName'].sort())
      || launch.provider !== 'app-store-connect' || launch.workflowId !== grant.expectedXcodeWorkflowId
      || launch.bundleId !== grant.packageName || launch.referenceKind !== 'TAG' || launch.referenceName !== grant.releaseTag
      || ['productId', 'repositoryId', 'referenceId'].some(key => typeof launch[key] !== 'string' || !launch[key].trim())) fail('RELEASE_EXCEPTION_XCODE_LAUNCH_REQUEST_CHANGED');
  }
  if (options.configurationFingerprint !== grant.configurationFingerprints?.[options.target]) fail('RELEASE_EXCEPTION_CONFIGURATION_UNREVIEWED');
  const request = { token: options.token, env: { ...env, GITHUB_API_URL: 'https://api.github.com' }, fetchImpl: options.fetchImpl };
  const verifierProof = await runtimeRevision(grant, options.verifierSha, request);
  // pin된 검증기도 각 phase에서 최신 grant의 철회를 읽는다. 중앙의 무관 커밋은 결속을 바꾸지 않는다.
  let remoteGrantFile;
  try { remoteGrantFile = await githubJson(`/repos/seorilabs/.github/contents/contracts/release-exceptions/${grant.id}.json?ref=main`, request); }
  catch { fail('RELEASE_EXCEPTION_CURRENT_GRANT_UNREADABLE'); }
  if (remoteGrantFile.encoding !== 'base64' || typeof remoteGrantFile.content !== 'string') fail('RELEASE_EXCEPTION_CURRENT_GRANT_UNREADABLE');
  let remoteGrant;
  try { remoteGrant = JSON.parse(Buffer.from(remoteGrantFile.content, 'base64')); } catch { fail('RELEASE_EXCEPTION_CURRENT_GRANT_UNREADABLE'); }
  if (remoteGrant.revoked) fail('RELEASE_EXCEPTION_REVOKED');
  if (!equal(remoteGrant, grant)) fail('RELEASE_EXCEPTION_CURRENT_GRANT_CHANGED');
  let document, approvalBytes, riskNotesBytes, originalEvidence;
  if (options.preflightOnly) {
    document = JSON.parse(readFileSync(options.exceptionFile, 'utf8'));
    approvalBytes = approval;
    if (!options.riskNotesFile) fail('RELEASE_EXCEPTION_RISK_NOTES_REQUIRED');
    riskNotesBytes = readFileSync(options.riskNotesFile);
    if (!options.originalEvidenceDir) fail('RELEASE_EXCEPTION_ORIGINAL_EVIDENCE_REQUIRED');
    originalEvidence = Object.fromEntries(observations.observations.map(item => [item.asset, readFileSync(join(options.originalEvidenceDir, item.asset))]));
  } else {
    if (options.exceptionFile) fail('RELEASE_EXCEPTION_LOCAL_FILE_NOT_RELEASE_AUTHORITY');
    const download = await releaseAssets(options.repository, options.tag, request);
    document = JSON.parse(await download(`release-exception.${options.target}.json`));
    approvalBytes = await download('release-exception.approval.json');
    riskNotesBytes = await download('release-risk-notes.md');
    originalEvidence = Object.fromEntries(await Promise.all(observations.observations.map(async item => [item.asset, await download(item.asset)])));
  }
  const inventory = await githubJson(`/repos/${options.repository}/contents/docs/qa/feature-inventory.json?ref=${options.sourceSha}`, request);
  if (inventory.encoding !== 'base64' || typeof inventory.content !== 'string') fail('RELEASE_EXCEPTION_INVENTORY_UNREADABLE');
  const baselineTree = await productTree(options.repository, grant.baselineSourceSha, grant.allowedAppFiles, request);
  const candidateTree = await productTree(options.repository, options.sourceSha, grant.allowedAppFiles, request);
  const remoteBinding = options.preflightOnly ? {} : await tagBinding(options.repository, options.tag, options.sourceSha, request);
  const result = validateReleaseException(document, { ...options, approvalBytes, riskNotesBytes, originalEvidence, verifierProof,
    inventoryBytes: Buffer.from(inventory.content, 'base64'), productTreeVerified: equal(baselineTree, candidateTree),
    productTreeSha256: sha256(JSON.stringify(baselineTree)), ...remoteBinding });
  if (promotionOnly) return { ...result, ...await verifyPromotionEvidence(options, grant, result, remoteBinding.tagReceipt) };
  result.scope = options.preflightOnly ? 'manifest-preflight' : launchRequestOnly ? 'xcode-launch-request' : 'actual-ci-phase';
  result.actualCiVerification = options.preflightOnly || launchRequestOnly ? 'pending-ci-hook' : 'verified';
  result.executionConfiguration = options.preflightOnly || launchRequestOnly ? null : executionConfiguration(options, grant);
  if (launchRequestOnly) result.launchRequest = options.launchRequest;
  if (!options.preflightOnly && !launchRequestOnly && options.phase === 'before-deploy') result.artifact = artifactBinding(options, remoteBinding.tagReceipt);
  return result;
}

export async function verifyReleaseException(options) { return verifyException(options); }

// Xcode trigger 내부 경계. CLI로 노출하지 않으며 실제 CI hook에서는 사용할 수 없다.
// 이 보고서는 실제 CI의 두 phase를 대체하지 않는다.
export async function verifyXcodeLaunchRequest(options) { return verifyException(options, true); }

// 실제 성공 CI와 원격 job 로그가 증명한 원본만 재사용한다. 로컬 CI env 복제는 금지한다.
export async function verifyGooglePlayPromotion(options) { return verifyException(options, false, true); }
