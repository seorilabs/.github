import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  AgentRelayDaemon,
  assertAgentRelayPublicJson,
  createAgentMtlsForwarder,
  NativeSecurityBoundary,
  SeoriAuthError,
} from '../src/index.mjs';

const helper = new URL('../.build/seori-auth-native', import.meta.url).pathname;

function post(socketPath, body, { method = 'POST', path = '/v1/execute', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8');
    const request = httpRequest({
      socketPath,
      method,
      path,
      headers: {
        'content-type': 'application/json',
        'content-length': String(encoded.length),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const payload = Buffer.concat(chunks);
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(payload.toString('utf8')) });
        } catch (error) {
          reject(error);
        } finally {
          payload.fill(0);
          chunks.forEach((entry) => entry.fill(0));
        }
      });
    });
    request.once('error', reject);
    request.end(encoded, () => encoded.fill(0));
  });
}

test('agent relay binds one Unix peer to a private socket and forwards public JSON only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seori-agent-relay-')));
  await chmod(root, 0o700);
  const socketPath = join(root, 'worker.sock');
  const helperDigest = createHash('sha256').update(await readFile(helper)).digest('hex');
  let forwarded = 0;
  let closed = 0;
  const nativeBoundary = await NativeSecurityBoundary.open({
    helperPath: helper,
    expectedSha256: helperDigest,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
    resolvePrincipal: async () => assert.fail('agent relay must use peer attestation without body principal resolution'),
  });
  const forwarder = {
    async forward(body) {
      forwarded += 1;
      assert.deepEqual(body, { body: { leaseSeconds: 300 }, operation: 'CLAIM' });
      return {
        statusCode: 200,
        body: Buffer.from(`${JSON.stringify({ claim: null, ok: true })}\n`, 'utf8'),
      };
    },
    close() {
      closed += 1;
    },
  };
  const daemon = new AgentRelayDaemon({
    socketPath,
    expectedPeerUid: process.getuid(),
    expectedPeerGid: process.getgid(),
    nativeBoundary,
    forwarder,
  });
  try {
    assert.deepEqual(await daemon.start(), { transport: 'unix', socketPath });
    const [directory, socket] = await Promise.all([stat(root), stat(socketPath)]);
    assert.equal(directory.mode & 0o777, 0o711);
    assert.equal(socket.mode & 0o777, 0o600);
    assert.equal(socket.uid, process.getuid());
    assert.equal(socket.gid, process.getgid());

    const success = await post(socketPath, { operation: 'CLAIM', body: { leaseSeconds: 300 } });
    assert.deepEqual(success, { statusCode: 200, body: { claim: null, ok: true } });
    assert.equal(forwarded, 1);

    const credentialHeader = await post(
      socketPath,
      { operation: 'CLAIM', body: { leaseSeconds: 300 } },
      { headers: { authorization: 'fake-secret-canary' } },
    );
    assert.deepEqual(credentialHeader, {
      statusCode: 400,
      body: { error: { code: 'agent_relay_secret_field_rejected' } },
    });

    const secretField = await post(socketPath, {
      operation: 'COMPLETE',
      body: { leaseToken: 'fake-secret-canary' },
    });
    assert.deepEqual(secretField, {
      statusCode: 400,
      body: { error: { code: 'agent_relay_secret_field_rejected' } },
    });
    assert.doesNotMatch(JSON.stringify(secretField), /fake-secret-canary/);
    assert.equal(forwarded, 1);

    const wrongPath = await post(socketPath, {}, { path: '/auth/leases' });
    assert.deepEqual(wrongPath, { statusCode: 404, body: { error: { code: 'route_not_found' } } });
  } finally {
    await daemon.stop();
    assert.equal(closed, 1);
    await assert.rejects(stat(socketPath), { code: 'ENOENT' });
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

function fakeHttpsRequest(responseBody, capture, statusCode = 200) {
  return (options, callback) => {
    capture.options = options;
    const request = new EventEmitter();
    request.end = (encoded) => {
      capture.requestBody = Buffer.from(encoded);
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.headers = { 'content-type': 'application/json; charset=utf-8' };
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(responseBody, 'utf8'));
        response.emit('end');
      });
    };
    request.destroy = (error) => request.emit('error', error ?? new Error('destroyed'));
    return request;
  };
}

async function tlsFiles(root) {
  const tls = {
    caPath: join(root, 'ca.pem'),
    certificatePath: join(root, 'tls.crt'),
    privateKeyPath: join(root, 'tls.key'),
  };
  await Promise.all([
    writeFile(tls.caPath, 'fake-ca-material', { mode: 0o600 }),
    writeFile(tls.certificatePath, 'fake-certificate-material', { mode: 0o600 }),
    writeFile(tls.privateKeyPath, 'fake-private-key-material', { mode: 0o600 }),
  ]);
  return tls;
}

test('agent relay normalizes conventional credential field names', () => {
  for (const key of ['accessToken', 'bearerToken', 'lease_token', 'clientCertificate']) {
    assert.throws(
      () => assertAgentRelayPublicJson({ [key]: 'fake-secret-canary' }),
      (error) => error instanceof SeoriAuthError && error.code === 'agent_relay_secret_field_rejected',
      key,
    );
  }
  assert.deepEqual(assertAgentRelayPublicJson({ tokenPagination: { nextPageTokenPresent: true } }), {
    tokenPagination: { nextPageTokenPresent: true },
  });
});

test('mTLS forwarder rejects writable trust and client certificate files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seori-agent-forwarder-mode-')));
  try {
    for (const target of ['caPath', 'certificatePath']) {
      const tls = await tlsFiles(root);
      await chmod(tls[target], 0o620);
      await assert.rejects(
        createAgentMtlsForwarder({
          origin: 'https://127.0.0.1:19443',
          serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
          tls,
        }),
        (error) => error instanceof SeoriAuthError && error.code === 'invalid_agent_relay_tls',
        target,
      );
      await chmod(tls[target], 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mTLS forwarder fixes the upstream origin and rejects credential-shaped responses', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seori-agent-forwarder-')));
  try {
    const tls = await tlsFiles(root);
    const capture = {};
    const forwarder = await createAgentMtlsForwarder({
      origin: 'https://127.0.0.1:19443',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      tls,
      requestImpl: fakeHttpsRequest(JSON.stringify({ ok: true, sessionId: 'agent-session:public' }), capture),
    });
    const result = await forwarder.forward({ body: { leaseSeconds: 300 }, operation: 'CLAIM' });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body.toString('utf8')), {
      ok: true,
      sessionId: 'agent-session:public',
    });
    assert.equal(capture.options.hostname, '127.0.0.1');
    assert.equal(capture.options.port, 19_443);
    assert.equal(capture.options.servername, 'seori-auth-agent-runtime.auth-broker.svc.cluster.local');
    assert.equal(capture.options.path, '/v1/execute');
    assert.equal(capture.options.minVersion, 'TLSv1.3');
    assert.equal(capture.options.maxVersion, 'TLSv1.3');
    assert.deepEqual(JSON.parse(capture.requestBody.toString('utf8')), {
      body: { leaseSeconds: 300 },
      operation: 'CLAIM',
    });
    capture.requestBody.fill(0);
    result.body.fill(0);
    forwarder.close();
    await assert.rejects(
      forwarder.forward({ operation: 'CLAIM' }),
      (error) => error instanceof SeoriAuthError && error.code === 'agent_relay_closed',
    );

    const secretResponseForwarder = await createAgentMtlsForwarder({
      origin: 'https://127.0.0.1:19443',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      tls,
      requestImpl: fakeHttpsRequest(JSON.stringify({ leaseToken: 'fake-secret-canary' }), {}),
    });
    await assert.rejects(
      secretResponseForwarder.forward({ operation: 'CLAIM' }),
      (error) => {
        assert.ok(error instanceof SeoriAuthError);
        assert.equal(error.code, 'agent_relay_secret_field_rejected');
        assert.doesNotMatch(error.message, /fake-secret-canary/);
        return true;
      },
    );
    secretResponseForwarder.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mTLS forwarder converts upstream response stream errors into a stable rejection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seori-agent-forwarder-error-')));
  try {
    const tls = await tlsFiles(root);
    const requestImpl = (_options, callback) => {
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        callback(response);
        queueMicrotask(() => {
          response.emit('data', Buffer.from('{"ok":', 'utf8'));
          response.emit('error', new Error('fake upstream reset containing fake-secret-canary'));
        });
      };
      request.destroy = (error) => request.emit('error', error ?? new Error('destroyed'));
      return request;
    };
    const forwarder = await createAgentMtlsForwarder({
      origin: 'https://127.0.0.1:19443',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      tls,
      requestImpl,
    });
    await assert.rejects(
      forwarder.forward({ operation: 'CLAIM' }),
      (error) => {
        assert.ok(error instanceof SeoriAuthError);
        assert.equal(error.code, 'agent_relay_upstream_rejected');
        assert.doesNotMatch(error.message, /fake-secret-canary/);
        return true;
      },
    );
    forwarder.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
