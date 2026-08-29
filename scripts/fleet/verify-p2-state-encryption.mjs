#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

import {
  StateEncryptionError,
  attestStateEncryption,
  buildRetainVolumeList,
  verifyRetainVolumeDryRun,
} from "../../tools/seori-auth/src/state-encryption.mjs";

const contractPath = fileURLToPath(
  new URL("../../contracts/fleet-p3-runtime.yaml", import.meta.url),
);
const mode = process.argv[2];
const context = "vzyx-cluster";
const mountInfoPath =
  process.env.SEORILABS_STATE_MOUNTINFO ?? `/proc/${process.pid}/mountinfo`;
const lsblk = process.env.SEORILABS_STATE_LSBLK ?? "/usr/bin/lsblk";
const hostname = process.env.SEORILABS_STATE_HOSTNAME ?? "/usr/bin/hostname";
const kubectl = process.env.SEORILABS_KUBECTL ?? "/usr/local/bin/kubectl";
const fixtureRuntime = process.env.SEORILABS_STATE_FIXTURE_RUNTIME;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exit(1);
}

if (!new Set(["host", "server-dry-run"]).has(mode) || process.argv.length !== 3) {
  fail("STATE_ENCRYPTION_COMMAND_INVALID");
}

function canonicalRegularPath(path, code, executable = false) {
  try {
    const entry = lstatSync(path);
    if (
      !isAbsolute(path) || !entry.isFile() || entry.isSymbolicLink() ||
      realpathSync(path) !== path || (executable && (entry.mode & 0o111) === 0)
    ) fail(code);
    return path;
  } catch {
    fail(code);
  }
}

function childEnvironment() {
  return {
    LANG: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...(process.env.KUBECONFIG === undefined
      ? {}
      : { KUBECONFIG: process.env.KUBECONFIG }),
    ...(process.env.SEORILABS_STATE_FIXTURE_SCENARIO === undefined
      ? {}
      : {
          SEORILABS_STATE_FIXTURE_SCENARIO:
            process.env.SEORILABS_STATE_FIXTURE_SCENARIO,
        }),
    ...(process.env.SEORILABS_STATE_FIXTURE_LOG === undefined
      ? {}
      : { SEORILABS_STATE_FIXTURE_LOG: process.env.SEORILABS_STATE_FIXTURE_LOG }),
  };
}

function run(executable, args, code, input = undefined) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      env: childEnvironment(),
      input,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
  } catch {
    fail(code);
  }
}

function runCommand(executable, args, code, input = undefined) {
  const commandPath = canonicalRegularPath(executable, code, true);
  if (fixtureRuntime === undefined) {
    return run(commandPath, args, code, input);
  }
  if (
    process.env.SEORILABS_STATE_FIXTURE_SCENARIO === undefined ||
    process.env.SEORILABS_STATE_LSBLK === undefined ||
    process.env.SEORILABS_STATE_HOSTNAME === undefined ||
    process.env.SEORILABS_KUBECTL === undefined
  ) {
    fail("STATE_ENCRYPTION_FIXTURE_RUNTIME_INVALID");
  }
  const runtimePath = canonicalRegularPath(
    fixtureRuntime,
    "STATE_ENCRYPTION_FIXTURE_RUNTIME_INVALID",
    true,
  );
  return run(runtimePath, [commandPath, ...args], code, input);
}

function publicJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function loadState() {
  let bytes;
  try {
    bytes = readFileSync(contractPath);
    if (bytes.length === 0 || bytes.length > 512 * 1024) {
      fail("STATE_ENCRYPTION_CONTRACT_INVALID");
    }
    return parse(bytes.toString("utf8"))?.authBroker?.state;
  } catch {
    fail("STATE_ENCRYPTION_CONTRACT_INVALID");
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
  }
}

function readMountInfo() {
  canonicalRegularPath(
    mountInfoPath,
    "STATE_ENCRYPTION_MOUNTINFO_PATH_INVALID",
  );
  let bytes;
  try {
    bytes = readFileSync(mountInfoPath);
    if (bytes.length === 0 || bytes.length > MAX_OUTPUT_BYTES) {
      fail("STATE_ENCRYPTION_MOUNTINFO_INVALID");
    }
    return bytes.toString("utf8");
  } catch {
    fail("STATE_ENCRYPTION_MOUNTINFO_INVALID");
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
  }
}

function hostAttestation(state) {
  const nodeName = runCommand(
    hostname,
    ["--short"],
    "STATE_ENCRYPTION_HOSTNAME_READ_FAILED",
  );
  const blockDevices = publicJson(
    runCommand(
      lsblk,
      [
        "--json",
        "--bytes",
        "--output",
        "NAME,KNAME,TYPE,FSTYPE,PKNAME,SIZE,MODEL,SERIAL,WWN,UUID,PARTUUID,MOUNTPOINTS",
      ],
      "STATE_ENCRYPTION_LSBLK_READ_FAILED",
    ),
    "STATE_ENCRYPTION_LSBLK_INVALID",
  );
  return attestStateEncryption({
    nodeName,
    mountInfo: readMountInfo(),
    lsblk: blockDevices,
    state,
  });
}

function dryRun(state, host) {
  const currentContext = runCommand(
    kubectl,
    ["config", "current-context"],
    "STATE_VOLUME_CONTEXT_READ_FAILED",
  );
  if (currentContext !== context) fail("STATE_VOLUME_CONTEXT_MISMATCH");
  const desired = buildRetainVolumeList({ state, hostAttestation: host });
  const manifest = desired.items
    .map((item) => stringify(item, { lineWidth: 0 }))
    .join("---\n");
  const observed = publicJson(
    runCommand(
      kubectl,
      [
        "--context",
        context,
        "create",
        "--dry-run=server",
        "--validate=strict",
        "--filename=-",
        "--output=json",
      ],
      "STATE_VOLUME_SERVER_DRY_RUN_FAILED",
      manifest,
    ),
    "STATE_VOLUME_SERVER_DRY_RUN_INVALID",
  );
  return verifyRetainVolumeDryRun({
    desired,
    observed,
    state,
    hostAttestation: host,
  });
}

try {
  const state = loadState();
  const host = hostAttestation(state);
  const result = mode === "host" ? host : dryRun(state, host);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  if (error instanceof StateEncryptionError) fail(error.code);
  fail("STATE_ENCRYPTION_VERIFICATION_FAILED");
}
