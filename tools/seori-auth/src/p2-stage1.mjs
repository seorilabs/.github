import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  buildTangBackupAttestation,
  buildTangBackupEvidenceEnvelope,
  canonicalDigest,
  canonicalJson,
  sha256,
  tangBackupSignaturePayload,
} from './host-encryption-provisioning.mjs';

const ARCHIVE_KEYS = ['ciphertext', 'header', 'schemaVersion'];
const HEADER_KEYS = [
  'cipher', 'ephemeralPublicKey', 'format', 'hkdfSalt', 'iv', 'kdf',
  'logicalCredentialId', 'nodeName', 'recipientPublicKeySha256', 'tag',
];
const PAYLOAD_KEYS = ['directory', 'files', 'schemaVersion'];
const DIRECTORY_KEYS = ['groupId', 'mode', 'ownerId'];
const FILE_KEYS = ['content', 'groupId', 'mode', 'name', 'ownerId'];
const SHA256 = /^[a-f0-9]{64}$/u;
const JWK_NAME = /^[A-Za-z0-9._-]+\.jwk$/u;
const MODE = /^0[0-7]{3}$/u;
const X25519_SPKI_BYTES = 44;

export class P2Stage1Error extends Error {
  constructor(code) {
    super(code);
    this.name = 'P2Stage1Error';
    this.code = code;
  }
}

function stop(code) {
  throw new P2Stage1Error(code);
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function modeString(entry) {
  return (entry.mode & 0o7777).toString(8).padStart(4, '0');
}

function safeBase64(value, bytes, code) {
  if (typeof value !== 'string' || value.length > bytes * 2) stop(code);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) stop(code);
  return decoded;
}

function readHeldRegular(path, { allowedModes, maximumBytes, expectedOwner } = {}) {
  let descriptor;
  try {
    const entry = lstatSync(path);
    if (
      !entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path ||
      (allowedModes !== undefined && !allowedModes.includes(entry.mode & 0o777)) ||
      (expectedOwner !== undefined &&
        (entry.uid !== expectedOwner.ownerId || entry.gid !== expectedOwner.groupId))
    ) stop('P2_STAGE1_FILE_IDENTITY_INVALID');
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const held = fstatSync(descriptor);
    if (
      held.dev !== entry.dev || held.ino !== entry.ino || held.mode !== entry.mode ||
      held.uid !== entry.uid || held.gid !== entry.gid || held.size !== entry.size ||
      held.size < 1 || held.size > maximumBytes
    ) stop('P2_STAGE1_FILE_IDENTITY_INVALID');
    const bytes = readFileSync(descriptor);
    const current = lstatSync(path);
    if (
      current.dev !== entry.dev || current.ino !== entry.ino || current.size !== entry.size ||
      fstatSync(descriptor).size !== entry.size
    ) stop('P2_STAGE1_FILE_IDENTITY_DRIFT');
    return { bytes, entry };
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_FILE_IDENTITY_INVALID');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        stop('P2_STAGE1_FILE_CLOSE_FAILED');
      }
    }
  }
}

export function attestorPublicDetails(publicKeyBytes) {
  try {
    const key = createPublicKey(publicKeyBytes);
    if (key.asymmetricKeyType !== 'ed25519') stop('P2_STAGE1_ATTESTOR_KEY_INVALID');
    const der = key.export({ format: 'der', type: 'spki' });
    const fingerprintSha256 = sha256(der);
    return Object.freeze({
      algorithm: 'Ed25519',
      fingerprintSha256,
      keyId: `credential-backup-attestor-v1-${fingerprintSha256.slice(0, 12)}`,
    });
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_ATTESTOR_KEY_INVALID');
  }
}

export function verifyAttestorPair(privateKeyBytes, publicKeyBytes) {
  try {
    const privateKey = createPrivateKey(privateKeyBytes);
    if (privateKey.asymmetricKeyType !== 'ed25519') stop('P2_STAGE1_ATTESTOR_KEY_INVALID');
    const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const supplied = createPublicKey(publicKeyBytes).export({ format: 'der', type: 'spki' });
    if (!Buffer.from(derived).equals(Buffer.from(supplied))) stop('P2_STAGE1_ATTESTOR_KEY_MISMATCH');
    return attestorPublicDetails(publicKeyBytes);
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_ATTESTOR_KEY_INVALID');
  }
}

export function encryptionPublicDetails(publicKeyBytes) {
  try {
    const key = createPublicKey(publicKeyBytes);
    if (key.asymmetricKeyType !== 'x25519') stop('P2_STAGE1_ENCRYPTION_KEY_INVALID');
    const der = key.export({ format: 'der', type: 'spki' });
    const fingerprintSha256 = sha256(der);
    return Object.freeze({
      algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
      fingerprintSha256,
      keyId: `tang-backup-encryption-v1-${fingerprintSha256.slice(0, 12)}`,
    });
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_ENCRYPTION_KEY_INVALID');
  }
}

export function verifyEncryptionPair(privateKeyBytes, publicKeyBytes) {
  try {
    const privateKey = createPrivateKey(privateKeyBytes);
    if (privateKey.asymmetricKeyType !== 'x25519') stop('P2_STAGE1_ENCRYPTION_KEY_INVALID');
    const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const supplied = createPublicKey(publicKeyBytes).export({ format: 'der', type: 'spki' });
    if (!Buffer.from(derived).equals(Buffer.from(supplied))) {
      stop('P2_STAGE1_ENCRYPTION_KEY_MISMATCH');
    }
    return encryptionPublicDetails(publicKeyBytes);
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_ENCRYPTION_KEY_INVALID');
  }
}

export function expectedAttestorCatalogEntry(contract, publicDetails) {
  return Object.freeze({
    id: contract.attestor.logicalCredentialId,
    scope: 'shared',
    purpose: 'tang-backup-restore-attestation-signing',
    kind: 'ed25519-private-key',
    path: contract.attestor.privateKeyRelativePath,
    companionPath: contract.attestor.publicKeyRelativePath,
    public: { ...publicDetails },
    consumers: [...contract.attestor.consumers],
    status: 'active',
  });
}

export function expectedEncryptionCatalogEntry(contract, publicDetails) {
  return Object.freeze({
    id: contract.tangBackupEncryption.logicalCredentialId,
    scope: 'shared',
    purpose: 'tang-backup-public-key-envelope-decryption',
    kind: 'x25519-private-key',
    path: contract.tangBackupEncryption.privateKeyRelativePath,
    companionPath: contract.tangBackupEncryption.publicKeyRelativePath,
    public: { ...publicDetails },
    consumers: [...contract.tangBackupEncryption.consumers],
    status: 'active',
  });
}

export function expectedTangCatalogEntry(contract, server, evidence, serverAttestation) {
  if (
    !SHA256.test(evidence.backupArtifactSha256 ?? '') ||
    !SHA256.test(evidence.inventoryEvidenceSha256 ?? '') ||
    evidence.nodeName !== server.nodeName || evidence.logicalCredentialId !== server.backupLogicalId ||
    serverAttestation?.nodeName !== server.nodeName ||
    !SHA256.test(serverAttestation?.observedDigest ?? '')
  ) stop('P2_STAGE1_PRIVATE_EVIDENCE_INVALID');
  const root = `${contract.tangBackup.localRelativeRoot}/${server.nodeName}`;
  return Object.freeze({
    id: server.backupLogicalId,
    scope: 'shared',
    purpose: 'tang-server-key-encrypted-backup',
    kind: 'encrypted-tang-server-key-backup',
    path: `${root}/${contract.tangBackup.archiveSuffix}`,
    companionPath: `${root}/${contract.tangBackup.evidenceSuffix}`,
    public: {
      backupArtifactSha256: evidence.backupArtifactSha256,
      backupGeneration: evidence.backupGeneration,
      inventoryEvidenceSha256: evidence.inventoryEvidenceSha256,
      isolatedRestoreRunId: evidence.isolatedRestoreRunId,
      nodeName: server.nodeName,
      serverAttestationPath: `${root}/${contract.tangBackup.serverAttestationSuffix}`,
      serverAttestationDigest: serverAttestation.observedDigest,
    },
    consumers: [`${server.nodeName}:tangd`, 'rpi5:clevis'],
    status: 'active',
  });
}

export function readScopedTangInventory(
  directory,
  { logicalDirectory = '/var/lib/tang', enforcePrivate = true } = {},
) {
  let directoryEntry;
  let directoryDescriptor;
  try {
    directoryEntry = lstatSync(directory);
    if (
      !directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      (enforcePrivate && (directoryEntry.mode & 0o022) !== 0)
    ) stop('P2_STAGE1_TANG_DIRECTORY_INVALID');
    if (process.platform === 'linux') {
      directoryDescriptor = openSync(
        directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const held = fstatSync(directoryDescriptor);
      if (
        held.dev !== directoryEntry.dev || held.ino !== directoryEntry.ino ||
        held.mode !== directoryEntry.mode || held.uid !== directoryEntry.uid ||
        held.gid !== directoryEntry.gid
      ) stop('P2_STAGE1_TANG_DIRECTORY_INVALID');
    }
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_TANG_DIRECTORY_INVALID');
  }
  const contentRecords = [];
  const metadataRecords = [];
  const archiveFiles = [];
  try {
    const enumerationPath = directoryDescriptor === undefined
      ? directory
      : `/proc/self/fd/${directoryDescriptor}`;
    const names = readdirSync(enumerationPath, { withFileTypes: true })
      .map((entry) => {
        if (!entry.isFile() || entry.isSymbolicLink() || !JWK_NAME.test(entry.name)) {
          stop('P2_STAGE1_TANG_SCOPE_INVALID');
        }
        return entry.name;
      })
      .toSorted();
  if (names.length < 2 || names.length > 64 || new Set(names).size !== names.length) {
      stop('P2_STAGE1_TANG_INVENTORY_PARTIAL');
    }
    for (const name of names) {
      let bytes;
      let entry;
      if (directoryDescriptor === undefined) {
        ({ bytes, entry } = readHeldRegular(join(directory, name), {
          allowedModes: [0o440],
          maximumBytes: 128 * 1024,
          expectedOwner: { ownerId: directoryEntry.uid, groupId: directoryEntry.gid },
        }));
      } else {
        let descriptor;
        try {
          descriptor = openSync(
            `/proc/self/fd/${directoryDescriptor}/${name}`,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
          );
          entry = fstatSync(descriptor);
          if (
            !entry.isFile() || (entry.mode & 0o777) !== 0o440 ||
            entry.uid !== directoryEntry.uid || entry.gid !== directoryEntry.gid ||
            entry.size < 1 || entry.size > 128 * 1024
          ) stop('P2_STAGE1_FILE_IDENTITY_INVALID');
          bytes = readFileSync(descriptor);
          const after = fstatSync(descriptor);
          if (
            after.dev !== entry.dev || after.ino !== entry.ino || after.mode !== entry.mode ||
            after.uid !== entry.uid || after.gid !== entry.gid || after.size !== entry.size
          ) stop('P2_STAGE1_FILE_IDENTITY_DRIFT');
        } catch (error) {
          if (error instanceof P2Stage1Error) throw error;
          stop('P2_STAGE1_FILE_IDENTITY_INVALID');
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
        }
      }
      contentRecords.push({ name, sha256: sha256(bytes) });
      metadataRecords.push({
        name,
        ownerId: entry.uid,
        groupId: entry.gid,
        mode: modeString(entry),
        sizeBytes: entry.size,
      });
      archiveFiles.push({
        name,
        ownerId: entry.uid,
        groupId: entry.gid,
        mode: modeString(entry),
        content: bytes.toString('base64'),
      });
      bytes.fill(0);
    }
    const contentSha256 = canonicalDigest(contentRecords);
    const metadataSha256 = canonicalDigest({
      directory: {
        ownerId: directoryEntry.uid,
        groupId: directoryEntry.gid,
        mode: modeString(directoryEntry),
      },
      files: metadataRecords,
    });
    if (directoryDescriptor !== undefined) {
      const heldAfter = fstatSync(directoryDescriptor);
      const pathAfter = lstatSync(directory);
      if (
        heldAfter.dev !== directoryEntry.dev || heldAfter.ino !== directoryEntry.ino ||
        heldAfter.mode !== directoryEntry.mode || heldAfter.uid !== directoryEntry.uid ||
        heldAfter.gid !== directoryEntry.gid || pathAfter.dev !== directoryEntry.dev ||
        pathAfter.ino !== directoryEntry.ino || pathAfter.mode !== directoryEntry.mode ||
        pathAfter.uid !== directoryEntry.uid || pathAfter.gid !== directoryEntry.gid
      ) stop('P2_STAGE1_TANG_DIRECTORY_DRIFT');
    }
    return Object.freeze({
      publicInventory: Object.freeze({
        directory: logicalDirectory,
        fileCount: names.length,
        inventoryEvidenceSha256: canonicalDigest({ contentSha256, metadataSha256 }),
      }),
      privateInventory: Object.freeze({
        contentSha256,
        metadataSha256,
        inventoryEvidenceSha256: canonicalDigest({ contentSha256, metadataSha256 }),
      }),
      archivePayload: {
        schemaVersion: 1,
        directory: {
          ownerId: directoryEntry.uid,
          groupId: directoryEntry.gid,
          mode: modeString(directoryEntry),
        },
        files: archiveFiles,
      },
    });
  } catch (error) {
    for (const entry of archiveFiles) entry.content = '';
    throw error;
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
}

function archiveContext(contract, server, recipientPublicKeySha256) {
  return Buffer.from(canonicalJson({
    domain: 'seorilabs-tang-backup-envelope-v1',
    format: contract.tangBackup.format,
    nodeName: server.nodeName,
    logicalCredentialId: server.backupLogicalId,
    recipientPublicKeySha256,
  }), 'utf8');
}

export function encryptTangBackup({ contract, server, archivePayload, recipientPublicKeyBytes }) {
  if (!exactKeys(archivePayload, PAYLOAD_KEYS)) stop('P2_STAGE1_ARCHIVE_PAYLOAD_INVALID');
  const recipient = encryptionPublicDetails(recipientPublicKeyBytes);
  const recipientPublicKey = createPublicKey(recipientPublicKeyBytes);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublicKey = ephemeral.publicKey.export({ format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublicKey });
  const hkdfSalt = randomBytes(32);
  const iv = randomBytes(12);
  const context = archiveContext(contract, server, recipient.fingerprintSha256);
  const key = Buffer.from(hkdfSync('sha256', shared, hkdfSalt, context, 32));
  const plaintext = Buffer.from(canonicalJson(archivePayload), 'utf8');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const header = {
      format: contract.tangBackup.format,
      cipher: contract.tangBackup.cipher,
      kdf: contract.tangBackup.kdf,
      nodeName: server.nodeName,
      logicalCredentialId: server.backupLogicalId,
      recipientPublicKeySha256: recipient.fingerprintSha256,
      ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString('base64'),
      hkdfSalt: hkdfSalt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
    return Buffer.from(`${canonicalJson({
      schemaVersion: 1,
      header,
      ciphertext: ciphertext.toString('base64'),
    })}\n`, 'utf8');
  } finally {
    key.fill(0);
    plaintext.fill(0);
    shared.fill(0);
    hkdfSalt.fill(0);
    iv.fill(0);
    context.fill(0);
    Buffer.from(ephemeralPublicKey).fill(0);
  }
}

export function tangBackupEnvelopePublic({ contract, server, artifactBytes }) {
  let record;
  try {
    record = JSON.parse(artifactBytes.toString('utf8'));
  } catch {
    stop('P2_STAGE1_BACKUP_FORMAT_INVALID');
  }
  if (
    !exactKeys(record, ARCHIVE_KEYS) || record.schemaVersion !== 1 ||
    !exactKeys(record.header, HEADER_KEYS) ||
    record.header.format !== contract.tangBackup.format ||
    record.header.cipher !== contract.tangBackup.cipher ||
    record.header.kdf !== contract.tangBackup.kdf ||
    record.header.nodeName !== server.nodeName ||
    record.header.logicalCredentialId !== server.backupLogicalId ||
    !SHA256.test(record.header.recipientPublicKeySha256 ?? '') ||
    typeof record.ciphertext !== 'string' || record.ciphertext.length > 2 * 1024 * 1024
  ) stop('P2_STAGE1_BACKUP_FORMAT_INVALID');
  safeBase64(record.header.ephemeralPublicKey, X25519_SPKI_BYTES, 'P2_STAGE1_BACKUP_FORMAT_INVALID').fill(0);
  safeBase64(record.header.hkdfSalt, 32, 'P2_STAGE1_BACKUP_FORMAT_INVALID').fill(0);
  safeBase64(record.header.iv, 12, 'P2_STAGE1_BACKUP_FORMAT_INVALID').fill(0);
  safeBase64(record.header.tag, 16, 'P2_STAGE1_BACKUP_FORMAT_INVALID').fill(0);
  const ciphertext = Buffer.from(record.ciphertext, 'base64');
  try {
    if (ciphertext.length < 1 || ciphertext.toString('base64') !== record.ciphertext) {
      stop('P2_STAGE1_BACKUP_FORMAT_INVALID');
    }
  } finally {
    ciphertext.fill(0);
  }
  return Object.freeze({
    nodeName: server.nodeName,
    logicalCredentialId: server.backupLogicalId,
    recipientPublicKeySha256: record.header.recipientPublicKeySha256,
    backupArtifactSha256: sha256(artifactBytes),
  });
}

export function decryptTangBackup({
  contract,
  server,
  artifactBytes,
  recipientPrivateKeyBytes,
  recipientPublicKeyBytes,
}) {
  tangBackupEnvelopePublic({ contract, server, artifactBytes });
  const record = JSON.parse(artifactBytes.toString('utf8'));
  const recipient = verifyEncryptionPair(recipientPrivateKeyBytes, recipientPublicKeyBytes);
  if (record.header.recipientPublicKeySha256 !== recipient.fingerprintSha256) {
    stop('P2_STAGE1_BACKUP_RECIPIENT_MISMATCH');
  }
  const ephemeralDer = safeBase64(
    record.header.ephemeralPublicKey,
    X25519_SPKI_BYTES,
    'P2_STAGE1_BACKUP_FORMAT_INVALID',
  );
  let ephemeralPublicKey;
  try {
    ephemeralPublicKey = createPublicKey({ key: ephemeralDer, format: 'der', type: 'spki' });
    if (ephemeralPublicKey.asymmetricKeyType !== 'x25519') stop('P2_STAGE1_BACKUP_FORMAT_INVALID');
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_BACKUP_FORMAT_INVALID');
  }
  const hkdfSalt = safeBase64(record.header.hkdfSalt, 32, 'P2_STAGE1_BACKUP_FORMAT_INVALID');
  const iv = safeBase64(record.header.iv, 12, 'P2_STAGE1_BACKUP_FORMAT_INVALID');
  const tag = safeBase64(record.header.tag, 16, 'P2_STAGE1_BACKUP_FORMAT_INVALID');
  const ciphertext = Buffer.from(record.ciphertext, 'base64');
  if (ciphertext.length < 1 || ciphertext.toString('base64') !== record.ciphertext) {
    stop('P2_STAGE1_BACKUP_FORMAT_INVALID');
  }
  const privateKey = createPrivateKey(recipientPrivateKeyBytes);
  const shared = diffieHellman({ privateKey, publicKey: ephemeralPublicKey });
  const context = archiveContext(contract, server, recipient.fingerprintSha256);
  const key = Buffer.from(hkdfSync('sha256', shared, hkdfSalt, context, 32));
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(context);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (
      !exactKeys(payload, PAYLOAD_KEYS) || payload.schemaVersion !== 1 ||
      !exactKeys(payload.directory, DIRECTORY_KEYS) || !Array.isArray(payload.files) ||
      !Number.isSafeInteger(payload.directory.ownerId) || payload.directory.ownerId < 0 ||
      !Number.isSafeInteger(payload.directory.groupId) || payload.directory.groupId < 0 ||
      !MODE.test(payload.directory.mode ?? '') ||
      (Number.parseInt(payload.directory.mode, 8) & 0o022) !== 0 ||
      payload.files.length < 2 || payload.files.length > 64 || payload.files.some((entry) =>
        !exactKeys(entry, FILE_KEYS) || !JWK_NAME.test(entry.name ?? '') ||
        entry.mode !== '0440' || !Number.isSafeInteger(entry.ownerId) || entry.ownerId < 0 ||
        !Number.isSafeInteger(entry.groupId) || entry.groupId < 0 ||
        typeof entry.content !== 'string') ||
      new Set(payload.files.map(({ name }) => name)).size !== payload.files.length
    ) stop('P2_STAGE1_ARCHIVE_PAYLOAD_INVALID');
    return payload;
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_BACKUP_DECRYPT_FAILED');
  } finally {
    key.fill(0);
    shared.fill(0);
    hkdfSalt.fill(0);
    ephemeralDer.fill(0);
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    context.fill(0);
    plaintext?.fill(0);
  }
}

export function isolatedRestoreInventory({
  payload,
  temporaryParent,
  enforcePrivate = true,
  applyOwnership = true,
}) {
  const root = realpathSync(mkdtempSync(join(temporaryParent, 'seorilabs-tang-restore-')));
  const tang = join(root, 'tang');
  try {
    mkdirSync(tang, { mode: 0o700 });
    for (const entry of payload.files) {
      const content = Buffer.from(entry.content, 'base64');
      if (content.length < 1 || content.length > 128 * 1024 || content.toString('base64') !== entry.content) {
        stop('P2_STAGE1_ARCHIVE_PAYLOAD_INVALID');
      }
      const descriptor = openSync(
        join(tang, entry.name),
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(descriptor, content);
        if (applyOwnership) fchownSync(descriptor, entry.ownerId, entry.groupId);
        fchmodSync(descriptor, Number.parseInt(entry.mode, 8));
      } finally {
        closeSync(descriptor);
        content.fill(0);
      }
    }
    const directoryDescriptor = openSync(tang, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      if (applyOwnership) {
        fchownSync(directoryDescriptor, payload.directory.ownerId, payload.directory.groupId);
      }
      fchmodSync(directoryDescriptor, Number.parseInt(payload.directory.mode, 8));
    } finally {
      closeSync(directoryDescriptor);
    }
    if (applyOwnership) return readScopedTangInventory(tang, { enforcePrivate }).privateInventory;
    const contentRecords = [];
    const metadataRecords = [];
    for (const expected of payload.files.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const { bytes, entry } = readHeldRegular(join(tang, expected.name), {
        allowedModes: [Number.parseInt(expected.mode, 8)],
        maximumBytes: 128 * 1024,
      });
      try {
        contentRecords.push({ name: expected.name, sha256: sha256(bytes) });
        metadataRecords.push({
          name: expected.name,
          ownerId: expected.ownerId,
          groupId: expected.groupId,
          mode: modeString(entry),
          sizeBytes: entry.size,
        });
      } finally {
        bytes.fill(0);
      }
    }
    const contentSha256 = canonicalDigest(contentRecords);
    const metadataSha256 = canonicalDigest({
      directory: {
        ownerId: payload.directory.ownerId,
        groupId: payload.directory.groupId,
        mode: payload.directory.mode,
      },
      files: metadataRecords,
    });
    return Object.freeze({
      contentSha256,
      metadataSha256,
      inventoryEvidenceSha256: canonicalDigest({ contentSha256, metadataSha256 }),
    });
  } catch (error) {
    if (error instanceof P2Stage1Error) throw error;
    stop('P2_STAGE1_ISOLATED_RESTORE_FAILED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function buildVerifiedPrivateEvidence({ server, artifactSha256, live, restored }) {
  if (
    !SHA256.test(artifactSha256 ?? '') ||
    live.contentSha256 !== restored.contentSha256 ||
    live.metadataSha256 !== restored.metadataSha256 ||
    live.inventoryEvidenceSha256 !== restored.inventoryEvidenceSha256
  ) stop('P2_STAGE1_ISOLATED_RESTORE_MISMATCH');
  return Object.freeze({
    schemaVersion: 1,
    nodeName: server.nodeName,
    logicalCredentialId: server.backupLogicalId,
    liveContentSha256: live.contentSha256,
    liveMetadataSha256: live.metadataSha256,
    inventoryEvidenceSha256: live.inventoryEvidenceSha256,
    backupArtifactSha256: artifactSha256,
    backupGeneration: `tang-${server.nodeName}-${artifactSha256.slice(0, 16)}`,
    isolatedRestoreContentSha256: restored.contentSha256,
    isolatedRestoreMetadataSha256: restored.metadataSha256,
    isolatedRestoreRunId: `restore-${server.nodeName}-${artifactSha256.slice(0, 16)}`,
  });
}

export function signTangPrivateEvidence({ hostContract, server, privateEvidence, privateKeyBytes, publicKeyBytes }) {
  verifyAttestorPair(privateKeyBytes, publicKeyBytes);
  const envelope = buildTangBackupEvidenceEnvelope({
    contract: hostContract,
    server,
    privateEvidence,
    authorityPublicKey: publicKeyBytes,
  });
  let signature;
  try {
    const key = createPrivateKey(privateKeyBytes);
    signature = sign(null, tangBackupSignaturePayload(hostContract, envelope), key).toString('base64');
  } catch {
    stop('P2_STAGE1_ATTESTOR_SIGN_FAILED');
  }
  return buildTangBackupAttestation({
    contract: hostContract,
    server,
    privateEvidence,
    authorityPublicKey: publicKeyBytes,
    signature,
  });
}
