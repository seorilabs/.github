import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PolicyEngine,
  validMacOsCanonicalFilePath,
  validMacOsId,
  validMacOsUnixSocketPath,
} from '../src/index.mjs';

const packageRoot = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, packageRoot), 'utf8');
}

test('example policy and JSON schemas are parseable', async () => {
  const policy = JSON.parse(await read('policy/example.policy.json'));
  const policySchema = JSON.parse(await read('schemas/policy.schema.json'));
  const leaseSchema = JSON.parse(await read('schemas/lease-request.schema.json'));
  const brokerSchema = JSON.parse(await read('schemas/local-broker.schema.json'));
  const agentRelaySchema = JSON.parse(await read('schemas/agent-relay-config.schema.json'));

  assert.equal(new PolicyEngine(policy).generation, 1);
  assert.equal(policySchema.additionalProperties, false);
  assert.equal(leaseSchema.additionalProperties, false);
  assert.equal(leaseSchema.properties.redirectOrigins.uniqueItems, true);
  assert.equal('accountKind' in leaseSchema.properties, false);
  assert.equal(leaseSchema.required.includes('accountId'), true);
  assert.equal(leaseSchema.required.includes('approval'), true);
  assert.equal(policySchema.required.includes('accounts'), true);
  assert.deepEqual(
    policySchema.properties.rules.items.properties.approvals.items.required,
    ['id', 'mode', 'expiresAt', 'maxUses'],
  );
  assert.equal(policySchema.properties.rules.items.required.includes('authStrategies'), true);
  assert.equal(policySchema.properties.rules.items.required.includes('actionClass'), true);
  assert.equal(
    policySchema.properties.rules.items.properties.actionClass.enum.includes('public_release'),
    true,
  );
  assert.deepEqual(brokerSchema.$defs.leaseCreateRequest.required, ['idempotencyKey', 'workerId', 'request']);
  assert.equal(brokerSchema.$defs.executionBinding.additionalProperties, false);
  assert.equal(brokerSchema.oneOf.length, 5);
  assert.equal(agentRelaySchema.additionalProperties, false);
  assert.equal(agentRelaySchema.properties.schemaVersion.const, 2);
  assert.equal(agentRelaySchema.required.includes('controlPlane'), true);
  assert.equal(agentRelaySchema.properties.controlPlane.additionalProperties, false);
  assert.equal(
    agentRelaySchema.properties.controlPlane.properties.configRevision.properties.revision.maximum,
    Number.MAX_SAFE_INTEGER,
  );
  assert.deepEqual(agentRelaySchema.properties.workerKind.enum, ['CODEX', 'CLAUDE']);
  const socketSchema = agentRelaySchema.properties.socketPath;
  const socketPattern = new RegExp(socketSchema.pattern);
  const schemaAcceptsSocket = (value) =>
    socketPattern.test(value) && [...value].length <= socketSchema.maxLength;
  for (const socketPath of [
    '/private/var/run/seori-auth-agent/codex/relay.sock',
    `/tmp/${'a'.repeat(99)}`,
  ]) {
    assert.equal(Buffer.byteLength(socketPath, 'utf8') <= 104, true, socketPath);
    assert.equal(schemaAcceptsSocket(socketPath), true, socketPath);
    assert.equal(validMacOsUnixSocketPath(socketPath), true, socketPath);
  }
  for (const socketPath of [
    `/tmp/${'a'.repeat(100)}`,
    `/tmp/${'가'.repeat(34)}`,
  ]) {
    assert.equal(Buffer.byteLength(socketPath, 'utf8') > 104, true, socketPath);
    assert.equal(schemaAcceptsSocket(socketPath), false, socketPath);
    assert.equal(validMacOsUnixSocketPath(socketPath), false, socketPath);
  }
  for (const socketPath of [
    '/private/var/run/relay/../relay.sock',
    '/private//var/run/relay.sock',
    '/private/var/run/relay/',
    '/./relay.sock',
  ]) {
    assert.equal(schemaAcceptsSocket(socketPath), false, socketPath);
    assert.equal(validMacOsUnixSocketPath(socketPath), false, socketPath);
  }
  assert.equal(agentRelaySchema.properties.expectedPeer.properties.uid.minimum, 1);
  assert.equal(agentRelaySchema.properties.expectedPeer.properties.uid.maximum, 2_147_483_647);
  assert.equal(agentRelaySchema.properties.expectedPeer.properties.gid.maximum, 2_147_483_647);
  assert.equal(validMacOsId(2_147_483_647), true);
  assert.equal(validMacOsId(2_147_483_648), false);
  const materialPathSchema = agentRelaySchema.$defs.canonicalAbsoluteFilePath;
  const materialPathPattern = new RegExp(materialPathSchema.pattern);
  const schemaAcceptsMaterialPath = (value) =>
    materialPathPattern.test(value) && [...value].length <= materialPathSchema.maxLength;
  for (const path of [
    '/opt/seori-auth/bin/seori-auth-native',
    '/private/etc/seori auth/codex/.client-key.pem',
  ]) {
    assert.equal(schemaAcceptsMaterialPath(path), true, path);
    assert.equal(validMacOsCanonicalFilePath(path), true, path);
  }
  for (const path of [
    '/opt/seori-auth/../seori-auth/bin/helper',
    '/private/etc//seori/key.pem',
    '/private/etc/seori/',
    '/./private/key.pem',
    `/private/etc/${'가'.repeat(600)}/key.pem`,
    `/${'a'.repeat(1_024)}`,
  ]) {
    assert.equal(schemaAcceptsMaterialPath(path), false, path);
    assert.equal(validMacOsCanonicalFilePath(path), false, path);
  }
  assert.equal(
    agentRelaySchema.properties.nativeHelper.properties.path.$ref,
    '#/$defs/canonicalAbsoluteFilePath',
  );
  for (const property of ['caPath', 'certificatePath', 'privateKeyPath']) {
    assert.equal(
      agentRelaySchema.properties.upstream.properties.tls.properties[property].$ref,
      '#/$defs/canonicalAbsoluteFilePath',
      property,
    );
  }
  assert.equal(agentRelaySchema.properties.upstream.properties.tls.additionalProperties, false);
  const relayOriginPatterns = agentRelaySchema.properties.upstream.properties.origin.oneOf
    .map(({ pattern }) => new RegExp(pattern));
  const relayOrigin = (value) => relayOriginPatterns.some((pattern) => pattern.test(value));
  for (const origin of [
    'https://relay.example.com',
    'https://relay.example.com:1',
    'https://127.0.0.1:443',
    'https://[::1]:65535',
    'https://[2001:db8:85a3::8a2e:370:7334]:9443',
  ]) {
    assert.equal(relayOrigin(origin), true, origin);
    assert.doesNotThrow(() => new URL(origin), origin);
  }
  for (const origin of [
    'https://relay.example.com:0',
    'https://relay.example.com:65536',
    'https://relay.example.com:99999',
    'https://999.999.999.999:443',
    'https://[:::]:443',
    'https://[1:2:3]:443',
  ]) assert.equal(relayOrigin(origin), false, origin);
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
    ['authAuditEvent', 'leaseId'],
  ]) {
    assert.equal(brokerSchema.$defs[definition].properties[property].$ref, '#/$defs/opaqueId');
  }
  assert.deepEqual(brokerSchema.$defs.browserCheckout.required, ['capabilityId', 'publicIdentity']);
  assert.deepEqual(
    brokerSchema.$defs.browserCheckoutRequest.required,
    [
      'context', 'executionBinding', 'expectedLeaseGeneration', 'expectedProfileGeneration',
      'expectedSessionGeneration', 'expectedIdentity', 'leaseId', 'role', 'workerId',
    ],
  );
  assert.deepEqual(
    brokerSchema.$defs.browserCompleteRequest.required,
    [
      'capabilityId', 'context', 'executionBinding', 'expectedGeneration', 'leaseId',
      'profileGeneration', 'role', 'workerId',
    ],
  );
  assert.equal('identityReadback' in brokerSchema.$defs.browserCompleteRequest.properties, false);
  assert.deepEqual(
    Object.keys(brokerSchema.$defs.leaseExecuteResponse.properties.execution.properties).sort(),
    ['exitCode', 'generation', 'outcome', 'signal'],
  );
  assert.equal(brokerSchema.$defs.reauthRequest.properties.state.const, 'HUMAN_REAUTH_REQUIRED');
  assert.equal(brokerSchema.$defs.authAuditEvent.properties.commitSha.pattern, '^[0-9a-f]{40}$');
  assert.equal(brokerSchema.$defs.authAuditEvent.properties.capabilityId.$ref, '#/$defs/opaqueId');
  assert.equal(brokerSchema.$defs.authAuditEvent.properties.ruleId.$ref, '#/$defs/publicId');
  assert.equal(brokerSchema.$defs.authAuditEvent.properties.idempotencyKey.$ref, '#/$defs/publicId');
  assert.equal(brokerSchema.$defs.authAuditEvent.properties.authStrategyIndex.minimum, 0);
  assert.equal(
    brokerSchema.$defs.authAuditEvent.properties.strategyEvidenceKey.pattern,
    '^[0-9a-f]{64}$',
  );
  assert.equal(brokerSchema.$defs.browserSessionBinding.properties.state.enum.includes('CLAIMED'), true);
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
  const cleanupScript = await read('scripts/cleanup-browser-runtime.mjs');
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
  assert.match(securityModel, /broker-held key.*schema v2 HMAC\/hash chain/s);
  assert.match(securityModel, /`EncryptedBrowserVault`/);
  assert.match(securityModel, /advisory lock/);
  assert.match(cleanupScript, /EncryptedBrowserVault\.cleanupRuntime/);
  assert.doesNotMatch(cleanupScript, /loadSecret|get-secret|print-secret|copy-password/);
});

test('legacy production Kubernetes paths cannot deploy stale placeholder objects', async () => {
  const namespaceRbac = await read('k8s/production/namespace-rbac.yaml');
  const networkPolicy = await read('k8s/production/network-policy.yaml');
  const workloads = await read('k8s/production/workloads.yaml');
  const stalePlaceholder = new RegExp(['REPLACE', ''].join('_'));
  for (const content of [namespaceRbac, networkPolicy, workloads]) {
    assert.match(content, /^# LEGACY PATH/);
    assert.match(content, /render-production-k8s\.mjs/);
    assert.doesNotMatch(content, /^(?:apiVersion|kind):/m);
    assert.doesNotMatch(content, stalePlaceholder);
    assert.doesNotMatch(content, /example\.invalid|@sha256:/);
  }
});

test('local daemon keeps the five public auth route shapes and isolates provider control-plane routes', async () => {
  const daemonSource = await read('src/local-daemon.mjs');
  const routeLiterals = [...daemonSource.matchAll(/url\.pathname === '([^']+)'/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith('/auth/'));
  const routePatterns = [...daemonSource.matchAll(/url\.pathname\.match\((\/\^.*\$\/)\)/g)]
    .map((match) => match[1])
    .filter((pattern) => pattern.includes('auth\\/'));

  assert.deepEqual(routeLiterals, ['/auth/leases', '/auth/reauth-requests']);
  assert.equal(routePatterns.length, 3);
  assert.match(routePatterns[0], /auth\\\/leases/);
  assert.match(routePatterns[1], /browser-sessions/);
  assert.match(routePatterns[2], /browser-sessions/);
  assert.doesNotMatch(daemonSource, /\/auth\/(?:secrets|export|print|credentials)/);
  assert.doesNotMatch(daemonSource, /request\.headers\[['"]authorization['"]\]|bearer/i);
  assert.match(daemonSource, /#authenticatePrincipal/);
  assert.match(daemonSource, /PROVIDER_CONTROL_PLANE_ENDPOINT_SCOPE/);
  assert.match(daemonSource, /#authorizeProviderControlPlanePeer/);
  assert.doesNotMatch(daemonSource, /\/auth\/(?:policy-grants|provider-grants)/);
  assert.doesNotMatch(daemonSource, /\.listen\(\s*\d|hostname|host:/);
});
