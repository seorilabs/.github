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
  const brokerSchema = JSON.parse(await read('schemas/local-broker.schema.json'));

  assert.equal(new PolicyEngine(policy).generation, 1);
  assert.equal(policySchema.additionalProperties, false);
  assert.equal(leaseSchema.additionalProperties, false);
  assert.equal(leaseSchema.properties.redirectOrigins.uniqueItems, true);
  assert.equal(brokerSchema.$defs.executionBinding.additionalProperties, false);
  assert.equal(brokerSchema.oneOf.length, 5);
  assert.deepEqual(
    brokerSchema.$defs.publicIdentity.required,
    ['provider', 'accountId', 'teamId', 'workspaceId', 'appId'],
  );
  const opaqueId = new RegExp(brokerSchema.$defs.opaqueId.pattern);
  const publicId = new RegExp(brokerSchema.$defs.publicId.pattern);
  assert.equal(opaqueId.test('capability-id_1'), true);
  assert.equal(opaqueId.test('capability/id'), false);
  assert.equal(publicId.test('accounts/user@example.com'), true);
  for (const [definition, property] of [
    ['browserCompleteRequest', 'capabilityId'],
    ['credentialCheckout', 'id'],
    ['browserSessionBinding', 'id'],
    ['browserCheckout', 'capabilityId'],
    ['reauthRequest', 'id'],
    ['authAuditEvent', 'id'],
    ['authAuditEvent', 'entityId'],
  ]) {
    assert.equal(brokerSchema.$defs[definition].properties[property].$ref, '#/$defs/opaqueId');
  }
  assert.deepEqual(brokerSchema.$defs.browserCheckout.required, ['capabilityId', 'publicIdentity']);
  assert.equal('identityReadback' in brokerSchema.$defs.browserCompleteRequest.properties, false);
  assert.deepEqual(
    Object.keys(brokerSchema.$defs.leaseExecuteResponse.properties.execution.properties).sort(),
    ['exitCode', 'generation', 'outcome', 'signal'],
  );
  assert.equal(brokerSchema.$defs.reauthRequest.properties.state.const, 'HUMAN_REAUTH_REQUIRED');
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

  for (const schema of [policySchema, leaseSchema]) {
    const exactOrigin = new RegExp(schema.$defs.exactHttpsOrigin.pattern);
    assert.equal(exactOrigin.test('https://console.example.com'), true);
    assert.equal(exactOrigin.test('http://console.example.com'), false);
    assert.equal(exactOrigin.test('https://console.example.com/'), false);
    assert.equal(exactOrigin.test('https://console.example.com/login'), false);
    assert.equal(exactOrigin.test('https://console.example.com.evil.test/path'), false);
  }
});

test('Kubernetes examples contain no secret value and grant workers no API rules', async () => {
  const rbac = await read('k8s/rbac.yaml');
  const networkPolicy = await read('k8s/network-policy.yaml');
  const sidecar = await read('k8s/local-sidecar-pod.yaml');
  const securityModel = await read('docs/security-model.md');
  const workerRole = rbac.match(
    /name: seori-auth-worker-no-kubernetes-api\n  namespace: seori-auth-workloads\nrules: \[\]/,
  );

  assert.ok(workerRole, 'worker role must remain empty');
  assert.match(rbac, /^# NON-DEPLOYABLE REFERENCE\./);
  assert.doesNotMatch(rbac, /^\s*(data|stringData):/m);
  assert.match(rbac, /resourceNames: \["seori-auth-execution-copy"\]/);
  assert.doesNotMatch(rbac, /verbs: \["(?:list|watch)"\]/);
  assert.match(networkPolicy, /name: seori-auth-broker-default-deny/);
  assert.match(networkPolicy, /^# NON-DEPLOYABLE REFERENCE\./);
  assert.match(networkPolicy, /ingress: \[\]\n  egress: \[\]/);
  assert.doesNotMatch(networkPolicy, /protocol: TCP|port: 8443/);
  assert.match(sidecar, /mountPath: \/run\/seori-auth/);
  assert.match(sidecar, /persistentVolumeClaim:\n        claimName: seori-auth-state/);
  assert.match(sidecar, /automountServiceAccountToken: false/);
  assert.doesNotMatch(sidecar, /^\s*(data|stringData):/m);
  assert.match(sidecar, /seorilabs\.io\/deployable: "false"/);
  const worker = sidecar.slice(sidecar.indexOf('    - name: worker')).split('\n  volumes:')[0];
  assert.doesNotMatch(worker, /broker-api-token|broker-state/);
  assert.match(securityModel, /authenticatePrincipal\(socket\)/);
  assert.match(securityModel, /RLIMIT_CORE=0/);
  assert.match(securityModel, /broker-held MAC\/hash chain/);
  assert.match(securityModel, /Browser Vault provider adapter/);
});

test('local daemon declares only the five approved POST route shapes and no secret getter route', async () => {
  const daemonSource = await read('src/local-daemon.mjs');
  const routeLiterals = [...daemonSource.matchAll(/url\.pathname === '([^']+)'/g)].map((match) => match[1]);
  const routePatterns = [...daemonSource.matchAll(/url\.pathname\.match\((\/\^.*\$\/)\)/g)].map((match) => match[1]);

  assert.deepEqual(routeLiterals, ['/auth/leases', '/auth/reauth-requests']);
  assert.equal(routePatterns.length, 3);
  assert.match(routePatterns[0], /auth\\\/leases/);
  assert.match(routePatterns[1], /browser-sessions/);
  assert.match(routePatterns[2], /browser-sessions/);
  assert.doesNotMatch(daemonSource, /\/auth\/(?:secrets|export|print|credentials)/);
  assert.doesNotMatch(daemonSource, /authorization|bearer/i);
  assert.match(daemonSource, /#authenticatePrincipal/);
  assert.doesNotMatch(daemonSource, /\.listen\(\s*\d|hostname|host:/);
});
