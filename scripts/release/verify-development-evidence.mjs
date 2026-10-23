#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { githubDownload, githubJson, githubPaginate, resolveToken } from '../github-rest.mjs';
import { carriedForwardFeatures } from './carry-forward.mjs';
import { validateLegacyEvidence } from './development-evidence-v1.mjs';
import { applyHistoricalReviewCoverage } from './historical-review-coverage.mjs';
import { computeFloor, DEVICE_ENVIRONMENTS, environmentOf, highestLevel, mergeTestPlans, policy, RELEASE_ONLY_TARGETS,
  testPlanProblems, validInventory } from './test-plan.mjs';

const schema = JSON.parse(readFileSync(new URL('../../contracts/development-evidence.schema.json', import.meta.url), 'utf8'));
const checkSchema = new Ajv2020({ allErrors: true }).compile(schema);
const MAX_RUN_AGE_MS = policy.runs.maxAgeHours * 60 * 60 * 1000;
const ROUNDS = policy.redesignReview.rounds;
const LEGACY_ACCEPTED_UNTIL = Date.parse(policy.legacyEvidence.acceptedUntil);
// compare API는 변경 파일을 최대 300개만 준다. 300개면 잘렸을 수 있으므로 판정 불가로 보고, 로컬 git 비교도 같은 기준을 쓴다.
const COMPARE_FILE_LIMIT = policy.floors.compareFileLimit;
const INVENTORY_PATH = policy.runs.featureInventory;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PHASES = Object.keys(policy.phases).filter(key => key.startsWith('before-'));
const TARGETS = Object.keys(policy.testLevels.marketPlatforms);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const PLAN_PATH = /^docs\/design\/[^/]+\/test-plan\.json$/u;
// CI 실행 링크. 저장소·실행 ID·재시도 번호만 꺼내 고정 API 경로로 조회한다.
const CI_RUN_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/actions\/runs\/([0-9]+)(?:\/attempts\/([0-9]+))?$/u;
const CI_EXECUTOR = policy.runs.ciExecutor.executor;

const withinCompareLimit = files => files.length < COMPARE_FILE_LIMIT ? files : null;
const sameFolder = design => design.testPlan === `${String(design.document).split('/').slice(0, 3).join('/')}/test-plan.json`;
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function validateDevelopmentEvidence(document, context) {
  if (document?.schemaVersion === 1) {
    const now = Date.parse(context.now ?? new Date().toISOString());
    if (!(now < LEGACY_ACCEPTED_UNTIL)) return { ok: false, errors: ['EVIDENCE_V1_RETIRED'] };
    return validateLegacyEvidence(document, context);
  }
  return applyHistoricalReviewCoverage(document, context, validateTestLevelEvidence(document, context));
}

// 알려진 최초 기록의 잘못된 판정과 시각은 보존한다. 새 검수의 통과 횟수에는 넣지 않는다.
function checkInvalidInitialHistory(document, { ui, redesign, errors, now }) {
  const history = document.invalidInitialReviewHistory;
  if (!history) return { count: 0, end: 0 };
  if (!ui || !redesign) errors.push('INVALID_INITIAL_REVIEW_REQUIRES_REDESIGN');
  let end = 0, previousReviewEnd = 0, invalid = false;
  if (!history.reason.trim()) errors.push('INVALID_INITIAL_REVIEW_EVIDENCE_REQUIRED');
  history.rounds.forEach(({ round, implementer, originalReportSha256, correction, evidence, resolutionEvidence }, index) => {
    if (round.number !== index + 1) errors.push('INVALID_INITIAL_REVIEW_SEQUENCE');
    if (round.interruption) errors.push('INVALID_INITIAL_REVIEW_INTERRUPTED');
    if (sameName(round.reviewer, implementer)) errors.push('INVALID_INITIAL_REVIEW_INDEPENDENCE');
    if (correction.number !== round.number || correction.sourceSha !== round.sourceSha || correction.originalReportSha256 !== originalReportSha256)
      errors.push('INVALID_INITIAL_REVIEW_CORRECTION_MISMATCH');
    const values = [round.plannedAt, round.startedAt, round.completedAt, correction.visualReviewCompletedAt, correction.recordedAt];
    const parsed = values.map(Date.parse);
    const [planned, started, completed, visual, recorded] = parsed;
    if (parsed.some((value, i) => !Number.isFinite(value) || value > now || new Date(value).toISOString().slice(0, 19) !== values[i].slice(0, 19))
      || recorded < Math.max(planned, started, completed, visual) || visual < started)
      errors.push('INVALID_INITIAL_REVIEW_TIME');
    if (!correction.reason.trim() || !evidence.some(value => value.trim()) || !correction.evidence.some(value => value.trim()))
      errors.push('INVALID_INITIAL_REVIEW_EVIDENCE_REQUIRED');
    const failed = [round.functional.status, round.ux.status, correction.functionalStatus, correction.uxStatus].some(status => status !== 'passed');
    if (failed && !resolutionEvidence?.trim()) errors.push('INVALID_INITIAL_REVIEW_UNRESOLVED_CORRECTION');
    invalid ||= failed || planned > started || started > completed || visual > completed || planned < previousReviewEnd;
    previousReviewEnd = Math.max(previousReviewEnd, completed, visual);
    end = Math.max(end, ...parsed);
  });
  if (!invalid) errors.push('INVALID_INITIAL_REVIEW_NO_FAILURE');
  return { count: history.rounds.length, end };
}

// 재설계 3회 검수는 v1 회차 규칙을 그대로 쓴다. 회차를 기록했다면 횟수와 상관없이 순서·독립성·해결 여부를 확인한다.
function checkReviewRounds(document, { redesign, coreFeatures, carried, inventoryIds, times, errors, now }) {
  const ui = document.productKind !== 'service';
  if (!ui && document.reviewRounds.length !== 0) errors.push('SERVICE_WITH_UI_ROUNDS');
  const hasInterruption = document.reviewRounds.some(round => round.interruption);
  const completeRounds = document.reviewRounds.filter(round => !round.interruption);
  if (redesign && (completeRounds.length < ROUNDS || coreFeatures.length === 0)) errors.push('THREE_UI_ROUNDS_REQUIRED');
  if (hasInterruption && (!ui || !redesign)) errors.push('INTERRUPTED_REVIEW_REQUIRES_REDESIGN');
  const invalidInitial = checkInvalidInitialHistory(document, { ui, redesign, errors, now });
  const covered = (ids, label) => {
    if (coreFeatures.some(id => !carried.has(id) && !ids.includes(id)) || ids.some(id => !inventoryIds.has(id))) errors.push(`FEATURE_COVERAGE ${label}`);
  };
  const approvals = document.additionalIterationApprovals ?? [document.additionalIterationApproval].filter(Boolean);
  const approvedBefore = (round, after = null) => approvals.some(approval => approval.maxRound >= round.number
    && Number.isFinite(Date.parse(approval.approvedAt)) && Date.parse(approval.approvedAt) <= Date.parse(round.plannedAt)
    && (after === null || Date.parse(approval.approvedAt) >= after));
  if (document.additionalIterationApprovals) {
    if (new Set(approvals.map(approval => approval.maxRound)).size !== approvals.length) errors.push('DUPLICATE additional-iteration-approval-maxRound');
    if (approvals.some(approval => {
      const parsed = Date.parse(approval.approvedAt);
      return !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== approval.approvedAt.slice(0, 19);
    })) errors.push('INVALID_ADDITIONAL_ITERATION_APPROVAL_TIME');
  }
  // Incomplete original attempts retain their verdicts and count toward the cap,
  // but never satisfy any of the three complete reviews required by a redesign.
  const history = document.reviewHistoryRecovery?.attempts ?? [];
  if (history.length && (!ui || !redesign)) errors.push('REVIEW_RECOVERY_REQUIRES_REDESIGN');
  if (history.length && !history.some(r => r.sourceSha === null || r.plannedAt === null || r.startedAt === null)) errors.push('REVIEW_RECOVERY_NO_METADATA_GAP');
  let previousEnd = invalidInitial.end;
  history.forEach((attempt, index) => {
    if (attempt.number !== index + 1) errors.push('REVIEW_RECOVERY_HISTORY_SEQUENCE');
    const knownTimes = [attempt.plannedAt, attempt.startedAt, attempt.completedAt].filter(value => value !== null);
    const known = knownTimes.map(Date.parse);
    const completion = Date.parse(attempt.completedAt);
    if (known.some((value, i) => !Number.isFinite(value) || new Date(value).toISOString().slice(0, 19) !== knownTimes[i].slice(0, 19) || (i > 0 && value < known[i - 1]))
      || completion > now || completion < previousEnd
      || (attempt.plannedAt !== null && Date.parse(attempt.plannedAt) < previousEnd)
      || (attempt.startedAt !== null && Date.parse(attempt.startedAt) < previousEnd)) errors.push('REVIEW_RECOVERY_HISTORY_TIME');
    if ([attempt.functionalStatus, attempt.uxStatus].some(status => status !== 'passed')
      && !attempt.resolutionEvidence?.trim()) errors.push('REVIEW_RECOVERY_UNRESOLVED_HISTORY');
    previousEnd = completion;
  });
  const incompleteEnd = previousEnd;
  const completedHistory = document.reviewHistoryRecovery?.completedRounds ?? [];
  const interruptedHistory = document.reviewHistoryRecovery?.interruptedRounds ?? [];
  const checkInterruption = round => {
    const partial = round.interruption;
    if (['functional', 'ux'].some(aspect => round[aspect].status === 'passed')) errors.push('INTERRUPTED_REVIEW_PASSED');
    if (!partial.reason.trim() || !partial.evidence.some(value => value.trim())) errors.push('INTERRUPTED_REVIEW_EVIDENCE_REQUIRED');
    const units = [...partial.actualScope.completed, ...partial.actualScope.incomplete, ...partial.actualScope.notRun];
    if (new Set(units).size !== units.length) errors.push('INTERRUPTED_REVIEW_SCOPE_OVERLAP');
  };
  // Separate arrays retain their own order; their union retains every actual round,
  // including interrupted attempts, without counting any history as current credit.
  for (const [records, label] of [[completedHistory, 'COMPLETED'], [interruptedHistory, 'INTERRUPTED']]) {
    if (records.some(({ round }, i) => i > 0 && round.number <= records[i - 1].round.number)) errors.push(`REVIEW_RECOVERY_${label}_SEQUENCE`);
  }
  const historicalRounds = [
    ...completedHistory.map(entry => ({ ...entry, interrupted: false })),
    ...interruptedHistory.map(entry => ({ ...entry, interrupted: true })),
  ].sort((a, b) => a.round.number - b.round.number);
  historicalRounds.forEach(({ round, implementer, originalReportSha256, interrupted }, index) => {
    if (!interrupted && round.interruption) errors.push('REVIEW_RECOVERY_INTERRUPTED_HISTORY');
    if (interrupted) {
      checkInterruption(round);
      if (originalReportSha256 !== round.interruption.originalReportSha256) errors.push('REVIEW_RECOVERY_INTERRUPTED_HASH_MISMATCH');
    }
    if (round.number !== history.length + index + 1) errors.push('REVIEW_RECOVERY_COMPLETED_SEQUENCE');
    times(round, `historical-round-${round.number}`);
    const knownTimes = [round.plannedAt, round.startedAt, round.completedAt];
    if (knownTimes.some(value => {
      const parsed = Date.parse(value);
      return !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19);
    }) || Date.parse(round.plannedAt) < previousEnd) errors.push('REVIEW_RECOVERY_COMPLETED_TIME');
    previousEnd = Date.parse(round.completedAt);
    if (sameName(round.reviewer, implementer)) errors.push('REVIEW_RECOVERY_COMPLETED_INDEPENDENCE');
    for (const aspect of ['functional', 'ux']) {
      if (round[aspect].status !== 'passed' && !round[aspect].resolutionEvidence?.trim()) errors.push(`REVIEW_RECOVERY_UNRESOLVED_COMPLETED ${round.number}-${aspect}`);
    }
    // Its original approval must precede its own plan; a later replacement approval cannot authorize it.
    if (!approvedBefore(round, incompleteEnd)) errors.push('EXTRA_ROUND_APPROVAL_REQUIRED');
  });
  const historicalEnd = previousEnd;
  const strictCurrent = history.length > 0 || invalidInitial.count > 0 || hasInterruption;
  document.reviewRounds.forEach((round, index) => {
    if (round.number !== index + history.length + historicalRounds.length + invalidInitial.count + 1) errors.push('ROUND_SEQUENCE');
    if (strictCurrent && round.sourceSha !== document.sourceSha) errors.push('REVIEW_RECOVERY_SOURCE_MISMATCH');
    if (strictCurrent && now - Date.parse(round.completedAt) > MAX_RUN_AGE_MS) errors.push('REVIEW_RECOVERY_EXPIRED');
    if (strictCurrent && !round.interruption && [...inventoryIds].some(id => !round.functional.featureIds.includes(id) || !round.ux.featureIds.includes(id))) errors.push('REVIEW_RECOVERY_FULL_COVERAGE');
    times(round, `round-${round.number}`);
    if (Date.parse(round.plannedAt) < previousEnd) errors.push('ROUND_OVERLAP');
    previousEnd = Date.parse(round.completedAt);
    if (sameName(round.reviewer, document.implementer)) errors.push('INDEPENDENT_REVIEW_REQUIRED');
    if (round.interruption) {
      checkInterruption(round);
      // These original IDs may be the required scope, not actual completion. The typed partial scope records that gap.
      if ([...round.functional.featureIds, ...round.ux.featureIds].some(id => !inventoryIds.has(id))) errors.push('INTERRUPTED_REVIEW_UNKNOWN_FEATURE');
    } else {
      covered(round.functional.featureIds, `functional-${round.number}`);
      covered(round.ux.featureIds, `ux-${round.number}`);
    }
    for (const aspect of ['functional', 'ux']) {
      const result = round[aspect];
      if (invalidInitial.count && result.status !== 'passed') errors.push('INVALID_INITIAL_REVIEW_CURRENT_NOT_PASSED');
      if (result.status !== 'passed' && (index === document.reviewRounds.length - 1 || !result.resolutionEvidence)) errors.push(`UNRESOLVED_REVIEW ${round.number}-${aspect}`);
    }
    if (round.number > ROUNDS || history.length || invalidInitial.count) {
      if (!approvedBefore(round, history.length || invalidInitial.count ? historicalEnd : null)) errors.push('EXTRA_ROUND_APPROVAL_REQUIRED');
    }
  });
}

// context.plans[designId] = { approved, plan }: approvedCommit이 후보의 조상이고 그 커밋에서 읽은 계획일 때만 approved다.
// context.changes[baseline] = 기준 태그부터 후보까지 바뀐 파일 목록, 비교할 수 없으면 null.
function validateTestLevelEvidence(document, context) {
  const errors = [];
  if (!checkSchema(document)) {
    return { ok: false, errors: [...new Set(checkSchema.errors.map(e => `EVIDENCE_SCHEMA ${e.instancePath || '/'}: ${e.keyword}`))] };
  }
  const { target, phase } = context;
  const now = Date.parse(context.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) errors.push('INVALID_CURRENT_TIME');
  if (!PHASES.includes(phase)) errors.push('INVALID_PHASE');
  for (const key of ['repository', 'sourceSha', 'target']) {
    if (document[key] !== context[key]) errors.push(`CANDIDATE_MISMATCH ${key}`);
  }
  const unique = (values, label) => {
    if (new Set(values).size !== values.length) errors.push(`DUPLICATE ${label}`);
  };
  const times = (value, label) => {
    const plan = Date.parse(value.plannedAt), start = Date.parse(value.startedAt), end = Date.parse(value.completedAt);
    const ordered = [plan, start, end].every(Number.isFinite) && plan <= start && start <= end && end <= now;
    if (!ordered) errors.push(`EXECUTION_ORDER ${label}`);
    return ordered;
  };

  const conditions = document.acceptance.map(a => a.id);
  const tddIds = document.tdd.map(t => t.acceptanceId);
  unique(conditions, 'acceptance'); unique(tddIds, 'tdd');
  if (conditions.some(id => !tddIds.includes(id)) || tddIds.some(id => !conditions.includes(id))) errors.push('TDD_ACCEPTANCE_COVERAGE');
  const mixed = document.productKind === 'mixed';
  const ui = document.productKind !== 'service';
  if (context.requireUi !== false && !ui) errors.push('UI_REQUIRED');

  const inventory = context.featureInventory;
  const inventoryValid = validInventory(inventory);
  if (!inventoryValid) errors.push('SOURCE_FEATURE_INVENTORY_REQUIRED');
  const features = inventoryValid ? inventory.features : [];
  const inventoryIds = new Set(features.map(f => f.id));
  const serviceIds = new Set(mixed ? features.filter(f => f.runtimeKind === 'service').map(f => f.id) : []);
  const uiIds = new Set(features.filter(f => !serviceIds.has(f.id)).map(f => f.id));
  if (mixed && (serviceIds.size === 0 || uiIds.size === 0)) errors.push('MIXED_FEATURE_KINDS_REQUIRED');

  unique(document.designs.map(d => d.id), 'design');
  const plans = [];
  for (const design of document.designs) {
    // 계획은 그 설계와 같은 폴더의 test-plan.json이어야 한다. 다른 설계의 계획을 끌어다 쓰지 못하게 한다.
    if (!sameFolder(design)) { errors.push(`TEST_PLAN_DESIGN_MISMATCH ${design.id}`); continue; }
    const entry = context.plans?.[design.id];
    if (!entry?.approved || !entry.plan) { errors.push(`TEST_PLAN_UNAPPROVED ${design.id}`); continue; }
    const problems = inventoryValid ? testPlanProblems(entry.plan, inventory) : [];
    if (problems.length > 0) { errors.push(...problems.map(problem => `TEST_PLAN_INVALID ${design.id} ${problem}`)); continue; }
    plans.push(entry.plan);
  }
  const runs = document.runs;
  unique(runs.map(r => r.id), 'run');
  const completedAt = runs.length === 0 ? null : runs.map(r => r.completedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  if (!inventoryValid || plans.length !== document.designs.length) return { ok: false, errors: [...new Set(errors)], level: null, completedAt };

  const merged = mergeTestPlans(plans);
  if (!merged.releaseAllowed) errors.push('RELEASE_NOT_AUTHORIZED development-only');
  const floor = computeFloor({ merged, inventory, changes: context.changes, baselineInventories: context.baselineInventories, target });
  const level = highestLevel([merged.level, floor.level]);
  const carried = carriedForwardFeatures(document, context, features, now, errors);
  if (merged.foundationRerun) for (const id of carried) errors.push(`CARRY_FORWARD_FORBIDDEN ${id}`);
  const usable = merged.foundationRerun ? new Set() : carried;
  const changedScope = [...new Set([...merged.changedFeatures, ...floor.touched])];
  for (const id of changedScope) if (carried.has(id)) errors.push(`CARRY_FORWARD_AFFECTED ${id}`);
  const fullScope = [...new Set([...features.map(f => f.id).filter(id => !usable.has(id) || changedScope.includes(id)), ...changedScope])];

  // 개발 환경 실행은 빌드 전부터, 실기기 실행은 제출·승격 직전부터 요구한다. 웹·서비스는 배포가 곧 출시다.
  const releasePhase = phase === 'before-release' || (RELEASE_ONLY_TARGETS.includes(target) && phase === 'before-deploy');
  const active = merged.environments.filter(env => env === 'dev' || releasePhase);

  // CI 실행은 GitHub API로 읽은 실행이 같은 저장소·후보 SHA·성공·기능 목록의 E2E workflow일 때만 인정한다.
  // 확인되면 구현자와 다른 실행자로 보고, 기한은 API의 마지막 갱신 시각으로 잰다.
  const ciProblem = run => {
    if (environmentOf(run.kind) !== 'dev') return 'CI_RUN_KIND';
    const info = context.ciRuns?.[run.ciRun.url];
    if (!info) return 'CI_RUN_UNVERIFIED';
    if (run.ciRun.url.match(CI_RUN_URL)?.[1] !== document.repository || info.repository?.full_name !== document.repository || info.head_sha !== context.sourceSha) return 'CI_RUN_MISMATCH';
    if (info.status !== 'completed' || info.conclusion !== 'success') return 'CI_RUN_NOT_SUCCESSFUL';
    if (inventory.schemaVersion !== 2 || info.path !== inventory.e2e.workflow) return 'CI_RUN_WORKFLOW';
    return null;
  };
  const valid = [];
  for (const run of runs) {
    const ordered = times(run, `run-${run.id}`);
    const ci = run.executor === CI_EXECUTOR;
    const problem = ci ? ciProblem(run) : null;
    if (problem) errors.push(`${problem} ${run.id}`);
    unique(run.scenarios.map(s => s.id), `scenario ${run.id}`);
    for (const id of new Set(run.scenarios.flatMap(s => s.featureIds))) if (!inventoryIds.has(id)) errors.push(`RUN_UNKNOWN_FEATURE ${run.id} ${id}`);
    const device = DEVICE_ENVIRONMENTS.includes(environmentOf(run.kind));
    if (ui && !mixed && run.kind === 'service-runtime') errors.push(`UI_RUNTIME_REQUIRED ${run.id}`);
    if (!ui && run.kind !== 'service-runtime') errors.push(`SERVICE_RUNTIME_REQUIRED ${run.id}`);
    let runtimeMatches = true;
    if (mixed) for (const id of new Set(run.scenarios.flatMap(s => s.featureIds))) {
      if (serviceIds.has(id) !== (run.kind === 'service-runtime')) {
        runtimeMatches = false;
        errors.push(`RUN_FEATURE_RUNTIME_MISMATCH ${run.id} ${id}`);
      }
    }
    const finishedAt = ci && !problem ? context.ciRuns[run.ciRun.url].updated_at : run.completedAt;
    const fresh = now - Date.parse(finishedAt) <= MAX_RUN_AGE_MS;
    if (!fresh) errors.push(`RUN_EXPIRED ${run.id}`);
    if (run.sourceSha !== context.sourceSha) errors.push(`RUN_CANDIDATE_MISMATCH ${run.id}`);
    // 대상 마켓의 기기·실제 SDK 실행을 명시한 출시 지문과 대조한다. SDK 대체 검수는 아래 승인 계획의 지문도 항상 검사한다.
    if ((device || run.nativeSdk) && context.configurationFingerprint && run.target === target && run.configurationFingerprint !== context.configurationFingerprint) errors.push(`CONFIGURATION_CHANGED ${run.id}`);
    if (sameName(run.executor, document.implementer) && (level === 'L3' || (level === 'L2' && device) || run.nativeSdk)) errors.push(`INDEPENDENT_RUN_REQUIRED ${run.id}`);
    if (ordered && fresh && !problem && runtimeMatches && run.sourceSha === context.sourceSha) valid.push(run);
  }
  if (mixed && (!valid.some(run => run.kind === 'service-runtime') || !valid.some(run => run.kind !== 'service-runtime')))
    errors.push('MIXED_RUN_KINDS_REQUIRED');
  const covers = (env, feature) => valid.some(run => environmentOf(run.kind) === env && run.scenarios.some(s => s.featureIds.includes(feature)));
  const deviceCovers = feature => valid.some(run => run.target === target && floor.platforms.includes(environmentOf(run.kind))
    && run.scenarios.some(s => s.featureIds.includes(feature)));
  const nativeCovers = feature => {
    const approval = merged.platformValidation.find(v => v.target === target && v.featureId === feature);
    if (!approval) return false;
    return valid.some(run => run.kind === 'native-development' && run.target === target && run.nativeSdk?.mode === 'real'
      && run.configurationFingerprint === approval.configurationFingerprint
      && floor.platforms.includes(run.nativeSdk.runtime === 'ios-simulator' ? 'ios' : 'android')
      && approval.checks.every(id => run.scenarios.some(s => s.id === id && s.featureIds.includes(feature))));
  };

  const planned = new Set();
  for (const env of active) for (const feature of merged.level === 'L3' ? fullScope : changedScope) {
    planned.add(`${env} ${feature}`);
    if (!covers(env, feature)) errors.push(`RUN_COVERAGE ${env} ${feature}`);
  }
  if (floor.regression) for (const env of active) for (const feature of fullScope) {
    if (!planned.has(`${env} ${feature}`) && !covers(env, feature)) errors.push(`TEST_LEVEL_BELOW_FLOOR regression ${feature} ${env}`);
  }
  if (releasePhase) for (const { featureId, rule } of floor.deviceFloor) {
    if (!deviceCovers(featureId) && !nativeCovers(featureId)) errors.push(`TEST_LEVEL_BELOW_FLOOR ${rule} ${featureId} ${floor.platforms.join('|')}`);
  }

  const coreFeatures = features.filter(f => mixed ? uiIds.has(f.id) : f.core).map(f => f.id).filter(id => !usable.has(id));
  // 승인된 Spiritgate Mac 생략 계획만 native 테스트 빌드 뒤 UI3를 수행한다. 다른 계획의 순서는 바꾸지 않는다.
  const nativeHandoff = document.repository === 'seorilabs/spiritgate-defenders' && ['google-play','app-store'].includes(target)
    && ['before-build','before-deploy'].includes(phase) && !releasePhase && !merged.environments.includes('dev') && document.designs.length === 1
    && document.designs.every(d => d.id === '2026-10-16-native-release-handoff' && d.approvedCommit === 'cfe7ee914c980f39d8bf6ca062f86eb1912606fe'
      && d.document === 'docs/design/2026-10-16-native-release-handoff/design.md' && d.testPlan === 'docs/design/2026-10-16-native-release-handoff/test-plan.json');
  checkReviewRounds(document, { redesign: merged.redesign && !nativeHandoff, coreFeatures, carried: new Set(), inventoryIds: mixed ? uiIds : inventoryIds, times, errors, now });

  if (releasePhase && merged.releaseAllowed) {
    if (!merged.markets.includes(target)) errors.push(`RELEASE_NOT_AUTHORIZED market ${target}`);
    if (merged.until === 'test-track') errors.push('RELEASE_NOT_AUTHORIZED until test-track');
    // Play production 승격은 승인된 단계적 출시 비율을 넘지 못한다. 비율을 주지 않으면 완전 출시(1)다.
    const rollout = context.rollout ?? 1;
    if (target === 'google-play' && !(rollout <= merged.rollout)) errors.push(`RELEASE_NOT_AUTHORIZED rollout ${rollout} > ${merged.rollout}`);
  }
  const unresolved = [...new Set(errors)];
  return { ok: unresolved.length === 0, errors: unresolved, level, completedAt };
}

const EVIDENCE_ARCHIVE_TAG = 'development-evidence';

const baselineShas = document => Array.isArray(document?.carriedForward)
  ? [...new Set(document.carriedForward.map(item => item?.baselineSha).filter(sha => SHA_PATTERN.test(sha ?? '')))] : [];
const readableDesigns = document => document?.schemaVersion === 2 && Array.isArray(document.designs)
  ? document.designs.filter(d => typeof d?.id === 'string' && SHA_PATTERN.test(d.approvedCommit ?? '') && PLAN_PATH.test(d.testPlan ?? '') && sameFolder(d)) : [];
const planBaselines = plans => [...new Set(Object.values(plans).map(entry => entry.plan?.baseline)
  .filter(ref => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(ref)))];
const ciRunUrls = document => document?.schemaVersion === 2 && Array.isArray(document.runs)
  ? [...new Set(document.runs.map(run => run?.ciRun?.url).filter(url => typeof url === 'string' && CI_RUN_URL.test(url)))] : [];
const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };

function decodeContents(file) {
  if (file?.encoding !== 'base64' || typeof file.content !== 'string' || !(file.size <= MAX_FILE_BYTES)) return null;
  return parseJson(Buffer.from(file.content, 'base64').toString('utf8'));
}

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

const git = (...args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const isAncestor = (ref, sourceSha) => git('merge-base', '--is-ancestor', ref, sourceSha).status === 0;
function localChangedFiles(ref, sourceSha) {
  const commit = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  if (commit.status !== 0 || !isAncestor(commit.stdout.trim(), sourceSha)) return null;
  const diff = git('diff', '--name-status', '--find-renames', '-z', commit.stdout.trim(), sourceSha);
  return diff.status === 0 ? withinCompareLimit(parseNameStatus(diff.stdout))?.flat() ?? null : null;
}

function readLocalContext(document, sourceSha, inventory) {
  const baselines = {}, plans = {}, changes = {}, baselineInventories = {};
  if (!SHA_PATTERN.test(sourceSha ?? '')) return { baselines, plans, changes, baselineInventories };
  for (const baselineSha of baselineShas(document)) {
    const inventory = git('show', `${baselineSha}:${INVENTORY_PATH}`);
    baselines[baselineSha] = { changedFiles: localChangedFiles(baselineSha, sourceSha), inventory: inventory.status === 0 ? parseJson(inventory.stdout) : null };
  }
  for (const design of readableDesigns(document)) {
    const approved = isAncestor(design.approvedCommit, sourceSha);
    const file = approved ? git('show', `${design.approvedCommit}:${design.testPlan}`) : null;
    plans[design.id] = { approved, plan: file?.status === 0 && Buffer.byteLength(file.stdout) <= MAX_FILE_BYTES ? parseJson(file.stdout) : null };
  }
  for (const baseline of planBaselines(plans)) changes[baseline] = localChangedFiles(baseline, sourceSha);
  if (inventory?.schemaVersion === 2) for (const baseline of planBaselines(plans)) {
    const file = git('show', `${baseline}:${INVENTORY_PATH}`);
    baselineInventories[baseline] = file.status === 0 ? parseJson(file.stdout) : null;
  }
  return { baselines, plans, changes, baselineInventories };
}

// 기준 커밋·태그나 그 시점 파일이 없으면(404) 판정 불가로 두어 다시 실행하게 한다. 그 밖의 조회 실패는 그대로 멈춘다.
const unlessMissing = error => { if (error?.status === 404) return null; throw error; };
async function remoteChangedFiles(repository, ref, sourceSha, request) {
  const compare = await githubJson(`/repos/${repository}/compare/${encodeURIComponent(ref)}...${sourceSha}`, request).catch(unlessMissing);
  const files = ['ahead', 'identical'].includes(compare?.status) && Array.isArray(compare.files) ? withinCompareLimit(compare.files) : null;
  return files?.flatMap(f => [f.filename, f.previous_filename].filter(Boolean)) ?? null;
}

async function readRemoteContext(document, repository, sourceSha, request, inventory) {
  const baselines = {}, plans = {}, changes = {}, baselineInventories = {};
  for (const baselineSha of baselineShas(document)) {
    baselines[baselineSha] = {
      changedFiles: await remoteChangedFiles(repository, baselineSha, sourceSha, request),
      inventory: await readRemoteInventory(repository, baselineSha, request).catch(unlessMissing),
    };
  }
  for (const design of readableDesigns(document)) {
    const compare = await githubJson(`/repos/${repository}/compare/${design.approvedCommit}...${sourceSha}`, request).catch(unlessMissing);
    const approved = ['ahead', 'identical'].includes(compare?.status);
    const path = design.testPlan.split('/').map(encodeURIComponent).join('/');
    const file = approved ? await githubJson(`/repos/${repository}/contents/${path}?ref=${design.approvedCommit}`, request).catch(unlessMissing) : null;
    plans[design.id] = { approved, plan: decodeContents(file) };
  }
  for (const baseline of planBaselines(plans)) changes[baseline] = await remoteChangedFiles(repository, baseline, sourceSha, request);
  if (inventory?.schemaVersion === 2) for (const baseline of planBaselines(plans)) {
    baselineInventories[baseline] = await readRemoteInventory(repository, encodeURIComponent(baseline), request).catch(error => {
      if (error?.status === 404 || /^SOURCE_FEATURE_INVENTORY_/u.test(error?.message ?? '')) return null;
      throw error;
    });
  }
  return { baselines, plans, changes, baselineInventories };
}

// CI 실행은 로컬 검증에서도 API로 확인한다. 토큰이 없거나 조회에 실패하면(404·403·5xx·네트워크) 확인 못 한 실행으로
// 남겨 CI_RUN_UNVERIFIED로 실패시킨다. 통과로 넘기지 않는다.
async function readCiRuns(document, request) {
  const ciRuns = {};
  const urls = ciRunUrls(document);
  if (urls.length === 0) return ciRuns;
  try { resolveToken(request.token, request.env); } catch { return ciRuns; }
  for (const url of urls) {
    const [, repository, id, attempt] = url.match(CI_RUN_URL);
    const run = await githubJson(`/repos/${repository}/actions/runs/${id}${attempt ? `/attempts/${attempt}` : ''}`, request).catch(() => null);
    if (run) ciRuns[url] = run;
  }
  return ciRuns;
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
  if (options.bootstrapId) {
    const { verifyInternalTestflightBootstrap } = await import('./internal-testflight-bootstrap.mjs');
    return verifyInternalTestflightBootstrap(options);
  }
  const { repository, tag, sourceSha, target, phase, token, env = process.env, fetchImpl = globalThis.fetch } = options;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository ?? '') || !SHA_PATTERN.test(sourceSha ?? '') || !PHASES.includes(phase) || !TARGETS.includes(target) || !tag) throw new Error('INVALID_EVIDENCE_CONTEXT');
  const request = { token, env, fetchImpl };
  const release = tag === EVIDENCE_ARCHIVE_TAG
    ? await findEvidenceArchive(repository, request)
    : await githubJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, request);
  const assets = await githubPaginate(`/repos/${repository}/releases/${release.id}/assets?per_page=100`, request);
  const nameFor = assetPhase => tag === EVIDENCE_ARCHIVE_TAG
    ? `development-evidence.${sourceSha}.${target}.${assetPhase}.json`
    : `development-evidence.${target}.${assetPhase}.json`;
  // 나중 단계 보고서가 따로 없으면 같은 후보의 앞 단계 보고서를 읽는다(before-release → before-deploy → before-build).
  const fallback = policy.phases.assetFallback;
  const candidates = fallback.slice(fallback.indexOf(phase)).map(nameFor);
  const assetName = candidates.find(name => assets.some(asset => asset.name === name)) ?? candidates[0];
  const matches = assets.filter(asset => asset.name === assetName);
  if (matches.length !== 1) throw new Error(`REQUIRED_DEVELOPMENT_EVIDENCE_MISSING ${candidates.join(' | ')}`);
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.size > MAX_FILE_BYTES) throw new Error('INVALID_EVIDENCE_ASSET');
  const bytes = await githubDownload(`/repos/${repository}/releases/assets/${asset.id}`, request);
  if (bytes.length > MAX_FILE_BYTES) throw new Error('EVIDENCE_ASSET_TOO_LARGE');
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('INVALID_EVIDENCE_JSON'); }
  const featureInventory = await readRemoteInventory(repository, sourceSha, request);
  const remote = await readRemoteContext(document, repository, sourceSha, request, featureInventory);
  const ciRuns = await readCiRuns(document, request);
  const result = validateDevelopmentEvidence(document, { ...options, featureInventory, ...remote, ciRuns });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return { ...result, assetId: asset.id, completedAt: document.schemaVersion === 1 ? document.e2e.completedAt : result.completedAt };
}

export async function runDevelopmentEvidenceCli(argv, env = process.env) {
  const args = new Map();
  const allowed = new Set(['file', 'feature-inventory', 'repo', 'tag', 'sha', 'target', 'phase', 'configuration-fingerprint',
    'rollout', 'play-track', 'play-operation', 'internal-testflight-bootstrap-id', 'verifier-sha', 'report', 'artifact-receipt', 'artifact-file', 'app-repository', 'after']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/u, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || args.has(key)) throw new Error('INVALID_EVIDENCE_ARGUMENT');
    args.set(key, argv[i + 1]);
  }
  const context = { repository: args.get('repo') ?? env.GITHUB_REPOSITORY, sourceSha: args.get('sha'), target: args.get('target'), tag: args.get('tag'), phase: args.get('phase'), configurationFingerprint: args.get('configuration-fingerprint'), requireUi: args.get('target') !== 'service' };
  context.playTrack = args.get('play-track');
  context.playOperation = args.get('play-operation');
  if (args.has('rollout')) {
    const rollout = Number(args.get('rollout'));
    if (!/^(0(\.\d+)?|1(\.0+)?)$/u.test(args.get('rollout')) || !(rollout > 0 && rollout <= 1)) throw new Error('INVALID_EVIDENCE_ARGUMENT');
    context.rollout = rollout;
  }
  if (args.has('internal-testflight-bootstrap-id')) {
    if (args.has('file')) throw new Error('INVALID_EVIDENCE_ARGUMENT');
    const { verifyInternalTestflightBootstrap } = await import('./internal-testflight-bootstrap.mjs');
    const result = await verifyInternalTestflightBootstrap({ ...context, tag: args.get('tag'), env,
      bootstrapId: args.get('internal-testflight-bootstrap-id'), verifierSha: args.get('verifier-sha'),
      appRepository: args.get('app-repository'), artifactFile: args.get('artifact-file'), artifactReceipt: args.get('artifact-receipt') });
    if (args.has('report')) writeFileSync(args.get('report'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`검수 시점 예외 human_exception: 내부 TestFlight 한 건; 제품 E2E blocked\n`);
    return result;
  }
  if (['verifier-sha', 'report', 'artifact-receipt', 'artifact-file', 'app-repository'].some(key => args.has(key))) throw new Error('INTERNAL_TESTFLIGHT_BOOTSTRAP_ID_REQUIRED');
  if (!PHASES.includes(context.phase) || !TARGETS.includes(context.target)) throw new Error('INVALID_EVIDENCE_CONTEXT');
  let result;
  if (args.has('file')) {
    const document = JSON.parse(readFileSync(args.get('file'), 'utf8'));
    const featureInventory = JSON.parse(readFileSync(args.get('feature-inventory') ?? INVENTORY_PATH, 'utf8'));
    const local = readLocalContext(document, context.sourceSha, featureInventory);
    const ciRuns = await readCiRuns(document, { env });
    const validated = validateDevelopmentEvidence(document, { ...context, featureInventory, ...local, ciRuns });
    result = { ...validated, completedAt: document?.schemaVersion === 1 ? document?.e2e?.completedAt : validated.completedAt };
  } else {
    result = await verifyReleaseDevelopmentEvidence({ ...context, tag: args.get('tag') ?? EVIDENCE_ARCHIVE_TAG, env });
  }
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const after = args.get('after');
  if (after !== undefined && (!Number.isFinite(Date.parse(after)) || !(Date.parse(result.completedAt) >= Date.parse(after)))) throw new Error('EVIDENCE_COMPLETION_BEFORE_BUILD');
  if (env.GITHUB_OUTPUT && result.completedAt) appendFileSync(env.GITHUB_OUTPUT, `completed_at=${result.completedAt}\n`);
  if (result.decisionStatus === 'human_exception') {
    process.stdout.write(`검수 승인 예외 human_exception: ${result.exceptionId} ${context.target} ${context.phase} ${context.sourceSha}\n원래 검증 failed: ${result.originalVerdict.errors.join(', ')}\n`);
  } else {
    process.stdout.write(`개발 검수 근거 통과${result.level ? `(${result.level})` : ''}: ${context.target} ${context.phase} ${context.sourceSha}\n`);
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDevelopmentEvidenceCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
