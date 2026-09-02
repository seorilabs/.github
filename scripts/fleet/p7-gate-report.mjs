#!/usr/bin/env node

// P7 wave rollout의 실행 전 gate를 한 곳에서 판정한다. 이 스크립트는 provider를 직접
// 호출하지 않고 read-only readback 문서만 입력으로 받는다. 따라서 secret, token,
// installation token, 승인 receipt를 다루지 않으며 어떤 외부 상태도 바꾸지 않는다.
// 열린 gate만으로 실행을 허가하지 않고, 닫힌 gate를 machine/human으로 구분해 보고한다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

const contractPath = fileURLToPath(
  new URL("../../contracts/fleet-p3-runtime.yaml", import.meta.url),
);

const PERMISSION_RANK = Object.freeze({ read: 1, write: 2, admin: 3 });
const PUBLIC_RELEASE_PROFILE_ID = "public-stable-tag-release";
const CALLER_MIGRATION_READBACK_CONTRACT =
  "seorilabs-fleet-caller-migration-readback-v1";
const CALLER_MIGRATION_MAX_TTL_MS = 15 * 60 * 1000;
const CALLER_MIGRATION_MAX_CLOCK_SKEW_MS = 60 * 1000;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const REPOSITORY_FULL_NAME_PATTERN = /^seorilabs\/[A-Za-z0-9._-]+$/u;

function permissionSatisfies(actual, required) {
  return (PERMISSION_RANK[actual] ?? 0) >= (PERMISSION_RANK[required] ?? 0);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

// GitHub App gate는 조직 owner만 열 수 있다. 자동 재시도 대상이 아니므로 부족한 권한과
// event를 정확히 나열하고 HUMAN_APPROVAL_REQUIRED로 남긴다.
function githubAppGate(contract, installation) {
  const desired = contract.github.app;
  const gate = desired.humanGate;
  if (installation === undefined || installation === null) {
    return {
      id: "GITHUB_APP_CAPABILITY",
      state: "MACHINE_BLOCKED",
      code: "GITHUB_APP_INSTALLATION_READBACK_MISSING",
      operation: gate.operation,
      detail: {},
    };
  }
  const identityMismatch = [];
  if (installation.app_id !== desired.appId) identityMismatch.push("app_id");
  if (installation.app_slug !== desired.slug) identityMismatch.push("slug");
  if (installation.id !== desired.installationId) {
    identityMismatch.push("installation_id");
  }
  if (installation.repository_selection !== desired.repositorySelection) {
    identityMismatch.push("repository_selection");
  }
  if ((installation.suspended_at ?? null) !== null) {
    identityMismatch.push("suspended_at");
  }
  const current = installation.permissions ?? {};
  const missingPermissions = Object.entries(desired.permissions)
    .filter(([name, required]) => !permissionSatisfies(current[name], required))
    .map(([name, required]) => `${name}:${current[name] ?? "absent"}->${required}`)
    .sort((left, right) => left.localeCompare(right));
  const acceptedEvents = new Set(installation.events ?? []);
  const missingEvents = desired.events
    .filter((event) => !acceptedEvents.has(event))
    .sort((left, right) => left.localeCompare(right));
  const open =
    identityMismatch.length === 0 &&
    missingPermissions.length === 0 &&
    missingEvents.length === 0;
  return {
    id: "GITHUB_APP_CAPABILITY",
    state: open ? "OPEN" : "HUMAN_APPROVAL_REQUIRED",
    code: open ? null : "GITHUB_APP_CAPABILITY_UNVERIFIED",
    operation: gate.operation,
    requiredRole: gate.requiredRole,
    automaticRetry: gate.automaticRetry,
    detail: {
      identityMismatch,
      missingPermissions,
      missingEvents,
    },
  };
}

// 조직 custom property schema는 zero-touch caller bootstrap의 전제다. 없으면 wave 대상
// 분류 자체가 성립하지 않으므로 machine gate로 닫는다.
const CUSTOM_PROPERTY_FIELDS = Object.freeze([
  "value_type",
  "required",
  "allowed_values",
  "values_editable_by",
  "require_explicit_values",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonical(value[key])]),
  );
}

function customPropertyGate(contract, schema) {
  const contractProperties = contract.github.customProperties ?? [];
  const required = sortedUnique(
    contractProperties.map((property) => property.property_name),
  );
  if (!Array.isArray(schema)) {
    return {
      id: "ORG_CUSTOM_PROPERTY_SCHEMA",
      state: "MACHINE_BLOCKED",
      code: "ORG_CUSTOM_PROPERTY_READBACK_MISSING",
      detail: { required },
    };
  }
  const byName = new Map(
    schema.map((property) => [property.property_name, property]),
  );
  const missing = [];
  const mismatched = [];
  for (const expected of contractProperties) {
    const actual = byName.get(expected.property_name);
    if (actual === undefined) {
      missing.push(expected.property_name);
      continue;
    }
    // 이름만 같고 정의가 다르면 잘못된 값이 들어올 수 있으므로 필드를 정확히 대조한다.
    const differing = CUSTOM_PROPERTY_FIELDS.filter(
      (field) =>
        Object.hasOwn(expected, field) &&
        JSON.stringify(canonical(actual[field])) !==
          JSON.stringify(canonical(expected[field])),
    );
    if (differing.length > 0) {
      mismatched.push(`${expected.property_name}:${differing.join("+")}`);
    }
  }
  const open = missing.length === 0 && mismatched.length === 0;
  return {
    id: "ORG_CUSTOM_PROPERTY_SCHEMA",
    state: open ? "OPEN" : "MACHINE_BLOCKED",
    code: open ? null : "ORG_CUSTOM_PROPERTY_SCHEMA_MISSING",
    detail: { required, missing, mismatched: mismatched.sort() },
  };
}

// Team의 중앙 SHADOW는 실제 설정을 읽기만 한다. 관측 완료와 ACTIVE 승인/적용은
// 별도 gate이며, Enterprise Evaluate ruleset을 만들거나 기존 보호를 완화하지 않는다.
function protectionGate(contract, protection, callerRepositories, now) {
  const desired = contract.github.protection;
  const requiredCheck = desired.requiredStatusCheck;
  const targets = sortedUnique(
    (desired.repositories ?? []).map((name) => `seorilabs/${name}`),
  );
  if (!Array.isArray(protection?.repositories) || !Array.isArray(callerRepositories)) {
    return {
      id: "PROTECTION_SHADOW_READBACK",
      state: "MACHINE_BLOCKED",
      code: "PROTECTION_READBACK_MISSING",
      detail: { requiredCheck, targets },
    };
  }
  const blockers = [];
  if (protection.providerMode !== desired.providerMode
    || protection.rolloutMode !== "SHADOW" || protection.observationMode !== "READ_ONLY"
    || protection.existingProtectionChanged !== false || protection.activationAllowed !== false) {
    blockers.push("PROTECTION_MODE_MISMATCH");
  }
  if (protection.repositories.length !== targets.length) blockers.push("PROTECTION_TARGET_COVERAGE_INCOMPLETE");
  for (const fullName of targets) {
    const matches = protection.repositories.filter((row) => row.fullName === fullName);
    const row = matches[0];
    const expected = contract.cloudBuild.githubActions.repositoryBindings.find((binding) => binding.fullName === fullName);
    const time = Date.parse(row?.observedAt);
    if (matches.length !== 1 || row?.repositoryId !== expected?.repositoryId
      || row?.branch !== desired.branch || row?.state !== "OBSERVED" || row?.identityExact !== true
      || row?.requiredStatusCheck !== requiredCheck || !DIGEST_PATTERN.test(row?.snapshotDigest ?? "")) {
      blockers.push("PROTECTION_TARGET_READBACK_INVALID");
    }
    if (!Number.isFinite(time) || time > now() + 60_000 || now() - time > 15 * 60_000) {
      blockers.push("PROTECTION_READBACK_STALE");
    }
  }
  // required check를 실제로 만드는 default branch caller가 대상 repo마다 있어야 한다.
  const callers = new Set(
    callerRepositories.map(({ fullName }) => fullName),
  );
  const uncovered = targets.filter((fullName) => !callers.has(fullName));
  if (uncovered.length > 0) {
    blockers.push("DEFAULT_BRANCH_ORG_CONTRACT_CALLER_ABSENT");
  }
  return {
    id: "PROTECTION_SHADOW_READBACK",
    state: blockers.length === 0 ? "OPEN" : "MACHINE_BLOCKED",
    code: blockers.length === 0 ? null : "PROTECTION_SHADOW_READBACK_INVALID",
    detail: {
      requiredCheck,
      targets,
      blockers: sortedUnique(blockers),
      uncoveredRepositories: uncovered,
    },
  };
}

// Cloud Build keyless 경로는 공개 식별자만 비교한다. 값이 비어 있거나 다르면 IAM 생성이
// 필요하므로 role/key를 만들지 않고 human gate로 남긴다.
function cloudBuildGate(contract, bindings) {
  const desired = contract.cloudBuild;
  const expected = {
    workloadIdentityProvider: desired.provider,
    submitterServiceAccount: desired.submitter.serviceAccountEmail,
    repositoryBindings: desired.githubActions.repositoryBindings.map(
      ({ fullName, repositoryId, variables }) => ({
        fullName,
        repositoryId,
        executorServiceAccount:
          variables.SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT,
      }),
    ),
  };
  if (bindings === undefined || bindings === null) {
    return {
      id: "CLOUD_BUILD_WIF_BINDING",
      state: "MACHINE_BLOCKED",
      code: "CLOUD_BUILD_WIF_READBACK_MISSING",
      detail: { expected },
    };
  }
  const mismatched = Object.entries(expected)
    .filter(
      ([key, value]) =>
        JSON.stringify(bindings[key]) !== JSON.stringify(value),
    )
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));
  const open = mismatched.length === 0;
  return {
    id: "CLOUD_BUILD_WIF_BINDING",
    state: open ? "OPEN" : "HUMAN_APPROVAL_REQUIRED",
    code: open ? null : "FLEET_CLOUD_BUILD_WIF_BINDING_UNVERIFIED",
    operation: desired.approval.operation,
    requiredRole: desired.approval.requiredRole,
    automaticRetry: false,
    detail: { expected, mismatched },
  };
}

// 중앙 release 경로는 private repo만 커버한다. ARC runner group은 public repository를
// 허용하지 않으므로, public repo를 wave에 넣으려면 public stable-tag release profile이
// 중앙 계약에 먼저 있어야 한다. 그 profile 구현은 이 gate의 범위가 아니다.
function publicReleaseProfileGate(publicRepositories) {
  if (!Array.isArray(publicRepositories)) {
    return {
      id: "CENTRAL_PUBLIC_RELEASE_PROFILE",
      state: "MACHINE_BLOCKED",
      code: "CENTRAL_PUBLIC_RELEASE_PROFILE_READBACK_MISSING",
      detail: { requiredProfile: PUBLIC_RELEASE_PROFILE_ID },
    };
  }
  const blocked = publicRepositories
    .filter(({ requiresRelease }) => requiresRelease === true)
    .map(({ fullName }) => fullName)
    .sort((left, right) => left.localeCompare(right));
  // profile은 단순 문자열로 열리지 않는다. 별도 worker가 만들 signed approved binding과
  // digest 구조가 중앙 계약에 올라오기 전까지 이 gate는 blocker로 유지한다.
  return {
    id: "CENTRAL_PUBLIC_RELEASE_PROFILE",
    state: blocked.length === 0 ? "OPEN" : "MACHINE_BLOCKED",
    code: blocked.length === 0 ? null : "CENTRAL_PUBLIC_RELEASE_PROFILE_REQUIRED",
    detail: {
      // ARC runner group이 public repository를 허용하지 않는 것이 근본 제약이다.
      requiredProfile: PUBLIC_RELEASE_PROFILE_ID,
      approvedBindingContract: "pending-central-signed-profile-binding",
      blockedRepositories: blocked,
    },
  };
}

// P7 caller 이관은 단순히 org-contract.yml 파일이 존재하는지만 보면 안 된다. 전체 active
// cohort를 같은 시점에 읽고 floating ref와 secrets: inherit가 0인지 확인해야 한다. 이
// readback은 signed P7 inventory를 검증한 trusted adapter가 공개 필드만 투영한 결과이며,
// report 자체는 여전히 PLAN_ONLY라서 PR이나 provider mutation 권한을 만들지 않는다.
function callerMigrationGate(readback, now) {
  const emptyDetail = {
    blockers: ["CALLER_MIGRATION_READBACK_INVALID"],
    counts: {},
    needsChangeRepositories: [],
  };
  if (readback === undefined || readback === null) {
    return {
      id: "CALLER_MIGRATION_CONFORMANCE",
      state: "MACHINE_BLOCKED",
      code: "CALLER_MIGRATION_READBACK_MISSING",
      detail: emptyDetail,
    };
  }
  const coverage = readback.coverage;
  const counts = readback.counts;
  const repositories = readback.repositories;
  const shapeValid =
    exactKeys(readback, [
      "contract",
      "inventoryId",
      "inventoryDigest",
      "observedAt",
      "expiresAt",
      "detectorSourceSha",
      "currentCentralSourceSha",
      "coverage",
      "counts",
      "repositories",
    ]) &&
    readback.contract === CALLER_MIGRATION_READBACK_CONTRACT &&
    EVIDENCE_ID_PATTERN.test(readback.inventoryId ?? "") &&
    DIGEST_PATTERN.test(readback.inventoryDigest ?? "") &&
    SHA_PATTERN.test(readback.detectorSourceSha ?? "") &&
    SHA_PATTERN.test(readback.currentCentralSourceSha ?? "") &&
    exactKeys(coverage, [
      "complete",
      "nextCursor",
      "activeRepositoryCount",
      "scannedRepositoryCount",
    ]) &&
    typeof coverage.complete === "boolean" &&
    (coverage.nextCursor === null || typeof coverage.nextCursor === "string") &&
    Number.isSafeInteger(coverage.activeRepositoryCount) &&
    coverage.activeRepositoryCount > 0 &&
    Number.isSafeInteger(coverage.scannedRepositoryCount) &&
    coverage.scannedRepositoryCount > 0 &&
    exactKeys(counts, ["workflowSecretsInherit", "workflowFloatingRef"]) &&
    Number.isSafeInteger(counts.workflowSecretsInherit) &&
    counts.workflowSecretsInherit >= 0 &&
    Number.isSafeInteger(counts.workflowFloatingRef) &&
    counts.workflowFloatingRef >= 0 &&
    Array.isArray(repositories) &&
    repositories.every(
      (repository) =>
        exactKeys(repository, [
          "repositoryId",
          "fullName",
          "sourceSha",
          "status",
        ]) &&
        NUMERIC_ID_PATTERN.test(repository.repositoryId ?? "") &&
        REPOSITORY_FULL_NAME_PATTERN.test(repository.fullName ?? "") &&
        SHA_PATTERN.test(repository.sourceSha ?? "") &&
        ["READY", "NEEDS_CHANGE"].includes(repository.status),
    );
  if (!shapeValid) {
    return {
      id: "CALLER_MIGRATION_CONFORMANCE",
      state: "MACHINE_BLOCKED",
      code: "CALLER_MIGRATION_READBACK_INVALID",
      detail: emptyDetail,
    };
  }

  const blockers = [];
  const observedAt = Date.parse(readback.observedAt);
  const expiresAt = Date.parse(readback.expiresAt);
  let nowMs;
  try {
    nowMs = Number(now());
  } catch {
    nowMs = Number.NaN;
  }
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(nowMs) ||
    expiresAt <= observedAt ||
    expiresAt - observedAt > CALLER_MIGRATION_MAX_TTL_MS ||
    observedAt > nowMs + CALLER_MIGRATION_MAX_CLOCK_SKEW_MS ||
    expiresAt <= nowMs
  ) {
    blockers.push("CALLER_MIGRATION_READBACK_EXPIRED");
  }
  if (readback.detectorSourceSha !== readback.currentCentralSourceSha) {
    blockers.push("CALLER_MIGRATION_DETECTOR_SOURCE_DRIFT");
  }
  const repositoryIds = repositories.map(({ repositoryId }) => repositoryId);
  const repositoryNames = repositories.map(({ fullName }) => fullName);
  if (
    coverage.complete !== true ||
    coverage.nextCursor !== null ||
    coverage.activeRepositoryCount !== coverage.scannedRepositoryCount ||
    coverage.scannedRepositoryCount !== repositories.length ||
    new Set(repositoryIds).size !== repositories.length ||
    new Set(repositoryNames).size !== repositories.length
  ) {
    blockers.push("CALLER_MIGRATION_COVERAGE_INCOMPLETE");
  }
  if (counts.workflowSecretsInherit !== 0) {
    blockers.push("CALLER_MIGRATION_SECRET_INHERITANCE_REMAINS");
  }
  if (counts.workflowFloatingRef !== 0) {
    blockers.push("CALLER_MIGRATION_FLOATING_REF_REMAINS");
  }
  const needsChangeRepositories = repositories
    .filter(({ status }) => status !== "READY")
    .map(({ fullName }) => fullName)
    .sort((left, right) => left.localeCompare(right));
  if (needsChangeRepositories.length > 0) {
    blockers.push("CALLER_MIGRATION_REPOSITORY_INCOMPLETE");
  }
  const uniqueBlockers = sortedUnique(blockers);
  return {
    id: "CALLER_MIGRATION_CONFORMANCE",
    state: uniqueBlockers.length === 0 ? "OPEN" : "MACHINE_BLOCKED",
    code:
      uniqueBlockers.length === 0
        ? null
        : "FLEET_CALLER_MIGRATION_INCOMPLETE",
    detail: {
      inventoryId: readback.inventoryId,
      inventoryDigest: readback.inventoryDigest,
      detectorSourceSha: readback.detectorSourceSha,
      currentCentralSourceSha: readback.currentCentralSourceSha,
      coverage: structuredClone(coverage),
      counts: structuredClone(counts),
      blockers: uniqueBlockers,
      needsChangeRepositories,
    },
  };
}

export function createFleetP7GateReport(
  readback,
  contract,
  { now = () => Date.now() } = {},
) {
  const gates = [
    githubAppGate(contract, readback.installation),
    customPropertyGate(contract, readback.organizationCustomProperties),
    protectionGate(
      contract,
      readback.protection,
      readback.defaultBranchOrgContractCallers,
      now,
    ),
    {
      id: "REPOSITORY_PROTECTION_ACTIVATION",
      state: "HUMAN_APPROVAL_REQUIRED",
      code: "PROTECTION_ACTIVE_APPROVAL_REQUIRED",
      operation: "GITHUB_PROTECTION_ACTIVE",
      automaticRetry: false,
      detail: { rolloutMode: contract.github.protection.rolloutMode, existingProtectionChanged: false },
    },
    cloudBuildGate(contract, readback.cloudBuildBindings),
    callerMigrationGate(readback.callerMigration, now),
    publicReleaseProfileGate(readback.publicRepositories),
  ];
  const blocked = gates.filter((gate) => gate.state !== "OPEN");
  return {
    contract: "seorilabs-fleet-p7-gate-report-v2",
    mode: "PLAN_ONLY",
    executionAllowed: blocked.length === 0,
    gates,
    machineBlocked: blocked
      .filter((gate) => gate.state === "MACHINE_BLOCKED")
      .map(({ id }) => id),
    humanApprovalRequired: blocked
      .filter((gate) => gate.state === "HUMAN_APPROVAL_REQUIRED")
      .map(({ id }) => id),
  };
}

export function loadFleetP3RuntimeContract() {
  return parse(readFileSync(contractPath, "utf8"));
}

function isEntrypoint() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const [readbackPath] = process.argv.slice(2);
  if (readbackPath === undefined) {
    process.stderr.write(
      "사용법: node scripts/fleet/p7-gate-report.mjs <readback.json>\n",
    );
    process.exit(2);
  }
  const readback = JSON.parse(readFileSync(readbackPath, "utf8"));
  const report = createFleetP7GateReport(
    readback,
    loadFleetP3RuntimeContract(),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.executionAllowed ? 0 : 1);
}
