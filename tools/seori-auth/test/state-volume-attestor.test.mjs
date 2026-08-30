import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import {
  validateStateAttestorExpected,
  verifyStateVolumeWithReader,
} from '../runtime/state-volume-attestor.mjs';
import {
  buildRetainVolumeList,
  verifyRetainVolumeReadback,
} from '../src/state-envelope.mjs';
import {
  buildHostEncryptedMountAttestation,
  HOST_ENCRYPTION_MARKER_PATH,
} from '../src/host-encrypted-mount.mjs';

const fleet = parse(await readFile(
  fileURLToPath(new URL('../../../contracts/fleet-p3-runtime.yaml', import.meta.url)),
  'utf8',
));
const state = fleet.authBroker.state;

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
  const attestation = structuredClone(
    verifyRetainVolumeReadback({ state, observedPv: pv, observedPvc: pvc }).attestation,
  );
  const hostEncryptionAttestation = structuredClone(buildHostEncryptedMountAttestation({
    state,
    stateVolumeAttestation: attestation,
    luksUuid: '12345678-1234-1234-1234-123456789abc',
  }));
  return {
    expected: {
      schemaVersion: 1,
      state,
      kubernetesApi: fleet.authBroker.kubernetesApi,
      attestation,
      hostEncryptionAttestation,
    },
    hostEncryptionAttestation,
    pv,
    pvc,
  };
}

test('startup attestor reads only the exact PV/PVC and accepts the pinned host/PV/PVC digests', async () => {
  const { expected, hostEncryptionAttestation, pv, pvc } = fixture();
  const calls = [];
  const resources = new Map([
    ['/api/v1/persistentvolumes/seori-auth-state-rpi5', pv],
    ['/api/v1/namespaces/auth-broker/persistentvolumeclaims/seori-auth-state', pvc],
  ]);
  const result = await verifyStateVolumeWithReader({
    expected,
    hostEncryptionMarker: hostEncryptionAttestation,
    async readResource(path) {
      calls.push(path);
      return structuredClone(resources.get(path));
    },
  });
  assert.deepEqual(calls, [...resources.keys()]);
  assert.equal(result.attestation.observedDigest, expected.attestation.observedDigest);
  assert.deepEqual(result.attestation.pv, expected.attestation.pv);
  assert.deepEqual(result.attestation.pvc, expected.attestation.pvc);
  assert.equal(
    result.hostEncryptionAttestation.observedDigest,
    expected.hostEncryptionAttestation.observedDigest,
  );
  assert.equal(
    result.runtimeMarker.hostEncryptionDigest,
    expected.hostEncryptionAttestation.observedDigest,
  );
});

test('startup attestor fails closed on substitution, missing, partial, or invalid API binding', async () => {
  const { expected, hostEncryptionAttestation, pv, pvc } = fixture();
  const substitutedPvc = structuredClone(pvc);
  substitutedPvc.metadata.resourceVersion = '18';
  await assert.rejects(
    verifyStateVolumeWithReader({
      expected,
      hostEncryptionMarker: hostEncryptionAttestation,
      readResource: async (path) => path.includes('persistentvolumeclaims')
        ? substitutedPvc
        : pv,
    }),
    (error) => error?.code === 'STATE_VOLUME_ATTESTATION_MISMATCH',
  );

  for (const [missing, code] of [
    ['both', 'STATE_VOLUME_LIVE_READBACK_MISSING'],
    ['pvc', 'STATE_VOLUME_LIVE_READBACK_PARTIAL'],
  ]) {
    await assert.rejects(
      verifyStateVolumeWithReader({
        expected,
        hostEncryptionMarker: hostEncryptionAttestation,
        readResource: async (path) => {
          if (missing === 'both' || path.includes('persistentvolumeclaims')) return undefined;
          return pv;
        },
      }),
      (error) => error?.code === code,
    );
  }

  const broadApi = structuredClone(expected);
  broadApi.kubernetesApi.egressCidr = '0.0.0.0/0';
  assert.throws(
    () => validateStateAttestorExpected(broadApi),
    (error) => error?.code === 'STATE_ATTESTOR_EXPECTED_INVALID',
  );
});

test('startup attestor fails closed when the encrypted-mount marker is absent or drifts', async () => {
  const { expected, hostEncryptionAttestation, pv, pvc } = fixture();
  const readResource = async (path) => path.includes('persistentvolumeclaims') ? pvc : pv;

  await assert.rejects(
    verifyStateVolumeWithReader({ expected, readResource }),
    (error) => error?.code === 'HOST_ENCRYPTION_ATTESTATION_INVALID',
  );

  for (const field of ['luksUuid', 'mapperPath', 'sourcePath']) {
    const drifted = structuredClone(hostEncryptionAttestation);
    drifted[field] = field === 'luksUuid'
      ? 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      : `/plain-ext4/${field}`;
    await assert.rejects(
      verifyStateVolumeWithReader({
        expected,
        hostEncryptionMarker: drifted,
        readResource,
      }),
      (error) => ['HOST_ENCRYPTION_ATTESTATION_INVALID', 'HOST_ENCRYPTION_ATTESTATION_MISMATCH']
        .includes(error?.code),
    );
  }
});

test('runtime attestor has fixed mounts and no ambient profile or mutation command surface', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../runtime/state-volume-attestor.mjs', import.meta.url)),
    'utf8',
  );
  for (const path of [
    '/etc/seori-auth-state-attestor/expected.json',
    '/var/run/seori-auth-state-token/token',
    '/var/run/seori-auth-state-token/ca.crt',
    '/run/seori-auth-state-attestor/verified.json',
  ]) assert.match(source, new RegExp(path.replaceAll('/', '\\/')));
  assert.equal(
    HOST_ENCRYPTION_MARKER_PATH,
    '/var/lib/seori-auth/.seorilabs-host-encrypted-mount.json',
  );
  assert.match(source, /secureBytes\(HOST_ENCRYPTION_MARKER_PATH/u);
  assert.doesNotMatch(source, /process\.env|\b(?:POST|PUT|PATCH|DELETE)\b/u);
  assert.match(source, /method: 'GET'/u);
});
