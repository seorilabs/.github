#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  assertPathWithin,
  isSafeRelativePosixPath,
  resolveSafeDirectory,
  resolveSafeFile,
} from "./v5-paths.mjs";

const PLATFORM_PACKAGE = "@seorilabs/platform-sdk";
const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const PRIVATE_REGISTRY = "https://npm.pkg.github.com";
const PINNED_PACKAGE_MANAGERS = Object.freeze({ npm: "11.13.0", pnpm: "11.3.0" });
const EXACT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const PACKAGE_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 24 * 1024 * 1024;
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "COREPACK_HOME",
  "GITHUB_ACTIONS",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PNPM_HOME",
  "RUNNER_TEMP",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

function fail(code) {
  throw new Error(code);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function packageManagerEnvironment(source, token, userConfigPath) {
  const environment = Object.create(null);
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = source?.[key];
    if (typeof value === "string" && !value.includes("\0")) {
      environment[key] = value;
    }
  }
  environment.NODE_AUTH_TOKEN = token;
  environment.NPM_CONFIG_GLOBALCONFIG = "/dev/null";
  environment.NPM_CONFIG_REGISTRY = PUBLIC_REGISTRY;
  environment.NPM_CONFIG_USERCONFIG = userConfigPath;
  environment.NPM_CONFIG_AUDIT = "false";
  environment.NPM_CONFIG_FUND = "false";
  environment.NPM_CONFIG_IGNORE_SCRIPTS = "true";
  return environment;
}

function tokenlessPackageManagerEnvironment(source, userConfigPath) {
  const environment = packageManagerEnvironment(source, "placeholder-token-never-used", userConfigPath);
  delete environment.NODE_AUTH_TOKEN;
  environment.NPM_CONFIG_AUDIT = "true";
  return environment;
}

async function readBounded(path, maximum, code) {
  const metadata = await lstat(path).catch(() => undefined);
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximum
  ) {
    fail(code);
  }
  return readFile(path, "utf8");
}

function trackedPackagePaths(repoRoot, dependencyRoot) {
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
  const prefix = dependencyRoot === "." ? "" : `${dependencyRoot}/`;
  const paths = output
    .split("\0")
    .filter(Boolean)
    .filter((path) => path === `${prefix}package.json` || path.startsWith(prefix));
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    fail("TRACKED_PACKAGE_DISCOVERY_INVALID");
  }
  return paths.sort();
}

async function declaredVersion(repoRoot, dependencyRoot) {
  const versions = new Set();
  for (const packagePath of trackedPackagePaths(repoRoot, dependencyRoot)) {
    const resolved = await resolveSafeFile(repoRoot, packagePath);
    let manifest;
    try {
      manifest = JSON.parse(
        await readBounded(resolved.path, MAX_PACKAGE_BYTES, "PACKAGE_MANIFEST_INVALID"),
      );
    } catch (error) {
      if (error?.message === "PACKAGE_MANIFEST_INVALID") throw error;
      fail("PACKAGE_MANIFEST_INVALID");
    }
    validateManifestDependencySources(manifest);
    for (const section of PACKAGE_SECTIONS) {
      const value = manifest?.[section]?.[PLATFORM_PACKAGE];
      if (value !== undefined) versions.add(value);
    }
  }
  if (versions.size !== 1) fail("PLATFORM_PACKAGE_DECLARATION_INVALID");
  const version = [...versions][0];
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
    fail("PLATFORM_PACKAGE_VERSION_NOT_EXACT");
  }
  return version;
}

function dependencySpecifiers(importer) {
  return PACKAGE_SECTIONS.flatMap((section) => {
    const record = importer?.[section];
    const value = record?.[PLATFORM_PACKAGE];
    if (typeof value === "string") return [value];
    if (value && typeof value === "object" && typeof value.specifier === "string") {
      return [value.specifier];
    }
    return [];
  });
}

function verifyPnpmLock(lock, version) {
  const importers = Object.values(lock?.importers ?? {});
  const specs = importers.flatMap(dependencySpecifiers);
  if (!specs.includes(version) || specs.some((value) => value !== version)) {
    fail("PLATFORM_PACKAGE_LOCK_IMPORTER_INVALID");
  }
  const packageEntries = Object.entries(lock?.packages ?? {}).filter(([key]) =>
    key === `${PLATFORM_PACKAGE}@${version}` || key === `/${PLATFORM_PACKAGE}@${version}`,
  );
  if (packageEntries.length !== 1) fail("PLATFORM_PACKAGE_LOCK_ENTRY_INVALID");
  const resolution = packageEntries[0][1]?.resolution;
  if (
    typeof resolution?.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/=]+$/u.test(resolution.integrity) ||
    typeof resolution?.tarball !== "string" ||
    !new RegExp(`^https://npm\\.pkg\\.github\\.com/download/@seorilabs/platform-sdk/${escapeRegExp(version)}/[0-9a-f]{40}$`, "u").test(resolution.tarball)
  ) {
    fail("PLATFORM_PACKAGE_LOCK_RESOLUTION_INVALID");
  }
  return resolution.integrity;
}

function verifyNpmLock(lock, version) {
  const rootImporters = Object.entries(lock?.packages ?? {})
    .filter(([path]) => path === "" || !path.includes("node_modules"))
    .map(([, importer]) => importer);
  const specs = rootImporters.flatMap(dependencySpecifiers);
  if (!specs.includes(version) || specs.some((value) => value !== version)) {
    fail("PLATFORM_PACKAGE_LOCK_IMPORTER_INVALID");
  }
  const entry = lock?.packages?.[`node_modules/${PLATFORM_PACKAGE}`];
  if (
    entry?.version !== version ||
    typeof entry.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/=]+$/u.test(entry.integrity) ||
    typeof entry.resolved !== "string" ||
    !new RegExp(`^https://npm\\.pkg\\.github\\.com/download/@seorilabs/platform-sdk/${escapeRegExp(version)}/[0-9a-f]{40}$`, "u").test(entry.resolved)
  ) {
    fail("PLATFORM_PACKAGE_LOCK_RESOLUTION_INVALID");
  }
  return entry.integrity;
}

function fixedRegistryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("LOCKFILE_REGISTRY_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search ||
    !url.pathname.startsWith("/")
  ) {
    fail("LOCKFILE_REGISTRY_URL_INVALID");
  }
  if (url.origin === PUBLIC_REGISTRY) return;
  if (
    url.origin === PRIVATE_REGISTRY &&
    /^\/download\/@seorilabs\/platform-sdk\/[0-9A-Za-z.-]+\/[0-9a-f]{40}$/u.test(
      url.pathname,
    )
  ) {
    return;
  }
  fail("LOCKFILE_REGISTRY_FORBIDDEN");
}

function validateLockSources(value, field = "", parentField = "") {
  if (Array.isArray(value)) {
    for (const child of value) validateLockSources(child, field, parentField);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) validateLockSources(child, key, field);
    return;
  }
  if (typeof value !== "string") return;
  const sourceBearing =
    ["resolved", "tarball", "repo", "version", "specifier"].includes(field) ||
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].includes(
      parentField,
    );
  if (!sourceBearing) return;
  if (/^https?:\/\//u.test(value)) {
    fixedRegistryUrl(value);
    return;
  }
  if (/^(?:git(?:\+[^:]+)?|github|file):/u.test(value)) {
    fail("LOCKFILE_SOURCE_FORBIDDEN");
  }
  if (value.startsWith("link:")) {
    const target = value.slice("link:".length);
    if (
      target.length === 0 ||
      target.startsWith("/") ||
      target.includes("\\") ||
      target.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      fail("LOCKFILE_LINK_INVALID");
    }
  }
  if (
    ["resolved", "tarball", "repo"].includes(field) &&
    /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|\\)/u.test(value)
  ) {
    fail("LOCKFILE_SOURCE_FORBIDDEN");
  }
}

function validateManifestDependencySources(manifest) {
  for (const section of PACKAGE_SECTIONS) {
    for (const [name, specifier] of Object.entries(manifest?.[section] ?? {})) {
      if (
        typeof specifier !== "string" ||
        /^(?:https?:\/\/|git(?:\+[^:]+)?:|github:|file:|link:)/u.test(specifier) ||
        (name !== PLATFORM_PACKAGE && /^npm:@seorilabs\//u.test(specifier)) ||
        (name.startsWith("@seorilabs/") && name !== PLATFORM_PACKAGE)
      ) {
        fail("PACKAGE_DEPENDENCY_SOURCE_FORBIDDEN");
      }
    }
  }
}

async function validateChildPath(pathValue, repoRoot) {
  if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.includes("\0")) {
    fail("PACKAGE_MANAGER_PATH_INVALID");
  }
  for (const entry of pathValue.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) fail("PACKAGE_MANAGER_PATH_INVALID");
    const canonical = await realpath(entry).catch(() => resolve(entry));
    const fromRepo = relative(repoRoot, canonical);
    if (
      fromRepo === "" ||
      (!fromRepo.startsWith(`..${sep}`) && fromRepo !== ".." && !isAbsolute(fromRepo))
    ) {
      fail("PACKAGE_MANAGER_PATH_APP_CONTROLLED");
    }
  }
}

export async function inspectExactPlatformDependencyV5({
  repoRoot,
  dependencyRoot = ".",
  packageManager,
} = {}) {
  if (!isSafeRelativePosixPath(dependencyRoot, { allowDot: true })) {
    fail("DEPENDENCY_ROOT_INVALID");
  }
  if (!["npm", "pnpm"].includes(packageManager)) fail("PACKAGE_MANAGER_INVALID");
  const canonicalDependency = await resolveSafeDirectory(repoRoot, dependencyRoot);
  const rootManifestRelative = dependencyRoot === "."
    ? "package.json"
    : `${dependencyRoot}/package.json`;
  const rootManifestPath = await resolveSafeFile(canonicalDependency.root, rootManifestRelative);
  let rootManifest;
  try {
    rootManifest = JSON.parse(
      await readBounded(rootManifestPath.path, MAX_PACKAGE_BYTES, "PACKAGE_MANIFEST_INVALID"),
    );
  } catch (error) {
    if (error?.message === "PACKAGE_MANIFEST_INVALID") throw error;
    fail("PACKAGE_MANIFEST_INVALID");
  }
  if (rootManifest.packageManager !== `${packageManager}@${PINNED_PACKAGE_MANAGERS[packageManager]}`) {
    fail("PACKAGE_MANAGER_VERSION_MISMATCH");
  }
  const version = await declaredVersion(canonicalDependency.root, dependencyRoot);
  const lockName = packageManager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  const lockRelative = dependencyRoot === "." ? lockName : `${dependencyRoot}/${lockName}`;
  const lockPath = await resolveSafeFile(canonicalDependency.root, lockRelative);
  let lock;
  try {
    const text = await readBounded(lockPath.path, MAX_LOCK_BYTES, "LOCKFILE_INVALID");
    lock = packageManager === "pnpm" ? parse(text) : JSON.parse(text);
  } catch (error) {
    if (error?.message === "LOCKFILE_INVALID") throw error;
    fail("LOCKFILE_INVALID");
  }
  validateLockSources(lock);
  const integrity = packageManager === "pnpm"
    ? verifyPnpmLock(lock, version)
    : verifyNpmLock(lock, version);
  return Object.freeze({
    package: PLATFORM_PACKAGE,
    version,
    packageManager,
    dependencyRoot,
    lockPath: lockRelative,
    integrity,
  });
}

async function writeTrustedStagingMetadata({
  repoRoot,
  dependencyRoot,
  packageManager,
  lockPath,
  stagingRoot,
}) {
  const packagePaths = trackedPackagePaths(repoRoot, dependencyRoot);
  const prefix = dependencyRoot === "." ? "" : `${dependencyRoot}/`;
  const relativePackagePaths = packagePaths.map((path) => path.slice(prefix.length));
  if (!relativePackagePaths.includes("package.json")) {
    fail("DEPENDENCY_ROOT_PACKAGE_MANIFEST_REQUIRED");
  }
  for (let index = 0; index < packagePaths.length; index += 1) {
    const source = await resolveSafeFile(repoRoot, packagePaths[index]);
    const content = await readBounded(
      source.path,
      MAX_PACKAGE_BYTES,
      "PACKAGE_MANIFEST_INVALID",
    );
    const destination = resolve(stagingRoot, relativePackagePaths[index]);
    assertPathWithin(stagingRoot, destination, "STAGING_METADATA_PATH_INVALID");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { flag: "wx", mode: 0o600 });
  }
  const lock = await resolveSafeFile(repoRoot, lockPath);
  await writeFile(
    join(stagingRoot, packageManager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json"),
    await readBounded(lock.path, MAX_LOCK_BYTES, "LOCKFILE_INVALID"),
    { flag: "wx", mode: 0o600 },
  );
  if (packageManager === "pnpm") {
    const workspaceDirectories = relativePackagePaths
      .filter((path) => path !== "package.json")
      .map((path) => dirname(path));
    await writeFile(
      join(stagingRoot, "pnpm-workspace.yaml"),
      workspaceDirectories.length === 0
        ? "packages: []\n"
        : [
            "packages:",
            ...workspaceDirectories.map((path) => `  - ${JSON.stringify(path)}`),
            "",
          ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
  }
}

async function scanCache(path, root, token, records) {
  const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(child);
      if (Buffer.from(target).indexOf(token) !== -1) fail("DEPENDENCY_TOKEN_PERSISTED");
      records.push(
        `${relative(root, child)}\0symlink\0${createHash("sha256").update(target).digest("hex")}`,
      );
      continue;
    }
    if (entry.isDirectory()) {
      await scanCache(child, root, token, records);
      continue;
    }
    if (!entry.isFile()) fail("DEPENDENCY_CACHE_ENTRY_INVALID");
    const content = await readFile(child);
    if (content.indexOf(token) !== -1) fail("DEPENDENCY_TOKEN_PERSISTED");
    records.push(
      `${relative(root, child)}\0${content.length}\0${createHash("sha256").update(content).digest("hex")}`,
    );
  }
}

export async function stageExactPlatformDependencyV5({
  repoRoot,
  dependencyRoot = ".",
  packageManager,
  cacheRoot,
  token = process.env.NODE_AUTH_TOKEN,
  spawn = spawnSync,
  childEnvironment = process.env,
} = {}) {
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    /[\r\n\0]/u.test(token)
  ) {
    fail("DEPENDENCY_TOKEN_REQUIRED");
  }
  const inspected = await inspectExactPlatformDependencyV5({
    repoRoot,
    dependencyRoot,
    packageManager,
  });
  const canonicalRepo = await resolveSafeDirectory(repoRoot, ".");
  await validateChildPath(childEnvironment?.PATH, canonicalRepo.path);
  const expectedRelative = packageManager === "pnpm"
    ? ".seorilabs-pnpm-store"
    : ".seorilabs-npm-cache";
  const expectedCache = resolve(canonicalRepo.path, expectedRelative);
  const requestedCache = resolve(cacheRoot ?? "");
  const requestedParent = await realpath(dirname(requestedCache)).catch(() => undefined);
  if (
    requestedParent !== canonicalRepo.path ||
    basename(requestedCache) !== expectedRelative
  ) {
    fail("DEPENDENCY_CACHE_PATH_INVALID");
  }
  const existing = await lstat(expectedCache).catch(() => undefined);
  if (existing !== undefined) fail("DEPENDENCY_CACHE_MUST_NOT_EXIST");
  await mkdir(expectedCache, { mode: 0o700 });
  assertPathWithin(canonicalRepo.path, expectedCache, "DEPENDENCY_CACHE_PATH_INVALID");

  const command = packageManager === "pnpm" ? "pnpm" : "npm";
  const args = packageManager === "pnpm"
    ? [
        "install",
        "--frozen-lockfile",
        "--trust-lockfile",
        "--ignore-scripts",
        "--store-dir",
        expectedCache,
        `--registry=${PUBLIC_REGISTRY}`,
      ]
    : [
        "ci",
        "--ignore-scripts",
        "--cache",
        expectedCache,
        `--registry=${PUBLIC_REGISTRY}`,
        "--no-audit",
        "--no-fund",
      ];
  const auditArgs = packageManager === "pnpm"
    ? ["audit", "--audit-level", "high", `--registry=${PUBLIC_REGISTRY}`]
    : ["audit", "--audit-level=high", `--registry=${PUBLIC_REGISTRY}`];
  const stagingRoot = await mkdtemp(join(tmpdir(), "seori-locked-dependencies-"));
  const stagingConfig = join(stagingRoot, ".npmrc");
  const auditConfig = join(stagingRoot, ".npmrc.audit");
  await writeTrustedStagingMetadata({
    repoRoot: canonicalRepo.path,
    dependencyRoot,
    packageManager,
    lockPath: inspected.lockPath,
    stagingRoot,
  });
  await writeFile(
    stagingConfig,
    [
      `registry=${PUBLIC_REGISTRY}`,
      `@seorilabs:registry=${PRIVATE_REGISTRY}`,
      "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}",
      "always-auth=false",
      "ignore-scripts=true",
      "audit=false",
      "fund=false",
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    auditConfig,
    [
      `registry=${PUBLIC_REGISTRY}`,
      `@seorilabs:registry=${PUBLIC_REGISTRY}`,
      "always-auth=false",
      "ignore-scripts=true",
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  let stageResult;
  let auditResult;
  try {
    stageResult = spawn(command, args, {
      // An app-owned .npmrc must never be able to redirect the package token.
      cwd: stagingRoot,
      // Do not forward the workflow's OIDC request variables or unrelated
      // credentials to npm/pnpm. The package child receives one exact token and
      // the minimum process environment required to run the package manager.
      env: packageManagerEnvironment(childEnvironment, token, stagingConfig),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    if (
      stageResult?.status !== 0 ||
      stageResult?.signal !== null ||
      stageResult?.error
    ) {
      fail("DEPENDENCY_STAGE_FAILED");
    }
    auditResult = spawn(command, auditArgs, {
      cwd: stagingRoot,
      // Audit is intentionally tokenless and cannot inherit app or OIDC state.
      env: tokenlessPackageManagerEnvironment(childEnvironment, auditConfig),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (
      auditResult?.status !== 0 ||
      auditResult?.signal !== null ||
      auditResult?.error
    ) {
      fail("DEPENDENCY_AUDIT_FAILED");
    }
  } catch (error) {
    await rm(expectedCache, { force: true, recursive: true });
    throw error;
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }

  const records = [];
  try {
    await scanCache(expectedCache, expectedCache, Buffer.from(token), records);
  } catch (error) {
    await rm(expectedCache, { force: true, recursive: true });
    throw error;
  }
  if (records.length === 0) {
    await rm(expectedCache, { force: true, recursive: true });
    fail("DEPENDENCY_CACHE_EMPTY");
  }
  return Object.freeze({
    schemaVersion: 1,
    ...inspected,
    cachePath: expectedRelative,
    contentDigest: `sha256:${createHash("sha256").update(records.join("\n")).digest("hex")}`,
    tokenPersisted: false,
  });
}

async function main() {
  const [repoRoot, dependencyRoot, packageManager, cacheRoot] = process.argv.slice(2);
  const result = await stageExactPlatformDependencyV5({
    repoRoot,
    dependencyRoot,
    packageManager,
    cacheRoot,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const code = /^[A-Z0-9_]+$/u.test(error?.message ?? "")
      ? error.message
      : "DEPENDENCY_STAGE_FAILED";
    process.stderr.write(`오류: ${code}\n`);
    process.exitCode = 1;
  });
}
