import assert from "node:assert/strict";
import test from "node:test";

import {
  createFleetP7GateReport,
  loadFleetP3RuntimeContract,
} from "../scripts/fleet/p7-gate-report.mjs";

const contract = loadFleetP3RuntimeContract();

function openReadback() {
  const app = contract.github.app;
  const now = Date.now();
  const callerMigrationRepositories = contract.github.protection.repositories.map(
    (name) => {
      const fullName = `seorilabs/${name}`;
      const executor = contract.cloudBuild.executors.find(
        (candidate) => candidate.fullName === fullName,
      );
      return {
        repositoryId: executor.repositoryId,
        fullName,
        sourceSha: "a".repeat(40),
        status: "READY",
      };
    },
  );
  return {
    installation: {
      app_id: app.appId,
      app_slug: app.slug,
      id: app.installationId,
      repository_selection: app.repositorySelection,
      suspended_at: null,
      permissions: structuredClone(app.permissions),
      events: [...app.events],
    },
    organizationCustomProperties: structuredClone(
      contract.github.customProperties,
    ),
    protection: {
      providerMode: "REPO_BRANCH_PROTECTION",
      rolloutMode: "SHADOW",
      observationMode: "READ_ONLY",
      existingProtectionChanged: false,
      activationAllowed: false,
      repositories: callerMigrationRepositories.map(({ repositoryId, fullName }) => ({
        repositoryId, fullName, branch: "main", observedAt: new Date(now).toISOString(),
        state: "OBSERVED", identityExact: true,
        snapshotDigest: `sha256:${"d".repeat(64)}`,
        requiredStatusCheck: contract.github.protection.requiredStatusCheck,
      })),
    },
    defaultBranchOrgContractCallers: contract.github.protection.repositories.map(
      (name) => ({ fullName: `seorilabs/${name}` }),
    ),
    cloudBuildBindings: {
      workloadIdentityProvider: contract.cloudBuild.provider,
      submitterServiceAccount: contract.cloudBuild.submitter.serviceAccountEmail,
      repositoryBindings:
        contract.cloudBuild.githubActions.repositoryBindings.map(
          ({ fullName, repositoryId, variables }) => ({
            fullName,
            repositoryId,
            executorServiceAccount:
              variables.SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT,
          }),
        ),
    },
    callerMigration: {
      contract: "seorilabs-fleet-caller-migration-readback-v1",
      inventoryId: "fleet-caller-inventory-20260831",
      inventoryDigest: `sha256:${"b".repeat(64)}`,
      observedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 14 * 60 * 1_000).toISOString(),
      detectorSourceSha: "c".repeat(40),
      currentCentralSourceSha: "c".repeat(40),
      coverage: {
        complete: true,
        nextCursor: null,
        activeRepositoryCount: callerMigrationRepositories.length,
        scannedRepositoryCount: callerMigrationRepositories.length,
      },
      counts: {
        workflowSecretsInherit: 0,
        workflowFloatingRef: 0,
      },
      repositories: callerMigrationRepositories,
    },
    publicRepositories: [],
  };
}

function gateById(report, id) {
  return report.gates.find((gate) => gate.id === id);
}

test("SHADOW 관측 완료는 보호 정책 ACTIVE 실행 권한을 만들지 않는다", () => {
  const report = createFleetP7GateReport(openReadback(), contract);
  assert.equal(report.mode, "PLAN_ONLY");
  assert.equal(report.executionAllowed, false);
  assert.deepEqual(report.machineBlocked, []);
  assert.deepEqual(report.humanApprovalRequired, ["REPOSITORY_PROTECTION_ACTIVATION"]);
  assert.equal(gateById(report, "PROTECTION_SHADOW_READBACK").state, "OPEN");
});

test("GitHub App 권한과 repository event 부족은 사람 승인 gate로 남는다", () => {
  const readback = openReadback();
  readback.installation.permissions.pull_requests = "read";
  delete readback.installation.permissions.workflows;
  readback.installation.events = readback.installation.events.filter(
    (event) => event !== "repository",
  );
  const report = createFleetP7GateReport(readback, contract);
  const gate = gateById(report, "GITHUB_APP_CAPABILITY");
  assert.equal(gate.state, "HUMAN_APPROVAL_REQUIRED");
  assert.equal(gate.code, "GITHUB_APP_CAPABILITY_UNVERIFIED");
  assert.equal(gate.automaticRetry, false);
  assert.equal(gate.requiredRole, "organization_owner");
  assert.deepEqual(gate.detail.missingEvents, ["repository"]);
  assert.deepEqual(gate.detail.missingPermissions, [
    "pull_requests:read->write",
    "workflows:absent->write",
  ]);
  assert.equal(report.executionAllowed, false);
  assert.deepEqual(report.humanApprovalRequired, ["GITHUB_APP_CAPABILITY", "REPOSITORY_PROTECTION_ACTIVATION"]);
});

test("조직 custom property schema가 비어 있으면 machine gate로 닫는다", () => {
  const readback = openReadback();
  readback.organizationCustomProperties = [];
  const gate = gateById(
    createFleetP7GateReport(readback, contract),
    "ORG_CUSTOM_PROPERTY_SCHEMA",
  );
  assert.equal(gate.state, "MACHINE_BLOCKED");
  assert.equal(gate.code, "ORG_CUSTOM_PROPERTY_SCHEMA_MISSING");
  assert.deepEqual(gate.detail.missing, [
    "fleet-managed",
    "fleet-profile",
    "fleet-ruleset",
    "fleet-state",
  ]);
});

test("custom property는 이름만 같고 정의가 다르면 열리지 않는다", () => {
  for (const [field, mutate] of [
    ["value_type", (property) => {
      property.value_type = "string";
    }],
    ["allowed_values", (property) => {
      property.allowed_values = ["true", "false", "maybe"];
    }],
    ["values_editable_by", (property) => {
      property.values_editable_by = "org_and_repo_actors";
    }],
    ["required", (property) => {
      property.required = true;
    }],
  ]) {
    const readback = openReadback();
    const target = readback.organizationCustomProperties.find(
      ({ property_name: name }) => name === "fleet-managed",
    );
    mutate(target);
    const gate = gateById(
      createFleetP7GateReport(readback, contract),
      "ORG_CUSTOM_PROPERTY_SCHEMA",
    );
    assert.equal(gate.state, "MACHINE_BLOCKED", field);
    assert.deepEqual(gate.detail.missing, []);
    assert.deepEqual(gate.detail.mismatched, [`fleet-managed:${field}`]);
  }
});

test("보호 조회의 대상과 시간 및 caller coverage를 검증한다", () => {
  for (const [mutate, blocker] of [
    [
      (readback) => { readback.protection.repositories = []; },
      "PROTECTION_TARGET_COVERAGE_INCOMPLETE",
    ],
    [
      (readback) => { readback.protection.rolloutMode = "ACTIVE"; },
      "PROTECTION_MODE_MISMATCH",
    ],
    [
      (readback) => { readback.protection.repositories[0].repositoryId = "42"; },
      "PROTECTION_TARGET_READBACK_INVALID",
    ],
    [
      (readback) => { readback.protection.repositories[0].observedAt = "2000-01-01T00:00:00Z"; },
      "PROTECTION_READBACK_STALE",
    ],
    [
      (readback) => {
        readback.defaultBranchOrgContractCallers = [];
      },
      "DEFAULT_BRANCH_ORG_CONTRACT_CALLER_ABSENT",
    ],
  ]) {
    const readback = openReadback();
    mutate(readback);
    const gate = gateById(
      createFleetP7GateReport(readback, contract),
      "PROTECTION_SHADOW_READBACK",
    );
    assert.equal(gate.state, "MACHINE_BLOCKED", blocker);
    assert.equal(gate.code, "PROTECTION_SHADOW_READBACK_INVALID");
    assert.equal(gate.detail.requiredCheck, "Org Contract / Org Contract");
    assert.ok(gate.detail.blockers.includes(blocker), gate.detail.blockers.join(","));
  }
});

test("Cloud Build keyless binding이 비어 있으면 IAM을 만들지 않고 사람 승인 gate로 남는다", () => {
  const readback = openReadback();
  readback.cloudBuildBindings = {
    workloadIdentityProvider:
      "projects/138773558853/locations/global/workloadIdentityPools/github-actions/providers/seorilabs-github",
    submitterServiceAccount: "",
    repositoryBindings: [],
  };
  const gate = gateById(
    createFleetP7GateReport(readback, contract),
    "CLOUD_BUILD_WIF_BINDING",
  );
  assert.equal(gate.state, "HUMAN_APPROVAL_REQUIRED");
  assert.equal(gate.code, "FLEET_CLOUD_BUILD_WIF_BINDING_UNVERIFIED");
  assert.equal(
    gate.operation,
    "FLEET_P3_PER_APP_ANDROID_EXECUTOR_ACTIVATION",
  );
  assert.deepEqual(gate.detail.mismatched, [
    "repositoryBindings",
    "submitterServiceAccount",
    "workloadIdentityProvider",
  ]);
});

test("readback이 없으면 열린 gate로 취급하지 않는다", () => {
  const report = createFleetP7GateReport({}, contract);
  assert.equal(report.executionAllowed, false);
  assert.deepEqual(report.machineBlocked.toSorted(), [
    "CALLER_MIGRATION_CONFORMANCE",
    "CENTRAL_PUBLIC_RELEASE_PROFILE",
    "CLOUD_BUILD_WIF_BINDING",
    "GITHUB_APP_CAPABILITY",
    "ORG_CUSTOM_PROPERTY_SCHEMA",
    "PROTECTION_SHADOW_READBACK",
  ]);
});

test("floating ref와 secrets inherit가 남은 caller inventory는 P7을 열지 않는다", () => {
  const readback = openReadback();
  readback.callerMigration.counts = {
    workflowSecretsInherit: 24,
    workflowFloatingRef: 22,
  };
  readback.callerMigration.repositories[0].status = "NEEDS_CHANGE";
  const gate = gateById(
    createFleetP7GateReport(readback, contract),
    "CALLER_MIGRATION_CONFORMANCE",
  );
  assert.equal(gate.state, "MACHINE_BLOCKED");
  assert.equal(gate.code, "FLEET_CALLER_MIGRATION_INCOMPLETE");
  assert.deepEqual(gate.detail.counts, {
    workflowSecretsInherit: 24,
    workflowFloatingRef: 22,
  });
  assert.deepEqual(gate.detail.blockers, [
    "CALLER_MIGRATION_FLOATING_REF_REMAINS",
    "CALLER_MIGRATION_REPOSITORY_INCOMPLETE",
    "CALLER_MIGRATION_SECRET_INHERITANCE_REMAINS",
  ]);
  assert.deepEqual(gate.detail.needsChangeRepositories, [
    readback.callerMigration.repositories[0].fullName,
  ]);
});

test("caller inventory의 detector drift, pagination과 TTL을 각각 fail-closed한다", () => {
  const readback = openReadback();
  readback.callerMigration.currentCentralSourceSha = "d".repeat(40);
  readback.callerMigration.coverage.complete = false;
  readback.callerMigration.coverage.nextCursor = "next-page";
  readback.callerMigration.expiresAt = new Date(Date.now() - 1_000).toISOString();
  const gate = gateById(
    createFleetP7GateReport(readback, contract),
    "CALLER_MIGRATION_CONFORMANCE",
  );
  assert.equal(gate.state, "MACHINE_BLOCKED");
  assert.deepEqual(gate.detail.blockers, [
    "CALLER_MIGRATION_COVERAGE_INCOMPLETE",
    "CALLER_MIGRATION_DETECTOR_SOURCE_DRIFT",
    "CALLER_MIGRATION_READBACK_EXPIRED",
  ]);
});

test("public repo가 wave에 있으면 중앙 public release profile을 먼저 요구한다", () => {
  const readback = openReadback();
  readback.publicRepositories = [
    { fullName: "seorilabs/periodic-table-app", requiresRelease: true },
    { fullName: "seorilabs/gemini-pr-bot", requiresRelease: false },
  ];
  const blocked = createFleetP7GateReport(readback, contract).gates.find(
    ({ id }) => id === "CENTRAL_PUBLIC_RELEASE_PROFILE",
  );
  assert.equal(blocked.state, "MACHINE_BLOCKED");
  assert.equal(blocked.code, "CENTRAL_PUBLIC_RELEASE_PROFILE_REQUIRED");
  assert.deepEqual(blocked.detail.blockedRepositories, [
    "seorilabs/periodic-table-app",
  ]);
  assert.equal(blocked.detail.requiredProfile, "public-stable-tag-release");

  // 임의 문자열 profile 목록으로는 열리지 않는다. 별도 worker의 signed approved
  // binding 계약이 중앙에 올라오기 전까지 blocker로 남는다.
  readback.centralReleaseProfiles = ["public-stable-tag-release"];
  const stillBlocked = createFleetP7GateReport(readback, contract).gates.find(
    ({ id }) => id === "CENTRAL_PUBLIC_RELEASE_PROFILE",
  );
  assert.equal(stillBlocked.state, "MACHINE_BLOCKED");
  assert.equal(
    stillBlocked.detail.approvedBindingContract,
    "pending-central-signed-profile-binding",
  );
});
