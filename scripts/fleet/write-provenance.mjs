#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import process from "node:process";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export async function writeProvenance({ outputPath, profile, environment = process.env }) {
  if (!outputPath || !["react-native", "godot"].includes(profile)) {
    throw new Error("ARGUMENT_INVALID");
  }
  for (const name of ["GITHUB_SHA", "GITHUB_WORKFLOW_SHA"]) {
    if (!SHA_PATTERN.test(environment[name] ?? "")) {
      throw new Error(`${name}_INVALID`);
    }
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
      ref: environment.GITHUB_WORKFLOW_REF ?? null,
      sha: environment.GITHUB_WORKFLOW_SHA,
      runId: environment.GITHUB_RUN_ID ?? null,
      runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    },
    runner: {
      environment: environment.RUNNER_ENVIRONMENT ?? null,
      architecture: environment.RUNNER_ARCH ?? null,
      os: environment.RUNNER_OS ?? null,
    },
    profile,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outputPath, profile] = process.argv.slice(2);
  try {
    await writeProvenance({ outputPath, profile });
  } catch (error) {
    const code = String(error?.message ?? "PROVENANCE_FAILED").split(":")[0];
    process.stderr.write(`오류 [${code}] provenance 생성 실패\n`);
    process.exitCode = 1;
  }
}
