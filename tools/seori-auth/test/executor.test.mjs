import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as publicApi from '../src/index.mjs';
import { SeoriAuthBroker, SeoriAuthError, TrustedAdapterRegistry } from '../src/index.mjs';
import { makeNativeLauncher, makePolicy, makeRequest } from '../fixtures/helpers.mjs';

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

test('secret is injected through fd3 while all child output channels are discarded', async () => {
  const canary = 'canary-password-value';
  const secretBuffer = Buffer.from(canary);
  const auditEvents = [];
  const request = makeRequest();
  const broker = new SeoriAuthBroker({
    policy: makePolicy(),
    adapters: [testAdapter({ launcher: await makeNativeLauncher() })],
    loadSecret: async () => secretBuffer,
    onAudit: (event) => auditEvents.push(event),
  });
  const lease = broker.issueLease(request, { idempotencyKey: 'executor-success' });

  const result = await broker.execute({
    leaseId: lease.leaseId,
    context: request,
    currentCredentialGeneration: request.credentialGeneration,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(result).sort(), ['exitCode', 'signal']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(Buffer.from(canary).toString('base64')));
  assert.doesNotMatch(JSON.stringify(auditEvents), new RegExp(canary));
  assert.ok(secretBuffer.every((byte) => byte === 0), 'secret buffer must be zeroed after execution');
});

test('secret loader error details are not returned and consumed lease cannot retry', async () => {
  const canary = 'loader-error-secret';
  const request = makeRequest();
  const broker = new SeoriAuthBroker({
    policy: makePolicy(),
    adapters: [testAdapter({ launcher: await makeNativeLauncher() })],
    loadSecret: async () => {
      throw new Error(canary);
    },
  });
  const lease = broker.issueLease(request, { idempotencyKey: 'executor-loader-error' });

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

test('invalid secret loader output preserves the intended non-secret error', async () => {
  const request = makeRequest();
  const broker = new SeoriAuthBroker({
    policy: makePolicy(),
    adapters: [testAdapter({ launcher: await makeNativeLauncher() })],
    loadSecret: async () => undefined,
  });
  const lease = broker.issueLease(request, { idempotencyKey: 'executor-invalid-loader' });

  await assert.rejects(
    broker.execute({
      leaseId: lease.leaseId,
      context: request,
      currentCredentialGeneration: request.credentialGeneration,
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'secret_load_failed',
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
  assert.throws(
    () => new TrustedAdapterRegistry([testAdapter()]),
    (error) => error instanceof SeoriAuthError && error.code === 'native_launcher_required',
  );
  assert.throws(
    () => new SeoriAuthBroker({
      policy: makePolicy(),
      adapters: [testAdapter()],
      loadSecret: async () => Buffer.from('unused'),
      requireNativeLauncher: false,
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'native_launcher_required',
  );
  assert.throws(
    () => new TrustedAdapterRegistry([testAdapter({
      launcher: { executable: '/tmp/forged-launcher', mode: 'non-dumpable-v1' },
    })]),
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
    adapters: [],
    loadSecret: async () => Buffer.from('not-read'),
  });
  assert.deepEqual(Object.keys(broker), []);
});
