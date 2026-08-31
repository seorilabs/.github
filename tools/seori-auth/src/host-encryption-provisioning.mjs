import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  buildHostEncryptedMountAttestation,
  validateHostEncryptedMountAttestation,
} from './host-encrypted-mount.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const LUKS_UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const TANG_THUMBPRINT = /^[A-Za-z0-9_-]{43}$/u;
const TANG_JWS_COMPONENT = /^[A-Za-z0-9_-]+$/u;
const PUBLIC_ID = /^[A-Za-z0-9._:/-]{1,256}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9.+:~_-]{1,128}$/u;

export class HostEncryptionProvisioningError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HostEncryptionProvisioningError';
    this.code = code;
  }
}

function stop(code) {
  throw new HostEncryptionProvisioningError(code);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableTangAdvertisementDigest(advertisement) {
  let value;
  try {
    value = JSON.parse(advertisement);
  } catch {
    stop('P2_TANG_ADVERTISEMENT_READBACK_INVALID');
  }
  if (
    !exactKeys(value, ['payload', 'protected', 'signature']) ||
    !TANG_JWS_COMPONENT.test(value.payload ?? '') ||
    !TANG_JWS_COMPONENT.test(value.protected ?? '') ||
    !TANG_JWS_COMPONENT.test(value.signature ?? '')
  ) stop('P2_TANG_ADVERTISEMENT_READBACK_INVALID');
  return sha256(`${value.protected}.${value.payload}`);
}

export function canonicalDigest(value) {
  return sha256(canonicalJson(value));
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

function withDigest(core) {
  return freeze({ ...structuredClone(core), observedDigest: canonicalDigest(core) });
}

function validateDigestEnvelope(value, keys, code) {
  if (!exactKeys(value, [...keys, 'observedDigest']) || !SHA256.test(value.observedDigest ?? '')) {
    stop(code);
  }
  const core = { ...value };
  delete core.observedDigest;
  if (canonicalDigest(core) !== value.observedDigest) stop(code);
  return value;
}

export function contractDigest(contract) {
  if (contract?.schemaVersion !== 1 || contract?.target?.nodeName !== 'rpi5') {
    stop('P2_HOST_CONTRACT_INVALID');
  }
  buildSystemdConfiguration(contract);
  return canonicalDigest(contract);
}

const SYSTEMD_CONFIGURATION_KEYS = [
  'cryptsetupUnit', 'crypttabLine', 'crypttabPath', 'fstabLine', 'fstabPath',
  'mountUnit', 'unlockerUnit',
];

function systemdEscapeSegment(value) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value ?? '')) {
    stop('P2_HOST_SYSTEMD_CONTRACT_INVALID');
  }
  return value.replaceAll('-', '\\x2d');
}

export function buildSystemdConfiguration(contract) {
  const systemd = contract?.systemd;
  const target = contract?.target;
  if (
    !exactKeys(systemd, SYSTEMD_CONFIGURATION_KEYS) ||
    target?.mapperName === undefined || target?.sourcePath === undefined ||
    target?.mapperPath === undefined || target?.mountPath === undefined ||
    target?.filesystemType === undefined || !target.mountPath.startsWith('/')
  ) stop('P2_HOST_SYSTEMD_CONTRACT_INVALID');
  const cryptsetupUnit = `systemd-cryptsetup@${systemdEscapeSegment(target.mapperName)}.service`;
  const mountUnit = `${target.mountPath.slice(1).split('/').map(systemdEscapeSegment).join('-')}.mount`;
  const crypttabLine = `${target.mapperName} ${target.sourcePath} none luks,_netdev`;
  const fstabLine = `${target.mapperPath} ${target.mountPath} ${target.filesystemType} ` +
    `defaults,_netdev,nofail,x-systemd.requires=${cryptsetupUnit} 0 2`;
  if (
    systemd.crypttabPath !== '/etc/crypttab' || systemd.fstabPath !== '/etc/fstab' ||
    systemd.crypttabLine !== crypttabLine || systemd.fstabLine !== fstabLine ||
    systemd.cryptsetupUnit !== cryptsetupUnit || systemd.mountUnit !== mountUnit ||
    systemd.unlockerUnit !== 'clevis-luks-askpass.path'
  ) stop('P2_HOST_SYSTEMD_CONTRACT_INVALID');
  return freeze({
    crypttabPath: systemd.crypttabPath,
    crypttabLine,
    fstabPath: systemd.fstabPath,
    fstabLine,
    cryptsetupUnit,
    unlockerUnit: systemd.unlockerUnit,
    mountUnit,
  });
}

export function confirmations(contract) {
  const digest = contractDigest(contract).slice(0, 12);
  return freeze({
    backup: `fleet-p2-host-backup-${digest}`,
    apply: `fleet-p2-host-apply-${digest}`,
    rollback: `fleet-p2-host-rollback-${digest}`,
    restore: `fleet-p2-host-restore-${digest}`,
    tang: Object.fromEntries(contract.tang.servers.map(({ nodeName }) => [
      nodeName,
      `fleet-p2-tang-${nodeName}-${digest}`,
    ])),
  });
}

export function buildClevisPolicy(contract, tangAttestations, authorityPublicKey) {
  const attestations = validateTangFleetAttestations(
    contract,
    tangAttestations,
    authorityPublicKey,
  );
  return freeze({
    t: contract.tang.threshold,
    pins: {
      tang: attestations.map((attestation) => ({
        url: attestation.url,
        thp: attestation.signingKeyThumbprints[0],
      })),
    },
  });
}

const BACKUP_PRIVATE_EVIDENCE_KEYS = [
  'backupArtifactSha256', 'backupGeneration', 'inventoryEvidenceSha256',
  'isolatedRestoreContentSha256', 'isolatedRestoreMetadataSha256',
  'isolatedRestoreRunId', 'liveContentSha256', 'liveMetadataSha256',
  'logicalCredentialId', 'nodeName', 'schemaVersion',
];
const BACKUP_ENVELOPE_KEYS = [
  'backupArtifactSha256', 'backupGeneration', 'inventoryEvidenceSha256',
  'isolatedRestoreRunId', 'logicalCredentialId', 'nodeName',
  'privateEvidenceSha256', 'schemaVersion', 'signerIdentity',
  'signerLogicalCredentialId', 'signerPublicKeySha256', 'state',
];
const BACKUP_ATTESTATION_KEYS = ['envelope', 'schemaVersion', 'signature'];
const RAW_BACKUP_ATTESTATION_KEYS = [
  'envelope', 'privateEvidence', 'schemaVersion', 'signature',
];
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/u;

function authorityPublicKeyDetails(authorityPublicKey) {
  try {
    const key = createPublicKey(authorityPublicKey);
    if (key.asymmetricKeyType !== 'ed25519') stop('P2_TANG_BACKUP_TRUST_ANCHOR_INVALID');
    const der = key.export({ format: 'der', type: 'spki' });
    return freeze({ key, sha256: sha256(der) });
  } catch (error) {
    if (error instanceof HostEncryptionProvisioningError) throw error;
    stop('P2_TANG_BACKUP_TRUST_ANCHOR_INVALID');
  }
}

function validateTangPrivateBackupEvidence({ server, privateEvidence }) {
  if (
    !exactKeys(privateEvidence, BACKUP_PRIVATE_EVIDENCE_KEYS) ||
    privateEvidence.schemaVersion !== 1 ||
    privateEvidence.nodeName !== server.nodeName ||
    privateEvidence.logicalCredentialId !== server.backupLogicalId ||
    !SHA256.test(privateEvidence.liveContentSha256 ?? '') ||
    !SHA256.test(privateEvidence.liveMetadataSha256 ?? '') ||
    !SHA256.test(privateEvidence.inventoryEvidenceSha256 ?? '') ||
    !SHA256.test(privateEvidence.backupArtifactSha256 ?? '') ||
    !PUBLIC_ID.test(privateEvidence.backupGeneration ?? '') ||
    !SHA256.test(privateEvidence.isolatedRestoreContentSha256 ?? '') ||
    !SHA256.test(privateEvidence.isolatedRestoreMetadataSha256 ?? '') ||
    !PUBLIC_ID.test(privateEvidence.isolatedRestoreRunId ?? '') ||
    privateEvidence.liveContentSha256 !== privateEvidence.isolatedRestoreContentSha256 ||
    privateEvidence.liveMetadataSha256 !== privateEvidence.isolatedRestoreMetadataSha256 ||
    privateEvidence.inventoryEvidenceSha256 !== canonicalDigest({
      contentSha256: privateEvidence.liveContentSha256,
      metadataSha256: privateEvidence.liveMetadataSha256,
    })
  ) stop('P2_TANG_BACKUP_PRIVATE_EVIDENCE_INVALID');
  return privateEvidence;
}

export function buildTangBackupEvidenceEnvelope({
  contract,
  server,
  privateEvidence,
  authorityPublicKey,
}) {
  validateTangPrivateBackupEvidence({ server, privateEvidence });
  const authority = contract?.tang?.backupAuthority;
  const key = authorityPublicKeyDetails(authorityPublicKey);
  if (
    contract.tang.servers.find(({ nodeName }) => nodeName === server.nodeName) === undefined ||
    authority?.algorithm !== 'Ed25519' ||
    !PUBLIC_ID.test(authority.signerIdentity ?? '') ||
    !PUBLIC_ID.test(authority.signerLogicalCredentialId ?? '') ||
    !PUBLIC_ID.test(authority.evidenceDomain ?? '')
  ) stop('P2_TANG_BACKUP_AUTHORITY_INVALID');
  return freeze({
    schemaVersion: 1,
    state: 'TANG_SERVER_KEYS_BACKUP_RESTORE_VERIFIED',
    signerIdentity: authority.signerIdentity,
    signerLogicalCredentialId: authority.signerLogicalCredentialId,
    signerPublicKeySha256: key.sha256,
    nodeName: server.nodeName,
    logicalCredentialId: server.backupLogicalId,
    privateEvidenceSha256: canonicalDigest(privateEvidence),
    inventoryEvidenceSha256: privateEvidence.inventoryEvidenceSha256,
    backupArtifactSha256: privateEvidence.backupArtifactSha256,
    backupGeneration: privateEvidence.backupGeneration,
    isolatedRestoreRunId: privateEvidence.isolatedRestoreRunId,
  });
}

export function tangBackupSignaturePayload(contract, envelope) {
  if (!PUBLIC_ID.test(contract?.tang?.backupAuthority?.evidenceDomain ?? '')) {
    stop('P2_TANG_BACKUP_AUTHORITY_INVALID');
  }
  return Buffer.from(
    `${contract.tang.backupAuthority.evidenceDomain}\n${canonicalJson(envelope)}`,
    'utf8',
  );
}

function decodeCanonicalSignature(signature) {
  if (typeof signature !== 'string' || !BASE64_SIGNATURE.test(signature)) {
    stop('P2_TANG_BACKUP_SIGNATURE_INVALID');
  }
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) {
    stop('P2_TANG_BACKUP_SIGNATURE_INVALID');
  }
  return bytes;
}

export function buildTangBackupAttestation({
  contract,
  server,
  privateEvidence,
  authorityPublicKey,
  signature,
}) {
  const envelope = buildTangBackupEvidenceEnvelope({
    contract,
    server,
    privateEvidence,
    authorityPublicKey,
  });
  const attestation = {
    schemaVersion: 1,
    privateEvidence: structuredClone(privateEvidence),
    envelope,
    signature,
  };
  validateTangBackupAttestation({
    contract,
    server,
    attestation,
    authorityPublicKey,
    liveInventory: {
      contentSha256: privateEvidence.liveContentSha256,
      metadataSha256: privateEvidence.liveMetadataSha256,
      inventoryEvidenceSha256: privateEvidence.inventoryEvidenceSha256,
    },
  });
  return freeze(attestation);
}

export function validateTangBackupAttestation({
  contract,
  server,
  attestation,
  authorityPublicKey,
  liveInventory,
}) {
  const raw = exactKeys(attestation, RAW_BACKUP_ATTESTATION_KEYS);
  if (!raw && !exactKeys(attestation, BACKUP_ATTESTATION_KEYS)) {
    stop('P2_TANG_BACKUP_ATTESTATION_INVALID');
  }
  if (attestation.schemaVersion !== 1 || !exactKeys(attestation.envelope, BACKUP_ENVELOPE_KEYS)) {
    stop('P2_TANG_BACKUP_ATTESTATION_INVALID');
  }
  const authority = contract?.tang?.backupAuthority;
  const key = authorityPublicKeyDetails(authorityPublicKey);
  const envelope = attestation.envelope;
  if (
    envelope.schemaVersion !== 1 ||
    envelope.state !== 'TANG_SERVER_KEYS_BACKUP_RESTORE_VERIFIED' ||
    envelope.signerIdentity !== authority?.signerIdentity ||
    envelope.signerLogicalCredentialId !== authority?.signerLogicalCredentialId ||
    envelope.signerPublicKeySha256 !== key.sha256 ||
    envelope.nodeName !== server.nodeName ||
    envelope.logicalCredentialId !== server.backupLogicalId ||
    !SHA256.test(envelope.privateEvidenceSha256 ?? '') ||
    !SHA256.test(envelope.inventoryEvidenceSha256 ?? '') ||
    !SHA256.test(envelope.backupArtifactSha256 ?? '') ||
    !PUBLIC_ID.test(envelope.backupGeneration ?? '') ||
    !PUBLIC_ID.test(envelope.isolatedRestoreRunId ?? '') ||
    contract.tang.servers.find(({ nodeName }) => nodeName === server.nodeName) === undefined
  ) stop('P2_TANG_BACKUP_ATTESTATION_MISMATCH');
  const signature = decodeCanonicalSignature(attestation.signature);
  if (!verifySignature(
    null,
    tangBackupSignaturePayload(contract, envelope),
    key.key,
    signature,
  )) stop('P2_TANG_BACKUP_SIGNATURE_INVALID');
  if (raw) {
    const privateEvidence = validateTangPrivateBackupEvidence({
      server,
      privateEvidence: attestation.privateEvidence,
    });
    if (canonicalDigest(privateEvidence) !== envelope.privateEvidenceSha256) {
      stop('P2_TANG_BACKUP_PRIVATE_EVIDENCE_MISMATCH');
    }
    if (
      privateEvidence.inventoryEvidenceSha256 !== envelope.inventoryEvidenceSha256 ||
      privateEvidence.backupArtifactSha256 !== envelope.backupArtifactSha256 ||
      privateEvidence.backupGeneration !== envelope.backupGeneration ||
      privateEvidence.isolatedRestoreRunId !== envelope.isolatedRestoreRunId
    ) stop('P2_TANG_BACKUP_PRIVATE_EVIDENCE_MISMATCH');
    if (liveInventory !== undefined && (
      privateEvidence.liveContentSha256 !== liveInventory.contentSha256 ||
      privateEvidence.liveMetadataSha256 !== liveInventory.metadataSha256 ||
      privateEvidence.inventoryEvidenceSha256 !== liveInventory.inventoryEvidenceSha256
    )) stop('P2_TANG_BACKUP_LIVE_INVENTORY_MISMATCH');
  } else if (liveInventory !== undefined) {
    stop('P2_TANG_BACKUP_PRIVATE_EVIDENCE_REQUIRED');
  }
  return freeze({
    schemaVersion: 1,
    envelope: structuredClone(envelope),
    signature: attestation.signature,
  });
}

const TANG_ATTESTATION_KEYS = [
  'advertisementSha256', 'backup', 'hostname', 'ipv4', 'keyInventory', 'nodeName',
  'packageVersion', 'port', 'schemaVersion', 'signingKeyThumbprints', 'socketUnit',
  'state', 'url',
];

const INVENTORY_KEYS = [
  'backupLogicalId', 'directory', 'fileCount', 'inventoryEvidenceSha256',
];

export function buildTangServerAttestation({
  contract,
  server,
  hostname,
  ipv4,
  packageVersion,
  signingKeyThumbprints,
  advertisementSha256,
  keyInventory,
  backupAttestation,
  authorityPublicKey,
}) {
  if (
    hostname !== server.expectedHostname || ipv4 !== server.ipv4 ||
    !PACKAGE_VERSION.test(packageVersion ?? '') || !SHA256.test(advertisementSha256 ?? '') ||
    !Array.isArray(signingKeyThumbprints) || signingKeyThumbprints.length !== 1 ||
    !TANG_THUMBPRINT.test(signingKeyThumbprints[0] ?? '') ||
    !exactKeys(keyInventory, INVENTORY_KEYS) ||
    keyInventory.directory !== server.keyDirectory ||
    !Number.isSafeInteger(keyInventory.fileCount) || keyInventory.fileCount < 2 ||
    !SHA256.test(keyInventory.inventoryEvidenceSha256 ?? '') ||
    keyInventory.backupLogicalId !== server.backupLogicalId
  ) stop('P2_TANG_SERVER_READBACK_INVALID');
  const backup = validateTangBackupAttestation({
    contract,
    server,
    attestation: backupAttestation,
    authorityPublicKey,
  });
  if (backup.envelope.inventoryEvidenceSha256 !== keyInventory.inventoryEvidenceSha256) {
    stop('P2_TANG_BACKUP_LIVE_INVENTORY_MISMATCH');
  }
  return withDigest({
    schemaVersion: 1,
    state: 'TANG_SERVER_VERIFIED',
    nodeName: server.nodeName,
    hostname,
    ipv4,
    port: server.port,
    url: server.url,
    socketUnit: server.socketUnit,
    packageVersion,
    signingKeyThumbprints: [...signingKeyThumbprints],
    advertisementSha256,
    keyInventory: structuredClone(keyInventory),
    backup,
  });
}

export function validateTangServerAttestation(contract, attestation, authorityPublicKey) {
  validateDigestEnvelope(
    attestation,
    TANG_ATTESTATION_KEYS,
    'P2_TANG_SERVER_ATTESTATION_INVALID',
  );
  const server = contract.tang.servers.find(({ nodeName }) => nodeName === attestation.nodeName);
  if (
    server === undefined || attestation.schemaVersion !== 1 ||
    attestation.state !== 'TANG_SERVER_VERIFIED' ||
    attestation.hostname !== server.expectedHostname || attestation.ipv4 !== server.ipv4 ||
    attestation.port !== server.port || attestation.url !== server.url ||
    attestation.socketUnit !== server.socketUnit ||
    !PACKAGE_VERSION.test(attestation.packageVersion ?? '') ||
    !SHA256.test(attestation.advertisementSha256 ?? '') ||
    !Array.isArray(attestation.signingKeyThumbprints) ||
    attestation.signingKeyThumbprints.length !== 1 ||
    !TANG_THUMBPRINT.test(attestation.signingKeyThumbprints[0] ?? '') ||
    !exactKeys(attestation.keyInventory, INVENTORY_KEYS) ||
    attestation.keyInventory.directory !== server.keyDirectory ||
    !Number.isSafeInteger(attestation.keyInventory.fileCount) ||
    attestation.keyInventory.fileCount < 2 ||
    !SHA256.test(attestation.keyInventory.inventoryEvidenceSha256 ?? '') ||
    attestation.keyInventory.backupLogicalId !== server.backupLogicalId
  ) stop('P2_TANG_SERVER_ATTESTATION_MISMATCH');
  validateTangBackupAttestation({
    contract,
    server,
    attestation: attestation.backup,
    authorityPublicKey,
  });
  if (
    attestation.backup.envelope.inventoryEvidenceSha256 !==
    attestation.keyInventory.inventoryEvidenceSha256
  ) stop('P2_TANG_BACKUP_LIVE_INVENTORY_MISMATCH');
  return freeze(structuredClone(attestation));
}

export function validateTangFleetAttestations(contract, attestations, authorityPublicKey) {
  if (!Array.isArray(attestations) || attestations.length !== contract.tang.requiredServers) {
    stop('P2_TANG_FLEET_ATTESTATION_PARTIAL');
  }
  const validated = attestations.map((value) =>
    validateTangServerAttestation(contract, value, authorityPublicKey));
  const actualNames = validated.map(({ nodeName }) => nodeName).toSorted();
  const expectedNames = contract.tang.servers.map(({ nodeName }) => nodeName).toSorted();
  if (!isDeepStrictEqual(actualNames, expectedNames)) stop('P2_TANG_FLEET_ATTESTATION_MISMATCH');
  return freeze(contract.tang.servers.map(({ nodeName }) =>
    validated.find((value) => value.nodeName === nodeName)));
}

const CONFIG_BACKUP_KEYS = ['existed', 'metadata', 'path', 'sha256'];
const CONFIG_METADATA_KEYS = ['groupId', 'mode', 'ownerId'];
const PRE_BACKUP_KEYS = [
  'configuration', 'contractDigest', 'nodeName', 'schemaVersion', 'state',
  'stateDirectoryEmpty', 'pathIdentities', 'unlockerState',
];
const UNLOCKER_STATE_KEYS = ['active', 'enabled'];
const PATH_IDENTITY_KEYS = [
  'device', 'groupId', 'inode', 'mode', 'ownerId', 'path', 'type',
];
const FILE_IDENTITY_KEYS = [
  'device', 'groupId', 'inode', 'mode', 'ownerId', 'path', 'sizeBytes', 'type',
];
const MAPPER_BACKING_KEYS = [
  'backingDevice', 'backingDeviceId', 'dmDeviceId', 'dmUuid', 'mapperName',
  'mapperPath', 'sourceIdentityDigest', 'sourcePath',
];
const DECIMAL_ID = /^(?:0|[1-9][0-9]{0,31})$/u;
const DEVICE_ID = /^(?:0|[1-9][0-9]{0,9}):(?:0|[1-9][0-9]{0,9})$/u;

function validPathIdentity(value, expectedType, withSize = false) {
  const keys = withSize ? FILE_IDENTITY_KEYS : PATH_IDENTITY_KEYS;
  return exactKeys(value, keys) && value.type === expectedType &&
    PUBLIC_ID.test(value.path ?? '') && DECIMAL_ID.test(value.device ?? '') &&
    DECIMAL_ID.test(value.inode ?? '') && Number.isSafeInteger(value.ownerId) &&
    value.ownerId >= 0 && Number.isSafeInteger(value.groupId) && value.groupId >= 0 &&
    /^[0-7]{4}$/u.test(value.mode ?? '') &&
    (!withSize || (Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0));
}

function validConfigurationBackup(entry, contract) {
  return exactKeys(entry, CONFIG_BACKUP_KEYS) &&
    [contract.systemd.crypttabPath, contract.systemd.fstabPath].includes(entry.path) &&
    typeof entry.existed === 'boolean' && SHA256.test(entry.sha256 ?? '') &&
    (entry.existed
      ? exactKeys(entry.metadata, CONFIG_METADATA_KEYS) &&
        Number.isSafeInteger(entry.metadata.ownerId) && entry.metadata.ownerId >= 0 &&
        Number.isSafeInteger(entry.metadata.groupId) && entry.metadata.groupId >= 0 &&
        /^[0-7]{4}$/u.test(entry.metadata.mode ?? '')
      : entry.metadata === null);
}

export function buildPreProvisionBackupAttestation({
  contract,
  configuration,
  pathIdentities,
  unlockerState,
}) {
  if (
    !Array.isArray(configuration) || configuration.length !== 2 ||
    configuration.some((entry) => !validConfigurationBackup(entry, contract)) ||
    !Array.isArray(pathIdentities) || pathIdentities.length !== 5 ||
    pathIdentities.some((entry) => !validPathIdentity(entry, 'directory')) ||
    new Set(pathIdentities.map(({ path }) => path)).size !== pathIdentities.length ||
    !exactKeys(unlockerState, UNLOCKER_STATE_KEYS) ||
    typeof unlockerState.enabled !== 'boolean' || typeof unlockerState.active !== 'boolean'
  ) stop('P2_HOST_PRE_BACKUP_INVALID');
  return withDigest({
    schemaVersion: 1,
    state: 'PRE_PROVISION_BACKUP_RESTORE_VERIFIED',
    nodeName: contract.target.nodeName,
    contractDigest: contractDigest(contract),
    stateDirectoryEmpty: true,
    unlockerState: structuredClone(unlockerState),
    configuration: configuration.map((entry) => ({ ...entry })),
    pathIdentities: pathIdentities.map((entry) => ({ ...entry })),
  });
}

export function validatePreProvisionBackupAttestation(contract, attestation) {
  validateDigestEnvelope(attestation, PRE_BACKUP_KEYS, 'P2_HOST_PRE_BACKUP_INVALID');
  if (
    attestation.schemaVersion !== 1 ||
    attestation.state !== 'PRE_PROVISION_BACKUP_RESTORE_VERIFIED' ||
    attestation.nodeName !== contract.target.nodeName ||
    attestation.contractDigest !== contractDigest(contract) ||
    attestation.stateDirectoryEmpty !== true ||
    !exactKeys(attestation.unlockerState, UNLOCKER_STATE_KEYS) ||
    typeof attestation.unlockerState.enabled !== 'boolean' ||
    typeof attestation.unlockerState.active !== 'boolean' ||
    !Array.isArray(attestation.configuration) || attestation.configuration.length !== 2 ||
    attestation.configuration.some((entry) => !validConfigurationBackup(entry, contract)) ||
    !Array.isArray(attestation.pathIdentities) || attestation.pathIdentities.length !== 5 ||
    attestation.pathIdentities.some((entry) => !validPathIdentity(entry, 'directory')) ||
    new Set(attestation.pathIdentities.map(({ path }) => path)).size !==
      attestation.pathIdentities.length
  ) stop('P2_HOST_PRE_BACKUP_MISMATCH');
  return freeze(structuredClone(attestation));
}

export function validateAllocatedFile({ sizeBytes, allocatedBytes, contract }) {
  if (
    sizeBytes !== contract.target.sourceSizeBytes ||
    allocatedBytes < contract.target.sourceSizeBytes
  ) stop('P2_HOST_SOURCE_SPARSE_OR_SIZE_DRIFT');
  return freeze({ sizeBytes, allocatedBytes, allocationPolicy: 'NON_SPARSE' });
}

export function validateMountedFilesystem({ source, filesystemType, target, contract }) {
  if (
    source !== contract.target.mapperPath ||
    filesystemType !== contract.target.filesystemType ||
    target !== contract.target.mountPath
  ) stop('P2_HOST_MOUNT_IDENTITY_DRIFT');
  return freeze({ source, filesystemType, target });
}

function stableMapperBackingIdentity(mapperBacking) {
  return {
    mapperName: mapperBacking.mapperName,
    mapperPath: mapperBacking.mapperPath,
    dmUuid: mapperBacking.dmUuid.toUpperCase(),
    sourcePath: mapperBacking.sourcePath,
    sourceIdentityDigest: mapperBacking.sourceIdentityDigest,
  };
}

export function validateMapperBackingAttestation({
  contract,
  luksUuid,
  sourceIdentity,
  mapperBacking,
}) {
  const normalizedUuid = luksUuid?.replaceAll('-', '').toUpperCase();
  const mapperName = contract?.target?.mapperName;
  const expectedDmUuid = typeof mapperName === 'string'
    ? `CRYPT-LUKS2-${normalizedUuid}-${mapperName.replaceAll('-', '--').toUpperCase()}`
    : '';
  if (
    !LUKS_UUID.test(luksUuid ?? '') || !validPathIdentity(sourceIdentity, 'file', true) ||
    !exactKeys(mapperBacking, MAPPER_BACKING_KEYS) ||
    mapperBacking.mapperName !== contract.target.mapperName ||
    mapperBacking.mapperPath !== contract.target.mapperPath ||
    mapperBacking.sourcePath !== contract.target.sourcePath ||
    !/^\/dev\/loop(?:0|[1-9][0-9]*)$/u.test(mapperBacking.backingDevice ?? '') ||
    !DEVICE_ID.test(mapperBacking.backingDeviceId ?? '') ||
    !DEVICE_ID.test(mapperBacking.dmDeviceId ?? '') ||
    typeof mapperBacking.dmUuid !== 'string' ||
    mapperBacking.dmUuid.toUpperCase() !== expectedDmUuid ||
    mapperBacking.sourceIdentityDigest !== canonicalDigest(sourceIdentity)
  ) stop('P2_HOST_MAPPER_BACKING_DRIFT');
  return freeze(structuredClone(mapperBacking));
}

export function buildProvisionedHostAttestation({
  contract,
  state,
  stateVolumeAttestation,
  luksUuid,
  tangAttestations,
  authorityPublicKey,
  preBackupAttestation,
  headerBackupSha256,
  headerBackupIdentity,
  sourceIdentity,
  mapperBacking,
  bootId,
  configurationSha256,
}) {
  if (
    !LUKS_UUID.test(luksUuid ?? '') || !SHA256.test(headerBackupSha256 ?? '') ||
    !PUBLIC_ID.test(bootId ?? '') || !SHA256.test(configurationSha256 ?? '') ||
    !validPathIdentity(headerBackupIdentity, 'file', true) ||
    !validPathIdentity(sourceIdentity, 'file', true)
  ) stop('P2_HOST_PROVISION_ATTESTATION_INVALID');
  const validatedMapperBacking = validateMapperBackingAttestation({
    contract,
    luksUuid,
    sourceIdentity,
    mapperBacking,
  });
  const tang = validateTangFleetAttestations(contract, tangAttestations, authorityPublicKey);
  const backup = validatePreProvisionBackupAttestation(contract, preBackupAttestation);
  const hostEncryption = buildHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation,
    luksUuid,
  });
  validateHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation,
    attestation: hostEncryption,
  });
  return withDigest({
    schemaVersion: 1,
    state: 'HOST_PROVISIONED_REBOOT_READBACK_REQUIRED',
    nodeName: contract.target.nodeName,
    contractDigest: contractDigest(contract),
    bootId,
    luksUuid,
    headerBackupSha256,
    headerBackupIdentity: structuredClone(headerBackupIdentity),
    sourceIdentity: structuredClone(sourceIdentity),
    mapperBacking: validatedMapperBacking,
    configurationSha256,
    preBackupDigest: backup.observedDigest,
    tangAttestationDigests: tang.map(({ observedDigest }) => observedDigest),
    hostEncryption,
  });
}

const PROVISIONED_KEYS = [
  'bootId', 'configurationSha256', 'contractDigest', 'headerBackupSha256',
  'headerBackupIdentity', 'hostEncryption', 'luksUuid', 'mapperBacking', 'nodeName',
  'preBackupDigest', 'schemaVersion', 'sourceIdentity', 'state',
  'tangAttestationDigests',
];

export function validateProvisionedHostAttestation({
  contract,
  provisioned,
  state,
  stateVolumeAttestation,
  tangAttestations,
  authorityPublicKey,
  preBackupAttestation,
  headerBackupIdentity,
  sourceIdentity,
  mapperBacking,
}) {
  validateDigestEnvelope(
    provisioned,
    PROVISIONED_KEYS,
    'P2_HOST_PROVISION_ATTESTATION_INVALID',
  );
  const tang = validateTangFleetAttestations(contract, tangAttestations, authorityPublicKey);
  const backup = validatePreProvisionBackupAttestation(contract, preBackupAttestation);
  if (
    provisioned.schemaVersion !== 1 ||
    provisioned.state !== 'HOST_PROVISIONED_REBOOT_READBACK_REQUIRED' ||
    provisioned.nodeName !== contract.target.nodeName ||
    provisioned.contractDigest !== contractDigest(contract) ||
    !PUBLIC_ID.test(provisioned.bootId ?? '') ||
    !LUKS_UUID.test(provisioned.luksUuid ?? '') ||
    !SHA256.test(provisioned.headerBackupSha256 ?? '') ||
    !validPathIdentity(provisioned.headerBackupIdentity, 'file', true) ||
    !validPathIdentity(provisioned.sourceIdentity, 'file', true) ||
    !SHA256.test(provisioned.configurationSha256 ?? '')
  ) stop('P2_HOST_PROVISION_ATTESTATION_MISMATCH');
  if (!isDeepStrictEqual(provisioned.headerBackupIdentity, headerBackupIdentity)) {
    stop('P2_HOST_PROVISION_HEADER_BACKUP_IDENTITY_DRIFT');
  }
  if (!isDeepStrictEqual(provisioned.sourceIdentity, sourceIdentity)) {
    stop('P2_HOST_PROVISION_SOURCE_IDENTITY_DRIFT');
  }
  const provisionedMapperBacking = validateMapperBackingAttestation({
    contract,
    luksUuid: provisioned.luksUuid,
    sourceIdentity: provisioned.sourceIdentity,
    mapperBacking: provisioned.mapperBacking,
  });
  const currentMapperBacking = validateMapperBackingAttestation({
    contract,
    luksUuid: provisioned.luksUuid,
    sourceIdentity,
    mapperBacking,
  });
  if (!isDeepStrictEqual(
    stableMapperBackingIdentity(provisionedMapperBacking),
    stableMapperBackingIdentity(currentMapperBacking),
  )) {
    stop('P2_HOST_PROVISION_MAPPER_BACKING_DRIFT');
  }
  if (provisioned.preBackupDigest !== backup.observedDigest) {
    stop('P2_HOST_PROVISION_PRE_BACKUP_DRIFT');
  }
  if (!isDeepStrictEqual(
    provisioned.tangAttestationDigests,
    tang.map(({ observedDigest }) => observedDigest),
  )) stop('P2_HOST_PROVISION_TANG_ATTESTATION_DRIFT');
  validateHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation,
    attestation: provisioned.hostEncryption,
  });
  return freeze(structuredClone(provisioned));
}

export function buildRebootVerifiedHostAttestation({ contract, provisioned, currentBootId, readback }) {
  if (
    provisioned?.state !== 'HOST_PROVISIONED_REBOOT_READBACK_REQUIRED' ||
    provisioned?.contractDigest !== contractDigest(contract) ||
    !SHA256.test(provisioned?.observedDigest ?? '') ||
    !PUBLIC_ID.test(currentBootId ?? '') || currentBootId === provisioned.bootId ||
    readback?.state !== 'HOST_ENCRYPTED_MOUNT_VERIFIED' ||
    readback?.hostEncryption?.observedDigest !== provisioned.hostEncryption.observedDigest
  ) stop('P2_HOST_REBOOT_READBACK_INVALID');
  return withDigest({
    schemaVersion: 1,
    state: 'HOST_ENCRYPTED_MOUNT_REBOOT_VERIFIED',
    nodeName: contract.target.nodeName,
    contractDigest: contractDigest(contract),
    previousBootId: provisioned.bootId,
    currentBootId,
    provisionedDigest: provisioned.observedDigest,
    hostEncryptionDigest: provisioned.hostEncryption.observedDigest,
  });
}

export function publicPlan(contract) {
  const digest = contractDigest(contract);
  return freeze({
    schemaVersion: 1,
    state: 'DRY_RUN',
    contractDigest: digest,
    confirmations: confirmations(contract),
    target: structuredClone(contract.target),
    systemd: buildSystemdConfiguration(contract),
    filesystemBoundary: structuredClone(contract.filesystemBoundary),
    tang: structuredClone(contract.tang),
    kubernetes: structuredClone(contract.kubernetes),
    gates: structuredClone(contract.gates),
    secretValuesCreated: false,
    secretValuesReturned: false,
  });
}
