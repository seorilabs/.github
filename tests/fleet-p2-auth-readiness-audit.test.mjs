import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { auditFoundationReadiness } from '../tools/seori-auth/scripts/audit-foundation-readiness.mjs';

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

function readerFixture({
  allowedSecretAuthorization = [],
  mutate,
  namespaceRbacItems,
  runtimeItems = [],
  staleConfigMaps = [],
} = {}) {
  const resources = new Map(desired.items.map((resource) => {
    const live = liveResource(resource);
    mutate?.(live);
    return [resourceKey(resource.kind, resource.metadata.name), live];
  }));
  const calls = [];
  return {
    calls,
    async get(kind, name, requestedNamespace) {
      calls.push({ operation: 'get', kind, name, namespace: requestedNamespace });
      return structuredClone(resources.get(resourceKey(kind, name)));
    },
    async list(kinds, requestedNamespace) {
      calls.push({ operation: 'list', kinds, namespace: requestedNamespace });
      if (kinds.length === 1 && kinds[0] === 'configmaps') {
        const current = resources.get(resourceKey(
          'ConfigMap',
          desired.items.find(({ kind }) => kind === 'ConfigMap').metadata.name,
        ));
        return { apiVersion: 'v1', kind: 'List', items: [current, ...staleConfigMaps] };
      }
      if (kinds.includes('roles')) {
        const exact = desired.items
          .filter(({ kind }) => ['Role', 'RoleBinding'].includes(kind))
          .map(({ kind, metadata }) => resources.get(resourceKey(kind, metadata.name)));
        return { apiVersion: 'v1', kind: 'List', items: namespaceRbacItems ?? exact };
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
  const reader = readerFixture();
  const result = await auditFoundationReadiness({ desired, reader, context });
  assert.equal(result.state, 'BLOCKED');
  assert.deepEqual(result.diagnostics, [
    { code: 'REGISTRY_GATE_BLOCKED' },
    { code: 'SECRET_MANAGER_GATE_BLOCKED' },
    { code: 'STATE_ENCRYPTION_GATE_BLOCKED' },
  ]);
  assert.ok(reader.calls.every((call) => ['get', 'list', 'canI'].includes(call.operation)));
  assert.ok(reader.calls.every((call) =>
    call.operation === 'canI' || (call.kind !== 'Secret' && !call.kinds?.includes('secrets'))));
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

test('readiness CLI uses only bounded get and non-secret authorization readback', async () => {
  const source = await readFile('tools/seori-auth/scripts/audit-foundation-readiness.mjs', 'utf8');
  assert.match(source, /const base = \['--context', context, 'get'\]/u);
  assert.match(source, /'auth', 'can-i', verb, resource/u);
  assert.doesNotMatch(source, /get[^\n]+['"]secrets?['"]/u);
});
