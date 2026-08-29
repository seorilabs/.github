import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

const IDENTIFIER = "com.seorilabs.fleet.github-keychain-helper";
const HELPER_NAME = "seorilabs-github-keychain";
const PROTOCOL = "binary-stdin-v1";
const ACL_POLICY = "self-designated-requirement-no-prompt-v1";
const MAGIC = Buffer.from("SEORIKC1", "ascii");
const SHA256 = /^[0-9a-f]{64}$/u;
const TEAM_IDENTIFIER = /^[A-Z0-9]{10}$/u;
const MAX_OUTPUT_BYTES = 16 * 1024;
const EXECUTION_TIMEOUT_MS = 10_000;
const openedStores = new WeakSet();

const TARGETS = Object.freeze([
  Object.freeze({
    encryptedKey: "GITHUB_PRIVATE_KEY",
    targetCredentialId: "shared/github/backoffice-app-private-key",
    targetKind: "macos-keychain-password",
    keychainService: "com.seorilabs.github.backoffice-app-private-key",
    catalogPath: "github/backoffice-app-private-key.keychain-ref",
  }),
  Object.freeze({
    encryptedKey: "GITHUB_WEBHOOK_SECRET",
    targetCredentialId: "shared/github/backoffice-app-webhook",
    targetKind: "macos-keychain-password",
    keychainService: "com.seorilabs.github.backoffice-app-webhook",
    catalogPath: "github/backoffice-app-webhook.keychain-ref",
  }),
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, expected) {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).toSorted().join("\0") === [...expected].toSorted().join("\0")
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function targetSetDigest() {
  return sha256(Buffer.from(
    TARGETS.map(({ targetCredentialId, keychainService }) =>
      `${targetCredentialId}\0${keychainService}`).join("\0"),
    "utf8",
  ));
}

function expectedRequirementDigest(teamIdentifier) {
  return sha256(Buffer.from(
    `identifier "${IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`,
    "utf8",
  ));
}

async function validateHelper(helperPath, helperSha256) {
  if (!isAbsolute(helperPath ?? "") || !SHA256.test(helperSha256 ?? "")) {
    fail("P3_GITHUB_KEYCHAIN_HELPER_BINDING_INVALID");
  }
  let state;
  let canonical;
  let bytes;
  try {
    [state, canonical, bytes] = await Promise.all([
      lstat(helperPath),
      realpath(helperPath),
      readFile(helperPath),
    ]);
  } catch {
    fail("P3_GITHUB_KEYCHAIN_HELPER_BINDING_INVALID");
  }
  try {
    if (
      !state.isFile() || state.isSymbolicLink() || canonical !== helperPath ||
      (state.mode & 0o022) !== 0 || ![0, process.getuid?.()].includes(state.uid) ||
      sha256(bytes) !== helperSha256
    ) {
      fail("P3_GITHUB_KEYCHAIN_HELPER_BINDING_INVALID");
    }
  } finally {
    bytes?.fill(0);
  }
}

function appendUInt16(parts, value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  parts.push(bytes);
}

function appendUInt32(parts, value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  parts.push(bytes);
}

function normalizeTargets(entries, includesSecrets) {
  if (!Array.isArray(entries) || entries.length !== TARGETS.length) {
    fail("P3_GITHUB_KEYCHAIN_TARGET_SET_MISMATCH");
  }
  return entries.map((entry, index) => {
    const expected = TARGETS[index];
    const keys = [
      "catalogPath",
      "encryptedKey",
      "keychainService",
      "targetCredentialId",
      "targetKind",
      ...(includesSecrets ? ["secret"] : []),
    ];
    if (
      !exactKeys(entry, keys) ||
      keys.filter((key) => key !== "secret").some((key) => entry[key] !== expected[key]) ||
      (includesSecrets && !Buffer.isBuffer(entry.secret))
    ) {
      fail("P3_GITHUB_KEYCHAIN_TARGET_SET_MISMATCH");
    }
    const secretLength = includesSecrets ? entry.secret.length : 0;
    const secretLengthValid = expected.encryptedKey === "GITHUB_PRIVATE_KEY"
      ? secretLength >= 256 && secretLength <= 32_768
      : secretLength >= 32 && secretLength <= 4_096;
    if (includesSecrets && !secretLengthValid) {
      fail("P3_GITHUB_KEYCHAIN_SECRET_LENGTH_INVALID");
    }
    return entry;
  });
}

function encodeBatch(operation, entries, includesSecrets) {
  const normalized = normalizeTargets(entries, includesSecrets);
  const parts = [MAGIC, Buffer.from([1, operation, TARGETS.length, 0])];
  for (const entry of normalized) {
    const credentialId = Buffer.from(entry.targetCredentialId, "utf8");
    const service = Buffer.from(entry.keychainService, "utf8");
    appendUInt16(parts, credentialId.length);
    appendUInt16(parts, service.length);
    appendUInt32(parts, includesSecrets ? entry.secret.length : 0);
    parts.push(credentialId, service);
    if (includesSecrets) parts.push(entry.secret);
  }
  return Buffer.concat(parts);
}

async function executeHelper(helperPath, command, frame) {
  const stdout = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const child = spawn(helperPath, [command], {
    env: { LANG: "C", PATH: "/usr/bin:/bin" },
    shell: false,
    stdio: [frame ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), EXECUTION_TIMEOUT_MS);
  timer.unref();
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    else stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
  });

  try {
    if (frame) {
      await new Promise((resolve, reject) => {
        child.stdin.once("error", reject);
        child.stdin.end(frame, resolve);
      });
    }
    const result = await completion;
    if (result.signal !== null || stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
      fail("P3_GITHUB_KEYCHAIN_HELPER_FAILED");
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    } catch {
      fail("P3_GITHUB_KEYCHAIN_HELPER_FAILED");
    }
    if (result.code !== 0) {
      const deniedKeys = ["code", "compensation", "operation", "schemaVersion", "state"];
      if (
        !exactKeys(value, deniedKeys) || value.schemaVersion !== 1 || value.state !== "DENIED" ||
        value.operation !== command.toUpperCase() ||
        typeof value.code !== "string" || !/^[A-Z0-9_]+$/u.test(value.code) ||
        !exactKeys(value.compensation, ["required", "verified"]) ||
        typeof value.compensation.required !== "boolean" ||
        typeof value.compensation.verified !== "boolean"
      ) {
        fail("P3_GITHUB_KEYCHAIN_HELPER_FAILED");
      }
      const error = new Error(`P3_GITHUB_KEYCHAIN_${value.code}`);
      error.code = `P3_GITHUB_KEYCHAIN_${value.code}`;
      if (value.compensation.required && !value.compensation.verified) {
        error.compensationFailed = true;
      }
      throw error;
    }
    return value;
  } catch (error) {
    child.kill("SIGKILL");
    await completion.catch(() => {});
    if (typeof error?.code === "string" && /^P3_GITHUB_KEYCHAIN_/u.test(error.code)) throw error;
    fail("P3_GITHUB_KEYCHAIN_HELPER_FAILED");
  } finally {
    clearTimeout(timer);
    frame?.fill(0);
    for (const chunk of stdout) chunk.fill(0);
  }
}

function validateAttestation(value, teamIdentifier) {
  if (
    !exactKeys(value, ["codeIdentity", "helper", "policy", "schemaVersion", "state"]) ||
    value.schemaVersion !== 1 || value.state !== "VERIFIED" || value.helper !== HELPER_NAME ||
    !exactKeys(value.codeIdentity, [
      "adHoc",
      "designatedRequirementSha256",
      "identifier",
      "signed",
      "teamIdentifier",
    ]) ||
    value.codeIdentity.identifier !== IDENTIFIER ||
    value.codeIdentity.teamIdentifier !== teamIdentifier ||
    value.codeIdentity.designatedRequirementSha256 !== expectedRequirementDigest(teamIdentifier) ||
    value.codeIdentity.signed !== true || value.codeIdentity.adHoc !== false ||
    !exactKeys(value.policy, ["authenticationUI", "protocol", "targetSetSha256", "unattendedAcl"]) ||
    value.policy.authenticationUI !== "fail" || value.policy.protocol !== PROTOCOL ||
    value.policy.targetSetSha256 !== targetSetDigest() || value.policy.unattendedAcl !== ACL_POLICY
  ) {
    fail("P3_GITHUB_KEYCHAIN_CODE_IDENTITY_MISMATCH");
  }
}

function validateSuccess(value, expectedOperation) {
  const compensationRequired = expectedOperation === "REMOVE_BATCH";
  if (
    !exactKeys(value, ["compensation", "operation", "readback", "schemaVersion", "state", "targets"]) ||
    value.schemaVersion !== 1 || value.state !== "VERIFIED" || value.operation !== expectedOperation ||
    !Array.isArray(value.targets) || value.targets.length !== TARGETS.length ||
    !exactKeys(value.readback, ["unattendedAclExact", "withoutPrompt"]) ||
    value.readback.unattendedAclExact !== true || value.readback.withoutPrompt !== true ||
    !exactKeys(value.compensation, ["required", "verified"]) ||
    value.compensation.required !== compensationRequired || value.compensation.verified !== true
  ) {
    fail("P3_GITHUB_KEYCHAIN_READBACK_MISMATCH");
  }
  for (const [index, target] of value.targets.entries()) {
    if (
      !exactKeys(target, ["credentialId", "service", "state"]) ||
      target.credentialId !== TARGETS[index].targetCredentialId ||
      target.service !== TARGETS[index].keychainService || target.state !== "VERIFIED"
    ) {
      fail("P3_GITHUB_KEYCHAIN_READBACK_MISMATCH");
    }
  }
}

export async function openGithubKeychainCredentialStore({
  helperPath,
  helperSha256,
  teamIdentifier,
}) {
  if (!TEAM_IDENTIFIER.test(teamIdentifier ?? "")) {
    fail("P3_GITHUB_KEYCHAIN_HELPER_BINDING_INVALID");
  }
  await validateHelper(helperPath, helperSha256);
  validateAttestation(await executeHelper(helperPath, "attest"), teamIdentifier);

  const publicTargets = TARGETS.map((target) => ({ ...target }));
  const preflightFrame = encodeBatch(0, publicTargets, false);
  const preflight = await executeHelper(helperPath, "preflight", preflightFrame);
  validateSuccess(preflight, "PREFLIGHT");

  const store = Object.freeze({
    async writeBatch(entries) {
      const frame = encodeBatch(1, entries, true);
      const value = await executeHelper(helperPath, "write-batch", frame);
      validateSuccess(value, "WRITE_BATCH");
    },
    async removeBatch(entries) {
      const frame = encodeBatch(2, entries, false);
      const value = await executeHelper(helperPath, "remove-batch", frame);
      validateSuccess(value, "REMOVE_BATCH");
      if (value.compensation.required !== true) {
        fail("P3_GITHUB_KEYCHAIN_READBACK_MISMATCH");
      }
    },
  });
  openedStores.add(store);
  return store;
}

export function isGithubKeychainCredentialStore(value) {
  return value !== null && typeof value === "object" && openedStores.has(value);
}
