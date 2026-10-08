#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { githubDownload, githubJson, githubPaginate } from '../github-rest.mjs';

const schema = JSON.parse(readFileSync(new URL('../../contracts/development-evidence.schema.json', import.meta.url), 'utf8'));
const checkSchema = new Ajv2020({ allErrors: true }).compile(schema);
const policy = parse(readFileSync(new URL('../../contracts/development-workflow.yaml', import.meta.url), 'utf8'));
const MAX_E2E_AGE_MS = policy.editorE2e.maxAgeMinutes * 60 * 1000;

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
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.features) || inventory.features.length === 0 || inventory.features.some(f => typeof f.id !== 'string' || !f.id.trim() || typeof f.core !== 'boolean')) {
    errors.push('SOURCE_FEATURE_INVENTORY_REQUIRED');
  } else {
    const key = f => `${f.id}:${f.core}`;
    const actual = document.features.map(key).sort();
    const expected = inventory.features.map(key).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected) || new Set(inventory.features.map(f => f.id)).size !== inventory.features.length) errors.push('SOURCE_FEATURE_INVENTORY_MISMATCH');
  }
  const conditions = document.acceptance.map(a => a.id);
  unique(features, 'feature'); unique(conditions, 'acceptance');
  const covered = (ids, expected, label) => {
    if (expected.some(id => !ids.includes(id)) || ids.some(id => !features.includes(id))) errors.push(`FEATURE_COVERAGE ${label}`);
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
  if (e2e.phase !== context.phase || e2e.sourceSha !== context.sourceSha) errors.push('E2E_CANDIDATE_OR_PHASE_MISMATCH');
  if (Date.parse(e2e.plannedAt) < previousEnd) errors.push('E2E_BEFORE_REVIEW_FINISHED');
  if (now - Date.parse(e2e.completedAt) > MAX_E2E_AGE_MS) errors.push('E2E_EXPIRED');
  if (context.after && (!Number.isFinite(Date.parse(context.after)) || Date.parse(e2e.startedAt) <= Date.parse(context.after))) errors.push('SEPARATE_DEPLOY_E2E_REQUIRED');
  if (context.configurationFingerprint && e2e.environment.configurationFingerprint !== context.configurationFingerprint) errors.push('CONFIGURATION_CHANGED');
  if (ui && e2e.environment.kind === 'service-runtime') errors.push('UI_RUNTIME_REQUIRED');
  if (!ui && e2e.environment.kind !== 'service-runtime') errors.push('SERVICE_RUNTIME_REQUIRED');
  unique(e2e.scenarios.map(s => s.id), 'scenario');
  covered(e2e.scenarios.flatMap(s => s.featureIds), features, 'e2e-all-implemented-features');
  return { ok: errors.length === 0, errors };
}

export async function verifyReleaseDevelopmentEvidence(options) {
  const { repository, tag, sourceSha, target, phase, token, env = process.env, fetchImpl = globalThis.fetch } = options;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository ?? '') || !/^[a-f0-9]{40}$/u.test(sourceSha ?? '') || !['before-build', 'before-deploy'].includes(phase) || !['apps-in-toss', 'google-play', 'app-store', 'web', 'service'].includes(target) || !tag) throw new Error('INVALID_EVIDENCE_CONTEXT');
  const request = { token, env, fetchImpl };
  const release = await githubJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, request);
  const assets = await githubPaginate(`/repos/${repository}/releases/${release.id}/assets?per_page=100`, request);
  const assetName = tag === 'development-evidence'
    ? `development-evidence.${sourceSha}.${target}.${phase}.json`
    : `development-evidence.${target}.${phase}.json`;
  const matches = assets.filter(asset => asset.name === assetName);
  if (matches.length !== 1) throw new Error(`REQUIRED_DEVELOPMENT_EVIDENCE_MISSING ${assetName}`);
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.size > 2 * 1024 * 1024) throw new Error('INVALID_EVIDENCE_ASSET');
  const bytes = await githubDownload(`/repos/${repository}/releases/assets/${asset.id}`, request);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('EVIDENCE_ASSET_TOO_LARGE');
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('INVALID_EVIDENCE_JSON'); }
  const inventoryFile = await githubJson(`/repos/${repository}/contents/docs/qa/feature-inventory.json?ref=${sourceSha}`, request);
  if (inventoryFile?.encoding !== 'base64' || typeof inventoryFile.content !== 'string') throw new Error('SOURCE_FEATURE_INVENTORY_UNREADABLE');
  let featureInventory;
  try { featureInventory = JSON.parse(Buffer.from(inventoryFile.content, 'base64').toString('utf8')); }
  catch { throw new Error('SOURCE_FEATURE_INVENTORY_INVALID_JSON'); }
  const result = validateDevelopmentEvidence(document, { ...options, featureInventory });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return { ...result, assetId: asset.id, completedAt: document.e2e.completedAt };
}

export async function runDevelopmentEvidenceCli(argv, env = process.env) {
  const args = new Map();
  const allowed = new Set(['file', 'feature-inventory', 'repo', 'tag', 'sha', 'target', 'phase', 'after', 'configuration-fingerprint']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/u, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || args.has(key)) throw new Error('INVALID_EVIDENCE_ARGUMENT');
    args.set(key, argv[i + 1]);
  }
  const context = { repository: args.get('repo') ?? env.GITHUB_REPOSITORY, sourceSha: args.get('sha'), target: args.get('target'), phase: args.get('phase'), after: args.get('after'), configurationFingerprint: args.get('configuration-fingerprint'), requireUi: args.get('target') !== 'service' };
  let result;
  if (args.has('file')) {
    const document = JSON.parse(readFileSync(args.get('file'), 'utf8'));
    const featureInventory = JSON.parse(readFileSync(args.get('feature-inventory') ?? 'docs/qa/feature-inventory.json', 'utf8'));
    result = { ...validateDevelopmentEvidence(document, { ...context, featureInventory }), completedAt: document?.e2e?.completedAt };
  } else {
    result = await verifyReleaseDevelopmentEvidence({ ...context, tag: args.get('tag') ?? 'development-evidence', env });
  }
  if (!result.ok) throw new Error(result.errors.join('\n'));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `completed_at=${result.completedAt}\n`);
  if (env.GITHUB_ENV && context.phase === 'before-build') appendFileSync(env.GITHUB_ENV, `EDITOR_BUILD_E2E_COMPLETED_AT=${result.completedAt}\n`);
  process.stdout.write(`개발 검수 근거 통과: ${context.target} ${context.phase} ${context.sourceSha}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDevelopmentEvidenceCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
