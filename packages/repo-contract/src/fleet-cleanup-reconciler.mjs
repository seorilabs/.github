// Fleet cleanup wave의 중앙 실행 경계다. durable state, CAS reservation, GitHub mutation의
// 소유자는 Backoffice이며 이 저장소는 그 provider를 중복 구현하지 않는다. capability와 그
// approval scope는 Backoffice admin이 미리 ISSUE·persist한 공개 값이고, 여기서는 GitHub
// Actions OIDC로 caller identity를 증명해 기대 digest가 일치하는 capability 하나를 EXECUTE한
// 뒤 receipt를 검증한다. static token과 PAT는 사용하지 않는다.

import { validateFleetCleanupExecutionReceipt } from "./trusted-cleanup-executor.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const NUMERIC_PATTERN = /^[1-9][0-9]{0,15}$/u;
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const PRIVATE_SURFACE_KEY_PATTERN =
  /^(?:authorization|cookie|credentialValue|password|privateKey|rawSecret|secret|secretValue|token)$/iu;
const RESPONSE_BYTE_CAP = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const fleetCleanupReconcilerContract = deepFreeze({
  contract: "seorilabs-fleet-cleanup-reconciler-v1",
  // PLAN_ONLY는 실행 경계를 호출하지 않는다. PREPARE_AND_EXECUTE만 EXECUTE를 부른다.
  modes: ["PLAN_ONLY", "PREPARE_AND_EXECUTE"],
  executionOwner: "BACKOFFICE",
  execute: {
    method: "POST",
    // origin은 공개 고정 상수다. 변수나 입력으로 바꿀 수 없다.
    origin: "https://backoffice.vzyx.xyz",
    route: "/api/internal/fleet-migration/cleanup-capabilities",
    audience: "seorilabs-control-plane",
    operation: "EXECUTE",
    // 응답 봉투는 요청 계약과 다른 이름을 쓴다.
    responseContract: "seorilabs-fleet-cleanup-execution-response-v1",
  },
  caller: {
    organizationId: "283115031",
    installationId: "142120077",
    repositoryId: "1241442018",
    fullName: "seorilabs/.github",
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    visibility: "public",
    runnerClass: "github-hosted",
    callerWorkflowPath: ".github/workflows/fleet-cleanup-reconciler.yml",
    executorWorkflowPath: ".github/workflows/fleet-cleanup-executor-v1.yml",
  },
});

function hasPrivateSurface(value) {
  if (Array.isArray(value)) return value.some(hasPrivateSurface);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      PRIVATE_SURFACE_KEY_PATTERN.test(key) || hasPrivateSurface(child),
  );
}

/**
 * 재실행 idempotency key는 capability와 그 approval scope에서만 파생한다. run이나 attempt를
 * 섞지 않으므로 같은 capability를 다시 실행해도 새 mutation을 만들지 않고 같은 결과를
 * readback한다.
 */
export function fleetCleanupIdempotencyKey({ capabilityId }) {
  return `fleet-cleanup-execute:${capabilityId}`;
}

/**
 * caller identity는 사용자 입력이 아니라 실행 중인 run의 고정 context에서만 만든다.
 * caller가 같은 commit의 local reusable executor를 호출하므로 workflow SHA와 checkout된
 * commit이 같아야 한다. capability와 approval scope digest는 실제로 EXECUTE할 때만 요구한다.
 */
export function verifyFleetCleanupExecuteBinding(binding, mode) {
  const expected = fleetCleanupReconcilerContract.caller;
  if (
    binding === null ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    binding.organizationId !== expected.organizationId ||
    binding.repositoryId !== expected.repositoryId ||
    binding.fullName !== expected.fullName ||
    binding.ref !== expected.ref ||
    binding.event !== expected.event ||
    binding.visibility !== expected.visibility ||
    binding.runnerClass !== expected.runnerClass ||
    binding.callerWorkflowPath !== expected.callerWorkflowPath ||
    binding.executorWorkflowPath !== expected.executorWorkflowPath ||
    !SHA_PATTERN.test(binding.workflowSha ?? "") ||
    !SHA_PATTERN.test(binding.jobWorkflowSha ?? "") ||
    binding.workflowSha !== binding.jobWorkflowSha ||
    !NUMERIC_PATTERN.test(binding.runId ?? "") ||
    !NUMERIC_PATTERN.test(binding.runAttempt ?? "") ||
    hasPrivateSurface(binding)
  ) {
    throw new Error("FLEET_CLEANUP_EXECUTE_BINDING_UNVERIFIED");
  }
  if (
    mode === "PREPARE_AND_EXECUTE" &&
    (!CAPABILITY_ID_PATTERN.test(binding.capabilityId ?? "") ||
      !SHA256_PATTERN.test(binding.approvalScopeDigest ?? ""))
  ) {
    throw new Error("FLEET_CLEANUP_CAPABILITY_SCOPE_UNVERIFIED");
  }
  return deepFreeze(structuredClone(binding));
}

// Backoffice가 고정한 exact body다. caller identity는 body가 아니라 OIDC JWT claim으로
// 증명하고, target scope는 서버 DB에 persist된 capability에서만 파생한다.
// runId는 재실행에도 같은 값이므로 attempt 증가는 readback-first resume이 된다.
function executeRequest(binding) {
  return deepFreeze({
    operation: fleetCleanupReconcilerContract.execute.operation,
    capabilityId: binding.capabilityId,
    approvalScopeDigest: binding.approvalScopeDigest,
    runId: binding.runId,
    runAttempt: binding.runAttempt,
  });
}

// 응답은 크기, redirect, content-type, 시간까지 모두 제한한다.
export async function readGuardedJson(response) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json\b/u.test(contentType)) {
    throw new Error("FLEET_CLEANUP_RESPONSE_CONTENT_TYPE_INVALID");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > RESPONSE_BYTE_CAP) {
    throw new Error("FLEET_CLEANUP_RESPONSE_TOO_LARGE");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("FLEET_CLEANUP_RESPONSE_INVALID");
  }
}

function guardedInit(extra) {
  return {
    ...extra,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

/**
 * GitHub Actions OIDC로 인증하는 Backoffice EXECUTE adapter를 만든다. endpoint origin은
 * 계약 상수이고 입력으로 바꿀 수 없다. OIDC token 요청 경로가 없으면 adapter를 만들지
 * 않으며 static token으로 대체하지 않는다.
 */
export function createBackofficeExecuteAdapter({
  requestOidcToken,
  fetchImpl,
} = {}) {
  if (
    typeof requestOidcToken !== "function" ||
    typeof fetchImpl !== "function"
  ) {
    return undefined;
  }
  const { origin, route, audience, method } =
    fleetCleanupReconcilerContract.execute;
  return async function backofficeExecute(request) {
    const token = await requestOidcToken(audience);
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("FLEET_CLEANUP_OIDC_TOKEN_UNAVAILABLE");
    }
    const response = await fetchImpl(
      `${origin}${route}`,
      guardedInit({
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          // 같은 capability의 재실행은 새 mutation을 만들지 않는다.
          "idempotency-key": fleetCleanupIdempotencyKey(request),
        },
        body: JSON.stringify(request),
      }),
    );
    // 배포되지 않은 route만 transport 사실로 구분한다. 그 밖의 비정상 응답을 임의
    // 상태로 바꾸지 않고, 승인 여부는 서버가 200으로 돌려준 structured state만 인정한다.
    if (response.status === 404 || response.status === 501) {
      return { transport: "ROUTE_NOT_DEPLOYED" };
    }
    if (response.status !== 200) {
      throw new Error("FLEET_CLEANUP_EXECUTE_ADAPTER_FAILED");
    }
    return readGuardedJson(response);
  };
}

const OUTER_RESPONSE_KEYS = Object.freeze([
  "actionScope",
  "approvalScopeDigest",
  "capabilityId",
  "contract",
  "digests",
  "installationId",
  "organizationId",
  "receipt",
  "repository",
  "state",
]);
const RECEIPT_DIGEST_KEYS = Object.freeze([
  "issuanceDigest",
  "inventoryDigest",
  "planDigest",
  "receiptDigest",
]);
const ACTION_SCOPE_KEYS = Object.freeze([
  "chainHeadDigest",
  "fileActionSetDigest",
  "replacementFilesDigest",
]);
// chainHeadDigest는 null을 허용하므로 필수 digest에서 제외한다.
const REQUIRED_ACTION_SCOPE_KEYS = Object.freeze([
  "fileActionSetDigest",
  "replacementFilesDigest",
]);

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    // 양쪽 모두 정렬해 비교한다. 상수 선언 순서에 의존하지 않는다.
    sameJson(Object.keys(value).sort(), [...keys].sort())
  );
}

// outer는 계약이 정한 key 집합과 정확히 같아야 하고, 공개 identity는 caller가 기대한
// capability/scope와 exact 일치해야 한다.
function assertOuterBinding(response, binding) {
  if (
    !exactKeys(response, OUTER_RESPONSE_KEYS) ||
    response.contract !==
      fleetCleanupReconcilerContract.execute.responseContract ||
    response.capabilityId !== binding.capabilityId ||
    response.approvalScopeDigest !== binding.approvalScopeDigest ||
    hasPrivateSurface(response)
  ) {
    throw new Error("FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED");
  }
}

function assertReceiptBinding(response, _binding) {
  const caller = fleetCleanupReconcilerContract.caller;
  const receipt = response.receipt;
  const validation = validateFleetCleanupExecutionReceipt(receipt);
  if (
    !validation.ok ||
    receipt.organizationId !== caller.organizationId ||
    receipt.installationId !== caller.installationId ||
    receipt.pullRequest === null ||
    typeof receipt.pullRequest !== "object" ||
    hasPrivateSurface(receipt)
  ) {
    throw new Error("FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED");
  }
  // outer의 공개 identity와 state는 inner receipt에서만 나와야 한다.
  if (
    response.organizationId !== receipt.organizationId ||
    response.installationId !== receipt.installationId ||
    response.state !== receipt.state ||
    !sameJson(response.repository, receipt.repository) ||
    !exactKeys(response.digests, RECEIPT_DIGEST_KEYS) ||
    RECEIPT_DIGEST_KEYS.some((key) => response.digests[key] !== receipt[key])
  ) {
    throw new Error("FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED");
  }
  // action scope digest는 서버가 persist한 scope에서만 나온다. 형식과 key 집합을 고정하되
  // chainHeadDigest는 chain head가 없는 실행에서 null일 수 있다.
  const actionScope = response.actionScope;
  if (
    !exactKeys(actionScope, ACTION_SCOPE_KEYS) ||
    REQUIRED_ACTION_SCOPE_KEYS.some(
      (key) => !SHA256_PATTERN.test(actionScope[key] ?? ""),
    ) ||
    (actionScope.chainHeadDigest !== null &&
      !SHA256_PATTERN.test(actionScope.chainHeadDigest ?? ""))
  ) {
    throw new Error("FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED");
  }
  return deepFreeze(structuredClone(receipt));
}

/**
 * 사전 ISSUE된 capability를 정확히 한 번 EXECUTE한다. adapter가 없으면 호출하지 않고
 * RUNTIME_NOT_OPERATIONAL로 멈춘다. 실행 성공은 Backoffice receipt가 Ready PR 생성을
 * 증명할 때만 주장한다.
 */
export async function executeFleetCleanupCapability({
  binding,
  mode,
  backofficeExecute,
} = {}) {
  if (!fleetCleanupReconcilerContract.modes.includes(mode)) {
    throw new Error("FLEET_CLEANUP_MODE_NOT_ALLOWED");
  }
  const verified = verifyFleetCleanupExecuteBinding(binding, mode);
  const base = {
    contract: fleetCleanupReconcilerContract.contract,
    mode,
    capabilityId: verified.capabilityId ?? null,
    approvalScopeDigest: verified.approvalScopeDigest ?? null,
    runId: verified.runId,
    runAttempt: verified.runAttempt,
  };
  if (mode === "PLAN_ONLY") {
    return deepFreeze({
      ...base,
      state: "PLAN_ONLY",
      executed: false,
      receipt: null,
    });
  }
  if (typeof backofficeExecute !== "function") {
    return deepFreeze({
      ...base,
      state: "RUNTIME_NOT_OPERATIONAL",
      executed: false,
      receipt: null,
    });
  }
  let response;
  try {
    response = await backofficeExecute(executeRequest(verified));
  } catch {
    // adapter 내부 오류 상세는 공개 경로로 전파하지 않는다.
    throw new Error("FLEET_CLEANUP_EXECUTE_ADAPTER_FAILED");
  }
  if (response?.transport === "ROUTE_NOT_DEPLOYED") {
    return deepFreeze({
      ...base,
      state: "RUNTIME_NOT_OPERATIONAL",
      executed: false,
      receipt: null,
    });
  }
  assertOuterBinding(response, verified);
  // state는 receipt에서만 나온다. receipt 없는 성공 봉투는 인정하지 않는다.
  const receipt = assertReceiptBinding(response, verified);
  return deepFreeze({
    ...base,
    state: receipt.state,
    executed: receipt.state === "READY_PR_CREATED",
    receipt,
  });
}
