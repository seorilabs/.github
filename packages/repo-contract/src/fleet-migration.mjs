import {
  createHash,
  verify as verifyEd25519,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
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
const ajv = new Ajv2020({ strict: true, validateFormats: false });
const validateInventorySchema = ajv.compile(
  JSON.parse(
    readFileSync(
      resolve(CONTRACTS_ROOT, "fleet-migration-inventory.schema.json"),
      "utf8",
    ),
  ),
);
const validatePlanSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      resolve(CONTRACTS_ROOT, "fleet-migration-plan.schema.json"),
      "utf8",
    ),
  ),
);

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;
const INVENTORY_BINDINGS = new WeakSet();
const INITIAL_BASELINE = Object.freeze({
  activeRepositories: 38,
  legacyOperationJson: 73,
  workflowSecretsInherit: 108,
  workflowFloatingRef: 87,
});
const BUILD_TARGET_ORDER = Object.freeze([
  "ORG_CONTRACT_STATIC",
  "ANDROID",
  "IOS",
  "APPS_IN_TOSS",
  "WEB",
]);
const CATEGORY_ORDER = Object.freeze([
  "LEGACY_OPERATION_JSON",
  "WORKFLOW_SECRETS_INHERIT",
  "WORKFLOW_FLOATING_REF",
  "UNCLASSIFIED",
]);
const CATEGORY_TO_COUNT_KEY = Object.freeze({
  LEGACY_OPERATION_JSON: "legacyOperationJson",
  WORKFLOW_SECRETS_INHERIT: "workflowSecretsInherit",
  WORKFLOW_FLOATING_REF: "workflowFloatingRef",
  UNCLASSIFIED: "unclassified",
});
const CATEGORY_TO_REPLACEMENT = Object.freeze({
  LEGACY_OPERATION_JSON: "SIGNED_RESOLVED_MANIFEST",
  WORKFLOW_SECRETS_INHERIT: "EXPLICIT_SECRET_MAPPING",
  WORKFLOW_FLOATING_REF: "PINNED_WORKFLOW_CALLER",
});
const NEEDS_INPUT_REASONS = new Set([
  "INITIAL_BASELINE_MISMATCH",
  "INVENTORY_COVERAGE_INCOMPLETE",
  "INVENTORY_PAGINATION_CHAIN_MISMATCH",
  "ACTIVE_REPOSITORY_COUNT_MISMATCH",
  "CANDIDATE_COUNT_MISMATCH",
  "REPOSITORY_IDENTITY_DUPLICATE",
  "UNSAFE_RELATIVE_PATH",
  "PATH_CANONICAL_COLLISION",
  "PATH_SOURCE_COLLISION",
  "PATH_REPLACEMENT_COLLISION",
  "PATH_PROOF_COLLISION",
  "CANDIDATE_DUPLICATE",
  "UNCLASSIFIED_CANDIDATE",
  "DETECTION_PATH_MISMATCH",
  "DETECTION_SCHEMA_MISMATCH",
]);
const LEGACY_CONTRACTS = Object.freeze({
  GOOGLE_PLAY: Object.freeze({
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/google-play.schema.json",
    path: "play-store/google-play.config.json",
  }),
  APP_STORE: Object.freeze({
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/app-store.schema.json",
    path: "app-store/app-store.config.json",
  }),
  APPS_IN_TOSS: Object.freeze({
    schemaId:
      "https://seorilabs.github.io/contracts/v1/markets/apps-in-toss.schema.json",
    path: "apps-in-toss/apps-in-toss.config.json",
  }),
  MARKET_LAUNCH_STATE: Object.freeze({
    schemaId:
      "https://seorilabs.com/contracts/legacy/market-launch-state.v1.schema.json",
    path: "release/market-launch-state.json",
  }),
  PLATFORM_REGISTRY_APP: Object.freeze({
    schemaId:
      "https://seorilabs.com/contracts/legacy/platform-registry-app.v1.schema.json",
  }),
  BACKOFFICE_OPERATIONS: Object.freeze({
    schemaId:
      "https://seorilabs.com/contracts/legacy/backoffice-operations.v1.schema.json",
    path: ".seorilabs/backoffice.json",
  }),
});

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

function compareCategories(left, right) {
  return CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right);
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

function operationForCategories(categories) {
  if (categories.length === 1 && categories[0] === "LEGACY_OPERATION_JSON") {
    return "DELETE";
  }
  if (
    categories.length > 0 &&
    categories.every((category) =>
      ["WORKFLOW_SECRETS_INHERIT", "WORKFLOW_FLOATING_REF"].includes(
        category,
      ),
    )
  ) {
    return "REWRITE";
  }
  return "NONE";
}

function isCanonicalSafeRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.normalize(path) !== path
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function normalizeDetection(detection) {
  const normalized = structuredClone(detection);
  if (Array.isArray(normalized.occurrenceLines)) {
    normalized.occurrenceLines.sort((left, right) => left - right);
  }
  if (Array.isArray(normalized.candidateKinds)) {
    normalized.candidateKinds.sort();
  }
  return normalized;
}

function normalizeReplacement(replacement) {
  if (replacement === null) return null;
  const normalized = structuredClone(replacement);
  if (Array.isArray(normalized.namedCredentialLogicalIds)) {
    normalized.namedCredentialLogicalIds.sort();
  }
  return normalized;
}

function normalizeProofs(proofs) {
  const normalized = structuredClone(proofs);
  if (normalized.marketProfileReadback !== null) {
    normalized.marketProfileReadback.marketBuildTargets.sort(
      compareBuildTargets,
    );
  }
  if (normalized.workflowBundleReadback !== null) {
    normalized.workflowBundleReadback.bindings.sort((left, right) =>
      compareBuildTargets(left.target, right.target),
    );
  }
  normalized.buildOnly.sort(
    (left, right) =>
      compareBuildTargets(left.target, right.target) ||
      compareNumericIds(left.runId, right.runId) ||
      left.runAttempt - right.runAttempt,
  );
  return normalized;
}

function normalizeCandidate(candidate) {
  return {
    ...structuredClone(candidate),
    detection: normalizeDetection(candidate.detection),
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

function normalizedInventoryForDigest(inventory) {
  const { attestation: _attestation, ...unsigned } = structuredClone(inventory);
  unsigned.coverage.pages.sort(
    (left, right) => left.pageNumber - right.pageNumber,
  );
  for (const page of unsigned.coverage.pages) {
    page.repositoryIds.sort(compareNumericIds);
  }
  unsigned.repositories.sort(
    (left, right) =>
      compareNumericIds(left.repository.id, right.repository.id) ||
      left.repository.fullName.localeCompare(right.repository.fullName),
  );
  for (const repository of unsigned.repositories) {
    repository.candidates = repository.candidates
      .map(normalizeCandidate)
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.detection.type.localeCompare(right.detection.type) ||
          left.gitEntry.objectSha.localeCompare(right.gitEntry.objectSha),
      );
  }
  return unsigned;
}

export function computeFleetRepositoryReadbackDigest({
  organizationId,
  repositories,
}) {
  const normalized = repositories
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

export function computeFleetCoveragePageDigest({ readbackId, page }) {
  const { pageDigest: _pageDigest, ...unsignedPage } = structuredClone(page);
  unsignedPage.repositoryIds.sort(compareNumericIds);
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-pagination-v1",
      readbackId,
      page: unsignedPage,
    }),
  );
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
      gitEntry: structuredClone(candidate.gitEntry),
      contentDigest: candidate.contentDigest,
      detection: normalizeDetection(candidate.detection),
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.detection.type.localeCompare(right.detection.type) ||
        left.gitEntry.objectSha.localeCompare(right.gitEntry.objectSha),
    );
  return sha256(
    canonicalJson({ repositoryId, sourceRef, sourceSha, treeSha, findings }),
  );
}

export function computeFleetEvidenceDigest(evidence) {
  const { evidenceDigest: _evidenceDigest, ...unsigned } = evidence;
  return sha256(canonicalJson(unsigned));
}

export function computeFleetMigrationInventoryDigest(inventory) {
  return sha256(canonicalJson(normalizedInventoryForDigest(inventory)));
}

export function validateFleetMigrationInventory(inventory) {
  const ok = validateInventorySchema(inventory);
  return deepFreeze({
    ok: Boolean(ok),
    diagnostics: ok ? [] : schemaDiagnostics(validateInventorySchema.errors),
  });
}

function assertValidInventory(inventory) {
  const validation = validateFleetMigrationInventory(inventory);
  if (!validation.ok) {
    throw new Error(
      `FLEET_MIGRATION_INVENTORY_INVALID:${validation.diagnostics.join(",")}`,
    );
  }
  const candidateCount = inventory.repositories.reduce(
    (sum, repository) => sum + repository.candidates.length,
    0,
  );
  if (candidateCount > 100000) {
    throw new Error("FLEET_MIGRATION_INVENTORY_TOO_LARGE");
  }
}

function attestationPayloadObject(
  inventory,
  { keyId, policyRevision, signedAt, inventoryDigest },
) {
  return {
    contract: "seorilabs-fleet-migration-inventory-attestation-v1",
    algorithm: "Ed25519",
    keyId,
    policyRevision,
    signedAt,
    inventoryDigest,
    organizationId: inventory.organization.id,
    detectorSourceSha: inventory.detector.sourceSha,
    coverageReadbackId: inventory.coverage.readbackId,
    repositoriesDigest: inventory.coverage.repositoriesDigest,
    expectedCounts: structuredClone(inventory.expectedCounts),
  };
}

export function createFleetMigrationAttestationPayload(
  inventory,
  { keyId, policyRevision, signedAt },
) {
  assertValidInventory(inventory);
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  return Buffer.from(
    canonicalJson(
      attestationPayloadObject(inventory, {
        keyId,
        policyRevision,
        signedAt,
        inventoryDigest,
      }),
    ),
    "utf8",
  );
}

function trustedPublicKey(trustedInventoryKeys, keyId) {
  const key =
    trustedInventoryKeys instanceof Map
      ? trustedInventoryKeys.get(keyId)
      : trustedInventoryKeys?.[keyId];
  return key?.type === "public" && key?.asymmetricKeyType === "ed25519"
    ? key
    : null;
}

function observedCounts(repositories) {
  const counts = {
    activeRepositories: repositories.length,
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
    unclassified: 0,
  };
  for (const repository of repositories) {
    for (const candidate of repository.candidates) {
      const category = categoryForDetection(candidate.detection);
      counts[CATEGORY_TO_COUNT_KEY[category]] += 1;
    }
  }
  return counts;
}

function duplicateRepositoryIdentity(repositories) {
  const ids = new Set();
  const names = new Set();
  for (const { repository } of repositories) {
    if (ids.has(repository.id) || names.has(repository.fullName)) return true;
    ids.add(repository.id);
    names.add(repository.fullName);
  }
  return false;
}

function paginationReasons(inventory) {
  const { coverage } = inventory;
  const reasons = [];
  if (!coverage.complete || coverage.nextCursor !== null) {
    reasons.push("INVENTORY_COVERAGE_INCOMPLETE");
  }
  const pages = coverage.pages;
  let expectedCursor = null;
  const pageRepositoryIds = [];
  const seenRepositoryIds = new Set();
  const seenCursors = new Set();
  let chainMatches = pages.length > 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    chainMatches &&=
      page.pageNumber === index + 1 &&
      page.requestCursor === expectedCursor &&
      page.pageDigest ===
        computeFleetCoveragePageDigest({
          readbackId: coverage.readbackId,
          page,
        });
    if (page.requestCursor !== null) {
      chainMatches &&= !seenCursors.has(page.requestCursor);
      seenCursors.add(page.requestCursor);
    }
    for (const repositoryId of page.repositoryIds) {
      chainMatches &&= !seenRepositoryIds.has(repositoryId);
      seenRepositoryIds.add(repositoryId);
      pageRepositoryIds.push(repositoryId);
    }
    expectedCursor = page.responseNextCursor;
  }
  chainMatches &&= expectedCursor === null;
  const exactRepositoryIds = inventory.repositories
    .map(({ repository }) => repository.id)
    .sort(compareNumericIds);
  chainMatches &&=
    canonicalJson([...pageRepositoryIds].sort(compareNumericIds)) ===
    canonicalJson(exactRepositoryIds);
  if (!chainMatches) reasons.push("INVENTORY_PAGINATION_CHAIN_MISMATCH");
  return reasons;
}

function inventoryAuthorityReasons(inventory, counts) {
  const reasons = [...paginationReasons(inventory)];
  if (
    canonicalJson(inventory.expectedCounts) !== canonicalJson(INITIAL_BASELINE) ||
    counts.activeRepositories !== INITIAL_BASELINE.activeRepositories ||
    counts.legacyOperationJson !== INITIAL_BASELINE.legacyOperationJson ||
    counts.workflowSecretsInherit !== INITIAL_BASELINE.workflowSecretsInherit ||
    counts.workflowFloatingRef !== INITIAL_BASELINE.workflowFloatingRef
  ) {
    reasons.push("INITIAL_BASELINE_MISMATCH");
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
  if (duplicateRepositoryIdentity(inventory.repositories)) {
    reasons.push("REPOSITORY_IDENTITY_DUPLICATE");
  }
  const repositoriesDigest = computeFleetRepositoryReadbackDigest({
    organizationId: inventory.organization.id,
    repositories: inventory.repositories.map(({ repository }) => repository),
  });
  if (repositoriesDigest !== inventory.coverage.repositoriesDigest) {
    reasons.push("INVENTORY_REPOSITORY_DIGEST_MISMATCH");
  }
  const capturedAt = Date.parse(inventory.capturedAt);
  const observedTimes = [
    Date.parse(inventory.coverage.observedAt),
    ...inventory.repositories.map(({ observation }) =>
      Date.parse(observation.observedAt),
    ),
  ];
  if (
    !Number.isFinite(capturedAt) ||
    !observedTimes.every(
      (observedAt) => Number.isFinite(observedAt) && observedAt <= capturedAt,
    )
  ) {
    reasons.push("INVENTORY_TIME_MISMATCH");
  }
  return sortedUnique(reasons);
}

export function loadTrustedFleetMigrationInventoryBinding({
  inventory,
  trustedInventoryKeys,
}) {
  assertValidInventory(inventory);
  const counts = observedCounts(inventory.repositories);
  const authorityReasons = inventoryAuthorityReasons(inventory, counts);
  if (authorityReasons.length > 0) {
    throw new Error(
      `FLEET_MIGRATION_INVENTORY_UNTRUSTED:${authorityReasons.join(",")}`,
    );
  }
  const attestation = inventory.attestation;
  if (attestation === null) {
    throw new Error("FLEET_MIGRATION_INVENTORY_ATTESTATION_REQUIRED");
  }
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  if (attestation.inventoryDigest !== inventoryDigest) {
    throw new Error("FLEET_MIGRATION_INVENTORY_DIGEST_MISMATCH");
  }
  const key = trustedPublicKey(trustedInventoryKeys, attestation.keyId);
  if (key === null) {
    throw new Error("FLEET_MIGRATION_INVENTORY_KEY_UNTRUSTED");
  }
  const signedAt = Date.parse(attestation.signedAt);
  if (
    !Number.isFinite(signedAt) ||
    signedAt < Date.parse(inventory.capturedAt)
  ) {
    throw new Error("FLEET_MIGRATION_INVENTORY_ATTESTATION_TIME_INVALID");
  }
  const payload = Buffer.from(
    canonicalJson(
      attestationPayloadObject(inventory, {
        keyId: attestation.keyId,
        policyRevision: attestation.policyRevision,
        signedAt: attestation.signedAt,
        inventoryDigest,
      }),
    ),
    "utf8",
  );
  let verified = false;
  try {
    verified = verifyEd25519(
      null,
      payload,
      key,
      Buffer.from(attestation.value, "base64url"),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new Error("FLEET_MIGRATION_INVENTORY_SIGNATURE_INVALID");
  }
  const binding = deepFreeze({
    inventoryId: inventory.inventoryId,
    inventoryDigest,
    keyId: attestation.keyId,
    policyRevision: attestation.policyRevision,
    signedAt: attestation.signedAt,
  });
  INVENTORY_BINDINGS.add(binding);
  return binding;
}

function bindingMatches(binding, inventory) {
  if (!INVENTORY_BINDINGS.has(binding)) return false;
  const attestation = inventory.attestation;
  return (
    attestation !== null &&
    binding.inventoryId === inventory.inventoryId &&
    binding.inventoryDigest === computeFleetMigrationInventoryDigest(inventory) &&
    binding.keyId === attestation.keyId &&
    binding.policyRevision === attestation.policyRevision &&
    binding.signedAt === attestation.signedAt
  );
}

function categoryForDetection(detection) {
  if (detection.type === "UNCLASSIFIED") return "UNCLASSIFIED";
  if (detection.type === "LEGACY_OPERATION_JSON") {
    return "LEGACY_OPERATION_JSON";
  }
  if (detection.type === "WORKFLOW_SECRETS_INHERIT") {
    return "WORKFLOW_SECRETS_INHERIT";
  }
  return SHA_PATTERN.test(detection.ref)
    ? "UNCLASSIFIED"
    : "WORKFLOW_FLOATING_REF";
}

function legacyDetectionReasons(candidate, repository) {
  const { detection, path } = candidate;
  const contract = LEGACY_CONTRACTS[detection.contract];
  const reasons = [];
  if (contract.schemaId !== detection.schemaId) {
    reasons.push("DETECTION_SCHEMA_MISMATCH");
  }
  let pathMatches = contract.path === path;
  if (detection.contract === "PLATFORM_REGISTRY_APP") {
    pathMatches =
      repository.fullName === "seorilabs/platform" &&
      candidate.replacement?.type === "SIGNED_RESOLVED_MANIFEST" &&
      path === `registry/apps/${candidate.replacement.appId}.json`;
  }
  if (!pathMatches) reasons.push("DETECTION_PATH_MISMATCH");
  return reasons;
}

function classifyCandidate(candidate, repository) {
  const category = categoryForDetection(candidate.detection);
  const reasons = [];
  if (!isCanonicalSafeRelativePath(candidate.path)) {
    reasons.push("UNSAFE_RELATIVE_PATH");
  }
  if (category === "UNCLASSIFIED") {
    reasons.push("UNCLASSIFIED_CANDIDATE");
  } else if (category === "LEGACY_OPERATION_JSON") {
    reasons.push(...legacyDetectionReasons(candidate, repository));
  } else if (!WORKFLOW_PATH_PATTERN.test(candidate.path)) {
    reasons.push("DETECTION_PATH_MISMATCH");
  }
  return { category, reasons };
}

export function computeFleetMigrationReplacementDigest(replacement) {
  if (replacement === null) return null;
  if (replacement.type === "SIGNED_RESOLVED_MANIFEST") {
    return sha256(
      canonicalJson({
        contract: "seorilabs-signed-resolved-manifest-binding-v1",
        appId: replacement.appId,
        configRevisionId: replacement.configRevisionId,
        configRevisionDigest: replacement.configRevisionDigest,
        signedSnapshotDigest: replacement.signedSnapshotDigest,
        signatureKeyId: replacement.signatureKeyId,
        policyRevision: replacement.policyRevision,
      }),
    );
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

function evidenceObjects(proofs) {
  return [
    proofs.activeConfigReadback,
    proofs.marketProfileReadback,
    proofs.workflowBundleReadback,
    proofs.sourceReadback,
    ...proofs.parityStream.observations,
    ...proofs.buildOnly,
    proofs.rollback.gitRestore,
    proofs.rollback.backofficeOutageRecovery,
    proofs.rollback.ownerGate,
    proofs.controlPlaneReadback,
  ].filter((value) => value !== null);
}

function evidenceReasons(proofs) {
  return evidenceObjects(proofs).every(
    (evidence) =>
      evidence.evidenceDigest === computeFleetEvidenceDigest(evidence),
  )
    ? []
    : ["EVIDENCE_DIGEST_MISMATCH"];
}

function activeConfigReasons(candidate, repository) {
  const readback = candidate.proofs.activeConfigReadback;
  if (readback === null) return ["ACTIVE_CONFIG_READBACK_MISSING"];
  let matches =
    readback.repositoryId === repository.id &&
    readback.sourceSha === repository.sourceSha;
  if (candidate.replacement?.type === "SIGNED_RESOLVED_MANIFEST") {
    const replacement = candidate.replacement;
    matches &&=
      readback.appId === replacement.appId &&
      readback.configRevisionId === replacement.configRevisionId &&
      readback.configRevisionDigest === replacement.configRevisionDigest &&
      readback.signedSnapshotDigest === replacement.signedSnapshotDigest &&
      readback.signatureKeyId === replacement.signatureKeyId &&
      readback.policyRevision === replacement.policyRevision;
  }
  return matches ? [] : ["ACTIVE_CONFIG_READBACK_MISMATCH"];
}

function requiredBuildTargets(candidate) {
  const marketTargets =
    candidate.proofs.marketProfileReadback?.marketBuildTargets ?? [];
  return ["ORG_CONTRACT_STATIC", ...marketTargets].sort(compareBuildTargets);
}

function marketProfileReasons(candidate, repository) {
  const market = candidate.proofs.marketProfileReadback;
  const active = candidate.proofs.activeConfigReadback;
  if (market === null) return ["MARKET_PROFILE_READBACK_MISSING"];
  const matches =
    active !== null &&
    market.appId === active.appId &&
    market.repositoryId === repository.id &&
    market.sourceSha === repository.sourceSha &&
    market.configRevisionId === active.configRevisionId &&
    canonicalJson(market.marketBuildTargets) ===
      canonicalJson(
        [...market.marketBuildTargets].sort(compareBuildTargets),
      );
  return matches ? [] : ["MARKET_PROFILE_READBACK_MISMATCH"];
}

function workflowBundleReasons(candidate, repository, targets) {
  const bundle = candidate.proofs.workflowBundleReadback;
  const active = candidate.proofs.activeConfigReadback;
  if (bundle === null) return ["WORKFLOW_BUNDLE_READBACK_MISSING"];
  const bindingTargets = bundle.bindings.map(({ target }) => target);
  const uniqueBindingTargets = new Set(bindingTargets);
  let matches =
    active !== null &&
    bundle.appId === active.appId &&
    bundle.repositoryId === repository.id &&
    bundle.sourceSha === repository.sourceSha &&
    uniqueBindingTargets.size === bindingTargets.length &&
    canonicalJson(bindingTargets) === canonicalJson(targets);
  if (
    candidate.replacement?.type === "EXPLICIT_SECRET_MAPPING" ||
    candidate.replacement?.type === "PINNED_WORKFLOW_CALLER"
  ) {
    matches &&=
      bundle.workflowBundleSha === candidate.replacement.workflowBundleSha;
  }
  return matches ? [] : ["WORKFLOW_BUNDLE_READBACK_MISMATCH"];
}

function sourceReadbackReasons(
  candidate,
  repository,
  capturedAt,
  discoveryObservedAt,
) {
  const readback = candidate.proofs.sourceReadback;
  if (readback === null) return ["SOURCE_READBACK_MISSING"];
  const evidenceTimes = evidenceObjects(candidate.proofs)
    .filter((evidence) => evidence !== readback)
    .map(
      (evidence) =>
        evidence.observedAt ??
        evidence.completedAt ??
        evidence.verifiedAt ??
        evidence.approvedAt,
    )
    .filter((value) => value !== undefined)
    .map(Date.parse);
  const readbackAt = Date.parse(readback.observedAt);
  const latestEvidenceAt = Math.max(Number.NEGATIVE_INFINITY, ...evidenceTimes);
  const matches =
    readback.repositoryId === repository.id &&
    readback.sourceRef === repository.defaultRef &&
    readback.sourceSha === repository.sourceSha &&
    readback.path === candidate.path &&
    canonicalJson(readback.gitEntry) === canonicalJson(candidate.gitEntry) &&
    readback.contentDigest === candidate.contentDigest &&
    Number.isFinite(readbackAt) &&
    evidenceTimes.every(Number.isFinite) &&
    readbackAt >= Date.parse(discoveryObservedAt) &&
    readbackAt >= latestEvidenceAt &&
    readbackAt <= Date.parse(capturedAt);
  return matches ? [] : ["SOURCE_READBACK_MISMATCH"];
}

function parityReasons(candidate, repository, replacementDigest) {
  const observations = candidate.proofs.parityStream.observations;
  if (observations.length < 2) {
    return ["PARITY_REQUIRES_LATEST_CONTIGUOUS_MATCHES"];
  }
  let streamMatches = true;
  const ids = new Set();
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    const previous = observations[index - 1];
    streamMatches &&=
      observation.sequence === index + 1 &&
      observation.previousObservationId ===
        (index === 0 ? null : previous.observationId) &&
      !ids.has(observation.observationId) &&
      (index === 0 ||
        Date.parse(observation.observedAt) > Date.parse(previous.observedAt));
    ids.add(observation.observationId);
  }
  const latest = observations.slice(-2);
  const latestMatches = latest.every(
    (observation) =>
      observation.state === "MATCH" &&
      observation.sourceSha === repository.sourceSha &&
      observation.currentContentDigest === candidate.contentDigest &&
      observation.replacementDigest === replacementDigest,
  );
  if (!streamMatches) return ["PARITY_STREAM_MISMATCH"];
  return latestMatches
    ? []
    : ["PARITY_REQUIRES_LATEST_CONTIGUOUS_MATCHES"];
}

function buildOnlyReasons(candidate, repository, targets) {
  const builds = candidate.proofs.buildOnly;
  if (builds.length === 0) return ["BUILD_ONLY_MISSING"];
  const bundle = candidate.proofs.workflowBundleReadback;
  if (bundle === null) return ["BUILD_ONLY_MISMATCH"];
  const bindingByTarget = new Map(
    bundle.bindings.map((binding) => [binding.target, binding]),
  );
  const buildTargets = builds.map(({ target }) => target);
  const uniqueTargets = new Set(buildTargets);
  const matches =
    uniqueTargets.size === buildTargets.length &&
    canonicalJson(buildTargets) === canonicalJson(targets) &&
    builds.every((build) => {
      const binding = bindingByTarget.get(build.target);
      return (
        binding !== undefined &&
        build.runRepositoryId === repository.id &&
        build.sourceSha === repository.sourceSha &&
        build.workflowBundleSha === bundle.workflowBundleSha &&
        build.workflowRef === binding.workflowRef &&
        build.builderDigest === binding.builderDigest
      );
    });
  return matches ? [] : ["BUILD_ONLY_MISMATCH"];
}

export function computeFleetMigrationOutageRecoveryDigest({
  appId,
  repositoryId,
  sourceSha,
  configRevisionId,
  configRevisionDigest,
  signedSnapshotDigest,
  signatureKeyId,
  policyRevision,
}) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-backoffice-outage-recovery-v1",
      appId,
      repositoryId,
      sourceSha,
      configRevisionId,
      configRevisionDigest,
      signedSnapshotDigest,
      signatureKeyId,
      policyRevision,
    }),
  );
}

export function computeFleetMigrationOwnerScopeDigest({
  repositoryId,
  sourceSha,
  path,
  operation,
  replacementDigest,
  appId,
  configRevisionId,
  configRevisionDigest,
  signedSnapshotDigest,
  signatureKeyId,
  policyRevision,
  ownerId,
}) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-cleanup-owner-gate-v1",
      repositoryId,
      sourceSha,
      path,
      operation,
      replacementDigest,
      appId,
      configRevisionId,
      configRevisionDigest,
      signedSnapshotDigest,
      signatureKeyId,
      policyRevision,
      ownerId,
    }),
  );
}

function ownerScopeDigest(candidate, repository, replacementDigest) {
  const active = candidate.proofs.activeConfigReadback;
  return computeFleetMigrationOwnerScopeDigest({
    repositoryId: repository.id,
    sourceSha: repository.sourceSha,
    path: candidate.path,
    operation: operationForCategories([
      categoryForDetection(candidate.detection),
    ]),
    replacementDigest,
    appId: active?.appId ?? null,
    configRevisionId: active?.configRevisionId ?? null,
    configRevisionDigest: active?.configRevisionDigest ?? null,
    signedSnapshotDigest: active?.signedSnapshotDigest ?? null,
    signatureKeyId: active?.signatureKeyId ?? null,
    policyRevision: active?.policyRevision ?? null,
    ownerId: active?.ownerId ?? null,
  });
}

function rollbackReasons(candidate, repository, replacementDigest) {
  const { gitRestore, backofficeOutageRecovery, ownerGate } =
    candidate.proofs.rollback;
  const active = candidate.proofs.activeConfigReadback;
  const reasons = [];
  if (gitRestore === null) {
    reasons.push("GIT_ROLLBACK_MISSING");
  } else if (
    gitRestore.sourceSha !== repository.sourceSha ||
    gitRestore.path !== candidate.path ||
    canonicalJson(gitRestore.originalGitEntry) !==
      canonicalJson(candidate.gitEntry) ||
    gitRestore.originalContentDigest !== candidate.contentDigest
  ) {
    reasons.push("GIT_ROLLBACK_MISMATCH");
  }
  if (backofficeOutageRecovery === null) {
    reasons.push("OUTAGE_RECOVERY_MISSING");
  } else if (
    active === null ||
    backofficeOutageRecovery.appId !== active.appId ||
    backofficeOutageRecovery.repositoryId !== repository.id ||
    backofficeOutageRecovery.sourceSha !== repository.sourceSha ||
    backofficeOutageRecovery.configRevisionId !== active.configRevisionId ||
    backofficeOutageRecovery.configRevisionDigest !==
      active.configRevisionDigest ||
    backofficeOutageRecovery.signedSnapshotDigest !==
      active.signedSnapshotDigest ||
    backofficeOutageRecovery.signatureKeyId !== active.signatureKeyId ||
    backofficeOutageRecovery.policyRevision !== active.policyRevision ||
    backofficeOutageRecovery.releaseReproductionDigest !==
      computeFleetMigrationOutageRecoveryDigest({
        appId: active.appId,
        repositoryId: repository.id,
        sourceSha: repository.sourceSha,
        configRevisionId: active.configRevisionId,
        configRevisionDigest: active.configRevisionDigest,
        signedSnapshotDigest: active.signedSnapshotDigest,
        signatureKeyId: active.signatureKeyId,
        policyRevision: active.policyRevision,
      })
  ) {
    reasons.push("OUTAGE_RECOVERY_MISMATCH");
  }
  if (ownerGate === null) {
    reasons.push("OWNER_GATE_MISSING");
  } else if (
    active === null ||
    ownerGate.ownerId !== active.ownerId ||
    ownerGate.scopeDigest !==
      ownerScopeDigest(candidate, repository, replacementDigest)
  ) {
    reasons.push("OWNER_GATE_MISMATCH");
  }
  return reasons;
}

function controlPlaneReasons(candidate, repository, replacementDigest) {
  const readback = candidate.proofs.controlPlaneReadback;
  const active = candidate.proofs.activeConfigReadback;
  if (readback === null) return ["CONTROL_PLANE_READBACK_MISSING"];
  const matches =
    active !== null &&
    readback.repositoryId === repository.id &&
    readback.appId === active.appId &&
    readback.sourceSha === repository.sourceSha &&
    readback.configRevisionId === active.configRevisionId &&
    readback.configRevisionDigest === active.configRevisionDigest &&
    readback.signedSnapshotDigest === active.signedSnapshotDigest &&
    readback.signatureKeyId === active.signatureKeyId &&
    readback.policyRevision === active.policyRevision &&
    readback.ownerId === active.ownerId &&
    readback.replacementDigest === replacementDigest;
  return matches ? [] : ["CONTROL_PLANE_READBACK_MISMATCH"];
}

function proofReasons(
  candidate,
  repository,
  replacementDigest,
  capturedAt,
  discoveryObservedAt,
) {
  if (replacementDigest === null) return [];
  const targets = requiredBuildTargets(candidate);
  return [
    ...evidenceReasons(candidate.proofs),
    ...activeConfigReasons(candidate, repository),
    ...marketProfileReasons(candidate, repository),
    ...workflowBundleReasons(candidate, repository, targets),
    ...sourceReadbackReasons(
      candidate,
      repository,
      capturedAt,
      discoveryObservedAt,
    ),
    ...parityReasons(candidate, repository, replacementDigest),
    ...buildOnlyReasons(candidate, repository, targets),
    ...rollbackReasons(candidate, repository, replacementDigest),
    ...controlPlaneReasons(candidate, repository, replacementDigest),
  ];
}

function observationReasons(repositoryObservation) {
  const { candidates, observation, repository } = repositoryObservation;
  const reasons = [];
  if (
    observation.repositoryId !== repository.id ||
    observation.sourceRef !== repository.defaultRef ||
    observation.sourceSha !== repository.sourceSha
  ) {
    reasons.push("OBSERVATION_SOURCE_MISMATCH");
  }
  if (
    observation.findingsDigest !==
    computeFleetFindingsDigest({
      repositoryId: repository.id,
      sourceRef: repository.defaultRef,
      sourceSha: repository.sourceSha,
      treeSha: observation.treeSha,
      candidates,
    })
  ) {
    reasons.push("OBSERVATION_FINDINGS_DIGEST_MISMATCH");
  }
  return reasons;
}

function findingCounts(candidates, repository) {
  const counts = {
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
    unclassified: 0,
  };
  for (const candidate of candidates) {
    const { category } = classifyCandidate(candidate, repository);
    counts[CATEGORY_TO_COUNT_KEY[category]] += 1;
  }
  return counts;
}

function categoriesForFindingCounts(counts) {
  return CATEGORY_ORDER.filter(
    (category) => counts[CATEGORY_TO_COUNT_KEY[category]] > 0,
  );
}

function migrationId(repositoryId, categories, path) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-migration-v1",
      repositoryId,
      categories,
      path,
    }),
  );
}

function operationIdempotencyKey({ inventory, repository, change }) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-migration-v1",
      inventoryId: inventory.inventoryId,
      inventoryDigest: inventory.binding.inventoryDigest,
      bindingKeyId: inventory.binding.keyId,
      bindingPolicyRevision: inventory.binding.policyRevision,
      repositoriesDigest: inventory.repositoriesDigest,
      detectorSourceSha: inventory.detectorSourceSha,
      repositoryId: repository.repositoryId,
      sourceRef: repository.sourceRef,
      sourceSha: repository.sourceSha,
      migrationId: change.migrationId,
      categories: change.categories,
      findingCounts: change.findingCounts,
      operation: change.operation,
      path: change.path,
      gitEntry: change.gitEntry,
      contentDigest: change.contentDigest,
      requiredBuildTargets: change.requiredBuildTargets,
      replacementDigest: change.replacementDigest,
      proofDigest: change.proofDigest,
    }),
  );
}

function pathCollisionReasons(groups) {
  const reasonsByPath = new Map([...groups.keys()].map((path) => [path, []]));
  const canonicalPaths = new Map();
  for (const path of groups.keys()) {
    const collisionKey = path.toLowerCase();
    const existing = canonicalPaths.get(collisionKey);
    if (existing !== undefined && existing !== path) {
      reasonsByPath.get(existing).push("PATH_CANONICAL_COLLISION");
      reasonsByPath.get(path).push("PATH_CANONICAL_COLLISION");
    } else {
      canonicalPaths.set(collisionKey, path);
    }
  }
  for (const [path, candidates] of groups) {
    const sourceIdentities = new Set(
      candidates.map((candidate) =>
        canonicalJson({
          gitEntry: candidate.gitEntry,
          contentDigest: candidate.contentDigest,
        }),
      ),
    );
    if (sourceIdentities.size !== 1) {
      reasonsByPath.get(path).push("PATH_SOURCE_COLLISION");
    }
    const replacementDigests = new Set(
      candidates.map((candidate) =>
        computeFleetMigrationReplacementDigest(candidate.replacement),
      ),
    );
    if (replacementDigests.size !== 1) {
      reasonsByPath.get(path).push("PATH_REPLACEMENT_COLLISION");
    }
    const proofDigests = new Set(
      candidates.map((candidate) => sha256(canonicalJson(candidate.proofs))),
    );
    if (proofDigests.size !== 1) {
      reasonsByPath.get(path).push("PATH_PROOF_COLLISION");
    }
  }
  return reasonsByPath;
}

function planRepository(
  repositoryObservation,
  inventorySummary,
  globalReasons,
) {
  const { repository, observation } = repositoryObservation;
  const candidates = repositoryObservation.candidates.map(normalizeCandidate);
  const groups = new Map();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.path) ?? [];
    existing.push(candidate);
    groups.set(candidate.path, existing);
  }
  const collisionReasons = pathCollisionReasons(groups);
  const repositoryReasons = [
    ...globalReasons,
    ...observationReasons(repositoryObservation),
  ];
  const repositoryContext = {
    repositoryId: repository.id,
    fullName: repository.fullName,
    sourceRef: repository.defaultRef,
    sourceSha: repository.sourceSha,
  };
  const changes = [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, pathCandidates]) => {
      const perCandidate = pathCandidates.map((candidate) => {
        const classification = classifyCandidate(candidate, repository);
        const replacementDigest = computeFleetMigrationReplacementDigest(
          candidate.replacement,
        );
        return {
          candidate,
          category: classification.category,
          replacementDigest,
          targets: requiredBuildTargets(candidate),
          reasons: [
            ...classification.reasons,
            ...(candidate.detection.detectorSha ===
            inventorySummary.detectorSourceSha
              ? []
              : ["DETECTOR_SOURCE_MISMATCH"]),
            ...replacementReasons(
              classification.category,
              candidate.detection,
              candidate.replacement,
            ),
            ...proofReasons(
              candidate,
              repository,
              replacementDigest,
              inventorySummary.capturedAt,
              observation.observedAt,
            ),
          ],
        };
      });
      const counts = findingCounts(pathCandidates, repository);
      const categories = categoriesForFindingCounts(counts);
      if (categories.some((category) => counts[CATEGORY_TO_COUNT_KEY[category]] > 1)) {
        for (const item of perCandidate) {
          item.reasons.push("CANDIDATE_DUPLICATE");
        }
      }
      const operation = operationForCategories(categories);
      const replacementDigests = new Set(
        perCandidate.map(({ replacementDigest }) => replacementDigest),
      );
      const targetSets = new Set(
        perCandidate.map(({ targets }) => canonicalJson(targets)),
      );
      const proofDigests = new Set(
        perCandidate.map(({ candidate }) =>
          sha256(canonicalJson(candidate.proofs)),
        ),
      );
      const reasons = sortedUnique([
        ...repositoryReasons,
        ...(collisionReasons.get(path) ?? []),
        ...(operation === "NONE" && !categories.includes("UNCLASSIFIED")
          ? ["PATH_REPLACEMENT_COLLISION"]
          : []),
        ...(targetSets.size === 1 ? [] : ["PATH_PROOF_COLLISION"]),
        ...perCandidate.flatMap(({ reasons: itemReasons }) => itemReasons),
      ]);
      const first = perCandidate[0];
      const baseChange = {
        migrationId: migrationId(repository.id, categories, path),
        categories,
        findingCounts: counts,
        operation,
        path,
        gitEntry: structuredClone(first.candidate.gitEntry),
        contentDigest: first.candidate.contentDigest,
        requiredBuildTargets:
          targetSets.size === 1 ? first.targets : ["ORG_CONTRACT_STATIC"],
        replacementDigest:
          replacementDigests.size === 1
            ? first.replacementDigest
            : null,
        proofDigest:
          proofDigests.size === 1
            ? [...proofDigests][0]
            : sha256(canonicalJson([...proofDigests].sort())),
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

function bindingSummary(inventory, binding) {
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  if (bindingMatches(binding, inventory)) {
    return {
      state: "VERIFIED",
      keyId: binding.keyId,
      policyRevision: binding.policyRevision,
      signedAt: binding.signedAt,
      inventoryDigest,
    };
  }
  return {
    state: "MISSING",
    keyId: null,
    policyRevision: null,
    signedAt: null,
    inventoryDigest,
  };
}

function withoutPlanDigest(plan) {
  const { planDigest: _planDigest, ...unsigned } = plan;
  return unsigned;
}

function buildFleetMigrationPlan(inventory, trustedInventoryBinding) {
  const normalizedRepositories = [...inventory.repositories].sort(
    (left, right) =>
      compareNumericIds(left.repository.id, right.repository.id) ||
      left.repository.fullName.localeCompare(right.repository.fullName),
  );
  const counts = observedCounts(normalizedRepositories);
  const reasons = inventoryAuthorityReasons(inventory, counts);
  if (trustedInventoryBinding === undefined) {
    reasons.push("TRUSTED_INVENTORY_BINDING_MISSING");
  } else if (!bindingMatches(trustedInventoryBinding, inventory)) {
    reasons.push("TRUSTED_INVENTORY_BINDING_MISMATCH");
  }
  const inventorySummary = {
    inventoryId: inventory.inventoryId,
    capturedAt: inventory.capturedAt,
    organizationId: inventory.organization.id,
    detectorSourceSha: inventory.detector.sourceSha,
    coverageReadbackId: inventory.coverage.readbackId,
    repositoriesDigest: inventory.coverage.repositoriesDigest,
    expectedCounts: structuredClone(inventory.expectedCounts),
    observedCounts: counts,
    binding: bindingSummary(inventory, trustedInventoryBinding),
  };
  const repositories = normalizedRepositories.map((repository) =>
    planRepository(repository, inventorySummary, sortedUnique(reasons)),
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
  return {
    ...unsigned,
    planDigest: sha256(canonicalJson(unsigned)),
  };
}

function semanticPlanDiagnostics(plan) {
  const diagnostics = [];
  if (plan.planDigest !== sha256(canonicalJson(withoutPlanDigest(plan)))) {
    diagnostics.push("PLAN_DIGEST_MISMATCH");
  }
  const rootReasons = sortedUnique(
    plan.repositories.flatMap(({ reasonCodes }) => reasonCodes),
  );
  if (canonicalJson(plan.reasonCodes) !== canonicalJson(rootReasons)) {
    diagnostics.push("PLAN_REASON_SUMMARY_MISMATCH");
  }
  if (plan.outcome !== outcomeForReasons(plan.reasonCodes)) {
    diagnostics.push("PLAN_OUTCOME_MISMATCH");
  }
  if (
    plan.outcome === "READY_FOR_REVIEW" &&
    plan.inventory.binding.state !== "VERIFIED"
  ) {
    diagnostics.push("PLAN_TRUSTED_BINDING_REQUIRED");
  }
  const sortedRepositories = [...plan.repositories].sort(
    (left, right) =>
      compareNumericIds(left.repositoryId, right.repositoryId) ||
      left.fullName.localeCompare(right.fullName),
  );
  if (canonicalJson(plan.repositories) !== canonicalJson(sortedRepositories)) {
    diagnostics.push("PLAN_REPOSITORY_ORDER_INVALID");
  }
  const counts = {
    activeRepositories: plan.repositories.length,
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
    unclassified: 0,
  };
  for (const repository of plan.repositories) {
    const repositoryReasons = sortedUnique(
      repository.changes.flatMap(({ reasonCodes }) => reasonCodes),
    );
    if (
      repository.changes.length > 0 &&
      canonicalJson(repository.reasonCodes) !== canonicalJson(repositoryReasons)
    ) {
      diagnostics.push("PLAN_REPOSITORY_REASON_SUMMARY_MISMATCH");
    }
    if (repository.outcome !== outcomeForReasons(repository.reasonCodes)) {
      diagnostics.push("PLAN_REPOSITORY_OUTCOME_MISMATCH");
    }
    const sortedChanges = [...repository.changes].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    if (canonicalJson(repository.changes) !== canonicalJson(sortedChanges)) {
      diagnostics.push("PLAN_CHANGE_ORDER_INVALID");
    }
    for (const change of repository.changes) {
      const expectedCategories = categoriesForFindingCounts(
        change.findingCounts,
      );
      if (
        canonicalJson(change.categories) !== canonicalJson(expectedCategories)
      ) {
        diagnostics.push("PLAN_FINDING_CATEGORY_MISMATCH");
      }
      for (const category of CATEGORY_ORDER) {
        counts[CATEGORY_TO_COUNT_KEY[category]] +=
          change.findingCounts[CATEGORY_TO_COUNT_KEY[category]];
      }
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
      if (change.operation !== operationForCategories(change.categories)) {
        diagnostics.push("PLAN_CHANGE_OPERATION_MISMATCH");
      }
      if (
        change.migrationId !==
        migrationId(
          repository.repositoryId,
          change.categories,
          change.path,
        )
      ) {
        diagnostics.push("PLAN_MIGRATION_ID_MISMATCH");
      }
      if (
        change.idempotencyKey !==
        operationIdempotencyKey({
          inventory: plan.inventory,
          repository,
          change,
        })
      ) {
        diagnostics.push("PLAN_IDEMPOTENCY_KEY_MISMATCH");
      }
    }
  }
  if (
    canonicalJson(plan.inventory.observedCounts) !== canonicalJson(counts)
  ) {
    diagnostics.push("PLAN_OBSERVED_COUNTS_MISMATCH");
  }
  return sortedUnique(diagnostics);
}

function structuralPlanValidation(plan) {
  const schemaOk = validatePlanSchema(plan);
  if (!schemaOk) return schemaDiagnostics(validatePlanSchema.errors);
  return semanticPlanDiagnostics(plan);
}

export function createFleetMigrationPlan(
  inventory,
  { trustedInventoryBinding } = {},
) {
  assertValidInventory(inventory);
  const plan = buildFleetMigrationPlan(inventory, trustedInventoryBinding);
  const diagnostics = structuralPlanValidation(plan);
  if (diagnostics.length > 0) {
    throw new Error(`FLEET_MIGRATION_PLAN_INVALID:${diagnostics.join(",")}`);
  }
  return deepFreeze(plan);
}

export function validateFleetMigrationPlan(
  plan,
  { inventory, trustedInventoryBinding } = {},
) {
  const diagnostics = structuralPlanValidation(plan);
  if (diagnostics.length > 0) {
    return deepFreeze({ ok: false, diagnostics });
  }
  if (plan.outcome === "READY_FOR_REVIEW") {
    if (
      inventory === undefined ||
      !bindingMatches(trustedInventoryBinding, inventory)
    ) {
      return deepFreeze({
        ok: false,
        diagnostics: ["PLAN_TRUSTED_INPUT_REQUIRED"],
      });
    }
    let expected;
    try {
      assertValidInventory(inventory);
      expected = buildFleetMigrationPlan(inventory, trustedInventoryBinding);
    } catch {
      return deepFreeze({
        ok: false,
        diagnostics: ["PLAN_TRUSTED_INPUT_INVALID"],
      });
    }
    if (canonicalJson(expected) !== canonicalJson(plan)) {
      return deepFreeze({
        ok: false,
        diagnostics: ["PLAN_TRUSTED_INPUT_MISMATCH"],
      });
    }
  }
  return deepFreeze({ ok: true, diagnostics: [] });
}

export const fleetMigrationContract = deepFreeze({
  schemaVersion: 1,
  mode: "PLAN_ONLY",
  executionAllowed: false,
  initialBaseline: {
    observedDate: "2026-08-29",
    expectedCounts: INITIAL_BASELINE,
  },
  inventoryAttestation: {
    algorithm: "Ed25519",
    contract: "seorilabs-fleet-migration-inventory-attestation-v1",
    trustRootRequired: true,
  },
  inventorySchema: "fleet-migration-inventory.schema.json",
  planSchema: "fleet-migration-plan.schema.json",
  requiredProofs: [
    "complete-pagination-chain-and-total",
    "signed-exact-inventory-and-evidence",
    "canonical-blob-path-and-single-final-digest",
    "active-config-and-market-profile-readback",
    "latest-two-contiguous-parity-matches",
    "approved-workflow-bundle-build-only",
    "git-and-backoffice-outage-rollback",
    "owner-gate",
    "provider-observation-and-gate-ledger-readback",
  ],
  prohibitedOperations: [
    "repository-write",
    "pull-request-create",
    "file-delete",
    "workflow-rewrite",
    "output-file-write",
    "secret-read",
    "provider-mutation",
  ],
});
