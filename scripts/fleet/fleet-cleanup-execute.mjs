#!/usr/bin/env node

// Fleet cleanup EXECUTE 진입점이다. caller identity는 사용자 입력이 아니라 실행 중인 run의
// GitHub context에서만 만들고, 인증은 GitHub Actions OIDC로만 한다. Backoffice endpoint가
// 주입되지 않으면 호출하지 않고 RUNTIME_NOT_OPERATIONAL로 멈춘다. static token과 PAT는
// 사용하지 않으며 이 스크립트는 어떤 provider 상태도 직접 바꾸지 않는다.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBackofficeExecuteAdapter,
  executeFleetCleanupCapability,
  fleetCleanupReconcilerContract,
  readGuardedJson,
} from "../../packages/repo-contract/src/fleet-cleanup-reconciler.mjs";

export function bindingFromEnvironment(environment) {
  const caller = fleetCleanupReconcilerContract.caller;
  return {
    capabilityId: environment.FLEET_CAPABILITY_ID,
    approvalScopeDigest: environment.FLEET_APPROVAL_SCOPE_DIGEST,
    organizationId: environment.FLEET_ORGANIZATION_ID,
    repositoryId: environment.FLEET_REPOSITORY_ID,
    fullName: environment.FLEET_FULL_NAME,
    ref: environment.FLEET_REF,
    event: environment.FLEET_EVENT,
    visibility: environment.FLEET_VISIBILITY,
    // GitHub-hosted runner만 사용한다. 이 값은 입력이 아니라 계약 상수다.
    runnerClass: caller.runnerClass,
    callerWorkflowPath: caller.callerWorkflowPath,
    executorWorkflowPath: caller.executorWorkflowPath,
    workflowSha: environment.FLEET_WORKFLOW_SHA,
    jobWorkflowSha: environment.FLEET_JOB_WORKFLOW_SHA,
    runId: environment.FLEET_RUN_ID,
    runAttempt: environment.FLEET_RUN_ATTEMPT,
  };
}

// GitHub Actions OIDC endpoint만 허용한다. 문자열 이어붙이기 대신 URL parser로 해석해
// scheme, host, userinfo, fragment를 검증하고 audience는 searchParams로만 설정한다.
const ACTIONS_OIDC_HOST = "actions.githubusercontent.com";

export function resolveActionsOidcEndpoint(rawUrl, audience) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("FLEET_CLEANUP_OIDC_ENDPOINT_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.hostname !== ACTIONS_OIDC_HOST &&
      !url.hostname.endsWith(`.${ACTIONS_OIDC_HOST}`)) ||
    !url.pathname.startsWith("/") ||
    // URL parser는 ..를 조용히 정규화하므로 원본 문자열에서 먼저 거부한다.
    /(?:^|\/)\.\.(?:\/|$)/u.test(rawUrl.split("?")[0])
  ) {
    throw new Error("FLEET_CLEANUP_OIDC_ENDPOINT_INVALID");
  }
  url.searchParams.set("audience", audience);
  return url;
}

export function createActionsOidcTokenRequest(environment, fetchImpl) {
  const rawUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (
    typeof rawUrl !== "string" ||
    typeof requestToken !== "string" ||
    rawUrl.length === 0 ||
    requestToken.length === 0 ||
    typeof fetchImpl !== "function"
  ) {
    return undefined;
  }
  return async function requestOidcToken(audience) {
    // OIDC 요청에도 EXECUTE와 같은 방어를 적용한다.
    const endpoint = resolveActionsOidcEndpoint(rawUrl, audience);
    const response = await fetchImpl(endpoint.toString(), {
      headers: {
        authorization: `Bearer ${requestToken}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) {
      throw new Error("FLEET_CLEANUP_OIDC_TOKEN_UNAVAILABLE");
    }
    const body = await readGuardedJson(response);
    if (typeof body.value !== "string" || body.value.length === 0) {
      throw new Error("FLEET_CLEANUP_OIDC_TOKEN_UNAVAILABLE");
    }
    return body.value;
  };
}

export async function runFleetCleanupExecute({ environment, fetchImpl }) {
  const requestOidcToken = createActionsOidcTokenRequest(
    environment,
    fetchImpl,
  );
  // endpoint origin은 계약 상수다. 환경 변수로 바꿀 수 없다.
  const backofficeExecute = createBackofficeExecuteAdapter({
    requestOidcToken,
    fetchImpl,
  });
  return executeFleetCleanupCapability({
    binding: bindingFromEnvironment(environment),
    mode: environment.FLEET_MODE,
    backofficeExecute,
  });
}

function isEntrypoint() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const report = await runFleetCleanupExecute({
    environment: process.env,
    fetchImpl: globalThis.fetch,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // PLAN_ONLY는 실행하지 않는 것이 정상 결과다.
  process.exit(report.state === "PLAN_ONLY" || report.executed ? 0 : 1);
}
