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

test('CredentialCheckout expires and durable state plus AuthAuditEvent replay from append-only journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seori-auth-replay-'));
  let now = 1_700_000_000_000;
  let state = await DurableAuthState.open({ directory, clock: () => now, idFactory: idFactory() });
  try {
    const checkout = await state.issueCredentialCheckout({
      authorized: authorized(),
      workerId: 'worker-a',
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
          expectedGeneration: 2,
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
          expectedGeneration: 2,
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
        expectedGeneration: 2,
        executionBinding: executionBinding(),
        authorization: browserAuthorization(),
        readIdentity: async () => publicIdentity({ workspaceId: 'wrong-workspace' }),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'identity_readback_mismatch',
    );
    const afterMismatch = state.snapshot().browserSessionBindings.find(({ id }) => id === 'session-a');
    assert.equal(afterMismatch.generation, 2, 'identity mismatch must not update session generation');
    assert.equal(afterMismatch.state, 'CHECKED_OUT');

    const completed = await state.completeBrowserSession({
      sessionId: 'session-a',
      capabilityId: checkout.capabilityId,
      expectedGeneration: 2,
      executionBinding: executionBinding(),
      authorization: browserAuthorization(),
      readIdentity: async () => publicIdentity(),
    });
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(completed.generation, 3);
    assert.equal(completed.useCount, 1);

    await assert.rejects(
      state.completeBrowserSession({
        sessionId: 'session-a',
        capabilityId: checkout.capabilityId,
        expectedGeneration: 3,
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
    advance(LEASE_TTL_MS);
    await assert.rejects(
      state.completeBrowserSession({
        sessionId: 'session-b',
        capabilityId: second.capabilityId,
        expectedGeneration: 2,
        executionBinding: executionBinding(),
        authorization: browserAuthorization(undefined, { leaseId: 'browser-lease-b' }),
        readIdentity: async () => publicIdentity(),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_capability_expired',
    );
  });
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
