#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createWorkflowBundle, validateWorkflowBundle } from "./fleet.mjs";

function parseOptions(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z][a-z0-9-]*$/u.test(name ?? "") || value === undefined) {
      throw new Error("OPTION_INVALID");
    }
    const key = name.slice(2);
    if (Object.hasOwn(options, key)) throw new Error("OPTION_INVALID");
    options[key] = value;
  }
  return options;
}

function requireOption(options, name, errorCode) {
  if (options[name] === undefined) throw new Error(errorCode);
  return options[name];
}

async function loadEd25519PublicKey(path, errorPrefix) {
  const encodedKey = await readFile(path, "utf8");
  if (/PRIVATE KEY/u.test(encodedKey)) {
    throw new Error(`${errorPrefix}_PUBLIC_KEY_REQUIRED`);
  }
  let publicKey;
  try {
    publicKey = createPublicKey(encodedKey);
  } catch {
    throw new Error(`${errorPrefix}_PUBLIC_KEY_INVALID`);
  }
  if (
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error(`${errorPrefix}_PUBLIC_KEY_INVALID`);
  }
  return publicKey;
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
  clock = () => Date.now(),
  trustedStateAuthorityReadback,
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
      await emit(
        `${JSON.stringify(bundle, null, 2)}\n`,
        options.output,
        stdout,
      );
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

  } catch (error) {
    const code = String(error?.message ?? "FLEET_CONTRACT_FAILED").split(
      ":",
    )[0];
    stderr.write(`오류 [${code}] fleet 계약 작업을 완료할 수 없습니다.\n`);
    return 1;
  }

  stderr.write(
    "사용법: fleet-contract bundle|validate-bundle [옵션]\n",
  );
  return 2;
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
  process.exitCode = await runFleetCli();
}
