import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { BROWSER_VAULT_ENVELOPE } from './browser-vault.mjs';
import { DURABLE_JOURNAL_ENVELOPE } from './durable-state.mjs';
import { validateHostEncryptionPolicy } from './host-encrypted-mount.mjs';
import { normalizeJournalCheckpointBinding } from './journal-checkpoint.mjs';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const SIZE = /^[1-9][0-9]*(?:Mi|Gi)$/;
const PUBLIC_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const STATE_MOUNT_PATH = '/var/lib/seori-auth';
const STATE_KEYS = ['hostEncryption', 'protection', 'volume'];
const PROTECTION_KEYS = [
  'browserVault', 'journal', 'mode', 'secretPersistencePolicy', 'status',
];
const JOURNAL_KEYS = [
  'checkpoint', 'contentPolicy', 'integrity', 'logicalCredentialId', 'schemaVersion',
  'writeValidation',
];
const BROWSER_VAULT_KEYS = [
  'algorithm', 'envelopeVersion', 'logicalCredentialId', 'plaintextAtRestAllowed',
];
const VOLUME_KEYS = [
  'accessModes', 'claimName', 'deletionPolicy', 'kubernetesContext', 'localPath',
  'mutationPolicy', 'namespace', 'nodeName', 'readbackPolicy', 'reclaimPolicy',
  'readbackAttestation', 'size', 'storageClassName', 'unknownOutcomePolicy',
  'volumeMode', 'volumeName',
];
const READBACK_ATTESTATION_POLICY_KEYS = [
  'digestAlgorithm', 'postStartGate', 'schemaVersion', 'startupGate',
];
const READBACK_ATTESTATION_KEYS = [
  'context', 'namespace', 'observedDigest', 'pv', 'pvc', 'schemaVersion',
  'stateContractDigest',
];
const PV_ATTESTATION_KEYS = ['name', 'resourceVersion', 'uid'];
const PVC_ATTESTATION_KEYS = ['name', 'namespace', 'resourceVersion', 'uid'];
const PV_SPEC_KEYS = [
  'accessModes', 'capacity', 'claimRef', 'local', 'nodeAffinity',
  'persistentVolumeReclaimPolicy', 'storageClassName', 'volumeMode',
];
const PVC_SPEC_KEYS = [
  'accessModes', 'resources', 'storageClassName', 'volumeMode', 'volumeName',
];
const CLAIM_REF_KEYS = ['apiVersion', 'kind', 'name', 'namespace', 'resourceVersion', 'uid'];

export class StateEnvelopeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StateEnvelopeError';
    this.code = code;
  }
}

function stop(code) {
  throw new StateEnvelopeError(code);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
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

function validateStateContract(state) {
  const protection = state?.protection;
  const journal = protection?.journal;
  const browserVault = protection?.browserVault;
  const volume = state?.volume;
  let checkpoint;
  try {
    checkpoint = normalizeJournalCheckpointBinding(journal?.checkpoint);
  } catch {
    stop('STATE_ENVELOPE_CONTRACT_INVALID');
  }
  const readbackAttestation = volume?.readbackAttestation;
  try {
    validateHostEncryptionPolicy(state);
  } catch {
    stop('STATE_ENVELOPE_CONTRACT_INVALID');
  }
  if (
    !exactKeys(state, STATE_KEYS) || !exactKeys(protection, PROTECTION_KEYS) ||
    protection.mode !== 'APPLICATION_ENVELOPE' ||
    !['verified', 'blocked_unverified'].includes(protection.status) ||
    protection.secretPersistencePolicy !== 'ENCRYPTED_ENVELOPE_ONLY' ||
    !exactKeys(journal, JOURNAL_KEYS) ||
    journal.schemaVersion !== DURABLE_JOURNAL_ENVELOPE.schemaVersion ||
    journal.contentPolicy !== DURABLE_JOURNAL_ENVELOPE.contentPolicy ||
    journal.integrity !== DURABLE_JOURNAL_ENVELOPE.integrity ||
    journal.writeValidation !== DURABLE_JOURNAL_ENVELOPE.writeValidation ||
    journal.logicalCredentialId !== 'shared/seori-auth/journal-mac' ||
    checkpoint.journalId !== 'seori-auth-production' ||
    !exactKeys(browserVault, BROWSER_VAULT_KEYS) ||
    browserVault.envelopeVersion !== BROWSER_VAULT_ENVELOPE.version ||
    browserVault.algorithm !== BROWSER_VAULT_ENVELOPE.algorithm ||
    browserVault.logicalCredentialId !== 'shared/seori-auth/browser-vault' ||
    browserVault.plaintextAtRestAllowed !== false ||
    !exactKeys(volume, VOLUME_KEYS) || volume.namespace !== 'auth-broker' ||
    volume.claimName !== 'seori-auth-state' ||
    volume.volumeName !== 'seori-auth-state-rpi5' || volume.nodeName !== 'rpi5' ||
    volume.kubernetesContext !== 'vzyx-cluster' || volume.localPath !== STATE_MOUNT_PATH ||
    !DNS_LABEL.test(volume.namespace ?? '') || !DNS_LABEL.test(volume.claimName ?? '') ||
    !DNS_LABEL.test(volume.volumeName ?? '') || !DNS_LABEL.test(volume.nodeName ?? '') ||
    !DNS_SUBDOMAIN.test(volume.storageClassName ?? '') || !SIZE.test(volume.size ?? '') ||
    !isDeepStrictEqual(volume.accessModes, ['ReadWriteOnce']) ||
    volume.volumeMode !== 'Filesystem' || volume.reclaimPolicy !== 'Retain' ||
    volume.readbackPolicy !== 'EXACT_READBACK_ONLY' ||
    volume.mutationPolicy !== 'SEPARATE_APPROVAL' ||
    volume.deletionPolicy !== 'FORBIDDEN' ||
    volume.unknownOutcomePolicy !== 'READBACK_FIRST' ||
    !exactKeys(readbackAttestation, READBACK_ATTESTATION_POLICY_KEYS) ||
    readbackAttestation.schemaVersion !== 1 ||
    readbackAttestation.digestAlgorithm !== 'SHA256_CANONICAL_JSON' ||
    readbackAttestation.startupGate !== 'INIT_CONTAINER_EXACT_READBACK' ||
    readbackAttestation.postStartGate !== 'READINESS_MARKER_EXACT_DIGEST'
  ) stop('STATE_ENVELOPE_CONTRACT_INVALID');
  return state;
}

function stateContractDigest(state) {
  const contract = structuredClone(state);
  delete contract.protection.status;
  return sha256(canonicalJson(contract));
}

function publicResourceIdentity(value, expectedKeys) {
  return exactKeys(value, expectedKeys) &&
    expectedKeys.every((key) => PUBLIC_ID.test(value[key] ?? ''));
}

function attestationCore(state, observedPv, observedPvc) {
  const core = {
    schemaVersion: state.volume.readbackAttestation.schemaVersion,
    context: state.volume.kubernetesContext,
    namespace: state.volume.namespace,
    stateContractDigest: stateContractDigest(state),
    pv: {
      name: observedPv.metadata.name,
      uid: observedPv.metadata.uid,
      resourceVersion: observedPv.metadata.resourceVersion,
    },
    pvc: {
      namespace: observedPvc.metadata.namespace,
      name: observedPvc.metadata.name,
      uid: observedPvc.metadata.uid,
      resourceVersion: observedPvc.metadata.resourceVersion,
    },
  };
  return deepFreeze({ ...core, observedDigest: sha256(canonicalJson(core)) });
}

export function validateStateVolumeReadbackAttestation({ state, attestation }) {
  validateStateContract(state);
  if (
    !exactKeys(attestation, READBACK_ATTESTATION_KEYS) ||
    attestation.schemaVersion !== state.volume.readbackAttestation.schemaVersion ||
    attestation.context !== state.volume.kubernetesContext ||
    attestation.namespace !== state.volume.namespace ||
    attestation.stateContractDigest !== stateContractDigest(state) ||
    !publicResourceIdentity(attestation.pv, PV_ATTESTATION_KEYS) ||
    !publicResourceIdentity(attestation.pvc, PVC_ATTESTATION_KEYS) ||
    attestation.pv.name !== state.volume.volumeName ||
    attestation.pvc.name !== state.volume.claimName ||
    attestation.pvc.namespace !== state.volume.namespace
  ) stop('STATE_VOLUME_ATTESTATION_INVALID');
  const core = { ...attestation };
  delete core.observedDigest;
  if (attestation.observedDigest !== sha256(canonicalJson(core))) {
    stop('STATE_VOLUME_ATTESTATION_INVALID');
  }
  return deepFreeze(structuredClone(attestation));
}

function volumeMetadata(state) {
  return {
    labels: {
      'app.kubernetes.io/name': 'seori-auth',
      'seorilabs.io/component': 'state',
      'seorilabs.io/protection-mode': 'application-envelope',
    },
    annotations: {
      'seorilabs.io/journal-content-policy': state.protection.journal.contentPolicy,
      'seorilabs.io/state-contract-major': '3',
    },
  };
}

export function verifyApplicationEnvelopeContract(state) {
  validateStateContract(state);
  return Object.freeze({
    schemaVersion: 3,
    state: 'APPLICATION_ENVELOPE_CONTRACT_VERIFIED',
    rolloutStatus: state.protection.status,
    mode: state.protection.mode,
    secretPersistencePolicy: state.protection.secretPersistencePolicy,
    journal: Object.freeze({
      schemaVersion: state.protection.journal.schemaVersion,
      contentPolicy: state.protection.journal.contentPolicy,
      integrity: state.protection.journal.integrity,
      writeValidation: state.protection.journal.writeValidation,
      checkpoint: Object.freeze({ ...state.protection.journal.checkpoint }),
    }),
    browserVault: Object.freeze({
      envelopeVersion: state.protection.browserVault.envelopeVersion,
      algorithm: state.protection.browserVault.algorithm,
      plaintextAtRestAllowed: state.protection.browserVault.plaintextAtRestAllowed,
    }),
    hostEncryption: Object.freeze({ ...state.hostEncryption }),
  });
}

export function buildRetainVolumeList(state) {
  validateStateContract(state);
  const volume = state.volume;
  const metadata = volumeMetadata(state);
  return deepFreeze({
    apiVersion: 'v1',
    kind: 'List',
    items: [
      {
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: { name: volume.volumeName, ...metadata },
        spec: {
          capacity: { storage: volume.size },
          volumeMode: volume.volumeMode,
          accessModes: [...volume.accessModes],
          persistentVolumeReclaimPolicy: volume.reclaimPolicy,
          storageClassName: volume.storageClassName,
          claimRef: {
            apiVersion: 'v1',
            kind: 'PersistentVolumeClaim',
            namespace: volume.namespace,
            name: volume.claimName,
          },
          local: { path: volume.localPath },
          nodeAffinity: {
            required: {
              nodeSelectorTerms: [{
                matchExpressions: [{
                  key: 'kubernetes.io/hostname',
                  operator: 'In',
                  values: [volume.nodeName],
                }],
              }],
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name: volume.claimName, namespace: volume.namespace, ...metadata },
        spec: {
          volumeName: volume.volumeName,
          storageClassName: volume.storageClassName,
          accessModes: [...volume.accessModes],
          volumeMode: volume.volumeMode,
          resources: { requests: { storage: volume.size } },
        },
      },
    ],
  });
}

function exactOwnedMetadata(actual, expected) {
  if (
    actual?.name !== expected.name || actual?.namespace !== expected.namespace ||
    typeof actual.uid !== 'string' || actual.uid.length === 0 ||
    typeof actual.resourceVersion !== 'string' || actual.resourceVersion.length === 0 ||
    actual.deletionTimestamp != null ||
    actual.labels?.['app.kubernetes.io/name'] !== expected.labels['app.kubernetes.io/name']
  ) stop('STATE_VOLUME_LIVE_READBACK_DRIFT');
  for (const surface of ['labels', 'annotations']) {
    const expectedValues = expected[surface];
    const actualValues = actual[surface] ?? {};
    const ownedKeys = Object.keys(actualValues).filter((key) => key.startsWith('seorilabs.io/'));
    if (
      ownedKeys.toSorted().join('\0') !== Object.keys(expectedValues)
        .filter((key) => key.startsWith('seorilabs.io/')).toSorted().join('\0') ||
      Object.entries(expectedValues).some(([key, value]) => actualValues[key] !== value)
    ) stop('STATE_VOLUME_LIVE_READBACK_DRIFT');
  }
}

function verifyPersistentVolume(actual, expected, pvcUid) {
  if (
    actual?.apiVersion !== expected.apiVersion || actual?.kind !== expected.kind ||
    !exactKeys(actual.spec, PV_SPEC_KEYS) ||
    !isDeepStrictEqual(actual.spec.capacity, expected.spec.capacity) ||
    !isDeepStrictEqual(actual.spec.accessModes, expected.spec.accessModes) ||
    actual.spec.volumeMode !== expected.spec.volumeMode ||
    actual.spec.persistentVolumeReclaimPolicy !== 'Retain' ||
    actual.spec.storageClassName !== expected.spec.storageClassName ||
    !isDeepStrictEqual(actual.spec.local, expected.spec.local) ||
    !isDeepStrictEqual(actual.spec.nodeAffinity, expected.spec.nodeAffinity) ||
    !actual.spec.claimRef ||
    Object.keys(actual.spec.claimRef).some((key) => !CLAIM_REF_KEYS.includes(key)) ||
    Object.entries(expected.spec.claimRef).some(([key, value]) => actual.spec.claimRef[key] !== value) ||
    actual.spec.claimRef.uid !== pvcUid || actual.status?.phase !== 'Bound'
  ) stop('STATE_VOLUME_LIVE_READBACK_DRIFT');
  exactOwnedMetadata(actual.metadata, expected.metadata);
}

function verifyPersistentVolumeClaim(actual, expected) {
  if (
    actual?.apiVersion !== expected.apiVersion || actual?.kind !== expected.kind ||
    !exactKeys(actual.spec, PVC_SPEC_KEYS) || !isDeepStrictEqual(actual.spec, expected.spec) ||
    actual.status?.phase !== 'Bound' ||
    !isDeepStrictEqual(actual.status?.accessModes, expected.spec.accessModes) ||
    actual.status?.capacity?.storage !== expected.spec.resources.requests.storage
  ) stop('STATE_VOLUME_LIVE_READBACK_DRIFT');
  exactOwnedMetadata(actual.metadata, expected.metadata);
}

export function verifyRetainVolumeReadback({ state, observedPv, observedPvc }) {
  validateStateContract(state);
  if (!observedPv && !observedPvc) stop('STATE_VOLUME_LIVE_READBACK_MISSING');
  if (!observedPv || !observedPvc) stop('STATE_VOLUME_LIVE_READBACK_PARTIAL');
  const desired = buildRetainVolumeList(state);
  const expectedPv = desired.items.find(({ kind }) => kind === 'PersistentVolume');
  const expectedPvc = desired.items.find(({ kind }) => kind === 'PersistentVolumeClaim');
  verifyPersistentVolumeClaim(observedPvc, expectedPvc);
  verifyPersistentVolume(observedPv, expectedPv, observedPvc.metadata.uid);
  const volume = state.volume;
  const attestation = attestationCore(state, observedPv, observedPvc);
  return deepFreeze({
    schemaVersion: 3,
    state: 'LIVE_READBACK_VERIFIED',
    readOnly: true,
    retention: 'Retain',
    attestation,
    pv: Object.freeze({
      name: volume.volumeName,
      uid: attestation.pv.uid,
      resourceVersion: attestation.pv.resourceVersion,
      size: volume.size,
      storageClassName: volume.storageClassName,
      nodeName: volume.nodeName,
      phase: 'Bound',
    }),
    pvc: Object.freeze({
      namespace: volume.namespace,
      name: volume.claimName,
      uid: attestation.pvc.uid,
      resourceVersion: attestation.pvc.resourceVersion,
      volumeName: volume.volumeName,
      size: volume.size,
      phase: 'Bound',
    }),
  });
}

export function verifyExactStateVolumeReadback({
  state,
  attestation,
  observedPv,
  observedPvc,
}) {
  const expected = validateStateVolumeReadbackAttestation({ state, attestation });
  const observed = verifyRetainVolumeReadback({ state, observedPv, observedPvc });
  if (!isDeepStrictEqual(observed.attestation, expected)) {
    stop('STATE_VOLUME_ATTESTATION_MISMATCH');
  }
  return observed;
}
