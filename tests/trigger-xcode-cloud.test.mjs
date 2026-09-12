import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  findPrimaryRepositoryId,
  findProductId,
  makeAppStoreConnectToken,
  pickWorkflowId,
  resolveTagReferenceId,
  parseArgs,
} from "../scripts/trigger-xcode-cloud.mjs";

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
