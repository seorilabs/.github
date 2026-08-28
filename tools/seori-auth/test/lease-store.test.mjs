import assert from 'node:assert/strict';
import test from 'node:test';

import { LEASE_TTL_MS, LeaseStore, PolicyEngine, SeoriAuthError } from '../src/index.mjs';
import { makePolicy, makeRequest } from '../fixtures/helpers.mjs';

function setup() {
  let now = 1_700_000_000_000;
  const engine = new PolicyEngine(makePolicy());
  const store = new LeaseStore({ clock: () => now });
  const request = makeRequest();
  const authorized = engine.authorize(request);
  const lease = store.issue({ ...authorized, idempotencyKey: 'lease-store-primary' });
  return {
    engine,
    store,
    request,
    lease,
    authorized,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function consume(setupResult, overrides = {}) {
  return setupResult.store.consume({
    leaseId: setupResult.lease.leaseId,
    context: setupResult.request,
    currentCredentialGeneration: setupResult.request.credentialGeneration,
    currentPolicyGeneration: setupResult.engine.generation,
    ...overrides,
  });
}

test('leases have a fixed five-minute lifetime', () => {
  const state = setup();
  assert.equal(
    Date.parse(state.lease.expiresAt) - Date.parse(state.lease.issuedAt),
    LEASE_TTL_MS,
  );
  state.advance(LEASE_TTL_MS);
  assert.throws(
    () => consume(state),
    (error) => error instanceof SeoriAuthError && error.code === 'lease_expired',
  );
});

test('lease is single-use', () => {
  const state = setup();
  consume(state);
  assert.throws(
    () => consume(state),
    (error) => error instanceof SeoriAuthError && error.code === 'lease_already_used',
  );
});

test('approval maxUses is reserved at issuance and an exact idempotent retry returns the same lease', () => {
  const state = setup();
  const replay = state.store.issue({ ...state.authorized, idempotencyKey: 'lease-store-primary' });
  assert.equal(replay.leaseId, state.lease.leaseId);
  assert.throws(
    () => state.store.issue({ ...state.authorized, idempotencyKey: 'lease-store-other' }),
    (error) => error instanceof SeoriAuthError && error.code === 'approval_already_used',
  );
});

test('cross-subject use is rejected', () => {
  const state = setup();
  assert.throws(
    () => consume(state, { context: makeRequest({ subject: 'k8s:release-workers:worker-b' }) }),
    (error) => error instanceof SeoriAuthError && error.code === 'lease_binding_mismatch',
  );
});

test('stale credential generation is rejected', () => {
  const state = setup();
  assert.throws(
    () => consume(state, { currentCredentialGeneration: 4 }),
    (error) => error instanceof SeoriAuthError && error.code === 'stale_credential_generation',
  );
});

test('stale policy generation is rejected', () => {
  const state = setup();
  assert.throws(
    () => consume(state, { currentPolicyGeneration: 8 }),
    (error) => error instanceof SeoriAuthError && error.code === 'stale_policy_generation',
  );
});
