import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PolicyEngine } from '../src/index.mjs';

const packageRoot = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, packageRoot), 'utf8');
}

test('example policy and JSON schemas are parseable', async () => {
  const policy = JSON.parse(await read('policy/example.policy.json'));
  const policySchema = JSON.parse(await read('schemas/policy.schema.json'));
  const leaseSchema = JSON.parse(await read('schemas/lease-request.schema.json'));

  assert.equal(new PolicyEngine(policy).generation, 1);
  assert.equal(policySchema.additionalProperties, false);
  assert.equal(leaseSchema.additionalProperties, false);
  assert.ok(
    [
      'subject',
      'runId',
      'repository',
      'commitSha',
      'provider',
      'origin',
      'capability',
      'resource',
      'artifact',
    ].every((field) => field === 'artifact' || leaseSchema.required.includes(field)),
  );
});

test('Kubernetes examples contain no secret value and grant workers no API rules', async () => {
  const rbac = await read('k8s/rbac.yaml');
  const networkPolicy = await read('k8s/network-policy.yaml');
  const workerRole = rbac.match(
    /name: seori-auth-worker-no-kubernetes-api\n  namespace: seori-auth-workloads\nrules: \[\]/,
  );

  assert.ok(workerRole, 'worker role must remain empty');
  assert.doesNotMatch(rbac, /^\s*(data|stringData):/m);
  assert.match(rbac, /resourceNames: \["seori-auth-execution-copy"\]/);
  assert.doesNotMatch(rbac, /verbs: \["(?:list|watch)"\]/);
  assert.match(networkPolicy, /name: seori-auth-broker-default-deny/);
  assert.match(networkPolicy, /ingress: \[\]\n  egress: \[\]/);
});
