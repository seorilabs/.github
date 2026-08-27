#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKFLOW_PATH_BY_PROFILE = Object.freeze({
  "react-native": ".github/workflows/rn-static-checks-v2.yml",
  godot: ".github/workflows/godot-checks-v2.yml",
});

export async function writeProvenance({
  outputPath,
  profile,
  environment = process.env,
}) {
  const expectedWorkflowPath = WORKFLOW_PATH_BY_PROFILE[profile];
  if (!outputPath || !expectedWorkflowPath) {
    throw new Error("ARGUMENT_INVALID");
  }
  if (environment.QUALITY_RESULT !== "success") {
    throw new Error("QUALITY_RESULT_INVALID");
  }
  for (const name of ["GITHUB_SHA", "SEORI_WORKFLOW_SHA"]) {
    if (!SHA_PATTERN.test(environment[name] ?? "")) {
      throw new Error(`${name}_INVALID`);
    }
  }
  if (environment.SEORI_WORKFLOW_REPOSITORY !== "seorilabs/.github") {
    throw new Error("SEORI_WORKFLOW_REPOSITORY_INVALID");
  }
  const expectedWorkflowRef =
    `seorilabs/.github/${expectedWorkflowPath}@${environment.SEORI_WORKFLOW_SHA}`;
  if (
    environment.SEORI_WORKFLOW_REF !== expectedWorkflowRef
  ) {
    throw new Error("SEORI_WORKFLOW_REF_INVALID");
  }

  const provenance = {
    schemaVersion: 1,
    result: "passed",
    repository: {
      id: environment.GITHUB_REPOSITORY_ID ?? null,
      name: environment.GITHUB_REPOSITORY ?? null,
      sourceSha: environment.GITHUB_SHA,
      ref: environment.GITHUB_REF ?? null,
    },
    workflow: {
      repository: environment.SEORI_WORKFLOW_REPOSITORY,
      ref: environment.SEORI_WORKFLOW_REF,
      sha: environment.SEORI_WORKFLOW_SHA,
      runId: environment.GITHUB_RUN_ID ?? null,
      runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    },
    callerWorkflow: {
      ref: environment.GITHUB_WORKFLOW_REF ?? null,
      sha: environment.GITHUB_WORKFLOW_SHA ?? null,
    },
    runner: {
      environment: environment.RUNNER_ENVIRONMENT ?? null,
      architecture: environment.RUNNER_ARCH ?? null,
      os: environment.RUNNER_OS ?? null,
    },
    profile,
    qualityJob: {
      result: environment.QUALITY_RESULT,
    },
    qualityCommands: [
      "test:core",
      "check:architecture",
      "check:release",
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return provenance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [outputPath, profile] = process.argv.slice(2);
  try {
    await writeProvenance({ outputPath, profile });
  } catch (error) {
    const code = String(error?.message ?? "PROVENANCE_FAILED").split(":")[0];
    process.stderr.write(`오류 [${code}] provenance 생성 실패\n`);
    process.exitCode = 1;
  }
}
