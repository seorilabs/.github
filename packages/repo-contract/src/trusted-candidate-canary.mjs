import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { stringify } from "yaml";

import { validateWorkflowBundle } from "./fleet.mjs";
import {
  isTrustedWifAdapter,
  readTrustedWifBinding,
  reconcileTrustedWifBinding,
} from "./trusted-executor.mjs";

const CONTRACT = "seorilabs-candidate-canary-v1";
const ORGANIZATION_LOGIN = "seorilabs";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_REF = "refs/heads/main";
const BINDING_TTL_MS = 5 * 60 * 1000;

const ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SNAPSHOT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{9,127}$/u;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SAFE_RELATIVE_DIRECTORY =
  /^(?:\.|[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*)$/u;

const STATIC_CALLER_PATH = ".github/workflows/org-contract.yml";
const ANDROID_CALLER_PATH = ".github/workflows/android-build-only.yml";
const OPERATION_KIND = "github.candidate-canary-pull-request.ensure";
const WIF_OPERATION_KIND = "gcp.wif-binding.ensure";
const WIF_LOGICAL_CREDENTIAL_ID = "shared/gcp/cloud-build";
const WIF_APPROVAL_PURPOSE = "CANDIDATE_WIF_PREBIND";

const CANARIES = Object.freeze({
  "1250442131": Object.freeze({
    fullName: "seorilabs/happy-farm",
    profile: "react-native",
  }),
  "1265192029": Object.freeze({
    fullName: "seorilabs/lizard-tycoon",
    profile: "godot",
  }),
});

const STATIC_WORKFLOW_BY_PROFILE = Object.freeze({
  "react-native": ".github/workflows/rn-static-checks-v2.yml",
  godot: ".github/workflows/godot-checks-v2.yml",
});
const ANDROID_WORKFLOW_BY_PROFILE = Object.freeze({
  "react-native": ".github/workflows/rn-build-android-cloud-v1.yml",
  godot: ".github/workflows/godot-build-android-cloud-v1.yml",
});

const IDENTITY_PERMISSIONS = Object.freeze({
  contents: "read",
  metadata: "read",
});
const OPERATION_READ_PERMISSIONS = Object.freeze({
  contents: "read",
  metadata: "read",
  pull_requests: "read",
});
const WRITE_PERMISSIONS = Object.freeze({
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  workflows: "write",
});

const CANDIDATE_BINDINGS = new WeakMap();
const CALLER_BINDINGS = new WeakMap();
const PLAN_BINDINGS = new WeakMap();
const GITHUB_ADAPTERS = new WeakMap();
const EXECUTION_STORES = new WeakMap();

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

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function clone(value, diagnostic) {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(diagnostic);
  }
}

function validNow(now) {
  const nowMs = now();
  if (!Number.isFinite(nowMs)) throw new Error("CANDIDATE_CANARY_CLOCK_INVALID");
  return nowMs;
}

function validSafeDirectory(value) {
  return (
    typeof value === "string" &&
    SAFE_RELATIVE_DIRECTORY.test(value) &&
    (value === "." ||
      value.split("/").every((segment) => segment !== "." && segment !== ".."))
  );
}

function validRepositoryContext(value) {
  const canary = CANARIES[value?.repositoryId];
  return (
    exactKeys(value, ["fullName", "repositoryId", "sourceSha"]) &&
    ID_PATTERN.test(value.repositoryId ?? "") &&
    canary !== undefined &&
    value.fullName === canary.fullName &&
    SHA_PATTERN.test(value.sourceSha ?? "")
  );
}

function candidatePolicyValid(bundle) {
  const candidateEntries = Object.entries(bundle?.quality?.canaries ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const expectedEntries = [
    [
      "godot",
      { fullName: CANARIES["1265192029"].fullName, repositoryId: 1265192029 },
    ],
    [
      "react-native",
      { fullName: CANARIES["1250442131"].fullName, repositoryId: 1250442131 },
    ],
  ];
  return (
    bundle?.approval?.state === "CANDIDATE" &&
    bundle?.source?.repository === "seorilabs/.github" &&
    SHA_PATTERN.test(bundle?.source?.sha ?? "") &&
    DIGEST_PATTERN.test(bundle?.integrity?.payloadDigest ?? "") &&
    canonicalJson(candidateEntries) === canonicalJson(expectedEntries) &&
    canonicalJson(bundle?.quality?.requiredCanaryGates) ===
      canonicalJson(["static", "build-only"]) &&
    bundle?.rollout?.mode === "SHADOW" &&
    bundle?.rollout?.ruleset === "EVALUATE" &&
    bundle?.rollout?.legacyConsumersPreserved === true &&
    bundle?.delivery?.android?.marketUpload === false &&
    canonicalJson(Object.keys(bundle?.reusableWorkflows ?? {}).sort()) ===
      canonicalJson(["godot", "react-native"]) &&
    canonicalJson(Object.keys(bundle?.buildWorkflows ?? {}).sort()) ===
      canonicalJson(["godot", "react-native"]) &&
    ["react-native", "godot"].every(
      (profile) =>
        bundle.reusableWorkflows[profile]?.path ===
          STATIC_WORKFLOW_BY_PROFILE[profile] &&
        SHA_PATTERN.test(bundle.reusableWorkflows[profile]?.sha ?? "") &&
        bundle.buildWorkflows[profile]?.path ===
          ANDROID_WORKFLOW_BY_PROFILE[profile] &&
        bundle.buildWorkflows[profile]?.sha ===
          bundle.reusableWorkflows[profile]?.sha &&
        bundle.buildWorkflows[profile]?.mode === "build-only" &&
        bundle.buildWorkflows[profile]?.platform === "android",
    )
  );
}

async function readCandidateSource(state) {
  let validation;
  try {
    validation = await validateWorkflowBundle(state.bundle, {
      repoRoot: state.repoRoot,
      trustedWorkflowSourceReadback: state.trustedWorkflowSourceReadback,
    });
  } catch {
    throw new Error("CANDIDATE_CANARY_SOURCE_READBACK_FAILED");
  }
  if (!validation.ok) {
    if (
      validation.diagnostics.some((diagnostic) =>
        [
          "WORKFLOW_EXECUTION_SOURCE_READBACK_FAILED",
          "WORKFLOW_SOURCE_READBACK_FAILED",
        ].includes(diagnostic),
      )
    ) {
      throw new Error("CANDIDATE_CANARY_SOURCE_READBACK_FAILED");
    }
    throw new Error("CANDIDATE_CANARY_SOURCE_MISMATCH");
  }
}

async function verifyCandidateBinding(binding) {
  const state =
    binding !== null && typeof binding === "object"
      ? CANDIDATE_BINDINGS.get(binding)
      : undefined;
  if (!state) throw new Error("CANDIDATE_CANARY_BUNDLE_BINDING_REQUIRED");
  if (validNow(state.now) >= state.expiresAtMs) {
    throw new Error("CANDIDATE_CANARY_BUNDLE_BINDING_EXPIRED");
  }
  await readCandidateSource(state);
  if (validNow(state.now) >= state.expiresAtMs) {
    throw new Error("CANDIDATE_CANARY_BUNDLE_BINDING_EXPIRED");
  }
  return state;
}

export async function loadTrustedCandidateBundle(
  bundle,
  {
    repoRoot,
    trustedWorkflowSourceReadback,
    now = Date.now,
  } = {},
) {
  if (
    typeof trustedWorkflowSourceReadback !== "function" ||
    typeof now !== "function"
  ) {
    throw new Error("CANDIDATE_CANARY_BUNDLE_TRUST_REQUIRED");
  }
  const snapshot = clone(bundle, "CANDIDATE_CANARY_BUNDLE_INVALID");
  const validation = await validateWorkflowBundle(snapshot, { repoRoot });
  if (!validation.ok || !candidatePolicyValid(snapshot)) {
    throw new Error("CANDIDATE_CANARY_BUNDLE_INVALID");
  }
  deepFreeze(snapshot);
  const nowMs = validNow(now);
  const state = {
    bundle: snapshot,
    expiresAtMs: nowMs + BINDING_TTL_MS,
    now,
    repoRoot,
    trustedWorkflowSourceReadback,
  };
  await readCandidateSource(state);
  const binding = Object.freeze({
    bundleDigest: snapshot.integrity.payloadDigest,
    contract: CONTRACT,
    expiresAt: new Date(state.expiresAtMs).toISOString(),
    sourceSha: snapshot.source.sha,
    state: "CANDIDATE",
  });
  CANDIDATE_BINDINGS.set(binding, state);
  return binding;
}

function normalizeManifest(value) {
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
  const canary = CANARIES[manifest?.repositoryId];
  if (
    !exactKeys(manifest, expectedKeys) ||
    manifest.state !== "ACTIVE" ||
    canary === undefined ||
    manifest.fullName !== canary.fullName ||
    manifest.profile !== canary.profile ||
    !SHA_PATTERN.test(manifest.sourceSha ?? "") ||
    manifest.sourceRef !== DEFAULT_REF ||
    !CONFIG_ID_PATTERN.test(manifest.observationId ?? "") ||
    !DIGEST_PATTERN.test(manifest.sourcePayloadDigest ?? "") ||
    !["npm", "pnpm"].includes(manifest.packageManager) ||
    !validSafeDirectory(manifest.workingDirectory) ||
    !CONFIG_ID_PATTERN.test(manifest.configId ?? "") ||
    !Number.isSafeInteger(manifest.configRevision) ||
    manifest.configRevision < 1 ||
    !SNAPSHOT_DIGEST_PATTERN.test(manifest.snapshotDigest ?? "") ||
    !DIGEST_PATTERN.test(manifest.configSignatureDigest ?? "")
  ) {
    return undefined;
  }
  return deepFreeze(manifest);
}

async function readCallerManifest(state) {
  let manifest;
  try {
    manifest = normalizeManifest(
      await state.trustedResolvedManifestReadback({
        repositoryId: state.manifest.repositoryId,
        fullName: state.manifest.fullName,
        sourceSha: state.manifest.sourceSha,
      }),
    );
  } catch {
    throw new Error("CANDIDATE_CANARY_CALLER_READBACK_FAILED");
  }
  if (!manifest || canonicalJson(manifest) !== canonicalJson(state.manifest)) {
    throw new Error("CANDIDATE_CANARY_CALLER_MISMATCH");
  }
}

async function verifyCallerBinding(binding) {
  const state =
    binding !== null && typeof binding === "object"
      ? CALLER_BINDINGS.get(binding)
      : undefined;
  if (!state) throw new Error("CANDIDATE_CANARY_CALLER_BINDING_REQUIRED");
  if (validNow(state.now) >= state.expiresAtMs) {
    throw new Error("CANDIDATE_CANARY_CALLER_BINDING_EXPIRED");
  }
  await readCallerManifest(state);
  if (validNow(state.now) >= state.expiresAtMs) {
    throw new Error("CANDIDATE_CANARY_CALLER_BINDING_EXPIRED");
  }
  return state;
}

export async function loadTrustedCandidateCanaryCaller(
  repositoryContext,
  { trustedResolvedManifestReadback, now = Date.now } = {},
) {
  const context = clone(
    repositoryContext,
    "CANDIDATE_CANARY_REPOSITORY_INVALID",
  );
  if (
    !validRepositoryContext(context) ||
    typeof trustedResolvedManifestReadback !== "function" ||
    typeof now !== "function"
  ) {
    throw new Error("CANDIDATE_CANARY_REPOSITORY_NOT_ALLOWED");
  }
  let manifest;
  try {
    manifest = normalizeManifest(
      await trustedResolvedManifestReadback(structuredClone(context)),
    );
  } catch {
    throw new Error("CANDIDATE_CANARY_CALLER_READBACK_FAILED");
  }
  if (
    !manifest ||
    manifest.repositoryId !== context.repositoryId ||
    manifest.fullName !== context.fullName ||
    manifest.sourceSha !== context.sourceSha
  ) {
    throw new Error("CANDIDATE_CANARY_CALLER_MISMATCH");
  }
  const nowMs = validNow(now);
  const state = {
    expiresAtMs: nowMs + BINDING_TTL_MS,
    manifest,
    now,
    trustedResolvedManifestReadback,
  };
  const binding = Object.freeze({
    contract: CONTRACT,
    expiresAt: new Date(state.expiresAtMs).toISOString(),
    fullName: manifest.fullName,
    repositoryId: manifest.repositoryId,
    sourceSha: manifest.sourceSha,
  });
  CALLER_BINDINGS.set(binding, state);
  return binding;
}

function renderStaticCaller(bundle, manifest) {
  const permissions =
    manifest.profile === "react-native"
      ? { contents: "read", packages: "read" }
      : { contents: "read" };
  const caller = {
    name: "Org Contract",
    on: {
      pull_request: {},
      push: { branches: ["main"] },
      workflow_dispatch: {},
    },
    permissions,
    concurrency: {
      group: "org-contract-${{ github.repository_id }}-${{ github.ref }}",
      "cancel-in-progress": true,
    },
    jobs: {
      "org-contract": {
        name: "Org Contract",
        uses:
          `seorilabs/.github/${STATIC_WORKFLOW_BY_PROFILE[manifest.profile]}` +
          `@${bundle.reusableWorkflows[manifest.profile].sha}`,
        with: {
          package_manager: manifest.packageManager,
          working_directory: manifest.workingDirectory,
        },
      },
    },
  };
  return [
    "# WorkflowBundle candidate canary generator가 관리합니다. 수동 편집하지 마십시오.",
    stringify(caller, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
}

function renderAndroidCaller(bundle, manifest) {
  const permissions =
    manifest.profile === "react-native"
      ? { contents: "read", "id-token": "write", packages: "read" }
      : { contents: "read", "id-token": "write" };
  const caller = {
    name: "Android Build-only",
    on: {
      pull_request: { paths: [ANDROID_CALLER_PATH] },
      workflow_dispatch: {},
    },
    permissions,
    concurrency: {
      group:
        `android-build-\${{ github.repository_id }}-${manifest.sourceSha}`,
      "cancel-in-progress": false,
    },
    jobs: {
      "android-build": {
        name: "Android Build-only",
        uses:
          `seorilabs/.github/${ANDROID_WORKFLOW_BY_PROFILE[manifest.profile]}` +
          `@${bundle.buildWorkflows[manifest.profile].sha}`,
        with: {
          source_sha: manifest.sourceSha,
          working_directory: manifest.workingDirectory,
        },
      },
    },
  };
  return [
    "# WorkflowBundle candidate canary generator가 관리합니다. 수동 편집하지 마십시오.",
    stringify(caller, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
}

function expectedOperation(bundle, manifest) {
  const staticCaller = renderStaticCaller(bundle, manifest);
  const androidCaller = renderAndroidCaller(bundle, manifest);
  const payload = {
    baseRef: "main",
    candidateBundleDigest: bundle.integrity.payloadDigest,
    candidateSourceSha: bundle.source.sha,
    files: [
      {
        content: staticCaller,
        contentDigest: sha256(staticCaller),
        path: STATIC_CALLER_PATH,
      },
      {
        content: androidCaller,
        contentDigest: sha256(androidCaller),
        path: ANDROID_CALLER_PATH,
      },
    ],
    fullName: manifest.fullName,
    headRef:
      `seori/workflow-bundle-canary/${manifest.repositoryId}/` +
      bundle.buildWorkflows[manifest.profile].sha.slice(0, 12),
    maximumOpenAutonomousPullRequests: 1,
    repositoryId: manifest.repositoryId,
    sourceSha: manifest.sourceSha,
    title: "WorkflowBundle 후보 canary를 검증한다",
  };
  const operation = {
    kind: OPERATION_KIND,
    payload,
  };
  return deepFreeze({
    ...operation,
    idempotencyKey: sha256(
      canonicalJson({
        kind: operation.kind,
        payload: operation.payload,
        repositoryId: manifest.repositoryId,
      }),
    ),
  });
}

function callerDocumentsMatch(callerDocuments, operation) {
  if (callerDocuments === undefined) return true;
  let documents;
  try {
    documents = structuredClone(callerDocuments);
  } catch {
    return false;
  }
  return (
    exactKeys(documents, [STATIC_CALLER_PATH, ANDROID_CALLER_PATH]) &&
    operation.payload.files.every(
      ({ content, path }) => documents[path] === content,
    )
  );
}

function expectedWifOperation(bundle, manifest, wifBinding) {
  const payload = {
    bindingRevision: wifBinding.bindingRevision,
    candidateBundleDigest: bundle.integrity.payloadDigest,
    environment: "internal",
    jobWorkflowRef:
      `seorilabs/.github/${ANDROID_WORKFLOW_BY_PROFILE[manifest.profile]}` +
      `@${bundle.buildWorkflows[manifest.profile].sha}`,
    logicalCredentialId: WIF_LOGICAL_CREDENTIAL_ID,
    organizationId: wifBinding.organizationId,
    repositoryId: manifest.repositoryId,
  };
  return deepFreeze({
    idempotencyKey: sha256(
      canonicalJson({
        kind: WIF_OPERATION_KIND,
        payload,
        repositoryId: manifest.repositoryId,
      }),
    ),
    kind: WIF_OPERATION_KIND,
    payload,
  });
}

function validWifBinding(value) {
  return (
    exactKeys(value, [
      "approvalReceiptId",
      "bindingRevision",
      "logicalCredentialId",
      "organizationId",
    ]) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(
      value.approvalReceiptId ?? "",
    ) &&
    Number.isSafeInteger(value.bindingRevision) &&
    value.bindingRevision > 0 &&
    value.logicalCredentialId === WIF_LOGICAL_CREDENTIAL_ID &&
    ID_PATTERN.test(value.organizationId ?? "")
  );
}

function planPayload(operation, wifOperation, manifest, bundle) {
  return {
    candidate: {
      bundleDigest: bundle.integrity.payloadDigest,
      sourceSha: bundle.source.sha,
    },
    contract: CONTRACT,
    operation,
    repository: {
      fullName: manifest.fullName,
      id: manifest.repositoryId,
      sourceSha: manifest.sourceSha,
    },
    schemaVersion: 1,
    wifOperation,
  };
}

export async function createTrustedCandidateCanaryPlan({
  candidateBundleBinding,
  callerBinding,
  callerDocuments,
  wifBinding,
} = {}) {
  const candidateState = await verifyCandidateBinding(candidateBundleBinding);
  const callerState = await verifyCallerBinding(callerBinding);
  const { bundle } = candidateState;
  const { manifest } = callerState;
  const wifBindingSnapshot = clone(
    wifBinding,
    "CANDIDATE_CANARY_WIF_BINDING_INVALID",
  );
  if (!validWifBinding(wifBindingSnapshot)) {
    throw new Error("CANDIDATE_CANARY_WIF_BINDING_INVALID");
  }
  const declaredCanary = bundle.quality.canaries[manifest.profile];
  if (
    String(declaredCanary?.repositoryId) !== manifest.repositoryId ||
    declaredCanary?.fullName !== manifest.fullName
  ) {
    throw new Error("CANDIDATE_CANARY_REPOSITORY_MISMATCH");
  }
  const operation = expectedOperation(bundle, manifest);
  const wifOperation = expectedWifOperation(
    bundle,
    manifest,
    wifBindingSnapshot,
  );
  if (!callerDocumentsMatch(callerDocuments, operation)) {
    throw new Error("CANDIDATE_CANARY_CALLER_UNTRUSTED");
  }
  const payload = planPayload(operation, wifOperation, manifest, bundle);
  const planDigest = sha256(canonicalJson(payload));
  const expiresAtMs = Math.min(
    candidateState.expiresAtMs,
    callerState.expiresAtMs,
  );
  const binding = deepFreeze({
    candidateBundleDigest: bundle.integrity.payloadDigest,
    candidateSourceSha: bundle.source.sha,
    contract: CONTRACT,
    expiresAt: new Date(expiresAtMs).toISOString(),
    fullName: manifest.fullName,
    planDigest,
    repositoryId: manifest.repositoryId,
    sourceSha: manifest.sourceSha,
  });
  PLAN_BINDINGS.set(binding, {
    candidateBundleBinding,
    callerBinding,
    expiresAtMs,
    operation,
    payload,
    wifBinding: deepFreeze(wifBindingSnapshot),
    wifOperation,
  });
  return binding;
}

function validTokenLease(
  lease,
  { installationId, organizationId, permissions, repositoryId, now },
) {
  const nowMs = validNow(now);
  const expiresAtMs = Date.parse(lease?.expiresAt ?? "");
  return (
    exactKeys(lease, [
      "accountId",
      "accountLogin",
      "expiresAt",
      "installationId",
      "permissions",
      "repositoryIds",
      "token",
    ]) &&
    Buffer.isBuffer(lease.token) &&
    lease.token.length >= 32 &&
    lease.accountId === organizationId &&
    lease.accountLogin === ORGANIZATION_LOGIN &&
    lease.installationId === installationId &&
    canonicalJson(lease.permissions) === canonicalJson(permissions) &&
    canonicalJson(lease.repositoryIds) === canonicalJson([repositoryId]) &&
    ISO_DATE_PATTERN.test(lease.expiresAt ?? "") &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > nowMs &&
    expiresAtMs <= nowMs + 60 * 60 * 1000
  );
}

export function createTrustedCandidateCanaryGitHubAdapter({
  organizationId,
  installationId,
  issueInstallationToken,
  provider,
  now = Date.now,
} = {}) {
  if (
    !ID_PATTERN.test(organizationId ?? "") ||
    !ID_PATTERN.test(installationId ?? "") ||
    typeof issueInstallationToken !== "function" ||
    !exactKeys(provider, ["applyOperation", "readIdentity", "readOperation"]) ||
    Object.values(provider).some((callback) => typeof callback !== "function") ||
    typeof now !== "function"
  ) {
    throw new Error("CANDIDATE_CANARY_GITHUB_ADAPTER_INVALID");
  }

  async function withCredential(context, permissions, purpose, action) {
    let lease;
    try {
      lease = await issueInstallationToken({
        installationId,
        organizationId,
        permissions: structuredClone(permissions),
        purpose,
        repositoryIds: [context.repositoryId],
      });
      if (
        !validTokenLease(lease, {
          installationId,
          now,
          organizationId,
          permissions,
          repositoryId: context.repositoryId,
        })
      ) {
        throw new Error("invalid lease");
      }
      return clone(
        await action(lease.token),
        "CANDIDATE_CANARY_GITHUB_RESPONSE_INVALID",
      );
    } catch {
      throw new Error("CANDIDATE_CANARY_GITHUB_REQUEST_FAILED");
    } finally {
      if (Buffer.isBuffer(lease?.token)) lease.token.fill(0);
    }
  }

  const adapter = Object.freeze({
    contract: CONTRACT,
    installationId,
    organizationId,
  });
  GITHUB_ADAPTERS.set(adapter, {
    async applyOperation(operation, context) {
      return withCredential(
        context,
        WRITE_PERMISSIONS,
        "candidate-canary-pull-request-write",
        (credential) =>
          provider.applyOperation({
            apiOrigin: GITHUB_API_ORIGIN,
            apiVersion: GITHUB_API_VERSION,
            context: structuredClone(context),
            credential,
            operation: structuredClone(operation),
          }),
      );
    },
    async readIdentity(context) {
      return withCredential(
        context,
        IDENTITY_PERMISSIONS,
        "candidate-canary-identity-read",
        (credential) =>
          provider.readIdentity({
            apiOrigin: GITHUB_API_ORIGIN,
            apiVersion: GITHUB_API_VERSION,
            context: structuredClone(context),
            credential,
          }),
      );
    },
    async readOperation(operation, context) {
      return withCredential(
        context,
        OPERATION_READ_PERMISSIONS,
        "candidate-canary-pull-request-read",
        (credential) =>
          provider.readOperation({
            apiOrigin: GITHUB_API_ORIGIN,
            apiVersion: GITHUB_API_VERSION,
            context: structuredClone(context),
            credential,
            operation: structuredClone(operation),
          }),
      );
    },
  });
  return adapter;
}

export function createTrustedCandidateCanaryExecutionStore({
  claimOperation,
  completeOperation,
  consumeWifApproval,
  readExecutablePlan,
  readWifApproval,
} = {}) {
  if (
    [
      claimOperation,
      completeOperation,
      consumeWifApproval,
      readExecutablePlan,
      readWifApproval,
    ].some((callback) => typeof callback !== "function")
  ) {
    throw new Error("CANDIDATE_CANARY_EXECUTION_STORE_INVALID");
  }
  const store = Object.freeze({ contract: CONTRACT });
  EXECUTION_STORES.set(store, {
    claimOperation,
    completeOperation,
    consumeWifApproval,
    readExecutablePlan,
    readWifApproval,
  });
  return store;
}

function executionBinding(planState) {
  const { operation, payload, wifBinding, wifOperation } = planState;
  return {
    candidateBundleDigest: payload.candidate.bundleDigest,
    candidateSourceSha: payload.candidate.sourceSha,
    contract: CONTRACT,
    fullName: payload.repository.fullName,
    idempotencyKey: operation.idempotencyKey,
    operationKind: operation.kind,
    planDigest: sha256(canonicalJson(payload)),
    repositoryId: payload.repository.id,
    sourceSha: payload.repository.sourceSha,
    wifApprovalReceiptId: wifBinding.approvalReceiptId,
    wifBindingRevision: wifOperation.payload.bindingRevision,
    wifIdempotencyKey: wifOperation.idempotencyKey,
    wifJobWorkflowRef: wifOperation.payload.jobWorkflowRef,
    wifLogicalCredentialId: wifOperation.payload.logicalCredentialId,
  };
}

function validExecutablePlan(value, expected, now) {
  const expiresAtMs = Date.parse(value?.expiresAt ?? "");
  const nowMs = validNow(now);
  return (
    exactKeys(value, [
      ...Object.keys(expected),
      "expiresAt",
      "generation",
      "state",
    ]) &&
    value.state === "EXECUTABLE" &&
    Object.entries(expected).every(([key, expectedValue]) =>
      canonicalJson(value[key]) === canonicalJson(expectedValue)
    ) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    ISO_DATE_PATTERN.test(value.expiresAt ?? "") &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > nowMs &&
    expiresAtMs <= nowMs + BINDING_TTL_MS
  );
}

function wifApprovalExpected(planState, repository, planDigest) {
  const { wifBinding, wifOperation } = planState;
  return {
    approvalReceiptId: wifBinding.approvalReceiptId,
    candidateBundleDigest: wifOperation.payload.candidateBundleDigest,
    candidateSourceSha: planState.payload.candidate.sourceSha,
    jobWorkflowRef: wifOperation.payload.jobWorkflowRef,
    organizationId: wifOperation.payload.organizationId,
    planDigest,
    purpose: WIF_APPROVAL_PURPOSE,
    repositoryId: repository.id,
    sourceSha: repository.sourceSha,
  };
}

function validWifApproval(value, expected, now) {
  const expiresAtMs = Date.parse(value?.expiresAt ?? "");
  const nowMs = validNow(now);
  return (
    exactKeys(value, [
      ...Object.keys(expected),
      "consumedUses",
      "expiresAt",
      "generation",
      "maxUses",
      "state",
    ]) &&
    ["AUTHORIZED", "CONSUMED"].includes(value.state) &&
    Object.entries(expected).every(
      ([key, expectedValue]) => value[key] === expectedValue,
    ) &&
    value.maxUses === 1 &&
    value.consumedUses === (value.state === "AUTHORIZED" ? 0 : 1) &&
    ISO_DATE_PATTERN.test(value.expiresAt ?? "") &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > nowMs &&
    expiresAtMs <= nowMs + BINDING_TTL_MS &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

function validConsumedWifApproval(value, authorized, expected, now) {
  return (
    validWifApproval(value, expected, now) &&
    value.state === "CONSUMED" &&
    value.generation === authorized.generation + 1 &&
    value.expiresAt === authorized.expiresAt
  );
}

function validIdentity(
  value,
  { installationId, organizationId, repository },
) {
  return (
    exactKeys(value, [
      "archived",
      "defaultBranch",
      "fullName",
      "installationId",
      "organizationId",
      "private",
      "repositoryId",
      "sourceSha",
    ]) &&
    value.organizationId === organizationId &&
    value.installationId === installationId &&
    value.repositoryId === repository.id &&
    value.fullName === repository.fullName &&
    value.sourceSha === repository.sourceSha &&
    value.private === true &&
    value.archived === false &&
    value.defaultBranch === "main"
  );
}

function notAppliedObservation(value, operation, repository) {
  return (
    exactKeys(value, ["idempotencyKey", "kind", "repositoryId", "state"]) &&
    value.state === "NOT_APPLIED" &&
    value.kind === operation.kind &&
    value.idempotencyKey === operation.idempotencyKey &&
    value.repositoryId === repository.id
  );
}

function appliedObservation(value, operation, repository) {
  const payload = operation.payload;
  const expectedFiles = payload.files.map(({ contentDigest, path }) => ({
    contentDigest,
    path,
  }));
  return (
    exactKeys(value, [
      "baseRef",
      "candidateBundleDigest",
      "candidateSourceSha",
      "files",
      "headRef",
      "idempotencyKey",
      "kind",
      "number",
      "repositoryId",
      "sourceSha",
      "state",
    ]) &&
    value.state === "OPEN" &&
    value.kind === operation.kind &&
    value.idempotencyKey === operation.idempotencyKey &&
    value.repositoryId === repository.id &&
    value.sourceSha === repository.sourceSha &&
    value.candidateSourceSha === payload.candidateSourceSha &&
    value.candidateBundleDigest === payload.candidateBundleDigest &&
    value.headRef === payload.headRef &&
    value.baseRef === payload.baseRef &&
    Number.isSafeInteger(value.number) &&
    value.number > 0 &&
    canonicalJson(value.files) === canonicalJson(expectedFiles)
  );
}

function validApplyReceipt(value, operation, repository) {
  return (
    exactKeys(value, [
      "headRef",
      "idempotencyKey",
      "kind",
      "number",
      "repositoryId",
      "state",
    ]) &&
    ["UPDATED", "UNCHANGED"].includes(value.state) &&
    value.kind === operation.kind &&
    value.idempotencyKey === operation.idempotencyKey &&
    value.repositoryId === repository.id &&
    value.headRef === operation.payload.headRef &&
    Number.isSafeInteger(value.number) &&
    value.number > 0
  );
}

function validClaim(value, expected, planGeneration, now) {
  const common = {
    ...expected,
    planGeneration,
  };
  if (value?.state === "COMPLETED") {
    return (
      exactKeys(value, [
        ...Object.keys(common),
        "generation",
        "receiptDigest",
        "state",
      ]) &&
      Object.entries(common).every(
        ([key, expectedValue]) => value[key] === expectedValue,
      ) &&
      Number.isSafeInteger(value.generation) &&
      value.generation > 0 &&
      DIGEST_PATTERN.test(value.receiptDigest ?? "")
    );
  }
  const expiresAtMs = Date.parse(value?.expiresAt ?? "");
  const nowMs = validNow(now);
  return (
    ["CLAIMED", "RESUME"].includes(value?.state) &&
    exactKeys(value, [
      ...Object.keys(common),
      "expiresAt",
      "generation",
      "leaseToken",
      "state",
    ]) &&
    Object.entries(common).every(
      ([key, expectedValue]) => value[key] === expectedValue,
    ) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    Buffer.isBuffer(value.leaseToken) &&
    value.leaseToken.length >= 32 &&
    ISO_DATE_PATTERN.test(value.expiresAt ?? "") &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > nowMs &&
    expiresAtMs <= nowMs + BINDING_TTL_MS
  );
}

function validWifReceipt(value, operation, repository) {
  return (
    exactKeys(value, [
      "bindingRevision",
      "jobWorkflowRef",
      "logicalCredentialId",
      "observationDigest",
      "repositoryId",
      "state",
      "workflowBundleDigest",
    ]) &&
    value.bindingRevision === operation.payload.bindingRevision &&
    value.jobWorkflowRef === operation.payload.jobWorkflowRef &&
    value.logicalCredentialId === operation.payload.logicalCredentialId &&
    DIGEST_PATTERN.test(value.observationDigest ?? "") &&
    value.repositoryId === repository.id &&
    value.state === "BOUND" &&
    value.workflowBundleDigest === operation.payload.candidateBundleDigest
  );
}

function operationReceipt(
  operation,
  repository,
  observation,
  wifOperation,
  wifReceipt,
) {
  return deepFreeze({
    candidateBundleDigest: operation.payload.candidateBundleDigest,
    candidateSourceSha: operation.payload.candidateSourceSha,
    idempotencyKey: operation.idempotencyKey,
    kind: operation.kind,
    observationDigest: sha256(canonicalJson(observation)),
    repositoryId: repository.id,
    sourceSha: repository.sourceSha,
    state: "APPLIED",
    wif: {
      bindingDigest: sha256(
        canonicalJson({
          bindingRevision: wifOperation.payload.bindingRevision,
          candidateBundleDigest: wifOperation.payload.candidateBundleDigest,
          idempotencyKey: wifOperation.idempotencyKey,
          jobWorkflowRef: wifReceipt.jobWorkflowRef,
          logicalCredentialId: wifOperation.payload.logicalCredentialId,
          repositoryId: repository.id,
        }),
      ),
      idempotencyKey: wifOperation.idempotencyKey,
      jobWorkflowRef: wifReceipt.jobWorkflowRef,
      state: wifReceipt.state,
    },
  });
}

function publicResult(
  planDigest,
  repository,
  operation,
  receipt,
  wifReceipt,
  outcome,
) {
  return deepFreeze({
    candidateBundleDigest: receipt.candidateBundleDigest,
    candidateSourceSha: receipt.candidateSourceSha,
    operation: {
      idempotencyKey: operation.idempotencyKey,
      kind: operation.kind,
      observationDigest: receipt.observationDigest,
      outcome,
      receiptDigest: sha256(canonicalJson(receipt)),
    },
    planDigest,
    repository: structuredClone(repository),
    schemaVersion: 1,
    state: "COMPLETED",
    wif: {
      ...structuredClone(receipt.wif),
      observationDigest: wifReceipt.observationDigest,
    },
  });
}

export function createTrustedCandidateCanaryExecutor({
  organizationId,
  installationId,
  githubAppAdapter,
  wifAdapter,
  executionStore,
  now = Date.now,
} = {}) {
  const github = GITHUB_ADAPTERS.get(githubAppAdapter);
  const store = EXECUTION_STORES.get(executionStore);
  if (
    !ID_PATTERN.test(organizationId ?? "") ||
    !ID_PATTERN.test(installationId ?? "") ||
    githubAppAdapter?.organizationId !== organizationId ||
    githubAppAdapter?.installationId !== installationId ||
    !github ||
    !isTrustedWifAdapter(wifAdapter) ||
    !store ||
    typeof now !== "function"
  ) {
    throw new Error("CANDIDATE_CANARY_EXECUTOR_CONFIGURATION_INVALID");
  }

  async function readIdentity(repository) {
    let identity;
    try {
      identity = await github.readIdentity({
        fullName: repository.fullName,
        repositoryId: repository.id,
        sourceSha: repository.sourceSha,
      });
    } catch {
      throw new Error("CANDIDATE_CANARY_IDENTITY_READBACK_FAILED");
    }
    if (
      !validIdentity(identity, {
        installationId,
        organizationId,
        repository,
      })
    ) {
      throw new Error("CANDIDATE_CANARY_IDENTITY_MISMATCH");
    }
  }

  async function readOperation(operation, repository) {
    let observation;
    try {
      observation = await github.readOperation(operation, {
        fullName: repository.fullName,
        repositoryId: repository.id,
        sourceSha: repository.sourceSha,
      });
    } catch {
      throw new Error("CANDIDATE_CANARY_OPERATION_READBACK_FAILED");
    }
    if (notAppliedObservation(observation, operation, repository)) {
      return { state: "NOT_APPLIED" };
    }
    if (!appliedObservation(observation, operation, repository)) {
      throw new Error("CANDIDATE_CANARY_OPERATION_READBACK_MISMATCH");
    }
    return { observation, state: "APPLIED" };
  }

  async function requireWifApproval(planState, repository, planDigest) {
    const expected = wifApprovalExpected(planState, repository, planDigest);
    let approval;
    try {
      approval = clone(
        await store.readWifApproval(structuredClone(expected)),
        "CANDIDATE_CANARY_WIF_APPROVAL_INVALID",
      );
    } catch {
      throw new Error("CANDIDATE_CANARY_WIF_APPROVAL_READBACK_FAILED");
    }
    if (!validWifApproval(approval, expected, now)) {
      throw new Error("CANDIDATE_CANARY_WIF_APPROVAL_MISMATCH");
    }
    if (approval.state === "CONSUMED") return;
    let consumed;
    try {
      consumed = clone(
        await store.consumeWifApproval({
          ...structuredClone(expected),
          expectedGeneration: approval.generation,
        }),
        "CANDIDATE_CANARY_WIF_APPROVAL_INVALID",
      );
    } catch {
      throw new Error("CANDIDATE_CANARY_WIF_APPROVAL_CONSUMPTION_FAILED");
    }
    if (!validConsumedWifApproval(consumed, approval, expected, now)) {
      throw new Error("CANDIDATE_CANARY_WIF_APPROVAL_CONSUMPTION_INVALID");
    }
  }

  async function reconcileWif(planState, repository) {
    let receipt;
    try {
      receipt = await reconcileTrustedWifBinding({
        operation: planState.wifOperation,
        repository,
        wifAdapter,
      });
    } catch {
      throw new Error("CANDIDATE_CANARY_WIF_RECONCILIATION_FAILED");
    }
    if (!validWifReceipt(receipt, planState.wifOperation, repository)) {
      throw new Error("CANDIDATE_CANARY_WIF_RECONCILIATION_MISMATCH");
    }
    return receipt;
  }

  async function readWif(planState, repository) {
    let receipt;
    try {
      receipt = await readTrustedWifBinding({
        operation: planState.wifOperation,
        repository,
        wifAdapter,
      });
    } catch {
      throw new Error("CANDIDATE_CANARY_WIF_READBACK_FAILED");
    }
    if (!validWifReceipt(receipt, planState.wifOperation, repository)) {
      throw new Error("CANDIDATE_CANARY_WIF_READBACK_MISMATCH");
    }
    return receipt;
  }

  return async function executeCandidateCanaryPlan(planBinding) {
    const planState =
      planBinding !== null && typeof planBinding === "object"
        ? PLAN_BINDINGS.get(planBinding)
        : undefined;
    if (!planState) throw new Error("CANDIDATE_CANARY_PLAN_BINDING_REQUIRED");
    if (validNow(now) >= planState.expiresAtMs) {
      throw new Error("CANDIDATE_CANARY_PLAN_BINDING_EXPIRED");
    }
    const candidateState = await verifyCandidateBinding(
      planState.candidateBundleBinding,
    );
    const callerState = await verifyCallerBinding(planState.callerBinding);
    const expected = expectedOperation(
      candidateState.bundle,
      callerState.manifest,
    );
    const expectedWif = expectedWifOperation(
      candidateState.bundle,
      callerState.manifest,
      planState.wifBinding,
    );
    if (
      canonicalJson(expected) !== canonicalJson(planState.operation) ||
      canonicalJson(expectedWif) !== canonicalJson(planState.wifOperation) ||
      expectedWif.payload.organizationId !== organizationId ||
      canonicalJson(planState.payload) !==
        canonicalJson(
          planPayload(
            expected,
            expectedWif,
            callerState.manifest,
            candidateState.bundle,
          ),
        )
    ) {
      throw new Error("CANDIDATE_CANARY_PLAN_MISMATCH");
    }
    const planDigest = sha256(canonicalJson(planState.payload));
    if (planBinding.planDigest !== planDigest) {
      throw new Error("CANDIDATE_CANARY_PLAN_MISMATCH");
    }

    const operation = planState.operation;
    const repository = planState.payload.repository;
    const binding = executionBinding(planState);
    let executable;
    try {
      executable = clone(
        await store.readExecutablePlan(structuredClone(binding)),
        "CANDIDATE_CANARY_EXECUTABLE_PLAN_INVALID",
      );
    } catch {
      throw new Error("CANDIDATE_CANARY_EXECUTABLE_PLAN_READBACK_FAILED");
    }
    if (!validExecutablePlan(executable, binding, now)) {
      throw new Error("CANDIDATE_CANARY_EXECUTABLE_PLAN_MISMATCH");
    }

    await readIdentity(repository);
    const claimRequest = { ...binding, planGeneration: executable.generation };
    let claim;
    try {
      claim = await store.claimOperation(structuredClone(claimRequest));
    } catch {
      throw new Error("CANDIDATE_CANARY_OPERATION_CLAIM_FAILED");
    }
    if (!validClaim(claim, binding, executable.generation, now)) {
      if (Buffer.isBuffer(claim?.leaseToken)) claim.leaseToken.fill(0);
      throw new Error("CANDIDATE_CANARY_OPERATION_CLAIM_INVALID");
    }

    const leaseToken =
      claim.state === "COMPLETED" ? undefined : claim.leaseToken;
    try {
      await requireWifApproval(planState, repository, planDigest);

      if (claim.state === "COMPLETED") {
        const wifReceipt = await readWif(planState, repository);
        const readback = await readOperation(operation, repository);
        if (readback.state !== "APPLIED") {
          throw new Error("CANDIDATE_CANARY_COMPLETED_OPERATION_MISSING");
        }
        const receipt = operationReceipt(
          operation,
          repository,
          readback.observation,
          planState.wifOperation,
          wifReceipt,
        );
        if (claim.receiptDigest !== sha256(canonicalJson(receipt))) {
          throw new Error("CANDIDATE_CANARY_COMPLETED_RECEIPT_MISMATCH");
        }
        return publicResult(
          planDigest,
          repository,
          operation,
          receipt,
          wifReceipt,
          "REPLAYED",
        );
      }

      const wifReceipt = await reconcileWif(planState, repository);
      let readback = await readOperation(operation, repository);
      let outcome = "RECOVERED";
      if (readback.state === "NOT_APPLIED") {
        let applyReceipt;
        try {
          applyReceipt = await github.applyOperation(operation, {
            fullName: repository.fullName,
            repositoryId: repository.id,
            sourceSha: repository.sourceSha,
          });
        } catch {
          throw new Error("CANDIDATE_CANARY_OPERATION_APPLY_FAILED");
        }
        if (!validApplyReceipt(applyReceipt, operation, repository)) {
          throw new Error("CANDIDATE_CANARY_OPERATION_APPLY_RECEIPT_INVALID");
        }
        readback = await readOperation(operation, repository);
        if (readback.state !== "APPLIED") {
          throw new Error("CANDIDATE_CANARY_OPERATION_READBACK_FAILED");
        }
        outcome = "APPLIED";
      }
      await readIdentity(repository);
      const receipt = operationReceipt(
        operation,
        repository,
        readback.observation,
        planState.wifOperation,
        wifReceipt,
      );
      const receiptDigest = sha256(canonicalJson(receipt));
      const completionRequest = {
        ...claimRequest,
        generation: claim.generation,
        leaseToken,
        receipt: structuredClone(receipt),
        receiptDigest,
      };
      let completion;
      try {
        completion = await store.completeOperation(completionRequest);
      } catch {
        throw new Error("CANDIDATE_CANARY_OPERATION_COMPLETION_FAILED");
      }
      const expectedCompletion = {
        ...claimRequest,
        generation: claim.generation,
        receiptDigest,
        state: "COMPLETED",
      };
      if (
        !exactKeys(completion, Object.keys(expectedCompletion)) ||
        Object.entries(expectedCompletion).some(
          ([key, expectedValue]) => completion[key] !== expectedValue,
        )
      ) {
        throw new Error("CANDIDATE_CANARY_OPERATION_COMPLETION_INVALID");
      }
      return publicResult(
        planDigest,
        repository,
        operation,
        receipt,
        wifReceipt,
        outcome,
      );
    } finally {
      if (Buffer.isBuffer(leaseToken)) leaseToken.fill(0);
    }
  };
}

export const trustedCandidateCanaryContract = Object.freeze({
  allowedRepositories: Object.freeze(
    Object.fromEntries(
      Object.entries(CANARIES).map(([repositoryId, value]) => [
        repositoryId,
        Object.freeze({ ...value }),
      ]),
    ),
  ),
  contract: CONTRACT,
  githubApiOrigin: GITHUB_API_ORIGIN,
  githubApiVersion: GITHUB_API_VERSION,
  operationKind: OPERATION_KIND,
  wifApprovalPurpose: WIF_APPROVAL_PURPOSE,
  wifLogicalCredentialId: WIF_LOGICAL_CREDENTIAL_ID,
  wifOperationKind: WIF_OPERATION_KIND,
});
