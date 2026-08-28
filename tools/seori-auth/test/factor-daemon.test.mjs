import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FactorHttpApplication,
  SecretManagerPasswordLoader,
  TrustedAdapterRegistry,
} from '../src/index.mjs';
import { makeNativeLauncher } from '../fixtures/helpers.mjs';

const brokerSpiffeId = 'spiffe://seorilabs.local/ns/auth-broker/sa/auth-broker';
const sink = fileURLToPath(new URL('../runtime/canary-secret-sink.mjs', import.meta.url));

function fakeTlsSocket() {
  return {
    encrypted: true,
    authorized: true,
    getPeerCertificate() {
      return { subjectaltname: `URI:${brokerSpiffeId}` };
    },
  };
}

function request(path, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = 'POST';
  stream.url = path;
  stream.headers = { 'content-type': 'application/json' };
  Object.defineProperty(stream, 'socket', { value: fakeTlsSocket() });
  return stream;
}

async function dispatch(application, path, body) {
  return new Promise((resolve, reject) => {
    const response = {
      headersSent: false,
      writeHead(status, headers) {
        this.headersSent = true;
        this.status = status;
        this.headers = headers;
      },
      end(encoded = '') {
        resolve({ status: this.status, headers: this.headers, body: String(encoded) });
      },
      destroy() {
        reject(new Error('response destroyed'));
      },
    };
    application.dispatch(request(path, body), response).catch(reject);
  });
}

function input(invocationId = 'factor-invocation-0001') {
  return {
    adapterId: 'password-injector',
    invocationId,
    executionBinding: {
      subject: 'k8s:release-workers:worker-a',
      runId: 'github:123',
      repository: 'seorilabs/example-app',
      workerId: 'worker-a',
    },
    binding: {
      credentialRef: 'shared/apps-in-toss/bot-password',
      credentialGeneration: 4,
      provider: 'apps-in-toss',
      accountId: 'automation-account',
    },
  };
}

test('password factor route injects one execution copy and returns no secret material', async () => {
  const source = Buffer.from('FAKE_PASSWORD_FACTOR_CANARY_20260828');
  let loads = 0;
  const factor = new SecretManagerPasswordLoader({
    bindings: [{
      ...input().binding,
      factor: 'password',
    }],
    loadSecret: async () => {
      loads += 1;
      return source;
    },
  });
  const registry = new TrustedAdapterRegistry([{
    id: 'password-injector',
    executable: process.execPath,
    providers: ['apps-in-toss'],
    capabilities: ['browser.password.inject'],
    credentialDelivery: 'fd3',
    launcher: await makeNativeLauncher(),
    buildArgs: () => [sink],
  }]);
  const application = new FactorHttpApplication({
    kind: 'password',
    factor,
    registry,
    allowedBrokerSpiffeIds: [brokerSpiffeId],
    clock: () => 1_700_000_000_000,
  });

  const first = await dispatch(application, '/internal/factors/password/execute', input());
  const replay = await dispatch(application, '/internal/factors/password/execute', input());
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), {
    execution: { outcome: 'SUCCESS', exitCode: 0, signal: null },
  });
  assert.equal(replay.body, first.body);
  assert.equal(loads, 1);
  assert.ok(source.every((byte) => byte === 0));
  assert.doesNotMatch(first.body, /FAKE_PASSWORD_FACTOR_CANARY|credentialRef|resourceName/);
});

test('factor service exposes no read, export, or wrong-factor route', async () => {
  let loads = 0;
  const factor = {
    async loadPassword() {
      loads += 1;
      return Buffer.from('must-never-be-loaded');
    },
  };
  const registry = new TrustedAdapterRegistry([{
    id: 'password-injector',
    executable: process.execPath,
    providers: ['apps-in-toss'],
    capabilities: ['browser.password.inject'],
    credentialDelivery: 'fd3',
    launcher: await makeNativeLauncher(),
    buildArgs: () => [sink],
  }]);
  const application = new FactorHttpApplication({
    kind: 'password', factor, registry, allowedBrokerSpiffeIds: [brokerSpiffeId],
  });

  for (const path of [
    '/internal/factors/password',
    '/internal/factors/password/export',
    '/internal/factors/totp/execute',
    '/internal/factors/password/execute?resource=anything',
  ]) {
    const response = await dispatch(application, path, input(`denied-${loads}-${path.length}`));
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), { error: { code: 'route_not_found' } });
  }
  assert.equal(loads, 0);
});

test('factor execution copy is zeroized when adapter lookup fails before spawn', async () => {
  const executionCopy = Buffer.from('FAKE_UNTRUSTED_ADAPTER_CANARY_20260828');
  const application = new FactorHttpApplication({
    kind: 'password',
    factor: { async loadPassword() { return executionCopy; } },
    registry: new TrustedAdapterRegistry([]),
    allowedBrokerSpiffeIds: [brokerSpiffeId],
  });
  const denied = input('factor-invocation-untrusted-adapter');
  denied.adapterId = 'not-registered';
  const response = await dispatch(application, '/internal/factors/password/execute', denied);
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { error: { code: 'adapter_not_trusted' } });
  assert.ok(executionCopy.every((byte) => byte === 0));
  assert.doesNotMatch(response.body, /FAKE_UNTRUSTED_ADAPTER_CANARY/);
});
