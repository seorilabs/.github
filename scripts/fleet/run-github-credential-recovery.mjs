#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parse, stringify } from "yaml";

import { recoverGithubAppCredentials } from "./github-credential-recovery.mjs";
import { githubAppReadback } from "./github-app-readback.mjs";
import { openGithubKeychainCredentialStore } from "./github-keychain-native-store.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const operation = "GITHUB_APP_CREDENTIAL_OFFLINE_RECOVERY";
const sha256Pattern = /^[0-9a-f]{64}$/u;
const teamPattern = /^[A-Z0-9]{10}$/u;
const targetIds = Object.freeze([
  "shared/github/backoffice-app-private-key",
  "shared/github/backoffice-app-webhook",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseOptions(argv) {
  const values = new Map();
  for (const argument of argv) {
    const match = argument.match(/^--([a-z][a-z0-9-]*)=(.*)$/u);
    if (!match || values.has(match[1])) fail("P3_GITHUB_RECOVERY_OPTIONS_INVALID");
    values.set(match[1], match[2]);
  }
  const allowed = new Set([
    "confirmation",
    "credential-root",
    "helper",
    "helper-sha256",
    "process-boundary",
    "process-boundary-sha256",
    "source-repo",
    "team-id",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key)) || values.size !== allowed.size) {
    fail("P3_GITHUB_RECOVERY_OPTIONS_INVALID");
  }
  return Object.fromEntries(values);
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).toSorted().join("\0") === [...expected].toSorted().join("\0");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function privateRegularFile(path, maximumBytes) {
  let state;
  let canonical;
  try {
    [state, canonical] = await Promise.all([lstat(path), realpath(path)]);
  } catch {
    fail("P3_GITHUB_RECOVERY_INPUT_INVALID");
  }
  if (
    !state.isFile() || state.isSymbolicLink() || canonical !== path ||
    state.uid !== process.getuid() || (state.mode & 0o077) !== 0 ||
    state.size < 1 || state.size > maximumBytes
  ) {
    fail("P3_GITHUB_RECOVERY_INPUT_INVALID");
  }
  return readFile(path);
}

async function privateDirectory(path) {
  let state;
  let canonical;
  try {
    [state, canonical] = await Promise.all([lstat(path), realpath(path)]);
  } catch {
    fail("P3_GITHUB_RECOVERY_ROOT_INVALID");
  }
  if (
    !state.isDirectory() || state.isSymbolicLink() || canonical !== path ||
    state.uid !== process.getuid() || (state.mode & 0o022) !== 0
  ) {
    fail("P3_GITHUB_RECOVERY_ROOT_INVALID");
  }
}

async function activateRecoveryProcessBoundary(path, expectedDigest) {
  const [state, canonical, bytes] = await Promise.all([
    lstat(path),
    realpath(path),
    readFile(path),
  ]);
  try {
    if (
      process.platform !== "darwin" || !state.isFile() || state.isSymbolicLink() ||
      canonical !== path || ![0, process.getuid()].includes(state.uid) ||
      (state.mode & 0o022) !== 0 || sha256(bytes) !== expectedDigest
    ) fail("P3_GITHUB_RECOVERY_PROCESS_BOUNDARY_INVALID");
    const receipt = require(path);
    if (
      !exactKeys(receipt, ["coreHard", "coreSoft", "denyAttachApplied", "state"]) ||
      receipt.state !== "PROCESS_HARDENING_OK" ||
      receipt.coreHard !== 0 || receipt.coreSoft !== 0 || receipt.denyAttachApplied !== true
    ) fail("P3_GITHUB_RECOVERY_PROCESS_BOUNDARY_INVALID");
  } finally {
    bytes.fill(0);
    delete process.env.SEORI_AUTH_NATIVE_LAUNCHED;
  }
}

async function runPublicCommand(executable, args, options = {}) {
  try {
    return await execFileAsync(executable, args, {
      encoding: options.encoding ?? "utf8",
      env: {
        HOME: homedir(),
        LANG: "C",
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        ...(options.credentialRoot
          ? { SEORILABS_CREDENTIAL_ROOT: options.credentialRoot }
          : {}),
      },
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      timeout: options.timeout ?? 30_000,
      windowsHide: true,
    });
  } catch {
    fail(options.code ?? "P3_GITHUB_RECOVERY_COMMAND_FAILED");
  }
}

function properties(output) {
  const values = new Map();
  for (const line of output.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0 || values.has(line.slice(0, separator))) {
      fail("P3_GITHUB_RECOVERY_COMMAND_OUTPUT_INVALID");
    }
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

async function verifyRestore(restoreScript, archive, expected, credentialRoot) {
  if (!isAbsolute(archive)) fail("P3_GITHUB_RECOVERY_BACKUP_INVALID");
  const { stdout } = await runPublicCommand(restoreScript, [archive], {
    code: "P3_GITHUB_RECOVERY_RESTORE_FAILED",
    credentialRoot,
    timeout: 180_000,
  });
  const result = properties(stdout);
  if (
    result.get("RESTORE_CHECK") !== "true" ||
    result.get("ARCHIVE_SHA256") !== expected.hash ||
    result.get("RESTORED_FILE_COUNT") !== expected.fileCount
  ) {
    fail("P3_GITHUB_RECOVERY_RESTORE_MISMATCH");
  }
}

export async function verifyCredentialBackupPair(credentialRoot) {
  const scripts = resolve(credentialRoot, "scripts");
  const backupScript = resolve(scripts, "backup-credentials.sh");
  const restoreScript = resolve(scripts, "restore-check.sh");
  const { stdout } = await runPublicCommand(backupScript, [], {
    code: "P3_GITHUB_RECOVERY_BACKUP_FAILED",
    credentialRoot,
    timeout: 180_000,
  });
  const result = properties(stdout);
  const expected = {
    hash: result.get("BACKUP_SHA256"),
    fileCount: result.get("BACKUP_FILE_COUNT"),
  };
  if (!sha256Pattern.test(expected.hash ?? "") || !/^[1-9][0-9]*$/u.test(expected.fileCount ?? "")) {
    fail("P3_GITHUB_RECOVERY_BACKUP_INVALID");
  }
  await verifyRestore(
    restoreScript,
    result.get("BACKUP_ARCHIVE") ?? "",
    expected,
    credentialRoot,
  );
  await verifyRestore(
    restoreScript,
    result.get("BEESTATION_ARCHIVE") ?? "",
    expected,
    credentialRoot,
  );
  return true;
}

async function atomicPrivateCreate(path, bytes, recordCreated) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.pending`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const state = await handle.stat();
    await link(temporary, path);
    // Track ownership before cleanup can fail, so compensation never loses a
    // successfully published file when removing the temporary link fails.
    recordCreated({ dev: state.dev, ino: state.ino, digest: sha256(bytes) });
  } finally {
    await handle.close();
    await rm(temporary);
  }
}

export async function preserveGithubRecoveryCiphertext({ root, source, sourceBytes }) {
  if (
    !Buffer.isBuffer(sourceBytes) || sourceBytes.length > 2 * 1024 * 1024 ||
    !/^[0-9a-f]{40}$/u.test(source?.sourceSha ?? "") ||
    !sha256Pattern.test(source?.manifestSha256 ?? "") ||
    sha256(sourceBytes) !== source.manifestSha256
  ) fail("P3_GITHUB_RECOVERY_SOURCE_DIGEST_MISMATCH");
  await privateDirectory(root);
  const relativePath = `github/recovery/backoffice-${source.sourceSha}.sealedsecret.yaml`;
  const path = resolve(root, relativePath);
  try {
    await atomicPrivateCreate(path, sourceBytes, () => {});
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const persisted = await privateRegularFile(path, 2 * 1024 * 1024);
  try {
    if (sha256(persisted) !== source.manifestSha256) {
      fail("P3_GITHUB_RECOVERY_SOURCE_SNAPSHOT_MISMATCH");
    }
  } finally {
    persisted.fill(0);
  }
  return {
    relativePath,
    sourceSha: source.sourceSha,
    manifestSha256: source.manifestSha256,
    plaintext: false,
  };
}

function catalogDocument(entries, app) {
  return {
    version: 1,
    credentials: entries.map((entry) => ({
      id: entry.targetCredentialId,
      scope: "shared",
      purpose: entry.encryptedKey === "GITHUB_PRIVATE_KEY"
        ? "github-app-installation-token-signing"
        : "github-app-webhook-verification",
      kind: entry.targetKind,
      path: entry.catalogPath,
      identity: `github-app:${app.appId}`,
      public: {
        appId: String(app.appId),
        installationId: String(app.installationId),
        fingerprintSha256: entry.fingerprintSha256,
      },
      consumers: entry.encryptedKey === "GITHUB_PRIVATE_KEY"
        ? ["seorilabs-backoffice", "seori-auth:github-adapter"]
        : ["seorilabs-backoffice:webhook"],
      status: "active",
    })),
  };
}

function referenceDocument(entry, app) {
  return [
    `service=${entry.keychainService}`,
    `account=${entry.targetCredentialId}`,
    "provider=github",
    `app_id=${app.appId}`,
    `installation_id=${app.installationId}`,
    `fingerprint_sha256=${entry.fingerprintSha256}`,
    "",
  ].join("\n");
}

async function catalogEntries(root) {
  const catalogRoot = resolve(root, "catalog");
  const names = (await readdir(catalogRoot)).filter((name) => name.endsWith(".yaml")).toSorted();
  const entries = [];
  for (const name of names) {
    const document = parse(await readFile(resolve(catalogRoot, name), "utf8"));
    if (document?.version !== 1 || !Array.isArray(document.credentials)) {
      fail("P3_GITHUB_RECOVERY_CATALOG_INVALID");
    }
    entries.push(...document.credentials);
  }
  return entries;
}

function validateRegistrationEntries(entries) {
  if (!Array.isArray(entries) || entries.length !== targetIds.length) {
    fail("P3_GITHUB_RECOVERY_CATALOG_TARGET_MISMATCH");
  }
  for (const [index, entry] of entries.entries()) {
    const suffix = index === 0 ? "backoffice-app-private-key" : "backoffice-app-webhook";
    if (
      !exactKeys(entry, [
        "catalogPath",
        "encryptedKey",
        "fingerprintSha256",
        "keychainService",
        "status",
        "targetCredentialId",
        "targetKind",
      ]) || entry.targetCredentialId !== targetIds[index] ||
      entry.status !== "active" || !sha256Pattern.test(entry.fingerprintSha256) ||
      entry.catalogPath !== `github/${suffix}.keychain-ref` ||
      entry.keychainService !== `com.seorilabs.github.${suffix}` ||
      entry.targetKind !== "macos-keychain-password" ||
      entry.encryptedKey !== (index === 0 ? "GITHUB_PRIVATE_KEY" : "GITHUB_WEBHOOK_SECRET")
    ) {
      fail("P3_GITHUB_RECOVERY_CATALOG_TARGET_MISMATCH");
    }
  }
}

export function createGithubRecoveryCatalogAdapter({ root, app }) {
  const catalogPath = resolve(root, "catalog/github-backoffice-app.yaml");
  const expected = new Map();
  let registered = false;

  async function removeOwnedFiles() {
    for (const [path, expectedState] of [...expected.entries()].reverse()) {
      try {
        const state = await lstat(path);
        if (
          !state.isFile() || state.isSymbolicLink() ||
          state.dev !== expectedState.dev || state.ino !== expectedState.ino
        ) fail("P3_GITHUB_RECOVERY_CATALOG_COMPENSATION_FAILED");
        const bytes = await readFile(path);
        const exact = sha256(bytes) === expectedState.digest;
        bytes.fill(0);
        if (!exact) fail("P3_GITHUB_RECOVERY_CATALOG_COMPENSATION_FAILED");
        await rm(path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    expected.clear();
    registered = false;
  }

  return Object.freeze({
    async targetsAbsent(targets) {
      if (
        !Array.isArray(targets) ||
        targets.map(({ targetCredentialId }) => targetCredentialId).join("\0") !== targetIds.join("\0")
      ) {
        fail("P3_GITHUB_RECOVERY_CATALOG_TARGET_MISMATCH");
      }
      const ids = new Set((await catalogEntries(root)).map(({ id }) => id));
      if (targetIds.some((id) => ids.has(id))) return false;
      for (const target of targets) {
        try {
          await lstat(resolve(root, target.catalogPath));
          return false;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      try {
        await lstat(catalogPath);
        return false;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return true;
    },

    async registerBatch(entries) {
      validateRegistrationEntries(entries);
      try {
        for (const entry of entries) {
          const path = resolve(root, entry.catalogPath);
          const bytes = Buffer.from(referenceDocument(entry, app), "utf8");
          try {
            await atomicPrivateCreate(path, bytes, (state) => expected.set(path, state));
          } finally {
            bytes.fill(0);
          }
        }
        const bytes = Buffer.from(stringify(catalogDocument(entries, app)), "utf8");
        try {
          await atomicPrivateCreate(catalogPath, bytes, (state) => expected.set(catalogPath, state));
        } finally {
          bytes.fill(0);
        }
        await runPublicCommand(resolve(root, "scripts/credential-catalog.py"), ["validate"], {
          code: "P3_GITHUB_RECOVERY_CATALOG_VALIDATION_FAILED",
          credentialRoot: root,
        });
        registered = true;
      } catch (error) {
        await removeOwnedFiles().catch(() => {
          error.compensationFailed = true;
        });
        throw error;
      }
    },

    async removeBatch(targets) {
      if (
        !Array.isArray(targets) ||
        targets.map(({ targetCredentialId }) => targetCredentialId).join("\0") !== targetIds.join("\0")
      ) {
        fail("P3_GITHUB_RECOVERY_CATALOG_TARGET_MISMATCH");
      }
      if (registered || expected.size > 0) await removeOwnedFiles();
    },
  });
}

async function githubIdentity(contract) {
  const org = contract.github.organization;
  if (!/^[A-Za-z0-9_.-]+$/u.test(org)) fail("P3_GITHUB_RECOVERY_ORGANIZATION_INVALID");
  const { stdout } = await runPublicCommand(
    "/opt/homebrew/bin/gh",
    ["api", `orgs/${org}/installations?per_page=100`],
    { code: "P3_GITHUB_RECOVERY_APP_READBACK_FAILED" },
  );
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    fail("P3_GITHUB_RECOVERY_APP_READBACK_INVALID");
  }
  const result = githubAppReadback(contract.github.app, payload?.installations);
  if (
    !Number.isSafeInteger(payload?.total_count) ||
    payload.total_count !== payload?.installations?.length
  ) fail("P3_GITHUB_RECOVERY_APP_READBACK_INCOMPLETE");
  if (!result.ready) fail(result.code ?? "P3_GITHUB_RECOVERY_APP_IDENTITY_MISMATCH");
  return result.identity;
}

async function gitSourceBytes(repository, source) {
  const repositoryPath = await realpath(repository).catch(() => "");
  if (!isAbsolute(repositoryPath)) fail("P3_GITHUB_RECOVERY_SOURCE_REPOSITORY_INVALID");
  const { stdout } = await runPublicCommand(
    "/usr/bin/git",
    ["-C", repositoryPath, "show", `${source.sourceSha}:${source.manifestPath}`],
    {
      code: "P3_GITHUB_RECOVERY_SOURCE_READ_FAILED",
      encoding: "buffer",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return Buffer.from(stdout);
}

export async function runGithubCredentialRecovery(options) {
  if (
    options.confirmation !== operation ||
    !isAbsolute(options["credential-root"]) || !isAbsolute(options.helper) ||
    !isAbsolute(options["source-repo"]) ||
    !isAbsolute(options["process-boundary"]) ||
    !sha256Pattern.test(options["helper-sha256"] ?? "") ||
    !sha256Pattern.test(options["process-boundary-sha256"] ?? "") ||
    !teamPattern.test(options["team-id"] ?? "")
  ) {
    fail("P3_GITHUB_RECOVERY_OPTIONS_INVALID");
  }
  const credentialRoot = resolve(options["credential-root"]);
  await privateDirectory(credentialRoot);
  const contract = parse(await readFile(resolve(sourceRoot, "contracts/fleet-p3-runtime.yaml"), "utf8"));
  const recovery = contract?.github?.credentialRecovery;
  if (recovery?.approvalGate?.operation !== operation) {
    fail("P3_GITHUB_RECOVERY_CONTRACT_INVALID");
  }

  const credentialStore = await openGithubKeychainCredentialStore({
    helperPath: resolve(options.helper),
    helperSha256: options["helper-sha256"],
    teamIdentifier: options["team-id"],
  });
  const runtimeContract = structuredClone(contract);
  runtimeContract.github.credentialRecovery.trustedAdapter.state = "ready";
  const matchingRecoveryEntries = (await catalogEntries(credentialRoot)).filter(
    ({ id }) => id === recovery.source.recoveryCredentialId,
  );
  if (
    matchingRecoveryEntries.length !== 1 ||
    matchingRecoveryEntries[0].scope !== "shared" ||
    matchingRecoveryEntries[0].status !== "active" ||
    matchingRecoveryEntries[0].kind !== "kubernetes-private-key"
  ) fail("P3_GITHUB_RECOVERY_KEY_CATALOG_INVALID");
  const recoveryPath = resolve(credentialRoot, matchingRecoveryEntries[0].path);
  if (!recoveryPath.startsWith(`${credentialRoot}/`)) {
    fail("P3_GITHUB_RECOVERY_KEY_CATALOG_INVALID");
  }
  await activateRecoveryProcessBoundary(
    resolve(options["process-boundary"]),
    options["process-boundary-sha256"],
  );
  let sourceBytes;
  let recoveryBytes;
  try {
    sourceBytes = await gitSourceBytes(options["source-repo"], recovery.source);
    // Keychain references alone cannot restore secrets. Keep the exact original
    // ciphertext beside the registered recovery key so both encrypted backups
    // remain usable even when GitHub or the source checkout is unavailable.
    await preserveGithubRecoveryCiphertext({
      root: credentialRoot,
      source: recovery.source,
      sourceBytes,
    });
    recoveryBytes = await privateRegularFile(recoveryPath, 2 * 1024 * 1024);
    return await recoverGithubAppCredentials({
      contract: runtimeContract,
      sourceBytes,
      recoveryBytes,
      adapters: {
        approval: {
          authorize: async (plan) => plan.operation === options.confirmation,
        },
        appIdentity: { read: async () => githubIdentity(runtimeContract) },
        backupRestore: { verify: async () => verifyCredentialBackupPair(credentialRoot) },
        catalog: createGithubRecoveryCatalogAdapter({
          root: credentialRoot,
          app: runtimeContract.github.app,
        }),
        credentialStore,
      },
    });
  } finally {
    sourceBytes?.fill(0);
    recoveryBytes?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runGithubCredentialRecovery(parseOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = typeof error?.code === "string" && /^P3_[A-Z0-9_]+$/u.test(error.code)
      ? error.code
      : "P3_GITHUB_RECOVERY_RUNTIME_FAILED";
    process.stderr.write(`${JSON.stringify({
      state: "RECOVERY_FAILED",
      code,
      compensationFailed: error?.compensationFailed === true,
    })}\n`);
    process.exitCode = 1;
  }
}
