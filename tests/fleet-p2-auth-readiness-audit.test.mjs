import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  FoundationReadinessError,
  auditFoundationReadiness,
} from '../tools/seori-auth/scripts/audit-foundation-readiness.mjs';
import { buildRetainVolumeList } from '../tools/seori-auth/src/state-envelope.mjs';

const execFileAsync = promisify(execFile);
const context = 'vzyx-cluster';
const { stdout } = await execFileAsync(process.execPath, [
  'scripts/fleet/render-p3-runtime.mjs',
  'auth-broker-foundation',
]);
const desired = JSON.parse(stdout);
const namespace = 'auth-broker';

function liveResource(resource) {
  const live = structuredClone(resource);
  live.metadata.uid = `uid-${resource.kind}-${resource.metadata.name}`;
  live.metadata.resourceVersion = '1';
  live.metadata.creationTimestamp = '2026-08-29T00:00:00Z';
  if (resource.kind === 'Namespace') {
    live.metadata.labels['kubernetes.io/metadata.name'] = namespace;
  }
  if (['Certificate', 'Issuer'].includes(resource.kind)) {
    live.status = { conditions: [{ type: 'Ready', status: 'True' }] };
  }
  if (resource.kind === 'Role') live.rules = null;
  if (resource.kind === 'Service') {
    live.spec = {
      clusterIP: '10.152.183.10',
      clusterIPs: ['10.152.183.10'],
      internalTrafficPolicy: 'Cluster',
      ipFamilies: ['IPv4'],
      ipFamilyPolicy: 'SingleStack',
      ...live.spec,
      sessionAffinity: 'None',
      type: 'ClusterIP',
    };
  }
  return live;
}

function resourceKey(kind, name) {
  return `${kind}\0${name}`;
}

function withExternalGateState(source, ready) {
  const copy = structuredClone(source);
  const configMap = copy.items.find(({ kind }) => kind === 'ConfigMap');
  const binding = JSON.parse(configMap.data['bindings.json']);
  const externalState = ready ? 'ready' : 'blocked_unverified';
  binding.registry.catalogStatus = externalState;
  binding.registry.kubernetesStatus = externalState;
  binding.secretManager.state = externalState;
  binding.secretManager.provisioning.state = externalState;
  binding.state.protection.status = ready ? 'verified' : 'blocked_unverified';
  binding.state.hostEncryption.status = ready ? 'verified' : 'blocked_unverified';
  configMap.data['bindings.json'] = JSON.stringify(binding);
  return copy;
}

function liveStateResources(desiredState) {
  const configMap = desiredState.items.find(({ kind }) => kind === 'ConfigMap');
  const state = JSON.parse(configMap.data['bindings.json']).state;
  const volumeList = structuredClone(buildRetainVolumeList(state));
  const pv = volumeList.items.find(({ kind }) => kind === 'PersistentVolume');
  const pvc = volumeList.items.find(({ kind }) => kind === 'PersistentVolumeClaim');
  pvc.metadata.uid = 'state-pvc-uid';
  pvc.metadata.resourceVersion = '17';
  pvc.status = {
    phase: 'Bound',
    accessModes: [...pvc.spec.accessModes],
    capacity: { storage: pvc.spec.resources.requests.storage },
  };
  pv.metadata.uid = 'state-pv-uid';
  pv.metadata.resourceVersion = '19';
  pv.spec.claimRef.uid = pvc.metadata.uid;
  pv.spec.claimRef.resourceVersion = pvc.metadata.resourceVersion;
  pv.status = { phase: 'Bound' };
  return { pv, pvc };
}

function readerFixture({
  allowedSecretAuthorization = [],
  desiredState = desired,
  mutate,
  networkSurfaceItems,
  namespaceRbacItems,
  runtimeItems = [],
  stateScenario = 'exact',
  stateMutation,
  staleConfigMaps = [],
} = {}) {
  const resources = new Map(desiredState.items.map((resource) => {
    const live = liveResource(resource);
    mutate?.(live);
    return [resourceKey(resource.kind, resource.metadata.name), live];
  }));
  const stateResources = liveStateResources(desiredState);
  stateMutation?.(stateResources);
  if (!['missing-both', 'missing-pv'].includes(stateScenario)) {
    resources.set(resourceKey('PersistentVolume', stateResources.pv.metadata.name), stateResources.pv);
  }
  if (!['missing-both', 'missing-pvc'].includes(stateScenario)) {
    resources.set(resourceKey('PersistentVolumeClaim', stateResources.pvc.metadata.name), stateResources.pvc);
  }
  const calls = [];
  return {
    calls,
    async get(kind, name, requestedNamespace) {
      calls.push({ operation: 'get', kind, name, namespace: requestedNamespace });
      if (
        stateScenario === 'unknown' &&
        ['PersistentVolume', 'PersistentVolumeClaim'].includes(kind)
      ) throw new FoundationReadinessError('READBACK_CHILD_FAILED');
      return structuredClone(resources.get(resourceKey(kind, name)));
    },
    async list(kinds, requestedNamespace) {
      calls.push({ operation: 'list', kinds, namespace: requestedNamespace });
      if (kinds.length === 1 && kinds[0] === 'configmaps') {
        const current = resources.get(resourceKey(
          'ConfigMap',
          desiredState.items.find(({ kind }) => kind === 'ConfigMap').metadata.name,
        ));
        return { apiVersion: 'v1', kind: 'List', items: [current, ...staleConfigMaps] };
      }
      if (kinds.includes('roles')) {
        const exact = desiredState.items
          .filter(({ kind }) => ['Role', 'RoleBinding'].includes(kind))
          .map(({ kind, metadata }) => resources.get(resourceKey(kind, metadata.name)));
        return { apiVersion: 'v1', kind: 'List', items: namespaceRbacItems ?? exact };
      }
      if (kinds.includes('services')) {
        const exact = desiredState.items
          .filter(({ kind }) => ['Service', 'NetworkPolicy'].includes(kind))
          .map(({ kind, metadata }) => resources.get(resourceKey(kind, metadata.name)));
        return { apiVersion: 'v1', kind: 'List', items: networkSurfaceItems ?? exact };
      }
      if (kinds.length === 1 && kinds[0] === 'persistentvolumeclaims') {
        const claim = resources.get(resourceKey(
          'PersistentVolumeClaim',
          stateResources.pvc.metadata.name,
        ));
        return { apiVersion: 'v1', kind: 'List', items: claim ? [claim] : [] };
      }
      return { apiVersion: 'v1', kind: 'List', items: runtimeItems };
    },
    async canI(request) {
      calls.push({ operation: 'canI', ...request });
      return allowedSecretAuthorization.some(({ serviceAccount, verb }) =>
        serviceAccount === request.serviceAccount && verb === request.verb);
    },
  };
}

test('readiness auditor exact-matches live foundation and remains blocked by current external gates', async () => {
  const blockedDesired = withExternalGateState(desired, false);
  const reader = readerFixture({ desiredState: blockedDesired });
  const result = await auditFoundationReadiness({ desired: blockedDesired, reader, context });
  assert.equal(result.state, 'BLOCKED');
  assert.deepEqual(result.diagnostics, [
    { code: 'REGISTRY_GATE_BLOCKED' },
    { code: 'SECRET_MANAGER_GATE_BLOCKED' },
    { code: 'STATE_APPLICATION_PROTECTION_GATE_BLOCKED' },
    { code: 'STATE_HOST_ENCRYPTION_GATE_BLOCKED' },
  ]);
  assert.match(result.stateReadbackAttestation.observedDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.stateReadbackAttestation.pv, {
    name: 'seori-auth-state-rpi5',
    uid: 'state-pv-uid',
    resourceVersion: '19',
  });
  assert.ok(reader.calls.every((call) => ['get', 'list', 'canI'].includes(call.operation)));
  assert.ok(reader.calls.every((call) =>
    call.operation === 'canI' || (call.kind !== 'Secret' && !call.kinds?.includes('secrets'))));
});

test('self-declared verified 상태는 exact PV/PVC readback 없이는 READY가 되지 않는다', async () => {
  const readyDesired = withExternalGateState(desired, true);
  const exact = await auditFoundationReadiness({
    desired: readyDesired,
    reader: readerFixture({ desiredState: readyDesired }),
    context,
  });
  assert.equal(exact.state, 'READY');
  assert.deepEqual(exact.diagnostics, []);
  assert.match(exact.stateReadbackAttestation.observedDigest, /^[a-f0-9]{64}$/u);

  for (const [stateScenario, code] of [
    ['missing-both', 'STATE_VOLUME_LIVE_READBACK_MISSING'],
    ['missing-pv', 'STATE_VOLUME_LIVE_READBACK_PARTIAL'],
    ['missing-pvc', 'STATE_VOLUME_LIVE_READBACK_PARTIAL'],
  ]) {
    const result = await auditFoundationReadiness({
      desired: readyDesired,
      reader: readerFixture({ desiredState: readyDesired, stateScenario }),
      context,
    });
    assert.equal(result.state, 'BLOCKED');
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code));
    assert.equal('stateReadbackAttestation' in result, false);
  }

  const drift = await auditFoundationReadiness({
    desired: readyDesired,
    reader: readerFixture({
      desiredState: readyDesired,
      stateMutation({ pv }) {
        pv.spec.persistentVolumeReclaimPolicy = 'Delete';
      },
    }),
    context,
  });
  assert.equal(drift.state, 'BLOCKED');
  assert.ok(drift.diagnostics.some(({ code }) => code === 'STATE_VOLUME_LIVE_READBACK_DRIFT'));

  await assert.rejects(
    auditFoundationReadiness({
      desired: readyDesired,
      reader: readerFixture({ desiredState: readyDesired, stateScenario: 'unknown' }),
      context,
    }),
    (error) => error instanceof FoundationReadinessError && error.code === 'READBACK_CHILD_FAILED',
  );
});

test('readiness auditor rejects an absent or mismatched contract namespace before readback', async () => {
  for (const namespaceValue of [undefined, '', 'other-namespace']) {
    const invalidDesired = structuredClone(desired);
    const configMap = invalidDesired.items.find(({ kind }) => kind === 'ConfigMap');
    const binding = JSON.parse(configMap.data['bindings.json']);
    binding.namespace = namespaceValue;
    configMap.data['bindings.json'] = JSON.stringify(binding);
    const reader = readerFixture({ desiredState: invalidDesired });
    await assert.rejects(
      () => auditFoundationReadiness({ desired: invalidDesired, reader, context }),
      /CURRENT_CONTRACT_NAMESPACE_INVALID/u,
    );
    assert.deepEqual(reader.calls, []);
  }
});

test('readiness auditor reports SA default drift, stale binding, and undeclared runtime without mutation', async () => {
  const staleName = 'auth-broker-public-bindings';
  const reader = readerFixture({
    mutate(resource) {
      if (resource.kind === 'ServiceAccount' && resource.metadata.name === 'auth-broker') {
        delete resource.automountServiceAccountToken;
      }
    },
    staleConfigMaps: [{ kind: 'ConfigMap', metadata: { name: staleName } }],
    runtimeItems: [
      { kind: 'Deployment', metadata: { name: 'uncontracted-broker' } },
      { kind: 'CronJob', metadata: { name: 'uncontracted-refresh' } },
    ],
  });
  const result = await auditFoundationReadiness({ desired, reader, context });
  assert.equal(result.state, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) =>
    item.code === 'FOUNDATION_RESOURCE_DRIFT' && item.kind === 'ServiceAccount' && item.name === 'auth-broker'));
  assert.ok(result.diagnostics.some((item) =>
    item.code === 'STALE_PUBLIC_BINDING_PRESENT' && item.name === staleName));
  assert.ok(result.diagnostics.some((item) =>
    item.code === 'UNDECLARED_RUNTIME_RESOURCE_PRESENT' && item.kind === 'Deployment'));
  assert.ok(result.diagnostics.some((item) =>
    item.code === 'UNDECLARED_RUNTIME_RESOURCE_PRESENT' && item.kind === 'CronJob'));
});

test('readiness auditor rejects additive namespace and effective cluster Secret RBAC', async () => {
  const extraRole = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: 'secret-reader', namespace },
    rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }],
  };
  const extraBinding = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: 'secret-reader', namespace },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'secret-reader' },
    subjects: [{ kind: 'ServiceAccount', name: 'auth-broker', namespace }],
  };
  const expectedRbac = desired.items
    .filter(({ kind }) => ['Role', 'RoleBinding'].includes(kind))
    .map(liveResource);
  const clusterBinding = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: 'cluster-secret-reader' },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'secret-reader' },
    subjects: [{ kind: 'ServiceAccount', name: 'auth-broker', namespace }],
  };
  const reader = readerFixture({
    namespaceRbacItems: [...expectedRbac, extraRole, extraBinding],
    allowedSecretAuthorization: [{
      serviceAccount: clusterBinding.subjects[0].name,
      verb: 'get',
    }],
  });
  const result = await auditFoundationReadiness({ desired, reader, context });
  assert.ok(result.diagnostics.some(({ code, kind, name }) =>
    code === 'UNDECLARED_NAMESPACE_RBAC_PRESENT' && kind === 'Role' && name === 'secret-reader'));
  assert.ok(result.diagnostics.some(({ code, kind, name }) =>
    code === 'UNDECLARED_NAMESPACE_RBAC_PRESENT' && kind === 'RoleBinding' && name === 'secret-reader'));
  assert.ok(result.diagnostics.some(({ code, name, verb }) =>
    code === 'SECRET_AUTHORIZATION_PRESENT' && name === 'auth-broker' && verb === 'get'));
});

test('readiness auditor rejects Service exposure and NetworkPolicy endPort extensions', async () => {
  const reader = readerFixture({
    mutate(resource) {
      if (resource.kind === 'Service' && resource.metadata.name === 'auth-broker') {
        resource.spec.type = 'LoadBalancer';
        resource.spec.externalIPs = ['203.0.113.10'];
      }
      if (resource.kind === 'NetworkPolicy' && resource.metadata.name === 'broker-allowed-traffic') {
        resource.spec.ingress[0].ports[0].endPort = 9443;
      }
    },
  });
  const result = await auditFoundationReadiness({ desired, reader, context });
  assert.ok(result.diagnostics.some(({ code, kind, name }) =>
    code === 'FOUNDATION_RESOURCE_DRIFT' && kind === 'Service' && name === 'auth-broker'));
  assert.ok(result.diagnostics.some(({ code, kind, name }) =>
    code === 'FOUNDATION_RESOURCE_DRIFT' && kind === 'NetworkPolicy' && name === 'broker-allowed-traffic'));
});

test('readiness auditor rejects additional LoadBalancer Service and allow-all NetworkPolicy inventory', async () => {
  const exact = desired.items
    .filter(({ kind }) => ['Service', 'NetworkPolicy'].includes(kind))
    .map(liveResource);
  const reader = readerFixture({
    networkSurfaceItems: [
      ...exact,
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'public-broker', namespace },
        spec: {
          selector: { 'app.kubernetes.io/name': 'seori-auth-broker' },
          ports: [{ name: 'https', port: 443, targetPort: 8443, protocol: 'TCP' }],
          type: 'LoadBalancer',
        },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'allow-all', namespace },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress', 'Egress'],
          ingress: [{}],
          egress: [{}],
        },
      },
    ],
  });
  const result = await auditFoundationReadiness({ desired, reader, context });
  assert.ok(result.diagnostics.some(({ code, kind, name }) =>
    code === 'UNDECLARED_NETWORK_SURFACE_PRESENT' && kind === 'Service' && name === 'public-broker'));
  assert.ok(result.diagnostics.some(({ code, kind, name }) =>
    code === 'UNDECLARED_NETWORK_SURFACE_PRESENT' && kind === 'NetworkPolicy' && name === 'allow-all'));
});

test('readiness CLI uses explicit kubeconfig, isolated profile, and bounded non-secret readback', async () => {
  const [source, boundary] = await Promise.all([
    readFile('tools/seori-auth/scripts/audit-foundation-readiness.mjs', 'utf8'),
    readFile('tools/seori-auth/src/kubectl-readback-boundary.mjs', 'utf8'),
  ]);
  assert.match(source, /`--kubeconfig=\$\{boundary\.kubeconfig\}`/u);
  assert.match(source, /`--cache-dir=\$\{boundary\.cacheDirectory\}`/u);
  assert.match(source, /openSecureKubectlReadbackBoundary/u);
  assert.match(source, /'auth', 'can-i', verb, resource/u);
  assert.doesNotMatch(source, /get[^\n]+['"]secrets?['"]/u);
  assert.doesNotMatch(source, /HOME: process\.env\.HOME|KUBECONFIG: process\.env\.KUBECONFIG/u);
  for (const key of [
    'HOME', 'KUBECONFIG', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  ]) {
    assert.match(boundary, new RegExp(`${key}:`));
  }
  assert.match(boundary, /mkdtempSync/u);
  assert.match(boundary, /mkdirSync\(path, \{ mode: 0o700 \}\)/u);
});
