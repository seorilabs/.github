import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import {
  findPrimaryRepositoryId,
  findProductId,
  makeAppStoreConnectToken,
  pickWorkflowId,
  resolveTagReferenceId,
  parseArgs,
} from "../scripts/trigger-xcode-cloud.mjs";

test("Xcode 트리거는 실제 중앙 workflow SHA를 검증한 뒤 같은 script를 checkout한다", (t) => {
  const workflow = parse(readFileSync(".github/workflows/app-store-xcode-cloud.yml", "utf8"));
  const steps = workflow.jobs.trigger.steps;
  const identity = steps.find((step) => step.id === "workflow-identity");
  const setup = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  const checkout = steps.find((step) => step.name === "Checkout org scripts");
  assert.ok(steps.indexOf(setup) < steps.indexOf(identity));
  assert.ok(steps.indexOf(identity) < steps.indexOf(checkout));
  assert.equal(identity.env.JOB_CONTEXT_JSON, "${{ toJSON(job) }}");
  assert.equal(checkout.with.repository, "${{ steps.workflow-identity.outputs.repository }}");
  assert.equal(checkout.with.ref, "${{ steps.workflow-identity.outputs.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);

  const root = mkdtempSync(join(tmpdir(), "xcode-workflow-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "output");
  const sha = "a".repeat(40);
  const exact = {
    workflow_repository: "seorilabs/.github",
    workflow_sha: sha,
    workflow_ref: `seorilabs/.github/.github/workflows/app-store-xcode-cloud.yml@${sha}`,
  };
  const run = (context) => spawnSync("bash", ["-euo", "pipefail", "-c", identity.run], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, JOB_CONTEXT_JSON: JSON.stringify(context), GITHUB_OUTPUT: output },
  });
  const valid = run(exact);
  assert.equal(valid.status, 0, valid.stderr);
  const expectedOutput = `repository=seorilabs/.github\nsha=${sha}\n`;
  assert.equal(readFileSync(output, "utf8"), expectedOutput);
  for (const context of [
    {},
    { ...exact, workflow_repository: "attacker/fork" },
    { ...exact, workflow_sha: "main" },
    { ...exact, workflow_ref: `${exact.workflow_ref}-changed` },
    { ...exact, workflow_sha: "b".repeat(40) },
  ]) {
    assert.notEqual(run(context).status, 0, JSON.stringify(context));
    assert.equal(readFileSync(output, "utf8"), expectedOutput);
  }
});

test("bundle ID로 Xcode Cloud 제품을 찾는다", () => {
  const document = {
    data: [
      {
        id: "product-1",
        relationships: { app: { data: { id: "app-1" } } },
      },
    ],
    included: [
      {
        type: "apps",
        id: "app-1",
        attributes: { bundleId: "com.etlegame.chess" },
      },
    ],
  };
  assert.equal(findProductId(document, "com.etlegame.chess"), "product-1");
  assert.throws(() => findProductId(document, "com.example.missing"), /제품 없음/);
});

test("이름이 일치하는 활성 워크플로를 우선한다", () => {
  const document = {
    data: [
      { id: "other", attributes: { name: "Other", isEnabled: true } },
      {
        id: "release",
        attributes: { name: "Lucid Chess Release", isEnabled: true },
      },
    ],
  };
  assert.equal(pickWorkflowId(document, "Lucid Chess Release"), "release");
});

test("primary repository와 tag reference를 결정한다", () => {
  assert.equal(findPrimaryRepositoryId({ data: [{ id: "repo-1" }] }), "repo-1");
  assert.equal(
    resolveTagReferenceId(
      {
        data: [
          { id: "branch", attributes: { kind: "BRANCH", name: "main" } },
          { id: "tag", attributes: { kind: "TAG", name: "v1.2.3" } },
        ],
      },
      "v1.2.3",
    ),
    "tag",
  );
});

test("App Store Connect ES256 JWT를 생성한다", () => {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const token = makeAppStoreConnectToken({
    keyId: "KEY123",
    issuerId: "issuer-123",
    privateKeyBase64: Buffer.from(pem).toString("base64"),
    nowSeconds: 1_700_000_000,
  });
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "ES256",
    kid: "KEY123",
    typ: "JWT",
  });
  assert.equal(
    JSON.parse(Buffer.from(payload, "base64url").toString()).aud,
    "appstoreconnect-v1",
  );
  assert.equal(Buffer.from(signature, "base64url").length, 64);
});

test("--start=false는 빌드를 시작하지 않는 확인 전용 모드다", () => {
  // 배선을 바꾼 뒤 진짜 빌드를 태우지 않고 제품·workflow·태그 해석까지만 확인할 수 있어야
  // 한다. 기본값은 종전 동작 그대로 시작이다.
  assert.equal(parseArgs(["--tag", "v1.2.3", "--bundle-id", "com.example.app"]).start, true);
  assert.equal(
    parseArgs(["--tag", "v1.2.3", "--bundle-id", "com.example.app", "--start", "false"]).start,
    false,
  );
  assert.equal(
    parseArgs(["--tag", "v1.2.3", "--bundle-id", "com.example.app", "--start", "true"]).start,
    true,
  );
});
