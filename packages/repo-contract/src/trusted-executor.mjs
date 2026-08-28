import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { validateFleetBootstrapPlan } from "./bootstrap.mjs";
import {
  resolveApprovedBuildWorkflowBinding,
  validateOrgContractCaller,
} from "./fleet.mjs";

const ORGANIZATION_LOGIN = "seorilabs";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GCP_IAM_API_ORIGIN = "https://iam.googleapis.com";
const GCP_IAM_API_VERSION = "v1";
const ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const LOGICAL_ID_PATTERN =
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){2,7}$/u;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,99}$/u;
const CLOUD_BUILD_VARIABLE_NAMES = Object.freeze([
  "GOOGLE_WORKLOAD_IDENTITY_PROVIDER",
  "SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT",
  "SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT",
]);
const WIF_PROVIDER_VARIABLE_PATTERN =
  /^projects\/[1-9][0-9]{0,31}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{3,31}\/providers\/[a-z][a-z0-9-]{3,31}$/u;
const SERVICE_ACCOUNT_EMAIL_PATTERN =
  /^[a-z][a-z0-9-]{4,29}@[a-z][a-z0-9-]{4,29}\.iam\.gserviceaccount\.com$/u;
const JOB_WORKFLOW_REF_PATTERN =
  /^seorilabs\/\.github\/\.github\/workflows\/[a-z0-9-]+\.yml@[0-9a-f]{40}$/u;
const ETAG_PATTERN = /^[A-Za-z0-9_+=\/-]{4,512}$/u;
const WIF_PROVIDER_RESOURCE_PATTERN =
  /^\/\/iam\.googleapis\.com\/(projects\/([1-9][0-9]{0,31})\/locations\/global\/workloadIdentityPools\/([a-z][a-z0-9-]{3,31})\/providers\/([a-z][a-z0-9-]{3,31}))$/u;
const MAX_OPERATION_LEASE_MS = 5 * 60 * 1000;

const TRUSTED_GITHUB_ADAPTERS = new WeakSet();
const TRUSTED_CONTROL_PLANE_ADAPTERS = new WeakSet();
const TRUSTED_WIF_ADAPTERS = new WeakSet();
const TRUSTED_EXECUTION_STORES = new WeakSet();

const GITHUB_OPERATION_WRITE_PERMISSIONS = Object.freeze({
  "github.custom-properties.ensure": Object.freeze({
    metadata: "read",
    repository_custom_properties: "write",
  }),
  "github.environment.ensure": Object.freeze({
    administration: "write",
    metadata: "read",
  }),
  "github.bootstrap-pull-request.ensure": Object.freeze({
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    workflows: "write",
  }),
  "github.bootstrap-pull-request.update": Object.freeze({
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    workflows: "write",
  }),
  "github.environment-variables.ensure": Object.freeze({
    environments: "write",
    metadata: "read",
  }),
  "github.org-secret-visibility.ensure": Object.freeze({
    metadata: "read",
    organization_secrets: "write",
  }),
});

const GITHUB_OPERATION_READ_PERMISSIONS = Object.freeze({
  "github.custom-properties.ensure": Object.freeze({ metadata: "read" }),
  "github.environment.ensure": Object.freeze({
    actions: "read",
    metadata: "read",
  }),
  "github.bootstrap-pull-request.ensure": Object.freeze({
    contents: "read",
    metadata: "read",
    pull_requests: "read",
  }),
  "github.bootstrap-pull-request.update": Object.freeze({
    contents: "read",
    metadata: "read",
    pull_requests: "read",
  }),
  "github.environment-variables.ensure": Object.freeze({
    environments: "read",
    metadata: "read",
  }),
  "github.org-secret-visibility.ensure": Object.freeze({
    metadata: "read",
    organization_secrets: "read",
  }),
});

const IDENTITY_PERMISSIONS = Object.freeze({
  contents: "read",
  metadata: "read",
});
const REPOSITORY_PROVISIONING_GATE_PERMISSIONS = Object.freeze({
  administration: "read",
  contents: "read",
  metadata: "read",
});
const ORGANIZATION_PROVISIONING_GATE_PERMISSIONS = Object.freeze({
  contents: "read",
  metadata: "read",
  organization_administration: "read",
});

const OPERATION_ORDER = Object.freeze({
  "control-plane.repository.observe": 0,
  "control-plane.repository.archive": 0,
  "github.custom-properties.ensure": 1,
  "github.environment.ensure": 2,
  "github.bootstrap-pull-request.ensure": 3,
  "github.bootstrap-pull-request.update": 3,
  "github.protection.reconcile": 4,
  "github.environment-variables.ensure": 5,
  "github.org-secret-visibility.ensure": 6,
  "gcp.wif-binding.ensure": 7,
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

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function clonePublic(value, diagnostic) {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(diagnostic);
  }
}

function operationIdempotencyKey(operation, repositoryId) {
  return sha256(
    canonicalJson({
      kind: operation.kind,
      repositoryId,
      payload: operation.payload,
    }),
  );
}

function validContext(value) {
  return (
    exactKeys(value, ["fullName", "repositoryId", "sourceSha"]) &&
    ID_PATTERN.test(value.repositoryId ?? "") &&
    /^seorilabs\/[A-Za-z0-9._-]+$/u.test(value.fullName ?? "") &&
    (value.sourceSha === null || SHA_PATTERN.test(value.sourceSha ?? ""))
  );
}

function validateTokenLease(
  lease,
  { organizationId, installationId, repositoryId, permissions, now },
) {
  const expiresAtMs = Date.parse(lease?.expiresAt ?? "");
  const nowMs = now();
  return (
    exactKeys(lease, [
      "accountId",
      "accountLogin",
      "expiresAt",
      "installationId",
      "permissions",
      "repositoryIds",
      "token",
    ]) &&
    Buffer.isBuffer(lease.token) &&
    lease.token.length >= 32 &&
    lease.accountId === organizationId &&
    lease.accountLogin === ORGANIZATION_LOGIN &&
    lease.installationId === installationId &&
    canonicalJson(lease.repositoryIds) === canonicalJson([repositoryId]) &&
    canonicalJson(lease.permissions) === canonicalJson(permissions) &&
    ISO_DATE_PATTERN.test(lease.expiresAt ?? "") &&
    Number.isFinite(expiresAtMs) &&
    Number.isFinite(nowMs) &&
    expiresAtMs > nowMs &&
    expiresAtMs <= nowMs + 60 * 60 * 1000
  );
}

function snapshotSecretBindings(bindings) {
  const kind = "GITHUB_APP_ADAPTER";
  if (!Array.isArray(bindings)) throw new Error(`${kind}_CONFIGURATION_INVALID`);
  const byKey = Object.create(null);
  for (const binding of bindings) {
    if (
      !exactKeys(binding, [
        "bindingRevision",
        "logicalCredentialId",
        "secretName",
      ]) ||
      !Number.isSafeInteger(binding?.bindingRevision) ||
      binding.bindingRevision < 1 ||
      !LOGICAL_ID_PATTERN.test(binding.logicalCredentialId ?? "") ||
      !SECRET_NAME_PATTERN.test(binding.secretName ?? "")
    ) {
      throw new Error(`${kind}_CONFIGURATION_INVALID`);
    }
    const key = `${binding.logicalCredentialId}@${binding.bindingRevision}`;
    if (byKey[key]) throw new Error(`${kind}_CONFIGURATION_INVALID`);
    byKey[key] = deepFreeze(structuredClone(binding));
  }
  return Object.freeze(byKey);
}

function validCloudBuildVariables(value) {
  return (
    exactKeys(value, CLOUD_BUILD_VARIABLE_NAMES) &&
    WIF_PROVIDER_VARIABLE_PATTERN.test(
      value.GOOGLE_WORKLOAD_IDENTITY_PROVIDER ?? "",
    ) &&
    SERVICE_ACCOUNT_EMAIL_PATTERN.test(
      value.SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT ?? "",
    ) &&
    SERVICE_ACCOUNT_EMAIL_PATTERN.test(
      value.SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT ?? "",
    ) &&
    value.SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT !==
      value.SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT
  );
}

function snapshotEnvironmentVariableBindings(bindings) {
  const kind = "GITHUB_APP_ADAPTER";
  if (!Array.isArray(bindings)) throw new Error(`${kind}_CONFIGURATION_INVALID`);
  const byKey = Object.create(null);
  for (const binding of bindings) {
    if (
      !exactKeys(binding, [
        "bindingRevision",
        "environment",
        "logicalCredentialId",
        "variables",
      ]) ||
      !Number.isSafeInteger(binding?.bindingRevision) ||
      binding.bindingRevision < 1 ||
      binding.environment !== "internal" ||
      !LOGICAL_ID_PATTERN.test(binding.logicalCredentialId ?? "") ||
      !validCloudBuildVariables(binding.variables)
    ) {
      throw new Error(`${kind}_CONFIGURATION_INVALID`);
    }
    const key =
      `${binding.logicalCredentialId}@${binding.bindingRevision}:` +
      binding.environment;
    if (byKey[key]) throw new Error(`${kind}_CONFIGURATION_INVALID`);
    byKey[key] = deepFreeze(structuredClone(binding));
  }
  return Object.freeze(byKey);
}

function snapshotWifCapabilities(capabilities) {
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.length > 64
  ) {
    throw new Error("WIF_PROVIDER_POLICY_INVALID");
  }
  const snapshot = capabilities.map((capability) => {
    if (
      !exactKeys(capability, [
        "environment",
        "jobWorkflowRef",
        "repositoryId",
      ]) ||
      capability.environment !== "internal" ||
      !ID_PATTERN.test(capability.repositoryId ?? "") ||
      !JOB_WORKFLOW_REF_PATTERN.test(capability.jobWorkflowRef ?? "")
    ) {
      throw new Error("WIF_PROVIDER_POLICY_INVALID");
    }
    return structuredClone(capability);
  });
  const keys = snapshot.map(
    ({ repositoryId, jobWorkflowRef }) =>
      `${repositoryId}:${jobWorkflowRef}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error("WIF_PROVIDER_POLICY_INVALID");
  }
  return deepFreeze(
    snapshot.toSorted(
      (left, right) =>
        left.repositoryId.localeCompare(right.repositoryId) ||
        left.jobWorkflowRef.localeCompare(right.jobWorkflowRef),
    ),
  );
}

export function createTrustedWifProviderPolicy({
  organizationId,
  capabilities,
} = {}) {
  if (!ID_PATTERN.test(organizationId ?? "")) {
    throw new Error("WIF_PROVIDER_POLICY_INVALID");
  }
  const trustedCapabilities = snapshotWifCapabilities(capabilities);
  const pairwiseCondition = trustedCapabilities
    .map(
      ({ repositoryId, jobWorkflowRef }) =>
        `(assertion.repository_id == '${repositoryId}' && ` +
        `assertion.job_workflow_ref == '${jobWorkflowRef}')`,
    )
    .join(" || ");
  return deepFreeze({
    attributeCondition:
      `assertion.repository_owner_id == '${organizationId}' && ` +
      `(${pairwiseCondition})`,
    attributeMapping: {
      "google.subject": "assertion.sub",
      "attribute.repository": "assertion.repository",
      "attribute.repository_id": "assertion.repository_id",
      "attribute.job_workflow_ref": "assertion.job_workflow_ref",
    },
    capabilities: trustedCapabilities,
  });
}

function snapshotWifBindings(bindings) {
  const kind = "WIF_ADAPTER";
  if (!Array.isArray(bindings)) throw new Error(`${kind}_CONFIGURATION_INVALID`);
  const byKey = Object.create(null);
  for (const binding of bindings) {
    if (
      !exactKeys(binding, [
        "bindingRevision",
        "capabilities",
        "logicalCredentialId",
        "providerResourceName",
        "serviceAccountEmail",
      ]) ||
      !Number.isSafeInteger(binding?.bindingRevision) ||
      binding.bindingRevision < 1 ||
      !LOGICAL_ID_PATTERN.test(binding.logicalCredentialId ?? "") ||
      !WIF_PROVIDER_RESOURCE_PATTERN.test(binding.providerResourceName ?? "") ||
      !/^[a-z][a-z0-9-]{4,29}@[a-z][a-z0-9-]{4,29}\.iam\.gserviceaccount\.com$/u.test(
        binding.serviceAccountEmail ?? "",
      )
    ) {
      throw new Error(`${kind}_CONFIGURATION_INVALID`);
    }
    let capabilities;
    try {
      capabilities = snapshotWifCapabilities(binding.capabilities);
    } catch {
      throw new Error(`${kind}_CONFIGURATION_INVALID`);
    }
    const key = `${binding.logicalCredentialId}@${binding.bindingRevision}`;
    if (byKey[key]) throw new Error(`${kind}_CONFIGURATION_INVALID`);
    byKey[key] = deepFreeze({ ...structuredClone(binding), capabilities });
  }
  return Object.freeze(byKey);
}

function secretBindingForOperation(operation, bindings) {
  const payload = operation?.payload;
  const binding =
    bindings[`${payload?.logicalCredentialId}@${payload?.bindingRevision}`];
  if (
    !binding ||
    binding.secretName !== payload.secretName ||
    !SECRET_NAME_PATTERN.test(binding.secretName ?? "")
  ) {
    throw new Error("GITHUB_SECRET_BINDING_UNTRUSTED");
  }
  return binding;
}

function environmentVariableBindingForOperation(operation, bindings) {
  const payload = operation?.payload;
  const key =
    `${payload?.logicalCredentialId}@${payload?.bindingRevision}:` +
    payload?.environment;
  const binding = bindings[key];
  if (
    operation?.kind !== "github.environment-variables.ensure" ||
    !binding ||
    canonicalJson(binding.variables) !== canonicalJson(payload.variables) ||
    !validCloudBuildVariables(binding.variables)
  ) {
    throw new Error("GITHUB_ENVIRONMENT_VARIABLE_BINDING_UNTRUSTED");
  }
  return binding;
}

function protectionPermissions(operation, write) {
  if (operation?.kind !== "github.protection.reconcile") return undefined;
  if (operation.payload.providerMode === "ORG_RULESET") {
    return Object.freeze({
      metadata: "read",
      organization_administration: write ? "write" : "read",
    });
  }
  if (operation.payload.providerMode === "REPO_BRANCH_PROTECTION") {
    return Object.freeze({
      administration: write ? "write" : "read",
      metadata: "read",
    });
  }
  return undefined;
}

function validateProtectionCapability(value, operation, organizationId) {
  const expectedPlan =
    operation.payload.providerMode === "ORG_RULESET" ? "ENTERPRISE" : "TEAM";
  return (
    exactKeys(value, [
      "accountPlan",
      "organizationId",
      "organizationLogin",
      "providerMode",
    ]) &&
    value.accountPlan === expectedPlan &&
    value.organizationId === organizationId &&
    value.organizationLogin === ORGANIZATION_LOGIN &&
    value.providerMode === operation.payload.providerMode
  );
}

function normalizeProtectionObservation(raw, operation, repositoryId) {
  const desired = operation.payload;
  if (
    !exactKeys(raw, [
      "broadProtectionDigest",
      "bypassActorsDigest",
      "canApplyMonotonically",
      "checks",
      "defaultBranch",
      "enforceAdmins",
      "requiredConversationResolution",
      "requiredLinearHistory",
      "allowDeletions",
      "allowForcePushes",
      "providerMode",
      "repositoryId",
      "restrictionsDigest",
      "reviewPolicy",
      "strict",
      "unsupportedSettings",
    ]) ||
    raw.repositoryId !== repositoryId ||
    raw.providerMode !== desired.providerMode ||
    raw.defaultBranch !== "main" ||
    !DIGEST_PATTERN.test(raw.broadProtectionDigest ?? "") ||
    (raw.bypassActorsDigest !== null &&
      !DIGEST_PATTERN.test(raw.bypassActorsDigest ?? "")) ||
    (raw.restrictionsDigest !== null &&
      !DIGEST_PATTERN.test(raw.restrictionsDigest ?? "")) ||
    typeof raw.canApplyMonotonically !== "boolean" ||
    typeof raw.strict !== "boolean" ||
    typeof raw.enforceAdmins !== "boolean" ||
    typeof raw.requiredConversationResolution !== "boolean" ||
    typeof raw.requiredLinearHistory !== "boolean" ||
    typeof raw.allowDeletions !== "boolean" ||
    typeof raw.allowForcePushes !== "boolean" ||
    !Array.isArray(raw.unsupportedSettings) ||
    raw.unsupportedSettings.some(
      (setting) => typeof setting !== "string" || setting.length === 0,
    ) ||
    !Array.isArray(raw.checks) ||
    raw.checks.some(
      (check) =>
        !exactKeys(check, ["appId", "context"]) ||
        !ID_PATTERN.test(check.appId ?? "") ||
        typeof check.context !== "string" ||
        check.context.length === 0,
    ) ||
    (raw.reviewPolicy !== null &&
      (!exactKeys(raw.reviewPolicy, [
        "dismissStaleReviews",
        "requiredApprovingReviewCount",
        "requireCodeOwnerReviews",
        "requireLastPushApproval",
      ]) ||
        typeof raw.reviewPolicy.dismissStaleReviews !== "boolean" ||
        !Number.isSafeInteger(raw.reviewPolicy.requiredApprovingReviewCount) ||
        raw.reviewPolicy.requiredApprovingReviewCount < 0 ||
        typeof raw.reviewPolicy.requireCodeOwnerReviews !== "boolean" ||
        typeof raw.reviewPolicy.requireLastPushApproval !== "boolean"))
  ) {
    throw new Error("GITHUB_PROTECTION_READBACK_FAILED");
  }
  const checks = raw.checks
    .map((check) => structuredClone(check))
    .toSorted((left, right) =>
      `${left.context}:${left.appId}`.localeCompare(
        `${right.context}:${right.appId}`,
      ),
    );
  const expectedChecks = desired.requiredStatusChecks.checks;
  const meetsDesired =
    raw.strict === true &&
    expectedChecks.every((expected) =>
      checks.some(
        (actual) =>
          actual.context === expected.context && actual.appId === expected.appId,
      ),
    ) &&
    (raw.reviewPolicy?.requiredApprovingReviewCount ?? 0) >=
      desired.reviewPolicy.requiredApprovingReviewCount &&
    raw.reviewPolicy?.dismissStaleReviews === true &&
    raw.reviewPolicy?.requireLastPushApproval === true;
  const state =
    raw.unsupportedSettings.length > 0
      ? "HUMAN_DECISION_REQUIRED"
      : meetsDesired
        ? "MATCH"
        : raw.canApplyMonotonically
          ? "DRIFT"
          : "HUMAN_DECISION_REQUIRED";
  const actual = {
    allowDeletions: raw.allowDeletions,
    allowForcePushes: raw.allowForcePushes,
    broadProtectionDigest: raw.broadProtectionDigest,
    bypassActorsDigest: raw.bypassActorsDigest,
    checks,
    defaultBranch: raw.defaultBranch,
    enforceAdmins: raw.enforceAdmins,
    providerMode: raw.providerMode,
    requiredConversationResolution: raw.requiredConversationResolution,
    requiredLinearHistory: raw.requiredLinearHistory,
    restrictionsDigest: raw.restrictionsDigest,
    reviewPolicy: raw.reviewPolicy,
    strict: raw.strict,
    unsupportedSettings: raw.unsupportedSettings.toSorted(),
  };
  return deepFreeze({
    actual: structuredClone(actual),
    actualDigest: sha256(canonicalJson(actual)),
    broadProtectionDigest: raw.broadProtectionDigest,
    bypassActorsDigest: raw.bypassActorsDigest,
    desiredDigest: sha256(
      canonicalJson({
        defaultBranch: desired.defaultBranch,
        providerMode: desired.providerMode,
        requiredStatusChecks: desired.requiredStatusChecks,
        reviewPolicy: desired.reviewPolicy,
      }),
    ),
    kind: operation.kind,
    providerMode: desired.providerMode,
    repositoryId,
    restrictionsDigest: raw.restrictionsDigest,
    rolloutMode: desired.rolloutMode,
    state,
  });
}

function expectedMonotonicProtection(before, operation) {
  const desired = operation.payload;
  const checks = [...before.actual.checks];
  for (const required of desired.requiredStatusChecks.checks) {
    if (
      !checks.some(
        (actual) =>
          actual.context === required.context && actual.appId === required.appId,
      )
    ) {
      checks.push(structuredClone(required));
    }
  }
  checks.sort((left, right) =>
    `${left.context}:${left.appId}`.localeCompare(
      `${right.context}:${right.appId}`,
    ),
  );
  return deepFreeze({
    ...structuredClone(before.actual),
    checks,
    reviewPolicy: {
      ...structuredClone(before.actual.reviewPolicy ?? {
        dismissStaleReviews: false,
        requiredApprovingReviewCount: 0,
        requireCodeOwnerReviews: false,
        requireLastPushApproval: false,
      }),
      dismissStaleReviews: true,
      requiredApprovingReviewCount: Math.max(
        before.actual.reviewPolicy?.requiredApprovingReviewCount ?? 0,
        desired.reviewPolicy.requiredApprovingReviewCount,
      ),
      requireLastPushApproval: true,
    },
    strict: true,
  });
}

function validateProtectionApplyReceipt(receipt, before, expected, operation) {
  return (
    exactKeys(receipt, [
      "expectedPolicyDigest",
      "method",
      "previousActualDigest",
      "preservedBroadProtectionDigest",
      "preservedBypassActorsDigest",
      "preservedRestrictionsDigest",
      "providerMode",
      "repositoryId",
      "state",
    ]) &&
    receipt.state === "UPDATED" &&
    receipt.method === "COMPARE_AND_SET_MONOTONIC_MERGE" &&
    receipt.repositoryId === before.repositoryId &&
    receipt.providerMode === operation.payload.providerMode &&
    receipt.previousActualDigest === before.actualDigest &&
    receipt.expectedPolicyDigest === sha256(canonicalJson(expected)) &&
    receipt.preservedBroadProtectionDigest === before.broadProtectionDigest &&
    receipt.preservedBypassActorsDigest === before.bypassActorsDigest &&
    receipt.preservedRestrictionsDigest === before.restrictionsDigest
  );
}

function validateMonotonicProtectionReadback(before, after, expected) {
  return (
    after.state === "MATCH" &&
    after.broadProtectionDigest === before.broadProtectionDigest &&
    after.bypassActorsDigest === before.bypassActorsDigest &&
    after.restrictionsDigest === before.restrictionsDigest &&
    after.actual.unsupportedSettings.length === 0 &&
    canonicalJson(after.actual) === canonicalJson(expected)
  );
}

export function createGitHubAppTrustedAdapter({
  organizationId,
  installationId,
  issueInstallationToken,
  environmentVariableBindings = [],
  secretBindings = [],
  provider,
  now = () => Date.now(),
} = {}) {
  let trustedEnvironmentVariableBindings;
  let trustedSecretBindings;
  try {
    trustedEnvironmentVariableBindings = snapshotEnvironmentVariableBindings(
      environmentVariableBindings,
    );
    trustedSecretBindings = snapshotSecretBindings(secretBindings);
  } catch {
    throw new Error("GITHUB_APP_ADAPTER_CONFIGURATION_INVALID");
  }
  if (
    !ID_PATTERN.test(organizationId ?? "") ||
    !ID_PATTERN.test(installationId ?? "") ||
    typeof issueInstallationToken !== "function" ||
    provider === null ||
    typeof provider !== "object" ||
    ![
      provider.addSecretRepositoryAccess,
      provider.applyOperation,
      provider.applyProtection,
      provider.readIdentity,
      provider.readOperation,
      provider.readProtection,
      provider.readProtectionCapability,
      provider.readProvisioningGate,
      provider.readSecretRepositoryAccess,
    ].every((callback) => typeof callback === "function") ||
    typeof now !== "function"
  ) {
    throw new Error("GITHUB_APP_ADAPTER_CONFIGURATION_INVALID");
  }

  async function withToken(context, permissions, callback, diagnostic) {
    if (!validContext(context)) {
      throw new Error("GITHUB_APP_REPOSITORY_CONTEXT_INVALID");
    }
    let lease;
    try {
      lease = await issueInstallationToken({
        installationId,
        repositoryIds: [context.repositoryId],
        permissions: structuredClone(permissions),
      });
      if (
        !validateTokenLease(lease, {
          organizationId,
          installationId,
          repositoryId: context.repositoryId,
          permissions,
          now,
        })
      ) {
        throw new Error("invalid lease");
      }
      return await callback({
        apiOrigin: GITHUB_API_ORIGIN,
        apiVersion: GITHUB_API_VERSION,
        credential: lease.token,
        context: deepFreeze(structuredClone(context)),
      });
    } catch {
      throw new Error(diagnostic);
    } finally {
      if (Buffer.isBuffer(lease?.token)) lease.token.fill(0);
    }
  }

  const adapter = Object.freeze({
    async readIdentity(context) {
      return withToken(
        context,
        IDENTITY_PERMISSIONS,
        async (request) =>
          clonePublic(
            await provider.readIdentity(request),
            "GITHUB_REPOSITORY_READBACK_FAILED",
          ),
        "GITHUB_REPOSITORY_READBACK_FAILED",
      );
    },
    async readProtectionCapability(operation, context) {
      const permissions = protectionPermissions(operation, false);
      if (!permissions) throw new Error("GITHUB_PROTECTION_REQUEST_INVALID");
      return withToken(
        context,
        permissions,
        async (request) => {
          const value = clonePublic(
            await provider.readProtectionCapability({
              ...request,
              operation: deepFreeze(structuredClone(operation)),
            }),
            "GITHUB_PROTECTION_CAPABILITY_READBACK_FAILED",
          );
          if (!validateProtectionCapability(value, operation, organizationId)) {
            throw new Error("capability mismatch");
          }
          return value;
        },
        "GITHUB_PROTECTION_CAPABILITY_READBACK_FAILED",
      );
    },
    async readProtection(operation, context) {
      const permissions = protectionPermissions(operation, false);
      if (!permissions) throw new Error("GITHUB_PROTECTION_REQUEST_INVALID");
      return withToken(
        context,
        permissions,
        async (request) =>
          normalizeProtectionObservation(
            clonePublic(
              await provider.readProtection({
                ...request,
                operation: deepFreeze(structuredClone(operation)),
              }),
              "GITHUB_PROTECTION_READBACK_FAILED",
            ),
            operation,
            context.repositoryId,
          ),
        "GITHUB_PROTECTION_READBACK_FAILED",
      );
    },
    async applyOperation(operation, context) {
      const permissions =
        GITHUB_OPERATION_WRITE_PERMISSIONS[operation?.kind] ??
        protectionPermissions(operation, true);
      if (!permissions) throw new Error("GITHUB_OPERATION_NOT_MUTABLE");
      if (operation.kind === "github.environment-variables.ensure") {
        environmentVariableBindingForOperation(
          operation,
          trustedEnvironmentVariableBindings,
        );
      }
      if (operation.kind === "github.org-secret-visibility.ensure") {
        secretBindingForOperation(operation, trustedSecretBindings);
      }
      await withToken(
        context,
        permissions,
        async (request) => {
          if (operation.kind === "github.org-secret-visibility.ensure") {
            const receipt = clonePublic(
              await provider.addSecretRepositoryAccess({
                ...request,
                operation: deepFreeze(structuredClone(operation)),
              }),
              "GITHUB_OPERATION_APPLY_FAILED",
            );
            if (
              !exactKeys(receipt, [
                "bindingRevision",
                "logicalCredentialId",
                "method",
                "repositoryId",
                "secretName",
                "state",
              ]) ||
              receipt.bindingRevision !== operation.payload.bindingRevision ||
              receipt.logicalCredentialId !== operation.payload.logicalCredentialId ||
              receipt.method !== "ADD_SELECTED_REPOSITORY" ||
              receipt.repositoryId !== context.repositoryId ||
              receipt.secretName !== operation.payload.secretName ||
              !["UNCHANGED", "UPDATED"].includes(receipt.state)
            ) {
              throw new Error("invalid additive receipt");
            }
            return;
          }
          if (operation.kind === "github.protection.reconcile") {
            if (operation.payload.rolloutMode !== "ACTIVE") {
              throw new Error("shadow protection is read-only");
            }
            const before = await adapter.readProtection(operation, context);
            if (before.state !== "DRIFT") {
              throw new Error("protection is not safely mutable");
            }
            const expected = expectedMonotonicProtection(before, operation);
            const receipt = clonePublic(
              await provider.applyProtection({
                ...request,
                expectedActualDigest: before.actualDigest,
                expectedPolicy: expected,
                operation: deepFreeze(structuredClone(operation)),
                preserveBroadProtectionDigest: before.broadProtectionDigest,
                preserveBypassActorsDigest: before.bypassActorsDigest,
                preserveRestrictionsDigest: before.restrictionsDigest,
                strategy: "MONOTONIC_STRENGTHEN_ONLY",
              }),
              "GITHUB_OPERATION_APPLY_FAILED",
            );
            if (
              !validateProtectionApplyReceipt(
                receipt,
                before,
                expected,
                operation,
              )
            ) {
              throw new Error("invalid monotonic receipt");
            }
            const after = await adapter.readProtection(operation, context);
            if (!validateMonotonicProtectionReadback(before, after, expected)) {
              throw new Error("protection was replaced or weakened");
            }
            return;
          }
          await provider.applyOperation({
            ...request,
            operation: deepFreeze(structuredClone(operation)),
          });
        },
        "GITHUB_OPERATION_APPLY_FAILED",
      );
    },
    async readOperation(operation, context) {
      if (operation?.kind === "github.protection.reconcile") {
        return adapter.readProtection(operation, context);
      }
      const permissions = GITHUB_OPERATION_READ_PERMISSIONS[operation?.kind];
      if (!permissions) throw new Error("GITHUB_OPERATION_READBACK_UNSUPPORTED");
      if (operation.kind === "github.environment-variables.ensure") {
        environmentVariableBindingForOperation(
          operation,
          trustedEnvironmentVariableBindings,
        );
      }
      if (operation.kind === "github.org-secret-visibility.ensure") {
        secretBindingForOperation(operation, trustedSecretBindings);
      }
      return withToken(
        context,
        permissions,
        async (request) =>
          clonePublic(
            operation.kind === "github.org-secret-visibility.ensure"
              ? await provider.readSecretRepositoryAccess({
                  ...request,
                  operation: deepFreeze(structuredClone(operation)),
                })
              : await provider.readOperation({
                  ...request,
                  operation: deepFreeze(structuredClone(operation)),
                }),
            "GITHUB_OPERATION_READBACK_FAILED",
          ),
        "GITHUB_OPERATION_READBACK_FAILED",
      );
    },
    async readProvisioningGate(gate, context) {
      const permissions =
        (gate?.providerMode ?? "ORG_RULESET") === "ORG_RULESET"
          ? ORGANIZATION_PROVISIONING_GATE_PERMISSIONS
          : REPOSITORY_PROVISIONING_GATE_PERMISSIONS;
      return withToken(
        context,
        permissions,
        async (request) =>
          clonePublic(
            await provider.readProvisioningGate({
              ...request,
              gate: deepFreeze(structuredClone(gate)),
            }),
            "GITHUB_PROVISIONING_GATE_READBACK_FAILED",
          ),
        "GITHUB_PROVISIONING_GATE_READBACK_FAILED",
      );
    },
  });
  TRUSTED_GITHUB_ADAPTERS.add(adapter);
  return adapter;
}

export function createTrustedControlPlaneAdapter({ provider } = {}) {
  if (
    provider === null ||
    typeof provider !== "object" ||
    ![provider.applyOperation, provider.readOperation].every(
      (callback) => typeof callback === "function",
    )
  ) {
    throw new Error("CONTROL_PLANE_ADAPTER_CONFIGURATION_INVALID");
  }
  const adapter = Object.freeze({
    async applyOperation(operation, repository) {
      try {
        await provider.applyOperation(
          deepFreeze(structuredClone(operation)),
          deepFreeze(structuredClone(repository)),
        );
      } catch {
        throw new Error("CONTROL_PLANE_OPERATION_APPLY_FAILED");
      }
    },
    async readOperation(operation, repository) {
      try {
        return clonePublic(
          await provider.readOperation(
            deepFreeze(structuredClone(operation)),
            deepFreeze(structuredClone(repository)),
          ),
          "CONTROL_PLANE_OPERATION_READBACK_FAILED",
        );
      } catch {
        throw new Error("CONTROL_PLANE_OPERATION_READBACK_FAILED");
      }
    },
  });
  TRUSTED_CONTROL_PLANE_ADAPTERS.add(adapter);
  return adapter;
}

function expectedWifBinding(operation, organizationId, bindings) {
  const payload = operation?.payload;
  const bundleDigest =
    payload?.approvedBundleDigest ?? payload?.candidateBundleDigest;
  const binding =
    bindings[`${payload?.logicalCredentialId}@${payload?.bindingRevision}`];
  if (
    operation?.kind !== "gcp.wif-binding.ensure" ||
    !binding ||
    payload.organizationId !== organizationId ||
    !DIGEST_PATTERN.test(bundleDigest ?? "") ||
    (payload.approvedBundleDigest === undefined) ===
      (payload.candidateBundleDigest === undefined) ||
    !ID_PATTERN.test(payload.repositoryId ?? "") ||
    !JOB_WORKFLOW_REF_PATTERN.test(payload.jobWorkflowRef ?? "") ||
    payload.environment !== "internal"
  ) {
    throw new Error("WIF_OPERATION_BINDING_UNTRUSTED");
  }
  const providerMatch = WIF_PROVIDER_RESOURCE_PATTERN.exec(
    binding.providerResourceName,
  );
  if (!providerMatch) throw new Error("WIF_OPERATION_BINDING_UNTRUSTED");
  const poolResource = providerMatch[1].replace(
    /\/providers\/[a-z][a-z0-9-]{3,31}$/u,
    "",
  );
  const capability = binding.capabilities.find(
    (item) =>
      item.environment === payload.environment &&
      item.repositoryId === payload.repositoryId &&
      item.jobWorkflowRef === payload.jobWorkflowRef,
  );
  if (!capability) throw new Error("WIF_OPERATION_BINDING_UNTRUSTED");
  const providerPolicy = createTrustedWifProviderPolicy({
    organizationId,
    capabilities: binding.capabilities,
  });
  return deepFreeze({
    workflowBundleDigest: bundleDigest,
    bindingRevision: payload.bindingRevision,
    environment: payload.environment,
    jobWorkflowRef: payload.jobWorkflowRef,
    kind: operation.kind,
    logicalCredentialId: payload.logicalCredentialId,
    organizationId,
    principalSetMember:
      `principalSet://iam.googleapis.com/${poolResource}/` +
      `attribute.repository_id/${payload.repositoryId}`,
    providerAttributeCondition: providerPolicy.attributeCondition,
    providerAttributeMapping: providerPolicy.attributeMapping,
    providerResourceName: binding.providerResourceName,
    repositoryId: payload.repositoryId,
    role: "roles/iam.workloadIdentityUser",
    serviceAccountEmail: binding.serviceAccountEmail,
  });
}

function validateWifObservation(observation, expected, allowedStates) {
  return (
    exactKeys(observation, [
      ...Object.keys(expected),
      "providerEtag",
      "serviceAccountPolicyEtag",
      "state",
    ]) &&
    Object.entries(expected).every(
      ([key, value]) => canonicalJson(observation[key]) === canonicalJson(value),
    ) &&
    ETAG_PATTERN.test(observation.providerEtag ?? "") &&
    ETAG_PATTERN.test(observation.serviceAccountPolicyEtag ?? "") &&
    allowedStates.includes(observation.state)
  );
}

export function createTrustedWifAdapter({
  organizationId,
  bindings,
  provider,
} = {}) {
  let trustedBindings;
  try {
    trustedBindings = snapshotWifBindings(bindings);
    const providerPolicies = new Map();
    for (const binding of Object.values(trustedBindings)) {
      const policy = createTrustedWifProviderPolicy({
        organizationId,
        capabilities: binding.capabilities,
      });
      const digest = canonicalJson({
        attributeCondition: policy.attributeCondition,
        attributeMapping: policy.attributeMapping,
      });
      const existing = providerPolicies.get(binding.providerResourceName);
      if (existing !== undefined && existing !== digest) {
        throw new Error("WIF_ADAPTER_CONFIGURATION_INVALID");
      }
      providerPolicies.set(binding.providerResourceName, digest);
    }
  } catch {
    throw new Error("WIF_ADAPTER_CONFIGURATION_INVALID");
  }
  if (
    !ID_PATTERN.test(organizationId ?? "") ||
    provider === null ||
    typeof provider !== "object" ||
    ![provider.applyBinding, provider.readBinding].every(
      (callback) => typeof callback === "function",
    )
  ) {
    throw new Error("WIF_ADAPTER_CONFIGURATION_INVALID");
  }
  async function readExpected(operation, expected) {
    let observation;
    try {
      observation = clonePublic(
        await provider.readBinding({
          apiOrigin: GCP_IAM_API_ORIGIN,
          apiVersion: GCP_IAM_API_VERSION,
          expected,
          operation: deepFreeze(structuredClone(operation)),
        }),
        "WIF_OPERATION_READBACK_FAILED",
      );
    } catch {
      throw new Error("WIF_OPERATION_READBACK_FAILED");
    }
    if (!validateWifObservation(observation, expected, ["BOUND", "NOT_APPLIED"])) {
      throw new Error("WIF_OPERATION_READBACK_FAILED");
    }
    return observation;
  }
  const adapter = Object.freeze({
    async applyOperation(operation, repository) {
      const expected = expectedWifBinding(
        operation,
        organizationId,
        trustedBindings,
      );
      if (expected.repositoryId !== repository.id) {
        throw new Error("WIF_OPERATION_BINDING_UNTRUSTED");
      }
      const before = await readExpected(operation, expected);
      if (before.state === "BOUND") return;
      try {
        const receipt = clonePublic(
          await provider.applyBinding({
            apiOrigin: GCP_IAM_API_ORIGIN,
            apiVersion: GCP_IAM_API_VERSION,
            expected,
            expectedProviderEtag: before.providerEtag,
            expectedServiceAccountPolicyEtag:
              before.serviceAccountPolicyEtag,
            operation: deepFreeze(structuredClone(operation)),
          }),
          "WIF_OPERATION_APPLY_FAILED",
        );
        if (
          !exactKeys(receipt, [
            "bindingRevision",
            "logicalCredentialId",
            "providerEtag",
            "providerResourceName",
            "previousProviderEtag",
            "previousServiceAccountPolicyEtag",
            "repositoryId",
            "serviceAccountEmail",
            "serviceAccountPolicyEtag",
            "state",
          ]) ||
          receipt.state !== "UPDATED" ||
          receipt.bindingRevision !== expected.bindingRevision ||
          receipt.logicalCredentialId !== expected.logicalCredentialId ||
          receipt.providerResourceName !== expected.providerResourceName ||
          receipt.repositoryId !== expected.repositoryId ||
          receipt.serviceAccountEmail !== expected.serviceAccountEmail ||
          receipt.previousProviderEtag !== before.providerEtag ||
          receipt.previousServiceAccountPolicyEtag !==
            before.serviceAccountPolicyEtag ||
          !ETAG_PATTERN.test(receipt.providerEtag ?? "") ||
          !ETAG_PATTERN.test(receipt.serviceAccountPolicyEtag ?? "")
        ) {
          throw new Error("invalid WIF receipt");
        }
      } catch {
        throw new Error("WIF_OPERATION_APPLY_FAILED");
      }
      const after = await readExpected(operation, expected);
      if (after.state !== "BOUND") {
        throw new Error("WIF_OPERATION_APPLY_FAILED");
      }
    },
    async readOperation(operation, repository) {
      const expected = expectedWifBinding(
        operation,
        organizationId,
        trustedBindings,
      );
      if (expected.repositoryId !== repository.id) {
        throw new Error("WIF_OPERATION_BINDING_UNTRUSTED");
      }
      return readExpected(operation, expected);
    },
  });
  TRUSTED_WIF_ADAPTERS.add(adapter);
  return adapter;
}

export async function reconcileTrustedWifBinding({
  operation,
  repository,
  wifAdapter,
} = {}) {
  if (
    !TRUSTED_WIF_ADAPTERS.has(wifAdapter) ||
    operation?.kind !== "gcp.wif-binding.ensure" ||
    !exactKeys(repository, ["fullName", "id", "sourceSha"]) ||
    !ID_PATTERN.test(repository.id ?? "") ||
    !/^seorilabs\/[A-Za-z0-9._-]+$/u.test(repository.fullName ?? "") ||
    !SHA_PATTERN.test(repository.sourceSha ?? "") ||
    operation.payload?.repositoryId !== repository.id
  ) {
    throw new Error("WIF_RECONCILIATION_REQUEST_INVALID");
  }
  let observation = await wifAdapter.readOperation(operation, repository);
  if (observation.state === "NOT_APPLIED") {
    await wifAdapter.applyOperation(operation, repository);
    observation = await wifAdapter.readOperation(operation, repository);
  }
  if (observation.state !== "BOUND") {
    throw new Error("WIF_RECONCILIATION_READBACK_FAILED");
  }
  return deepFreeze({
    bindingRevision: operation.payload.bindingRevision,
    jobWorkflowRef: operation.payload.jobWorkflowRef,
    logicalCredentialId: operation.payload.logicalCredentialId,
    observationDigest: sha256(canonicalJson(observation)),
    repositoryId: repository.id,
    state: "BOUND",
    workflowBundleDigest:
      operation.payload.approvedBundleDigest ??
      operation.payload.candidateBundleDigest,
  });
}

export async function readTrustedWifBinding({
  operation,
  repository,
  wifAdapter,
} = {}) {
  if (
    !TRUSTED_WIF_ADAPTERS.has(wifAdapter) ||
    operation?.kind !== "gcp.wif-binding.ensure" ||
    !exactKeys(repository, ["fullName", "id", "sourceSha"]) ||
    !ID_PATTERN.test(repository.id ?? "") ||
    !/^seorilabs\/[A-Za-z0-9._-]+$/u.test(repository.fullName ?? "") ||
    !SHA_PATTERN.test(repository.sourceSha ?? "") ||
    operation.payload?.repositoryId !== repository.id
  ) {
    throw new Error("WIF_READBACK_REQUEST_INVALID");
  }
  const observation = await wifAdapter.readOperation(operation, repository);
  if (observation.state !== "BOUND") {
    throw new Error("WIF_READBACK_MISSING");
  }
  return deepFreeze({
    bindingRevision: operation.payload.bindingRevision,
    jobWorkflowRef: operation.payload.jobWorkflowRef,
    logicalCredentialId: operation.payload.logicalCredentialId,
    observationDigest: sha256(canonicalJson(observation)),
    repositoryId: repository.id,
    state: "BOUND",
    workflowBundleDigest:
      operation.payload.approvedBundleDigest ??
      operation.payload.candidateBundleDigest,
  });
}

export function isTrustedWifAdapter(value) {
  return TRUSTED_WIF_ADAPTERS.has(value);
}

export function createTrustedExecutionStore({ provider } = {}) {
  if (
    provider === null ||
    typeof provider !== "object" ||
    ![
      provider.claimOperation,
      provider.completeOperation,
      provider.consumeProtectionApproval,
      provider.readExecutablePlan,
      provider.readProtectionApproval,
    ].every((callback) => typeof callback === "function")
  ) {
    throw new Error("EXECUTION_STORE_CONFIGURATION_INVALID");
  }
  const store = Object.freeze({
    async readExecutablePlan(request) {
      try {
        return clonePublic(
          await provider.readExecutablePlan(
            deepFreeze(structuredClone(request)),
          ),
          "EXECUTION_STORE_PLAN_READBACK_FAILED",
        );
      } catch {
        throw new Error("EXECUTION_STORE_PLAN_READBACK_FAILED");
      }
    },
    async readProtectionApproval(request) {
      try {
        return clonePublic(
          await provider.readProtectionApproval(
            deepFreeze(structuredClone(request)),
          ),
          "EXECUTION_STORE_APPROVAL_READBACK_FAILED",
        );
      } catch {
        throw new Error("EXECUTION_STORE_APPROVAL_READBACK_FAILED");
      }
    },
    async consumeProtectionApproval(request) {
      try {
        return clonePublic(
          await provider.consumeProtectionApproval(
            deepFreeze(structuredClone(request)),
          ),
          "EXECUTION_STORE_APPROVAL_CONSUMPTION_FAILED",
        );
      } catch {
        throw new Error("EXECUTION_STORE_APPROVAL_CONSUMPTION_FAILED");
      }
    },
    async claimOperation(request) {
      try {
        return await provider.claimOperation(
          deepFreeze(structuredClone(request)),
        );
      } catch {
        throw new Error("EXECUTION_STORE_OPERATION_CLAIM_FAILED");
      }
    },
    async completeOperation(request) {
      try {
        return clonePublic(
          await provider.completeOperation(request),
          "EXECUTION_STORE_OPERATION_COMPLETION_FAILED",
        );
      } catch {
        throw new Error("EXECUTION_STORE_OPERATION_COMPLETION_FAILED");
      }
    },
  });
  TRUSTED_EXECUTION_STORES.add(store);
  return store;
}

function operationTargetsRepository(operation, repository) {
  const payload = operation.payload;
  if (operation.kind.startsWith("control-plane.")) {
    return (
      payload.repository?.id === repository.id &&
      payload.repository?.fullName === repository.fullName &&
      payload.repository?.sourceSha === repository.sourceSha
    );
  }
  if (operation.kind.startsWith("github.bootstrap-pull-request.")) {
    return (
      payload.sourceSha === repository.sourceSha &&
      payload.headRef === `seori/fleet-bootstrap/${repository.id}`
    );
  }
  return (
    payload.repositoryId === repository.id &&
    payload.repositoryFullName === repository.fullName
  );
}

function validateIdentity(
  value,
  { organizationId, installationId, repository, requiresActiveRepository },
) {
  return (
    exactKeys(value, [
      "archived",
      "defaultBranch",
      "fullName",
      "installationId",
      "organizationId",
      "private",
      "repositoryId",
      "sourceSha",
    ]) &&
    value.organizationId === organizationId &&
    value.installationId === installationId &&
    value.repositoryId === repository.id &&
    value.fullName === repository.fullName &&
    value.sourceSha === repository.sourceSha &&
    typeof value.private === "boolean" &&
    typeof value.archived === "boolean" &&
    (value.defaultBranch === null ||
      (typeof value.defaultBranch === "string" &&
        value.defaultBranch.length > 0 &&
        value.defaultBranch.length <= 255)) &&
    (!requiresActiveRepository ||
      (value.private === true &&
        value.archived === false &&
        value.defaultBranch === "main" &&
        SHA_PATTERN.test(value.sourceSha ?? "")))
  );
}

function notAppliedObservation(observation, operation, repository) {
  return (
    exactKeys(observation, ["kind", "repositoryId", "state"]) &&
    observation.kind === operation.kind &&
    observation.repositoryId === repository.id &&
    observation.state === "NOT_APPLIED"
  );
}

function validateControlPlaneObservation(observation, operation, repository) {
  return (
    exactKeys(observation, ["kind", "repositoryId", "sourceSha", "state"]) &&
    observation.kind === operation.kind &&
    observation.repositoryId === repository.id &&
    observation.sourceSha === repository.sourceSha &&
    observation.state === "APPLIED"
  );
}

function validateGitHubObservation(observation, operation, repository) {
  const payload = operation.payload;
  if (operation.kind === "github.custom-properties.ensure") {
    return (
      exactKeys(observation, ["kind", "properties", "repositoryId"]) &&
      observation.kind === operation.kind &&
      observation.repositoryId === repository.id &&
      observation.properties !== null &&
      typeof observation.properties === "object" &&
      !Array.isArray(observation.properties) &&
      Object.entries(payload.properties).every(
        ([key, value]) => observation.properties[key] === value,
      )
    );
  }
  if (operation.kind === "github.environment.ensure") {
    return (
      exactKeys(observation, [
        "kind",
        "name",
        "protectedBranches",
        "repositoryId",
      ]) &&
      observation.kind === operation.kind &&
      observation.repositoryId === repository.id &&
      observation.name === payload.name &&
      observation.protectedBranches === payload.protectedBranches
    );
  }
  if (operation.kind.startsWith("github.bootstrap-pull-request.")) {
    return (
      exactKeys(observation, [
        "baseRef",
        "contentDigest",
        "headRef",
        "kind",
        "number",
        "path",
        "repositoryId",
        "sourceSha",
        "state",
      ]) &&
      observation.kind === operation.kind &&
      observation.repositoryId === repository.id &&
      Number.isSafeInteger(observation.number) &&
      observation.number > 0 &&
      (payload.number === undefined || observation.number === payload.number) &&
      observation.headRef === payload.headRef &&
      observation.baseRef === payload.baseRef &&
      observation.sourceSha === payload.sourceSha &&
      observation.path === payload.path &&
      observation.contentDigest === payload.contentDigest &&
      observation.state === "OPEN"
    );
  }
  if (operation.kind === "github.environment-variables.ensure") {
    return (
      exactKeys(observation, [
        "bindingRevision",
        "environment",
        "kind",
        "logicalCredentialId",
        "repositoryId",
        "variables",
      ]) &&
      observation.kind === operation.kind &&
      observation.repositoryId === repository.id &&
      observation.bindingRevision === payload.bindingRevision &&
      observation.environment === payload.environment &&
      observation.logicalCredentialId === payload.logicalCredentialId &&
      observation.variables !== null &&
      typeof observation.variables === "object" &&
      !Array.isArray(observation.variables) &&
      Object.entries(payload.variables).every(
        ([name, value]) => observation.variables[name] === value,
      )
    );
  }
  if (operation.kind === "github.org-secret-visibility.ensure") {
    return (
      exactKeys(observation, [
        "bindingRevision",
        "kind",
        "logicalCredentialId",
        "mutationMethod",
        "preservedSelectedRepositoryIds",
        "repositoryId",
        "secretName",
        "selectedRepositoryIds",
        "visibility",
      ]) &&
      observation.kind === operation.kind &&
      observation.repositoryId === repository.id &&
      observation.bindingRevision === payload.bindingRevision &&
      observation.logicalCredentialId === payload.logicalCredentialId &&
      observation.secretName === payload.secretName &&
      observation.visibility === "selected" &&
      observation.mutationMethod === "ADD_SELECTED_REPOSITORY" &&
      Array.isArray(observation.selectedRepositoryIds) &&
      Array.isArray(observation.preservedSelectedRepositoryIds) &&
      observation.selectedRepositoryIds.every((id) => ID_PATTERN.test(id)) &&
      observation.preservedSelectedRepositoryIds.every((id) =>
        observation.selectedRepositoryIds.includes(id),
      ) &&
      observation.selectedRepositoryIds.includes(repository.id)
    );
  }
  return false;
}

function validateExecutablePlanReadback(value, expected) {
  return (
    exactKeys(value, [
      "deliveryId",
      "generation",
      "installationId",
      "operationCount",
      "organizationId",
      "planDigest",
      "repositoryId",
      "sourceSha",
      "state",
    ]) &&
    value.state === "EXECUTABLE" &&
    Object.entries(expected).every(([key, item]) => value[key] === item) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

function validateProtectionApproval(value, expected, now) {
  const expiresAtMs = Date.parse(value?.expiresAt ?? "");
  const nowMs = now();
  return (
    exactKeys(value, [
      "approvalReceiptId",
      "consumedUses",
      "expiresAt",
      "generation",
      "maxUses",
      "organizationId",
      "planDigest",
      "providerMode",
      "purpose",
      "repositoryId",
      "sourceSha",
      "state",
    ]) &&
    ["AUTHORIZED", "CONSUMED"].includes(value.state) &&
    Object.entries(expected).every(([key, item]) => value[key] === item) &&
    value.maxUses === 1 &&
    value.consumedUses === (value.state === "AUTHORIZED" ? 0 : 1) &&
    ISO_DATE_PATTERN.test(value.expiresAt ?? "") &&
    Number.isFinite(expiresAtMs) &&
    Number.isFinite(nowMs) &&
    (value.state === "CONSUMED" ||
      (expiresAtMs > nowMs && expiresAtMs <= nowMs + MAX_OPERATION_LEASE_MS)) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

function validateConsumedProtectionApproval(value, authorized, expected, now) {
  return (
    validateProtectionApproval(value, expected, now) &&
    value.state === "CONSUMED" &&
    value.generation === authorized.generation + 1 &&
    value.expiresAt === authorized.expiresAt
  );
}

function validateProvisioningGateObservation(
  observation,
  gate,
  { organizationId, repository },
) {
  if (gate.providerMode === undefined) {
    return (
      exactKeys(observation, [
        "approvalReceiptId",
        "callerContentDigest",
        "callerPath",
        "callerSourceSha",
        "credentialApprovalReceiptId",
        "organizationId",
        "repositoryId",
        "requiredChecks",
        "rulesetEnforcement",
        "rulesetId",
        "state",
      ]) &&
      observation.organizationId === organizationId &&
      observation.repositoryId === repository.id &&
      observation.approvalReceiptId === gate.approvalReceiptId &&
      observation.credentialApprovalReceiptId ===
        gate.credentialApprovalReceiptId &&
      observation.callerContentDigest === gate.callerContentDigest &&
      observation.callerPath === gate.callerPath &&
      observation.callerSourceSha === repository.sourceSha &&
      canonicalJson(observation.requiredChecks) ===
        canonicalJson(gate.requiredChecks) &&
      observation.rulesetEnforcement === gate.rulesetEnforcement &&
      observation.rulesetId === gate.rulesetId &&
      observation.state === "READY"
    );
  }
  return (
    exactKeys(observation, [
      "callerContentDigest",
      "callerPath",
      "callerSourceSha",
      "credentialApprovalReceiptId",
      "organizationId",
      "protectionDigest",
      "providerMode",
      "repositoryId",
      "rolloutMode",
      "state",
    ]) &&
    observation.organizationId === organizationId &&
    observation.repositoryId === repository.id &&
    observation.callerContentDigest === gate.callerContentDigest &&
    observation.callerPath === gate.callerPath &&
    observation.callerSourceSha === repository.sourceSha &&
    observation.credentialApprovalReceiptId ===
      gate.credentialApprovalReceiptId &&
    observation.protectionDigest === gate.protectionDigest &&
    observation.providerMode === gate.providerMode &&
    observation.rolloutMode === "ACTIVE" &&
    observation.state === "READY"
  );
}

function validatePlanSemantics(plan) {
  const kinds = plan.operations.map(({ kind }) => kind);
  const allowedByOutcome = {
    ARCHIVED: ["control-plane.repository.archive"],
    BOOTSTRAP_PR_OPEN: [
      "control-plane.repository.observe",
      "github.custom-properties.ensure",
      "github.environment.ensure",
      "github.bootstrap-pull-request.ensure",
      "github.bootstrap-pull-request.update",
      "github.protection.reconcile",
    ],
    DUPLICATE: [],
    IGNORED: [],
    NEEDS_INPUT: ["control-plane.repository.observe"],
    PROVISIONING_READY: [
      "control-plane.repository.observe",
      "github.environment-variables.ensure",
      "github.org-secret-visibility.ensure",
      "gcp.wif-binding.ensure",
    ],
    READY: [
      "control-plane.repository.observe",
      "github.custom-properties.ensure",
      "github.environment.ensure",
      "github.bootstrap-pull-request.ensure",
      "github.bootstrap-pull-request.update",
      "github.protection.reconcile",
    ],
    WAITING_FOR_PR_SLOT: [
      "control-plane.repository.observe",
      "github.custom-properties.ensure",
      "github.environment.ensure",
      "github.protection.reconcile",
    ],
  };
  const allowed = allowedByOutcome[plan.outcome];
  if (!allowed || kinds.some((kind) => !allowed.includes(kind))) return false;
  if (
    new Set(plan.operations.map(({ idempotencyKey }) => idempotencyKey)).size !==
    plan.operations.length
  ) {
    return false;
  }
  const singletonKinds = kinds.filter(
    (kind) =>
      kind !== "github.org-secret-visibility.ensure" &&
      kind !== "gcp.wif-binding.ensure",
  );
  if (new Set(singletonKinds).size !== singletonKinds.length) return false;
  const ranks = kinds.map((kind) => OPERATION_ORDER[kind]);
  if (
    ranks.some(
      (rank, index) => index > 0 && rank < ranks[index - 1],
    )
  ) {
    return false;
  }
  if (["DUPLICATE", "IGNORED"].includes(plan.outcome)) {
    return kinds.length === 0;
  }
  if (plan.outcome === "ARCHIVED") {
    return kinds.length === 1 && kinds[0] === "control-plane.repository.archive";
  }
  if (plan.outcome === "NEEDS_INPUT") {
    return (
      kinds.length === 1 &&
      plan.operations[0].payload?.state === "needs_input"
    );
  }
  if (plan.outcome === "PROVISIONING_READY") {
    const provisioning = plan.operations.filter(
      ({ kind }) =>
        kind === "github.environment-variables.ensure" ||
        kind === "github.org-secret-visibility.ensure" ||
        kind === "gcp.wif-binding.ensure",
    );
    const observation = plan.operations[0];
    return (
      plan.operations.length === provisioning.length + 1 &&
      observation?.kind === "control-plane.repository.observe" &&
      observation.payload?.state === "active" &&
      provisioning.length > 0 &&
      provisioning.every(
        ({ payload }) =>
          canonicalJson(payload.provisioningGate) ===
          canonicalJson(provisioning[0].payload.provisioningGate),
      )
    );
  }
  return kinds[0] === "control-plane.repository.observe";
}

function claimBinding(expected) {
  return {
    idempotencyKey: expected.idempotencyKey,
    installationId: expected.installationId,
    operationKind: expected.operationKind,
    organizationId: expected.organizationId,
    planDigest: expected.planDigest,
    planGeneration: expected.planGeneration,
    repositoryId: expected.repositoryId,
    sourceSha: expected.sourceSha,
  };
}

function validClaim(claim, expected, now) {
  const binding = claimBinding(expected);
  if (
    exactKeys(claim, [
      ...Object.keys(binding),
      "expiresAt",
      "generation",
      "leaseToken",
      "state",
    ]) &&
    ["CLAIMED", "RESUME"].includes(claim.state)
  ) {
    const nowMs = now();
    const expiresAtMs = Date.parse(claim.expiresAt ?? "");
    return (
      Object.entries(binding).every(([key, value]) => claim[key] === value) &&
      Number.isSafeInteger(claim.generation) &&
      claim.generation > 0 &&
      Buffer.isBuffer(claim.leaseToken) &&
      claim.leaseToken.length >= 32 &&
      ISO_DATE_PATTERN.test(claim.expiresAt ?? "") &&
      Number.isFinite(nowMs) &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs > nowMs &&
      expiresAtMs <= nowMs + MAX_OPERATION_LEASE_MS
    );
  }
  return (
    exactKeys(claim, [
      ...Object.keys(binding),
      "generation",
      "receiptDigest",
      "state",
    ]) &&
    claim.state === "COMPLETED" &&
    Object.entries(binding).every(([key, value]) => claim[key] === value) &&
    Number.isSafeInteger(claim.generation) &&
    claim.generation > 0 &&
    DIGEST_PATTERN.test(claim.receiptDigest ?? "")
  );
}

function stableObservationWitness(operation, observation) {
  if (observation === undefined) return undefined;
  if (operation.kind === "github.custom-properties.ensure") {
    return {
      kind: observation.kind,
      properties: Object.fromEntries(
        Object.keys(operation.payload.properties)
          .sort()
          .map((key) => [key, observation.properties[key]]),
      ),
      repositoryId: observation.repositoryId,
    };
  }
  if (operation.kind === "github.org-secret-visibility.ensure") {
    return {
      bindingRevision: observation.bindingRevision,
      kind: observation.kind,
      logicalCredentialId: observation.logicalCredentialId,
      mutationMethod: observation.mutationMethod,
      repositoryId: observation.repositoryId,
      secretName: observation.secretName,
      visibility: observation.visibility,
    };
  }
  if (operation.kind === "github.environment-variables.ensure") {
    return {
      bindingRevision: observation.bindingRevision,
      environment: observation.environment,
      kind: observation.kind,
      logicalCredentialId: observation.logicalCredentialId,
      repositoryId: observation.repositoryId,
      variables: Object.fromEntries(
        CLOUD_BUILD_VARIABLE_NAMES.map((name) => [
          name,
          observation.variables[name],
        ]),
      ),
    };
  }
  if (operation.kind === "gcp.wif-binding.ensure") {
    const {
      providerEtag: _providerEtag,
      serviceAccountPolicyEtag: _serviceAccountPolicyEtag,
      ...stable
    } = observation;
    return stable;
  }
  return observation;
}

function durableOperationReceipt(operation, outcome, observation) {
  const witness = stableObservationWitness(operation, observation);
  return deepFreeze({
    idempotencyKey: operation.idempotencyKey,
    kind: operation.kind,
    observationDigest:
      witness === undefined ? null : sha256(canonicalJson(witness)),
    outcome,
    reason:
      outcome === "BLOCKED" ? "HUMAN_DECISION_REQUIRED" : null,
  });
}

function publicOperationReceipt(operation, outcome, observation) {
  return deepFreeze({
    ...durableOperationReceipt(operation, outcome, observation),
    readbackDigest:
      observation === undefined ? null : sha256(canonicalJson(observation)),
  });
}

function persistedOutcome(operation, readback) {
  if (operation.kind !== "github.protection.reconcile") return "APPLIED";
  if (operation.payload.rolloutMode === "SHADOW") return "OBSERVED";
  return readback.observation.state === "HUMAN_DECISION_REQUIRED"
    ? "BLOCKED"
    : "APPLIED";
}

export function createTrustedFleetExecutor({
  organizationId,
  installationId,
  approvedBundleBinding,
  readCallerBinding,
  githubAppAdapter,
  controlPlaneAdapter,
  wifAdapter,
  executionStore,
  now = () => Date.now(),
} = {}) {
  if (
    !ID_PATTERN.test(organizationId ?? "") ||
    !ID_PATTERN.test(installationId ?? "") ||
    approvedBundleBinding === null ||
    typeof approvedBundleBinding !== "object" ||
    typeof readCallerBinding !== "function" ||
    !TRUSTED_GITHUB_ADAPTERS.has(githubAppAdapter) ||
    !TRUSTED_CONTROL_PLANE_ADAPTERS.has(controlPlaneAdapter) ||
    !TRUSTED_WIF_ADAPTERS.has(wifAdapter) ||
    !TRUSTED_EXECUTION_STORES.has(executionStore) ||
    typeof now !== "function"
  ) {
    throw new Error("FLEET_EXECUTOR_CONFIGURATION_INVALID");
  }

  const repositoryContext = (repository) => ({
    fullName: repository.fullName,
    repositoryId: repository.id,
    sourceSha: repository.sourceSha,
  });

  async function readIdentity(repository, requiresActiveRepository) {
    let identity;
    try {
      identity = await githubAppAdapter.readIdentity(
        repositoryContext(repository),
      );
    } catch {
      throw new Error("FLEET_EXECUTOR_IDENTITY_READBACK_FAILED");
    }
    if (
      !validateIdentity(identity, {
        organizationId,
        installationId,
        repository,
        requiresActiveRepository,
      })
    ) {
      throw new Error("FLEET_EXECUTOR_IDENTITY_MISMATCH");
    }
  }

  async function validateCallerOperation(operation, repository) {
    if (!operation.kind.startsWith("github.bootstrap-pull-request.")) return;
    let callerBinding;
    try {
      callerBinding = await readCallerBinding(repositoryContext(repository));
    } catch {
      throw new Error("FLEET_EXECUTOR_CALLER_BINDING_READBACK_FAILED");
    }
    const validation = await validateOrgContractCaller(operation.payload.content, {
      approvedBundleBinding,
      callerBinding,
      repositoryContext: repositoryContext(repository),
    });
    if (
      !validation.ok ||
      operation.payload.contentDigest !== sha256(operation.payload.content)
    ) {
      throw new Error("FLEET_EXECUTOR_CALLER_UNTRUSTED");
    }
  }

  async function readOperation(operation, repository) {
    let observation;
    try {
      if (operation.kind.startsWith("control-plane.")) {
        observation = await controlPlaneAdapter.readOperation(
          operation,
          repository,
        );
        if (notAppliedObservation(observation, operation, repository)) {
          return { state: "NOT_APPLIED" };
        }
        if (!validateControlPlaneObservation(observation, operation, repository)) {
          throw new Error("mismatch");
        }
      } else if (operation.kind === "gcp.wif-binding.ensure") {
        observation = await wifAdapter.readOperation(operation, repository);
        if (observation.state === "NOT_APPLIED") {
          return { state: "NOT_APPLIED" };
        }
        if (observation.state !== "BOUND") throw new Error("mismatch");
      } else if (operation.kind === "github.protection.reconcile") {
        observation = await githubAppAdapter.readProtection(
          operation,
          repositoryContext(repository),
        );
      } else {
        observation = await githubAppAdapter.readOperation(
          operation,
          repositoryContext(repository),
        );
        if (notAppliedObservation(observation, operation, repository)) {
          return { state: "NOT_APPLIED" };
        }
        if (!validateGitHubObservation(observation, operation, repository)) {
          throw new Error("mismatch");
        }
      }
    } catch {
      throw new Error("FLEET_EXECUTOR_OPERATION_READBACK_FAILED");
    }
    return { state: "APPLIED", observation: structuredClone(observation) };
  }

  async function applyOperation(operation, repository) {
    try {
      if (operation.kind.startsWith("control-plane.")) {
        await controlPlaneAdapter.applyOperation(operation, repository);
      } else if (operation.kind === "gcp.wif-binding.ensure") {
        await wifAdapter.applyOperation(operation, repository);
      } else {
        await githubAppAdapter.applyOperation(
          operation,
          repositoryContext(repository),
        );
      }
    } catch {
      throw new Error("FLEET_EXECUTOR_OPERATION_APPLY_FAILED");
    }
  }

  async function requireProtectionApproval(
    approvalReceiptId,
    providerMode,
    repository,
    purpose,
    planDigest,
  ) {
    let readback;
    const expected = {
      approvalReceiptId,
      organizationId,
      planDigest,
      providerMode,
      purpose,
      repositoryId: repository.id,
      sourceSha: repository.sourceSha,
    };
    try {
      readback = await executionStore.readProtectionApproval(expected);
    } catch {
      throw new Error("FLEET_EXECUTOR_PROTECTION_APPROVAL_READBACK_FAILED");
    }
    if (!validateProtectionApproval(readback, expected, now)) {
      throw new Error("FLEET_EXECUTOR_PROTECTION_APPROVAL_MISMATCH");
    }
    if (readback.state === "CONSUMED") return;
    let consumed;
    try {
      consumed = await executionStore.consumeProtectionApproval({
        ...expected,
        expectedGeneration: readback.generation,
      });
    } catch {
      throw new Error("FLEET_EXECUTOR_PROTECTION_APPROVAL_CONSUMPTION_FAILED");
    }
    if (
      !validateConsumedProtectionApproval(consumed, readback, expected, now)
    ) {
      throw new Error("FLEET_EXECUTOR_PROTECTION_APPROVAL_CONSUMPTION_INVALID");
    }
  }

  return async function executeFleetBootstrapPlan(plan) {
    const snapshot = clonePublic(plan, "FLEET_EXECUTOR_PLAN_INVALID");
    const validation = await validateFleetBootstrapPlan(snapshot);
    if (!validation.ok || !validatePlanSemantics(snapshot)) {
      throw new Error("FLEET_EXECUTOR_PLAN_INVALID");
    }
    const repository = snapshot.repository;
    for (const operation of snapshot.operations) {
      if (!operationTargetsRepository(operation, repository)) {
        throw new Error("FLEET_EXECUTOR_OPERATION_TARGET_MISMATCH");
      }
      if (
        operation.idempotencyKey !==
        operationIdempotencyKey(operation, repository.id)
      ) {
        throw new Error("FLEET_EXECUTOR_IDEMPOTENCY_KEY_MISMATCH");
      }
      await validateCallerOperation(operation, repository);
    }

    const planDigest = sha256(canonicalJson(snapshot));
    const planReadbackExpected = {
      deliveryId: snapshot.deliveryId,
      installationId,
      operationCount: snapshot.operations.length,
      organizationId,
      planDigest,
      repositoryId: repository.id,
      sourceSha: repository.sourceSha,
    };
    let planReadback;
    try {
      planReadback = await executionStore.readExecutablePlan(
        planReadbackExpected,
      );
    } catch {
      throw new Error("FLEET_EXECUTOR_PLAN_READBACK_FAILED");
    }
    if (!validateExecutablePlanReadback(planReadback, planReadbackExpected)) {
      throw new Error("FLEET_EXECUTOR_PLAN_READBACK_MISMATCH");
    }

    const protectionOperation = snapshot.operations.find(
      ({ kind }) => kind === "github.protection.reconcile",
    );
    if (protectionOperation) {
      await readIdentity(repository, true);
      try {
        await githubAppAdapter.readProtectionCapability(
          protectionOperation,
          repositoryContext(repository),
        );
      } catch {
        throw new Error("FLEET_EXECUTOR_PROTECTION_CAPABILITY_MISMATCH");
      }
      if (protectionOperation.payload.rolloutMode === "ACTIVE") {
        await requireProtectionApproval(
          protectionOperation.payload.approvalReceiptId,
          protectionOperation.payload.providerMode,
          repository,
          "PROTECTION_STRENGTHEN",
          planDigest,
        );
      }
    }

    if (snapshot.outcome === "PROVISIONING_READY") {
      await readIdentity(repository, true);
      const provisioningOperations = snapshot.operations.slice(1);
      const gate = provisioningOperations[0].payload.provisioningGate;
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(
          gate.credentialApprovalReceiptId ?? "",
        ) ||
        gate.credentialApprovalReceiptId === gate.approvalReceiptId
      ) {
        throw new Error("FLEET_EXECUTOR_PROVISIONING_APPROVAL_REQUIRED");
      }
      await requireProtectionApproval(
        gate.credentialApprovalReceiptId,
        gate.providerMode ?? "ORG_RULESET",
        repository,
        "PROVISION_CREDENTIAL_BINDINGS",
        planDigest,
      );
      let gateObservation;
      try {
        gateObservation = await githubAppAdapter.readProvisioningGate(
          gate,
          repositoryContext(repository),
        );
      } catch {
        throw new Error("FLEET_EXECUTOR_PROVISIONING_GATE_READBACK_FAILED");
      }
      if (
        !validateProvisioningGateObservation(gateObservation, gate, {
          organizationId,
          repository,
        })
      ) {
        throw new Error("FLEET_EXECUTOR_PROVISIONING_GATE_MISMATCH");
      }
      const profile = snapshot.operations[0].payload.profile;
      const buildWorkflow = await resolveApprovedBuildWorkflowBinding(
        approvedBundleBinding,
        profile,
      );
      const jobWorkflowRef =
        `seorilabs/.github/${buildWorkflow.path}@${buildWorkflow.sha}`;
      if (
        provisioningOperations.some(
          ({ kind, payload }) =>
            payload.approvedBundleDigest !== buildWorkflow.bundleDigest ||
            (kind === "gcp.wif-binding.ensure" &&
              payload.jobWorkflowRef !== jobWorkflowRef),
        )
      ) {
        throw new Error("FLEET_EXECUTOR_APPROVED_BUNDLE_MISMATCH");
      }
    }

    const receipts = [];
    let blocked = false;
    for (const operation of snapshot.operations) {
      const requiresActiveRepository =
        !operation.kind.startsWith("control-plane.");
      await readIdentity(repository, requiresActiveRepository);

      const claimRequest = {
        idempotencyKey: operation.idempotencyKey,
        installationId,
        operationKind: operation.kind,
        organizationId,
        planDigest,
        planGeneration: planReadback.generation,
        repositoryId: repository.id,
        sourceSha: repository.sourceSha,
      };
      let claim;
      try {
        claim = await executionStore.claimOperation(claimRequest);
      } catch {
        throw new Error("FLEET_EXECUTOR_OPERATION_CLAIM_FAILED");
      }
      if (!validClaim(claim, claimRequest, now)) {
        if (Buffer.isBuffer(claim?.leaseToken)) claim.leaseToken.fill(0);
        throw new Error("FLEET_EXECUTOR_OPERATION_CLAIM_INVALID");
      }

      if (claim.state === "COMPLETED") {
        const readback = await readOperation(operation, repository);
        if (readback.state !== "APPLIED") {
          throw new Error("FLEET_EXECUTOR_COMPLETED_OPERATION_MISSING");
        }
        const outcome = persistedOutcome(operation, readback);
        const persistedReceipt = durableOperationReceipt(
          operation,
          outcome,
          readback.observation,
        );
        if (sha256(canonicalJson(persistedReceipt)) !== claim.receiptDigest) {
          throw new Error("FLEET_EXECUTOR_COMPLETED_RECEIPT_MISMATCH");
        }
        const publicOutcome = outcome === "BLOCKED" ? "BLOCKED" : "REPLAYED";
        receipts.push(
          publicOperationReceipt(
            operation,
            publicOutcome,
            readback.observation,
          ),
        );
        if (outcome === "BLOCKED") {
          blocked = true;
          break;
        }
        continue;
      }

      const leaseToken = claim.leaseToken;
      try {
        let readback;
        const readBeforeApply =
          claim.state === "RESUME" ||
          operation.kind === "github.protection.reconcile";
        if (readBeforeApply) {
          readback = await readOperation(operation, repository);
        }

        if (operation.kind === "github.protection.reconcile") {
          if (
            operation.payload.rolloutMode === "ACTIVE" &&
            readback.observation.state === "DRIFT"
          ) {
            await applyOperation(operation, repository);
            readback = await readOperation(operation, repository);
            if (readback.observation.state !== "MATCH") {
              throw new Error("FLEET_EXECUTOR_OPERATION_READBACK_FAILED");
            }
          }
        } else if (!readback || readback.state === "NOT_APPLIED") {
          await applyOperation(operation, repository);
          readback = await readOperation(operation, repository);
        }

        if (readback.state !== "APPLIED") {
          throw new Error("FLEET_EXECUTOR_OPERATION_READBACK_FAILED");
        }
        await readIdentity(repository, requiresActiveRepository);
        const outcome = persistedOutcome(operation, readback);
        const receipt = durableOperationReceipt(
          operation,
          outcome,
          readback.observation,
        );
        const receiptDigest = sha256(canonicalJson(receipt));
        let completion;
        try {
          completion = await executionStore.completeOperation({
            ...claimBinding(claimRequest),
            expiresAt: claim.expiresAt,
            generation: claim.generation,
            leaseToken,
            receipt: structuredClone(receipt),
            receiptDigest,
          });
        } catch {
          throw new Error("FLEET_EXECUTOR_OPERATION_COMPLETION_FAILED");
        }
        if (
          !exactKeys(completion, [
            ...Object.keys(claimBinding(claimRequest)),
            "generation",
            "receiptDigest",
            "state",
          ]) ||
          completion.state !== "COMPLETED" ||
          Object.entries(claimBinding(claimRequest)).some(
            ([key, value]) => completion[key] !== value,
          ) ||
          completion.generation !== claim.generation ||
          completion.receiptDigest !== receiptDigest
        ) {
          throw new Error("FLEET_EXECUTOR_OPERATION_COMPLETION_INVALID");
        }
        receipts.push(
          publicOperationReceipt(operation, outcome, readback.observation),
        );
        if (outcome === "BLOCKED") {
          blocked = true;
          break;
        }
      } finally {
        leaseToken.fill(0);
      }
    }

    return deepFreeze({
      schemaVersion: 1,
      planDigest,
      repository: structuredClone(repository),
      state: blocked ? "BLOCKED" : "COMPLETED",
      operations: receipts,
    });
  };
}

export const trustedFleetExecutorContract = Object.freeze({
  gcpIamApiOrigin: GCP_IAM_API_ORIGIN,
  gcpIamApiVersion: GCP_IAM_API_VERSION,
  githubApiOrigin: GITHUB_API_ORIGIN,
  githubApiVersion: GITHUB_API_VERSION,
  githubAppCredentialId: "shared/github/fleet-app",
  organizationLogin: ORGANIZATION_LOGIN,
  teamProtectionFallback: "REPO_BRANCH_PROTECTION",
});
