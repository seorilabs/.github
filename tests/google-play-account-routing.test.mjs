import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(
  await readFile(resolve(ROOT, "contracts/google-play-account-routing.schema.json"), "utf8"),
);
const policyText = await readFile(
  resolve(ROOT, "contracts/google-play-account-routing.yaml"),
  "utf8",
);
const document = parseDocument(policyText, { strict: true, uniqueKeys: true });
assert.deepEqual(document.errors, []);
const policy = document.toJS();

function role(id) {
  return policy.accountRoles.find((account) => account.role === id);
}

test("Google Play 계정 라우팅 계약은 strict schema를 통과한다", () => {
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(policy), true, JSON.stringify(validate.errors));
});

test("신규 앱과 Play 결제는 한국 개인 기본 역할로만 라우팅한다", () => {
  assert.equal(policy.defaultNewAppRole, "primary-korea-personal");
  assert.equal(policy.routing.newApps, "primary-korea-personal");
  assert.equal(policy.routing.paidOrPlayBilling, "primary-korea-personal");
  assert.deepEqual(role("primary-korea-personal").allowedOperations, [
    "new-app",
    "existing-app-maintenance",
    "advertising",
    "paid-app",
    "play-billing",
  ]);
});

test("레거시와 종료 대기 역할은 신규 출시와 Play 결제를 허용하지 않는다", () => {
  assert.deepEqual(role("legacy-personal").allowedOperations, [
    "existing-app-maintenance",
    "advertising",
  ]);
  assert.deepEqual(role("retiring-organization").allowedOperations, [
    "financial-recovery",
    "support",
  ]);
});

test("테스트 완화와 광고 수익모델은 계정 선택 기준이 아니다", () => {
  assert.equal(policy.testing.useAsAccountRoutingCriterion, false);
  assert.equal(policy.testing.requirementSource, "live-play-console");
  assert.equal(policy.routing.advertisingOnly, "no-account-override");
});

test("공개 계약에는 실제 로그인 이메일이나 개발자 계정 ID가 없다", () => {
  assert.equal(policyText.includes("@"), false);
  assert.equal(/\b\d{19}\b/u.test(policyText), false);
  assert.deepEqual(policy.privacy.localOnlyFields, [
    "login-email",
    "developer-account-name",
    "developer-account-id",
    "merchant-id",
    "payments-profile-id",
  ]);
});

test("공유 게시자는 대상 계정과 패키지 권한을 매번 확인한다", () => {
  assert.equal(policy.credentials.publisherLogicalId, "shared/google-play/publisher");
  assert.deepEqual(policy.credentials.requiredReadback, [
    "target-developer-account",
    "package-ownership",
    "publisher-access",
  ]);
  assert.equal(policy.credentials.unknownBindingBehavior, "stop");
});
