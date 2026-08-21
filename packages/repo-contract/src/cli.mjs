#!/usr/bin/env node

import process from "node:process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatDiagnostic, validateRepository } from "./index.mjs";

export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  schemaPath,
  profilesRoot,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (argv.length > 1 || argv[0]?.startsWith("-")) {
    stderr.write("사용법: repo-contract [저장소 경로]\n");
    return 2;
  }

  let result;
  try {
    result = await validateRepository({
      repoRoot: argv[0] ?? cwd,
      schemaPath,
      profilesRoot,
    });
  } catch {
    stderr.write(
      "오류 [VALIDATION_INTERNAL] .seorilabs/app.yaml $: 계약 검증을 완료할 수 없습니다.\n",
    );
    return 1;
  }

  if (!result.ok) {
    for (const diagnostic of result.diagnostics) {
      stderr.write(`${formatDiagnostic(diagnostic)}\n`);
    }
    return 1;
  }

  stdout.write("계약 검증 통과: .seorilabs/app.yaml\n");
  return 0;
}

let isEntrypoint = false;
try {
  isEntrypoint =
    Boolean(process.argv[1]) &&
    realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
} catch {
  isEntrypoint = false;
}

if (isEntrypoint) {
  process.exitCode = await runCli();
}
