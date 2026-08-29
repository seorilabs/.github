import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createFleetStandardLabelsPlan,
  validateFleetBootstrapPlan,
} from "../packages/repo-contract/src/bootstrap.mjs";
import {
  FLEET_STANDARD_LABEL_CATALOG,
  FLEET_STANDARD_LABEL_CATALOG_DIGEST,
  fleetStandardLabelsPayload,
} from "../packages/repo-contract/src/standard-labels.mjs";
import {
  createGitHubAppTrustedAdapter,
  createTrustedControlPlaneAdapter,
  createTrustedExecutionStore,
  createTrustedFleetExecutor,
  createTrustedWifAdapter,
  trustedFleetExecutorContract,
} from "../packages/repo-contract/src/trusted-executor.mjs";

const ORGANIZATION_ID = "1001";
const INSTALLATION_ID = "2001";
const REPOSITORY_ID = "7001";
const SOURCE_SHA = "a".repeat(40);
const FULL_NAME = "seorilabs/example-app";
const NOW = Date.parse("2026-08-28T04:00:00.000Z");
const TOKEN_TEXT = "installation-token-must-not-escape";
const ORG_CHECK_APP_ID = "31001";
const SEORI_CHECK_APP_ID = "31002";
const CLOUD_BUILD_VARIABLES = Object.freeze({
  GOOGLE_WORKLOAD_IDENTITY_PROVIDER:
    "projects/123456789/locations/global/workloadIdentityPools/seorilabs/providers/github",
  SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT:
    "seori-cloud-build-executor@seorilabs-ci.iam.gserviceaccount.com",
  SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT:
    "seori-cloud-build-submitter@seorilabs-ci.iam.gserviceaccount.com",
});

function wifCapability(repositoryId, workflowName) {
  return {
    environment: "internal",
    repositoryId,
    jobWorkflowRef:
      `seorilabs/.github/.github/workflows/${workflowName}.yml@${"b".repeat(40)}`,
  };
}

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

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex")}`;
}

function operation(kind, payload) {
  return {
    kind,
    idempotencyKey: digest({ kind, repositoryId: REPOSITORY_ID, payload }),
    payload,
  };
}

function protectionOperation({
  approvalReceiptId = null,
  providerMode = "REPO_BRANCH_PROTECTION",
  rolloutMode = "SHADOW",
} = {}) {
  return operation("github.protection.reconcile", {
    approvalReceiptId,
    defaultBranch: "main",
    providerMode,
    repositoryFullName: FULL_NAME,
    repositoryId: REPOSITORY_ID,
    requiredStatusChecks: {
      checks: [
        {
          appId: ORG_CHECK_APP_ID,
          context: "Org Contract / Org Contract",
        },
        { appId: SEORI_CHECK_APP_ID, context: "Seori Review" },
      ],
      strict: true,
    },
    reviewPolicy: {
      dismissStaleReviews: true,
      requiredApprovingReviewCount: 1,
      requireLastPushApproval: true,
    },
    rolloutMode,
    sourceSha: SOURCE_SHA,
  });
}

function standardLabelsOperation() {
  return operation(
    "github.standard-labels.ensure",
    fleetStandardLabelsPayload({ id: REPOSITORY_ID, fullName: FULL_NAME }),
  );
}

function bootstrapPlan(protection) {
  return {
    schemaVersion: 1,
    deliveryId: "delivery-trusted-executor-0001",
    action: "created",
    outcome: "READY",
    reason: null,
    repository: {
      id: REPOSITORY_ID,
      fullName: FULL_NAME,
      sourceSha: SOURCE_SHA,
    },
    operations: [
      operation("control-plane.repository.observe", {
        repository: {
          id: REPOSITORY_ID,
          fullName: FULL_NAME,
          sourceSha: SOURCE_SHA,
        },
        state: "active",
        profile: "react-native",
      }),
      standardLabelsOperation(),
      protection,
    ],
  };
}

function customPropertiesPlan() {
  const base = bootstrapPlan(protectionOperation());
  return {
    ...base,
    operations: [
      base.operations[0],
      base.operations[1],
      operation("github.custom-properties.ensure", {
        repositoryId: REPOSITORY_ID,
        repositoryFullName: FULL_NAME,
        properties: {
          "fleet-managed": "true",
          "fleet-profile": "react-native",
          "fleet-ruleset": "shadow",
          "fleet-state": "active",
        },
      }),
    ],
  };
}

function needsInputLabelsPlan({ sourceSha = null } = {}) {
  const repository = {
    id: REPOSITORY_ID,
    fullName: FULL_NAME,
    sourceSha,
  };
  return {
    schemaVersion: 1,
    deliveryId: "delivery-standard-labels-0001",
    action: "created",
    outcome: "NEEDS_INPUT",
    reason: "PUBLIC_REPOSITORY_REQUIRES_POLICY",
    repository,
    operations: [
      operation("control-plane.repository.observe", {
        reason: "PUBLIC_REPOSITORY_REQUIRES_POLICY",
        repository,
        state: "needs_input",
      }),
      standardLabelsOperation(),
    ],
  };
}

function rawProtection({
  providerMode = "REPO_BRANCH_PROTECTION",
  unsupportedSettings = [],
} = {}) {
  return {
    allowDeletions: false,
    allowForcePushes: false,
    broadProtectionDigest: `sha256:${"1".repeat(64)}`,
    bypassActorsDigest: `sha256:${"2".repeat(64)}`,
    canApplyMonotonically: unsupportedSettings.length === 0,
    checks: [],
    defaultBranch: "main",
    enforceAdmins: true,
    providerMode,
    repositoryId: REPOSITORY_ID,
    requiredConversationResolution: true,
    requiredLinearHistory: false,
    restrictionsDigest: `sha256:${"3".repeat(64)}`,
    reviewPolicy: {
      dismissStaleReviews: false,
      requiredApprovingReviewCount: 0,
      requireCodeOwnerReviews: true,
      requireLastPushApproval: false,
    },
    strict: false,
    unsupportedSettings,
  };
}

function rawFromExpected(expected, repositoryId = REPOSITORY_ID) {
  return {
    ...structuredClone(expected),
    canApplyMonotonically: true,
    repositoryId,
  };
}

function harness({
  accountPlan = "TEAM",
  claimExpiresAt = new Date(NOW + 4 * 60 * 1000).toISOString(),
  completionGenerationOffset = 0,
  identitySourceSha = SOURCE_SHA,
  initialProtection = rawProtection(),
  initialLabels = FLEET_STANDARD_LABEL_CATALOG.labels,
  mutateLabelsAfterApply,
  identityArchived = false,
  identityDefaultBranch = "main",
  identityPrivate = true,
  mutateProtectionAfterApply,
  providerMode = "REPO_BRANCH_PROTECTION",
} = {}) {
  let protection = structuredClone(initialProtection);
  const permissionRequests = [];
  const issuedTokens = [];
  const controlPlaneState = new Map();
  const completedClaims = new Map();
  const consumedApprovals = new Map();
  const customProperties = {};
  let labels = structuredClone(initialLabels);
  let protectionApplyCount = 0;
  let githubOperationApplyCount = 0;
  let standardLabelApplyCount = 0;
  let approvalConsumeCount = 0;

  const issueInstallationToken = async (request) => {
    permissionRequests.push(structuredClone(request));
    const token = Buffer.from(TOKEN_TEXT.repeat(2), "utf8");
    issuedTokens.push(token);
    return {
      accountId: ORGANIZATION_ID,
      accountLogin: "seorilabs",
      expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
      installationId: INSTALLATION_ID,
      permissions: structuredClone(request.permissions),
      repositoryIds: [REPOSITORY_ID],
      token,
    };
  };

  const githubAppAdapter = createGitHubAppTrustedAdapter({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    issueInstallationToken,
    now: () => NOW,
    provider: {
      async addSecretRepositoryAccess() {
        throw new Error("unused");
      },
      async applyOperation({ operation: item }) {
        if (item.kind === "github.standard-labels.ensure") {
          githubOperationApplyCount += 1;
          standardLabelApplyCount += 1;
          const fixedNames = new Set(
            item.payload.labels.map(({ name }) => name.toLocaleLowerCase("en-US")),
          );
          labels = [
            ...labels.filter(
              ({ name }) => !fixedNames.has(name.toLocaleLowerCase("en-US")),
            ),
            ...structuredClone(item.payload.labels),
          ];
          if (mutateLabelsAfterApply) {
            labels = mutateLabelsAfterApply(structuredClone(labels));
          }
          return {
            catalogDigest: FLEET_STANDARD_LABEL_CATALOG_DIGEST,
            catalogVersion: FLEET_STANDARD_LABEL_CATALOG.catalogVersion,
            method: "UPSERT_FIXED_LABELS_PRESERVE_CUSTOM",
            repositoryId: REPOSITORY_ID,
            state: "UPDATED",
          };
        }
        if (item.kind !== "github.custom-properties.ensure") {
          throw new Error("unused");
        }
        githubOperationApplyCount += 1;
        Object.assign(customProperties, structuredClone(item.payload.properties));
      },
      async applyProtection(request) {
        protectionApplyCount += 1;
        assert.equal(request.strategy, "MONOTONIC_STRENGTHEN_ONLY");
        assert.equal(request.preserveBroadProtectionDigest, protection.broadProtectionDigest);
        assert.equal(request.preserveBypassActorsDigest, protection.bypassActorsDigest);
        assert.equal(request.preserveRestrictionsDigest, protection.restrictionsDigest);
        const expected = structuredClone(request.expectedPolicy);
        protection = rawFromExpected(expected);
        if (mutateProtectionAfterApply) {
          protection = mutateProtectionAfterApply(protection);
        }
        return {
          expectedPolicyDigest: digest(expected),
          method: "COMPARE_AND_SET_MONOTONIC_MERGE",
          previousActualDigest: request.expectedActualDigest,
          preservedBroadProtectionDigest: request.preserveBroadProtectionDigest,
          preservedBypassActorsDigest: request.preserveBypassActorsDigest,
          preservedRestrictionsDigest: request.preserveRestrictionsDigest,
          providerMode,
          repositoryId: REPOSITORY_ID,
          state: "UPDATED",
        };
      },
      async readIdentity({ apiOrigin, apiVersion, credential }) {
        assert.equal(apiOrigin, "https://api.github.com");
        assert.equal(apiVersion, "2026-03-10");
        assert.equal(credential.includes(Buffer.from("installation-token")), true);
        return {
          archived: identityArchived,
          defaultBranch: identityDefaultBranch,
          fullName: FULL_NAME,
          installationId: INSTALLATION_ID,
          organizationId: ORGANIZATION_ID,
          private: identityPrivate,
          repositoryId: REPOSITORY_ID,
          sourceSha: identitySourceSha,
        };
      },
      async readOperation({ operation: item }) {
        if (item.kind === "github.standard-labels.ensure") {
          return {
            kind: item.kind,
            labels: structuredClone(labels),
            repositoryId: REPOSITORY_ID,
          };
        }
        if (item.kind !== "github.custom-properties.ensure") {
          throw new Error("unused");
        }
        const satisfied = Object.entries(item.payload.properties).every(
          ([key, value]) => customProperties[key] === value,
        );
        return satisfied
          ? {
              kind: item.kind,
              properties: structuredClone(customProperties),
              repositoryId: REPOSITORY_ID,
            }
          : {
              kind: item.kind,
              repositoryId: REPOSITORY_ID,
              state: "NOT_APPLIED",
            };
      },
      async readProtection() {
        return structuredClone(protection);
      },
      async readProtectionCapability() {
        return {
          accountPlan,
          organizationId: ORGANIZATION_ID,
          organizationLogin: "seorilabs",
          providerMode,
        };
      },
      async readProvisioningGate() {
        throw new Error("unused");
      },
      async readSecretRepositoryAccess() {
        throw new Error("unused");
      },
    },
  });

  const controlPlaneAdapter = createTrustedControlPlaneAdapter({
    provider: {
      async applyOperation(item) {
        controlPlaneState.set(item.idempotencyKey, structuredClone(item));
      },
      async readOperation(item, repository) {
        if (!controlPlaneState.has(item.idempotencyKey)) {
          return { kind: item.kind, repositoryId: repository.id, state: "NOT_APPLIED" };
        }
        return {
          kind: item.kind,
          repositoryId: repository.id,
          sourceSha: repository.sourceSha,
          state: "APPLIED",
        };
      },
    },
  });

  const wifAdapter = createTrustedWifAdapter({
    organizationId: ORGANIZATION_ID,
    bindings: [],
    provider: {
      async applyBinding() {
        throw new Error("unused");
      },
      async readBinding() {
        throw new Error("unused");
      },
    },
  });

  const executionStore = createTrustedExecutionStore({
    provider: {
      async claimOperation(request) {
        const completed = completedClaims.get(request.idempotencyKey);
        if (completed) return structuredClone(completed);
        return {
          ...structuredClone(request),
          expiresAt: claimExpiresAt,
          generation: 1,
          leaseToken: Buffer.from("operation-lease-token-material-0001"),
          state: "CLAIMED",
        };
      },
      async completeOperation(request) {
        const completed = {
          idempotencyKey: request.idempotencyKey,
          installationId: request.installationId,
          operationKind: request.operationKind,
          organizationId: request.organizationId,
          planDigest: request.planDigest,
          planGeneration: request.planGeneration,
          repositoryId: request.repositoryId,
          sourceSha: request.sourceSha,
          generation: request.generation + completionGenerationOffset,
          receiptDigest: request.receiptDigest,
          state: "COMPLETED",
        };
        if (completionGenerationOffset === 0) {
          completedClaims.set(request.idempotencyKey, structuredClone(completed));
        }
        return completed;
      },
      async consumeProtectionApproval(request) {
        approvalConsumeCount += 1;
        const { expectedGeneration, ...expected } = request;
        const consumed = {
          ...structuredClone(expected),
          consumedUses: 1,
          expiresAt: new Date(NOW + 4 * 60 * 1000).toISOString(),
          generation: expectedGeneration + 1,
          maxUses: 1,
          state: "CONSUMED",
        };
        consumedApprovals.set(
          `${request.purpose}:${request.planDigest}`,
          structuredClone(consumed),
        );
        return consumed;
      },
      async readExecutablePlan(request) {
        return {
          ...structuredClone(request),
          generation: 1,
          state: "EXECUTABLE",
        };
      },
      async readProtectionApproval(request) {
        const consumed = consumedApprovals.get(
          `${request.purpose}:${request.planDigest}`,
        );
        if (consumed) return structuredClone(consumed);
        return {
          ...structuredClone(request),
          consumedUses: 0,
          expiresAt: new Date(NOW + 4 * 60 * 1000).toISOString(),
          generation: 1,
          maxUses: 1,
          state: "AUTHORIZED",
        };
      },
    },
  });

  const execute = createTrustedFleetExecutor({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    approvedBundleBinding: {},
    readCallerBinding: async () => {
      throw new Error("unused");
    },
    githubAppAdapter,
    controlPlaneAdapter,
    wifAdapter,
    executionStore,
    now: () => NOW,
  });

  return {
    approvalConsumeCount: () => approvalConsumeCount,
    execute,
    githubAppAdapter,
    issuedTokens,
    permissionRequests,
    protectionApplyCount: () => protectionApplyCount,
    githubOperationApplyCount: () => githubOperationApplyCount,
    standardLabelApplyCount: () => standardLabelApplyCount,
    addUnrelatedCustomProperty() {
      customProperties["unrelated-provider-property"] = "preserved";
    },
    addCustomLabel(label) {
      labels.push(structuredClone(label));
    },
    labels() {
      return structuredClone(labels);
    },
  };
}

test("표준 라벨은 public empty repo에도 고정 catalog만 적용하고 custom label을 보존한다", async () => {
  const existingCustom = {
    color: "ABCDEF",
    description: "repository custom",
    name: "product-area",
  };
  const concurrentCustom = {
    color: "123456",
    description: "concurrent custom",
    name: "release-train",
  };
  const drifted = [
    ...structuredClone(FLEET_STANDARD_LABEL_CATALOG.labels.slice(1)),
    existingCustom,
  ];
  const state = harness({
    identityDefaultBranch: null,
    identityPrivate: false,
    identitySourceSha: null,
    initialLabels: drifted,
    mutateLabelsAfterApply: (labels) => [...labels, concurrentCustom],
  });
  const plan = await createFleetStandardLabelsPlan({
    deliveryId: "label-reconcile-public-empty",
    repository: {
      archived: false,
      fullName: FULL_NAME,
      id: REPOSITORY_ID,
      private: false,
      sourceSha: null,
    },
  });
  assert.deepEqual(await validateFleetBootstrapPlan(plan), {
    diagnostics: [],
    ok: true,
  });

  const first = await state.execute(plan);
  assert.equal(first.state, "COMPLETED");
  assert.equal(state.standardLabelApplyCount(), 1);
  assert.deepEqual(
    state.labels().filter(({ name }) =>
      ["product-area", "release-train"].includes(name),
    ),
    [existingCustom, concurrentCustom],
  );
  assert.ok(
    FLEET_STANDARD_LABEL_CATALOG.labels.every((expected) =>
      state.labels().some(
        (actual) => canonicalJson(actual) === canonicalJson(expected),
      ),
    ),
  );
  assert.ok(
    state.permissionRequests.some(
      ({ permissions }) =>
        permissions.issues === "write" && permissions.metadata === "read",
    ),
  );

  state.addCustomLabel({
    color: "654321",
    description: "post completion",
    name: "owner-team",
  });
  const replay = await state.execute(plan);
  assert.equal(state.standardLabelApplyCount(), 1);
  assert.ok(replay.operations.every(({ outcome }) => outcome === "REPLAYED"));
});

test("표준 라벨 executor는 임의 label payload와 provider duplicate를 fail-closed한다", async () => {
  const valid = standardLabelsOperation();
  const forged = structuredClone(valid);
  forged.payload.labels[0].name = "approval:worker-bypass";
  const state = harness();
  await assert.rejects(
    state.githubAppAdapter.applyOperation(forged, {
      fullName: FULL_NAME,
      repositoryId: REPOSITORY_ID,
      sourceSha: SOURCE_SHA,
    }),
    /GITHUB_STANDARD_LABEL_OPERATION_UNTRUSTED/u,
  );
  assert.equal(state.standardLabelApplyCount(), 0);

  const duplicate = harness({
    identityDefaultBranch: null,
    identityPrivate: false,
    identitySourceSha: null,
    initialLabels: [
      ...structuredClone(FLEET_STANDARD_LABEL_CATALOG.labels),
      { color: "B60205", description: "duplicate", name: "p1" },
    ],
  });
  await assert.rejects(
    duplicate.execute(needsInputLabelsPlan()),
    /FLEET_EXECUTOR_OPERATION_APPLY_FAILED/u,
  );
  assert.equal(duplicate.standardLabelApplyCount(), 0);
});

test("Team SHADOW는 branch protection diff만 관찰하고 mutation하지 않는다", async () => {
  const item = protectionOperation();
  const plan = bootstrapPlan(item);
  assert.deepEqual(await validateFleetBootstrapPlan(plan), {
    diagnostics: [],
    ok: true,
  });
  const state = harness();
  const result = await state.execute(plan);

  assert.equal(result.state, "COMPLETED");
  assert.equal(result.operations.at(-1).outcome, "OBSERVED");
  assert.equal(state.protectionApplyCount(), 0);
  assert.equal(state.approvalConsumeCount(), 0);
  assert.ok(
    state.permissionRequests.some(
      ({ permissions }) => permissions.administration === "read",
    ),
  );
});

test("Team ACTIVE는 승인된 exact main 보호를 단조 강화하고 즉시 readback한다", async () => {
  const item = protectionOperation({
    approvalReceiptId: "approval-team-0001",
    rolloutMode: "ACTIVE",
  });
  const state = harness();
  const result = await state.execute(bootstrapPlan(item));

  assert.equal(result.state, "COMPLETED");
  assert.equal(result.operations.at(-1).outcome, "APPLIED");
  assert.equal(state.protectionApplyCount(), 1);
  assert.equal(state.approvalConsumeCount(), 1);
  assert.ok(
    state.permissionRequests.some(
      ({ permissions }) => permissions.administration === "write",
    ),
  );
});

test("actual strict=false는 MATCH로 오판하지 않고 ACTIVE에서 강화한다", async () => {
  const initial = rawProtection();
  initial.checks = [
    { appId: ORG_CHECK_APP_ID, context: "Org Contract / Org Contract" },
    { appId: SEORI_CHECK_APP_ID, context: "Seori Review" },
  ];
  initial.reviewPolicy = {
    dismissStaleReviews: true,
    requiredApprovingReviewCount: 2,
    requireCodeOwnerReviews: true,
    requireLastPushApproval: true,
  };
  const state = harness({ initialProtection: initial });
  await state.execute(
    bootstrapPlan(
      protectionOperation({
        approvalReceiptId: "approval-team-0002",
        rolloutMode: "ACTIVE",
      }),
    ),
  );
  assert.equal(state.protectionApplyCount(), 1);
  assert.equal(state.approvalConsumeCount(), 1);
});

test("unsupported 또는 안전하게 보존할 수 없는 보호 설정은 사람 결정으로 차단한다", async () => {
  const unsupported = rawProtection({ unsupportedSettings: ["bypass_actor"] });
  unsupported.checks = [
    { appId: ORG_CHECK_APP_ID, context: "Org Contract / Org Contract" },
    { appId: SEORI_CHECK_APP_ID, context: "Seori Review" },
  ];
  unsupported.reviewPolicy = {
    dismissStaleReviews: true,
    requiredApprovingReviewCount: 1,
    requireCodeOwnerReviews: true,
    requireLastPushApproval: true,
  };
  unsupported.strict = true;
  const state = harness({
    initialProtection: unsupported,
  });
  const result = await state.execute(
    bootstrapPlan(
      protectionOperation({
        approvalReceiptId: "approval-team-0003",
        rolloutMode: "ACTIVE",
      }),
    ),
  );

  assert.equal(result.state, "BLOCKED");
  assert.equal(result.operations.at(-1).reason, "HUMAN_DECISION_REQUIRED");
  assert.equal(state.protectionApplyCount(), 0);
});

test("ACTIVE 적용이 bypass/restriction/broad 설정을 바꾸면 fail-closed한다", async () => {
  const state = harness({
    mutateProtectionAfterApply(next) {
      return { ...next, bypassActorsDigest: `sha256:${"9".repeat(64)}` };
    },
  });
  await assert.rejects(
    state.execute(
      bootstrapPlan(
        protectionOperation({
          approvalReceiptId: "approval-team-0004",
          rolloutMode: "ACTIVE",
        }),
      ),
    ),
    /FLEET_EXECUTOR_OPERATION_APPLY_FAILED/u,
  );
  assert.equal(state.protectionApplyCount(), 1);
});

test("Enterprise와 Team provider mode가 실제 account plan과 다르면 mutation 전 거부한다", async () => {
  const state = harness({ accountPlan: "TEAM", providerMode: "ORG_RULESET" });
  await assert.rejects(
    state.execute(
      bootstrapPlan(
        protectionOperation({
          approvalReceiptId: "approval-org-0001",
          providerMode: "ORG_RULESET",
          rolloutMode: "ACTIVE",
        }),
      ),
    ),
    /FLEET_EXECUTOR_PROTECTION_CAPABILITY_MISMATCH/u,
  );
  assert.equal(state.protectionApplyCount(), 0);
});

test("Enterprise는 ORG_RULESET만 조직 관리 권한으로 실행한다", async () => {
  const state = harness({
    accountPlan: "ENTERPRISE",
    initialProtection: rawProtection({ providerMode: "ORG_RULESET" }),
    providerMode: "ORG_RULESET",
  });
  await state.execute(
    bootstrapPlan(
      protectionOperation({
        approvalReceiptId: "approval-org-0002",
        providerMode: "ORG_RULESET",
        rolloutMode: "ACTIVE",
      }),
    ),
  );
  assert.equal(state.protectionApplyCount(), 1);
  assert.ok(
    state.permissionRequests.some(
      ({ permissions }) => permissions.organization_administration === "write",
    ),
  );
});

test("Enterprise provisioning gate readback은 조직 ruleset과 exact caller bytes를 함께 읽는다", async () => {
  const requests = [];
  const adapter = createGitHubAppTrustedAdapter({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    now: () => NOW,
    issueInstallationToken: async (request) => {
      requests.push(structuredClone(request));
      return {
        accountId: ORGANIZATION_ID,
        accountLogin: "seorilabs",
        expiresAt: new Date(NOW + 4 * 60 * 1000).toISOString(),
        installationId: INSTALLATION_ID,
        permissions: structuredClone(request.permissions),
        repositoryIds: [REPOSITORY_ID],
        token: Buffer.from(TOKEN_TEXT.repeat(2), "utf8"),
      };
    },
    provider: {
      addSecretRepositoryAccess() {},
      applyOperation() {},
      applyProtection() {},
      readIdentity() {},
      readOperation() {},
      readProtection() {},
      readProtectionCapability() {},
      readProvisioningGate() {
        return {};
      },
      readSecretRepositoryAccess() {},
    },
  });
  await adapter.readProvisioningGate(
    { providerMode: "ORG_RULESET" },
    {
      fullName: FULL_NAME,
      repositoryId: REPOSITORY_ID,
      sourceSha: SOURCE_SHA,
    },
  );
  assert.deepEqual(requests.at(-1).permissions, {
    contents: "read",
    metadata: "read",
    organization_administration: "read",
  });
});

test("operation lease는 exact plan/repo/SHA에 묶이고 5분 초과 TTL을 거부한다", async () => {
  const state = harness({
    claimExpiresAt: new Date(NOW + 5 * 60 * 1000 + 1).toISOString(),
  });
  await assert.rejects(
    state.execute(bootstrapPlan(protectionOperation())),
    /FLEET_EXECUTOR_OPERATION_CLAIM_INVALID/u,
  );
  assert.equal(state.protectionApplyCount(), 0);
});

test("완료된 operation은 provider readback만 수행하고 다시 mutation하지 않는다", async () => {
  const state = harness();
  const plan = bootstrapPlan(
    protectionOperation({
      approvalReceiptId: "approval-team-0005",
      rolloutMode: "ACTIVE",
    }),
  );
  await state.execute(plan);
  const replay = await state.execute(plan);

  assert.equal(state.protectionApplyCount(), 1);
  assert.ok(replay.operations.every(({ outcome }) => outcome === "REPLAYED"));
});

test("custom property provider superset은 stable target receipt replay를 깨지 않는다", async () => {
  const state = harness();
  const plan = customPropertiesPlan();
  assert.deepEqual(await validateFleetBootstrapPlan(plan), {
    diagnostics: [],
    ok: true,
  });
  const first = await state.execute(plan);
  state.addUnrelatedCustomProperty();
  const replay = await state.execute(plan);
  const firstReceipt = first.operations.at(-1);
  const replayReceipt = replay.operations.at(-1);

  assert.equal(state.githubOperationApplyCount(), 1);
  assert.equal(replayReceipt.outcome, "REPLAYED");
  assert.equal(replayReceipt.observationDigest, firstReceipt.observationDigest);
  assert.notEqual(replayReceipt.readbackDigest, firstReceipt.readbackDigest);
});

test("stale generation completion은 성공으로 기록하지 않는다", async () => {
  const state = harness({ completionGenerationOffset: 1 });
  await assert.rejects(
    state.execute(bootstrapPlan(protectionOperation())),
    /FLEET_EXECUTOR_OPERATION_COMPLETION_INVALID/u,
  );
});

test("공개 environment variable과 secret/WIF adapter는 exact catalog 필드만 허용한다", async () => {
  const noOpGitHubProvider = {
    addSecretRepositoryAccess() {},
    applyOperation() {},
    applyProtection() {},
    readIdentity() {},
    readOperation() {},
    readProtection() {},
    readProtectionCapability() {},
    readProvisioningGate() {},
    readSecretRepositoryAccess() {},
  };
  assert.throws(
    () =>
      createGitHubAppTrustedAdapter({
        organizationId: ORGANIZATION_ID,
        installationId: INSTALLATION_ID,
        issueInstallationToken() {},
        provider: noOpGitHubProvider,
        secretBindings: [
          {
            bindingRevision: 1,
            logicalCredentialId: "shared/apps-in-toss/operator",
            secretName: "APPS_IN_TOSS_API_KEY",
            value: "must-not-be-accepted",
          },
        ],
      }),
    /GITHUB_APP_ADAPTER_CONFIGURATION_INVALID/u,
  );
  assert.throws(
    () =>
      createGitHubAppTrustedAdapter({
        organizationId: ORGANIZATION_ID,
        installationId: INSTALLATION_ID,
        issueInstallationToken() {},
        provider: noOpGitHubProvider,
        environmentVariableBindings: [
          {
            bindingRevision: 1,
            environment: "internal",
            logicalCredentialId: "shared/gcp/cloud-build",
            variables: CLOUD_BUILD_VARIABLES,
            password: "must-not-be-accepted",
          },
        ],
      }),
    /GITHUB_APP_ADAPTER_CONFIGURATION_INVALID/u,
  );
  const environmentAdapter = createGitHubAppTrustedAdapter({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    now: () => NOW,
    issueInstallationToken: async (request) => ({
      accountId: ORGANIZATION_ID,
      accountLogin: "seorilabs",
      expiresAt: new Date(NOW + 4 * 60 * 1000).toISOString(),
      installationId: INSTALLATION_ID,
      permissions: structuredClone(request.permissions),
      repositoryIds: [REPOSITORY_ID],
      token: Buffer.from(TOKEN_TEXT.repeat(2), "utf8"),
    }),
    provider: noOpGitHubProvider,
    environmentVariableBindings: [
      {
        bindingRevision: 1,
        environment: "internal",
        logicalCredentialId: "shared/gcp/cloud-build",
        variables: CLOUD_BUILD_VARIABLES,
      },
    ],
  });
  await assert.rejects(
    environmentAdapter.readOperation(
      {
        kind: "github.environment-variables.ensure",
        payload: {
          bindingRevision: 1,
          environment: "internal",
          logicalCredentialId: "shared/gcp/cloud-build",
          variables: {
            ...CLOUD_BUILD_VARIABLES,
            GOOGLE_WORKLOAD_IDENTITY_PROVIDER:
              "projects/987654321/locations/global/workloadIdentityPools/seorilabs/providers/github",
          },
        },
      },
      {
        fullName: FULL_NAME,
        repositoryId: REPOSITORY_ID,
        sourceSha: SOURCE_SHA,
      },
    ),
    /GITHUB_ENVIRONMENT_VARIABLE_BINDING_UNTRUSTED/u,
  );
  assert.throws(
    () =>
      createTrustedWifAdapter({
        organizationId: ORGANIZATION_ID,
        bindings: [
          {
            bindingRevision: 1,
            logicalCredentialId: "shared/gcp/cloud-build",
            projectNumber: "123456789",
            poolId: "seorilabs",
            providerPrefix: "repo",
            serviceAccountEmail:
              "seorilabs-ci-builder@seorilabs-ci.iam.gserviceaccount.com",
          },
        ],
        provider: { applyBinding() {}, readBinding() {} },
      }),
    /WIF_ADAPTER_CONFIGURATION_INVALID/u,
  );
  assert.doesNotThrow(() =>
    createTrustedWifAdapter({
      organizationId: ORGANIZATION_ID,
      bindings: [
        {
          bindingRevision: 1,
          capabilities: [
            wifCapability(REPOSITORY_ID, "rn-build-android-cloud-v1"),
          ],
          logicalCredentialId: "shared/gcp/cloud-build",
          providerResourceName:
            "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seorilabs/providers/github",
          serviceAccountEmail:
            "seorilabs-ci-builder@seorilabs-ci.iam.gserviceaccount.com",
        },
      ],
      provider: { applyBinding() {}, readBinding() {} },
    }),
  );
  assert.throws(
    () =>
      createTrustedWifAdapter({
        organizationId: ORGANIZATION_ID,
        bindings: [
          {
            bindingRevision: 1,
            capabilities: [
              wifCapability(REPOSITORY_ID, "rn-build-android-cloud-v1"),
            ],
            logicalCredentialId: "shared/gcp/cloud-build",
            providerResourceName:
              "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seorilabs/providers/github",
            serviceAccountEmail:
              "seorilabs-ci-builder@seorilabs-ci.iam.gserviceaccount.com",
          },
          {
            bindingRevision: 1,
            capabilities: [
              wifCapability("7002", "godot-build-android-cloud-v1"),
            ],
            logicalCredentialId: "shared/gcp/cloud-build-alt",
            providerResourceName:
              "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seorilabs/providers/github",
            serviceAccountEmail:
              "seorilabs-ci-runner@seorilabs-ci.iam.gserviceaccount.com",
          },
        ],
        provider: { applyBinding() {}, readBinding() {} },
      }),
    /WIF_ADAPTER_CONFIGURATION_INVALID/u,
  );
});

test("WIF는 shared provider의 exact repo-workflow pair와 repository principal을 사용한다", async () => {
  const expectedByRepository = new Map();
  const providerResourceName =
    "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/seorilabs/providers/github";
  const adapter = createTrustedWifAdapter({
    organizationId: ORGANIZATION_ID,
    bindings: [
      {
        bindingRevision: 1,
        capabilities: [
          wifCapability(REPOSITORY_ID, "rn-build-android-cloud-v1"),
          wifCapability("7002", "godot-build-android-cloud-v1"),
        ],
        logicalCredentialId: "shared/gcp/cloud-build",
        providerResourceName,
        serviceAccountEmail:
          "seorilabs-ci-builder@seorilabs-ci.iam.gserviceaccount.com",
      },
    ],
    provider: {
      async applyBinding({ expected }) {
        expectedByRepository.set(expected.repositoryId, structuredClone(expected));
        return {
          bindingRevision: expected.bindingRevision,
          logicalCredentialId: expected.logicalCredentialId,
          providerEtag: "provider-etag-0001",
          providerResourceName: expected.providerResourceName,
          repositoryId: expected.repositoryId,
          serviceAccountEmail: expected.serviceAccountEmail,
          serviceAccountPolicyEtag: "policy-etag-0001",
          state: "UPDATED",
        };
      },
      async readBinding({ expected }) {
        expectedByRepository.set(expected.repositoryId, structuredClone(expected));
        return {
          ...structuredClone(expected),
          providerEtag: "provider-etag-0001",
          serviceAccountPolicyEtag: "policy-etag-0001",
          state: "BOUND",
        };
      },
    },
  });
  const makeOperation = (repositoryId, workflowName) => ({
    kind: "gcp.wif-binding.ensure",
    payload: {
      approvedBundleDigest: `sha256:${"8".repeat(64)}`,
      bindingRevision: 1,
      environment: "internal",
      jobWorkflowRef: wifCapability(repositoryId, workflowName).jobWorkflowRef,
      logicalCredentialId: "shared/gcp/cloud-build",
      organizationId: ORGANIZATION_ID,
      repositoryId,
    },
  });
  const first = makeOperation(REPOSITORY_ID, "rn-build-android-cloud-v1");
  const second = makeOperation("7002", "godot-build-android-cloud-v1");
  await adapter.applyOperation(first, { id: REPOSITORY_ID });
  await adapter.readOperation(first, { id: REPOSITORY_ID });
  await adapter.applyOperation(second, { id: "7002" });
  await adapter.readOperation(second, { id: "7002" });

  const firstExpected = expectedByRepository.get(REPOSITORY_ID);
  const secondExpected = expectedByRepository.get("7002");
  assert.equal(firstExpected.providerResourceName, providerResourceName);
  assert.equal(secondExpected.providerResourceName, providerResourceName);
  assert.notEqual(firstExpected.principalSetMember, secondExpected.principalSetMember);
  assert.match(firstExpected.principalSetMember, /attribute\.repository_id\/7001$/u);
  assert.match(secondExpected.principalSetMember, /attribute\.repository_id\/7002$/u);
  assert.match(firstExpected.providerAttributeCondition, /repository_owner_id/u);
  assert.match(firstExpected.providerAttributeCondition, /job_workflow_ref/u);
  assert.match(firstExpected.providerAttributeCondition, /repository_id == '7001'/u);
  assert.match(firstExpected.providerAttributeCondition, /repository_id == '7002'/u);
  assert.deepEqual(firstExpected.providerAttributeMapping, {
    "google.subject": "assertion.sub",
    "attribute.repository": "assertion.repository",
    "attribute.repository_id": "assertion.repository_id",
    "attribute.job_workflow_ref": "assertion.job_workflow_ref",
  });
  assert.equal(
    firstExpected.providerAttributeCondition,
    secondExpected.providerAttributeCondition,
  );
  assert.equal(
    Object.hasOwn(firstExpected, "serviceAccountPolicyCondition"),
    false,
  );
});

test("public receipt와 contract에는 token 또는 secret export 표면이 없다", async () => {
  const state = harness();
  const result = await state.execute(bootstrapPlan(protectionOperation()));
  assert.doesNotMatch(JSON.stringify(result), /installation-token|lease-token/u);
  assert.doesNotMatch(JSON.stringify(trustedFleetExecutorContract), /private|password|token/u);
  assert.equal(Object.hasOwn(trustedFleetExecutorContract, "getSecret"), false);
  assert.ok(state.issuedTokens.every((token) => token.every((byte) => byte === 0)));
});
