import { createHash, verify as verifyEd25519 } from "node:crypto";
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
const validateChainHeadSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      resolve(CONTRACTS_ROOT, "fleet-migration-chain-head.schema.json"),
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
const HISTORICAL_INVENTORY_BINDINGS = new WeakSet();
const CHAIN_HEAD_BINDINGS = new WeakSet();
const INVENTORY_MAX_TTL_MS = 15 * 60 * 1000;
const INVENTORY_MAX_CLOCK_SKEW_MS = 60 * 1000;
const CHAIN_HEAD_MAX_TTL_MS = 5 * 60 * 1000;
const CHAIN_HEAD_AUTHORITY_ROLE = "FLEET_MIGRATION_CHAIN_HEAD_AUTHORITY";
const CHAIN_HEAD_RESERVATION_CONTRACT =
  "seorilabs-fleet-migration-chain-head-cas-reservation-v1";
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
  "INVENTORY_LINEAGE_REQUIRED",
  "INVENTORY_LINEAGE_MISMATCH",
  "INVENTORY_COUNTS_NOT_MONOTONIC",
  "CHAIN_HEAD_REQUIRED",
  "CHAIN_HEAD_MISMATCH",
  "INVENTORY_COVERAGE_INCOMPLETE",
  "INVENTORY_PAGINATION_CHAIN_MISMATCH",
  "INVENTORY_PROVIDER_TOTAL_MISMATCH",
  "ACTIVE_REPOSITORY_COUNT_MISMATCH",
  "CANDIDATE_COUNT_MISMATCH",
  "REPOSITORY_IDENTITY_DUPLICATE",
  "REPOSITORY_CLASSIFICATION_MISMATCH",
  "SUBJECT_BINDING_MISMATCH",
  "PLATFORM_FLEET_BINDING_MISSING",
  "PLATFORM_FLEET_BINDING_MISMATCH",
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
  ORG_CONTRACT_APP: Object.freeze({
    schemaId: "https://seorilabs.github.io/contracts/v1/app.schema.json",
    path: ".seorilabs/app.yaml",
  }),
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
        .sort(compareUtf8)
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

function decodeCanonicalEd25519Signature(value) {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 64 && decoded.toString("base64url") === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

function trustedNow(optionsNow) {
  const value = optionsNow ?? Date.now();
  const result = timestamp(value);
  if (!Number.isFinite(result)) {
    throw new Error("FLEET_MIGRATION_TRUSTED_TIME_INVALID");
  }
  return result;
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
  ].sort(compareUtf8);
}

function compareNumericIds(left, right) {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareBuildTargets(left, right) {
  return BUILD_TARGET_ORDER.indexOf(left) - BUILD_TARGET_ORDER.indexOf(right);
}

function compareCategories(left, right) {
  return CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right);
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareUtf8);
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
      ["WORKFLOW_SECRETS_INHERIT", "WORKFLOW_FLOATING_REF"].includes(category),
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
    normalized.candidateKinds.sort(compareUtf8);
  }
  return normalized;
}

function normalizeReplacement(replacement) {
  if (replacement === null) return null;
  const normalized = structuredClone(replacement);
  if (Array.isArray(normalized.namedCredentialBindings)) {
    normalized.namedCredentialBindings.sort(
      (left, right) =>
        compareUtf8(left.secretName, right.secretName) ||
        compareUtf8(left.logicalCredentialId, right.logicalCredentialId),
    );
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
  normalized.credentialBindings.sort(
    (left, right) =>
      compareUtf8(left.secretName, right.secretName) ||
      compareUtf8(left.logicalCredentialId, right.logicalCredentialId) ||
      compareUtf8(left.observationId, right.observationId),
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
    fork: repository.fork,
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
      compareUtf8(left.repository.fullName, right.repository.fullName),
  );
  for (const repository of unsigned.repositories) {
    repository.candidates = repository.candidates
      .map(normalizeCandidate)
      .sort(
        (left, right) =>
          compareUtf8(left.path, right.path) ||
          compareUtf8(left.detection.type, right.detection.type) ||
          compareUtf8(left.gitEntry.objectSha, right.gitEntry.objectSha),
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
        compareUtf8(left.fullName, right.fullName),
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
  treeReadback,
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
        compareUtf8(left.path, right.path) ||
        compareUtf8(left.detection.type, right.detection.type) ||
        compareUtf8(left.gitEntry.objectSha, right.gitEntry.objectSha),
    );
  return sha256(
    canonicalJson({
      repositoryId,
      sourceRef,
      sourceSha,
      treeSha,
      treeReadback: structuredClone(treeReadback),
      findings,
    }),
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

export function validateFleetMigrationChainHead(chainHead) {
  const ok = validateChainHeadSchema(chainHead);
  return deepFreeze({
    ok: Boolean(ok),
    diagnostics: ok ? [] : schemaDiagnostics(validateChainHeadSchema.errors),
  });
}

function assertValidChainHead(chainHead) {
  const validation = validateFleetMigrationChainHead(chainHead);
  if (!validation.ok) {
    throw new Error(
      `FLEET_MIGRATION_CHAIN_HEAD_INVALID:${validation.diagnostics.join(",")}`,
    );
  }
}

export function computeFleetMigrationChainHeadDigest(chainHead) {
  const { attestation: _attestation, ...unsigned } = structuredClone(chainHead);
  return sha256(canonicalJson(unsigned));
}

function chainHeadAttestationPayloadObject(
  chainHead,
  { keyId, policyRevision, signedAt, chainHeadDigest },
) {
  return {
    contract: "seorilabs-fleet-migration-chain-head-attestation-v1",
    algorithm: "Ed25519",
    role: CHAIN_HEAD_AUTHORITY_ROLE,
    keyId,
    policyRevision,
    signedAt,
    chainHeadDigest,
    authorityRevision: chainHead.authorityRevision,
    readbackId: chainHead.readbackId,
    observedAt: chainHead.observedAt,
    expiresAt: chainHead.expiresAt,
    organization: structuredClone(chainHead.organization),
    installationId: chainHead.installationId,
    head: structuredClone(chainHead.head),
    candidate: structuredClone(chainHead.candidate),
    reservation: structuredClone(chainHead.reservation),
  };
}

export function createFleetMigrationChainHeadAttestationPayload(
  chainHead,
  { keyId, policyRevision, signedAt },
) {
  assertValidChainHead(chainHead);
  const chainHeadDigest = computeFleetMigrationChainHeadDigest(chainHead);
  return Buffer.from(
    canonicalJson(
      chainHeadAttestationPayloadObject(chainHead, {
        keyId,
        policyRevision,
        signedAt,
        chainHeadDigest,
      }),
    ),
    "utf8",
  );
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

function lineageCommitment(lineage) {
  return {
    mode: lineage.mode,
    waveNumber: lineage.waveNumber,
    priorInventoryId: lineage.priorInventoryId,
    priorInventoryDigest: lineage.priorInventoryDigest,
    priorCapturedAt: lineage.priorCapturedAt,
    priorObservedCounts:
      lineage.priorObservedCounts === null
        ? null
        : structuredClone(lineage.priorObservedCounts),
    rootInventoryId: lineage.rootInventoryId,
    rootInventoryDigest: lineage.rootInventoryDigest,
    chainDigest: lineage.chainDigest,
  };
}

function attestationPayloadFields({
  keyId,
  policyRevision,
  signedAt,
  inventoryId,
  inventoryDigest,
  capturedAt,
  expiresAt,
  organizationId,
  organizationLogin,
  installationId,
  coverageProvider,
  coverageQuery,
  coverageObservedAt,
  coverageReadbackId,
  coverageSnapshotId,
  providerTotalCount,
  detectorSourceSha,
  repositoriesDigest,
  expectedCounts,
  lineage: committedLineage,
}) {
  return {
    contract: "seorilabs-fleet-migration-inventory-attestation-v2",
    algorithm: "Ed25519",
    keyId,
    policyRevision,
    signedAt,
    inventoryId,
    inventoryDigest,
    capturedAt,
    expiresAt,
    organizationId,
    organizationLogin,
    installationId,
    coverageProvider,
    coverageQuery: structuredClone(coverageQuery),
    coverageObservedAt,
    coverageReadbackId,
    coverageSnapshotId,
    providerTotalCount,
    detectorSourceSha,
    repositoriesDigest,
    expectedCounts: structuredClone(expectedCounts),
    lineage: structuredClone(committedLineage),
  };
}

function attestationPayloadObject(
  inventory,
  { keyId, policyRevision, signedAt, inventoryDigest },
) {
  return attestationPayloadFields({
    keyId,
    policyRevision,
    signedAt,
    inventoryId: inventory.inventoryId,
    inventoryDigest,
    capturedAt: inventory.capturedAt,
    expiresAt: inventory.expiresAt,
    organizationId: inventory.organization.id,
    organizationLogin: inventory.organization.login,
    installationId: inventory.coverage.installationId,
    coverageProvider: inventory.coverage.provider,
    coverageQuery: inventory.coverage.query,
    coverageObservedAt: inventory.coverage.observedAt,
    coverageReadbackId: inventory.coverage.readbackId,
    coverageSnapshotId: inventory.coverage.snapshotId,
    providerTotalCount: inventory.coverage.providerTotalCount,
    detectorSourceSha: inventory.detector.sourceSha,
    repositoriesDigest: inventory.coverage.repositoriesDigest,
    expectedCounts: inventory.expectedCounts,
    lineage: lineageCommitment(inventory.lineage),
  });
}

function checkpointAttestationPayloadObject(checkpoint) {
  return attestationPayloadFields({
    keyId: checkpoint.attestation.keyId,
    policyRevision: checkpoint.attestation.policyRevision,
    signedAt: checkpoint.attestation.signedAt,
    inventoryId: checkpoint.inventoryId,
    inventoryDigest: checkpoint.inventoryDigest,
    capturedAt: checkpoint.capturedAt,
    expiresAt: checkpoint.expiresAt,
    organizationId: checkpoint.organizationId,
    organizationLogin: checkpoint.organizationLogin,
    installationId: checkpoint.installationId,
    coverageProvider: checkpoint.coverageProvider,
    coverageQuery: checkpoint.coverageQuery,
    coverageObservedAt: checkpoint.coverageObservedAt,
    coverageReadbackId: checkpoint.coverageReadbackId,
    coverageSnapshotId: checkpoint.coverageSnapshotId,
    providerTotalCount: checkpoint.providerTotalCount,
    detectorSourceSha: checkpoint.detectorSourceSha,
    repositoriesDigest: checkpoint.repositoriesDigest,
    expectedCounts: checkpoint.expectedCounts,
    lineage: checkpoint.lineageCommitment,
  });
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

export function computeFleetMigrationLineageChainDigest(checkpoints) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-migration-lineage-chain-v1",
      checkpoints: structuredClone(checkpoints),
    }),
  );
}

export function deriveFleetMigrationInventoryCheckpoint(inventory) {
  assertValidInventory(inventory);
  const attestation = inventory.attestation;
  if (attestation === null) {
    throw new Error("FLEET_MIGRATION_INVENTORY_ATTESTATION_REQUIRED");
  }
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  if (attestation.inventoryDigest !== inventoryDigest) {
    throw new Error("FLEET_MIGRATION_INVENTORY_DIGEST_MISMATCH");
  }
  return deepFreeze({
    inventoryId: inventory.inventoryId,
    inventoryDigest,
    capturedAt: inventory.capturedAt,
    expiresAt: inventory.expiresAt,
    organizationId: inventory.organization.id,
    organizationLogin: inventory.organization.login,
    installationId: inventory.coverage.installationId,
    coverageProvider: inventory.coverage.provider,
    coverageQuery: structuredClone(inventory.coverage.query),
    coverageObservedAt: inventory.coverage.observedAt,
    coverageReadbackId: inventory.coverage.readbackId,
    coverageSnapshotId: inventory.coverage.snapshotId,
    providerTotalCount: inventory.coverage.providerTotalCount,
    detectorSourceSha: inventory.detector.sourceSha,
    repositoriesDigest: inventory.coverage.repositoriesDigest,
    expectedCounts: structuredClone(inventory.expectedCounts),
    lineageCommitment: lineageCommitment(inventory.lineage),
    attestation: structuredClone(attestation),
  });
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

function trustedKeyEntries(keys) {
  return keys instanceof Map ? [...keys.entries()] : Object.entries(keys ?? {});
}

function samePublicKey(left, right) {
  try {
    return (
      left.type === "public" &&
      right.type === "public" &&
      left.asymmetricKeyType === "ed25519" &&
      right.asymmetricKeyType === "ed25519" &&
      Buffer.compare(
        left.export({ format: "der", type: "spki" }),
        right.export({ format: "der", type: "spki" }),
      ) === 0
    );
  } catch {
    return false;
  }
}

function publicKeyFingerprint(key) {
  return sha256(key.export({ format: "der", type: "spki" }));
}

function chainHeadKeyConflictsWithInventoryKeys(binding, trustedInventoryKeys) {
  return trustedKeyEntries(trustedInventoryKeys).some(
    ([inventoryKeyId, inventoryKey]) =>
      inventoryKeyId === binding.keyId ||
      (() => {
        try {
          return publicKeyFingerprint(inventoryKey) === binding.keyFingerprint;
        } catch {
          return false;
        }
      })(),
  );
}

async function requireCurrentChainHeadReservation({
  chainHead,
  chainHeadDigest,
  trustedStateAuthorityReadback,
}) {
  if (typeof trustedStateAuthorityReadback !== "function") {
    throw new Error(
      "FLEET_MIGRATION_STATE_AUTHORITY_READBACK_REQUIRED",
    );
  }
  const request = deepFreeze({
    contract: CHAIN_HEAD_RESERVATION_CONTRACT,
    authorityRole: CHAIN_HEAD_AUTHORITY_ROLE,
    organizationId: chainHead.organization.id,
    installationId: chainHead.installationId,
    authorityRevision: chainHead.authorityRevision,
    reservationId: chainHead.reservation.reservationId,
    expectedGeneration: chainHead.reservation.expectedGeneration,
    reservedGeneration: chainHead.reservation.reservedGeneration,
    chainHeadDigest,
    head: structuredClone(chainHead.head),
    candidate: structuredClone(chainHead.candidate),
  });
  let readback;
  try {
    readback = await trustedStateAuthorityReadback(request);
  } catch {
    throw new Error("FLEET_MIGRATION_STATE_AUTHORITY_READBACK_FAILED");
  }
  try {
    assertValidChainHead(readback);
  } catch {
    throw new Error("FLEET_MIGRATION_STATE_AUTHORITY_READBACK_MISMATCH");
  }
  if (canonicalJson(readback) !== canonicalJson(chainHead)) {
    throw new Error("FLEET_MIGRATION_STATE_AUTHORITY_READBACK_MISMATCH");
  }
}

export async function loadTrustedFleetMigrationChainHeadBinding({
  chainHead,
  trustedChainHeadKeys,
  trustedInventoryKeys,
  trustedStateAuthorityReadback,
  now,
}) {
  chainHead = deepFreeze(structuredClone(chainHead));
  assertValidChainHead(chainHead);
  const nowMs = trustedNow(now);
  const attestation = chainHead.attestation;
  if (attestation === null) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_ATTESTATION_REQUIRED");
  }
  if (
    chainHead.authorityRole !== CHAIN_HEAD_AUTHORITY_ROLE ||
    attestation.role !== CHAIN_HEAD_AUTHORITY_ROLE
  ) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_ROLE_INVALID");
  }
  const key = trustedPublicKey(trustedChainHeadKeys, attestation.keyId);
  if (key === null) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_KEY_UNTRUSTED");
  }
  if (
    trustedKeyEntries(trustedInventoryKeys).some(
      ([inventoryKeyId, inventoryKey]) =>
        inventoryKeyId === attestation.keyId || samePublicKey(inventoryKey, key),
    )
  ) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_KEY_ROLE_CONFLICT");
  }
  const observedAt = Date.parse(chainHead.observedAt);
  const expiresAt = Date.parse(chainHead.expiresAt);
  const signedAt = Date.parse(attestation.signedAt);
  const inventorySignedAt = Date.parse(chainHead.head.inventorySignedAt);
  const candidateInventorySignedAt = Date.parse(
    chainHead.candidate.inventorySignedAt,
  );
  const reservedAt = Date.parse(chainHead.reservation.reservedAt);
  const expectedGeneration = BigInt(
    chainHead.reservation.expectedGeneration,
  );
  const reservedGeneration = BigInt(
    chainHead.reservation.reservedGeneration,
  );
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(signedAt) ||
    !Number.isFinite(inventorySignedAt) ||
    !Number.isFinite(candidateInventorySignedAt) ||
    !Number.isFinite(reservedAt) ||
    observedAt < inventorySignedAt ||
    observedAt < candidateInventorySignedAt ||
    reservedAt < candidateInventorySignedAt ||
    reservedAt > observedAt ||
    expiresAt <= observedAt ||
    expiresAt - observedAt > CHAIN_HEAD_MAX_TTL_MS ||
    signedAt < observedAt ||
    signedAt > expiresAt ||
    signedAt > nowMs + INVENTORY_MAX_CLOCK_SKEW_MS ||
    expiresAt <= nowMs ||
    (chainHead.head.waveNumber === 0) !==
      (chainHead.head.chainDigest === null) ||
    chainHead.candidate.waveNumber !== chainHead.head.waveNumber + 1 ||
    chainHead.reservation.contract !== CHAIN_HEAD_RESERVATION_CONTRACT ||
    chainHead.reservation.state !== "RESERVED" ||
    chainHead.reservation.expectedGeneration !==
      chainHead.head.stateGeneration ||
    reservedGeneration !== expectedGeneration + 1n ||
    (chainHead.head.waveNumber === 0 &&
      (chainHead.head.rootInventoryId !== chainHead.head.inventoryId ||
        chainHead.head.rootInventoryDigest !==
          chainHead.head.inventoryDigest))
  ) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_STATE_INVALID");
  }
  const chainHeadDigest = computeFleetMigrationChainHeadDigest(chainHead);
  if (attestation.chainHeadDigest !== chainHeadDigest) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_DIGEST_MISMATCH");
  }
  let verified = false;
  try {
    const signature = decodeCanonicalEd25519Signature(attestation.value);
    verified =
      signature !== null &&
      verifyEd25519(
        null,
        Buffer.from(
          canonicalJson(
            chainHeadAttestationPayloadObject(chainHead, {
              keyId: attestation.keyId,
              policyRevision: attestation.policyRevision,
              signedAt: attestation.signedAt,
              chainHeadDigest,
            }),
          ),
          "utf8",
        ),
        key,
        signature,
      );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_SIGNATURE_INVALID");
  }
  await requireCurrentChainHeadReservation({
    chainHead,
    chainHeadDigest,
    trustedStateAuthorityReadback,
  });
  const binding = deepFreeze({
    chainHeadDigest,
    keyId: attestation.keyId,
    keyFingerprint: publicKeyFingerprint(key),
    policyRevision: attestation.policyRevision,
    signedAt: attestation.signedAt,
    authorityRevision: chainHead.authorityRevision,
    readbackId: chainHead.readbackId,
    observedAt: chainHead.observedAt,
    expiresAt: chainHead.expiresAt,
    organizationId: chainHead.organization.id,
    installationId: chainHead.installationId,
    stateGeneration: chainHead.head.stateGeneration,
    waveNumber: chainHead.head.waveNumber,
    inventoryId: chainHead.head.inventoryId,
    inventoryDigest: chainHead.head.inventoryDigest,
    chainDigest: chainHead.head.chainDigest,
    rootInventoryId: chainHead.head.rootInventoryId,
    rootInventoryDigest: chainHead.head.rootInventoryDigest,
    observedCounts: structuredClone(chainHead.head.observedCounts),
    inventoryKeyId: chainHead.head.inventoryKeyId,
    inventoryPolicyRevision: chainHead.head.inventoryPolicyRevision,
    inventorySignedAt: chainHead.head.inventorySignedAt,
    candidateWaveNumber: chainHead.candidate.waveNumber,
    candidateInventoryId: chainHead.candidate.inventoryId,
    candidateInventoryDigest: chainHead.candidate.inventoryDigest,
    candidateInventorySignedAt: chainHead.candidate.inventorySignedAt,
    reservationId: chainHead.reservation.reservationId,
    reservationExpectedGeneration:
      chainHead.reservation.expectedGeneration,
    reservationReservedGeneration:
      chainHead.reservation.reservedGeneration,
    reservationReservedAt: chainHead.reservation.reservedAt,
  });
  CHAIN_HEAD_BINDINGS.add(binding);
  return binding;
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

function classificationDecisionMatches(value) {
  return (
    value.classificationDecisionRevision > 0 &&
    value.classificationDecisionId !== null
  );
}

function repositoryClassificationReasons(repositories) {
  const reasons = [];
  for (const { repository, candidates } of repositories) {
    if (
      !classificationDecisionMatches(repository) ||
      (repository.fork && repository.classification !== "EXCLUDED") ||
      (repository.classification === "EXCLUDED" && candidates.length > 0)
    ) {
      reasons.push("REPOSITORY_CLASSIFICATION_MISMATCH");
    }
  }
  return reasons;
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
      page.providerTotalCount === coverage.providerTotalCount &&
      page.hasNextPage === (page.responseNextCursor !== null) &&
      page.repositoryIds.length <= coverage.query.pageSize &&
      (!page.hasNextPage ||
        page.repositoryIds.length === coverage.query.pageSize) &&
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
  chainMatches &&=
    coverage.providerTotalCount === pageRepositoryIds.length &&
    coverage.activeRepositoryCount === coverage.providerTotalCount;
  const exactRepositoryIds = inventory.repositories
    .map(({ repository }) => repository.id)
    .sort(compareNumericIds);
  chainMatches &&=
    canonicalJson([...pageRepositoryIds].sort(compareNumericIds)) ===
    canonicalJson(exactRepositoryIds);
  if (!chainMatches) reasons.push("INVENTORY_PAGINATION_CHAIN_MISMATCH");
  if (coverage.providerTotalCount !== inventory.repositories.length) {
    reasons.push("INVENTORY_PROVIDER_TOTAL_MISMATCH");
  }
  return reasons;
}

function inventoryAuthorityReasons(
  inventory,
  counts,
  now,
  { requireFresh = true } = {},
) {
  const reasons = [
    ...paginationReasons(inventory),
    ...repositoryClassificationReasons(inventory.repositories),
  ];
  if (
    inventory.lineage.mode === "BOOTSTRAP" &&
    (canonicalJson(inventory.expectedCounts) !==
      canonicalJson(INITIAL_BASELINE) ||
      counts.activeRepositories !== INITIAL_BASELINE.activeRepositories ||
      counts.legacyOperationJson !== INITIAL_BASELINE.legacyOperationJson ||
      counts.workflowSecretsInherit !==
        INITIAL_BASELINE.workflowSecretsInherit ||
      counts.workflowFloatingRef !== INITIAL_BASELINE.workflowFloatingRef)
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
  const expiresAt = Date.parse(inventory.expiresAt);
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
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= capturedAt ||
    expiresAt - capturedAt > INVENTORY_MAX_TTL_MS
  ) {
    reasons.push("INVENTORY_TTL_INVALID");
  } else if (
    capturedAt > now + INVENTORY_MAX_CLOCK_SKEW_MS ||
    (requireFresh && expiresAt <= now)
  ) {
    reasons.push("INVENTORY_EXPIRED");
  }
  return sortedUnique(reasons);
}

function cleanupCountsProgress(currentCounts, priorCounts) {
  const cleanupKeys = [
    "legacyOperationJson",
    "workflowSecretsInherit",
    "workflowFloatingRef",
  ];
  return (
    cleanupKeys.every((key) => currentCounts[key] <= priorCounts[key]) &&
    cleanupKeys.some((key) => currentCounts[key] < priorCounts[key])
  );
}

function verifyCheckpointSignature(checkpoint, trustedInventoryKeys) {
  const attestation = checkpoint.attestation;
  if (attestation.inventoryDigest !== checkpoint.inventoryDigest) return false;
  const key = trustedPublicKey(trustedInventoryKeys, attestation.keyId);
  if (key === null) return false;
  const capturedAt = Date.parse(checkpoint.capturedAt);
  const expiresAt = Date.parse(checkpoint.expiresAt);
  const signedAt = Date.parse(attestation.signedAt);
  const coverageObservedAt = Date.parse(checkpoint.coverageObservedAt);
  if (
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(signedAt) ||
    !Number.isFinite(coverageObservedAt) ||
    coverageObservedAt > capturedAt ||
    expiresAt <= capturedAt ||
    expiresAt - capturedAt > INVENTORY_MAX_TTL_MS ||
    signedAt < capturedAt ||
    signedAt > expiresAt ||
    checkpoint.providerTotalCount !==
      checkpoint.expectedCounts.activeRepositories
  ) {
    return false;
  }
  try {
    const signature = decodeCanonicalEd25519Signature(attestation.value);
    return (
      signature !== null &&
      verifyEd25519(
        null,
        Buffer.from(
          canonicalJson(checkpointAttestationPayloadObject(checkpoint)),
          "utf8",
        ),
        key,
        signature,
      )
    );
  } catch {
    return false;
  }
}

function bootstrapLineageCommitment() {
  return {
    mode: "BOOTSTRAP",
    waveNumber: 0,
    priorInventoryId: null,
    priorInventoryDigest: null,
    priorCapturedAt: null,
    priorObservedCounts: null,
    rootInventoryId: null,
    rootInventoryDigest: null,
    chainDigest: null,
  };
}

function sameCheckpointFleet(left, right) {
  return (
    left.organizationId === right.organizationId &&
    left.organizationLogin === right.organizationLogin &&
    left.installationId === right.installationId &&
    left.coverageProvider === right.coverageProvider &&
    canonicalJson(left.coverageQuery) === canonicalJson(right.coverageQuery)
  );
}

function embeddedLineageMatches(inventory, trustedInventoryKeys) {
  const { lineage } = inventory;
  if (lineage.mode === "BOOTSTRAP") {
    return (
      canonicalJson(lineageCommitment(lineage)) ===
        canonicalJson(bootstrapLineageCommitment()) &&
      lineage.ancestry.length === 0
    );
  }
  const checkpoints = lineage.ancestry;
  if (checkpoints.length !== lineage.waveNumber) return false;
  const seenInventoryIds = new Set();
  const seenInventoryDigests = new Set();
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (
      seenInventoryIds.has(checkpoint.inventoryId) ||
      seenInventoryDigests.has(checkpoint.inventoryDigest) ||
      !verifyCheckpointSignature(checkpoint, trustedInventoryKeys)
    ) {
      return false;
    }
    seenInventoryIds.add(checkpoint.inventoryId);
    seenInventoryDigests.add(checkpoint.inventoryDigest);
    if (index === 0) {
      if (
        canonicalJson(checkpoint.lineageCommitment) !==
          canonicalJson(bootstrapLineageCommitment()) ||
        canonicalJson(checkpoint.expectedCounts) !==
          canonicalJson(INITIAL_BASELINE)
      ) {
        return false;
      }
      continue;
    }
    const previous = checkpoints[index - 1];
    const committed = checkpoint.lineageCommitment;
    if (
      !sameCheckpointFleet(checkpoint, previous) ||
      committed.mode !== "WAVE" ||
      committed.waveNumber !== index ||
      committed.rootInventoryId !== checkpoints[0].inventoryId ||
      committed.rootInventoryDigest !== checkpoints[0].inventoryDigest ||
      committed.priorInventoryId !== previous.inventoryId ||
      committed.priorInventoryDigest !== previous.inventoryDigest ||
      committed.priorCapturedAt !== previous.capturedAt ||
      canonicalJson(committed.priorObservedCounts) !==
        canonicalJson(previous.expectedCounts) ||
      committed.chainDigest !==
        computeFleetMigrationLineageChainDigest(checkpoints.slice(0, index)) ||
      Date.parse(checkpoint.capturedAt) <= Date.parse(previous.capturedAt) ||
      Date.parse(checkpoint.capturedAt) <
        Date.parse(previous.attestation.signedAt) ||
      Date.parse(checkpoint.coverageObservedAt) <=
        Date.parse(previous.capturedAt) ||
      !cleanupCountsProgress(checkpoint.expectedCounts, previous.expectedCounts)
    ) {
      return false;
    }
  }
  const root = checkpoints[0];
  const prior = checkpoints.at(-1);
  return (
    prior !== undefined &&
    inventory.organization.id === root.organizationId &&
    inventory.organization.login === root.organizationLogin &&
    inventory.coverage.installationId === root.installationId &&
    inventory.coverage.provider === root.coverageProvider &&
    canonicalJson(inventory.coverage.query) ===
      canonicalJson(root.coverageQuery) &&
    lineage.rootInventoryId === root.inventoryId &&
    lineage.rootInventoryDigest === root.inventoryDigest &&
    lineage.priorInventoryId === prior.inventoryId &&
    lineage.priorInventoryDigest === prior.inventoryDigest &&
    lineage.priorCapturedAt === prior.capturedAt &&
    canonicalJson(lineage.priorObservedCounts) ===
      canonicalJson(prior.expectedCounts) &&
    lineage.chainDigest ===
      computeFleetMigrationLineageChainDigest(checkpoints) &&
    Date.parse(inventory.capturedAt) > Date.parse(prior.capturedAt) &&
    Date.parse(inventory.capturedAt) >=
      Date.parse(prior.attestation.signedAt) &&
    Date.parse(inventory.coverage.observedAt) > Date.parse(prior.capturedAt) &&
    cleanupCountsProgress(inventory.expectedCounts, prior.expectedCounts)
  );
}

function chainHeadBindingMatches(
  binding,
  chainHead,
  priorInventory,
  trustedPriorInventoryBinding,
  inventory,
  now,
  trustedCurrentInventoryBinding,
) {
  if (
    !CHAIN_HEAD_BINDINGS.has(binding) ||
    chainHead === undefined ||
    priorInventory === undefined ||
    trustedPriorInventoryBinding === undefined ||
    trustedCurrentInventoryBinding === undefined ||
    !historicalBindingMatches(trustedPriorInventoryBinding, priorInventory)
  ) {
    return false;
  }
  const nowMs = trustedNow(now);
  const attestation = chainHead.attestation;
  const priorCounts = expectedCountsFromObserved(
    observedCounts(priorInventory.repositories),
  );
  const priorDigest = computeFleetMigrationInventoryDigest(priorInventory);
  const priorRootInventoryId =
    priorInventory.lineage.mode === "BOOTSTRAP"
      ? priorInventory.inventoryId
      : priorInventory.lineage.rootInventoryId;
  const priorRootInventoryDigest =
    priorInventory.lineage.mode === "BOOTSTRAP"
      ? priorDigest
      : priorInventory.lineage.rootInventoryDigest;
  const currentAttestation = inventory.attestation;
  const currentDigest = computeFleetMigrationInventoryDigest(inventory);
  return (
    attestation !== null &&
    currentAttestation !== null &&
    binding.chainHeadDigest ===
      computeFleetMigrationChainHeadDigest(chainHead) &&
    binding.keyId === attestation.keyId &&
    binding.policyRevision === attestation.policyRevision &&
    binding.signedAt === attestation.signedAt &&
    binding.authorityRevision === chainHead.authorityRevision &&
    binding.readbackId === chainHead.readbackId &&
    binding.observedAt === chainHead.observedAt &&
    binding.expiresAt === chainHead.expiresAt &&
    nowMs < Date.parse(chainHead.expiresAt) &&
    binding.organizationId === priorInventory.organization.id &&
    binding.organizationId === inventory.organization.id &&
    binding.installationId === priorInventory.coverage.installationId &&
    binding.installationId === inventory.coverage.installationId &&
    binding.stateGeneration === chainHead.head.stateGeneration &&
    binding.reservationId === chainHead.reservation.reservationId &&
    binding.reservationExpectedGeneration ===
      chainHead.reservation.expectedGeneration &&
    binding.reservationReservedGeneration ===
      chainHead.reservation.reservedGeneration &&
    binding.reservationReservedAt === chainHead.reservation.reservedAt &&
    binding.waveNumber === priorInventory.lineage.waveNumber &&
    binding.inventoryId === priorInventory.inventoryId &&
    binding.inventoryDigest === priorDigest &&
    binding.chainDigest === priorInventory.lineage.chainDigest &&
    binding.rootInventoryId === priorRootInventoryId &&
    binding.rootInventoryDigest === priorRootInventoryDigest &&
    canonicalJson(binding.observedCounts) === canonicalJson(priorCounts) &&
    binding.inventoryKeyId === trustedPriorInventoryBinding.keyId &&
    binding.keyId !== trustedPriorInventoryBinding.keyId &&
    binding.keyFingerprint !==
      trustedPriorInventoryBinding.keyFingerprint &&
    binding.inventoryPolicyRevision ===
      trustedPriorInventoryBinding.policyRevision &&
    binding.inventorySignedAt === trustedPriorInventoryBinding.signedAt &&
    binding.keyId !== trustedCurrentInventoryBinding.keyId &&
    binding.keyFingerprint !==
      trustedCurrentInventoryBinding.keyFingerprint &&
    trustedCurrentInventoryBinding.inventoryId === inventory.inventoryId &&
    trustedCurrentInventoryBinding.inventoryDigest === currentDigest &&
    binding.candidateWaveNumber === inventory.lineage.waveNumber &&
    binding.candidateInventoryId === inventory.inventoryId &&
    binding.candidateInventoryDigest === currentDigest &&
    binding.candidateInventorySignedAt === currentAttestation.signedAt &&
    inventory.lineage.waveNumber === binding.waveNumber + 1 &&
    inventory.lineage.priorInventoryId === binding.inventoryId &&
    inventory.lineage.priorInventoryDigest === binding.inventoryDigest &&
    inventory.lineage.chainDigest !== binding.chainDigest
  );
}

function verifyTrustedInventoryBinding({
  inventory,
  trustedInventoryKeys,
  now,
  historical,
  priorInventory,
  trustedPriorInventoryBinding,
  chainHead,
  trustedChainHeadBinding,
}) {
  assertValidInventory(inventory);
  const nowMs = trustedNow(now);
  const counts = observedCounts(inventory.repositories);
  const authorityReasons = inventoryAuthorityReasons(inventory, counts, nowMs, {
    requireFresh: !historical,
  });
  if (authorityReasons.length > 0) {
    throw new Error(
      `FLEET_MIGRATION_INVENTORY_UNTRUSTED:${authorityReasons.join(",")}`,
    );
  }
  if (!embeddedLineageMatches(inventory, trustedInventoryKeys)) {
    throw new Error("FLEET_MIGRATION_INVENTORY_LINEAGE_INVALID");
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
    signedAt < Date.parse(inventory.capturedAt) ||
    signedAt > Date.parse(inventory.expiresAt) ||
    signedAt > nowMs + INVENTORY_MAX_CLOCK_SKEW_MS
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
    const signature = decodeCanonicalEd25519Signature(attestation.value);
    verified =
      signature !== null &&
      verifyEd25519(
        null,
        payload,
        key,
        signature,
      );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new Error("FLEET_MIGRATION_INVENTORY_SIGNATURE_INVALID");
  }
  const currentSignerBinding = {
    inventoryId: inventory.inventoryId,
    inventoryDigest,
    keyId: attestation.keyId,
    keyFingerprint: publicKeyFingerprint(key),
  };
  if (
    !historical &&
    inventory.lineage.mode === "WAVE" &&
    trustedChainHeadBinding !== undefined &&
    CHAIN_HEAD_BINDINGS.has(trustedChainHeadBinding) &&
    chainHeadKeyConflictsWithInventoryKeys(
      trustedChainHeadBinding,
      trustedInventoryKeys,
    )
  ) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_KEY_ROLE_CONFLICT");
  }
  if (
    !historical &&
    inventory.lineage.mode === "WAVE" &&
    (chainHead === undefined || trustedChainHeadBinding === undefined)
  ) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_REQUIRED");
  }
  if (
    !historical &&
    inventory.lineage.mode === "WAVE" &&
    !chainHeadBindingMatches(
      trustedChainHeadBinding,
      chainHead,
      priorInventory,
      trustedPriorInventoryBinding,
      inventory,
      nowMs,
      currentSignerBinding,
    )
  ) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_MISMATCH");
  }
  if (
    inventory.lineage.mode === "BOOTSTRAP" &&
    (priorInventory !== undefined ||
      trustedPriorInventoryBinding !== undefined ||
      chainHead !== undefined ||
      trustedChainHeadBinding !== undefined)
  ) {
    throw new Error("FLEET_MIGRATION_CHAIN_HEAD_NOT_ALLOWED");
  }
  const binding = deepFreeze({
    inventoryId: inventory.inventoryId,
    inventoryDigest,
    keyId: attestation.keyId,
    keyFingerprint: publicKeyFingerprint(key),
    policyRevision: attestation.policyRevision,
    signedAt: attestation.signedAt,
    expiresAt: inventory.expiresAt,
    waveNumber: inventory.lineage.waveNumber,
    rootInventoryId:
      inventory.lineage.mode === "BOOTSTRAP"
        ? inventory.inventoryId
        : inventory.lineage.rootInventoryId,
    rootInventoryDigest:
      inventory.lineage.mode === "BOOTSTRAP"
        ? inventoryDigest
        : inventory.lineage.rootInventoryDigest,
    chainDigest: inventory.lineage.chainDigest,
    priorChainHeadDigest:
      historical || inventory.lineage.mode === "BOOTSTRAP"
        ? null
        : trustedChainHeadBinding.chainHeadDigest,
    priorChainHeadAuthorityRevision:
      historical || inventory.lineage.mode === "BOOTSTRAP"
        ? null
        : trustedChainHeadBinding.authorityRevision,
  });
  (historical ? HISTORICAL_INVENTORY_BINDINGS : INVENTORY_BINDINGS).add(
    binding,
  );
  return binding;
}

export function loadTrustedFleetMigrationInventoryBinding({
  inventory,
  trustedInventoryKeys,
  now,
  priorInventory,
  trustedPriorInventoryBinding,
  chainHead,
  trustedChainHeadBinding,
}) {
  return verifyTrustedInventoryBinding({
    inventory,
    trustedInventoryKeys,
    now,
    historical: false,
    priorInventory,
    trustedPriorInventoryBinding,
    chainHead,
    trustedChainHeadBinding,
  });
}

export function loadTrustedFleetMigrationHistoricalInventoryBinding({
  inventory,
  trustedInventoryKeys,
  now,
}) {
  return verifyTrustedInventoryBinding({
    inventory,
    trustedInventoryKeys,
    now,
    historical: true,
  });
}

function bindingMatches(binding, inventory, now) {
  if (!INVENTORY_BINDINGS.has(binding)) return false;
  const nowMs = trustedNow(now);
  const attestation = inventory.attestation;
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  return (
    attestation !== null &&
    binding.inventoryId === inventory.inventoryId &&
    binding.inventoryDigest === inventoryDigest &&
    binding.keyId === attestation.keyId &&
    binding.policyRevision === attestation.policyRevision &&
    binding.signedAt === attestation.signedAt &&
    binding.expiresAt === inventory.expiresAt &&
    binding.waveNumber === inventory.lineage.waveNumber &&
    binding.rootInventoryId ===
      (inventory.lineage.mode === "BOOTSTRAP"
        ? inventory.inventoryId
        : inventory.lineage.rootInventoryId) &&
    binding.rootInventoryDigest ===
      (inventory.lineage.mode === "BOOTSTRAP"
        ? inventoryDigest
        : inventory.lineage.rootInventoryDigest) &&
    binding.chainDigest === inventory.lineage.chainDigest &&
    (inventory.lineage.mode === "BOOTSTRAP"
      ? binding.priorChainHeadDigest === null &&
        binding.priorChainHeadAuthorityRevision === null
      : binding.priorChainHeadDigest !== null &&
        binding.priorChainHeadAuthorityRevision !== null) &&
    nowMs < Date.parse(inventory.expiresAt)
  );
}

function historicalBindingMatches(binding, inventory) {
  if (
    !INVENTORY_BINDINGS.has(binding) &&
    !HISTORICAL_INVENTORY_BINDINGS.has(binding)
  ) {
    return false;
  }
  const attestation = inventory.attestation;
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  return (
    attestation !== null &&
    binding.inventoryId === inventory.inventoryId &&
    binding.inventoryDigest === inventoryDigest &&
    binding.keyId === attestation.keyId &&
    binding.policyRevision === attestation.policyRevision &&
    binding.signedAt === attestation.signedAt &&
    binding.expiresAt === inventory.expiresAt &&
    binding.waveNumber === inventory.lineage.waveNumber &&
    binding.rootInventoryId ===
      (inventory.lineage.mode === "BOOTSTRAP"
        ? inventory.inventoryId
        : inventory.lineage.rootInventoryId) &&
    binding.rootInventoryDigest ===
      (inventory.lineage.mode === "BOOTSTRAP"
        ? inventoryDigest
        : inventory.lineage.rootInventoryDigest) &&
    binding.chainDigest === inventory.lineage.chainDigest
  );
}

function expectedCountsFromObserved(counts) {
  return {
    activeRepositories: counts.activeRepositories,
    legacyOperationJson: counts.legacyOperationJson,
    workflowSecretsInherit: counts.workflowSecretsInherit,
    workflowFloatingRef: counts.workflowFloatingRef,
  };
}

function inventoryLineageReasons(
  inventory,
  {
    priorInventory,
    trustedPriorInventoryBinding,
    chainHead,
    trustedChainHeadBinding,
    trustedCurrentInventoryBinding,
  } = {},
  now,
) {
  if (inventory.lineage.mode === "BOOTSTRAP") {
    return priorInventory === undefined &&
      trustedPriorInventoryBinding === undefined &&
      chainHead === undefined &&
      trustedChainHeadBinding === undefined
      ? []
      : ["INVENTORY_LINEAGE_MISMATCH"];
  }
  if (
    priorInventory === undefined ||
    trustedPriorInventoryBinding === undefined
  ) {
    return ["INVENTORY_LINEAGE_REQUIRED"];
  }
  if (chainHead === undefined || trustedChainHeadBinding === undefined) {
    return ["CHAIN_HEAD_REQUIRED"];
  }
  if (
    !chainHeadBindingMatches(
      trustedChainHeadBinding,
      chainHead,
      priorInventory,
      trustedPriorInventoryBinding,
      inventory,
      now,
      trustedCurrentInventoryBinding,
    )
  ) {
    return ["CHAIN_HEAD_MISMATCH"];
  }
  try {
    assertValidInventory(priorInventory);
  } catch {
    return ["INVENTORY_LINEAGE_MISMATCH"];
  }
  if (!historicalBindingMatches(trustedPriorInventoryBinding, priorInventory)) {
    return ["INVENTORY_LINEAGE_MISMATCH"];
  }
  let expectedAncestry;
  try {
    expectedAncestry = [
      ...structuredClone(priorInventory.lineage.ancestry),
      structuredClone(deriveFleetMigrationInventoryCheckpoint(priorInventory)),
    ];
  } catch {
    return ["INVENTORY_LINEAGE_MISMATCH"];
  }
  const priorCounts = observedCounts(priorInventory.repositories);
  const currentCounts = observedCounts(inventory.repositories);
  const priorExpectedCounts = expectedCountsFromObserved(priorCounts);
  const priorWaveNumber = priorInventory.lineage.waveNumber;
  const priorCapturedAt = Date.parse(priorInventory.capturedAt);
  const currentProviderEvidenceIsNewer =
    Date.parse(inventory.coverage.observedAt) > priorCapturedAt &&
    inventory.repositories.every(
      ({ observation }) =>
        Date.parse(observation.observedAt) > priorCapturedAt &&
        Date.parse(observation.treeReadback.observedAt) > priorCapturedAt,
    );
  const sameFleet =
    inventory.organization.id === priorInventory.organization.id &&
    inventory.organization.login === priorInventory.organization.login &&
    inventory.coverage.installationId ===
      priorInventory.coverage.installationId &&
    inventory.coverage.provider === priorInventory.coverage.provider &&
    canonicalJson(inventory.coverage.query) ===
      canonicalJson(priorInventory.coverage.query);
  const lineageMatches =
    sameFleet &&
    inventory.lineage.waveNumber === priorWaveNumber + 1 &&
    inventory.lineage.rootInventoryId ===
      trustedPriorInventoryBinding.rootInventoryId &&
    inventory.lineage.rootInventoryDigest ===
      trustedPriorInventoryBinding.rootInventoryDigest &&
    inventory.lineage.priorInventoryId === priorInventory.inventoryId &&
    inventory.lineage.priorInventoryDigest ===
      trustedPriorInventoryBinding.inventoryDigest &&
    inventory.lineage.priorCapturedAt === priorInventory.capturedAt &&
    canonicalJson(inventory.lineage.priorObservedCounts) ===
      canonicalJson(priorExpectedCounts) &&
    canonicalJson(inventory.lineage.ancestry) ===
      canonicalJson(expectedAncestry) &&
    inventory.lineage.chainDigest ===
      computeFleetMigrationLineageChainDigest(expectedAncestry) &&
    Date.parse(inventory.capturedAt) > priorCapturedAt &&
    currentProviderEvidenceIsNewer;
  if (!lineageMatches) return ["INVENTORY_LINEAGE_MISMATCH"];
  return cleanupCountsProgress(currentCounts, priorCounts)
    ? []
    : ["INVENTORY_COUNTS_NOT_MONOTONIC"];
}

function platformRegistryCollisionReasons(repositories) {
  const subjects = new Set();
  const platformAppIds = new Set();
  for (const { candidates } of repositories) {
    for (const candidate of candidates) {
      if (
        candidate.detection.type !== "LEGACY_OPERATION_JSON" ||
        candidate.detection.contract !== "PLATFORM_REGISTRY_APP"
      ) {
        continue;
      }
      const subjectKey = candidate.subject.appId;
      const platformAppId = candidate.subject.platformAppId;
      if (
        subjectKey === null ||
        subjects.has(subjectKey) ||
        platformAppId === null ||
        platformAppIds.has(platformAppId)
      ) {
        return ["PLATFORM_FLEET_BINDING_MISMATCH"];
      }
      subjects.add(subjectKey);
      platformAppIds.add(platformAppId);
    }
  }
  return [];
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

function subjectBindingReasons(candidate, repository, repositoryById) {
  const { subject } = candidate;
  if (!classificationDecisionMatches(subject)) {
    return ["SUBJECT_BINDING_MISMATCH"];
  }
  const observedSubject = repositoryById.get(subject.repositoryId)?.repository;
  if (
    observedSubject === undefined ||
    observedSubject.fullName !== subject.fullName ||
    observedSubject.defaultRef !== subject.sourceRef ||
    observedSubject.sourceSha !== subject.sourceSha ||
    observedSubject.classificationDecisionRevision !==
      subject.classificationDecisionRevision ||
    observedSubject.classificationDecisionId !==
      subject.classificationDecisionId
  ) {
    return ["SUBJECT_BINDING_MISMATCH"];
  }
  if (subject.kind === "PRODUCT_APP") {
    const isPlatformRegistry =
      candidate.detection.type === "LEGACY_OPERATION_JSON" &&
      candidate.detection.contract === "PLATFORM_REGISTRY_APP";
    const sameRepository = subject.repositoryId === repository.id;
    const sourceContractMatches = sameRepository
      ? subject.platformAppId === null &&
        repository.classification === "PRODUCT_APP"
      : isPlatformRegistry &&
        subject.platformAppId !== null &&
        repository.classification === "PLATFORM_PRODUCER" &&
        !repository.fork;
    return subject.appId !== null &&
      observedSubject.classification === "PRODUCT_APP" &&
      !observedSubject.fork &&
      sourceContractMatches
      ? []
      : ["SUBJECT_BINDING_MISMATCH"];
  }
  const matchesSource =
    subject.appId === null &&
    subject.platformAppId === null &&
    subject.repositoryId === repository.id &&
    subject.fullName === repository.fullName &&
    ["INFRA_REPO", "PLATFORM_PRODUCER"].includes(repository.classification);
  return matchesSource ? [] : ["SUBJECT_BINDING_MISMATCH"];
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
      repository.classification === "PLATFORM_PRODUCER" &&
      candidate.subject.kind === "PRODUCT_APP" &&
      candidate.subject.platformAppId !== null &&
      candidate.replacement?.type === "SIGNED_RESOLVED_MANIFEST" &&
      candidate.replacement.appId === candidate.subject.appId &&
      path === `registry/apps/${candidate.subject.platformAppId}.json`;
  } else {
    pathMatches &&=
      repository.classification === "PRODUCT_APP" &&
      candidate.subject.kind === "PRODUCT_APP" &&
      candidate.subject.repositoryId === repository.id;
  }
  if (!pathMatches) reasons.push("DETECTION_PATH_MISMATCH");
  return reasons;
}

function classifyCandidate(candidate, repository, repositoryById) {
  const category = categoryForDetection(candidate.detection);
  const reasons = [];
  reasons.push(...subjectBindingReasons(candidate, repository, repositoryById));
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

export function computeFleetMigrationReplacementBindingDigest(replacement) {
  if (replacement === null) return null;
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-replacement-binding-v1",
      replacement: normalizeReplacement(replacement),
    }),
  );
}

export function computeFleetPlatformFleetBindingDigest(readback) {
  const {
    bindingDigest: _bindingDigest,
    evidenceDigest: _evidenceDigest,
    ...unsigned
  } = readback;
  return sha256(
    canonicalJson({
      contract: "seorilabs-platform-fleet-binding-readback-v1",
      ...unsigned,
    }),
  );
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
    proofs.platformFleetBindingReadback,
    proofs.sourceReadback,
    proofs.parityStream,
    ...proofs.parityStream.observations,
    ...proofs.buildOnly,
    ...proofs.credentialBindings,
    proofs.consumerReadback,
    proofs.rollback.gitRestore,
    proofs.rollback.backofficeOutageRecovery,
    proofs.rollback.ownerGate,
    proofs.controlPlaneReadback,
  ].filter((value) => value !== null);
}

function platformFleetBindingReasons(candidate, repository) {
  const readback = candidate.proofs.platformFleetBindingReadback;
  const isPlatformRegistry =
    candidate.detection.type === "LEGACY_OPERATION_JSON" &&
    candidate.detection.contract === "PLATFORM_REGISTRY_APP";
  if (!isPlatformRegistry) {
    return readback === null ? [] : ["PLATFORM_FLEET_BINDING_MISMATCH"];
  }
  if (readback === null) return ["PLATFORM_FLEET_BINDING_MISSING"];
  const { subject } = candidate;
  const matches =
    subject.kind === "PRODUCT_APP" &&
    subject.appId !== null &&
    subject.platformAppId !== null &&
    subject.repositoryId !== repository.id &&
    readback.appId === subject.appId &&
    readback.appRepositoryId === subject.repositoryId &&
    readback.appSourceSha === subject.sourceSha &&
    readback.platformAppId === subject.platformAppId &&
    readback.platformRepositoryId === repository.id &&
    readback.platformSourceSha === repository.sourceSha &&
    readback.classificationDecisionRevision ===
      subject.classificationDecisionRevision &&
    readback.classificationDecisionId === subject.classificationDecisionId &&
    readback.bindingDigest === computeFleetPlatformFleetBindingDigest(readback);
  return matches ? [] : ["PLATFORM_FLEET_BINDING_MISMATCH"];
}

function evidenceReasons(proofs) {
  return evidenceObjects(proofs).every(
    (evidence) =>
      evidence.evidenceDigest === computeFleetEvidenceDigest(evidence),
  )
    ? []
    : ["EVIDENCE_DIGEST_MISMATCH"];
}

function activeConfigReasons(candidate) {
  const readback = candidate.proofs.activeConfigReadback;
  const { subject } = candidate;
  if (subject.kind === "REPOSITORY") {
    return readback === null ? [] : ["ACTIVE_CONFIG_READBACK_MISMATCH"];
  }
  if (readback === null) return ["ACTIVE_CONFIG_READBACK_MISSING"];
  let matches =
    readback.repositoryId === subject.repositoryId &&
    readback.sourceSha === subject.sourceSha &&
    readback.appId === subject.appId;
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

function marketProfileReasons(candidate) {
  const market = candidate.proofs.marketProfileReadback;
  const active = candidate.proofs.activeConfigReadback;
  if (candidate.subject.kind === "REPOSITORY") {
    return market === null ? [] : ["MARKET_PROFILE_READBACK_MISMATCH"];
  }
  if (market === null) return ["MARKET_PROFILE_READBACK_MISSING"];
  const matches =
    active !== null &&
    market.appId === active.appId &&
    market.repositoryId === candidate.subject.repositoryId &&
    market.sourceSha === candidate.subject.sourceSha &&
    market.configRevisionId === active.configRevisionId &&
    canonicalJson(market.marketBuildTargets) ===
      canonicalJson([...market.marketBuildTargets].sort(compareBuildTargets));
  return matches ? [] : ["MARKET_PROFILE_READBACK_MISMATCH"];
}

function workflowBundleReasons(candidate, targets) {
  const bundle = candidate.proofs.workflowBundleReadback;
  if (bundle === null) return ["WORKFLOW_BUNDLE_READBACK_MISSING"];
  const bindingTargets = bundle.bindings.map(({ target }) => target);
  const uniqueBindingTargets = new Set(bindingTargets);
  let matches =
    bundle.appId === candidate.subject.appId &&
    bundle.repositoryId === candidate.subject.repositoryId &&
    bundle.sourceSha === candidate.subject.sourceSha &&
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
  discoveryTreeSha,
) {
  const readback = candidate.proofs.sourceReadback;
  if (readback === null) return ["SOURCE_READBACK_MISSING"];
  const evidenceTimes = evidenceObjects(candidate.proofs)
    .filter((evidence) => evidence !== readback)
    .map(
      (evidence) =>
        evidence.observedAt ??
        evidence.readbackAt ??
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
    readback.treeSha === discoveryTreeSha &&
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

function parityReasons(
  candidate,
  repository,
  replacementDigest,
  capturedAt,
  now,
) {
  const stream = candidate.proofs.parityStream;
  const observations = candidate.proofs.parityStream.observations;
  if (observations.length < 2) {
    return ["PARITY_REQUIRES_LATEST_CONTIGUOUS_MATCHES"];
  }
  const readbackAt = Date.parse(stream.readbackAt);
  const expiresAt = Date.parse(stream.expiresAt);
  const capturedAtMs = Date.parse(capturedAt);
  if (
    !Number.isFinite(readbackAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= readbackAt ||
    expiresAt - readbackAt > INVENTORY_MAX_TTL_MS ||
    readbackAt > capturedAtMs ||
    expiresAt <= capturedAtMs ||
    expiresAt <= now
  ) {
    return ["PARITY_READBACK_EXPIRED"];
  }
  let streamMatches =
    stream.totalObservations === observations.length &&
    stream.headSequence === observations.length;
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
  const head = observations.at(-1);
  if (
    head === undefined ||
    stream.headObservationId !== head.observationId ||
    stream.headSequence !== head.sequence
  ) {
    return ["PARITY_HEAD_MISMATCH"];
  }
  if (readbackAt < Date.parse(head.observedAt)) {
    return ["PARITY_HEAD_MISMATCH"];
  }
  const latestMatches = latest.every(
    (observation) =>
      observation.state === "MATCH" &&
      observation.sourceSha === repository.sourceSha &&
      observation.subjectRepositoryId === candidate.subject.repositoryId &&
      observation.subjectSourceSha === candidate.subject.sourceSha &&
      observation.appId === candidate.subject.appId &&
      observation.currentContentDigest === candidate.contentDigest &&
      observation.replacementDigest === replacementDigest,
  );
  if (!streamMatches) return ["PARITY_STREAM_MISMATCH"];
  return latestMatches ? [] : ["PARITY_REQUIRES_LATEST_CONTIGUOUS_MATCHES"];
}

function buildOnlyReasons(candidate, targets, replacementDigest) {
  const builds = candidate.proofs.buildOnly;
  if (builds.length === 0) return ["BUILD_ONLY_MISSING"];
  const bundle = candidate.proofs.workflowBundleReadback;
  const active = candidate.proofs.activeConfigReadback;
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
      const configMatches =
        candidate.subject.kind === "PRODUCT_APP"
          ? active !== null &&
            build.configRevisionId === active.configRevisionId &&
            build.configRevisionDigest === active.configRevisionDigest &&
            build.signedSnapshotDigest === active.signedSnapshotDigest &&
            build.signatureKeyId === active.signatureKeyId &&
            build.policyRevision === active.policyRevision
          : active === null &&
            build.configRevisionId === null &&
            build.configRevisionDigest === null &&
            build.signedSnapshotDigest === null &&
            build.signatureKeyId === null &&
            build.policyRevision === null;
      return (
        binding !== undefined &&
        build.runRepositoryId === candidate.subject.repositoryId &&
        build.appId === candidate.subject.appId &&
        build.sourceSha === candidate.subject.sourceSha &&
        configMatches &&
        build.replacementDigest === replacementDigest &&
        build.workflowBundleSha === bundle.workflowBundleSha &&
        build.workflowRef === binding.workflowRef &&
        build.builderDigest === binding.builderDigest
      );
    });
  return matches ? [] : ["BUILD_ONLY_MISMATCH"];
}

export function computeFleetCredentialBindingScopeDigest(binding) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-credential-binding-scope-v1",
      appId: binding.appId,
      repositoryId: binding.repositoryId,
      sourceSha: binding.sourceSha,
      secretName: binding.secretName,
      logicalCredentialId: binding.logicalCredentialId,
      provider: binding.provider,
      capability: binding.capability,
      environment: binding.environment,
      publicIdentity: binding.publicIdentity,
      fingerprint: binding.fingerprint,
      consumer: binding.consumer,
      status: binding.status,
      credentialGeneration: binding.credentialGeneration,
      policyGeneration: binding.policyGeneration,
      policyRevision: binding.policyRevision,
      replacementBlobDigest: binding.replacementBlobDigest,
    }),
  );
}

function credentialBindingReasons(candidate) {
  const replacement = candidate.replacement;
  if (replacement?.type !== "EXPLICIT_SECRET_MAPPING") return [];
  const expected = normalizeReplacement(replacement).namedCredentialBindings;
  const observed = candidate.proofs.credentialBindings;
  if (observed.length === 0) return ["CREDENTIAL_BINDING_MISSING"];
  const observedPolicies = observed.map(
    ({
      secretName,
      logicalCredentialId,
      provider,
      capability,
      environment,
      publicIdentity,
      fingerprint,
      policyRevision,
    }) => ({
      secretName,
      logicalCredentialId,
      provider,
      capability,
      environment,
      publicIdentity,
      fingerprint,
      policyRevision,
    }),
  );
  const uniqueKeys = new Set(
    observedPolicies.map(({ secretName, logicalCredentialId }) =>
      canonicalJson({ secretName, logicalCredentialId }),
    ),
  );
  const matches =
    observed.length === expected.length &&
    uniqueKeys.size === observed.length &&
    canonicalJson(observedPolicies) === canonicalJson(expected) &&
    observed.every(
      (binding) =>
        binding.appId === candidate.subject.appId &&
        binding.repositoryId === candidate.subject.repositoryId &&
        binding.sourceSha === candidate.subject.sourceSha &&
        binding.consumer ===
          `${candidate.subject.fullName}:${candidate.path}:${binding.secretName}` &&
        binding.replacementBlobDigest === replacement.replacementBlobDigest &&
        binding.status === "ACTIVE" &&
        binding.credentialGeneration > 0 &&
        binding.policyGeneration > 0 &&
        binding.scopeDigest ===
          computeFleetCredentialBindingScopeDigest(binding) &&
        (binding.publicIdentity !== null || binding.fingerprint !== null),
    );
  return matches ? [] : ["CREDENTIAL_BINDING_MISMATCH"];
}

function consumerReadbackReasons(candidate, repository, replacementDigest) {
  const readback = candidate.proofs.consumerReadback;
  if (readback === null) return ["CONSUMER_READBACK_MISSING"];
  const operation = operationForCategories([
    categoryForDetection(candidate.detection),
  ]);
  const policyMatches =
    operation === "DELETE"
      ? readback.parserFallbackState === "DISABLED" &&
        readback.dispatchReadbackState === "NOT_APPLICABLE"
      : operation === "REWRITE" &&
        readback.parserFallbackState === "NOT_APPLICABLE" &&
        readback.dispatchReadbackState === "MATCH";
  const matches =
    operation !== "NONE" &&
    readback.repositoryId === repository.id &&
    readback.sourceSha === repository.sourceSha &&
    readback.path === candidate.path &&
    readback.operation === operation &&
    readback.replacementDigest === replacementDigest &&
    readback.legacyConsumerCount === 0 &&
    readback.state === "MATCH" &&
    policyMatches;
  return matches ? [] : ["CONSUMER_READBACK_MISMATCH"];
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
  subjectRepositoryId,
  subjectSourceSha,
  subjectClassificationDecisionRevision,
  subjectClassificationDecisionId,
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
      subjectRepositoryId,
      subjectSourceSha,
      subjectClassificationDecisionRevision,
      subjectClassificationDecisionId,
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
  const ownerId =
    active?.ownerId ?? candidate.proofs.controlPlaneReadback?.ownerId ?? null;
  return computeFleetMigrationOwnerScopeDigest({
    repositoryId: repository.id,
    sourceSha: repository.sourceSha,
    subjectRepositoryId: candidate.subject.repositoryId,
    subjectSourceSha: candidate.subject.sourceSha,
    subjectClassificationDecisionRevision:
      candidate.subject.classificationDecisionRevision,
    subjectClassificationDecisionId: candidate.subject.classificationDecisionId,
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
    ownerId,
  });
}

function rollbackReasons(
  candidate,
  repository,
  replacementDigest,
  discoveryTreeSha,
) {
  const { gitRestore, backofficeOutageRecovery, ownerGate } =
    candidate.proofs.rollback;
  const active = candidate.proofs.activeConfigReadback;
  const reasons = [];
  if (gitRestore === null) {
    reasons.push("GIT_ROLLBACK_MISSING");
  } else if (
    gitRestore.sourceSha !== repository.sourceSha ||
    gitRestore.sourceTreeSha !== discoveryTreeSha ||
    gitRestore.path !== candidate.path ||
    canonicalJson(gitRestore.originalGitEntry) !==
      canonicalJson(candidate.gitEntry) ||
    gitRestore.originalContentDigest !== candidate.contentDigest
  ) {
    reasons.push("GIT_ROLLBACK_MISMATCH");
  }
  if (
    candidate.subject.kind === "PRODUCT_APP" &&
    backofficeOutageRecovery === null
  ) {
    reasons.push("OUTAGE_RECOVERY_MISSING");
  } else if (
    candidate.subject.kind === "PRODUCT_APP" &&
    (active === null ||
      backofficeOutageRecovery.appId !== active.appId ||
      backofficeOutageRecovery.repositoryId !==
        candidate.subject.repositoryId ||
      backofficeOutageRecovery.sourceSha !== candidate.subject.sourceSha ||
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
          repositoryId: candidate.subject.repositoryId,
          sourceSha: candidate.subject.sourceSha,
          configRevisionId: active.configRevisionId,
          configRevisionDigest: active.configRevisionDigest,
          signedSnapshotDigest: active.signedSnapshotDigest,
          signatureKeyId: active.signatureKeyId,
          policyRevision: active.policyRevision,
        }))
  ) {
    reasons.push("OUTAGE_RECOVERY_MISMATCH");
  } else if (
    candidate.subject.kind === "REPOSITORY" &&
    backofficeOutageRecovery !== null
  ) {
    reasons.push("OUTAGE_RECOVERY_MISMATCH");
  }
  if (ownerGate === null) {
    reasons.push("OWNER_GATE_MISSING");
  } else if (
    ownerGate.ownerId !==
      (active?.ownerId ?? candidate.proofs.controlPlaneReadback?.ownerId) ||
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
  const configMatches =
    candidate.subject.kind === "PRODUCT_APP"
      ? active !== null &&
        readback.appId === active.appId &&
        readback.configRevisionId === active.configRevisionId &&
        readback.configRevisionDigest === active.configRevisionDigest &&
        readback.signedSnapshotDigest === active.signedSnapshotDigest &&
        readback.signatureKeyId === active.signatureKeyId &&
        readback.policyRevision === active.policyRevision &&
        readback.ownerId === active.ownerId
      : active === null &&
        readback.appId === null &&
        readback.configRevisionId === null &&
        readback.configRevisionDigest === null &&
        readback.signedSnapshotDigest === null &&
        readback.signatureKeyId === null &&
        readback.policyRevision === null;
  const matches =
    readback.repositoryId === candidate.subject.repositoryId &&
    readback.sourceSha === candidate.subject.sourceSha &&
    configMatches &&
    readback.replacementDigest === replacementDigest;
  return matches ? [] : ["CONTROL_PLANE_READBACK_MISMATCH"];
}

function proofReasons(
  candidate,
  repository,
  replacementDigest,
  capturedAt,
  discoveryObservedAt,
  discoveryTreeSha,
  now,
) {
  if (replacementDigest === null) return [];
  const targets = requiredBuildTargets(candidate);
  return [
    ...evidenceReasons(candidate.proofs),
    ...activeConfigReasons(candidate),
    ...marketProfileReasons(candidate),
    ...workflowBundleReasons(candidate, targets),
    ...platformFleetBindingReasons(candidate, repository),
    ...sourceReadbackReasons(
      candidate,
      repository,
      capturedAt,
      discoveryObservedAt,
      discoveryTreeSha,
    ),
    ...parityReasons(candidate, repository, replacementDigest, capturedAt, now),
    ...buildOnlyReasons(candidate, targets, replacementDigest),
    ...credentialBindingReasons(candidate),
    ...consumerReadbackReasons(candidate, repository, replacementDigest),
    ...rollbackReasons(
      candidate,
      repository,
      replacementDigest,
      discoveryTreeSha,
    ),
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
  const tree = observation.treeReadback;
  if (
    tree.evidenceDigest !== computeFleetEvidenceDigest(tree) ||
    tree.repositoryId !== repository.id ||
    tree.sourceSha !== repository.sourceSha ||
    tree.treeSha !== observation.treeSha ||
    tree.scannedBlobCount > tree.blobCount ||
    tree.blobCount > tree.entryCount ||
    !Number.isFinite(Date.parse(tree.observedAt)) ||
    Date.parse(tree.observedAt) > Date.parse(observation.observedAt)
  ) {
    reasons.push("OBSERVATION_TREE_READBACK_MISMATCH");
  }
  if (
    observation.findingsDigest !==
    computeFleetFindingsDigest({
      repositoryId: repository.id,
      sourceRef: repository.defaultRef,
      sourceSha: repository.sourceSha,
      treeSha: observation.treeSha,
      treeReadback: observation.treeReadback,
      candidates,
    })
  ) {
    reasons.push("OBSERVATION_FINDINGS_DIGEST_MISMATCH");
  }
  return reasons;
}

function findingCounts(candidates, repository, repositoryById) {
  const counts = {
    legacyOperationJson: 0,
    workflowSecretsInherit: 0,
    workflowFloatingRef: 0,
    unclassified: 0,
  };
  for (const candidate of candidates) {
    const { category } = classifyCandidate(
      candidate,
      repository,
      repositoryById,
    );
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
      chainHead: inventory.chainHead,
      repositoriesDigest: inventory.repositoriesDigest,
      detectorSourceSha: inventory.detectorSourceSha,
      repositoryId: repository.repositoryId,
      sourceRef: repository.sourceRef,
      sourceSha: repository.sourceSha,
      fork: repository.fork,
      classification: repository.classification,
      classificationDecisionRevision: repository.classificationDecisionRevision,
      classificationDecisionId: repository.classificationDecisionId,
      migrationId: change.migrationId,
      categories: change.categories,
      findingCounts: change.findingCounts,
      operation: change.operation,
      path: change.path,
      gitEntry: change.gitEntry,
      contentDigest: change.contentDigest,
      requiredBuildTargets: change.requiredBuildTargets,
      replacementDigest: change.replacementDigest,
      replacementBindingDigest: change.replacementBindingDigest,
      namedCredentialBindings: change.namedCredentialBindings,
      subject: change.subject,
      proofDigest: change.proofDigest,
      evidence: change.evidence,
    }),
  );
}

function evidenceSummary(proofs) {
  return {
    sourceReadbackId: proofs.sourceReadback?.observationId ?? null,
    platformFleetBindingObservationId:
      proofs.platformFleetBindingReadback?.observationId ?? null,
    parityStreamId: proofs.parityStream.streamId,
    parityHeadObservationId: proofs.parityStream.headObservationId,
    parityHeadSequence: proofs.parityStream.headSequence,
    parityTotalObservations: proofs.parityStream.totalObservations,
    buildRunIds: proofs.buildOnly
      .map(({ runId }) => runId)
      .sort(compareNumericIds),
    credentialObservationIds: proofs.credentialBindings
      .map(({ observationId }) => observationId)
      .sort(compareUtf8),
    consumerReadbackId: proofs.consumerReadback?.observationId ?? null,
    gitRestoreValidationId:
      proofs.rollback.gitRestore?.restoreValidationId ?? null,
    ownerApprovalId: proofs.rollback.ownerGate?.approvalId ?? null,
    controlPlaneReadbackId:
      proofs.controlPlaneReadback?.providerObservationId ?? null,
  };
}

function aggregateDigest(values) {
  const unique = sortedUnique(values.filter((value) => value !== null));
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  return sha256(canonicalJson(unique));
}

function namedCredentialBindings(candidates) {
  const bindings = candidates.flatMap(({ replacement }) =>
    replacement?.type === "EXPLICIT_SECRET_MAPPING"
      ? replacement.namedCredentialBindings
      : [],
  );
  const byName = new Map();
  for (const binding of bindings) {
    const existing = byName.get(binding.secretName);
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(binding)
    ) {
      return null;
    }
    byName.set(binding.secretName, structuredClone(binding));
  }
  return [...byName.values()].sort(
    (left, right) =>
      compareUtf8(left.secretName, right.secretName) ||
      compareUtf8(left.logicalCredentialId, right.logicalCredentialId),
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
    const subjects = new Set(
      candidates.map(({ subject }) => canonicalJson(subject)),
    );
    if (subjects.size !== 1) {
      reasonsByPath.get(path).push("SUBJECT_BINDING_MISMATCH");
    }
    if (namedCredentialBindings(candidates) === null) {
      reasonsByPath.get(path).push("CREDENTIAL_BINDING_MISMATCH");
    }
  }
  return reasonsByPath;
}

function planRepository(
  repositoryObservation,
  inventorySummary,
  globalReasons,
  repositoryById,
  now,
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
    fork: repository.fork,
    classification: repository.classification,
    classificationDecisionRevision: repository.classificationDecisionRevision,
    classificationDecisionId: repository.classificationDecisionId,
  };
  const changes = [...groups]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([path, pathCandidates]) => {
      const perCandidate = pathCandidates.map((candidate) => {
        const classification = classifyCandidate(
          candidate,
          repository,
          repositoryById,
        );
        const replacementDigest = computeFleetMigrationReplacementDigest(
          candidate.replacement,
        );
        const replacementBindingDigest =
          computeFleetMigrationReplacementBindingDigest(candidate.replacement);
        return {
          candidate,
          category: classification.category,
          replacementDigest,
          replacementBindingDigest,
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
              observation.treeSha,
              now,
            ),
          ],
        };
      });
      const counts = findingCounts(pathCandidates, repository, repositoryById);
      const categories = categoriesForFindingCounts(counts);
      if (
        categories.some(
          (category) => counts[CATEGORY_TO_COUNT_KEY[category]] > 1,
        )
      ) {
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
      const replacementBindingDigest = aggregateDigest(
        perCandidate.map((item) => item.replacementBindingDigest),
      );
      const credentialBindings = namedCredentialBindings(pathCandidates);
      const subjects = new Set(
        perCandidate.map(({ candidate }) => canonicalJson(candidate.subject)),
      );
      const reasons = sortedUnique([
        ...repositoryReasons,
        ...(collisionReasons.get(path) ?? []),
        ...(operation === "NONE" && !categories.includes("UNCLASSIFIED")
          ? ["PATH_REPLACEMENT_COLLISION"]
          : []),
        ...(targetSets.size === 1 ? [] : ["PATH_PROOF_COLLISION"]),
        ...(subjects.size === 1 ? [] : ["SUBJECT_BINDING_MISMATCH"]),
        ...(credentialBindings === null ? ["CREDENTIAL_BINDING_MISMATCH"] : []),
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
        subject: structuredClone(first.candidate.subject),
        requiredBuildTargets:
          targetSets.size === 1 ? first.targets : ["ORG_CONTRACT_STATIC"],
        replacementDigest:
          replacementDigests.size === 1 ? first.replacementDigest : null,
        replacementBindingDigest,
        namedCredentialBindings: credentialBindings ?? [],
        proofDigest:
          proofDigests.size === 1
            ? [...proofDigests][0]
            : sha256(canonicalJson([...proofDigests].sort(compareUtf8))),
        evidence: evidenceSummary(first.candidate.proofs),
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

function bindingSummary(inventory, binding, now) {
  const inventoryDigest = computeFleetMigrationInventoryDigest(inventory);
  if (bindingMatches(binding, inventory, now)) {
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

function lineageSummary(lineage) {
  return {
    ...lineageCommitment(lineage),
    ancestorCount: lineage.ancestry.length,
  };
}

function chainHeadSummary(inventory, lineageInputs, now) {
  const empty = (state) => ({
    state,
    keyId: null,
    policyRevision: null,
    signedAt: null,
    authorityRevision: null,
    readbackId: null,
    observedAt: null,
    expiresAt: null,
    chainHeadDigest: null,
    stateGeneration: null,
    reservationId: null,
    reservedGeneration: null,
    waveNumber: null,
    inventoryId: null,
    inventoryDigest: null,
    chainDigest: null,
    candidateInventoryDigest: null,
  });
  if (inventory.lineage.mode === "BOOTSTRAP") {
    return empty("NOT_APPLICABLE");
  }
  const {
    priorInventory,
    trustedPriorInventoryBinding,
    chainHead,
    trustedChainHeadBinding,
    trustedCurrentInventoryBinding,
  } = lineageInputs ?? {};
  if (
    !chainHeadBindingMatches(
      trustedChainHeadBinding,
      chainHead,
      priorInventory,
      trustedPriorInventoryBinding,
      inventory,
      now,
      trustedCurrentInventoryBinding,
    )
  ) {
    return empty("MISSING");
  }
  return {
    state: "VERIFIED",
    keyId: trustedChainHeadBinding.keyId,
    policyRevision: trustedChainHeadBinding.policyRevision,
    signedAt: trustedChainHeadBinding.signedAt,
    authorityRevision: trustedChainHeadBinding.authorityRevision,
    readbackId: trustedChainHeadBinding.readbackId,
    observedAt: trustedChainHeadBinding.observedAt,
    expiresAt: trustedChainHeadBinding.expiresAt,
    chainHeadDigest: trustedChainHeadBinding.chainHeadDigest,
    stateGeneration: trustedChainHeadBinding.stateGeneration,
    reservationId: trustedChainHeadBinding.reservationId,
    reservedGeneration:
      trustedChainHeadBinding.reservationReservedGeneration,
    waveNumber: trustedChainHeadBinding.waveNumber,
    inventoryId: trustedChainHeadBinding.inventoryId,
    inventoryDigest: trustedChainHeadBinding.inventoryDigest,
    chainDigest: trustedChainHeadBinding.chainDigest,
    candidateInventoryDigest:
      trustedChainHeadBinding.candidateInventoryDigest,
  };
}

function withoutPlanDigest(plan) {
  const { planDigest: _planDigest, ...unsigned } = plan;
  return unsigned;
}

function buildFleetMigrationPlan(
  inventory,
  trustedInventoryBinding,
  now,
  lineageInputs,
) {
  const nowMs = trustedNow(now);
  const normalizedRepositories = [...inventory.repositories].sort(
    (left, right) =>
      compareNumericIds(left.repository.id, right.repository.id) ||
      compareUtf8(left.repository.fullName, right.repository.fullName),
  );
  const repositoryById = new Map(
    normalizedRepositories.map((entry) => [entry.repository.id, entry]),
  );
  const counts = observedCounts(normalizedRepositories);
  const verifiedLineageInputs = {
    ...lineageInputs,
    trustedCurrentInventoryBinding: trustedInventoryBinding,
  };
  const reasons = [
    ...inventoryAuthorityReasons(inventory, counts, nowMs),
    ...inventoryLineageReasons(inventory, verifiedLineageInputs, nowMs),
    ...platformRegistryCollisionReasons(normalizedRepositories),
  ];
  if (trustedInventoryBinding === undefined) {
    reasons.push("TRUSTED_INVENTORY_BINDING_MISSING");
  } else if (!bindingMatches(trustedInventoryBinding, inventory, nowMs)) {
    reasons.push("TRUSTED_INVENTORY_BINDING_MISMATCH");
  }
  const inventorySummary = {
    inventoryId: inventory.inventoryId,
    capturedAt: inventory.capturedAt,
    expiresAt: inventory.expiresAt,
    organizationId: inventory.organization.id,
    detectorSourceSha: inventory.detector.sourceSha,
    installationId: inventory.coverage.installationId,
    coverageReadbackId: inventory.coverage.readbackId,
    coverageSnapshotId: inventory.coverage.snapshotId,
    providerTotalCount: inventory.coverage.providerTotalCount,
    repositoriesDigest: inventory.coverage.repositoriesDigest,
    expectedCounts: structuredClone(inventory.expectedCounts),
    observedCounts: counts,
    lineage: lineageSummary(inventory.lineage),
    binding: bindingSummary(inventory, trustedInventoryBinding, nowMs),
    chainHead: chainHeadSummary(inventory, verifiedLineageInputs, nowMs),
  };
  const repositories = normalizedRepositories.map((repository) =>
    planRepository(
      repository,
      inventorySummary,
      sortedUnique(reasons),
      repositoryById,
      nowMs,
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
  if (
    plan.outcome === "READY_FOR_REVIEW" &&
    plan.inventory.lineage.mode === "WAVE" &&
    plan.inventory.chainHead.state !== "VERIFIED"
  ) {
    diagnostics.push("PLAN_CHAIN_HEAD_REQUIRED");
  }
  if (
    plan.inventory.lineage.mode === "BOOTSTRAP" &&
    plan.inventory.chainHead.state !== "NOT_APPLICABLE"
  ) {
    diagnostics.push("PLAN_CHAIN_HEAD_INVALID");
  }
  const sortedRepositories = [...plan.repositories].sort(
    (left, right) =>
      compareNumericIds(left.repositoryId, right.repositoryId) ||
      compareUtf8(left.fullName, right.fullName),
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
      compareUtf8(left.path, right.path),
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
        migrationId(repository.repositoryId, change.categories, change.path)
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
  if (canonicalJson(plan.inventory.observedCounts) !== canonicalJson(counts)) {
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
  {
    trustedInventoryBinding,
    priorInventory,
    trustedPriorInventoryBinding,
    chainHead,
    trustedChainHeadBinding,
    now,
  } = {},
) {
  assertValidInventory(inventory);
  const plan = buildFleetMigrationPlan(
    inventory,
    trustedInventoryBinding,
    now,
    {
      priorInventory,
      trustedPriorInventoryBinding,
      chainHead,
      trustedChainHeadBinding,
    },
  );
  const diagnostics = structuralPlanValidation(plan);
  if (diagnostics.length > 0) {
    throw new Error(`FLEET_MIGRATION_PLAN_INVALID:${diagnostics.join(",")}`);
  }
  return deepFreeze(plan);
}

export function validateFleetMigrationPlan(
  plan,
  {
    inventory,
    trustedInventoryBinding,
    priorInventory,
    trustedPriorInventoryBinding,
    chainHead,
    trustedChainHeadBinding,
    now,
  } = {},
) {
  const diagnostics = structuralPlanValidation(plan);
  if (diagnostics.length > 0) {
    return deepFreeze({ ok: false, diagnostics });
  }
  if (
    inventory === undefined ||
    !bindingMatches(trustedInventoryBinding, inventory, now)
  ) {
    return deepFreeze({
      ok: false,
      diagnostics: ["PLAN_TRUSTED_INPUT_REQUIRED"],
    });
  }
  let expected;
  try {
    assertValidInventory(inventory);
    expected = buildFleetMigrationPlan(
      inventory,
      trustedInventoryBinding,
      now,
      {
        priorInventory,
        trustedPriorInventoryBinding,
        chainHead,
        trustedChainHeadBinding,
      },
    );
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
  return deepFreeze({ ok: true, diagnostics: [] });
}

export function validateFleetMigrationPlanStructure(plan) {
  const diagnostics = structuralPlanValidation(plan);
  return deepFreeze({
    ok: diagnostics.length === 0,
    diagnostics,
  });
}

export const fleetMigrationContract = deepFreeze({
  schemaVersion: 1,
  mode: "PLAN_ONLY",
  executionAllowed: false,
  initialBaseline: {
    mode: "BOOTSTRAP_ONLY",
    observedDate: "2026-08-29",
    expectedCounts: INITIAL_BASELINE,
  },
  inventoryAttestation: {
    algorithm: "Ed25519",
    contract: "seorilabs-fleet-migration-inventory-attestation-v2",
    trustRootRequired: true,
  },
  inventorySchema: "fleet-migration-inventory.schema.json",
  chainHeadSchema: "fleet-migration-chain-head.schema.json",
  chainHeadAttestation: {
    algorithm: "Ed25519",
    role: CHAIN_HEAD_AUTHORITY_ROLE,
    contract: "seorilabs-fleet-migration-chain-head-attestation-v1",
    maxTtlSeconds: CHAIN_HEAD_MAX_TTL_MS / 1000,
    separateTrustRootRequired: true,
    reservationContract: CHAIN_HEAD_RESERVATION_CONTRACT,
    durableCasRequired: true,
    liveCurrentReadbackRequired: true,
  },
  planSchema: "fleet-migration-plan.schema.json",
  requiredProofs: [
    "github-installation-query-pagination-and-provider-total",
    "signed-exact-inventory-and-evidence",
    "classification-revision-bound-source-and-product-subject",
    "platform-registry-app-and-platform-fleet-binding-readback",
    "prior-trusted-inventory-lineage-and-monotonic-wave-counts",
    "bootstrap-rooted-signed-checkpoint-chain",
    "state-authority-live-cas-reservation-exact-append",
    "untruncated-canonical-tree-and-detector-scoped-blob-readback",
    "canonical-blob-path-and-single-final-digest",
    "active-config-signed-snapshot-and-market-profile-readback",
    "authoritative-parity-head-total-and-latest-two-matches",
    "approved-workflow-bundle-config-and-replacement-bound-build-only",
    "replacement-authorized-credential-policy-scope-consumer-and-generation",
    "consumer-zero-parser-disabled-and-dispatch-readback",
    "exact-tree-git-and-backoffice-outage-rollback",
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
