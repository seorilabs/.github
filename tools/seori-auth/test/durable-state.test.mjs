import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

    const checkout = await state.checkoutBrowserSession({
      sessionId: 'session-a',
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      expectedIdentity: publicIdentity(),
    });
    assert.deepEqual(Object.keys(checkout).sort(), ['capabilityId', 'publicIdentity']);
    assert.doesNotMatch(JSON.stringify(checkout), /profile|cookie|path/i);

    await assert.rejects(
      state.checkoutBrowserSession({
        sessionId: 'session-b',
        expectedGeneration: 1,
        executionBinding: executionBinding(),
        expectedIdentity: publicIdentity(),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_account_in_use',
    );

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
        readIdentity: async () => publicIdentity(),
      }),
      (error) => error instanceof SeoriAuthError && error.code === 'browser_capability_invalid',
    );

    const second = await state.checkoutBrowserSession({
      sessionId: 'session-b',
      expectedGeneration: 1,
      executionBinding: executionBinding(),
      expectedIdentity: publicIdentity(),
    });
    advance(LEASE_TTL_MS);
    await assert.rejects(
      state.completeBrowserSession({
        sessionId: 'session-b',
        capabilityId: second.capabilityId,
        expectedGeneration: 2,
        executionBinding: executionBinding(),
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
  });
});
