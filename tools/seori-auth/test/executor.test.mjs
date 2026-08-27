import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as publicApi from '../src/index.mjs';
import { SeoriAuthBroker, SeoriAuthError, TrustedAdapterRegistry } from '../src/index.mjs';
import { makePolicy, makeRequest } from '../fixtures/helpers.mjs';

const fixture = fileURLToPath(new URL('../fixtures/echo-secret-child.mjs', import.meta.url));

function testAdapter(overrides = {}) {
  return {
    id: 'test-adapter',
    executable: process.execPath,
    providers: ['apps-in-toss'],
    capabilities: ['ait.bundle.upload.private'],
    credentialDelivery: 'fd3',
    buildArgs: () => [fixture],
    ...overrides,
  };
}

test('secret is injected through fd3 and removed from returned outputs and audit', async () => {
  const canary = 'canary-password-value';
  const secretBuffer = Buffer.from(canary);
  const auditEvents = [];
  const request = makeRequest();
  const broker = new SeoriAuthBroker({
    policy: makePolicy(),
    adapters: [testAdapter()],
    loadSecret: async () => secretBuffer,
    onAudit: (event) => auditEvents.push(event),
  });
  const lease = broker.issueLease(request);

  const result = await broker.execute({
    leaseId: lease.leaseId,
    context: request,
    currentCredentialGeneration: request.credentialGeneration,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, new RegExp(canary));
  assert.doesNotMatch(result.stderr, new RegExp(canary));
  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(canary));
  assert.ok(secretBuffer.every((byte) => byte === 0), 'secret buffer must be zeroed after execution');
});

test('secret loader error details are not returned and consumed lease cannot retry', async () => {
  const canary = 'loader-error-secret';
  const request = makeRequest();
  const broker = new SeoriAuthBroker({
    policy: makePolicy(),
    adapters: [testAdapter()],
    loadSecret: async () => {
      throw new Error(canary);
    },
  });
  const lease = broker.issueLease(request);

  await assert.rejects(
    broker.execute({
      leaseId: lease.leaseId,
      context: request,
      currentCredentialGeneration: request.credentialGeneration,
    }),
    (error) =>
      error instanceof SeoriAuthError &&
      error.code === 'secret_load_failed' &&
      !error.message.includes(canary),
  );
  await assert.rejects(
    broker.execute({
      leaseId: lease.leaseId,
      context: request,
      currentCredentialGeneration: request.credentialGeneration,
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'lease_already_used',
  );
});

test('registry rejects relative executables and secret-shaped environment fields', () => {
  assert.throws(
    () => new TrustedAdapterRegistry([testAdapter({ executable: 'node' })]),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_adapter',
  );
  assert.throws(
    () => new TrustedAdapterRegistry([testAdapter({ environment: { API_TOKEN: 'not-even-a-real-secret' } })]),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_adapter',
  );
});

test('public API has no secret getter or exporter', () => {
  assert.deepEqual(
    Object.keys(publicApi).filter((name) => /(get|read|export).*secret|secret.*(get|read|export)/i.test(name)),
    [],
  );
  assert.deepEqual(
    Object.getOwnPropertyNames(SeoriAuthBroker.prototype).sort(),
    ['constructor', 'execute', 'issueLease'],
  );
  const broker = new SeoriAuthBroker({
    policy: makePolicy(),
    adapters: [testAdapter()],
    loadSecret: async () => Buffer.from('not-read'),
  });
  assert.deepEqual(Object.keys(broker), []);
});
