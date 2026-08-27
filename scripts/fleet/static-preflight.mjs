#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_SCRIPTS = Object.freeze([
  "test:core",
  "check:architecture",
  "check:release",
]);
const SAFE_RELATIVE_DIRECTORY = /^(?:\.|[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*)$/u;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("ARGUMENT_INVALID");
    }
    values[name.slice(2)] = value;
  }
  return values;
}

async function requireRegularFile(path, code) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(code);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(code);
  }
}

export async function runStaticPreflight({
  repoRoot,
  workingDirectory = ".",
  packageManager = "pnpm",
  profile,
} = {}) {
  if (!SAFE_RELATIVE_DIRECTORY.test(workingDirectory)) {
    throw new Error("WORKING_DIRECTORY_INVALID");
  }
  if (!["npm", "pnpm"].includes(packageManager)) {
    throw new Error("PACKAGE_MANAGER_INVALID");
  }
  if (!["react-native", "godot"].includes(profile)) {
    throw new Error("PROFILE_INVALID");
  }

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(repoRoot);
  } catch {
    throw new Error("REPO_ROOT_INVALID");
  }
  const requestedDirectory = resolve(canonicalRoot, workingDirectory);
  let canonicalWorkingDirectory;
  try {
    canonicalWorkingDirectory = await realpath(requestedDirectory);
  } catch {
    throw new Error("WORKING_DIRECTORY_MISSING");
  }
  const relativeDirectory = relative(canonicalRoot, canonicalWorkingDirectory);
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    relativeDirectory.startsWith(sep)
  ) {
    throw new Error("WORKING_DIRECTORY_ESCAPE");
  }

  const packageJsonPath = resolve(canonicalWorkingDirectory, "package.json");
  await requireRegularFile(packageJsonPath, "PACKAGE_JSON_MISSING");
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    throw new Error("PACKAGE_JSON_INVALID");
  }
  for (const requiredScript of REQUIRED_SCRIPTS) {
    if (typeof packageJson.scripts?.[requiredScript] !== "string") {
      throw new Error(`QUALITY_SCRIPT_MISSING_${requiredScript}`);
    }
  }

  const lockfile = packageManager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  await requireRegularFile(
    resolve(canonicalWorkingDirectory, lockfile),
    "LOCKFILE_MISSING",
  );
  if (profile === "godot") {
    await requireRegularFile(
      resolve(canonicalWorkingDirectory, "project.godot"),
      "GODOT_PROJECT_MISSING",
    );
  }

  return {
    profile,
    packageManager,
    workingDirectory: relativeDirectory || ".",
    commands: REQUIRED_SCRIPTS.map((script) =>
      packageManager === "npm" ? `npm run ${script}` : `pnpm ${script}`,
    ),
  };
}

export async function runStaticPreflightCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const args = parseArgs(argv);
    await runStaticPreflight({
      repoRoot: args["repo-root"],
      workingDirectory: args["working-directory"],
      packageManager: args["package-manager"],
      profile: args.profile,
    });
    stdout.write("중앙 정적 게이트 preflight 통과\n");
    return 0;
  } catch (error) {
    const code = String(error?.message ?? "PREFLIGHT_FAILED").split(":")[0];
    stderr.write(`오류 [${code}] 중앙 정적 게이트 preflight 실패\n`);
    return 1;
  }
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
  process.exitCode = await runStaticPreflightCli();
}
