import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

import {
  validateStateAttestorExpected,
  verifyStateVolumeWithReader,
} from '../runtime/state-volume-attestor.mjs';
import {
  buildRetainVolumeList,
  verifyRetainVolumeReadback,
} from '../src/state-envelope.mjs';

const fleet = parse(await readFile('contracts/fleet-p3-runtime.yaml', 'utf8'));
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
  return {
    expected: {
      schemaVersion: 1,
      state,
      kubernetesApi: fleet.authBroker.kubernetesApi,
      attestation,
    },
    pv,
    pvc,
  };
}

test('startup attestor reads only the exact PV/PVC and accepts the pinned UID/RV/digest', async () => {
  const { expected, pv, pvc } = fixture();
  const calls = [];
  const resources = new Map([
    ['/api/v1/persistentvolumes/seori-auth-state-rpi5', pv],
    ['/api/v1/namespaces/auth-broker/persistentvolumeclaims/seori-auth-state', pvc],
  ]);
  const result = await verifyStateVolumeWithReader({
    expected,
    async readResource(path) {
      calls.push(path);
      return structuredClone(resources.get(path));
    },
  });
  assert.deepEqual(calls, [...resources.keys()]);
  assert.equal(result.attestation.observedDigest, expected.attestation.observedDigest);
  assert.deepEqual(result.attestation.pv, expected.attestation.pv);
  assert.deepEqual(result.attestation.pvc, expected.attestation.pvc);
});

test('startup attestor fails closed on substitution, missing, partial, or invalid API binding', async () => {
  const { expected, pv, pvc } = fixture();
  const substitutedPvc = structuredClone(pvc);
  substitutedPvc.metadata.resourceVersion = '18';
  await assert.rejects(
    verifyStateVolumeWithReader({
      expected,
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

test('runtime attestor has fixed mounts and no ambient profile or mutation command surface', async () => {
  const source = await readFile('tools/seori-auth/runtime/state-volume-attestor.mjs', 'utf8');
  for (const path of [
    '/etc/seori-auth-state-attestor/expected.json',
    '/var/run/seori-auth-state-token/token',
    '/var/run/seori-auth-state-token/ca.crt',
    '/run/seori-auth-state-attestor/verified.json',
  ]) assert.match(source, new RegExp(path.replaceAll('/', '\\/')));
  assert.doesNotMatch(source, /process\.env|\b(?:POST|PUT|PATCH|DELETE)\b/u);
  assert.match(source, /method: 'GET'/u);
});
