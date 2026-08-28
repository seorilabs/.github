import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DurableAuthState, EncryptedBrowserVault, LocalAuthDaemon } from '../src/index.mjs';
import { makeNativeLockProvider, makePolicy, makeRequest } from '../fixtures/helpers.mjs';

const fixture = fileURLToPath(new URL('../fixtures/echo-secret-child.mjs', import.meta.url));

function post(socketPath, path, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest({
      socketPath,
      path,
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': payload.length,
      } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, text, body: JSON.parse(text) });
      });
    });
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function executionBinding() {
  return {
    subject: 'k8s:release-workers:worker-a',
    runId: 'github:123',
    repository: 'seorilabs/example-app',
    workerId: 'worker-a',
  };
}

function publicIdentity(overrides = {}) {
  return {
    provider: 'apps-in-toss',
    accountId: 'operator-account',
    teamId: 'seorilabs-team',
    workspaceId: 'release-workspace',
    appId: 'example-app',
    ...overrides,
  };
}

function stateContractStub() {
  return Object.fromEntries([
    'issueCredentialCheckout',
    'consumeCredentialCheckout',
    'recordCredentialExecution',
    'checkoutBrowserSession',
    'authorizeBrowserSessionExecution',
    'completeBrowserSession',
    'abortBrowserSession',
    'createReauthRequest',
  ].map((method) => [method, async () => {}]));
}

function browserVaultStub() {
  return {
    checkout: async () => {},
    withClone: async (_binding, operation) => operation('/trusted/ephemeral-clone'),
    complete: async () => {},
    abort: async () => {},
  };
}

test('daemon cannot be constructed without an out-of-body principal attestor', () => {
  assert.throws(
    () => new LocalAuthDaemon({
      socketPath: '/tmp/seori-auth-constructor-test.sock',
      state: stateContractStub(),
      policy: makePolicy(),
      adapters: [],
      loadSecret: async () => Buffer.from('unused'),
      getCredentialGeneration: async () => 3,
      readBrowserIdentity: async () => publicIdentity(),
      browserVault: browserVaultStub(),
      executeBrowserSession: async () => {},
    }),
    /authenticatePrincipal must attest the Unix peer outside the HTTP body/,
  );
});

test('Unix-only daemon exposes only five non-secret POST routes and never leaks a secret canary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-daemon-'));
  const stateDirectory = join(root, 'state');
  const runtimeDirectory = join(root, 'run');
  const socketPath = join(runtimeDirectory, 'broker.sock');
  const capturePath = join(root, 'child-boundary.json');
  const fakeHome = join(root, 'fake-home');
  const canary = 'canary-actual-password-TOTP-session-cookie';
  const marker = 'must-remain-unchanged';
  const profileFiles = [
    join(fakeHome, 'Library/Application Support/Google/Chrome/Default/Preferences'),
    join(fakeHome, '.config/gcloud/configurations/config_default'),
    join(fakeHome, '.config/configstore/firebase-tools.json'),
  ];
  for (const path of profileFiles) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, marker);
  }

  const previousEnvironment = new Map();
  for (const [name, value] of Object.entries({
    HOME: fakeHome,
    CLOUDSDK_CONFIG: join(fakeHome, '.config/gcloud'),
    FIREBASE_CONFIG: join(fakeHome, '.config/configstore/firebase-tools.json'),
    CHROME_USER_DATA_DIR: join(fakeHome, 'Library/Application Support/Google/Chrome'),
  })) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  let state;
  let vault;
  let daemon;
  let unauthenticatedDaemon;
  let trustedIdentityReadback = publicIdentity();
  let generationLookups = 0;
  let browserAdapterRuns = 0;
  let expectedBrowserLeaseId;
  const vaultKey = Buffer.alloc(32, 0x4d);
  try {
    state = await DurableAuthState.open({ directory: stateDirectory });
    await state.registerBrowserSession({
      sessionId: 'browser-session-a',
      generation: 1,
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    const browserProfile = join(root, 'browser-profile');
    await mkdir(browserProfile, { mode: 0o700 });
    await writeFile(join(browserProfile, 'Cookies'), 'fake-encrypted-session-input', { mode: 0o600 });
    vault = await EncryptedBrowserVault.open({
      vaultDirectory: join(root, 'browser-vault'),
      runtimeDirectory: join(root, 'browser-runtime'),
      encryptionKey: vaultKey,
      lockProvider: await makeNativeLockProvider(),
    });
    await vault.registerProfile({
      sourceDirectory: browserProfile,
      role: 'release',
      publicIdentity: publicIdentity(),
      generation: 1,
    });
    unauthenticatedDaemon = new LocalAuthDaemon({
      socketPath: join(runtimeDirectory, 'unauthenticated.sock'),
      state,
      policy: makePolicy(),
      adapters: [{
        id: 'test-adapter',
        executable: process.execPath,
        providers: ['apps-in-toss'],
        capabilities: ['ait.bundle.upload.private'],
        credentialDelivery: 'fd3',
        buildArgs: () => [fixture],
        environment: { TEST_CAPTURE_FILE: capturePath },
      }],
      loadSecret: async () => Buffer.from(canary),
      getCredentialGeneration: async () => 3,
      readBrowserIdentity: async () => publicIdentity(),
      authenticatePrincipal: async () => {
        throw new Error('same UID without scheduler attestation');
      },
      browserVault: vault,
      executeBrowserSession: async () => {},
    });
    await unauthenticatedDaemon.start();
    const unauthenticated = await post(
      join(runtimeDirectory, 'unauthenticated.sock'),
      '/auth/leases',
      { workerId: 'worker-a', request: makeRequest() },
    );
    assert.equal(unauthenticated.status, 403);
    assert.deepEqual(unauthenticated.body, { error: { code: 'principal_unauthenticated' } });
    await unauthenticatedDaemon.stop();
    unauthenticatedDaemon = undefined;

    daemon = new LocalAuthDaemon({
      socketPath,
      state,
      policy: makePolicy(),
      adapters: [{
        id: 'test-adapter',
        executable: process.execPath,
        providers: ['apps-in-toss'],
        capabilities: ['ait.bundle.upload.private'],
        credentialDelivery: 'fd3',
        buildArgs: () => [fixture],
        environment: { TEST_CAPTURE_FILE: capturePath },
      }],
      loadSecret: async () => Buffer.from(canary),
      getCredentialGeneration: async ({ credentialRef }) => {
        generationLookups += 1;
        assert.equal(credentialRef, 'shared/apps-in-toss/operator');
        return 3;
      },
      readBrowserIdentity: async ({ sessionId, capabilityId }) => {
        assert.equal(sessionId, 'browser-session-a');
        assert.match(capabilityId, /^[A-Za-z0-9-]+$/);
        return trustedIdentityReadback;
      },
      authenticatePrincipal: async (socket) => {
        assert.equal(typeof socket.remoteAddress, 'undefined');
        return executionBinding();
      },
      browserVault: vault,
      executeBrowserSession: async ({ cloneDirectory, authorization }) => {
        browserAdapterRuns += 1;
        assert.equal(await readFile(join(cloneDirectory, 'Cookies'), 'utf8'), 'fake-encrypted-session-input');
        assert.equal(authorization.leaseId, expectedBrowserLeaseId);
        assert.equal(authorization.request.commitSha, makeRequest().commitSha);
        assert.equal(authorization.request.origin, makeRequest().origin);
        assert.deepEqual(authorization.request.approval, makeRequest().approval);
      },
    });
    const listening = await daemon.start();
    assert.deepEqual(listening, { transport: 'unix', socketPath });
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);

    const methodRejected = await post(socketPath, '/auth/leases', undefined, 'GET');
    assert.equal(methodRejected.status, 405);
    const secretRoutes = [
      '/auth/secrets',
      '/auth/credentials/shared%2Fapps-in-toss%2Foperator',
      '/auth/export',
      '/auth/print',
    ];
    for (const route of secretRoutes) {
      const rejected = await post(socketPath, route, {});
      assert.equal(rejected.status, 404);
      assert.deepEqual(rejected.body, { error: { code: 'route_not_found' } });
    }

    const promptRejected = await post(socketPath, '/auth/leases', {
      workerId: 'worker-a',
      request: makeRequest(),
      prompt: canary,
    });
    assert.equal(promptRejected.status, 400);
    assert.doesNotMatch(promptRejected.text, new RegExp(canary));

    for (const spoofed of [
      { workerId: 'worker-b', request: makeRequest() },
      { workerId: 'worker-a', request: makeRequest({ subject: 'k8s:release-workers:worker-b' }) },
      { workerId: 'worker-a', request: makeRequest({ runId: 'github:124' }) },
      { workerId: 'worker-a', request: makeRequest({ repository: 'seorilabs/other-app' }) },
    ]) {
      const rejected = await post(socketPath, '/auth/leases', spoofed);
      assert.equal(rejected.status, 403);
      assert.deepEqual(rejected.body, { error: { code: 'principal_binding_mismatch' } });
    }
    assert.equal(generationLookups, 0, 'spoofed principals must be rejected before generation lookup');

    const issued = await post(socketPath, '/auth/leases', {
      workerId: 'worker-a',
      request: makeRequest(),
    });
    assert.equal(issued.status, 201);
    assert.equal(generationLookups, 1);
    assert.equal(issued.body.credentialCheckout.secretExportable, false);
    assert.deepEqual(issued.body.credentialCheckout.executionBinding, executionBinding());

    const executed = await post(
      socketPath,
      `/auth/leases/${issued.body.credentialCheckout.id}/execute`,
      {
        expectedGeneration: issued.body.credentialCheckout.generation,
        workerId: 'worker-a',
        context: makeRequest(),
      },
    );
    assert.equal(executed.status, 200);
    assert.deepEqual(executed.body.execution, {
      generation: 2,
      outcome: 'SUCCESS',
      exitCode: 0,
      signal: null,
    });
    assert.doesNotMatch(executed.text, new RegExp(canary));
    assert.equal('stdout' in executed.body.execution, false);
    assert.equal('stderr' in executed.body.execution, false);

    const browserContext = makeRequest();
    const browserLease = await post(socketPath, '/auth/leases', {
      workerId: 'worker-a',
      request: browserContext,
    });
    assert.equal(browserLease.status, 201);
    expectedBrowserLeaseId = browserLease.body.credentialCheckout.id;
    const browserCheckout = await post(socketPath, '/auth/browser-sessions/browser-session-a/checkout', {
      context: browserContext,
      executionBinding: executionBinding(),
      expectedLeaseGeneration: browserLease.body.credentialCheckout.generation,
      expectedProfileGeneration: 1,
      expectedSessionGeneration: 1,
      expectedIdentity: publicIdentity(),
      leaseId: browserLease.body.credentialCheckout.id,
      role: 'release',
      workerId: 'worker-a',
    });
    assert.equal(browserCheckout.status, 200);
    assert.deepEqual(
      Object.keys(browserCheckout.body.browserSession).sort(),
      ['capabilityId', 'publicIdentity'],
    );
    assert.doesNotMatch(browserCheckout.text, /profile|cookie|path/i);
    assert.equal(browserAdapterRuns, 0, 'checkout must not expose or execute the clone');

    const completionRequest = {
      capabilityId: browserCheckout.body.browserSession.capabilityId,
      context: browserContext,
      executionBinding: executionBinding(),
      expectedGeneration: 2,
      leaseId: browserLease.body.credentialCheckout.id,
      profileGeneration: 1,
      role: 'release',
      workerId: 'worker-a',
    };

    const spoofedReadback = await post(socketPath, '/auth/browser-sessions/browser-session-a/complete', {
      ...completionRequest,
      identityReadback: publicIdentity({ accountId: canary }),
    });
    assert.equal(spoofedReadback.status, 400);
    assert.doesNotMatch(spoofedReadback.text, new RegExp(canary));
    assert.equal(state.snapshot().browserSessionBindings[0].generation, 2);
    assert.equal(browserAdapterRuns, 0);

    const changedBindings = [
      [makeRequest({ commitSha: '2'.repeat(40) }), 403, 'capability_forbidden'],
      [makeRequest({ origin: 'https://business.toss.im' }), 403, 'capability_forbidden'],
      [makeRequest({ capability: 'ait.bundle.status.read' }), 403, 'capability_forbidden'],
      [makeRequest({
        resource: { kind: 'miniapp', id: 'other-app', environment: 'private' },
      }), 403, 'capability_forbidden'],
      [makeRequest({
        artifact: { sha256: 'b'.repeat(64), sizeBytes: 1024 },
      }), 403, 'capability_forbidden'],
      [makeRequest({ policyGeneration: 8 }), 409, 'stale_policy_generation'],
      [makeRequest({
        approval: {
          id: 'approval-123', mode: 'preapproved', expiresAt: '2098-01-01T00:00:00.000Z', maxUses: 1,
        },
      }), 403, 'capability_forbidden'],
    ];
    for (const [context, status, code] of changedBindings) {
      const changed = await post(socketPath, '/auth/browser-sessions/browser-session-a/complete', {
        ...completionRequest,
        context,
      });
      assert.equal(changed.status, status);
      assert.deepEqual(changed.body, { error: { code } });
    }
    assert.equal(browserAdapterRuns, 0, 'changed browser binding must fail before the trusted adapter');

    const changedLease = await post(socketPath, '/auth/browser-sessions/browser-session-a/complete', {
      ...completionRequest,
      leaseId: 'different-browser-lease',
    });
    assert.equal(changedLease.status, 403);
    assert.deepEqual(changedLease.body, { error: { code: 'browser_session_binding_mismatch' } });
    assert.equal(browserAdapterRuns, 0, 'changed lease must fail before the trusted browser adapter');

    trustedIdentityReadback = publicIdentity({ appId: 'wrong-app' });
    const mismatch = await post(
      socketPath,
      '/auth/browser-sessions/browser-session-a/complete',
      completionRequest,
    );
    assert.equal(mismatch.status, 403, JSON.stringify(mismatch.body));
    assert.equal(browserAdapterRuns, 1);
    assert.equal(state.snapshot().browserSessionBindings[0].generation, 3);
    assert.equal(state.snapshot().browserSessionBindings[0].state, 'AVAILABLE');

    trustedIdentityReadback = publicIdentity();
    const retryLease = await post(socketPath, '/auth/leases', {
      workerId: 'worker-a',
      request: browserContext,
    });
    expectedBrowserLeaseId = retryLease.body.credentialCheckout.id;
    const retryCheckout = await post(socketPath, '/auth/browser-sessions/browser-session-a/checkout', {
      context: browserContext,
      executionBinding: executionBinding(),
      expectedLeaseGeneration: retryLease.body.credentialCheckout.generation,
      expectedProfileGeneration: 1,
      expectedSessionGeneration: 3,
      expectedIdentity: publicIdentity(),
      leaseId: retryLease.body.credentialCheckout.id,
      role: 'release',
      workerId: 'worker-a',
    });
    assert.equal(retryCheckout.status, 200);
    const completed = await post(socketPath, '/auth/browser-sessions/browser-session-a/complete', {
      capabilityId: retryCheckout.body.browserSession.capabilityId,
      context: browserContext,
      executionBinding: executionBinding(),
      expectedGeneration: 4,
      leaseId: retryLease.body.credentialCheckout.id,
      profileGeneration: 1,
      role: 'release',
      workerId: 'worker-a',
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.browserSession.state, 'COMPLETED');
    assert.equal(completed.body.browserSession.generation, 5);
    assert.equal(browserAdapterRuns, 2);

    const reauth = await post(socketPath, '/auth/reauth-requests', {
      reason: 'captcha_required',
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    assert.equal(reauth.status, 201);
    assert.equal(reauth.body.reauthRequest.state, 'HUMAN_REAUTH_REQUIRED');

    const capture = await readFile(capturePath, 'utf8');
    const journal = await readFile(join(stateDirectory, 'auth-journal.jsonl'), 'utf8');
    const transformedCanary = Buffer.from(canary).toString('base64');
    assert.doesNotMatch(capture, new RegExp(canary), 'canary must not enter child argv or environment');
    assert.doesNotMatch(journal, new RegExp(canary), 'canary must not enter durable state or audit');
    assert.doesNotMatch(executed.text, new RegExp(transformedCanary));
    assert.doesNotMatch(journal, new RegExp(transformedCanary));
    assert.doesNotMatch(JSON.stringify(state.snapshot()), new RegExp(canary));

    for (const path of profileFiles) {
      assert.equal(await readFile(path, 'utf8'), marker);
    }
  } finally {
    if (unauthenticatedDaemon) await unauthenticatedDaemon.stop();
    if (daemon) await daemon.stop();
    if (vault) await vault.close();
    if (state) await state.close();
    vaultKey.fill(0);
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
