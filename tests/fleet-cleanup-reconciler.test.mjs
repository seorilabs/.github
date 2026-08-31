import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { parse } from "yaml";

import {
  createBackofficeExecuteAdapter,
  executeFleetCleanupCapability,
  fleetCleanupIdempotencyKey,
  fleetCleanupReconcilerContract,
  verifyFleetCleanupExecuteBinding,
} from "../packages/repo-contract/src/fleet-cleanup-reconciler.mjs";
import { createTrustedFleetCleanupExecutor } from "../packages/repo-contract/src/trusted-cleanup-executor.mjs";
import {
  bindingFromEnvironment,
  createActionsOidcTokenRequest,
  resolveActionsOidcEndpoint,
  runFleetCleanupExecute,
} from "../scripts/fleet/fleet-cleanup-execute.mjs";
import {
  INSTALLATION_ID,
  ORGANIZATION_ID,
  cleanupExecutionRequest,
  makeAuthoritativeCleanupFixture,
  makeCleanupGitHubProvider,
  makeCleanupStateProvider,
} from "./helpers/fleet-cleanup-executor-fixtures.mjs";

const CALLER = fleetCleanupReconcilerContract.caller;
const COMMIT_SHA = "a".repeat(40);
const CAPABILITY_ID = "fleet-cleanup-capability-20260831-0001";
const SCOPE_DIGEST = `sha256:${"c".repeat(64)}`;
const OIDC_URL =
  "https://run-actions-1-azure-eastus.actions.githubusercontent.com/abc/token?api-version=2.0";

function environment(overrides = {}) {
  return {
    FLEET_MODE: "PREPARE_AND_EXECUTE",
    FLEET_CAPABILITY_ID: CAPABILITY_ID,
    FLEET_APPROVAL_SCOPE_DIGEST: SCOPE_DIGEST,
    FLEET_ORGANIZATION_ID: CALLER.organizationId,
    FLEET_REPOSITORY_ID: CALLER.repositoryId,
    FLEET_FULL_NAME: CALLER.fullName,
    FLEET_REF: CALLER.ref,
    FLEET_EVENT: CALLER.event,
    FLEET_VISIBILITY: CALLER.visibility,
    FLEET_WORKFLOW_SHA: COMMIT_SHA,
    FLEET_JOB_WORKFLOW_SHA: COMMIT_SHA,
    FLEET_RUN_ID: "33281591098",
    FLEET_RUN_ATTEMPT: "1",
    ...overrides,
  };
}

// receipt는 손으로 만들지 않는다. 실제 trusted executor가 만든 값을 그대로 쓴다.
let GENUINE_RECEIPT;

before(async () => {
  const base = await makeAuthoritativeCleanupFixture({ count: 38 });
  const repository = base.plan.repositories.find(
    ({ classification, changes }) =>
      classification === "PRODUCT_APP" && changes.length > 0,
  );
  const clock = () => base.executionNowMs;
  const github = makeCleanupGitHubProvider({
    plan: base.plan,
    issuance: base.issuance,
    repositoryId: repository.repositoryId,
    now: clock,
  });
  const durable = makeCleanupStateProvider({ now: clock });
  const executor = createTrustedFleetCleanupExecutor({
    organizationId: ORGANIZATION_ID,
    installationId: INSTALLATION_ID,
    inventoryPublicKey: base.keys.publicKey,
    githubAdapter: github.adapter,
    stateStore: durable.store,
    clock,
  });
  GENUINE_RECEIPT = await executor.execute(
    base.issuance,
    base.plan,
    cleanupExecutionRequest(repository.repositoryId),
  );
});

function receiptFixture() {
  return structuredClone(GENUINE_RECEIPT);
}

function outerFixture(overrides = {}) {
  const receipt = receiptFixture();
  return {
    contract: fleetCleanupReconcilerContract.execute.responseContract,
    state: receipt.state,
    capabilityId: CAPABILITY_ID,
    approvalScopeDigest: SCOPE_DIGEST,
    organizationId: receipt.organizationId,
    installationId: receipt.installationId,
    repository: structuredClone(receipt.repository),
    digests: {
      issuanceDigest: receipt.issuanceDigest,
      inventoryDigest: receipt.inventoryDigest,
      planDigest: receipt.planDigest,
      receiptDigest: receipt.receiptDigest,
    },
    actionScope: {
      chainHeadDigest: `sha256:${"a".repeat(64)}`,
      fileActionSetDigest: `sha256:${"b".repeat(64)}`,
      replacementFilesDigest: `sha256:${"c".repeat(64)}`,
    },
    receipt,
    ...overrides,
  };
}

async function execute(response, overrides = {}) {
  return executeFleetCleanupCapability({
    binding: bindingFromEnvironment(environment(overrides)),
    mode: "PREPARE_AND_EXECUTE",
    backofficeExecute: async () => response,
  });
}

test("caller binding은 계약 identity와 같은 commit executor일 때만 통과한다", () => {
  const binding = bindingFromEnvironment(environment());
  assert.deepEqual(
    verifyFleetCleanupExecuteBinding(binding, "PREPARE_AND_EXECUTE"),
    binding,
  );
  for (const overrides of [
    { FLEET_ORGANIZATION_ID: "1" },
    { FLEET_REPOSITORY_ID: "999" },
    { FLEET_FULL_NAME: "seorilabs/attacker" },
    { FLEET_REF: "refs/heads/attacker" },
    { FLEET_EVENT: "pull_request" },
    { FLEET_VISIBILITY: "private" },
    { FLEET_RUN_ID: "0" },
    { FLEET_RUN_ATTEMPT: "x" },
    // 다른 commit의 reusable executor가 실행되면 두 SHA가 달라진다.
    { FLEET_JOB_WORKFLOW_SHA: "b".repeat(40) },
    { FLEET_WORKFLOW_SHA: "main" },
  ]) {
    assert.throws(
      () =>
        verifyFleetCleanupExecuteBinding(
          bindingFromEnvironment(environment(overrides)),
          "PREPARE_AND_EXECUTE",
        ),
      /FLEET_CLEANUP_EXECUTE_BINDING_UNVERIFIED/u,
      JSON.stringify(overrides),
    );
  }
});

test("capability와 scope digest는 EXECUTE에서만 요구한다", () => {
  const withoutCapability = environment({
    FLEET_CAPABILITY_ID: "",
    FLEET_APPROVAL_SCOPE_DIGEST: "",
  });
  // PLAN_ONLY는 capability 없이도 통과한다.
  assert.doesNotThrow(() =>
    verifyFleetCleanupExecuteBinding(
      bindingFromEnvironment(withoutCapability),
      "PLAN_ONLY",
    ),
  );
  for (const overrides of [
    { FLEET_CAPABILITY_ID: "" },
    { FLEET_CAPABILITY_ID: "short" },
    { FLEET_APPROVAL_SCOPE_DIGEST: "" },
    { FLEET_APPROVAL_SCOPE_DIGEST: "not-a-digest" },
  ]) {
    assert.throws(
      () =>
        verifyFleetCleanupExecuteBinding(
          bindingFromEnvironment(environment(overrides)),
          "PREPARE_AND_EXECUTE",
        ),
      /FLEET_CLEANUP_CAPABILITY_SCOPE_UNVERIFIED/u,
      JSON.stringify(overrides),
    );
  }
});

test("PLAN_ONLY는 실행 경계를 호출하지 않는다", async () => {
  let calls = 0;
  const result = await executeFleetCleanupCapability({
    binding: bindingFromEnvironment(
      environment({ FLEET_CAPABILITY_ID: "", FLEET_APPROVAL_SCOPE_DIGEST: "" }),
    ),
    mode: "PLAN_ONLY",
    backofficeExecute: async () => {
      calls += 1;
      return {};
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.state, "PLAN_ONLY");
  assert.equal(result.executed, false);
});

test("허용되지 않은 mode는 거부한다", async () => {
  await assert.rejects(
    executeFleetCleanupCapability({
      binding: bindingFromEnvironment(environment()),
      mode: "APPLY",
    }),
    /FLEET_CLEANUP_MODE_NOT_ALLOWED/u,
  );
});

test("OIDC 경로가 없으면 호출하지 않고 RUNTIME_NOT_OPERATIONAL로 멈춘다", async () => {
  const report = await runFleetCleanupExecute({
    environment: environment(),
    fetchImpl: () => {
      throw new Error("network must not be used");
    },
  });
  assert.equal(report.state, "RUNTIME_NOT_OPERATIONAL");
  assert.equal(report.executed, false);
  assert.equal(report.capabilityId, CAPABILITY_ID);
});

test("EXECUTE는 고정 origin에 계약 body와 안정적 Idempotency-Key로 한 번 POST한다", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    const headers = new Map([["content-type", "application/json"]]);
    const json = url.includes(".actions.githubusercontent.com")
      ? { value: "oidc-jwt" }
      : outerFixture();
    return {
      status: 200,
      headers: { get: (key) => headers.get(key) ?? null },
      text: async () => JSON.stringify(json),
    };
  };
  const report = await runFleetCleanupExecute({
    environment: environment({
      ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      // endpoint를 바꾸려는 입력은 무시돼야 한다.
      FLEET_BACKOFFICE_ORIGIN: "https://attacker.example",
    }),
    fetchImpl,
  });

  assert.match(requests[0].url, /[?&]audience=seorilabs-control-plane\b/u);
  assert.ok(requests[0].url.startsWith("https://run-actions-1-azure-eastus."));
  assert.equal(requests[0].init.redirect, "error");
  const executeCall = requests[1];
  assert.equal(
    executeCall.url,
    "https://backoffice.vzyx.xyz/api/internal/fleet-migration/cleanup-capabilities",
  );
  assert.equal(executeCall.init.method, "POST");
  assert.equal(executeCall.init.redirect, "error");
  assert.ok(executeCall.init.signal instanceof AbortSignal);
  assert.equal(executeCall.init.headers.authorization, "Bearer oidc-jwt");
  assert.equal(
    executeCall.init.headers["idempotency-key"],
    `fleet-cleanup-execute:${CAPABILITY_ID}`,
  );
  // body는 계약이 고정한 다섯 field만 보낸다.
  const body = JSON.parse(executeCall.init.body);
  assert.deepEqual(Object.keys(body).sort(), [
    "approvalScopeDigest",
    "capabilityId",
    "operation",
    "runAttempt",
    "runId",
  ]);
  assert.equal(body.operation, "EXECUTE");
  assert.equal(body.capabilityId, CAPABILITY_ID);
  assert.equal(body.approvalScopeDigest, SCOPE_DIGEST);
  assert.equal(requests.filter(({ init }) => init.method === "POST").length, 1);
  assert.equal(report.state, "READY_PR_CREATED");
  assert.equal(report.executed, true);
});

test("재실행 idempotency key는 attempt가 아니라 capability에만 의존한다", () => {
  assert.equal(
    fleetCleanupIdempotencyKey({ capabilityId: CAPABILITY_ID }),
    `fleet-cleanup-execute:${CAPABILITY_ID}`,
  );
  assert.equal(
    fleetCleanupIdempotencyKey({
      capabilityId: CAPABILITY_ID,
      approvalScopeDigest: SCOPE_DIGEST,
    }),
    fleetCleanupIdempotencyKey({ capabilityId: CAPABILITY_ID }),
  );
});

test("배포되지 않은 route만 상태로 구분하고 다른 비정상 응답은 실패시킨다", async () => {
  const adapterFor = (status) =>
    createBackofficeExecuteAdapter({
      requestOidcToken: async () => "oidc-jwt",
      fetchImpl: async () => ({
        status,
        headers: { get: () => "application/json" },
        text: async () => "{}",
      }),
    });
  for (const status of [404, 501]) {
    const result = await executeFleetCleanupCapability({
      binding: bindingFromEnvironment(environment()),
      mode: "PREPARE_AND_EXECUTE",
      backofficeExecute: adapterFor(status),
    });
    assert.equal(result.state, "RUNTIME_NOT_OPERATIONAL", String(status));
    assert.equal(result.executed, false);
  }
  // 401/403을 임의 승인 상태로 바꾸지 않는다.
  for (const status of [401, 403, 500, 302]) {
    await assert.rejects(
      executeFleetCleanupCapability({
        binding: bindingFromEnvironment(environment()),
        mode: "PREPARE_AND_EXECUTE",
        backofficeExecute: adapterFor(status),
      }),
      /FLEET_CLEANUP_EXECUTE_ADAPTER_FAILED/u,
      String(status),
    );
  }
});

test("outer response는 계약 key 집합과 공개 identity가 정확히 일치해야 한다", async () => {
  for (const overrides of [
    { contract: "seorilabs-fleet-cleanup-reconciler-v1" },
    { capabilityId: "fleet-cleanup-capability-other-0001" },
    { approvalScopeDigest: `sha256:${"9".repeat(64)}` },
    { organizationId: "1" },
    { installationId: "1" },
    // key 하나만 빠져도 거부한다.
    { digests: undefined },
  ]) {
    const response = outerFixture(overrides);
    if (overrides.digests === undefined && "digests" in overrides) {
      delete response.digests;
    }
    await assert.rejects(
      execute(response),
      /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
      JSON.stringify(Object.keys(overrides)),
    );
  }
});

test("outer digests와 repository는 inner receipt와 exact 비교한다", async () => {
  const wrongDigest = outerFixture();
  wrongDigest.digests.planDigest = `sha256:${"8".repeat(64)}`;
  await assert.rejects(
    execute(wrongDigest),
    /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
  );

  const wrongRepository = outerFixture();
  wrongRepository.repository = {
    ...wrongRepository.repository,
    fullName: "seorilabs/other-app",
  };
  await assert.rejects(
    execute(wrongRepository),
    /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
  );

  const wrongInstallation = outerFixture();
  wrongInstallation.receipt.installationId = "1";
  await assert.rejects(
    execute(wrongInstallation),
    /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
  );
});

test("state와 공개 identity는 inner receipt에서만 나와야 한다", async () => {
  const wrongState = outerFixture();
  wrongState.state = "HUMAN_APPROVAL_REQUIRED";
  await assert.rejects(
    execute(wrongState),
    /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
  );

  for (const field of ["organizationId", "installationId"]) {
    const drifted = outerFixture();
    drifted[field] = "1";
    await assert.rejects(
      execute(drifted),
      /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
      field,
    );
  }

  // receipt 없는 성공 봉투는 인정하지 않는다.
  await assert.rejects(
    execute(outerFixture({ receipt: null })),
    /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
  );
});

test("actionScope는 계약 key 집합과 digest 형식을 정확히 지켜야 한다", async () => {
  const missingKey = outerFixture();
  delete missingKey.actionScope.chainHeadDigest;
  await assert.rejects(
    execute(missingKey),
    /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
  );

  const extraKey = outerFixture();
  extraKey.actionScope.extraDigest = `sha256:${"d".repeat(64)}`;
  await assert.rejects(
    execute(extraKey),
    /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
  );

  for (const key of ["fileActionSetDigest", "replacementFilesDigest"]) {
    for (const value of ["not-a-digest", null, undefined]) {
      const badFormat = outerFixture();
      badFormat.actionScope[key] = value;
      await assert.rejects(
        execute(badFormat),
        /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
        `${key}=${String(value)}`,
      );
    }
  }
});

test("chainHeadDigest는 null을 허용하고 잘못된 형식만 거부한다", async () => {
  // chain head가 없는 실행은 null을 보낸다.
  const nullChainHead = outerFixture();
  nullChainHead.actionScope.chainHeadDigest = null;
  const result = await execute(nullChainHead);
  assert.equal(result.state, "READY_PR_CREATED");
  assert.equal(result.executed, true);

  for (const value of ["not-a-digest", "", `sha256:${"z".repeat(64)}`, 1]) {
    const invalid = outerFixture();
    invalid.actionScope.chainHeadDigest = value;
    await assert.rejects(
      execute(invalid),
      /FLEET_CLEANUP_EXECUTION_RECEIPT_UNVERIFIED/u,
      String(value),
    );
  }
});

test("응답은 JSON content-type과 크기 상한을 강제한다", async () => {
  const adapter = (contentType, text) =>
    createBackofficeExecuteAdapter({
      requestOidcToken: async () => "oidc-jwt",
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => contentType },
        text: async () => text,
      }),
    });
  for (const [contentType, text] of [
    ["text/html", "{}"],
    ["application/json", "not json"],
    ["application/json", `{"padding":"${"x".repeat(300 * 1024)}"}`],
  ]) {
    await assert.rejects(
      executeFleetCleanupCapability({
        binding: bindingFromEnvironment(environment()),
        mode: "PREPARE_AND_EXECUTE",
        backofficeExecute: adapter(contentType, text),
      }),
      /FLEET_CLEANUP_EXECUTE_ADAPTER_FAILED/u,
      contentType,
    );
  }
});

test("OIDC 요청 경로가 없으면 token을 만들지 않는다", () => {
  assert.equal(createActionsOidcTokenRequest({}, async () => ({})), undefined);
  assert.equal(
    createBackofficeExecuteAdapter({
      requestOidcToken: undefined,
      fetchImpl: async () => ({}),
    }),
    undefined,
  );
});

test("caller는 같은 commit의 local reusable executor만 호출한다", async () => {
  const callerSource = await readFile(
    new URL("../.github/workflows/fleet-cleanup-reconciler.yml", import.meta.url),
    "utf8",
  );
  const caller = parse(callerSource);
  assert.deepEqual(Object.keys(caller.on), ["workflow_dispatch"]);
  assert.deepEqual(caller.on.workflow_dispatch.inputs.mode.options, [
    "PLAN_ONLY",
    "PREPARE_AND_EXECUTE",
  ]);
  assert.equal(
    caller.jobs.execute.uses,
    "./.github/workflows/fleet-cleanup-executor-v1.yml",
  );
  assert.equal(caller.jobs.execute.secrets, undefined);
  assert.equal(caller.concurrency["cancel-in-progress"], false);
  assert.doesNotMatch(callerSource, /\bsecrets\.[A-Z]/u);

  const executorSource = await readFile(
    new URL("../.github/workflows/fleet-cleanup-executor-v1.yml", import.meta.url),
    "utf8",
  );
  const executor = parse(executorSource);
  assert.deepEqual(Object.keys(executor.on), ["workflow_call"]);
  assert.equal(executor.jobs.execute["runs-on"], "ubuntu-latest");
  assert.equal(executor.jobs.execute.permissions["id-token"], "write");
  assert.doesNotMatch(executorSource, /seorilabs-rpi/u);
  assert.doesNotMatch(executorSource, /\bsecrets\.[A-Z]/u);
  assert.doesNotMatch(executorSource, /\bsecrets:\s*inherit\b/u);
  // endpoint는 계약 상수이므로 변수 의존성을 만들지 않는다.
  assert.doesNotMatch(executorSource, /FLEET_BACKOFFICE_ORIGIN/u);
  for (const step of executor.jobs.execute.steps) {
    if (step.uses === undefined) continue;
    assert.match(step.uses, /^actions\/[a-z-]+@[0-9a-f]{40}$/u);
  }
});

test("이 저장소는 durable state provider나 static token을 소유하지 않는다", async () => {
  const source = await readFile(
    new URL(
      "../packages/repo-contract/src/fleet-cleanup-reconciler.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(fleetCleanupReconcilerContract.executionOwner, "BACKOFFICE");
  assert.equal(
    fleetCleanupReconcilerContract.execute.origin,
    "https://backoffice.vzyx.xyz",
  );
  assert.doesNotMatch(source, /GITHUB_TOKEN|GH_TOKEN|process\.env/u);
  const script = await readFile(
    new URL("../scripts/fleet/fleet-cleanup-execute.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(script, /GITHUB_TOKEN|GH_TOKEN|ghp_/u);
});

test("OIDC endpoint는 URL parser로 검증하고 audience를 query로만 설정한다", () => {
  const resolved = resolveActionsOidcEndpoint(OIDC_URL, "seorilabs-control-plane");
  assert.equal(resolved.protocol, "https:");
  assert.equal(
    resolved.searchParams.get("audience"),
    "seorilabs-control-plane",
  );
  // 기존 query는 보존하고 audience는 중복 없이 하나만 남는다.
  assert.equal(resolved.searchParams.get("api-version"), "2.0");
  assert.equal(resolved.searchParams.getAll("audience").length, 1);

  // 이미 audience가 있어도 덮어쓴다.
  const overridden = resolveActionsOidcEndpoint(
    `${OIDC_URL}&audience=attacker`,
    "seorilabs-control-plane",
  );
  assert.deepEqual(overridden.searchParams.getAll("audience"), [
    "seorilabs-control-plane",
  ]);
});

test("허용되지 않은 OIDC endpoint는 token 요청 전에 차단한다", () => {
  for (const rawUrl of [
    // http
    "http://run-actions-1.actions.githubusercontent.com/abc/token",
    // 다른 host
    "https://attacker.example/abc/token",
    // suffix 흉내
    "https://actions.githubusercontent.com.attacker.example/abc/token",
    // userinfo
    "https://user:pass@run-actions-1.actions.githubusercontent.com/abc/token",
    "https://attacker@actions.githubusercontent.com/abc/token",
    // fragment
    "https://actions.githubusercontent.com/abc/token#fragment",
    // traversal
    "https://actions.githubusercontent.com/abc/../../token",
    // 파싱 불가
    "not-a-url",
  ]) {
    assert.throws(
      () => resolveActionsOidcEndpoint(rawUrl, "seorilabs-control-plane"),
      /FLEET_CLEANUP_OIDC_ENDPOINT_INVALID/u,
      rawUrl,
    );
  }
});

test("OIDC 요청은 redirect를 따르지 않고 token은 보고서에 직렬화되지 않는다", async () => {
  let oidcInit;
  const fetchImpl = async (url, init = {}) => {
    const headers = new Map([["content-type", "application/json"]]);
    if (url.includes(".actions.githubusercontent.com")) {
      oidcInit = init;
      return {
        status: 200,
        headers: { get: (key) => headers.get(key) ?? null },
        text: async () => JSON.stringify({ value: "super-secret-oidc-jwt" }),
      };
    }
    return {
      status: 200,
      headers: { get: (key) => headers.get(key) ?? null },
      text: async () => JSON.stringify(outerFixture()),
    };
  };
  const report = await runFleetCleanupExecute({
    environment: environment({
      ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    }),
    fetchImpl,
  });
  assert.equal(oidcInit.redirect, "error");
  assert.ok(oidcInit.signal instanceof AbortSignal);
  assert.equal(oidcInit.headers.accept, "application/json");

  // 보고서와 artifact에 token이나 Authorization이 남지 않는다.
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /super-secret-oidc-jwt/u);
  assert.doesNotMatch(serialized, /request-token/u);
  assert.doesNotMatch(serialized, /[Aa]uthorization/u);
  assert.doesNotMatch(serialized, /Bearer /u);
});
