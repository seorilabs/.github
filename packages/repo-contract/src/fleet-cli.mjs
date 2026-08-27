#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import {
  createWorkflowBundle,
  generateOrgContractCaller,
  validateOrgContractCaller,
  validateWorkflowBundle,
} from "./fleet.mjs";

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("OPTION_INVALID");
    }
    options[name.slice(2)] = value;
  }
  return options;
}

async function emit(content, outputPath, stdout) {
  if (outputPath) {
    await writeFile(outputPath, content, { encoding: "utf8", mode: 0o644 });
  } else {
    stdout.write(content);
  }
}

export async function runFleetCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const [command, ...optionArgs] = argv;
  let options;
  try {
    options = parseOptions(optionArgs);
  } catch {
    stderr.write("오류 [OPTION_INVALID] 옵션은 --이름 값 형식이어야 합니다.\n");
    return 2;
  }

  try {
    if (command === "bundle") {
      const platformRelease = options["platform-release"]
        ? JSON.parse(await readFile(options["platform-release"], "utf8"))
        : undefined;
      const bundle = await createWorkflowBundle({
        sourceSha: options["source-sha"],
        platformRelease,
      });
      await emit(`${JSON.stringify(bundle, null, 2)}\n`, options.output, stdout);
      return 0;
    }

    if (command === "validate-bundle") {
      const bundle = JSON.parse(await readFile(options.bundle, "utf8"));
      const result = await validateWorkflowBundle(bundle);
      if (!result.ok) {
        for (const diagnostic of result.diagnostics) {
          stderr.write(`오류 [${diagnostic}] WorkflowBundle 검증 실패\n`);
        }
        return 1;
      }
      stdout.write("WorkflowBundle 검증 통과\n");
      return 0;
    }

    if (command === "generate-caller") {
      const caller = generateOrgContractCaller({
        profile: options.profile,
        workflowSha: options["workflow-sha"],
        workingDirectory: options["working-directory"] ?? ".",
        packageManager: options["package-manager"] ?? "pnpm",
      });
      await emit(caller, options.output, stdout);
      return 0;
    }

    if (command === "validate-caller") {
      const result = validateOrgContractCaller(
        await readFile(options.caller, "utf8"),
      );
      if (!result.ok) {
        for (const diagnostic of result.diagnostics) {
          stderr.write(`오류 [${diagnostic}] thin caller 검증 실패\n`);
        }
        return 1;
      }
      stdout.write("thin caller 검증 통과\n");
      return 0;
    }
  } catch (error) {
    const code = String(error?.message ?? "FLEET_CONTRACT_FAILED").split(":")[0];
    stderr.write(`오류 [${code}] fleet 계약 작업을 완료할 수 없습니다.\n`);
    return 1;
  }

  stderr.write(
    "사용법: fleet-contract bundle|validate-bundle|generate-caller|validate-caller [옵션]\n",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runFleetCli();
}
