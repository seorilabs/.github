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

function permissionSatisfies(actual, required) {
  return (PERMISSION_RANK[actual] ?? 0) >= (PERMISSION_RANK[required] ?? 0);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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

// ruleset Active 전환은 물리 check 이름이 실제로 생성되는 저장소가 있어야 의미가 있다.
// Evaluate ruleset이 없거나 required check를 만드는 default branch caller가 0이면
// Active 전환을 계획하지 않는다.
function rulesetGate(contract, rulesets, callerRepositories) {
  const desired = contract.github.ruleset;
  const requiredCheck = desired.requiredStatusCheck;
  const targets = sortedUnique(
    (desired.repositories ?? []).map((name) => `seorilabs/${name}`),
  );
  if (!Array.isArray(rulesets) || !Array.isArray(callerRepositories)) {
    return {
      id: "ORG_RULESET_ACTIVATION",
      state: "MACHINE_BLOCKED",
      code: "ORG_RULESET_READBACK_MISSING",
      detail: { requiredCheck, targets },
    };
  }
  const blockers = [];
  // 임의의 evaluate ruleset이 아니라 계약이 지정한 exact ruleset이어야 한다.
  const matching = rulesets.find((ruleset) => ruleset.name === desired.name);
  if (matching === undefined) {
    blockers.push("CONTRACT_RULESET_ABSENT");
  } else {
    if (
      matching.target !== desired.target ||
      matching.enforcement !== desired.enforcement
    ) {
      blockers.push("CONTRACT_RULESET_MODE_MISMATCH");
    }
    const checks = new Set(
      Array.isArray(matching.requiredStatusChecks)
        ? matching.requiredStatusChecks
        : [],
    );
    if (!checks.has(requiredCheck)) {
      blockers.push("REQUIRED_STATUS_CHECK_ABSENT");
    }
    const scoped = new Set(
      Array.isArray(matching.repositories) ? matching.repositories : [],
    );
    if (targets.some((fullName) => !scoped.has(fullName))) {
      blockers.push("RULESET_TARGET_COVERAGE_INCOMPLETE");
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
    id: "ORG_RULESET_ACTIVATION",
    state: blockers.length === 0 ? "OPEN" : "MACHINE_BLOCKED",
    code: blockers.length === 0 ? null : "ORG_RULESET_ACTIVATION_UNSAFE",
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
    executorServiceAccount: desired.executor.serviceAccountEmail,
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
    .filter(([key, value]) => bindings[key] !== value)
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right));
  const open = mismatched.length === 0;
  return {
    id: "CLOUD_BUILD_WIF_BINDING",
    state: open ? "OPEN" : "HUMAN_APPROVAL_REQUIRED",
    code: open ? null : "FLEET_CLOUD_BUILD_WIF_BINDING_UNVERIFIED",
    operation: "FLEET_P3_CLOUD_BUILD_WIF_ACTIVATION",
    requiredRole: "organization_owner",
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

export function createFleetP7GateReport(readback, contract) {
  const gates = [
    githubAppGate(contract, readback.installation),
    customPropertyGate(contract, readback.organizationCustomProperties),
    rulesetGate(
      contract,
      readback.rulesets,
      readback.defaultBranchOrgContractCallers,
    ),
    cloudBuildGate(contract, readback.cloudBuildBindings),
    publicReleaseProfileGate(readback.publicRepositories),
  ];
  const blocked = gates.filter((gate) => gate.state !== "OPEN");
  return {
    contract: "seorilabs-fleet-p7-gate-report-v1",
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
