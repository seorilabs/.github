#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFile, lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  assertPathWithin,
  resolveSafeDirectory,
  resolveSafeFile,
} from "./v5-paths.mjs";

const REQUIRED_SCRIPTS = Object.freeze([
  "test:core",
  "check:architecture",
  "check:release",
]);
const EXACT_PACKAGE_MANAGER = /^(npm|pnpm)@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const GODOT_LOCK_NAMES = Object.freeze([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SAFE_DIAGNOSTIC_CODE = /^[A-Za-z0-9_:.-]+$/u;

function fail(code) {
  throw new Error(code);
}

async function readPackageJson(path) {
  const metadata = await lstat(path).catch(() => undefined);
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_PACKAGE_BYTES
  ) {
    fail("PACKAGE_JSON_INVALID");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("PACKAGE_JSON_INVALID");
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("ARGUMENT_INVALID");
    values[name.slice(2)] = value;
  }
  return values;
}

function trackedPackagePaths(repoRoot, workspaceRoot) {
  let output;
  try {
    output = execFileSync(
      "git",
      ["-C", repoRoot, "ls-files", "-z", "--", "package.json", ":(glob)**/package.json"],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    fail("TRACKED_PACKAGE_DISCOVERY_FAILED");
  }
  const prefix = workspaceRoot === "." ? "" : `${workspaceRoot}/`;
  return output
    .split("\0")
    .filter(Boolean)
    .filter((path) => path === `${prefix}package.json` || path.startsWith(prefix))
    .sort();
}

function dependenciesOf(manifest) {
  return {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.devDependencies ?? {}),
  };
}

function managedDependencySections(manifest) {
  const result = {};
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest?.[section] ?? {};
    if (
      dependencies === null ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      fail("GODOT_DEPENDENCY_DECLARATION_INVALID");
    }
    for (const [name, specification] of Object.entries(dependencies)) {
      if (
        !PACKAGE_NAME.test(name) ||
        name.startsWith("@seorilabs/") ||
        typeof specification !== "string" ||
        specification.length === 0 ||
        specification.length > 256 ||
        /[\r\n\0]/u.test(specification) ||
        /^(?:file|link|workspace|git|git\+|https?|npm):/iu.test(specification)
      ) {
        fail("GODOT_DEPENDENCY_SOURCE_FORBIDDEN");
      }
    }
    result[section] = dependencies;
  }
  return result;
}

function trackedFile(repoRoot, path) {
  try {
    execFileSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", path], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

async function readGodotLock(path) {
  const metadata = await lstat(path).catch(() => undefined);
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_LOCK_BYTES
  ) {
    fail("GODOT_DEPENDENCY_LOCK_INVALID");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("GODOT_DEPENDENCY_LOCK_INVALID");
  }
}

function validatePublicNpmLock(lock, dependencySections) {
  if (
    lock?.lockfileVersion !== 3 ||
    lock.packages === null ||
    typeof lock.packages !== "object" ||
    Array.isArray(lock.packages) ||
    lock.packages[""] === null ||
    typeof lock.packages[""] !== "object" ||
    Array.isArray(lock.packages[""])
  ) {
    fail("GODOT_DEPENDENCY_LOCK_INVALID");
  }
  const lockRoot = lock.packages[""];
  for (const section of DEPENDENCY_SECTIONS) {
    const expected = dependencySections[section];
    const actual = lockRoot[section] ?? {};
    if (
      actual === null ||
      typeof actual !== "object" ||
      Array.isArray(actual) ||
      JSON.stringify(Object.entries(actual).sort()) !==
        JSON.stringify(Object.entries(expected).sort())
    ) {
      fail("GODOT_DEPENDENCY_LOCK_MISMATCH");
    }
  }
  const visit = (value, field = "") => {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, field));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key.includes("node_modules/@seorilabs/")) {
          fail("GODOT_DEPENDENCY_SOURCE_FORBIDDEN");
        }
        visit(child, key);
      }
      return;
    }
    if (typeof value !== "string") return;
    if (["resolved", "tarball"].includes(field)) {
      let url;
      try {
        url = new URL(value);
      } catch {
        fail("GODOT_DEPENDENCY_SOURCE_FORBIDDEN");
      }
      if (
        url.protocol !== "https:" ||
        url.origin !== "https://registry.npmjs.org" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash
      ) {
        fail("GODOT_DEPENDENCY_SOURCE_FORBIDDEN");
      }
    }
    if (
      field === "version" &&
      /^(?:file|link|workspace|git|git\+|https?|npm):/iu.test(value)
    ) {
      fail("GODOT_DEPENDENCY_SOURCE_FORBIDDEN");
    }
  };
  visit(lock);
}

async function inspectGodotDependencyBoundary({
  repoRoot,
  commandPath,
  commandDirectory,
  commandPackage,
}) {
  const dependencySections = managedDependencySections(commandPackage);
  const dependencyCount = Object.values(dependencySections)
    .reduce((count, dependencies) => count + Object.keys(dependencies).length, 0);
  const lockfiles = [];
  for (const name of GODOT_LOCK_NAMES) {
    const path = resolve(commandPath, name);
    const metadata = await lstat(path).catch(() => undefined);
    if (metadata !== undefined) lockfiles.push({ name, path, metadata });
  }
  if (lockfiles.length > 1) fail("GODOT_DEPENDENCY_LOCK_AMBIGUOUS");
  if (lockfiles.length === 0) {
    if (dependencyCount > 0) fail("GODOT_DEPENDENCY_LOCK_REQUIRED");
    return "NO_MANAGED_DEPENDENCIES";
  }
  const [{ name, path, metadata }] = lockfiles;
  if (name !== "package-lock.json") fail("GODOT_DEPENDENCY_LOCK_UNSUPPORTED");
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("GODOT_DEPENDENCY_LOCK_INVALID");
  }
  const relativeLockPath = commandDirectory === "."
    ? name
    : `${commandDirectory}/${name}`;
  if (!trackedFile(repoRoot, relativeLockPath)) fail("GODOT_DEPENDENCY_LOCK_UNTRACKED");
  validatePublicNpmLock(await readGodotLock(path), dependencySections);
  return "PUBLIC_NPM_LOCK_AUDIT";
}

async function packageManifests(repoRoot, workspaceRoot) {
  const paths = trackedPackagePaths(repoRoot, workspaceRoot);
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    fail("TRACKED_PACKAGE_DISCOVERY_INVALID");
  }
  return Promise.all(
    paths.map(async (path) => {
      const file = await resolveSafeFile(repoRoot, path);
      return { path, value: await readPackageJson(file.path) };
    }),
  );
}

function hasDependency(packages, dependency) {
  return packages.some(({ value }) =>
    typeof dependenciesOf(value)[dependency] === "string",
  );
}

async function requireProfileSignals({ profile, repoRoot, commandDirectory, packages }) {
  if (profile === "react-native") {
    if (
      !hasDependency(packages, "react-native") &&
      !hasDependency(packages, "@granite-js/react-native")
    ) {
      fail("REACT_NATIVE_SIGNAL_MISSING");
    }
    return;
  }
  if (profile === "capacitor") {
    if (!hasDependency(packages, "@capacitor/core")) fail("CAPACITOR_SIGNAL_MISSING");
    const configPath = commandDirectory === "."
      ? "capacitor.config.ts"
      : `${commandDirectory}/capacitor.config.ts`;
    await resolveSafeFile(repoRoot, configPath).catch(() => fail("CAPACITOR_CONFIG_MISSING"));
    return;
  }
  if (profile === "ait-web") {
    if (!hasDependency(packages, "@apps-in-toss/web-framework")) {
      fail("AIT_WEB_SIGNAL_MISSING");
    }
    const configPath = commandDirectory === "."
      ? "granite.config.ts"
      : `${commandDirectory}/granite.config.ts`;
    await resolveSafeFile(repoRoot, configPath).catch(() => fail("GRANITE_CONFIG_MISSING"));
    return;
  }
  if (profile === "godot") {
    const projectPath = commandDirectory === "."
      ? "project.godot"
      : `${commandDirectory}/project.godot`;
    await resolveSafeFile(repoRoot, projectPath).catch(() => fail("GODOT_PROJECT_MISSING"));
    return;
  }
  fail("STATIC_PROFILE_INVALID");
}

export async function runStaticPreflightV5({ repoRoot, staticBinding } = {}) {
  const { profile, packageManager, workspaceRoot, commandDirectory } = staticBinding ?? {};
  if (!["react-native", "godot", "capacitor", "ait-web"].includes(profile)) {
    fail("STATIC_PROFILE_INVALID");
  }
  if (profile === "godot" ? packageManager !== null : !["npm", "pnpm"].includes(packageManager)) {
    fail("PACKAGE_MANAGER_INVALID");
  }
  const workspace = await resolveSafeDirectory(repoRoot, workspaceRoot);
  const command = await resolveSafeDirectory(repoRoot, commandDirectory);
  assertPathWithin(workspace.path, command.path, "COMMAND_DIRECTORY_OUTSIDE_WORKSPACE");

  const commandPackagePath = commandDirectory === "."
    ? "package.json"
    : `${commandDirectory}/package.json`;
  const commandPackageFile = await resolveSafeFile(workspace.root, commandPackagePath)
    .catch(() => fail("QUALITY_PACKAGE_JSON_MISSING"));
  const commandPackage = await readPackageJson(commandPackageFile.path);
  for (const script of REQUIRED_SCRIPTS) {
    if (typeof commandPackage?.scripts?.[script] !== "string" || commandPackage.scripts[script].trim() === "") {
      fail(`QUALITY_SCRIPT_MISSING_${script}`);
    }
  }

  if (profile === "godot") {
    await requireProfileSignals({ profile, repoRoot: workspace.root, commandDirectory, packages: [] });
    const dependencyMode = await inspectGodotDependencyBoundary({
      repoRoot: workspace.root,
      commandPath: command.path,
      commandDirectory,
      commandPackage,
    });
    return Object.freeze({
      profile,
      packageManager,
      workspaceRoot,
      commandDirectory,
      dependencyMode,
      commands: REQUIRED_SCRIPTS.map((script) => `npm run ${script}`),
    });
  }

  const workspacePackagePath = workspaceRoot === "."
    ? "package.json"
    : `${workspaceRoot}/package.json`;
  const workspacePackageFile = await resolveSafeFile(workspace.root, workspacePackagePath);
  const workspacePackage = await readPackageJson(workspacePackageFile.path);
  const packageManagerMatch = EXACT_PACKAGE_MANAGER.exec(workspacePackage.packageManager ?? "");
  if (packageManagerMatch?.[1] !== packageManager) fail("PACKAGE_MANAGER_VERSION_NOT_EXACT");

  const packages = await packageManifests(workspace.root, workspaceRoot);
  await requireProfileSignals({
    profile,
    repoRoot: workspace.root,
    commandDirectory,
    packages,
  });
  const { inspectExactPlatformDependencyV5 } = await import(
    "./stage-private-package-v5.mjs"
  );
  await inspectExactPlatformDependencyV5({
    repoRoot: workspace.root,
    dependencyRoot: workspaceRoot,
    packageManager,
  });

  return Object.freeze({
    profile,
    packageManager,
    workspaceRoot,
    commandDirectory,
    commands: REQUIRED_SCRIPTS.map((script) =>
      packageManager === "npm" ? `npm run ${script}` : `pnpm ${script}`,
    ),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runStaticPreflightV5({
    repoRoot: args["repo-root"],
    staticBinding: {
      profile: args.profile,
      packageManager: args["package-manager"] === "null" ? null : args["package-manager"],
      workspaceRoot: args["workspace-root"],
      commandDirectory: args["command-directory"],
    },
  });
  if (args["github-output"] !== undefined) {
    if (
      result.profile !== "godot" ||
      !["NO_MANAGED_DEPENDENCIES", "PUBLIC_NPM_LOCK_AUDIT"].includes(
        result.dependencyMode,
      )
    ) {
      fail("GODOT_DEPENDENCY_MODE_INVALID");
    }
    await appendFile(
      args["github-output"],
      `dependency_mode=${result.dependencyMode}\n`,
      "utf8",
    );
  }
  process.stdout.write("WorkflowBundle v5 정적 preflight 통과\n");
}

if (import.meta.main) {
  main().catch((error) => {
    const code = SAFE_DIAGNOSTIC_CODE.test(error?.message ?? "")
      ? error.message
      : "STATIC_PREFLIGHT_FAILED";
    process.stderr.write(`오류: ${code}\n`);
    process.exitCode = 1;
  });
}
