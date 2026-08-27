import {
  createHash,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { Buffer } from "node:buffer";
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
  "contracts/fleet-bootstrap-plan.schema.json",
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
const APPROVED_BINDING_TTL_MS = 5 * 60 * 1000;
const TRUSTED_BUNDLE_BINDINGS = new WeakMap();
const TRUSTED_CALLER_BINDINGS = new WeakMap();
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_RELATIVE_DIRECTORY = /^(?:\.|[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*)$/u;
const REPOSITORY_FULL_NAME_PATTERN = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{9,127}$/u;
const SNAPSHOT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_REF_PATTERN = /^[^\u0000-\u001F\u007F]{1,512}$/u;
const FLEET_DEFAULT_REF = "refs/heads/main";

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

function sourceSnapshotMatches(snapshot, bundle) {
  if (!(
    snapshot !== null &&
    typeof snapshot === "object" &&
    snapshot.repository === "seorilabs/.github" &&
    snapshot.sourceSha === bundle?.source?.sha &&
    canonicalJson(snapshot.contractDigests ?? {}) ===
      canonicalJson(bundle?.quality?.contractDigests ?? {}) &&
    canonicalJson(snapshot.runtimeAssetDigests ?? {}) ===
      canonicalJson(bundle?.quality?.runtimeAssetDigests ?? {}) &&
    typeof snapshot.workflowBundleSchemaText === "string" &&
    sha256(Buffer.from(snapshot.workflowBundleSchemaText, "utf8")) ===
      bundle?.quality?.contractDigests?.[SCHEMA_PATH]
  )) {
    return false;
  }
  const runtimeContents = snapshot.runtimeAssetContents;
  return (
    runtimeContents !== null &&
    typeof runtimeContents === "object" &&
    canonicalJson(Object.keys(runtimeContents).sort()) ===
      canonicalJson([...RUNTIME_ASSET_FILES].sort()) &&
    RUNTIME_ASSET_FILES.every(
      (path) =>
        typeof runtimeContents[path] === "string" &&
        sha256(Buffer.from(runtimeContents[path], "utf8")) ===
          bundle.quality.runtimeAssetDigests[path],
    )
  );
}

async function verifyWorkflowSourceReadback(bundle, trustedWorkflowSourceReadback) {
  if (typeof trustedWorkflowSourceReadback !== "function") {
    return { diagnostic: "WORKFLOW_SOURCE_READBACK_REQUIRED" };
  }
  try {
    const observed = await trustedWorkflowSourceReadback({
      repository: "seorilabs/.github",
      sourceSha: bundle.source.sha,
      contractPaths: [...CONTRACT_FILES],
      runtimeAssetPaths: [...RUNTIME_ASSET_FILES],
    });
    const snapshot = structuredClone(observed);
    if (!sourceSnapshotMatches(snapshot, bundle)) {
      return { diagnostic: "WORKFLOW_SOURCE_READBACK_MISMATCH" };
    }
    return { snapshot };
  } catch {
    return { diagnostic: "WORKFLOW_SOURCE_READBACK_FAILED" };
  }
}

function fixedGitHubApiUrl(path, query = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function githubJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
  });
  if (!response?.ok) {
    throw new Error(`GITHUB_READBACK_HTTP_${response?.status ?? "UNKNOWN"}`);
  }
  return response.json();
}

function decodeGitHubContents(value) {
  const normalized = value.replace(/\s/gu, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) {
    throw new Error("GITHUB_CONTENT_INVALID");
  }
  return Buffer.from(normalized, "base64");
}

export function createGitHubWorkflowSourceReadback({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("GITHUB_FETCH_REQUIRED");
  }
  const snapshotPromises = new Map();
  return async ({ repository, sourceSha, contractPaths, runtimeAssetPaths }) => {
    if (
      repository !== "seorilabs/.github" ||
      !SHA_PATTERN.test(sourceSha ?? "") ||
      canonicalJson(contractPaths) !== canonicalJson([...CONTRACT_FILES]) ||
      canonicalJson(runtimeAssetPaths) !== canonicalJson([...RUNTIME_ASSET_FILES])
    ) {
      throw new Error("GITHUB_SOURCE_REQUEST_INVALID");
    }
    if (!snapshotPromises.has(sourceSha)) {
      snapshotPromises.set(
        sourceSha,
        (async () => {
          const commit = await githubJson(
            fetchImpl,
            fixedGitHubApiUrl(`/repos/seorilabs/.github/commits/${sourceSha}`),
          );
          if (commit?.sha !== sourceSha) {
            throw new Error("GITHUB_COMMIT_MISMATCH");
          }

          const fileEntries = await Promise.all(
            [...CONTRACT_FILES, ...RUNTIME_ASSET_FILES].map(
              async (relativePath) => {
                const encodedPath = relativePath
                  .split("/")
                  .map((segment) => encodeURIComponent(segment))
                  .join("/");
                const contents = await githubJson(
                  fetchImpl,
                  fixedGitHubApiUrl(
                    `/repos/seorilabs/.github/contents/${encodedPath}`,
                    { ref: sourceSha },
                  ),
                );
                if (
                  contents?.type !== "file" ||
                  contents?.encoding !== "base64" ||
                  typeof contents.content !== "string"
                ) {
                  throw new Error("GITHUB_CONTENT_INVALID");
                }
                const content = decodeGitHubContents(contents.content);
                return [relativePath, { content, digest: sha256(content) }];
              },
            ),
          );
          const fileByPath = Object.fromEntries(fileEntries);
          return {
            repository,
            sourceSha,
            contractDigests: Object.fromEntries(
              CONTRACT_FILES.map((path) => [path, fileByPath[path].digest]),
            ),
            runtimeAssetDigests: Object.fromEntries(
              RUNTIME_ASSET_FILES.map((path) => [path, fileByPath[path].digest]),
            ),
            workflowBundleSchemaText:
              fileByPath[SCHEMA_PATH].content.toString("utf8"),
            runtimeAssetContents: Object.fromEntries(
              RUNTIME_ASSET_FILES.map((path) => [
                path,
                fileByPath[path].content.toString("utf8"),
              ]),
            ),
          };
        })(),
      );
    }
    try {
      return structuredClone(await snapshotPromises.get(sourceSha));
    } catch (error) {
      snapshotPromises.delete(sourceSha);
      throw error;
    }
  };
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function runtimeDeclarationsMatchTexts(bundle, workflowTextByProfile) {
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

async function runtimeDeclarationsMatch(bundle, repoRoot) {
  const workflowTextByProfile = Object.fromEntries(
    await Promise.all(
      Object.keys(WORKFLOW_BY_PROFILE).map(async (profile) => [
        profile,
        await readFile(resolve(repoRoot, WORKFLOW_BY_PROFILE[profile]), "utf8"),
      ]),
    ),
  );
  return runtimeDeclarationsMatchTexts(bundle, workflowTextByProfile);
}

function sourceRuntimeDeclarationsMatch(bundle, snapshot) {
  const workflowTextByProfile = Object.fromEntries(
    Object.entries(WORKFLOW_BY_PROFILE).map(([profile, path]) => [
      profile,
      snapshot.runtimeAssetContents[path],
    ]),
  );
  return runtimeDeclarationsMatchTexts(bundle, workflowTextByProfile);
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
    trustedWorkflowSourceReadback,
  } = {},
) {
  try {
    bundle = structuredClone(bundle);
  } catch {
    return { ok: false, diagnostics: ["BUNDLE_SNAPSHOT_INVALID"] };
  }
  const diagnostics = [];
  const approvedSourceReadback =
    bundle?.approval?.state === "APPROVED"
      ? await verifyWorkflowSourceReadback(
          bundle,
          trustedWorkflowSourceReadback,
        )
      : undefined;
  if (approvedSourceReadback?.diagnostic) {
    diagnostics.push(approvedSourceReadback.diagnostic);
  }
  let schema;
  try {
    const schemaText = approvedSourceReadback?.snapshot
      ?.workflowBundleSchemaText ??
      (await readFile(resolve(repoRoot, SCHEMA_PATH), "utf8"));
    schema = JSON.parse(schemaText);
  } catch {
    diagnostics.push("SCHEMA_UNREADABLE");
    return { ok: false, diagnostics: [...new Set(diagnostics)].sort() };
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
    diagnostics.push("SCHEMA_INVALID");
    return { ok: false, diagnostics: [...new Set(diagnostics)].sort() };
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

  if (bundle?.approval?.state !== "APPROVED") {
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
  } else if (
    approvedSourceReadback?.snapshot &&
    !sourceRuntimeDeclarationsMatch(bundle, approvedSourceReadback.snapshot)
  ) {
    diagnostics.push("RUNTIME_DECLARATION_MISMATCH");
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
    trustedWorkflowSourceReadback,
  } = {},
) {
  try {
    bundle = structuredClone(bundle);
    evidence = structuredClone(evidence);
  } catch {
    throw new Error("BUNDLE_SNAPSHOT_INVALID");
  }
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
  const sourceReadback = await verifyWorkflowSourceReadback(
    bundle,
    trustedWorkflowSourceReadback,
  );
  if (sourceReadback.diagnostic) {
    throw new Error(sourceReadback.diagnostic);
  }
  if (typeof evidenceVerifier !== "function") {
    throw new Error("CANARY_EVIDENCE_VERIFIER_REQUIRED");
  }
  const evidenceResults = await Promise.all(
    evidence.map((record) =>
      evidenceVerifier(structuredClone(record), structuredClone(bundle)),
    ),
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
  const publishedRecord = await registryPublisher(
    structuredClone(registryRecord),
    structuredClone(promoted),
  );
  if (!registryRecordMatches(publishedRecord, promoted)) {
    throw new Error("APPROVAL_REGISTRY_PUBLISH_FAILED");
  }
  const result = await validateWorkflowBundle(promoted, {
    repoRoot,
    trustedApprovalKeys: new Map([
      [approvalSigner.keyId, createPublicKey(approvalSigner.privateKey)],
    ]),
    trustedRegistryReadback: async () => publishedRecord,
    trustedWorkflowSourceReadback,
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
    trustedWorkflowSourceReadback,
  } = {},
) {
  try {
    bundle = structuredClone(bundle);
  } catch {
    throw new Error("BUNDLE_SNAPSHOT_INVALID");
  }
  if (bundle?.approval?.state !== "APPROVED") {
    throw new Error("APPROVED_BUNDLE_REQUIRED");
  }
  const validation = await validateWorkflowBundle(bundle, {
    repoRoot,
    trustedApprovalKeys,
    trustedRegistryReadback,
    trustedWorkflowSourceReadback,
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
    expiresAt: new Date(Date.now() + APPROVED_BINDING_TTL_MS).toISOString(),
  });
  TRUSTED_BUNDLE_BINDINGS.set(
    binding,
    Object.freeze({
      expiresAtMs: Date.parse(binding.expiresAt),
      bundle,
      workflowByProfile,
      trustedRegistryReadback,
    }),
  );
  return binding;
}

function bundleBindingState(binding) {
  if (binding === null || typeof binding !== "object") return undefined;
  return TRUSTED_BUNDLE_BINDINGS.get(binding);
}

async function verifyBundleBinding(binding) {
  const state = bundleBindingState(binding);
  if (!state) return { diagnostic: "APPROVED_BUNDLE_BINDING_REQUIRED" };
  if (Date.now() >= state.expiresAtMs) {
    return { diagnostic: "APPROVED_BUNDLE_BINDING_EXPIRED" };
  }
  try {
    const record = await state.trustedRegistryReadback({
      registryId: state.bundle.approval.registry.id,
      subject: state.bundle.approval.registry.subject,
      bundleDigest: state.bundle.integrity.payloadDigest,
      sourceSha: state.bundle.source.sha,
      bundleVersion: state.bundle.bundleVersion,
    });
    if (!registryRecordMatches(record, state.bundle)) {
      return { diagnostic: "APPROVED_BUNDLE_REGISTRY_REVOKED" };
    }
    if (Date.now() >= state.expiresAtMs) {
      return { diagnostic: "APPROVED_BUNDLE_BINDING_EXPIRED" };
    }
  } catch {
    return { diagnostic: "APPROVED_BUNDLE_REGISTRY_READBACK_FAILED" };
  }
  return { state };
}

export function createBackofficeResolvedManifestReadback({
  origin,
  fetchImpl = globalThis.fetch,
} = {}) {
  let fixedOrigin;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("BACKOFFICE_ORIGIN_INVALID");
    }
    fixedOrigin = parsed.origin;
  } catch {
    throw new Error("BACKOFFICE_ORIGIN_INVALID");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("BACKOFFICE_FETCH_REQUIRED");
  }

  return async ({ repositoryId, fullName, sourceSha }) => {
    if (
      !REPOSITORY_ID_PATTERN.test(repositoryId ?? "") ||
      !REPOSITORY_FULL_NAME_PATTERN.test(fullName ?? "") ||
      !SHA_PATTERN.test(sourceSha ?? "")
    ) {
      throw new Error("BACKOFFICE_MANIFEST_REQUEST_INVALID");
    }
    const url = new URL(
      `/control-plane/apps/${encodeURIComponent(repositoryId)}/resolved-manifest`,
      fixedOrigin,
    );
    url.searchParams.set("ref", sourceSha);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (!response?.ok) {
      throw new Error(
        `BACKOFFICE_MANIFEST_HTTP_${response?.status ?? "UNKNOWN"}`,
      );
    }
    const payload = await response.json();
    const { app, config, source, workflowCaller } = payload ?? {};
    if (
      app?.repoId !== repositoryId ||
      app?.repoFullName !== fullName ||
      source?.sha !== sourceSha ||
      !SOURCE_REF_PATTERN.test(source?.ref ?? "") ||
      source.ref !== FLEET_DEFAULT_REF ||
      !CONFIG_ID_PATTERN.test(source?.observationId ?? "") ||
      source?.payload === null ||
      typeof source?.payload !== "object" ||
      Array.isArray(source.payload) ||
      config?.status !== "ACTIVE" ||
      !CONFIG_ID_PATTERN.test(config?.id ?? "") ||
      !Number.isSafeInteger(config?.revision) ||
      config.revision < 1 ||
      !SNAPSHOT_DIGEST_PATTERN.test(config?.digest ?? "") ||
      config.signature === undefined ||
      config.signature === null ||
      workflowCaller === null ||
      typeof workflowCaller !== "object" ||
      canonicalJson(Object.keys(workflowCaller).sort()) !==
        canonicalJson(["packageManager", "profile", "workingDirectory"]) ||
      !Object.hasOwn(WORKFLOW_BY_PROFILE, workflowCaller.profile) ||
      !["npm", "pnpm"].includes(workflowCaller.packageManager) ||
      !SAFE_RELATIVE_DIRECTORY.test(workflowCaller.workingDirectory ?? "")
    ) {
      throw new Error("BACKOFFICE_MANIFEST_RESPONSE_INVALID");
    }
    return {
      state: "ACTIVE",
      repositoryId,
      fullName,
      sourceSha,
      sourceRef: source.ref,
      observationId: source.observationId,
      sourcePayloadDigest: sha256(canonicalJson(source.payload)),
      profile: workflowCaller.profile,
      packageManager: workflowCaller.packageManager,
      workingDirectory: workflowCaller.workingDirectory,
      configId: config.id,
      configRevision: config.revision,
      snapshotDigest: config.digest,
      configSignatureDigest: sha256(canonicalJson(config.signature)),
    };
  };
}

function normalizeCallerManifest(value) {
  let manifest;
  try {
    manifest = structuredClone(value);
  } catch {
    return undefined;
  }
  const expectedKeys = [
    "configId",
    "configRevision",
    "configSignatureDigest",
    "fullName",
    "observationId",
    "packageManager",
    "profile",
    "repositoryId",
    "snapshotDigest",
    "sourcePayloadDigest",
    "sourceRef",
    "sourceSha",
    "state",
    "workingDirectory",
  ];
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    canonicalJson(Object.keys(manifest).sort()) !== canonicalJson(expectedKeys) ||
    manifest.state !== "ACTIVE" ||
    !REPOSITORY_ID_PATTERN.test(manifest.repositoryId ?? "") ||
    !REPOSITORY_FULL_NAME_PATTERN.test(manifest.fullName ?? "") ||
    !SHA_PATTERN.test(manifest.sourceSha ?? "") ||
    !SOURCE_REF_PATTERN.test(manifest.sourceRef ?? "") ||
    !CONFIG_ID_PATTERN.test(manifest.observationId ?? "") ||
    !SHA256_PATTERN.test(manifest.sourcePayloadDigest ?? "") ||
    !Object.hasOwn(WORKFLOW_BY_PROFILE, manifest.profile) ||
    !["npm", "pnpm"].includes(manifest.packageManager) ||
    !SAFE_RELATIVE_DIRECTORY.test(manifest.workingDirectory ?? "") ||
    !CONFIG_ID_PATTERN.test(manifest.configId ?? "") ||
    !Number.isSafeInteger(manifest.configRevision) ||
    manifest.configRevision < 1 ||
    !SNAPSHOT_DIGEST_PATTERN.test(manifest.snapshotDigest ?? "") ||
    !SHA256_PATTERN.test(manifest.configSignatureDigest ?? "")
  ) {
    return undefined;
  }
  return Object.freeze(manifest);
}

function repositoryContextMatches(context, manifest) {
  return (
    context !== null &&
    typeof context === "object" &&
    REPOSITORY_ID_PATTERN.test(context.repositoryId ?? "") &&
    context.repositoryId === manifest.repositoryId &&
    context.fullName === manifest.fullName &&
    context.sourceSha === manifest.sourceSha
  );
}

export async function loadResolvedCallerBinding(
  repositoryContext,
  { trustedResolvedManifestReadback } = {},
) {
  if (
    typeof trustedResolvedManifestReadback !== "function" ||
    repositoryContext === null ||
    typeof repositoryContext !== "object" ||
    !REPOSITORY_ID_PATTERN.test(repositoryContext.repositoryId ?? "") ||
    !REPOSITORY_FULL_NAME_PATTERN.test(repositoryContext.fullName ?? "") ||
    !SHA_PATTERN.test(repositoryContext.sourceSha ?? "")
  ) {
    throw new Error("CALLER_MANIFEST_READBACK_REQUIRED");
  }
  let manifest;
  try {
    manifest = normalizeCallerManifest(
      await trustedResolvedManifestReadback({
        repositoryId: repositoryContext.repositoryId,
        fullName: repositoryContext.fullName,
        sourceSha: repositoryContext.sourceSha,
      }),
    );
  } catch {
    throw new Error("CALLER_MANIFEST_READBACK_FAILED");
  }
  if (!manifest || !repositoryContextMatches(repositoryContext, manifest)) {
    throw new Error("CALLER_MANIFEST_MISMATCH");
  }
  const expiresAtMs = Date.now() + APPROVED_BINDING_TTL_MS;
  const binding = Object.freeze({
    repositoryId: manifest.repositoryId,
    fullName: manifest.fullName,
    sourceSha: manifest.sourceSha,
    sourceRef: manifest.sourceRef,
    observationId: manifest.observationId,
    sourcePayloadDigest: manifest.sourcePayloadDigest,
    configId: manifest.configId,
    configRevision: manifest.configRevision,
    snapshotDigest: manifest.snapshotDigest,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  TRUSTED_CALLER_BINDINGS.set(
    binding,
    Object.freeze({
      expiresAtMs,
      manifest,
      trustedResolvedManifestReadback,
    }),
  );
  return binding;
}

async function verifyCallerBinding(binding, repositoryContext) {
  const state =
    binding !== null && typeof binding === "object"
      ? TRUSTED_CALLER_BINDINGS.get(binding)
      : undefined;
  if (!state) return { diagnostic: "CALLER_BINDING_REQUIRED" };
  if (Date.now() >= state.expiresAtMs) {
    return { diagnostic: "CALLER_BINDING_EXPIRED" };
  }
  if (!repositoryContextMatches(repositoryContext, state.manifest)) {
    return { diagnostic: "CALLER_REPOSITORY_CONTEXT_MISMATCH" };
  }
  try {
    const observed = normalizeCallerManifest(
      await state.trustedResolvedManifestReadback({
        repositoryId: state.manifest.repositoryId,
        fullName: state.manifest.fullName,
        sourceSha: state.manifest.sourceSha,
      }),
    );
    if (!observed) {
      return { diagnostic: "CALLER_MANIFEST_REVOKED" };
    }
    if (canonicalJson(observed) !== canonicalJson(state.manifest)) {
      return { diagnostic: "CALLER_MANIFEST_CHANGED" };
    }
    if (Date.now() >= state.expiresAtMs) {
      return { diagnostic: "CALLER_BINDING_EXPIRED" };
    }
  } catch {
    return { diagnostic: "CALLER_MANIFEST_READBACK_FAILED" };
  }
  return { state };
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

export async function validateOrgContractCaller(
  text,
  { approvedBundleBinding, callerBinding, repositoryContext } = {},
) {
  const parsed = parseCaller(text);
  if (parsed.diagnostic) {
    return { ok: false, diagnostics: [parsed.diagnostic] };
  }
  const caller = parsed.value;
  const diagnostics = [];
  const bindingVerification = await verifyBundleBinding(approvedBundleBinding);
  const trustedBinding = bindingVerification.state;
  if (!trustedBinding) diagnostics.push(bindingVerification.diagnostic);
  const callerBindingVerification = await verifyCallerBinding(
    callerBinding,
    repositoryContext,
  );
  const trustedCallerBinding = callerBindingVerification.state;
  if (!trustedCallerBinding) {
    diagnostics.push(callerBindingVerification.diagnostic);
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
  const expectedCaller = trustedCallerBinding?.manifest;
  const approvedWorkflow =
    trustedBinding && expectedCaller
      ? trustedBinding.workflowByProfile[expectedCaller.profile]
      : undefined;
  if (
    usesMatch &&
    (!approvedWorkflow ||
      profile !== expectedCaller?.profile ||
      usesMatch[1] !== approvedWorkflow.path ||
      usesMatch[2] !== approvedWorkflow.sha)
  ) {
    diagnostics.push("CALLER_APPROVED_WORKFLOW_MISMATCH");
  }
  if (
    expectedCaller &&
    (withInputs.package_manager !== expectedCaller.packageManager ||
      withInputs.working_directory !== expectedCaller.workingDirectory)
  ) {
    diagnostics.push("CALLER_RESOLVED_INPUT_MISMATCH");
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...new Set(diagnostics)].sort(),
    profile,
    workflowSha: approvedWorkflow?.sha,
  };
}

export async function generateOrgContractCaller(options = {}) {
  const allowedKeys = ["approvedBundleBinding", "callerBinding"];
  if (
    options === null ||
    typeof options !== "object" ||
    Object.keys(options).some((key) => !allowedKeys.includes(key))
  ) {
    throw new Error("CALLER_GENERATION_INPUT_FORBIDDEN");
  }
  const { approvedBundleBinding, callerBinding } = options;
  const bundleVerification = await verifyBundleBinding(approvedBundleBinding);
  if (!bundleVerification.state) {
    throw new Error(bundleVerification.diagnostic);
  }
  const callerState =
    callerBinding !== null && typeof callerBinding === "object"
      ? TRUSTED_CALLER_BINDINGS.get(callerBinding)
      : undefined;
  if (!callerState) {
    throw new Error("CALLER_BINDING_REQUIRED");
  }
  const repositoryContext = {
    repositoryId: callerState.manifest.repositoryId,
    fullName: callerState.manifest.fullName,
    sourceSha: callerState.manifest.sourceSha,
  };
  const callerVerification = await verifyCallerBinding(
    callerBinding,
    repositoryContext,
  );
  if (!callerVerification.state) {
    throw new Error(callerVerification.diagnostic);
  }
  const { profile, packageManager, workingDirectory } =
    callerVerification.state.manifest;
  const approvedWorkflow =
    bundleVerification.state.workflowByProfile[profile];
  if (
    !approvedWorkflow ||
    approvedWorkflow.path !== WORKFLOW_BY_PROFILE[profile] ||
    !SHA_PATTERN.test(approvedWorkflow.sha)
  ) {
    throw new Error("APPROVED_WORKFLOW_MISSING");
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
  const validation = await validateOrgContractCaller(rendered, {
    approvedBundleBinding,
    callerBinding,
    repositoryContext,
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
