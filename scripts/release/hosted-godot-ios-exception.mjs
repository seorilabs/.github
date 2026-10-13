import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { githubJson } from '../github-rest.mjs';
import { applyGodotExportVersion, applyGodotProjectVersion, assertArtifactReceipt, assertTagReceipt, parseArtifactReceipt, parseInfoPlistJson, parseReleaseBinding } from './tag-version-authority.mjs';

const fail = code => { throw new Error(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = ['title', 'first-run-tutorial', 'matching-game', 'wrong-answer-and-hint', 'timing-and-splits',
  'record-persistence', 'language-and-sound-settings', 'back-and-exit', 'safe-area-and-awake',
  'native-leaderboards', 'interstitial-and-privacy', 'ait-share', 'analytics'];
const mutable = ['godot/project.godot', 'godot/export_presets.cfg', 'godot/analytics.config.json'];
function bytes(path, code) {
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) fail(code); return readFileSync(path); }
  catch { fail(code); }
}
export function validateHostedEditorEvidence(observations, context, grant) {
  const inventory = JSON.parse(context.inventoryBytes);
  if (JSON.stringify(inventory.features.map(({ id }) => id)) !== JSON.stringify(ids)
    || inventory.features.some((feature, index) => feature.core !== (index < 9))) fail('RELEASE_EXCEPTION_INVENTORY_CHANGED');
  let e2e;
  try { e2e = JSON.parse(context.originalEvidence?.[observations.finalEditorEvidenceAsset]); }
  catch { fail('RELEASE_EXCEPTION_EDITOR_EVIDENCE_REQUIRED'); }
  if (e2e.schemaVersion !== 1 || e2e.sourceSha !== context.sourceSha || e2e.target !== 'app-store'
    || e2e.configurationFingerprint !== context.configurationFingerprint || e2e.inventorySha256 !== grant.inventorySha256
    || e2e.editorVerdict !== 'pass' || e2e.productE2eStatus !== 'blocked' || e2e.physicalDeviceExecution !== 'waived'
    || JSON.stringify(e2e.features?.map(({ id }) => id)) !== JSON.stringify(ids)) fail('RELEASE_EXCEPTION_EDITOR_EVIDENCE_CHANGED');
  const now = Date.parse(context.now ?? new Date().toISOString()), start = Date.parse(e2e.startedAt), end = Date.parse(e2e.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > now || now - end > 168 * 3600000) fail('RELEASE_EXCEPTION_EDITOR_EVIDENCE_EXPIRED');
  for (const feature of e2e.features) {
    const status = feature.id === 'ait-share' ? 'out_of_scope'
      : feature.id === 'analytics' && grant.executionConfiguration['app-store'].analyticsMode === 'disabled' ? 'expected_disabled' : 'pass_scoped';
    if (feature.editorStatus !== status) fail('RELEASE_EXCEPTION_EDITOR_FEATURE_NOT_VERIFIED');
  }
  return { startedAt: e2e.startedAt, completedAt: e2e.completedAt, sourceSha: e2e.sourceSha,
    editorVerdict: 'pass', physicalDeviceExecution: 'waived', productE2eStatus: 'blocked' };
}

function setting(text, key) {
  const separator = key.indexOf('::'), section = key.slice(0, separator), name = key.slice(separator + 2);
  let current = '', values = [];
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]$/u.exec(line.trim());
    if (header) current = header[1];
    else if (current === section && line.startsWith(`${name}=`)) values.push(line.slice(name.length + 1).trim());
  }
  if (values.length !== 1) fail('RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED');
  return values[0];
}

export function validateHostedConfiguration(options, grant) {
  const env = options.env ?? process.env, expected = grant.executionConfiguration['app-store'];
  if (options.target !== 'app-store' || !options.appRepository) fail('RELEASE_EXCEPTION_APP_REPOSITORY_REQUIRED');
  if (Object.entries(expected.expectedInputs).some(([key, value]) => String(env[key] ?? '') !== value)
    || env.GITHUB_SHA !== options.sourceSha || !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '')
    || !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? '') || env.CI_XCODE_CLOUD === 'TRUE') fail('RELEASE_EXCEPTION_EXECUTION_INPUTS_CHANGED');
  const root = resolve(options.appRepository);
  if (expected.analyticsMode !== 'disabled' || env.SEORI_ANALYTICS_SECRET_PRESENT !== 'false') fail('RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED');
  if (digest(bytes(join(root, '.github/workflows/deploy-app-store.yml'), 'RELEASE_EXCEPTION_APP_CALLER_CHANGED')) !== grant.callerSha256) fail('RELEASE_EXCEPTION_APP_CALLER_CHANGED');
  const analyticsBytes = bytes(join(root, 'godot/analytics.config.json'), 'RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED');
  let config; try { config = JSON.parse(analyticsBytes); } catch { fail('RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED'); }
  if (config.measurement_id !== '' || config.api_secret !== '') fail('RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED');
  if (digest(analyticsBytes) !== expected.analyticsConfigurationSha256) fail('RELEASE_EXCEPTION_REGISTERED_CONFIG_CHANGED');
  const git = args => execFileSync('git', ['-C', root, ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  let changed;
  try {
    if (git(['rev-parse', 'HEAD']).toString().trim() !== options.sourceSha) fail('RELEASE_EXCEPTION_SOURCE_CHANGED');
    changed = git(['diff', '--name-only', 'HEAD']).toString().trim().split('\n').filter(Boolean);
  } catch { fail('RELEASE_EXCEPTION_SOURCE_CHANGED'); }
  const generated = ['.seorilabs-release-authority/', 'godot/addons/admob/ios/bin/', 'godot/ios/plugins/ad_privacy/libmatch_ad_privacy.', 'templates/'];
  const untracked = git(['ls-files', '--others', '--exclude-standard']).toString().trim().split('\n').filter(Boolean);
  if (untracked.some(path => !generated.some(prefix => path.startsWith(prefix)) && !['godot.zip', 'export_templates.tpz'].includes(path))) fail('RELEASE_EXCEPTION_EXECUTION_SOURCE_CHANGED');
  if (changed.some(path => options.phase === 'before-build' || !mutable.includes(path))) fail('RELEASE_EXCEPTION_EXECUTION_SOURCE_CHANGED');
  const sourceHashes = {};
  for (const [path, hash] of Object.entries(expected.sourceFiles)) {
    let source;
    try { source = options.phase === 'before-deploy' && mutable.includes(path) ? git(['show', `HEAD:${path}`]) : bytes(join(root, path), 'RELEASE_EXCEPTION_EXECUTION_SOURCE_CHANGED'); }
    catch { fail('RELEASE_EXCEPTION_EXECUTION_SOURCE_CHANGED'); }
    if (digest(source) !== hash) fail('RELEASE_EXCEPTION_EXECUTION_SOURCE_CHANGED');
    sourceHashes[path] = hash;
  }
  let consumedSettings = null;
  if (options.phase === 'before-deploy') {
    const binding = parseReleaseBinding(bytes(options.releaseBindingFile, 'RELEASE_EXCEPTION_ARTIFACT_BINDING_CHANGED').toString());
    const expectedProject = applyGodotProjectVersion(git(['show', 'HEAD:godot/project.godot']).toString(), { binding });
    const expectedPresets = applyGodotExportVersion(git(['show', 'HEAD:godot/export_presets.cfg']).toString(), { platform: 'iOS', preset: 'iOS', binding });
    if (bytes(join(root, 'godot/project.godot'), 'RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED').toString() !== expectedProject
      || bytes(join(root, 'godot/export_presets.cfg'), 'RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED').toString() !== expectedPresets) fail('RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED');
    consumedSettings = {};
    for (const [path, settings] of Object.entries(expected.consumedSettings)) {
      const text = bytes(join(root, path), 'RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED').toString();
      consumedSettings[path] = {};
      for (const [key, value] of Object.entries(settings)) {
        const observed = setting(text, key);
        if (observed !== value) fail('RELEASE_EXCEPTION_CONSUMED_SETTINGS_CHANGED');
        consumedSettings[path][key] = observed;
      }
    }
  }
  return { kind: 'actual-hosted-ci-inputs', inputs: expected.expectedInputs, analyticsMode: expected.analyticsMode,
    analyticsConfigurationSha256: digest(analyticsBytes), sourceHashes, consumedSettings };
}

// public 저장소의 run/job 조회만 익명으로 수행해 기존 caller의 토큰 권한을 유지한다.
async function publicHostedJson(path, request) {
  const response = await (request.fetchImpl ?? globalThis.fetch)(`https://api.github.com${path}`, {
    method: 'GET', headers: { accept: 'application/vnd.github+json', 'user-agent': 'seorilabs-github-rest', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const rateLimited = [403, 429].includes(response.status) && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'));
    fail(`${rateLimited ? 'RELEASE_EXCEPTION_HOSTED_API_RATE_LIMITED' : 'RELEASE_EXCEPTION_HOSTED_API_UNREADABLE'} HTTP_${response.status}`);
  }
  return response.json();
}
export async function verifyHostedExecution(options, grant, request) {
  const result = validateHostedConfiguration(options, grant), env = options.env ?? process.env;
  const runPath = `/repos/${grant.repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const run = await publicHostedJson(runPath, request);
  if (String(run.id) !== env.GITHUB_RUN_ID || String(run.run_attempt) !== env.GITHUB_RUN_ATTEMPT
    || run.head_sha !== options.sourceSha || run.head_repository?.full_name !== grant.repository
    || run.event !== 'workflow_dispatch' || run.path?.split('@')[0] !== '.github/workflows/deploy-app-store.yml'
    || run.head_branch !== 'main' || run.status !== 'in_progress') fail('RELEASE_EXCEPTION_HOSTED_RUN_CHANGED');
  const path = '.github/workflows/godot-deploy-app-store.yml';
  const workflows = run.referenced_workflows?.filter(item => item.path === `seorilabs/.github/${path}@main`);
  if (workflows?.length !== 1 || !/^[a-f0-9]{40}$/u.test(workflows[0].sha ?? '')) fail('RELEASE_EXCEPTION_HOSTED_WORKFLOW_CHANGED');
  const workflowSha = workflows[0].sha;
  const ancestry = await githubJson(`/repos/seorilabs/.github/compare/${workflowSha}...main`, request);
  const remote = await githubJson(`/repos/seorilabs/.github/contents/${path}?ref=${workflowSha}`, request);
  if (!['ahead', 'identical'].includes(ancestry.status) || ancestry.base_commit?.sha !== workflowSha
    || remote.type !== 'file' || remote.encoding !== 'base64' || typeof remote.content !== 'string'
    || !Buffer.from(remote.content, 'base64').equals(readFileSync(new URL(`../../${path}`, import.meta.url)))) fail('RELEASE_EXCEPTION_HOSTED_WORKFLOW_CHANGED');
  const jobs = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await publicHostedJson(`${runPath}/jobs?per_page=100&page=${page}`, request);
    if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count)) fail('RELEASE_EXCEPTION_HOSTED_JOB_CHANGED');
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    if (page === 100 || result.jobs.length === 0) fail('RELEASE_EXCEPTION_HOSTED_JOB_CHANGED');
  }
  const matches = jobs.filter(job => job.name === 'app-store / Godot signed iOS archive' && job.status === 'in_progress'
    && job.runner_group_name === 'GitHub Actions' && JSON.stringify(job.labels) === JSON.stringify(['macos-26']));
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) fail('RELEASE_EXCEPTION_HOSTED_JOB_CHANGED');
  return { ...result, hostedExecution: { runId: run.id, runAttempt: run.run_attempt, jobId: matches[0].id,
    sourceSha: run.head_sha, workflowPath: run.path, runnerLabels: matches[0].labels,
    actualReusableWorkflowSha: workflowSha, actualReusableWorkflowBytesVerified: true } };
}

export function bindHostedArtifact(options, grant, tagReceipt) {
  if (!options.artifactFile || !options.releaseBindingFile || !options.artifactReceiptFile) fail('RELEASE_EXCEPTION_ARTIFACT_REQUIRED');
  const binding = parseReleaseBinding(bytes(options.releaseBindingFile, 'RELEASE_EXCEPTION_ARTIFACT_BINDING_CHANGED').toString());
  if (binding.sourceSha !== options.sourceSha || binding.tag !== options.tag) fail('RELEASE_EXCEPTION_ARTIFACT_BINDING_CHANGED');
  assertTagReceipt(binding, tagReceipt);
  const env = options.env ?? process.env, root = resolve(env.ARCHIVE_PATH ?? '');
  const plistPath = resolve(options.artifactFile);
  if (!env.ARCHIVE_PATH || !plistPath.startsWith(`${root}/Products/Applications/`) || !plistPath.endsWith('.app/Info.plist')) fail('RELEASE_EXCEPTION_ARTIFACT_PATH_CHANGED');
  bytes(plistPath, 'RELEASE_EXCEPTION_ARTIFACT_NOT_REGULAR_FILE');
  let plistBytes;
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', dirname(plistPath)], { stdio: 'ignore', timeout: 30000 });
    plistBytes = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]);
  } catch { fail('RELEASE_EXCEPTION_SIGNED_ARTIFACT_INVALID'); }
  const metadata = parseInfoPlistJson(plistBytes.toString()), plist = JSON.parse(plistBytes);
  if (plist.CFBundleIdentifier !== grant.packageName || metadata.versionName !== binding.appleMarketingVersion
    || metadata.versionCode !== binding.appleBuildNumber) fail('RELEASE_EXCEPTION_ARTIFACT_VERSION_CHANGED');
  const sha256 = digest(plistBytes);
  assertArtifactReceipt({ binding, kind: 'xcode-archive', artifactDigest: sha256,
    receipt: parseArtifactReceipt(bytes(options.artifactReceiptFile, 'RELEASE_EXCEPTION_ARTIFACT_RECEIPT_REQUIRED').toString()) });
  return { kind: 'xcode-archive', digestSource: 'app-info-plist-json', sha256,
    versionName: binding.appleMarketingVersion, appleBuildNumber: binding.appleBuildNumber,
    buildNumberAuthority: 'release-tag', signatureIntegrityVerified: true, signatureVerificationScope: 'archive-app-codesign-verify-deep-strict' };
}
