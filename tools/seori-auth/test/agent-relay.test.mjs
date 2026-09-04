import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  AgentRelayDaemon,
  agentRelayProjectionDigest,
  assertAgentRelayProjection,
  assertAgentRelayClientSocket,
  assertAgentRelayPublicRequest,
  assertAgentRelayPublicResponse,
  createAgentMtlsForwarder,
  executeAgentRelayClientRequest,
  NativeSecurityBoundary,
  readImmutableAgentRelayConfig,
  runAgentRelayLifecycle,
  SeoriAuthError,
} from '../src/index.mjs';

const helper = new URL('../.build/seori-auth-native', import.meta.url).pathname;

function publicRequest(operation, body, suffix = 'test') {
  return { requestId: `relay-request:${operation.toLowerCase()}:${suffix}`, operation, body };
}

function publicResult(outcomeCode, extra = {}) {
  return { outcomeCode, summary: 'public result', costMicros: 0, ...extra };
}

function publicClaim(agentKind = 'CODEX') {
  return {
    sessionId: 'agent-session:123e4567-e89b-42d3-a456-426614174000',
    runId: 'agent-run:123e4567-e89b-42d3-a456-426614174000',
    repoFullName: 'seorilabs/example',
    issueNumber: 42,
    template: 'repo-task-autopilot-v1',
    agentKind,
    model: null,
    approvalPolicy: 'READY_PR',
    budgetCeilingMicros: 1_000_000,
    spentMicros: 0,
    remainingBudgetMicros: 1_000_000,
    taskInput: null,
    actionCapabilities: ['github.issue.read'],
    resumeMode: 'START',
    generation: 1,
    expiresAt: '2026-09-04T00:05:00.000Z',
    duplicate: false,
  };
}

function relayProjectionConfig() {
  const config = {
    schemaVersion: 2,
    controlPlane: {
      contractVersion: 'agent-relay-projection/v1',
      projectionId: 'agent-relay:codex:test',
      projectionDigest: '0'.repeat(64),
      configRevision: {
        appId: 'app-control-plane-test',
        id: 'config-revision-test',
        revision: 7,
        snapshotDigest: '1'.repeat(64),
      },
      discoveryObservation: {
        id: 'discovery-observation-test',
        sourceSha: '2'.repeat(40),
        payloadHash: '3'.repeat(64),
      },
      providerObservation: {
        id: 'provider-observation-test',
        payloadHash: '4'.repeat(64),
      },
    },
    workerKind: 'CODEX',
    socketPath: '/private/var/run/seori-auth-agent/codex/relay.sock',
    expectedPeer: { uid: 5010, gid: 5010 },
    nativeHelper: {
      path: '/opt/seori-auth/bin/seori-auth-native',
      sha256: '5'.repeat(64),
    },
    upstream: {
      origin: 'https://127.0.0.1:19443',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      tls: {
        caPath: '/private/etc/seori-auth-agent/codex/ca.pem',
        certificatePath: '/private/etc/seori-auth-agent/codex/tls.crt',
        privateKeyPath: '/private/etc/seori-auth-agent/codex/tls.key',
      },
    },
  };
  config.controlPlane.projectionDigest = agentRelayProjectionDigest(config);
  return config;
}

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
  const root = await realpath(await mkdtemp(join(homedir(), '.seori-agent-relay-')));
  await chmod(root, 0o711);
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
      assert.deepEqual(body, publicRequest('CLAIM', { leaseSeconds: 300 }));
      return {
        statusCode: 200,
        body: Buffer.from(`${JSON.stringify({ ok: true, result: { claim: null, ok: true } })}\n`, 'utf8'),
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
    await assertAgentRelayClientSocket(socketPath, {
      expectedDirectoryUid: process.getuid(),
      expectedSocketUid: process.getuid(),
      expectedSocketGid: process.getgid(),
    });
    await chmod(root, 0o700);
    await assert.rejects(
      assertAgentRelayClientSocket(socketPath, {
        expectedDirectoryUid: process.getuid(),
        expectedSocketUid: process.getuid(),
        expectedSocketGid: process.getgid(),
      }),
      (error) => error instanceof SeoriAuthError &&
        error.code === 'insecure_agent_relay_socket_directory',
    );
    await chmod(root, 0o711);

    const success = await post(socketPath, publicRequest('CLAIM', { leaseSeconds: 300 }));
    assert.deepEqual(success, {
      statusCode: 200,
      body: { ok: true, result: { claim: null, ok: true } },
    });
    assert.equal(forwarded, 1);

    const credentialHeader = await post(
      socketPath,
      publicRequest('CLAIM', { leaseSeconds: 300 }),
      { headers: { authorization: 'fake-secret-canary' } },
    );
    assert.deepEqual(credentialHeader, {
      statusCode: 400,
      body: { error: { code: 'agent_relay_secret_field_rejected' } },
    });

    const secretField = await post(socketPath, {
      ...publicRequest('COMPLETE', {
        sessionId: 'agent-session:public',
        result: publicResult('NO_CHANGES'),
      }),
      signedJwt: 'fake-secret-canary',
    });
    assert.deepEqual(secretField, {
      statusCode: 400,
      body: { error: { code: 'invalid_agent_relay_payload' } },
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

test('agent relay rejects excess in-flight work before peer attestation or body buffering', async () => {
  const root = await realpath(await mkdtemp(join(homedir(), '.seori-agent-relay-bound-')));
  await chmod(root, 0o700);
  const socketPath = join(root, 'worker.sock');
  let attestations = 0;
  let forwarded = 0;
  let releaseForwarding;
  let resolveSaturated;
  const forwardingGate = new Promise((resolve) => { releaseForwarding = resolve; });
  const saturated = new Promise((resolve) => { resolveSaturated = resolve; });
  const daemon = new AgentRelayDaemon({
    socketPath,
    expectedPeerUid: process.getuid(),
    expectedPeerGid: process.getgid(),
    nativeBoundary: {
      async attest() {
        attestations += 1;
        return { uid: process.getuid(), gid: process.getgid() };
      },
    },
    forwarder: {
      async forward() {
        forwarded += 1;
        if (forwarded === 2) resolveSaturated();
        await forwardingGate;
        return { statusCode: 200, body: Buffer.from('{"ok":true}\n', 'utf8') };
      },
      close() {},
    },
  });
  try {
    await daemon.start();
    const first = post(socketPath, publicRequest('CLAIM', {}, 'first'));
    const second = post(socketPath, publicRequest('HEARTBEAT', {
      sessionId: 'agent-session:public',
      leaseSeconds: 300,
    }, 'second'));
    await saturated;
    const excess = await post(socketPath, publicRequest('CLAIM', {}, 'excess'));
    assert.deepEqual(excess, {
      statusCode: 503,
      body: { error: { code: 'agent_relay_busy' } },
    });
    assert.equal(attestations, 2);
    assert.equal(forwarded, 2);
    releaseForwarding();
    assert.deepEqual(await Promise.all([first, second]), [
      { statusCode: 200, body: { ok: true } },
      { statusCode: 200, body: { ok: true } },
    ]);
  } finally {
    releaseForwarding?.();
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('agent relay clears buffered request chunks when body streaming aborts', async () => {
  const source = Buffer.from('{"signedJwt":"fake-secret-canary"', 'utf8');
  const originalBufferFrom = Buffer.from;
  let bufferedCopy;
  Buffer.from = function captureRequestCopy(value, ...args) {
    const copy = originalBufferFrom.call(Buffer, value, ...args);
    if (value === source) bufferedCopy = copy;
    return copy;
  };
  let forwarded = false;
  const daemon = new AgentRelayDaemon({
    socketPath: '/private/var/run/seori-auth-agent/codex/relay.sock',
    expectedPeerUid: 5010,
    expectedPeerGid: 5010,
    nativeBoundary: { async attest() { return { uid: 5010, gid: 5010 }; } },
    forwarder: {
      async forward() { forwarded = true; },
      close() {},
    },
  });
  const request = {
    method: 'POST',
    url: '/v1/execute',
    headers: {
      'content-type': 'application/json',
      'content-length': String(source.length + 1),
    },
    socket: {},
    async *[Symbol.asyncIterator]() {
      yield source;
      throw new Error('fake request reset containing fake-secret-canary');
    },
  };
  const response = {
    headersSent: false,
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    end(_encoded, callback) { callback?.(); },
    destroy() { this.destroyed = true; },
  };
  try {
    await daemon.dispatch(request, response);
  } finally {
    Buffer.from = originalBufferFrom;
    source.fill(0);
  }
  assert.equal(forwarded, false);
  assert.equal(response.statusCode, 500);
  assert.ok(bufferedCopy);
  assert.ok(bufferedCopy.every((byte) => byte === 0));
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

test('agent relay accepts only operation-specific public request and response fields', () => {
  const claim = publicRequest('CLAIM', { leaseSeconds: 300 });
  assert.deepEqual(assertAgentRelayPublicRequest(claim), claim);
  const response = { ok: true, result: { ok: true, claim: null } };
  assert.deepEqual(assertAgentRelayPublicResponse(response, 'CLAIM'), response);

  for (const key of ['signedJwt', 'jwtAssertion', 'clientAssertion', 'samlAssertion']) {
    assert.throws(
      () => assertAgentRelayPublicRequest({ ...claim, [key]: 'fake-secret-canary' }),
      (error) => error instanceof SeoriAuthError && error.code === 'invalid_agent_relay_payload',
      key,
    );
    assert.throws(
      () => assertAgentRelayPublicResponse({
        ok: true,
        result: { ok: true, claim: null, [key]: 'fake-secret-canary' },
      }, 'CLAIM'),
      (error) => error instanceof SeoriAuthError && error.code === 'agent_relay_upstream_rejected',
      key,
    );
  }

  assert.throws(
    () => assertAgentRelayPublicRequest(publicRequest('COMPLETE', {
      sessionId: 'agent-session:public',
      result: publicResult('NO_CHANGES'),
      leaseToken: 'fake-secret-canary',
    })),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_agent_relay_payload',
  );
  assert.throws(
    () => assertAgentRelayPublicResponse({ ok: true, result: { tokenPagination: {} } }, 'CLAIM'),
    (error) => error instanceof SeoriAuthError && error.code === 'agent_relay_upstream_rejected',
  );
});

test('agent relay public schemas cover every worker operation and known claim task', () => {
  const sessionId = 'agent-session:123e4567-e89b-42d3-a456-426614174000';
  const requests = [
    publicRequest('CLAIM', {}),
    publicRequest('HEARTBEAT', { sessionId, leaseSeconds: 60 }),
    publicRequest('COMPLETE', { sessionId, result: publicResult('NO_CHANGES') }),
    publicRequest('FAIL', { sessionId, result: publicResult('BLOCKED'), error: 'WORKER_FAILED' }),
    publicRequest('READBACK_REQUIRED', { sessionId, result: publicResult('RESULT_UNKNOWN') }),
    publicRequest('READBACK_RESOLVE', {
      sessionId,
      resolution: 'RESUME',
      result: publicResult('READBACK_CONFIRMED'),
    }),
    publicRequest('GITHUB_READY_PR', {
      sessionId,
      repoId: '1250442131',
      repoFullName: 'seorilabs/example',
      issueNumber: 42,
      sourceSha: '1'.repeat(40),
      title: '공개 PR',
      body: '공개 본문',
      commitMessage: 'fix: 공개 변경',
      files: [{ path: 'src/example.ts', contentBase64: Buffer.from('export {};\n').toString('base64') }],
    }),
    publicRequest('GITHUB_READY_PR_READBACK', { sessionId }),
  ];
  requests.forEach((request) => assert.equal(assertAgentRelayPublicRequest(request), request));

  const baseClaim = {
    sessionId,
    runId: 'agent-run:123e4567-e89b-42d3-a456-426614174000',
    repoFullName: 'seorilabs/example',
    issueNumber: 42,
    agentKind: 'CODEX',
    model: null,
    approvalPolicy: 'READY_PR',
    budgetCeilingMicros: 1_000_000,
    spentMicros: 0,
    remainingBudgetMicros: 1_000_000,
    actionCapabilities: [
      'github.issue.read',
      'github.pull_request.read',
      'provider.readback',
      'github.branch.write',
      'github.commit.write',
      'github.pull_request.create',
    ],
    resumeMode: 'START',
    generation: 1,
    expiresAt: '2026-09-04T00:05:00.000Z',
    duplicate: false,
  };
  const claims = [
    { ...baseClaim, template: 'repo-task-autopilot-v1', taskInput: null },
    {
      ...baseClaim,
      issueNumber: null,
      template: 'platform-fleet-reconcile-v1',
      taskInput: {
        schemaVersion: 1,
        kind: 'PLATFORM_SDK_UPDATE',
        planId: 'platform-plan:example',
        repoId: '1250442131',
        repoFullName: 'seorilabs/example',
        sourceSha: '1'.repeat(40),
        manifestDigest: '2'.repeat(64),
        releaseVersion: '0.6.8',
        releaseSourceSha: '3'.repeat(40),
        contractRevision: '4'.repeat(64),
        artifact: {
          kind: 'TYPESCRIPT',
          version: '0.6.8',
          digest: '5'.repeat(64),
          packageName: '@seorilabs/platform',
        },
        pullRequestMarker: `<!-- seorilabs-platform-fleet:${'6'.repeat(64)}:1250442131 -->`,
        requiredChecks: ['test:core', 'repo-contract'],
      },
    },
    {
      ...baseClaim,
      template: 'repo-source-remediation-v1',
      taskInput: {
        kind: 'SOURCE_REMEDIATION',
        reasonCode: 'NO_CANDIDATE',
        discoveryGeneration: 7,
        sourceSha: '7'.repeat(40),
      },
    },
  ];
  claims.forEach((claim) => assert.deepEqual(
    assertAgentRelayPublicResponse({ ok: true, result: { ok: true, claim } }, 'CLAIM'),
    { ok: true, result: { ok: true, claim } },
  ));

  const responses = [
    ['HEARTBEAT', { ok: true, result: { ok: true, sessionId, expiresAt: '2026-09-04T00:05:00.000Z', duplicate: false } }],
    ['COMPLETE', { ok: true, result: { ok: true, runId: baseClaim.runId, status: 'SUCCEEDED', retry: false, duplicate: false } }],
    ['FAIL', { ok: true, result: { ok: true, runId: baseClaim.runId, status: 'PENDING', retry: true, duplicate: false } }],
    ['READBACK_REQUIRED', { ok: true, result: { ok: true, runId: baseClaim.runId, status: 'FAILED', retry: false, duplicate: false } }],
    ['READBACK_RESOLVE', { ok: true, result: { ok: true, runId: baseClaim.runId, status: 'PENDING', duplicate: false } }],
    ['GITHUB_READY_PR', { ok: true, result: { executionId: 'mutation-execution:public', status: 'VERIFIED', writeAttempted: true, pullRequestNumber: 7, pullRequestUrl: 'https://github.com/seorilabs/example/pull/7' } }],
    ['GITHUB_READY_PR_READBACK', { ok: true, result: { executionId: 'mutation-execution:public', status: 'NOT_APPLIED', writeAttempted: false, safeToResume: true } }],
  ];
  responses.forEach(([operation, response]) => assert.equal(
    assertAgentRelayPublicResponse(response, operation),
    response,
  ));
  const error = { error: { code: 'seori_auth_request_rejected' } };
  assert.equal(assertAgentRelayPublicResponse(error, 'CLAIM'), error);
});

test('agent relay refuses a private socket directory below a writable ancestor', async () => {
  const root = await realpath(await mkdtemp(join(process.cwd(), '.agent-relay-ancestor-test-')));
  try {
    const unsafe = join(root, 'worker-writable');
    const directory = join(unsafe, 'relay');
    await mkdir(unsafe, { mode: 0o700 });
    await chmod(unsafe, 0o777);
    await mkdir(directory, { mode: 0o700 });
    const daemon = new AgentRelayDaemon({
      socketPath: join(directory, 'worker.sock'),
      expectedPeerUid: process.getuid(),
      expectedPeerGid: process.getgid(),
      nativeBoundary: { async attest() { return {}; } },
      forwarder: { async forward() { return {}; }, close() {} },
    });
    await assert.rejects(
      daemon.start(),
      (error) => error instanceof SeoriAuthError && error.code === 'insecure_agent_relay_directory',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent relay config is read from one verified descriptor under trusted ancestors', async () => {
  const root = await realpath(await mkdtemp(join(process.cwd(), '.agent-relay-config-test-')));
  try {
    const configPath = join(root, 'relay.json');
    await writeFile(configPath, '{"schemaVersion":1}', { mode: 0o600 });
    assert.deepEqual(await readImmutableAgentRelayConfig(configPath, {
      expectedOwnerUid: process.getuid(),
    }), { schemaVersion: 1 });

    const unsafe = join(root, 'worker-writable');
    await mkdir(unsafe, { mode: 0o700 });
    await chmod(unsafe, 0o777);
    const replacedPath = join(unsafe, 'relay.json');
    await writeFile(replacedPath, '{"schemaVersion":1}', { mode: 0o600 });
    await assert.rejects(
      readImmutableAgentRelayConfig(replacedPath, { expectedOwnerUid: process.getuid() }),
      (error) => error instanceof SeoriAuthError && error.code === 'insecure_agent_relay_config_ancestor',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent relay config is bound to one central revision and observation projection', () => {
  const config = relayProjectionConfig();
  assert.deepEqual(assertAgentRelayProjection(config), config.controlPlane);

  const tampered = structuredClone(config);
  tampered.expectedPeer.uid += 1;
  assert.throws(
    () => assertAgentRelayProjection(tampered),
    (error) => error instanceof SeoriAuthError && error.code === 'agent_relay_projection_mismatch',
  );

  const missingObservation = structuredClone(config);
  delete missingObservation.controlPlane.providerObservation;
  assert.throws(
    () => assertAgentRelayProjection(missingObservation),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_agent_relay_projection',
  );
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
          workerKind: 'CODEX',
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

test('mTLS forwarder rejects port zero before reading TLS material', async () => {
  await assert.rejects(
    createAgentMtlsForwarder({
      origin: 'https://127.0.0.1:0',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      workerKind: 'CODEX',
      tls: {
        caPath: '/not-read/ca.pem',
        certificatePath: '/not-read/tls.crt',
        privateKeyPath: '/not-read/tls.key',
      },
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'invalid_agent_relay_upstream',
  );
});

test('mTLS forwarder fixes the upstream origin and rejects credential-shaped responses', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seori-agent-forwarder-')));
  try {
    const tls = await tlsFiles(root);
    const capture = {};
    const forwarder = await createAgentMtlsForwarder({
      origin: 'https://127.0.0.1:19443',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      workerKind: 'CODEX',
      tls,
      requestImpl: fakeHttpsRequest(JSON.stringify({
        ok: true,
        result: { ok: true, claim: null },
      }), capture),
    });
    const request = publicRequest('CLAIM', { leaseSeconds: 300 });
    const result = await forwarder.forward(request);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body.toString('utf8')), {
      ok: true,
      result: { ok: true, claim: null },
    });
    assert.equal(capture.options.hostname, '127.0.0.1');
    assert.equal(capture.options.port, 19_443);
    assert.equal(capture.options.servername, 'seori-auth-agent-runtime.auth-broker.svc.cluster.local');
    assert.equal(capture.options.path, '/v1/execute');
    assert.equal(capture.options.minVersion, 'TLSv1.3');
    assert.equal(capture.options.maxVersion, 'TLSv1.3');
    assert.equal(capture.options.agent.options.keepAlive, false);
    assert.deepEqual(JSON.parse(capture.requestBody.toString('utf8')), {
      ...request,
    });
    capture.requestBody.fill(0);
    result.body.fill(0);
    let agentDestroyed = false;
    capture.options.agent.destroy = () => { agentDestroyed = true; };
    forwarder.close();
    assert.equal(agentDestroyed, true);
    await assert.rejects(
      forwarder.forward(publicRequest('CLAIM', {})),
      (error) => error instanceof SeoriAuthError && error.code === 'agent_relay_closed',
    );

    const secretResponseForwarder = await createAgentMtlsForwarder({
      origin: 'https://127.0.0.1:19443',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      workerKind: 'CODEX',
      tls,
      requestImpl: fakeHttpsRequest(JSON.stringify({
        ok: true,
        result: { ok: true, claim: null, signedJwt: 'fake-secret-canary' },
      }), {}),
    });
    await assert.rejects(
      secretResponseForwarder.forward(publicRequest('CLAIM', {})),
      (error) => {
        assert.ok(error instanceof SeoriAuthError);
        assert.equal(error.code, 'agent_relay_upstream_rejected');
        assert.doesNotMatch(error.message, /fake-secret-canary/);
        return true;
      },
    );
    secretResponseForwarder.close();

    const mismatchedClaimForwarder = await createAgentMtlsForwarder({
      origin: 'https://127.0.0.1:19443',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      workerKind: 'CODEX',
      tls,
      requestImpl: fakeHttpsRequest(JSON.stringify({
        ok: true,
        result: { ok: true, claim: publicClaim('CLAUDE') },
      }), {}),
    });
    await assert.rejects(
      mismatchedClaimForwarder.forward(publicRequest('CLAIM', {})),
      (error) => error instanceof SeoriAuthError && error.code === 'agent_relay_upstream_rejected',
    );
    mismatchedClaimForwarder.close();

    for (const [statusCode, response] of [
      [200, { error: { code: 'claim_rejected' } }],
      [400, { ok: true, result: { ok: true, claim: null } }],
    ]) {
      const mislabeledForwarder = await createAgentMtlsForwarder({
        origin: 'https://127.0.0.1:19443',
        serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
        workerKind: 'CODEX',
        tls,
        requestImpl: fakeHttpsRequest(JSON.stringify(response), {}, statusCode),
      });
      await assert.rejects(
        mislabeledForwarder.forward(publicRequest('CLAIM', {})),
        (error) => error instanceof SeoriAuthError && error.code === 'agent_relay_upstream_rejected',
        `status ${statusCode}`,
      );
      mislabeledForwarder.close();
    }

    const ipv6Capture = {};
    const ipv6Forwarder = await createAgentMtlsForwarder({
      origin: 'https://[::1]:19443',
      serverName: 'seori-auth-agent-runtime.auth-broker.svc.cluster.local',
      workerKind: 'CODEX',
      tls,
      requestImpl: fakeHttpsRequest(JSON.stringify({ ok: true, result: { ok: true, claim: null } }), ipv6Capture),
    });
    const ipv6Result = await ipv6Forwarder.forward(publicRequest('CLAIM', {}));
    assert.equal(ipv6Capture.options.hostname, '::1');
    ipv6Result.body.fill(0);
    ipv6Forwarder.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent relay entrypoint delegates lifecycle without forced process exit', async () => {
  const entrypoint = await readFile(new URL('../runtime/agent-relay-entrypoint.mjs', import.meta.url), 'utf8');
  assert.match(entrypoint, /await runAgentRelayLifecycle\(\{/);
  assert.match(entrypoint, /workerKind: config\.workerKind/);
  assert.doesNotMatch(entrypoint, /process\.exit\(/);
});

test('agent relay lifecycle serializes a startup signal before STOPPED and never emits READY', async () => {
  const config = relayProjectionConfig();
  let resolveStart;
  const startGate = new Promise((resolve) => { resolveStart = resolve; });
  const events = [];
  const handlers = new Map();
  const exitCodes = [];
  const lifecycle = runAgentRelayLifecycle({
    daemon: {
      async start() {
        events.push('STARTING');
        await startGate;
        events.push('STARTED');
      },
      async stop() {
        events.push('STOPPED_DAEMON');
      },
    },
    workerKind: 'CODEX',
    controlPlane: config.controlPlane,
    async writeRecord(record) {
      events.push(record.state);
    },
    subscribeSignal(signal, handler) {
      handlers.set(signal, handler);
    },
    setExitCode(code) {
      exitCodes.push(code);
    },
  });

  handlers.get('SIGTERM')();
  await Promise.resolve();
  assert.deepEqual(events, ['STARTING']);
  resolveStart();
  await lifecycle;
  assert.deepEqual(events, ['STARTING', 'STARTED', 'STOPPED_DAEMON', 'STOPPED']);
  assert.deepEqual(exitCodes, [0]);
});

test('agent relay lifecycle closes the daemon when READY publication fails', async () => {
  const config = relayProjectionConfig();
  let stopCount = 0;
  await assert.rejects(
    runAgentRelayLifecycle({
      daemon: {
        async start() {},
        async stop() { stopCount += 1; },
      },
      workerKind: 'CLAUDE',
      controlPlane: config.controlPlane,
      async writeRecord(record) {
        assert.equal(record.state, 'READY');
        throw new Error('fake stdout failure');
      },
      subscribeSignal() {},
      setExitCode: () => assert.fail('startup publication failure is handled by the entrypoint catch'),
    }),
    /fake stdout failure/,
  );
  assert.equal(stopCount, 1);
});

test('agent relay lifecycle refuses to start without a control-plane projection', async () => {
  let started = false;
  await assert.rejects(
    runAgentRelayLifecycle({
      daemon: {
        async start() { started = true; },
        async stop() {},
      },
      workerKind: 'CODEX',
      async writeRecord() {},
      subscribeSignal() {},
      setExitCode() {},
    }),
    /validated control-plane projection/,
  );
  assert.equal(started, false);
});

test('agent relay READY record exposes the exact public control-plane projection binding', async () => {
  const config = relayProjectionConfig();
  const records = [];
  await runAgentRelayLifecycle({
    daemon: { async start() {}, async stop() {} },
    workerKind: config.workerKind,
    controlPlane: config.controlPlane,
    async writeRecord(record) { records.push(record); },
    subscribeSignal() {},
    setExitCode: () => assert.fail('READY completion does not set an exit code'),
  });
  assert.deepEqual(records, [{
    state: 'READY',
    transport: 'unix',
    workerKind: 'CODEX',
    controlPlane: config.controlPlane,
  }]);
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
      workerKind: 'CODEX',
      tls,
      requestImpl,
    });
    await assert.rejects(
      forwarder.forward(publicRequest('CLAIM', {})),
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

test('agent relay client rejects response stream errors without reflecting details', async () => {
  const requestImpl = (_options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      response.destroy = () => response.emit('aborted');
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from('{"ok":', 'utf8'));
        response.emit('error', new Error('fake local reset containing fake-secret-canary'));
      });
    };
    request.destroy = () => request.emit('error', new Error('destroyed'));
    return request;
  };
  const encoded = Buffer.from(JSON.stringify(publicRequest('CLAIM', {})), 'utf8');
  try {
    await assert.rejects(
      executeAgentRelayClientRequest({
        socketPath: '/private/var/run/seori-auth-agent/codex/relay.sock',
        encoded,
        requestImpl,
      }),
      (error) => {
        assert.ok(error instanceof SeoriAuthError);
        assert.equal(error.code, 'agent_relay_response_rejected');
        assert.doesNotMatch(error.message, /fake-secret-canary/);
        return true;
      },
    );
  } finally {
    encoded.fill(0);
  }
});
