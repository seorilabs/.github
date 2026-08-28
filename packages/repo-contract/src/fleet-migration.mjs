import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const SOURCE_CONTRACTS_ROOT = fileURLToPath(
  new URL("../../../contracts", import.meta.url),
);
const PACKAGED_CONTRACTS_ROOT = fileURLToPath(
  new URL("../.generated/contracts", import.meta.url),
);
const CONTRACTS_ROOT = existsSync(SOURCE_CONTRACTS_ROOT)
  ? SOURCE_CONTRACTS_ROOT
  : PACKAGED_CONTRACTS_ROOT;

const INVENTORY_SCHEMA_PATH = resolve(
  CONTRACTS_ROOT,
  "fleet-migration-inventory.schema.json",
);
const PLAN_SCHEMA_PATH = resolve(
  CONTRACTS_ROOT,
  "fleet-migration-plan.schema.json",
);
const ajv = new Ajv2020({ strict: true, validateFormats: false });
const validateInventorySchema = ajv.compile(
  JSON.parse(readFileSync(INVENTORY_SCHEMA_PATH, "utf8")),
);
const validatePlanSchema = ajv.compile(
  JSON.parse(readFileSync(PLAN_SCHEMA_PATH, "utf8")),
);

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const NEEDS_INPUT_REASONS = new Set([
  "INVENTORY_COVERAGE_INCOMPLETE",
  "ACTIVE_REPOSITORY_COUNT_MISMATCH",
  "CANDIDATE_COUNT_MISMATCH",
  "REPOSITORY_IDENTITY_DUPLICATE",
  "CANDIDATE_DUPLICATE",
  "UNCLASSIFIED_CANDIDATE",
  "DETECTION_PATH_MISMATCH",
]);
const CATEGORY_TO_COUNT_KEY = Object.freeze({
  LEGACY_OPERATION_JSON: "legacyOperationJson",
  WORKFLOW_SECRETS_INHERIT: "workflowSecretsInherit",
  WORKFLOW_FLOATING_REF: "workflowFloatingRef",
  UNCLASSIFIED: "unclassified",
});
const CATEGORY_TO_OPERATION = Object.freeze({
  LEGACY_OPERATION_JSON: "DELETE",
  WORKFLOW_SECRETS_INHERIT: "REWRITE",
  WORKFLOW_FLOATING_REF: "REWRITE",
  UNCLASSIFIED: "NONE",
});
const CATEGORY_TO_REPLACEMENT = Object.freeze({
  LEGACY_OPERATION_JSON: "SIGNED_RESOLVED_MANIFEST",
  WORKFLOW_SECRETS_INHERIT: "EXPLICIT_SECRET_MAPPING",
  WORKFLOW_FLOATING_REF: "PINNED_WORKFLOW_CALLER",
});
const BUILD_TARGET_ORDER = Object.freeze([
  "ORG_CONTRACT_STATIC",
  "ANDROID",
  "IOS",
  "APPS_IN_TOSS",
  "WEB",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function schemaDiagnostics(errors) {
  return [
    ...new Set(
      (errors ?? []).map(
        ({ instancePath, keyword }) =>
          `${instancePath.length > 0 ? instancePath : "/"}:${keyword}`,
      ),
    ),
  ].sort();
}

function compareNumericIds(left, right) {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function compareBuildTargets(left, right) {
  return BUILD_TARGET_ORDER.indexOf(left) - BUILD_TARGET_ORDER.indexOf(right);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function outcomeForReasons(reasons) {
  if (reasons.some((reason) => NEEDS_INPUT_REASONS.has(reason))) {
    return "NEEDS_INPUT";
  }
  return reasons.length === 0 ? "READY_FOR_REVIEW" : "BLOCKED";
}

function normalizeDetection(detection) {
  if (
    detection.type === "WORKFLOW_SECRETS_INHERIT" ||
    detection.type === "WORKFLOW_FLOATING_REF"
  ) {
    return {
      ...structuredClone(detection),
      occurrenceLines: [...detection.occurrenceLines].sort(
        (left, right) => left - right,
      ),
    };
  }
  if (detection.type === "UNCLASSIFIED") {
    return {
      ...structuredClone(detection),
      candidateKinds: [...detection.candidateKinds].sort(),
    };
  }
  return structuredClone(detection);
}

function normalizeReplacement(replacement) {
  if (replacement === null) return null;
  const normalized = structuredClone(replacement);
  if (normalized.type === "EXPLICIT_SECRET_MAPPING") {
    normalized.namedCredentialLogicalIds = [
      ...normalized.namedCredentialLogicalIds,
    ].sort();
  }
  return normalized;
}

function normalizeProofs(proofs) {
  return {
    sourceReadback: structuredClone(proofs.sourceReadback),
    parity: [...proofs.parity]
      .map((proof) => structuredClone(proof))
      .sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.observationId.localeCompare(right.observationId),
      ),
    buildOnly: [...proofs.buildOnly]
      .map((proof) => structuredClone(proof))
      .sort(
        (left, right) =>
          compareBuildTargets(left.target, right.target) ||
          compareNumericIds(left.runId, right.runId),
      ),
    rollback: structuredClone(proofs.rollback),
    controlPlaneReadback: structuredClone(proofs.controlPlaneReadback),
  };
}

function normalizedCandidate(candidate) {
  return {
    ...structuredClone(candidate),
    detection: normalizeDetection(candidate.detection),
    requiredBuildTargets: [...candidate.requiredBuildTargets].sort(
      compareBuildTargets,
    ),
    replacement: normalizeReplacement(candidate.replacement),
    proofs: normalizeProofs(candidate.proofs),
  };
}

function normalizedRepositoryIdentity(repository) {
  return {
    id: repository.id,
    fullName: repository.fullName,
    defaultRef: repository.defaultRef,
    sourceSha: repository.sourceSha,
    archived: repository.archived,
  };
}

export function computeFleetFindingsDigest({
  repositoryId,
  sourceRef,
  sourceSha,
  treeSha,
  candidates,
}) {
  const findings = candidates
    .map((candidate) => ({
      path: candidate.path,
      blobSha: candidate.blobSha,
      contentDigest: candidate.contentDigest,
      detection: normalizeDetection(candidate.detection),
      requiredBuildTargets: [...candidate.requiredBuildTargets].sort(
        compareBuildTargets,
      ),
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.detection.type.localeCompare(right.detection.type) ||
        left.blobSha.localeCompare(right.blobSha),
    );
  return sha256(
    canonicalJson({
      repositoryId,
      sourceRef,
      sourceSha,
      treeSha,
      findings,
    }),
  );
}

export function computeFleetRepositoryReadbackDigest({
  organizationId,
  repositories,
}) {
  const normalized = [...repositories]
    .map(normalizedRepositoryIdentity)
    .sort(
      (left, right) =>
        compareNumericIds(left.id, right.id) ||
        left.fullName.localeCompare(right.fullName),
    );
  return sha256(
    canonicalJson({
      organizationId,
      organizationLogin: "seorilabs",
      repositories: normalized,
    }),
  );
}

export function validateFleetMigrationInventory(inventory) {
  const ok = validateInventorySchema(inventory);
  return deepFreeze({
    ok: Boolean(ok),
    diagnostics: ok ? [] : schemaDiagnostics(validateInventorySchema.errors),
  });
}

function assertValidInventory(inventory) {
  const result = validateFleetMigrationInventory(inventory);
  if (!result.ok) {
    throw new Error(
      `FLEET_MIGRATION_INVENTORY_INVALID:${result.diagnostics.join(",")}`,
    );
  }
}

function classifyCandidate(candidate, repository) {
  const { detection, path } = candidate;
  if (detection.type === "UNCLASSIFIED") {
    return {
      category: "UNCLASSIFIED",
      reasons: ["UNCLASSIFIED_CANDIDATE"],
    };
  }

  if (detection.type === "LEGACY_OPERATION_JSON") {
    let pathMatches = path.endsWith(".json");
    if (detection.contract === "BACKOFFICE_OPERATIONS") {
      pathMatches = path === ".seorilabs/backoffice.json";
    } else if (detection.contract === "MARKET_LAUNCH_STATE") {
      pathMatches = path.split("/").at(-1) === "market-launch-state.json";
    } else if (detection.contract === "PLATFORM_REGISTRY_APP") {
      pathMatches =
        repository.fullName === "seorilabs/platform" &&
        /^registry\/apps\/[A-Za-z0-9._-]+\.json$/u.test(path);
    }
    return {
      category: "LEGACY_OPERATION_JSON",
      reasons: pathMatches ? [] : ["DETECTION_PATH_MISMATCH"],
    };
  }

  const workflowPathMatches = WORKFLOW_PATH_PATTERN.test(path);
  if (detection.type === "WORKFLOW_SECRETS_INHERIT") {
    return {
      category: "WORKFLOW_SECRETS_INHERIT",
      reasons: workflowPathMatches ? [] : ["DETECTION_PATH_MISMATCH"],
    };
  }

  const isFloating = !SHA_PATTERN.test(detection.ref);
  return {
    category: isFloating
      ? "WORKFLOW_FLOATING_REF"
      : "UNCLASSIFIED",
    reasons:
      workflowPathMatches && isFloating
        ? []
        : [
            isFloating
              ? "DETECTION_PATH_MISMATCH"
              : "UNCLASSIFIED_CANDIDATE",
          ],
  };
}

function replacementDigest(replacement) {
  if (replacement === null) return null;
  if (replacement.type === "SIGNED_RESOLVED_MANIFEST") {
    return replacement.configRevisionDigest;
  }
  return replacement.replacementBlobDigest;
}

function replacementReasons(category, detection, replacement) {
  if (category === "UNCLASSIFIED") return [];
  if (replacement === null) return ["REPLACEMENT_MISSING"];
  if (replacement.type !== CATEGORY_TO_REPLACEMENT[category]) {
    return ["REPLACEMENT_TYPE_MISMATCH"];
  }
  if (
    category === "WORKFLOW_FLOATING_REF" &&
    replacement.workflowRef !==
      `${detection.calledWorkflow}@${replacement.workflowBundleSha}`
  ) {
    return ["REPLACEMENT_TYPE_MISMATCH"];
  }
  return [];
}

function sourceReadbackReasons(
  candidate,
  repository,
  capturedAt,
  discoveryObservedAt,
) {
  const readback = candidate.proofs.sourceReadback;
  if (readback === null) return ["SOURCE_READBACK_MISSING"];
  const otherEvidenceTimes = [
    ...candidate.proofs.parity.map(({ observedAt }) => observedAt),
    ...candidate.proofs.buildOnly.map(({ completedAt }) => completedAt),
    candidate.proofs.rollback?.verifiedAt,
    candidate.proofs.controlPlaneReadback?.observedAt,
  ]
    .filter((value) => value !== undefined)
    .map((value) => Date.parse(value));
  const readbackAt = Date.parse(readback.observedAt);
  const latestOtherEvidenceAt = Math.max(
    Number.NEGATIVE_INFINITY,
    ...otherEvidenceTimes,
  );
  const matches =
    readback.repositoryId === repository.id &&
    readback.sourceRef === repository.defaultRef &&
    readback.sourceSha === repository.sourceSha &&
    readback.path === candidate.path &&
    readback.blobSha === candidate.blobSha &&
    readback.contentDigest === candidate.contentDigest &&
    Number.isFinite(readbackAt) &&
    otherEvidenceTimes.every(Number.isFinite) &&
    readbackAt >= Date.parse(discoveryObservedAt) &&
    readbackAt >= latestOtherEvidenceAt &&
    readbackAt <= Date.parse(capturedAt);
  return matches ? [] : ["SOURCE_READBACK_MISMATCH"];
}

function parityReasons(candidate, repository, expectedReplacementDigest) {
  const parity = candidate.proofs.parity;
  if (parity.length !== 2) return ["PARITY_REQUIRES_TWO_MATCHES"];
  const [first, second] = parity;
  const matches =
    first.sequence === 1 &&
    second.sequence === 2 &&
    first.observationId !== second.observationId &&
    first.evidenceDigest !== second.evidenceDigest &&
    Date.parse(first.observedAt) < Date.parse(second.observedAt) &&
    parity.every(
      (proof) =>
        proof.sourceSha === repository.sourceSha &&
        proof.currentContentDigest === candidate.contentDigest &&
        proof.replacementDigest === expectedReplacementDigest,
    );
  return matches ? [] : ["PARITY_MISMATCH"];
}

function buildOnlyReasons(candidate, repository, replacement) {
  const proofs = candidate.proofs.buildOnly;
  if (proofs.length === 0) return ["BUILD_ONLY_MISSING"];
  const requiredTargets = [...candidate.requiredBuildTargets].sort(
    compareBuildTargets,
  );
  const observedTargets = proofs
    .map(({ target }) => target)
    .sort(compareBuildTargets);
  const uniqueTargets = new Set(observedTargets);
  const expectedWorkflowBundleSha =
    replacement?.workflowBundleSha ?? proofs[0]?.workflowBundleSha;
  const matches =
    canonicalJson(requiredTargets) === canonicalJson(observedTargets) &&
    uniqueTargets.size === observedTargets.length &&
    proofs.every(
      (proof) =>
        proof.sourceSha === repository.sourceSha &&
        proof.workflowBundleSha === expectedWorkflowBundleSha,
    );
  return matches ? [] : ["BUILD_ONLY_MISMATCH"];
}

function rollbackReasons(candidate, repository) {
  const rollback = candidate.proofs.rollback;
  if (rollback === null) return ["ROLLBACK_MISSING"];
  const matches =
    rollback.sourceSha === repository.sourceSha &&
    rollback.path === candidate.path &&
    rollback.originalBlobSha === candidate.blobSha &&
    rollback.originalContentDigest === candidate.contentDigest;
  return matches ? [] : ["ROLLBACK_MISMATCH"];
}

function controlPlaneReadbackReasons(
  candidate,
  repository,
  expectedReplacementDigest,
) {
  const readback = candidate.proofs.controlPlaneReadback;
  if (readback === null) return ["CONTROL_PLANE_READBACK_MISSING"];
  const matches =
    readback.repositoryId === repository.id &&
    readback.sourceSha === repository.sourceSha &&
    readback.replacementDigest === expectedReplacementDigest;
  return matches ? [] : ["CONTROL_PLANE_READBACK_MISMATCH"];
}

function proofReasons(
  candidate,
  repository,
  expectedReplacementDigest,
  capturedAt,
  discoveryObservedAt,
) {
  if (expectedReplacementDigest === null) return [];
  return [
    ...sourceReadbackReasons(
      candidate,
      repository,
      capturedAt,
      discoveryObservedAt,
    ),
    ...parityReasons(candidate, repository, expectedReplacementDigest),
    ...buildOnlyReasons(candidate, repository, candidate.replacement),
    ...rollbackReasons(candidate, repository),
    ...controlPlaneReadbackReasons(
      candidate,
      repository,
      expectedReplacementDigest,
    ),
  ];
}

function observationReasons(repositoryObservation) {
  const { candidates, observation, repository } = repositoryObservation;
  const reasons = [];
  if (!(observation.repositoryId === repository.id &&
    observation.sourceRef === repository.defaultRef &&
    observation.sourceSha === repository.sourceSha)) {
    reasons.push("OBSERVATION_SOURCE_MISMATCH");
  }
  const expectedFindingsDigest = computeFleetFindingsDigest({
    repositoryId: repository.id,
    sourceRef: repository.defaultRef,
    sourceSha: repository.sourceSha,
    treeSha: observation.treeSha,
    candidates,
  });
  if (observation.findingsDigest !== expectedFindingsDigest) {
    reasons.push("OBSERVATION_FINDINGS_DIGEST_MISMATCH");
  }
  return reasons;
}

function migrationId(repositoryId, category, path) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-migration-v1",
      repositoryId,
      category,
      path,
    }),
  );
}

function operationIdempotencyKey({
  inventory,
  repository,
  change,
}) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-migration-v1",
      inventoryId: inventory.inventoryId,
      repositoriesDigest: inventory.repositoriesDigest,
      detectorSourceSha: inventory.detectorSourceSha,
      repositoryId: repository.repositoryId,
      sourceRef: repository.sourceRef,
      sourceSha: repository.sourceSha,
      migrationId: change.migrationId,
      category: change.category,
      operation: change.operation,
      path: change.path,
      blobSha: change.blobSha,
      contentDigest: change.contentDigest,
      requiredBuildTargets: change.requiredBuildTargets,
      replacementDigest: change.replacementDigest,
    }),
  );
}

function observedCounts(repositories) {
  const counts = {
    activeRepositories: repositories.length,
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
    unclassified: 0,
  };
  for (const { repository, candidates } of repositories) {
    for (const candidate of candidates) {
      const { category } = classifyCandidate(candidate, repository);
      counts[CATEGORY_TO_COUNT_KEY[category]] += 1;
    }
  }
  return counts;
}

function duplicateRepositoryReasons(repositories) {
  const ids = new Map();
  const names = new Map();
  for (const { repository } of repositories) {
    ids.set(repository.id, (ids.get(repository.id) ?? 0) + 1);
    names.set(
      repository.fullName,
      (names.get(repository.fullName) ?? 0) + 1,
    );
  }
  const duplicateIds = new Set(
    [...ids].filter(([, count]) => count > 1).map(([id]) => id),
  );
  const duplicateNames = new Set(
    [...names].filter(([, count]) => count > 1).map(([name]) => name),
  );
  return { duplicateIds, duplicateNames };
}

function inventoryReasons(inventory, counts) {
  const reasons = [];
  if (!inventory.coverage.complete || inventory.coverage.nextCursor !== null) {
    reasons.push("INVENTORY_COVERAGE_INCOMPLETE");
  }
  const computedDigest = computeFleetRepositoryReadbackDigest({
    organizationId: inventory.organization.id,
    repositories: inventory.repositories.map(({ repository }) => repository),
  });
  if (computedDigest !== inventory.coverage.repositoriesDigest) {
    reasons.push("INVENTORY_REPOSITORY_DIGEST_MISMATCH");
  }
  const capturedAt = Date.parse(inventory.capturedAt);
  const observationTimes = [
    Date.parse(inventory.coverage.observedAt),
    ...inventory.repositories.map(({ observation }) =>
      Date.parse(observation.observedAt),
    ),
  ];
  if (
    !Number.isFinite(capturedAt) ||
    !observationTimes.every(
      (observedAt) => Number.isFinite(observedAt) && observedAt <= capturedAt,
    )
  ) {
    reasons.push("INVENTORY_TIME_MISMATCH");
  }
  if (
    inventory.coverage.activeRepositoryCount !== counts.activeRepositories ||
    inventory.expectedCounts.activeRepositories !== counts.activeRepositories
  ) {
    reasons.push("ACTIVE_REPOSITORY_COUNT_MISMATCH");
  }
  if (
    inventory.expectedCounts.legacyOperationJson !==
      counts.legacyOperationJson ||
    inventory.expectedCounts.workflowSecretsInherit !==
      counts.workflowSecretsInherit ||
    inventory.expectedCounts.workflowFloatingRef !==
      counts.workflowFloatingRef ||
    counts.unclassified > 0
  ) {
    reasons.push("CANDIDATE_COUNT_MISMATCH");
  }
  const { duplicateIds, duplicateNames } =
    duplicateRepositoryReasons(inventory.repositories);
  if (duplicateIds.size > 0 || duplicateNames.size > 0) {
    reasons.push("REPOSITORY_IDENTITY_DUPLICATE");
  }
  return sortedUnique(reasons);
}

function duplicateCandidateKeys(candidates, repository) {
  const counts = new Map();
  for (const candidate of candidates) {
    const { category } = classifyCandidate(candidate, repository);
    const key = `${category}\u0000${candidate.path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([key]) => key),
  );
}

function planRepository(
  repositoryObservation,
  inventorySummary,
  globalReasons,
  duplicateRepositories,
) {
  const { repository } = repositoryObservation;
  const candidates = repositoryObservation.candidates
    .map(normalizedCandidate)
    .sort((left, right) => {
      const leftCategory = classifyCandidate(left, repository).category;
      const rightCategory = classifyCandidate(right, repository).category;
      return (
        left.path.localeCompare(right.path) ||
        leftCategory.localeCompare(rightCategory) ||
        left.blobSha.localeCompare(right.blobSha)
      );
    });
  const repositoryReasons = [
    ...globalReasons,
    ...observationReasons(repositoryObservation),
  ];
  if (
    duplicateRepositories.duplicateIds.has(repository.id) ||
    duplicateRepositories.duplicateNames.has(repository.fullName)
  ) {
    repositoryReasons.push("REPOSITORY_IDENTITY_DUPLICATE");
  }
  const duplicateKeys = duplicateCandidateKeys(candidates, repository);

  const repositoryContext = {
    repositoryId: repository.id,
    fullName: repository.fullName,
    sourceRef: repository.defaultRef,
    sourceSha: repository.sourceSha,
  };
  const changes = candidates.map((candidate) => {
    const classification = classifyCandidate(candidate, repository);
    const expectedReplacementDigest = replacementDigest(candidate.replacement);
    const duplicateKey = `${classification.category}\u0000${candidate.path}`;
    const reasons = sortedUnique([
      ...repositoryReasons,
      ...classification.reasons,
      ...(duplicateKeys.has(duplicateKey) ? ["CANDIDATE_DUPLICATE"] : []),
      ...replacementReasons(
        classification.category,
        candidate.detection,
        candidate.replacement,
      ),
      ...(candidate.detection.detectorSha === inventorySummary.detectorSourceSha
        ? []
        : ["DETECTOR_SOURCE_MISMATCH"]),
      ...proofReasons(
        candidate,
        repository,
        expectedReplacementDigest,
        inventorySummary.capturedAt,
        repositoryObservation.observation.observedAt,
      ),
    ]);
    const baseChange = {
      migrationId: migrationId(
        repository.id,
        classification.category,
        candidate.path,
      ),
      category: classification.category,
      operation: CATEGORY_TO_OPERATION[classification.category],
      path: candidate.path,
      blobSha: candidate.blobSha,
      contentDigest: candidate.contentDigest,
      requiredBuildTargets: candidate.requiredBuildTargets,
      replacementDigest: expectedReplacementDigest,
      proofDigest: sha256(canonicalJson(candidate.proofs)),
      outcome: outcomeForReasons(reasons),
      reasonCodes: reasons,
    };
    return {
      ...baseChange,
      idempotencyKey: operationIdempotencyKey({
        inventory: inventorySummary,
        repository: repositoryContext,
        change: baseChange,
      }),
    };
  });
  const reasons = sortedUnique([
    ...repositoryReasons,
    ...changes.flatMap(({ reasonCodes }) => reasonCodes),
  ]);
  return {
    ...repositoryContext,
    outcome: outcomeForReasons(reasons),
    reasonCodes: reasons,
    changes,
  };
}

function withoutPlanDigest(plan) {
  const { planDigest: _planDigest, ...unsigned } = plan;
  return unsigned;
}

export function createFleetMigrationPlan(inventory) {
  assertValidInventory(inventory);
  const normalizedRepositories = [...inventory.repositories].sort(
    (left, right) =>
      compareNumericIds(left.repository.id, right.repository.id) ||
      left.repository.fullName.localeCompare(right.repository.fullName),
  );
  const counts = observedCounts(normalizedRepositories);
  const reasons = inventoryReasons(inventory, counts);
  const inventorySummary = {
    inventoryId: inventory.inventoryId,
    capturedAt: inventory.capturedAt,
    organizationId: inventory.organization.id,
    detectorSourceSha: inventory.detector.sourceSha,
    coverageReadbackId: inventory.coverage.readbackId,
    repositoriesDigest: inventory.coverage.repositoriesDigest,
    expectedCounts: structuredClone(inventory.expectedCounts),
    observedCounts: counts,
  };
  const duplicateRepositories = duplicateRepositoryReasons(
    normalizedRepositories,
  );
  const repositories = normalizedRepositories.map((repository) =>
    planRepository(
      repository,
      inventorySummary,
      reasons,
      duplicateRepositories,
    ),
  );
  const allReasons = sortedUnique([
    ...reasons,
    ...repositories.flatMap(({ reasonCodes }) => reasonCodes),
  ]);
  const unsigned = {
    schemaVersion: 1,
    mode: "PLAN_ONLY",
    executionAllowed: false,
    inventory: inventorySummary,
    outcome: outcomeForReasons(allReasons),
    reasonCodes: allReasons,
    repositories,
  };
  const plan = {
    ...unsigned,
    planDigest: sha256(canonicalJson(unsigned)),
  };
  const validation = validateFleetMigrationPlan(plan);
  if (!validation.ok) {
    throw new Error(
      `FLEET_MIGRATION_PLAN_INVALID:${validation.diagnostics.join(",")}`,
    );
  }
  return deepFreeze(plan);
}

function semanticPlanDiagnostics(plan) {
  const diagnostics = [];
  if (plan.planDigest !== sha256(canonicalJson(withoutPlanDigest(plan)))) {
    diagnostics.push("PLAN_DIGEST_MISMATCH");
  }
  const expectedRootReasons = sortedUnique([
    ...plan.repositories.flatMap(({ reasonCodes }) => reasonCodes),
  ]);
  if (canonicalJson(plan.reasonCodes) !== canonicalJson(expectedRootReasons)) {
    diagnostics.push("PLAN_REASON_SUMMARY_MISMATCH");
  }
  if (plan.outcome !== outcomeForReasons(plan.reasonCodes)) {
    diagnostics.push("PLAN_OUTCOME_MISMATCH");
  }
  const sortedRepositories = [...plan.repositories].sort(
    (left, right) =>
      compareNumericIds(left.repositoryId, right.repositoryId) ||
      left.fullName.localeCompare(right.fullName),
  );
  if (canonicalJson(sortedRepositories) !== canonicalJson(plan.repositories)) {
    diagnostics.push("PLAN_REPOSITORY_ORDER_INVALID");
  }
  for (const repository of plan.repositories) {
    const sortedRepositoryReasons = sortedUnique(repository.reasonCodes);
    const changeReasonSummary = sortedUnique(
      repository.changes.flatMap(({ reasonCodes }) => reasonCodes),
    );
    if (canonicalJson(repository.reasonCodes) !== canonicalJson(sortedRepositoryReasons)) {
      diagnostics.push("PLAN_REPOSITORY_REASON_SUMMARY_MISMATCH");
    }
    if (
      repository.changes.length > 0 &&
      canonicalJson(repository.reasonCodes) !== canonicalJson(changeReasonSummary)
    ) {
      diagnostics.push("PLAN_REPOSITORY_REASON_SUMMARY_MISMATCH");
    }
    if (repository.outcome !== outcomeForReasons(repository.reasonCodes)) {
      diagnostics.push("PLAN_REPOSITORY_OUTCOME_MISMATCH");
    }
    const sortedChanges = [...repository.changes].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.category.localeCompare(right.category) ||
        left.blobSha.localeCompare(right.blobSha),
    );
    if (canonicalJson(repository.changes) !== canonicalJson(sortedChanges)) {
      diagnostics.push("PLAN_CHANGE_ORDER_INVALID");
    }
    for (const change of repository.changes) {
      if (
        canonicalJson(change.reasonCodes) !==
        canonicalJson(sortedUnique(change.reasonCodes))
      ) {
        diagnostics.push("PLAN_CHANGE_REASON_ORDER_INVALID");
      }
      if (
        canonicalJson(change.requiredBuildTargets) !==
        canonicalJson(
          [...change.requiredBuildTargets].sort(compareBuildTargets),
        )
      ) {
        diagnostics.push("PLAN_BUILD_TARGET_ORDER_INVALID");
      }
      if (change.outcome !== outcomeForReasons(change.reasonCodes)) {
        diagnostics.push("PLAN_CHANGE_OUTCOME_MISMATCH");
      }
      if (change.operation !== CATEGORY_TO_OPERATION[change.category]) {
        diagnostics.push("PLAN_CHANGE_OPERATION_MISMATCH");
      }
      const expectedMigrationId = migrationId(
        repository.repositoryId,
        change.category,
        change.path,
      );
      if (change.migrationId !== expectedMigrationId) {
        diagnostics.push("PLAN_MIGRATION_ID_MISMATCH");
      }
      const expectedIdempotencyKey = operationIdempotencyKey({
        inventory: plan.inventory,
        repository,
        change,
      });
      if (change.idempotencyKey !== expectedIdempotencyKey) {
        diagnostics.push("PLAN_IDEMPOTENCY_KEY_MISMATCH");
      }
    }
  }
  const observedCountsFromPlan = {
    activeRepositories: plan.repositories.length,
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
    unclassified: 0,
  };
  for (const repository of plan.repositories) {
    for (const change of repository.changes) {
      observedCountsFromPlan[CATEGORY_TO_COUNT_KEY[change.category]] += 1;
    }
  }
  if (
    canonicalJson(plan.inventory.observedCounts) !==
    canonicalJson(observedCountsFromPlan)
  ) {
    diagnostics.push("PLAN_OBSERVED_COUNTS_MISMATCH");
  }
  return sortedUnique(diagnostics);
}

export function validateFleetMigrationPlan(plan) {
  const schemaOk = validatePlanSchema(plan);
  if (!schemaOk) {
    return deepFreeze({
      ok: false,
      diagnostics: schemaDiagnostics(validatePlanSchema.errors),
    });
  }
  const diagnostics = semanticPlanDiagnostics(plan);
  return deepFreeze({ ok: diagnostics.length === 0, diagnostics });
}

export const fleetMigrationContract = deepFreeze({
  schemaVersion: 1,
  mode: "PLAN_ONLY",
  executionAllowed: false,
  initialBaseline: {
    observedDate: "2026-08-29",
    expectedCounts: {
      activeRepositories: 38,
      legacyOperationJson: 73,
      workflowSecretsInherit: 108,
      workflowFloatingRef: 87,
    },
  },
  inventorySchema: "fleet-migration-inventory.schema.json",
  planSchema: "fleet-migration-plan.schema.json",
  requiredProofs: [
    "exact-source-readback",
    "two-consecutive-parity-matches",
    "declared-target-build-only",
    "rollback-restore-validation",
    "control-plane-readback",
  ],
  prohibitedOperations: [
    "repository-write",
    "pull-request-create",
    "file-delete",
    "workflow-rewrite",
    "secret-read",
    "provider-mutation",
  ],
});
