import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;
const FULL_NAME = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*$/u;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const STATIC_CALLER_PATH = ".github/workflows/org-contract.yml";
const STATIC_CALLED_WORKFLOWS = Object.freeze({
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
});
const BUILD_RUNTIME_CONTRACTS = Object.freeze({
  reactNativeAndroid: Object.freeze({
    callerPath: ".github/workflows/android-build-only.yml",
    calledWorkflowPath: ".github/workflows/rn-build-android-cloud-v2.yml",
    profile: "react-native-android",
    packageManager: "pnpm",
    artifactKind: "android-aab",
    scriptPath: "scripts/build-android.sh",
  }),
  godotAndroid: Object.freeze({
    callerPath: ".github/workflows/android-build-only.yml",
    calledWorkflowPath: ".github/workflows/godot-build-android-cloud-v2.yml",
    profile: "godot-android",
    packageManager: null,
    artifactKind: "android-aab",
    scriptPath: "scripts/build-android.sh",
  }),
});
const BUILD_CANARIES = Object.freeze({
  "1250442131": Object.freeze({
    fullName: "seorilabs/happy-farm",
    profile: "react-native-android",
  }),
  "1265192029": Object.freeze({
    fullName: "seorilabs/lizard-tycoon",
    profile: "godot-android",
  }),
});
const MAX_RESPONSE_BYTES = 1024 * 1024;
const STATIC_MANIFEST_RETRY_DELAYS_MS = Object.freeze([250, 750]);

export const staticRuntimeBindingV5Contract = Object.freeze({
  origin: "https://backoffice.vzyx.xyz",
  endpoint: "/api/control-plane/apps/{repositoryId}/resolved-manifest",
  audience: "seorilabs-control-plane",
  authentication: "github-oidc",
  prPolicy: "trusted-github-pr-readback-required",
  callerPath: STATIC_CALLER_PATH,
  calledWorkflows: STATIC_CALLED_WORKFLOWS,
  identity: Object.freeze({
    callerWorkflowRef: "github.workflow_ref",
    calledWorkflowRef: "job.workflow_ref",
    calledWorkflowSha: "job.workflow_sha",
    calledWorkflowRepository: "job.workflow_repository",
  }),
});

export const buildRuntimeBindingV5Contract = Object.freeze({
  origin: staticRuntimeBindingV5Contract.origin,
  endpoint: staticRuntimeBindingV5Contract.endpoint,
  audience: staticRuntimeBindingV5Contract.audience,
  authentication: "github-oidc",
  sourceStrategy: "exact-main-or-fixed-canary-pr-base",
  candidatePolicy: "fixed-repository-and-workflow-sha",
  candidateBranchTemplate:
    "seori/workflow-bundle-v5-canary/{repositoryId}/{workflowSha12}",
  calledWorkflows: BUILD_RUNTIME_CONTRACTS,
  canaries: BUILD_CANARIES,
});

function fail(code) {
  throw new Error(code);
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

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function safeDirectory(value) {
  return (
    value === "." ||
    (typeof value === "string" &&
      value.length > 0 &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => SAFE_SEGMENT.test(segment)))
  );
}

function positiveIntegerString(value) {
  return /^(?:[1-9][0-9]*)$/u.test(String(value ?? ""));
}

function calledWorkflowForPath(path) {
  return Object.values(STATIC_CALLED_WORKFLOWS).find(
    (workflow) => workflow.path === path,
  );
}

function validateContext(context) {
  if (
    !REPOSITORY_ID.test(context?.repositoryId ?? "") ||
    !FULL_NAME.test(context?.fullName ?? "") ||
    !SHA.test(context?.applicationSourceSha ?? "") ||
    !positiveIntegerString(context?.runId) ||
    !positiveIntegerString(context?.runAttempt)
  ) {
    fail("STATIC_RUNTIME_CONTEXT_INVALID");
  }
  if (
    context.jobWorkflowRepository !== "seorilabs/.github" ||
    !SHA.test(context.jobWorkflowSha ?? "")
  ) {
    fail("STATIC_RUNTIME_CALLED_WORKFLOW_IDENTITY_INVALID");
  }
  const calledWorkflow = Object.values(STATIC_CALLED_WORKFLOWS).find(
    ({ path }) =>
      context.jobWorkflowRef ===
        `seorilabs/.github/${path}@${context.jobWorkflowSha}`,
  );
  if (!calledWorkflow) fail("STATIC_RUNTIME_CALLED_WORKFLOW_IDENTITY_INVALID");
  const expectedCallerRef =
    `${context.fullName}/${STATIC_CALLER_PATH}@${context.eventRef}`;
  if (context.callerWorkflowRef !== expectedCallerRef) {
    fail("STATIC_RUNTIME_CALLER_WORKFLOW_IDENTITY_INVALID");
  }
  if (context.eventName === "pull_request") {
    if (
      !/^refs\/pull\/[1-9][0-9]*\/merge$/u.test(context.eventRef ?? "") ||
      !SHA.test(context.pullRequestBaseSha ?? "") ||
      context.pullRequestHeadRepository !== context.fullName
    ) {
      fail("STATIC_RUNTIME_PULL_REQUEST_IDENTITY_INVALID");
    }
    return Object.freeze({
      applicationSourceSha: context.applicationSourceSha,
      bindingSourceSha: context.pullRequestBaseSha,
      calledWorkflowPath: calledWorkflow.path,
    });
  }
  if (
    !["push", "workflow_dispatch"].includes(context.eventName) ||
    context.eventRef !== "refs/heads/main" ||
    (context.pullRequestBaseSha ?? "") !== "" ||
    (context.pullRequestHeadRepository ?? "") !== ""
  ) {
    fail("STATIC_RUNTIME_MAIN_IDENTITY_INVALID");
  }
  return Object.freeze({
    applicationSourceSha: context.applicationSourceSha,
    bindingSourceSha: context.applicationSourceSha,
    calledWorkflowPath: calledWorkflow.path,
  });
}

function validateManifestResponse(response, request) {
  const responseKeys = [
    "schemaVersion",
    "state",
    "repositoryId",
    "fullName",
    "bindingSourceSha",
    "applicationSourceSha",
    "manifestDigest",
    "manifest",
  ];
  if (!exactKeys(response, responseKeys)) fail("STATIC_RUNTIME_READBACK_INVALID");
  const manifest = response.manifest;
  const manifestKeys = [
    "schemaVersion",
    "lifecycleState",
    "repositoryId",
    "fullName",
    "sourceSha",
    "sourceRef",
    "observationId",
    "observationDigest",
    "configRevisionId",
    "configRevision",
    "configRevisionDigest",
    "signedSnapshotDigest",
    "snapshotSignature",
    "staticBinding",
  ];
  const signatureKeys = ["keyId", "policyRevision", "digest"];
  const bindingKeys = ["profile", "packageManager", "workspaceRoot", "commandDirectory"];
  const calledWorkflow = calledWorkflowForPath(request.calledWorkflowPath);
  if (
    response.schemaVersion !== 1 ||
    response.state !== "VERIFIED" ||
    response.repositoryId !== request.repositoryId ||
    response.fullName !== request.fullName ||
    response.bindingSourceSha !== request.bindingSourceSha ||
    response.applicationSourceSha !== request.applicationSourceSha ||
    !exactKeys(manifest, manifestKeys) ||
    manifest.schemaVersion !== 1 ||
    !["ACTIVE", "PAUSED", "DEPRECATED"].includes(manifest.lifecycleState) ||
    manifest.repositoryId !== request.repositoryId ||
    manifest.fullName !== request.fullName ||
    manifest.sourceSha !== request.bindingSourceSha ||
    manifest.sourceRef !== "refs/heads/main" ||
    !PUBLIC_ID.test(manifest.observationId ?? "") ||
    !SHA256.test(manifest.observationDigest ?? "") ||
    !PUBLIC_ID.test(manifest.configRevisionId ?? "") ||
    !Number.isSafeInteger(manifest.configRevision) ||
    manifest.configRevision < 1 ||
    !SHA256.test(manifest.configRevisionDigest ?? "") ||
    !SHA256.test(manifest.signedSnapshotDigest ?? "") ||
    !exactKeys(manifest.snapshotSignature, signatureKeys) ||
    !PUBLIC_ID.test(manifest.snapshotSignature.keyId ?? "") ||
    !PUBLIC_ID.test(manifest.snapshotSignature.policyRevision ?? "") ||
    !SHA256.test(manifest.snapshotSignature.digest ?? "") ||
    !exactKeys(manifest.staticBinding, bindingKeys) ||
    !calledWorkflow ||
    !calledWorkflow.profiles.includes(manifest.staticBinding.profile) ||
    !calledWorkflow.packageManagers.includes(manifest.staticBinding.packageManager) ||
    !safeDirectory(manifest.staticBinding.workspaceRoot) ||
    !safeDirectory(manifest.staticBinding.commandDirectory) ||
    !SHA256.test(response.manifestDigest ?? "") ||
    response.manifestDigest !== sha256(canonicalJson(manifest))
  ) {
    fail("STATIC_RUNTIME_READBACK_INVALID");
  }
  return manifest;
}

async function readLimitedText(response, maximumBytes) {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    fail("STATIC_RUNTIME_RESPONSE_TOO_LARGE");
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        fail("STATIC_RUNTIME_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) fail("STATIC_RUNTIME_RESPONSE_TOO_LARGE");
  return text;
}

export async function requestGithubOidcToken(
  audience,
  { fetchImpl = globalThis.fetch, env = process.env } = {},
) {
  if (typeof fetchImpl !== "function") fail("STATIC_RUNTIME_FETCH_REQUIRED");
  let endpoint;
  try {
    endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  } catch {
    fail("STATIC_RUNTIME_OIDC_ENDPOINT_INVALID");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    !endpoint.hostname ||
    !endpoint.pathname ||
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== "string" ||
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length === 0 ||
    /[\r\n\0]/u.test(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  ) {
    fail("STATIC_RUNTIME_OIDC_ENDPOINT_INVALID");
  }
  endpoint.searchParams.set("audience", audience);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    fail("STATIC_RUNTIME_OIDC_REQUEST_FAILED");
  }
  if (!response?.ok) fail(`STATIC_RUNTIME_OIDC_HTTP_${response?.status ?? "UNKNOWN"}`);
  if (!(response.headers?.get?.("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    fail("STATIC_RUNTIME_OIDC_CONTENT_TYPE_INVALID");
  }
  let payload;
  try {
    payload = JSON.parse(await readLimitedText(response, 16 * 1024));
  } catch (error) {
    if (error?.message === "STATIC_RUNTIME_RESPONSE_TOO_LARGE") throw error;
    fail("STATIC_RUNTIME_OIDC_RESPONSE_INVALID");
  }
  if (!exactKeys(payload, ["value"]) || !JWT.test(payload.value ?? "")) {
    fail("STATIC_RUNTIME_OIDC_RESPONSE_INVALID");
  }
  return payload.value;
}

export function createStaticManifestReadbackV5({
  fetchImpl = globalThis.fetch,
  oidcTokenProvider,
  waitImpl = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
} = {}) {
  if (typeof fetchImpl !== "function") fail("STATIC_RUNTIME_FETCH_REQUIRED");
  if (typeof waitImpl !== "function") fail("STATIC_RUNTIME_WAIT_REQUIRED");
  const getToken = oidcTokenProvider ?? ((audience) => requestGithubOidcToken(audience, { fetchImpl }));
  return async (request) => {
    let token;
    try {
      token = await getToken(staticRuntimeBindingV5Contract.audience);
    } catch {
      fail("STATIC_RUNTIME_OIDC_REQUEST_FAILED");
    }
    if (!JWT.test(token ?? "")) fail("STATIC_RUNTIME_OIDC_TOKEN_INVALID");
    const url = new URL(
      staticRuntimeBindingV5Contract.endpoint.replace(
        "{repositoryId}",
        encodeURIComponent(request.repositoryId),
      ),
      staticRuntimeBindingV5Contract.origin,
    );
    url.searchParams.set("ref", request.bindingSourceSha);
    url.searchParams.set("application_ref", request.applicationSourceSha);
    url.searchParams.set("schema", "workflow-bundle-v5-static");
    for (let attempt = 0; attempt <= STATIC_MANIFEST_RETRY_DELAYS_MS.length; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "x-seori-principal": `github-actions:${request.repositoryId}:${request.runId}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        fail("STATIC_RUNTIME_MANIFEST_REQUEST_FAILED");
      }
      if (response?.status === 409 && attempt < STATIC_MANIFEST_RETRY_DELAYS_MS.length) {
        await response.body?.cancel?.().catch(() => undefined);
        await waitImpl(STATIC_MANIFEST_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (!response?.ok) fail(`STATIC_RUNTIME_MANIFEST_HTTP_${response?.status ?? "UNKNOWN"}`);
      const contentType = response.headers?.get?.("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        fail("STATIC_RUNTIME_MANIFEST_CONTENT_TYPE_INVALID");
      }
      try {
        return JSON.parse(await readLimitedText(response, MAX_RESPONSE_BYTES));
      } catch (error) {
        if (error?.message === "STATIC_RUNTIME_RESPONSE_TOO_LARGE") throw error;
        fail("STATIC_RUNTIME_MANIFEST_RESPONSE_INVALID");
      }
    }
    fail("STATIC_RUNTIME_MANIFEST_RETRY_EXHAUSTED");
  };
}

export async function resolveStaticRuntimeBindingV5(
  context,
  { trustedManifestReadback } = {},
) {
  const identity = validateContext(context);
  if (typeof trustedManifestReadback !== "function") {
    fail("STATIC_RUNTIME_TRUSTED_READBACK_REQUIRED");
  }
  const request = Object.freeze({
    repositoryId: context.repositoryId,
    fullName: context.fullName,
    applicationSourceSha: identity.applicationSourceSha,
    bindingSourceSha: identity.bindingSourceSha,
    callerWorkflowRef: context.callerWorkflowRef,
    calledWorkflowRef: context.jobWorkflowRef,
    calledWorkflowPath: identity.calledWorkflowPath,
    runId: String(context.runId),
    runAttempt: String(context.runAttempt),
  });
  const response = await trustedManifestReadback(structuredClone(request));
  const manifest = validateManifestResponse(response, request);
  if (manifest.lifecycleState === "DEPRECATED") fail("STATIC_RUNTIME_NO_CALLER");
  return Object.freeze({
    applicationSourceSha: request.applicationSourceSha,
    bindingSourceSha: request.bindingSourceSha,
    calledWorkflowPath: request.calledWorkflowPath,
    profile: manifest.staticBinding.profile,
    packageManager: manifest.staticBinding.packageManager,
    workspaceRoot: manifest.staticBinding.workspaceRoot,
    commandDirectory: manifest.staticBinding.commandDirectory,
    enforcementMode: manifest.lifecycleState === "ACTIVE" ? "ENFORCE" : "SHADOW",
    configRevisionId: manifest.configRevisionId,
    configRevision: manifest.configRevision,
    configRevisionDigest: manifest.configRevisionDigest,
    signedSnapshotDigest: manifest.signedSnapshotDigest,
    snapshotSignatureKeyId: manifest.snapshotSignature.keyId,
    snapshotSignaturePolicyRevision: manifest.snapshotSignature.policyRevision,
    snapshotSignatureDigest: manifest.snapshotSignature.digest,
    manifestDigest: response.manifestDigest,
  });
}

function validateBuildContext(context) {
  const eventSourceSha = context?.eventSourceSha ?? context?.applicationSourceSha;
  if (
    context?.repositoryPrivate !== "true" ||
    !REPOSITORY_ID.test(context?.repositoryId ?? "") ||
    !FULL_NAME.test(context?.fullName ?? "") ||
    !SHA.test(eventSourceSha ?? "") ||
    !positiveIntegerString(context?.runId) ||
    !positiveIntegerString(context?.runAttempt) ||
    context.jobWorkflowRepository !== "seorilabs/.github" ||
    !SHA.test(context.jobWorkflowSha ?? "")
  ) {
    fail("BUILD_RUNTIME_CONTEXT_INVALID");
  }
  const contract = Object.values(BUILD_RUNTIME_CONTRACTS).find(
    ({ calledWorkflowPath }) =>
      context.jobWorkflowRef ===
        `seorilabs/.github/${calledWorkflowPath}@${context.jobWorkflowSha}`,
  );
  if (!contract) fail("BUILD_RUNTIME_CALLED_WORKFLOW_IDENTITY_INVALID");
  const expectedCaller = `${context.fullName}/${contract.callerPath}@${context.eventRef}`;
  if (context.callerWorkflowRef !== expectedCaller) {
    fail("BUILD_RUNTIME_CALLER_WORKFLOW_IDENTITY_INVALID");
  }
  if (context.eventName === "workflow_dispatch") {
    if (
      context.eventRef !== "refs/heads/main" ||
      (context.pullRequestBaseSha ?? "") !== "" ||
      (context.pullRequestHeadRepository ?? "") !== "" ||
      (context.pullRequestHeadRef ?? "") !== ""
    ) {
      fail("BUILD_RUNTIME_MAIN_IDENTITY_INVALID");
    }
    return Object.freeze({
      applicationSourceSha: eventSourceSha,
      contract,
      eventSourceSha,
      mode: "APPROVED",
      schema: "workflow-bundle-v5-build",
    });
  }
  const canary = BUILD_CANARIES[context.repositoryId];
  if (
    context.eventName !== "pull_request" ||
    !canary ||
    canary.fullName !== context.fullName ||
    canary.profile !== contract.profile ||
    !/^refs\/pull\/[1-9][0-9]*\/merge$/u.test(context.eventRef ?? "") ||
    !SHA.test(context.pullRequestBaseSha ?? "") ||
    context.pullRequestHeadRepository !== context.fullName ||
    context.pullRequestHeadRef !==
      `seori/workflow-bundle-v5-canary/${context.repositoryId}/${context.jobWorkflowSha.slice(0, 12)}`
  ) {
    fail("BUILD_RUNTIME_CANDIDATE_IDENTITY_INVALID");
  }
  return Object.freeze({
    applicationSourceSha: context.pullRequestBaseSha,
    contract,
    eventSourceSha,
    mode: "CANDIDATE",
    schema: "workflow-bundle-v5-build-canary",
  });
}

function validateBuildManifestResponse(response, request, contract) {
  const responseKeys = [
    "schemaVersion", "state", "mode", "repositoryId", "fullName",
    "applicationSourceSha", "eventSourceSha", "manifestDigest", "manifest",
  ];
  const manifestKeys = [
    "schemaVersion", "lifecycleState", "repositoryId", "fullName", "sourceSha",
    "sourceRef", "observationId", "observationDigest", "configRevisionId",
    "configRevision", "configRevisionDigest", "signedSnapshotDigest",
    "snapshotSignature", "workflowBundle", "buildBinding",
  ];
  const signatureKeys = ["keyId", "policyRevision", "digest"];
  const workflowBundleKeys = ["sourceSha", "payloadDigest", "approvalState", "buildProfiles"];
  const bindingKeys = [
    "target", "buildProfile", "packageManager", "executionRoot", "dependencyRoot",
    "scriptPath", "artifactKind",
  ];
  const manifest = response?.manifest;
  const binding = manifest?.buildBinding;
  const workflowBundle = manifest?.workflowBundle;
  if (
    !exactKeys(response, responseKeys) ||
    response.schemaVersion !== 1 ||
    response.state !== "VERIFIED" ||
    response.mode !== request.mode ||
    response.repositoryId !== request.repositoryId ||
    response.fullName !== request.fullName ||
    response.applicationSourceSha !== request.applicationSourceSha ||
    response.eventSourceSha !== request.eventSourceSha ||
    !exactKeys(manifest, manifestKeys) ||
    manifest.schemaVersion !== 1 ||
    !["ACTIVE", "PAUSED", "DEPRECATED"].includes(manifest.lifecycleState) ||
    manifest.repositoryId !== request.repositoryId ||
    manifest.fullName !== request.fullName ||
    manifest.sourceSha !== request.applicationSourceSha ||
    manifest.sourceRef !== "refs/heads/main" ||
    !PUBLIC_ID.test(manifest.observationId ?? "") ||
    !SHA256.test(manifest.observationDigest ?? "") ||
    !PUBLIC_ID.test(manifest.configRevisionId ?? "") ||
    !Number.isSafeInteger(manifest.configRevision) ||
    manifest.configRevision < 1 ||
    !SHA256.test(manifest.configRevisionDigest ?? "") ||
    !SHA256.test(manifest.signedSnapshotDigest ?? "") ||
    !exactKeys(manifest.snapshotSignature, signatureKeys) ||
    !PUBLIC_ID.test(manifest.snapshotSignature.keyId ?? "") ||
    !PUBLIC_ID.test(manifest.snapshotSignature.policyRevision ?? "") ||
    !SHA256.test(manifest.snapshotSignature.digest ?? "") ||
    !exactKeys(workflowBundle, workflowBundleKeys) ||
    workflowBundle.sourceSha !== request.workflowExecutionSha ||
    !SHA256.test(workflowBundle.payloadDigest ?? "") ||
    workflowBundle.approvalState !== request.mode ||
    canonicalJson(workflowBundle.buildProfiles) !==
      canonicalJson(["react-native-android", "godot-android"]) ||
    !exactKeys(binding, bindingKeys) ||
    binding.target !== "android" ||
    binding.buildProfile !== contract.profile ||
    binding.packageManager !== contract.packageManager ||
    !safeDirectory(binding.executionRoot) ||
    !safeDirectory(binding.dependencyRoot) ||
    binding.scriptPath !== contract.scriptPath ||
    binding.artifactKind !== contract.artifactKind ||
    !SHA256.test(response.manifestDigest ?? "") ||
    response.manifestDigest !== sha256(canonicalJson(manifest))
  ) {
    fail("BUILD_RUNTIME_READBACK_INVALID");
  }
  return manifest;
}

export function createBuildManifestReadbackV5({
  fetchImpl = globalThis.fetch,
  oidcTokenProvider,
  waitImpl = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
} = {}) {
  if (typeof fetchImpl !== "function") fail("BUILD_RUNTIME_FETCH_REQUIRED");
  if (typeof waitImpl !== "function") fail("BUILD_RUNTIME_WAIT_REQUIRED");
  const getToken = oidcTokenProvider ?? ((audience) => requestGithubOidcToken(audience, { fetchImpl }));
  return async (request) => {
    let token;
    try {
      token = await getToken(buildRuntimeBindingV5Contract.audience);
    } catch {
      fail("BUILD_RUNTIME_OIDC_REQUEST_FAILED");
    }
    if (!JWT.test(token ?? "")) fail("BUILD_RUNTIME_OIDC_TOKEN_INVALID");
    const url = new URL(
      buildRuntimeBindingV5Contract.endpoint.replace(
        "{repositoryId}",
        encodeURIComponent(request.repositoryId),
      ),
      buildRuntimeBindingV5Contract.origin,
    );
    url.searchParams.set("ref", request.applicationSourceSha);
    url.searchParams.set("event_ref", request.eventSourceSha);
    url.searchParams.set("workflow_sha", request.workflowExecutionSha);
    url.searchParams.set("build_profile", request.buildProfile);
    url.searchParams.set("schema", request.schema);
    for (let attempt = 0; attempt <= STATIC_MANIFEST_RETRY_DELAYS_MS.length; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "x-seori-principal": `github-actions:${request.repositoryId}:${request.runId}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        fail("BUILD_RUNTIME_MANIFEST_REQUEST_FAILED");
      }
      if (response?.status === 409 && attempt < STATIC_MANIFEST_RETRY_DELAYS_MS.length) {
        await response.body?.cancel?.().catch(() => undefined);
        await waitImpl(STATIC_MANIFEST_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (!response?.ok) fail(`BUILD_RUNTIME_MANIFEST_HTTP_${response?.status ?? "UNKNOWN"}`);
      if (!(response.headers?.get?.("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        fail("BUILD_RUNTIME_MANIFEST_CONTENT_TYPE_INVALID");
      }
      try {
        return JSON.parse(await readLimitedText(response, MAX_RESPONSE_BYTES));
      } catch (error) {
        if (error?.message === "STATIC_RUNTIME_RESPONSE_TOO_LARGE") {
          fail("BUILD_RUNTIME_RESPONSE_TOO_LARGE");
        }
        fail("BUILD_RUNTIME_MANIFEST_RESPONSE_INVALID");
      }
    }
    fail("BUILD_RUNTIME_MANIFEST_RETRY_EXHAUSTED");
  };
}

export async function resolveBuildRuntimeBindingV5(
  context,
  { trustedManifestReadback } = {},
) {
  const identity = validateBuildContext(context);
  if (typeof trustedManifestReadback !== "function") {
    fail("BUILD_RUNTIME_TRUSTED_READBACK_REQUIRED");
  }
  const request = Object.freeze({
    repositoryId: context.repositoryId,
    fullName: context.fullName,
    applicationSourceSha: identity.applicationSourceSha,
    eventSourceSha: identity.eventSourceSha,
    workflowExecutionSha: context.jobWorkflowSha,
    buildProfile: identity.contract.profile,
    callerWorkflowRef: context.callerWorkflowRef,
    calledWorkflowRef: context.jobWorkflowRef,
    runId: String(context.runId),
    runAttempt: String(context.runAttempt),
    mode: identity.mode,
    schema: identity.schema,
  });
  const response = await trustedManifestReadback(structuredClone(request));
  const manifest = validateBuildManifestResponse(response, request, identity.contract);
  if (manifest.lifecycleState !== "ACTIVE") {
    fail(`${manifest.lifecycleState}_BUILD_RUNTIME_FORBIDDEN`);
  }
  return Object.freeze({
    applicationSourceSha: manifest.sourceSha,
    eventSourceSha: request.eventSourceSha,
    calledWorkflowPath: identity.contract.calledWorkflowPath,
    buildProfile: manifest.buildBinding.buildProfile,
    packageManager: manifest.buildBinding.packageManager,
    executionRoot: manifest.buildBinding.executionRoot,
    dependencyRoot: manifest.buildBinding.dependencyRoot,
    scriptPath: manifest.buildBinding.scriptPath,
    artifactKind: manifest.buildBinding.artifactKind,
    configRevisionId: manifest.configRevisionId,
    configRevision: manifest.configRevision,
    configRevisionDigest: manifest.configRevisionDigest,
    signedSnapshotDigest: manifest.signedSnapshotDigest,
    snapshotSignatureKeyId: manifest.snapshotSignature.keyId,
    snapshotSignaturePolicyRevision: manifest.snapshotSignature.policyRevision,
    snapshotSignatureDigest: manifest.snapshotSignature.digest,
    workflowBundleSourceSha: manifest.workflowBundle.sourceSha,
    workflowBundlePayloadDigest: manifest.workflowBundle.payloadDigest,
    workflowBundleApprovalState: manifest.workflowBundle.approvalState,
    manifestDigest: response.manifestDigest,
  });
}

function environmentContext(env) {
  return {
    eventName: env.EVENT_NAME,
    eventRef: env.EVENT_REF,
    applicationSourceSha: env.APPLICATION_SOURCE_SHA,
    eventSourceSha: env.EVENT_SOURCE_SHA,
    pullRequestBaseSha: env.PR_BASE_SHA ?? "",
    pullRequestHeadRepository: env.PR_HEAD_REPOSITORY ?? "",
    pullRequestHeadRef: env.PR_HEAD_REF ?? "",
    repositoryId: env.REPOSITORY_ID,
    fullName: env.FULL_NAME,
    repositoryPrivate: env.REPOSITORY_PRIVATE,
    callerWorkflowRef: env.CALLER_WORKFLOW_REF,
    jobWorkflowRepository: env.JOB_WORKFLOW_REPOSITORY,
    jobWorkflowSha: env.JOB_WORKFLOW_SHA,
    jobWorkflowRef: env.JOB_WORKFLOW_REF,
    runId: env.RUN_ID,
    runAttempt: env.RUN_ATTEMPT,
  };
}

function appendOutputs(path, binding) {
  if (typeof path !== "string" || path.length === 0) fail("STATIC_RUNTIME_OUTPUT_REQUIRED");
  const outputs = {
    application_source_sha: binding.applicationSourceSha,
    binding_source_sha: binding.bindingSourceSha,
    called_workflow_path: binding.calledWorkflowPath,
    profile: binding.profile,
    package_manager: binding.packageManager,
    workspace_root: binding.workspaceRoot,
    command_directory: binding.commandDirectory,
    enforcement_mode: binding.enforcementMode,
    config_revision_id: binding.configRevisionId,
    config_revision: binding.configRevision,
    config_revision_digest: binding.configRevisionDigest,
    signed_snapshot_digest: binding.signedSnapshotDigest,
    snapshot_signature_key_id: binding.snapshotSignatureKeyId,
    snapshot_signature_policy_revision: binding.snapshotSignaturePolicyRevision,
    snapshot_signature_digest: binding.snapshotSignatureDigest,
    manifest_digest: binding.manifestDigest,
  };
  appendFileSync(
    path,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""),
  );
}

function appendBuildOutputs(path, binding) {
  if (typeof path !== "string" || path.length === 0) fail("BUILD_RUNTIME_OUTPUT_REQUIRED");
  const outputs = {
    application_source_sha: binding.applicationSourceSha,
    event_source_sha: binding.eventSourceSha,
    called_workflow_path: binding.calledWorkflowPath,
    build_profile: binding.buildProfile,
    package_manager: binding.packageManager ?? "none",
    execution_root: binding.executionRoot,
    dependency_root: binding.dependencyRoot,
    script_path: binding.scriptPath,
    artifact_kind: binding.artifactKind,
    config_revision_id: binding.configRevisionId,
    config_revision: binding.configRevision,
    config_revision_digest: binding.configRevisionDigest,
    signed_snapshot_digest: binding.signedSnapshotDigest,
    snapshot_signature_key_id: binding.snapshotSignatureKeyId,
    snapshot_signature_policy_revision: binding.snapshotSignaturePolicyRevision,
    snapshot_signature_digest: binding.snapshotSignatureDigest,
    workflow_bundle_source_sha: binding.workflowBundleSourceSha,
    workflow_bundle_payload_digest: binding.workflowBundlePayloadDigest,
    workflow_bundle_approval_state: binding.workflowBundleApprovalState,
    manifest_digest: binding.manifestDigest,
  };
  appendFileSync(
    path,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""),
  );
}

if (import.meta.main) {
  try {
    if (process.env.BINDING_TARGET) {
      if (process.env.BINDING_TARGET !== "android") fail("BUILD_RUNTIME_TARGET_INVALID");
      const trustedManifestReadback = createBuildManifestReadbackV5();
      const binding = await resolveBuildRuntimeBindingV5(environmentContext(process.env), {
        trustedManifestReadback,
      });
      appendBuildOutputs(process.env.GITHUB_OUTPUT, binding);
    } else {
      const trustedManifestReadback = createStaticManifestReadbackV5();
      const binding = await resolveStaticRuntimeBindingV5(environmentContext(process.env), {
        trustedManifestReadback,
      });
      appendOutputs(process.env.GITHUB_OUTPUT, binding);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? "STATIC_RUNTIME_BINDING_FAILED"}\n`);
    process.exitCode = 1;
  }
}
