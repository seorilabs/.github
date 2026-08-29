import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*$/u;

export function isSafeRelativePosixPath(value, { allowDot = false } = {}) {
  if (value === ".") return allowDot;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      SAFE_SEGMENT.test(segment),
  );
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return !(
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    pathFromRoot.startsWith(sep)
  );
}

async function canonicalRoot(repoRoot) {
  const requested = resolve(repoRoot ?? "");
  const metadata = await lstat(requested).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("REPOSITORY_ROOT_INVALID");
  }
  return realpath(requested);
}

export async function resolveSafeDirectory(repoRoot, relativePath) {
  if (!isSafeRelativePosixPath(relativePath, { allowDot: true })) {
    throw new Error("DIRECTORY_PATH_INVALID");
  }
  const root = await canonicalRoot(repoRoot);
  let current = root;
  if (relativePath !== ".") {
    for (const segment of relativePath.split("/")) {
      current = resolve(current, segment);
      const metadata = await lstat(current).catch(() => undefined);
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("DIRECTORY_PATH_UNTRUSTED");
      }
    }
  }
  const canonical = await realpath(current);
  if (!isWithin(root, canonical)) throw new Error("DIRECTORY_PATH_ESCAPE");
  return Object.freeze({ root, path: canonical });
}

export async function resolveSafeFile(repoRoot, relativePath) {
  if (!isSafeRelativePosixPath(relativePath)) {
    throw new Error("FILE_PATH_INVALID");
  }
  const root = await canonicalRoot(repoRoot);
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    const metadata = await lstat(current).catch(() => undefined);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("FILE_PARENT_UNTRUSTED");
    }
  }
  const requested = resolve(current, segments.at(-1));
  const metadata = await lstat(requested).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error("FILE_PATH_UNTRUSTED");
  }
  const canonical = await realpath(requested);
  if (!isWithin(root, canonical)) throw new Error("FILE_PATH_ESCAPE");
  return Object.freeze({ root, path: canonical });
}

export function assertPathWithin(parent, child, code = "PATH_RELATION_INVALID") {
  if (!isWithin(parent, child)) throw new Error(code);
}
