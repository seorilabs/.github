// Reascend 1.1.0 전용: 실제 internal 업로드 CI의 원본 bytes를 승격 직전에 다시 결속한다.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubDownload, githubJson, githubPaginate } from '../github-rest.mjs';
import { assertArtifactReceipt, assertTagReceipt, parseArtifactReceipt, parseReleaseBinding } from './tag-version-authority.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NAMES = ['app.aab', 'release-binding.json', 'release-artifact-receipt.txt', 'before-build.json', 'before-deploy.json'];
const WORKFLOW = '.github/workflows/godot-deploy-google-play.yml';
const LIMIT = 512 * 1024 * 1024;
const regular = path => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > LIMIT) fail('RELEASE_PROMOTION_BUNDLE_INVALID');
  return readFileSync(path);
};
const marker = (runId, attempt, manifestHash, zipHash) => `SEORI_REASCEND_PROMOTION_EVIDENCE_V1 run=${runId} attempt=${attempt} manifest=${manifestHash} zip=${zipHash}`;

export function createPromotionEvidence({ directory, outputFile, env = process.env }) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'seorilabs/reascend'
    || !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? '')) fail('RELEASE_PROMOTION_REAL_CI_REQUIRED');
  const files = Object.fromEntries(NAMES.map(name => [name, hash(regular(join(directory, name)))]));
  const report = JSON.parse(readFileSync(join(directory, 'before-deploy.json')));
  if (report.exceptionId !== 'reascend-1.1.0' || report.scope !== 'actual-ci-phase' || report.actualCiVerification !== 'verified'
    || report.decisionStatus !== 'human_exception' || report.productE2eStatus !== 'blocked') fail('RELEASE_PROMOTION_CI_REPORT_UNVERIFIED');
  const manifest = { schemaVersion: 1, repository: env.GITHUB_REPOSITORY, sourceSha: report.sourceSha,
    releaseTag: report.releaseTag, verifierSha: report.verifierSha, configurationFingerprint: report.configurationFingerprint,
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), files };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'manifest.json'), bytes);
  execFileSync('python3', ['-c', `import sys,zipfile,pathlib\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_DEFLATED) as z:\n for name in sys.argv[3:]: z.write(root/name,name)`,
    directory, outputFile, ...NAMES, 'manifest.json'], { stdio: 'ignore', timeout: 120000 });
  const manifestSha256 = hash(bytes), zipSha256 = hash(regular(outputFile));
  return { manifestSha256, zipSha256, logLine: marker(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, manifestSha256, zipSha256) };
}

function unpack(bundleFile, dir) {
  // 불필요한 파일·경로 탈출·심볼릭 링크·압축 폭탄을 거절하고 정해진 6개만 읽는다.
  try {
    execFileSync('python3', ['-c', `import sys,zipfile,pathlib,stat\nz=zipfile.ZipFile(sys.argv[1]); names=sys.argv[3:]\nitems=z.infolist()\nassert len(items)==len(names) and set(x.filename for x in items)==set(names)\nassert sum(x.file_size for x in items)<=512*1024*1024\nfor x in items:\n assert x.file_size>0 and not x.is_dir() and not stat.S_ISLNK(x.external_attr>>16)\n if x.filename!='app.aab': assert x.file_size<=2*1024*1024\n pathlib.Path(sys.argv[2],x.filename).write_bytes(z.read(x))`, bundleFile, dir, ...NAMES, 'manifest.json'],
    { stdio: 'ignore', timeout: 120000 });
  } catch { fail('RELEASE_PROMOTION_BUNDLE_INVALID'); }
}

export async function verifyPromotionEvidence(options, grant, common, tagReceipt) {
  const env = options.env ?? process.env;
  if (['GITHUB_ACTIONS', 'CI_XCODE_CLOUD'].some(key => ['true', 'TRUE'].includes(env[key]))) fail('RELEASE_PROMOTION_FORBIDDEN_IN_CI');
  if (grant.id !== 'reascend-1.1.0' || options.target !== 'google-play' || options.preflightOnly
    || !/^[1-9][0-9]*$/u.test(String(options.ciRunId ?? '')) || !/^[1-9][0-9]*$/u.test(String(options.ciRunAttempt ?? ''))
    || !options.evidenceBundleFile) fail('RELEASE_PROMOTION_CONTEXT_REQUIRED');
  if (!env.GOOGLE_PLAY_ACCESS_TOKEN || !/^[A-Za-z0-9_-]+$/u.test(env.GOOGLE_PLAY_READ_EDIT_ID ?? '')) fail('RELEASE_PROMOTION_PLAY_READ_IDENTITY_REQUIRED');
  const request = { token: options.token, env: { ...env, GITHUB_API_URL: 'https://api.github.com' }, fetchImpl: options.fetchImpl };
  const runId = Number(options.ciRunId), attempt = Number(options.ciRunAttempt);
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(attempt)) fail('RELEASE_PROMOTION_CONTEXT_REQUIRED');
  const run = await githubJson(`/repos/${grant.repository}/actions/runs/${runId}/attempts/${attempt}`, request);
  if (run.id !== runId || run.run_attempt !== attempt || run.status !== 'completed' || run.conclusion !== 'success'
    || run.head_sha !== common.sourceSha || run.repository?.full_name !== grant.repository || run.head_repository?.full_name !== grant.repository
    || !['workflow_dispatch', 'release', 'push'].includes(run.event) || run.path?.split('@')[0] !== '.github/workflows/deploy-google-play.yml') fail('RELEASE_PROMOTION_CI_RUN_UNVERIFIED');
  const workflow = run.referenced_workflows?.filter(item => item.path?.split('@')[0] === `seorilabs/.github/${WORKFLOW}`);
  if (workflow?.length !== 1 || !/^[a-f0-9]{40}$/u.test(workflow[0].sha ?? '')) fail('RELEASE_PROMOTION_WORKFLOW_UNVERIFIED');
  const workflowSha = workflow[0].sha;
  const ancestry = await githubJson(`/repos/seorilabs/.github/compare/${workflowSha}...main`, request);
  if (!['ahead', 'identical'].includes(ancestry.status) || ancestry.base_commit?.sha !== workflowSha) fail('RELEASE_PROMOTION_WORKFLOW_UNVERIFIED');
  const remoteWorkflow = await githubJson(`/repos/seorilabs/.github/contents/${WORKFLOW}?ref=${workflowSha}`, request);
  const localWorkflow = readFileSync(new URL(`../../${WORKFLOW}`, import.meta.url));
  if (remoteWorkflow.type !== 'file' || remoteWorkflow.encoding !== 'base64' || typeof remoteWorkflow.content !== 'string'
    || !Buffer.from(remoteWorkflow.content, 'base64').equals(localWorkflow)) fail('RELEASE_PROMOTION_WORKFLOW_CHANGED');
  const jobs = await githubPaginate(`/repos/${grant.repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, { ...request, select: page => page.jobs });
  const requiredSteps = ['Verify Editor E2E before-build', 'Verify Editor E2E before-deploy', 'Upload to Google Play', 'Package promotion evidence', 'Preserve promotion evidence bundle'];
  const matches = jobs.filter(job => requiredSteps.every(name => job.steps?.some(step => step.name === name && step.conclusion === 'success')));
  if (matches.length !== 1 || matches[0].run_id !== runId || matches[0].run_attempt !== attempt || matches[0].head_sha !== common.sourceSha
    || matches[0].status !== 'completed' || matches[0].conclusion !== 'success' || !Number.isSafeInteger(matches[0].id)) fail('RELEASE_PROMOTION_CI_JOB_UNVERIFIED');
  let log;
  try { log = (await githubDownload(`/repos/${grant.repository}/actions/jobs/${matches[0].id}/logs`, request)).toString('utf8'); }
  catch { fail('RELEASE_PROMOTION_LOG_PROOF_MISSING'); }
  const lines = log.split(/\r?\n/u).map(line => line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/u, ''));
  const prefix = `SEORI_REASCEND_PROMOTION_EVIDENCE_V1 run=${runId} attempt=${attempt} manifest=`;
  const proofs = lines.filter(line => line.startsWith(prefix));
  const proof = proofs.length === 1 && /^SEORI_REASCEND_PROMOTION_EVIDENCE_V1 run=[1-9][0-9]* attempt=[1-9][0-9]* manifest=([a-f0-9]{64}) zip=([a-f0-9]{64})$/u.exec(proofs[0]);
  if (!proof) fail('RELEASE_PROMOTION_LOG_PROOF_MISSING');
  let zipBytes;
  try { zipBytes = regular(options.evidenceBundleFile); } catch { fail('RELEASE_PROMOTION_BUNDLE_CHANGED'); }
  if (hash(zipBytes) !== proof[2]) fail('RELEASE_PROMOTION_BUNDLE_CHANGED');
  const dir = mkdtempSync(join(tmpdir(), 'seori-promotion-evidence-'));
  try {
    unpack(options.evidenceBundleFile, dir);
    const manifestBytes = regular(join(dir, 'manifest.json'));
    if (hash(manifestBytes) !== proof[1]) fail('RELEASE_PROMOTION_BUNDLE_CHANGED');
    const manifest = JSON.parse(manifestBytes);
    if (manifest.schemaVersion !== 1 || !equal(Object.keys(manifest.files ?? {}).sort(), [...NAMES].sort())
      || !equal(Object.keys(manifest).sort(), ['schemaVersion', 'repository', 'sourceSha', 'releaseTag', 'verifierSha', 'configurationFingerprint', 'runId', 'runAttempt', 'files'].sort())
      || manifest.runId !== runId || manifest.runAttempt !== attempt
      || ['repository', 'sourceSha', 'releaseTag', 'verifierSha', 'configurationFingerprint'].some(key => manifest[key] !== common[key])
      || NAMES.some(name => hash(regular(join(dir, name))) !== manifest.files[name])) fail('RELEASE_PROMOTION_BUNDLE_CHANGED');
    const expected = grant.executionConfiguration['google-play'];
    for (const phase of ['before-build', 'before-deploy']) {
      const report = JSON.parse(regular(join(dir, `${phase}.json`)));
      if (report.ok !== true || report.scope !== 'actual-ci-phase' || report.actualCiVerification !== 'verified' || report.phase !== phase
        || ['decisionStatus', 'productE2eStatus', 'repository', 'sourceSha', 'target', 'releaseTag', 'verifierSha', 'exceptionId', 'configurationFingerprint',
          'features', 'featureCount', 'approvedRisks', 'configurationObservationSha256', 'originalEvidence',
          'approvalSha256', 'observationsSha256', 'productTreeSha256', 'approvedAt', 'expiresAt', 'releaseBinding'].some(key => !equal(report[key], common[key]))
        || report.verifierProof?.verified !== true || report.verifierProof.revision !== common.verifierSha
        || !equal(report.verifierProof.files, common.verifierProof.files)
        || !(Date.parse(run.run_started_at) <= Date.parse(report.verifiedAt) && Date.parse(report.verifiedAt) <= Date.parse(run.updated_at))) fail('RELEASE_PROMOTION_CI_REPORT_UNVERIFIED');
      const actual = report.executionConfiguration;
      if (!actual || !equal(actual.inputs, expected.expectedInputs) || actual.kind !== (phase === 'before-build' ? 'generated-from-ci-input' : 'actual-runtime-file')
        || ['registeredClientConfigurationSha256', 'runtimeConfigurationSha256', 'generatorSha256', 'buildEnvironmentSha256', 'admobInputSha256'].some(key => actual[key] !== expected[key])
        || (phase === 'before-deploy' && !equal(actual.injectedConfiguration, { projectSha256: expected.injectedProjectSha256, adUnitsSha256: expected.injectedAdUnitsSha256 }))) fail('RELEASE_PROMOTION_CI_CONFIGURATION_CHANGED');
    }
    const binding = parseReleaseBinding(regular(join(dir, 'release-binding.json')).toString());
    assertTagReceipt(binding, tagReceipt);
    const aabSha256 = manifest.files['app.aab'];
    assertArtifactReceipt({ binding, kind: 'android-app-bundle', artifactDigest: aabSha256,
      receipt: parseArtifactReceipt(regular(join(dir, 'release-artifact-receipt.txt')).toString()) });
    const artifact = JSON.parse(regular(join(dir, 'before-deploy.json'))).artifact;
    if (artifact?.sha256 !== aabSha256 || artifact.kind !== 'android-app-bundle' || artifact.versionName !== binding.versionName
      || artifact.androidVersionCode !== binding.androidVersionCode) fail('RELEASE_PROMOTION_CI_ARTIFACT_CHANGED');
    let track;
    try {
      const response = await (options.fetchImpl ?? globalThis.fetch)(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(grant.packageName)}/edits/${encodeURIComponent(env.GOOGLE_PLAY_READ_EDIT_ID)}/tracks/internal`,
        { method: 'GET', headers: { authorization: `Bearer ${env.GOOGLE_PLAY_ACCESS_TOKEN}`, accept: 'application/json' } });
      if (!response.ok) fail('RELEASE_PROMOTION_PLAY_INTERNAL_UNVERIFIED');
      track = await response.json();
    } catch { fail('RELEASE_PROMOTION_PLAY_INTERNAL_UNVERIFIED'); }
    if (track.track !== 'internal' || !track.releases?.some(item => item.status === 'completed' && item.versionCodes?.includes(String(binding.androidVersionCode)))) fail('RELEASE_PROMOTION_PLAY_INTERNAL_UNVERIFIED');
    return { scope: 'promotion-recheck', actualCiVerification: 'reused-successful-ci', artifact,
      ciProof: { provider: 'github-actions', runId, runAttempt: attempt, jobId: matches[0].id, workflowSha,
        workflowSha256: hash(localWorkflow), verifierSha: common.verifierSha, manifestSha256: proof[1], bundleSha256: proof[2],
        authority: 'successful-remote-run-and-job-log', ciEnvironmentRecreated: false },
      executionConfiguration: JSON.parse(regular(join(dir, 'before-deploy.json'))).executionConfiguration,
      playTrack: { track: 'internal', versionCode: binding.androidVersionCode, status: 'completed', freshReadVerified: true } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
