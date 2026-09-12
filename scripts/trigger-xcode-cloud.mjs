#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const API_BASE = "https://api.appstoreconnect.apple.com";

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function makeAppStoreConnectToken({
  keyId,
  issuerId,
  privateKeyBase64,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: issuerId,
      iat: nowSeconds,
      exp: nowSeconds + 15 * 60,
      aud: "appstoreconnect-v1",
    }),
  );
  const signingInput = `${header}.${payload}`;
  const decoded = Buffer.from(privateKeyBase64, "base64").toString("utf8");
  const privateKey = decoded.includes("BEGIN PRIVATE KEY")
    ? decoded
    : privateKeyBase64.replaceAll("\\n", "\n");
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function findProductId(document, bundleId) {
  const apps = asArray(document.included).filter((item) => item.type === "apps");
  const product = asArray(document.data).find((item) => {
    const appId = item.relationships?.app?.data?.id;
    const app = apps.find((candidate) => candidate.id === appId);
    return app?.attributes?.bundleId === bundleId;
  });
  if (!product?.id) {
    throw new Error(`Xcode Cloud 제품 없음(bundleId=${bundleId})`);
  }
  return product.id;
}

export function pickWorkflowId(document, preferredName) {
  const workflows = asArray(document.data);
  const preferred = preferredName
    ? workflows.find(
        (item) =>
          item.attributes?.name === preferredName && item.attributes?.isEnabled === true,
      )
    : null;
  const chosen =
    preferred ??
    workflows.find((item) => item.attributes?.isEnabled === true) ??
    workflows[0];
  if (!chosen?.id) {
    throw new Error("Xcode Cloud 워크플로 없음");
  }
  return chosen.id;
}

export function findPrimaryRepositoryId(document) {
  const repository = asArray(document.data)[0];
  if (!repository?.id) {
    throw new Error("Xcode Cloud primary repository 없음");
  }
  return repository.id;
}

export function resolveTagReferenceId(document, tag) {
  const reference = asArray(document.data).find(
    (item) => item.attributes?.kind === "TAG" && item.attributes?.name === tag,
  );
  if (!reference?.id) {
    throw new Error(`태그 ref가 Xcode Cloud에 아직 동기화되지 않음: ${tag}`);
  }
  return reference.id;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }
  return value;
}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) {
      throw new Error(`잘못된 인자: ${key ?? ""}`);
    }
    values.set(key, value);
  }
  const tag = values.get("--tag") ?? "";
  const bundleId = values.get("--bundle-id") ?? "";
  const workflowName = values.get("--workflow-name") ?? "";
  // 빌드를 실제로 시작하지 않고 제품·workflow·태그 ref 해석까지만 한다. 배선을 바꾼 뒤
  // 진짜 빌드를 태우지 않고 확인할 수 있어야 한다.
  const start = (values.get("--start") ?? "true") !== "false";
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    throw new Error(`release tag는 vX.Y.Z 형식이어야 합니다: ${tag || "empty"}`);
  }
  if (!bundleId) {
    throw new Error("--bundle-id가 필요합니다.");
  }
  return { tag, bundleId, workflowName, start };
}

async function appStoreConnect(path, token, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const document = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const first = asArray(document.errors)[0];
    const detail = first?.detail ?? first?.title ?? response.statusText;
    throw new Error(`App Store Connect API ${response.status}: ${detail}`);
  }
  return document;
}

async function main() {
  const { tag, bundleId, workflowName, start } = parseArgs(process.argv.slice(2));
  const token = makeAppStoreConnectToken({
    keyId: requiredEnv("APP_STORE_CONNECT_API_KEY_ID"),
    issuerId: requiredEnv("APP_STORE_CONNECT_ISSUER_ID"),
    privateKeyBase64: requiredEnv("APP_STORE_CONNECT_PRIVATE_KEY_BASE64"),
  });

  const products = await appStoreConnect("/v1/ciProducts?include=app&limit=200", token);
  const productId = findProductId(products, bundleId);
  const [workflows, repositories] = await Promise.all([
    appStoreConnect(`/v1/ciProducts/${productId}/workflows?limit=200`, token),
    appStoreConnect(`/v1/ciProducts/${productId}/primaryRepositories?limit=10`, token),
  ]);
  const workflowId = pickWorkflowId(workflows, workflowName);
  const repositoryId = findPrimaryRepositoryId(repositories);
  const references = await appStoreConnect(
    `/v1/scmRepositories/${repositoryId}/gitReferences?limit=200`,
    token,
  );
  const referenceId = resolveTagReferenceId(references, tag);

  let buildRun = null;
  if (start) {
    const run = await appStoreConnect("/v1/ciBuildRuns", token, {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "ciBuildRuns",
          relationships: {
            workflow: { data: { type: "ciWorkflows", id: workflowId } },
            sourceBranchOrTag: { data: { type: "scmGitReferences", id: referenceId } },
          },
        },
      }),
    });
    buildRun = asArray(run.data)[0] ?? null;
    if (!buildRun?.id) {
      throw new Error("Xcode Cloud 빌드 실행 ID가 없습니다.");
    }
  }
  const buildNumber =
    typeof buildRun?.attributes?.number === "number" ? buildRun.attributes.number : "";
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `xcode_cloud_build_run_id=${buildRun?.id ?? ""}\n` +
        `xcode_cloud_build_number=${buildNumber}\n` +
        `xcode_cloud_product_id=${productId}\n` +
        `xcode_cloud_workflow_id=${workflowId}\n` +
        `xcode_cloud_started=${String(start)}\n`,
    );
  }
  console.log(
    start
      ? `Xcode Cloud 빌드 트리거 완료: tag=${tag}, build=${buildNumber || "pending"}`
      : `Xcode Cloud 배선 확인 완료(빌드 미시작): tag=${tag}, product=${productId}, workflow=${workflowId}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
