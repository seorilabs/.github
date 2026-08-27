#!/usr/bin/env node

import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const MAX_SCANNED_BYTES = 2 * 1024 * 1024;
const RULES = Object.freeze([
  ["PRIVATE_KEY", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u],
  ["GITHUB_TOKEN", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["AWS_ACCESS_KEY", /\bAKIA[0-9A-Z]{16}\b/u],
  ["GOOGLE_API_KEY", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["SERVICE_ACCOUNT_PRIVATE_KEY", /["']private_key["']\s*:\s*["'][^"']{20,}/u],
]);

function trackedFiles(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error("GIT_LS_FILES_FAILED");
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

export async function scanTrackedSecrets({ repoRoot } = {}) {
  const canonicalRoot = await realpath(repoRoot);
  const findings = [];
  for (const file of trackedFiles(canonicalRoot)) {
    const absolutePath = resolve(canonicalRoot, file);
    const relativePath = relative(canonicalRoot, absolutePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath.startsWith(sep)
    ) {
      throw new Error("TRACKED_PATH_ESCAPE");
    }

    const metadata = await lstat(absolutePath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_SCANNED_BYTES
    ) {
      continue;
    }
    const buffer = await readFile(absolutePath);
    if (buffer.includes(0)) {
      continue;
    }
    const content = buffer.toString("utf8");
    for (const [rule, pattern] of RULES) {
      if (pattern.test(content)) {
        findings.push({ file, rule });
      }
    }
  }
  return findings;
}

export async function runSecretScanCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const repoRoot = argv[0];
  if (!repoRoot || argv.length !== 1) {
    stderr.write("오류 [ARGUMENT_INVALID] 사용법: secret-scan.mjs 저장소경로\n");
    return 2;
  }
  try {
    const findings = await scanTrackedSecrets({ repoRoot });
    if (findings.length > 0) {
      for (const finding of findings) {
        stderr.write(`오류 [${finding.rule}] ${finding.file}\n`);
      }
      return 1;
    }
    stdout.write("중앙 high-confidence secret scan 통과\n");
    return 0;
  } catch (error) {
    const code = String(error?.message ?? "SECRET_SCAN_FAILED").split(":")[0];
    stderr.write(`오류 [${code}] secret scan을 완료할 수 없습니다.\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runSecretScanCli();
}
