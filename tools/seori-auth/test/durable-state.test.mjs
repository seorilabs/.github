import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DurableAuthState,
  HUMAN_REAUTH_REQUIRED,
  LEASE_TTL_MS,
  PolicyEngine,
  SeoriAuthError,
} from '../src/index.mjs';
import { makePolicy, makeRequest } from '../fixtures/helpers.mjs';

function idFactory() {
  let id = 0;
  return () => `opaque-${++id}`;
}

function executionBinding(overrides = {}) {
  return {
    subject: 'k8s:release-workers:worker-a',
    runId: 'github:123',
    repository: 'seorilabs/example-app',
    workerId: 'worker-a',
    ...overrides,
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

async function withState(run) {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-state-'));
  let now = 1_700_000_000_000;
  const state = await DurableAuthState.open({
    directory,
    clock: () => now,
    idFactory: idFactory(),
  });
  try {
    await run({ state, directory, advance: (milliseconds) => { now += milliseconds; } });
  } finally {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function authorized(request = makeRequest()) {
  return new PolicyEngine(makePolicy()).authorize(request);
}

function browserAuthorization(request = makeRequest(), overrides = {}) {
  return {
    leaseId: 'browser-lease-a',
    ruleId: 'private-upload',
    profileGeneration: 1,
    role: 'release',
    request,
    ...overrides,
  };
}

test('CredentialCheckout uses generation CAS, exact run/repo/worker binding, five-minute TTL, and one use', async () => {
  await withState(async ({ state }) => {
    const request = makeRequest();
    const checkout = await state.issueCredentialCheckout({
      authorized: authorized(request),
      workerId: 'worker-a',
      idempotencyKey: 'checkout-primary',
      currentCredentialGeneration: 3,
      currentPolicyGeneration: 7,
    });

    assert.equal(Date.parse(checkout.expiresAt) - Date.parse(checkout.issuedAt), LEASE_TTL_MS);
    assert.equal(checkout.generation, 1);
    assert.equal(checkout.maxUses, 1);
    assert.equal(checkout.secretExportable, false);
    const issuedAudit = state.snapshot().auditEvents.at(-1);
    assert.equal(issuedAudit.commitSha, request.commitSha);
    assert.equal(issuedAudit.capability, request.capability);
    assert.equal(issuedAudit.credentialRef, request.credentialRef);

    await assert.rejects(
      state.consumeCredentialCheckout({
        id: checkout.id,
        expectedGeneration: 2,
        context: request,
        workerId: 'worker-a',
        currentCredentialGeneration: 3,
        currentPolicyGeneration: 7,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'generation_conflict',
    );

    for (const mismatch of [
      { context: makeRequest({ runId: 'github:124' }), workerId: 'worker-a' },
      { context: makeRequest({ repository: 'seorilabs/other-app' }), workerId: 'worker-a' },
      { context: request, workerId: 'worker-b' },
    ]) {
      await assert.rejects(
        state.consumeCredentialCheckout({
          id: checkout.id,
          expectedGeneration: 1,
          ...mismatch,
          currentCredentialGeneration: 3,
          currentPolicyGeneration: 7,
        }),
        (error) => error instanceof SeoriAuthError && error.code === 'lease_binding_mismatch',
      );
    }

    const consumed = await state.consumeCredentialCheckout({
      id: checkout.id,
      expectedGeneration: 1,
      context: request,
      workerId: 'worker-a',
      currentCredentialGeneration: 3,
      currentPolicyGeneration: 7,
    });
    assert.equal(consumed.generation, 2);
    await state.recordCredentialExecution({
      consumed,
      outcome: 'ADAPTER_FAILED',
      signal: 'SIGTERM',
    });
    const signalAudit = state.snapshot().auditEvents.at(-1);
    assert.equal(signalAudit.signal, 'SIGTERM');
    assert.equal('exitCode' in signalAudit, false);

    await assert.rejects(
      state.consumeCredentialCheckout({
        id: checkout.id,
        expectedGeneration: 2,
        context: request,
        workerId: 'worker-a',
        currentCredentialGeneration: 3,
        currentPolicyGeneration: 7,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'lease_already_used',
    );
  });
});

test('approval maxUses is durably reserved once and exact idempotent retries survive concurrency and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-approval-reservation-'));
  const nextId = idFactory();
  let state = await DurableAuthState.open({ directory, idFactory: nextId });
  const request = makeRequest();
  const issuance = {
    authorized: authorized(request),
    workerId: 'worker-a',
    idempotencyKey: 'occurrence-one',
    currentCredentialGeneration: 3,
    currentPolicyGeneration: 7,
  };
  try {
    const concurrent = await Promise.all([
      state.issueCredentialCheckout(issuance),
      state.issueCredentialCheckout(issuance),
    ]);
    assert.equal(concurrent[0].id, concurrent[1].id);
    assert.equal(state.snapshot().credentialCheckouts.length, 1);
    assert.equal(
      state.snapshot().auditEvents.filter(({ eventType }) => eventType === 'CREDENTIAL_CHECKOUT_ISSUED').length,
      1,
    );

    await assert.rejects(
      state.issueCredentialCheckout({ ...issuance, idempotencyKey: 'occurrence-two' }),
      (error) => error instanceof SeoriAuthError && error.code === 'approval_already_used',
    );
    await assert.rejects(
      state.issueCredentialCheckout({ ...issuance, workerId: 'worker-b' }),
      (error) => error instanceof SeoriAuthError && error.code === 'idempotency_conflict',
    );

    await state.close();
    state = await DurableAuthState.open({ directory, idFactory: nextId });
    const replay = await state.issueCredentialCheckout(issuance);
    assert.equal(replay.id, concurrent[0].id);
    await assert.rejects(
      state.issueCredentialCheckout({ ...issuance, idempotencyKey: 'occurrence-after-crash' }),
      (error) => error instanceof SeoriAuthError && error.code === 'approval_already_used',
    );
    assert.equal(
      state.snapshot().auditEvents.filter(({ eventType }) => eventType === 'CREDENTIAL_CHECKOUT_ISSUED').length,
      1,
    );
  } finally {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CredentialCheckout expires and durable state plus AuthAuditEvent replay from append-only journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-replay-'));
  let now = 1_700_000_000_000;
  let state = await DurableAuthState.open({ directory, clock: () => now, idFactory: idFactory() });
  try {
    const checkout = await state.issueCredentialCheckout({
      authorized: authorized(),
      workerId: 'worker-a',
      idempotencyKey: 'checkout-expiry',
      currentCredentialGeneration: 3,
      currentPolicyGeneration: 7,
    });
    now += LEASE_TTL_MS;
    await assert.rejects(
      state.consumeCredentialCheckout({
        id: checkout.id,
        expectedGeneration: 1,
        context: makeRequest(),
        workerId: 'worker-a',
        currentCredentialGeneration: 3,
        currentPolicyGeneration: 7,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'lease_expired',
    );
    const before = state.snapshot();
    assert.ok(before.auditEvents.length >= 2);
    await state.close();

    state = await DurableAuthState.open({ directory, clock: () => now, idFactory: idFactory() });
    const replayed = state.snapshot();
    assert.deepEqual(replayed.credentialCheckouts, before.credentialCheckouts);
    assert.deepEqual(replayed.auditEvents, before.auditEvents);

    const journal = await readFile(join(directory, 'auth-journal.jsonl'), 'utf8');
    const sequences = journal.trimEnd().split('\n').map((line) => JSON.parse(line).sequence);
    assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
  } finally {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('BrowserSessionBinding returns only opaque capability and public identity, with account concurrency and identity readback gates', async () => {
  await withState(async ({ state, advance }) => {
    for (const sessionId of ['session-a', 'session-b']) {
      await state.registerBrowserSession({
        sessionId,
        generation: 1,
        executionBinding: executionBinding(),
        publicIdentity: publicIdentity(),
      });
    }
    await state.registerBrowserSession({
      sessionId: 'session-wrong-app',
      generation: 1,
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity({ appId: 'other-app' }),
    });
    await assert.rejects(
      state.checkoutBrowserSession({
        sessionId: 'session-wrong-app',
        expectedGeneration: 1,
        executionBinding: executionBinding(),
        expectedIdentity: publicIdentity({ appId: 'other-app' }),
        authorization: browserAuthorization(),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_session_binding_mismatch',
    );

    const checkout = await state.checkoutBrowserSession({
      sessionId: 'session-a',
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      expectedIdentity: publicIdentity(),
      authorization: browserAuthorization(),
    });
    assert.deepEqual(Object.keys(checkout).sort(), ['capabilityId', 'publicIdentity']);
    assert.doesNotMatch(JSON.stringify(checkout), /profile|cookie|path/i);
    assert.equal(state.snapshot().auditEvents.at(-1).capabilityId, checkout.capabilityId);
    assert.equal(state.snapshot().auditEvents.at(-1).credentialRef, makeRequest().credentialRef);
    assert.equal(state.snapshot().auditEvents.at(-1).leaseId, 'browser-lease-a');
    assert.equal(state.snapshot().auditEvents.at(-1).ruleId, 'private-upload');

    const claimed = await state.claimBrowserSessionExecution({
      sessionId: 'session-a',
      capabilityId: checkout.capabilityId,
      expectedGeneration: 2,
      executionBinding: executionBinding(),
      authorization: browserAuthorization(),
    });
    assert.equal(claimed.mode, 'EXECUTE');
    assert.equal(claimed.generation, 3);

    await assert.rejects(
      state.checkoutBrowserSession({
        sessionId: 'session-b',
        expectedGeneration: 1,
        executionBinding: executionBinding(),
        expectedIdentity: publicIdentity(),
        authorization: browserAuthorization(undefined, { leaseId: 'browser-lease-b' }),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_account_in_use',
    );

    const exactAuthorizationMismatches = [
      browserAuthorization(makeRequest({ commitSha: '2'.repeat(40) })),
      browserAuthorization(makeRequest({ origin: 'https://business.toss.im' })),
      browserAuthorization(makeRequest({ capability: 'ait.bundle.status.read' })),
      browserAuthorization(makeRequest({
        resource: { kind: 'miniapp', id: 'other-app', environment: 'private' },
      })),
      browserAuthorization(makeRequest({
        artifact: { sha256: 'b'.repeat(64), sizeBytes: 1024 },
      })),
      browserAuthorization(makeRequest({ policyGeneration: 8 })),
      browserAuthorization(makeRequest({
        approval: {
          id: 'approval-123', mode: 'preapproved', expiresAt: '2098-01-01T00:00:00.000Z', maxUses: 1,
        },
      })),
      browserAuthorization(undefined, { leaseId: 'browser-lease-other' }),
      browserAuthorization(undefined, { ruleId: 'different-rule' }),
      browserAuthorization(undefined, { profileGeneration: 2 }),
      browserAuthorization(undefined, { role: 'support' }),
    ];
    for (const authorization of exactAuthorizationMismatches) {
      await assert.rejects(
        state.completeBrowserSession({
          sessionId: 'session-a',
          capabilityId: checkout.capabilityId,
          expectedGeneration: 3,
          executionBinding: executionBinding(),
          authorization,
          readIdentity: async () => publicIdentity(),
        }),
        (error) => error instanceof SeoriAuthError && error.code === 'browser_session_binding_mismatch',
      );
    }

    for (const executionMismatch of [
      executionBinding({ runId: 'github:other' }),
      executionBinding({ repository: 'seorilabs/other-app' }),
      executionBinding({ workerId: 'worker-b' }),
    ]) {
      await assert.rejects(
        state.completeBrowserSession({
          sessionId: 'session-a',
          capabilityId: checkout.capabilityId,
          expectedGeneration: 3,
          executionBinding: executionMismatch,
          authorization: browserAuthorization(),
          readIdentity: async () => publicIdentity(),
        }),
        (error) => error instanceof SeoriAuthError && error.code === 'browser_session_binding_mismatch',
      );
    }

    await assert.rejects(
      state.completeBrowserSession({
        sessionId: 'session-a',
        capabilityId: checkout.capabilityId,
        expectedGeneration: 3,
        executionBinding: executionBinding(),
        authorization: browserAuthorization(),
        readIdentity: async () => publicIdentity({ workspaceId: 'wrong-workspace' }),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'identity_readback_mismatch',
    );
    const afterMismatch = state.snapshot().browserSessionBindings.find(({ id }) => id === 'session-a');
    assert.equal(afterMismatch.generation, 3, 'identity mismatch must not update session generation');
    assert.equal(afterMismatch.state, 'CLAIMED');

    const recoveryClaim = await state.claimBrowserSessionExecution({
      sessionId: 'session-a',
      capabilityId: checkout.capabilityId,
      expectedGeneration: 3,
      executionBinding: executionBinding(),
      authorization: browserAuthorization(),
    });
    assert.equal(recoveryClaim.mode, 'RECOVERY_READBACK_ONLY');

    const completed = await state.completeBrowserSession({
      sessionId: 'session-a',
      capabilityId: checkout.capabilityId,
      expectedGeneration: 3,
      executionBinding: executionBinding(),
      authorization: browserAuthorization(),
      recoveryMode: true,
      readIdentity: async () => publicIdentity(),
    });
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(completed.generation, 4);
    assert.equal(completed.useCount, 1);

    await assert.rejects(
      state.completeBrowserSession({
        sessionId: 'session-a',
        capabilityId: checkout.capabilityId,
        expectedGeneration: 4,
        executionBinding: executionBinding(),
        authorization: browserAuthorization(),
        readIdentity: async () => publicIdentity(),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_capability_invalid',
    );

    const second = await state.checkoutBrowserSession({
      sessionId: 'session-b',
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      expectedIdentity: publicIdentity(),
      authorization: browserAuthorization(undefined, { leaseId: 'browser-lease-b' }),
    });
    const secondClaim = await state.claimBrowserSessionExecution({
      sessionId: 'session-b',
      capabilityId: second.capabilityId,
      expectedGeneration: 2,
      executionBinding: executionBinding(),
      authorization: browserAuthorization(undefined, { leaseId: 'browser-lease-b' }),
    });
    advance(LEASE_TTL_MS);
    await assert.rejects(
      state.completeBrowserSession({
        sessionId: 'session-b',
        capabilityId: second.capabilityId,
        expectedGeneration: secondClaim.generation,
        executionBinding: executionBinding(),
        authorization: browserAuthorization(undefined, { leaseId: 'browser-lease-b' }),
        readIdentity: async () => publicIdentity(),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_capability_expired',
    );
  });
});

test('browser execution claim is an atomic durable CAS and crash replay is readback-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-browser-claim-'));
  const nextId = idFactory();
  let state = await DurableAuthState.open({ directory, idFactory: nextId });
  try {
    await state.registerBrowserSession({
      sessionId: 'session-claim',
      generation: 1,
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    const checkout = await state.checkoutBrowserSession({
      sessionId: 'session-claim',
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      expectedIdentity: publicIdentity(),
      authorization: browserAuthorization(),
    });
    const claimRequest = {
      sessionId: 'session-claim',
      capabilityId: checkout.capabilityId,
      expectedGeneration: 2,
      executionBinding: executionBinding(),
      authorization: browserAuthorization(),
    };
    const claims = await Promise.allSettled([
      state.claimBrowserSessionExecution(claimRequest),
      state.claimBrowserSessionExecution(claimRequest),
    ]);
    assert.equal(claims.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = claims.find(({ status }) => status === 'rejected');
    assert.equal(rejected.reason.code, 'generation_conflict');
    const firstClaim = claims.find(({ status }) => status === 'fulfilled').value;
    assert.equal(firstClaim.mode, 'EXECUTE');
    assert.equal(firstClaim.generation, 3);
    assert.equal(state.snapshot().browserSessionBindings[0].state, 'CLAIMED');

    await state.close();
    state = await DurableAuthState.open({ directory, idFactory: nextId });
    const recoveryProbe = await state.claimBrowserSessionRecovery({
      sessionId: 'session-claim',
      capabilityId: checkout.capabilityId,
      expectedGeneration: 2,
      executionBinding: executionBinding(),
      request: makeRequest(),
      leaseId: 'browser-lease-a',
      profileGeneration: 1,
      role: 'release',
    });
    assert.equal(recoveryProbe.mode, 'RECOVERY_READBACK_ONLY');
    assert.deepEqual(recoveryProbe.authorization, browserAuthorization());
    const recovery = await state.claimBrowserSessionExecution(claimRequest);
    assert.equal(recovery.mode, 'RECOVERY_READBACK_ONLY');
    assert.equal(recovery.generation, 3);
    assert.equal(
      state.snapshot().auditEvents.filter(({ eventType }) => eventType === 'BROWSER_SESSION_EXECUTION_CLAIMED').length,
      1,
    );

    const completed = await state.completeBrowserSession({
      ...claimRequest,
      expectedGeneration: recovery.generation,
      recoveryMode: true,
      readIdentity: async () => publicIdentity(),
    });
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(completed.generation, 4);
    assert.equal(state.snapshot().auditEvents.at(-1).eventType, 'BROWSER_SESSION_RECOVERED');
  } finally {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup reconciliation reclaims expired unclaimed browser checkouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-browser-expiry-startup-'));
  const nextId = idFactory();
  let now = 1_700_000_000_000;
  let state = await DurableAuthState.open({ directory, clock: () => now, idFactory: nextId });
  try {
    await state.registerBrowserSession({
      sessionId: 'session-expired',
      generation: 1,
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    await state.checkoutBrowserSession({
      sessionId: 'session-expired',
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      expectedIdentity: publicIdentity(),
      authorization: browserAuthorization(),
    });
    now += LEASE_TTL_MS;
    await state.close();
    state = await DurableAuthState.open({ directory, clock: () => now, idFactory: nextId });

    const reclaimed = state.snapshot().browserSessionBindings[0];
    assert.equal(reclaimed.state, 'AVAILABLE');
    assert.equal(reclaimed.generation, 3);
    assert.equal(state.snapshot().auditEvents.at(-1).eventType, 'BROWSER_SESSION_EXPIRED_RECLAIMED');
    const nextCheckout = await state.checkoutBrowserSession({
      sessionId: 'session-expired',
      expectedGeneration: 3,
      executionBinding: executionBinding(),
      expectedIdentity: publicIdentity(),
      authorization: browserAuthorization(undefined, { leaseId: 'browser-lease-after-expiry' }),
    });
    assert.match(nextCheckout.capabilityId, /^opaque-/);
    assert.equal(state.snapshot().browserSessionBindings[0].generation, 4);
  } finally {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ReauthRequest durably records all interactive factors as HUMAN_REAUTH_REQUIRED', async () => {
  await withState(async ({ state }) => {
    for (const reason of [
      'captcha_required',
      'passkey_required',
      'sms_required',
      'push_required',
      'account_recovery_required',
      'terms_acceptance_required',
    ]) {
      const request = await state.createReauthRequest({
        reason,
        executionBinding: executionBinding(),
        publicIdentity: publicIdentity(),
      });
      assert.equal(request.state, HUMAN_REAUTH_REQUIRED);
      assert.equal(request.reason, reason);
    }
    const snapshot = state.snapshot();
    assert.equal(snapshot.reauthRequests.length, 6);
    assert.equal(snapshot.auditEvents.filter(({ eventType }) => eventType === 'REAUTH_REQUESTED').length, 6);
    const duplicate = await state.createReauthRequest({
      reason: 'captcha_required',
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    assert.equal(duplicate.id, snapshot.reauthRequests.find(({ reason }) => reason === 'captcha_required').id);
    assert.equal(state.snapshot().auditEvents.filter(({ eventType }) => eventType === 'REAUTH_REQUESTED').length, 6);
  });
});

test('unresolved ReauthRequest blocks matching issuance across restart until trusted exact resolution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-reauth-block-'));
  const nextId = idFactory();
  let state = await DurableAuthState.open({ directory, idFactory: nextId });
  const issuance = {
    authorized: authorized(),
    workerId: 'worker-a',
    idempotencyKey: 'reauth-blocked-occurrence',
    currentCredentialGeneration: 3,
    currentPolicyGeneration: 7,
  };
  try {
    const reauth = await state.createReauthRequest({
      reason: 'captcha_required',
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    await assert.rejects(
      state.issueCredentialCheckout(issuance),
      (error) => error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED,
    );
    await state.close();
    state = await DurableAuthState.open({ directory, idFactory: nextId });
    await assert.rejects(
      state.issueCredentialCheckout(issuance),
      (error) => error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED,
    );
    await assert.rejects(
      state.resolveReauthRequest({
        id: reauth.id,
        expectedGeneration: 1,
        executionBinding: executionBinding({ runId: 'github:other' }),
        publicIdentity: publicIdentity(),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'reauth_request_binding_mismatch',
    );
    const resolved = await state.resolveReauthRequest({
      id: reauth.id,
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    assert.equal(resolved.state, 'RESOLVED');
    assert.equal(resolved.generation, 2);
    const checkout = await state.issueCredentialCheckout(issuance);
    assert.equal(checkout.state, 'ISSUED');
  } finally {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reauth invalidates every older matching checkout and requires a new approval after resolution', async () => {
  await withState(async ({ state }) => {
    const request = makeRequest();
    const issuance = {
      authorized: authorized(request),
      workerId: 'worker-a',
      idempotencyKey: 'before-reauth',
      currentCredentialGeneration: 3,
      currentPolicyGeneration: 7,
    };
    const oldCheckout = await state.issueCredentialCheckout(issuance);
    const reauth = await state.createReauthRequest({
      reason: 'captcha_required',
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    await assert.rejects(
      state.issueCredentialCheckout(issuance),
      (error) => error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED,
    );
    await assert.rejects(
      state.consumeCredentialCheckout({
        id: oldCheckout.id,
        expectedGeneration: 1,
        context: request,
        workerId: 'worker-a',
        currentCredentialGeneration: 3,
        currentPolicyGeneration: 7,
      }),
      (error) => error instanceof SeoriAuthError && error.code === HUMAN_REAUTH_REQUIRED,
    );
    await state.resolveReauthRequest({
      id: reauth.id,
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    await assert.rejects(
      state.issueCredentialCheckout(issuance),
      (error) => error instanceof SeoriAuthError && error.code === 'lease_invalidated_by_reauth',
    );
    await assert.rejects(
      state.consumeCredentialCheckout({
        id: oldCheckout.id,
        expectedGeneration: 1,
        context: request,
        workerId: 'worker-a',
        currentCredentialGeneration: 3,
        currentPolicyGeneration: 7,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'lease_invalidated_by_reauth',
    );

    const nextApproval = {
      id: 'approval-after-reauth',
      mode: 'preapproved',
      expiresAt: '2099-01-01T00:00:00.000Z',
      maxUses: 1,
    };
    const nextRequest = makeRequest({ approval: nextApproval });
    const nextAuthorized = new PolicyEngine(makePolicy({ approvals: [nextApproval] })).authorize(nextRequest);
    const nextCheckout = await state.issueCredentialCheckout({
      authorized: nextAuthorized,
      workerId: 'worker-a',
      idempotencyKey: 'after-reauth',
      currentCredentialGeneration: 3,
      currentPolicyGeneration: 7,
    });
    const consumed = await state.consumeCredentialCheckout({
      id: nextCheckout.id,
      expectedGeneration: 1,
      context: nextRequest,
      workerId: 'worker-a',
      currentCredentialGeneration: 3,
      currentPolicyGeneration: 7,
    });
    assert.equal(consumed.generation, 2);
  });
});

test('browser lease authorization and reconstructable audit survive durable replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-browser-replay-'));
  let state = await DurableAuthState.open({ directory, idFactory: idFactory() });
  try {
    await state.registerBrowserSession({
      sessionId: 'session-replay',
      generation: 1,
      executionBinding: executionBinding(),
      publicIdentity: publicIdentity(),
    });
    const checkout = await state.checkoutBrowserSession({
      sessionId: 'session-replay',
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      expectedIdentity: publicIdentity(),
      authorization: browserAuthorization(),
    });
    const before = state.snapshot();
    await state.close();
    state = await DurableAuthState.open({ directory, idFactory: idFactory() });
    const replayed = state.snapshot();
    assert.deepEqual(replayed.browserSessionBindings, before.browserSessionBindings);
    assert.deepEqual(replayed.auditEvents, before.auditEvents);
    const audit = replayed.auditEvents.find(({ capabilityId }) => capabilityId === checkout.capabilityId);
    assert.equal(audit.leaseId, 'browser-lease-a');
    assert.equal(audit.credentialRef, makeRequest().credentialRef);
    assert.equal(audit.commitSha, makeRequest().commitSha);
    assert.equal(audit.capability, makeRequest().capability);
  } finally {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('broker-held HMAC journal detects wrong keys, record tampering, and trusted-head rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-integrity-'));
  const journalMacKey = Buffer.alloc(32, 0x4a);
  const wrongKey = Buffer.alloc(32, 0x5b);
  let state;
  try {
    await assert.rejects(
      DurableAuthState.open({ directory, requireIntegrity: true }),
      (error) => error instanceof SeoriAuthError && error.code === 'state_integrity_required',
    );
    state = await DurableAuthState.open({
      directory,
      journalMacKey,
      requireIntegrity: true,
      idFactory: idFactory(),
    });
    await state.issueCredentialCheckout({
      authorized: authorized(),
      workerId: 'worker-a',
      idempotencyKey: 'checkout-integrity',
      currentCredentialGeneration: 3,
      currentPolicyGeneration: 7,
    });
    const checkpoint = state.integrityCheckpoint();
    assert.equal(checkpoint.sequence, 1);
    assert.match(checkpoint.headMac, /^[0-9a-f]{64}$/);
    await state.close();
    state = undefined;

    const journalPath = join(directory, 'auth-journal.jsonl');
    const original = await readFile(journalPath, 'utf8');
    const envelope = JSON.parse(original.trimEnd());
    assert.equal(envelope.schemaVersion, 2);
    assert.equal(envelope.previousMac, '0'.repeat(64));
    assert.equal(envelope.mac, checkpoint.headMac);
    assert.doesNotMatch(original, new RegExp(journalMacKey.toString('hex')));
    assert.doesNotMatch(original, new RegExp(journalMacKey.toString('base64')));

    state = await DurableAuthState.open({
      directory,
      journalMacKey,
      requireIntegrity: true,
      expectedJournalHeadMac: checkpoint.headMac,
      idFactory: idFactory(),
    });
    assert.equal(state.snapshot().credentialCheckouts.length, 1);
    await state.close();
    state = undefined;

    await assert.rejects(
      DurableAuthState.open({ directory, journalMacKey: wrongKey, requireIntegrity: true }),
      (error) => error instanceof SeoriAuthError && error.code === 'invalid_state_journal',
    );

    await writeFile(journalPath, original.replace('"outcome":"SUCCESS"', '"outcome":"TAMPERED"'));
    await assert.rejects(
      DurableAuthState.open({ directory, journalMacKey, requireIntegrity: true }),
      (error) => error instanceof SeoriAuthError && error.code === 'invalid_state_journal',
    );

    await writeFile(journalPath, '');
    await assert.rejects(
      DurableAuthState.open({
        directory,
        journalMacKey,
        requireIntegrity: true,
        expectedJournalHeadMac: checkpoint.headMac,
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'invalid_state_journal',
    );
  } finally {
    if (state) await state.close();
    journalMacKey.fill(0);
    wrongKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('durable state refuses a directory readable by another OS identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-insecure-state-'));
  try {
    await chmod(directory, 0o755);
    await assert.rejects(
      DurableAuthState.open({ directory }),
      (error) => error instanceof SeoriAuthError && error.code === 'insecure_state_directory',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
