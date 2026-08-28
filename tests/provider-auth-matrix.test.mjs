import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(
  await readFile(resolve(ROOT, "contracts/provider-auth-matrix.schema.json"), "utf8"),
);
const document = parseDocument(
  await readFile(resolve(ROOT, "contracts/provider-auth-matrix.yaml"), "utf8"),
  { strict: true, uniqueKeys: true },
);
assert.deepEqual(document.errors, []);
const matrix = document.toJS();

test("provider 인증 매트릭스가 strict schema를 통과한다", () => {
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
  assert.equal(validate(matrix), true, JSON.stringify(validate.errors));
});

test("모든 capability는 중앙 우선순위와 human fallback을 지킨다", () => {
  const rank = new Map(matrix.strategyPriority.map((strategy, index) => [strategy, index]));
  const providerIds = new Set();

  for (const provider of matrix.providers) {
    assert.equal(providerIds.has(provider.id), false, provider.id);
    providerIds.add(provider.id);
    const capabilityIds = new Set();
    for (const capability of provider.capabilities) {
      assert.equal(capabilityIds.has(capability.id), false, `${provider.id}:${capability.id}`);
      capabilityIds.add(capability.id);
      const kinds = capability.strategies.map(({ kind }) => kind);
      assert.deepEqual(
        kinds,
        [...kinds].sort((left, right) => rank.get(left) - rank.get(right)),
        `${provider.id}:${capability.id}`,
      );
      assert.equal(kinds.at(-1), "HUMAN_REAUTH", `${provider.id}:${capability.id}`);
      assert.equal(new Set(kinds).size, kinds.length, `${provider.id}:${capability.id}`);
      if (capability.actionClass === "PROTECTED") {
        assert.notEqual(capability.approval, "PREAPPROVED", `${provider.id}:${capability.id}`);
      }
      if (capability.approval === "HUMAN_ONLY") {
        assert.deepEqual(kinds, ["HUMAN_REAUTH"], `${provider.id}:${capability.id}`);
      }
    }
  }

  assert.deepEqual(
    [...providerIds].sort(),
    [
      "app-store-connect",
      "apps-in-toss",
      "firebase",
      "github",
      "google-cloud",
      "google-play",
      "google-workspace",
    ],
  );
});

test("TOTP는 전용 봇에서만 허용하고 interactive factor는 agent 경로에 없다", () => {
  for (const provider of matrix.providers) {
    for (const capability of provider.capabilities) {
      for (const strategy of capability.strategies) {
        if (strategy.allowTotp) {
          assert.equal(strategy.kind, "BOT_PASSWORD_TOTP");
          assert.equal(strategy.accountKind, "DEDICATED_BOT");
          assert.equal(strategy.credentialLogicalIds.length, 2);
        }
        if (strategy.kind === "HUMAN_REAUTH") {
          assert.equal(strategy.accountKind, "HUMAN");
          assert.equal(strategy.unattended, false);
          assert.deepEqual(strategy.credentialLogicalIds, []);
        } else {
          assert.notEqual(strategy.accountKind, "HUMAN");
        }
        if (strategy.unattended) {
          assert.equal(strategy.availability, "ACTIVE");
          assert.equal(capability.approval, "PREAPPROVED");
        }
      }
    }
  }

  assert.deepEqual(
    [...matrix.prohibitedInteractiveFactors].sort(),
    [
      "CAPTCHA",
      "PASSKEY",
      "PERSONAL_ACCOUNT_PASSWORD_TOTP",
      "PUSH",
      "RECOVERY",
      "SMS",
      "TERMS_OR_ACCOUNT_ACCEPTANCE",
      "TRUSTED_DEVICE",
    ],
  );
});

test("공용 identity는 canonical logical ID만 사용하고 개인 GitHub operator는 제외한다", () => {
  const credentialIds = matrix.providers.flatMap(({ capabilities }) =>
    capabilities.flatMap(({ strategies }) =>
      strategies.flatMap(({ credentialLogicalIds }) => credentialLogicalIds),
    ),
  );
  assert.equal(credentialIds.includes("shared/github/operator"), false);
  assert.equal(credentialIds.includes("shared/google-play/publisher"), true);
  assert.equal(credentialIds.includes("shared/apple/app-store-connect-uploader"), true);
  assert.equal(credentialIds.includes("shared/apps-in-toss/operator"), true);
  assert.equal(credentialIds.includes("shared/gcp/provisioner-session"), true);
  assert.equal(credentialIds.includes("shared/gcp/firebase-automation"), true);
});

test("계약에는 credential 값을 수용하는 field가 없다", () => {
  const forbidden = /(?:secret|password|token|cookie|seed|privatekey|credentialvalue)/iu;
  function visit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.test(key), false, key);
      visit(child);
    }
  }
  visit(matrix);
});
