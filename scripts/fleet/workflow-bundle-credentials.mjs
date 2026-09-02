#!/usr/bin/env node

// Fixed-purpose enrollment. Secret material never crosses this process's output
// boundary; canonical files are consumed only by trusted runtime provisioning.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const CATALOG = "workflow-bundle-runtime.yaml";
const CONFIRMATION = "shared-workflow-bundle-build-runtime-v1";
const TARGETS = Object.freeze([
  { id: "shared/seori-auth/workflow-bundle-candidate-adapter", purpose: "workflow-bundle-candidate-adapter-authentication", kind: "opaque-capability", path: "seori-auth/workflow-bundle-candidate/adapter.bearer" },
  { id: "shared/seori-auth/workflow-bundle-candidate-attestation", purpose: "workflow-bundle-candidate-request-attestation", kind: "ed25519-private-key", path: "seori-auth/workflow-bundle-candidate/attestation-private.pem", companionPath: "seori-auth/workflow-bundle-candidate/attestation-public.pem" },
  { id: "shared/workflow-bundle/approval-signing", purpose: "workflow-bundle-v5-approval-signing", kind: "ed25519-private-key", path: "workflow-bundle/approval-signing/private-key.pem", companionPath: "workflow-bundle/approval-signing/public-key.pem" },
]);

function stop(code) { throw Object.assign(new Error(code), { code }); }
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function directory(path, allowGroupRead = false) {
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid()
    || (state.mode & (allowGroupRead ? 0o022 : 0o077)) !== 0 || realpathSync(path) !== path) {
    stop("WORKFLOW_CREDENTIAL_DIRECTORY_UNSAFE");
  }
}

function readPrivate(path) {
  directory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = fstatSync(fd);
    if (!state.isFile() || state.uid !== process.getuid() || (state.mode & 0o077) !== 0
      || state.size < 1 || state.size > 32768 || state.nlink !== 1) stop("WORKFLOW_CREDENTIAL_FILE_UNSAFE");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function createPrivate(root, relative, bytes) {
  let current = root;
  const parts = relative.split("/");
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    directory(current, current === join(root, "catalog"));
  }
  const fd = openSync(join(root, relative), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function inventory(root) {
  directory(root);
  directory(join(root, "catalog"), true);
  return readdirSync(join(root, "catalog")).filter((name) => name.endsWith(".yaml")).flatMap((name) => {
    const path = join(root, "catalog", name);
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink() || state.uid !== process.getuid() || (state.mode & 0o022) !== 0) {
      stop("WORKFLOW_CREDENTIAL_CATALOG_UNSAFE");
    }
    const document = parse(readFileSync(path, "utf8"));
    if (document?.version !== 1 || !Array.isArray(document.credentials)) stop("WORKFLOW_CREDENTIAL_CATALOG_INVALID");
    return document.credentials;
  });
}

function fingerprint(target, bytes) {
  if (target.kind === "opaque-capability") {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(bytes.toString("utf8"))) stop("WORKFLOW_CREDENTIAL_CAPABILITY_INVALID");
    return digest(bytes);
  }
  const key = createPrivateKey(bytes);
  if (key.asymmetricKeyType !== "ed25519") stop("WORKFLOW_CREDENTIAL_KEY_INVALID");
  return digest(createPublicKey(key).export({ type: "spki", format: "der" }));
}

function verifyRegistered(root, records) {
  return TARGETS.map((target) => {
    const matching = records.filter((entry) => entry.id === target.id);
    if (matching.length !== 1) stop("WORKFLOW_CREDENTIAL_CATALOG_CONFLICT");
    const entry = matching[0];
    if (entry.scope !== "shared" || entry.status !== "active"
      || Object.entries(target).some(([key, value]) => entry[key] !== value)) stop("WORKFLOW_CREDENTIAL_BINDING_MISMATCH");
    const bytes = readPrivate(join(root, target.path));
    try {
      const actual = fingerprint(target, bytes);
      if (actual !== entry.public?.fingerprintSha256) stop("WORKFLOW_CREDENTIAL_FINGERPRINT_MISMATCH");
      if (target.companionPath) {
        const publicBytes = readPrivate(join(root, target.companionPath));
        try {
          if (digest(createPublicKey(publicBytes).export({ type: "spki", format: "der" })) !== actual) {
            stop("WORKFLOW_CREDENTIAL_PUBLIC_PAIR_MISMATCH");
          }
        } finally { publicBytes.fill(0); }
      }
      return { credentialId: target.id, fingerprintSha256: actual, ...("keyId" in entry.public ? { keyId: entry.public.keyId } : {}) };
    } finally { bytes.fill(0); }
  });
}

export function enrollWorkflowBundleCredentials({ root, mode = "plan", confirmation, backupSha256, now = new Date() }) {
  if (!["plan", "issue", "readback"].includes(mode)) stop("WORKFLOW_CREDENTIAL_OPERATION_INVALID");
  const records = inventory(root);
  const registered = TARGETS.filter((target) => records.some((entry) => entry.id === target.id));
  for (const target of TARGETS) {
    if (records.some((entry) => entry.id !== target.id && entry.purpose === target.purpose
      && !["retired", "revoked", "missing"].includes(entry.status))) stop("WORKFLOW_CREDENTIAL_SHARED_DUPLICATE");
  }
  if (registered.length === TARGETS.length) return { state: "VERIFIED", credentials: verifyRegistered(root, records), changed: false };
  if (registered.length !== 0) stop("WORKFLOW_CREDENTIAL_PARTIAL_REGISTRATION");
  if (TARGETS.some((target) => [target.path, target.companionPath].filter(Boolean).some((path) => existsSync(join(root, path))))) {
    stop("WORKFLOW_CREDENTIAL_UNREGISTERED_MATERIAL_PRESENT");
  }
  if (mode === "readback") stop("WORKFLOW_CREDENTIAL_NOT_ENROLLED");
  if (mode === "plan") return { state: "ABSENT", credentials: TARGETS.map(({ id, purpose }) => ({ credentialId: id, purpose })), changed: false };
  if (confirmation !== CONFIRMATION || !/^[0-9a-f]{64}$/u.test(backupSha256 ?? "")) stop("WORKFLOW_CREDENTIAL_APPROVAL_BACKUP_REQUIRED");
  if (existsSync(join(root, "catalog", CATALOG))) stop("WORKFLOW_CREDENTIAL_CATALOG_CONFLICT");
  const createdAt = now.toISOString();
  const entries = TARGETS.map((target) => {
    let bytes;
    let publicBytes;
    try {
      if (target.kind === "opaque-capability") bytes = Buffer.from(randomBytes(32).toString("base64url"));
      else {
        const pair = generateKeyPairSync("ed25519");
        bytes = pair.privateKey.export({ type: "pkcs8", format: "pem" });
        bytes = Buffer.from(bytes);
        publicBytes = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" }));
      }
      const fingerprintSha256 = fingerprint(target, bytes);
      createPrivate(root, target.path, bytes);
      if (publicBytes) createPrivate(root, target.companionPath, publicBytes);
      return {
        ...target, scope: "shared", status: "active",
        public: { fingerprintSha256, createdAt, preChangeBackupSha256: backupSha256,
          ...(target.id === "shared/workflow-bundle/approval-signing" ? {
            keyId: `workflow-bundle-v5-${createdAt.slice(0, 10).replaceAll("-", "")}-${fingerprintSha256.slice(0, 12)}`,
            policyRevision: "workflow-bundle-v5-approval-v1",
          } : { principal: "seori-auth:workflow-bundle-candidate-adapter" }) },
        consumers: target.id === "shared/workflow-bundle/approval-signing"
          ? ["seori-auth:workflow-bundle-v5-approval-signer"]
          : ["seorilabs-backoffice", "auth-broker:workflow-bundle-candidate-executor"],
      };
    } finally { bytes?.fill(0); publicBytes?.fill(0); }
  });
  createPrivate(root, `catalog/${CATALOG}`, Buffer.from(stringify({ version: 1, credentials: entries })));
  return { state: "ENROLLED_BACKUP_REQUIRED", changed: true, credentials: verifyRegistered(root, entries) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.SEORI_AUTH_NATIVE_LAUNCHED !== "1") stop("WORKFLOW_CREDENTIAL_NATIVE_LAUNCH_REQUIRED");
    const [mode = "plan", ...args] = process.argv.slice(2);
    const options = Object.fromEntries(args.map((arg) => {
      const match = /^--(confirmation|backup-sha256)=(.+)$/u.exec(arg);
      if (!match) stop("WORKFLOW_CREDENTIAL_ARGUMENT_INVALID");
      return [match[1], match[2]];
    }));
    const result = enrollWorkflowBundleCredentials({ root: join(homedir(), ".config", "seorilabs"), mode,
      confirmation: options.confirmation, backupSha256: options["backup-sha256"] });
    console.log(JSON.stringify(result));
  } catch (error) {
    const code = /^WORKFLOW_CREDENTIAL_[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "WORKFLOW_CREDENTIAL_OPERATION_FAILED";
    console.error(JSON.stringify({ state: "DENIED", code }));
    process.exitCode = 1;
  }
}
