import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DurableAuthState,
  EncryptedBrowserVault,
  HUMAN_REAUTH_REQUIRED,
  LocalAuthDaemon,
  SeoriAuthError,
} from '../src/index.mjs';
import { makeNativeLauncher, makeNativeLockProvider, makePolicy, makeRequest } from '../fixtures/helpers.mjs';

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

function approval(id) {
  return {
    id,
    mode: 'preapproved',
    expiresAt: '2099-01-01T00:00:00.000Z',
    maxUses: 1,
  };
}

function stateContractStub() {
  return Object.fromEntries([
    'issueCredentialCheckout',
    'consumeCredentialCheckout',
    'recordCredentialExecution',
    'checkoutBrowserSession',
    'claimBrowserSessionExecution',
    'claimBrowserSessionRecovery',
    'completeBrowserSession',
    'abortBrowserSession',
    'requireBrowserSessionReconciliation',
    'abortBrowserSessionAfterReconciliation',
    'blockBrowserSessionForReauth',
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

async function startBrowserHarness({
  approvals,
  executeBrowserSession,
  reconcileBrowserSession,
  readBrowserIdentity = async () => publicIdentity(),
  getCredentialGeneration = async () => 3,
}) {
  const root = await mkdtemp(join(tmpdir(), 'seori-auth-browser-daemon-'));
  const socketPath = join(root, 'broker.sock');
  const state = await DurableAuthState.open({ directory: join(root, 'state') });
  await state.registerBrowserSession({
    sessionId: 'browser-session-harness',
    generation: 1,
    executionBinding: executionBinding(),
    publicIdentity: publicIdentity(),
  });
  const daemon = new LocalAuthDaemon({
    socketPath,
    state,
    policy: makePolicy({ approvals }),
    adapters: [],
    loadSecret: async () => Buffer.from('unused'),
    getCredentialGeneration,
    readBrowserIdentity,
    reconcileBrowserSession,
    authenticatePrincipal: async () => executionBinding(),
    browserVault: browserVaultStub(),
    executeBrowserSession,
  });
  await daemon.start();

  return {
    socketPath,
    state,
    async checkout({ approval: requestApproval, occurrence, expectedSessionGeneration = 1 }) {
      const context = makeRequest({ approval: requestApproval });
      const lease = await post(socketPath, '/auth/leases', {
        idempotencyKey: occurrence,
        workerId: 'worker-a',
        request: context,
      });
      assert.equal(lease.status, 201, JSON.stringify(lease.body));
      const checkedOut = await post(socketPath, '/auth/browser-sessions/browser-session-harness/checkout', {
        context,
        executionBinding: executionBinding(),
        expectedLeaseGeneration: lease.body.credentialCheckout.generation,
        expectedProfileGeneration: 1,
        expectedSessionGeneration,
        expectedIdentity: publicIdentity(),
        leaseId: lease.body.credentialCheckout.id,
        role: 'release',
        workerId: 'worker-a',
      });
      assert.equal(checkedOut.status, 200, JSON.stringify(checkedOut.body));
      return {
        context,
        completion: {
          capabilityId: checkedOut.body.browserSession.capabilityId,
          context,
          executionBinding: executionBinding(),
          expectedGeneration: expectedSessionGeneration + 1,
          leaseId: lease.body.credentialCheckout.id,
          profileGeneration: 1,
          role: 'release',
          workerId: 'worker-a',
        },
      };
    },
    async close() {
      await daemon.stop();
      await state.close();
      await rm(root, { recursive: true, force: true });
    },
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
      reconcileBrowserSession: async () => ({ outcome: 'UNKNOWN', publicIdentity: publicIdentity() }),
      browserVault: browserVaultStub(),
      executeBrowserSession: async () => {},
    }),
    /authenticatePrincipal must attest the Unix peer outside the HTTP body/,
  );
});

test('daemon production boundary requires every credential adapter to use the native launcher', () => {
  assert.throws(
    () => new LocalAuthDaemon({
      socketPath: '/tmp/seori-auth-native-required.sock',
      state: stateContractStub(),
      policy: makePolicy(),
      adapters: [{
        id: 'test-adapter',
        executable: process.execPath,
        providers: ['apps-in-toss'],
        capabilities: ['ait.bundle.upload.private'],
        credentialDelivery: 'fd3',
        buildArgs: () => [fixture],
      }],
      loadSecret: async () => Buffer.from('unused'),
      getCredentialGeneration: async () => 3,
      readBrowserIdentity: async () => publicIdentity(),
      reconcileBrowserSession: async () => ({ outcome: 'UNKNOWN', publicIdentity: publicIdentity() }),
      authenticatePrincipal: async () => executionBinding(),
      browserVault: browserVaultStub(),
      executeBrowserSession: async () => {},
      requireNativeLauncher: false,
    }),
    (error) => error instanceof SeoriAuthError && error.code === 'native_launcher_required',
  );
});

test('concurrent browser completion claims execute the trusted adapter exactly once', async () => {
  const requestApproval = approval('approval-concurrent-complete');
  let adapterRuns = 0;
  let releaseAdapter;
  let signalAdapterStarted;
  const adapterStarted = new Promise((resolve) => { signalAdapterStarted = resolve; });
  const adapterReleased = new Promise((resolve) => { releaseAdapter = resolve; });
  const harness = await startBrowserHarness({
    approvals: [requestApproval],
    executeBrowserSession: async () => {
      adapterRuns += 1;
      signalAdapterStarted();
      await adapterReleased;
    },
    reconcileBrowserSession: async () => ({ outcome: 'UNKNOWN', publicIdentity: publicIdentity() }),
  });
  try {
    const { completion } = await harness.checkout({
      approval: requestApproval,
      occurrence: 'concurrent-complete',
    });
    const first = post(
      harness.socketPath,
      '/auth/browser-sessions/browser-session-harness/complete',
      completion,
    );
    await adapterStarted;
    const duplicate = await post(
      harness.socketPath,
      '/auth/browser-sessions/browser-session-harness/complete',
      completion,
    );
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.body, { error: { code: 'generation_conflict' } });
    assert.equal(adapterRuns, 1);
    releaseAdapter();
    const completed = await first;
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.browserSession.state, 'COMPLETED');
    assert.equal(completed.body.browserSession.generation, 4);
    assert.equal(adapterRuns, 1);
  } finally {
    releaseAdapter();
    await harness.close();
  }
});

test('uncertain browser failure remains claimed and every retry is readback-only', async () => {
  const requestApproval = approval('approval-uncertain-complete');
  let adapterRuns = 0;
  let reconciliationRuns = 0;
  let credentialGeneration = 3;
  let generationReads = 0;
  const harness = await startBrowserHarness({
    approvals: [requestApproval],
    executeBrowserSession: async () => {
      adapterRuns += 1;
      throw new Error('simulated crash after external boundary');
    },
    reconcileBrowserSession: async () => {
      reconciliationRuns += 1;
      return { outcome: 'UNKNOWN', publicIdentity: publicIdentity() };
    },
    getCredentialGeneration: async () => {
      generationReads += 1;
      return credentialGeneration;
    },
  });
  try {
    const { completion } = await harness.checkout({
      approval: requestApproval,
      occurrence: 'uncertain-complete',
    });
    const failed = await post(
      harness.socketPath,
      '/auth/browser-sessions/browser-session-harness/complete',
      completion,
    );
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: { code: 'internal_error' } });
    assert.equal(harness.state.snapshot().browserSessionBindings[0].state, 'CLAIMED');
    assert.equal(harness.state.snapshot().browserSessionBindings[0].generation, 3);
    credentialGeneration = 4;
    const readsBeforeRecovery = generationReads;

    const reboundRecovery = await post(
      harness.socketPath,
      '/auth/browser-sessions/browser-session-harness/complete',
      { ...completion, context: makeRequest({ approval: requestApproval, commitSha: '2'.repeat(40) }) },
    );
    assert.equal(reboundRecovery.status, 403);
    assert.deepEqual(reboundRecovery.body, { error: { code: 'browser_session_binding_mismatch' } });
    assert.equal(adapterRuns, 1);
    assert.equal(reconciliationRuns, 0);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = await post(
        harness.socketPath,
        '/auth/browser-sessions/browser-session-harness/complete',
        completion,
      );
      assert.equal(retry.status, 409);
      assert.deepEqual(retry.body, { error: { code: 'browser_reconciliation_required' } });
    }
    assert.equal(adapterRuns, 1, 'unknown reconciliation must never replay the external action');
    assert.equal(reconciliationRuns, 2);
    assert.equal(
      generationReads,
      readsBeforeRecovery,
      'recovery readback must remain possible after credential generation changes',
    );
    assert.equal(harness.state.snapshot().browserSessionBindings[0].state, 'CLAIMED');
  } finally {
    await harness.close();
  }
});

test('detected interactive login gate creates durable ReauthRequest and blocks retries', async () => {
  const firstApproval = approval('approval-human-gate-first');
  const retryApproval = approval('approval-human-gate-retry');
  let adapterRuns = 0;
  const harness = await startBrowserHarness({
    approvals: [firstApproval, retryApproval],
    executeBrowserSession: async () => {
      adapterRuns += 1;
      throw new SeoriAuthError(
        HUMAN_REAUTH_REQUIRED,
        'interactive browser gate detected',
        { reason: 'captcha_required' },
      );
    },
    reconcileBrowserSession: async () => ({ outcome: 'UNKNOWN', publicIdentity: publicIdentity() }),
  });
  try {
    const { completion } = await harness.checkout({
      approval: firstApproval,
      occurrence: 'human-gate-first',
    });
    const blocked = await post(
      harness.socketPath,
      '/auth/browser-sessions/browser-session-harness/complete',
      completion,
    );
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body, { error: { code: HUMAN_REAUTH_REQUIRED } });
    const snapshot = harness.state.snapshot();
    assert.equal(snapshot.browserSessionBindings[0].state, 'AVAILABLE');
    assert.equal(snapshot.browserSessionBindings[0].generation, 4);
    assert.equal(snapshot.reauthRequests.length, 1);
    assert.equal(snapshot.reauthRequests[0].reason, 'captcha_required');
    assert.equal(snapshot.reauthRequests[0].state, HUMAN_REAUTH_REQUIRED);

    const retryLease = await post(harness.socketPath, '/auth/leases', {
      idempotencyKey: 'human-gate-retry',
      workerId: 'worker-a',
      request: makeRequest({ approval: retryApproval }),
    });
    assert.equal(retryLease.status, 409);
    assert.deepEqual(retryLease.body, { error: { code: HUMAN_REAUTH_REQUIRED } });
    assert.equal(adapterRuns, 1);
    assert.equal(harness.state.snapshot().reauthRequests.length, 1, 'retry must reuse the durable gate');
  } finally {
    await harness.close();
  }
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
  let expectedBrowserContext;
  const browserApproval = approval('approval-browser-first');
  const retryBrowserApproval = approval('approval-browser-retry');
  const daemonPolicy = makePolicy({
    approvals: [makeRequest().approval, browserApproval, retryBrowserApproval],
  });
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
    const nativeLauncher = await makeNativeLauncher();
    unauthenticatedDaemon = new LocalAuthDaemon({
      socketPath: join(runtimeDirectory, 'unauthenticated.sock'),
      state,
      policy: daemonPolicy,
      adapters: [{
        id: 'test-adapter',
        executable: process.execPath,
        providers: ['apps-in-toss'],
        capabilities: ['ait.bundle.upload.private'],
        credentialDelivery: 'fd3',
        launcher: nativeLauncher,
        buildArgs: () => [fixture],
        environment: { TEST_CAPTURE_FILE: capturePath },
      }],
      loadSecret: async () => Buffer.from(canary),
      getCredentialGeneration: async () => 3,
      readBrowserIdentity: async () => publicIdentity(),
      reconcileBrowserSession: async () => ({ outcome: 'UNKNOWN', publicIdentity: publicIdentity() }),
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
      { idempotencyKey: 'unauthenticated', workerId: 'worker-a', request: makeRequest() },
    );
    assert.equal(unauthenticated.status, 403);
    assert.deepEqual(unauthenticated.body, { error: { code: 'principal_unauthenticated' } });
    await unauthenticatedDaemon.stop();
    unauthenticatedDaemon = undefined;

    daemon = new LocalAuthDaemon({
      socketPath,
      state,
      policy: daemonPolicy,
      adapters: [{
        id: 'test-adapter',
        executable: process.execPath,
        providers: ['apps-in-toss'],
        capabilities: ['ait.bundle.upload.private'],
        credentialDelivery: 'fd3',
        launcher: nativeLauncher,
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
      reconcileBrowserSession: async () => ({
        outcome: 'NOT_APPLIED',
        publicIdentity: publicIdentity(),
      }),
      authenticatePrincipal: async (socket) => {
        assert.equal(typeof socket.remoteAddress, 'undefined');
        return executionBinding();
      },
      browserVault: vault,
      executeBrowserSession: async ({ cloneDirectory, authorization }) => {
        browserAdapterRuns += 1;
        assert.equal(await readFile(join(cloneDirectory, 'Cookies'), 'utf8'), 'fake-encrypted-session-input');
        assert.equal(authorization.leaseId, expectedBrowserLeaseId);
        assert.deepEqual(authorization.request, expectedBrowserContext);
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
      idempotencyKey: 'prompt-rejected',
      workerId: 'worker-a',
      request: makeRequest(),
      prompt: canary,
    });
    assert.equal(promptRejected.status, 400);
    assert.doesNotMatch(promptRejected.text, new RegExp(canary));

    for (const spoofed of [
      { idempotencyKey: 'spoof-worker', workerId: 'worker-b', request: makeRequest() },
      { idempotencyKey: 'spoof-subject', workerId: 'worker-a', request: makeRequest({ subject: 'k8s:release-workers:worker-b' }) },
      { idempotencyKey: 'spoof-run', workerId: 'worker-a', request: makeRequest({ runId: 'github:124' }) },
      { idempotencyKey: 'spoof-repo', workerId: 'worker-a', request: makeRequest({ repository: 'seorilabs/other-app' }) },
    ]) {
      const rejected = await post(socketPath, '/auth/leases', spoofed);
      assert.equal(rejected.status, 403);
      assert.deepEqual(rejected.body, { error: { code: 'principal_binding_mismatch' } });
    }
    assert.equal(generationLookups, 0, 'spoofed principals must be rejected before generation lookup');

    const issued = await post(socketPath, '/auth/leases', {
      idempotencyKey: 'daemon-execute',
      workerId: 'worker-a',
      request: makeRequest(),
    });
    assert.equal(issued.status, 201);
    assert.equal(generationLookups, 1);
    assert.equal(issued.body.credentialCheckout.secretExportable, false);
    assert.deepEqual(issued.body.credentialCheckout.executionBinding, executionBinding());

    const idempotentReplay = await post(socketPath, '/auth/leases', {
      idempotencyKey: 'daemon-execute',
      workerId: 'worker-a',
      request: makeRequest(),
    });
    assert.equal(idempotentReplay.status, 201);
    assert.equal(idempotentReplay.body.credentialCheckout.id, issued.body.credentialCheckout.id);
    assert.equal(generationLookups, 2, 'credential generation is checked before an idempotent replay');

    const duplicateApproval = await post(socketPath, '/auth/leases', {
      idempotencyKey: 'daemon-execute-other-key',
      workerId: 'worker-a',
      request: makeRequest(),
    });
    assert.equal(duplicateApproval.status, 409);
    assert.deepEqual(duplicateApproval.body, { error: { code: 'approval_already_used' } });

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

    const browserContext = makeRequest({ approval: browserApproval });
    expectedBrowserContext = browserContext;
    const browserLease = await post(socketPath, '/auth/leases', {
      idempotencyKey: 'daemon-browser-first',
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
    assert.equal(state.snapshot().browserSessionBindings[0].state, 'CLAIMED');

    const reconciledNotApplied = await post(
      socketPath,
      '/auth/browser-sessions/browser-session-a/complete',
      completionRequest,
    );
    assert.equal(reconciledNotApplied.status, 409);
    assert.deepEqual(reconciledNotApplied.body, {
      error: { code: 'browser_reconciliation_not_applied' },
    });
    assert.equal(browserAdapterRuns, 1, 'recovery retries must use readback and never execute the adapter');
    assert.equal(state.snapshot().browserSessionBindings[0].generation, 4);
    assert.equal(state.snapshot().browserSessionBindings[0].state, 'AVAILABLE');

    trustedIdentityReadback = publicIdentity();
    const retryContext = makeRequest({ approval: retryBrowserApproval });
    expectedBrowserContext = retryContext;
    const retryLease = await post(socketPath, '/auth/leases', {
      idempotencyKey: 'daemon-browser-retry',
      workerId: 'worker-a',
      request: retryContext,
    });
    assert.equal(retryLease.status, 201);
    expectedBrowserLeaseId = retryLease.body.credentialCheckout.id;
    const retryCheckout = await post(socketPath, '/auth/browser-sessions/browser-session-a/checkout', {
      context: retryContext,
      executionBinding: executionBinding(),
      expectedLeaseGeneration: retryLease.body.credentialCheckout.generation,
      expectedProfileGeneration: 1,
      expectedSessionGeneration: 4,
      expectedIdentity: publicIdentity(),
      leaseId: retryLease.body.credentialCheckout.id,
      role: 'release',
      workerId: 'worker-a',
    });
    assert.equal(retryCheckout.status, 200);
    const completed = await post(socketPath, '/auth/browser-sessions/browser-session-a/complete', {
      capabilityId: retryCheckout.body.browserSession.capabilityId,
      context: retryContext,
      executionBinding: executionBinding(),
      expectedGeneration: 5,
      leaseId: retryLease.body.credentialCheckout.id,
      profileGeneration: 1,
      role: 'release',
      workerId: 'worker-a',
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.browserSession.state, 'COMPLETED');
    assert.equal(completed.body.browserSession.generation, 7);
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
