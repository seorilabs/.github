import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  loadTrustedFleetMigrationInventoryBinding,
  validateFleetMigrationPlan,
} from "./fleet-migration.mjs";
import {
  fleetMigrationInventoryIssuerContract,
  validateFleetMigrationAuthoritativeInventory,
} from "./trusted-inventory-issuer.mjs";

const EXECUTION_CONTRACT = "seorilabs-fleet-cleanup-execution-v1";
const STATE_AUTHORITY_CONTRACT =
  "seorilabs-fleet-cleanup-state-authority-v1";
const RESERVATION_CONTRACT =
  "seorilabs-fleet-cleanup-state-reservation-v1";
const LEDGER_CONTRACT = "seorilabs-fleet-cleanup-execution-ledger-v1";
const COMPLETION_CONTRACT =
  "seorilabs-fleet-cleanup-state-consumption-v1";
const MUTATION_GUARD_CONTRACT =
  "seorilabs-fleet-cleanup-mutation-guard-v1";
const MUTATION_READBACK_CONTRACT =
  "seorilabs-fleet-cleanup-mutation-readback-v1";
const REPLACEMENT_READBACK_CONTRACT =
  "seorilabs-fleet-cleanup-replacement-readback-v1";
const ORGANIZATION_LOGIN = "seorilabs";
const STEP_KINDS = Object.freeze([
  "CREATE_COMMIT",
  "CREATE_REF",
  "CREATE_PR",
]);
const MAX_RESERVATION_MS = 5 * 60 * 1000;
const MAX_READBACK_AGE_MS = 2 * 60 * 1000;
const MAX_APPROVAL_TTL_MS = 15 * 60 * 1000;
const ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXECUTION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const FULL_NAME_PATTERN = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const SOURCE_REF_PATTERN =
  /^refs\/heads\/[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const PRIVATE_SURFACE_KEY_PATTERN =
  /^(?:authorization|cookie|credentialValue|leaseToken|password|privateKey|rawSecret|secret|secretValue|token)$/iu;
const PRIVATE_SURFACE_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/iu,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /["']private_key["']\s*:/u,
]);

const TRUSTED_GITHUB_ADAPTERS = new WeakSet();
const TRUSTED_STATE_STORES = new WeakSet();

const SOURCE_CONTRACTS_ROOT = fileURLToPath(
  new URL("../../../contracts", import.meta.url),
);
const PACKAGED_CONTRACTS_ROOT = fileURLToPath(
  new URL("../.generated/contracts", import.meta.url),
);
const CONTRACTS_ROOT = existsSync(SOURCE_CONTRACTS_ROOT)
  ? SOURCE_CONTRACTS_ROOT
  : PACKAGED_CONTRACTS_ROOT;
const validateReceiptSchema = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile(
  JSON.parse(
    readFileSync(
      resolve(CONTRACTS_ROOT, "fleet-cleanup-execution-receipt.schema.json"),
      "utf8",
    ),
  ),
);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

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

function gitBlobSha(content) {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort(compareUtf8)) ===
      canonicalJson([...keys].sort(compareUtf8))
  );
}

function deepFreeze(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    !Buffer.isBuffer(value) &&
    !Object.isFrozen(value)
  ) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertPublicSurface(value) {
  const visit = (item) => {
    if (Buffer.isBuffer(item)) {
      throw new Error("FLEET_CLEANUP_PRIVATE_SURFACE_REJECTED");
    }
    if (Array.isArray(item)) {
      for (const nested of item) visit(nested);
      return;
    }
    if (typeof item === "string") {
      if (PRIVATE_SURFACE_VALUE_PATTERNS.some((pattern) => pattern.test(item))) {
        throw new Error("FLEET_CLEANUP_PRIVATE_SURFACE_REJECTED");
      }
      return;
    }
    if (item === null || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      if (PRIVATE_SURFACE_KEY_PATTERN.test(key)) {
        throw new Error("FLEET_CLEANUP_PRIVATE_SURFACE_REJECTED");
      }
      visit(nested);
    }
  };
  visit(value);
}

function clonePublic(value, diagnostic) {
  try {
    const cloned = structuredClone(value);
    assertPublicSurface(cloned);
    return cloned;
  } catch {
    throw new Error(diagnostic);
  }
}

function trustedTime(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw new Error("FLEET_CLEANUP_TIME_INVALID");
  }
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("FLEET_CLEANUP_TIME_INVALID");
  }
  return milliseconds;
}

function evidenceDigest(value) {
  const { evidenceDigest: _evidenceDigest, ...unsigned } = value;
  return sha256(canonicalJson(unsigned));
}

function validFreshTime(value, nowMs, maximumAgeMs = MAX_READBACK_AGE_MS) {
  const observedAtMs = Date.parse(value ?? "");
  return (
    Number.isFinite(observedAtMs) &&
    new Date(observedAtMs).toISOString() === value &&
    observedAtMs <= nowMs &&
    nowMs - observedAtMs <= maximumAgeMs
  );
}

function snapshotPublicKey(key) {
  if (key?.type !== "public" || key?.asymmetricKeyType !== "ed25519") {
    throw new Error("FLEET_CLEANUP_EXECUTOR_CONFIGURATION_INVALID");
  }
  try {
    const spki = key.export({ format: "der", type: "spki" });
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    spki.fill(0);
    return publicKey;
  } catch {
    throw new Error("FLEET_CLEANUP_EXECUTOR_CONFIGURATION_INVALID");
  }
}

function copyMutationRequest(request) {
  const copy = structuredClone(request);
  for (let index = 0; index < (copy.mutations ?? []).length; index += 1) {
    const originalContent = request.mutations[index].content;
    if (originalContent !== null && !Buffer.isBuffer(originalContent)) {
      throw new Error("FLEET_CLEANUP_GITHUB_MUTATION_INVALID");
    }
    copy.mutations[index].content =
      originalContent === null ? null : Buffer.from(originalContent);
  }
  return copy;
}

export function createTrustedFleetCleanupGitHubAdapter({ provider } = {}) {
  const callbacks = [
    "readMutationGuard",
    "readReplacementBlob",
    "readCommit",
    "createCommit",
    "readRef",
    "createRef",
    "readPullRequest",
    "createPullRequest",
  ];
  if (
    !exactKeys(provider, callbacks) ||
    callbacks.some((name) => typeof provider[name] !== "function")
  ) {
    throw new Error("FLEET_CLEANUP_GITHUB_ADAPTER_CONFIGURATION_INVALID");
  }
  const adapter = Object.freeze({
    async readMutationGuard(request) {
      try {
        return clonePublic(
          await provider.readMutationGuard(
            deepFreeze(structuredClone(request)),
          ),
          "FLEET_CLEANUP_MUTATION_GUARD_READBACK_FAILED",
        );
      } catch {
        throw new Error("FLEET_CLEANUP_MUTATION_GUARD_READBACK_FAILED");
      }
    },
    async readReplacementBlob(request) {
      let raw;
      try {
        raw = await provider.readReplacementBlob(
          deepFreeze(structuredClone(request)),
        );
      } catch {
        throw new Error("FLEET_CLEANUP_REPLACEMENT_READBACK_FAILED");
      }
      if (!Buffer.isBuffer(raw?.content)) {
        throw new Error("FLEET_CLEANUP_REPLACEMENT_READBACK_FAILED");
      }
      const { content, ...metadata } = raw;
      const publicMetadata = clonePublic(
        metadata,
        "FLEET_CLEANUP_REPLACEMENT_READBACK_FAILED",
      );
      return { ...publicMetadata, content: Buffer.from(content) };
    },
    async readCommit(request) {
      try {
        return clonePublic(
          await provider.readCommit(deepFreeze(structuredClone(request))),
          "FLEET_CLEANUP_COMMIT_READBACK_FAILED",
        );
      } catch {
        throw new Error("FLEET_CLEANUP_COMMIT_READBACK_FAILED");
      }
    },
    async createCommit(request) {
      const copy = copyMutationRequest(request);
      try {
        const result = await provider.createCommit(copy);
        if (result !== undefined) {
          throw new Error("FLEET_CLEANUP_COMMIT_RESULT_UNKNOWN");
        }
      } catch {
        throw new Error("FLEET_CLEANUP_COMMIT_RESULT_UNKNOWN");
      } finally {
        for (const mutation of copy.mutations) {
          if (Buffer.isBuffer(mutation.content)) mutation.content.fill(0);
        }
      }
    },
    async readRef(request) {
      try {
        return clonePublic(
          await provider.readRef(deepFreeze(structuredClone(request))),
          "FLEET_CLEANUP_REF_READBACK_FAILED",
        );
      } catch {
        throw new Error("FLEET_CLEANUP_REF_READBACK_FAILED");
      }
    },
    async createRef(request) {
      try {
        const result = await provider.createRef(
          deepFreeze(structuredClone(request)),
        );
        if (result !== undefined) {
          throw new Error("FLEET_CLEANUP_REF_RESULT_UNKNOWN");
        }
      } catch {
        throw new Error("FLEET_CLEANUP_REF_RESULT_UNKNOWN");
      }
    },
    async readPullRequest(request) {
      try {
        return clonePublic(
          await provider.readPullRequest(
            deepFreeze(structuredClone(request)),
          ),
          "FLEET_CLEANUP_PR_READBACK_FAILED",
        );
      } catch {
        throw new Error("FLEET_CLEANUP_PR_READBACK_FAILED");
      }
    },
    async createPullRequest(request) {
      try {
        const result = await provider.createPullRequest(
          deepFreeze(structuredClone(request)),
        );
        if (result !== undefined) {
          throw new Error("FLEET_CLEANUP_PR_RESULT_UNKNOWN");
        }
      } catch {
        throw new Error("FLEET_CLEANUP_PR_RESULT_UNKNOWN");
      }
    },
  });
  TRUSTED_GITHUB_ADAPTERS.add(adapter);
  return adapter;
}

function copyStateRequest(request) {
  const copy = structuredClone(request);
  if (Buffer.isBuffer(request.leaseToken)) {
    copy.leaseToken = Buffer.from(request.leaseToken);
  }
  return copy;
}

export function createTrustedFleetCleanupStateStore({ provider } = {}) {
  const callbacks = [
    "readAuthority",
    "reserveExecution",
    "readExecution",
    "transitionStep",
    "completeAndConsume",
  ];
  if (
    !exactKeys(provider, callbacks) ||
    callbacks.some((name) => typeof provider[name] !== "function")
  ) {
    throw new Error("FLEET_CLEANUP_STATE_STORE_CONFIGURATION_INVALID");
  }
  const store = Object.freeze({
    async readAuthority(request) {
      try {
        return clonePublic(
          await provider.readAuthority(deepFreeze(structuredClone(request))),
          "FLEET_CLEANUP_STATE_AUTHORITY_READBACK_FAILED",
        );
      } catch {
        throw new Error("FLEET_CLEANUP_STATE_AUTHORITY_READBACK_FAILED");
      }
    },
    async reserveExecution(request) {
      let raw;
      try {
        raw = await provider.reserveExecution(
          deepFreeze(structuredClone(request)),
        );
      } catch {
        throw new Error("FLEET_CLEANUP_EXECUTION_CLAIM_FAILED");
      }
      try {
        if (raw?.state === "COMPLETED") {
          return clonePublic(raw, "FLEET_CLEANUP_EXECUTION_CLAIM_FAILED");
        }
        if (!Buffer.isBuffer(raw?.leaseToken)) {
          throw new Error("FLEET_CLEANUP_EXECUTION_CLAIM_FAILED");
        }
        const { leaseToken, ...metadata } = raw;
        return {
          ...clonePublic(metadata, "FLEET_CLEANUP_EXECUTION_CLAIM_FAILED"),
          leaseToken: Buffer.from(leaseToken),
        };
      } finally {
        if (Buffer.isBuffer(raw?.leaseToken)) raw.leaseToken.fill(0);
      }
    },
    async readExecution(request) {
      try {
        return clonePublic(
          await provider.readExecution(deepFreeze(structuredClone(request))),
          "FLEET_CLEANUP_LEDGER_READBACK_FAILED",
        );
      } catch {
        throw new Error("FLEET_CLEANUP_LEDGER_READBACK_FAILED");
      }
    },
    async transitionStep(request) {
      const copy = copyStateRequest(request);
      try {
        return clonePublic(
          await provider.transitionStep(copy),
          "FLEET_CLEANUP_LEDGER_TRANSITION_FAILED",
        );
      } catch {
        throw new Error("FLEET_CLEANUP_LEDGER_TRANSITION_FAILED");
      } finally {
        if (Buffer.isBuffer(copy.leaseToken)) copy.leaseToken.fill(0);
      }
    },
    async completeAndConsume(request) {
      const copy = copyStateRequest(request);
      try {
        return clonePublic(
          await provider.completeAndConsume(copy),
          "FLEET_CLEANUP_COMPLETION_FAILED",
        );
      } catch {
        throw new Error("FLEET_CLEANUP_COMPLETION_FAILED");
      } finally {
        if (Buffer.isBuffer(copy.leaseToken)) copy.leaseToken.fill(0);
      }
    },
  });
  TRUSTED_STATE_STORES.add(store);
  return store;
}

export function computeFleetCleanupApprovalScopeDigest(input) {
  if (
    !exactKeys(input, [
      "fullName",
      "installationId",
      "inventoryDigest",
      "issuanceDigest",
      "issueNumber",
      "organizationId",
      "planDigest",
      "repositoryId",
      "sourceSha",
    ]) ||
    !ID_PATTERN.test(input.organizationId ?? "") ||
    !ID_PATTERN.test(input.installationId ?? "") ||
    !DIGEST_PATTERN.test(input.issuanceDigest ?? "") ||
    !DIGEST_PATTERN.test(input.inventoryDigest ?? "") ||
    !DIGEST_PATTERN.test(input.planDigest ?? "") ||
    !ID_PATTERN.test(input.repositoryId ?? "") ||
    !FULL_NAME_PATTERN.test(input.fullName ?? "") ||
    !SHA_PATTERN.test(input.sourceSha ?? "") ||
    !Number.isSafeInteger(input.issueNumber) ||
    input.issueNumber < 1
  ) {
    throw new Error("FLEET_CLEANUP_APPROVAL_SCOPE_INVALID");
  }
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-cleanup-runtime-approval-scope-v1",
      ...structuredClone(input),
    }),
  );
}

function validExecutionRequest(value) {
  return (
    exactKeys(value, ["issueNumber", "repositoryId", "runId", "workerId"]) &&
    ID_PATTERN.test(value.repositoryId ?? "") &&
    Number.isSafeInteger(value.issueNumber) &&
    value.issueNumber > 0 &&
    EXECUTION_ID_PATTERN.test(value.runId ?? "") &&
    EXECUTION_ID_PATTERN.test(value.workerId ?? "")
  );
}

function fleetCleanupExecutionKey({
  issuanceDigest,
  inventoryDigest,
  planDigest,
  repositoryId,
  sourceSha,
}) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-cleanup-execution-key-v1",
      issuanceDigest,
      inventoryDigest,
      planDigest,
      repositoryId,
      sourceSha,
    }),
  );
}

function fleetCleanupOperationIds(executionKey) {
  return Object.fromEntries(
    STEP_KINDS.map((kind) => [
      kind,
      sha256(
        canonicalJson({
          contract: "seorilabs-fleet-cleanup-operation-v1",
          executionKey,
          kind,
        }),
      ),
    ]),
  );
}

function buildExecutionContext(
  issuance,
  plan,
  request,
  organizationId,
  installationId,
) {
  const repository = plan.repositories.find(
    ({ repositoryId }) => repositoryId === request.repositoryId,
  );
  const inventoryRepository = issuance.inventory.repositories.find(
    ({ repository: item }) => item.id === request.repositoryId,
  );
  if (
    repository === undefined ||
    inventoryRepository === undefined ||
    repository.fullName !== inventoryRepository.repository.fullName ||
    repository.sourceRef !== inventoryRepository.repository.defaultRef ||
    repository.sourceSha !== inventoryRepository.repository.sourceSha ||
    repository.fork ||
    repository.outcome !== "READY_FOR_REVIEW" ||
    repository.reasonCodes.length !== 0 ||
    repository.changes.length === 0
  ) {
    throw new Error("FLEET_CLEANUP_REPOSITORY_PLAN_INVALID");
  }
  const paths = new Set();
  for (const change of repository.changes) {
    if (
      paths.has(change.path) ||
      change.outcome !== "READY_FOR_REVIEW" ||
      change.reasonCodes.length !== 0 ||
      !["DELETE", "REWRITE"].includes(change.operation) ||
      !DIGEST_PATTERN.test(change.idempotencyKey ?? "") ||
      !DIGEST_PATTERN.test(change.contentDigest ?? "") ||
      !DIGEST_PATTERN.test(change.replacementDigest ?? "") ||
      !DIGEST_PATTERN.test(change.replacementBindingDigest ?? "") ||
      !SHA_PATTERN.test(change.gitEntry?.objectSha ?? "")
    ) {
      throw new Error("FLEET_CLEANUP_REPOSITORY_PLAN_INVALID");
    }
    paths.add(change.path);
    const crossRepository = change.subject.repositoryId !== repository.repositoryId;
    if (
      crossRepository &&
      !(
        repository.classification === "PLATFORM_PRODUCER" &&
        change.operation === "DELETE" &&
        change.categories.length === 1 &&
        change.categories[0] === "LEGACY_OPERATION_JSON" &&
        /^registry\/apps\/[a-z0-9][a-z0-9-]{1,62}\.json$/u.test(
          change.path,
        )
      )
    ) {
      throw new Error("FLEET_CLEANUP_CROSS_REPOSITORY_REJECTED");
    }
  }
  const inventoryDigest = issuance.inventoryDigest;
  const executionKey = fleetCleanupExecutionKey({
    issuanceDigest: issuance.issuanceDigest,
    inventoryDigest,
    planDigest: plan.planDigest,
    repositoryId: repository.repositoryId,
    sourceSha: repository.sourceSha,
  });
  const operationIds = fleetCleanupOperationIds(executionKey);
  const branchName =
    `seori/fleet-cleanup/${repository.repositoryId}/` +
    plan.planDigest.slice(7, 19);
  const branchRef = `refs/heads/${branchName}`;
  if (
    branchRef === repository.sourceRef ||
    !SOURCE_REF_PATTERN.test(branchRef)
  ) {
    throw new Error("FLEET_CLEANUP_BRANCH_INVALID");
  }
  const chainHeadDigest =
    plan.inventory.chainHead.state === "VERIFIED"
      ? plan.inventory.chainHead.chainHeadDigest
      : null;
  const binding = {
    organizationId,
    installationId,
    issuanceDigest: issuance.issuanceDigest,
    inventoryDigest,
    planDigest: plan.planDigest,
    executionKey,
    runId: request.runId,
    workerId: request.workerId,
    repositoryId: repository.repositoryId,
    fullName: repository.fullName,
    sourceSha: repository.sourceSha,
    issueNumber: request.issueNumber,
    chainHeadDigest,
  };
  return deepFreeze({
    binding,
    repository: structuredClone(repository),
    treeSha: inventoryRepository.observation.treeSha,
    changes: structuredClone(
      [...repository.changes].sort((left, right) =>
        compareUtf8(left.path, right.path),
      ),
    ),
    operationIds,
    branchName,
    branchRef,
    approvalScopeDigest: computeFleetCleanupApprovalScopeDigest({
      organizationId,
      installationId,
      issuanceDigest: issuance.issuanceDigest,
      inventoryDigest,
      planDigest: plan.planDigest,
      repositoryId: repository.repositoryId,
      fullName: repository.fullName,
      sourceSha: repository.sourceSha,
      issueNumber: request.issueNumber,
    }),
  });
}

function validateAuthorityReadback(value, context, nowMs) {
  return (
    exactKeys(value, [
      "authorityRevision",
      "chainHeadDigest",
      "contract",
      "evidenceDigest",
      "fullName",
      "generation",
      "installationId",
      "inventoryDigest",
      "observedAt",
      "organizationId",
      "planDigest",
      "readbackId",
      "repositoryId",
      "sourceSha",
      "state",
    ]) &&
    value.contract === STATE_AUTHORITY_CONTRACT &&
    value.state === "ACTIVE" &&
    value.organizationId === context.binding.organizationId &&
    value.installationId === context.binding.installationId &&
    value.repositoryId === context.binding.repositoryId &&
    value.fullName === context.binding.fullName &&
    value.sourceSha === context.binding.sourceSha &&
    value.inventoryDigest === context.binding.inventoryDigest &&
    value.planDigest === context.binding.planDigest &&
    value.chainHeadDigest === context.binding.chainHeadDigest &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    EXECUTION_ID_PATTERN.test(value.authorityRevision ?? "") &&
    EXECUTION_ID_PATTERN.test(value.readbackId ?? "") &&
    validFreshTime(value.observedAt, nowMs) &&
    evidenceDigest(value) === value.evidenceDigest
  );
}

function bindingMatches(value, binding) {
  return Object.entries(binding).every(([key, expected]) => value[key] === expected);
}

function validateReservation(value, context, authority, nowMs) {
  const common = [
    ...Object.keys(context.binding),
    "contract",
    "executionGeneration",
    "expectedStateGeneration",
    "reservationId",
    "reservedStateGeneration",
    "state",
  ];
  if (
    value?.state === "COMPLETED" &&
    exactKeys(value, [
      ...common,
      "receiptDigest",
      "stateGeneration",
    ])
  ) {
    return (
      value.contract === RESERVATION_CONTRACT &&
      bindingMatches(value, context.binding) &&
      value.expectedStateGeneration + 1 === value.reservedStateGeneration &&
      value.stateGeneration === value.reservedStateGeneration &&
      value.stateGeneration === authority.generation &&
      Number.isSafeInteger(value.executionGeneration) &&
      value.executionGeneration > 0 &&
      EXECUTION_ID_PATTERN.test(value.reservationId ?? "") &&
      DIGEST_PATTERN.test(value.receiptDigest ?? "")
    );
  }
  const expiresAtMs = Date.parse(value?.expiresAt ?? "");
  return (
    exactKeys(value, [...common, "expiresAt", "leaseToken"]) &&
    value.contract === RESERVATION_CONTRACT &&
    ["CLAIMED", "RESUME"].includes(value.state) &&
    bindingMatches(value, context.binding) &&
    value.expectedStateGeneration === authority.generation &&
    value.reservedStateGeneration === authority.generation + 1 &&
    Number.isSafeInteger(value.executionGeneration) &&
    value.executionGeneration > 0 &&
    EXECUTION_ID_PATTERN.test(value.reservationId ?? "") &&
    Buffer.isBuffer(value.leaseToken) &&
    value.leaseToken.length >= 32 &&
    value.leaseToken.length <= 4096 &&
    Number.isFinite(expiresAtMs) &&
    new Date(expiresAtMs).toISOString() === value.expiresAt &&
    expiresAtMs > nowMs &&
    expiresAtMs <= nowMs + MAX_RESERVATION_MS
  );
}

function assertReservationLive(reservation, nowMs) {
  const expiresAtMs = Date.parse(reservation.expiresAt ?? "");
  if (
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== reservation.expiresAt ||
    expiresAtMs <= nowMs
  ) {
    throw new Error("FLEET_CLEANUP_EXECUTION_LEASE_EXPIRED");
  }
}

function expectedStepState(steps) {
  if (steps.some(({ state }) => state === "RESULT_UNKNOWN")) {
    return "RESULT_UNKNOWN";
  }
  if (steps.every(({ state }) => state === "CONFIRMED")) {
    return "READY_TO_COMPLETE";
  }
  return "RUNNING";
}

function validateLedger(value, context, reservation, nowMs, options = {}) {
  if (
    !exactKeys(value, [
      ...Object.keys(context.binding),
      "contract",
      "evidenceDigest",
      "executionGeneration",
      "expectedStateGeneration",
      "observedAt",
      "readbackId",
      "receiptDigest",
      "reservationId",
      "reservedStateGeneration",
      "state",
      "steps",
    ]) ||
    value.contract !== LEDGER_CONTRACT ||
    !bindingMatches(value, context.binding) ||
    value.reservationId !== reservation.reservationId ||
    value.expectedStateGeneration !== reservation.expectedStateGeneration ||
    value.reservedStateGeneration !== reservation.reservedStateGeneration ||
    !Number.isSafeInteger(value.executionGeneration) ||
    value.executionGeneration < reservation.executionGeneration ||
    !EXECUTION_ID_PATTERN.test(value.readbackId ?? "") ||
    !validFreshTime(value.observedAt, nowMs) ||
    evidenceDigest(value) !== value.evidenceDigest ||
    !Array.isArray(value.steps) ||
    value.steps.length !== STEP_KINDS.length
  ) {
    return false;
  }
  for (let index = 0; index < STEP_KINDS.length; index += 1) {
    const step = value.steps[index];
    if (
      !exactKeys(step, ["kind", "operationId", "receiptDigest", "state"]) ||
      step.kind !== STEP_KINDS[index] ||
      step.operationId !== context.operationIds[step.kind] ||
      !["PENDING", "DISPATCHED", "RESULT_UNKNOWN", "CONFIRMED"].includes(
        step.state,
      ) ||
      (step.state === "CONFIRMED") !==
        DIGEST_PATTERN.test(step.receiptDigest ?? "") ||
      (step.state !== "CONFIRMED" && step.receiptDigest !== null)
    ) {
      return false;
    }
    if (
      index > 0 &&
      step.state !== "PENDING" &&
      value.steps[index - 1].state !== "CONFIRMED"
    ) {
      return false;
    }
  }
  if (options.completed === true) {
    return (
      value.state === "COMPLETED" &&
      value.steps.every(({ state }) => state === "CONFIRMED") &&
      DIGEST_PATTERN.test(value.receiptDigest ?? "")
    );
  }
  return (
    value.state === expectedStepState(value.steps) && value.receiptDigest === null
  );
}

function validateApproval(issue, context, nowMs) {
  const approvedAtMs = Date.parse(issue?.approvedAt ?? "");
  const expiresAtMs = Date.parse(issue?.expiresAt ?? "");
  const labels = issue?.labels;
  return (
    exactKeys(issue, [
      "approvalId",
      "approvalScopeDigest",
      "approvalState",
      "approvedAt",
      "expiresAt",
      "labels",
      "number",
      "state",
    ]) &&
    issue.number === context.binding.issueNumber &&
    issue.state === "OPEN" &&
    issue.approvalState === "APPROVED" &&
    EXECUTION_ID_PATTERN.test(issue.approvalId ?? "") &&
    issue.approvalScopeDigest === context.approvalScopeDigest &&
    Array.isArray(labels) &&
    labels.length > 0 &&
    new Set(labels).size === labels.length &&
    canonicalJson(labels) === canonicalJson([...labels].sort(compareUtf8)) &&
    labels.includes("autopilot") &&
    !labels.some(
      (label) =>
        label === "blocked" ||
        label === "no-autopilot" ||
        label.startsWith("approval:"),
    ) &&
    Number.isFinite(approvedAtMs) &&
    Number.isFinite(expiresAtMs) &&
    new Date(approvedAtMs).toISOString() === issue.approvedAt &&
    new Date(expiresAtMs).toISOString() === issue.expiresAt &&
    approvedAtMs <= nowMs &&
    expiresAtMs > nowMs &&
    expiresAtMs <= nowMs + MAX_APPROVAL_TTL_MS
  );
}

function expectedBlobReadbacks(context) {
  return context.changes.map((change) => ({
    path: change.path,
    mode: change.gitEntry.mode,
    objectSha: change.gitEntry.objectSha,
    contentDigest: change.contentDigest,
  }));
}

function validateMutationGuard(
  value,
  context,
  nowMs,
  knownCommitSha,
  allowExpectedPullRequest,
  requireExpectedPullRequest = false,
) {
  if (
    !exactKeys(value, [
      "archived",
      "blobs",
      "contract",
      "defaultHeadSha",
      "defaultRef",
      "evidenceDigest",
      "fork",
      "fullName",
      "installationId",
      "issue",
      "observedAt",
      "openAutonomousReadyPullRequestCount",
      "openAutonomousReadyPullRequests",
      "organizationId",
      "readbackId",
      "repositoryId",
      "treeSha",
    ]) ||
    value.contract !== MUTATION_GUARD_CONTRACT ||
    value.organizationId !== context.binding.organizationId ||
    value.installationId !== context.binding.installationId ||
    value.repositoryId !== context.binding.repositoryId ||
    value.fullName !== context.binding.fullName ||
    value.defaultRef !== context.repository.sourceRef ||
    value.defaultHeadSha !== context.binding.sourceSha ||
    value.treeSha !== context.treeSha ||
    value.archived !== false ||
    value.fork !== false ||
    !EXECUTION_ID_PATTERN.test(value.readbackId ?? "") ||
    !validFreshTime(value.observedAt, nowMs) ||
    evidenceDigest(value) !== value.evidenceDigest ||
    canonicalJson(value.blobs) !== canonicalJson(expectedBlobReadbacks(context)) ||
    !validateApproval(value.issue, context, nowMs) ||
    !Number.isSafeInteger(value.openAutonomousReadyPullRequestCount) ||
    value.openAutonomousReadyPullRequestCount < 0 ||
    value.openAutonomousReadyPullRequestCount > 1 ||
    !Array.isArray(value.openAutonomousReadyPullRequests) ||
    value.openAutonomousReadyPullRequests.length !==
      value.openAutonomousReadyPullRequestCount
  ) {
    return false;
  }
  if (value.openAutonomousReadyPullRequestCount === 0) {
    return !requireExpectedPullRequest;
  }
  const pullRequest = value.openAutonomousReadyPullRequests[0];
  return (
    (knownCommitSha !== null || allowExpectedPullRequest) &&
    exactKeys(pullRequest, [
      "baseRef",
      "headRef",
      "headSha",
      "isDraft",
      "number",
      "operationId",
      "state",
    ]) &&
    pullRequest.state === "OPEN" &&
    pullRequest.isDraft === false &&
    pullRequest.baseRef === context.repository.sourceRef.slice("refs/heads/".length) &&
    pullRequest.headRef === context.branchName &&
    SHA_PATTERN.test(pullRequest.headSha ?? "") &&
    (knownCommitSha === null || pullRequest.headSha === knownCommitSha) &&
    pullRequest.operationId === context.operationIds.CREATE_PR &&
    Number.isSafeInteger(pullRequest.number) &&
    pullRequest.number > 0
  );
}

function commonReadbackValid(value, context, kind, nowMs) {
  return (
    value?.contract === MUTATION_READBACK_CONTRACT &&
    value?.kind === kind &&
    value?.operationId === context.operationIds[kind] &&
    value?.repositoryId === context.binding.repositoryId &&
    value?.fullName === context.binding.fullName &&
    EXECUTION_ID_PATTERN.test(value?.readbackId ?? "") &&
    validFreshTime(value?.observedAt, nowMs) &&
    evidenceDigest(value) === value.evidenceDigest
  );
}

function validateAbsentReadback(value, context, kind, nowMs) {
  return (
    exactKeys(value, [
      "contract",
      "evidenceDigest",
      "fullName",
      "kind",
      "observedAt",
      "operationId",
      "readbackId",
      "repositoryId",
      "state",
    ]) &&
    ["ABSENT", "UNKNOWN"].includes(value.state) &&
    commonReadbackValid(value, context, kind, nowMs)
  );
}

function stableCommitReceipt(value) {
  return {
    kind: value.kind,
    operationId: value.operationId,
    repositoryId: value.repositoryId,
    fullName: value.fullName,
    parentSha: value.parentSha,
    sourceTreeSha: value.sourceTreeSha,
    commitSha: value.commitSha,
    treeSha: value.treeSha,
    mutationsDigest: value.mutationsDigest,
    changes: structuredClone(value.changes),
  };
}

function stableRefReceipt(value) {
  return {
    kind: value.kind,
    operationId: value.operationId,
    repositoryId: value.repositoryId,
    fullName: value.fullName,
    ref: value.ref,
    commitSha: value.commitSha,
  };
}

function stablePullRequestReceipt(value) {
  return {
    kind: value.kind,
    operationId: value.operationId,
    repositoryId: value.repositoryId,
    fullName: value.fullName,
    number: value.number,
    url: value.url,
    state: value.state,
    isDraft: value.isDraft,
    baseRef: value.baseRef,
    headRef: value.headRef,
    headSha: value.headSha,
    title: value.title,
    bodyDigest: value.bodyDigest,
  };
}

function publicMutationDescriptors(context, replacementContents = new Map()) {
  return context.changes.map((change) => {
    const content = replacementContents.get(change.path) ?? null;
    return {
      operation: change.operation,
      path: change.path,
      expectedMode: change.gitEntry.mode,
      expectedBlobSha: change.gitEntry.objectSha,
      expectedContentDigest: change.contentDigest,
      replacementDigest: change.replacementDigest,
      replacementBindingDigest: change.replacementBindingDigest,
      resultBlobSha: content === null ? null : gitBlobSha(content),
    };
  });
}

function mutationsDigest(context, replacementContents = new Map()) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-cleanup-mutations-v1",
      repositoryId: context.binding.repositoryId,
      sourceSha: context.binding.sourceSha,
      sourceTreeSha: context.treeSha,
      changes: publicMutationDescriptors(context, replacementContents),
    }),
  );
}

function validateCommitReadback(
  value,
  context,
  nowMs,
  replacementContents,
) {
  const expectedChanges = publicMutationDescriptors(context, replacementContents);
  return (
    exactKeys(value, [
      "changes",
      "commitSha",
      "contract",
      "evidenceDigest",
      "fullName",
      "kind",
      "mutationsDigest",
      "observedAt",
      "operationId",
      "parentSha",
      "readbackId",
      "repositoryId",
      "sourceTreeSha",
      "state",
      "treeSha",
    ]) &&
    value.state === "FOUND" &&
    commonReadbackValid(value, context, "CREATE_COMMIT", nowMs) &&
    value.parentSha === context.binding.sourceSha &&
    value.sourceTreeSha === context.treeSha &&
    SHA_PATTERN.test(value.commitSha ?? "") &&
    SHA_PATTERN.test(value.treeSha ?? "") &&
    value.mutationsDigest === mutationsDigest(context, replacementContents) &&
    canonicalJson(value.changes) === canonicalJson(expectedChanges)
  );
}

function validateRefReadback(value, context, nowMs, commitSha) {
  return (
    exactKeys(value, [
      "commitSha",
      "contract",
      "evidenceDigest",
      "fullName",
      "kind",
      "observedAt",
      "operationId",
      "readbackId",
      "ref",
      "repositoryId",
      "state",
    ]) &&
    value.state === "FOUND" &&
    commonReadbackValid(value, context, "CREATE_REF", nowMs) &&
    value.ref === context.branchRef &&
    value.commitSha === commitSha
  );
}

function pullRequestTitle() {
  return "P7 중앙 운영 설정 cleanup 적용";
}

function pullRequestBody(context) {
  return [
    "## 변경",
    "",
    "- 중앙 P7 authoritative inventory에 결합된 운영 설정 cleanup을 새 브랜치에 반영합니다.",
    "- 기본 브랜치는 직접 변경하지 않으며 이 PR은 Ready 상태로 생성됩니다.",
    "",
    "## 실행 결합",
    "",
    `- Inventory: \`${context.binding.inventoryDigest}\``,
    `- Plan: \`${context.binding.planDigest}\``,
    `- Source SHA: \`${context.binding.sourceSha}\``,
    "",
    `Closes #${context.binding.issueNumber}`,
  ].join("\n");
}

function validatePullRequestReadback(value, context, nowMs, commitSha) {
  const title = pullRequestTitle();
  const bodyDigest = sha256(pullRequestBody(context));
  const baseRef = context.repository.sourceRef.slice("refs/heads/".length);
  return (
    exactKeys(value, [
      "baseRef",
      "bodyDigest",
      "contract",
      "evidenceDigest",
      "fullName",
      "headRef",
      "headSha",
      "isDraft",
      "kind",
      "number",
      "observedAt",
      "operationId",
      "readbackId",
      "repositoryId",
      "state",
      "title",
      "url",
    ]) &&
    commonReadbackValid(value, context, "CREATE_PR", nowMs) &&
    value.state === "OPEN" &&
    value.isDraft === false &&
    Number.isSafeInteger(value.number) &&
    value.number > 0 &&
    value.url ===
      `https://github.com/${context.binding.fullName}/pull/${value.number}` &&
    value.baseRef === baseRef &&
    value.headRef === context.branchName &&
    value.headSha === commitSha &&
    value.title === title &&
    value.bodyDigest === bodyDigest
  );
}

function receiptDigest(receipt) {
  const {
    receiptDigest: _receiptDigest,
    replayed: _replayed,
    ...durable
  } = receipt;
  return sha256(canonicalJson(durable));
}

function ledgerStepsDigest(ledger) {
  return sha256(
    canonicalJson({
      contract: "seorilabs-fleet-cleanup-ledger-steps-v1",
      steps: ledger.steps.map(({ kind, operationId, receiptDigest: digest }) => ({
        kind,
        operationId,
        receiptDigest: digest,
      })),
    }),
  );
}

function buildFinalReceipt(
  context,
  ledger,
  commit,
  pullRequest,
  stateGeneration,
  executionGeneration,
  replayed,
) {
  const receipt = {
    schemaVersion: 1,
    contract: EXECUTION_CONTRACT,
    state: "READY_PR_CREATED",
    replayed,
    runId: context.binding.runId,
    workerId: context.binding.workerId,
    organizationId: context.binding.organizationId,
    installationId: context.binding.installationId,
    issuanceDigest: context.binding.issuanceDigest,
    inventoryDigest: context.binding.inventoryDigest,
    planDigest: context.binding.planDigest,
    repository: {
      id: context.binding.repositoryId,
      fullName: context.binding.fullName,
      sourceSha: context.binding.sourceSha,
      defaultRef: context.repository.sourceRef,
      treeSha: context.treeSha,
    },
    branch: {
      ref: context.branchRef,
      commitSha: commit.commitSha,
    },
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
      baseRef: pullRequest.baseRef,
      headRef: pullRequest.headRef,
      headSha: pullRequest.headSha,
    },
    authority: {
      reservationId: ledger.reservationId,
      stateGeneration,
    },
    ledger: {
      generation: executionGeneration,
      digest: ledgerStepsDigest(ledger),
      steps: ledger.steps.map(({ kind, operationId, receiptDigest: digest }) => ({
        kind,
        operationId,
        receiptDigest: digest,
      })),
    },
    receiptDigest: "sha256:" + "0".repeat(64),
  };
  receipt.receiptDigest = receiptDigest(receipt);
  if (!validateReceiptSchema(receipt)) {
    throw new Error("FLEET_CLEANUP_RECEIPT_INVALID");
  }
  assertPublicSurface(receipt);
  return deepFreeze(receipt);
}

function validateCompletion(value, context, reservation, ledger, digest) {
  return (
    exactKeys(value, [
      ...Object.keys(context.binding),
      "contract",
      "evidenceDigest",
      "executionGeneration",
      "receiptDigest",
      "reservationId",
      "state",
      "stateGeneration",
    ]) &&
    value.contract === COMPLETION_CONTRACT &&
    value.state === "COMPLETED" &&
    bindingMatches(value, context.binding) &&
    value.reservationId === reservation.reservationId &&
    value.stateGeneration === reservation.reservedStateGeneration &&
    value.executionGeneration === ledger.executionGeneration + 1 &&
    value.receiptDigest === digest &&
    evidenceDigest(value) === value.evidenceDigest
  );
}

export function createTrustedFleetCleanupExecutor({
  organizationId,
  installationId,
  inventoryPublicKey,
  githubAdapter,
  stateStore,
  clock = () => Date.now(),
} = {}) {
  if (
    !ID_PATTERN.test(organizationId ?? "") ||
    !ID_PATTERN.test(installationId ?? "") ||
    !TRUSTED_GITHUB_ADAPTERS.has(githubAdapter) ||
    !TRUSTED_STATE_STORES.has(stateStore) ||
    typeof clock !== "function"
  ) {
    throw new Error("FLEET_CLEANUP_EXECUTOR_CONFIGURATION_INVALID");
  }
  const publicKey = snapshotPublicKey(inventoryPublicKey);

  function validateAuthoritativeInputs(issuance, plan) {
    const nowMs = trustedTime(clock);
    const now = new Date(nowMs).toISOString();
    const issuanceValidation = validateFleetMigrationAuthoritativeInventory(
      issuance,
      publicKey,
      { now },
    );
    if (
      !issuanceValidation.ok ||
      issuance.authoritative !== true ||
      issuance.readyForPlanning !== true ||
      issuance.inventory.organization.id !== organizationId ||
      issuance.inventory.organization.login !== ORGANIZATION_LOGIN ||
      issuance.inventory.coverage.installationId !== installationId ||
      issuance.inventory.lineage.mode !== "BOOTSTRAP"
    ) {
      throw new Error("FLEET_CLEANUP_AUTHORITATIVE_INVENTORY_INVALID");
    }
    let trustedInventoryBinding;
    try {
      trustedInventoryBinding = loadTrustedFleetMigrationInventoryBinding({
        inventory: issuance.inventory,
        trustedInventoryKeys: {
          [fleetMigrationInventoryIssuerContract.keyId]: publicKey,
        },
        now,
      });
    } catch {
      throw new Error("FLEET_CLEANUP_TRUSTED_INVENTORY_BINDING_INVALID");
    }
    const planValidation = validateFleetMigrationPlan(plan, {
      inventory: issuance.inventory,
      trustedInventoryBinding,
      now,
    });
    if (
      !planValidation.ok ||
      plan.mode !== "PLAN_ONLY" ||
      plan.executionAllowed !== false ||
      plan.outcome !== "READY_FOR_REVIEW" ||
      plan.reasonCodes.length !== 0 ||
      plan.inventory.inventoryId !== issuance.inventory.inventoryId ||
      plan.inventory.binding.inventoryDigest !== issuance.inventoryDigest
    ) {
      throw new Error("FLEET_CLEANUP_PLAN_INVALID");
    }
    return nowMs;
  }

  async function readAuthority(context) {
    let value;
    try {
      value = await stateStore.readAuthority({
        contract: STATE_AUTHORITY_CONTRACT,
        organizationId,
        installationId,
        repositoryId: context.binding.repositoryId,
        fullName: context.binding.fullName,
        sourceSha: context.binding.sourceSha,
        chainHeadDigest: context.binding.chainHeadDigest,
        inventoryDigest: context.binding.inventoryDigest,
        planDigest: context.binding.planDigest,
        readMode: "CURRENT_PUBLIC_STATE",
      });
    } catch {
      throw new Error("FLEET_CLEANUP_STATE_AUTHORITY_READBACK_FAILED");
    }
    const nowMs = trustedTime(clock);
    if (!validateAuthorityReadback(value, context, nowMs)) {
      throw new Error("FLEET_CLEANUP_STATE_AUTHORITY_MISMATCH");
    }
    return deepFreeze(value);
  }

  async function readGuard(
    context,
    knownCommitSha = null,
    allowExpectedPullRequest = false,
    requireExpectedPullRequest = false,
  ) {
    let value;
    try {
      value = await githubAdapter.readMutationGuard({
        contract: MUTATION_GUARD_CONTRACT,
        organizationId,
        installationId,
        repositoryId: context.binding.repositoryId,
        fullName: context.binding.fullName,
        defaultRef: context.repository.sourceRef,
        sourceSha: context.binding.sourceSha,
        treeSha: context.treeSha,
        issueNumber: context.binding.issueNumber,
        approvalScopeDigest: context.approvalScopeDigest,
        expectedBlobs: expectedBlobReadbacks(context),
        expectedHeadRef: context.branchName,
        expectedPullRequestOperationId: context.operationIds.CREATE_PR,
      });
    } catch {
      throw new Error("FLEET_CLEANUP_MUTATION_GUARD_READBACK_FAILED");
    }
    const nowMs = trustedTime(clock);
    if (
      !validateMutationGuard(
        value,
        context,
        nowMs,
        knownCommitSha,
        allowExpectedPullRequest,
        requireExpectedPullRequest,
      )
    ) {
      throw new Error("FLEET_CLEANUP_MUTATION_GUARD_MISMATCH");
    }
    return deepFreeze(value);
  }

  async function loadReplacementContents(context) {
    const contents = new Map();
    try {
      for (const change of context.changes) {
        if (change.operation !== "REWRITE") continue;
        let readback;
        try {
          readback = await githubAdapter.readReplacementBlob({
            contract: REPLACEMENT_READBACK_CONTRACT,
            repositoryId: context.binding.repositoryId,
            fullName: context.binding.fullName,
            sourceSha: context.binding.sourceSha,
            path: change.path,
            replacementDigest: change.replacementDigest,
            replacementBindingDigest: change.replacementBindingDigest,
            planDigest: context.binding.planDigest,
          });
        } catch {
          throw new Error("FLEET_CLEANUP_REPLACEMENT_READBACK_FAILED");
        }
        const { content, ...metadata } = readback;
        const nowMs = trustedTime(clock);
        if (
          !exactKeys(metadata, [
            "contract",
            "fullName",
            "observedAt",
            "path",
            "planDigest",
            "readbackId",
            "replacementBindingDigest",
            "replacementDigest",
            "repositoryId",
            "sourceSha",
          ]) ||
          metadata.contract !== REPLACEMENT_READBACK_CONTRACT ||
          metadata.repositoryId !== context.binding.repositoryId ||
          metadata.fullName !== context.binding.fullName ||
          metadata.sourceSha !== context.binding.sourceSha ||
          metadata.path !== change.path ||
          metadata.planDigest !== context.binding.planDigest ||
          metadata.replacementDigest !== change.replacementDigest ||
          metadata.replacementBindingDigest !== change.replacementBindingDigest ||
          !EXECUTION_ID_PATTERN.test(metadata.readbackId ?? "") ||
          !validFreshTime(metadata.observedAt, nowMs) ||
          !Buffer.isBuffer(content) ||
          content.length === 0 ||
          content.length > 1024 * 1024 ||
          sha256(content) !== change.replacementDigest
        ) {
          if (Buffer.isBuffer(content)) content.fill(0);
          throw new Error("FLEET_CLEANUP_REPLACEMENT_READBACK_MISMATCH");
        }
        const text = content.toString("utf8");
        if (
          Buffer.from(text, "utf8").compare(content) !== 0 ||
          PRIVATE_SURFACE_VALUE_PATTERNS.some((pattern) => pattern.test(text))
        ) {
          content.fill(0);
          throw new Error("FLEET_CLEANUP_REPLACEMENT_PRIVATE_SURFACE_REJECTED");
        }
        contents.set(change.path, content);
      }
      return contents;
    } catch (error) {
      for (const content of contents.values()) content.fill(0);
      throw error;
    }
  }

  async function readStep(kind, context, commitSha, replacementContents) {
    const common = {
      contract: MUTATION_READBACK_CONTRACT,
      repositoryId: context.binding.repositoryId,
      fullName: context.binding.fullName,
      operationId: context.operationIds[kind],
    };
    let value;
    try {
      if (kind === "CREATE_COMMIT") {
        value = await githubAdapter.readCommit({
          ...common,
          parentSha: context.binding.sourceSha,
          sourceTreeSha: context.treeSha,
          mutationsDigest: mutationsDigest(context, replacementContents),
        });
      } else if (kind === "CREATE_REF") {
        value = await githubAdapter.readRef({
          ...common,
          ref: context.branchRef,
          commitSha,
        });
      } else {
        value = await githubAdapter.readPullRequest({
          ...common,
          baseRef: context.repository.sourceRef.slice("refs/heads/".length),
          headRef: context.branchName,
          headSha: commitSha,
          issueNumber: context.binding.issueNumber,
        });
      }
    } catch {
      throw new Error(`FLEET_CLEANUP_${kind}_READBACK_FAILED`);
    }
    const nowMs = trustedTime(clock);
    if (value?.state === "ABSENT" || value?.state === "UNKNOWN") {
      if (!validateAbsentReadback(value, context, kind, nowMs)) {
        throw new Error(`FLEET_CLEANUP_${kind}_READBACK_MISMATCH`);
      }
      return { state: value.state, value };
    }
    const valid =
      kind === "CREATE_COMMIT"
        ? validateCommitReadback(value, context, nowMs, replacementContents)
        : kind === "CREATE_REF"
          ? validateRefReadback(value, context, nowMs, commitSha)
          : validatePullRequestReadback(value, context, nowMs, commitSha);
    if (!valid) throw new Error(`FLEET_CLEANUP_${kind}_READBACK_MISMATCH`);
    return { state: "FOUND", value };
  }

  function stableReceipt(kind, value) {
    if (kind === "CREATE_COMMIT") return stableCommitReceipt(value);
    if (kind === "CREATE_REF") return stableRefReceipt(value);
    return stablePullRequestReceipt(value);
  }

  async function transition(
    context,
    reservation,
    ledger,
    leaseToken,
    kind,
    nextStepState,
    receipt = null,
  ) {
    assertReservationLive(reservation, trustedTime(clock));
    const step = ledger.steps.find((item) => item.kind === kind);
    const digest = receipt === null ? null : sha256(canonicalJson(receipt));
    const allowedTransition = new Set([
      "PENDING:DISPATCHED",
      "PENDING:CONFIRMED",
      "DISPATCHED:RESULT_UNKNOWN",
      "DISPATCHED:CONFIRMED",
      "RESULT_UNKNOWN:CONFIRMED",
    ]).has(`${step?.state}:${nextStepState}`);
    if (
      !allowedTransition ||
      (nextStepState === "CONFIRMED") !== (receipt !== null)
    ) {
      throw new Error("FLEET_CLEANUP_LEDGER_TRANSITION_INVALID");
    }
    let next;
    try {
      next = await stateStore.transitionStep({
        ...context.binding,
        contract: LEDGER_CONTRACT,
        reservationId: reservation.reservationId,
        expectedStateGeneration: reservation.expectedStateGeneration,
        reservedStateGeneration: reservation.reservedStateGeneration,
        expectedExecutionGeneration: ledger.executionGeneration,
        expiresAt: reservation.expiresAt,
        leaseToken,
        kind,
        operationId: context.operationIds[kind],
        expectedStepState: step.state,
        nextStepState,
        receipt,
        receiptDigest: digest,
      });
    } catch {
      throw new Error("FLEET_CLEANUP_LEDGER_TRANSITION_FAILED");
    }
    const nowMs = trustedTime(clock);
    if (
      !validateLedger(next, context, reservation, nowMs) ||
      next.executionGeneration !== ledger.executionGeneration + 1
    ) {
      throw new Error("FLEET_CLEANUP_LEDGER_TRANSITION_INVALID");
    }
    const nextStep = next.steps.find((item) => item.kind === kind);
    if (
      nextStep.state !== nextStepState ||
      nextStep.receiptDigest !== digest
    ) {
      throw new Error("FLEET_CLEANUP_LEDGER_TRANSITION_INVALID");
    }
    for (const previousStep of ledger.steps) {
      if (previousStep.kind === kind) continue;
      const observedStep = next.steps.find(
        (candidate) => candidate.kind === previousStep.kind,
      );
      if (canonicalJson(observedStep) !== canonicalJson(previousStep)) {
        throw new Error("FLEET_CLEANUP_LEDGER_TRANSITION_INVALID");
      }
    }
    return deepFreeze(next);
  }

  async function createStepMutation(
    kind,
    context,
    commitSha,
    replacementContents,
  ) {
    if (kind === "CREATE_COMMIT") {
      const mutations = context.changes.map((change) => ({
        operation: change.operation,
        path: change.path,
        expectedMode: change.gitEntry.mode,
        expectedBlobSha: change.gitEntry.objectSha,
        expectedContentDigest: change.contentDigest,
        replacementDigest: change.replacementDigest,
        replacementBindingDigest: change.replacementBindingDigest,
        content:
          change.operation === "REWRITE"
            ? Buffer.from(replacementContents.get(change.path))
            : null,
      }));
      try {
        await githubAdapter.createCommit({
          contract: EXECUTION_CONTRACT,
          repositoryId: context.binding.repositoryId,
          fullName: context.binding.fullName,
          operationId: context.operationIds[kind],
          parentSha: context.binding.sourceSha,
          sourceTreeSha: context.treeSha,
          mutationsDigest: mutationsDigest(context, replacementContents),
          message: [
            "P7 중앙 운영 설정 cleanup 적용",
            "",
            `Seorilabs-Operation: ${context.operationIds[kind]}`,
            `Seorilabs-Plan: ${context.binding.planDigest}`,
          ].join("\n"),
          mutations,
        });
      } finally {
        for (const mutation of mutations) {
          if (Buffer.isBuffer(mutation.content)) mutation.content.fill(0);
        }
      }
      return;
    }
    if (kind === "CREATE_REF") {
      await githubAdapter.createRef({
        contract: EXECUTION_CONTRACT,
        repositoryId: context.binding.repositoryId,
        fullName: context.binding.fullName,
        operationId: context.operationIds[kind],
        ref: context.branchRef,
        commitSha,
        expectedAbsent: true,
      });
      return;
    }
    const body = pullRequestBody(context);
    await githubAdapter.createPullRequest({
      contract: EXECUTION_CONTRACT,
      repositoryId: context.binding.repositoryId,
      fullName: context.binding.fullName,
      operationId: context.operationIds[kind],
      baseRef: context.repository.sourceRef.slice("refs/heads/".length),
      baseSha: context.binding.sourceSha,
      headRef: context.branchName,
      headSha: commitSha,
      title: pullRequestTitle(),
      body,
      bodyDigest: sha256(body),
      issueNumber: context.binding.issueNumber,
      draft: false,
      expectedOpenAutonomousReadyPullRequestCount: 0,
    });
  }

  async function readConfirmedStep(
    kind,
    context,
    ledger,
    commitSha,
    replacementContents,
  ) {
    const step = ledger.steps.find((item) => item.kind === kind);
    if (step?.state !== "CONFIRMED") {
      throw new Error("FLEET_CLEANUP_CONFIRMED_STEP_MISSING");
    }
    const readback = await readStep(
      kind,
      context,
      commitSha,
      replacementContents,
    );
    if (readback.state !== "FOUND") {
      throw new Error("FLEET_CLEANUP_CONFIRMED_STEP_MISSING");
    }
    const receipt = stableReceipt(kind, readback.value);
    if (sha256(canonicalJson(receipt)) !== step.receiptDigest) {
      throw new Error("FLEET_CLEANUP_CONFIRMED_STEP_MISMATCH");
    }
    return { receipt, readback: readback.value };
  }

  async function resolveStep(
    kind,
    context,
    issuance,
    plan,
    reservation,
    ledger,
    leaseToken,
    commitSha,
    replacementContents,
  ) {
    const step = ledger.steps.find((item) => item.kind === kind);
    if (step.state === "CONFIRMED") {
      const confirmed = await readConfirmedStep(
        kind,
        context,
        ledger,
        commitSha,
        replacementContents,
      );
      return { ledger, ...confirmed };
    }

    assertReservationLive(reservation, trustedTime(clock));
    validateAuthoritativeInputs(issuance, plan);
    await readGuard(context, commitSha);
    validateAuthoritativeInputs(issuance, plan);
    let readback = await readStep(
      kind,
      context,
      commitSha,
      replacementContents,
    );
    if (readback.state === "FOUND") {
      const receipt = stableReceipt(kind, readback.value);
      const nextLedger = await transition(
        context,
        reservation,
        ledger,
        leaseToken,
        kind,
        "CONFIRMED",
        receipt,
      );
      return { ledger: nextLedger, receipt, readback: readback.value };
    }
    if (readback.state === "UNKNOWN") {
      throw new Error(`FLEET_CLEANUP_${kind}_RESULT_UNKNOWN`);
    }
    if (["DISPATCHED", "RESULT_UNKNOWN"].includes(step.state)) {
      throw new Error(`FLEET_CLEANUP_${kind}_RESULT_UNKNOWN`);
    }
    let currentLedger = await transition(
      context,
      reservation,
      ledger,
      leaseToken,
      kind,
      "DISPATCHED",
    );

    assertReservationLive(reservation, trustedTime(clock));
    validateAuthoritativeInputs(issuance, plan);
    await readGuard(context, commitSha);
    validateAuthoritativeInputs(issuance, plan);
    assertReservationLive(reservation, trustedTime(clock));
    try {
      await createStepMutation(
        kind,
        context,
        commitSha,
        replacementContents,
      );
    } catch {
      try {
        currentLedger = await transition(
          context,
          reservation,
          currentLedger,
          leaseToken,
          kind,
          "RESULT_UNKNOWN",
        );
      } catch {
        // The durable DISPATCHED state is itself a result-unknown stop gate.
      }
      throw new Error(`FLEET_CLEANUP_${kind}_RESULT_UNKNOWN`);
    }

    readback = await readStep(
      kind,
      context,
      commitSha,
      replacementContents,
    );
    if (readback.state !== "FOUND") {
      try {
        currentLedger = await transition(
          context,
          reservation,
          currentLedger,
          leaseToken,
          kind,
          "RESULT_UNKNOWN",
        );
      } catch {
        // Keep the last durable state and stop without repeating the mutation.
      }
      throw new Error(`FLEET_CLEANUP_${kind}_RESULT_UNKNOWN`);
    }
    const receipt = stableReceipt(kind, readback.value);
    currentLedger = await transition(
      context,
      reservation,
      currentLedger,
      leaseToken,
      kind,
      "CONFIRMED",
      receipt,
    );
    return { ledger: currentLedger, receipt, readback: readback.value };
  }

  return Object.freeze({
    async execute(issuanceInput, planInput, requestInput) {
      const issuance = clonePublic(
        issuanceInput,
        "FLEET_CLEANUP_AUTHORITATIVE_INVENTORY_INVALID",
      );
      const plan = clonePublic(planInput, "FLEET_CLEANUP_PLAN_INVALID");
      const request = clonePublic(
        requestInput,
        "FLEET_CLEANUP_EXECUTION_REQUEST_INVALID",
      );
      if (!validExecutionRequest(request)) {
        throw new Error("FLEET_CLEANUP_EXECUTION_REQUEST_INVALID");
      }
      validateAuthoritativeInputs(issuance, plan);
      const context = buildExecutionContext(
        issuance,
        plan,
        request,
        organizationId,
        installationId,
      );
      await readGuard(context, null, true);
      validateAuthoritativeInputs(issuance, plan);
      const authority = await readAuthority(context);
      validateAuthoritativeInputs(issuance, plan);
      const claimGuard = await readGuard(context, null, true);
      const claimNowMs = validateAuthoritativeInputs(issuance, plan);
      if (!validateAuthorityReadback(authority, context, claimNowMs)) {
        throw new Error("FLEET_CLEANUP_STATE_AUTHORITY_MISMATCH");
      }
      if (!validateMutationGuard(claimGuard, context, claimNowMs, null, true)) {
        throw new Error("FLEET_CLEANUP_MUTATION_GUARD_MISMATCH");
      }
      let reservation;
      try {
        reservation = await stateStore.reserveExecution({
          ...context.binding,
          contract: RESERVATION_CONTRACT,
          authorityRevision: authority.authorityRevision,
          authorityReadbackId: authority.readbackId,
          expectedStateGeneration: authority.generation,
          requestedExpiresAt: new Date(
            claimNowMs + MAX_RESERVATION_MS,
          ).toISOString(),
          steps: STEP_KINDS.map((kind) => ({
            kind,
            operationId: context.operationIds[kind],
          })),
        });
      } catch {
        throw new Error("FLEET_CLEANUP_EXECUTION_CLAIM_FAILED");
      }
      const nowMs = trustedTime(clock);
      if (!validateReservation(reservation, context, authority, nowMs)) {
        if (Buffer.isBuffer(reservation?.leaseToken)) {
          reservation.leaseToken.fill(0);
        }
        throw new Error("FLEET_CLEANUP_EXECUTION_CLAIM_INVALID");
      }

      if (reservation.state === "COMPLETED") {
        const ledger = await stateStore.readExecution({
          ...context.binding,
          contract: LEDGER_CONTRACT,
          reservationId: reservation.reservationId,
        });
        if (
          !validateLedger(ledger, context, reservation, trustedTime(clock), {
            completed: true,
          }) ||
          ledger.executionGeneration !== reservation.executionGeneration ||
          ledger.receiptDigest !== reservation.receiptDigest
        ) {
          throw new Error("FLEET_CLEANUP_COMPLETED_LEDGER_INVALID");
        }
        const replacementContents = await loadReplacementContents(context);
        try {
          const commitResult = await readConfirmedStep(
            "CREATE_COMMIT",
            context,
            ledger,
            null,
            replacementContents,
          );
          const replayGuard = await readGuard(
            context,
            commitResult.readback.commitSha,
            false,
            true,
          );
          await readConfirmedStep(
            "CREATE_REF",
            context,
            ledger,
            commitResult.readback.commitSha,
            replacementContents,
          );
          const prResult = await readConfirmedStep(
            "CREATE_PR",
            context,
            ledger,
            commitResult.readback.commitSha,
            replacementContents,
          );
          const replayNowMs = trustedTime(clock);
          if (
            !validateMutationGuard(
              replayGuard,
              context,
              replayNowMs,
              commitResult.readback.commitSha,
              false,
              true,
            )
          ) {
            throw new Error("FLEET_CLEANUP_MUTATION_GUARD_MISMATCH");
          }
          validateAuthoritativeInputs(issuance, plan);
          const receipt = buildFinalReceipt(
            context,
            ledger,
            commitResult.readback,
            prResult.readback,
            reservation.stateGeneration,
            reservation.executionGeneration,
            true,
          );
          if (receipt.receiptDigest !== reservation.receiptDigest) {
            throw new Error("FLEET_CLEANUP_COMPLETED_RECEIPT_MISMATCH");
          }
          return receipt;
        } finally {
          for (const content of replacementContents.values()) content.fill(0);
        }
      }

      const leaseToken = reservation.leaseToken;
      try {
        let ledger = await stateStore.readExecution({
          ...context.binding,
          contract: LEDGER_CONTRACT,
          reservationId: reservation.reservationId,
        });
        if (
          !validateLedger(ledger, context, reservation, trustedTime(clock)) ||
          ledger.executionGeneration !== reservation.executionGeneration
        ) {
          throw new Error("FLEET_CLEANUP_LEDGER_READBACK_INVALID");
        }
        const replacementContents = await loadReplacementContents(context);
        try {
          const commitResult = await resolveStep(
            "CREATE_COMMIT",
            context,
            issuance,
            plan,
            reservation,
            ledger,
            leaseToken,
            null,
            replacementContents,
          );
          ledger = commitResult.ledger;
          const commitSha = commitResult.readback.commitSha;
          const refResult = await resolveStep(
            "CREATE_REF",
            context,
            issuance,
            plan,
            reservation,
            ledger,
            leaseToken,
            commitSha,
            replacementContents,
          );
          ledger = refResult.ledger;
          const prResult = await resolveStep(
            "CREATE_PR",
            context,
            issuance,
            plan,
            reservation,
            ledger,
            leaseToken,
            commitSha,
            replacementContents,
          );
          ledger = prResult.ledger;
          if (
            ledger.state !== "READY_TO_COMPLETE" ||
            ledger.steps.some(({ state }) => state !== "CONFIRMED")
          ) {
            throw new Error("FLEET_CLEANUP_LEDGER_INCOMPLETE");
          }
          validateAuthoritativeInputs(issuance, plan);
          const completionGuard = await readGuard(
            context,
            commitSha,
            false,
            true,
          );
          const finalCommitResult = await readConfirmedStep(
            "CREATE_COMMIT",
            context,
            ledger,
            null,
            replacementContents,
          );
          const finalCommitSha = finalCommitResult.readback.commitSha;
          await readConfirmedStep(
            "CREATE_REF",
            context,
            ledger,
            finalCommitSha,
            replacementContents,
          );
          const finalPrResult = await readConfirmedStep(
            "CREATE_PR",
            context,
            ledger,
            finalCommitSha,
            replacementContents,
          );
          const completionNowMs = trustedTime(clock);
          if (
            !validateMutationGuard(
              completionGuard,
              context,
              completionNowMs,
              finalCommitSha,
              false,
              true,
            )
          ) {
            throw new Error("FLEET_CLEANUP_MUTATION_GUARD_MISMATCH");
          }
          validateAuthoritativeInputs(issuance, plan);
          const receipt = buildFinalReceipt(
            context,
            ledger,
            finalCommitResult.readback,
            finalPrResult.readback,
            reservation.reservedStateGeneration,
            ledger.executionGeneration + 1,
            false,
          );
          let completion;
          assertReservationLive(reservation, trustedTime(clock));
          try {
            completion = await stateStore.completeAndConsume({
              ...context.binding,
              contract: COMPLETION_CONTRACT,
              reservationId: reservation.reservationId,
              expectedStateGeneration: reservation.expectedStateGeneration,
              reservedStateGeneration: reservation.reservedStateGeneration,
              expectedExecutionGeneration: ledger.executionGeneration,
              expiresAt: reservation.expiresAt,
              leaseToken,
              receipt: structuredClone(receipt),
              receiptDigest: receipt.receiptDigest,
            });
          } catch {
            throw new Error("FLEET_CLEANUP_COMPLETION_FAILED");
          }
          if (
            !validateCompletion(
              completion,
              context,
              reservation,
              ledger,
              receipt.receiptDigest,
            )
          ) {
            throw new Error("FLEET_CLEANUP_COMPLETION_INVALID");
          }
          return receipt;
        } finally {
          for (const content of replacementContents.values()) content.fill(0);
        }
      } finally {
        leaseToken.fill(0);
      }
    },
  });
}

export function validateFleetCleanupExecutionReceipt(receipt) {
  try {
    const snapshot = clonePublic(receipt, "FLEET_CLEANUP_RECEIPT_INVALID");
    const schemaValid = Boolean(validateReceiptSchema(snapshot));
    const expectedOperationIds = schemaValid
      ? fleetCleanupOperationIds(
          fleetCleanupExecutionKey({
            issuanceDigest: snapshot.issuanceDigest,
            inventoryDigest: snapshot.inventoryDigest,
            planDigest: snapshot.planDigest,
            repositoryId: snapshot.repository.id,
            sourceSha: snapshot.repository.sourceSha,
          }),
        )
      : null;
    const semanticValid =
      schemaValid &&
      snapshot.branch.ref === `refs/heads/${snapshot.pullRequest.headRef}` &&
      snapshot.branch.commitSha === snapshot.pullRequest.headSha &&
      snapshot.repository.defaultRef ===
        `refs/heads/${snapshot.pullRequest.baseRef}` &&
      snapshot.pullRequest.url ===
        `https://github.com/${snapshot.repository.fullName}/pull/${snapshot.pullRequest.number}` &&
      snapshot.branch.ref ===
        `refs/heads/seori/fleet-cleanup/${snapshot.repository.id}/${snapshot.planDigest.slice(7, 19)}` &&
      canonicalJson(snapshot.ledger.steps.map(({ kind }) => kind)) ===
        canonicalJson(STEP_KINDS) &&
      snapshot.ledger.steps.every(
        ({ kind, operationId }) => operationId === expectedOperationIds[kind],
      ) &&
      snapshot.ledger.digest === ledgerStepsDigest(snapshot.ledger) &&
      receiptDigest(snapshot) === snapshot.receiptDigest;
    return deepFreeze({
      ok: semanticValid,
      diagnostics: semanticValid ? [] : ["FLEET_CLEANUP_RECEIPT_INVALID"],
    });
  } catch {
    return deepFreeze({
      ok: false,
      diagnostics: ["FLEET_CLEANUP_RECEIPT_INVALID"],
    });
  }
}

export const trustedFleetCleanupExecutorContract = deepFreeze({
  contract: EXECUTION_CONTRACT,
  receiptSchema: "fleet-cleanup-execution-receipt.schema.json",
  mode: "READY_PR_ONLY",
  sourcePlanMode: "PLAN_ONLY",
  sourcePlanExecutionAllowed: false,
  supportedLineageMode: "BOOTSTRAP",
  stepOrder: STEP_KINDS,
  maximumReservationSeconds: MAX_RESERVATION_MS / 1000,
  maximumReadbackAgeSeconds: MAX_READBACK_AGE_MS / 1000,
  maximumRuntimeApprovalSeconds: MAX_APPROVAL_TTL_MS / 1000,
  repositoryReadyPullRequestLimit: 1,
  authoritativeInventoryRequired: true,
  trustedInventoryBindingRequired: true,
  durableStateAuthorityCasRequired: true,
  stateAuthorityRepositoryPlanBindingRequired: true,
  leaseExpiryRevalidatedBeforeMutation: true,
  readbackBeforeMutationRequired: true,
  resultUnknownRetryAllowed: false,
  directDefaultBranchMutationAllowed: false,
  refDeletionAllowed: false,
  publicFieldsOnly: true,
  githubAppCredentialId: "shared/github/fleet-app",
});
