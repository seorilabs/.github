// 과도기 전용: schemaVersion 1 근거(UI 3회 + 전체 Editor E2E)를 이전 규칙으로 검증한다.
// contracts/development-workflow.yaml의 legacyEvidence.acceptedUntil 이후에는 호출되지 않으며 그 뒤 이 파일을 지운다.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { carriedForwardFeatures } from './carry-forward.mjs';
import { policy, validInventory } from './test-plan.mjs';

const checkSchema = new Ajv2020({ allErrors: true }).compile(JSON.parse(readFileSync(new URL(`../../${policy.legacyEvidence.schema}`, import.meta.url), 'utf8')));
const ROUNDS = policy.redesignReview.rounds;
const MAX_E2E_AGE_MS = policy.runs.maxAgeHours * 60 * 60 * 1000;

export function validateLegacyEvidence(document, context) {
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
  const inventoryValid = validInventory(inventory);
  if (!inventoryValid) {
    errors.push('SOURCE_FEATURE_INVENTORY_REQUIRED');
  } else {
    const key = f => `${f.id}:${f.core}`;
    const actual = document.features.map(key).sort();
    const expected = inventory.features.map(key).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push('SOURCE_FEATURE_INVENTORY_MISMATCH');
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
  if (ui && (document.iterations.length < ROUNDS || core.length === 0)) errors.push('THREE_UI_ROUNDS_REQUIRED');
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
    if (round.number > ROUNDS) {
      const approvals = [document.additionalIterationApproval, ...(document.additionalIterationApprovals ?? [])];
      if (!approvals.some(approval => approval && approval.maxRound >= round.number && Number.isFinite(Date.parse(approval.approvedAt)) && Date.parse(approval.approvedAt) <= Date.parse(round.plannedAt))) errors.push('EXTRA_ROUND_APPROVAL_REQUIRED');
    }
  });
  const e2e = document.e2e;
  times(e2e, 'e2e');
  // 같은 후보의 통과한 빌드 직전 E2E는 배포 직전에도 쓴다. v1에는 출시 직전 단계가 없었으므로 그 단계는 배포 직전과 같이 본다.
  const phase = context.phase === 'before-release' ? 'before-deploy' : context.phase;
  const phaseServes = e2e.phase === phase || (phase === 'before-deploy' && e2e.phase === 'before-build');
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
