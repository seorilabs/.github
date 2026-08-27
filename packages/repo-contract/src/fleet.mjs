import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument, stringify } from "yaml";

const WORKSPACE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_PATH = "contracts/workflow-bundle-source.yaml";
const SCHEMA_PATH = "contracts/workflow-bundle.schema.json";
const PROFILE_BY_WORKFLOW = Object.freeze({
  ".github/workflows/rn-static-checks-v2.yml": "react-native",
  ".github/workflows/godot-checks-v2.yml": "godot",
});
const WORKFLOW_BY_PROFILE = Object.freeze(
  Object.fromEntries(
    Object.entries(PROFILE_BY_WORKFLOW).map(([workflow, profile]) => [
      profile,
      workflow,
    ]),
  ),
);
const CONTRACT_FILES = Object.freeze([
  "contracts/app.schema.json",
  "contracts/release-policy.yaml",
  "contracts/test-policy.yaml",
  "contracts/workflow-bundle.schema.json",
  "contracts/workflow-bundle-source.yaml",
  "profiles/fleet-godot.yaml",
  "profiles/fleet-react-native.yaml",
  "profiles/godot.yaml",
  "profiles/react-native.yaml",
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_RELATIVE_DIRECTORY = /^(?:\.|[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*)$/u;

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
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

function bundlePayload(bundle) {
  const { integrity: _integrity, ...payload } = bundle;
  return payload;
}

function withIntegrity(bundle) {
  const payload = bundlePayload(bundle);
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      payloadDigest: sha256(canonicalJson(payload)),
    },
  };
}

async function readYaml(path) {
  const text = await readFile(path, "utf8");
  const document = parseDocument(text, {
    maxAliasCount: 20,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`YAML_PARSE_FAILED:${path}`);
  }
  return document.toJS({ maxAliasCount: 20 });
}

async function contractDigests(repoRoot) {
  return Object.fromEntries(
    await Promise.all(
      CONTRACT_FILES.map(async (relativePath) => [
        relativePath,
        sha256(await readFile(resolve(repoRoot, relativePath))),
      ]),
    ),
  );
}

function normalizePlatformRelease(platformRelease) {
  if (platformRelease === undefined || platformRelease === null) {
    return { state: "UNRESOLVED" };
  }

  const sourceSha = platformRelease.sourceSha;
  const contractRevision = platformRelease.contractRevision;
  const typescript =
    platformRelease.typescript ?? platformRelease.artifacts?.typescript;
  const gdscript = platformRelease.gdscript ?? platformRelease.artifacts?.gdscript;

  if (
    !SHA_PATTERN.test(sourceSha ?? "") ||
    !SHA256_PATTERN.test(contractRevision ?? "") ||
    !typescript ||
    !gdscript
  ) {
    throw new Error("PLATFORM_RELEASE_INVALID");
  }

  for (const artifact of [typescript, gdscript]) {
    if (
      typeof artifact.version !== "string" ||
      !SHA256_PATTERN.test(artifact.digest ?? "")
    ) {
      throw new Error("PLATFORM_RELEASE_INVALID");
    }
  }

  return {
    state: "RESOLVED",
    sourceSha,
    contractRevision,
    typescript: {
      version: typescript.version,
      digest: typescript.digest,
    },
    gdscript: {
      version: gdscript.version,
      digest: gdscript.digest,
    },
  };
}

export async function createWorkflowBundle({
  repoRoot = WORKSPACE_ROOT,
  sourceSha,
  platformRelease,
} = {}) {
  if (!SHA_PATTERN.test(sourceSha ?? "")) {
    throw new Error("SOURCE_SHA_INVALID");
  }

  const source = await readYaml(resolve(repoRoot, SOURCE_PATH));
  const workflows = Object.fromEntries(
    Object.entries(source.reusableWorkflows).map(([profile, workflow]) => [
      profile,
      { ...workflow, sha: sourceSha },
    ]),
  );
  const buildWorkflows = Object.fromEntries(
    Object.entries(source.buildWorkflows).map(([target, workflow]) => [
      target,
      { ...workflow, sha: sourceSha },
    ]),
  );

  const candidate = withIntegrity({
    schemaVersion: source.schemaVersion,
    bundleVersion: source.bundleVersion,
    source: {
      repository: source.repository,
      sha: sourceSha,
    },
    quality: {
      ...source.quality,
      contractDigests: await contractDigests(repoRoot),
    },
    reusableWorkflows: workflows,
    buildWorkflows,
    actions: source.actions,
    runners: source.runners,
    toolchains: source.toolchains,
    builders: source.builders,
    platform: normalizePlatformRelease(platformRelease),
    approval: {
      ...source.approval,
      evidence: [],
    },
  });

  const result = await validateWorkflowBundle(candidate, { repoRoot });
  if (!result.ok) {
    throw new Error(`WORKFLOW_BUNDLE_INVALID:${result.diagnostics.join(",")}`);
  }
  return candidate;
}

export async function validateWorkflowBundle(
  bundle,
  { repoRoot = WORKSPACE_ROOT } = {},
) {
  const diagnostics = [];
  let schema;
  try {
    schema = JSON.parse(
      await readFile(resolve(repoRoot, SCHEMA_PATH), "utf8"),
    );
  } catch {
    return { ok: false, diagnostics: ["SCHEMA_UNREADABLE"] };
  }

  let validate;
  try {
    validate = new Ajv2020({
      allErrors: true,
      messages: false,
      strict: true,
      validateFormats: false,
    }).compile(schema);
  } catch {
    return { ok: false, diagnostics: ["SCHEMA_INVALID"] };
  }

  if (!validate(bundle)) {
    diagnostics.push(
      ...(validate.errors ?? []).map(
        (error) =>
          `SCHEMA_${error.keyword.toUpperCase()}:${error.instancePath || "/"}`,
      ),
    );
  }

  const expectedDigest = sha256(canonicalJson(bundlePayload(bundle)));
  if (bundle?.integrity?.payloadDigest !== expectedDigest) {
    diagnostics.push("INTEGRITY_MISMATCH");
  }

  const workflowShas = [
    ...Object.values(bundle?.reusableWorkflows ?? {}),
    ...Object.values(bundle?.buildWorkflows ?? {}),
  ].map((workflow) => workflow.sha);
  if (workflowShas.some((sha) => sha !== bundle?.source?.sha)) {
    diagnostics.push("WORKFLOW_SOURCE_SHA_MISMATCH");
  }

  if (bundle?.approval?.state === "APPROVED") {
    if (bundle?.platform?.state !== "RESOLVED") {
      diagnostics.push("APPROVED_PLATFORM_UNRESOLVED");
    }
    const profiles = (bundle.approval.evidence ?? [])
      .map(({ profile }) => profile)
      .sort();
    if (
      profiles.length !== 2 ||
      profiles[0] !== "godot" ||
      profiles[1] !== "react-native"
    ) {
      diagnostics.push("APPROVED_CANARY_EVIDENCE_INCOMPLETE");
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

export async function promoteWorkflowBundle(
  bundle,
  evidence,
  { repoRoot = WORKSPACE_ROOT, evidenceVerifier } = {},
) {
  const profiles = evidence.map(({ profile }) => profile).sort();
  if (
    bundle?.approval?.state !== "CANDIDATE" ||
    bundle?.platform?.state !== "RESOLVED" ||
    profiles.length !== 2 ||
    profiles[0] !== "godot" ||
    profiles[1] !== "react-native"
  ) {
    throw new Error("WORKFLOW_BUNDLE_NOT_PROMOTABLE");
  }
  if (typeof evidenceVerifier !== "function") {
    throw new Error("CANARY_EVIDENCE_VERIFIER_REQUIRED");
  }
  const evidenceResults = await Promise.all(
    evidence.map((record) => evidenceVerifier(record, bundle)),
  );
  if (evidenceResults.some((verified) => verified !== true)) {
    throw new Error("CANARY_EVIDENCE_READBACK_FAILED");
  }

  const promoted = withIntegrity({
    ...bundlePayload(bundle),
    approval: {
      ...bundle.approval,
      state: "APPROVED",
      evidence: evidence.toSorted((left, right) =>
        left.profile.localeCompare(right.profile),
      ),
    },
  });
  const result = await validateWorkflowBundle(promoted, { repoRoot });
  if (!result.ok) {
    throw new Error(`WORKFLOW_BUNDLE_INVALID:${result.diagnostics.join(",")}`);
  }
  return promoted;
}

function parseCaller(text) {
  const document = parseDocument(text, {
    maxAliasCount: 10,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return { diagnostic: "CALLER_YAML_INVALID" };
  }
  return { value: document.toJS({ maxAliasCount: 10 }) };
}

function containsSecretInheritance(value) {
  if (value === "inherit") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsSecretInheritance);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, nested]) =>
        (key.toLowerCase() === "secrets" && nested === "inherit") ||
        containsSecretInheritance(nested),
    );
  }
  return false;
}

export function validateOrgContractCaller(text) {
  const parsed = parseCaller(text);
  if (parsed.diagnostic) {
    return { ok: false, diagnostics: [parsed.diagnostic] };
  }
  const caller = parsed.value;
  const diagnostics = [];

  const allowedTopLevel = new Set([
    "name",
    "on",
    "permissions",
    "concurrency",
    "jobs",
  ]);
  if (
    caller === null ||
    typeof caller !== "object" ||
    Object.keys(caller).some((key) => !allowedTopLevel.has(key))
  ) {
    diagnostics.push("CALLER_TOP_LEVEL_INVALID");
  }
  if (caller?.name !== "Org Contract") {
    diagnostics.push("CALLER_NAME_INVALID");
  }

  const eventNames = Object.keys(caller?.on ?? {}).sort();
  if (
    JSON.stringify(eventNames) !==
      JSON.stringify(["pull_request", "push", "workflow_dispatch"])
  ) {
    diagnostics.push("CALLER_EVENTS_INVALID");
  }
  if (
    caller?.on?.pull_request === null ||
    typeof caller?.on?.pull_request !== "object" ||
    caller?.on?.workflow_dispatch === null ||
    typeof caller?.on?.workflow_dispatch !== "object" ||
    JSON.stringify(caller?.on?.push?.branches) !== JSON.stringify(["main"])
  ) {
    diagnostics.push("CALLER_TRIGGER_POLICY_INVALID");
  }

  if (containsSecretInheritance(caller)) {
    diagnostics.push("SECRET_INHERITANCE_FORBIDDEN");
  }

  const permissionEntries = Object.entries(caller?.permissions ?? {}).sort();
  const expectedPermissions = [
    ["contents", "read"],
    ["packages", "read"],
  ];
  if (JSON.stringify(permissionEntries) !== JSON.stringify(expectedPermissions)) {
    diagnostics.push("CALLER_PERMISSIONS_INVALID");
  }

  if (
    caller?.concurrency?.["cancel-in-progress"] !== true ||
    typeof caller?.concurrency?.group !== "string" ||
    !caller.concurrency.group.includes("github.repository_id") ||
    !caller.concurrency.group.includes("github.ref")
  ) {
    diagnostics.push("CALLER_CONCURRENCY_INVALID");
  }

  const jobs = Object.entries(caller?.jobs ?? {});
  if (jobs.length !== 1 || jobs[0]?.[0] !== "org-contract") {
    diagnostics.push("CALLER_JOB_SET_INVALID");
  }
  const job = caller?.jobs?.["org-contract"];
  if (!job || job.name !== "Org Contract") {
    diagnostics.push("REQUIRED_CHECK_NAME_INVALID");
  }
  if (job && (job["runs-on"] !== undefined || job.steps !== undefined)) {
    diagnostics.push("THIN_CALLER_REQUIRED");
  }
  if (
    job &&
    Object.keys(job).some((key) => !["name", "uses", "with"].includes(key))
  ) {
    diagnostics.push("CALLER_JOB_POLICY_INVALID");
  }
  if (job?.secrets !== undefined) {
    diagnostics.push("STATIC_CALLER_SECRETS_FORBIDDEN");
  }

  const usesPattern =
    /^seorilabs\/\.github\/\.github\/workflows\/(rn-static-checks-v2|godot-checks-v2)\.yml@([0-9a-f]{40})$/u;
  const usesMatch = usesPattern.exec(job?.uses ?? "");
  if (!usesMatch) {
    diagnostics.push("REUSABLE_WORKFLOW_FULL_SHA_REQUIRED");
  }

  const withInputs = job?.with ?? {};
  const unexpectedInputs = Object.keys(withInputs).filter(
    (key) => !["package_manager", "working_directory"].includes(key),
  );
  if (unexpectedInputs.length > 0) {
    diagnostics.push("CALLER_INPUT_NOT_ALLOWED");
  }
  if (!SAFE_RELATIVE_DIRECTORY.test(withInputs.working_directory ?? ".")) {
    diagnostics.push("WORKING_DIRECTORY_INVALID");
  }
  if (!["npm", "pnpm"].includes(withInputs.package_manager ?? "pnpm")) {
    diagnostics.push("PACKAGE_MANAGER_INVALID");
  }

  const profile = usesMatch
    ? PROFILE_BY_WORKFLOW[`.github/workflows/${usesMatch[1]}.yml`]
    : undefined;
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)].sort(),
    profile,
    workflowSha: usesMatch?.[2],
  };
}

export function generateOrgContractCaller({
  profile,
  workflowSha,
  workingDirectory = ".",
  packageManager = "pnpm",
} = {}) {
  const workflow = WORKFLOW_BY_PROFILE[profile];
  if (!workflow) {
    throw new Error("PROFILE_NEEDS_INPUT");
  }
  if (!SHA_PATTERN.test(workflowSha ?? "")) {
    throw new Error("WORKFLOW_SHA_INVALID");
  }
  if (!SAFE_RELATIVE_DIRECTORY.test(workingDirectory)) {
    throw new Error("WORKING_DIRECTORY_INVALID");
  }
  if (!["npm", "pnpm"].includes(packageManager)) {
    throw new Error("PACKAGE_MANAGER_INVALID");
  }

  const caller = {
    name: "Org Contract",
    on: {
      pull_request: {},
      push: { branches: ["main"] },
      workflow_dispatch: {},
    },
    permissions: {
      contents: "read",
      packages: "read",
    },
    concurrency: {
      group:
        "org-contract-${{ github.repository_id }}-${{ github.ref }}",
      "cancel-in-progress": true,
    },
    jobs: {
      "org-contract": {
        name: "Org Contract",
        uses: `seorilabs/.github/${workflow}@${workflowSha}`,
        with: {
          package_manager: packageManager,
          working_directory: workingDirectory,
        },
      },
    },
  };
  const rendered = [
    "# 중앙 generator가 관리합니다. 수동 편집하지 마십시오.",
    stringify(caller, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
  const validation = validateOrgContractCaller(rendered);
  if (!validation.ok) {
    throw new Error(`GENERATED_CALLER_INVALID:${validation.diagnostics.join(",")}`);
  }
  return rendered;
}

export const fleetContractPaths = Object.freeze({
  source: SOURCE_PATH,
  schema: SCHEMA_PATH,
});
