import {
  constants as cryptoConstants,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
} from "node:crypto";
import { parseAllDocuments } from "yaml";

import { isGithubKeychainCredentialStore } from "./github-keychain-native-store.mjs";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).toSorted().join("\0") ===
      [...expected].toSorted().join("\0")
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseYamlDocuments(bytes, code) {
  try {
    return parseAllDocuments(bytes.toString("utf8"))
      .map((document) => document.toJSON())
      .filter(Boolean);
  } catch {
    fail(code);
  }
}

function recoverySecrets(bytes) {
  const roots = parseYamlDocuments(bytes, "P3_GITHUB_RECOVERY_KEY_PARSE_FAILED");
  const secrets = roots.flatMap((entry) =>
    entry?.kind === "List" ? entry.items ?? [] : [entry],
  );
  const privateKeys = [];
  for (const secret of secrets) {
    if (
      secret?.kind !== "Secret" ||
      typeof secret?.data?.["tls.key"] !== "string"
    ) {
      continue;
    }
    let keyBytes;
    try {
      keyBytes = Buffer.from(secret.data["tls.key"], "base64");
      privateKeys.push(createPrivateKey(keyBytes));
    } catch {
      fail("P3_GITHUB_RECOVERY_KEY_INVALID");
    } finally {
      keyBytes?.fill(0);
    }
  }
  if (privateKeys.length === 0) fail("P3_GITHUB_RECOVERY_KEY_MISSING");
  return privateKeys;
}

function decryptCiphertext(ciphertextBase64, label, privateKeys) {
  let ciphertext;
  try {
    ciphertext = Buffer.from(ciphertextBase64, "base64");
    if (ciphertext.length < 2) fail("P3_GITHUB_CIPHERTEXT_INVALID");
    const rsaLength = ciphertext.readUInt16BE(0);
    if (rsaLength < 128 || ciphertext.length < 2 + rsaLength + 28) {
      fail("P3_GITHUB_CIPHERTEXT_INVALID");
    }
    const rsaCiphertext = ciphertext.subarray(2, 2 + rsaLength);
    const encryptedPayload = ciphertext.subarray(2 + rsaLength);
    const nonce = encryptedPayload.subarray(0, 12);
    const body = encryptedPayload.subarray(12, encryptedPayload.length - 16);
    const tag = encryptedPayload.subarray(encryptedPayload.length - 16);
    for (const privateKey of privateKeys) {
      let sessionKey;
      try {
        sessionKey = privateDecrypt(
          {
            key: privateKey,
            oaepHash: "sha256",
            oaepLabel: label,
            padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          },
          rsaCiphertext,
        );
        if (sessionKey.length !== 32) continue;
        const decipher = createDecipheriv(
          "aes-256-gcm",
          sessionKey,
          nonce,
        );
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        // Recovery backups can contain historical keys. Try the next one.
      } finally {
        sessionKey?.fill(0);
      }
    }
    fail("P3_GITHUB_CIPHERTEXT_DECRYPT_FAILED");
  } finally {
    ciphertext?.fill(0);
  }
}

function sourceReadback(bytes, expected) {
  if (sha256(bytes) !== expected.source.manifestSha256) {
    fail("P3_GITHUB_RECOVERY_SOURCE_DIGEST_MISMATCH");
  }
  const documents = parseYamlDocuments(
    bytes,
    "P3_GITHUB_RECOVERY_SOURCE_PARSE_FAILED",
  );
  if (documents.length !== 1) fail("P3_GITHUB_RECOVERY_SOURCE_INVALID");
  const source = documents[0];
  if (
    source?.kind !== expected.source.kind ||
    source?.metadata?.name !== expected.source.name ||
    source?.metadata?.namespace !== expected.source.namespace ||
    source?.spec?.template?.metadata?.name !== expected.source.name ||
    source?.spec?.template?.metadata?.namespace !== expected.source.namespace ||
    source?.metadata?.annotations?.["sealedsecrets.bitnami.com/cluster-wide"] ===
      "true" ||
    source?.metadata?.annotations?.["sealedsecrets.bitnami.com/namespace-wide"] ===
      "true"
  ) {
    fail("P3_GITHUB_RECOVERY_SOURCE_IDENTITY_MISMATCH");
  }
  const encryptedData = source?.spec?.encryptedData;
  if (!encryptedData || typeof encryptedData !== "object") {
    fail("P3_GITHUB_RECOVERY_ENCRYPTED_DATA_MISSING");
  }
  for (const { encryptedKey } of expected.mappings) {
    if (typeof encryptedData[encryptedKey] !== "string") {
      fail("P3_GITHUB_RECOVERY_ENCRYPTED_KEY_MISSING");
    }
  }
  return encryptedData;
}

function publicKeyFingerprint(privateKeyBytes) {
  try {
    const privateKey = createPrivateKey(privateKeyBytes);
    const publicDer = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    try {
      return sha256(publicDer);
    } finally {
      publicDer.fill(0);
    }
  } catch {
    fail("P3_GITHUB_APP_PRIVATE_KEY_INVALID");
  }
}

function validateAdapters(adapters) {
  if (
    !exactKeys(adapters, [
      "approval",
      "appIdentity",
      "backupRestore",
      "catalog",
      "credentialStore",
    ]) ||
    typeof adapters.approval.authorize !== "function" ||
    typeof adapters.appIdentity.read !== "function" ||
    typeof adapters.backupRestore.verify !== "function" ||
    typeof adapters.catalog.targetsAbsent !== "function" ||
    typeof adapters.catalog.registerBatch !== "function" ||
    typeof adapters.catalog.removeBatch !== "function" ||
    !isGithubKeychainCredentialStore(adapters.credentialStore) ||
    typeof adapters.credentialStore.writeBatch !== "function" ||
    typeof adapters.credentialStore.removeBatch !== "function"
  ) {
    fail("P3_GITHUB_RECOVERY_TRUSTED_ADAPTERS_REQUIRED");
  }
}

function identityExact(actual, expected) {
  return (
    actual?.appId === expected.appId &&
    actual?.slug === expected.slug &&
    actual?.installationId === expected.installationId &&
    actual?.targetType === expected.targetType &&
    actual?.repositorySelection === expected.repositorySelection &&
    actual?.suspendedAt === null
  );
}

export async function recoverGithubAppCredentials({
  contract,
  sourceBytes,
  recoveryBytes,
  adapters,
}) {
  if (!Buffer.isBuffer(sourceBytes) || !Buffer.isBuffer(recoveryBytes)) {
    fail("P3_GITHUB_RECOVERY_BUFFERS_REQUIRED");
  }
  let decrypted = [];
  let stored = false;
  let registered = false;
  let publicPlan = { targets: [] };
  try {
    const recovery = contract?.github?.credentialRecovery;
    const app = contract?.github?.app;
    if (!recovery || !app?.reuseExisting) {
      fail("P3_GITHUB_RECOVERY_CONTRACT_INVALID");
    }
    if (recovery.trustedAdapter?.state !== "ready") {
      fail("P3_GITHUB_RECOVERY_NATIVE_HELPER_REQUIRED");
    }
    validateAdapters(adapters);
    publicPlan = {
      operation: recovery.approvalGate.operation,
      source: recovery.source,
      targets: recovery.mappings.map(
        ({ encryptedKey, targetCredentialId, targetKind, keychainService, catalogPath }) => ({
          encryptedKey,
          targetCredentialId,
          targetKind,
          keychainService,
          catalogPath,
        }),
      ),
      appIdentity: {
        appId: app.appId,
        slug: app.slug,
        installationId: app.installationId,
        targetType: app.targetType,
        repositorySelection: app.repositorySelection,
      },
      staticKeysCreated: false,
    };
    const encryptedData = sourceReadback(sourceBytes, recovery);
    if (!(await adapters.approval.authorize(publicPlan))) {
      fail("P3_GITHUB_RECOVERY_APPROVAL_REQUIRED");
    }
    if (!(await adapters.catalog.targetsAbsent(publicPlan.targets))) {
      fail("P3_GITHUB_RECOVERY_TARGET_ALREADY_EXISTS");
    }
    if (!(await adapters.backupRestore.verify("pre-recovery"))) {
      fail("P3_GITHUB_RECOVERY_PRE_BACKUP_RESTORE_REQUIRED");
    }
    const actualIdentity = await adapters.appIdentity.read();
    if (!identityExact(actualIdentity, publicPlan.appIdentity)) {
      fail("P3_GITHUB_RECOVERY_APP_IDENTITY_MISMATCH");
    }
    const privateKeys = recoverySecrets(recoveryBytes);
    const label = Buffer.from(
      `${recovery.source.namespace}${recovery.source.name}`,
      "utf8",
    );
    try {
      for (const mapping of recovery.mappings) {
        const secret = decryptCiphertext(
          encryptedData[mapping.encryptedKey],
          label,
          privateKeys,
        );
        decrypted.push({ ...mapping, secret });
      }
    } finally {
      label.fill(0);
    }
    const appPrivateKey = decrypted.find(
      ({ encryptedKey }) => encryptedKey === "GITHUB_PRIVATE_KEY",
    )?.secret;
    const webhook = decrypted.find(
      ({ encryptedKey }) => encryptedKey === "GITHUB_WEBHOOK_SECRET",
    )?.secret;
    const appPublicKeyFingerprintSha256 = publicKeyFingerprint(appPrivateKey);
    if (!webhook || webhook.length < 32 || webhook.length > 4096) {
      fail("P3_GITHUB_WEBHOOK_SECRET_INVALID");
    }
    const webhookFingerprintSha256 = sha256(webhook);
    await adapters.credentialStore.writeBatch(decrypted);
    stored = true;
    registered = true;
    await adapters.catalog.registerBatch(
      publicPlan.targets.map((target) => ({ ...target, status: "active" })),
    );
    if (!(await adapters.backupRestore.verify("post-recovery"))) {
      fail("P3_GITHUB_RECOVERY_POST_BACKUP_RESTORE_REQUIRED");
    }
    return {
      state: "RECOVERED",
      sourceManifestSha256: recovery.source.manifestSha256,
      appIdentity: actualIdentity,
      appPublicKeyFingerprintSha256,
      webhookFingerprintSha256,
      logicalCredentials: publicPlan.targets.map(({ targetCredentialId }) => ({
        id: targetCredentialId,
        status: "active",
      })),
      backupRestore: { preRecovery: true, postRecovery: true },
      staticKeysCreated: false,
    };
  } catch (error) {
    const originalCode =
      typeof error?.code === "string" && /^P3_[A-Z0-9_]+$/u.test(error.code)
        ? error.code
        : "P3_GITHUB_RECOVERY_TRUSTED_ADAPTER_FAILED";
    let cleanupFailed = error?.compensationFailed === true;
    if (registered) {
      try {
        await adapters.catalog.removeBatch(publicPlan.targets);
      } catch {
        cleanupFailed = true;
      }
    }
    if (stored) {
      try {
        await adapters.credentialStore.removeBatch(publicPlan.targets);
      } catch {
        cleanupFailed = true;
      }
    }
    const publicError = new Error(originalCode);
    publicError.code = originalCode;
    if (cleanupFailed) publicError.compensationFailed = true;
    throw publicError;
  } finally {
    for (const { secret } of decrypted) secret.fill(0);
    sourceBytes.fill(0);
    recoveryBytes.fill(0);
  }
}
