#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_PACKAGE = "@seorilabs/platform-sdk";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PACKAGE_JSON_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;

function fail(code) {
  throw new Error(code);
}

async function requiredRegularFile(path, maxBytes) {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    fail("PRIVATE_PACKAGE_INPUT_INVALID");
  }
  return readFile(path, "utf8");
}

function trackedPackageJsonPaths(applicationRoot) {
  let output;
  try {
    output = execFileSync(
      "git",
      [
        "-C",
        applicationRoot,
        "ls-files",
        "-z",
        "--",
        "package.json",
        ":(glob)**/package.json",
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    fail("TRACKED_PACKAGE_DISCOVERY_FAILED");
  }
  const paths = output.split("\0").filter(Boolean);
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    fail("TRACKED_PACKAGE_DISCOVERY_INVALID");
  }
  return paths;
}

async function discoverPlatformVersion(applicationRoot) {
  const versions = new Set();
  for (const trackedPath of trackedPackageJsonPaths(applicationRoot)) {
    const absolutePath = resolve(applicationRoot, trackedPath);
    const pathFromRoot = relative(applicationRoot, absolutePath);
    if (
      pathFromRoot.startsWith(`..${sep}`) ||
      pathFromRoot === ".." ||
      resolve(applicationRoot, pathFromRoot) !== absolutePath
    ) {
      fail("TRACKED_PACKAGE_PATH_INVALID");
    }
    let manifest;
    try {
      manifest = JSON.parse(
        await requiredRegularFile(absolutePath, MAX_PACKAGE_JSON_BYTES),
      );
    } catch {
      fail("TRACKED_PACKAGE_MANIFEST_INVALID");
    }
    for (const section of PACKAGE_JSON_SECTIONS) {
      const value = manifest?.[section]?.[PLATFORM_PACKAGE];
      if (value !== undefined) versions.add(value);
    }
  }
  if (
    versions.size !== 1 ||
    !EXACT_VERSION.test([...versions][0] ?? "")
  ) {
    fail("PLATFORM_PACKAGE_VERSION_NOT_EXACT");
  }
  return [...versions][0];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function verifyLockfile(applicationRoot, version) {
  const lockfile = await requiredRegularFile(
    resolve(applicationRoot, "pnpm-lock.yaml"),
    MAX_LOCKFILE_BYTES,
  );
  const escapedVersion = escapeRegExp(version);
  const packageHeader = new RegExp(
    `^  '${escapeRegExp(PLATFORM_PACKAGE)}@${escapedVersion}':\\s*$`,
    "gmu",
  );
  const starts = [...lockfile.matchAll(packageHeader)].map((match) => match.index);
  const expectedResolution = new RegExp(
    `^    resolution: \\{integrity: sha512-[A-Za-z0-9+/=]+, tarball: https://npm\\.pkg\\.github\\.com/download/${escapeRegExp(PLATFORM_PACKAGE)}/${escapedVersion}/[0-9a-f]{40}\\}\\s*$`,
    "mu",
  );
  const matchingBlocks = starts.filter((start) => {
    const next = lockfile.indexOf("\n  '", start + 1);
    const block = lockfile.slice(start, next === -1 ? undefined : next);
    return expectedResolution.test(block);
  });
  if (matchingBlocks.length !== 1) {
    fail("PLATFORM_PACKAGE_LOCKFILE_UNTRUSTED");
  }
}

async function assertEmptyStoreTarget(applicationRoot, storePath) {
  const expected = resolve(applicationRoot, ".seorilabs-pnpm-store");
  if (storePath !== expected || dirname(storePath) !== applicationRoot) {
    fail("PRIVATE_PACKAGE_STORE_PATH_INVALID");
  }
  const existing = await lstat(storePath).catch(() => undefined);
  if (existing !== undefined) {
    fail("PRIVATE_PACKAGE_STORE_MUST_NOT_EXIST");
  }
  await mkdir(storePath, { mode: 0o700 });
  if ((await realpath(storePath)) !== storePath) {
    fail("PRIVATE_PACKAGE_STORE_PATH_INVALID");
  }
}

async function scanStore(path, storeRoot, tokenBytes, totals) {
  const entries = (await readdir(path, { withFileTypes: true })).sort(
    (left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) fail("PRIVATE_PACKAGE_STORE_SYMLINK_FORBIDDEN");
    if (entry.isDirectory()) {
      await scanStore(child, storeRoot, tokenBytes, totals);
      continue;
    }
    if (!entry.isFile()) fail("PRIVATE_PACKAGE_STORE_ENTRY_INVALID");
    const content = await readFile(child);
    totals.files += 1;
    totals.bytes += content.length;
    totals.records.push(
      `${relative(storeRoot, child)}\0${createHash("sha256")
        .update(content)
        .digest("hex")}\0${content.length}`,
    );
    if (content.indexOf(tokenBytes) !== -1) {
      fail("PRIVATE_PACKAGE_TOKEN_PERSISTED");
    }
  }
}

export async function stagePrivatePnpmStore({
  applicationRoot,
  storePath,
  token = process.env.NODE_AUTH_TOKEN,
  pnpmCommand = "pnpm",
  childEnvironment = process.env,
} = {}) {
  if (typeof token !== "string" || token.length < 20) {
    fail("PRIVATE_PACKAGE_TOKEN_REQUIRED");
  }
  const requestedRoot = resolve(applicationRoot ?? "");
  const rootMetadata = await lstat(requestedRoot).catch(() => undefined);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("APPLICATION_ROOT_INVALID");
  }
  const root = await realpath(requestedRoot).catch(() => undefined);
  if (!root) fail("APPLICATION_ROOT_INVALID");
  const version = await discoverPlatformVersion(root);
  await verifyLockfile(root, version);
  if (
    resolve(storePath ?? "") !==
    resolve(requestedRoot, ".seorilabs-pnpm-store")
  ) {
    fail("PRIVATE_PACKAGE_STORE_PATH_INVALID");
  }
  const resolvedStore = resolve(root, ".seorilabs-pnpm-store");
  await assertEmptyStoreTarget(root, resolvedStore);

  const packageSpec = `${PLATFORM_PACKAGE}@${version}`;
  const result = spawnSync(
    pnpmCommand,
    ["store", "add", packageSpec, "--store-dir", resolvedStore],
    {
      cwd: root,
      env: { ...childEnvironment, NODE_AUTH_TOKEN: token },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0 || result.signal !== null || result.error) {
    await rm(resolvedStore, { force: true, recursive: true });
    fail("PRIVATE_PACKAGE_STAGE_FAILED");
  }

  const totals = { bytes: 0, files: 0, records: [] };
  try {
    await scanStore(resolvedStore, resolvedStore, Buffer.from(token), totals);
  } catch (error) {
    await rm(resolvedStore, { force: true, recursive: true });
    throw error;
  }
  if (totals.files === 0 || totals.bytes === 0) {
    await rm(resolvedStore, { force: true, recursive: true });
    fail("PRIVATE_PACKAGE_STORE_EMPTY");
  }

  return Object.freeze({
    schemaVersion: 1,
    package: PLATFORM_PACKAGE,
    version,
    storePath: ".seorilabs-pnpm-store",
    contentDigest: `sha256:${createHash("sha256")
      .update(totals.records.join("\n"))
      .digest("hex")}`,
    tokenPersisted: false,
  });
}

async function main() {
  if (process.argv.length !== 4) fail("USAGE_INVALID");
  const result = await stagePrivatePnpmStore({
    applicationRoot: process.argv[2],
    storePath: process.argv[3],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1]
  ? realpathSync(resolve(process.argv[1]))
  : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = /^[_A-Z0-9]+$/u.test(error?.message ?? "")
      ? error.message
      : "PRIVATE_PACKAGE_STAGE_FAILED";
    process.stderr.write(`오류: ${code}\n`);
    process.exitCode = 1;
  });
}
