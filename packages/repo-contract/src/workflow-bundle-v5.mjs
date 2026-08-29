import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument, stringify } from "yaml";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "../..");
const GENERATED_ROOT = resolve(PACKAGE_ROOT, ".generated");
const SOURCE_WORKSPACE = existsSync(resolve(WORKSPACE_ROOT, "contracts/workflow-bundle-v5.schema.json"));
const CONTRACTS_ROOT = SOURCE_WORKSPACE
  ? resolve(WORKSPACE_ROOT, "contracts")
  : resolve(GENERATED_ROOT, "contracts");
const SOURCE_PATH = "contracts/workflow-bundle-v5-source.yaml";
const SCHEMA_PATH = "contracts/workflow-bundle-v5.schema.json";
const BINDING_SCHEMA_PATH = "contracts/workflow-bundle-v5-resolved-binding.schema.json";
const STATIC_RUNTIME_SCHEMA_PATH =
  "contracts/workflow-bundle-v5-static-runtime-readback.schema.json";
const XCODE_SCHEMA_PATH = "contracts/xcode-cloud-run-v5.schema.json";
const CONTRACT_FILES = Object.freeze([
  BINDING_SCHEMA_PATH,
  STATIC_RUNTIME_SCHEMA_PATH,
  SCHEMA_PATH,
  SOURCE_PATH,
  XCODE_SCHEMA_PATH,
  "profiles/ait-granite-v5.yaml",
  "profiles/ait-web-build-v5.yaml",
  "profiles/ait-web-v5.yaml",
  "profiles/capacitor-android-v5.yaml",
  "profiles/capacitor-ios-xcode-cloud-v5.yaml",
  "profiles/capacitor-v5.yaml",
]);
const RUNTIME_ASSET_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  ".github/cloud-build/capacitor-android-build-only-v1.yaml",
  ".github/cloud-build/godot-android-build-only.yaml",
  ".github/cloud-build/rn-android-build-only.yaml",
  ".github/workflows/ait-build-only-v1.yml",
  ".github/workflows/capacitor-build-android-cloud-v1.yml",
  ".github/workflows/godot-build-android-cloud-v1.yml",
  ".github/workflows/godot-checks-v3.yml",
  ".github/workflows/js-static-checks-v1.yml",
  ".github/workflows/rn-build-android-cloud-v1.yml",
  ".github/workflows/workflow-bundle-v5-candidate.yml",
  "fixtures/workflow-bundle-v5/saju-reader/binding.json",
  "fixtures/workflow-bundle-v5/saju-reader/repository/build.env",
  "fixtures/workflow-bundle-v5/saju-reader/repository/android/app/build.gradle",
  "fixtures/workflow-bundle-v5/saju-reader/repository/capacitor.config.ts",
  "fixtures/workflow-bundle-v5/saju-reader/repository/ci_scripts/ci_post_clone.sh",
  "fixtures/workflow-bundle-v5/saju-reader/repository/ci_scripts/ci_pre_xcodebuild.sh",
  "fixtures/workflow-bundle-v5/saju-reader/repository/granite.config.ts",
  "fixtures/workflow-bundle-v5/saju-reader/repository/ios/App/App.xcodeproj/project.pbxproj",
  "fixtures/workflow-bundle-v5/saju-reader/repository/package.json",
  "fixtures/workflow-bundle-v5/saju-reader/repository/pnpm-lock.yaml",
  "fixtures/workflow-bundle-v5/saju-reader/repository/scripts/architecture.mjs",
  "fixtures/workflow-bundle-v5/saju-reader/repository/scripts/build-ait.sh",
  "fixtures/workflow-bundle-v5/saju-reader/repository/scripts/build-android.sh",
  "fixtures/workflow-bundle-v5/saju-reader/repository/scripts/release.mjs",
  "fixtures/workflow-bundle-v5/godot-runtime/binding.json",
  "fixtures/workflow-bundle-v5/godot-runtime/repository/.npmrc",
  "fixtures/workflow-bundle-v5/godot-runtime/repository/package.json",
  "fixtures/workflow-bundle-v5/godot-runtime/repository/project.godot",
  "fixtures/workflow-bundle-v5/godot-runtime/repository/scripts/check_architecture.sh",
  "fixtures/workflow-bundle-v5/godot-runtime/repository/scripts/check_release.sh",
  "fixtures/workflow-bundle-v5/godot-runtime/repository/scripts/test_core.sh",
  "fixtures/workflow-bundle-v5/godot-runtime/toolchain-probe/project.godot",
  "fixtures/workflow-bundle-v5/trait-test-hub/binding.json",
  "fixtures/workflow-bundle-v5/trait-test-hub/repository/apps/ait/granite.config.ts",
  "fixtures/workflow-bundle-v5/trait-test-hub/repository/apps/ait/package.json",
  "fixtures/workflow-bundle-v5/trait-test-hub/repository/package.json",
  "fixtures/workflow-bundle-v5/trait-test-hub/repository/pnpm-lock.yaml",
  "fixtures/workflow-bundle-v5/trait-test-hub/repository/pnpm-workspace.yaml",
  "fixtures/workflow-bundle-v5/trait-test-hub/repository/scripts/architecture.mjs",
  "fixtures/workflow-bundle-v5/trait-test-hub/repository/scripts/build-ait.sh",
  "fixtures/workflow-bundle-v5/trait-test-hub/repository/scripts/release.mjs",
  "scripts/fleet/stage-private-package-v5.mjs",
  "scripts/fleet/godot-diagnostic-gate.mjs",
  "scripts/fleet/secret-scan.mjs",
  "scripts/fleet/static-runtime-binding-v5.mjs",
  "scripts/fleet/static-preflight-v5.mjs",
  "scripts/fleet/v5-paths.mjs",
]);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TRUSTED_BUNDLES = new WeakMap();
const TRUSTED_BINDINGS = new WeakMap();
const TRUST_BINDING_TTL_MS = 5 * 60 * 1000;
const SAFE_SEGMENT = /^[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*$/u;

function fail(code) {
  throw new Error(code);
}

function isSafeRelativePosixPath(value, { allowDot = false } = {}) {
  if (value === ".") return allowDot;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\")
  ) {
    return false;
  }
  return value.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      SAFE_SEGMENT.test(segment),
  );
}

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return !(
    pathFromParent === ".." ||
    pathFromParent.startsWith(`..${sep}`) ||
    pathFromParent.startsWith(sep)
  );
}

async function canonicalRoot(repoRoot) {
  const requested = resolve(repoRoot ?? "");
  const metadata = await lstat(requested).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    fail("REPOSITORY_ROOT_INVALID");
  }
  return realpath(requested);
}

async function resolveSafeDirectory(repoRoot, relativePath) {
  if (!isSafeRelativePosixPath(relativePath, { allowDot: true })) {
    fail("DIRECTORY_PATH_INVALID");
  }
  const root = await canonicalRoot(repoRoot);
  let current = root;
  if (relativePath !== ".") {
    for (const segment of relativePath.split("/")) {
      current = resolve(current, segment);
      const metadata = await lstat(current).catch(() => undefined);
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
        fail("DIRECTORY_PATH_UNTRUSTED");
      }
    }
  }
  const canonical = await realpath(current);
  if (!isWithin(root, canonical)) fail("DIRECTORY_PATH_ESCAPE");
  return Object.freeze({ root, path: canonical });
}

async function resolveSafeFile(repoRoot, relativePath) {
  if (!isSafeRelativePosixPath(relativePath)) fail("FILE_PATH_INVALID");
  const root = await canonicalRoot(repoRoot);
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    const metadata = await lstat(current).catch(() => undefined);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      fail("FILE_PARENT_UNTRUSTED");
    }
  }
  const requested = resolve(current, segments.at(-1));
  const metadata = await lstat(requested).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail("FILE_PATH_UNTRUSTED");
  const canonical = await realpath(requested);
  if (!isWithin(root, canonical)) fail("FILE_PATH_ESCAPE");
  return Object.freeze({ root, path: canonical });
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

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function payloadOf(bundle) {
  const { integrity: _integrity, ...payload } = bundle;
  return payload;
}

function withIntegrity(bundle) {
  const payload = payloadOf(bundle);
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      payloadDigest: sha256(canonicalJson(payload)),
    },
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parseYaml(text, path) {
  const document = parseDocument(text, {
    maxAliasCount: 20,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) fail(`YAML_PARSE_FAILED:${path}`);
  return document.toJS({ maxAliasCount: 20 });
}

async function readContract(relativePath, repoRoot = WORKSPACE_ROOT) {
  if (SOURCE_WORKSPACE || repoRoot !== WORKSPACE_ROOT) {
    return readFile(resolve(repoRoot, relativePath), "utf8");
  }
  const packagedRelative = relativePath.startsWith("contracts/")
    ? relativePath.slice("contracts/".length)
    : relativePath.startsWith("profiles/")
      ? `../profiles/${relativePath.slice("profiles/".length)}`
      : relativePath;
  return readFile(resolve(CONTRACTS_ROOT, packagedRelative), "utf8");
}

async function digestFiles(repoRoot, paths) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, sha256(await readFile(resolve(repoRoot, path)))]),
    ),
  );
}

async function compileSchema(path, repoRoot = WORKSPACE_ROOT) {
  const schema = JSON.parse(await readContract(path, repoRoot));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

function diagnostics(validate) {
  return (validate.errors ?? []).map((error) =>
    `${error.instancePath || "$"}:${error.keyword}`,
  );
}

function addExecutionSha(record, workflowExecutionSha) {
  return record.workflow === null
    ? structuredClone(record)
    : { ...structuredClone(record), sha: workflowExecutionSha };
}

function addStaticExecutionSha(record, workflowExecutionSha) {
  return { ...structuredClone(record), sha: workflowExecutionSha };
}

export async function createWorkflowBundleV5({
  sourceSha,
  workflowExecutionSha,
  repoRoot = WORKSPACE_ROOT,
} = {}) {
  if (!SHA.test(sourceSha ?? "") || !SHA.test(workflowExecutionSha ?? "")) {
    fail("WORKFLOW_BUNDLE_SHA_INVALID");
  }
  const source = parseYaml(
    await readFile(resolve(repoRoot, SOURCE_PATH), "utf8"),
    SOURCE_PATH,
  );
  const candidate = withIntegrity({
    schemaVersion: source.schemaVersion,
    bundleVersion: source.bundleVersion,
    source: {
      repository: source.repository,
      sha: sourceSha,
      workflowExecutionSha,
    },
    quality: {
      ...source.quality,
      contractDigests: await digestFiles(repoRoot, CONTRACT_FILES),
      runtimeAssetDigests: await digestFiles(repoRoot, RUNTIME_ASSET_FILES),
    },
    promotionScope: source.promotionScope,
    staticRuntimeBinding: source.staticRuntimeBinding,
    staticProfiles: Object.fromEntries(
      Object.entries(source.staticProfiles).map(([profile, record]) => [
        profile,
        addStaticExecutionSha(record, workflowExecutionSha),
      ]),
    ),
    buildProfiles: Object.fromEntries(
      Object.entries(source.buildProfiles).map(([profile, record]) => [
        profile,
        addExecutionSha(record, workflowExecutionSha),
      ]),
    ),
    actions: source.actions,
    runners: source.runners,
    toolchains: source.toolchains,
    callerPolicies: source.callerPolicies,
    lifecyclePolicy: source.lifecyclePolicy,
    approval: source.approval,
  });
  const result = await validateWorkflowBundleV5(candidate, {
    repoRoot,
    verifyLocalAssets: true,
  });
  if (!result.ok) fail(result.diagnostics[0] ?? "WORKFLOW_BUNDLE_V5_INVALID");
  return structuredClone(candidate);
}

export async function validateWorkflowBundleV5(
  bundle,
  { repoRoot = WORKSPACE_ROOT, verifyLocalAssets = SOURCE_WORKSPACE } = {},
) {
  const validate = await compileSchema(SCHEMA_PATH, repoRoot);
  const validSchema = validate(bundle);
  const result = [];
  if (!validSchema) result.push(...diagnostics(validate));
  if (
    !SHA256.test(bundle?.integrity?.payloadDigest ?? "") ||
    bundle?.integrity?.payloadDigest !== sha256(canonicalJson(payloadOf(bundle ?? {})))
  ) {
    result.push("WORKFLOW_BUNDLE_INTEGRITY_INVALID");
  }
  if (validSchema) {
    for (const record of Object.values(bundle.staticProfiles)) {
      if (record.sha !== bundle.source.workflowExecutionSha) {
        result.push("STATIC_WORKFLOW_SHA_MISMATCH");
      }
    }
    for (const record of Object.values(bundle.buildProfiles)) {
      if (record.workflow !== null && record.sha !== bundle.source.workflowExecutionSha) {
        result.push("BUILD_WORKFLOW_SHA_MISMATCH");
      }
    }
    if (verifyLocalAssets) {
      const expectedContracts = await digestFiles(repoRoot, CONTRACT_FILES).catch(() => null);
      const expectedRuntime = await digestFiles(repoRoot, RUNTIME_ASSET_FILES).catch(() => null);
      if (
        expectedContracts === null ||
        canonicalJson(expectedContracts) !== canonicalJson(bundle.quality.contractDigests)
      ) {
        result.push("WORKFLOW_BUNDLE_CONTRACT_DIGEST_MISMATCH");
      }
      if (
        expectedRuntime === null ||
        canonicalJson(expectedRuntime) !== canonicalJson(bundle.quality.runtimeAssetDigests)
      ) {
        result.push("WORKFLOW_BUNDLE_RUNTIME_DIGEST_MISMATCH");
      }
    }
  }
  return Object.freeze({ ok: result.length === 0, diagnostics: Object.freeze(result.sort()) });
}

export async function loadApprovedWorkflowBundleV5(
  bundle,
  { trustedApprovalVerifier } = {},
) {
  const snapshot = deepFreeze(structuredClone(bundle));
  const validation = await validateWorkflowBundleV5(snapshot, {
    verifyLocalAssets: false,
  });
  if (!validation.ok) fail(validation.diagnostics[0]);
  if (snapshot.approval.state !== "APPROVED") fail("WORKFLOW_BUNDLE_NOT_APPROVED");
  if (typeof trustedApprovalVerifier !== "function") fail("TRUSTED_APPROVAL_VERIFIER_REQUIRED");
  const candidateDigest = withIntegrity({
    ...payloadOf(snapshot),
    approval: { state: "CANDIDATE", evidence: [] },
  }).integrity.payloadDigest;
  const verification = await trustedApprovalVerifier({
    source: structuredClone(snapshot.source),
    candidateDigest,
    payloadDigest: snapshot.integrity.payloadDigest,
    signature: structuredClone(snapshot.approval.signature),
    evidence: structuredClone(snapshot.approval.evidence),
    contractDigests: structuredClone(snapshot.quality.contractDigests),
    runtimeAssetDigests: structuredClone(snapshot.quality.runtimeAssetDigests),
  });
  if (
    verification?.state !== "VERIFIED" ||
    verification.candidateDigest !== candidateDigest ||
    verification.payloadDigest !== snapshot.integrity.payloadDigest ||
    verification.sourceSha !== snapshot.source.sha ||
    verification.workflowExecutionSha !== snapshot.source.workflowExecutionSha ||
    verification.keyId !== snapshot.approval.signature.keyId ||
    verification.policyRevision !== snapshot.approval.signature.policyRevision ||
    verification.contractDigestsDigest !==
      sha256(canonicalJson(snapshot.quality.contractDigests)) ||
    verification.runtimeAssetDigestsDigest !==
      sha256(canonicalJson(snapshot.quality.runtimeAssetDigests)) ||
    verification.evidenceDigest !== sha256(canonicalJson(snapshot.approval.evidence))
  ) {
    fail("WORKFLOW_BUNDLE_APPROVAL_UNTRUSTED");
  }
  const binding = Object.freeze({});
  TRUSTED_BUNDLES.set(binding, {
    value: snapshot,
    expiresAt: Date.now() + TRUST_BINDING_TTL_MS,
  });
  return binding;
}

const REQUIRED_EVIDENCE = Object.freeze([
  "static:react-native",
  "static:godot",
  "static:capacitor",
  "static:ait-web",
]);

function evidenceIdentity(record) {
  return `${record.target}:${record.profile ?? record.buildProfile ?? ""}`;
}

function evidenceRuntimeMatches(bundle, record) {
  const runtime = record.target === "static" && bundle.staticProfiles[record.profile];
  return Boolean(
    runtime &&
    bundle.promotionScope.staticProfiles.includes(record.profile) &&
    runtime.sha === record.workflowExecutionSha &&
    record.workflowRef === `seorilabs/.github/${runtime.path}@${runtime.sha}`,
  );
}

const EVIDENCE_READBACK_FIELDS = Object.freeze([
  "target",
  "profile",
  "buildProfile",
  "repositoryId",
  "fullName",
  "sourceSha",
  "bindingSourceSha",
  "callerWorkflowRef",
  "manifestDigest",
  "workflowExecutionSha",
  "workflowRef",
  "runId",
  "runAttempt",
  "configRevisionId",
  "configRevision",
  "configRevisionDigest",
  "signedSnapshotDigest",
  "snapshotSignatureKeyId",
  "snapshotSignaturePolicyRevision",
  "snapshotSignatureDigest",
  "artifactSha256",
]);

export async function promoteWorkflowBundleV5(
  candidate,
  evidence,
  { trustedEvidenceVerifier, trustedApprovalSigner, repoRoot = WORKSPACE_ROOT } = {},
) {
  const candidateSnapshot = deepFreeze(structuredClone(candidate));
  const evidenceSnapshot = deepFreeze(structuredClone(evidence));
  const validation = await validateWorkflowBundleV5(candidateSnapshot, { repoRoot });
  if (!validation.ok) fail(validation.diagnostics[0]);
  if (candidateSnapshot.approval.state !== "CANDIDATE") fail("WORKFLOW_BUNDLE_NOT_CANDIDATE");
  if (!Array.isArray(evidenceSnapshot) || typeof trustedEvidenceVerifier !== "function") {
    fail("TRUSTED_EVIDENCE_VERIFIER_REQUIRED");
  }
  if (typeof trustedApprovalSigner !== "function") fail("TRUSTED_APPROVAL_SIGNER_REQUIRED");
  const identities = evidenceSnapshot.map(evidenceIdentity).sort();
  if (canonicalJson(identities) !== canonicalJson([...REQUIRED_EVIDENCE].sort())) {
    fail("WORKFLOW_BUNDLE_EVIDENCE_SET_INVALID");
  }
  const evidenceShape = withIntegrity({
    ...payloadOf(candidateSnapshot),
    approval: {
      state: "APPROVED",
      evidence: structuredClone(evidenceSnapshot),
      signature: {
        algorithm: "Ed25519",
        keyId: "workflow-bundle-v5-shape-check",
        policyRevision: "workflow-bundle-v5-shape-check",
        value: Buffer.alloc(64).toString("base64url"),
      },
    },
  });
  const evidenceShapeValidation = await validateWorkflowBundleV5(evidenceShape, { repoRoot });
  if (!evidenceShapeValidation.ok) {
    fail(`WORKFLOW_BUNDLE_EVIDENCE_INVALID:${evidenceShapeValidation.diagnostics[0]}`);
  }
  const verified = [];
  for (const record of evidenceSnapshot) {
    if (!evidenceRuntimeMatches(candidateSnapshot, record)) {
      fail("WORKFLOW_BUNDLE_EVIDENCE_RUNTIME_MISMATCH");
    }
    const readback = await trustedEvidenceVerifier(
      structuredClone(record),
      structuredClone(candidateSnapshot),
    );
    if (
      readback?.state !== "VERIFIED" ||
      readback.identity !== evidenceIdentity(record) ||
      EVIDENCE_READBACK_FIELDS.some(
        (field) => record[field] !== undefined && readback[field] !== record[field],
      ) ||
      readback.evidenceDigest !== sha256(canonicalJson(record))
    ) {
      fail("WORKFLOW_BUNDLE_EVIDENCE_UNTRUSTED");
    }
    verified.push(structuredClone(record));
  }
  const evidenceDigest = sha256(canonicalJson(verified));
  const signature = await trustedApprovalSigner({
    source: structuredClone(candidateSnapshot.source),
    candidateDigest: candidateSnapshot.integrity.payloadDigest,
    evidenceDigest,
    contractDigestsDigest: sha256(canonicalJson(candidateSnapshot.quality.contractDigests)),
    runtimeAssetDigestsDigest: sha256(canonicalJson(candidateSnapshot.quality.runtimeAssetDigests)),
  });
  const approved = withIntegrity({
    ...payloadOf(candidateSnapshot),
    approval: { state: "APPROVED", evidence: verified, signature },
  });
  const approvedValidation = await validateWorkflowBundleV5(approved, { repoRoot });
  if (!approvedValidation.ok) fail(approvedValidation.diagnostics[0]);
  return deepFreeze(approved);
}

function bundleFrom(binding) {
  const record = binding !== null && typeof binding === "object"
    ? TRUSTED_BUNDLES.get(binding)
    : undefined;
  if (!record) fail("APPROVED_WORKFLOW_BUNDLE_BINDING_REQUIRED");
  if (record.expiresAt <= Date.now()) fail("APPROVED_WORKFLOW_BUNDLE_BINDING_EXPIRED");
  return record.value;
}

function sourceHead(repoRoot) {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail("REPOSITORY_SOURCE_READBACK_FAILED");
  }
}

function validateBindingRelationships(manifest) {
  const targets = manifest.buildBindings.map(({ target }) => target);
  if (new Set(targets).size !== targets.length) fail("BUILD_TARGET_DUPLICATE");
  const allowed = {
    "react-native": new Set(["react-native-android", "ait-granite"]),
    godot: new Set(["godot-android"]),
    capacitor: new Set(["capacitor-android", "capacitor-ios-xcode-cloud", "ait-web"]),
    "ait-web": new Set(["ait-web"]),
  }[manifest.staticBinding.profile];
  if (manifest.buildBindings.some(({ buildProfile }) => !allowed?.has(buildProfile))) {
    fail("STATIC_BUILD_PROFILE_MISMATCH");
  }
}

async function validateBindingPaths(repoRoot, manifest) {
  const workspace = await resolveSafeDirectory(repoRoot, manifest.staticBinding.workspaceRoot);
  const command = await resolveSafeDirectory(repoRoot, manifest.staticBinding.commandDirectory);
  if (!isWithin(workspace.path, command.path)) {
    fail("COMMAND_DIRECTORY_OUTSIDE_WORKSPACE");
  }
  for (const binding of manifest.buildBindings) {
    const execution = await resolveSafeDirectory(repoRoot, binding.executionRoot);
    const dependency = await resolveSafeDirectory(repoRoot, binding.dependencyRoot);
    const script = await resolveSafeFile(repoRoot, binding.scriptPath);
    if (!isWithin(dependency.path, execution.path) || !isWithin(dependency.path, script.path)) {
      fail("BUILD_BINDING_PATH_RELATION_INVALID");
    }
    const executionPrefix = binding.executionRoot === "." ? "" : `${binding.executionRoot}/`;
    if (binding.buildProfile === "capacitor-android") {
      await resolveSafeFile(repoRoot, `${executionPrefix}build.env`);
      await resolveSafeFile(repoRoot, `${executionPrefix}capacitor.config.ts`);
    }
    if (binding.buildProfile === "capacitor-ios-xcode-cloud") {
      const prebuild = `${dirname(binding.scriptPath)}/ci_pre_xcodebuild.sh`;
      await resolveSafeFile(repoRoot, prebuild);
      await resolveSafeFile(
        repoRoot,
        `${executionPrefix}ios/App/App.xcodeproj/project.pbxproj`,
      );
    }
    if (["ait-granite", "ait-web"].includes(binding.buildProfile)) {
      await resolveSafeFile(repoRoot, `${executionPrefix}granite.config.ts`);
    }
  }
}

export async function loadResolvedWorkflowBindingV5(
  repositoryContext,
  { trustedResolvedManifestReadback, repoRoot } = {},
) {
  if (
    !repositoryContext ||
    !/^[1-9][0-9]{0,31}$/u.test(repositoryContext.repositoryId ?? "") ||
    !/^seorilabs\/[A-Za-z0-9._-]+$/u.test(repositoryContext.fullName ?? "") ||
    !SHA.test(repositoryContext.sourceSha ?? "")
  ) {
    fail("REPOSITORY_CONTEXT_INVALID");
  }
  if (typeof trustedResolvedManifestReadback !== "function") {
    fail("TRUSTED_RESOLVED_MANIFEST_READBACK_REQUIRED");
  }
  if (typeof repoRoot !== "string" || repoRoot.length === 0) fail("REPOSITORY_ROOT_REQUIRED");
  const readback = await trustedResolvedManifestReadback(structuredClone(repositoryContext));
  const manifest = readback?.manifest;
  if (
    readback?.state !== "VERIFIED" ||
    readback.repositoryId !== repositoryContext.repositoryId ||
    readback.fullName !== repositoryContext.fullName ||
    readback.sourceSha !== repositoryContext.sourceSha ||
    readback.manifestDigest !== sha256(canonicalJson(manifest ?? {})) ||
    readback.configRevisionId !== manifest?.configRevisionId ||
    readback.configRevision !== manifest?.configRevision ||
    readback.configRevisionDigest !== manifest?.configRevisionDigest ||
    readback.signedSnapshotDigest !== manifest?.signedSnapshotDigest ||
    readback.snapshotSignatureKeyId !== manifest?.snapshotSignature?.keyId ||
    readback.snapshotSignaturePolicyRevision !== manifest?.snapshotSignature?.policyRevision ||
    readback.snapshotSignatureDigest !== manifest?.snapshotSignature?.digest
  ) {
    fail("RESOLVED_BINDING_READBACK_UNTRUSTED");
  }
  const validate = await compileSchema(BINDING_SCHEMA_PATH);
  if (!validate(manifest)) fail(`RESOLVED_BINDING_INVALID:${diagnostics(validate)[0] ?? "schema"}`);
  if (
    manifest.repositoryId !== repositoryContext.repositoryId ||
    manifest.fullName !== repositoryContext.fullName ||
    manifest.sourceSha !== repositoryContext.sourceSha ||
    manifest.sourceSha !== sourceHead(repoRoot)
  ) {
    fail("RESOLVED_BINDING_REPOSITORY_MISMATCH");
  }
  validateBindingRelationships(manifest);
  await validateBindingPaths(repoRoot, manifest);
  const state = deepFreeze(structuredClone(manifest));
  const binding = Object.freeze({});
  TRUSTED_BINDINGS.set(binding, {
    value: state,
    expiresAt: Date.now() + TRUST_BINDING_TTL_MS,
  });
  return binding;
}

function manifestFrom(binding) {
  const record = binding !== null && typeof binding === "object"
    ? TRUSTED_BINDINGS.get(binding)
    : undefined;
  if (!record) fail("RESOLVED_WORKFLOW_BINDING_REQUIRED");
  if (record.expiresAt <= Date.now()) fail("RESOLVED_WORKFLOW_BINDING_EXPIRED");
  return record.value;
}

function workflowDocument(value) {
  return [
    "# WorkflowBundle v5 generator가 관리합니다. 수동 편집하지 마십시오.",
    stringify(value, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
}

function staticPermissions(profile) {
  return profile === "godot"
    ? { contents: "read", "id-token": "write" }
    : { contents: "read", "id-token": "write", packages: "read" };
}

export function generateStaticCallerV5({ approvedBundleBinding, resolvedBinding } = {}) {
  const bundle = bundleFrom(approvedBundleBinding);
  const manifest = manifestFrom(resolvedBinding);
  if (manifest.state === "DEPRECATED") fail("DEPRECATED_NO_CALLER");
  const staticBinding = manifest.staticBinding;
  const workflow = bundle.staticProfiles[staticBinding.profile];
  return workflowDocument({
    name: "Org Contract",
    on: {
      pull_request: { branches: ["main"] },
      push: { branches: ["main"] },
      workflow_dispatch: {},
    },
    permissions: staticPermissions(staticBinding.profile),
    concurrency: {
      group: "org-contract-${{ github.repository_id }}-${{ github.ref }}",
      "cancel-in-progress": true,
    },
    jobs: {
      "org-contract": {
        uses: `seorilabs/.github/${workflow.path}@${workflow.sha}`,
      },
    },
  });
}

export function validateStaticCallerV5(caller, options = {}) {
  try {
    const expected = generateStaticCallerV5(options);
    const exact = caller === expected;
    const forbidden = /secrets:\s*inherit|@main\b/u.test(caller);
    return Object.freeze({
      ok: exact && !forbidden,
      diagnostics: Object.freeze([
        ...(!exact ? ["STATIC_CALLER_NOT_EXACT"] : []),
        ...(forbidden ? ["STATIC_CALLER_FORBIDDEN_REFERENCE"] : []),
      ]),
    });
  } catch (error) {
    return Object.freeze({ ok: false, diagnostics: Object.freeze([error.message]) });
  }
}

export function generateBuildCallerV5({
  approvedBundleBinding,
  resolvedBinding,
  target,
} = {}) {
  const bundle = bundleFrom(approvedBundleBinding);
  const manifest = manifestFrom(resolvedBinding);
  if (manifest.state !== "ACTIVE") fail(`${manifest.state}_BUILD_CALLER_FORBIDDEN`);
  if (!["android", "ait"].includes(target)) fail("BUILD_TARGET_INVALID");
  if (bundle.promotionScope.buildProfiles.length !== 0) {
    fail("WORKFLOW_BUNDLE_BUILD_PROMOTION_SCOPE_INVALID");
  }
  fail("BUILD_RUNTIME_BINDING_UNAVAILABLE");
}

export function validateBuildCallerV5(caller, options = {}) {
  try {
    const expected = generateBuildCallerV5(options);
    const exact = caller === expected;
    const forbidden = /secrets:\s*inherit|@main\b/u.test(caller);
    return Object.freeze({
      ok: exact && !forbidden,
      diagnostics: Object.freeze([
        ...(!exact ? ["BUILD_CALLER_NOT_EXACT"] : []),
        ...(forbidden ? ["BUILD_CALLER_FORBIDDEN_REFERENCE"] : []),
      ]),
    });
  } catch (error) {
    return Object.freeze({ ok: false, diagnostics: Object.freeze([error.message]) });
  }
}

export async function generateXcodeCloudRunV5({
  approvedBundleBinding,
  resolvedBinding,
  productId,
  workflowId,
  sourceReferenceId,
} = {}) {
  const bundle = bundleFrom(approvedBundleBinding);
  const manifest = manifestFrom(resolvedBinding);
  if (manifest.state !== "ACTIVE") fail(`${manifest.state}_XCODE_RUN_FORBIDDEN`);
  if (bundle.promotionScope.buildProfiles.length !== 0) {
    fail("WORKFLOW_BUNDLE_BUILD_PROMOTION_SCOPE_INVALID");
  }
  void productId;
  void workflowId;
  void sourceReferenceId;
  fail("BUILD_RUNTIME_BINDING_UNAVAILABLE");
}

export const workflowBundleV5Contract = Object.freeze({
  bundleVersion: "5.0.0",
  schemaVersion: 2,
  staticProfiles: Object.freeze(["react-native", "godot", "capacitor", "ait-web"]),
  promotionScope: Object.freeze({
    staticProfiles: Object.freeze(["react-native", "godot", "capacitor", "ait-web"]),
    buildProfiles: Object.freeze([]),
  }),
  buildProfiles: Object.freeze([
    "react-native-android",
    "godot-android",
    "capacitor-android",
    "capacitor-ios-xcode-cloud",
    "ait-granite",
    "ait-web",
  ]),
  lifecycle: Object.freeze({ ACTIVE: "ENFORCE", PAUSED: "SHADOW", DEPRECATED: "NO_CALLER" }),
  namedSecrets: 0,
  staticRuntimeBinding: Object.freeze({
    authentication: "github-oidc",
    sourceStrategy: "event-sha-with-pr-base-binding",
    prPolicy: "trusted-github-pr-readback-required",
    calledWorkflows: Object.freeze({
      jsStatic: Object.freeze({
        path: ".github/workflows/js-static-checks-v1.yml",
        profiles: Object.freeze(["react-native", "capacitor", "ait-web"]),
        packageManagers: Object.freeze(["npm", "pnpm"]),
      }),
      godot: Object.freeze({
        path: ".github/workflows/godot-checks-v3.yml",
        profiles: Object.freeze(["godot"]),
        packageManagers: Object.freeze([null]),
      }),
    }),
  }),
  trustBindingTtlSeconds: TRUST_BINDING_TTL_MS / 1000,
});
