#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { githubDownload, githubJson, githubPaginate } from '../github-rest.mjs';
import { verifyReleaseException } from './verify-release-exception.mjs';

const schema = JSON.parse(readFileSync(new URL('../../contracts/development-evidence.schema.json', import.meta.url), 'utf8'));
const checkSchema = new Ajv2020({ allErrors: true }).compile(schema);
const policy = parse(readFileSync(new URL('../../contracts/development-workflow.yaml', import.meta.url), 'utf8'));
const MAX_E2E_AGE_MS = policy.editorE2e.maxAgeHours * 60 * 60 * 1000;
const MAX_CARRY_FORWARD_MS = policy.foundationFeatures.carryForwardMaxAgeDays * 24 * 60 * 60 * 1000;
// compare API는 변경 파일을 최대 300개만 준다. 300개면 잘렸을 수 있으므로 판정 불가로 보고, 로컬 git 비교도 같은 기준을 쓴다.
const COMPARE_FILE_LIMIT = 300;
const INVENTORY_PATH = 'docs/qa/feature-inventory.json';

const validInventoryFeature = f => typeof f.id === 'string' && f.id.trim() && typeof f.core === 'boolean'
  && (f.foundation === undefined || typeof f.foundation === 'boolean')
  && (f.foundation !== true || (Array.isArray(f.paths) && f.paths.length > 0 && f.paths.every(p => typeof p === 'string' && p.trim())));
// glob의 **는 점으로 시작하는 파일을 건너뛴다. 양쪽의 선행 점을 지운 비교도 하여 놓치지 않는다(오탐은 재실행일 뿐이다).
const undotted = value => value.replace(/(^|\/)\./gu, '$1');
const touches = (file, pattern) => posix.matchesGlob(file, pattern) || posix.matchesGlob(undotted(file), undotted(pattern));
const sameDefinition = (a, b) => a?.foundation === true && b?.foundation === true && Array.isArray(a.paths) && Array.isArray(b.paths)
  && JSON.stringify([...a.paths].sort()) === JSON.stringify([...b.paths].sort());
const withinCompareLimit = files => files.length < COMPARE_FILE_LIMIT ? files : null;

// 영향 없는 기반 기능은 실제로 통과한 기준 SHA의 근거를 이어받는다. 기준부터 후보까지 바뀐 파일이 그 기능의
// paths와 겹치거나, 비교할 수 없거나, 기능 정의가 달라졌거나, 실제 실행이 기한을 넘었으면 다시 실행해야 한다.
function carriedForwardFeatures(document, context, inventoryFeatures, now, errors) {
  const carried = new Set();
  for (const item of document.carriedForward ?? []) {
    if (carried.has(item.featureId)) { errors.push('DUPLICATE carried-forward'); continue; }
    carried.add(item.featureId);
    const feature = inventoryFeatures.find(f => f.id === item.featureId);
    if (feature?.foundation !== true) { errors.push(`CARRY_FORWARD_NOT_FOUNDATION ${item.featureId}`); continue; }
    const verifiedAt = Date.parse(item.verifiedAt);
    if (!(verifiedAt <= now) || now - verifiedAt > MAX_CARRY_FORWARD_MS) errors.push(`CARRY_FORWARD_EXPIRED ${item.featureId}`);
    const baseline = context.baselines?.[item.baselineSha];
    if (!Array.isArray(baseline?.changedFiles)) { errors.push(`CARRY_FORWARD_DIFF_UNAVAILABLE ${item.featureId}`); continue; }
    if (!sameDefinition(feature, baseline.inventory?.features?.find(f => f.id === item.featureId))) errors.push(`CARRY_FORWARD_INVENTORY_CHANGED ${item.featureId}`);
    if (baseline.changedFiles.some(file => feature.paths.some(pattern => touches(file, pattern)))) errors.push(`CARRY_FORWARD_AFFECTED ${item.featureId}`);
  }
  return carried;
}

export function validateDevelopmentEvidence(document, context) {
  const errors = [];
  if (!checkSchema(document)) {
    return { ok: false, errors: [...new Set(checkSchema.errors.map(e => `EVIDENCE_SCHEMA ${e.instancePath || '/'}: ${e.keyword}`))] };
  }
  const now = Date.parse(context.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) errors.push('INVALID_CURRENT_TIME');
  for (const key of ['repository', 'sourceSha', 'target']) {
    if (document[key] !== context[key]) errors.push(`CANDIDATE_MISMATCH ${key}`);
  }
  const times = (value, label) => {
    const plan = Date.parse(value.plannedAt), start = Date.parse(value.startedAt), end = Date.parse(value.completedAt);
    if (![plan, start, end].every(Number.isFinite) || plan > start || start > end || end > now) errors.push(`EXECUTION_ORDER ${label}`);
  };
  const unique = (values, label) => {
    if (new Set(values).size !== values.length) errors.push(`DUPLICATE ${label}`);
  };
  const features = document.features.map(f => f.id);
  const core = document.features.filter(f => f.core).map(f => f.id);
  const inventory = context.featureInventory;
  const inventoryValid = inventory?.schemaVersion === 1 && Array.isArray(inventory.features) && inventory.features.length > 0 && inventory.features.every(validInventoryFeature);
  if (!inventoryValid) {
    errors.push('SOURCE_FEATURE_INVENTORY_REQUIRED');
  } else {
    const key = f => `${f.id}:${f.core}`;
    const actual = document.features.map(key).sort();
    const expected = inventory.features.map(key).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected) || new Set(inventory.features.map(f => f.id)).size !== inventory.features.length) errors.push('SOURCE_FEATURE_INVENTORY_MISMATCH');
  }
  const conditions = document.acceptance.map(a => a.id);
  unique(features, 'feature'); unique(conditions, 'acceptance');
  const carried = carriedForwardFeatures(document, context, inventoryValid ? inventory.features : [], now, errors);
  const covered = (ids, expected, label) => {
    if (expected.some(id => !carried.has(id) && !ids.includes(id)) || ids.some(id => !features.includes(id))) errors.push(`FEATURE_COVERAGE ${label}`);
  };
  const tddIds = document.tdd.map(t => t.acceptanceId);
  unique(tddIds, 'tdd');
  if (conditions.some(id => !tddIds.includes(id)) || tddIds.some(id => !conditions.includes(id))) errors.push('TDD_ACCEPTANCE_COVERAGE');
  const ui = document.productKind === 'ui';
  if (context.requireUi !== false && !ui) errors.push('UI_REQUIRED');
  if (ui && (document.iterations.length < policy.uiReview.rounds || core.length === 0)) errors.push('THREE_UI_ROUNDS_REQUIRED');
  if (!ui && document.iterations.length !== 0) errors.push('SERVICE_WITH_UI_ROUNDS');
  let previousEnd = 0;
  document.iterations.forEach((round, index) => {
    if (round.number !== index + 1) errors.push('ROUND_SEQUENCE');
    times(round, `round-${round.number}`);
    if (Date.parse(round.plannedAt) < previousEnd) errors.push('ROUND_OVERLAP');
    previousEnd = Date.parse(round.completedAt);
    if (round.reviewer.trim().toLowerCase() === document.implementer.trim().toLowerCase()) errors.push('INDEPENDENT_REVIEW_REQUIRED');
    covered(round.functional.featureIds, core, `functional-${round.number}`);
    covered(round.ux.featureIds, core, `ux-${round.number}`);
    for (const aspect of ['functional', 'ux']) {
      const result = round[aspect];
      if (result.status !== 'passed' && (index === document.iterations.length - 1 || !result.resolutionEvidence)) errors.push(`UNRESOLVED_REVIEW ${round.number}-${aspect}`);
    }
    if (round.number > policy.uiReview.rounds) {
      const approval = document.additionalIterationApproval;
      if (!approval || approval.maxRound < round.number || !Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt) > Date.parse(round.plannedAt)) errors.push('EXTRA_ROUND_APPROVAL_REQUIRED');
    }
  });
  const e2e = document.e2e;
  times(e2e, 'e2e');
  // 같은 후보의 통과한 빌드 직전 E2E는 배포 직전에도 쓴다(phaseReuse). 배포 직전 실행이 빌드 직전을 대신하지는 않는다.
  const phaseServes = e2e.phase === context.phase || (context.phase === 'before-deploy' && e2e.phase === 'before-build');
  if (!phaseServes || e2e.sourceSha !== context.sourceSha) errors.push('E2E_CANDIDATE_OR_PHASE_MISMATCH');
  if (Date.parse(e2e.plannedAt) < previousEnd) errors.push('E2E_BEFORE_REVIEW_FINISHED');
  if (now - Date.parse(e2e.completedAt) > MAX_E2E_AGE_MS) errors.push('E2E_EXPIRED');
  if (context.configurationFingerprint && e2e.environment.configurationFingerprint !== context.configurationFingerprint) errors.push('CONFIGURATION_CHANGED');
  if (ui && e2e.environment.kind === 'service-runtime') errors.push('UI_RUNTIME_REQUIRED');
  if (!ui && e2e.environment.kind !== 'service-runtime') errors.push('SERVICE_RUNTIME_REQUIRED');
  unique(e2e.scenarios.map(s => s.id), 'scenario');
  covered(e2e.scenarios.flatMap(s => s.featureIds), features, 'e2e-all-implemented-features');
  return { ok: errors.length === 0, errors };
}

const EVIDENCE_ARCHIVE_TAG = 'development-evidence';

const baselineShas = document => checkSchema(document) ? [...new Set((document.carriedForward ?? []).map(item => item.baselineSha))] : [];

async function readRemoteInventory(repository, ref, request) {
  const inventoryFile = await githubJson(`/repos/${repository}/contents/${INVENTORY_PATH}?ref=${ref}`, request);
  if (inventoryFile?.encoding !== 'base64' || typeof inventoryFile.content !== 'string') throw new Error('SOURCE_FEATURE_INVENTORY_UNREADABLE');
  try { return JSON.parse(Buffer.from(inventoryFile.content, 'base64').toString('utf8')); }
  catch { throw new Error('SOURCE_FEATURE_INVENTORY_INVALID_JSON'); }
}

// 로컬 --file 검증은 현재 저장소의 git으로 Release 검증과 같은 비교를 한다. compare API처럼 이름 변경을 한 건으로 세고
// 전후 경로를 모두 보며, 한글 등 비ASCII 경로가 따옴표로 바뀌지 않도록 NUL 구분 출력을 읽는다.
function parseNameStatus(output) {
  const parts = output.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const width = /^[RC]/u.test(parts[i]) ? 2 : 1;
    entries.push(parts.slice(i + 1, i + 1 + width));
    i += 1 + width;
  }
  return entries;
}

function readLocalBaselines(document, sourceSha) {
  const git = (...args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const baselines = {};
  if (!/^[a-f0-9]{40}$/u.test(sourceSha ?? '')) return baselines;
  for (const baselineSha of baselineShas(document)) {
    const diff = git('merge-base', '--is-ancestor', baselineSha, sourceSha).status === 0 ? git('diff', '--name-status', '--find-renames', '-z', baselineSha, sourceSha) : null;
    const inventory = git('show', `${baselineSha}:${INVENTORY_PATH}`);
    let parsed = null;
    try { parsed = inventory.status === 0 ? JSON.parse(inventory.stdout) : null; } catch { parsed = null; }
    baselines[baselineSha] = { changedFiles: diff?.status === 0 ? withinCompareLimit(parseNameStatus(diff.stdout))?.flat() ?? null : null, inventory: parsed };
  }
  return baselines;
}

/**
 * 태그 없는 build-only·웹 검수 보관함은 draft Release 다. GitHub 의 태그 조회
 * (`GET /releases/tags/{tag}`)는 draft 를 돌려주지 않으므로 목록에서 찾는다. 목록의 draft 는
 * 저장소 push 권한이 있는 토큰에만 보인다 — 읽기 전용 토큰이면 보관함 없음으로 멈춘다.
 */
async function findEvidenceArchive(repository, request) {
  const releases = await githubPaginate(`/repos/${repository}/releases?per_page=100`, request);
  const archives = releases.filter(release => release.tag_name === EVIDENCE_ARCHIVE_TAG && release.draft === true);
  if (archives.length !== 1) {
    throw new Error(`DEVELOPMENT_EVIDENCE_ARCHIVE_${archives.length === 0 ? 'MISSING' : 'AMBIGUOUS'} draft Release '${EVIDENCE_ARCHIVE_TAG}' ${archives.length}개 (목록의 draft 는 push 권한 토큰에만 보인다)`);
  }
  return archives[0];
}

export async function verifyReleaseDevelopmentEvidence(options) {
  if (options.exceptionId) return verifyReleaseException(options);
  const { repository, tag, sourceSha, target, phase, token, env = process.env, fetchImpl = globalThis.fetch } = options;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository ?? '') || !/^[a-f0-9]{40}$/u.test(sourceSha ?? '') || !['before-build', 'before-deploy'].includes(phase) || !['apps-in-toss', 'google-play', 'app-store', 'web', 'service'].includes(target) || !tag) throw new Error('INVALID_EVIDENCE_CONTEXT');
  const request = { token, env, fetchImpl };
  const release = tag === EVIDENCE_ARCHIVE_TAG
    ? await findEvidenceArchive(repository, request)
    : await githubJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, request);
  const assets = await githubPaginate(`/repos/${repository}/releases/${release.id}/assets?per_page=100`, request);
  const nameFor = assetPhase => tag === EVIDENCE_ARCHIVE_TAG
    ? `development-evidence.${sourceSha}.${target}.${assetPhase}.json`
    : `development-evidence.${target}.${assetPhase}.json`;
  // 배포 직전 보고서가 따로 없으면 같은 후보의 빌드 직전 보고서를 읽는다(phaseReuse).
  const candidates = phase === 'before-deploy' ? [nameFor('before-deploy'), nameFor('before-build')] : [nameFor(phase)];
  const assetName = candidates.find(name => assets.some(asset => asset.name === name)) ?? candidates[0];
  const matches = assets.filter(asset => asset.name === assetName);
  if (matches.length !== 1) throw new Error(`REQUIRED_DEVELOPMENT_EVIDENCE_MISSING ${candidates.join(' | ')}`);
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.size > 2 * 1024 * 1024) throw new Error('INVALID_EVIDENCE_ASSET');
  const bytes = await githubDownload(`/repos/${repository}/releases/assets/${asset.id}`, request);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('EVIDENCE_ASSET_TOO_LARGE');
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('INVALID_EVIDENCE_JSON'); }
  const featureInventory = await readRemoteInventory(repository, sourceSha, request);
  const baselines = {};
  // 기준 커밋이나 그 시점 기능 목록이 없으면(404) 로컬 검증처럼 판정 불가로 두어 다시 실행하게 한다.
  const unlessMissing = error => { if (error?.status === 404) return null; throw error; };
  for (const baselineSha of baselineShas(document)) {
    const compare = await githubJson(`/repos/${repository}/compare/${baselineSha}...${sourceSha}`, request).catch(unlessMissing);
    const files = ['ahead', 'identical'].includes(compare?.status) && Array.isArray(compare.files) ? withinCompareLimit(compare.files) : null;
    baselines[baselineSha] = {
      changedFiles: files?.flatMap(f => [f.filename, f.previous_filename].filter(Boolean)) ?? null,
      inventory: await readRemoteInventory(repository, baselineSha, request).catch(unlessMissing),
    };
  }
  const result = validateDevelopmentEvidence(document, { ...options, featureInventory, baselines });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return { ...result, assetId: asset.id, completedAt: document.e2e.completedAt };
}

export async function runDevelopmentEvidenceCli(argv, env = process.env) {
  const args = new Map();
  const allowed = new Set(['file', 'feature-inventory', 'repo', 'tag', 'sha', 'target', 'phase', 'configuration-fingerprint',
    'release-exception-id', 'verifier-sha', 'report', 'release-binding', 'artifact-receipt', 'artifact-file',
    'exception-file', 'preflight', 'risk-notes-file', 'original-evidence-dir', 'xcode-build-number', 'app-repository']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/u, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || args.has(key)) throw new Error('INVALID_EVIDENCE_ARGUMENT');
    args.set(key, argv[i + 1]);
  }
  const context = { repository: args.get('repo') ?? env.GITHUB_REPOSITORY, sourceSha: args.get('sha'), target: args.get('target'), phase: args.get('phase'), configurationFingerprint: args.get('configuration-fingerprint'), requireUi: args.get('target') !== 'service' };
  if (args.has('release-exception-id')) {
    if (args.has('file') || (args.has('preflight') && args.get('preflight') !== 'true')) throw new Error('INVALID_EVIDENCE_ARGUMENT');
    let result;
    try {
      result = await verifyReleaseDevelopmentEvidence({ ...context, tag: args.get('tag'), env,
        exceptionId: args.get('release-exception-id'), verifierSha: args.get('verifier-sha'),
        releaseBindingFile: args.get('release-binding'), artifactReceiptFile: args.get('artifact-receipt'), artifactFile: args.get('artifact-file'),
        exceptionFile: args.get('exception-file'), riskNotesFile: args.get('risk-notes-file'), preflightOnly: args.get('preflight') === 'true',
        originalEvidenceDir: args.get('original-evidence-dir'),
        xcodeBuildNumber: args.get('xcode-build-number'), appRepository: args.get('app-repository') });
    } catch (error) {
      if (args.has('report')) writeFileSync(args.get('report'), `${JSON.stringify({ ok: false, decisionStatus: 'rejected',
        productE2eStatus: 'blocked', repository: context.repository, sourceSha: context.sourceSha, target: context.target,
        phase: context.phase, error: error.message }, null, 2)}\n`);
      throw error;
    }
    if (args.has('report')) writeFileSync(args.get('report'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`출시 판정 ${result.decisionStatus}: ${context.target} ${context.phase} ${context.sourceSha}; 제품 E2E blocked\n`);
    return result;
  }
  if (['verifier-sha', 'report', 'release-binding', 'artifact-receipt', 'artifact-file', 'exception-file', 'preflight', 'risk-notes-file', 'original-evidence-dir', 'xcode-build-number', 'app-repository'].some(key => args.has(key))) throw new Error('RELEASE_EXCEPTION_ID_REQUIRED');
  let result;
  if (args.has('file')) {
    const document = JSON.parse(readFileSync(args.get('file'), 'utf8'));
    const featureInventory = JSON.parse(readFileSync(args.get('feature-inventory') ?? INVENTORY_PATH, 'utf8'));
    const baselines = readLocalBaselines(document, context.sourceSha);
    result = { ...validateDevelopmentEvidence(document, { ...context, featureInventory, baselines }), completedAt: document?.e2e?.completedAt };
  } else {
    result = await verifyReleaseDevelopmentEvidence({ ...context, tag: args.get('tag') ?? EVIDENCE_ARCHIVE_TAG, env });
  }
  if (!result.ok) throw new Error(result.errors.join('\n'));
  process.stdout.write(`개발 검수 근거 통과: ${context.target} ${context.phase} ${context.sourceSha}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDevelopmentEvidenceCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
