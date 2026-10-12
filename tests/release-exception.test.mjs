import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}\n');
symlinkSync(join(repo, 'node_modules'), join(sandbox, 'node_modules'), 'dir');
writeFileSync(join(sandbox, `contracts/release-exceptions/${grant.observationsFile}`), observationsBytes);
writeFileSync(join(sandbox, 'contracts/release-exceptions/reascend-1.1.0.json'), JSON.stringify(grant));
after(() => rmSync(sandbox, { recursive: true, force: true }));
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
    verifierSha: VERIFIER, configurationFingerprint: '1'.repeat(64), inventorySha256: digest(inventoryBytes), productTreeSha256: productTreeHash,
    approvedAt: grant.approvedAt, expiresAt: new Date(Date.parse(grant.approvedAt) + 168 * 3600000).toISOString(),
    approvalSha256: grant.approvalSha256, proposalSha256: grant.proposalSha256, observationsSha256: grant.observationsSha256,
    approvedRisks: grant.approvedRisks, features: observations.features, riskNotesSha256: digest(riskNotes),
    releaseBinding: { tagObjectSha: TAG_OBJECT, tagReceiptSha256: digest(receipt) },
    decisionStatus: 'human_exception', productE2eStatus: 'blocked' };
}
function github({ manifest = fixture(), changedProduct = false, approvalBytes = approval, duplicate = false,
  originalBytes = originals, missingOriginal = false,
  treeTruncated = false, tagMessage = receipt, tagSource = SOURCE, riskBytes = riskNotes, remoteGrant = grant } = {}) {
  const calls = [];
  const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/repos/seorilabs/.github/contents/contracts/release-exceptions/')) return remoteGrant === null
      ? new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
      : reply({ encoding: 'base64', content: Buffer.from(JSON.stringify(remoteGrant)).toString('base64') });
    if (url.includes('/releases/tags/')) return reply({ id: 1, tag_name: grant.releaseTag });
    if (url.includes('/releases/1/assets?')) return reply([
      { id: 10, name: `release-exception.${manifest.target}.json`, size: 10000 },
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
  configurationFingerprint: '1'.repeat(64), verifierSha: VERIFIER, exceptionId: grant.id, token: 'fixture-token', now: new Date(Date.parse(grant.approvedAt) + 60000).toISOString() };

test('explicit reviewed release exception preserves all 26 original verdicts and blocked E2E', async () => {
  const api = github();
  const result = await verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: api.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.decisionStatus, 'human_exception');
  assert.equal(result.productE2eStatus, 'blocked');
  assert.equal(result.featureCount, 26);
  assert.deepEqual(result.features, observations.features);
  assert.equal(result.artifact, null);
});

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
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github({ manifest }).fetchImpl }), /RELEASE_EXCEPTION/u);
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
  await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, fetchImpl: github(changes).fetchImpl }), /RELEASE_EXCEPTION/u);
});
test('expired exception and missing runtime fingerprint fail without fallback', async () => {
  for (const changes of [{ now: new Date(Date.parse(grant.approvedAt) + 169 * 3600000).toISOString() }, { configurationFingerprint: undefined }, { exceptionId: 'unreviewed' }]) {
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, ...changes, fetchImpl: github().fetchImpl }), /RELEASE_EXCEPTION/u);
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
test('local preflight cannot manufacture an executed E2E or build authorization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-exception-preflight-'));
  try {
    const exceptionFile = join(dir, 'exception.json'), riskNotesFile = join(dir, 'risk.md');
    const manifest = fixture(); manifest.releaseBinding = null;
    writeFileSync(exceptionFile, JSON.stringify(manifest)); writeFileSync(riskNotesFile, riskNotes);
    const originalEvidenceDir = join(dir, 'originals'); mkdirSync(originalEvidenceDir);
    for (const [asset, bytes] of Object.entries(originals)) writeFileSync(join(originalEvidenceDir, asset), bytes);
    const api = github();
    const result = await verifyReleaseDevelopmentEvidence({ ...context, preflightOnly: true, exceptionFile, riskNotesFile, originalEvidenceDir, fetchImpl: api.fetchImpl });
    assert.equal(result.decisionStatus, 'preflight_ready'); assert.equal(result.productE2eStatus, 'blocked');
    assert.ok(!api.calls.some(url => url.includes('/releases') || url.includes('/git/ref/tags/')));
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, preflightOnly: true, exceptionFile, riskNotesFile, fetchImpl: github().fetchImpl }), /ORIGINAL_EVIDENCE_REQUIRED/u);
    writeFileSync(join(originalEvidenceDir, observations.observations[0].asset), 'modified original');
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, preflightOnly: true, exceptionFile, riskNotesFile, originalEvidenceDir, fetchImpl: github().fetchImpl }), /ORIGINAL_EVIDENCE_MISSING_OR_CHANGED/u);
    await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, exceptionFile, riskNotesFile, fetchImpl: github().fetchImpl }), /LOCAL_FILE_NOT_RELEASE_AUTHORITY/u);
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
    for (const phase of ['before-build', 'before-deploy']) await assert.rejects(verifyReleaseDevelopmentEvidence({ ...context, phase, fetchImpl: github({ remoteGrant }).fetchImpl }));
  });
}
