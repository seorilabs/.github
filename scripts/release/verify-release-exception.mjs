// 별도 사람 승인 예외는 제품 E2E 통과를 뜻하지 않는다. 검토된 중앙 grant가 신뢰 기준이다.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { githubDownload, githubJson, githubPaginate } from '../github-rest.mjs';
import { assertArtifactReceipt, assertTagReceipt, deriveEncodedVersion, deriveTagEncodedVersionCode,
  parseArtifactReceipt, parseInfoPlistJson, parseReleaseBinding, parseTagReceipt } from './tag-version-authority.mjs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url));
const schema = JSON.parse(read('contracts/release-exception.schema.json'));
const check = new Ajv2020({ allErrors: true }).compile(schema);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{40}$/u, DIGEST = /^[a-f0-9]{64}$/u;
const grants = new Map(parse(read('contracts/development-workflow.yaml').toString()).releaseExceptions.grantRegistry.map(path => {
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
  if (grant.revoked || grant.id !== id) fail('RELEASE_EXCEPTION_REVOKED');
  const prefix = 'contracts/release-exceptions/';
  const approval = read(`${prefix}${grant.approvalFile}`), observations = read(`${prefix}${grant.observationsFile}`);
  if (sha256(approval) !== grant.approvalSha256 || sha256(observations) !== grant.observationsSha256) fail('RELEASE_EXCEPTION_TRUST_ANCHOR_CHANGED');
  return { grant, approval, observations: JSON.parse(observations) };
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
    repository: document.repository, sourceSha: document.sourceSha, target: document.target, releaseTag: document.releaseTag,
    phase: context.phase, configurationFingerprint: document.configurationFingerprint, verifierSha: document.verifierSha,
    exceptionId: grant.id, approvedAt: document.approvedAt, expiresAt: document.expiresAt,
    featureCount: document.features.length, features: document.features, approvedRisks: document.approvedRisks,
    approvalSha256: document.approvalSha256, observationsSha256: document.observationsSha256,
    originalEvidence: observations.observations,
    productTreeSha256: document.productTreeSha256, releaseBinding: document.releaseBinding,
    iosBuildProvenance: document.target === 'app-store' ? grant.iosBuildProvenance : null, artifact: null };
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
  return { kind: options.target === 'google-play' ? 'android-app-bundle' : 'xcode-archive', sha256: artifactDigest,
    digestSource: options.target === 'google-play' ? 'artifact-file' : 'app-info-plist', versionName: tagReceipt.versionName,
    androidVersionCode: Number(tagReceipt.androidVersionCode), appleBuildNumber: binding.appleBuildNumber,
    tagReceiptAppleBuildNumber: Number(tagReceipt.appleBuildNumber), buildNumberAuthority: options.target === 'google-play' ? 'release-tag' : binding.buildNumberAuthority };
}

export async function verifyReleaseException(options) {
  const { grant, approval, observations } = reviewedGrant(options.exceptionId);
  if (options.repository !== grant.repository || options.tag !== grant.releaseTag || !SHA.test(options.sourceSha ?? '')
    || !grant.targets.includes(options.target) || !DIGEST.test(options.configurationFingerprint ?? '') || !SHA.test(options.verifierSha ?? '')) fail('RELEASE_EXCEPTION_CONTEXT_REQUIRED');
  if (options.preflightOnly && (!options.exceptionFile || options.phase !== 'before-build')) fail('RELEASE_EXCEPTION_PREFLIGHT_ONLY');
  const request = { token: options.token, env: options.env, fetchImpl: options.fetchImpl };
  // pin된 검증기도 각 phase에서 최신 grant의 철회를 읽는다. 중앙의 무관 커밋은 결속을 바꾸지 않는다.
  const remoteGrantFile = await githubJson(`/repos/seorilabs/.github/contents/contracts/release-exceptions/${grant.id}.json?ref=main`, request);
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
  const result = validateReleaseException(document, { ...options, approvalBytes, riskNotesBytes, originalEvidence,
    inventoryBytes: Buffer.from(inventory.content, 'base64'), productTreeVerified: equal(baselineTree, candidateTree),
    productTreeSha256: sha256(JSON.stringify(baselineTree)), ...remoteBinding });
  if (!options.preflightOnly && options.phase === 'before-deploy') result.artifact = artifactBinding(options, remoteBinding.tagReceipt);
  return result;
}
