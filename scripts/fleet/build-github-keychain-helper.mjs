#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(root, "scripts/fleet/native/github-keychain-helper.swift");
const identifier = "com.seorilabs.fleet.github-keychain-helper";
const teamPattern = /^[A-Z0-9]{10}$/u;
let activeTemporaryRoot;

function fail(message) {
  if (activeTemporaryRoot) {
    rmSync(activeTemporaryRoot, { recursive: true, force: true });
    activeTemporaryRoot = undefined;
  }
  process.stderr.write(`github-keychain-helper-build: ${message}\n`);
  process.exit(64);
}

function parseOptions(argv) {
  const options = new Map();
  for (const argument of argv) {
    const match = argument.match(/^--([a-z-]+)(?:=(.*))?$/u);
    if (!match || options.has(match[1])) fail("invalid or duplicate option");
    options.set(match[1], match[2] ?? true);
  }
  return options;
}

function run(executable, args, { capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(executable, args, {
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveRun({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      } else {
        rejectRun(new Error(`subprocess failed: ${executable}`));
      }
    });
  });
}

if (process.platform !== "darwin") {
  process.stdout.write(`${JSON.stringify({ built: false, reason: "macos-required" })}\n`);
  process.exit(0);
}

const options = parseOptions(process.argv.slice(2));
const fixture = options.get("fixture") === true;
const compileGate = options.get("compile-gate") === true;
if (fixture && compileGate) fail("fixture and compile-gate are mutually exclusive");
const allowed = fixture
  ? ["fixture", "output"]
  : compileGate
    ? ["compile-gate", "output"]
    : ["output", "signing-identity", "team-identifier"];
if ([...options.keys()].some((key) => !allowed.includes(key))) fail("unsupported option");

const outputValue = options.get("output") ??
  (fixture
    ? resolve(root, ".build/github-keychain-helper-fixture")
    : compileGate
      ? resolve(root, ".build/github-keychain-helper-unsigned-gate")
      : undefined);
if (typeof outputValue !== "string" || !isAbsolute(outputValue)) {
  fail("--output must be an absolute path");
}
const output = resolve(outputValue);
const teamIdentifier = fixture || compileGate ? "SEORIFIX01" : options.get("team-identifier");
const signingIdentity = fixture || compileGate ? "-" : options.get("signing-identity");
if (!teamPattern.test(teamIdentifier ?? "")) fail("--team-identifier must be an exact Apple Team ID");
if (!fixture && !compileGate && (typeof signingIdentity !== "string" || signingIdentity.length < 1)) {
  fail("--signing-identity is required for a production build");
}

const temporaryRoot = await mkdtemp(resolve(tmpdir(), "seori-keychain-helper-build-"));
activeTemporaryRoot = temporaryRoot;
const identitySource = resolve(temporaryRoot, "github-keychain-build-identity.swift");
const buildOutput = resolve(temporaryRoot, "github-keychain-helper");
try {
  const outputParent = dirname(output);
  await mkdir(outputParent, { recursive: true, mode: 0o700 });
  const [parentState, parentCanonical] = await Promise.all([
    lstat(outputParent),
    realpath(outputParent),
  ]);
  if (
    !parentState.isDirectory() || parentState.isSymbolicLink() ||
    parentCanonical !== outputParent || (parentState.mode & 0o022) !== 0 ||
    ![0, process.getuid?.()].includes(parentState.uid)
  ) {
    fail("output parent failed ownership boundary validation");
  }
  await writeFile(
    identitySource,
    [
      "enum SeoriKeychainBuildIdentity {",
      `    static let expectedTeamIdentifier = ${JSON.stringify(teamIdentifier)}`,
      `    static let fixture = ${fixture ? "true" : "false"}`,
      "}",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const swiftc = "/usr/bin/xcrun";
  const compileArguments = [
    "swiftc",
    "-O",
    "-whole-module-optimization",
    "-parse-as-library",
    ...(fixture ? ["-D", "SEORI_KEYCHAIN_FIXTURE"] : []),
    source,
    identitySource,
    "-framework",
    "Security",
    "-framework",
    "LocalAuthentication",
    "-o",
    buildOutput,
  ];
  await run(swiftc, compileArguments);
  await run("/usr/bin/codesign", [
    "--force",
    "--sign",
    signingIdentity,
    "--identifier",
    identifier,
    "--options",
    "runtime",
    ...(fixture || compileGate ? [] : ["--timestamp"]),
    buildOutput,
  ]);
  await chmod(buildOutput, 0o555);
  await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", buildOutput]);

  if (compileGate) {
    let value;
    try {
      const attestation = await run(buildOutput, ["attest"], { capture: true });
      value = JSON.parse(attestation.stdout.toString("utf8"));
    } catch (error) {
      const child = spawn(buildOutput, ["attest"], {
        env: { LANG: "C", PATH: "/usr/bin:/bin" },
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const code = await new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", resolveExit);
      });
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        for (const chunk of chunks) chunk.fill(0);
      }
      if (code !== 70) fail("unsigned production branch did not fail closed");
    }
    if (value?.state !== "DENIED" || value?.code !== "CODE_IDENTITY_UNTRUSTED") {
      fail("unsigned production branch code identity gate did not fail closed");
    }
  } else if (!fixture) {
    const attestation = await run(buildOutput, ["attest"], { capture: true });
    let value;
    try {
      value = JSON.parse(attestation.stdout.toString("utf8"));
    } catch {
      fail("signed helper attestation is malformed");
    }
    if (
      attestation.stderr.length !== 0 || value?.state !== "VERIFIED" ||
      value?.codeIdentity?.identifier !== identifier ||
      value?.codeIdentity?.teamIdentifier !== teamIdentifier ||
      value?.codeIdentity?.signed !== true || value?.codeIdentity?.adHoc !== false
    ) {
      fail("signed helper code identity readback did not match");
    }
  }

  await rename(buildOutput, output);
  const [state, canonical, bytes] = await Promise.all([
    lstat(output),
    realpath(output),
    readFile(output),
  ]);
  if (
    !state.isFile() || state.isSymbolicLink() || canonical !== output ||
    (state.mode & 0o022) !== 0 || ![0, process.getuid?.()].includes(state.uid)
  ) {
    fail("signed output failed ownership boundary validation");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  bytes.fill(0);

  process.stdout.write(`${JSON.stringify({
    built: true,
    fixture,
    compileGate,
    identifier,
    output,
    sha256,
    teamIdentifier: fixture || compileGate ? null : teamIdentifier,
  })}\n`);
} catch {
  fail("build failed without exposing subprocess details");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  activeTemporaryRoot = undefined;
}
