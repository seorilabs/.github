import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ANDROID_CANARY_BUILD_TARGETS,
  resolveAndroidCloudBuildTarget,
} from "../scripts/fleet/resolve-android-cloud-build-target.mjs";

const execFileAsync = promisify(execFile);
const provider =
  "projects/321365398093/locations/global/workloadIdentityPools/fleet-p3/providers/github-cloud-build";
const submitter =
  "seori-cloud-build-submitter@seorilabs-ci.iam.gserviceaccount.com";

function request(target, overrides = {}) {
  return {
    actionCapability: "ANDROID_CANARY_BUILD_ONLY",
    buildProfile: target.buildProfile,
    executorServiceAccount: target.executorServiceAccount,
    fullName: target.fullName,
    provider,
    repositoryId: target.repositoryId,
    submitterServiceAccount: submitter,
    ...overrides,
  };
}

test("네 pilot의 Android canary executor는 repo ID와 profile에 exact 결합된다", () => {
  assert.equal(ANDROID_CANARY_BUILD_TARGETS.length, 4);
  assert.equal(
    new Set(ANDROID_CANARY_BUILD_TARGETS.map(({ executorServiceAccount }) =>
      executorServiceAccount,
    )).size,
    4,
  );
  for (const target of ANDROID_CANARY_BUILD_TARGETS) {
    assert.deepEqual(resolveAndroidCloudBuildTarget(request(target)), {
      actionCapability: "ANDROID_CANARY_BUILD_ONLY",
      artifactClass: "NON_PROMOTABLE_CANARY",
      buildTarget: "ANDROID_CANARY_AAB",
      executorServiceAccount: target.executorServiceAccount,
    });
  }
});

test("repo는 다른 executor, profile 또는 release capability를 선택할 수 없다", () => {
  const [first, second] = ANDROID_CANARY_BUILD_TARGETS;
  for (const overrides of [
    { executorServiceAccount: second.executorServiceAccount },
    { fullName: second.fullName },
    { buildProfile: second.buildProfile },
    { actionCapability: "ANDROID_PLAY_PROMOTABLE_SIGNED_BUILD" },
    { secretResource: "projects/seorilabs-ci/secrets/example" },
  ]) {
    assert.throws(
      () => resolveAndroidCloudBuildTarget(request(first, overrides)),
      /ANDROID_CLOUD_BUILD_TARGET_BINDING_INVALID/u,
    );
  }
});

test("CLI는 공개 canary capability만 output file에 쓰고 stdout은 비운다", async () => {
  const target = ANDROID_CANARY_BUILD_TARGETS[2];
  const directory = await mkdtemp(join(tmpdir(), "android-cloud-target-"));
  const outputPath = join(directory, "github-output");
  try {
    const result = await execFileAsync(
      process.execPath,
      ["scripts/fleet/resolve-android-cloud-build-target.mjs"],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: outputPath,
          GOOGLE_WORKLOAD_IDENTITY_PROVIDER: provider,
          SEORI_ACTION_CAPABILITY: "ANDROID_CANARY_BUILD_ONLY",
          SEORI_BUILD_PROFILE: target.buildProfile,
          SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT:
            target.executorServiceAccount,
          SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT: submitter,
          SEORI_REPOSITORY_FULL_NAME: target.fullName,
          SEORI_REPOSITORY_ID: target.repositoryId,
        },
      },
    );
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(
      await readFile(outputPath, "utf8"),
      "action_capability=ANDROID_CANARY_BUILD_ONLY\n" +
        "artifact_class=NON_PROMOTABLE_CANARY\n" +
        "build_target=ANDROID_CANARY_AAB\n" +
        `executor_service_account=${target.executorServiceAccount}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
