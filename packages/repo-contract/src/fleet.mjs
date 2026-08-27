import {
  createHash,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
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
const RUNTIME_ASSET_FILES = Object.freeze([
  ".github/workflows/godot-checks-v2.yml",
  ".github/workflows/rn-static-checks-v2.yml",
  "scripts/fleet/secret-scan.mjs",
  "scripts/fleet/static-preflight.mjs",
  "scripts/fleet/write-provenance.mjs",
]);
const ACTION_REPOSITORY_BY_KEY = Object.freeze({
  checkout: "actions/checkout",
  "setup-node": "actions/setup-node",
  "upload-artifact": "actions/upload-artifact",
});
const APPROVAL_REGISTRY_ID = "seorilabs-workflow-bundles-v1";
const APPROVAL_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TRUSTED_BUNDLE_BINDINGS = new WeakSet();
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

async function runtimeAssetDigests(repoRoot) {
  return Object.fromEntries(
    await Promise.all(
      RUNTIME_ASSET_FILES.map(async (relativePath) => [
        relativePath,
        sha256(await readFile(resolve(repoRoot, relativePath))),
      ]),
    ),
  );
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function runtimeDeclarationsMatch(bundle, repoRoot) {
  const workflowTextByProfile = Object.fromEntries(
    await Promise.all(
      Object.keys(WORKFLOW_BY_PROFILE).map(async (profile) => [
        profile,
        await readFile(resolve(repoRoot, WORKFLOW_BY_PROFILE[profile]), "utf8"),
      ]),
    ),
  );
  const combined = Object.values(workflowTextByProfile).join("\n");
  const declaredActions = new Map();
  for (const [key, action] of Object.entries(bundle?.actions ?? {})) {
    const repository = ACTION_REPOSITORY_BY_KEY[key];
    if (!repository || !SHA_PATTERN.test(action?.sha ?? "")) return false;
    declaredActions.set(repository, action.sha);
  }
  if (declaredActions.size !== Object.keys(ACTION_REPOSITORY_BY_KEY).length) {
    return false;
  }
  const observedActions = [
    ...combined.matchAll(/uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})/gu),
  ];
  if (observedActions.length === 0) return false;
  const seen = new Set();
  for (const [, repository, sha] of observedActions) {
    if (declaredActions.get(repository) !== sha) return false;
    seen.add(repository);
  }
  if ([...declaredActions.keys()].some((repository) => !seen.has(repository))) {
    return false;
  }

  const nodeVersion = regexEscape(bundle?.toolchains?.node ?? "");
  const pnpmVersion = regexEscape(bundle?.toolchains?.pnpm ?? "");
  if (
    !new RegExp(`node-version: ["']?${nodeVersion}["']?`, "u").test(combined) ||
    !new RegExp(`corepack prepare pnpm@${pnpmVersion} --activate`, "u").test(combined)
  ) {
    return false;
  }
  for (const script of bundle?.quality?.canonicalScripts ?? []) {
    if (!combined.includes(script)) return false;
  }
  if (
    !combined.includes(bundle?.runners?.privateGeneral ?? "") ||
    !combined.includes(bundle?.runners?.publicPullRequest ?? "")
  ) {
    return false;
  }

  const godot = workflowTextByProfile.godot;
  const godotToolchain = bundle?.toolchains?.godot;
  return (
    godot.includes(`Godot_v${godotToolchain?.version}-stable_linux.arm64.zip`) &&
    godot.includes(`Godot_v${godotToolchain?.version}-stable_linux.x86_64.zip`) &&
    godot.includes(godotToolchain?.linuxArm64Sha256 ?? "missing") &&
    godot.includes(godotToolchain?.linuxX64Sha256 ?? "missing")
  );
}

function approvalSigningPayload(bundle) {
  const payload = bundlePayload(bundle);
  const { signature: _signature, ...approval } = payload.approval ?? {};
  return {
    ...payload,
    approval,
  };
}

function approvalRegistrySubject(bundle) {
  return `workflow-bundle/${bundle.bundleVersion}/${bundle.source.sha}`;
}

function trustedApprovalKey(trustedApprovalKeys, keyId) {
  if (trustedApprovalKeys instanceof Map) {
    return trustedApprovalKeys.get(keyId);
  }
  if (
    trustedApprovalKeys !== null &&
    typeof trustedApprovalKeys === "object" &&
    Object.hasOwn(trustedApprovalKeys, keyId)
  ) {
    return trustedApprovalKeys[keyId];
  }
  return undefined;
}

function registryRecordMatches(record, bundle) {
  return (
    record !== null &&
    typeof record === "object" &&
    record.registryId === bundle.approval.registry.id &&
    record.subject === bundle.approval.registry.subject &&
    record.bundleDigest === bundle.integrity.payloadDigest &&
    record.sourceSha === bundle.source.sha &&
    record.bundleVersion === bundle.bundleVersion &&
    record.state === "APPROVED"
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
      runtimeAssetDigests: await runtimeAssetDigests(repoRoot),
    },
    reusableWorkflows: workflows,
    actions: source.actions,
    runners: source.runners,
    toolchains: source.toolchains,
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
  {
    repoRoot = WORKSPACE_ROOT,
    trustedApprovalKeys,
    trustedRegistryReadback,
  } = {},
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
  ].map((workflow) => workflow.sha);
  if (workflowShas.some((sha) => sha !== bundle?.source?.sha)) {
    diagnostics.push("WORKFLOW_SOURCE_SHA_MISMATCH");
  }

  try {
    const expectedContractDigests = await contractDigests(repoRoot);
    if (
      canonicalJson(bundle?.quality?.contractDigests ?? {}) !==
      canonicalJson(expectedContractDigests)
    ) {
      diagnostics.push("CONTRACT_DIGEST_MISMATCH");
    }
  } catch {
    diagnostics.push("CONTRACT_ASSET_UNREADABLE");
  }
  try {
    const expectedRuntimeAssetDigests = await runtimeAssetDigests(repoRoot);
    if (
      canonicalJson(bundle?.quality?.runtimeAssetDigests ?? {}) !==
      canonicalJson(expectedRuntimeAssetDigests)
    ) {
      diagnostics.push("RUNTIME_ASSET_DIGEST_MISMATCH");
    }
  } catch {
    diagnostics.push("RUNTIME_ASSET_UNREADABLE");
  }
  try {
    if (!(await runtimeDeclarationsMatch(bundle, repoRoot))) {
      diagnostics.push("RUNTIME_DECLARATION_MISMATCH");
    }
  } catch {
    diagnostics.push("RUNTIME_DECLARATION_UNREADABLE");
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
    if (bundle.approval.registry?.subject !== approvalRegistrySubject(bundle)) {
      diagnostics.push("APPROVAL_REGISTRY_SUBJECT_MISMATCH");
    }

    const signature = bundle.approval.signature;
    const trustedKey = trustedApprovalKey(
      trustedApprovalKeys,
      signature?.keyId,
    );
    let signatureVerified = false;
    if (!trustedKey) {
      diagnostics.push("APPROVAL_TRUSTED_KEY_REQUIRED");
    } else {
      try {
        signatureVerified = verifyEd25519(
          null,
          Buffer.from(canonicalJson(approvalSigningPayload(bundle))),
          trustedKey,
          Buffer.from(signature.value, "base64url"),
        );
      } catch {
        signatureVerified = false;
      }
      if (!signatureVerified) {
        diagnostics.push("APPROVAL_SIGNATURE_INVALID");
      }
    }

    if (typeof trustedRegistryReadback !== "function") {
      diagnostics.push("APPROVAL_REGISTRY_READBACK_REQUIRED");
    } else if (signatureVerified) {
      try {
        const record = await trustedRegistryReadback({
          registryId: bundle.approval.registry.id,
          subject: bundle.approval.registry.subject,
          bundleDigest: bundle.integrity.payloadDigest,
          sourceSha: bundle.source.sha,
          bundleVersion: bundle.bundleVersion,
        });
        if (!registryRecordMatches(record, bundle)) {
          diagnostics.push("APPROVAL_REGISTRY_READBACK_MISMATCH");
        }
      } catch {
        diagnostics.push("APPROVAL_REGISTRY_READBACK_FAILED");
      }
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
  {
    repoRoot = WORKSPACE_ROOT,
    evidenceVerifier,
    approvalSigner,
    registryPublisher,
  } = {},
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
  const candidateValidation = await validateWorkflowBundle(bundle, { repoRoot });
  if (!candidateValidation.ok) {
    throw new Error(
      `WORKFLOW_BUNDLE_INVALID:${candidateValidation.diagnostics.join(",")}`,
    );
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

  if (
    !APPROVAL_KEY_ID_PATTERN.test(approvalSigner?.keyId ?? "") ||
    !approvalSigner?.privateKey
  ) {
    throw new Error("APPROVAL_SIGNER_REQUIRED");
  }
  if (typeof registryPublisher !== "function") {
    throw new Error("APPROVAL_REGISTRY_PUBLISHER_REQUIRED");
  }

  const unsignedApproval = {
    ...bundle.approval,
    state: "APPROVED",
    evidence: evidence.toSorted((left, right) =>
      left.profile.localeCompare(right.profile),
    ),
    registry: {
      id: APPROVAL_REGISTRY_ID,
      subject: approvalRegistrySubject(bundle),
    },
  };
  const unsignedPromoted = {
    ...bundlePayload(bundle),
    approval: unsignedApproval,
  };
  const signatureValue = signEd25519(
    null,
    Buffer.from(canonicalJson(unsignedPromoted)),
    approvalSigner.privateKey,
  ).toString("base64url");
  const promoted = withIntegrity({
    ...unsignedPromoted,
    approval: {
      ...unsignedApproval,
      signature: {
        algorithm: "Ed25519",
        keyId: approvalSigner.keyId,
        value: signatureValue,
      },
    },
  });
  const registryRecord = {
    registryId: promoted.approval.registry.id,
    subject: promoted.approval.registry.subject,
    bundleDigest: promoted.integrity.payloadDigest,
    sourceSha: promoted.source.sha,
    bundleVersion: promoted.bundleVersion,
    state: "APPROVED",
  };
  const publishedRecord = await registryPublisher(registryRecord, promoted);
  if (!registryRecordMatches(publishedRecord, promoted)) {
    throw new Error("APPROVAL_REGISTRY_PUBLISH_FAILED");
  }
  const result = await validateWorkflowBundle(promoted, {
    repoRoot,
    trustedApprovalKeys: new Map([
      [approvalSigner.keyId, createPublicKey(approvalSigner.privateKey)],
    ]),
    trustedRegistryReadback: async () => publishedRecord,
  });
  if (!result.ok) {
    throw new Error(`WORKFLOW_BUNDLE_INVALID:${result.diagnostics.join(",")}`);
  }
  return promoted;
}

export async function loadApprovedWorkflowBundle(
  bundle,
  {
    repoRoot = WORKSPACE_ROOT,
    trustedApprovalKeys,
    trustedRegistryReadback,
  } = {},
) {
  if (bundle?.approval?.state !== "APPROVED") {
    throw new Error("APPROVED_BUNDLE_REQUIRED");
  }
  const validation = await validateWorkflowBundle(bundle, {
    repoRoot,
    trustedApprovalKeys,
    trustedRegistryReadback,
  });
  if (!validation.ok) {
    throw new Error(
      `APPROVED_BUNDLE_UNTRUSTED:${validation.diagnostics.join(",")}`,
    );
  }
  const workflowByProfile = Object.freeze(
    Object.fromEntries(
      Object.entries(bundle.reusableWorkflows).map(([profile, workflow]) => [
        profile,
        Object.freeze({ path: workflow.path, sha: workflow.sha }),
      ]),
    ),
  );
  const binding = Object.freeze({
    bundleDigest: bundle.integrity.payloadDigest,
    sourceSha: bundle.source.sha,
    workflowByProfile,
  });
  TRUSTED_BUNDLE_BINDINGS.add(binding);
  return binding;
}

function isTrustedBundleBinding(binding) {
  return (
    binding !== null &&
    typeof binding === "object" &&
    TRUSTED_BUNDLE_BINDINGS.has(binding)
  );
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

export function validateOrgContractCaller(
  text,
  { approvedBundleBinding } = {},
) {
  const parsed = parseCaller(text);
  if (parsed.diagnostic) {
    return { ok: false, diagnostics: [parsed.diagnostic] };
  }
  const caller = parsed.value;
  const diagnostics = [];
  const trustedBinding = isTrustedBundleBinding(approvedBundleBinding);
  if (!trustedBinding) {
    diagnostics.push("APPROVED_BUNDLE_BINDING_REQUIRED");
  }

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
    canonicalJson(caller?.on ?? {}) !==
    canonicalJson({
      pull_request: {},
      push: { branches: ["main"] },
      workflow_dispatch: {},
    })
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
    caller?.concurrency?.group !==
      "org-contract-${{ github.repository_id }}-${{ github.ref }}"
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
    /^seorilabs\/\.github\/(\.github\/workflows\/[a-z0-9-]+\.yml)@([0-9a-f]{40})$/u;
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

  const profile = usesMatch ? PROFILE_BY_WORKFLOW[usesMatch[1]] : undefined;
  const approvedWorkflow =
    trustedBinding && profile
      ? approvedBundleBinding.workflowByProfile[profile]
      : undefined;
  if (
    usesMatch &&
    (!approvedWorkflow ||
      usesMatch[1] !== approvedWorkflow.path ||
      usesMatch[2] !== approvedWorkflow.sha)
  ) {
    diagnostics.push("CALLER_APPROVED_WORKFLOW_MISMATCH");
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)].sort(),
    profile,
    workflowSha: approvedWorkflow?.sha,
  };
}

export function generateOrgContractCaller({
  profile,
  approvedBundleBinding,
  workingDirectory = ".",
  packageManager = "pnpm",
} = {}) {
  if (!WORKFLOW_BY_PROFILE[profile]) {
    throw new Error("PROFILE_NEEDS_INPUT");
  }
  if (!isTrustedBundleBinding(approvedBundleBinding)) {
    throw new Error("APPROVED_BUNDLE_BINDING_REQUIRED");
  }
  const approvedWorkflow = approvedBundleBinding.workflowByProfile[profile];
  if (
    !approvedWorkflow ||
    approvedWorkflow.path !== WORKFLOW_BY_PROFILE[profile] ||
    !SHA_PATTERN.test(approvedWorkflow.sha)
  ) {
    throw new Error("APPROVED_WORKFLOW_MISSING");
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
        uses: `seorilabs/.github/${approvedWorkflow.path}@${approvedWorkflow.sha}`,
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
  const validation = validateOrgContractCaller(rendered, {
    approvedBundleBinding,
  });
  if (!validation.ok) {
    throw new Error(`GENERATED_CALLER_INVALID:${validation.diagnostics.join(",")}`);
  }
  return rendered;
}

export const fleetContractPaths = Object.freeze({
  source: SOURCE_PATH,
  schema: SCHEMA_PATH,
});
