#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  accessSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { createTrustedWifProviderPolicy } from "../../packages/repo-contract/src/trusted-executor.mjs";

const contractPath = fileURLToPath(
  new URL("../../contracts/fleet-p3-runtime.yaml", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
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
const modes = new Set(["plan", "apply", "readback", "rollback"]);

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exit(1);
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
      fail("P3_GCLOUD_WRAPPER_INVALID");
    }
    accessSync(gcloud, constants.R_OK | constants.X_OK);
  } catch {
    fail("P3_GCLOUD_WRAPPER_INVALID");
  }
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
  fail("P3_GCP_CONTRACT_PARSE_FAILED");
}
const cloud = contract.cloudBuild;
const auth = contract.authBroker;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

const contractDigest = createHash("sha256")
  .update(JSON.stringify(canonical(contract)))
  .digest("hex");

if (!modes.has(mode) || process.argv.length > 4) fail("P3_GCP_COMMAND_INVALID");

const expectedConfirmation = `fleet-p3-${contractDigest.slice(0, 12)}`;
const expectedRollback = `fleet-p3-rollback-${contractDigest.slice(0, 12)}`;
const poolDisplayName = "Seorilabs Fleet P3";
const poolDescription =
  "Dedicated keyless identities for Fleet Cloud Build and Auth Broker";
const poolName =
  `projects/${cloud.projectNumber}/locations/global/workloadIdentityPools/${cloud.wif.pool}`;
if (mode === "apply" && confirmation !== expectedConfirmation) {
  fail("P3_GCP_APPLY_CONFIRMATION_REQUIRED");
}
if (mode === "rollback" && confirmation !== expectedRollback) {
  fail("P3_GCP_ROLLBACK_CONFIRMATION_REQUIRED");
}

function run(executable, args, code) {
  try {
    return execFileSync(executable, args, {
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

function gcloudRun(args, code) {
  return run(gcloud, ["--quiet", ...args], code);
}

function localSourcePreflight() {
  const remote = run("git", ["remote", "get-url", "origin"], "P3_GIT_REMOTE_READ_FAILED");
  if (!/(?:github\.com[:/])seorilabs\/\.github(?:\.git)?$/u.test(remote)) {
    fail("P3_GIT_REMOTE_MISMATCH");
  }
  for (const { workflow, sha256 } of cloud.wif.repositories) {
    const executionObject = `${cloud.wif.workflowExecutionSha}:${workflow}`;
    const provenanceObject = `${cloud.wif.workflowBundleSourceSha}:${workflow}`;
    let executionBytes;
    let provenanceBytes;
    try {
      executionBytes = execFileSync("git", ["show", executionObject], {
        cwd: repositoryRoot,
        encoding: null,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      fail("P3_WORKFLOW_SOURCE_MISSING");
    }
    try {
      provenanceBytes = execFileSync("git", ["show", provenanceObject], {
        cwd: repositoryRoot,
        encoding: null,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      fail("P3_WORKFLOW_SOURCE_MISSING");
    }
    const executionDigest = createHash("sha256")
      .update(executionBytes)
      .digest("hex");
    const provenanceDigest = createHash("sha256")
      .update(provenanceBytes)
      .digest("hex");
    if (
      executionDigest !== sha256 ||
      provenanceDigest !== sha256 ||
      !executionBytes.equals(provenanceBytes)
    ) {
      fail("P3_WORKFLOW_SOURCE_DIGEST_MISMATCH");
    }
  }
}

const githubWifPolicy = createTrustedWifProviderPolicy({
  organizationId: cloud.wif.organizationId,
  capabilities: cloud.wif.repositories.map(({ repositoryId, workflow }) => ({
    environment: cloud.githubActions.environment,
    repositoryId,
    jobWorkflowRef:
      `seorilabs/.github/${workflow}@${cloud.wif.workflowExecutionSha}`,
  })),
});

function githubCondition() {
  return githubWifPolicy.attributeCondition;
}

function legacyGithubCondition() {
  const repositoryClauses = cloud.wif.repositories.map(
    ({ repositoryId }) => `assertion.repository_id == '${repositoryId}'`,
  );
  const workflowClauses = cloud.wif.repositories.map(
    ({ workflow }) =>
      `assertion.job_workflow_ref == 'seorilabs/.github/${workflow}@${cloud.wif.workflowExecutionSha}'`,
  );
  return [
    `assertion.repository_owner_id == '${cloud.wif.organizationId}'`,
    `(${repositoryClauses.join(" || ")})`,
    `(${workflowClauses.join(" || ")})`,
  ].join(" && ");
}

function kubernetesCondition() {
  const serviceAccounts = auth.roles.map(
    ({ serviceAccount }) =>
      `assertion['kubernetes.io']['serviceaccount']['name'] == '${serviceAccount}'`,
  );
  return [
    `assertion.iss == '${cloud.wif.kubernetesIssuer}'`,
    `assertion['kubernetes.io']['namespace'] == '${auth.namespace}'`,
    `(${serviceAccounts.join(" || ")})`,
  ].join(" && ");
}

const githubMapping = Object.entries(githubWifPolicy.attributeMapping)
  .map(([attribute, assertion]) => `${attribute}=${assertion}`)
  .join(",");
const kubernetesMapping = [
  "google.subject=assertion.sub",
  "attribute.namespace=assertion['kubernetes.io']['namespace']",
  "attribute.service_account=assertion['kubernetes.io']['serviceaccount']['name']",
].join(",");

const serviceAccounts = [
  {
    id: cloud.submitter.serviceAccountEmail.split("@")[0],
    email: cloud.submitter.serviceAccountEmail,
    displayName: "Seori Cloud Build submitter",
  },
  {
    id: cloud.executor.serviceAccountEmail.split("@")[0],
    email: cloud.executor.serviceAccountEmail,
    displayName: "Seori Cloud Build executor",
  },
  ...auth.roles.map(({ name, googleServiceAccount }) => ({
    id: googleServiceAccount.split("@")[0],
    email: googleServiceAccount,
    displayName: `Seori Auth ${name}`,
  })),
];

function principalSet(attribute, value) {
  return (
    `principalSet://iam.googleapis.com/projects/${cloud.projectNumber}` +
    `/locations/global/workloadIdentityPools/${cloud.wif.pool}/attribute.${attribute}/${value}`
  );
}

const bindings = [];
function binding(resourceType, resource, role, member) {
  bindings.push({ resourceType, resource, role, member });
}

for (const { resource, role } of cloud.submitter.bindings) {
  const resourceType = resource.startsWith("projects/")
    ? "project"
    : resource.startsWith("gs://")
      ? "bucket"
      : "serviceAccount";
  binding(
    resourceType,
    resource,
    role,
    `serviceAccount:${cloud.submitter.serviceAccountEmail}`,
  );
}
for (const { resource, role } of cloud.executor.bindings) {
  const resourceType = resource.startsWith("projects/")
    ? resource.includes("/repositories/")
      ? "artifactRepository"
      : "project"
    : resource.startsWith("gs://")
      ? "bucket"
      : "serviceAccount";
  binding(
    resourceType,
    resource,
    role,
    `serviceAccount:${cloud.executor.serviceAccountEmail}`,
  );
}
binding(
  "serviceAccount",
  cloud.executor.serviceAccountEmail,
  "roles/iam.serviceAccountTokenCreator",
  `serviceAccount:service-${cloud.projectNumber}@gcp-sa-cloudbuild.iam.gserviceaccount.com`,
);
for (const { repositoryId } of cloud.wif.repositories) {
  binding(
    "serviceAccount",
    cloud.submitter.serviceAccountEmail,
    "roles/iam.workloadIdentityUser",
    principalSet("repository_id", repositoryId),
  );
}
for (const role of auth.roles) {
  binding(
    "serviceAccount",
    role.googleServiceAccount,
    "roles/iam.workloadIdentityUser",
    principalSet("service_account", role.serviceAccount),
  );
}

function publicPlan() {
  return {
    schemaVersion: 1,
    mode: "DRY_RUN",
    project: { id: cloud.projectId, number: cloud.projectNumber },
    contractDigest,
    workflowBundleSourceSha: cloud.wif.workflowBundleSourceSha,
    workflowExecutionSha: cloud.wif.workflowExecutionSha,
    githubActions: cloud.githubActions,
    confirmation: expectedConfirmation,
    rollbackConfirmation: expectedRollback,
    staticKeysCreated: false,
    serviceAccounts,
    workloadIdentity: {
      pool: cloud.wif.pool,
      github: {
        provider: cloud.wif.githubProvider,
        issuer: cloud.wif.githubIssuer,
        audience: cloud.wif.githubAudience,
        attributeMapping: githubMapping,
        attributeCondition: githubCondition(),
      },
      kubernetes: {
        provider: cloud.wif.kubernetesProvider,
        issuer: cloud.wif.kubernetesIssuer,
        audience: auth.wifAudience,
        attributeMapping: kubernetesMapping,
        attributeCondition: kubernetesCondition(),
        jwksSource: "Kubernetes /openid/v1/jwks public readback",
      },
    },
    iamBindings: bindings,
    apply: `node scripts/fleet/bootstrap-p3-gcp.mjs apply ${expectedConfirmation}`,
    readback: "node scripts/fleet/bootstrap-p3-gcp.mjs readback",
    rollback: `node scripts/fleet/bootstrap-p3-gcp.mjs rollback ${expectedRollback}`,
    resume:
      "같은 apply 명령은 exact-existing 객체를 보존하고 rollback으로 disabled된 exact provider만 다시 활성화한다.",
    rollbackStrategy:
      "IAM binding은 변경하지 않고 exact provider만 disable해 신규 token exchange를 차단한다.",
  };
}

function gcpPreflight() {
  validateGcloudExecutable();
  const number = gcloudRun(
    ["projects", "describe", cloud.projectId, "--format=value(projectNumber)"],
    "P3_GCP_PROJECT_READ_FAILED",
  );
  if (number !== cloud.projectNumber) fail("P3_GCP_PROJECT_NUMBER_MISMATCH");
}

function ensureServiceAccounts() {
  for (const account of serviceAccounts) {
    const existing = gcloudRun(
      [
        "iam",
        "service-accounts",
        "describe",
        account.email,
        `--project=${cloud.projectId}`,
        "--format=value(email)",
      ],
      "P3_GCP_SERVICE_ACCOUNT_READ_FAILED",
    );
    if (existing === null) {
      gcloudRun(
        [
          "iam",
          "service-accounts",
          "create",
          account.id,
          `--project=${cloud.projectId}`,
          `--display-name=${account.displayName}`,
          "--format=none",
        ],
        "P3_GCP_SERVICE_ACCOUNT_CREATE_FAILED",
      );
    } else if (existing !== account.email) {
      fail("P3_GCP_SERVICE_ACCOUNT_IDENTITY_MISMATCH");
    }
  }
}

function poolRead() {
  const raw = gcloudRun(
    [
      "iam",
      "workload-identity-pools",
      "describe",
      cloud.wif.pool,
      `--project=${cloud.projectId}`,
      "--location=global",
      "--format=json(name,displayName,description,disabled,state)",
    ],
    "P3_GCP_WIF_POOL_READ_FAILED",
  );
  return raw === null
    ? null
    : parsePublicJson(raw, "P3_GCP_WIF_POOL_RESPONSE_INVALID");
}

function poolConfigurationMatches(actual) {
  return (
    actual?.name === poolName &&
    actual?.displayName === poolDisplayName &&
    actual?.description === poolDescription
  );
}

function poolActive(actual) {
  return (
    actual !== null &&
    actual?.disabled !== true &&
    actual?.state === "ACTIVE"
  );
}

function ensurePool() {
  let existing = poolRead();
  if (existing === null) {
    gcloudRun(
      [
        "iam",
        "workload-identity-pools",
        "create",
        cloud.wif.pool,
        `--project=${cloud.projectId}`,
        "--location=global",
        `--display-name=${poolDisplayName}`,
        `--description=${poolDescription}`,
        "--format=none",
      ],
      "P3_GCP_WIF_POOL_CREATE_FAILED",
    );
    existing = poolRead();
  }
  if (!poolConfigurationMatches(existing)) fail("P3_GCP_WIF_POOL_DRIFT");
  if (existing.disabled === true) fail("P3_GCP_WIF_POOL_DISABLED");
  if (existing.state !== "ACTIVE") fail("P3_GCP_WIF_POOL_STATE_INVALID");
}

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
    "P3_GCP_WIF_PROVIDER_READ_FAILED",
  );
  return raw === null
    ? null
    : parsePublicJson(raw, "P3_GCP_WIF_PROVIDER_RESPONSE_INVALID");
}

function mappingObject(mapping) {
  return Object.fromEntries(mapping.split(",").map((entry) => entry.split(/=(.*)/su).slice(0, 2)));
}

function providerConfigurationMatches(actual, { condition, mapping, issuer, audience }) {
  const actualMapping = Object.entries(actual?.attributeMapping ?? {}).toSorted(
    ([left], [right]) => left.localeCompare(right),
  );
  const expectedMapping = Object.entries(mappingObject(mapping)).toSorted(
    ([left], [right]) => left.localeCompare(right),
  );
  return (
    actual?.attributeCondition === condition &&
    JSON.stringify(actualMapping) === JSON.stringify(expectedMapping) &&
    actual?.oidc?.issuerUri === issuer &&
    Array.isArray(actual?.oidc?.allowedAudiences) &&
    actual.oidc.allowedAudiences.length === 1 &&
    actual.oidc.allowedAudiences[0] === audience
  );
}

function providerMatches(actual, expected) {
  return (
    providerConfigurationMatches(actual, expected) &&
    providerActive(actual)
  );
}

function providerActive(actual) {
  return actual !== null && actual?.disabled !== true;
}

function updateProviderDisabled(provider, disabled, code) {
  gcloudRun(
    [
      "iam",
      "workload-identity-pools",
      "providers",
      "update-oidc",
      provider,
      `--project=${cloud.projectId}`,
      "--location=global",
      `--workload-identity-pool=${cloud.wif.pool}`,
      disabled ? "--disabled" : "--no-disabled",
      "--format=none",
    ],
    code,
  );
}

function kubernetesJwks() {
  const discoveryRaw = run(
    "kubectl",
    ["get", "--raw", "/.well-known/openid-configuration"],
    "P3_KUBERNETES_OIDC_DISCOVERY_FAILED",
  );
  if (discoveryRaw === null) fail("P3_KUBERNETES_OIDC_DISCOVERY_FAILED");
  const discovery = parsePublicJson(
    discoveryRaw,
    "P3_KUBERNETES_OIDC_DISCOVERY_FAILED",
  );
  if (discovery.issuer !== cloud.wif.kubernetesIssuer) {
    fail("P3_KUBERNETES_OIDC_ISSUER_MISMATCH");
  }
  const raw = run(
    "kubectl",
    ["get", "--raw", "/openid/v1/jwks"],
    "P3_KUBERNETES_JWKS_READ_FAILED",
  );
  if (raw === null) fail("P3_KUBERNETES_JWKS_READ_FAILED");
  const jwks = parsePublicJson(raw, "P3_KUBERNETES_JWKS_READ_FAILED");
  if (
    !Array.isArray(jwks.keys) ||
    jwks.keys.length === 0 ||
    jwks.keys.some(
      (key) =>
        typeof key !== "object" ||
        !key.kid ||
        ["d", "p", "q", "dp", "dq", "qi", "oth"].some((field) => field in key),
    )
  ) {
    fail("P3_KUBERNETES_JWKS_INVALID");
  }
  return `${JSON.stringify(jwks)}\n`;
}

function providerSpecifications() {
  return [
    {
      name: "github",
      id: cloud.wif.githubProvider,
      expected: {
        condition: githubCondition(),
        mapping: githubMapping,
        issuer: cloud.wif.githubIssuer,
        audience: cloud.wif.githubAudience,
      },
      legacy: {
        condition: legacyGithubCondition(),
        mapping: githubMapping,
        issuer: cloud.wif.githubIssuer,
        audience: cloud.wif.githubAudience,
      },
      driftCode: "P3_GITHUB_WIF_PROVIDER_DRIFT",
      createCode: "P3_GITHUB_WIF_PROVIDER_CREATE_FAILED",
      enableCode: "P3_GITHUB_WIF_PROVIDER_ENABLE_FAILED",
      migrationCode: "P3_GITHUB_WIF_PROVIDER_MIGRATION_FAILED",
    },
    {
      name: "kubernetes",
      id: cloud.wif.kubernetesProvider,
      expected: {
        condition: kubernetesCondition(),
        mapping: kubernetesMapping,
        issuer: cloud.wif.kubernetesIssuer,
        audience: auth.wifAudience,
      },
      driftCode: "P3_KUBERNETES_WIF_PROVIDER_DRIFT",
      createCode: "P3_KUBERNETES_WIF_PROVIDER_CREATE_FAILED",
      enableCode: "P3_KUBERNETES_WIF_PROVIDER_ENABLE_FAILED",
    },
  ];
}

function preflightProviders() {
  const states = providerSpecifications().map((specification) => {
    const existing = providerRead(specification.id);
    const configurationState =
      existing === null
        ? "MISSING"
        : providerConfigurationMatches(existing, specification.expected)
          ? "EXACT"
          : specification.legacy &&
              providerConfigurationMatches(existing, specification.legacy)
            ? "LEGACY_MIGRATION_REQUIRED"
            : "DRIFT";
    return { ...specification, existing, configurationState };
  });
  for (const { configurationState, driftCode } of states) {
    if (configurationState === "DRIFT") fail(driftCode);
  }
  return states;
}

function createGithubProvider({ id, expected, createCode }) {
  gcloudRun(
    [
      "iam",
      "workload-identity-pools",
      "providers",
      "create-oidc",
      id,
      `--project=${cloud.projectId}`,
      "--location=global",
      `--workload-identity-pool=${cloud.wif.pool}`,
      `--issuer-uri=${expected.issuer}`,
      `--allowed-audiences=${expected.audience}`,
      `--attribute-mapping=${expected.mapping}`,
      `--attribute-condition=${expected.condition}`,
      "--format=none",
    ],
    createCode,
  );
}

function createKubernetesProvider({ id, expected, createCode }) {
  const directory = mkdtempSync(join(tmpdir(), "seori-p3-jwks-"));
  const jwksPath = join(directory, "jwks.json");
  try {
    writeFileSync(jwksPath, kubernetesJwks(), { encoding: "utf8", mode: 0o600 });
    gcloudRun(
      [
        "iam",
        "workload-identity-pools",
        "providers",
        "create-oidc",
        id,
        `--project=${cloud.projectId}`,
        "--location=global",
        `--workload-identity-pool=${cloud.wif.pool}`,
        `--issuer-uri=${expected.issuer}`,
        `--allowed-audiences=${expected.audience}`,
        `--attribute-mapping=${expected.mapping}`,
        `--attribute-condition=${expected.condition}`,
        `--jwk-json-path=${jwksPath}`,
        "--format=none",
      ],
      createCode,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function migrateGithubProvider({
  id,
  existing,
  expected,
  legacy,
  migrationCode,
}) {
  if (existing.disabled !== true) {
    updateProviderDisabled(id, true, migrationCode);
  }
  const disabledLegacy = providerRead(id);
  if (
    !providerConfigurationMatches(disabledLegacy, legacy) ||
    disabledLegacy?.disabled !== true
  ) {
    fail(migrationCode);
  }
  gcloudRun(
    [
      "iam",
      "workload-identity-pools",
      "providers",
      "update-oidc",
      id,
      `--project=${cloud.projectId}`,
      "--location=global",
      `--workload-identity-pool=${cloud.wif.pool}`,
      `--issuer-uri=${expected.issuer}`,
      `--allowed-audiences=${expected.audience}`,
      `--attribute-mapping=${expected.mapping}`,
      `--attribute-condition=${expected.condition}`,
      "--disabled",
      "--format=none",
    ],
    migrationCode,
  );
  const narrowed = providerRead(id);
  if (
    !providerConfigurationMatches(narrowed, expected) ||
    narrowed?.disabled !== true
  ) {
    fail(migrationCode);
  }
  updateProviderDisabled(id, false, migrationCode);
  if (!providerMatches(providerRead(id), expected)) fail(migrationCode);
}

function ensureProviders() {
  const states = preflightProviders();
  for (const state of states) {
    if (state.configurationState === "MISSING") {
      if (state.name === "github") createGithubProvider(state);
      else createKubernetesProvider(state);
      if (!providerMatches(providerRead(state.id), state.expected)) {
        fail(state.createCode);
      }
    } else if (state.configurationState === "LEGACY_MIGRATION_REQUIRED") {
      migrateGithubProvider(state);
    } else if (state.existing.disabled === true) {
      updateProviderDisabled(state.id, false, state.enableCode);
      if (!providerMatches(providerRead(state.id), state.expected)) {
        fail(state.enableCode);
      }
    }
  }
}

function bindingCommand(item) {
  const common = [`--member=${item.member}`, `--role=${item.role}`, "--format=none"];
  if (item.resourceType === "project") {
    return ["projects", "add-iam-policy-binding", cloud.projectId, ...common];
  }
  if (item.resourceType === "bucket") {
    return [
      "storage",
      "buckets",
      "add-iam-policy-binding",
      item.resource,
      ...common,
    ];
  }
  if (item.resourceType === "serviceAccount") {
    return [
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      item.resource,
      `--project=${cloud.projectId}`,
      ...common,
    ];
  }
  const segments = item.resource.split("/");
  return [
    "artifacts",
    "repositories",
    "add-iam-policy-binding",
    segments.at(-1),
    `--project=${cloud.projectId}`,
    `--location=${segments[3]}`,
    ...common,
  ];
}

function applyBindings() {
  for (const item of bindings) {
    gcloudRun(bindingCommand(item), "P3_GCP_IAM_BINDING_APPLY_FAILED");
  }
}

function readPolicy(item) {
  if (item.resourceType === "project") {
    return gcloudRun(
      ["projects", "get-iam-policy", cloud.projectId, "--format=json(bindings)"],
      "P3_GCP_PROJECT_IAM_READ_FAILED",
    );
  }
  if (item.resourceType === "bucket") {
    return gcloudRun(
      ["storage", "buckets", "get-iam-policy", item.resource, "--format=json(bindings)"],
      "P3_GCP_BUCKET_IAM_READ_FAILED",
    );
  }
  if (item.resourceType === "serviceAccount") {
    return gcloudRun(
      [
        "iam",
        "service-accounts",
        "get-iam-policy",
        item.resource,
        `--project=${cloud.projectId}`,
        "--format=json(bindings)",
      ],
      "P3_GCP_SERVICE_ACCOUNT_IAM_READ_FAILED",
    );
  }
  const segments = item.resource.split("/");
  return gcloudRun(
    [
      "artifacts",
      "repositories",
      "get-iam-policy",
      segments.at(-1),
      `--project=${cloud.projectId}`,
      `--location=${segments[3]}`,
      "--format=json(bindings)",
    ],
    "P3_GCP_ARTIFACT_IAM_READ_FAILED",
  );
}

function bindingPresent(item) {
  const raw = readPolicy(item);
  if (raw === null) return false;
  const policy = parsePublicJson(raw, "P3_GCP_IAM_RESPONSE_INVALID");
  return (policy.bindings ?? []).some(
    ({ role, members, condition }) =>
      role === item.role &&
      condition === undefined &&
      Array.isArray(members) &&
      members.includes(item.member),
  );
}

function readback() {
  const accountState = serviceAccounts.map((account) => {
    const raw = gcloudRun(
      [
        "iam",
        "service-accounts",
        "describe",
        account.email,
        `--project=${cloud.projectId}`,
        "--format=json(email,disabled)",
      ],
      "P3_GCP_SERVICE_ACCOUNT_READ_FAILED",
    );
    return raw === null
      ? { email: account.email, exists: false }
      : {
          ...parsePublicJson(raw, "P3_GCP_SERVICE_ACCOUNT_RESPONSE_INVALID"),
          exists: true,
        };
  });
  const pool = poolRead();
  const [githubSpec, kubernetesSpec] = providerSpecifications();
  const github = providerRead(githubSpec.id);
  const kubernetes = providerRead(kubernetesSpec.id);
  const bindingState = bindings.map((item) => ({ ...item, present: bindingPresent(item) }));
  return {
    project: { id: cloud.projectId, number: cloud.projectNumber },
    serviceAccounts: accountState,
    workloadIdentityPool: {
      exists: pool !== null,
      configurationExact: poolConfigurationMatches(pool),
      disabled: pool?.disabled === true,
      state: pool?.state ?? null,
      active: poolActive(pool),
    },
    providers: {
      github: {
        exists: github !== null,
        configurationExact: providerConfigurationMatches(
          github,
          githubSpec.expected,
        ),
        disabled: github?.disabled === true,
        active: providerActive(github),
      },
      kubernetes: {
        exists: kubernetes !== null,
        configurationExact: providerConfigurationMatches(
          kubernetes,
          kubernetesSpec.expected,
        ),
        disabled: kubernetes?.disabled === true,
        active: providerActive(kubernetes),
      },
    },
    iamBindings: bindingState,
    ready:
      accountState.every(({ exists, disabled }) => exists && disabled !== true) &&
      poolConfigurationMatches(pool) &&
      poolActive(pool) &&
      providerMatches(github, githubSpec.expected) &&
      providerMatches(kubernetes, kubernetesSpec.expected) &&
      bindingState.every(({ present }) => present),
    staticKeysCreated: false,
  };
}

function rollback() {
  const states = preflightProviders();
  const providersDisabled = [];
  const providersAbsent = [];
  for (const {
    id,
    expected,
    legacy,
    existing,
    configurationState,
  } of states) {
    if (existing === null) {
      providersAbsent.push(id);
      continue;
    }
    if (existing.disabled !== true) {
      updateProviderDisabled(id, true, "P3_GCP_WIF_PROVIDER_DISABLE_FAILED");
    }
    const disabled = providerRead(id);
    const rollbackConfiguration =
      configurationState === "LEGACY_MIGRATION_REQUIRED" ? legacy : expected;
    if (
      !providerConfigurationMatches(disabled, rollbackConfiguration) ||
      disabled?.disabled !== true
    ) {
      fail("P3_GCP_WIF_PROVIDER_DISABLE_FAILED");
    }
    providersDisabled.push(id);
  }
  return {
    state: "NEW_TOKEN_EXCHANGE_REVOKED",
    serviceAccountsDeleted: false,
    staticKeysDeleted: false,
    existingAccessTokensRevoked: false,
    providersDisabled,
    providersAbsent,
    iamBindingsMutated: false,
    exactBindingsPreserved: bindings.length,
    exactBindingsRemoved: 0,
  };
}

localSourcePreflight();
if (mode === "plan") {
  process.stdout.write(`${JSON.stringify(publicPlan(), null, 2)}\n`);
} else {
  gcpPreflight();
  if (mode === "apply") {
    ensureServiceAccounts();
    ensurePool();
    ensureProviders();
    applyBindings();
    process.stdout.write(`${JSON.stringify(readback(), null, 2)}\n`);
  } else if (mode === "readback") {
    process.stdout.write(`${JSON.stringify(readback(), null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(rollback(), null, 2)}\n`);
  }
}
