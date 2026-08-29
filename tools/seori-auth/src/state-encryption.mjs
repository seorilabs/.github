import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEVICE_NAME = /^[A-Za-z0-9._+:-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SIZE = /^[1-9][0-9]*(?:Mi|Gi)$/;
const STATE_MOUNT_PATH = '/var/lib/seori-auth';
const BLOCK_DEVICE_KEYS = new Set([
  'children', 'fstype', 'kname', 'model', 'mountpoints', 'name', 'partuuid',
  'pkname', 'serial', 'size', 'type', 'uuid', 'wwn',
]);
const STATE_KEYS = [
  'accessModes', 'claimName', 'encryptionRequired', 'encryptionStatus', 'mapperName',
  'mountFstype', 'nodeName', 'reclaimPolicy', 'size', 'storageClassName', 'volumeMode',
  'volumeName',
];

export class StateEncryptionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StateEncryptionError';
    this.code = code;
  }
}

function stop(code) {
  throw new StateEncryptionError(code);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function validateStateContract(state) {
  if (
    !exactKeys(state, STATE_KEYS) || state.claimName !== 'seori-auth-state' ||
    state.volumeName !== 'seori-auth-state-rpi5' || state.nodeName !== 'rpi5' ||
    state.mapperName !== 'seori-auth-state' || state.mountFstype !== 'ext4' ||
    !DNS_LABEL.test(state.storageClassName ?? '') || !SIZE.test(state.size ?? '') ||
    !isDeepStrictEqual(state.accessModes, ['ReadWriteOnce']) ||
    state.volumeMode !== 'Filesystem' || state.reclaimPolicy !== 'Retain' ||
    state.encryptionRequired !== true ||
    !['verified', 'blocked_unverified'].includes(state.encryptionStatus)
  ) stop('STATE_ENCRYPTION_CONTRACT_INVALID');
  return state;
}

function decodeMountInfoField(value) {
  if (typeof value !== 'string' || /\\(?![0-7]{3})/.test(value)) {
    stop('STATE_ENCRYPTION_MOUNTINFO_INVALID');
  }
  return value.replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function mountRecord(line) {
  const fields = line.trim().split(' ');
  const separator = fields.indexOf('-');
  if (separator < 6 || fields.length < separator + 4) {
    stop('STATE_ENCRYPTION_MOUNTINFO_INVALID');
  }
  return Object.freeze({
    mountPoint: decodeMountInfoField(fields[4]),
    fstype: fields[separator + 1],
    source: decodeMountInfoField(fields[separator + 2]),
  });
}

function mountForState(mountInfo) {
  if (typeof mountInfo !== 'string' || mountInfo.length === 0 || mountInfo.length > 2 * 1024 * 1024) {
    stop('STATE_ENCRYPTION_MOUNTINFO_INVALID');
  }
  const matches = mountInfo.trim().split('\n')
    .filter((line) => line.length > 0)
    .map(mountRecord)
    .filter(({ mountPoint }) => mountPoint === STATE_MOUNT_PATH);
  if (matches.length !== 1) stop('STATE_ENCRYPTION_MOUNT_MISSING_OR_AMBIGUOUS');
  return matches[0];
}

function optionalPublicString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 256 || /[\0\r\n]/.test(value)) {
    stop('STATE_ENCRYPTION_LSBLK_INVALID');
  }
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function normalizeBlockDevice(value) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !BLOCK_DEVICE_KEYS.has(key)) ||
    !DEVICE_NAME.test(value.name ?? '') || !DEVICE_NAME.test(value.kname ?? '') ||
    (value.pkname !== null && value.pkname !== undefined && !DEVICE_NAME.test(value.pkname)) ||
    !['crypt', 'disk', 'part'].includes(value.type) ||
    !Number.isSafeInteger(value.size) || value.size < 1 ||
    !Array.isArray(value.mountpoints) ||
    value.mountpoints.some((entry) => entry !== null && typeof entry !== 'string') ||
    (value.children !== undefined && !Array.isArray(value.children))
  ) stop('STATE_ENCRYPTION_LSBLK_INVALID');
  return Object.freeze({
    name: value.name,
    kname: value.kname,
    type: value.type,
    fstype: optionalPublicString(value.fstype),
    pkname: value.pkname ?? null,
    size: String(value.size),
    model: optionalPublicString(value.model),
    serial: optionalPublicString(value.serial),
    wwn: optionalPublicString(value.wwn),
    uuid: optionalPublicString(value.uuid),
    partuuid: optionalPublicString(value.partuuid),
    mountpoints: Object.freeze([...value.mountpoints]),
    children: Object.freeze((value.children ?? []).map(normalizeBlockDevice)),
  });
}

function flattenBlockDevices(lsblk) {
  if (!exactKeys(lsblk, ['blockdevices']) || !Array.isArray(lsblk.blockdevices)) {
    stop('STATE_ENCRYPTION_LSBLK_INVALID');
  }
  const flattened = [];
  const visit = (normalized) => {
    flattened.push(normalized);
    normalized.children.forEach(visit);
  };
  lsblk.blockdevices.map(normalizeBlockDevice).forEach(visit);
  if (flattened.length === 0) stop('STATE_ENCRYPTION_LSBLK_INVALID');
  const names = new Set();
  const kernelNames = new Set();
  for (const device of flattened) {
    if (names.has(device.name) || kernelNames.has(device.kname)) {
      stop('STATE_ENCRYPTION_LSBLK_AMBIGUOUS');
    }
    names.add(device.name);
    kernelNames.add(device.kname);
  }
  return flattened;
}

function backingFingerprint(nodeName, backing) {
  if (![backing.serial, backing.wwn, backing.uuid, backing.partuuid].some(Boolean)) {
    stop('STATE_ENCRYPTION_BACKING_IDENTITY_MISSING');
  }
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    nodeName,
    name: backing.name,
    kname: backing.kname,
    type: backing.type,
    size: backing.size,
    model: backing.model,
    serial: backing.serial,
    wwn: backing.wwn,
    uuid: backing.uuid,
    partuuid: backing.partuuid,
  })).digest('hex');
}

export function attestStateEncryption({ nodeName, mountInfo, lsblk, state }) {
  validateStateContract(state);
  if (nodeName !== state.nodeName) stop('STATE_ENCRYPTION_NODE_MISMATCH');
  const mount = mountForState(mountInfo);
  const expectedSource = `/dev/mapper/${state.mapperName}`;
  if (mount.source !== expectedSource) stop('STATE_ENCRYPTION_MAPPER_REQUIRED');
  if (mount.fstype !== state.mountFstype) stop('STATE_ENCRYPTION_FSTYPE_MISMATCH');

  const devices = flattenBlockDevices(lsblk);
  const mapper = devices.find(({ name }) => name === state.mapperName);
  if (
    !mapper || mapper.type !== 'crypt' || mapper.fstype !== state.mountFstype ||
    !isDeepStrictEqual(mapper.mountpoints.filter(Boolean), [STATE_MOUNT_PATH]) ||
    typeof mapper.pkname !== 'string'
  ) stop('STATE_ENCRYPTION_DM_CRYPT_MISSING');
  const backing = devices.find(({ name, kname }) => name === mapper.pkname || kname === mapper.pkname);
  if (!backing || !['disk', 'part'].includes(backing.type)) {
    stop('STATE_ENCRYPTION_BACKING_DEVICE_INVALID');
  }

  return Object.freeze({
    schemaVersion: 1,
    nodeName,
    deviceMapper: true,
    mapperType: 'crypt',
    fstype: state.mountFstype,
    backingFingerprintSha256: backingFingerprint(nodeName, backing),
  });
}

function stateMetadata(state, hostAttestation) {
  if (
    !exactKeys(hostAttestation, [
      'backingFingerprintSha256', 'deviceMapper', 'fstype', 'mapperType', 'nodeName',
      'schemaVersion',
    ]) || hostAttestation.schemaVersion !== 1 || hostAttestation.nodeName !== state.nodeName ||
    hostAttestation.deviceMapper !== true || hostAttestation.mapperType !== 'crypt' ||
    hostAttestation.fstype !== state.mountFstype ||
    !SHA256.test(hostAttestation.backingFingerprintSha256 ?? '')
  ) stop('STATE_ENCRYPTION_HOST_ATTESTATION_INVALID');
  return {
    labels: {
      'app.kubernetes.io/name': 'seori-auth',
      'seorilabs.io/component': 'state',
    },
    annotations: {
      'seorilabs.io/backing-fingerprint-sha256': hostAttestation.backingFingerprintSha256,
    },
  };
}

export function buildRetainVolumeList({ state, hostAttestation }) {
  validateStateContract(state);
  const metadata = stateMetadata(state, hostAttestation);
  return Object.freeze({
    apiVersion: 'v1',
    kind: 'List',
    items: Object.freeze([
      Object.freeze({
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: { name: state.volumeName, ...metadata },
        spec: {
          capacity: { storage: state.size },
          volumeMode: state.volumeMode,
          accessModes: [...state.accessModes],
          persistentVolumeReclaimPolicy: state.reclaimPolicy,
          storageClassName: state.storageClassName,
          claimRef: {
            apiVersion: 'v1',
            kind: 'PersistentVolumeClaim',
            namespace: 'auth-broker',
            name: state.claimName,
          },
          local: { path: STATE_MOUNT_PATH },
          nodeAffinity: {
            required: {
              nodeSelectorTerms: [{
                matchExpressions: [{
                  key: 'kubernetes.io/hostname',
                  operator: 'In',
                  values: [state.nodeName],
                }],
              }],
            },
          },
        },
      }),
      Object.freeze({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: state.claimName, namespace: 'auth-broker', ...metadata },
        spec: {
          volumeName: state.volumeName,
          storageClassName: state.storageClassName,
          accessModes: [...state.accessModes],
          volumeMode: state.volumeMode,
          resources: { requests: { storage: state.size } },
        },
      }),
    ]),
  });
}

function exactResource(actual, expected) {
  if (
    actual?.apiVersion !== expected.apiVersion || actual?.kind !== expected.kind ||
    actual?.metadata?.name !== expected.metadata.name ||
    actual?.metadata?.namespace !== expected.metadata.namespace ||
    !isDeepStrictEqual(actual?.metadata?.labels, expected.metadata.labels) ||
    !isDeepStrictEqual(actual?.metadata?.annotations, expected.metadata.annotations) ||
    actual?.metadata?.deletionTimestamp !== undefined ||
    !isDeepStrictEqual(actual?.spec, expected.spec)
  ) stop('STATE_VOLUME_SERVER_DRY_RUN_DRIFT');
}

export function verifyRetainVolumeDryRun({ desired, observed, state, hostAttestation }) {
  validateStateContract(state);
  stateMetadata(state, hostAttestation);
  if (
    !desired || desired.kind !== 'List' || !Array.isArray(desired.items) ||
    !observed || observed.kind !== 'List' || !Array.isArray(observed.items) ||
    desired.items.length !== 2 || observed.items.length !== 2
  ) stop('STATE_VOLUME_SERVER_DRY_RUN_INVALID');
  for (const expected of desired.items) {
    const actual = observed.items.find(({ kind, metadata }) =>
      kind === expected.kind && metadata?.name === expected.metadata.name);
    if (!actual) stop('STATE_VOLUME_SERVER_DRY_RUN_DRIFT');
    exactResource(actual, expected);
  }

  return Object.freeze({
    schemaVersion: 1,
    state: 'SERVER_DRY_RUN_VERIFIED',
    serverDryRun: true,
    host: hostAttestation,
    pv: Object.freeze({
      name: state.volumeName,
      size: state.size,
      accessModes: Object.freeze([...state.accessModes]),
      volumeMode: state.volumeMode,
      reclaimPolicy: state.reclaimPolicy,
      storageClassName: state.storageClassName,
      nodeName: state.nodeName,
    }),
    pvc: Object.freeze({
      namespace: 'auth-broker',
      name: state.claimName,
      volumeName: state.volumeName,
      size: state.size,
      accessModes: Object.freeze([...state.accessModes]),
      volumeMode: state.volumeMode,
      storageClassName: state.storageClassName,
    }),
  });
}
