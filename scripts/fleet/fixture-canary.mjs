#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PROFILE_PATTERN = /^(?:react-native|godot)$/u;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")}`;
}

function fail(code) {
  throw new Error(code);
}

export async function runFixtureCanary({ profile, outputPath, repoRoot = "." }) {
  if (!PROFILE_PATTERN.test(profile ?? "") || !outputPath) {
    fail("FIXTURE_CANARY_INPUT_INVALID");
  }
  const sourceText = await readFile(
    resolve(repoRoot, "contracts/workflow-bundle-source.yaml"),
    "utf8",
  );
  const sourceDocument = parseDocument(sourceText, {
    maxAliasCount: 10,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (sourceDocument.errors.length > 0) fail("BUNDLE_SOURCE_INVALID");
  const source = sourceDocument.toJS({ maxAliasCount: 10 });
  const fixture = JSON.parse(
    await readFile(
      resolve(repoRoot, `fixtures/workflow-bundle/${profile}/fixture.json`),
      "utf8",
    ),
  );
  const expectedKeys = ["buildOnly", "profile", "schemaVersion", "static"];
  if (
    JSON.stringify(Object.keys(fixture).sort()) !== JSON.stringify(expectedKeys) ||
    fixture.schemaVersion !== 1 ||
    fixture.profile !== profile ||
    JSON.stringify(fixture.static?.canonicalScripts) !==
      JSON.stringify(source.quality.canonicalScripts) ||
    fixture.buildOnly?.runner !== source.runners.androidSubmit ||
    fixture.buildOnly?.executor !== source.delivery.android.executor ||
    fixture.buildOnly?.artifact !== source.buildWorkflows[profile].artifact ||
    fixture.buildOnly?.marketUpload !== false ||
    fixture.buildOnly?.builderImage !==
      source.delivery.android.builderImages[profile] ||
    !SHA256_PATTERN.test(fixture.buildOnly.builderImage.split("@").at(-1) ?? "")
  ) {
    fail("FIXTURE_CANARY_CONTRACT_MISMATCH");
  }

  const payload = {
    schemaVersion: 1,
    kind: "WORKFLOW_BUNDLE_CONTRACT_FIXTURE",
    profile,
    marketUpload: false,
    fixtureDigest: digest(fixture),
  };
  const evidence = { ...payload, contractProbeSha256: digest(payload) };
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return evidence;
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
  const [profile, outputPath] = process.argv.slice(2);
  try {
    await runFixtureCanary({ profile, outputPath });
  } catch (error) {
    process.stderr.write(
      `오류 [${String(error?.message ?? "FIXTURE_CANARY_FAILED").split(":")[0]}] fixture canary 실패\n`,
    );
    process.exitCode = 1;
  }
}
