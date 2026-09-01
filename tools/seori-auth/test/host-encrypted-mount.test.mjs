import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  buildHostEncryptedMountAttestation,
  buildRuntimeStateAttestationMarker,
  validateHostEncryptionPolicy,
  validateHostEncryptedMountAttestation,
  validateHostEncryptedMountMarkerDigest,
  validateRuntimeStateAttestationMarker,
} from '../src/host-encrypted-mount.mjs';
import {
  buildRetainVolumeList,
  verifyRetainVolumeReadback,
} from '../src/state-envelope.mjs';

const fleet = parse(await readFile(
  fileURLToPath(new URL('../../../contracts/fleet-p3-runtime.yaml', import.meta.url)),
  'utf8',
));
const state = fleet.authBroker.state;

test('verified host policy requires the exact reboot receipt evidence', () => {
  assert.equal(validateHostEncryptionPolicy(state).status, 'verified');

  const missing = structuredClone(state);
  delete missing.hostEncryption.verification;
  assert.throws(
    () => validateHostEncryptionPolicy(missing),
    (error) => error?.code === 'HOST_ENCRYPTION_POLICY_INVALID',
  );

  const tampered = structuredClone(state);
  tampered.hostEncryption.verification.receipt.currentBootId =
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.throws(
    () => validateHostEncryptionPolicy(tampered),
    (error) => error?.code === 'HOST_ENCRYPTION_POLICY_INVALID',
  );

  const blockedWithEvidence = structuredClone(state);
  blockedWithEvidence.hostEncryption.status = 'blocked_unverified';
  assert.throws(
    () => validateHostEncryptionPolicy(blockedWithEvidence),
    (error) => error?.code === 'HOST_ENCRYPTION_POLICY_INVALID',
  );
});

function fixture() {
  const desired = structuredClone(buildRetainVolumeList(state));
  const pv = desired.items.find(({ kind }) => kind === 'PersistentVolume');
  const pvc = desired.items.find(({ kind }) => kind === 'PersistentVolumeClaim');
  pvc.metadata.uid = 'fixture-pvc-uid';
  pvc.metadata.resourceVersion = '17';
  pvc.status = {
    phase: 'Bound',
    accessModes: [...pvc.spec.accessModes],
    capacity: { storage: pvc.spec.resources.requests.storage },
  };
  pv.metadata.uid = 'fixture-pv-uid';
  pv.metadata.resourceVersion = '19';
  pv.spec.claimRef.uid = pvc.metadata.uid;
  pv.spec.claimRef.resourceVersion = pvc.metadata.resourceVersion;
  pv.status = { phase: 'Bound' };
  const stateVolumeAttestation = verifyRetainVolumeReadback({
    state,
    observedPv: pv,
    observedPvc: pvc,
  }).attestation;
  const hostEncryptionAttestation = buildHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation,
    luksUuid: '12345678-1234-1234-1234-123456789abc',
  });
  return { hostEncryptionAttestation, stateVolumeAttestation };
}

test('host marker exact-binds LUKS UUID, mapper, source and Retain PV/PVC identity', () => {
  const { hostEncryptionAttestation, stateVolumeAttestation } = fixture();
  const actual = validateHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation,
    attestation: hostEncryptionAttestation,
  });
  assert.equal(actual.luksType, 'LUKS2');
  assert.equal(actual.filesystemType, 'ext4');
  assert.equal(actual.mapperPath, '/dev/mapper/seori-auth-state');
  assert.equal(actual.sourcePath, '/data/seori-auth/seori-auth-state.luks');
  assert.equal(actual.mountPath, '/var/lib/seori-auth');
  assert.deepEqual(actual.pv, stateVolumeAttestation.pv);
  assert.deepEqual(actual.pvc, stateVolumeAttestation.pvc);
  assert.match(actual.observedDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    validateHostEncryptedMountMarkerDigest({
      attestation: actual,
      expectedDigest: actual.observedDigest,
    }),
    actual,
  );
});

test('missing marker, plain ext4 identity and every pinned identity drift fail closed', () => {
  const { hostEncryptionAttestation, stateVolumeAttestation } = fixture();
  assert.throws(
    () => validateHostEncryptedMountAttestation({
      state,
      stateVolumeAttestation,
      attestation: undefined,
    }),
    (error) => error?.code === 'HOST_ENCRYPTION_ATTESTATION_INVALID',
  );

  const cases = [
    ['luksType', 'NONE'],
    ['luksUuid', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    ['mapperPath', '/dev/mmcblk0p2'],
    ['sourcePath', '/dev/mmcblk0p2'],
    ['filesystemType', 'ext4-plain'],
    ['nodeName', 'rpi4001'],
  ];
  for (const [field, value] of cases) {
    const drifted = structuredClone(hostEncryptionAttestation);
    drifted[field] = value;
    assert.throws(
      () => validateHostEncryptedMountAttestation({
        state,
        stateVolumeAttestation,
        attestation: drifted,
      }),
      (error) => error?.code === 'HOST_ENCRYPTION_ATTESTATION_INVALID',
    );
  }

  for (const resource of ['pv', 'pvc']) {
    const drifted = structuredClone(hostEncryptionAttestation);
    drifted[resource].uid = `substituted-${resource}-uid`;
    assert.throws(
      () => validateHostEncryptedMountAttestation({
        state,
        stateVolumeAttestation,
        attestation: drifted,
      }),
      (error) => error?.code === 'HOST_ENCRYPTION_ATTESTATION_INVALID',
    );
  }
});

test('runtime marker binds both public digests and rejects stale host state', () => {
  const { hostEncryptionAttestation, stateVolumeAttestation } = fixture();
  const marker = buildRuntimeStateAttestationMarker({
    stateVolumeAttestation,
    hostEncryptionAttestation,
  });
  assert.deepEqual(validateRuntimeStateAttestationMarker({
    marker,
    expectedObservedDigest: marker.observedDigest,
    expectedHostEncryptionDigest: hostEncryptionAttestation.observedDigest,
  }), marker);

  assert.throws(
    () => validateRuntimeStateAttestationMarker({
      marker,
      expectedObservedDigest: marker.observedDigest,
      expectedHostEncryptionDigest: 'f'.repeat(64),
    }),
    (error) => error?.code === 'RUNTIME_STATE_ATTESTATION_INVALID',
  );
  assert.doesNotMatch(
    JSON.stringify({ hostEncryptionAttestation, marker }),
    /password|totp|cookie|secret|keyMaterial/iu,
  );
});
