import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const SHA256 = /^[a-f0-9]{64}$/;
const LUKS_UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const PUBLIC_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const HOST_ENCRYPTION_KEYS = [
  'digestAlgorithm', 'filesystemType', 'luksType', 'mapperPath', 'markerPath',
  'missingPolicy', 'mode', 'schemaVersion', 'sourcePath', 'status',
];
const HOST_ATTESTATION_KEYS = [
  'filesystemType', 'luksType', 'luksUuid', 'mapperPath', 'mode', 'mountPath',
  'nodeName', 'observedDigest', 'pv', 'pvc', 'schemaVersion', 'sourcePath', 'state',
];
const PV_KEYS = ['name', 'resourceVersion', 'uid'];
const PVC_KEYS = ['name', 'namespace', 'resourceVersion', 'uid'];
const RUNTIME_MARKER_KEYS = [
  'hostEncryptionDigest', 'observedDigest', 'schemaVersion', 'state',
  'stateVolumeDigest',
];

export const HOST_ENCRYPTION_MARKER_PATH =
  '/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json';
export const HOST_ENCRYPTION_SOURCE_PATH =
  '/data/seori-auth/seori-auth-state.luks';
export const HOST_ENCRYPTION_MAPPER_PATH = '/dev/mapper/seori-auth-state';

export class HostEncryptedMountError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HostEncryptedMountError';
    this.code = code;
  }
}

function stop(code) {
  throw new HostEncryptedMountError(code);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function publicIdentity(value, keys) {
  return exactKeys(value, keys) &&
    keys.every((key) => PUBLIC_ID.test(value[key] ?? ''));
}

export function validateHostEncryptionPolicy(state) {
  const policy = state?.hostEncryption;
  if (
    !exactKeys(policy, HOST_ENCRYPTION_KEYS) || policy.schemaVersion !== 1 ||
    policy.mode !== 'LUKS2_DM_CRYPT' ||
    !['verified', 'blocked_unverified'].includes(policy.status) ||
    policy.luksType !== 'LUKS2' || policy.filesystemType !== 'ext4' ||
    policy.mapperPath !== HOST_ENCRYPTION_MAPPER_PATH ||
    policy.sourcePath !== HOST_ENCRYPTION_SOURCE_PATH ||
    policy.markerPath !== HOST_ENCRYPTION_MARKER_PATH ||
    policy.digestAlgorithm !== 'SHA256_CANONICAL_JSON' ||
    policy.missingPolicy !== 'FAIL_CLOSED' ||
    state?.volume?.nodeName !== 'rpi5' ||
    state?.volume?.localPath !== '/var/lib/seori-auth'
  ) stop('HOST_ENCRYPTION_POLICY_INVALID');
  return policy;
}

function validateMarkerShape(attestation) {
  if (
    !exactKeys(attestation, HOST_ATTESTATION_KEYS) ||
    attestation.schemaVersion !== 1 ||
    attestation.state !== 'HOST_ENCRYPTED_MOUNT_VERIFIED' ||
    attestation.mode !== 'LUKS2_DM_CRYPT' ||
    attestation.luksType !== 'LUKS2' ||
    !LUKS_UUID.test(attestation.luksUuid ?? '') ||
    attestation.mapperPath !== HOST_ENCRYPTION_MAPPER_PATH ||
    attestation.sourcePath !== HOST_ENCRYPTION_SOURCE_PATH ||
    attestation.mountPath !== '/var/lib/seori-auth' ||
    attestation.filesystemType !== 'ext4' ||
    attestation.nodeName !== 'rpi5' ||
    !publicIdentity(attestation.pv, PV_KEYS) ||
    !publicIdentity(attestation.pvc, PVC_KEYS) ||
    !SHA256.test(attestation.observedDigest ?? '')
  ) stop('HOST_ENCRYPTION_ATTESTATION_INVALID');
  const core = { ...attestation };
  delete core.observedDigest;
  if (sha256(canonicalJson(core)) !== attestation.observedDigest) {
    stop('HOST_ENCRYPTION_ATTESTATION_INVALID');
  }
  return attestation;
}

export function buildHostEncryptedMountAttestation({
  state,
  stateVolumeAttestation,
  luksUuid,
}) {
  const policy = validateHostEncryptionPolicy(state);
  const core = {
    schemaVersion: 1,
    state: 'HOST_ENCRYPTED_MOUNT_VERIFIED',
    mode: policy.mode,
    luksType: policy.luksType,
    luksUuid,
    mapperPath: policy.mapperPath,
    sourcePath: policy.sourcePath,
    mountPath: state.volume.localPath,
    filesystemType: policy.filesystemType,
    nodeName: state.volume.nodeName,
    pv: structuredClone(stateVolumeAttestation?.pv),
    pvc: structuredClone(stateVolumeAttestation?.pvc),
  };
  return validateHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation,
    attestation: { ...core, observedDigest: sha256(canonicalJson(core)) },
  });
}

export function validateHostEncryptedMountAttestation({
  state,
  stateVolumeAttestation,
  attestation,
}) {
  const policy = validateHostEncryptionPolicy(state);
  validateMarkerShape(attestation);
  if (
    attestation.mode !== policy.mode ||
    attestation.luksType !== policy.luksType ||
    attestation.mapperPath !== policy.mapperPath ||
    attestation.sourcePath !== policy.sourcePath ||
    attestation.filesystemType !== policy.filesystemType ||
    attestation.mountPath !== state.volume.localPath ||
    attestation.nodeName !== state.volume.nodeName ||
    !isDeepStrictEqual(attestation.pv, stateVolumeAttestation?.pv) ||
    !isDeepStrictEqual(attestation.pvc, stateVolumeAttestation?.pvc)
  ) stop('HOST_ENCRYPTION_ATTESTATION_MISMATCH');
  return deepFreeze(structuredClone(attestation));
}

export function validateHostEncryptedMountMarkerDigest({ attestation, expectedDigest }) {
  validateMarkerShape(attestation);
  if (!SHA256.test(expectedDigest ?? '') || attestation.observedDigest !== expectedDigest) {
    stop('HOST_ENCRYPTION_ATTESTATION_MISMATCH');
  }
  return deepFreeze(structuredClone(attestation));
}

export function buildRuntimeStateAttestationMarker({
  stateVolumeAttestation,
  hostEncryptionAttestation,
}) {
  const stateVolumeDigest = stateVolumeAttestation?.observedDigest;
  const hostEncryptionDigest = hostEncryptionAttestation?.observedDigest;
  if (!SHA256.test(stateVolumeDigest ?? '') || !SHA256.test(hostEncryptionDigest ?? '')) {
    stop('RUNTIME_STATE_ATTESTATION_INVALID');
  }
  const core = {
    schemaVersion: 2,
    state: 'STATE_VOLUME_AND_HOST_ENCRYPTION_VERIFIED',
    stateVolumeDigest,
    hostEncryptionDigest,
  };
  return deepFreeze({ ...core, observedDigest: sha256(canonicalJson(core)) });
}

export function validateRuntimeStateAttestationMarker({
  marker,
  expectedObservedDigest,
  expectedHostEncryptionDigest,
}) {
  if (
    !exactKeys(marker, RUNTIME_MARKER_KEYS) || marker.schemaVersion !== 2 ||
    marker.state !== 'STATE_VOLUME_AND_HOST_ENCRYPTION_VERIFIED' ||
    !SHA256.test(marker.stateVolumeDigest ?? '') ||
    !SHA256.test(marker.hostEncryptionDigest ?? '') ||
    !SHA256.test(marker.observedDigest ?? '') ||
    !SHA256.test(expectedObservedDigest ?? '') ||
    !SHA256.test(expectedHostEncryptionDigest ?? '') ||
    marker.hostEncryptionDigest !== expectedHostEncryptionDigest ||
    marker.observedDigest !== expectedObservedDigest
  ) stop('RUNTIME_STATE_ATTESTATION_INVALID');
  const core = { ...marker };
  delete core.observedDigest;
  if (sha256(canonicalJson(core)) !== marker.observedDigest) {
    stop('RUNTIME_STATE_ATTESTATION_INVALID');
  }
  return deepFreeze(structuredClone(marker));
}
