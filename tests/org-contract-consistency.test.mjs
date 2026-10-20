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

test("상시 자동 코드 리뷰 없이 로컬 모델 리뷰 단계만 계약된다", () => {
  assert.deepEqual(
    reviewPolicy.stages.map(({ id }) => id),
    ["local-model-review", "required-checks"],
  );
  assert.deepEqual(
    reviewPolicy.stages.map(({ order }) => order),
    [1, 2],
  );
  assert.ok(
    reviewPolicy.stages.every(({ trigger }) => trigger !== "automatic-first-turn"),
  );
  assert.ok(
    reviewPolicy.stages.every(({ provider }) => provider !== "copilot"),
  );

  const localReview = reviewPolicy.stages.find(
    ({ id }) => id === "local-model-review",
  );
  assert.equal(localReview.provider, "minimax");
  assert.equal(localReview.tool, "mcode");
  assert.equal(localReview.mode, "advisory");
  assert.equal(localReview.trigger, "local-headless");
  assert.equal(localReview.runner, "author-agent");
  assert.equal(localReview.input, "author-generated-diff");
  assert.equal(localReview.readOnly, true);
  assert.equal(localReview.optional, false);
  assert.equal(localReview.countsAsApproval, false);
  assert.equal(localReview.blocking, false);
  assert.equal(localReview.resultPostedToPr, false);
  assert.equal(localReview.beforePullRequestReady, true);
  assert.deepEqual(
    [...localReview.allowedWhen].sort(),
    ["code-change", "configuration-logic-change"],
  );
  assert.deepEqual(
    [...localReview.skipWhen].sort(),
    [
      "assets-only-change",
      "docs-only-change",
      "generated-file-only-change",
      "release-metadata-only-change",
      "translations-only-change",
    ],
  );
});

test("저장소 예외 없이 모든 저장소의 코드·설정 변경에 로컬 리뷰 의무가 있다", () => {
  assert.equal(reviewPolicy.repositoryExemptions, undefined);
  assert.equal(reviewPolicy.copilotEffort, undefined);
  assert.equal(reviewPolicy.requestObligation.requiredForApplicableStage, true);
  assert.equal(reviewPolicy.requestObligation.reviewResultCountsAsApproval, false);
  assert.equal(
    reviewPolicy.requestObligation.resultUnavailableRequiresRecordedReason,
    true,
  );
  assert.deepEqual(
    [...reviewPolicy.requestObligation.skipWhen].sort(),
    [
      "assets-only-change",
      "docs-only-change",
      "generated-file-only-change",
      "release-metadata-only-change",
      "translations-only-change",
    ],
  );
});

test("로컬 리뷰 실패는 사유를 기록하고 자체 점검으로 진행하며 유료 설정을 바꾸지 않는다", () => {
  const failures = reviewPolicy.reviewFailures;
  assert.equal(failures.diagnoseBeforeRetry, true);
  assert.equal(failures.otherError.maxRetries, 1);
  assert.equal(failures.usageLimit.retry, "no-automatic-retry");
  assert.equal(failures.workingTreeChangedByReviewer.retry, "once-after-revert");
  assert.equal(failures.unavailable.recordReasonInPr, true);
  assert.equal(failures.unavailable.proceedWithSelfReview, true);
  assert.equal(failures.unavailable.requestOtherProvider, false);
  assert.equal(failures.changePaidUsageBudget, false);
});

test("변경 줄 수는 한 가지 제외 기준으로 세고 큰 PR은 리뷰 전에 분할을 검토한다", () => {
  assert.deepEqual(
    [...reviewPolicy.changedLines.excludes].sort(),
    ["assets", "docs", "generated-files", "lock-files", "translations"],
  );
  assert.equal(reviewPolicy.pullRequest.splitReviewAboveChangedLines, 1500);
});

test("리뷰는 2회차까지만 돌고 2회차는 1회차 이후 수정분만 확인한다", () => {
  const rounds = reviewPolicy.reviewRounds;
  assert.equal(rounds.maxRoundsPerPr, 2);
  assert.equal(rounds.findingAcceptance, "concrete-failure-scenario-in-scope");
  assert.equal(rounds.rejectedFindingHandling, "drop-without-reply");
  assert.equal(rounds.verificationRound.when, "accepted-fix-added-logic");
  assert.equal(rounds.verificationRound.scope, "changes-since-first-review");
  assert.equal(rounds.verificationRound.includeFirstRoundFindings, true);
  assert.equal(rounds.afterVerificationRound, "no-review-run");
  assert.equal(
    rounds.escalateWhen,
    "same-area-defect-after-verification-round",
  );
});

test("머지 gate는 도착하지 않는 봇 산출물을 기다리지 않는다", () => {
  assert.deepEqual(Object.keys(reviewPolicy.mergeGate).sort(), [
    "codeReviewThreadsResolved",
    "humanApproval",
    "humanApprovalConditions",
    "localReviewFindingsHandled",
    "requiredChecksPassed",
  ]);
  assert.equal(reviewPolicy.mergeGate.codeReviewThreadsResolved, true);
  assert.equal(reviewPolicy.mergeGate.requiredChecksPassed, true);
  assert.equal(reviewPolicy.mergeGate.localReviewFindingsHandled, true);
  assert.equal(reviewPolicy.mergeGate.humanApproval, "conditional");
});
