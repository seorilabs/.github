#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PROVIDER =
  "projects/321365398093/locations/global/workloadIdentityPools/fleet-p3/providers/github-cloud-build";
const SUBMITTER =
  "seori-cloud-build-submitter@seorilabs-ci.iam.gserviceaccount.com";
const ACTION_CAPABILITY = "ANDROID_CANARY_BUILD_ONLY";

export const ANDROID_CANARY_BUILD_TARGETS = Object.freeze([
  Object.freeze({
    repositoryId: "1250442131",
    fullName: "seorilabs/happy-farm",
    buildProfile: "react-native-android",
    executorServiceAccount:
      "seori-happy-farm-canary@seorilabs-ci.iam.gserviceaccount.com",
  }),
  Object.freeze({
    repositoryId: "1265192029",
    fullName: "seorilabs/lizard-tycoon",
    buildProfile: "godot-android",
    executorServiceAccount:
      "seori-lizard-tycoon-canary@seorilabs-ci.iam.gserviceaccount.com",
  }),
  Object.freeze({
    repositoryId: "1298244321",
    fullName: "seorilabs/babycare",
    buildProfile: "react-native-android",
    executorServiceAccount:
      "seori-babycare-canary@seorilabs-ci.iam.gserviceaccount.com",
  }),
  Object.freeze({
    repositoryId: "1298264957",
    fullName: "seorilabs/cycle-pair",
    buildProfile: "react-native-android",
    executorServiceAccount:
      "seori-cycle-pair-canary@seorilabs-ci.iam.gserviceaccount.com",
  }),
]);

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).toSorted()) ===
      JSON.stringify([...keys].toSorted())
  );
}

export function resolveAndroidCloudBuildTarget(input) {
  if (
    !exactKeys(input, [
      "actionCapability",
      "buildProfile",
      "executorServiceAccount",
      "fullName",
      "provider",
      "repositoryId",
      "submitterServiceAccount",
    ]) ||
    input.actionCapability !== ACTION_CAPABILITY ||
    input.provider !== PROVIDER ||
    input.submitterServiceAccount !== SUBMITTER
  ) {
    throw new Error("ANDROID_CLOUD_BUILD_TARGET_BINDING_INVALID");
  }
  const target = ANDROID_CANARY_BUILD_TARGETS.find(
    ({ repositoryId }) => repositoryId === input.repositoryId,
  );
  if (
    target === undefined ||
    target.fullName !== input.fullName ||
    target.buildProfile !== input.buildProfile ||
    target.executorServiceAccount !== input.executorServiceAccount
  ) {
    throw new Error("ANDROID_CLOUD_BUILD_TARGET_BINDING_INVALID");
  }
  return Object.freeze({
    actionCapability: ACTION_CAPABILITY,
    artifactClass: "NON_PROMOTABLE_CANARY",
    buildTarget: "ANDROID_CANARY_AAB",
    executorServiceAccount: target.executorServiceAccount,
  });
}

function fail(code) {
  process.stderr.write(`${JSON.stringify({ valid: false, code })}\n`);
  process.exit(1);
}

function main() {
  if (process.argv.length !== 2 || !process.env.GITHUB_OUTPUT) {
    fail("ANDROID_CLOUD_BUILD_TARGET_COMMAND_INVALID");
  }
  let binding;
  try {
    binding = resolveAndroidCloudBuildTarget({
      actionCapability: process.env.SEORI_ACTION_CAPABILITY,
      buildProfile: process.env.SEORI_BUILD_PROFILE,
      executorServiceAccount: process.env.SEORI_CLOUD_BUILD_EXECUTOR_SERVICE_ACCOUNT,
      fullName: process.env.SEORI_REPOSITORY_FULL_NAME,
      provider: process.env.GOOGLE_WORKLOAD_IDENTITY_PROVIDER,
      repositoryId: process.env.SEORI_REPOSITORY_ID,
      submitterServiceAccount:
        process.env.SEORI_CLOUD_BUILD_SUBMITTER_SERVICE_ACCOUNT,
    });
  } catch {
    fail("ANDROID_CLOUD_BUILD_TARGET_BINDING_INVALID");
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `action_capability=${binding.actionCapability}`,
      `artifact_class=${binding.artifactClass}`,
      `build_target=${binding.buildTarget}`,
      `executor_service_account=${binding.executorServiceAccount}`,
    ].join("\n") + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) main();
