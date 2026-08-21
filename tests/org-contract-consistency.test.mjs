import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(resolve(REPOSITORY_ROOT, relativePath), "utf8"),
  );
}

async function readYaml(relativePath) {
  return parse(await readFile(resolve(REPOSITORY_ROOT, relativePath), "utf8"));
}

const [appSchema, testPolicy, releasePolicy, reviewPolicy, ...profiles] =
  await Promise.all([
    readJson("contracts/app.schema.json"),
    readYaml("contracts/test-policy.yaml"),
    readYaml("contracts/release-policy.yaml"),
    readYaml("contracts/review-policy.yaml"),
    readYaml("profiles/react-native.yaml"),
    readYaml("profiles/godot.yaml"),
  ]);

test("앱과 credential 표준 예제가 실제 schema를 통과한다", async () => {
  const credentialSchema = await readJson(
    "contracts/credential-consumer.schema.json",
  );
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  const validateApp = ajv.compile(appSchema);
  const validateCredential = new Ajv2020({
    strict: true,
    validateFormats: false,
  }).compile(credentialSchema);

  for (const example of [
    "contracts/examples/react-native-app.yaml",
    "contracts/examples/godot-game.yaml",
  ]) {
    assert.equal(validateApp(await readYaml(example)), true, example);
  }
  assert.equal(
    validateCredential(
      await readYaml("contracts/examples/credential-consumers.yaml"),
    ),
    true,
  );
});

test("app schema의 품질 명령은 test policy의 canonical invocation과 일치한다", () => {
  const schemaCommands = appSchema.properties.quality.properties.commands;
  const policyCommands = testPolicy.canonicalCommands;

  assert.deepEqual(
    [...schemaCommands.required].sort(),
    Object.keys(policyCommands).sort(),
  );

  for (const [command, policy] of Object.entries(policyCommands)) {
    assert.equal(schemaCommands.properties[command].const, policy.invocation);
  }
});

test("RN과 Godot profile의 requiredScripts는 test policy alias와 일치한다", () => {
  const canonicalAliases = Object.values(testPolicy.canonicalCommands)
    .map(({ alias }) => alias)
    .sort();

  for (const profile of profiles) {
    assert.deepEqual(
      [...profile.quality.requiredScripts].sort(),
      canonicalAliases,
      profile.id,
    );
  }
});

test("release 기본 branch와 명시적 semver tag 의미는 app schema와 일치한다", () => {
  const repositorySchema = appSchema.properties.repository;
  const releaseSchema = appSchema.properties.release;

  assert.ok(repositorySchema.required.includes("defaultBranch"));
  assert.equal(
    repositorySchema.properties.defaultBranch.const,
    releasePolicy.defaultBranch,
  );
  assert.ok(releaseSchema.required.includes("trigger"));
  assert.equal(
    releaseSchema.properties.trigger.const,
    releasePolicy.releaseTrigger.type,
  );
  assert.equal(releasePolicy.releaseTrigger.automaticOnMerge, false);

  const tagPattern = new RegExp(releasePolicy.releaseTrigger.tagPattern, "u");
  assert.equal(tagPattern.test("v1.2.3"), true);
  assert.equal(tagPattern.test("v1.2.3-rc.1+build.7"), true);
  for (const invalidTag of ["1.2.3", "v1.2", "v01.2.3", "v1.2.3.4"]) {
    assert.equal(tagPattern.test(invalidTag), false, invalidTag);
  }
});

test("profile SDK 배포 방식은 app schema의 profile 조건과 일치한다", () => {
  const schemaConditions = new Map(
    appSchema.allOf.map((condition) => {
      const profile = condition.if.properties.app.properties.profile.const;
      const definition = condition.then.properties.sdk.$ref.replace(
        "#/$defs/",
        "",
      );
      return [profile, appSchema.$defs[definition]];
    }),
  );

  for (const profile of profiles) {
    const sdkSchema = schemaConditions.get(profile.id);
    assert.ok(sdkSchema, profile.id);
    assert.ok(sdkSchema.required.includes("distribution"), profile.id);
    assert.equal(
      sdkSchema.properties.distribution.const,
      profile.sharedSdk.distribution,
      profile.id,
    );
  }
});

test("모든 stack profile은 SDK git submodule 배포를 금지한다", () => {
  for (const profile of profiles) {
    assert.ok(
      profile.sharedSdk.forbiddenDistributions.includes("git-submodule"),
      profile.id,
    );
  }
});

test("Copilot review는 최종 HEAD 최초 1회와 조건부 추가 1회로 제한된다", () => {
  const codeReview = reviewPolicy.stages.find(
    ({ id }) => id === "code-review",
  );
  const allowedAdditionalRequestConditions = [
    "unable-to-review",
    "accepted-review-fix-introduces-new-function",
    "accepted-review-fix-introduces-new-file",
    "accepted-review-fix-introduces-new-branch",
  ];

  assert.equal(codeReview.provider, "copilot");
  assert.equal(codeReview.target, "final-head");
  assert.equal(codeReview.initialRequest.maximumRequests, 1);
  assert.equal(codeReview.additionalRequest.maximumRequests, 1);
  assert.deepEqual(
    [...codeReview.additionalRequest.allowedWhen].sort(),
    allowedAdditionalRequestConditions.sort(),
  );
  assert.equal(codeReview.maximumTotalRequests, 2);
  assert.equal(
    codeReview.initialRequest.maximumRequests +
      codeReview.additionalRequest.maximumRequests,
    codeReview.maximumTotalRequests,
  );
  assert.equal(codeReview.requiredSuccessfulReviews, 1);
  assert.equal(codeReview.maximumSuccessfulReviews, 2);
});
