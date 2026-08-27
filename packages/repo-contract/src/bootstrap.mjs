import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  generateOrgContractCaller,
  validateOrgContractCaller,
} from "./fleet.mjs";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE_PLAN_SCHEMA = resolve(
  PACKAGE_ROOT,
  "../../contracts/fleet-bootstrap-plan.schema.json",
);
const BUNDLED_PLAN_SCHEMA = resolve(
  PACKAGE_ROOT,
  ".generated/contracts/fleet-bootstrap-plan.schema.json",
);
const PLAN_SCHEMA_PATH = existsSync(WORKSPACE_PLAN_SCHEMA)
  ? WORKSPACE_PLAN_SCHEMA
  : BUNDLED_PLAN_SCHEMA;
const WEBHOOK_CREDENTIAL_ID = "shared/github/fleet-app-webhook";
const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const FULL_NAME_PATTERN = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const BRANCH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,255}$/u;
const ORGANIZATION_LOGIN = "seorilabs";
const DEFAULT_BRANCH = "main";
const DEFAULT_REF = "refs/heads/main";
const PROFILE_BY_WORKFLOW = Object.freeze({
  ".github/workflows/rn-static-checks-v2.yml": "react-native",
  ".github/workflows/godot-checks-v2.yml": "godot",
});
const MANAGED_PROPERTIES = Object.freeze({
  "fleet-managed": "true",
  "fleet-ruleset": "evaluate",
});
let planValidatorPromise;

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

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function planValidator() {
  planValidatorPromise ??= readFile(PLAN_SCHEMA_PATH, "utf8").then((text) => {
    const schema = JSON.parse(text);
    return new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
  });
  return planValidatorPromise;
}

export async function validateFleetBootstrapPlan(value) {
  let snapshot;
  try {
    snapshot = structuredClone(value);
  } catch {
    return { ok: false, diagnostics: ["PLAN_NOT_CLONEABLE"] };
  }
  try {
    const validate = await planValidator();
    const ok = validate(snapshot);
    return {
      ok,
      diagnostics: ok
        ? []
        : [...new Set((validate.errors ?? []).map(({ keyword }) => keyword))]
            .sort()
            .map((keyword) => `PLAN_SCHEMA_${keyword.toUpperCase()}`),
    };
  } catch {
    return { ok: false, diagnostics: ["PLAN_SCHEMA_UNAVAILABLE"] };
  }
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function safeIntegerString(value) {
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  const stringValue = String(value);
  return REPOSITORY_ID_PATTERN.test(stringValue) ? stringValue : undefined;
}

function normalizedRepository(payload, { organizationId, installationId }) {
  const repository = payload?.repository;
  const payloadOrganization = payload?.organization;
  const repositoryId = safeIntegerString(repository?.id);
  const ownerId = safeIntegerString(repository?.owner?.id);
  const observedOrganizationId = safeIntegerString(payloadOrganization?.id);
  const observedInstallationId = safeIntegerString(payload?.installation?.id);
  if (
    !repositoryId ||
    !FULL_NAME_PATTERN.test(repository?.full_name ?? "") ||
    repository?.owner?.login !== ORGANIZATION_LOGIN ||
    ownerId !== organizationId ||
    payloadOrganization?.login !== ORGANIZATION_LOGIN ||
    observedOrganizationId !== organizationId ||
    observedInstallationId !== installationId ||
    typeof repository?.private !== "boolean" ||
    typeof repository?.archived !== "boolean" ||
    (repository?.default_branch !== null &&
      !BRANCH_PATTERN.test(repository?.default_branch ?? ""))
  ) {
    throw new Error("WEBHOOK_REPOSITORY_IDENTITY_INVALID");
  }
  return deepFreeze({
    id: repositoryId,
    fullName: repository.full_name,
    private: repository.private,
    archived: repository.archived,
    defaultBranch: repository.default_branch,
  });
}

function normalizeEvent(eventName, payload, configuration) {
  const repository = normalizedRepository(payload, configuration);
  if (eventName === "repository") {
    if (!["created", "renamed", "archived", "unarchived"].includes(payload.action)) {
      return { relevant: false, repository, reason: "REPOSITORY_ACTION_IGNORED" };
    }
    return {
      relevant: true,
      repository,
      action: payload.action,
      pushedSha: undefined,
    };
  }
  if (eventName === "push") {
    if (payload.ref !== DEFAULT_REF) {
      return { relevant: false, repository, reason: "NON_DEFAULT_PUSH_IGNORED" };
    }
    if (!SHA_PATTERN.test(payload.after ?? "")) {
      throw new Error("WEBHOOK_PUSH_SHA_INVALID");
    }
    return {
      relevant: true,
      repository,
      action: "default_push",
      pushedSha: payload.after,
    };
  }
  throw new Error("WEBHOOK_EVENT_UNSUPPORTED");
}

function validateReadback(readback, expected, pushedSha) {
  if (
    !exactKeys(readback, [
      "archived",
      "defaultBranch",
      "fullName",
      "organizationId",
      "private",
      "repositoryId",
      "sourceSha",
    ]) ||
    readback.repositoryId !== expected.id ||
    readback.fullName !== expected.fullName ||
    readback.organizationId === undefined ||
    readback.private !== expected.private ||
    readback.archived !== expected.archived ||
    readback.defaultBranch !== expected.defaultBranch ||
    (readback.sourceSha !== null && !SHA_PATTERN.test(readback.sourceSha ?? "")) ||
    (pushedSha !== undefined && readback.sourceSha !== pushedSha)
  ) {
    throw new Error("REPOSITORY_READBACK_MISMATCH");
  }
  return Object.freeze(structuredClone(readback));
}

function validateObservedState(value) {
  if (
    !exactKeys(value, [
      "autonomousOpenPullRequestCount",
      "bootstrapPullRequest",
      "callerDigest",
      "customProperties",
      "environments",
    ]) ||
    !Number.isSafeInteger(value.autonomousOpenPullRequestCount) ||
    value.autonomousOpenPullRequestCount < 0 ||
    value.customProperties === null ||
    typeof value.customProperties !== "object" ||
    Array.isArray(value.customProperties) ||
    !Object.entries(value.customProperties).every(
      ([key, item]) =>
        /^[A-Za-z0-9_-]{1,75}$/u.test(key) && typeof item === "string",
    ) ||
    !Array.isArray(value.environments) ||
    !value.environments.every(
      (item) => typeof item === "string" && /^[A-Za-z0-9_-]{1,255}$/u.test(item),
    ) ||
    (value.callerDigest !== null &&
      !/^sha256:[0-9a-f]{64}$/u.test(value.callerDigest ?? ""))
  ) {
    throw new Error("REPOSITORY_OBSERVED_STATE_INVALID");
  }
  const pullRequest = value.bootstrapPullRequest;
  if (
    pullRequest !== null &&
    (!exactKeys(pullRequest, ["contentDigest", "headRef", "number", "sourceSha"]) ||
      !Number.isSafeInteger(pullRequest.number) ||
      pullRequest.number < 1 ||
      !/^seori\/fleet-bootstrap\/[1-9][0-9]{0,31}$/u.test(pullRequest.headRef) ||
      !SHA_PATTERN.test(pullRequest.sourceSha ?? "") ||
      !/^sha256:[0-9a-f]{64}$/u.test(pullRequest.contentDigest ?? ""))
  ) {
    throw new Error("REPOSITORY_OBSERVED_STATE_INVALID");
  }
  return structuredClone(value);
}

function operation(kind, repositoryId, payload) {
  const operationPayload = structuredClone(payload);
  return Object.freeze({
    kind,
    idempotencyKey: sha256(
      canonicalJson({ kind, repositoryId, payload: operationPayload }),
    ),
    payload: deepFreeze(operationPayload),
  });
}

function baseResult({ deliveryId, repository, sourceSha, action, outcome, reason }) {
  return {
    schemaVersion: 1,
    deliveryId,
    action,
    outcome,
    reason: reason ?? null,
    repository: {
      id: repository.id,
      fullName: repository.fullName,
      sourceSha: sourceSha ?? null,
    },
    operations: [],
  };
}

function needsInputOperations(result, reason) {
  result.operations.push(
    operation("control-plane.repository.observe", result.repository.id, {
      repository: result.repository,
      state: "needs_input",
      reason,
    }),
  );
  return deepFreeze(result);
}

function expectedProperties(profile, state) {
  return {
    ...MANAGED_PROPERTIES,
    "fleet-profile": profile,
    "fleet-state": state,
  };
}

function propertiesMatch(observed, expected) {
  return Object.entries(expected).every(([key, value]) => observed[key] === value);
}

function callerProfile(text) {
  const match = text.match(
    /uses:\s+seorilabs\/\.github\/(\.github\/workflows\/[a-z0-9-]+\.yml)@[0-9a-f]{40}/u,
  );
  return match ? PROFILE_BY_WORKFLOW[match[1]] : undefined;
}

async function readyPlan({
  deliveryId,
  action,
  repository,
  sourceSha,
  approvedBundleBinding,
  callerBinding,
  readObservedState,
}) {
  const repositoryContext = {
    repositoryId: repository.id,
    fullName: repository.fullName,
    sourceSha,
  };
  const caller = await generateOrgContractCaller({
    approvedBundleBinding,
    callerBinding,
  });
  const validation = await validateOrgContractCaller(caller, {
    approvedBundleBinding,
    callerBinding,
    repositoryContext,
  });
  const profile = callerProfile(caller);
  if (!validation.ok || !profile || validation.profile !== profile) {
    throw new Error("GENERATED_CALLER_UNTRUSTED");
  }
  const callerDigest = sha256(caller);
  let observedReadback;
  try {
    observedReadback = await readObservedState(structuredClone(repositoryContext));
  } catch {
    throw new Error("REPOSITORY_OBSERVED_STATE_FAILED");
  }
  const observed = validateObservedState(observedReadback);
  const result = baseResult({
    deliveryId,
    repository,
    sourceSha,
    action,
    outcome: "READY",
  });
  result.operations.push(
    operation("control-plane.repository.observe", repository.id, {
      repository: result.repository,
      state: "active",
      profile,
    }),
  );

  const properties = expectedProperties(profile, "active");
  if (!propertiesMatch(observed.customProperties, properties)) {
    result.operations.push(
      operation("github.custom-properties.ensure", repository.id, {
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        properties,
      }),
    );
  }
  if (!observed.environments.includes("internal")) {
    result.operations.push(
      operation("github.environment.ensure", repository.id, {
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        name: "internal",
        protectedBranches: true,
      }),
    );
  }
  if (observed.callerDigest === callerDigest) {
    return result;
  }

  const pullRequest = observed.bootstrapPullRequest;
  if (pullRequest) {
    if (
      pullRequest.contentDigest !== callerDigest ||
      pullRequest.sourceSha !== sourceSha
    ) {
      result.operations.push(
        operation("github.bootstrap-pull-request.update", repository.id, {
          number: pullRequest.number,
          headRef: pullRequest.headRef,
          baseRef: DEFAULT_BRANCH,
          sourceSha,
          path: ".github/workflows/org-contract.yml",
          content: caller,
          contentDigest: callerDigest,
        }),
      );
    }
    result.outcome = "BOOTSTRAP_PR_OPEN";
    return result;
  }
  if (observed.autonomousOpenPullRequestCount > 0) {
    result.outcome = "WAITING_FOR_PR_SLOT";
    result.reason = "AUTONOMOUS_PR_LIMIT_REACHED";
    return result;
  }
  result.operations.push(
    operation("github.bootstrap-pull-request.ensure", repository.id, {
      headRef: `seori/fleet-bootstrap/${repository.id}`,
      baseRef: DEFAULT_BRANCH,
      sourceSha,
      path: ".github/workflows/org-contract.yml",
      title: "Fleet 중앙 CI 호출자를 등록한다",
      content: caller,
      contentDigest: callerDigest,
      maximumOpenAutonomousPullRequests: 1,
    }),
  );
  return result;
}

export function createFleetWebhookHandler({
  organizationId,
  installationId,
  loadWebhookSecret,
  claimDelivery,
  completeDelivery,
  readRepository,
  resolveCallerBinding,
  readObservedState,
} = {}) {
  if (
    !REPOSITORY_ID_PATTERN.test(organizationId ?? "") ||
    !REPOSITORY_ID_PATTERN.test(installationId ?? "") ||
    ![
      loadWebhookSecret,
      claimDelivery,
      completeDelivery,
      readRepository,
      resolveCallerBinding,
      readObservedState,
    ].every((callback) => typeof callback === "function")
  ) {
    throw new Error("FLEET_WEBHOOK_CONFIGURATION_INVALID");
  }

  return async function handleFleetWebhook({
    eventName,
    deliveryId,
    signature,
    rawBody,
    approvedBundleBinding,
  } = {}) {
    if (
      !["repository", "push"].includes(eventName) ||
      !DELIVERY_PATTERN.test(deliveryId ?? "") ||
      !SIGNATURE_PATTERN.test(signature ?? "") ||
      !Buffer.isBuffer(rawBody) ||
      rawBody.length === 0 ||
      rawBody.length > MAX_WEBHOOK_BYTES
    ) {
      throw new Error("WEBHOOK_REQUEST_INVALID");
    }

    let secret;
    let expectedSignature;
    try {
      secret = await loadWebhookSecret({ credentialId: WEBHOOK_CREDENTIAL_ID });
      if (!Buffer.isBuffer(secret) || secret.length < 32) {
        throw new Error("WEBHOOK_AUTH_FAILED");
      }
      expectedSignature = createHmac("sha256", secret).update(rawBody).digest();
      const receivedSignature = Buffer.from(
        SIGNATURE_PATTERN.exec(signature)[1],
        "hex",
      );
      if (!timingSafeEqual(expectedSignature, receivedSignature)) {
        throw new Error("WEBHOOK_AUTH_FAILED");
      }
    } catch {
      throw new Error("WEBHOOK_AUTH_FAILED");
    } finally {
      if (Buffer.isBuffer(secret)) secret.fill(0);
      if (Buffer.isBuffer(expectedSignature)) expectedSignature.fill(0);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new Error("WEBHOOK_JSON_INVALID");
    }
    const normalized = normalizeEvent(eventName, payload, {
      organizationId,
      installationId,
    });
    const payloadDigest = sha256(rawBody);
    const persistPlan = async (plan) => {
      const planSnapshot = structuredClone(plan);
      const validation = await validateFleetBootstrapPlan(planSnapshot);
      if (!validation.ok) {
        throw new Error("FLEET_BOOTSTRAP_PLAN_INVALID");
      }
      const planDigest = sha256(canonicalJson(planSnapshot));
      let completion;
      try {
        completion = await completeDelivery({
          deliveryId,
          payloadDigest,
          repositoryId: plan.repository.id,
          planDigest,
          plan: planSnapshot,
        });
      } catch {
        throw new Error("WEBHOOK_DELIVERY_COMPLETION_FAILED");
      }
      if (
        !exactKeys(completion, ["planDigest", "state"]) ||
        completion.state !== "COMPLETED" ||
        completion.planDigest !== planDigest
      ) {
        throw new Error("WEBHOOK_DELIVERY_COMPLETION_INVALID");
      }
      return deepFreeze(plan);
    };
    if (!normalized.relevant) {
      let claim;
      try {
        claim = await claimDelivery({
          deliveryId,
          payloadDigest,
          repositoryId: normalized.repository.id,
        });
      } catch {
        throw new Error("WEBHOOK_DELIVERY_CLAIM_FAILED");
      }
      if (!["CLAIMED", "RESUME", "COMPLETED"].includes(claim)) {
        throw new Error("WEBHOOK_DELIVERY_CLAIM_INVALID");
      }
      if (claim === "COMPLETED") {
        return deepFreeze(
          baseResult({
            deliveryId,
            repository: normalized.repository,
            action: eventName,
            outcome: "DUPLICATE",
            reason: "DELIVERY_ALREADY_APPLIED",
          }),
        );
      }
      return persistPlan(
        baseResult({
          deliveryId,
          repository: normalized.repository,
          action: eventName,
          outcome: "IGNORED",
          reason: normalized.reason,
        }),
      );
    }

    let repositoryReadback;
    try {
      repositoryReadback = await readRepository({
        repositoryId: normalized.repository.id,
        fullName: normalized.repository.fullName,
      });
    } catch {
      throw new Error("REPOSITORY_READBACK_FAILED");
    }
    const readback = validateReadback(
      repositoryReadback,
      normalized.repository,
      normalized.pushedSha,
    );
    if (readback.organizationId !== organizationId) {
      throw new Error("REPOSITORY_READBACK_MISMATCH");
    }
    let claim;
    try {
      claim = await claimDelivery({
        deliveryId,
        payloadDigest,
        repositoryId: normalized.repository.id,
      });
    } catch {
      throw new Error("WEBHOOK_DELIVERY_CLAIM_FAILED");
    }
    if (claim === "COMPLETED") {
      return deepFreeze(
        baseResult({
          deliveryId,
          repository: normalized.repository,
          sourceSha: readback.sourceSha,
          action: normalized.action,
          outcome: "DUPLICATE",
          reason: "DELIVERY_ALREADY_APPLIED",
        }),
      );
    }
    if (!["CLAIMED", "RESUME"].includes(claim)) {
      throw new Error("WEBHOOK_DELIVERY_CLAIM_INVALID");
    }

    if (readback.archived) {
      const result = baseResult({
        deliveryId,
        repository: normalized.repository,
        sourceSha: readback.sourceSha,
        action: normalized.action,
        outcome: "ARCHIVED",
      });
      result.operations.push(
        operation("control-plane.repository.archive", normalized.repository.id, {
          repository: result.repository,
        }),
      );
      return persistPlan(result);
    }
    if (!readback.private) {
      const result = baseResult({
        deliveryId,
        repository: normalized.repository,
        sourceSha: readback.sourceSha,
        action: normalized.action,
        outcome: "NEEDS_INPUT",
        reason: "PUBLIC_REPOSITORY_REQUIRES_POLICY",
      });
      return persistPlan(needsInputOperations(result, result.reason));
    }
    if (readback.sourceSha === null) {
      const result = baseResult({
        deliveryId,
        repository: normalized.repository,
        action: normalized.action,
        outcome: "NEEDS_INPUT",
        reason: "EMPTY_REPOSITORY",
      });
      return persistPlan(needsInputOperations(result, result.reason));
    }
    if (readback.defaultBranch !== DEFAULT_BRANCH) {
      const result = baseResult({
        deliveryId,
        repository: normalized.repository,
        sourceSha: readback.sourceSha,
        action: normalized.action,
        outcome: "NEEDS_INPUT",
        reason: "DEFAULT_BRANCH_NOT_MAIN",
      });
      return persistPlan(needsInputOperations(result, result.reason));
    }

    let resolution;
    try {
      resolution = await resolveCallerBinding({
        repositoryId: normalized.repository.id,
        fullName: normalized.repository.fullName,
        sourceSha: readback.sourceSha,
      });
    } catch {
      throw new Error("CALLER_RESOLUTION_FAILED");
    }
    if (
      resolution?.status === "NEEDS_INPUT" &&
      ["NO_CANDIDATE", "MULTIPLE_CANDIDATES", "CONFIG_INACTIVE"].includes(
        resolution.reason,
      )
    ) {
      const result = baseResult({
        deliveryId,
        repository: normalized.repository,
        sourceSha: readback.sourceSha,
        action: normalized.action,
        outcome: "NEEDS_INPUT",
        reason: resolution.reason,
      });
      return persistPlan(needsInputOperations(result, resolution.reason));
    }
    if (!exactKeys(resolution, ["binding", "status"]) || resolution.status !== "ACTIVE") {
      throw new Error("CALLER_RESOLUTION_INVALID");
    }
    const plan = await readyPlan({
      deliveryId,
      action: normalized.action,
      repository: normalized.repository,
      sourceSha: readback.sourceSha,
      approvedBundleBinding,
      callerBinding: resolution.binding,
      readObservedState,
    });
    return persistPlan(plan);
  };
}

export const fleetBootstrapContract = Object.freeze({
  defaultBranch: DEFAULT_BRANCH,
  defaultRef: DEFAULT_REF,
  maximumWebhookBytes: MAX_WEBHOOK_BYTES,
  organizationLogin: ORGANIZATION_LOGIN,
  webhookCredentialId: WEBHOOK_CREDENTIAL_ID,
});
