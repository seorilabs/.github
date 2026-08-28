#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const contractPath = fileURLToPath(
  new URL("../../contracts/fleet-p3-runtime.yaml", import.meta.url),
);
const defaultGcloud = join(
  homedir(),
  ".config",
  "seorilabs",
  "scripts",
  "gcloud-cli.sh",
);
const gcloud = process.env.SEORILABS_GCLOUD_CLI ?? defaultGcloud;
const mode = process.argv[2] ?? "plan";
const confirmation = process.argv[3] ?? "";

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exit(1);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function parsePublicJson(raw, code) {
  try {
    return JSON.parse(raw);
  } catch {
    fail(code);
  }
}

let contract;
try {
  contract = parse(readFileSync(contractPath, "utf8"));
} catch {
  fail("P3_SECRET_MANAGER_CONTRACT_PARSE_FAILED");
}
if (!new Set(["plan", "apply", "readback", "rollback"]).has(mode)) {
  fail("P3_SECRET_MANAGER_COMMAND_INVALID");
}
if (process.argv.length > 4) fail("P3_SECRET_MANAGER_COMMAND_INVALID");

const cloud = contract.cloudBuild;
const auth = contract.authBroker;
const manager = auth.secretManager;
const contractDigest = createHash("sha256")
  .update(JSON.stringify(canonical(contract)))
  .digest("hex");
const expectedConfirmation = `fleet-p3-secrets-${contractDigest.slice(0, 12)}`;
const expectedRollback = `fleet-p3-secrets-rollback-${contractDigest.slice(0, 12)}`;
if (mode === "apply" && confirmation !== expectedConfirmation) {
  fail("P3_SECRET_MANAGER_APPLY_CONFIRMATION_REQUIRED");
}
if (mode === "rollback" && confirmation !== expectedRollback) {
  fail("P3_SECRET_MANAGER_ROLLBACK_CONFIRMATION_REQUIRED");
}

function validateGcloudExecutable() {
  try {
    const entry = lstatSync(gcloud);
    if (
      !isAbsolute(gcloud) ||
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      realpathSync(gcloud) !== gcloud
    ) {
      fail("P3_SECRET_MANAGER_GCLOUD_WRAPPER_INVALID");
    }
    accessSync(gcloud, constants.R_OK | constants.X_OK);
  } catch {
    fail("P3_SECRET_MANAGER_GCLOUD_WRAPPER_INVALID");
  }
}

function gcloudRun(args, code) {
  try {
    return execFileSync(gcloud, ["--quiet", ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const diagnostic = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (/not found|NOT_FOUND|does not exist|was not found/iu.test(diagnostic)) {
      return null;
    }
    fail(code);
  }
}

function githubCondition() {
  const workflows = cloud.wif.repositories.map(
    ({ workflow }) =>
      `assertion.job_workflow_ref == 'seorilabs/.github/${workflow}@${cloud.wif.workflowSourceSha}'`,
  );
  const repositories = cloud.wif.repositories.map(
    ({ repositoryId }) => `assertion.repository_id == '${repositoryId}'`,
  );
  return [
    `assertion.repository_owner_id == '${cloud.wif.organizationId}'`,
    `(${repositories.join(" || ")})`,
    `(${workflows.join(" || ")})`,
  ].join(" && ");
}

function kubernetesCondition() {
  const accounts = auth.roles.map(
    ({ serviceAccount }) =>
      `assertion['kubernetes.io']['serviceaccount']['name'] == '${serviceAccount}'`,
  );
  return [
    `assertion.iss == '${cloud.wif.kubernetesIssuer}'`,
    `assertion['kubernetes.io']['namespace'] == '${auth.namespace}'`,
    `(${accounts.join(" || ")})`,
  ].join(" && ");
}

const kubernetesMapping = Object.fromEntries(
  [
    "google.subject=assertion.sub",
    "attribute.namespace=assertion['kubernetes.io']['namespace']",
    "attribute.service_account=assertion['kubernetes.io']['serviceaccount']['name']",
  ].map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
);
const githubMapping = Object.fromEntries(
  [
    "google.subject=assertion.sub",
    "attribute.repository=assertion.repository",
    "attribute.repository_id=assertion.repository_id",
    "attribute.job_workflow_ref=assertion.job_workflow_ref",
  ].map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
);

function providerRead(provider) {
  const raw = gcloudRun(
    [
      "iam",
      "workload-identity-pools",
      "providers",
      "describe",
      provider,
      `--project=${cloud.projectId}`,
      "--location=global",
      `--workload-identity-pool=${cloud.wif.pool}`,
      "--format=json(attributeCondition,attributeMapping,disabled,oidc.allowedAudiences,oidc.issuerUri)",
    ],
    "P3_SECRET_MANAGER_WIF_PROVIDER_READ_FAILED",
  );
  return raw === null
    ? null
    : parsePublicJson(raw, "P3_SECRET_MANAGER_WIF_PROVIDER_RESPONSE_INVALID");
}

function providerExpected(name) {
  if (name === "github") {
    return {
      condition: githubCondition(),
      mapping: githubMapping,
      issuer: cloud.wif.githubIssuer,
      audience: cloud.wif.githubAudience,
    };
  }
  return {
    condition: kubernetesCondition(),
    mapping: kubernetesMapping,
    issuer: cloud.wif.kubernetesIssuer,
    audience: auth.wifAudience,
  };
}

function providerExact(actual, expected) {
  return (
    actual !== null &&
    actual.attributeCondition === expected.condition &&
    JSON.stringify(canonical(actual.attributeMapping)) ===
      JSON.stringify(canonical(expected.mapping)) &&
    actual.oidc?.issuerUri === expected.issuer &&
    JSON.stringify(actual.oidc?.allowedAudiences) ===
      JSON.stringify([expected.audience])
  );
}

function providerStates() {
  return [
    { name: "github", id: cloud.wif.githubProvider },
    { name: "kubernetes", id: cloud.wif.kubernetesProvider },
  ].map((entry) => {
    const actual = providerRead(entry.id);
    return {
      ...entry,
      actual,
      expected: providerExpected(entry.name),
      exact: providerExact(actual, providerExpected(entry.name)),
    };
  });
}

function secretRead(resource) {
  const raw = gcloudRun(
    [
      "secrets",
      "describe",
      resource.secretId,
      `--project=${manager.projectId}`,
      "--format=json(name)",
    ],
    "P3_SECRET_MANAGER_RESOURCE_READ_FAILED",
  );
  const versionsRaw = raw === null
    ? null
    : gcloudRun(
        [
          "secrets",
          "versions",
          "list",
          resource.secretId,
          `--project=${manager.projectId}`,
          "--format=json(name,state)",
        ],
        "P3_SECRET_MANAGER_VERSION_READ_FAILED",
      );
  const actual = raw === null
    ? null
    : parsePublicJson(raw, "P3_SECRET_MANAGER_RESOURCE_RESPONSE_INVALID");
  const versions = versionsRaw === null
    ? []
    : parsePublicJson(versionsRaw, "P3_SECRET_MANAGER_VERSION_RESPONSE_INVALID");
  const canonicalResource =
    `projects/${cloud.projectNumber}/secrets/${resource.secretId}`;
  const canonicalVersion = `${canonicalResource}/versions/${resource.version}`;
  return {
    ...resource,
    exists: actual !== null,
    identityExact:
      actual?.name === resource.resource || actual?.name === canonicalResource,
    versionExact:
      versions.length === 1 &&
      (versions[0].name === resource.versionResource ||
        versions[0].name === canonicalVersion) &&
      versions[0].state === "ENABLED",
  };
}

function policyRead(resource) {
  const raw = gcloudRun(
    [
      "secrets",
      "get-iam-policy",
      resource.secretId,
      `--project=${manager.projectId}`,
      "--format=json(bindings)",
    ],
    "P3_SECRET_MANAGER_IAM_READ_FAILED",
  );
  return raw === null
    ? { bindings: [] }
    : parsePublicJson(raw, "P3_SECRET_MANAGER_IAM_RESPONSE_INVALID");
}

function member(resource) {
  return `serviceAccount:${resource.googleServiceAccount}`;
}

function accessorMembers(policy) {
  return (
    policy.bindings?.find(
      ({ role, condition }) =>
        role === "roles/secretmanager.secretAccessor" && condition === undefined,
    )?.members ?? []
  );
}

function accessorBindings(policy) {
  return (policy.bindings ?? []).filter(
    ({ role }) => role === "roles/secretmanager.secretAccessor",
  );
}

function projectPolicyRead() {
  const raw = gcloudRun(
    [
      "projects",
      "get-iam-policy",
      manager.projectId,
      "--format=json(bindings)",
    ],
    "P3_SECRET_MANAGER_PROJECT_IAM_READ_FAILED",
  );
  if (raw === null) fail("P3_SECRET_MANAGER_PROJECT_IAM_READ_FAILED");
  return parsePublicJson(
    raw,
    "P3_SECRET_MANAGER_PROJECT_IAM_RESPONSE_INVALID",
  );
}

function projectScopedP3Accessors(policy) {
  const roleMembers = new Set(
    auth.roles.map(
      ({ googleServiceAccount }) => `serviceAccount:${googleServiceAccount}`,
    ),
  );
  return (policy.bindings ?? [])
    .filter(({ role }) => role === "roles/secretmanager.secretAccessor")
    .flatMap(({ members = [] }) => members)
    .filter((candidate) => roleMembers.has(candidate));
}

function publicPlan() {
  return {
    schemaVersion: 1,
    mode: "DRY_RUN",
    project: { id: manager.projectId, number: cloud.projectNumber },
    contractDigest,
    workflowSourceSha: cloud.wif.workflowSourceSha,
    confirmation: expectedConfirmation,
    rollbackConfirmation: expectedRollback,
    resources: manager.resources,
    provisioning: manager.provisioning,
    iamBindings: manager.resources.map((resource) => ({
      resource: resource.resource,
      role: "roles/secretmanager.secretAccessor",
      member: member(resource),
    })),
    humanGate: manager.humanGate,
    apply:
      `node scripts/fleet/bootstrap-p3-secret-manager.mjs apply ${expectedConfirmation}`,
    readback: "node scripts/fleet/bootstrap-p3-secret-manager.mjs readback",
    rollback:
      `node scripts/fleet/bootstrap-p3-secret-manager.mjs rollback ${expectedRollback}`,
    rollbackStrategy:
      "Secret-level IAM은 보존하고 exact Kubernetes provider만 disable해 신규 workload token exchange를 차단한다.",
    secretValuesCreated: false,
  };
}

function preflightProviders() {
  validateGcloudExecutable();
  const number = gcloudRun(
    ["projects", "describe", manager.projectId, "--format=value(projectNumber)"],
    "P3_SECRET_MANAGER_PROJECT_READ_FAILED",
  );
  if (number !== cloud.projectNumber) fail("P3_SECRET_MANAGER_PROJECT_MISMATCH");
  const projectPolicy = projectPolicyRead();
  if (projectScopedP3Accessors(projectPolicy).length !== 0) {
    fail("P3_SECRET_MANAGER_PROJECT_ACCESSOR_PRESENT");
  }
  const providers = providerStates();
  if (providers.some(({ actual }) => actual === null)) {
    fail("P3_SECRET_MANAGER_WIF_PROVIDER_MISSING");
  }
  if (providers.some(({ exact }) => !exact)) {
    fail("P3_SECRET_MANAGER_WIF_PROVIDER_DRIFT");
  }
  return providers;
}

function preflight() {
  const providers = preflightProviders();
  const resources = manager.resources.map(secretRead);
  if (resources.some(({ exists }) => !exists)) {
    fail("P3_SECRET_MANAGER_RESOURCE_MISSING");
  }
  if (resources.some(({ identityExact, versionExact }) => !identityExact || !versionExact)) {
    fail("P3_SECRET_MANAGER_RESOURCE_DRIFT");
  }
  return { providers, resources };
}

function updateKubernetesProviderDisabled(disabled) {
  gcloudRun(
    [
      "iam",
      "workload-identity-pools",
      "providers",
      "update-oidc",
      cloud.wif.kubernetesProvider,
      `--project=${cloud.projectId}`,
      "--location=global",
      `--workload-identity-pool=${cloud.wif.pool}`,
      disabled ? "--disabled" : "--no-disabled",
      "--format=none",
    ],
    "P3_SECRET_MANAGER_WIF_PROVIDER_UPDATE_FAILED",
  );
}

function apply() {
  const state = preflight();
  const policies = manager.resources.map((resource) => ({
    resource,
    policy: policyRead(resource),
  }));
  for (const { resource, policy } of policies) {
    const unexpected = accessorBindings(policy).some(
      ({ condition, members }) =>
        condition !== undefined ||
        !Array.isArray(members) ||
        members.some((candidate) => candidate !== member(resource)),
    );
    if (unexpected) fail("P3_SECRET_MANAGER_UNEXPECTED_ACCESSOR_PRESENT");
  }
  for (const { resource, policy } of policies) {
    if (accessorMembers(policy).includes(member(resource))) continue;
    gcloudRun(
      [
        "secrets",
        "add-iam-policy-binding",
        resource.secretId,
        `--project=${manager.projectId}`,
        "--role=roles/secretmanager.secretAccessor",
        `--member=${member(resource)}`,
        "--format=none",
      ],
      "P3_SECRET_MANAGER_IAM_APPLY_FAILED",
    );
  }
  const kubernetes = state.providers.find(({ name }) => name === "kubernetes");
  if (kubernetes.actual.disabled === true) {
    updateKubernetesProviderDisabled(false);
  }
  return readback();
}

function readback() {
  validateGcloudExecutable();
  const projectPolicy = projectPolicyRead();
  const projectScopedAccessDenied =
    projectScopedP3Accessors(projectPolicy).length === 0;
  const resources = manager.resources.map((resource) => {
    const state = secretRead(resource);
    const policy = policyRead(resource);
    const members = accessorMembers(policy);
    const bindings = accessorBindings(policy);
    const otherRoleMembers = auth.roles
      .map(({ googleServiceAccount }) => `serviceAccount:${googleServiceAccount}`)
      .filter((candidate) => candidate !== member(resource));
    return {
      secretId: resource.secretId,
      resource: resource.resource,
      versionResource: resource.versionResource,
      consumerRole: resource.consumerRole,
      googleServiceAccount: resource.googleServiceAccount,
      exists: state.exists,
      identityExact: state.identityExact,
      versionExact: state.versionExact,
      accessorBindingExact:
        bindings.length === 1 &&
        bindings[0].condition === undefined &&
        members.length === 1 &&
        members.includes(member(resource)),
      crossRoleAccessDenied: otherRoleMembers.every(
        (candidate) => !members.includes(candidate),
      ),
    };
  });
  const providers = providerStates();
  const kubernetes = providers.find(({ name }) => name === "kubernetes");
  return {
    project: { id: manager.projectId, number: cloud.projectNumber },
    contractDigest,
    projectScopedAccessDenied,
    resources,
    providers: Object.fromEntries(
      providers.map(({ name, id, actual, exact }) => [name, {
        id,
        exists: actual !== null,
        configurationExact: exact,
        disabled: actual?.disabled === true,
        active: actual !== null && exact && actual.disabled !== true,
      }]),
    ),
    canary: {
      state: "BLOCKED_LIVE_RUNTIME",
      requiredReadback: manager.humanGate.requiredReadback.slice(2),
    },
    ready:
      resources.every(
        ({ exists, identityExact, versionExact, accessorBindingExact, crossRoleAccessDenied }) =>
          exists && identityExact && versionExact && accessorBindingExact && crossRoleAccessDenied,
      ) &&
      projectScopedAccessDenied &&
      kubernetes?.exact === true &&
      kubernetes.actual?.disabled !== true,
    secretValuesCreated: false,
  };
}

function rollback() {
  const providers = preflightProviders();
  const kubernetes = providers.find(({ name }) => name === "kubernetes");
  if (kubernetes.actual.disabled !== true) {
    updateKubernetesProviderDisabled(true);
  }
  const disabled = providerRead(cloud.wif.kubernetesProvider);
  if (!providerExact(disabled, kubernetes.expected) || disabled.disabled !== true) {
    fail("P3_SECRET_MANAGER_WIF_PROVIDER_UPDATE_FAILED");
  }
  return {
    state: "NEW_AUTH_BROKER_TOKEN_EXCHANGE_REVOKED",
    provider: cloud.wif.kubernetesProvider,
    providerDisabled: true,
    iamBindingsMutated: false,
    exactBindingsPreserved: manager.resources.length,
    secretValuesDeleted: false,
    existingAccessTokensRevoked: false,
  };
}

if (mode === "plan") {
  process.stdout.write(`${JSON.stringify(publicPlan(), null, 2)}\n`);
} else if (mode === "apply") {
  process.stdout.write(`${JSON.stringify(apply(), null, 2)}\n`);
} else if (mode === "readback") {
  process.stdout.write(`${JSON.stringify(readback(), null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(rollback(), null, 2)}\n`);
}
