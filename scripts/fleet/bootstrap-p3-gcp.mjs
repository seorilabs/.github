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

if (!modes.has(mode) || process.argv.length > 4) fail("P3_GCP_COMMAND_INVALID");

const expectedConfirmation = `fleet-p3-${cloud.wif.workflowSourceSha.slice(0, 12)}`;
const expectedRollback = `fleet-p3-rollback-${cloud.wif.workflowSourceSha.slice(0, 12)}`;
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
    const object = `${cloud.wif.workflowSourceSha}:${workflow}`;
    let bytes;
    try {
      bytes = execFileSync("git", ["show", object], {
        cwd: repositoryRoot,
        encoding: null,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      const encoded = run(
        "gh",
        [
          "api",
          "--method",
          "GET",
          `/repos/seorilabs/.github/contents/${workflow}`,
          "-f",
          `ref=${cloud.wif.workflowSourceSha}`,
          "--jq",
          '.encoding + ":" + .content',
        ],
        "P3_WORKFLOW_SOURCE_READ_FAILED",
      );
      if (encoded === null || !encoded.startsWith("base64:")) {
        fail("P3_WORKFLOW_SOURCE_MISSING");
      }
      try {
        bytes = Buffer.from(encoded.slice("base64:".length), "base64");
      } catch {
        fail("P3_WORKFLOW_SOURCE_READ_FAILED");
      }
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) fail("P3_WORKFLOW_SOURCE_DIGEST_MISMATCH");
  }
}

function githubCondition() {
  const workflowClauses = cloud.wif.repositories.map(
    ({ workflow }) =>
      `assertion.job_workflow_ref == 'seorilabs/.github/${workflow}@${cloud.wif.workflowSourceSha}'`,
  );
  const repositoryClauses = cloud.wif.repositories.map(
    ({ repositoryId }) => `assertion.repository_id == '${repositoryId}'`,
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

const githubMapping = [
  "google.subject=assertion.sub",
  "attribute.repository=assertion.repository",
  "attribute.repository_id=assertion.repository_id",
  "attribute.job_workflow_ref=assertion.job_workflow_ref",
].join(",");
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
    resume: "같은 apply 명령을 다시 실행하면 exact-existing 객체는 no-op하고 미완료 단계만 진행한다.",
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

function ensurePool() {
  const existing = gcloudRun(
    [
      "iam",
      "workload-identity-pools",
      "describe",
      cloud.wif.pool,
      `--project=${cloud.projectId}`,
      "--location=global",
      "--format=value(name)",
    ],
    "P3_GCP_WIF_POOL_READ_FAILED",
  );
  if (existing === null) {
    gcloudRun(
      [
        "iam",
        "workload-identity-pools",
        "create",
        cloud.wif.pool,
        `--project=${cloud.projectId}`,
        "--location=global",
        "--display-name=Seorilabs Fleet P3",
        "--description=Dedicated keyless identities for Fleet Cloud Build and Auth Broker",
        "--format=none",
      ],
      "P3_GCP_WIF_POOL_CREATE_FAILED",
    );
  }
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

function providerMatches(actual, { condition, mapping, issuer, audience }) {
  const actualMapping = Object.entries(actual?.attributeMapping ?? {}).toSorted(
    ([left], [right]) => left.localeCompare(right),
  );
  const expectedMapping = Object.entries(mappingObject(mapping)).toSorted(
    ([left], [right]) => left.localeCompare(right),
  );
  return (
    actual?.disabled === false &&
    actual?.attributeCondition === condition &&
    JSON.stringify(actualMapping) === JSON.stringify(expectedMapping) &&
    actual?.oidc?.issuerUri === issuer &&
    Array.isArray(actual?.oidc?.allowedAudiences) &&
    actual.oidc.allowedAudiences.length === 1 &&
    actual.oidc.allowedAudiences[0] === audience
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

function ensureGithubProvider() {
  const expected = {
    condition: githubCondition(),
    mapping: githubMapping,
    issuer: cloud.wif.githubIssuer,
    audience: cloud.wif.githubAudience,
  };
  const existing = providerRead(cloud.wif.githubProvider);
  if (existing !== null) {
    if (!providerMatches(existing, expected)) fail("P3_GITHUB_WIF_PROVIDER_DRIFT");
    return;
  }
  gcloudRun(
    [
      "iam",
      "workload-identity-pools",
      "providers",
      "create-oidc",
      cloud.wif.githubProvider,
      `--project=${cloud.projectId}`,
      "--location=global",
      `--workload-identity-pool=${cloud.wif.pool}`,
      `--issuer-uri=${expected.issuer}`,
      `--allowed-audiences=${expected.audience}`,
      `--attribute-mapping=${expected.mapping}`,
      `--attribute-condition=${expected.condition}`,
      "--format=none",
    ],
    "P3_GITHUB_WIF_PROVIDER_CREATE_FAILED",
  );
}

function ensureKubernetesProvider() {
  const expected = {
    condition: kubernetesCondition(),
    mapping: kubernetesMapping,
    issuer: cloud.wif.kubernetesIssuer,
    audience: auth.wifAudience,
  };
  const existing = providerRead(cloud.wif.kubernetesProvider);
  if (existing !== null) {
    if (!providerMatches(existing, expected)) fail("P3_KUBERNETES_WIF_PROVIDER_DRIFT");
    return;
  }
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
        cloud.wif.kubernetesProvider,
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
      "P3_KUBERNETES_WIF_PROVIDER_CREATE_FAILED",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function bindingCommand(action, item) {
  const verb = action === "add" ? "add-iam-policy-binding" : "remove-iam-policy-binding";
  const common = [`--member=${item.member}`, `--role=${item.role}`, "--format=none"];
  if (item.resourceType === "project") {
    return ["projects", verb, cloud.projectId, ...common];
  }
  if (item.resourceType === "bucket") {
    return ["storage", "buckets", verb, item.resource, ...common];
  }
  if (item.resourceType === "serviceAccount") {
    return [
      "iam",
      "service-accounts",
      verb,
      item.resource,
      `--project=${cloud.projectId}`,
      ...common,
    ];
  }
  const segments = item.resource.split("/");
  return [
    "artifacts",
    "repositories",
    verb,
    segments.at(-1),
    `--project=${cloud.projectId}`,
    `--location=${segments[3]}`,
    ...common,
  ];
}

function applyBindings() {
  for (const item of bindings) {
    gcloudRun(bindingCommand("add", item), "P3_GCP_IAM_BINDING_APPLY_FAILED");
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
  const github = providerRead(cloud.wif.githubProvider);
  const kubernetes = providerRead(cloud.wif.kubernetesProvider);
  const bindingState = bindings.map((item) => ({ ...item, present: bindingPresent(item) }));
  return {
    project: { id: cloud.projectId, number: cloud.projectNumber },
    serviceAccounts: accountState,
    providers: {
      github: { exists: github !== null, exact: providerMatches(github, {
        condition: githubCondition(), mapping: githubMapping,
        issuer: cloud.wif.githubIssuer, audience: cloud.wif.githubAudience,
      }) },
      kubernetes: { exists: kubernetes !== null, exact: providerMatches(kubernetes, {
        condition: kubernetesCondition(), mapping: kubernetesMapping,
        issuer: cloud.wif.kubernetesIssuer, audience: auth.wifAudience,
      }) },
    },
    iamBindings: bindingState,
    ready:
      accountState.every(({ exists, disabled }) => exists && disabled !== true) &&
      providerMatches(github, {
        condition: githubCondition(), mapping: githubMapping,
        issuer: cloud.wif.githubIssuer, audience: cloud.wif.githubAudience,
      }) &&
      providerMatches(kubernetes, {
        condition: kubernetesCondition(), mapping: kubernetesMapping,
        issuer: cloud.wif.kubernetesIssuer, audience: auth.wifAudience,
      }) &&
      bindingState.every(({ present }) => present),
    staticKeysCreated: false,
  };
}

function rollback() {
  for (const item of bindings.toReversed()) {
    if (bindingPresent(item)) {
      gcloudRun(bindingCommand("remove", item), "P3_GCP_IAM_BINDING_ROLLBACK_FAILED");
    }
  }
  for (const provider of [cloud.wif.githubProvider, cloud.wif.kubernetesProvider]) {
    if (providerRead(provider) !== null) {
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
          "--disabled",
          "--format=none",
        ],
        "P3_GCP_WIF_PROVIDER_DISABLE_FAILED",
      );
    }
  }
  return {
    state: "ACCESS_REVOKED",
    serviceAccountsDeleted: false,
    staticKeysDeleted: false,
    providersDisabled: [cloud.wif.githubProvider, cloud.wif.kubernetesProvider],
    exactBindingsRemoved: bindings.length,
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
    ensureGithubProvider();
    ensureKubernetesProvider();
    applyBindings();
    process.stdout.write(`${JSON.stringify(readback(), null, 2)}\n`);
  } else if (mode === "readback") {
    process.stdout.write(`${JSON.stringify(readback(), null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(rollback(), null, 2)}\n`);
  }
}
