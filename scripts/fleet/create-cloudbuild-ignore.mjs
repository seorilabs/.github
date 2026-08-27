#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const MANDATORY_EXCLUDES = Object.freeze([
  ".git",
  ".git/**",
  ".fleet.gcloudignore",
  ".seorilabs-org",
  ".seorilabs-org/**",
  "gha-creds-*.json",
  "**/gha-creds-*.json",
  "node_modules",
  "**/node_modules/**",
]);

export async function createCloudBuildIgnore({ outputPath, repositoryIgnorePath } = {}) {
  if (!outputPath) {
    throw new Error("OUTPUT_PATH_REQUIRED");
  }
  let repositoryRules = "";
  if (repositoryIgnorePath) {
    try {
      repositoryRules = await readFile(repositoryIgnorePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const content = [
    "# Generated for one Cloud Build submit. Do not commit.",
    repositoryRules.trimEnd(),
    "# Mandatory credential and control-plane exclusions follow last.",
    ...MANDATORY_EXCLUDES,
    "",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
  await writeFile(outputPath, content, { encoding: "utf8", mode: 0o600 });
  return content;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outputPath, repositoryIgnorePath] = process.argv.slice(2);
  try {
    await createCloudBuildIgnore({ outputPath, repositoryIgnorePath });
  } catch (error) {
    const code = String(error?.message ?? "IGNORE_GENERATION_FAILED").split(":")[0];
    process.stderr.write(`오류 [${code}] Cloud Build ignore 생성 실패\n`);
    process.exitCode = 1;
  }
}
