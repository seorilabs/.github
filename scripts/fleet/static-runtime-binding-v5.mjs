import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindingDigest,
  computeAuthorityRevision,
  computeConfigRevision,
  createReleaseBinding,
  parseReleaseTagRef,
} from "../release/tag-version-authority.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PLAN_IDENTITY = /^[0-9a-f]{64}$/u;
const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;
const FULL_NAME = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const GHSA = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
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
    target: "android",
    callerPath: ".github/workflows/android-build-only.yml",
    calledWorkflowPath: ".github/workflows/rn-build-android-cloud-v2.yml",
    profile: "react-native-android",
    packageManager: "pnpm",
    artifactKind: "android-aab",
    releaseArtifactKind: "android-app-bundle",
    scriptPath: "scripts/build-android.sh",
  }),
  godotAndroid: Object.freeze({
    target: "android",
    callerPath: ".github/workflows/android-build-only.yml",
    calledWorkflowPath: ".github/workflows/godot-build-android-cloud-v2.yml",
    profile: "godot-android",
    packageManager: null,
    artifactKind: "android-aab",
    releaseArtifactKind: "android-app-bundle",
    scriptPath: "scripts/build-android.sh",
  }),
  aitGranite: Object.freeze({
    target: "ait",
    callerPath: ".github/workflows/ait-build-only.yml",
    calledWorkflowPath: ".github/workflows/ait-build-only-v1.yml",
    profile: "ait-granite",
    packageManager: "pnpm",
    artifactKind: "ait",
    releaseArtifactKind: "ait",
    scriptPath: "scripts/build-ait.sh",
  }),
  aitWeb: Object.freeze({
    target: "ait",
    callerPath: ".github/workflows/ait-build-only.yml",
    calledWorkflowPath: ".github/workflows/ait-build-only-v1.yml",
    profile: "ait-web",
    packageManager: "npm",
    artifactKind: "ait",
    releaseArtifactKind: "ait",
    scriptPath: "scripts/build-ait.sh",
  }),
});
const BUILD_RUNTIME_TARGETS = Object.freeze(["android", "ait"]);
// 마켓 artifact를 만드는 실행은 exact stable release tag ref에서만 시작한다.
const RELEASE_MODE = "RELEASE";
const DEFAULT_AUTHORITY_CONTRACT_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "../../contracts/release-version-authority.yaml",
);
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
// push[main] caller는 discovery 관측이 기록되기 전에 binding을 읽으므로 409를 만난다.
// 실측 간격은 push 이벤트로부터 약 30~40초였다. 요청 timeout이 10초라 서버가 응답을
// 붙잡아 둘 수 없으므로 caller가 지수 백오프로 기다린다. 총 대기는 91초다.
const STATIC_MANIFEST_RETRY_DELAYS_MS = Object.freeze([
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
  30_000,
]);
const CANDIDATE_BRANCH =
  /^seori\/workflow-bundle-v5-canary\/([1-9][0-9]{0,31})\/([0-9a-f]{12})\/([0-9a-f]{64})$/u;

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
  sourceStrategy: "exact-main-or-fixed-canary-pr-base-or-exact-release-tag",
  candidatePolicy: "fixed-repository-workflow-sha-and-plan-identity",
  candidateBranchTemplate:
    "seori/workflow-bundle-v5-canary/{repositoryId}/{workflowSha12}/{planIdentity}",
  releasePolicy: "exact-stable-release-tag-with-source-sha-and-config-revision",
  releaseVersionAuthority: "release-version-authority-v1",
  targets: BUILD_RUNTIME_TARGETS,
  calledWorkflows: BUILD_RUNTIME_CONTRACTS,
  canaries: BUILD_CANARIES,
});

function fail(code) {
  throw new Error(code);
}

function isReleaseRef(ref) {
  return typeof ref === "string" && ref.startsWith("refs/tags/");
}

function readAuthorityContract(path) {
  try {
    return readFileSync(path ?? DEFAULT_AUTHORITY_CONTRACT_PATH, "utf8");
  } catch {
    fail("RELEASE_VERSION_AUTHORITY_CONTRACT_UNREADABLE");
    return "";
  }
}

/**
 * release 실행의 version binding. exact stable tag 하나에서 display version과 versionCode를
 * 파생하고, source SHA와 called workflow full SHA·authority 계약 revision을 config revision으로
 * 고정한다. 여기서 만든 값은 build 뒤 artifact readback에서 다시 대조한다.
 */
function releaseBindingFor({
  releaseTag,
  sourceSha,
  calledWorkflowRepository,
  calledWorkflowRef,
  calledWorkflowSha,
  authorityContract,
}) {
  let binding;
  try {
    const authorityRevision = computeAuthorityRevision(authorityContract);
    binding = createReleaseBinding({
      tag: releaseTag,
      sourceSha,
      authorityRevision,
      configRevision: computeConfigRevision({
        calledWorkflowRepository,
        calledWorkflowRef,
        calledWorkflowSha,
        authorityRevision,
      }),
    });
  } catch (error) {
    fail(`RELEASE_VERSION_AUTHORITY_${String(error?.code ?? "FAILED").toUpperCase().replaceAll("-", "_")}`);
  }
  return Object.freeze({ ...binding, bindingDigest: bindingDigest(binding) });
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

function validateDependencyAuditException(value, request, actionClass, nowMs) {
  if (value === undefined) return null;
  const topLevelKeys = [
    "schemaVersion",
    "repositoryId",
    "fullName",
    "expiresAt",
    "reason",
    "bindings",
    "advisories",
  ];
  const bindingKeys = ["actionClass", "sourceSha", "lockfileSha256"];
  const advisoryKeys = ["ghsa", "module", "severity", "versions"];
  if (
    !exactKeys(value, topLevelKeys) ||
    value.schemaVersion !== 1 ||
    value.repositoryId !== request.repositoryId ||
    value.fullName !== request.fullName ||
    typeof value.reason !== "string" ||
    value.reason.length < 1 ||
    value.reason.length > 500 ||
    /[\r\n\0]/u.test(value.reason) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= nowMs ||
    !Array.isArray(value.bindings) ||
    value.bindings.length !== 2 ||
    !Array.isArray(value.advisories) ||
    value.advisories.length < 1 ||
    value.advisories.length > 16
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
  }
  const expectedActions = ["ANDROID_BUILD_ONLY", "STATIC_CHECK"];
  const actions = value.bindings.map((binding) => binding?.actionClass).sort();
  if (canonicalJson(actions) !== canonicalJson(expectedActions)) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
  }
  for (const binding of value.bindings) {
    if (
      !exactKeys(binding, bindingKeys) ||
      !expectedActions.includes(binding.actionClass) ||
      !SHA.test(binding.sourceSha ?? "") ||
      !SHA256.test(binding.lockfileSha256 ?? "")
    ) {
      fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
    }
  }
  const advisoryKeysSeen = [];
  for (const advisory of value.advisories) {
    if (
      !exactKeys(advisory, advisoryKeys) ||
      !GHSA.test(advisory.ghsa ?? "") ||
      !PACKAGE_NAME.test(advisory.module ?? "") ||
      advisory.severity !== "high" ||
      !Array.isArray(advisory.versions) ||
      advisory.versions.length < 1 ||
      advisory.versions.length > 16 ||
      advisory.versions.some((version) => !EXACT_VERSION.test(version)) ||
      canonicalJson(advisory.versions) !== canonicalJson([...new Set(advisory.versions)].sort())
    ) {
      fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
    }
    advisoryKeysSeen.push(`${advisory.ghsa}:${advisory.module}`);
  }
  if (
    canonicalJson(advisoryKeysSeen) !== canonicalJson([...new Set(advisoryKeysSeen)].sort())
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
  }
  const binding = value.bindings.find((candidate) => candidate.actionClass === actionClass);
  // 예외는 ACTIVE 설정과 discovery가 결합된 기본 브랜치 exact source(bindingSourceSha)에
  // 묶인다. main/dispatch 실행은 application source와 같고, 후보 PR 실행은 merge 커밋이
  // 아니라 PR base다. lockfile digest 결합은 staging 단계가 별도로 강제한다.
  const boundSourceSha = request.bindingSourceSha ?? request.applicationSourceSha;
  if (!binding || binding.sourceSha !== boundSourceSha) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH");
  }
  return Object.freeze(structuredClone(value));
}

function encodedDependencyAuditException(value) {
  return value === null ? "" : Buffer.from(canonicalJson(value), "utf8").toString("base64url");
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

function parseCandidateBranchIdentity(value) {
  const match = CANDIDATE_BRANCH.exec(value ?? "");
  if (!match) return null;
  return Object.freeze({
    repositoryId: match[1],
    workflowSha12: match[2],
    planIdentity: match[3],
  });
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

function validateManifestResponse(response, request, nowMs = Date.now()) {
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
  if (response?.manifest?.dependencyAuditException !== undefined) {
    manifestKeys.push("dependencyAuditException");
  }
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
  const dependencyAuditException = validateDependencyAuditException(
    manifest.dependencyAuditException,
    request,
    "STATIC_CHECK",
    nowMs,
  );
  return { manifest, dependencyAuditException };
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
  { trustedManifestReadback, now = () => new Date() } = {},
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
  const current = now();
  if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_CLOCK_INVALID");
  }
  const { manifest, dependencyAuditException } = validateManifestResponse(
    response,
    request,
    current.getTime(),
  );
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
    dependencyAuditException: encodedDependencyAuditException(dependencyAuditException),
  });
}

function validateBuildContext(context) {
  const eventSourceSha = context?.eventSourceSha ?? context?.applicationSourceSha;
  const applicationSourceSha = context?.applicationSourceSha ?? eventSourceSha;
  if (
    !["true", "false"].includes(context?.repositoryPrivate) ||
    !REPOSITORY_ID.test(context?.repositoryId ?? "") ||
    !FULL_NAME.test(context?.fullName ?? "") ||
    !SHA.test(applicationSourceSha ?? "") ||
    !SHA.test(eventSourceSha ?? "") ||
    !positiveIntegerString(context?.runId) ||
    !positiveIntegerString(context?.runAttempt) ||
    context.jobWorkflowRepository !== "seorilabs/.github" ||
    !SHA.test(context.jobWorkflowSha ?? "") ||
    !BUILD_RUNTIME_TARGETS.includes(context.bindingTarget ?? "")
  ) {
    fail("BUILD_RUNTIME_CONTEXT_INVALID");
  }
  const candidates = Object.values(BUILD_RUNTIME_CONTRACTS).filter(
    ({ calledWorkflowPath, target }) =>
      target === context.bindingTarget &&
      context.jobWorkflowRef ===
        `seorilabs/.github/${calledWorkflowPath}@${context.jobWorkflowSha}`,
  );
  if (candidates.length === 0) fail("BUILD_RUNTIME_CALLED_WORKFLOW_IDENTITY_INVALID");
  // 같은 called workflow가 여러 profile을 담당하면 profile은 caller 입력이 아니라
  // Backoffice manifest readback이 정한다. contract는 그때 exact match로 다시 고정한다.
  const contract = candidates.length === 1 ? candidates[0] : null;
  const expectedCaller = `${context.fullName}/${candidates[0].callerPath}@${context.eventRef}`;
  if (context.callerWorkflowRef !== expectedCaller) {
    fail("BUILD_RUNTIME_CALLER_WORKFLOW_IDENTITY_INVALID");
  }
  // 마켓 artifact를 만드는 실행은 exact stable release tag ref에서만 시작한다.
  if (isReleaseRef(context.eventRef)) {
    if (
      !["push", "workflow_dispatch"].includes(context.eventName) ||
      (context.pullRequestBaseSha ?? "") !== "" ||
      (context.pullRequestHeadRepository ?? "") !== "" ||
      (context.pullRequestHeadRef ?? "") !== ""
    ) {
      fail("BUILD_RUNTIME_RELEASE_IDENTITY_INVALID");
    }
    let tag;
    try {
      ({ tag } = parseReleaseTagRef(context.eventRef));
    } catch {
      // 태그 형식 위반은 build runtime 오류 계열로 정규화한다. 상세는 노출하지 않는다.
      fail("BUILD_RUNTIME_RELEASE_TAG_INVALID");
    }
    return Object.freeze({
      // annotated tag event SHA는 tag object일 수 있다. application source는 GitHub ref
      // readback에서 peel한 commit이고 eventSourceSha는 OIDC `sha` claim 대조용으로 분리한다.
      applicationSourceSha,
      candidates: Object.freeze(candidates),
      contract,
      eventSourceSha,
      mode: RELEASE_MODE,
      releaseTag: tag,
      releaseRef: context.eventRef,
      schema: "workflow-bundle-v5-build-release",
    });
  }
  // public repository의 build runtime은 stable tag 외에는 열지 않는다. 특히 public PR과
  // main workflow_dispatch가 OIDC manifest readback까지 진행하지 못하게 여기서 차단한다.
  if (context.repositoryPrivate === "false") {
    fail("BUILD_RUNTIME_PUBLIC_STABLE_TAG_REQUIRED");
  }
  if (context.eventName === "workflow_dispatch") {
    if (
      context.eventRef !== "refs/heads/main" ||
      applicationSourceSha !== eventSourceSha ||
      (context.pullRequestBaseSha ?? "") !== "" ||
      (context.pullRequestHeadRepository ?? "") !== "" ||
      (context.pullRequestHeadRef ?? "") !== ""
    ) {
      fail("BUILD_RUNTIME_MAIN_IDENTITY_INVALID");
    }
    return Object.freeze({
      applicationSourceSha: eventSourceSha,
      candidates: Object.freeze(candidates),
      contract,
      eventSourceSha,
      mode: "APPROVED",
      schema: "workflow-bundle-v5-build",
    });
  }
  const canary = BUILD_CANARIES[context.repositoryId];
  const candidateBranchIdentity = parseCandidateBranchIdentity(
    context.pullRequestHeadRef,
  );
  if (
    context.eventName !== "pull_request" ||
    !canary ||
    canary.fullName !== context.fullName ||
    contract === null ||
    canary.profile !== contract.profile ||
    !/^refs\/pull\/[1-9][0-9]*\/merge$/u.test(context.eventRef ?? "") ||
    !SHA.test(context.pullRequestBaseSha ?? "") ||
    context.pullRequestHeadRepository !== context.fullName ||
    !candidateBranchIdentity ||
    candidateBranchIdentity.repositoryId !== context.repositoryId ||
    candidateBranchIdentity.workflowSha12 !== context.jobWorkflowSha.slice(0, 12) ||
    !PLAN_IDENTITY.test(candidateBranchIdentity.planIdentity)
  ) {
    fail("BUILD_RUNTIME_CANDIDATE_IDENTITY_INVALID");
  }
  return Object.freeze({
    applicationSourceSha: context.pullRequestBaseSha,
    candidates: Object.freeze(candidates),
    contract,
    eventSourceSha,
    mode: "CANDIDATE",
    planIdentity: candidateBranchIdentity.planIdentity,
    schema: "workflow-bundle-v5-build-canary",
  });
}

function validateBuildManifestResponse(response, request, contracts, nowMs = Date.now()) {
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
  if (response?.manifest?.dependencyAuditException !== undefined) {
    manifestKeys.push("dependencyAuditException");
  }
  const signatureKeys = ["keyId", "policyRevision", "digest"];
  const workflowBundleKeys = ["sourceSha", "payloadDigest", "approvalState", "buildProfiles"];
  const bindingKeys = [
    "target", "buildProfile", "packageManager", "executionRoot", "dependencyRoot",
    "scriptPath", "artifactKind",
  ];
  const manifest = response?.manifest;
  const binding = manifest?.buildBinding;
  const workflowBundle = manifest?.workflowBundle;
  // profile은 caller가 아니라 서명된 manifest가 정한다. 그 profile에 해당하는 org 계약 하나로
  // packageManager·scriptPath·artifactKind를 다시 exact match한다.
  const contract = contracts.find(({ profile }) => profile === binding?.buildProfile) ?? null;
  if (contract === null) fail("BUILD_RUNTIME_READBACK_INVALID");
  if (
    !exactKeys(response, responseKeys) ||
    response.schemaVersion !== 1 ||
    response.state !== "VERIFIED" ||
    response.mode !== request.mode ||
    !["CANDIDATE", "APPROVED", RELEASE_MODE].includes(response.mode) ||
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
    // release 실행은 정확히 그 태그 ref에 묶인다. main manifest를 태그 실행에 재사용할 수 없다.
    manifest.sourceRef !== (request.releaseRef ?? "refs/heads/main") ||
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
    // release 실행은 승인된 번들에서만 만든다. CANDIDATE 번들로 마켓 artifact를 만들지 않는다.
    workflowBundle.approvalState !== (request.mode === RELEASE_MODE ? "APPROVED" : request.mode) ||
    canonicalJson(workflowBundle.buildProfiles) !==
      canonicalJson(["react-native-android", "godot-android"]) ||
    !exactKeys(binding, bindingKeys) ||
    binding.target !== request.bindingTarget ||
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
  // 승격되지 않은 build profile로는 어떤 artifact도 만들지 않는다. AIT profile은 아직
  // promotionScope에도 canary에도 없으므로 여기서 명시적으로 fail-closed한다.
  if (!workflowBundle.buildProfiles.includes(binding.buildProfile)) {
    fail("BUILD_PROFILE_NOT_PROMOTED");
  }
  const dependencyAuditException = validateDependencyAuditException(
    manifest.dependencyAuditException,
    request,
    "ANDROID_BUILD_ONLY",
    nowMs,
  );
  return { manifest, dependencyAuditException, contract };
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
    url.searchParams.set("build_target", request.bindingTarget);
    if (request.buildProfile !== null) {
      url.searchParams.set("build_profile", request.buildProfile);
    }
    if (request.mode === "CANDIDATE") {
      if (!PLAN_IDENTITY.test(request.planIdentity ?? "")) {
        fail("BUILD_RUNTIME_CANDIDATE_IDENTITY_INVALID");
      }
      url.searchParams.set("plan_identity", request.planIdentity);
    }
    if (request.mode === RELEASE_MODE) {
      url.searchParams.set("release_ref", request.releaseRef);
      url.searchParams.set("release_tag", request.releaseTag);
    }
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
  { trustedManifestReadback, now = () => new Date() } = {},
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
    bindingTarget: context.bindingTarget,
    buildProfile: identity.contract?.profile ?? null,
    callerWorkflowRef: context.callerWorkflowRef,
    calledWorkflowRef: context.jobWorkflowRef,
    runId: String(context.runId),
    runAttempt: String(context.runAttempt),
    mode: identity.mode,
    ...(identity.mode === "CANDIDATE"
      ? { planIdentity: identity.planIdentity }
      : {}),
    ...(identity.mode === RELEASE_MODE
      ? { releaseRef: identity.releaseRef, releaseTag: identity.releaseTag }
      : {}),
    schema: identity.schema,
  });
  const response = await trustedManifestReadback(structuredClone(request));
  const current = now();
  if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_CLOCK_INVALID");
  }
  const { manifest, dependencyAuditException, contract } = validateBuildManifestResponse(
    response,
    request,
    identity.candidates,
    current.getTime(),
  );
  if (contract.target !== "android" && dependencyAuditException !== null) {
    // dependency audit 예외는 Android build-only action class에만 정의돼 있다.
    fail("DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH");
  }
  if (manifest.lifecycleState !== "ACTIVE") {
    fail(`${manifest.lifecycleState}_BUILD_RUNTIME_FORBIDDEN`);
  }
  const release =
    identity.mode === RELEASE_MODE
      ? releaseBindingFor({
          releaseTag: identity.releaseTag,
          sourceSha: manifest.sourceSha,
          calledWorkflowRepository: context.jobWorkflowRepository,
          calledWorkflowRef: context.jobWorkflowRef,
          calledWorkflowSha: context.jobWorkflowSha,
          authorityContract: readAuthorityContract(context.authorityContractPath),
        })
      : null;
  return Object.freeze({
    applicationSourceSha: manifest.sourceSha,
    eventSourceSha: request.eventSourceSha,
    calledWorkflowPath: contract.calledWorkflowPath,
    bindingTarget: contract.target,
    mode: identity.mode,
    release,
    releaseArtifactKind: contract.releaseArtifactKind,
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
    planIdentity: request.planIdentity ?? null,
    manifestDigest: response.manifestDigest,
    dependencyAuditException: encodedDependencyAuditException(dependencyAuditException),
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
    bindingTarget: env.BINDING_TARGET,
    authorityContractPath: env.RELEASE_AUTHORITY_CONTRACT,
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
    dependency_audit_exception: binding.dependencyAuditException,
  };
  appendFileSync(
    path,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""),
  );
}

function appendBuildOutputs(path, binding) {
  if (typeof path !== "string" || path.length === 0) fail("BUILD_RUNTIME_OUTPUT_REQUIRED");
  const release = binding.release;
  const outputs = {
    application_source_sha: binding.applicationSourceSha,
    event_source_sha: binding.eventSourceSha,
    called_workflow_path: binding.calledWorkflowPath,
    binding_target: binding.bindingTarget,
    binding_mode: binding.mode,
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
    dependency_audit_exception: binding.dependencyAuditException,
    // release 실행에서만 채워진다. 마켓 artifact의 version 정본은 오직 이 태그 파생값이다.
    release_mode: release === null ? "false" : "true",
    release_tag: release?.tag ?? "",
    release_artifact_kind: release === null ? "" : binding.releaseArtifactKind,
    release_version_name: release?.versionName ?? "",
    release_android_version_code: release === null ? "" : String(release.androidVersionCode),
    release_apple_marketing_version: release?.appleMarketingVersion ?? "",
    release_apple_build_number: release === null ? "" : String(release.appleBuildNumber),
    release_authority_revision: release?.authorityRevision ?? "",
    release_config_revision: release?.configRevision ?? "",
    release_binding_digest: release?.bindingDigest ?? "",
  };
  appendFileSync(
    path,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""),
  );
}

/**
 * release 실행이고 경로를 받은 경우에만 binding JSON을 남긴다. 워크플로우는 binding을 앱
 * checkout이 있는 build job에서 다시 만들어 tag receipt까지 대조하므로, 이 파일은 선택 출력이다.
 */
function writeReleaseBinding(path, binding) {
  if (binding.release === null || typeof path !== "string" || path.length === 0) return;
  const { bindingDigest: _digest, ...releaseBinding } = binding.release;
  writeFileSync(path, `${JSON.stringify(releaseBinding, null, 2)}\n`, "utf8");
}

if (import.meta.main) {
  try {
    if (process.env.BINDING_TARGET) {
      if (!BUILD_RUNTIME_TARGETS.includes(process.env.BINDING_TARGET)) {
        fail("BUILD_RUNTIME_TARGET_INVALID");
      }
      const trustedManifestReadback = createBuildManifestReadbackV5();
      const binding = await resolveBuildRuntimeBindingV5(environmentContext(process.env), {
        trustedManifestReadback,
      });
      appendBuildOutputs(process.env.GITHUB_OUTPUT, binding);
      writeReleaseBinding(process.env.RELEASE_BINDING_PATH, binding);
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
