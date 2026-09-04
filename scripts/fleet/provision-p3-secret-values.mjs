#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { NativeSecurityBoundary } from "../../tools/seori-auth/src/native-boundary.mjs";

const mode = process.argv[2] ?? "plan";
const confirmation = process.argv[3] ?? "";
const home = homedir();
const credentialRoot = join(home, ".config", "seorilabs");
const catalogPath = join(credentialRoot, "catalog", "seori-auth-runtime-secrets.yaml");
const gcloud = join(credentialRoot, "scripts", "gcloud-cli.sh");
const restoreCheck = join(credentialRoot, "scripts", "restore-check.sh");
const contractPath = fileURLToPath(
  new URL("../../contracts/fleet-p3-runtime.yaml", import.meta.url),
);
const receiptPath = join(
  credentialRoot,
  "receipts",
  "p3-secret-manager-values.json",
);
const installed = Object.freeze({
  helperPath: "/usr/local/libexec/seori-auth-native",
  executablePath: "/usr/local/libexec/seori-auth-node",
  childPath: "/opt/seori-auth/runtime/secret-manager-writer.mjs",
});
const localBackupRoot = join(home, ".seorilabs-credential-backups");
const beeBackupRoot = join(
  home,
  "Library",
  "CloudStorage",
  "BeeStation-ChaedaStation",
  "vault",
  "seorilabs-credentials",
  "backups",
);

function stop(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exit(1);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function crc32c(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

function parseJson(raw, code) {
  try {
    return JSON.parse(raw);
  } catch {
    stop(code);
  }
}

function trustedUserExecutable(path, code) {
  try {
    const stat = lstatSync(path);
    if (
      !isAbsolute(path) || !stat.isFile() || stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 ||
      realpathSync(path) !== path
    ) stop(code);
  } catch {
    stop(code);
  }
}

function gcloudRun(args, code, { allowNotFound = false } = {}) {
  trustedUserExecutable(gcloud, "P3_SECRET_VALUE_GCLOUD_WRAPPER_INVALID");
  try {
    return execFileSync(gcloud, ["--quiet", ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const diagnostic = String(error?.stderr ?? "").trim();
    const primary = diagnostic.split(/\r?\n/u)
      .find((line) => line.startsWith("ERROR: ")) ?? diagnostic;
    if (
      allowNotFound && error?.status === 1 &&
      /^(?:ERROR: \(gcloud\.[^)\r\n]+\) )?NOT_FOUND(?::|$)/u.test(primary)
    ) return null;
    stop(code);
  }
}

let contract;
let catalog;
try {
  contract = parse(readFileSync(contractPath, "utf8"));
  catalog = parse(readFileSync(catalogPath, "utf8"));
} catch {
  stop("P3_SECRET_VALUE_INPUT_PARSE_FAILED");
}
if (!new Set(["plan", "apply", "readback"]).has(mode) || process.argv.length > 4) {
  stop("P3_SECRET_VALUE_COMMAND_INVALID");
}
const manager = contract.authBroker?.secretManager;
const expectedBindings = new Map([
  ["seori-auth-journal-mac", "shared/seori-auth/journal-mac"],
  ["seori-auth-browser-vault", "shared/seori-auth/browser-vault"],
  ["seori-auth-canary-password", "shared/seori-auth/canary-password"],
  ["seori-auth-canary-totp-seed", "shared/seori-auth/canary-totp-seed"],
]);
if (
  manager?.projectId !== "seorilabs-ci" || manager.resources?.length !== 4 ||
  manager.provisioning?.adapterMode !== "native-secret-manager-writer" ||
  manager.provisioning?.plaintextTransport !== "fd3" ||
  manager.provisioning?.values?.length !== 4 ||
  manager.resources.some((resource) =>
    resource.version !== 1 ||
    resource.resource !== `projects/seorilabs-ci/secrets/${resource.secretId}` ||
    expectedBindings.get(resource.secretId) !== resource.logicalCredentialId) ||
  manager.provisioning.values.some(({ secretId }) => !expectedBindings.has(secretId))
) stop("P3_SECRET_VALUE_CONTRACT_MISMATCH");
const contractDigest = sha256(JSON.stringify(canonical(manager)));
const expectedConfirmation = `fleet-p3-secret-values-${contractDigest.slice(0, 12)}`;
if (mode === "apply" && confirmation !== expectedConfirmation) {
  stop("P3_SECRET_VALUE_APPLY_CONFIRMATION_REQUIRED");
}

function installedIdentity({ required }) {
  const identity = {};
  for (const [key, path] of Object.entries(installed)) {
    if (!existsSync(path)) {
      if (required) stop("P3_SECRET_VALUE_WRITER_NOT_INSTALLED");
      return null;
    }
    const stat = lstatSync(path);
    if (
      !stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 || realpathSync(path) !== path
    ) stop("P3_SECRET_VALUE_WRITER_IDENTITY_INVALID");
    identity[key] = path;
    identity[`${key.slice(0, -4)}Sha256`] = sha256(readFileSync(path));
  }
  return identity;
}

function catalogRecord(logicalCredentialId) {
  const matches = catalog.credentials?.filter(({ id }) => id === logicalCredentialId) ?? [];
  const record = matches[0];
  if (
    matches.length !== 1 || record.status !== "active" || record.scope !== "shared" ||
    record.public?.generation !== 1 ||
    !/^[0-9a-f]{64}$/u.test(record.public?.fingerprintSha256 ?? "")
  ) stop("P3_SECRET_VALUE_CATALOG_RECORD_INVALID");
  return record;
}

function bytesMatch(buffer, predicate) {
  for (const byte of buffer) if (!predicate(byte)) return false;
  return true;
}

function loadMaterial(resource, valueContract) {
  const record = catalogRecord(resource.logicalCredentialId);
  if (!record.consumers?.includes(
    `gcp-secret-manager:${manager.projectId}:${resource.secretId}:${resource.version}`,
  )) stop("P3_SECRET_VALUE_CATALOG_CONSUMER_MISMATCH");
  const path = join(credentialRoot, record.path);
  const pathRelative = relative(credentialRoot, path);
  if (pathRelative.startsWith("..") || isAbsolute(pathRelative)) {
    stop("P3_SECRET_VALUE_PATH_INVALID");
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  ) stop("P3_SECRET_VALUE_PATH_INVALID");
  const material = readFileSync(path);
  const validEncoding =
    (valueContract.encoding === "raw" && material.length === valueContract.entropyBytes) ||
    (valueContract.encoding === "base64url" &&
      material.length === 43 && bytesMatch(material, (byte) =>
        (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) || byte === 0x5f || byte === 0x2d)) ||
    (valueContract.encoding === "base32-no-padding" &&
      material.length === 32 && bytesMatch(material, (byte) =>
        (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x32 && byte <= 0x37)));
  if (!validEncoding || sha256(material) !== record.public.fingerprintSha256) {
    material.fill(0);
    stop("P3_SECRET_VALUE_MATERIAL_MISMATCH");
  }
  return { material, fingerprintSha256: record.public.fingerprintSha256 };
}

function findBackupPair() {
  let localGenerations;
  let beeGenerations;
  try {
    localGenerations = new Set(
      readdirSync(localBackupRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map(({ name }) => name),
    );
    beeGenerations = readdirSync(beeBackupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && localGenerations.has(entry.name))
      .map(({ name }) => name)
      .toSorted()
      .reverse();
  } catch {
    stop("P3_SECRET_VALUE_BACKUP_INVENTORY_UNAVAILABLE");
  }
  for (const generation of beeGenerations) {
    const archive = `seorilabs-credentials-${generation}.tar.zst.gpg`;
    const local = join(localBackupRoot, generation, archive);
    const bee = join(beeBackupRoot, generation, archive);
    if (
      existsSync(local) && existsSync(`${local}.sha256`) &&
      existsSync(bee) && existsSync(`${bee}.sha256`)
    ) {
      const newestCredential = Math.max(...manager.resources.map((resource) =>
        Date.parse(catalogRecord(resource.logicalCredentialId).public.createdAt)));
      if (
        Number.isFinite(newestCredential) &&
        lstatSync(local).mtimeMs >= newestCredential &&
        lstatSync(bee).mtimeMs >= newestCredential
      ) return { generation, local, bee };
    }
  }
  stop("P3_SECRET_VALUE_BACKUP_PAIR_MISSING");
}

function restoreReadback(path) {
  trustedUserExecutable(restoreCheck, "P3_SECRET_VALUE_RESTORE_CHECK_INVALID");
  try {
    const output = execFileSync(restoreCheck, [path], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const values = Object.fromEntries(
      output.trim().split(/\r?\n/u).map((line) => line.split(/=(.*)/su).slice(0, 2)),
    );
    if (
      values.RESTORE_CHECK !== "true" ||
      !/^[0-9a-f]{64}$/u.test(values.ARCHIVE_SHA256 ?? "") ||
      !/^[1-9][0-9]*$/u.test(values.RESTORED_FILE_COUNT ?? "")
    ) stop("P3_SECRET_VALUE_RESTORE_CHECK_FAILED");
    return values;
  } catch {
    stop("P3_SECRET_VALUE_RESTORE_CHECK_FAILED");
  }
}

function secretState(resource) {
  const described = gcloudRun(
    [
      "secrets", "describe", resource.secretId,
      `--project=${manager.projectId}`, "--format=value(name)",
    ],
    "P3_SECRET_VALUE_RESOURCE_READ_FAILED",
    { allowNotFound: true },
  );
  if (described === null) return { exists: false, versions: [] };
  const versions = parseJson(
    gcloudRun(
      [
        "secrets", "versions", "list", resource.secretId,
        `--project=${manager.projectId}`, "--format=json(name,state)",
      ],
      "P3_SECRET_VALUE_VERSION_READ_FAILED",
    ),
    "P3_SECRET_VALUE_VERSION_RESPONSE_INVALID",
  );
  const identityExact =
    described === resource.resource ||
    described.endsWith(`/secrets/${resource.secretId}`);
  if (!identityExact) stop("P3_SECRET_VALUE_RESOURCE_IDENTITY_MISMATCH");
  return { exists: true, versions };
}

function publicReadback() {
  const resources = manager.resources.map((resource) => {
    const state = secretState(resource);
    const version = state.versions[0];
    return {
      secretId: resource.secretId,
      exists: state.exists,
      versionCount: state.versions.length,
      versionExact:
        state.versions.length === 1 && version?.name.endsWith("/versions/1") &&
        version?.state === "ENABLED",
    };
  });
  return {
    schemaVersion: 1,
    projectId: manager.projectId,
    contractDigest,
    resources,
    exact: resources.every(({ exists, versionExact }) => exists && versionExact),
  };
}

function createSecret(resource) {
  const state = secretState(resource);
  if (state.exists) return state;
  const name = gcloudRun(
    [
      "secrets", "create", resource.secretId,
      `--project=${manager.projectId}`,
      "--replication-policy=automatic",
      "--labels=managed-by=fleet-control-plane,purpose=seori-auth",
      "--format=value(name)",
    ],
    "P3_SECRET_VALUE_RESOURCE_CREATE_FAILED",
  );
  if (!name.endsWith(`/secrets/${resource.secretId}`)) {
    stop("P3_SECRET_VALUE_RESOURCE_CREATE_RESPONSE_INVALID");
  }
  return secretState(resource);
}

function loadReceipt(identity) {
  if (!existsSync(receiptPath)) {
    return {
      schemaVersion: 1,
      contractDigest,
      writerIdentity: identity,
      results: [],
    };
  }
  const receipt = parseJson(
    readFileSync(receiptPath, "utf8"),
    "P3_SECRET_VALUE_RECEIPT_INVALID",
  );
  if (
    receipt.schemaVersion !== 1 || receipt.contractDigest !== contractDigest ||
    JSON.stringify(receipt.writerIdentity) !== JSON.stringify(identity) ||
    !Array.isArray(receipt.results) ||
    new Set(receipt.results.map(({ resourceName }) => resourceName)).size !==
      receipt.results.length ||
    receipt.results.some(({ resourceName }) =>
      !manager.resources.some(({ resource }) => resource === resourceName))
  ) stop("P3_SECRET_VALUE_RECEIPT_INVALID");
  return receipt;
}

function persistReceipt(receipt) {
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(receiptPath), 0o700);
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, receiptPath);
}

async function apply() {
  const identity = installedIdentity({ required: true });
  const backup = findBackupPair();
  const [localRestore, beeRestore] = [
    restoreReadback(backup.local),
    restoreReadback(backup.bee),
  ];
  if (localRestore.ARCHIVE_SHA256 !== beeRestore.ARCHIVE_SHA256) {
    stop("P3_SECRET_VALUE_BACKUP_PAIR_MISMATCH");
  }
  const receipt = loadReceipt(identity);
  for (const resource of manager.resources) createSecret(resource);
  const boundary = await NativeSecurityBoundary.open({
    helperPath: identity.helperPath,
    expectedSha256: identity.helperSha256,
    expectedUid: process.getuid?.(),
    expectedGid: process.getgid?.(),
    resolvePrincipal: async () => ({
      subject: "fleet-p3-secret-provisioner",
      runId: `local-${Date.now()}`,
      repository: "seorilabs/.github",
      workerId: "local-security-boundary",
    }),
  });
  const writer = await boundary.secretManagerWriter({
    executablePath: identity.executablePath,
    executableSha256: identity.executableSha256,
    childPath: identity.childPath,
    childSha256: identity.childSha256,
  });
  for (const resource of manager.resources) {
    const valueContract = manager.provisioning.values.find(
      ({ secretId }) => secretId === resource.secretId,
    );
    if (!valueContract) stop("P3_SECRET_VALUE_CONTRACT_MISMATCH");
    const { material, fingerprintSha256 } = loadMaterial(resource, valueContract);
    const expectedCrc32c = crc32c(material);
    const state = secretState(resource);
    const recorded = receipt.results.find(
      ({ resourceName }) => resourceName === resource.resource,
    );
    if (state.versions.length > 0) {
      material.fill(0);
      if (
        state.versions.length !== 1 || !state.versions[0].name.endsWith("/versions/1") ||
        state.versions[0].state !== "ENABLED" ||
        recorded?.dataCrc32c !== expectedCrc32c ||
        recorded?.fingerprintSha256 !== fingerprintSha256
      ) stop("P3_SECRET_VALUE_EXISTING_VERSION_UNVERIFIED");
      continue;
    }
    if (recorded) {
      material.fill(0);
      stop("P3_SECRET_VALUE_RECEIPT_REMOTE_MISMATCH");
    }
    const result = await writer.writeVersion({
      resourceName: resource.resource,
      expectedVersion: resource.version,
      material,
    });
    receipt.results.push({ ...result, fingerprintSha256 });
    persistReceipt(receipt);
  }
  const readback = publicReadback();
  if (!readback.exact || receipt.results.length !== manager.resources.length) {
    stop("P3_SECRET_VALUE_READBACK_FAILED");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "APPLIED",
    backup: {
      generation: backup.generation,
      archiveSha256: localRestore.ARCHIVE_SHA256,
      restoredFileCount: Number(localRestore.RESTORED_FILE_COUNT),
    },
    writerIdentity: identity,
    receiptPath,
    readback,
  }, null, 2)}\n`);
}

if (mode === "plan") {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    mode: "DRY_RUN",
    projectId: manager.projectId,
    contractDigest,
    writerIdentity: installedIdentity({ required: false }),
    resources: manager.resources.map(({ secretId, resource, version, logicalCredentialId }) => ({
      secretId, resource, version, logicalCredentialId,
    })),
    backupPair: findBackupPair().generation,
    confirmation: expectedConfirmation,
    apply: `node scripts/fleet/provision-p3-secret-values.mjs apply ${expectedConfirmation}`,
    readback: "node scripts/fleet/provision-p3-secret-values.mjs readback",
    secretValuesExposed: false,
  }, null, 2)}\n`);
} else if (mode === "readback") {
  process.stdout.write(`${JSON.stringify(publicReadback(), null, 2)}\n`);
} else {
  await apply();
}
