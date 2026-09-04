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
import {
  evaluateSecretEffectiveAccess,
  secretEffectiveAccessArgs,
} from "../../packages/repo-contract/src/secret-manager-effective-access.mjs";

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
const installedModes = Object.freeze({
  helperPath: 0o555,
  executablePath: 0o555,
  childPath: 0o444,
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
const managedSecretLabels = Object.freeze({
  "managed-by": "fleet-control-plane",
  purpose: "seori-auth",
});

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

function canonicalWriterResource(resource) {
  return `projects/${cloud.projectNumber}/secrets/${resource.secretId}`;
}

function receiptResult(result, resource) {
  const canonicalResource = canonicalWriterResource(resource);
  if (
    result.resourceName !== canonicalResource ||
    result.versionResourceName !== `${canonicalResource}/versions/${resource.version}`
  ) stop("P3_SECRET_VALUE_WRITER_RESULT_MISMATCH");
  return {
    ...result,
    resourceName: resource.resource,
    versionResourceName: resource.versionResource,
  };
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
const cloud = contract.cloudBuild;
const effectiveAccessPolicy = manager?.effectiveAccessPolicy;
const expectedBindings = new Map([
  ["seori-auth-journal-mac", "shared/seori-auth/journal-mac"],
  ["seori-auth-browser-vault", "shared/seori-auth/browser-vault"],
  ["seori-auth-canary-password", "shared/seori-auth/canary-password"],
  ["seori-auth-canary-totp-seed", "shared/seori-auth/canary-totp-seed"],
]);
if (
  manager?.projectId !== "seorilabs-ci" || cloud?.projectNumber !== "321365398093" ||
  cloud.projectId !== manager.projectId || manager.resources?.length !== 4 ||
  effectiveAccessPolicy?.analyzer !== "CLOUD_ASSET_POLICY_ANALYZER" ||
  effectiveAccessPolicy.scope !== `projects/${manager.projectId}` ||
  effectiveAccessPolicy.permission !== "secretmanager.versions.access" ||
  effectiveAccessPolicy.expandRoles !== true ||
  effectiveAccessPolicy.requireFullyExplored !== true ||
  JSON.stringify(effectiveAccessPolicy.allowedProjectPrincipals) !== JSON.stringify([
    "serviceAccount:seorilabs-provisioner@seorilabs-gws.iam.gserviceaccount.com",
    "user:ih@seorilabs.com",
  ]) ||
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
      (stat.mode & 0o777) !== installedModes[key] || realpathSync(path) !== path
    ) stop("P3_SECRET_VALUE_WRITER_IDENTITY_INVALID");
    identity[key] = path;
    try {
      identity[`${key.slice(0, -4)}Sha256`] = sha256(readFileSync(path));
    } catch {
      stop("P3_SECRET_VALUE_WRITER_IDENTITY_INVALID");
    }
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
  const describedRaw = gcloudRun(
    [
      "secrets", "describe", resource.secretId,
      `--project=${manager.projectId}`, "--format=json",
    ],
    "P3_SECRET_VALUE_RESOURCE_READ_FAILED",
    { allowNotFound: true },
  );
  if (describedRaw === null) return { exists: false, versions: [] };
  const described = parseJson(
    describedRaw,
    "P3_SECRET_VALUE_RESOURCE_RESPONSE_INVALID",
  );
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
  const identityExact = new Set([
    resource.resource,
    `projects/${cloud.projectNumber}/secrets/${resource.secretId}`,
  ]).has(described?.name);
  if (!identityExact) stop("P3_SECRET_VALUE_RESOURCE_IDENTITY_MISMATCH");
  const automatic = described.replication?.automatic;
  const metadataExact =
    automatic !== null && typeof automatic === "object" && !Array.isArray(automatic) &&
    Object.keys(automatic).length === 0 &&
    Object.keys(described.replication ?? {}).length === 1 &&
    JSON.stringify(canonical(described.labels ?? {})) ===
      JSON.stringify(canonical(managedSecretLabels)) &&
    (described.topics === undefined || described.topics?.length === 0) &&
    described.rotation === undefined &&
    (described.versionAliases === undefined ||
      Object.keys(described.versionAliases ?? {}).length === 0) &&
    (described.annotations === undefined ||
      Object.keys(described.annotations ?? {}).length === 0) &&
    described.expireTime === undefined && described.ttl === undefined;
  if (!metadataExact) stop("P3_SECRET_VALUE_RESOURCE_MANAGEMENT_MISMATCH");
  const policy = parseJson(
    gcloudRun(
      [
        "secrets", "get-iam-policy", resource.secretId,
        `--project=${manager.projectId}`, "--format=json",
      ],
      "P3_SECRET_VALUE_RESOURCE_IAM_READ_FAILED",
    ),
    "P3_SECRET_VALUE_RESOURCE_IAM_RESPONSE_INVALID",
  );
  const bindings = policy?.bindings ?? [];
  const expectedAccessor = `serviceAccount:${resource.googleServiceAccount}`;
  const accessExact = bindings.length === 0 || (
    bindings.length === 1 &&
    bindings[0]?.role === "roles/secretmanager.secretAccessor" &&
    bindings[0]?.condition === undefined &&
    Array.isArray(bindings[0]?.members) && bindings[0].members.length === 1 &&
    bindings[0].members[0] === expectedAccessor
  );
  if (
    !policy || typeof policy !== "object" || Array.isArray(policy) ||
    !Array.isArray(bindings) || !accessExact ||
    (policy.auditConfigs !== undefined &&
      (!Array.isArray(policy.auditConfigs) || policy.auditConfigs.length !== 0))
  ) stop("P3_SECRET_VALUE_RESOURCE_IAM_MISMATCH");
  return { exists: true, versions };
}

function effectiveAccessState(resource) {
  let analysis;
  try {
    analysis = parseJson(
      gcloudRun(
        secretEffectiveAccessArgs({
          projectId: manager.projectId,
          projectNumber: cloud.projectNumber,
          secretId: resource.secretId,
          permission: effectiveAccessPolicy.permission,
        }),
        "P3_SECRET_VALUE_EFFECTIVE_ACCESS_READ_FAILED",
      ),
      "P3_SECRET_VALUE_EFFECTIVE_ACCESS_RESPONSE_INVALID",
    );
    return evaluateSecretEffectiveAccess({
      analysis,
      projectId: manager.projectId,
      projectNumber: cloud.projectNumber,
      secretId: resource.secretId,
      permission: effectiveAccessPolicy.permission,
      allowedPrincipals: [
        ...effectiveAccessPolicy.allowedProjectPrincipals,
        `serviceAccount:${resource.googleServiceAccount}`,
      ],
    });
  } catch (error) {
    if (error?.code === "SECRET_EFFECTIVE_ACCESS_INCOMPLETE") {
      stop("P3_SECRET_VALUE_EFFECTIVE_ACCESS_INCOMPLETE");
    }
    if (error?.code === "SECRET_EFFECTIVE_ACCESS_RESPONSE_INVALID") {
      stop("P3_SECRET_VALUE_EFFECTIVE_ACCESS_RESPONSE_INVALID");
    }
    throw error;
  }
}

function assertEffectiveAccess(resource) {
  const access = effectiveAccessState(resource);
  if (!access.exact) stop("P3_SECRET_VALUE_UNEXPECTED_EFFECTIVE_ACCESS");
  return access;
}

function publicReadback() {
  const resources = manager.resources.map((resource) => {
    const state = secretState(resource);
    const effectiveAccess = assertEffectiveAccess(resource);
    const version = state.versions[0];
    return {
      secretId: resource.secretId,
      exists: state.exists,
      effectiveAccess,
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
      schemaVersion: 2,
      contractDigest,
      writerIdentity: identity,
      pending: [],
      results: [],
    };
  }
  const receipt = parseJson(
    readFileSync(receiptPath, "utf8"),
    "P3_SECRET_VALUE_RECEIPT_INVALID",
  );
  if (
    receipt.schemaVersion !== 2 || receipt.contractDigest !== contractDigest ||
    JSON.stringify(receipt.writerIdentity) !== JSON.stringify(identity) ||
    !Array.isArray(receipt.pending) || !Array.isArray(receipt.results) ||
    new Set(receipt.pending.map(({ resourceName }) => resourceName)).size !==
      receipt.pending.length ||
    new Set(receipt.results.map(({ resourceName }) => resourceName)).size !==
      receipt.results.length ||
    receipt.pending.some(({ resourceName }) =>
      receipt.results.some((result) => result.resourceName === resourceName)) ||
    receipt.pending.some((entry) =>
      Object.keys(entry).toSorted().join(",") !==
        "dataCrc32c,fingerprintSha256,resourceName,versionResourceName" ||
      !manager.resources.some(({ resource, versionResource }) =>
        resource === entry.resourceName && versionResource === entry.versionResourceName) ||
      !/^(?:0|[1-9][0-9]{0,9})$/u.test(entry.dataCrc32c ?? "") ||
      !/^[0-9a-f]{64}$/u.test(entry.fingerprintSha256 ?? "")) ||
    receipt.results.some((entry) =>
      Object.keys(entry).toSorted().join(",") !== [
        "backupRestoreVerified", "dataCrc32c", "fingerprintSha256", "operation",
        "resourceName", "schemaVersion", "secretExposed", "versionResourceName",
      ].toSorted().join(",") ||
      entry.schemaVersion !== 1 ||
      !new Set(["secret-version-write", "secret-version-verify"]).has(entry.operation) ||
      entry.backupRestoreVerified !== true || entry.secretExposed !== false ||
      !manager.resources.some(({ resource, versionResource }) =>
        resource === entry.resourceName && versionResource === entry.versionResourceName) ||
      !/^(?:0|[1-9][0-9]{0,9})$/u.test(entry.dataCrc32c ?? "") ||
      !/^[0-9a-f]{64}$/u.test(entry.fingerprintSha256 ?? ""))
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
  for (const resource of manager.resources) assertEffectiveAccess(resource);
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
    const pending = receipt.pending.find(
      ({ resourceName }) => resourceName === resource.resource,
    );
    const intentExact = (entry) =>
      entry?.versionResourceName === resource.versionResource &&
      entry?.dataCrc32c === expectedCrc32c &&
      entry?.fingerprintSha256 === fingerprintSha256;
    if (state.versions.length > 0) {
      if (
        state.versions.length !== 1 || !state.versions[0].name.endsWith("/versions/1") ||
        state.versions[0].state !== "ENABLED"
      ) {
        material.fill(0);
        stop("P3_SECRET_VALUE_EXISTING_VERSION_UNVERIFIED");
      }
      if (recorded) {
        material.fill(0);
        if (!intentExact(recorded)) {
          stop("P3_SECRET_VALUE_EXISTING_VERSION_UNVERIFIED");
        }
        continue;
      }
      if (!intentExact(pending)) {
        material.fill(0);
        stop("P3_SECRET_VALUE_EXISTING_VERSION_UNVERIFIED");
      }
      const result = await writer.verifyVersion({
        resourceName: canonicalWriterResource(resource),
        expectedVersion: resource.version,
        material,
      });
      receipt.pending = receipt.pending.filter(
        ({ resourceName }) => resourceName !== resource.resource,
      );
      receipt.results.push({ ...receiptResult(result, resource), fingerprintSha256 });
      persistReceipt(receipt);
      continue;
    }
    if (recorded) {
      material.fill(0);
      stop("P3_SECRET_VALUE_RECEIPT_REMOTE_MISMATCH");
    }
    if (pending && !intentExact(pending)) {
      material.fill(0);
      stop("P3_SECRET_VALUE_PENDING_INTENT_MISMATCH");
    }
    if (!pending) {
      receipt.pending.push({
        resourceName: resource.resource,
        versionResourceName: resource.versionResource,
        dataCrc32c: expectedCrc32c,
        fingerprintSha256,
      });
      persistReceipt(receipt);
    }
    const result = await writer.writeVersion({
      resourceName: canonicalWriterResource(resource),
      expectedVersion: resource.version,
      material,
    });
    receipt.pending = receipt.pending.filter(
      ({ resourceName }) => resourceName !== resource.resource,
    );
    receipt.results.push({ ...receiptResult(result, resource), fingerprintSha256 });
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
    effectiveAccessPolicy,
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
