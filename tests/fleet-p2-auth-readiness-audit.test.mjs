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
  return live;
}

function resourceKey(kind, name) {
  return `${kind}\0${name}`;
}

function readerFixture({ mutate, runtimeItems = [], staleConfigMaps = [] } = {}) {
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
      return { apiVersion: 'v1', kind: 'List', items: runtimeItems };
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
  assert.ok(reader.calls.every((call) => call.operation === 'get' || call.operation === 'list'));
  assert.ok(reader.calls.every((call) => call.kind !== 'Secret' && !call.kinds?.includes('secrets')));
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
    runtimeItems: [{ kind: 'Deployment', metadata: { name: 'uncontracted-broker' } }],
  });
  const result = await auditFoundationReadiness({ desired, reader, context });
  assert.equal(result.state, 'BLOCKED');
  assert.ok(result.diagnostics.some((item) =>
    item.code === 'FOUNDATION_RESOURCE_DRIFT' && item.kind === 'ServiceAccount' && item.name === 'auth-broker'));
  assert.ok(result.diagnostics.some((item) =>
    item.code === 'STALE_PUBLIC_BINDING_PRESENT' && item.name === staleName));
  assert.ok(result.diagnostics.some((item) =>
    item.code === 'UNDECLARED_RUNTIME_RESOURCE_PRESENT' && item.kind === 'Deployment'));
});

test('readiness CLI contains only bounded get readback and never requests Secret resources', async () => {
  const source = await readFile('tools/seori-auth/scripts/audit-foundation-readiness.mjs', 'utf8');
  assert.match(source, /const base = \['--context', context, 'get'\]/u);
  assert.doesNotMatch(source, /\b(?:apply|create|delete|patch|replace)\b/u);
  assert.doesNotMatch(source, /['"]secrets?['"]/u);
});
