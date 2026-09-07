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
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

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
const EXACT_STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const PNPM_OVERRIDE_SELECTOR = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))?$/u;
const PACKAGE_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 24 * 1024 * 1024;
const MAX_PNPM_OVERRIDES = 64;
const MAX_AUDIT_EXCEPTION_BYTES = 32 * 1024;
// pnpm 11's lock-graph audit is CPU-bound and takes over 100 seconds on the
// ARM64 ARC runner, so use the same bounded window as the locked install.
const DEPENDENCY_AUDIT_TIMEOUT_MS = 300_000;
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY_ID = /^[1-9][0-9]{0,31}$/u;
const FULL_NAME = /^seorilabs\/[A-Za-z0-9._-]+$/u;
const GHSA = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function decodeDependencyAuditException(encoded) {
  if (encoded === undefined || encoded === null || encoded === "") return null;
  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(MAX_AUDIT_EXCEPTION_BYTES * 4 / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
  }
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (
      bytes.length === 0 ||
      bytes.length > MAX_AUDIT_EXCEPTION_BYTES ||
      bytes.toString("base64url") !== encoded
    ) {
      fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
    }
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error?.message === "DEPENDENCY_AUDIT_EXCEPTION_INVALID") throw error;
    fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
  }
}

function validateDependencyAuditException({
  value,
  actionClass,
  repositoryId,
  fullName,
  sourceSha,
  lockfileSha256,
  now,
}) {
  if (value === null) return null;
  const topLevelKeys = [
    "schemaVersion",
    "repositoryId",
    "fullName",
    "expiresAt",
    "reason",
    "bindings",
    "advisories",
  ];
  const bindingKeys = ["actionClass", "sourceSha", "lockfileSha256"];
  const advisoryKeys = ["ghsa", "module", "severity", "versions"];
  if (
    !exactKeys(value, topLevelKeys) ||
    value.schemaVersion !== 1 ||
    value.repositoryId !== repositoryId ||
    value.fullName !== fullName ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now.getTime() ||
    typeof value.reason !== "string" ||
    value.reason.length < 1 ||
    value.reason.length > 500 ||
    /[\r\n\0]/u.test(value.reason) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length !== 2 ||
    !Array.isArray(value.advisories) ||
    value.advisories.length < 1 ||
    value.advisories.length > 16
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
  }
  const expectedActions = ["ANDROID_BUILD_ONLY", "STATIC_CHECK"];
  if (
    canonicalJson(value.bindings.map((binding) => binding?.actionClass).sort()) !==
      canonicalJson(expectedActions)
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
  }
  for (const binding of value.bindings) {
    if (
      !exactKeys(binding, bindingKeys) ||
      !expectedActions.includes(binding.actionClass) ||
      !SHA.test(binding.sourceSha ?? "") ||
      !SHA256.test(binding.lockfileSha256 ?? "")
    ) {
      fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
    }
  }
  const advisoryKeysSeen = [];
  for (const advisory of value.advisories) {
    if (
      !exactKeys(advisory, advisoryKeys) ||
      !GHSA.test(advisory.ghsa ?? "") ||
      !PACKAGE_NAME.test(advisory.module ?? "") ||
      advisory.severity !== "high" ||
      !Array.isArray(advisory.versions) ||
      advisory.versions.length < 1 ||
      advisory.versions.length > 16 ||
      advisory.versions.some((version) => !EXACT_VERSION.test(version)) ||
      canonicalJson(advisory.versions) !== canonicalJson([...new Set(advisory.versions)].sort())
    ) {
      fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
    }
    advisoryKeysSeen.push(`${advisory.ghsa}:${advisory.module}`);
  }
  if (
    canonicalJson(advisoryKeysSeen) !== canonicalJson([...new Set(advisoryKeysSeen)].sort())
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_INVALID");
  }
  const binding = value.bindings.find((candidate) => candidate.actionClass === actionClass);
  if (
    !binding ||
    binding.sourceSha !== sourceSha ||
    binding.lockfileSha256 !== lockfileSha256
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_BINDING_MISMATCH");
  }
  return Object.freeze(structuredClone(value));
}

function auditedAdvisories(stdout) {
  let report;
  try {
    report = JSON.parse(stdout ?? "");
  } catch {
    fail("DEPENDENCY_AUDIT_REPORT_INVALID");
  }
  if (
    report === null ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.advisories === null ||
    typeof report.advisories !== "object" ||
    Array.isArray(report.advisories)
  ) {
    fail("DEPENDENCY_AUDIT_REPORT_INVALID");
  }
  const advisories = [];
  for (const advisory of Object.values(report.advisories)) {
    if (!advisory || !["high", "critical"].includes(advisory.severity)) continue;
    const versions = [...new Set(
      Array.isArray(advisory.findings)
        ? advisory.findings.map((finding) => finding?.version)
        : [],
    )].sort();
    if (
      !GHSA.test(advisory.github_advisory_id ?? "") ||
      !PACKAGE_NAME.test(advisory.module_name ?? "") ||
      versions.length < 1 ||
      versions.some((version) => !EXACT_VERSION.test(version))
    ) {
      fail("DEPENDENCY_AUDIT_REPORT_INVALID");
    }
    advisories.push({
      ghsa: advisory.github_advisory_id,
      module: advisory.module_name,
      severity: advisory.severity,
      versions,
    });
  }
  return advisories.sort((left, right) =>
    `${left.ghsa}:${left.module}`.localeCompare(`${right.ghsa}:${right.module}`),
  );
}

// 감사 실패는 앱 저장소 owner가 조치해야 하므로 코드만 던지지 않고 차단 사유가 된
// high/critical advisory 공개 식별자를 그대로 덧붙인다. 값은 GHSA ID, 패키지 이름,
// severity, 정확한 버전뿐이며 token·registry 자격증명은 포함하지 않는다.
function blockingAdvisorySummary(result) {
  let advisories;
  try {
    advisories = auditedAdvisories(result?.stdout);
  } catch {
    return "";
  }
  if (advisories.length === 0) return "";
  return `:${advisories
    .map(({ ghsa, module, severity, versions }) =>
      `${ghsa}/${module}/${severity}/${versions.join("+")}`,
    )
    .join(",")}`;
}

function acceptAuditResult(result, exception) {
  if (result?.status === 0 && result?.signal === null && !result?.error) {
    if (exception !== null) fail("DEPENDENCY_AUDIT_EXCEPTION_UNUSED");
    return null;
  }
  if (
    result?.status === 1 &&
    result?.signal === null &&
    !result?.error &&
    exception === null
  ) {
    fail(`DEPENDENCY_AUDIT_FAILED${blockingAdvisorySummary(result)}`);
  }
  if (
    result?.status !== 1 ||
    result?.signal !== null ||
    result?.error ||
    exception === null
  ) {
    fail("DEPENDENCY_AUDIT_FAILED");
  }
  const actual = auditedAdvisories(result.stdout);
  if (
    actual.some((advisory) => advisory.severity === "critical") ||
    canonicalJson(actual) !== canonicalJson(exception.advisories)
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_MISMATCH");
  }
  return `sha256:${createHash("sha256").update(canonicalJson(exception)).digest("hex")}`;
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

// Platform #113 이후 @seorilabs/platform-sdk 는 공개 npm 패키지다. 두 해석 형태를
// 모두 받는다.
//
//   공개 npm  — pnpm 은 기본 레지스트리라 tarball 을 적지 않고, npm 은 공개 tarball URL 을 적는다
//   과거 GitHub Packages — v0.4.x 이하 lockfile 이 실제로 담고 있는 값이라 계속 받는다
//
// 어느 쪽도 아니면 제3의 레지스트리를 가리키는 것이므로 거부한다.
function platformResolutionAllowed(version, url) {
  if (url === undefined || url === null) return "public";
  if (typeof url !== "string") return null;
  if (url === `${PUBLIC_REGISTRY}/@seorilabs/platform-sdk/-/platform-sdk-${version}.tgz`) {
    return "public";
  }
  if (
    new RegExp(
      `^${escapeRegExp(PRIVATE_REGISTRY)}/download/@seorilabs/platform-sdk/${escapeRegExp(version)}/[0-9a-f]{40}$`,
      "u",
    ).test(url)
  ) {
    return "private";
  }
  return null;
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
    platformResolutionAllowed(version, resolution.tarball) === null
  ) {
    fail("PLATFORM_PACKAGE_LOCK_RESOLUTION_INVALID");
  }
  return {
    integrity: resolution.integrity,
    registry: platformResolutionAllowed(version, resolution.tarball),
  };
}

function validatedPnpmOverrides(value) {
  if (value === undefined) return Object.freeze({});
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail("PNPM_OVERRIDES_INVALID");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PNPM_OVERRIDES) fail("PNPM_OVERRIDES_INVALID");
  const normalized = Object.create(null);
  for (const [selector, target] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (
      !PNPM_OVERRIDE_SELECTOR.test(selector) ||
      typeof target !== "string" ||
      !EXACT_STABLE_VERSION.test(target)
    ) {
      fail("PNPM_OVERRIDE_SOURCE_FORBIDDEN");
    }
    normalized[selector] = target;
  }
  return Object.freeze(normalized);
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
  // npm lockfile 은 공개 레지스트리에서도 resolved 를 적으므로 문자열을 요구한다.
  if (
    entry?.version !== version ||
    typeof entry.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/=]+$/u.test(entry.integrity) ||
    typeof entry.resolved !== "string" ||
    platformResolutionAllowed(version, entry.resolved) === null
  ) {
    fail("PLATFORM_PACKAGE_LOCK_RESOLUTION_INVALID");
  }
  return {
    integrity: entry.integrity,
    registry: platformResolutionAllowed(version, entry.resolved),
  };
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
  // directory resolution도 저장소 안이어야 한다. lockfile이 바깥 경로를 가리키면 거부한다.
  if (field === "directory" && parentField === "resolution") {
    if (inRepoPackageTarget(`file:${value}`) === null) fail("LOCKFILE_SOURCE_FORBIDDEN");
    return;
  }
  if (!sourceBearing) return;
  if (/^https?:\/\//u.test(value)) {
    fixedRegistryUrl(value);
    return;
  }
  if (value.startsWith("file:")) {
    if (inRepoPackageTarget(value) === null) fail("LOCKFILE_SOURCE_FORBIDDEN");
  } else if (/^(?:git(?:\+[^:]+)?|github):/u.test(value)) {
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

// 저장소 안에 있는 package를 가리키는 file: 지정자만 허용한다. capacitor 앱은 자기 native
// 플러그인을 이렇게 참조하며, 그 바이트는 이미 검증한 checkout 안에 있으므로 offline 설치에서
// 외부 source가 늘지 않는다. workspace를 벗어나거나 절대 경로면 그대로 거부한다.
function inRepoPackageTarget(value) {
  if (typeof value !== "string" || !value.startsWith("file:")) return null;
  const target = value.slice("file:".length);
  if (
    target.length === 0 ||
    target.startsWith("/") ||
    target.includes("\\") ||
    /^[A-Za-z]:/u.test(target) ||
    target.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return target;
}

function inRepoPackageTargets(manifest) {
  const targets = new Set();
  for (const section of PACKAGE_SECTIONS) {
    for (const specifier of Object.values(manifest?.[section] ?? {})) {
      const target = inRepoPackageTarget(specifier);
      if (target !== null) targets.add(target);
    }
  }
  return targets;
}

function validateManifestDependencySources(manifest) {
  for (const section of PACKAGE_SECTIONS) {
    for (const [name, specifier] of Object.entries(manifest?.[section] ?? {})) {
      const inRepo = inRepoPackageTarget(specifier) !== null;
      if (
        typeof specifier !== "string" ||
        (!inRepo && /^(?:https?:\/\/|git(?:\+[^:]+)?:|github:|file:|link:)/u.test(specifier)) ||
        (name !== PLATFORM_PACKAGE && /^npm:@seorilabs\//u.test(specifier)) ||
        (name.startsWith("@seorilabs/") && name !== PLATFORM_PACKAGE && !inRepo)
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
  const pnpmOverrides = packageManager === "pnpm"
    ? validatedPnpmOverrides(lock?.overrides)
    : Object.freeze({});
  const {integrity, registry} = packageManager === "pnpm"
    ? verifyPnpmLock(lock, version)
    : verifyNpmLock(lock, version);
  return Object.freeze({
    package: PLATFORM_PACKAGE,
    version,
    packageManager,
    dependencyRoot,
    lockPath: lockRelative,
    integrity,
    // lockfile 이 실제로 가리키는 레지스트리. staging npmrc 가 이걸 따라간다.
    registry,
    pnpmOverrides,
  });
}

async function writeTrustedStagingMetadata({
  repoRoot,
  dependencyRoot,
  packageManager,
  lockPath,
  pnpmOverrides,
  stagingRoot,
}) {
  const packagePaths = trackedPackagePaths(repoRoot, dependencyRoot);
  const prefix = dependencyRoot === "." ? "" : `${dependencyRoot}/`;
  const relativePackagePaths = packagePaths.map((path) => path.slice(prefix.length));
  if (!relativePackagePaths.includes("package.json")) {
    fail("DEPENDENCY_ROOT_PACKAGE_MANIFEST_REQUIRED");
  }
  // file: 로 참조하는 저장소 안 package는 workspace 멤버가 아니다. manifest는 staging으로
  // 옮기되 workspace 목록에서는 빼야 --frozen-lockfile이 importer 불일치로 깨지지 않는다.
  const linkedPackageDirectories = new Set();
  for (let index = 0; index < packagePaths.length; index += 1) {
    const source = await resolveSafeFile(repoRoot, packagePaths[index]);
    const content = await readBounded(
      source.path,
      MAX_PACKAGE_BYTES,
      "PACKAGE_MANIFEST_INVALID",
    );
    let manifest;
    try {
      manifest = JSON.parse(content);
    } catch {
      fail("PACKAGE_MANIFEST_INVALID");
    }
    const manifestPrefix = relativePackagePaths[index] === "package.json"
      ? ""
      : `${dirname(relativePackagePaths[index])}/`;
    for (const target of inRepoPackageTargets(manifest)) {
      linkedPackageDirectories.add(`${manifestPrefix}${target}`);
    }
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
      .map((path) => dirname(path))
      .filter((path) => !linkedPackageDirectories.has(path));
    const workspace = workspaceDirectories.length === 0
      ? ["packages: []"]
      : ["packages:", ...workspaceDirectories.map((path) => `  - ${JSON.stringify(path)}`)];
    const overrides = Object.entries(pnpmOverrides ?? {});
    if (overrides.length > 0) {
      workspace.push(
        "overrides:",
        ...overrides.map(([selector, target]) =>
          `  ${JSON.stringify(selector)}: ${JSON.stringify(target)}`),
      );
    }
    await writeFile(
      join(stagingRoot, "pnpm-workspace.yaml"),
      `${workspace.join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
}

// pnpm은 store에 v11/projects/<hash> 같은 host 전용 project 색인을 심볼릭 링크로 남긴다.
// 격리된 stagingRoot는 staging 뒤 삭제되므로 그 링크는 dangling이 되고, 이후 gcloud builds
// submit이 소스 tar를 만들며 FileNotFoundError로 크래시한다. offline install에 필요 없는
// dangling 링크만 제거하고 정상 링크와 파일은 그대로 둔다.
async function pruneDanglingSymlinks(path) {
  const entries = await readdir(path, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await stat(child).catch(() => undefined);
      if (!target) {
        await rm(child, { force: true });
        removed += 1;
      }
      continue;
    }
    if (entry.isDirectory()) {
      removed += await pruneDanglingSymlinks(child);
      const remaining = await readdir(child);
      if (remaining.length === 0) await rm(child, { force: true, recursive: true });
    }
  }
  return removed;
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
  dependencyAuditException = null,
  auditActionClass,
  repositoryId,
  fullName,
  sourceSha,
  // 감사 예외가 결합되는 기본 브랜치 exact source. 후보 PR 실행은 checkout(sourceSha)이
  // merge 커밋이므로 base를 따로 받고, 없으면 sourceSha와 같다.
  bindingSourceSha = sourceSha,
  now = () => new Date(),
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
  const current = now();
  if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_CLOCK_INVALID");
  }
  let actualSourceSha;
  try {
    actualSourceSha = execFileSync("git", ["-C", canonicalRepo.path, "rev-parse", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail("DEPENDENCY_SOURCE_SHA_READ_FAILED");
  }
  if (
    (dependencyAuditException !== null || auditActionClass !== undefined) &&
    (
      !["ANDROID_BUILD_ONLY", "STATIC_CHECK"].includes(auditActionClass) ||
      !REPOSITORY_ID.test(repositoryId ?? "") ||
      !FULL_NAME.test(fullName ?? "") ||
      !SHA.test(sourceSha ?? "") ||
      sourceSha !== actualSourceSha ||
      !SHA.test(bindingSourceSha ?? "")
    )
  ) {
    fail("DEPENDENCY_AUDIT_EXCEPTION_CONTEXT_INVALID");
  }
  const lockBytes = await readFile(join(canonicalRepo.path, inspected.lockPath));
  const lockfileSha256 = `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`;
  const validatedAuditException = validateDependencyAuditException({
    value: dependencyAuditException,
    actionClass: auditActionClass,
    repositoryId,
    fullName,
    sourceSha: bindingSourceSha,
    lockfileSha256,
    now: current,
  });
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
    ? ["audit", "--audit-level", "high", "--json", `--registry=${PUBLIC_REGISTRY}`]
    : ["audit", "--audit-level=high", "--json", `--registry=${PUBLIC_REGISTRY}`];
  const stagingRoot = await mkdtemp(join(tmpdir(), "seori-locked-dependencies-"));
  const stagingConfig = join(stagingRoot, ".npmrc");
  const auditConfig = join(stagingRoot, ".npmrc.audit");
  await writeTrustedStagingMetadata({
    repoRoot: canonicalRepo.path,
    dependencyRoot,
    packageManager,
    lockPath: inspected.lockPath,
    pnpmOverrides: inspected.pnpmOverrides,
    stagingRoot,
  });
  // lockfile 이 가리키는 레지스트리를 그대로 따라간다. 공개 npm 이면 토큰 줄을 쓰지
  // 않는다. 필요 없는 인증을 남기면 토큰이 없다는 이유로 설치가 막힌다.
  await writeFile(
    stagingConfig,
    [
      `registry=${PUBLIC_REGISTRY}`,
      ...(inspected.registry === "private"
        ? [
            `@seorilabs:registry=${PRIVATE_REGISTRY}`,
            "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}",
          ]
        : [`@seorilabs:registry=${PUBLIC_REGISTRY}`]),
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
  let dependencyAuditExceptionDigest = null;
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
      timeout: DEPENDENCY_AUDIT_TIMEOUT_MS,
    });
    dependencyAuditExceptionDigest = acceptAuditResult(
      auditResult,
      validatedAuditException,
    );
  } catch (error) {
    await rm(expectedCache, { force: true, recursive: true });
    throw error;
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }

  const records = [];
  try {
    await pruneDanglingSymlinks(expectedCache);
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
    dependencyAuditExceptionDigest,
  });
}

async function main() {
  const [repoRoot, dependencyRoot, packageManager, cacheRoot, encodedAuditException = ""] =
    process.argv.slice(2);
  const result = await stageExactPlatformDependencyV5({
    repoRoot,
    dependencyRoot,
    packageManager,
    cacheRoot,
    dependencyAuditException: decodeDependencyAuditException(encodedAuditException),
    auditActionClass: encodedAuditException ? process.env.SEORI_AUDIT_ACTION_CLASS : undefined,
    repositoryId: encodedAuditException ? process.env.SEORI_REPOSITORY_ID : undefined,
    fullName: encodedAuditException ? process.env.SEORI_REPOSITORY : undefined,
    sourceSha: encodedAuditException ? process.env.SEORI_SOURCE_SHA : undefined,
    ...(encodedAuditException && process.env.SEORI_BINDING_SOURCE_SHA
      ? { bindingSourceSha: process.env.SEORI_BINDING_SOURCE_SHA }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    const code = /^[A-Z0-9_]+$/u.test(error?.message ?? "")
      ? error.message
      : "DEPENDENCY_STAGE_FAILED";
    process.stderr.write(`오류: ${code}\n`);
    process.exitCode = 1;
  });
}
