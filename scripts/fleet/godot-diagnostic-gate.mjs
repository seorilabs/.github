#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_MARKER = /(?:SCRIPT ERROR|ERROR:)/u;
const SCRIPT_ERROR_MARKER = /SCRIPT ERROR/u;
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) fail("GODOT_DIAGNOSTIC_INPUT_INVALID");
    result[key.slice(2)] = value;
  }
  if (
    argv.length % 2 !== 0 ||
    !result["toolchain-log"] ||
    !result["application-log"]
  ) {
    fail("GODOT_DIAGNOSTIC_INPUT_INVALID");
  }
  return result;
}

function diagnosticLines(log) {
  return log
    .split(/\r?\n/u)
    .map((line) => line.replace(ANSI_ESCAPE, "").trim())
    .filter((line) => line.length > 0 && DIAGNOSTIC_MARKER.test(line));
}

async function readBoundedLog(path) {
  const resolved = resolve(path);
  const metadata = await stat(resolved);
  if (!metadata.isFile() || metadata.size > MAX_LOG_BYTES) {
    fail("GODOT_DIAGNOSTIC_LOG_INVALID");
  }
  return readFile(resolved, "utf8");
}

export function analyzeGodotDiagnostics({ toolchainLog, applicationLog }) {
  const toolchainDiagnostics = diagnosticLines(toolchainLog);
  if (toolchainDiagnostics.some((line) => SCRIPT_ERROR_MARKER.test(line))) {
    fail("GODOT_TOOLCHAIN_SCRIPT_ERROR");
  }

  const toolchainSet = new Set(toolchainDiagnostics);
  const applicationDiagnostics = diagnosticLines(applicationLog);
  const productDiagnostics = applicationDiagnostics.filter(
    (line) => !toolchainSet.has(line),
  );
  if (productDiagnostics.length > 0) fail("GODOT_PRODUCT_DIAGNOSTIC");

  return Object.freeze({
    applicationDiagnosticCount: applicationDiagnostics.length,
    productDiagnosticCount: 0,
    toolchainDiagnosticCount: toolchainSet.size,
  });
}

export async function runGodotDiagnosticGate({
  toolchainLogPath,
  applicationLogPath,
  summaryPath,
}) {
  const result = analyzeGodotDiagnostics({
    toolchainLog: await readBoundedLog(toolchainLogPath),
    applicationLog: await readBoundedLog(applicationLogPath),
  });
  if (summaryPath) {
    await appendFile(
      resolve(summaryPath),
      [
        "### Godot 진단 경계",
        "",
        `- 고정 toolchain 진단: ${result.toolchainDiagnosticCount}건`,
        `- 제품 고유 진단: ${result.productDiagnosticCount}건`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  if (result.toolchainDiagnosticCount > 0) {
    process.stdout.write(
      `::warning title=Godot toolchain diagnostics::고정 runner 환경 진단 ${result.toolchainDiagnosticCount}건을 제품 오류와 분리했습니다.\n`,
    );
  }
  return result;
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
  try {
    const args = parseArguments(process.argv.slice(2));
    await runGodotDiagnosticGate({
      toolchainLogPath: args["toolchain-log"],
      applicationLogPath: args["application-log"],
      summaryPath: args.summary,
    });
  } catch (error) {
    process.stderr.write(
      `오류 [${String(error?.message ?? "GODOT_DIAGNOSTIC_GATE_FAILED").split(":")[0]}] Godot 진단 검증 실패\n`,
    );
    process.exitCode = 1;
  }
}
